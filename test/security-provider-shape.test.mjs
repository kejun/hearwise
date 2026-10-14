import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { securityFixture, SECURITY_KEY } from '../test-support/security-fixture.mjs';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { deadline, closeServer } from '../test-support/lifecycle.mjs';

async function until(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Provider shape observation exceeded 5000ms');
}

test('connection-check ASR ignores non-object provider JSON and can accept a later valid start', { timeout: 10000 }, async t => {
  const f = await securityFixture(); t.after(f.close); f.control.asrReply = null;
  const pending = fetch(f.base + '/api/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: SECURITY_KEY }), signal: AbortSignal.timeout(6000) });
  // Keep the rejected promise observed even when the service crashes in the red version.
  pending.catch(() => {});
  await until(() => f.stats.asrClients.size > 0);
  assert.equal((await fetch(f.base + '/api/listenings')).status, 200);
  for (const ws of f.stats.asrClients) ws.send(JSON.stringify({ header: { event: 'task-started' } }));
  const result = await pending; assert.equal(result.status, 200); assert.equal((await result.json()).recognition.ok, true);
});

test('live ASR ignores non-object provider JSON then accepts a valid final without losing the service', { timeout: 10000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws'); t.after(() => ws.terminate());
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await deadline(() => once(ws, 'open'), 5000, 'Provider shape ASR open');
  ws.send(JSON.stringify({ type: 'start', key: SECURITY_KEY, source: 'zh', targetLang: 'Chinese' }));
  await until(() => messages.some(row => row.type === 'listening-ready'));
  for (const upstream of f.stats.asrClients) upstream.send('null');
  // A valid final in the same transport is a causal recovery witness, not a sleep.
  f.final('忽略无效响应后仍可保存。');
  await until(() => messages.some(row => row.type === 'segment-final'));
  assert.equal((await fetch(f.base + '/api/listenings')).status, 200);
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'stop' })); await deadline(() => closed, 5000, 'Provider shape ASR stop');
});

test('Qwen non-object provider JSON fails with the existing safe response error while the application remains available', { timeout: 10000 }, async t => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(upstream, 'listening'); t.after(() => closeServer(upstream, 'Qwen shape stub'));
  let requests = 0; upstream.on('connection', ws => { requests++; ws.send('null'); });
  const f = await speechFixture({ extraEnv: { TTS_ENDPOINT: `ws://127.0.0.1:${upstream.address().port}` } }); t.after(f.close);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/tts'); t.after(() => ws.terminate());
  const messages = []; ws.on('message', (bytes, binary) => { if (!binary) messages.push(JSON.parse(bytes.toString())); });
  await deadline(() => once(ws, 'open'), 5000, 'Qwen shape open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'speech.preview', epoch: 1, config: { key: SECURITY_KEY, region: 'beijing', voice: 'Cherry', rate: 1 } }));
  await deadline(() => closed, 5000, 'Qwen shape rejection');
  assert.equal((await fetch(f.base + '/api/listenings')).status, 200);
  assert.equal(requests, 2); assert.ok(messages.some(row => row.type === 'speech.error' && /响应无效/.test(row.message)));
});
