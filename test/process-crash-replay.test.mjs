import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessProtocolAdapter } from '../test-support/process-crash-adapter.mjs';

test('SIGKILL after knowledge reservation preserves paid occupancy in a different process', async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 1 });
  t.after(() => adapter.close());
  await adapter.act({ action: 'admit', actor: 0 });
  const before = adapter.observe();
  assert.equal(before.ledger.length, 0);
  assert.equal(before.durable.checkpoint.parts[0].initial_requests, 1);
  await adapter.act({ action: 'crash' });
  assert.equal(adapter.observe().exits.at(-1).signal, 'SIGKILL');
  await adapter.act({ action: 'recover' });
  const recovered = adapter.observe();
  assert.notEqual(recovered.pid, before.pid);
  assert.equal(recovered.durable.checkpoint.parts[0].phase, 'extract_pending');
  assert.equal(recovered.durable.checkpoint.parts[0].initial_requests, 1);
  assert.equal(recovered.durable.checkpoint.progress.cycle, 1);
  await adapter.act({ action: 'advance_time' });
  await adapter.act({ action: 'admit', actor: 0 });
  assert.equal(adapter.observe().durable.checkpoint.progress.extra_requests, 1);
  await adapter.act({ action: 'send', actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response: 'ok' });
  await adapter.act({ action: 'commit', actor: 0 });
  await adapter.act({ action: 'notify', actor: 0 });
  assert.equal(adapter.observe().ledger.length, 1);
  assert.equal(adapter.observe().durable.checkpoint.job.outcome, 'ok');
  assert.deepEqual(adapter.check(), []);
});

test('SIGKILL after the real SQLite commit and before knowledge notification retains content without another call', async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 1 });
  t.after(() => adapter.close());
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response: 'ok' });
  await adapter.act({ action: 'commit', actor: 0 });
  const committed = adapter.observe();
  assert.equal(committed.durable.checkpoint.parts[0].results.length, 1);
  assert.equal(committed.durable.checkpoint.job.state, 'pending');
  assert.equal(committed.boundary.name, 'committed');
  assert.equal(committed.boundary.resultNotifications, 0);
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  await adapter.act({ action: 'advance_time' });
  await adapter.act({ action: 'settle', actor: -1 });
  assert.equal(adapter.observe().ledger.length, 1);
  assert.equal(adapter.observe().durable.checkpoint.job.outcome, 'ok');
  assert.deepEqual(adapter.observe().durable.knowledge, committed.durable.knowledge);
  assert.deepEqual(adapter.check(), []);
});

async function toBoundary(adapter, point, response = 'ok') {
  await adapter.act({ action: 'admit', actor: 0 });
  if (point === 'reserved') return;
  await adapter.act({ action: 'send', actor: 0 });
  if (point === 'inflight') return;
  await adapter.act({ action: 'response', actor: 0, response });
  if (point === 'received') return;
  await adapter.act({ action: 'commit', actor: 0 });
}
async function finishRequest(adapter, response = 'ok') {
  await toBoundary(adapter, 'committed', response);
  await adapter.act({ action: 'notify', actor: 0 });
}

for (const point of ['inflight', 'received']) test(`SIGKILL at knowledge ${point} loses only volatile response and uses the remaining budget`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 1 });
  t.after(() => adapter.close());
  await toBoundary(adapter, point);
  const before = adapter.observe();
  await adapter.act({ action: 'crash' });
  assert.deepEqual(adapter.observe().durable, before.durable);
  await adapter.act({ action: 'recover' });
  assert.equal(adapter.observe().durable.checkpoint.parts[0].initial_requests, 1);
  assert.equal(adapter.project().replies[0], 'none');
  assert.equal(adapter.observe().durable.knowledge.length, 1, 'uncommitted response must not appear as business data');
  await adapter.act({ action: 'advance_time' });
  await finishRequest(adapter);
  assert.equal(adapter.observe().ledger.length, 2);
  assert.equal(adapter.observe().durable.checkpoint.progress.extra_requests, 1);
  assert.equal(adapter.observe().durable.checkpoint.job.outcome, 'ok');
  assert.deepEqual(adapter.check(), []);
});

for (const point of ['reserved', 'inflight', 'received', 'committed']) test(`SIGKILL at repair ${point} never repeats its one reserved repair and retains accepted content`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 1 });
  t.after(() => adapter.close());
  await finishRequest(adapter, 'partial');
  const accepted = adapter.observe().durable.knowledge;
  assert.equal(accepted.length, 2);
  await adapter.act({ action: 'advance_time' });
  await toBoundary(adapter, point);
  const before = adapter.observe();
  assert.equal(before.durable.checkpoint.parts[0].repair_reserved, 1);
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  await adapter.act({ action: 'advance_time' });
  await adapter.act({ action: 'settle', actor: -1 });
  const after = adapter.observe();
  assert.equal(after.ledger.length, point === 'reserved' ? 1 : 2);
  assert.equal(after.durable.checkpoint.parts[0].repair_reserved, 1);
  assert.equal(after.durable.checkpoint.job.outcome, point === 'committed' ? 'ok' : 'partial');
  assert.deepEqual(after.durable.knowledge, point === 'committed' ? before.durable.knowledge : accepted);
  if (point !== 'committed') assert.equal(after.durable.checkpoint.parts[0].stats.repair_error, 'REPAIR_INTERRUPTED');
  assert.deepEqual(adapter.check(), []);
});

for (const failure of ['transient', 'protocol']) test(`SIGKILL at the last ${failure} reservation conserves the exhausted knowledge budget without another call`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 1 });
  t.after(() => adapter.close());
  const failures = failure === 'transient' ? 2 : 1;
  for (let attempt = 0; attempt < failures; attempt++) {
    await adapter.act({ action: 'admit', actor: 0 });
    await adapter.act({ action: 'send', actor: 0 });
    await adapter.act({ action: 'response', actor: 0, response: failure });
    await adapter.act({ action: 'advance_time' });
  }
  await adapter.act({ action: 'admit', actor: 0 });
  const before = adapter.observe();
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  await adapter.act({ action: 'advance_time' });
  await adapter.act({ action: 'settle_exhausted', actor: 0 });
  const after = adapter.observe();
  assert.equal(after.ledger.length, failures);
  assert.equal(after.durable.checkpoint.parts[0].initial_requests, failures + 1);
  assert.equal(after.durable.checkpoint.progress.extra_requests, before.durable.checkpoint.progress.extra_requests);
  assert.equal(after.durable.checkpoint.progress.protocol_retries, before.durable.checkpoint.progress.protocol_retries);
  assert.equal(after.durable.checkpoint.job.outcome, 'invalid');
  assert.equal(after.durable.checkpoint.parts[0].stats.failure_code, 'REQUEST_BUDGET_EXHAUSTED');
  assert.deepEqual(adapter.check(), []);
});

for (const point of ['reserved', 'inflight', 'received', 'committed']) test(`SIGKILL at relation ${point} preserves the durable request journal and graph`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'relation', actors: 1, capacity: 1 });
  t.after(() => adapter.close());
  await toBoundary(adapter, point);
  const before = adapter.observe();
  assert.equal(before.durable.actors[0].budget, 1);
  if (point === 'committed') assert.equal(before.boundary.resultNotifications, 0);
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  const recovered = adapter.observe();
  assert.notEqual(recovered.pid, before.pid);
  assert.equal(recovered.durable.actors[0].budget, 1);
  assert.equal(recovered.durable.actors[0].journal.length, 1);
  if (point !== 'committed') {
    assert.equal(recovered.durable.actors[0].jobs[0].state, 'pending');
    await finishRequest(adapter);
  } else {
    assert.equal(recovered.durable.actors[0].jobs[0].state, 'complete');
    assert.deepEqual(recovered.durable.actors[0].relations, before.durable.actors[0].relations);
  }
  assert.equal(adapter.observe().ledger.length, point === 'reserved' || point === 'committed' ? 1 : 2);
  assert.equal(adapter.observe().durable.actors[0].relations.length, 1);
  assert.deepEqual(adapter.check(), []);
});

for (const point of ['reserved', 'inflight', 'received']) test(`SIGKILL on the third relation ${point} exhausts its persisted budget without another request`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'relation', actors: 1, capacity: 1 });
  t.after(() => adapter.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    await adapter.act({ action: 'admit', actor: 0 });
    await adapter.act({ action: 'send', actor: 0 });
    await adapter.act({ action: 'response', actor: 0, response: 'transient' });
    await adapter.act({ action: 'advance_time' });
  }
  await toBoundary(adapter, point);
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  assert.equal(adapter.observe().durable.actors[0].budget, 3);
  assert.equal(adapter.observe().durable.actors[0].journal.length, 3);
  assert.equal(adapter.observe().durable.actors[0].jobs[0].state, 'failed');
  assert.equal(adapter.observe().durable.actors[0].window.state, 'failed');
  assert.equal(adapter.observe().ledger.length, point === 'reserved' ? 2 : 3);
  assert.equal(adapter.project().phase[0], 'done');
  assert.deepEqual(adapter.check(), []);
});

test('one process SIGKILL stops both active relation sessions and conserves both ledgers', async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'relation', actors: 3, capacity: 2 });
  t.after(() => adapter.close());
  await adapter.act({ action: 'admit', actor: 0 });
  await adapter.act({ action: 'send', actor: 0 });
  await adapter.act({ action: 'admit', actor: 1 });
  const before = adapter.observe();
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  const after = adapter.observe();
  assert.notEqual(after.pid, before.pid);
  assert.deepEqual(adapter.project().counts, { 0: 1, 1: 1, 2: 0 });
  assert.deepEqual(adapter.project().phase, { 0: 'idle', 1: 'idle', 2: 'idle' });
  assert.deepEqual(adapter.project().calls, { 0: 1, 1: 0, 2: 0 });
  assert.equal(after.exits.filter(exit => exit.signal === 'SIGKILL').length, 1);
  await finishRequest(adapter);
  assert.equal(adapter.project().relations[0], 1);
  assert.deepEqual(adapter.check(), []);
});

test('a later knowledge part crash preserves the first accepted part and the same processing cycle', async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 2 });
  t.after(() => adapter.close());
  await finishRequest(adapter);
  const accepted = adapter.observe().durable.knowledge;
  await adapter.act({ action: 'advance_time' });
  await adapter.act({ action: 'admit', actor: 1 });
  await adapter.act({ action: 'send', actor: 1 });
  await adapter.act({ action: 'crash' });
  await adapter.act({ action: 'recover' });
  assert.deepEqual(adapter.observe().durable.knowledge, accepted);
  assert.equal(adapter.project().phase[0], 'done');
  assert.equal(adapter.project().phase[1], 'extract_pending');
  assert.equal(adapter.project().cycle, 1);
  await adapter.act({ action: 'advance_time' });
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 1 });
  await adapter.act({ action: 'response', actor: 1, response: 'ok' });
  for (const action of ['commit', 'notify']) await adapter.act({ action, actor: 1 });
  assert.equal(adapter.project().outcome, 'ok');
  assert.deepEqual(adapter.project().initial_requests, { 0: 1, 1: 2 });
  assert.equal(adapter.observe().ledger.length, 3);
  assert.deepEqual(adapter.observe().durable.knowledge.filter(item => accepted.some(old => old.id === item.id)), accepted);
  assert.deepEqual(adapter.check(), []);
});

for (const protocol of ['knowledge', 'relation']) {
  const config = protocol === 'knowledge' ? { protocol, parts: 1 } : { protocol, actors: 1, capacity: 1 };
  test(`${protocol} reservation transaction failure is diagnosed before any external request`, async t => {
    const adapter = await createProcessProtocolAdapter({ ...config, ...(protocol === 'relation' ? { mode: 'reserve_fail' } : {}) });
    t.after(() => adapter.close());
    await adapter.act({ action: protocol === 'knowledge' ? 'reserve_fail' : 'admit', actor: 0 });
    assert.equal(adapter.observe().ledger.length, 0);
    assert.ok(adapter.observe().errors.some(error => /synthetic reservation failure/.test(error.message)));
    assert.deepEqual(adapter.check(), []);
  });
  test(`${protocol} commit transaction failure does not retry the completed paid response`, async t => {
    const adapter = await createProcessProtocolAdapter(config);
    t.after(() => adapter.close());
    await toBoundary(adapter, 'received');
    await adapter.act({ action: 'commit_fail', actor: 0 });
    assert.equal(adapter.observe().ledger.length, 1);
    assert.ok(adapter.observe().errors.length > 0);
    assert.deepEqual(adapter.check(), []);
  });
  test(`${protocol} notification failure follows durable commit and cannot repeat paid work`, async t => {
    const adapter = await createProcessProtocolAdapter(config);
    t.after(() => adapter.close());
    await toBoundary(adapter, 'committed');
    const committed = adapter.observe().durable;
    await adapter.act({ action: 'notify_fail', actor: 0 });
    assert.equal(adapter.observe().ledger.length, 1);
    assert.ok(protocol === 'knowledge' ? adapter.observe().notificationFailures > 0 : adapter.observe().tasks[0].notificationFailures > 0);
    if (protocol === 'knowledge') assert.deepEqual(adapter.observe().durable.knowledge, committed.knowledge);
    else assert.deepEqual(adapter.observe().durable.actors[0].relations, committed.actors[0].relations);
    assert.deepEqual(adapter.check(), []);
  });
}

for (const response of ['unexpected', 'auth']) test(`two-part knowledge ${response} keeps the actual provider failure classification`, async t => {
  const adapter = await createProcessProtocolAdapter({ protocol: 'knowledge', parts: 2 });
  t.after(() => adapter.close());
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response });
  assert.equal(adapter.project().phase[0], 'done');
  assert.equal(adapter.observe().ledger.length, 1);
  if (response === 'auth') {
    assert.equal(adapter.project().phase[1], 'done');
    assert.equal(adapter.project().outcome, 'invalid');
    assert.equal(adapter.project().stage, 'done');
  } else {
    assert.equal(adapter.project().phase[1], 'extract_pending');
    assert.equal(adapter.project().stage, 'idle');
    await adapter.act({ action: 'advance_time' });
    for (const action of ['admit', 'send']) await adapter.act({ action, actor: 1 });
    await adapter.act({ action: 'response', actor: 1, response: 'ok' });
    for (const action of ['commit', 'notify']) await adapter.act({ action, actor: 1 });
    assert.equal(adapter.project().outcome, 'partial');
    assert.equal(adapter.observe().ledger.length, 2);
  }
  assert.deepEqual(adapter.check(), []);
});
