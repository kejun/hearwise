import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateGenerationEvidence } from './generation-protocol-report.mjs';
import { sourceVersion } from './verification-evidence.mjs';

export function validateGenerationFinalSummary(report, checked) {
  assert.equal(report.ok, true, 'generation_not_finalized');
  assert.equal(Object.hasOwn(report, 'error'), false, 'generation_final_error');
  // The original reader's host environment is recorded, not rewritten to the
  // later aggregate host. All source/build fields and recomputed conclusions
  // remain exact; the environment itself stays bound to the original report.
  const expected = { ...checked, target: { ...checked.target, environment: report.environment } };
  assert.deepEqual(report.summary, expected, 'generation_final_summary_changed');
  return true;
}

// The domain reader already rechecks every native trace, command, full TAP tree,
// actual durable frame, negative boundary, source/build hash and deadline.
// This adapter adds only the common release result shape and exact runtime tools.
export async function validateGenerationReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const checked = await validateGenerationEvidence(directory, { release, requireProfile });
  const result = { ...checked, kind: 'generation-protocol', source: null, status: 'not_run', ok: false,
    stale: checked.reasons.some(reason => reason.includes('stale')),
    methods: ['finite-state-complete', 'bounded-model-check', 'actual-late-callback-sqlite-http-replay'], fullProjectAcceptance: false };
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return result; }
  result.source = report?.source ?? null; result.status = 'incomplete';
  try {
    assert.equal(checked.ok, true, 'generation_domain_not_passed');
    validateGenerationFinalSummary(report, checked);
    assert.deepEqual(report.source, sourceVersion(), 'generation_source_changed');
    assert.equal(report.tools.node, process.version, 'generation_node_changed');
    assert.equal(report.tools.sqlite, process.versions.sqlite, 'generation_sqlite_changed');
    assert.equal(report.environment.node, report.tools.node, 'generation_environment_node_changed');
    assert.equal(report.environment.platform, process.platform, 'generation_platform_changed');
    assert.equal(report.environment.arch, process.arch, 'generation_arch_changed');
    result.scope = { profile: report.profile, domain: report.domain, propertyCoverage: checked.propertyCoverage,
      checks: report.results.map(row => ({ id: row.id, kind: row.kind, bound: row.bound, metrics: row.metrics, timeoutMs: row.timeoutMs })),
      overallTimeoutMs: report.overallTimeoutMs, boundary: checked.boundary };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons = [...result.reasons, error.message]; }
  return result;
}
