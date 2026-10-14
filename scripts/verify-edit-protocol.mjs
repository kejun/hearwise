import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { runEditProtocolCommand } from './lib/edit-protocol-command.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource } from './lib/runner-evidence-contract.mjs';
import { digest, writeJson } from './lib/verification-evidence.mjs';
import { checkProtocolTools, quintCli, quintHome, toolchain } from './lib/relation-protocol-tools.mjs';
import { editConfig, editModelRoot, editProtocolMetadata, editProtocolPlan, editProtocolCoverage, editConfiguration,
  editStageConclusion, validateEditProtocolEvidence } from './lib/edit-protocol-evidence.mjs';
import { normalizeEditTrace, replayEditTrace, expectedEditMutationViolation } from './lib/edit-protocol-replay.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--release')) throw new Error('Usage: node scripts/verify-edit-protocol.mjs [--release]');
const repositoryRoot = process.cwd();
const config = await editConfig(), context = await editProtocolMetadata(), sourceStart = await sourceSnapshot();
if (!validBuildSource(sourceStart)) throw new Error('Build source differs from checkout; run npm run build before testing');
const root = path.resolve(process.env.EDIT_PROTOCOL_EVIDENCE_DIR || 'verification-evidence/edit-protocol');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-'));
const report = { ...context, sourceStart, executionContext: { repositoryRoot, evidenceDirectory: directory, quintCli, overallTimeoutMs: config.limits.overallMs, jvmArgs: '-Xmx2G' }, startedAt: new Date().toISOString(), finishedAt: null, complete: false, ok: false, tools: null,
  config, propertyCoverage: editProtocolCoverage(config), results: [], artifacts: [], execution: { complete: false, timedOut: false, interrupted: false } };
const save = () => writeJson(path.join(directory, 'report.json'), report);
await save(); console.log(`Edit protocol evidence: ${directory}`);
const artifacts = new Set(), witnessTraces = [], simulationTraces = [];
const relative = file => path.relative(directory, file).split(path.sep).join('/');
let timedOut = false, interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, config.limits.overallMs);
const stopped = () => { if (timedOut || interrupted) throw new Error('Edit verification interrupted'); };
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function command(id, kind, argv, { timeoutMs = 60000, bound } = {}) {
  stopped(); console.log(`START ${id}`);
  const startedAt = new Date().toISOString(), logFile = path.join(directory, `${id}.log`);
  const env = { ...process.env, QUINT_HOME: quintHome, JVM_ARGS: '-Xmx2G' }; delete env.NODE_TEST_CONTEXT;
  const execution = await runEditProtocolCommand(process.execPath, argv, { kind, repositoryRoot, evidenceDirectory: directory,
    env, timeoutMs, graceMs: 1500, logFile });
  const log = await readFile(logFile, 'utf8'), conclusion = editStageConclusion(id, kind, execution, log, config, bound);
  const { tail: _tail, ...processResult } = execution;
  const row = { id, kind, startedAt, finishedAt: new Date().toISOString(), complete: conclusion.complete,
    status: conclusion.ok ? 'passed' : conclusion.complete ? 'failed' : 'incomplete', execution: processResult,
    log: relative(logFile), argv, timeoutMs, bound, cwd: kind === 'implementation-regression' ? repositoryRoot : directory, metrics: conclusion.metrics || null };
  report.results.push(row); artifacts.add(row.log); await save();
  if (execution.interrupted) interrupted = true;
  console.log(`${row.status.toUpperCase()} ${id} (${execution.durationMs}ms)`); return row;
}
const quint = (id, kind, argv, options) => command(id, kind, [quintCli, ...argv], options);
async function collect(row, location, main, target) {
  row.traces = (await readdir(location)).filter(file => file.startsWith(`${main}-`) && file.endsWith('.itf.json')).sort()
    .map(file => relative(path.join(location, file)));
  for (const file of row.traces) { artifacts.add(file); target.push({ file, main }); }
  if (!row.traces.length) row.status = 'failed';
  await save();
}
async function replay(id, entries, mutation) {
  stopped(); const startedAt = new Date().toISOString(), values = [];
  // Loading only at replay time allows failed formal setup to retain useful logs.
  const { createEditProtocolAdapter } = await import('../test-support/edit-protocol-adapter.mjs');
  for (const entry of entries) {
    stopped(); const raw = await readFile(path.join(directory, entry.file), 'utf8');
    const trace = normalizeEditTrace(JSON.parse(raw), editConfiguration(entry.main, config));
    const value = await replayEditTrace(trace, options => createEditProtocolAdapter({ ...options, ...(mutation ? { mutation } : {}) }));
    values.push({ ...value, sourceTrace: entry.file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length });
  }
  const data = `${id}.json`, log = `${id}.log`;
  await writeJson(path.join(directory, data), values);
  await writeJson(path.join(directory, log), values.map(value => ({ sourceTrace: value.sourceTrace, classification: value.classification, complete: value.complete, ok: value.ok, steps: value.steps })));
  artifacts.add(data); artifacts.add(log);
  const count = mutation ? 1 : id === 'replay-witnesses' ? config.witnesses.expectedTestCount : config.configurations.length * config.simulation.selectedTraces;
  const complete = values.every(value => value.complete), ok = values.length === count && complete && values.every(value => mutation ? value.classification === 'implementation_mismatch' && value.counterexample : value.ok);
  report.results.push({ id, kind: mutation ? 'implementation-negative' : 'implementation-replay', startedAt, finishedAt: new Date().toISOString(),
    complete, status: ok ? 'passed' : complete ? 'failed' : 'incomplete', data, log, traces: entries.map(entry => entry.file), samples: values.length,
    steps: values.reduce((sum, value) => sum + value.steps, 0) });
  await save(); console.log(`${ok ? 'PASSED' : 'FAILED'} ${id}: ${values.length} traces`);
}
try {
  report.tools = await checkProtocolTools(); await save();
  for (const name of ['protocol', 'configurations', 'witnesses']) await quint(`typecheck-${name}`, 'typecheck', ['typecheck', path.join(editModelRoot, `${name}.qnt`)]);
  for (const entry of config.configurations) {
    const base = ['verify', path.join(editModelRoot, config.specification), '--main', entry.main, '--init', config.init, '--step', config.step,
      '--invariant', config.invariant, '--apalache-version', toolchain.apalache.version, '--verbosity', '3'];
    await quint(`tlc-${entry.main}`, 'finite-state-complete', [...base, '--backend', 'tlc', '--tlc-config', path.join(editModelRoot, 'tlc.json'),
      '--server-endpoint', `127.0.0.1:${await freePort()}`], { timeoutMs: config.limits.tlcMs });
    await quint(`bounded-${entry.main}`, 'bounded-model-check', [...base, '--backend', 'apalache', '--max-steps', String(entry.apalacheDepth),
      '--server-endpoint', `127.0.0.1:${await freePort()}`], { timeoutMs: config.limits.boundedMs, bound: entry.apalacheDepth });
  }
  const witnessDirectory = path.join(directory, 'witnesses'); await mkdir(witnessDirectory);
  for (const main of config.witnesses.mains) {
    const row = await quint(`witnesses-${main}`, 'model-witness', ['test', path.join(editModelRoot, config.witnesses.specification), '--main', main,
      '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples),
      '--out-itf', path.join(witnessDirectory, `${main}-{test}-{seq}.itf.json`)], { timeoutMs: config.limits.witnessMs });
    await collect(row, witnessDirectory, main, witnessTraces);
  }
  const simulationDirectory = path.join(directory, 'simulation'); await mkdir(simulationDirectory);
  for (const entry of config.configurations) {
    const row = await quint(`simulation-${entry.main}`, 'simulation', ['run', path.join(editModelRoot, config.specification), '--main', entry.main,
      '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'typescript', '--seed', config.simulation.seed,
      '--max-samples', String(config.simulation.samples), '--max-steps', String(config.simulation.maximumSteps), '--n-traces', String(config.simulation.selectedTraces),
      '--out-itf', path.join(simulationDirectory, `${entry.main}-{seq}.itf.json`)], { timeoutMs: config.limits.simulationMs });
    row.parameters = config.simulation; await collect(row, simulationDirectory, entry.main, simulationTraces);
  }
  const negativeDirectory = path.join(directory, 'negative'); await mkdir(negativeDirectory);
  for (const mutant of config.mutants) {
    const file = path.join(negativeDirectory, `${mutant.main}.itf.json`);
    const row = await quint(`negative-${mutant.main}`, 'model-negative', ['verify', path.join(editModelRoot, config.specification), '--main', mutant.main,
      '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'apalache', '--apalache-version', toolchain.apalache.version,
      '--server-endpoint', `127.0.0.1:${await freePort()}`, '--max-steps', String(mutant.maxSteps), '--out-itf', file], { timeoutMs: config.limits.mutationMs });
    try {
      row.violation = expectedEditMutationViolation(mutant.main, JSON.parse(await readFile(file, 'utf8')), editConfiguration(mutant.main, config));
      row.traces = [relative(file)]; artifacts.add(relative(file)); if (!row.violation.ok) row.status = 'failed';
    } catch { row.status = 'failed'; }
    await save();
  }
  await replay('replay-witnesses', witnessTraces);
  await replay('replay-simulation', simulationTraces);
  const negativeSources = witnessTraces.filter(entry => entry.file.includes('current_witnesses-backgroundConflictTest-'));
  await replay('negative-replay-bypass_revision', negativeSources, 'bypass_revision');
  await replay('negative-replay-auto_revision_resend', negativeSources, 'auto_revision_resend');
  await command('driver-regressions', 'implementation-regression', ['--test', '--test-reporter=tap', '--test-timeout=30000',
    path.resolve('test/edit-protocol-evidence.test.mjs')]);
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally {
  clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.finishedAt = new Date().toISOString();
  report.complete = !timedOut && !interrupted && report.results.length === editProtocolPlan(config).length && report.results.every(row => row.complete);
  for (const file of artifacts) {
    try { report.artifacts.push({ path: file, sha256: digest(await readFile(path.join(directory, file))) }); }
    catch { report.complete = false; }
  }
  report.sourceEnd = await sourceSnapshot();
  if (!sameSourceSnapshot(sourceStart, report.sourceEnd) || !validBuildSource(report.sourceEnd) || !isSame(await editProtocolMetadata(), context)) { report.complete = false; report.error = { message: 'Source or verification inputs changed during execution' }; }
  report.execution = { complete: report.complete, timedOut, interrupted, code: !report.error && report.results.every(row => row.status === 'passed') ? 0 : 1, signal: null };
  await save();
}
function isSame(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
const summary = await validateEditProtocolEvidence(directory, { release: args.includes('--release') });
report.ok = summary.ok; report.summary = summary; await save();
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, reasons: summary.reasons, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
process.exitCode = report.ok ? 0 : 1;
