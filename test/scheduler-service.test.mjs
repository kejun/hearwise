import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationServiceAdapter } from '../test-support/scheduler-service-adapter.mjs';

async function harness(t, options = {}) {
  const adapter = await createTranslationServiceAdapter(options);
  t.after(() => adapter.close());
  return adapter;
}

test('real server shares final and interim admission and pumps waiting work on release', async t => {
  const h = await harness(t);
  await h.act({ action: 'admit_interim' });
  await h.act({ action: 'enqueue', actor: 0 });
  await h.act({ action: 'enqueue', actor: 1 });
  let state = await h.act({ action: 'pump' });
  assert.equal(state.service.final, 1); assert.equal(state.service.interim, 1);
  assert.deepEqual(state.queue, [0]);
  state = await h.act({ action: 'reject_interim' });
  assert.equal(state.lastResult.code, 'TRANSLATION_BUSY');
  state = await h.act({ action: 'settle_interim', argument: 'success' });
  assert.equal(state.service.final, 2); assert.equal(state.service.interim, 0);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.ledger.map(x => x.actor), [-1, 1, 0]);
  assert.equal(state.binding.originalSha256.length, 64);
  assert.equal(state.binding.appendOnly, true);
});

for (const outcome of ['success', 'error', 'timeout', 'cancelled']) {
  test(`real final ${outcome} releases only its slot and immediately starts queued work`, async t => {
    const h = await harness(t);
    for (const actor of [0, 1, 2]) await h.act({ action: 'enqueue', actor });
    let state = await h.act({ action: 'pump' });
    assert.equal(state.service.final, 2);
    const finished = state.running[0];
    state = await h.act({ action: 'settle_final', actor: finished, argument: outcome });
    assert.equal(state.service.final, 2);
    assert.equal(state.phase[finished], 'settled');
    assert.equal(state.ledger.length, 3);
    assert.equal(state.completions.at(-1).outcome, outcome);
  });
}

test('queued dedup does not invent an in-flight segment identity lock', async t => {
  const h = await harness(t, { identities: [0, 0, 2] });
  await h.act({ action: 'enqueue', actor: 0 });
  let state = await h.act({ action: 'duplicate', actor: 1 });
  assert.equal(state.lastResult.accepted, false); assert.equal(state.queue.length, 1);
  await h.act({ action: 'pump' });
  state = await h.act({ action: 'enqueue', actor: 1 });
  assert.equal(state.lastResult.accepted, true);
  assert.deepEqual(state.queue, [1]); assert.deepEqual(state.queueIds, ['segment-0']);
  state = await h.act({ action: 'pump' });
  assert.deepEqual(state.running, [0, 1]); assert.equal(state.service.final, 2);
});

for (const outcome of ['success', 'error', 'timeout', 'cancelled']) {
  test(`real optional phrase ${outcome} releases its slot and pumps waiting finals`, async t => {
    const h = await harness(t); await h.act({ action: 'admit_interim' });
    await h.act({ action: 'enqueue', actor: 1 }); await h.act({ action: 'enqueue', actor: 2 }); await h.act({ action: 'pump' });
    const state = await h.act({ action: 'settle_interim', argument: outcome });
    assert.equal(state.service.interim, 0); assert.equal(state.service.final, 2);
    assert.equal(state.completions.at(-1).outcome, outcome);
  });
}

test('actual HTTP preview shares the phrase/final budget and its disconnect releases only its own slot', async t => {
  const h = await harness(t, { interimMode: 'http' });
  await h.act({ action: 'admit_interim' });
  const rejected = await h.act({ action: 'reject_interim' });
  assert.equal(rejected.lastResult.httpStatus, 429); assert.equal(rejected.lastResult.code, 'FINAL_TRANSLATION_BUSY');
  for (const actor of [1, 2]) await h.act({ action: 'enqueue', actor });
  let state = await h.act({ action: 'pump' }); assert.equal(state.service.final, 1);
  state = await h.act({ action: 'settle_interim', argument: 'cancelled' });
  assert.equal(state.service.final, 2); assert.equal(state.service.interim, 0);
  assert.equal(state.ledger.find(row => row.actor === -1).aborted, true);
  assert.equal(state.ledger.filter(row => row.actor !== -1).every(row => !row.aborted), true);
});

test('intentional shared-admission guard mutation exposes a third real provider request', async t => {
  const h = await harness(t, { mutation: 'interim_queue_only' });
  for (const actor of [1, 2]) await h.act({ action: 'enqueue', actor });
  await h.act({ action: 'pump' });
  const state = await h.act({ action: 'reject_interim' });
  assert.equal(state.binding.mutation, 'interim_queue_only'); assert.equal(state.binding.appendOnly, false);
  assert.equal(state.service.final + state.service.interim, 3); assert.equal(state.ledger.length, 3);
});

for (const outcome of ['success', 'error', 'cancelled']) {
  test(`ordinary persisted background ${outcome} follows the real setTranslation branch and releases its slot`, async t => {
    const h = await harness(t, { persistedTasks: true, background: [0, 1, 2, 3] });
    for (const actor of [0, 1, 2]) await h.act({ action: 'enqueue', actor });
    await h.act({ action: 'pump' });
    const state = await h.act({ action: 'settle_final', actor: 0, argument: outcome });
    assert.equal(state.service.final, 2); assert.deepEqual(state.running, [1, 2]);
    assert.equal(state.storedSegments[0].original_text, JSON.stringify({ actor: 0 }));
    assert.equal(state.storedSegments[0].translation_state, outcome === 'success' ? 'complete' : outcome === 'error' ? 'failed' : 'pending');
    assert.equal(state.storedSegments[0].translation_text, outcome === 'success' ? '译文' : null);
    assert.equal(state.completions.at(-1).outcome, outcome);
    assert.equal(state.diagnostics.events.some(event => event.step_key === 'translation.execute' && ['succeeded', 'cancelled'].includes(event.state)), true);
  });
}

test('partial real worker initialization is force-cleaned even when its graceful close fails', async () => {
  const audit = [];
  await assert.rejects(createTranslationServiceAdapter({ initializationFailure: 'provider', resourceAudit: audit }), /Controlled translation initialization failure/);
  const { existsSync } = await import('node:fs');
  for (const resource of audit) {
    if (resource.type === 'directory') assert.equal(existsSync(resource.path), false);
    if (resource.type === 'child') assert.throws(() => process.kill(resource.pid, 0), { code: 'ESRCH' });
  }
});

test('real waiting queue keeps nonnumeric order before dispatch and through cancellation', async t => {
  const h = await harness(t, { background: [0, 1, 2, 3] });
  let state;
  for (const actor of [2, 0, 1]) state = await h.act({ action: 'enqueue', actor });
  assert.deepEqual(state.queue, [2, 0, 1]);
  assert.deepEqual(state.queueIds, ['segment-2', 'segment-0', 'segment-1']);
  assert.deepEqual(state.ledger, []);
  state = await h.act({ action: 'duplicate', actor: 2 });
  assert.equal(state.lastResult.accepted, false);
  assert.deepEqual(state.queue, [2, 0, 1]);
  state = await h.act({ action: 'cancel_queued', actor: 0 });
  assert.deepEqual(state.queue, [2, 1]);
  state = await h.act({ action: 'enqueue', actor: 0 });
  assert.deepEqual(state.queue, [2, 1, 0]);
  state = await h.act({ action: 'pump' });
  assert.deepEqual(state.recentStarts, [2, 1]);
  assert.deepEqual(state.queue, [0]);
});
