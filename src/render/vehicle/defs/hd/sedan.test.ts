/**
 * R-RIG: the sedan's render body bound to its high-density rigs — zero
 * dropped panels at every LOD, sheets skinned only by their own nodes, and
 * the committed skin data still on the render surface (drift check; re-run
 * tools/rig-skins.mjs after a body-shape change).
 */
import { describe, expect, it } from 'vitest';
import { compileVehicle } from '../../../../sim/vehicle/builder';
import { sedanHD } from '../../../../sim/vehicle/defs/hd/sedan';
import { SKINS as HIGH } from '../../../../sim/vehicle/defs/hd/skins/sedan.high';
import { SKINS as ULTRA } from '../../../../sim/vehicle/defs/hd/skins/sedan.ultra';
import type { SkinSet } from '../../../../sim/rig/gen/types';
import { bindTolerant } from '../../index';
import { tessellateVehicle } from '../../loft';
import { visualExtras } from '../../lods';
import type { PanelGeometry } from '../../types';
import { SEDAN_VISUAL } from '../sedan';
import { sedanHDVisual } from './sedan';

/** Distance from p to triangle (a, b, c). */
function pointTri(p: number[], a: number[], b: number[], c: number[]): number {
  const sub = (x: number[], y: number[]): number[] => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
  const dot = (x: number[], y: number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.sqrt(dot(ap, ap));
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.sqrt(dot(bp, bp));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.sqrt(dot(cp, cp));
  const vc = d1 * d4 - d3 * d2;
  const vb = d5 * d2 - d1 * d6;
  const va = d3 * d6 - d5 * d4;
  let q: number[];
  if (vc <= 0 && d1 >= 0 && d3 <= 0) q = a.map((x, k) => x + (d1 / (d1 - d3)) * ab[k]!);
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = a.map((x, k) => x + (d2 / (d2 - d6)) * ac[k]!);
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) q = b.map((x, k) => x + ((d4 - d3) / (d4 - d3 + (d5 - d6))) * (c[k]! - x));
  else {
    const den = 1 / (va + vb + vc);
    q = a.map((x, k) => x + ab[k]! * vb * den + ac[k]! * vc * den);
  }
  const d = sub(p, q);
  return Math.sqrt(dot(d, d));
}

function maxDrift(set: SkinSet, geoms: readonly PanelGeometry[]): { max: number; panel: string } {
  let max = 0;
  let panel = '';
  for (const p of set.panels) {
    const i = SEDAN_VISUAL.panels.findIndex((q) => q.id === p.id);
    expect(i).toBeGreaterThanOrEqual(0);
    const g = geoms[i]!;
    const P = (k: number): number[] => [g.position[3 * k]!, g.position[3 * k + 1]!, g.position[3 * k + 2]!];
    for (let n = 0; n < p.pos.length / 3; n += 3) {
      const x = [p.pos[3 * n]!, p.pos[3 * n + 1]!, p.pos[3 * n + 2]!];
      let best = Infinity;
      for (let t = 0; t < g.index.length; t += 3) best = Math.min(best, pointTri(x, P(g.index[t]!), P(g.index[t + 1]!), P(g.index[t + 2]!)));
      if (best > max) {
        max = best;
        panel = p.id;
      }
    }
  }
  return { max, panel };
}

describe('SEDAN HD visuals', { timeout: 300_000 }, () => {
  const geoms = tessellateVehicle(SEDAN_VISUAL);
  it('committed skin data lies on the render surface (≤ 5 mm)', () => {
    for (const set of [HIGH, ULTRA]) {
      const d = maxDrift(set, geoms);
      expect(d.max, `${set.pitch}: ${d.panel}`).toBeLessThan(0.005);
    }
  });

  for (const tier of ['high', 'ultra'] as const) {
    const hd = sedanHD(tier);
    const cv = compileVehicle(hd.def);
    const vis = sedanHDVisual(tier);
    const extras = visualExtras(vis);
    it(`${tier}: names the variant, registers LOD1 / LOD2 and the door-card followers`, () => {
      expect(vis.vehicle).toBe(hd.def.name);
      expect(vis.panels.map((p) => p.id)).toEqual(SEDAN_VISUAL.panels.map((p) => p.id));
      expect(extras.lods?.length).toBe(2);
      expect(extras.follow?.doorCardRF).toBe('doorRF');
    });
    [() => vis, ...(extras.lods ?? [])].forEach((build, lod) => {
      it(`${tier}: binds with zero dropped panels (LOD${lod}); each sheet panel uses only its own sheet nodes`, () => {
        const def = build();
        const bound = bindTolerant(cv, def, tessellateVehicle(def));
        expect(bound.dropped).toEqual([]);
        expect(bound.binding.panels.length).toBe(def.panels.length);
        for (const p of bound.binding.panels) {
          if (!hd.skinNodes[p.panelId]) continue;
          for (const n of p.nodes) expect(cv.rig.nodeIds[n]!.startsWith(`k_${p.panelId}_`)).toBe(true);
        }
      });
    });
  }
});
