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
