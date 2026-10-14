import test from 'node:test';
import assert from 'node:assert/strict';
import { atomicitySource, stableAtomicitySources, validateAtomicityObservations, validateAtomicityBrowser, executionPassed } from '../test-support/import-atomicity-evidence.mjs';

test('atomicity source hashes reject dirty-to-dirty changes and release dirtiness', async () => {
  const start = await atomicitySource(), end = structuredClone(start);
  assert.equal(stableAtomicitySources(start, end), true);
  end.digests['data-transfer.mjs'] = '0'.repeat(64);
  assert.equal(stableAtomicitySources(start, end), false);
  const dirty = { ...start, dirty: true }; assert.equal(stableAtomicitySources(dirty, dirty, true), false);
});
test('atomicity evidence rejects absent cases despite cached passed flags', () => {
  assert.equal(validateAtomicityObservations({ version: '1.0', complete: true, ok: true, scenarios: [] }).ok, false);
  assert.equal(validateAtomicityObservations({ version: 'old', scenarios: [] }).ok, false);
});
test('atomicity browser cannot be supplied by Node or an empty cached pass', () => {
  assert.equal(validateAtomicityBrowser({ complete: true, ok: true, chromium: 'claimed', scenarios: [], cleanup: [] }).ok, false);
});
test('atomicity execution rejects timeouts signals interruption and missing finish', () => {
  const done = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true };
  assert.equal(executionPassed(done), true);
  for (const delta of [{ code: null }, { code: 1 }, { signal: 'SIGKILL' }, { timedOut: true }, { interrupted: true }, { ok: false }])
    assert.equal(executionPassed({ ...done, ...delta }), false);
});
