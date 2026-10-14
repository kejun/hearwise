import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicitySource, stableAtomicitySources, validateAtomicityObservations, validateAtomicityBrowser, executionPassed } from '../test-support/import-atomicity-evidence.mjs';

test('atomicity source hashes reject dirty-to-dirty changes and release dirtiness', async () => {
  const start = await atomicitySource(), end = structuredClone(start);
  assert.equal(stableAtomicitySources(start, end), true);
  end.digests['data-transfer.mjs'] = '0'.repeat(64);
  assert.equal(stableAtomicitySources(start, end), false);
  const dirty = { ...start, dirty: true }; assert.equal(stableAtomicitySources(dirty, dirty, true), false);
});
test('atomicity evidence rejects absent cases despite cached passed flags', async () => {
  assert.equal(validateAtomicityObservations({ version: '1.0', complete: true, ok: true, scenarios: [] }).ok, false);
  assert.equal(validateAtomicityObservations({ version: 'old', scenarios: [] }).ok, false);
  const { collectAtomicityControls } = await import('../scripts/lib/import-atomicity-controls.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomicity-failed-controls-'));
  try {
    await writeFile(path.join(directory, 'observations.json'), JSON.stringify({ version: '1.0', scenarios: [] }));
    const report = {}; await collectAtomicityControls(directory, report);
    assert.equal(report.error, undefined, 'a failed Node matrix must not become a global runner error');
    assert.equal(report.controlsError.name, 'AssertionError');
    await assert.rejects(readFile(path.join(directory, 'controls.json')), { code: 'ENOENT' });
    const runnerError = { name: 'Error', message: 'independent runner failure' }, existing = { error: runnerError };
    await collectAtomicityControls(directory, existing);
    assert.equal(existing.error, runnerError); assert.equal(existing.controlsError.name, 'AssertionError');
  } finally { await rm(directory, { recursive: true, force: true }); }

});
test('atomicity browser cannot be supplied by Node or an empty cached pass', () => {
  assert.equal(validateAtomicityBrowser({ complete: true, ok: true, chromium: 'claimed', scenarios: [], cleanup: [] }).ok, false);
});
test('atomicity execution rejects timeouts signals interruption and missing finish', async () => {
  const done = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true };
  assert.equal(executionPassed(done), true);
  for (const delta of [{ code: null }, { code: 1 }, { signal: 'SIGKILL' }, { timedOut: true }, { interrupted: true }, { ok: false }])
    assert.equal(executionPassed({ ...done, ...delta }), false);
  const { atomicityCleanupError } = await import('../test-support/import-atomicity-scenarios.mjs');
  let primary; try { assert.equal('partial write', 'original projection'); } catch (error) { primary = error; }
  const cleanup = new Error('fixture cleanup failed'), combined = atomicityCleanupError(primary, cleanup);
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.cause, primary); assert.deepEqual(combined.errors, [primary, cleanup]);
  assert.equal(combined.errors[0].stack, primary.stack); assert.equal(combined.errors[1].stack, cleanup.stack);
  assert.equal(atomicityCleanupError(undefined, cleanup), cleanup);

});


test('atomicity commands bind the actual regression files cwd and budgets', async () => {
  const { atomicityChecks, validAtomicityCommand, validAtomicityLocations } = await import('../test-support/import-atomicity-contract.mjs');
  const expected = atomicityChecks('/tmp/atomicity-contract', true).find(row => row.name === 'regressions');
  const actual = { command: [process.execPath, ...expected.command], cwd: process.cwd(), log: 'regressions.log', configuredTimeoutMs: expected.timeout, effectiveTimeoutMs: expected.timeout };
  assert.equal(validAtomicityCommand(actual, expected, process.cwd()), true);
  const directory = '/tmp/atomicity-contract', node = atomicityChecks(directory, true).find(row => row.name === 'node');
  const report = { cwd: process.cwd(), evidenceDirectory: directory, checks: [actual, { ...actual, command: [process.execPath, ...node.command] }] };
  assert.equal(validAtomicityLocations(report, directory, process.cwd()), true);
  const cwdOnly = { ...report, cwd: '/tmp/unrelated-checkout' };
  const cwdAndCommand = { ...cwdOnly, checks: report.checks.map(check => ({ ...check, cwd: cwdOnly.cwd })) };
  const evidenceAndCommand = { ...report, evidenceDirectory: '/tmp/unrelated-artifacts', checks: report.checks.map(check => ({ ...check, command: check.command.map(value => value.replace(directory, '/tmp/unrelated-artifacts')) })) };
  for (const forged of [cwdOnly, cwdAndCommand, evidenceAndCommand]) assert.equal(validAtomicityLocations(forged, directory, process.cwd()), false);

  assert.equal(validAtomicityCommand({ ...actual, command: actual.command.slice(0, -1) }, expected, process.cwd()), false);
  assert.equal(validAtomicityCommand({ ...actual, cwd: '/wrong' }, expected, process.cwd()), false);
  assert.equal(validAtomicityCommand({ ...actual, configuredTimeoutMs: 90000 }, expected, process.cwd()), false);
});
test('atomicity TAP binds every expected test name number and body', async () => {
  const { atomicityRegressionNames: names, atomicityRegressionTap: validate } = await import('../test-support/import-atomicity-contract.mjs');
  const bodies = names.map((name, i) => `# Subtest: ${name}\nok ${i + 1} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n`);
  const end = `1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  const whole = `TAP version 13\n${bodies.join('')}${end}`;
  assert.equal(validate(whole).ok, true);
  const failed = whole.replace(/^ok 1 /m, 'not ok 1 ').replace(`# pass ${names.length}`, `# pass ${names.length - 1}`).replace('# fail 0', '# fail 1');
  assert.equal(validate(failed).ok, false); assert.equal(validate(failed).bodiesComplete, true);
  assert.equal(validate(whole.replace(bodies[0], '')).ok, false);
  assert.equal(validate(whole.replace(/^ok 1 /m, 'ok 99 ')).ok, false);
  assert.equal(validate(whole.replaceAll(names[0], 'Different test')).ok, false);
  for (const injected of ['    not ok 1 - hidden child', 'Bail out! verifier incomplete', '    1..99'])
    assert.equal(validate(whole.replace('TAP version 13\n', `TAP version 13\n${injected}\n`)).ok, false);
});
