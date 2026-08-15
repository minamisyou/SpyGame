// Bootstrap: screens, mission lifecycle and the frame loop.

import LEVELS from './levels.js';
import Game, { MISSION } from './game.js';
import Renderer, { VIEW_W, VIEW_H } from './render.js';
import Hud from './hud.js';
import input from './input.js';
import audio from './audio.js';
import { store, formatTime } from './util.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'nightecho.progress.v1';

const canvas = $('game');
const renderer = new Renderer(canvas);
const hud = new Hud();

const screens = {
  title: $('screenTitle'),
  brief: $('screenBrief'),
  pause: $('screenPause'),
  end: $('screenEnd'),
};

let game = null;
let levelIndex = 0;
let paused = false;
let lastTime = performance.now();
let progress = store.get(SAVE_KEY, { best: {} });

const isTouch = matchMedia('(hover: none)').matches || 'ontouchstart' in window;

// ------------------------------------------------------------------ layout
function fitStage() {
  const stage = $('stage');
  const pad = isTouch ? 0 : 24;
  const scale = Math.min(
    (innerWidth - pad) / VIEW_W,
    (innerHeight - pad) / VIEW_H,
  );
  stage.style.transform = `scale(${Math.max(0.3, scale)})`;
}
addEventListener('resize', fitStage);
fitStage();

// ------------------------------------------------------------------ screens
function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
  if (name === null) for (const el of Object.values(screens)) el.classList.add('hidden');
}

function hideAllScreens() {
  for (const el of Object.values(screens)) el.classList.add('hidden');
}

function levelUnlocked(i) {
  if (i === 0) return true;
  return !!progress.best[LEVELS[i - 1].id];
}

function buildMissionSelect() {
  const wrap = $('missionSelect');
  wrap.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const unlocked = levelUnlocked(i);
    const best = progress.best[lv.id];
    const btn = document.createElement('button');
    btn.className = 'mcard';
    btn.disabled = !unlocked;
    btn.innerHTML = `
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <span>${unlocked ? lv.name : '● ● ● ● ●'}
        <span class="sub">${unlocked ? lv.codename : '이전 임무를 완수하면 해금'}</span>
      </span>
      <span class="best">${best ? `RANK ${best.rank}<br>${formatTime(best.time)}` : ''}</span>`;
    btn.addEventListener('click', () => {
      audio.init();
      levelIndex = i;
      openBriefing();
    });
    wrap.appendChild(btn);
  });
}

function openBriefing() {
  const lv = LEVELS[levelIndex];
  $('briefName').textContent = `${String(levelIndex + 1).padStart(2, '0')} · ${lv.name}`;
  $('briefText').textContent = lv.brief;
  $('briefObjectives').innerHTML = [
    `데이터 단말 ${lv.map.join('').split('I').length - 1}곳 해킹`,
    '탈출 지점(EXIT)으로 이동',
    lv.lockedDoorHint ? `${lv.lockedDoorHint} — 키카드를 찾을 것` : '경비는 비살상으로만 무력화',
  ].map((t) => `<li>${t}</li>`).join('');
  showScreen('brief');
}

// ------------------------------------------------------------------ mission
function startMission() {
  audio.init();
  const def = LEVELS[levelIndex];
  game = new Game(def, {
    onToast: (msg) => hud.toast(msg),
    onDetected: () => hud.flash(),
    onEnd: (result) => onMissionEnd(result),
  });
  game.usingTouch = isTouch;
  renderer.buildStatic(game.level);
  hud.setMission(def);
  hud.show(true);
  hideAllScreens();
  paused = false;
  $('touch').classList.toggle('hidden', !isTouch);
  lastTime = performance.now();
}

function onMissionEnd(result) {
  const lv = LEVELS[levelIndex];
  if (result.success) {
    const prev = progress.best[lv.id];
    if (!prev || result.score > prev.score) {
      progress.best[lv.id] = { rank: result.rank, score: result.score, time: result.time };
      store.set(SAVE_KEY, progress);
    }
  }

  const title = $('endTitle');
  title.textContent = result.success ? 'MISSION COMPLETE' : 'MISSION FAILED';
  title.classList.toggle('fail', !result.success);
  $('endSub').textContent = result.success
    ? (result.ghost ? '완전 은신 · 흔적 없음 · GHOST' : '침투 완료. 흔적은 남았지만 목표는 확보했다.')
    : (result.failReason || '작전 중단');

  $('scoreGrid').innerHTML = [
    ['소요 시간', result.timeText],
    ['확보 데이터', result.terminals],
    ['발각 횟수', result.detections],
    ['무력화', result.knockouts],
    ['파괴한 조명', result.lightsOut],
    ['점수', result.score],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');

  $('rankText').textContent = result.rank;
  $('btnNext').classList.toggle('hidden', !result.success || levelIndex >= LEVELS.length - 1);
  hud.show(false);
  $('touch').classList.add('hidden');
  showScreen('end');
  buildMissionSelect();
}

function togglePause(force) {
  if (!game || game.state !== MISSION.RUNNING) return;
  paused = force !== undefined ? force : !paused;
  if (paused) {
    showScreen('pause');
    hud.show(false);
  } else {
    hideAllScreens();
    hud.show(true);
    lastTime = performance.now();
  }
}

function toMenu() {
  game = null;
  hud.show(false);
  $('touch').classList.add('hidden');
  buildMissionSelect();
  showScreen('title');
}

// ------------------------------------------------------------------ buttons
$('btnStart').addEventListener('click', startMission);
$('btnBackTitle').addEventListener('click', () => showScreen('title'));
$('btnResume').addEventListener('click', () => togglePause(false));
$('btnRestart').addEventListener('click', startMission);
$('btnAbort').addEventListener('click', toMenu);
$('btnRetry').addEventListener('click', startMission);
$('btnMenu').addEventListener('click', toMenu);
$('btnNext').addEventListener('click', () => {
  levelIndex = Math.min(LEVELS.length - 1, levelIndex + 1);
  openBriefing();
});

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game && game.state === MISSION.RUNNING) {
    e.preventDefault();
    togglePause();
  }
  if (e.code === 'Enter' && !screens.brief.classList.contains('hidden')) startMission();
});

// ------------------------------------------------------------------ loop
input.attach(canvas);
if (isTouch) input.attachTouch($('touch'));

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;

  if (!game) return;
  const live = !paused && game.state === MISSION.RUNNING;
  if (live) {
    game.update(dt);
    hud.update(game, dt);
  }
  renderer.draw(game, live ? dt : 0);
  input.endFrame();
}

buildMissionSelect();
showScreen('title');
requestAnimationFrame(frame);

// Expose for quick console poking during development.
window.NIGHT_ECHO = { get game() { return game; }, LEVELS };
