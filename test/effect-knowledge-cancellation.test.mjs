import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeScheduler } from '../knowledge-queue.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { extractKnowledge, repairKnowledge } from '../knowledge.mjs';
import { createTaskRuntime, TaskCancelled } from '../dist/server/index.js';
import { speechFixture } from '../test-support/speech-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-cancel-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function add() {
    const run = store.createRun(null, settings, 'test');
    store.addSegment(run.listeningId, run.runId, { id: 'one', text: 'Anthropic builds AI systems.' });
    store.finishRun(run.runId);
    return run;
  }
  return { store, add };
}

test('deleting an in-flight knowledge job aborts it and releases the slot before ignored provider settles', async t => {
  const h = fixture(t), a = h.add(), b = h.add(), calls = [];
  const runtime = createTaskRuntime({ enabled: true });
  const scheduler = createKnowledgeScheduler({ store: h.store, listeningIds: () => [a.listeningId, b.listeningId],
    keyFor: () => 'fake-key', translationBusy: () => false, concurrency: 1, minStartIntervalMs: 0,
    taskRuntime: runtime, execute: (job, key, context) => new Promise((resolve, reject) => calls.push({ job, context, resolve, reject })) });
  t.after(async () => { await scheduler.close(); await runtime.dispose(); });
  scheduler.schedule(a.listeningId, true); scheduler.schedule(b.listeningId, true);
  assert.equal(calls.length, 1);
  assert.equal(h.store.removeListening(a.listeningId), 'deleted');
  scheduler.remove(a.listeningId);
  await tick();
  assert.equal(calls[0].context.signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].job.listening_id, b.listeningId);
  calls[0].reject(new Error('late result'));
  await tick();
  assert.equal(scheduler.hasWork(b.listeningId), true);
  assert.equal(h.store.hasListening(a.listeningId), false);
});

test('shutdown cancellation leaves v2 inflight checkpoint and late extract cannot commit', async t => {
  const h = fixture(t), a = h.add();
  const job = h.store.createExtractionJob(a.listeningId, h.store.extractionRange(a.listeningId));
  let resolveExtract;
  const workflow = createKnowledgeWorkflow({ store: h.store, endpoint: 'http://unused',
    extract: () => new Promise(resolve => { resolveExtract = resolve; }) });
  const runtime = createTaskRuntime();
  const task = runtime.start(job.id, { job_id: job.id, listening_id: a.listeningId }, context => workflow.execute(job, 'key', context));
  assert.equal(h.store.knowledgeCheckpoint(job.id).parts[0].phase, 'extract_inflight');
  task.cancel('application_shutdown');
  await assert.rejects(task.promise, TaskCancelled);
  resolveExtract({ accepted: [], rejected: [], returnedCount: 0, normalized: [] });
  await tick();
  assert.equal(h.store.knowledgeCheckpoint(job.id).parts[0].phase, 'extract_inflight');
  assert.equal(h.store.detail(a.listeningId).knowledge.length, 0);
  await runtime.dispose();
});

test('pre-cancelled knowledge workflow does not reserve budget or call the model', async t => {
  const h = fixture(t), a = h.add();
  const job = h.store.createExtractionJob(a.listeningId, h.store.extractionRange(a.listeningId));
  let calls = 0;
  const workflow = createKnowledgeWorkflow({ store: h.store, endpoint: 'http://unused', extract: async () => { calls++; } });
  const abort = new AbortController(); abort.abort(new TaskCancelled('listening_deleted'));
  await assert.rejects(workflow.execute(job, 'key', { signal: abort.signal }), TaskCancelled);
  assert.equal(calls, 0);
  assert.equal(h.store.knowledgeCheckpoint(job.id)?.parts.length ?? 0, 0);
});

test('scheduler notification failures cannot orphan a registered task or prevent the next dispatch', async t => {
  const h = fixture(t), a = h.add(), b = h.add(); let calls = 0;
  const scheduler = createKnowledgeScheduler({ store: h.store, listeningIds: () => [a.listeningId, b.listeningId],
    keyFor: () => 'key', translationBusy: () => false, concurrency: 1, minStartIntervalMs: 0,
    onChange: () => { throw new Error('notification'); }, onLog: () => { throw new Error('log'); },
    onError: () => { throw new Error('observer'); }, onIdle: () => { throw new Error('idle'); },
    execute: async () => { calls++; } });
  t.after(() => scheduler.close());
  scheduler.schedule(a.listeningId, true); scheduler.schedule(b.listeningId, true);
  await tick();
  assert.equal(calls, 2);
  assert.equal(scheduler.hasWork(a.listeningId), false);
  assert.equal(scheduler.hasWork(b.listeningId), false);
});

for (const phase of ['headers', 'body']) {
  test('knowledge HTTP cancellation reaches the real connection during ' + phase, async t => {
    let received, closed, requests = 0;
    const incoming = new Promise(resolve => { received = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((_req, res) => {
      requests++;
      res.once('close', closed);
      if (phase === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":'); }
      received();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const runtime = createTaskRuntime({ enabled: true });
    t.after(() => runtime.dispose());
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const task = runtime.start('job', { job_id: 'job', listening_id: 'listening' },
      context => extractKnowledge('secret-test-key', { policy_version: 2 }, endpoint, context));
    await incoming;
    task.cancel('listening_deleted');
    await assert.rejects(task.promise, TaskCancelled);
    await Promise.race([disconnected, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP connection not closed')), 1000);
      disconnected.then(() => clearTimeout(timer));
    })]);
    assert.equal(requests, 1);
    assert.equal(runtime.activeCount, 0);
    assert.doesNotMatch(JSON.stringify(runtime.diagnostics()), /secret-test-key/);
  });
}

test('repair cancellation reaches the request and does not retry', async t => {
  let received, calls = 0;
  const incoming = new Promise(resolve => { received = resolve; });
  const server = http.createServer((_req, res) => { calls++; res.writeHead(200); res.write('{"choices":'); received(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = createTaskRuntime(); t.after(() => runtime.dispose());
  const task = runtime.start('repair', { job_id: 'repair', listening_id: 'listening' }, context =>
    repairKnowledge('key', { policy_version: 2 }, 'http://127.0.0.1:' + server.address().port,
      [{ anchor: { kind: 'name' }, rawItem: {}, rejection_id: 'r', issues: [] }], context));
  await incoming; task.cancel('application_shutdown');
  await assert.rejects(task.promise, TaskCancelled); await tick();
  assert.equal(calls, 1);
});

test('HTTP delete releases knowledge concurrency and emitted spans identify the cancelled job', async t => {
  let firstStarted, secondStarted, releaseFirst;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  let calls = 0;
  const fixture = await speechFixture({
    extraEnv: { HEARWISE_TRACE: '1', EXTRACTION_CONCURRENCY: '1', EXTRACTION_WAIT_MS: '0' },
    seed(store) {
      return ['a', 'b'].map(name => {
        const run = store.createRun(null, { ...settings, source: 'zh' }, name);
        store.addSegment(run.listeningId, run.runId, { id: name, text: '测试知识任务' });
        store.finishRun(run.runId);
        const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
        return { id: run.listeningId, jobId: job.id };
      });
    },
    modelResponse(body) {
      if (body.model !== 'qwen3.8-flash') return undefined;
      if (++calls === 1) { firstStarted(); return new Promise(resolve => { releaseFirst = resolve; }); }
      secondStarted(); return { items: [] };
    }
  });
  t.after(async () => { releaseFirst?.({ items: [] }); await fixture.close(); });
  async function within(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture event timeout')), 2000); })]); }
    finally { clearTimeout(timer); }
  }
  for (const row of fixture.seeded) {
    const response = await fetch(`${fixture.base}/api/listenings/${row.id}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'secret-observability-test-key' }) });
    assert.equal(response.status, 202);
  }
  await within(first);
  assert.equal(calls, 1);
  const deletion = await fetch(`${fixture.base}/api/listenings/${fixture.seeded[0].id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  await within(second);
  assert.equal(calls, 2, 'second job starts without resolving the deleted provider request');
  assert.equal((await fetch(`${fixture.base}/api/listenings/${fixture.seeded[0].id}`)).status, 404);
  const traces = fixture.logs().split('\n').filter(line => line.startsWith('execution_trace ')).map(line => JSON.parse(line.slice(16)));
  assert.ok(traces.some(event => event.state === 'cancelled' && event.attributes.job_id === fixture.seeded[0].jobId));
  assert.ok(traces.every(event => event.build.instrumentation_version === 1));
  assert.doesNotMatch(fixture.logs(), /secret-observability-test-key/);
});
