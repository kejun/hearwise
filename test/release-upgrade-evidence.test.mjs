import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';
import { validateUpgradeReleaseEvidence } from '../scripts/lib/upgrade-release-evidence.mjs';
import { technicalSuites, purposes, budgets, domainSuites } from '../verification/release/policy.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
test('upgrade is a mandatory scoped technical slot without closing external platform acceptance', () => {
  for (const suites of [technicalSuites, purposes.pr, purposes.release]) assert.equal(suites.filter(name => name === 'install-upgrade').length, 1);
  assert.equal(technicalSuites.length, 17);
  assert.deepEqual(budgets['install-upgrade'], { overallMs: 300000, dataMs: 60000, installMs: 240000 });
  for (const domain of ['HW-09', 'HW-10', 'HW-14']) assert.ok(domainSuites[domain].includes('install-upgrade'));
});
test('upgrade release adapter refuses absent, malformed and unfinalized envelopes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-upgrade-missing-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run-contract'); await mkdir(directory);
  const missing = await readTechnicalEvidence('install-upgrade', directory, { release: false });
  assert.equal(missing.status, 'not_run'); assert.equal(missing.ok, false); assert.equal(missing.fullProjectAcceptance, false);
  for (const text of ['{bad', JSON.stringify({ complete: true, ok: true, finalized: true }), JSON.stringify({ complete: false, ok: false })]) {
    await writeFile(path.join(directory, 'report.json'), text);
    const result = await validateUpgradeReleaseEvidence(directory, { release: false });
    assert.equal(result.ok, false); assert.equal(result.status, 'incomplete'); assert.equal(result.fullProjectAcceptance, false);
  }
});
test('upgrade artifact discovery includes every attempt and the dedicated job is a release dependency', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-upgrade-discovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, `install-upgrade-evidence-${sourceVersion().sha}`), output = path.join(directory, 'manifest.json');
  for (const count of [0, 1, 2]) {
    if (count) { const candidate = path.join(artifact, `run-${count}`); await mkdir(candidate, { recursive: true }); await json(path.join(candidate, 'report.json'), { profile: 'install-upgrade' }); }
    const execution = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
    assert.equal(execution.ok, true, execution.tail); const manifest = JSON.parse(await readFile(output)), row = manifest.evidence.find(row => row.suite === 'install-upgrade');
    assert.equal(manifest.evidence.length, 17);
    if (count === 1) { assert.equal(row.discoveryError, undefined); assert.equal(row.directory, path.join(artifact, 'run-1')); }
    else assert.equal(row.discoveryError, count ? 'ambiguous_report_artifacts' : 'missing_report_artifact');
  }
  await writeFile(path.join(artifact, 'run-2/report.json'), '{malformed');
  const execution = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
  assert.equal(execution.ok, true, execution.tail);
  assert.equal(JSON.parse(await readFile(output)).evidence.find(row => row.suite === 'install-upgrade').discoveryError, 'ambiguous_report_artifacts');
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8'), releaseJob = workflow.slice(workflow.indexOf('  release-evidence:'), workflow.indexOf('  install-upgrade:'));
  assert.match(releaseJob, /needs: \[[^\]\n]*install-upgrade\]/);
  assert.match(workflow.slice(workflow.indexOf('  install-upgrade:')), /npm run verify:upgrade -- --release/);
});
