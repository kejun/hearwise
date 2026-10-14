import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGenerationFixture } from '../test-support/generation-isolation-fixture.mjs';
import { loadRelationCommitGuardVariant, relationCommitGuardVariant, relationCommitGuardAnchor } from '../test-support/generation-commit-variant.mjs';

test('old-context transaction guard rejects a real late payload while the exact isolated source mutant commits it', { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'relation', capacity: 1, controlledAdmission: true }); t.after(() => h.close());
  const id = h.addListening(); h.addTask(id, 'Atlas Guard'); h.enable(id);
  h.permitAdmission(); await h.admit(); await h.send(0); await h.cancel(id); h.enable(id); await h.settle();
  h.permitAdmission(); await h.admit(); await h.send(1); await h.respond(0, 'ok');
  const old = h.calls[0], current = h.calls[1], before = h.snapshot();
  assert.equal(old.signal.aborted, true); assert.equal(current.signal.aborted, false); assert.equal(current.status, 'pending');
  const oldJob = before.durable.relation_jobs.find(row => row.id === old.jobId), currentJob = before.durable.relation_jobs.find(row => row.id === current.jobId);
  assert.equal(oldJob.epoch + 1, currentJob.epoch); assert.equal(oldJob.state, 'cancelled'); assert.equal(currentJob.state, 'running');
  assert.equal(before.durable.relations.length, 0);
  // This directly exercises the transaction's defense in depth. Normal workflow
  // abort already rejected the old continuation; no claim that it reached here.
  const normal = h.store.commitRelationJob(old.jobId, old.responseValue);
  assert.equal(normal.stale, true); assert.equal(normal.changed, false);
  assert.equal(h.snapshot().durable.relations.length, 0);
  assert.deepEqual(h.snapshot().durable.relation_jobs.find(row => row.id === current.jobId), currentJob);
  // The guard may label only the old usage row stale. Its real onUsage callback
  // is allowed to update that same row; this restores the exact identical input
  // for the variant without manually editing any persistent task state.
  await h.reportUsage(0, 11); assert.deepEqual(h.snapshot().durable, before.durable);
  const variant = await loadRelationCommitGuardVariant();
  assert.equal(variant.metadata.replacedCount, 1); assert.notEqual(variant.metadata.variantSha256, variant.metadata.originalSha256);
  const result = variant.commit.call(h.store, old.jobId, old.responseValue), after = h.snapshot();
  assert.equal(result.stale, false); assert.equal(result.accepted, 1);
  assert.equal(after.durable.relations.length, 1);
  assert.equal(after.durable.relation_supports[0].job_id, old.jobId, 'the copied actual source accepted the stale owner');
  assert.equal(after.durable.relation_windows[0].state, 'complete', 'the stale commit altered the current window');
  assert.deepEqual(after.durable.relation_jobs.find(row => row.id === current.jobId), currentJob);
  assert.equal(current.signal.aborted, false); assert.equal(current.status, 'pending');
});

test('guard variant fails closed if the exact production anchor is missing or duplicated', async () => {
  const source = await readFile(new URL('../relation-storage.mjs', import.meta.url), 'utf8');
  assert.throws(() => relationCommitGuardVariant(source.replace(relationCommitGuardAnchor, 'if (true) {')), /exactly one/);
  assert.throws(() => relationCommitGuardVariant(source + relationCommitGuardAnchor), /exactly one/);
});
