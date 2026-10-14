import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SECURITY_KEY, SECURITY_FISH_KEY, credentialFindings } from '../test-support/security-fixture.mjs';
import { createSecurityFetchLedger, installSecurityFetchObserver, assertTextIsolation, SecurityBoundaryViolation,
  renderingMutant, redactSecurityDiagnostic } from '../test-support/security-browser-support.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const empty = { executionCount: 0, injectedNodeCount: 0, probeRequests: 0, externalRequests: 0,
  credentialFindings: 0, observationErrors: 0, pageErrors: 0 };

test('security oracle fails each forbidden surface and fails closed on missing observations', () => {
  assertTextIsolation(empty, 'normal');
  for (const field of Object.keys(empty)) {
    assert.throws(() => assertTextIsolation({ ...empty, [field]: 1 }, field), SecurityBoundaryViolation);
    const missing = { ...empty }; delete missing[field];
    assert.throws(() => assertTextIsolation(missing, 'missing'), SecurityBoundaryViolation);
  }
});

test('isolated mutation changes exactly the unique actual-app text sink', async () => {
  const source = await readFile('public/app.js', 'utf8'), mutant = renderingMutant(source);
  assert.equal(mutant.replacements, 1);
  assert.equal(mutant.source.replace(mutant.replacement, mutant.anchor), source);
  assert.throws(() => renderingMutant('missing anchor'));
  assert.throws(() => renderingMutant(source + source));
});

test('diagnostics remove every synthetic credential before artifact serialization', () => {
  const result = redactSecurityDiagnostic(new Error(`${SECURITY_KEY} ${SECURITY_FISH_KEY} ${SECURITY_KEY}`));
  assert.equal(credentialFindings(result).length, 0);
  assert.match(result, /redacted/);
});

test('fetch observer preserves arguments, receiver, original promise and Response without awaiting clone', async () => {
  let release, clones = 0, receivedThis, receivedArgs;
  const cloneBytes = new Promise(resolve => { release = resolve; });
  const response = { url: 'http://127.0.0.1/api/listenings', headers: new Map(),
    clone() { clones++; return { arrayBuffer: () => cloneBytes }; } };
  const original = Promise.resolve(response), request = { url: response.url }, options = { method: 'GET' }, receiver = {};
  const target = { fetch(...args) { receivedThis = this; receivedArgs = args; return original; } };
  const state = installSecurityFetchObserver({ target, keys: [SECURITY_KEY], epoch: 'identity' });
  const returned = target.fetch.call(receiver, request, options);
  assert.equal(returned, original); assert.equal(await returned, response);
  assert.equal(receivedThis, receiver); assert.equal(receivedArgs[0], request); assert.equal(receivedArgs[1], options);
  await tick(); assert.equal(clones, 1); assert.equal(state.pending, 1); assert.equal(state.responses, 0);
  release(new TextEncoder().encode('safe business body').buffer); await tick();
  assert.equal(state.pending, 0); assert.equal(state.responses, 1); assert.equal(state.errors, 0);
});

test('fetch observer scans cloned UTF-8/UTF-16 response bodies and headers without publishing raw content', async () => {
  const updates = [];
  for (const [encoding, key] of [['utf8', SECURITY_KEY], ['utf16le', SECURITY_FISH_KEY]]) {
    const response = new Response(Buffer.from(`body:${key}`, encoding), { headers: { 'x-fixture': SECURITY_KEY } });
    Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/api/data/export' });
    const target = { fetch: () => Promise.resolve(response), __hwSecurityFetchUpdated: data => updates.push(data) };
    const state = installSecurityFetchObserver({ target, keys: [SECURITY_KEY, SECURITY_FISH_KEY], epoch: encoding });
    const original = await target.fetch('/api/data/export');
    assert.equal(original, response); assert.equal(original.bodyUsed, false);
    await original.arrayBuffer();
    for (let i = 0; state.pending && i < 50; i++) await tick();
    assert.equal(state.pending, 0); assert.equal(state.responses, 1); assert.equal(state.errors, 0);
    assert.equal(state.credentialFindings, 2);
  }
  assert.equal(credentialFindings(updates).length, 0, 'Only numeric counts and opaque epoch identifiers leave the observer');
});

test('clone failure is incomplete observation, while native network rejection retains original behavior', async () => {
  for (const clone of [() => { throw new Error('clone failed'); }, () => ({ arrayBuffer: () => Promise.reject(new Error('body failed')) })]) {
    const response = { url: 'http://127.0.0.1/api/listenings', headers: new Map(), clone };
    const target = { fetch: () => Promise.resolve(response) };
    const state = installSecurityFetchObserver({ target, epoch: 'clone-failed' });
    assert.equal(await target.fetch('/api/listenings'), response); await tick();
    assert.equal(state.errors, 1); assert.equal(state.pending, 0); assert.equal(state.responses, 0);
  }
  const rejection = new Error('network failure'), original = Promise.reject(rejection);
  const target = { fetch: () => original }, state = installSecurityFetchObserver({ target, epoch: 'network-failed' });
  const returned = target.fetch('/api/listenings'); assert.equal(returned, original);
  await assert.rejects(returned, error => error === rejection); await tick();
  assert.equal(state.responses, 0); assert.equal(state.errors, 0); assert.equal(state.pending, 0);
});


test('fetch observation includes pending native responses and synchronous failure preserves identity', async () => {
  let deliver; const pending = new Promise(resolve => { deliver = resolve; });
  const target = { fetch: () => pending }, state = installSecurityFetchObserver({ target, epoch: 'delayed-native' });
  assert.equal(target.fetch('/api/listenings'), pending); assert.equal(state.pending, 1); assert.equal(state.responses, 0);
  deliver({ url: 'http://127.0.0.1/api/listenings', headers: new Map(), clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) });
  await tick(); assert.equal(state.pending, 0); assert.equal(state.responses, 1);
  const error = new Error('native argument rejection'), throwing = { fetch() { throw error; } };
  const failed = installSecurityFetchObserver({ target: throwing, epoch: 'throws' });
  assert.throws(() => throwing.fetch(), value => value === error); assert.equal(failed.pending, 0);
});

test('fetch ledger retains old-navigation pending work and ignores stale callbacks without erasing errors', () => {
  const ledger = createSecurityFetchLedger(), observation = { sequence: 1, responses: 0, pending: 1, errors: 0, credentialFindings: 0 };
  ledger.update({ ...observation, epoch: 'old' }); ledger.update({ ...observation, epoch: 'current', pending: 0 });
  assert.equal(ledger.pending, 1, 'The current page pending=0 cannot erase an older page request');
  assert.equal(ledger.size, 2);
  assert.deepEqual(ledger.update({ ...observation, epoch: 'old', sequence: 2, pending: 0, responses: 1, errors: 1 }), { responses: 1, errors: 1, credentialFindings: 0 });
  assert.equal(ledger.pending, 0);
  ledger.update({ ...observation, epoch: 'old' }); assert.equal(ledger.pending, 0, 'A late earlier callback cannot resurrect or hide work');
  assert.throws(() => ledger.update({ ...observation, epoch: 'old', sequence: 3, errors: 0 }), /Regressed/);
  assert.throws(() => ledger.update({ epoch: 'incomplete' }), /Invalid/);
});
