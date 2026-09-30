import { createIncrementalLedger } from './incremental-speech.mjs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { QwenTts } from './qwen-tts.mjs';
import { FishTts, FishTtsError } from './fish-tts.mjs';
import { speechUnits, transcriptSpeechUnits } from './speech-scheduler.mjs';
import { AUDIO_HEADER_BYTES, PREVIEW_TEXT, TTS_MODEL, TTS_INSTRUCT_MODEL, TTS_SAMPLE_RATE, speechConfig } from './public/speech-protocol.js';

export function createSpeechService({ store, setHead = () => {}, createTts = config => config.provider === 'fish' ? new FishTts(config) : new QwenTts(config),
  incrementalClauses = true, translatePhrase, onDispose = () => {}, now = Date.now, drainMs = 20000, progressTimeoutMs = 12000, translationWaitMs = 30000, pauseTimeoutMs = 300000, onMetric = () => {} }) {
  const consumers = new Set();
  function accept(client) {
    const owner = randomUUID();
    const createdAt = now();
    let consumer, epoch, tts, timer, initialized = false, closed = false, busy = false;
    let provider, model, activeKey, speechRate = 1;
    let cursor = 0, throughSequence = null, units = [], segment, unitIndex = 0, playedUnit = 0, sentSamples = 0, consumedSamples = 0;
    let lastProgress = now(), drainAt = null, preview = false, replay = null, lastState = '', lastBacklog = '', underruns = 0;
    let transcript = null, position = 0, parts = 0, waitingTranslation = null;
    let pausedAt = null;
    let ledger = null, phraseRequest = null;
    let liveUnit = null;
    const completedSamples = new Map();
    const metric = (event, extra = {}) => onMetric({ event, consumer: owner, run: consumer?.runId, provider, model, ...extra });
    const send = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ ...data, epoch })); };
    const dispose = (graceful = false) => {
      if (closed) return;
      closed = true; clearInterval(timer); clearTimeout(initTimeout); tts?.close(graceful); tts = null;
      phraseRequest?.abort(); ledger?.close();
      consumers.delete(consumer); onDispose(consumer?.listeningId); setHead(owner, null); units = []; activeKey = null;
    };
    const finish = (type, message, error) => {
      message = String(message || '语音服务暂时不可用');
      if (activeKey) message = message.replaceAll(activeKey, '[redacted]');
      message = message.slice(0, 500);
      const diagnostics = error instanceof FishTtsError ? error.diagnostics : {};
      send({ type, message, ...(type === 'speech.error' ? diagnostics : {}) });
      metric(type, { message, elapsedMs: now() - createdAt, ...diagnostics,
        bufferedMs: Math.round((sentSamples - consumedSamples) / 24), underruns });
      dispose(type === 'speech.finished'); client.close();
    };
    const state = (name, message, extra = {}) => {
      const data = JSON.stringify({ name, message, ...extra });
      if (data !== lastState) { lastState = data; send({ type: 'speech.state', state: name, message, ...extra }); }
    };
    const initTimeout = setTimeout(() => finish('speech.error', '语音连接未初始化'), 10000);
    const pump = async () => {
      if (closed || !initialized) return;
      if (transcript) {
        const snapshot = store.speechTranscript(consumer.listeningId);
        if (!snapshot) return finish('speech.error', '收听记录已不存在');
        if (snapshot.active) return finish('speech.error', '收听已继续，整篇播报已停止');
      } else if (!preview && !replay) {
        const snapshot = store.speechRun(consumer.listeningId, consumer.runId);
        if (!snapshot) return finish('speech.error', '收听片段已不存在');
        if (snapshot.state !== 'active') { drainAt ??= now(); throughSequence ??= snapshot.maxSequence; }
      }
      // A suspended AudioContext cannot emit progress. Keep its bounded queue, but never synthesize ahead while paused.
      if (pausedAt != null) {
        if (now() - pausedAt > pauseTimeoutMs) return finish('speech.error', '暂停已超过 5 分钟，播报已关闭，请重新开启');
        return;
      }
      if (now() - lastProgress > progressTimeoutMs) return finish('speech.error', '播放端已暂停或失去连接，播报已关闭');
      if (drainAt != null && now() - drainAt > drainMs) return finish('speech.error', '收尾等待已结束；未读内容仍保留在文字记录中');
      if (transcript && waitingTranslation && now() - waitingTranslation.since > translationWaitMs && playedUnit === unitIndex) {
        return finish('speech.error', `第 ${position + 1} 句译文尚未完成，请先继续处理，再播报全文`);
      }
      if (!transcript && !preview && !replay) {
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
          if (pausedAt != null) return;
          const run = preview || replay || transcript ? { state: 'complete' } : store.speechRun(consumer.listeningId, consumer.runId);
          if (!run) return finish('speech.error', '收听片段已不存在');
          // The synthetic completed run used by preview/replay is not a stopped live run.
          if (!preview && !replay && !transcript && run.state !== 'active' && drainAt == null) drainAt = now();
          if (sentSamples - consumedSamples >= TTS_SAMPLE_RATE * 4 || unitIndex - playedUnit >= 2) return;
          if (!units.length) {
            segment = preview ? (unitIndex ? null : { id: 'preview', sequence_no: 0, translation_state: 'complete', translation_text: PREVIEW_TEXT })
              : replay ? (unitIndex ? null : replay)
                : transcript ? store.speechTranscriptNext(consumer.listeningId, cursor, throughSequence)
                  : store.speechNext(consumer.listeningId, consumer.runId, cursor);
            liveUnit = null;
            // Persisted predecessors always win. Early phrases never overtake a pending final.
            if (ledger && !segment && run.state === 'active') {
              const candidate = ledger.candidate();
              if (candidate) {
                phraseRequest = new AbortController();
                phraseRequest.sourceUnit = candidate;
                try {
                  const translated = await translatePhrase({ listeningId: consumer.listeningId, text: candidate.source,
                    signal: phraseRequest.signal, final: false });
                  if (closed) return;
                  if (pausedAt != null || drainAt != null || store.speechRun(consumer.listeningId, consumer.runId)?.state !== 'active') return;
                  if (!ledger.commit(candidate)) continue; // Final/revision won the race; never emit stale speech.
                  liveUnit = candidate;
                  segment = { id: null, sequence_no: cursor, translation_state: 'complete', translation_text: translated, early: true };
                  metric('phrase_committed', { sentence: candidate.sentenceId, revision: candidate.revision, sourceEnd: candidate.end, hash: candidate.hash });
                } catch (error) {
                  if (closed) return;
                  if (error.name === 'AbortError' && !ledger.valid(candidate)) continue;
                  if (error.code === 'TRANSLATION_BUSY') return;
                  throw error;
                } finally { phraseRequest = null; }
              }
            } else if (ledger && segment) {
              const remainder = ledger.finalize(segment);
              if (closed || remainder?.conflict) return;
              if (remainder) {
                // Source coverage, never target-string suffix subtraction. Canonical MT stays intact in storage.
                if (!remainder.source) { cursor = segment.sequence_no; ledger.complete(segment.asr_sentence_id); continue; }
                phraseRequest = new AbortController();
                try {
                  const translated = await translatePhrase({ listeningId: consumer.listeningId, text: remainder.source,
                    signal: phraseRequest.signal, final: true });
                  if (closed) return;
                  liveUnit = remainder;
                  segment = { ...segment, translation_state: 'complete', translation_text: translated };
                  units = speechUnits(translated);
                  if (pausedAt != null) return;
                  if (drainAt != null && now() - drainAt > drainMs) return finish('speech.error', '收尾等待已结束；未读内容仍保留在文字记录中');
                } finally { phraseRequest = null; }
              }
            }
            if (segment && throughSequence != null && segment.sequence_no > throughSequence) segment = null;
            if (!segment) {
              setHead(owner, null);
              if (run.state !== 'active' && playedUnit === unitIndex) return finish('speech.finished', preview ? '试听完成' : transcript ? `${transcript.kind === 'original' ? '原文' : '译文'}全文播报完成` : '本次播报已完成');
              state(transcript || drainAt != null ? 'draining' : 'waiting', transcript || drainAt != null ? '正在读完最后几句' : '等待新的完整译文');
              return;
            }
            if (transcript?.kind !== 'original' && segment.translation_state !== 'complete') {
              setHead(owner, segment.id);
              if (transcript) {
                if (segment.translation_state === 'failed') {
                  if (playedUnit < unitIndex) { state('blocked', `第 ${position + 1} 句翻译失败，正在读完前面的内容`); return; }
                  return finish('speech.error', `第 ${position + 1} 句翻译失败，请先继续处理，再播报全文`);
                }
                if (waitingTranslation?.id !== segment.id) waitingTranslation = { id: segment.id, since: now() };
                state('waiting-translation', `正在等待第 ${position + 1} / ${transcript.total} 句译文，完成后继续播报`);
                return;
              }
              state('waiting-translation', segment.translation_state === 'failed' ? '前一句翻译失败，可继续处理或跳到最新内容' : '等待前一句译文，保持播报顺序', { canJump: true });
              return;
            }
            setHead(owner, null);
            waitingTranslation = null;
            units = transcript ? transcriptSpeechUnits(transcript.kind === 'original' ? segment.original_text : segment.translation_text, { rate: speechRate })
              : speechUnits(segment.translation_text);
            parts = units.length;
            if (transcript) position++;
          }
          const text = units.shift();
          const index = ++unitIndex;
          const requestedAt = now();
          let frame = 0, samples = 0;
          send({ type: 'speech.unit', unit: index, segmentId: segment.id, sequence: segment.sequence_no, text,
            ...(liveUnit ? { sourceUnit: liveUnit } : {}),
            ...(transcript ? { position, total: transcript.total, kind: transcript.kind, part: parts - units.length, parts } : {}) });
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
          if (!units.length && !segment.early) { cursor = segment.sequence_no; ledger?.complete(segment.asr_sentence_id); }
          const queuedMs = Math.round((sentSamples - consumedSamples) / TTS_SAMPLE_RATE * 1000);
          state('playing', drainAt == null ? '正在播报' : '正在读完最后几句', { queuedMs, canJump: queuedMs > 8000 });
        }
      } catch (error) {
        if (!closed) finish('speech.error', error.message || '语音服务暂时不可用', error);
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
        if (msg.type === 'speech.pause') {
          pausedAt ??= now();
          state('paused', '播报已暂停，播放位置保留 5 分钟。');
        }
        if (msg.type === 'speech.resume' && pausedAt != null) {
          const resumedAt = now();
          if (resumedAt - pausedAt > pauseTimeoutMs) return finish('speech.error', '暂停已超过 5 分钟，播报已关闭，请重新开启');
          // Only count time spent actively playing towards drain/translation deadlines.
          if (drainAt != null) drainAt += resumedAt - Math.max(pausedAt, drainAt);
          if (waitingTranslation) waitingTranslation.since += resumedAt - Math.max(pausedAt, waitingTranslation.since);
          pausedAt = null; lastProgress = resumedAt; lastState = '';
        }
        if (msg.type === 'speech.drain' && !preview && !replay && !transcript) { drainAt ??= now(); state('draining', '正在读完最后几句'); }
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
      if (!['speech.start', 'speech.preview', 'speech.replay', 'speech.transcript'].includes(msg.type)) return finish('speech.error', '请先开启播报');
      try {
        if (!Number.isInteger(msg.epoch) || msg.epoch < 1 || msg.epoch > 0xffffffff) throw new Error('播报会话无效');
        epoch = msg.epoch; preview = msg.type === 'speech.preview';
        const config = speechConfig(msg.config);
        provider = config.provider; activeKey = config.key; speechRate = config.rate;
        model = provider === 'fish' ? config.model : config.prompt ? TTS_INSTRUCT_MODEL : TTS_MODEL;
        if (msg.type === 'speech.transcript') {
          if (!['original', 'translation'].includes(msg.kind)) throw new Error('请选择播报原文或译文');
          const snapshot = store.speechTranscript(msg.listeningId);
          if (!snapshot) throw new Error('收听记录不存在');
          if (snapshot.active) throw new Error('请先停止收听，再播报全文');
          if (!snapshot.total) throw new Error('暂无可以播报的内容');
          transcript = { kind: msg.kind, total: snapshot.total };
          throughSequence = snapshot.maxSequence;
          config.language = 'Auto'; // Records can span runs with different source/target languages.
        } else if (!preview) {
          const run = store.speechRun(msg.listeningId, msg.runId);
          if (msg.type === 'speech.replay') replay = store.speechSegment(msg.listeningId, msg.runId, msg.segmentId);
          if (!run || (run.state !== 'active' && !replay) || run.target_lang !== 'Chinese' ||
              (msg.type === 'speech.replay' && replay?.translation_state !== 'complete')) throw new Error('请在中文译文收听中开启播报');
          // Snapshot and registration are synchronous. Finals committed after this point cannot fall through a gap.
          cursor = run.maxSequence;
        }
        // Opt-in belongs to this consumer epoch, never a process-wide or provider setting.
        // Missing/malformed values and legacy clients stay final-only. It cannot change mid-session.
        if (msg.incremental === true && translatePhrase && msg.type === 'speech.start') {
          const run = store.speechRun(msg.listeningId, msg.runId);
          if (run.source_lang === 'en' && run.target_lang === 'Chinese') {
            ledger = createIncrementalLedger({ epoch, runId: msg.runId, allowClauses: incrementalClauses, onCorrection: detail => {
              metric('incremental_correction', detail);
              finish('speech.error', '提前播报的原文已修订，播报已停止；请查看定稿后从文字记录完整回放');
            } });
          }
        }
        consumer = { listeningId: msg.listeningId, runId: msg.runId, pump,
          observe: (id, text) => { if (ledger && pausedAt == null && drainAt == null) { ledger.observe(id, text); if (phraseRequest?.sourceUnit && !ledger.valid(phraseRequest.sourceUnit)) phraseRequest.abort(); void pump(); } },
          final: segment => { ledger?.finalize(segment); if (phraseRequest?.sourceUnit && !ledger.valid(phraseRequest.sourceUnit)) phraseRequest.abort(); void pump(); },
          correct: () => finish('speech.error', '识别定稿出现冲突，播报已停止；请核对文字记录后完整回放'),
          stop: () => finish('speech.error', '收听记录已删除') };
        consumers.add(consumer); tts = createTts(config); initialized = true;
        if (msg.paused === true) pausedAt = now();
        metric(msg.type, { afterSequence: cursor });
        clearTimeout(initTimeout); timer = setInterval(() => { void pump(); }, 1000);
        send({ type: 'speech.ready', afterSequence: cursor, sampleRate: TTS_SAMPLE_RATE, incremental: Boolean(ledger),
          ...(transcript ? { total: transcript.total, kind: transcript.kind } : {}) });
        void pump();
      } catch (error) { finish('speech.error', error.message); }
    });
    client.on('close', () => dispose()); client.on('error', () => dispose());
  }
  return { accept,
    hasConsumers: id => [...consumers].some(c => c.listeningId === id),
    observe: (listeningId, runId, id, text) => { for (const c of consumers) if (c.listeningId === listeningId && c.runId === runId) c.observe(id, text); },
    final: (listeningId, runId, segment) => { for (const c of consumers) if (c.listeningId === listeningId && c.runId === runId) c.final(segment); },
    correct: (listeningId, runId) => { for (const c of consumers) if (c.listeningId === listeningId && c.runId === runId) c.correct(); },
    notify: id => { for (const c of consumers) if (c.listeningId === id) void c.pump(); },
    remove: id => { for (const c of [...consumers]) if (c.listeningId === id) c.stop(); }
  };
}
