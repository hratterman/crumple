/**
 * Zone / pad shape evaluation for the terrain generator (A). Pure, allocation
 * free per query, only + − × ÷ sqrt (DETERMINISM rules in types.ts).
 *
 * Mask m = 1 inside, smoothstep(1 − dist/blend) outside (dist = plan distance
 * past the boundary). Ellipse distance uses the radial approximation
 * ρ·(1 − 1/r) (r = normalized elliptical radius), exact for circles.
 */
import type { ZoneShape } from './types';

export const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface CompiledShape {
  /** Plan distance outside the boundary, 0 inside. */
  outside(x: number, z: number): number;
  /** Soft mask (1 inside, smoothstep to 0 at `blend` outside). */
  mask(x: number, z: number): number;
  /** Normalized elliptical radius (circle/ellipse only; 0 centre, 1 boundary). Other shapes: 0 inside, 1 + dist outside. */
  radius(x: number, z: number): number;
  readonly blend: number;
  /** Support bounding box (mask > 0), world metres. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export function compileShape(shape: ZoneShape): CompiledShape {
  const blend = shape.blend;
  let outside: (x: number, z: number) => number;
  let radius: (x: number, z: number) => number;
  let minX: number;
  let maxX: number;
  let minZ: number;
  let maxZ: number;

  switch (shape.type) {
    case 'circle': {
      const [cx, cz] = shape.center;
      const r0 = shape.radius;
      outside = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        const d = Math.sqrt(dx * dx + dz * dz) - r0;
        return d > 0 ? d : 0;
      };
      radius = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        return Math.sqrt(dx * dx + dz * dz) / r0;
      };
      minX = cx - r0 - blend;
      maxX = cx + r0 + blend;
      minZ = cz - r0 - blend;
      maxZ = cz + r0 + blend;
      break;
    }
    case 'ellipse': {
      const [cx, cz] = shape.center;
      const rx = shape.radiusX;
      const rz = shape.radiusZ;
      const ax = shape.axis ? shape.axis[0] : 1;
      const az = shape.axis ? shape.axis[1] : 0;
      radius = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        const lx = (dx * ax + dz * az) / rx;
        const lz = (dz * ax - dx * az) / rz;
        return Math.sqrt(lx * lx + lz * lz);
      };
      outside = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        const lx = (dx * ax + dz * az) / rx;
        const lz = (dz * ax - dx * az) / rz;
        const r = Math.sqrt(lx * lx + lz * lz);
        if (r <= 1) return 0;
        return Math.sqrt(dx * dx + dz * dz) * (1 - 1 / r);
      };
      const rm = (rx > rz ? rx : rz) + blend;
      minX = cx - rm;
      maxX = cx + rm;
      minZ = cz - rm;
      maxZ = cz + rm;
      break;
    }
    case 'rect': {
      const [cx, cz] = shape.center;
      const hx = shape.halfX;
      const hz = shape.halfZ;
      const ax = shape.axis ? shape.axis[0] : 1;
      const az = shape.axis ? shape.axis[1] : 0;
      outside = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        let lx = dx * ax + dz * az;
        let lz = dz * ax - dx * az;
        lx = (lx < 0 ? -lx : lx) - hx;
        lz = (lz < 0 ? -lz : lz) - hz;
        if (lx <= 0 && lz <= 0) return 0;
        if (lx < 0) lx = 0;
        if (lz < 0) lz = 0;
        return Math.sqrt(lx * lx + lz * lz);
      };
      radius = (x, z) => {
        const d = outside(x, z);
        return d > 0 ? 1 + d : 0;
      };
      // Rotated rect: conservative box from the half diagonal.
      const ex = Math.abs(ax) * hx + Math.abs(az) * hz + blend;
      const ez = Math.abs(az) * hx + Math.abs(ax) * hz + blend;
      minX = cx - ex;
      maxX = cx + ex;
      minZ = cz - ez;
      maxZ = cz + ez;
      break;
    }
    case 'polygon': {
      const n = shape.points.length;
      const px = new Float64Array(n);
      const pz = new Float64Array(n);
      minX = Infinity;
      maxX = -Infinity;
      minZ = Infinity;
      maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = shape.points[i]!;
        px[i] = p[0];
        pz[i] = p[1];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minZ) minZ = p[1];
        if (p[1] > maxZ) maxZ = p[1];
      }
      minX -= blend;
      maxX += blend;
      minZ -= blend;
      maxZ += blend;
      outside = (x, z) => {
        let inside = false;
        let best = Infinity;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = px[i]!;
          const zi = pz[i]!;
          const xj = px[j]!;
          const zj = pz[j]!;
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
          const ex = xj - xi;
          const ez = zj - zi;
          const l2 = ex * ex + ez * ez;
          let t = l2 > 0 ? ((x - xi) * ex + (z - zi) * ez) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x - xi - t * ex;
          const qz = z - zi - t * ez;
          const d2 = qx * qx + qz * qz;
          if (d2 < best) best = d2;
        }
        return inside ? 0 : Math.sqrt(best);
      };
      radius = (x, z) => {
        const d = outside(x, z);
        return d > 0 ? 1 + d : 0;
      };
      break;
    }
  }

  const mask = (x: number, z: number): number => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return 0;
    const d = outside(x, z);
    if (d <= 0) return 1;
    if (blend <= 0) return 0;
    return smooth01(1 - d / blend);
  };

  return { outside, mask, radius, blend, minX, maxX, minZ, maxZ };
}
