import { describe, expect, it } from 'vitest';

import { compileRig } from '../../sim/rig/builder';
import type { RigDef } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import { bindPanels, boundaryBeams, evalFlexFrame, evalFlexVertex, rigHashOf, resolveBeamSelector } from './binder';
import { syntheticCubeSubject } from './synthetic';
import {
  BindError,
  FLEX_AGREE_FLOOR,
  FLEX_CONSENSUS,
  FLEX_CROSS_FLOOR,
  FLEX_HEALTHY_SLACK,
  FLEX_HEALTHY_STRETCH,
  FLEX_MAX_AB,
  FLEX_MAX_ABS_C,
  FLEX_MAX_EDGE,
  FLEX_MAX_EDGE_RATIO,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEX_MIN_ANGLE_DEG,
  FLEX_MIN_EDGE,
  FLEX_QUALITY_FLOOR,
  FLEX_SIN_FLOOR,
  FLEX_TRIADS,
  type BindingPanel,
  type PanelGeometry,
  type VehicleVisualDef,
} from './types';

const K = FLEX_TRIADS;

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

  it('every bound triad satisfies the acceptance rules; weights are normalized, descending and spread', () => {
    const pos = rig.nodePos;
    let multi = 0;
    let bound = 0;
    for (const p of binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        let sum = 0;
        let used = 0;
        for (let k = 0; k < K; k++) {
          const s = K * v + k;
          const w = p.weight[s]!;
          expect(w).toBeGreaterThanOrEqual(0);
          if (k > 0) expect(w).toBeLessThanOrEqual(p.weight[s - 1]! + 1e-7);
          sum += w;
          if (w > 0) used++;
          const [r, x, y] = [p.triad[3 * s]!, p.triad[3 * s + 1]!, p.triad[3 * s + 2]!];
          expect(x).toBeLessThan(y);
          expect(r !== x && r !== y).toBe(true);
          const e1 = [0, 1, 2].map((c) => pos[3 * x + c]! - pos[3 * r + c]!);
          const e2 = [0, 1, 2].map((c) => pos[3 * y + c]! - pos[3 * r + c]!);
          const l1 = Math.hypot(...e1);
          const l2 = Math.hypot(...e2);
          expect(Math.min(l1, l2)).toBeGreaterThanOrEqual(FLEX_MIN_EDGE);
          expect(Math.max(l1, l2)).toBeLessThanOrEqual(FLEX_MAX_EDGE);
          expect(Math.max(l1, l2) / Math.min(l1, l2)).toBeLessThanOrEqual(FLEX_MAX_EDGE_RATIO);
          const ang = (Math.acos((e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!) / (l1 * l2)) * 180) / Math.PI;
          expect(ang).toBeGreaterThanOrEqual(FLEX_MIN_ANGLE_DEG - 1e-9);
          expect(ang).toBeLessThanOrEqual(180 - FLEX_MIN_ANGLE_DEG + 1e-9);
          expect(Math.abs(p.coef[4 * s]!)).toBeLessThanOrEqual(FLEX_MAX_AB);
          expect(Math.abs(p.coef[4 * s + 1]!)).toBeLessThanOrEqual(FLEX_MAX_AB);
          expect(Math.abs(p.coef[4 * s + 2]!)).toBeLessThanOrEqual(FLEX_MAX_ABS_C);
        }
        expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
        bound++;
        if (used > 1) multi++;
      }
    }
    // Blending is the norm, not the exception.
    expect(multi / bound).toBeGreaterThan(0.9);
    expect(binding.stats.meanTriads).toBeGreaterThan(2);
    expect(binding.stats.poolTriads).toBeGreaterThan(100);
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

  it('collapsed, exploded and NaN triads never produce NaN or spikes', () => {
    const p = binding.panels[0]!;
    const out = new Float64Array(6);
    const tan = new Float64Array(4);
    /** A vertex never leaves the box around its triads' (current) R nodes, grown by the clamp. */
    const inHull = (v: number, nodes: Float64Array, q: ArrayLike<number>): boolean => {
      let lim = 0;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < K; k++) {
        const s = K * v + k;
        lim = Math.max(lim, FLEX_MAX_STRETCH * p.coef[4 * s + 3]! + FLEX_MAX_SLACK);
        const r = p.triad[3 * s]!;
        for (let c = 0; c < 3; c++) {
          const x = Number.isFinite(nodes[3 * r + c]!) ? nodes[3 * r + c]! : 0;
          lo[c] = Math.min(lo[c]!, x);
          hi[c] = Math.max(hi[c]!, x);
        }
      }
      return [0, 1, 2].every((c) => q[c]! >= lo[c]! - lim - 1e-9 && q[c]! <= hi[c]! + lim + 1e-9);
    };
    for (let v = 0; v < p.vertexCount; v += 37) {
      // Collapse: every node of every triad of v onto one point.
      const nodes = restNodes();
      const r0 = p.triad[3 * K * v]!;
      for (let k = 0; k < 3 * K; k++) {
        const i = p.triad[3 * K * v + k]!;
        for (let c = 0; c < 3; c++) nodes[3 * i + c] = nodes[3 * r0 + c]!;
      }
      evalFlexFrame(p, v, nodes, out, tan);
      expect(Array.from(out).every(Number.isFinite)).toBe(true);
      expect(Array.from(tan).every(Number.isFinite)).toBe(true);
      expect(Math.hypot(out[3]!, out[4]!, out[5]!)).toBeCloseTo(1, 9);
      expect(inHull(v, nodes, out)).toBe(true);
      // Explosion: a node of the primary triad flung 1 km away: offsets are length-limited, never a spike.
      for (let c = 0; c < 3; c++) {
        const boom = restNodes();
        boom[3 * p.triad[3 * K * v + c]!] = 1000;
        evalFlexFrame(p, v, boom, out, tan);
        expect(Array.from(out).every(Number.isFinite)).toBe(true);
        expect(inHull(v, boom, out)).toBe(true);
      }
      // NaN node: finite output.
      const bad = restNodes();
      bad[3 * p.triad[3 * K * v + 2]! + 1] = NaN;
      evalFlexFrame(p, v, bad, out, tan);
      expect(Array.from(out).every(Number.isFinite)).toBe(true);
      expect(inHull(v, bad, out)).toBe(true);
    }
  });

  it('a tearing node moves the vertex continuously (graceful clamp, no snap) and the healthy triads take over', () => {
    const p = binding.panels[0]!;
    const out = new Float64Array(6);
    // A vertex whose triads do not all share the torn node.
    let v = 0;
    let torn = -1;
    for (; v < p.vertexCount; v++) {
      const x0 = p.triad[3 * K * v + 1]!;
      let shared = 0;
      for (let k = 0; k < K; k++) for (let c = 0; c < 3; c++) if (p.triad[3 * (K * v + k) + c] === x0) shared++;
      if (shared === 1 && p.weight[K * v + 1]! > 0.1) {
        torn = x0;
        break;
      }
    }
    expect(torn).toBeGreaterThanOrEqual(0);
    const nodes = restNodes();
    const start = [nodes[3 * torn]!, nodes[3 * torn + 1]!, nodes[3 * torn + 2]!];
    let prev: number[] | null = null;
    let maxStep = 0;
    const STEPS = 400;
    for (let i = 0; i <= STEPS; i++) {
      const t = (4 * i) / STEPS; // 0 → 4 m away
      nodes[3 * torn] = start[0]! + 0.6 * t;
      nodes[3 * torn + 1] = start[1]! + 0.8 * t;
      nodes[3 * torn + 2] = start[2]!;
      evalFlexVertex(p, v, nodes, out);
      if (prev) maxStep = Math.max(maxStep, Math.hypot(out[0]! - prev[0]!, out[1]! - prev[1]!, out[2]! - prev[2]!));
      prev = [out[0]!, out[1]!, out[2]!];
    }
    // 1 cm node steps never make the vertex jump.
    expect(maxStep).toBeLessThan(0.02);
    // Fully torn: the vertex sits with its healthy triads, near its rest place.
    const rest = [p.restPosition[3 * v]!, p.restPosition[3 * v + 1]!, p.restPosition[3 * v + 2]!];
    expect(Math.hypot(prev![0]! - rest[0]!, prev![1]! - rest[1]!, prev![2]! - rest[2]!)).toBeLessThan(0.05);
  });

  it('crush continuity: neighbouring vertices stay together where single triads tear apart (regression)', () => {
    // Synthetic crumple: the cube squashed 35 % along z toward its back face, every node
    // jittered ±7 cm (deterministic hash) — strongly non-affine, like a frontal crush.
    const src = restNodes();
    const nodes = new Float64Array(src.length);
    const hash = (i: number): number => {
      const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      return x - Math.floor(x) - 0.5;
    };
    for (let i = 0; i < src.length; i += 3) {
      const z = src[i + 2]!;
      nodes[i] = src[i]! + 0.14 * hash(i);
      nodes[i + 1] = src[i + 1]! + 0.14 * hash(i + 1);
      nodes[i + 2] = 0.75 - (0.75 - z) * 0.65 + 0.14 * hash(i + 2);
    }
    const single = (p: BindingPanel): BindingPanel => {
      const weight = new Float32Array(p.weight.length);
      for (let v = 0; v < p.vertexCount; v++) weight[K * v] = 1;
      return { ...p, weight };
    };
    const maxJump = (p: BindingPanel): { max: number; p99: number } => {
      const disp = new Float64Array(p.vertexCount * 3);
      const out = new Float64Array(6);
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexVertex(p, v, nodes, out);
        for (let c = 0; c < 3; c++) disp[3 * v + c] = out[c]! - p.restPosition[3 * v + c]!;
      }
      const jumps: number[] = [];
      for (let t = 0; t < p.index.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = p.index[t + e]!;
          const b = p.index[t + ((e + 1) % 3)]!;
          jumps.push(Math.hypot(disp[3 * a]! - disp[3 * b]!, disp[3 * a + 1]! - disp[3 * b + 1]!, disp[3 * a + 2]! - disp[3 * b + 2]!));
        }
      }
      jumps.sort((x, y) => x - y);
      return { max: jumps[jumps.length - 1]!, p99: jumps[Math.floor(jumps.length * 0.99)]! };
    };
    for (const p of binding.panels) {
      const blended = maxJump(p);
      const one = maxJump(single(p));
      console.info(`[crush continuity] ${p.panelId}: blended max ${(blended.max * 100).toFixed(1)} cm p99 ${(blended.p99 * 100).toFixed(1)} cm; single-triad max ${(one.max * 100).toFixed(1)} cm p99 ${(one.p99 * 100).toFixed(1)} cm`);
      // ~6 cm edges in a field whose node-to-node differences reach 20 cm over 50 cm: single
      // triads tear neighbours ~11 cm apart; the continuous K-blend keeps them together.
      expect(blended.max).toBeLessThan(0.08);
      expect(blended.max).toBeLessThan(0.65 * one.max);
      expect(blended.p99).toBeLessThan(0.6 * one.p99);
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

/** f32 emulation of the shader position path (Math.fround after every op that the GPU rounds). */
function evalF32(p: BindingPanel, v: number, nodes: Float32Array, out: Float64Array): void {
  const F = Math.fround;
  const len = (a: number[]): number => F(Math.sqrt(F(F(F(a[0]! * a[0]!) + F(a[1]! * a[1]!)) + F(a[2]! * a[2]!))));
  const smooth = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, F(F(x - e0) / F(e1 - e0))));
    return F(F(t * t) * F(3 - 2 * t));
  };
  const P: number[][] = [];
  const W: number[] = [];
  for (let k = 0; k < K; k++) {
    const s = K * v + k;
    const r = p.triad[3 * s]! * 3, x = p.triad[3 * s + 1]! * 3, y = p.triad[3 * s + 2]! * 3;
    const R = [nodes[r]!, nodes[r + 1]!, nodes[r + 2]!];
    const e1 = [0, 1, 2].map((c) => F(nodes[x + c]! - R[c]!));
    const e2 = [0, 1, 2].map((c) => F(nodes[y + c]! - R[c]!));
    const cr = [F(F(e1[1]! * e2[2]!) - F(e1[2]! * e2[1]!)), F(F(e1[2]! * e2[0]!) - F(e1[0]! * e2[2]!)), F(F(e1[0]! * e2[1]!) - F(e1[1]! * e2[0]!))];
    const L = len(cr);
    const m = Math.max(F(len(e1) * len(e2)), FLEX_CROSS_FLOOR);
    const den = Math.max(L, F(FLEX_SIN_FLOOR * m));
    const [a, b, c, d0] = [p.coef[4 * s]!, p.coef[4 * s + 1]!, p.coef[4 * s + 2]!, p.coef[4 * s + 3]!];
    const o = [0, 1, 2].map((i) => F(F(F(a * e1[i]!) + F(b * e2[i]!)) + F(c * F(cr[i]! / den))));
    const lo = len(o);
    const lim = F(F(FLEX_MAX_STRETCH * d0) + FLEX_MAX_SLACK);
    let q = 0;
    if (lo <= lim) q = F((1 - smooth(F(F(FLEX_HEALTHY_STRETCH * d0) + FLEX_HEALTHY_SLACK), lim, lo)) * smooth(0.5 * FLEX_SIN_FLOOR, 2 * FLEX_SIN_FLOOR, F(L / m)));
    else for (let i = 0; i < 3; i++) o[i] = F(o[i]! * F(lim / lo));
    P.push([0, 1, 2].map((i) => F(R[i]! + o[i]!)));
    W.push(F(p.weight[s]! * Math.max(q, FLEX_QUALITY_FLOOR)));
  }
  const sw = F(F(W[0]! + W[1]!) + W[2]!);
  const pm = [0, 1, 2].map((i) => F(F(F(F(W[0]! * P[0]![i]!) + F(W[1]! * P[1]![i]!)) + F(W[2]! * P[2]![i]!)) / sw));
  const C = P.map((q, k) => {
    const d = [0, 1, 2].map((i) => F(q[i]! - pm[i]!));
    return F(W[k]! / F(1 + F(F(F(F(d[0]! * d[0]!) + F(d[1]! * d[1]!)) + F(d[2]! * d[2]!)) * F(1 / (FLEX_CONSENSUS * FLEX_CONSENSUS)))));
  });
  const sc = F(F(C[0]! + C[1]!) + C[2]!);
  for (let i = 0; i < 3; i++) out[i] = F(F(F(F(C[0]! * P[0]![i]!) + F(C[1]! * P[1]![i]!)) + F(C[2]! * P[2]![i]!)) / sc);
}
void FLEX_AGREE_FLOOR;

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

  it('repairs when every node neighbourhood is degenerate (two collinear rows)', () => {
    // Two parallel rows of 12 collinear nodes 1.2 m apart: each node's 10 nearest are its own row
    // (no valid triangle in the first pool), the 16-node neighbourhood reaches across.
    const nodes: RigDef['nodes'] = [];
    for (let i = 0; i < 12; i++) nodes.push({ id: `a${i}`, pos: [-0.3 + 0.06 * i, -0.6, 0], mass: 1 });
    for (let i = 0; i < 12; i++) nodes.push({ id: `b${i}`, pos: [-0.3 + 0.06 * i, 0.6, 0], mass: 1 });
    const v = tinyVehicle({ name: 'rep', nodes, beams: [{ a: 'a0', b: 'b0', type: 'normal' }] });
    const b = bindPanels(v, def('rep', ['*']), [quad(0.01)]);
    expect(b.stats.repaired).toBe(3);
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
