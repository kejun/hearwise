import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { createRelationScheduler } from '../relation-queue.mjs';
import { seedProcessFixture, readProcessDurable } from './process-crash-fixture.mjs';

const options = JSON.parse(process.argv[2]), { directory, endpoint, generation } = options;
const filename = path.join(directory, 'store.sqlite'), manifestFile = path.join(directory, 'manifest.json');
const store = new ListeningStore(filename);
if (generation > 0 && options.mutation === 'reset_on_recovery') {
  store.db.exec('UPDATE relation_jobs SET request_count=0; DELETE FROM relation_requests');
}
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : seedProcessFixture(store, options);
if (!existsSync(manifestFile)) writeFileSync(manifestFile, JSON.stringify(manifest));
let clock = options.clock ?? manifest.clock, enabledActor = -1, sequence = 0, timerId = 0;
const errors = [], timers = new Map(), tasks = manifest.tasks.map(task => ({ ...task, phase: 'idle', outcome: 'none', reply: 'none', notifications: 0, notificationFailures: 0 }));
for (const task of tasks) {
  const saved = readProcessDurable(filename, manifest).actors[task.actor], job = saved.jobs.at(-1);
  if (job) {
    task.jobId = job.id;
    if (['complete', 'partial', 'failed'].includes(job.state)) {
      task.phase = 'done'; task.outcome = job.state === 'failed' ? 'failed' : job.state === 'partial' ? 'partial' : saved.relations.length ? 'ok' : 'empty';
    } else if (job.ready_at > clock) task.phase = 'retry_wait';
  }
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const snapshot = () => ({ generation, pid: process.pid, clock, tasks: tasks.map(task => ({ actor: task.actor, phase: task.phase,
  outcome: task.outcome, reply: task.reply, jobId: task.jobId || null, notifications: task.notifications, notificationFailures: task.notificationFailures })), errors: [...errors], durable: readProcessDurable(filename, manifest) });
const send = message => { if (process.connected) process.send(message); };
const state = (label, actor = -1) => send({ type: 'state', label, actor, ...snapshot() });
const report = error => {
  errors.push({ name: error.name, message: error.message, code: error.code || null, errcode: error.errcode ?? null, errstr: error.errstr ?? null });
  send({ type: 'diagnostic', generation, pid: process.pid, error: errors.at(-1) });
};
function committedGate(task) {
  const id = `${generation}-${++sequence}`, file = path.join(directory, `boundary-${id}.json`), release = path.join(directory, `release-${id}`);
  const marker = { name: 'committed', id, release, actor: task.actor, resultNotifications: task.notifications, ...snapshot() };
  writeFileSync(`${file}.tmp`, JSON.stringify(marker)); renameSync(`${file}.tmp`, file);
  const until = Date.now() + 5000, lock = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) {
    if (Date.now() >= until) throw Object.assign(new Error('Process checkpoint handshake timed out'), { code: 'CHECKPOINT_HANDSHAKE_TIMEOUT' });
    Atomics.wait(lock, 0, 0, 10);
  }
  task.notifyFailure = readFileSync(release, 'utf8').trim() === 'notify_fail';
}
const commit = store.commitRelationJob.bind(store);
store.commitRelationJob = (id, patch) => {
  const result = commit(id, patch), task = tasks.find(row => row.jobId === id);
  if (result?.stale) return result;
  task.phase = 'committed'; task.outcome = result.state === 'partial' ? 'partial' : result.accepted ? 'ok' : 'empty';
  committedGate(task); return result;
};
const scheduler = createRelationScheduler({ store, listeningIds: () => manifest.sessions.map(run => run.listeningId),
  keyFor: id => enabledActor >= 0 && tasks[enabledActor].listeningId === id ? 'synthetic-process-fixture-key' : null,
  quietMs: 0, minStartIntervalMs: 0, maxConcurrent: manifest.capacity, now: () => clock,
  setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimer: id => timers.delete(id),
  onError: report, onIdle: () => {
    store.db.exec('DROP TRIGGER IF EXISTS process_reserve_failure; DROP TRIGGER IF EXISTS process_commit_failure');
    for (const row of readProcessDurable(filename, manifest).actors) if (!row.jobs.length && row.window.state === 'waiting_nodes') {
      tasks[row.actor].phase = 'waiting_nodes'; tasks[row.actor].outcome = 'no_candidates';
    }
    state('settled');
  }, execute: async (job, key, signal) => {
    const task = tasks.find(row => row.windowId === job.window_id);
    assert.equal(task.actor, enabledActor, 'Scheduler dispatched another window'); enabledActor = -1;
    task.jobId = job.id; task.reply = 'none'; task.outcome = 'none'; task.notifications = 0; task.notificationFailures = 0;
    const workflow = createRelationWorkflow({ store, endpoint, now: () => clock,
      provider: { run: async (_options, request) => { task.phase = 'reserved'; state('reserved', task.actor); await task.send.promise;
        signal.throwIfAborted(); task.phase = 'inflight'; state('inflight', task.actor); return request(); } },
      onChange: (_id, result) => { if (result) { task.notifications++; if (task.notifyFailure) { task.notificationFailures++; throw new Error('Synthetic notification failure'); } } }, onError: report });
    try {
      const result = await workflow.execute(job, key, signal, { event() {}, step: async (name, operation) => {
        if (name !== 'relation.commit') return operation();
        task.phase = 'received'; state('received', task.actor); await task.commit.promise; signal.throwIfAborted();
        return operation();
      } });
      task.phase = result.kind === 'continue' ? 'retry_wait' : 'done'; task.outcome = result.outcome || 'none';
      return result;
    } catch (error) { task.phase = 'reserve_failed'; task.outcome = 'reserve_failed'; throw error; }
  }
});
process.on('message', async message => {
  try {
    const task = tasks[message.actor];
    if (message.command === 'admit') {
      assert.equal(task.phase, 'idle');
      task.send = deferred(); task.commit = deferred(); enabledActor = task.actor;
      if (manifest.mode === 'reserve_fail') store.db.exec("CREATE TEMP TRIGGER process_reserve_failure BEFORE INSERT ON relation_requests BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END");
      scheduler.pump(); enabledActor = -1;
      if (!task.jobId && readProcessDurable(filename, manifest).actors[task.actor].window.state === 'waiting_nodes') {
        task.phase = 'waiting_nodes'; task.outcome = 'no_candidates'; state('settled', task.actor);
      }
    } else if (message.command === 'send') task.send.resolve();
    else if (message.command === 'response') { task.reply = message.response; state('response-selected', task.actor); }
    else if (['commit', 'commit_fail'].includes(message.command)) {
      if (message.command === 'commit_fail') store.db.exec("CREATE TEMP TRIGGER process_commit_failure BEFORE UPDATE OF accepted_count ON relation_jobs BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
      task.commit.resolve();
    }
    else if (message.command === 'advance_time') {
      clock = Math.max(clock, ...readProcessDurable(filename, manifest).actors.flatMap(row => row.jobs.map(job => job.ready_at || 0)));
      for (const task of tasks) if (task.phase === 'retry_wait') task.phase = 'idle'; state('clock');
    } else if (message.command === 'abnormal_exit') { process.exit(73);
    } else if (message.command === 'pump') { scheduler.pump(); state('pumped');
    } else throw new Error(`Unknown process replay command: ${message.command}`);
  } catch (error) { report(error); send({ type: 'command-error', command: message.command, generation, error: errors.at(-1) }); }
});
process.on('disconnect', () => process.exit(1));
state('ready');
