import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { BEATER } from '../../../sim/vehicle/defs/beater';
import { patchMaterial } from '../../material';
import { QUALITY_PRESETS, type LightingStack, type RenderContext } from '../../types';
import { createVehicleDamage } from '../damage';
import { createFlexSkin } from '../flexskin';
import { bindTolerant } from '../index';
import { visualExtras } from '../lods';
import { tessellateVehicle } from '../loft';
import { createVehicleMaterials, materialFinish } from '../materials';
import type { PanelGeometry } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { finishExtras, finishMasks, finishRow, hasFinish } from '../weathering';
import { BEATER_DIMS, BEATER_PAINT, BEATER_VISUAL, buildBeaterVisual } from './beater';

const compiled = compileVehicle(BEATER);
const geoms = tessellateVehicle(BEATER_VISUAL);
const byId = new Map(geoms.map((g) => [g.panelId, g]));
const tris = (gs: readonly PanelGeometry[]): number => gs.reduce((a, g) => a + g.index.length / 3, 0);

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

describe('BEATER_VISUAL', { timeout: 120_000 }, () => {
  it('names the beater and tessellates every panel: finite, unit normals, CCW outward', () => {
    expect(BEATER_VISUAL.vehicle).toBe(BEATER.name);
    expect(geoms.length).toBe(BEATER_VISUAL.panels.length);
    for (const g of geoms) {
      expect(g.index.length, g.panelId).toBeGreaterThan(0);
      for (const arr of [g.position, g.normal, g.uv, g.tangent!]) for (const x of arr) expect(Number.isFinite(x), g.panelId).toBe(true);
      for (let i = 0; i < g.normal.length; i += 3) expect(Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1), g.panelId).toBeLessThan(1e-4);
      // seals are black rubber backing under the shut edges (never seen face-on)
      expect(windingAgreement(g), g.panelId).toBeGreaterThan(g.panelId.endsWith('Seal') ? 0.9 : 0.97);
    }
  });

  it('binds every panel to the rig with zero dropped panels, LOD1/LOD2 too', () => {
    const r = bindTolerant(compiled, BEATER_VISUAL, geoms);
    expect(r.dropped).toEqual([]);
    expect(r.binding.panels.length).toBe(BEATER_VISUAL.panels.length);
    const lods = visualExtras(BEATER_VISUAL).lods ?? [];
    expect(lods.length).toBe(2);
    for (const build of lods) {
      const d = build();
      expect(bindTolerant(compiled, d, tessellateVehicle(d)).dropped).toEqual([]);
    }
  });

  it('keeps the triangle budget: LOD0 ≤ 61k, LOD1 ≈ 40 %, LOD2 smaller still', () => {
    const t0 = tris(geoms);
    const t1 = tris(tessellateVehicle(buildBeaterVisual({ lod: 1 })));
    const t2 = tris(tessellateVehicle(buildBeaterVisual({ lod: 2 })));
    expect(t0).toBeLessThanOrEqual(61_000);
    expect(t1 / t0).toBeLessThan(0.55);
    expect(t2).toBeLessThan(t1);
  });

  it('is deterministic', () => {
    const again = tessellateVehicle(buildBeaterVisual({ lod: 0 }));
    for (let i = 0; i < geoms.length; i++) {
      expect(again[i]!.position).toEqual(geoms[i]!.position);
      expect(again[i]!.index).toEqual(geoms[i]!.index);
    }
  });

  it('matches the rig: wheelbase, track, hub height, tyre radius', () => {
    for (const w of compiled.wheels) {
      const p = compiled.rig.nodePos;
      const x = (p[3 * w.hubI]! + p[3 * w.hubO]!) / 2;
      const y = (p[3 * w.hubI + 1]! + p[3 * w.hubO + 1]!) / 2;
      const z = (p[3 * w.hubI + 2]! + p[3 * w.hubO + 2]!) / 2;
      expect(Math.abs(x)).toBeCloseTo(BEATER_DIMS.halfTrack, 3);
      expect(y).toBeCloseTo(BEATER_DIMS.hubY, 3);
      expect(z).toBeCloseTo(w.id[0] === 'F' ? BEATER_DIMS.axleFrontZ : BEATER_DIMS.axleRearZ, 3);
      expect(w.radius).toBeCloseTo(BEATER_DIMS.tyreRadius, 3);
    }
  });

  it('wheel arches clear the tyres: no body skin inside the tyre envelope', () => {
    const skin = BEATER_VISUAL.panels.filter((p) => ['body', 'fender', 'door', 'hood', 'trunk'].includes(p.kind)).map((p) => byId.get(p.id)!);
    const clearance = BEATER_DIMS.tyreRadius + 0.02;
    for (const g of skin) {
      for (let i = 0; i < g.position.length; i += 3) {
        const x = Math.abs(g.position[i]!);
        if (x < BEATER_DIMS.halfTrack - 0.1 || x > BEATER_DIMS.halfTrack + 0.1) continue;
        for (const zc of [BEATER_DIMS.axleFrontZ, BEATER_DIMS.axleRearZ]) {
          const r = Math.hypot(g.position[i + 2]! - zc, g.position[i + 1]! - BEATER_DIMS.hubY);
          expect(r, g.panelId).toBeGreaterThan(clearance);
        }
      }
    }
  });

  it('cuts real shut gaps between neighbouring panels', () => {
    for (const [a, b] of [
      ['hood', 'fenderR'],
      ['fenderR', 'doorRF'],
      ['doorRF', 'doorRR'],
      ['doorLR', 'quarterL'],
      ['trunk', 'quarterL'],
      ['bumperF', 'frontPanel'],
      ['bumperR', 'rearPanel'],
    ] as const) {
      const d = minDistance(byId.get(a)!, byId.get(b)!);
      expect(d, `${a}–${b}`).toBeGreaterThan(VISUAL_DEFAULTS.shutGap * 0.75);
      expect(d, `${a}–${b}`).toBeLessThan(0.03);
    }
  });

  it('derby build: no glass, a mesh screen, a cage, chained bumper, one mirror, lamps for every function', () => {
    const def = BEATER_VISUAL;
    expect(def.panels.filter((p) => p.material === 'glass')).toEqual([]);
    for (const id of ['screen', 'cageHoop', 'cageAR', 'cageAL', 'chainR', 'strapL', 'mirrorL', 'mirrorBaseR']) expect(byId.has(id), id).toBe(true);
    expect(byId.has('mirrorR')).toBe(false);
    const lit = new Set(def.panels.flatMap((p) => p.lights ?? []));
    for (const f of ['head', 'highBeam', 'tail', 'brake', 'reverse', 'indicatorL', 'indicatorR'] as const) expect(lit.has(f), f).toBe(true);
    expect(def.panels.find((p) => p.id === 'hood')!.bind).toEqual(['hood_*']);
    expect(def.panels.find((p) => p.id === 'bumperF')!.detach?.mode).toBe('follow');
    // the front bumper's right end hangs lower than its left end (bent)
    const g = byId.get('bumperF')!;
    let yR = Infinity;
    let yL = Infinity;
    for (let i = 0; i < g.position.length; i += 3) {
      if (g.position[i]! > 0.7) yR = Math.min(yR, g.position[i + 1]!);
      if (g.position[i]! < -0.7) yL = Math.min(yL, g.position[i + 1]!);
    }
    expect(yL - yR).toBeGreaterThan(0.04);
  });

  it('weathering: ≥ 2 doors/wings with their own colour, primer + rust on ≥ 30 % of the paint panels, numbers, cracked lenses', () => {
    const paint = BEATER_VISUAL.panels.filter((p) => p.material === 'paint');
    const own = paint.filter((p) => (p.kind === 'door' || p.kind === 'fender') && (p.finish?.color !== undefined || (p.finish?.primer ?? 0) >= 1));
    expect(own.length).toBeGreaterThanOrEqual(2);
    expect(paint.filter((p) => p.finish?.color !== undefined).length).toBeGreaterThanOrEqual(1);
    const arches = finishExtras(BEATER_VISUAL).arches ?? [];
    expect(arches.length).toBe(2);
    // measured coverage over each panel's own rest vertices (CPU mirror of the shader masks)
    let weathered = 0;
    for (const p of paint) {
      const g = byId.get(p.id)!;
      const row = finishRow(p);
      let rust = 0;
      let primer = 0;
      const n = g.position.length / 3;
      for (let i = 0; i < n; i++) {
        const m = finishMasks(row, g.position[3 * i]!, g.position[3 * i + 1]!, g.position[3 * i + 2]!, arches);
        rust += m.rust;
        primer += m.primer;
      }
      if (rust / n > 0.01 || primer / n > 0.01) weathered++;
    }
    expect(weathered / paint.length).toBeGreaterThanOrEqual(0.3);
    const sill = byId.get('sillR')!;
    const sillRow = finishRow(BEATER_VISUAL.panels.find((p) => p.id === 'sillR')!);
    let sillRust = 0;
    for (let i = 0; i < sill.position.length; i += 3) sillRust += finishMasks(sillRow, sill.position[i]!, sill.position[i + 1]!, sill.position[i + 2]!, arches).rust;
    expect(sillRust / (sill.position.length / 3)).toBeGreaterThan(0.3);
    expect(BEATER_VISUAL.panels.filter((p) => p.finish?.number).length).toBeGreaterThanOrEqual(3);
    expect((BEATER_VISUAL.panels.find((p) => p.id === 'headlightR')!.finish?.crack ?? 0)).toBeGreaterThanOrEqual(0.6);
    expect(paint.every((p) => hasFinish(p.finish))).toBe(true);
    expect(BEATER_VISUAL.paint).toEqual(BEATER_PAINT);
  });

  it('U6 draw budget: ≤ 15 body draws main pass, one shadow caster per cascade set; materials carry the finish texture', () => {
    const ctx = { quality: QUALITY_PRESETS.high } as unknown as RenderContext;
    const { binding, def } = bindTolerant(compiled, BEATER_VISUAL, geoms);
    const materials = createVehicleMaterials(ctx, def);
    expect(materialFinish(materials)).not.toBeNull();
    const damage = createVehicleDamage(compiled, binding, def);
    const lighting = { csm: null } as unknown as LightingStack;
    const renderer = { shadowMap: { render: () => {} } } as never;
    const skin = createFlexSkin(binding, { materials, damage, lighting, patchMaterial, anchorNode: compiled.frameNodes[0]!, renderer });
    expect(skin.meshes.length).toBeLessThanOrEqual(15);
    expect(new Set(skin.casters).size).toBeLessThanOrEqual(2);
    skin.dispose();
    damage.dispose();
    materials.dispose();
  });
});
