import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationFixture } from '../test-support/generation-isolation-fixture.mjs';

test('knowledge cancellation frees the logical slot while an ignored-abort request remains physical', { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'knowledge', capacity: 1 }); t.after(() => h.close());
  const a = h.addListening(), b = h.addListening();
  h.addTask(a, 'Atlas A'); h.addTask(b, 'Atlas B');
  h.enable(a); h.enable(b); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].listeningId, a);
  const budget = h.snapshot().durable.jobs.find(job => job.id === h.calls[0].jobId);
  assert.equal(budget.parts[0].initial_requests, 1);
  await h.cancel(a);
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls[0].status, 'pending');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].listeningId, b);
  const next = h.snapshot().durable.jobs.find(job => job.id === h.calls[1].jobId);
  await h.respond(0, 'ok');
  assert.equal(h.snapshot().queries[a].detail.knowledge.length, 0);
  assert.deepEqual(h.snapshot().durable.jobs.find(job => job.id === h.calls[1].jobId), next);
  assert.equal(h.scheduler.hasWork(b), true);
  await h.respond(1, 'ok');
  assert.equal(h.snapshot().queries[b].detail.knowledge[0].canonical_name, 'Atlas B');
  assert.equal(h.scheduler.hasWork(b), false);
  await h.respond(1, 'ok');
  assert.equal(h.snapshot().queries[b].detail.knowledge[0].content_version, 1);
});

test('relation cancellation opens a new round without moving late usage into the new owner', { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'relation', capacity: 1 }); t.after(() => h.close());
  const a = h.addListening(); h.addTask(a, 'Atlas A'); h.enable(a); await h.settle();
  assert.equal(h.calls.length, 1);
  const first = h.snapshot(), firstRound = first.queries[a].graph.status.round.id;
  await h.cancel(a);
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls[0].status, 'pending');
  h.enable(a); await h.advance();
  assert.equal(h.calls.length, 2);
  const newer = h.snapshot(); assert.notEqual(newer.queries[a].graph.status.round.id, firstRound);
  await h.respond(0, 'ok');
  let current = h.snapshot();
  assert.equal(current.queries[a].graph.relations.length, 0);
  assert.equal(current.queries[a].graph.status.round.totalTokens, 0);
  assert.equal(current.queries[a].graph.status.usageLastHour.totalTokens, 11);
  assert.equal(h.scheduler.hasWork(a), true);
  await h.respond(1, 'ok'); current = h.snapshot();
  assert.equal(current.queries[a].graph.relations.length, 1);
  assert.equal(current.queries[a].graph.status.round.totalTokens, 11);
  assert.equal(current.queries[a].graph.status.usageLastHour.totalTokens, 22);
  const committed = current.durable;
  await h.respond(0, 'ok'); await h.respond(1, 'ok');
  assert.deepEqual(h.snapshot().durable, committed, 'Repeated Promise settlement cannot repeat a business commit or fee record');
});

test('a new knowledge job on the same listening retains its budget and owner after the old response', { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'knowledge', capacity: 1 }); t.after(() => h.close());
  const a = h.addListening(); const oldJob = h.addTask(a, 'Atlas Old'); h.enable(a); await h.settle();
  await h.cancel(a);
  const nextJob = h.addTask(a, 'Atlas New'); assert.notEqual(nextJob, oldJob);
  h.enable(a); await h.advance(); assert.equal(h.calls.length, 2);
  const before = h.snapshot(), current = before.durable.jobs.find(job => job.id === nextJob);
  await h.respond(0, 'failure'); await h.respond(0, 'ok');
  const after = h.snapshot();
  assert.deepEqual(after.durable.jobs.find(job => job.id === nextJob), current);
  assert.equal(after.runtime.activeCount, 1); assert.equal(h.scheduler.hasWork(a), true);
  assert.equal(after.durable.jobs.find(job => job.id === oldJob).parts[0].initial_requests, 1);
  assert.equal(after.queries[a].detail.knowledge.length, 0);
  await h.respond(1, 'ok');
  assert.deepEqual(h.snapshot().queries[a].detail.knowledge.map(item => item.canonical_name), ['Atlas New']);
  assert.equal(h.snapshot().runtime.activeCount, 0);
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} delete, late result and restart retain public absence and another listening's data`, { timeout: 15000 }, async t => {
  const h = await createGenerationFixture({ protocol, capacity: 2 }); t.after(() => h.close());
  const a = h.addListening(), b = h.addListening(); h.addTask(a, 'Atlas Deleted'); h.addTask(b, 'Atlas Kept');
  h.enable(a); h.enable(b); await h.advance(); assert.equal(h.calls.length, 2);
  const removedCall = h.calls.find(call => call.listeningId === a), keptCall = h.calls.find(call => call.listeningId === b);
  await h.delete(a); const kept = h.snapshot().queries[b];
  await h.respond(removedCall.index, 'ok'); await h.respond(removedCall.index, 'failure');
  assert.equal(h.snapshot().queries[a].detail, null); assert.equal(h.snapshot().queries[a].graph, null);
  assert.deepEqual(h.snapshot().queries[b], kept);
  assert.equal(h.scheduler.hasWork(b), true);
  await h.respond(keptCall.index, 'ok');
  const reopened = await h.restartQueries([a, b]);
  assert.equal(reopened[a].detail.status, 404); assert.equal(reopened[a].graph.status, 404);
  assert.equal(reopened[b].detail.status, 200); assert.equal(reopened[b].graph.status, 200);
  assert.equal(reopened[b].detail.body.knowledge.some(item => item.canonical_name === 'Atlas Kept'), true);
  assert.equal(h.snapshot().durable.foreignKeys.length, 0);
});

test('relation onUsage callbacks remain bound to the cancelled attempt and duplicate upserts do not add fees', { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'relation', capacity: 1 }); t.after(() => h.close());
  const a = h.addListening(); h.addTask(a, 'Atlas Fees'); h.enable(a); await h.settle();
  await h.cancel(a); h.enable(a); await h.advance();
  assert.equal(h.calls.length, 2);
  await h.reportUsage(0, 7); await h.reportUsage(0, 7);
  let snapshot = h.snapshot();
  assert.equal(snapshot.queries[a].graph.status.usageLastHour.totalTokens, 7);
  assert.equal(snapshot.queries[a].graph.status.round.totalTokens, 0);
  assert.equal(snapshot.durable.relation_requests.find(row => row.job_id === h.calls[0].jobId).outcome, 'late_response');
  assert.equal(snapshot.durable.relation_requests.find(row => row.job_id === h.calls[1].jobId).usage_json, null);
  await h.respond(1, 'ok');
  await h.reportUsage(0, 9); await h.respond(0, 'empty');
  snapshot = h.snapshot();
  assert.equal(snapshot.queries[a].graph.status.round.totalTokens, 11);
  assert.equal(snapshot.queries[a].graph.status.usageLastHour.totalTokens, 22);
  assert.equal(snapshot.queries[a].graph.relations.length, 1);
});

for (const capacity of [1, 2]) test(`knowledge two listenings and three tasks retain FIFO and isolation with capacity ${capacity}`, { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'knowledge', capacity }); t.after(() => h.close());
  const a = h.addListening(), b = h.addListening();
  const first = h.addTask(a, 'Atlas A0'), second = h.addTask(a, 'Atlas A1'); h.addTask(b, 'Atlas B0');
  h.enable(a); h.enable(b); await h.settle();
  assert.equal(h.calls.length, capacity); assert.equal(h.calls[0].jobId, first);
  await h.cancel(a); h.enable(a); await h.advance();
  assert.equal(h.calls.find(call => call.listeningId === b)?.status, 'pending');
  const bCall = h.calls.find(call => call.listeningId === b); await h.respond(bCall.index, 'ok');
  await h.advance(); const aNext = h.calls.find(call => call.jobId === second); assert.ok(aNext);
  const before = h.snapshot().durable.jobs.find(job => job.id === second);
  await h.respond(0, 'ok');
  assert.deepEqual(h.snapshot().durable.jobs.find(job => job.id === second), before);
  assert.equal(h.scheduler.hasWork(a), true);
  await h.respond(aNext.index, 'ok');
  const snapshot = h.snapshot();
  assert.deepEqual(snapshot.queries[a].detail.knowledge.map(item => item.canonical_name), ['Atlas A1']);
  assert.deepEqual(snapshot.queries[b].detail.knowledge.map(item => item.canonical_name), ['Atlas B0']);
  assert.equal(snapshot.runtime.activeCount, 0);
});

for (const capacity of [1, 2]) test(`relation two listenings and three windows isolate cancelled requests with capacity ${capacity}`, { timeout: 10000 }, async t => {
  const h = await createGenerationFixture({ protocol: 'relation', capacity }); t.after(() => h.close());
  const a = h.addListening(), b = h.addListening();
  h.addTask(a, 'Atlas A0'); h.addTask(a, 'Atlas A1'); h.addTask(b, 'Atlas B0');
  h.enable(a); h.enable(b); await h.advance();
  assert.equal(h.calls.length, capacity); assert.equal(h.calls[0].name, 'Atlas A0');
  await h.cancel(a); h.enable(a); await h.advance();
  assert.ok(h.calls.some(call => call.listeningId === b));
  await h.respond(0, 'ok');
  assert.equal(h.snapshot().queries[a].graph.relations.length, 0);
  // Keep every physical response and advance the real queue's configured 2s
  // admission clock. No private running-map access or forced job dispatch.
  for (let step = 0; step < 6; step++) {
    for (const call of [...h.calls]) if (call.index && call.status === 'pending') await h.respond(call.index, 'ok');
    await h.advance();
  }
  assert.equal(h.calls.length, 4); assert.equal(h.calls.filter(call => call.status === 'pending').length, 0);
  const snapshot = h.snapshot();
  assert.equal(snapshot.queries[a].graph.relations.length, 2); assert.equal(snapshot.queries[b].graph.relations.length, 1);
  assert.equal(snapshot.queries[a].graph.status.round.totalTokens, 22);
  assert.equal(snapshot.queries[a].graph.status.usageLastHour.totalTokens, 33);
  assert.equal(h.scheduler.hasWork(a), false); assert.equal(h.scheduler.hasWork(b), false);
});
