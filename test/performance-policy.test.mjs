import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleStatistics, comparePerformance, policyDigest } from '../scripts/lib/performance-policy.mjs';

test('quantiles use the documented nearest-rank rule and preserve raw variability', () => {
  const result = sampleStatistics(Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual({ count: result.count, min: result.min, p50: result.p50, p90: result.p90, p95: result.p95, p99: result.p99, max: result.max },
    { count: 20, min: 1, p50: 10, p90: 18, p95: 19, p99: 20, max: 20 });
  assert.equal(result.mean, 10.5); assert.ok(result.standardDeviation > 5);
  for (const values of [[], [null], [undefined], [NaN], [Infinity], [-1], ['2']]) assert.throws(() => sampleStatistics(values));
});

const baseline = () => ({ schemaVersion: 1, kind: 'history-graph-performance', collectionComplete: true, source: { sha: 'a'.repeat(40), dirty: false },
  startedAt: '2026-10-14T10:00:00.000Z', finishedAt: '2026-10-14T10:01:00.000Z',
  environmentDigest: 'e'.repeat(64), configurationDigest: 'c'.repeat(64), measurementDigest: 'a'.repeat(64), inputDatabaseDigests: { small: 'd'.repeat(64) },
  cases: [{ id: 'small/normal/graph', status: 'collected', samples: [1, 2, 3].map((value, index) => ({ index, warmup: false, metrics: { wallMs: value, cpuMs: value, heapBytes: 100 } })) }],
  sampling: { warmups: 0, repetitions: 3 }, policyAtStart: null,
  conditions: { before: { recordedAt: '2026-10-14T10:00:00Z', loadAverage: [1, 1, 1], freeMemoryBytes: 1000 }, after: { recordedAt: '2026-10-14T10:01:00Z', loadAverage: [1, 1, 1], freeMemoryBytes: 1000 } } });
function fixture() {
  const before = baseline(), candidate = structuredClone(before);
  candidate.source.sha = 'b'.repeat(40); candidate.startedAt = '2026-10-14T12:00:00.000Z'; candidate.finishedAt = '2026-10-14T12:01:00.000Z';
  candidate.conditions.before.recordedAt = candidate.startedAt; candidate.conditions.after.recordedAt = candidate.finishedAt;
  const policy = { schemaVersion: 1, status: 'frozen', frozenAt: '2026-10-14T11:00:00.000Z', releaseLead: 'fixture reviewer',
    baselineSha256: policyDigest(before), baselineSourceSha: before.source.sha,
    environmentDigest: before.environmentDigest, configurationDigest: before.configurationDigest,
    measurementDigest: before.measurementDigest,
    inputDatabaseDigests: before.inputDatabaseDigests, sampling: before.sampling,
    quantile: 'nearest-rank', supportedScope: ['small/normal/graph'],
    conditionLimits: { maxHostLoadAverage1m: 2, minHostFreeMemoryBytes: 500 },
    budgets: { 'small/normal/graph': { wallMs: { p95Max: 10, p95RatioMax: 1.5, maxToP50Ratio: 4 },
      cpuMs: { p95Max: 10, p95RatioMax: 1.5, maxToP50Ratio: 4 }, heapBytes: { p95Max: 200, p95RatioMax: 1.2, maxToP50Ratio: 2 } } } };
  candidate.policyAtStart = { digest: policyDigest(policy), capturedAt: '2026-10-14T11:59:59.000Z' };
  return { before, candidate, policy };
}

test('a complete baseline with no frozen thresholds is not a performance pass', () => {
  assert.deepEqual(comparePerformance({ baseline: baseline(), candidate: baseline() }),
    { comparable: false, performanceEvaluated: false, passed: false, reason: 'thresholds_not_frozen', results: [] });
});

test('same-environment frozen budgets are evaluated from raw samples', () => {
  const { before, candidate, policy } = fixture();
  const result = comparePerformance({ baseline: before, candidate, policy });
  assert.equal(result.comparable, true); assert.equal(result.performanceEvaluated, true); assert.equal(result.passed, true);
  candidate.cases[0].samples[2].metrics.wallMs = 40;
  assert.equal(comparePerformance({ baseline: before, candidate, policy }).passed, false);
});

test('missing metrics, changed environment/load/sampling and late policies cannot pass', () => {
  const changes = [
    c => { c.environmentDigest = 'f'.repeat(64); }, c => { c.configurationDigest = 'f'.repeat(64); },
    c => { c.inputDatabaseDigests.small = 'f'.repeat(64); }, c => { c.sampling.warmups = 1; },
    c => { delete c.cases[0].samples[0].metrics.cpuMs; }, c => { c.cases[0].samples[0].metrics.heapBytes = null; },
    c => { c.cases[0].samples.pop(); }, c => { c.cases[0].samples[1].index = 0; },
    c => { c.cases[0].status = 'not_run'; }, c => { c.source.dirty = true; },
    c => { c.policyAtStart.digest = 'f'.repeat(64); }, c => { c.policyAtStart.capturedAt = c.finishedAt; },
    c => { c.startedAt = '2026-10-14T10:30:00.000Z'; }, c => { c.collectionComplete = false; },
    c => { c.conditions.before.loadAverage[0] = 3; }, c => { c.conditions.after.freeMemoryBytes = null; },
    c => { c.measurementDigest = 'f'.repeat(64); }, c => { c.conditions.before.recordedAt = '2026-10-14T10:00:00Z'; },
    c => { [c.conditions.before.recordedAt, c.conditions.after.recordedAt] = [c.conditions.after.recordedAt, c.conditions.before.recordedAt]; },
    c => { c.conditions.after.recordedAt = '2026-10-14T12:02:00Z'; }
  ];
  for (const change of changes) {
    const { before, candidate, policy } = fixture(); change(candidate);
    const result = comparePerformance({ baseline: before, candidate, policy });
    assert.equal(result.passed, false, change.toString()); assert.equal(result.performanceEvaluated, false, change.toString());
  }
});

test('incomplete policy and post-hoc budget edits cannot be silently accepted', () => {
  for (const change of [p => { delete p.budgets['small/normal/graph'].cpuMs; }, p => { p.budgets['small/normal/graph'].wallMs.p95Max = 999; },
    p => { p.releaseLead = ''; }, p => { p.supportedScope = []; }, p => { p.quantile = 'invented'; }]) {
    const { before, candidate, policy } = fixture(); change(policy);
    assert.equal(comparePerformance({ baseline: before, candidate, policy }).passed, false);
  }
});
