import { workflowScenarioNames } from '../../test-support/trace-business-scenarios.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { metadata, sourceVersion, checkArtifacts, summarize } from './verification-evidence.mjs';
import { tapSummary } from './tap-summary.mjs';
import { validateFlatTap } from './release-tap-evidence.mjs';
import { traceSourceSnapshot, sameTraceSources, validateTraceBusinessObservations, validTraceBrowser, checkTraceArtifacts,
  traceBrowserArtifacts, traceBrowserReportNames, traceBrowserDocuments, tracePropertyState, traceRegressionFiles, traceRegressionCount, traceEvidenceScope } from '../../test-support/trace-business-evidence.mjs';
import { traceBusinessProperties, traceBusinessProfile } from '../../verification/trace-business-properties.mjs';
import { expectedTraceMutations } from '../../test-support/trace-business-negative.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const passed = execution => execution?.code === 0 && execution.signal === null && execution.timedOut === false && execution.interrupted === false && execution.ok === true && !execution.error;
export async function traceRegressionNames() {
  return (await Promise.all([...traceRegressionFiles].sort().map(async file => {
    const text = await readFile(file, 'utf8');
    if (file === 'test/trace-business-workflow.test.mjs') {
      const templates = [...text.matchAll(/test\(`([^`]+)`/g)].map(row => row[1]);
      assert.deepEqual(templates, ['actual workflow and durable task query agree with Trace: ${name}']);
      return workflowScenarioNames.map(name => templates[0].replace('${name}', name));
    }
    return [...text.matchAll(/^test\('([^']+)'/gm)].map(row => row[1]);
  }))).flat();
}
export const traceNestedFiles = ['observations.json', 'worker.log', 'business-observations.json', 'trace-browser.json', 'workflows.log', 'regressions.log', 'browser.log',
  ...traceBrowserArtifacts, ...traceBrowserReportNames, 'trace-safe-export.json'];
export async function validateTraceReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'trace-business', ok: false, status: 'not_run', stale: false, reasons: [], source: null,
    methods: ['real-sqlite-http-ws-trace-comparison', 'automated-chromium', 'compiled-production-mutations'], fullProjectAcceptance: false };
  let report, observations;
  try { report = await json(path.join(directory, 'report.json')); observations = await json(path.join(directory, 'observations.json')); }
  catch { result.reasons.push('missing_trace_business_report'); return result; }
  result.source = report.source; result.status = 'incomplete';
  try {
    const context = await metadata(), target = sourceVersion();
    assert.equal(report.profile, 'trace-business'); assert.equal(report.profileVersion, 1); assert.equal(report.nodeOnly, false);
    assert.equal(report.complete, true); assert.equal(report.ok, true); assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
    assert.ok(Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= 180000);
    assert.deepEqual(report.source, target); assert.deepEqual(report.specification, context.specification); assert.deepEqual(report.tools, context.tools);
    assert.deepEqual(report.sourceStart, observations.sourceStart); assert.deepEqual(report.sourceEnd, observations.sourceEnd);
    assert.ok(sameTraceSources(observations.sourceStart, observations.sourceEnd));
    assert.deepEqual(observations.sourceEnd, await traceSourceSnapshot());
    assert.equal(observations.sourceStable, true); assert.equal(observations.cleanupOk, true); assert.equal(observations.budgetExpired, false); assert.ok(!observations.failure);
    assert.deepEqual(observations.checks.map(row => row.name), ['workflows', 'regressions', 'browser']);
    const logs = [], origin = observations.checks[0].command?.[2];
    assert.equal(typeof origin, 'string'); assert.equal(path.basename(origin), path.basename(directory));
    for (const [index, check] of observations.checks.entries()) {
      const log = await readFile(path.join(directory, `${check.name}.log`), 'utf8'); logs.push(`CHECK ${check.name}\n${log}`);
      assert.ok(passed(check.execution)); assert.equal(check.execution.tail, log.slice(-12000));
      assert.ok(path.isAbsolute(check.command[0])); assert.equal(check.command[0], observations.checks[0].command[0]);
      const command = check.name === 'regressions' ? ['--test', '--test-reporter=tap', '--test-timeout=25000', ...traceRegressionFiles] :
        [`test-support/trace-business-${check.name === 'workflows' ? 'worker' : 'browser'}.mjs`, origin];
      assert.deepEqual(check.command.slice(1), command); assert.equal(check.configuredTimeoutMs, [40000, 45000, 60000][index]);
      if (check.name === 'regressions') {
        assert.deepEqual(check.files, traceRegressionFiles); const tap = tapSummary(log);
        assert.equal(tap.ok, true); assert.equal(tap.testCount, traceRegressionCount); assert.equal(check.execution.testCount, tap.testCount); assert.equal(check.execution.testComplete, true);
        assert.equal(validateFlatTap(log, await traceRegressionNames()), true);
      }
    }
    assert.equal(await readFile(path.join(directory, 'worker.log'), 'utf8'), logs.join('\n'));
    const business = await json(path.join(directory, 'business-observations.json')), mutations = await expectedTraceMutations();
    assert.deepEqual(observations.mutations, mutations);
    const validation = validateTraceBusinessObservations(business, { source: target, mutations });
    assert.equal(validation.ok, true); assert.deepEqual(observations.validation, validation);
    assert.equal(await checkTraceArtifacts(directory, [observations.businessArtifact], ['business-observations.json']), true);
    const browser = await json(path.join(directory, 'trace-browser.json'));
    assert.deepEqual(browser, observations.browser); assert.deepEqual(browser.source, target); assert.equal(validTraceBrowser(browser, business), true);
    assert.equal(await checkTraceArtifacts(directory, browser.artifacts, [...traceBrowserArtifacts, 'trace-safe-export.json']), true);
    assert.equal(await checkTraceArtifacts(directory, browser.reports, traceBrowserReportNames), true);
    for (const expected of traceBrowserDocuments(business)) {
      assert.equal(await readFile(path.join(directory, expected.name), 'utf8'), expected.html);
      assert.equal(browser.reports.find(row => row.path === expected.name).sha256, expected.sha256);
    }
    const exported = await json(path.join(directory, 'trace-safe-export.json'));
    const full = business.boundaries.find(row => row.name === 'full-public-boundary');
    const rendered = traceBrowserDocuments(business).find(row => row.name === 'trace-full.html').html;
    const embedded = rendered.match(/<script type="application\/json" id="trace-data">([\s\S]*?)<\/script>/);
    assert.ok(embedded); assert.deepEqual(exported, JSON.parse(embedded[1]));
    assert.equal(exported.current?.eventCount, full.report.eventCount);
    assert.doesNotMatch(JSON.stringify(exported), /TRACE_SECRET_KEY|HW_TEST_ONLY_TRACE_SENTINEL_84_secret|PRIVATE_TRACE_TRANSCRIPT|PRIVATE_PREVIEW_TEXT/);
    assert.equal(observations.browserValid, true); assert.equal(report.results.length, traceBusinessProperties.length);
    for (const property of traceBusinessProperties) {
      const rows = report.results.filter(row => row.property.id === property.id); assert.equal(rows.length, 1); const row = rows[0];
      const state = tracePropertyState(property.id, { checks: observations.checks, observationsValid: validation.ok, artifactsValid: true, browserValid: true,
        sourceStable: true, cleanupOk: true, nodeOnly: false });
      assert.equal(row.status, state.status); assert.equal(row.complete, state.complete); assert.deepEqual(row.scope, traceEvidenceScope(property));
      for (const key of ['source', 'specification', 'tools', 'environment']) assert.deepEqual(row[key], report[key]);
      assert.equal(await checkArtifacts(directory, row), true);
    }
    const summary = summarize({ results: report.results, target, required: traceBusinessProfile, release,
      execution: { code: 0, signal: null, interrupted: false, timedOut: false, complete: true }, artifactsValid: report.results.map(() => true) });
    assert.equal(summary.ok, true); assert.deepEqual(report.summary.rows, summary.rows); assert.deepEqual(report.summary.required, traceBusinessProfile);
    assert.equal(report.summary.nodeOnly, false); assert.equal(report.summary.fullTraceBusinessProfile, true); assert.equal(report.summary.fullProjectAcceptance, false);
    return { ...result, ok: true, status: 'passed', propertyRows: summary.rows, chromium: browser.chromium };
  } catch (error) { result.reasons.push(error.message); result.stale = JSON.stringify(report.source) !== JSON.stringify(sourceVersion()); return result; }
}
