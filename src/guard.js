// Guard AI: patrol → suspicion → investigation → alert → search → patrol.

import { T } from './level.js';
import { findPath } from './pathfinding.js';
import { hasLOS, visibilityPoly } from './raycast.js';
import { moveBody } from './player.js';
import audio from './audio.js';
import { clamp, dist, angleDelta, turnToward, rand, TAU } from './util.js';

export const GUARD_STATE = {
  PATROL: 'patrol',
  LOOK: 'look',
  SUSPECT: 'suspect',
  INVESTIGATE: 'investigate',
  ALERT: 'alert',
  SEARCH: 'search',
  DOWN: 'down',
};

const DEG = Math.PI / 180;

export class Guard {
  constructor(level, def, index) {
    this.level = level;
    this.index = index;
    this.route = (def.route || []).map((c) => level.node(c)).filter(Boolean);
    const spawn = this.route[0] || level.start;

    this.x = spawn.x;
    this.y = spawn.y;
    this.r = 10;
    this.angle = rand(TAU);
    this.baseSpeed = def.speed ?? 60;
    this.fov = (def.fov ?? 76) * DEG;
    this.range = def.range ?? 290;

    this.state = GUARD_STATE.PATROL;
    this.routeIdx = 0;
    this.path = [];
    this.repathTimer = 0;
    this.lookTimer = 0;
    this.lookTarget = this.angle;
    this.stateTimer = 0;

    this.detect = 0;
    this.canSeePlayer = false;
    this.lastKnown = null;
    this.target = null;
    this.shootTimer = 0;
    this.aimTime = 0;
    this.reportedBody = new Set();
    this.down = false;
    this.downFade = 0;
    this.cone = null;   // cached visibility polygon for rendering
    this.coneDirty = true;
    this.speakTimer = 0;
  }

  get alerted() {
    return this.state === GUARD_STATE.ALERT || this.state === GUARD_STATE.SEARCH;
  }

  get viewRange() {
    return this.alerted ? this.range * 1.15 : this.range;
  }

  get viewFov() {
    return this.alerted ? this.fov * 1.35 : this.fov;
  }

  knockOut(game, silent = false) {
    if (this.down) return;
    this.down = true;
    this.state = GUARD_STATE.DOWN;
    this.path = [];
    this.detect = 0;
    if (!silent) audio.takedown();
    game.onGuardDown(this);
  }

  // ------------------------------------------------------------ perception
  perceive(dt, game) {
    const p = game.player;
    this.canSeePlayer = false;
    if (!p.alive) {
      this.detect = Math.max(0, this.detect - dt * 0.5);
      return;
    }

    const d = dist(this.x, this.y, p.x, p.y);
    const range = this.viewRange;
    let gain = 0;

    if (d < range && hasLOS(this.level, this.x, this.y, p.x, p.y, range)) {
      const toPlayer = Math.atan2(p.y - this.y, p.x - this.x);
      const off = Math.abs(angleDelta(this.angle, toPlayer));
      const inCone = off < this.viewFov / 2;
      // Anyone standing right next to a guard gets noticed regardless of facing.
      const brushing = d < 44;

      if (inCone || brushing) {
        this.canSeePlayer = true;
        const exposure = clamp(p.exposure, 0.06, 1);
        const proximity = 1 - d / range;
        const focus = inCone ? 1 - (off / (this.viewFov / 2)) * 0.35 : 0.6;
        gain = (0.42 + 1.55 * proximity) * (0.22 + 1.05 * exposure) * focus;
        if (this.alerted) gain *= 1.7;
        if (brushing) gain = Math.max(gain, 1.3);
      }
    }

    if (gain > 0) {
      this.detect = clamp(this.detect + gain * dt, 0, 1.0001);
      if (this.detect >= 1) {
        game.raiseAlarm(this, p.x, p.y);
      } else if (this.detect > 0.42 && this.state !== GUARD_STATE.ALERT) {
        this.enterSuspect(game, p.x, p.y);
      }
    } else {
      const decay = this.alerted ? 0.22 : 0.45;
      this.detect = Math.max(0, this.detect - decay * dt);
    }

    // Spotting an unconscious colleague is as good as an alarm.
    for (const g of game.guards) {
      if (!g.down || g === this || this.reportedBody.has(g.index)) continue;
      if (dist(this.x, this.y, g.x, g.y) < 190 && hasLOS(this.level, this.x, this.y, g.x, g.y)) {
        this.reportedBody.add(g.index);
        game.onBodyFound(this, g);
      }
    }
  }

  hear(game, x, y, radius, kind) {
    if (this.down) return;
    const d = dist(this.x, this.y, x, y);
    if (d > radius) return;
    // Walls muffle: a noise behind cover needs to be much closer.
    if (!hasLOS(this.level, this.x, this.y, x, y) && d > radius * 0.55) return;
    if (this.state === GUARD_STATE.ALERT) return;
    if (kind === 'step' && this.state === GUARD_STATE.INVESTIGATE) return;
    this.investigate(game, x, y, kind === 'loud');
  }

  // ------------------------------------------------------------ state moves
  enterSuspect(game, x, y) {
    if (this.state === GUARD_STATE.SUSPECT) {
      this.target = { x, y };
      return;
    }
    this.state = GUARD_STATE.SUSPECT;
    this.stateTimer = 0;
    this.target = { x, y };
    this.path = [];
    if (this.speakTimer <= 0) {
      audio.suspicious();
      this.speakTimer = 3;
      game.say(this, '?');
    }
  }

  investigate(game, x, y, loud = false) {
    if (this.down || this.state === GUARD_STATE.ALERT) return;
    this.state = GUARD_STATE.INVESTIGATE;
    this.stateTimer = 0;
    this.target = { x, y };
    this.repath(x, y);
    if (this.speakTimer <= 0) {
      audio.suspicious();
      this.speakTimer = 3;
      game.say(this, loud ? '!?' : '?');
    }
  }

  goAlert(game, x, y) {
    this.state = GUARD_STATE.ALERT;
    this.stateTimer = 0;
    this.lastKnown = { x, y };
    this.repath(x, y);
  }

  repath(x, y) {
    const p = findPath(this.level, this.x, this.y, x, y);
    this.path = p || [];
    this.repathTimer = 0.45 + Math.random() * 0.25;
  }

  nextRoutePoint() {
    if (!this.route.length) return null;
    this.routeIdx = (this.routeIdx + 1) % this.route.length;
    return this.route[this.routeIdx];
  }

  // ------------------------------------------------------------ update
  update(dt, game) {
    if (this.down) {
      this.downFade = Math.min(1, this.downFade + dt * 3);
      return;
    }
    this.speakTimer = Math.max(0, this.speakTimer - dt);
    this.shootTimer = Math.max(0, this.shootTimer - dt);
    this.stateTimer += dt;
    this.repathTimer -= dt;

    this.perceive(dt, game);
    this.openDoorsNearby(game);

    switch (this.state) {
      case GUARD_STATE.PATROL: this.updatePatrol(dt, game); break;
      case GUARD_STATE.LOOK: this.updateLook(dt, game); break;
      case GUARD_STATE.SUSPECT: this.updateSuspect(dt, game); break;
      case GUARD_STATE.INVESTIGATE: this.updateInvestigate(dt, game); break;
      case GUARD_STATE.ALERT: this.updateAlert(dt, game); break;
      case GUARD_STATE.SEARCH: this.updateSearch(dt, game); break;
      default: break;
    }
    this.coneDirty = true;
  }

  updatePatrol(dt, game) {
    if (!this.route.length) return;
    if (!this.path.length) {
      const dest = this.route[this.routeIdx];
      if (dest && dist(this.x, this.y, dest.x, dest.y) > 20) {
        if (this.repathTimer <= 0) this.repath(dest.x, dest.y);
      } else {
        this.state = GUARD_STATE.LOOK;
        this.stateTimer = 0;
        this.lookTimer = 0;
        this.lookTarget = this.angle + rand(1.4, -1.4);
        return;
      }
    }
    this.follow(dt, this.baseSpeed, game);
  }

  updateLook(dt, game) {
    this.angle = turnToward(this.angle, this.lookTarget, dt * 1.6);
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(1.4, 0.6);
      this.lookTarget = this.angle + rand(2.0, -2.0);
    }
    if (this.stateTimer > rand(2.6, 1.6)) {
      const next = this.nextRoutePoint();
      this.state = GUARD_STATE.PATROL;
      this.stateTimer = 0;
      if (next) this.repath(next.x, next.y);
    }
  }

  updateSuspect(dt, game) {
    // Freeze, stare at the disturbance, edge forward.
    if (this.target) {
      const a = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      this.angle = turnToward(this.angle, a, dt * 4);
      if (this.canSeePlayer) {
        this.target = { x: game.player.x, y: game.player.y };
      }
      const d = dist(this.x, this.y, this.target.x, this.target.y);
      if (d > 90) {
        if (this.repathTimer <= 0) this.repath(this.target.x, this.target.y);
        this.follow(dt, this.baseSpeed * 0.55, game);
      }
    }
    if (this.detect < 0.12) {
      this.investigate(game, this.target?.x ?? this.x, this.target?.y ?? this.y);
    }
    if (this.stateTimer > 7) {
      this.state = GUARD_STATE.PATROL;
      this.stateTimer = 0;
    }
  }

  updateInvestigate(dt, game) {
    if (!this.target) {
      this.state = GUARD_STATE.PATROL;
      return;
    }
    const d = dist(this.x, this.y, this.target.x, this.target.y);
    if (d > 26 && this.stateTimer < 16) {
      if (this.repathTimer <= 0 && !this.path.length) this.repath(this.target.x, this.target.y);
      this.follow(dt, this.baseSpeed * 1.25, game);
    } else {
      // Sweep the area, then head back to the beat.
      this.lookTimer -= dt;
      if (this.lookTimer <= 0) {
        this.lookTimer = rand(1.2, 0.5);
        this.lookTarget = this.angle + rand(2.4, -2.4);
      }
      this.angle = turnToward(this.angle, this.lookTarget, dt * 2.2);
      if (this.stateTimer > 6.5) {
        this.state = GUARD_STATE.PATROL;
        this.stateTimer = 0;
        this.path = [];
        const dest = this.route[this.routeIdx];
        if (dest) this.repath(dest.x, dest.y);
      }
    }
  }

  updateAlert(dt, game) {
    const p = game.player;
    if (this.canSeePlayer && p.alive) {
      this.lastKnown = { x: p.x, y: p.y };
      this.stateTimer = 0;
      const a = Math.atan2(p.y - this.y, p.x - this.x);
      this.angle = turnToward(this.angle, a, dt * 6);
      const d = dist(this.x, this.y, p.x, p.y);

      // Shoulder the weapon first — a short reaction window is what makes
      // breaking line of sight a viable escape.
      this.aimTime += dt;
      if (d < 230 && this.shootTimer <= 0 && this.aimTime > 0.45) {
        this.shootTimer = rand(1.8, 1.1);
        game.guardShoot(this, p);
      }
      // Close in, but keep a firing distance.
      if (d > 120) {
        if (this.repathTimer <= 0) this.repath(p.x, p.y);
        this.follow(dt, this.baseSpeed * 1.7, game, false);
      } else {
        this.path = [];
      }
      return;
    }

    this.aimTime = 0;
    if (this.lastKnown) {
      const d = dist(this.x, this.y, this.lastKnown.x, this.lastKnown.y);
      if (d > 24) {
        if (this.repathTimer <= 0 && !this.path.length) this.repath(this.lastKnown.x, this.lastKnown.y);
        this.follow(dt, this.baseSpeed * 1.6, game);
      } else if (this.stateTimer > 1.2) {
        this.state = GUARD_STATE.SEARCH;
        this.stateTimer = 0;
        this.path = [];
      }
    }
    if (this.stateTimer > 9) {
      this.state = GUARD_STATE.SEARCH;
      this.stateTimer = 0;
    }
  }

  updateSearch(dt, game) {
    if (this.canSeePlayer) {
      this.goAlert(game, game.player.x, game.player.y);
      return;
    }
    if (!this.path.length && this.repathTimer <= 0) {
      const base = this.lastKnown || { x: this.x, y: this.y };
      const a = rand(TAU);
      const r = rand(5 * T, 2 * T);
      this.repath(base.x + Math.cos(a) * r, base.y + Math.sin(a) * r);
    }
    this.follow(dt, this.baseSpeed * 1.15, game);
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(1.4, 0.7);
      if (!this.path.length) this.lookTarget = this.angle + rand(2.2, -2.2);
    }
    if (!this.path.length) this.angle = turnToward(this.angle, this.lookTarget, dt * 2);

    if (this.stateTimer > 16) {
      this.state = GUARD_STATE.PATROL;
      this.stateTimer = 0;
      this.lastKnown = null;
      this.path = [];
      game.onGuardCalmed(this);
    }
  }

  /** Walk the current path; `faceMotion` turns the guard toward travel. */
  follow(dt, speed, game, faceMotion = true) {
    if (!this.path.length) return;
    const wp = this.path[0];
    const dx = wp.x - this.x;
    const dy = wp.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) {
      this.path.shift();
      return;
    }
    const ux = dx / d;
    const uy = dy / d;
    const before = { x: this.x, y: this.y };
    moveBody(this.level, this, ux * speed * dt, uy * speed * dt);

    // Wedged against geometry: throw the path away and try again shortly.
    if (Math.abs(this.x - before.x) < 0.01 && Math.abs(this.y - before.y) < 0.01) {
      this.path.shift();
      this.repathTimer = Math.min(this.repathTimer, 0.15);
    }
    if (faceMotion) this.angle = turnToward(this.angle, Math.atan2(uy, ux), dt * 5.5);
  }

  openDoorsNearby(game) {
    const tx = Math.floor(this.x / T);
    const ty = Math.floor(this.y / T);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const door = this.level.doorAt(tx + dx, ty + dy);
        if (door && !door.open && !door.locked && dist(this.x, this.y, door.x, door.y) < 42) {
          game.setDoor(door, true, false);
        }
      }
    }
  }

  /** Vision cone polygon for rendering; recomputed lazily once per frame. */
  getCone() {
    if (this.coneDirty || !this.cone) {
      const fov = this.viewFov;
      this.cone = visibilityPoly(
        this.level, this.x, this.y, this.viewRange, 34, this.angle - fov / 2, fov,
      );
      this.coneDirty = false;
    }
    return this.cone;
  }
}

export default Guard;
