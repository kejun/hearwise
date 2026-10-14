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


test('atomicity commands bind the actual regression files cwd and budgets', async () => {
  const { atomicityChecks, validAtomicityCommand } = await import('../test-support/import-atomicity-contract.mjs');
  const expected = atomicityChecks('/tmp/atomicity-contract', true).find(row => row.name === 'regressions');
  const actual = { command: [process.execPath, ...expected.command], cwd: process.cwd(), log: 'regressions.log', configuredTimeoutMs: expected.timeout, effectiveTimeoutMs: expected.timeout };
  assert.equal(validAtomicityCommand(actual, expected, process.cwd()), true);
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
  assert.equal(validate(whole.replace(bodies[0], '')).ok, false);
  assert.equal(validate(whole.replace(/^ok 1 /m, 'ok 99 ')).ok, false);
  assert.equal(validate(whole.replaceAll(names[0], 'Different test')).ok, false);
  for (const injected of ['    not ok 1 - hidden child', 'Bail out! verifier incomplete', '    1..99'])
    assert.equal(validate(whole.replace('TAP version 13\n', `TAP version 13\n${injected}\n`)).ok, false);
});
