import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { speechFixture } from './speech-fixture.mjs';
import { deadline } from './lifecycle.mjs';

export const playbackConfig = { key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 };
export const playbackGolden = '标题 👨‍👩‍👧‍👦 é 𠮷。\n\n' + '保留全部词语与最后尾字'.repeat(70) + ' END';
export const playbackSource = '  **标题** 👨‍👩‍👧‍👦 é 𠮷。\n\n`' + '保留全部词语与最后尾字'.repeat(70) + '` END  ';
export async function playbackFixture(options = {}) {
  const held = [];
  const fixture = await speechFixture({ audioSamples: 4, ...options,
    ...(options.hold ? { onTtsCommit: request => held.push(request) } : {}),
    seed(store) {
      const records = {};
      for (const [name, texts] of [['A', ['甲。', '乙。']], ['B', ['丙。', '丁。']], ['Text', [playbackSource]]]) {
        const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, `播放验证 ${name}`);
        texts.forEach((text, n) => {
          const row = store.addSegment(run.listeningId, run.runId, { id: n + 1, text }).segment;
          store.setTranslation(row.id, text, false);
        });
        const job = store.createExtractionJob(run.listeningId, store.detail(run.listeningId, 1, 100).segments);
        if (job) store.markJob(job.id, 'complete');
        store.finishRun(run.runId); records[name] = run;
      }
      return records;
    } });
  return { ...fixture, held };
}
export async function playbackSocket(fixture, record, epoch, config = playbackConfig) {
  const ws = new WebSocket(fixture.base.replace('http', 'ws') + '/ws/tts');
  const events = [], packets = []; let samples = 0;
  ws.on('message', (data, binary) => {
    if (binary) { packets.push(Buffer.from(data)); samples += data.readUInt32LE(12); }
    else events.push(JSON.parse(data));
  });
  await deadline(() => once(ws, 'open'), 3000, 'playback WebSocket open');
  const send = message => ws.send(JSON.stringify({ epoch, ...message }));
  send({ type: 'speech.transcript', listeningId: fixture.seeded[record].listeningId, kind: 'translation', config });
  return { ws, events, packets, send, samples: () => samples,
    acknowledge() { send({ type: 'speech.progress', consumedSamples: samples, playedUnit: events.filter(e => e.type === 'speech.unit-end').at(-1)?.unit || 0 }); } };
}
export async function playbackWait(check, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label} did not become true within 5000ms`);
}
