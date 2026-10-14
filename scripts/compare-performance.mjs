import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { comparePerformance, policyDigest } from './lib/performance-policy.mjs';
import { validatePerformanceEvidence } from './lib/performance-evidence.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const [baselineDirectory, candidateDirectory, policyFile, output] = process.argv.slice(2);
if (!baselineDirectory || !candidateDirectory || !policyFile || !output) throw new Error('Expected BASELINE_DIRECTORY CANDIDATE_DIRECTORY FROZEN_POLICY.json OUTPUT.json');
const baseline = JSON.parse(await readFile(path.join(baselineDirectory, 'report.json'), 'utf8'));
const candidate = JSON.parse(await readFile(path.join(candidateDirectory, 'report.json'), 'utf8'));
const policy = JSON.parse(await readFile(policyFile, 'utf8'));
// The old source snapshot is historical. Its exact report digest must already be
// bound by the release lead's pre-candidate policy; candidate source is checked
// against this checkout. Freeze the baseline only after its own clean-source gate.
const baselineBound = policy.baselineSha256 === policyDigest(baseline) && policy.baselineSourceSha === baseline.source.sha;
const baselineValidation = baselineBound ? await validatePerformanceEvidence(path.resolve(baselineDirectory), { release: true,
  target: { source: baseline.source, sourceDigests: baseline.sourceDigests, runtimeBuild: baseline.runtimeBuild } }) : { valid: false, issues: ['Baseline differs from frozen policy'] };
const candidateValidation = await validatePerformanceEvidence(path.resolve(candidateDirectory), { release: true });
const comparison = baselineValidation.valid && candidateValidation.valid ? comparePerformance({ baseline, candidate, policy }) :
  { comparable: false, performanceEvaluated: false, passed: false, reason: 'invalid_collection_evidence', results: [] };
const result = { schemaVersion: 1, kind: 'history-graph-performance-comparison', evaluatedAt: new Date().toISOString(),
  baselineSha256: policyDigest(baseline), candidateSha256: policyDigest(candidate), policySha256: policyDigest(policy),
  baselineValidation, candidateValidation, ...comparison };
await writeJson(output, result); console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
