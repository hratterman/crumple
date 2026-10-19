/**
 * Vehicle placement on terrain (pure; no three, no DOM). A rig is dropped
 * upright at a world point with a heading so that its lowest collidable node
 * clears the ground under it by `drop` (clamped), whatever the slope.
 */
import { quatFromAxisAngle, type Quat, type Vec3 } from '../core/math';
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

/**
 * Transform placing `rest` at world (x, z) facing `yaw` (rad about +Y; 0
 * faces −Z, the vehicle-frame forward). The rig's local origin goes to
 * (x, y, z) with y chosen so that min over nodes of
 * (nodeY − radius − ground(nodeXZ)) equals `drop`, clamped to
 * [SPAWN_DROP_MIN_M, SPAWN_DROP_MAX_M].
 */
export function placeOnGround(rest: RestPose, ground: Ground, x: number, z: number, yaw: number, drop = SPAWN_DROP_M): Transform {
  const q = quatFromAxisAngle([0, 0, 0, 1] as Quat, [0, 1, 0], yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let lift = -Infinity;
  for (let i = 0; i < rest.nodeCount; i++) {
    const lx = rest.nodePos[3 * i]!;
    const ly = rest.nodePos[3 * i + 1]!;
    const lz = rest.nodePos[3 * i + 2]!;
    // Rotation about +Y by yaw: x' = x·cos + z·sin, z' = −x·sin + z·cos.
    const wx = x + lx * c + lz * s;
    const wz = z - lx * s + lz * c;
    const need = ground.heightAt(wx, wz) - (ly - rest.nodeRadius[i]!);
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
