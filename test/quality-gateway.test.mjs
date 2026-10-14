import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { closeServer, deadline } from '../test-support/lifecycle.mjs';
import { createQualityGateway } from '../scripts/lib/quality-gateway.mjs';

const parameters = { format: 'pcm', sample_rate: 16000, heartbeat: true, language_hints: ['en'] };
const input = 'The appointment is at five.';
const key = 'synthetic-evaluation-key-never-real';
const expected = { asrModel: 'paraformer-realtime-v2', mtModel: 'qwen-mt-flash', maxAudioBytes: 8,
  asrParameters: parameters, mtTarget: 'Chinese', mtInputs: [input], maxConnectionMs: 2000 };
const run = (taskId = randomUUID(), override = {}) => ({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
  payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: expected.asrModel,
    parameters, input: {}, ...override } });
const finish = taskId => ({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } });
const translation = (text = input, override = {}) => ({ model: expected.mtModel, messages: [{ role: 'user', content: text }],
  translation_options: { source_lang: 'auto', target_lang: 'Chinese' }, ...override });
async function waitFor(predicate, label = 'gateway condition') {
  await deadline(async () => { while (!predicate()) await delay(10); }, 2500, label);
}
async function fixtures(t, options = {}) {
  const count = { asr: 0, mt: 0, audioBytes: 0, authorization: [] };
  const asr = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(asr, 'listening');
  asr.on('connection', (ws, req) => {
    count.asr++;
    count.authorization.push(req.headers.authorization);
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      if (binary) { count.audioBytes += raw.length; return; }
      const message = JSON.parse(raw.toString());
      if (options.asrMessage) return options.asrMessage(ws, message, count);
      const header = { task_id: message.header.task_id };
      if (message.header.action === 'run-task') ws.send(JSON.stringify({ header: { ...header, event: 'task-started' } }));
      if (message.header.action === 'finish-task') {
        ws.send(JSON.stringify({ header: { ...header, event: 'result-generated' }, payload: { output: { sentence:
          { sentence_id: 1, text: input, sentence_end: true, begin_time: 0, end_time: 1 } }, usage: { duration: 1 } } }));
        ws.send(JSON.stringify({ header: { ...header, event: 'task-finished' }, payload: { usage: { duration: 1 } } }));
      }
    });
  });
  const mt = http.createServer(async (req, res) => {
    count.mt++;
    count.authorization.push(req.headers.authorization);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (options.mtRequest) return options.mtRequest(req, res, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'qwen-mt-flash-fixture-revision', id: 'fixture-response-1', request_id: 'fixture-request-1',
      choices: [{ message: { content: '预约时间是五点。' } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
  });
  mt.listen(0, '127.0.0.1'); await once(mt, 'listening');
  const reserved = [], observed = [], clients = new Set();
  const gateway = await createQualityGateway({ mode: 'offline', upstream: {
    asr: `ws://127.0.0.1:${asr.address().port}`, mt: `http://127.0.0.1:${mt.address().port}`, key },
    expected: { ...expected, ...options.expected }, reserve: options.reserve || (async request => {
      reserved.push(request); return `attempt-${reserved.length}`;
    }), observe: value => { observed.push(value); options.observe?.(value); }, signal: options.signal });
  t.after(async () => {
    for (const client of clients) client.terminate();
    await gateway.close();
    await Promise.all([closeServer(asr, 'ASR stub'), closeServer(mt, 'MT stub')]);
  });
  const connect = async () => {
    const ws = new WebSocket(gateway.asrEndpoint); clients.add(ws);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    ws.on('error', () => {});
    await deadline(() => once(ws, 'open'), 2500, 'gateway WebSocket');
    return { ws, messages };
  };
  const post = body => fetch(gateway.mtEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { gateway, count, reserved, observed, connect, post };
}

test('offline gateway forwards approved ASR and MT, reserving each call and recording actual outputs', async t => {
  const f = await fixtures(t);
  const { ws, messages } = await f.connect();
  const command = run(); ws.send(JSON.stringify(command));
  await waitFor(() => messages.some(row => row.header.event === 'task-started'));
  ws.send(Buffer.from([0, 0, 1, 0])); ws.send(JSON.stringify(finish(command.header.task_id)));
  await waitFor(() => messages.some(row => row.header.event === 'task-finished'));
  const response = await f.post(translation());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '预约时间是五点。');
  assert.deepEqual(f.reserved.map(row => row.kind), ['asr', 'mt']);
  assert.equal(f.count.asr, 1); assert.equal(f.count.mt, 1); assert.equal(f.count.audioBytes, 4);
  assert.deepEqual(f.count.authorization, [`Bearer ${key}`, `Bearer ${key}`]);
  const asr = f.gateway.observations.find(row => row.kind === 'asr');
  const mt = f.gateway.observations.find(row => row.kind === 'mt');
  assert.equal(asr.status, 'succeeded'); assert.equal(asr.audioBytes, 4);
  assert.equal(asr.outputs[0].text, input); assert.deepEqual(asr.config.parameters, parameters);
  assert.equal(mt.status, 'succeeded'); assert.equal(mt.usage.total_tokens, 14);
  assert.equal(mt.output, '预约时间是五点。');
  assert.equal(mt.responseModel, 'qwen-mt-flash-fixture-revision');
  assert.equal(mt.responseId, 'fixture-response-1'); assert.equal(mt.requestId, 'fixture-request-1');
  assert.equal(asr.returnedModel, null); assert.equal(asr.revision, null);
  assert.equal(asr.requestId, null, 'client task_id is not a provider request ID');
  for (const row of f.gateway.observations) {
    const endpoint = new URL(row.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.protocol, row.kind === 'asr' ? 'ws:' : 'http:');
  }
  assert(f.gateway.observations.every(row => row.evidenceKind === 'offline-provider-stub'));
  assert(!JSON.stringify(f.observed).includes(key));
});

test('a rejected reservation blocks every upstream connection and fetch, without echoing its error', async t => {
  const f = await fixtures(t, { reserve: async () => { throw new Error(`Authorization: Bearer ${key}`); } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.event === 'task-failed'));
  const response = await f.post(translation());
  assert.equal(response.status, 403);
  assert.equal(f.count.asr, 0); assert.equal(f.count.mt, 0);
  assert.equal(f.gateway.observations.length, 2);
  assert(f.gateway.observations.every(row => row.status === 'denied' && row.code === 'BUDGET_REJECTED'));
  assert(!JSON.stringify([...f.observed, ...messages, await response.json()]).includes(key));
});

test('knowledge calls, undeclared text, altered MT config, and ASR extra parameters never reserve', async t => {
  const f = await fixtures(t);
  for (const body of [
    { model: 'qwen-plus', messages: [{ role: 'system', content: 'Extract knowledge' }] },
    translation('Undeclared transcript'), translation(input, { stream: true }),
    translation(input, { translation_options: { source_lang: 'English', target_lang: 'Chinese' } })
  ]) assert.equal((await f.post(body)).status, 403);
  const { ws, messages } = await f.connect();
  ws.send(JSON.stringify(run(undefined, { parameters: { ...parameters, undeclared: true } })));
  await waitFor(() => messages.some(row => row.header.event === 'task-failed'));
  assert.equal(f.reserved.length, 0); assert.equal(f.count.asr, 0); assert.equal(f.count.mt, 0);
  assert(f.gateway.observations.every(row => row.status === 'denied'));
});

test('a fresh ASR connection reserves separately for an explicitly allowed fallback', async t => {
  const realtime = { ...parameters, semantic_punctuation_enabled: false, max_sentence_silence: 2500, multi_threshold_mode_enabled: true };
  const f = await fixtures(t, { expected: { asrParameters: [realtime, parameters] }, asrMessage(ws, message) {
    if (message.header.action !== 'run-task') return;
    ws.send(JSON.stringify({ header: { event: message.payload.parameters.max_sentence_silence ? 'task-failed' : 'task-started',
      task_id: message.header.task_id, error_message: 'The provider rejects the optional parameters' } }));
  } });
  const first = await f.connect(); first.ws.send(JSON.stringify(run(undefined, { parameters: realtime })));
  await waitFor(() => first.messages.some(row => row.header.event === 'task-failed'));
  assert.equal(f.count.asr, 1); assert.equal(f.reserved.length, 1);
  await delay(30); assert.equal(f.count.asr, 1, 'the gateway does not retry automatically');
  const fallback = await f.connect(); fallback.ws.send(JSON.stringify(run()));
  await waitFor(() => fallback.messages.some(row => row.header.event === 'task-started'));
  assert.equal(f.count.asr, 2); assert.equal(f.reserved.length, 2);
  assert.deepEqual(f.reserved.map(row => row.config.parameters), [realtime, parameters]);
  assert.equal(f.gateway.observations[0].status, 'failed');
});

test('PCM is even-byte, cumulative, and bounded before forwarding', async t => {
  const f = await fixtures(t, { expected: { maxAudioBytes: 4 } });
  const first = await f.connect(); first.ws.send(JSON.stringify(run()));
  await waitFor(() => first.messages.some(row => row.header.event === 'task-started'));
  first.ws.send(Buffer.from([0, 0, 0]));
  await waitFor(() => first.messages.some(row => row.header.event === 'task-failed'));
  assert.equal(f.count.audioBytes, 0);
  const next = await f.connect(); next.ws.send(JSON.stringify(run()));
  await waitFor(() => next.messages.some(row => row.header.event === 'task-started'));
  next.ws.send(Buffer.from([0, 0])); next.ws.send(Buffer.from([0, 0])); next.ws.send(Buffer.from([0, 0]));
  await waitFor(() => next.messages.some(row => row.header.event === 'task-failed'));
  await waitFor(() => f.count.audioBytes === 4);
  assert.equal(f.gateway.observations.at(-1).audioBytes, 4);
  assert.equal(f.gateway.observations.at(-1).code, 'ASR_AUDIO_DENIED');
  assert.equal(f.reserved.length, 2);
});

test('provider credential echoes fail closed on success and error responses', async t => {
  const f = await fixtures(t, { mtRequest(_req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // An escaped JSON string must be checked after parsing as well as on the wire.
    res.end(JSON.stringify({ choices: [{ message: { content: key } }] }).replace('synthetic', 'synth\\u0065tic'));
  }, asrMessage(ws, message) {
    ws.send(JSON.stringify({ header: { event: 'task-failed', task_id: message.header.task_id, error_message: `Bearer ${key}` } }));
  } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.event === 'task-failed'));
  const response = await f.post(translation()); const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error.message, 'UPSTREAM_CREDENTIAL_ECHO');
  assert(!JSON.stringify([...f.observed, ...messages, body, ...f.gateway.observations]).includes(key));
  assert(f.gateway.observations.every(row => row.status === 'failed' && row.code === 'UPSTREAM_CREDENTIAL_ECHO'));
});

test('cancellation while reservations are pending blocks late upstream activity and close is bounded and idempotent', async t => {
  const controller = new AbortController(), releases = [];
  const f = await fixtures(t, { signal: controller.signal, reserve: () => new Promise(resolve => releases.push(resolve)) });
  const { ws } = await f.connect(); ws.send(JSON.stringify(run()));
  const response = f.post(translation()).catch(() => null);
  await waitFor(() => releases.length === 2);
  assert.equal(f.count.asr, 0); assert.equal(f.count.mt, 0);
  controller.abort();
  await deadline(() => f.gateway.close(), 500, 'gateway close with pending reservations');
  await deadline(() => f.gateway.close(), 500, 'repeated gateway close');
  releases.forEach((release, index) => release(`late-attempt-${index}`));
  await response; await delay(30);
  assert.equal(f.count.asr, 0); assert.equal(f.count.mt, 0);
  assert(f.gateway.observations.every(row => row.status === 'cancelled'));
  assert.deepEqual(f.gateway.observations.map(row => row.attemptId).sort(), ['late-attempt-0', 'late-attempt-1']);
});

test('connection deadline includes pending reservation and permanently blocks a late connect', async t => {
  let release;
  const f = await fixtures(t, { expected: { maxConnectionMs: 80 }, reserve: () => new Promise(resolve => { release = resolve; }) });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.error_message === 'GATEWAY_TIMEOUT'));
  assert.equal(f.count.asr, 0);
  release('expired-reservation'); await delay(30);
  assert.equal(f.count.asr, 0); assert.equal(f.gateway.observations[0].status, 'failed');
  assert.equal(f.gateway.observations[0].attemptId, 'expired-reservation');
});

test('active ASR and MT calls are aborted on close without refund or automatic retry', async t => {
  const f = await fixtures(t, { mtRequest() {}, asrMessage(ws, message) {
    ws.send(JSON.stringify({ header: { event: 'task-started', task_id: message.header.task_id } }));
  } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.event === 'task-started'));
  const response = f.post(translation()).catch(() => null);
  await waitFor(() => f.count.mt === 1);
  await deadline(() => f.gateway.close(), 500, 'active gateway shutdown');
  await response;
  assert.equal(f.reserved.length, 2);
  assert(f.gateway.observations.every(row => row.status === 'cancelled'));
  assert.equal(f.count.asr, 1); assert.equal(f.count.mt, 1);
});

test('MT client cancellation aborts the provider request and retains the reservation', async t => {
  let providerClosed = false;
  const f = await fixtures(t, { mtRequest(_req, res) { res.on('close', () => { providerClosed = true; }); } });
  const controller = new AbortController();
  const result = fetch(f.gateway.mtEndpoint, { method: 'POST', body: JSON.stringify(translation()), signal: controller.signal }).catch(() => null);
  await waitFor(() => f.count.mt === 1);
  controller.abort(); await result;
  await waitFor(() => providerClosed);
  assert.equal(f.reserved.length, 1); assert.equal(f.gateway.observations[0].status, 'cancelled');
});

test('HTTP redirect cannot turn the local fixture into an unreserved second request', async t => {
  const f = await fixtures(t, { mtRequest(req, res) {
    res.writeHead(307, { Location: `http://${req.headers.host}/redirected` }); res.end();
  } });
  const response = await f.post(translation());
  assert.equal(response.status, 502); assert.equal(f.count.mt, 1); assert.equal(f.reserved.length, 1);
  assert.equal(f.gateway.observations[0].status, 'failed');
});

test('offline endpoints are literal loopback only and live configuration requires explicit authorization and TLS', async () => {
  const options = { mode: 'offline', expected, reserve: async () => 'unused',
    upstream: { asr: 'ws://127.0.0.1:1', mt: 'http://127.0.0.1:1', key } };
  for (const url of ['http://example.com/mt', 'http://localhost:1', 'http://user:password@127.0.0.1:1', 'http://127.0.0.1:1?key=value']) {
    await assert.rejects(createQualityGateway({ ...options, upstream: { ...options.upstream, mt: url } }), /UPSTREAM_SCOPE_DENIED|INVALID_UPSTREAM_ENDPOINT/);
  }
  await assert.rejects(createQualityGateway({ ...options, mode: 'live' }), /LIVE_AUTHORIZATION_REQUIRED/);
  await assert.rejects(createQualityGateway({ ...options, mode: 'live', liveAuthorized: true }), /UPSTREAM_SCOPE_DENIED/);
  await assert.rejects(createQualityGateway({ ...options, expected: { ...expected, maxConnectionMs: 120001 } }), /INVALID_GATEWAY_LIMIT/);
  await assert.rejects(createQualityGateway({ ...options, expected: { ...expected, maxAudioBytes: 3 } }), /INVALID_AUDIO_LIMIT/);
});

test('ASR transcripts authorize MT input only with an explicit opt-in', async t => {
  const f = await fixtures(t, { expected: { mtInputs: [], allowAsrTranslations: true } });
  assert.equal((await f.post(translation())).status, 403);
  const { ws, messages } = await f.connect(); const command = run(); ws.send(JSON.stringify(command));
  await waitFor(() => messages.some(row => row.header.event === 'task-started'));
  ws.send(JSON.stringify(finish(command.header.task_id)));
  await waitFor(() => messages.some(row => row.header.event === 'task-finished'));
  assert.equal((await f.post(translation())).status, 200);
  assert.equal(f.reserved.length, 2);
});

test('successful ASR output containing an escaped credential is never forwarded or retained', async t => {
  const f = await fixtures(t, { asrMessage(ws, message) {
    ws.send(JSON.stringify({ header: { event: 'task-started', task_id: message.header.task_id } }));
    ws.send(JSON.stringify({ header: { event: 'result-generated', task_id: message.header.task_id },
      payload: { output: { sentence: { sentence_id: 1, text: key, sentence_end: true } } } }).replace('synthetic', 'synth\\u0065tic'));
  } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.event === 'task-failed'));
  assert.equal(f.gateway.observations[0].code, 'UPSTREAM_CREDENTIAL_ECHO');
  assert.deepEqual(f.gateway.observations[0].outputs, []);
  assert(!JSON.stringify([...messages, ...f.observed]).includes(key));
});

test('provider response limits and active deadlines terminate without retrying', async t => {
  const f = await fixtures(t, { expected: { maxResponseBytes: 256, maxConnectionMs: 100 }, asrMessage() {}, mtRequest(_req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(300) } }] }));
  } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  const response = await f.post(translation());
  assert.equal(response.status, 502);
  await waitFor(() => messages.some(row => row.header.error_message === 'GATEWAY_TIMEOUT'));
  assert.equal(f.count.asr, 1); assert.equal(f.count.mt, 1); assert.equal(f.reserved.length, 2);
  assert(f.gateway.observations.every(row => row.status === 'failed'));
});


test('ASR output does not authorize unplanned MT calls by default', async t => {
  const f = await fixtures(t, { expected: { mtInputs: [] } });
  const { ws, messages } = await f.connect(); const command = run(); ws.send(JSON.stringify(command));
  await waitFor(() => messages.some(row => row.header.event === 'task-started'));
  ws.send(JSON.stringify(finish(command.header.task_id)));
  await waitFor(() => messages.some(row => row.header.event === 'task-finished'));
  assert.equal(f.gateway.observations[0].outputs[0].text, input);
  assert.equal((await f.post(translation())).status, 403);
  assert.equal(f.reserved.length, 1);
  assert.equal(f.count.mt, 0);
  assert.equal(f.gateway.observations[1].code, 'MT_REQUEST_DENIED');
});

test('ASR response byte cap is cumulative, not just a per-message limit', async t => {
  const f = await fixtures(t, { expected: { maxResponseBytes: 512 }, asrMessage(ws, message) {
    const header = { task_id: message.header.task_id };
    ws.send(JSON.stringify({ header: { ...header, event: 'task-started' } }));
    for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ header: { ...header, event: 'result-generated' },
      payload: { output: { sentence: { text: 'x'.repeat(100), sentence_id: i, sentence_end: true } } } }));
  } });
  const { ws, messages } = await f.connect(); ws.send(JSON.stringify(run()));
  await waitFor(() => messages.some(row => row.header.event === 'task-failed'));
  assert.equal(f.gateway.observations[0].status, 'failed');
  assert.equal(f.gateway.observations[0].code, 'ASR_RESPONSE_INVALID');
  assert.equal(f.gateway.observations[0].outputs.length, 1);
  assert.equal(f.reserved.length, 1);
});

test('close releases timers even if a caller reservation never resolves', async t => {
  const f = await fixtures(t, { expected: { maxConnectionMs: 120000 }, reserve: () => new Promise(() => {}) });
  const response = f.post(translation()).catch(() => null);
  await waitFor(() => f.gateway.observations.some(row => row.status === 'reserving'));
  await deadline(() => f.gateway.close(), 500, 'unresolved reservation shutdown');
  await response;
  assert.equal(f.count.mt, 0);
  assert.equal(f.gateway.observations[0].status, 'cancelled');
});


test('ASR records only explicit provider model, revision, and IDs from successful events', async t => {
  const f = await fixtures(t, { asrMessage(ws, message) {
    if (message.header.action === 'run-task') ws.send(JSON.stringify({
      header: { event: 'task-started', task_id: message.header.task_id, request_id: 'asr-request-1', response_id: 'asr-response-1' },
      payload: { model: 'paraformer-fixture-returned-model', model_revision: 'fixture-revision-2026' }
    }));
    if (message.header.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: message.header.task_id } }));
  } });
  const { ws, messages } = await f.connect(); const command = run(); ws.send(JSON.stringify(command));
  await waitFor(() => messages.some(row => row.header.event === 'task-started'));
  ws.send(JSON.stringify(finish(command.header.task_id)));
  await waitFor(() => messages.some(row => row.header.event === 'task-finished'));
  const row = f.gateway.observations[0];
  assert.equal(row.returnedModel, 'paraformer-fixture-returned-model');
  assert.equal(row.revision, 'fixture-revision-2026');
  assert.equal(row.requestId, 'asr-request-1'); assert.equal(row.responseId, 'asr-response-1');
  assert.equal(row.evidenceKind, 'offline-provider-stub');
  assert.equal(new URL(row.endpoint).hostname, '127.0.0.1');
});

test('an offline endpoint cannot become live evidence by changing only mode', async t => {
  const f = await fixtures(t);
  await f.post(translation());
  const row = f.gateway.observations[0];
  assert.equal(row.mode, 'offline'); assert.equal(row.evidenceKind, 'offline-provider-stub');
  assert.equal(new URL(row.endpoint).hostname, '127.0.0.1');
  assert.equal(new URL(row.endpoint).protocol, 'http:');
  const options = { mode: 'live', expected, reserve: async () => 'must-not-reserve',
    upstream: { asr: f.gateway.asrEndpoint, mt: row.endpoint, key } };
  await assert.rejects(createQualityGateway(options), /LIVE_AUTHORIZATION_REQUIRED/);
  await assert.rejects(createQualityGateway({ ...options, liveAuthorized: true }), /UPSTREAM_SCOPE_DENIED/);
  assert.equal(f.count.mt, 1); assert.equal(f.count.asr, 0);
});

test('unsafe provider metadata is omitted and credentials in metadata fail closed', async t => {
  let calls = 0;
  const f = await fixtures(t, { mtRequest(_req, res) {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: calls === 1 ? { unexpected: 'shape' } : key, id: 'unsafe\nidentifier', request_id: 'x'.repeat(257),
      choices: [{ message: { content: '安全译文。' } }] }));
  } });
  assert.equal((await f.post(translation())).status, 200);
  const row = f.gateway.observations[0];
  assert.equal(row.responseModel, null); assert.equal(row.responseId, null); assert.equal(row.requestId, null);
  assert.equal((await f.post(translation())).status, 502);
  assert.equal(f.gateway.observations[1].code, 'UPSTREAM_CREDENTIAL_ECHO');
  assert(!JSON.stringify(f.gateway.observations).includes(key));
});
test('full MT wire-byte bound rejects equivalent whitespace and escape inflation before reservation', async t => {
  const normal = JSON.stringify(translation()), limit = Buffer.byteLength(normal);
  const f = await fixtures(t, { expected: { maxMtRequestBytes: limit } });
  const postRaw = body => fetch(f.gateway.mtEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  for (const raw of [normal + ' '.repeat(50), normal.replace('appointment', '\\u0061ppointment')]) {
    assert.deepEqual(JSON.parse(raw), JSON.parse(normal)); assert.ok(Buffer.byteLength(raw) > limit);
    const response = await postRaw(raw); assert.equal(response.status, 403); await response.arrayBuffer();
    assert.equal(f.reserved.length, 0); assert.equal(f.count.mt, 0);
  }
  const response = await postRaw(normal); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(f.reserved.length, 1); assert.equal(f.count.mt, 1);
  const observation = f.gateway.observations.find(row => row.status === 'succeeded');
  assert.equal(observation.requestBytes, limit); assert.equal(observation.requestWire, normal);
  assert.equal(observation.requestSha256, (await import('node:crypto')).createHash('sha256').update(normal).digest('hex'));
});
test('approval expiry while reserving blocks the actual upstream send but keeps its reservation', async t => {
  const f = await fixtures(t, { expected: { approvalExpiresAt: new Date(Date.now() + 100).toISOString() }, reserve: async () => { await delay(150); return 'already-persisted-attempt'; } });
  const response = await f.post(translation()); assert.equal(response.status, 403); await response.arrayBuffer();
  assert.equal(f.count.mt, 0); assert.equal(f.count.asr, 0);
  const row = f.gateway.observations[0]; assert.equal(row.attemptId, 'already-persisted-attempt'); assert.equal(row.status, 'denied'); assert.equal(row.upstreamStartedAt, undefined);
});
test('a synchronous observation crossing expiry cannot open an upstream request', async t => {
  let blocked = false;
  const f = await fixtures(t, { expected: { approvalExpiresAt: new Date(Date.now() + 150).toISOString() }, observe: row => {
    if (row.kind === 'mt' && row.status === 'running') { blocked = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220); }
  } });
  const response = await f.post(translation()); assert.equal(response.status, 403); await response.arrayBuffer();
  assert.equal(blocked, true); assert.equal(f.reserved.length, 1); assert.equal(f.count.mt, 0);
  const row = f.gateway.observations[0]; assert.equal(row.status, 'denied'); assert.equal(row.upstreamStartedAt, undefined);
});
