import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { createKnowledgeScheduler } from '../knowledge-queue.mjs';
import { seedProcessFixture, readProcessDurable } from './process-crash-fixture.mjs';

const options = JSON.parse(process.argv[2]), { directory, endpoint, generation } = options;
const filename = path.join(directory, 'store.sqlite'), manifestFile = path.join(directory, 'manifest.json');
const store = new ListeningStore(filename);
if (generation > 0 && options.mutation === 'reset_on_recovery') {
  store.db.exec('UPDATE extraction_parts SET initial_requests=0,repair_reserved=0');
  const rows = store.db.prepare('SELECT id,progress_json FROM extraction_jobs WHERE progress_json IS NOT NULL').all();
  for (const row of rows) { const progress = JSON.parse(row.progress_json); progress.extra_requests = 0; progress.protocol_retries = 0;
    store.db.prepare('UPDATE extraction_jobs SET progress_json=? WHERE id=?').run(JSON.stringify(progress), row.id); }
}
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : seedProcessFixture(store, options);
if (!existsSync(manifestFile)) writeFileSync(manifestFile, JSON.stringify(manifest));
let clock = options.clock ?? manifest.clock, enabled = false, current, stage = 'idle', sequence = 0, timerId = 0, closed = false, lastDispatchAt = null;
const replies = Array(manifest.parts).fill('none'), errors = [], timers = new Map();
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const snapshot = () => ({ generation, pid: process.pid, clock, schedulerReadyAt: lastDispatchAt == null ? 0 : lastDispatchAt + 2000, stage, replies: [...replies],
  errors: [...errors], resultNotifications: current?.resultNotifications || 0, notificationFailures: current?.notificationFailures || 0, durable: readProcessDurable(filename, manifest) });
const send = message => { if (process.connected) process.send(message); };
const state = label => send({ type: 'state', label, ...snapshot() });
const report = error => {
  errors.push({ name: error.name, message: error.message, code: error.code || null, errcode: error.errcode ?? null, errstr: error.errstr ?? null });
  send({ type: 'diagnostic', generation, pid: process.pid, error: errors.at(-1) });
};

// This synchronous test wrapper exposes COMMIT-return -> first-notification.
// It inserts no production await and blocks the whole worker, as a process
// stopped at a synchronous instruction would. The parent uses files/SIGKILL;
// an IPC callback cannot run while this event loop is synchronously paused.
function committedGate() {
  const id = `${generation}-${++sequence}`, file = path.join(directory, `boundary-${id}.json`);
  const release = path.join(directory, `release-${id}`);
  const marker = { name: 'committed', id, release, ...snapshot() };
  writeFileSync(`${file}.tmp`, JSON.stringify(marker)); renameSync(`${file}.tmp`, file);
  const until = Date.now() + 5000, lock = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) {
    if (Date.now() >= until) throw Object.assign(new Error('Process checkpoint handshake timed out'), { code: 'CHECKPOINT_HANDSHAKE_TIMEOUT' });
    Atomics.wait(lock, 0, 0, 10);
  }
  current.notifyFailure = readFileSync(release, 'utf8').trim() === 'notify_fail';
}
const save = store.saveKnowledgeCheckpoint.bind(store);
store.saveKnowledgeCheckpoint = (id, patch, accepted) => {
  const result = save(id, patch, accepted);
  if (current?.awaitingResultCommit && patch.part && ['done', 'repair_pending'].includes(patch.part.phase)) {
    current.awaitingResultCommit = false; stage = 'committed'; committedGate();
  }
  return result;
};
const notifyResult = () => { if (stage === 'committed') { current.resultNotifications++;
  if (current.notifyFailure) { current.notificationFailures++; throw new Error('Synthetic notification failure'); } } };
const workflow = createKnowledgeWorkflow({ store, endpoint, now: () => clock,
  onItems: notifyResult, onProgress: notifyResult, onRejected: notifyResult, onDiagnostic: notifyResult, onError: report });
const scheduler = createKnowledgeScheduler({ store, listeningIds: () => [manifest.run.listeningId],
  keyFor: () => enabled ? 'synthetic-process-fixture-key' : null, translationBusy: () => false, now: () => clock,
  setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimer: id => timers.delete(id),
  onError: report, onIdle: () => {
    store.db.exec('DROP TRIGGER IF EXISTS process_reserve_failure; DROP TRIGGER IF EXISTS process_commit_failure');
    const job = store.knowledgeCheckpoint(manifest.jobId).job;
    stage = ['complete', 'failed'].includes(job.state) ? 'done' : 'idle'; state('settled');
  }, execute: async (job, key, context) => {
    enabled = false; lastDispatchAt = clock;
    const part = store.knowledgeCheckpoint(job.id).parts.find(part => part.phase !== 'done');
    assert.equal(part?.part_no ?? -1, current.actor, 'Scheduler dispatched another part');
    const wrap = original => ({ ...original, step: async (name, operation) => {
      if (!['knowledge.extract', 'knowledge.repair'].includes(name)) return original.step(name, child => operation(wrap(child)));
      stage = 'reserved'; replies[current.actor] = 'none'; state('reserved');
      await current.send.promise;
      context.signal?.throwIfAborted(); stage = 'inflight'; state('inflight');
      const parsed = await original.step(name, child => operation(wrap(child)));
      context.signal?.throwIfAborted();
      stage = 'received'; current.awaitingResultCommit = true; state('received');
      await current.commit.promise;
      context.signal?.throwIfAborted(); return parsed;
    } });
    return workflow.execute(job, key, wrap(context));
  }
});

process.on('message', async message => {
  try {
    if (['admit', 'settle', 'reserve_fail'].includes(message.command)) {
      assert.equal(stage, 'idle');
      current = { actor: message.actor, send: deferred(), commit: deferred(), resultNotifications: 0, notificationFailures: 0 };
      if (message.command === 'reserve_fail') store.db.exec("CREATE TEMP TRIGGER process_reserve_failure BEFORE UPDATE ON extraction_parts WHEN NEW.phase IN ('extract_inflight','repair_inflight') BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END");
      enabled = true; scheduler.pump(); enabled = false;
    } else if (message.command === 'send') current.send.resolve();
    else if (message.command === 'response') { replies[message.actor] = message.response; state('response-selected'); }
    else if (['commit', 'commit_fail'].includes(message.command)) {
      if (message.command === 'commit_fail') store.db.exec("CREATE TEMP TRIGGER process_commit_failure BEFORE UPDATE ON extraction_parts WHEN NEW.phase IN ('done','repair_pending') BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
      current.commit.resolve();
    }
    else if (message.command === 'advance_time') {
      const next = store.nextJob(manifest.run.listeningId);
      clock = Math.max(clock, lastDispatchAt == null ? 0 : lastDispatchAt + 2000, next?.ready_at || 0, next?.retry_at ? Date.parse(next.retry_at) : 0); state('clock');
    } else if (message.command === 'close') {
      closed = true; current?.send.resolve(); current?.commit.resolve(); await scheduler.close(); store.close(); process.disconnect();
    } else if (message.command === 'abnormal_exit') { process.exit(73);
    } else if (message.command === 'pump') { scheduler.pump(); const job = store.knowledgeCheckpoint(manifest.jobId).job; stage = ['complete', 'failed'].includes(job.state) ? 'done' : 'idle'; state('pumped');
    } else throw new Error(`Unknown process replay command: ${message.command}`);
  } catch (error) { report(error); send({ type: 'command-error', command: message.command, generation, error: errors.at(-1) }); }
});
process.on('disconnect', () => { if (!closed) process.exit(1); });
state('ready');
