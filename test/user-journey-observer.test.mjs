import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { observeJourneyPage, observeJourneyGraphReads } from '../test-support/user-journey-observer.mjs';
import { userJourneyFixture } from '../test-support/user-journey-fixture.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';

const graphPath = '/api/listenings/12345678-1234-1234-1234-123456789abc/graph';
async function observedDone(entry) {
  for (let step = 0; step < 100 && !entry.done; step++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entry.done, true);
}

test('journey export observer hashes the actual server response with its download headers', { timeout: 15000 }, async t => {
  const fixture = await userJourneyFixture(); t.after(() => fixture.close());
  const endpoint = `/api/data/export?download=${Date.now()}`, startedAt = new Date().toISOString();
  const response = await fetch(fixture.base + endpoint, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
  let rows = [];
  for (let step = 0; step < 100 && !rows.length; step++) {
    rows = (await fixture.workletCapture.read()).filter(value => value.kind === 'data-export');
    if (!rows.length) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(rows.length, 1); const observed = rows[0];
  assert.equal(observed.fixtureId, fixture.fixtureId); assert.equal(observed.origin, fixture.base);
  assert.equal(observed.path, endpoint); assert.equal(observed.source, 'server-response-finish'); assert.equal(observed.method, 'GET'); assert.equal(observed.status, 200);
  assert.deepEqual(observed.headers, { contentType: 'application/vnd.sqlite3', contentLength: bytes.length, contentDisposition: response.headers.get('content-disposition') });
  assert.match(observed.headers.contentDisposition, /^attachment; filename="hearwise-backup-\d{8}-\d{6}\.sqlite"$/);
  assert.equal(observed.sha256, digest(bytes)); assert.equal(observed.bytes, bytes.length);
  assert.ok(Date.parse(observed.startedAt) >= Date.parse(startedAt)); assert.ok(Date.parse(observed.finishedAt) >= Date.parse(observed.startedAt));
  assert.equal(fixture.snapshot().rows.listenings.length, 0, 'HTTP boundary test does not seed a listening or claim UI acceptance');
});

test('graph fetch observation preserves the response and never repeats or delays the request', async () => {
  const response = new Response('{"listeningId":"12345678-1234-1234-1234-123456789abc"}'), calls = [];
  const window = { fetch: async (...args) => { calls.push(args); return response; } };
  runInNewContext(`(${observeJourneyGraphReads.toString()})()`, { window, location: { href: 'http://fixture/' }, URL, Request });
  const controller = new AbortController(), options = { signal: controller.signal };
  const delivered = await window.fetch(graphPath, options);
  assert.equal(delivered, response); assert.equal(calls.length, 1); assert.equal(calls[0][1], options);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { listeningId: '12345678-1234-1234-1234-123456789abc' });
  const entry = window.__journeyGraphReads[0]; await observedDone(entry);
  assert.equal(entry.hasSignal, true); assert.equal(entry.initiallyAborted, false); assert.equal(entry.abortedAt, null);
  assert.equal(entry.body.listeningId, '12345678-1234-1234-1234-123456789abc'); assert.equal(entry.status, 200);
  assert.equal(calls.length, 1);
});

test('graph observation records the real signal abort after HTTP headers without consuming the app response', async t => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"held":'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, calls = [];
  let nativeResponse;
  const window = { fetch: async (input, options) => { calls.push(options); nativeResponse = await fetch(new URL(input, base), options); return nativeResponse; } };
  runInNewContext(`(${observeJourneyGraphReads.toString()})()`, { window, location: { href: base }, URL, Request });
  const controller = new AbortController(), options = { signal: controller.signal };
  const response = await window.fetch(graphPath, options), entry = window.__journeyGraphReads[0];
  assert.equal(response, nativeResponse); assert.equal(response.bodyUsed, false); assert.equal(entry.status, 200); assert.equal(entry.done, false);
  function abortObservedRequest() { controller.abort(); }
  abortObservedRequest();
  await assert.rejects(response.json(), { name: 'AbortError' }); await observedDone(entry);
  assert.ok(entry.abortedAt); assert.match(entry.abortStack, /abortObservedRequest/);
  assert.equal(entry.bodyError.name, 'AbortError'); assert.equal(entry.body, undefined); assert.equal(entry.fetchError, undefined);
  assert.equal(calls.length, 1); assert.equal(calls[0], options);
});

test('graph observation keeps a pre-header aborted request distinct from a completed response', async () => {
  const controller = new AbortController(), calls = [];
  const window = { fetch: (_input, options) => { calls.push(options); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } };
  runInNewContext(`(${observeJourneyGraphReads.toString()})()`, { window, location: { href: 'http://fixture/' }, URL, Request });
  const pending = window.fetch(graphPath, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); const entry = window.__journeyGraphReads[0];
  assert.equal(entry.done, true); assert.equal(entry.status, null); assert.ok(entry.abortedAt);
  assert.equal(entry.fetchError.name, 'AbortError'); assert.equal(entry.body, undefined); assert.equal(calls.length, 1);
});

// Explicit event-source unit test, not a browser acceptance run. It checks only
// collector indexing around the production import flow's document reload.
test('journey import observation indices restart only for main-document navigation', async () => {
  const page = new EventEmitter(), main = {}, child = {};
  page.mainFrame = () => main;
  page.addInitScript = async () => {};
  const row = { base: 'http://127.0.0.1:43210', http: [], errors: [] };
  const observer = await observeJourneyPage(page, row, '390-reopened');
  const request = (suffix = 'validate?mode=append') => ({
    url: () => `${row.base}/api/data/import/${suffix}`, method: () => 'POST',
    postDataBuffer: () => null, headers: () => ({})
  });
  page.emit('framenavigated', main);
  page.emit('request', request());
  page.emit('request', request());
  page.emit('request', request('preview'));
  page.emit('framenavigated', child);
  page.emit('request', request());
  page.emit('framenavigated', main);
  page.emit('request', request());
  assert.deepEqual(row.http.map(({ index, documentIndex, responseIndex }) => ({ index, documentIndex, responseIndex })), [
    { index: 0, documentIndex: 1, responseIndex: 0 },
    { index: 1, documentIndex: 1, responseIndex: 1 },
    { index: 2, documentIndex: 1, responseIndex: 0 },
    { index: 3, documentIndex: 1, responseIndex: 2 },
    { index: 4, documentIndex: 2, responseIndex: 0 }
  ]);
  assert.deepEqual(row.http[0].request, { uploadBytes: null, uploadSha256: null, mode: 'append' });
  assert.ok(row.http.every(entry => entry.contextId === '390-reopened'));
  await observer.drain();
});

test('journey cannot correlate an old import response with the next document ledger', async () => {
  const page = new EventEmitter(), main = {};
  page.mainFrame = () => main;
  page.addInitScript = async () => {};
  let ledgerReads = 0;
  page.waitForFunction = async () => { ledgerReads++; };
  page.evaluate = async () => { ledgerReads++; };
  const row = { base: 'http://127.0.0.1:43210', http: [], errors: [] };
  const observer = await observeJourneyPage(page, row, '390-reopened');
  const request = {
    url: () => `${row.base}/api/data/import/validate?mode=append`, method: () => 'POST',
    postDataBuffer: () => null, headers: () => ({})
  };
  page.emit('framenavigated', main);
  page.emit('request', request);
  page.emit('framenavigated', main);
  page.emit('response', { url: request.url, request: () => request, status: () => 200 });
  await observer.drain();
  assert.equal(ledgerReads, 0);
  assert.equal(row.http[0].response, null);
  assert.equal(row.http[0].status, 200);
  assert.match(row.http[0].bodyError, /Import observation must remain in its request document/);
});
