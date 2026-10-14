import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNameProtocolFixture } from '../test-support/name-protocol-fixture.mjs';
import { installNameWriteFault, removeNameWriteFault } from '../test-support/name-transaction-fixture.mjs';
async function submit(fixture, id, input) {
  const response = await fetch(fixture.url + '/name-replacements', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
test('three simultaneous exact HTTP attempts share one durable name transaction and receipt', async t => {
  const f = await createNameProtocolFixture(); t.after(() => f.close());
  const before = f.tables(), id = randomUUID(), input = { name: '😀 Longer', revision: f.snapshot().revision };
  const replies = await Promise.all(Array.from({ length: 3 }, () => submit(f, id, input)));
  assert.deepEqual(replies.map(row => row.status), [200, 200, 200]);
  assert.equal(replies.filter(row => row.body.changed).length, 1);
  for (const reply of replies) assert.deepEqual(reply.body.job, replies[0].body.job);
  const after = f.tables(); assert.equal(after.knowledge_edit_jobs.length - before.knowledge_edit_jobs.length, 1);
  assert.equal(after.knowledge_revisions.length - before.knowledge_revisions.length, 1);
  assert.equal(f.snapshot().item.canonical_name, input.name);
  const receipt = await fetch(`${f.url}/edits/${id}`).then(response => response.json()); assert.deepEqual(receipt.job, replies[0].body.job);
  assert.equal(f.stats.providerRequests.length, 0);
});
test('same-ID conflicting concurrent HTTP bodies choose one actual winner without relying on arrival order', async t => {
  const f = await createNameProtocolFixture(); t.after(() => f.close());
  const id = randomUUID(), revision = f.snapshot().revision;
  const replies = await Promise.all(['Tibo', 'Mira'].map(name => submit(f, id, { name, revision })));
  assert.deepEqual(replies.map(row => row.status).sort(), [200, 409]);
  const winner = replies.find(row => row.status === 200).body.job;
  assert.ok(['Tibo', 'Mira'].includes(winner.name)); assert.equal(winner.saved, true);
  assert.equal(f.snapshot().item.canonical_name, winner.name);
  assert.equal(f.tables().knowledge_edit_jobs.filter(row => row.id === id).length, 1);
  assert.equal(f.stats.providerRequests.length, 0);
});
test('actual HTTP receipt-boundary failure reports unsaved and allows the identical request after rollback', async t => {
  const f = await createNameProtocolFixture(); t.after(() => f.close());
  const id = randomUUID(), input = { name: 'Tibo', revision: f.snapshot().revision };
  installNameWriteFault(f.store, 'receipt-success'); const before = f.tables();
  const failed = await submit(f, id, input);
  assert.equal(failed.status, 502); assert.equal(failed.body.saved, false); assert.deepEqual(f.tables(), before);
  assert.equal((await fetch(`${f.url}/edits/${id}`)).status, 404);
  removeNameWriteFault(f.store, 'receipt-success');
  const saved = await submit(f, id, input); assert.equal(saved.status, 200); assert.equal(saved.body.job.saved, true);
  assert.equal(f.stats.providerRequests.length, 0);
});
