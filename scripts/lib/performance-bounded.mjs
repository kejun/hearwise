import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { comparePerformance, policyDigest, sampleStatistics } from './performance-policy.mjs';
import { validatePerformanceEvidence } from './performance-evidence.mjs';

export const boundedLimitMs = 450000;
export const boundedExclusions = ['medium and large datasets', 'constrained network', 'population p95/p99 or tail reliability', 'user devices', 'product release acceptance'];
export function freezeBoundedPolicy(baseline, targets = null, now = new Date().toISOString()) {
  assert.equal(baseline.profile, 'bounded');
  assert.equal(baseline.collectionComplete, true);
  assert.equal(baseline.source.dirty, false);
  assert.ok(Date.parse(now) >= Date.parse(baseline.finishedAt));
  const supportedScope = baseline.cases.filter(row => row.status === 'collected').map(row => row.id);
  assert.ok(supportedScope.length > 0);
  if (targets) {
    assert.equal(targets.status, 'approved', 'Targets must be explicitly approved before candidate collection');
    assert.ok(typeof targets.releaseLead === 'string' && targets.releaseLead.trim());
    assert.ok(Number.isFinite(Date.parse(targets.approvedAt)) && Date.parse(targets.approvedAt) <= Date.parse(now));
    assert.deepEqual(Object.keys(targets.budgets).sort(), [...supportedScope].sort());
    for (const row of baseline.cases.filter(row => row.status === 'collected')) {
      assert.deepEqual(Object.keys(targets.budgets[row.id]).sort(), Object.keys(row.samples[0].metrics).sort());
      for (const budget of Object.values(targets.budgets[row.id])) {
        assert.deepEqual(Object.keys(budget).sort(), ['maxObserved', 'maxRatioMax', 'maxToP50Ratio'].sort());
        assert.ok(Object.values(budget).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0));
        assert.ok(budget.maxRatioMax >= 1 && budget.maxToP50Ratio >= 1);
      }
    }
    assert.deepEqual(Object.keys(targets.conditionLimits).sort(), ['maxHostLoadAverage1m', 'minHostFreeMemoryBytes']);
    assert.ok(Object.values(targets.conditionLimits).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0));
  }
  return { schemaVersion: 1, statistic: 'max', quantile: 'nearest-rank', status: targets ? 'frozen' : 'draft', frozenAt: now,
    releaseLead: targets?.releaseLead || null, approvedTargets: targets, targetsSha256: targets ? policyDigest(targets) : null,
    baselineSha256: policyDigest(baseline), baselineSourceSha: baseline.source.sha,
    environmentDigest: baseline.environmentDigest, configurationDigest: baseline.configurationDigest, measurementDigest: baseline.measurementDigest,
    inputDatabaseDigests: baseline.inputDatabaseDigests, sampling: baseline.sampling, supportedScope,
    budgets: targets?.budgets || null, conditionLimits: targets?.conditionLimits || null };
}

export async function compareBoundedDirectories(baselineDirectory, candidateDirectory, policy, { candidateTarget = null } = {}) {
  const baseline = JSON.parse(await readFile(path.join(baselineDirectory, 'report.json'), 'utf8'));
  const candidate = JSON.parse(await readFile(path.join(candidateDirectory, 'report.json'), 'utf8'));
  const blocked = detail => ({ evidenceValid: false, comparable: false, performanceEvaluated: false, passed: false, reason: 'invalid_collection_evidence', detail, results: [] });
  try {
    assert.deepEqual(policy, freezeBoundedPolicy(baseline, policy.approvedTargets, policy.frozenAt), 'Frozen policy differs from baseline/approved targets');
    for (const report of [baseline, candidate]) {
      assert.equal(report.profile, 'bounded');
      assert.deepEqual(report.sampling, { warmups: 0, repetitions: 3 });
      for (const key of ['environmentDigest', 'configurationDigest', 'measurementDigest']) assert.equal(report[key], policy[key], `${key} changed`);
      assert.deepEqual(report.inputDatabaseDigests, policy.inputDatabaseDigests, 'Frozen database changed');
    }
    assert.equal(candidate.policyAtStart?.digest, policyDigest(policy));
    assert.ok(Date.parse(policy.frozenAt) <= Date.parse(candidate.policyAtStart.capturedAt));
    assert.ok(Date.parse(candidate.policyAtStart.capturedAt) <= Date.parse(candidate.startedAt));
    const baselineValidation = await validatePerformanceEvidence(baselineDirectory, { cleanSource: true, target: {
      source: baseline.source, sourceDigests: baseline.sourceDigests, runtimeBuild: baseline.runtimeBuild } });
    const candidateValidation = await validatePerformanceEvidence(candidateDirectory, { cleanSource: true, target: candidateTarget });
    assert.equal(baselineValidation.valid, true, JSON.stringify(baselineValidation));
    assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation));
    const observations = baseline.cases.filter(row => row.status === 'collected').flatMap(before => {
      const after = candidate.cases.find(row => row.id === before.id);
      assert.equal(after?.status, 'collected');
      return Object.keys(before.samples[0].metrics).map(metric => {
        const baselineMax = sampleStatistics(before.samples.map(row => row.metrics[metric])).max;
        const candidateMax = sampleStatistics(after.samples.map(row => row.metrics[metric])).max;
        return { id: before.id, metric, statistic: 'max', sampleCount: 3, baselineMax, candidateMax,
          ratio: baselineMax > 0 ? candidateMax / baselineMax : candidateMax === 0 ? 1 : null };
      });
    });
    return { evidenceValid: true, targetsApproved: policy.status === 'frozen', observations, ...comparePerformance({ baseline, candidate, policy }),
      scope: 'bounded-three-sample-observed-max', sampleCount: 3, excluded: boundedExclusions,
      sameSourceCalibration: baseline.source.sha === candidate.source.sha,
      baselineSourceSha: baseline.source.sha, candidateSourceSha: candidate.source.sha,
      baselineSha256: policyDigest(baseline), candidateSha256: policyDigest(candidate), policySha256: policyDigest(policy) };
  } catch (error) { return blocked(error.message); }
}
