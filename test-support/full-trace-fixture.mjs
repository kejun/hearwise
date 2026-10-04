import WebSocket from 'ws';
import { once } from 'node:events';
import { speechFixture } from './speech-fixture.mjs';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';

export const traceEvents = logs => logs.split('\n').filter(line => line.startsWith('execution_trace ')).map(line => JSON.parse(line.slice(16)));
export async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Full trace fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function socket(base, route) {
  const ws = new WebSocket(base.replace('http', 'ws') + route), events = [];
  ws.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw.toString())); });
  await once(ws, 'open');
  return { ws, events, send: message => ws.send(JSON.stringify(message)) };
}

// Complete application boundaries, with only paid services substituted locally.
export async function fullTraceFixture() {
  const f = await speechFixture({ extraEnv: { HEARWISE_TRACE: '' }, seed: store => {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, 'Full trace fixture');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 'seed', text: 'Eastman Kodak released the Brownie camera in 1900.' }).segment;
    store.setTranslation(segment.id, '柯达推出相机。', false);
    for (const name of ['Eastman Kodak', 'Brownie camera']) store.applyKnowledge(run.listeningId, [{ type: 'term', canonical_name: name,
      aliases: [], dialogue_summary: '对话中提到的对象。', background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null,
      correction_reason: null, evidence: [{ segment_id: segment.id, quote: name }] }]);
    const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    store.markJob(job.id, 'complete'); store.finishRun(run.runId); return run;
  }, modelResponse: body => {
    if (body.model === 'qwen-mt-flash') return '本轮真实适配器经过本地模拟模型。';
    const input = JSON.parse(body.messages.at(-1).content);
    return input.candidates ? relationWireEnvelope(input) : { items: [] };
  } });
  const sockets = [];
  try {
    const relation = await fetch(`${f.base}/api/listenings/${f.seeded.listeningId}/graph`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TRACE_SECRET_KEY' }) });
    if (relation.status !== 202) throw new Error('Relation fixture admission failed');
    await until(() => traceEvents(f.logs()).some(e => e.step_key === 'relation.commit' && e.state === 'succeeded'));
    const asr = await socket(f.base, '/ws'); sockets.push(asr.ws);
    asr.send({ type: 'start', key: 'TRACE_SECRET_KEY', listeningId: f.seeded.listeningId, source: 'en', targetLang: 'Chinese', audioSource: 'tab' });
    await until(() => asr.events.some(e => e.type === 'listening-ready'));
    const run = asr.events.find(e => e.type === 'listening-ready');
    const speech = await socket(f.base, '/ws/tts'); sockets.push(speech.ws);
    speech.send({ type: 'speech.start', epoch: 7, listeningId: run.listeningId, runId: run.runId,
      config: { key: 'TRACE_SECRET_KEY', region: 'beijing', voice: 'Cherry', rate: 1 } });
    await until(() => speech.events.some(e => e.type === 'speech.ready'));
    f.final('PRIVATE_TRACE_TRANSCRIPT. Eastman Kodak released the Brownie camera in 1900.', true, 'trace-final');
    await until(() => speech.events.some(e => e.type === 'speech.unit-end'));
    const end = speech.events.find(e => e.type === 'speech.unit-end');
    speech.send({ type: 'speech.progress', epoch: 7, playedUnit: end.unit, consumedSamples: end.samples });
    const asrClosed = once(asr.ws, 'close'); asr.send({ type: 'stop' }); await asrClosed;
    await until(() => speech.events.some(e => e.type === 'speech.finished'));
    await until(() => traceEvents(f.logs()).some(e => e.step_key === 'knowledge.execute' && e.state === 'succeeded'));
    // Cover the second TTS provider and HTTP preview translation independently.
    const preview = await fetch(`${f.base}/api/translate`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'TRACE_SECRET_KEY', text: 'PRIVATE_PREVIEW_TEXT', source: 'en', target: 'Chinese' }) });
    if (preview.status !== 200) throw new Error('Preview fixture failed');
    const fish = await socket(f.base, '/ws/tts'); sockets.push(fish.ws);
    fish.send({ type: 'speech.transcript', epoch: 8, listeningId: run.listeningId, kind: 'translation',
      config: { provider: 'fish', key: 'TRACE_SECRET_KEY', model: 's2.1-pro-free', referenceId: 'voice', rate: 1, latency: 'balanced' } });
    let samples = 0;
    fish.ws.on('message', (raw, binary) => {
      if (binary) return;
      const event = JSON.parse(raw.toString());
      if (event.type === 'speech.unit-end') { samples += event.samples; fish.send({ type: 'speech.progress', epoch: 8, playedUnit: event.unit, consumedSamples: samples }); }
    });
    await until(() => fish.events.some(e => e.type === 'speech.finished'));
    await until(() => traceEvents(f.logs()).filter(e => e.step_key === 'speech.session' && e.state === 'succeeded').length === 2);
  } finally { for (const ws of sockets) ws.terminate(); await f.close(); }
  return f.logs();
}
