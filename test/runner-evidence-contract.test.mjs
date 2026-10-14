import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { tapSummary } from '../scripts/lib/tap-summary.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { browserChecks, browserScreenshots, rootScreenshots, findNodeTests, sourceSnapshot, sameSourceSnapshot, evidenceFiles, hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';

test('real Node aggregate fixes TAP and isolates inherited node:test context without changing the selected test', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-report-contract-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const execution = await runProcess(process.execPath, ['scripts/run-tests.mjs', 'test/asr-params.test.mjs'], {
    env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', TEST_EVIDENCE_DIR: directory }, timeoutMs: 15000 });
  assert.equal(execution.code, 0, execution.tail);
  const report = JSON.parse(await readFile(path.join(directory, 'results.json')));
  assert.equal(report.schemaVersion, 2); assert.equal(report.complete, true); assert.equal(report.ok, true);
  assert.equal(report.results.length, 1); assert.equal(report.results[0].file, 'test/asr-params.test.mjs');
  const log = await readFile(report.results[0].log, 'utf8'); assert.equal(tapSummary(log).ok, true, log);
  assert.equal(report.results[0].logSha256, digest(log)); assert.equal(sameSourceSnapshot(report.sourceStart, report.sourceEnd), true);
  assert.ok(Object.keys(report.sourceStart.digests).includes('dist/server/index.js'));
});
test('all browser checks and mandatory image outputs remain explicitly registered', () => {
  assert.deepEqual(browserChecks, ['speech', 'speech-seek', 'graph', 'relation-progress', 'trace', 'transcript', 'knowledge-edit', 'data-transfer', 'knowledge-name', 'knowledge-revision', 'session', 'relation-result']);
  assert.deepEqual(Object.keys(browserScreenshots).sort(), [...browserChecks].sort());
  assert.equal(browserScreenshots.session.length, 7); assert.equal(browserScreenshots['relation-result'].length, 12);
  assert.deepEqual(browserScreenshots.speech, Object.values(rootScreenshots));
});
test('source binding sees actual content and built server, and evidence refuses symlinks/traversal', async t => {
  const before = await sourceSnapshot(); assert.equal(sameSourceSnapshot(before, structuredClone(before)), true);
  for (const file of ['public/app.js', 'dist/server/index.js', 'package-lock.json']) {
    const after = structuredClone(before); after.digests[file] = '0'.repeat(64); assert.equal(sameSourceSnapshot(before, after), false);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runner-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'a.log'), 'actual output');
  assert.deepEqual(await evidenceFiles(directory), ['a.log']); assert.equal((await hashEvidenceFiles(directory, ['a.log']))[0].sha256, digest('actual output'));
  await assert.rejects(hashEvidenceFiles(directory, ['../outside']));
  await symlink('a.log', path.join(directory, 'link.log')); await assert.rejects(evidenceFiles(directory)); await assert.rejects(hashEvidenceFiles(directory, ['link.log']));
  assert.ok((await findNodeTests()).includes('test/runner-evidence-contract.test.mjs'));
});
