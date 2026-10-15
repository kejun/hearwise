import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationFixture } from '../test-support/generation-isolation-fixture.mjs';

for (const protocol of ['knowledge', 'relation']) test(`${protocol} explicit provider permission consumes exactly one real admission and reserves before send`, { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol, capacity: 2, controlledAdmission: true }); t.after(() => h.close());
  const a = h.addListening(), b = h.addListening(); h.addTask(a, 'Atlas First'); h.addTask(b, 'Atlas Second');
  h.enable(a); h.enable(b); await h.settle(); assert.equal(h.calls.length, 0);
  h.permitAdmission(); await h.admit();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].listeningId, a); assert.equal(h.calls[0].sent, false);
  let snapshot = h.snapshot();
  assert.equal(snapshot.ledger.filter(row => row.event === 'provider_started').length, 0);
  if (protocol === 'knowledge') assert.equal(snapshot.durable.jobs.find(job => job.id === h.calls[0].jobId).parts[0].initial_requests, 1);
  else { assert.equal(snapshot.durable.relation_jobs.find(job => job.id === h.calls[0].jobId).request_count, 1); assert.equal(snapshot.durable.relation_requests.length, 1); }
  await assert.rejects(h.respond(0, 'ok'), /actual provider send/);
  await h.send(0); h.permitAdmission(); await h.admit(); await h.send(1);
  assert.equal(h.calls[1].listeningId, b); assert.equal(h.calls.filter(call => !call.signal.aborted && call.status === 'pending').length, 2);
  await h.respond(0, 'ok'); await h.respond(1, 'ok'); snapshot = h.snapshot();
  assert.equal(snapshot.admission.permit, false);
  assert.equal(snapshot.ledger.filter(row => row.event === 'admission_permit').length, 2);
  assert.equal(snapshot.ledger.filter(row => row.event === 'admission_consumed').length, 2);
  assert.equal(snapshot.ledger.filter(row => row.event === 'provider_started').length, 2);
  assert.equal(snapshot.errors.length, 0);
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} cancellation between durable reservation and physical send cannot invoke the provider`, { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol, capacity: 1, controlledAdmission: true }); t.after(() => h.close());
  const a = h.addListening(); h.addTask(a, 'Atlas Cancelled'); h.enable(a);
  h.permitAdmission(); await h.admit(); await h.cancel(a);
  assert.equal(h.calls[0].sent, false); assert.equal(h.calls[0].signal.aborted, true);
  await assert.rejects(h.send(0), /false/);
  assert.equal(h.snapshot().ledger.filter(row => row.event === 'provider_started').length, 0);
  assert.equal(h.snapshot().executions.every(execution => execution.settled), true);
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} a real reopened scheduler admits an existing pending task with its original identity`, { timeout: 15000 }, async t => {
  const h = await createGenerationFixture({ protocol, capacity: 1, controlledAdmission: true }); t.after(() => h.close());
  const id = h.addListening(); h.addTask(id, 'Atlas Reopened'); h.enable(id); await h.settle();
  assert.equal(h.calls.length, 0);
  const before = h.snapshot(), queries = await h.restartQueries([id]);
  assert.equal(queries[id].detail.status, 200); assert.equal(queries[id].graph.status, 200);
  h.permitAdmission(); await h.admit(); await h.send(0); await h.respond(0, 'ok');
  const after = h.snapshot();
  assert.deepEqual({ ...after.database, storeGeneration: 0 }, { ...before.database, storeGeneration: 0 });
  assert.equal(after.database.storeGeneration, before.database.storeGeneration + 1);
  const closed = after.ledger.find(entry => entry.event === 'local_resources_closed');
  assert.equal(closed.activeExecutions, 0); assert.equal(closed.timers, 0);
  if (protocol === 'knowledge') assert.equal(closed.activeCount, 0);
  assert.equal(after.calls.length, 1); assert.equal(after.calls[0].listeningId, id);
  assert.equal(after.ledger.filter(entry => entry.event === 'admission_consumed').length, 1);
  if (protocol === 'knowledge') {
    assert.equal(after.calls[0].jobId, before.durable.jobs[0].id);
    assert.equal(after.durable.jobs[0].parts[0].initial_requests, 1);
    assert.equal(after.queries[id].detail.knowledge[0].canonical_name, 'Atlas Reopened');
  } else {
    assert.equal(after.durable.relation_requests.length, 1);
    assert.equal(after.queries[id].graph.relations.length, 1);
  }
  assert.equal(after.errors.length, 0);
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} deleted physical work remains isolated after the actual store and scheduler reopen`, { timeout: 15000 }, async t => {
  const h = await createGenerationFixture({ protocol, capacity: 1, controlledAdmission: true }); t.after(() => h.close());
  const id = h.addListening(), kept = h.addListening(); h.addTask(id, 'Atlas Removed'); h.addTask(kept, 'Atlas Current'); h.enable(id); h.enable(kept);
  h.permitAdmission(); await h.admit(); await h.send(0); await h.delete(id);
  assert.equal(h.calls[0].status, 'pending'); assert.equal(h.calls[0].signal.aborted, true);
  const queries = await h.restartQueries([id]);
  assert.equal(queries[id].detail.status, 404); assert.equal(queries[id].graph.status, 404);
  h.permitAdmission(); await h.admit(); await h.send(1);
  assert.equal(h.calls[1].listeningId, kept);
  const before = h.snapshot().durable;
  await h.respond(0, 'ok');
  assert.deepEqual(h.snapshot().durable, before);
  assert.equal(h.snapshot().calls[0].transportSettled, true);
  assert.equal(h.snapshot().queries[id].detail, null); assert.equal(h.snapshot().queries[id].graph, null);
  assert.equal(h.calls[1].signal.aborted, false); assert.equal(h.calls[1].status, 'pending');
  assert.equal(h.scheduler.hasWork(kept), true);
  const closed = h.snapshot().ledger.find(entry => entry.event === 'local_resources_closed');
  assert.equal(closed.activeExecutions, 0); assert.equal(closed.timers, 0);
  await h.respond(1, 'ok');
  if (protocol === 'relation') {
    assert.ok(h.snapshot().ledger.some(entry => entry.event === 'workflow_presence_checked' && entry.jobId === h.calls[0].jobId && entry.error === 'ERR_INVALID_STATE'));
    assert.equal(h.snapshot().queries[kept].graph.relations.length, 1);
  } else assert.equal(h.snapshot().queries[kept].detail.knowledge[0].canonical_name, 'Atlas Current');
});
