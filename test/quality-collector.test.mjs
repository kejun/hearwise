import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises'; import path from 'node:path'; import { tmpdir } from 'node:os';
import { runOfflineQuality } from '../test-support/quality-offline.mjs';

test('one collector traverses real public ASR/SQLite and MT while offline evidence stays not_run', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-public-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runOfflineQuality(path.join(directory, 'run'));
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.cleanup, true); assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false);
  assert.equal(result.trials.length, 4); assert.equal(result.mode, 'offline'); assert.equal(result.actualStubRequests.filter(row => row.kind === 'asr').length, 2);
  assert.equal(result.actualStubRequests.filter(row => row.kind === 'mt').length, 2); assert.equal(result.budget.after.attempts.length, 4);
  for (const artifact of result.trials) {
    const trial = JSON.parse(await readFile(path.join(directory, 'run', artifact.path)));
    assert.equal(trial.evidenceKind, 'offline-provider-stub'); assert.equal(trial.complete, true); assert.ok(trial.traceBuilds.length);
    if (trial.kind === 'asr') { assert.equal(trial.result.output, 'Do not pay 15.'); assert.equal(trial.result.segments.length, 1); assert.equal(trial.result.audioBytes, 640); assert.equal(trial.provider.filter(row => row.attemptId).length, 1); }
    else assert.equal(trial.result.output, '不要支付15。');
  }
  assert.doesNotMatch(JSON.stringify(result), /offline-upstream-sentinel/);
});

test('conflicting revised ASR final remains a measured canonical result, not a discarded difficult sample', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-revision-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runOfflineQuality(path.join(directory, 'run'), { providerOptions: { revision: 'Pay 15.' } });
  assert.equal(result.complete, true);
  const trial = JSON.parse(await readFile(path.join(directory, 'run', result.trials[0].path)));
  assert.ok(trial.result.events.some(row => row.event.type === 'caption-correction'));
  assert.equal(trial.result.output, 'Do not pay 15.'); assert.equal(trial.result.segments.length, 1);
});
test('pre-send cancellation persists an incomplete zero-reservation collection rather than quality pass', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-cancel-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOfflineQuality(path.join(directory, 'run'), { signal: controller.signal }));
  const report = JSON.parse(await readFile(path.join(directory, 'run', 'collection.json')));
  assert.equal(report.complete, false); assert.equal(report.interrupted, true); assert.equal(report.cleanup, true);
  assert.equal(report.trials.length, 0); assert.equal(report.budget.after.attempts.length, 0); assert.equal(report.budget.after.reservedMicros, 0);
  assert.equal(report.qualityStatus, 'not_run'); assert.equal(report.qualityEvaluated, false);
});
test('empty ASR output is retained for a later hallucination/omission review', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-empty-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runOfflineQuality(path.join(directory, 'run'), { providerOptions: { output: '' } });
  assert.equal(result.complete, true);
  const trial = JSON.parse(await readFile(path.join(directory, 'run', result.trials[0].path)));
  assert.equal(trial.result.output, ''); assert.deepEqual(trial.result.segments, []); assert.equal(trial.outputSha256.length, 64);
  assert.equal(result.qualityEvaluated, false);
});
test('actual startup fallback preserves the first failed paid reservation before a second connection', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-fallback-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runOfflineQuality(path.join(directory, 'run'), { providerOptions: { failFirstAsr: true } });
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.actualStubRequests.filter(row => row.kind === 'asr').length, 3);
  assert.equal(result.budget.after.attempts.length, 5);
  const trial = JSON.parse(await readFile(path.join(directory, 'run', result.trials[0].path))), attempts = trial.provider.filter(row => row.attemptId);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(row => row.status), ['failed','succeeded']); assert.equal(attempts[0].audioBytes, 0);
  assert.equal(attempts[0].config.parameters.semantic_punctuation_enabled, false); assert.equal(attempts[1].config.parameters.semantic_punctuation_enabled, undefined);
  assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false);
});
