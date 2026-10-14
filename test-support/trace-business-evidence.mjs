import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { buildBusinessOverview } from '../dist/server/index.js';
import { traceReport } from './trace-business-fixture.mjs';
import { workflowScenarioNames, checkWorkflowCapture } from './trace-business-scenarios.mjs';
import { checkFullTraceComparison } from './trace-business-boundary.mjs';
import { renderTraceReport } from '../scripts/trace-report.mjs';

export async function traceSourceSnapshot() {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const names = [...new Set([...tracked, 'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort();
  return { source: sourceVersion(), digests: Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(name))]))) };
}
export const sameTraceSources = (start, end) => Boolean(start && end && /^[a-f0-9]{40}$/.test(start.source?.sha) &&
  ['server.mjs', 'speech-service.mjs', 'relation-workflow.mjs', 'src/server/diagnostics/report.ts', 'src/server/diagnostics/business.ts',
    'dist/server/index.js', 'scripts/verify-trace-business-browser.mjs', 'test-support/trace-business-evidence.mjs', 'package-lock.json']
    .every(name => /^[a-f0-9]{64}$/.test(start.digests?.[name])) && JSON.stringify(start) === JSON.stringify(end));
const safeReport = (report, source) => {
  assert.ok(report.eventCount > 0); assert.ok(report.builds.length === 1);
  assert.equal(report.builds[0].git_sha, source.sha); assert.equal(report.builds[0].build_dirty, source.dirty);
  assert.equal(report.builds[0].instrumentation_version, 3);
  assert.doesNotMatch(JSON.stringify(report), /TRACE_SECRET_KEY|HW_TEST_ONLY_TRACE_SENTINEL_84_secret/);
};
const finalCapture = row => row.captures.at(-2);
const json = value => JSON.parse(JSON.stringify(value));
const sameJson = (actual, expected) => assert.deepEqual(json(actual), json(expected));
export function validateTraceBusinessObservations(value, { source, mutations }) {
  try {
    // Evidence crosses JSON files; SQLite row prototypes and undefined JS fields are not wire data.
    value = json(value);
    assert.equal(value?.profileVersion, 1); assert.equal(value.complete, true); assert.equal(value.ok, true);
    assert.deepEqual(value.source, source); assert.ok(Date.parse(value.finishedAt) >= Date.parse(value.startedAt));
    assert.equal(value.workflows.length, workflowScenarioNames.length);
    assert.deepEqual(value.workflows.map(row => row.name).sort(), [...workflowScenarioNames].sort());
    for (const row of value.workflows) {
      assert.equal(row.complete, true); assert.equal(row.ok, true); assert.equal(row.cleanup, true);
      assert.equal(row.captures.length, ['knowledge-partial', 'knowledge-retry', 'knowledge-cancel-late', 'relation-retry', 'relation-old-generation-usage'].includes(row.name) ? 3 : 2);
      for (const c of row.captures) {
        assert.ok(c.query?.jobId && c.query?.listeningId); const report = traceReport(c.snapshot);
        sameJson(c.report, report); sameJson(c.business, buildBusinessOverview(report, c.query.listeningId)); safeReport(report, source);
      }
      const domain = row.name.split('-')[0];
      if (row.name === 'knowledge-cancel-late') {
        assert.equal(row.captures.length, 3); const [before, late, recovered] = row.captures;
        assert.equal(before.business.tasks[0].state, 'cancelled'); assert.equal(before.query.checkpoint.parts[0].phase, 'extract_inflight');
        assert.equal(before.query.checkpoint.job.state, 'running'); assert.equal(before.query.checkpoint.job.outcome, null);
        assert.equal(before.activeCount, 0); assert.equal(before.query.detail.knowledge.length, 0);
        assert.deepEqual(before.snapshot, late.snapshot); assert.deepEqual(before.query, late.query);
        assert.equal(recovered.query.checkpoint.job.state, 'pending'); assert.equal(recovered.query.detail.knowledge.length, 0);
        assert.equal(recovered.query.checkpoint.parts[0].phase, 'extract_pending'); assert.equal(recovered.query.checkpoint.parts[0].initial_requests, 1);
        assert.equal(recovered.query.next.id, recovered.query.jobId);
        assert.equal(recovered.adapterCalls.length, 1); assert.equal(recovered.calls.length, 0); assert.equal(recovered.activeCount, 0);
      } else if (row.name === 'relation-old-generation-usage') {
        assert.equal(row.captures.length, 3); const [cancelled, late, complete] = row.captures;
        assert.equal(cancelled.query.processing.state, 'cancelled'); assert.equal(cancelled.business.tasks[0].state, 'cancelled');
        assert.equal(late.query.processing.usageLastHour.totalTokens, 71); assert.equal(late.query.processing.round.totalTokens, 0); assert.equal(late.activeCount, 1);
        assert.deepEqual(late.snapshot, late.beforeLate.snapshot); assert.deepEqual(late.query.job, late.beforeLate.query.job); assert.equal(late.beforeLate.activeCount, 1);
        assert.equal(late.query.job.state, 'running');
        for (const field of ['relations', 'assertions', 'supports']) {
          assert.deepEqual(late.query.graph[field], []); assert.deepEqual(late.query.graph[field], late.beforeLate.query.graph[field]);
          assert.deepEqual(complete.query.graph[field], []);
        }
        assert.deepEqual(late.query.graph.nodes, late.beforeLate.query.graph.nodes);
        assert.equal(late.oldLedger.length, 1); assert.equal(late.oldLedger[0].outcome, 'late_response'); assert.equal(JSON.parse(late.oldLedger[0].usage_json).total_tokens, 71);
        assert.equal(complete.query.processing.usageLastHour.totalTokens, 92); assert.equal(complete.query.processing.round.totalTokens, 21);
        assert.equal(complete.query.job.state, 'complete'); assert.equal(complete.query.ledger.length, 1); assert.equal(complete.adapterCalls.length, 2);
        assert.equal(complete.activeCount, 0); assert.equal(complete.calls.length, 0);
        assert.deepEqual(complete.business.tasks.map(task => task.state).sort(), ['cancelled', 'succeeded']);
        assert.notEqual(complete.query.job.id, cancelled.query.job.id); assert.ok(complete.query.job.epoch > cancelled.query.job.epoch);
        assert.equal(complete.business.tasks.find(task => task.job === cancelled.query.job.id).state, 'cancelled');
        assert.equal(complete.business.tasks.find(task => task.job === complete.query.job.id).state, 'succeeded');
      } else {
        const terminal = finalCapture(row), partial = row.name.endsWith('partial'), retry = row.name.endsWith('retry'), fault = row.name.includes('notification');
        const expected = { domain, state: partial ? 'partial' : retry ? 'recovered' : 'succeeded', calls: retry || domain === 'knowledge' && partial ? 2 : 1,
          items: domain === 'knowledge' && (partial || fault) ? 1 : 0, queryState: domain === 'relation' && partial ? 'partial' : 'complete',
          outcome: partial ? 'partial' : fault ? 'ok' : 'empty', next: false, accepted: 0, rejected: row.name === 'relation-filtered' ? 1 : 0 };
        checkWorkflowCapture(terminal, expected); checkWorkflowCapture(row.captures.at(-1), expected);
        if (domain === 'knowledge') assert.deepEqual(row.captures.at(-1).query.detail.knowledge, terminal.query.detail.knowledge);
        else assert.deepEqual(row.captures.at(-1).query.ledger, terminal.query.ledger);
        if (retry || domain === 'knowledge' && partial) checkWorkflowCapture(row.captures[0], { domain, state: 'waiting', calls: 1,
          items: partial ? 1 : 0, queryState: 'pending', outcome: null, next: domain === 'knowledge', accepted: null, rejected: 0 });
        if (fault) {
          assert.equal(terminal.notifications.delivered, 0); assert.ok(terminal.notifications.attempted >= 2);
          assert.equal(terminal.snapshot.events.filter(event => event.event === 'notification_sent').length, 0);
          if (domain === 'knowledge') { assert.ok(terminal.snapshot.sink_errors > 0); assert.equal(terminal.snapshot.sink_complete, false); }
        }
      }
    }
    assert.deepEqual(value.boundaries.map(row => row.name).sort(), ['full-public-boundary', 'speech-cancel-old-progress', 'speech-failed', 'translation-failure-retry'].sort());
    for (const row of value.boundaries) { assert.equal(row.complete, true); assert.equal(row.ok, true); assert.equal(row.cleanup, true); }
    const full = value.boundaries.find(row => row.name === 'full-public-boundary');
    sameJson(full.report, traceReport(full.actual.logs)); sameJson(full.business, buildBusinessOverview(full.report, full.actual.listeningId));
    checkFullTraceComparison(full.actual, full.report, full.business); safeReport(full.report, source);
    for (const name of ['speech-cancel-old-progress', 'speech-failed']) {
      const row = value.boundaries.find(row => row.name === name), failed = name === 'speech-failed'; safeReport(row.report, source);
      sameJson(row.report, traceReport(row.rawInput));
      assert.deepEqual(row.before, row.after); assert.equal(row.before.items.length, 1);
      sameJson(row.business, buildBusinessOverview(row.report, row.report.spans[0].listening));
      assert.deepEqual(row.business.tasks.filter(task => !task.session).map(task => task.state).sort(), failed ? ['failed'] : ['cancelled', 'succeeded']);
      assert.equal(row.business.domains.find(domain => domain.key === 'speech').played, failed ? 0 : 1);
      assert.deepEqual(row.provider, failed ? { qwen: 0, fish: 1 } : { qwen: 2, fish: 0 });
      if (!failed) {
        sameJson(row.observations[0].report, traceReport(row.observations[0].rawInput));
        assert.equal(row.observations[0].report.spans.flatMap(span => span.events).filter(event => event.event === 'playback_completed').length, 0);
        assert.deepEqual(row.observations[0].tasks.filter(task => !task.session).map(task => task.state).sort(), ['cancelled', 'unknown']);
      }
    }
    const translated = value.boundaries.find(row => row.name === 'translation-failure-retry');
    assert.equal(translated.failed.query.items[0].translation_state, 'failed'); assert.equal(translated.recovered.query.items[0].translation_state, 'complete');
    assert.equal(translated.failed.query.items[0].id, translated.segmentId); assert.equal(translated.recovered.query.items[0].id, translated.segmentId);
    assert.equal(translated.failed.query.items[0].original_text, translated.recovered.query.items[0].original_text);
    for (const capture of [translated.failed, translated.recovered]) { sameJson(capture.report, traceReport(capture.rawInput)); safeReport(capture.report, source); }
    const task = buildBusinessOverview(translated.recovered.report, translated.listeningId).tasks.filter(row => row.domain === 'translation');
    assert.equal(task.length, 1); assert.equal(task[0].state, 'recovered'); assert.equal(task[0].calls, 2); assert.equal(translated.calls, 2);
    const failed = buildBusinessOverview(translated.failed.report, translated.listeningId).tasks.filter(row => row.domain === 'translation');
    assert.equal(failed.length, 1); assert.equal(failed[0].state, 'failed'); assert.equal(failed[0].calls, 1); assert.equal(failed[0].job, translated.segmentId);
    assert.equal(value.negative.complete, true); assert.equal(value.negative.ok, true); assert.equal(value.negative.cleanup, true);
    const normal = value.negative.normal; assert.equal(normal.name, 'knowledge-retry'); assert.equal(normal.complete, true); assert.equal(normal.ok, true); assert.equal(normal.cleanup, true);
    assert.equal(normal.captures.length, 3);
    for (const capture of normal.captures) { sameJson(capture.report, traceReport(capture.snapshot)); safeReport(capture.report, source);
      sameJson(capture.business, buildBusinessOverview(capture.report, capture.query.listeningId)); }
    assert.equal(value.negative.results.length, 2); assert.equal(mutations.length, 2);
    for (const mutation of mutations) {
      const matches = value.negative.results.filter(row => row.id === mutation.id); assert.equal(matches.length, 1);
      const row = matches[0]; for (const [key, expected] of Object.entries(mutation)) assert.deepEqual(row[key], expected);
      assert.equal(row.detected, true); assert.equal(row.complete, true);
      const before = normal.captures[row.id === 'continuation-as-success' ? 0 : 1];
      const expectedComparison = { domain: 'knowledge', state: row.id === 'continuation-as-success' ? 'waiting' : 'recovered',
        calls: row.id === 'continuation-as-success' ? 1 : 2, items: 0, queryState: row.id === 'continuation-as-success' ? 'pending' : 'complete',
        outcome: row.id === 'continuation-as-success' ? null : 'empty', next: row.id === 'continuation-as-success' };
      assert.deepEqual(row.comparison, expectedComparison); checkWorkflowCapture(before, expectedComparison);
      for (const key of ['snapshot', 'query', 'calls', 'adapterCalls', 'notifications', 'activeCount']) assert.deepEqual(row.capture[key], before[key]);
      assert.deepEqual(row.capture.report.spans.flatMap(span => span.events), before.report.spans.flatMap(span => span.events));
      let mismatch;
      try { checkWorkflowCapture(row.capture, row.comparison); } catch (error) {
        if (error.code !== 'ERR_ASSERTION') throw error; mismatch = { actual: error.actual, expected: error.expected, operator: error.operator };
      }
      assert.deepEqual(row.mismatch, mismatch); assert.ok(mismatch);
      if (row.id === 'continuation-as-success') { assert.equal(row.persistedState, 'pending'); assert.deepEqual(row.observedStates, ['recovered']); assert.equal(row.businessObjects, 1); }
      else { assert.equal(row.persistedState, 'complete'); assert.equal(row.businessObjects, 2); }
      assert.deepEqual(row.observedStates, row.capture.business.tasks.map(task => task.state)); assert.equal(row.businessObjects, row.capture.business.tasks.length);
      assert.deepEqual(row.mismatch, row.id === 'continuation-as-success' ? { actual: 'recovered', expected: 'waiting', operator: 'strictEqual' } : { actual: 2, expected: 1, operator: 'strictEqual' });
    }
    return { ok: true, workflowCases: value.workflows.length, boundaryCases: value.boundaries.length, mutants: value.negative.results.length };
  } catch (error) { return { ok: false, reason: String(error.message).slice(0, 500) }; }
}

export const traceBrowserChecks = ['business-domains', 'terminal-states', 'identity-drilldown', 'incomplete-and-export'];
export const traceBrowserArtifacts = ['trace-business-desktop.png', 'trace-business-mobile.png', 'trace-business-incomplete.png'];
export const traceBrowserReportNames = ['trace-full.html', 'trace-incomplete.html', ...['succeeded', 'waiting', 'partial', 'recovered', 'cancelled', 'failed'].map(state => `trace-state-${state}.html`)];
export const traceStateLabels = { succeeded: '成功', waiting: '等待后续执行', partial: '部分成功', recovered: '成功 · 存在异常子步骤', cancelled: '已取消', failed: '失败' };
export function traceBrowserDocuments(data) {
  const workflow = name => data.workflows.find(row => row.name === name), full = data.boundaries.find(row => row.name === 'full-public-boundary');
  const missing = structuredClone(workflow('knowledge-empty').captures[0].snapshot); missing.events.shift();
  const rows = [['trace-full.html', full.report], ['trace-incomplete.html', traceReport(missing)],
    ['trace-state-succeeded.html', workflow('knowledge-empty').captures[0].report],
    ['trace-state-waiting.html', workflow('knowledge-retry').captures[0].report],
    ['trace-state-partial.html', workflow('knowledge-partial').captures[1].report],
    ['trace-state-recovered.html', workflow('knowledge-retry').captures[1].report],
    ['trace-state-cancelled.html', workflow('relation-old-generation-usage').captures[0].report],
    ['trace-state-failed.html', data.boundaries.find(row => row.name === 'speech-failed').report]];
  return rows.map(([name, report]) => { const html = renderTraceReport(report); return { name, report, html, sha256: digest(html) }; });
}
export function validTraceBrowser(browser, data) {
  if (!browser || browser.complete !== true || browser.ok !== true || browser.cleanup !== true || !browser.chromium || browser.errors?.length !== 0 || browser.networkRequests?.length !== 0) return false;
  if (browser.checks?.length !== traceBrowserChecks.length || !traceBrowserChecks.every(id => browser.checks.filter(row => row.id === id && row.complete === true && row.ok === true).length === 1)) return false;
  const full = data?.boundaries?.find(row => row.name === 'full-public-boundary'); if (!full) return false;
  if (browser.terminalObservations?.length !== 6 || !Object.entries(traceStateLabels).every(([state, label]) =>
    browser.terminalObservations.filter(row => row.state === state && row.text === label && Number.isSafeInteger(row.badges) && row.badges > 0).length === 1)) return false;
  if (browser.identityObservations?.length !== 4 || !['translation', 'knowledge', 'relation', 'speech'].every(domain => {
    const rows = browser.identityObservations.filter(row => row.domain === domain); if (rows.length !== 1) return false;
    const row = rows[0], task = full.business.tasks.find(task => task.domain === domain && task.id === row.taskId && task.job === row.jobId);
    const event = full.report.spans.flatMap(span => span.events).find(event => event.event_id === row.eventId);
    return task && event?.attributes.job_id === task.job && event.attributes.listening_id === row.listeningId && row.listeningId === full.actual.listeningId;
  })) return false;
  if (!/完整性未知/.test(browser.captureObservations?.jsonl || '') || !/采集不完整/.test(browser.captureObservations?.missing || '') ||
    browser.captureObservations?.exportedEvents !== full.report.eventCount || browser.captureObservations?.mobileOverflow !== false) return false;
  const counts = Object.fromEntries(browser.checks.map(row => [row.id, row.counts]));
  return counts['business-domains']?.domains === 5 && counts['business-domains']?.unownedPreviews === 1 &&
    counts['terminal-states']?.cases === browser.terminalObservations.length && counts['identity-drilldown']?.tasks === 4 && counts['identity-drilldown']?.eventIdentities === browser.identityObservations.length &&
    counts['incomplete-and-export']?.missingBoundary === 1 && counts['incomplete-and-export']?.jsonlUnknown === 1 &&
    counts['incomplete-and-export']?.safeExports === 1 && counts['incomplete-and-export']?.mobileWidth === 390;
}
export async function checkTraceArtifacts(directory, artifacts, expected) {
  if (!Array.isArray(artifacts) || artifacts.length !== expected.length || !expected.every(name => artifacts.filter(row => row.path === name).length === 1)) return false;
  for (const row of artifacts) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256)) return false;
    try { if (digest(await readFile(path.join(directory, row.path))) !== row.sha256) return false; } catch { return false; }
  }
  return true;
}
export const cleanTraceExecution = execution => execution && execution.timedOut === false && execution.interrupted === false && execution.signal == null &&
  [0, 1].includes(execution.code) && execution.testComplete !== false;
export const traceRegressionFiles = ['test/business-trace.test.mjs', 'test/trace-report.test.mjs', 'test/effect-runtime.test.mjs', 'test/trace-business-workflow.test.mjs',
  'test/trace-notification-boundary.test.mjs', 'test/trace-business-negative.test.mjs', 'test/trace-business-evidence.test.mjs'];
export const traceRegressionCount = 47;
export const traceEvidenceScope = property => ({ description: property.domain, scenario: 'trace-business-fixed-boundaries', samples: 1, seed: null,
  ...(property.id === 'HW-15-02' ? { scenarioCases: 15 } : {}) });
export function tracePropertyState(id, { checks, observationsValid, artifactsValid, browserValid, sourceStable, cleanupOk, nodeOnly }) {
  if (id === 'HW-15-04' && nodeOnly) return { complete: false, status: 'not_run' };
  const names = id === 'HW-15-03' ? ['regressions'] : id === 'HW-15-04' ? ['workflows', 'browser'] : ['workflows', 'regressions'];
  const selected = names.map(name => checks.filter(row => row.name === name));
  if (!sourceStable || !cleanupOk || !artifactsValid || selected.some(rows => rows.length !== 1 || !cleanTraceExecution(rows[0].execution))) return { complete: false, status: 'incomplete' };
  const reg = selected.flat().find(row => row.name === 'regressions');
  if (reg && (reg.execution.testComplete !== true || reg.execution.testCount !== traceRegressionCount || JSON.stringify(reg.files) !== JSON.stringify(traceRegressionFiles))) return { complete: false, status: 'incomplete' };
  return { complete: true, status: selected.every(rows => rows[0].execution.ok) && (id === 'HW-15-03' || observationsValid) &&
    (id !== 'HW-15-04' || browserValid) ? 'passed' : 'failed' };
}
