import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { COUPE } from '../../../sim/vehicle/defs/coupe';
import { patchMaterial } from '../../material';
import type { LightingStack, RenderContext } from '../../types';
import { applyFollowers, bindPanels, evalFlexVertex } from '../binder';
import { bindTolerant, createVehicleVisual } from '../index';
import { tessellateVehicle } from '../loft';
import { visualExtras } from '../lods';
import { slotBox } from '../materials';
import type { PanelGeometry, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { buildCoupeVisual, COUPE_DIMS, COUPE_FOLLOW, COUPE_PAINT, COUPE_VISUAL } from './coupe';

const compiled = compileVehicle(COUPE);
const geoms = tessellateVehicle(COUPE_VISUAL);
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

describe('COUPE_VISUAL', { timeout: 120_000 }, () => {
  it('names the coupe and tessellates every panel: finite, unit normals, CCW outward', () => {
    expect(COUPE_VISUAL.vehicle).toBe(COUPE.name);
    expect(geoms.length).toBe(COUPE_VISUAL.panels.length);
    for (const g of geoms) {
      expect(g.index.length, g.panelId).toBeGreaterThan(0);
      for (const arr of [g.position, g.normal, g.uv, g.tangent!]) for (const x of arr) expect(Number.isFinite(x), g.panelId).toBe(true);
      for (let i = 0; i < g.normal.length; i += 3) expect(Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1)).toBeLessThan(1e-4);
      expect(windingAgreement(g), g.panelId).toBeGreaterThan(0.97);
    }
  });

  it('keeps the sedan triangle budget: LOD0 ≤ 61k, LOD1 ≈ 40 %, LOD2 a subset with fewer still', () => {
    const t0 = tris(geoms);
    const [l1, l2] = visualExtras(COUPE_VISUAL).lods!.map((f) => f());
    const t1 = tris(tessellateVehicle(l1!));
    const t2 = tris(tessellateVehicle(l2!));
    console.info(`[coupe LOD] triangles LOD0 ${t0} LOD1 ${t1} LOD2 ${t2}`);
    expect(t0).toBeLessThanOrEqual(61_000);
    expect(t1 / t0).toBeGreaterThan(0.3);
    expect(t1 / t0).toBeLessThan(0.45);
    expect(t2).toBeLessThan(0.8 * t1);
    const ids0 = COUPE_VISUAL.panels.map((p) => p.id);
    expect(l1!.panels.map((p) => p.id)).toEqual(ids0);
    for (const p of l2!.panels) expect(ids0).toContain(p.id);
  });

  it('is deterministic', () => {
    const again = tessellateVehicle(buildCoupeVisual({ lod: 0 }));
    for (let i = 0; i < geoms.length; i++) {
      expect(again[i]!.position).toEqual(geoms[i]!.position);
      expect(again[i]!.index).toEqual(geoms[i]!.index);
    }
  });

  it('every selector resolves against compileVehicle(COUPE); every panel binds at every LOD (none dropped); rest pose exact', () => {
    for (const p of COUPE_VISUAL.panels) {
      expect(resolve(p.bind).length, p.id).toBeGreaterThanOrEqual(3);
      if (p.glass && 'pairs' in p.glass.beams) for (const [a, b] of p.glass.beams.pairs) resolve([a, b]);
    }
    const b0 = bindTolerant(compiled, COUPE_VISUAL, geoms);
    expect(b0.dropped).toEqual([]);
    expect(b0.binding.panels.length).toBe(COUPE_VISUAL.panels.length);
    for (const ld of visualExtras(COUPE_VISUAL).lods!.map((f) => f())) expect(bindTolerant(compiled, ld, tessellateVehicle(ld)).dropped).toEqual([]);
    const out = new Float64Array(6);
    let max = 0;
    for (const p of b0.binding.panels) {
      for (let v = 0; v < p.vertexCount; v += 11) {
        evalFlexVertex(p, v, compiled.rig.nodePos, out);
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
    }
    expect(max).toBeLessThan(1e-5);
    // Glass panes resolve their crack beams (BeamSelector pairs must be real rig beams).
    for (const p of b0.binding.panels.filter((x) => x.kind === 'glass')) expect(p.glass!.beams.length, p.panelId).toBeGreaterThan(0);
  });

  it('door cards follow their door skins', () => {
    expect(visualExtras(COUPE_VISUAL).follow).toBe(COUPE_FOLLOW);
    const b = bindPanels(compiled, COUPE_VISUAL, geoms);
    const f = applyFollowers(compiled.rig, b, COUPE_FOLLOW);
    for (const [card, door] of Object.entries(COUPE_FOLLOW)) {
      expect(COUPE_VISUAL.panels.some((p) => p.id === card), card).toBe(true);
      expect(COUPE_VISUAL.panels.some((p) => p.id === door), door).toBe(true);
    }
    expect(f.panels.length).toBe(b.panels.length);
  });

  it('matches the rig: wheelbase, track, hub height, tyre size', () => {
    for (const w of compiled.wheels) {
      const p = compiled.rig.nodePos;
      const x = (p[3 * w.hubI]! + p[3 * w.hubO]!) / 2;
      const y = (p[3 * w.hubI + 1]! + p[3 * w.hubO + 1]!) / 2;
      const z = (p[3 * w.hubI + 2]! + p[3 * w.hubO + 2]!) / 2;
      expect(Math.abs(x)).toBeCloseTo(COUPE_DIMS.halfTrack, 3);
      expect(y).toBeCloseTo(COUPE_DIMS.hubY, 3);
      expect(z).toBeCloseTo(w.id[0] === 'F' ? COUPE_DIMS.axleFrontZ : COUPE_DIMS.axleRearZ, 3);
      expect(w.radius).toBeCloseTo(COUPE_DIMS.tyreRadius, 3);
    }
  });

  it('wheel arches sit over the hubs: no body skin inside the tyre envelope', () => {
    const skin = COUPE_VISUAL.panels.filter((p) => ['body', 'fender', 'door', 'bumper', 'hood', 'trunk'].includes(p.kind)).map((p) => byId.get(p.id)!);
    const clearance = COUPE_DIMS.tyreRadius + 0.02;
    for (const g of skin) {
      for (let i = 0; i < g.position.length; i += 3) {
        const x = Math.abs(g.position[i]!);
        if (x < COUPE_DIMS.halfTrack - COUPE_DIMS.tyreHalfW || x > COUPE_DIMS.halfTrack + COUPE_DIMS.tyreHalfW) continue;
        for (const zc of [COUPE_DIMS.axleFrontZ, COUPE_DIMS.axleRearZ]) {
          const r = Math.hypot(g.position[i + 2]! - zc, g.position[i + 1]! - COUPE_DIMS.hubY);
          expect(r, g.panelId).toBeGreaterThan(clearance);
        }
      }
    }
  });

  it('cuts real shut gaps between neighbouring panels', () => {
    const pairsToCheck: [string, string][] = [
      ['hood', 'fenderR'],
      ['fenderR', 'doorR'],
      ['doorR', 'quarterR'],
      ['doorL', 'sillL'],
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
    const ids = COUPE_VISUAL.panels.map((p) => p.id);
    let twins = 0;
    for (const id of ids) {
      const m = /^(.*?)R([A-Z]?\w*)$/.exec(id);
      if (!m || id.startsWith('rear') || id.startsWith('quarter') || id === 'roof' || id === 'reverseLamps' || id === 'radiatorSupport') continue;
      const twin = `${m[1]}L${m[2]}`;
      if (!byId.has(twin)) continue;
      twins++;
      const a = byId.get(id)!;
      const b = byId.get(twin)!;
      expect(b.position.length, id).toBe(a.position.length);
      for (let i = 0; i < a.position.length; i += 3 * 17) {
        expect(b.position[i]).toBeCloseTo(-a.position[i]!, 6);
        expect(b.position[i + 1]).toBe(a.position[i + 1]);
      }
    }
    expect(twins).toBeGreaterThan(15);
  });

  it('declares glass, lamps, detachable parts and its own wheel / paint design', () => {
    const def: VehicleVisualDef = COUPE_VISUAL;
    const glass = def.panels.filter((p) => p.material === 'glass');
    expect(glass.map((g) => g.id).sort()).toEqual(['glassL', 'glassLQ', 'glassR', 'glassRQ', 'rearGlass', 'windscreen']);
    for (const g of glass) {
      expect(g.glass, g.id).toBeDefined();
      expect(g.castShadow).toBe(false);
    }
    expect(def.panels.find((p) => p.id === 'windscreen')!.glass!.laminated).toBe(true);
    const lit = new Set(def.panels.flatMap((p) => p.lights ?? []));
    for (const f of ['head', 'highBeam', 'tail', 'brake', 'reverse', 'indicatorL', 'indicatorR'] as const) expect(lit.has(f), f).toBe(true);
    for (const p of def.panels) if (p.lights) expect(p.material.startsWith('light'), p.id).toBe(true);
    expect(def.panels.find((p) => p.id === 'hood')!.bind).toEqual(['hood_*']);
    expect(def.panels.find((p) => p.id === 'hood')!.detach?.mode).toBe('follow');
    expect(def.panels.find((p) => p.id === 'bumperF')!.bind).toEqual(['s0_*']);
    expect(def.panels.find((p) => p.id === 'bumperF')!.detach?.mode).toBe('follow');
    expect(def.panels.find((p) => p.id === 'bumperR')!.bind).toEqual(['s12_*']);
    expect(def.paint).toEqual(COUPE_PAINT);
    // Distinct from the sedan's 5-spoke: a 14-bar mesh rim, quad exhaust tips, a full-width light bar.
    expect(def.wheels.rim.style).toBe('mesh');
    const tail = byId.get('taillights')!;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (let i = 0; i < tail.position.length; i += 3) {
      xMin = Math.min(xMin, tail.position[i]!);
      xMax = Math.max(xMax, tail.position[i]!);
    }
    expect(xMin).toBeLessThan(-0.8);
    expect(xMax).toBeGreaterThan(0.8);
    for (const id of ['exhaust', 'diffuser', 'scoopGrilleR', 'scoopGrilleL', 'splitter', 'grille', 'grilleSlats', 'mirrorR', 'mirrorL', 'handleR', 'handleL']) expect(byId.has(id), id).toBe(true);
  });

  it('headlamp parts line up with the lamp shader layout (projector "eyes" on the discs, DRL band on the guide)', () => {
    const box = slotBox(COUPE_VISUAL, 'lightHead')!;
    const W = box.max.x - box.min.x;
    const H = box.max.y - box.min.y;
    expect(H).toBeGreaterThan(0.04);
    expect(H).toBeLessThan(0.1);
    const g = byId.get('headlights')!;
    for (const f of [0.34, 0.66]) {
      const cx = box.min.x + f * W;
      const cy = box.min.y + 0.58 * H;
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
      expect(Math.abs(sx / n - cx), `eye ${f} x`).toBeLessThan(0.003);
      expect(Math.abs(sy / n - cy), `eye ${f} y`).toBeLessThan(0.003);
    }
  });

  it('meets the U6 draw budget: ≤ 20 draws in the main pass (body + one wheel variant), 2 casters per cascade', () => {
    // A renderer with a shadow map (shadowlod.ts hooks it): colour meshes never cast, casters are separate.
    const renderer = { capabilities: { getMaxAnisotropy: () => 1 }, shadowMap: { render: () => {} } };
    const ctx = { renderer, quality: { level: 'low' } } as unknown as RenderContext;
    const lighting = { csm: null } as unknown as LightingStack;
    const v = createVehicleVisual(ctx, compiled, COUPE_VISUAL, { lighting, patchMaterial, fx: false, settle: false });
    const body = v.skin.levels[0]!.length;
    const wheels = (v.wheels as unknown as { levels: readonly (readonly unknown[])[] }).levels[0]!.length;
    console.info(`[coupe draws] main pass: body ${body} + wheels ${wheels}`);
    expect(v.lodBindings.length).toBe(2);
    expect(wheels).toBe(5);
    expect(body + wheels).toBeLessThanOrEqual(20);
    // One body caster per cascade (cascade 0: LOD1, cascades ≥ 1: LOD2) + one instanced wheel caster.
    expect(v.skin.casters.length).toBe(2);
    expect(new Set(v.skin.casters).size).toBe(2);
    v.dispose();
  });
});
