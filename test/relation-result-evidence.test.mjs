import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { relationResultProfile } from '../verification/relation-result-properties.mjs';
import { validateResult, checkArtifacts, metadata } from '../scripts/lib/verification-evidence.mjs';

test('node-only relation result evidence cannot turn missing browser coverage into a pass', { timeout: 40000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relation-result-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const execution = await runProcess(process.execPath, ['scripts/verify-relation-result-browser.mjs', '--node-only'], {
    env: { ...process.env, RELATION_RESULT_EVIDENCE_DIR: directory }, timeoutMs: 35000
  });
  assert.equal(execution.code, 1, execution.tail);
  assert.equal(execution.timedOut, false);
  const children = await readdir(directory); assert.equal(children.length, 1);
  const evidence = path.join(directory, children[0]);
  const report = JSON.parse(await readFile(path.join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.ok, false); assert.equal(report.complete, true);
  const observations = JSON.parse(await readFile(path.join(evidence, 'observations.json'), 'utf8'));
  assert.deepEqual(observations.checks.map(check => check.name), ['source-integrity', 'http-results']);
  assert.ok(observations.checks[0].execution.testCount >= 80, 'Existing source regressions must actually run');
  assert.equal(observations.checks[1].execution.testCount, 1, 'The six-scenario HTTP test must actually run');
  assert.ok(observations.checks.every(check => !check.execution.tail.includes('skipping running files')));
  assert.deepEqual(report.results.map(result => result.property.id), relationResultProfile);
  assert.equal(report.results.find(result => result.property.id === 'HW-05-02').status, 'passed');
  assert.equal(report.results.filter(result => result.status === 'not_run').length, 2);
  for (const result of report.results) {
    assert.equal(validateResult(result), true);
    assert.equal(await checkArtifacts(evidence, result), true);
  }
  assert.equal((await readdir(evidence)).some(name => name.startsWith('temporary-runtime-')), false);
});

// Synthetic bytes test evidence packaging only. They are not Chromium observations.
test('complete browser asset packaging respects the two-artifact contract and verifies referenced files', async t => {
  const { writeRelationResultEvidence, checkRelationResultEvidence } = await import('../test-support/relation-result-evidence.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relation-asset-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scenarios = ['shortage', 'empty', 'filtered', 'qualified', 'partial', 'error'];
  const browser = { complete: true, widths: [1280, 390].map(width => ({ width, results: scenarios.map(scenario => ({ scenario })) })) };
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(browser));
  for (const { width, results } of browser.widths) for (const { scenario } of results)
    await writeFile(path.join(directory, `relations-${width}-${scenario}.png`), 'synthetic image bytes, not a UI result');
  await writeFile(path.join(directory, 'browser.log'), 'synthetic packaging check');
  const artifacts = await writeRelationResultEvidence(directory, { checks: [{ name: 'browser' }], browser });
  const result = { ...await metadata(), property: { id: 'HW-11-03', version: 1 },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), complete: true, status: 'passed',
    scope: { description: 'Synthetic artifact contract only', scenario: 'unit-test', samples: 1, seed: null }, artifacts };
  assert.equal(validateResult(result), true, 'Browser attachments must not expand the public two-artifact result contract');
  assert.equal(artifacts.length, 2);
  assert.equal(await checkRelationResultEvidence(directory, result), true);
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  assert.equal(observations.attachments.length, 13);
  const screenshot = path.join(directory, 'relations-390-empty.png');
  await writeFile(screenshot, 'changed');
  assert.equal(await checkRelationResultEvidence(directory, result), false, 'A changed referenced screenshot invalidates evidence');
  await rm(screenshot);
  assert.equal(await checkRelationResultEvidence(directory, result), false, 'A missing referenced screenshot invalidates evidence');
  await assert.rejects(writeRelationResultEvidence(directory, { checks: [{ name: 'browser' }], browser }), /ENOENT/);
});

test('relation evidence rejects skipped, todo, missing, cancelled or inconsistent TAP coverage', async () => {
  const { relationTapSummary } = await import('../test-support/relation-result-evidence.mjs');
  const tap = ({ tests = 2, pass = 2, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
    Object.entries({ tests, pass, fail, cancelled, skipped, todo }).map(([key, value]) => `# ${key} ${value}\n`).join('');
  assert.deepEqual(relationTapSummary(tap()), { testCount: 2, testComplete: true, ok: true });
  for (const text of [tap({ pass: 0, skipped: 2 }), tap({ pass: 0, todo: 2 }), tap({ pass: 1, cancelled: 1 }),
    tap({ tests: 0, pass: 0 }), tap().replace('# pass 2\n', ''), tap({ pass: 1 })]) {
    assert.equal(relationTapSummary(text).ok, false, text);
    assert.equal(relationTapSummary(text).testComplete, false, text);
  }
  assert.deepEqual(relationTapSummary(tap({ pass: 1, fail: 1 })), { testCount: 2, testComplete: true, ok: false });
});
