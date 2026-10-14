import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportTrace, validateImportTrace, replayImportTrace } from '../scripts/lib/import-protocol-replay.mjs';
import { createImportProtocolAdapter } from '../test-support/import-protocol-adapter.mjs';

const initial = { lastHTTPStatus: 0, lastHTTPCode: '', businessIds: [0], clientGeneration: { 0: 0 }, clientMode: { 0: '' },
  clientCurrentCount: { 0: 0 }, clientAddedCount: { 0: 0 }, clientSkippedCount: { 0: 0 } };
const uploaded = { ...initial, lastHTTPStatus: 200, clientGeneration: { 0: 1 }, clientMode: { 0: 'append' }, clientCurrentCount: { 0: 1 }, clientAddedCount: { 0: 1 } };
const stale = { ...uploaded, lastHTTPStatus: 409, lastHTTPCode: 'IMPORT_PREVIEW_STALE' };
const step = (action, actor, expected, requestedMode = '', requestedGeneration = 0, fault = false) => ({ action, actor, expected, requestedMode, requestedGeneration, fault });
const trace = () => structuredClone({ schemaVersion: 1, specificationVersion: '1.0', config: { tokens: 1 }, initial, steps: [
  step('upload', 0, uploaded, 'append', 1), step('other_write', -1, uploaded), step('commit', 0, stale, 'append', 1)
] });

test('import replay compares actual HTTP/SQLite and preserves immutable observations', async () => {
  const result = await replayImportTrace(trace(), createImportProtocolAdapter);
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.observations.length, 4);
  assert.equal(result.observations[0].durable.events.length, 0);
  assert.equal(result.observations[1].durable.events.length, 1);
  assert.equal(result.observations[3].durable.events.length, 3);
  assert.deepEqual(result.observations[2].durable.snapshot, result.observations[3].durable.snapshot);
});

test('actual HTTP retained-revision deletion is detected at the first divergent commit', async () => {
  const result = await replayImportTrace(trace(), options => createImportProtocolAdapter({ ...options, mutation: 'skip_http_revision' }));
  assert.equal(result.ok, false); assert.equal(result.complete, true); assert.equal(result.classification, 'implementation_mismatch');
  assert.equal(result.difference.step, 2); assert.equal(result.difference.actual.lastHTTPStatus, 200);
  assert.equal(result.difference.expected.lastHTTPCode, 'IMPORT_PREVIEW_STALE');
  assert.deepEqual(result.difference.actual.businessIds, [0, 1]); assert.equal(result.counterexample.steps.length, 3);
  assert.equal(result.observations.at(-1).durable.mutation.id, 'skip_http_revision');
});

test('invalid trace domain and malformed model initialization fail closed before constructing an adapter', async () => {
  for (const mutate of [t => { t.config.tokens = 3; }, t => { t.initial.clientGeneration[1] = 0; },
    t => { t.steps[0].actor = -1; }, t => { t.steps[0].fault = true; }, t => { t.steps[1].expected.clientGeneration[0] = 3; },
    t => { t.steps[0].expected.businessIds = [0, 0]; }]) {
    const invalid = trace(); mutate(invalid); assert.equal(validateImportTrace(invalid), false);
    const result = await replayImportTrace(invalid, () => { throw new Error('Adapter must not be created'); });
    assert.equal(result.classification, 'unreplayable'); assert.equal(result.ok, false);
  }
  assert.throws(() => normalizeImportTrace({ vars: [], states: [] }, { tokens: 1 }));
});
