import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { atomicityScenario } from '../test-support/import-atomicity-scenarios.mjs';
import { assertAtomicityBoundary, validateAtomicityObservations } from '../test-support/import-atomicity-evidence.mjs';
import { atomicityRegressionCount, atomicityRegressionTap } from '../test-support/import-atomicity-contract.mjs';
let original, source;
before(async () => {
  const file = process.env.IMPORT_ATOMICITY_TEST_EVIDENCE_FILE;
  if (file) {
    const full = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(validateAtomicityObservations(full).ok, true);
    original = full.scenarios.find(row => row.id === 'append/crash/after-commit'); source = full.source;
  } else {
    // This audit mutates one real boundary trace, not another full business matrix.
    // The profile and crash/data tests still require all 27 original scenarios.
    source = sourceVersion();
    original = await atomicityScenario({ mode: 'append', kind: 'crash', boundary: 'after-commit' });
  }
  assertAtomicityBoundary(original, source);
}, { timeout: 60000 });
test('atomicity audit rejects erased crash boundary events', () => {
  const changed = structuredClone(original); changed.events = [];
  assert.throws(() => assertAtomicityBoundary(changed, source));
});
test('atomicity audit rejects contradictory SQL and out-of-run boundary timestamps', () => {
  const changed = structuredClone(original); changed.marker.sql = 'SELECT 1'; changed.marker.mutations = 0;
  assert.throws(() => assertAtomicityBoundary(changed, source));
  const times = [...original.lifecycle, ...original.events].map(value => Date.parse(value.at));
  const window = { startedAt: new Date(Math.min(...times)).toISOString(), finishedAt: new Date(Math.max(...times)).toISOString() };
  assertAtomicityBoundary(original, source, window);
  for (const days of [-365, 365]) {
    const shifted = structuredClone(original);
    for (const value of [...shifted.lifecycle, ...shifted.events, shifted.marker]) value.at = new Date(Date.parse(value.at) + days * 86400000).toISOString();
    // Every local ordering and SQL/marker binding still matches the genuine trace.
    assertAtomicityBoundary(shifted, source);
    assert.throws(() => assertAtomicityBoundary(shifted, source, window));
  }
});
test('atomicity audit rejects footer-only passing TAP', () => {
  const n = atomicityRegressionCount;
  const forged = `TAP version 13\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  assert.equal(atomicityRegressionTap(forged).ok, false);
});
