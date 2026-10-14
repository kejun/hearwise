import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditProtocolAdapter } from '../test-support/edit-protocol-adapter.mjs';

const act = async (adapter, steps) => {
  for (const [action, actor = 0, argument = ''] of steps) {
    await adapter.act({ action, actor, argument }); adapter.project();
    assert.deepEqual(adapter.check(), [], `${action}: independent durable invariant`);
  }
};
const begin = actor => [['read', actor], ['edit', actor, 'new'], ['send', actor]];
const commit = actor => [['transaction', actor, 'ok'], ['notify', actor, 'ok']];

test('real HTTP clients reading the same current or frozen versions reject the later stale write without automatic resend', async t => {
  for (const codecs of [{ 0: 'v1', 1: 'v1' }, { 0: 'v11', 1: 'v12' }, { 0: 'v12', 1: 'v11' }]) {
    const adapter = await createEditProtocolAdapter({ codecs });
    try {
      await act(adapter, [...begin(0), ...begin(1), ...commit(0), ['deliver', 0], ['transaction', 1, 'rollback'], ['deliver', 1], ['refresh_stale', 1]]);
      const state = adapter.project(), observation = adapter.observe();
      assert.equal(state.name, 1); assert.equal(state.revision, 1);
      assert.equal(state.txResult[1], 'conflict'); assert.equal(state.phase[1], 'conflict');
      assert.equal(state.draft[1], 2); assert.equal(state.loadedName[1], 1);
      assert.deepEqual(state.requests, { 0: 1, 1: 1 }); assert.equal(observation.jobs.length, 1);
      assert.equal(observation.clients[1].actualResponse.status, 409);
      assert.equal(JSON.parse(observation.clients[1].actualResponse.text).code, 'KNOWLEDGE_EDIT_STALE');
    } finally { await adapter.close(); }
  }
});

test('v11 refuses an override while v12 preserves its frozen compatibility contract', async () => {
  for (const codec of ['v11', 'v12']) {
    const adapter = await createEditProtocolAdapter({ clients: 1, codecs: { 0: codec }, initialOverride: true });
    try {
      await act(adapter, [...begin(0), ['transaction', 0, 'ok'], ...(codec === 'v12' ? [['notify', 0, 'ok']] : []), ['deliver', 0]]);
      const state = adapter.project();
      assert.equal(state.txResult[0], codec === 'v11' ? 'conflict' : 'committed');
      assert.equal(state.override, codec === 'v11'); assert.equal(state.name, codec === 'v11' ? 0 : 1);
    } finally { await adapter.close(); }
  }
});

test('actual committed edits with lost/502 responses and unavailable receipts retain uncertainty and reopen persisted content', async () => {
  for (const transport of ['lost', 'proxy502']) {
    const adapter = await createEditProtocolAdapter({ clients: 1, codecs: { 0: 'v1' } });
    try {
      await act(adapter, [...begin(0), ['transaction', 0, 'ok'], ['notify', 0, 'fail'], ['lose_response', 0, transport], ['lookup', 0, 'unavailable']]);
      const uncertain = adapter.project(), observed = adapter.observe();
      assert.equal(observed.jobs[0].state, 'succeeded'); assert.equal(observed.snapshot.item.canonical_name, 'Tibo');
      assert.equal(uncertain.phase[0], 'unknown'); assert.equal(uncertain.reply[0], 'unknown'); assert.equal(uncertain.draft[0], 1);
      assert.equal(uncertain.requests[0], 1); assert.equal(observed.clients[0].lookups, 1);
      await act(adapter, [['close', 0], ['reopen', 0]]);
      assert.equal(adapter.project().loadedName[0], 1); assert.equal(adapter.project().phase[0], 'loaded');
    } finally { await adapter.close(); }
  }
});

test('mid-transaction rollback is all-table atomic and a later independent edit can succeed', async () => {
  const adapter = await createEditProtocolAdapter();
  try {
    await act(adapter, [...begin(0), ['transaction', 0, 'rollback'], ['deliver', 0]]);
    assert.equal(adapter.project().name, 0); assert.equal(adapter.project().txResult[0], 'rolled_back');
    assert.equal(adapter.observe().jobs.length, 0);
    await act(adapter, [...begin(1), ...commit(1), ['deliver', 1], ['refresh_saved', 1]]);
    assert.equal(adapter.project().name, 2); assert.equal(adapter.project().phase[1], 'done');
  } finally { await adapter.close(); }
});

test('a delayed successful response refreshes current persisted content after another client committed', async () => {
  const adapter = await createEditProtocolAdapter();
  try {
    await act(adapter, [...begin(0), ...commit(0), ...begin(1), ...commit(1), ['deliver', 1], ['refresh_saved', 1], ['deliver', 0], ['refresh_saved', 0]]);
    const state = adapter.project(); assert.equal(state.name, 2); assert.equal(state.revision, 2);
    assert.deepEqual(state.loadedName, { 0: 2, 1: 2 }); assert.deepEqual(state.requests, { 0: 1, 1: 1 });
    assert.deepEqual(state.receipt, { 0: 'succeeded', 1: 'succeeded' });
  } finally { await adapter.close(); }
});

test('real transaction/client mutations produce semantic violations rather than tool failures', async () => {
  for (const mutation of ['bypass_revision', 'auto_revision_resend']) {
    const adapter = await createEditProtocolAdapter({ clients: 1, codecs: { 0: 'v1' }, mutation });
    try {
      await act(adapter, [...begin(0), ['background_change', -1]]);
      await adapter.act({ action: 'transaction', actor: 0, argument: 'ok' });
      if (mutation === 'auto_revision_resend') {
        await act(adapter, [['deliver', 0]]);
        await adapter.act({ action: 'refresh_stale', actor: 0 });
      }
      const state = adapter.project(), errors = adapter.check();
      if (mutation === 'bypass_revision') {
        assert.equal(state.txResult[0], 'committed'); assert.equal(state.submittedRevision[0], 0); assert.equal(state.commitBaseRevision[0], 1);
        assert.ok(errors.some(error => error.includes('stale/incompatible revision committed')));
      } else {
        assert.equal(state.userSaves[0], 1); assert.equal(state.requests[0], 2);
        assert.ok(errors.some(error => error.includes('automatic POST')));
      }
      assert.equal(adapter.observe().providerCalls, 0);
    } finally { await adapter.close(); }
  }
});
