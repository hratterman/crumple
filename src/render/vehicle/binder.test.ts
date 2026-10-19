import { describe, expect, it } from 'vitest';

import { compileRig } from '../../sim/rig/builder';
import type { RigDef } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import { bindPanels, boundaryBeams, evalFlexFrame, evalFlexVertex, rigHashOf, resolveBeamSelector } from './binder';
import { syntheticCubeSubject } from './synthetic';
import {
  BindError,
  FLEX_MAX_AB,
  FLEX_MAX_ABS_C,
  FLEX_MAX_EDGE,
  FLEX_MAX_EDGE_RATIO,
  FLEX_MIN_ANGLE_DEG,
  FLEX_MIN_EDGE,
  type BindingPanel,
  type PanelGeometry,
  type VehicleVisualDef,
} from './types';

const subject = syntheticCubeSubject();
const binding = bindPanels(subject.compiled, subject.def, subject.geoms);
const rig = subject.compiled.rig;

function restNodes(): Float64Array {
  return Float64Array.from(rig.nodePos);
}

/** Rotation matrix (row-major) from axis-angle. */
function rotation(axis: [number, number, number], angle: number): number[] {
  const l = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / l) as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
function apply(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
}
function transformNodes(src: Float64Array, m: number[], t: [number, number, number]): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = apply(m, src[i]!, src[i + 1]!, src[i + 2]!);
    out[i] = p[0] + t[0];
    out[i + 1] = p[1] + t[1];
    out[i + 2] = p[2] + t[2];
  }
  return out;
}

describe('bindPanels on the synthetic cube shell', () => {
  it('binds every vertex, welds seams and reports stats', () => {
    expect(binding.vehicle).toBe('softCube');
    expect(binding.nodeCount).toBe(64);
    expect(binding.panels.map((p) => p.panelId)).toEqual(['shell', 'lid']);
    const verts = subject.geoms.reduce((s, g) => s + g.position.length / 3, 0);
    expect(binding.stats.vertices).toBe(verts);
    // 5 shell faces share 8 edges (27 verts each), minus the 4 corner triples' extra copies.
    expect(binding.stats.welded).toBeGreaterThan(8 * 25);
    expect(binding.stats.maxAbsC).toBeLessThanOrEqual(FLEX_MAX_ABS_C);
    expect(binding.stats.minAngleDeg).toBeGreaterThanOrEqual(FLEX_MIN_ANGLE_DEG - 1e-9);
  });

  it('every triad satisfies the acceptance rules', () => {
    const pos = rig.nodePos;
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        const [r, x, y] = [p.triad[3 * v]!, p.triad[3 * v + 1]!, p.triad[3 * v + 2]!];
        expect(x).toBeLessThan(y);
        expect(r !== x && r !== y).toBe(true);
        const e1 = [0, 1, 2].map((k) => pos[3 * x + k]! - pos[3 * r + k]!);
        const e2 = [0, 1, 2].map((k) => pos[3 * y + k]! - pos[3 * r + k]!);
        const l1 = Math.hypot(...e1);
        const l2 = Math.hypot(...e2);
        expect(l1).toBeGreaterThanOrEqual(FLEX_MIN_EDGE);
        expect(l2).toBeLessThanOrEqual(FLEX_MAX_EDGE);
        expect(Math.max(l1, l2) / Math.min(l1, l2)).toBeLessThanOrEqual(FLEX_MAX_EDGE_RATIO);
        const ang = (Math.acos((e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!) / (l1 * l2)) * 180) / Math.PI;
        expect(ang).toBeGreaterThanOrEqual(FLEX_MIN_ANGLE_DEG - 1e-9);
        expect(ang).toBeLessThanOrEqual(180 - FLEX_MIN_ANGLE_DEG + 1e-9);
        expect(Math.abs(p.coef[4 * v]!)).toBeLessThanOrEqual(FLEX_MAX_AB);
        expect(Math.abs(p.coef[4 * v + 2]!)).toBeLessThanOrEqual(FLEX_MAX_ABS_C);
      }
    }
  });

  it('panels bind only to their own nodes', () => {
    const lid = binding.panels[1]!;
    for (const n of lid.nodes) expect(rig.nodeIds[n]).toMatch(/^n\d_3_\d$/);
    for (const n of lid.triad) expect(lid.bindNodes.includes(n)).toBe(true);
    expect(lid.bindNodes.length).toBe(16);
  });

  it('rest pose reconstructs exactly (< 1e-5 m) with rest normals and tangents', () => {
    const nodes = restNodes();
    const out = new Float64Array(6);
    const tan = new Float64Array(4);
    let maxP = 0;
    let maxN = 0;
    let maxT = 0;
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexFrame(p, v, nodes, out, tan);
        for (let k = 0; k < 3; k++) {
          maxP = Math.max(maxP, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
          maxN = Math.max(maxN, Math.abs(out[3 + k]! - p.restNormal[3 * v + k]!));
          maxT = Math.max(maxT, Math.abs(tan[k]! - p.restTangent![4 * v + k]!));
        }
        expect(tan[3]).toBe(1);
      }
    }
    expect(maxP).toBeLessThan(1e-5);
    expect(maxN).toBeLessThan(1e-5);
    expect(maxT).toBeLessThan(1e-5);
  });

  it('f32 (GPU-precision) reconstruction of the rest pose stays < 1e-5 m', () => {
    const nodes = Float32Array.from(rig.nodePos);
    const out = new Float64Array(6);
    let maxP = 0;
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        evalF32(p, v, nodes, out);
        for (let k = 0; k < 3; k++) maxP = Math.max(maxP, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
    }
    expect(maxP).toBeLessThan(1e-5);
  });

  it('rigid rotation + translation moves the mesh rigidly and rotates normals exactly', () => {
    const m = rotation([0.3, 1, -0.4], 2.1);
    const t: [number, number, number] = [312.5, 41.25, -87.75];
    const nodes = transformNodes(restNodes(), m, t);
    const out = new Float64Array(6);
    const tan = new Float64Array(4);
    let maxP = 0;
    let maxN = 0;
    let maxT = 0;
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexFrame(p, v, nodes, out, tan);
        const rp = p.restPosition;
        const q = apply(m, rp[3 * v]!, rp[3 * v + 1]!, rp[3 * v + 2]!);
        const n = apply(m, p.restNormal[3 * v]!, p.restNormal[3 * v + 1]!, p.restNormal[3 * v + 2]!);
        const tt = apply(m, p.restTangent![4 * v]!, p.restTangent![4 * v + 1]!, p.restTangent![4 * v + 2]!);
        for (let k = 0; k < 3; k++) {
          maxP = Math.max(maxP, Math.abs(out[k]! - (q[k]! + t[k]!)));
          maxN = Math.max(maxN, Math.abs(out[3 + k]! - n[k]!));
          maxT = Math.max(maxT, Math.abs(tan[k]! - tt[k]!));
        }
      }
    }
    expect(maxP).toBeLessThan(1e-5);
    expect(maxN).toBeLessThan(1e-5);
    expect(maxT).toBeLessThan(1e-5);
  });

  it('shear + stretch keeps normals unit and orthogonal to tangents', () => {
    // Non-rigid affine map + a wavy dent.
    const src = restNodes();
    const nodes = new Float64Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i]!, y = src[i + 1]!, z = src[i + 2]!;
      nodes[i] = 1.3 * x + 0.4 * y;
      nodes[i + 1] = 0.7 * y + 0.2 * z + 0.15 * Math.sin(3 * x);
      nodes[i + 2] = z - 0.35 * x + 0.1 * Math.cos(2 * y);
    }
    const out = new Float64Array(6);
    const tan = new Float64Array(4);
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexFrame(p, v, nodes, out, tan);
        const nl = Math.hypot(out[3]!, out[4]!, out[5]!);
        expect(Math.abs(nl - 1)).toBeLessThan(1e-9);
        expect(Math.abs(Math.hypot(tan[0]!, tan[1]!, tan[2]!) - 1)).toBeLessThan(1e-9);
        // Rest normal ⟂ rest tangent (≤ f32 rounding) and the frame is orthonormal.
        expect(Math.abs(out[3]! * tan[0]! + out[4]! * tan[1]! + out[5]! * tan[2]!)).toBeLessThan(1e-6);
        expect(Number.isFinite(out[0]! + out[1]! + out[2]!)).toBe(true);
      }
    }
  });

  it('seams stay welded under deformation (bit-equal rest → bit-equal deformed)', () => {
    const src = restNodes();
    const nodes = src.map((v, i) => v + 0.2 * Math.sin(i * 1.7) * Math.cos(i * 0.31));
    const out = new Float64Array(6);
    for (const p of binding.panels) {
      const seen = new Map<string, [number, number, number]>();
      let dup = 0;
      for (let v = 0; v < p.vertexCount; v++) {
        const key = `${p.restPosition[3 * v]},${p.restPosition[3 * v + 1]},${p.restPosition[3 * v + 2]}`;
        evalFlexVertex(p, v, nodes, out);
        const prev = seen.get(key);
        if (prev) {
          dup++;
          expect([out[0], out[1], out[2]]).toEqual(prev);
        } else seen.set(key, [out[0]!, out[1]!, out[2]!]);
      }
      if (p.panelId === 'shell') expect(dup).toBeGreaterThan(100);
    }
  });

  it('collapsed, exploded and NaN triads never produce NaN (clamp to R)', () => {
    const p = binding.panels[0]!;
    const out = new Float64Array(6);
    const tan = new Float64Array(4);
    for (let v = 0; v < p.vertexCount; v += 37) {
      const [r, x, y] = [p.triad[3 * v]!, p.triad[3 * v + 1]!, p.triad[3 * v + 2]!];
      // Collapse: all three nodes at one point.
      const nodes = restNodes();
      for (const i of [x, y]) for (let k = 0; k < 3; k++) nodes[3 * i + k] = nodes[3 * r + k]!;
      evalFlexFrame(p, v, nodes, out, tan);
      expect(Array.from(out).every(Number.isFinite)).toBe(true);
      expect(Array.from(tan).every(Number.isFinite)).toBe(true);
      expect(Math.hypot(out[3]!, out[4]!, out[5]!)).toBeCloseTo(1, 9);
      // Explosion: X flung 1 km away → vertex clamps onto R.
      const boom = restNodes();
      boom[3 * x] = 1000;
      evalFlexFrame(p, v, boom, out, tan);
      const off = Math.hypot(out[0]! - boom[3 * r]!, out[1]! - boom[3 * r + 1]!, out[2]! - boom[3 * r + 2]!);
      expect(off).toBeLessThanOrEqual(2 * p.coef[4 * v + 3]! + 0.15);
      if (Math.abs(p.coef[4 * v]!) > 1e-3) expect(off).toBe(0);
      expect(Array.from(out).every(Number.isFinite)).toBe(true);
      // NaN node.
      const bad = restNodes();
      bad[3 * y + 1] = NaN;
      evalFlexVertex(p, v, bad, out);
      expect([out[0], out[1], out[2]]).toEqual([bad[3 * r], bad[3 * r + 1], bad[3 * r + 2]]);
    }
  });

  it('is deterministic and hashes the rig', () => {
    const again = bindPanels(subject.compiled, subject.def, subject.geoms);
    for (let i = 0; i < binding.panels.length; i++) {
      expect(again.panels[i]!.triad).toEqual(binding.panels[i]!.triad);
      expect(again.panels[i]!.coef).toEqual(binding.panels[i]!.coef);
    }
    expect(again.rigHash).toBe(binding.rigHash);
    const other = compileRig({ ...structuredCloneRig(), name: 'softCube' });
    other.nodePos[0] = other.nodePos[0]! + 0.001;
    expect(rigHashOf(other)).not.toBe(binding.rigHash);
  });

  it('resolves detach boundary beams (exactly one endpoint in the bind set)', () => {
    const lid = binding.panels[1]!;
    expect(lid.detach).not.toBeNull();
    const beams = lid.detach!.attachBeams;
    expect(beams.length).toBeGreaterThan(0);
    const inSet = new Set(lid.bindNodes);
    for (const b of beams) expect(inSet.has(rig.beamA[b]!) !== inSet.has(rig.beamB[b]!)).toBe(true);
    expect(Array.from(beams)).toEqual(Array.from(boundaryBeams(rig, lid.bindNodes)));
    expect(binding.panels[0]!.detach).toBeNull();
    expect(binding.panels[0]!.castShadow).toBe(true);
    expect(binding.panels[0]!.damageWeight[0]).toBe(1);
  });

  it('bakes the synthetic subject fast', () => {
    const t0 = performance.now();
    bindPanels(subject.compiled, subject.def, subject.geoms);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
  });
});

function structuredCloneRig(): RigDef {
  // Re-derive the cube RigDef from the compiled rig (names + positions are all the hash needs).
  return {
    name: rig.name,
    nodes: rig.nodeIds.map((id, i) => ({ id, pos: [rig.nodePos[3 * i]!, rig.nodePos[3 * i + 1]!, rig.nodePos[3 * i + 2]!], mass: 1 })),
    beams: Array.from({ length: rig.beamCount }, (_, i) => ({ a: rig.nodeIds[rig.beamA[i]!]!, b: rig.nodeIds[rig.beamB[i]!]!, type: 'normal' as const })),
  };
}

/** f32 emulation of the shader (Math.fround after every op that the GPU rounds). */
function evalF32(p: BindingPanel, v: number, nodes: Float32Array, out: Float64Array): void {
  const F = Math.fround;
  const r = p.triad[3 * v]! * 3, x = p.triad[3 * v + 1]! * 3, y = p.triad[3 * v + 2]! * 3;
  const R = [nodes[r]!, nodes[r + 1]!, nodes[r + 2]!];
  const e1 = [0, 1, 2].map((k) => F(nodes[x + k]! - R[k]!));
  const e2 = [0, 1, 2].map((k) => F(nodes[y + k]! - R[k]!));
  const cr = [F(F(e1[1]! * e2[2]!) - F(e1[2]! * e2[1]!)), F(F(e1[2]! * e2[0]!) - F(e1[0]! * e2[2]!)), F(F(e1[0]! * e2[1]!) - F(e1[1]! * e2[0]!))];
  const L = F(Math.sqrt(F(F(cr[0]! * cr[0]!) + F(cr[1]! * cr[1]!) + F(cr[2]! * cr[2]!))));
  const [a, b, c] = [p.coef[4 * v]!, p.coef[4 * v + 1]!, p.coef[4 * v + 2]!];
  for (let k = 0; k < 3; k++) out[k] = F(R[k]! + F(F(F(a * e1[k]!) + F(b * e2[k]!)) + F(c * F(cr[k]! / Math.max(L, 1e-4)))));
}

describe('bindPanels errors and repair', () => {
  const tinyVehicle = (rigDef: RigDef): CompiledVehicle =>
    ({ name: rigDef.name, rig: compileRig(rigDef), frameNodes: Int32Array.of(0, 1, 2) }) as unknown as CompiledVehicle;
  const quad = (z: number): PanelGeometry => ({
    panelId: 'p',
    position: Float32Array.of(0, 0, z, 0.1, 0, z, 0, 0.1, z),
    normal: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    uv: new Float32Array(6),
    tangent: null,
    index: Uint32Array.of(0, 1, 2),
    damageWeight: null,
  });
  const def = (name: string, bind: string[]): VehicleVisualDef => ({
    ...syntheticCubeSubject(1).def,
    vehicle: name,
    panels: [{ id: 'p', kind: 'body', material: 'glass', surface: { type: 'mesh', position: [], index: [] }, bind, detach: null }],
  });

  it('repairs when the nearest candidates are degenerate (collinear cluster)', () => {
    // 10 collinear nodes hugging the panel (nearest 8 are all on one line), 3 good nodes farther out.
    const nodes: RigDef['nodes'] = [];
    for (let i = 0; i < 10; i++) nodes.push({ id: `l${i}`, pos: [-0.25 + 0.06 * i, 0.02, 0], mass: 1 });
    nodes.push({ id: 'g0', pos: [-0.4, -0.4, 0], mass: 1 }, { id: 'g1', pos: [0.5, -0.4, 0], mass: 1 }, { id: 'g2', pos: [0, 0.6, 0], mass: 1 });
    const v = tinyVehicle({ name: 'rep', nodes, beams: [{ a: 'l0', b: 'g0', type: 'normal' }] });
    const b = bindPanels(v, def('rep', ['*']), [quad(0.01)]);
    expect(b.stats.repaired).toBeGreaterThan(0);
    const out = new Float64Array(6);
    evalFlexVertex(b.panels[0]!, 1, v.rig.nodePos, out);
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(b.panels[0]!.castShadow).toBe(false);
    expect(b.panels[0]!.damageWeight[0]).toBe(0);
  });

  it('throws BindError when nothing in the bind set is acceptable (never binds outside it)', () => {
    const nodes: RigDef['nodes'] = [];
    for (let i = 0; i < 10; i++) nodes.push({ id: `l${i}`, pos: [-0.25 + 0.06 * i, 0.02, 0], mass: 1 });
    nodes.push({ id: 'g0', pos: [-0.4, -0.4, 0], mass: 1 }, { id: 'g1', pos: [0.5, -0.4, 0], mass: 1 });
    const v = tinyVehicle({ name: 'bad', nodes, beams: [{ a: 'l0', b: 'g0', type: 'normal' }] });
    expect(() => bindPanels(v, def('bad', ['l*']), [quad(0.01)])).toThrow(BindError);
  });

  it('rejects mismatched names, unknown selectors and unknown beam pairs', () => {
    expect(() => bindPanels(subject.compiled, { ...subject.def, vehicle: 'other' }, subject.geoms)).toThrow(/softCube/);
    const bad = { ...subject.def, panels: [{ ...subject.def.panels[0]!, bind: ['nope_*'] }, subject.def.panels[1]!] };
    expect(() => bindPanels(subject.compiled, bad, subject.geoms)).toThrow(BindError);
    expect(() => resolveBeamSelector(rig, { pairs: [['n0_0_0', 'n3_3_3']] }, 't')).toThrow(BindError);
    const pair = resolveBeamSelector(rig, { pairs: [['n0_0_0', 'n1_0_0']] }, 't');
    expect(pair.length).toBe(1);
    const between = resolveBeamSelector(rig, { between: [['n*_3_*'], ['n*_2_*']] }, 't');
    expect(between.length).toBeGreaterThan(16);
  });
});
