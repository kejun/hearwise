import test from 'node:test';
import assert from 'node:assert/strict';
import { importBrowserCases, summarizeImportBrowserEvidence } from '../test-support/import-protocol-browser-evidence.mjs';

function evidence() {
  const source = { sha: 'a'.repeat(40), dirty: false, digests: Object.fromEntries([
    'server.mjs', 'storage.mjs', 'data-transfer.mjs', 'public/app.js', 'package-lock.json',
    'scripts/verify-import-protocol-browser.mjs', 'test-support/import-protocol-browser-evidence.mjs',
    'test-support/import-protocol-fixture.mjs', 'test-support/import-protocol-control.mjs', 'test-support/import-protocol-browser-observer.mjs'
  ].map(file => [file, 'b'.repeat(64)])) };
  const work = { translations: [{ translation_state: 'failed' }],
    extraction: [{ state: 'failed', last_error: 'IMPORT_REQUIRES_RESUME' }],
    relations: [{ state: 'cancelled', last_error: 'IMPORT_REQUIRES_RESUME' }],
    rounds: [{ state: 'paused', stop_reason: 'IMPORT_REQUIRES_RESUME' }],
    edits: [{ state: 'failed' }], providerCalls: 0 };
  return { sourceStart: source, sourceEnd: structuredClone(source), tools: { chromium: 'synthetic-unit-version' },
    cleanup: [{ target: 'Chromium', ok: true }], errors: [],
    scenarios: importBrowserCases.map(row => ({ ...row, complete: true, ok: true,
      checks: { browserProtocol: { complete: true, ok: true }, importedWorkStopped: { complete: true, ok: true } },
      cleanup: [{ target: 'browser context', ok: true }, { target: 'fixture', ok: true }],
      providerCalls: [], pageErrors: [], unfinishedAfterCommit: structuredClone(work), unfinishedAfterRestart: structuredClone(work),
      lifecycle: [{ action: 'start' }, { action: 'crash', signal: 'SIGKILL' }, { action: 'start' }] })) };
}
const result = (summary, id) => summary.results.find(row => row.property.id === id);

test('completed browser protocol and stopped-work checks establish both scoped properties', () => {
  const summary = summarizeImportBrowserEvidence(evidence());
  assert.equal(summary.ok, true); assert.equal(summary.complete, true);
  assert.deepEqual(summary.results.map(row => row.status), ['passed', 'passed']);
});

test('the final UI-only expiry regression cannot revoke completed stopped-work/restart evidence', () => {
  const observations = evidence(), race = observations.scenarios.at(-1);
  race.complete = race.ok = false; race.checks = {};
  delete race.unfinishedAfterCommit; delete race.unfinishedAfterRestart;
  race.error = { name: 'AssertionError', message: 'failed stale refresh must preserve the real 410 error' };
  observations.errors.push(race.error);
  const summary = summarizeImportBrowserEvidence(observations);
  assert.equal(result(summary, 'HW-09-04').status, 'passed');
  assert.equal(result(summary, 'HW-09-04').complete, true);
  assert.equal(result(summary, 'HW-09-05').status, 'failed');
  assert.equal(result(summary, 'HW-09-05').ok, false);
  assert.equal(summary.ok, false); assert.equal(summary.complete, false);
});

for (const [name, mutate] of [
  ['missing initial source', value => { value.sourceStart = null; }],
  ['missing final source', value => { value.sourceEnd = null; }],
  ['changed source', value => { value.sourceEnd.digests['public/app.js'] = 'c'.repeat(64); }],
  ['missing required helper digest', value => {
    delete value.sourceStart.digests['test-support/import-protocol-control.mjs'];
    delete value.sourceEnd.digests['test-support/import-protocol-control.mjs'];
  }],
  ['failed global cleanup', value => { value.cleanup[0].ok = false; }],
  ['missing global cleanup', value => { value.cleanup = []; }],
  ['failed final UI fixture cleanup', value => { value.scenarios.at(-1).cleanup[1].ok = false; }],
  ['missing scenario cleanup', value => { value.scenarios[0].cleanup = []; }]
]) test(`${name} invalidates both properties even when all check markers passed`, () => {
  const observations = evidence(); mutate(observations);
  const summary = summarizeImportBrowserEvidence(observations);
  assert.equal(summary.ok, false); assert.equal(summary.complete, false);
  assert.ok(summary.results.every(row => row.status === 'incomplete' && row.complete === false && row.ok === false));
});

test('a never-started browser is not_run; a missing final case is incomplete', () => {
  const observations = evidence(); observations.scenarios = []; observations.tools.chromium = null;
  assert.deepEqual(summarizeImportBrowserEvidence(observations).results.map(row => row.status), ['not_run', 'not_run']);
  const partial = evidence(); partial.scenarios.pop();
  const summary = summarizeImportBrowserEvidence(partial);
  assert.equal(result(summary, 'HW-09-04').status, 'passed');
  assert.equal(result(summary, 'HW-09-05').status, 'incomplete'); assert.equal(summary.ok, false);
});

test('a passed marker cannot replace actual stopped-work observations', () => {
  const observations = evidence(); delete observations.scenarios[0].unfinishedAfterRestart;
  const summary = summarizeImportBrowserEvidence(observations);
  assert.equal(result(summary, 'HW-09-04').status, 'incomplete');
  assert.equal(result(summary, 'HW-09-05').status, 'passed'); assert.equal(summary.ok, false);
});

for (const [name, mutate] of [
  ['provider request', value => { value.scenarios[0].providerCalls.push({ transport: 'http' }); }],
  ['resumed imported job', value => { value.scenarios[0].unfinishedAfterRestart.extraction[0].state = 'running'; }],
  ['missing genuine process crash', value => { value.scenarios[0].lifecycle[1].signal = 'SIGTERM'; }]
]) test(`${name} fails the stopped-work property despite success markers`, () => {
  const observations = evidence(); mutate(observations);
  const summary = summarizeImportBrowserEvidence(observations);
  assert.equal(result(summary, 'HW-09-04').status, 'failed'); assert.equal(summary.ok, false);
});

test('a late page error fails browser coverage without revoking stopped-work coverage', () => {
  const observations = evidence(); observations.scenarios.at(-1).pageErrors.push({ message: 'late page error' });
  const summary = summarizeImportBrowserEvidence(observations);
  assert.equal(result(summary, 'HW-09-04').status, 'passed');
  assert.equal(result(summary, 'HW-09-05').status, 'failed'); assert.equal(summary.ok, false);
});


test('browser fetch observer never gates, substitutes or consumes the actual application response', async () => {
  const { observeImportFetch } = await import('../test-support/import-protocol-browser-observer.mjs');
  const { runInNewContext } = await import('node:vm');
  const clone = Promise.withResolvers(), entered = Promise.withResolvers();
  const original = { status: 200, clone() { return { json() { entered.resolve(); return clone.promise; } }; } };
  const calls = [], window = { fetch: async function (...args) { calls.push({ receiver: this, args }); return original; } };
  const context = { window, location: { href: 'http://fixture/' }, URL, Request };
  runInNewContext(`(${observeImportFetch.toString()})()`, context);
  const options = { method: 'POST', body: 'unchanged upload body' };
  const returned = await window.fetch('/api/data/import/validate?mode=append', options);
  assert.equal(returned, original); assert.equal(calls[0].receiver, window);
  assert.deepEqual(calls[0].args, ['/api/data/import/validate?mode=append', options]);
  await entered.promise;
  assert.equal(window.__importProtocolResponses[0].done, false, 'application receives its Response before observation completes');
  clone.resolve({ token: 'synthetic', mode: 'append' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.__importProtocolResponses[0].done, true);
  assert.equal(window.__importProtocolResponses[0].body.token, 'synthetic');
  assert.equal(await window.fetch('/api/listenings'), original);
  assert.equal(window.__importProtocolResponses.length, 1, 'other endpoints are not cloned');
});
