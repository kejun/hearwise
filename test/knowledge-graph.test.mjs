import { test } from 'node:test';
import { GRAPH_NODE, routeGraphRelation } from '../public/knowledge-graph-layout.js';
import assert from 'node:assert/strict';
import { readKnowledgeView, saveKnowledgeView, filterGraph, stableGraphLayout, relationLabel, assertionQualifiers,
  createGraphSnapshotLoader, graphStatusText, graphWorkActive, graphProgressText, graphUsageText, graphCostText, graphDiagnosticsText, acceptGraphProcessing } from '../public/knowledge-graph.js';

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
  const narrow = stableGraphLayout(nodes, [relation], new Map(), 2);
  assert.ok([...narrow.values()].every(p => p.col < 2));
  assert.equal(large.size, 250);
  assert.equal(new Set([...large.values()].map(p => `${p.col},${p.row}`)).size, 250);
});

test('compact routing avoids unrelated nodes in a dense map, including parallel edges', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}` }));
  const positions = stableGraphLayout(many, []);
  assert.ok(GRAPH_NODE.width * GRAPH_NODE.height < 216 * 84 / 2);
  for (let i = 0; i < many.length; i++) for (let j = i + 1; j < many.length; j++) for (const lane of [0, 1, 2]) {
    const edge = { subject_item_id: many[i].id, object_item_id: many[j].id };
    const route = routeGraphRelation(edge, positions, lane, 3);
    assert.ok(route.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    for (const [id, node] of positions) {
      if ([edge.subject_item_id, edge.object_item_id].includes(id)) continue;
      // Sample the entire rendered segment, not just its midpoint or waypoints.
      for (let k = 1; k < route.points.length; k++) {
        const a = route.points[k - 1], b = route.points[k], steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
        for (let t = 0; t <= steps; t++) {
          const x = a.x + (b.x - a.x) * t / steps, y = a.y + (b.y - a.y) * t / steps;
          assert.ok(!(x > node.x && x < node.x + GRAPH_NODE.width && y > node.y && y < node.y + GRAPH_NODE.height), `${i}→${j} lane ${lane} crosses ${id}`);
        }
      }
    }
  }
  const crossing = routeGraphRelation({ subject_item_id: 'n00', object_item_id: 'n04' }, positions);
  assert.ok(crossing.points.length > 2, 'a row of intervening nodes requires a detour');
  assert.notDeepEqual(crossing.points, routeGraphRelation({ subject_item_id: 'n00', object_item_id: 'n04' }, positions, 1, 2).points);
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
  assert.match(graphStatusText({ state: 'empty' }), /未发现有充分依据的关系/);
  assert.match(graphStatusText({ state: 'empty', diagnostics: { returnedCount: 0, unknownJobs: 0, resultJobs: 1 } }), /未发现有充分依据的关系/);
  assert.match(graphStatusText({ state: 'empty', diagnostics: { returnedCount: 0, unknownJobs: 0, resultJobs: 0 } }), /未发现有充分依据的关系/);
  assert.match(graphStatusText({ state: 'empty', diagnostics: { returnedCount: 3, acceptedCount: 0, rejectedCount: 3, unknownJobs: 0 } }), /未发现有充分依据的关系/);
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

test('terminal relation states override leftover queue counts; legacy pauses stay resumable', () => {
  for (const state of ['paused', 'cancelled', 'complete', 'empty', 'partial', 'failed', 'waiting_nodes']) {
    assert.equal(graphWorkActive({ state, pendingJobs: 3, runningJobs: 1 }), false, state);
  }
  assert.equal(graphWorkActive({ state: 'queued' }), true);
  assert.equal(graphWorkActive({ state: 'waiting_key' }), true);
  assert.match(graphStatusText({ state: 'cancelled', pendingJobs: 1 }), /已取消.*手动/);
  for (const stopReason of ['ROUND_DEADLINE', 'ROUND_REQUEST_LIMIT', 'ROUND_TOKEN_LIMIT']) {
    assert.match(graphStatusText({ state: 'paused', pendingJobs: 2, round: { stopReason } }), /历史关系任务已暂停.*继续/);
    assert.doesNotMatch(graphStatusText({ state: 'paused', round: { stopReason } }), /额度|上限/);
  }
  for (const [waitReason, label] of [['foreground', '前台任务'], ['provider_cooldown', '限流冷却'], ['retrying', '等待重试'], ['network_retry', '等待重试'], ['quiet_period', '等待原文与知识条目稳定'], ['admission_interval', '等待请求间隔'], ['translations', '等待相关译文'], ['queued', '已排队'], ['waiting_key', 'API Key']]) {
    assert.match(graphStatusText({ state: 'running', runningJobs: 1, waitReason }), new RegExp(label));
  }
});

test('round progress separates current round from historical usage and freezes terminal duration', () => {
  const startedAt = Date.UTC(2026, 9, 1), state = { state: 'running', progress: { totalWindows: 10, completedWindows: 3, remainingWindows: 7 },
    round: { id: 'round-1', startedAt, requestCount: 14, totalTokens: 2300, measuredRequests: 3 } };
  const current = graphProgressText(state, startedAt + 75000);
  assert.match(current.progress, /3 \/ 10.*剩余 7/);
  assert.match(current.round, /本轮请求 14 次.*1 分 15 秒.*2,300 tokens.*11 次用量尚未知/);
  assert.doesNotMatch(current.round, /过去 1 小时|最多|请求 \d+ \/|额度/);
  assert.match(graphProgressText(state, startedAt + 185000).round, /3 分 5 秒/);
  assert.match(graphProgressText({ ...state, round: { ...state.round, finishedAt: startedAt + 30000 } }, startedAt + 185000).round, /已等待\/处理 3 分 5 秒/);
  assert.match(graphProgressText({ progress: { totalWindows: 10, completedWindows: 8, partialWindows: 2, remainingWindows: 2 } }).progress, /已处理 8 \/ 10.*其中 2 个部分完成.*剩余 2/);
  assert.match(graphProgressText({ ...state, state: 'cancelled', round: { ...state.round, finishedAt: startedAt + 83000 } }, startedAt + 400000).round, /本轮用时 1 分 23 秒/);
  assert.doesNotMatch(graphProgressText({ ...state, state: 'paused' }, startedAt + 400000).round, /本轮已等待/);
  assert.match(graphProgressText({ state: 'running', round: { ...state.round, startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + 120000).toISOString() } }, startedAt + 9000).round, /9 秒/);
});

test('cost notice is concise while detailed usage keeps unknown charges honest', () => {
  assert.ok(graphCostText().length < 70);
  assert.match(graphCostText(), /原文、译文和条目.*千问.*模型费用.*随时取消.*仍可能计费/);
  assert.doesNotMatch(graphCostText(), /窗口|并行|token|上限/);
  assert.match(graphUsageText(), /暂不可用.*不代表免费/);
  assert.match(graphUsageText({ requests: 7, measuredRequests: 4, totalTokens: 9200, inputTokens: 8000, outputTokens: 1200 }), /过去 1 小时.*7 次.*9,200 tokens.*3 次请求用量未知.*仍可能产生费用/);
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


test('active snapshots poll until terminal without SSE, overlap or additional generation requests', async () => {
  const timers = clock(), requests = [], received = [];
  const loader = createGraphSnapshotLoader({ ...timers, read: id => new Promise(resolve => requests.push({ id, resolve })), onSnapshot: s => received.push(s) });
  loader.select('a'); timers.tick();
  requests[0].resolve(snapshot('a', 1, { status: { state: 'running' } })); await flush();
  assert.equal(timers.size, 1);
  timers.tick(); timers.tick(); assert.equal(requests.length, 2, 'slow read cannot overlap another poll');
  requests[1].resolve(snapshot('a', 2, { status: { state: 'running' } })); await flush();
  timers.tick(); requests[2].resolve(snapshot('a', 3, { status: { state: 'complete', pendingJobs: 9 } })); await flush();
  assert.equal(timers.size, 0); assert.equal(received.length, 3);
  loader.stop();
});

test('a final invalidation GET failure retries without another event and backoff is bounded', async () => {
  const timers = clock(), delays = [], received = [];
  let calls = 0;
  const loader = createGraphSnapshotLoader({ ...timers, setTimer: (fn, ms) => { delays.push(ms); return timers.setTimer(fn); },
    read: async id => { calls++; if (calls > 1 && calls < 4) throw Error('offline'); return snapshot(id, calls === 1 ? 1 : 2); },
    onSnapshot: s => received.push(s) });
  loader.select('a'); timers.tick(); await flush();
  loader.invalidate('a', 2); timers.tick(); await flush();
  assert.equal(timers.size, 1); timers.tick(); await flush(); timers.tick(); await flush();
  assert.deepEqual(received.map(s => s.graphRevision), [1, 2]);
  assert.equal(timers.size, 0); assert.deepEqual(delays, [0, 35, 4000, 8000]);
  loader.stop();
});

test('inactive failures have finite retries; active reads recover after longer outages', async () => {
  for (const active of [false, true]) {
    const timers = clock(), delays = [];
    let calls = 0;
    const loader = createGraphSnapshotLoader({ ...timers, setTimer: (fn, ms) => { delays.push(ms); return timers.setTimer(fn); },
      read: async id => { calls++; if (active && calls === 1) return snapshot(id, 1, { status: { state: 'running' } }); if (calls < 7) throw Error('offline'); return snapshot(id, 2, { status: { state: 'cancelled' } }); }, onSnapshot: () => {} });
    loader.select('a');
    for (let i = 0; i < 10; i++) { timers.tick(); await flush(); }
    assert.equal(calls, active ? 7 : 4);
    assert.equal(timers.size, 0); assert.ok(delays.every(ms => ms <= 15000));
    loader.stop();
  }
});

test('404, waiting-key and cancellation stop automatic reads; active detail state can restart polling', async () => {
  for (const state of ['waiting_key', 'cancelled', 'partial', 'failed']) {
    const timers = clock(); let calls = 0;
    const loader = createGraphSnapshotLoader({ ...timers, read: async id => { calls++; return snapshot(id, calls, { status: { state, pendingJobs: 9 } }); }, onSnapshot: () => {} });
    loader.select('a'); timers.tick(); await flush(); assert.equal(timers.size, 0);
    loader.setPolling(true); assert.equal(timers.size, 1);
    loader.setPolling(false); assert.equal(timers.size, 0);
    loader.stop();
  }
  const timers = clock(); let calls = 0;
  const loader = createGraphSnapshotLoader({ ...timers, read: async () => { calls++; throw Object.assign(Error('gone'), { status: 404 }); }, onSnapshot: () => {} });
  loader.select('a'); loader.setPolling(true); timers.tick(); await flush();
  assert.equal(calls, 1); assert.equal(timers.size, 0); loader.stop();
});

// Tiny DOM fixture exercises actual createKnowledgeGraph action wiring without
// browser/model dependencies. Layout/accessibility stay in the browser suite.
function graphDom() {
  class Element {
    constructor(doc, tag) {
      this.ownerDocument = doc; this.tag = tag; this.children = []; this.handlers = {}; this.style = {}; this.dataset = {};
      this.value = ''; this.textContent = ''; this.hidden = false; this.classList = { add() {}, toggle() {}, remove() {} };
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {} removeAttribute() {} remove() {} focus() {}
    addEventListener(type, fn) { this.handlers[type] = fn; }
    get options() { return this.children; }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children.at(-1); }
    click() { this.handlers.click?.({ currentTarget: this }); }
  }
  const doc = { elements: [], createElement(tag) { const element = new Element(this, tag); this.elements.push(element); return element; },
    createElementNS(_, tag) { return this.createElement(tag); } };
  return { root: doc.createElement('root'), element: id => doc.elements.find(e => e.id === id) };
}

test('lost POST response and failed recovery GET reach terminal UI without another POST', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom();
  let state = { state: 'paused', enabled: true, round: { id: 'old', epoch: 1 } }, gets = 0, posts = 0, failNextGet = false;
  t.mock.method(globalThis, 'fetch', async (_url, { method = 'GET' } = {}) => {
    if (method === 'POST') {
      posts++; state = { state: 'running', enabled: true, round: { id: 'new', epoch: 2, startedAt: Date.now() } };
      failNextGet = true; throw TypeError('Failed to fetch');
    }
    gets++;
    if (failNextGet) { failNextGet = false; throw TypeError('offline'); }
    return { ok: true, json: async () => snapshot('a', gets, { status: structuredClone(state) }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => 'fixture-only', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); graph.setActive(true); t.mock.timers.tick(0); await flush();
  dom.element('graph-generate').click(); await flush();
  assert.equal(posts, 1); assert.equal(dom.element('graph-generate').disabled, true);
  assert.match(dom.element('graph-status').textContent, /状态尚未确认/);
  dom.element('graph-generate').click(); await flush(); assert.equal(posts, 1);
  t.mock.timers.tick(4000); await flush(); assert.match(dom.element('graph-status').textContent, /正在整理关系/);
  state = { ...state, state: 'partial', pendingJobs: 7, round: { ...state.round, finishedAt: Date.now() } };
  t.mock.timers.tick(2000); await flush();
  assert.match(dom.element('graph-status').textContent, /部分完成.*已保存关系可继续查看/);
  assert.equal(dom.element('graph-generate').textContent, '检查新增或变化的内容');
  assert.equal(dom.element('graph-generate').disabled, false);
  const finalGets = gets; t.mock.timers.tick(30000); await flush(); assert.equal(gets, finalGets); assert.equal(posts, 1);
});

test('lost DELETE response reconciles saved cancellation and clears active polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom();
  let state = { state: 'running', enabled: true, round: { id: 'run', epoch: 1, startedAt: Date.now() } }, gets = 0, deletes = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { method = 'GET' } = {}) => {
    if (method === 'DELETE') { deletes++; state = { ...state, state: 'cancelled', round: { ...state.round, finishedAt: Date.now() } }; throw TypeError('Failed to fetch'); }
    assert.equal(method, 'GET'); gets++; return { ok: true, json: async () => snapshot('a', gets, { status: structuredClone(state) }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => '', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); graph.setActive(true); t.mock.timers.tick(0); await flush();
  dom.element('graph-cancel').click(); dom.element('graph-cancel').click(); await flush();
  assert.equal(deletes, 1); assert.match(dom.element('graph-status').textContent, /已取消/);
  assert.equal(dom.element('graph-generate').disabled, false); assert.equal(dom.element('graph-cancel').hidden, true);
  const finalGets = gets; t.mock.timers.tick(30000); await flush(); assert.equal(gets, finalGets);
});


test('diagnostics distinguish returned, rejected, deduplicated, visible and legacy-unknown counts', () => {
  const d = { scope: 'latest_result_per_window', resultJobs: 3, measuredJobs: 3, unknownJobs: 0,
    returnedCount: 9, validatorAcceptedCount: 7, acceptedCount: 6, rejectedCount: 3, insertedRelationCount: 4,
    deduplicatedCount: 2, storedRelationCount: 5, visibleRelationCount: 4, coverageLimitedWindows: 1,
    rejectionReasons: [{ code: 'CROSS_SENTENCE_REFERENCE_REQUIRED', count: 2, label: '缺少跨句指代依据' }],
    failureReasons: [{ code: 'RELATION_OUTPUT_LIMIT', count: 1, label: '模型输出被截断' }] };
  const text = graphDiagnosticsText({ state: 'partial', diagnostics: d }).join('\n');
  assert.match(text, /当前可见 4 条.*已保存 5 条/);
  assert.match(text, /不是本轮累计.*模型返回 9 项.*通过校验 7 项.*最终接收 6 项.*已忽略候选 3 项/);
  assert.match(text, /写入新关系 4 条.*复用已有关系 2 项/);
  assert.match(text, /未保存候选详情.*缺少跨句指代依据.*CROSS_SENTENCE_REFERENCE_REQUIRED/);
  assert.match(text, /请求失败原因.*模型输出被截断/);
  const legacy = graphDiagnosticsText({ state: 'empty', diagnostics: { ...d, measuredJobs: 0, unknownJobs: 3,
    returnedCount: null, validatorAcceptedCount: null, acceptedCount: null, insertedRelationCount: null, deduplicatedCount: null } }).join('\n');
  assert.match(legacy, /模型返回 未知 项/); assert.doesNotMatch(legacy, /模型返回 0 项/);
  assert.match(legacy, /未知不等于 0/);
});

test('terminal detail fetches authoritative nonzero edges once and fences an older zero-edge GET', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom(), reads = [];
  const running = { state: 'running', enabled: true, round: { id: 'run', epoch: 1, startedAt: Date.now() } };
  const complete = { ...running, state: 'complete', round: { ...running.round, finishedAt: Date.now() } };
  t.mock.method(globalThis, 'fetch', (_url, options = {}) => {
    assert.equal(options.method, undefined, 'terminal reconciliation must never call the model');
    return new Promise(resolve => reads.push({ signal: options.signal, resolve: data => resolve({ ok: true, json: async () => data }) }));
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => '', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); t.mock.timers.tick(0);
  reads[0].resolve(snapshot('a', 1, { status: running, nodes })); await flush();
  void graph.refresh(); assert.equal(reads.length, 2);
  graph.setProcessing(complete); assert.equal(reads.length, 3); assert.equal(reads[1].signal.aborted, true);
  assert.match(dom.element('graph-status').textContent, /读取最新图谱/);
  assert.doesNotMatch(dom.element('graph-count').textContent, /0 条关系/);
  graph.setProcessing(complete); assert.equal(reads.length, 3, 'repeated detail terminal events coalesce');
  reads[1].resolve(snapshot('a', 999, { status: running, nodes })); await flush();
  assert.match(dom.element('graph-status').textContent, /读取最新图谱/);
  reads[2].resolve(snapshot('a', 2, { status: complete, nodes, relations: [relation] })); await flush();
  assert.match(dom.element('graph-count').textContent, /1 条关系/);
  assert.equal(dom.element('graph-status').textContent, '关系整理完成');
  graph.setProcessing(complete); t.mock.timers.tick(5000); await flush(); assert.equal(reads.length, 3);
});

test('selective failed/partial retry needs confirmation, carries displayed epoch, and is single-flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom(), posts = [];
  let state = { state: 'partial', enabled: true, partialJobs: 1, canRetryProblems: true, retryableWindows: 1, round: { id: 'run', epoch: 4 } };
  let release;
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      await new Promise(resolve => { release = resolve; });
      state = { state: 'running', enabled: true, canRetryProblems: false, round: { id: 'next', epoch: 5 } };
    }
    return { ok: true, json: async () => snapshot('a', 2, { status: structuredClone(state) }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => 'fixture-only', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); t.mock.timers.tick(0); await flush();
  assert.equal(dom.element('graph-generate').hidden, true);
  dom.element('graph-retry').click(); assert.match(dom.element('graph-retry-warning').textContent, /成功窗口.*保留.*额外模型费用/);
  assert.equal(posts.length, 0); dom.element('graph-retry-dismiss').click(); assert.equal(posts.length, 0);
  dom.element('graph-retry').click(); dom.element('graph-retry-confirm').click(); dom.element('graph-retry-confirm').click(); await flush();
  assert.deepEqual(posts, [{ key: 'fixture-only', retry: 'failed_partial', expectedEpoch: 4 }]);
  release(); await flush(); assert.equal(dom.element('graph-retry').hidden, true);
  assert.equal(dom.element('graph-retry-panel').hidden, true);
});

test('retry confirmation cannot follow navigation or a changed epoch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom(); let posts = 0;
  const partial = epoch => ({ state: 'partial', enabled: true, canRetryProblems: true, retryableWindows: 1, round: { id: `r${epoch}`, epoch } });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => snapshot(url.includes('/b/') ? 'b' : 'a', 10, { status: partial(2) }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => 'fixture-only', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); t.mock.timers.tick(0); await flush();
  dom.element('graph-retry').click(); graph.select('b'); dom.element('graph-retry-confirm').click(); t.mock.timers.tick(0); await flush();
  assert.equal(posts, 0); assert.equal(dom.element('graph-retry-panel').hidden, true);
  dom.element('graph-retry').click(); graph.setProcessing(partial(3)); dom.element('graph-retry-confirm').click(); await flush();
  assert.equal(posts, 0); assert.equal(dom.element('graph-retry-panel').hidden, true);
});

test('terminal graph read failure retries while preserving honest unsynchronized state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom(); let calls = 0;
  const running = { state: 'running', enabled: true, round: { id: 'r1', epoch: 1 } };
  const complete = { ...running, state: 'complete' };
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    assert.equal(options.method, undefined); calls++;
    if (calls === 2) throw Error('offline');
    return { ok: true, json: async () => snapshot('a', calls, { status: calls === 1 ? running : complete, nodes, relations: calls === 1 ? [] : [relation] }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => '', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); t.mock.timers.tick(0); await flush();
  graph.setProcessing(complete); await flush();
  assert.match(dom.element('graph-status').textContent, /最终图谱尚未同步/);
  assert.doesNotMatch(dom.element('graph-count').textContent, /0 条关系/);
  assert.equal(dom.element('graph-generate').disabled, true);
  t.mock.timers.tick(4000); await flush();
  assert.equal(calls, 3); assert.match(dom.element('graph-count').textContent, /1 条关系/);
});

test('selective retry 409 preserves the failure notice, refreshes epoch and never auto-resubmits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createKnowledgeGraph } = await import('../public/knowledge-graph.js');
  const dom = graphDom(); let posts = 0, epoch = 1;
  const partial = () => ({ state: 'partial', enabled: true, canRetryProblems: true, retryableWindows: 1, round: { id: `r${epoch}`, epoch } });
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (options.method === 'POST') {
      posts++; assert.equal(JSON.parse(options.body).expectedEpoch, 1); epoch = 2;
      return { ok: false, status: 409, json: async () => ({ code: 'RETRY_STATE_CHANGED', error: '整理状态已改变，请刷新后再重试' }) };
    }
    return { ok: true, json: async () => snapshot('a', epoch, { status: partial() }) };
  });
  const graph = createKnowledgeGraph({ ...dom, getKey: () => 'fixture-only', onRequireKey() {}, loadSegment: async () => ({}), locateSegment() {} });
  t.after(() => graph.destroy()); graph.select('a'); t.mock.timers.tick(0); await flush();
  dom.element('graph-retry').click(); dom.element('graph-retry-confirm').click(); await flush();
  assert.match(dom.element('graph-action-notice').textContent, /整理状态已改变/);
  assert.equal(dom.element('graph-retry').disabled, false); assert.equal(dom.element('graph-retry-panel').hidden, true);
  t.mock.timers.tick(30000); await flush(); assert.equal(posts, 1);
});


test('all-failed diagnostics retain failure reasons, unknown row counts and existing graph counts', () => {
  const text = graphDiagnosticsText({ state: 'failed', diagnostics: {
    scope: 'latest_result_per_window', resultJobs: 0, measuredJobs: 0, unknownJobs: 1,
    returnedCount: null, validatorAcceptedCount: null, acceptedCount: null, rejectedCount: 0,
    insertedRelationCount: null, deduplicatedCount: null, storedRelationCount: 2, visibleRelationCount: 1,
    coverageLimitedWindows: 0, rejectionReasons: [],
    failureReasons: [{ code: 'RELATION_OUTPUT_LIMIT', count: 1, label: '模型输出被截断' }]
  } }).join('\n');
  assert.match(text, /当前可见 1 条.*已保存 2 条/);
  assert.match(text, /模型返回 未知 项/);
  assert.match(text, /尚无已完成或部分完成的窗口结果/);
  assert.match(text, /1 个窗口的数量未记录或尚未取得/);
  assert.match(text, /请求失败原因.*模型输出被截断.*RELATION_OUTPUT_LIMIT/);
  assert.doesNotMatch(text, /模型返回 0 项/);
});
