import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN_TRAFFIC } from '../../sim/vehicle/defs/sedanTraffic';
import { applyFollowers } from '../vehicle/binder';
import { bindTolerant } from '../vehicle/index';
import { tessellateVehicle } from '../vehicle/loft';
import { visualExtras } from '../vehicle/lods';
import { SEDAN_TRAFFIC_VISUAL } from '../vehicle/defs/sedanTraffic';
import { bakeGhostBody, bakeGhostWheel, ghostNodes, ghostWheels, settleOffsets, wheelLocalMatrix } from './bake';
import { Matrix4, Vector3 } from 'three';

const compiled = compileVehicle(SEDAN_TRAFFIC);
const extras = visualExtras(SEDAN_TRAFFIC_VISUAL);

describe('ghost bake', { timeout: 120_000 }, () => {
  it('settle offsets vanish at rest and ghost nodes undo a template sag', () => {
    const rest = compiled.rig.nodePos;
    const off0 = settleOffsets(compiled, rest);
    expect(Math.max(...off0.map(Math.abs))).toBeLessThan(1e-6);
    // A template: the whole car 4 cm lower, one body node sagging 3 cm more.
    const tmpl = Float64Array.from(rest, (x, i) => (i % 3 === 1 ? x - 0.04 : x));
    tmpl[3 * 5 + 1] = tmpl[3 * 5 + 1]! - 0.03;
    const off = settleOffsets(compiled, tmpl);
    expect(off[3 * 5 + 1]).toBeCloseTo(-0.03, 6);
    const g = ghostNodes(compiled, tmpl, off);
    expect(g[3 * 5 + 1]).toBeCloseTo(rest[3 * 5 + 1]! - 0.04, 6);
    const lastWheel = compiled.rig.nodeCount - 1;
    expect(g[3 * lastWheel + 1]).toBeCloseTo(tmpl[3 * lastWheel + 1]!, 9);
  });

  it('bakes LOD1 / LOD2 bodies at the rest nodes onto the rest surface', () => {
    const tris: number[] = [];
    for (const build of extras.lods ?? []) {
      const def = build();
      const binding = applyFollowers(compiled.rig, bindTolerant(compiled, def, tessellateVehicle(def)).binding, extras.follow);
      const g = bakeGhostBody(binding, compiled.rig.nodePos);
      const pos = g.getAttribute('position').array as Float32Array;
      const nrm = g.getAttribute('normal').array as Float32Array;
      expect(pos.every(Number.isFinite)).toBe(true);
      for (let i = 0; i < nrm.length; i += 3) expect(Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!)).toBeCloseTo(1, 3);
      const r = g.boundingSphere!;
      expect(r.radius).toBeGreaterThan(2);
      expect(r.radius).toBeLessThan(3.2);
      tris.push(g.getIndex()!.count / 3);
      const mat = g.getAttribute('crMat').array as Float32Array;
      const lamps = new Set<number>();
      for (let i = 3; i < mat.length; i += 4) lamps.add(mat[i]!);
      expect([...lamps].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    }
    console.info(`[ghost] body triangles LOD1 ${tris[0]} LOD2 ${tris[1]}`);
    expect(tris[1]).toBeLessThan(tris[0]!);
  });

  it('bakes wheels and places them at the template hubs', () => {
    const wheels = ghostWheels(compiled, compiled.rig.nodePos);
    expect(wheels.length).toBe(4);
    expect(wheels.filter((w) => w.steered).length).toBe(2);
    const m = new Matrix4();
    for (const w of wheels) {
      wheelLocalMatrix(w, 0, 0, m);
      const c = new Vector3().setFromMatrixPosition(m);
      expect(Math.abs(Math.abs(c.x) - 0.78)).toBeLessThan(0.08);
      expect(Math.abs(Math.abs(c.z) - 1.375)).toBeLessThan(0.05);
      // x axis of the wheel frame = outboard
      const s = new Vector3().setFromMatrixColumn(m, 0);
      expect(Math.sign(s.x)).toBe(Math.sign(c.x));
    }
    for (const d of [1, 2] as const) {
      const g = bakeGhostWheel(compiled, SEDAN_TRAFFIC_VISUAL.wheels, d);
      expect(g.getAttribute('crPbr')).toBeTruthy();
      console.info(`[ghost] wheel LOD${d} triangles ${(g.getIndex()?.count ?? 0) / 3}`);
    }
  });
});
