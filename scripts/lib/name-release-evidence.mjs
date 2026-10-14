import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateNameProtocolEvidence, nameConfig, nameProtocolPlan, nameInputBinding, validateNameCommand, strictNameTap } from './name-protocol-evidence.mjs';
import { sourceVersion, metadata } from './verification-evidence.mjs';
import { evidenceFiles } from './runner-evidence-contract.mjs';
import { summarizeChecks } from './verification-checks.mjs';
import { nameProfile } from '../../verification/name-properties.mjs';
import { checkNameEvidence, nameBrowserAssets, nameBrowserChecks, nameHttpRoster } from '../../test-support/name-protocol-browser-evidence.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
const nodeExecutable = value => absolute(value) && path.basename(value) === (process.platform === 'win32' ? 'node.exe' : 'node');
export const nameNestedFiles = ['observations.json', 'worker.log', ...nameBrowserChecks.map(row => `${row.name}.log`), ...nameBrowserAssets];
// Domain readers own the complete model/TAP/replay/durable/browser contracts.
// This thin boundary adds release origin, portable output and aggregate binding.
export async function validateNameReleaseContract(report, directory) {
  const origin = report.origin, config = await nameConfig(), plan = nameProtocolPlan(config);
  assert.ok(nodeExecutable(origin.nodeExecutable), 'wrong_name_executable');
  for (const key of ['repositoryRoot', 'quintHome', 'evidenceDirectory']) assert.ok(absolute(origin[key]), `invalid_name_origin:${key}`);
  assert.equal(origin.repositoryRoot, report.repositoryRoot, 'wrong_name_repository_root');
  assert.equal(path.basename(origin.evidenceDirectory), path.basename(path.resolve(directory)), 'wrong_name_output_directory');
  assert.equal(report.tools.node, process.version); assert.equal(report.tools.sqlite, process.versions.sqlite);
  assert.equal(report.overallTimeoutMs, config.limits.overallMs);
  assert.deepEqual(report.results.map(row => row.id), plan.map(row => row.id), 'wrong_name_stage_plan');
  const binding = nameInputBinding(report, config, report.tools), files = new Set(await evidenceFiles(directory));
  for (const row of report.artifacts) assert.ok(files.has(row.path), 'missing_name_artifact');
  for (const [index, row] of report.results.entries()) {
    assert.equal(validateNameCommand(row, plan[index], config, origin.evidenceDirectory, binding, origin), true, `wrong_name_command:${row.id}`);
  }
  const regression = report.results.find(row => row.id === 'driver-regressions');
  assert.equal(regression.log, 'driver-regressions.log');
  assert.equal(strictNameTap(await readFile(path.join(directory, regression.log), 'utf8')).ok, true, 'wrong_name_tap_tree');
  return true;
}
export async function validateNameReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const result = { kind: 'name-protocol', source: null, status: 'not_run', ok: false, stale: false, reasons: [],
    methods: ['complete-labelled-finite-domains', 'bounded-model-check', 'real-name-http-sqlite-replay'], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { result.reasons.push('missing_or_invalid_name_report'); return result; }
  result.source = report?.source; result.status = 'incomplete';
  try {
    assert.equal(requireProfile, 'fast', 'name_has_only_a_fixed_profile');
    const checked = await validateNameProtocolEvidence(directory, { release });
    result.rows = checked.rows; result.propertyRows = checked.propertyRows; result.reasons.push(...checked.reasons);
    result.stale = checked.reasons.some(reason => reason.startsWith('stale_'));
    assert.equal(checked.ok, true, 'name_domain_rejected'); assert.deepEqual(report.source, sourceVersion());
    await validateNameReleaseContract(report, directory);
    result.scope = { profile: 'fixed', domain: report.config, propertyRows: checked.propertyRows, browserAcceptance: checked.browserAcceptance };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
export async function validateNameBrowserReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'name-protocol', source: null, status: 'not_run', ok: false, stale: false, reasons: [], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { result.reasons.push('missing_name_browser_report'); return result; }
  result.source = report?.source; result.status = 'incomplete';
  try {
    const context = await metadata(), observations = await json(path.join(directory, 'observations.json'));
    assert.equal(report.profile, 'name-protocol-browser'); assert.equal(report.complete, true); assert.equal(report.ok, true);
    assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt)) &&
      Date.parse(report.finishedAt) >= Date.parse(report.startedAt) && Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= 180000, 'wrong_name_browser_interval');
    assert.deepEqual(report.results.map(row => row.property.id), nameProfile);
    for (const row of [report, ...report.results]) for (const key of ['source', 'specification', 'tools', 'environment']) assert.deepEqual(row[key], context[key]);
    const origin = observations.executionContext;
    assert.ok(nodeExecutable(origin.executable), 'wrong_name_browser_executable');
    assert.ok(absolute(origin.cwd) && absolute(origin.evidenceDirectory), 'wrong_name_browser_origin');
    for (const row of report.results) {
      assert.equal(row.startedAt, report.startedAt); assert.equal(row.finishedAt, report.finishedAt);
      assert.equal(row.scope.scenario, 'name-http-browser');
    }
    for (const check of observations.checks) {
      const e = check.execution; assert.ok(!e.error, 'name_browser_process_error');
      assert.ok(Number.isSafeInteger(e.durationMs) && e.durationMs >= 0 && e.durationMs <= e.timeoutMs + 1500, 'wrong_name_browser_duration');
      if (check.name === 'http') { assert.equal(e.testComplete, true); assert.equal(e.testCount, (await nameHttpRoster()).length); }
    }
    const files = await evidenceFiles(directory); for (const file of nameNestedFiles) assert.ok(files.includes(file), `missing_name_browser_asset:${file}`);
    const artifactsValid = await Promise.all(report.results.map(row => checkNameEvidence(directory, row)));
    const { execution, summary } = summarizeChecks({ results: report.results, checks: observations.checks, target: context.source, required: nameProfile,
      release, sourceStable: true, expectedChecks: nameBrowserChecks.map(row => row.name), checksForProperty: () => nameBrowserChecks.map(row => row.name),
      budgetExpired: false, artifactsValid });
    assert.equal(summary.ok, true, 'name_browser_domain_rejected'); assert.deepEqual(report.execution, execution); assert.deepEqual(report.summary, summary);
    result.status = 'passed'; result.ok = true; result.propertyRows = summary.rows;
    result.scope = { widths: [1280, 390], scenariosPerWidth: 6, productionCopyNegatives: 1, providers: 'local stubs; no physical-device or semantic-quality acceptance' };
  } catch (error) { result.reasons.push(error.message); result.stale = JSON.stringify(report?.source) !== JSON.stringify(sourceVersion()); }
  return result;
}
