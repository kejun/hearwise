import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectTraceBusinessEvidence, saveTraceRegressionFailure } from '../test-support/trace-business-worker.mjs';
import { expectedTraceMutations } from '../test-support/trace-business-negative.mjs';
import { validateTraceBusinessObservations, tracePropertyState, validTraceBrowser, sameTraceSources, checkTraceArtifacts,
  traceSourceSnapshot, traceBrowserChecks, traceStateLabels, traceRegressionFiles, traceEvidenceScope } from '../test-support/trace-business-evidence.mjs';
import { digest, metadata, validateResult } from '../scripts/lib/verification-evidence.mjs';
import { traceBusinessProperties } from '../verification/trace-business-properties.mjs';

let baseline, target;
before(async () => {
  baseline = await collectTraceBusinessEvidence();
  if (!baseline.ok) await saveTraceRegressionFailure(process.env.TRACE_REGRESSION_FAILURE_FILE ||
    path.join(process.env.TEST_EVIDENCE_DIR || 'test-evidence', 'trace-regression-failure.json'), baseline);
  assert.equal(baseline.ok, true, JSON.stringify(baseline.failure));
  target = { source: baseline.source, mutations: await expectedTraceMutations() };
}, { timeout: 40000 });
const execution = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, testComplete: true, testCount: 51 };
const options = () => ({ checks: ['workflows', 'regressions'].map(name => ({ name, ...(name === 'regressions' ? { files: traceRegressionFiles } : {}), execution: { ...execution } })),
  observationsValid: true, artifactsValid: true, browserValid: false, sourceStable: true, cleanupOk: true, nodeOnly: true });
const reject = change => { const value = structuredClone(baseline); change(value); assert.equal(validateTraceBusinessObservations(value, target).ok, false); };

test('actual workflow, boundary, build and mutation evidence validates its complete declared scope', async () => {
  assert.deepEqual(validateTraceBusinessObservations(baseline, target), { ok: true, workflowCases: 11, boundaryCases: 4, mutants: 2 });
  assert.deepEqual(tracePropertyState('HW-15-02', options()), { complete: true, status: 'passed' });
  assert.deepEqual(tracePropertyState('HW-15-04', options()), { complete: false, status: 'not_run' });
  const context = await metadata(), now = new Date().toISOString();
  for (const property of traceBusinessProperties) assert.equal(validateResult({ ...context, property: { id: property.id, version: property.version },
    startedAt: now, finishedAt: now, complete: true, status: 'passed', scope: traceEvidenceScope(property),
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: 'a'.repeat(64) })) }), true);
});
test('missing business snapshots, cases and wrong durable terminal state fail closed', () => {
  reject(value => delete value.workflows[0].captures[0].query);
  reject(value => value.workflows.pop()); reject(value => value.boundaries.pop());
  const full = value => value.boundaries.find(row => row.name === 'full-public-boundary').actual;
  reject(value => full(value).relationRequests.push(full(value).relationRequests[0]));
  reject(value => full(value).durable.relation_requests[0].attempt = 2);
  reject(value => {
    const job = full(value).durable.relation_jobs[0], input = JSON.parse(job.input_json);
    input.focus_segments.pop(); job.input_json = JSON.stringify(input);
  });
  reject(value => full(value).relationRequests[0].focus_segments[1].translation = 'stale translation');

  reject(value => value.workflows[0].captures[0].query.checkpoint.job.state = 'failed');
  reject(value => value.workflows[0].captures[0].calls.length = 0);
  reject(value => value.workflows.find(row => row.name === 'knowledge-retry').captures[0].query.checkpoint.job.state = 'complete');
  reject(value => value.workflows.find(row => row.name === 'knowledge-empty').captures.at(-1).query.checkpoint.job.state = 'failed');
  reject(value => value.workflows.find(row => row.name === 'relation-old-generation-usage').captures[1].query.graph.relations.push({ id: 'unexpected' }));
  reject(value => { const row = value.boundaries.find(row => row.name === 'translation-failure-retry'); row.failed.rawInput = row.recovered.rawInput; row.failed.report = row.recovered.report; });
});
test('old source, old instrumentation, incomplete captures and tampered report views cannot pass', () => {
  reject(value => value.source.sha = '0'.repeat(40)); reject(value => value.complete = false);
  reject(value => value.workflows[0].captures[0].snapshot.events[0].build.instrumentation_version = 2);
  reject(value => value.workflows[0].captures[0].snapshot.events.shift());
  reject(value => value.workflows[0].captures[0].business.tasks[0].state = 'failed');
});
test('negative controls must match actual source mutation and observed mismatch, not success markers', () => {
  reject(value => value.negative.results[0].normalSha256 = '1'.repeat(64));
  reject(value => value.negative.results[0].detected = false);
  reject(value => value.negative.results[0].observedStates = ['waiting']);
  reject(value => value.negative.results[1].businessObjects = 1);
  reject(value => value.negative.results[1] = value.negative.results[0]);
  reject(value => delete value.negative.results[0].capture); reject(value => value.negative.results[0].comparison.state = 'failed');
});
test('interruption, missing TAP and browser failure retain scoped and incomplete outcomes', () => {
  for (const patch of [{ timedOut: true }, { interrupted: true }, { signal: 'SIGTERM' }, { testComplete: false }, { testCount: 1 }]) {
    const input = options(); Object.assign(input.checks[1].execution, patch);
    assert.notEqual(tracePropertyState('HW-15-03', input).status, 'passed');
  }
  const browserFailure = { ...options(), nodeOnly: false };
  browserFailure.checks.push({ name: 'browser', execution: { ...execution, code: 1, ok: false } });
  assert.equal(tracePropertyState('HW-15-02', browserFailure).status, 'passed');
  assert.equal(tracePropertyState('HW-15-04', browserFailure).status, 'failed');
  for (const field of ['sourceStable', 'cleanupOk', 'artifactsValid']) {
    assert.equal(tracePropertyState('HW-15-02', { ...options(), [field]: false }).status, 'incomplete');
  }
  const omittedFile = options(); omittedFile.checks[1].files = traceRegressionFiles.slice(1);
  assert.equal(tracePropertyState('HW-15-03', omittedFile).status, 'incomplete');
});
test('changed or missing declared sources invalidate evidence even while both workspaces are dirty', async () => {
  const start = await traceSourceSnapshot(); assert.equal(sameTraceSources(start, start), true);
  const changed = structuredClone(start); changed.digests['server.mjs'] = '2'.repeat(64); assert.equal(sameTraceSources(start, changed), false);
  delete changed.digests['server.mjs']; assert.equal(sameTraceSources(start, changed), false);
  const absent = structuredClone(start); delete absent.digests['dist/server/index.js']; assert.equal(sameTraceSources(absent, absent), false);
});
test('browser gate binds every declared scope and exact artifact bytes rather than a generic ok', async t => {
  const browser = { complete: true, ok: true, cleanup: true, chromium: 'locked-test-version', errors: [], networkRequests: [],
    checks: traceBrowserChecks.map(id => ({ id, complete: true, ok: true, counts: {
      domains: 5, unownedPreviews: 1, cases: 6, tasks: 4, eventIdentities: 4,
      missingBoundary: 1, jsonlUnknown: 1, safeExports: 1, mobileWidth: 390 } })) };
  const full = baseline.boundaries.find(row => row.name === 'full-public-boundary');
  browser.terminalObservations = Object.entries(traceStateLabels).map(([state, text]) => ({ state, text, badges: 1 }));
  browser.identityObservations = ['translation', 'knowledge', 'relation', 'speech'].map(domain => {
    const task = full.business.tasks.find(row => row.domain === domain), event = full.report.spans.find(row => row.id === task.focus).events[0];
    return { domain, taskId: task.id, jobId: task.job, eventId: event.event_id, listeningId: full.actual.listeningId };
  });
  browser.captureObservations = { jsonl: '完整性未知', missing: '采集不完整', exportedEvents: full.report.eventCount, mobileOverflow: false };
  assert.equal(validTraceBrowser(browser, baseline), true);
  for (const mutate of [value => value.checks.pop(), value => value.errors.push('error'), value => value.networkRequests.push('https://example.invalid'),
    value => value.cleanup = false, value => value.checks[0].counts.domains = 4, value => value.checks[1].counts.cases = 0,
    value => value.identityObservations = [], value => value.terminalObservations[0].text = 'failed', value => value.identityObservations[0].jobId = 'foreign']) {
    const value = structuredClone(browser); mutate(value); assert.equal(validTraceBrowser(value, baseline), false);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-artifact-gate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'evidence.json'), 'actual'); const artifacts = [{ path: 'evidence.json', sha256: digest('actual') }];
  assert.equal(await checkTraceArtifacts(directory, artifacts, ['evidence.json']), true);
  assert.equal(await checkTraceArtifacts(directory, artifacts, ['evidence.json', 'missing.png']), false);
  await writeFile(path.join(directory, 'evidence.json'), 'changed'); assert.equal(await checkTraceArtifacts(directory, artifacts, ['evidence.json']), false);
});
