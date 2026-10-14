import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { SECURITY_KEY, SECURITY_FISH_KEY, credentialFindings } from '../test-support/security-fixture.mjs';
import { closeServer, deadline } from '../test-support/lifecycle.mjs';

const qwen = { key: SECURITY_KEY, region: 'beijing', voice: 'Cherry', rate: 1 };
const fish = { provider: 'fish', key: SECURITY_FISH_KEY, model: 's2.1-pro-free', referenceId: 'synthetic-voice', rate: 1, latency: 'balanced' };
async function client(f) {
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/tts'), messages = [];
  ws.on('message', (bytes, binary) => { if (!binary) messages.push(JSON.parse(bytes.toString())); });
  await deadline(() => once(ws, 'open'), 5000, 'Security speech open');
  return { ws, messages };
}
async function waitFor(read, label) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label} exceeded 5000ms`);
}

test('Qwen and Fish credentials only reach their selected provider Authorization, never speech messages, bodies or logs', { timeout: 15000 }, async t => {
  const f = await speechFixture(); t.after(f.close);
  for (const config of [qwen, fish]) {
    const c = await client(f); t.after(() => c.ws.terminate());
    c.ws.send(JSON.stringify({ type: 'speech.preview', epoch: 1, config }));
    await waitFor(() => c.messages.some(row => row.type === 'speech.unit-end'), 'Speech generated');
    const closed = once(c.ws, 'close'); c.ws.send(JSON.stringify({ type: 'speech.stop', epoch: 1 })); await deadline(() => closed, 5000, 'Speech stop');
    assert.deepEqual(credentialFindings(c.messages), []);
  }
  assert.ok(f.stats.authorizations.length > 0 && f.stats.authorizations.every(value => value === `Bearer ${SECURITY_KEY}`));
  assert.ok(f.stats.fishRequests.length > 0 && f.stats.fishRequests.every(row => row.authorization === `Bearer ${SECURITY_FISH_KEY}`));
  assert.deepEqual(credentialFindings([...f.stats.sessions, ...f.stats.commits, ...f.stats.fishRequests.map(row => row.body)]), []);
  assert.deepEqual(credentialFindings(f.logs()), []);
});

for (const status of [401, 429, 503]) test(`Fish echoed credential on HTTP ${status} remains out of client diagnostics and logs`, { timeout: 10000 }, async t => {
  const f = await speechFixture({ fishStatus: status }); t.after(f.close); const c = await client(f); t.after(() => c.ws.terminate());
  const closed = once(c.ws, 'close'); c.ws.send(JSON.stringify({ type: 'speech.preview', epoch: 1, config: fish }));
  await deadline(() => closed, 5000, 'Fish rejected preview');
  assert.equal(f.stats.fishRequests.length, 1); assert.equal(f.stats.connections, 0);
  const failure = c.messages.find(row => row.type === 'speech.error'); assert.equal(failure.httpStatus, status);
  assert.deepEqual(credentialFindings(c.messages), []); assert.deepEqual(credentialFindings(f.logs()), []);
});

test('Qwen provider error events containing the credential never reach public speech error or Trace/log outputs', { timeout: 10000 }, async t => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(upstream, 'listening'); t.after(() => closeServer(upstream, 'Qwen error stub'));
  const authorizations = []; upstream.on('connection', (ws, req) => { authorizations.push(req.headers.authorization); ws.send(JSON.stringify({ type: 'error', error: { message: `Echo ${req.headers.authorization}` } })); });
  const f = await speechFixture({ extraEnv: { TTS_ENDPOINT: `ws://127.0.0.1:${upstream.address().port}` } }); t.after(f.close);
  const c = await client(f); t.after(() => c.ws.terminate()); const closed = once(c.ws, 'close');
  c.ws.send(JSON.stringify({ type: 'speech.preview', epoch: 1, config: qwen })); await deadline(() => closed, 5000, 'Qwen rejected preview');
  assert.equal(authorizations.length, 2, 'Existing pre-audio one-retry policy remains intact');
  assert.ok(authorizations.every(value => value === `Bearer ${SECURITY_KEY}`));
  assert.ok(c.messages.some(row => row.type === 'speech.error'));
  assert.deepEqual(credentialFindings(c.messages), []); assert.deepEqual(credentialFindings(f.logs()), []);
});
