import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSemanticGateway } from '../scripts/lib/semantic-quality-gateway.mjs';
import { closeServer, deadline } from '../test-support/lifecycle.mjs';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { KNOWLEDGE_MODEL } from '../knowledge.mjs';
import { RELATION_MODEL } from '../relations.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';
const key = 'synthetic-upstream-semantic-key';
const body = { model: KNOWLEDGE_MODEL, enable_thinking: false, messages: [{ role: 'system', content: 'Synthetic protocol.' }, { role: 'user', content: '{}' }] };
const expected = () => ({ knowledgeModel: KNOWLEDGE_MODEL, relationModel: RELATION_MODEL, maxRequests: 24, maxRequestBytes: 128000,
  maxResponseBytes: 128000, timeoutMs: 1500, expiresAt: new Date(Date.now() + 60000).toISOString() });
async function fixture(t, options = {}) {
  const received = [], reservations = [];
  const server = http.createServer(async (request, reply) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const wire = Buffer.concat(chunks).toString();
    received.push({ authorization: request.headers.authorization, wire });
    if (options.respond) return options.respond(request, reply, JSON.parse(wire), received);
    reply.writeHead(200, { 'content-type': 'application/json' }); reply.end('{"choices":[{"message":{"content":"{\\"items\\":[]}"}}]}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => closeServer(server, 'semantic test upstream'));
  const gateway = await createSemanticGateway({ mode: 'offline', upstream: { endpoint: `http://127.0.0.1:${server.address().port}`, key: options.key || key },
    expected: { ...expected(), ...options.expected }, authorize: options.authorize || (() => true),
    reserve: options.reserve || (context => { reservations.push(context); return `attempt-${reservations.length}`; }), signal: options.signal });
  t.after(() => gateway.close());
  const request = (payload = body, headers = {}) => fetch(gateway.knowledgeEndpoint, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, ...headers }, body: JSON.stringify(payload) });
  return { gateway, received, reservations, request };
}
test('semantic adapter reserves before actual forwarding and keeps the provider key private', { timeout: 5000 }, async t => {
  let reserved = false;
  const f = await fixture(t, { reserve: () => { reserved = true; return 'r1'; }, respond: (_req, res) => {
    assert.equal(reserved, true); res.end('{"choices":[{"message":{"content":"{}"}}]}');
  } });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.received[0].authorization, `Bearer ${key}`);
  const [row] = f.gateway.observations();
  assert.equal(row.attemptId, 'r1'); assert.equal(row.status, 'succeeded');
  assert.equal(row.requestWire, f.received[0].wire);
  assert.ok(row.reservedAt <= row.forwardedAt);
  assert.ok(!JSON.stringify(row).includes(key)); assert.ok(!JSON.stringify(row).includes(f.gateway.token));
});
for (const variant of ['authorization', 'reservation', 'model', 'extra-field', 'secret', 'local-token']) test(`semantic adapter denies ${variant} before upstream`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { authorize: () => variant !== 'authorization', reserve: () => { if (variant === 'reservation') throw new Error(key); return 'r1'; } });
  const payload = structuredClone(body);
  if (variant === 'model') payload.model = 'wrong-model';
  if (variant === 'extra-field') payload.stream = true;
  if (variant === 'secret') payload.messages[1].content = key;
  assert.equal((await f.request(payload, variant === 'local-token' ? { authorization: 'Bearer wrong' } : {})).status, 502);
  assert.equal(f.received.length, 0); assert.ok(!JSON.stringify(f.gateway.observations()).includes(key));
});
for (const variant of ['redirect', 'oversize', 'secret', 'http-error']) test(`semantic adapter handles ${variant} without leaking or retrying`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { expected: { maxResponseBytes: 256 }, respond: (_req, res) => {
    if (variant === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:1/not-followed' }); res.end(); }
    if (variant === 'oversize') res.end('x'.repeat(257));
    if (variant === 'secret') res.end(JSON.stringify({ error: key }));
    if (variant === 'http-error') { res.writeHead(429, { 'retry-after': '2' }); res.end(JSON.stringify({ error: 'untrusted provider error' })); }
  } });
  const response = await f.request(); assert.equal(response.status, variant === 'http-error' ? 429 : 502); assert.equal(await response.text(), '{}');
  if (variant === 'http-error') assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(f.received.length, 1); assert.equal(f.reservations.length, 1);
  const [row] = f.gateway.observations(); assert.equal(row.status, 'failed'); assert.equal(row.responseWire, undefined);
  assert.ok(!JSON.stringify(row).includes(key));
});
test('semantic adapter preserves invalid successful protocol output for production repair', { timeout: 5000 }, async t => {
  const f = await fixture(t, { respond: (_req, res) => res.end('not-json') });
  assert.equal(await (await f.request()).text(), 'not-json'); assert.equal(f.gateway.observations()[0].responseWire, 'not-json');
});
test('semantic adapter rejects duplicate reservations and fixed request exhaustion', { timeout: 5000 }, async t => {
  const f = await fixture(t, { expected: { maxRequests: 2 }, reserve: () => 'same-reservation' });
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 502);
  assert.equal((await f.request()).status, 502);
  assert.equal(f.received.length, 1); assert.equal(f.gateway.observations().length, 2);
});
test('semantic adapter bounds provider stalls and closes while reservation is pending', { timeout: 5000 }, async t => {
  const f = await fixture(t, { expected: { timeoutMs: 30 }, respond: () => {} });
  assert.equal((await f.request()).status, 502);
  assert.equal(f.gateway.observations()[0].status, 'cancelled');
  let finish;
  const g = await fixture(t, { expected: { timeoutMs: 30 }, reserve: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal((await g.request()).status, 502);
  await deadline(() => g.gateway.close(), 1000, 'close pending reservation');
  finish('late-reservation'); await delay(10);
  assert.equal(g.received.length, 0); assert.equal(g.gateway.observations()[0].attemptId, 'late-reservation');
  assert.equal(g.gateway.observations()[0].status, 'cancelled');
});
test('semantic adapter rejects live mode or expired plan before opening an endpoint', async () => {
  const options = { mode: 'live', upstream: { endpoint: 'https://example.invalid', key }, expected: expected(), authorize: () => true, reserve: () => 'r1' };
  await assert.rejects(createSemanticGateway(options), /LIVE_AUTHORIZATION_REQUIRED/);
  await assert.rejects(createSemanticGateway({ ...options, mode: 'offline' }), /UPSTREAM_SCOPE_DENIED/);
  await assert.rejects(createSemanticGateway({ ...options, mode: 'offline', upstream: { endpoint: 'http://127.0.0.1:1', key }, expected: { ...expected(), expiresAt: '2000-01-01' } }), /APPROVAL_EXPIRED/);
});
test('real knowledge and relation workflows cross the adapter after SQLite reservation and persist results', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-gateway-workflow-'));
  const store = new ListeningStore(path.join(root, 'store.sqlite'));
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  store.db.exec('CREATE TABLE evaluation_attempts(id INTEGER PRIMARY KEY,kind TEXT,request_hash TEXT)');
  const sample = semanticFixtureSample(), response = semanticFixtureResponse();
  let active, clock = Date.now();
  const f = await fixture(t, {
    authorize: context => {
      if (context.kind !== active.domain) return false;
      if (active.domain === 'knowledge') {
        const checkpoint = store.knowledgeCheckpoint(active.id);
        return checkpoint.job.state === 'running' && checkpoint.parts.some(part => part.phase === 'extract_inflight' || part.phase === 'repair_inflight');
      }
      const job = store.getRelationJob(active.id); return job.state === 'running' && job.request_count > 0;
    },
    reserve: context => {
      const id = store.db.prepare('INSERT INTO evaluation_attempts(kind,request_hash) VALUES(?,?)').run(context.kind, context.requestSha256).lastInsertRowid;
      return `sqlite-${id}`;
    },
    respond: (_req, res, payload, received) => {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM evaluation_attempts').get().n, received.length);
      const input = JSON.parse(payload.messages.at(-1).content);
      const output = response({ kind: active.domain, input, sample });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    }
  });
  const run = store.createRun(null, { source: 'en', targetLang: 'English', audioSource: 'microphone' }, 'Synthetic adapter contract');
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'source-0', text: sample.segments[0] }).segment;
  store.setTranslation(segment.id, sample.segments[0]);
  const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
  active = { domain: 'knowledge', id: job.id };
  const knowledge = createKnowledgeWorkflow({ store, endpoint: f.gateway.knowledgeEndpoint, now: () => clock });
  const result = await knowledge.execute(store.markJob(job.id, 'running'), f.gateway.token, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.kind, 'terminal'); assert.equal(result.outcome, 'ok');
  store.finishRun(run.runId); store.enableRelations(run.listeningId, { now: clock });
  const relations = createRelationWorkflow({ store, endpoint: f.gateway.relationEndpoint, now: () => clock, requestTimeoutMs: 3000 });
  for (let i = 0; i < 4; i++) {
    clock = Math.max(clock, store.relationProcessing(run.listeningId).nextReadyAt || 0);
    const next = store.nextRelationJob(run.listeningId, { now: clock, quietMs: 0 }); if (!next) break;
    active = { domain: 'relation', id: next.id };
    await relations.execute(next, f.gateway.token, AbortSignal.timeout(5000));
  }
  assert.equal(store.knowledge(run.listeningId).length, 3);
  assert.equal(store.graph(run.listeningId).status.state, 'complete');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM relation_assertions').get().n, 2);
  assert.equal(f.received.length, 2);
  assert.deepEqual(f.gateway.observations().map(row => [row.kind, row.status]), [['knowledge','succeeded'],['relation','succeeded']]);
});

test('semantic adapter rejects oversize input before a reservation', { timeout: 5000 }, async t => {
  const f = await fixture(t, { expected: { maxRequestBytes: 256 } });
  const payload = structuredClone(body); payload.messages[1].content = 'x'.repeat(256);
  await f.request(payload).then(response => assert.equal(response.status, 502), () => {});
  assert.equal(f.received.length, 0); assert.equal(f.reservations.length, 0);
});
test('semantic adapter rechecks expiry after a committed reservation without refunding', { timeout: 5000 }, async t => {
  const f = await fixture(t, { expected: { expiresAt: new Date(Date.now() + 60).toISOString() },
    reserve: async () => { await delay(90); return 'expired-but-charged'; } });
  assert.equal((await f.request()).status, 502);
  assert.equal(f.received.length, 0);
  const [row] = f.gateway.observations();
  assert.equal(row.attemptId, 'expired-but-charged'); assert.equal(row.code, 'APPROVAL_EXPIRED');
});
test('semantic adapter cancels concurrent authorizations before either can reserve', { timeout: 5000 }, async t => {
  let finish; const hold = new Promise(resolve => { finish = resolve; }); let count = 0;
  const f = await fixture(t, { authorize: () => { count++; return hold; } });
  const pending = [f.request().catch(() => null), f.request().catch(() => null)];
  await deadline(async () => { while (count < 2) await delay(5); }, 1500, 'both authorizations');
  await f.gateway.close(); finish(true); await Promise.all(pending); await delay(10);
  assert.equal(f.received.length, 0); assert.equal(f.reservations.length, 0);
  assert.deepEqual(f.gateway.observations().map(row => row.status), ['cancelled', 'cancelled']);
});
for (const credential of ['upstream','local']) test(`semantic adapter rejects JSON-escaped ${credential} key in either direction`, { timeout: 5000 }, async t => {
  let encoded;
  const f = await fixture(t, { respond: (_request, reply) => reply.end(`{"choices":[{"message":{"content":"${encoded}"}}]}`) });
  const value = credential === 'upstream' ? key : f.gateway.token;
  encoded = [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const wire = JSON.stringify(body).replace('"{}"', `"${encoded}"`);
  const denied = await fetch(f.gateway.knowledgeEndpoint, { method: 'POST', headers: { authorization: `Bearer ${f.gateway.token}` }, body: wire });
  assert.equal(denied.status, 502); assert.equal(f.received.length, 0);
  const rejected = await f.request(); assert.equal(rejected.status, 502); assert.equal(await rejected.text(), '{}');
  assert.ok(f.gateway.observations().every(row => row.responseWire === undefined && row.requestWire !== wire));
});
test('semantic adapter rejects invalid UTF-8 without inventing replacement-character evidence', { timeout: 5000 }, async t => {
  const f = await fixture(t, { respond: (_req, res) => res.end(Buffer.from([0xff])) });
  assert.equal((await f.request()).status, 502);
  const wire = Buffer.concat([Buffer.from(JSON.stringify(body).replace('"{}"', '"')), Buffer.from([0xff])]);
  const response = await fetch(f.gateway.knowledgeEndpoint, { method: 'POST', headers: { authorization: `Bearer ${f.gateway.token}` }, body: wire });
  assert.equal(response.status, 502); assert.equal(f.received.length, 1);
  assert.ok(f.gateway.observations().every(row => row.responseWire === undefined));
});

test('callback error codes cannot become credential-bearing public diagnostics', { timeout: 5000 }, async t => {
  const f = await fixture(t, { key: 'SYNTHETIC_SECRET_KEY', authorize: () => { throw Object.assign(new Error('safe'), { code: 'SYNTHETIC_SECRET_KEY' }); } });
  assert.equal((await f.request()).status, 502);
  assert.equal(f.gateway.observations()[0].code, 'SEMANTIC_TRANSPORT_FAILED');
  assert.equal(f.received.length, 0);
});

test('semantic adapter rejects credentials outside the bearer-token alphabet', async () => {
  for (const invalid of ['synthetic"secret-key', 'synthetic\\secret-key', 'synthetic secret-key']) {
    await assert.rejects(createSemanticGateway({ mode: 'offline', upstream: { endpoint: 'http://127.0.0.1:1', key: invalid },
      expected: expected(), authorize: () => true, reserve: () => 'r1' }), /UPSTREAM_KEY_REQUIRED/);
  }
});

test('semantic adapter does not silently strip UTF-8 BOM from wire evidence', { timeout: 5000 }, async t => {
  const responseBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]);
  const f = await fixture(t, { respond: (_req, res) => res.end(responseBytes) });
  const bomRequest = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(body))]);
  const rejected = await fetch(f.gateway.knowledgeEndpoint, { method: 'POST', headers: { authorization: `Bearer ${f.gateway.token}` }, body: bomRequest });
  assert.equal(rejected.status, 502); assert.equal(f.received.length, 0);
  const response = await f.request(); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBytes);
  assert.deepEqual(Buffer.from(f.gateway.observations()[1].responseWire), responseBytes);
});
