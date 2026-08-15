// Display mode (mobile / desktop) and the render resolution that follows it.
//
// The game is mobile-first: anything that looks touch-driven — and anything
// ambiguous — gets the mobile build. A desktop browser with a real pointer and
// a wide window gets the desktop build. The player can override this in
// Settings, or with ?mode=mobile / ?mode=desktop in the URL.

import { clamp, store } from './util.js';

const KEY = 'nightecho.displaymode.v1';

export const MODE = { AUTO: 'auto', MOBILE: 'mobile', DESKTOP: 'desktop' };

/** Live viewport state, read by the renderer and the camera every frame. */
export const view = {
  w: 960,
  h: 544,
  mode: MODE.MOBILE,
  portrait: false,
  scale: 1,
  /** World magnification. Phones zoom in so tiles stay thumb-sized. */
  zoom: 1,
  /** Viewport measured in world pixels — what the camera actually covers. */
  get worldW() { return this.w / this.zoom; },
  get worldH() { return this.h / this.zoom; },
};

/** What the browser looks like, ignoring any saved preference. */
export function detectMode() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const noHover = matchMedia('(hover: none)').matches;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const ua = /android|iphone|ipad|ipod|iemobile|opera mini|mobile|tablet/i.test(navigator.userAgent);

  if (ua) return MODE.MOBILE;
  if (touch && (coarse || noHover)) return MODE.MOBILE;
  // A fine pointer on a roomy window is the only confident desktop signal.
  if (!touch && !coarse && Math.min(innerWidth, innerHeight) >= 600) return MODE.DESKTOP;
  return MODE.MOBILE;
}

export function getPreference() {
  const q = new URLSearchParams(location.search).get('mode');
  if (q === MODE.MOBILE || q === MODE.DESKTOP || q === MODE.AUTO) {
    store.set(KEY, q);
    return q;
  }
  const saved = store.get(KEY, MODE.AUTO);
  return saved === MODE.MOBILE || saved === MODE.DESKTOP ? saved : MODE.AUTO;
}

export function setPreference(pref) {
  store.set(KEY, pref);
}

export function resolveMode() {
  const pref = getPreference();
  return pref === MODE.AUTO ? detectMode() : pref;
}

/**
 * Pick an internal render resolution.
 *
 * Desktop keeps the fixed 960x544 frame (letterboxed inside the window).
 * Mobile matches the device aspect ratio exactly so the canvas fills the
 * screen edge to edge in either orientation, holding a roughly constant pixel
 * budget so the amount of world you can see stays fair.
 */
export function computeSize(mode, winW = innerWidth, winH = innerHeight) {
  if (mode === MODE.DESKTOP) return { w: 960, h: 544 };

  const aspect = clamp(winW / Math.max(1, winH), 0.42, 2.6);
  const BUDGET = 486000; // ~= 900 x 540
  let h = Math.sqrt(BUDGET / aspect);
  let w = h * aspect;

  // Keep the world readable: never so wide that tiles get tiny, never so
  // narrow that you cannot see a guard coming.
  const s = Math.min(1, 1180 / w, 980 / h);
  w *= s;
  h *= s;
  const s2 = Math.max(1, 430 / w, 430 / h);
  w *= s2;
  h *= s2;

  return { w: Math.round(w / 2) * 2, h: Math.round(h / 2) * 2 };
}

/** Recompute `view` from the window; returns true when the size changed. */
export function layout() {
  const mode = resolveMode();
  const { w, h } = computeSize(mode);
  const changed = w !== view.w || h !== view.h || mode !== view.mode;

  view.mode = mode;
  view.w = w;
  view.h = h;
  view.portrait = innerHeight > innerWidth;
  view.zoom = mode === MODE.DESKTOP ? 1 : (view.portrait ? 1.5 : 1.15);

  const pad = mode === MODE.DESKTOP ? 24 : 0;
  view.scale = Math.max(0.25, Math.min((innerWidth - pad) / w, (innerHeight - pad) / h));

  document.body.classList.toggle('mobile', mode === MODE.MOBILE);
  document.body.classList.toggle('desktop', mode === MODE.DESKTOP);
  document.body.classList.toggle('portrait', view.portrait);
  return changed;
}

export default view;
