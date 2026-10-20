/**
 * Ambient world bed (P8 audio): stereo, subtle. PURE, allocation-free after
 * construction (runs in the `crumple-ambience` worklet and in node renders).
 *
 * Layers: breeze (gusting low-passed noise, decorrelated L/R), songbirds
 * (three singers with their own species: warbler phrases, falling two-note
 * whistles, rapid chips — FM-swept notes with trill vibrato, each singer at a
 * random distance and side), golden-hour crickets (pulse-chirped 4.3 kHz
 * carriers) and lake lapping (bursty low-passed noise).
 */
import { clamp01, Noise, OnePole, sin01, Svf } from './core';

export interface AmbienceInput {
  birds: number;
  breeze: number;
  crickets: number;
  water: number;
  /** Frequency / time scale (slow-mo). */
  pitch: number;
}

export function createAmbienceInput(): AmbienceInput {
  return { birds: 0.5, breeze: 0.5, crickets: 0.2, water: 0, pitch: 1 };
}

type Species = 0 | 1 | 2;

class Singer {
  species: Species = 0;
  wait = 1;
  notesLeft = 0;
  noteT = 0;
  noteDur = 0.1;
  gap = 0;
  f0 = 3000;
  df = 0;
  vibHz = 30;
  vibDepth = 0.04;
  ph = 0;
  vph = 0;
  panL = 0.7;
  panR = 0.7;
  gain = 0.5;
  readonly lp = new OnePole();
}

export class AmbienceDsp {
  readonly sr: number;
  private readonly rng: Noise;
  private readonly singers = [new Singer(), new Singer(), new Singer()];
  private readonly breezeL = new Svf();
  private readonly breezeR = new Svf();
  private gust = 0.5;
  private gustTarget = 0.5;
  private gustT = 0;
  private crPh = 0;
  private crPh2 = 0;
  private crT = 0;
  private readonly waterLp = new Svf();
  private waterEnv = 0;
  private waterT = 0;
  private readonly lv = new Float64Array(4);

  constructor(sampleRate: number, seed = 11) {
    this.sr = sampleRate;
    this.rng = new Noise(seed * 2246822519 + 3);
    this.singers.forEach((s, i) => {
      s.species = i as Species;
      s.wait = 0.5 + 2 * i;
    });
  }

  private startPhrase(s: Singer): void {
    const r = this.rng;
    s.notesLeft = s.species === 0 ? 4 + Math.floor(r.next() * 7) : s.species === 1 ? 2 + Math.floor(r.next() * 2) : 5 + Math.floor(r.next() * 8);
    const side = r.next();
    s.panL = Math.sqrt(1 - side);
    s.panR = Math.sqrt(side);
    s.gain = 0.25 + 0.75 * r.next() * r.next();
    s.lp.setHz(2500 + 9000 * s.gain, this.sr);
    s.noteT = 0;
    s.gap = 0;
    this.nextNote(s, true);
  }

  private nextNote(s: Singer, first: boolean): void {
    const r = this.rng;
    switch (s.species) {
      case 0: // warbler: varied short notes, up/down sweeps, fast trill
        s.f0 = 2600 + r.next() * 3200;
        s.df = (r.next() - 0.5) * 2400;
        s.noteDur = 0.05 + r.next() * 0.09;
        s.vibHz = 35 + r.next() * 30;
        s.vibDepth = 0.02 + r.next() * 0.05;
        s.gap = 0.025 + r.next() * 0.06;
        break;
      case 1: // whistle: long pure tones, falling ("pee-oo")
        s.f0 = first ? 3600 + r.next() * 900 : s.f0 * (0.72 + r.next() * 0.1);
        s.df = -400 - r.next() * 500;
        s.noteDur = 0.22 + r.next() * 0.18;
        s.vibHz = 6 + r.next() * 4;
        s.vibDepth = 0.008;
        s.gap = 0.08 + r.next() * 0.1;
        break;
      default: // chips: rapid repeated short notes
        s.f0 = first ? 4200 + r.next() * 1500 : s.f0;
        s.df = 1800;
        s.noteDur = 0.018 + r.next() * 0.012;
        s.vibHz = 0;
        s.vibDepth = 0;
        s.gap = 0.045 + r.next() * 0.03;
        break;
    }
    s.noteT = 0;
  }

  process(outL: Float32Array, outR: Float32Array, n: number, inp: AmbienceInput): void {
    const sr = this.sr;
    const rng = this.rng;
    const pitch = Math.min(Math.max(inp.pitch, 0.25), 4);
    const dt = pitch / sr;
    const blockS = n / sr;
    this.breezeL.set(380 * pitch, 0.5, sr);
    this.breezeR.set(420 * pitch, 0.5, sr);
    this.waterLp.set(520 * pitch, 0.7, sr);
    this.gustT -= blockS;
    if (this.gustT <= 0) {
      this.gustTarget = 0.2 + 0.8 * rng.next();
      this.gustT = 1.5 + 4 * rng.next();
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, blockS * 0.6);
    const birds = clamp01(inp.birds);
    // phrase scheduling (block rate)
    for (const s of this.singers) {
      if (s.notesLeft > 0) continue;
      s.wait -= blockS * pitch * (0.3 + birds);
      if (s.wait <= 0 && birds > 0.02) {
        this.startPhrase(s);
        s.wait = 2.5 + 6 * rng.next();
      }
    }
    // water lapping bursts
    this.waterT -= blockS;
    if (this.waterT <= 0) {
      this.waterT = 0.35 + 0.9 * rng.next();
    }
    const tg0 = birds;
    const tg1 = clamp01(inp.breeze);
    const tg2 = clamp01(inp.crickets);
    const tg3 = clamp01(inp.water);
    const lv = this.lv;
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      const u = (i + 1) * invN;
      const bLv = lv[0]! + (tg0 - lv[0]!) * u;
      const brLv = lv[1]! + (tg1 - lv[1]!) * u;
      const crLv = lv[2]! + (tg2 - lv[2]!) * u;
      const wLv = lv[3]! + (tg3 - lv[3]!) * u;
      let l = 0;
      let r = 0;
      // breeze
      if (brLv > 1e-4) {
        this.breezeL.tick(rng.white());
        this.breezeR.tick(rng.white());
        const g = brLv * (0.35 + 0.65 * this.gust) * 0.6;
        l += this.breezeL.lp * g;
        r += this.breezeR.lp * g;
      }
      // birds
      if (bLv > 1e-4) {
        for (let k = 0; k < 3; k++) {
          const s = this.singers[k]!;
          if (s.notesLeft <= 0) continue;
          if (s.noteT < s.noteDur) {
            const x = s.noteT / s.noteDur;
            const env = sin01(x * 0.5); // half sine
            s.vph += s.vibHz * dt;
            if (s.vph >= 1) s.vph -= 1;
            const f = (s.f0 + s.df * x) * (1 + s.vibDepth * sin01(s.vph)) * pitch;
            s.ph += f / sr;
            if (s.ph >= 1) s.ph -= 1;
            const v = s.lp.tick(sin01(s.ph) * env * env * s.gain * bLv * 0.11);
            l += v * s.panL;
            r += v * s.panR;
            s.noteT += dt;
          } else {
            s.gap -= dt;
            s.lp.tick(0);
            if (s.gap <= 0) {
              s.notesLeft--;
              if (s.notesLeft > 0) this.nextNote(s, false);
            }
          }
        }
      }
      // crickets: 3-pulse chirps every ~0.55 s, two individuals
      if (crLv > 1e-4) {
        this.crT += dt;
        if (this.crT >= 0.55) this.crT -= 0.55;
        const pulse = this.crT < 0.12 ? sin01(((this.crT % 0.04) / 0.04) * 0.5) : 0;
        this.crPh += 4300 * dt;
        if (this.crPh >= 1) this.crPh -= 1;
        this.crPh2 += 4520 * dt;
        if (this.crPh2 >= 1) this.crPh2 -= 1;
        const t2 = (this.crT + 0.23) % 0.55;
        const pulse2 = t2 < 0.12 ? sin01(((t2 % 0.04) / 0.04) * 0.5) : 0;
        const c1 = sin01(this.crPh) * pulse * crLv * 0.018;
        const c2 = sin01(this.crPh2) * pulse2 * crLv * 0.012;
        l += c1 * 0.8 + c2 * 0.4;
        r += c1 * 0.4 + c2 * 0.8;
      }
      // water lapping
      if (wLv > 1e-4) {
        const ph = this.waterT;
        const target = ph > 0.25 ? 0.15 : 1;
        this.waterEnv += (target - this.waterEnv) * 0.0004;
        this.waterLp.tick(rng.white());
        const v = this.waterLp.lp * this.waterEnv * wLv * 0.35;
        l += v;
        r += v * 0.85;
      }
      outL[i] = l;
      outR[i] = r;
    }
    lv[0] = tg0;
    lv[1] = tg1;
    lv[2] = tg2;
    lv[3] = tg3;
  }
}
