import cytoscape from './vendor/cytoscape.js';
import { arrangeGraph } from './knowledge-graph-layout.js';
import { knowledgeName } from './knowledge-name.js';

// Rendering only: all nodes, directions and qualified labels come from persisted
// graph data. Canvas interaction has an equivalent semantic list in the explorer.
const NODE_COLORS = { 人物: '#e4edf9', 组织: '#e3f0e8', 产品: '#f6edda', 作品: '#f0e7f6',
  方法: '#e0f1ed', 事件: '#f9e6dc', 地点: '#e7efda', 术语: '#e9edf0', 其他: '#eef0e9' };
const relationId = id => `relation:${id}`;
const style = [
  { selector: 'node', style: { shape: 'round-rectangle', width: 164, height: 56,
    'background-color': 'data(color)', 'border-color': '#a4bbae', 'border-width': 1.3,
    label: 'data(displayLabel)', color: '#243d32', 'font-family': 'system-ui, "Noto Sans CJK SC", sans-serif',
    'font-size': 12, 'font-weight': 500, 'text-wrap': 'wrap', 'text-overflow-wrap': 'anywhere', 'text-max-width': 146,
    'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.45, 'overlay-opacity': 0 } },
  { selector: 'node[group = "independent"]', style: { 'border-style': 'dashed', 'border-color': '#bec8b8', 'background-color': '#f3f5ef' } },
  { selector: 'node.updated', style: { 'background-color': '#edf1cf', 'border-color': '#a1b54c', 'border-width': 3 } },
  { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'control-point-step-size': 54,
    'line-color': '#9aac9e', 'target-arrow-color': '#82998b', 'target-arrow-shape': 'data(arrow)',
    'arrow-scale': .8, label: 'data(label)', color: '#536e5c', 'font-size': 10,
    'font-family': 'system-ui, "Noto Sans CJK SC", sans-serif', 'text-wrap': 'wrap', 'text-overflow-wrap': 'anywhere', 'text-max-width': 116,
    'text-background-color': '#f8faf6', 'text-background-opacity': .95, 'text-background-padding': 3,
    'text-border-color': '#e0e7db', 'text-border-width': 1, 'text-border-opacity': 1,
    'text-rotation': 'none', 'overlay-opacity': 0 } },
  { selector: 'edge.qualified', style: { 'line-style': 'dashed', 'line-color': '#b29b69', 'target-arrow-color': '#b29b69', color: '#7b6537' } },
  { selector: 'edge.quiet', style: { 'text-opacity': 0 } },
  { selector: '.faded', style: { opacity: .16, 'text-opacity': .25 } },
  { selector: 'node.neighbor', style: { 'border-width': 2, 'border-color': '#648c76' } },
  { selector: 'node.selected', style: { 'border-width': 3, 'border-color': '#315f4d', 'background-color': '#dcebd9', 'font-weight': 700 } },
  { selector: 'edge.neighbor, edge.selected, edge.hover', style: { width: 2.5, 'line-color': '#48785c', 'target-arrow-color': '#48785c',
    'text-opacity': 1, color: '#294d38', 'z-index': 20 } },
  { selector: '.filtered', style: { display: 'none' } }
];

export function createGraphRenderer({ container, onSelect, onBackground, onViewportChange = () => {}, createEngine = cytoscape }) {
  const cy = createEngine({ container, elements: [], style, layout: { name: 'preset' },
    minZoom: .03, maxZoom: 2.5, boxSelectionEnabled: false,
    autounselectify: true, selectionType: 'single', pixelRatio: 'auto' });
  let topology = '', filterKey = '', internal = 0, selected = null;
  const highlights = new Map();
  function programmatic(work) { internal++; try { return work(); } finally { internal--; } }
  const shown = () => cy.elements().not('.filtered');
  cy.on('tap', 'node', event => onSelect('node', event.target.id()));
  cy.on('tap', 'edge', event => onSelect('relation', event.target.data('relationId')));
  cy.on('tap', event => { if (event.target === cy) onBackground(); });
  cy.on('zoom pan drag', () => { if (!internal) onViewportChange(); });
  cy.on('mouseover', 'edge', event => event.target.addClass('hover'));
  cy.on('mouseout', 'edge', event => event.target.removeClass('hover'));
  function focus(value) {
    selected = value;
    cy.batch(() => {
      cy.elements().removeClass('selected neighbor faded');
      if (!value) return;
      const current = cy.getElementById(value.kind === 'node' ? value.id : relationId(value.id));
      if (!current.length || current.hasClass('filtered')) return;
      const nearby = value.kind === 'node' ? current.closedNeighborhood() : current.union(current.connectedNodes());
      cy.elements().difference(nearby).addClass('faded');
      nearby.difference(current).addClass('neighbor'); current.addClass('selected');
    });
  }
  return {
    update(nodes, relations, { visibleNodes, visibleRelations, selection }) {
      const nextTopology = JSON.stringify([nodes.map(n => n.id).sort(), relations.map(r => [r.id, r.subject_item_id, r.object_item_id]).sort()]);
      const nextFilter = JSON.stringify([visibleNodes.map(n => n.id).sort(), visibleRelations.map(r => r.id).sort()]);
      const structural = nextTopology !== topology, filtered = nextFilter !== filterKey;
      const ids = new Set(nodes.map(n => n.id)), edgeIds = new Set(relations.map(r => relationId(r.id)));
      programmatic(() => {
        cy.batch(() => {
          cy.edges().filter(e => !edgeIds.has(e.id())).remove();
          cy.nodes().filter(n => !ids.has(n.id())).remove();
          for (const node of nodes) {
            const label = knowledgeName(node);
            const short = [...label].length > 20 ? [...label].slice(0, 19).join('') + '…' : label;
            const data = { id: node.id, label, typeLabel: node.typeLabel, displayLabel: `${short}\n${node.typeLabel}`, color: NODE_COLORS[node.typeLabel] || NODE_COLORS.其他 };
            const current = cy.getElementById(node.id);
            if (current.length) current.data(data); else cy.add({ group: 'nodes', data });
          }
          for (const relation of relations) {
            const data = { id: relationId(relation.id), relationId: relation.id, source: relation.subject_item_id,
              target: relation.object_item_id, label: relation.label, arrow: relation.symmetric ? 'none' : 'triangle' };
            let current = cy.getElementById(data.id);
            if (current.length && (current.data('source') !== data.source || current.data('target') !== data.target)) { current.remove(); current = cy.collection(); }
            if (!current.length) current = cy.add({ group: 'edges', data }); else current.data(data);
            current.toggleClass('qualified', relation.qualified).toggleClass('quiet', relations.length > 24);
          }
          // Layout is based on the entire actual graph; filters never reclassify
          // connected knowledge as an independent fact or discard saved positions.
          if (structural) cy.elements().removeClass('filtered');
        });
        if (structural) arrangeGraph(cy, { width: container.clientWidth || 900, height: container.clientHeight || 500 });
        const shownNodes = new Set(visibleNodes.map(n => n.id)), shownEdges = new Set(visibleRelations.map(r => r.id));
        cy.batch(() => {
          cy.nodes().forEach(n => n.toggleClass('filtered', !shownNodes.has(n.id())));
          cy.edges().forEach(e => e.toggleClass('filtered', !shownEdges.has(e.data('relationId'))));
        });
        focus(selection);
      });
      topology = nextTopology; filterKey = nextFilter;
      return { structural, filtered, connected: cy.nodes('[group = "connected"]').not('.filtered').length,
        independent: cy.nodes('[group = "independent"]').not('.filtered').length };
    },
    fit() { programmatic(() => { cy.resize(); if (shown().nodes().length) cy.fit(shown(), 30); else { cy.zoom(1); cy.pan({ x: 0, y: 0 }); } }); },
    zoom(factor) { programmatic(() => cy.zoom({ level: Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * factor)),
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })); },
    pan(x, y) { programmatic(() => cy.panBy({ x, y })); },
    resize() { programmatic(() => cy.resize()); },
    arrange() { programmatic(() => { cy.elements().removeClass('filtered'); arrangeGraph(cy, { width: container.clientWidth || 900, height: container.clientHeight || 500 }); }); },
    save() { return { topology, zoom: cy.zoom(), pan: { ...cy.pan() }, positions: cy.nodes().map(n => ({ id: n.id(), ...n.position() })) }; },
    restore(view) {
      // A live topology change invalidates saved coordinates: partial restoration
      // can put new nodes directly on top of old ones. Let the host arrange afresh.
      if (view.topology !== topology) return false;
      programmatic(() => { cy.resize(); cy.batch(() => { for (const p of view.positions) cy.getElementById(p.id).position({ x: p.x, y: p.y }); }); cy.viewport({ zoom: view.zoom, pan: view.pan }); }); focus(selected); return true; },
    highlight(id) {
      clearTimeout(highlights.get(id)); cy.getElementById(id).addClass('updated');
      highlights.set(id, setTimeout(() => { highlights.delete(id); cy.getElementById(id).removeClass('updated'); }, 1900));
    },
    destroy() { for (const timer of highlights.values()) clearTimeout(timer); highlights.clear(); cy.destroy(); }
  };
}
