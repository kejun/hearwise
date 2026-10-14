import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { isDeepStrictEqual as same } from 'node:util';
import { digest, writeJson } from './lib/verification-evidence.mjs';
import { checkProtocolTools, quintHome } from './lib/relation-protocol-tools.mjs';
import { runNameProtocolCommand } from './lib/name-protocol-command.mjs';
import { nameConfig, nameProtocolMetadata, nameProtocolPlan, nameProtocolCoverage, nameInputBinding, nameStageCommand,
  nameStageConclusion, nameTracePaths, validateNameModelNegative, validateNameProtocolEvidence } from './lib/name-protocol-evidence.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--release')) throw new Error('Usage: node scripts/verify-name-protocol.mjs [--release]');
const config = await nameConfig(), context = await nameProtocolMetadata(), plan = nameProtocolPlan(config);
const root = path.resolve(process.env.NAME_PROTOCOL_EVIDENCE_DIR || 'verification-evidence/name-protocol');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-'));
for (const folder of ['witnesses', 'simulation', 'negative']) await mkdir(path.join(directory, folder));
const report = { ...context, startedAt: new Date().toISOString(), finishedAt: null, complete: false, ok: false, tools: null,
  origin: { repositoryRoot: process.cwd(), nodeExecutable: process.execPath, quintHome, evidenceDirectory: directory },
  config, propertyCoverage: nameProtocolCoverage(config), overallTimeoutMs: config.limits.overallMs,
  results: [], artifacts: [], execution: { complete: false, timedOut: false, interrupted: false } };
const save = () => writeJson(path.join(directory, 'report.json'), report);
await save(); console.log(`Name protocol evidence: ${directory}`);
let timedOut = false, interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, config.limits.overallMs);
const artifacts = new Set();
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return `127.0.0.1:${port}`;
}
try {
  if (!context.buildCurrent) throw new Error('Actual built source is stale; run npm run build against this exact worktree');
  report.tools = await checkProtocolTools(); await save();
  for (const stage of plan) {
    if (interrupted || timedOut) throw new Error('Name verification interrupted');
    const start = await nameProtocolMetadata(), inputStart = nameInputBinding(start, config, await checkProtocolTools());
    if (!same(start, context)) throw new Error('Source/build content changed before stage');
    const endpoint = ['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(stage.kind) ? await freePort() : null;
    const invocation = nameStageCommand(stage, config, directory, endpoint), startedAt = new Date().toISOString();
    const log = `${stage.id}.log`; console.log(`START ${stage.id}`);
    const execution = await runNameProtocolCommand(invocation, path.join(directory, log));
    const { tail: _tail, ...processResult } = execution;
    const conclusion = nameStageConclusion(stage, execution, await readFile(path.join(directory, log), 'utf8'), config);
    const result = { id: stage.id, kind: stage.kind, startedAt, finishedAt: new Date().toISOString(),
      invocation, inputStart, inputEnd: nameInputBinding(await nameProtocolMetadata(), config, await checkProtocolTools()),
      execution: processResult, complete: conclusion.complete, status: conclusion.ok ? 'passed' : conclusion.complete ? 'failed' : 'incomplete',
      metrics: conclusion.metrics || null, log, traces: nameTracePaths(stage, config) };
    artifacts.add(log); for (const file of result.traces) artifacts.add(file);
    if (stage.kind === 'model-negative') {
      try { result.violation = validateNameModelNegative(stage.id.slice('negative-'.length), JSON.parse(await readFile(path.join(directory, result.traces[0]), 'utf8')), config); }
      catch { result.violation = { ok: false }; }
      if (!result.violation.ok) result.status = 'failed';
    }
    if (['implementation-replay', 'implementation-negative'].includes(stage.kind)) {
      result.data = `${stage.id}.json`; artifacts.add(result.data);
      try { const values = JSON.parse(await readFile(path.join(directory, result.data), 'utf8')); result.samples = values.length; result.steps = values.reduce((sum, value) => sum + value.steps, 0); }
      catch { result.status = 'failed'; }
    }
    report.results.push(result); await save();
    console.log(`${result.status.toUpperCase()} ${stage.id} (${execution.durationMs}ms)`);
    if (execution.interrupted) interrupted = true;
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally {
  clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.finishedAt = new Date().toISOString();
  report.complete = !timedOut && !interrupted && report.results.length === plan.length && report.results.every(row => row.complete);
  for (const file of artifacts) {
    try { report.artifacts.push({ path: file, sha256: digest(await readFile(path.join(directory, file))) }); }
    catch { report.complete = false; }
  }
  report.inputEnd = nameInputBinding(await nameProtocolMetadata(), config, await checkProtocolTools().catch(() => null));
  if (!same(report.inputEnd, nameInputBinding(context, config, report.tools))) { report.complete = false; report.error = { message: 'Source/build/config/tool inputs changed during execution' }; }
  report.execution = { complete: report.complete, timedOut, interrupted, code: !report.error && report.results.every(row => row.status === 'passed') ? 0 : 1, signal: null };
  await save();
}
const summary = await validateNameProtocolEvidence(directory, { release: args.includes('--release') });
report.ok = summary.ok; report.summary = summary; await save();
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, reasons: summary.reasons, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
process.exitCode = report.ok ? 0 : 1;
