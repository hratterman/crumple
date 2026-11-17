import { describe, expect, it } from 'vitest';
import { compileVehicle } from '../vehicle/builder';
import { SEDAN } from '../vehicle/defs/sedan';
import { BOXTRUCK } from '../vehicle/defs/boxtruck';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import { COUPE } from '../vehicle/defs/coupe';
import { bulkheadsOf, compileTriangleDefs, deriveCollisionTriangles, mergeTriangles, sheetNodes, triangleSetOf } from './triangles';
import { RIG_TRI_FLAG_BULKHEAD, RIG_TRI_FLAG_SELF, RIG_TRI_FLAG_TWO_SIDED, type CompiledTriangles } from './types';

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

describe('declared triangles merged into the derived surface (R-CORE self-collision)', () => {
  const tris = (list: [number, number, number, number][]): CompiledTriangles => ({
    count: list.length,
    a: Int32Array.from(list.map((t) => t[0])),
    b: Int32Array.from(list.map((t) => t[1])),
    c: Int32Array.from(list.map((t) => t[2])),
    flags: Uint8Array.from(list.map((t) => t[3])),
    material: new Uint8Array(list.length),
    thickness: new Float64Array(list.length),
  });
  // 6 nodes: 0..3 a backbone quad, 4 / 5 sheet nodes in front of it.
  const P = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 0.3, 1.5, 0.5, 0.3]);
  const S = RIG_TRI_FLAG_SELF;
  it('sheet nodes: vertices of selfCollide: false triangles only', () => {
    const decl = tris([[0, 1, 4, 0], [1, 2, 5, 0], [2, 3, 0, S]]);
    expect(Array.from(sheetNodes(decl, 6))).toEqual([0, 1, 0, 0, 1, 1]);
  });
  it('a derived triangle duplicated by, or touching, a sheet is no self-collision face', () => {
    const derived = tris([[0, 1, 2, S], [0, 2, 3, S], [2, 1, 5, S], [3, 2, 4, S]]);
    const decl = tris([[2, 3, 0, 0], [1, 2, 5, 0], [0, 1, 4, 0]]);
    const m = mergeTriangles(derived, decl, P);
    // Only non-self declarations: every vertex is a sheet node, so no derived triangle stays a self face;
    // [0,1,4] (no derived match) is appended with its declared flags.
    expect(m.count).toBe(5);
    expect(m.flags[0]! & S).toBe(0);
    expect(m.flags[1]! & S).toBe(0);
    expect(m.flags[2]! & S).toBe(0);
    expect(m.flags[3]! & S).toBe(0);
    expect(m.flags[4]! & S).toBe(0);
  });
  it('self triangles of the declaration keep the backbone in self-collision', () => {
    const derived = tris([[0, 1, 2, S], [0, 2, 3, S], [1, 2, 5, S]]);
    const decl = tris([[0, 1, 2, S], [0, 2, 3, S], [1, 2, 5, 0], [5, 2, 4, 0]]);
    const m = mergeTriangles(derived, decl, P);
    expect(m.flags[0]! & S).toBe(S);
    expect(m.flags[1]! & S).toBe(S);
    expect(m.flags[2]! & S).toBe(0); // declared non-self duplicate, and touches sheet node 5
  });
});

describe('declared bulkheads (R-CORE: self-collision in every solver preset)', () => {
  it('compile: a bulkhead is a self triangle; selfCollide: false on one is an error', () => {
    const idx = new Map([['a', 0], ['b', 1], ['c', 2]]);
    const t = compileTriangleDefs([{ a: 'a', b: 'b', c: 'c', bulkhead: true, twoSided: true }], idx);
    expect(t.flags[0]).toBe(RIG_TRI_FLAG_BULKHEAD | RIG_TRI_FLAG_SELF | RIG_TRI_FLAG_TWO_SIDED);
    expect(() => compileTriangleDefs([{ a: 'a', b: 'b', c: 'c', bulkhead: true, selfCollide: false }], idx)).toThrow();
  });
  it('sedan firewall: 12 two-sided bulkheads over s5; the bay rails and the engine that run into it are not excluded', () => {
    const cv = compileVehicle(SEDAN);
    const rig = cv.rig;
    const b = bulkheadsOf(rig.triangles)!;
    expect(b.count).toBe(12);
    const set = triangleSetOf(rig, b);
    const ids = rig.nodeIds;
    for (let t = 0; t < b.count; t++) {
      for (const v of [b.a[t]!, b.b[t]!, b.c[t]!]) expect(ids[v]!.startsWith('s5_')).toBe(true);
      const ex = Array.from(set.excl.subarray(set.exclStart[t]!, set.exclStart[t + 1]!)).map((i) => ids[i]!);
      expect(ex.filter((id) => /^(s4_|eng_)/.test(id))).toEqual([]);
    }
    // the full surface keeps them (merged after the derived lattice surface, flags intact)
    const derived = deriveCollisionTriangles(rig, { nodeCount: cv.bodyNodeCount });
    const m = mergeTriangles(derived, rig.triangles!, rig.nodePos);
    let n = 0;
    for (let t = 0; t < m.count; t++) if ((m.flags[t]! & RIG_TRI_FLAG_BULKHEAD) !== 0) n++;
    expect(n).toBe(12);
  });
});
