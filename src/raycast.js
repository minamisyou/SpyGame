// Grid ray casting: line of sight, visibility polygons and the tile light map.
// Everything uses a DDA voxel walk, so cost is O(tiles crossed) rather than
// O(wall segments) — cheap enough to recompute the player's 360° polygon every
// frame.

import { T } from './level.js';
import { TAU, clamp } from './util.js';

/**
 * Walk from (x0,y0) along the unit vector (dx,dy) until `blocked(tx,ty)` is
 * true or `maxDist` is reached. Returns the travelled distance.
 */
export function rayDistance(level, x0, y0, dx, dy, maxDist, blocked) {
  let tx = Math.floor(x0 / T);
  let ty = Math.floor(y0 / T);
  if (blocked(tx, ty)) return 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  let tMaxX = adx < 1e-9 ? Infinity : (dx > 0 ? (tx + 1) * T - x0 : x0 - tx * T) / adx;
  let tMaxY = ady < 1e-9 ? Infinity : (dy > 0 ? (ty + 1) * T - y0 : y0 - ty * T) / ady;
  const tDeltaX = adx < 1e-9 ? Infinity : T / adx;
  const tDeltaY = ady < 1e-9 ? Infinity : T / ady;

  let t = 0;
  // Hard iteration cap: a ray can never cross more tiles than this.
  for (let i = 0; i < 512; i++) {
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      t = tMaxY;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (t >= maxDist) return maxDist;
    if (!level.inBounds(tx, ty) || blocked(tx, ty)) return t;
  }
  return maxDist;
}

const sightBlocked = (level) => (tx, ty) => level.blocksSight(tx, ty);
const moveBlocked = (level) => (tx, ty) => level.blocksMove(tx, ty);

/** True when nothing opaque sits between the two world points. */
export function hasLOS(level, x0, y0, x1, y1, maxDist = Infinity) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  if (d > maxDist) return false;
  const hit = rayDistance(level, x0, y0, dx / d, dy / d, d, sightBlocked(level));
  return hit >= d - 0.5;
}

/** Same as hasLOS but glass stops it — used for bullets. */
export function bulletTravel(level, x0, y0, dx, dy, maxDist) {
  return rayDistance(level, x0, y0, dx, dy, maxDist, moveBlocked(level));
}

/**
 * Radial visibility polygon. Returns a Float32Array of hit distances for
 * `rays` evenly spaced directions starting at `startAngle` and spanning
 * `spread` radians. Callers turn it into a canvas path.
 */
export function visibilityPoly(level, x, y, radius, rays, startAngle = 0, spread = TAU) {
  const out = new Float32Array(rays);
  const blocked = sightBlocked(level);
  const step = spread / (spread >= TAU - 1e-6 ? rays : rays - 1);
  for (let i = 0; i < rays; i++) {
    const a = startAngle + i * step;
    out[i] = rayDistance(level, x, y, Math.cos(a), Math.sin(a), radius, blocked);
  }
  return out;
}

/** Trace a visibility polygon onto a 2D context (world coordinates). */
export function tracePoly(ctx, x, y, radii, radius, startAngle = 0, spread = TAU, closeToCenter = false) {
  const n = radii.length;
  const step = spread / (spread >= TAU - 1e-6 ? n : n - 1);
  ctx.beginPath();
  if (closeToCenter) ctx.moveTo(x, y);
  for (let i = 0; i < n; i++) {
    const a = startAngle + i * step;
    // Nudge outward slightly so the polygon reaches into the wall tile and we
    // do not get a hairline gap along wall faces.
    const r = Math.min(radii[i] + 1.5, radius + 1.5);
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0 && !closeToCenter) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Recompute the per-tile light map and each light's occlusion polygon.
 * Called on load and whenever a light dies or a door changes state.
 */
export function rebuildLighting(level) {
  const map = level.lightmap;
  map.fill(level.ambient);

  const blocked = sightBlocked(level);

  for (const light of level.lights) {
    if (!light.alive) {
      light.poly = null;
      continue;
    }
    light.poly = visibilityPoly(level, light.x, light.y, light.radius, 140);

    const r = light.radius;
    const tr = Math.ceil(r / T);
    const ltx = Math.floor(light.x / T);
    const lty = Math.floor(light.y / T);

    for (let ty = lty - tr; ty <= lty + tr; ty++) {
      if (ty < 0 || ty >= level.h) continue;
      for (let tx = ltx - tr; tx <= ltx + tr; tx++) {
        if (tx < 0 || tx >= level.w) continue;
        const cx = tx * T + T / 2;
        const cy = ty * T + T / 2;
        const dx = cx - light.x;
        const dy = cy - light.y;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;

        // Falloff, then occlusion check against walls.
        const falloff = (1 - d / r) ** 1.4;
        if (falloff <= 0.002) continue;
        if (d > T * 0.5) {
          const hit = rayDistance(level, light.x, light.y, dx / d, dy / d, d, blocked);
          if (hit < d - T * 0.55) continue;
        }
        const i = ty * level.w + tx;
        map[i] = clamp(map[i] + falloff * light.power, 0, 1);
      }
    }
  }
  level.lightDirty = false;
}
