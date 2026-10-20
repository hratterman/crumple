/**
 * Firing-order engine synthesis (P8 audio). PURE + allocation-free after
 * construction; runs inside the `crumple-engine` AudioWorklet processor, in
 * node for the WAV renders / tests, and offline for the plain-node fallback.
 *
 * MODEL (per sample):
 *   crank phase → each cylinder fires at its slot of the 720° cycle (real
 *   firing order, per-slot gain + timing offsets, per-cycle combustion
 *   variability, jitter, misfires). A firing deposits a sub-sample-accurate
 *   impulse into its exhaust BANK and into the intake:
 *   EXHAUST per bank: pulse shaper (difference of exponentials: fast attack,
 *     decay over `pulseDeg` crank degrees, so width ∝ 1/rpm) + blowdown rasp
 *     (noise gated by the pulse, ∝ load²) → pipe waveguide (delay 2L/c with
 *     an open-end reflection and loop losses: the pipe's comb of resonances)
 *     → banks summed → muffler low-pass (opens with load) → body resonance →
 *     DC block. Overrun pops / crackle are noise bangs fed into the pipes.
 *   INTAKE: suction pulses → airbox Helmholtz band-pass + induction roar
 *     (noise ∝ throttle·load, riding the pulses).
 *   MECH: valve-train ticks, diesel knock exciting three block modes, gear
 *     whine, heat-shield rattle, turbo whistle (spool lag) + blow-off /
 *     wastegate flutter on lift-off, starter motor while cranking.
 *   Two outputs: exhaust (rear of the car) and intake + mechanical (front).
 *
 * TIME SCALE: `pitch` scales every frequency and time constant of the voice
 * (manual Doppler × slow-mo pitch): the whole engine is played faster/slower
 * like a tape, which keeps the timbre consistent.
 */
import type { EngineProfile } from '../profiles';
import { Biquad, clamp01, DcBlock, Delay, Noise, OnePole, sin01, softClip, Svf } from './core';

/** Block inputs (targets for the END of the block; ramped from the previous block's values). */
export interface EngineInput {
  rpm: number;
  throttle: number;
  /** 0..1 engine load (torque / peak, or throttle when unknown). */
  load: number;
  /** 0..1 master gate (voice on/off fade). */
  gate: number;
  /** Frequency / time scale of the whole voice (Doppler × slow-mo). */
  pitch: number;
  /** ≥ 0.5: hard against the rev limiter (fuel-cut bounce). */
  limiter: number;
  /** ≥ 0.5: starter cranking (no combustion, starter motor). */
  crank: number;
  /** ≥ 0.5: gear change in progress (ignition cut "brap" on sporty engines). */
  shift: number;
  /** 0..1 vehicle damage (adds misfires and roughness). */
  damage: number;
}

export function createEngineInput(): EngineInput {
  return { rpm: 800, throttle: 0, load: 0, gate: 1, pitch: 1, limiter: 0, crank: 0, shift: 0, damage: 0 };
}

const SPEED_OF_SOUND = 343;
const MAX_PIPE_M = 4.5;

export class EngineDsp {
  readonly sr: number;
  private p: EngineProfile;
  /** Light voice (traffic): one bank, no mechanical layer, intake folded into the exhaust output. */
  readonly light: boolean;
  private readonly rng: Noise;

  // ---- firing schedule
  private cyc = 0;
  private slot = 0;
  private nextPos = 0;
  private readonly slotPos: Float64Array;

  // ---- ramped inputs (previous block end values)
  private rpm0 = 800;
  private thr0 = 0;
  private load0 = 0;
  private gate0 = 0;
  private pitch0 = 1;

  // ---- exhaust per bank
  private readonly excCur = new Float64Array(2);
  private readonly excNext = new Float64Array(2);
  private readonly pulseD = new Float64Array(2);
  private readonly pulseA = new Float64Array(2);
  private readonly raspEnv = new Float64Array(2);
  private readonly popEnv = new Float64Array(2);
  private readonly pipe: Delay[];
  private readonly loop: OnePole[];
  private readonly rasp: Svf[];
  private readonly muffler = new Svf();
  private readonly body = new Biquad();
  private readonly dc = new DcBlock();
  private readonly dc2 = new DcBlock();
  private readonly popTone = new OnePole();
  private bodyPitch = -1;

  // ---- intake
  private inCur = 0;
  private inNext = 0;
  private inD = 0;
  private inA = 0;
  private readonly helm = new Svf();
  private readonly roar = new Svf();
  private readonly dcIn = new DcBlock();

  // ---- mechanical
  private tickEnv = 0;
  private readonly tickHp = new Svf();
  private clatImp = 0;
  private readonly clat: Svf[];
  private whinePh = 0;
  private readonly rattle = new Svf();
  private rattleEnv = 0;
  private boost = 0;
  private whPh = 0;
  private whPh2 = 0;
  private readonly whNoise = new Svf();
  private dumpEnv = 0;
  private dumpPh = 0;
  private readonly dumpBp = new Svf();
  private starterPh = 0;
  private starterEnv = 0;
  private readonly starterLp = new OnePole();

  // ---- state machines
  private lope = 0;
  private lopeTarget = 0;
  private lopeT = 0;
  private limPh = 0;
  private cutSmooth = 0;
  private liftAge = 10;
  private thrPeak = 0;
  private shiftPrev = 0;
  private outGain = 0;

  constructor(profile: EngineProfile, sampleRate: number, seed = 1, light = false) {
    this.sr = sampleRate;
    this.p = profile;
    this.light = light;
    this.rng = new Noise(seed * 2654435761);
    this.slotPos = new Float64Array(16);
    const cap = Math.ceil(((2 * MAX_PIPE_M) / SPEED_OF_SOUND) * sampleRate * 4) + 8; // pitch down to 0.25
    this.pipe = [new Delay(cap), new Delay(cap)];
    this.loop = [new OnePole(), new OnePole()];
    this.rasp = [new Svf(), new Svf()];
    this.clat = [new Svf(), new Svf(), new Svf()];
    this.setProfile(profile);
  }

  get profile(): EngineProfile {
    return this.p;
  }

  setProfile(p: EngineProfile): void {
    this.p = p;
    const n = Math.min(16, p.cylinders);
    for (let k = 0; k < n; k++) this.slotPos[k] = k / n + (p.cylTiming[k] ?? 0) / 720;
    this.slot = 0;
    this.cyc = 0;
    this.nextPos = this.slotPos[0]!;
    this.rpm0 = p.idleRpm;
    this.bodyPitch = -1;
  }

  /**
   * Renders `n` samples into `exhaust` and `front` (intake + mechanical;
   * may be the same array as `exhaust` for a mono mix — then both add).
   * Arrays are written (not accumulated) unless they alias.
   */
  process(exhaust: Float32Array, front: Float32Array, n: number, inp: EngineInput): void {
    const p = this.p;
    const sr = this.sr;
    const rng = this.rng;
    const light = this.light;
    const alias = exhaust === front;
    const cyl = Math.min(16, p.cylinders);

    const rpm1 = Math.max(0, inp.rpm);
    const thr1 = clamp01(inp.throttle);
    const load1 = clamp01(inp.load);
    const gate1 = clamp01(inp.gate);
    const pitch1 = Math.min(Math.max(inp.pitch, 0.25), 4);
    const crank = inp.crank >= 0.5;
    const limiter = inp.limiter >= 0.5;
    const rpm0 = this.rpm0;
    const pitch = pitch1; // per-block (coefficients)

    // ---- block-rate state machines
    const blockS = n / sr;
    if (thr1 > this.thrPeak) this.thrPeak = thr1;
    if (this.thrPeak > 0.45 && thr1 < 0.08) {
      this.liftAge = 0;
      // turbo dump on lift-off with boost up
      if (p.turbo && this.boost > 0.3 && !light) this.dumpEnv = Math.max(this.dumpEnv, this.boost);
    }
    if (thr1 < 0.08) this.thrPeak = thr1;
    else this.thrPeak = Math.max(this.thrPeak * 0.995, thr1);
    this.liftAge += blockS;
    if (inp.shift >= 0.5 && this.shiftPrev < 0.5 && p.pops > 0.5 && thr1 > 0.5) {
      // upshift ignition cut: one fat "brap"
      this.popEnv[0] = 2.2;
      this.popEnv[1] = 1.8;
    }
    this.shiftPrev = inp.shift;
    // idle lope: a slow random walk around idle, only near idle
    this.lopeT -= blockS;
    if (this.lopeT <= 0) {
      this.lopeTarget = rng.white();
      this.lopeT = 0.25 + 0.5 * rng.next();
    }
    this.lope += (this.lopeTarget - this.lope) * Math.min(1, blockS * 3);
    const idleW = clamp01(1 - (rpm1 - p.idleRpm) / (p.idleRpm * 0.8));
    const rpmN = clamp01(rpm1 / p.redlineRpm);
    // turbo spool
    if (p.turbo) {
      const t = p.turbo;
      const target = clamp01((rpm1 - t.spoolRpm[0]) / (t.spoolRpm[1] - t.spoolRpm[0])) * clamp01(thr1 * 1.25);
      const tau = target > this.boost ? t.lag : 0.22;
      this.boost += (target - this.boost) * (1 - Math.exp(-blockS / tau));
    }

    // ---- per-block coefficients
    const tauD = Math.min(Math.max(p.pulseDeg / (6 * Math.max(rpm1, 60)), 0.00025), 0.014) / pitch;
    const attackMs = p.attackMs[0] + (p.attackMs[1] - p.attackMs[0]) * load1;
    const ed = Math.exp(-1 / (tauD * sr));
    const ea = Math.exp(-1 / ((attackMs / 1000 / pitch) * sr));
    const raspDecay = Math.exp(-1 / (tauD * 0.45 * sr));
    const ex = p.exhaust;
    for (let b = 0; b < 2; b++) {
      this.loop[b]!.setHz(ex.loopHz * pitch, sr);
      this.rasp[b]!.set(ex.raspHz * pitch * (0.8 + 0.4 * load1), 0.6, sr);
    }
    const pipeD0 = ((2 * ex.pipeM[0]) / SPEED_OF_SOUND) * sr / pitch;
    const pipeD1 = ((2 * ex.pipeM[1]) / SPEED_OF_SOUND) * sr / pitch;
    const overrunNow = thr1 < 0.04 && rpm1 > p.idleRpm * 1.35 && !crank;
    const muffHz = ex.lowpassHz * (overrunNow ? 0.75 : 0.95 + 0.6 * load1) * pitch;
    this.muffler.set(muffHz, 0.7, sr);
    if (Math.abs(this.bodyPitch - pitch) > 0.002) {
      this.body.peaking(ex.bodyHz * pitch, 1.1, ex.bodyDb, sr);
      this.bodyPitch = pitch;
      this.dc.setHz(26 * pitch, sr);
      this.dc2.setHz(26 * pitch, sr);
      this.dcIn.setHz(40 * pitch, sr);
      this.popTone.setHz(5200 * pitch, sr);
    }
    const inTauD = tauD * 1.7;
    const ied = Math.exp(-1 / (inTauD * sr));
    const iea = Math.exp(-1 / ((0.5 / 1000 / pitch) * sr));
    const it = p.intake;
    this.helm.set(it.helmHz * (1 + 0.28 * rpmN) * pitch, it.q, sr);
    this.roar.set(it.roarHz * (0.85 + 0.3 * rpmN) * pitch, 0.8, sr);
    const m = p.mech;
    if (!light) {
      this.tickHp.set(4800 * pitch, 0.8, sr);
      this.clat[0]!.set(m.clatterHz[0] * pitch, 9, sr);
      this.clat[1]!.set(m.clatterHz[1] * pitch, 12, sr);
      this.clat[2]!.set(m.clatterHz[2] * pitch, 14, sr);
      this.rattle.set(640 * pitch, 7, sr);
      this.dumpBp.set((p.turbo?.dump === 'flutter' ? 1300 : 3200) * pitch, 0.8, sr);
      this.starterLp.setHz(1800 * pitch, sr);
    }
    const tickDecay = Math.exp(-1 / (0.0006 / pitch * sr));
    const popDecay = Math.exp(-1 / (0.0035 / pitch * sr));
    const rattleDecay = Math.exp(-1 / (0.012 / pitch * sr));
    const dumpDecay = Math.exp(-blockS / (p.turbo?.dump === 'flutter' ? 0.45 : 0.32));
    const rattleW = m.rattle > 0 ? clamp01(1 - Math.abs((rpm1 - (m.rattleRpm[0] + m.rattleRpm[1]) / 2) / ((m.rattleRpm[1] - m.rattleRpm[0]) / 2))) : 0;
    let whF = 0;
    let whF2 = 0;
    let whAmp = 0;
    if (p.turbo && !light) {
      const t = p.turbo;
      whF = (t.whistleHz[0] + (t.whistleHz[1] - t.whistleHz[0]) * this.boost) * pitch;
      whF2 = whF * 1.505;
      whAmp = t.gain * Math.pow(this.boost, 1.6);
      this.whNoise.set(whF, 14, sr);
    }
    const gainTarget = gate1;
    const outStep = (gainTarget - this.outGain) / n;
    // starter envelope (block rate)
    this.starterEnv += ((crank ? 1 : 0) - this.starterEnv) * Math.min(1, blockS * (crank ? 30 : 9));

    const invN = 1 / n;
    let x0 = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) * invN;
      let rpm = rpm0 + (rpm1 - rpm0) * t;
      const thr = this.thr0 + (thr1 - this.thr0) * t;
      const load = this.load0 + (load1 - this.load0) * t;
      // idle lope + limiter bounce
      rpm += p.idleLope * this.lope * idleW;
      if (limiter) {
        this.limPh += (11 * pitch) / sr;
        if (this.limPh >= 1) this.limPh -= 1;
      }
      const cutting = limiter && this.limPh < 0.42;
      this.cutSmooth += ((cutting ? 1 : 0) - this.cutSmooth) * (40 * pitch / sr);
      rpm -= 260 * this.cutSmooth * (p.revLimitRpm / 7000);
      if (rpm < 0) rpm = 0;

      // ---- crank phase + firing
      const inc = ((rpm / 120) * pitch) / sr;
      this.cyc += inc;
      while (inc > 0 && this.cyc >= this.nextPos) {
        const frac = (this.cyc - this.nextPos) / inc; // how far past the firing point (0..1 sample)
        this.fire(this.slot, frac < 0 ? 0 : frac > 1 ? 1 : frac, rpm, thr, load, crank, cutting, inp.damage, idleW, rpmN);
        this.slot++;
        if (this.slot >= cyl) {
          this.slot = 0;
          this.cyc -= 1;
        }
        const jit = (p.jitterDeg * (1 + idleW) * rng.white()) / 720;
        this.nextPos = this.slotPos[this.slot]! + jit;
      }

      // ---- exhaust banks
      let exh = 0;
      for (let b = 0; b < (light ? 1 : 2); b++) {
        const x = this.excCur[b]!;
        this.excCur[b] = this.excNext[b]!;
        this.excNext[b] = 0;
        this.pulseD[b] = this.pulseD[b]! * ed + x;
        this.pulseA[b] = this.pulseA[b]! * ea + x;
        const pulse = this.pulseD[b]! - this.pulseA[b]!;
        let e = pulse;
        if (!light) {
          const re = this.raspEnv[b]!;
          if (re > 1e-5) {
            const rs = this.rasp[b]!;
            rs.tick(rng.white() * re);
            e += rs.bpn;
            this.raspEnv[b] = re * raspDecay;
          }
          const pe = this.popEnv[b]!;
          if (pe > 1e-4) {
            e += rng.white() * pe;
            this.popEnv[b] = pe * popDecay;
          }
        }
        const pd = b === 0 ? pipeD0 : pipeD1;
        const fb = this.loop[b]!.tick(this.pipe[b]!.read(pd));
        const s = e + ex.reflect * fb;
        this.pipe[b]!.write(s);
        exh += b === 0 ? s : s * p.bankBalance;
      }
      this.muffler.tick(exh);
      let ev = this.body.tick(this.muffler.lp);
      // pops and crackle bypass the muffler (straight out of the tailpipe)
      if (!light && (this.popEnv[0]! > 1e-3 || this.popEnv[1]! > 1e-3)) {
        ev += this.popTone.tick(rng.white() * (this.popEnv[0]! + this.popEnv[1]!) * 0.3);
      }
      ev = this.dc2.tick(this.dc.tick(ev)) * ex.gain;

      // ---- intake
      const xi = this.inCur;
      this.inCur = this.inNext;
      this.inNext = 0;
      this.inD = this.inD * ied + xi;
      this.inA = this.inA * iea + xi;
      const ip = this.inD - this.inA;
      this.helm.tick(ip);
      let fr = this.helm.bpn * it.pulse + ip * 0.22;
      if (!light) {
        const roarAmt = thr * (0.25 + 0.75 * load) * (0.35 + 0.65 * Math.min(1, Math.abs(ip) * 1.5));
        if (roarAmt > 1e-4) {
          this.roar.tick(rng.white() * roarAmt);
          fr += this.roar.bpn * it.roar;
        }
      }
      fr = this.dcIn.tick(fr) * it.gain;

      // ---- mechanical (front)
      if (!light) {
        if (this.tickEnv > 1e-5) {
          this.tickHp.tick(rng.white() * this.tickEnv);
          fr += this.tickHp.hp * m.tick;
          this.tickEnv *= tickDecay;
        }
        if (m.clatter > 0) {
          const ci = this.clatImp;
          this.clatImp = 0;
          this.clat[0]!.tick(ci);
          this.clat[1]!.tick(ci);
          this.clat[2]!.tick(ci);
          fr += (this.clat[0]!.bp * 0.9 + this.clat[1]!.bp * 0.7 + this.clat[2]!.bp * 0.45) * m.clatter;
        }
        if (m.whine > 0) {
          this.whinePh += ((rpm / 60) * m.whineOrder * pitch) / sr;
          if (this.whinePh >= 1) this.whinePh -= Math.floor(this.whinePh);
          fr += sin01(this.whinePh) * m.whine * (0.3 + 0.7 * rpmN);
        }
        if (rattleW > 0) {
          const drive = Math.abs(ev) - 0.12;
          if (drive > 0) this.rattleEnv = Math.min(1, this.rattleEnv + drive * 0.6);
          this.rattle.tick(rng.white() * this.rattleEnv);
          fr += this.rattle.bp * m.rattle * rattleW * 2.2;
          this.rattleEnv *= rattleDecay;
        }
        if (whAmp > 1e-4) {
          this.whPh += whF / sr;
          if (this.whPh >= 1) this.whPh -= 1;
          this.whPh2 += whF2 / sr;
          if (this.whPh2 >= 1) this.whPh2 -= 1;
          this.whNoise.tick(rng.white());
          fr += whAmp * (sin01(this.whPh) * 0.5 + sin01(this.whPh2) * 0.04 + this.whNoise.bpn * 0.6);
        }
        if (this.dumpEnv > 1e-3 && p.turbo) {
          let d = rng.white() * this.dumpEnv;
          if (p.turbo.dump === 'flutter') {
            this.dumpPh += (19 * pitch) / sr;
            if (this.dumpPh >= 1) this.dumpPh -= 1;
            const flutter = this.dumpPh < 0.35 ? 1 : 0.15;
            d *= flutter;
          }
          this.dumpBp.tick(d);
          fr += this.dumpBp.bpn * p.turbo.dumpGain;
        }
        if (this.starterEnv > 1e-3) {
          // starter: ~12× crank speed motor, commutator buzz + pinion whine, loaded by compression
          const comp = 0.75 + 0.25 * Math.abs(this.pulseD[0]! - this.pulseA[0]!);
          this.starterPh += (((rpm / 60) * 12 + 8) * pitch) / sr;
          if (this.starterPh >= 1) this.starterPh -= Math.floor(this.starterPh);
          const ph = this.starterPh;
          const buzz = sin01(ph) * 0.5 + sin01((ph * 2) % 1) * 0.3 + sin01((ph * 8) % 1) * 0.35 + sin01((ph * 9) % 1) * 0.25 + rng.white() * 0.15;
          fr += this.starterLp.tick(buzz) * 0.28 * this.starterEnv * comp;
        }
      }

      // ---- outputs
      this.outGain += outStep;
      const g = this.outGain;
      if (light) {
        exhaust[i] = softClip((ev + fr * 0.6) * g * 1.15) * 0.87;
      } else if (alias) {
        exhaust[i] = softClip((ev + fr) * g * 1.15) * 0.87;
      } else {
        exhaust[i] = softClip(ev * g * 1.15) * 0.87;
        front[i] = softClip(fr * g * 1.15) * 0.87;
      }
      x0 = ev;
    }
    void x0;
    this.dumpEnv *= dumpDecay;
    this.rpm0 = rpm1;
    this.thr0 = thr1;
    this.load0 = load1;
    this.gate0 = gate1;
    this.pitch0 = pitch1;
  }

  private fire(slot: number, frac: number, rpm: number, thr: number, load: number, crank: boolean, cut: boolean, damage: number, idleW: number, rpmN: number): void {
    const p = this.p;
    const rng = this.rng;
    const overrun = thr < 0.04 && rpm > p.idleRpm * 1.35 && !crank;
    let a: number;
    if (crank) a = 0.32; // compression release, no combustion
    else if (overrun) a = 0.2; // pumping only (fuel cut): hollow, darker
    else a = 0.24 + 0.76 * Math.pow(load, 0.85);
    // loudness rises with rpm (more mass flow)
    a *= 0.5 + 0.5 * Math.min(1, rpm / p.redlineRpm + 0.1);
    a *= p.cylGain[slot] ?? 1;
    if (!crank) {
      const v = p.cycleVar * (1 + idleW + damage * 2);
      a *= Math.max(0.15, 1 + v * rng.gauss());
      const mis = p.misfire * (1 - 0.5 * load) + damage * damage * 0.08;
      if (mis > 0 && rng.next() < mis) a *= 0.04;
      if (cut) a *= 0.06;
    }
    const b = this.light ? 0 : (p.banks[slot] ?? 0);
    // sub-sample placement: the impulse lies `frac` samples before this one (delayed one sample)
    this.excCur[b] = this.excCur[b]! + a * frac;
    this.excNext[b] = this.excNext[b]! + a * (1 - frac);
    const ia = -a * (crank ? 0.6 : 0.8 + 0.4 * thr);
    this.inCur += ia * frac;
    this.inNext += ia * (1 - frac);
    if (this.light) return;
    const rasp = p.exhaust.rasp * (0.3 + 0.7 * load * load) * (overrun ? 0.45 : 1);
    if (!crank && a * rasp > this.raspEnv[b]!) this.raspEnv[b] = a * rasp;
    this.tickEnv = Math.max(this.tickEnv, 0.6 + 0.4 * rng.next());
    if (p.mech.clatter > 0 && !crank) {
      // diesel knock: strongest at idle / low rpm, still there under load
      this.clatImp += (1 - 0.55 * rpmN) * (0.55 + 0.45 * load) * (0.7 + 0.6 * rng.next()) * (overrun ? 0.35 : 1);
    }
    // overrun crackle: dense right after lift-off, sporadic later; also on the limiter's fuel cut
    if (p.pops > 0 && ((overrun && rpm > p.redlineRpm * 0.38) || cut)) {
      const window = Math.exp(-this.liftAge / 1.3);
      const pr = p.pops * (cut ? 0.07 : 0.03 + 0.34 * window) * (0.5 + 0.5 * rpmN);
      if (rng.next() < pr) {
        const big = rng.next() < 0.3;
        const amp = (big ? 2.2 : 0.7) + rng.next() * (big ? 1.6 : 0.6);
        this.popEnv[b] = Math.max(this.popEnv[b]!, amp);
        this.excNext[b] = this.excNext[b]! + amp * 0.5;
      }
    }
  }
}
