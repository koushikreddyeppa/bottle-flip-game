/* ============================================================
   BOTTLE FLIP – audio.js
   Web Audio API synthesizer – zero dependencies, offline-first
   ============================================================ */

'use strict';

class SoundController {
  constructor() {
    this.ctx   = null;
    this.muted = false;

    // Restore mute preference across sessions
    const saved = localStorage.getItem('bottle_flip_muted');
    if (saved !== null) this.muted = saved === 'true';
  }

  /* Lazy-init AudioContext on first user gesture */
  _init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('bottle_flip_muted', this.muted);
    return this.muted;
  }

  isMuted() { return this.muted; }

  /* ── Whoosh – bottle launch ── */
  playFlip(power = 1) {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // Noise burst
    const buf  = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.28), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const noise  = this.ctx.createBufferSource(); noise.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(280, t);
    filter.frequency.exponentialRampToValueAtTime(1100 * power, t + 0.11);
    filter.frequency.exponentialRampToValueAtTime(380, t + 0.26);
    filter.Q.value = 3;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.07);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.27);

    // Water slosh tone
    const osc = this.ctx.createOscillator();
    const og  = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.1);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.22);
    og.gain.setValueAtTime(0.14, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.23);

    noise.connect(filter); filter.connect(gain); gain.connect(this.ctx.destination);
    osc.connect(og); og.connect(this.ctx.destination);

    noise.start(t); noise.stop(t + 0.28);
    osc.start(t);   osc.stop(t + 0.24);
  }

  /* ── Chime – upright landing ── */
  playLand(streak = 1) {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // Thud
    const thud = this.ctx.createOscillator();
    const tg   = this.ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(155, t);
    thud.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    tg.gain.setValueAtTime(0.55, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    thud.connect(tg); tg.connect(this.ctx.destination);
    thud.start(t); thud.stop(t + 0.11);

    // Chime – rises with streak
    const base  = 523.25; // C5
    const semis = [0, 4, 7, 12, 16];
    const freq  = base * Math.pow(2, semis[Math.min(streak - 1, semis.length - 1)] / 12);
    const chime = this.ctx.createOscillator();
    const cg    = this.ctx.createGain();
    chime.type = 'sine';
    chime.frequency.value = freq;
    cg.gain.setValueAtTime(0.01, t);
    cg.gain.setValueAtTime(0.28, t + 0.05);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    chime.connect(cg); cg.connect(this.ctx.destination);
    chime.start(t + 0.05); chime.stop(t + 0.4);
  }

  /* ── Clatter – fail / fall ── */
  playCrash() {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    [0, 0.09, 0.19].forEach((delay, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(260 - i * 55 + Math.random() * 35, t + delay);
      o.frequency.exponentialRampToValueAtTime(75, t + delay + 0.08);
      g.gain.setValueAtTime(0.3 / (i + 1), t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.09);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t + delay); o.stop(t + delay + 0.1);
    });

    // Sad slide
    const sad = this.ctx.createOscillator();
    const sg  = this.ctx.createGain();
    sad.type = 'sine';
    sad.frequency.setValueAtTime(220, t + 0.12);
    sad.frequency.exponentialRampToValueAtTime(105, t + 0.44);
    sg.gain.setValueAtTime(0.2, t + 0.12);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    sad.connect(sg); sg.connect(this.ctx.destination);
    sad.start(t + 0.12); sad.stop(t + 0.46);
  }

  /* ── Fanfare – new high score ── */
  playFanfare() {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => {
      const ts = t + i * 0.09;
      const o  = this.ctx.createOscillator();
      const g  = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.26, ts);
      g.gain.exponentialRampToValueAtTime(0.001, ts + 0.32);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(ts); o.stop(ts + 0.34);
    });
  }

  /* ── UI pop ── */
  playPop() {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(820, t + 0.05);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + 0.08);
  }

  /* ── Charge hum – pitch rises smoothly as spacebar is held ── */
  startCharge() {
    if (this.muted) return;
    this._init();
    if (!this.ctx) return;
    this.stopCharge();
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, t);
      osc.frequency.exponentialRampToValueAtTime(640, t + 1.2);
      g.gain.setValueAtTime(0.01, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.12);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(t);
      this._chargeOsc = osc;
      this._chargeGain = g;
    } catch (e) {}
  }

  stopCharge() {
    if (this._chargeOsc) {
      try {
        const t = this.ctx ? this.ctx.currentTime : 0;
        if (this._chargeGain && this.ctx) {
          this._chargeGain.gain.setValueAtTime(this._chargeGain.gain.value, t);
          this._chargeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        }
        this._chargeOsc.stop(t + 0.06);
      } catch (e) {}
      this._chargeOsc = null;
      this._chargeGain = null;
    }
  }
}

window.soundCtrl = new SoundController();
