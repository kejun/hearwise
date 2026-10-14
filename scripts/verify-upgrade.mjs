import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './lib/process.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
import { atomicitySource } from '../test-support/import-atomicity-evidence.mjs';
import { hash, upgradeVersion, upgradeControls } from '../test-support/upgrade-evidence.mjs';
import { collectAtomicityControls } from './lib/import-atomicity-controls.mjs';
import { upgradeChecks, evaluateUpgradeReport } from './lib/upgrade-report.mjs';
const args = process.argv.slice(2); if (args.some(value => value !== '--release')) throw new Error('Usage: verify:upgrade [--release]');
const root = process.env.UPGRADE_EVIDENCE_DIR || 'verification-evidence/upgrade'; await mkdir(root, { recursive: true });
const directory = path.resolve(await mkdtemp(path.join(root, 'run-'))), temporary = await mkdtemp(path.join(os.tmpdir(), 'hearwise-upgrade-profile-'));
const report = { profile: 'install-upgrade', budgetMs: 300000, version: upgradeVersion, sourceStart: await atomicitySource(), sourceEnd: null,
  cwd: process.cwd(), directory, startedAt: new Date().toISOString(), finishedAt: null, complete: false, ok: false, finalized: false, checks: [], artifacts: [], cleanupOk: false,
  environment: { node: process.version, npm: null, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, release: os.release() } };
const output = path.join(directory, 'report.json'); await writeJson(output, report); console.log(`Install/upgrade evidence: ${directory}`);
const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }; delete env.NODE_TEST_CONTEXT;
const deadline = Date.now() + 300000;
try {
  for (const check of upgradeChecks(directory)) {
    const remaining = deadline - Date.now(); if (remaining < check.timeoutMs) throw new Error('Insufficient remaining profile deadline');
    const startedAt = Date.now();
    const execution = await runProcess(process.execPath, check.command, { env, timeoutMs: check.timeoutMs,
      logFile: path.join(directory, `${check.name}.log`), onOutput: text => process.stdout.write(text) });
    report.checks.push({ ...check, startedAt, finishedAt: Date.now(), command: [process.execPath, ...check.command], cwd: process.cwd(), log: `${check.name}.log`, execution }); await writeJson(output, report);
    if (execution.interrupted || execution.timedOut || execution.signal) break;
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally { try { await rm(temporary, { recursive: true, force: true }); report.cleanupOk = true; } catch (error) { report.cleanupError = { name: error.name, message: error.message }; } }
await collectAtomicityControls(directory, report, upgradeControls);
try { report.environment.npm = JSON.parse(await readFile(path.join(directory, 'install.json'), 'utf8')).environment.npm; } catch {}
report.sourceEnd = await atomicitySource(); report.finishedAt = new Date().toISOString();
for (const name of ['data.log', 'install.log', 'observations.json', 'install.json', 'controls.json',
  ...['missing-build', 'ci', 'version', 'build', 'reinstall'].map(name => `install-${name}.log`)]) {
  try { report.artifacts.push({ path: name, sha256: hash(await readFile(path.join(directory, name))) }); } catch { /* missing evidence fails closed */ }
}
await writeJson(output, report);
const summary = await evaluateUpgradeReport(directory, { release: args.includes('--release') }); Object.assign(report, { complete: summary.complete, ok: summary.ok, summary, finalized: true });
await writeJson(output, report); console.log(JSON.stringify({ directory, ...summary }, null, 2)); process.exitCode = summary.ok ? 0 : 1;
