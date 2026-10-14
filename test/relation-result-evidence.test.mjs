import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { relationResultProfile } from '../verification/relation-result-properties.mjs';
import { validateResult, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';

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
