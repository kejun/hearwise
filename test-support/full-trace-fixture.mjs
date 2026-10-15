import WebSocket from 'ws';
import { once } from 'node:events';
import { speechFixture } from './speech-fixture.mjs';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
import { deadline } from './lifecycle.mjs';
import { waitForTraceTasks } from './trace-completion.mjs';
import { traceReport } from './trace-business-fixture.mjs';
import { buildBusinessOverview } from '../dist/server/index.js';

export const traceEvents = logs => logs.split('\n').filter(line => line.startsWith('execution_trace ')).map(line => JSON.parse(line.slice(16)));
export async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Full trace fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function socket(base, route) {
  const ws = new WebSocket(base.replace('http', 'ws') + route), events = [], frames = [];
  ws.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw.toString()));
    else frames.push({ epoch: raw.readUInt32LE(0), unit: raw.readUInt32LE(4), bytes: raw.length }); });
  try { await deadline(() => once(ws, 'open'), 3000, 'Full Trace WebSocket startup'); }
  catch (error) { ws.terminate(); throw error; }
  return { ws, events, frames, send: message => ws.send(JSON.stringify(message)) };
}

// Complete application boundaries, with only paid services substituted locally.
export async function fullTraceFixture({ observations = false } = {}) {
  const f = await speechFixture({ extraEnv: { HEARWISE_TRACE: '' }, seed: store => {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, 'Full trace fixture');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 'seed', text: 'Eastman Kodak released the Brownie camera in 1900.' }).segment;
    store.setTranslation(segment.id, '柯达推出相机。', false);
    for (const name of ['Eastman Kodak', 'Brownie camera']) store.applyKnowledge(run.listeningId, [{ type: 'term', canonical_name: name,
      aliases: [], dialogue_summary: '对话中提到的对象。', background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null,
      correction_reason: null, evidence: [{ segment_id: segment.id, quote: name }] }]);
    const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    store.markJob(job.id, 'complete'); store.finishRun(run.runId);
    return { ...run, filename: store.db.prepare('PRAGMA database_list').get().file, seededJobId: job.id };
  }, modelResponse: body => {
    if (body.model === 'qwen-mt-flash') return '本轮真实适配器经过本地模拟模型。';
    const input = JSON.parse(body.messages.at(-1).content);
    return input.candidates ? relationWireEnvelope(input) : { items: [] };
  } });
  const sockets = []; let observed, capturedLogs, failure, stage = 'relation admission';
  const durableSnapshot = () => {
    const db = new DatabaseSync(f.seeded.filename, { readOnly: true });
    try { return Object.fromEntries(['listening_runs', 'segments', 'extraction_jobs', 'relation_jobs', 'relation_requests'].map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'relation_requests' ? 'job_id,attempt' : 'id'}`).all()])); }
    finally { db.close(); }
  };
  const jobs = table => durableSnapshot()[table].filter(job => job.listening_id === f.seeded.listeningId && job.id !== f.seeded.seededJobId);
  const waitTasks = (table, step) => waitForTraceTasks(() => traceEvents(f.logs()), () => jobs(table), step);
  try {
    const relation = await fetch(`${f.base}/api/listenings/${f.seeded.listeningId}/graph`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TRACE_SECRET_KEY' }) });
    if (relation.status !== 202) throw new Error('Relation fixture admission failed');
    stage = 'initial relation root';
    await waitTasks('relation_jobs', 'relation.execute');
    stage = 'ASR and live speech';
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
    if (observations) speech.send({ type: 'speech.progress', epoch: 7, playedUnit: end.unit, consumedSamples: end.samples });
    // A speech unit is not a terminal signal for the queued final translation.
    // Stop only after this run's persisted final and its terminal Trace agree.
    stage = 'final translation root';
    await until(() => asr.events.some(e => e.type === 'segment-final' && e.runId === run.runId && e.segment.asr_sentence_id === 'trace-final'));
    const finalSegment = asr.events.find(e => e.type === 'segment-final' && e.runId === run.runId && e.segment.asr_sentence_id === 'trace-final').segment;
    await until(() => asr.events.some(e => e.type === 'translation-updated' && e.runId === run.runId &&
      e.segment.id === finalSegment.id && e.segment.translation_state === 'complete') &&
      traceEvents(f.logs()).some(e => e.step_key === 'translation.execute' && e.state === 'succeeded' &&
        e.attributes?.job_id === finalSegment.id && e.attributes?.run_id === run.runId));
    const asrClosed = once(asr.ws, 'close'); asr.send({ type: 'stop' }); await deadline(() => asrClosed, 3000, 'Full Trace ASR stop');
    await until(() => speech.events.some(e => e.type === 'speech.finished'));
    stage = 'knowledge roots';
    await waitTasks('extraction_jobs', 'knowledge.execute');
    stage = 'preview and transcript speech';
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
    stage = 'business queries and all task roots';
    {
      const get = async route => { const response = await fetch(f.base + route); if (response.status !== 200) throw new Error('Trace query failed'); return response.json(); };
      let detail, graph;
      const end = Date.now() + 12000;
      do {
        detail = await get(`/api/listenings/${run.listeningId}`); graph = await get(`/api/listenings/${run.listeningId}/graph`);
        if (!graph.status.pendingJobs && !graph.status.runningJobs && detail.jobs.every(job => ['complete', 'failed'].includes(job.state))) break;
        if (Date.now() > end) throw new Error('Trace business queries did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (true);
      await waitTasks('extraction_jobs', 'knowledge.execute');
      await waitTasks('relation_jobs', 'relation.execute');
      const durable = durableSnapshot();
      if (observations) observed = { listeningId: run.listeningId, runId: run.runId, seededJobId: f.seeded.seededJobId,
        detail, graph, durable, asrEvents: asr.events, speechEvents: speech.events, fishEvents: fish.events,
        frames: [...speech.frames, ...fish.frames], provider: { mt: f.stats.mtRequests.length, knowledge: f.stats.providerRequests.filter(row => row.model !== 'qwen-mt-flash').length,
          qwen: f.stats.commits.length, fish: f.stats.fishRequests.length } };
    }
    capturedLogs = f.logs();
  } catch (error) {
    failure = error;
    // Snapshot live evidence before shutdown can cancel roots or remove SQLite.
    const rawInput = f.logs();
    error.traceFailure = { stage, stack: error.stack, rawInput, listeningId: f.seeded.listeningId };
    try {
      error.traceFailure.durable = durableSnapshot();
      error.traceFailure.tasks = buildBusinessOverview(traceReport(rawInput), f.seeded.listeningId).tasks;
    } catch (captureError) { error.traceFailure.captureError = captureError.stack; }
    throw error;
  } finally {
    for (const ws of sockets) ws.terminate();
    try { await f.close(); }
    catch (error) {
      if (!failure) throw error;
      failure.traceFailure.cleanupError = error.stack;
    }
  }
  return observations ? { logs: capturedLogs, ...observed, cleanup: true } : capturedLogs;
}
