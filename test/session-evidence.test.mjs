import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { nestedProfileDeadlineMs, nestedProfileTestDeadlineMs } from '../scripts/lib/test-schedule.mjs';
import { profileEvidenceDirectory } from '../test-support/profile-test-evidence.mjs';
import { sessionProfile } from '../verification/session-properties.mjs';
import { validateResult, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';

test('node-only session evidence cannot turn missing browser coverage into a pass', { timeout: nestedProfileTestDeadlineMs }, async t => {
  const directory = await profileEvidenceDirectory('session');
  const execution = await runProcess(process.execPath, ['scripts/verify-session-browser.mjs', '--node-only'], {
    env: { ...process.env, SESSION_EVIDENCE_DIR: directory }, timeoutMs: nestedProfileDeadlineMs
  });
  assert.equal(execution.code, 1, execution.tail);
  assert.equal(execution.timedOut, false, JSON.stringify(execution));
  const children = await readdir(directory); assert.equal(children.length, 1);
  const evidence = path.join(directory, children[0]);
  const report = JSON.parse(await readFile(path.join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.ok, false); assert.equal(report.complete, true, JSON.stringify(report));
  const observations = JSON.parse(await readFile(path.join(evidence, 'observations.json'), 'utf8'));
  assert.ok(observations.checks.every(check => check.execution.testCount >= 4), 'Each nested subprocess must actually run tests');
  assert.ok(observations.checks.every(check => !check.execution.tail.includes('skipping running files')));
  assert.deepEqual(report.results.map(result => result.property.id), sessionProfile);
  assert.equal(report.results.find(result => result.property.id === 'HW-01-02').status, 'passed');
  assert.equal(report.results.filter(result => result.status === 'not_run').length, 4);
  for (const result of report.results) {
    assert.equal(validateResult(result), true);
    assert.equal(await checkArtifacts(evidence, result), true);
  }
  assert.equal((await readdir(evidence)).some(name => name.startsWith('temporary-runtime-')), false);
});
