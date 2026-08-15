// All drawing. The frame is built in layers:
//   world art → entities → light (multiply) → vision cones → fog of war →
//   night-vision grade → above-fog markers.

import { T, WALL, GLASS } from './level.js';
import { tracePoly } from './raycast.js';
import { clamp, TAU } from './util.js';
import { GUARD_STATE } from './guard.js';

const VIEW_W = 960;
const VIEW_H = 544;

/** Cheap deterministic hash for tile-to-tile texture variation. */
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.light = makeCanvas(VIEW_W, VIEW_H);
    this.lightCtx = this.light.getContext('2d');
    this.fog = makeCanvas(VIEW_W, VIEW_H);
    this.fogCtx = this.fog.getContext('2d');
    this.static = null;
    this.minimap = null;
    this.minimapScale = 1;
    this.time = 0;
  }

  // ------------------------------------------------------------- prebake
  buildStatic(level) {
    const c = makeCanvas(level.pxW, level.pxH);
    const g = c.getContext('2d');

    g.fillStyle = '#0a0e15';
    g.fillRect(0, 0, level.pxW, level.pxH);

    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = 0; tx < level.w; tx++) {
        const t = level.tileAt(tx, ty);
        const x = tx * T;
        const y = ty * T;
        const n = hash(tx, ty);

        if (t === WALL) continue;

        // Floor
        const shade = 58 + n * 16;
        g.fillStyle = `rgb(${(shade * 0.78) | 0}, ${(shade * 0.92) | 0}, ${(shade * 1.15) | 0})`;
        g.fillRect(x, y, T, T);
        g.strokeStyle = 'rgba(140, 190, 220, 0.07)';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
        if (n > 0.93) {
          g.fillStyle = 'rgba(150, 200, 230, 0.05)';
          g.fillRect(x + 4, y + 4, T - 8, T - 8);
        }

        if (t === GLASS) {
          g.fillStyle = 'rgba(120, 210, 235, 0.16)';
          g.fillRect(x, y, T, T);
          g.strokeStyle = 'rgba(160, 230, 255, 0.5)';
          g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
          g.beginPath();
          g.moveTo(x, y + T);
          g.lineTo(x + T, y);
          g.strokeStyle = 'rgba(200, 245, 255, 0.22)';
          g.stroke();
        }
      }
    }

    // Walls on top so their shadow skirt overlaps the floor.
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = 0; tx < level.w; tx++) {
        if (level.tileAt(tx, ty) !== WALL) continue;
        const x = tx * T;
        const y = ty * T;
        const n = hash(tx, ty);
        const openBelow = level.tileAt(tx, ty + 1) !== WALL;

        if (openBelow) {
          g.fillStyle = 'rgba(0,0,0,0.55)';
          g.fillRect(x, y + T, T, 9);
        }
        g.fillStyle = `rgb(${(92 + n * 16) | 0}, ${(104 + n * 16) | 0}, ${(128 + n * 18) | 0})`;
        g.fillRect(x, y, T, T);
        // Lit top lip
        if (level.tileAt(tx, ty - 1) !== WALL) {
          g.fillStyle = 'rgba(210, 235, 255, 0.16)';
          g.fillRect(x, y, T, 4);
        }
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
      }
    }

    this.static = c;
    this.buildMinimap(level);
  }

  buildMinimap(level) {
    const mmW = 180;
    const mmH = 130;
    const s = Math.min(mmW / level.pxW, mmH / level.pxH);
    const c = makeCanvas(mmW, mmH);
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(4,10,12,0.9)';
    g.fillRect(0, 0, mmW, mmH);
    const ox = (mmW - level.pxW * s) / 2;
    const oy = (mmH - level.pxH * s) / 2;
    g.save();
    g.translate(ox, oy);
    g.scale(s, s);
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = 0; tx < level.w; tx++) {
        const t = level.tileAt(tx, ty);
        if (t === WALL) g.fillStyle = 'rgba(90,120,150,0.55)';
        else if (t === GLASS) g.fillStyle = 'rgba(120,210,235,0.4)';
        else g.fillStyle = 'rgba(30,48,60,0.5)';
        g.fillRect(tx * T, ty * T, T, T);
      }
    }
    g.restore();
    this.minimap = c;
    this.minimapScale = s;
    this.minimapOffset = { x: ox, y: oy };
  }

  // ------------------------------------------------------------- frame
  draw(game, dt) {
    this.time += dt;
    const ctx = this.ctx;
    const { cam, level, player } = game;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

    // 1. baked world
    ctx.drawImage(this.static, 0, 0);

    // 2. dynamic world objects
    this.drawDoors(ctx, level);
    this.drawExtraction(ctx, game);
    this.drawTerminals(ctx, level);
    this.drawPickups(ctx, level);
    this.drawProjectiles(ctx, game);
    this.drawBodies(ctx, game);
    this.drawGuards(ctx, game);
    this.drawCameras(ctx, game);

    ctx.restore();

    // 3. lighting
    this.drawLighting(game);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.light, 0, 0);
    ctx.restore();

    // 4. the operative sits above the light pass — you always see yourself,
    //    the LIGHT meter is what tells you whether anyone else does.
    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    this.drawPlayer(ctx, game, player);
    this.drawCones(ctx, game);
    ctx.restore();

    // 5. fog of war
    this.drawFog(game);
    ctx.drawImage(this.fog, 0, 0);

    // 6. grade + overlays
    if (player.nvOn) this.drawNightVision(ctx);
    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    this.drawAboveFog(ctx, game);
    ctx.restore();
    this.drawVignette(ctx, game);
    this.drawMinimap(game);
  }

  // ------------------------------------------------------------- objects
  drawDoors(ctx, level) {
    for (const d of level.doors) {
      const x = d.tx * T;
      const y = d.ty * T;
      const slide = d.openAmt * (T - 6);
      ctx.save();
      ctx.translate(x, y);
      // frame
      ctx.fillStyle = 'rgba(10,14,20,0.9)';
      ctx.fillRect(0, 0, T, T);
      ctx.fillStyle = d.locked ? '#7a4a2a' : '#3d5566';
      ctx.strokeStyle = d.locked ? 'rgba(255,180,90,0.55)' : 'rgba(150,220,255,0.35)';
      ctx.lineWidth = 1;
      if (d.horizontal) {
        ctx.fillRect(2 + slide / 2, 6, (T - 4) - slide, T - 12);
        ctx.strokeRect(2.5 + slide / 2, 6.5, (T - 4) - slide - 1, T - 13);
      } else {
        ctx.fillRect(6, 2 + slide / 2, T - 12, (T - 4) - slide);
        ctx.strokeRect(6.5, 2.5 + slide / 2, T - 13, (T - 4) - slide - 1);
      }
      if (d.locked) {
        ctx.fillStyle = '#ffb45a';
        ctx.beginPath();
        ctx.arc(T / 2, T / 2, 2.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawTerminals(ctx, level) {
    for (const t of level.terminals) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.fillStyle = '#1b2634';
      ctx.fillRect(-10, -8, 20, 16);
      ctx.strokeStyle = t.hacked ? 'rgba(89,255,158,0.8)' : 'rgba(120,200,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-10.5, -8.5, 21, 17);
      const blink = t.hacked ? 1 : 0.45 + 0.55 * Math.sin(this.time * 4 + t.x);
      ctx.fillStyle = t.hacked ? `rgba(89,255,158,${blink})` : `rgba(120,200,255,${blink})`;
      ctx.fillRect(-7, -5, 14, 10);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = -4; i < 5; i += 3) ctx.fillRect(-7, i, 14, 1);
      if (t.progress > 0 && !t.hacked) {
        ctx.strokeStyle = '#59ff9e';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, 17, -Math.PI / 2, -Math.PI / 2 + TAU * t.progress);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawPickups(ctx, level) {
    for (const p of level.pickups) {
      if (p.taken) continue;
      const bob = Math.sin(this.time * 2.5 + p.x) * 1.6;
      ctx.save();
      ctx.translate(p.x, p.y + bob);
      const color = p.kind === 'ammo' ? '#9fd7ff' : p.kind === 'bottle' ? '#c9ffe1' : '#ffc14d';
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      if (p.kind === 'ammo') {
        ctx.fillRect(-5, -3, 10, 6);
      } else if (p.kind === 'bottle') {
        ctx.beginPath();
        ctx.ellipse(0, 1, 3.6, 5.4, 0, 0, TAU);
        ctx.fill();
        ctx.fillRect(-1.4, -7, 2.8, 4);
      } else {
        ctx.fillRect(-6, -4, 12, 8);
        ctx.fillStyle = '#3a2a10';
        ctx.fillRect(-4, -2, 5, 4);
      }
      ctx.restore();
    }
  }

  drawExtraction(ctx, game) {
    const e = game.level.extraction;
    const active = game.objectivesDone;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (active ? 3.5 : 1.4));
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.strokeStyle = active ? `rgba(89,255,158,${0.45 + 0.5 * pulse})` : 'rgba(120,140,160,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, 8 + i * 7 + pulse * 4, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = active ? 'rgba(89,255,158,0.85)' : 'rgba(120,140,160,0.4)';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', 0, 3.5);
    ctx.restore();
  }

  drawProjectiles(ctx, game) {
    for (const b of game.bottlesInFlight) {
      const scale = 1 + b.h * 0.02;
      ctx.save();
      ctx.translate(b.x, b.y - b.h);
      ctx.rotate(b.spin);
      ctx.fillStyle = '#c9ffe1';
      ctx.shadowColor = '#c9ffe1';
      ctx.shadowBlur = 6;
      ctx.fillRect(-2 * scale, -5 * scale, 4 * scale, 10 * scale);
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, 4, 2, 0, 0, TAU);
      ctx.fill();
    }
    for (const t of game.tracers) {
      const a = t.life / t.maxLife;
      ctx.strokeStyle = t.hostile ? `rgba(255,120,90,${a})` : `rgba(180,240,255,${a})`;
      ctx.lineWidth = t.hostile ? 2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x1, t.y1);
      ctx.stroke();
    }
  }

  drawBodies(ctx, game) {
    for (const g of game.guards) {
      if (!g.down) continue;
      const a = 0.35 + 0.35 * g.downFade;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.fillStyle = `rgba(70,80,95,${a + 0.35})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, 13, 8, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,26,34,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,190,255,0.35)';
      ctx.beginPath();
      ctx.arc(7, 0, 4, 0, TAU);
      ctx.fill();
      ctx.restore();
      // Z's — reads as "asleep", not dead.
      ctx.fillStyle = `rgba(150,200,220,${0.25 + 0.2 * Math.sin(this.time * 2 + g.index)})`;
      ctx.font = '9px monospace';
      ctx.fillText('z', g.x + 10, g.y - 10 - ((this.time * 8 + g.index * 3) % 6));
    }
  }

  drawGuards(ctx, game) {
    for (const g of game.guards) {
      if (g.down) continue;
      const alert = g.state === GUARD_STATE.ALERT;
      const search = g.state === GUARD_STATE.SEARCH;
      const susp = g.state === GUARD_STATE.SUSPECT || g.state === GUARD_STATE.INVESTIGATE;
      const body = alert ? '#c8465a' : search ? '#c07a3a' : susp ? '#c0a13a' : '#4d6a7d';
      const trim = alert ? '#ff8a9a' : susp || search ? '#ffd98a' : '#9fc4d8';

      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      // torso
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,12,18,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // shoulders
      ctx.fillStyle = trim;
      ctx.fillRect(-2, -9, 5, 3);
      ctx.fillRect(-2, 6, 5, 3);
      // weapon
      ctx.fillStyle = '#20262e';
      ctx.fillRect(6, -1.6, 12, 3.2);
      // head
      ctx.fillStyle = trim;
      ctx.beginPath();
      ctx.arc(2, 0, 4.4, 0, TAU);
      ctx.fill();
      ctx.restore();

      this.drawDetectMeter(ctx, g);
      if (g.bubble && g.bubble.t > 0) {
        ctx.save();
        ctx.font = 'bold 15px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = alert ? '#ff6a7a' : '#ffd24d';
        ctx.fillText(g.bubble.text, g.x, g.y - 20 - (1 - g.bubble.t) * 6);
        ctx.restore();
      }
    }
  }

  drawDetectMeter(ctx, g) {
    if (g.detect <= 0.02) return;
    const r = 16;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI * 0.75, -Math.PI * 0.25);
    ctx.stroke();
    const c = g.detect > 0.75 ? '#ff5468' : g.detect > 0.4 ? '#ffb14d' : '#ffe98a';
    ctx.strokeStyle = c;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI * 0.75, -Math.PI * 0.75 + Math.PI * 0.5 * clamp(g.detect, 0, 1));
    ctx.stroke();
    ctx.restore();
  }

  drawCameras(ctx, game) {
    for (const c of game.cams) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.fillStyle = 'rgba(12,18,26,0.95)';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = c.alive ? 'rgba(160,200,230,0.7)' : 'rgba(90,100,110,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.rotate(c.angle);
      ctx.fillStyle = c.alive ? '#28323f' : '#1a1f26';
      ctx.fillRect(0, -4, 13, 8);
      ctx.beginPath();
      ctx.arc(13, 0, 3.4, 0, TAU);
      ctx.fillStyle = c.alive
        ? (c.detect > 0.05 ? '#ff5468' : '#59ff9e')
        : '#40484f';
      ctx.fill();
      ctx.restore();
      if (!c.alive && c.sparks > 0 && Math.random() < 0.25) {
        ctx.fillStyle = `rgba(255,220,150,${c.sparks})`;
        ctx.fillRect(c.x + (Math.random() - 0.5) * 14, c.y + (Math.random() - 0.5) * 14, 2, 2);
      }
    }
  }

  drawPlayer(ctx, game, p) {
    if (!p.alive) return;
    const crouch = p.stance === 'crouch';
    const scale = crouch ? 0.82 : 1;

    // Soft ground ring so the operative never gets lost in a black room.
    const ringA = 0.16 + 0.08 * Math.sin(this.time * 2.2);
    ctx.strokeStyle = `rgba(120,220,190,${ringA})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15, 0, TAU);
    ctx.stroke();

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.scale(scale, scale);

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(-1, 2, 11, 10, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#1d2a33';
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,200,220,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // pistol
    ctx.fillStyle = '#0e1318';
    ctx.fillRect(5, -1.4, 13, 2.8);

    // goggles
    const glow = p.nvOn ? 1 : 0.5;
    ctx.fillStyle = `rgba(89,255,158,${glow})`;
    if (p.nvOn) {
      ctx.shadowColor = '#59ff9e';
      ctx.shadowBlur = 12;
    }
    ctx.beginPath();
    ctx.arc(4.5, -3, 2.3, 0, TAU);
    ctx.arc(4.5, 3, 2.3, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (p.hurtFlash > 0) {
      ctx.strokeStyle = `rgba(255,84,104,${p.hurtFlash})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14 + (1 - p.hurtFlash) * 10, 0, TAU);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------- lighting
  drawLighting(game) {
    const g = this.lightCtx;
    const { cam, level, player } = game;
    // Gameplay ambient is deliberately low (that is what keeps you hidden);
    // the *visual* floor is lifted so unlit rooms stay readable.
    const amb = player.nvOn
      ? Math.max(0.62, level.ambient + 0.45)
      : Math.max(0.30, level.ambient + 0.15);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const base = Math.round(amb * 255);
    g.fillStyle = `rgb(${Math.round(base * 0.8)},${Math.round(base * 0.92)},${Math.round(base * 1.15)})`;
    g.fillRect(0, 0, VIEW_W, VIEW_H);

    g.save();
    g.translate(-Math.round(cam.x), -Math.round(cam.y));
    g.globalCompositeOperation = 'lighter';

    for (const light of level.lights) {
      if (!light.alive || !light.poly) continue;
      if (light.x + light.radius < cam.x || light.x - light.radius > cam.x + VIEW_W) continue;
      if (light.y + light.radius < cam.y || light.y - light.radius > cam.y + VIEW_H) continue;

      const flick = 0.93 + 0.07 * Math.sin(this.time * 7 + light.flicker * 5);
      const r = light.radius;
      const grad = g.createRadialGradient(light.x, light.y, 4, light.x, light.y, r);
      const i = light.power * flick;
      grad.addColorStop(0, `rgba(255,246,214,${0.95 * i})`);
      grad.addColorStop(0.42, `rgba(255,232,180,${0.42 * i})`);
      grad.addColorStop(1, 'rgba(255,220,160,0)');
      g.save();
      tracePoly(g, light.x, light.y, light.poly, r);
      g.clip();
      g.fillStyle = grad;
      g.fillRect(light.x - r, light.y - r, r * 2, r * 2);
      g.restore();

      // bulb
      g.fillStyle = `rgba(255,250,225,${0.5 * flick})`;
      g.beginPath();
      g.arc(light.x, light.y, 5, 0, TAU);
      g.fill();
    }

    // Dark-adapted eyes: a whisper of light around the operative.
    const pr = player.nvOn ? 190 : 132;
    const pg = g.createRadialGradient(player.x, player.y, 2, player.x, player.y, pr);
    pg.addColorStop(0, 'rgba(130,180,205,0.42)');
    pg.addColorStop(1, 'rgba(130,180,205,0)');
    g.fillStyle = pg;
    g.fillRect(player.x - pr, player.y - pr, pr * 2, pr * 2);

    g.restore();
  }

  drawCones(ctx, game) {
    for (const g of game.guards) {
      if (g.down) continue;
      const alert = g.state === GUARD_STATE.ALERT;
      const susp = g.detect > 0.25 || g.state === GUARD_STATE.SUSPECT;
      const color = alert ? [255, 70, 90] : susp ? [255, 190, 70] : [150, 220, 255];
      this.paintCone(ctx, g.x, g.y, g.getCone(), g.viewRange, g.angle - g.viewFov / 2, g.viewFov, color, alert ? 0.3 : 0.17);
    }
    for (const c of game.cams) {
      if (!c.alive) continue;
      const hot = c.detect > 0.05;
      this.paintCone(ctx, c.x, c.y, c.getCone(), c.range, c.angle - c.fov / 2, c.fov,
        hot ? [255, 90, 110] : [140, 255, 210], hot ? 0.28 : 0.14);
    }
  }

  paintCone(ctx, x, y, radii, range, start, spread, rgb, alpha) {
    const [r, gg, b] = rgb;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    tracePoly(ctx, x, y, radii, range, start, spread, true);
    ctx.clip();
    const grad = ctx.createRadialGradient(x, y, 6, x, y, range);
    grad.addColorStop(0, `rgba(${r},${gg},${b},${alpha})`);
    grad.addColorStop(0.6, `rgba(${r},${gg},${b},${alpha * 0.55})`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - range, y - range, range * 2, range * 2);
    ctx.restore();
  }

  // ------------------------------------------------------------- fog
  drawFog(game) {
    const g = this.fogCtx;
    const { cam, player } = game;
    const radius = game.sightRadius;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, VIEW_W, VIEW_H);
    // Not quite opaque: the layout stays faintly readable outside your sight,
    // like a memorised floor plan.
    g.fillStyle = 'rgba(2,4,7,0.9)';
    g.fillRect(0, 0, VIEW_W, VIEW_H);

    g.save();
    g.translate(-Math.round(cam.x), -Math.round(cam.y));
    g.globalCompositeOperation = 'destination-out';
    const grad = g.createRadialGradient(player.x, player.y, 8, player.x, player.y, radius);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.62, 'rgba(0,0,0,1)');
    grad.addColorStop(0.86, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    tracePoly(g, player.x, player.y, game.playerPoly, radius);
    g.fill();
    g.restore();
  }

  drawNightVision(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(20,110,60,0.16)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,20,10,0.10)';
    for (let y = 0; y < VIEW_H; y += 3) ctx.fillRect(0, y, VIEW_W, 1);
    const grad = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.28, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.78);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,12,6,0.75)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }

  // ------------------------------------------------------------- overlays
  drawAboveFog(ctx, game) {
    // Noise pings
    for (const n of game.noiseRings) {
      const t = 1 - n.life / n.maxLife;
      ctx.strokeStyle = `rgba(190,225,255,${(1 - t) * 0.5})`;
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius * t, 0, TAU);
      ctx.stroke();
    }

    // Alerted guards stay pinned even through walls — you can hear them yelling.
    for (const g of game.guards) {
      if (g.down || !(g.state === GUARD_STATE.ALERT || g.state === GUARD_STATE.SEARCH)) continue;
      const bob = Math.sin(this.time * 8) * 2;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = g.state === GUARD_STATE.ALERT ? '#ff5468' : '#ffb14d';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('!', g.x, g.y - 22 + bob);
      ctx.restore();
    }

    // Last-known-position marker
    if (game.lastKnownMarker) {
      const m = game.lastKnownMarker;
      ctx.save();
      ctx.strokeStyle = `rgba(255,84,104,${clamp(m.life / 3, 0, 0.8)})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 16, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawVignette(ctx, game) {
    const p = game.player;
    if (p.hurtFlash > 0 || p.health < 45) {
      const a = Math.max(p.hurtFlash * 0.5, (45 - p.health) / 45 * 0.28);
      const grad = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.3, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.85);
      grad.addColorStop(0, 'rgba(120,0,20,0)');
      grad.addColorStop(1, `rgba(150,10,30,${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    const g2 = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.55, VIEW_W / 2, VIEW_H / 2, VIEW_H);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  drawMinimap(game) {
    const el = document.getElementById('minimap');
    if (!el || !this.minimap) return;
    const g = el.getContext('2d');
    g.clearRect(0, 0, el.width, el.height);
    g.drawImage(this.minimap, 0, 0);

    const s = this.minimapScale;
    const o = this.minimapOffset;
    const px = (x) => o.x + x * s;
    const py = (y) => o.y + y * s;

    // viewport box
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.strokeRect(px(game.cam.x), py(game.cam.y), VIEW_W * s, VIEW_H * s);

    for (const t of game.level.terminals) {
      g.fillStyle = t.hacked ? '#59ff9e' : '#6ec8ff';
      g.fillRect(px(t.x) - 2, py(t.y) - 2, 4, 4);
    }
    const e = game.level.extraction;
    g.fillStyle = game.objectivesDone ? '#59ff9e' : 'rgba(120,140,160,0.6)';
    g.fillRect(px(e.x) - 3, py(e.y) - 3, 6, 6);

    for (const gd of game.guards) {
      if (gd.down) {
        g.fillStyle = 'rgba(140,150,160,0.6)';
      } else if (gd.state === GUARD_STATE.ALERT || gd.state === GUARD_STATE.SEARCH) {
        g.fillStyle = '#ff5468';
      } else if (game.canPlayerSee(gd.x, gd.y)) {
        g.fillStyle = '#ffb14d';
      } else {
        continue;
      }
      g.beginPath();
      g.arc(px(gd.x), py(gd.y), 2.4, 0, TAU);
      g.fill();
    }

    const p = game.player;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(px(p.x), py(p.y), 2.6, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(89,255,158,0.9)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(px(p.x), py(p.y));
    g.lineTo(px(p.x) + Math.cos(p.angle) * 8, py(p.y) + Math.sin(p.angle) * 8);
    g.stroke();
  }
}

export { VIEW_W, VIEW_H };
export default Renderer;
