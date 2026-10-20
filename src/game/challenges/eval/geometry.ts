/**
 * Plan-view helpers shared by the evaluators (pure, main thread).
 * Yaw convention (layout / `__crumple.place`): 0 faces −Z, 90° faces −X.
 */
import type { XZ, ZoneDef } from '../types';

const DEG = Math.PI / 180;

/** Unit travel direction (x, z) of a yaw in degrees. */
export function yawDir(yawDeg: number): [number, number] {
  const a = yawDeg * DEG;
  return [-Math.sin(a), -Math.cos(a)];
}

/** Yaw in degrees of a plan direction (x, z) (inverse of yawDir). */
export function dirYaw(x: number, z: number): number {
  return Math.atan2(-x, -z) / DEG;
}

/** Smallest absolute angle between two yaws, degrees [0, 180]. */
export function yawDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d < 0) d += 360;
  return d > 180 ? 360 - d : d;
}

/** Zone membership of a plan point. */
export function inZone(z: ZoneDef, x: number, zz: number): boolean {
  if (z.kind === 'circle') {
    const dx = x - z.center[0];
    const dz = zz - z.center[1];
    return dx * dx + dz * dz <= z.radius * z.radius;
  }
  const [lx, lz] = toLocal(z.center, z.yawDeg ?? 0, x, zz);
  return Math.abs(lx) <= z.halfX && Math.abs(lz) <= z.halfZ;
}

/**
 * Plan point in the local frame of a yaw (centre `c`, local −Z = the yaw's
 * travel direction, local +X = right of travel): returns [local x, local z]
 * (yaw 0 → the world offsets). A point ahead has local z < 0.
 */
export function toLocal(c: XZ, yawDeg: number, x: number, z: number): [number, number] {
  const [fx, fz] = yawDir(yawDeg);
  const dx = x - c[0];
  const dz = z - c[1];
  // right of travel = (−fz, fx)… for travel (0, −1) right is (+1, 0): r = (−fz, fx).
  const lateral = dx * -fz + dz * fx;
  const along = dx * fx + dz * fz;
  return [lateral, 0 - along];
}
