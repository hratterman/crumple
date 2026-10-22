import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import { applyFollowers, bindPanels, evalFlexVertex } from './binder';
import { SEDAN_VISUAL } from './defs/sedan';
import FRONT80 from './fixtures/front80-final.json';
import POLE80 from './fixtures/pole80-peak.json';
import { tessellateVehicle } from './loft';
import { visualExtras } from './lods';

describe('sedan flexbody bake', () => {
  const compiled = compileVehicle(SEDAN);
  const geoms = tessellateVehicle(SEDAN_VISUAL);

  it('binds every panel of SEDAN_VISUAL and reconstructs the rest pose exactly', () => {
    const t0 = performance.now();
    const b = bindPanels(compiled, SEDAN_VISUAL, geoms);
    const ms = performance.now() - t0;
    console.info(`[sedan bake] ${b.panels.length} panels, ${b.stats.vertices} verts, bind ${ms.toFixed(0)} ms, repaired ${b.stats.repaired}`);
    expect(b.panels.length).toBe(SEDAN_VISUAL.panels.length);
    // Budget at load is 300 ms (measured ~130–150 ms warm on an idle core); loose here: the full suite runs files in parallel.
    expect(ms).toBeLessThan(5000);
    const out = new Float64Array(6);
    let max = 0;
    for (const p of b.panels) {
      for (let v = 0; v < p.vertexCount; v += 7) {
        evalFlexVertex(p, v, compiled.rig.nodePos, out);
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
    }
    expect(max).toBeLessThan(1e-5);
  });
});

describe('sedan render LODs + door-card followers (U6)', { timeout: 60_000 }, () => {
  const compiled = compileVehicle(SEDAN);
  const b0 = bindPanels(compiled, SEDAN_VISUAL, tessellateVehicle(SEDAN_VISUAL));
  const extras = visualExtras(SEDAN_VISUAL);

  it('registers LOD1 / LOD2 defs: the same panel ids (LOD2 a subset), far fewer triangles, all bindable', () => {
    expect(extras.lods?.length).toBe(2);
    const ids0 = SEDAN_VISUAL.panels.map((p) => p.id);
    const [l1, l2] = extras.lods!.map((f) => f());
    expect(l1!.panels.map((p) => p.id)).toEqual(ids0);
    for (const p of l2!.panels) expect(ids0).toContain(p.id);
    const tris = (def: typeof SEDAN_VISUAL): number => tessellateVehicle(def).reduce((n, g) => n + g.index.length / 3, 0);
    const t0 = b0.stats.triangles;
    const t1 = tris(l1!);
    const t2 = tris(l2!);
    console.info(`[sedan LOD] triangles LOD0 ${t0} LOD1 ${t1} LOD2 ${t2}`);
    expect(t1).toBeLessThan(0.45 * t0);
    expect(t2).toBeLessThan(0.8 * t1);
    const b1 = bindPanels(compiled, l1!, tessellateVehicle(l1!));
    expect(b1.panels.length).toBe(l1!.panels.length);
  });

  it('door cards follow their door skins: rest pose exact, and a recorded 80 km/h side-pole peak keeps them behind the skin', () => {
    const follow = extras.follow!;
    expect(Object.keys(follow).sort()).toEqual(['doorCardLF', 'doorCardLR', 'doorCardRF', 'doorCardRR']);
    const bf = applyFollowers(compiled.rig, b0, follow);
    const out = new Float64Array(6);
    const panel = (b: typeof b0, id: string) => b.panels.find((p) => p.panelId === id)!;
    // rest round trip of the re-bound cards
    for (const id of Object.keys(follow)) {
      const p = panel(bf, id);
      let max = 0;
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexVertex(p, v, compiled.rig.nodePos, out);
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
      expect(max).toBeLessThan(1e-5);
    }
    // Recorded frame (fixtures/pole80-peak.json): the right front door wrapped around the pole.
    const nodes = Float64Array.from(POLE80.pos);
    expect(nodes.length).toBe(compiled.rig.nodeCount * 3);
    const deform = (p: (typeof b0.panels)[number], at: ArrayLike<number>): Float64Array => {
      const r = new Float64Array(p.vertexCount * 6);
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexVertex(p, v, at, out);
        r.set(out, 6 * v);
      }
      return r;
    };
    /** Per card vertex: signed gap to its rest-nearest OUTER door-skin vertex along the deformed skin normal (< 0 = behind). */
    const gaps = (b: typeof b0, card: string, door: string, at: ArrayLike<number>): Float64Array => {
      const c = panel(b, card);
      const d = panel(b, door);
      const C = deform(c, at);
      const D = deform(d, at);
      const g = new Float64Array(c.vertexCount);
      for (let v = 0; v < c.vertexCount; v++) {
        let best = Infinity;
        let u = 0;
        for (let j = 0; j < d.vertexCount; j++) {
          if (d.restNormal[3 * j]! * Math.sign(d.restPosition[3 * j]!) < 0.3) continue; // outer skin only
          const q = (d.restPosition[3 * j]! - c.restPosition[3 * v]!) ** 2 + (d.restPosition[3 * j + 1]! - c.restPosition[3 * v + 1]!) ** 2 + (d.restPosition[3 * j + 2]! - c.restPosition[3 * v + 2]!) ** 2;
          if (q < best) {
            best = q;
            u = j;
          }
        }
        g[v] = (C[6 * v]! - D[6 * u]!) * D[6 * u + 3]! + (C[6 * v + 1]! - D[6 * u + 1]!) * D[6 * u + 4]! + (C[6 * v + 2]! - D[6 * u + 2]!) * D[6 * u + 5]!;
      }
      return g;
    };
    const closing = (b: typeof b0, card: string, door: string): { close: number; front: number } => {
      const g0 = gaps(b, card, door, compiled.rig.nodePos);
      const g = gaps(b, card, door, nodes);
      let close = -Infinity;
      let front = -Infinity;
      for (let v = 0; v < g.length; v++) {
        close = Math.max(close, g[v]! - g0[v]!);
        front = Math.max(front, g[v]!);
      }
      return { close, front };
    };
    const old = closing(b0, 'doorCardRF', 'doorRF');
    const neu = closing(bf, 'doorCardRF', 'doorRF');
    console.info(`[door card RF @80 km/h pole peak] gap closing: own triads ${(old.close * 100).toFixed(1)} cm, follower ${(neu.close * 100).toFixed(1)} cm; max gap ${(neu.front * 100).toFixed(1)} cm`);
    expect(old.close).toBeGreaterThan(0.05); // the bug: the card stayed put while the skin folded in
    expect(neu.close).toBeLessThan(0.04);
    for (const [card, door] of Object.entries(follow)) {
      // never in front of the skin (+ the inward crumple fold allowance, FLEX_CRUMPLE_AMP · 0.3)
      expect(closing(bf, card, door).front, card).toBeLessThan(-0.012);
    }
  });

  it('80 km/h frontal wreck (recorded): every point of each door card outer face stays covered by its door skin', () => {
    const bf = applyFollowers(compiled.rig, b0, extras.follow!);
    const nodes = Float64Array.from(FRONT80.pos);
    const out = new Float64Array(6);
    const deform = (p: (typeof b0.panels)[number]): Float64Array => {
      const r = new Float64Array(p.vertexCount * 3);
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexVertex(p, v, nodes, out);
        r.set(out.subarray(0, 3), 3 * v);
      }
      return r;
    };
    /** Distance along dir to the first door-skin triangle facing back along -dir (front-facing to a viewer outside), else Infinity. */
    const firstHit = (P: Float64Array, idx: Uint32Array, o: number[], d: number[]): number => {
      let best = Infinity;
      for (let t = 0; t < idx.length; t += 3) {
        const a = 3 * idx[t]!, b = 3 * idx[t + 1]!, c = 3 * idx[t + 2]!;
        const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
        const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        if (n[0]! * d[0]! + n[1]! * d[1]! + n[2]! * d[2]! <= 0) continue; // back face from outside: culled
        const pv = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
        const det = e1[0]! * pv[0]! + e1[1]! * pv[1]! + e1[2]! * pv[2]!;
        if (Math.abs(det) < 1e-14) continue;
        const tv = [o[0]! - P[a]!, o[1]! - P[a + 1]!, o[2]! - P[a + 2]!];
        const u = (tv[0]! * pv[0]! + tv[1]! * pv[1]! + tv[2]! * pv[2]!) / det;
        if (u < 0 || u > 1) continue;
        const qv = [tv[1]! * e1[2]! - tv[2]! * e1[1]!, tv[2]! * e1[0]! - tv[0]! * e1[2]!, tv[0]! * e1[1]! - tv[1]! * e1[0]!];
        const w = (d[0]! * qv[0]! + d[1]! * qv[1]! + d[2]! * qv[2]!) / det;
        if (w < 0 || u + w > 1) continue;
        const s = (e2[0]! * qv[0]! + e2[1]! * qv[1]! + e2[2]! * qv[2]!) / det;
        if (s > 0 && s < best) best = s;
      }
      return best;
    };
    let samples = 0;
    let exposed = 0;
    let openSamples = 0;
    let openExposed = 0;
    let openDoors = 0;
    for (const [cardId, doorId] of Object.entries(extras.follow!)) {
      const card = bf.panels.find((p) => p.panelId === cardId)!;
      const door = bf.panels.find((p) => p.panelId === doorId)!;
      const C = deform(card);
      const D = deform(door);
      const sx = Math.sign(card.restPosition[0]!);
      // R-CRASH: the doors are hinged closures — a door the crash unlatched has swung open, so look out
      // along the door's own outward direction: [sx, 0, 0] carried by the door frame's rotation (an
      // orthonormal frame on three of its closure nodes, rest → recorded)
      const did = `d${doorId.slice(-1)}${doorId.slice(4, 5)}`;
      const frame = (at: ArrayLike<number>): number[][] => {
        const q = (id: string): number[] => {
          const i = compiled.rig.nodeIds.indexOf(`${did}_${id}`);
          return [at[3 * i]!, at[3 * i + 1]!, at[3 * i + 2]!];
        };
        const [a, b, c] = [q('10'), q('12'), q('21')];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const ul = Math.hypot(u[0]!, u[1]!, u[2]!);
        const e1 = u.map((x) => x / ul);
        const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const d1 = w[0]! * e1[0]! + w[1]! * e1[1]! + w[2]! * e1[2]!;
        const v = w.map((x, k) => x - d1 * e1[k]!);
        const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
        const e2 = v.map((x) => x / vl);
        const e3 = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        return [e1, e2, e3];
      };
      const F0 = frame(compiled.rig.nodePos);
      const F1 = frame(nodes);
      const loc = F0.map((e) => e[0]! * sx);
      const dir = [0, 1, 2].map((k) => loc[0]! * F1[0]![k]! + loc[1]! * F1[1]![k]! + loc[2]! * F1[2]![k]!);
      // swung open (unlatched) by more than 10°: its skin was bent by the hit that opened it
      const open = dir[0]! * sx < Math.cos((10 * Math.PI) / 180);
      if (open) openDoors++;
      for (let t = 0; t < card.index.length; t += 3) {
        const [ia, ib, ic] = [card.index[t]!, card.index[t + 1]!, card.index[t + 2]!];
        if ((card.restNormal[3 * ia]! + card.restNormal[3 * ib]! + card.restNormal[3 * ic]!) * sx < 1.5) continue; // outer face
        for (const [wa, wb] of [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7], [0.15, 0.15]] as const) {
          const wc = 1 - wa - wb;
          const o = [0, 1, 2].map((k) => wa * C[3 * ia + k]! + wb * C[3 * ib + k]! + wc * C[3 * ic + k]!);
          const miss = !(firstHit(D, door.index, o, dir) < 0.5);
          if (open) {
            openSamples++;
            if (miss) openExposed++;
          } else {
            samples++;
            if (miss) exposed++;
          }
        }
      }
    }
    console.info(`[door cards @80 km/h frontal] latched doors: ${exposed} / ${samples} exposed; ${openDoors} unlatched (swung open): ${openExposed} / ${openSamples}`);
    expect(samples).toBeGreaterThan(800);
    expect(exposed).toBe(0);
    // an unlatched door was bent by the hit that opened it (its front edge buckled by the fender): ≤ 1.5 %
    // (measured 1.3 %: the top front corner of the card and the armrest root, hidden behind the card)
    expect(openExposed).toBeLessThanOrEqual(0.015 * openSamples);
  });
});
