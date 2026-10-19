/**
 * CHAIN BINDING for slender truss members (sign post, light pole shaft).
 *
 * The post rigs are triangular trusses: 3 nodes per level, levels 0.7–1.4 m
 * apart, triangle edges ≈ 0.1 m. The generic binder's static triad rules
 * (edge ratio ≤ 6, |c| ≤ 0.3) reject every triad of such a member, so these
 * panels are bound here with the SAME BindingPanel layout and v2 math
 * (render/vehicle/types.ts "FLEXBODY RECONSTRUCTION v2"): per vertex the
 * three FACE triads of its bay, R = L_j[k], X = L_j[k+1], Y = L_{j+1}[k]
 * (one horizontal edge, one vertical rail), coefficients solved at rest in
 * f64 (c = (P − R)·n̂, a, b from the 2 × 2 Gram system, d0 = |P − R|),
 * weights by the angle between the vertex and each face (smooth around the
 * shaft). Under bending the faces turn with their rails, so the shaft bends
 * where the truss bends; the shader and the CPU mirror (evalFlexVertex) are
 * unchanged.
 */
import { FLEX_TRIADS, type BindingPanel, type PanelDef, type PanelGeometry } from '../vehicle/types';
import { resolveNodeSelector } from '../vehicle/binder';
import type { CompiledRig } from '../../sim/rig/types';

const K = FLEX_TRIADS;

/** Resolve `${prefix}${level}_${k}` triples (k = 0..2) bottom → top. */
export function chainLevels(rig: CompiledRig, prefix: string, count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let l = 0; l < count; l++) {
    const t = [0, 1, 2].map((k) => rig.nodeIds.indexOf(`${prefix}${l}_${k}`));
    if (t.some((i) => i < 0)) throw new Error(`chain: rig '${rig.name}' lacks ${prefix}${l}_*`);
    out.push(t as [number, number, number]);
  }
  return out;
}

/** Number of `${prefix}${l}_0` levels present in the rig. */
export function countLevels(rig: CompiledRig, prefix: string): number {
  let l = 0;
  while (rig.nodeIds.indexOf(`${prefix}${l}_0`) >= 0) l++;
  return l;
}

interface Vec {
  x: number;
  y: number;
  z: number;
}
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: Vec): number => Math.sqrt(dot(a, a));
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export function bindChainPanel<S extends string>(
  rig: CompiledRig,
  pdef: PanelDef<S>,
  geom: PanelGeometry,
  panelIndex: number,
  levels: readonly (readonly [number, number, number])[],
  damageWeight: number,
): BindingPanel<S> {
  if (levels.length < 2) throw new Error(`chain panel '${pdef.id}': needs ≥ 2 levels`);
  const np = rig.nodePos;
  const node = (i: number): Vec => ({ x: np[3 * i]!, y: np[3 * i + 1]!, z: np[3 * i + 2]! });
  const centres = levels.map((t) => {
    const a = node(t[0]), b = node(t[1]), c = node(t[2]);
    return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
  });
  const n = geom.position.length / 3;
  const triad = new Uint16Array(n * K * 3);
  const coef = new Float32Array(n * K * 4);
  const weight = new Float32Array(n * K);
  const frameNormal = new Float32Array(n * K * 3);
  const frameTangent = geom.tangent ? new Float32Array(n * K * 3) : null;
  const used = new Set<number>();
  const slots: { t: [number, number, number]; w: number; a: number; b: number; c: number; d0: number; F: Vec[] }[] = [];
  for (let v = 0; v < n; v++) {
    const P: Vec = { x: geom.position[3 * v]!, y: geom.position[3 * v + 1]!, z: geom.position[3 * v + 2]! };
    let j = 0;
    while (j + 2 < levels.length && centres[j + 1]!.y <= P.y) j++;
    const L0 = levels[j]!;
    const L1 = levels[j + 1]!;
    const c0 = centres[j]!;
    const c1 = centres[j + 1]!;
    // axis point at the vertex height (linear between the bay's level centroids)
    const t = Math.min(1.5, Math.max(-0.5, (P.y - c0.y) / (c1.y - c0.y || 1)));
    const axis: Vec = { x: c0.x + (c1.x - c0.x) * t, y: P.y, z: c0.z + (c1.z - c0.z) * t };
    const dv = sub(P, axis);
    dv.y = 0;
    const dl = len(dv);
    slots.length = 0;
    let wsum = 0;
    for (let k = 0; k < 3; k++) {
      const iR = L0[k]!, iX = L0[(k + 1) % 3]!, iY = L1[k]!;
      const R = node(iR), X = node(iX), Y = node(iY);
      const e1 = sub(X, R);
      const e2 = sub(Y, R);
      const cr = cross(e1, e2);
      const nh = scale(cr, 1 / len(cr));
      const d = sub(P, R);
      const c = dot(d, nh);
      const dp = sub(d, scale(nh, c));
      const g11 = dot(e1, e1), g12 = dot(e1, e2), g22 = dot(e2, e2);
      const r1 = dot(dp, e1), r2 = dot(dp, e2);
      const det = g11 * g22 - g12 * g12;
      const a = (r1 * g22 - r2 * g12) / det;
      const b = (r2 * g11 - r1 * g12) / det;
      // face direction: from the level centroid to the face's horizontal edge midpoint
      const fm = sub({ x: (R.x + X.x) / 2, y: 0, z: (R.z + X.z) / 2 }, { x: c0.x, y: 0, z: c0.z });
      const fl = len(fm) || 1;
      const cosA = dl > 1e-6 ? dot(fm, dv) / (fl * dl) : 0.5;
      const w = Math.pow(Math.max(0, cosA + 0.55), 2) + 1e-4;
      wsum += w;
      // rest GS frame
      const f1 = scale(e1, 1 / len(e1));
      const tt = sub(e2, scale(f1, dot(e2, f1)));
      const f2 = scale(tt, 1 / len(tt));
      const f3 = cross(f1, f2);
      slots.push({ t: [iR, iX, iY], w, a, b, c, d0: len(d), F: [f1, f2, f3] });
      used.add(iR).add(iX).add(iY);
    }
    slots.sort((p, q) => q.w - p.w);
    const N: Vec = { x: geom.normal[3 * v]!, y: geom.normal[3 * v + 1]!, z: geom.normal[3 * v + 2]! };
    const T: Vec | null = geom.tangent ? { x: geom.tangent[4 * v]!, y: geom.tangent[4 * v + 1]!, z: geom.tangent[4 * v + 2]! } : null;
    for (let k = 0; k < K; k++) {
      const s = slots[k]!;
      const o = K * v + k;
      triad.set(s.t, 3 * o);
      coef.set([s.a, s.b, s.c, s.d0], 4 * o);
      weight[o] = s.w / wsum;
      const [f1, f2, f3] = s.F as [Vec, Vec, Vec];
      frameNormal.set([dot(N, f1), dot(N, f2), dot(N, f3)], 3 * o);
      if (frameTangent && T) frameTangent.set([dot(T, f1), dot(T, f2), dot(T, f3)], 3 * o);
    }
  }
  const bind = resolveNodeSelector(rig, pdef.bind, `chain panel '${pdef.id}'`);
  let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < n; v++) {
    cx += geom.position[3 * v]!;
    cy += geom.position[3 * v + 1]!;
    cz += geom.position[3 * v + 2]!;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let r2 = 0;
  for (let v = 0; v < n; v++) {
    const dx = geom.position[3 * v]! - cx, dy = geom.position[3 * v + 1]! - cy, dz = geom.position[3 * v + 2]! - cz;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return {
    panelId: pdef.id,
    panelIndex,
    kind: pdef.kind,
    material: pdef.material,
    vertexCount: n,
    restPosition: geom.position,
    restNormal: geom.normal,
    restTangent: geom.tangent,
    uv: geom.uv,
    index: geom.index,
    triad,
    coef,
    weight,
    frameNormal,
    frameTangent,
    damageWeight: geom.damageWeight ?? new Float32Array(n).fill(damageWeight),
    nodes: Uint16Array.from([...used].sort((p, q) => p - q)),
    bindNodes: bind,
    restCenter: [cx, cy, cz],
    restRadius: Math.sqrt(r2),
    detach: null,
    glass: null,
    lights: [],
    castShadow: pdef.castShadow ?? true,
  };
}
