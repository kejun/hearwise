import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { speechFixture } from './speech-fixture.mjs';
import { deadline } from './lifecycle.mjs';
import { summarizeLatencies, validateBaselineRun } from '../scripts/lib/realtime-baseline.mjs';

const [directory, profile, negative = 'none'] = process.argv.slice(2);
const plan = JSON.parse(await readFile('verification/realtime-baseline.json', 'utf8'));
const config = plan.profiles[profile];
assert.ok(config && ['none', 'retain-asr-socket'].includes(negative));
const result = { startedAt: new Date().toISOString(), complete: false, cleanup: { confirmed: false }, phases: [], samples: [], runs: [], quiescent: [], negative };
const now = () => performance.now();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const raw = (type, value) => appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), monoMs: now(), type, ...value }) + '\n');
async function until(check, label, timeout = config.phaseTimeoutMs) {
  const start = now();
  while (now() - start < timeout) { const value = await check(); if (value) return value; await wait(10); }
  throw new Error(`${label} exceeded ${timeout}ms`);
}
const resourcesFile = path.join(directory, 'resources.jsonl');
let fixture, sequence = 0, epoch = 0, phase = 'warmup';
const sockets = [], records = new Map();
try {
  fixture = await speechFixture({ directoryRoot: path.join(directory, 'temporary-database'), translationDelay: plan.input.translationDelayMs,
    translationText: text => `探针${text.match(/Probe(\d+)/)?.[1] || 0}。`,
    extraEnv: { HOST: '127.0.0.1', EXTRACTION_WAIT_MS: String(plan.input.extractionWaitMs),
      HEARWISE_BASELINE_RESOURCES: resourcesFile, HEARWISE_BASELINE_SAMPLE_MS: String(config.sampleMs), HEARWISE_BASELINE_NEGATIVE: negative },
    serverImports: [path.resolve('test-support/realtime-resource-preload.mjs')],
    seed: store => ({ filename: store.db.prepare('PRAGMA database_list').get().file }),
    modelResponse: body => {
      if (body.model === 'qwen-mt-flash') return undefined;
      const input = JSON.parse(body.messages.at(-1).content);
      return { items: input.focus_segments.map(segment => ({ action: 'create', type: 'other', display_label: 'product', canonical_name: segment.text.match(/Probe\d+/)[0],
        role: '核心系统', reason: '合成测试对象', existing_item_id: null, observed_candidate_id: null, correction_reason: null,
        aliases: [], short_description: '合成测试系统。', new_information: '仅用于本地负载测量。', certainty: 'clear',
        evidence: [{ segment_id: segment.id, quote: segment.text }] })) };
    }
  });
  appendFileSync(path.join(directory, 'server.log'), fixture.logs());
  fixture.child.stdout.on('data', data => appendFileSync(path.join(directory, 'server.log'), data));
  fixture.child.stderr.on('data', data => appendFileSync(path.join(directory, 'server.log'), data));
  result.pid = fixture.child.pid;
  async function request(route, { body, method = 'GET' } = {}) {
    const response = await fetch(fixture.base + route, { method, signal: AbortSignal.timeout(config.phaseTimeoutMs),
      headers: { Connection: 'close', ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    assert.equal(response.status, 200, `${method} ${route}`); return response;
  }
  async function socket(route) {
    const ws = new WebSocket(fixture.base.replace('http:', 'ws:') + route); sockets.push(ws);
    ws.on('error', error => raw('socket-error', { message: error.message }));
    await deadline(() => once(ws, 'open'), config.phaseTimeoutMs, 'websocket startup'); return ws;
  }
  async function start(listeningId) {
    const ws = await socket('/ws'), run = { phase, startMs: now(), listeningId, epoch: ++epoch };
    const events = [];
    ws.on('message', data => {
      const event = JSON.parse(data), at = now(); events.push(event); raw('asr-event', { phase, event });
      if (event.type === 'segment-final') {
        const row = records.get(event.segment.asr_sentence_id);
        if (row) { row.finalMs = at; row.audioToCaptionMs = at - row.audioSentMs; row.segmentId = event.segment.id; }
      }
      if (event.type === 'translation-updated') {
        const row = records.get(event.segment.asr_sentence_id);
        if (row && event.segment.translation_state === 'complete') { row.translationMs = at; row.finalToTranslationMs = at - row.finalMs; row.audioToTranslationMs = at - row.audioSentMs; }
      }
      if (event.type === 'knowledge-upserted') {
        const row = records.get(event.item.canonical_name);
        if (row) { row.knowledgeMs = at; row.finalToKnowledgeMs = at - row.finalMs; row.audioToKnowledgeMs = at - row.audioSentMs; }
      }
    });
    ws.send(JSON.stringify({ type: 'start', key: 'local-fixture-only', source: 'en', targetLang: 'Chinese', audioSource: 'tab', listeningId }));
    const ready = await until(() => events.find(event => event.type === 'listening-ready'), 'listening ready');
    Object.assign(run, ready); delete run.type; result.runs.push(run);
    const tts = await socket('/ws/tts'); let consumed = 0;
    tts.on('message', (data, binary) => {
      if (binary) {
        raw('pcm', { phase, epoch: data.readUInt32LE(0), unit: data.readUInt32LE(4), bytes: data.length });
        run.startToFirstPcmMs ??= now() - run.speechStartMs;
        run.audioToFirstPcmMs ??= now() - run.firstAudioMs;
      } else {
        const event = JSON.parse(data); raw('speech-event', { phase, event });
        if (event.type === 'speech.unit-end') { consumed += event.samples; tts.send(JSON.stringify({ type: 'speech.progress', epoch: run.epoch, playedUnit: event.unit, consumedSamples: consumed })); }
      }
    });
    run.speechStartMs = now();
    tts.send(JSON.stringify({ type: 'speech.start', epoch: run.epoch, listeningId: run.listeningId, runId: run.runId,
      config: { key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 } }));
    return { ws, tts, run };
  }
  async function send(client) {
    const id = `Probe${++sequence}`, row = { id, phase, listeningId: client.run.listeningId, runId: client.run.runId, audioSentMs: now() };
    client.run.firstAudioMs ??= row.audioSentMs;
    result.samples.push(row); records.set(id, row); const before = fixture.stats.audioFrames;
    client.ws.send(Buffer.alloc(3200));
    await until(() => fixture.stats.audioFrames > before, 'audio reaches local ASR');
    row.providerFrameMs = now(); fixture.final(`${id} is a synthetic test system.`, true, id);
    raw('input', row); return row;
  }
  async function drain(listeningId) {
    return until(async () => {
      const detail = await (await request(`/api/listenings/${listeningId}`)).json();
      raw('processing', { listeningId, processing: detail.processing, jobs: detail.jobs.map(job => ({ id: job.id, state: job.state, outcome: job.outcome })) });
      const observedMs = now();
      for (const segment of detail.segments) {
        const row = records.get(segment.asr_sentence_id);
        if (row && !Number.isFinite(row.finalToTranslationMs) && !Number.isFinite(row.finalToTranslationHttpObservedMs) && segment.translation_state === 'complete') {
          row.finalToTranslationHttpObservedMs = observedMs - row.finalMs;
        }
      }
      for (const item of detail.knowledge) {
        const row = records.get(item.canonical_name);
        if (row && !Number.isFinite(row.finalToKnowledgeMs) && !Number.isFinite(row.finalToKnowledgeHttpObservedMs)) row.finalToKnowledgeHttpObservedMs = observedMs - row.finalMs;
      }
      const p = detail.processing, k = p.knowledge;
      assert.equal(p.failedTranslations, 0); assert.equal(k.failedJobs, 0);
      return !p.pendingTranslations && !k.pendingJobs && !k.runningJobs && !k.bufferedSegments && detail;
    }, 'background work settles');
  }
  async function stop(client, { drainWork = true } = {}) {
    await until(() => Number.isFinite(client.run.startToFirstPcmMs), 'first PCM');
    client.tts.send(JSON.stringify({ type: 'speech.stop', epoch: client.run.epoch }));
    client.ws.send(JSON.stringify({ type: 'stop' }));
    await until(() => client.ws.readyState === 3 && client.tts.readyState === 3, 'consumer socket cleanup', config.cleanupObservationMs);
    await until(() => fixture.stats.asrClients.size === 0, 'ASR upstream retained after stop', config.cleanupObservationMs);
    if (!drainWork) return;
    await drain(client.run.listeningId);
    await wait(config.sampleMs * 2);
    const samples = readFileSync(resourcesFile, 'utf8').trim().split('\n').map(JSON.parse);
    result.quiescent.push({ phase, listeningId: client.run.listeningId, resource: samples.at(-1), providerAsrConnections: fixture.stats.asrClients.size });
  }
  async function stage(name, operation) {
    phase = name; const row = { name, startedMs: now(), complete: false }; result.phases.push(row); raw('phase-start', { name });
    await operation(); Object.assign(row, { finishedMs: now(), complete: true }); raw('phase-end', row);
  }
  let primary;
  for (const [name, duration] of [['warmup', config.warmupMs], ['continuous', config.continuousMs]]) await stage(name, async () => {
    const client = await start(); primary = client.run.listeningId; const startMs = now();
    for (let slot = 0; slot < Math.ceil(duration / config.intervalMs); slot++) {
      await wait(Math.max(0, startMs + slot * config.intervalMs - now())); await send(client);
    }
    await wait(Math.max(0, startMs + duration - now())); await stop(client);
  });
  await stage('stop-start', async () => { for (let i = 0; i < config.restartCycles; i++) { const client = await start(primary); await send(client); await stop(client); } });
  await stage('switching', async () => {
    const switched = new Set();
    for (let i = 0; i < config.switchCycles; i++) {
      const client = await start(i % 2 ? primary : undefined); switched.add(client.run.listeningId);
      await send(client); await send(client);
      raw('switch-pending', { listeningId: client.run.listeningId, processing: (await (await request(`/api/listenings/${client.run.listeningId}`)).json()).processing });
      // Close old capture/playback, but let its real queued work overlap the next record.
      await stop(client, { drainWork: false });
    }
    for (const id of switched) await drain(id);
  });
  await stage('background', async () => {
    const client = await start(primary);
    for (let i = 0; i < config.backgroundSentences; i++) await send(client);
    const before = await (await request(`/api/listenings/${primary}`)).json();
    raw('background-before-stop', { processing: before.processing });
    assert.ok(before.processing.pendingTranslations || before.processing.knowledge.bufferedSegments || before.processing.knowledge.runningJobs, 'actual work remains pending before stop');
    await stop(client);
  });
  await stage('post-import', async () => {
    const exported = Buffer.from(await (await request('/api/data/export')).arrayBuffer());
    const preview = await (await request('/api/data/import/validate?mode=replace', { method: 'POST', body: exported })).json();
    const imported = await (await request('/api/data/import/commit', { method: 'POST', body: { mode: 'replace', token: preview.token, previewToken: preview.previewToken } })).json();
    assert.equal(imported.ok, true); raw('import', { bytes: exported.length, result: imported });
    const calls = fixture.stats.providerRequests.length; await wait(config.sampleMs * 2);
    assert.equal(fixture.stats.providerRequests.length, calls, 'restore does not auto-call providers');
    const client = await start(primary); await send(client); await stop(client);
  });
  const db = new DatabaseSync(fixture.seeded.filename, { readOnly: true });
  try { result.durable = Object.fromEntries(['listenings', 'listening_runs', 'segments', 'extraction_jobs', 'knowledge_items'].map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count])); }
  finally { db.close(); }
  result.complete = true;
} catch (error) { result.error = error.message; result.failure = { error: error.message, phase, providerAsrConnections: fixture?.stats.asrClients.size ?? null }; raw('failure', result.failure); }
finally {
  for (const ws of sockets) ws.terminate();
  try {
    if (fixture) {
      await fixture.close();
      assert.ok(fixture.child.exitCode != null || fixture.child.signalCode != null);
      assert.equal(existsSync(path.dirname(fixture.seeded.filename)), false);
      result.cleanup = { confirmed: true, serverExitCode: fixture.child.exitCode, serverSignal: fixture.child.signalCode, temporaryDatabaseRemoved: true, socketsClosed: sockets.every(ws => ws.readyState === 3) };
    }
  } catch (error) { result.cleanup.error = error.message; }
  const resources = existsSync(resourcesFile) ? readFileSync(resourcesFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  result.resourceSamples = resources.length;
  result.retainedCloseCalls = Math.max(0, ...resources.map(row => row.retainedCloseCalls));
  result.resourceSummary = resources.length ? {
    rssBytes: { first: resources[0].memory.rss, last: resources.at(-1).memory.rss, max: Math.max(...resources.map(row => row.memory.rss)) },
    cpuMicroseconds: resources.at(-1).cpuMicroseconds,
    descriptors: { first: resources[0].descriptors, last: resources.at(-1).descriptors },
    interpretation: 'Descriptive only. SQLite contents, caches and fixture records grow; no stability acceptance budget is approved.'
  } : null;
  for (const phase of result.phases) {
    const rows = result.samples.filter(row => row.phase === phase.name);
    phase.inputs = rows.length; phase.captionDeliveries = rows.filter(row => Number.isFinite(row.audioToCaptionMs)).length;
    phase.elapsedMs = phase.finishedMs == null ? null : phase.finishedMs - phase.startedMs;
    phase.captionDeliveriesPerSecond = phase.elapsedMs ? phase.captionDeliveries / (phase.elapsedMs / 1000) : null;
  }
  result.latencies = summarizeLatencies(result.samples);
  result.finishedAt = new Date().toISOString(); result.validation = validateBaselineRun(result);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ complete: result.complete, validation: result.validation, cleanup: result.cleanup, samples: result.samples.length }));
process.exitCode = result.validation.ok ? 0 : 1;
