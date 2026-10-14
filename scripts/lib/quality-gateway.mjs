// Evaluation-only forwarding boundary. Never imported by the application.
// Reservations are pessimistic and irrevocable: this module never refunds them.
import http from 'node:http';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';

const terminal = new Set(['succeeded', 'failed', 'denied', 'cancelled']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const boundedInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fault = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
const numericUsage = value => {
  if (!object(value)) return undefined;
  const result = {};
  for (const name of ['duration', 'audio_duration', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isFinite(value[name]) && value[name] >= 0) result[name] = value[name];
  }
  return Object.keys(result).length ? result : undefined;
};
function endpoint(value, kind, mode) {
  let url;
  try { url = new URL(value); } catch { throw fault('INVALID_UPSTREAM_ENDPOINT'); }
  if (url.username || url.password || url.hash || url.search) throw fault('INVALID_UPSTREAM_ENDPOINT');
  const secure = kind === 'asr' ? 'wss:' : 'https:';
  const local = kind === 'asr' ? 'ws:' : 'http:';
  if (mode === 'live' ? url.protocol !== secure :
    !['127.0.0.1', '[::1]'].includes(url.hostname) || ![local, secure].includes(url.protocol)) throw fault('UPSTREAM_SCOPE_DENIED');
  return url.href;
}
function validateExpected(value) {
  if (!object(value)) throw fault('EXPECTED_CONFIG_REQUIRED');
  const result = clone(value);
  for (const name of ['asrModel', 'mtModel']) {
    if (typeof result[name] !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(result[name])) throw fault('INVALID_MODEL');
  }
  if (!boundedInt(result.maxAudioBytes, 2, 32 * 1024 * 1024) || result.maxAudioBytes % 2) throw fault('INVALID_AUDIO_LIMIT');
  result.maxConnectionMs ??= 30000;
  result.maxMtInputBytes ??= 256 * 1024;
  result.maxResponseBytes ??= 1024 * 1024;
  if (!boundedInt(result.maxConnectionMs, 1, 120000) || !boundedInt(result.maxMtInputBytes, 1, 1024 * 1024) ||
    !boundedInt(result.maxResponseBytes, 256, 8 * 1024 * 1024)) throw fault('INVALID_GATEWAY_LIMIT');
  if (typeof result.mtTarget !== 'string' || !/^[\p{L} -]{1,64}$/u.test(result.mtTarget)) throw fault('INVALID_MT_TARGET');
  result.asrParameters = Array.isArray(result.asrParameters) ? result.asrParameters : [result.asrParameters];
  if (!result.asrParameters.length || result.asrParameters.length > 4) throw fault('INVALID_ASR_PARAMETERS');
  const allowed = new Set(['format', 'sample_rate', 'heartbeat', 'language_hints', 'semantic_punctuation_enabled',
    'max_sentence_silence', 'multi_threshold_mode_enabled']);
  for (const parameters of result.asrParameters) {
    if (!object(parameters) || Object.keys(parameters).some(key => !allowed.has(key)) || parameters.format !== 'pcm' ||
      parameters.sample_rate !== 16000 || ['heartbeat', 'semantic_punctuation_enabled', 'multi_threshold_mode_enabled']
        .some(key => key in parameters && typeof parameters[key] !== 'boolean') ||
      ('max_sentence_silence' in parameters && !boundedInt(parameters.max_sentence_silence, 1, 120000)) ||
      ('language_hints' in parameters && (!Array.isArray(parameters.language_hints) || parameters.language_hints.length !== 1 ||
        !/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(parameters.language_hints[0])))) throw fault('INVALID_ASR_PARAMETERS');
  }
  result.allowAsrTranslations ??= false;
  if (typeof result.allowAsrTranslations !== 'boolean') throw fault('INVALID_MT_INPUTS');
  result.mtInputs ??= [];
  if (!Array.isArray(result.mtInputs) || result.mtInputs.some(text => typeof text !== 'string' ||
    !text.trim() || Buffer.byteLength(text) > result.maxMtInputBytes)) throw fault('INVALID_MT_INPUTS');
  return result;
}
function validRun(message, expected) {
  return keysAre(message, ['header', 'payload']) && keysAre(message.header, ['action', 'task_id', 'streaming']) &&
    message.header.action === 'run-task' && typeof message.header.task_id === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.header.task_id) && message.header.streaming === 'duplex' &&
    keysAre(message.payload, ['task_group', 'task', 'function', 'model', 'parameters', 'input']) &&
    message.payload.task_group === 'audio' && message.payload.task === 'asr' && message.payload.function === 'recognition' &&
    message.payload.model === expected.asrModel && keysAre(message.payload.input, []) &&
    expected.asrParameters.some(parameters => isDeepStrictEqual(parameters, message.payload.parameters));
}
function validFinish(message, taskId) {
  return keysAre(message, ['header', 'payload']) && keysAre(message.header, ['action', 'task_id', 'streaming']) &&
    message.header.action === 'finish-task' && message.header.task_id === taskId && message.header.streaming === 'duplex' &&
    keysAre(message.payload, ['input']) && keysAre(message.payload.input, []);
}
function validTranslation(body, expected, inputs) {
  return keysAre(body, ['model', 'messages', 'translation_options']) && body.model === expected.mtModel &&
    Array.isArray(body.messages) && body.messages.length === 1 && keysAre(body.messages[0], ['role', 'content']) &&
    body.messages[0].role === 'user' && typeof body.messages[0].content === 'string' && inputs.has(body.messages[0].content) &&
    Buffer.byteLength(body.messages[0].content) <= expected.maxMtInputBytes &&
    keysAre(body.translation_options, ['source_lang', 'target_lang']) && body.translation_options.source_lang === 'auto' &&
    body.translation_options.target_lang === expected.mtTarget;
}
async function readBody(stream, limit, limitCode = 'BODY_LIMIT') {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fault(limitCode);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * reserve(request) must persist a worst-case reservation before resolving to a
 * nonempty string ID (or {attemptId}). Every new ASR connection reserves again.
 * observe receives best-effort detached snapshots; observations retains records.
 * Only mtInputs authorizes MT text unless allowAsrTranslations is explicitly true.
 * Output byte caps do not cap provider-generated/billed tokens. The caller must
 * reserve against a validated provider worst-case generation bound.
 * liveAuthorized is a caller attestation, never an authorization discovery API.
 */
export async function createQualityGateway({ mode, upstream, expected: suppliedExpected, reserve, observe, signal, liveAuthorized = false }) {
  if (!['offline', 'live'].includes(mode) || (mode === 'live' && liveAuthorized !== true)) throw fault('LIVE_AUTHORIZATION_REQUIRED');
  if (!object(upstream) || typeof upstream.key !== 'string' || !upstream.key || /[\r\n]/.test(upstream.key)) throw fault('UPSTREAM_KEY_REQUIRED');
  if (typeof reserve !== 'function') throw fault('RESERVATION_REQUIRED');
  const expected = validateExpected(suppliedExpected);
  const urls = { asr: endpoint(upstream.asr, 'asr', mode), mt: endpoint(upstream.mt, 'mt', mode) };
  if (signal?.aborted) throw fault('GATEWAY_CANCELLED');
  const secrets = new Set([upstream.key]);
  const hasSecret = value => {
    if (typeof value === 'string') return [...secrets].some(secret => secret && value.includes(secret)) ||
      /authorization\s*[":=]|bearer\s+[a-z0-9._~-]+/i.test(value);
    if (Array.isArray(value)) return value.some(hasSecret);
    if (object(value)) return Object.entries(value).some(([name, item]) => /^authorization$/i.test(name) || hasSecret(name) || hasSecret(item));
    return false;
  };
  if (hasSecret(expected) || hasSecret(urls)) throw fault('CONFIG_CONTAINS_CREDENTIAL');
  const metadataString = (...values) => values.find(value => typeof value === 'string' && value.trim() &&
    value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && !hasSecret(value)) ?? null;
  const inputs = new Set(expected.mtInputs);
  const observations = [], clients = new Set(), upstreamSockets = new Set(), operations = new Set(), sockets = new Set();
  let closed = false, closing;
  const publish = row => {
    if (!observe) return;
    try { Promise.resolve(observe(clone(row))).catch(() => {}); } catch { /* Evidence remains available in observations. */ }
  };
  const record = (kind, config = {}) => {
    const row = { kind, mode, evidenceKind: mode === 'offline' ? 'offline-provider-stub' : 'live-provider',
      endpoint: urls[kind], model: expected[kind === 'asr' ? 'asrModel' : 'mtModel'],
      ...(kind === 'asr' ? { returnedModel: null, revision: null } : { responseModel: null }),
      responseId: null, requestId: null, config: clone(config), status: 'reserving', startedAt: new Date().toISOString() };
    observations.push(row); return row;
  };
  const update = (row, status, detail = {}) => {
    if (terminal.has(row.status)) return;
    Object.assign(row, detail, { status });
    if (terminal.has(status)) row.completedAt = new Date().toISOString();
    publish(row);
  };
  const reserveCall = async (row, bounds) => {
    publish(row);
    let result;
    try { result = await reserve({ kind: row.kind, model: row.model, config: clone(row.config), ...bounds }); }
    catch { throw fault('BUDGET_REJECTED'); }
    const id = typeof result === 'string' ? result : result?.attemptId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id) || hasSecret(id)) throw fault('BUDGET_REJECTED');
    // Cancellation does not undo a reservation that the caller persisted.
    row.attemptId = id;
    if (!terminal.has(row.status)) update(row, 'reserved'); else publish(row);
  };
  const rememberClientToken = request => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) secrets.add(token);
  };
  const respond = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (closed || req.method !== 'POST' || req.url !== '/mt') { respond(res, 403, { error: { message: 'GATEWAY_SCOPE_DENIED' } }); return; }
    rememberClientToken(req);
    const controller = new AbortController();
    const op = { controller }; operations.add(op);
    let row, finished = false;
    const abort = code => {
      if (finished) return;
      clearTimeout(timer);
      controller.abort(fault(code));
      if (!req.complete) res.once('finish', () => req.destroy());
      if (row) update(row, code === 'GATEWAY_TIMEOUT' ? 'failed' : 'cancelled', { code });
      respond(res, code === 'GATEWAY_TIMEOUT' ? 504 : 499, { error: { message: code } });
    };
    op.abort = abort;
    const timer = setTimeout(() => abort('GATEWAY_TIMEOUT'), expected.maxConnectionMs);
    const cancelled = () => { if (!res.writableEnded) abort('CLIENT_CANCELLED'); };
    res.on('close', cancelled);
    try {
      const raw = await readBody(req, expected.maxMtInputBytes + 4096);
      if (controller.signal.aborted || closed) return;
      let body; try { body = JSON.parse(raw); } catch { throw fault('MT_REQUEST_DENIED'); }
      if (hasSecret(raw) || hasSecret(body) || !validTranslation(body, expected, inputs)) throw fault('MT_REQUEST_DENIED');
      row = record('mt', { translation_options: body.translation_options });
      row.input = body.messages[0].content;
      await reserveCall(row, { inputBytes: Buffer.byteLength(row.input), maxConnectionMs: expected.maxConnectionMs,
        maxResponseBytes: expected.maxResponseBytes });
      if (controller.signal.aborted || closed) return;
      row.upstreamStartedAt = new Date().toISOString();
      update(row, 'running');
      const response = await fetch(urls.mt, { method: 'POST', headers: { Authorization: `Bearer ${upstream.key}`, 'Content-Type': 'application/json' },
        body: raw, signal: controller.signal, redirect: 'error' });
      row.httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); throw fault('MT_UPSTREAM_FAILED'); }
      const responseRaw = await readBody(response.body, expected.maxResponseBytes, 'MT_RESPONSE_LIMIT');
      if (hasSecret(responseRaw)) throw fault('UPSTREAM_CREDENTIAL_ECHO');
      let result; try { result = JSON.parse(responseRaw); } catch { throw fault('MT_RESPONSE_INVALID'); }
      if (hasSecret(result)) throw fault('UPSTREAM_CREDENTIAL_ECHO');
      const output = result.choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !output.trim()) throw fault('MT_RESPONSE_INVALID');
      const usage = numericUsage(result.usage);
      update(row, 'succeeded', { output, ...(usage && { usage }), responseModel: metadataString(result.model),
        responseId: metadataString(result.id, result.response_id), requestId: metadataString(result.request_id) });
      respond(res, 200, { choices: [{ message: { content: output } }], ...(usage && { usage }) });
    } catch (error) {
      if (!row) row = record('mt');
      const known = new Set(['MT_REQUEST_DENIED', 'BODY_LIMIT', 'BUDGET_REJECTED', 'MT_UPSTREAM_FAILED', 'MT_RESPONSE_INVALID', 'MT_RESPONSE_LIMIT', 'UPSTREAM_CREDENTIAL_ECHO']);
      const code = known.has(error.code) ? error.code : controller.signal.aborted ? 'GATEWAY_CANCELLED' : 'MT_UPSTREAM_FAILED';
      const denied = ['MT_REQUEST_DENIED', 'BODY_LIMIT', 'BUDGET_REJECTED'].includes(code);
      update(row, denied ? 'denied' : controller.signal.aborted ? 'cancelled' : 'failed', { code });
      respond(res, denied ? 403 : 502, { error: { message: code } });
    } finally {
      finished = true; clearTimeout(timer); res.removeListener('close', cancelled); operations.delete(op);
      controller.abort();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (closed || req.url !== '/asr') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    rememberClientToken(req);
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', client => {
    clients.add(client);
    let row, provider, taskId, phase = 'idle', finished = false, responseBytes = 0;
    const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const dispose = () => {
      clearTimeout(timer); operations.delete(op);
      if (provider && provider.readyState !== WebSocket.CLOSED) provider.terminate();
      if (client.readyState === WebSocket.OPEN) client.close();
      // A peer cannot hold cleanup open by declining a WebSocket close handshake.
      const reap = setTimeout(() => client.terminate(), 100); reap.unref();
    };
    const end = (status, code) => {
      if (finished) return; finished = true;
      if (!row) row = record('asr');
      update(row, status, code ? { code } : {});
      if (code) send({ header: { event: 'task-failed', ...(taskId && { task_id: taskId }), error_message: code } });
      dispose();
    };
    const op = { abort: code => end(code === 'GATEWAY_TIMEOUT' ? 'failed' : 'cancelled', code) };
    operations.add(op);
    const timer = setTimeout(() => end('failed', 'GATEWAY_TIMEOUT'), expected.maxConnectionMs);
    client.on('error', () => end('failed', 'ASR_CLIENT_ERROR'));
    client.on('close', () => { clients.delete(client); end('cancelled', 'CLIENT_CANCELLED'); });
    client.on('message', async (raw, binary) => {
      if (finished) return;
      try {
        if (binary) {
          if (phase !== 'streaming' || !row || provider?.readyState !== WebSocket.OPEN || !raw.length || raw.length % 2 ||
            row.audioBytes + raw.length > expected.maxAudioBytes) throw fault('ASR_AUDIO_DENIED');
          row.audioBytes += raw.length;
          provider.send(raw, { binary: true }); return;
        }
        if (hasSecret(raw.toString())) throw fault('ASR_REQUEST_DENIED');
        let message; try { message = JSON.parse(raw.toString()); } catch { throw fault('ASR_REQUEST_DENIED'); }
        if (hasSecret(message)) throw fault('ASR_REQUEST_DENIED');
        if (phase !== 'idle') {
          if (phase !== 'streaming' || !validFinish(message, taskId)) throw fault('ASR_REQUEST_DENIED');
          phase = 'finishing'; provider.send(JSON.stringify(message)); return;
        }
        if (!validRun(message, expected)) throw fault('ASR_REQUEST_DENIED');
        phase = 'reserving'; taskId = message.header.task_id;
        row = record('asr', { parameters: message.payload.parameters }); row.audioBytes = 0; row.outputs = [];
        await reserveCall(row, { maxAudioBytes: expected.maxAudioBytes, maxConnectionMs: expected.maxConnectionMs });
        if (finished || closed) return;
        row.upstreamStartedAt = new Date().toISOString();
        provider = new WebSocket(urls.asr, { headers: { Authorization: `Bearer ${upstream.key}` },
          handshakeTimeout: expected.maxConnectionMs, maxPayload: expected.maxResponseBytes, followRedirects: false, perMessageDeflate: false });
        upstreamSockets.add(provider); phase = 'connecting';
        provider.on('open', () => { if (finished) return provider.terminate(); provider.send(JSON.stringify(message)); });
        provider.on('error', () => end('failed', 'ASR_UPSTREAM_FAILED'));
        provider.on('unexpected-response', (_req, response) => { response.destroy(); end('failed', 'ASR_UPSTREAM_FAILED'); });
        provider.on('close', () => { upstreamSockets.delete(provider); if (!finished) end('failed', 'ASR_UPSTREAM_CLOSED'); });
        provider.on('message', (data, isBinary) => {
          if (finished) return;
          try {
            responseBytes += data.length;
            if (isBinary || responseBytes > expected.maxResponseBytes) throw fault('ASR_RESPONSE_INVALID');
            const text = data.toString(); if (hasSecret(text)) throw fault('UPSTREAM_CREDENTIAL_ECHO');
            const event = JSON.parse(text), kind = event.header?.event;
            if (hasSecret(event)) throw fault('UPSTREAM_CREDENTIAL_ECHO');
            if (event.header?.task_id != null && event.header.task_id !== taskId) throw fault('ASR_RESPONSE_INVALID');
            const header = { event: kind, task_id: taskId };
            if (['task-started', 'result-generated', 'task-finished'].includes(kind)) {
              const fields = {
                returnedModel: metadataString(event.model, event.header?.model, event.payload?.model, event.payload?.output?.model),
                revision: metadataString(event.revision, event.model_revision, event.model_version, event.header?.revision,
                  event.payload?.revision, event.payload?.model_revision, event.payload?.model_version),
                requestId: metadataString(event.request_id, event.header?.request_id, event.payload?.request_id),
                responseId: metadataString(event.id, event.response_id, event.header?.response_id, event.payload?.response_id)
              };
              for (const [name, value] of Object.entries(fields)) if (value !== null) row[name] = value;
            }
            const usage = numericUsage(event.payload?.usage || event.usage);
            if (usage) row.usage = usage;
            if (kind === 'task-started') {
              if (phase !== 'connecting') throw fault('ASR_RESPONSE_INVALID');
              phase = 'streaming'; update(row, 'running'); send({ header });
            } else if (kind === 'result-generated') {
              if (!['streaming', 'finishing'].includes(phase)) throw fault('ASR_RESPONSE_INVALID');
              const sentence = event.payload?.output?.sentence;
              if (!object(sentence) || (typeof sentence.text !== 'string' && !sentence.heartbeat)) throw fault('ASR_RESPONSE_INVALID');
              const safe = {};
              for (const name of ['text', 'sentence_id', 'sentence_end', 'begin_time', 'end_time', 'heartbeat']) {
                if (['string', 'number', 'boolean'].includes(typeof sentence[name])) safe[name] = sentence[name];
              }
              if (safe.text?.trim() && !safe.heartbeat) {
                row.outputs.push(safe);
                if (expected.allowAsrTranslations && Buffer.byteLength(safe.text) <= expected.maxMtInputBytes) inputs.add(safe.text);
              }
              publish(row); send({ header, payload: { output: { sentence: safe }, ...(usage && { usage }) } });
            } else if (kind === 'task-finished') {
              if (phase !== 'finishing') throw fault('ASR_RESPONSE_INVALID');
              send({ header, ...(usage && { payload: { usage } }) }); end('succeeded');
            } else if (kind === 'task-failed') end('failed', 'ASR_UPSTREAM_FAILED');
            else throw fault('ASR_RESPONSE_INVALID');
          } catch (error) { end('failed', error.code === 'UPSTREAM_CREDENTIAL_ECHO' ? error.code : 'ASR_RESPONSE_INVALID'); }
        });
      } catch (error) {
        const known = new Set(['ASR_REQUEST_DENIED', 'ASR_AUDIO_DENIED', 'BUDGET_REJECTED']);
        end(known.has(error.code) ? 'denied' : 'failed', known.has(error.code) ? error.code : 'ASR_UPSTREAM_FAILED');
      }
    });
  });
  const abort = () => { void close(); };
  async function close() {
    if (closing) return closing;
    closed = true; signal?.removeEventListener('abort', abort);
    for (const op of operations) op.abort('GATEWAY_CANCELLED');
    for (const ws of clients) ws.terminate();
    for (const ws of upstreamSockets) ws.terminate();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    closing = Promise.all([new Promise(resolve => wss.close(() => resolve())),
      new Promise(resolve => server.close(() => resolve()))]);
    return closing;
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { await close(); throw fault('GATEWAY_CANCELLED'); }
  const port = server.address().port;
  return { asrEndpoint: `ws://127.0.0.1:${port}/asr`, mtEndpoint: `http://127.0.0.1:${port}/mt`, observations, close };
}
