import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { BOX_DIMS, BOXTRUCK } from '../../../sim/vehicle/defs/boxtruck';
import { patchMaterial } from '../../material';
import type { LightingStack, RenderContext } from '../../types';
import { evalFlexVertex } from '../binder';
import { bindTolerant, createVehicleVisual } from '../index';
import { tessellateVehicle } from '../loft';
import { visualExtras } from '../lods';
import type { PanelGeometry, VehicleVisualDef } from '../types';
import { createWheelFrame, solveWheelFrame, wheelRest } from '../wheels';
import { BOXTRUCK_DIMS, BOXTRUCK_LIVERY, BOXTRUCK_PAINT, BOXTRUCK_VISUAL, buildBoxtruckVisual } from './boxtruck';

const compiled = compileVehicle(BOXTRUCK);
const geoms = tessellateVehicle(BOXTRUCK_VISUAL);
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

describe('BOXTRUCK_VISUAL', { timeout: 120_000 }, () => {
  it('names the truck and tessellates every panel: finite, unit normals, CCW outward', () => {
    expect(BOXTRUCK_VISUAL.vehicle).toBe(BOXTRUCK.name);
    expect(geoms.length).toBe(BOXTRUCK_VISUAL.panels.length);
    for (const g of geoms) {
      expect(g.index.length, g.panelId).toBeGreaterThan(0);
      for (const arr of [g.position, g.normal, g.uv, g.tangent!]) for (const x of arr) expect(Number.isFinite(x), g.panelId).toBe(true);
      for (let i = 0; i < g.normal.length; i += 3) expect(Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1)).toBeLessThan(1e-4);
      expect(windingAgreement(g), g.panelId).toBeGreaterThan(0.95);
    }
  });

  it('keeps the triangle budget: LOD0 ≤ 61k, LOD1 30–45 %, LOD2 a subset with fewer still', () => {
    const t0 = tris(geoms);
    const [l1, l2] = visualExtras(BOXTRUCK_VISUAL).lods!.map((f) => f());
    const t1 = tris(tessellateVehicle(l1!));
    const t2 = tris(tessellateVehicle(l2!));
    console.info(`[boxtruck LOD] triangles LOD0 ${t0} LOD1 ${t1} LOD2 ${t2}`);
    expect(t0).toBeLessThanOrEqual(61_000);
    expect(t1 / t0).toBeGreaterThan(0.3);
    expect(t1 / t0).toBeLessThan(0.45);
    expect(t2).toBeLessThan(0.8 * t1);
    const ids0 = BOXTRUCK_VISUAL.panels.map((p) => p.id);
    expect(l1!.panels.map((p) => p.id)).toEqual(ids0);
    for (const p of l2!.panels) expect(ids0).toContain(p.id);
  });

  it('is deterministic', () => {
    const again = tessellateVehicle(buildBoxtruckVisual({ lod: 0 }));
    for (let i = 0; i < geoms.length; i++) {
      expect(again[i]!.position).toEqual(geoms[i]!.position);
      expect(again[i]!.index).toEqual(geoms[i]!.index);
    }
  });

  it('every selector resolves; every panel binds at every LOD (none dropped); rest pose exact', () => {
    for (const p of BOXTRUCK_VISUAL.panels) {
      expect(resolve(p.bind).length, p.id).toBeGreaterThanOrEqual(3);
      if (p.glass && 'pairs' in p.glass.beams) for (const [a, b] of p.glass.beams.pairs) resolve([a, b]);
    }
    const b0 = bindTolerant(compiled, BOXTRUCK_VISUAL, geoms);
    expect(b0.dropped).toEqual([]);
    expect(b0.binding.panels.length).toBe(BOXTRUCK_VISUAL.panels.length);
    for (const ld of visualExtras(BOXTRUCK_VISUAL).lods!.map((f) => f())) expect(bindTolerant(compiled, ld, tessellateVehicle(ld)).dropped).toEqual([]);
    const out = new Float64Array(6);
    let max = 0;
    for (const p of b0.binding.panels) {
      for (let v = 0; v < p.vertexCount; v += 11) {
        evalFlexVertex(p, v, compiled.rig.nodePos, out);
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
    }
    expect(max).toBeLessThan(1e-5);
    for (const p of b0.binding.panels.filter((x) => x.kind === 'glass')) expect(p.glass!.beams.length, p.panelId).toBeGreaterThan(0);
  });

  it('matches the rig: axles, dual spacing, hub height, tyre size, box floor', () => {
    expect(BOXTRUCK_DIMS.boxFloorY).toBeCloseTo(BOX_DIMS.floorY, 6);
    const p = compiled.rig.nodePos;
    for (const w of compiled.wheels) {
      const x = Math.abs((p[3 * w.hubI]! + p[3 * w.hubO]!) / 2);
      const y = (p[3 * w.hubI + 1]! + p[3 * w.hubO + 1]!) / 2;
      const z = (p[3 * w.hubI + 2]! + p[3 * w.hubO + 2]!) / 2;
      expect(y).toBeCloseTo(BOXTRUCK_DIMS.hubY, 3);
      expect(w.radius).toBeCloseTo(BOXTRUCK_DIMS.tyreRadius, 3);
      if (w.axle === 'front') {
        expect(z).toBeCloseTo(BOXTRUCK_DIMS.axleFrontZ, 3);
        expect(x).toBeCloseTo(BOXTRUCK_DIMS.halfTrackFront, 3);
      } else {
        expect(z).toBeCloseTo(BOXTRUCK_DIMS.axleRearZ, 3);
        expect(x).toBeCloseTo(w.id.endsWith('i') ? BOXTRUCK_DIMS.dualInnerX : BOXTRUCK_DIMS.dualOuterX, 3);
      }
    }
  });

  it('a separate cab and box: box panels bind only box / guard nodes, cab panels never box nodes', () => {
    const boxPanels = BOXTRUCK_VISUAL.panels.filter((p) => /^(boxSide|boxRoof|boxFront|rollerDoor|battens|rivets|livery)/.test(p.id));
    expect(boxPanels.length).toBeGreaterThan(8);
    for (const p of boxPanels) for (const s of p.bind) expect(/^(b\d|b\*|bp)/.test(s), `${p.id} ${s}`).toBe(true);
    for (const id of ['cabShell', 'doorR', 'doorL', 'windscreen', 'hood']) for (const s of BOXTRUCK_VISUAL.panels.find((p) => p.id === id)!.bind) expect(/^b\d/.test(s), `${id} ${s}`).toBe(false);
  });

  it('declares glass, lamps, detachable bumper / hood, fleet-white paint with a white box finish and the livery', () => {
    const def: VehicleVisualDef = BOXTRUCK_VISUAL;
    expect(def.paint).toEqual(BOXTRUCK_PAINT);
    const glass = def.panels.filter((p) => p.material === 'glass');
    expect(glass.map((g) => g.id).sort()).toEqual(['doorGlassL', 'doorGlassR', 'rearGlass', 'windscreen']);
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
    // The box keeps its own white under any cab palette (the catalog palettes recolour the cab only).
    for (const id of ['boxSideR', 'boxSideL', 'boxRoof', 'boxFront']) expect(def.panels.find((p) => p.id === id)!.finish?.color, id).toBe(BOXTRUCK_LIVERY.box);
    for (const id of ['liveryTextR', 'liveryTextL', 'liveryBandR', 'liveryNose', 'mirrorR', 'mirrorL', 'fuelTank', 'exhaust', 'mudFlapR', 'stepsR', 'guardsR', 'bumperR', 'rollerDoor', 'grilleBars']) expect(byId.has(id), id).toBe(true);
    expect(def.wheels.mirrored).toEqual(['RLi', 'RRi']);
  });

  it('mirrored inner duals: the frame axle turns inboard and stays right-handed; the outer dual keeps outboard', () => {
    const p = compiled.rig.nodePos;
    for (const id of ['RL', 'RLi', 'RR', 'RRi']) {
      const w = compiled.wheels.find((x) => x.id === id)!;
      const mirrored = id.endsWith('i');
      const rest = wheelRest(compiled, w, mirrored);
      const fr = createWheelFrame();
      expect(solveWheelFrame(rest, p, 3, fr)).toBe(true);
      const cx = (p[3 * w.hubI]! + p[3 * w.hubO]!) / 2;
      // s points away from the vehicle centre on an outer wheel, toward it on an inner dual.
      expect(Math.sign(fr.s.x), id).toBe(mirrored ? -Math.sign(cx) : Math.sign(cx));
      expect(new Vector3().crossVectors(fr.u, fr.v).dot(fr.s), id).toBeCloseTo(1, 6);
    }
  });

  it('meets the U6 draw budget: ≤ 20 draws in the main pass (body + one wheel variant), 2 casters per cascade', () => {
    const renderer = { capabilities: { getMaxAnisotropy: () => 1 }, shadowMap: { render: () => {} } };
    const ctx = { renderer, quality: { level: 'low' } } as unknown as RenderContext;
    const lighting = { csm: null } as unknown as LightingStack;
    const v = createVehicleVisual(ctx, compiled, BOXTRUCK_VISUAL, { lighting, patchMaterial, fx: false, settle: false });
    const body = v.skin.levels[0]!.length;
    const wheels = (v.wheels as unknown as { levels: readonly (readonly unknown[])[] }).levels[0]!.length;
    console.info(`[boxtruck draws] main pass: body ${body} + wheels ${wheels}`);
    expect(v.lodBindings.length).toBe(2);
    expect(wheels).toBe(5);
    expect(body + wheels).toBeLessThanOrEqual(20);
    expect(v.skin.casters.length).toBe(2);
    expect(new Set(v.skin.casters).size).toBe(2);
    v.dispose();
  });
});
