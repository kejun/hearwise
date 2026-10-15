import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedTrace } from '../test-support/generation-trace-fixture.mjs';
import { createGenerationProtocolAdapter } from '../test-support/generation-protocol-adapter.mjs';
import { replayGenerationTrace } from '../scripts/lib/generation-protocol-replay.mjs';

for (const protocol of ['relation', 'knowledge']) test(`${protocol} real generation replay catches an isolated omitted durable reservation`, { timeout: 15000 }, async t => {
  const trace = await fixedTrace(t, protocol, 1, 1, 'normalSuccessTest', true);
  const normal = await replayGenerationTrace(trace, createGenerationProtocolAdapter);
  assert.equal(normal.ok, true, JSON.stringify(normal.error || normal.difference));
  const broken = await replayGenerationTrace(trace, config => createGenerationProtocolAdapter(config, { mutation: 'skip_reservation' }));
  assert.equal(broken.complete, true); assert.equal(broken.ok, false); assert.equal(broken.classification, 'implementation_mismatch');
  assert.equal(broken.difference.step, 1); assert.equal(broken.difference.actual.reserved[0], 0);
  assert.equal(broken.difference.expected.reserved[0], 1);
});

test('the real driver rejects a copied stale-transaction guard mutant while a newer owner is active', { timeout: 15000 }, async t => {
  const trace = await fixedTrace(t, 'relation', 1, 1, 'oldResponseWhileNewActiveTest', true);
  const normal = await replayGenerationTrace(trace, createGenerationProtocolAdapter); assert.equal(normal.ok, true);
  const broken = await replayGenerationTrace(trace, config => createGenerationProtocolAdapter(config, { mutation: 'omit_transaction_guard' }));
  assert.equal(broken.complete, true); assert.equal(broken.ok, false); assert.equal(broken.classification, 'implementation_mismatch');
  assert.deepEqual(broken.difference.actual.business[0], [0]); assert.deepEqual(broken.difference.expected.business[0], []);
  assert.equal(broken.difference.actual.activeOwner[0], 1); assert.equal(broken.difference.actual.reserved[1], 1);
  const trial = broken.observations.at(-1).durable.boundaryTrials[0];
  assert.equal(trial.normal.stale, true); assert.equal(trial.inputRestored, true); assert.equal(trial.variant.accepted, 1);
  assert.equal(trial.metadata.boundary, 'direct-old-context-transaction-call'); assert.equal(trial.metadata.replacedCount, 1);
});

test('real knowledge content corruption cannot pass merely because accepted item counts still match', { timeout: 15000 }, async t => {
  const trace = await fixedTrace(t, 'knowledge', 1, 1, 'normalSuccessTest', true);
  const broken = await replayGenerationTrace(trace, config => createGenerationProtocolAdapter(config, { mutation: 'corrupt_accepted_fact' }));
  assert.equal(broken.complete, true); assert.equal(broken.classification, 'implementation_mismatch');
  assert.deepEqual(broken.difference.actual.business, broken.difference.expected.business);
  assert.ok(broken.difference.durableViolations.includes('accepted_fact_changed'));
});
