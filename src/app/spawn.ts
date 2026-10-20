/**
 * Vehicle placement on terrain (pure; no three, no DOM). The one placement
 * API for every vehicle spawn (boot, teleport, showroom DRIVE, F repair,
 * challenge starts and opponents): a rig is set down at a world point with a
 * heading, its up axis aligned to the ground plane fitted under its whole
 * footprint, and lifted so that its lowest collidable node clears the ground
 * under it by `drop` (clamped). Main sends the result with the protocol's
 * spawn-settle window (`SPAWN_SETTLE_S`), so the last centimetres of drop and
 * the suspension's first compression never yield or break anything.
 */
import { quatFromAxisAngle, quatMultiply, quatNormalize, type Quat, type Vec3 } from '../core/math';
import type { Transform } from '../protocol/messages';

/** Rest-pose facts of a rig (CompiledRig subset). */
export interface RestPose {
  nodeCount: number;
  /** xyz × nodeCount, rig-local. */
  nodePos: ArrayLike<number>;
  nodeRadius: ArrayLike<number>;
}

export interface Ground {
  heightAt(x: number, z: number): number;
}

/** Default and limits of the gap between the lowest node and the ground at spawn, m. */
export const SPAWN_DROP_M = 0.06;
export const SPAWN_DROP_MIN_M = 0.02;
export const SPAWN_DROP_MAX_M = 0.5;
/** Steepest ground plane a spawn is tilted to (beyond it the car is set at this tilt, still clear of the ground). */
export const SPAWN_MAX_TILT_RAD = (30 * Math.PI) / 180;
/** Ground samples across × along the footprint for the plane fit. */
const FIT_ACROSS = 5;
const FIT_ALONG = 9;

/**
 * Least-squares ground plane under a footprint in the yawed frame: samples on
 * a FIT_ACROSS × FIT_ALONG grid over the rest-pose XZ extent (rotated by yaw
 * about (x, z)) and returns the slopes dh/du (along the rig's +X, right) and
 * dh/dv (along its +Z, rear). The grid is symmetric about its centre, so the
 * two slopes decouple.
 */
export function groundSlopes(rest: RestPose, ground: Ground, x: number, z: number, yaw: number, out: { du: number; dv: number }): { du: number; dv: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < rest.nodeCount; i++) {
    const lx = rest.nodePos[3 * i]!;
    const lz = rest.nodePos[3 * i + 2]!;
    if (lx < x0) x0 = lx;
    if (lx > x1) x1 = lx;
    if (lz < z0) z0 = lz;
    if (lz > z1) z1 = lz;
  }
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const cu = (x0 + x1) / 2;
  const cv = (z0 + z1) / 2;
  const hu = (x1 - x0) / 2;
  const hv = (z1 - z0) / 2;
  let su = 0;
  let suu = 0;
  let sv = 0;
  let svv = 0;
  for (let a = 0; a < FIT_ACROSS; a++) {
    const u = hu * ((2 * a) / (FIT_ACROSS - 1) - 1);
    for (let b = 0; b < FIT_ALONG; b++) {
      const v = hv * ((2 * b) / (FIT_ALONG - 1) - 1);
      const lx = cu + u;
      const lz = cv + v;
      const h = ground.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
      su += u * h;
      suu += u * u;
      sv += v * h;
      svv += v * v;
    }
  }
  out.du = suu > 0 ? su / suu : 0;
  out.dv = svv > 0 ? sv / svv : 0;
  return out;
}

const slopes = { du: 0, dv: 0 };

/**
 * Transform placing `rest` at world (x, z) facing `yaw` (rad about +Y; 0
 * faces −Z, the vehicle-frame forward), tilted so its up axis is the normal
 * of the ground plane fitted under the whole footprint (groundSlopes; tilt
 * capped at SPAWN_MAX_TILT_RAD; heading kept as the projection of forward).
 * The rig's local origin goes to (x, y, z) with y chosen so that min over
 * nodes of (nodeY − radius − ground(nodeXZ)) equals `drop`, clamped to
 * [SPAWN_DROP_MIN_M, SPAWN_DROP_MAX_M] — every node (wheels and body) is
 * tested against the ground under its own XZ, so nothing starts inside the
 * terrain or a road cut.
 */
export function placeOnGround(rest: RestPose, ground: Ground, x: number, z: number, yaw: number, drop = SPAWN_DROP_M): Transform {
  const qYaw = quatFromAxisAngle([0, 0, 0, 1] as Quat, [0, 1, 0], yaw);
  groundSlopes(rest, ground, x, z, yaw, slopes);
  // Ground normal in the yawed frame (u right, v rear): (−du, 1, −dv); its
  // tilt is the rotation from +Y about the horizontal axis up × n.
  const nu = -slopes.du;
  const nv = -slopes.dv;
  const horiz = Math.sqrt(nu * nu + nv * nv);
  let q = qYaw;
  if (horiz > 1e-9) {
    const tilt = Math.min(Math.atan(horiz), SPAWN_MAX_TILT_RAD);
    // up × n in the yawed frame = (nv, 0, −nu) / horiz.
    const qTilt = quatFromAxisAngle([0, 0, 0, 1] as Quat, [nv / horiz, 0, -nu / horiz], tilt);
    q = quatNormalize([0, 0, 0, 1] as Quat, quatMultiply([0, 0, 0, 1] as Quat, qYaw, qTilt));
  }
  // Rotation matrix rows of q.
  const [qx, qy, qz, qw] = q;
  const m00 = 1 - 2 * (qy * qy + qz * qz);
  const m01 = 2 * (qx * qy - qw * qz);
  const m02 = 2 * (qx * qz + qw * qy);
  const m10 = 2 * (qx * qy + qw * qz);
  const m11 = 1 - 2 * (qx * qx + qz * qz);
  const m12 = 2 * (qy * qz - qw * qx);
  const m20 = 2 * (qx * qz - qw * qy);
  const m21 = 2 * (qy * qz + qw * qx);
  const m22 = 1 - 2 * (qx * qx + qy * qy);
  let lift = -Infinity;
  for (let i = 0; i < rest.nodeCount; i++) {
    const lx = rest.nodePos[3 * i]!;
    const ly = rest.nodePos[3 * i + 1]!;
    const lz = rest.nodePos[3 * i + 2]!;
    const wx = x + m00 * lx + m01 * ly + m02 * lz;
    const wy = m10 * lx + m11 * ly + m12 * lz;
    const wz = z + m20 * lx + m21 * ly + m22 * lz;
    const need = ground.heightAt(wx, wz) - (wy - rest.nodeRadius[i]!);
    if (need > lift) lift = need;
  }
  const d = Math.min(Math.max(drop, SPAWN_DROP_MIN_M), SPAWN_DROP_MAX_M);
  return { pos: [x, lift + d, z] as Vec3, quat: q };
}

/** Yaw (rad, 0 = −Z) of a horizontal heading vector. */
export function yawOf(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/**
 * Yaw (rad, 0 = −Z) of a transform's rotation: the heading of its rotated
 * forward (−Z) projected on the ground plane (0 when it points straight up/down).
 */
export function yawOfQuat(q: readonly [number, number, number, number] | Quat): number {
  const [x, y, z, w] = q;
  // Rotated (0, 0, −1): −(third column of the rotation matrix).
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  return Math.hypot(fx, fz) > 1e-9 ? yawOf(fx, fz) : 0;
}

/** World AABB (min xyz, max xyz), e.g. `PropInstance.aabb`. */
export type Aabb = readonly [number, number, number, number, number, number];

/** Gap kept between a repaired vehicle's footprint and a prop's spawn box, m. */
export const REPAIR_CLEARANCE_M = 0.4;
/** Back-off step and range when the repair spot overlaps a prop's spawn box, m. */
export const REPAIR_BACKOFF_STEP_M = 0.5;
export const REPAIR_BACKOFF_MAX_M = 40;

/**
 * Whether `rest` placed at (x, z) facing `yaw` stays `clearance` away (XZ) from
 * every box whose height range overlaps the rig's ±3 m around `y`.
 * Conservative: the rotated footprint's world AABB is tested.
 */
export function clearOfBoxes(rest: RestPose, x: number, y: number, z: number, yaw: number, boxes: readonly Aabb[], clearance = REPAIR_CLEARANCE_M): boolean {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < rest.nodeCount; i++) {
    const lx = rest.nodePos[3 * i]!;
    const lz = rest.nodePos[3 * i + 2]!;
    const wx = x + lx * c + lz * s;
    const wz = z - lx * s + lz * c;
    if (wx < x0) x0 = wx;
    if (wx > x1) x1 = wx;
    if (wz < z0) z0 = wz;
    if (wz > z1) z1 = wz;
  }
  for (const b of boxes) {
    if (b[1] > y + 3 || b[4] < y - 3) continue;
    if (b[0] - clearance < x1 && b[3] + clearance > x0 && b[2] - clearance < z1 && b[5] + clearance > z0) return false;
  }
  return true;
}

/**
 * Full-repair spot for F: the vehicle's own position when it is clear of
 * every prop's SPAWN box (the props are re-placed at the same time; a car
 * repaired inside a barrel wall it had pushed away would explode against
 * the returning barrels), else the nearest clear point straight back along
 * its heading, then forward; null when nothing within `maxM` is clear.
 */
export function repairSpot(
  rest: RestPose,
  ground: Ground,
  x: number,
  z: number,
  yaw: number,
  boxes: readonly Aabb[],
  maxM = REPAIR_BACKOFF_MAX_M,
): Transform | null {
  const bx = Math.sin(yaw);
  const bz = Math.cos(yaw);
  for (let d = 0; d <= maxM + 1e-9; d += REPAIR_BACKOFF_STEP_M) {
    for (const sign of d === 0 ? [1] : [1, -1]) {
      const px = x + sign * bx * d;
      const pz = z + sign * bz * d;
      const t = placeOnGround(rest, ground, px, pz, yaw);
      if (clearOfBoxes(rest, px, t.pos[1], pz, yaw, boxes)) return t;
    }
  }
  return null;
}
