import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { technicalSuites, purposes } from '../verification/release/policy.mjs';
import { browserChecks, browserScreenshots } from '../scripts/lib/runner-evidence-contract.mjs';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';
test('current main crash recovery and offline infrastructure reports are mandatory technical evidence', () => {
  for (const suite of ['process-crash', 'quality-offline']) {
    assert.ok(technicalSuites.includes(suite), suite); assert.ok(purposes.pr.includes(suite)); assert.ok(purposes.release.includes(suite));
  }
});
test('current main Trace business browser profile cannot disappear behind the older roster', () => {
  assert.equal(browserChecks.filter(name => name === 'trace-business').length, 1);
  assert.deepEqual(browserScreenshots['trace-business'], ['trace-business-desktop.png', 'trace-business-mobile.png', 'trace-business-incomplete.png']);
  assert.equal(browserChecks.length, 19);
});
for (const suite of ['process-crash', 'quality-offline']) test(`${suite} missing raw evidence cannot pass`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-current-main-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await readTechnicalEvidence(suite, directory, { release: false }); assert.equal(result.ok, false); assert.equal(result.status, 'not_run');
});
test('process crash commands preserve the recorded evidence cwd and exact fixed regression files', async () => {
  const { formalCommandContract } = await import('../scripts/lib/formal-release-evidence.mjs');
  const { processEvidenceDefinition } = await import('../scripts/lib/process-crash-evidence.mjs');
  const { processRegressionContract } = await import('../scripts/lib/process-release-evidence.mjs');
  const root = '/portable/source', directory = '/portable/evidence/run-tests';
  const report = { profile: 'fast', overallTimeoutMs: 480000, tools: { node: process.version, sqlite: process.versions.sqlite },
    executionContext: { repositoryRoot: root, evidenceDirectory: directory, quintCli: root + '/node_modules/@informalsystems/quint/dist/src/cli.js', overallTimeoutMs: 480000, jvmArgs: '-Xmx2G' },
    results: [{ id: 'implementation-regressions', kind: 'implementation-regression', timeoutMs: 60000, expectedFailure: false, execution: { code: 0, ok: true }, cwd: directory,
      argv: ['--test', '--test-reporter=tap', '--test-timeout=30000', ...processRegressionContract.files.map(file => root + '/' + file)] }] };
  assert.equal(await formalCommandContract('process-crash', report, processEvidenceDefinition, processRegressionContract), true);
  for (const mutate of [r => { r.results[0].cwd = root; }, r => { r.results[0].argv.pop(); }, r => { r.results[0].timeoutMs = 120000; }, r => { r.overallTimeoutMs = 1; }]) {
    const changed = structuredClone(report); mutate(changed); await assert.rejects(formalCommandContract('process-crash', changed, processEvidenceDefinition, processRegressionContract));
  }
});
