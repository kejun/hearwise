import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { realtimeMetrics, freezeRealtimePolicy, compareRealtime, auditRealtimeComparison, evaluateLimits, hash } from '../scripts/lib/realtime-comparison.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { profileEvidenceDirectory } from '../test-support/profile-test-evidence.mjs';

test('unknown or failed per-metric budgets never become a pass', () => {
  assert.equal(evaluateLimits({ a: 1 }, { a: 2 }, { a: null })[0].status, 'not_run');
  const fallback = 'latency.finalToTranslationHttpObservedMs.p95';
  assert.equal(evaluateLimits({ [fallback]: null }, { [fallback]: 50 }, { [fallback]: { maxAbsolute: 100, maxIncrease: 100 } })[0].status, 'not_applicable');
  assert.equal(evaluateLimits({ [fallback]: null }, { [fallback]: null }, { [fallback]: null })[0].status, 'not_applicable');
  assert.equal(evaluateLimits({ a: 1 }, { a: null }, { a: { maxAbsolute: 3, maxIncrease: 3 } })[0].status, 'incomplete');
  assert.equal(evaluateLimits({ a: 1 }, { a: 2 }, { a: { maxAbsolute: 3, maxIncrease: 0 } })[0].status, 'failed');
  assert.equal(evaluateLimits({ a: 1 }, { a: 2 }, { a: { maxAbsolute: 1, maxIncrease: 3 } })[0].status, 'failed');
});

test('real bounded captures bind frozen policy and comparison independently reads raw evidence', { timeout: 80000 }, async () => {
  const root = await profileEvidenceDirectory('realtime-comparison'), deadline = Date.now() + 75000;
  const capture = async policy => {
    const before = new Set(await readdir(root));
    const execution = await runProcess(process.execPath, ['scripts/verify-realtime-baseline.mjs', '--profile=smoke', ...(policy ? [`--policy=${policy}`] : [])], { env: { ...process.env, REALTIME_EVIDENCE_DIR: root }, timeoutMs: Math.min(45000, Math.max(1, deadline - Date.now() - 5000)), logFile: path.join(root, policy ? 'candidate.log' : 'baseline.log') });
    assert.equal(execution.code, 0, execution.tail);
    const name = (await readdir(root)).find(name => name.startsWith('smoke-') && !before.has(name));
    return path.join(root, name);
  };
  const baseline = await capture(), original = JSON.parse(await readFile(path.join(baseline, 'report.json'), 'utf8'));
  // Deliberately broad synthetic regression-test budgets, NOT product SLOs.
  const limits = Object.fromEntries(Object.keys(realtimeMetrics(original)).map(key => [key, { maxAbsolute: 1e15, maxIncrease: 1e15 }]));
  limits['postStop.providerAsrConnections.max'] = { maxAbsolute: 0, maxIncrease: 0 };
  const policyPath = path.join(root, 'frozen-policy.json');
  const policy = await freezeRealtimePolicy(baseline, limits, policyPath);
  await assert.rejects(freezeRealtimePolicy(baseline, limits, policyPath), /EEXIST/);
  const candidate = await capture(policyPath), result = await compareRealtime(baseline, candidate, policy);
  assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.fullProjectAcceptance, false);
  await writeFile(path.join(root, 'comparison.json'), JSON.stringify(result));
  assert.equal((await auditRealtimeComparison(baseline, candidate, policy, result)).ok, true);
  const forged = structuredClone(result); forged.results[0].candidate = -1;
  await assert.rejects(auditRealtimeComparison(baseline, candidate, policy, forged));
  const file = path.join(candidate, 'report.json'), bytes = await readFile(file), report = JSON.parse(bytes);
  for (const mutate of [
    r => { r.environment.cpu = 'other CPU'; },
    r => { r.tools.node = 'v0'; },
    r => { r.profile = 'baseline'; },
    r => { r.complete = false; r.runs[0].execution.timedOut = true; },
    r => { r.comparisonPolicyDigest = '0'.repeat(64); },
    r => { r.startedAt = '2000-01-01T00:00:00Z'; },
    r => { r.runs[0].result.quiescent[0].providerAsrConnections = 1; },
    r => { r.runs[0].artifacts.pop(); },
    r => { r.plan.scope = 'real-vendor-end-to-end'; }
  ]) {
    try { const changed = structuredClone(report); mutate(changed); await writeFile(file, JSON.stringify(changed)); assert.equal((await compareRealtime(baseline, candidate, policy)).status, 'incomplete'); }
    finally { await writeFile(file, bytes); }
  }
  const interrupted = path.join(root, 'interrupted'); await mkdir(interrupted);
  const stopped = await runProcess(process.execPath, ['scripts/verify-realtime-baseline.mjs', '--profile=smoke', `--policy=${policyPath}`], { env: { ...process.env, REALTIME_EVIDENCE_DIR: interrupted }, timeoutMs: 1, logFile: path.join(interrupted, 'timeout.log') });
  assert.equal(stopped.timedOut, true);
  assert.equal((await compareRealtime(baseline, interrupted, policy)).status, 'incomplete');
  // Rewriting an un-hashed summary and backdating a policy cannot invent a
  // pre-capture freeze: the original hashed runtime event keeps the old digest.
  try {
    const postHoc = structuredClone(policy); postHoc.limits['latency.audioToCaptionMs.p95'].maxAbsolute = 1e16;
    const changed = structuredClone(report); changed.comparisonPolicyDigest = hash(postHoc);
    await writeFile(file, JSON.stringify(changed));
    const rejected = await compareRealtime(baseline, candidate, postHoc);
    assert.equal(rejected.status, 'incomplete'); assert.match(rejected.reasons.join(' '), /policy digest reconstructed/);
  } finally { await writeFile(file, bytes); }
  const raw = path.join(candidate, 'repeat-1/resources.jsonl'), rawBytes = await readFile(raw);
  try { await writeFile(raw, ''); assert.equal((await compareRealtime(baseline, candidate, policy)).status, 'incomplete'); }
  finally { await writeFile(raw, rawBytes); }
});
