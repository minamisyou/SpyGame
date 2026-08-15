// Mission runtime: entities, player actions, alarm state and scoring.

import Level from './level.js';
import { rebuildLighting, visibilityPoly, hasLOS, bulletTravel } from './raycast.js';
import Player from './player.js';
import Guard, { GUARD_STATE } from './guard.js';
import SecurityCamera from './seccam.js';
import { VIEW_W, VIEW_H } from './render.js';
import input from './input.js';
import audio from './audio.js';
import { clamp, dist, angleDelta, lerp, formatTime } from './util.js';

const HACK_TIME = 2.6;
const INTERACT_RANGE = 40;
const TAKEDOWN_RANGE = 34;

export const MISSION = {
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

export class Game {
  constructor(levelDef, hooks = {}) {
    this.def = levelDef;
    this.hooks = hooks;
    this.level = new Level(levelDef);
    rebuildLighting(this.level);

    this.player = new Player(this.level, levelDef);
    this.guards = (levelDef.guards || []).map((g, i) => new Guard(this.level, g, i));
    this.cams = this.level.cams.map((spot, i) =>
      new SecurityCamera(this.level, spot, (levelDef.cams || [])[i] || {}, i));

    this.cam = { x: 0, y: 0 };
    this.tracers = [];
    this.bottlesInFlight = [];
    this.noiseRings = [];
    this.lastKnownMarker = null;

    this.alarmLevel = 0;
    this.reportedBodies = new Set();
    this.state = MISSION.RUNNING;
    this.time = 0;
    this.usingTouch = false;
    this.hackTarget = null;
    this.hackProgress = 0;
    this.promptText = '';
    this.extracting = 0;

    this.stats = { detections: 0, knockouts: 0, shots: 0, lightsOut: 0, bodiesFound: 0 };

    this.playerPoly = visibilityPoly(this.level, this.player.x, this.player.y, this.sightRadius, 200);
    this.snapCamera();
  }

  // ------------------------------------------------------------- helpers
  get sightRadius() {
    return this.player.nvOn ? 560 : 430;
  }

  get objectivesDone() {
    return this.level.terminals.every((t) => t.hacked);
  }

  get hackedCount() {
    return this.level.terminals.filter((t) => t.hacked).length;
  }

  screenToWorld(sx, sy) {
    return { x: sx + this.cam.x, y: sy + this.cam.y };
  }

  canPlayerSee(x, y) {
    const p = this.player;
    return dist(p.x, p.y, x, y) < this.sightRadius && hasLOS(this.level, p.x, p.y, x, y);
  }

  say(guard, text) {
    guard.bubble = { text, t: 1 };
  }

  toast(msg) {
    this.hooks.onToast?.(msg);
  }

  /**
   * Desired camera position. A margin of overscan past the map edge keeps the
   * operative out of the screen corners (and out from under the HUD panels)
   * when they hug an outer wall.
   */
  cameraTarget() {
    const l = this.level;
    const M = 150;
    const x = l.pxW < VIEW_W
      ? (l.pxW - VIEW_W) / 2
      : clamp(this.player.x - VIEW_W / 2, -M, l.pxW - VIEW_W + M);
    const y = l.pxH < VIEW_H
      ? (l.pxH - VIEW_H) / 2
      : clamp(this.player.y - VIEW_H / 2, -M, l.pxH - VIEW_H + M);
    return { x, y };
  }

  snapCamera() {
    const t = this.cameraTarget();
    this.cam.x = t.x;
    this.cam.y = t.y;
  }

  // ------------------------------------------------------------- update
  update(dt) {
    if (this.state !== MISSION.RUNNING) return;
    this.time += dt;

    this.player.update(dt, this);
    this.handleActions(dt);

    for (const g of this.guards) {
      g.update(dt, this);
      if (g.bubble) g.bubble.t = Math.max(0, g.bubble.t - dt * 0.6);
    }
    for (const c of this.cams) c.update(dt, this);

    this.updateDoors(dt);
    this.updateProjectiles(dt);
    this.updatePickups();

    if (this.lastKnownMarker) {
      this.lastKnownMarker.life -= dt;
      if (this.lastKnownMarker.life <= 0) this.lastKnownMarker = null;
    }

    for (let i = this.noiseRings.length - 1; i >= 0; i--) {
      const n = this.noiseRings[i];
      n.life -= dt;
      if (n.life <= 0) this.noiseRings.splice(i, 1);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) this.tracers.splice(i, 1);
    }

    if (this.level.lightDirty) rebuildLighting(this.level);

    // Visibility polygon for the fog pass.
    this.playerPoly = visibilityPoly(this.level, this.player.x, this.player.y, this.sightRadius, 200);

    // Smooth camera follow.
    const t = this.cameraTarget();
    const k = 1 - Math.pow(0.0015, dt);
    this.cam.x = lerp(this.cam.x, t.x, k);
    this.cam.y = lerp(this.cam.y, t.y, k);

    this.checkMissionState(dt);
  }

  checkMissionState(dt) {
    if (!this.player.alive) return this.fail('OPERATIVE DOWN');
    if (this.alarmLevel >= 3) return this.fail('침투 노출 · COMPROMISED');

    const e = this.level.extraction;
    if (this.objectivesDone && dist(this.player.x, this.player.y, e.x, e.y) < 26) {
      this.extracting += dt;
      if (this.extracting > 0.6) this.complete();
    } else {
      this.extracting = 0;
    }
  }

  // ------------------------------------------------------------- actions
  handleActions(dt) {
    const p = this.player;
    const interactHeld = input.isDown('KeyE') || input.touchDown('interact');
    const interactPressed = input.wasPressed('KeyE') || input.touchPressed('interact');
    const firePressed = input.mouse.clicked || input.touchPressed('fire');

    // --- what are we standing next to? ---
    let prompt = '';
    const near = this.findInteractable();

    if (near) {
      if (near.kind === 'terminal') prompt = near.obj.hacked ? '' : '<b>E</b> 홀드 · 데이터 다운로드';
      else if (near.kind === 'door') {
        prompt = near.obj.locked && !p.keycard
          ? '잠김 · 키카드 필요'
          : `<b>E</b> · 문 ${near.obj.open ? '닫기' : '열기'}`;
      } else if (near.kind === 'takedown') prompt = '<b>E</b> · 제압 (비살상)';
    }
    if (this.objectivesDone && dist(p.x, p.y, this.level.extraction.x, this.level.extraction.y) < 90) {
      prompt = '탈출 지점 · EXFIL';
    }
    this.promptText = prompt;

    // --- hacking (hold) ---
    if (near && near.kind === 'terminal' && !near.obj.hacked && interactHeld) {
      this.hackTarget = near.obj;
      this.hackProgress += dt / HACK_TIME;
      near.obj.progress = clamp(this.hackProgress, 0, 1);
      if (Math.random() < dt * 6) audio.beep();
      if (this.hackProgress >= 1) {
        near.obj.hacked = true;
        near.obj.progress = 1;
        this.hackTarget = null;
        this.hackProgress = 0;
        audio.hackDone();
        const left = this.level.terminals.length - this.hackedCount;
        this.toast(left > 0 ? `데이터 확보 · 남은 목표 ${left}` : '모든 데이터 확보 · 탈출 지점으로');
        this.emitNoise(near.obj.x, near.obj.y, 90, 'step');
      }
    } else if (this.hackTarget) {
      this.hackTarget.progress = 0;
      this.hackTarget = null;
      this.hackProgress = 0;
    }

    // --- single-press interactions ---
    if (interactPressed && near) {
      if (near.kind === 'door') this.tryDoor(near.obj);
      else if (near.kind === 'takedown') this.doTakedown(near.obj);
    }

    // --- weapons ---
    if (firePressed && p.fireCooldown <= 0) {
      if (p.ammo > 0) {
        p.ammo--;
        p.fireCooldown = 0.5;
        this.stats.shots++;
        this.fireDart();
      } else {
        audio.beep(true);
        this.toast('마취탄 소진');
      }
    }
    if ((input.wasPressed('KeyF') || input.touchPressed('bottle')) && p.throwCooldown <= 0) {
      if (p.bottles > 0) {
        p.bottles--;
        p.throwCooldown = 0.6;
        this.throwBottle();
      } else {
        audio.beep(true);
      }
    }
  }

  findInteractable() {
    const p = this.player;
    let best = null;
    let bestD = Infinity;

    for (const t of this.level.terminals) {
      const d = dist(p.x, p.y, t.x, t.y);
      if (d < INTERACT_RANGE && d < bestD && !t.hacked) {
        best = { kind: 'terminal', obj: t };
        bestD = d;
      }
    }
    for (const d0 of this.level.doors) {
      const d = dist(p.x, p.y, d0.x, d0.y);
      if (d < INTERACT_RANGE && d < bestD) {
        best = { kind: 'door', obj: d0 };
        bestD = d;
      }
    }
    for (const g of this.guards) {
      if (g.down) continue;
      const d = dist(p.x, p.y, g.x, g.y);
      if (d > TAKEDOWN_RANGE) continue;
      const facing = Math.abs(angleDelta(g.angle, Math.atan2(p.y - g.y, p.x - g.x)));
      const fromBehind = facing > 1.75;               // ~100°
      const unaware = g.detect < 0.55 && g.state !== GUARD_STATE.ALERT;
      if ((fromBehind || unaware) && d < bestD) {
        best = { kind: 'takedown', obj: g };
        bestD = d;
      }
    }
    return best;
  }

  tryDoor(door) {
    if (door.locked && !this.player.keycard) {
      audio.beep(true);
      this.toast('키카드가 필요하다');
      return;
    }
    if (door.locked && this.player.keycard) {
      door.locked = false;
      this.toast('키카드 인증 · 잠금 해제');
      audio.hackDone();
    }
    this.setDoor(door, !door.open, true);
  }

  setDoor(door, open, byPlayer) {
    if (door.open === open) {
      if (open) door.holdTimer = 5;
      return;
    }
    door.open = open;
    door.holdTimer = open ? 5 : 0;
    audio.door();
    this.level.markLightsDirty();
    if (byPlayer && open) this.emitNoise(door.x, door.y, 110, 'step');
  }

  updateDoors(dt) {
    for (const d of this.level.doors) {
      const target = d.open ? 1 : 0;
      const speed = dt * 4;
      d.openAmt = d.openAmt < target
        ? Math.min(target, d.openAmt + speed)
        : Math.max(target, d.openAmt - speed);

      if (d.open) {
        d.holdTimer = (d.holdTimer ?? 5) - dt;
        if (d.holdTimer <= 0) {
          // Do not shut a door on somebody's head.
          const blocked = [this.player, ...this.guards].some(
            (b) => (b === this.player ? b.alive : !b.down) && dist(b.x, b.y, d.x, d.y) < 30,
          );
          if (!blocked) this.setDoor(d, false, false);
          else d.holdTimer = 1;
        }
      }
    }
  }

  doTakedown(guard) {
    const p = this.player;
    p.x = lerp(p.x, guard.x, 0.35);
    p.y = lerp(p.y, guard.y, 0.35);
    guard.knockOut(this);
    this.toast('무력화 · 비살상');
    this.emitNoise(guard.x, guard.y, 90, 'step');
  }

  fireDart() {
    const p = this.player;
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);
    const maxDist = 520;
    let hitDist = bulletTravel(this.level, p.x, p.y, dx, dy, maxDist);
    let hitObj = null;
    let hitKind = null;

    const test = (obj, radius, kind) => {
      const ox = obj.x - p.x;
      const oy = obj.y - p.y;
      const along = ox * dx + oy * dy;
      if (along < 6 || along > hitDist) return;
      const perp = Math.abs(ox * -dy + oy * dx);
      if (perp > radius) return;
      hitDist = along;
      hitObj = obj;
      hitKind = kind;
    };

    for (const g of this.guards) if (!g.down) test(g, 12, 'guard');
    for (const c of this.cams) if (c.alive) test(c, 10, 'cam');
    for (const li of this.level.lights) if (li.alive) test(li, 9, 'light');

    this.tracers.push({
      x0: p.x + dx * 10, y0: p.y + dy * 10,
      x1: p.x + dx * hitDist, y1: p.y + dy * hitDist,
      life: 0.09, maxLife: 0.09, hostile: false,
    });
    audio.dart();
    this.emitNoise(p.x, p.y, 70, 'step');

    if (hitKind === 'guard') {
      hitObj.knockOut(this);
      this.toast('마취탄 명중');
    } else if (hitKind === 'cam') {
      hitObj.destroy();
      audio.glass();
      this.toast('카메라 무력화');
      this.emitNoise(hitObj.x, hitObj.y, 150, 'loud');
    } else if (hitKind === 'light') {
      hitObj.alive = false;
      this.stats.lightsOut++;
      this.level.markLightsDirty();
      audio.glass();
      this.emitNoise(hitObj.x, hitObj.y, 260, 'loud');
      this.toast('조명 파괴 · 어둠 확보');
    }
  }

  throwBottle() {
    const p = this.player;
    const aim = this.usingTouch
      ? { x: p.x + Math.cos(p.angle) * 260, y: p.y + Math.sin(p.angle) * 260 }
      : this.screenToWorld(input.mouse.x, input.mouse.y);
    const dx = aim.x - p.x;
    const dy = aim.y - p.y;
    const d = clamp(Math.hypot(dx, dy), 60, 420);
    const a = Math.atan2(dy, dx);
    this.bottlesInFlight.push({
      x: p.x, y: p.y,
      vx: Math.cos(a), vy: Math.sin(a),
      travelled: 0, total: d, h: 0, spin: 0, speed: 320,
    });
    audio.step(false, false);
  }

  updateProjectiles(dt) {
    for (let i = this.bottlesInFlight.length - 1; i >= 0; i--) {
      const b = this.bottlesInFlight[i];
      const step = b.speed * dt;
      const nx = b.x + b.vx * step;
      const ny = b.y + b.vy * step;
      b.travelled += step;
      b.spin += dt * 14;
      const tprog = b.travelled / b.total;
      b.h = Math.sin(clamp(tprog, 0, 1) * Math.PI) * 26;

      const hitWall = this.level.blocksMoveAtPx(nx, ny);
      if (!hitWall) {
        b.x = nx;
        b.y = ny;
      }
      if (hitWall || b.travelled >= b.total) {
        this.bottlesInFlight.splice(i, 1);
        audio.bottle();
        this.emitNoise(b.x, b.y, 300, 'loud');
      }
    }
  }

  updatePickups() {
    const p = this.player;
    for (const item of this.level.pickups) {
      if (item.taken) continue;
      if (dist(p.x, p.y, item.x, item.y) > 20) continue;
      item.taken = true;
      audio.pickup();
      if (item.kind === 'ammo') {
        p.ammo += 3;
        this.toast('마취탄 +3');
      } else if (item.kind === 'bottle') {
        p.bottles += 2;
        this.toast('소음 유발용 병 +2');
      } else {
        p.keycard = true;
        this.toast('키카드 확보');
      }
    }
  }

  // ------------------------------------------------------------- events
  emitNoise(x, y, radius, kind = 'step') {
    if (radius <= 0) return;
    this.noiseRings.push({ x, y, radius, life: 0.7, maxLife: 0.7 });
    for (const g of this.guards) g.hear(this, x, y, radius, kind);
  }

  /** True while anybody is actively hunting the player. */
  get hunted() {
    return this.guards.some((g) => !g.down && g.alerted);
  }

  /**
   * One "detection" is one transition from unnoticed to hunted — not one per
   * guard and not one per second, so the HUD counter matches what the player
   * actually experienced.
   */
  escalate(sourceGuard, x, y) {
    this.lastKnownMarker = { x, y, life: 4 };
    this.alarmLevel = Math.min(3, this.alarmLevel + 1);
    this.stats.detections++;
    audio.alert();
    audio.alarm();
    if (sourceGuard) this.say(sourceGuard, '!');
    this.hooks.onDetected?.(this.alarmLevel);
    this.toast(this.alarmLevel >= 3 ? '경보 최대 · 임무 실패' : `발각 · 경보 ${this.alarmLevel}/3`);
  }

  raiseAlarm(guard, x, y) {
    if (guard.state === GUARD_STATE.ALERT) {
      guard.lastKnown = { x, y };
      guard.detect = 1;
      return;
    }
    const alreadyHunted = this.hunted;
    guard.goAlert(this, x, y);
    guard.detect = 1;

    // Radio: everyone in earshot converges.
    for (const other of this.guards) {
      if (other === guard || other.down) continue;
      if (dist(other.x, other.y, guard.x, guard.y) < 520) other.goAlert(this, x, y);
    }

    if (!alreadyHunted) this.escalate(guard, x, y);
    else this.lastKnownMarker = { x, y, life: 4 };
  }

  cameraSpotted(cam) {
    const p = this.player;
    const alreadyHunted = this.hunted;
    this.toast('카메라에 포착됨');
    for (const g of this.guards) {
      if (!g.down && dist(g.x, g.y, p.x, p.y) < 900) g.goAlert(this, p.x, p.y);
    }
    if (!alreadyHunted) this.escalate(null, p.x, p.y);
    else this.lastKnownMarker = { x: p.x, y: p.y, life: 4 };
  }

  onGuardDown(guard) {
    this.stats.knockouts++;
  }

  onBodyFound(finder, body) {
    this.say(finder, '!');
    finder.investigate(this, body.x, body.y, true);
    for (const g of this.guards) {
      if (!g.down && g !== finder && dist(g.x, g.y, body.x, body.y) < 420) {
        g.investigate(this, body.x, body.y, true);
      }
    }
    // One body raises the alarm once, however many guards trip over it —
    // there is no way to hide a body, so stacking the cost would be unfair.
    if (this.reportedBodies.has(body.index)) return;
    this.reportedBodies.add(body.index);
    this.stats.bodiesFound++;
    this.alarmLevel = Math.min(3, this.alarmLevel + 1);
    audio.alarm();
    this.toast(`동료 발견됨 · 경보 ${this.alarmLevel}/3`);
    this.hooks.onDetected?.(this.alarmLevel);
  }

  onGuardCalmed(guard) {
    const anyAlert = this.guards.some((g) => !g.down && g.alerted);
    if (!anyAlert) this.toast('경계 해제 · 다시 어둠 속으로');
  }

  guardShoot(guard, target) {
    const d = dist(guard.x, guard.y, target.x, target.y);
    const a = Math.atan2(target.y - guard.y, target.x - guard.x);
    const spread = (Math.random() - 0.5) * 0.14;
    const dx = Math.cos(a + spread);
    const dy = Math.sin(a + spread);
    const travel = bulletTravel(this.level, guard.x, guard.y, dx, dy, d + 40);
    this.tracers.push({
      x0: guard.x + dx * 12, y0: guard.y + dy * 12,
      x1: guard.x + dx * travel, y1: guard.y + dy * travel,
      life: 0.1, maxLife: 0.1, hostile: true,
    });
    audio.gunshot();
    this.emitNoise(guard.x, guard.y, 340, 'loud');

    if (travel >= d - 12) {
      let chance = 0.34 + 0.28 * (1 - clamp(d / 240, 0, 1));
      if (this.player.stance === 'crouch') chance -= 0.12;
      if (this.player.moving) chance -= 0.1;
      if (Math.random() < chance) this.player.damage(9);
    }
  }

  // ------------------------------------------------------------- outcome
  complete() {
    if (this.state !== MISSION.RUNNING) return;
    this.state = MISSION.COMPLETE;
    audio.win();
    this.hooks.onEnd?.(this.result());
  }

  fail(reason) {
    if (this.state !== MISSION.RUNNING) return;
    this.state = MISSION.FAILED;
    audio.lose();
    this.hooks.onEnd?.(this.result(reason));
  }

  result(failReason = null) {
    const s = this.stats;
    const timePenalty = Math.min(280, Math.max(0, this.time - 150) * 2);
    let score = 1000
      - s.detections * 180
      - s.knockouts * 35
      - s.bodiesFound * 40
      - Math.round(timePenalty);
    const ghost = s.detections === 0 && s.knockouts === 0;
    if (ghost) score += 200;
    score = Math.max(0, score);

    const rank = failReason ? 'F'
      : score >= 1050 ? 'S'
      : score >= 880 ? 'A'
      : score >= 700 ? 'B'
      : score >= 520 ? 'C' : 'D';

    return {
      success: !failReason,
      failReason,
      score,
      rank,
      ghost,
      time: this.time,
      timeText: formatTime(this.time),
      detections: s.detections,
      bodiesFound: s.bodiesFound,
      knockouts: s.knockouts,
      lightsOut: s.lightsOut,
      terminals: `${this.hackedCount}/${this.level.terminals.length}`,
    };
  }
}

export default Game;
