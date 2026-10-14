import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { securityFixture, SECURITY_KEY, credentialFindings } from '../test-support/security-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

async function post(f, route, input) {
  const response = await fetch(f.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}

test('credentials stay out of normal connection responses and structured traces; only provider authorization receives the key', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  const response = await post(f, '/api/test-connection', { key: SECURITY_KEY });
  assert.equal(response.status, 200);
  assert.ok(Object.values(response.body).every(row => row.ok));
  assert.equal(f.stats.requests.length, 3);
  assert.ok(f.stats.requests.every(row => row.authorization === `Bearer ${SECURITY_KEY}`));
  assert.deepEqual(credentialFindings(response), []);
  assert.deepEqual(credentialFindings(f.stats.requests.map(row => row.body || null)), []);
  assert.match(f.logs(), /execution_trace /);
  assert.deepEqual(credentialFindings(f.logs()), []);
});

test('provider error bodies cannot echo credentials through translation or connection diagnostics; recovery still works', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  f.control.modelStatus = 401; f.control.asrFailure = true;
  const translation = await post(f, '/api/translate', { key: SECURITY_KEY, text: 'Hello.', source: 'en', target: 'Chinese' });
  const connection = await post(f, '/api/test-connection', { key: SECURITY_KEY });
  assert.equal(translation.status, 502); assert.equal(connection.status, 200);
  assert.ok(Object.values(connection.body).every(row => row.ok === false));
  assert.deepEqual(credentialFindings({ translation, connection }), [], 'Provider error response must not contain a credential sentinel');
  assert.deepEqual(credentialFindings(f.logs()), []);
  f.control.modelStatus = 200; f.control.asrFailure = false;
  assert.ok(Object.values((await post(f, '/api/test-connection', { key: SECURITY_KEY })).body).every(row => row.ok));
});

test('ASR failure and segmentation fallback never forward credentials to client or server logs', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close); f.control.asrFailure = true;
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws'); t.after(() => ws.terminate());
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await deadline(() => once(ws, 'open'), 5000, 'Security WebSocket open');
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'start', key: SECURITY_KEY, source: 'en', targetLang: 'Chinese' }));
  await deadline(() => closed, 5000, 'Security WebSocket failure');
  assert.equal(f.stats.asrConnections, 2, 'Retain the existing one-time base-parameter fallback');
  assert.ok(messages.some(row => row.type === 'error'));
  assert.match(f.logs(), /asr_param_fallback/);
  assert.deepEqual(credentialFindings(messages), [], 'ASR client error must not contain a credential sentinel');
  assert.deepEqual(credentialFindings(f.logs()), [], 'ASR fallback log must not contain a credential sentinel');
});
