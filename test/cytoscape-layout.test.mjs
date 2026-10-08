import { test } from 'node:test';
import assert from 'node:assert/strict';
import cytoscape from 'cytoscape';
import { arrangeGraph, GRAPH_NODE } from '../public/knowledge-graph-layout.js';

const node = id => ({ data: { id, label: `知识 ${id}`, typeLabel: '术语', group: 'independent' } });
const edge = (source, target, id = `${source}-${target}`) => ({ data: { id: `edge:${id}`, source, target, relationId: id } });
function graph(t, nodes, edges = []) {
  const cy = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' },
    style: [{ selector: 'node', style: { width: GRAPH_NODE.width, height: GRAPH_NODE.height, 'border-width': 2,
      label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 144 } }], elements: [...nodes, ...edges] });
  t.after(() => cy.destroy());
  return cy;
}
const positions = cy => Object.fromEntries(cy.nodes().map(n => [n.id(), { ...n.position() }]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
function assertClear(cy) {
  const nodes = cy.nodes().toArray();
  for (const n of nodes) assert.ok(Number.isFinite(n.position('x')) && Number.isFinite(n.position('y')), n.id());
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    assert.ok(Math.abs(a.position('x') - b.position('x')) >= (a.outerWidth() + b.outerWidth()) / 2 ||
      Math.abs(a.position('y') - b.position('y')) >= (a.outerHeight() + b.outerHeight()) / 2, `${a.id()} overlaps ${b.id()}`);
  }
}
function assertSeparated(cy) {
  const connected = cy.nodes('[group = "connected"]'), independent = cy.nodes('[group = "independent"]');
  if (connected.length && independent.length) assert.ok(connected.boundingBox().y2 + 80 < independent.boundingBox().y1);
}
function crossingCount(pairs, places) {
  const direction = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let count = 0;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [a, b] = pairs[i], [c, d] = pairs[j];
    if (new Set([a, b, c, d]).size < 4) continue;
    const [pa, pb, pc, pd] = [a, b, c, d].map(id => places[id]);
    if (direction(pa, pb, pc) * direction(pa, pb, pd) < 0 && direction(pc, pd, pa) * direction(pc, pd, pb) < 0) count++;
  }
  return count;
}

test('empty, single and many independent nodes have finite, non-overlapping geometry', t => {
  const empty = graph(t, []);
  assert.deepEqual(arrangeGraph(empty, { width: 0, height: NaN }), { connected: 0, independent: 0, components: 0 });
  for (const count of [1, 250]) {
    const cy = graph(t, Array.from({ length: count }, (_, i) => node(`n${String(i).padStart(3, '0')}`)));
    assert.deepEqual(arrangeGraph(cy, { width: Infinity, height: -1 }), { connected: 0, independent: count, components: 0 });
    assertClear(cy);
    assert.equal(cy.nodes().every(n => n.data('group') === 'independent'), true);
    assert.equal(Math.min(...cy.nodes().map(n => n.position('y') - n.outerHeight() / 2)), GRAPH_NODE.margin);
  }
});

test('layout is deterministic across insertion order, previous positions and label changes', t => {
  const nodes = Array.from({ length: 14 }, (_, i) => node(`n${i}`));
  const edges = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 0], [2, 6], [8, 10], [10, 12], [1, 3], [3, 5], [1, 5]]
    .map(([a, b]) => edge(`n${a}`, `n${b}`));
  const first = graph(t, nodes, edges), second = graph(t, nodes.slice().reverse(), edges.slice().reverse());
  arrangeGraph(first); arrangeGraph(second);
  assert.deepEqual(positions(second), positions(first));
  second.nodes().forEach((n, i) => { n.position({ x: i * 13 - 999, y: 800 - i * 29 }); n.data('label', `改名 ${i}`); });
  arrangeGraph(second);
  assert.deepEqual(positions(second), positions(first));
  assertClear(first); assertSeparated(first);
});

test('only actual relations form components, with isolated nodes below and no synthetic elements', t => {
  const nodes = Array.from({ length: 13 }, (_, i) => node(`n${String(i).padStart(2, '0')}`));
  const cy = graph(t, nodes);
  assert.deepEqual(arrangeGraph(cy), { connected: 0, independent: 13, components: 0 });
  cy.add([edge('n01', 'n03'), edge('n03', 'n05'), edge('n10', 'n12')]);
  assert.deepEqual(arrangeGraph(cy), { connected: 5, independent: 8, components: 2 });
  assert.deepEqual(cy.nodes('[group = "connected"]').map(n => n.id()).sort(), ['n01', 'n03', 'n05', 'n10', 'n12']);
  assertClear(cy); assertSeparated(cy);
  const components = cy.elements().components().filter(c => c.edges().length);
  const [a, b] = components.map(c => c.nodes().boundingBox());
  assert.ok(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
  assert.equal(cy.nodes().length, 13); assert.equal(cy.edges().length, 3);
  assert.deepEqual(cy.edges().map(e => e.data('relationId')), ['n01-n03', 'n03-n05', 'n10-n12']);
  cy.edges().remove();
  assert.deepEqual(arrangeGraph(cy), { connected: 0, independent: 13, components: 0 });
  assert.equal(Math.min(...cy.nodes().map(n => n.position('y') - n.outerHeight() / 2)), GRAPH_NODE.margin);
});

test('parallel and self relations remain real edges and preserve viewport and selection', t => {
  const cy = graph(t, ['a', 'b', 'c', 'd'].map(node), [edge('a', 'b', 'ab1'), edge('a', 'b', 'ab2'), edge('b', 'a', 'ba'), edge('c', 'c', 'self')]);
  cy.zoom(1.75); cy.pan({ x: -120, y: 87 }); cy.getElementById('a').select();
  const data = cy.edges().map(e => ({ ...e.data() }));
  assert.deepEqual(arrangeGraph(cy), { connected: 3, independent: 1, components: 2 });
  assert.equal(cy.zoom(), 1.75); assert.deepEqual(cy.pan(), { x: -120, y: 87 });
  assert.equal(cy.getElementById('a').selected(), true); assert.deepEqual(cy.edges().map(e => e.data()), data);
  assertClear(cy); assertSeparated(cy);
});

test('relation-aware layout reduces crossings on an ID-scrambled chain and responds to rewiring', t => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(`n${String(i).padStart(2, '0')}`));
  const path = [0, 8, 3, 11, 1, 7, 2, 10, 5, 9, 4, 6].map(i => nodes[i].data.id);
  const pairs = path.slice(1).map((id, i) => [path[i], id]);
  const cy = graph(t, nodes, pairs.map(([a, b]) => edge(a, b)));
  arrangeGraph(cy, { width: 1200, height: 650 });
  const grid = Object.fromEntries(nodes.map((n, i) => [n.data.id, { x: (i % 4) * 220, y: Math.floor(i / 4) * 120 }]));
  const count = crossingCount(pairs, positions(cy)), baseline = crossingCount(pairs, grid);
  assert.ok(baseline > 0); assert.ok(count < baseline, `${count} crossings; ID-grid baseline ${baseline}`);
  assertClear(cy);
  const before = positions(cy);
  cy.edges().remove(); cy.add(nodes.slice(1).map(n => edge(nodes[0].data.id, n.data.id)));
  arrangeGraph(cy, { width: 1200, height: 650 });
  assert.notDeepEqual(positions(cy), before); assertClear(cy);
});

test('packing uses viewport aspect for disconnected components and independent grids', t => {
  for (const connected of [false, true]) {
    const nodes = Array.from({ length: 80 }, (_, i) => node(`n${String(i).padStart(2, '0')}`));
    const edges = connected ? Array.from({ length: 30 }, (_, i) => edge(nodes[2 * i].data.id, nodes[2 * i + 1].data.id)) : [];
    const cy = graph(t, nodes, edges);
    arrangeGraph(cy, { width: 1800, height: 650 });
    const wide = cy.nodes().boundingBox();
    assertClear(cy); assertSeparated(cy);
    arrangeGraph(cy, { width: 390, height: 800 });
    const narrow = cy.nodes().boundingBox();
    assert.ok(wide.w > narrow.w, `width did not respond to viewport: ${wide.w}, ${narrow.w}`);
    assert.ok(wide.h < narrow.h, `height did not respond to viewport: ${wide.h}, ${narrow.h}`);
    assertClear(cy); assertSeparated(cy);
  }
});

test('dense and long-label rectangles retain their actual rendered clearance', t => {
  const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`));
  const edges = nodes.flatMap((n, i) => nodes.slice(i + 1).filter((_, j) => j % 7 === 0).map(m => edge(n.data.id, m.data.id)));
  const cy = graph(t, nodes, edges);
  cy.nodes().filter((_, i) => i % 5 === 0).style({ width: 240, height: 86 });
  arrangeGraph(cy, { width: 1280, height: 700 });
  assertClear(cy);
});
