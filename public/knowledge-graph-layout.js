// All coordinates are Cytoscape node centres. Layout only uses real relations;
// component boundaries and the independent section are whitespace, not nodes.
export const GRAPH_NODE = Object.freeze({ width: 164, height: 56, margin: 36 });
const NODE_GAP = 28, COMPONENT_GAP = 88, GROUP_GAP = 132;
const compareId = (a, b) => a.id() < b.id() ? -1 : a.id() > b.id() ? 1 : 0;
const finiteSize = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

function dimensions(node) {
  return { width: Math.max(GRAPH_NODE.width, finiteSize(node.outerWidth(), GRAPH_NODE.width)),
    height: Math.max(GRAPH_NODE.height, finiteSize(node.outerHeight(), GRAPH_NODE.height)) };
}

function bounds(points) {
  const left = Math.min(...points.map(p => p.x - p.width / 2)), top = Math.min(...points.map(p => p.y - p.height / 2));
  return { left, top, width: Math.max(...points.map(p => p.x + p.width / 2)) - left,
    height: Math.max(...points.map(p => p.y + p.height / 2)) - top };
}

// A depth-first ordering keeps relation neighbourhoods together before CoSE.
// Unique, slightly asymmetric seeds avoid CoSE's random coincident-node rescue.
function seedComponent(nodes, neighbors, sizes) {
  const byDegree = (a, b) => neighbors.get(b.id()).size - neighbors.get(a.id()).size || compareId(a, b);
  const root = nodes.slice().sort(byDegree)[0], order = [], seen = new Set(), stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.id())) continue;
    seen.add(node.id()); order.push(node);
    const next = [...neighbors.get(node.id())].filter(n => !seen.has(n.id())).sort(byDegree);
    stack.push(...next.reverse());
  }
  const radius = Math.max(140, nodes.length * (Math.max(...sizes.map(s => s.width)) + NODE_GAP) / (2 * Math.PI));
  order.forEach((node, i) => {
    const angle = 2 * Math.PI * i / order.length + .17;
    node.position({ x: radius * Math.cos(angle) + i * .013, y: radius * Math.sin(angle) + i * .021 });
  });
}

// CoSE avoids most collisions, but its force approximation does not guarantee
// rectangular label clearance. Separate locally, then use a finite sweep as a
// guarantee, including headless and unusually dense graphs.
function separateOverlaps(points) {
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j], dx = b.x - a.x, dy = b.y - a.y;
      const overlapX = (a.width + b.width) / 2 + NODE_GAP - Math.abs(dx);
      const overlapY = (a.height + b.height) / 2 + NODE_GAP - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      if (overlapX < overlapY) {
        const shift = (overlapX + .1) / 2 * (dx < 0 ? -1 : 1); a.x -= shift; b.x += shift;
      } else {
        const shift = (overlapY + .1) / 2 * (dy < 0 ? -1 : 1); a.y -= shift; b.y += shift;
      }
    }
    if (!moved) return;
  }
  const ordered = points.slice().sort((a, b) => a.y - b.y || a.x - b.x || compareId(a.node, b.node));
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < i; j++) {
    const a = ordered[j], b = ordered[i];
    if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 + NODE_GAP) {
      b.y = Math.max(b.y, a.y + (a.height + b.height) / 2 + NODE_GAP);
    }
  }
}

function arrangeComponent(cy, nodes, edges, neighbors, viewport) {
  const sizes = nodes.map(dimensions);
  if (nodes.length < 3) {
    nodes.forEach((node, i) => node.position({ x: i * (Math.max(...sizes.map(s => s.width)) + 112), y: 0 }));
  } else {
    seedComponent(nodes, neighbors, sizes);
    cy.collection([...nodes, ...edges]).layout({
      name: 'cose', animate: false, randomize: false, fit: false,
      nodeDimensionsIncludeLabels: false, nodeRepulsion: 28000, nodeOverlap: 16,
      idealEdgeLength: 112, edgeElasticity: 100, gravity: .12,
      numIter: 700, initialTemp: 160, coolingFactor: .985, minTemp: .25
    }).run();
  }
  const initial = nodes.map((node, i) => ({ node, ...sizes[i],
    x: Number.isFinite(node.position('x')) ? node.position('x') : i * (sizes[i].width + NODE_GAP),
    y: Number.isFinite(node.position('y')) ? node.position('y') : 0 }));
  const centre = initial.reduce((sum, p) => ({ x: sum.x + p.x / nodes.length, y: sum.y + p.y / nodes.length }), { x: 0, y: 0 });
  const covariance = initial.reduce((sum, p) => ({ xx: sum.xx + (p.x - centre.x) ** 2,
    yy: sum.yy + (p.y - centre.y) ** 2, xy: sum.xy + (p.x - centre.x) * (p.y - centre.y) }), { xx: 0, yy: 0, xy: 0 });
  const principalAngle = .5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy);
  // CoSE's orientation is arbitrary. Compare rigid rotations before packing so
  // a long chain does not unnecessarily shrink to fit a landscape viewport.
  const rotations = nodes.length < 3 ? [0] : [0, Math.PI / 2, -principalAngle, Math.PI / 2 - principalAngle];
  const alternatives = rotations.map(angle => {
    const points = initial.map(p => ({ ...p, x: (p.x - centre.x) * Math.cos(angle) - (p.y - centre.y) * Math.sin(angle),
      y: (p.x - centre.x) * Math.sin(angle) + (p.y - centre.y) * Math.cos(angle) }));
    separateOverlaps(points);
    const box = bounds(points);
    return { points, box, fit: Math.min(viewport.width / box.width, viewport.height / box.height) };
  }).sort((a, b) => b.fit - a.fit);
  const { points, box } = alternatives[0];
  for (const point of points) { point.x -= box.left; point.y -= box.top; }
  return { points, width: box.width, height: box.height, id: nodes[0].id() };
}

function packAtWidth(components, independent, sizes, targetWidth) {
  let x = 0, y = 0, rowHeight = 0, width = 0;
  const placements = [];
  for (const component of components) {
    if (x && x + component.width > targetWidth) { x = 0; y += rowHeight + COMPONENT_GAP; rowHeight = 0; }
    placements.push({ component, x, y });
    width = Math.max(width, x + component.width);
    rowHeight = Math.max(rowHeight, component.height);
    x += component.width + COMPONENT_GAP;
  }
  const connectedHeight = y + rowHeight;
  const columns = Math.max(1, Math.min(independent.length, Math.floor((targetWidth + NODE_GAP) / (sizes.width + NODE_GAP))));
  const independentY = connectedHeight ? connectedHeight + GROUP_GAP : 0;
  const rows = Math.ceil(independent.length / columns);
  if (independent.length) width = Math.max(width, columns * (sizes.width + NODE_GAP) - NODE_GAP);
  return { placements, columns, independentY, width,
    height: independent.length ? independentY + rows * (sizes.height + NODE_GAP) - NODE_GAP : connectedHeight };
}

function packComponents(components, independent, viewport) {
  components.sort((a, b) => b.height - a.height || b.width - a.width || (a.id < b.id ? -1 : 1));
  const sizes = { width: Math.max(GRAPH_NODE.width, ...independent.map(n => dimensions(n).width)),
    height: Math.max(GRAPH_NODE.height, ...independent.map(n => dimensions(n).height)) };
  const minWidth = Math.max(sizes.width, ...components.map(c => c.width));
  const area = components.reduce((sum, c) => sum + (c.width + COMPONENT_GAP) * (c.height + COMPONENT_GAP), 0) +
    independent.length * (sizes.width + NODE_GAP) * (sizes.height + NODE_GAP);
  const idealWidth = Math.sqrt(area * viewport.width / viewport.height);
  const candidates = new Set([minWidth]);
  for (let i = 8; i <= 32; i++) candidates.add(Math.max(minWidth, idealWidth * i / 16));
  // Exact grid widths avoid rounding a useful final column away on a narrow view.
  for (let columns = 1; columns <= independent.length; columns++) candidates.add(Math.max(minWidth, columns * (sizes.width + NODE_GAP) - NODE_GAP));
  const layouts = [...candidates].map(targetWidth => {
    const layout = packAtWidth(components, independent, sizes, targetWidth);
    layout.fit = Math.min(viewport.width / (layout.width + GRAPH_NODE.margin * 2), viewport.height / (layout.height + GRAPH_NODE.margin * 2));
    return layout;
  });
  layouts.sort((a, b) => b.fit - a.fit || a.width * a.height - b.width * b.height || a.width - b.width);
  return { ...layouts[0], sizes };
}

// Call on topology changes or an explicit relayout, never on label, selection,
// or progress changes. This function deliberately does not fit, pan, or zoom.
export function arrangeGraph(cy, { width = 960, height = 600 } = {}) {
  const nodes = cy.nodes().toArray().sort(compareId), edges = cy.edges().toArray().sort(compareId);
  if (!nodes.length) return { connected: 0, independent: 0, components: 0 };
  const neighbors = new Map(nodes.map(node => [node.id(), new Set()])), byId = new Map(nodes.map(node => [node.id(), node]));
  for (const edge of edges) {
    const source = byId.get(edge.data('source')), target = byId.get(edge.data('target'));
    if (!source || !target) continue;
    neighbors.get(source.id()).add(target); neighbors.get(target.id()).add(source);
  }
  const independent = nodes.filter(node => !neighbors.get(node.id()).size), components = [], visited = new Set();
  const viewport = { width: finiteSize(width, 960), height: finiteSize(height, 600) };
  cy.batch(() => {
    for (const node of nodes) node.data('group', neighbors.get(node.id()).size ? 'connected' : 'independent');
    for (const node of nodes) {
      if (!neighbors.get(node.id()).size || visited.has(node.id())) continue;
      const members = [], queue = [node]; visited.add(node.id());
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i]; members.push(current);
        for (const neighbor of neighbors.get(current.id())) if (!visited.has(neighbor.id())) {
          visited.add(neighbor.id()); queue.push(neighbor);
        }
      }
      members.sort(compareId);
      const ids = new Set(members.map(member => member.id()));
      components.push(arrangeComponent(cy, members, edges.filter(edge => ids.has(edge.data('source')) && ids.has(edge.data('target'))), neighbors, viewport));
    }
    const packed = packComponents(components, independent, viewport);
    for (const { component, x, y } of packed.placements) for (const point of component.points) {
      point.node.position({ x: GRAPH_NODE.margin + x + point.x, y: GRAPH_NODE.margin + y + point.y });
    }
    independent.forEach((node, i) => node.position({
      x: GRAPH_NODE.margin + packed.sizes.width / 2 + (i % packed.columns) * (packed.sizes.width + NODE_GAP),
      y: GRAPH_NODE.margin + packed.independentY + packed.sizes.height / 2 + Math.floor(i / packed.columns) * (packed.sizes.height + NODE_GAP)
    }));
  });
  return { connected: nodes.length - independent.length, independent: independent.length, components: components.length };
}
