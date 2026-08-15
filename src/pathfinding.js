// A* over the tile grid, with a tiny binary heap and a string-pulling pass so
// guards walk diagonals instead of stair-stepping.

import { T } from './level.js';
import { rayDistance } from './raycast.js';

class Heap {
  constructor() {
    this.items = [];
    this.costs = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, cost) {
    let i = this.items.length;
    this.items.push(item);
    this.costs.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.costs[p] <= this.costs[i]) break;
      this._swap(p, i);
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastCost = this.costs.pop();
    if (this.items.length) {
      this.items[0] = lastItem;
      this.costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.costs[l] < this.costs[m]) m = l;
        if (r < this.items.length && this.costs[r] < this.costs[m]) m = r;
        if (m === i) break;
        this._swap(m, i);
        i = m;
      }
    }
    return top;
  }
  _swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
  }
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
];

/** Guards can open doors, so a closed door is passable but expensive. */
function stepCost(level, tx, ty) {
  if (level.tileAt(tx, ty) !== 0) return Infinity;
  const door = level.doorAt(tx, ty);
  if (door) {
    if (door.locked) return Infinity;
    return door.open ? 1 : 2.5;
  }
  return 1;
}

function passable(level, tx, ty) {
  return stepCost(level, tx, ty) !== Infinity;
}

/**
 * Find a tile path from world point A to world point B.
 * Returns an array of world-space waypoints (excluding the start), or null.
 */
export function findPath(level, sx, sy, gx, gy, maxNodes = 6000) {
  const w = level.w;
  const startX = Math.floor(sx / T);
  const startY = Math.floor(sy / T);
  let goalX = Math.floor(gx / T);
  let goalY = Math.floor(gy / T);

  if (!passable(level, goalX, goalY)) {
    const alt = nearestOpen(level, goalX, goalY);
    if (!alt) return null;
    goalX = alt.x;
    goalY = alt.y;
  }
  if (startX === goalX && startY === goalY) return [];

  const startIdx = startY * w + startX;
  const goalIdx = goalY * w + goalX;

  const gScore = new Map([[startIdx, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  const open = new Heap();
  const h = (x, y) => {
    const dx = Math.abs(x - goalX);
    const dy = Math.abs(y - goalY);
    return (dx + dy) + (1.4142 - 2) * Math.min(dx, dy);
  };
  open.push(startIdx, h(startX, startY));

  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === goalIdx) return buildPath(level, cameFrom, cur, sx, sy);
    if (closed.has(cur)) continue;
    closed.add(cur);
    if (++expanded > maxNodes) break;

    const cx = cur % w;
    const cy = (cur / w) | 0;
    const cg = gScore.get(cur);

    for (const [dx, dy, base] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!level.inBounds(nx, ny)) continue;
      const c = stepCost(level, nx, ny);
      if (c === Infinity) continue;
      // No cutting corners diagonally through wall wedges.
      if (dx && dy && (!passable(level, cx + dx, cy) || !passable(level, cx, cy + dy))) continue;

      const ni = ny * w + nx;
      if (closed.has(ni)) continue;
      const ng = cg + base * c;
      if (ng < (gScore.get(ni) ?? Infinity)) {
        gScore.set(ni, ng);
        cameFrom.set(ni, cur);
        open.push(ni, ng + h(nx, ny));
      }
    }
  }
  return null;
}

function buildPath(level, cameFrom, endIdx, sx, sy) {
  const w = level.w;
  const tiles = [];
  let cur = endIdx;
  while (cur !== undefined) {
    tiles.push(cur);
    cur = cameFrom.get(cur);
  }
  tiles.reverse();

  const pts = tiles.map((i) => ({
    x: (i % w) * T + T / 2,
    y: ((i / w) | 0) * T + T / 2,
  }));
  pts.shift(); // the tile we already stand in
  return smooth(level, sx, sy, pts);
}

/** Drop waypoints we can walk straight past. */
function smooth(level, sx, sy, pts) {
  if (pts.length < 2) return pts;
  const out = [];
  let cx = sx;
  let cy = sy;
  let i = 0;
  while (i < pts.length) {
    let best = i;
    for (let j = pts.length - 1; j > i; j--) {
      if (clearWalk(level, cx, cy, pts[j].x, pts[j].y)) {
        best = j;
        break;
      }
    }
    out.push(pts[best]);
    cx = pts[best].x;
    cy = pts[best].y;
    i = best + 1;
  }
  return out;
}

/** Straight-line walkability, keeping a body-width margin off walls. */
function clearWalk(level, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const ux = dx / d;
  const uy = dy / d;
  const nx = -uy * 9;
  const ny = ux * 9;
  const blocked = (tx, ty) => {
    // A closed but unlocked door is walkable for guards; treat it as open here
    // so smoothing does not fight the path that already accounted for it.
    if (level.doorAt(tx, ty)) return level.doorAt(tx, ty).locked;
    return level.blocksMove(tx, ty);
  };
  for (const [ox, oy] of [[0, 0], [nx, ny], [-nx, -ny]]) {
    if (rayDistance(level, x0 + ox, y0 + oy, ux, uy, d, blocked) < d - 0.5) return false;
  }
  return true;
}

/** Breadth-first search for the closest walkable tile to a blocked target. */
export function nearestOpen(level, tx, ty, maxRadius = 8) {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (level.inBounds(nx, ny) && passable(level, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
