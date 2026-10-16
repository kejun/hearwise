import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { readbackBaseline } from './realtime-readback.mjs';
import { baselinePhases } from './realtime-baseline.mjs';

export const hash = value => digest(JSON.stringify(value));
const load = async directory => JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
const finite = value => Number.isFinite(value) && value >= 0;
const percentile = values => values.length && values.every(finite) ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const maximum = values => values.length && values.every(finite) ? Math.max(...values) : null;
const identity = report => { const { loadAtStart, ...environment } = report.environment; return { environment, tools: report.tools, planDigest: report.planDigest, profile: report.profile, scope: report.plan.scope }; };

// Only consume fields independently reconstructed by readbackBaseline. Each
// metric says what it measures; elapsed phase time includes post-stop draining.
export function realtimeMetrics(report) {
  const results = report.runs.map(row => row.result), metrics = {};
  const samples = results.flatMap(row => row.samples).filter(row => row.phase !== 'warmup');
  for (const key of ['audioToCaptionMs', 'finalToTranslationMs', 'audioToTranslationMs', 'finalToKnowledgeMs', 'audioToKnowledgeMs', 'finalToTranslationHttpObservedMs', 'finalToKnowledgeHttpObservedMs']) {
    metrics[`latency.${key}.p95`] = percentile(samples.map(row => row[key]).filter(Number.isFinite));
  }
  for (const key of ['startToFirstPcmMs', 'audioToFirstPcmMs']) metrics[`transport.${key}.p95`] = percentile(results.flatMap(row => row.runs).filter(row => row.phase !== 'warmup').map(row => row[key]));
  for (const phase of baselinePhases.filter(name => name !== 'warmup')) metrics[`phase.${phase}.maxElapsedMs`] = maximum(results.flatMap(row => row.phases).filter(row => row.name === phase).map(row => row.elapsedMs));
  const checkpoints = results.flatMap(row => row.quiescent);
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) metrics[`postStop.${key}.maxBytes`] = maximum(checkpoints.map(row => row.resource.memory[key]));
  for (const key of ['total', 'socket', 'file', 'pipe', 'other']) metrics[`postStop.descriptors.${key}.max`] = maximum(checkpoints.map(row => row.resource.descriptors[key]));
  metrics['postStop.activeResources.max'] = maximum(checkpoints.map(row => Object.values(row.resource.activeResources).reduce((sum, n) => sum + n, 0)));
  metrics['postStop.providerAsrConnections.max'] = maximum(checkpoints.map(row => row.providerAsrConnections));
  metrics['run.cpuMicroseconds.max'] = maximum(results.map(row => row.resourceSummary.cpuMicroseconds.user + row.resourceSummary.cpuMicroseconds.system));
  return metrics;
}

export async function freezeRealtimePolicy(directory, limits, output) {
  await readbackBaseline(directory);
  const baseline = await load(directory);
  assert.equal(baseline.source.dirty, false, 'freeze requires clean source');
  assert.equal(baseline.negative, 'none');
  assert.ok(Date.parse(baseline.finishedAt) <= Date.now());
  const metrics = realtimeMetrics(baseline);
  assert.deepEqual(Object.keys(limits).sort(), Object.keys(metrics).sort(), 'explicit limit (or null) for every metric');
  for (const limit of Object.values(limits)) assert.ok(limit === null || (Object.keys(limit).sort().join(',') === 'maxAbsolute,maxIncrease' && finite(limit.maxAbsolute) && finite(limit.maxIncrease)), 'limits are nonnegative absolute/increase budgets or unknown null');
  const policy = { schemaVersion: 1, kind: 'realtime-comparison-policy', scope: 'bounded-loopback-only', frozenAt: new Date().toISOString(), baselineDigest: hash(baseline), baselineIdentity: { source: baseline.source, buildDigest: baseline.buildDigest }, identity: identity(baseline), limits };
  // A frozen file is write-once. A changed policy is a new run, not a retune.
  await writeFile(output, JSON.stringify(policy, null, 2) + '\n', { flag: 'wx' });
  return policy;
}

export async function compareRealtime(directory, candidateDirectory, policy) {
  const result = { schemaVersion: 1, kind: 'bounded-realtime-comparison', scope: 'bounded-loopback-only', evaluatedAt: new Date().toISOString(), status: 'incomplete', comparable: false, evaluated: false, passed: false, acceptanceStatus: 'not_run', fullProjectAcceptance: false, results: [], reasons: [] };
  try {
    assert.equal(policy.schemaVersion, 1); assert.equal(policy.kind, 'realtime-comparison-policy'); assert.equal(policy.scope, result.scope);
    const baseline = await load(directory), candidate = await load(candidateDirectory);
    Object.assign(result, { baselineDigest: hash(baseline), candidateDigest: hash(candidate), policyDigest: hash(policy), baselineSource: baseline.source, candidateSource: candidate.source });
    assert.equal(hash(baseline), policy.baselineDigest, 'baseline differs from pre-candidate freeze');
    assert.deepEqual(policy.baselineIdentity, { source: baseline.source, buildDigest: baseline.buildDigest });
    assert.equal(baseline.source.dirty, false); assert.equal(candidate.source.dirty, false);
    assert.deepEqual(candidate.source, sourceVersion());
    assert.equal(candidate.comparisonPolicyDigest, hash(policy), 'candidate must bind policy before starting');
    assert.ok(Date.parse(baseline.finishedAt) <= Date.parse(policy.frozenAt) && Date.parse(policy.frozenAt) <= Date.parse(candidate.startedAt), 'freeze precedes candidate');
    assert.deepEqual(identity(baseline), policy.identity); assert.deepEqual(identity(candidate), policy.identity, 'incomparable load/runtime/environment/provider scope');
    assert.equal(baseline.negative, 'none'); assert.equal(candidate.negative, 'none');
    await readbackBaseline(directory, { frozenIdentity: policy.baselineIdentity });
    await readbackBaseline(candidateDirectory);
    const before = realtimeMetrics(baseline), after = realtimeMetrics(candidate);
    assert.deepEqual(Object.keys(policy.limits).sort(), Object.keys(before).sort(), 'all metrics need an explicit budget or null');
    result.comparable = true;
    result.results = evaluateLimits(before, after, policy.limits);
    result.status = result.results.some(row => row.status === 'incomplete') ? 'incomplete' : result.results.some(row => row.status === 'not_run') ? 'not_run' : result.results.some(row => row.status === 'failed') ? 'failed' : 'passed';
    result.evaluated = result.results.every(row => ['passed', 'failed'].includes(row.status));
    result.passed = result.status === 'passed';
  } catch (error) { result.reasons.push(error.message); }
  return result;
}

export function evaluateLimits(before, after, limits) {
  const results = [];
  for (const [metric, value] of Object.entries(after)) {
      const limit = limits[metric], base = before[metric];
      if (limit !== null) assert.ok(limit && Object.keys(limit).sort().join(',') === 'maxAbsolute,maxIncrease' && finite(limit.maxAbsolute) && finite(limit.maxIncrease), 'invalid metric limit');
      const status = !finite(value) || !finite(base) ? 'incomplete' : limit === null ? 'not_run' : value <= limit.maxAbsolute && value - base <= limit.maxIncrease ? 'passed' : 'failed';
      results.push({ metric, baseline: base, candidate: value, limit, status });
    }
  return results;
}

export async function auditRealtimeComparison(baseline, candidate, policy, report) {
  const rebuilt = await compareRealtime(baseline, candidate, policy);
  const { evaluatedAt, ...expected } = rebuilt;
  const { evaluatedAt: savedAt, ...saved } = report;
  assert.ok(Number.isFinite(Date.parse(savedAt)), "comparison timestamp");
  assert.deepEqual(saved, expected, "comparison must reproduce from original evidence");
  return { ok: true, status: rebuilt.status, fullProjectAcceptance: false };
}
