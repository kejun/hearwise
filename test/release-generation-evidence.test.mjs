import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { technicalSuites, domainSuites, budgets } from '../verification/release/policy.mjs';
import { readTechnicalEvidence, releaseEvidence } from '../scripts/lib/release-evidence.mjs';
import { validateGenerationFinalSummary } from '../scripts/lib/generation-release-evidence.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';

test('generation is a mandatory seventeenth suite without removing existing domain obligations', () => {
  assert.equal(technicalSuites.length, 17);
  assert.equal(technicalSuites.filter(suite => suite === 'generation-protocol').length, 1);
  for (const group of ['HW-04', 'HW-10', 'HW-14', 'HW-15']) assert.ok(domainSuites[group].includes('generation-protocol'));
  assert.deepEqual(budgets['generation-protocol'], { fastMs: 2100000, deepMs: 4200000, supervisorGraceMs: 15000,
    regressionMs: 180000, mutationMs: 120000, processMs: 60000 });
});

test('missing and forged generation evidence cannot pass through the release dispatcher', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-generation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = await readTechnicalEvidence('generation-protocol', directory, { release: false });
  assert.equal(missing.ok, false); assert.equal(missing.status, 'not_run');
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ source: sourceVersion(), profile: 'fast',
    complete: true, ok: true, results: [], artifacts: [], tools: { node: process.version, sqlite: process.versions.sqlite } }));
  const forged = await readTechnicalEvidence('generation-protocol', directory, { release: false });
  assert.equal(forged.ok, false); assert.equal(forged.status, 'incomplete'); assert.ok(forged.rows.length === 52);
  assert.ok(forged.rows.every(row => row.status !== 'passed'));
  const aggregate = await releaseEvidence({ schemaVersion: 1, evidence: [{ suite: 'generation-protocol', directory }] },
    { purpose: 'pr', release: false, base: sourceVersion().sha });
  assert.equal(aggregate.ok, false); assert.equal(aggregate.fullAcceptance, false);
  assert.ok(aggregate.rows.some(row => row.suite === 'generation-protocol' && !row.ok));
});

test('aggregate waits for generation and M1 while retaining all previously required CI jobs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = workflow.slice(workflow.indexOf('\n  release-evidence:'));
  const needs = release.match(/\n    needs: \[([^\]]+)\]/)[1].split(',').map(value => value.trim());
  assert.deepEqual(needs, ['test', 'relation-protocol', 'knowledge-protocol', 'import-protocol', 'edit-protocol',
    'process-crash', 'playback-protocol', 'scheduler', 'name-protocol', 'browser', 'revision', 'generation-protocol', 'm1-protocols']);
});

// This isolates finalization from the existing 52-stage raw reader. A complete
// current-source positive is still provided by the actual CI generation suite.
test('release requires a finalized result and its independently recomputed complete summary', () => {
  const checked = { ok: true, reasons: [], rows: [{ id: 'observed-stage', status: 'passed', reasons: [] }],
    target: { source: { sha: 'a'.repeat(40), dirty: false }, sourceDigests: { 'runtime.mjs': 'b'.repeat(64) },
      environment: { platform: 'linux', arch: 'x64', osRelease: 'aggregate-host', node: process.version } },
    propertyCoverage: [{ id: 'HW-04-17', checks: ['observed-stage'] }], boundary: 'finite profile' };
  const environment = { ...checked.target.environment, osRelease: 'collector-host' };
  const report = { ok: true, environment, summary: { ...structuredClone(checked), target: { ...structuredClone(checked.target), environment: structuredClone(environment) } } };
  assert.equal(validateGenerationFinalSummary(report, checked), true);
  for (const change of [r => delete r.ok, r => r.ok = false, r => delete r.summary,
    r => r.error = 'parent did not finalize', r => r.summary.rows = [], r => r.summary.ok = false,
    r => r.summary.target.source.sha = 'c'.repeat(40), r => r.summary.target.environment.osRelease = 'forged-host']) {
    const candidate = structuredClone(report); change(candidate);
    assert.throws(() => validateGenerationFinalSummary(candidate, checked));
  }
});
