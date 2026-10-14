import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectSemanticOffline } from './semantic-quality-offline.mjs';
import { qualitySources } from './quality-collector.mjs';
import { sourceSnapshot, validBuildSource, evidenceFiles } from './runner-evidence-contract.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function validateSemanticOfflineReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'semantic-offline', ok: false, status: 'not_run', stale: false, reasons: [], source: null,
    methods: ['synthetic-provider-and-review-infrastructure-only'], qualityStatus: 'not_run', qualityEvaluated: false,
    fullQualityAcceptance: false, releaseEligible: false, liveCalls: 0, fullProjectAcceptance: false };
  let cached; try { cached = await json(path.join(directory, 'summary.json')); }
  catch { result.reasons.push('missing_semantic_offline_summary'); return result; }
  result.status = 'incomplete';
  try {
    await evidenceFiles(directory);
    const run = await json(path.join(directory, 'run/run.json')), target = await qualitySources(), current = await sourceSnapshot();
    result.source = { sha: run.sourceStart?.sha, dirty: run.sourceStart?.dirty };
    result.stale = !isDeepStrictEqual(run.sourceStart, target) || !isDeepStrictEqual(run.sourceEnd, target);
    if (result.stale) result.reasons.push('source_or_environment_changed');
    assert.equal(validBuildSource(current), true, 'invalid_semantic_runtime_build');
    const actual = await inspectSemanticOffline(path.join(directory, 'run'), target, { release });
    assert.equal(actual.infrastructurePassed, true, 'semantic_offline_raw_evidence_rejected'); assert.equal(actual.complete, true);
    assert.deepEqual(cached, actual, 'semantic_offline_summary_mismatch');
    for (const key of ['qualityStatus', 'qualityEvaluated', 'fullQualityAcceptance', 'releaseEligible', 'liveCalls']) assert.deepEqual(actual[key], result[key]);
    assert.ok(actual.properties.length > 0 && actual.properties.every(row => row.status === 'not_run'));
    result.scope = { infrastructureOnly: true, ...actual.scope, properties: actual.properties };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
