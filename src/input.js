// Keyboard + mouse + touch input, normalised into a tiny polled API.

const MOVE_KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};

class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.mouse = { x: 480, y: 272, down: false, clicked: false, moved: false };
    this.touch = {
      active: false, dx: 0, dy: 0, mag: 0,
      buttons: new Set(), pressed: new Set(), toggles: new Set(),
    };
    this.canvas = null;
    this.blockKeys = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
    ]);
  }

  attach(canvas) {
    this.canvas = canvas;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (this.blockKeys.has(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => {
      this.down.clear();
      this.mouse.down = false;
    });

    const toCanvas = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((clientX - r.left) / r.width) * canvas.width,
        y: ((clientY - r.top) / r.height) * canvas.height,
      };
    };

    canvas.addEventListener('mousemove', (e) => {
      const p = toCanvas(e.clientX, e.clientY);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      this.mouse.moved = true;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.mouse.down = true;
      this.mouse.clicked = true;
    });
    addEventListener('mouseup', () => { this.mouse.down = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Wire up the on-screen controls.
   *
   * The stick has a floating origin: it appears wherever the thumb lands in
   * the stick zone, which is far more forgiving than a fixed circle you have
   * to find without looking. Buttons marked data-toggle latch instead of
   * needing to be held, since you cannot hold a button and steer at once.
   */
  attachTouch(root) {
    const zone = root.querySelector('#stickZone');
    const stick = root.querySelector('#stick');
    const knob = root.querySelector('.stick-knob');
    const R = 60;             // thumb travel for full deflection, in client px
    let id = null;
    let cx = 0;
    let cy = 0;
    let stageScale = 1;

    const setKnob = (dx, dy) => {
      const len = Math.hypot(dx, dy);
      const k = len > R ? R / len : 1;
      // The ring lives inside the scaled stage; undo the scale so the knob
      // stays exactly under the finger.
      const s = 1 / (stageScale || 1);
      knob.style.transform = `translate(${dx * k * s}px, ${dy * k * s}px)`;
      const nl = Math.min(len / R, 1);
      if (len > 7) {
        this.touch.dx = (dx / len) * nl;
        this.touch.dy = (dy / len) * nl;
        this.touch.mag = nl;
      } else {
        this.touch.dx = this.touch.dy = 0;
        this.touch.mag = 0;
      }
    };

    // The stage is transform-scaled, so client coords have to be converted
    // into stage-local pixels before positioning the ring.
    const place = (clientX, clientY) => {
      cx = clientX;
      cy = clientY;
      const host = zone.offsetParent || zone;
      const rect = host.getBoundingClientRect();
      stageScale = rect.width / (host.offsetWidth || rect.width) || 1;
      stick.style.left = `${(clientX - rect.left) / stageScale}px`;
      stick.style.top = `${(clientY - rect.top) / stageScale}px`;
      stick.classList.add('live');
    };

    const clear = () => {
      id = null;
      this.touch.dx = this.touch.dy = 0;
      this.touch.mag = 0;
      this.touch.active = false;
      knob.style.transform = 'translate(0,0)';
      stick.classList.remove('live');
    };

    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (id !== null) return;
      const t = e.changedTouches[0];
      id = t.identifier;
      this.touch.active = true;
      place(t.clientX, t.clientY);
      setKnob(0, 0);
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === id) setKnob(t.clientX - cx, t.clientY - cy);
      }
    }, { passive: false });

    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) clear();
    };
    zone.addEventListener('touchend', end, { passive: false });
    zone.addEventListener('touchcancel', end, { passive: false });

    // Mouse fallback so the mobile build is still playable (and testable) when
    // it is forced on in a pointer browser.
    let mouseStick = false;
    zone.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mouseStick = true;
      id = 'mouse';
      this.touch.active = true;
      place(e.clientX, e.clientY);
      setKnob(0, 0);
    });
    addEventListener('mousemove', (e) => {
      if (mouseStick) setKnob(e.clientX - cx, e.clientY - cy);
    });
    addEventListener('mouseup', () => {
      if (!mouseStick) return;
      mouseStick = false;
      clear();
    });

    root.querySelectorAll('.tbtn').forEach((btn) => {
      const act = btn.dataset.act;
      const latch = btn.dataset.toggle === 'true';
      const press = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.touch.pressed.add(act);
        if (latch) {
          if (this.touch.toggles.has(act)) this.touch.toggles.delete(act);
          else this.touch.toggles.add(act);
          btn.classList.toggle('on', this.touch.toggles.has(act));
        } else {
          this.touch.buttons.add(act);
          btn.classList.add('on');
        }
        if (navigator.vibrate) navigator.vibrate(8);
      };
      const lift = (e) => {
        e.preventDefault();
        if (!latch) {
          this.touch.buttons.delete(act);
          btn.classList.remove('on');
        }
      };
      btn.addEventListener('touchstart', press, { passive: false });
      btn.addEventListener('touchend', lift, { passive: false });
      btn.addEventListener('touchcancel', lift, { passive: false });
      // Desktop browsers in mobile mode (and devtools emulation) get clicks.
      btn.addEventListener('mousedown', press);
      btn.addEventListener('mouseup', lift);
      btn.addEventListener('mouseleave', lift);
    });
  }

  /** Reset latched buttons — called when a mission starts. */
  clearToggles() {
    this.touch.toggles.clear();
    this.touch.buttons.clear();
    document.querySelectorAll('.tbtn.on').forEach((b) => b.classList.remove('on'));
  }

  isDown(...codes) {
    return codes.some((c) => this.down.has(c));
  }
  wasPressed(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  /** Movement vector, magnitude <= 1. */
  axis() {
    let x = 0;
    let y = 0;
    if (this.isDown(...MOVE_KEYS.left)) x -= 1;
    if (this.isDown(...MOVE_KEYS.right)) x += 1;
    if (this.isDown(...MOVE_KEYS.up)) y -= 1;
    if (this.isDown(...MOVE_KEYS.down)) y += 1;
    if (x || y) {
      const l = Math.hypot(x, y);
      return { x: x / l, y: y / l };
    }
    if (this.touch.dx || this.touch.dy) return { x: this.touch.dx, y: this.touch.dy };
    return { x: 0, y: 0 };
  }

  touchDown(act) {
    return this.touch.buttons.has(act);
  }
  touchPressed(act) {
    return this.touch.pressed.has(act);
  }
  touchToggled(act) {
    return this.touch.toggles.has(act);
  }

  endFrame() {
    this.pressed.clear();
    this.touch.pressed.clear();
    this.mouse.clicked = false;
    this.mouse.moved = false;
  }
}

export const input = new Input();
export default input;
