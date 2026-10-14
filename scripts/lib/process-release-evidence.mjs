import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { processEvidenceDefinition, validateProcessEvidence } from './process-crash-evidence.mjs';
import { formalCommandContract } from './formal-release-evidence.mjs';
import { validateFlatTap } from './release-tap-evidence.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource, evidenceFiles } from './runner-evidence-contract.mjs';
import { sourceVersion } from './verification-evidence.mjs';
import regressionNames from '../../verification/release/process-regressions.json' with { type: 'json' };
export const processRegressionContract = { files: ['test/process-crash-replay.test.mjs', 'test/process-crash-lock.test.mjs', 'test/process-crash-trace.test.mjs'], count: 36, cwd: 'evidence' };
export async function validateProcessReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const checked = await validateProcessEvidence(directory, { release, requireProfile });
  const result = { ...checked, kind: 'process-crash', source: null, status: 'not_run', ok: false, stale: checked.reasons.includes('stale'),
    methods: ['full-finite-state-exploration', 'bounded-model-check', 'actual-sigkill-http-sqlite-replay'], fullProjectAcceptance: false };
  let report; try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return result; }
  result.source = report.source; result.status = checked.rows.some(row => row.status === 'failed') ? 'failed' : 'incomplete';
  try {
    assert.equal(checked.ok, true); await evidenceFiles(directory);
    assert.deepEqual(report.source, sourceVersion());
    assert.ok(sameSourceSnapshot(report.sourceStart, report.sourceEnd) && validBuildSource(report.sourceStart) && validBuildSource(report.sourceEnd));
    assert.deepEqual(report.sourceStart.source, report.source); assert.deepEqual(report.sourceEnd, await sourceSnapshot());
    await formalCommandContract('process-crash', report, processEvidenceDefinition, processRegressionContract);
    const regression = report.results.find(row => row.id === 'implementation-regressions');
    validateFlatTap(await readFile(path.join(directory, regression.log), 'utf8'), regressionNames);
    for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
      const row = report.results.find(row => row.id === id), replays = JSON.parse(await readFile(path.join(directory, row.data), 'utf8'));
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, row.log), 'utf8')), replays.map(replay => ({ trace: replay.sourceTrace, classification: replay.classification, complete: replay.complete, ok: replay.ok, steps: replay.steps })));
    }
    result.scope = { profile: report.profile, domain: report.domain, exclusions: report.domain.exclusions, processCoverage: checked.processCoverage,
      checks: report.results.map(row => ({ id: row.id, kind: row.kind, bound: row.bound, timeoutMs: row.timeoutMs, metrics: row.metrics })) };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons = [...result.reasons, error.message]; }
  return result;
}
