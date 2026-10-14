import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { securityFixture } from '../test-support/security-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

for (const [route, limit] of [['/ws', 64 * 1024], ['/ws/tts', 16 * 1024]]) {
  test(`${route} rejects an oversized frame with 1009 without terminating the service`, { timeout: 10000 }, async t => {
    const f = await securityFixture(); t.after(f.close);
    const before = await (await fetch(f.base + '/api/listenings')).json();
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + route); ws.on('error', () => {}); t.after(() => ws.terminate());
    await deadline(() => once(ws, 'open'), 5000, 'Oversized frame open');
    const closed = once(ws, 'close'); ws.send('x'.repeat(limit + 1));
    const [code] = await deadline(() => closed, 5000, 'Oversized frame close'); assert.equal(code, 1009);
    const response = await fetch(f.base + '/api/listenings');
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), before);
    assert.equal(f.stats.requests.length, 0); assert.doesNotMatch(f.logs(), /Unhandled 'error' event/);
  });
}

test('an oversized active ASR frame preserves accepted text and runs interrupted cleanup while the server stays available', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws'); ws.on('error', () => {}); t.after(() => ws.terminate());
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  const wait = async predicate => {
    const expires = Date.now() + 5000;
    while (Date.now() < expires) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Active ASR security event exceeded 5000ms');
  };
  await deadline(() => once(ws, 'open'), 5000, 'Active oversized frame open');
  ws.send(JSON.stringify({ type: 'start', key: 'synthetic-active-frame-key', source: 'zh', targetLang: 'Chinese' }));
  await wait(() => messages.some(row => row.type === 'listening-ready'));
  const run = messages.find(row => row.type === 'listening-ready');
  f.final('超大帧之前已经合法保存的原文。'); await wait(() => messages.some(row => row.type === 'segment-final'));
  const closed = once(ws, 'close'); ws.send('x'.repeat(65537));
  assert.equal((await deadline(() => closed, 5000, 'Active oversized frame close'))[0], 1009);
  await wait(() => f.stats.asrClients.size === 0);
  const response = await fetch(f.base + `/api/listenings/${run.listeningId}`); assert.equal(response.status, 200);
  const detail = await response.json(); assert.equal(detail.runs.find(row => row.id === run.runId).state, 'interrupted');
  assert.equal(detail.segments.length, 1); assert.equal(detail.segments[0].original_text, '超大帧之前已经合法保存的原文。');
  assert.equal(f.stats.asrConnections, 1); assert.doesNotMatch(f.logs(), /Unhandled 'error' event/);
});
