import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicityChecks, atomicityRegressionTap, validAtomicityCommand, validAtomicityLocations } from '../../test-support/import-atomicity-contract.mjs';
import { atomicitySource, atomicityVersion, hash, stableAtomicitySources, validateAtomicityObservations, validateAtomicityBrowser, executionPassed, atomicityEvidenceControls, atomicityMatrixComplete } from '../../test-support/import-atomicity-evidence.mjs';

export async function readAtomicityReport(directory, { release = false, nodeOnly = false } = {}) {
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const reasons = [], nodeArtifactReasons = [], browserArtifactReasons = [], artifacts = new Map();
  const artifactReasons = file => /^browser\.(?:json|log)$|^atomicity-.*\.png$/.test(file) ? browserArtifactReasons : nodeArtifactReasons;
  if (report.profile !== 'import-atomicity' || report.version !== atomicityVersion || report.nodeOnly !== nodeOnly) reasons.push('wrong_profile');
  if (report.error) reasons.push('runner_error');
  const checkNames = (report.checks || []).map(row => row.name);
  if (JSON.stringify(checkNames.filter(name => ['node', 'regressions'].includes(name))) !== JSON.stringify(['node', 'regressions'])) nodeArtifactReasons.push('missing_or_duplicate_node_check');
  if (!nodeOnly && checkNames.filter(name => name === 'browser').length !== 1) browserArtifactReasons.push('missing_or_duplicate_browser_check');
  if (checkNames.some(name => !['node', 'regressions', ...(!nodeOnly ? ['browser'] : [])].includes(name))) reasons.push('unexpected_check');
  const current = await atomicitySource();
  if (!stableAtomicitySources(report.sourceStart, report.sourceEnd, release) || !stableAtomicitySources(report.sourceEnd, current, release)) reasons.push('source_missing_changed_or_uncommitted');
  if (!Number.isFinite(Date.parse(report.finishedAt)) || !Number.isFinite(Date.parse(report.startedAt)) || Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
    !report.tools?.node || !report.tools?.sqlite || !report.environment?.platform || report.cleanupOk !== true) reasons.push('execution_metadata_or_cleanup_missing');
  for (const artifact of report.artifacts || []) {
    if (!artifact.path || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || artifacts.has(artifact.path)) { reasons.push('invalid_artifact'); continue; }
    try {
      const bytes = await readFile(path.join(directory, artifact.path));
      if (hash(bytes) !== artifact.sha256) artifactReasons(artifact.path).push(`changed_artifact:${artifact.path}`); else artifacts.set(artifact.path, bytes);
    } catch { artifactReasons(artifact.path).push(`missing_artifact:${artifact.path}`); }
  }
  const check = name => {
    const rows = (report.checks || []).filter(row => row.name === name);
    return rows.length === 1 ? rows[0] : null;
  };
  const cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  const expectedChecks = atomicityChecks(path.resolve(directory), nodeOnly);
  if (!validAtomicityLocations(report, directory, cwd)) reasons.push('execution_location_mismatch');
  for (const expected of expectedChecks) {
    const actual = check(expected.name);
    if (!validAtomicityCommand(actual, expected, cwd)) (expected.name === 'browser' ? browserArtifactReasons : nodeArtifactReasons).push(`command_or_budget_mismatch:${expected.name}`);
    const log = artifacts.get(`${expected.name}.log`);
    if (log && actual?.execution.tail !== log.toString().slice(-12000)) (expected.name === 'browser' ? browserArtifactReasons : nodeArtifactReasons).push(`log_tail_mismatch:${expected.name}`);
  }
  const node = check('node'), regressions = check('regressions'), browserCheck = check('browser');
  let raw, nodeValidation = { ok: false, reasons: ['observations_missing'] };
  try { raw = JSON.parse(artifacts.get('observations.json')); nodeValidation = validateAtomicityObservations(raw, report);
    if (!isDeepStrictEqual(raw.source, { sha: report.sourceStart.sha, dirty: report.sourceStart.dirty })) nodeValidation = { ok: false, reasons: ['runtime_source_mismatch'] }; } catch { /* fail closed */ }
  let controlsValid = false;
  const controlsReasons = [];
  if (!artifacts.has('controls.json')) nodeArtifactReasons.push('controls_artifact_missing');
  try {
    const controls = JSON.parse(artifacts.get('controls.json'));
    controlsValid = !report.controlsError && Array.isArray(controls) && controls.every(row => row.rejected === true) && isDeepStrictEqual(controls, atomicityEvidenceControls(raw));
  } catch { /* Real-evidence negative controls are required. */ }
  if (!controlsValid) controlsReasons.push(report.controlsError ? `controls_failed:${report.controlsError.name}: ${report.controlsError.message}` : 'controls_missing_or_invalid');
  if (report.controlsWriteError) controlsReasons.push(`controls_write_failed:${report.controlsWriteError.name}: ${report.controlsWriteError.message}`);
  const tap = atomicityRegressionTap(artifacts.get('regressions.log')?.toString() || '');
  const nodeOk = executionPassed(node?.execution) && artifacts.has('node.log') && nodeValidation.ok && controlsValid && executionPassed(regressions?.execution) && tap.ok;
  const finished = value => [0, 1].includes(value?.code) && value.signal === null && value.timedOut === false && value.interrupted === false;
  const nodeComplete = Boolean(finished(node?.execution) && finished(regressions?.execution) && atomicityMatrixComplete(raw) && tap.testComplete && tap.bodiesComplete);
  if (!tap.bodiesComplete) nodeArtifactReasons.push('regression_body_incomplete');
  let browser, browserValidation = { ok: false, reasons: ['browser_not_run'] };
  if (!report.nodeOnly) {
    try {
      browser = JSON.parse(artifacts.get('browser.json')); browserValidation = validateAtomicityBrowser(browser, report);
      if (!isDeepStrictEqual(browser.source, { sha: report.sourceStart.sha, dirty: report.sourceStart.dirty })) browserValidation = { ok: false, reasons: ['runtime_source_mismatch'] };
      for (const row of browser.scenarios) for (const screenshot of row.screenshots) {
        if (!artifacts.has(screenshot.path) || hash(artifacts.get(screenshot.path)) !== screenshot.sha256) browserValidation = { ok: false, reasons: ['screenshot_missing_or_changed'] };
      }
    } catch { browserValidation = { ok: false, reasons: ['browser_missing'] }; }
  }
  const browserOk = !report.nodeOnly && executionPassed(browserCheck?.execution) && artifacts.has('browser.log') && browserValidation.ok;
  const rows = atomicityPropertyRows({ nodeOnly: report.nodeOnly, reasons,
    node: { complete: nodeComplete, ok: nodeOk, artifactReasons: nodeArtifactReasons, reasons: [...nodeValidation.reasons, ...controlsReasons] },
    browser: { complete: Boolean(browser && finished(browserCheck?.execution)), ok: browserOk, artifactReasons: browserArtifactReasons, reasons: browserValidation.reasons } });
  const required = report.nodeOnly ? rows.slice(0, 3) : rows;
  return { complete: required.every(row => !['not_run', 'incomplete'].includes(row.status)), ok: required.every(row => row.status === 'passed'),
    nodeOnly: report.nodeOnly, fullImportAtomicityAcceptance: !report.nodeOnly && rows.every(row => row.status === 'passed'), fullProjectAcceptance: false, rows };
}

export function atomicityPropertyRows({ nodeOnly, reasons, node, browser }) {
  const row = (id, evidence) => ({ id,
    status: reasons.length || evidence.artifactReasons.length || !evidence.complete ? 'incomplete' : evidence.ok ? 'passed' : 'failed',
    reasons: [...reasons, ...evidence.artifactReasons, ...(!evidence.ok ? evidence.reasons : [])] });
  return [...['HW-09-06', 'HW-09-07', 'HW-09-08'].map(id => row(id, node)),
    nodeOnly ? { id: 'HW-09-09', status: 'not_run', reasons: ['node_only_profile'] } : row('HW-09-09', browser)];
}
