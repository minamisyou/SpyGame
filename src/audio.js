// Procedural audio — everything is synthesised, so the build ships no binaries.

class AudioKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuffer = null;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this.enabled = false;
      return;
    }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 1.2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  get t() {
    return this.ctx.currentTime;
  }

  _ok() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  tone({ freq = 440, to = null, type = 'sine', dur = 0.15, gain = 0.2, delay = 0, attack = 0.005 }) {
    if (!this._ok()) return;
    const t0 = this.t + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.12, gain = 0.2, freq = 1200, q = 1, type = 'bandpass', delay = 0, sweepTo = null }) {
    if (!this._ok()) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filt.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    filt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // --------------------------------------------------------------- cues
  step(running, crouching) {
    if (crouching) return;
    this.noise({ dur: 0.05, gain: running ? 0.13 : 0.06, freq: running ? 900 : 550, q: 1.4 });
  }
  dart() {
    this.noise({ dur: 0.07, gain: 0.16, freq: 2600, q: 0.7, sweepTo: 500 });
    this.tone({ freq: 320, to: 120, type: 'triangle', dur: 0.08, gain: 0.08 });
  }
  glass() {
    this.noise({ dur: 0.35, gain: 0.22, freq: 5200, q: 0.6, sweepTo: 1400 });
    for (let i = 0; i < 4; i++) {
      this.tone({ freq: 2400 + Math.random() * 2600, type: 'triangle', dur: 0.09, gain: 0.05, delay: i * 0.045 });
    }
  }
  bottle() {
    this.noise({ dur: 0.22, gain: 0.2, freq: 3200, q: 0.8, sweepTo: 800 });
  }
  takedown() {
    this.noise({ dur: 0.16, gain: 0.25, freq: 240, q: 0.9, type: 'lowpass' });
    this.tone({ freq: 90, to: 40, type: 'sine', dur: 0.2, gain: 0.2 });
  }
  hit() {
    this.noise({ dur: 0.1, gain: 0.28, freq: 400, q: 1, type: 'lowpass' });
    this.tone({ freq: 160, to: 60, type: 'sawtooth', dur: 0.16, gain: 0.12 });
  }
  gunshot() {
    this.noise({ dur: 0.18, gain: 0.3, freq: 1800, q: 0.4, sweepTo: 200 });
  }
  beep(high = false) {
    this.tone({ freq: high ? 1400 : 880, type: 'square', dur: 0.06, gain: 0.06 });
  }
  door() {
    this.noise({ dur: 0.3, gain: 0.08, freq: 380, q: 2, sweepTo: 160 });
  }
  pickup() {
    this.tone({ freq: 660, to: 1320, type: 'triangle', dur: 0.14, gain: 0.12 });
  }
  suspicious() {
    this.tone({ freq: 300, to: 520, type: 'sawtooth', dur: 0.35, gain: 0.07 });
  }
  alert() {
    this.tone({ freq: 220, to: 880, type: 'sawtooth', dur: 0.5, gain: 0.16 });
    this.tone({ freq: 110, to: 440, type: 'square', dur: 0.6, gain: 0.1, delay: 0.05 });
  }
  alarm() {
    for (let i = 0; i < 3; i++) {
      this.tone({ freq: 740, to: 380, type: 'square', dur: 0.32, gain: 0.13, delay: i * 0.38 });
    }
  }
  hackDone() {
    [523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ freq: f, type: 'triangle', dur: 0.22, gain: 0.11, delay: i * 0.08 }));
  }
  win() {
    [392, 523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.13, delay: i * 0.13 }));
  }
  lose() {
    [440, 349, 262, 175].forEach((f, i) =>
      this.tone({ freq: f, type: 'sawtooth', dur: 0.6, gain: 0.12, delay: i * 0.18 }));
  }
  nvg(on) {
    this.tone({ freq: on ? 900 : 500, to: on ? 1500 : 260, type: 'sine', dur: 0.18, gain: 0.07 });
  }
}

export const audio = new AudioKit();
export default audio;
