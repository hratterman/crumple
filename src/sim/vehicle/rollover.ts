/**
 * Headless ROLLOVER harness (P6 F3; generic — any VehicleDef, test/tool use
 * only, never imported by the engine). Drives a vehicle on the flat handling
 * plane (src/sim/vehicle/handling.ts) and measures body roll, inside-wheel
 * lift and tip-over:
 *
 *   runRampSteer   constant speed, a closed-loop lateral-acceleration DEMAND
 *                  ramped at `rampGPerS` up to `holdG` and held: the steering
 *                  tracks the demand through yaw rate (κ = a/v², geometric
 *                  feed-forward + PI, as runCircle). Reports the lateral g at
 *                  which the first inside wheel lifts (NHTSA-style "ramp
 *                  steer" threshold) and whether the vehicle rolls over
 *                  (|roll| > ROLLED_DEG) while the demand is held.
 *   runSteadyLateral  the same controller held at a modest demand: steady roll.
 *   runJTurn       open loop: at speed, steer ramps 0 → `steer` in `rampS`
 *                  and is held, throttle off (the driver lifts).
 *   runRollover    a tripped rollover: forward speed plus a roll rate about
 *                  the vehicle's long axis through the COM at t = 0, then
 *                  free; measures roof crush of caller-named structures.
 *
 * Conventions: roll φ = rotation of the vehicle frame's up vector about its
 * forward axis, degrees, + = top toward the vehicle's right (a left-hand
 * lean outward in a right turn is −). Lateral g = v·yawRate / g (+ right),
 * 0.5 s running mean. A wheel is LIFTED while its ground load is below
 * LIFT_LOAD_FRACTION of its static load. Inside = the side toward the turn.
 */
import { SIM_DT, SIM_HZ } from '../engine';
import { MaterialId } from '../../protocol/messages';
import { createHandlingSim, G, kinematics, Recorder, setMotion, stepN, type HandlingSample, type HandlingSim } from './handling';
import type { VehicleDef } from './types';

/** Rolled over: |roll| beyond this, degrees. */
export const ROLLED_DEG = 60;
/** A wheel is lifted while its load is below this fraction of its static load. */
export const LIFT_LOAD_FRACTION = 0.03;
/** …for at least this long, s (bumps and tread-polygon rocking are shorter). */
export const LIFT_HOLD_S = 0.1;
const SETTLE_S = 1.5;
const SAMPLE_HZ = 50;
const CONTROL_HZ = 100;

export interface RollSample {
  t: number;
  speed: number;
  /** v·yawRate / g, 0.5 s running mean, + = right. */
  latG: number;
  rollDeg: number;
  /** Per wheel (declaration order) ground load, N (mean over the sample interval). */
  load: number[];
  /** Per wheel lifted (load < LIFT_LOAD_FRACTION · static). */
  lifted: boolean[];
}

/** Roll of the vehicle frame about its forward axis, degrees (+ = top toward the vehicle right). */
export function rollAngleDeg(sim: HandlingSim): number {
  const s = sim.eng.state;
  const n0 = sim.obj.nodeStart;
  const [o, f, t] = [n0 + sim.cv.frameNodes[0]!, n0 + sim.cv.frameNodes[1]!, n0 + sim.cv.frameNodes[2]!];
  let fx = s.posX[f]! - s.posX[o]!;
  let fy = s.posY[f]! - s.posY[o]!;
  let fz = s.posZ[f]! - s.posZ[o]!;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let ux = s.posX[t]! - s.posX[o]!;
  let uy = s.posY[t]! - s.posY[o]!;
  let uz = s.posZ[t]! - s.posZ[o]!;
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  // Horizontal right = forward × world up; the reference up = right × forward.
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  // (rx, 0, rz) × (fx, fy, fz)
  const vx = -rz * fy;
  const vy = rz * fx - rx * fz;
  const vz = rx * fy;
  return (Math.atan2(ux * rx + uz * rz, ux * vx + uy * vy + uz * vz) * 180) / Math.PI;
}

/** +1 for wheels on the vehicle's right (+X at rest), −1 left. */
function wheelSides(sim: HandlingSim): number[] {
  const p = sim.cv.rig.nodePos;
  return sim.cv.wheels.map((w) => Math.sign(p[3 * w.hubI]! + p[3 * w.hubO]!) || 1);
}

interface Run {
  sim: HandlingSim;
  rec: Recorder;
  staticLoad: number[];
  samples: RollSample[];
  raw: HandlingSample[];
}

/** Fresh sim, settled at rest, then given `speed` (rolling wheels, matched gear). */
function start(def: VehicleDef, speed: number): Run {
  const sim = createHandlingSim({ def });
  sim.eng.setInput(sim.objectId, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0, steer: 0 });
  stepN(sim, Math.round(SETTLE_S * SIM_HZ));
  const staticLoad = sim.veh.wheels.map(() => 0);
  const settleN = Math.round(0.25 * SIM_HZ);
  for (let t = 0; t < settleN; t++) {
    sim.eng.step();
    sim.veh.wheels.forEach((w, i) => (staticLoad[i]! += w.load / settleN));
  }
  if (speed > 0) setMotion(sim, speed);
  return { sim, rec: new Recorder(sim), staticLoad, samples: [], raw: [] };
}

/** Steps `ticks` with `control` re-evaluated at CONTROL_HZ and a RollSample every SAMPLE_HZ; `stop` ends early. */
function drive(run: Run, durationS: number, control: (t: number, last: RollSample | null) => Record<string, number>, stop?: (s: RollSample) => boolean): void {
  const { sim, rec } = run;
  const t0 = run.samples.length ? run.samples[run.samples.length - 1]!.t : 0;
  const total = Math.round(durationS * SIM_HZ);
  const ctrlEvery = SIM_HZ / CONTROL_HZ;
  const smpEvery = SIM_HZ / SAMPLE_HZ;
  const win = Math.round(0.5 * SAMPLE_HZ);
  const nW = sim.veh.wheels.length;
  /** Wheel loads summed over the sample interval: a 10-ray tyre's per-tick load jumps as tread nodes touch down. */
  const loadSum = new Float64Array(nW);
  for (let tick = 0; tick < total; tick++) {
    const t = t0 + tick * SIM_DT;
    if (tick % ctrlEvery === 0) sim.eng.setInput(sim.objectId, control(t, run.samples.length ? run.samples[run.samples.length - 1]! : null));
    sim.eng.step();
    for (let w = 0; w < nW; w++) loadSum[w]! += sim.veh.wheels[w]!.load;
    if ((tick + 1) % smpEvery !== 0) continue;
    const h = rec.sample(t + SIM_DT);
    run.raw.push(h);
    let ay = 0;
    const from = Math.max(0, run.raw.length - win);
    for (let j = from; j < run.raw.length; j++) ay += run.raw[j]!.speed * run.raw[j]!.yawRate;
    ay /= run.raw.length - from;
    const load = Array.from(loadSum, (x) => x / smpEvery);
    loadSum.fill(0);
    const smp: RollSample = {
      t: t + SIM_DT,
      speed: h.speed,
      latG: ay / G,
      rollDeg: rollAngleDeg(sim),
      load,
      lifted: load.map((l, i) => l < LIFT_LOAD_FRACTION * run.staticLoad[i]!),
    };
    run.samples.push(smp);
    if (stop && stop(smp)) break;
  }
}

/** First time (and that sample) at which `pred` has held for LIFT_HOLD_S; null if never. */
function firstHeld(samples: readonly RollSample[], pred: (s: RollSample) => boolean): RollSample | null {
  const need = Math.max(1, Math.round(LIFT_HOLD_S * SAMPLE_HZ));
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    run = pred(samples[i]!) ? run + 1 : 0;
    if (run >= need) return samples[i - need + 1]!;
  }
  return null;
}

/**
 * Closed-loop lateral-acceleration demand controller (steer + speed),
 * returning a control function. `demand(t)` in g (+ = right turn).
 */
function lateralController(def: VehicleDef, run: Run, v0: number, demand: (t: number) => number): (t: number, last: RollSample | null) => Record<string, number> {
  const maxWheel = (def.steering.maxWheelAngleDeg * Math.PI) / 180;
  const zs = def.wheels.map((w) => (w.hubInner[2] + w.hubOuter[2]) / 2);
  const wheelbase = Math.max(...zs) - Math.min(...zs);
  let steerI = 0;
  let thrI = 0;
  let kFilt = 0;
  const dtc = 1 / CONTROL_HZ;
  return (t, last) => {
    const aT = demand(t) * G;
    const v = Math.max(3, last?.speed ?? v0);
    const kT = aT / (v * v);
    const raw = run.raw[run.raw.length - 1];
    const k = raw ? raw.yawRate / Math.max(raw.speed, 1) : 0;
    // Curvature loop (geometric feed-forward L·κ/δmax + gentle PI on the filtered yaw-rate curvature; a stiff
    // loop shook the steering at the axle's 5 Hz tramp frequency).
    kFilt += (k - kFilt) * 0.1;
    const err = kT - kFilt;
    const g = wheelbase / maxWheel;
    const ff = g * kT;
    steerI = Math.min(1, Math.max(-1, steerI + 0.8 * g * err * dtc));
    const steer = Math.min(1, Math.max(-1, ff + steerI + 0.4 * g * err));
    const ev = v0 - (last?.speed ?? v0);
    thrI = Math.min(1, Math.max(0, thrI + 0.08 * ev * dtc));
    const thr = Math.min(1, Math.max(0, 0.15 + 0.35 * ev + thrI));
    const brake = ev < -1.5 ? Math.min(1, -0.15 * (ev + 1.5)) : 0;
    return { gearSelect: 1, throttle: brake > 0 ? 0 : thr, brake, steer };
  };
}

export interface RampSteerOptions {
  speedKmh?: number;
  /** Demand ramp rate, g/s. */
  rampGPerS?: number;
  /** Demand held from the end of the ramp, g. */
  holdG?: number;
  holdS?: number;
  /** +1 right turn, −1 left. */
  direction?: 1 | -1;
}

export interface RampSteerResult {
  /** Lateral g (0.5 s mean) when the first inside wheel lifted (held LIFT_HOLD_S); NaN if none did. */
  liftG: number;
  liftT: number;
  /** Ids of the wheels lifted at that moment. */
  liftWheels: string[];
  /** Lateral g when EVERY inside wheel was lifted; NaN if never. */
  allLiftG: number;
  /** Max |roll| over the run, degrees; and |roll| at first lift. */
  maxRollDeg: number;
  rollAtLiftDeg: number;
  rolled: boolean;
  /** Peak |lateral g| reached. */
  maxLatG: number;
  samples: RollSample[];
}

function summarizeTurn(run: Run, dir: number): Omit<RampSteerResult, 'samples'> {
  const sides = wheelSides(run.sim);
  const ids = run.sim.cv.wheels.map((w) => w.id);
  const inside = sides.map((s) => s === dir);
  const first = firstHeld(run.samples, (s) => s.lifted.some((l, i) => l && inside[i]));
  const all = firstHeld(run.samples, (s) => s.lifted.every((l, i) => l || !inside[i]));
  let maxRoll = 0;
  let maxLat = 0;
  for (const s of run.samples) {
    maxRoll = Math.max(maxRoll, Math.abs(s.rollDeg));
    maxLat = Math.max(maxLat, Math.abs(s.latG));
  }
  return {
    liftG: first ? Math.abs(first.latG) : NaN,
    liftT: first ? first.t : NaN,
    liftWheels: first ? ids.filter((_, i) => first.lifted[i] && inside[i]) : [],
    allLiftG: all ? Math.abs(all.latG) : NaN,
    maxRollDeg: maxRoll,
    rollAtLiftDeg: first ? Math.abs(first.rollDeg) : NaN,
    rolled: maxRoll > ROLLED_DEG,
    maxLatG: maxLat,
  };
}

/**
 * Ramp steer at constant speed (default 60 km/h): lateral demand 0 → holdG
 * at rampGPerS, held holdS. Stops 1 s after the vehicle has rolled.
 */
export function runRampSteer(def: VehicleDef, opts: RampSteerOptions = {}): RampSteerResult {
  const v0 = (opts.speedKmh ?? 60) / 3.6;
  const rate = opts.rampGPerS ?? 0.1;
  const hold = opts.holdG ?? 0.65;
  const dir = opts.direction ?? 1;
  const run = start(def, v0);
  const ctl = lateralController(def, run, v0, (t) => dir * Math.min(hold, rate * Math.max(0, t - 0.5)));
  let rolledAt = -1;
  drive(run, 0.5 + hold / rate + (opts.holdS ?? 5), ctl, (s) => {
    if (rolledAt < 0 && Math.abs(s.rollDeg) > ROLLED_DEG) rolledAt = s.t;
    return rolledAt >= 0 && s.t > rolledAt + 1;
  });
  return { ...summarizeTurn(run, dir), samples: run.samples };
}

export interface SteadyLateralResult {
  /** Mean |roll| over the last `measureS`, degrees. */
  rollDeg: number;
  /** Mean |lateral g| over the same window. */
  latG: number;
  /** Any wheel lifted (held LIFT_HOLD_S) during the run. */
  lifted: boolean;
  samples: RollSample[];
}

/** Lateral demand ramped to `latG` (default 0.35 g) at 60 km/h and held 4 s: the steady body roll. */
export function runSteadyLateral(def: VehicleDef, opts: { speedKmh?: number; latG?: number; direction?: 1 | -1 } = {}): SteadyLateralResult {
  const v0 = (opts.speedKmh ?? 60) / 3.6;
  const target = opts.latG ?? 0.35;
  const dir = opts.direction ?? 1;
  const run = start(def, v0);
  // The curvature integrator is gentle (lateralController): 8 s of hold to settle on the demand.
  drive(run, 0.5 + target / 0.2 + 8, lateralController(def, run, v0, (t) => dir * Math.min(target, 0.2 * Math.max(0, t - 0.5))));
  const end = run.samples[run.samples.length - 1]!.t;
  const tail = run.samples.filter((s) => s.t >= end - 1.5);
  return {
    rollDeg: tail.reduce((a, s) => a + Math.abs(s.rollDeg), 0) / tail.length,
    latG: tail.reduce((a, s) => a + Math.abs(s.latG), 0) / tail.length,
    lifted: firstHeld(run.samples, (s) => s.lifted.some(Boolean)) !== null,
    samples: run.samples,
  };
}

export interface JTurnOptions {
  speedKmh: number;
  /** Final steer input (default 1 = full lock), sign = direction. */
  steer?: number;
  /** Steer ramp time, s (default 0.3). */
  rampS?: number;
  durationS?: number;
}

/** J-turn: from `speedKmh`, throttle off, steer ramped to `steer` in `rampS` and held. */
export function runJTurn(def: VehicleDef, opts: JTurnOptions): RampSteerResult {
  const steer = opts.steer ?? 1;
  const ramp = opts.rampS ?? 0.3;
  const run = start(def, opts.speedKmh / 3.6);
  let rolledAt = -1;
  drive(
    run,
    opts.durationS ?? 5,
    (t) => ({ gearSelect: 1, throttle: 0, brake: 0, steer: steer * Math.min(1, t / ramp) }),
    (s) => {
      if (rolledAt < 0 && Math.abs(s.rollDeg) > ROLLED_DEG) rolledAt = s.t;
      return rolledAt >= 0 && s.t > rolledAt + 1.5;
    },
  );
  return { ...summarizeTurn(run, Math.sign(steer) || 1), samples: run.samples };
}

/**
 * Roof crush probe: the perpendicular height of a roof node set above a
 * floor node set, measured along the floor's local normal (across × the
 * vehicle frame forward), so racking (a parallelogram) counts as crush.
 */
export interface CrushProbe {
  name: string;
  roof: readonly string[];
  floor: readonly string[];
  /** Floor left / right nodes (the across direction). */
  across: readonly [string, string];
}

export interface RolloverOptions {
  speedKmh: number;
  /** Initial roll rate about the forward axis through the COM, rad/s (+ = rolls toward the right). */
  rollRate: number;
  /**
   * Land it on its roof instead (the end of a roll, without the chaotic
   * tumble deciding side vs roof): the settled vehicle is turned upside down
   * about its forward axis through the COM and released with its lowest
   * point `dropM` above the ground, moving forward at `speedKmh`.
   */
  invertedDropM?: number;
  /**
   * R-CRASH FMVSS 208 DOLLY rollover (S8.1.11 / NHTSA dolly test): the settled vehicle is tilted
   * `tiltDeg` (23°) with its leading side down, lifted so its lowest point is `heightM` (0.23 m, the
   * dolly bed) above the ground, and released moving sideways toward the leading side at `speedKmh`
   * (48 km/h); the leading wheels dig in and trip it. Overrides speedKmh / rollRate.
   */
  dolly?: { speedKmh: number; tiltDeg?: number; heightM?: number; leading?: 'L' | 'R'; curbM?: number };
  durationS?: number;
  probes: Readonly<Record<string, readonly CrushProbe[]>>;
  /** R-CRASH diagnostics: called with the live sim at every recorded sample. */
  onSample?: (sim: HandlingSim) => void;
}

export interface RolloverResult {
  maxRollDeg: number;
  /** Total roll turned (unwrapped), degrees (360 = one full roll), and the peak roll rate, deg/s (50 Hz samples). */
  rollTotalDeg: number;
  peakRollRate: number;
  /** |roll| at the end, degrees (≈ 90 on its side, 180 on its roof). */
  finalRollDeg: number;
  /** Per probe group: final crush = max over its probes of (rest − final height), m; and the max over time. */
  crush: Record<string, number>;
  crushMax: Record<string, number>;
  /** Which probe gave the final crush per group. */
  worst: Record<string, string>;
  finite: boolean;
  samples: RollSample[];
}

export function runRollover(def: VehicleDef, opts: RolloverOptions): RolloverResult {
  const run = start(def, opts.invertedDropM === undefined && opts.dolly === undefined ? opts.speedKmh / 3.6 : 0);
  const { sim } = run;
  const s = sim.eng.state;
  const n0 = sim.obj.nodeStart;
  const ids = sim.cv.rig.nodeIds;
  const index = (id: string): number => {
    const i = ids.indexOf(id);
    if (i < 0) throw new Error(`rollover: no node ${id}`);
    return n0 + i;
  };
  if (opts.invertedDropM !== undefined) {
    // Upside down: r → 2(r·f)f − r about the forward axis f through the COM, then lowered to the drop height.
    const k0 = kinematics(sim);
    // Forward along the frame nodes (pitch included).
    const fr0 = sim.cv.frameNodes;
    const fo = n0 + fr0[0]!;
    const ff = n0 + fr0[1]!;
    const fv = [s.posX[ff]! - s.posX[fo]!, s.posY[ff]! - s.posY[fo]!, s.posZ[ff]! - s.posZ[fo]!];
    const fl = Math.hypot(fv[0]!, fv[1]!, fv[2]!) || 1;
    const f = [fv[0]! / fl, fv[1]! / fl, fv[2]! / fl];
    let minY = Infinity;
    for (let i = n0; i < n0 + sim.obj.nodeCount; i++) {
      const r = [s.posX[i]! - k0.cx, s.posY[i]! - k0.cy, s.posZ[i]! - k0.cz];
      const d = r[0]! * f[0]! + r[1]! * f[1]! + r[2]! * f[2]!;
      s.posX[i] = k0.cx + 2 * d * f[0]! - r[0]!;
      s.posY[i] = k0.cy + 2 * d * f[1]! - r[1]!;
      s.posZ[i] = k0.cz + 2 * d * f[2]! - r[2]!;
      minY = Math.min(minY, s.posY[i]! - s.radius[i]!);
    }
    const v = opts.speedKmh / 3.6;
    for (let i = n0; i < n0 + sim.obj.nodeCount; i++) {
      s.posY[i] = s.posY[i]! - minY + opts.invertedDropM;
      s.velX[i] = f[0]! * v;
      s.velY[i] = 0;
      s.velZ[i] = f[2]! * v;
    }
    for (const w of sim.veh.wheels) w.omega = 0;
  }
  if (opts.dolly) {
    const k0 = kinematics(sim);
    const lead = opts.dolly.leading ?? 'R';
    // right = forward × up (horizontal); roll + = top toward the right: the right side goes down
    const rx = -k0.fz;
    const rz = k0.fx;
    const a = (((lead === 'R' ? 1 : -1) * (opts.dolly.tiltDeg ?? 23)) * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // rotate about the forward axis through the COM: up → up·cos a + right·sin a
    let minY = Infinity;
    for (let i = n0; i < n0 + sim.obj.nodeCount; i++) {
      const dx = s.posX[i]! - k0.cx;
      const dy = s.posY[i]! - k0.cy;
      const dz = s.posZ[i]! - k0.cz;
      const side = dx * rx + dz * rz;
      const fwd = dx * k0.fx + dz * k0.fz;
      const nSide = side * ca + dy * sa;
      const nUp = dy * ca - side * sa;
      s.posX[i] = k0.cx + nSide * rx + fwd * k0.fx;
      s.posY[i] = k0.cy + nUp;
      s.posZ[i] = k0.cz + nSide * rz + fwd * k0.fz;
      minY = Math.min(minY, s.posY[i]! - s.radius[i]!);
    }
    const v = ((lead === 'R' ? 1 : -1) * opts.dolly.speedKmh) / 3.6;
    for (let i = n0; i < n0 + sim.obj.nodeCount; i++) {
      s.posY[i] = s.posY[i]! - minY + (opts.dolly.heightM ?? 0.23);
      s.velX[i] = rx * v;
      s.velY[i] = 0;
      s.velZ[i] = rz * v;
    }
    for (const w of sim.veh.wheels) w.omega = 0;
    const curb = opts.dolly.curbM ?? 0;
    if (curb > 0) {
      // a tripping curb along the leading side, 0.3 m out from the vehicle's widest point
      let reach = 0;
      for (let i = n0; i < n0 + sim.obj.nodeCount; i++) reach = Math.max(reach, (s.posX[i]! - k0.cx) * rx * (v > 0 ? 1 : -1) + (s.posZ[i]! - k0.cz) * rz * (v > 0 ? 1 : -1) + s.radius[i]!);
      const off = (v > 0 ? 1 : -1) * (reach + 0.3 + 0.5);
      sim.eng.setExtraColliders([
        { id: 'tripCurb', kind: 'box', pos: [k0.cx + rx * off, curb / 2, k0.cz + rz * off], quat: [0, Math.sin(Math.atan2(k0.fx, k0.fz) / 2), 0, Math.cos(Math.atan2(k0.fx, k0.fz) / 2)], size: [0.5, curb / 2, 4], material: MaterialId.concrete },
      ]);
    }
  }
  // Initial roll rate ω about the forward axis through the COM: v += ω × (p − c), ω = rollRate·forward
  // (ω × up = rollRate·right: the top starts toward the vehicle's right).
  const k = kinematics(sim);
  const ox = opts.rollRate * k.fx;
  const oz = opts.rollRate * k.fz;
  for (let i = n0; i < n0 + sim.obj.nodeCount; i++) {
    const rx = s.posX[i]! - k.cx;
    const ry = s.posY[i]! - k.cy;
    const rz = s.posZ[i]! - k.cz;
    s.velX[i] = s.velX[i]! - oz * ry;
    s.velY[i] = s.velY[i]! + oz * rx - ox * rz;
    s.velZ[i] = s.velZ[i]! + ox * ry;
  }
  const groups = Object.entries(opts.probes).map(([g, list]) => ({
    g,
    list: list.map((p) => ({ p, roof: p.roof.map(index), floor: p.floor.map(index), l: index(p.across[0]), r: index(p.across[1]), rest: 0 })),
  }));
  const fr = sim.cv.frameNodes;
  const height = (q: { roof: number[]; floor: number[]; l: number; r: number }, X: ArrayLike<number>, Y: ArrayLike<number>, Z: ArrayLike<number>, off: number): number => {
    const mean = (arr: number[]): [number, number, number] => {
      let x = 0;
      let y = 0;
      let z = 0;
      for (const i of arr) {
        x += X[i - off]!;
        y += Y[i - off]!;
        z += Z[i - off]!;
      }
      return [x / arr.length, y / arr.length, z / arr.length];
    };
    const ax = X[q.r - off]! - X[q.l - off]!;
    const ay = Y[q.r - off]! - Y[q.l - off]!;
    const az = Z[q.r - off]! - Z[q.l - off]!;
    const o = n0 + fr[0]! - off;
    const f = n0 + fr[1]! - off;
    const fx = X[f]! - X[o]!;
    const fy = Y[f]! - Y[o]!;
    const fz = Z[f]! - Z[o]!;
    // n = across × forward (≈ +Y upright)
    let nx = ay * fz - az * fy;
    let ny = az * fx - ax * fz;
    let nz = ax * fy - ay * fx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const a = mean(q.roof);
    const b = mean(q.floor);
    return (a[0] - b[0]) * nx + (a[1] - b[1]) * ny + (a[2] - b[2]) * nz;
  };
  const rp = sim.cv.rig.nodePos;
  const RX = new Float64Array(rp.length / 3);
  const RY = new Float64Array(rp.length / 3);
  const RZ = new Float64Array(rp.length / 3);
  for (let i = 0; i < RX.length; i++) {
    RX[i] = rp[3 * i]!;
    RY[i] = rp[3 * i + 1]!;
    RZ[i] = rp[3 * i + 2]!;
  }
  for (const g of groups) for (const q of g.list) q.rest = height(q, RX, RY, RZ, n0);
  const crushMax: Record<string, number> = {};
  for (const g of groups) crushMax[g.g] = 0;
  // unwrapped roll (rollAngleDeg every sample)
  let lastRoll = rollAngleDeg(sim);
  let total = 0;
  let peakRate = 0;
  drive(
    run,
    opts.durationS ?? 4,
    () => ({ gearSelect: 0, throttle: 0, brake: 0, steer: 0 }),
    (smp) => {
      opts.onSample?.(sim);
      const r = rollAngleDeg(sim);
      let d = r - lastRoll;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      lastRoll = r;
      total += d;
      peakRate = Math.max(peakRate, Math.abs(d) * SAMPLE_HZ);
      for (const g of groups) for (const q of g.list) crushMax[g.g] = Math.max(crushMax[g.g]!, q.rest - height(q, s.posX, s.posY, s.posZ, 0));
      return !Number.isFinite(smp.rollDeg);
    },
  );
  const crush: Record<string, number> = {};
  const worst: Record<string, string> = {};
  for (const g of groups) {
    crush[g.g] = -Infinity;
    for (const q of g.list) {
      const c = q.rest - height(q, s.posX, s.posY, s.posZ, 0);
      if (c > crush[g.g]!) {
        crush[g.g] = c;
        worst[g.g] = q.p.name;
      }
    }
  }
  let finite = true;
  for (let i = n0; i < n0 + sim.obj.nodeCount; i++) if (!Number.isFinite(s.posX[i]! + s.posY[i]! + s.posZ[i]!)) finite = false;
  let maxRoll = 0;
  for (const smp of run.samples) maxRoll = Math.max(maxRoll, Math.abs(smp.rollDeg));
  return {
    maxRollDeg: maxRoll,
    rollTotalDeg: Math.abs(total),
    peakRollRate: peakRate,
    finalRollDeg: Math.abs(run.samples[run.samples.length - 1]!.rollDeg),
    crush,
    crushMax,
    worst,
    finite,
    samples: run.samples,
  };
}

/** One-line summaries (reports). */
export function formatTurn(name: string, r: RampSteerResult): string {
  const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));
  return `${name}: lift ${f(r.liftG)} g @ ${f(r.liftT)} s (${r.liftWheels.join('+') || '-'}, roll ${f(r.rollAtLiftDeg, 1)}°), all-inside ${f(r.allLiftG)} g, max lat ${f(r.maxLatG)} g, max roll ${f(r.maxRollDeg, 1)}°, rolled ${r.rolled}`;
}
