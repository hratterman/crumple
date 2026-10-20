/**
 * Ambient zone weights from the world layout (P8 audio; pure): arena /
 * town / lake-shore membership of a point with the layout's soft blends,
 * so the ambient bed cross-fades (birds and wind in the valley, quieter in
 * the arena, water lapping near the lake).
 */
import type { ZoneShape } from '../world/types';

export interface AudioZone {
  kind: string;
  shape: ZoneShape;
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Signed distance-ish outside measure (m, ≤ 0 inside) of a shape; polygons count as outside. */
export function shapeOutside(s: ZoneShape, x: number, z: number): number {
  switch (s.type) {
    case 'circle':
      return Math.hypot(x - s.center[0], z - s.center[1]) - s.radius;
    case 'ellipse': {
      const ax = s.axis ? s.axis[0] : 1;
      const az = s.axis ? s.axis[1] : 0;
      const dx = x - s.center[0];
      const dz = z - s.center[1];
      const u = dx * ax + dz * az;
      const v = -dx * az + dz * ax;
      const r = Math.hypot(u / s.radiusX, v / s.radiusZ);
      return (r - 1) * Math.min(s.radiusX, s.radiusZ);
    }
    case 'rect': {
      const ax = s.axis ? s.axis[0] : 1;
      const az = s.axis ? s.axis[1] : 0;
      const dx = x - s.center[0];
      const dz = z - s.center[1];
      const u = Math.abs(dx * ax + dz * az) - s.halfX;
      const v = Math.abs(-dx * az + dz * ax) - s.halfZ;
      return u > 0 || v > 0 ? Math.hypot(Math.max(u, 0), Math.max(v, 0)) : Math.max(u, v);
    }
    default:
      return Infinity;
  }
}

/** Membership 0..1 (1 inside, fading over the shape's blend outside). */
export function zoneWeight(s: ZoneShape, x: number, z: number): number {
  const d = shapeOutside(s, x, z);
  return 1 - smooth(d / Math.max(1, s.blend));
}

/** out = [arena, town, lakeShore, height]. */
export function ambientZones(zones: readonly AudioZone[], heightAt: (x: number, z: number) => number, x: number, z: number, out: Float64Array): void {
  let arena = 0;
  let town = 0;
  let lake = 0;
  for (let i = 0; i < zones.length; i++) {
    const zn = zones[i]!;
    if (zn.kind === 'arena') arena = Math.max(arena, zoneWeight(zn.shape, x, z));
    else if (zn.kind === 'town') town = Math.max(town, zoneWeight(zn.shape, x, z));
    else if (zn.kind === 'lake') {
      // the lapping lives at the shore: within ~70 m of the water's edge, either side
      const d = shapeOutside(zn.shape, x, z);
      lake = Math.max(lake, 1 - smooth((Math.abs(d) - 10) / 60));
    }
  }
  out[0] = arena;
  out[1] = town;
  out[2] = lake;
  out[3] = heightAt(x, z);
}
