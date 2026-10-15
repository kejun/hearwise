import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { atomicitySource, stableAtomicitySources } from '../../test-support/import-atomicity-evidence.mjs';
import { upgradeVersion, validateUpgradeObservations, validateInstall, upgradeControls, hash, passedExecution } from '../../test-support/upgrade-evidence.mjs';
export function upgradeChecks(directory) {
  return [{ name: 'data', command: ['test-support/upgrade-worker.mjs', path.resolve(directory, 'observations.json')], timeoutMs: 60000 },
    { name: 'install', command: ['test-support/upgrade-install.mjs', path.resolve(directory, 'install.json')], timeoutMs: 240000 }];
}
async function inspectUpgradeReport(directory, { release = false } = {}, ciArtifact = false) {
  const reasons = [], evidence = { data: { reasons: [], artifactReasons: [] }, install: { reasons: [], artifactReasons: [] } };
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const current = await atomicitySource(), cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  const expectedDirectory = ciArtifact ? path.join(cwd, 'verification-evidence/upgrade', path.basename(directory)) : path.resolve(directory);
  if (ciArtifact) assert.match(path.basename(directory), /^run-[A-Za-z0-9]+$/, 'invalid_upgrade_run_directory');
  if (report.budgetMs !== 300000 || Date.parse(report.finishedAt) - Date.parse(report.startedAt) > 300000) reasons.push('outer_budget_mismatch');
  if (report.profile !== 'install-upgrade' || report.version !== upgradeVersion) reasons.push('wrong_profile');
  if (report.cwd !== cwd || report.directory !== expectedDirectory) reasons.push('execution_location_mismatch');
  if (!stableAtomicitySources(report.sourceStart, report.sourceEnd, release) || !stableAtomicitySources(report.sourceEnd, current, release)) reasons.push('source_missing_changed_or_dirty');
  if (!Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.finishedAt)) || report.finishedAt < report.startedAt || Date.parse(report.finishedAt) > Date.now() || report.error || report.cleanupOk !== true) reasons.push('incomplete_run');
  const artifacts = new Map();
  for (const row of report.artifacts || []) {
    try { assert.ok(row.path && !path.isAbsolute(row.path) && !row.path.split(/[\\/]/).includes('..') && !artifacts.has(row.path));
      const bytes = await readFile(path.join(directory, row.path)); assert.equal(hash(bytes), row.sha256); artifacts.set(row.path, bytes);
    } catch { (row.path?.startsWith('install') ? evidence.install : evidence.data).artifactReasons.push(`missing_changed_or_duplicate_artifact:${row.path}`); }
  }
  const checks = upgradeChecks(expectedDirectory);
  if (JSON.stringify(report.checks?.map(row => row.name)) !== JSON.stringify(checks.map(row => row.name))) reasons.push('missing_or_duplicate_check');
  try { assertSerialUpgradeChecks(report.checks); } catch { reasons.push('overlapping_or_missing_check_windows'); }
  for (const expected of checks) {
    const entry = evidence[expected.name], errors = entry.reasons, row = report.checks?.find(row => row.name === expected.name);
    entry.execution = row?.execution;
    const requiredFiles = expected.name === 'data' ? ['data.log', 'observations.json', 'controls.json'] : ['install.log', 'install.json', ...['missing-build', 'ci', 'version', 'build', 'reinstall'].map(name => `install-${name}.log`)];
    for (const file of requiredFiles) if (!artifacts.has(file)) entry.artifactReasons.push(`missing_artifact:${file}`);
    try { assert.deepEqual(row.command, [process.execPath, ...expected.command]); assert.equal(row.timeoutMs, expected.timeoutMs);
      assert.ok(row.execution.durationMs >= 0 && row.execution.durationMs <= expected.timeoutMs && row.finishedAt - row.startedAt >= row.execution.durationMs && row.finishedAt - row.startedAt <= expected.timeoutMs);
      assert.equal(row.cwd, cwd);
      assert.ok(row.startedAt >= Date.parse(report.startedAt) && row.finishedAt >= row.startedAt && row.finishedAt <= Date.parse(report.finishedAt)); assert.equal(row.log, `${expected.name}.log`);
      assert.ok(artifacts.has(row.log));
      assert.equal(row.execution.tail, artifacts.get(row.log).toString().slice(-12000));
      const raw = JSON.parse(artifacts.get(expected.name === 'data' ? 'observations.json' : 'install.json')); entry.raw = raw;
      assert.ok(passedExecution(row.execution));
      if (expected.name === 'data') {
        assert.deepEqual(raw.source, { sha: current.sha, dirty: current.dirty }); validateUpgradeObservations(raw, row);
        assert.equal(report.controlsError, undefined); assert.equal(report.controlsWriteError, undefined);
        const controls = JSON.parse(artifacts.get('controls.json')); assert.deepEqual(controls, upgradeControls(raw)); assert.ok(controls.every(row => row.rejected));
      } else {
        validateInstall(raw, current, report.environment, row);
        for (const key of ['platform', 'arch', 'node', 'sqlite']) assert.equal(report.environment[key], key === 'node' ? process.version : key === 'sqlite' ? process.versions.sqlite : process[key]);
        assert.equal(report.environment.npm, raw.environment.npm);
        assert.equal(raw.environment.npm, execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        for (const command of raw.commands) assert.equal(command.execution.tail, artifacts.get(command.log).toString().slice(-12000));
      }
    } catch (error) { errors.push(error.message); }
  }
  const rows = [
    { id: 'HW-14-02', scope: 'actual historical v1–12 preservation and continued editing', reasons: [...reasons, ...evidence.data.artifactReasons, ...evidence.data.reasons] },
    { id: 'HW-14-03', scope: 'migration SIGKILL/constraint/readonly and actual HTTP backup recovery', reasons: [...reasons, ...evidence.data.artifactReasons, ...evidence.data.reasons] },
    { id: 'HW-14-04', scope: 'isolated clean install/build/npm start/reinstall/version and missing-key diagnosis', reasons: [...reasons, ...evidence.install.artifactReasons, ...evidence.install.reasons] }
  ].map((row, index) => ({ ...row, status: upgradeCheckStatus(evidence[index === 2 ? 'install' : 'data'], reasons) }));
  const summary = { ok: rows.every(row => row.status === 'passed'), complete: rows.every(row => ['passed', 'failed'].includes(row.status)), rows,
    support: [{ environment: `${report.environment?.platform}/${report.environment?.arch}/${report.environment?.node}`, status: rows[2].status },
      { environment: 'macOS Intel/ARM, Windows, Linux ARM, other Node versions', status: 'not_run', reason: 'Not executed by this Linux x64 Node 24 profile.' },
      { environment: 'microphone, speaker, browser audio, mobile/background playback', status: 'not_run', reason: 'Install/build/HTTP success is not audio-device acceptance.' },
      { environment: 'disk-full, kernel crash, real power loss', status: 'not_run', reason: 'SIGKILL and SQLite READONLY are distinct fault classes.' }], fullProjectAcceptance: false };
  return { report, summary };
}

// Only the runner uses provisional evaluation before its final atomic write.
// Public evidence readers always require finalization and recompute the summary.
export async function evaluateUpgradeReport(directory, options) {
  return (await inspectUpgradeReport(directory, options)).summary;
}
export async function readUpgradeReport(directory, options) {
  const { report, summary } = await inspectUpgradeReport(directory, options);
  return finalizedUpgradeSummary(report, summary);
}
// This separate adapter accepts relocated CI artifacts only at the fixed origin
// used by the checked-in install-upgrade job. No report-supplied origin is trusted.
export async function readUpgradeCIReport(directory, options) {
  const { report, summary } = await inspectUpgradeReport(directory, options, true);
  return { source: { sha: report.sourceStart?.sha, dirty: report.sourceStart?.dirty }, summary: finalizedUpgradeSummary(report, summary) };
}
export function finalizedUpgradeSummary(report, summary) {
  if (report.finalized === true && report.complete === summary.complete && report.ok === summary.ok && isDeepStrictEqual(report.summary, summary)) return summary;
  return { ...summary, ok: false, complete: false,
    rows: summary.rows.map(row => ({ ...row, status: 'incomplete', reasons: [...row.reasons, 'unfinalized_or_mismatched_report'] })),
    support: summary.support.map((row, index) => index === 0 ? { ...row, status: 'incomplete' } : row) };
}

export function upgradeCheckStatus({ execution, raw, reasons = [], artifactReasons = [] }, globalReasons = []) {
  const finished = execution && [0, 1].includes(execution.code) && execution.signal === null && execution.timedOut === false && execution.interrupted === false;
  if (globalReasons.length || artifactReasons.length || !finished || !raw || raw.complete !== true) return 'incomplete';
  return execution.code === 0 && execution.ok === true && !reasons.length ? 'passed' : 'failed';
}

export function assertSerialUpgradeChecks(checks) {
  assert.equal(checks.length, 2); assert.equal(checks[0].name, 'data'); assert.equal(checks[1].name, 'install');
  assert.ok(checks[0].finishedAt <= checks[1].startedAt, 'actual data and install processes run serially');
}
