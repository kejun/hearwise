import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { runProcess } from './lib/process.mjs';
import { digest, writeJson } from './lib/verification-evidence.mjs';
import { checkProtocolTools, quintCli, quintHome, toolchain } from './lib/relation-protocol-tools.mjs';
import { schedulerRoot, schedulerRepositoryRoot, schedulerFiles, loadSchedulerConfig, schedulerMetadata, schedulerPlan, schedulerCoverage, schedulerRegressionFiles, schedulerCommandConclusion, schedulerCommandCwd, schedulerDiagnosticContract, schedulerDiagnosticStatus, validateSchedulerEvidence } from './lib/scheduler-protocol-evidence.mjs';
import { normalizeSchedulerTrace, replaySchedulerTrace } from './lib/scheduler-protocol-replay.mjs';
import { createSchedulerProtocolAdapter } from '../test-support/scheduler-protocol-adapter.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--release', '--deep'].includes(arg))) throw new Error('Usage: npm run verify:scheduler -- [--release] [--deep]');
const profile = args.includes('--deep') ? 'deep' : 'fast';
const config = await loadSchedulerConfig(), modelFiles = await schedulerFiles(), plan = schedulerPlan(config, modelFiles);
const root = path.resolve(process.env.SCHEDULER_EVIDENCE_DIR || 'verification-evidence/scheduler');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-')), initial = await schedulerMetadata(), artifacts = new Set(), traces = [];
const report = { ...initial, profile, domain: config, propertyCoverage: schedulerCoverage(config, plan), startedAt: new Date().toISOString(), finishedAt: null,
  complete: false, ok: false, results: [], artifacts: [], diagnostics: {}, tools: null, execution: { repositoryRoot: schedulerRepositoryRoot, complete: false, timedOut: false, interrupted: false, code: null, signal: null } };
console.log(`Scheduler evidence: ${directory}`);
const save = () => writeJson(path.join(directory, 'report.json'), report);
await save();
let timedOut = false, interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
// Independently declared scheduler-profile budget, including full temporal graphs.
const deadlineMs = profile === 'deep' ? 1200000 : 900000;
const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, deadlineMs);
const checkStopped = () => { if (timedOut || interrupted) throw new Error('Scheduler verification interrupted'); };
const relative = file => path.relative(directory, file).split(path.sep).join('/');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function execute(id, argv, timeoutMs, cwd = schedulerCommandCwd({ id }, directory)) {
  checkStopped();
  await mkdir(cwd, { recursive: true });
  const log = `${id}.log`, startedAt = new Date().toISOString();
  const env = { ...process.env, QUINT_HOME: quintHome, JVM_ARGS: '-Xmx2G' }; delete env.NODE_TEST_CONTEXT;
  console.log(`START ${id}`);
  const result = await runProcess(process.execPath, argv, { cwd, env, timeoutMs, graceMs: 1500, logFile: path.join(directory, log) });
  const { tail: _tail, ...execution } = result;
  artifacts.add(log);
  if (execution.interrupted) interrupted = true;
  return { startedAt, finishedAt: new Date().toISOString(), execution, timeoutMs, argv, log, cwd };
}
async function command(entry, argv, timeoutMs = 60000) {
  const result = await execute(entry.id, argv, timeoutMs, schedulerCommandCwd(entry, directory)), log = await readFile(path.join(directory, result.log), 'utf8');
  const conclusion = schedulerCommandConclusion(entry, result.execution, log, config, profile);
  const row = { id: entry.id, kind: entry.kind, ...result, complete: conclusion.complete, status: conclusion.ok ? 'passed' : 'incomplete', metrics: conclusion.metrics };
  report.results.push(row); await save(); console.log(`${row.status.toUpperCase()} ${entry.id} (${result.execution.durationMs}ms)`); return row;
}
async function exportTraces(result, folder, specification, kind) {
  result.traces = (await readdir(folder)).filter(file => file.endsWith('.itf.json')).sort().map(file => relative(path.join(folder, file)));
  for (const file of result.traces) { artifacts.add(file); traces.push({ file, config: specification.traceConfig, kind }); }
  await save();
}
async function replay(id, entries, mutation = false) {
  const startedAt = new Date().toISOString(), results = [];
  for (const entry of entries) {
    checkStopped();
    const raw = await readFile(path.join(directory, entry.file), 'utf8'), trace = normalizeSchedulerTrace(JSON.parse(raw), entry.config);
    const replay = await replaySchedulerTrace(trace, config => createSchedulerProtocolAdapter({ ...config, mutation: mutation ? 'interim_queue_only' : 'none' }));
    results.push({ ...replay, sourceTrace: entry.file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length });
  }
  const data = `${id}.json`, log = `${id}.log`;
  await writeJson(path.join(directory, data), results); await writeJson(path.join(directory, log), results.map(row => ({ trace: row.sourceTrace, complete: row.complete, ok: row.ok, classification: row.classification })));
  artifacts.add(data); artifacts.add(log);
  const complete = entries.length > 0 && results.every(row => row.complete), ok = complete && results.every(row => mutation ? !row.ok && row.classification === 'implementation_mismatch' : row.ok && row.classification === 'matched');
  report.results.push({ id, kind: mutation ? 'implementation-negative' : 'implementation-replay', startedAt, finishedAt: new Date().toISOString(), complete, status: ok ? 'passed' : 'incomplete', data, log, samples: results.length });
  await save(); console.log(`${ok ? 'PASSED' : 'INCOMPLETE'} ${id}: ${results.length} traces`);
}
async function detailLogs(folder) {
  const found = [];
  for (const name of await readdir(folder)) {
    const file = path.join(folder, name), info = await stat(file);
    if (info.isDirectory()) found.push(...await detailLogs(file));
    else if (['detailed.log', 'log.out'].includes(name)) found.push(file);
  }
  return found;
}
try {
  report.tools = await checkProtocolTools(); await save();
  for (const entry of plan.filter(row => row.kind === 'typecheck')) await command(entry, [quintCli, 'typecheck', path.join(schedulerRoot, entry.specification)]);
  for (const check of config.checks) {
    const entry = plan.find(row => row.id === check.id);
    const argv = [quintCli, 'verify', path.join(schedulerRoot, check.specification), '--main', check.main, '--init', check.init, '--step', check.step,
      ...(check.temporal ? ['--temporal', check.temporal] : ['--invariant', check.invariant]), '--backend', 'tlc', '--apalache-version', toolchain.apalache.version,
      '--tlc-config', path.join(schedulerRoot, 'tlc.json'), '--server-endpoint', `127.0.0.1:${await freePort()}`, '--verbosity', '3'];
    await command(entry, argv, check.deadlineMs);
  }
  // A same-source bounded probe is diagnostic only. Its error or timeout never
  // becomes a safety counterexample, a bounded pass, or missing required TLC.
  const probe = await execute('apalache-diagnostic', [quintCli, 'verify', path.join(schedulerRoot, 'configurations.qnt'), '--main', 'translation_small', '--init', 'Init', '--step', 'Step', '--invariant', 'Safety',
    '--backend', 'apalache', '--max-steps', '4', '--apalache-version', toolchain.apalache.version, '--server-endpoint', `127.0.0.1:${await freePort()}`, '--verbosity', '3'], 90000);
  const details = await detailLogs(probe.cwd), diagnosticLogs = [probe.log, ...details.map(relative)];
  for (const file of diagnosticLogs) artifacts.add(file);
  const rawLogs = await Promise.all(diagnosticLogs.map(file => readFile(path.join(directory, file), 'utf8')));
  report.diagnostics.apalache = { ...probe, ...schedulerDiagnosticContract, sourceSha: initial.source.sha, modelDigest: initial.modelDigest, logs: diagnosticLogs,
    status: schedulerDiagnosticStatus(probe.execution, rawLogs) };
  await save();
  for (const row of config.witnesses.roster) {
    const folder = path.join(directory, 'witnesses', row.main); await mkdir(folder, { recursive: true });
    const result = await command(plan.find(entry => entry.id === `witnesses-${row.main}`), [quintCli, 'test', path.join(schedulerRoot, config.witnesses.specification), '--main', row.main,
      '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', path.join(folder, `${row.main}-{test}-{seq}.itf.json`)]);
    await exportTraces(result, folder, row, 'model-witness');
  }
  const simulation = config.simulation, sample = config.profiles[profile].simulation, folder = path.join(directory, 'simulation'); await mkdir(folder);
  const result = await command(plan.find(entry => entry.id === 'simulation'), [quintCli, 'run', path.join(schedulerRoot, simulation.specification), '--main', simulation.main, '--init', simulation.init, '--step', simulation.step,
    '--invariant', simulation.invariant, '--backend', 'typescript', '--seed', sample.seed, '--max-samples', String(sample.samples), '--max-steps', String(sample.maxSteps), '--n-traces', String(sample.selectedTraces), '--verbosity', '1', '--out-itf', path.join(folder, `${simulation.main}-{seq}.itf.json`)]);
  await exportTraces(result, folder, simulation, 'simulation');
  await replay('replay-witnesses', traces.filter(row => row.kind === 'model-witness'));
  await replay('replay-simulation', traces.filter(row => row.kind === 'simulation'));
  await replay('negative-replay', traces.filter(row => row.file.includes('-activeFinalsRejectInterimTest-')), true);
  await command(plan.find(entry => entry.id === 'implementation-regressions'), ['--test', '--test-reporter=tap', '--test-timeout=30000', ...schedulerRegressionFiles.map(file => path.join(schedulerRepositoryRoot, file))], 90000);
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally {
  clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.finishedAt = new Date().toISOString();
  report.complete = !timedOut && !interrupted && !report.error && report.results.length === plan.length && report.results.every(row => row.complete);
  report.execution = { repositoryRoot: schedulerRepositoryRoot, complete: report.complete, code: report.error ? 1 : 0, signal: null, timedOut, interrupted, timeoutMs: deadlineMs };
  for (const file of artifacts) {
    try { report.artifacts.push({ path: file, sha256: digest(await readFile(path.join(directory, file))) }); }
    catch { report.complete = false; report.execution.complete = false; }
  }
  const final = await schedulerMetadata();
  if (!equalMetadata(initial, final)) { report.complete = false; report.execution.complete = false; report.error = { message: 'Source or verification input changed during execution' }; }
  await save();
}
function equalMetadata(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
report.summary = await validateSchedulerEvidence(directory, { release: args.includes('--release') }); report.ok = report.summary.ok; await save();
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, ...report.summary }, null, 2));
process.exitCode = report.ok ? 0 : 1;
