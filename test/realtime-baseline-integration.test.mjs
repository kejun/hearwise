import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditRawRun, readbackBaseline } from '../scripts/lib/realtime-readback.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { profileEvidenceDirectory } from '../test-support/profile-test-evidence.mjs';

test('bounded real HTTP/WS/SQLite baseline measures all phases and catches retained ASR transport', { timeout: 65000 }, async () => {
  const deadline = Date.now() + 60000;
  for (const negative of [false, true]) {
    const root = await profileEvidenceDirectory(negative ? 'realtime-negative' : 'realtime');
    const execution = await runProcess(process.execPath, ['scripts/verify-realtime-baseline.mjs', '--profile=smoke', ...(negative ? ['--negative=retain-asr-socket'] : [])],
      { env: { ...process.env, REALTIME_EVIDENCE_DIR: root }, timeoutMs: Math.min(50000, Math.max(1, deadline - Date.now() - 5000)), logFile: path.join(root, 'profile.log') });
    assert.equal(execution.timedOut, false); assert.equal(execution.signal, null); assert.equal(execution.code, negative ? 1 : 0, execution.tail);
    const directory = (await readdir(root)).find(name => name.startsWith('smoke-'));
    const report = JSON.parse(await readFile(path.join(root, directory, 'report.json'), 'utf8'));
    assert.equal(report.complete, true); assert.equal(report.ok, !negative); assert.equal(report.negativeDetected, negative);
    assert.equal(report.readback?.ok, true, JSON.stringify(report.readback));
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
      const folder = path.join(root, directory, 'repeat-1');
      const lines = async name => (await readFile(path.join(folder, name), 'utf8')).trim().split('\n').map(JSON.parse);
      const events = await lines('events.jsonl'), resources = await lines('resources.jsonl');
      const repeated = run.runs.filter(row => row.phase === 'stop-start').at(-1);
      const stopAt = events.findIndex(row => row.type === 'consumer-stopped' && row.runId === repeated.runId);
      const drainAt = events.findIndex((row, index) => index > stopAt && row.type === 'drained');
      const staleProcessing = events.filter((row, index) => !(index > stopAt && index < drainAt && row.type === 'processing'));
      assert.throws(() => auditRawRun(run, staleProcessing, resources, report.plan.profiles.smoke), 'a later stop cannot reuse an earlier idle processing snapshot');
      const idleSwitch = structuredClone(events);
      for (const row of idleSwitch.filter(row => row.type === 'switch-pending')) {
        row.processing.pendingTranslations = 0;
        for (const key of ['pendingJobs', 'runningJobs', 'bufferedSegments']) row.processing.knowledge[key] = 0;
      }
      assert.throws(() => auditRawRun(run, idleSwitch, resources, report.plan.profiles.smoke), 'switching must observe actual pending work for each run');
      const switched = new Set(run.runs.filter(row => row.phase === 'switching').map(row => row.listeningId));
      assert.equal(events.filter(row => row.type === 'switch-overlap').length, report.plan.profiles.smoke.switchCycles - 1);
      for (const listeningId of switched) {
        assert.ok(run.quiescent.some(row => row.phase === 'switching' && row.listeningId === listeningId));
        const missing = row => row.phase === 'switching' && row.listeningId === listeningId;
        const changed = structuredClone(run); changed.quiescent = changed.quiescent.filter(row => !missing(row));
        assert.throws(() => auditRawRun(changed, events.filter(row => row.type !== 'quiescent' || !missing(row.checkpoint)), resources, report.plan.profiles.smoke), 'each switched listening needs its own post-drain checkpoint');
      }
      for (const type of ['switch-pending', 'switch-overlap']) {
        const index = events.findIndex(row => row.type === type);
        assert.throws(() => auditRawRun(run, events.filter((_, i) => i !== index), resources, report.plan.profiles.smoke), 'no switching witness may be omitted');
        const foreign = structuredClone(events); foreign[index].runId = 'foreign-run';
        assert.throws(() => auditRawRun(run, foreign, resources, report.plan.profiles.smoke), 'pending work belongs to the actual switching run');
      }
      const idleOverlap = structuredClone(events);
      for (const row of idleOverlap.filter(row => row.type === 'switch-overlap')) {
        row.processing.pendingTranslations = 0;
        for (const key of ['pendingJobs', 'runningJobs', 'bufferedSegments']) row.processing.knowledge[key] = 0;
      }
      assert.throws(() => auditRawRun(run, idleOverlap, resources, report.plan.profiles.smoke), 'old work must remain pending after the new record opens');
      for (const mutate of [
        row => { row.samples[0].audioToCaptionMs = -100; },
        row => { row.samples = row.samples.slice(0, 1); },
        row => { row.phases[0].inputs = 999; },
        row => { row.cleanup.socketsClosed = false; row.cleanup.serverSignal = null; },
        row => { row.resourceSamples = 99999; },
        row => { row.resourceSummary.rssBytes.max = -1; },
        row => { row.latencies.audioToCaptionMs.p95 = -1; },
        row => { row.samples[0].runId = 'foreign-run'; },
        row => { row.startedAt = '2027-10-14T00:00:00.000Z'; row.finishedAt = '2027-10-13T00:00:00.000Z'; },
        row => { row.durable = {}; },
        row => { row.quiescent[0].providerAsrConnections = 100; }
      ]) {
        const changed = structuredClone(run); mutate(changed);
        assert.throws(() => auditRawRun(changed, events, resources, report.plan.profiles.smoke), 'derived evidence tamper must fail raw readback');
      }
      const injected = structuredClone(events), first = run.samples[0];
      Object.assign(injected.find(row => row.type === 'input' && row.id === first.id), first);
      assert.throws(() => auditRawRun(run, injected.filter(row => !(row.type === 'asr-event' && row.event.type === 'segment-final' && row.event.segment.asr_sentence_id === first.id)), resources, report.plan.profiles.smoke), 'input cannot smuggle derived timing without a real final event');
      const fakeRun = structuredClone(events);
      Object.assign(fakeRun.find(row => row.type === 'run-open').run, run.runs[0]);
      assert.throws(() => auditRawRun(run, fakeRun, resources, report.plan.profiles.smoke), 'run-open cannot prefill first-frame measurements');
      const emptyResource = structuredClone(resources); emptyResource[0].memory = {};
      assert.throws(() => auditRawRun(run, events, emptyResource, report.plan.profiles.smoke), 'missing raw resource fields fail closed');
      for (const mutate of [
        (r, e, s) => { for (const row of e.filter(row => row.type === 'quiescent')) row.checkpoint.resource = structuredClone(s[0]); r.quiescent = e.filter(row => row.type === 'quiescent').map(row => row.checkpoint); },
        (r, e, s) => { s.at(-1).cpuMicroseconds = { user: 1e30, system: 1e30 }; r.resourceSummary.cpuMicroseconds = s.at(-1).cpuMicroseconds; },
        (r, e) => { const i = e.findIndex(row => row.type === 'phase-end'); e.splice(i, 0, structuredClone(e[i])); },
        (r, e) => { r.durable.knowledge_items = -1; e.find(row => row.type === 'durable').counts.knowledge_items = -1; },
        (r, e) => { r.cleanup.serverExitCode = -9; r.cleanup.serverSignal = 'FAKE'; e.find(row => row.type === 'cleanup').cleanup = structuredClone(r.cleanup); }
      ]) {
        const changed = structuredClone(run), raw = structuredClone(events), sampled = structuredClone(resources); mutate(changed, raw, sampled);
        assert.throws(() => auditRawRun(changed, raw, sampled, report.plan.profiles.smoke), 'coordinated raw/summary corruption fails semantic readback');
      }
      for (const mutate of [
        r => { r.runs[0].execution.durationMs = 1e9; },
        r => { r.runs[0].execution.ok = false; },
        r => { r.runs[0].execution.error = 'FAILED'; },
        r => { r.ok = false; },
        r => { r.negative = 'OTHER'; },
        r => { r.tools.node = 'v0.0.0'; r.tools.sqlite = 'FAKE'; },
        r => { r.environment.platform = 'FAKE'; r.environment.arch = 'FAKE'; }
      ]) {
        const copy = await mkdtemp(path.join(root, 'corrupt-'));
        try {
          await cp(path.join(root, directory), copy, { recursive: true });
          const changed = structuredClone(report); mutate(changed); await writeFile(path.join(copy, 'report.json'), JSON.stringify(changed));
          await assert.rejects(readbackBaseline(copy), 'invalid execution header fails the complete file reader');
        } finally { await rm(copy, { recursive: true, force: true }); }
      }
    }
  }
});
