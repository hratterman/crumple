/**
 * Traffic variants (P6, T1; worker): compile once per config, settle the
 * SETTLED TEMPLATE, measure poses from frame nodes, place a promoted car.
 *
 * SETTLED TEMPLATE (TrafficReadyMsg.variants[i].settled, rig-local): the
 * variant spawned at rest on a private plane y = 0, neutral, brakes on,
 * stepped TEMPLATE_SETTLE_S; then rigidly re-aligned so its frame basis
 * (VehicleDef.frame origin/front/top) equals the REST frame basis and the
 * frame origin is at the rest x/z — the settle height is kept, so the
 * tyres stand on y = 0 (the rig ground plane). A ghost at pose (q, p)
 * draws q·template + p; a promotion spawns exactly those nodes.
 *
 * POSE of an awake car (record + scheduler): Q = R_now·R_restᵀ (R = the
 * orthonormal frame basis [right, up, forward] from the frame nodes), pos =
 * origin_now − Q·origin_template, so Q·template + pos reproduces the nodes
 * where the car is rigid; for a freshly promoted car it equals the ghost
 * pose it spawned from (no pose jump).
 */
import type { Transform } from '../../protocol/messages';
import { quatFromBasis } from '../../world/routes';
import type { SimEngine } from '../engine';
import type { SimObject, SimState } from '../types';
import { RPM_PER_RAD_S, type DrivetrainStateEx } from '../vehicle/drivetrain';
import type { CompiledVehicle, VehicleRuntime } from '../vehicle/types';

/** Template settle time on the private plane, s (contract: 1.5 s). */
export const TEMPLATE_SETTLE_S = 1.5;

export interface TrafficVariant {
  catalogId: string;
  compiled: CompiledVehicle;
  beams: number;
  weight: number;
  paletteCount: number;
  /** Rig-local settled nodes (xyz × nodeCount). */
  settled: Float64Array;
  /** Frame basis of the template (= rest basis): right, up, forward (unit, rig-local). */
  basis: Float64Array;
  /** Frame origin in the template, rig-local. */
  origin: [number, number, number];
  /** Rig-local extents along the vehicle axes: ahead of / behind the rig origin (z = 0), half width. */
  front: number;
  rear: number;
  halfWidth: number;
  /** Rig-local z of the rear axle (pure-pursuit reference) and the wheelbase, m. */
  rearAxleZ: number;
  wheelbase: number;
  /** Max road-wheel angle, rad. */
  maxSteerRad: number;
}

/** Orthonormal frame basis [r, u, f] (9 numbers) from origin / front / top points. */
export function frameBasis(
  ox: number,
  oy: number,
  oz: number,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  out: Float64Array,
): boolean {
  let ax = fx - ox;
  let ay = fy - oy;
  let az = fz - oz;
  let l = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(l > 1e-9)) return false;
  ax /= l;
  ay /= l;
  az /= l;
  let ux = tx - ox;
  let uy = ty - oy;
  let uz = tz - oz;
  const d = ux * ax + uy * ay + uz * az;
  ux -= d * ax;
  uy -= d * ay;
  uz -= d * az;
  l = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(l > 1e-9)) return false;
  ux /= l;
  uy /= l;
  uz /= l;
  // right = forward × up
  out[0] = ay * uz - az * uy;
  out[1] = az * ux - ax * uz;
  out[2] = ax * uy - ay * ux;
  out[3] = ux;
  out[4] = uy;
  out[5] = uz;
  out[6] = ax;
  out[7] = ay;
  out[8] = az;
  return true;
}

/** M = A·Bᵀ for column bases A, B ([r, u, f] each); writes M row-major into out[9]. */
function basisRotation(A: ArrayLike<number>, B: ArrayLike<number>, out: Float64Array): void {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[3 * i + j] = A[i]! * B[j]! + A[3 + i]! * B[3 + j]! + A[6 + i]! * B[6 + j]!;
    }
  }
}

/**
 * Compiles nothing (the caller compiles): settles `compiled` on a private
 * engine and builds the variant record.
 */
export function buildVariant(
  catalogId: string,
  compiled: CompiledVehicle,
  weight: number,
  paletteCount: number,
  maxSteerDeg: number,
  makeEngine: (nodes: number, beams: number) => SimEngine,
): TrafficVariant {
  const rig = compiled.rig;
  const n = rig.nodeCount;
  const eng = makeEngine(n, rig.beamCount);
  eng.spawnCompiledVehicle(1, compiled, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { brake: 1, handbrake: 1, gearSelect: 0, throttle: 0 });
  const steps = Math.round(TEMPLATE_SETTLE_S * 2000);
  for (let i = 0; i < steps; i++) eng.step();
  eng.events.clear();
  const s = eng.state;
  const obj = eng.arena.get(1)!;
  const fr = compiled.frameNodes;
  const P = rig.nodePos;
  const rest = new Float64Array(9);
  const now = new Float64Array(9);
  const o = fr[0]!;
  const f = fr[1]!;
  const t = fr[2]!;
  frameBasis(P[3 * o]!, P[3 * o + 1]!, P[3 * o + 2]!, P[3 * f]!, P[3 * f + 1]!, P[3 * f + 2]!, P[3 * t]!, P[3 * t + 1]!, P[3 * t + 2]!, rest);
  const b = obj.nodeStart;
  const sx = s.posX;
  const sy = s.posY;
  const sz = s.posZ;
  frameBasis(sx[b + o]!, sy[b + o]!, sz[b + o]!, sx[b + f]!, sy[b + f]!, sz[b + f]!, sx[b + t]!, sy[b + t]!, sz[b + t]!, now);
  // p' = R_rest·R_nowᵀ·(p − o_now) + (o_rest.x, o_now.y, o_rest.z)
  const M = new Float64Array(9);
  basisRotation(rest, now, M);
  const ox = sx[b + o]!;
  const oy = sy[b + o]!;
  const oz = sz[b + o]!;
  const settled = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const px = sx[b + i]! - ox;
    const py = sy[b + i]! - oy;
    const pz = sz[b + i]! - oz;
    settled[3 * i] = M[0]! * px + M[1]! * py + M[2]! * pz + P[3 * o]!;
    settled[3 * i + 1] = M[3]! * px + M[4]! * py + M[5]! * pz + oy;
    settled[3 * i + 2] = M[6]! * px + M[7]! * py + M[8]! * pz + P[3 * o + 2]!;
  }
  let front = 0;
  let rear = 0;
  let halfWidth = 0;
  for (let i = 0; i < n; i++) {
    const x = settled[3 * i]!;
    const z = settled[3 * i + 2]!;
    if (-z > front) front = -z;
    if (z > rear) rear = z;
    if (Math.abs(x) > halfWidth) halfWidth = Math.abs(x);
  }
  let zf = 0;
  let nf = 0;
  let zr = 0;
  let nr = 0;
  for (const w of compiled.wheels) {
    const z = (P[3 * w.hubI + 2]! + P[3 * w.hubO + 2]!) / 2;
    if (w.steered) {
      zf += z;
      nf++;
    } else {
      zr += z;
      nr++;
    }
  }
  const rearAxleZ = nr > 0 ? zr / nr : 0;
  const frontAxleZ = nf > 0 ? zf / nf : -2.7;
  return {
    catalogId,
    compiled,
    beams: rig.beamCount,
    weight,
    paletteCount,
    settled,
    basis: rest,
    origin: [P[3 * o]!, oy, P[3 * o + 2]!],
    front,
    rear,
    halfWidth,
    rearAxleZ,
    wheelbase: rearAxleZ - frontAxleZ,
    maxSteerRad: (maxSteerDeg * Math.PI) / 180,
  };
}

/** Scratch for measurePose (worker-single-threaded). */
const basisNow = new Float64Array(9);
const rot = new Float64Array(9);

/**
 * Pose of an awake car from its frame nodes (module doc): writes quat/pos
 * and the unit forward / up (world). Returns false on a degenerate frame.
 */
export function measurePose(
  s: SimState,
  vehicle: VehicleRuntime,
  variant: TrafficVariant,
  pos: [number, number, number],
  quat: [number, number, number, number],
  fwd: Float64Array,
): boolean {
  const fr = vehicle.vehicle.frameNodes;
  const b = vehicle.nodeStart;
  const o = b + fr[0]!;
  const f = b + fr[1]!;
  const t = b + fr[2]!;
  if (!frameBasis(s.posX[o]!, s.posY[o]!, s.posZ[o]!, s.posX[f]!, s.posY[f]!, s.posZ[f]!, s.posX[t]!, s.posY[t]!, s.posZ[t]!, basisNow)) return false;
  basisRotation(basisNow, variant.basis, rot);
  // rot is row-major M (world ← template); columns = M·e_x etc.
  quatFromBasis(rot[0]!, rot[3]!, rot[6]!, rot[1]!, rot[4]!, rot[7]!, rot[2]!, rot[5]!, rot[8]!, quat);
  const ox = variant.origin[0];
  const oy = variant.origin[1];
  const oz = variant.origin[2];
  pos[0] = s.posX[o]! - (rot[0]! * ox + rot[1]! * oy + rot[2]! * oz);
  pos[1] = s.posY[o]! - (rot[3]! * ox + rot[4]! * oy + rot[5]! * oz);
  pos[2] = s.posZ[o]! - (rot[6]! * ox + rot[7]! * oy + rot[8]! * oz);
  // Vehicle forward = M·(0, 0, −1); up = M·(0, 1, 0).
  fwd[0] = -rot[2]!;
  fwd[1] = -rot[5]!;
  fwd[2] = -rot[8]!;
  fwd[3] = rot[1]!;
  fwd[4] = rot[4]!;
  fwd[5] = rot[7]!;
  return true;
}

/** Rotates v by unit quat q into out (x, y, z). */
function qrot(q: readonly number[], x: number, y: number, z: number, out: Float64Array): void {
  const qx = q[0]!;
  const qy = q[1]!;
  const qz = q[2]!;
  const qw = q[3]!;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

const tmp = new Float64Array(3);

/**
 * Promotion: spawns the variant at `transform`, overwrites its nodes with
 * transform·template, gives every node the rigid velocity speed·forward,
 * pre-spins the wheels and puts the auto box in the gear that speed wants
 * (engine speed matched, clutch closed).
 */
export function spawnAtPose(eng: SimEngine, objectId: number, variant: TrafficVariant, transform: Transform, speed: number): SimObject {
  const obj = eng.spawnCompiledVehicle(objectId, variant.compiled, transform, 'auto');
  const veh = eng.getVehicle(objectId)!;
  const s = eng.state;
  const q = transform.quat;
  const p = transform.pos;
  const n = obj.nodeCount;
  const st = variant.settled;
  qrot(q, 0, 0, -1, tmp);
  const fx = tmp[0]!;
  const fy = tmp[1]!;
  const fz = tmp[2]!;
  const vx = fx * speed;
  const vy = fy * speed;
  const vz = fz * speed;
  for (let i = 0; i < n; i++) {
    qrot(q, st[3 * i]!, st[3 * i + 1]!, st[3 * i + 2]!, tmp);
    const g = obj.nodeStart + i;
    s.posX[g] = tmp[0]! + p[0];
    s.posY[g] = tmp[1]! + p[1];
    s.posZ[g] = tmp[2]! + p[2];
    s.velX[g] = vx;
    s.velY[g] = vy;
    s.velZ[g] = vz;
  }
  for (const wr of veh.wheels) {
    const w = speed / wr.rollRadius;
    wr.omega = w;
    const hi = wr.hubI;
    const ho = wr.hubO;
    const cx = (s.posX[hi]! + s.posX[ho]!) / 2;
    const cy = (s.posY[hi]! + s.posY[ho]!) / 2;
    const cz = (s.posZ[hi]! + s.posZ[ho]!) / 2;
    let ax = s.posX[ho]! - s.posX[hi]!;
    let ay = s.posY[ho]! - s.posY[hi]!;
    let az = s.posZ[ho]! - s.posZ[hi]!;
    const al = Math.sqrt(ax * ax + ay * ay + az * az);
    const sg = wr.wheel.spinSign / al;
    ax *= sg;
    ay *= sg;
    az *= sg;
    for (let i = wr.rimStart; i < wr.tireStart + wr.ringCount; i++) {
      const rx = s.posX[i]! - cx;
      const ry = s.posY[i]! - cy;
      const rz = s.posZ[i]! - cz;
      s.velX[i] = vx + w * (ay * rz - az * ry);
      s.velY[i] = vy + w * (az * rx - ax * rz);
      s.velZ[i] = vz + w * (ax * ry - ay * rx);
    }
  }
  const d = veh.vehicle.drivetrain;
  const dt = veh.drivetrain as DrivetrainStateEx;
  const wMean = speed / veh.wheels[0]!.rollRadius;
  let g = 1;
  for (let c = d.gearCount; c >= 1; c--) {
    const rpm = d.gearRatioTable[c + 1]! * d.finalDrive * wMean * RPM_PER_RAD_S;
    if (rpm >= d.autoShiftDownRpm * 1.1 && rpm <= d.autoShiftUpRpm) {
      g = c;
      break;
    }
  }
  dt.gear = g;
  dt.targetGear = g;
  dt.shiftTimer = 0;
  dt.shiftCooldown = 0;
  const eo = d.gearRatioTable[g + 1]! * d.finalDrive * wMean;
  dt.engineOmega = Math.max(eo, d.idleRpm / RPM_PER_RAD_S);
  dt.autoEngage = 1;
  dt.clutchWind = 0;
  eng.markMoved();
  return obj;
}
