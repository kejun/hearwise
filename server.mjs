import { createTaskRuntime } from './dist/server/index.js';
import { validateInterimTranslation, TRANSLATION_TARGETS, RECOGNITION_SOURCES } from './public/translation-params.js';
import http from 'node:http';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { ListeningStore } from './storage.mjs';
import { extractKnowledge, repairKnowledge, splitFocusSegments, regenerateKnowledge } from './knowledge.mjs';
import { createTranslationScheduler } from './translation-queue.mjs';
import { createKnowledgeScheduler } from './knowledge-queue.mjs';
import { createKnowledgeWorkflow } from './knowledge-workflow.mjs';
import { createSpeechService } from './speech-service.mjs';
import { createProviderAdmission } from './provider-admission.mjs';
import { createRelationScheduler } from './relation-queue.mjs';
import { createRelationWorkflow } from './relation-workflow.mjs';
import { DataTransferError, MAX_IMPORT_BYTES, exportDatabase, inspectDatabase, restoreDatabase } from './data-transfer.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const listeningDb = process.env.LISTENING_DB || path.join(root, 'data', 'listenings.sqlite');
const store = new ListeningStore(listeningDb);
const dataRoot = path.dirname(listeningDb);
const importRoot = path.join(dataRoot, '.imports');
const exportRoot = path.join(dataRoot, '.exports');
const backupRoot = path.join(dataRoot, 'backups');
const pendingImports = new Map();
const IMPORT_TTL_MS = 15 * 60 * 1000;
const model = 'qwen-audio-3.0-asr-flash-streaming';
const asrEndpoint = process.env.ASR_ENDPOINT || 'wss://maas.qianwenaiapi.com/api-ws/v1/inference';
const mtEndpoint = process.env.MT_ENDPOINT || 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions';
const types = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
  '/audio-processor.js': 'text/javascript; charset=utf-8', '/processing-state.js': 'text/javascript; charset=utf-8',
  '/translation-params.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
const targets = TRANSLATION_TARGETS;
const sources = RECOGNITION_SOURCES;
// 识别语言与译文语言相同（如中文→简体中文）时不调用翻译模型，原文直通作为最终译文；auto 无法判定，永远走翻译
const sameLanguageTargets = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
const isSameLanguage = (source, target) => sameLanguageTargets[source] === target;
const audioSources = ['microphone', 'tab'];
const captionModes = ['realtime', 'classic'];
const asrSentenceSilenceMs = Math.min(6000, Math.max(200, Number(process.env.ASR_SENTENCE_SILENCE_MS || 2500)));
const taskRuntime = createTaskRuntime({
  onEvent: event => {
    // Always-on local diagnostics; never build an unbounded stdout backlog.
    if (process.stdout.writableLength > 65536) throw new Error('Trace output backpressure');
    process.stdout.write(`execution_trace ${JSON.stringify(event)}\n`);
  } });
const keys = new Map();
const listeners = new Map();
const translations = createTranslationScheduler();
const provider = createProviderAdmission({ onMetric: event => console.info('provider_request', JSON.stringify(event)) });
const graphRevisions = new Map();
let relationScheduler;
const speech = createSpeechService({ store, taskRuntime, incrementalClauses: process.env.HEARWISE_INCREMENTAL_BOUNDARY !== 'sentence', translatePhrase: translateSpeechPhrase, onDispose: id => maybeReleaseKey(id), setHead: (owner, id) => translations.setSpeechHead(owner, id),
  onMetric: event => console.info('speech_event', JSON.stringify(event)) });
for (const file of ['knowledge-editor.js', 'transcript-visibility.js', 'caption-frontier.js', 'speech-protocol.js', 'speech-controller.js', 'speech-player.js', 'speech-buffer.js', 'speech-output-processor.js', 'speech-media-session.js', 'knowledge-graph.js', 'knowledge-graph-layout.js']) {
  types[`/${file}`] = 'text/javascript; charset=utf-8';
}
let translating = 0;
let interimTranslating = 0;
const activeTranslations = new Map();
const modelErrorCounts = new Map();
const configuredExtractionWait = Number(process.env.EXTRACTION_WAIT_MS ?? 1500);
const extractionWaitMs = Number.isFinite(configuredExtractionWait) ? Math.min(15000, Math.max(0, configuredExtractionWait)) : 1500;
const knowledgeWorkflow = createKnowledgeWorkflow({
  store, endpoint: mtEndpoint, onProgress: publishProcessing,
  extract: (key, input, endpoint, context) => provider.run({ key, priority: 'knowledge', signal: context?.signal }, () => extractKnowledge(key, input, endpoint, context)),
  repair: (key, input, endpoint, targets, context) => provider.run({ key, priority: 'knowledge', signal: context?.signal }, () => repairKnowledge(key, input, endpoint, targets, context)),
  onItems: (id, items) => {
    for (const item of items) broadcast(id, { type: 'knowledge-upserted', listeningId: id, item });
  },
  onRejected: (job, part, rejected, stage) => console.info('knowledge_rejected', JSON.stringify({
    job_id: job.id, part_no: part, stage, rejected_count: rejected.length,
    items: rejected.map(item => ({ source_index: item.sourceIndex, issues: item.issues }))
  })),
  onDiagnostic: (job, part, issues, stage) => console.info('knowledge_diagnostic', JSON.stringify({
    job_id: job.id, part_no: part, stage, issues
  })),
  onError: error => logModelError('knowledge', error)
});
const knowledgeScheduler = createKnowledgeScheduler({
  store, provider, taskRuntime, listeningIds: () => keys.keys(), keyFor: id => keys.get(id),
  translationBusy: () => Boolean(translations.length || translating || interimTranslating),
  execute: executeKnowledge, onChange: publishProcessing, onIdle: maybeReleaseKey,
  onError: error => logModelError('knowledge', error),
  onLog: entry => console.info('knowledge_job', JSON.stringify(entry)),
  translationGraceMs: extractionWaitMs,
  concurrency: Math.min(4, Math.max(1, Math.floor(Number(process.env.EXTRACTION_CONCURRENCY) || 2)))
});

const relationWorkflow = createRelationWorkflow({ store, endpoint: mtEndpoint, provider,
  onChange: publishProcessing, onError: error => logModelError('relations', error) });
relationScheduler = createRelationScheduler({ store, provider, listeningIds: () => keys.keys(), keyFor: id => keys.get(id),
  foregroundBusy: () => Boolean(translations.length || translating || interimTranslating ||
    [...keys.keys()].some(id => knowledgeScheduler.hasWork(id) || speech.hasConsumers(id))),
  execute: (job, key, signal) => taskRuntime.run('relation.execute', { listening_id: job.listening_id, job_id: job.id,
    attempt: (job.request_count || 0) + 1 }, context => relationWorkflow.execute(job, key, context.signal, context), signal), onChange: publishProcessing, onIdle: maybeReleaseKey,
  onError: error => logModelError('relations', error) });
// Recovered runs wait for an explicit in-memory key; retain their paid progress.
queueMicrotask(() => relationScheduler.pump());

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function sameOrigin(req) {
  try {
    if (!req.headers.origin) return true;
    const origin = new URL(req.headers.origin);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto ? `${forwardedProto}:` : (req.socket.encrypted ? 'https:' : 'http:');
    return origin.host === req.headers.host && origin.protocol === protocol;
  } catch { return false; }
}
async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32_000) throw new Error('请求内容过长');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function transferError(error, fallback = '数据操作失败') {
  return {
    status: error instanceof DataTransferError ? error.status : 500,
    body: { code: error?.code || 'DATA_TRANSFER_FAILED', error: error?.message || fallback }
  };
}
function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
async function receiveDatabase(req, filename) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    throw new DataTransferError('备份文件超过 2 GB 限制', { status: 413, code: 'IMPORT_TOO_LARGE' });
  }
  await mkdir(path.dirname(filename), { recursive: true });
  const handle = await open(filename, 'wx');
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_IMPORT_BYTES) {
        throw new DataTransferError('备份文件超过 2 GB 限制', { status: 413, code: 'IMPORT_TOO_LARGE' });
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset);
        if (!bytesWritten) throw new Error('无法写入导入文件');
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(filename, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  if (!bytes) {
    await rm(filename, { force: true }).catch(() => {});
    throw new DataTransferError('备份文件为空', { code: 'INVALID_SQLITE' });
  }
  return bytes;
}
function retainImport(filename, info) {
  const token = randomUUID();
  const timer = setTimeout(() => {
    pendingImports.delete(token);
    void rm(filename, { force: true });
  }, IMPORT_TTL_MS);
  timer.unref?.();
  pendingImports.set(token, { filename, info, timer });
  return token;
}
async function discardImport(token) {
  const pending = pendingImports.get(token);
  if (!pending) return;
  pendingImports.delete(token);
  clearTimeout(pending.timer);
  await rm(pending.filename, { force: true }).catch(() => {});
}
function restoreRuntimeBusy() {
  if (translations.length || translating || interimTranslating) return '翻译仍在处理，请稍后再导入。';
  if (knowledgeEdits.size) return '知识修改仍在保存，请稍后再导入。';
  if ([...keys.keys()].some(id => speech.hasConsumers(id))) return '语音播报仍在运行，请停止播报后再导入。';
  return null;
}
function resetRuntimeAfterRestore(oldListeningIds) {
  for (const id of oldListeningIds) {
    translations.remove(id);
    taskRuntime.cancelListening(id);
    speech.remove(id);
    knowledgeScheduler.remove(id);
    relationScheduler?.remove(id);
  }
  for (const clients of listeners.values()) for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.close(1012, '数据已恢复，请刷新页面');
  }
  listeners.clear();
  graphRevisions.clear();
  const oldKeys = [...new Set(keys.values())];
  keys.clear();
  for (const key of oldKeys) provider.release(key);
}

function broadcast(listeningId, data) {
  for (const ws of listeners.get(listeningId) || []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function publishProcessing(id, { refreshDetail = false } = {}) {
  if (!store.hasListening(id)) return;
  broadcast(id, { type: 'processing-updated', listeningId: id, processing: store.processing(id),
    processingAvailable: keys.has(id), refreshDetail });
  const graphRevision = store.graphMetadata(id)?.graphRevision;
  if (graphRevision != null && graphRevisions.get(id) !== graphRevision) {
    graphRevisions.set(id, graphRevision);
    broadcast(id, { type: 'graph-invalidated', listeningId: id, graphRevision });
  }
  // Defer pumping until the current knowledge/translation transaction has finished.
  queueMicrotask(() => relationScheduler?.pump());
}
function subscribe(id, ws) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(ws);
}
function unsubscribe(id, ws) {
  if (!id) return;
  listeners.get(id)?.delete(ws);
  if (!listeners.get(id)?.size) listeners.delete(id);
}
function errorMessage(error) { return String(error?.message || error || '服务暂时不可用').slice(0, 300); }
function logModelError(modelName, error) {
  const message = errorMessage(error);
  const kind = error?.status === 429 || /429|rate limit|限流/i.test(message) ? 'rate_limit'
    : ['TimeoutError', 'AbortError'].includes(error?.name) || /timeout|超时/i.test(message) ? 'timeout' : 'other';
  const counter = `${modelName}:${kind}`;
  modelErrorCounts.set(counter, (modelErrorCounts.get(counter) || 0) + 1);
  console.warn('model_error', counter, modelErrorCounts.get(counter), message);
}

async function translate(key, text, target, timeout = 15000, signal, context) {
  if (!context) return taskRuntime.run('translation.check', { job_id: randomUUID(), kind: 'check' },
    child => translate(key, text, target, timeout, child.signal, child), signal);
  return context.step('translation.http', child => provider.run({ key, priority: 'translation', signal: child.signal }, async () => {
    child.event('provider_started');
    child.event('request_started');
    const requestSignal = AbortSignal.any([child.signal, AbortSignal.timeout(timeout)]);
    const response = await fetch(mtEndpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-mt-flash', messages: [{ role: 'user', content: text }],
        translation_options: { source_lang: 'auto', target_lang: target } }),
      signal: requestSignal });
    child.event('response_headers', { http_status: response.status });
    const result = await response.json().catch(() => { requestSignal.throwIfAborted(); return {}; });
    child.signal.throwIfAborted();
    child.event('response_received', { http_status: response.status });
    if (!response.ok) throw Object.assign(new Error(result.error?.message || result.message || `翻译服务 HTTP ${response.status}`), { status: response.status });
    const output = result.choices?.[0]?.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw Object.assign(new Error('翻译服务未返回文字'), { code: 'TRANSLATION_EMPTY' });
    return output.trim();
  }));
}
async function translateSpeechPhrase({ listeningId, text, signal, final, traceContext, consumerId, runId, segmentId }) {
  if (!traceContext) return taskRuntime.run('translation.phrase', { listening_id: listeningId, job_id: randomUUID(),
    kind: final ? 'remainder' : 'phrase', consumer_id: consumerId, run_id: runId, segment_id: segmentId },
    child => translateSpeechPhrase({ listeningId, text, signal: child.signal, final, traceContext: child, consumerId, runId, segmentId }), signal);
  if (signal.aborted) throw signal.reason;
  const key = keys.get(listeningId);
  if (!key) throw new Error('收听连接已结束，请从文字记录完整回放');
  if (final) {
    // Remainders are final audible work, under the existing scheduler/fairness budget.
    return new Promise((resolve, reject) => {
      const id = `speech-remainder:${randomUUID()}`;
      const abort = () => { translations.cancel(id); reject(signal.reason); pumpTranslations(); };
      const done = (error, result) => { signal.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
      signal.addEventListener('abort', abort, { once: true });
      translations.enqueue({ segment: { id, original_text: text }, listeningId, target: 'Chinese', kind: 'realtime', signal, done, traceContext });
      pumpTranslations();
    });
  }
  // Confirmed early phrases and UI previews share the single optional-work slot.
  if (translations.length || interimTranslating >= 1 || translating + interimTranslating >= translations.concurrency) {
    throw Object.assign(new Error('最终译文优先处理'), { code: 'TRANSLATION_BUSY' });
  }
  interimTranslating++;
  try { return await translate(key, text, 'Chinese', 15000, signal, traceContext); }
  finally { interimTranslating--; pumpTranslations(); knowledgeScheduler.pump(); }
}

async function checkTranslation(key) {
  try { await translate(key, 'Hello', 'Chinese', 12000); return { ok: true, message: '翻译模型可用' }; }
  catch (error) { return { ok: false, message: errorMessage(error) }; }
}
async function checkKnowledge(key) {
  try {
    const input = { listening_id: 'test', policy_version: 2, context_segments: [],
      focus_segments: [{ id: 'test-segment', text: 'Hello.' }], existing_candidates: [], observed_candidates: [] };
    await taskRuntime.run('knowledge.execute', { job_id: randomUUID(), kind: 'check' }, context =>
      context.step('knowledge.extract', child => extractKnowledge(key, input, mtEndpoint, child)));
    return { ok: true, message: '知识抽取模型可用' };
  } catch (error) { return { ok: false, message: errorMessage(error) }; }
}
function checkRecognition(key) {
  return new Promise(resolve => {
    const taskId = randomUUID();
    const ws = new WebSocket(asrEndpoint, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000 });
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timeout); ws.close(); resolve(result); };
    const timeout = setTimeout(() => finish({ ok: false, message: '连接超时' }), 12000);
    ws.on('open', () => ws.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: { task_group: 'audio', task: 'asr', function: 'recognition', model,
        parameters: { format: 'pcm', sample_rate: 16000 }, input: {} } })));
    ws.on('message', raw => {
      let event; try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.header?.event === 'task-started') {
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }),
          error => finish(error ? { ok: false, message: '无法结束测试任务' } : { ok: true, message: '识别模型可用' }));
      }
      if (event.header?.event === 'task-failed') finish({ ok: false, message: event.header?.error_message || event.payload?.message || '识别任务启动失败' });
    });
    ws.on('unexpected-response', (_request, response) => finish({ ok: false, message: `识别服务 HTTP ${response.statusCode}` }));
    ws.on('error', () => finish({ ok: false, message: '无法连接识别服务' }));
    ws.on('close', () => finish({ ok: false, message: '识别连接已关闭' }));
  });
}

function maybeReleaseKey(id) {
  relationScheduler?.pump();
  if (!id || listeners.get(id)?.size || speech.hasConsumers(id) || knowledgeScheduler.hasWork(id) || relationScheduler?.hasWork(id) ||
      activeTranslations.get(id) || translations.hasListening(id)) return;
  const key = keys.get(id);
  keys.delete(id);
  if (key && ![...keys.values()].includes(key)) provider.release(key);
  knowledgeScheduler.pump();
  relationScheduler?.pump();
}
function queueTranslation(segment, listeningId, target, kind = 'background') {
  if (segment.translation_state === 'complete') return;
  if (translations.enqueue({ segment, listeningId, target, kind })) pumpTranslations();
}
function pumpTranslations() {
  while (translating + interimTranslating < translations.concurrency) {
    const task = translations.next();
    if (!task) break;
    const key = keys.get(task.listeningId);
    if (!key) { task.done?.(new Error('收听连接已结束')); continue; }
    translating++;
    activeTranslations.set(task.listeningId, (activeTranslations.get(task.listeningId) || 0) + 1);
    const operation = async context => {
      context.event('admitted', { queue_ms: Math.max(0, Date.now() - task.enqueuedAt) });
      let failed = false;
      let updated;
      const modelStartedAt = performance.now();
      console.info('translation_stage', JSON.stringify({ stage: 'queue', kind: task.kind, elapsedMs: Date.now() - task.enqueuedAt }));
      try {
        const text = await translate(key, task.segment.original_text, task.target, 15000, context.signal, context);
        context.signal.throwIfAborted();
        if (task.done) task.done(null, text);
        else updated = store.setTranslation(task.segment.id, text, false);
        context.event(updated || task.done ? 'translation_committed' : 'discarded');
        console.info('translation_stage', JSON.stringify({ stage: 'model', kind: task.kind, elapsedMs: performance.now() - modelStartedAt }));
      } catch (error) {
        failed = true;
        if (context.signal.aborted) { task.done?.(error); return { outcome: 'discarded' }; }
        if (task.done) task.done(error);
        else updated = store.setTranslation(task.segment.id, null, true);
        logModelError('translation', error);
      } finally {
        if (updated) broadcast(task.listeningId, { type: 'translation-updated', runId: updated.run_id, segment: updated });
        if (updated) context.event('notification_sent');
        speech.notify(task.listeningId);
        translating--;
        activeTranslations.set(task.listeningId, activeTranslations.get(task.listeningId) - 1);
        if (!activeTranslations.get(task.listeningId)) activeTranslations.delete(task.listeningId);
        publishProcessing(task.listeningId);
        pumpTranslations(); knowledgeScheduler.pump(); maybeReleaseKey(task.listeningId);
      }
      return { outcome: failed ? 'failed' : updated || task.done ? 'ok' : 'discarded' };
    };
    const execution = task.traceContext ? operation(task.traceContext) : taskRuntime.run('translation.execute', {
      listening_id: task.listeningId, job_id: task.segment.id, segment_id: task.segment.id, segment_sequence: task.segment.sequence_no,
      run_id: task.segment.run_id, kind: task.kind }, operation, task.signal);
    void execution.catch(() => {});
  }
}
async function executeKnowledge(job, key, context) {
  context.signal.throwIfAborted();
  if (job.prompt_version === 2) return knowledgeWorkflow.execute(job, key, context);
  const baseInput = store.jobInput(job);
  for (const input of splitFocusSegments(baseInput)) {
    if (!store.hasListening(job.listening_id)) break;
    const refreshed = store.jobInput(job, input.focus_segments);
    input.existing_candidates = refreshed.existing_candidates;
    if (job.prompt_version === 2) input.observed_candidates = refreshed.observed_candidates;
    const parsed = await context.step('knowledge.extract', child => provider.run({ key, priority: 'knowledge', signal: child.signal }, () => extractKnowledge(key, input, mtEndpoint, child)));
    context.signal.throwIfAborted();
    if (!store.hasListening(job.listening_id)) break;
    if (parsed.rejected.length) console.info('knowledge_rejected', job.id, `${parsed.rejected.length}/${parsed.rejected.length + parsed.items.length}`,
      parsed.rejected.map(r => `${r.name}（${r.reason}）`).join('；').slice(0, 400));
    const changed = store.applyKnowledge(job.listening_id, parsed.items);
    for (const item of changed) broadcast(job.listening_id, { type: 'knowledge-upserted', listeningId: job.listening_id, item });
  }
}
function passthroughTranslation(segment, listeningId, kind) {
  const trace = taskRuntime.open('translation.execute', { listening_id: listeningId, job_id: segment.id,
    segment_id: segment.id, segment_sequence: segment.sequence_no, run_id: segment.run_id, kind });
  try {
    trace.context.event('passthrough');
    const updated = store.setTranslation(segment.id, segment.original_text, false);
    trace.context.event(updated ? 'translation_committed' : 'discarded');
    trace.succeed({ outcome: updated ? 'ok' : 'discarded' });
    return updated;
  } catch (error) { trace.fail(error); throw error; }
}
function resumeProcessing(id, key) {
  keys.set(id, key);
  for (const row of store.pendingTranslations(id)) {
    if (isSameLanguage(row.source_lang, row.target_lang)) { // 同语言待译句：本地以原文补全，不调翻译模型
      const updated = passthroughTranslation(row, id, 'background');
      if (updated) broadcast(id, { type: 'translation-updated', runId: updated.run_id, segment: updated });
      speech.notify(id);
      continue;
    }
    queueTranslation(row, id, row.target_lang);
  }
  knowledgeScheduler.schedule(id, true);
  knowledgeScheduler.pump();
  relationScheduler?.schedule(id);
  maybeReleaseKey(id);
}

const knowledgeEdits = new Set();
store.recoverKnowledgeEditJobs();
function notifyKnowledgeEdit(id) {
  try {
    broadcast(id, { type: 'knowledge-edited', listeningId: id });
    relationScheduler.schedule(id); publishProcessing(id); maybeReleaseKey(id);
  } catch (error) { logModelError('knowledge-edit-notify', error); }
}
async function runKnowledgeEditJob(id, itemId, jobId, prepared, key) {
  const started = Date.now();
  try {
    const card = await taskRuntime.run('knowledge.execute', { listening_id: id, job_id: jobId, kind: 'manual' }, context =>
      provider.run({ key, priority: 'knowledge', signal: context.signal }, () => regenerateKnowledge(key, prepared, mtEndpoint, context)));
    store.saveKnowledgeEdit(id, itemId, prepared, card, jobId);
    keys.set(id, key); notifyKnowledgeEdit(id);
    console.info('knowledge_edit', JSON.stringify({ job_id: jobId, state: 'succeeded', elapsed_ms: Date.now() - started }));
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
    const message = error.knowledgeEdit ? error.message : timeout ? '卡片生成超过 90 秒，原内容未更改，请稍后重试。' :
      error?.status ? `模型服务请求失败（HTTP ${error.status}），原内容未更改，请稍后重试。` :
        '卡片生成失败或结果未通过校验，原内容未更改，请稍后重试。';
    store.failKnowledgeEditJob(jobId, message);
    console.warn('knowledge_edit', JSON.stringify({ job_id: jobId, state: 'failed', elapsed_ms: Date.now() - started,
      reason: timeout ? 'timeout' : error.knowledgeEdit ? 'conflict' : 'generation_failed', http_status: error.status || null }));
  } finally { knowledgeEdits.delete(id); }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: '仅允许同源请求' });

  if (req.method === 'GET' && url.pathname === '/api/data/export') {
    const temporary = path.join(exportRoot, `hearwise-export-${randomUUID()}.sqlite`);
    try {
      await mkdir(exportRoot, { recursive: true });
      exportDatabase(store, temporary);
      const metadata = await stat(temporary);
      const filename = `hearwise-backup-${backupStamp()}.sqlite`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': metadata.size,
        'Cache-Control': 'no-store'
      });
      const stream = createReadStream(temporary);
      const cleanup = () => { void rm(temporary, { force: true }).catch(() => {}); };
      stream.once('error', error => { cleanup(); if (!res.destroyed) res.destroy(error); });
      res.once('close', cleanup);
      stream.pipe(res);
      return;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      const failure = transferError(error, '生成数据库备份失败');
      return sendJson(res, failure.status, failure.body);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/data/import/validate') {
    const temporary = path.join(importRoot, `hearwise-import-${randomUUID()}.sqlite`);
    try {
      await receiveDatabase(req, temporary);
      const info = inspectDatabase(temporary);
      const token = retainImport(temporary, info);
      return sendJson(res, 200, { ...info, token });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      const failure = transferError(error, '无法验证备份文件');
      return sendJson(res, failure.status, failure.body);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/data/import/commit') {
    let input;
    try { input = await readJson(req); }
    catch { return sendJson(res, 400, { code: 'INVALID_IMPORT_REQUEST', error: '导入请求格式无效' }); }
    const token = typeof input?.token === 'string' ? input.token : '';
    const pending = pendingImports.get(token);
    if (!pending) return sendJson(res, 410, { code: 'IMPORT_EXPIRED', error: '导入文件已过期，请重新选择备份文件' });
    const busy = restoreRuntimeBusy();
    if (busy) return sendJson(res, 409, { code: 'RESTORE_BUSY', error: busy });

    const oldListeningIds = store.db.prepare('SELECT id FROM listenings').all().map(row => row.id);
    const backup = path.join(backupRoot, `before-import-${backupStamp()}-${randomUUID().slice(0, 8)}.sqlite`);
    try {
      const result = restoreDatabase(store, pending.filename, backup);
      resetRuntimeAfterRestore(oldListeningIds);
      await discardImport(token);
      return sendJson(res, 200, {
        ok: true,
        databaseVersion: result.databaseVersion,
        listeningCount: result.listeningCount,
        safetyBackup: path.basename(backup)
      });
    } catch (error) {
      const failure = transferError(error, '导入数据失败，当前数据未被替换');
      return sendJson(res, failure.status, failure.body);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/test-connection') {
    try {
      const { key } = await readJson(req);
      if (typeof key !== 'string' || !key.trim()) return sendJson(res, 400, { error: '请先填写 API Key' });
      const [recognition, translation, knowledge] = await Promise.all([
        checkRecognition(key.trim()), checkTranslation(key.trim()), checkKnowledge(key.trim())
      ]);
      return sendJson(res, 200, { recognition, translation, knowledge });
    } catch { return sendJson(res, 400, { error: '测试请求无效' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/translate') {
    let input;
    try { input = await readJson(req); }
    catch { return sendJson(res, 400, { code: 'INVALID_TRANSLATION_REQUEST', error: '翻译请求格式无效' }); }
    const invalid = validateInterimTranslation(input);
    if (invalid) return sendJson(res, 400, invalid);
    const { key, text, target = 'Chinese', source = 'auto' } = input;
    try {
      if (isSameLanguage(source, target)) {
        await taskRuntime.run('translation.preview', { job_id: randomUUID(), kind: 'preview' }, async context => { context.event('passthrough'); });
        return sendJson(res, 200, { text: text.trim() });
      }
      if (translations.length || interimTranslating >= 1 || translating + interimTranslating >= translations.concurrency) {
        await taskRuntime.run('translation.preview', { job_id: randomUUID(), kind: 'preview' }, async context => {
          context.event('discarded'); return { outcome: 'discarded' };
        });
        return sendJson(res, 429, { code: 'FINAL_TRANSLATION_BUSY', error: '最终译文优先处理' });
      }
      // Only this HTTP consumer owns this controller; finals and other consumers are independent.
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', disconnected); res.once('close', disconnected);
      if (req.aborted || res.destroyed) controller.abort();
      const modelStartedAt = performance.now();
      interimTranslating++;
      try {
        const textResult = await taskRuntime.run('translation.preview', { job_id: randomUUID(), kind: 'preview' },
          context => translate(key.trim(), text.trim(), target, 15000, context.signal, context), controller.signal);
        if (!controller.signal.aborted) return sendJson(res, 200, { text: textResult });
      } finally {
        req.off('aborted', disconnected); res.off('close', disconnected);
        console.info('translation_stage', JSON.stringify({ stage: 'model', kind: 'preview', elapsedMs: performance.now() - modelStartedAt, canceled: controller.signal.aborted }));
        interimTranslating--; pumpTranslations(); knowledgeScheduler.pump();
      }
    } catch (error) { if (!res.destroyed) return sendJson(res, 502, { code: 'TRANSLATION_FAILED', error: errorMessage(error) }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/listenings') {
    const page = Math.max(1, Math.min(100000, Math.floor(Number(url.searchParams.get('page')) || 1)));
    return sendJson(res, 200, store.list(page));
  }
  const editStatusMatch = /^\/api\/listenings\/([0-9a-f-]{36})\/knowledge\/([0-9a-f-]{36})\/edits\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (editStatusMatch && req.method === 'GET') {
    const job = store.knowledgeEditJob(...editStatusMatch.slice(1));
    return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: '保存任务不存在，请重新打开条目核对' });
  }
  const knowledgeMatch = /^\/api\/listenings\/([0-9a-f-]{36})\/knowledge\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (knowledgeMatch && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    const [, id, itemId] = knowledgeMatch;
    let locked = false;
    try {
      if (req.method === 'GET') {
        const snapshot = store.knowledgeEditSnapshot(id, itemId);
        return sendJson(res, 200, { ...snapshot, editJob: store.knowledgeEditForSnapshot(id, itemId, snapshot.revision) });
      }
      const input = await readJson(req);
      const asynchronous = req.method === 'PATCH' && req.headers.prefer === 'respond-async';
      const jobId = req.headers['idempotency-key'];
      if (asynchronous) {
        if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(jobId))
          return sendJson(res, 400, { error: '保存任务编号无效' });
        const existing = store.knowledgeEditJob(id, itemId, jobId, input);
        if (existing) return sendJson(res, 202, { job: existing });
      }
      // Body reads yield: recheck after parsing before owning the per-record lock.
      if (knowledgeEdits.has(id)) return sendJson(res, 409, { error: '正在保存知识修改，请稍后再试' });
      knowledgeEdits.add(id); locked = true;
      let result;
      if (req.method === 'DELETE') {
        if (!input || typeof input.revision !== 'string' || Object.keys(input).some(key => key !== 'revision'))
          return sendJson(res, 400, { error: '删除请求格式无效' });
        result = store.deleteKnowledgeItem(id, itemId, input.revision);
      } else {
        const prepared = store.prepareKnowledgeEdit(id, itemId, input);
        const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : keys.get(id);
        if (!key) return sendJson(res, 400, { error: '请先在连接设置填写 API Key' });
        if (asynchronous) {
          const job = store.createKnowledgeEditJob(id, itemId, jobId, input);
          // The job owns the lock after acceptance, independently of the HTTP connection.
          locked = false;
          void runKnowledgeEditJob(id, itemId, jobId, prepared, key);
          return sendJson(res, 202, { job });
        }
        const card = await taskRuntime.run('knowledge.execute', { listening_id: id, job_id: randomUUID(), kind: 'manual' }, context =>
          provider.run({ key, priority: 'knowledge', signal: context.signal }, () => regenerateKnowledge(key, prepared, mtEndpoint, { ...context, manualTimeoutMs: 30000 })));
        result = { item: store.saveKnowledgeEdit(id, itemId, prepared, card) };
        keys.set(id, key);
      }
      notifyKnowledgeEdit(id);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.knowledgeEdit ? error.status : error instanceof SyntaxError ? 400 : 502,
        { code: 'KNOWLEDGE_EDIT_FAILED', saved: false,
          error: error.knowledgeEdit ? error.message : '知识修改失败，原内容未更改，请稍后重试' });
    } finally { if (locked) knowledgeEdits.delete(id); }
  }
  const match = /^\/api\/listenings\/([0-9a-f-]{36})(?:\/(retry|export|segments|graph))?$/.exec(url.pathname);
  if (match && req.method === 'GET' && !match[2]) {
    const page = Math.max(1, Math.min(100000, Math.floor(Number(url.searchParams.get('page')) || 1)));
    const detail = store.detail(match[1], page);
    return detail ? sendJson(res, 200, { ...detail, processingAvailable: keys.has(match[1]) }) : sendJson(res, 404, { error: '收听记录不存在' });
  }
  if (match && req.method === 'PATCH' && !match[2]) {
    let input;
    try { input = await readJson(req); }
    catch { return sendJson(res, 400, { error: '标题和备注请求格式无效' }); }
    try {
      const result = store.updateMetadata(match[1], input);
      if (result === 'missing') return sendJson(res, 404, { error: '收听记录不存在' });
      if (result === 'active') return sendJson(res, 409, { error: '请先停止这条收听，再修改标题或备注' });
      return sendJson(res, 200, { listening: result });
    } catch (error) {
      return sendJson(res, error instanceof TypeError ? 400 : 500, { error: errorMessage(error) });
    }
  }
  if (match && req.method === 'DELETE' && !match[2]) {
    try {
      const result = store.removeListening(match[1]);
      if (result === 'missing') return sendJson(res, 404, { error: '收听记录不存在' });
      if (result === 'active') return sendJson(res, 409, { error: '请先停止这条收听，再删除记录' });
      translations.remove(match[1]);
      taskRuntime.cancelListening(match[1]);
      speech.remove(match[1]);
      keys.delete(match[1]);
      knowledgeScheduler.remove(match[1]);
      relationScheduler.remove(match[1]);
      graphRevisions.delete(match[1]);
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 500, { error: errorMessage(error) }); }
  }
  if (match && match[2] === 'retry' && req.method === 'POST') {
    try {
      const { key } = await readJson(req);
      if (!store.detail(match[1], 1, 1)) return sendJson(res, 404, { error: '收听记录不存在' });
      if (typeof key !== 'string' || !key.trim()) return sendJson(res, 400, { error: '请先填写 API Key' });
      store.retry(match[1]); resumeProcessing(match[1], key.trim());
      return sendJson(res, 202, { ok: true });
    } catch { return sendJson(res, 400, { error: '请求无效' }); }
  }
  if (match && match[2] === 'graph' && req.method === 'GET') {
    const graph = store.graph(match[1]);
    return graph ? sendJson(res, 200, { ...graph, processingAvailable: keys.has(match[1]) })
      : sendJson(res, 404, { error: '收听记录不存在' });
  }
  if (match && match[2] === 'graph' && req.method === 'DELETE') {
    if (!store.hasListening(match[1])) return sendJson(res, 404, { error: '收听记录不存在' });
    // Persist the cancellation fence before aborting the network operation so a
    // simultaneous or late paid response can never resurrect cancelled work.
    store.cancelRelations(match[1], { reason: 'USER_CANCELLED' });
    relationScheduler.cancel(match[1]);
    publishProcessing(match[1]);
    maybeReleaseKey(match[1]);
    return sendJson(res, 200, { ok: true, ...store.graphMetadata(match[1]), processingAvailable: keys.has(match[1]) });
  }
  if (match && match[2] === 'graph' && req.method === 'POST') {
    try {
      const input = await readJson(req);
      if (!store.hasListening(match[1])) return sendJson(res, 404, { error: '收听记录不存在' });
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['key', 'retry', 'expectedEpoch'].includes(k)) ||
          (input.retry !== undefined && input.retry !== 'failed_partial') ||
          (input.retry === 'failed_partial' ? !Number.isInteger(input.expectedEpoch) || input.expectedEpoch < 0 : input.expectedEpoch !== undefined)) {
        return sendJson(res, 400, { error: '关系生成请求无效' });
      }
      const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : keys.get(match[1]);
      if (!key) return sendJson(res, 400, { error: '请先在连接设置填写 API Key' });
      if (input.retry === 'failed_partial') store.retryProblemRelations(match[1], { expectedEpoch: input.expectedEpoch });
      else store.enableRelations(match[1], { retry: true });
      keys.set(match[1], key);
      // A restored pending extraction already has authorization for this record;
      // resume its scheduler so graph admission does not wait on dormant work.
      knowledgeScheduler.pump();
      relationScheduler.schedule(match[1], true);
      publishProcessing(match[1]);
      return sendJson(res, 202, { ok: true, ...store.graphMetadata(match[1]), processingAvailable: true });
    } catch (error) {
      return error?.code === 'RETRY_STATE_CHANGED'
        ? sendJson(res, 409, { error: '整理状态已改变，请刷新后再重试', code: 'RETRY_STATE_CHANGED' })
        : sendJson(res, 400, { error: '关系生成请求无效' });
    }
  }
  if (match && match[2] === 'export' && req.method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (kind !== 'original' && kind !== 'translation') return sendJson(res, 400, { error: '下载参数无效，仅支持原文或译文' });
    const result = store.exportText(match[1], kind);
    if (!result) return sendJson(res, 404, { error: '收听记录不存在' });
    if (!result.hasBody) return sendJson(res, 409, { error: kind === 'original' ? '尚无原文可下载' : '尚无完成翻译的句子可下载' });
    const label = kind === 'original' ? '原文' : '译文';
    const safeTitle = Array.from(result.title.toWellFormed().replace(/[\\/:*?"<>|\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')).slice(0, 80).join('') || '收听记录';
    const filename = `${safeTitle}-${label}.txt`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="transcript-${kind}.txt"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` });
    return res.end(result.text);
  }
  if (match && match[2] === 'segments' && req.method === 'GET') {
    const uuidPattern = /^[0-9a-f-]{36}$/;
    const p = url.searchParams;
    const intParam = name => { const raw = p.get(name); if (raw == null) return null; const value = Number(raw); return Number.isInteger(value) ? value : NaN; };
    const query = {};
    const runId = p.get('runId');
    if (runId != null) {
      if (!uuidPattern.test(runId)) return sendJson(res, 400, { error: 'runId 无效' });
      query.runId = runId;
    }
    const idsRaw = p.get('ids');
    const latest = intParam('latest');
    const after = intParam('afterSequence');
    const before = intParam('beforeSequence');
    const limit = intParam('limit') ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return sendJson(res, 400, { error: 'limit 需为 1-200 的整数' });
    if (idsRaw != null) {
      const ids = idsRaw.split(',').map(id => id.trim()).filter(Boolean);
      if (!ids.length || ids.length > 50 || ids.some(id => !uuidPattern.test(id))) return sendJson(res, 400, { error: 'ids 需为 1-50 个 UUID，用英文逗号分隔' });
      query.ids = [...new Set(ids)];
    } else if (latest != null) {
      if (!Number.isInteger(latest) || latest < 1 || latest > 200) return sendJson(res, 400, { error: 'latest 需为 1-200 的整数' });
      query.latest = latest;
    } else if (after != null) {
      if (!Number.isInteger(after) || after < 0) return sendJson(res, 400, { error: 'afterSequence 需为非负整数' });
      query.afterSequence = after; query.limit = limit;
    } else if (before != null) {
      if (!Number.isInteger(before) || before < 1) return sendJson(res, 400, { error: 'beforeSequence 需为正整数' });
      query.beforeSequence = before; query.limit = limit;
    } else query.latest = 50;
    const result = store.segmentsQuery(match[1], query);
    if (result == null) return sendJson(res, 404, { error: '收听记录不存在' });
    if (result === 'missing-run') return sendJson(res, 404, { error: '收听片段不存在' });
    return sendJson(res, 200, result);
  }
  if (req.method !== 'GET' || !types[url.pathname]) return sendJson(res, 404, { error: '未找到页面' });
  try {
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const content = await readFile(path.join(root, 'public', filename));
    res.writeHead(200, { 'Content-Type': types[url.pathname], 'Cache-Control': 'no-store' }); res.end(content);
  } catch { sendJson(res, 404, { error: '未找到页面' }); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const speechWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
speechWss.on('connection', speech.accept);
server.on('upgrade', (req, socket, head) => {
  if (!['/ws', '/ws/tts'].includes(req.url) || !sameOrigin(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const target = req.url === '/ws/tts' ? speechWss : wss;
  target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws));
});
wss.on('connection', client => {
  let upstream, taskId, run, listeningId, key, settings;
  let started = false, stopping = false, finished = false;
  const receivedAt = performance.now();
  let receivedSamples = 0;
  let recognitionTrace;
  const send = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); };
  const fail = message => { recognitionTrace?.fail(Object.assign(new Error('Recognition failed'), { code: 'ASR_FAILED' })); send({ type: 'error', message }); upstream?.close(); client.close(); };
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      if (started && !stopping && upstream?.readyState === WebSocket.OPEN) { receivedSamples += data.length / 2; upstream.send(data, { binary: true }); }
      return;
    }
    let message; try { message = JSON.parse(data.toString()); } catch { fail('消息格式无效'); return; }
    if (message.type === 'stop') {
      stopping = true;
      if (started && upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} }
      }));
      else { upstream?.close(); client.close(); }
      return;
    }
    if (message.type !== 'start' || upstream) return;
    const { source = 'en', targetLang = 'Chinese', audioSource = 'microphone', captionMode = 'realtime' } = message;
    if (typeof message.key !== 'string' || !message.key.trim() || !sources.includes(source) || !targets.includes(targetLang) ||
        !audioSources.includes(audioSource) || !captionModes.includes(captionMode) ||
        (message.listeningId != null && !/^[0-9a-f-]{36}$/.test(message.listeningId))) {
      fail('请检查 API Key 和收听设置'); return;
    }
    key = message.key.trim(); listeningId = message.listeningId || null;
    settings = { source, targetLang, audioSource, captionMode };
    let segmentationFallback = false;
    const openUpstream = withSegmentation => {
      const ws = new WebSocket(asrEndpoint, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 12000 });
      upstream = ws;
      ws.on('open', () => {
        const parameters = { format: 'pcm', sample_rate: 16000, heartbeat: true };
        if (source !== 'auto') parameters.language_hints = [source];
        if (withSegmentation) {
          parameters.semantic_punctuation_enabled = false;
          parameters.max_sentence_silence = asrSentenceSilenceMs;
          parameters.multi_threshold_mode_enabled = true;
        }
        taskId = randomUUID();
        ws.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input: {} } }));
      });
      ws.on('message', raw => {
        if (ws !== upstream) return;
        let event; try { event = JSON.parse(raw.toString()); } catch { return; }
        const kind = event.header?.event;
        if (kind === 'task-started' && !started) {
          if (client.readyState !== WebSocket.OPEN || stopping) { ws.close(); return; }
          try {
            const title = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
            run = store.createRun(listeningId, settings, title); listeningId = run.listeningId;
            recognitionTrace = taskRuntime.open('recognition.session', { listening_id: listeningId, job_id: run.runId, run_id: run.runId });
            subscribe(listeningId, client); resumeProcessing(listeningId, key);
            started = true; send({ type: 'listening-ready', ...run, captionMode });
          } catch (error) { fail(errorMessage(error)); }
        }
        if (kind === 'result-generated' && started) {
          const sentence = event.payload?.output?.sentence;
          if (!sentence || sentence.heartbeat || typeof sentence.text !== 'string' || !sentence.text.trim()) return;
          const correctedText = store.correctKnowledgeText(listeningId, sentence.text);
          console.info('asr_stage', JSON.stringify({ runId: run.runId, final: Boolean(sentence.sentence_end), receivedAudioMs: receivedSamples / 16, connectionElapsedMs: performance.now() - receivedAt, sourceBeginMs: sentence.begin_time, sourceEndMs: sentence.end_time }));
          if (!sentence.sentence_end) {
            send({ type: 'sentence', runId: run.runId, id: sentence.sentence_id, text: correctedText, final: false });
            speech.observe(listeningId, run.runId, sentence.sentence_id, correctedText); return;
          }
          if (sentence.sentence_id == null) return;
          try {
            const { segment, inserted } = store.addSegment(listeningId, run.runId, {
              id: sentence.sentence_id, text: sentence.text, beginMs: sentence.begin_time, endMs: sentence.end_time
            });
            if (!inserted && segment.original_text !== correctedText) {
              console.warn('asr_final_conflict', JSON.stringify({ runId: run.runId, sentenceId: sentence.sentence_id }));
              send({ type: 'caption-correction', runId: run.runId, message: '识别服务返回冲突定稿，已停止播报；文字记录保留首次定稿，请核对原文' });
              speech.correct(listeningId, run.runId);
            }
            if (inserted) {
              recognitionTrace?.context.event('source_committed', { segment_id: segment.id, segment_sequence: segment.sequence_no });
              speech.final(listeningId, run.runId, segment);
              const passthrough = isSameLanguage(source, targetLang); // 同语言：原文直通写入为最终译文，不进翻译队列
              const finalSegment = passthrough ? passthroughTranslation(segment, listeningId, 'realtime') : segment;
              send({ type: 'segment-final', runId: run.runId, segment: finalSegment });
              speech.notify(listeningId);
              if (!passthrough) queueTranslation(segment, listeningId, targetLang, 'realtime');
              knowledgeScheduler.schedule(listeningId);
            }
          } catch (error) { fail(`保存原文失败：${errorMessage(error)}`); }
        }
        if (kind === 'task-failed') {
          const reason = event.payload?.message || event.header?.error_message || '识别任务失败';
          if (!started && withSegmentation && !segmentationFallback && !stopping) {
            segmentationFallback = true;
            console.warn('asr_param_fallback', String(reason).slice(0, 200));
            ws.close(); openUpstream(false);
            return;
          }
          fail(reason);
        }
        if (kind === 'task-finished') {
          recognitionTrace?.succeed();
          finished = true; store.finishRun(run?.runId); knowledgeScheduler.schedule(listeningId, true);
          speech.notify(listeningId);
          send({ type: 'finished' }); ws.close(); client.close();
        }
      });
      ws.on('unexpected-response', (_request, response) => { if (ws === upstream) fail(`识别服务连接失败 (${response.statusCode})，请检查 API Key`); });
      ws.on('error', error => { if (ws === upstream) fail(errorMessage(error)); });
      ws.on('close', () => {
        if (ws !== upstream) return;
        if (!stopping && client.readyState === WebSocket.OPEN) send({ type: 'error', message: '识别连接已断开，请重试' });
        if (client.readyState === WebSocket.OPEN) client.close();
      });
    };
    openUpstream(captionMode === 'realtime');
  });
  client.on('close', () => {
    recognitionTrace?.cancel('consumer_closed');
    unsubscribe(listeningId, client);
    if (run && !finished) { store.finishRun(run.runId, true); knowledgeScheduler.schedule(listeningId, true); }
    speech.notify(listeningId);
    upstream?.close();
    maybeReleaseKey(listeningId);
  });
});

server.listen(port, host, () => console.log(`同声翻译已启动：http://${host}:${server.address().port}`));
