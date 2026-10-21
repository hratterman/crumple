/**
 * Headless handling harness (worker-side, test/tool use only): drives a
 * VehicleDef on a flat plane in a real SimEngine with scripted inputs and
 * records speed, heading, position, rpm, gear, per-corner wheel ω / slip /
 * load and accelerations at a fixed sample rate.
 *
 * Not a hot path (allocates per sample); never imported by the engine.
 *
 * Conventions: heading is the vehicle forward (frame origin → front) in the
 * ground plane, radians, 0 = −Z, + = toward +X (a right turn), unwrapped.
 * Lateral acceleration is + to the vehicle right. "Speed" is the COM
 * velocity along the vehicle forward (telemetry slot 0 definition).
 */
import { Action, MaterialId, type ActionState } from '../../protocol/messages';
import { SimEngine, SIM_DT, SIM_HZ } from '../engine';
import type { SimObject } from '../types';
import { SEDAN } from './defs/sedan';
import type { DrivetrainStateEx } from './drivetrain';
import { RPM_PER_RAD_S } from './drivetrain';
import type { CompiledVehicle, TransmissionMode, VehicleDef, VehicleRuntime } from './types';
import type { VehicleRuntimeEx } from './runtime';
import { resetBrakeSystem } from './brakes';

export const G = 9.81;

export interface HandlingSample {
  t: number;
  /** m/s along the vehicle forward. */
  speed: number;
  /** Horizontal COM speed, m/s (any direction). */
  groundSpeed: number;
  /** rad, unwrapped, 0 = −Z, + = right. */
  heading: number;
  /** rad/s, + = turning right. */
  yawRate: number;
  /** Angle between the heading and the COM velocity, rad (+ = velocity right of nose). */
  sideslip: number;
  comX: number;
  comY: number;
  comZ: number;
  /** COM acceleration along vehicle forward / right, m/s² (finite difference over the sample interval). */
  lonAcc: number;
  latAcc: number;
  rpm: number;
  gear: number;
  clutch: number;
  /** FL, FR, RL, RR. */
  omega: number[];
  slipRatio: number[];
  slipSpeed: number[];
  load: number[];
  driveTorque: number[];
  /** Distance travelled by the COM in the ground plane, m. */
  dist: number;
  /**
   * Body attitude from the frame nodes (R-PHYS, additive), rad: roll + = the
   * body top leaning to the vehicle RIGHT; pitch + = nose DOWN.
   */
  roll: number;
  pitch: number;
  /** Applied steer action (−1..1), R-PHYS additive. */
  steer: number;
}

export interface HandlingSim {
  eng: SimEngine;
  obj: SimObject;
  veh: VehicleRuntime;
  cv: CompiledVehicle;
  objectId: number;
}

export interface HandlingSimOptions {
  def?: VehicleDef;
  transmission?: TransmissionMode;
  materialId?: number;
}

export function createHandlingSim(opts: HandlingSimOptions = {}): HandlingSim {
  const eng = new SimEngine({
    gravity: [0, -G, 0],
    debugStrains: false,
    capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 },
  });
  eng.setGroundPlane(0, opts.materialId ?? MaterialId.asphalt);
  const objectId = 1;
  const obj = eng.spawnVehicle(objectId, opts.def ?? SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, opts.transmission ?? 'auto');
  const veh = eng.getVehicle(objectId)!;
  return { eng, obj, veh, cv: veh.vehicle, objectId };
}

/** Steps n fixed ticks. */
export function stepN(sim: HandlingSim, n: number): void {
  for (let i = 0; i < n; i++) sim.eng.step();
}

// ------------------------------------------------------------ kinematics
interface Kin {
  m: number;
  cx: number;
  cy: number;
  cz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Unit horizontal forward / right. */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
}

export function kinematics(sim: HandlingSim): Kin {
  const s = sim.eng.state;
  const start = sim.obj.nodeStart;
  const end = start + sim.obj.nodeCount;
  let m = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = start; i < end; i++) {
    const im = s.invMass[i]!;
    if (im === 0) continue;
    const mi = 1 / im;
    m += mi;
    cx += mi * s.posX[i]!;
    cy += mi * s.posY[i]!;
    cz += mi * s.posZ[i]!;
    vx += mi * s.velX[i]!;
    vy += mi * s.velY[i]!;
    vz += mi * s.velZ[i]!;
  }
  const fr = sim.cv.frameNodes;
  const o = start + fr[0]!;
  const f = start + fr[1]!;
  let fx = s.posX[f]! - s.posX[o]!;
  let fz = s.posZ[f]! - s.posZ[o]!;
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  // right = forward × up = (fx,0,fz) × (0,1,0) = (−fz, 0, fx)
  return { m, cx: cx / m, cy: cy / m, cz: cz / m, vx: vx / m, vy: vy / m, vz: vz / m, fx, fz, rx: -fz, rz: fx };
}

/** Heading of the vehicle forward in the ground plane, rad (0 = −Z, + = toward +X). */
export function headingOf(k: Kin): number {
  return Math.atan2(k.fx, -k.fz);
}

/** Body roll / pitch (rad) from the frame nodes: roll + = top leaning right, pitch + = nose down. */
export function attitudeOf(sim: HandlingSim): { roll: number; pitch: number } {
  const s = sim.eng.state;
  const start = sim.obj.nodeStart;
  const fr = sim.cv.frameNodes;
  const o = start + fr[0]!;
  const f = start + fr[1]!;
  const t = start + fr[2]!;
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
  // horizontal right of the heading: (forward × up_world) = (−fz, 0, fx) normalised
  const hl = Math.hypot(fx, fz) || 1;
  const rx = -fz / hl;
  const rz = fx / hl;
  const roll = Math.atan2(ux * rx + uz * rz, uy);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -fy)));
  return { roll, pitch };
}

/**
 * Gives the whole vehicle a rigid forward velocity `speed` (m/s, along its
 * current horizontal heading) with every wheel's rim/tyre/hub nodes spinning
 * at the matching rolling ω = speed / WheelRuntime.rollRadius. The
 * gearbox is put in `gear` (default: the gear auto would pick) with the
 * engine speed matched, clutch closed. Harness-only shortcut to start
 * coastdown / braking / cornering runs at speed without a long launch.
 */
export function setMotion(sim: HandlingSim, speed: number, gear?: number): void {
  const s = sim.eng.state;
  const k = kinematics(sim);
  const start = sim.obj.nodeStart;
  const vx = k.fx * speed;
  const vz = k.fz * speed;
  for (let i = start; i < start + sim.obj.nodeCount; i++) {
    s.velX[i] = vx;
    s.velY[i] = 0;
    s.velZ[i] = vz;
  }
  const w = speed / sim.veh.wheels[0]!.rollRadius;
  for (const wr of sim.veh.wheels) {
    const ww = speed / wr.rollRadius;
    const hi = wr.hubI;
    const ho = wr.hubO;
    const cx = (s.posX[hi]! + s.posX[ho]!) / 2;
    const cy = (s.posY[hi]! + s.posY[ho]!) / 2;
    const cz = (s.posZ[hi]! + s.posZ[ho]!) / 2;
    let ax = s.posX[ho]! - s.posX[hi]!;
    let ay = s.posY[ho]! - s.posY[hi]!;
    let az = s.posZ[ho]! - s.posZ[hi]!;
    const al = Math.hypot(ax, ay, az);
    const sg = wr.wheel.spinSign / al;
    ax *= sg;
    ay *= sg;
    az *= sg;
    for (let i = wr.rimStart; i < wr.tireStart + wr.ringCount; i++) {
      const rx = s.posX[i]! - cx;
      const ry = s.posY[i]! - cy;
      const rz = s.posZ[i]! - cz;
      // v = ω s × r
      s.velX[i] = vx + ww * (ay * rz - az * ry);
      s.velY[i] = ww * (az * rx - ax * rz);
      s.velZ[i] = vz + ww * (ax * ry - ay * rx);
    }
  }
  const dt = sim.veh.drivetrain as DrivetrainStateEx;
  const d = sim.cv.drivetrain;
  let g = gear;
  if (g === undefined) {
    // highest gear whose rpm stays above the downshift point
    g = 1;
    for (let c = d.gearCount; c >= 1; c--) {
      const rpm = d.gearRatioTable[c + 1]! * d.finalDrive * w * RPM_PER_RAD_S;
      if (rpm >= d.autoShiftDownRpm * 1.1 && rpm <= d.autoShiftUpRpm) {
        g = c;
        break;
      }
    }
  }
  dt.gear = g;
  dt.targetGear = g;
  dt.shiftTimer = 0;
  dt.shiftCooldown = 0;
  const eo = g === 0 ? d.idleRpm / RPM_PER_RAD_S : d.gearRatioTable[g + 1]! * d.finalDrive * w;
  dt.engineOmega = Math.max(eo, d.idleRpm / RPM_PER_RAD_S);
  dt.autoEngage = 1;
  dt.clutchWind = 0;
  for (const wr of sim.veh.wheels) wr.omega = speed / wr.rollRadius;
  // a teleport: no caliper pressure carried over from before (R-PHYS brake hydraulics), reference speed seeded
  const bs = (sim.veh as VehicleRuntimeEx).brakeSys;
  if (bs) {
    resetBrakeSystem(bs);
    bs.vRef = Math.abs(speed);
    bs.vPrev.fill(Math.abs(speed));
  }
}

// ------------------------------------------------------------ scenario
export interface ScenarioContext {
  sim: HandlingSim;
  /** Time since the scenario start, s. */
  t: number;
  /** Latest sample (taken at the sample rate; null before the first). */
  last: HandlingSample | null;
}

export interface Scenario {
  /** Settle at rest before the scenario (s). Default 1.5. */
  settleS?: number;
  /** Initial forward speed (m/s) applied after settling via setMotion. */
  initialSpeed?: number;
  /** Gear for setMotion (auto default: matched). */
  initialGear?: number;
  durationS: number;
  /** Samples per second. Default 50. */
  sampleHz?: number;
  /** Inputs, re-evaluated every `controlHz` (default 100 Hz). */
  control?: (ctx: ScenarioContext) => Partial<ActionState>;
  controlHz?: number;
  /** Stop early once this returns true (checked per sample). */
  stop?: (s: HandlingSample) => boolean;
  transmission?: TransmissionMode;
  def?: VehicleDef;
}

export interface ScenarioResult {
  sim: HandlingSim;
  samples: HandlingSample[];
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Corner-ordered (FL FR RL RR) copy of a per-wheel quantity. */
function corners(sim: HandlingSim, f: (w: VehicleRuntime['wheels'][number]) => number): number[] {
  const out = [0, 0, 0, 0];
  for (const w of sim.veh.wheels) if (w.wheel.corner >= 0 && w.wheel.corner < 4) out[w.wheel.corner] = f(w);
  return out;
}

export class Recorder {
  readonly samples: HandlingSample[] = [];
  private prev: { k: Kin; t: number; heading: number } | null = null;
  private dist = 0;
  private headingAcc = 0;
  private heading0 = 0;

  constructor(private readonly sim: HandlingSim) {}

  sample(t: number): HandlingSample {
    const sim = this.sim;
    const k = kinematics(sim);
    const hRaw = headingOf(k);
    let lonAcc = 0;
    let latAcc = 0;
    let yawRate = 0;
    if (this.prev === null) {
      this.heading0 = hRaw;
      this.headingAcc = 0;
    } else {
      const dtS = t - this.prev.t;
      const dh = wrapPi(hRaw - this.prev.heading);
      this.headingAcc += dh;
      yawRate = dtS > 0 ? dh / dtS : 0;
      if (dtS > 0) {
        const ax = (k.vx - this.prev.k.vx) / dtS;
        const az = (k.vz - this.prev.k.vz) / dtS;
        lonAcc = ax * k.fx + az * k.fz;
        latAcc = ax * k.rx + az * k.rz;
      }
      this.dist += Math.hypot(k.cx - this.prev.k.cx, k.cz - this.prev.k.cz);
    }
    const speed = k.vx * k.fx + k.vz * k.fz;
    const vLat = k.vx * k.rx + k.vz * k.rz;
    const groundSpeed = Math.hypot(k.vx, k.vz);
    const dts = sim.veh.drivetrain as DrivetrainStateEx;
    const att = attitudeOf(sim);
    const smp: HandlingSample = {
      t,
      speed,
      groundSpeed,
      heading: this.heading0 + this.headingAcc,
      yawRate,
      sideslip: groundSpeed > 0.5 ? Math.atan2(vLat, speed) : 0,
      comX: k.cx,
      comY: k.cy,
      comZ: k.cz,
      lonAcc,
      latAcc,
      rpm: dts.rpm,
      gear: dts.gear,
      clutch: dts.clutch,
      omega: corners(sim, (w) => w.omega),
      slipRatio: corners(sim, (w) => w.slipRatio),
      slipSpeed: corners(sim, (w) => w.slipSpeed),
      load: corners(sim, (w) => w.load),
      driveTorque: corners(sim, (w) => w.driveTorque),
      dist: this.dist,
      roll: att.roll,
      pitch: att.pitch,
      steer: sim.obj.actions[Action.steer]!,
    };
    this.prev = { k, t, heading: hRaw };
    this.samples.push(smp);
    return smp;
  }
}

/** Runs one scenario on a fresh sim and returns every sample. */
export function runScenario(scn: Scenario): ScenarioResult {
  const sim = createHandlingSim({ def: scn.def, transmission: scn.transmission });
  stepN(sim, Math.round((scn.settleS ?? 1.5) * SIM_HZ));
  if (scn.initialSpeed !== undefined) setMotion(sim, scn.initialSpeed, scn.initialGear);
  const rec = new Recorder(sim);
  const sampleEvery = Math.max(1, Math.round(SIM_HZ / (scn.sampleHz ?? 50)));
  const controlEvery = Math.max(1, Math.round(SIM_HZ / (scn.controlHz ?? 100)));
  const total = Math.round(scn.durationS * SIM_HZ);
  const ctx: ScenarioContext = { sim, t: 0, last: rec.sample(0) };
  for (let tick = 0; tick < total; tick++) {
    if (scn.control && tick % controlEvery === 0) {
      ctx.t = tick * SIM_DT;
      sim.eng.setInput(sim.objectId, scn.control(ctx));
    }
    sim.eng.step();
    if ((tick + 1) % sampleEvery === 0) {
      const smp = rec.sample((tick + 1) * SIM_DT);
      ctx.last = smp;
      if (scn.stop && scn.stop(smp)) break;
    }
  }
  return { sim, samples: rec.samples };
}

// ------------------------------------------------------------ standard tests
export interface StaticResult {
  /** Mean body-node drop from the rest pose, m. */
  sag: number;
  /** Horizontal COM speed averaged over the measurement window, m/s. */
  creep: number;
  /** Max node speed in the window, m/s. */
  jitter: number;
}

/** Settle 3 s, then measure creep (COM drift over 2 s) and jitter. */
export function runStatic(def: VehicleDef = SEDAN): StaticResult {
  const sim = createHandlingSim({ def });
  const s = sim.eng.state;
  const nb = sim.cv.bodyNodeCount;
  const start = sim.obj.nodeStart;
  const groups = def.body.nodes.map((n) => n.group);
  const y0: number[] = [];
  for (let i = 0; i < nb; i++) y0.push(s.posY[start + i]!);
  sim.eng.setInput(sim.objectId, { gearSelect: 0 });
  stepN(sim, 3 * SIM_HZ);
  const k0 = kinematics(sim);
  let jitter = 0;
  const window = 2;
  for (let t = 0; t < window * SIM_HZ; t++) {
    sim.eng.step();
    if (t % 20 === 0) {
      for (let i = start; i < start + sim.obj.nodeCount; i++) {
        const v = Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!);
        if (v > jitter) jitter = v;
      }
    }
  }
  const k1 = kinematics(sim);
  let drop = 0;
  let n = 0;
  for (let i = 0; i < nb; i++) {
    if (groups[i] !== 'body') continue;
    drop += y0[i]! - s.posY[start + i]!;
    n++;
  }
  return { sag: drop / n, creep: Math.hypot(k1.cx - k0.cx, k1.cz - k0.cz) / window, jitter };
}

export interface LaunchResult {
  /** s to 100 km/h (Infinity if not reached). */
  t100: number;
  /** Max |heading change| over the first 100 m, deg. */
  headingDrift100: number;
  /** Lateral offset of the COM from the start line at 100 m, m. */
  lateral100: number;
  /** Max |rear slip ratio| (mean of RL/RR) over samples after 1.5 s (until 100 km/h). */
  rearSlipAfter: number;
  /** Mean rear slip ratio over 1.5 s .. t100. */
  rearSlipMean: number;
  speedAt4s: number;
  rpmAt4s: number;
  gearAt4s: number;
  samples: HandlingSample[];
}

/** P6: `durationS` (default 12) — heavy vehicles need longer to reach 100 km/h. */
export function runLaunch(def: VehicleDef = SEDAN, opts: { durationS?: number } = {}): LaunchResult {
  const { samples } = runScenario({
    def,
    durationS: opts.durationS ?? 12,
    sampleHz: 50,
    control: () => ({ gearSelect: 1, throttle: 1, steer: 0 }),
    stop: (s) => s.speed > 100 / 3.6 && s.dist > 100,
  });
  const s0 = samples[0]!;
  const fx = Math.sin(s0.heading);
  const fz = -Math.cos(s0.heading);
  let t100 = Infinity;
  let drift = 0;
  let lateral100 = NaN;
  let slipMax = 0;
  let slipSum = 0;
  let slipN = 0;
  for (const s of samples) {
    if (t100 === Infinity && s.speed >= 100 / 3.6) t100 = s.t;
    if (s.dist <= 100) {
      drift = Math.max(drift, Math.abs(s.heading - s0.heading));
      const dx = s.comX - s0.comX;
      const dz = s.comZ - s0.comZ;
      lateral100 = dx * -fz + dz * fx;
    }
    if (s.t >= 1.5 && s.t <= t100 && s.speed > 1) {
      const r = (s.slipRatio[2]! + s.slipRatio[3]!) / 2;
      slipMax = Math.max(slipMax, Math.abs(r));
      slipSum += r;
      slipN++;
    }
  }
  const at4 = samples.find((s) => s.t >= 4) ?? samples[samples.length - 1]!;
  return {
    t100,
    headingDrift100: (drift * 180) / Math.PI,
    lateral100,
    rearSlipAfter: slipMax,
    rearSlipMean: slipN > 0 ? slipSum / slipN : NaN,
    speedAt4s: at4.speed,
    rpmAt4s: at4.rpm,
    gearAt4s: at4.gear,
    samples,
  };
}

export interface CoastResult {
  /** Mean deceleration over the first 5 s, m/s². */
  decel5: number;
  samples: HandlingSample[];
}

export function runCoastdown(def: VehicleDef = SEDAN): CoastResult {
  const v0 = 100 / 3.6;
  const { samples } = runScenario({
    def,
    initialSpeed: v0,
    initialGear: 0,
    durationS: 5.5,
    sampleHz: 20,
    control: () => ({ gearSelect: 0, throttle: 0, brake: 0, steer: 0 }),
  });
  // Skip the first 0.5 s of the rigid-velocity transient.
  const a = samples.find((s) => s.t >= 0.5)!;
  const b = samples[samples.length - 1]!;
  return { decel5: (a.speed - b.speed) / (b.t - a.t), samples };
}

export interface BrakeResult {
  /** Stopping distance from 100 km/h, m. */
  distance: number;
  /** Max |heading change| during the stop, deg. */
  headingDrift: number;
  stopTime: number;
  samples: HandlingSample[];
}

export function runBraking(def: VehicleDef = SEDAN): BrakeResult {
  const v0 = 100 / 3.6;
  const { samples } = runScenario({
    def,
    initialSpeed: v0,
    initialGear: 0,
    durationS: 6,
    sampleHz: 100,
    control: () => ({ gearSelect: 0, throttle: 0, brake: 1, steer: 0 }),
    stop: (s) => s.groundSpeed < 0.1,
  });
  const s0 = samples[0]!;
  let drift = 0;
  for (const s of samples) drift = Math.max(drift, Math.abs(s.heading - s0.heading));
  const last = samples[samples.length - 1]!;
  return {
    distance: last.groundSpeed < 0.2 ? last.dist : Infinity,
    headingDrift: (drift * 180) / Math.PI,
    stopTime: last.t,
    samples,
  };
}

export interface CircleResult {
  /** Peak sustained lateral acceleration (2 s mean of v·yawRate) before breakaway, g. */
  maxLatG: number;
  /** Speed at that point, m/s. */
  speedAtMax: number;
  /** Radius at that point, m. */
  radiusAtMax: number;
  samples: HandlingSample[];
}

/**
 * Steady-state circle (constant radius, slowly increasing speed — SAE J266
 * style). A curvature controller steers to hold κ = yawRate / speed at 1/R
 * (geometric feed-forward L/R, gentle PI: the steering hydros lag ~0.1 s),
 * a speed PI ramps the target speed by `rampMs2`. Lateral g = v·r (steady
 * state, noise-free). The peak of the 1 s rolling mean is taken while the
 * radius is still held (≤ 15 % over target) and sideslip stays < 10°.
 */
export function runCircle(def: VehicleDef = SEDAN, radius = 40, rampMs2 = 0.3, startSpeed = 12): CircleResult {
  const maxWheel = def.steering.maxWheelAngleDeg * (Math.PI / 180);
  let wheelbase = 2.75;
  {
    const zs = def.wheels.map((w) => (w.hubInner[2] + w.hubOuter[2]) / 2);
    wheelbase = Math.max(...zs) - Math.min(...zs);
  }
  const ff = wheelbase / radius / maxWheel;
  let steerI = 0;
  let thrI = 0;
  let kFilt = 0;
  const dtc = 1 / 50;
  const { samples } = runScenario({
    def,
    initialSpeed: startSpeed,
    durationS: 40,
    sampleHz: 50,
    controlHz: 50,
    control: (ctx) => {
      const s = ctx.last;
      const vTarget = startSpeed + rampMs2 * Math.max(0, ctx.t - 3);
      if (s === null) return { gearSelect: 1, throttle: 0.2, steer: ff };
      const k = s.yawRate / Math.max(s.speed, 1);
      kFilt += (k - kFilt) * 0.3;
      const err = 1 / radius - kFilt;
      steerI = Math.min(1, Math.max(-1, steerI + 0.6 * radius * err * dtc));
      const steer = Math.min(1, Math.max(-1, ff * (1 + steerI) + 0.15 * radius * ff * err));
      const ev = vTarget - s.speed;
      thrI = Math.min(1, Math.max(0, thrI + 0.05 * ev * dtc));
      const thr = Math.min(1, Math.max(0, 0.1 + 0.25 * ev + thrI));
      return { gearSelect: 1, throttle: thr, brake: 0, steer };
    },
    stop: (s) => s.t > 6 && Math.abs(s.sideslip) > (15 * Math.PI) / 180,
  });
  // Rolling 2 s means of v·r and R. Near the limit the closed loop (PI
  // steer, speed ramp, power-on rear slip) swings R ±25 % with a ~3 s
  // period; 1 s means caught single swings (both the ay peaks and the first
  // wide excursion that ends the search), so the result jumped 0.74 ↔ 1.10 g
  // for a 10 % μ change. 2 s means average the cycle (0.92 / 0.99 / 1.02 g
  // at μ 1.0 / 1.05 / 1.1).
  let best = 0;
  let bestV = 0;
  let bestR = 0;
  const win = 100;
  for (let i = win; i < samples.length; i++) {
    let ay = 0;
    let v = 0;
    let w = 0;
    let slipMax = 0;
    for (let j = i - win; j < i; j++) {
      const s = samples[j]!;
      ay += s.speed * s.yawRate;
      v += s.speed;
      w += s.yawRate;
      slipMax = Math.max(slipMax, Math.abs(s.sideslip));
    }
    ay /= win;
    v /= win;
    w /= win;
    const R = Math.abs(w) > 1e-3 ? v / Math.abs(w) : Infinity;
    if (samples[i]!.t < 4) continue;
    if (R > radius * 1.15 || slipMax > (10 * Math.PI) / 180) {
      if (best > 0) break;
      continue;
    }
    if (Math.abs(ay) > best) {
      best = Math.abs(ay);
      bestV = v;
      bestR = R;
    }
  }
  return { maxLatG: best / G, speedAtMax: bestV, radiusAtMax: bestR, samples };
}

export interface StepSteerResult {
  /** Mean yaw rate over the last second, rad/s. */
  yawSteady: number;
  /** Peak yaw rate / steady. */
  overshoot: number;
  /** Std-dev of yaw rate over the last second, rad/s (settling). */
  yawStd: number;
  /** 1 if the run diverged (spun: |sideslip| > 20°). */
  spun: boolean;
  latG: number;
  samples: HandlingSample[];
}

/**
 * Step steer at 60 km/h: hold speed, steer step to `steer` at t = 0.5 s, hold 4 s.
 * R-PHYS (additive): `speedKmh` (default 60) for the ISO 7401 80 km/h step.
 */
export function runStepSteer(def: VehicleDef = SEDAN, steer = 0.12, speedKmh = 60): StepSteerResult {
  const v0 = speedKmh / 3.6;
  const { samples } = runScenario({
    def,
    initialSpeed: v0,
    durationS: 4.5,
    sampleHz: 100,
    controlHz: 100,
    control: (ctx) => {
      const s = ctx.last;
      const ev = s === null ? 0 : v0 - s.speed;
      return { gearSelect: 1, throttle: Math.min(1, Math.max(0, 0.25 + 0.3 * ev)), steer: ctx.t >= 0.5 ? steer : 0 };
    },
  });
  const tail = samples.filter((s) => s.t >= 3.5);
  const mean = tail.reduce((a, s) => a + s.yawRate, 0) / tail.length;
  const std = Math.sqrt(tail.reduce((a, s) => a + (s.yawRate - mean) ** 2, 0) / tail.length);
  let peak = 0;
  let spun = false;
  for (const s of samples) {
    if (Math.abs(s.yawRate) > Math.abs(peak)) peak = s.yawRate;
    if (Math.abs(s.sideslip) > (20 * Math.PI) / 180) spun = true;
  }
  const latG = tail.reduce((a, s) => a + s.speed * s.yawRate, 0) / tail.length / G;
  return { yawSteady: mean, overshoot: mean !== 0 ? peak / mean : Infinity, yawStd: std, spun, latG, samples };
}

export interface TopSpeedResult {
  /** Full-throttle acceleration at 200 / 210 km/h in the best gear (mean over 1–3 s), m/s². > 0 ⇒ v_max above. */
  accel200: number;
  accel210: number;
  /** Gear used at 200 / 210 km/h (most wheel force below the rev limit). */
  gear200: number;
  gear210: number;
  /** 10 s full-throttle straight from 195 km/h in the best gear: max |yaw rate| after 1 s, rad/s (weave check). */
  maxYawRate: number;
  /** …its heading change, deg… */
  headingDrift: number;
  /** …and the speed it reached, km/h. */
  endKmh: number;
  samples: HandlingSample[];
}

/**
 * Gear (1-based) with the most full-throttle wheel force at `kmh`, rpm from
 * the unloaded tyre radius (the loaded rolling radius is ~3 % smaller: the
 * real rpm is a little higher), skipping gears past 98 % of the rev limit.
 */
export function bestGear(def: VehicleDef, kmh: number): number {
  const d = def.drivetrain;
  const r = def.wheels[0]!.radius;
  const curve = d.torqueCurve;
  const torqueAt = (rpm: number): number => {
    if (rpm <= curve[0]![0]) return curve[0]![1];
    for (let i = 1; i < curve.length; i++) {
      const [r1, t1] = curve[i]!;
      const [r0, t0] = curve[i - 1]!;
      if (rpm <= r1) return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
    return curve[curve.length - 1]![1];
  };
  let best = d.gearRatios.length;
  let bestF = -Infinity;
  for (let g = 0; g < d.gearRatios.length; g++) {
    const ratio = d.gearRatios[g]! * d.finalDrive;
    const rpm = ((kmh / 3.6 / r) * ratio * 60) / (2 * Math.PI);
    if (rpm > 0.98 * d.revLimitRpm) continue;
    const f = torqueAt(rpm) * ratio;
    if (f > bestF) {
      bestF = f;
      best = g + 1;
    }
  }
  return best;
}

function fullThrottleRun(def: VehicleDef, kmh: number, durationS: number): HandlingSample[] {
  const gear = bestGear(def, kmh);
  return runScenario({
    def,
    transmission: 'manual',
    initialSpeed: kmh / 3.6,
    initialGear: gear,
    durationS,
    sampleHz: 20,
    control: () => ({ gearSelect: gear, throttle: 1, steer: 0 }),
  }).samples;
}

function fullThrottleAccel(def: VehicleDef, kmh: number): number {
  const samples = fullThrottleRun(def, kmh, 3);
  const a = samples.find((s) => s.t >= 1)!;
  const b = samples[samples.length - 1]!;
  return (b.speed - a.speed) / (b.t - a.t);
}

/**
 * Top speed as a power balance (a full run from rest takes > 60 s of sim):
 * full throttle at 200 and 210 km/h, held in the gear with the most wheel
 * force (manual box, so the measurement is the car's, not the shift
 * logic's), must still accelerate. Plus a 10 s full-throttle straight from
 * 195 km/h (it reaches ~210), which catches high-speed weave: a ±0.1 rad/s
 * yaw limit cycle at v_max before the tread hoop tension (wheels.ts
 * applyHoopTension), a spin at 185 km/h before the rear hub links were
 * stiffened (sedan.ts REAR_LINK_FACTOR) and at 205 km/h before the rigid
 * subframe (sedan.ts K_SUBFRAME).
 */
/**
 * P6: the probe speeds are parameters (defaults = the sedan's 200 / 210 /
 * 195 km/h); the result fields keep their names (`accel200` = the lower
 * probe, `accel210` the upper, `gear200` / `gear210` likewise).
 */
export interface TopSpeedOptions {
  lowKmh?: number;
  highKmh?: number;
  straightFromKmh?: number;
}
export function runTopSpeed(def: VehicleDef = SEDAN, opts: TopSpeedOptions = {}): TopSpeedResult {
  const lo = opts.lowKmh ?? 200;
  const hi = opts.highKmh ?? 210;
  const accel200 = fullThrottleAccel(def, lo);
  const accel210 = fullThrottleAccel(def, hi);
  const samples = fullThrottleRun(def, opts.straightFromKmh ?? 195, 10);
  let maxYawRate = 0;
  let drift = 0;
  const h0 = samples[0]!.heading;
  for (const s of samples) {
    if (s.t < 1) continue;
    maxYawRate = Math.max(maxYawRate, Math.abs(s.yawRate));
    drift = Math.max(drift, Math.abs(s.heading - h0));
  }
  return {
    accel200,
    accel210,
    gear200: bestGear(def, lo),
    gear210: bestGear(def, hi),
    maxYawRate,
    headingDrift: (drift * 180) / Math.PI,
    endKmh: samples[samples.length - 1]!.speed * 3.6,
    samples,
  };
}
