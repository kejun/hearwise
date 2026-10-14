import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { profileEvidenceDirectory } from '../test-support/profile-test-evidence.mjs';

test('bounded real HTTP/WS/SQLite baseline measures all phases and catches retained ASR transport', { timeout: 65000 }, async () => {
  for (const negative of [false, true]) {
    const root = await profileEvidenceDirectory(negative ? 'realtime-negative' : 'realtime');
    const execution = await runProcess(process.execPath, ['scripts/verify-realtime-baseline.mjs', '--profile=smoke', ...(negative ? ['--negative=retain-asr-socket'] : [])],
      { env: { ...process.env, REALTIME_EVIDENCE_DIR: root }, timeoutMs: 50000, logFile: path.join(root, 'profile.log') });
    assert.equal(execution.timedOut, false); assert.equal(execution.signal, null); assert.equal(execution.code, negative ? 1 : 0, execution.tail);
    const directory = (await readdir(root)).find(name => name.startsWith('smoke-'));
    const report = JSON.parse(await readFile(path.join(root, directory, 'report.json'), 'utf8'));
    assert.equal(report.complete, true); assert.equal(report.ok, !negative); assert.equal(report.negativeDetected, negative);
    assert.equal(report.acceptanceStatus, 'not_run'); assert.equal(report.fullProjectAcceptance, false);
    const run = report.runs[0].result;
    assert.equal(run.cleanup.confirmed, true); assert.equal(run.cleanup.temporaryDatabaseRemoved, true); assert.equal(run.cleanup.socketsClosed, true);
    assert.ok(run.resourceSamples > 2);
    if (negative) { assert.match(run.error, /ASR upstream retained after stop/); assert.ok(run.retainedCloseCalls > 0); assert.equal(run.failure.providerAsrConnections, 1); }
    else {
      assert.equal(run.phases.length, 6); assert.equal(run.durable.segments, run.samples.length);
      assert.ok(run.latencies.audioToCaptionMs.count > 0); assert.ok(run.latencies.finalToTranslationMs.count > 0); assert.ok(run.latencies.finalToKnowledgeMs.count > 0);
      assert.ok(run.samples.some(row => Number.isFinite(row.finalToTranslationHttpObservedMs)), 'post-stop HTTP observation remains separately labelled');
      assert.ok(run.quiescent.every(row => row.providerAsrConnections === 0));
    }
  }
});
