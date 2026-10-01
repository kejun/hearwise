import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAdmission } from '../provider-admission.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('foreground admission is observed but translation never waits for an in-flight relation', async () => {
  const metrics = [];
  const provider = createProviderAdmission({ onMetric: event => metrics.push(event) });
  const relation = deferred(), translation = deferred();
  const graph = provider.run({ key: 'private', priority: 'relations' }, () => relation.promise);
  assert.equal(provider.canStartBackground(), true);
  let began = false;
  const caption = provider.run({ key: 'private', priority: 'translation' }, () => { began = true; return translation.promise; });
  assert.equal(began, true);
  assert.equal(provider.canStartBackground(), false);
  translation.resolve('caption'); assert.equal(await caption, 'caption');
  assert.equal(provider.canStartBackground(), true);
  relation.resolve('graph'); assert.equal(await graph, 'graph');
  assert.equal(metrics.length, 2);
  assert.doesNotMatch(JSON.stringify(metrics), /private|caption|graph/);
});

test('knowledge and graph share full model cooldown; MT 429 does not stop another model', async () => {
  let now = 100;
  const provider = createProviderAdmission({ now: () => now });
  await assert.rejects(provider.run({ key: 'a', priority: 'knowledge' }, async () => { throw Object.assign(new Error('secret body'), { status: 429, retryAfterMs: 3000 }); }));
  assert.equal(provider.readyAt('a'), 3100);
  assert.equal(provider.readyAt('b'), 0);
  provider.coolDown('a', 1000); assert.equal(provider.readyAt('a'), 3100);
  await assert.rejects(provider.run({ key: 'b', priority: 'translation' }, async () => { throw Object.assign(new Error('rate'), { status: 429, retryAfterMs: 9000 }); }));
  assert.equal(provider.readyAt('b'), 0);
  now = 3100; assert.equal(provider.readyAt('a'), 0);
  provider.coolDown('a', 99999999); assert.equal(provider.readyAt('a'), now + 99999999);
  provider.release('a'); assert.equal(provider.readyAt('a'), now + 99999999);
  now += 99999999; assert.equal(provider.readyAt('a'), 0);
});

test('aborted admission never sends a request; metric callback cannot fail successful foreground work', async () => {
  const provider = createProviderAdmission({ onMetric: () => { throw new Error('diagnostic'); } });
  let called = false;
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(provider.run({ priority: 'relations', signal }, () => { called = true; }));
  assert.equal(called, false);
  assert.equal(await provider.run({ priority: 'translation' }, async () => 'ok'), 'ok');
  assert.equal(provider.canStartBackground(), true);
});
