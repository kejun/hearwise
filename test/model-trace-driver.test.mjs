import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeITF, normalizeITFStates, replayModelTrace } from '../scripts/lib/protocol-replay.mjs';

// Domain-neutral driver tests only; these synthetic counters are not business evidence.
const trace = { schemaVersion: 1, specificationVersion: 'counter-unit-test', config: {}, initial: { count: 0 },
  steps: [{ action: 'increment', expected: { count: 1 } }] };
const validateTrace = input => input.specificationVersion === 'counter-unit-test' && input.initial?.count === 0;
const adapter = ({ wrong = false, failCleanup = false } = {}) => async () => {
  let count = 0;
  return { act: async () => { count += wrong ? 2 : 1; }, project: () => ({ count }), observe: () => ({ testOnly: true, count }),
    close: async () => { if (failCleanup) throw new Error('unit cleanup failure'); } };
};

test('generic replay requires a domain validator and keeps relation-specific fields out of the shared core', async () => {
  const matched = await replayModelTrace(trace, adapter(), { validateTrace });
  assert.equal(matched.ok, true); assert.equal(matched.classification, 'matched');
  assert.equal(matched.observations.length, 2);
  assert.equal((await replayModelTrace(trace, adapter())).classification, 'unreplayable');
  assert.equal((await replayModelTrace(trace, adapter(), { validateTrace: () => false })).classification, 'unreplayable');
});

test('generic replay preserves first divergence and refuses a successful result with failed cleanup', async () => {
  const mismatch = await replayModelTrace(trace, adapter({ wrong: true }), { validateTrace });
  assert.equal(mismatch.classification, 'implementation_mismatch'); assert.equal(mismatch.complete, true);
  assert.equal(mismatch.counterexample.steps.length, 1); assert.equal(mismatch.difference.step, 0);
  const unclosed = await replayModelTrace(trace, adapter({ failCleanup: true }), { validateTrace });
  assert.equal(unclosed.ok, false); assert.equal(unclosed.complete, false); assert.equal(unclosed.classification, 'unreplayable');
});

test('ITF state normalization is reusable but rejects missing and ambiguous domain fields', () => {
  const itf = { vars: ['counter::count', 'counter::ready'], states: [{ 'counter::count': { '#bigint': '0' }, 'counter::ready': true }] };
  assert.deepEqual(normalizeITFStates(itf, ['count', 'ready']), [{ count: 0, ready: true }]);
  assert.throws(() => normalizeITFStates(itf, ['budget']), /Missing/);
  assert.throws(() => normalizeITFStates({ vars: ['one::count', 'two::count'], states: [{}] }, ['count']), /ambiguous/);
});


test('ITF integer sets have a canonical order and reject duplicate or unsupported members', () => {
  assert.deepEqual(decodeITF({ '#set': [{ '#bigint': '1' }, { '#bigint': '0' }] }), [0, 1]);
  assert.deepEqual(decodeITF({ '#set': [] }), []);
  assert.throws(() => decodeITF({ '#set': [{ '#bigint': '1' }, { '#bigint': '1' }] }), /Duplicate/);
  assert.throws(() => decodeITF({ '#set': ['unexpected'] }), /integer/);
});
