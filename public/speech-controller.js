import { SpeechPlayer } from './speech-player.js';

export function createSpeechController({ onChange, createPlayer = callback => new SpeechPlayer(callback),
  createSocket = () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/tts`) }) {
  let epoch = 0, socket, player, enabled = false, context = {}, draining = false, previewing = false;
  const text = new Map(), metadata = new Map();
  let readingMeta = null, replayTarget = null;
  const report = (message, extra = {}) => onChange({ enabled, draining, preview: previewing, message, ...extra });
  const send = data => { if (socket?.readyState === 1) socket.send(JSON.stringify({ ...data, epoch })); };
  function stop(message = '译文播报已关闭', reason = 'cancel') {
    const previous = socket, previousEpoch = epoch;
    ++epoch; enabled = false; draining = false; previewing = false;
    player?.close(); player = null; // Local mute first; no server acknowledgement is required.
    try { if (previous?.readyState === 1) previous.send(JSON.stringify({ type: 'speech.stop', reason, epoch: previousEpoch })); } catch { /* Already locally muted. */ }
    socket?.close(); socket = null; text.clear(); metadata.clear(); readingMeta = replayTarget = null;
    report(message, { reading: '', canJump: false, canReplay: false, backlog: '' });
  }
  function fail(message) {
    const target = !previewing && (readingMeta || metadata.values().next().value);
    const saved = target ? { segmentId: target.segmentId, listeningId: context.listeningId, runId: context.runId } : null;
    stop(message); replayTarget = saved;
    report(message, { canReplay: Boolean(saved) });
  }
  async function start(config, { preview = false, replay = null, volume = .8, reason } = {}) {
    stop('正在准备播报', reason);
    if (!preview && !replay && (context.phase !== 'listening' || context.target !== 'Chinese' || !context.runId)) {
      report('请先开始中文译文收听'); return;
    }
    const gen = epoch, run = { ...context, ...replay };
    enabled = true; previewing = preview; report(preview ? '正在准备试听' : '正在连接；从新内容开始播报');
    const output = player = createPlayer(event => {
      if (gen !== epoch) return;
      if (event.type === 'progress') send({ type: 'speech.progress', consumedSamples: event.consumedSamples, playedUnit: event.playedUnit, underruns: event.underruns });
      if (event.type === 'started') { readingMeta = metadata.get(event.unit); report(draining ? '正在读完最后几句' : '正在播报', { reading: text.get(event.unit) || '' }); }
      if (event.type === 'played') {
        text.delete(event.unit); metadata.delete(event.unit); readingMeta = null;
        if (!text.size) report(draining ? '正在收尾' : '等待新的完整译文', { reading: '' });
      }
      if (event.type === 'suspended') stop('声音已暂停，请点击开启播报恢复');
      if (event.type === 'error') fail('语音缓冲异常，请重新开启播报');
    });
    try {
      await output.unlock(volume);
      if (gen !== epoch) return;
      const ws = socket = createSocket(); ws.binaryType = 'arraybuffer';
      let finished = false;
      ws.addEventListener('open', () => {
        if (gen !== epoch) return;
        send({ type: preview ? 'speech.preview' : replay ? 'speech.replay' : 'speech.start', config,
          listeningId: run.listeningId, runId: run.runId, segmentId: replay?.segmentId });
      });
      ws.addEventListener('message', ({ data }) => {
        if (gen !== epoch) return;
        try {
          if (data instanceof ArrayBuffer) { output.audio(data, gen); return; }
          const msg = JSON.parse(data);
          if (msg.epoch !== gen) return;
          if (msg.type === 'speech.unit') { text.set(msg.unit, msg.text); metadata.set(msg.unit, msg); output.begin(msg.unit); }
          if (msg.type === 'speech.unit-end') output.end(msg.unit, msg.samples);
          if (msg.type === 'speech.state') report(readingMeta && !draining ? '正在播报' : msg.message, { canJump: msg.canJump });
          if (msg.type === 'speech.backlog') report(readingMeta ? '正在播报' : draining ? '正在读完最后几句' : '等待新的完整译文', {
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
  return { start, stop, get enabled() { return enabled; },
    replay(config, options) { if (replayTarget) return start(config, { ...options, replay: replayTarget }); },
    setContext(next) {
      if ((enabled || replayTarget) && ((context.runId && next.runId !== context.runId) || next.target !== 'Chinese' || next.phase === 'connecting')) stop();
      context = next;
    },
    drain() { if (enabled) { draining = true; send({ type: 'speech.drain' }); report('正在读完最后几句'); } },
    volume(value) { player?.volume(value); }
  };
}
