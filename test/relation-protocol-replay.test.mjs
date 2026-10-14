import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelationProtocolAdapter } from '../test-support/relation-protocol-adapter.mjs';
import { decodeITF, normalizeProtocolTrace, replayProtocolTrace } from '../scripts/lib/protocol-replay.mjs';
import { checkerConclusion } from '../scripts/lib/relation-protocol-evidence.mjs';

const initial = { phase: { 0: 'idle' }, counts: { 0: 0 }, calls: { 0: 0 }, relations: { 0: 0 }, outcome: { 0: 'none' }, replies: { 0: 'none' }, ready: { 0: true } };
const reservationTrace = { schemaVersion: 1, specificationVersion: '1.0', config: { actors: 1, capacity: 1, mode: 'valid' }, initial,
  steps: [{ action: 'admit', actor: 0, response: '', expected: { ...initial, phase: { 0: 'reserved' }, counts: { 0: 1 } } }] };

test('replay detects an isolated broken reservation guard and keeps mismatch separate from an unreplayable trace', async () => {
  assert.equal((await replayProtocolTrace(reservationTrace, createRelationProtocolAdapter)).classification, 'matched');
  const broken = await replayProtocolTrace(reservationTrace, options => createRelationProtocolAdapter({ ...options, mutation: 'skip_reservation' }));
  assert.equal(broken.classification, 'implementation_mismatch'); assert.equal(broken.ok, false);
  assert.equal(broken.difference.actual.counts[0], 0); assert.equal(broken.difference.expected.counts[0], 1);
  assert.equal(broken.counterexample.steps.length, 1);
  const unsupported = structuredClone(reservationTrace); unsupported.steps[0].action = 'unknown_action';
  const cannotReplay = await replayProtocolTrace(unsupported, createRelationProtocolAdapter);
  assert.equal(cannotReplay.classification, 'unreplayable'); assert.equal(cannotReplay.complete, false); assert.equal(cannotReplay.ok, false);
  const incomplete = structuredClone(reservationTrace); delete incomplete.initial.counts;
  assert.equal((await replayProtocolTrace(incomplete, createRelationProtocolAdapter)).classification, 'unreplayable');
  assert.equal((await replayProtocolTrace(reservationTrace, createRelationProtocolAdapter)).ok, true, 'The mutation must not escape its isolated store');
});

test('ITF rejects unsafe integers, duplicate actors and ambiguous names instead of silently changing the model state', () => {
  assert.equal(decodeITF({ '#bigint': '3' }), 3);
  assert.throws(() => decodeITF({ '#bigint': '9007199254740993' }), /safe-integer/);
  assert.throws(() => decodeITF({ '#map': [[{ '#bigint': '0' }, 1], [{ '#bigint': '0' }, 2]] }), /Duplicate/);
  assert.throws(() => normalizeProtocolTrace({ vars: ['one::phase', 'two::phase'], states: [{}] }, {}), /ambiguous/);
});

test('checker conclusions distinguish complete exploration, bounded depth and expected model counterexamples', () => {
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  const tlc = 'Model checking completed. No error has been found.\n160 states generated, 112 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 15.';
  assert.equal(checkerConclusion('finite-state-complete', execution, tlc).ok, true);
  assert.equal(checkerConclusion('finite-state-complete', execution, tlc.replace('0 states left', '1 states left')).ok, false);
  assert.equal(checkerConclusion('finite-state-complete', { ...execution, timedOut: true }, tlc).ok, false);
  assert.equal(checkerConclusion('finite-state-complete', { ...execution, interrupted: true }, tlc).complete, false);
  const bmc = 'Step 8: picking a transition\nThe outcome is: NoError\n[ok] No violation found';
  assert.equal(checkerConclusion('bounded-model-check', execution, bmc, 8).ok, true);
  assert.equal(checkerConclusion('bounded-model-check', execution, bmc, 12).ok, false);
  assert.equal(checkerConclusion('model-negative', { ...execution, code: 1 }, 'error: download failed').ok, false);
  assert.equal(checkerConclusion('model-negative', { ...execution, code: 1 }, 'error: found a counterexample').ok, true);
});

test('relation replay separates durable reservation, send, response, commit and notification', async t => {
  const adapter = await createRelationProtocolAdapter({ actors: 1, capacity: 1, mode: 'valid' });
  t.after(() => adapter.close());
  const initial = adapter.project();
  assert.equal(initial.counts[0], 0);
  assert.equal(initial.calls[0], 0);
  await adapter.act({ action: 'admit', actor: 0 });
  assert.equal(adapter.project().phase[0], 'reserved');
  assert.equal(adapter.project().counts[0], 1);
  assert.equal(adapter.project().calls[0], 0);
  await adapter.act({ action: 'send', actor: 0 });
  assert.equal(adapter.project().phase[0], 'inflight');
  assert.equal(adapter.project().calls[0], 1);
  await adapter.act({ action: 'response', actor: 0, response: 'ok' });
  assert.equal(adapter.project().phase[0], 'received');
  assert.equal(adapter.project().relations[0], 0);
  await adapter.act({ action: 'commit', actor: 0 });
  assert.equal(adapter.project().phase[0], 'committed');
  assert.equal(adapter.project().relations[0], 1);
  assert.equal(adapter.project().outcome[0], 'ok');
  await adapter.act({ action: 'notify_fail', actor: 0 });
  assert.equal(adapter.project().phase[0], 'done');
  assert.equal(adapter.project().relations[0], 1);
  assert.equal(adapter.project().calls[0], 1);
  assert.deepEqual(adapter.observe().actors[0].journal.map(row => row.outcome), ['complete']);
});

test('shared provider cooldown prevents another listening from consuming a request until Retry-After', async t => {
  const adapter = await createRelationProtocolAdapter({ actors: 3, capacity: 2 });
  t.after(() => adapter.close());
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response: 'rate_limit' });
  const failed = adapter.observe();
  assert.equal(failed.actors[0].job.ready_at - failed.clock, 7000);
  assert.equal(failed.actors[0].providerReadyAt - failed.clock, 7000);
  await adapter.act({ action: 'admit', actor: 1 });
  assert.equal(adapter.project().calls[1], 0); assert.equal(adapter.project().counts[1], 0);
  assert.equal(adapter.observe().actors[1].result.reason, 'provider_cooldown');
  await adapter.act({ action: 'advance_time', actor: -1, milliseconds: 6999 });
  await adapter.act({ action: 'admit', actor: 1 });
  assert.equal(adapter.project().counts[1], 0);
  await adapter.act({ action: 'advance_time', actor: -1, milliseconds: 1 });
  await adapter.act({ action: 'admit', actor: 1 });
  await adapter.act({ action: 'send', actor: 1 });
  assert.equal(adapter.project().counts[1], 1); assert.equal(adapter.project().calls[1], 1);
});

test('valid empty and fully filtered responses settle without extra calls; insufficient candidates make zero calls', async t => {
  for (const response of ['empty', 'filtered']) await t.test(response, async sub => {
    const adapter = await createRelationProtocolAdapter(); sub.after(() => adapter.close());
    for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
    await adapter.act({ action: 'response', actor: 0, response });
    for (const action of ['commit', 'notify']) await adapter.act({ action, actor: 0 });
    const state = adapter.project(), actual = adapter.observe().actors[0];
    assert.equal(state.calls[0], 1); assert.equal(state.outcome[0], 'empty');
    assert.equal(actual.job.state, 'complete'); assert.equal(actual.relations.length, 0);
    assert.equal(actual.knowledgeCount, 2);
  });
  await t.test('no candidates', async sub => {
    const adapter = await createRelationProtocolAdapter({ mode: 'no_candidates' }); sub.after(() => adapter.close());
    await adapter.act({ action: 'admit', actor: 0 });
    assert.equal(adapter.project().phase[0], 'waiting_nodes');
    assert.equal(adapter.project().calls[0], 0); assert.equal(adapter.project().counts[0], 0);
    assert.equal(adapter.observe().actors[0].job, null);
  });
});

test('SQLite commit failure after a successful response never adds another request', async t => {
  const adapter = await createRelationProtocolAdapter();
  t.after(() => adapter.close());
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response: 'ok' });
  await adapter.act({ action: 'commit_fail', actor: 0 });
  const state = adapter.project(), actual = adapter.observe().actors[0];
  assert.equal(state.phase[0], 'done');
  assert.equal(state.calls[0], 1); assert.equal(state.counts[0], 1);
  assert.equal(state.relations[0], 0); assert.equal(state.outcome[0], 'failed');
  assert.equal(actual.job.state, 'failed');
  await adapter.act({ action: 'advance_time', actor: -1 });
  assert.equal(adapter.project().calls[0], 1);
});

test('reservation write failure rolls back its budget and never invokes the provider', async t => {
  const adapter = await createRelationProtocolAdapter({ mode: 'reserve_fail' });
  t.after(() => adapter.close());
  await adapter.act({ action: 'admit', actor: 0 });
  const state = adapter.project(), actual = adapter.observe().actors[0];
  assert.equal(state.phase[0], 'reserve_failed');
  assert.equal(state.counts[0], 0);
  assert.equal(state.calls[0], 0);
  assert.equal(actual.job.request_count, 0);
  assert.equal(actual.job.state, 'pending');
  assert.match(actual.error.message, /synthetic reservation failure/);
});

test('protocol failures consume two durable calls including the failed responses', async t => {
  const adapter = await createRelationProtocolAdapter();
  t.after(() => adapter.close());
  for (let attempt = 1; attempt <= 2; attempt++) {
    await adapter.act({ action: 'admit', actor: 0 });
    await adapter.act({ action: 'send', actor: 0 });
    await adapter.act({ action: 'response', actor: 0, response: 'protocol' });
    const state = adapter.project();
    assert.equal(state.calls[0], attempt);
    assert.equal(state.counts[0], attempt);
    assert.equal(state.phase[0], attempt === 1 ? 'retry_wait' : 'done');
    if (attempt === 1) await adapter.act({ action: 'advance_time', actor: -1 });
  }
  assert.equal(adapter.project().outcome[0], 'failed');
  assert.equal(adapter.observe().actors[0].job.state, 'failed');
});

test('implementation regression evidence requires executed TAP tests, not a silent successful child', () => {
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  const tap = 'TAP version 13\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(checkerConclusion('implementation-regression', execution, tap).ok, true);
  assert.equal(checkerConclusion('implementation-regression', execution, '').ok, false);
  assert.equal(checkerConclusion('implementation-regression', execution, tap.replace('# tests 1', '# tests 0')).ok, false);
  for (const field of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(checkerConclusion('implementation-regression', execution, tap.replace(`# ${field} 0`, `# ${field} 1`)).ok, false);
});

test('replay rejects a corrupted durable commit even when its observational projection still matches', async () => {
  let state = structuredClone(initial);
  const expected = changes => (state = { ...state, ...changes });
  const trace = { ...reservationTrace, steps: [
    { action: 'admit', actor: 0, expected: expected({ phase: { 0: 'reserved' }, counts: { 0: 1 } }) },
    { action: 'send', actor: 0, expected: expected({ phase: { 0: 'inflight' }, calls: { 0: 1 } }) },
    { action: 'response', actor: 0, response: 'ok', expected: expected({ phase: { 0: 'received' }, replies: { 0: 'ok' } }) },
    { action: 'commit', actor: 0, expected: expected({ phase: { 0: 'committed' }, relations: { 0: 1 }, outcome: { 0: 'ok' } }) }
  ] };
  assert.equal((await replayProtocolTrace(trace, createRelationProtocolAdapter)).ok, true);
  const broken = await replayProtocolTrace(trace, options => createRelationProtocolAdapter({ ...options, mutation: 'corrupt_committed_state' }));
  assert.equal(broken.classification, 'implementation_mismatch');
  assert.deepEqual(broken.difference.actual, broken.difference.expected, 'Only durable state was corrupted, not the observational phase');
  assert.match(broken.difference.durableViolations.join('\n'), /not durably complete/);
  assert.equal(broken.counterexample.steps.length, 4);
});
