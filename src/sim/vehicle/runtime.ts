/**
 * Vehicle runtime (WORKER-ONLY): per spawned vehicle state, the per-tick
 * vehicle pre-step, aero, recover, damage and snapshot telemetry.
 *
 * Per-tick order (contract, runs before steering hydros and beams):
 *   estimateWheelOmega (all wheels) → stepDrivetrain → applyWheelTorques
 *   (per wheel, declaration order) → applyParkingClamp → applyAero.
 *
 * Hot paths (vehiclePreStep, applyAero) use only + − × ÷ sqrt, fixed order,
 * no allocation. Spawn/recover/reset/telemetry helpers are not per-tick hot.
 */
import type { Vec3 } from '../../core/math';
import { TELEMETRY_SLOTS } from '../../protocol/layout';
import {
  CORNER_BIT,
  TELEMETRY_CORNER_COUNT,
  VehicleTelemetry,
  WHEEL_LOAD_SLOTS,
  WHEEL_OMEGA_SLOTS,
  WHEEL_SLIP_SLOTS,
} from '../../protocol/telemetry';
import { BeamType, NODE_FLAG_COLLIDABLE, NODE_FLAG_IN_CONTACT, type HeightSampler, type SimState } from '../types';
import {
  computeWheelInertia,
  createDrivetrainState,
  resetDrivetrainState,
  stepDrivetrain,
  type DrivetrainStateEx,
} from './drivetrain';
import type {
  CompiledVehicle,
  CompiledWheel,
  ComputeDamage,
  RebaseVehicle,
  TransmissionMode,
  VehicleRuntime,
  WheelRuntime,
} from './types';
import { applyParkingClamp, applyTreadBrush, applyWheelTorques, estimateWheelOmega } from './wheels';

/** Air density, kg/m³ (AeroDef contract). */
export const AIR_DENSITY = 1.225;
/**
 * Damage: a beam counts fully damaged when broken, or in proportion to its
 * plastic strain max(|restLen − restLen0|/restLen0, 1 − k/k0) up to this value
 * (beams below the contract's 1e-3 threshold count 0). Severity weighting
 * keeps the gauge from jumping to "wrecked" on a kerb tap.
 */
export const DAMAGE_FULL_STRAIN = 0.02;
export const DAMAGE_MIN_STRAIN = 1e-3;
/** Recover: default lift above the current origin and minimum ground clearance, m. */
export const RECOVER_LIFT = 0.5;
export const RECOVER_CLEARANCE = 0.05;
/** Recover: the default placement never drops the car from higher than this clearance, m. */
export const RECOVER_MAX_DROP = 0.3;

/** VehicleRuntime plus spawn-time constants (createVehicleRuntime builds these). */
export interface VehicleRuntimeEx extends VehicleRuntime {
  drivetrain: DrivetrainStateEx;
  /**
   * RIG-LOCAL indices of beams that can be damaged (finite deform or finite
   * breakF): the damage denominator. Tyre beams never deform/break and are
   * excluded so a wreck can actually reach 1.
   */
  damageBeams: Int32Array;
  /** Free (unpinned) body-node mass, kg (aero distribution). */
  bodyMass: number;
}

// ------------------------------------------------------------ create / rebase
/**
 * Effective rolling radius of a soft-body wheel: the perimeter of the tread
 * polygon over 2π, r_ring·n·sin(π/n)/π. Contact tread nodes stick, so one
 * revolution advances the hub by n tread chords (measured free rolling:
 * 0.272 m vs 0.272 predicted for the 205/55R16 tuning; the unloaded radius
 * read +9 % slip, the loaded radius +4 %).
 */
export function rollingRadius(w: CompiledWheel): number {
  return (w.tireRingRadius * w.rays * Math.sin(Math.PI / w.rays)) / Math.PI;
}

function makeWheel(vehicle: CompiledVehicle, index: number): WheelRuntime {
  const cw = vehicle.wheels[index]!;
  return {
    wheel: cw,
    hubI: cw.hubI,
    hubO: cw.hubO,
    rimStart: cw.rimStart,
    tireStart: cw.tireStart,
    ringCount: 2 * cw.rays,
    hubLinkBeams: new Int32Array(cw.hubLinkBeams.length),
    attachNodes: new Int32Array(cw.attachNodes.length),
    omega: 0,
    load: 0,
    slipSpeed: 0,
    slipRatio: 0,
    rollRadius: rollingRadius(cw),
    treadLoad: new Float64Array(2 * cw.rays),
    treadNormal: new Float64Array(6 * cw.rays),
    treadBrush: new Float64Array(6 * cw.rays),
    contact: 0,
    detached: 0,
    driveTorque: 0,
    brakeTorque: 0,
  };
}

/** Runtime for a vehicle whose merged rig sits at arena [nodeStart…], [beamStart…]. */
export function createVehicleRuntime(
  objectId: number,
  vehicle: CompiledVehicle,
  nodeStart: number,
  beamStart: number,
  transmission: TransmissionMode = vehicle.drivetrain.transmission,
): VehicleRuntimeEx {
  const rig = vehicle.rig;
  const wheels: WheelRuntime[] = [];
  for (let w = 0; w < vehicle.wheels.length; w++) wheels.push(makeWheel(vehicle, w));
  const dmg: number[] = [];
  for (let b = 0; b < rig.beamCount; b++) {
    if (Number.isFinite(rig.beamDeform[b]!) || Number.isFinite(rig.beamBreakF[b]!)) dmg.push(b);
  }
  let bodyMass = 0;
  for (let i = 0; i < vehicle.bodyNodeCount; i++) {
    const im = rig.nodeInvMass[i]!;
    if (im > 0) bodyMass += 1 / im;
  }
  const rt: VehicleRuntimeEx = {
    objectId,
    vehicle,
    nodeStart: 0,
    beamStart: 0,
    wheels,
    drivetrain: createDrivetrainState(vehicle.drivetrain, computeWheelInertia(vehicle), transmission),
    telemetry: new Float32Array(TELEMETRY_SLOTS),
    damageBeams: Int32Array.from(dmg),
    bodyMass,
  };
  rebaseVehicle(rt, nodeStart, beamStart);
  return rt;
}

/** Updates every global index after the object's arena range moved. */
export const rebaseVehicle: RebaseVehicle = (vehicle, nodeStart, beamStart) => {
  vehicle.nodeStart = nodeStart;
  vehicle.beamStart = beamStart;
  for (const w of vehicle.wheels) {
    const cw = w.wheel;
    w.hubI = nodeStart + cw.hubI;
    w.hubO = nodeStart + cw.hubO;
    w.rimStart = nodeStart + cw.rimStart;
    w.tireStart = nodeStart + cw.tireStart;
    for (let j = 0; j < cw.hubLinkBeams.length; j++) w.hubLinkBeams[j] = beamStart + cw.hubLinkBeams[j]!;
    for (let j = 0; j < cw.attachNodes.length; j++) w.attachNodes[j] = nodeStart + cw.attachNodes[j]!;
  }
};

/** After a full repair (reset): wheels re-attached, drivetrain back to idle/neutral (mode kept). */
export function resetVehicleRuntime(vehicle: VehicleRuntime): void {
  for (const w of vehicle.wheels) {
    w.omega = 0;
    w.load = 0;
    w.slipSpeed = 0;
    w.slipRatio = 0;
    w.contact = 0;
    w.detached = 0;
    w.driveTorque = 0;
    w.brakeTorque = 0;
    w.treadLoad.fill(0);
    w.treadBrush.fill(0);
  }
  resetDrivetrainState(vehicle.drivetrain as DrivetrainStateEx, vehicle.vehicle.drivetrain);
  vehicle.telemetry.fill(0);
}

// ------------------------------------------------------------ per tick
/**
 * Quadratic aero on the BODY nodes' COM velocity, distributed by mass (so it
 * is a uniform acceleration of the body): drag −½ρ·CdA·|v|·v, lift
 * +½ρ·ClA·|v|²·up_vehicle (negative ClA = downforce).
 */
export function applyAero(state: SimState, vehicle: VehicleRuntime): void {
  const v = vehicle as VehicleRuntimeEx;
  const aero = v.vehicle.aero;
  const M = v.bodyMass;
  if (!(M > 0) || (aero.dragCoeffArea === 0 && aero.liftCoeffArea === 0)) return;
  const { velX, velY, velZ, frcX, frcY, frcZ, invMass } = state;
  const start = v.nodeStart;
  const end = start + v.vehicle.bodyNodeCount;
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = start; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const m = 1 / im;
    px += m * velX[i]!;
    py += m * velY[i]!;
    pz += m * velZ[i]!;
  }
  const vx = px / M;
  const vy = py / M;
  const vz = pz / M;
  const v2 = vx * vx + vy * vy + vz * vz;
  if (!(v2 > 1e-8)) return;
  const q = 0.5 * AIR_DENSITY;
  const speed = Math.sqrt(v2);
  const dragK = -q * aero.dragCoeffArea * speed;
  // Force per kg (divide by M once): F_i = F·m_i/M.
  let ax = (dragK * vx) / M;
  let ay = (dragK * vy) / M;
  let az = (dragK * vz) / M;
  if (aero.liftCoeffArea !== 0) {
    const fr = v.vehicle.frameNodes;
    const o = start + fr[0]!;
    const f = start + fr[1]!;
    const t = start + fr[2]!;
    const { posX, posY, posZ } = state;
    let fx = posX[f]! - posX[o]!;
    let fy = posY[f]! - posY[o]!;
    let fz = posZ[f]! - posZ[o]!;
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    let ux = posX[t]! - posX[o]!;
    let uy = posY[t]! - posY[o]!;
    let uz = posZ[t]! - posZ[o]!;
    if (fl > 1e-9) {
      fx /= fl;
      fy /= fl;
      fz /= fl;
      const d = ux * fx + uy * fy + uz * fz;
      ux -= d * fx;
      uy -= d * fy;
      uz -= d * fz;
    }
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (ul > 1e-9) {
      const lift = (q * aero.liftCoeffArea * v2) / (ul * M);
      ax += lift * ux;
      ay += lift * uy;
      az += lift * uz;
    }
  }
  for (let i = start; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const m = 1 / im;
    frcX[i] = frcX[i]! + ax * m;
    frcY[i] = frcY[i]! + ay * m;
    frcZ[i] = frcZ[i]! + az * m;
  }
}

/**
 * The vehicle pre-step: ω estimate → drivetrain → wheel torques → parking
 * clamp → aero. `actions` = the object's protocol action array.
 */
export function vehiclePreStep(state: SimState, vehicle: VehicleRuntime, actions: Float64Array, dt: number): void {
  const wheels = vehicle.wheels;
  for (let w = 0; w < wheels.length; w++) estimateWheelOmega(state, wheels[w]!);
  stepDrivetrain(state, vehicle, actions, dt, vehicle.telemetry);
  for (let w = 0; w < wheels.length; w++) {
    const wr = wheels[w]!;
    applyWheelTorques(state, wr, wr.driveTorque, wr.brakeTorque);
    applyTreadBrush(state, wr, dt);
  }
  applyParkingClamp(state, vehicle, actions, dt);
  applyAero(state, vehicle);
}

// ------------------------------------------------------------ damage / telemetry
/** 0..1 severity-weighted fraction of damageable beams broken or plastically deformed. */
export const computeDamage: ComputeDamage = (state, vehicle) => {
  const v = vehicle as VehicleRuntimeEx;
  const list = v.damageBeams;
  const n = list.length;
  if (n === 0) return 0;
  const { active, restLen, restLen0, k, k0, type } = state;
  const base = v.beamStart;
  let sum = 0;
  for (let j = 0; j < n; j++) {
    const b = base + list[j]!;
    if (active[b] === 0) {
      sum += 1;
      continue;
    }
    let e = 0;
    // Hydro rest length is driven by steering, not plasticity.
    if (type[b] !== BeamType.hydro) {
      const r0 = restLen0[b]!;
      const dr = restLen[b]! - r0;
      e = (dr < 0 ? -dr : dr) / r0;
    }
    const kk = k0[b]!;
    if (kk > 0) {
      const ek = 1 - k[b]! / kk;
      if (ek > e) e = ek;
    }
    if (e > DAMAGE_MIN_STRAIN) sum += e >= DAMAGE_FULL_STRAIN ? 1 : e / DAMAGE_FULL_STRAIN;
  }
  const d = sum / n;
  return d > 1 ? 1 : d;
};

/**
 * Completes vehicle.telemetry for a snapshot (stepDrivetrain already wrote
 * rpm/gear/pedals/torques this tick): speed, COM/velocity, per-corner wheel
 * slip/load/ω, damage, airborne and the detached/contact bitmasks. Returns
 * vehicle.telemetry. Snapshot-rate only.
 */
export function writeVehicleTelemetry(state: SimState, vehicle: VehicleRuntime): Float32Array {
  const T = VehicleTelemetry;
  const out = vehicle.telemetry;
  const { posX, posY, posZ, velX, velY, velZ, invMass } = state;
  const start = vehicle.nodeStart;
  const end = start + vehicle.vehicle.rig.nodeCount;
  let M = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = start; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const m = 1 / im;
    M += m;
    cx += m * posX[i]!;
    cy += m * posY[i]!;
    cz += m * posZ[i]!;
    vx += m * velX[i]!;
    vy += m * velY[i]!;
    vz += m * velZ[i]!;
  }
  if (M > 0) {
    cx /= M;
    cy /= M;
    cz /= M;
    vx /= M;
    vy /= M;
    vz /= M;
  }
  const fr = vehicle.vehicle.frameNodes;
  const o = start + fr[0]!;
  const f = start + fr[1]!;
  let fx = posX[f]! - posX[o]!;
  let fy = posY[f]! - posY[o]!;
  let fz = posZ[f]! - posZ[o]!;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (fl > 1e-9) {
    fx /= fl;
    fy /= fl;
    fz /= fl;
  }
  out[T.speed] = vx * fx + vy * fy + vz * fz;
  out[T.comX] = cx;
  out[T.comY] = cy;
  out[T.comZ] = cz;
  out[T.velX] = vx;
  out[T.velY] = vy;
  out[T.velZ] = vz;

  for (let c = 0; c < TELEMETRY_CORNER_COUNT; c++) {
    out[WHEEL_SLIP_SLOTS[c]!] = 0;
    out[WHEEL_LOAD_SLOTS[c]!] = 0;
    out[WHEEL_OMEGA_SLOTS[c]!] = 0;
  }
  let detached = 0;
  let contact = 0;
  let anyGround = false;
  for (const w of vehicle.wheels) {
    if (w.detached === 0 && w.contact !== 0) anyGround = true;
    const c = w.wheel.corner;
    if (c < 0 || c >= TELEMETRY_CORNER_COUNT) continue;
    out[WHEEL_SLIP_SLOTS[c]!] = w.slipSpeed;
    out[WHEEL_LOAD_SLOTS[c]!] = w.load;
    out[WHEEL_OMEGA_SLOTS[c]!] = w.omega;
    if (w.detached !== 0) detached |= CORNER_BIT[c]!;
    if (w.contact !== 0) contact |= CORNER_BIT[c]!;
  }
  out[T.wheelsDetached] = detached;
  out[T.wheelContact] = contact;
  out[T.airborne] = anyGround ? 0 : 1;
  out[T.damage] = computeDamage(state, vehicle);
  return out;
}

// ------------------------------------------------------------ recover
/**
 * Recover (R): rigidly re-places the CURRENT (deformed) node set so the
 * vehicle frame's up is world +Y with the heading kept, frame origin at `pos`
 * (default: current origin + RECOVER_LIFT up, then ground-clearance adjusted
 * so the lowest collidable node sits RECOVER_CLEARANCE..RECOVER_MAX_DROP
 * above the ground: never buried, never dropped from high up — an
 * upside-down origin can be a metre above where the wheels belong). Velocities and
 * forces are zeroed and contact flags cleared; beams (damage) and the
 * drivetrain are untouched. Not a hot path.
 */
export function recoverVehicle(
  state: SimState,
  vehicle: VehicleRuntime,
  sampler: HeightSampler | null,
  pos?: Vec3,
): void {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, flags, invMass, radius } = state;
  const start = vehicle.nodeStart;
  const end = start + vehicle.vehicle.rig.nodeCount;
  const fr = vehicle.vehicle.frameNodes;
  const o = start + fr[0]!;
  const f = start + fr[1]!;
  const t = start + fr[2]!;
  const ox = posX[o]!;
  const oy = posY[o]!;
  const oz = posZ[o]!;
  // Current orthonormal frame (forward, up, right = forward × up).
  let fx = posX[f]! - ox;
  let fy = posY[f]! - oy;
  let fz = posZ[f]! - oz;
  let l = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (!(l > 1e-9)) {
    fx = 0;
    fy = 0;
    fz = -1;
    l = 1;
  }
  fx /= l;
  fy /= l;
  fz /= l;
  let ux = posX[t]! - ox;
  let uy = posY[t]! - oy;
  let uz = posZ[t]! - oz;
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  l = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(l > 1e-9)) {
    // Degenerate: pick any up perpendicular to forward.
    ux = -fy * fx;
    uy = 1 - fy * fy;
    uz = -fy * fz;
    l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  }
  ux /= l;
  uy /= l;
  uz /= l;
  const rx = fy * uz - fz * uy;
  const ry = fz * ux - fx * uz;
  const rz = fx * uy - fy * ux;

  // Target frame: up = +Y, forward = horizontal heading.
  let hx = fx;
  let hz = fz;
  let hl = Math.sqrt(hx * hx + hz * hz);
  if (hl < 1e-3) {
    // Nose straight up/down: the roof points back (nose-up) or ahead (nose-down).
    const sgn = fy > 0 ? -1 : 1;
    hx = sgn * ux;
    hz = sgn * uz;
    hl = Math.sqrt(hx * hx + hz * hz);
    if (hl < 1e-6) {
      hx = 0;
      hz = -1;
      hl = 1;
    }
  }
  hx /= hl;
  hz /= hl;
  // right' = forward' × up' = (hx,0,hz) × (0,1,0) = (−hz, 0, hx)
  const r2x = -hz;
  const r2z = hx;

  let tx: number;
  let ty: number;
  let tz: number;
  if (pos) {
    tx = pos[0];
    ty = pos[1];
    tz = pos[2];
  } else {
    tx = ox;
    ty = oy + RECOVER_LIFT;
    tz = oz;
  }
  for (let i = start; i < end; i++) {
    const dx = posX[i]! - ox;
    const dy = posY[i]! - oy;
    const dz = posZ[i]! - oz;
    const a = dx * rx + dy * ry + dz * rz; // right
    const b = dx * ux + dy * uy + dz * uz; // up
    const c = dx * fx + dy * fy + dz * fz; // forward
    posX[i] = tx + a * r2x + c * hx;
    posY[i] = ty + b;
    posZ[i] = tz + a * r2z + c * hz;
  }
  if (!pos && sampler !== null) {
    let minGap = Infinity;
    for (let i = start; i < end; i++) {
      if ((flags[i]! & NODE_FLAG_COLLIDABLE) === 0 || invMass[i] === 0) continue;
      const gap = posY[i]! - radius[i]! - sampler.heightAt(posX[i]!, posZ[i]!);
      if (gap < minGap) minGap = gap;
    }
    let lift = 0;
    if (minGap < RECOVER_CLEARANCE) lift = RECOVER_CLEARANCE - minGap;
    else if (minGap > RECOVER_MAX_DROP && minGap !== Infinity) lift = RECOVER_MAX_DROP - minGap;
    if (lift !== 0) for (let i = start; i < end; i++) posY[i] = posY[i]! + lift;
  }
  for (let i = start; i < end; i++) {
    velX[i] = 0;
    velY[i] = 0;
    velZ[i] = 0;
    frcX[i] = 0;
    frcY[i] = 0;
    frcZ[i] = 0;
    flags[i] = flags[i]! & ~NODE_FLAG_IN_CONTACT;
  }
  for (const w of vehicle.wheels) {
    w.omega = 0;
    w.contact = 0;
    w.load = 0;
    w.slipSpeed = 0;
    w.treadLoad.fill(0);
    w.treadBrush.fill(0);
  }
}
