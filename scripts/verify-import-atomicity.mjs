import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './lib/process.mjs';
import { tapSummary } from './lib/tap-summary.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
import { atomicitySource, atomicityVersion, hash, atomicityEvidenceControls } from '../test-support/import-atomicity-evidence.mjs';
import { readAtomicityReport } from './lib/import-atomicity-report.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: verify:import-atomicity [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), release = args.includes('--release');
const root = process.env.IMPORT_ATOMICITY_EVIDENCE_DIR || 'verification-evidence/import-atomicity'; await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-')), temporary = await mkdtemp(path.join(os.tmpdir(), 'hearwise-atomicity-run-'));
const report = { profile: 'import-atomicity', version: atomicityVersion, nodeOnly, release, startedAt: new Date().toISOString(), finishedAt: null,
  sourceStart: await atomicitySource(), sourceEnd: null, tools: { node: process.version, sqlite: process.versions.sqlite },
  environment: { platform: process.platform, arch: process.arch, release: os.release() }, checks: [], artifacts: [], cleanupOk: false, complete: false, ok: false };
const output = path.join(directory, 'report.json'); await writeJson(output, report); console.log(`Import atomicity evidence: ${directory}`);
const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }; delete env.NODE_TEST_CONTEXT;
const deadlineAt = Date.now() + 150000;
const checks = [
  { name: 'node', command: ['test-support/import-atomicity-worker.mjs', path.join(directory, 'observations.json')], timeout: 55000 },
  { name: 'regressions', command: ['--test', '--test-reporter=tap', '--test-timeout=20000', 'test/import-atomicity-crash.test.mjs', 'test/import-atomicity-data.test.mjs', 'test/import-atomicity-evidence.test.mjs'], timeout: 55000 },
  ...(!nodeOnly ? [{ name: 'browser', command: ['test-support/import-atomicity-browser.mjs', directory], timeout: 55000 }] : [])
];
try {
  for (const check of checks) {
    const remaining = deadlineAt - Date.now(); if (remaining <= 0) throw new Error('Import atomicity outer deadline expired');
    const log = `${check.name}.log`;
    const execution = await runProcess(process.execPath, check.command, { env, timeoutMs: Math.min(check.timeout, remaining),
      logFile: path.join(directory, log), onOutput: text => process.stdout.write(text) });
    if (check.name === 'regressions') {
      const parsed = tapSummary(await readFile(path.join(directory, log), 'utf8'));
      Object.assign(execution, parsed, { ok: execution.ok && parsed.ok && parsed.testCount === 31 });
    }
    report.checks.push({ name: check.name, command: [process.execPath, ...check.command], configuredTimeoutMs: check.timeout, execution, log });
    await writeJson(output, report);
    if (execution.timedOut || execution.interrupted || execution.signal !== null) break;
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally { await rm(temporary, { recursive: true, force: true }); report.cleanupOk = true; }
try {
  const raw = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  await writeJson(path.join(directory, 'controls.json'), atomicityEvidenceControls(raw));
} catch (error) { report.error ||= { name: error.name, message: error.message }; }
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
