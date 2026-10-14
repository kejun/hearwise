// Genuine HTTP/SQLite matrices and transactions, with explicitly synthetic TAP,
// UI text and PNG envelopes. This fixture never claims Chromium execution.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../scripts/lib/process.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { atomicityChecks, atomicityRegressionNames } from './import-atomicity-contract.mjs';
import { atomicitySource, atomicityEvidenceControls, atomicityProperties, hash } from './import-atomicity-evidence.mjs';
import { importAtomicityFixture } from './import-atomicity-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
let rawPromise, browserPromise;
async function collectRaw() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomicity-release-raw-')), startedAt = new Date().toISOString();
  try {
    const output = path.join(directory, 'raw.json'), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const execution = await runProcess(process.execPath, ['test-support/import-atomicity-worker.mjs', output], { timeoutMs: 55000, env });
    assert.equal(execution.ok, true, execution.tail);
    const raw = JSON.parse(await readFile(output)); return { raw, startedAt, finishedAt: new Date().toISOString() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function collectBrowserEnvelope() {
  const browser = { version: '1.0', source: sourceVersion(), chromium: 'synthetic-reader-envelope-only', scenarios: [], cleanup: [{ target: 'Chromium', ok: true }], complete: true, ok: true };
  for (const mode of ['append', 'replace']) {
    const fixture = await importAtomicityFixture(), row = { mode, snapshots: [], http: [], screenshots: [], providerCalls: [], pageErrors: [], cleanup: [{ target: 'context', ok: true }, { target: 'fixture', ok: true }], complete: true, ok: true };
    browser.scenarios.push(row);
    try {
      const record = label => { const database = fixture.snapshot(); row.snapshots.push({ label, database }); return database; };
      const before = record('before'); row.download = { name: 'synthetic-reader-export.sqlite', bytes: 1, database: before };
      let review = await fixture.upload(mode); row.incoming = await fixture.preparedSnapshot();
      await fixture.arm({ fault: 'write' }); const failed = await fixture.commit(review); await fixture.disarm();
      row.http.push(failed); record('after-failure'); row.failureEvents = await fixture.events(); row.failureStatus = '导入失败';
      review = await fixture.upload(mode); const saved = await fixture.commit(review); row.http.push(saved); record('after-explicit-retry');
      const safety = path.join(fixture.directory, 'backups', saved.body.safetyBackup); row.safetyBackup = databaseSnapshot(safety);
      row.http.push(await fixture.restoreBackup(safety)); record('after-safety-restore');
      row.runtimes = await fixture.runtimes(); row.providerCalls = [...fixture.calls];
      row.screenshots = ['failure', 'restored'].map(label => ({ path: `atomicity-${mode}-${label}.png`, sha256: hash(png) }));
    } finally { await fixture.close(); }
  }
  return browser;
}
export async function atomicityReleaseFixture(directory, { nodeOnly = false, outerRun = 'run-contract' } = {}) {
  await mkdir(directory, { recursive: true }); rawPromise ||= collectRaw(); const { raw, startedAt } = await rawPromise;
  if (!nodeOnly) browserPromise ||= collectBrowserEnvelope(); const browser = nodeOnly ? null : await browserPromise;
  const source = await atomicitySource(), expectedDirectory = path.join(process.cwd(), nodeOnly ? 'verification-evidence/import-atomicity' : `browser-evidence/${outerRun}`, path.basename(directory));
  const report = { profile: 'import-atomicity', version: '1.0', nodeOnly, release: false, startedAt, finishedAt: new Date().toISOString(),
    sourceStart: source, sourceEnd: source, tools: { node: process.version, sqlite: process.versions.sqlite },
    cwd: process.cwd(), evidenceDirectory: expectedDirectory, environment: { platform: process.platform, arch: process.arch, release: os.release() }, checks: [], artifacts: [], cleanupOk: true, complete: true, ok: true };
  const names = atomicityRegressionNames, tap = 'TAP version 13\n' + names.map((name, index) => `# Subtest: ${name}\nok ${index + 1} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n`).join('') + `1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  const logs = { node: raw.scenarios.map(row => `PASS ${row.id}\n`).join(''), regressions: tap, browser: 'Explicitly synthetic browser reader envelope\n' };
  for (const check of atomicityChecks(expectedDirectory, nodeOnly)) {
    const log = logs[check.name]; await writeFile(path.join(directory, `${check.name}.log`), log);
    report.checks.push({ name: check.name, command: [process.execPath, ...check.command], cwd: process.cwd(), configuredTimeoutMs: check.timeout, effectiveTimeoutMs: check.timeout, log: `${check.name}.log`,
      execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 1, tail: log.slice(-12000) } });
  }
  await json(path.join(directory, 'observations.json'), raw); await json(path.join(directory, 'controls.json'), atomicityEvidenceControls(raw));
  if (browser) { await json(path.join(directory, 'browser.json'), browser); for (const row of browser.scenarios) for (const shot of row.screenshots) await writeFile(path.join(directory, shot.path), png); }
  const files = ['observations.json', 'controls.json', ...report.checks.map(row => row.log), ...(browser ? ['browser.json', ...browser.scenarios.flatMap(row => row.screenshots.map(shot => shot.path))] : [])];
  for (const file of files) report.artifacts.push({ path: file, sha256: hash(await readFile(path.join(directory, file))) });
  report.summary = { complete: true, ok: true, nodeOnly, fullImportAtomicityAcceptance: !nodeOnly, fullProjectAcceptance: false,
    rows: atomicityProperties.map((id, index) => ({ id, status: nodeOnly && index === 3 ? 'not_run' : 'passed', reasons: nodeOnly && index === 3 ? ['node_only_profile'] : [] })) };
  await json(path.join(directory, 'report.json'), report); return { report, raw, browser, outerLog: `Import atomicity evidence: browser-evidence/${outerRun}/${path.basename(directory)}\n` };
}
