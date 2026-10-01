import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphFixture } from '../test-support/graph-fixture.mjs';
import { relationWireEnvelope, relationWireRow } from '../test-support/relation-wire-fixture.mjs';

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
    const input = JSON.parse(body.messages.at(-1).content);
    return input.candidates ? relationWireEnvelope(input) : { items: [] };
  } });
  t.after(() => fixture.close());
  const id = fixture.seeded.listeningId;
  const url = `${fixture.base}/api/listenings/${id}`;
  assert.equal((await fetch(`${url}/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-resume-key' }) })).status, 202);
  const state = await until(async () => (await fetch(url)).json(), detail => detail.processing.relations.requestCount > 0, 14000);
  assert.equal(state.processing.knowledge.pendingJobs, 0);
  assert.equal(state.processing.knowledge.runningJobs, 0);
});

test('graph DELETE cancels an in-flight request, preserves nodes and allows explicit bounded continuation', { timeout: 22000 }, async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const fixture = await graphFixture({ modelResponse: async body => {
    if (body.model === 'qwen-mt-flash') return undefined;
    const input = JSON.parse(body.messages.at(-1).content);
    if (!input.candidates) return { items: [] };
    began(); await blocked;
    const subject = input.candidates.find(item => item.canonical_name === 'Eastman Kodak');
    const object = input.candidates.find(item => item.canonical_name === 'Brownie camera');
    const segment = input.focus_segments.find(item => item.text.includes('Eastman Kodak released'));
    return !subject || !object || !segment ? relationWireEnvelope(input) : relationWireEnvelope(input, [relationWireRow(input, {
      subject_item_id: subject.id, object_item_id: object.id, predicate: 'released',
      statement: 'Eastman Kodak released the Brownie camera in 1900.', polarity: 'positive', modality: 'asserted',
      conditions: null, time_scope: '1900', attribution: null, status: 'active', correction_of: null,
      supports: [{ segment_id: segment.id, quote: segment.text, role: 'relation' }]
    })]);
  } });
  t.after(async () => { release(); await fixture.close(); });
  const url = `${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`;
  const read = async () => (await fetch(url)).json();
  const initial = await read();
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-cancel-key' }) })).status, 202);
  await started;
  const running = await read();
  assert.equal(running.status.runningJobs, 1);
  assert.equal((await fetch(url, { method: 'DELETE', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await read()).status.round.id, running.status.round.id);
  const cancelled = await fetch(url, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  const stop = await cancelled.json();
  assert.equal(stop.status.state, 'cancelled');
  assert.equal(stop.status.round.stopReason, 'USER_CANCELLED');
  assert.equal(stop.status.round.id, running.status.round.id);
  assert.equal(stop.status.runningJobs, 0);
  const repeat = await (await fetch(url, { method: 'DELETE' })).json();
  assert.equal(repeat.status.round.id, stop.status.round.id);
  assert.equal(repeat.status.round.requestCount, stop.status.round.requestCount);
  release(); await sleep(150);
  const after = await read();
  assert.equal(after.status.state, 'cancelled');
  assert.deepEqual(after.nodes.map(n => n.id), initial.nodes.map(n => n.id));
  assert.equal(after.relations.length, 0);
  const resumed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-cancel-key' }) });
  assert.equal(resumed.status, 202);
  const next = await resumed.json();
  assert.notEqual(next.status.round.id, stop.status.round.id);
  assert.equal(next.status.round.maxRequests, undefined);
  assert.equal(next.status.round.deadlineAt, undefined);
  assert.equal(next.status.limits.maxWindowRequests, 3);
  const finished = await until(read, graph => graph.relations.length === 1);
  assert.equal(finished.relations.length, 1);
  assert.equal((await fetch(`${fixture.base}/api/listenings/00000000-0000-0000-0000-000000000000/graph`, { method: 'DELETE' })).status, 404);
});

test('server startup keeps recovered runs waiting for a key without paid requests', { timeout: 12000 }, async t => {
  const { speechFixture } = await import('../test-support/speech-fixture.mjs');
  const { seedGraphListening } = await import('../test-support/graph-fixture.mjs');
  const fixture = await speechFixture({ seed: store => {
    const seeded = seedGraphListening(store, { extraNodes: 0 });
    store.enableRelations(seeded.listeningId, { now: Date.now() - 180000 });
    return { ...seeded, round: store.relationProcessing(seeded.listeningId).round };
  } });
  t.after(() => fixture.close());
  const url = `${fixture.base}/api/listenings/${fixture.seeded.listeningId}/graph`;
  const graph = await until(async () => (await fetch(url)).json(), value => value.status.state === 'waiting_key', 7000);
  assert.equal(graph.status.round.id, fixture.seeded.round.id);
  assert.equal(graph.status.round.deadlineAt, undefined); assert.equal(graph.status.round.stopReason, null);
  assert.equal(graph.status.round.requestCount, 0); assert.equal(fixture.stats.providerRequests.length, 0);
});

test('explicit problem-window retry recovers rejected output and diagnostics without replay on GET or stale POST', { timeout: 25000 }, async t => {
  let responses = 0;
  const fixture = await graphFixture({ modelResponse: body => {
    if (body.model === 'qwen-mt-flash') return undefined;
    const input = JSON.parse(body.messages.at(-1).content);
    if (!input.candidates) return { items: [] };
    const subject = input.candidates.find(c => c.canonical_name === 'Eastman Kodak');
    const object = input.candidates.find(c => c.canonical_name === 'Brownie camera');
    const segment = input.focus_segments.find(s => s.text.includes('Eastman Kodak released'));
    if (!subject || !object || !segment) return relationWireEnvelope(input);
    responses++;
    return relationWireEnvelope(input, [relationWireRow(input, { subject_item_id: subject.id, object_item_id: object.id, predicate: 'released',
      statement: 'Eastman Kodak released Brownie camera in 1900.', polarity: responses === 1 ? undefined : 'positive',
      modality: 'asserted', status: 'active', time_scope: '1900',
      supports: [{ segment_id: segment.id, quote: segment.text, role: 'relation' }] })]);
  } });
  t.after(() => fixture.close());
  const url = `${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`;
  const read = async () => (await fetch(url)).json();
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ key: 'mock-selective-key' })).status, 202);
  const rejected = await until(read, graph => graph.status.state === 'partial');
  const { diagnostics } = rejected.status;
  assert.equal(rejected.relations.length, 0); assert.equal(diagnostics.returnedCount, 1);
  assert.equal(diagnostics.acceptedCount, 0); assert.equal(diagnostics.rejectedCount, 1);
  assert.equal(diagnostics.rejectionReasons[0].code, 'QUALIFICATION_INVALID');
  assert.equal(rejected.status.canRetryProblems, true);
  const requests = fixture.stats.providerRequests.length;
  await read(); await read(); await sleep(100);
  assert.equal(fixture.stats.providerRequests.length, requests, 'read-only refresh never repeats model work');
  const epoch = rejected.status.round.epoch;
  assert.equal((await post({ key: 'mock-selective-key', retry: 'failed_partial' })).status, 400);
  assert.equal((await post({ key: 'mock-selective-key', retry: 'all', expectedEpoch: epoch })).status, 400);
  assert.equal((await post({ key: 'mock-selective-key', retry: 'failed_partial', expectedEpoch: epoch })).status, 202);
  assert.equal((await post({ key: 'mock-selective-key', retry: 'failed_partial', expectedEpoch: epoch })).status, 409);
  const recovered = await until(read, graph => graph.relations.length === 1);
  assert.equal(responses, 2); assert.equal(recovered.status.diagnostics.acceptedCount, 1);
  assert.equal(recovered.status.diagnostics.rejectedCount, 0, 'latest-window results replace historical rejection totals');
  assert.equal(recovered.status.diagnostics.visibleRelationCount, 1);
  assert.equal(recovered.status.diagnostics.storedRelationCount, 1);
  assert.equal(recovered.status.retryableWindows, 0);
  assert.doesNotMatch(JSON.stringify(recovered.status.diagnostics), /mock-selective-key|Bearer|Kodak|Brownie/);
});
