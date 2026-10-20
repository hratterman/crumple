/**
 * Horn synthesis (P8 audio; pure, allocation-free after construction). Runs
 * inside the engine voice (front output; folded into the light traffic
 * voice), so it shares the voice's pitch (Doppler × slow-mo).
 *
 *   disc  electric disc horns (sedan, coupe, pickup): two diaphragm horns a
 *         major third-ish apart, slightly detuned; each a band-limited
 *         harmonic stack with strong odd partials (the interrupter's buzz)
 *         through the trumpet's formant, a little contact rattle; the
 *         diaphragm "lands" a few % flat for ~25 ms; short attack / release.
 *   air   pneumatic air horn (box truck): a low three-trumpet chord, full
 *         sawtooth-like stacks, breath noise on the attack, pressure building
 *         in two stages (flat and soft for 0.25 s, then full), a slow sag
 *         while held and a falling release.
 *   sick  the beater's tired single horn: weak, raspy, wandering pitch,
 *         intermittent contact drop-outs.
 */
import { clamp01, Noise, OnePole, sin01, softClip, Svf } from './core';

export interface HornProfile {
  kind: 'disc' | 'air' | 'sick';
  /** Fundamental of each horn / trumpet, Hz. */
  freqs: readonly number[];
  /** Output level. */
  level: number;
  /** Trumpet / bell formant, Hz. */
  formantHz: number;
}

const MAX_TONES = 3;
const MAX_HARM = 40;

export class HornDsp {
  private readonly sr: number;
  private readonly rng: Noise;
  private p: HornProfile;
  private readonly ph = new Float64Array(MAX_TONES);
  private readonly amps = new Float64Array(MAX_HARM + 1);
  private env = 0;
  private onT = 0;
  private offT = 10;
  private wob = 0;
  private wobT = 0;
  private wobTarget = 0;
  private drop = 1;
  private dropT = 0;
  private readonly formant = new Svf();
  private readonly formant2 = new Svf();
  private readonly breath = new Svf();
  private readonly dc = new OnePole();

  constructor(profile: HornProfile, sampleRate: number, seed = 5) {
    this.sr = sampleRate;
    this.p = profile;
    this.rng = new Noise(seed * 1103515245 + 7);
    this.setProfile(profile);
  }

  setProfile(p: HornProfile): void {
    this.p = p;
    // harmonic weights: disc / sick = strong odd partials (buzz), air = every partial (brass-like)
    for (let k = 1; k <= MAX_HARM; k++) {
      const odd = (k & 1) === 1;
      this.amps[k] = p.kind === 'air' ? 1 / Math.pow(k, 0.85) : (odd ? 1 : 0.45) / Math.pow(k, p.kind === 'sick' ? 1.1 : 0.85);
    }
  }

  get active(): boolean {
    return this.env > 1e-4;
  }

  /** Adds `n` samples of horn into `out` while `on` (with attack / release). */
  process(out: Float32Array, n: number, on: boolean, pitch: number): void {
    const p = this.p;
    const sr = this.sr;
    const blockS = n / sr;
    if (on) {
      if (this.offT > 0) this.onT = 0;
      this.offT = 0;
      this.onT += blockS;
    } else {
      this.offT += blockS;
    }
    if (!on && this.env < 1e-4) {
      this.env = 0;
      return;
    }
    const air = p.kind === 'air';
    const sick = p.kind === 'sick';
    // envelope targets and speeds
    const stage = air ? (this.onT < 0.25 ? 0.55 : 1) : 1;
    const target = on ? stage : 0;
    const tau = on ? (air ? 0.06 : sick ? 0.03 : 0.012) : air ? 0.12 : 0.035;
    const k = 1 - Math.exp(-1 / (tau * sr));
    // pitch: landing flat on the attack, pressure stages / sag for air, wander for sick
    let pf = 1;
    if (on) {
      if (air) pf = (this.onT < 0.25 ? 0.93 : 1 - 0.07 * Math.exp(-(this.onT - 0.25) / 0.08)) * (1 - 0.025 * clamp01((this.onT - 0.4) / 2));
      else pf = 1 - 0.04 * Math.exp(-this.onT / 0.025);
    } else pf = air ? 1 - 0.06 * clamp01(this.offT / 0.25) : 1 - 0.03 * clamp01(this.offT / 0.05);
    if (sick) {
      this.wobT -= blockS;
      if (this.wobT <= 0) {
        this.wobTarget = this.rng.white();
        this.wobT = 0.05 + 0.15 * this.rng.next();
      }
      this.wob += (this.wobTarget - this.wob) * Math.min(1, blockS * 12);
      pf *= 1 + 0.035 * this.wob;
      // a bad contact: short drop-outs
      this.dropT -= blockS;
      if (this.dropT <= 0) {
        this.drop = this.rng.next() < 0.3 ? 0.15 : 1;
        this.dropT = this.drop < 1 ? 0.02 + 0.03 * this.rng.next() : 0.06 + 0.25 * this.rng.next();
      }
    } else this.drop = 1;
    this.formant.set(p.formantHz * pitch, air ? 1.6 : 2.4, sr);
    this.formant2.set((air ? p.formantHz * 2.9 : p.formantHz * 1.9) * pitch, 3, sr);
    this.breath.set((air ? 1400 : 3000) * pitch, 0.8, sr);
    this.dc.setHz(30, sr);
    const nyq = Math.min(10000, sr * 0.45);
    const tones = Math.min(MAX_TONES, p.freqs.length);
    const breathAmt = air ? 0.35 * Math.exp(-this.onT / 0.15) + 0.05 : sick ? 0.12 : 0.03;
    const lvl = p.level;
    for (let i = 0; i < n; i++) {
      this.env += ((target * this.drop) - this.env) * k;
      const e = this.env;
      let x = 0;
      for (let t = 0; t < tones; t++) {
        const f = p.freqs[t]! * pf * pitch * (1 + 0.003 * t);
        let ph = this.ph[t]! + f / sr;
        if (ph >= 1) ph -= 1;
        this.ph[t] = ph;
        const kmax = Math.min(MAX_HARM, Math.floor(nyq / f));
        let s = 0;
        for (let h = 1; h <= kmax; h++) {
          const q = ph * h;
          s += this.amps[h]! * sin01(q - Math.floor(q));
        }
        x += s;
      }
      x /= tones;
      // contact rattle / breath riding the fundamental
      this.breath.tick(this.rng.white() * (0.6 + 0.4 * sin01(this.ph[0]!)));
      x += this.breath.bpn * breathAmt * 3;
      this.formant.tick(x);
      this.formant2.tick(x);
      let y = x * 0.35 + this.formant.bpn * 0.9 + this.formant2.bpn * 0.35;
      y -= this.dc.tick(y);
      out[i] = out[i]! + softClip(y * 0.6 * (sick ? 1.6 : 1)) * e * lvl;
    }
  }
}
