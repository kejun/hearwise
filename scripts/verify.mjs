import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pilot } from '../verification/properties.mjs';
import { metadata, writeJson, digest, sourceVersion, summarize, checkArtifacts } from './lib/verification-evidence.mjs';
import { runProcess } from './lib/process.mjs';
import { onceOutputContains } from './lib/output-marker.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--release' && !/^--scenario=(success|business-failure|timeout|interrupt)$/.test(arg))) {
  throw new Error('Usage: npm run verify -- [--release] [--scenario=success|business-failure|timeout|interrupt]');
}
const scenario = args.find(arg => arg.startsWith('--scenario='))?.split('=')[1] || 'success';
const root = path.resolve(process.env.VERIFICATION_EVIDENCE_DIR || 'verification-evidence');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-'));
const context = await metadata(), startedAt = new Date().toISOString();
const report = { ...context, startedAt, finishedAt: null, complete: false, ok: false, profile: 'pilot', scenario, results: [] };
await writeJson(path.join(directory, 'context.json'), context);
await writeJson(path.join(directory, 'report.json'), report);
console.log(`Verification evidence: ${directory}`);
let execution;
try {
  execution = await runProcess(process.execPath, ['test-support/verification-relation.mjs', scenario, directory], {
    logFile: path.join(directory, 'worker.log'), timeoutMs: scenario === 'timeout' ? 1500 : 15000, graceMs: 300,
    onOutput: scenario === 'interrupt' ? onceOutputContains('PROVIDER_PENDING', () => process.kill(process.pid, 'SIGTERM')) : undefined
  });
} finally {
  // Parent cleans the file-backed SQLite database even after a killed worker.
  await rm(path.join(directory, 'temporary-database'), { recursive: true, force: true });
}
execution.complete = !execution.timedOut && !execution.interrupted && execution.signal == null && [0, 1].includes(execution.code);
let result;
try { result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); }
catch { /* A worker that never completed is represented explicitly below. */ }
if (!result) result = { ...context, property: { id: 'HW-04-01', version: 1 },
  scope: { description: 'Relation fixture did not produce a complete result.', scenario, samples: 1, seed: null },
  startedAt, finishedAt: new Date().toISOString(), complete: false, status: 'incomplete' };
result.artifacts = [];
for (const name of ['observations.json', 'worker.log']) {
  try { result.artifacts.push({ path: name, sha256: digest(await readFile(path.join(directory, name))) }); }
  catch { /* An absent artifact is not accepted by the final gate. */ }
}
if (result.artifacts.length !== 2) result.complete = false;
await writeJson(path.join(directory, 'result.json'), result);
const target = sourceVersion();
if (target.sha !== context.source.sha || target.dirty !== context.source.dirty) execution.complete = false;
const summary = summarize({ results: [result], required: pilot, execution, target,
  release: args.includes('--release'), artifactsValid: [await checkArtifacts(directory, result)] });
Object.assign(report, { finishedAt: new Date().toISOString(), complete: execution.complete, ok: summary.ok,
  execution, results: [result], summary });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows,
  fullProjectAcceptance: false }, null, 2));
process.exitCode = report.ok ? 0 : 1;
