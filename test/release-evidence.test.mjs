import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releaseEvidence, readTechnicalEvidence, isCurrentTechnicalPass } from '../scripts/lib/release-evidence.mjs';
import { validateHistoricalEvidence, historicalBindings } from '../scripts/lib/historical-release-evidence.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { technicalSuites } from '../verification/release/policy.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

test('fixed release purposes expose all fifteen business domains and unfrozen external acceptance', async () => {
  for (const purpose of ['foundation-demo', 'pr', 'release']) {
    const result = await releaseEvidence({ schemaVersion: 1, evidence: [] }, { purpose, base: sourceVersion().sha, release: false });
    assert.equal(result.ok, false); assert.equal(result.technicalPassed, false); assert.equal(result.fullAcceptance, false);
    assert.equal(result.releaseEligible, false); assert.equal(result.fullProjectAcceptance, false);
    assert.deepEqual(result.required, purpose === 'foundation-demo' ? ['relation-protocol', 'revision'] : technicalSuites);
    assert.equal(result.requirements.length, 15); assert.ok(result.requirements.every(row => row.status === 'not_run'));
    assert.equal(result.external.length, 8); assert.ok(result.external.every(row => row.status === 'not_run' && row.validator === null && row.frozenConfiguration === null));
    assert.equal(result.automaticPaidCalls, false);
    assert.deepEqual(result.historicalCapabilities.supported, ['relation-protocol', 'knowledge-protocol', 'revision']);
    assert.equal(result.historicalCapabilities.unavailable[0].suite, 'name-interval');
  }
  await assert.rejects(releaseEvidence({}, { purpose: 'skip-heavy' }));
  await assert.rejects(releaseEvidence({}, { profile: 'shallow' }));
});
test('missing, duplicate, wrong-suite and ambiguous evidence cannot become a current-source pass', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-gate-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = [{ suite: 'revision', directory }, { suite: 'revision', directory }, { suite: 'node', directory }];
  const result = await releaseEvidence({ schemaVersion: 1, evidence }, { purpose: 'foundation-demo', base: sourceVersion().sha, release: false });
  assert.equal(result.ok, false); assert.ok(result.reasons.includes('unexpected_suite_for_purpose'));
  assert.ok(result.rows.some(row => row.reasons.includes('invalid_or_duplicate_evidence_directory')));
  assert.ok(result.rows.some(row => row.suite === 'relation-protocol' && row.status === 'not_run'));
  const ambiguous = await releaseEvidence({ schemaVersion: 1, evidence: [{ suite: 'revision', directory, discoveryError: 'ambiguous_report_artifacts' }] }, { purpose: 'foundation-demo', base: sourceVersion().sha, release: false });
  assert.ok(ambiguous.rows.some(row => row.reasons.includes('ambiguous_report_artifacts')));
  await assert.rejects(readTechnicalEvidence('quality', directory));
});
test('historical reader rejects unsupported and absent evidence and binds its conservative dependency closure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'historical-gate-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual((await validateHistoricalEvidence('quality', directory)).reasons, ['historical_validator_not_registered']);
  assert.deepEqual((await validateHistoricalEvidence('name-interval', directory)).reasons, ['original_execution_origin_not_recorded']);
  assert.deepEqual((await validateHistoricalEvidence('revision', directory)).reasons, ['missing_original_report']);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ source: { sha: '0'.repeat(40), dirty: true }, ok: true }));
  assert.deepEqual((await validateHistoricalEvidence('revision', directory)).reasons, ['unclean_or_invalid_source']);
  const fast = await historicalBindings('revision', 'fast'), deep = await historicalBindings('revision', 'deep');
  assert.deepEqual(Object.keys(fast).sort(), ['configuration', 'corpus', 'environment', 'model', 'policy', 'thresholds', 'tools']);
  assert.ok(Object.values(fast).every(value => /^[0-9a-f]{64}$/.test(value))); assert.notEqual(fast.configuration, deep.configuration);
});
test('artifact discovery records all fourteen missing obligations and rejects a wrong requested source', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-manifest-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'manifest.json');
  const execution = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${file}`], { timeoutMs: 10000 });
  assert.equal(execution.code, 0, execution.tail);
  const manifest = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(manifest.evidence.map(row => row.suite), technicalSuites);
  assert.equal(manifest.evidence.filter(row => row.discoveryError === 'missing_report_artifact').length, 12);
  for (const suite of ['playback-protocol', 'scheduler', 'semantic-offline']) assert.equal(manifest.evidence.find(row => row.suite === suite).discoveryError, 'missing_report_artifact');
  const invalid = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${file}`, `--source=${'0'.repeat(40)}`], { timeoutMs: 10000 });
  assert.equal(invalid.code, 1);
});


test('aggregate independently refuses a cached ok flag with incomplete, stale or wrong-source rows', () => {
  const target = { sha: 'a'.repeat(40), dirty: false }, row = { source: target, ok: true, status: 'passed', stale: false };
  assert.equal(isCurrentTechnicalPass(row, target), true);
  for (const changed of [{ ...row, status: 'incomplete' }, { ...row, stale: true }, { ...row, source: { ...target, sha: 'b'.repeat(40) } },
    { ...row, source: { ...target, dirty: true } }, { ...row, stale: undefined }]) assert.equal(isCurrentTechnicalPass(changed, target), false);
});
