import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { metadata, writeJson, digest, sourceVersion } from './lib/verification-evidence.mjs';
import { runProcess } from './lib/process.mjs';
import { validateBaselineRun } from './lib/realtime-baseline.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !/^--profile=(smoke|baseline)$/.test(arg) && arg !== '--negative=retain-asr-socket')) throw new Error('Usage: npm run verify:realtime-baseline -- [--profile=smoke|baseline] [--negative=retain-asr-socket]');
const profile = args.find(arg => arg.startsWith('--profile='))?.split('=')[1] || 'baseline';
const negative = args.includes('--negative=retain-asr-socket') ? 'retain-asr-socket' : 'none';
const planBytes = await readFile('verification/realtime-baseline.json'), plan = JSON.parse(planBytes), config = plan.profiles[profile];
const root = path.resolve(process.env.REALTIME_EVIDENCE_DIR || 'verification-evidence/realtime');
await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, `${profile}-`));
const context = await metadata();
const report = { ...context, plan, planDigest: digest(planBytes), profile, negative, startedAt: new Date().toISOString(),
  complete: false, ok: false, acceptanceStatus: 'not_run', fullProjectAcceptance: false, runs: [],
  environment: { ...context.environment, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(), totalMemoryBytes: os.totalmem(), loadAtStart: os.loadavg() } };
await writeJson(path.join(directory, 'report.json'), report);
console.log(`Realtime baseline evidence: ${directory}`);
for (let repeat = 0; repeat < (negative === 'none' ? config.repeats : 1); repeat++) {
  const runDirectory = path.join(directory, `repeat-${repeat + 1}`); await mkdir(runDirectory); await mkdir(path.join(runDirectory, 'temporary-database'));
  const execution = await runProcess(process.execPath, ['test-support/realtime-baseline-worker.mjs', runDirectory, profile, negative], {
    logFile: path.join(runDirectory, 'worker.log'), timeoutMs: config.workerTimeoutMs });
  await rm(path.join(runDirectory, 'temporary-database'), { recursive: true, force: true });
  let result; try { result = JSON.parse(await readFile(path.join(runDirectory, 'result.json'), 'utf8')); } catch { /* Incomplete evidence remains a failure. */ }
  const artifacts = [];
  for (const name of await readdir(runDirectory)) artifacts.push({ path: `repeat-${repeat + 1}/${name}`, sha256: digest(await readFile(path.join(runDirectory, name))) });
  const validation = validateBaselineRun(result);
  for (const file of ['resources.jsonl', 'events.jsonl', 'server.log', 'worker.log', 'result.json']) if (!artifacts.some(row => row.path === `repeat-${repeat + 1}/${file}`)) {
    validation.ok = false; validation.reasons.push(`missing_artifact:${file}`);
  }
  report.runs.push({ repeat: repeat + 1, execution, validation, result, artifacts });
  await writeJson(path.join(directory, 'report.json'), report);
  if (!execution.ok) break;
}
const target = sourceVersion();
report.finishedAt = new Date().toISOString(); report.target = target;
report.complete = report.runs.length === (negative === 'none' ? config.repeats : 1) && report.runs.every(run => !run.execution.timedOut && !run.execution.interrupted && run.execution.signal == null && [0, 1].includes(run.execution.code) && run.result?.cleanup?.confirmed);
report.ok = report.complete && target.sha === context.source.sha && target.dirty === context.source.dirty && report.runs.every(run => run.execution.ok && run.validation.ok);
report.negativeDetected = negative !== 'none' && report.complete && report.runs.every(run => run.execution.code === 1 && run.result?.error?.startsWith('ASR upstream retained after stop exceeded') && run.result?.cleanup?.confirmed && run.result?.retainedCloseCalls > 0 && run.result?.failure?.providerAsrConnections > 0);
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, negativeDetected: report.negativeDetected, acceptanceStatus: report.acceptanceStatus, fullProjectAcceptance: false }));
process.exitCode = report.ok ? 0 : 1;
