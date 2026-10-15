import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { seedPerformanceDatabase } from '../test-support/performance-dataset.mjs';
import { startPerformanceServer, measureBackendRequest } from '../test-support/performance-server.mjs';

const recipe = { version: 1, tier: 'unit', listenings: 3, segmentsPerBackground: 2,
  graphRecords: 2, nodesPerGraph: 6, isolatedPerGraph: 2, textCharacters: 160, seed: 20261014 };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'performance-backend-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.sqlite'), manifest = await seedPerformanceDatabase(file, recipe);
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  return { file, manifest, sha256 };
}

test('backend samples use actual HTTP/SQLite and server process resource counters', async t => {
  const input = await fixture(t), server = await startPerformanceServer(input);
  t.after(() => server.close());
  const row = await measureBackendRequest(server, '/api/listenings?page=1');
  assert.equal(row.response.status, 200); assert.equal(row.response.body.items.length, 3);
  assert.ok(row.metrics.wallMs > 0); assert.ok(row.metrics.serverCpuMs >= 0);
  assert.ok(row.metrics.serverRssAfterBytes > 0); assert.ok(row.metrics.serverHeapUsedAfterBytes > 0);
  assert.equal(row.before.pid, row.after.pid); assert.equal(row.after.pid, server.pid);
  assert.notEqual(row.after.pid, process.pid);
  assert.equal(server.providerRequests.length, 0);
  assert.equal(server.input.sha256, input.sha256);
  assert.equal(createHash('sha256').update(await readFile(input.file)).digest('hex'), input.sha256);
});

test('controlled latency negative traverses the real read route and preserves its response', async t => {
  const input = await fixture(t), server = await startPerformanceServer(input);
  t.after(() => server.close());
  const row = await measureBackendRequest(server, `/api/listenings/${input.manifest.primary.id}/graph`, { controlledDelayMs: 120 });
  assert.equal(row.response.status, 200); assert.equal(row.response.body.nodes.length, 6);
  assert.equal(row.response.body.relations.length, 8);
  assert.ok(row.metrics.wallMs >= 120, JSON.stringify(row.metrics));
  assert.equal(row.controlledCost.kind, 'loopback-forwarding-response-delay');
  assert.equal(row.controlledCost.forwardedRequests, 1);
  assert.equal(row.controlledCost.requestedMs, 120);
  assert.ok(row.controlledCost.observedMs >= 120);
});

test('invalid input fingerprint is rejected before a server is started', async t => {
  const input = await fixture(t);
  await assert.rejects(startPerformanceServer({ ...input, sha256: '0'.repeat(64) }), /input.*hash/i);
});

test('failed server initialization closes its child/provider and removes its isolated copy', async t => {
  const input = await fixture(t);
  const temporaryRoot = path.dirname(input.file);
  const owned = async () => (await readdir(temporaryRoot)).filter(name => name.startsWith('hearwise-performance-server-')).sort();
  const before = await owned();
  await assert.rejects(startPerformanceServer({ ...input, temporaryRoot, serverFile: 'missing-performance-server.mjs' }), /exited before ready/);
  assert.deepEqual(await owned(), before);
  assert.equal(createHash('sha256').update(await readFile(input.file)).digest('hex'), input.sha256);
});
