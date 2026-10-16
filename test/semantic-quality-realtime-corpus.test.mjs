import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectSemanticCorpusOffline, inspectSemanticCorpusOffline } from '../scripts/lib/semantic-quality-corpus.mjs';
import { closeServer } from '../test-support/lifecycle.mjs';

function plan() { return { schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
  sample: { id: 'realtime-test', kind: 'offline-text-corpus', segments: ['A source without named entities.'], ingestionBatchSize: 1,
    gold: { approved: false, variants: [{ id: 'unreviewed', units: [] }] } }, reviewers: ['synthetic test label'],
  budget: { id: 'synthetic-realtime-test', currency: 'USD', ceilingMicros: 100, attemptMicros: { knowledge: 2, relation: 3 }, expiresAt: new Date(Date.now() + 600000).toISOString() },
  limits: { maxRequestBytes: 32768, maxResponseBytes: 16384, requestTimeoutMs: 3000, totalTimeoutMs: 12000 } }; }
async function fixture(t, respond) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-realtime-corpus-'));
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    respond(response, request);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await closeServer(server, 'realtime test provider'); await rm(root, { recursive: true, force: true }); });
  return { directory: path.join(root, 'run'), providerEndpoint: `http://127.0.0.1:${server.address().port}/` };
}
const empty = response => response.end(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }));

test('realtime corpus records actual retry waits and independently replays without waiting or changing evidence', { timeout: 20000 }, async t => {
  const times = [];
  const { directory, providerEndpoint } = await fixture(t, response => {
    times.push(Date.now());
    if (times.length === 1) { response.writeHead(503, { 'retry-after': '0.01' }); response.end('{}'); }
    else empty(response);
  });
  const p = plan();
  assert.equal((await collectSemanticCorpusOffline(directory, { plan: p, providerEndpoint, realtime: true })).complete, true);
  assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 2000);
  const frozen = JSON.parse(await readFile(path.join(directory, 'freeze.json')));
  assert.equal(frozen.realtime, true);
  const capture = JSON.parse(await readFile(path.join(directory, 'capture/capture.json')));
  assert.equal(capture.clock, 'realtime workflow wall time; local provider bridge');
  const tapePath = path.join(directory, 'runtime.json'), bytes = await readFile(tapePath), tape = JSON.parse(bytes);
  assert.ok(tape.some(row => row.kind === 'wait' && row.value > 0));
  const result = await inspectSemanticCorpusOffline(directory, { plan: p, realtime: true });
  assert.equal(result.infrastructurePassed, true, JSON.stringify(result));
  assert.equal(times.length, 2, 'historical replay must not call the original provider');
  assert.equal(result.attempts, 2); assert.equal(result.reservedMicros, 4);
  assert.deepEqual(await readFile(tapePath), bytes);
  assert.equal((await inspectSemanticCorpusOffline(directory, { plan: p })).infrastructurePassed, false);
  for (const change of ['target', 'order', 'extra']) {
    const edited = structuredClone(tape), index = edited.findIndex(row => row.kind === 'wait');
    if (change === 'target') edited[index].value++;
    else if (change === 'order') edited[index].kind = 'now';
    else edited.push({ kind: 'wait', value: 0 });
    await writeFile(tapePath, JSON.stringify(edited));
    assert.equal((await inspectSemanticCorpusOffline(directory, { plan: p, realtime: true })).infrastructurePassed, false, change);
  }
  await writeFile(tapePath, bytes);
});

test('realtime corpus cancellation during backoff preserves reservation and cannot complete', { timeout: 10000 }, async t => {
  const controller = new AbortController(); let calls = 0;
  const { directory, providerEndpoint } = await fixture(t, response => {
    calls++; response.writeHead(503, { 'retry-after': '0.01' }); response.end('{}');
    setTimeout(() => controller.abort(), 150);
  });
  const p = plan(), result = await collectSemanticCorpusOffline(directory, { plan: p, providerEndpoint, realtime: true, signal: controller.signal });
  assert.equal(result.complete, false); assert.equal(result.errorCode, 'CORPUS_CANCELLED'); assert.equal(calls, 1);
  assert.equal((await inspectSemanticCorpusOffline(directory, { plan: p, realtime: true })).infrastructurePassed, false);
});

test('realtime option requires a boolean and cannot authorize an external worker endpoint', async () => {
  await assert.rejects(collectSemanticCorpusOffline('/tmp/unused-realtime-corpus', { plan: plan(), providerEndpoint: 'http://127.0.0.1:1/', realtime: 'true' }), /CORPUS_REALTIME_INVALID/);
  await assert.rejects(collectSemanticCorpusOffline('/tmp/unused-realtime-corpus', { plan: plan(), providerEndpoint: 'https://example.com/', realtime: true }), /LOOPBACK_ONLY/);
});


test('provider capability travels only in private stdin and local authorization header, never replay evidence', { timeout: 10000 }, async t => {
  const capability = 'synthetic-private-role-capability-' + 'x'.repeat(32); let calls = 0;
  const { directory, providerEndpoint } = await fixture(t, (response, request) => {
    calls++; assert.equal(request.headers.authorization, `Bearer ${capability}`); empty(response);
  });
  const p = plan();
  assert.equal((await collectSemanticCorpusOffline(directory, { plan: p, providerEndpoint, realtime: true, providerCapability: capability })).complete, true);
  assert.equal(calls, 1);
  for (const file of ['input.json', 'freeze.json', 'run.json', 'runtime.json', 'worker.json', 'review.json', 'capture/capture.json', 'capture/store.sqlite', 'budget.sqlite']) {
    assert.equal((await readFile(path.join(directory, file))).includes(Buffer.from(capability)), false, file);
  }
  assert.equal((await inspectSemanticCorpusOffline(directory, { plan: p, realtime: true })).infrastructurePassed, true);
  assert.equal(calls, 1);
});
