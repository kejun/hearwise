import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readKnowledgeView, saveKnowledgeView, filterGraph, stableGraphLayout, relationLabel, assertionQualifiers,
  createGraphSnapshotLoader, graphStatusText } from '../public/knowledge-graph.js';

const nodes = [
  { id: 'a', canonical_name: 'Acme', display_label: 'organization', short_description: 'A studio', aliases: ['艾克米'] },
  { id: 'b', canonical_name: 'Camera', display_label: 'product' },
  { id: 'c', canonical_name: 'Island', display_label: 'place' }
];
const relation = { id: 'ab', subject_item_id: 'a', object_item_id: 'b', predicate: 'released', assertions: [{ id: 'claim', status: 'active', polarity: 'positive', modality: 'asserted' }] };
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id, revision, extra = {}) => ({ listeningId: id, graphRevision: revision, nodes: [], relations: [], ...extra });
function clock() {
  const calls = new Map(); let n = 0;
  return { setTimer(fn) { calls.set(++n, fn); return n; }, clearTimer(id) { calls.delete(id); }, tick() { const entries = [...calls]; calls.clear(); for (const [, fn] of entries) fn(); }, get size() { return calls.size; } };
}

test('list default, graph preference, corrupt and inaccessible storage all work', () => {
  assert.equal(readKnowledgeView({ getItem: () => null }), 'list');
  assert.equal(readKnowledgeView({ getItem: () => 'corrupt' }), 'list');
  assert.equal(readKnowledgeView({ getItem: () => 'graph' }), 'graph');
  assert.equal(readKnowledgeView({ getItem() { throw Error('denied'); } }), 'list');
  assert.doesNotThrow(() => saveKnowledgeView({ setItem() { throw Error('denied'); } }, 'graph'));
});

test('filters preserve isolated nodes, never invent dangling edges and report total', () => {
  const result = filterGraph(nodes, [relation]);
  assert.deepEqual(result.nodes.map(n => n.id), ['a', 'b', 'c']);
  assert.equal(result.total, 3);
  assert.deepEqual(filterGraph(nodes, [relation], { localId: 'a' }).nodes.map(n => n.id), ['a', 'b']);
  assert.deepEqual(filterGraph(nodes, [relation], { type: '地点' }).nodes.map(n => n.id), ['c']);
  assert.deepEqual(filterGraph(nodes, [relation], { query: '艾克米' }).nodes.map(n => n.id), ['a']);
  assert.equal(filterGraph(nodes, [{ ...relation, object_item_id: 'missing' }]).relations.length, 0);
  assert.equal(filterGraph(nodes, [{ ...relation, assertions: [{ status: 'stale' }] }]).relations.length, 0);
  assert.equal(filterGraph(nodes, [{ ...relation, assertions: [{ status: 'superseded' }] }]).relations.length, 0);
});

test('stable layout retains all positions through arrivals, rename, filtering and relation changes', () => {
  const first = stableGraphLayout(nodes, [relation]);
  const later = [...nodes.map(n => n.id === 'a' ? { ...n, canonical_name: 'Renamed' } : n), { id: 'aa' }, { id: 'd' }];
  const second = stableGraphLayout(later, [{ ...relation, subject_item_id: 'aa' }], first);
  for (const n of nodes) assert.deepEqual(second.get(n.id), first.get(n.id));
  assert.equal(new Set([...second.values()].map(p => `${p.x},${p.y}`)).size, later.length);
  assert.deepEqual(stableGraphLayout(nodes.slice().reverse(), [relation]), first);
  const large = stableGraphLayout(Array.from({ length: 250 }, (_, i) => ({ id: `node-${i}` })), []);
  assert.equal(large.size, 250);
  assert.equal(new Set([...large.values()].map(p => `${p.col},${p.row}`)).size, 250);
});

test('edge and detail labels do not flatten negative, planned, uncertain, temporal or attributed claims', () => {
  const assertion = { status: 'needs_review', polarity: 'negative', modality: 'planned', time_scope: 'in 1999', attribution: 'the host', conditions: 'if funded' };
  assert.match(relationLabel({ ...relation, assertions: [assertion] }), /否定·计划·待核对·时间限定·有条件·转述/);
  assert.match(assertionQualifiers(assertion).join(' '), /in 1999/);
  assert.match(assertionQualifiers(assertion).join(' '), /if funded/);
  assert.match(relationLabel({ ...relation, assertions: [{ ...assertion, modality: 'uncertain' }] }), /推测/);
});

test('status distinguishes opt-in, missing key, zero results, failure and partial completion', () => {
  assert.match(graphStatusText({ enabled: false, pendingJobs: 3 }), /尚未生成/);
  assert.match(graphStatusText({ state: 'waiting_key', pendingJobs: 2 }), /需.*API Key/);
  assert.match(graphStatusText({ state: 'empty' }), /暂无有明确依据/);
  assert.match(graphStatusText({ partialJobs: 1 }), /部分完成/);
  assert.match(graphStatusText({ failedJobs: 1 }), /失败/);
});

test('coalesced invalidations reject in-flight stale revision and read latest snapshot', async () => {
  const timers = clock(), requests = [], received = [];
  const loader = createGraphSnapshotLoader({ ...timers, read: (id, signal) => new Promise(resolve => requests.push({ id, signal, resolve })), onSnapshot: s => received.push(s) });
  loader.select('a'); timers.tick(); assert.equal(requests.length, 1);
  loader.invalidate('a', 2); loader.invalidate('a', 4); loader.invalidate('a', 3);
  requests[0].resolve(snapshot('a', 1)); await flush(); assert.equal(received.length, 0); assert.equal(timers.size, 1);
  timers.tick(); requests[1].resolve(snapshot('a', 4)); await flush(); assert.equal(received[0].graphRevision, 4);
  loader.invalidate('a', 2); assert.equal(timers.size, 0);
  loader.stop();
});

test('listening generation protects A→B→A and aborts old reads without accepting wrong response identity', async () => {
  const timers = clock(), requests = [], received = [];
  const loader = createGraphSnapshotLoader({ ...timers, read: (id, signal) => new Promise(resolve => requests.push({ id, signal, resolve })), onSnapshot: s => received.push(s) });
  loader.select('a'); timers.tick(); loader.select('b'); timers.tick(); loader.select('a'); timers.tick();
  assert.equal(requests.length, 3); assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(snapshot('a', 99)); requests[1].resolve(snapshot('b', 10)); requests[2].resolve(snapshot('a', 2)); await flush();
  assert.deepEqual(received.map(s => [s.listeningId, s.graphRevision]), [['a', 2]]);
  void loader.refresh(); requests[3].resolve(snapshot('b', 100)); await flush(); assert.equal(received.length, 1);
  loader.stop();
});

test('refresh while in flight coalesces without overlap; failed reads preserve prior snapshot', async () => {
  const timers = clock(), requests = [], received = [], errors = [];
  const loader = createGraphSnapshotLoader({ ...timers, read: (id, signal) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject })), onSnapshot: s => received.push(s), onError: e => errors.push(e) });
  loader.select('a'); timers.tick(); void loader.refresh(); void loader.refresh(); assert.equal(requests.length, 1);
  requests[0].resolve(snapshot('a', 2)); await flush(); timers.tick(); assert.equal(requests.length, 2);
  requests[1].reject(Error('offline')); await flush(); assert.equal(received.length, 1); assert.equal(errors.length, 1);
  loader.stop(); timers.tick(); assert.equal(requests.length, 2);
});
