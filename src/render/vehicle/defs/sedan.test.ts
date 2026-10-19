import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { SEDAN } from '../../../sim/vehicle/defs/sedan';
import { bindPanels } from '../binder';
import { tessellateVehicle } from '../loft';
import { slotBox } from '../materials';
import type { PanelGeometry, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { buildSedanVisual, SEDAN_DIMS, SEDAN_VISUAL } from './sedan';

const compiled = compileVehicle(SEDAN);
const geoms = tessellateVehicle(SEDAN_VISUAL);
const byId = new Map(geoms.map((g) => [g.panelId, g]));
const tris = (gs: readonly PanelGeometry[]): number => gs.reduce((a, g) => a + g.index.length / 3, 0);

/** Glob (`*` = any run) against the rig's node ids. */
function resolve(sel: readonly string[]): number[] {
  const ids = compiled.rig.nodeIds;
  const out = new Set<number>();
  for (const s of sel) {
    const re = new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let hit = false;
    ids.forEach((id, i) => {
      if (re.test(id)) {
        out.add(i);
        hit = true;
      }
    });
    if (!hit) throw new Error(`selector ${s} matches nothing`);
  }
  return [...out];
}

/** Fraction of triangles whose face normal agrees with the summed vertex normals. */
function windingAgreement(g: PanelGeometry): number {
  let ok = 0;
  let n = 0;
  const p = g.position;
  for (let q = 0; q < g.index.length; q += 3) {
    const a = g.index[q]! * 3;
    const b = g.index[q + 1]! * 3;
    const c = g.index[q + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const f = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (Math.hypot(f[0]!, f[1]!, f[2]!) < 1e-9) continue;
    let d = 0;
    for (const v of [a, b, c]) d += f[0]! * g.normal[v]! + f[1]! * g.normal[v + 1]! + f[2]! * g.normal[v + 2]!;
    n++;
    if (d > 0) ok++;
  }
  return ok / Math.max(1, n);
}

/** Smallest distance between any vertex of a and any vertex of b (grid hash). */
function minDistance(a: PanelGeometry, b: PanelGeometry): number {
  const cell = 0.02;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < b.position.length; i += 3) {
    const k = `${Math.floor(b.position[i]! / cell)},${Math.floor(b.position[i + 1]! / cell)},${Math.floor(b.position[i + 2]! / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  let best = Infinity;
  for (let i = 0; i < a.position.length; i += 3) {
    const cx = Math.floor(a.position[i]! / cell);
    const cy = Math.floor(a.position[i + 1]! / cell);
    const cz = Math.floor(a.position[i + 2]! / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? [])
            best = Math.min(best, Math.hypot(a.position[i]! - b.position[j]!, a.position[i + 1]! - b.position[j + 1]!, a.position[i + 2]! - b.position[j + 2]!));
  }
  return best;
}

describe('SEDAN_VISUAL', { timeout: 60_000 }, () => {
  it('names the sedan and tessellates every panel: finite, unit normals, CCW outward', () => {
    expect(SEDAN_VISUAL.vehicle).toBe(SEDAN.name);
    expect(geoms.length).toBe(SEDAN_VISUAL.panels.length);
    for (const g of geoms) {
      expect(g.index.length, g.panelId).toBeGreaterThan(0);
      for (const arr of [g.position, g.normal, g.uv, g.tangent!]) for (const x of arr) expect(Number.isFinite(x), g.panelId).toBe(true);
      for (let i = 0; i < g.normal.length; i += 3) expect(Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1)).toBeLessThan(1e-4);
      expect(windingAgreement(g), g.panelId).toBeGreaterThan(0.97);
    }
  });

  it('keeps the triangle budget: LOD0 ≤ 60k, LOD1 ≈ 40 %', () => {
    const t0 = tris(geoms);
    const t1 = tris(tessellateVehicle(buildSedanVisual({ lod: 1 })));
    expect(t0).toBeLessThanOrEqual(60_000);
    expect(t1 / t0).toBeGreaterThan(0.3);
    expect(t1 / t0).toBeLessThan(0.5);
  });

  it('is deterministic', () => {
    const again = tessellateVehicle(buildSedanVisual({ lod: 0 }));
    for (let i = 0; i < geoms.length; i++) {
      expect(again[i]!.position).toEqual(geoms[i]!.position);
      expect(again[i]!.index).toEqual(geoms[i]!.index);
    }
  });

  it('every selector resolves against compileVehicle(SEDAN); bindPanels binds every panel', () => {
    for (const p of SEDAN_VISUAL.panels) {
      expect(resolve(p.bind).length, p.id).toBeGreaterThanOrEqual(3);
      if (p.glass && 'pairs' in p.glass.beams) for (const [a, b] of p.glass.beams.pairs) resolve([a, b]);
    }
    const binding = bindPanels(compiled, SEDAN_VISUAL, geoms);
    expect(binding.panels.length).toBe(SEDAN_VISUAL.panels.length);
  });

  it('matches the rig: wheelbase, track, hub height', () => {
    for (const w of compiled.wheels) {
      const p = compiled.rig.nodePos;
      const x = (p[3 * w.hubI]! + p[3 * w.hubO]!) / 2;
      const y = (p[3 * w.hubI + 1]! + p[3 * w.hubO + 1]!) / 2;
      const z = (p[3 * w.hubI + 2]! + p[3 * w.hubO + 2]!) / 2;
      expect(Math.abs(x)).toBeCloseTo(SEDAN_DIMS.halfTrack, 3);
      expect(y).toBeCloseTo(SEDAN_DIMS.hubY, 3);
      expect(z).toBeCloseTo(w.id[0] === 'F' ? SEDAN_DIMS.axleFrontZ : SEDAN_DIMS.axleRearZ, 3);
      expect(w.radius).toBeCloseTo(SEDAN_DIMS.tyreRadius, 3);
    }
  });

  it('wheel arches sit over the hubs: no body skin inside the tyre envelope', () => {
    const skin = SEDAN_VISUAL.panels.filter((p) => ['body', 'fender', 'door', 'bumper', 'hood', 'trunk'].includes(p.kind)).map((p) => byId.get(p.id)!);
    const clearance = SEDAN_DIMS.tyreRadius + 0.02;
    for (const g of skin) {
      for (let i = 0; i < g.position.length; i += 3) {
        const x = Math.abs(g.position[i]!);
        if (x < SEDAN_DIMS.halfTrack - 0.11 || x > SEDAN_DIMS.halfTrack + 0.11) continue;
        for (const zc of [SEDAN_DIMS.axleFrontZ, SEDAN_DIMS.axleRearZ]) {
          const r = Math.hypot(g.position[i + 2]! - zc, g.position[i + 1]! - SEDAN_DIMS.hubY);
          expect(r, g.panelId).toBeGreaterThan(clearance);
        }
      }
    }
  });

  it('cuts real shut gaps between neighbouring panels', () => {
    const pairsToCheck: [string, string][] = [
      ['hood', 'fenderR'],
      ['fenderR', 'doorRF'],
      ['doorRF', 'doorRR'],
      ['doorRR', 'quarterR'],
      ['trunk', 'quarterL'],
      ['bumperF', 'fenderL'],
      ['bumperF', 'headlampHousing'],
      ['bumperR', 'rearPanel'],
    ];
    for (const [a, b] of pairsToCheck) {
      const d = minDistance(byId.get(a)!, byId.get(b)!);
      expect(d, `${a}–${b}`).toBeGreaterThan(VISUAL_DEFAULTS.shutGap * 0.75);
      expect(d, `${a}–${b}`).toBeLessThan(0.02);
    }
  });

  it('is left/right symmetric: every *R panel mirrors its *L twin', () => {
    const ids = SEDAN_VISUAL.panels.map((p) => p.id);
    for (const id of ids) {
      const m = /^(.*?)R([A-Z]?\w*)$/.exec(id);
      if (!m || id.startsWith('rear') || id.startsWith('quarter') || id === 'roof' || id === 'reverseLamps' || id === 'radiatorSupport') continue;
      const twin = `${m[1]}L${m[2]}`;
      if (!byId.has(twin)) continue;
      const a = byId.get(id)!;
      const b = byId.get(twin)!;
      expect(b.position.length, id).toBe(a.position.length);
      for (let i = 0; i < a.position.length; i += 3 * 17) {
        expect(b.position[i]).toBeCloseTo(-a.position[i]!, 6);
        expect(b.position[i + 1]).toBe(a.position[i + 1]);
      }
    }
  });

  it('declares glass, lamps and detachable parts', () => {
    const def: VehicleVisualDef = SEDAN_VISUAL;
    const glass = def.panels.filter((p) => p.material === 'glass');
    expect(glass.length).toBe(8);
    for (const g of glass) {
      expect(g.glass, g.id).toBeDefined();
      expect(g.castShadow).toBe(false);
    }
    expect(def.panels.find((p) => p.id === 'windscreen')!.glass!.laminated).toBe(true);
    const lit = new Set(def.panels.flatMap((p) => p.lights ?? []));
    for (const f of ['head', 'highBeam', 'tail', 'brake', 'reverse', 'indicatorL', 'indicatorR'] as const) expect(lit.has(f), f).toBe(true);
    for (const p of def.panels) if (p.lights) expect(p.material.startsWith('light'), p.id).toBe(true);
    expect(def.panels.find((p) => p.id === 'hood')!.bind).toEqual(['hood_*']);
    expect(def.panels.find((p) => p.id === 'bumperF')!.detach?.mode).toBe('follow');
    expect(def.panels.find((p) => p.id === 'bumperR')!.bind).toEqual(['s13_*']);
  });

  it('headlamp parts line up with the lamp shader layout (projector "eyes" on the discs, DRL band on the guide)', () => {
    // A3's head-lamp shader places two eyes at 34 % / 66 % across and 58 % up the (|x|, y) box of
    // every lightHead part (lens radius 0.8 · 0.27 · height) and a DRL band 8–15 % up: the sedan's
    // projector discs and light guide are built inside that box.
    const box = slotBox(SEDAN_VISUAL, 'lightHead')!;
    const W = box.max.x - box.min.x;
    const H = box.max.y - box.min.y;
    expect(H).toBeGreaterThan(0.06);
    expect(H).toBeLessThan(0.1);
    const g = byId.get('headlights')!;
    for (const f of [0.34, 0.66]) {
      const cx = box.min.x + f * W;
      const cy = box.min.y + 0.58 * H;
      // Every vertex within the eye's lens radius belongs to a disc centred on it.
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < g.position.length; i += 3) {
        const x = Math.abs(g.position[i]!);
        const y = g.position[i + 1]!;
        if (Math.hypot(x - cx, y - cy) < 0.8 * 0.27 * H) {
          n++;
          sx += x;
          sy += y;
        }
      }
      expect(n, `eye ${f}`).toBeGreaterThan(10);
      expect(Math.abs(sx / n - cx), `eye ${f} x`).toBeLessThan(0.002);
      expect(Math.abs(sy / n - cy), `eye ${f} y`).toBeLessThan(0.002);
    }
    // The light guide covers the DRL band along the bottom.
    let guide = 0;
    for (let i = 0; i < g.position.length; i += 3) {
      const ty = (g.position[i + 1]! - box.min.y) / H;
      if (ty > 0.08 && ty < 0.15) guide++;
    }
    expect(guide).toBeGreaterThan(40);
    // Front lamp / grille / intake parts exist and bind to their own nodes.
    for (const id of ['headlampHousing', 'projectorBezels', 'grille', 'grilleSlats', 'intakeFins', 'splitter', 'indicatorFL', 'indicatorFR']) expect(byId.has(id), id).toBe(true);
  });
});
