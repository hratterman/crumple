/**
 * Click-to-focus picking (photo mode): the nearest hit along a view ray
 * against the camera subjects (bounding spheres shrunk to the body), the
 * terrain heightfield (marched, then bisected) and optional static meshes.
 * Flexbody vehicles deform in the vertex shader, so their CPU geometry is
 * stale: the subject spheres stand in for them.
 */
import { Raycaster, type Object3D, type Vector3 } from 'three';
import type { CameraSubject } from './rig';

const MAX_DIST = 600;
const STEP = 0.75;

/** Ray / sphere: entry distance along the unit ray, or Infinity. */
export function raySphere(o: Vector3, d: Vector3, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > 0) return t0;
  const t1 = -b + s;
  return t1 > 0 ? 0 : Infinity;
}

/** Ray / heightfield: first crossing below the ground, refined by bisection; Infinity when none within maxDist. */
export function rayTerrain(o: Vector3, d: Vector3, groundHeight: (x: number, z: number) => number, maxDist = MAX_DIST): number {
  let prev = 0;
  if (o.y < groundHeight(o.x, o.z)) return 0;
  for (let t = STEP; t <= maxDist; t += STEP * (1 + t / 80)) {
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    if (o.y + d.y * t < groundHeight(x, z)) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 14; i++) {
        const m = (lo + hi) / 2;
        if (o.y + d.y * m < groundHeight(o.x + d.x * m, o.z + d.z * m)) hi = m;
        else lo = m;
      }
      return hi;
    }
    prev = t;
  }
  return Infinity;
}

const ray = new Raycaster();

/**
 * Distance along the unit ray (origin o, direction d) to the nearest surface,
 * or null. `subjects`: camera subjects (sphere radius × 0.6 ≈ the body).
 */
export function pickDistance(
  o: Vector3,
  d: Vector3,
  subjects: readonly CameraSubject[],
  groundHeight: (x: number, z: number) => number,
  meshes: readonly Object3D[] = [],
): number | null {
  let best = rayTerrain(o, d, groundHeight);
  for (const s of subjects) {
    if (!s.valid) continue;
    const r = Math.max(0.5, s.radius * 0.6);
    const t = raySphere(o, d, s.position[0]!, s.position[1]! + r * 0.25, s.position[2]!, r);
    if (t < best) best = t;
  }
  if (meshes.length > 0) {
    ray.set(o, d);
    ray.far = Number.isFinite(best) ? best : MAX_DIST;
    const hits = ray.intersectObjects(meshes as Object3D[], true);
    if (hits.length > 0 && hits[0]!.distance < best) best = hits[0]!.distance;
  }
  return Number.isFinite(best) ? best : null;
}

