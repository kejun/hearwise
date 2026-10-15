// Evaluation transport only. The CLI remains fail-closed until a domain-specific
// frozen plan, durable budget, paired collector and independent reader are wired.
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { closeServer } from '../../test-support/lifecycle.mjs';
const ownFaults = new WeakSet();
const fail = code => { const error = Object.assign(new Error(code), { code }); ownFaults.add(error); return error; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const hash = value => createHash('sha256').update(value).digest('hex');
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(fail('CANCELLED_OR_TIMED_OUT')); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}
async function bodyBytes(stream, maximum) {
  const chunks = []; let size = 0;
  for await (const bytes of stream) {
    size += bytes.length;
    if (size > maximum) throw fail('BODY_LIMIT');
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
/**
 * authorize must bind the exact wire request to the active production SQLite
 * reservation/frozen corpus and model configuration. reserve must durably charge
 * its verified worst-case billing bound before returning a unique attempt ID.
 * Neither callback is an authorization-discovery API. No refunds or retries.
 * Byte/time caps limit this transport, NOT provider-generated or billed tokens.
 */
export async function createSemanticGateway({ mode, upstream, expected, authorize, reserve, signal, liveAuthorized = false }) {
  if (!['offline', 'live'].includes(mode) || (mode === 'live' && (liveAuthorized !== true || process.env.CI))) throw fail('LIVE_AUTHORIZATION_REQUIRED');
  if (!object(upstream) || typeof upstream.key !== 'string' || upstream.key.length < 8 || upstream.key.length > 4096 || !/^[a-zA-Z0-9._~+/-]+=*$/.test(upstream.key)) throw fail('UPSTREAM_KEY_REQUIRED');
  let url; try { url = new URL(upstream.endpoint); } catch { throw fail('UPSTREAM_SCOPE_DENIED'); }
  if (url.username || url.password || url.hash || url.search || (mode === 'live' ? url.protocol !== 'https:' :
    url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname))) throw fail('UPSTREAM_SCOPE_DENIED');
  if (typeof authorize !== 'function' || typeof reserve !== 'function') throw fail('AUTHORIZATION_AND_RESERVATION_REQUIRED');
  const config = structuredClone(expected), key = upstream.key, token = randomUUID();
  if (!object(config) || !['knowledgeModel','relationModel'].every(name => typeof config[name] === 'string' && /^[\w.:-]{1,120}$/.test(config[name])) ||
    !integer(config.maxRequests, 1, 1000) || !integer(config.maxRequestBytes, 256, 2 * 1024 * 1024) ||
    !integer(config.maxResponseBytes, 256, 8 * 1024 * 1024) || !integer(config.timeoutMs, 1, 120000) ||
    !Number.isFinite(Date.parse(config.expiresAt))) throw fail('INVALID_GATEWAY_LIMITS');
  const secret = text => {
    if (typeof text !== 'string') return false;
    // Inspect decoded JSON strings as well as raw wire bytes. Conservative
    // repeated unescaping also covers nested model JSON content, without ever
    // storing a sanitized substitute as if it were the original response.
    for (let depth = 0; depth < 8; depth++) {
      if (text.includes(key) || text.includes(token) || /authorization\s*[":=]|bearer\s+[a-z0-9._~-]+/i.test(text)) return true;
      const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/');
      if (decoded === text) return false;
      text = decoded;
    }
    // Excessively nested escaping is not necessary for this model protocol.
    return true;
  };
  if (secret(url.href) || secret(JSON.stringify(config))) throw fail('CONFIG_CONTAINS_CREDENTIAL');
  const validTime = () => { if (Date.now() >= Date.parse(config.expiresAt)) throw fail('APPROVAL_EXPIRED'); };
  validTime(); signal?.throwIfAborted();
  const observations = [], operations = new Set(), attempts = new Set(), controllers = new Set();
  let closed = false, closePromise;
  const server = http.createServer((request, reply) => {
    const operation = handle(request, reply); operations.add(operation);
    operation.finally(() => operations.delete(operation));
  });
  async function handle(request, reply) {
    let row, timer;
    const controller = new AbortController(); controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const disconnected = () => { if (!reply.writableEnded) controller.abort(); };
    reply.once('close', disconnected);
    const send = (status, bytes, extraHeaders = {}) => { if (!reply.destroyed && !reply.writableEnded) { reply.writeHead(status, { 'content-type': 'application/json', ...extraHeaders }); reply.end(bytes); } };
    try {
      if (closed || combined.aborted) throw fail('GATEWAY_CLOSED');
      validTime();
      if (request.method !== 'POST' || !['/knowledge','/relation'].includes(request.url) || request.headers.authorization !== `Bearer ${token}`) throw fail('LOCAL_REQUEST_DENIED');
      if (observations.length >= config.maxRequests) throw fail('REQUEST_LIMIT');
      row = { mode, kind: request.url.slice(1), status: 'receiving', endpoint: url.href, startedAt: new Date().toISOString() };
      observations.push(row);
      timer = setTimeout(() => { controller.abort(); if (!request.complete) request.destroy(); }, config.timeoutMs);
      const wire = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await abortable(bodyBytes(request, config.maxRequestBytes), combined));
      if (secret(wire)) throw fail('REQUEST_CONTAINS_CREDENTIAL');
      let body; try { body = JSON.parse(wire); } catch { throw fail('INVALID_JSON'); }
      const keys = row.kind === 'knowledge' ? ['model','enable_thinking','messages'] : ['model','enable_thinking','temperature','max_completion_tokens','response_format','messages'];
      if (!object(body) || Object.keys(body).sort().join('|') !== keys.sort().join('|') || body.model !== config[`${row.kind}Model`] ||
        body.enable_thinking !== false || !Array.isArray(body.messages) || body.messages.length !== 2 ||
        !body.messages.every((message, index) => object(message) && Object.keys(message).sort().join('|') === 'content|role' &&
          message.role === (index ? 'user' : 'system') && typeof message.content === 'string' && message.content.length > 0) ||
        (row.kind === 'relation' && (body.temperature !== 0 || !integer(body.max_completion_tokens, 1, 1000000) ||
          !object(body.response_format) || JSON.stringify(body.response_format) !== '{"type":"json_object"}'))) throw fail('REQUEST_CONTRACT_DENIED');
      Object.assign(row, { requestWire: wire, requestSha256: hash(wire), requestBytes: Buffer.byteLength(wire), model: body.model, status: 'authorizing' });
      const context = { kind: row.kind, request: structuredClone(body), requestSha256: row.requestSha256, requestBytes: row.requestBytes };
      if (await abortable(Promise.resolve().then(() => authorize(structuredClone(context), combined)), combined) !== true) throw fail('REQUEST_NOT_AUTHORIZED');
      combined.throwIfAborted(); validTime(); row.status = 'reserving'; row.reservationStatus = 'pending';
      // Record late reservations too: cancellation never refunds ambiguous cost.
      const reservation = Promise.resolve().then(() => reserve(structuredClone(context), combined)).then(id => {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id) || secret(id) || attempts.has(id)) throw fail('INVALID_RESERVATION');
        attempts.add(id); row.reservationStatus = 'confirmed'; row.attemptId = id; row.reservedAt = new Date().toISOString(); return id;
      }).catch(error => { row.reservationStatus = 'rejected_or_unknown'; throw error; });
      await abortable(reservation, combined); combined.throwIfAborted(); validTime();
      row.status = 'forwarding'; row.forwardedAt = new Date().toISOString();
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: wire, redirect: 'manual', signal: combined });
      row.httpStatus = response.status;
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail('REDIRECT_DENIED'); }
      const bytes = response.body ? await abortable(bodyBytes(response.body, config.maxResponseBytes), combined) : Buffer.alloc(0);
      combined.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (secret(text)) throw fail('RESPONSE_CONTAINS_CREDENTIAL');
      row.responseBytes = bytes.length; row.responseSha256 = hash(bytes);
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const safeRetry = typeof retry === 'string' && retry.length <= 128 && !secret(retry) && (/^\d+(?:\.\d+)?$/.test(retry) || Number.isFinite(Date.parse(retry))) ? retry : null;
        row.status = 'failed'; row.code = 'PROVIDER_HTTP_ERROR'; row.retryAfter = safeRetry;
        send(response.status, '{}', safeRetry ? { 'retry-after': safeRetry } : {}); return;
      }
      // Preserve protocol-invalid content for production parsers and repair flow.
      row.responseWire = text; row.status = 'succeeded'; send(response.status, bytes);
    } catch (error) {
      if (row) { row.status = combined.aborted ? 'cancelled' : 'failed'; row.code = ownFaults.has(error) && !secret(error.code) ? error.code : 'SEMANTIC_TRANSPORT_FAILED'; }
      send(502, '{}');
    } finally {
      clearTimeout(timer); controller.abort(); controllers.delete(controller); reply.removeListener('close', disconnected);
      if (row) row.completedAt = new Date().toISOString();
    }
  }
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch { await closeServer(server, 'semantic gateway'); throw fail('GATEWAY_START_FAILED'); }
  const close = () => closePromise ||= (async () => {
    closed = true; for (const controller of controllers) controller.abort();
    await closeServer(server, 'semantic gateway'); await Promise.all(operations);
    signal?.removeEventListener('abort', onAbort);
  })();
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { await close(); throw fail('GATEWAY_CANCELLED'); }
  const base = `http://127.0.0.1:${server.address().port}`;
  return { knowledgeEndpoint: `${base}/knowledge`, relationEndpoint: `${base}/relation`, token, observations: () => structuredClone(observations), close };
}
