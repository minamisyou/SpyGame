// The operative: movement, stance, exposure and gear state.

import { T } from './level.js';
import input from './input.js';
import audio from './audio.js';
import { clamp, turnToward, approach } from './util.js';

export const STANCE = {
  crouch: { speed: 62, noise: 0, vis: 0.55, label: 'CROUCH' },
  stand: { speed: 116, noise: 0.42, vis: 1.0, label: 'STAND' },
  sprint: { speed: 196, noise: 1.0, vis: 1.3, label: 'SPRINT' },
};

/** Circle-vs-tiles test used by every moving body. */
export function circleBlocked(level, x, y, r) {
  const minX = Math.floor((x - r) / T);
  const maxX = Math.floor((x + r) / T);
  const minY = Math.floor((y - r) / T);
  const maxY = Math.floor((y + r) / T);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (!level.blocksMove(tx, ty)) continue;
      // Closest point on the tile box to the circle centre.
      const cx = clamp(x, tx * T, tx * T + T);
      const cy = clamp(y, ty * T, ty * T + T);
      if ((cx - x) ** 2 + (cy - y) ** 2 < r * r) return true;
    }
  }
  return false;
}

/** Axis-separated slide movement. Mutates and returns `body`. */
export function moveBody(level, body, dx, dy) {
  const r = body.r;
  if (dx) {
    const nx = body.x + dx;
    if (!circleBlocked(level, nx, body.y, r)) body.x = nx;
  }
  if (dy) {
    const ny = body.y + dy;
    if (!circleBlocked(level, body.x, ny, r)) body.y = ny;
  }
  return body;
}

export class Player {
  constructor(level, def) {
    this.level = level;
    this.x = level.start.x;
    this.y = level.start.y;
    this.r = 9;
    this.angle = 0;
    this.moveAngle = 0;
    this.stance = 'stand';
    this.speedScale = 0;

    this.health = 100;
    this.ammo = def.startAmmo ?? 6;
    this.bottles = def.startBottles ?? 2;
    this.keycard = false;

    this.nvOn = false;
    this.nvBattery = 100;

    this.exposure = 0;      // 0..1 how visible the player currently is
    this.noiseLevel = 0;    // 0..1 HUD-only smoothed noise
    this.stepAccum = 0;
    this.fireCooldown = 0;
    this.throwCooldown = 0;
    this.hurtFlash = 0;
    this.alive = true;
  }

  get moving() {
    return this.speedScale > 0.05;
  }

  update(dt, game) {
    const inp = input;

    // ---- stance -------------------------------------------------------
    const crouching = inp.isDown('KeyC', 'ControlLeft', 'ControlRight') || inp.touchDown('crouch');
    const sprinting = (inp.isDown('ShiftLeft', 'ShiftRight') || inp.touchDown('sprint')) && !crouching;
    this.stance = crouching ? 'crouch' : sprinting ? 'sprint' : 'stand';
    const st = STANCE[this.stance];

    // ---- movement -----------------------------------------------------
    const ax = inp.axis();
    const wants = Math.hypot(ax.x, ax.y);
    this.speedScale = approach(this.speedScale, wants, dt * 8);

    if (wants > 0.01) {
      this.moveAngle = Math.atan2(ax.y, ax.x);
      const v = st.speed * this.speedScale;
      moveBody(this.level, this, ax.x * v * dt, ax.y * v * dt);

      // Footsteps: one noise pulse every stride.
      this.stepAccum += v * dt;
      const stride = this.stance === 'sprint' ? 46 : 60;
      if (this.stepAccum > stride) {
        this.stepAccum = 0;
        audio.step(this.stance === 'sprint', this.stance === 'crouch');
        if (st.noise > 0) {
          game.emitNoise(this.x, this.y, st.noise * (this.stance === 'sprint' ? 250 : 150), 'step');
        }
      }
    } else {
      this.stepAccum = 0;
    }

    // ---- aiming -------------------------------------------------------
    if (game.usingTouch) {
      // Touch: face the way we move.
      if (wants > 0.01) this.angle = turnToward(this.angle, this.moveAngle, dt * 12);
    } else {
      const world = game.screenToWorld(inp.mouse.x, inp.mouse.y);
      this.angle = Math.atan2(world.y - this.y, world.x - this.x);
    }

    // ---- night vision -------------------------------------------------
    if (inp.wasPressed('KeyQ') || inp.touchPressed('nv')) {
      if (this.nvBattery > 4 || this.nvOn) {
        this.nvOn = !this.nvOn;
        audio.nvg(this.nvOn);
      }
    }
    if (this.nvOn) {
      this.nvBattery = Math.max(0, this.nvBattery - 7 * dt);
      if (this.nvBattery <= 0) {
        this.nvOn = false;
        audio.nvg(false);
      }
    } else {
      this.nvBattery = Math.min(100, this.nvBattery + 3.5 * dt);
    }

    // ---- exposure ------------------------------------------------------
    const light = this.level.lightAt(this.x, this.y);
    const motion = this.moving ? 1 : 0.72;
    this.exposure = clamp(light * st.vis * motion + (this.nvOn ? 0.04 : 0), 0, 1);

    // ---- HUD noise decay ----------------------------------------------
    const target = this.moving ? st.noise : 0;
    this.noiseLevel = approach(this.noiseLevel, target, dt * (target > this.noiseLevel ? 6 : 1.5));

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.throwCooldown = Math.max(0, this.throwCooldown - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
  }

  damage(amount) {
    this.health = Math.max(0, this.health - amount);
    this.hurtFlash = 1;
    audio.hit();
    if (this.health <= 0) this.alive = false;
  }
}

export default Player;
