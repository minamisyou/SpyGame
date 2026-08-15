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
    this.touch = { active: false, dx: 0, dy: 0, buttons: new Set(), pressed: new Set() };
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

  /** Wire up the on-screen stick + buttons for touch devices. */
  attachTouch(root) {
    const stick = root.querySelector('#stick');
    const knob = root.querySelector('.stick-knob');
    const R = 44;
    let id = null;
    let cx = 0;
    let cy = 0;

    const set = (dx, dy) => {
      const len = Math.hypot(dx, dy);
      const k = len > R ? R / len : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      const nl = Math.min(len / R, 1);
      if (len > 6) {
        this.touch.dx = (dx / len) * nl;
        this.touch.dy = (dy / len) * nl;
      } else {
        this.touch.dx = this.touch.dy = 0;
      }
    };

    stick.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      id = t.identifier;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      set(t.clientX - cx, t.clientY - cy);
    }, { passive: false });

    stick.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === id) set(t.clientX - cx, t.clientY - cy);
      }
    }, { passive: false });

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === id) {
          id = null;
          this.touch.dx = this.touch.dy = 0;
          knob.style.transform = 'translate(0,0)';
        }
      }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);

    root.querySelectorAll('.tbtn').forEach((btn) => {
      const act = btn.dataset.act;
      const on = (e) => {
        e.preventDefault();
        this.touch.buttons.add(act);
        this.touch.pressed.add(act);
      };
      const off = (e) => {
        e.preventDefault();
        this.touch.buttons.delete(act);
      };
      btn.addEventListener('touchstart', on, { passive: false });
      btn.addEventListener('touchend', off, { passive: false });
      btn.addEventListener('touchcancel', off, { passive: false });
    });
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

  endFrame() {
    this.pressed.clear();
    this.touch.pressed.clear();
    this.mouse.clicked = false;
    this.mouse.moved = false;
  }
}

export const input = new Input();
export default input;
