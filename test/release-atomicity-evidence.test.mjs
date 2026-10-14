import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicityReleaseFixture } from '../test-support/release-atomicity-fixture.mjs';
import { validateAtomicityReleaseEvidence, validateAtomicityBrowserReleaseEvidence } from '../scripts/lib/atomicity-release-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { testExecutionPlan } from '../scripts/lib/test-schedule.mjs';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';
import { digest, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { technicalSuites, purposes, domainSuites } from '../verification/release/policy.mjs';
import { browserChecks } from '../scripts/lib/runner-evidence-contract.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
test('atomicity release adapter preserves actual matrices, complete TAP and independently derived execution origin', { timeout: 80000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-atomicity-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run-contract'), { report } = await atomicityReleaseFixture(directory, { nodeOnly: true });
  assert.equal((await validateAtomicityReleaseEvidence(directory, { release: false })).ok, true);
  assert.equal(technicalSuites.filter(name => name === 'import-atomicity').length, 1); assert.equal(browserChecks.filter(name => name === 'import-atomicity').length, 1);
  for (const mutate of [r => { r.cwd = '/tmp/elsewhere'; r.checks.forEach(c => { c.cwd = r.cwd; }); },
    r => { const old = r.evidenceDirectory; r.evidenceDirectory = '/tmp/forged/run-contract'; r.checks.forEach(c => { c.command = c.command.map(v => v.replace(old, r.evidenceDirectory)); }); },
    r => { r.checks[0].command[0] = '/tmp/node'; }, r => { r.checks[1].command.pop(); }, r => { r.checks[0].execution.timedOut = true; },
    r => { r.checks[0].execution.code = 1; }, r => { r.checks[0].execution.signal = 'SIGTERM'; },
    r => { r.checks[0].execution.interrupted = true; }, r => { r.controlsError = { message: 'failed control' }; },
    r => { r.controlsWriteError = { message: 'failed write' }; }, r => { r.artifacts[0].sha256 = '0'.repeat(64); },
    r => { r.checks[0].effectiveTimeoutMs = 55001; }, r => { r.checks[0].execution.durationMs = 56501; },
    r => { r.finishedAt = new Date(Date.parse(r.startedAt) + 180001).toISOString(); },
    r => { r.checks.forEach(c => { c.execution.durationMs = 1000; }); r.finishedAt = new Date(Date.parse(r.startedAt) + 100).toISOString(); }]) {
    const changed = structuredClone(report); mutate(changed); await json(path.join(directory, 'report.json'), changed);
    assert.equal((await validateAtomicityReleaseEvidence(directory, { release: false })).ok, false);
  }
  for (const [file, mutate] of [['observations.json', r => { r.scenarios.pop(); }], ['observations.json', r => { r.scenarios.find(row => row.runtimes?.length).runtimes[0].diagnostics.build.git_sha = '0'.repeat(40); }], ['controls.json', r => { r.pop(); }], ['regressions.log', s => s.slice(s.lastIndexOf('1..'))]]) {
    const location = path.join(directory, file), bytes = await readFile(location), value = file.endsWith('.json') ? JSON.parse(bytes) : bytes.toString();
    const output = mutate(value) ?? value, changed = structuredClone(report), replacement = typeof output === 'string' ? output : JSON.stringify(output);
    await writeFile(location, replacement); changed.artifacts.find(r => r.path === file).sha256 = digest(replacement);
    if (file.endsWith('.log')) changed.checks.find(c => c.log === file).execution.tail = replacement.slice(-12000);
    await json(path.join(directory, 'report.json'), changed); assert.equal((await validateAtomicityReleaseEvidence(directory, { release: false })).ok, false, file);
    await writeFile(location, bytes);
  }
});
test('atomicity browser release adapter binds its separately recorded outer origin and genuine HTTP SQLite observations', { timeout: 80000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-atomicity-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run-contract'), fixture = await atomicityReleaseFixture(directory);
  const options = { release: false, outerRun: 'run-contract', outerLog: fixture.outerLog,
    outerOrigin: { repositoryRoot: process.cwd(), nodeExecutable: process.execPath, evidenceDirectory: 'browser-evidence/run-contract' } };
  assert.equal((await validateAtomicityBrowserReleaseEvidence(directory, options)).ok, true);
  for (const outerLog of ['', fixture.outerLog + fixture.outerLog, 'unrelated prefix\n' + fixture.outerLog, fixture.outerLog.replace('browser-evidence', '/tmp/other')]) await assert.rejects(async () => validateAtomicityBrowserReleaseEvidence(directory, { ...options, outerLog }));
  for (const evidenceDirectory of [undefined, '', '/forged/run-contract', 'browser-evidence/run-other', 'browser-evidence/../run-contract'])
    await assert.rejects(async () => validateAtomicityBrowserReleaseEvidence(directory, { ...options, outerOrigin: { ...options.outerOrigin, evidenceDirectory } }));
  for (const forgery of [{ repositoryRoot: '/forged/checkout' }, { nodeExecutable: '/forged/node' }, { repositoryRoot: '/forged/checkout', nodeExecutable: '/forged/node' }]) {
    const outerOrigin = { ...options.outerOrigin, ...forgery }, changed = structuredClone(fixture.report), previous = changed.evidenceDirectory;
    changed.cwd = outerOrigin.repositoryRoot; changed.evidenceDirectory = path.resolve(outerOrigin.repositoryRoot, outerOrigin.evidenceDirectory, path.basename(directory));
    for (const check of changed.checks) { check.cwd = changed.cwd; check.command = check.command.map(value => value.replace(previous, changed.evidenceDirectory)); check.command[0] = outerOrigin.nodeExecutable; }
    await json(path.join(directory, 'report.json'), changed);
    await assert.rejects(async () => validateAtomicityBrowserReleaseEvidence(directory, { ...options, outerOrigin }), /atomicity_outer_(repository|executable)/);
  }
  for (const mutate of [r => { r.summary.fullImportAtomicityAcceptance = false; }, r => { r.nodeOnly = true; },
    r => { r.checks.forEach(c => { c.execution.durationMs = 51000; }); r.finishedAt = new Date(Date.parse(r.startedAt) + 170000).toISOString(); }]) {
    const changed = structuredClone(fixture.report); mutate(changed); await json(path.join(directory, 'report.json'), changed);
    assert.equal((await validateAtomicityBrowserReleaseEvidence(directory, options)).ok, false);
  }
  const report = structuredClone(fixture.report), browser = structuredClone(fixture.browser); browser.scenarios[0].failureEvents = [];
  const bytes = JSON.stringify(browser); await writeFile(path.join(directory, 'browser.json'), bytes); report.artifacts.find(r => r.path === 'browser.json').sha256 = digest(bytes); await json(path.join(directory, 'report.json'), report);
  assert.equal((await validateAtomicityBrowserReleaseEvidence(directory, options)).ok, false);
});

test('atomicity release discovery requires one existing Node artifact attempt and preserves collector scheduling budgets', async t => {
  for (const suites of [technicalSuites, purposes.pr, purposes.release]) assert.equal(suites.filter(name => name === 'import-atomicity').length, 1);
  assert.ok(domainSuites['HW-09'].includes('import-atomicity')); assert.equal(technicalSuites.length, 18);
  for (const file of ['test/release-atomicity-evidence.test.mjs', 'test/runner-report-evidence.test.mjs'])
    assert.deepEqual(testExecutionPlan(file), { exclusive: true, timeoutMs: 90000 });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-atomicity-discovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = await readTechnicalEvidence('import-atomicity', path.join(directory, 'run-missing'), { release: false });
  assert.equal(missing.ok, false); assert.equal(missing.status, 'not_run');
  const artifact = path.join(directory, `test-evidence-${sourceVersion().sha}`, 'verification-evidence/import-atomicity'), output = path.join(directory, 'manifest.json');
  for (const count of [0, 1, 2]) {
    if (count) { const candidate = path.join(artifact, `run-${count}`); await mkdir(candidate, { recursive: true }); await json(path.join(candidate, 'report.json'), { profile: 'import-atomicity', nodeOnly: true }); }
    const execution = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
    assert.equal(execution.ok, true, execution.tail); const manifest = JSON.parse(await readFile(output)), row = manifest.evidence.find(row => row.suite === 'import-atomicity');
    assert.equal(manifest.evidence.length, 18);
    if (count === 1) { assert.equal(row.discoveryError, undefined); assert.equal(row.directory, path.join(artifact, 'run-1')); }
    else assert.equal(row.discoveryError, count ? 'ambiguous_report_artifacts' : 'missing_report_artifact');
  }
  await writeFile(path.join(artifact, 'run-2/report.json'), '{malformed');
  const execution = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
  assert.equal(execution.ok, true, execution.tail);
  assert.equal(JSON.parse(await readFile(output)).evidence.find(row => row.suite === 'import-atomicity').discoveryError, 'ambiguous_report_artifacts');
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  relation-protocol:')), /npm run verify:import-atomicity -- --node-only --release/);
});
