import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeJourneyPage } from '../test-support/user-journey-observer.mjs';

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
