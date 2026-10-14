import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditProtocolAdapter } from '../test-support/edit-protocol-adapter.mjs';
import { validMatchedEditDurable } from '../scripts/lib/edit-protocol-durable.mjs';

const config = { clients: 2, codecs: { 0: 'v1', 1: 'v1' }, initialOverride: false, background: true };
const step = (action, actor, argument = '') => ({ action, actor, argument });
const capture = adapter => ({ actual: adapter.project(), durable: adapter.observe() });

test('durable gate checks actual HTTP/SQLite facts independently of cached projection and violation claims', { timeout: 15000 }, async () => {
  const adapter = await createEditProtocolAdapter(config), observations = [];
  try {
    observations.push(capture(adapter));
    for (const action of [step('read', 0), step('read', 1), step('edit', 0, 'new'), step('edit', 1, 'new'),
      step('send', 0), step('send', 1), step('transaction', 0, 'ok'), step('notify', 0, 'ok'),
      step('transaction', 1, 'ok'), step('deliver', 0), step('deliver', 1), step('refresh_stale', 1), step('refresh_saved', 0)]) {
      await adapter.act(action); observations.push(capture(adapter));
    }
    // These are actual raw-observation contract tests, not fabricated Quint or
    // implementation-conformance evidence: no expected model trace is derived.
    observations.forEach((observation, index) => assert.equal(validMatchedEditDurable(observation, config), true, `Actual observation ${index}`));
    const complete = observations.at(-1);
    const mutations = [
      ['empty observation', value => { value.durable = {}; }],
      ['provider call', value => { value.durable.providerCalls = 3; }],
      ['missing snapshot', value => { delete value.durable.snapshot; }],
      ['false durable name', value => { value.durable.snapshot.item.canonical_name = 'Mira'; }],
      ['wrong revision mapping', value => { value.durable.versions[0] = '0'.repeat(64); }],
      ['missing client', value => { value.durable.clients.pop(); }],
      ['silent second request', value => { value.durable.clients[0].requests++; }],
      ['wrong request token', value => { value.durable.clients[0].actualRequest.revision = '0'.repeat(64); }],
      ['missing receipt', value => { value.durable.jobs = []; }],
      ['wrong receipt name', value => { value.durable.jobs[0].name = 'Mira'; }],
      ['false successful response', value => {
        const response = value.durable.clients[0].actualResponse, body = JSON.parse(response.text);
        body.job.saved = false; response.text = JSON.stringify(body);
      }],
      ['missing transaction checkpoint', value => { value.durable.events = value.durable.events.filter(event => event.action !== 'transaction'); }],
      ['wrong graph item', value => { value.durable.graph.nodes.find(node => node.id === value.durable.snapshot.item.id).canonical_name = 'Mira'; }]
    ];
    for (const [label, mutate] of mutations) {
      const value = structuredClone(complete); mutate(value);
      assert.equal(validMatchedEditDurable(value, config), false, label);
    }
  } finally { await adapter.close(); }
});

test('durable gate accepts no-op receipt without a notification and fails closed for malformed observations', { timeout: 10000 }, async () => {
  const one = { ...config, clients: 1, codecs: { 0: 'v1' } }, adapter = await createEditProtocolAdapter(one);
  try {
    for (const action of [step('read', 0), step('edit', 0, 'same'), step('send', 0), step('transaction', 0, 'ok'), step('deliver', 0)]) {
      await adapter.act(action); assert.equal(validMatchedEditDurable(capture(adapter), one), true);
    }
    for (const value of [undefined, null, {}, { actual: {}, durable: {} }]) assert.equal(validMatchedEditDurable(value, one), false);
  } finally { await adapter.close(); }
});
