import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFormalRegression } from '../scripts/lib/formal-regression-contract.mjs';
import { syntheticFormalTap } from '../test-support/synthetic-formal-tap.mjs';

for (const kind of ['relation-protocol', 'knowledge-protocol', 'import-protocol', 'process-crash']) test(`canonical ${kind} TAP roster rejects missing, swapped and invented result bodies`, async () => {
  const good = await syntheticFormalTap(kind);
  assert.equal(await validateFormalRegression(kind, good), true);
  const footerOnly = 'TAP version 13\n' + good.split('\n').filter(line => /^1\.\.|^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line)).join('\n') + '\n';
  for (const bad of [footerOnly, good.replace(/^(\s*)ok 1 - .+/m, '$1ok 1 - invented name'), good.replace(/^\s*ok 1 - .+\n/m, ''),
    good.replace(/^(\s*)ok 2 -/m, '$1ok 1 -'), good.replace('TAP version 13\n', 'TAP version 13\nBail out!\n'), good.replace(/^(\s*)ok 1 -/m, '$1not ok 1 -')])
    await assert.rejects(validateFormalRegression(kind, bad));
});
