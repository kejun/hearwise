import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path'; import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createQualityGateway } from './quality-gateway.mjs';
import { openQualityBudget } from './quality-budget.mjs';
import { validateQualityObservations } from './quality-observations.mjs';
import { hashBytes, contractDigest, languageTargets, qualityBudgetConfig, readFrozenQualityPlan } from './quality-contract.mjs';
import { deadline, stopChild } from '../../test-support/lifecycle.mjs';
import { sourceVersion, writeJson } from './verification-evidence.mjs';

export async function qualitySources() {
  const names = [...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean), 'dist/server/index.js'])].sort();
  return { ...sourceVersion(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), files: Object.fromEntries(await Promise.all(names.map(async name => [name, hashBytes(await readFile(name))]))),
    node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, os: os.release() };
}
export function asrParameters(config, source) {
  const base = { format: 'pcm', sample_rate: 16000, heartbeat: true, language_hints: [source] };
  return config.captionMode === 'classic' ? [base] : [{ ...base, semantic_punctuation_enabled: false, max_sentence_silence: config.sentenceSilenceMs, multi_threshold_mode_enabled: true }, base];
}
async function app(gateway, directory, config) {
  const child = spawn(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1',
    LISTENING_DB: path.join(directory, 'app.sqlite'), ASR_ENDPOINT: gateway.asrEndpoint, MT_ENDPOINT: gateway.mtEndpoint,
    // Neither TTS endpoint is exercised; keep any unexpected path loopback-only.
    TTS_ENDPOINT: gateway.asrEndpoint, FISH_TTS_ENDPOINT: gateway.mtEndpoint, ASR_SENTENCE_SILENCE_MS: String(config.sentenceSilenceMs), HEARWISE_TRACE: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', totalBytes = 0, truncated = false;
  const record = bytes => { totalBytes += bytes.length; if (totalBytes > 2 * 1024 * 1024) truncated = true; logs = (logs + bytes).slice(-2 * 1024 * 1024); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  try {
    const base = await deadline(() => new Promise((resolve, reject) => {
      const exit = () => reject(new Error('APPLICATION_EXITED_BEFORE_READY'));
      const data = bytes => { const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { child.stdout.off('data', data); child.off('exit', exit); resolve(match[0]); } };
      child.stdout.on('data', data); child.once('exit', exit); child.once('error', () => reject(new Error('APPLICATION_START_FAILED')));
    }), 10000, 'Quality application startup');
    return { base, child, logs: () => ({ text: logs, truncated }), close: () => stopChild(child) };
  } catch (error) { await stopChild(child); throw error; }
}
async function jsonRequest(url, options, signal) {
  const response = await fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}`);
  return response.json();
}
async function waitFor(check, signal) {
  while (!check()) { signal.throwIfAborted(); await delay(10, undefined, { signal }); }
}
async function captureAsr(application, sample, config, corpusPath, signal) {
  const audio = await readFile(path.resolve(path.dirname(corpusPath), sample.audio.path));
  if (hashBytes(audio) !== sample.audio.sha256 || audio.length !== sample.audio.bytes) throw new Error('AUDIO_CHANGED');
  const socket = new WebSocket(application.base.replace('http', 'ws') + '/ws'), events = [], started = performance.now();
  socket.on('error', () => {});
  socket.on('message', (raw, binary) => { if (!binary) events.push({ atMs: performance.now() - started, event: JSON.parse(raw.toString()) }); });
  const abort = () => socket.terminate(); signal.addEventListener('abort', abort, { once: true });
  try {
    await deadline(() => once(socket, 'open'), 10000, 'Quality ASR public socket');
    socket.send(JSON.stringify({ type: 'start', key: 'quality-local-capability', source: sample.language, targetLang: languageTargets[sample.language], audioSource: 'tab', captionMode: config.captionMode }));
    await waitFor(() => events.some(row => ['listening-ready', 'error'].includes(row.event.type)) || socket.readyState === WebSocket.CLOSED, signal);
    const ready = events.find(row => row.event.type === 'listening-ready')?.event;
    if (!ready) throw new Error('PUBLIC_ASR_NOT_READY');
    const audioStarted = performance.now();
    for (let offset = 0; offset < audio.length; offset += 640) {
      signal.throwIfAborted(); if (socket.readyState !== WebSocket.OPEN) throw new Error('PUBLIC_ASR_EARLY_CLOSE');
      socket.send(audio.subarray(offset, offset + 640));
      const due = audioStarted + Math.min(offset + 640, audio.length) / 32;
      if (due > performance.now()) await delay(due - performance.now(), undefined, { signal });
    }
    socket.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => socket.readyState === WebSocket.CLOSED, signal);
    if (!events.some(row => row.event.type === 'finished') || events.some(row => row.event.type === 'error')) throw new Error('PUBLIC_ASR_INCOMPLETE');
    const segments = []; let after = 0;
    for (let page = 0; page < 100; page++) {
      const query = await jsonRequest(`${application.base}/api/listenings/${ready.listeningId}/segments?runId=${ready.runId}&afterSequence=${after}&limit=200`, {}, signal);
      if (!Array.isArray(query.items)) throw new Error('PUBLIC_SEGMENTS_INVALID');
      segments.push(...query.items); if (query.items.length < 200) break;
      after = query.items.at(-1).sequence_no; if (page === 99) throw new Error('PUBLIC_SEGMENTS_LIMIT');
    }
    const finals = events.filter(row => row.event.type === 'segment-final').map(row => row.event.segment);
    assert.deepEqual(finals.map(row => row.id), segments.map(row => row.id));
    assert.deepEqual(finals.map(row => row.original_text), segments.map(row => row.original_text));
    return { output: segments.map(row => row.original_text).join(' '), segments, events, listeningId: ready.listeningId, runId: ready.runId,
      audioBytes: audio.length, pacing: '640-byte / 20ms real-time monotonic schedule', audioElapsedMs: performance.now() - audioStarted };
  } finally { signal.removeEventListener('abort', abort); socket.terminate(); }
}
async function captureMt(application, sample, signal) {
  const request = { key: 'quality-local-capability', text: sample.text, source: sample.language, target: sample.target };
  const response = await jsonRequest(application.base + '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }, signal);
  if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('PUBLIC_MT_EMPTY');
  return { output: response.text, input: sample.text, source: sample.language, target: sample.target };
}
export async function collectQualityTrial({ sample, kind, repetition, role, config, corpusPath, directory, mode, upstream, reserve, signal, source, liveAuthorized = false, maxMtRequestBytes, approvalExpiresAt }) {
  const trialId = `${role}:${sample.id}:${kind}:${repetition}`, startedAt = new Date().toISOString();
  let gateway, application, result, errorCode, cleanup = false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), config.maxConnectionMs + 15000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    gateway = await createQualityGateway({ mode, upstream, liveAuthorized, signal: combined,
      expected: { asrModel: config.asrModel, mtModel: config.mtModel, maxAudioBytes: sample.audio?.bytes || 2, maxConnectionMs: config.maxConnectionMs,
        asrParameters: asrParameters(config, sample.language), mtTarget: sample.target, mtInputs: kind === 'mt' ? [sample.text.trim()] : [], allowAsrTranslations: false, maxMtRequestBytes, approvalExpiresAt },
      reserve: request => reserve({ ...request, trialId }) });
    application = await app(gateway, directory, config);
    result = kind === 'asr' ? await captureAsr(application, sample, config, corpusPath, combined) : await captureMt(application, sample, combined);
    const actual = validateQualityObservations(gateway.observations, { mode, kind, startedAt, finishedAt: new Date().toISOString(), maxConnectionMs: config.maxConnectionMs });
    assert.ok(actual.length > 0 && actual.every(row => row.kind === kind));
    const success = actual.filter(row => row.status === 'succeeded'); assert.equal(success.length, 1);
    if (kind === 'mt') assert.equal(result.output, success[0].output.trim());
    else assert.equal(success[0].audioBytes, sample.audio.bytes);
  } catch (error) { errorCode = error.name === 'AbortError' || combined.aborted ? 'COLLECTION_CANCELLED_OR_TIMEOUT' : /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'COLLECTION_FAILED'; }
  finally {
    clearTimeout(timer);
    const cleanupResults = await Promise.allSettled([application?.close(), gateway?.close()]);
    cleanup = cleanupResults.every(row => row.status === 'fulfilled');
  }
  const log = application?.logs() || { text: '', truncated: false };
  const logText = log.text.replaceAll(upstream.key, '[redacted]').replaceAll('quality-local-capability', '[redacted]');
  await writeFile(path.join(directory, 'application.log'), logText, { mode: 0o600 });
  const traceBuilds = [...new Set(logText.split('\n').filter(line => line.startsWith('execution_trace ')).map(line => {
    try { return JSON.stringify(JSON.parse(line.slice(16)).build); } catch { return null; }
  }).filter(Boolean))].map(value => JSON.parse(value));
  if (gateway) try {
    const finalAttempts = validateQualityObservations(gateway.observations, { mode, kind, startedAt, finishedAt: new Date().toISOString(), maxConnectionMs: config.maxConnectionMs });
    assert.ok(finalAttempts.length >= 1 && finalAttempts.length <= (kind === 'asr' ? 2 : 1));
    assert.equal(finalAttempts.filter(row => row.status === 'succeeded').length, 1);
  } catch { errorCode ||= 'INVALID_PROVIDER_OBSERVATIONS'; }
  if (log.truncated) errorCode ||= 'TRACE_LOG_TRUNCATED';
  if (source && (traceBuilds.length !== 1 || traceBuilds[0].git_sha !== source.sha || traceBuilds[0].build_dirty !== source.dirty)) errorCode ||= 'TRACE_BUILD_MISMATCH';
  const row = { schemaVersion: 1, evidenceKind: mode === 'offline' ? 'offline-provider-stub' : 'live-provider', mode, trialId, sampleId: sample.id, kind, repetition, role,
    startedAt, finishedAt: new Date().toISOString(), complete: !errorCode && cleanup, status: errorCode ? 'failed' : cleanup ? 'collected' : 'incomplete',
    cleanup, errorCode, result, outputSha256: result ? hashBytes(result.output) : null, config, provider: gateway?.observations || [], traceBuilds,
    artifacts: [{ path: 'application.log', sha256: hashBytes(logText) }], logTruncated: log.truncated };
  await writeJson(path.join(directory, 'trial.json'), row); return row;
}
export async function collectQualityRun({ frozen, role, directory, mode, upstream, signal, liveAuthorized = false, baselineDirectory }) {
  if (!['baseline', 'candidate'].includes(role) || !['offline', 'live'].includes(mode)) throw new Error('INVALID_COLLECTION_MODE');
  if (mode === 'live') {
    if (!liveAuthorized || process.env.CI || !frozen.freezePath) throw new Error('LIVE_SOURCE_OR_AUTHORIZATION_REQUIRED');
    const reloaded = await readFrozenQualityPlan(frozen.freezePath);
    if (contractDigest(reloaded) !== contractDigest(frozen)) throw new Error('FREEZE_CHANGED_OR_EXPIRED');
    frozen = reloaded;
  }
  const sourceStart = await qualitySources(), config = frozen.config.roles[role];
  if (mode === 'live' && (!liveAuthorized || process.env.CI || sourceStart.dirty || sourceStart.sha !== config.sourceSha)) throw new Error('LIVE_SOURCE_OR_AUTHORIZATION_REQUIRED');
  let baseline;
  if (mode === 'live' && role === 'candidate') {
    if (!baselineDirectory) throw new Error('COMPLETE_BASELINE_REQUIRED');
    const { readQualityCollection } = await import('./quality-assessment.mjs');
    baseline = await readQualityCollection(baselineDirectory, frozen, 'baseline');
  }
  await mkdir(directory, { mode: 0o700 }); // Exclusive run directory: no overwrite/relabel.
  const startedAt = new Date().toISOString(), trials = [];
  const report = { schemaVersion: 1, kind: 'quality-collection', mode, evidenceKind: mode === 'offline' ? 'offline-provider-stub' : 'live-provider', role,
    frozenDigest: frozen.digest, freezeFileSha256: frozen.freezeFileSha256, frozenAt: frozen.frozenAt, sourceStart, sourceEnd: null, startedAt,
    outputDirectory: path.resolve(directory), complete: false, qualityStatus: 'not_run', qualityEvaluated: false, trials: [], cleanup: false,
    ...(baseline && { baselineCollectionSha256: hashBytes(await readFile(path.join(baselineDirectory, 'collection.json'))) }) };
  await writeJson(path.join(directory, 'collection.json'), report);
  const b = frozen.config.budget, estimate = frozen.estimate;
  const ledgerPath = mode === 'offline' ? path.join(directory, 'offline-budget.sqlite') : path.resolve(path.dirname(frozen.configPath), b.ledgerFile);
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const budgetConfig = { ...qualityBudgetConfig(frozen), requireRunClaim: mode === 'live' };
  const budget = openQualityBudget(ledgerPath, budgetConfig, frozen.digest);
  const budgetBefore = budget.snapshot(); let cleanup = false, claimed = false;
  const controller = new AbortController(), runTimer = setTimeout(() => controller.abort(), config.maxRunMs);
  const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  report.maxRunMs = config.maxRunMs;
  try {
    if (mode === 'live') {
      if (contractDigest(sourceStart) !== contractDigest(await qualitySources())) throw new Error('LIVE_SOURCE_CHANGED_BEFORE_COLLECTION');
      budget.claimRun({ role, sourceSha: sourceStart.sha, directory: report.outputDirectory, expectedSnapshot: baseline?.report.budget.after || budgetBefore }); claimed = true;
    }
    outer: for (const sample of frozen.corpus.samples.filter(row => row.split === 'acceptance')) for (const kind of sample.tasks) for (let repetition = 0; repetition < frozen.config.repetitions; repetition++) {
      runSignal.throwIfAborted();
      const name = `trial-${trials.length}`, row = await collectQualityTrial({ sample, kind, repetition, role, config, corpusPath: frozen.corpusPath,
        directory: path.join(directory, name), mode, upstream, signal: runSignal, source: sourceStart, liveAuthorized,
        maxMtRequestBytes: Math.min(b.bounds.mt.providerRequestByteLimit ?? 256 * 1024 + 4096, 2 * 1024 * 1024), approvalExpiresAt: budgetConfig.expiresAt,
        reserve: request => String(budget.reserve(request)) });
      trials.push(row); report.trials.push({ path: `${name}/trial.json`, sha256: hashBytes(await readFile(path.join(directory, name, 'trial.json'))) });
      await writeJson(path.join(directory, 'collection.json'), report);
      if (!row.complete) break outer;
    }
  } finally {
    clearTimeout(runTimer); report.interrupted = runSignal.aborted;
    try {
      cleanup = trials.every(row => row.cleanup); report.sourceEnd = await qualitySources(); report.cleanup = cleanup;
      const expected = frozen.corpus.samples.filter(row => row.split === 'acceptance').reduce((n, sample) => n + sample.tasks.length * frozen.config.repetitions, 0);
      report.complete = !runSignal.aborted && trials.length === expected && trials.every(row => row.complete) && cleanup && contractDigest(sourceStart) === contractDigest(report.sourceEnd);
      report.collectionStatus = report.complete ? 'collected' : 'incomplete'; report.expectedTrials = expected;
    } catch { report.complete = false; report.collectionStatus = 'incomplete'; }
    try { if (claimed) budget.finishRun(role, report.complete); report.budget = { before: budgetBefore, after: budget.snapshot() }; }
    finally { budget.close(); }
    report.finishedAt = new Date().toISOString();
    await writeJson(path.join(directory, 'collection.json'), report);
  }
  return report;
}
