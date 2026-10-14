import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schedulerHeaderReasons, schedulerCommandConclusion, validateSchedulerEvidence, schedulerSourceDigests, schedulerMetadata, validateSchedulerDiagnostic, schedulerRegressionFiles, schedulerRegressionTestCount, schedulerCommandBound, schedulerCommandCwd, schedulerRepositoryRoot, loadSchedulerConfig } from '../scripts/lib/scheduler-protocol-evidence.mjs';

const target = { schemaVersion: 1, specificationVersion: '1.0', modelVersion: 1, source: { sha: 'a'.repeat(40), dirty: false }, modelDigest: 'b'.repeat(64), lockDigest: 'c'.repeat(64), serverSha256: 'd'.repeat(64), sourceDigests: { 'server.mjs': 'd'.repeat(64), 'scripts/verify-scheduler-protocol.mjs': 'f'.repeat(64), 'dist/server/index.js': 'a'.repeat(64) }, runtimeBuild: { git_sha: 'a'.repeat(40), build_dirty: false, instrumentation_version: 3 } };
const domain = { checks: [] }, coverage = [{ id: 'HW-03-02', version: 1, checks: ['example'] }];
const validReport = () => ({ ...structuredClone(target), complete: true, execution: { repositoryRoot: schedulerRepositoryRoot, complete: true, code: 0, signal: null, timedOut: false, interrupted: false },
  environment: { platform: 'linux', arch: 'x64', osRelease: 'test' }, startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', domain, propertyCoverage: coverage, profile: 'fast' });
for (const [label, patch] of [
  ['old source', r => { r.source.sha = 'e'.repeat(40); }],
  ['dirty release', r => { r.source.dirty = true; }],
  ['model changed', r => { r.modelDigest = 'e'.repeat(64); }],
  ['tool dependency changed', r => { r.lockDigest = 'e'.repeat(64); }],
  ['server changed', r => { r.serverSha256 = 'e'.repeat(64); }],
  ['missing source digests', r => { delete r.sourceDigests; }],
  ['changed source inputs', r => { r.sourceDigests['scripts/verify-scheduler-protocol.mjs'] = 'e'.repeat(64); }],
  ['omitted source inputs', r => { delete r.sourceDigests['server.mjs']; }],
  ['missing runtime build metadata', r => { delete r.runtimeBuild; }],
  ['stale runtime build SHA', r => { r.runtimeBuild.git_sha = 'e'.repeat(40); }],
  ['dirty runtime build', r => { r.runtimeBuild.build_dirty = true; }],
  ['invalid runtime instrumentation version', r => { r.runtimeBuild.instrumentation_version = 0; }],
  ['changed runtime bundle bytes', r => { r.sourceDigests['dist/server/index.js'] = 'e'.repeat(64); }],
  ['missing metadata', r => { delete r.schemaVersion; }],
  ['wrong model version', r => { r.modelVersion++; }],
  ['missing environment', r => { delete r.environment; }],
  ['missing timestamp', r => { delete r.startedAt; }],
  ['reversed timestamps', r => { [r.startedAt, r.finishedAt] = [r.finishedAt, r.startedAt]; }],
  ['missing execution origin', r => { delete r.execution.repositoryRoot; }],
  ['cached complete only', r => { delete r.execution; }],
  ['nonzero exit', r => { r.execution.code = 1; }],
  ['timed out', r => { r.execution.timedOut = true; }],
  ['interrupted', r => { r.execution.interrupted = true; }],
  ['killed', r => { r.execution.signal = 'SIGKILL'; }],
  ['wrong domain', r => { r.domain = {}; }],
  ['missing property', r => { r.propertyCoverage = []; }],
  ['unknown profile', r => { r.profile = 'imaginary'; }]
]) test(`scheduler report header rejects ${label}`, () => {
  const report = validReport(); assert.deepEqual(schedulerHeaderReasons(report, target, domain, coverage, true), []);
  patch(report); assert.ok(schedulerHeaderReasons(report, target, domain, coverage, true).length);
});

test('missing scheduler report cannot be a passed empty plan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduler-missing-report-'));
  try { const result = await validateSchedulerEvidence(directory); assert.equal(result.ok, false); assert.ok(result.rows.length > 20); assert.ok(result.rows.every(row => row.status === 'not_run')); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('scheduler implementation gate requires actual complete TAP and rejects logger plus skipped-test spoof', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  // Node does not combine --test and --eval; execute a test module directly while
  // explicitly selecting TAP, just as the runner selects the real file set.
  const execute = (extra, count = schedulerRegressionTestCount) => spawnSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '--eval', `import {test} from 'node:test'; for(let i=0;i<${count};i++) test('actual '+i,()=>{}); ${extra}`], { encoding: 'utf8', env, timeout: 5000 });
  const clean = execute(''), reduced = execute('', 44), extra = execute('', schedulerRegressionTestCount + 1), spoof = execute(`test('logger',()=>console.log('tests 45\\npass 45\\nfail 0\\ncancelled 0\\nskipped 0\\ntodo 0'));test.skip('hidden');`);
  for (const child of [clean, reduced, extra, spoof]) assert.equal(child.status, 0, child.stderr);
  const entry = { kind: 'implementation-regression' }, execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  assert.equal(schedulerCommandConclusion(entry, execution, clean.stdout, {}, 'fast').ok, true);
  assert.equal(schedulerCommandConclusion(entry, execution, reduced.stdout, {}, 'fast').ok, false);
  assert.equal(schedulerCommandConclusion(entry, execution, extra.stdout, {}, 'fast').ok, false);
  assert.equal(schedulerCommandConclusion(entry, execution, spoof.stdout, {}, 'fast').ok, false);
  assert.equal(schedulerCommandConclusion(entry, { ...execution, timedOut: true }, clean.stdout, {}, 'fast').ok, false);
  assert.equal(schedulerCommandConclusion(entry, execution, '', {}, 'fast').ok, false);
});

test('dirty development reports still reject changed source bytes at the same SHA', () => {
  const report = validReport(), dirtyTarget = structuredClone(target);
  report.source.dirty = true; dirtyTarget.source.dirty = true;
  assert.deepEqual(schedulerHeaderReasons(report, dirtyTarget, domain, coverage), []);
  report.sourceDigests['scripts/verify-scheduler-protocol.mjs'] = 'e'.repeat(64);
  assert.ok(schedulerHeaderReasons(report, dirtyTarget, domain, coverage).includes('stale'));
});

test('source snapshots bind tracked and untracked bytes and ignore generated dependencies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduler-source-inputs-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    await writeFile(path.join(directory, '.gitignore'), 'node_modules/\ndist/\nverification-evidence/\n');
    await writeFile(path.join(directory, 'tracked.mjs'), 'export const value = 1;\n');
    execFileSync('git', ['-C', directory, 'add', '.gitignore', 'tracked.mjs']);
    await writeFile(path.join(directory, 'untracked.bin'), Buffer.from([0x80]));
    const before = await schedulerSourceDigests(directory, []);
    assert.deepEqual(Object.keys(before), ['.gitignore', 'tracked.mjs', 'untracked.bin']);
    await writeFile(path.join(directory, 'untracked.bin'), Buffer.from([0x81]));
    const changed = await schedulerSourceDigests(directory, []);
    assert.notEqual(changed['untracked.bin'], before['untracked.bin']);
    assert.equal(changed['tracked.mjs'], before['tracked.mjs']);
    for (const folder of ['node_modules', 'dist', 'verification-evidence']) {
      await mkdir(path.join(directory, folder)); await writeFile(path.join(directory, folder, 'generated'), 'changes');
    }
    assert.deepEqual(await schedulerSourceDigests(directory, []), changed);
    await rm(path.join(directory, 'tracked.mjs'));
    await assert.rejects(schedulerSourceDigests(directory, []), /Missing scheduler source input: tracked\.mjs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scheduler metadata binds runner, adapters, production, tests, and shared gate dependencies', async () => {
  const metadata = await schedulerMetadata();
  for (const file of ['scripts/verify-scheduler-protocol.mjs', 'scripts/lib/scheduler-protocol-evidence.mjs', 'scripts/lib/tap-summary.mjs', 'scripts/lib/process.mjs', 'scripts/lib/verification-evidence.mjs', 'test-support/scheduler-service-adapter.mjs', 'test-support/scheduler-knowledge-adapter.mjs', 'test-support/scheduler-service-worker.mjs', 'speech-scheduler.mjs', 'knowledge-queue.mjs', 'server.mjs', 'test/scheduler-protocol-evidence.test.mjs', 'dist/server/index.js']) {
    assert.match(metadata.sourceDigests[file], /^[a-f0-9]{64}$/, file);
  }
});

const diagnosticExecution = () => ({ code: 0, signal: null, timedOut: false, interrupted: false });
const diagnosticArgv = () => [path.resolve('node_modules/@informalsystems/quint/dist/src/cli.js'), 'verify', path.resolve('verification/scheduler-protocol/configurations.qnt'),
  '--main', 'translation_small', '--init', 'Init', '--step', 'Step', '--invariant', 'Safety', '--backend', 'apalache', '--max-steps', '4', '--apalache-version', '0.62.1', '--server-endpoint', '127.0.0.1:12345', '--verbosity', '3'];
const diagnosticLog = [
  '2026-10-14T00:00:00,000 [main] INFO  a.f.a.t.Tool$ - # APALACHE version: 0.62.1 | build: a321771',
  ...[0, 1, 2, 3, 4].map(step => `2026-10-14T00:00:00,100 [zio-default-async-5] INFO  a.f.a.t.b.t.TransitionExecutorImpl - Step ${step}: picking a transition out of 1 transition(s)`),
  '2026-10-14T00:00:00,200 [zio-default-async-5] INFO  a.f.a.t.b.p.BoundedCheckerPassImpl - The outcome is: NoError',
  '2026-10-14T00:00:00,200 [zio-default-async-5] DEBUG a.f.a.i.p.PassChainExecutor - PASS #13: BoundedChecker [OK]'
].join('\n');
const validDiagnostic = () => ({ required: false, specification: 'configurations.qnt', main: 'translation_small', init: 'Init', step: 'Step', invariant: 'Safety', backend: 'apalache', bound: 4, toolVersion: '0.62.1', modelDigest: target.modelDigest, sourceSha: target.source.sha,
  startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', execution: diagnosticExecution(), cwd: '/tmp/scheduler-evidence/run-example/work/apalache-diagnostic', argv: diagnosticArgv(), logs: ['apalache.log'], status: 'bounded_passed' });
const checkDiagnostic = (diagnostic, raw = diagnosticLog) => validateSchedulerDiagnostic(diagnostic, { target, artifacts: new Map([['apalache.log', raw]]) });

test('optional bounded diagnostic binds exact query and accepts only completed raw bounded proof', () => {
  assert.deepEqual(checkDiagnostic(undefined), { ok: false, reasons: ['missing_bounded_diagnostic'], status: 'not_run', passed: false, required: false });
  assert.deepEqual(checkDiagnostic(validDiagnostic()), { ok: true, reasons: [], status: 'bounded_passed', passed: true, required: false });
  for (const patch of [d => { d.execution.signal = 'SIGTERM'; }, d => { d.execution.code = 1; }, d => { d.execution.timedOut = true; }, d => { d.execution.interrupted = true; }]) {
    const diagnostic = validDiagnostic(); patch(diagnostic); const result = checkDiagnostic(diagnostic);
    assert.equal(result.ok, false); assert.equal(result.passed, false);
  }
});

test('bounded diagnostic rejects missing duplicate and wrong flags and positional inputs', () => {
  const mutations = [d => { d.argv[0] = '/tmp/cli.js'; }, d => { d.argv[1] = 'run'; }, d => { d.argv[2] = path.resolve('verification/scheduler-protocol/replay.qnt'); }, d => { d.argv.push('--unexpected', 'true'); }];
  for (let index = 3; index < diagnosticArgv().length; index += 2) {
    mutations.push(d => { d.argv.splice(index, 2); });
    mutations.push(d => { d.argv.push(d.argv[index], d.argv[index + 1]); });
    if (index > 3) mutations.push(d => { d.argv[index] = '--main'; d.argv[index + 1] = 'translation_small'; });
    mutations.push(d => { d.argv[index + 1] = 'wrong'; });
  }
  for (const mutation of mutations) {
    const diagnostic = validDiagnostic(); mutation(diagnostic); const result = checkDiagnostic(diagnostic);
    assert.equal(result.ok, false, JSON.stringify(diagnostic.argv));
    assert.equal(result.passed, false); assert.notEqual(result.status, 'bounded_passed');
  }
});

test('bounded diagnostic rejects mismatched bindings and missing raw evidence', () => {
  for (const key of ['required', 'specification', 'main', 'init', 'step', 'invariant', 'backend', 'bound', 'toolVersion', 'modelDigest', 'sourceSha', 'startedAt', 'finishedAt']) {
    const diagnostic = validDiagnostic(); diagnostic[key] = 'wrong'; const result = checkDiagnostic(diagnostic);
    assert.equal(result.ok, false, key); assert.equal(result.passed, false); assert.notEqual(result.status, 'bounded_passed');
  }
  for (const logs of [[], ['missing.log'], ['apalache.log', 'apalache.log']]) {
    const diagnostic = validDiagnostic(); diagnostic.logs = logs;
    assert.equal(checkDiagnostic(diagnostic).ok, false);
  }
});

test('bounded diagnostic never upgrades backend error timeout interruption or tool failure to proof', () => {
  for (const [status, patch, raw] of [
    ['incomplete_backend_error', d => { d.execution.code = 1; }, 'java.util.NoSuchElementException: key not found: $C$7'],
    ['incomplete_timeout', d => { d.execution.timedOut = true; }, diagnosticLog],
    ['incomplete_interrupted', d => { d.execution.interrupted = true; }, diagnosticLog],
    ['incomplete_interrupted', d => { d.execution.signal = 'SIGTERM'; }, diagnosticLog],
    ['incomplete_tool_failure', d => { d.execution.code = 1; }, diagnosticLog]
  ]) {
    const diagnostic = validDiagnostic(); patch(diagnostic); diagnostic.status = status;
    const result = checkDiagnostic(diagnostic, raw); assert.equal(result.ok, true, status); assert.equal(result.status, status); assert.equal(result.passed, false);
    diagnostic.status = 'bounded_passed'; assert.equal(checkDiagnostic(diagnostic, raw).ok, false, status);
  }
});

test('bounded diagnostic rejects truncated summary-only or contradictory raw proof', () => {
  for (const raw of ['', 'The outcome is: NoError\nStep 4:', '[ok] No violation found', diagnosticLog.replace('Step 2:', 'Step 9:'), diagnosticLog.replace('BoundedChecker [OK]', 'BoundedChecker'), diagnosticLog.replace('version: 0.62.1', 'version: 0.62.0'), diagnosticLog + '\nERROR solver crashed']) {
    const result = checkDiagnostic(validDiagnostic(), raw); assert.equal(result.ok, false, raw); assert.equal(result.passed, false);
  }
  const diagnostic = validDiagnostic(); diagnostic.logs.push('contradiction.log');
  const result = validateSchedulerDiagnostic(diagnostic, { target, artifacts: new Map([['apalache.log', diagnosticLog], ['contradiction.log', 'ERROR solver crashed']]) });
  assert.equal(result.ok, false); assert.equal(result.passed, false);
});

test('implementation regression command binds the exact seven files flags and repository cwd', () => {
  const entry = { id: 'implementation-regressions', kind: 'implementation-regression' };
  const argv = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...schedulerRegressionFiles.map(file => path.join(schedulerRepositoryRoot, file))];
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', schedulerRepositoryRoot), true);
  for (const mutated of [argv.slice(0, -1), [...argv, argv.at(-1)], [...argv.slice(0, 3), ...argv.slice(3).reverse()], argv.map((value, index) => index === 3 ? '/tmp/other/test/scheduler-service.test.mjs' : value), [...argv, '--test-name-pattern=only'], argv.map(value => value === '--test-reporter=tap' ? '--test-reporter=spec' : value), argv.map(value => value === '--test-timeout=30000' ? '--test-timeout=90000' : value)]) {
    assert.equal(schedulerCommandBound(entry, mutated, {}, 'fast', schedulerRepositoryRoot), false, JSON.stringify(mutated));
  }
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', '/tmp/evidence/work/implementation-regressions'), false);
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast'), false);
});

test('regressions execute at the repository root while formal commands stay isolated', () => {
  const directory = '/tmp/scheduler-evidence/run-example';
  assert.equal(schedulerCommandCwd({ id: 'implementation-regressions', kind: 'implementation-regression' }, directory), schedulerRepositoryRoot);
  assert.equal(schedulerCommandCwd({ id: 'safety-example', kind: 'finite-model-check' }, directory), path.join(directory, 'work/safety-example'));
  assert.equal(schedulerCommandCwd({ id: 'apalache-diagnostic' }, directory), path.join(directory, 'work/apalache-diagnostic'));
});

test('CI regression and diagnostic evidence remain valid from a different checkout root', () => {
  const repositoryRoot = `${schedulerRepositoryRoot}-different-checkout`;
  assert.notEqual(repositoryRoot, schedulerRepositoryRoot, 'The foreign-checkout fixture must actually differ on CI too');
  const entry = { id: 'implementation-regressions', kind: 'implementation-regression' };
  const argv = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...schedulerRegressionFiles.map(file => path.join(repositoryRoot, file))];
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', repositoryRoot, repositoryRoot), true);
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', schedulerRepositoryRoot, repositoryRoot), false);
  const diagnostic = validDiagnostic(); diagnostic.argv = diagnostic.argv.map(value => value.startsWith(schedulerRepositoryRoot + '/') ? repositoryRoot + value.slice(schedulerRepositoryRoot.length) : value);
  const options = { target, artifacts: new Map([['apalache.log', diagnosticLog]]), repositoryRoot };
  assert.equal(validateSchedulerDiagnostic(diagnostic, options).passed, true);
  diagnostic.argv[2] = path.join(repositoryRoot, 'verification/scheduler-protocol/replay.qnt');
  assert.equal(validateSchedulerDiagnostic(diagnostic, options).ok, false);
  const report = validReport(); report.execution.repositoryRoot = repositoryRoot;
  assert.deepEqual(schedulerHeaderReasons(report, target, domain, coverage, true), []);
});

test('formal command paths bind the recorded checkout and retain isolated working directories', async () => {
  const repositoryRoot = `${schedulerRepositoryRoot}-different-checkout`, cwd = '/tmp/evidence/run-one/work/typecheck-translation';
  assert.notEqual(repositoryRoot, schedulerRepositoryRoot, 'The foreign-checkout fixture must actually differ on CI too');
  const entry = { id: 'typecheck-translation', kind: 'typecheck', specification: 'translation.qnt' };
  const argv = [path.join(repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js'), 'typecheck', path.join(repositoryRoot, 'verification/scheduler-protocol/translation.qnt')];
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', cwd, repositoryRoot), true);
  assert.equal(schedulerCommandBound(entry, argv, {}, 'fast', repositoryRoot, repositoryRoot), false);
  assert.equal(schedulerCommandBound(entry, [argv[0], argv[1], path.join(schedulerRepositoryRoot, 'verification/scheduler-protocol/translation.qnt')], {}, 'fast', cwd, repositoryRoot), false);
  assert.equal(schedulerCommandBound(entry, ['/tmp/cli.js', ...argv.slice(1)], {}, 'fast', cwd, repositoryRoot), false);
  const config = await loadSchedulerConfig(), modelRoot = path.join(repositoryRoot, 'verification/scheduler-protocol'), cli = argv[0], evidenceRoot = '/tmp/evidence/run-one';
  for (const check of config.checks) {
    const row = { ...check, kind: check.kind === 'temporal' ? 'temporal-model-check' : 'finite-model-check' }, work = path.join(evidenceRoot, 'work', check.id);
    const command = [cli, 'verify', path.join(modelRoot, check.specification), '--main', check.main, '--init', check.init, '--step', check.step, ...(check.temporal ? ['--temporal', check.temporal] : ['--invariant', check.invariant]), '--backend', 'tlc', '--apalache-version', '0.62.1', '--tlc-config', path.join(modelRoot, 'tlc.json'), '--server-endpoint', '127.0.0.1:12345', '--verbosity', '3'];
    assert.equal(schedulerCommandBound(row, command, config, 'fast', work, repositoryRoot), true, check.id);
    assert.equal(schedulerCommandBound(row, [...command, '--backend', 'apalache'], config, 'fast', work, repositoryRoot), false, check.id);
  }
  for (const witness of config.witnesses.roster) {
    const row = { ...witness, id: `witnesses-${witness.main}`, kind: 'model-witness' }, work = path.join(evidenceRoot, 'work', row.id);
    const command = [cli, 'test', path.join(modelRoot, config.witnesses.specification), '--main', witness.main, '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', path.join(evidenceRoot, 'witnesses', witness.main, `${witness.main}-{test}-{seq}.itf.json`)];
    assert.equal(schedulerCommandBound(row, command, config, 'fast', work, repositoryRoot), true, row.id);
  }
  for (const profile of ['fast', 'deep']) {
    const simulation = config.simulation, sample = config.profiles[profile].simulation, row = { id: 'simulation', kind: 'simulation' }, work = path.join(evidenceRoot, 'work/simulation');
    const command = [cli, 'run', path.join(modelRoot, simulation.specification), '--main', simulation.main, '--init', simulation.init, '--step', simulation.step, '--invariant', simulation.invariant, '--backend', 'typescript', '--seed', sample.seed, '--max-samples', String(sample.samples), '--max-steps', String(sample.maxSteps), '--n-traces', String(sample.selectedTraces), '--verbosity', '1', '--out-itf', path.join(evidenceRoot, 'simulation', `${simulation.main}-{seq}.itf.json`)];
    assert.equal(schedulerCommandBound(row, command, config, profile, work, repositoryRoot), true, profile);
  }
});

test('source snapshots require ignored runtime inputs and bind their exact bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduler-built-inputs-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    await writeFile(path.join(directory, '.gitignore'), 'dist/\n');
    const inputs = ['dist/server/index.js'];
    await assert.rejects(schedulerSourceDigests(directory, inputs), /Missing scheduler source input: dist\/server\/index\.js/);
    await mkdir(path.join(directory, 'dist/server'), { recursive: true });
    await writeFile(path.join(directory, inputs[0]), 'export const build = 1;\n');
    const before = await schedulerSourceDigests(directory, inputs);
    assert.match(before[inputs[0]], /^[a-f0-9]{64}$/);
    await writeFile(path.join(directory, inputs[0]), 'export const build = 2;\n');
    assert.notEqual((await schedulerSourceDigests(directory, inputs))[inputs[0]], before[inputs[0]]);
    await rm(path.join(directory, inputs[0])); await mkdir(path.join(directory, inputs[0]));
    await assert.rejects(schedulerSourceDigests(directory, inputs), /Scheduler source input is not a regular file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
