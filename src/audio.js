// All sound is synthesized with WebAudio — no audio files.
export class Sound {
  constructor() { this.ctx = null; this.sfxOn = true; this.musicOn = true; this.step = 0; this.nextTime = 0; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const c = (this.ctx = new C());
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    comp.connect(c.destination);
    this.master = c.createGain(); this.master.gain.value = 0.9; this.master.connect(comp);
    this.sfx = c.createGain(); this.sfx.gain.value = this.sfxOn ? 1 : 0; this.sfx.connect(this.master);
    this.music = c.createGain(); this.music.gain.value = this.musicOn ? 0.3 : 0; this.music.connect(this.master);

    // noise buffer
    const len = c.sampleRate * 2, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = b;

    // music delay bus
    this.delay = c.createDelay(1); this.delay.delayTime.value = 60 / 112 * 0.75;
    const fb = c.createGain(); fb.gain.value = 0.35;
    const dl = c.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2200;
    this.delay.connect(dl); dl.connect(fb); fb.connect(this.delay); dl.connect(this.music);

    // engine
    this.engGain = c.createGain(); this.engGain.gain.value = 0;
    this.engFilter = c.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.Q.value = 3;
    this.engFilter.connect(this.engGain); this.engGain.connect(this.sfx);
    const mk = (type, det) => { const o = c.createOscillator(); o.type = type; o.detune.value = det; o.connect(this.engFilter); o.start(); return o; };
    this.o1 = mk('sawtooth', 0); this.o2 = mk('square', -1200); this.o3 = mk('sawtooth', 7);
    // wind
    const w = c.createBufferSource(); w.buffer = this.noiseBuf; w.loop = true;
    this.windF = c.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.6; this.windF.frequency.value = 800;
    this.windG = c.createGain(); this.windG.gain.value = 0;
    w.connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.sfx); w.start();

    this.nextTime = c.currentTime + 0.1;
    this._timer = setInterval(() => this._schedule(), 25);
  }

  setSfx(on) { this.sfxOn = on; if (this.sfx) this.sfx.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05); }
  setMusic(on) { this.musicOn = on; if (this.music) this.music.gain.setTargetAtTime(on ? 0.3 : 0, this.ctx.currentTime, 0.1); }
  duck(amount, time = 1.5) {
    if (!this.ctx || !this.musicOn) return;
    const g = this.music.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t); g.setTargetAtTime(0.3 * amount, t, 0.05); g.setTargetAtTime(0.3, t + time, 0.6);
  }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // speed in m/s
  engine(speed, nitro, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gearSpan = 21, gear = Math.min(6, Math.floor(speed / gearSpan));
    const rpm = (speed - gear * gearSpan) / gearSpan;
    const f = 55 + rpm * 85 + gear * 9 + (nitro ? 25 : 0);
    for (const o of [this.o1, this.o2, this.o3]) o.frequency.setTargetAtTime(f, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(380 + speed * 14 + (nitro ? 900 : 0), t, 0.08);
    this.engGain.gain.setTargetAtTime(on ? 0.075 + (nitro ? 0.04 : 0) : 0, t, 0.1);
    this.windF.frequency.setTargetAtTime(500 + speed * 18, t, 0.1);
    this.windG.gain.setTargetAtTime(on ? Math.min(0.22, speed * 0.0022) : 0, t, 0.2);
  }

  _noise(t, dur, type, freq, gain, q = 1, dest = this.sfx, endFreq) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
    return g;
  }
  _tone(t, dur, type, f0, f1, gain, dest = this.sfx) {
    const c = this.ctx, o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  }

  whoosh(pan = 0) {
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime;
    const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(this.sfx);
    this._noise(t, 0.4, 'bandpass', 500, 0.9, 1.2, p, 2600);
  }
  coin() { if (!this.ctx) return; const t = this.ctx.currentTime; this._tone(t, 0.09, 'square', 1318, 0, 0.07); this._tone(t + 0.06, 0.18, 'square', 1975, 0, 0.07); }
  nitro() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._noise(t, 0.9, 'bandpass', 300, 0.9, 0.8, this.sfx, 3500);
    this._tone(t, 0.5, 'sine', 120, 40, 0.5);
  }
  takedown() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._noise(t, 0.6, 'lowpass', 2500, 1.0, 0.7, this.sfx, 200);
    this._tone(t, 0.4, 'sine', 90, 35, 0.9);
    this._noise(t + 0.05, 0.25, 'highpass', 4000, 0.4);
    this.duck(0.3, 0.8);
  }
  crash() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._noise(t, 1.4, 'lowpass', 1800, 1.2, 0.5, this.sfx, 120);
    this._tone(t, 0.6, 'sine', 70, 25, 1.0);
    this._noise(t + 0.1, 0.5, 'highpass', 3000, 0.5);
    this._noise(t + 0.35, 0.4, 'bandpass', 900, 0.5, 2);
    this.duck(0.15, 2.5);
  }
  scrape() { if (!this.ctx) return; const t = this.ctx.currentTime; this._noise(t, 0.25, 'highpass', 2500, 0.45, 2); this._tone(t, 0.15, 'sine', 80, 50, 0.4); }
  land() { if (!this.ctx) return; const t = this.ctx.currentTime; this._tone(t, 0.25, 'sine', 90, 40, 0.7); this._noise(t, 0.2, 'lowpass', 800, 0.5); }
  ramp() { if (!this.ctx) return; const t = this.ctx.currentTime; this._noise(t, 0.7, 'bandpass', 800, 0.5, 1, this.sfx, 300); }
  beep(hi) { if (!this.ctx) return; const t = this.ctx.currentTime; this._tone(t, hi ? 0.6 : 0.25, 'square', hi ? 1760 : 880, 0, 0.12); }
  click() { if (!this.ctx) return; const t = this.ctx.currentTime; this._tone(t, 0.06, 'square', 660, 990, 0.05); }

  // ---------- synthwave music ----------
  _schedule() {
    const c = this.ctx; if (!c || c.state !== 'running') { if (c) this.nextTime = c.currentTime + 0.05; return; }
    const spb = 60 / 112 / 4; // 16th note
    while (this.nextTime < c.currentTime + 0.15) { this._playStep(this.step, this.nextTime, spb); this.nextTime += spb; this.step++; }
  }
  _playStep(step, t, spb) {
    if (!this.musicOn) return;
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    // Am  F  C  G
    const roots = [55, 43.65, 65.41, 49.0];
    const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 261.6, 329.6], [196, 246.9, 293.7]];
    const r = roots[bar], ch = chords[bar];
    const m = this.music;
    if (s % 4 === 0) { this._tone(t, 0.28, 'sine', 140, 38, 0.9, m); }
    if (s === 4 || s === 12) { this._noise(t, 0.18, 'highpass', 1400, 0.38, 1, m); this._tone(t, 0.1, 'triangle', 190, 120, 0.25, m); }
    if (s % 2 === 1) this._noise(t, 0.04, 'highpass', 8000, 0.13, 1, m);
    // pumping bass 8ths
    if (s % 2 === 0) {
      const f = s % 4 === 0 ? r : r * 2;
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const fl = this.ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 6;
      fl.frequency.setValueAtTime(900, t); fl.frequency.exponentialRampToValueAtTime(140, t + spb * 1.8);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.32, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + spb * 1.9);
      o.connect(fl); fl.connect(g); g.connect(m); o.start(t); o.stop(t + spb * 2);
    }
    // arp
    const arpN = [0, 1, 2, 1, 0, 2, 1, 2][s % 8];
    const af = ch[arpN] * (s >= 8 ? 2 : 1);
    const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = af;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.045, t); g.gain.exponentialRampToValueAtTime(0.001, t + spb * 0.9);
    const fl = this.ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 2600;
    o.connect(fl); fl.connect(g); g.connect(m); g.connect(this.delay); o.start(t); o.stop(t + spb);
    // pad at bar start
    if (s === 0) {
      for (const f of ch) for (const det of [-9, 9]) {
        const p = this.ctx.createOscillator(); p.type = 'sawtooth'; p.frequency.value = f / 2; p.detune.value = det;
        const pf = this.ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 900;
        const pg = this.ctx.createGain(); const dur = spb * 16;
        pg.gain.setValueAtTime(0.0001, t); pg.gain.linearRampToValueAtTime(0.022, t + 0.4); pg.gain.linearRampToValueAtTime(0.0001, t + dur);
        p.connect(pf); pf.connect(pg); pg.connect(m); p.start(t); p.stop(t + dur + 0.05);
      }
    }
  }
}
