import { test } from 'node:test';
import assert from 'node:assert/strict';
import cytoscape from 'cytoscape';
import { createGraphRenderer } from '../public/knowledge-graph-renderer.js';

const nodes = ['a', 'b', 'c'].map(id => ({ id, canonical_name: `知识${id}`, typeLabel: '术语' }));
const relations = [{ id: 'ab', subject_item_id: 'a', object_item_id: 'b', label: '否定·计划 使用', qualified: true, symmetric: false }];
function fixture(t) {
  let cy, changes = 0;
  const selections = [];
  const renderer = createGraphRenderer({ container: { clientWidth: 900, clientHeight: 500 },
    onSelect: (...args) => selections.push(args), onBackground: () => selections.push(['background']), onViewportChange: () => changes++,
    createEngine: options => (cy = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true })) });
  t.after(() => renderer.destroy());
  const update = (ns = nodes, rs = relations, selection = null, visibleNodes = ns, visibleRelations = rs) =>
    renderer.update(ns, rs, { selection, visibleNodes, visibleRelations });
  return { renderer, update, selections, get cy() { return cy; }, get changes() { return changes; } };
}

test('renderer keeps actual ids, qualified labels, directions, full names and isolated nodes', t => {
  const f = fixture(t);
  const original = JSON.stringify([nodes, relations]);
  f.update();
  assert.equal(f.cy.nodes().length, 3); assert.equal(f.cy.edges().length, 1);
  assert.equal(f.cy.getElementById('relation:ab').data('label'), '否定·计划 使用');
  assert.equal(f.cy.getElementById('relation:ab').data('arrow'), 'triangle');
  assert.equal(f.cy.getElementById('relation:ab').hasClass('qualified'), true);
  assert.equal(f.cy.getElementById('c').data('group'), 'independent');
  const long = '特别长的知识节点名称，用于检验完整名称和省略标签不会混淆';
  f.update([{ ...nodes[0], canonical_name: long }, ...nodes.slice(1)], [{ ...relations[0], symmetric: true }]);
  assert.equal(f.cy.getElementById('a').data('label'), long);
  assert.match(f.cy.getElementById('a').data('displayLabel'), /…\n术语$/);
  assert.equal(f.cy.getElementById('relation:ab').data('arrow'), 'none');
  assert.equal(JSON.stringify([nodes, relations]), original);
});

test('metadata, selection and filters preserve dragged coordinates and viewport', t => {
  const f = fixture(t); f.update();
  f.cy.getElementById('a').position({ x: -120, y: 450 }); f.cy.zoom(1.25); f.cy.pan({ x: 91, y: -73 });
  const saved = f.renderer.save();
  f.update(nodes.map(n => ({ ...n, canonical_name: `新名称${n.id}` })), relations, { kind: 'node', id: 'a' });
  assert.deepEqual(f.renderer.save(), saved);
  assert.equal(f.cy.getElementById('a').hasClass('selected'), true);
  assert.equal(f.cy.getElementById('b').hasClass('neighbor'), true);
  assert.equal(f.cy.getElementById('c').hasClass('faded'), true);
  assert.equal(f.cy.getElementById('relation:ab').hasClass('neighbor'), true);
  f.update(nodes, relations, null, [nodes[0]], []);
  assert.deepEqual(f.renderer.save(), saved);
  assert.equal(f.cy.nodes(':visible').length, 1); assert.equal(f.cy.edges(':visible').length, 0);
  assert.equal(f.cy.getElementById('a').data('group'), 'connected');
  assert.equal(f.cy.elements('.selected,.neighbor,.faded').length, 0);
});

test('actual drag/pan/zoom disable automatic fit; node grab/tap and programmatic view changes do not', t => {
  const f = fixture(t); f.update();
  const a = f.cy.getElementById('a');
  a.emit('grab'); a.emit('tap');
  assert.equal(f.changes, 0); assert.deepEqual(f.selections, [['node', 'a']]);
  a.emit('drag'); assert.equal(f.changes, 1);
  f.cy.pan({ x: 10, y: 20 }); assert.equal(f.changes, 2);
  const before = f.changes;
  f.renderer.zoom(1.2); f.renderer.pan(20, 10); f.renderer.arrange();
  assert.equal(f.changes, before);
  const saved = f.renderer.save();
  f.cy.getElementById('b').position({ x: 999, y: 999 }); f.renderer.zoom(.5); f.renderer.restore(saved);
  assert.deepEqual(f.renderer.save(), saved); assert.equal(f.changes, before);
});

test('topology updates and deletions remove stale canvas objects and never duplicate edges', t => {
  const f = fixture(t); f.update();
  f.update(nodes, [{ ...relations[0], object_item_id: 'c' }]);
  assert.equal(f.cy.getElementById('relation:ab').target().id(), 'c');
  assert.equal(f.cy.getElementById('b').data('group'), 'independent');
  f.update([nodes[0]], []); assert.equal(f.cy.nodes().length, 1); assert.equal(f.cy.edges().length, 0);
  f.update([], []); assert.equal(f.cy.elements().length, 0);
});


test('fullscreen restore refuses partial stale positions after a live node arrival', t => {
  const f = fixture(t); f.update(nodes.slice(0, 2), []);
  const saved = f.renderer.save();
  f.update([{ id: '0-new', canonical_name: '新知识', typeLabel: '术语' }, ...nodes.slice(0, 2)], []);
  const updated = f.renderer.save();
  assert.equal(f.renderer.restore(saved), false);
  assert.deepEqual(f.renderer.save(), updated, 'old positions are not mixed into new topology');
  f.renderer.arrange();
  assert.equal(new Set(f.cy.nodes().map(n => JSON.stringify(n.position()))).size, 3);
});
