// Ceiling security cameras: slow sweep, narrow cone, fast detection.
// They ignore darkness (IR sensors) but have a short range, and one dart
// takes them out for good.

import { hasLOS, visibilityPoly } from './raycast.js';
import { clamp, dist, angleDelta } from './util.js';

const DEG = Math.PI / 180;

export class SecurityCamera {
  constructor(level, spot, cfg = {}, index = 0) {
    this.level = level;
    this.x = spot.x;
    this.y = spot.y;
    this.index = index;
    this.base = (cfg.angle ?? 0) * DEG;
    this.sweep = (cfg.sweep ?? 70) * DEG;
    this.speed = cfg.speed ?? 0.5;
    this.range = cfg.range ?? 250;
    this.fov = (cfg.fov ?? 46) * DEG;
    this.angle = this.base;
    this.phase = Math.random() * 10;
    this.alive = true;
    this.detect = 0;
    this.sparks = 0;
    this.cone = null;
    this.coneDirty = true;
  }

  destroy() {
    this.alive = false;
    this.sparks = 1;
    this.detect = 0;
  }

  update(dt, game) {
    if (!this.alive) {
      this.sparks = Math.max(0, this.sparks - dt * 0.5);
      return;
    }
    this.phase += dt * this.speed;
    this.angle = this.base + Math.sin(this.phase) * (this.sweep / 2);
    this.coneDirty = true;

    const p = game.player;
    let seeing = false;
    if (p.alive) {
      const d = dist(this.x, this.y, p.x, p.y);
      if (d < this.range) {
        const to = Math.atan2(p.y - this.y, p.x - this.x);
        if (Math.abs(angleDelta(this.angle, to)) < this.fov / 2 &&
            hasLOS(this.level, this.x, this.y, p.x, p.y, this.range)) {
          seeing = true;
          // Crouching under a camera helps a little; darkness does not.
          const stealth = p.stance === 'crouch' ? 0.62 : 1;
          this.detect = clamp(this.detect + (0.55 + 0.9 * (1 - d / this.range)) * stealth * dt, 0, 1.0001);
        }
      }
    }
    if (!seeing) this.detect = Math.max(0, this.detect - dt * 0.6);

    if (this.detect >= 1) {
      this.detect = 0;
      game.cameraSpotted(this);
    }
  }

  getCone() {
    if (this.coneDirty || !this.cone) {
      this.cone = visibilityPoly(
        this.level, this.x, this.y, this.range, 22, this.angle - this.fov / 2, this.fov,
      );
      this.coneDirty = false;
    }
    return this.cone;
  }
}

export default SecurityCamera;
