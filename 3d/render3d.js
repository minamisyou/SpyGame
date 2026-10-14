// NIGHT ECHO 3D — a three.js renderer that drops in for src/render.js.
//
// The simulation is untouched: guards, sight, light, sound and scoring all run
// on the original 2D grid. This file only decides how that grid looks.
//
// Lighting and fog of war are not re-simulated with GPU lights. Every frame we
// paint two small world-space canvases exactly the way the 2D build does —
//   light : ambient + every lamp's occlusion polygon (what LIGHT measures)
//   fog   : R = what the operative can see, G = the same, dilated onto walls
// — and every material samples them by world XZ. So a shadow you can hide in
// looks like a shadow, and a wall you cannot see behind stays dark.

import * as THREE from 'three';
import { T, WALL, GLASS } from '../src/level.js';
import { tracePoly } from '../src/raycast.js';
import { GUARD_STATE } from '../src/guard.js';
import { view } from '../src/viewport.js';
import { clamp, TAU } from '../src/util.js';

const WALL_H = 1.2;
const GLASS_H = 1.05;
const LS = 0.25;          // light/fog canvas pixels per world pixel (8 per tile)
const AIM_Y = 0.45;       // muzzle height: the mouse ray is cast onto this plane
const PITCH_TILT = 58 * Math.PI / 180;
const PITCH_TOP = 86 * Math.PI / 180;
const FOV = 36;

const W = (px) => px / T; // world pixels -> tiles (scene units)

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ shaders
const WORLD_VS = /* glsl */`
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
varying float vViewZ;
#ifdef USE_INSTANCING_COLOR
varying vec3 vIC;
#endif
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  n = mat3(instanceMatrix) * n;
  #endif
  #ifdef USE_INSTANCING_COLOR
  vIC = instanceColor;
  #endif
  vec4 w = modelMatrix * p;
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  vec4 mv = viewMatrix * w;
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FOG_CHUNK = /* glsl */`
uniform sampler2D uLight;
uniform sampler2D uFog;
uniform vec2 uWorld;
uniform float uNV;
vec3 finishWorld(vec3 col, float vis) {
  // Grade in display space so the numbers match the 2D build's canvas maths.
  vec3 cs = pow(max(col, 0.0), vec3(1.0 / 2.2));
  cs = mix(cs, vec3(0.012, 0.02, 0.034), 0.86 * (1.0 - vis));
  float lum = dot(cs, vec3(0.3, 0.59, 0.11));
  cs = mix(cs, vec3(lum * 0.45, lum * 1.3 + 0.025, lum * 0.62), uNV * 0.8);
  return pow(max(cs, 0.0), vec3(2.2));
}`;

const WORLD_FS = /* glsl */`
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform float uOpacity;
uniform float uSelf;
uniform float uOffset;
uniform vec2 uPlayerPx;
uniform float uPlayerZ;
uniform float uXrayR;
#ifdef USE_MAP2
uniform sampler2D uMap;
#endif
varying vec3 vW;
varying vec3 vN;
varying vec2 vUv;
varying float vViewZ;
#ifdef USE_INSTANCING_COLOR
varying vec3 vIC;
#endif
${FOG_CHUNK}
void main() {
  #ifdef XRAY
  // Cut a dithered window through anything standing between the camera and
  // the operative, so a wall never hides you from yourself.
  float d = distance(gl_FragCoord.xy, uPlayerPx);
  if (vViewZ > uPlayerZ + 0.45 && d < uXrayR) {
    float k = smoothstep(uXrayR, uXrayR * 0.5, d);
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (k * 0.92 > ign) discard;
  }
  #endif
  vec3 base = uColor;
  #ifdef USE_MAP2
  base *= texture2D(uMap, vUv).rgb;
  #endif
  #ifdef USE_INSTANCING_COLOR
  base *= vIC;
  #endif
  vec3 n = normalize(vN);
  #ifdef FLAT
  float shade = 1.0;
  #else
  float shade = 0.6 + 0.5 * max(dot(n, normalize(vec3(-0.3, 1.0, 0.5))), 0.0);
  #endif
  vec2 uv = (vW.xz + n.xz * uOffset) / uWorld;
  vec3 L = max(texture2D(uLight, uv).rgb, vec3(uSelf));
  vec3 col = base * L * shade + uEmissive;
  vec2 f = texture2D(uFog, uv).rg;
  #ifdef FOG_DILATED
  float vis = max(f.g, f.r);
  #else
  float vis = f.r;
  #endif
  #ifdef NO_FOG
  vis = 1.0;
  #endif
  gl_FragColor = vec4(finishWorld(col, vis), uOpacity);
  #include <colorspace_fragment>
}`;

// Vision cones: a fan on the floor, radial falloff, hidden by fog like the 2D build.
const CONE_VS = /* glsl */`
attribute float aT;
varying float vT;
varying vec3 vW;
void main() {
  vT = aT;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const CONE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform sampler2D uFog;
uniform vec2 uWorld;
varying float vT;
varying vec3 vW;
void main() {
  float a = vT < 0.6 ? mix(1.0, 0.55, vT / 0.6) : mix(0.55, 0.0, (vT - 0.6) / 0.4);
  float vis = texture2D(uFog, vW.xz / uWorld).r;
  a *= uAlpha * (0.1 + 0.9 * vis);
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

// Lamp light shafts: additive open cones, brightest at the bulb.
const SHAFT_FS = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform sampler2D uFog;
uniform vec2 uWorld;
varying vec2 vUv;
varying vec3 vW;
void main() {
  float vis = texture2D(uFog, vW.xz / uWorld).r;
  float a = uAlpha * pow(vUv.y, 1.6) * vis;
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;
const SHAFT_VS = /* glsl */`
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Arcs and rings (progress meters, noise pings, markers). Not fogged.
const ARC_VS = /* glsl */`
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const ARC_FS = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uProg;
uniform float uSpan;
uniform float uStart;
uniform float uTrack;
uniform float uDash;
uniform float uDashPhase;
varying vec2 vP;
void main() {
  float a = atan(vP.y, vP.x);
  float t = mod(uStart - a, 6.2831853) / 6.2831853;
  if (t > uSpan) discard;
  if (uDash > 0.0 && fract(t * uDash + uDashPhase) > 0.5) discard;
  bool on = t <= uProg * uSpan;
  float al = on ? uAlpha : uTrack;
  if (al <= 0.003) discard;
  gl_FragColor = vec4(on ? uColor : vec3(0.0), al);
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ renderer
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = 0;
    this.game = null;
    this.level = null;
    this.minimap = null;
    this.topDown = store.get('nightecho3d.topdown', false);
    this.userZoom = store.get('nightecho3d.zoom', 0.74);

    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.setClearColor(0x04060a, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, view.w / view.h, 0.1, 400);
    this.camTarget = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -AIM_Y);
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.tmpV = new THREE.Vector3();

    // World-space light + fog canvases, shared by every material.
    this.lightCanvas = makeCanvas(4, 4);
    this.lctx = this.lightCanvas.getContext('2d');
    this.fogCanvas = makeCanvas(4, 4);
    this.fctx = this.fogCanvas.getContext('2d');
    this.lightTex = new THREE.CanvasTexture(this.lightCanvas);
    this.lightTex.colorSpace = THREE.SRGBColorSpace;
    this.fogTex = new THREE.CanvasTexture(this.fogCanvas);
    for (const t of [this.lightTex, this.fogTex]) {
      t.flipY = false; // sampled by world XZ: canvas row 0 is map row 0
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    }

    this.shared = {
      uLight: { value: this.lightTex },
      uFog: { value: this.fogTex },
      uWorld: { value: new THREE.Vector2(1, 1) },
      uNV: { value: 0 },
      uPlayerPx: { value: new THREE.Vector2(-9999, -9999) },
      uPlayerZ: { value: -1e6 },
      uXrayR: { value: 140 },
    };

    this.worldGroup = new THREE.Group();
    this.entityGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.scene.add(this.worldGroup, this.entityGroup, this.fxGroup);

    this.spriteCache = new Map();
    this.overlay = {
      nv: document.getElementById('nv3d'),
      hurt: document.getElementById('hurt3d'),
    };

    this.attachViewControls();
    this.resize();
  }

  // ------------------------------------------------------------- view controls
  attachViewControls() {
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyV' && !e.repeat) this.toggleView();
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userZoom = clamp(this.userZoom * (e.deltaY > 0 ? 1.08 : 1 / 1.08), 0.45, 1.4);
      store.set('nightecho3d.zoom', this.userZoom);
    }, { passive: false });
    const btn = document.getElementById('btnView3d');
    if (btn) btn.addEventListener('click', () => this.toggleView());
  }

  toggleView() {
    this.topDown = !this.topDown;
    store.set('nightecho3d.topdown', this.topDown);
  }

  resize() {
    const mobile = view.mode === 'mobile';
    const pr = Math.min(mobile ? 1.6 : 2, (window.devicePixelRatio || 1) * view.scale);
    this.gl.setPixelRatio(Math.max(0.5, pr));
    this.gl.setSize(view.w, view.h, false);
    this.camera.aspect = view.w / view.h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- materials
  mat(o = {}) {
    const uniforms = {
      ...this.shared,
      uColor: { value: new THREE.Color(o.color ?? 0xffffff) },
      uEmissive: { value: new THREE.Color(o.emissive ?? 0x000000) },
      uOpacity: { value: o.opacity ?? 1 },
      uSelf: { value: o.self ?? 0 },
      uOffset: { value: o.offset ?? 0.22 },
    };
    const defines = {};
    if (o.map) { defines.USE_MAP2 = ''; uniforms.uMap = { value: o.map }; }
    if (o.dilated) defines.FOG_DILATED = '';
    if (o.xray) defines.XRAY = '';
    if (o.flat) defines.FLAT = '';
    if (o.noFog) defines.NO_FOG = '';
    const transparent = !!o.transparent || (o.opacity ?? 1) < 1;
    return new THREE.ShaderMaterial({
      uniforms, defines,
      vertexShader: WORLD_VS,
      fragmentShader: WORLD_FS,
      transparent,
      depthWrite: o.depthWrite ?? !transparent,
      side: o.side ?? THREE.FrontSide,
    });
  }

  arcMat(o = {}) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(o.color ?? 0xffffff) },
        uAlpha: { value: o.alpha ?? 1 },
        uProg: { value: o.prog ?? 1 },
        uSpan: { value: o.span ?? 1 },
        uStart: { value: o.start ?? Math.PI / 2 },
        uTrack: { value: o.track ?? 0 },
        uDash: { value: o.dash ?? 0 },
        uDashPhase: { value: 0 },
      },
      vertexShader: ARC_VS,
      fragmentShader: ARC_FS,
      transparent: true,
      depthWrite: false,
      depthTest: o.depthTest ?? true,
      side: THREE.DoubleSide,
    });
  }

  floorRing(inner, outer, mat, y = 0.03) {
    const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 56, 1), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.renderOrder = 5;
    return m;
  }

  textSprite(text, color, { size = 0.5, depthTest = false, font = 'bold 84px monospace' } = {}) {
    const key = `${text}|${color}|${font}`;
    let tex = this.spriteCache.get(key);
    if (!tex) {
      const c = makeCanvas(128, 128);
      const g = c.getContext('2d');
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 10;
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.strokeText(text, 64, 68);
      g.fillStyle = color;
      g.fillText(text, 64, 68);
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.spriteCache.set(key, tex);
    }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest, depthWrite: false, transparent: true }));
    s.scale.set(size, size, 1);
    s.renderOrder = 20;
    return s;
  }

  setSpriteText(sprite, text, color) {
    const key = `${text}|${color}`;
    if (sprite.userData.key === key) return;
    sprite.userData.key = key;
    const tmp = this.textSprite(text, color);
    sprite.material.map = tmp.material.map;
    sprite.material.needsUpdate = true;
    tmp.material.dispose();
  }

  // ------------------------------------------------------------- textures
  floorTexture(level) {
    const P = 32; // texture pixels per tile
    const c = makeCanvas(level.w * P, level.h * P);
    const g = c.getContext('2d');
    g.fillStyle = '#0a0e15';
    g.fillRect(0, 0, c.width, c.height);
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = 0; tx < level.w; tx++) {
        const t = level.tileAt(tx, ty);
        if (t === WALL) continue;
        const x = tx * P;
        const y = ty * P;
        const n = hash(tx, ty);
        const shade = 60 + n * 16;
        g.fillStyle = `rgb(${(shade * 0.8) | 0}, ${(shade * 0.93) | 0}, ${(shade * 1.15) | 0})`;
        g.fillRect(x, y, P, P);
        g.strokeStyle = 'rgba(150, 200, 230, 0.10)';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, P - 1, P - 1);
        if (n > 0.9) {
          g.fillStyle = 'rgba(150, 200, 230, 0.06)';
          g.fillRect(x + 4, y + 4, P - 8, P - 8);
        }
        if (n < 0.06) {
          g.strokeStyle = 'rgba(0,0,0,0.25)';
          g.beginPath();
          g.moveTo(x + 6, y + 6 + n * 200);
          g.lineTo(x + P - 6, y + P - 10);
          g.stroke();
        }
        // ambient-occlusion skirt where the floor meets a wall
        const skirt = (dx, dy) => level.tileAt(tx + dx, ty + dy) === WALL;
        g.fillStyle = 'rgba(0,0,0,0.38)';
        if (skirt(0, -1)) g.fillRect(x, y, P, 5);
        if (skirt(0, 1)) g.fillRect(x, y + P - 5, P, 5);
        if (skirt(-1, 0)) g.fillRect(x, y, 5, P);
        if (skirt(1, 0)) g.fillRect(x + P - 5, y, 5, P);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
    return tex;
  }

  wallSideTexture() {
    const c = makeCanvas(64, 128);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#8392ac');
    grad.addColorStop(0.75, '#6a7790');
    grad.addColorStop(1, '#3a4252');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 128);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(0, 44, 64, 2);
    g.fillRect(0, 92, 64, 2);
    g.fillRect(0, 0, 2, 128);
    g.fillStyle = 'rgba(210,235,255,0.35)';
    g.fillRect(0, 0, 64, 4);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ------------------------------------------------------------- prebake
  disposeGroup(group) {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of [].concat(o.material)) {
          if (m.uniforms?.uMap?.value && !m.userData.sharedMap) m.uniforms.uMap.value.dispose?.();
          m.dispose();
        }
      }
    });
    group.clear();
  }

  buildStatic(level) {
    this.level = level;
    this.game = null;
    this.disposeGroup(this.worldGroup);
    this.disposeGroup(this.entityGroup);
    this.disposeGroup(this.fxGroup);

    this.shared.uWorld.value.set(level.w, level.h);
    this.lightCanvas.width = Math.ceil(level.pxW * LS);
    this.lightCanvas.height = Math.ceil(level.pxH * LS);
    this.fogCanvas.width = this.lightCanvas.width;
    this.fogCanvas.height = this.lightCanvas.height;
    this.lightTex.dispose();
    this.fogTex.dispose();
    this.lightTex.needsUpdate = true;
    this.fogTex.needsUpdate = true;

    const G = this.worldGroup;

    // Floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(level.w, level.h),
      this.mat({ map: this.floorTexture(level), offset: 0, color: 0xffffff }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(level.w / 2, 0, level.h / 2);
    G.add(floor);

    // Walls — one instanced box per tile; the top face gets its own material.
    const walls = [];
    const glass = [];
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = 0; tx < level.w; tx++) {
        const t = level.tileAt(tx, ty);
        if (t === WALL) {
          // Skip wall tiles fully buried in other walls: nobody sees them.
          let open = false;
          for (let dy = -1; dy <= 1 && !open; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (level.inBounds(tx + dx, ty + dy) && level.tileAt(tx + dx, ty + dy) !== WALL) { open = true; break; }
            }
          }
          if (open) walls.push([tx, ty]);
        } else if (t === GLASS) glass.push([tx, ty]);
      }
    }
    const boxGeo = new THREE.BoxGeometry(1, WALL_H, 1);
    boxGeo.translate(0, WALL_H / 2, 0);
    const side = this.mat({ map: this.wallSideTexture(), xray: true, dilated: true, offset: 0.25 });
    const top = this.mat({ color: 0x3b4558, xray: true, dilated: true, self: 0.62, offset: 0, flat: true });
    const wallMesh = new THREE.InstancedMesh(boxGeo, [side, side, top, top, side, side], walls.length);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    walls.forEach(([tx, ty], i) => {
      m4.makeTranslation(tx + 0.5, 0, ty + 0.5);
      wallMesh.setMatrixAt(i, m4);
      const n = hash(tx, ty);
      col.setRGB(0.88 + n * 0.14, 0.9 + n * 0.12, 0.92 + n * 0.12);
      wallMesh.setColorAt(i, col);
    });
    G.add(wallMesh);

    if (glass.length) {
      // Thin panes running along the wall line, with a slim frame on top.
      const gGeo = new THREE.BoxGeometry(1, GLASS_H, 0.14);
      gGeo.translate(0, GLASS_H / 2, 0);
      const gMat = this.mat({ color: 0x9fe6ff, emissive: 0x06161c, opacity: 0.28, xray: true, dilated: true, side: THREE.DoubleSide, self: 0.6 });
      const gMesh = new THREE.InstancedMesh(gGeo, gMat, glass.length);
      gMesh.renderOrder = 8;
      const frameGeo = new THREE.BoxGeometry(1, 0.05, 0.2);
      frameGeo.translate(0, GLASS_H, 0);
      const fMesh = new THREE.InstancedMesh(frameGeo, this.mat({ color: 0x5f7f8c, emissive: 0x0c3440, self: 0.6, dilated: true }), glass.length);
      const solid = (x, y) => level.tileAt(x, y) === WALL || level.tileAt(x, y) === GLASS;
      const rot = new THREE.Matrix4();
      glass.forEach(([tx, ty], i) => {
        const horizontal = solid(tx - 1, ty) || solid(tx + 1, ty) || !(solid(tx, ty - 1) || solid(tx, ty + 1));
        m4.makeTranslation(tx + 0.5, 0, ty + 0.5);
        if (!horizontal) m4.multiply(rot.makeRotationY(Math.PI / 2));
        gMesh.setMatrixAt(i, m4);
        fMesh.setMatrixAt(i, m4);
      });
      G.add(gMesh, fMesh);
    }

    // Doors: two leaves that slide apart into the wall.
    this.doorMeshes = level.doors.map((d) => {
      const grp = new THREE.Group();
      grp.position.set(d.tx + 0.5, 0, d.ty + 0.5);
      if (!d.horizontal) grp.rotation.y = Math.PI / 2;
      const leafMat = this.mat({ color: d.locked ? 0x8a5530 : 0x4a6578, xray: true, dilated: true, offset: 0.3 });
      const stripMat = this.mat({ color: 0x000000, emissive: d.locked ? 0xff9a3a : 0x5fd0ff, dilated: true });
      const leaves = [-1, 1].map((s) => {
        const leaf = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, WALL_H * 0.92, 0.2), leafMat);
        box.position.set(0, WALL_H * 0.46, 0);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.04, WALL_H * 0.7, 0.22), stripMat);
        strip.position.set(-s * 0.23, WALL_H * 0.46, 0);
        leaf.add(box, strip);
        leaf.userData.side = s;
        grp.add(leaf);
        return leaf;
      });
      G.add(grp);
      return { door: d, grp, leaves, leafMat, stripMat };
    });

    // Lamps
    this.lampMeshes = level.lights.map((li) => {
      const grp = new THREE.Group();
      grp.position.set(W(li.x), 0, W(li.y));
      const bulbMat = this.mat({ color: 0x222222, emissive: 0xfff2c8, noFog: false, dilated: true });
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.05, 20), bulbMat);
      bulb.position.y = WALL_H + 0.28;
      const shaftMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0xffe6b0) }, uAlpha: { value: 0.16 }, uFog: this.shared.uFog, uWorld: this.shared.uWorld },
        vertexShader: SHAFT_VS, fragmentShader: SHAFT_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.95, WALL_H + 0.26, 28, 1, true), shaftMat);
      shaft.position.y = (WALL_H + 0.26) / 2;
      shaft.renderOrder = 9;
      grp.add(bulb, shaft);
      G.add(grp);
      return { light: li, grp, bulb, bulbMat, shaft, shaftMat };
    });

    // Terminals
    this.terminalMeshes = level.terminals.map((t) => {
      const grp = new THREE.Group();
      grp.position.set(W(t.x), 0, W(t.y));
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.5, 0.42), this.mat({ color: 0x2a3646, dilated: true }));
      body.position.y = 0.25;
      const screenMat = this.mat({ color: 0x000000, emissive: 0x6ec8ff, dilated: true });
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.04), screenMat);
      screen.position.set(0, 0.62, 0.02);
      screen.rotation.x = -0.45;
      const ringMat = this.arcMat({ color: 0x59ff9e, alpha: 0.95, prog: 0, track: 0.25 });
      const ring = this.floorRing(0.5, 0.58, ringMat, 0.04);
      grp.add(body, screen, ring);
      G.add(grp);
      return { term: t, grp, screenMat, ringMat };
    });

    // Pickups
    this.pickupMeshes = level.pickups.map((p) => {
      const grp = new THREE.Group();
      grp.position.set(W(p.x), 0, W(p.y));
      let mesh;
      if (p.kind === 'ammo') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.2), this.mat({ color: 0x0a1a24, emissive: 0x4fa8e0, self: 0.5 }));
      } else if (p.kind === 'bottle') {
        mesh = new THREE.Group();
        const bm = this.mat({ color: 0x0a2016, emissive: 0x7fe0b0, self: 0.5 });
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.26, 12), bm);
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.12, 8), bm);
        neck.position.y = 0.18;
        mesh.add(b, neck);
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.22), this.mat({ color: 0x2a1a08, emissive: 0xffb43c, self: 0.5 }));
      }
      mesh.position.y = 0.32;
      const ring = this.floorRing(0.2, 0.26, this.arcMat({
        color: p.kind === 'ammo' ? 0x9fd7ff : p.kind === 'bottle' ? 0xc9ffe1 : 0xffc14d, alpha: 0.5,
      }), 0.03);
      grp.add(mesh, ring);
      G.add(grp);
      return { pickup: p, grp, mesh };
    });

    // Extraction
    {
      const e = level.extraction;
      const grp = new THREE.Group();
      grp.position.set(W(e.x), 0, W(e.y));
      const rings = [0, 1, 2].map((i) => {
        const r = this.floorRing(0.3 + i * 0.24, 0.35 + i * 0.24, this.arcMat({ color: 0x59ff9e, alpha: 0.5 }), 0.03 + i * 0.002);
        grp.add(r);
        return r;
      });
      const c = makeCanvas(256, 128);
      const g = c.getContext('2d');
      g.font = 'bold 72px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#ffffff';
      g.fillText('EXIT', 128, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const labelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: 0x59ff9e });
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), labelMat);
      label.rotation.x = -Math.PI / 2;
      label.position.y = 0.035;
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x59ff9e) }, uAlpha: { value: 0 }, uFog: this.shared.uFog, uWorld: this.shared.uWorld },
        vertexShader: SHAFT_VS,
        fragmentShader: SHAFT_FS.replace('pow(vUv.y, 1.6)', 'pow(1.0 - vUv.y, 1.3)'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 3, 28, 1, true), beamMat);
      beam.position.y = 1.5;
      grp.add(label, beam);
      G.add(grp);
      this.exitMesh = { grp, rings, labelMat, beamMat };
    }

    this.buildMinimap(level);
  }

  // ------------------------------------------------------------- characters
  makeCharacter({ body, trim, head, gun = 0x1a2027, self = 0, scale = 1 }) {
    const root = new THREE.Group();
    const pivot = new THREE.Group();
    root.add(pivot);
    const bodyMat = this.mat({ color: body, self, offset: 0.1 });
    const trimMat = this.mat({ color: trim, self, offset: 0.1 });
    const headMat = this.mat({ color: head, self, offset: 0.1 });
    const gunMat = this.mat({ color: gun, self: Math.max(self, 0.2), offset: 0.1 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.2, 4, 12), bodyMat);
    torso.position.y = 0.46;
    torso.scale.set(0.85, 1, 1.25);
    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.42), trimMat);
    shoulders.position.y = 0.58;
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), headMat);
    headM.position.set(0.02, 0.76, 0);
    const legs = [-1, 1].map((s) => {
      const hip = new THREE.Group();
      hip.position.set(0, 0.3, s * 0.08);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), bodyMat);
      leg.position.y = -0.15;
      hip.add(leg);
      pivot.add(hip);
      return hip;
    });
    const gunM = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.05), gunMat);
    gunM.position.set(0.24, AIM_Y, 0.1);
    pivot.add(torso, shoulders, headM, gunM);
    root.scale.setScalar(scale);
    return { root, pivot, legs, headM, bodyMat, trimMat, headMat, gunM, base: scale, walk: 0, lastX: 0, lastZ: 0 };
  }

  buildEntities(game) {
    this.disposeGroup(this.entityGroup);
    this.disposeGroup(this.fxGroup);
    this.game = game;
    const E = this.entityGroup;
    const F = this.fxGroup;

    // Player
    const pc = this.makeCharacter({ body: 0x2f4352, trim: 0x8cc8dc, head: 0x2a3a46, self: 0.42, scale: 1.2 });
    const gogMat = this.mat({ color: 0x000000, emissive: 0x2a8a55, noFog: true });
    for (const s of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), gogMat);
      g.position.set(0.11, 0.78, s * 0.045);
      pc.pivot.add(g);
    }
    pc.gogMat = gogMat;
    pc.ring = this.floorRing(0.44, 0.48, this.arcMat({ color: 0x78dcbe, alpha: 0.25 }), 0.025);
    pc.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    pc.aimMark = this.floorRing(0.13, 0.17, this.arcMat({ color: 0x9fe8ff, alpha: 0.7, dash: 8 }), 0.04);
    E.add(pc.root, pc.ring, pc.aimLine, pc.aimMark);
    this.playerModel = pc;

    // Guards
    this.guardModels = game.guards.map((g) => {
      const m = this.makeCharacter({ body: 0x4d6a7d, trim: 0x9fc4d8, head: 0x9fc4d8, scale: 1.2 });
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 12), m.bodyMat);
      cap.position.set(0.02, 0.85, 0);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.18), m.bodyMat);
      brim.position.set(0.13, 0.83, 0);
      m.pivot.add(cap, brim);
      m.coneMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0.2 }, uFog: this.shared.uFog, uWorld: this.shared.uWorld },
        vertexShader: CONE_VS, fragmentShader: CONE_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      m.cone = this.makeFan(34, m.coneMat);
      m.meterMat = this.arcMat({ color: 0xffe98a, alpha: 1, span: 0.25, start: Math.PI * 0.75, track: 0.45, depthTest: false });
      m.meter = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 40), m.meterMat);
      m.meter.renderOrder = 21;
      m.bubble = this.textSprite('?', '#ffd24d', { size: 0.55, depthTest: true });
      m.alertMark = this.textSprite('!', '#ff5468', { size: 0.6 });
      m.zzz = this.textSprite('z', '#96c8dc', { size: 0.4, depthTest: true, font: 'bold 64px monospace' });
      E.add(m.root, m.cone);
      F.add(m.meter, m.bubble, m.alertMark, m.zzz);
      m.lastX = W(g.x);
      m.lastZ = W(g.y);
      return m;
    });

    // Security cameras
    this.camModels = game.cams.map((c) => {
      const grp = new THREE.Group();
      grp.position.set(W(c.x), 0, W(c.y));
      const poleMat = this.mat({ color: 0x2a323c, dilated: true, self: 0.3 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8), poleMat);
      pole.position.y = WALL_H + 0.05;
      const mount = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), poleMat);
      mount.position.y = WALL_H - 0.15;
      const head = new THREE.Group();
      head.position.y = WALL_H - 0.15;
      const bodyMat = this.mat({ color: 0x323c4a, dilated: true, self: 0.3 });
      const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.18), bodyMat);
      bodyM.position.x = 0.2;
      const lensMat = this.mat({ color: 0x000000, emissive: 0x59ff9e, noFog: true });
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12), lensMat);
      lens.rotation.z = Math.PI / 2;
      lens.position.x = 0.43;
      head.add(bodyM, lens);
      head.rotation.z = -0.35; // tilt the lens down toward the floor
      const tilt = new THREE.Group();
      tilt.add(head);
      grp.add(pole, mount, tilt);
      const coneMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0.14 }, uFog: this.shared.uFog, uWorld: this.shared.uWorld },
        vertexShader: CONE_VS, fragmentShader: CONE_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const cone = this.makeFan(22, coneMat);
      const sparks = new THREE.Points(
        new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3)),
        new THREE.PointsMaterial({ color: 0xffdc96, size: 0.06, transparent: true, depthWrite: false }),
      );
      sparks.frustumCulled = false;
      E.add(grp, cone, sparks);
      return { cam: c, grp, tilt, head, lensMat, bodyMat, cone, coneMat, sparks };
    });

    // Pools for short-lived effects
    this.tracerPool = Array.from({ length: 10 }, () => {
      const l = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
      );
      l.frustumCulled = false;
      l.visible = false;
      F.add(l);
      return l;
    });
    this.bottlePool = Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.22, 10), this.mat({ color: 0x0a2016, emissive: 0x9fe8c8, noFog: true }));
      m.visible = false;
      F.add(m);
      return m;
    });
    this.noisePool = Array.from({ length: 12 }, () => {
      const r = this.floorRing(0.96, 1, this.arcMat({ color: 0xbee1ff, alpha: 0.5 }), 0.05);
      r.visible = false;
      F.add(r);
      return r;
    });
    this.lockReticle = new THREE.Group();
    this.lockReticle.add(this.floorRing(0.5, 0.56, this.arcMat({ color: 0xff7878, alpha: 0.9, dash: 10, depthTest: false }), 0.06));
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.05), new THREE.MeshBasicMaterial({ color: 0xff7878, transparent: true, depthTest: false }));
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = (i * Math.PI) / 2;
      tick.position.set(Math.cos(i * Math.PI / 2) * 0.55, 0.06, -Math.sin(i * Math.PI / 2) * 0.55);
      tick.renderOrder = 22;
      this.lockReticle.add(tick);
    }
    this.lockReticle.visible = false;
    this.lockLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xff7878, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.lockLine.frustumCulled = false;
    this.lastKnown = this.floorRing(0.44, 0.5, this.arcMat({ color: 0xff5468, alpha: 0.8, dash: 12, depthTest: false }), 0.06);
    this.lastKnown.visible = false;
    F.add(this.lockReticle, this.lockLine, this.lastKnown);
  }

  makeFan(n, mat) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(n + 1), 1));
    const idx = [];
    for (let i = 0; i < n - 1; i++) idx.push(0, i + 1, i + 2);
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 6;
    return m;
  }

  updateFan(mesh, x, y, radii, range, start, spread) {
    const pos = mesh.geometry.attributes.position;
    const at = mesh.geometry.attributes.aT;
    const n = radii.length;
    const step = spread / (n - 1);
    pos.setXYZ(0, W(x), 0.035, W(y));
    at.setX(0, 0);
    for (let i = 0; i < n; i++) {
      const a = start + i * step;
      const r = Math.min(radii[i] + 1.5, range + 1.5);
      pos.setXYZ(i + 1, W(x + Math.cos(a) * r), 0.035, W(y + Math.sin(a) * r));
      at.setX(i + 1, r / range);
    }
    pos.needsUpdate = true;
    at.needsUpdate = true;
  }

  // ------------------------------------------------------------- minimap
  buildMinimap(level) {
    const el = document.getElementById('minimap');
    const mmW = el ? el.width : 180;
    const mmH = el ? el.height : 130;
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

  // ------------------------------------------------------------- camera
  cameraDistance() {
    const pitch = this.topDown ? PITCH_TOP : PITCH_TILT;
    // Show about as much floor (vertically) as the 2D build does.
    const tilesTall = view.worldH / T;
    const k = (2 * Math.tan((FOV / 2) * Math.PI / 180)) / Math.sin(pitch);
    return (tilesTall / k) * this.userZoom;
  }

  placeCamera(target, snap, dt) {
    const pitch = this.topDown ? PITCH_TOP : PITCH_TILT;
    const d = this.cameraDistance();
    const want = new THREE.Vector3(target.x, target.y + d * Math.sin(pitch), target.z + d * Math.cos(pitch));
    if (snap || this.camLook.distanceTo(target) > 7) {
      this.camera.position.copy(want);
      this.camLook.copy(target);
    } else {
      const k = 1 - Math.pow(0.002, dt);
      this.camera.position.lerp(want, k);
      this.camLook.lerp(target, k);
    }
    this.camera.lookAt(this.camLook);
    this.camera.updateMatrixWorld();
  }

  /**
   * Lamps and cameras hang near the ceiling, so the floor point under the
   * cursor is not where they are. If the cursor is over something a dart can
   * hit, aim at that thing instead.
   */
  aimAssist(sx, sy) {
    const game = this.game;
    if (!game) return null;
    const c = this.canvas;
    const pr = c.width / Math.max(1, view.w);
    const reach = 26 * pr;
    let best = null;
    let bestD = reach;
    const v = this.tmpV;
    const test = (obj, y, kind) => {
      v.set(W(obj.x), y, W(obj.y)).project(this.camera);
      if (v.z > 1) return;
      const px = (v.x * 0.5 + 0.5) * c.width;
      const py = (-v.y * 0.5 + 0.5) * c.height;
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = { x: obj.x, y: obj.y, kind }; }
    };
    for (const li of game.level.lights) if (li.alive) test(li, WALL_H + 0.28, 'light');
    for (const cm of game.cams) if (cm.alive) test(cm, WALL_H - 0.15, 'cam');
    for (const g of game.guards) if (!g.down) test(g, 0.6, 'guard');
    return best;
  }

  screenToWorld(sx, sy) {
    const snap = this.aimAssist(sx, sy);
    this.aimSnap = snap;
    if (snap) return { x: snap.x, y: snap.y };
    const c = this.canvas;
    const nx = (sx / c.width) * 2 - 1;
    const ny = -((sy / c.height) * 2 - 1);
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.tmpV);
    if (!hit) {
      const p = this.game?.player;
      return p ? { x: p.x + 1, y: p.y } : { x: 0, y: 0 };
    }
    return { x: hit.x * T, y: hit.z * T };
  }

  groundFootprint() {
    const pts = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.raycaster.setFromCamera({ x, y }, this.camera);
      const hit = this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3());
      if (hit) pts.push({ x: hit.x * T, y: hit.z * T });
    }
    return pts;
  }

  // ------------------------------------------------------------- 2D passes
  paintLight(game) {
    const g = this.lctx;
    const { level, player } = game;
    const amb = player.nvOn
      ? Math.max(0.62, level.ambient + 0.45)
      : Math.max(0.30, level.ambient + 0.15);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const base = Math.round(amb * 255);
    g.fillStyle = `rgb(${Math.round(base * 0.8)},${Math.round(base * 0.92)},${Math.round(base * 1.15)})`;
    g.fillRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);

    g.setTransform(LS, 0, 0, LS, 0, 0);
    g.globalCompositeOperation = 'lighter';
    for (const light of level.lights) {
      if (!light.alive || !light.poly) continue;
      const flick = 0.93 + 0.07 * Math.sin(this.time * 7 + light.flicker * 5);
      const r = light.radius;
      const i = light.power * flick;
      const grad = g.createRadialGradient(light.x, light.y, 4, light.x, light.y, r);
      grad.addColorStop(0, `rgba(255,246,214,${0.95 * i})`);
      grad.addColorStop(0.42, `rgba(255,232,180,${0.42 * i})`);
      grad.addColorStop(1, 'rgba(255,220,160,0)');
      g.save();
      tracePoly(g, light.x, light.y, light.poly, r);
      g.clip();
      g.fillStyle = grad;
      g.fillRect(light.x - r, light.y - r, r * 2, r * 2);
      g.restore();
    }
    // Dark-adapted eyes: a whisper of light around the operative.
    const pr = player.nvOn ? 190 : 132;
    const pg = g.createRadialGradient(player.x, player.y, 2, player.x, player.y, pr);
    pg.addColorStop(0, 'rgba(130,180,205,0.42)');
    pg.addColorStop(1, 'rgba(130,180,205,0)');
    g.fillStyle = pg;
    g.fillRect(player.x - pr, player.y - pr, pr * 2, pr * 2);
    this.lightTex.needsUpdate = true;
  }

  paintFog(game) {
    const g = this.fctx;
    const { player } = game;
    const radius = game.sightRadius;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    if (!player.alive) { this.fogTex.needsUpdate = true; return; }

    g.setTransform(LS, 0, 0, LS, 0, 0);
    g.globalCompositeOperation = 'lighter';
    const grad = (r, gg) => {
      const gr = g.createRadialGradient(player.x, player.y, 8, player.x, player.y, radius);
      gr.addColorStop(0, `rgba(${r},${gg},0,1)`);
      gr.addColorStop(0.62, `rgba(${r},${gg},0,1)`);
      gr.addColorStop(0.86, `rgba(${r},${gg},0,0.75)`);
      gr.addColorStop(1, `rgba(${r},${gg},0,0)`);
      return gr;
    };
    // R: floor-level sight, exactly the 2D polygon.
    g.fillStyle = grad(255, 0);
    tracePoly(g, player.x, player.y, game.playerPoly, radius);
    g.fill();
    // G: the same polygon grown by most of a tile, so the walls that bound
    // what you can see light up along with the floor in front of them.
    const gg = grad(0, 255);
    g.fillStyle = gg;
    g.strokeStyle = gg;
    g.lineWidth = T * 1.1;
    g.lineJoin = 'round';
    tracePoly(g, player.x, player.y, game.playerPoly, radius);
    g.fill();
    g.stroke();
    this.fogTex.needsUpdate = true;
  }

  // ------------------------------------------------------------- frame
  draw(game, dt) {
    if (!this.level || game.level !== this.level) this.buildStatic(game.level);
    if (this.game !== game) {
      this.buildEntities(game);
      this.snapCamera(game);
    }
    this.time += dt;
    const t = this.time;
    const { player, level } = game;

    this.paintLight(game);
    this.paintFog(game);
    this.shared.uNV.value = player.nvOn ? 1 : 0;

    // ---- camera
    const look = new THREE.Vector3(W(player.x), 0.3, W(player.y));
    if (!game.usingTouch) {
      look.x += Math.cos(player.angle) * 0.6;
      look.z += Math.sin(player.angle) * 0.6;
    }
    this.placeCamera(look, false, Math.max(dt, 1 / 120));

    // ---- x-ray window around the operative
    const pp = new THREE.Vector3(W(player.x), 0.5, W(player.y));
    const pv = pp.clone().applyMatrix4(this.camera.matrixWorldInverse);
    this.shared.uPlayerZ.value = pv.z;
    const ndc = pp.clone().project(this.camera);
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    this.shared.uPlayerPx.value.set((ndc.x * 0.5 + 0.5) * bw, (ndc.y * 0.5 + 0.5) * bh);
    this.shared.uXrayR.value = 0.11 * bh / this.userZoom;

    this.updateWorld(game, t);
    this.updatePlayer(game, dt, t);
    this.updateGuards(game, dt, t);
    this.updateCams(game, t);
    this.updateFx(game, t);
    this.updateOverlays(game);

    this.gl.render(this.scene, this.camera);
    this.drawMinimap(game);
  }

  snapCamera(game) {
    const p = game.player;
    this.placeCamera(new THREE.Vector3(W(p.x), 0.3, W(p.y)), true, 0);
  }

  updateWorld(game, t) {
    for (const dm of this.doorMeshes) {
      const d = dm.door;
      for (const leaf of dm.leaves) {
        const s = leaf.userData.side;
        leaf.position.x = s * (0.25 + d.openAmt * 0.48);
      }
      // A keycard unlock turns the amber leaves back to the ordinary blue.
      if (!d.locked && dm.leafMat.userData.locked !== false) {
        dm.leafMat.uniforms.uColor.value.set(0x4a6578);
        dm.stripMat.uniforms.uEmissive.value.set(0x5fd0ff);
        dm.leafMat.userData.locked = false;
      }
    }
    for (const lm of this.lampMeshes) {
      const li = lm.light;
      const flick = 0.93 + 0.07 * Math.sin(t * 7 + li.flicker * 5);
      lm.shaft.visible = li.alive;
      lm.bulbMat.uniforms.uEmissive.value.setRGB(li.alive ? flick : 0.05, li.alive ? flick * 0.94 : 0.05, li.alive ? flick * 0.78 : 0.06);
      lm.shaftMat.uniforms.uAlpha.value = 0.09 * flick;
    }
    for (const tm of this.terminalMeshes) {
      const tr = tm.term;
      const blink = tr.hacked ? 1 : 0.45 + 0.55 * Math.sin(t * 4 + tr.x);
      tm.screenMat.uniforms.uEmissive.value.set(tr.hacked ? 0x59ff9e : 0x6ec8ff).multiplyScalar(0.35 + 0.65 * blink);
      tm.ringMat.uniforms.uProg.value = tr.progress;
      tm.ringMat.uniforms.uTrack.value = tr.progress > 0 && !tr.hacked ? 0.3 : 0;
      tm.ringMat.uniforms.uAlpha.value = tr.progress > 0 && !tr.hacked ? 0.95 : 0;
    }
    for (const pm of this.pickupMeshes) {
      pm.grp.visible = !pm.pickup.taken;
      pm.mesh.position.y = 0.32 + Math.sin(t * 2.5 + pm.pickup.x) * 0.05;
      pm.mesh.rotation.y = t * 1.6;
    }
    const ex = this.exitMesh;
    const active = game.objectivesDone;
    const pulse = 0.5 + 0.5 * Math.sin(t * (active ? 3.5 : 1.4));
    ex.rings.forEach((r, i) => {
      r.scale.setScalar(1 + pulse * 0.12);
      r.material.uniforms.uColor.value.set(active ? 0x59ff9e : 0x788ca0);
      r.material.uniforms.uAlpha.value = active ? 0.45 + 0.5 * pulse - i * 0.1 : 0.3;
    });
    ex.labelMat.color.set(active ? 0x59ff9e : 0x788ca0);
    ex.labelMat.opacity = active ? 0.95 : 0.45;
    ex.beamMat.uniforms.uAlpha.value = active ? 0.22 + 0.1 * pulse : 0;
  }

  animateWalk(m, x, z, dt) {
    const moved = Math.hypot(x - m.lastX, z - m.lastZ);
    m.lastX = x;
    m.lastZ = z;
    const speed = dt > 0 ? moved / dt : 0;
    if (speed > 0.2) m.walk += moved * 9;
    const amp = clamp(speed / 3, 0, 1) * 0.55;
    m.legs[0].rotation.z = Math.sin(m.walk) * amp;
    m.legs[1].rotation.z = -Math.sin(m.walk) * amp;
    m.pivot.position.y = Math.abs(Math.sin(m.walk)) * amp * 0.06;
  }

  updatePlayer(game, dt, t) {
    const p = game.player;
    const m = this.playerModel;
    const x = W(p.x);
    const z = W(p.y);
    m.root.visible = p.alive;
    m.root.position.set(x, 0, z);
    m.root.rotation.y = -p.angle;
    const crouch = p.stance === 'crouch';
    const sy = (crouch ? 0.7 : 1) * m.base;
    m.root.scale.y += (sy - m.root.scale.y) * Math.min(1, dt * 14);
    this.animateWalk(m, x, z, dt);
    m.gogMat.uniforms.uEmissive.value.set(p.nvOn ? 0x59ff9e : 0x2a8a55);
    const hurt = p.hurtFlash;
    m.bodyMat.uniforms.uEmissive.value.setRGB(hurt * 0.5, 0, hurt * 0.08);

    m.ring.position.set(x, 0.025, z);
    m.ring.material.uniforms.uAlpha.value = 0.18 + 0.08 * Math.sin(t * 2.2);

    // Desktop: show where the cursor actually lands, and a faint laser.
    const showAim = !game.usingTouch && p.alive;
    m.aimLine.visible = showAim;
    m.aimMark.visible = showAim;
    if (showAim) {
      const a = p.angle;
      const pos = m.aimLine.geometry.attributes.position;
      pos.setXYZ(0, x + Math.cos(a) * 0.4, AIM_Y, z + Math.sin(a) * 0.4);
      pos.setXYZ(1, x + Math.cos(a) * 3.2, AIM_Y, z + Math.sin(a) * 3.2);
      pos.needsUpdate = true;
      const inputMouse = window.NIGHT_ECHO?.input?.mouse;
      if (inputMouse) {
        const w = this.screenToWorld(inputMouse.x, inputMouse.y);
        const snap = this.aimSnap;
        const y = !snap ? 0.04 : snap.kind === 'light' ? WALL_H + 0.28 : snap.kind === 'cam' ? WALL_H - 0.15 : 0.04;
        m.aimMark.position.set(W(w.x), y, W(w.y));
        m.aimMark.scale.setScalar(snap ? 2.6 : 1);
        m.aimMark.material.depthTest = !snap;
        m.aimMark.material.uniforms.uColor.value.set(!snap ? 0x9fe8ff : snap.kind === 'guard' ? 0xff7878 : snap.kind === 'cam' ? 0xffbe5a : 0xfff0b4);
        m.aimMark.material.uniforms.uDashPhase.value = t * 0.5;
        if (snap) {
          const pos = m.aimLine.geometry.attributes.position;
          pos.setXYZ(1, W(w.x), AIM_Y, W(w.y));
          pos.needsUpdate = true;
        }
      }
    }
  }

  updateGuards(game, dt, t) {
    const cam = this.camera;
    game.guards.forEach((g, i) => {
      const m = this.guardModels[i];
      const x = W(g.x);
      const z = W(g.y);
      m.root.position.set(x, 0, z);
      m.root.rotation.y = -g.angle;
      const alert = g.state === GUARD_STATE.ALERT;
      const search = g.state === GUARD_STATE.SEARCH;
      const susp = g.state === GUARD_STATE.SUSPECT || g.state === GUARD_STATE.INVESTIGATE;
      m.bodyMat.uniforms.uColor.value.set(alert ? 0xc8465a : search ? 0xc07a3a : susp ? 0xc0a13a : 0x4d6a7d);
      const trim = alert ? 0xff8a9a : susp || search ? 0xffd98a : 0x9fc4d8;
      m.trimMat.uniforms.uColor.value.set(trim);
      m.headMat.uniforms.uColor.value.set(trim);

      if (g.down) {
        // Fall over backwards, then lie still.
        const k = clamp(g.downFade ?? 1, 0, 1);
        m.pivot.rotation.z = (Math.PI / 2) * Math.min(1, k * 1.4);
        m.pivot.position.y = 0.12 * k;
        m.legs.forEach((l) => { l.rotation.z = 0; });
      } else {
        m.pivot.rotation.z = 0;
        this.animateWalk(m, x, z, dt);
      }

      // vision cone
      m.cone.visible = !g.down;
      if (!g.down) {
        const suspCone = g.detect > 0.25 || g.state === GUARD_STATE.SUSPECT;
        m.coneMat.uniforms.uColor.value.set(alert ? 0xff465a : suspCone ? 0xffbe46 : 0x96dcff);
        m.coneMat.uniforms.uAlpha.value = alert ? 0.34 : 0.19;
        this.updateFan(m.cone, g.x, g.y, g.getCone(), g.viewRange, g.angle - g.viewFov / 2, g.viewFov);
      }

      const seen = game.canPlayerSee(g.x, g.y);

      // detection meter — a billboard arc over the head
      m.meter.visible = !g.down && g.detect > 0.02 && seen;
      if (m.meter.visible) {
        m.meter.position.set(x, 1.15, z);
        m.meter.quaternion.copy(cam.quaternion);
        m.meterMat.uniforms.uProg.value = clamp(g.detect, 0, 1);
        m.meterMat.uniforms.uColor.value.set(g.detect > 0.75 ? 0xff5468 : g.detect > 0.4 ? 0xffb14d : 0xffe98a);
      }

      // speech bubble ("?", "!?")
      const b = g.bubble;
      m.bubble.visible = !g.down && !!b && b.t > 0 && seen;
      if (m.bubble.visible) {
        this.setSpriteText(m.bubble, b.text, alert ? '#ff6a7a' : '#ffd24d');
        m.bubble.position.set(x, 1.35 + (1 - b.t) * 0.2, z);
        m.bubble.material.opacity = clamp(b.t * 1.5, 0, 1);
      }

      // Alerted guards stay pinned through walls — you can hear them yelling.
      m.alertMark.visible = !g.down && (alert || search) && !m.bubble.visible;
      if (m.alertMark.visible) {
        this.setSpriteText(m.alertMark, '!', alert ? '#ff5468' : '#ffb14d');
        m.alertMark.position.set(x, 1.45 + Math.sin(t * 8) * 0.06, z);
      }

      m.zzz.visible = g.down && seen;
      if (m.zzz.visible) {
        const ph = (t * 0.8 + i * 0.37) % 1;
        m.zzz.position.set(x + 0.2, 0.45 + ph * 0.5, z - 0.2);
        m.zzz.material.opacity = 0.7 * (1 - ph);
      }
    });
  }

  updateCams(game, t) {
    for (const cm of this.camModels) {
      const c = cm.cam;
      cm.tilt.rotation.y = -c.angle;
      cm.cone.visible = c.alive;
      if (c.alive) {
        const hot = c.detect > 0.05;
        cm.lensMat.uniforms.uEmissive.value.set(hot ? 0xff5468 : 0x59ff9e);
        cm.coneMat.uniforms.uColor.value.set(hot ? 0xff5a6e : 0x8cffd2);
        cm.coneMat.uniforms.uAlpha.value = hot ? 0.32 : 0.16;
        this.updateFan(cm.cone, c.x, c.y, c.getCone(), c.range, c.angle - c.fov / 2, c.fov);
      } else {
        cm.lensMat.uniforms.uEmissive.value.set(0x202428);
        cm.head.rotation.z = -0.9;
      }
      cm.sparks.visible = !c.alive && c.sparks > 0;
      if (cm.sparks.visible) {
        const pos = cm.sparks.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const ph = (t * 1.7 + i * 0.13) % 1;
          pos.setXYZ(i, W(c.x) + Math.sin(i * 12.9) * 0.3 * ph, WALL_H - 0.15 - ph * 0.9, W(c.y) + Math.cos(i * 7.3) * 0.3 * ph);
        }
        pos.needsUpdate = true;
        cm.sparks.material.opacity = c.sparks;
      }
    }
  }

  updateFx(game, t) {
    // tracers
    this.tracerPool.forEach((l, i) => {
      const tr = game.tracers[i];
      l.visible = !!tr;
      if (!tr) return;
      const pos = l.geometry.attributes.position;
      pos.setXYZ(0, W(tr.x0), AIM_Y, W(tr.y0));
      pos.setXYZ(1, W(tr.x1), AIM_Y, W(tr.y1));
      pos.needsUpdate = true;
      l.material.color.set(tr.hostile ? 0xff785a : 0xb4f0ff);
      l.material.opacity = tr.life / tr.maxLife;
    });
    // bottles
    this.bottlePool.forEach((m, i) => {
      const b = game.bottlesInFlight[i];
      m.visible = !!b;
      if (!b) return;
      m.position.set(W(b.x), 0.3 + W(b.h) * 1.6, W(b.y));
      m.rotation.set(b.spin, 0, b.spin * 0.6);
    });
    // noise pings
    this.noisePool.forEach((r, i) => {
      const n = game.noiseRings[i];
      r.visible = !!n;
      if (!n) return;
      const k = 1 - n.life / n.maxLife;
      const rad = Math.max(0.05, W(n.radius) * k);
      r.position.set(W(n.x), 0.05, W(n.y));
      r.scale.setScalar(rad);
      r.material.uniforms.uAlpha.value = (1 - k) * 0.55;
    });
    // touch lock-on
    const lock = game.lockTarget;
    this.lockReticle.visible = !!lock;
    this.lockLine.visible = !!lock;
    if (lock) {
      const o = lock.obj;
      const col = lock.kind === 'guard' ? 0xff7878 : lock.kind === 'cam' ? 0xffbe5a : 0xfff0b4;
      const y = lock.kind === 'guard' ? 0 : lock.kind === 'cam' ? WALL_H - 0.2 : WALL_H + 0.25;
      this.lockReticle.position.set(W(o.x), y, W(o.y));
      this.lockReticle.rotation.y = t * 1.4;
      this.lockReticle.traverse((c) => {
        if (c.material?.uniforms) c.material.uniforms.uColor.value.set(col);
        else if (c.material?.color) c.material.color.set(col);
      });
      const p = game.player;
      const pos = this.lockLine.geometry.attributes.position;
      pos.setXYZ(0, W(p.x), AIM_Y, W(p.y));
      pos.setXYZ(1, W(o.x), y + (lock.kind === 'guard' ? AIM_Y : 0), W(o.y));
      pos.needsUpdate = true;
      this.lockLine.material.color.set(col);
    }
    // last known position
    const mk = game.lastKnownMarker;
    this.lastKnown.visible = !!mk;
    if (mk) {
      this.lastKnown.position.set(W(mk.x), 0.06, W(mk.y));
      this.lastKnown.material.uniforms.uAlpha.value = clamp(mk.life / 3, 0, 0.8);
      this.lastKnown.material.uniforms.uDashPhase.value = t * 0.3;
    }
  }

  updateOverlays(game) {
    const p = game.player;
    if (this.overlay.nv) this.overlay.nv.classList.toggle('on', p.nvOn);
    if (this.overlay.hurt) {
      const a = Math.max(p.hurtFlash * 0.9, p.health < 45 ? (45 - p.health) / 45 * 0.55 : 0);
      this.overlay.hurt.style.opacity = a.toFixed(3);
    }
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

    // camera footprint (a trapezoid in the tilted view)
    const fp = this.groundFootprint();
    if (fp.length === 4) {
      g.strokeStyle = 'rgba(255,255,255,0.22)';
      g.lineWidth = 1;
      g.beginPath();
      fp.forEach((q, i) => (i ? g.lineTo(px(q.x), py(q.y)) : g.moveTo(px(q.x), py(q.y))));
      g.closePath();
      g.stroke();
    }

    for (const t of game.level.terminals) {
      g.fillStyle = t.hacked ? '#59ff9e' : '#6ec8ff';
      g.fillRect(px(t.x) - 2, py(t.y) - 2, 4, 4);
    }
    const e = game.level.extraction;
    g.fillStyle = game.objectivesDone ? '#59ff9e' : 'rgba(120,140,160,0.6)';
    g.fillRect(px(e.x) - 3, py(e.y) - 3, 6, 6);

    for (const gd of game.guards) {
      if (gd.down) g.fillStyle = 'rgba(140,150,160,0.6)';
      else if (gd.state === GUARD_STATE.ALERT || gd.state === GUARD_STATE.SEARCH) g.fillStyle = '#ff5468';
      else if (game.canPlayerSee(gd.x, gd.y)) g.fillStyle = '#ffb14d';
      else continue;
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

export default Renderer;
