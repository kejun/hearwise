import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { createKnowledgeScheduler } from '../knowledge-queue.mjs';
import { parseKnowledgeV2 } from '../knowledge.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { createRelationScheduler } from '../relation-queue.mjs';
import { buildRelationRequest } from '../relations.mjs';
import { createTaskRuntime } from '../dist/server/index.js';
import { deadline, stopChild } from './lifecycle.mjs';
import { startServer } from './server-fixture.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function waitUntil(predicate, label) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`${label} exceeded 2000ms`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const item = (name, input) => ({ action: 'create', type: 'other', display_label: 'organization', canonical_name: name,
  role: '主体', reason: '原文讨论的公司', existing_item_id: null, observed_candidate_id: null, aliases: [], correction_reason: null,
  short_description: `${name}是原文讨论的公司。`, new_information: `${name}发布了新产品。`, certainty: 'clear',
  evidence: [{ segment_id: input.focus_segments[0].id, quote: name }] });

async function queryRestartedServer(filename, ids) {
  const server = await startServer({ env: { LISTENING_DB: filename, MT_ENDPOINT: 'http://127.0.0.1:9/not-used', HEARWISE_TRACE: '0' } });
  const observed = { pid: server.child.pid, parentPid: process.pid, startedAt: new Date().toISOString(), finishedAt: null, exit: null, queries: {} };
  try {
    const queries = observed.queries;
    for (const id of ids) {
      queries[id] = {};
      for (const [kind, suffix] of [['detail', ''], ['graph', '/graph']]) {
        const response = await fetch(`${server.base}/api/listenings/${id}${suffix}`, { signal: AbortSignal.timeout(3000) });
        queries[id][kind] = { status: response.status, body: await response.json() };
      }
    }
  } finally {
    await stopChild(server.child); observed.exit = { pid: server.child.pid, code: server.child.exitCode, signal: server.child.signalCode }; observed.finishedAt = new Date().toISOString();
  }
  return observed;
}

// Real runtime, scheduler, workflow and SQLite. The provider seam deliberately
// ignores AbortSignal. Its unresolved Promise represents physical work, not a
// retained local slot. Knowledge has no durable usage journal; don't invent one.
export async function createGenerationFixture({ protocol, capacity = 1, controlledAdmission = false } = {}) {
  if (protocol === 'relation') return createRelationGenerationFixture({ capacity, controlledAdmission });
  assert.equal(protocol, 'knowledge'); assert.ok([1, 2].includes(capacity));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-generation-'));
  const filename = path.join(directory, 'store.sqlite');
  let store, runtime, scheduler, closed = false, clock = Date.now(), timerId = 0, storeGeneration = 0;
  const sessions = new Map(), tasks = new Map(), keys = new Set(), timers = new Map();
  const calls = [], ledger = [], executions = [], errors = [], notifications = [], admissions = [];
  const record = (event, values = {}) => ledger.push({ sequence: ledger.length, event, ...values });
  let permit = false;
  const providerAdmission = controlledAdmission ? { readyAt: () => {
    const readyAt = permit ? clock : clock + 60000;
    record('admission_readiness', { clock, readyAt, permit }); return readyAt;
  } } : undefined;
  const consumePermit = job => {
    if (!controlledAdmission) return;
    assert.equal(permit, true, 'Actual scheduler admission must consume one explicit permit');
    permit = false; record('admission_consumed', { clock, jobId: job.id, listeningId: job.listening_id,
      attempt: job.attempts ?? null, epoch: job.epoch ?? null });
  };
  const idleCounts = new Map(), cleanupWaits = [];
  const idle = id => { idleCounts.set(id, (idleCounts.get(id) || 0) + 1); record('scheduler_idle', { listeningId: id }); };
  const expectCleanup = selected => {
    const pending = selected.filter(execution => !execution.settled);
    const expected = new Map();
    for (const execution of pending) expected.set(execution.listeningId, (expected.get(execution.listeningId) || 0) + 1);
    cleanupWaits.push({ pending, expected: [...expected].map(([id, count]) => ({ id, count: count + (idleCounts.get(id) || 0) })) });
  };
  const cleaned = () => cleanupWaits.every(wait => wait.pending.every(execution => execution.settled) && wait.expected.every(({ id, count }) => (idleCounts.get(id) || 0) >= count));
  const settle = async () => {
    await waitUntil(() => (closed || admissions.every(admission => executions.some(execution => execution.jobId === admission.job_id && execution.attempt === admission.attempt))) &&
      (closed || cleaned()) && executions.every(execution => execution.settled || calls.some(call => call.jobId === execution.jobId && ['reserved', 'pending'].includes(call.status) && !call.signal.aborted)) &&
      calls.every(call => call.response === null || call.transportSettled), 'knowledge real workflow/admission settlement');
    record('settlement_barrier', { admissions: admissions.length, executions: executions.length, calls: calls.length });
  };
  const error = value => errors.push({ name: value.name, code: value.code || null, message: value.message });
  function provider(job, input, context) {
    const task = tasks.get(job.id); assert.ok(task);
    const gate = deferred();
    const call = { index: calls.length, listeningId: job.listening_id, jobId: job.id, name: task.name,
      input: structuredClone(input), signal: context.signal, status: controlledAdmission ? 'reserved' : 'pending', sent: !controlledAdmission, transportSettled: false, deliveries: 0, response: null, responseWire: null, responseValue: null, responseError: null, gate };
    gate.promise.then(() => { call.status = 'settled'; call.transportSettled = true; }, () => { call.status = 'settled'; call.transportSettled = true; });
    calls.push(call); record(controlledAdmission ? 'provider_reserved' : 'provider_started', { index: call.index, listeningId: call.listeningId, jobId: call.jobId });
    context.signal.addEventListener('abort', () => record('provider_abort_observed', { index: call.index, name: context.signal.reason?.name || null, code: context.signal.reason?.code || null, reason: context.signal.reason?.reason || context.signal.reason?.message || null }), { once: true });
    // No abort listener resolves/rejects this gate: the external request can
    // remain physical after TaskRuntime has already released its registration.
    return gate.promise;
  }
  function openScheduler() {
    storeGeneration++;
    runtime = createTaskRuntime({ enabled: true, capacity: 10000 });
    scheduler = createKnowledgeScheduler({ store, taskRuntime: runtime, concurrency: capacity, provider: providerAdmission,
      listeningIds: () => sessions.keys(), keyFor: id => keys.has(id) ? 'synthetic-generation-key' : null,
      translationBusy: () => false, now: () => clock,
      setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimer: id => timers.delete(id), onError: error, onIdle: idle,
      onLog: entry => { if (entry.state === 'running') {
        consumePermit({ id: entry.job_id, listening_id: entry.listening_id, attempts: entry.attempt });
        admissions.push(structuredClone(entry));
      } },
      onChange: (id, flags) => notifications.push({ id, flags: flags || null }),
      execute: async (job, key, context) => {
        const execution = { jobId: job.id, listeningId: job.listening_id, attempt: job.attempts, settled: false, result: null, error: null };
        executions.push(execution);
        const workflow = createKnowledgeWorkflow({ store, now: () => clock, endpoint: 'mock://generation-no-network',
          extract: (_key, input, _endpoint, child) => provider(job, input, child),
          onError: error });
        try { execution.result = await workflow.execute(job, key, context); return execution.result; }
        catch (failure) { execution.error = { name: failure.name, code: failure.code || null }; throw failure; }
        finally { execution.settled = true; }
      }
    });
  }
  try { store = new ListeningStore(filename); openScheduler(); } catch (failure) {
    try { await runtime?.dispose(); } finally { try { store?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    throw failure;
  }
  const snapshot = () => {
    const db = new DatabaseSync(filename, { readOnly: true });
    let durable;
    try {
      durable = { listenings: db.prepare('SELECT * FROM listenings ORDER BY id').all(),
        listening_runs: db.prepare('SELECT * FROM listening_runs ORDER BY rowid').all(),
        segments: db.prepare('SELECT * FROM segments ORDER BY listening_id,sequence_no').all(),
        jobs: db.prepare('SELECT * FROM extraction_jobs ORDER BY listening_id,from_sequence').all().map(job => ({ ...job,
          progress: JSON.parse(job.progress_json), parts: db.prepare('SELECT * FROM extraction_parts WHERE job_id=? ORDER BY part_no').all(job.id).map(part => ({ ...part,
            focus_refs: JSON.parse(part.focus_refs), unresolved: JSON.parse(part.unresolved), results: JSON.parse(part.results), stats: JSON.parse(part.stats), input_snapshot: part.input_snapshot ? JSON.parse(part.input_snapshot) : null })) })),
        knowledge_aliases: db.prepare('SELECT * FROM knowledge_aliases ORDER BY rowid').all(),
        knowledge_mentions: db.prepare('SELECT * FROM knowledge_mentions ORDER BY rowid').all(), knowledge_revisions: db.prepare('SELECT * FROM knowledge_revisions ORDER BY rowid').all(),
        knowledge: db.prepare('SELECT * FROM knowledge_items ORDER BY id').all(), facts: db.prepare('SELECT * FROM knowledge_facts ORDER BY id').all(),
        foreignKeys: db.prepare('PRAGMA foreign_key_check').all() };
    } finally { db.close(); }
    return { hostPid: process.pid, clock, database: { file: filename, device: statSync(filename).dev, inode: statSync(filename).ino, storeGeneration }, admission: { controlled: controlledAdmission, permit }, durable, queries: Object.fromEntries([...sessions.keys()].map(id => [id, { detail: store.detail(id), graph: store.graph(id) }])),
      calls: calls.map(({ gate: _gate, onUsage: _onUsage, signal, ...call }) => ({ ...call, aborted: signal.aborted })),
      executions: structuredClone(executions), ledger: structuredClone(ledger), runtime: { activeCount: runtime.activeCount, diagnostics: runtime.diagnostics() },
      errors: structuredClone(errors), notifications: structuredClone(notifications) };
  };
  return {
    get store() { return store; }, get scheduler() { return scheduler; }, calls, snapshot, settle,
    permitAdmission() {
      assert.equal(controlledAdmission, true); assert.equal(permit, false);
      clock += 6000; permit = true; record('admission_permit', { clock });
    },
    async admit() {
      assert.equal(controlledAdmission, true); assert.equal(permit, true);
      const before = executions.length; scheduler.pump();
      await waitUntil(() => executions.length === before + 1, 'one real scheduler admission');
      await settle(); assert.equal(permit, false); assert.equal(executions.length, before + 1);
      return executions.at(-1).jobId;
    },
    async send(index) {
      assert.equal(controlledAdmission, true); const call = calls[index]; assert.ok(call);
      assert.equal(call.status, 'reserved'); assert.equal(call.signal.aborted, false);
      call.sent = true; call.status = 'pending'; record('provider_started', { index, listeningId: call.listeningId, jobId: call.jobId });
      await settle();
    },
    addListening() {
      const run = store.createRun(null, settings, 'Synthetic generation isolation'); sessions.set(run.listeningId, run); return run.listeningId;
    },
    addTask(id, name) {
      const run = sessions.get(id); assert.ok(run);
      const segment = store.addSegment(id, run.runId, { id: `synthetic-${tasks.size}`, text: `${name} released a new product.` }).segment;
      const job = store.createExtractionJob(id, [segment]);
      // A valid initialized pending job is not eligible for pre-dispatch merging.
      store.initializeKnowledgeParts(job.id, [{ part_no: 0, focus_refs: [{ segment_id: segment.id, start: 0, end: segment.original_text.length }] }]);
      tasks.set(job.id, { name, segmentId: segment.id }); return job.id;
    },
    enable(id) { keys.add(id); scheduler.pump(); },
    async cancel(id) {
      expectCleanup(executions.filter(execution => execution.listeningId === id));
      if (!controlledAdmission) keys.delete(id); runtime.cancelListening(id, 'user_cancelled'); await settle(); scheduler.pump(); await settle();
    },
    async delete(id) {
      expectCleanup(executions.filter(execution => execution.listeningId === id));
      store.finishRun(sessions.get(id).runId);
      assert.equal(store.removeListening(id), 'deleted');
      runtime.cancelListening(id); keys.delete(id); scheduler.remove(id); await settle();
    },
    async restartQueries(ids) {
      await deadline(() => scheduler.close(), 3000, 'knowledge restart scheduler close');
      await deadline(() => runtime.dispose(), 3000, 'knowledge restart runtime close');
      record('local_resources_closed', { storeGeneration, activeCount: runtime.activeCount, activeExecutions: executions.filter(execution => !execution.settled).length, timers: timers.size });
      store.close();
      try { const observed = await queryRestartedServer(filename, ids); record('restart_http', observed); return observed.queries; }
      finally { store = new ListeningStore(filename); openScheduler(); record('scheduler_reopened', { protocol: 'knowledge' }); }
    },
    async respond(index, response) {
      const call = calls[index]; assert.ok(call); assert.equal(call.sent, true, 'Response requires an actual provider send'); assert.ok(['ok', 'empty', 'failure'].includes(response));
      if (call.status === 'pending') expectCleanup(executions.filter(execution => execution.jobId === call.jobId));
      call.deliveries++; record('provider_delivery', { index, response, delivery: call.deliveries });
      const firstDelivery = call.status === 'pending';
      if (firstDelivery) call.response = response;
      if (response === 'failure') {
        const failure = Object.assign(new Error('Synthetic provider configuration failure'), { status: 418 });
        if (firstDelivery) call.responseError = { name: failure.name, message: failure.message, status: failure.status };
        call.gate.reject(failure);
      } else {
        const wire = JSON.stringify({ items: response === 'ok' ? [item(call.name, call.input)] : [] });
        const value = parseKnowledgeV2(wire, call.input);
        if (firstDelivery) { call.responseWire = wire; call.responseValue = JSON.parse(JSON.stringify(value)); }
        call.gate.resolve(value);
      }
      await settle();
    },
    async advance(milliseconds = 2000) { clock += milliseconds; scheduler.pump(); await settle(); },
    async close() {
      if (closed) return; closed = true;
      const results = await Promise.allSettled([deadline(() => scheduler.close(), 3000, 'generation scheduler close'),
        deadline(() => runtime.dispose(), 3000, 'generation runtime close')]);
      for (const call of calls) if (['reserved', 'pending'].includes(call.status)) call.gate.resolve({ accepted: [], rejected: [], returnedCount: 0, normalized: [] });
      try { await waitUntil(() => executions.every(execution => execution.settled) && calls.every(call => call.transportSettled) && runtime.activeCount === 0, 'knowledge actual execution cleanup'); } finally { try { store.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Generation fixture cleanup failed');
    }
  };
}

async function createRelationGenerationFixture({ capacity, controlledAdmission }) {
  assert.ok([1, 2].includes(capacity));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-relation-generation-'));
  const filename = path.join(directory, 'store.sqlite');
  let store, scheduler, closed = false, clock = Date.now(), timerId = 0, storeGeneration = 0;
  const sessions = new Map(), tasks = new Map(), keys = new Set(), timers = new Map();
  const calls = [], ledger = [], executions = [], errors = [], notifications = [];
  const record = (event, values = {}) => ledger.push({ sequence: ledger.length, event, ...values });
  let permit = false;
  const providerAdmission = controlledAdmission ? { readyAt: () => {
    const readyAt = permit ? clock : clock + 60000;
    record('admission_readiness', { clock, readyAt, permit }); return readyAt;
  } } : undefined;
  const consumePermit = job => {
    if (!controlledAdmission) return;
    assert.equal(permit, true, 'Actual scheduler admission must consume one explicit permit');
    permit = false; record('admission_consumed', { clock, jobId: job.id, listeningId: job.listening_id,
      attempt: job.attempts ?? null, epoch: job.epoch ?? null });
  };
  const idleCounts = new Map(), cleanupWaits = [];
  const idle = id => { idleCounts.set(id, (idleCounts.get(id) || 0) + 1); record('scheduler_idle', { listeningId: id }); };
  const expectCleanup = selected => {
    const pending = selected.filter(execution => !execution.settled);
    const expected = new Map();
    for (const execution of pending) expected.set(execution.listeningId, (expected.get(execution.listeningId) || 0) + 1);
    cleanupWaits.push({ pending, expected: [...expected].map(([id, count]) => ({ id, count: count + (idleCounts.get(id) || 0) })) });
  };
  const cleaned = () => cleanupWaits.every(wait => wait.pending.every(execution => execution.settled) && wait.expected.every(({ id, count }) => (idleCounts.get(id) || 0) >= count));
  const settle = async () => {
    await waitUntil(() => (closed || cleaned()) && executions.every(execution => execution.settled ||
      calls.some(call => call.jobId === execution.jobId && ['reserved', 'pending'].includes(call.status) && !call.signal.aborted)) &&
      calls.every(call => call.response === null || call.transportSettled), 'relation real workflow/admission settlement');
    record('settlement_barrier', { executions: executions.length, calls: calls.length });
  };
  const error = value => errors.push({ name: value.name, code: value.code || null, message: value.message });
  function openScheduler() {
    storeGeneration++;
    const recordUsage = store.recordRelationUsage.bind(store);
    store.recordRelationUsage = (jobId, detail) => {
      const result = recordUsage(jobId, detail);
      record('usage_persisted', { jobId, attempt: detail.attempt, outcome: detail.outcome });
      return result;
    };
    scheduler = createRelationScheduler({ store, maxConcurrent: capacity, provider: providerAdmission, now: () => clock,
      listeningIds: () => sessions.keys(), keyFor: id => keys.has(id) ? 'synthetic-generation-key' : null,
      setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimer: id => timers.delete(id), onError: error, onIdle: idle,
      onChange: (id, result) => notifications.push({ id, result: result || null }),
      execute: async (job, key, signal) => {
        consumePermit(job);
        const execution = { jobId: job.id, listeningId: job.listening_id, settled: false, result: null, error: null }; executions.push(execution);
        // Read-only call-through observation of the actual workflow's presence
        // guard. The proxy remains bound to this store, including after close;
        // late callbacks are never redirected into the replacement connection.
        const workflowStore = new Proxy(store, { get(target, property) {
          if (property === 'hasListening') return id => {
            try { const present = target.hasListening(id); record('workflow_presence_checked', { jobId: job.id, listeningId: id, present, error: null }); return present; }
            catch (failure) { record('workflow_presence_checked', { jobId: job.id, listeningId: id, present: null, error: failure.code || failure.name }); throw failure; }
          };
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
        const workflow = createRelationWorkflow({ store: workflowStore, now: () => clock, endpoint: 'mock://generation-no-network', onError: error,
          extract: (_key, input, _endpoint, context) => {
            const task = [...tasks.values()].find(task => task.segmentIds.includes(input.focus_segments[0].id)); assert.ok(task);
            const gate = deferred(), call = { index: calls.length, listeningId: job.listening_id, jobId: job.id, attempt: store.getRelationJob(job.id).request_count, name: task.name, onUsage: context.onUsage,
              input: structuredClone(input), signal: context.signal, status: controlledAdmission ? 'reserved' : 'pending', sent: !controlledAdmission, transportSettled: false, deliveries: 0, response: null, responseWire: null, responseValue: null, responseError: null, gate };
            gate.promise.then(() => { call.status = 'settled'; call.transportSettled = true; }, () => { call.status = 'settled'; call.transportSettled = true; });
            calls.push(call); record(controlledAdmission ? 'provider_reserved' : 'provider_started', { index: call.index, listeningId: call.listeningId, jobId: call.jobId });
            context.signal.addEventListener('abort', () => record('provider_abort_observed', { index: call.index, name: context.signal.reason?.name || null, code: context.signal.reason?.code || null, reason: context.signal.reason?.reason || context.signal.reason?.message || null }), { once: true });
            return gate.promise;
          } });
        try { execution.result = await workflow.execute(job, key, signal); return execution.result; }
        catch (failure) { execution.error = { name: failure.name, code: failure.code || null }; throw failure; }
        finally { execution.settled = true; }
      }
    });
  }
  try { store = new ListeningStore(filename); openScheduler(); } catch (failure) { store?.close(); await rm(directory, { recursive: true, force: true }); throw failure; }
  const snapshot = () => {
    const db = new DatabaseSync(filename, { readOnly: true }); let durable;
    try {
      durable = Object.fromEntries(['listenings', 'listening_runs', 'segments', 'relation_rounds', 'relation_windows', 'relation_jobs', 'relation_requests',
        'knowledge_items', 'knowledge_facts', 'knowledge_aliases', 'knowledge_mentions', 'knowledge_revisions', 'relations', 'relation_assertions', 'relation_supports', 'relation_revisions'].map(table => [table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      durable.foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    } finally { db.close(); }
    return { hostPid: process.pid, clock, database: { file: filename, device: statSync(filename).dev, inode: statSync(filename).ino, storeGeneration }, admission: { controlled: controlledAdmission, permit }, durable, queries: Object.fromEntries([...sessions.keys()].map(id => [id, { detail: store.detail(id), graph: store.graph(id) }])),
      calls: calls.map(({ gate: _gate, onUsage: _onUsage, signal, ...call }) => ({ ...call, aborted: signal.aborted })),
      executions: structuredClone(executions), ledger: structuredClone(ledger), errors: structuredClone(errors), notifications: structuredClone(notifications) };
  };
  return {
    get store() { return store; }, get scheduler() { return scheduler; }, calls, snapshot, settle,
    permitAdmission() {
      assert.equal(controlledAdmission, true); assert.equal(permit, false);
      clock += 6000; permit = true; record('admission_permit', { clock });
    },
    async admit() {
      assert.equal(controlledAdmission, true); assert.equal(permit, true);
      const before = executions.length; scheduler.pump();
      await waitUntil(() => executions.length === before + 1, 'one real scheduler admission');
      await settle(); assert.equal(permit, false); assert.equal(executions.length, before + 1);
      return executions.at(-1).jobId;
    },
    async send(index) {
      assert.equal(controlledAdmission, true); const call = calls[index]; assert.ok(call);
      assert.equal(call.status, 'reserved'); assert.equal(call.signal.aborted, false);
      call.sent = true; call.status = 'pending'; record('provider_started', { index, listeningId: call.listeningId, jobId: call.jobId });
      await settle();
    },
    addListening() { const run = store.createRun(null, settings, 'Synthetic relation generation isolation'); sessions.set(run.listeningId, run); return run.listeningId; },
    addTask(id, name) {
      const run = sessions.get(id); assert.ok(run); const ordinal = tasks.size, other = name.replace('Atlas', 'Nova');
      const segments = Array.from({ length: 6 }, (_, index) => {
        const row = store.addSegment(id, run.runId, { id: `generation-${ordinal}-${index}`, text: `${name} launched ${other}.` }).segment;
        store.setTranslation(row.id, `${name}推出了${other}。`); return row;
      });
      const input = { focus_segments: [{ id: segments[0].id, text: segments[0].original_text }] };
      store.applyKnowledgeV2(id, [item(name, input), item(other, input)]);
      tasks.set(ordinal, { name, segmentIds: segments.map(row => row.id) }); return ordinal;
    },
    enable(id) { keys.add(id); store.enableRelations(id, { retry: true, now: clock }); scheduler.schedule(id, true); },
    async cancel(id) { expectCleanup(executions.filter(execution => execution.listeningId === id)); store.cancelRelations(id); scheduler.cancel(id); await settle(); },
    async delete(id) {
      expectCleanup(executions.filter(execution => execution.listeningId === id));
      store.finishRun(sessions.get(id).runId);
      assert.equal(store.removeListening(id), 'deleted'); keys.delete(id); scheduler.remove(id); await settle();
    },
    async restartQueries(ids) {
      scheduler.close(); await settle();
      record('local_resources_closed', { storeGeneration, activeExecutions: executions.filter(execution => !execution.settled).length, timers: timers.size });
      store.close();
      try { const observed = await queryRestartedServer(filename, ids); record('restart_http', observed); return observed.queries; }
      finally { store = new ListeningStore(filename); openScheduler(); record('scheduler_reopened', { protocol: 'relation' }); }
    },
    async reportUsage(index, totalTokens) {
      const call = calls[index]; assert.ok(call); assert.ok(Number.isSafeInteger(totalTokens) && totalTokens >= 0);
      record('provider_usage', { index, totalTokens }); call.onUsage({ total_tokens: totalTokens }); await settle();
    },
    async respond(index, response) {
      const call = calls[index]; assert.ok(call); assert.equal(call.sent, true, 'Response requires an actual provider send'); assert.ok(['ok', 'empty', 'failure'].includes(response));
      const usageFrom = ledger.length, firstDelivery = call.status === 'pending';
      if (call.status === 'pending') expectCleanup(executions.filter(execution => execution.jobId === call.jobId));
      call.deliveries++; record('provider_delivery', { index, response, delivery: call.deliveries });
      if (call.status === 'pending') call.response = response;
      if (response === 'failure') {
        const failure = Object.assign(new Error('Synthetic provider configuration failure'), { status: 418, usage: { total_tokens: 11 } });
        if (firstDelivery) call.responseError = { name: failure.name, message: failure.message, status: failure.status, usage: failure.usage };
        call.gate.reject(failure);
      }
      else {
        const request = buildRelationRequest(call.input), wire = JSON.parse(request.body.messages[1].content);
        const evidence = wire.evidence.find(entry => entry.scope === 'focus' && entry.quote.includes(call.name) && entry.quote.includes(call.name.replace('Atlas', 'Nova')));
        assert.ok(response === 'empty' || evidence, 'Synthetic relation must cite its own focus window, not previous context');
        const responseWire = JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version,
          relations: response === 'empty' ? [] : [{ subject_item_id: wire.candidates.find(candidate => candidate.canonical_name === call.name).id,
            object_item_id: wire.candidates.find(candidate => candidate.canonical_name === call.name.replace('Atlas', 'Nova')).id,
            predicate: 'released', polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] }] });
        const parsed = request.parse(responseWire);
        const value = { ...parsed, usage: { total_tokens: 11 } };
        if (firstDelivery) { call.responseWire = responseWire; call.responseValue = JSON.parse(JSON.stringify(value)); }
        call.gate.resolve(value);
      }
      if (firstDelivery) {
        if (store.hasListening(call.listeningId)) await waitUntil(() => ledger.slice(usageFrom).some(entry =>
          entry.event === 'usage_persisted' && entry.jobId === call.jobId && entry.attempt === call.attempt), 'actual late/current usage persistence');
        else await waitUntil(() => ledger.slice(usageFrom).some(entry => entry.event === 'workflow_presence_checked' &&
          entry.jobId === call.jobId && (entry.present === false || entry.error !== null)), 'actual deleted-listening callback guard');
      }
      await settle();
    },
    async advance(milliseconds = 2000) { clock += milliseconds; scheduler.pump(); await settle(); },
    async close() {
      if (closed) return; closed = true; scheduler.close();
      const usageFrom = ledger.length, usagePending = calls.filter(call => ['reserved', 'pending'].includes(call.status) && store.hasListening(call.listeningId));
      for (const call of calls) if (['reserved', 'pending'].includes(call.status)) call.gate.resolve({ relations: [], rejected: [], usage: { total_tokens: 0 } });
      try { await waitUntil(() => executions.every(execution => execution.settled) && calls.every(call => call.transportSettled) && usagePending.every(call => ledger.slice(usageFrom).some(entry => entry.event === 'usage_persisted' && entry.jobId === call.jobId && entry.attempt === call.attempt)), 'relation actual execution cleanup'); } finally { try { store.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    }
  };
}
