import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { traceBusinessFixture, deferred } from '../test-support/trace-business-fixture.mjs';
import { waitForTraceTasks } from '../test-support/trace-completion.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 30));
test('full Trace waits for the actual relation root after its real SQLite COMMIT', { timeout: 8000 }, async () => {
  const f = await traceBusinessFixture({ domain: 'relation' }), committed = deferred(), release = deferred();
  let task, waiting, failure;
  try {
    task = f.start({ context: context => ({ ...context, async step(name, operation, attributes) {
      const result = await context.step(name, operation, attributes);
      if (name === 'relation.commit') { committed.resolve(); await release.promise; }
      return result;
    } }) });
    await deadline(() => committed.promise, 3000, 'Actual relation COMMIT');
    // A separate SQLite connection sees the real committed row while execute is held.
    const db = new DatabaseSync(f.filename, { readOnly: true });
    let durable;
    try { durable = db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(f.job.id); }
    finally { db.close(); }
    assert.equal(durable.state, 'complete'); assert.equal(durable.request_count, 1);
    const before = f.capture('real COMMIT, execute return held');
    assert.ok(before.snapshot.events.some(event => event.step_key === 'relation.commit' && event.state === 'succeeded'));
    assert.equal(before.business.tasks[0].state, 'unknown'); assert.equal(before.business.tasks[0].calls, 1);
    let settled = false;
    waiting = waitForTraceTasks(() => f.runtime.diagnostics().events, () => [durable], 'relation.execute');
    waiting.then(() => { settled = true; }, () => {});
    await tick();
    assert.equal(settled, false, 'A committed child is not the terminal relation.execute root');
    release.resolve(); await deadline(() => task.promise, 3000, 'Actual relation return');
    await deadline(() => waiting, 3000, 'Exact root barrier');
    const after = f.capture('root returned');
    assert.equal(after.business.tasks[0].state, 'succeeded'); assert.equal(after.business.tasks[0].calls, 1);
    assert.equal(after.calls.length, 1); assert.equal(after.query.job.state, 'complete');
  } catch (error) {
    // Keep the original stack and live business state before cleanup can cancel the root.
    failure = { stack: error.stack, stage: 'post-COMMIT root barrier', ...f.capture('failure before cleanup') };
    error.traceFailure = failure; console.error(JSON.stringify({ traceFailure: failure })); throw error;
  } finally {
    release.resolve();
    try { if (task) await deadline(() => task.promise, 3000, 'Held relation cleanup'); }
    finally { await f.close(); }
  }
});

test('Trace completion requires every current job and exact listening, root, process, trace and attempt', { timeout: 3000 }, async () => {
  const jobs = [{ id: 'a', listening_id: 'ours' }, { id: 'b', listening_id: 'ours' }];
  const event = (job, state, patch = {}) => ({ process_id: 'process', trace_id: 'trace', span_id: job,
    step_key: 'relation.execute', state, attributes: { job_id: job, listening_id: 'ours' }, ...patch });
  const events = [event('a', 'running'), event('a', 'succeeded'),
    event('b', 'running'), event('b', 'succeeded', { parent_span_id: 'child' }),
    event('b', 'succeeded', { attributes: { job_id: 'b', listening_id: 'foreign' } }),
    event('b', 'succeeded', { process_id: 'other-process' }), event('b', 'succeeded', { trace_id: 'other-trace' }),
    event('b', 'succeeded', { span_id: 'other-attempt' }), event('other-job', 'succeeded')];
  let settled = false;
  const waiting = waitForTraceTasks(() => events, () => jobs, 'relation.execute', 1000);
  waiting.then(() => { settled = true; }, () => {});
  try {
    await tick(); assert.equal(settled, false, 'Unrelated terminals cannot finish the actual second job');
    jobs.push({ id: 'c', listening_id: 'ours' });
    events.push(event('b', 'succeeded'), event('c', 'succeeded'));
    await tick(); assert.equal(settled, false, 'A newly observed job also needs its own started root');
    events.push(event('c', 'running'), event('c', 'running', { span_id: 'c-retry' }));
    await tick(); assert.equal(settled, false, 'Every started attempt must return');
    events.push(event('c', 'failed', { span_id: 'c-retry' }));
    await waiting; assert.equal(settled, true, 'Terminal failure is evidence for the unchanged business assertions, not a hang');
  } finally { events.push(event('b', 'succeeded'), event('c', 'running'), event('c', 'succeeded'), event('c', 'failed', { span_id: 'c-retry' })); await waiting; }
});
