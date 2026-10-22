import { describe, expect, it } from 'vitest';
import { compileVehicle } from '../vehicle/builder';
import { SEDAN } from '../vehicle/defs/sedan';
import { BOXTRUCK } from '../vehicle/defs/boxtruck';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import { COUPE } from '../vehicle/defs/coupe';
import { deriveCollisionTriangles, triangleSetOf } from './triangles';
import { RIG_TRI_FLAG_TWO_SIDED } from './types';

describe('derived collision triangles', () => {
  for (const def of [SEDAN, SEDAN_TRAFFIC, COUPE, BOXTRUCK]) {
    it(`${def.name}: an outward-facing closed-ish surface`, () => {
      const cv = compileVehicle(def);
      const rig = cv.rig;
      const t0 = performance.now();
      const tris = deriveCollisionTriangles(rig, { nodeCount: cv.bodyNodeCount });
      const ms = performance.now() - t0;
      const P = rig.nodePos;
      // Body centroid.
      let gx = 0, gy = 0, gz = 0;
      for (let i = 0; i < cv.bodyNodeCount; i++) {
        gx += P[3 * i]!;
        gy += P[3 * i + 1]!;
        gz += P[3 * i + 2]!;
      }
      gx /= cv.bodyNodeCount;
      gy /= cv.bodyNodeCount;
      gz /= cv.bodyNodeCount;
      let outward = 0;
      let two = 0;
      let area = 0;
      for (let t = 0; t < tris.count; t++) {
        const a = tris.a[t]!, b = tris.b[t]!, c = tris.c[t]!;
        const e1 = [P[3 * b]! - P[3 * a]!, P[3 * b + 1]! - P[3 * a + 1]!, P[3 * b + 2]! - P[3 * a + 2]!];
        const e2 = [P[3 * c]! - P[3 * a]!, P[3 * c + 1]! - P[3 * a + 1]!, P[3 * c + 2]! - P[3 * a + 2]!];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        area += 0.5 * Math.hypot(n[0]!, n[1]!, n[2]!);
        const cx = (P[3 * a]! + P[3 * b]! + P[3 * c]!) / 3 - gx;
        const cy = (P[3 * a + 1]! + P[3 * b + 1]! + P[3 * c + 1]!) / 3 - gy;
        const cz = (P[3 * a + 2]! + P[3 * b + 2]! + P[3 * c + 2]!) / 3 - gz;
        if (n[0]! * cx + n[1]! * cy + n[2]! * cz > 0) outward++;
        if ((tris.flags[t]! & RIG_TRI_FLAG_TWO_SIDED) !== 0) two++;
      }
      const set = triangleSetOf(rig, tris);
      console.log(`${def.name}: ${tris.count} triangles (${two} two-sided), area ${area.toFixed(1)} m², ${outward} face away from the centroid, derive ${ms.toFixed(0)} ms, excl ${set.excl.length}`);
      expect(tris.count).toBeGreaterThan(100);
      expect(outward / tris.count).toBeGreaterThan(0.8);
    });
  }
});
