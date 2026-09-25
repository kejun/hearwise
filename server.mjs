import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { ListeningStore } from './storage.mjs';
import { extractKnowledge, splitFocusSegments } from './knowledge.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const store = new ListeningStore(process.env.LISTENING_DB || path.join(root, 'data', 'listenings.sqlite'));
const model = 'qwen-audio-3.0-asr-flash-streaming';
const asrEndpoint = process.env.ASR_ENDPOINT || 'wss://maas.qianwenaiapi.com/api-ws/v1/inference';
const mtEndpoint = process.env.MT_ENDPOINT || 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions';
const types = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
  '/audio-processor.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
const targets = ['Chinese', 'English', 'Japanese', 'Korean'];
const sources = ['auto', 'zh', 'en', 'ja', 'ko'];
const audioSources = ['microphone', 'tab'];
const keys = new Map();
const listeners = new Map();
const extractionTimers = new Map();
const translationQueue = [];
const translationQueued = new Set();
let translating = 0;
let interimTranslating = 0;
let extracting = false;
let extractingId = null;
let extractionDeferred = null;
const activeTranslations = new Map();
const modelErrorCounts = new Map();
const extractionWaitMs = Math.max(1000, Number(process.env.EXTRACTION_WAIT_MS || 15000));

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
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw new Error('请求内容过长');
  }
  return JSON.parse(body);
}
function broadcast(listeningId, data) {
  for (const ws of listeners.get(listeningId) || []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
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
  const kind = /429|rate limit|限流/i.test(message) ? 'rate_limit' : /timeout|超时/i.test(message) ? 'timeout' : 'other';
  const counter = `${modelName}:${kind}`;
  modelErrorCounts.set(counter, (modelErrorCounts.get(counter) || 0) + 1);
  console.warn('model_error', counter, modelErrorCounts.get(counter), message);
}

async function translate(key, text, target, timeout = 15000) {
  const response = await fetch(mtEndpoint, { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-mt-flash', messages: [{ role: 'user', content: text }],
      translation_options: { source_lang: 'auto', target_lang: target } }), signal: AbortSignal.timeout(timeout) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.message || `翻译服务 HTTP ${response.status}`);
  const output = result.choices?.[0]?.message?.content;
  if (typeof output !== 'string' || !output.trim()) throw new Error('翻译服务未返回文字');
  return output.trim();
}
async function checkTranslation(key) {
  try { await translate(key, 'Hello', 'Chinese', 12000); return { ok: true, message: '翻译模型可用' }; }
  catch (error) { return { ok: false, message: errorMessage(error) }; }
}
async function checkKnowledge(key) {
  try {
    const input = { listening_id: 'test', context_segments: [], focus_segments: [{ id: 'test-segment', text: 'Hello.' }], existing_candidates: [] };
    await extractKnowledge(key, input, mtEndpoint);
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
  if (!id || listeners.get(id)?.size || extractionTimers.has(id) || extractingId === id ||
      activeTranslations.get(id) || translationQueue.some(t => t.listeningId === id) || store.nextJob(id)) return;
  keys.delete(id);
}
function queueTranslation(segment, listeningId, target) {
  if (segment.translation_state === 'complete' || translationQueued.has(segment.id)) return;
  translationQueued.add(segment.id);
  translationQueue.push({ segment, listeningId, target, enqueuedAt: Date.now() });
  pumpTranslations();
}
function pumpTranslations() {
  while (translating < 2 && translationQueue.length) {
    const task = translationQueue.shift();
    const key = keys.get(task.listeningId);
    if (!key) { translationQueued.delete(task.segment.id); continue; }
    translating++;
    activeTranslations.set(task.listeningId, (activeTranslations.get(task.listeningId) || 0) + 1);
    (async () => {
      let updated;
      try {
        const text = await translate(key, task.segment.original_text, task.target);
        updated = store.setTranslation(task.segment.id, text, false);
        console.info('final_translation_ms', Date.now() - task.enqueuedAt);
      } catch (error) {
        updated = store.setTranslation(task.segment.id, null, true);
        logModelError('translation', error);
      } finally {
        if (updated) broadcast(task.listeningId, { type: 'translation-updated', segment: updated });
        translating--; translationQueued.delete(task.segment.id);
        activeTranslations.set(task.listeningId, activeTranslations.get(task.listeningId) - 1);
        if (!activeTranslations.get(task.listeningId)) activeTranslations.delete(task.listeningId);
        pumpTranslations(); pumpExtraction(); maybeReleaseKey(task.listeningId);
      }
    })();
  }
}
function scheduleExtraction(listeningId, force = false) {
  const rows = store.extractionRange(listeningId);
  if (!rows.length) return;
  if (rows.length >= 3 || force) {
    clearTimeout(extractionTimers.get(listeningId));
    extractionTimers.delete(listeningId);
    store.createExtractionJob(listeningId, rows);
    console.info('knowledge_queue_length', store.pendingJobCount());
    pumpExtraction();
    if (rows.length === 3 && store.extractionRange(listeningId).length) scheduleExtraction(listeningId);
    return;
  }
  if (!extractionTimers.has(listeningId)) extractionTimers.set(listeningId, setTimeout(() => {
    extractionTimers.delete(listeningId); scheduleExtraction(listeningId, true);
  }, 10000));
}
function pumpExtraction() {
  if (extracting) return;
  let job;
  for (const id of keys.keys()) { job = store.nextJob(id); if (job) break; }
  if (!job) return;
  if ((translationQueue.length || translating || interimTranslating) && Date.now() - Date.parse(job.created_at) < extractionWaitMs) {
    if (!extractionDeferred) extractionDeferred = setTimeout(() => { extractionDeferred = null; pumpExtraction(); }, 1000); return;
  }
  extracting = true; extractingId = job.listening_id;
  store.markJob(job.id, 'running');
  (async () => {
    const baseInput = store.jobInput(job);
    let error;
    try {
      for (const input of splitFocusSegments(baseInput)) {
        if (!store.hasListening(job.listening_id)) break;
        input.existing_candidates = store.jobInput(job).existing_candidates;
        let items;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { items = await extractKnowledge(keys.get(job.listening_id), input, mtEndpoint); break; }
          catch (caught) { error = caught; if (attempt === 0) continue; throw caught; }
        }
        if (!store.hasListening(job.listening_id)) break;
        const changed = store.applyKnowledge(job.listening_id, items);
        for (const item of changed) broadcast(job.listening_id, { type: 'knowledge-upserted', item });
      }
      store.markJob(job.id, 'complete');
    } catch (caught) {
      store.markJob(job.id, 'failed', errorMessage(caught));
      logModelError('knowledge', caught);
    } finally {
      broadcast(job.listening_id, { type: 'processing-updated' });
      extracting = false; extractingId = null; pumpExtraction(); maybeReleaseKey(job.listening_id);
    }
  })();
}
function resumeProcessing(id, key) {
  keys.set(id, key);
  for (const row of store.pendingTranslations(id)) queueTranslation(row, id, row.target_lang);
  scheduleExtraction(id, true);
  pumpExtraction();
  maybeReleaseKey(id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if ((req.method === 'POST' || req.method === 'DELETE') && !sameOrigin(req)) return sendJson(res, 403, { error: '仅允许同源请求' });
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
    try {
      const { key, text, target = 'Chinese' } = await readJson(req);
      if (typeof key !== 'string' || !key.trim() || typeof text !== 'string' || !text.trim() || text.length > 3000 || !targets.includes(target))
        return sendJson(res, 400, { error: '翻译参数无效' });
      if (translationQueue.length) return sendJson(res, 429, { error: '最终译文优先处理' });
      interimTranslating++;
      try { return sendJson(res, 200, { text: await translate(key.trim(), text.trim(), target) }); }
      finally { interimTranslating--; pumpExtraction(); }
    } catch (error) { return sendJson(res, 502, { error: errorMessage(error) }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/listenings') {
    const page = Math.max(1, Math.min(100000, Math.floor(Number(url.searchParams.get('page')) || 1)));
    return sendJson(res, 200, store.list(page));
  }
  const match = /^\/api\/listenings\/([0-9a-f-]{36})(?:\/(retry))?$/.exec(url.pathname);
  if (match && req.method === 'GET' && !match[2]) {
    const page = Math.max(1, Math.min(100000, Math.floor(Number(url.searchParams.get('page')) || 1)));
    const detail = store.detail(match[1], page);
    return detail ? sendJson(res, 200, { ...detail, processingAvailable: keys.has(match[1]) }) : sendJson(res, 404, { error: '收听记录不存在' });
  }
  if (match && req.method === 'DELETE' && !match[2]) {
    try {
      const result = store.removeListening(match[1]);
      if (result === 'missing') return sendJson(res, 404, { error: '收听记录不存在' });
      if (result === 'active') return sendJson(res, 409, { error: '请先停止这条收听，再删除记录' });
      clearTimeout(extractionTimers.get(match[1]));
      extractionTimers.delete(match[1]);
      for (let i = translationQueue.length - 1; i >= 0; i--) {
        if (translationQueue[i].listeningId !== match[1]) continue;
        translationQueued.delete(translationQueue[i].segment.id);
        translationQueue.splice(i, 1);
      }
      keys.delete(match[1]);
      pumpExtraction();
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
  if (req.method !== 'GET' || !types[url.pathname]) return sendJson(res, 404, { error: '未找到页面' });
  try {
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const content = await readFile(path.join(root, 'public', filename));
    res.writeHead(200, { 'Content-Type': types[url.pathname], 'Cache-Control': 'no-store' }); res.end(content);
  } catch { sendJson(res, 404, { error: '未找到页面' }); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !sameOrigin(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', client => {
  let upstream, taskId, run, listeningId, key, settings;
  let started = false, stopping = false, finished = false;
  const send = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); };
  const fail = message => { send({ type: 'error', message }); upstream?.close(); client.close(); };
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      if (started && !stopping && upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
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
    const { source = 'en', targetLang = 'Chinese', audioSource = 'microphone' } = message;
    if (typeof message.key !== 'string' || !message.key.trim() || !sources.includes(source) || !targets.includes(targetLang) ||
        !audioSources.includes(audioSource) || (message.listeningId != null && !/^[0-9a-f-]{36}$/.test(message.listeningId))) {
      fail('请检查 API Key 和收听设置'); return;
    }
    key = message.key.trim(); listeningId = message.listeningId || null;
    settings = { source, targetLang, audioSource };
    taskId = randomUUID();
    upstream = new WebSocket(asrEndpoint, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 12000 });
    upstream.on('open', () => {
      const parameters = { format: 'pcm', sample_rate: 16000, heartbeat: true };
      if (source !== 'auto') parameters.language_hints = [source];
      upstream.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input: {} } }));
    });
    upstream.on('message', raw => {
      let event; try { event = JSON.parse(raw.toString()); } catch { return; }
      const kind = event.header?.event;
      if (kind === 'task-started' && !started) {
        if (client.readyState !== WebSocket.OPEN || stopping) { upstream.close(); return; }
        try {
          const title = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
          run = store.createRun(listeningId, settings, title); listeningId = run.listeningId;
          subscribe(listeningId, client); resumeProcessing(listeningId, key);
          started = true; send({ type: 'listening-ready', ...run });
        } catch (error) { fail(errorMessage(error)); }
      }
      if (kind === 'result-generated' && started) {
        const sentence = event.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat || typeof sentence.text !== 'string' || !sentence.text.trim()) return;
        if (!sentence.sentence_end) { send({ type: 'sentence', id: sentence.sentence_id, text: sentence.text, final: false }); return; }
        if (sentence.sentence_id == null) return;
        try {
          const { segment, inserted } = store.addSegment(listeningId, run.runId, {
            id: sentence.sentence_id, text: sentence.text, beginMs: sentence.begin_time, endMs: sentence.end_time
          });
          if (inserted) {
            send({ type: 'segment-final', segment });
            queueTranslation(segment, listeningId, targetLang);
            scheduleExtraction(listeningId);
          }
        } catch (error) { fail(`保存原文失败：${errorMessage(error)}`); }
      }
      if (kind === 'task-failed') fail(event.payload?.message || event.header?.error_message || '识别任务失败');
      if (kind === 'task-finished') {
        finished = true; store.finishRun(run?.runId); scheduleExtraction(listeningId, true);
        send({ type: 'finished' }); upstream.close(); client.close();
      }
    });
    upstream.on('unexpected-response', (_request, response) => fail(`识别服务连接失败 (${response.statusCode})，请检查 API Key`));
    upstream.on('error', error => fail(errorMessage(error)));
    upstream.on('close', () => {
      if (!stopping && client.readyState === WebSocket.OPEN) send({ type: 'error', message: '识别连接已断开，请重试' });
      if (client.readyState === WebSocket.OPEN) client.close();
    });
  });
  client.on('close', () => {
    unsubscribe(listeningId, client);
    if (run && !finished) { store.finishRun(run.runId, true); scheduleExtraction(listeningId, true); }
    upstream?.close();
    maybeReleaseKey(listeningId);
  });
});

server.listen(port, host, () => console.log(`同声翻译已启动：http://${host}:${port}`));
