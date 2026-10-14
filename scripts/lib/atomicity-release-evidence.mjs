import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicityChecks, atomicityRegressionTap, validAtomicityCommand, validAtomicityLocations } from '../../test-support/import-atomicity-contract.mjs';
import { atomicitySource, atomicityVersion, stableAtomicitySources, validateAtomicityObservations, validateAtomicityBrowser,
  executionPassed, atomicityEvidenceControls, atomicityProperties } from '../../test-support/import-atomicity-evidence.mjs';
import { sourceVersion, digest } from './verification-evidence.mjs';
import { evidenceFiles, safeRelative } from './runner-evidence-contract.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const atomicityNestedFiles = ['observations.json', 'controls.json', 'node.log', 'regressions.log', 'browser.log', 'browser.json',
  ...['append', 'replace'].flatMap(mode => [`atomicity-${mode}-failure.png`, `atomicity-${mode}-restored.png`])];
// The caller derives origin from a checked-in invocation / separately bound outer
// runner log, never from the nested report's own cwd or output declaration.
export async function validateAtomicityReleaseContract(directory, report, { nodeOnly, repositoryRoot, evidenceDirectory, nodeExecutable }) {
  assert.equal(validAtomicityLocations(report, evidenceDirectory, repositoryRoot), true, 'atomicity_origin_mismatch');
  assert.equal(report.profile, 'import-atomicity'); assert.equal(report.version, atomicityVersion); assert.equal(report.nodeOnly, nodeOnly);
  assert.equal(report.complete, true); assert.equal(report.ok, true); assert.equal(report.cleanupOk, true);
  for (const field of ['error', 'controlsError', 'controlsWriteError']) assert.ok(!report[field]);
  assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt)));
  assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt) && Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= 180000);
  const checks = atomicityChecks(evidenceDirectory, nodeOnly); assert.deepEqual(report.checks.map(row => row.name), checks.map(row => row.name));
  const disk = new Set(await evidenceFiles(directory)), artifacts = new Map();
  for (const row of report.artifacts) {
    assert.ok(safeRelative(row.path) && disk.has(row.path) && !artifacts.has(row.path), 'invalid_atomicity_artifact');
    const bytes = await readFile(path.join(directory, row.path)); assert.equal(digest(bytes), row.sha256, 'changed_atomicity_artifact'); artifacts.set(row.path, bytes);
  }
  const expectedFiles = nodeOnly ? ['observations.json', 'controls.json', 'node.log', 'regressions.log'] : atomicityNestedFiles;
  assert.deepEqual([...artifacts.keys()].sort(), [...expectedFiles].sort(), 'atomicity_artifact_roster');
  for (const expected of checks) {
    const row = report.checks.find(value => value.name === expected.name), log = artifacts.get(row.log).toString();
    assert.equal(validAtomicityCommand(row, expected, repositoryRoot), true, 'atomicity_command_or_budget');
    assert.equal(row.command[0], nodeExecutable, 'atomicity_executable'); assert.equal(executionPassed(row.execution), true);
    assert.equal(row.execution.tail, log.slice(-12000));
    assert.ok(Number.isSafeInteger(row.execution.durationMs) && row.execution.durationMs >= 0 && row.execution.durationMs <= row.effectiveTimeoutMs + 1500);
    if (row.name === 'regressions') assert.equal(atomicityRegressionTap(log).ok, true, 'atomicity_complete_tap_body');
  }
  const elapsed = report.checks.reduce((sum, row) => sum + row.execution.durationMs, 0);
  assert.ok(elapsed <= 150000 && elapsed <= Date.parse(report.finishedAt) - Date.parse(report.startedAt), 'atomicity_sequential_budget');
  const raw = JSON.parse(artifacts.get('observations.json'));
  assert.equal(artifacts.get('node.log').toString(), raw.scenarios.map(row => `PASS ${row.id}\n`).join(''), 'atomicity_worker_log_binding');
  assert.deepEqual(raw.source, { sha: report.sourceStart.sha, dirty: report.sourceStart.dirty });
  assert.equal(validateAtomicityObservations(raw, report).ok, true, 'atomicity_raw_matrix');
  assert.deepEqual(JSON.parse(artifacts.get('controls.json')), atomicityEvidenceControls(raw), 'atomicity_actual_controls');
  let chromium;
  if (!nodeOnly) {
    const browser = JSON.parse(artifacts.get('browser.json')); chromium = browser.chromium;
    assert.deepEqual(browser.source, raw.source); assert.equal(validateAtomicityBrowser(browser, report).ok, true, 'atomicity_raw_browser');
    for (const scenario of browser.scenarios) for (const shot of scenario.screenshots) assert.equal(digest(artifacts.get(shot.path)), shot.sha256);
  }
  const expectedRows = atomicityProperties.map((id, index) => ({ id, status: nodeOnly && index === 3 ? 'not_run' : 'passed', reasons: nodeOnly && index === 3 ? ['node_only_profile'] : [] }));
  assert.deepEqual(report.summary.rows, expectedRows); assert.equal(report.summary.ok, true); assert.equal(report.summary.complete, true);
  assert.equal(report.summary.nodeOnly, nodeOnly); assert.equal(report.summary.fullImportAtomicityAcceptance, !nodeOnly); assert.equal(report.summary.fullProjectAcceptance, false);
  return { propertyRows: expectedRows, chromium };
}
async function inspect(directory, { release, nodeOnly, evidenceDirectory }) {
  const result = { kind: 'import-atomicity', source: null, ok: false, status: 'not_run', stale: false, reasons: [], fullProjectAcceptance: false,
    methods: ['actual-sqlite-http-crash-boundaries', ...(nodeOnly ? [] : ['automated-chromium'])] };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { result.reasons.push('missing_atomicity_report'); return result; }
  result.source = { sha: report.sourceStart?.sha, dirty: report.sourceStart?.dirty }; result.status = 'incomplete';
  try {
    assert.equal(stableAtomicitySources(report.sourceStart, report.sourceEnd, release), true);
    assert.equal(stableAtomicitySources(report.sourceEnd, await atomicitySource(), release), true, 'stale_atomicity_source');
    assert.deepEqual(report.tools, { node: process.version, sqlite: process.versions.sqlite });
    assert.equal(report.environment.platform, process.platform); assert.equal(report.environment.arch, process.arch); assert.ok(report.environment.release);
    const checked = await validateAtomicityReleaseContract(directory, report, { nodeOnly, repositoryRoot: process.cwd(), evidenceDirectory, nodeExecutable: process.execPath });
    return { ...result, ...checked, ok: true, status: 'passed' };
  } catch (error) { result.reasons.push(error.message); result.stale = JSON.stringify(result.source) !== JSON.stringify(sourceVersion()); return result; }
}
export function validateAtomicityReleaseEvidence(directory, { release = true } = {}) {
  const run = path.basename(directory); if (!/^run-[A-Za-z0-9]+$/.test(run)) throw new Error('invalid_atomicity_run_directory');
  return inspect(directory, { release, nodeOnly: true, evidenceDirectory: path.join(process.cwd(), 'verification-evidence/import-atomicity', run) });
}
export function validateAtomicityBrowserReleaseEvidence(directory, { release = true, outerLog, outerRun } = {}) {
  assert.match(outerRun || '', /^run-[A-Za-z0-9]+$/); const run = path.basename(directory); assert.match(run, /^run-[A-Za-z0-9]+$/);
  const expected = path.join('browser-evidence', outerRun, run), matches = [...(outerLog || '').matchAll(/^Import atomicity evidence: (.+)$/gm)];
  assert.equal(matches.length, 1, 'atomicity_outer_origin_missing'); assert.equal(matches[0][1], expected, 'atomicity_outer_origin_mismatch');
  assert.equal(outerLog.split(/\r?\n/, 1)[0], `Import atomicity evidence: ${expected}`, 'atomicity_outer_origin_not_first');
  return inspect(directory, { release, nodeOnly: false, evidenceDirectory: path.join(process.cwd(), expected) });
}
