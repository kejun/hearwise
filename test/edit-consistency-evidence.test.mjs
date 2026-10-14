import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { metadata, validateResult } from '../scripts/lib/verification-evidence.mjs';
import { editConsistencyProfile } from '../verification/edit-consistency-properties.mjs';
import { editScenarios, editBrowserAssets, writeEditEvidence, checkEditEvidence, summarizeEditResults } from '../test-support/edit-consistency-evidence.mjs';

// Sequential child budgets total 50s; allow 15s for startup, cleanup and report output,
// then 10s for assertions/fixture teardown, below the unchanged 90s file watchdog.
test('node-only edit evidence runs the real HTTP cases but leaves every UI-dependent property not run', { timeout: 75000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edit-report-')); t.after(() => rm(root, { recursive: true, force: true }));
  const execution = await runProcess(process.execPath, ['scripts/verify-edit-consistency-browser.mjs', '--node-only'],
    { env: { ...process.env, EDIT_CONSISTENCY_EVIDENCE_DIR: root }, timeoutMs: 65000 });
  assert.equal(execution.code, 1, execution.tail); assert.equal(execution.timedOut, false);
  const names = await readdir(root); assert.equal(names.length, 1); const directory = path.join(root, names[0]);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  assert.equal(report.complete, true); assert.equal(report.ok, false);
  assert.deepEqual(report.results.map(row => row.property.id), editConsistencyProfile);
  assert.ok(report.results.every(row => row.status === 'not_run'));
  assert.deepEqual(observations.checks.map(check => [check.name, check.execution.testCount, check.execution.testComplete, check.execution.ok]),
    [['notification', 2, true, true], ['http', 6, true, true]]);
  for (const result of report.results) { assert.equal(validateResult(result), true); assert.equal(await checkEditEvidence(directory, result), true); }
  assert.equal((await readdir(directory)).some(name => name.startsWith('temporary-runtime-')), false);
});

test('synthetic edit evidence packaging verifies every browser attachment without expanding the shared result contract', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'edit-attachments-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // Synthetic JSON/PNG bytes exercise packaging only, never actual UI behavior.
  const browser = { complete: true, ok: true, widths: [1280, 390].map(width => ({ width, results: editScenarios.map(scenario => ({ scenario, complete: true, ok: true })) })),
    negative: { complete: true, classification: 'implementation_mismatch', property: 'HW-06-06', counterexample: { writes: 2, explicitSaves: 1, persistedName: 'Mira' } } };
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(browser));
  for (const name of editBrowserAssets.filter(name => name.endsWith('.png'))) await writeFile(path.join(directory, name), 'Synthetic packaging fixture only');
  await writeFile(path.join(directory, 'browser.log'), 'Synthetic packaging test');
  const artifacts = await writeEditEvidence(directory, { checks: [{ name: 'browser' }], browser });
  const result = { ...await metadata(), property: { id: 'HW-11-04', version: 1 }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    complete: true, status: 'passed', scope: { description: 'Synthetic attachment contract only', scenario: 'unit-test', samples: 1, seed: null }, artifacts };
  assert.equal(validateResult(result), true); assert.equal(artifacts.length, 2); assert.equal(await checkEditEvidence(directory, result), true);
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8')); assert.equal(observations.attachments.length, 12);
  await writeFile(path.join(directory, 'edits-390-auto-resend-negative.png'), 'Tampered');
  assert.equal(await checkEditEvidence(directory, result), false);
  await rm(path.join(directory, 'edits-1280-conflict.png'));
  assert.equal(await checkEditEvidence(directory, result), false);
  await assert.rejects(writeEditEvidence(directory, { checks: [{ name: 'browser' }], browser }), /ENOENT/);
});

test('edit profile isolates notification failures but fails closed for missing dispatch or browser coverage', async () => {
  const context = await metadata(), time = new Date().toISOString();
  const results = editConsistencyProfile.map((id, index) => ({ ...context, property: { id, version: 1 }, startedAt: time, finishedAt: time, complete: true,
    status: index === 1 ? 'failed' : 'passed', scope: { description: 'Synthetic outcome classification', scenario: 'unit-test', samples: 1, seed: null },
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: '0'.repeat(64) })) }));
  const checks = ['notification', 'http', 'browser'].map(name => ({ name, execution: { code: name === 'notification' ? 1 : 0, ok: name !== 'notification',
    signal: null, timedOut: false, interrupted: false, testComplete: true } }));
  const options = { results, checks, target: context.source, required: editConsistencyProfile, artifactsValid: [true, true, true], sourceStable: true };
  const outcome = summarizeEditResults(options); assert.equal(outcome.summary.ok, false);
  assert.deepEqual(outcome.summary.rows.map(row => row.status), ['passed', 'failed', 'passed']);
  const missing = summarizeEditResults({ ...options, checks: checks.slice(0, 1) });
  assert.equal(missing.execution.complete, false); assert.equal(missing.summary.ok, false);
  assert.ok(missing.summary.rows.every(row => row.status === 'incomplete'));
});
