import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'; import path from 'node:path'; import { tmpdir } from 'node:os';
import { runOfflineQuality } from '../test-support/quality-offline.mjs';
import { inspectOfflineQualityEvidence } from '../scripts/lib/quality-offline-evidence.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
test('offline raw artifacts prove four loopback trials and cannot satisfy either real quality property', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-offline-evidence-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runOfflineQuality(path.join(directory, 'collection'));
  assert.equal(report.complete, true); const ledgerFile = path.join(directory, 'provider-ledger.json');
  await writeFile(ledgerFile, JSON.stringify(report.actualStubRequests));
  const result = await inspectOfflineQualityEvidence(directory, report.sourceStart);
  assert.equal(result.infrastructurePassed, true); assert.equal(result.complete, true); assert.equal(result.liveCalls, 0); assert.equal(result.actualLoopbackCalls, 4);
  assert.equal(result.artifacts.length, 10); assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false); assert.equal(result.fullQualityAcceptance, false);
  assert.ok(result.properties.every(row => row.status === 'not_run' && !row.complete));
  const collectionFile = path.join(directory, 'collection/collection.json'), original = await readFile(collectionFile);
  for (const mutate of [r => r.complete = false, r => r.mode = 'live', r => r.trials.pop(), r => r.budget.after.attempts.pop(), r => r.sourceEnd.files['server.mjs'] = 'a'.repeat(64)]) {
    const changed = JSON.parse(original); mutate(changed); await writeFile(collectionFile, JSON.stringify(changed));
    const negative = await inspectOfflineQualityEvidence(directory, report.sourceStart); assert.equal(negative.infrastructurePassed, false); assert.equal(negative.qualityStatus, 'not_run');
  }
  await writeFile(collectionFile, original);
  await writeFile(ledgerFile, JSON.stringify(report.actualStubRequests.slice(1))); assert.equal((await inspectOfflineQualityEvidence(directory, report.sourceStart)).infrastructurePassed, false);
  await writeFile(ledgerFile, JSON.stringify(report.actualStubRequests));
  const trialFile = path.join(directory, 'collection/trial-0/trial.json'), trial = JSON.parse(await readFile(trialFile)); trial.logTruncated = true;
  const bytes = JSON.stringify(trial); await writeFile(trialFile, bytes); const changed = JSON.parse(original); changed.trials[0].sha256 = hashBytes(bytes); await writeFile(collectionFile, JSON.stringify(changed));
  assert.equal((await inspectOfflineQualityEvidence(directory, report.sourceStart)).infrastructurePassed, false);
  assert.equal((await inspectOfflineQualityEvidence(directory, { ...report.sourceStart, sha: 'a'.repeat(40) })).infrastructurePassed, false);
});
