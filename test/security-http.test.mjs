import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { securityFixture, SECURITY_KEY, credentialFindings } from '../test-support/security-fixture.mjs';
import { seedNameReplacement } from '../test-support/name-replacement-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

const seed = store => {
  const first = seedNameReplacement(store, { graph: true }), second = seedNameReplacement(store), receiptId = randomUUID();
  const snapshot = store.knowledgeEditSnapshot(second.listeningId, second.item.id);
  store.replaceKnowledgeName(second.listeningId, second.item.id, receiptId, { name: 'SecondDeebo', revision: snapshot.revision });
  return { first, second, receiptId };
};
function snapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()])); }
  finally { db.close(); }
}
async function request(f, route, { method = 'GET', body, headers = {}, raw } = {}) {
  const response = await fetch(f.base + route, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function rejectedUpgrade(f, route, headers = {}) {
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + route, { headers });
  ws.on('error', () => {});
  try { const [, response] = await deadline(() => once(ws, 'unexpected-response'), 5000, 'Rejected upgrade'); return response.statusCode; }
  finally { ws.terminate(); }
}

test('HTTP Origin boundary retains local/no-Origin and trusted proxy semantics while rejecting foreign writes', { timeout: 15000 }, async t => {
  const f = await securityFixture({ seed }); t.after(f.close);
  const route = `/api/listenings/${f.seeded.first.listeningId}`;
  for (const headers of [{}, { Origin: f.base }, { Origin: f.base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https, http' }]) {
    assert.equal((await request(f, route, { method: 'PATCH', body: { title: 'Origin accepted', notes: 'local deployment' }, headers })).status, 200);
  }
  const before = snapshot(f.filename), calls = f.stats.requests.length;
  const origins = ['https://untrusted.invalid', 'null', '://invalid', f.base.replace('http:', 'https:'), 'http://127.0.0.1:1'];
  for (const Origin of origins) for (const method of ['POST', 'PATCH', 'DELETE']) {
    const response = await request(f, method === 'POST' ? '/api/test-connection' : route, { method, body: { key: SECURITY_KEY, title: 'must not write' }, headers: { Origin } });
    assert.equal(response.status, 403, `${method} ${Origin}`); assert.deepEqual(credentialFindings(response.body), []);
  }
  const read = await request(f, route, { headers: { Origin: 'https://untrusted.invalid' } });
  assert.equal(read.status, 200, 'Existing GET API has no authentication/Origin rejection');
  assert.equal(read.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(snapshot(f.filename), before); assert.equal(f.stats.requests.length, calls);
});

test('WebSocket Origin and route boundaries reject before upstream calls; supported same/no-Origin upgrades remain usable', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  for (const route of ['/ws', '/ws/tts']) {
    for (const Origin of ['https://untrusted.invalid', 'null', f.base.replace('http:', 'https:')]) assert.equal(await rejectedUpgrade(f, route, { Origin }), 403);
    for (const headers of [{}, { Origin: f.base }]) {
      const ws = new WebSocket(f.base.replace('http:', 'ws:') + route, { headers });
      await deadline(() => once(ws, 'open'), 5000, 'Accepted upgrade'); ws.terminate();
    }
  }
  assert.equal(await rejectedUpgrade(f, '/ws/unexpected'), 403);
  assert.equal(f.stats.requests.length, 0);
});

test('invalid JSON, shape, language, lengths and metadata are rejected without provider calls or persisted writes', { timeout: 15000 }, async t => {
  const f = await securityFixture({ seed }); t.after(f.close); const before = snapshot(f.filename);
  const base = { key: SECURITY_KEY, text: 'Hello.', source: 'en', target: 'Chinese' };
  for (const body of [null, [], { ...base, key: {} }, { ...base, key: '' }, { ...base, text: {} }, { ...base, text: 'a'.repeat(3001) },
    { ...base, source: 'javascript:alert(1)' }, { ...base, target: '<script>' }]) {
    const result = await request(f, '/api/translate', { method: 'POST', body }); assert.equal(result.status, 400); assert.deepEqual(credentialFindings(result.body), []);
  }
  for (const raw of [`{"key":"${SECURITY_KEY}"`, JSON.stringify({ ...base, text: 'x'.repeat(33000) })]) {
    const result = await request(f, '/api/translate', { method: 'POST', raw }); assert.equal(result.status, 400); assert.deepEqual(credentialFindings(result.body), []);
  }
  for (const body of [[], { title: [] }, { title: 'x', notes: 'n', unknown: SECURITY_KEY }]) {
    assert.equal((await request(f, `/api/listenings/${f.seeded.first.listeningId}`, { method: 'PATCH', body })).status, 400);
  }
  for (const query of ['limit=201', 'limit=1.2', 'ids=not-a-uuid', 'runId=bad', 'afterSequence=-1']) {
    assert.equal((await request(f, `/api/listenings/${f.seeded.first.listeningId}/segments?${query}`)).status, 400);
  }
  assert.equal(f.stats.requests.length, 0); assert.deepEqual(snapshot(f.filename), before); assert.deepEqual(credentialFindings(f.logs()), []);
});

test('cross-listening item, run, segment and receipt combinations cannot read or modify the foreign child', { timeout: 15000 }, async t => {
  const f = await securityFixture({ seed }); t.after(f.close); const { first, second } = f.seeded;
  const before = snapshot(f.filename), route = `/api/listenings/${first.listeningId}/knowledge/${second.item.id}`;
  assert.equal((await request(f, route)).status, 404);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await request(f, route, { method, body: method === 'DELETE' ? { revision: 'a'.repeat(64) } : { revision: 'a'.repeat(64), key: SECURITY_KEY, name: 'Tibo', source: 'Deebo' } })).status, 404);
  assert.equal((await request(f, route + '/name-replacements', { method: 'POST', body: { revision: 'a'.repeat(64), name: 'MustNotChange' }, headers: { 'Idempotency-Key': randomUUID() } })).status, 404);
  const receipt = `/edits/${f.seeded.receiptId}`;
  assert.equal((await request(f, `/api/listenings/${second.listeningId}/knowledge/${second.item.id}` + receipt)).status, 200, 'The foreign receipt really exists');
  for (const prefix of [route, `/api/listenings/${first.listeningId}/knowledge/${first.item.id}`, `/api/listenings/${second.listeningId}/knowledge/${first.item.id}`]) assert.equal((await request(f, prefix + receipt)).status, 404);
  assert.equal((await request(f, `/api/listenings/${first.listeningId}/segments?runId=${second.runId}`)).status, 404);
  const segments = await request(f, `/api/listenings/${first.listeningId}/segments?ids=${second.segment.id}`);
  assert.equal(segments.status, 200); assert.deepEqual(segments.body.items, []);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/tts'); t.after(() => ws.terminate());
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await deadline(() => once(ws, 'open'), 5000, 'Cross-run speech open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'speech.start', epoch: 1, listeningId: first.listeningId, runId: second.runId,
    config: { key: SECURITY_KEY, region: 'beijing', voice: 'Cherry', rate: 1 } }));
  await deadline(() => closed, 5000, 'Cross-run speech rejected'); assert.ok(messages.some(row => row.type === 'speech.error'));
  assert.deepEqual(snapshot(f.filename), before); assert.equal(f.stats.requests.length, 0);
});

test('malformed WebSocket messages fail closed before any provider request', { timeout: 15000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  for (const [route, input] of [['/ws', '{broken'], ['/ws', JSON.stringify({ type: 'start', key: SECURITY_KEY, source: 'invalid' })],
    ['/ws/tts', JSON.stringify({ type: 'speech.preview', epoch: 1, config: { key: SECURITY_KEY, provider: 'unknown' } })]]) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + route); ws.on('error', () => {});
    const messages = []; ws.on('message', bytes => messages.push(bytes.toString()));
    await deadline(() => once(ws, 'open'), 5000, 'Invalid message open'); const closed = once(ws, 'close'); ws.send(input);
    await deadline(() => closed, 5000, 'Invalid message close');
    assert.deepEqual(credentialFindings(messages), []);
  }
  assert.equal(f.stats.requests.length, 0); assert.deepEqual(credentialFindings(f.logs()), []);
});
