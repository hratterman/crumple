/**
 * One-shot sound synthesis (P8 audio): crashes, glass, debris, props,
 * snaps, booms, transitions. PURE: each call renders one variant into a new
 * Float32Array (done once per variant when the bank is built — never per
 * event). Seeded, so variants are reproducible in tests and WAV renders.
 *
 * Building blocks: modal resonators (decaying sinusoids driven by an
 * excitation — metal, plastic, wood modes), filtered noise bursts, pitch-
 * dropping sine thumps, and particle clouds (glass tinkle, debris bounces).
 */
import { Noise, OnePole, softClip, Svf } from './core';

export const ONE_SHOT_KINDS = [
  'thump',
  'crunch',
  'hit',
  'snap',
  'glass',
  'glassCrack',
  'debris',
  'clang',
  'cone',
  'tire',
  'cardboard',
  'wood',
  'pole',
  'concrete',
  'boom',
  'whoosh',
] as const;
export type OneShotKind = (typeof ONE_SHOT_KINDS)[number];

/** Variants built per kind (bank size). */
export const ONE_SHOT_VARIANTS: Readonly<Record<OneShotKind, number>> = {
  thump: 4,
  crunch: 6,
  hit: 4,
  snap: 4,
  glass: 3,
  glassCrack: 3,
  debris: 4,
  clang: 3,
  cone: 3,
  tire: 2,
  cardboard: 3,
  wood: 3,
  pole: 2,
  concrete: 3,
  boom: 2,
  whoosh: 1,
};

const DUR: Readonly<Record<OneShotKind, number>> = {
  thump: 0.55,
  crunch: 1.3,
  hit: 0.45,
  snap: 0.3,
  glass: 1.7,
  glassCrack: 0.3,
  debris: 1.5,
  clang: 1.9,
  cone: 0.45,
  tire: 0.45,
  cardboard: 0.55,
  wood: 0.6,
  pole: 2.3,
  concrete: 0.6,
  boom: 1.3,
  whoosh: 1.4,
};

/** Bank of 2-pole modal resonators (y = 2r·cos w·y1 − r²·y2 + x). */
class Modes {
  readonly c1: Float64Array;
  readonly c2: Float64Array;
  readonly g: Float64Array;
  readonly y1: Float64Array;
  readonly y2: Float64Array;
  constructor(freqs: readonly number[], decays: readonly number[], gains: readonly number[], sr: number) {
    const n = freqs.length;
    this.c1 = new Float64Array(n);
    this.c2 = new Float64Array(n);
    this.g = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const f = Math.min(freqs[k]!, sr * 0.45);
      const r = Math.exp(-1 / (decays[k]! * sr));
      this.c1[k] = 2 * r * Math.cos((2 * Math.PI * f) / sr);
      this.c2[k] = -r * r;
      // normalise so an impulse gives ≈ unit-amplitude ringing
      this.g[k] = (gains[k] ?? 1) * Math.sin((2 * Math.PI * f) / sr);
    }
  }
  tick(x: number): number {
    let s = 0;
    for (let k = 0; k < this.c1.length; k++) {
      const y = this.c1[k]! * this.y1[k]! + this.c2[k]! * this.y2[k]! + x * this.g[k]!;
      this.y2[k] = this.y1[k]!;
      this.y1[k] = y;
      s += y;
    }
    return s;
  }
}

function normalize(out: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (let i = 0; i < out.length; i++) m = Math.max(m, Math.abs(out[i]!));
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * k;
  }
  // 3 ms fade-out guard
  const f = Math.min(out.length, 144);
  for (let i = 0; i < f; i++) out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / f);
  return out;
}

/** Decaying sine with a pitch glide (thumps, booms). */
function addThump(out: Float32Array, sr: number, start: number, f0: number, f1: number, glideS: number, decayS: number, amp: number, drive = 1): void {
  let ph = 0;
  const i0 = Math.floor(start * sr);
  const glide = Math.exp(-1 / (glideS * sr));
  const decay = Math.exp(-1 / (decayS * sr));
  let f = f0;
  let env = amp;
  const atk = Math.max(1, Math.floor(0.002 * sr));
  for (let i = i0; i < out.length && env > 1e-5; i++) {
    f = f1 + (f - f1) * glide;
    ph += f / sr;
    if (ph >= 1) ph -= 1;
    const a = i - i0 < atk ? (i - i0) / atk : 1;
    out[i] = out[i]! + softClip(Math.sin(2 * Math.PI * ph) * drive) * env * a;
    env *= decay;
  }
}

/** Noise burst through an SVF band-pass with an exponential envelope. */
function addBurst(out: Float32Array, sr: number, rng: Noise, start: number, durS: number, hz: number, q: number, amp: number, decayS: number): void {
  const f = new Svf();
  f.set(hz, q, sr);
  const i0 = Math.floor(start * sr);
  const i1 = Math.min(out.length, i0 + Math.floor(durS * sr));
  const decay = Math.exp(-1 / (decayS * sr));
  let env = amp;
  for (let i = i0; i < i1; i++) {
    f.tick(rng.white());
    out[i] = out[i]! + f.bpn * env;
    env *= decay;
  }
}

/** Inharmonic metal panel modes (random within a band), seeded. */
function metalModes(rng: Noise, count: number, lo: number, hi: number, dLo: number, dHi: number, sr: number): Modes {
  const f: number[] = [];
  const d: number[] = [];
  const g: number[] = [];
  for (let k = 0; k < count; k++) {
    const u = rng.next();
    f.push(lo * Math.pow(hi / lo, u));
    d.push(dLo + (dHi - dLo) * rng.next());
    g.push(0.4 + 0.6 * rng.next());
  }
  return new Modes(f, d, g, sr);
}

/** Excitation (bursts of noise, sparse clicks) driving modes. */
function driveModes(out: Float32Array, m: Modes, sr: number, rng: Noise, start: number, durS: number, amp: number, density: number, lp: OnePole | null): void {
  const i0 = Math.floor(start * sr);
  const n = out.length;
  const i1 = Math.min(n, i0 + Math.floor(durS * sr));
  for (let i = i0; i < n; i++) {
    let x = 0;
    if (i < i1) {
      const t = (i - i0) / Math.max(1, i1 - i0);
      const env = (1 - t) * (1 - t);
      x = rng.next() < density ? rng.white() * amp * env : 0;
      if (lp) x = lp.tick(x);
    }
    out[i] = out[i]! + m.tick(x);
  }
}

export function synthOneShot(kind: OneShotKind, sr: number, seed: number): Float32Array {
  const rng = new Noise(seed * 0x2545f491 + kind.length * 977 + 13);
  const dur = DUR[kind] * (0.9 + 0.2 * rng.next());
  const out = new Float32Array(Math.ceil(dur * sr));
  switch (kind) {
    case 'thump': {
      addThump(out, sr, 0, 120 + 40 * rng.next(), 55, 0.035, 0.12, 1, 1.4);
      addBurst(out, sr, rng, 0, 0.03, 900, 0.7, 0.5, 0.008);
      return normalize(out, 0.9);
    }
    case 'boom': {
      addThump(out, sr, 0, 85 + 15 * rng.next(), 36, 0.07, 0.2, 1, 1.8);
      addThump(out, sr, 0.01, 52, 32, 0.15, 0.3, 0.45, 1);
      addBurst(out, sr, rng, 0, 0.06, 300, 0.6, 0.3, 0.03);
      return normalize(out, 0.95);
    }
    case 'crunch': {
      // crumpling sheet metal: a dense, decaying crackle of buckling events (Poisson) exciting many
      // short-lived panel modes, the same crackle as raw grit, a low body thump and a falling creak
      const m = metalModes(rng, 22, 240, 6500, 0.012, 0.11, sr);
      const big = metalModes(rng, 5, 180, 900, 0.08, 0.25, sr);
      const exc = new Float32Array(out.length);
      const crumpleS = 0.28 + 0.3 * rng.next();
      let t = 0;
      while (t < crumpleS) {
        const u = t / crumpleS;
        const a = (1 - u) * (1 - u) * (0.3 + 0.7 * rng.next()) * (rng.next() < 0.15 ? 2.2 : 1);
        const i0 = Math.floor(t * sr);
        const len = Math.floor((0.0008 + 0.005 * rng.next()) * sr);
        for (let i = 0; i < len && i0 + i < exc.length; i++) exc[i0 + i] = exc[i0 + i]! + rng.white() * a * (1 - i / len);
        t += -Math.log(1 - rng.next() * 0.999) * (0.004 + 0.02 * u);
      }
      const grit = new Svf();
      grit.set(2600 + 1200 * rng.next(), 0.7, sr);
      const lp = new OnePole();
      lp.setHz(7000, sr);
      for (let i = 0; i < out.length; i++) {
        const x = lp.tick(exc[i]!);
        grit.tick(exc[i]!);
        out[i] = out[i]! + m.tick(x) * 0.8 + big.tick(x) * 0.35 + grit.bpn * 0.6;
      }
      addThump(out, sr, 0, 95 + 30 * rng.next(), 48, 0.04, 0.09, 0.55, 1.3);
      // creak: a slowly falling resonance
      const cr = new Svf();
      const i0 = Math.floor((0.08 + 0.15 * rng.next()) * sr);
      const cdur = Math.floor((0.25 + 0.3 * rng.next()) * sr);
      const cf = 500 + 600 * rng.next();
      for (let i = 0; i < cdur && i0 + i < out.length; i++) {
        const u = i / cdur;
        cr.set(cf * (1 - 0.35 * u), 18, sr);
        cr.tick(rng.white() * (rng.next() < 0.3 ? 1 : 0));
        out[i0 + i] = out[i0 + i]! + cr.bpn * 0.2 * Math.sin(Math.PI * u);
      }
      return normalize(out, 0.92);
    }
    case 'hit': {
      const m = metalModes(rng, 7, 350, 4800, 0.02, 0.18, sr);
      driveModes(out, m, sr, rng, 0, 0.006, 1, 1, null);
      addThump(out, sr, 0, 140, 70, 0.02, 0.05, 0.5);
      return normalize(out, 0.85);
    }
    case 'snap': {
      // metal tearing / weld letting go: very sharp transient + short bright ring
      const m = metalModes(rng, 6, 1500, 7500, 0.01, 0.06, sr);
      driveModes(out, m, sr, rng, 0, 0.004, 1.5, 1, null);
      addBurst(out, sr, rng, 0, 0.02, 3500, 0.8, 0.8, 0.004);
      addBurst(out, sr, rng, 0.004, 0.08, 1800, 1.2, 0.25, 0.02);
      return normalize(out, 0.85);
    }
    case 'glass': {
      // shatter: bright crack transient, a burst of breakage noise, then falling tinkle particles
      addBurst(out, sr, rng, 0, 0.012, 6500, 0.6, 1, 0.003);
      addBurst(out, sr, rng, 0.002, 0.35, 5200, 0.5, 0.45, 0.07);
      addBurst(out, sr, rng, 0.0, 0.2, 2600, 0.8, 0.2, 0.05);
      const particles = 55 + Math.floor(rng.next() * 40);
      for (let k = 0; k < particles; k++) {
        const t = 0.01 + Math.min(1.4, -Math.log(1 - rng.next() * 0.98) * 0.28);
        const f = 2800 + 7500 * rng.next();
        const m = new Modes([f, f * (1.47 + 0.2 * rng.next()), f * (2.31 + 0.3 * rng.next())], [0.006 + 0.03 * rng.next(), 0.004 + 0.015 * rng.next(), 0.003 + 0.01 * rng.next()], [1, 0.5, 0.3], sr);
        const i0 = Math.floor(t * sr);
        const a = (0.15 + 0.85 * rng.next()) * Math.exp(-t * 1.8) * 0.5;
        const len = Math.min(out.length - i0, Math.floor(0.06 * sr));
        for (let i = 0; i < len; i++) out[i0 + i] = out[i0 + i]! + m.tick(i === 0 ? a : 0);
      }
      return normalize(out, 0.85);
    }
    case 'glassCrack': {
      addBurst(out, sr, rng, 0, 0.006, 7000, 0.7, 1, 0.0015);
      const m = new Modes([3200 + 1500 * rng.next(), 5400 + 2000 * rng.next()], [0.012, 0.008], [1, 0.6], sr);
      driveModes(out, m, sr, rng, 0, 0.003, 0.6, 1, null);
      for (let k = 0; k < 5; k++) addBurst(out, sr, rng, 0.01 + rng.next() * 0.12, 0.004, 6000, 1, 0.3 * rng.next(), 0.001);
      return normalize(out, 0.75);
    }
    case 'debris': {
      // a handful of pieces bouncing: geometric bounce intervals, each bounce a small modal hit
      const pieces = 3 + Math.floor(rng.next() * 4);
      for (let p = 0; p < pieces; p++) {
        const metal = rng.next() < 0.6;
        const m = metal ? metalModes(rng, 4, 900, 6000, 0.01, 0.07, sr) : new Modes([600 + 900 * rng.next(), 1500 + 1500 * rng.next()], [0.015, 0.01], [1, 0.5], sr);
        let t = 0.03 + rng.next() * 0.3;
        let gap = 0.12 + rng.next() * 0.15;
        let a = 0.5 + 0.5 * rng.next();
        const hits: number[] = [];
        while (t < DUR.debris - 0.1 && a > 0.04) {
          hits.push(t, a);
          t += gap;
          gap *= 0.62 + 0.1 * rng.next();
          a *= 0.55 + 0.15 * rng.next();
          if (gap < 0.012) break;
        }
        let h = 0;
        for (let i = Math.floor(hits[0]! * sr); i < out.length; i++) {
          let x = 0;
          if (h < hits.length && i >= Math.floor(hits[h]! * sr)) {
            x = hits[h + 1]!;
            h += 2;
          }
          out[i] = out[i]! + m.tick(x);
        }
      }
      return normalize(out, 0.7);
    }
    case 'clang': {
      // 200 L steel drum: strong shell modes + hollow body boom
      const base = 165 + 30 * rng.next();
      const ratios = [1, 1.83, 2.71, 3.86, 5.12, 6.9, 8.95];
      const m = new Modes(
        ratios.map((r) => base * r * (0.97 + 0.06 * rng.next())),
        [1.1, 0.9, 0.7, 0.55, 0.4, 0.3, 0.2],
        [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2],
        sr,
      );
      driveModes(out, m, sr, rng, 0, 0.008, 1, 1, null);
      addThump(out, sr, 0, 120, 82, 0.05, 0.16, 0.8, 1.2);
      addBurst(out, sr, rng, 0, 0.02, 2200, 0.7, 0.4, 0.005);
      return normalize(out, 0.85);
    }
    case 'cone': {
      const m = new Modes([210 + 40 * rng.next(), 520 + 80 * rng.next(), 990 + 150 * rng.next(), 1650], [0.09, 0.06, 0.04, 0.025], [1, 0.7, 0.4, 0.2], sr);
      driveModes(out, m, sr, rng, 0, 0.01, 0.8, 1, null);
      addBurst(out, sr, rng, 0, 0.03, 1400, 0.6, 0.4, 0.008);
      addThump(out, sr, 0, 110, 70, 0.02, 0.05, 0.4);
      return normalize(out, 0.7);
    }
    case 'tire': {
      addThump(out, sr, 0, 105, 62, 0.04, 0.09, 1, 1.2);
      const sq = new Svf();
      const i0 = Math.floor(0.01 * sr);
      const len = Math.floor(0.12 * sr);
      for (let i = 0; i < len; i++) {
        sq.set(700 + 300 * (i / len), 12, sr);
        sq.tick(rng.white());
        out[i0 + i] = out[i0 + i]! + sq.bpn * 0.12 * Math.sin((Math.PI * i) / len);
      }
      return normalize(out, 0.7);
    }
    case 'cardboard': {
      addThump(out, sr, 0, 140, 90, 0.02, 0.04, 0.6);
      const n = 6 + Math.floor(rng.next() * 8);
      for (let k = 0; k < n; k++) addBurst(out, sr, rng, rng.next() * 0.3, 0.03, 700 + 2200 * rng.next(), 0.9, 0.4 * (0.4 + rng.next()), 0.012);
      return normalize(out, 0.65);
    }
    case 'wood': {
      const m = new Modes([380 + 80 * rng.next(), 870 + 120 * rng.next(), 1580 + 200 * rng.next(), 2600], [0.05, 0.035, 0.022, 0.012], [1, 0.7, 0.45, 0.25], sr);
      driveModes(out, m, sr, rng, 0, 0.006, 1, 1, null);
      for (let k = 0; k < 9; k++) addBurst(out, sr, rng, 0.005 + rng.next() * 0.2, 0.008, 1800 + 3000 * rng.next(), 1.2, 0.35 * rng.next(), 0.003);
      addThump(out, sr, 0, 130, 80, 0.03, 0.06, 0.5);
      return normalize(out, 0.8);
    }
    case 'pole': {
      const base = 118 + 20 * rng.next();
      const ratios = [1, 2.76, 5.4, 8.93, 13.3, 18.6];
      const m = new Modes(
        ratios.map((r) => base * r * (0.98 + 0.04 * rng.next())),
        [1.6, 1.3, 0.9, 0.6, 0.4, 0.25],
        [1, 0.7, 0.5, 0.35, 0.25, 0.15],
        sr,
      );
      driveModes(out, m, sr, rng, 0, 0.006, 1.2, 1, null);
      addBurst(out, sr, rng, 0, 0.015, 3200, 0.7, 0.5, 0.004);
      return normalize(out, 0.8);
    }
    case 'concrete': {
      addThump(out, sr, 0, 95, 50, 0.03, 0.09, 1, 1.5);
      for (let k = 0; k < 18; k++) addBurst(out, sr, rng, rng.next() * 0.25, 0.006, 1500 + 4500 * rng.next(), 1.4, 0.25 * rng.next(), 0.003);
      addBurst(out, sr, rng, 0, 0.05, 600, 0.6, 0.4, 0.02);
      return normalize(out, 0.85);
    }
    case 'whoosh': {
      // reverse-swell into a dark sweep: crash-cam / replay transitions
      const f = new Svf();
      const n = out.length;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const env = u < 0.55 ? Math.pow(u / 0.55, 2.2) : Math.exp(-(u - 0.55) * 9);
        f.set(300 + 2600 * (u < 0.55 ? u / 0.55 : 1 - (u - 0.55) / 0.45), 1.4, sr);
        f.tick(rng.white());
        out[i] = f.bpn * env;
      }
      return normalize(out, 0.6);
    }
  }
}
