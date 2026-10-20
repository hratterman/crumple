/**
 * Tyre / road / body-contact / wind synthesis for the player car (P8 audio).
 * PURE, allocation-free after construction (runs in the `crumple-surface`
 * worklet, in node renders and in tests).
 *
 * Output 0 (mono, at the car): tyre squeal per axle (noise-excited resonant
 * partials + a jittered tonal core whose pitch follows slip and load, with
 * stick-slip amplitude flutter), burnout scrub hiss, road roar (+ tread hum),
 * gravel / dirt / grass rumble, body scrape / grind (inharmonic metal modes
 * + grit), suspension thumps and bump-stop knocks.
 * Output 1 (stereo): wind (decorrelated L/R, gusting, whistle at speed).
 */
import { clamp01, Noise, OnePole, sin01, softClip, Svf } from './core';

export interface SurfaceInput {
  pitch: number;
  /** Ground speed, m/s. */
  speed: number;
  /** Squeal level per axle (0..1, already through the slip → gain curve). */
  squealF: number;
  squealR: number;
  /** Squeal pitch factor per axle (≈ 0.9..1.25: slip speed and load). */
  squealPitchF: number;
  squealPitchR: number;
  /** The car's tyre base pitch, Hz. */
  squealHz: number;
  /** Broadband slip hiss (burnouts, big slides), 0..1. */
  scrub: number;
  /** Road roar level 0..1 (speed + surface). */
  roar: number;
  /** Roar brightness: 0 smooth asphalt … 1 coarse concrete. */
  roarTone: number;
  gravel: number;
  dirt: number;
  grass: number;
  /** Body scrape / grind 0..1 and its sliding speed, m/s. */
  scrape: number;
  scrapeSpeed: number;
  /** Thump trigger: a new value of `thumpCount` fires a thump of `thumpAmp` (0..1, > 0.6 adds the bump-stop knock). */
  thumpCount: number;
  thumpAmp: number;
  wind: number;
  windSpeed: number;
}

export function createSurfaceInput(): SurfaceInput {
  return {
    pitch: 1,
    speed: 0,
    squealF: 0,
    squealR: 0,
    squealPitchF: 1,
    squealPitchR: 1,
    squealHz: 900,
    scrub: 0,
    roar: 0,
    roarTone: 0,
    gravel: 0,
    dirt: 0,
    grass: 0,
    scrape: 0,
    scrapeSpeed: 0,
    thumpCount: 0,
    thumpAmp: 0,
    wind: 0,
    windSpeed: 0,
  };
}

const METAL_MODES = [1170, 2380, 3510, 5230];

class Squeal {
  ph = 0;
  ph2 = 0;
  drift = 0;
  driftT = 0;
  driftTarget = 0;
  readonly jit = new OnePole();
  readonly am = new OnePole();
  readonly r1 = new Svf();
  readonly r2 = new Svf();
  readonly r3 = new Svf();
  level = 0;
}

export class SurfaceDsp {
  readonly sr: number;
  private readonly rng: Noise;
  private readonly sq = [new Squeal(), new Squeal()];
  private readonly scrubBp = new Svf();
  private readonly roarBrown = new OnePole();
  private readonly roarLp = new Svf();
  private readonly roarHp = new Svf();
  private treadPh = 0;
  private readonly gravBp1 = new Svf();
  private readonly gravBp2 = new Svf();
  private readonly rumbleLp = new Svf();
  private readonly dirtBp = new Svf();
  private readonly grassHp = new Svf();
  private readonly grassAm = new OnePole();
  private readonly modes: Svf[] = METAL_MODES.map(() => new Svf());
  private readonly scrapeAm = new OnePole();
  private readonly gritBp = new Svf();
  private thumpCount = 0;
  private thumpEnv = 0;
  private thumpPh = 0;
  private thumpF = 80;
  private clickEnv = 0;
  private knockImp = 0;
  private readonly knock1 = new Svf();
  private readonly knock2 = new Svf();
  private readonly clickLp = new OnePole();
  private readonly windL = new Svf();
  private readonly windR = new Svf();
  private readonly windHpL = new Svf();
  private readonly windHpR = new Svf();
  private readonly whistle = new Svf();
  private gust = 0;
  private gustTarget = 0;
  private gustT = 0;
  // ramped levels
  private lv = new Float64Array(12);

  constructor(sampleRate: number, seed = 3) {
    this.sr = sampleRate;
    this.rng = new Noise(seed * 747796405 + 1);
    this.sq[0]!.jit.setHz(35, sampleRate);
    this.sq[1]!.jit.setHz(31, sampleRate);
    this.sq[0]!.am.setHz(28, sampleRate);
    this.sq[1]!.am.setHz(24, sampleRate);
    this.roarBrown.setHz(180, sampleRate);
    this.grassAm.setHz(3, sampleRate);
    this.scrapeAm.setHz(9, sampleRate);
    this.clickLp.setHz(2600, sampleRate);
  }

  /** Renders `n` samples: `tyres` (mono, written) and `windL` / `windR` (written). */
  process(tyres: Float32Array, windL: Float32Array, windR: Float32Array, n: number, inp: SurfaceInput): void {
    const sr = this.sr;
    const rng = this.rng;
    const pitch = Math.min(Math.max(inp.pitch, 0.25), 4);
    const blockS = n / sr;
    const speed = Math.max(0, inp.speed);
    const sN = clamp01(speed / 40);

    // ---- block coefficients
    for (let a = 0; a < 2; a++) {
      const s = this.sq[a]!;
      s.driftT -= blockS;
      if (s.driftT <= 0) {
        s.driftTarget = rng.white();
        s.driftT = 0.08 + 0.25 * rng.next();
      }
      s.drift += (s.driftTarget - s.drift) * Math.min(1, blockS * 6);
      const pf = a === 0 ? inp.squealPitchF : inp.squealPitchR * 0.94;
      const f = inp.squealHz * pf * (1 + 0.06 * s.drift) * pitch;
      s.r1.set(f, 28, sr);
      s.r2.set(f * 2.03, 22, sr);
      s.r3.set(f * 3.07, 16, sr);
    }
    this.scrubBp.set(2600 * pitch, 0.6, sr);
    const roarHz = (260 + 30 * speed) * (1 + 0.6 * inp.roarTone) * pitch;
    this.roarLp.set(Math.min(roarHz, 6000), 0.6, sr);
    this.roarHp.set(55 * pitch, 0.7, sr);
    const treadHz = Math.min(speed / 0.034, 1400) * pitch;
    this.gravBp1.set(2900 * pitch, 2.2, sr);
    this.gravBp2.set(1150 * pitch, 2.5, sr);
    this.rumbleLp.set((70 + 2.5 * speed) * pitch, 0.8, sr);
    this.dirtBp.set(700 * pitch, 1.6, sr);
    this.grassHp.set(2200 * pitch, 0.7, sr);
    const sc = 0.85 + 0.35 * clamp01(inp.scrapeSpeed / 20);
    for (let k = 0; k < this.modes.length; k++) this.modes[k]!.set(METAL_MODES[k]! * sc * pitch, 34, sr);
    this.gritBp.set(4200 * pitch, 1.2, sr);
    this.knock1.set(310 * pitch, 7, sr);
    this.knock2.set(780 * pitch, 10, sr);
    const windHz = Math.min(220 + 48 * inp.windSpeed, 5200) * pitch;
    this.windL.set(windHz, 0.6, sr);
    this.windR.set(windHz * 1.07, 0.6, sr);
    this.windHpL.set(70 * pitch, 0.7, sr);
    this.windHpR.set(70 * pitch, 0.7, sr);
    this.whistle.set((1100 + 14 * inp.windSpeed) * pitch, 9, sr);
    this.gustT -= blockS;
    if (this.gustT <= 0) {
      this.gustTarget = rng.next();
      this.gustT = 0.6 + 1.8 * rng.next();
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, blockS * 1.2);
    const whistleAmt = clamp01((inp.windSpeed - 24) / 30) * 0.35;

    // thump trigger
    if (inp.thumpCount !== this.thumpCount) {
      this.thumpCount = inp.thumpCount;
      const a = clamp01(inp.thumpAmp);
      this.thumpEnv = Math.max(this.thumpEnv, a);
      this.thumpF = (70 + 30 * a) * pitch;
      this.clickEnv = Math.max(this.clickEnv, a * 0.7);
      if (a > 0.6) this.knockImp += (a - 0.5) * 2;
    }
    const thumpDecay = Math.exp(-1 / ((0.085 / pitch) * sr));
    const clickDecay = Math.exp(-1 / ((0.004 / pitch) * sr));
    const thumpGlide = Math.exp(-1 / ((0.05 / pitch) * sr));
    const thumpF1 = 46 * pitch;

    // ramp targets
    const tgt = this.tmpTargets;
    tgt[0] = clamp01(inp.squealF);
    tgt[1] = clamp01(inp.squealR);
    tgt[2] = clamp01(inp.scrub);
    tgt[3] = clamp01(inp.roar);
    tgt[4] = clamp01(inp.gravel);
    tgt[5] = clamp01(inp.dirt);
    tgt[6] = clamp01(inp.grass);
    tgt[7] = clamp01(inp.scrape);
    tgt[8] = clamp01(inp.wind);
    const lv = this.lv;
    const invN = 1 / n;
    const gravelRate = (30 + 22 * speed) * pitch / sr;
    const dirtRate = (12 + 8 * speed) * pitch / sr;
    const gritRate = (120 + 25 * inp.scrapeSpeed) * pitch / sr;

    for (let i = 0; i < n; i++) {
      const u = (i + 1) * invN;
      const sqF = lv[0]! + (tgt[0]! - lv[0]!) * u;
      const sqR = lv[1]! + (tgt[1]! - lv[1]!) * u;
      const scrub = lv[2]! + (tgt[2]! - lv[2]!) * u;
      const roar = lv[3]! + (tgt[3]! - lv[3]!) * u;
      const grav = lv[4]! + (tgt[4]! - lv[4]!) * u;
      const dirt = lv[5]! + (tgt[5]! - lv[5]!) * u;
      const grass = lv[6]! + (tgt[6]! - lv[6]!) * u;
      const scr = lv[7]! + (tgt[7]! - lv[7]!) * u;
      const wind = lv[8]! + (tgt[8]! - lv[8]!) * u;
      let out = 0;

      // ---- squeal
      for (let a = 0; a < 2; a++) {
        const level = a === 0 ? sqF : sqR;
        if (level < 1e-4) continue;
        const s = this.sq[a]!;
        const j = s.jit.tick(rng.white());
        const pf = a === 0 ? inp.squealPitchF : inp.squealPitchR * 0.94;
        const f = inp.squealHz * pf * (1 + 0.06 * s.drift + 0.12 * j) * pitch;
        s.ph += f / sr;
        if (s.ph >= 1) s.ph -= 1;
        s.ph2 += (2 * f) / sr;
        if (s.ph2 >= 1) s.ph2 -= 1;
        const tone = sin01(s.ph) * 0.6 + sin01(s.ph2) * 0.22;
        const x = rng.white();
        s.r1.tick(x);
        s.r2.tick(x);
        s.r3.tick(x);
        const am = 0.6 + 0.4 * Math.abs(s.am.tick(rng.white()) * 6);
        out += (tone * 0.5 + s.r1.bpn * 1.1 + s.r2.bpn * 0.45 + s.r3.bpn * 0.2) * am * level * 0.55;
      }
      if (scrub > 1e-4) {
        this.scrubBp.tick(rng.white());
        out += this.scrubBp.bpn * scrub * 0.35;
      }

      // ---- road roar + tread hum
      if (roar > 1e-4) {
        const br = this.roarBrown.tick(rng.white());
        this.roarLp.tick(br * 3 + rng.white() * 0.12);
        this.roarHp.tick(this.roarLp.lp);
        this.treadPh += treadHz / sr;
        if (this.treadPh >= 1) this.treadPh -= 1;
        out += (this.roarHp.hp * 0.9 + sin01(this.treadPh) * 0.03) * roar;
      }

      // ---- gravel / dirt / grass
      if (grav > 1e-4 || dirt > 1e-4 || grass > 1e-4) {
        let imp = 0;
        if (grav > 1e-4 && rng.next() < gravelRate) imp += (0.4 + rng.next()) * grav;
        let dimp = 0;
        if (dirt > 1e-4 && rng.next() < dirtRate) dimp = (0.3 + rng.next()) * dirt;
        this.gravBp1.tick(imp + rng.white() * grav * 0.05);
        this.gravBp2.tick(imp * 0.7);
        this.dirtBp.tick(dimp);
        this.rumbleLp.tick(rng.white());
        const rumble = this.rumbleLp.lp * (grav * 0.9 + dirt * 1.3 + grass * 0.5) * (0.4 + sN);
        this.grassHp.tick(rng.white());
        const swish = this.grassHp.hp * grass * (0.5 + 0.5 * Math.abs(this.grassAm.tick(rng.white()) * 8)) * 0.12;
        out += this.gravBp1.bpn * 0.55 + this.gravBp2.bpn * 0.45 + this.dirtBp.bpn * 0.6 + rumble * 0.7 + swish;
      }

      // ---- scrape / grind
      if (scr > 1e-4) {
        const x = rng.white();
        let m = 0;
        for (let k = 0; k < this.modes.length; k++) {
          const md = this.modes[k]!;
          md.tick(x);
          m += md.bpn * (k === 0 ? 0.9 : k === 1 ? 0.7 : k === 2 ? 0.5 : 0.35);
        }
        const grit = rng.next() < gritRate ? rng.white() * 3 : 0;
        this.gritBp.tick(grit + x * 0.15);
        const am = 0.55 + 0.45 * Math.abs(this.scrapeAm.tick(rng.white()) * 10);
        out += (m * 0.55 + this.gritBp.bpn * 0.5) * scr * am;
      }

      // ---- thumps / bump-stop knocks
      if (this.thumpEnv > 1e-4 || this.clickEnv > 1e-4 || this.knockImp !== 0) {
        this.thumpF = thumpF1 + (this.thumpF - thumpF1) * thumpGlide;
        this.thumpPh += this.thumpF / sr;
        if (this.thumpPh >= 1) this.thumpPh -= 1;
        out += sin01(this.thumpPh) * this.thumpEnv * 0.8;
        this.thumpEnv *= thumpDecay;
        out += this.clickLp.tick(rng.white() * this.clickEnv) * 0.6;
        this.clickEnv *= clickDecay;
        const ki = this.knockImp;
        this.knockImp = 0;
        this.knock1.tick(ki);
        this.knock2.tick(ki);
        out += this.knock1.bp * 0.5 + this.knock2.bp * 0.3;
      }
      tyres[i] = softClip(out * 1.1) * 0.9;

      // ---- wind (stereo)
      if (wind > 1e-4) {
        const g = wind * (0.75 + 0.5 * this.gust);
        this.windL.tick(rng.white());
        this.windR.tick(rng.white());
        this.windHpL.tick(this.windL.lp);
        this.windHpR.tick(this.windR.lp);
        let w = 0;
        if (whistleAmt > 0) {
          this.whistle.tick(rng.white());
          w = this.whistle.bpn * whistleAmt;
        }
        windL[i] = softClip((this.windHpL.hp + w) * g * 0.9);
        windR[i] = softClip((this.windHpR.hp + w * 0.8) * g * 0.9);
      } else {
        windL[i] = 0;
        windR[i] = 0;
      }
    }
    for (let k = 0; k < 9; k++) lv[k] = tgt[k]!;
  }

  private readonly tmpTargets = new Float64Array(12);
}
