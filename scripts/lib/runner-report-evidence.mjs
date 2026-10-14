import { validatePlaybackBrowserReleaseEvidence, playbackNestedFiles } from './playback-release-evidence.mjs';
import { validateTraceReleaseEvidence, traceNestedFiles } from './trace-release-evidence.mjs';
import { validateNewNestedBrowserEvidence, newNestedChecks } from './new-browser-release-evidence.mjs';
import { validateImportBrowserReleaseEvidence } from './import-browser-release-evidence.mjs';
import { nodeTestArgv, validateNodeTestEvents, validateNodeTestSchedule } from './node-test-evidence.mjs';
import { testExecutionPlan } from './test-schedule.mjs';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion, checkArtifacts } from './verification-evidence.mjs';
import { tapSummary } from './tap-summary.mjs';
import { browserChecks, browserScreenshots, findNodeTests, sourceSnapshot, sameSourceSnapshot, validBuildSource, safeRelative, evidenceFiles } from './runner-evidence-contract.mjs';
import { sessionProfile } from '../../verification/session-properties.mjs';
import { relationResultProfile } from '../../verification/relation-result-properties.mjs';
import { summarizeSessionResults } from '../../test-support/session-evidence.mjs';
import { summarizeRelationResults, checkRelationResultEvidence } from '../../test-support/relation-result-evidence.mjs';
import { resultScenarios } from '../../test-support/relation-result-fixture.mjs';

const passed = row => row?.code === 0 && row.signal === null && row.timedOut === false && row.interrupted === false && row.ok === true && !row.error;
const complete = row => Number.isInteger(row?.code) && row.signal === null && row.timedOut === false && row.interrupted === false;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
function verdict(kind, target) { return { kind, ok: false, status: 'not_run', stale: false, reasons: [], source: null, target,
  methods: [kind === 'browser' ? 'automated-chromium-stub-provider' : 'node-implementation-regression'], scope: {}, fullProjectAcceptance: false }; }
async function header(kind, directory, release) {
  const result = verdict(kind, sourceVersion()); let report;
  try { report = await readJson(path.join(directory, 'results.json')); } catch { result.reasons.push('missing_or_invalid_report'); return { result }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) { result.reasons.push('invalid_report'); return { result }; }
  result.source = { sha: report.sha, dirty: report.dirty }; result.status = 'incomplete';
  if (report.schemaVersion !== 2 || !Array.isArray(report.results) || report.complete !== true) result.reasons.push('incomplete_aggregate');
  if (report.sha !== result.target.sha || report.dirty !== result.target.dirty) { result.stale = true; result.reasons.push('source_changed'); }
  if (release && (report.dirty !== false || result.target.dirty !== false)) result.reasons.push('uncommitted_source');
  if (!validBuildSource(report.sourceStart) || !validBuildSource(report.sourceEnd)) result.reasons.push('stale_or_invalid_runtime_build');
  if (!sameSourceSnapshot(report.sourceStart, report.sourceEnd)) result.reasons.push('source_changed_during_execution');
  if (!isDeepStrictEqual(report.sourceStart?.source, result.source)) result.reasons.push('source_header_mismatch');
  try { if (!sameSourceSnapshot(report.sourceEnd, await sourceSnapshot())) { result.stale = true; result.reasons.push('source_or_build_digest_changed'); } }
  catch { result.reasons.push('missing_source_or_build'); }
  if (!/^v24\./.test(process.version) || report.tools?.node !== process.version || report.tools?.sqlite !== process.versions.sqlite ||
      !['platform', 'arch', 'release'].every(key => typeof report.environment?.[key] === 'string' && report.environment[key])) result.reasons.push('missing_tools_or_environment');
  result.tools = report.tools; result.environment = report.environment;
  return { result, report };
}
function finish(result, statuses) {
  result.status = statuses.includes('incomplete') ? 'incomplete' : statuses.includes('failed') ? 'failed' : 'passed';
  if (result.reasons.length && result.status === 'passed' && !result.reasons.every(reason => ['source_changed', 'source_or_build_digest_changed', 'uncommitted_source'].includes(reason))) result.status = 'incomplete';
  result.ok = result.status === 'passed' && !result.stale && !result.reasons.length; return result;
}
export async function validateNodeEvidence(directory, { release = true } = {}) {
  const { result, report } = await header('node', directory, release); if (!report) return result;
  const expected = await findNodeTests(), rows = Array.isArray(report.results) ? report.results : [], statuses = [];
  if (!isDeepStrictEqual(rows.map(row => row?.file).sort(), expected) || report.selected !== expected.length || report.passed !== expected.length) result.reasons.push('missing_duplicate_or_unexpected_test_file');
  result.scope = { testFiles: expected, allDiscoveredFilesRequired: true, concurrency: 4, individualTestMs: 30000, executionPlan: Object.fromEntries(expected.map(file => [file, testExecutionPlan(file)])) };
  try { validateNodeTestSchedule(rows, expected); } catch (error) { result.reasons.push(error.message); statuses.push('incomplete'); }
  result.testRows = [];
  for (const row of rows) {
    const item = { file: row?.file, status: 'incomplete' };
    try {
      if (!expected.includes(row.file) || typeof row.log !== 'string') throw new Error('unknown_test_file');
      const logName = row.file.replaceAll(/[\\/]/g, '_') + '.log';
      if (path.basename(row.log) !== logName || !(await lstat(path.join(directory, logName))).isFile()) throw new Error('invalid_test_log_path');
      const bytes = await readFile(path.join(directory, logName)); if (digest(bytes) !== row.logSha256) throw new Error('changed_test_log');
      if (row.tail !== bytes.toString('utf8').slice(-12000) || !isDeepStrictEqual(row.argv, nodeTestArgv(row.file, row.events))) throw new Error('test_execution_binding');
      if (typeof row.events !== 'string' || path.basename(row.events) !== logName + '.events.ndjson' || !(await lstat(path.join(directory, path.basename(row.events)))).isFile()) throw new Error('invalid_native_events_path');
      const eventBytes = await readFile(path.join(directory, path.basename(row.events)));
      if (digest(eventBytes) !== row.eventsSha256) throw new Error('changed_native_events');
      validateNodeTestEvents(bytes.toString('utf8'), eventBytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)), { entry: row.file, repositoryRoot: report.executionRepositoryRoot, sourceFiles: Object.keys(report.sourceStart.digests) });
      const tap = tapSummary(bytes.toString('utf8'));
      item.tests = tap.testCount;
      item.status = !complete(row) || !tap.testComplete ? 'incomplete' : passed(row) && tap.ok ? 'passed' : 'failed';
    } catch (error) { item.reason = error.message; }
    if (item.status !== 'passed') result.reasons.push(`test:${item.file}:${item.reason || item.status}`);
    statuses.push(item.status); result.testRows.push(item);
  }
  return finish(result, statuses.length ? statuses : ['incomplete']);
}
const nestedCounts = { session: { 'identity-and-source': 6, 'caption-frontier': 53 }, 'relation-result': { 'source-integrity': 100, 'http-results': 1 } };
function validBrowserObservations(kind, browser) {
  if (browser?.complete !== true || typeof browser.chromium !== 'string' || !browser.chromium || browser.widths?.length !== 2) return false;
  for (const width of [1280, 390]) {
    const matches = browser.widths.filter(row => row.width === width); if (matches.length !== 1) return false;
    const row = matches[0];
    if (kind === 'session') {
      if (!['permissionRejected', 'keyboardRecovery', 'stopTail', 'duplicateFinalIdentity', 'conflictingFinalPreserved', 'oldSocketIgnored', 'microphoneReleased'].every(key => row[key] === true) || row.reconnectRuns !== 2) return false;
      if (!isDeepStrictEqual(row.first?.segments?.map(segment => segment.original_text), ['Rain 😀.', 'Stop tail 😀.', 'Reconnected run.']) ||
          !isDeepStrictEqual(row.next?.segments?.map(segment => segment.original_text), ['New listening.', 'Stop tail 😀.']) ||
          row.first?.runs?.length !== 2 || row.first.runs.at(-1).state !== 'interrupted' || row.first.segments[0].run_id === row.first.segments[2].run_id) return false;
    } else {
      if (!Array.isArray(row.errors) || row.errors.length || row.results?.length !== resultScenarios.length) return false;
      for (const scenario of resultScenarios) {
        const found = row.results.filter(item => item.scenario === scenario.name); if (found.length !== 1) return false;
        const item = found[0];
        if (item.state !== scenario.state || item.nodes !== scenario.nodes || item.edges !== scenario.edges || item.providerRequests !== scenario.requests || !Array.isArray(item.supports)) return false;
      }
    }
  }
  if (kind === 'session') {
    const value = browser.sourceVersion;
    if (typeof value?.before !== 'string' || typeof value?.after !== 'string' || value.before === value.after || typeof value.oldRequest !== 'string' ||
        typeof value.newRequest !== 'string' || value.oldRequest === value.newRequest || value.persisted?.original_text !== value.newRequest ||
        value.persisted?.translation_text !== '新版本有效译文 😀' || value.persisted?.translation_state !== 'complete' || value.visibleText !== true) return false;
  }
  return true;
}
export async function validateNestedBrowserEvidence(kind, directory, { release = true } = {}) {
  if (kind === 'playback') return validatePlaybackBrowserReleaseEvidence(directory, { release });
  if (kind === 'trace-business') return validateTraceReleaseEvidence(directory, { release });
  if (kind === 'import-protocol') return validateImportBrowserReleaseEvidence(directory, { release });
  if (Object.hasOwn(newNestedChecks, kind)) return validateNewNestedBrowserEvidence(kind, directory, { release });
  const reasons = [], required = kind === 'session' ? sessionProfile : relationResultProfile;
  if (!Object.hasOwn(nestedCounts, kind)) throw new Error('Unknown nested browser profile');
  let report, observations;
  try { report = await readJson(path.join(directory, 'report.json')); observations = await readJson(path.join(directory, 'observations.json')); }
  catch { return { ok: false, kind, status: 'not_run', reasons: ['missing_nested_report'] }; }
  try {
    if (report.profile !== kind || report.complete !== true || !Array.isArray(report.results) || report.results.length !== required.length) throw new Error('incomplete_nested_profile');
    const names = [...Object.keys(nestedCounts[kind]), 'browser'];
    if (!isDeepStrictEqual(observations.checks?.map(check => check.name), names)) throw new Error('missing_or_duplicate_nested_execution');
    const logs = [];
    for (const check of observations.checks) {
      const log = await readFile(path.join(directory, `${check.name}.log`), 'utf8'); logs.push(`CHECK ${check.name}\n${log}`);
      if (check.execution?.tail !== log.slice(-12000)) throw new Error(`nested_execution_log:${check.name}`);
      if (!passed(check.execution)) throw new Error(`nested_execution:${check.name}`);
      if (check.name !== 'browser') {
        const tap = tapSummary(log);
        if (!tap.ok || tap.testCount !== nestedCounts[kind][check.name] || check.execution.testCount !== tap.testCount || check.execution.testComplete !== true) throw new Error(`nested_raw_tap:${check.name}`);
      }
    }
    if (logs.join('\n') !== await readFile(path.join(directory, 'worker.log'), 'utf8')) throw new Error('nested_log_binding');
    if (!isDeepStrictEqual(observations.browser, await readJson(path.join(directory, 'browser.json'))) || !validBrowserObservations(kind, observations.browser)) throw new Error('nested_browser_observations');
    const target = sourceVersion(), summarize = kind === 'session' ? summarizeSessionResults : summarizeRelationResults;
    const artifactsValid = await Promise.all(report.results.map(row => kind === 'session' ? checkArtifacts(directory, row) : checkRelationResultEvidence(directory, row)));
    const { execution, summary } = summarize({ results: report.results, target, checks: observations.checks, nodeOnly: false,
      required, sourceStable: report.source?.sha === target.sha && report.source?.dirty === target.dirty, release, artifactsValid });
    if (!summary.ok || !isDeepStrictEqual(execution, report.execution)) throw new Error('nested_gate_rejected');
    return { ok: true, kind, status: 'passed', reasons, propertyRows: summary.rows, chromium: observations.browser.chromium };
  } catch (error) { return { ok: false, kind, status: 'incomplete', reasons: [error.message] }; }
}
export async function validateBrowserEvidence(directory, { release = true } = {}) {
  const { result, report } = await header('browser', directory, release); if (!report) return result;
  const rows = Array.isArray(report.results) ? report.results : [], statuses = rows.map(row => !complete(row) ? 'incomplete' : passed(row) ? 'passed' : 'failed');
  result.scope = { checks: browserChecks, widths: [1280, 390], profileWatchdogMs: 180000, providers: 'local stubs; no paid quality or physical-device acceptance' };
  if (!isDeepStrictEqual(rows.map(row => row?.name), browserChecks)) result.reasons.push('missing_duplicate_or_unexpected_browser_check');
  if (statuses.some(status => status !== 'passed')) result.reasons.push('browser_execution_not_passed');
  const files = new Map();
  try {
    const diskPaths = new Set(await evidenceFiles(directory));
    if (!Array.isArray(report.artifacts) || !report.artifacts.length) throw new Error('missing_browser_artifacts');
    for (const artifact of report.artifacts) {
      if (!safeRelative(artifact?.path) || files.has(artifact.path) || !diskPaths.has(artifact.path)) throw new Error('invalid_or_missing_browser_artifact');
      const bytes = await readFile(path.join(directory, artifact.path)); if (digest(bytes) !== artifact.sha256) throw new Error('changed_browser_artifact');
      files.set(artifact.path, bytes);
    }
    const run = path.basename(report.evidenceDirectory || ''); if (!/^run-[A-Za-z0-9]+$/.test(run)) throw new Error('invalid_browser_run_directory');
    for (const name of browserChecks) {
      const log = `${run}/${name}.log`;
      const row = rows.find(row => row.name === name);
      if (!files.has(log) || path.basename(row?.log || '') !== `${name}.log`) throw new Error(`missing_browser_log:${name}`);
      if (row.tail !== files.get(log).toString('utf8').slice(-12000) || !isDeepStrictEqual(row.argv, [`scripts/verify-${name}-browser.mjs`])) throw new Error(`browser_execution_binding:${name}`);
      for (const file of browserScreenshots[name]) {
        const candidates = [...files.keys()].filter(relative => name === 'speech' ? relative === file : relative.startsWith(`${run}/`) && path.basename(relative) === file);
        if (candidates.length !== 1 || !files.get(candidates[0]).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`missing_or_invalid_screenshot:${file}`);
      }
    }
    result.nested = [];
    for (const kind of ['session', 'relation-result', 'security', 'import-protocol', 'edit-consistency', 'trace-business', 'playback']) {
      const candidates = [...files.keys()].filter(file => new RegExp(`^${run}/${kind}-[A-Za-z0-9]+/report\\.json$`).test(file));
      if (candidates.length !== 1) throw new Error(`missing_or_duplicate_nested_report:${kind}`);
      const nestedDirectory = path.dirname(candidates[0]);
      const mandatory = kind === 'playback' ? playbackNestedFiles : kind === 'trace-business' ? traceNestedFiles : kind === 'import-protocol' ? ['observations.json'] : ['observations.json', 'worker.log', 'browser.json', ...(newNestedChecks[kind]?.map(row => `${row.name}.log`) || [...Object.keys(nestedCounts[kind]).map(name => `${name}.log`), 'browser.log'])];
      for (const file of mandatory)
        if (!files.has(`${nestedDirectory}/${file}`)) throw new Error(`missing_bound_nested_file:${kind}:${file}`);
      for (const file of await evidenceFiles(path.join(directory, nestedDirectory))) if (!files.has(`${nestedDirectory}/${file}`)) throw new Error(`unbound_nested_file:${kind}:${file}`);
      const verdict = await validateNestedBrowserEvidence(kind, path.join(directory, nestedDirectory), { release }); result.nested.push(verdict);
      if (!verdict.ok) throw new Error(`nested_profile_rejected:${kind}:${verdict.reasons.join(',')}`);
    }
  } catch (error) { result.reasons.push(error.message); statuses.push('incomplete'); }
  return finish(result, statuses.length ? statuses : ['incomplete']);
}
