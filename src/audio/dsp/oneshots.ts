/**
 * One-shot sound synthesis (P8 audio): crashes, glass, debris, props,
 * snaps, booms, transitions. PURE: each call renders one variant into a new
 * Float32Array (done once per variant when the bank is built, in a worker —
 * never per event). Seeded, so variants are reproducible in tests and renders.
 *
 * CRASH DESIGN (P8 review: "crashes sound like windchimes"): a car crash is
 * a heavy, dull, broadband low-mid IMPACT plus a dense, granular CRUMPLE —
 * not pitched ringing. So the crash kinds are built from
 *   - a low body: low-passed noise burst + a dropping 60–110 Hz thud, fast attack;
 *   - grains: hundreds of 0.4–6 ms noise micro-bursts through random
 *     band-passes (300–3000 Hz, low Q), density and level decaying, arriving
 *     in irregular waves for the rolling crumple;
 *   - creaks (short, low-Q falling resonances) and plastic cracks (sharp
 *     clicks into 2–5 kHz band-passes);
 *   - metal ringing only for hard metal-on-metal ('clang', 'pole', 'drum'):
 *     DENSE inharmonic partials (40+) that die in < 150 ms (drum / pole a bit longer).
 * Glass is a crunchy broadband shatter burst + a few short fragment ticks
 * (noise grains, no sine partials). Debris = low thuds and short scrapes.
 */
import { DcBlock, Noise, OnePole, softClip, Svf } from './core';

export const ONE_SHOT_KINDS = [
  'thump',
  'tap',
  'crunch',
  'crumple',
  'plastic',
  'snap',
  'glass',
  'glassCrack',
  'debris',
  'clang',
  'drum',
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

/** Variants built per kind (bank size). `crumple` variants are ordered short → long (index ≈ crash energy). */
export const ONE_SHOT_VARIANTS: Readonly<Record<OneShotKind, number>> = {
  thump: 4,
  tap: 4,
  crunch: 6,
  crumple: 4,
  plastic: 3,
  snap: 4,
  glass: 3,
  glassCrack: 3,
  debris: 4,
  clang: 3,
  drum: 3,
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
  thump: 0.35,
  tap: 0.25,
  crunch: 0.45,
  crumple: 1.6,
  plastic: 0.3,
  snap: 0.2,
  glass: 0.9,
  glassCrack: 0.15,
  debris: 1.4,
  clang: 0.35,
  drum: 0.6,
  cone: 0.45,
  tire: 0.45,
  cardboard: 0.55,
  wood: 0.6,
  pole: 0.9,
  concrete: 0.6,
  boom: 0.8,
  whoosh: 1.4,
};

/** Crumple variant lengths (s): index 0..3 = light … massive crash. */
export const CRUMPLE_LENGTHS = [0.5, 0.8, 1.15, 1.5];

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
  // a 25 Hz DC blocker (low-passed noise bodies carry a little DC)
  const dc = new DcBlock();
  dc.setHz(25, 48000);
  for (let i = 0; i < out.length; i++) out[i] = dc.tick(out[i]!);
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


/** Low body of an impact: double low-passed noise burst + a dropping thud (60–250 Hz, fast attack). */
function addBody(out: Float32Array, sr: number, rng: Noise, start: number, amp: number, decayS: number, lpHz = 220): void {
  const a = new OnePole();
  const b = new OnePole();
  a.setHz(lpHz, sr);
  b.setHz(lpHz * 1.3, sr);
  const i0 = Math.floor(start * sr);
  const n = Math.min(out.length - i0, Math.floor(decayS * 7 * sr));
  const dec = Math.exp(-1 / (decayS * sr));
  const atk = Math.max(1, Math.floor(0.0015 * sr));
  let env = amp * 9;
  for (let i = 0; i < n; i++) {
    const v = b.tick(a.tick(rng.white()));
    out[i0 + i] = out[i0 + i]! + v * env * (i < atk ? i / atk : 1);
    env *= dec;
  }
  addThump(out, sr, start, 105 + 30 * rng.next(), 58, 0.03, decayS * 0.9, amp * 0.32, 1.6);
}

/**
 * Granular crumple: Poisson micro-bursts of noise through random low-Q
 * band-passes. `rate(u)` grains/s and `level(u)` over u = 0..1 of `durS`.
 */
function addGrains(
  out: Float32Array,
  sr: number,
  rng: Noise,
  start: number,
  durS: number,
  rate0: number,
  rate1: number,
  amp: number,
  fLo: number,
  fHi: number,
  msLo: number,
  msHi: number,
  qLo = 0.7,
  qHi = 2.5,
): void {
  const f = new Svf();
  let t = 0;
  while (t < durS) {
    const u = t / durS;
    const rate = rate0 + (rate1 - rate0) * u;
    const lvl = amp * (1 - u) * (1 - 0.5 * u) * (0.25 + 0.75 * rng.next()) * (rng.next() < 0.08 ? 2.2 : 1);
    const hz = fLo * Math.pow(fHi / fLo, rng.next());
    f.reset();
    f.set(hz, qLo + (qHi - qLo) * rng.next(), sr);
    const len = Math.max(4, Math.floor(((msLo + (msHi - msLo) * rng.next()) / 1000) * sr));
    const i0 = Math.floor((start + t) * sr);
    for (let i = 0; i < len + Math.floor(0.004 * sr) && i0 + i < out.length; i++) {
      const e = i < len ? (i < 3 ? i / 3 : 1 - i / len) : 0;
      f.tick(rng.white() * e);
      out[i0 + i] = out[i0 + i]! + f.bpn * lvl;
    }
    t += -Math.log(1 - rng.next() * 0.999) / Math.max(rate, 1);
  }
}

/** Creak: a short, low-Q band of noise whose centre falls (bending sheet metal). */
function addCreak(out: Float32Array, sr: number, rng: Noise, start: number, amp: number): void {
  const f = new Svf();
  const i0 = Math.floor(start * sr);
  const n = Math.floor((0.03 + 0.07 * rng.next()) * sr);
  const f0 = 500 + 900 * rng.next();
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const u = i / n;
    if ((i & 15) === 0) f.set(f0 * (1 - 0.4 * u), 5 + 3 * rng.next(), sr);
    f.tick(rng.white() * (rng.next() < 0.5 ? 1 : 0.2));
    out[i0 + i] = out[i0 + i]! + f.bpn * amp * Math.sin(Math.PI * u);
  }
}

/** Plastic crack: a few sharp clicks into 2–5 kHz band-passes, in a quick cluster. */
function addCracks(out: Float32Array, sr: number, rng: Noise, start: number, count: number, amp: number): void {
  let t = start;
  for (let k = 0; k < count; k++) {
    const f = new Svf();
    f.set(1800 + 3200 * rng.next(), 2 + 2 * rng.next(), sr);
    const i0 = Math.floor(t * sr);
    const n = Math.floor((0.004 + 0.006 * rng.next()) * sr);
    const a = amp * (0.4 + 0.6 * rng.next());
    for (let i = 0; i < n && i0 + i < out.length; i++) {
      f.tick(i === 0 ? 1 : rng.white() * Math.exp(-i / (0.0008 * sr)));
      out[i0 + i] = out[i0 + i]! + f.bpn * a * 3;
    }
    t += 0.004 + 0.03 * rng.next();
  }
}

/** Dense inharmonic metal partials (decays dLo..dHi s) excited by a short noise burst. */
function addMetal(out: Float32Array, sr: number, rng: Noise, start: number, count: number, lo: number, hi: number, dLo: number, dHi: number, amp: number): void {
  const m = metalModes(rng, count, lo, hi, dLo, dHi, sr);
  const i0 = Math.floor(start * sr);
  const burst = Math.floor(0.004 * sr);
  const n = Math.min(out.length - i0, Math.floor(dHi * 6 * sr));
  for (let i = 0; i < n; i++) out[i0 + i] = out[i0 + i]! + m.tick(i < burst ? rng.white() * amp * (1 - i / burst) * 0.25 : 0);
}

export function synthOneShot(kind: OneShotKind, sr: number, seed: number): Float32Array {
  const rng = new Noise(seed * 0x2545f491 + kind.length * 977 + 13);
  const dur = kind === 'crumple' ? (CRUMPLE_LENGTHS[(seed - 1) % CRUMPLE_LENGTHS.length]! + 0.25) : DUR[kind] * (0.9 + 0.2 * rng.next());
  const out = new Float32Array(Math.ceil(dur * sr));
  switch (kind) {
    case 'thump': {
      addBody(out, sr, rng, 0, 1, 0.06);
      return normalize(out, 0.9);
    }
    case 'tap': {
      // a light knock: small dull body + a short cluster of grains
      addBody(out, sr, rng, 0, 0.7, 0.03, 320);
      addGrains(out, sr, rng, 0.002, 0.035, 700, 200, 0.5, 500, 2600, 0.4, 3);
      return normalize(out, 0.8);
    }
    case 'boom': {
      addThump(out, sr, 0, 80 + 15 * rng.next(), 38, 0.05, 0.12, 1, 1.8);
      addBody(out, sr, rng, 0, 0.6, 0.09, 160);
      return normalize(out, 0.95);
    }
    case 'crunch': {
      // short crumple: dense grains decaying over ~0.3 s, a couple of creaks and cracks, a body hit
      addBody(out, sr, rng, 0, 0.9, 0.05);
      addGrains(out, sr, rng, 0.001, 0.28 + 0.1 * rng.next(), 1400, 120, 0.75, 300, 3000, 0.4, 5);
      addGrains(out, sr, rng, 0.0, 0.06, 900, 300, 0.45, 180, 600, 2, 8, 0.7, 1.5);
      for (let k = 0; k < 2; k++) addCreak(out, sr, rng, 0.03 + 0.18 * rng.next(), 0.35);
      addCracks(out, sr, rng, 0.01 + 0.05 * rng.next(), 2 + Math.floor(rng.next() * 3), 0.4);
      return normalize(out, 0.92);
    }
    case 'crumple': {
      // rolling crumple: irregular waves of buckling (each a grain burst + low thud), creaks, cracks
      const len = dur - 0.25;
      let t = 0;
      let w = 0;
      while (t < len) {
        const u = t / len;
        const a = (1 - 0.75 * u) * (0.55 + 0.45 * rng.next());
        const wl = 0.08 + 0.17 * rng.next();
        addGrains(out, sr, rng, t, wl, 1600 * a + 200, 150, 0.7 * a, 300, 3000, 0.4, 5);
        addGrains(out, sr, rng, t, wl * 0.6, 500, 150, 0.4 * a, 180, 700, 2, 9, 0.7, 1.5);
        if (w === 0 || rng.next() < 0.5) addBody(out, sr, rng, t, (w === 0 ? 1 : 0.45) * a, 0.05);
        if (rng.next() < 0.6) addCreak(out, sr, rng, t + wl * rng.next(), 0.3 * a);
        if (rng.next() < 0.45) addCracks(out, sr, rng, t + wl * rng.next(), 1 + Math.floor(rng.next() * 3), 0.35 * a);
        t += wl * (0.5 + 0.7 * rng.next());
        w++;
      }
      return normalize(out, 0.92);
    }
    case 'plastic': {
      addCracks(out, sr, rng, 0, 4 + Math.floor(rng.next() * 5), 0.8);
      addGrains(out, sr, rng, 0, 0.12, 900, 100, 0.35, 900, 4000, 0.3, 2);
      return normalize(out, 0.75);
    }
    case 'snap': {
      // a beam / weld letting go: a sharp crack and a short dull knock, no ringing
      addCracks(out, sr, rng, 0, 1 + Math.floor(rng.next() * 2), 1);
      addGrains(out, sr, rng, 0, 0.04, 1200, 300, 0.5, 600, 3000, 0.3, 2);
      addBody(out, sr, rng, 0.002, 0.35, 0.025, 300);
      return normalize(out, 0.85);
    }
    case 'glass': {
      // shatter: a crunchy broadband burst (dense short grains, 2–9 kHz) + a few short fragment ticks
      addCracks(out, sr, rng, 0, 2, 1);
      addGrains(out, sr, rng, 0, 0.09, 5000, 600, 0.9, 1800, 9000, 0.2, 1.6, 0.5, 1.5);
      addBurst(out, sr, rng, 0, 0.12, 4500, 0.4, 0.35, 0.03);
      // the pane's crunch body (1–3 kHz) under the bright burst
      addGrains(out, sr, rng, 0, 0.07, 2500, 400, 0.45, 900, 3200, 0.3, 2, 0.6, 1.4);
      const ticks = 6 + Math.floor(rng.next() * 9);
      for (let k = 0; k < ticks; k++) {
        const t = 0.12 + Math.pow(rng.next(), 1.4) * (dur - 0.2);
        const a = 0.25 * (1 - 0.6 * (t / dur)) * (0.4 + 0.6 * rng.next());
        addGrains(out, sr, rng, t, 0.004 + 0.01 * rng.next(), 1500, 500, a, 2500, 7000, 0.3, 1.5, 1, 2.5);
      }
      return normalize(out, 0.85);
    }
    case 'glassCrack': {
      addCracks(out, sr, rng, 0, 1, 1);
      addGrains(out, sr, rng, 0.002, 0.03, 2500, 400, 0.4, 2000, 7000, 0.2, 1.2, 0.6, 1.6);
      return normalize(out, 0.7);
    }
    case 'debris': {
      // pieces landing: low thuds and short scrapes, bounce intervals shrinking
      const pieces = 3 + Math.floor(rng.next() * 4);
      for (let p = 0; p < pieces; p++) {
        let t = 0.02 + rng.next() * 0.35;
        let gap = 0.1 + rng.next() * 0.18;
        let a = 0.5 + 0.5 * rng.next();
        while (t < dur - 0.1 && a > 0.05 && gap > 0.015) {
          addBody(out, sr, rng, t, a * 0.6, 0.018, 280 + 200 * rng.next());
          addGrains(out, sr, rng, t, 0.015 + 0.03 * rng.next(), 600, 200, a * 0.35, 500, 2500, 0.5, 4);
          t += gap;
          gap *= 0.6 + 0.12 * rng.next();
          a *= 0.5 + 0.15 * rng.next();
        }
      }
      return normalize(out, 0.75);
    }
    case 'clang': {
      // hard metal on metal: dense inharmonic partials, heavily damped (< 150 ms), with a body knock
      addMetal(out, sr, rng, 0, 64, 280, 6000, 0.012, 0.05, 0.6);
      addBody(out, sr, rng, 0, 0.6, 0.03, 300);
      addGrains(out, sr, rng, 0, 0.07, 2200, 300, 0.6, 600, 4000, 0.3, 2);
      return normalize(out, 0.85);
    }
    case 'drum': {
      // 200 L steel drum: hollow body boom + a dense, short shell ring
      addThump(out, sr, 0, 125 + 20 * rng.next(), 85, 0.04, 0.13, 0.9, 1.3);
      addBody(out, sr, rng, 0, 0.6, 0.05, 260);
      addMetal(out, sr, rng, 0, 56, 160, 3200, 0.035, 0.13, 0.7);
      addGrains(out, sr, rng, 0, 0.05, 1500, 300, 0.35, 400, 2500, 0.3, 2);
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
      // a sign / light pole: a knock and a dense, damped ring (a pole sings a little longer than a panel)
      addBody(out, sr, rng, 0, 0.5, 0.03, 300);
      addMetal(out, sr, rng, 0, 72, 140, 3600, 0.04, 0.16, 0.8);
      addGrains(out, sr, rng, 0, 0.04, 1500, 300, 0.3, 500, 3000, 0.3, 2);
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
