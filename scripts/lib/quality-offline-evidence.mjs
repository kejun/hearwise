// Infrastructure evidence only. This validator cannot grant a real-quality pass.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises'; import path from 'node:path';
import { contractDigest, hashBytes, qualityProperties } from './quality-contract.mjs';
const same = (a,b) => assert.equal(contractDigest(a), contractDigest(b));
export async function inspectOfflineQualityEvidence(directory, targetSource, { release = false } = {}) {
  const properties = Object.values(qualityProperties).map(propertyId => ({ propertyId, status: 'not_run', complete: false, reason: 'Offline stubs have no ASR/MT quality score.' }));
  const base = { schemaVersion: 1, kind: 'offline-quality-contract', method: 'loopback-public-http-ws-sqlite',
    qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, liveCalls: 0, properties };
  try {
    const collectionBytes = await readFile(path.join(directory, 'collection', 'collection.json')), collection = JSON.parse(collectionBytes);
    const ledgerBytes = await readFile(path.join(directory, 'provider-ledger.json')), ledger = JSON.parse(ledgerBytes);
    assert.equal(collection.mode, 'offline'); assert.equal(collection.evidenceKind, 'offline-provider-stub'); assert.equal(collection.role, 'candidate');
    assert.equal(collection.complete, true); assert.equal(collection.cleanup, true); assert.equal(collection.interrupted, false);
    assert.equal(collection.qualityStatus, 'not_run'); assert.equal(collection.qualityEvaluated, false);
    same(collection.sourceStart, collection.sourceEnd); same(collection.sourceStart, targetSource);
    if (release) assert.equal(targetSource.dirty, false);
    assert.equal(collection.trials.length, 4); assert.equal(collection.expectedTrials, 4);
    assert.equal(ledger.length, 6); assert.equal(ledger.filter(row => row.kind === 'asr').length, 2); assert.equal(ledger.filter(row => row.kind === 'mt').length, 2);
    assert.equal(ledger.filter(row => row.kind === 'audio').length, 2); assert.equal(ledger.filter(row => row.kind === 'audio').reduce((n,row) => n + row.bytes, 0), 1280);
    assert.equal(collection.budget.before.attempts.length, 0); assert.equal(collection.budget.after.attempts.length, 4);
    const artifacts = [{ path: 'collection/collection.json', sha256: hashBytes(collectionBytes) }, { path: 'provider-ledger.json', sha256: hashBytes(ledgerBytes) }];
    for (const [index, artifact] of collection.trials.entries()) {
      assert.equal(artifact.path, `trial-${index}/trial.json`); const filename = `collection/${artifact.path}`;
      const bytes = await readFile(path.join(directory, filename)); assert.equal(hashBytes(bytes), artifact.sha256); const trial = JSON.parse(bytes);
      assert.equal(trial.schemaVersion, 1); assert.equal(trial.mode, 'offline'); assert.equal(trial.evidenceKind, 'offline-provider-stub');
      assert.equal(trial.complete, true); assert.equal(trial.cleanup, true); assert.equal(trial.logTruncated, false);
      assert.equal(trial.kind, index < 2 ? 'asr' : 'mt'); assert.equal(trial.repetition, index % 2); assert.equal(trial.outputSha256, hashBytes(trial.result.output));
      assert.equal(trial.provider.filter(row => row.attemptId).length, 1);
      const upstream = trial.provider.find(row => row.attemptId); assert.equal(upstream.mode, 'offline'); assert.equal(upstream.status, 'succeeded');
      assert.ok(['127.0.0.1','[::1]'].includes(new URL(upstream.endpoint).hostname));
      const reservation = collection.budget.after.attempts.find(row => String(row.id) === upstream.attemptId); assert.ok(reservation); assert.equal(reservation.trial_id, trial.trialId);
      assert.equal(trial.artifacts.length, 1); assert.equal(trial.artifacts[0].path, 'application.log');
      const logPath = `collection/trial-${index}/application.log`, log = await readFile(path.join(directory, logPath)); assert.equal(hashBytes(log), trial.artifacts[0].sha256);
      assert.equal(trial.traceBuilds.length, 1); assert.equal(trial.traceBuilds[0].git_sha, targetSource.sha); assert.equal(trial.traceBuilds[0].build_dirty, targetSource.dirty);
      if (trial.kind === 'asr') { assert.equal(trial.result.output, 'Do not pay 15.'); assert.equal(trial.result.segments.length, 1); assert.equal(trial.result.audioBytes, 640); }
      else { assert.equal(trial.result.output, '不要支付15。'); assert.equal(trial.result.input, 'Do not pay 15.'); }
      artifacts.push({ path: filename, sha256: hashBytes(bytes) }, { path: logPath, sha256: hashBytes(log) });
    }
    return { ...base, complete: true, infrastructurePassed: true, source: collection.sourceStart, startedAt: collection.startedAt, finishedAt: collection.finishedAt,
      actualLoopbackCalls: 4, asrTrials: 2, mtTrials: 2, artifacts };
  } catch { return { ...base, complete: false, infrastructurePassed: false, reasons: ['MISSING_CHANGED_OR_INVALID_OFFLINE_EVIDENCE'] }; }
}
