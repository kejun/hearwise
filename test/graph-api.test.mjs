import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphFixture } from '../test-support/graph-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, condition, timeout = 18000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await read(); if (condition(value)) return value; await sleep(60); }
  throw new Error('graph API did not reach expected state');
}

test('graph GET is read-only; POST scopes generation to selected listening and preserves stable nodes and evidence', async t => {
  const fixture = await graphFixture(); t.after(() => fixture.close());
  const { first, second } = fixture.seeded;
  const url = `${fixture.base}/api/listenings/${first.listeningId}/graph`;
  const read = async () => (await fetch(url)).json();
  const before = await read();
  assert.deepEqual(before.nodes.map(n => n.id).sort(), first.nodes.map(n => n.id).sort());
  assert.equal(before.relations.length, 0);
  assert.equal(fixture.stats.providerRequests.length, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }) })).status, 403);
  const generated = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }) });
  assert.equal(generated.status, 202);
  const graph = await until(read, graph => graph.relations.length === 1);
  assert.equal(graph.nodes.length, first.nodes.length);
  const edge = graph.relations[0];
  assert.equal(edge.predicate, 'released');
  assert.equal(edge.subject_item_id, first.nodes[0].id);
  assert.equal(edge.object_item_id, first.nodes[1].id);
  assert.equal(edge.assertions[0].time_scope, '1900');
  assert.ok(edge.assertions[0].supports.some(s => s.segment_id === first.evidence.id));
  assert.ok(graph.graphRevision > before.graphRevision);
  const evidence = await (await fetch(`${fixture.base}/api/listenings/${first.listeningId}/segments?ids=${first.evidence.id}`)).json();
  assert.equal(evidence.items[0].sequence_no, 104);
  assert.match(evidence.items[0].translation_text, /1900/);
  const other = await (await fetch(`${fixture.base}/api/listenings/${second.listeningId}/graph`)).json();
  assert.equal(other.relations.length, 0);
  assert.doesNotMatch(JSON.stringify(graph), /mock-key|Bearer/);
  assert.equal((await fetch(`${fixture.base}/knowledge-graph.js`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/api/listenings/00000000-0000-0000-0000-000000000000/graph`)).status, 404);
});

test('graph generation resumes restored pending knowledge instead of waiting behind an idle scheduler', { timeout: 16000 }, async t => {
  const { speechFixture } = await import('../test-support/speech-fixture.mjs');
  const { seedGraphListening } = await import('../test-support/graph-fixture.mjs');
  const fixture = await speechFixture({ seed: store => {
    const seeded = seedGraphListening(store, { extraNodes: 0 });
    const job = store.detail(seeded.listeningId).jobs[0];
    store.markJob(job.id, 'pending');
    return seeded;
  }, modelResponse: body => {
    if (body.model === 'qwen-mt-flash') return undefined;
    return JSON.parse(body.messages.at(-1).content).candidates ? { relations: [] } : { items: [] };
  } });
  t.after(() => fixture.close());
  const id = fixture.seeded.listeningId;
  const url = `${fixture.base}/api/listenings/${id}`;
  assert.equal((await fetch(`${url}/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-resume-key' }) })).status, 202);
  const state = await until(async () => (await fetch(url)).json(), detail => detail.processing.relations.requestCount > 0, 14000);
  assert.equal(state.processing.knowledge.pendingJobs, 0);
  assert.equal(state.processing.knowledge.runningJobs, 0);
});
