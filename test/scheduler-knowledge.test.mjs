import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeSchedulerAdapter } from '../test-support/scheduler-knowledge-adapter.mjs';

async function harness(t, config = {}) {
  const adapter = await createKnowledgeSchedulerAdapter(config); t.after(() => adapter.close()); return adapter;
}

test('real translation busy state restricts only new knowledge admissions, preserving two existing executions', async t => {
  const h = await harness(t);
  await h.act({ action: 'pump' }); assert.deepEqual(h.project().running, [0, 2]);
  await h.act({ action: 'set_translation', actor: 1, argument: '0,0' });
  assert.deepEqual(h.project().running, [0, 2]);
  await h.act({ action: 'advance_time' });
  await h.act({ action: 'settle', actor: 0, argument: 'success' });
  assert.deepEqual(h.project().running, [2]); assert.equal(h.project().phase[1], 'pending');
  await h.act({ action: 'settle', actor: 2, argument: 'success' });
  assert.deepEqual(h.project().running, [1]);
  assert.equal(h.observe().translation.service.queueLength, 1);
});

test('actual grace deadline, session interval and round robin are separate from a legal wait', async t => {
  const h = await harness(t);
  await h.act({ action: 'set_translation', actor: 0, argument: '0,1' });
  await h.act({ action: 'pump' }); assert.deepEqual(h.project().running, []);
  await h.act({ action: 'advance_time' }); await h.act({ action: 'pump' });
  assert.deepEqual(h.project().running, [0]);
  await h.act({ action: 'settle', actor: 0, argument: 'success' });
  assert.deepEqual(h.project().running, [2]);
  await h.act({ action: 'settle', actor: 2, argument: 'success' });
  assert.deepEqual(h.project().running, []);
  await h.act({ action: 'advance_time' }); await h.act({ action: 'pump' });
  assert.deepEqual(h.project().running, [1]);
});

test('shared provider cooldown blocks new dispatch without replaying completed work', async t => {
  const h = await harness(t, { jobs: [0, 2] });
  await h.act({ action: 'block_provider', actor: 0 }); await h.act({ action: 'pump' });
  assert.deepEqual(h.project().running, []);
  await h.act({ action: 'advance_time' }); await h.act({ action: 'pump' });
  assert.deepEqual(h.project().running, [0, 2]);
  await h.act({ action: 'settle', actor: 0, argument: 'rate_limit' });
  assert.equal(h.project().durable[0], 'failed');
  assert.equal(h.observe().deadlines.provider[0], h.observe().clock + 2000);
  assert.equal(h.observe().calls.length, 2);
});

test('remove and close await real runtime cancellation; closing does not forge durable completion', async t => {
  const h = await harness(t); await h.act({ action: 'pump' });
  await h.act({ action: 'remove', actor: 0 });
  assert.equal(h.project().durable[0], 'deleted'); assert.equal(h.project().durable[1], 'deleted');
  assert.deepEqual(h.project().running, [2]);
  await h.act({ action: 'close' });
  assert.deepEqual(h.project().running, []); assert.equal(h.project().phase[2], 'cancelled');
  assert.equal(h.project().durable[2], 'running');
  assert.equal(h.observe().calls.every(call => call.cancelled), true);
});

test('synchronous runtime.start failure releases scheduler admission and leaves later sessions runnable', async t => {
  const h = await harness(t, { startErrorActor: 0 }); await h.act({ action: 'pump' });
  assert.equal(h.project().durable[0], 'failed'); assert.deepEqual(h.project().running, [2]);
  await h.act({ action: 'advance_time' }); await h.act({ action: 'pump' });
  assert.deepEqual(h.project().running, [1, 2]);
  assert.equal(h.observe().calls.some(call => call.actor === 0), false);
  assert.match(h.observe().errors[0].message, /runtime.start/);
});

test('observer exceptions do not prevent real knowledge cleanup and future admission', async t => {
  const h = await harness(t, { observerFault: true }); await h.act({ action: 'pump' });
  await h.act({ action: 'advance_time' }); await h.act({ action: 'settle', actor: 0, argument: 'success' });
  assert.deepEqual(h.project().running, [1, 2]); assert.equal(h.project().durable[0], 'complete');
  assert.deepEqual(h.check(), []); assert.ok(h.observe().errors.length > 0);
});

for (const stage of ['store', 'translation']) {
  test(`failed initialization after ${stage} closes its real resources`, async () => {
    const audit = [];
    await assert.rejects(createKnowledgeSchedulerAdapter({ initializationFailure: stage, resourceAudit: audit }), /Controlled initialization failure/);
    const { existsSync } = await import('node:fs');
    for (const resource of audit) {
      if (resource.type === 'directory') assert.equal(existsSync(resource.path), false);
      if (resource.type === 'child') assert.throws(() => process.kill(resource.pid, 0), { code: 'ESRCH' });
    }
  });
}

test('runtime cleanup error still closes the translation child and removes the database', async () => {
  const audit = [], h = await createKnowledgeSchedulerAdapter({ cleanupFailure: true, resourceAudit: audit });
  await h.act({ action: 'pump' });
  await assert.rejects(h.close(), /Knowledge fixture cleanup failed/);
  const { existsSync } = await import('node:fs');
  for (const resource of audit) {
    if (resource.type === 'directory') assert.equal(existsSync(resource.path), false);
    if (resource.type === 'child') assert.throws(() => process.kill(resource.pid, 0), { code: 'ESRCH' });
  }
});

test('model-only backlog recycling cannot masquerade as a real persistent job restart', async t => {
  const h = await harness(t); await h.act({ action: 'pump' }); await h.act({ action: 'settle', actor: 0, argument: 'success' });
  await assert.rejects(h.act({ action: 'recycle', actor: 0 }), /Unreplayable abstract knowledge backlog recycle/);
  assert.equal(h.project().durable[0], 'complete');
});
