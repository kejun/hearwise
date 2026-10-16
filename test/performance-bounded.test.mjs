import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freezeBoundedPolicy, boundedLimitMs } from '../scripts/lib/performance-bounded.mjs';
import { comparePerformance, policyDigest } from '../scripts/lib/performance-policy.mjs';
import { performanceProfiles, performanceTimeoutsFor } from '../verification/performance/profile.mjs';
function fixture() {
  const conditions = time => ({ recordedAt: time, loadAverage: [1, 1, 1], freeMemoryBytes: 1000 });
  const baseline = { schemaVersion: 1, kind: 'history-graph-performance', profile: 'bounded', collectionComplete: true,
    source: { sha: 'a'.repeat(40), dirty: false }, startedAt: '2026-10-15T10:00:00Z', finishedAt: '2026-10-15T10:01:00Z',
    environmentDigest: 'e'.repeat(64), configurationDigest: 'c'.repeat(64), measurementDigest: 'b'.repeat(64),
    inputDatabaseDigests: { small: 'd'.repeat(64), 'small-import': 'f'.repeat(64) }, sampling: { warmups: 0, repetitions: 3 },
    conditions: { before: conditions('2026-10-15T10:00:00Z'), after: conditions('2026-10-15T10:01:00Z') },
    cases: [{ id: 'small/graph', status: 'collected', samples: [2, 3, 4].map((wallMs, index) => ({ index, warmup: false, metrics: { wallMs } })) }] };
  const targets = { status: 'approved', releaseLead: 'synthetic test only', approvedAt: '2026-10-15T09:00:00Z',
    conditionLimits: { maxHostLoadAverage1m: 5, minHostFreeMemoryBytes: 500 },
    budgets: { 'small/graph': { wallMs: { maxObserved: 10, maxRatioMax: 1.5, maxToP50Ratio: 10 } } } };
  const policy = freezeBoundedPolicy(baseline, targets, '2026-10-15T10:02:00Z');
  const candidate = structuredClone(baseline); candidate.source.sha = 'b'.repeat(40);
  candidate.startedAt = '2026-10-15T10:03:00Z'; candidate.finishedAt = '2026-10-15T10:04:00Z';
  candidate.conditions = { before: conditions(candidate.startedAt), after: conditions(candidate.finishedAt) };
  candidate.policyAtStart = { digest: policyDigest(policy), capturedAt: '2026-10-15T10:02:30Z' };
  return { baseline, candidate, policy, targets };
}
test('bounded profile preserves all small-loopback behaviors with three observations, not population p95', () => {
  assert.deepEqual(performanceProfiles.bounded, { sampling: { warmups: 0, repetitions: 3 }, tiers: ['small'], networks: ['loopback'], releaseCollection: false });
  assert.ok(boundedLimitMs < 600000); assert.equal(performanceTimeoutsFor('bounded').runMs, 180000);
  const result = comparePerformance(fixture()); assert.equal(result.passed, true);
  assert.equal(result.results[0].statistic, 'max'); assert.equal(result.results[0].sampleCount, 3);
  assert.equal(Object.hasOwn(result.results[0], 'p95Ratio'), false);
});
test('unapproved targets stay draft and cannot grant a pass', () => {
  const f = fixture(); const draft = freezeBoundedPolicy(f.baseline, null, f.policy.frozenAt);
  assert.equal(draft.status, 'draft'); assert.equal(draft.budgets, null);
  assert.equal(comparePerformance({ ...f, policy: draft }).performanceEvaluated, false);
  for (const modify of [t => t.status = 'draft', t => t.releaseLead = '', t => t.approvedAt = '2026-10-16T10:00:00Z', t => delete t.budgets['small/graph'], t => t.budgets['small/graph'].wallMs.maxRatioMax = 0.1]) {
    const g = fixture(); modify(g.targets); assert.throws(() => freezeBoundedPolicy(g.baseline, g.targets, g.policy.frozenAt));
  }
});
test('observed-max absolute and relative regressions are both rejected', () => {
  for (const limit of ['maxObserved', 'maxRatioMax']) {
    const f = fixture(); f.targets.budgets['small/graph'].wallMs[limit] = limit === 'maxObserved' ? 5 : 1.2;
    f.policy = freezeBoundedPolicy(f.baseline, f.targets, f.policy.frozenAt);
    f.candidate.policyAtStart.digest = policyDigest(f.policy); f.candidate.cases[0].samples[2].metrics.wallMs = 6;
    const result = comparePerformance(f); assert.equal(result.performanceEvaluated, true); assert.equal(result.passed, false); assert.equal(result.reason, 'performance_regression');
  }
});
test('partial, timeout, altered data/environment, omitted cases and after-candidate policies fail closed', () => {
  for (const modify of [f => f.candidate.collectionComplete = false,
    f => f.candidate.inputDatabaseDigests['small-import'] = 'a'.repeat(64),
    f => f.candidate.environmentDigest = 'a'.repeat(64), f => f.candidate.measurementDigest = 'd'.repeat(64),
    f => f.candidate.cases = [], f => f.candidate.cases[0].samples.pop(),
    f => f.policy.supportedScope = [], f => f.policy.frozenAt = f.candidate.finishedAt,
    f => f.candidate.conditions.after.loadAverage[0] = 10, f => f.candidate.sampling.repetitions = 2]) {
    const f = fixture(); modify(f); assert.equal(comparePerformance(f).performanceEvaluated, false, modify.toString());
  }
});
test('daily performance job remains capped at ten minutes and runs the raw pair reader', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const section = workflow.split('  performance-smoke:')[1].split('  performance-baseline:')[0];
  assert.match(section, /timeout-minutes: 10/); assert.match(section, /performance:bounded --/); assert.match(section, /performance:bounded:report --/);
});
