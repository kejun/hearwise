import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { semanticFixtureSample, semanticFixtureResponse, semanticMutations } from '../test-support/semantic-quality-fixture.mjs';

for (const id of ['qualified', 'independent', 'empty']) test(`offline semantic capture persists and reopens ${id}`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-capture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await captureSemanticOffline({ directory: path.join(root, 'capture'), sample: semanticFixtureSample(id), response: semanticFixtureResponse() });
  assert.equal(result.complete, true, JSON.stringify({ error: result.errorCode, results: result.results, errors: result.errors }));
  assert.equal(result.cleanup, true);
  assert.equal(result.qualityEvaluated, false);
  assert.equal(result.qualityStatus, 'not_run');
  assert.equal(result.liveCalls, 0);
  const expected = structuredClone(result.before);
  for (const row of expected.tables.listenings) row.relation_waiting_key = row.relation_enabled;
  assert.deepEqual(result.after, expected);
  assert.equal(result.visible.graph.status.state, id === 'qualified' ? 'complete' : 'empty');
  assert.equal(result.units.filter(row => row.kind === 'entity').length, id === 'empty' ? 0 : 3);
  assert.equal(result.units.filter(row => row.kind === 'relation').length, id === 'qualified' ? 2 : 0);
});

for (const mutation of semanticMutations) test(`structurally valid ${mutation} remains visible in persisted semantic evidence`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-mutation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sample = semanticFixtureSample();
  if (mutation === 'duplicate') { sample.segments.push(sample.segments[0]); sample.ingestionBatchSize = 1; }
  const r = await captureSemanticOffline({ directory: path.join(root, 'capture'), sample, response: semanticFixtureResponse(mutation) });
  assert.equal(r.complete, true); assert.equal(r.qualityEvaluated, false);
  assert.deepEqual(r.errors, []);
  assert.ok(r.results.every(row => !row.result.rejected?.length));
  assert.ok(r.calls.every(row => row.kind !== 'repair'));
  const units = kind => r.units.filter(row => row.kind === kind);
  const atlas = units('entity').find(row => row.value.canonical_name === 'Atlas');
  assert.ok(atlas);
  if (mutation === 'number') assert.ok(units('fact').some(row => row.value.content.includes('150 dollars')));
  if (mutation === 'negation') assert.ok(units('relation').every(row => row.value.polarity === 'positive'));
  if (mutation === 'condition') assert.ok(units('relation').every(row => row.value.modality === 'asserted' && row.value.conditions === null));
  if (mutation === 'attribution') {
    const orion = units('entity').find(row => row.value.canonical_name === 'Orion');
    assert.ok(units('relation').every(row => row.relation.subject_item_id === orion.value.id));
  }
  if (mutation === 'merge') { assert.equal(units('entity').length, 2); assert.ok(atlas.aliases.some(row => row.alias === 'Nova')); }
  if (mutation === 'duplicate') { assert.equal(units('fact').filter(row => row.value.item_id === atlas.value.id).length, 2); assert.equal(r.calls.filter(row => row.kind === 'knowledge').length, 2); }
  if (mutation === 'unsupported') assert.ok(units('relation').some(row => row.relation.predicate === 'uses'));
  if (mutation === 'upstream-omission') { assert.equal(units('entity').length, 1); assert.equal(units('relation').length, 0); assert.equal(r.calls.filter(row => row.kind === 'relation').length, 0); }
});
