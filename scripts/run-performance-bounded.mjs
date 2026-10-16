import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { runProcess } from './lib/process.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
import { freezeBoundedPolicy, boundedLimitMs } from './lib/performance-bounded.mjs';

const [baselineArg, candidateArg, outputArg, targetsFile, ...extra] = process.argv.slice(2);
if (!baselineArg || !candidateArg || !outputArg || extra.length) throw new Error('Usage: node scripts/run-performance-bounded.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT OUTPUT_DIRECTORY [APPROVED_TARGETS.json]');
const baselineRoot = path.resolve(baselineArg), candidateRoot = path.resolve(candidateArg);
// Dependencies must already be installed in each checkout. No network, credentials,
// worktree mutation, automatic target selection, or automatic long-run fallback.
const targets = targetsFile ? JSON.parse(await readFile(targetsFile, 'utf8')) : null;
await mkdir(outputArg, { recursive: true });
const directory = await mkdtemp(path.join(path.resolve(outputArg), 'pair-'));
const report = { schemaVersion: 1, kind: 'bounded-performance-pair', startedAt: new Date().toISOString(), finishedAt: null,
  timeoutMs: boundedLimitMs, complete: false, performanceEvaluated: false, performancePassed: false, stages: [], comparison: null };
const deadline = Date.now() + boundedLimitMs;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
const save = () => writeJson(path.join(directory, 'pair.json'), report);
async function run(id, root, script, args, cap) {
  assert.equal(interrupted, false, 'Pair interrupted');
  const timeoutMs = Math.min(cap, deadline - Date.now());
  assert.ok(timeoutMs > 0, 'Pair overall time budget exhausted');
  const argv = [script, ...args];
  const env = { ...process.env, PERFORMANCE_EVIDENCE_DIR: path.join(directory, id) }; delete env.NODE_TEST_CONTEXT;
  const startedAt = new Date().toISOString();
  const execution = await runProcess(process.execPath, argv, { cwd: root, env, timeoutMs, logFile: path.join(directory, `${id}.log`) });
  const { tail, ...outcome } = execution;
  report.stages.push({ id, startedAt, finishedAt: new Date().toISOString(), cwd: root, argv, timeoutMs, execution: outcome }); await save();
  assert.equal(execution.ok, true, `${id} failed: ${tail.slice(-2000)}`);
  return tail;
}
try {
  await save();
  await run('build-baseline', baselineRoot, 'scripts/build.mjs', [], 45000);
  if (baselineRoot !== candidateRoot) await run('build-candidate', candidateRoot, 'scripts/build.mjs', [], 45000);
  const preparedLog = await run('prepare', baselineRoot, 'scripts/prepare-performance.mjs', [path.join(directory, 'fixtures'), 'bounded'], 60000);
  const prepared = JSON.parse(preparedLog.trim().split('\n').at(-1)).path;
  const baselineLog = await run('baseline', baselineRoot, 'scripts/collect-performance.mjs', [prepared, 'bounded'], 180000);
  const baselineDirectory = path.dirname(JSON.parse(baselineLog.trim().split('\n').at(-1)).path);
  await run('verify-baseline', baselineRoot, 'scripts/verify-performance-report.mjs', [baselineDirectory, '--clean'], 20000);
  const baseline = JSON.parse(await readFile(path.join(baselineDirectory, 'report.json'), 'utf8'));
  const policy = freezeBoundedPolicy(baseline, targets);
  const policyFile = path.join(directory, 'policy.json'); await writeJson(policyFile, policy);
  report.baseline = path.relative(directory, baselineDirectory); report.policy = 'policy.json'; await save();
  const candidateLog = await run('candidate', candidateRoot, 'scripts/collect-performance.mjs', [prepared, 'bounded', '--policy', policyFile], 180000);
  const candidateDirectory = path.dirname(JSON.parse(candidateLog.trim().split('\n').at(-1)).path);
  report.candidate = path.relative(directory, candidateDirectory); await save();
  await run('verify-candidate', candidateRoot, 'scripts/verify-performance-report.mjs', [candidateDirectory, '--clean'], 20000);
  // Comparison runs in candidate checkout, independently re-reading raw files.
  const comparisonLog = await run('compare', candidateRoot, 'scripts/verify-performance-bounded.mjs', [directory, '--collecting'], 20000);
  report.comparison = JSON.parse(comparisonLog.trim().split('\n').at(-1));
  report.complete = report.comparison.evidenceValid === true;
  report.performanceEvaluated = report.comparison.performanceEvaluated;
  report.performancePassed = report.comparison.passed;
} catch (error) { report.error = error.message; }
finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  report.interrupted = interrupted; report.finishedAt = new Date().toISOString();
  if (interrupted || Date.now() > deadline) report.complete = false;
  report.exitCode = !report.complete ? 3 : report.performanceEvaluated && !report.performancePassed ? 1 : 0;
  await save(); console.log(JSON.stringify({ directory, ...report }, null, 2)); process.exitCode = report.exitCode;
}
