import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { QwenTts } from './qwen-tts.mjs';
import { speechUnits } from './speech-scheduler.mjs';
import { AUDIO_HEADER_BYTES, PREVIEW_TEXT, TTS_SAMPLE_RATE, speechConfig } from './public/speech-protocol.js';

export function createSpeechService({ store, setHead = () => {}, createTts = config => new QwenTts(config),
  now = Date.now, drainMs = 20000, progressTimeoutMs = 12000, onMetric = () => {} }) {
  const consumers = new Set();
  function accept(client) {
    const owner = randomUUID();
    let consumer, epoch, tts, timer, initialized = false, closed = false, busy = false;
    let cursor = 0, throughSequence = null, units = [], segment, unitIndex = 0, playedUnit = 0, sentSamples = 0, consumedSamples = 0;
    let lastProgress = now(), drainAt = null, preview = false, replay = null, lastState = '', lastBacklog = '', underruns = 0;
    const completedSamples = new Map();
    const metric = (event, extra = {}) => onMetric({ event, consumer: owner, run: consumer?.runId, ...extra });
    const send = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ ...data, epoch })); };
    const dispose = (graceful = false) => {
      if (closed) return;
      closed = true; clearInterval(timer); clearTimeout(initTimeout); tts?.close(graceful); tts = null;
      consumers.delete(consumer); setHead(owner, null); units = [];
    };
    const finish = (type, message) => { send({ type, message }); metric(type, { bufferedMs: Math.round((sentSamples - consumedSamples) / 24), underruns }); dispose(type === 'speech.finished'); client.close(); };
    const state = (name, message, extra = {}) => {
      const data = JSON.stringify({ name, message, ...extra });
      if (data !== lastState) { lastState = data; send({ type: 'speech.state', state: name, message, ...extra }); }
    };
    const initTimeout = setTimeout(() => finish('speech.error', '语音连接未初始化'), 10000);
    const pump = async () => {
      if (closed || !initialized) return;
      if (!preview && !replay) {
        const snapshot = store.speechRun(consumer.listeningId, consumer.runId);
        if (!snapshot) return finish('speech.error', '收听片段已不存在');
        if (snapshot.state !== 'active') { drainAt ??= now(); throughSequence ??= snapshot.maxSequence; }
      }
      if (now() - lastProgress > progressTimeoutMs) return finish('speech.error', '播放端已暂停或失去连接，播报已关闭');
      if (drainAt != null && now() - drainAt > drainMs) return finish('speech.error', '收尾等待已结束；未读内容仍保留在文字记录中');
      if (!preview && !replay) {
        const current = (busy || units.length) && segment?.translation_state === 'complete' ? segment.sequence_no : cursor;
        const backlog = store.speechBacklog(consumer.listeningId, consumer.runId, Math.max(cursor, current));
        const estimate = Math.ceil((sentSamples - consumedSamples) / TTS_SAMPLE_RATE + (backlog.characters + units.join('').length) / 5);
        const data = JSON.stringify({ waiting: backlog.count, estimate });
        if (data !== lastBacklog) {
          lastBacklog = data; send({ type: 'speech.backlog', waiting: backlog.count, estimatedSeconds: estimate });
        }
      }
      if (busy) return;
      busy = true;
      try {
        while (!closed) {
          const run = preview || replay ? { state: 'complete' } : store.speechRun(consumer.listeningId, consumer.runId);
          if (!run) return finish('speech.error', '收听片段已不存在');
          if (run.state !== 'active' && drainAt == null) drainAt = now();
          if (sentSamples - consumedSamples >= TTS_SAMPLE_RATE * 4 || unitIndex - playedUnit >= 2) return;
          if (!units.length) {
            segment = preview ? (unitIndex ? null : { id: 'preview', sequence_no: 0, translation_state: 'complete', translation_text: PREVIEW_TEXT })
              : replay ? (unitIndex ? null : replay) : store.speechNext(consumer.listeningId, consumer.runId, cursor);
            if (segment && throughSequence != null && segment.sequence_no > throughSequence) segment = null;
            if (!segment) {
              setHead(owner, null);
              if (run.state !== 'active' && playedUnit === unitIndex) return finish('speech.finished', preview ? '试听完成' : '本次播报已完成');
              state(drainAt == null ? 'waiting' : 'draining', drainAt == null ? '等待新的完整译文' : '正在读完最后几句');
              return;
            }
            if (segment.translation_state !== 'complete') {
              setHead(owner, segment.id);
              state('waiting-translation', segment.translation_state === 'failed' ? '前一句翻译失败，可继续处理或跳到最新内容' : '等待前一句译文，保持播报顺序', { canJump: true });
              return;
            }
            setHead(owner, null);
            units = speechUnits(segment.translation_text);
          }
          const text = units.shift();
          const index = ++unitIndex;
          const requestedAt = now();
          let frame = 0, samples = 0;
          send({ type: 'speech.unit', unit: index, segmentId: segment.id, sequence: segment.sequence_no, text });
          state('buffering', drainAt == null ? '正在准备语音' : '正在读完最后几句');
          const response = await tts.synthesize(text, pcm => {
            if (closed) return;
            if (!samples) metric('first_audio', { segment: segment.id, sequence: segment.sequence_no, unit: index, elapsedMs: now() - requestedAt });
            if (sentSamples + pcm.length / 2 - consumedSamples > TTS_SAMPLE_RATE * 32 || client.bufferedAmount > 1024 * 1024) {
              throw new Error('播放速度跟不上，已停止播报；可重新开启或跳到最新内容');
            }
            for (let offset = 0; offset < pcm.length; offset += 24000) {
              const chunk = pcm.subarray(offset, offset + 24000);
              const packet = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + chunk.length);
              packet.writeUInt32LE(epoch, 0); packet.writeUInt32LE(index, 4);
              packet.writeUInt32LE(frame++, 8); packet.writeUInt32LE(chunk.length / 2, 12);
              chunk.copy(packet, AUDIO_HEADER_BYTES);
              client.send(packet, { binary: true });
              sentSamples += chunk.length / 2; samples += chunk.length / 2;
            }
          });
          if (closed) return;
          send({ type: 'speech.unit-end', unit: index, samples });
          completedSamples.set(index, sentSamples);
          metric('unit_generated', { segment: segment.id, unit: index, elapsedMs: now() - requestedAt, samples });
          if (response) metric('response', { unit: index, response: response.id, status: response.status, attempts: response.attempts,
            inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens });
          if (!units.length) cursor = segment.sequence_no;
          const queuedMs = Math.round((sentSamples - consumedSamples) / TTS_SAMPLE_RATE * 1000);
          state('playing', drainAt == null ? '正在播报' : '正在读完最后几句', { queuedMs, canJump: queuedMs > 8000 });
        }
      } catch (error) {
        if (!closed) finish('speech.error', error.message || '语音服务暂时不可用');
      } finally { busy = false; }
    };
    client.on('message', (raw, binary) => {
      if (closed) return;
      let msg;
      try { if (binary) throw new Error(); msg = JSON.parse(raw.toString()); }
      catch { return finish('speech.error', '播报消息格式无效'); }
      if (msg.type === 'speech.stop') { metric(msg.reason === 'skip' ? 'skip' : 'cancel', { afterSequence: cursor }); dispose(); client.close(); return; }
      if (initialized) {
        if (msg.epoch !== epoch) return;
        if (msg.type === 'speech.drain') { drainAt ??= now(); state('draining', '正在读完最后几句'); }
        if (msg.type === 'speech.progress') {
          if (!Number.isSafeInteger(msg.consumedSamples) || msg.consumedSamples < consumedSamples || msg.consumedSamples > sentSamples ||
              !Number.isSafeInteger(msg.playedUnit) || msg.playedUnit < playedUnit || msg.playedUnit > unitIndex ||
              (msg.playedUnit > playedUnit && (completedSamples.get(msg.playedUnit) == null || completedSamples.get(msg.playedUnit) > msg.consumedSamples))) {
            return finish('speech.error', '播放进度无效');
          }
          lastProgress = now(); consumedSamples = msg.consumedSamples; playedUnit = msg.playedUnit;
          if (Number.isSafeInteger(msg.underruns) && msg.underruns >= underruns) underruns = msg.underruns;
          for (const id of completedSamples.keys()) if (id <= playedUnit) completedSamples.delete(id);
        }
        void pump(); return;
      }
      if (!['speech.start', 'speech.preview', 'speech.replay'].includes(msg.type)) return finish('speech.error', '请先开启播报');
      try {
        const config = speechConfig(msg.config);
        if (!Number.isInteger(msg.epoch) || msg.epoch < 1 || msg.epoch > 0xffffffff) throw new Error('播报会话无效');
        epoch = msg.epoch; preview = msg.type === 'speech.preview';
        if (!preview) {
          const run = store.speechRun(msg.listeningId, msg.runId);
          if (msg.type === 'speech.replay') replay = store.speechSegment(msg.listeningId, msg.runId, msg.segmentId);
          if (!run || (run.state !== 'active' && !replay) || run.target_lang !== 'Chinese' ||
              (msg.type === 'speech.replay' && replay?.translation_state !== 'complete')) throw new Error('请在中文译文收听中开启播报');
          // Snapshot and registration are synchronous. Finals committed after this point cannot fall through a gap.
          cursor = run.maxSequence;
        }
        consumer = { listeningId: msg.listeningId, runId: msg.runId, pump,
          stop: () => finish('speech.error', '收听记录已删除') };
        consumers.add(consumer); tts = createTts(config); initialized = true;
        metric(msg.type, { afterSequence: cursor });
        clearTimeout(initTimeout); timer = setInterval(() => { void pump(); }, 1000);
        send({ type: 'speech.ready', afterSequence: cursor, sampleRate: TTS_SAMPLE_RATE });
        void pump();
      } catch (error) { finish('speech.error', error.message); }
    });
    client.on('close', () => dispose()); client.on('error', () => dispose());
  }
  return { accept,
    notify: id => { for (const c of consumers) if (c.listeningId === id) void c.pump(); },
    remove: id => { for (const c of [...consumers]) if (c.listeningId === id) c.stop(); }
  };
}
