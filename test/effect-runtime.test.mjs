import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRuntime, TaskCancelled } from '../dist/server/index.js';

const meta = { listening_id: 'listening-1', job_id: 'job-1', attempt: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Effect task starts immediately, retains error identity and releases its registration', async () => {
  const runtime = createTaskRuntime({ enabled: true }); let called = false;
  const failure = Object.assign(new Error('secret-provider-error-body'), { status: 429, retryAfterMs: 1234 });
  const handle = runtime.start('a', meta, () => { called = true; return Promise.reject(failure); });
  assert.equal(called, true);
  await assert.rejects(handle.promise, error => error === failure);
  assert.equal(runtime.activeCount, 0);
  assert.equal(runtime.diagnostics().events.at(-1).error_code, 'HTTP_429');
  assert.doesNotMatch(JSON.stringify(runtime.diagnostics()), /secret-provider-error-body/);
  await runtime.dispose();
});

test('cancel stops an ignored-abort task, allows identity reuse, and observes its late rejection', async () => {
  const runtime = createTaskRuntime({ enabled: true }); let rejectOld, oldSignal;
  const old = runtime.start('a', meta, context => {
    oldSignal = context.signal;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  });
  old.cancel('listening_deleted');
  await assert.rejects(old.promise, error => error instanceof TaskCancelled && error.reason === 'listening_deleted');
  assert.equal(oldSignal.aborted, true);
  let finish;
  const next = runtime.start('a', meta, () => new Promise(resolve => { finish = resolve; }));
  rejectOld(new Error('late provider rejection')); await tick();
  assert.equal(runtime.activeCount, 1);
  finish(42); assert.equal(await next.promise, 42);
  assert.equal(runtime.activeCount, 0);
  assert.ok(runtime.diagnostics().events.some(e => e.state === 'cancelled'));
  await runtime.dispose();
});

test('nested legacy adapters keep span parents and safe business attributes without sensitive errors', async () => {
  const runtime = createTaskRuntime({ enabled: true });
  await runtime.start('a', meta, context => context.step('knowledge.extract', child =>
    child.step('knowledge.http', async http => {
      http.event('response_received', { http_status: 200, Authorization: 'secret-key', text: 'private transcript' });
      return 'private model result';
    }))).promise;
  const snapshot = runtime.diagnostics();
  const starts = snapshot.events.filter(e => e.state === 'running');
  assert.deepEqual(starts.map(e => e.step_key), ['knowledge.execute', 'knowledge.extract', 'knowledge.http']);
  assert.equal(new Set(starts.map(e => e.trace_id)).size, 1);
  assert.equal(starts[1].parent_span_id, starts[0].span_id);
  assert.equal(starts[2].parent_span_id, starts[1].span_id);
  assert.equal(starts[2].attributes.job_id, meta.job_id);
  assert.equal(snapshot.complete, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-key|private transcript|private model result/);
  await runtime.dispose();
});

test('scope closes forgotten child work when a task returns', async () => {
  const runtime = createTaskRuntime({ enabled: true }); let childResult, signal;
  await runtime.start('a', meta, async context => {
    childResult = context.step('knowledge.http', child => {
      signal = child.signal;
      return new Promise(() => {});
    });
    void childResult.catch(() => {});
    return 1;
  }).promise;
  await assert.rejects(childResult, TaskCancelled);
  assert.equal(signal.aborted, true);
  await tick();
  assert.equal(runtime.diagnostics().active_spans, 0);
  await runtime.dispose();
});

test('runtime dispose is idempotent and cancels all tasks without waiting on providers', async () => {
  const runtime = createTaskRuntime(); const signals = [];
  const handles = ['a', 'b'].map(id => runtime.start(id, meta, context => {
    signals.push(context.signal); return new Promise(() => {});
  }));
  const closing = runtime.dispose();
  assert.equal(runtime.dispose(), closing);
  await closing;
  for (const handle of handles) await assert.rejects(handle.promise, error => error.reason === 'application_shutdown');
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(runtime.activeCount, 0);
  assert.throws(() => runtime.start('c', meta, async () => 1), /closed/);
});

test('diagnostic buffer is bounded, marks missing history, and cannot fail business work', async () => {
  const runtime = createTaskRuntime({ enabled: true, capacity: 2, onEvent: () => { throw new Error('sink failed'); } });
  for (const id of ['a', 'b', 'c']) assert.equal(await runtime.start(id, meta, async () => 7).promise, 7);
  const snapshot = runtime.diagnostics();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.dropped_events, 4);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.sink_errors, 6);
  assert.ok(snapshot.events[0].sequence < snapshot.events[1].sequence);
  snapshot.events[0].attributes.job_id = 'modified';
  assert.notEqual(runtime.diagnostics().events[0].attributes.job_id, 'modified');
  await runtime.dispose();
});

test('disabled tracing retains no events and active capture is not reported as complete', async () => {
  const off = createTaskRuntime({ enabled: false });
  await off.start('a', meta, async () => 1).promise;
  assert.equal(off.diagnostics().events.length, 0);
  assert.equal(off.diagnostics().enabled, false);
  await off.dispose();
  const on = createTaskRuntime({ enabled: true });
  const active = on.start('a', meta, () => new Promise(() => {}));
  assert.equal(on.diagnostics().complete, false);
  active.cancel('application_shutdown'); await assert.rejects(active.promise, TaskCancelled);
  await on.dispose();
});
