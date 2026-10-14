import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../scripts/lib/process.mjs';
import { nameDeadlineAt, nameRemainingMs } from '../scripts/lib/name-protocol-budget.mjs';
const fileDeadline = nameDeadlineAt(80000);
process.env.HEARWISE_NAME_DEADLINE_AT = String(fileDeadline);
import { digest, writeJson } from '../scripts/lib/verification-evidence.mjs';
import { nameConfig, nameProtocolPlan, nameProtocolMetadata, nameInputBinding, nameStageCommand, validateNameCommand, strictNameTap,
  nameStageConclusion, nameWitnesses, nameNegatives, nameGateTests, nameTracePaths, nameConfiguration, nameTraceMain,
  validateNameModelNegative, validateNameReplay, validateNameProtocolEvidence, expectedNameMutationDigests } from '../scripts/lib/name-protocol-evidence.mjs';
import { normalizeNameTrace, replayNameTrace } from '../scripts/lib/name-protocol-replay.mjs';
import { createNameProtocolAdapter } from '../test-support/name-protocol-adapter.mjs';
const config = await nameConfig(), plan = nameProtocolPlan(config), execution = { code: 0, signal: null, timedOut: false, interrupted: false, durationMs: 1, cleanupComplete: true };
let directory;
const traces = new Map();
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'name-gate-tests-'));
  const env = { ...process.env, NODE_NO_WARNINGS: '1' }; delete env.NODE_TEST_CONTEXT;
  for (const main of config.witnesses.mains) {
    const result = await runProcess(process.execPath, [path.resolve('node_modules/@informalsystems/quint/dist/src/cli.js'), 'test',
      path.resolve('verification/name-protocol/witnesses.qnt'), '--main', main, '--backend', 'typescript', '--seed', '71', '--max-samples', '1',
      '--out-itf', path.join(directory, `${main}-{test}-{seq}.itf.json`)], { cwd: directory, env, timeoutMs: nameRemainingMs(fileDeadline, 20000, 5000) });
    assert.equal(result.ok, true, result.tail);
  }
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.itf.json'))) {
    const source = `witnesses/${file}`, bytes = await readFile(path.join(directory, file), 'utf8');
    traces.set(source, { bytes, trace: normalizeNameTrace(JSON.parse(bytes), nameConfiguration(nameTraceMain(source), config)) });
  }
}, { timeout: 45000 });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function realReplay(source, negative = null, deadlineAt = Math.min(fileDeadline, Date.now() + 25000)) {
  const { bytes, trace } = traces.get(source);
  const replay = await replayNameTrace(trace, options => createNameProtocolAdapter({ ...options, mutation: negative?.mutation || 'none' }), { deadlineAt });
  return { trace, bytes, value: { ...replay, sourceTrace: source, sourceTraceSha256: digest(bytes), semanticTraceSha256: digest(JSON.stringify(trace)), config: trace.config, steps: trace.steps.length } };
}
const tap = () => 'TAP version 13\n# Subtest: parent\n    # Subtest: child\n    ok 1 - child\n      ---\n      duration_ms: 1\n      ...\n    1..1\nok 1 - parent\n  ---\n  duration_ms: 2\n  ...\n1..1\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 3\n';

test(nameGateTests[0], () => {
  assert.equal(plan.length, 23); assert.equal(new Set(plan.map(row => row.id)).size, 23);
  assert.deepEqual(plan.filter(row => row.kind === 'bounded-model-check').map(row => row.bound), [6, 6]);
  assert.equal(config.limits.overallMs, 480000); assert.equal(plan.at(-1).timeoutMs, 90000); assert.equal(config.witnesses.expectedTestCount, 22);
  assert.equal(nameTracePaths(plan.find(row => row.id === 'replay-simulation'), config).length, 6);
  assert.equal(plan.filter(row => row.kind === 'model-negative').length, 5); assert.equal(nameNegatives.length, 4);
});
test(nameGateTests[1], () => {
  const stage = plan[4], binding = { buildCurrent: true, sourceDigest: 'exact', source: { sha: 'a'.repeat(40), dirty: false } };
  const startedAt = '2026-10-14T00:00:00.000Z';
  const result = { invocation: nameStageCommand(stage, config, directory, '127.0.0.1:12345'), inputStart: binding, inputEnd: binding,
    startedAt, finishedAt: '2026-10-14T00:00:00.001Z', execution: { ...execution, startedAt,
      budget: { timeoutMs: stage.timeoutMs, deadlineAt: Date.parse(startedAt) + stage.timeoutMs, childDeadlineAt: Date.parse(startedAt) + stage.timeoutMs - 1500 } } };
  assert.equal(validateNameCommand(result, stage, config, directory, binding), true);
  const origin = { repositoryRoot: '/ci/original/checkout', nodeExecutable: '/ci/node/bin/node', quintHome: '/ci/quint' };
  const relocated = { ...result, invocation: nameStageCommand(stage, config, '/ci/evidence/run-1', '127.0.0.1:12345', origin) };
  assert.equal(validateNameCommand(relocated, stage, config, '/ci/evidence/run-1', binding, origin), true);
  assert.equal(validateNameCommand(relocated, stage, config, '/ci/evidence/run-1', binding), false);
  for (const change of [x => x.invocation.argv.push('--max-steps', '1'), x => { x.invocation.cwd = '/tmp'; }, x => x.invocation.timeoutMs++,
    x => { x.inputEnd.sourceDigest = 'other'; }, x => { x.inputStart.buildCurrent = false; }, x => { x.execution.timedOut = true; }, x => { x.execution.budget.childDeadlineAt++; }, x => { x.execution.budget.timeoutMs++; },
    x => { x.invocation.environment.QUINT_HOME = '/tmp/elsewhere'; }]) {
    const changed = structuredClone(result); change(changed); assert.equal(validateNameCommand(changed, stage, config, directory, binding), false);
  }
});
test(nameGateTests[2], () => {
  const raw = tap(), roster = ['parent', 'parent > child']; assert.equal(strictNameTap(raw, roster).ok, true);
  for (const changed of [raw.slice(raw.indexOf('1..1\n# tests')), raw.replace('ok 1 - child\n', ''), raw.replace('ok 1 - child', 'ok 2 - child'),
    raw.replace('child\n', 'substitute\n'), raw.replace('    1..1', '    1..2'), raw.replace('ok 1 - child', 'ok 1 - child # SKIP'),
    ...['not ok 99', '    not ok 99', 'ok 99', '1..bad'].map(line => raw.replace('# Subtest: parent', `${line}\n# Subtest: parent`)), raw.replace('# pass 2', '# pass 1'), raw + '# extra footer\n', raw.replace('# Subtest: parent', '# Subtest: forged')]) assert.equal(strictNameTap(changed, roster).ok, false);
});
test(nameGateTests[3], async () => {
  for (const [id, file] of [['tlc-independent', 'independent-tlc-depth0.log'], ['bounded-independent', 'independent-apalache-depth6.log']]) {
    const stage = plan.find(row => row.id === id), log = await readFile(`docs/name-protocol-cost-probes/${file}`, 'utf8');
    assert.equal(nameStageConclusion(stage, execution, log, config).ok, true);
    assert.equal(nameStageConclusion(stage, { ...execution, timedOut: true }, log, config).ok, false);
    assert.equal(nameStageConclusion(stage, execution, log.slice(-1200), config).ok, false);
  }
  const driver = plan.at(-1); assert.equal(nameStageConclusion(driver, execution, tap(), config).ok, false);
});
test(nameGateTests[4], () => {
  const stage = plan.find(row => row.id === 'witnesses-independent_witnesses');
  const log = nameWitnesses.independent_witnesses.map(name => `    ok ${name} passed 1 test(s)`).join('\n') + '\n  13 passing (1ms)\n';
  assert.equal(nameStageConclusion(stage, execution, log, config).ok, true);
  for (const changed of ['13 passing', log.replace('ok successTest', 'ok counterfeitTest'), log.replace('ok successTest passed 1 test(s)', ''), log + '\n    ok successTest passed 1 test(s)'])
    assert.equal(nameStageConclusion(stage, execution, changed, config).ok, false);
});
test(nameGateTests[5], async () => {
  for (const mutant of config.mutants) {
    const itf = JSON.parse(await readFile(`docs/name-protocol-cost-probes/negative-${mutant.main}.itf.json`, 'utf8'));
    assert.equal(validateNameModelNegative(mutant.main, itf, config).ok, true, mutant.main);
    const changed = structuredClone(itf); changed.states.push(structuredClone(changed.states.at(-1)));
    assert.equal(validateNameModelNegative(mutant.main, changed, config).ok, false);
    assert.equal(validateNameModelNegative('mutant_fingerprint', JSON.parse(traces.values().next().value.bytes), config).ok, false);
  }
});
test(nameGateTests[6], { timeout: 30000 }, async () => {
  const source = 'witnesses/independent_witnesses-successTest-0.itf.json', { value, trace, bytes } = await realReplay(source);
  assert.equal(validateNameReplay(value, trace, source, bytes), true);
  const changes = [x => { x.config.mode = 'reuse'; }, x => { x.sourceTrace = '../other'; }, x => { x.semanticTraceSha256 = 'f'.repeat(64); },
    x => { x.observations.pop(); }, x => { x.cleanupComplete = false; }, x => { x.budget.deadlineAt += 60000; }, x => { x.observations.at(-1).durable.events.at(-1).action = 'stutter'; },
    x => { x.observations.at(-1).durable.events.at(-1).startedAtMs = 1; }, x => { x.observations.at(-1).actual.name = 2; },
    x => { x.observations.at(-1).durable.tables.knowledge_facts[0].content = 'tampered'; }, x => { x.complete = false; },
    x => { x.classification = 'driver_cannot_replay'; }];
  for (const change of changes) { const changed = structuredClone(value); change(changed); assert.equal(validateNameReplay(changed, trace, source, bytes), false); }
});
test(nameGateTests[7], { timeout: 30000 }, async () => {
  const deadlineAt = Math.min(fileDeadline, Date.now() + 25000);
  for (const negative of nameNegatives) {
    const source = `witnesses/${negative.witness}`, { value, trace, bytes } = await realReplay(source, negative, deadlineAt);
    assert.equal(validateNameReplay(value, trace, source, bytes, { negative }), true, negative.mutation);
    const expected = expectedNameMutationDigests(await readFile('knowledge-name-replacement.mjs', 'utf8'), negative.mutation, process.cwd());
    for (const field of ['sourceDigest', 'mutatedDigest', 'runnableDigest']) assert.equal(value.observations.at(-1).durable.mutation[field], expected[field]);
    assert.notEqual(expectedNameMutationDigests(await readFile('knowledge-name-replacement.mjs', 'utf8'), negative.mutation, '/different/root').runnableDigest, expected.runnableDigest);
    for (const change of [x => { x.observations[1].durable.tables.knowledge_facts[0].content = 'tampered'; },
      x => { x.observations.at(-1).durable.tables.knowledge_facts[0].content = 'tampered'; }, x => { x.counterexample.steps.pop(); },
      x => { x.difference.step--; }, x => { x.observations.at(-1).durable.events.at(-1).argument = 'associated_fail'; },
      x => { x.classification = 'driver_cannot_replay'; }]) {
      const changed = structuredClone(value); change(changed); assert.equal(validateNameReplay(changed, trace, source, bytes, { negative }), false);
    }
  }
});
test(nameGateTests[8], async () => {
  const context = await nameProtocolMetadata(); assert.equal((await validateNameProtocolEvidence(directory)).ok, false);
  const skeleton = { ...context, origin: { repositoryRoot: process.cwd(), nodeExecutable: process.execPath, quintHome: '/tmp/hearwise-quint', evidenceDirectory: directory }, config, results: [], artifacts: [], complete: true, ok: true, execution: { ...execution, complete: true } };
  await writeJson(path.join(directory, 'report.json'), skeleton);
  const result = await validateNameProtocolEvidence(directory); assert.equal(result.ok, false); assert.ok(result.reasons.includes('wrong_stage_plan'));
  assert.ok(result.rows.every(row => row.status !== 'passed'));
  skeleton.sourceDigest = 'f'.repeat(64); skeleton.artifacts = [{ path: '../outside', sha256: 'f'.repeat(64) }];
  await writeJson(path.join(directory, 'report.json'), skeleton);
  const altered = await validateNameProtocolEvidence(directory); assert.equal(altered.ok, false); assert.ok(altered.reasons.includes('stale_sourceDigest')); assert.ok(altered.reasons.includes('invalid_artifact_path'));
  assert.equal(nameInputBinding(context, config, {}).sourceDigest, context.sourceDigest);
});


test(nameGateTests[9], { timeout: 5000 }, async t => {
  const { runNameProtocolCommand } = await import('../scripts/lib/name-protocol-command.mjs');
  const { access } = await import('node:fs/promises');
  const temporary = path.join(directory, 'owned-stage-temporary'), parentDeadline = Date.now() + 2000;
  const invocation = { command: process.execPath, argv: ['-e', 'console.log(process.env.HEARWISE_NAME_DEADLINE_AT)'], cwd: directory,
    timeoutMs: 5000, graceMs: 50, environment: { TMPDIR: temporary } };
  const log = path.join(directory, 'real-child-deadline.log');
  const result = await runNameProtocolCommand(invocation, log, { deadlineAt: parentDeadline });
  assert.equal(result.ok, true); assert.equal(result.budget.deadlineAt, parentDeadline);
  assert.equal(Number((await readFile(log, 'utf8')).trim()), parentDeadline - 50); assert.equal(result.cleanupComplete, true);
  await assert.rejects(access(temporary));
  const hanging = await runNameProtocolCommand({ ...invocation, argv: ['-e', 'setInterval(() => {}, 1000)'] }, log, { deadlineAt: Date.now() + 200 });
  assert.equal(hanging.ok, false); assert.equal(hanging.timedOut, true); assert.equal(hanging.cleanupComplete, true);
  assert.ok(hanging.durationMs < 1500); await assert.rejects(access(temporary));
  await assert.rejects(runNameProtocolCommand(invocation, log, { deadlineAt: Date.now() - 1 }), /cleanup allowance/);
  await assert.rejects(access(temporary));
});
