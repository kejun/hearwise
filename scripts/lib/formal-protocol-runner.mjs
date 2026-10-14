import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { digest, writeJson } from './verification-evidence.mjs';
import { checkProtocolTools, quintCli, quintHome, toolchain } from './relation-protocol-tools.mjs';
import { formalPlan, checkerConclusion } from './formal-protocol-evidence.mjs';

// A shared execution/evidence interface. Domain definitions supply their model,
// projections and acceptance controls; neither domain can reuse another's pass.
export async function runFormalProtocol(definition) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--release', '--deep'].includes(arg))) throw new Error(`Usage: npm run ${definition.script} -- [--release] [--deep]`);
  const config = await definition.loadConfig(), modelRoot = definition.modelRoot;
  const profile = args.includes('--deep') ? 'deep' : 'fast';
  const root = path.resolve(process.env[definition.environmentVariable] || definition.defaultDirectory);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'run-'));
  const context = await definition.metadata(), startedAt = new Date().toISOString();
  const report = { ...context, profile, startedAt, finishedAt: null, complete: false, ok: false, tools: null,
    executionContext: { repositoryRoot: process.cwd(), evidenceDirectory: directory, quintCli, overallTimeoutMs: profile === 'deep' ? 1200000 : 480000, jvmArgs: '-Xmx2G' },
    domain: config, propertyCoverage: definition.coverage(config), results: [], artifacts: [], execution: { complete: false, timedOut: false, interrupted: false } };
  await writeJson(path.join(directory, 'report.json'), report);
  console.log(`${definition.label} evidence: ${directory}`);
  const artifacts = new Set(), fixedTraces = [], simulationTraces = [];
  let timedOut = false, interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  // Initial measured-cost budgets: never relax them to turn a partial run green.
  const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, profile === 'deep' ? 1200000 : 480000);
  const relative = file => path.relative(directory, file).split(path.sep).join('/');
  const save = () => writeJson(path.join(directory, 'report.json'), report);
  const checkStopped = () => { if (interrupted || timedOut) throw new Error(`${definition.label} verification interrupted`); };
  async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
  }
  async function command(id, kind, argv, { timeoutMs = 60000, bound, expectedFailure = false } = {}) {
    checkStopped();
    const startedAt = new Date().toISOString();
    const logFile = path.join(directory, `${id}.log`);
    console.log(`START ${id}`);
    const childEnv = { ...process.env, QUINT_HOME: quintHome, JVM_ARGS: '-Xmx2G' };
    delete childEnv.NODE_TEST_CONTEXT;
    const execution = await runProcess(process.execPath, argv, { cwd: directory, env: childEnv, timeoutMs, graceMs: 1500, logFile });
    const log = await readFile(logFile, 'utf8'), conclusion = checkerConclusion(kind, execution, log, bound);
    const { tail: _tail, ...processResult } = execution;
    const result = { id, kind, startedAt, finishedAt: new Date().toISOString(), complete: conclusion.complete, status: conclusion.ok ? 'passed' : conclusion.complete ? 'failed' : 'incomplete',
      execution: processResult, timeoutMs, log: relative(logFile), metrics: conclusion.metrics || null, expectedFailure, argv, bound };
    artifacts.add(result.log); report.results.push(result); await save();
    console.log(`${result.status.toUpperCase()} ${id} (${execution.durationMs}ms)`);
    if (execution.interrupted) interrupted = true;
    return result;
  }
  async function quint(id, kind, argv, options) { return command(id, kind, [quintCli, ...argv], options); }
  async function addTraces(result, traceDirectory, main, target) {
    result.traces = (await readdir(traceDirectory)).filter(file => file.startsWith(`${main}-`) && file.endsWith('.itf.json')).map(file => relative(path.join(traceDirectory, file))).sort();
    for (const file of result.traces) { artifacts.add(file); target?.push({ file, main }); }
    if (!result.traces.length) result.status = 'failed';
    await save();
  }
  async function replay(id, entries, mutation = false) {
    checkStopped();
    const startedAt = new Date().toISOString();
    const results = [];
    for (const entry of entries) {
      checkStopped();
      const raw = await readFile(path.join(directory, entry.file), 'utf8'), itf = JSON.parse(raw);
      const trace = definition.normalizeTrace(itf, definition.traceConfig(entry.main));
      const result = await definition.replayTrace(trace, options => definition.createAdapter({ ...options, mutation: mutation ? 'skip_reservation' : 'none' }));
      results.push({ ...result, sourceTrace: entry.file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length });
    }
    const data = `${id}.json`, log = `${id}.log`;
    await writeJson(path.join(directory, data), results);
    await writeJson(path.join(directory, log), results.map(row => ({ trace: row.sourceTrace, classification: row.classification, complete: row.complete, ok: row.ok, steps: row.steps })));
    artifacts.add(data); artifacts.add(log);
    const expected = id === 'replay-witnesses' ? config.witnesses.expectedTestCount : id === 'replay-simulation' ? config.simulation.selectedTraces * (config.multiple.mains.length + 1) : 1;
    const ok = results.length === expected && results.every(row => row.complete && (mutation ? row.classification === 'implementation_mismatch' && row.counterexample : row.ok));
    report.results.push({ id, startedAt, finishedAt: new Date().toISOString(), kind: mutation ? 'implementation-negative' : 'implementation-replay', complete: results.every(row => row.complete), status: ok ? 'passed' : 'failed', data, log,
      traces: entries.map(row => row.file), samples: results.length, steps: results.reduce((sum, row) => sum + row.steps, 0) });
    await save(); console.log(`${ok ? 'PASSED' : 'FAILED'} ${id}: ${results.length} traces`);
  }
  try {
    report.tools = await checkProtocolTools(); await save();
    for (const name of ['protocol', 'configurations', 'witnesses']) await quint(`typecheck-${name}`, 'typecheck', ['typecheck', path.join(modelRoot, `${name}.qnt`)]);
    const mains = [config.single.main, ...config.multiple.mains.map(row => row.main)];
    for (const main of mains) {
      const base = ['verify', path.join(modelRoot, config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant,
        '--apalache-version', toolchain.apalache.version, '--verbosity', '3'];
      await quint(`tlc-${main}`, 'finite-state-complete', [...base, '--backend', 'tlc', '--tlc-config', path.join(modelRoot, 'tlc.json'), '--server-endpoint', `127.0.0.1:${await freePort()}`]);
      const bound = config.profiles[profile].apalacheDepth[main];
      await quint(`bounded-${main}`, 'bounded-model-check', [...base, '--backend', 'apalache', '--max-steps', String(bound), '--server-endpoint', `127.0.0.1:${await freePort()}`],
        { bound, timeoutMs: profile === 'deep' && main !== 'single' ? 900000 : 240000 });
    }
    const witnessDirectory = path.join(directory, 'witnesses'); await mkdir(witnessDirectory);
    for (const main of config.witnesses.mains) {
      const result = await quint(`witnesses-${main}`, 'model-witness', ['test', path.join(modelRoot, config.witnesses.specification), '--main', main,
        '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', path.join(witnessDirectory, `${main}-{test}-{seq}.itf.json`)]);
      await addTraces(result, witnessDirectory, main, fixedTraces);
    }
    const sampleDirectory = path.join(directory, 'simulation'); await mkdir(sampleDirectory);
    for (const main of mains) {
      const result = await quint(`simulation-${main}`, 'simulation', ['run', path.join(modelRoot, config.specification), '--main', main, '--init', config.init, '--step', config.step,
        '--invariant', config.invariant, '--backend', 'typescript', '--seed', config.simulation.seed, '--max-samples', String(config.simulation.samples), '--n-traces', String(config.simulation.selectedTraces), '--max-steps', String(config.simulation.maximumSteps), '--verbosity', '1',
        '--out-itf', path.join(sampleDirectory, `${main}-{seq}.itf.json`)]);
      result.metrics = { ...config.simulation };
      await addTraces(result, sampleDirectory, main, simulationTraces);
    }
    const negativeDirectory = path.join(directory, 'negative'); await mkdir(negativeDirectory);
    for (const mutant of config.mutants) {
      const file = path.join(negativeDirectory, `${mutant.main}.itf.json`);
      const result = await quint(`negative-${mutant.main}`, 'model-negative', ['verify', path.join(modelRoot, config.specification), '--main', mutant.main,
        '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'apalache', '--apalache-version', toolchain.apalache.version,
        '--server-endpoint', `127.0.0.1:${await freePort()}`, '--max-steps', String(mutant.maxSteps), '--out-itf', file], { expectedFailure: true });
      try {
        const itf = JSON.parse(await readFile(file, 'utf8'));
        result.violation = definition.expectedMutationViolation(mutant.main, itf);
        result.traces = [relative(file)]; artifacts.add(relative(file));
        if (!result.violation.ok) result.status = 'failed';
      } catch { result.status = 'failed'; }
      await save();
    }
    await replay('replay-witnesses', fixedTraces);
    await replay('replay-simulation', simulationTraces);
    await replay('negative-replay', fixedTraces.filter(row => row.file.includes('normalSuccessTest-')), true);
    await command('implementation-regressions', 'implementation-regression', ['--test', '--test-reporter=tap', '--test-timeout=30000', ...definition.regressionFiles.map(file => path.resolve(file))]);
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  finally {
    clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString();
    report.complete = !timedOut && !interrupted && report.results.length === formalPlan(config).length && report.results.every(row => row.complete);
    report.execution = { complete: report.complete, timedOut, interrupted, code: report.error ? 1 : 0, signal: null };
    for (const file of artifacts) {
      try { report.artifacts.push({ path: file, sha256: digest(await readFile(path.join(directory, file))) }); }
      catch { report.complete = false; report.execution.complete = false; }
    }
    const target = await definition.metadata();
    if (JSON.stringify(target) !== JSON.stringify(context)) { report.complete = false; report.execution.complete = false; report.error = { message: 'Source or verification inputs changed during execution' }; }
    await save();
  }
  const summary = await definition.validateEvidence(directory, { release: args.includes('--release') });
  report.ok = summary.ok; report.summary = summary; await save();
  console.log(JSON.stringify({ directory, profile, complete: report.complete, ok: report.ok, reasons: summary.reasons, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
