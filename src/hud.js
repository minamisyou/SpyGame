// HUD: syncs DOM widgets with the live mission state once per frame.

import { formatTime, clamp } from './util.js';
import { GUARD_STATE } from './guard.js';
import { STANCE } from './player.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = $('hud');
    this.el = {
      missionName: $('missionName'),
      objectives: $('objectiveList'),
      pips: [...document.querySelectorAll('.pip')],
      timer: $('timerText'),
      light: $('lightBar'),
      sound: $('soundBar'),
      health: $('healthBar'),
      stance: $('stanceText'),
      ammo: $('ammoText'),
      bottle: $('bottleText'),
      nv: $('nvText'),
      keycard: $('keycardItem'),
      prompt: $('prompt'),
      hackWrap: $('hackWrap'),
      hackBar: $('hackBar'),
      toast: $('toast'),
      flash: $('detectFlash'),
    };
    this.toastTimer = 0;
    this.flashTimer = 0;
    this.lastObjSignature = '';
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
  }

  setMission(level) {
    this.el.missionName.textContent = level.name;
    this.lastObjSignature = '';
  }

  toast(msg) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    this.toastTimer = 2.6;
  }

  flash() {
    this.flashTimer = 0.35;
    this.el.flash.classList.add('on');
  }

  update(game, dt) {
    const p = game.player;

    // objectives -------------------------------------------------------
    const total = game.level.terminals.length;
    const done = game.hackedCount;
    const sig = `${done}/${total}|${game.objectivesDone}|${game.alarmLevel}`;
    if (sig !== this.lastObjSignature) {
      this.lastObjSignature = sig;
      const items = [
        {
          text: `데이터 단말 해킹 (${done}/${total})`,
          done: done === total,
          active: done < total,
        },
        {
          text: '탈출 지점으로 이동',
          done: false,
          active: done === total,
        },
        {
          text: `무경보 유지 (${game.alarmLevel}/3)`,
          done: false,
          active: game.alarmLevel > 0,
        },
      ];
      this.el.objectives.innerHTML = items
        .map((i) => `<li class="${i.done ? 'done' : i.active ? 'active' : ''}">${i.text}</li>`)
        .join('');
    }

    // alarm ------------------------------------------------------------
    this.el.pips.forEach((pip, i) => pip.classList.toggle('on', i < game.alarmLevel));
    this.el.timer.textContent = formatTime(game.time);

    // meters -----------------------------------------------------------
    this.el.light.style.width = `${clamp(p.exposure, 0, 1) * 100}%`;
    this.el.sound.style.width = `${clamp(p.noiseLevel, 0, 1) * 100}%`;
    this.el.health.style.width = `${clamp(p.health / 100, 0, 1) * 100}%`;
    this.el.stance.textContent = STANCE[p.stance].label;

    // gear -------------------------------------------------------------
    this.el.ammo.textContent = p.ammo;
    this.el.bottle.textContent = p.bottles;
    this.el.nv.textContent = Math.round(p.nvBattery);
    this.el.nv.style.color = p.nvOn ? '#59ff9e' : '';
    this.el.keycard.classList.toggle('hidden', !p.keycard);

    // prompt + hack ------------------------------------------------------
    if (game.promptText) {
      this.el.prompt.innerHTML = game.promptText;
      this.el.prompt.classList.remove('hidden');
    } else {
      this.el.prompt.classList.add('hidden');
    }

    const hacking = game.hackTarget && game.hackProgress > 0;
    this.el.hackWrap.classList.toggle('hidden', !hacking);
    if (hacking) this.el.hackBar.style.width = `${clamp(game.hackProgress, 0, 1) * 100}%`;

    // transient overlays -------------------------------------------------
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.el.flash.classList.remove('on');
    }

    // A hunting guard keeps a faint red edge on screen.
    const hunted = game.guards.some((g) => !g.down && g.state === GUARD_STATE.ALERT);
    if (this.flashTimer <= 0) this.el.flash.classList.toggle('on', hunted && Math.sin(performance.now() / 220) > 0.4);
  }
}

export default Hud;
