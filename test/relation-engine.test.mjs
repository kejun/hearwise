import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createRelationWorkflow, relationRetryDelay } from '../relation-workflow.mjs';
import { createRelationScheduler } from '../relation-queue.mjs';
import { buildRelationRequest, extractRelations } from '../relations.mjs';
import { createProviderAdmission } from '../provider-admission.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

function fixture(t, { limits } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'relation-engine-')), file = path.join(dir, 'store.sqlite');
  let store = new ListeningStore(file);
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'relations');
  const seg = store.addSegment(run.listeningId, run.runId, { id: 'asr1', text: 'Atlas launched Nova.' }).segment;
  store.setTranslation(seg.id, 'Atlas 推出了 Nova。');
  for (const [id, name] of [['atlas', 'Atlas'], ['nova', 'Nova']]) {
    store.db.prepare(`INSERT INTO knowledge_items(id,listening_id,type,canonical_name,normalized_name,dialogue_summary,certainty,created_at,updated_at)
      VALUES(?,?,'other',?,?,?,'clear',?,?)`).run(id, run.listeningId, name, name.toLowerCase(), name, new Date().toISOString(), new Date().toISOString());
    store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(id, seg.id, name);
  }
  store.enableRelations(run.listeningId, { limits });
  const job = () => store.nextRelationJob(run.listeningId, { quietMs: 0, now: Date.now() });
  const result = input => {
    const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
    return request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version,
      relations: [{ subject_item_id: wire.candidates.find(c => c.canonical_name === 'Atlas').id,
        object_item_id: wire.candidates.find(c => c.canonical_name === 'Nova').id, predicate: 'released',
        polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: [wire.evidence[0].id] }] }));
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, run, seg, job, result, restart() { store.close(); store = new ListeningStore(file); } };
}

test('workflow persists each HTTP reservation before execution and commits bilingual evidence and usage', async t => {
  const h = fixture(t); const job = h.job(); let calls = 0;
  const workflow = createRelationWorkflow({ store: h.store, endpoint: 'mock', extract: async (key, input) => {
    calls++; assert.equal(key, 'memory-only');
    assert.equal(h.store.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(job.id).request_count, 1);
    assert.equal(input.focus_segments[0].translation, 'Atlas 推出了 Nova。');
    assert.ok(input.focus_segments[0].translation_revision);
    return { ...h.result(input), usage: { prompt_tokens: 12, completion_tokens: 13, total_tokens: 25 } };
  } });
  const done = await workflow.execute(job, 'memory-only');
  assert.equal(calls, 1); assert.equal(done.kind, 'terminal'); assert.equal(done.outcome, 'ok');
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 25);
  assert.equal(h.store.relationHasWork(h.run.listeningId), false);
});

test('empty model result completes without automatic repeat and existing graph survives errors', async t => {
  const h = fixture(t);
  const initial = createRelationWorkflow({ store: h.store, extract: async (_key, input) => h.result(input) });
  await initial.execute(h.job(), 'key');
  const existing = h.store.graph(h.run.listeningId).relations[0].id;
  h.store.db.prepare("UPDATE knowledge_items SET canonical_name=canonical_name||' Inc' WHERE id=?").run('atlas');
  const empty = createRelationWorkflow({ store: h.store, extract: async () => ({ relations: [], rejected: [] }) });
  assert.equal((await empty.execute(h.job(), 'key')).outcome, 'empty');
  assert.equal(h.store.graph(h.run.listeningId).relations[0].id, existing);
  assert.equal(h.job(), null);
  h.store.db.prepare("UPDATE knowledge_items SET canonical_name=canonical_name||' Inc' WHERE id=?").run('atlas');
  const fail = createRelationWorkflow({ store: h.store, extract: async () => { throw Object.assign(new Error('upstream secret'), { status: 401 }); } });
  const result = await fail.execute(h.job(), 'key');
  assert.equal(result.stopKey, true); assert.equal(result.outcome, 'failed');
  assert.equal(h.store.graph(h.run.listeningId).relations[0].id, existing);
  assert.equal(h.store.db.prepare('SELECT last_error FROM relation_jobs ORDER BY created_at DESC,rowid DESC LIMIT 1').get().last_error, 'HTTP_401');
});

test('stale translation/source/node version responses are discarded rather than overwriting', async t => {
  for (const change of ['translation', 'source', 'node']) {
    await t.test(change, async sub => {
      const h = fixture(sub), gate = deferred(), job = h.job();
      const workflow = createRelationWorkflow({ store: h.store, extract: () => gate.promise });
      const request = workflow.execute(job, 'key');
      if (change === 'translation') h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('Atlas 已推出 Nova', h.seg.id);
      if (change === 'source') h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Atlas did not launch Nova.', h.seg.id);
      if (change === 'node') h.store.db.prepare("UPDATE knowledge_items SET canonical_name=canonical_name||' Inc' WHERE id=?").run('atlas');
      gate.resolve(h.result(job.input));
      assert.equal((await request).kind, 'discarded');
      assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
      assert.ok(h.store.relationHasWork(h.run.listeningId));
    });
  }
});

test('deleting an in-flight listening cannot recreate nodes or edges', async t => {
  const h = fixture(t), gate = deferred(), job = h.job();
  const workflow = createRelationWorkflow({ store: h.store, extract: () => gate.promise });
  const request = workflow.execute(job, 'key');
  h.store.db.prepare('DELETE FROM listenings WHERE id=?').run(h.run.listeningId);
  gate.resolve(h.result(job.input));
  assert.equal((await request).kind, 'discarded');
  assert.equal(h.store.graph(h.run.listeningId), null);
});

test('transient retries and restart retain one durable three-request budget', async t => {
  const h = fixture(t); let clock = Date.now(), calls = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const workflow = createRelationWorkflow({ store: h.store, now: () => clock, extract: async () => {
      calls++; throw Object.assign(new Error('temporary'), { status: 429, retryAfterMs: 7000 });
    } });
    const job = h.store.nextRelationJob(h.run.listeningId, { now: clock, quietMs: 0 });
    const result = await workflow.execute(job, 'key');
    assert.equal(result.kind, attempt < 3 ? 'continue' : 'terminal');
    const count = h.store.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(job.id).request_count;
    assert.equal(count, attempt);
    clock += 15000;
    h.restart();
  }
  assert.equal(calls, 3); assert.equal(h.store.relationHasWork(h.run.listeningId), false);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'failed');
});

test('protocol retries are bounded and oversized Retry-After does not create an unbounded retry', () => {
  assert.equal(relationRetryDelay({ code: 'RELATION_INVALID_RESPONSE' }, 1), 3000);
  assert.equal(relationRetryDelay({ code: 'RELATION_INVALID_RESPONSE' }, 2), null);
  assert.equal(relationRetryDelay({ status: 429, retryAfterMs: 301000 }, 1), null);
  assert.equal(relationRetryDelay({ status: 403 }, 1), null);
  assert.equal(relationRetryDelay({ status: 500 }, 3), null);
});

test('provider admission postpones graph requests without reserving a network attempt', async t => {
  const h = fixture(t), provider = createProviderAdmission(), foreground = deferred();
  const busy = provider.run({ key: 'key', priority: 'translation' }, () => foreground.promise);
  const workflow = createRelationWorkflow({ store: h.store, provider, extract: async () => { throw new Error('must not call'); } });
  const job = h.job();
  assert.equal((await workflow.execute(job, 'key')).kind, 'continue');
  assert.equal(h.store.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(job.id).request_count, 0);
  foreground.resolve(); await busy;
});

function queueHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const jobs = new Map(), keys = new Map(), live = new Set(), calls = [], waiting = [], changes = [], errors = [];
  let sequence = 0, busy = false;
  const store = {
    hasListening: id => live.has(id), relationListeningIds: () => [...live],
    relationHasWork: id => (jobs.get(id) || []).some(j => ['pending', 'running'].includes(j.state)),
    markRelationWaitingKey: (id, value) => waiting.push([id, value]),
    relationProcessing: id => ({ pendingJobs: (jobs.get(id) || []).filter(j => j.state === 'pending').length,
      nextReadyAt: Math.min(...(jobs.get(id) || []).filter(j => j.state === 'pending').map(j => j.ready_at)) }),
    nextRelationJob: id => (jobs.get(id) || []).find(j => j.state === 'pending') || null,
    failRelationJob: (id, patch) => { const job = [...jobs.values()].flat().find(j => j.id === id); if (job) Object.assign(job, { state: patch.terminal ? 'failed' : 'pending', ready_at: patch.retryAt }); }
  };
  const queue = createRelationScheduler({ store, listeningIds: () => keys.keys(), keyFor: id => keys.get(id), foregroundBusy: () => busy,
    execute: (job, key, signal) => {
      const gate = deferred(); job.state = 'running'; calls.push({ job, key, signal, ...gate });
      return gate.promise.then(result => { job.state = result?.kind === 'continue' ? 'pending' : 'complete'; if (result?.readyAt) job.ready_at = result.readyAt; return result; });
    }, onChange: id => changes.push(id), onError: error => errors.push(error), minStartIntervalMs: 0, maxConcurrent: 1, ...options });
  t.after(() => queue.close());
  const add = (id, key = 'test-key') => { live.add(id); if (key) keys.set(id, key);
    const job = { id: `job${++sequence}`, listening_id: id, state: 'pending', ready_at: 0, request_count: 0 };
    jobs.set(id, [...(jobs.get(id) || []), job]); return job; };
  return { queue, store, jobs, keys, live, calls, changes, waiting, errors, add, setBusy(value) { busy = value; } };
}

test('scheduler never starts while realtime/TTS/knowledge busy and remains independent single concurrency', async t => {
  const h = queueHarness(t); h.add('a'); h.add('b'); h.setBusy(true); h.queue.schedule('a');
  t.mock.timers.tick(10000); assert.equal(h.calls.length, 0);
  h.setBusy(false); h.queue.pump(); assert.equal(h.calls.length, 1);
  h.queue.pump(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ kind: 'terminal' }); await settle(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ kind: 'terminal' }); await settle();
  assert.equal(h.queue.hasWork('a'), false); assert.equal(h.queue.hasWork('b'), false);
});

test('scheduler round-robin fairness prevents a listening backlog from taking every slot', async t => {
  const h = queueHarness(t); h.add('a'); h.add('a'); h.add('b'); h.add('c'); h.queue.pump();
  h.calls[0].resolve(); await settle(); h.calls[1].resolve(); await settle(); h.calls[2].resolve(); await settle();
  assert.deepEqual(h.calls.map(c => c.job.listening_id), ['a', 'b', 'c', 'a']);
  h.calls[3].resolve(); await settle();
});

test('keyless restart has honest waiting state, retains work and starts only after a key arrives', async t => {
  const h = queueHarness(t); h.add('a', null); h.queue.pump(); h.queue.pump();
  assert.equal(h.calls.length, 0); assert.equal(h.queue.hasWork('a'), true);
  assert.deepEqual(h.waiting, [['a', true]]);
  h.keys.set('a', 'new-key'); h.queue.pump();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.waiting, [['a', true], ['a', false]]);
  h.calls[0].resolve(); await settle();
});

test('429 shared cooldown gates other listenings using same key but not independent keys', async t => {
  const h = queueHarness(t); h.add('a', 'shared'); h.add('b', 'shared'); h.add('c', 'other'); h.queue.pump();
  h.calls[0].resolve({ kind: 'continue', readyAt: Date.now() + 7000, rateLimitMs: 7000 }); await settle();
  assert.equal(h.calls[1].job.listening_id, 'c');
  h.calls[1].resolve(); await settle(); assert.equal(h.calls.length, 2);
  t.mock.timers.tick(6999); assert.equal(h.calls.length, 2);
  t.mock.timers.tick(1); assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].job.listening_id, 'a');
  h.calls[2].resolve(); await settle(); h.calls[3].resolve(); await settle();
});

test('auth failure halts the key until explicit retry; delete and close abort in-flight work', async t => {
  const h = queueHarness(t); h.add('a'); h.add('b'); h.queue.pump();
  h.calls[0].resolve({ kind: 'terminal', stopKey: true }); await settle();
  assert.equal(h.calls.length, 1);
  h.queue.schedule('b', true); assert.equal(h.calls.length, 2);
  h.live.delete('b'); h.queue.remove('b'); assert.equal(h.calls[1].signal.aborted, true);
  h.calls[1].resolve({ kind: 'discarded' }); await settle();
  h.add('c'); h.queue.pump(); assert.equal(h.calls.length, 3);
  h.queue.close(); assert.equal(h.calls[2].signal.aborted, true);
  h.calls[2].resolve({ kind: 'discarded' }); await settle();
});

test('authentication failure exposes waiting_key for remaining windows and replacement key resumes them', async t => {
  const h = queueHarness(t); h.add('a', 'bad'); h.add('a', 'bad'); h.queue.pump();
  h.calls[0].resolve({ kind: 'terminal', stopKey: true }); await settle();
  assert.equal(h.calls.length, 1); assert.equal(h.queue.hasWork('a'), true);
  assert.deepEqual(h.waiting.at(-1), ['a', true]);
  h.keys.set('a', 'replacement'); h.queue.pump();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].key, 'replacement');
  assert.deepEqual(h.waiting.at(-1), ['a', false]);
  h.calls[1].resolve(); await settle();
});

test('deterministic input budget failure makes zero HTTP attempts and does not consume paid-request metrics', async t => {
  const h = fixture(t), job = h.job(); let calls = 0;
  job.input.focus_segments[0].text = 'x'.repeat(14001);
  const workflow = createRelationWorkflow({ store: h.store, extract: async () => { calls++; return { relations: [], rejected: [] }; } });
  assert.equal((await workflow.execute(job, 'key')).outcome, 'failed');
  assert.equal(calls, 0);
  assert.equal(h.store.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(job.id).request_count, 0);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.requests, 0);
});

test('terminal 429 preserves Retry-After across key release and explicit same-key resubmit', async t => {
  const provider = createProviderAdmission();
  let h;
  h = queueHarness(t, { provider, onIdle: id => {
    if (h.queue.hasWork(id)) return;
    const key = h.keys.get(id); h.keys.delete(id); provider.release(key);
  } });
  h.add('a', 'shared-key'); h.queue.pump();
  const started = Date.now();
  h.calls[0].resolve({ kind: 'terminal', outcome: 'failed', rateLimitMs: 600000 }); await settle();
  assert.equal(h.keys.has('a'), false);
  assert.equal(provider.readyAt('shared-key'), started + 600000);
  h.add('a', 'shared-key'); h.queue.schedule('a', true);
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(599999); h.queue.pump(); assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1); h.queue.pump(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(); await settle();
});

test('malformed paid model JSON preserves measured usage before protocol retry', async t => {
  const h = fixture(t);
  const workflow = createRelationWorkflow({ store: h.store, endpoint: 'mock',
    extract: (key, input, endpoint, options) => extractRelations(key, input, endpoint, { ...options,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not valid JSON' } }],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52, hidden: 'private' } }) }) }) });
  const result = await workflow.execute(h.job(), 'key');
  assert.equal(result.kind, 'continue');
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.usageLastHour.measuredRequests, 1);
  assert.equal(status.usageLastHour.totalTokens, 52);
  assert.equal(status.round.totalTokens, 52);
  assert.equal(status.waitReason, 'network_retry');
  assert.doesNotMatch(JSON.stringify(status), /private|not valid JSON/);
});

test('stalled extract ignoring abort is released at 30 seconds and late usage cannot alter graph', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), gate = deferred();
  const workflow = createRelationWorkflow({ store: h.store, extract: () => gate.promise });
  const job = h.job(), work = workflow.execute(job, 'key');
  await settle();
  t.mock.timers.tick(30000);
  const result = await work;
  assert.equal(result.kind, 'continue');
  assert.equal(h.store.relationProcessing(h.run.listeningId).runningJobs, 0);
  gate.resolve({ ...h.result(job.input), usage: { total_tokens: 80 } });
  await settle();
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.totalTokens, 80);
});

test('durable cancellation frees scheduler immediately and retains late paid usage after manual continuation', async t => {
  const h = fixture(t), gates = [], workflow = createRelationWorkflow({ store: h.store, extract: (_key, input) => {
    const gate = deferred(); gates.push({ ...gate, input }); return gate.promise;
  } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute, minStartIntervalMs: 0, quietMs: 0 });
  t.after(() => queue.close());
  queue.schedule(h.run.listeningId, true); await settle();
  const firstRound = h.store.relationProcessing(h.run.listeningId).round.id;
  h.store.cancelRelations(h.run.listeningId); queue.cancel(h.run.listeningId);
  await settle();
  assert.equal(queue.hasWork(h.run.listeningId), false);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'cancelled');
  h.store.enableRelations(h.run.listeningId, { retry: true });
  queue.schedule(h.run.listeningId, true); await settle();
  assert.equal(gates.length, 2);
  assert.notEqual(h.store.relationProcessing(h.run.listeningId).round.id, firstRound);
  gates[0].resolve({ ...h.result(gates[0].input), usage: { total_tokens: 71 } });
  await settle();
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 71);
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.totalTokens, 0);
  gates[1].resolve({ relations: [], rejected: [], usage: { total_tokens: 21 } });
  await settle();
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.totalTokens, 21);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 92);
});

test('foreground, missing-key and provider-cooldown waits remain resumable beyond the former two-minute deadline', async t => {
  for (const waiting of ['foreground', 'waiting_key', 'provider_cooldown']) await t.test(waiting, async sub => {
    sub.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const h = fixture(sub); let calls = 0, blocked = true;
    const workflow = createRelationWorkflow({ store: h.store, extract: async () => { calls++; return { relations: [] }; } });
    const queue = createRelationScheduler({ store: h.store, keyFor: () => waiting === 'waiting_key' && blocked ? null : 'key',
      foregroundBusy: () => waiting === 'foreground' && blocked,
      provider: { readyAt: () => waiting === 'provider_cooldown' && blocked ? Date.now() + 600000 : 0 },
      execute: workflow.execute, quietMs: 0 });
    sub.after(() => queue.close()); queue.schedule(h.run.listeningId, true);
    assert.equal(h.store.relationProcessing(h.run.listeningId).waitReason, waiting);
    sub.mock.timers.tick(180000); await settle();
    assert.equal(h.store.relationProcessing(h.run.listeningId).round.state, 'active');
    assert.equal(queue.hasWork(h.run.listeningId), true); assert.equal(calls, 0);
    blocked = false; queue.schedule(h.run.listeningId, true); await settle();
    assert.equal(calls, 1); assert.equal(queue.hasWork(h.run.listeningId), false);
  });
});

test('explicit cancellation frees an injected executor that ignores AbortSignal', async t => {
  const h = fixture(t), gate = deferred(); let signal;
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', quietMs: 0,
    execute: (_job, _key, value) => { signal = value; return gate.promise; } });
  t.after(() => queue.close()); queue.schedule(h.run.listeningId, true);
  assert.equal(signal.aborted, false);
  h.store.cancelRelations(h.run.listeningId); queue.cancel(h.run.listeningId); await settle();
  assert.equal(signal.aborted, true); assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'cancelled');
  assert.equal(queue.hasWork(h.run.listeningId), false);
  gate.resolve({ kind: 'terminal' }); await settle();
});

test('long provider cooldown crosses the former run deadline but retries only three times', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t); let calls = 0;
  const workflow = createRelationWorkflow({ store: h.store, extract: async () => {
    calls++; throw Object.assign(new Error('rate limit'), { status: 429, retryAfterMs: 180000 });
  } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute, quietMs: 0 });
  t.after(() => queue.close()); queue.schedule(h.run.listeningId, true); await settle();
  assert.equal(calls, 1);
  for (let attempt = 2; attempt <= 3; attempt++) {
    t.mock.timers.tick(179999); await settle(); assert.equal(calls, attempt - 1);
    t.mock.timers.tick(1); await settle(); assert.equal(calls, attempt);
  }
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'failed');
  t.mock.timers.tick(600000); await settle(); assert.equal(calls, 3); assert.equal(queue.hasWork(h.run.listeningId), false);
});

test('late usage from a timed-out attempt never overwrites a newer attempt in the same job', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), gates = [];
  const workflow = createRelationWorkflow({ store: h.store, extract: () => {
    const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const first = workflow.execute(h.job(), 'key'); await settle();
  t.mock.timers.tick(30000); await first;
  t.mock.timers.tick(3000);
  const job = h.job(), second = workflow.execute(job, 'key'); await settle();
  gates[0].resolve({ relations: [], rejected: [], usage: { total_tokens: 90 } }); await settle();
  let rows = h.store.db.prepare('SELECT attempt,usage_json FROM relation_requests WHERE job_id=? ORDER BY attempt').all(job.id);
  assert.equal(JSON.parse(rows[0].usage_json).total_tokens, 90);
  assert.equal(rows[1].usage_json, null);
  gates[1].resolve({ relations: [], rejected: [], usage: { total_tokens: 20 } }); await second;
  rows = h.store.db.prepare('SELECT attempt,usage_json FROM relation_requests WHERE job_id=? ORDER BY attempt').all(job.id);
  assert.equal(JSON.parse(rows[0].usage_json).total_tokens, 90);
  assert.equal(JSON.parse(rows[1].usage_json).total_tokens, 20);
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.totalTokens, 110);
});

test('workflow alone enforces each request timeout even after a long run and preserves late usage', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), gate = deferred(); let signal;
  t.mock.timers.tick(180000);
  const workflow = createRelationWorkflow({ store: h.store, extract: (_key, _input, _endpoint, options) => { signal = options.signal; return gate.promise; } });
  const work = workflow.execute(h.job(), 'key'); await settle();
  t.mock.timers.tick(30000); assert.equal((await work).kind, 'continue'); assert.equal(signal.aborted, true);
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.state, 'active');
  gate.resolve({ relations: [], rejected: [], usage: { total_tokens: 18 } }); await settle();
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.totalTokens, 18);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
});

test('restart while waiting retains the same run and no key means no paid requests', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), original = h.store.relationProcessing(h.run.listeningId).round;
  t.mock.timers.tick(180000); h.restart(); let calls = 0;
  const queue = createRelationScheduler({ store: h.store, keyFor: () => null, execute: async () => { calls++; } });
  t.after(() => queue.close()); queue.pump(); t.mock.timers.tick(180000); await settle();
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.round.id, original.id); assert.equal(status.state, 'waiting_key'); assert.equal(calls, 0);
  assert.equal(status.round.requestCount, 0); assert.equal(status.round.deadlineAt, undefined);
});

test('network retry wait reason remains distinct from quiet-period admission', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), workflow = createRelationWorkflow({ store: h.store, extract: async () => {
    throw Object.assign(new Error('temporary'), { status: 500 });
  } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute, minStartIntervalMs: 0, quietMs: 0 });
  t.after(() => queue.close());
  queue.schedule(h.run.listeningId, true); await settle();
  assert.equal(h.store.relationProcessing(h.run.listeningId).waitReason, 'network_retry');
});

test('scheduler catches SQLite admission locks and resumes without resetting attempts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), errors = [];
  const { DatabaseSync } = await import('node:sqlite');
  const filename = h.store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const blocker = new DatabaseSync(filename); h.store.db.exec('PRAGMA busy_timeout=1');
  const workflow = createRelationWorkflow({ store: h.store, extract: async () => ({ relations: [] }) });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute, quietMs: 0, onError: error => errors.push(error) });
  t.after(() => { queue.close(); blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE'); assert.doesNotThrow(() => queue.schedule(h.run.listeningId, true));
  assert.equal(errors.length, 1); assert.equal(h.store.relationProcessing(h.run.listeningId).round.requestCount, 0);
  blocker.exec('ROLLBACK'); t.mock.timers.tick(1000); await settle();
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'empty');
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.requestCount, 1);
});

test('SQLite lock after paid completion retries only finalization and cannot reject the detached task', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = fixture(t), errors = [];
  const { DatabaseSync } = await import('node:sqlite');
  const filename = h.store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const blocker = new DatabaseSync(filename); h.store.db.exec('PRAGMA busy_timeout=1');
  let calls = 0;
  const workflow = createRelationWorkflow({ store: h.store, extract: async () => {
    calls++; blocker.exec('BEGIN IMMEDIATE'); return { relations: [], usage: { total_tokens: 25 } };
  } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute, quietMs: 0, onError: error => errors.push(error) });
  t.after(() => { queue.close(); blocker.close(); });
  queue.schedule(h.run.listeningId, true); await settle();
  assert.equal(calls, 1); assert.ok(errors.length > 0);
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.requestCount, 1);
  blocker.exec('ROLLBACK'); t.mock.timers.tick(1000); await settle();
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'failed');
  assert.equal(queue.hasWork(h.run.listeningId), false);
  t.mock.timers.tick(600000); await settle(); assert.equal(calls, 1, 'storage failure never repeats the completed paid HTTP request');
});
