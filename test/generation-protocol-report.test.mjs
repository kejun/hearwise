import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import * as traceFixture from '../test-support/generation-trace-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';
import { fixedTrace, runGenerationWitness } from '../test-support/generation-trace-fixture.mjs';
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
    value => { value.control = { ...value.control, mutation: 'none' }; },
    value => { value.broken.observations.at(-1).durable.raw.queries = {}; },
    value => { value.broken.observations.at(-1).durable.raw.ledger = []; },
    value => { value.broken.observations.at(-1).durable.raw.durable.listening_runs = []; },
    value => { value.broken.observations.at(-1).durable.raw.durable.listening_runs[0].run_no = 99; },
    value => { value.broken.observations.at(-1).durable.raw.durable.segments[0].original_text = 'FORGED'; }];
  if (control.mutation === 'omit_transaction_guard') corruptions.push(
    value => { value.broken.observations.at(-1).durable.boundaryTrials[0].metadata.originalSha256 = 'a'.repeat(64); },
    value => { value.broken.observations.at(-1).durable.boundaryTrials[0].inputRestored = false; },
    value => { value.broken.observations.at(-1).durable.raw.durable.listenings[0].title = 'Unrelated change'; },
    value => { value.broken.observations.at(-1).durable.raw.durable.relation_assertions[0].statement = 'Unrelated assertion'; });
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
    execution: { code: 0, signal: null, timedOut: false, interrupted: false, durationMs: 1200000 } };
  assert.deepEqual(generationHeaderReasons(report, target, config, pinned, { release: true }), []);
  const changes = [r => { r.source.sha = 'c'.repeat(40); }, r => { r.modelDigest = 'd'.repeat(64); }, r => { r.sourceDigests = {}; },
    r => { r.runtimeBuild.git_sha = 'e'.repeat(40); }, r => { r.propertyCoverage.pop(); }, r => { r.execution.timedOut = true; },
    r => { delete r.execution; }, r => { r.finishedAt = r.startedAt.replace('12:00', '11:00'); }, r => { r.environment = {}; },
    r => { r.tools.apalache = 'different'; }, r => { r.overallTimeoutMs++; }, r => { r.domain.domains.pop(); }, r => { r.source.dirty = true; },
    r => { r.finishedAt = r.supervisor.finishedAt = '2027-10-14T12:20:00Z'; }, r => { r.supervisor.execution.durationMs = 100000000; }];
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

test('both exact regression rosters require every TAP body, order and test name', () => {
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  for (const entry of generationPlan(config).filter(row => row.kind === 'implementation-regression')) {
    const footer = `1..${entry.count}\n# tests ${entry.count}\n# suites 0\n# pass ${entry.count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
    const body = entry.names.map((name, i) => `ok ${i + 1} - ${name.replaceAll('\\', '\\\\').replaceAll('#', '\\#')}`).join('\n') + '\n';
    const good = 'TAP version 13\n' + body + footer;
    assert.equal(generationCommandConclusion(entry, execution, good).ok, true);
    for (const bad of ['TAP version 13\n' + footer, good.replace(entry.names[0], 'wrong test'), good.replace(/^ok 1 - .+\n/m, ''), good.replace('ok 2 -', 'ok 1 -'), good.replace(/^ok 2 - .+\n/m, '$&Bail out!\n')])
      assert.equal(generationCommandConclusion(entry, execution, bad).ok, false);
  }
});

test('witness invocation failures retain real exit signal output and elapsed diagnostics', async t => {
  await assert.rejects(fixedTrace(t, 'missing_protocol'), error => {
    const execution = error.witnessExecution;
    assert.equal(execution.code, 1); assert.equal(execution.signal, null); assert.equal(execution.killed, false);
    assert.equal(typeof execution.stdout, 'string'); assert.equal(typeof execution.stderr, 'string');
    assert.ok(execution.durationMs >= 0); assert.equal(execution.timeoutMs, 10000);
    assert.match(error.message, /Generation witness execution:/);
    return true;
  });
});
test('a shared witness deadline never resets between calls and records real child termination', async t => {
  const expired = performance.now() - 1;
  await assert.rejects(fixedTrace(t, 'knowledge', 1, 1, 'successfulRestartTest', true, { deadlineAt: expired }),
    error => error.code === 'GENERATION_WITNESS_BUDGET_EXHAUSTED');
  await assert.rejects(runGenerationWitness(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50, signal: t.signal }), error => {
    const execution = error.witnessExecution;
    assert.equal(execution.killed, true); assert.equal(execution.signal, 'SIGTERM');
    assert.equal(execution.timeoutMs, 50); assert.ok(execution.durationMs >= 0);
    return true;
  });
  await assert.rejects(fixedTrace(t, 'knowledge', 1, 1, 'successfulRestartTest', true, { deadlineAt: expired }),
    error => error.code === 'GENERATION_WITNESS_BUDGET_EXHAUSTED');
});

for (const mode of ['deadline', 'parent-abort']) test(`shared restart ${mode} closes the real adapter and blocks later actions`, { timeout: 15000 }, async t => {
  const adapter = await createGenerationProtocolAdapter({ protocol: 'knowledge', actors: 1, capacity: 1, refinement: 'fixed-ready-provider-permit-v1' });
  const database = adapter.observe().raw.database.file;
  let release, entered, starts = 0, closes = 0;
  const holding = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let cleaned = false;
  const close = async () => { if (!cleaned) { cleaned = true; closes++; await adapter.close(); release(); } };
  t.after(close);
  const controller = new AbortController();
  const factory = traceFixture.generationDeadlineFactory(async () => ({ ...adapter,
    async act(step) { starts++; await adapter.act(step); entered(); await holding; }, close }),
  { deadlineAt: performance.now() + (mode === 'deadline' ? 1000 : 10000), signal: controller.signal });
  const bounded = await factory({});
  const action = bounded.act({ action: 'permit', actor: -1, response: '' }); action.catch(() => {});
  await started;
  if (mode === 'parent-abort') controller.abort();
  await assert.rejects(deadline(() => action, 3000, 'deadline cancellation observation'), /Generation replay (deadline|aborted)/);
  await bounded.close();
  assert.equal(closes, 1); assert.equal(starts, 1);
  await assert.rejects(bounded.act({ action: 'permit', actor: -1, response: '' }), /Generation replay/);
  assert.equal(starts, 1); await assert.rejects(access(database), { code: 'ENOENT' });
});

test('parent abort closes an adapter that finishes initialization after cancellation', { timeout: 15000 }, async t => {
  const adapter = await createGenerationProtocolAdapter({ protocol: 'knowledge', actors: 1, capacity: 1, refinement: 'fixed-ready-provider-permit-v1' });
  const database = adapter.observe().raw.database.file;
  let release, entered, closes = 0;
  const holding = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => adapter.close());
  const controller = new AbortController();
  const factory = traceFixture.generationDeadlineFactory(async () => { entered(); await holding; return { ...adapter,
    async close() { closes++; await adapter.close(); } }; }, { deadlineAt: performance.now() + 10000, signal: controller.signal });
  const creating = factory({}); creating.catch(() => {});
  await started; controller.abort(); release();
  await assert.rejects(creating, /Generation replay aborted/);
  assert.equal(closes, 1); await assert.rejects(access(database), { code: 'ENOENT' });
});

test('parent abort waits for an active real restart before closing the reopened owner', { timeout: 15000 }, async t => {
  const adapter = await createGenerationProtocolAdapter({ protocol: 'knowledge', actors: 1, capacity: 1, refinement: 'fixed-ready-provider-permit-v1' });
  const database = adapter.observe().raw.database.file;
  let release, entered, closes = 0, starts = 0;
  const holding = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(async () => { release(); await adapter.close(); });
  const controller = new AbortController();
  const factory = traceFixture.generationDeadlineFactory(async () => ({ ...adapter,
    async act(step) { starts++; await adapter.act(step); entered(); await holding; },
    async close() { closes++; await adapter.close(); } }), { deadlineAt: performance.now() + 10000, signal: controller.signal });
  const bounded = await factory({});
  const action = bounded.act({ action: 'restart', actor: -1, response: '' }); action.catch(() => {});
  await started; controller.abort();
  await assert.rejects(action, /Generation replay aborted/);
  assert.equal(closes, 0, 'the in-flight close/reopen operation retains ownership until it settles');
  release(); await bounded.close();
  assert.equal(closes, 1); assert.equal(starts, 1);
  await assert.rejects(bounded.act({ action: 'restart', actor: -1, response: '' }), /Generation replay aborted/);
  assert.equal(starts, 1); await assert.rejects(access(database), { code: 'ENOENT' });
});

test('expired or already aborted replay factories never create resources', async () => {
  let starts = 0;
  const create = async () => { starts++; return { close() {} }; };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(traceFixture.generationDeadlineFactory(create, { deadlineAt: performance.now() + 1000, signal: controller.signal })({}), /Generation replay aborted/);
  await assert.rejects(traceFixture.generationDeadlineFactory(create, { deadlineAt: performance.now() - 1 })({}), /Generation replay deadline exceeded/);
  const active = new AbortController();
  const queued = traceFixture.generationDeadlineFactory(create, { deadlineAt: performance.now() + 1000, signal: active.signal })({});
  active.abort(); await assert.rejects(queued, /Generation replay aborted/);
  assert.equal(starts, 0);
});

test('parent abort between action enqueue and execution does not start actual work', { timeout: 15000 }, async t => {
  const adapter = await createGenerationProtocolAdapter({ protocol: 'knowledge', actors: 1, capacity: 1, refinement: 'fixed-ready-provider-permit-v1' });
  const database = adapter.observe().raw.database.file;
  let starts = 0, closes = 0;
  t.after(() => adapter.close());
  const controller = new AbortController();
  const bounded = await traceFixture.generationDeadlineFactory(async () => ({ ...adapter,
    async act(step) { starts++; await adapter.act(step); }, async close() { closes++; await adapter.close(); } }),
  { deadlineAt: performance.now() + 10000, signal: controller.signal })({});
  const action = bounded.act({ action: 'permit', actor: -1, response: '' });
  controller.abort(); await assert.rejects(action, /Generation replay aborted/); await bounded.close();
  assert.equal(starts, 0); assert.equal(closes, 1); await assert.rejects(access(database), { code: 'ENOENT' });
});

test('witness failure timelines distinguish output delivery from actual process exit and close', async () => {
  const check = execution => {
    const events = execution.lifecycle;
    assert.ok(events && Number.isSafeInteger(events.spawn.pid) && events.spawn.pid > 0);
    assert.ok(events.spawn.atMs >= 0);
    assert.equal(events.exit.code, execution.code); assert.equal(events.exit.signal, execution.signal);
    assert.equal(events.close.code, execution.code); assert.equal(events.close.signal, execution.signal);
    assert.ok(events.exit.atMs >= events.spawn.atMs && events.close.atMs >= events.exit.atMs);
    assert.ok(events.close.atMs <= execution.durationMs + 1);
    for (const stream of ['stdout', 'stderr']) {
      const output = events[stream]; assert.equal(output.bytes, Buffer.byteLength(execution[stream]));
      if (output.bytes === 0) assert.deepEqual(output, { chunks: 0, bytes: 0, firstAtMs: null, lastAtMs: null });
      else {
        assert.ok(Number.isSafeInteger(output.chunks) && output.chunks > 0);
        assert.ok(output.firstAtMs >= events.spawn.atMs && output.lastAtMs >= output.firstAtMs);
        assert.ok(output.lastAtMs <= events.close.atMs);
      }
    }
  };
  await assert.rejects(runGenerationWitness(['-e', "const fs=require('node:fs');fs.writeSync(1,'first\\nlast\\n');fs.writeSync(2,'problem\\n');process.exit(7)"]), error => {
    check(error.witnessExecution); assert.equal(error.witnessExecution.timeoutMs, 10000);
    assert.equal(error.witnessExecution.stdout, 'first\nlast\n'); assert.equal(error.witnessExecution.stderr, 'problem\n');
    assert.equal(error.witnessExecution.code, 7); assert.equal(error.witnessExecution.killed, false);
    assert.deepEqual(JSON.parse(error.message.split('Generation witness execution: ')[1]).lifecycle, error.witnessExecution.lifecycle);
    return true;
  });
  await assert.rejects(runGenerationWitness(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }), error => {
    check(error.witnessExecution); assert.equal(error.witnessExecution.signal, 'SIGTERM'); assert.equal(error.witnessExecution.killed, true);
    return true;
  });
});
