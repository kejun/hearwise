import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { databaseSnapshot } from '../../test-support/import-protocol-fixture.mjs';
import { journeyScreenshots, journeyLimits, journeyExternalAcceptance } from '../../test-support/user-journey-contract.mjs';
import { validateUserJourneyEvidence } from './user-journey-evidence.mjs';
import { digest, metadata, sourceVersion } from './verification-evidence.mjs';
import { evidenceFiles, safeRelative, sourceSnapshot, sameSourceSnapshot, validBuildSource } from './runner-evidence-contract.mjs';

const require = createRequire(import.meta.url);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const passed = value => value?.ok === true && value.code === 0 && value.signal === null && value.timedOut === false && value.interrupted === false && !value.error;
export const userJourneyNestedFiles = ['browser.json', 'browser.log', 'journey-1280-server.log', 'journey-390-server.log', ...journeyScreenshots];
export async function journeyMutation() {
  const file = 'public/knowledge-editor.js', source = await readFile(file, 'utf8');
  const anchor = '      await onSaved(current.listeningId);', replacement = '      // Deliberately broken: leave the committed name out of every current view.';
  assert.equal(source.split(anchor).length - 1, 1, 'journey_unique_mutation_anchor');
  return { file, anchor, replacement, sourceSha256: digest(source), mutantSha256: digest(source.replace(anchor, replacement)) };
}
// A thin origin/artifact boundary around the single raw domain reader. Evidence
// may be copied out of CI; the recorded output argument must still be bound to
// the exact command and the known nested-directory basename.
export async function validateUserJourneyReleaseContract(report, directory, { requirePassed = true, release = false, source = undefined, origin: expectedOrigin = undefined } = {}) {
  assert.equal(report.profile, 'user-journey'); assert.equal(report.schemaVersion, 1); assert.equal(report.complete, true);
  if (requirePassed) { assert.equal(report.ok, true); assert.equal(report.status, 'passed'); }
  assert.deepEqual(report.finalizationErrors, [], 'journey_finalization_failed'); assert.equal(report.fullProjectAcceptance, false);
  assert.ok(!report.error && !report.failure, 'journey_report_failure');
  const started = Date.parse(report.startedAt), finished = Date.parse(report.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started && finished - started <= journeyLimits.overallMs, 'journey_report_interval');
  assert.ok(sameSourceSnapshot(report.sourceStart, report.sourceEnd), 'journey_source_changed');
  assert.ok(validBuildSource(report.sourceStart) && validBuildSource(report.sourceEnd), 'journey_invalid_runtime_build');
  assert.deepEqual(report.source, report.sourceEnd.source);
  if (source) assert.deepEqual(report.sourceEnd, source, 'journey_stale_source');
  if (release) assert.equal(report.source.dirty, false, 'journey_uncommitted_source');
  const context = await metadata();
  for (const field of ['specification', 'tools', 'environment']) assert.deepEqual(report[field], context[field], `journey_${field}`);
  assert.deepEqual(report.externalAcceptance, journeyExternalAcceptance, 'journey_external_acceptance_not_run');
  const origin = report.executionContext;
  for (const field of ['repositoryRoot', 'evidenceDirectory', 'nodeExecutable']) assert.ok(typeof origin[field] === 'string' && path.isAbsolute(origin[field]) && path.normalize(origin[field]) === origin[field], `journey_origin:${field}`);
  const trusted = expectedOrigin || { repositoryRoot: process.cwd(), nodeExecutable: process.execPath, evidenceDirectory: path.resolve(directory) };
  for (const field of ['repositoryRoot', 'nodeExecutable', 'evidenceDirectory']) assert.equal(origin[field], trusted[field], `journey_untrusted_origin:${field}`);
  assert.equal(path.basename(origin.nodeExecutable), process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(path.basename(origin.evidenceDirectory), path.basename(path.resolve(directory)), 'journey_output_binding');
  assert.equal(origin.overallTimeoutMs, journeyLimits.overallMs);
  assert.equal(report.browserFile, 'browser.json'); assert.deepEqual(report.checks.map(value => value.name), ['browser']);
  const check = report.checks[0]; assert.equal(check.timeoutMs, journeyLimits.browserMs); assert.ok(passed(check.execution), 'journey_browser_process_incomplete');
  assert.deepEqual(check.command, [origin.nodeExecutable, 'test-support/user-journey-browser.mjs', origin.evidenceDirectory], 'journey_browser_command');
  assert.ok(Number.isSafeInteger(check.execution.durationMs) && check.execution.durationMs >= 0 && check.execution.durationMs <= journeyLimits.browserMs && check.execution.durationMs <= finished - started, 'journey_execution_duration');
  const disk = await evidenceFiles(directory), files = new Map();
  assert.ok(Array.isArray(report.artifacts) && report.artifacts.length > 0, 'journey_missing_artifacts');
  for (const artifact of report.artifacts) {
    assert.ok(safeRelative(artifact.path) && disk.includes(artifact.path) && !files.has(artifact.path), 'journey_artifact_roster');
    const bytes = await readFile(path.join(directory, artifact.path)); assert.equal(digest(bytes), artifact.sha256, 'journey_changed_artifact'); files.set(artifact.path, bytes);
  }
  assert.deepEqual([...files.keys()].sort(), disk.filter(file => file !== 'report.json').sort(), 'journey_unbound_artifact');
  for (const file of userJourneyNestedFiles) assert.ok(files.has(file), `journey_missing_artifact:${file}`);
  assert.equal(check.execution.tail, files.get('browser.log').toString('utf8').slice(-12000), 'journey_execution_log_binding');
  const browser = JSON.parse(files.get('browser.json'));
  assert.equal(browser.playwright, require('playwright/package.json').version, 'journey_browser_tool_version');
  assert.ok(Date.parse(browser.startedAt) >= started && Date.parse(browser.finishedAt) <= finished, 'journey_child_interval');
  const mutation = await journeyMutation();
  const checked = validateUserJourneyEvidence(browser, { source: report.source, sourceDigests: report.sourceEnd.digests, mutation });
  assert.equal(checked.ok, true, `journey_raw_rejected:${checked.reasons.join(';')}`);
  if (requirePassed) assert.deepEqual(report.propertyRows, checked.propertyRows, 'journey_contradictory_property_rows');
  for (const file of journeyScreenshots) {
    const bytes = files.get(file); assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `journey_invalid_png:${file}`);
  }
  for (const width of browser.widths) assert.equal(files.get(`journey-${width.width}-server.log`).toString(), width.serverLog, 'journey_server_log_binding');
  for (const width of browser.widths) for (const download of width.downloads) {
    assert.ok(safeRelative(download.path) && files.has(download.path), 'journey_missing_download'); const bytes = files.get(download.path);
    assert.equal(bytes.length, download.bytes, 'journey_download_size'); assert.equal(digest(bytes), download.sha256, 'journey_download_hash');
    assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0', 'journey_native_sqlite_bytes');
    assert.deepEqual(databaseSnapshot(path.join(directory, download.path)), download.database, 'journey_download_native_snapshot');
  }
  return { ...checked, chromium: browser.chromium, scope: { widths: browser.widths.map(value => value.width), stagesPerWidth: browser.widths[0].stages.length,
    continuousDatabasePerWidth: true, externalAcceptance: journeyExternalAcceptance, cancelledProvider: 'physical completion after transport closure; application late callback ownership requires separate same-source KEJ-66 evidence' } };
}
export async function validateUserJourneyBrowserReleaseEvidence(directory, { release = true, outerRun, outerLog, outerOrigin } = {}) {
  const result = { kind: 'user-journey', source: null, ok: false, status: 'not_run', stale: false, reasons: [], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { result.reasons.push('missing_user_journey_report'); return result; }
  result.source = report.source; result.status = 'incomplete';
  try {
    assert.deepEqual(report.source, sourceVersion(), 'journey_stale_source');
    let origin;
    if (outerRun !== undefined || outerLog !== undefined || outerOrigin !== undefined) {
      assert.match(outerRun || '', /^run-[A-Za-z0-9]+$/, 'journey_outer_run');
      assert.match(path.basename(directory), /^user-journey-[A-Za-z0-9]+$/, 'journey_nested_directory');
      assert.ok(outerOrigin?.repositoryRoot && outerOrigin.nodeExecutable, 'journey_outer_origin_missing');
      origin = { ...outerOrigin, evidenceDirectory: path.join(outerOrigin.repositoryRoot, 'browser-evidence', outerRun, path.basename(directory)) };
      const lines = (outerLog || '').split(/\r?\n/);
      assert.equal(lines[0], `User journey browser evidence: ${origin.evidenceDirectory}`, 'journey_outer_log_origin');
      assert.equal(lines.filter(line => line.startsWith('User journey browser evidence: ')).length, 1, 'journey_duplicate_outer_origin');
    }
    const checked = await validateUserJourneyReleaseContract(report, directory, { release, source: await sourceSnapshot(), origin });
    return { ...result, ...checked, status: 'passed', ok: true };
  } catch (error) { result.reasons.push(error.message); result.stale = JSON.stringify(report.source) !== JSON.stringify(sourceVersion()); return result; }
}
