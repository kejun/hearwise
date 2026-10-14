import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { closeServer } from './lifecycle.mjs';

// Expose the existing live bindings in an isolated test process. No production
// statement is removed, replaced, reordered, or wrapped by this loader hook.
const sourceUrl = new URL('../server.mjs', import.meta.url).href;
const exportSuffix = '\nexport { translations, pumpTranslations, translateSpeechPhrase, translating, interimTranslating, activeTranslations, keys, store, server, knowledgeScheduler, relationScheduler, taskRuntime };\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const original = readFileSync(new URL(sourceUrl), 'utf8');
const binding = { originalSha256: hash(original), exportSuffix, transformedSha256: hash(original + exportSuffix), appendOnly: false };
const hook = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== sourceUrl) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  assert.equal(text, original);
  const guard = 'translations.length || interimTranslating >= 1 || translating + interimTranslating >= translations.concurrency';
  const mutation = config?.mutation || 'none';
  assert.ok(['none', 'interim_queue_only'].includes(mutation));
  if (mutation !== 'none') assert.equal(text.split(guard).length - 1, 2);
  const body = mutation === 'none' ? text : text.replaceAll(guard, 'translations.length');
  const transformed = body + exportSuffix;
  binding.mutation = mutation; binding.transformedSha256 = hash(transformed);
  binding.appendOnly = mutation === 'none';
  if (binding.appendOnly) assert.equal(transformed.slice(0, -exportSuffix.length), original);
  return { ...result, source: transformed };
} });
const realNow = Date.now;
let clock = Date.parse('2026-10-14T00:00:00Z');
Date.now = () => clock;
const timeoutSignals = [];
const realTimeout = AbortSignal.timeout;
AbortSignal.timeout = ms => {
  const controller = new AbortController(); timeoutSignals.push({ controller, duration: ms }); return controller.signal;
};
const storedSegments = new Map();
const tasks = new Map(), ledger = [], completions = [], interimRuns = [];
let config, api, modelServer, run, lastResult = null, recentStarts = [];
const pendingTimeouts = [];
const wait = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(predicate, label) {
  const end = performance.now() + 4500;
  while (!predicate()) { if (performance.now() >= end) throw new Error(`Timed out: ${label}`); await wait(); }
}
const configuredTokens = () => (config.identities || [0, 1, 2, 3]).map((_, token) => token);
const identity = token => (config.identities || [0, 1, 2, 3])[token];
const taskId = token => storedSegments.get(identity(token))?.id || `segment-${identity(token)}`;
const classify = error => !error ? 'success' : error.name === 'TimeoutError' ? 'timeout' : error.name === 'AbortError' ? 'cancelled' : 'error';
function rememberTimeouts() { pendingTimeouts.push(...timeoutSignals.splice(0)); }
function refreshTerminals() {
  if (!config.persistedTasks) return;
  const events = api.taskRuntime.diagnostics().events;
  for (const [actor, task] of tasks) {
    if (task.phase !== 'running') continue;
    const terminal = events.findLast(event => event.step_key === 'translation.execute' && event.attributes.segment_id === task.segment.id && ['succeeded', 'failed', 'cancelled'].includes(event.state));
    if (!terminal) continue;
    const http = events.findLast(event => event.step_key === 'translation.http' && event.attributes.segment_id === task.segment.id && ['succeeded', 'failed', 'cancelled'].includes(event.state));
    task.phase = 'settled';
    const outcome = terminal.state === 'cancelled' ? 'cancelled' : http?.error_code === 'REQUEST_TIMEOUT' ? 'timeout' : terminal.attributes.outcome === 'failed' ? 'error' : 'success';
    completions.push({ actor, outcome, terminalState: terminal.state, httpErrorCode: http?.error_code || null });
  }
}
function snapshot() {
  refreshTerminals();
  const phase = {}, queued = [], running = [];
  for (const token of configuredTokens()) {
    const task = tasks.get(token);
    phase[token] = task?.dropped ? 'dropped' : task?.phase || 'fresh';
    if (phase[token] === 'queued') { assert.equal(api.translations.has(taskId(token)), true); queued.push(token); }
    if (phase[token] === 'running') running.push(token);
  }
  const queueIds = api.translations.queuedIds;
  assert.equal(queueIds.length, queued.length);
  const queue = queueIds.map(id => {
    const matches = queued.filter(token => taskId(token) === id);
    assert.equal(matches.length, 1, 'Each waiting segment must map to one queued token');
    return matches[0];
  });
  assert.equal(new Set(queue).size, queue.length);
  assert.equal(queue.length, api.translations.length);
  return { clock, phase, queue, queueIds, running, recentStarts, lastResult, binding,
    queuePresence: Object.fromEntries([...new Set(config.identities || [0, 1, 2, 3])].map(id => [id, api.translations.has(storedSegments.get(id)?.id || `segment-${id}`)])),
    platformControls: { dateNow: 'controlled-monotonic-clock', abortSignalTimeout: 'controlled-platform-deadline', productionTimeoutMs: 15000, waitsRealWallTime: false },
    storedSegments: Object.fromEntries([...storedSegments].map(([actor, segment]) => [actor, api.store.db.prepare('SELECT id,original_text,translation_state,translation_text FROM segments WHERE id=?').get(segment.id)])),
    diagnostics: config.persistedTasks ? api.taskRuntime.diagnostics() : null,
    service: { final: api.translating, interim: api.interimTranslating, active: [...api.activeTranslations.values()].reduce((a, n) => a + n, 0), queueLength: api.translations.length, concurrency: api.translations.concurrency },
    ledger: ledger.map(({ response, timeout, ...entry }) => ({ ...entry, timeoutMs: timeout.duration })),
    completions: [...completions] };
}
async function stable() {
  rememberTimeouts();
  await until(() => { refreshTerminals(); return tasks.size === 0 || [...tasks.values()].filter(task => task.phase === 'running').length === api.translating; }, 'real final HTTP admission');
  await until(() => ledger.filter(entry => !entry.ended).length === api.translating + api.interimTranslating, 'service and HTTP slots');
}
async function initialize(input) {
  config = input;
  modelServer = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'qwen-mt-flash');
    const descriptor = JSON.parse(body.messages[0].content);
    rememberTimeouts();
    const timeout = pendingTimeouts.shift(); assert.ok(timeout); assert.equal(timeout.duration, 15000);
    const actor = descriptor.actor;
    const entry = { index: ledger.length, actor, kind: actor === -1 ? 'interim' : 'final', startedAt: clock, ended: false, requestModel: body.model, requestBodySha256: hash(Buffer.concat(chunks)), response: response, timeout };
    ledger.push(entry); if (actor !== -1) recentStarts.push(actor);
    if (actor !== -1) tasks.get(actor).phase = 'running';
    response.on('close', () => { if (!response.writableEnded) { entry.ended = true; entry.aborted = true; } });
  });
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
  if (config.initializationFailure === 'provider') throw new Error('Controlled translation initialization failure');
  process.env.MT_ENDPOINT = `http://127.0.0.1:${modelServer.address().port}`;
  api = await import(sourceUrl); hook.deregister(); assert.equal(binding.appendOnly, (config.mutation || 'none') === 'none');
  if (!api.server.listening) await once(api.server, 'listening');
  run = api.store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Scheduler verification');
  api.keys.set(run.listeningId, 'synthetic-scheduler-key');
  if (config.persistedTasks) {
    assert.equal(new Set((config.identities || [0, 1, 2, 3])).size, configuredTokens().length);
    for (const actor of configuredTokens()) storedSegments.set(identity(actor), api.store.addSegment(run.listeningId, run.runId, { id: `stored-${actor}`, text: JSON.stringify({ actor }) }).segment);
  }
  for (const actor of config.initialQueue || []) enqueue(actor);
  lastResult = null;
}
function enqueue(actor) {
  const controller = new AbortController();
  const task = { segment: { id: taskId(actor), original_text: JSON.stringify({ actor }), run_id: run.runId, sequence_no: actor + 1 },
    listeningId: run.listeningId, target: 'Chinese', kind: (config.background || [0]).includes(actor) ? 'background' : 'realtime', signal: controller.signal,
    controller, phase: 'queued', done(error) {
      task.phase = 'settled'; completions.push({ actor, outcome: classify(error), errorName: error?.name || null });
    } };
  if (config.persistedTasks) { task.segment = storedSegments.get(identity(actor)); delete task.done; }
  const accepted = api.translations.enqueue(task);
  if (accepted) tasks.set(actor, task);
  lastResult = { accepted };
}
async function admitInterim() {
  const controller = new AbortController();
  const before = ledger.length;
  const execution = { controller, settled: false, error: null };
  interimRuns.push(execution);
  const operation = config.interimMode === 'http'
    ? fetch(`http://127.0.0.1:${api.server.address().port}/api/translate`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'synthetic-scheduler-key', text: JSON.stringify({ actor: -1 }), source: 'en', target: 'Chinese' }) })
      .then(async response => { const body = await response.json(); execution.httpStatus = response.status; if (!response.ok) throw Object.assign(new Error(body.error), { code: body.code }); })
    : api.translateSpeechPhrase({ listeningId: run.listeningId, text: JSON.stringify({ actor: -1 }), signal: controller.signal, final: false });
  execution.promise = operation.then(() => { execution.settled = true; }, error => { execution.settled = true; execution.error = error; });
  await until(() => execution.settled || ledger.slice(before).some(entry => entry.actor === -1 && !entry.ended), 'interim admission');
  lastResult = execution.error ? { code: execution.error.code, message: execution.error.message, httpStatus: execution.httpStatus } : { admitted: true };
}
async function settle(actor, outcome) {
  const entry = ledger.find(item => item.actor === actor && !item.ended);
  assert.ok(entry, `Missing held HTTP ${actor}`);
  const task = actor === -1 ? interimRuns.find(item => !item.settled) : tasks.get(actor);
  entry.delivery = outcome;
  if (outcome === 'cancelled') task.controller.abort(new DOMException('Controlled cancellation', 'AbortError'));
  else if (outcome === 'timeout') { clock += entry.timeout.duration; entry.timeout.controller.abort(new DOMException('Controlled deadline', 'TimeoutError')); }
  else {
    entry.ended = true; entry.httpStatus = outcome === 'error' ? 500 : 200;
    entry.response.writeHead(outcome === 'error' ? 500 : 200, { 'Content-Type': 'application/json' });
    entry.response.end(JSON.stringify(outcome === 'error' ? { error: { message: 'Controlled provider failure' } } : { choices: [{ message: { content: '译文' } }] }));
  }
  await until(() => { refreshTerminals(); return actor === -1 ? task.settled : task.phase === 'settled'; }, 'translation terminal');
  if (actor === -1) completions.push({ actor, outcome: classify(task.error), errorName: task.error?.name || null });
  // The HTTP client can reject on disconnect before the server observes it.
  // Wait for the real provider close and server finally, not a consistent but
  // still in-flight pre-disconnect snapshot.
  await until(() => entry.ended && (actor !== -1 || api.interimTranslating === 0), 'provider settlement and server release');
  await stable();
}
async function act(message) {
  if (message.action === 'initialize') { await initialize(message.config); return snapshot(); }
  recentStarts = []; lastResult = null;
  api.keys.set(run.listeningId, 'synthetic-scheduler-key');
  if (message.action === 'enqueue' || message.action === 'duplicate') enqueue(message.actor);
  else if (message.action === 'pump') { api.pumpTranslations(); await stable(); }
  else if (message.action === 'admit_interim' || message.action === 'reject_interim') { await admitInterim(); await stable(); }
  else if (message.action === 'settle_final') await settle(message.actor, message.argument);
  else if (message.action === 'settle_interim') await settle(-1, message.argument);
  else if (message.action === 'set_head') api.translations.setSpeechHead('verification', message.actor === -1 ? null : taskId(message.actor));
  else if (message.action === 'advance_time') clock += 10000;
  else if (message.action === 'cancel_queued') {
    assert.equal(api.translations.cancel(taskId(message.actor)), true); tasks.get(message.actor).phase = 'cancelled';
  } else if (message.action === 'recycle') {
    assert.equal(tasks.get(message.actor)?.phase, 'settled'); tasks.delete(message.actor);
  } else if (message.action === 'close') {
    for (const task of tasks.values()) {
      if (task.phase === 'queued') { api.translations.cancel(task.segment.id); task.phase = 'cancelled'; }
      task.controller.abort();
    }
    for (const execution of interimRuns) execution.controller.abort();
    await api.knowledgeScheduler.close(); await api.relationScheduler.close();
    await api.taskRuntime.dispose();
    await closeServer(api.server, 'Real application'); await closeServer(modelServer, 'Model provider');
    api.store.close(); Date.now = realNow; AbortSignal.timeout = realTimeout;
    return { closed: true };
  } else if (!['observe', 'stutter'].includes(message.action)) throw new Error(`Unknown action ${message.action}`);
  return snapshot();
}
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    try {
      const state = await act(message); process.send({ id: message.id, state });
      if (message.action === 'close') process.disconnect();
    } catch (error) { process.send({ id: message.id, error: error.stack }); }
  });
});
