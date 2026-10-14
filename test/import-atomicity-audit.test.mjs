import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../scripts/lib/process.mjs';
import { validateAtomicityObservations } from '../test-support/import-atomicity-evidence.mjs';
import { atomicityRegressionCount, atomicityRegressionTap } from '../test-support/import-atomicity-contract.mjs';
let original, directory;
before(async () => {
  let file = process.env.IMPORT_ATOMICITY_TEST_EVIDENCE_FILE;
  if (!file) {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-atomicity-audit-')); file = path.join(directory, 'observations.json');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = await runProcess(process.execPath, ['test-support/import-atomicity-worker.mjs', file], { env, timeoutMs: 55000 });
    assert.equal(result.ok, true, result.tail);
  }
  original = JSON.parse(await readFile(file, 'utf8')); assert.equal(validateAtomicityObservations(original).ok, true);
}, { timeout: 60000 });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
test('atomicity audit rejects erased crash boundary events', () => {
  const changed = structuredClone(original);
  for (const row of changed.scenarios.filter(row => row.kind === 'crash')) row.events = [];
  assert.equal(validateAtomicityObservations(changed).ok, false);
});
test('atomicity audit rejects contradictory SQL and out-of-run boundary timestamps', () => {
  const changed = structuredClone(original), row = changed.scenarios.find(row => row.id === 'append/crash/after-commit');
  row.marker.sql = 'SELECT 1'; row.marker.mutations = 0;
  assert.equal(validateAtomicityObservations(changed).ok, false);
  const times = original.scenarios.flatMap(value => [...(value.lifecycle || []), ...(value.events || [])]).map(value => Date.parse(value.at));
  const window = { startedAt: new Date(Math.min(...times)).toISOString(), finishedAt: new Date(Math.max(...times)).toISOString() };
  assert.equal(validateAtomicityObservations(original, window).ok, true);
  for (const days of [-365, 365]) {
    const shifted = structuredClone(original), target = shifted.scenarios.find(value => value.id === 'append/crash/after-commit');
    for (const value of [...target.lifecycle, ...target.events, target.marker]) value.at = new Date(Date.parse(value.at) + days * 86400000).toISOString();
    // Every local ordering and SQL/marker binding still matches the genuine trace.
    assert.equal(validateAtomicityObservations(shifted).ok, true);
    assert.equal(validateAtomicityObservations(shifted, window).ok, false);
  }
});
test('atomicity audit rejects footer-only passing TAP', () => {
  const n = atomicityRegressionCount;
  const forged = `TAP version 13\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  assert.equal(atomicityRegressionTap(forged).ok, false);
});
