import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readKnowledgeView, saveKnowledgeView, filterGraph, stableGraphLayout, relationLabel, assertionQualifiers,
  createGraphSnapshotLoader, graphStatusText, graphWorkActive, graphProgressText, graphUsageText, graphCostText, acceptGraphProcessing } from '../public/knowledge-graph.js';

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

test('terminal relation states override leftover queue counts and identify budget reasons', () => {
  for (const state of ['paused', 'cancelled', 'complete', 'empty', 'partial', 'failed', 'waiting_nodes']) {
    assert.equal(graphWorkActive({ state, pendingJobs: 3, runningJobs: 1 }), false, state);
  }
  assert.equal(graphWorkActive({ state: 'queued' }), true);
  assert.equal(graphWorkActive({ state: 'waiting_key' }), true);
  assert.match(graphStatusText({ state: 'cancelled', pendingJobs: 1 }), /已取消.*手动/);
  for (const [stopReason, label] of [['ROUND_DEADLINE', '时间上限'], ['ROUND_REQUEST_LIMIT', '请求上限'], ['ROUND_TOKEN_LIMIT', 'token 额度']]) {
    assert.match(graphStatusText({ state: 'paused', pendingJobs: 2, round: { stopReason } }), new RegExp(label));
  }
  for (const [waitReason, label] of [['foreground', '前台任务'], ['provider_cooldown', '限流冷却'], ['retrying', '等待重试'], ['network_retry', '等待重试'], ['quiet_period', '等待原文与知识条目稳定'], ['admission_interval', '等待请求间隔'], ['translations', '等待相关译文'], ['queued', '已排队'], ['waiting_key', 'API Key']]) {
    assert.match(graphStatusText({ state: 'running', runningJobs: 1, waitReason }), new RegExp(label));
  }
});

test('round progress separates current round from historical usage and freezes terminal duration', () => {
  const startedAt = Date.UTC(2026, 9, 1), state = { state: 'running', progress: { totalWindows: 10, completedWindows: 3, remainingWindows: 7 },
    round: { id: 'round-1', startedAt, deadlineAt: startedAt + 120000, requestCount: 4, maxRequests: 12, totalTokens: 2300, measuredRequests: 3 } };
  const current = graphProgressText(state, startedAt + 75000);
  assert.match(current.progress, /3 \/ 10.*剩余 7/);
  assert.match(current.round, /本轮请求 4 \/ 12.*1 分 15 秒.*最多 2 分 0 秒.*2,300 tokens/);
  assert.doesNotMatch(current.round, /过去 1 小时/);
  assert.match(graphProgressText({ ...state, state: 'cancelled', round: { ...state.round, finishedAt: startedAt + 83000 } }, startedAt + 400000).round, /本轮用时 1 分 23 秒/);
  assert.doesNotMatch(graphProgressText({ ...state, state: 'paused' }, startedAt + 400000).round, /本轮已等待/);
  assert.match(graphProgressText({ state: 'running', round: { ...state.round, startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + 120000).toISOString() } }, startedAt + 9000).round, /9 秒/);
});

test('cost copy uses configured caps and never equates unmeasured tokens with free requests', () => {
  assert.match(graphCostText({ limits: { maxRequests: 5, maxDurationMs: 75000, maxEstimatedTokens: 40000 } }), /最多 5 次请求.*最长 1 分 15 秒.*40,000/);
  assert.match(graphCostText(), /下一轮需再次点击.*未完成或已变化.*取消后已发出的请求仍可能计费/);
  assert.match(graphUsageText(), /暂不可用.*不代表免费/);
  assert.match(graphUsageText({ requests: 7, measuredRequests: 4, totalTokens: 9200, inputTokens: 8000, outputTokens: 1200 }), /过去 1 小时.*7 次.*9,200 tokens.*3 次请求用量未知.*仍可能产生费用/);
  assert.match(graphUsageText({ requests: 2, measuredRequests: 0, totalTokens: 0 }), /2 次请求用量未知/);
});

test('processing updates allow new same-round work but fence cancelled and older rounds', () => {
  const first = { id: 'first', epoch: 1, startedAt: 1000 };
  const second = { id: 'second', epoch: 2, startedAt: 2000 };
  assert.equal(acceptGraphProcessing({ state: 'running', round: first }, { enabled: false, state: 'not_generated', round: null }), false);
  for (const state of ['complete', 'partial', 'waiting_nodes']) {
    assert.equal(acceptGraphProcessing({ state, round: first }, { state: 'queued', round: first }), true, state);
  }
  for (const state of ['cancelled', 'paused']) {
    assert.equal(acceptGraphProcessing({ state, round: first }, { state: 'running', round: first }), false, state);
    assert.equal(acceptGraphProcessing({ state, round: first }, { state: 'running', round: second }), true, state);
  }
  assert.equal(acceptGraphProcessing({ state: 'running', round: first }, { state: 'running', round: { ...second, startedAt: 500 } }), true, 'newer epoch wins even if clocks move backwards');
  assert.equal(acceptGraphProcessing({ state: 'running', round: second }, { state: 'paused', round: first }), false);
  assert.equal(acceptGraphProcessing({ state: 'running', round: second }, { state: 'running', round: { ...first, startedAt: 3000 } }), false, 'epoch wins even when clocks differ');
  assert.equal(acceptGraphProcessing({ state: 'running', round: { id: 'second', startedAt: 2000 } }, { state: 'cancelled', round: { id: 'first', startedAt: 1000 } }), false);
});
