/**
 * R-RIG: every car's render body bound to its high-density rigs — zero dropped panels at every LOD, sheets skinned
 * only by their own nodes, the render-side extras carried over, and the committed skin data still on the render
 * surface (drift check; re-run tools/rig-skins.mjs after a body-shape change).
 */
import { describe, expect, it } from 'vitest';
import { compileVehicle } from '../../../../sim/vehicle/builder';
import { vehicleVariantSync } from '../../../../sim/vehicle/defs/hd/index';
import type { HdCar } from '../../../../sim/vehicle/defs/hd/skinSources';
import type { SkinSet } from '../../../../sim/rig/gen/types';
import { SKINS as BEATER_HIGH } from '../../../../sim/vehicle/defs/hd/skins/beater.high';
import { SKINS as BEATER_ULTRA } from '../../../../sim/vehicle/defs/hd/skins/beater.ultra';
import { SKINS as BOXTRUCK_HIGH } from '../../../../sim/vehicle/defs/hd/skins/boxtruck.high';
import { SKINS as BOXTRUCK_ULTRA } from '../../../../sim/vehicle/defs/hd/skins/boxtruck.ultra';
import { SKINS as COUPE_HIGH } from '../../../../sim/vehicle/defs/hd/skins/coupe.high';
import { SKINS as COUPE_ULTRA } from '../../../../sim/vehicle/defs/hd/skins/coupe.ultra';
import { SKINS as PICKUP_HIGH } from '../../../../sim/vehicle/defs/hd/skins/pickup.high';
import { SKINS as PICKUP_ULTRA } from '../../../../sim/vehicle/defs/hd/skins/pickup.ultra';
import { SKINS as SEDAN_HIGH } from '../../../../sim/vehicle/defs/hd/skins/sedan.high';
import { SKINS as SEDAN_ULTRA } from '../../../../sim/vehicle/defs/hd/skins/sedan.ultra';
import { bindTolerant } from '../../index';
import { tessellateVehicle } from '../../loft';
import { visualExtras } from '../../lods';
import type { PanelGeometry, VehicleVisualDef } from '../../types';
import { vehicleVisualSync } from './index';

const SKIN_DATA: Readonly<Record<HdCar, SkinSet[]>> = {
  sedan: [SEDAN_HIGH, SEDAN_ULTRA],
  coupe: [COUPE_HIGH, COUPE_ULTRA],
  pickup: [PICKUP_HIGH, PICKUP_ULTRA],
  boxtruck: [BOXTRUCK_HIGH, BOXTRUCK_ULTRA],
  beater: [BEATER_HIGH, BEATER_ULTRA],
};

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

/** Largest distance from a sample of the committed sheet nodes to their render panel's surface. */
function maxDrift(set: SkinSet, visual: VehicleVisualDef, geoms: readonly PanelGeometry[]): { max: number; panel: string } {
  let max = 0;
  let panel = '';
  for (const p of set.panels) {
    const i = visual.panels.findIndex((q) => q.id === p.id);
    if (i < 0) return { max: Infinity, panel: `${p.id} (gone)` };
    const g = geoms[i]!;
    const P = (k: number): number[] => [g.position[3 * k]!, g.position[3 * k + 1]!, g.position[3 * k + 2]!];
    for (let n = 0; n < p.pos.length / 3; n += 4) {
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

for (const car of ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater'] as const) {
  describe(`${car} HD visuals`, { timeout: 600_000 }, () => {
    it('committed skin data lies on the render surface (≤ 5 mm)', () => {
      const std = vehicleVisualSync(car, 'standard');
      const geoms = tessellateVehicle(std);
      for (const set of SKIN_DATA[car]) {
        const d = maxDrift(set, std, geoms);
        expect(d.max, `${car} ${set.pitch}: ${d.panel}`).toBeLessThan(0.005);
      }
    });
    for (const tier of ['high', 'ultra'] as const) {
      it(`${tier}: binds with zero dropped panels at LOD0 / 1 / 2; sheets use only their own nodes; extras carried over`, () => {
        const hd = vehicleVariantSync(car, tier);
        const cv = compileVehicle(hd.def);
        const vis = vehicleVisualSync(car, tier);
        const std = vehicleVisualSync(car, 'standard');
        expect(vis.vehicle).toBe(hd.def.name);
        expect(vis.panels.map((p) => p.id)).toEqual(std.panels.map((p) => p.id));
        const extras = visualExtras(vis);
        expect(extras.lods?.length).toBe(2);
        expect(extras.follow).toEqual(visualExtras(std).follow);
        [() => vis, ...extras.lods!].forEach((build, lod) => {
          const def = build();
          const bound = bindTolerant(cv, def, tessellateVehicle(def));
          expect(bound.dropped, `LOD${lod}`).toEqual([]);
          expect(bound.binding.panels.length).toBe(def.panels.length);
          for (const p of bound.binding.panels) {
            if (!hd.skinNodes?.[p.panelId]) continue;
            for (const n of p.nodes) expect(cv.rig.nodeIds[n]!.startsWith(`k_${p.panelId}_`)).toBe(true);
          }
        });
      });
    }
  });
}
