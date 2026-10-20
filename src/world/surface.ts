/**
 * Support height under a plan point: the terrain or the top of any box /
 * ramp collider above it (a downward ray against the collider solids).
 * Pure, both sides: stunt-park markings drape over decks with it, the
 * challenge runtime measures air clearance with it.
 */
import { quatToMatrix } from './colliders';
import type { ResolvedCollider } from './types';

export interface SurfaceIndex {
  at(x: number, z: number): number;
}

export function surfaceIndex(colliders: readonly ResolvedCollider[], heightAt: (x: number, z: number) => number): SurfaceIndex {
  const items = colliders
    .filter((c) => c.kind === 'box' || c.kind === 'ramp')
    .map((c) => {
      const R = new Float64Array(9);
      quatToMatrix(c.quat, R);
      // plan bounding radius
      const r = Math.hypot(c.size[0], c.size[1], c.size[2]);
      return { c, R, r };
    });
  return {
    at(x: number, z: number): number {
      let best = heightAt(x, z);
      for (const { c, R, r } of items) {
        const px = x - c.pos[0];
        const pz = z - c.pos[2];
        if (px * px + pz * pz > r * r) continue;
        const py = 1000 - c.pos[1];
        // local = Rᵀ·p; ray dir (0, −1, 0) → local −(row 1 of R)
        const o = [R[0]! * px + R[3]! * py + R[6]! * pz, R[1]! * px + R[4]! * py + R[7]! * pz, R[2]! * px + R[5]! * py + R[8]! * pz];
        const dl = [-R[3]!, -R[4]!, -R[5]!];
        let t0 = -Infinity;
        let t1 = Infinity;
        for (let k = 0; k < 3; k++) {
          const h = c.size[k]!;
          if (Math.abs(dl[k]!) < 1e-12) {
            if (o[k]! < -h || o[k]! > h) {
              t0 = Infinity;
              break;
            }
            continue;
          }
          let ta = (-h - o[k]!) / dl[k]!;
          let tb = (h - o[k]!) / dl[k]!;
          if (ta > tb) [ta, tb] = [tb, ta];
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
        }
        if (!(t0 <= t1)) continue;
        if (c.kind === 'ramp') {
          // solid: y + (b/d)·z ≤ 0
          const k = c.size[1] / c.size[2];
          const f0 = o[1]! + k * o[2]!;
          const df = dl[1]! + k * dl[2]!;
          if (f0 > 0) {
            if (df >= 0) continue;
            const tp = -f0 / df;
            if (tp > t0) t0 = tp;
            if (t0 > t1) continue;
          }
        }
        const y = 1000 - t0;
        if (y > best) best = y;
      }
      return best;
    },
  };
}

