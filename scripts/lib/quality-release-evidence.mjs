import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectOfflineQualityEvidence } from './quality-offline-evidence.mjs';
import { qualitySources } from './quality-collector.mjs';
import { sourceSnapshot, validBuildSource, evidenceFiles } from './runner-evidence-contract.mjs';
export async function validateQualityInfrastructureEvidence(directory, { release = true } = {}) {
  const result = { kind: 'quality-offline', ok: false, status: 'not_run', stale: false, reasons: [], source: null,
    methods: ['loopback-infrastructure-only'], qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, fullProjectAcceptance: false };
  let cached; try { cached = JSON.parse(await readFile(path.join(directory, 'offline-summary.json'), 'utf8')); }
  catch { result.reasons.push('missing_offline_infrastructure_evidence'); return result; }
  result.status = 'incomplete';
  try {
    await evidenceFiles(directory); const target = await qualitySources(), current = await sourceSnapshot();
    assert.equal(validBuildSource(current), true);
    const actual = await inspectOfflineQualityEvidence(directory, target, { release });
    assert.equal(actual.infrastructurePassed, true); assert.equal(actual.complete, true); assert.deepEqual(cached, actual);
    assert.equal(actual.qualityStatus, 'not_run'); assert.equal(actual.qualityEvaluated, false); assert.equal(actual.liveCalls, 0); assert.equal(actual.fullQualityAcceptance, false);
    result.source = { sha: actual.source.sha, dirty: actual.source.dirty };
    result.scope = { infrastructureOnly: true, asrTrials: actual.asrTrials, mtTrials: actual.mtTrials, properties: actual.properties };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
