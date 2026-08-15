#!/usr/bin/env node
// Sanity-checks the ASCII maps: rectangular grids, sealed borders, every patrol
// node present, and every objective reachable from the insertion point.
//
//   node tools/validate-levels.mjs

import { LEVELS } from '../src/levels.js';

const WALKABLE = new Set(['.', 'D', '+', '*', 'C', '@', 'X', 'I', 'A', 'B', 'K']);
const isNode = (c) => /^[0-9a-z]$/.test(c);

let failures = 0;
const fail = (lv, msg) => {
  console.error(`  ✗ [${lv.id}] ${msg}`);
  failures++;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

function walkable(ch) {
  return WALKABLE.has(ch) || isNode(ch);
}

for (const lv of LEVELS) {
  console.log(`\n${lv.id} — ${lv.name}`);
  const map = lv.map;
  const h = map.length;
  const w = Math.max(...map.map((r) => r.length));

  // --- geometry ---
  const ragged = map
    .map((r, i) => [i, r.length])
    .filter(([, len]) => len !== w);
  if (ragged.length) {
    fail(lv, `rows are not all ${w} wide: ${ragged.map(([i, l]) => `row ${i}=${l}`).join(', ')}`);
  } else {
    ok(`grid ${w}×${h}`);
  }

  for (let x = 0; x < w; x++) {
    if (map[0][x] !== '#' || map[h - 1][x] !== '#') fail(lv, `open top/bottom border at column ${x}`);
  }
  for (let y = 0; y < h; y++) {
    const row = map[y];
    if (row[0] !== '#' || row[row.length - 1] !== '#') fail(lv, `open left/right border at row ${y}`);
  }

  // --- markers ---
  const counts = {};
  const nodes = new Map();
  let start = null;
  let exit = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const c = map[y][x];
      counts[c] = (counts[c] || 0) + 1;
      if (c === '@') start = { x, y };
      if (c === 'X') exit = { x, y };
      if (isNode(c)) {
        if (nodes.has(c)) fail(lv, `duplicate node '${c}'`);
        nodes.set(c, { x, y });
      }
    }
  }
  if (counts['@'] !== 1) fail(lv, `expected exactly one '@', found ${counts['@'] || 0}`);
  if (counts['X'] !== 1) fail(lv, `expected exactly one 'X', found ${counts['X'] || 0}`);
  if (!counts['I']) fail(lv, 'no data terminals');
  const camCount = counts['C'] || 0;
  if (camCount > (lv.cams || []).length) {
    fail(lv, `${camCount} 'C' markers but only ${(lv.cams || []).length} camera configs`);
  }
  if ((counts['+'] || 0) > 0 && !(counts['K'] || 0)) fail(lv, 'locked door but no keycard');
  ok(`${counts['I']} terminals · ${counts['*'] || 0} lights · ${camCount} cameras · ${nodes.size} nav nodes`);

  // --- guard routes ---
  for (const [gi, g] of (lv.guards || []).entries()) {
    for (const ch of g.route) {
      if (!nodes.has(ch)) fail(lv, `guard ${gi} references missing node '${ch}'`);
    }
    if (g.route.length < 2) fail(lv, `guard ${gi} needs at least 2 route nodes`);
  }
  const used = new Set((lv.guards || []).flatMap((g) => g.route));
  for (const ch of nodes.keys()) {
    if (!used.has(ch)) console.warn(`  ! [${lv.id}] node '${ch}' is never used by a patrol`);
  }

  // --- reachability ---
  const flood = (allowLocked) => {
    const seen = new Set();
    if (!start) return seen;
    const q = [start];
    seen.add(`${start.x},${start.y}`);
    while (q.length) {
      const { x, y } = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || ny >= h || nx >= map[ny].length) continue;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        const ch = map[ny][nx];
        if (!walkable(ch)) continue;
        if (!allowLocked && ch === '+') continue;
        seen.add(key);
        q.push({ x: nx, y: ny });
      }
    }
    return seen;
  };

  // --- the insertion point must be safe ---
  // A patrol node too close to '@' means a guard is standing on the player
  // before they have touched a key. Measured as walking distance, not
  // line-of-sight, so a node behind a wall next door is fine.
  const SAFE_TILES = 10;
  if (start) {
    const distMap = new Map([[`${start.x},${start.y}`, 0]]);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      const d = distMap.get(`${cur.x},${cur.y}`);
      if (d >= SAFE_TILES) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || ny >= h || nx >= map[ny].length) continue;
        const key = `${nx},${ny}`;
        if (distMap.has(key) || !walkable(map[ny][nx])) continue;
        distMap.set(key, d + 1);
        q.push({ x: nx, y: ny });
      }
    }
    let tooClose = 0;
    for (const [ch, pos] of nodes) {
      const d = distMap.get(`${pos.x},${pos.y}`);
      if (d !== undefined) {
        fail(lv, `patrol node '${ch}' is only ${d} tiles from the insertion point (needs > ${SAFE_TILES})`);
        tooClose++;
      }
    }
    if (!tooClose) ok(`insertion point is clear of patrol nodes (> ${SAFE_TILES} tiles)`);
  }

  if (start) {
    const seen = flood(true);
    // The keycard must be obtainable before any locked door is opened.
    const preKey = flood(false);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < map[y].length; x++) {
        if (map[y][x] === 'K' && !preKey.has(`${x},${y}`)) {
          fail(lv, `keycard at (${x},${y}) is itself behind a locked door`);
        }
      }
    }
    const check = (label, pos) => {
      if (!pos) return;
      if (!seen.has(`${pos.x},${pos.y}`)) fail(lv, `${label} at (${pos.x},${pos.y}) is unreachable`);
    };
    check('exit', exit);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < map[y].length; x++) {
        const c = map[y][x];
        if (c === 'I') check('terminal', { x, y });
        if (c === 'K') check('keycard', { x, y });
        if (isNode(c)) check(`node '${c}'`, { x, y });
      }
    }
    ok(`${seen.size} tiles reachable from insertion point`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} problem(s) found.`);
  process.exit(1);
}
console.log('All levels valid.');
