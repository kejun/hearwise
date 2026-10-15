import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFormalRegression } from '../scripts/lib/formal-regression-contract.mjs';
import { syntheticFormalTap } from '../test-support/synthetic-formal-tap.mjs';
import * as shared from '../scripts/lib/formal-regression-contract.mjs';
import * as legacy from '../scripts/lib/formal-release-evidence.mjs';
import { processRegressionContract } from '../scripts/lib/process-release-evidence.mjs';
import processNames from '../verification/release/process-regressions.json' with { type: 'json' };


for (const kind of ['relation-protocol', 'knowledge-protocol', 'import-protocol', 'process-crash']) test(`canonical ${kind} TAP roster rejects missing, swapped and invented result bodies`, async () => {
  const good = await syntheticFormalTap(kind);
  assert.equal(await validateFormalRegression(kind, good), true);
  const footerOnly = 'TAP version 13\n' + good.split('\n').filter(line => /^1\.\.|^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line)).join('\n') + '\n';
  for (const bad of [footerOnly, good.replace(/^(\s*)ok 1 - .+/m, '$1ok 1 - invented name'), good.replace(/^\s*ok 1 - .+\n/m, ''),
    good.replace(/^(\s*)ok 2 -/m, '$1ok 1 -'), good.replace('TAP version 13\n', 'TAP version 13\nBail out!\n'), good.replace(/^(\s*)ok 1 -/m, '$1not ok 1 -')])
    await assert.rejects(validateFormalRegression(kind, bad));
});

test('formal release parser exports remain the canonical shared functions', () => {
  for (const name of ['regressionNames', 'importRegressionTree', 'validateFormalRegression']) {
    assert.equal(legacy[name], shared[name]);
  }
});

test('shared process parser preserves the exact 36-name roster and command scope', async () => {
  assert.equal(await shared.formalRegressionTree('process-crash'), processNames);
  assert.equal(processNames.length, 36);
  assert.deepEqual(processRegressionContract, {
    files: ['test/process-crash-replay.test.mjs', 'test/process-crash-lock.test.mjs', 'test/process-crash-trace.test.mjs'],
    count: 36, cwd: 'evidence'
  });
  const footer = '1..36\n# tests 36\n# suites 0\n# pass 36\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n';
  const body = processNames.map((name, index) => `ok ${index + 1} - ${name.replaceAll('\\', '\\\\').replaceAll('#', '\\#')}\n`).join('');
  const log = `TAP version 13\n${body}${footer}`;
  assert.equal(await shared.validateFormalRegression('process-crash', log), true);
  await assert.rejects(shared.validateFormalRegression('process-crash', `TAP version 13\n${footer}`));
  await assert.rejects(shared.validateFormalRegression('process-crash', log.replace('TAP version 13\n', 'TAP version 13\n    not ok 1 - hidden child failure\n')));
});
