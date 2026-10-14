import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './lib/process.mjs';
import { atomicityChecks, atomicityRegressionTap } from '../test-support/import-atomicity-contract.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
import { atomicitySource, atomicityVersion, hash } from '../test-support/import-atomicity-evidence.mjs';
import { collectAtomicityControls } from './lib/import-atomicity-controls.mjs';
import { readAtomicityReport } from './lib/import-atomicity-report.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: verify:import-atomicity [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), release = args.includes('--release');
const root = process.env.IMPORT_ATOMICITY_EVIDENCE_DIR || 'verification-evidence/import-atomicity'; await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-')), temporary = await mkdtemp(path.join(os.tmpdir(), 'hearwise-atomicity-run-'));
const report = { profile: 'import-atomicity', version: atomicityVersion, nodeOnly, release, startedAt: new Date().toISOString(), finishedAt: null,
  sourceStart: await atomicitySource(), sourceEnd: null, tools: { node: process.version, sqlite: process.versions.sqlite },
  cwd: process.cwd(), evidenceDirectory: path.resolve(directory), environment: { platform: process.platform, arch: process.arch, release: os.release() }, checks: [], artifacts: [], cleanupOk: false, complete: false, ok: false };
const output = path.join(directory, 'report.json'); await writeJson(output, report); console.log(`Import atomicity evidence: ${directory}`);
const env = { ...process.env, IMPORT_ATOMICITY_TEST_EVIDENCE_FILE: path.resolve(directory, 'observations.json'), TMPDIR: temporary, TMP: temporary, TEMP: temporary }; delete env.NODE_TEST_CONTEXT;
const deadlineAt = Date.now() + 150000;
const checks = atomicityChecks(directory, nodeOnly);
try {
  for (const check of checks) {
    const remaining = deadlineAt - Date.now(); if (remaining <= 0) throw new Error('Import atomicity outer deadline expired');
    const log = `${check.name}.log`;
    const execution = await runProcess(process.execPath, check.command, { env, timeoutMs: Math.min(check.timeout, remaining),
      logFile: path.join(directory, log), onOutput: text => process.stdout.write(text) });
    if (check.name === 'regressions') {
      const parsed = atomicityRegressionTap(await readFile(path.join(directory, log), 'utf8'));
      Object.assign(execution, parsed, { ok: execution.ok && parsed.ok });
    }
    report.checks.push({ name: check.name, command: [process.execPath, ...check.command], cwd: process.cwd(), configuredTimeoutMs: check.timeout, effectiveTimeoutMs: Math.min(check.timeout, remaining), execution, log });
    await writeJson(output, report);
    if (execution.timedOut || execution.interrupted || execution.signal !== null) break;
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally { await rm(temporary, { recursive: true, force: true }); report.cleanupOk = true; }
await collectAtomicityControls(directory, report);
report.sourceEnd = await atomicitySource(); report.finishedAt = new Date().toISOString();
const files = ['observations.json', 'controls.json', ...report.checks.map(check => check.log)];
if (!nodeOnly) {
  try {
    const browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); files.push('browser.json');
    for (const row of browser.scenarios) for (const shot of row.screenshots) files.push(shot.path);
  } catch { /* The independent reader reports missing browser evidence. */ }
}
for (const file of files) {
  try { report.artifacts.push({ path: file, sha256: hash(await readFile(path.join(directory, file))) }); }
  catch { /* A missing artifact cannot be a passing report. */ }
}
await writeJson(output, report);
const summary = await readAtomicityReport(directory, { release, nodeOnly });
Object.assign(report, { complete: summary.complete, ok: summary.ok, summary }); await writeJson(output, report);
console.log(JSON.stringify({ directory, ...summary }, null, 2)); process.exitCode = summary.ok ? 0 : 1;
