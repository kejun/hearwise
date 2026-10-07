import { SpeechPlayer } from './speech-player.js';
import { createSpeechMediaSession } from './speech-media-session.js';

export function createSpeechController({ onChange, createPlayer = callback => new SpeechPlayer(callback),
  media = createSpeechMediaSession(), document = globalThis.document,
  createSocket = () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/tts`) }) {
  let epoch = 0, socket, player, enabled = false, context = {}, draining = false, mode = null, kind = null;
  let incremental = false;
  let firstHeard = false, lastMessage = '', total = 0;
  let paused = false, interrupted = false, resuming = false, playbackRevision = 0;
  let pauseMessage = '', transcriptPosition = 1, transcriptConfig = null, outputVolume = .8;
  const text = new Map(), metadata = new Map();
  let readingMeta = null, replayTarget = null;
  const report = (message = lastMessage, extra = {}) => {
    lastMessage = message;
    onChange({ enabled, paused, resuming, draining, preview: mode === 'preview', mode, kind,
      message: paused ? pauseMessage : message, total, position: transcriptPosition, ...extra });
  };
  const send = data => { if (socket?.readyState === 1) socket.send(JSON.stringify({ ...data, epoch })); };
  const playingMessage = () => mode === 'transcript'
    ? `正在播报${kind === 'original' ? '原文' : '译文'} · 第 ${readingMeta?.position || 1} / ${total} 句${readingMeta?.parts > 1 ? ` · 第 ${readingMeta.part} / ${readingMeta.parts} 段` : ''}`
    : draining ? '正在读完最后几句' : '正在播报';
  function stop(message = '播报已关闭', reason = 'cancel', notify = true) {
    const previous = socket, previousEpoch = epoch, stoppedMode = mode, stoppedKind = kind;
    ++epoch; ++playbackRevision; incremental = false; enabled = paused = interrupted = resuming = false; draining = false; mode = kind = null;
    transcriptConfig = null;
    player?.close(); player = null; // Local mute first; no server acknowledgement is required.
    media.close(); document?.removeEventListener('visibilitychange', recover);
    try { if (previous?.readyState === 1) previous.send(JSON.stringify({ type: 'speech.stop', reason, epoch: previousEpoch })); } catch { /* Already locally muted. */ }
    socket?.close(); socket = null; text.clear(); metadata.clear(); readingMeta = replayTarget = null;
    if (notify) report(message, { mode: stoppedMode, kind: stoppedKind, reading: '', canJump: false, canReplay: false, backlog: '' });
  }
  function pause(system = false) {
    if (!enabled) return;
    ++playbackRevision; paused = true; interrupted = system; resuming = false;
    pauseMessage = system ? '系统暂停了声音，可点击继续播报；播放位置保留 5 分钟。' : '播报已暂停，播放位置保留 5 分钟。';
    player?.pause(); media.setPaused(true); send({ type: 'speech.pause' }); report();
  }
  async function resume() {
    if (!enabled || !paused || resuming) return;
    const gen = epoch, revision = ++playbackRevision;
    resuming = true; report();
    try {
      const ready = await player.resume();
      if (gen !== epoch || revision !== playbackRevision) return;
      resuming = false;
      if (!ready) { report(); return; }
      paused = interrupted = false;
      send({ type: 'speech.resume' }); media.setPaused(false);
      report(readingMeta ? playingMessage() : '正在继续播报…');
    } catch {
      if (gen !== epoch || revision !== playbackRevision) return;
      resuming = false; player.pause();
      pauseMessage = '声音暂时无法恢复，请回到页面点击继续播报。'; report();
    }
  }
  function recover() { if (document?.visibilityState === 'visible' && interrupted) void resume(); }
  function fail(message) {
    const failedMode = mode, failedKind = kind;
    const target = ['live', 'replay'].includes(mode) && (readingMeta || metadata.values().next().value);
    const saved = target?.segmentId ? { segmentId: target.segmentId, listeningId: context.listeningId, runId: context.runId } : null;
    stop(message); replayTarget = saved;
    report(message, { mode: failedMode, kind: failedKind, canReplay: Boolean(saved) });
  }
  async function start(config, { preview = false, replay = null, transcript = null, volume = .8, reason, incremental: requestIncremental = false, startPosition = 1, paused: startPaused = false } = {}) {
    const knownTotal = reason === 'seek' ? total : 0;
    stop('正在准备播报', reason, reason !== 'seek');
    if (transcript && (context.phase !== 'idle' || !context.listeningId || !['original', 'translation'].includes(transcript))) {
      report('请先停止收听，再播报全文'); return;
    }
    if (!preview && !replay && !transcript && (context.phase !== 'listening' || context.target !== 'Chinese' || !context.runId)) {
      report('请先开始中文译文收听'); return;
    }
    const gen = epoch, run = { ...context, ...replay };
    enabled = true; firstHeard = false; total = knownTotal;
    transcriptPosition = startPosition; transcriptConfig = transcript ? { ...config } : null; outputVolume = volume;
    paused = startPaused;
    pauseMessage = '播报已暂停，播放位置保留 5 分钟。';
    mode = preview ? 'preview' : transcript ? 'transcript' : replay ? 'replay' : 'live'; kind = transcript;
    report(mode === 'live' ? '播报已开启，等下一句完整译文准备好后就会开始；首次出声需要一点时间。'
      : mode === 'transcript' ? `正在准备第 ${transcriptPosition} 句语音，请稍候…` : '正在准备语音，首次播放可能稍慢，请稍候…', { reading: '' });
    const output = player = createPlayer(event => {
      if (gen !== epoch) return;
      if (event.type === 'progress') send({ type: 'speech.progress', consumedSamples: event.consumedSamples, playedUnit: event.playedUnit, underruns: event.underruns });
      if (event.type === 'started') { firstHeard = true; readingMeta = metadata.get(event.unit); if (readingMeta?.position) transcriptPosition = readingMeta.position; report(playingMessage(), { reading: text.get(event.unit) || '' }); }
      if (event.type === 'played') {
        text.delete(event.unit); metadata.delete(event.unit); readingMeta = null;
        if (!text.size) report(mode === 'transcript' ? '正在准备下一句…' : draining ? '正在收尾' : '等待新的完整译文', { reading: '' });
      }
      if (event.type === 'suspended') pause(true);
      if (event.type === 'error') fail('语音缓冲异常，请重新开启播报');
    });
    media.activate({ mode, kind, context, play: () => { if (gen === epoch) void resume(); },
      pause: () => { if (gen === epoch) pause(); }, stop: () => { if (gen === epoch) stop(); } });
    if (paused) { output.pause(); media.setPaused(true); }
    document?.addEventListener('visibilitychange', recover);
    try {
      await output.unlock(volume);
      if (gen !== epoch) return;
      const ws = socket = createSocket(); ws.binaryType = 'arraybuffer';
      let finished = false;
      ws.addEventListener('open', () => {
        if (gen !== epoch) return;
        send({ type: preview ? 'speech.preview' : replay ? 'speech.replay' : transcript ? 'speech.transcript' : 'speech.start', config,
          listeningId: run.listeningId, runId: run.runId, segmentId: replay?.segmentId, kind: transcript, paused,
          ...(transcript ? { startPosition } : {}),
          ...(mode === 'live' ? { incremental: requestIncremental === true } : {}) });
      });
      ws.addEventListener('message', ({ data }) => {
        if (gen !== epoch) return;
        try {
          if (data instanceof ArrayBuffer) { output.audio(data, gen); return; }
          const msg = JSON.parse(data);
          if (msg.epoch !== gen) return;
          if (msg.type === 'speech.ready') { total = msg.total || 0; if (mode === 'transcript') { transcriptPosition = msg.position || startPosition; report(); } incremental = Boolean(msg.incremental); if (incremental) report('实验性短句播报已开启；不确定内容仍等待定稿'); }
          if (msg.type === 'speech.unit') { text.set(msg.unit, msg.text); metadata.set(msg.unit, msg); output.begin(msg.unit); }
          if (msg.type === 'speech.unit-end') output.end(msg.unit, msg.samples);
          if (msg.type === 'speech.state') {
            let message = msg.message;
            if (!firstHeard && !draining) {
              if (msg.state === 'waiting') message = incremental ? '实验性短句播报已开启；不确定内容仍等待定稿' : '播报已开启，等说话人说完一句并完成翻译后就会开始。';
              if (['buffering', 'playing'].includes(msg.state)) message = mode === 'transcript' ? `正在准备第 ${transcriptPosition} 句语音，请稍候…` : '正在准备第一句语音，首次播放可能稍慢，请稍候…';
            }
            report(readingMeta ? playingMessage() : message, { canJump: msg.canJump });
          }
          if (msg.type === 'speech.backlog') report(undefined, {
            backlog: msg.estimatedSeconds >= 8 ? `约 ${msg.estimatedSeconds} 秒待播 · ${msg.waiting} 句待处理` : '', canJump: msg.estimatedSeconds >= 8
          });
          if (msg.type === 'speech.error') fail(msg.message);
          if (msg.type === 'speech.finished') {
            finished = true;
            void Promise.resolve(output.settle?.()).then(() => { if (gen === epoch) stop(msg.message); });
          }
        } catch (error) { fail(error.message || '语音数据无效'); }
      });
      ws.addEventListener('close', () => { if (gen === epoch && !finished) fail('语音连接已断开，请重新开启播报'); });
      ws.addEventListener('error', () => { if (gen === epoch) fail('无法连接语音服务，请检查设置'); });
    } catch (error) { if (gen === epoch) stop(error.message || '无法启动语音播放'); }
  }
  return { start, stop, pause, resume, get paused() { return paused; }, get enabled() { return enabled; }, get mode() { return mode; }, get kind() { return kind; },
    seek(position) {
      if (!enabled || mode !== 'transcript' || !transcriptConfig || !Number.isSafeInteger(position) || position < 1 || position > total) return;
      return start(transcriptConfig, { transcript: kind, startPosition: position, paused, volume: outputVolume, reason: 'seek' });
    },
    replay(config, options) { if (replayTarget) return start(config, { ...options, replay: replayTarget }); },
    setContext(next) {
      const changedRecord = context.listeningId && context.listeningId !== next.listeningId;
      const changedLive = mode !== 'transcript' && mode !== 'preview' && ((context.runId && next.runId !== context.runId) || next.target !== 'Chinese');
      if ((enabled || replayTarget) && (changedRecord || changedLive || next.phase === 'connecting' || (mode === 'transcript' && next.phase !== 'idle'))) stop();
      context = next;
      media.setContext(context);
    },
    drain() { if (enabled && mode === 'live') { draining = true; send({ type: 'speech.drain' }); report('正在读完最后几句'); } },
    volume(value) { outputVolume = value; player?.volume(value); }
  };
}
