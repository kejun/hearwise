import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { runProcess } from './process.mjs';
import { digest, writeJson } from './verification-evidence.mjs';
import { checkProtocolTools, quintHome } from './relation-protocol-tools.mjs';
import { generationMetadata, generationPlan, generationCoverage, generationCommand, generationCommandConclusion,
  generationTraceConfig, generationRepositoryRoot, loadGenerationConfig } from './generation-protocol-plan.mjs';
import { normalizeGenerationTrace, replayGenerationTrace } from './generation-protocol-replay.mjs';
import { validateGenerationReplayEvidence } from './generation-protocol-evidence.mjs';
import { validateGenerationEvidence, validateGenerationControl, generationModelViolation, generationReplaySummary } from './generation-protocol-report.mjs';
import { createGenerationProtocolAdapter } from '../../test-support/generation-protocol-adapter.mjs';

const now = () => new Date().toISOString();
export async function superviseGenerationWorker(argv, { directory, timeoutMs }) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const startedAt = now(), log = 'supervisor.log';
  const execution = await runProcess(process.execPath, argv, { cwd: generationRepositoryRoot, env, timeoutMs, graceMs: 5000,
    logFile: path.join(directory, log), onOutput: text => process.stdout.write(text) });
  const { tail: _tail, ...processResult } = execution;
  return { startedAt, finishedAt: now(), argv, cwd: generationRepositoryRoot, timeoutMs, execution: processResult, log };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export async function runGenerationWorker(directory, profile) {
  const config = await loadGenerationConfig(), plan = generationPlan(config), context = await generationMetadata();
  const overallTimeoutMs = config.profiles[profile].overallTimeoutMs;
  const report = { ...context, profile, overallTimeoutMs, domain: config, propertyCoverage: generationCoverage(config),
    startedAt: now(), finishedAt: null, complete: false, tools: null, results: [], artifacts: [], execution: {
      pid: process.pid, repositoryRoot: generationRepositoryRoot, evidenceRoot: directory, complete: false, code: null, signal: null, timedOut: false, interrupted: false } };
  const save = () => writeJson(path.join(directory, 'report.json'), report), artifacts = new Set();
  await save(); console.log(`Generation worker PID ${process.pid}`);
  let timedOut = false, interrupted = false;
  const interrupt = () => { if (!timedOut) interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const timer = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, overallTimeoutMs);
  const checkStopped = () => { if (timedOut || interrupted) throw new Error('Generation verification stopped'); };
  const relative = file => path.relative(directory, file).split(path.sep).join('/');
  async function command(entry) {
    checkStopped();
    const port = ['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(entry.kind) ? await freePort() : undefined;
    const command = generationCommand(entry, config, profile, { repositoryRoot: generationRepositoryRoot, evidenceRoot: directory, port });
    await mkdir(command.cwd, { recursive: true }); if (command.traceDirectory) await mkdir(command.traceDirectory, { recursive: true });
    const startedAt = now(), log = `${entry.id}.log`; console.log(`START ${entry.id}`);
    const env = { ...process.env, QUINT_HOME: quintHome, JVM_ARGS: '-Xmx2G' }; delete env.NODE_TEST_CONTEXT;
    const execution = await runProcess(process.execPath, command.argv, { cwd: command.cwd, env, timeoutMs: command.timeoutMs, graceMs: 1500, logFile: path.join(directory, log) });
    const text = await readFile(path.join(directory, log), 'utf8'), conclusion = generationCommandConclusion(entry, execution, text, command.bound);
    const { tail: _tail, ...processResult } = execution;
    const result = { id: entry.id, kind: entry.kind, startedAt, finishedAt: now(), ...command, ...(port ? { port } : {}),
      complete: conclusion.complete, status: conclusion.ok ? 'passed' : conclusion.complete ? 'failed' : 'incomplete', execution: processResult, metrics: conclusion.metrics || null, log };
    artifacts.add(log);
    if (['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) {
      result.traces = (await readdir(command.traceDirectory)).filter(file => file.endsWith('.itf.json')).sort().map(file => relative(path.join(command.traceDirectory, file)));
      for (const file of result.traces) artifacts.add(file);
      if (result.traces.length !== entry.count) result.status = 'failed';
      if (entry.kind === 'model-negative' && result.traces.length === 1) {
        result.violation = generationModelViolation(entry, JSON.parse(await readFile(path.join(directory, result.traces[0]))));
        if (!result.violation.ok) result.status = 'failed';
      }
    }
    report.results.push(result); await save(); console.log(`${result.status.toUpperCase()} ${entry.id} (${execution.durationMs}ms)`);
    if (execution.interrupted && !timedOut) interrupted = true;
  }
  async function actualReplay(entry) {
    checkStopped(); const startedAt = now(), data = `${entry.id}.json`, log = `${entry.id}.log`, results = [];
    console.log(`START ${entry.id}`);
    const sources = plan.filter(row => row.refined && (entry.control ? row.kind === 'model-witness' && generationTraceConfig(row).protocol === entry.control.protocol && generationTraceConfig(row).actors === 1 : row.kind === entry.sourceKind));
    const replay = (trace, mutation = 'none') => replayGenerationTrace(trace, async options => {
      checkStopped(); const adapter = await createGenerationProtocolAdapter(options, { mutation });
      return { ...adapter, async act(step) { checkStopped(); await adapter.act(step); checkStopped(); } };
    });
    for (const source of sources) for (const file of report.results.find(row => row.id === source.id)?.traces || []) {
      if (entry.control && !file.includes(`${entry.control.witness}-`)) continue;
      checkStopped(); const raw = await readFile(path.join(directory, file), 'utf8');
      const trace = normalizeGenerationTrace(JSON.parse(raw), generationTraceConfig(source));
      const identity = { sourceTrace: file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length };
      if (entry.control) results.push({ ...identity, control: entry.control, normal: await replay(trace), broken: await replay(trace, entry.control.mutation) });
      else results.push({ ...identity, ...await replay(trace) });
      await writeJson(path.join(directory, data), results);
    }
    await writeJson(path.join(directory, data), results); await writeJson(path.join(directory, log), generationReplaySummary(results));
    artifacts.add(data); artifacts.add(log);
    let ok = results.length === entry.count;
    for (const result of results) {
      const source = sources.find(row => report.results.find(result => result.id === row.id)?.traces.includes(result.sourceTrace));
      const trace = normalizeGenerationTrace(JSON.parse(await readFile(path.join(directory, result.sourceTrace))), generationTraceConfig(source));
      ok &&= entry.control ? (await validateGenerationControl(trace, entry.control, result, { repositoryRoot: generationRepositoryRoot, sourceDigests: context.sourceDigests })).ok : validateGenerationReplayEvidence(trace, result).ok;
    }
    report.results.push({ id: entry.id, kind: entry.kind, startedAt, finishedAt: now(), data, log,
      complete: results.length === entry.count && results.every(row => entry.control ? row.normal.complete && row.broken.complete : row.complete), status: ok ? 'passed' : 'failed' });
    await save(); console.log(`${ok ? 'PASSED' : 'FAILED'} ${entry.id}: ${results.length} traces`);
  }
  try {
    report.tools = await checkProtocolTools(); await save();
    for (const entry of plan) {
      if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) await actualReplay(entry);
      else await command(entry);
    }
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  finally {
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { if (!equal(context, await generationMetadata())) report.error = { message: 'Source, runtime build or verification inputs changed during execution' }; }
    catch (error) { report.error = { message: `Cannot recheck source: ${error.message}` }; }
    report.finishedAt = now();
    report.complete = !report.error && !timedOut && !interrupted && report.results.length === plan.length && report.results.every(row => row.complete);
    Object.assign(report.execution, { complete: report.complete, code: report.complete && report.results.every(row => row.status === 'passed') ? 0 : 1, signal: null, timedOut, interrupted });
    for (const file of artifacts) {
      try { report.artifacts.push({ path: file, sha256: digest(await readFile(path.join(directory, file))) }); }
      catch { report.complete = report.execution.complete = false; report.execution.code = 1; }
    }
    await save(); process.exitCode = report.execution.code;
  }
}

export async function runGenerationProtocol(args = process.argv.slice(2)) {
  if (args[0] === '--worker') {
    if (args.length !== 3 || !path.isAbsolute(args[1]) || !['fast', 'deep'].includes(args[2])) throw new Error('Invalid generation worker command');
    await runGenerationWorker(args[1], args[2]); return;
  }
  if (args.some(arg => !['--release', '--deep'].includes(arg))) throw new Error('Usage: npm run verify:generation-protocol -- [--release] [--deep]');
  const config = await loadGenerationConfig(), profile = args.includes('--deep') ? 'deep' : 'fast';
  const root = path.resolve(process.env.GENERATION_EVIDENCE_DIR || 'verification-evidence/generation-protocol');
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'run-'));
  console.log(`Generation evidence: ${directory}`);
  const argv = [path.join(generationRepositoryRoot, 'scripts/verify-generation-protocol.mjs'), '--worker', directory, profile];
  const supervisor = await superviseGenerationWorker(argv, { directory, timeoutMs: config.profiles[profile].overallTimeoutMs + 15000 });
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'))); }
  catch { console.error(`Generation worker failed before a report was available: ${directory}`); process.exitCode = 1; return; }
  report.supervisor = supervisor;
  report.artifacts.push({ path: supervisor.log, sha256: digest(await readFile(path.join(directory, supervisor.log))) });
  await writeJson(path.join(directory, 'report.json'), report);
  const summary = await validateGenerationEvidence(directory, { release: args.includes('--release') });
  report.ok = summary.ok; report.summary = summary; await writeJson(path.join(directory, 'report.json'), report);
  console.log(JSON.stringify({ directory, profile, complete: report.complete, ok: summary.ok, reasons: summary.reasons, rows: summary.rows, fullM1Acceptance: false }, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}
