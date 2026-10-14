import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backendPhases, backendMetrics } from '../../verification/performance/profile.mjs';
import { validateBackendResponse } from '../../test-support/performance-backend.mjs';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function deriveBackendMetrics(sample) {
  const { before, after, timing } = sample;
  assert.ok(Number.isSafeInteger(before.pid) && before.pid > 0); assert.equal(before.pid, after.pid);
  assert.ok(number(before.monotonicMs) && number(after.monotonicMs) && after.monotonicMs >= before.monotonicMs);
  assert.ok(number(before.timeOrigin) && before.timeOrigin > 0); assert.equal(before.timeOrigin, after.timeOrigin);
  assert.deepEqual(before.runtime, after.runtime);
  for (const key of ['node', 'sqlite', 'platform', 'arch']) assert.ok(typeof before.runtime?.[key] === 'string' && before.runtime[key]);
  for (const value of [before, after]) {
    assert.ok(number(value.cpuUsage.user) && number(value.cpuUsage.system));
    assert.ok(number(value.memoryUsage.rss) && value.memoryUsage.rss > 0);
    assert.ok(number(value.memoryUsage.heapUsed) && value.memoryUsage.heapUsed > 0);
    assert.ok(number(value.resourceUsage.maxRSS) && value.resourceUsage.maxRSS > 0);
  }
  assert.ok(after.cpuUsage.user >= before.cpuUsage.user && after.cpuUsage.system >= before.cpuUsage.system);
  assert.ok(after.resourceUsage.maxRSS >= before.resourceUsage.maxRSS, 'Server lifetime RSS high-water mark decreased');
  assert.ok(number(timing.timeOrigin) && timing.timeOrigin > 0 && number(timing.startedMonotonicMs) && number(timing.bodyReceivedMonotonicMs));
  assert.ok(timing.bodyReceivedMonotonicMs >= timing.startedMonotonicMs);
  const precisionMs = 2;
  assert.ok(before.timeOrigin + before.monotonicMs <= timing.timeOrigin + timing.startedMonotonicMs + precisionMs, 'Request precedes resource observation');
  assert.ok(timing.timeOrigin + timing.bodyReceivedMonotonicMs <= after.timeOrigin + after.monotonicMs + precisionMs, 'Body receipt follows resource observation');
  return { wallMs: timing.bodyReceivedMonotonicMs - timing.startedMonotonicMs,
    serverCpuMs: (after.cpuUsage.user - before.cpuUsage.user + after.cpuUsage.system - before.cpuUsage.system) / 1000,
    serverRssAfterBytes: after.memoryUsage.rss, serverHeapUsedAfterBytes: after.memoryUsage.heapUsed,
    serverLifetimeMaxRssAfterKiB: after.resourceUsage.maxRSS };
}

export function validateBackendEvidence(report, manifest) {
  const issues = [];
  try {
    assert.equal(report.schemaVersion, 1); assert.equal(report.component, 'backend'); assert.equal(report.complete, true);
    assert.ok(date(report.startedAt) && date(report.finishedAt) && Date.parse(report.startedAt) <= Date.parse(report.finishedAt));
    assert.equal(report.cleanup.complete, true); assert.deepEqual(report.providerRequests, []);
    assert.equal(report.error, undefined); assert.equal(report.server.input.sha256, manifest.database.sha256);
    assert.deepEqual(report.server.instrumentation, { kind: 'read-only-process-IPC-preload', source: 'test-support/performance-server-metrics.mjs' });
    assert.deepEqual(report.cases.map(row => row.phase), backendPhases);
    assert.ok(report.responseBodies && typeof report.responseBodies === 'object');
    const usedBodies = new Set(), verifiedBodies = new Map();
    let previous = null, serverTimeOrigin = null, runtime = null;
    const check = (sample, phase, negative = false) => {
      assert.equal(sample.before.pid, report.server.pid);
      serverTimeOrigin ??= sample.before.timeOrigin;
      assert.equal(sample.before.timeOrigin, serverTimeOrigin);
      runtime ??= sample.before.runtime; assert.deepEqual(sample.before.runtime, runtime);
      if (previous) {
        assert.ok(sample.before.monotonicMs >= previous.monotonicMs, 'Server observations are out of order');
        assert.ok(sample.before.cpuUsage.user >= previous.cpuUsage.user && sample.before.cpuUsage.system >= previous.cpuUsage.system, 'Cumulative CPU counters decreased');
        assert.ok(sample.before.resourceUsage.maxRSS >= previous.resourceUsage.maxRSS, 'Lifetime RSS high-water mark decreased across samples');
      }
      assert.ok(date(sample.startedAt) && date(sample.finishedAt) && Date.parse(sample.startedAt) <= Date.parse(sample.finishedAt));
      assert.ok(Date.parse(sample.startedAt) >= Date.parse(report.startedAt) && Date.parse(sample.finishedAt) <= Date.parse(report.finishedAt));
      const record = phase.startsWith('post-import') ? manifest.import.record : phase === 'record-secondary' ? manifest.secondary : manifest.primary;
      const route = phase.includes('history') ? `/api/listenings?page=${phase === 'history-second-page' ? 2 : 1}` :
        `/api/listenings/${record.id}${phase.includes('graph') ? '/graph' : '?page=1'}`;
      assert.equal(sample.route, route);
      assert.deepEqual(Object.keys(sample.metrics).sort(), [...backendMetrics].sort());
      assert.deepEqual(sample.metrics, deriveBackendMetrics(sample));
      previous = sample.after;
      assert.equal(sample.response.status, 200);
      const body = report.responseBodies[sample.response.sha256]; assert.ok(body); assert.equal(sample.response.body, undefined);
      usedBodies.add(sample.response.sha256);
      if (!verifiedBodies.has(sample.response.sha256)) {
        const bytes = Buffer.from(JSON.stringify(body)); assert.equal(sample.response.sha256, hash(bytes)); verifiedBodies.set(sample.response.sha256, bytes.length);
      }
      assert.equal(sample.response.bytes, verifiedBodies.get(sample.response.sha256));
      validateBackendResponse(phase, body, manifest);
      if (!negative) assert.equal(sample.controlledCost, null);
    };
    for (const row of report.cases) {
      assert.equal(row.id, `${manifest.workload.tier}/backend/${row.phase}`); assert.equal(row.status, 'collected');
      assert.equal(row.samples.length, manifest.sampling.warmups + manifest.sampling.repetitions);
      for (const [index, sample] of row.samples.entries()) {
        assert.equal(sample.index, index); assert.equal(sample.warmup, index < manifest.sampling.warmups); check(sample, row.phase);
      }
    }
    assert.equal(report.import.inputSha256, manifest.import.sha256);
    assert.equal(report.import.preview.addedCount, manifest.import.addedCount);
    assert.equal(report.import.result.addedCount, manifest.import.addedCount);
    assert.equal(report.import.result.ok, true); assert.equal(report.import.result.mode, 'append');
    assert.equal(report.import.destinationTotal, manifest.import.expectedTotal);
    check(report.negative, 'graph-primary', true);
    assert.equal(report.negative.controlledCost.kind, 'loopback-forwarding-response-delay');
    assert.equal(report.negative.controlledCost.requestedMs, 200); assert.equal(report.negative.controlledCost.forwardedRequests, 1);
    assert.ok(number(report.negative.controlledCost.observedMs) && report.negative.controlledCost.observedMs >= 190 && report.negative.metrics.wallMs >= 190);
    assert.deepEqual(Object.keys(report.responseBodies).sort(), [...usedBodies].sort(), 'Every saved full response is referenced by actual samples');
  } catch (error) { issues.push(error.message); }
  return { ok: issues.length === 0, issues };
}
