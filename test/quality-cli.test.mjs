import { test } from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises'; import path from 'node:path'; import { tmpdir } from 'node:os';
import { writeQualityPlanFixture } from '../test-support/quality-plan-fixture.mjs';
import { freezeQualityPlan } from '../scripts/lib/quality-contract.mjs';
const run = (args, env = {}) => { const { NODE_TEST_CONTEXT, HEARWISE_QUALITY_API_KEY, ...base } = process.env;
  return spawnSync(process.execPath, ['scripts/evaluate-asr-translation-quality.mjs', ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 15000 }); };
test('default command only plans and reports unknown real evaluation requirements', () => {
  const result = run([]); assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.qualityStatus, 'not_run'); assert.equal(report.qualityEvaluated, false); assert.equal(report.eligibleForFreeze, false);
  assert.ok(report.missing.includes('thresholds_not_frozen'));
});
test('incomplete approval, offline/live confusion and ordinary CI refuse live startup', async t => {
  for (const args of [['freeze','--out','/tmp/should-not-exist-quality-freeze'], ['collect','--live'], ['offline','--live'], ['offline','--approve-budget','anything']]) {
    const result = run(args); assert.equal(result.status, 1); const report = JSON.parse(result.stderr.split('\n').find(line => line.startsWith('{')));
    assert.equal(report.qualityEvaluated, false); assert.equal(report.qualityStatus, 'not_run');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await writeQualityPlanFixture(directory), freeze = path.join(directory, 'frozen.json'); await freezeQualityPlan(f.configFile, freeze);
  const result = run(['collect','--freeze',freeze,'--role','candidate','--out',path.join(directory,'run'),'--live','--approve-budget',f.config.budget.id], { CI: 'true', HEARWISE_QUALITY_API_KEY: 'synthetic-never-used-key' });
  assert.equal(result.status, 1); assert.match(result.stderr, /EXPLICIT_LIVE_BUDGET_APPROVAL_REQUIRED/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-never-used-key/);
  const missingBaseline = run(['collect','--freeze',freeze,'--role','candidate','--out',path.join(directory,'run'),'--live','--approve-budget',f.config.budget.id], { CI: '' });
  assert.equal(missingBaseline.status, 1); assert.match(missingBaseline.stderr, /COMPLETE_BASELINE_REQUIRED/);
  assert.doesNotMatch(missingBaseline.stderr, /DEDICATED_OPERATOR_KEY_REQUIRED/, 'baseline is rejected before any credential is needed');
});
