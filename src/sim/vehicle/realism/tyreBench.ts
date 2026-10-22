/**
 * TYRE TEST BENCH (harness only, never imported by the engine): one real
 * soft-body wheel (any vehicle's WheelDef, every per-tick kernel of the car:
 * brush, contact layer, hoop tension, rolling resistance, tyre state) on a
 * KINEMATIC carriage driven through a real SimEngine over flat asphalt — a
 * flat-track tyre tester.
 *
 * Carriage: heavy body nodes (BENCH_NODE_MASS) re-placed on the prescribed
 * path before every tick (position AND velocity), so the wheel sees a
 * perfectly rigid, prescribed hub motion through its attach beams (the car's
 * upright stiffnesses). The force the wheel puts on the carriage is read
 * back from what the engine did to the carriage nodes during the tick:
 *   F_i = m_i·((v_after − v_prescribed)/dt − g).
 * In a steady state the wheel's momentum is constant, so the ground force on
 * the tyre is F_ground = Σ F_i − m_wheel·g (vector), and the ground moment
 * about the wheel centre is Σ (r_i − c) × F_i. Measured this way, the bench
 * makes no assumption about which kernel produced the force.
 *
 * Conventions (ISO-ish, reported for a wheel heading −Z):
 *   slip angle α  = angle of the carriage velocity right of the wheel heading;
 *   Fy            = lateral ground force OPPOSING the slip (cornering force, + at α > 0);
 *   Fx            = longitudinal ground force, + = driving (forward);
 *   Fz            = vertical load, +;
 *   Mz            = aligning moment about the vertical, + = turns the wheel
 *                   toward its velocity (reduces α);
 *   κ (slip ratio) = (ω·r_roll − V_x)/|V_x|;
 *   γ (camber)     = top of the wheel leaning OUTBOARD (−X for this left
 *                   wheel) is positive; the camber thrust of a left wheel with
 *                   positive camber points outboard.
 */
import { MaterialId } from '../../../protocol/messages';
import { SimEngine, SIM_DT, SIM_HZ } from '../../engine';
import type { SimObject } from '../../types';
import type { DrivetrainDef, VehicleDef, VehicleRuntime, WheelDef } from '../types';

export const BENCH_G = 9.81;
const BENCH_NODE_MASS = 2000;
const ARM_K = 1.2e6;
const ARM_D = 400;

export interface TyreBenchOptions {
  /** Speed of the carriage, m/s. */
  speed?: number;
  /** Target vertical load, N. */
  load: number;
  /** Camber angle, rad (see header). */
  camber?: number;
  /** Ground material. */
  materialId?: number;
  /** R-TYRE: surface water (engine setSurfaceWetness), 0..1. */
  wetness?: number;
  rain?: number;
  /** R-TYRE: remaining tread depth, mm (engine setTyre treadMm; default new). */
  treadMm?: number;
}

export interface TyreBench {
  eng: SimEngine;
  obj: SimObject;
  veh: VehicleRuntime;
  wheelDef: WheelDef;
  /** Wheel mass (hub + rim + tyre nodes after MINIMASS), kg. */
  wheelMass: number;
  /** Current prescribed slip angle, rad. */
  alpha: number;
  speed: number;
  camber: number;
  /** Target load, N. */
  load: number;
  /** Carriage ride height offset (load controller state), m. */
  h: number;
  /** Load controller integral. */
  hI: number;
  /** Distance travelled, m. */
  dist: number;
  /** ω command (rad/s) for the wheel-speed servo, or NaN = free rolling. */
  omegaCmd: number;
  /** Extra axle torque applied this tick by the servo, N·m. */
  servoTorque: number;
  /** Raw per-tick measurements of the last tick. */
  fx: number;
  fy: number;
  fz: number;
  mz: number;
  /** Path position of the carriage along −Z, m. */
  pathZ: number;
  /** Low-passed Fz for the load servo, N. */
  fzFilt: number;
  /** Carriage node rest positions (rig-local, before camber), xyz triplets. */
  rest: Float64Array;
  /** Carriage node indices (global). */
  nodes: Int32Array;
}

/** Bench drivetrain: never drives (the wheel is undriven), neutral. */
const BENCH_DRIVETRAIN: DrivetrainDef = {
  torqueCurve: [
    [0, 10],
    [8000, 10],
  ],
  idleRpm: 800,
  redlineRpm: 6000,
  revLimitRpm: 6500,
  engineInertia: 0.2,
  engineBrakeTorque: 0,
  gearRatios: [1],
  reverseRatio: 1,
  finalDrive: 1,
  shiftTimeS: 0.2,
  autoShiftUpRpm: 5000,
  autoShiftDownRpm: 2000,
  diff: 'open',
  clutchMaxTorque: 100,
  transmission: 'manual',
};

/**
 * VehicleDef of the bench: carriage nodes o (origin, wheel centre height,
 * inboard), f (front), t (top), k (upright top, the wheel's attach node,
 * 0.25 m above the centre), a / b (lower pivots fore / aft). The wheel is a
 * LEFT wheel (outboard −X) at x 0..−width.
 */
export function benchDef(src: WheelDef): { def: VehicleDef; wheel: WheelDef } {
  const R = src.radius;
  const w = src.width;
  const xin = 0.25;
  const m = BENCH_NODE_MASS;
  const nodes = [
    { id: 'o', pos: [xin + 0.3, R, 0] as [number, number, number], mass: m, collidable: false, group: 'bench' },
    { id: 'f', pos: [xin + 0.3, R, -0.6] as [number, number, number], mass: m, collidable: false, group: 'bench' },
    { id: 't', pos: [xin + 0.3, R + 0.6, 0] as [number, number, number], mass: m, collidable: false, group: 'bench' },
    { id: 'k', pos: [-w / 2, R + 0.25, 0] as [number, number, number], mass: m, collidable: false, group: 'bench' },
    { id: 'a', pos: [xin, R, -0.3] as [number, number, number], mass: m, collidable: false, group: 'bench' },
    { id: 'b', pos: [xin, R, 0.3] as [number, number, number], mass: m, collidable: false, group: 'bench' },
  ];
  const wheel: WheelDef = {
    // the bench's own mass would make the default design load meaningless: 4 kN unless the def says
    tyreDesignLoad: 4000,
    ...src,
    id: 'W',
    hubInner: [0, R, 0],
    hubOuter: [-w, R, 0],
    axle: 'front',
    steered: false,
    driven: false,
    braked: true,
    handbrake: false,
    attach: ['k'],
  };
  const beams = [
    { a: 'W.hubI', b: 'a', type: 'normal' as const, k: ARM_K, d: ARM_D, deform: 0, breakF: 0 },
    { a: 'W.hubI', b: 'b', type: 'normal' as const, k: ARM_K, d: ARM_D, deform: 0, breakF: 0 },
    { a: 'W.hubO', b: 'a', type: 'normal' as const, k: ARM_K, d: ARM_D, deform: 0, breakF: 0 },
    { a: 'W.hubO', b: 'b', type: 'normal' as const, k: ARM_K, d: ARM_D, deform: 0, breakF: 0 },
  ];
  const def: VehicleDef = {
    name: 'tyreBench',
    body: { name: 'tyreBenchBody', nodes, beams },
    wheels: [{ ...wheel, attachBreakF: 0 }],
    drivetrain: BENCH_DRIVETRAIN,
    brakes: { frontBias: 0.5, handbrakeTorqueMax: 0 },
    aero: { dragCoeffArea: 0, liftCoeffArea: 0 },
    steering: { maxWheelAngleDeg: 30 },
    frame: { origin: 'o', front: 'f', top: 't' },
    shell: false,
  };
  return { def, wheel };
}

/**
 * Builds the bench with the wheel resting on the ground at about the target
 * load and rolling at `speed`, then settles 0.5 s (load servo converged).
 */
export function createTyreBench(src: WheelDef, opts: TyreBenchOptions): TyreBench {
  const { def, wheel } = benchDef(src);
  const eng = new SimEngine({
    gravity: [0, -BENCH_G, 0],
    debugStrains: false,
    capacity: { maxObjects: 2, nodeCapacity: 512, beamCapacity: 2048 },
  });
  eng.setGroundPlane(0, opts.materialId ?? MaterialId.asphalt);
  if (opts.wetness !== undefined || opts.rain !== undefined) eng.setSurfaceWetness(opts.wetness ?? 0, opts.rain ?? 0);
  // Start with the carriage lifted so the tyre just touches; the load servo sinks it.
  const obj = eng.spawnVehicle(1, def, { pos: [0, 0.01, 0], quat: [0, 0, 0, 1] }, 'manual');
  const veh = eng.getVehicle(1)!;
  if (opts.treadMm !== undefined) eng.setTyre({ objectId: 1, treadMm: opts.treadMm });
  const s = eng.state;
  const nCarriage = def.body.nodes.length;
  const nodes = new Int32Array(nCarriage);
  const rest = new Float64Array(3 * nCarriage);
  for (let i = 0; i < nCarriage; i++) {
    const g = obj.nodeStart + i;
    nodes[i] = g;
    rest[3 * i] = s.posX[g]!;
    rest[3 * i + 1] = s.posY[g]!;
    rest[3 * i + 2] = s.posZ[g]!;
  }
  let wheelMass = 0;
  for (let i = obj.nodeStart + nCarriage; i < obj.nodeStart + obj.nodeCount; i++) wheelMass += 1 / s.invMass[i]!;
  const b: TyreBench = {
    eng,
    obj,
    veh,
    wheelDef: wheel,
    wheelMass,
    alpha: 0,
    speed: opts.speed ?? 15,
    camber: opts.camber ?? 0,
    load: opts.load,
    h: 0,
    hI: 0,
    dist: 0,
    omegaCmd: NaN,
    servoTorque: 0,
    fx: 0,
    fy: 0,
    fz: 0,
    mz: 0,
    pathZ: 0,
    fzFilt: 0,
    rest,
    nodes,
  };
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
  // Settle at rest (load servo), then spin up to speed.
  for (let i = 0; i < 0.6 * SIM_HZ; i++) benchStep(b, 0);
  spinUp(b);
  for (let i = 0; i < 0.4 * SIM_HZ; i++) benchStep(b);
  b.dist = 0;
  return b;
}

/** Gives every wheel node the rolling motion at the bench speed (carriage velocity + ω × r). */
function spinUp(b: TyreBench): void {
  const s = b.eng.state;
  const w = b.veh.wheels[0]!;
  const v = b.speed;
  const vx = 0;
  const vz = -1;
  const om = v / w.rollRadius;
  const hi = w.hubI;
  const ho = w.hubO;
  const cx = (s.posX[hi]! + s.posX[ho]!) / 2;
  const cy = (s.posY[hi]! + s.posY[ho]!) / 2;
  const cz = (s.posZ[hi]! + s.posZ[ho]!) / 2;
  let ax = s.posX[ho]! - s.posX[hi]!;
  let ay = s.posY[ho]! - s.posY[hi]!;
  let az = s.posZ[ho]! - s.posZ[hi]!;
  const al = Math.hypot(ax, ay, az);
  const sg = w.wheel.spinSign / al;
  ax *= sg;
  ay *= sg;
  az *= sg;
  const start = b.obj.nodeStart + b.nodes.length;
  for (let i = start; i < b.obj.nodeStart + b.obj.nodeCount; i++) {
    const rx = s.posX[i]! - cx;
    const ry = s.posY[i]! - cy;
    const rz = s.posZ[i]! - cz;
    s.velX[i] = vx * v + om * (ay * rz - az * ry);
    s.velY[i] = om * (az * rx - ax * rz);
    s.velZ[i] = vz * v + om * (ax * ry - ay * rx);
  }
  w.omega = om;
}

const LOAD_KP = 2e-6;
const LOAD_KI = 1e-4;
const LOAD_FILTER = 0.02;

/**
 * One tick: place the carriage (path + camber + ride height), optional
 * wheel-speed servo, engine step, read back the carriage reaction.
 * `speedOverride` = carriage speed this tick (0 while settling).
 */
export function benchStep(b: TyreBench, speedOverride?: number): void {
  const eng = b.eng;
  const s = eng.state;
  const v = speedOverride ?? b.speed;
  // The carriage always travels along −Z; the slip angle is set by YAWING the carriage (a steered wheel, as
  // on a flat-track tester) by ψ = −α (heading rotated left of the velocity: the velocity is right of it).
  const vz = -v;
  b.dist += v * SIM_DT;
  const ca = Math.cos(b.alpha);
  const sa = Math.sin(b.alpha);
  const cg = Math.cos(b.camber);
  const sgm = Math.sin(b.camber);
  const xc = -b.wheelDef.width / 2;
  const n = b.nodes.length;
  for (let i = 0; i < n; i++) {
    const g = b.nodes[i]!;
    // camber: rotate about the forward (Z) axis through the contact point (x = xc, y = 0); + leans the top to −X
    const px = b.rest[3 * i]! - xc;
    const py = b.rest[3 * i + 1]!;
    const pz = b.rest[3 * i + 2]!;
    const rx = px * cg - py * sgm;
    const ry = px * sgm + py * cg;
    // yaw by −α about +Y through the wheel centre: heading −Z → (−sin α, 0, −cos α)
    const yx = rx * ca + pz * sa;
    const yz = -rx * sa + pz * ca;
    s.posX[g] = yx + xc;
    s.posY[g] = ry + b.h;
    s.posZ[g] = yz + b.pathZ;
    s.velX[g] = 0;
    s.velY[g] = 0;
    s.velZ[g] = vz;
  }
  b.pathZ += vz * SIM_DT;
  // Wheel-speed servo (slip-ratio sweeps): stiff P on ω, as an axle torque on the tyre ring.
  const w = b.veh.wheels[0]!;
  b.servoTorque = 0;
  if (b.omegaCmd === b.omegaCmd) {
    const I = (b.veh.drivetrain as unknown as { wheelInertia: Float64Array }).wheelInertia[0]!;
    // ω-servo gain: I/τ with τ = 4 ms (well under the tyre's longitudinal dynamics, ≥ 10 dt).
    const tau = (I / 0.004) * (b.omegaCmd - w.omega);
    b.servoTorque = tau;
    addAxleTorque(b, tau);
  }
  eng.step();
  // Read back the reaction on the carriage.
  let Fx = 0;
  let Fy = 0;
  let Fz = 0;
  let My = 0;
  const hi = w.hubI;
  const ho = w.hubO;
  const cx = (s.posX[hi]! + s.posX[ho]!) / 2;
  const cz = (s.posZ[hi]! + s.posZ[ho]!) / 2;
  for (let i = 0; i < n; i++) {
    const g = b.nodes[i]!;
    const m = 1 / s.invMass[g]!;
    const fx = m * (s.velX[g]! / SIM_DT);
    const fy = m * (s.velY[g]! / SIM_DT + BENCH_G);
    const fz = m * ((s.velZ[g]! - vz) / SIM_DT);
    Fx += fx;
    Fy += fy;
    Fz += fz;
    // vertical moment about the wheel centre, (r × F)_y = rz·fx − rx·fz, at the prescribed (pre-step) positions
    const rx = s.posX[g]! - s.velX[g]! * SIM_DT - cx;
    const rz = s.posZ[g]! - s.velZ[g]! * SIM_DT - cz;
    My += rz * fx - rx * fz;
  }
  // Ground force on the wheel = reaction on the carriage minus the wheel weight (steady state).
  const gx = Fx;
  const gy = Fy + b.wheelMass * BENCH_G;
  const gz = Fz;
  // Wheel frame: heading h = (−sin α, 0, −cos α), right r = (cos α, 0, −sin α).
  b.fx = -sa * gx - ca * gz;
  // Cornering force opposes the slip (velocity right of the heading): Fy = −g·r.
  b.fy = -(ca * gx - sa * gz);
  b.fz = gy;
  // Aligning: + turns the heading toward the velocity, i.e. to the right: a rotation about −Y.
  b.mz = -My;
  // Load servo on the filtered vertical force (ride height h; h down = more load).
  b.fzFilt += (b.fz - b.fzFilt) * LOAD_FILTER;
  const e = b.load - b.fzFilt;
  b.hI += LOAD_KI * e * SIM_DT;
  b.h = -(b.hI + LOAD_KP * e);
}

/** Axle torque τ (about s, + = forward roll) as tangential forces on the tyre ring, reaction on the hubs. */
function addAxleTorque(b: TyreBench, tau: number): void {
  const s = b.eng.state;
  const w = b.veh.wheels[0]!;
  const hi = w.hubI;
  const ho = w.hubO;
  const cx = (s.posX[hi]! + s.posX[ho]!) / 2;
  const cy = (s.posY[hi]! + s.posY[ho]!) / 2;
  const cz = (s.posZ[hi]! + s.posZ[ho]!) / 2;
  let sx = s.posX[ho]! - s.posX[hi]!;
  let sy = s.posY[ho]! - s.posY[hi]!;
  let sz = s.posZ[ho]! - s.posZ[hi]!;
  const l = Math.hypot(sx, sy, sz);
  const k = w.wheel.spinSign / l;
  sx *= k;
  sy *= k;
  sz *= k;
  const n = w.ringCount;
  const coef = tau / (n * w.wheel.tireRingRadius);
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (let i = w.tireStart; i < w.tireStart + n; i++) {
    const rx = s.posX[i]! - cx;
    const ry = s.posY[i]! - cy;
    const rz = s.posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    const pl = Math.hypot(px, py, pz);
    const g = coef / pl;
    const fx = g * (sy * pz - sz * py);
    const fy = g * (sz * px - sx * pz);
    const fz = g * (sx * py - sy * px);
    s.frcX[i] = s.frcX[i]! + fx;
    s.frcY[i] = s.frcY[i]! + fy;
    s.frcZ[i] = s.frcZ[i]! + fz;
    tx += fx;
    ty += fy;
    tz += fz;
  }
  s.frcX[hi] = s.frcX[hi]! - tx / 2;
  s.frcY[hi] = s.frcY[hi]! - ty / 2;
  s.frcZ[hi] = s.frcZ[hi]! - tz / 2;
  s.frcX[ho] = s.frcX[ho]! - tx / 2;
  s.frcY[ho] = s.frcY[ho]! - ty / 2;
  s.frcZ[ho] = s.frcZ[ho]! - tz / 2;
}
