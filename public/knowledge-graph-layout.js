// Stable, compact cells leave clear horizontal and vertical lanes for edges.
// No simulation runs during polling, filtering or keyboard navigation.
export const GRAPH_NODE = Object.freeze({ width: 156, height: 40, stepX: 212, stepY: 92, margin: 40 });

export function stableGraphLayout(nodes, relations, previous = new Map(), columns = 5) {
  const ids = new Set(nodes.map(n => n.id));
  const result = new Map([...previous].filter(([id]) => ids.has(id)));
  const occupied = new Set([...result.values()].map(p => `${p.col},${p.row}`));
  const neighbors = new Map(nodes.map(n => [n.id, new Set()]));
  for (const r of relations) {
    if (!ids.has(r.subject_item_id) || !ids.has(r.object_item_id) ||
      !(r.assertions || []).some(a => ['active', 'needs_review'].includes(a.status))) continue;
    neighbors.get(r.subject_item_id).add(r.object_item_id);
    neighbors.get(r.object_item_id).add(r.subject_item_id);
  }
  const byDegree = (a, b) => neighbors.get(b).size - neighbors.get(a).size || a.localeCompare(b);
  const order = [], visited = new Set();
  for (const id of [...ids].sort(byDegree)) {
    if (visited.has(id)) continue;
    const queue = [id]; visited.add(id);
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]; order.push(next);
      for (const neighbor of [...neighbors.get(next)].sort(byDegree)) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
  }
  for (const id of order) {
    if (result.has(id)) continue;
    const near = [...neighbors.get(id)].map(n => result.get(n)).filter(Boolean);
    const candidates = new Map();
    for (const p of near) for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]]) {
      const col = p.col + dc, row = p.row + dr, key = `${col},${row}`;
      if (col >= 0 && col < columns && row >= 0 && !occupied.has(key)) candidates.set(key, { col, row });
    }
    const distance = p => near.reduce((sum, n) => sum + Math.abs(p.col - n.col) + Math.abs(p.row - n.row), 0);
    let cell = [...candidates.values()].sort((a, b) => distance(a) - distance(b) || a.row - b.row || a.col - b.col)[0];
    for (let i = 0; !cell; i++) {
      const col = i % columns, row = Math.floor(i / columns);
      if (!occupied.has(`${col},${row}`)) cell = { col, row };
    }
    occupied.add(`${cell.col},${cell.row}`);
    result.set(id, { ...cell, x: GRAPH_NODE.margin + cell.col * GRAPH_NODE.stepX, y: GRAPH_NODE.margin + cell.row * GRAPH_NODE.stepY });
  }
  return result;
}

function crossesNode(a, b, node) {
  let low = 0, high = 1;
  for (const [axis, size] of [['x', GRAPH_NODE.width], ['y', GRAPH_NODE.height]]) {
    const delta = b[axis] - a[axis], min = node[axis] - 8, max = node[axis] + size + 8;
    if (!delta) { if (a[axis] < min || a[axis] > max) return false; continue; }
    const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta;
    low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
    if (low > high) return false;
  }
  return true;
}
const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
function compact(points) {
  const result = [];
  for (const p of points) {
    const b = result.at(-1), a = result.at(-2);
    if (b && b.x === p.x && b.y === p.y) continue;
    if (a && (a.x === b.x && b.x === p.x || a.y === b.y && b.y === p.y)) result.pop();
    result.push(p);
  }
  return result;
}

// Straight edges are used only when clear. Otherwise use the cell lanes, which
// remain free even when a later streaming update fills a previously empty cell.
export function routeGraphRelation(relation, positions, lane = 0, parallelCount = 1) {
  const a = positions.get(relation.subject_item_id), b = positions.get(relation.object_item_id);
  if (!a || !b || a === b) return null;
  const { width: w, height: h, stepX, stepY } = GRAPH_NODE;
  const dx = b.x - a.x, dy = b.y - a.y;
  const factor = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  const direct = [{ x: a.x + w / 2 + dx * factor, y: a.y + h / 2 + dy * factor },
    { x: b.x + w / 2 - dx * factor, y: b.y + h / 2 - dy * factor }];
  let points;
  if (!lane && ![...positions.values()].some(p => p !== a && p !== b && crossesNode(...direct, p))) points = direct;
  else {
    const offset = (lane % 5 - 2) * 4, gapY = (stepY - h) / 2, gapX = (stepX - w) / 2;
    const candidates = [];
    for (const sideA of [-1, 1]) for (const sideB of [-1, 1]) {
      const start = { x: a.x + w / 2, y: a.y + (sideA < 0 ? 0 : h) };
      const end = { x: b.x + w / 2, y: b.y + (sideB < 0 ? 0 : h) };
      const y1 = start.y + sideA * gapY + offset, y2 = end.y + sideB * gapY + offset;
      for (const x of [a.x - gapX + offset, a.x + w + gapX + offset, b.x - gapX + offset, b.x + w + gapX + offset]) {
        candidates.push(compact([start, { x: start.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: end.x, y: y2 }, end]));
      }
    }
    const cost = p => p.slice(1).reduce((sum, next, i) => sum + length(p[i], next), 0) + p.length * 12;
    points = candidates.sort((a, b) => cost(a) - cost(b))[0];
  }
  // Put the label on a long segment; its width fits between node boundaries.
  let best = 0;
  for (let i = 1; i < points.length - 1; i++) if (length(points[i], points[i + 1]) > length(points[best], points[best + 1])) best = i;
  const p = points[best], q = points[best + 1];
  // Parallel relation labels share the available segment instead of stacking.
  const portion = (lane + .5) / parallelCount;
  const fraction = p.x < q.x || p.x === q.x && p.y < q.y ? portion : 1 - portion;
  return { points, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '),
    label: { x: p.x + (q.x - p.x) * fraction, y: p.y + (q.y - p.y) * fraction,
      width: Math.min(120, Math.max(40, Math.abs(q.x - p.x) / parallelCount || 120)) - 8 } };
}
