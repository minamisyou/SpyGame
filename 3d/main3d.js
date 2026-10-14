// NIGHT ECHO 3D bootstrap — the 2D build's main.js with the three.js renderer
// swapped in. All game logic is imported unchanged from ../src/.

import LEVELS from '../src/levels.js';
import Game, { MISSION } from '../src/game.js';
import Renderer from './render3d.js';
import Hud from '../src/hud.js';
import input from '../src/input.js';
import audio from '../src/audio.js';
import { store, formatTime } from '../src/util.js';
import { view, layout, MODE, getPreference, setPreference, detectMode } from '../src/viewport.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'nightecho.progress.v1';

layout(); // establish body classes + view size before anything measures itself

const canvas = $('game');
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  document.getElementById('noWebgl')?.classList.remove('hidden');
  throw err;
}
const hud = new Hud();

const screens = {
  title: $('screenTitle'),
  brief: $('screenBrief'),
  settings: $('screenSettings'),
  pause: $('screenPause'),
  end: $('screenEnd'),
};

let game = null;
let levelIndex = 0;
let paused = false;
let lastTime = performance.now();
let progress = store.get(SAVE_KEY, { best: {} });
let settingsReturn = 'title';

const isMobile = () => view.mode === MODE.MOBILE;

// ------------------------------------------------------------------ layout
function applyLayout() {
  const sizeChanged = layout();
  const stage = $('stage');
  stage.style.width = `${view.w}px`;
  stage.style.height = `${view.h}px`;
  // Scale from the top-left corner, then centre by hand.
  const ox = Math.max(0, (innerWidth - view.w * view.scale) / 2);
  const oy = Math.max(0, (innerHeight - view.h * view.scale) / 2);
  stage.style.transform = `translate(${ox}px, ${oy}px) scale(${view.scale})`;

  // The minimap shrinks on phones; rebake it when the size changes.
  const mm = $('minimap');
  const mmW = isMobile() ? (view.portrait ? 116 : 96) : 180;
  const mmH = isMobile() ? (view.portrait ? 84 : 70) : 130;
  const mmChanged = mm.width !== mmW || mm.height !== mmH;
  if (mmChanged) {
    mm.width = mmW;
    mm.height = mmH;
  }

  renderer.resize();
  if (game && (sizeChanged || mmChanged)) renderer.buildMinimap(game.level);
  if (game) {
    game.usingTouch = isMobile();
    game.snapCamera();
    renderer.snapCamera(game);
  }
  $('touch').classList.toggle('hidden', !(isMobile() && game && !paused));
}

addEventListener('resize', applyLayout);
addEventListener('orientationchange', () => setTimeout(applyLayout, 120));
applyLayout();

// ------------------------------------------------------------------ screens
function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
  $('touch').classList.add('hidden');
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

// ------------------------------------------------------------------ settings
function renderSettings() {
  const pref = getPreference();
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === pref);
  });
  const detected = detectMode() === MODE.MOBILE ? '모바일' : '데스크톱';
  const active = isMobile() ? '모바일' : '데스크톱';
  $('modeHint').innerHTML = pref === MODE.AUTO
    ? `이 브라우저는 <b>${detected}</b> 환경으로 판별되어 현재 <b>${active}</b> 버전으로 실행 중입니다.<br>`
      + '모바일 버전은 터치 조작, 데스크톱 버전은 키보드+마우스 조작입니다.'
    : `수동으로 <b>${active}</b> 버전을 사용 중입니다. '자동'으로 돌리면 접속 환경에 맞춰 판별합니다.`;
}

function openSettings(from) {
  settingsReturn = from;
  renderSettings();
  showScreen('settings');
}

document.querySelectorAll('#modeSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    setPreference(b.dataset.mode);
    applyLayout();
    renderSettings();
    buildMissionSelect();
    if (game && paused) $('touch').classList.add('hidden');
  });
});

$('btnWipe').addEventListener('click', () => {
  progress = { best: {} };
  store.set(SAVE_KEY, progress);
  buildMissionSelect();
  $('btnWipe').textContent = '초기화 완료';
  setTimeout(() => { $('btnWipe').textContent = '기록 초기화'; }, 1500);
});

// ------------------------------------------------------------------ mission
function startMission() {
  audio.init();
  const def = LEVELS[levelIndex];
  game = new Game(def, {
    onToast: (msg) => hud.toast(msg),
    onDetected: () => {
      hud.flash();
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    },
    onEnd: (result) => onMissionEnd(result),
  });
  game.usingTouch = isMobile();
  // Mouse aim: cast the cursor onto the 3D floor instead of the 2D camera.
  game.screenToWorld = (sx, sy) => renderer.screenToWorld(sx, sy);
  renderer.resize();
  renderer.buildStatic(game.level);
  hud.setMission(def);
  hud.show(true);
  hideAllScreens();
  paused = false;
  input.clearToggles();
  $('touch').classList.toggle('hidden', !isMobile());
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
    ['동료 발견됨', result.bodiesFound],
    ['파괴한 조명', result.lightsOut],
    ['점수', result.score],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');

  $('rankText').textContent = result.rank;
  $('btnNext').classList.toggle('hidden', !result.success || levelIndex >= LEVELS.length - 1);
  hud.show(false);
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
    $('touch').classList.toggle('hidden', !isMobile());
    lastTime = performance.now();
  }
}

function toMenu() {
  game = null;
  hud.show(false);
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
$('btnSettings').addEventListener('click', () => openSettings('title'));
$('btnPauseSettings').addEventListener('click', () => openSettings('pause'));
$('btnSettingsBack').addEventListener('click', () => {
  showScreen(settingsReturn === 'pause' ? 'pause' : 'title');
});
$('btnPauseTouch').addEventListener('click', () => togglePause(true));
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
input.attachTouch($('touch'));

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
window.NIGHT_ECHO = { get game() { return game; }, LEVELS, view, input };
