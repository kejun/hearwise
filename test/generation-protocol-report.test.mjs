import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixedTrace } from '../test-support/generation-trace-fixture.mjs';
import { createGenerationProtocolAdapter } from '../test-support/generation-protocol-adapter.mjs';
import { replayGenerationTrace } from '../scripts/lib/generation-protocol-replay.mjs';
import { validateGenerationControl, generationHeaderReasons } from '../scripts/lib/generation-protocol-report.mjs';
import { generationRepositoryRoot, generationPlan, generationCommand, generationCommandConclusion, generationCoverage,
  loadGenerationConfig, loadGenerationTools } from '../scripts/lib/generation-protocol-plan.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
const config = await loadGenerationConfig();
for (const control of config.implementationControls) test(`raw negative-control gate requires actual ${control.id} divergence and valid normal comparison`, { timeout: 20000 }, async t => {
  const trace = await fixedTrace(t, control.protocol, 1, 1, control.witness, true);
  const normal = await replayGenerationTrace(trace, createGenerationProtocolAdapter);
  const broken = await replayGenerationTrace(trace, options => createGenerationProtocolAdapter(options, { mutation: control.mutation }));
  const data = { control, normal, broken }, context = { repositoryRoot: generationRepositoryRoot,
    sourceDigests: { 'relation-storage.mjs': digest(await readFile(new URL('../relation-storage.mjs', import.meta.url))) } };
  assert.deepEqual(await validateGenerationControl(trace, control, data, context), { ok: true, reasons: [] });
  const corruptions = [value => { value.normal.observations.at(-1).durable.raw.durable = {}; },
    value => { value.broken.classification = 'matched'; }, value => { value.broken.counterexample.steps.pop(); },
    value => { value.broken.observations[0].durable.raw.queries = {}; }, value => { value.broken.difference.step++; },
    value => { value.control = { ...value.control, mutation: 'none' }; }];
  if (control.mutation === 'omit_transaction_guard') corruptions.push(
    value => { value.broken.observations.at(-1).durable.boundaryTrials[0].metadata.originalSha256 = 'a'.repeat(64); },
    value => { value.broken.observations.at(-1).durable.boundaryTrials[0].inputRestored = false; });
  for (const [index, mutate] of corruptions.entries()) { const changed = structuredClone(data); mutate(changed);
    assert.equal((await validateGenerationControl(trace, control, changed, context)).ok, false, `corruption ${index}`); }
});

test('generation report header binds exact source, toolchain, build, environment, properties and complete execution', async () => {
  const pinned = await loadGenerationTools(), hash = 'a'.repeat(64), source = { sha: 'b'.repeat(40), dirty: false };
  const target = { source, sourceDigests: { 'dist/server/index.js': hash }, modelDigest: hash, lockDigest: hash,
    runtimeBuild: { git_sha: source.sha, build_dirty: false, instrumentation_version: 3 } };
  const report = { ...target, schemaVersion: 1, specificationVersion: '1.0', modelVersion: 1, profile: 'fast', domain: config,
    propertyCoverage: generationCoverage(config), overallTimeoutMs: config.profiles.fast.overallTimeoutMs,
    startedAt: '2026-10-14T12:00:00Z', finishedAt: '2026-10-14T12:20:00Z', environment: { platform: 'linux', arch: 'x64', osRelease: 'test' }, complete: true,
    execution: { complete: true, code: 0, signal: null, timedOut: false, interrupted: false, pid: 123, repositoryRoot: '/repo', evidenceRoot: '/evidence' },
    tools: { quint: pinned.quint.version, apalache: pinned.apalache.version, tlc: pinned.apalache.bundledTlcVersion,
      apalacheJarSha256: pinned.apalache.jarSha256, apalacheArchiveSha256: pinned.apalache.archiveSha256, java: 'openjdk version "21"', node: 'v24.0.0', sqlite: '3.50.4' } };
  report.supervisor = { startedAt: report.startedAt, finishedAt: report.finishedAt, cwd: '/repo',
    argv: ['/repo/scripts/verify-generation-protocol.mjs', '--worker', '/evidence', 'fast'], timeoutMs: report.overallTimeoutMs + 15000,
    execution: { code: 0, signal: null, timedOut: false, interrupted: false } };
  assert.deepEqual(generationHeaderReasons(report, target, config, pinned, { release: true }), []);
  const changes = [r => { r.source.sha = 'c'.repeat(40); }, r => { r.modelDigest = 'd'.repeat(64); }, r => { r.sourceDigests = {}; },
    r => { r.runtimeBuild.git_sha = 'e'.repeat(40); }, r => { r.propertyCoverage.pop(); }, r => { r.execution.timedOut = true; },
    r => { delete r.execution; }, r => { r.finishedAt = r.startedAt.replace('12:00', '11:00'); }, r => { r.environment = {}; },
    r => { r.tools.apalache = 'different'; }, r => { r.overallTimeoutMs++; }, r => { r.domain.domains.pop(); }, r => { r.source.dirty = true; }];
  for (const change of changes) { const changed = structuredClone(report); change(changed); assert.notEqual(generationHeaderReasons(changed, target, config, pinned, { release: true }).length, 0); }
});

test('generation plan keeps complete domains, exact trace rosters and rejects incomplete command outcomes', () => {
  const plan = generationPlan(config);
  assert.equal(plan.filter(row => row.kind === 'finite-state-complete').length, 8);
  assert.equal(plan.filter(row => row.kind === 'bounded-model-check').length, 8);
  for (const refined of [false, true]) {
    assert.equal(plan.filter(row => row.kind === 'model-witness' && row.refined === refined).reduce((sum, row) => sum + row.count, 0), 39);
    assert.equal(plan.filter(row => row.kind === 'simulation' && row.refined === refined).reduce((sum, row) => sum + row.count, 0), 18);
  }
  const entry = plan.find(row => row.kind === 'bounded-model-check');
  const command = generationCommand(entry, config, 'fast', { repositoryRoot: '/repo', evidenceRoot: '/evidence', port: 12345 });
  assert.ok(command.argv.includes('/repo/verification/generation-protocol/relation-finite.qnt'));
  assert.equal(command.bound, 8); assert.equal(command.timeoutMs, 240000);
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  const log = 'Step 8: The outcome is: NoError\n[ok] No violation found';
  assert.equal(generationCommandConclusion(entry, execution, log, 8).ok, true);
  for (const patch of [{ code: 1 }, { signal: 'SIGTERM' }, { timedOut: true }, { interrupted: true }]) assert.equal(generationCommandConclusion(entry, { ...execution, ...patch }, log, 8).ok, false);
  assert.equal(generationCommandConclusion(entry, execution, log, 12).ok, false);
});
