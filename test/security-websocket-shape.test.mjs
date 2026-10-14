import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { securityFixture, credentialFindings } from '../test-support/security-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

for (const route of ['/ws', '/ws/tts']) test(`${route} rejects non-object JSON without crashing or requesting a provider`, { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  for (const value of [null, [], true, 17, 'string']) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + route); ws.on('error', () => {}); t.after(() => ws.terminate());
    const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    await deadline(() => once(ws, 'open'), 5000, 'Shape test open'); const closed = once(ws, 'close'); ws.send(JSON.stringify(value));
    await deadline(() => closed, 2000, 'Shape rejection');
    assert.ok(messages.some(row => ['error', 'speech.error'].includes(row.type) && /格式无效/.test(row.message)));
    assert.equal((await fetch(f.base + '/api/listenings')).status, 200);
    assert.deepEqual(credentialFindings(messages), []);
  }
  assert.equal(f.stats.requests.length, 0); assert.doesNotMatch(f.logs(), /TypeError|Unhandled 'error' event/);
});
