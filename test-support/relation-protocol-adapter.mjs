import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { createProviderAdmission } from '../provider-admission.mjs';
import { buildRelationRequest } from '../relations.mjs';
import { deadline } from './lifecycle.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const waiting = (gate, label) => deadline(() => gate.promise, 2000, label);
const providerError = response => {
  const error = new Error(`Synthetic ${response}`);
  if (response === 'protocol') error.code = 'RELATION_INVALID_RESPONSE';
  else if (response === 'transient') error.status = 500;
  else if (response === 'auth') error.status = 401;
  else if (response === 'rate_limit') Object.assign(error, { status: 429, retryAfterMs: 7000 });
  else if (response === 'rate_limit_long') Object.assign(error, { status: 429, retryAfterMs: 301000 });
  else assert.equal(response, 'unexpected');
  return error;
};

// Public workflow/provider/diagnostics seams control asynchronous boundaries.
// Only synthetic fixture setup and necessary durable projections use SQLite.
export async function createRelationProtocolAdapter({ actors = 1, capacity = 1, mode = 'valid', mutation = 'none' } = {}) {
  assert.ok([1, 3].includes(actors));
  assert.ok([1, 2].includes(capacity));
  assert.ok(['valid', 'reserve_fail', 'no_candidates'].includes(mode));
  assert.ok(['none', 'skip_reservation', 'corrupt_committed_state'].includes(mutation));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-relation-protocol-'));
  const store = new ListeningStore(path.join(directory, 'store.sqlite'));
  const tasks = [], sessions = [];
  let clock = Date.now(), closed = false;
  const provider = createProviderAdmission({ now: () => clock });
  // Deliberately broken test-only instance, never a production configuration.
  if (mutation === 'skip_reservation') store.beginRelationRequest = jobId => store.getRelationJob(jobId);
  try {
    for (let session = 0; session < (actors === 1 ? 1 : 2); session++) {
      const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic protocol replay');
      sessions.push(run);
      const actorIds = session === 0 ? (actors === 1 ? [0] : [0, 2]) : [1];
      for (const [window, actor] of actorIds.entries()) {
        const names = [`Atlas ${actor}`, `Nova ${actor}`], nodes = names.map((_, index) => `protocol-${actor}-${index}`);
        const segments = Array.from({ length: 6 }, (_, index) => {
          const segment = store.addSegment(run.listeningId, run.runId, { id: `asr-${actor}-${index}`, text: `${names[0]} launched ${names[1]}.` }).segment;
          store.setTranslation(segment.id, `${names[0]} 推出了 ${names[1]}。`);
          return segment;
        });
        for (const [index, name] of names.slice(0, mode === 'no_candidates' ? 1 : 2).entries()) {
          store.db.prepare(`INSERT INTO knowledge_items(id,listening_id,type,canonical_name,normalized_name,dialogue_summary,certainty,created_at,updated_at)
            VALUES(?,?,'other',?,?,?,'clear',?,?)`).run(nodes[index], run.listeningId, name, name.toLowerCase(), name, new Date().toISOString(), new Date().toISOString());
          for (const segment of segments) store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(nodes[index], segment.id, name);
        }
        tasks[actor] = { actor, session, window, listeningId: run.listeningId, windowId: `${run.listeningId}:${window}`, nodes, names,
          calls: 0, phase: 'idle', outcome: 'none', reply: 'none', job: null, errors: [], notifications: 0 };
      }
      store.enableRelations(run.listeningId, { now: clock });
    }
  } catch (error) { store.close(); await rm(directory, { recursive: true, force: true }); throw error; }

  const parsedResponse = (task, response) => {
    const request = buildRelationRequest(task.input), wire = JSON.parse(request.body.messages[1].content);
    const relations = response === 'empty' ? [] : [{
      subject_item_id: wire.candidates.find(row => row.canonical_name === task.names[0]).id,
      object_item_id: wire.candidates.find(row => row.canonical_name === task.names[1]).id,
      predicate: 'released', polarity: response === 'filtered' ? undefined : 'positive', modality: 'asserted', status: 'active',
      evidence_ids: [wire.evidence.find(row => row.quote.includes(task.names[0]) && row.quote.includes(task.names[1])).id]
    }];
    return request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version, relations }));
  };
  const start = task => {
    const active = tasks.filter(row => ['reserved', 'inflight', 'received', 'committed'].includes(row.phase));
    assert.ok(active.length < capacity, 'Trace exceeded its declared admission capacity');
    const job = store.nextRelationJob(task.listeningId, { now: clock, quietMs: 0, maxConcurrent: capacity });
    if (!job && mode === 'no_candidates') { task.phase = 'waiting_nodes'; task.outcome = 'no_candidates'; return; }
    assert.ok(job, 'Trace requested a job that storage cannot admit');
    assert.equal(job.window_id, task.windowId, 'Trace violates real window admission order');
    task.job = job;
    task.reply = 'none'; task.outcome = 'none';
    task.controller = new AbortController();
    task.gates = Object.fromEntries(['reserved', 'send', 'sent', 'response', 'commitReady', 'commit', 'committed', 'notify', 'finished'].map(name => [name, deferred()]));
    const workflow = createRelationWorkflow({ store, endpoint: 'mock://relation-protocol-no-network', now: () => clock,
      provider: { readyAt: provider.readyAt, canStartBackground: provider.canStartBackground, coolDown: provider.coolDown,
        run: async (options, request) => {
          task.phase = 'reserved'; task.gates.reserved.resolve();
          await task.gates.send.promise;
          return provider.run(options, request);
        } },
      extract: async (_key, input) => {
        task.calls++; task.input = input; task.phase = 'inflight'; task.gates.sent.resolve();
        return task.gates.response.promise;
      },
      onChange: (_id, result) => {
        if (result) { task.notifications++; if (task.notifyFailure) throw new Error('Synthetic notification failure'); }
      }, onError: error => task.errors.push({ name: error.name, code: error.code, message: error.message }) });
    const context = { event() {}, step: async (name, operation) => {
      if (name !== 'relation.commit') return operation();
      task.phase = 'received'; task.gates.commitReady.resolve();
      await task.gates.commit.promise;
      if (task.commitFailure) store.db.exec("CREATE TEMP TRIGGER protocol_commit_failure BEFORE UPDATE OF accepted_count ON relation_jobs BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
      let result;
      try { result = await operation(); }
      finally { if (task.commitFailure) store.db.exec('DROP TRIGGER protocol_commit_failure'); }
      if (mutation === 'corrupt_committed_state') store.db.prepare("UPDATE relation_jobs SET state='pending' WHERE id=?").run(task.job.id);
      task.commitResult = result;
      task.phase = 'committed'; task.outcome = result.accepted ? 'ok' : 'empty'; task.gates.committed.resolve();
      await task.gates.notify.promise;
      return result;
    } };
    task.completion = workflow.execute(job, 'synthetic-not-a-key', task.controller.signal, context).then(result => {
      task.result = result; task.phase = result.kind === 'continue' ? 'retry_wait' : 'done';
      task.outcome = result.outcome || 'none';
    }, error => {
      task.error = { name: error.name, message: error.message }; task.phase = 'reserve_failed'; task.outcome = 'reserve_failed';
    }).finally(() => task.gates.finished.resolve());
  };
  const observe = () => ({ clock, actors: tasks.map(task => ({ actor: task.actor,
    identity: { listeningId: task.listeningId, windowId: task.windowId, jobId: task.job?.id || null },
    job: task.job ? { ...store.db.prepare('SELECT state,request_count,ready_at,last_error FROM relation_jobs WHERE id=?').get(task.job.id) } : null,
    window: { ...store.db.prepare('SELECT state,ready_at FROM relation_windows WHERE id=?').get(task.windowId) },
    journal: store.db.prepare(`SELECT q.attempt,q.outcome FROM relation_requests q JOIN relation_jobs j ON j.id=q.job_id
      JOIN listenings l ON l.id=j.listening_id WHERE j.window_id=? AND j.epoch=l.relation_epoch ORDER BY j.created_at,q.attempt`).all(task.windowId),
    budget: store.db.prepare(`SELECT COALESCE(SUM(j.request_count),0) AS count FROM relation_jobs j JOIN listenings l ON l.id=j.listening_id
      WHERE j.window_id=? AND j.epoch=l.relation_epoch`).get(task.windowId).count,
    knowledgeCount: store.knowledge(task.listeningId).length,
    relations: store.graph(task.listeningId).relations.filter(row => row.subject_item_id === task.nodes[0] && row.object_item_id === task.nodes[1]),
    calls: task.calls, phase: task.phase, outcome: task.outcome, reply: task.reply, result: task.result || null,
    error: task.error || null, notifications: task.notifications, providerReadyAt: provider.readyAt('synthetic-not-a-key')
  })) });
  const project = () => {
    const rows = observe().actors;
    return Object.fromEntries(['phase', 'counts', 'calls', 'relations', 'outcome', 'replies', 'ready'].map(field => [field,
      Object.fromEntries(rows.map(row => [row.actor, field === 'counts' ? row.budget : field === 'relations' ? row.relations.length :
        field === 'replies' ? row.reply : field === 'ready' ? !(row.job?.ready_at > clock) : row[field]]))]));
  };
  const check = () => observe().actors.flatMap(row => {
    const failures = [], expect = (condition, label) => { if (!condition) failures.push(`actor ${row.actor}: ${label}`); };
    expect(row.budget === row.journal.length, 'durable budget differs from request ledger');
    expect(row.calls <= row.budget, 'provider invocation has no durable reservation');
    if (['reserved', 'inflight', 'received'].includes(row.phase)) {
      expect(row.job?.state === 'running' && row.window.state === 'pending', 'active checkpoint is not durably running/pending');
    } else if (row.phase === 'committed' || (row.phase === 'done' && ['ok', 'empty'].includes(row.outcome))) {
      expect(row.job?.state === 'complete' && row.window.state === 'complete' && row.job.last_error === null, 'successful checkpoint is not durably complete');
      expect(row.journal.at(-1)?.outcome === 'complete', 'successful request ledger is not settled');
    } else if (row.phase === 'done' && row.outcome === 'failed') {
      expect(row.job?.state === 'failed' && row.window.state === 'failed', 'failed checkpoint is not durably failed');
    } else if (row.phase === 'retry_wait' || row.phase === 'reserve_failed' || (row.phase === 'idle' && row.job)) {
      expect(row.job?.state === 'pending' && row.window.state === 'pending', 'waiting checkpoint lost its pending job');
    } else if (row.phase === 'waiting_nodes') {
      expect(row.job === null && row.window.state === 'waiting_nodes', 'candidate wait unexpectedly admitted a job');
    } else if (row.phase === 'idle') expect(row.job === null && row.window.state === 'dirty', 'initial window is not unadmitted');
    return failures;
  });
  async function act({ action, actor, response, milliseconds }) {
    assert.equal(closed, false);
    if (action === 'stutter') return project();
    if (action === 'advance_time') {
      const actual = observe();
      if (milliseconds != null) { assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0); clock += milliseconds; }
      else clock = Math.max(clock, ...actual.actors.map(row => Math.max(row.job?.ready_at || 0, row.providerReadyAt)));
      for (const row of actual.actors) if (row.phase === 'retry_wait' && Math.max(row.job?.ready_at || 0, row.providerReadyAt) <= clock) tasks[row.actor].phase = 'idle';
      return project();
    }
    const task = tasks[actor];
    assert.ok(task, `Unknown actor ${actor}`);
    const phase = { admit: ['idle', 'retry_wait'], send: ['reserved'], response: ['inflight'], commit: ['received'], commit_fail: ['received'], notify: ['committed'], notify_fail: ['committed'] }[action];
    assert.ok(phase?.includes(task.phase), `Cannot replay ${action} from ${task.phase}`);
    if (action === 'admit') {
      if (mode === 'reserve_fail') store.db.exec("CREATE TEMP TRIGGER protocol_reserve_failure BEFORE INSERT ON relation_requests BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END");
      try {
        start(task);
        if (task.gates) await deadline(() => Promise.race([task.gates.reserved.promise, task.gates.finished.promise]), 2000, 'reservation or its diagnosed failure');
      } finally { if (mode === 'reserve_fail') store.db.exec('DROP TRIGGER protocol_reserve_failure'); }
    }
    else if (action === 'send') { task.gates.send.resolve(); await waiting(task.gates.sent, 'provider invocation'); }
    else if (action === 'response') {
      task.reply = response;
      if (['ok', 'empty', 'filtered'].includes(response)) {
        task.gates.response.resolve(parsedResponse(task, response)); await waiting(task.gates.commitReady, 'provider response');
      } else {
        task.gates.response.reject(providerError(response)); await waiting(task.gates.finished, 'failed provider response');
      }
    } else if (action === 'commit') { task.gates.commit.resolve(); await waiting(task.gates.committed, 'business commit'); }
    else if (action === 'commit_fail') {
      task.commitFailure = true; task.gates.commit.resolve(); await waiting(task.gates.finished, 'failed business commit');
    }
    else if (['notify', 'notify_fail'].includes(action)) {
      task.notifyFailure = action === 'notify_fail'; task.gates.notify.resolve(); await waiting(task.gates.finished, 'workflow completion');
    } else throw new Error(`Unsupported relation protocol action: ${action}`);
    return project();
  }
  async function close() {
    if (closed) return; closed = true;
    try {
      for (const task of tasks) {
        task.controller?.abort();
        for (const [name, gate] of Object.entries(task.gates || {})) gate.resolve(name === 'response' ? { relations: [] } : undefined);
      }
      await deadline(() => Promise.all(tasks.map(task => task.completion)), 3000, 'relation replay cleanup');
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  }
  return { act, project, observe, check, close };
}
