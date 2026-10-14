import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTraceNegativeControls, mutateTraceSource, traceMutations } from '../test-support/trace-business-negative.mjs';

test('actual workflow snapshots reject two compiled production Trace mutations', { timeout: 15000 }, async () => {
  const result = await runTraceNegativeControls(); assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0].observedStates, ['recovered']);
  assert.equal(result.results[1].businessObjects, 2);
});
test('Trace mutation anchors fail closed when missing or ambiguous', () => {
  for (const mutation of traceMutations) {
    assert.throws(() => mutateTraceSource('missing', mutation));
    assert.throws(() => mutateTraceSource(mutation.anchor.repeat(2), mutation));
  }
});
