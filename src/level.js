// Level parsing + world queries (collision, sight, light).

import { clamp } from './util.js';

export const T = 32; // tile size in world pixels

export const FLOOR = 0;
export const WALL = 1;
export const GLASS = 2;

const NODE_CHARS = /[0-9a-z]/;

export class Level {
  constructor(def) {
    this.def = def;
    this.name = def.name;
    this.ambient = def.ambient ?? 0.15;

    const rows = def.map;
    this.w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    this.h = rows.length;
    this.tiles = new Uint8Array(this.w * this.h).fill(WALL);

    this.nodes = new Map();
    this.doors = [];
    this.lights = [];
    this.cams = [];
    this.terminals = [];
    this.pickups = [];
    this.start = { x: T * 1.5, y: T * 1.5 };
    this.extraction = { x: T * 1.5, y: T * 1.5 };

    this.doorGrid = new Map(); // tileIndex -> door

    for (let y = 0; y < this.h; y++) {
      const row = rows[y];
      for (let x = 0; x < this.w; x++) {
        const ch = x < row.length ? row[x] : '#';
        const idx = y * this.w + x;
        const cx = x * T + T / 2;
        const cy = y * T + T / 2;

        let tile = FLOOR;
        switch (ch) {
          case '#':
            tile = WALL;
            break;
          case '=':
            tile = GLASS;
            break;
          case 'D':
          case '+': {
            const door = {
              tx: x, ty: y, x: cx, y: cy,
              locked: ch === '+',
              open: false,
              openAmt: 0,
              // Doors in a vertical wall run swing on the horizontal axis.
              horizontal: this._isHorizontalDoor(rows, x, y),
            };
            this.doors.push(door);
            this.doorGrid.set(idx, door);
            break;
          }
          case '*':
            this.lights.push({
              x: cx, y: cy,
              radius: 7.2 * T,
              power: 1,
              alive: true,
              flicker: Math.random() * 10,
              poly: null,
            });
            break;
          case 'C':
            this.cams.push({ x: cx, y: cy, tx: x, ty: y });
            break;
          case '@':
            this.start = { x: cx, y: cy };
            break;
          case 'X':
            this.extraction = { x: cx, y: cy };
            break;
          case 'I':
            this.terminals.push({ x: cx, y: cy, hacked: false, progress: 0 });
            break;
          case 'A':
            this.pickups.push({ x: cx, y: cy, kind: 'ammo', taken: false });
            break;
          case 'B':
            this.pickups.push({ x: cx, y: cy, kind: 'bottle', taken: false });
            break;
          case 'K':
            this.pickups.push({ x: cx, y: cy, kind: 'keycard', taken: false });
            break;
          default:
            if (NODE_CHARS.test(ch)) this.nodes.set(ch, { x: cx, y: cy, tx: x, ty: y });
            break;
        }
        this.tiles[idx] = tile;
      }
    }

    this.pxW = this.w * T;
    this.pxH = this.h * T;

    this.lightmap = new Float32Array(this.w * this.h);
    this.lightDirty = true;
  }

  /** A door sits in a wall run; figure out which way the wall runs. */
  _isHorizontalDoor(rows, x, y) {
    const at = (px, py) => {
      const r = rows[py];
      if (!r) return '#';
      return px < r.length ? r[px] : '#';
    };
    const solid = (c) => c === '#';
    return solid(at(x - 1, y)) && solid(at(x + 1, y));
  }

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  tileAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return WALL;
    return this.tiles[ty * this.w + tx];
  }

  doorAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return null;
    return this.doorGrid.get(ty * this.w + tx) || null;
  }

  /** Blocks bodies and bullets. */
  blocksMove(tx, ty) {
    const t = this.tileAt(tx, ty);
    if (t === WALL || t === GLASS) return true;
    const d = this.doorAt(tx, ty);
    return !!d && !d.open;
  }

  /** Blocks line of sight and light propagation (glass is transparent). */
  blocksSight(tx, ty) {
    if (this.tileAt(tx, ty) === WALL) return true;
    const d = this.doorAt(tx, ty);
    return !!d && !d.open;
  }

  blocksMoveAtPx(x, y) {
    return this.blocksMove(Math.floor(x / T), Math.floor(y / T));
  }

  isWalkable(tx, ty) {
    return !this.blocksMove(tx, ty);
  }

  node(ch) {
    return this.nodes.get(ch);
  }

  /** Bilinear-ish sample of the tile light map, 0..1. */
  lightAt(x, y) {
    const fx = x / T - 0.5;
    const fy = y / T - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const s = (px, py) => {
      if (!this.inBounds(px, py)) return 0;
      return this.lightmap[py * this.w + px];
    };
    const a = s(x0, y0) * (1 - tx) + s(x0 + 1, y0) * tx;
    const b = s(x0, y0 + 1) * (1 - tx) + s(x0 + 1, y0 + 1) * tx;
    return clamp(a * (1 - ty) + b * ty, 0, 1);
  }

  markLightsDirty() {
    this.lightDirty = true;
  }
}

export default Level;
