import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { PICKUP, PICKUP_DESIGN } from '../../../sim/vehicle/defs/pickup';
import { bindTolerant } from '../index';
import { tessellateVehicle } from '../loft';
import { visualExtras } from '../lods';
import type { PanelGeometry, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { buildPickupVisual, PICKUP_BUMPER_STRAPS, PICKUP_DIMS, PICKUP_FOLLOW, PICKUP_PAINT, PICKUP_VISUAL } from './pickup';

const compiled = compileVehicle(PICKUP);
const geoms = tessellateVehicle(PICKUP_VISUAL);
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

describe('PICKUP_VISUAL', { timeout: 120_000 }, () => {
  it('names the pickup and tessellates every panel: finite, unit normals, CCW outward', () => {
    expect(PICKUP_VISUAL.vehicle).toBe(PICKUP.name);
    expect(geoms.length).toBe(PICKUP_VISUAL.panels.length);
    for (const g of geoms) {
      expect(g.index.length, g.panelId).toBeGreaterThan(0);
      for (const arr of [g.position, g.normal, g.uv, g.tangent!]) for (const x of arr) expect(Number.isFinite(x), g.panelId).toBe(true);
      for (let i = 0; i < g.normal.length; i += 3) expect(Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1)).toBeLessThan(1e-4);
      // Seal backing strips fold where a vertical shut line crosses the sharp shoulder crease, and the
      // side glass where its inset top edge runs steeply along the A-pillar (behind the sail / seal):
      // a few slivers, hidden in the gaps. Everything visible keeps the sedan's 97 %.
      const floor = /Seal$/.test(g.panelId) ? 0.88 : g.panelId === 'headliner' || /^glass[LR]F$/.test(g.panelId) ? 0.9 : 0.97;
      expect(windingAgreement(g), g.panelId).toBeGreaterThan(floor);
    }
  });

  it('keeps the triangle budget: LOD0 ≤ 76k, LOD1 30–50 %, LOD2 ≤ 35 %, same panel ids', () => {
    const t0 = tris(geoms);
    const l1 = buildPickupVisual({ lod: 1 });
    const l2 = buildPickupVisual({ lod: 2 });
    const t1 = tris(tessellateVehicle(l1));
    const t2 = tris(tessellateVehicle(l2));
    expect(t0).toBeLessThanOrEqual(76_000);
    expect(t1 / t0).toBeGreaterThan(0.3);
    expect(t1 / t0).toBeLessThan(0.5);
    expect(t2 / t0).toBeLessThan(0.35);
    expect(l1.panels.map((p) => p.id)).toEqual(PICKUP_VISUAL.panels.map((p) => p.id));
    const ids0 = new Set(PICKUP_VISUAL.panels.map((p) => p.id));
    for (const p of l2.panels) expect(ids0.has(p.id), p.id).toBe(true);
    // LOD1/LOD2 are registered for createVehicleVisual (U6) together with the door-card followers.
    const ex = visualExtras(PICKUP_VISUAL);
    expect(ex.lods?.length).toBe(2);
    expect(ex.follow).toEqual(PICKUP_FOLLOW);
  });

  it('is deterministic', () => {
    const again = tessellateVehicle(buildPickupVisual({ lod: 0 }));
    for (let i = 0; i < geoms.length; i++) {
      expect(again[i]!.position).toEqual(geoms[i]!.position);
      expect(again[i]!.index).toEqual(geoms[i]!.index);
    }
  });

  it('every selector resolves against compileVehicle(PICKUP); all three LODs bind with zero dropped panels', () => {
    for (const p of PICKUP_VISUAL.panels) {
      expect(resolve(p.bind).length, p.id).toBeGreaterThanOrEqual(3);
      if (p.glass && 'pairs' in p.glass.beams) for (const [a, b] of p.glass.beams.pairs) resolve([a, b]);
    }
    for (const def of [PICKUP_VISUAL, buildPickupVisual({ lod: 1 }), buildPickupVisual({ lod: 2 })]) {
      const r = bindTolerant(compiled, def, def === PICKUP_VISUAL ? geoms : tessellateVehicle(def));
      expect(r.dropped).toEqual([]);
      expect(r.binding.panels.length).toBe(def.panels.length);
    }
  });

  it('panels bind only to their own sub-structure (cab, bed, clip, hood, tailgate, bumpers never mixed)', () => {
    const part = (id: string): string => {
      if (/^c\d_/.test(id)) return 'cab';
      if (/^b\d_/.test(id)) return 'bed';
      if (/^s\d_/.test(id)) return 'clip';
      if (id.startsWith('hood_')) return 'hood';
      if (id.startsWith('tg_')) return 'tailgate';
      if (/^bf_/.test(id)) return 'bumperF';
      if (/^br_|^hitch$/.test(id)) return 'bumperR';
      return 'other';
    };
    const ids = compiled.rig.nodeIds;
    for (const p of PICKUP_VISUAL.panels) {
      const parts = new Set(resolve(p.bind).map((i) => part(ids[i]!)));
      parts.delete('other');
      expect(parts.size, `${p.id}: ${[...parts].join(',')}`).toBeLessThanOrEqual(1);
    }
  });

  it('matches the rig: wheelbase, track, hub height, tyre radius', () => {
    for (const w of compiled.wheels) {
      const p = compiled.rig.nodePos;
      const x = (p[3 * w.hubI]! + p[3 * w.hubO]!) / 2;
      const y = (p[3 * w.hubI + 1]! + p[3 * w.hubO + 1]!) / 2;
      const z = (p[3 * w.hubI + 2]! + p[3 * w.hubO + 2]!) / 2;
      expect(Math.abs(x)).toBeCloseTo(PICKUP_DIMS.halfTrack, 3);
      expect(y).toBeCloseTo(PICKUP_DIMS.hubY, 3);
      expect(z).toBeCloseTo(w.id[0] === 'F' ? PICKUP_DIMS.axleFrontZ : PICKUP_DIMS.axleRearZ, 3);
      expect(w.radius).toBeCloseTo(PICKUP_DIMS.tyreRadius, 3);
    }
  });

  it('wheel arches clear the tyres with long-travel room: no body skin within r + 6 cm of a hub', () => {
    const skin = PICKUP_VISUAL.panels.filter((p) => ['body', 'fender', 'door', 'bumper', 'hood', 'trunk'].includes(p.kind)).map((p) => byId.get(p.id)!);
    const clearance = PICKUP_DIMS.tyreRadius + 0.06;
    for (const g of skin) {
      for (let i = 0; i < g.position.length; i += 3) {
        const x = Math.abs(g.position[i]!);
        if (x < PICKUP_DIMS.halfTrack - 0.14 || x > PICKUP_DIMS.halfTrack + 0.14) continue;
        for (const zc of [PICKUP_DIMS.axleFrontZ, PICKUP_DIMS.axleRearZ]) {
          const r = Math.hypot(g.position[i + 2]! - zc, g.position[i + 1]! - PICKUP_DIMS.hubY);
          expect(r, g.panelId).toBeGreaterThan(clearance);
        }
      }
    }
  });

  it('cuts real shut gaps between neighbouring panels; the bed stands clear of the cab', () => {
    const pairsToCheck: [string, string][] = [
      ['hood', 'fenderR'],
      ['fenderR', 'doorRF'],
      ['doorRF', 'doorRR'],
      ['doorLF', 'doorLR'],
      ['fascia', 'headlights'],
    ];
    for (const [a, b] of pairsToCheck) {
      const d = minDistance(byId.get(a)!, byId.get(b)!);
      expect(d, `${a}–${b}`).toBeGreaterThan(VISUAL_DEFAULTS.shutGap * 0.75);
      expect(d, `${a}–${b}`).toBeLessThan(0.03);
    }
    // Cab ↔ bed: a separate box on its own mounts (≈ 5 cm gap between the cab back and the bed's front wall).
    const zs = (id: string): number[] => {
      const g = byId.get(id)!;
      const out: number[] = [];
      for (let i = 2; i < g.position.length; i += 3) out.push(g.position[i]!);
      return out;
    };
    const gap = Math.min(...zs('bedFront')) - Math.max(...zs('cabBack'));
    expect(gap).toBeGreaterThan(0.03);
    expect(gap).toBeLessThan(0.1);
  });

  it('is left/right symmetric: every *R panel mirrors its *L twin', () => {
    const ids = PICKUP_VISUAL.panels.map((p) => p.id);
    let pairs = 0;
    for (const id of ids) {
      const m = /^(.*?)R([A-Z]?\w*)$/.exec(id);
      if (!m) continue;
      const twin = `${m[1]}L${m[2]}`;
      if (!byId.has(twin) || twin === id) continue;
      const a = byId.get(id)!;
      const b = byId.get(twin)!;
      if (b.position.length !== a.position.length) continue; // e.g. 'rearX' style ids that are not side twins
      pairs++;
      for (let i = 0; i < a.position.length; i += 3 * 17) {
        expect(b.position[i]).toBeCloseTo(-a.position[i]!, 6);
        expect(b.position[i + 1]).toBe(a.position[i + 1]);
      }
    }
    expect(pairs).toBeGreaterThan(15);
  });

  it('declares glass, every lamp function, sub-rig panels with follow detach, mirrors that hide', () => {
    const def: VehicleVisualDef = PICKUP_VISUAL;
    const glass = def.panels.filter((p) => p.material === 'glass');
    expect(glass.length).toBe(6);
    for (const g of glass) {
      expect(g.glass, g.id).toBeDefined();
      expect(g.castShadow).toBe(false);
    }
    expect(def.panels.find((p) => p.id === 'windscreen')!.glass!.laminated).toBe(true);
    const lit = new Set(def.panels.flatMap((p) => p.lights ?? []));
    for (const f of ['head', 'highBeam', 'tail', 'brake', 'reverse', 'indicatorL', 'indicatorR', 'fog'] as const) expect(lit.has(f), f).toBe(true);
    for (const p of def.panels) if (p.lights) expect(p.material.startsWith('light'), p.id).toBe(true);
    expect(def.panels.find((p) => p.id === 'hood')!.bind).toEqual(['hood_*']);
    expect(def.panels.find((p) => p.id === 'tailgate')!.bind).toEqual(['tg_*']);
    for (const id of ['hood', 'tailgate', 'bumperF', 'bumperR']) expect(def.panels.find((p) => p.id === id)!.detach?.mode, id).toBe('follow');
    for (const id of ['mirrorL', 'mirrorR']) expect(def.panels.find((p) => p.id === id)!.detach?.mode, id).toBe('hide');
    // The front bar detaches on the sim's strap beams (the crush brackets are compression-only and never break).
    expect(PICKUP_BUMPER_STRAPS.map(([a, b]) => `${a}|${b}`)).toEqual(PICKUP_DESIGN.bumperStraps.map(([a, b]) => `${a}|${b}`));
    expect(def.panels.find((p) => p.id === 'bumperF')!.detach?.attach).toEqual({ pairs: PICKUP_BUMPER_STRAPS });
    expect(def.paint).toEqual(PICKUP_PAINT);
    expect(def.wheels.tire.tread).toBe('allTerrain');
  });

  it('stays within the U6 draw budget: ≤ 15 body material slots (+ 5 wheel draws ≤ 20 main)', () => {
    const slots = new Set(PICKUP_VISUAL.panels.map((p) => p.material));
    expect(slots.size).toBeLessThanOrEqual(15);
  });
});
