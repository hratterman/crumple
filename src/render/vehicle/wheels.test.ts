import { BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, Quaternion, ShaderLib, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import { patchMaterial } from '../material';
import { QUALITY_PRESETS, type LightingStack, type RenderContext } from '../types';
import { createVehicleMaterials, PAINT_PALETTE } from './materials';
import type { FlexSkin, VehicleVisualDef, WheelVisualDef } from './types';
import {
  applyTyreGlsl,
  buildRimGeometry,
  buildTyreGeometry,
  createTyreUniforms,
  createWheelFrame,
  createWheelVisuals,
  deformTyrePoint,
  solveWheelFrame,
  TYRE_SINK_PER_COMPRESSION,
  updateTyreUniforms,
  wheelDims,
  wheelRest,
} from './wheels';

const compiled = compileVehicle(SEDAN);
const N = compiled.rig.nodeCount;
const WDEF: WheelVisualDef = {
  rim: { style: 'spoke', spokes: 5, spokeWidth: 0.34, dish: 0.034, lip: 0.012, finish: 'silver', boltCount: 5 },
  tire: { tread: 'street', sidewallText: 'Crumple', bulge: 0.1 },
  brake: { discRadius: 0.15, caliperColor: 0xcc1111 },
};

/** Rest positions as skin block A (stride 4). */
function restNodes(): Float32Array {
  const out = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) out.set([compiled.rig.nodePos[3 * i]!, compiled.rig.nodePos[3 * i + 1]!, compiled.rig.nodePos[3 * i + 2]!, 0], 4 * i);
  return out;
}

function ringCentre(nodes: Float32Array, start: number, count: number): Vector3 {
  const c = new Vector3();
  for (let k = 0; k < count; k++) c.add(new Vector3(nodes[4 * (start + k)]!, nodes[4 * (start + k) + 1]!, nodes[4 * (start + k) + 2]!));
  return c.multiplyScalar(1 / count);
}

/** Rotates a wheel's rim + tyre nodes by `angle` about its rim axis. */
function spinWheel(nodes: Float32Array, wi: number, angle: number): void {
  const w = compiled.wheels[wi]!;
  const cI = ringCentre(nodes, w.rimStart, w.rays);
  const cO = ringCentre(nodes, w.rimStart + w.rays, w.rays);
  const c = cI.clone().add(cO).multiplyScalar(0.5);
  const q = new Quaternion().setFromAxisAngle(cO.clone().sub(cI).normalize(), angle);
  for (let k = 0; k < 4 * w.rays; k++) {
    const i = w.rimStart + k;
    const p = new Vector3(nodes[4 * i]!, nodes[4 * i + 1]!, nodes[4 * i + 2]!).sub(c).applyQuaternion(q).add(c);
    nodes.set([p.x, p.y, p.z], 4 * i);
  }
}

describe('wheel rest data', () => {
  it('ray slots are evenly spaced and the rest frame is upright', () => {
    for (const w of compiled.wheels) {
      const rest = wheelRest(compiled, w);
      expect(new Set(Array.from(rest.slotOf.slice(0, w.rays))).size).toBe(w.rays);
      const f = createWheelFrame();
      expect(solveWheelFrame(rest, compiled.rig.nodePos, 3, f)).toBe(true);
      expect(f.u.y).toBeGreaterThan(0.999);
      // s points outboard: −X on the left (x < 0) wheels
      expect(Math.sign(f.s.x)).toBe(Math.sign(f.centre.x));
      expect(f.v.clone().cross(f.s).dot(f.u)).toBeCloseTo(1, 6); // right-handed (s, u, v)
      const d = wheelDims(compiled, w);
      expect(d.radius).toBeCloseTo(w.radius);
      expect(d.tyreHalfW).toBeGreaterThan(d.rowHalf);
      expect(d.rimHalfW).toBeLessThan(d.tyreHalfW);
    }
  });
});

describe('wheel frame solve', () => {
  it('follows spin from the rim nodes (sign and magnitude)', () => {
    const nodes = restNodes();
    const rest = wheelRest(compiled, compiled.wheels[0]!);
    const f0 = createWheelFrame();
    solveWheelFrame(rest, nodes, 4, f0);
    for (const ang of [0.2, 1.3, -2.5, 3.0]) {
      const n = restNodes();
      spinWheel(n, 0, ang);
      const f = createWheelFrame();
      solveWheelFrame(rest, n, 4, f);
      const got = Math.atan2(f.u.dot(f0.v), f.u.dot(f0.u));
      expect(got).toBeCloseTo(ang, 4);
      expect(f.centre.distanceTo(f0.centre)).toBeLessThan(1e-5);
    }
  });

  it('is rigid-motion invariant (whole rig yawed + moved)', () => {
    const rest = wheelRest(compiled, compiled.wheels[2]!);
    const f0 = createWheelFrame();
    solveWheelFrame(rest, restNodes(), 4, f0);
    const m = new Matrix4().makeRotationY(0.6).setPosition(3, 1, -2);
    const n = restNodes();
    for (let i = 0; i < N; i++) {
      const p = new Vector3(n[4 * i]!, n[4 * i + 1]!, n[4 * i + 2]!).applyMatrix4(m);
      n.set([p.x, p.y, p.z], 4 * i);
    }
    const f = createWheelFrame();
    solveWheelFrame(rest, n, 4, f);
    expect(f.centre.distanceTo(f0.centre.clone().applyMatrix4(m))).toBeLessThan(1e-5);
    const rot = new Matrix4().extractRotation(m);
    expect(f.u.distanceTo(f0.u.clone().applyMatrix4(rot))).toBeLessThan(1e-5);
    expect(f.s.distanceTo(f0.s.clone().applyMatrix4(rot))).toBeLessThan(1e-5);
  });

  it('rejects degenerate / NaN rings and keeps the last frame', () => {
    const rest = wheelRest(compiled, compiled.wheels[0]!);
    const f = createWheelFrame();
    solveWheelFrame(rest, restNodes(), 4, f);
    const keep = f.centre.clone();
    expect(solveWheelFrame(rest, new Float32Array(N * 4), 4, f)).toBe(false);
    const n = restNodes().fill(Number.NaN);
    expect(solveWheelFrame(rest, n, 4, f)).toBe(false);
    expect(f.centre.equals(keep)).toBe(true);
  });
});

describe('tyre deformation', () => {
  const w = compiled.wheels[0]!;
  const rest = wheelRest(compiled, w);
  const dims = wheelDims(compiled, w);

  function setup(nodes: Float32Array) {
    const f = createWheelFrame();
    solveWheelFrame(rest, nodes, 4, f);
    const u = createTyreUniforms(dims, rest);
    updateTyreUniforms(rest, dims, f, nodes, 4, u);
    return { f, u };
  }

  it('rest / airborne pose leaves the tyre round', () => {
    const { u } = setup(restNodes());
    for (const v of u.di.value.slice(0, w.rays)) expect(Math.abs(v)).toBeLessThan(1e-6);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const p = new Vector3(0.03, dims.radius * Math.cos(a), dims.radius * Math.sin(a));
      const q = deformTyrePoint(u, p.clone());
      expect(q.distanceTo(p)).toBeLessThan(1e-6);
    }
  });

  it('one pressed-in ray dents the tread there and nowhere else', () => {
    const n = restNodes();
    const { f: f0 } = setup(n);
    const k = 3;
    for (const row of [0, w.rays]) {
      const i = w.tireStart + row + k;
      const p = new Vector3(n[4 * i]!, n[4 * i + 1]!, n[4 * i + 2]!);
      const radial = p.clone().sub(f0.centre).projectOnPlane(f0.s).normalize();
      p.addScaledVector(radial, -0.02);
      n.set([p.x, p.y, p.z], 4 * i);
    }
    const { u, f } = setup(n);
    const i0 = w.tireStart + k;
    const dir = new Vector3(n[4 * i0]!, n[4 * i0 + 1]!, n[4 * i0 + 2]!).sub(f.centre).projectOnPlane(f.s).normalize();
    const ly = dir.dot(f.u);
    const lz = dir.dot(f.v);
    const at = (ang: number): number => {
      const c = Math.cos(ang), s = Math.sin(ang);
      const q = deformTyrePoint(u, new Vector3(0, dims.radius * (ly * c - lz * s), dims.radius * (ly * s + lz * c)));
      return Math.hypot(q.y, q.z);
    };
    // the dent may be 0 at this ray if the ground-plane estimator latched it, so only check radial dent
    expect(at(0)).toBeLessThan(dims.radius - 0.015);
    const step = (2 * Math.PI) / w.rays;
    expect(Math.abs(at(step * 2) - dims.radius)).toBeLessThan(0.003);
    expect(Math.abs(at(-step * 2) - dims.radius)).toBeLessThan(0.003);
  });

  it('settled on the ground: contact plane at the road, tread flattened onto it', () => {
    const n = restNodes();
    const { f: f0 } = setup(n);
    // move the rig so the axle sits 0.281 m above the ground y = 0 (settled sedan), then press the
    // tyre nodes the way the soft contact layer does: penetration p = c + K·c (c = carcass compression)
    const shift = 0.281 - f0.centre.y;
    for (let i = 0; i < N; i++) n[4 * i + 1]! += shift;
    const c = f0.centre.clone().setY(0.281);
    for (let k = 0; k < 2 * w.rays; k++) {
      const i = w.tireStart + k;
      const p = new Vector3(n[4 * i]!, n[4 * i + 1]!, n[4 * i + 2]!);
      const pen = dims.nodeRadius - p.y;
      if (pen <= 0) continue;
      const radial = p.clone().sub(c).projectOnPlane(f0.s);
      p.addScaledVector(radial, -pen / (1 + TYRE_SINK_PER_COMPRESSION) / radial.length());
      n.set([p.x, p.y, p.z], 4 * i);
    }
    const { u, f } = setup(n);
    expect(Math.abs(u.plane.value.w + f.centre.y)).toBeLessThan(0.004);
    let lowest = Infinity;
    for (let k = 0; k < 180; k++) {
      const a = (k / 180) * Math.PI * 2;
      for (const x of [-0.05, 0, 0.05]) {
        const q = deformTyrePoint(u, new Vector3(x, dims.radius * Math.cos(a), dims.radius * Math.sin(a)));
        lowest = Math.min(lowest, f.centre.y + q.x * f.s.y + q.y * f.u.y + q.z * f.v.y);
      }
    }
    expect(Math.abs(lowest)).toBeLessThan(0.004);
  });

  it('GLSL edit applies to colour and depth programs', () => {
    for (const vs of [ShaderLib.physical.vertexShader, ShaderLib.depth.vertexShader, ShaderLib.distance.vertexShader]) {
      const sh = { vertexShader: vs };
      applyTyreGlsl(sh);
      expect(sh.vertexShader).toContain('uTyrePlane');
      expect(sh.vertexShader).not.toContain('#include <begin_vertex>');
    }
    expect(() => applyTyreGlsl({ vertexShader: 'void main(){}' })).toThrow();
  });
});

function checkGeometry(g: BufferGeometry): void {
  const p = g.getAttribute('position').array;
  const n = g.getAttribute('normal').array;
  let finite = true;
  for (let i = 0; i < p.length; i++) finite &&= Number.isFinite(p[i]!);
  expect(finite).toBe(true);
  let worst = 0;
  for (let i = 0; i < n.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) - 1));
  expect(worst).toBeLessThan(0.01);
  // winding agrees with the authored normals
  const idx = g.getIndex();
  if (!idx) return;
  let agree = 0;
  let total = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), nn = new Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    a.fromArray(p, i0 * 3);
    b.fromArray(p, i1 * 3);
    c.fromArray(p, i2 * 3);
    const fn = b.sub(a).cross(c.sub(a));
    if (fn.lengthSq() < 1e-14) continue;
    nn.fromArray(n, i0 * 3);
    total++;
    if (fn.dot(nn) > 0) agree++;
  }
  expect(agree / total).toBeGreaterThan(0.97);
}

describe('wheel geometry', () => {
  const dims = wheelDims(compiled, compiled.wheels[0]!);
  it('tyre: tread on the contact radius, grooves aligned, outward normals', () => {
    for (const tread of ['street', 'sport', 'allTerrain'] as const) {
      const t = buildTyreGeometry(dims, { ...WDEF.tire, tread });
      checkGeometry(t.tread);
      checkGeometry(t.sidewall);
      t.tread.computeBoundingBox();
      const bb = t.tread.boundingBox!;
      expect(bb.max.y).toBeCloseTo(dims.radius, 3);
      expect(bb.max.x).toBeCloseTo(dims.tyreHalfW, 3);
      for (const g of t.grooves) {
        expect(g.v).toBeGreaterThan(0.05);
        expect(g.v).toBeLessThan(0.95);
      }
    }
  });

  it('rim: every part valid; disc and caliper clear the spokes and the barrel', () => {
    for (const style of ['spoke', 'mesh', 'turbine', 'steel'] as const) {
      const g = buildRimGeometry(dims, WDEF, { ...WDEF.rim, style });
      for (const part of [g.face, g.barrel, g.cap, g.disc, g.hat, g.caliper, g.shield]) checkGeometry(part);
      const L = g.layout;
      expect(L.rDisc).toBeLessThan(dims.bead - 0.04);
      g.caliper.computeBoundingBox();
      const cb = g.caliper.boundingBox!;
      expect(Math.hypot(cb.max.y, cb.max.z)).toBeLessThan(dims.bead - 0.012); // inside the barrel
      expect(cb.max.x).toBeLessThan(L.xHub - 0.005); // behind the spoke backs at the hub
      g.face.computeBoundingBox();
      expect(g.face.boundingBox!.max.x).toBeLessThan(dims.tyreHalfW + 0.005);
    }
  });
});

describe('createWheelVisuals', { timeout: 60_000 }, () => {
  const def: VehicleVisualDef = { vehicle: compiled.name, panels: [], paint: PAINT_PALETTE.liquidSilver, wheels: WDEF };
  const ctx = { quality: QUALITY_PRESETS.high } as unknown as RenderContext;
  const lighting = { csm: null } as unknown as LightingStack;

  it('instanced draws per part (all wheels in one), LOD levels, follows the skin, disposes', () => {
    const materials = createVehicleMaterials(ctx, def);
    const wv = createWheelVisuals(compiled, WDEF, { materials, lighting, patchMaterial });
    // one geometry variant (all four wheels alike): 5 draws per LOD level, 3 levels, no casters (no renderer hook)
    expect(wv.levels.map((l) => l.length)).toEqual([5, 5, 5]);
    expect(wv.casters.length).toBe(0);
    const lod0 = wv.levels[0]! as InstancedMesh[];
    for (const m of lod0) {
      expect(m.isInstancedMesh).toBe(true);
      expect(m.count).toBe(compiled.wheels.length);
      expect(m.visible).toBe(true);
      expect(m.castShadow).toBe(true);
    }
    for (const m of wv.levels[1]!) expect(m.visible).toBe(false);
    const tyres = lod0.filter((m) => m.customDepthMaterial);
    expect(tyres).toHaveLength(2); // tread + sidewall deform in the shadow pass too
    const rim = lod0.find((m) => m.name === 'wheelRim0')!;
    expect(rim.geometry.getAttribute('crPbr')).toBeDefined();
    expect(rim.geometry.getAttribute('color')).toBeDefined();
    // LOD1 / LOD2 triangle budgets per wheel
    const tris = (list: readonly Mesh[]): number => list.reduce((n, m) => n + m.geometry.getIndex()!.count / 3, 0);
    expect(tris(wv.levels[1]!)).toBeLessThanOrEqual(4000);
    expect(tris(wv.levels[2]!)).toBeLessThan(tris(wv.levels[1]!) / 2);
    expect(tris(wv.levels[0]!)).toBeGreaterThan(8 * tris(wv.levels[1]!));
    // skin at an anchor, wheel 0 spun by 1 rad
    const nodes = restNodes();
    spinWheel(nodes, 0, 1);
    const root = new Group();
    root.position.set(10, 0, 5);
    const skin = { object: root, nodeData: nodes, lod: 1 } as unknown as FlexSkin;
    wv.update(skin, 1 / 60);
    expect(wv.object.position.toArray()).toEqual([10, 0, 5]);
    expect(wv.lod).toBe(1);
    expect(wv.levels[1]![0]!.visible).toBe(true);
    expect(lod0[0]!.visible).toBe(false);
    const spinM = new Matrix4();
    rim.getMatrixAt(0, spinM);
    const u = new Vector3().setFromMatrixColumn(spinM, 1);
    expect(u.y).toBeCloseTo(Math.cos(1), 4);
    expect(rim.boundingSphere!.radius).toBeGreaterThan(1);
    // child of the skin root → no double offset
    root.add(wv.object);
    wv.update(skin, 1 / 60);
    expect(wv.object.position.length()).toBe(0);
    wv.dispose();
    materials.dispose();
  });

  it('instanced tyre GLSL picks the wheel by gl_InstanceID', () => {
    const sh = { vertexShader: ShaderLib.physical.vertexShader };
    applyTyreGlsl(sh, 4);
    expect(sh.vertexShader).toContain('uniform vec4 uTyreD[ 32 ];');
    expect(sh.vertexShader).toContain('int tyI = gl_InstanceID;');
    expect(sh.vertexShader).not.toContain('#include <begin_vertex>');
  });
});
