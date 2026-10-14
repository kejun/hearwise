import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const policyDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const ratio = (value, base) => base === 0 ? value === 0 ? 1 : Infinity : value / base;

export function sampleStatistics(values) {
  assert.ok(Array.isArray(values) && values.length > 0 && values.every(finite), 'Metrics must be present, finite, nonnegative numbers');
  const sorted = [...values].sort((a, b) => a - b), count = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const nearest = quantile => sorted[Math.max(0, Math.ceil(quantile * count) - 1)];
  return { count, min: sorted[0], p50: nearest(.5), p90: nearest(.9), p95: nearest(.95), p99: nearest(.99), max: sorted.at(-1), mean,
    standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count), quantile: 'nearest-rank' };
}

function samplesFor(report, id, metrics) {
  const rows = report.cases.filter(row => row.id === id);
  assert.equal(rows.length, 1, `Missing or duplicate case ${id}`);
  const row = rows[0], { warmups, repetitions } = report.sampling;
  assert.equal(row.status, 'collected', `${id} was not collected`);
  assert.ok(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(repetitions) && repetitions > 0);
  assert.equal(row.samples.length, warmups + repetitions, `${id} sample count differs`);
  for (let i = 0; i < row.samples.length; i++) {
    const sample = row.samples[i];
    assert.equal(sample.index, i); assert.equal(sample.warmup, i < warmups);
    assert.ok(sample.metrics && same(Object.keys(sample.metrics).sort(), [...metrics].sort()), `${id} metric roster differs`);
    assert.ok(metrics.every(key => finite(sample.metrics[key])), `${id} contains missing/non-finite metrics`);
  }
  return Object.fromEntries(metrics.map(key => [key, sampleStatistics(row.samples.filter(sample => !sample.warmup).map(sample => sample.metrics[key]))]));
}

// Collection can succeed before thresholds are frozen. This comparator is the
// separate release decision and can never turn absent targets into a pass.
export function comparePerformance({ baseline, candidate, policy }) {
  const blocked = reason => ({ comparable: false, performanceEvaluated: false, passed: false, reason, results: [] });
  if (!policy || policy.status !== 'frozen') return blocked('thresholds_not_frozen');
  try {
    assert.equal(policy.schemaVersion, 1);
    assert.ok(typeof policy.releaseLead === 'string' && policy.releaseLead.trim());
    assert.ok(date(policy.frozenAt)); assert.equal(policy.quantile, 'nearest-rank');
    assert.ok(Array.isArray(policy.supportedScope) && policy.supportedScope.length > 0 && new Set(policy.supportedScope).size === policy.supportedScope.length);
    assert.ok(same(Object.keys(policy.budgets || {}).sort(), [...policy.supportedScope].sort()));
    assert.ok(same(Object.keys(policy.conditionLimits || {}).sort(), ['maxHostLoadAverage1m', 'minHostFreeMemoryBytes']));
    assert.ok(finite(policy.conditionLimits.maxHostLoadAverage1m) && finite(policy.conditionLimits.minHostFreeMemoryBytes));
    for (const report of [baseline, candidate]) {
      assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'history-graph-performance');
      assert.equal(report.collectionComplete, true); assert.equal(report.source.dirty, false);
      assert.match(report.source.sha, /^[a-f0-9]{40}$/);
      assert.ok(date(report.startedAt) && date(report.finishedAt) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
      assert.ok(sha(report.environmentDigest) && sha(report.configurationDigest));
      assert.equal(report.environmentDigest, policy.environmentDigest);
      assert.equal(report.configurationDigest, policy.configurationDigest);
      assert.ok(sha(report.measurementDigest)); assert.equal(report.measurementDigest, policy.measurementDigest);
      assert.ok(same(report.inputDatabaseDigests, policy.inputDatabaseDigests));
      assert.ok(Object.keys(report.inputDatabaseDigests).length > 0 && Object.values(report.inputDatabaseDigests).every(sha));
      assert.ok(same(report.sampling, policy.sampling));
      assert.ok(Array.isArray(report.cases));
      for (const observation of [report.conditions?.before, report.conditions?.after]) {
        assert.ok(date(observation?.recordedAt) && Array.isArray(observation.loadAverage) && observation.loadAverage.length === 3 && observation.loadAverage.every(finite));
        assert.ok(Date.parse(observation.recordedAt) >= Date.parse(report.startedAt) && Date.parse(observation.recordedAt) <= Date.parse(report.finishedAt), 'Load observation belongs to a different collection interval');
        assert.ok(finite(observation.freeMemoryBytes));
        if (observation.loadAverage[0] > policy.conditionLimits.maxHostLoadAverage1m || observation.freeMemoryBytes < policy.conditionLimits.minHostFreeMemoryBytes)
          return blocked('environment_load_outside_frozen_policy');
      }
      assert.ok(Date.parse(report.conditions.before.recordedAt) <= Date.parse(report.conditions.after.recordedAt), 'Load observation order reversed');
    }
    assert.equal(policy.baselineSha256, policyDigest(baseline));
    assert.equal(policy.baselineSourceSha, baseline.source.sha);
    assert.ok(Date.parse(baseline.finishedAt) <= Date.parse(policy.frozenAt));
    assert.ok(Date.parse(policy.frozenAt) <= Date.parse(candidate.startedAt));
    assert.equal(candidate.policyAtStart?.digest, policyDigest(policy));
    assert.ok(date(candidate.policyAtStart?.capturedAt) && Date.parse(policy.frozenAt) <= Date.parse(candidate.policyAtStart.capturedAt) &&
      Date.parse(candidate.policyAtStart.capturedAt) <= Date.parse(candidate.startedAt));
    const results = [];
    for (const id of policy.supportedScope) {
      const budgets = policy.budgets[id], metrics = Object.keys(budgets);
      assert.ok(metrics.length > 0);
      const before = samplesFor(baseline, id, metrics), after = samplesFor(candidate, id, metrics);
      for (const metric of metrics) {
        const budget = budgets[metric];
        assert.ok(same(Object.keys(budget).sort(), ['maxToP50Ratio', 'p95Max', 'p95RatioMax']));
        assert.ok(finite(budget.p95Max) && finite(budget.p95RatioMax) && budget.p95RatioMax >= 1 && finite(budget.maxToP50Ratio) && budget.maxToP50Ratio >= 1);
        if (ratio(before[metric].max, before[metric].p50) > budget.maxToP50Ratio || ratio(after[metric].max, after[metric].p50) > budget.maxToP50Ratio)
          return blocked('measurement_variability_exceeds_policy');
        const relative = ratio(after[metric].p95, before[metric].p95);
        results.push({ id, metric, baseline: before[metric], candidate: after[metric], budget, p95Ratio: Number.isFinite(relative) ? relative : null,
          passed: after[metric].p95 <= budget.p95Max && relative <= budget.p95RatioMax });
      }
    }
    return { comparable: true, performanceEvaluated: true, passed: results.every(result => result.passed),
      reason: results.every(result => result.passed) ? 'within_frozen_policy' : 'performance_regression', results };
  } catch (error) { return { ...blocked('incomparable_or_invalid_evidence'), detail: error.message }; }
}
