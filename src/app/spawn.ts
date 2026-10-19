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
