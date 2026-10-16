import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, sourceVersion, metadata } from './verification-evidence.mjs';
import { baselinePhases, summarizeLatencies, validateBaselineRun } from './realtime-baseline.mjs';
const finite = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'raw observation fields');
const jsonl = text => text.trim().split('\n').filter(Boolean).map(JSON.parse);
export function resourceSummary(resources) {
  return resources.length ? {
    rssBytes: { first: resources[0].memory.rss, last: resources.at(-1).memory.rss, max: Math.max(...resources.map(row => row.memory.rss)) },
    cpuMicroseconds: resources.at(-1).cpuMicroseconds,
    descriptors: { first: resources[0].descriptors, last: resources.at(-1).descriptors },
    interpretation: 'Descriptive only. SQLite contents, caches and fixture records grow; no stability acceptance budget is approved.'
  } : null;
}

// Independently replay observations, not derived latency or resource summaries.
export function auditRawRun(result, events, resources, config, { negative = false } = {}) {
  const samples = [], records = new Map(), runs = [], byRun = new Map(), phases = [], quiescent = [], stopped = new Map(), checkpointed = new Set(), switchPending = new Set(), switchOverlap = new Set();
  let last = -1, cleanup, durable, active; const readyRuns = new Map(), drains = new Map(), stimuli = new Map(), processing = new Map(), holds = new Map();
  function hasPendingWork(value) {
    const k = value?.knowledge;
    assert.ok(value && k && [value.pendingTranslations, value.failedTranslations, k.pendingJobs, k.runningJobs, k.bufferedSegments, k.failedJobs].every(count), 'complete processing counters');
    assert.equal(value.failedTranslations, 0); assert.equal(k.failedJobs, 0);
    return Boolean(value.pendingTranslations || k.pendingJobs || k.runningJobs || k.bufferedSegments);
  }
  const begun = Date.parse(result.startedAt), finished = Date.parse(result.finishedAt);
  assert.ok(Number.isFinite(begun) && Number.isFinite(finished) && finished >= begun);
  for (const row of events) {
    assert.ok(Date.parse(row.at) >= begun && Date.parse(row.at) <= finished, 'observation belongs to execution interval');
    assert.ok(finite(row.monoMs) && row.monoMs >= last, 'ordered monotonic observation time'); last = row.monoMs;
    if (row.type === 'input') {
      const { type, monoMs, at, ...sample } = row;
      exactKeys(sample, ['id', 'phase', 'listeningId', 'runId', 'audioSentMs', 'providerFrameMs', 'scheduledMs']);
      assert.ok(active && !active.complete && sample.phase === active.name && sample.audioSentMs >= active.startedMs);
      const stimulus = stimuli.get(sample.phase);
      assert.equal(sample.scheduledMs, stimulus ? stimulus.startedMs + stimulus.inputs++ * config.intervalMs : sample.audioSentMs); assert.ok(sample.audioSentMs >= sample.scheduledMs);
      assert.ok(!records.has(sample.id), 'unique input'); assert.ok(byRun.has(sample.runId), 'input belongs to open run');
      assert.equal(sample.listeningId, byRun.get(sample.runId).listeningId); assert.equal(sample.phase, byRun.get(sample.runId).phase); assert.ok(sample.audioSentMs >= byRun.get(sample.runId).startMs);
      assert.ok(finite(sample.audioSentMs) && sample.providerFrameMs >= sample.audioSentMs && monoMs >= sample.providerFrameMs);
      samples.push(sample); records.set(sample.id, sample); byRun.get(sample.runId).firstAudioMs ??= sample.audioSentMs;
    }
    if (row.type === 'stimulus-start') {
      assert.ok(active && !active.complete && row.phase === active.name && !stimuli.has(row.phase));
      assert.ok(['warmup', 'continuous'].includes(row.phase)); assert.equal(row.durationMs, row.phase === 'warmup' ? config.warmupMs : config.continuousMs); assert.equal(row.intervalMs, config.intervalMs);
      assert.ok(row.startedMs >= active.startedMs && row.startedMs <= row.monoMs); stimuli.set(row.phase, { startedMs: row.startedMs, inputs: 0 });
    }
    if (row.type === 'run-open') {
      exactKeys(row.run, ['phase', 'startMs', 'listeningId', 'epoch', 'runId', 'runNo', 'captionMode']);
      assert.ok(active && !active.complete && row.run.phase === active.name && row.run.startMs >= active.startedMs && row.run.startMs <= row.monoMs);
      assert.ok(!byRun.has(row.run.runId), 'unique run'); const run = { ...row.run }, ready = readyRuns.get(run.runId);
      assert.ok(ready); for (const key of ['runId', 'listeningId', 'runNo', 'captionMode']) assert.equal(run[key], ready[key]);
      runs.push(run); byRun.set(run.runId, run);
    }
    if (row.type === 'speech-start') { const run = byRun.get(row.runId); assert.ok(run && run.speechStartMs == null && row.speechStartMs >= run.startMs && row.speechStartMs <= row.monoMs); run.speechStartMs = row.speechStartMs; }
    if (row.type === 'pcm') {
      const run = byRun.get(row.runId); assert.ok(run && finite(run.firstAudioMs) && finite(run.speechStartMs)); assert.equal(row.phase, run.phase); assert.equal(row.epoch, run.epoch); assert.ok(row.bytes > 16);
      run.startToFirstPcmMs ??= row.monoMs - run.speechStartMs; run.audioToFirstPcmMs ??= row.monoMs - run.firstAudioMs;
    }
    if (row.type === 'asr-event') {
      const event = row.event; if (event.type === 'listening-ready') readyRuns.set(event.runId, event);
      const sample = records.get(event.segment?.asr_sentence_id ?? event.item?.canonical_name);
      if (sample && event.type === 'segment-final') {
        assert.equal(event.runId, sample.runId); sample.finalMs = row.monoMs;
        sample.audioToCaptionMs = row.monoMs - sample.audioSentMs; sample.segmentId = event.segment.id;
      }
      if (sample && event.type === 'translation-updated' && event.segment.translation_state === 'complete') {
        assert.equal(event.segment.id, sample.segmentId); assert.equal(event.segment.run_id, sample.runId); assert.equal(event.segment.listening_id, sample.listeningId); sample.translationMs = row.monoMs;
        sample.finalToTranslationMs = row.monoMs - sample.finalMs; sample.audioToTranslationMs = row.monoMs - sample.audioSentMs;
      }
      if (sample && event.type === 'knowledge-upserted') {
        assert.equal(event.listeningId, sample.listeningId); sample.knowledgeMs = row.monoMs;
        sample.finalToKnowledgeMs = row.monoMs - sample.finalMs; sample.audioToKnowledgeMs = row.monoMs - sample.audioSentMs;
      }
    }
    if (row.type === 'http-observation') {
      for (const segment of row.segments) {
        const sample = records.get(segment.asr_sentence_id); if (!sample) continue;
        assert.equal(segment.id, sample.segmentId); assert.equal(segment.run_id, sample.runId); assert.equal(row.listeningId, sample.listeningId);
        if (!Number.isFinite(sample.finalToTranslationMs) && !Number.isFinite(sample.finalToTranslationHttpObservedMs) && segment.translation_state === 'complete') sample.finalToTranslationHttpObservedMs = row.monoMs - sample.finalMs;
      }
      for (const item of row.knowledge) {
        const sample = records.get(item.canonical_name); if (!sample) continue;
        assert.equal(row.listeningId, sample.listeningId);
        if (!Number.isFinite(sample.finalToKnowledgeMs) && !Number.isFinite(sample.finalToKnowledgeHttpObservedMs)) sample.finalToKnowledgeHttpObservedMs = row.monoMs - sample.finalMs;
      }
    }
    if (row.type === 'phase-start') { assert.ok(!active || active.complete); assert.equal(row.name, baselinePhases[phases.length]); assert.equal(row.startedMs, row.monoMs); active = { name: row.name, startedMs: row.startedMs, complete: false }; phases.push(active); }
    if (row.type === 'phase-end') {
      const phase = phases.at(-1); assert.equal(phase.complete, false); assert.equal(phase.name, row.name); assert.equal(phase.startedMs, row.startedMs);
      assert.ok(row.finishedMs >= phase.startedMs && row.finishedMs <= row.monoMs); Object.assign(phase, { finishedMs: row.finishedMs, complete: true });
    }
    if (row.type === 'consumer-stopped') {
      const run = byRun.get(row.runId); assert.ok(run && active && !active.complete && run.phase === active.name && !stopped.has(row.runId));
      assert.ok(row.consumerClosed && row.providerAsrConnections === 0); stopped.set(row.runId, row.monoMs);
    }
    if (row.type === 'switch-hold') {
      const run = byRun.get(row.runId); assert.ok(active?.name === 'switching' && !active.complete && run?.phase === 'switching');
      if (row.action === 'create') {
        assert.ok(!holds.has(row.runId)); assert.equal(samples.filter(sample => sample.runId === row.runId).length, 0);
        holds.set(row.runId, { created: row.monoMs, waited: false, released: false });
      } else {
        const hold = holds.get(row.runId); assert.ok(hold && !hold.released);
        if (row.action === 'await') hold.waited = true;
        else {
          assert.equal(row.action, 'release'); assert.ok(hold.waited && row.monoMs - hold.created <= config.phaseTimeoutMs);
          const switching = runs.filter(run => run.phase === 'switching');
          if (row.reason === 'overlap-observed') assert.ok(switchOverlap.has(switching.at(-1).runId) && switching.at(-2).runId === row.runId);
          else { assert.equal(row.reason, 'final-drain'); assert.equal(switching.length, config.switchCycles); assert.equal(switching.at(-1).runId, row.runId); }
          hold.released = true;
        }
      }
    }
    if (row.type === 'switch-pending' || row.type === 'switch-overlap') {
      assert.ok(active?.name === 'switching' && !active.complete);
      const run = byRun.get(row.runId), switching = runs.filter(run => run.phase === 'switching');
      assert.ok(run?.phase === 'switching'); assert.equal(row.listeningId, run.listeningId);
      assert.ok(hasPendingWork(row.processing), 'switch must observe actual pending work');
      if (row.type === 'switch-pending') {
        assert.equal(switching.at(-1).runId, run.runId); assert.ok(!stopped.has(run.runId) && !switchPending.has(run.runId));
        assert.equal(samples.filter(sample => sample.runId === run.runId).length, 2); switchPending.add(run.runId);
      } else {
        const next = byRun.get(row.nextRunId);
        assert.equal(switching.at(-2)?.runId, run.runId); assert.equal(switching.at(-1)?.runId, next?.runId);
        assert.equal(row.nextListeningId, next.listeningId); assert.notEqual(run.listeningId, next.listeningId);
        assert.ok(stopped.has(run.runId) && !stopped.has(next.runId) && !switchOverlap.has(next.runId));
        assert.ok(holds.get(run.runId)?.waited && !holds.get(run.runId).released, 'real old knowledge response remains held during overlap');
        assert.equal(samples.filter(sample => sample.runId === next.runId).length, 0); switchOverlap.add(next.runId);
      }
    }
    if (row.type === 'processing') { hasPendingWork(row.processing); processing.set(row.listeningId, { value: row.processing, phase: active?.name, monoMs: row.monoMs }); }
    if (row.type === 'durable') { assert.equal(durable, undefined); durable = row.counts; }
    if (row.type === 'drained') {
      assert.ok(active && !active.complete && row.phase === active.name);
      const matching = runs.filter(run => run.phase === row.phase && run.listeningId === row.listeningId);
      assert.ok(matching.length && matching.every(run => stopped.has(run.runId)));
      const observed = processing.get(row.listeningId); assert.equal(observed?.phase, row.phase); assert.equal(hasPendingWork(observed.value), false, 'drain has an actual idle processing observation');
      assert.ok(observed.monoMs >= Math.max(...matching.map(run => stopped.get(run.runId))), 'idle processing is observed after the latest stop, not reused from an earlier cycle');
      drains.set(row.listeningId, { at: Date.parse(row.at), phase: row.phase });
    }
    if (row.type === 'quiescent') {
      const checkpoint = row.checkpoint, observed = Date.parse(checkpoint.resource.at), begin = Date.parse(checkpoint.readStartedAt), end = Date.parse(checkpoint.readFinishedAt);
      assert.ok(active && !active.complete && checkpoint.phase === active.name);
      assert.equal(checkpoint.providerAsrConnections, 0); assert.equal(drains.get(checkpoint.listeningId)?.phase, checkpoint.phase);
      const matching = runs.filter(run => run.phase === checkpoint.phase && run.listeningId === checkpoint.listeningId);
      assert.ok(matching.length && matching.every(run => stopped.has(run.runId))); matching.forEach(run => checkpointed.add(run.runId));
      assert.ok(observed >= drains.get(checkpoint.listeningId).at && observed <= end && begin <= end && end <= Date.parse(row.at));
      const index = resources.findIndex(resource => JSON.stringify(resource) === JSON.stringify(checkpoint.resource)); assert.ok(index >= 0);
      assert.ok(resources.slice(index + 1).every(resource => Date.parse(resource.at) >= begin), 'checkpoint uses latest sample available at snapshot start');
      quiescent.push(checkpoint);
    }
    if (row.type === 'cleanup') cleanup = row.cleanup;
  }
  for (const phase of phases) {
    const rows = samples.filter(row => row.phase === phase.name);
    phase.inputs = rows.length; phase.captionDeliveries = rows.filter(row => Number.isFinite(row.audioToCaptionMs)).length;
    phase.elapsedMs = phase.finishedMs == null ? null : phase.finishedMs - phase.startedMs;
    phase.captionDeliveriesPerSecond = phase.elapsedMs ? phase.captionDeliveries / (phase.elapsedMs / 1000) : null;
  }
  assert.deepEqual(result.samples, samples, 'samples derive from timestamped observations');
  assert.deepEqual(result.runs, runs, 'first PCM timing derives from actual frame observations');
  assert.deepEqual(result.phases, phases, 'phase durations/throughput derive from raw sequence');
  assert.deepEqual(result.durable, durable);
  assert.deepEqual(result.quiescent, quiescent); assert.deepEqual(result.cleanup, cleanup);
  assert.equal(cleanup?.confirmed, true); assert.equal(cleanup.socketsClosed, true); assert.equal(cleanup.temporaryDatabaseRemoved, true);
  assert.ok(cleanup.serverExitCode === 0 && cleanup.serverSignal === null || cleanup.serverExitCode === null && cleanup.serverSignal === 'SIGTERM', 'expected bounded fixture exit');
  for (const sample of samples) for (const [key, value] of Object.entries(sample)) if (key.endsWith('Ms')) assert.ok(finite(value), `${key} is nonnegative`);
  for (const run of runs) for (const [key, value] of Object.entries(run)) if (key.endsWith('Ms')) assert.ok(finite(value), `${key} is nonnegative`);
  assert.deepEqual(result.latencies, summarizeLatencies(samples), 'quantiles derive from raw samples');
  assert.ok(resources.length > 2); last = -1; let cpu = { user: 0, system: 0 };
  for (const resource of resources) {
    assert.ok(count(resource.pid) && resource.pid > 0 && count(resource.retainedCloseCalls)); assert.equal(resource.pid, result.pid); assert.ok(finite(resource.elapsedMs) && resource.elapsedMs >= last); last = resource.elapsedMs;
    assert.ok(Date.parse(resource.at) >= begun && Date.parse(resource.at) <= finished);
    exactKeys(resource.memory, ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']); assert.ok(Object.values(resource.memory).every(count));
    exactKeys(resource.cpuMicroseconds, ['user', 'system']); assert.ok(Object.values(resource.cpuMicroseconds).every(count));
    exactKeys(resource.descriptors, ['total', 'socket', 'file', 'pipe', 'other']); assert.ok(Object.values(resource.descriptors).every(value => value === null || Number.isSafeInteger(value) && value >= 0)); assert.ok(Object.values(resource.activeResources).every(value => Number.isSafeInteger(value) && value >= 0));
    assert.ok(resource.cpuMicroseconds.user >= cpu.user && resource.cpuMicroseconds.system >= cpu.system); cpu = resource.cpuMicroseconds;
    if (resource.descriptors.total === null) assert.ok(Object.values(resource.descriptors).every(value => value === null));
    else assert.equal(resource.descriptors.total, ['socket', 'file', 'pipe', 'other'].reduce((sum, key) => sum + resource.descriptors[key], 0));
  }
  assert.equal(result.resourceSamples, resources.length); assert.deepEqual(result.resourceSummary, resourceSummary(resources));
  assert.equal(result.retainedCloseCalls, Math.max(0, ...resources.map(row => row.retainedCloseCalls)));
  if (!negative) {
    assert.equal(validateBaselineRun(result).ok, true); assert.deepEqual(phases.map(row => row.name), baselinePhases);
    const counts = [Math.ceil(config.warmupMs / config.intervalMs), Math.ceil(config.continuousMs / config.intervalMs), config.restartCycles, config.switchCycles * 2, config.backgroundSentences, 1];
    assert.deepEqual(phases.map(row => row.inputs), counts, 'exact versioned load counts');
    exactKeys(durable, ['listenings', 'listening_runs', 'segments', 'extraction_jobs', 'knowledge_items']); assert.ok(Object.values(durable).every(value => Number.isSafeInteger(value) && value > 0));
    assert.equal(durable.knowledge_items, samples.length); assert.ok(durable.extraction_jobs <= samples.length && durable.listenings <= runs.length);
    assert.equal(durable.segments, samples.length); assert.equal(durable.listening_runs, runs.length);
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]; assert.ok(phase.complete && (i === 0 || phase.startedMs >= phases[i - 1].finishedMs));
      assert.ok(samples.filter(row => row.phase === phase.name).every(row => row.audioSentMs >= phase.startedMs && row.audioSentMs <= phase.finishedMs));
    }
    assert.equal(stimuli.size, 2); assert.ok(phases[0].elapsedMs >= config.warmupMs && phases[1].elapsedMs >= config.continuousMs);
    assert.ok(runs.every(run => stopped.has(run.runId)), 'each run really stopped');
    assert.ok(runs.every(run => checkpointed.has(run.runId)), 'every stopped run has a phase-bound post-drain resource checkpoint');
    const switching = runs.filter(run => run.phase === 'switching');
    assert.equal(switching.length, config.switchCycles);
    assert.equal(holds.size, config.switchCycles); assert.ok([...holds.values()].every(hold => hold.waited && hold.released), 'all switching response holds release before drain/cleanup');
    assert.deepEqual([...switchPending], switching.map(run => run.runId), 'every switching run observes pending work');
    assert.deepEqual([...switchOverlap], switching.slice(1).map(run => run.runId), 'old work overlaps each newly opened record');
  } else {
    const failure = events.find(row => row.type === 'failure');
    assert.ok(failure?.error.startsWith('ASR upstream retained after stop exceeded') && failure.providerAsrConnections > 0 && result.retainedCloseCalls > 0);
  }
  return { ok: true, events: events.length, resources: resources.length, acceptanceStatus: 'not_run' };
}

export async function readbackBaseline(directory, { frozenIdentity = null } = {}) {
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const current = await metadata();
  assert.equal(report.schemaVersion, current.schemaVersion); assert.equal(report.mode, current.mode); assert.deepEqual(report.specification, current.specification);
  assert.ok(['none', 'retain-asr-socket'].includes(report.negative) && ['smoke', 'baseline'].includes(report.profile));
  const source = frozenIdentity?.source ?? sourceVersion(), planBytes = await readFile('verification/realtime-baseline.json'), plan = JSON.parse(planBytes);
  assert.deepEqual(report.source, source, 'evidence source must match current checkout');
  assert.deepEqual(report.target, source); assert.deepEqual(report.plan, plan); assert.equal(report.planDigest, digest(planBytes));
  assert.equal(report.tools.node, process.version); assert.equal(report.tools.sqlite, process.versions.sqlite);
  assert.ok(Array.isArray(report.environment.loadAtStart) && report.environment.loadAtStart.length === 3 && report.environment.loadAtStart.every(finite));
  assert.equal(report.tools.lockDigest, digest(await readFile('package-lock.json')));
  assert.equal(report.buildDigest, frozenIdentity?.buildDigest ?? digest(await readFile('dist/server/index.js')), 'actual built runtime identity');
  assert.equal(report.acceptanceStatus, 'not_run'); assert.equal(report.fullProjectAcceptance, false);
  assert.equal(report.complete, true);
  const negative = report.negative === 'retain-asr-socket', expected = negative ? 1 : plan.profiles[report.profile].repeats;
  assert.equal(report.runs.length, expected); assert.deepEqual(report.runs.map(row => row.repeat), Array.from({ length: expected }, (_, index) => index + 1));
  assert.equal(report.ok, !negative); assert.equal(report.negativeDetected, negative);
  let previousFinish = Date.parse(report.startedAt);
  for (const row of report.runs) {
    assert.equal(row.execution.ok, !negative); assert.equal(row.execution.error ?? null, null);
    assert.ok(finite(row.execution.durationMs) && row.execution.durationMs <= plan.profiles[report.profile].workerTimeoutMs + 1500);
    assert.equal(row.execution.code, negative ? 1 : 0); assert.equal(row.execution.signal, null); assert.equal(row.execution.timedOut, false); assert.equal(row.execution.interrupted, false);
    assert.equal(row.parentCleanup?.processGone, true); assert.equal(row.parentCleanup?.databaseRootRemoved, true);
    const base = `repeat-${row.repeat}`;
    assert.deepEqual(row.artifacts.map(item => item.path).sort(), ['events.jsonl', 'resources.jsonl', 'result.json', 'server.log', 'worker.log'].map(name => `${base}/${name}`).sort());
    for (const artifact of row.artifacts) assert.equal(digest(await readFile(path.join(directory, artifact.path))), artifact.sha256, `artifact digest: ${artifact.path}`);
    const result = JSON.parse(await readFile(path.join(directory, base, 'result.json'), 'utf8')); assert.deepEqual(result, row.result); assert.deepEqual(row.validation, validateBaselineRun(result)); assert.deepEqual(result.validation, validateBaselineRun(result));
    assert.ok(Date.parse(result.startedAt) >= previousFinish && Date.parse(result.finishedAt) <= Date.parse(report.finishedAt), 'independent repeats are ordered and inside report window');
    assert.ok(row.execution.durationMs >= Date.parse(result.finishedAt) - Date.parse(result.startedAt)); previousFinish = Date.parse(result.finishedAt);
    const log = await readFile(path.join(directory, base, 'server.log'), 'utf8');
    const traces = log.split('\n').filter(line => line.startsWith('execution_trace ')).map(line => JSON.parse(line.slice(16)));
    assert.ok(traces.length); assert.ok(traces.every(row => row.build.git_sha === source.sha && row.build.build_dirty === source.dirty), 'real runtime trace build matches source');
    const events = jsonl(await readFile(path.join(directory, base, 'events.jsonl'), 'utf8')), runtime = events.filter(event => event.type === 'runtime');
    assert.equal(runtime.length, 1); assert.deepEqual(runtime[0].tools, { node: report.tools.node, sqlite: report.tools.sqlite });
    const { loadAtStart, ...identity } = report.environment; assert.deepEqual(identity, runtime[0].environment);
    assert.equal(row.execution.tail, (await readFile(path.join(directory, base, 'worker.log'), 'utf8')).slice(-12000));
    auditRawRun(result, events, jsonl(await readFile(path.join(directory, base, 'resources.jsonl'), 'utf8')), plan.profiles[report.profile], { negative });
  }
  return { ok: true, acceptanceStatus: 'not_run', fullProjectAcceptance: false };
}
