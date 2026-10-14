import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';

for (const id of ['qualified', 'independent', 'empty']) test(`offline semantic capture persists and reopens ${id}`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-capture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await captureSemanticOffline({ directory: path.join(root, 'capture'), sample: semanticFixtureSample(id), response: semanticFixtureResponse() });
  assert.equal(result.complete, true, JSON.stringify({ error: result.errorCode, results: result.results, errors: result.errors }));
  assert.equal(result.cleanup, true);
  assert.equal(result.qualityEvaluated, false);
  assert.equal(result.qualityStatus, 'not_run');
  assert.equal(result.liveCalls, 0);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.visible.graph.status.state, id === 'qualified' ? 'complete' : 'empty');
  assert.equal(result.units.filter(row => row.kind === 'entity').length, id === 'empty' ? 0 : 3);
  assert.equal(result.units.filter(row => row.kind === 'relation').length, id === 'qualified' ? 2 : 0);
});
