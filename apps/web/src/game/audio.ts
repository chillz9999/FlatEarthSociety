/**
 * The Society's sound board — every sound is synthesised with WebAudio, so
 * there are no audio files. Created on a user gesture (browser autoplay rules).
 */
export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private seaGain: GainNode | null = null;
  private roarGain: GainNode | null = null;
  private roarFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private _muted = false;

  get muted(): boolean {
    return this._muted;
  }

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = brown * 3.2;
    }

    // Ambient sea: brown noise through a lowpass, slowly swelling.
    const sea = ctx.createBufferSource();
    sea.buffer = this.noise;
    sea.loop = true;
    const seaFilter = ctx.createBiquadFilter();
    seaFilter.type = 'lowpass';
    seaFilter.frequency.value = 520;
    this.seaGain = ctx.createGain();
    this.seaGain.gain.value = 0.16;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain).connect(this.seaGain.gain);
    sea.connect(seaFilter).connect(this.seaGain).connect(this.master);
    sea.start();
    lfo.start();

    // The roar of the Edge: bandpassed noise, silent until the ship nears the rim.
    const roar = ctx.createBufferSource();
    roar.buffer = this.noise;
    roar.loop = true;
    roar.playbackRate.value = 1.7;
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'bandpass';
    this.roarFilter.frequency.value = 300;
    this.roarFilter.Q.value = 0.6;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    roar.connect(this.roarFilter).connect(this.roarGain).connect(this.master);
    roar.start();
    this.sources.push(sea, lfo, roar);
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  /** 0 = far from the Edge, 1 = at the lip. */
  setEdgeProximity(p: number): void {
    if (!this.ctx || !this.roarGain || !this.roarFilter) return;
    const v = Math.max(0, Math.min(1, p));
    this.roarGain.gain.setTargetAtTime(v * v * 0.55, this.ctx.currentTime, 0.2);
    this.roarFilter.frequency.setTargetAtTime(220 + v * 500, this.ctx.currentTime, 0.2);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, glideTo?: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.master);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  private noiseBurst(start: number, dur: number, freq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(start, Math.random());
    s.stop(start + dur + 0.05);
  }

  /** A small bright bell for a piece of evidence. */
  evidence(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(1318.5, t, 0.5, 'sine', 0.18);
    this.tone(1975.5, t + 0.06, 0.6, 'sine', 0.12);
    this.tone(2637, t + 0.12, 0.5, 'triangle', 0.05);
  }

  /** A rising run of bells for a super coin. */
  superCoin(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [1046.5, 1318.5, 1568, 2093, 2637].forEach((f, i) => this.tone(f, t + i * 0.06, 0.7, 'sine', 0.16));
    this.tone(3136, t + 0.32, 0.9, 'triangle', 0.06);
  }

  /** The Society's horn marks a new stage of the Test. */
  stage(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(110, t, 1.6, 'sawtooth', 0.06);
    this.tone(165, t + 0.05, 1.5, 'sawtooth', 0.04);
    this.tone(220, t + 0.1, 1.2, 'triangle', 0.05);
  }

  /** A low groan as a whirlpool forms. */
  whirl(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(80, t, 1.8, 'sine', 0.1, 50);
    this.noiseBurst(t, 1.6, 400, 0.12, 'bandpass');
  }

  /** A rush of air past the hull: a hazard cleared by a hair. */
  nearMiss(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.32, 2600, 0.16, 'bandpass');
    this.tone(990, t + 0.02, 0.22, 'sine', 0.035, 1480);
  }

  /** A bright rising call: a new personal best, mid-voyage. */
  personalBest(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, t + i * 0.09, 0.55, 'triangle', 0.08));
  }

  crash(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.6, 1800, 0.6);
    this.tone(70, t, 0.5, 'sine', 0.4, 35);
    this.noiseBurst(t + 0.15, 1.2, 600, 0.2);
  }

  fall(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(420, t, 1.6, 'sine', 0.12, 60);
    this.noiseBurst(t, 2.2, 900, 0.35, 'bandpass');
  }

  swallowed(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(200, t, 1.4, 'sine', 0.15, 40);
    this.noiseBurst(t, 1.4, 300, 0.3);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    void this.ctx?.close();
    this.ctx = null;
  }
}
