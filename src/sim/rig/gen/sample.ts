/**
 * R-RIG skin sampler (pure; generator numerics, not a hot loop): a render
 * panel's triangle mesh → a node grid on its OUTER sheet at a target pitch.
 *
 * The render panels are lofted sheets with metric-ish (u, v) parameters
 * (render/vehicle/types.ts LoftSurface: u across, v along the car), cut to
 * shape, with an inner shell + rolled flanges when they have thickness. So:
 *  1. keep the triangles that face OUT of the car (geometric normal against
 *     the gradient of a super-ellipsoid fitted to the body: the inner shell
 *     and the flanges face away from it);
 *  2. lay a regular grid in (u, v) whose spacing is the pitch divided by the
 *     sheet's mean metric scale per direction (|∂p/∂u|, |∂p/∂v|);
 *  3. every grid point inside the outer sheet's uv footprint becomes a node
 *     at its barycentric 3D position; a point just outside (≤ half a cell)
 *     is snapped onto the nearest outer triangle (the sheet's boundary stays
 *     sharp: hems and shut lines are where the seams go). A uv point that
 *     covers several sheets (a mirrored half, a fold) yields one node per
 *     sheet;
 *  4. grid neighbours closer than 1.8 pitches in 3D are connected; cells
 *     with 4 connected corners are quads, with 3 triangles.
 * Deterministic (fixed iteration order, no RNG), allocation-heavy (offline).
 */
import type { SkinPanelData } from './types';

export interface SampleMesh {
  position: ArrayLike<number>;
  normal: ArrayLike<number>;
  uv: ArrayLike<number>;
  index: ArrayLike<number>;
}

/** Body envelope (super-ellipsoid) used to tell the outer sheet from the inner shell. */
export interface BodyEnvelope {
  center: [number, number, number];
  half: [number, number, number];
}

export interface SampleOptions {
  pitch: number;
  envelope: BodyEnvelope;
  /** Minimum cos between a triangle's normal and the envelope's outward direction. Default 0.15. */
  minOutward?: number;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;

/** Outward direction of the envelope at p (gradient of Σ|d_k/h_k|^4). */
export function envelopeOutward(env: BodyEnvelope, p: readonly number[]): [number, number, number] {
  const g: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const d = (p[k]! - env.center[k]!) / env.half[k]!;
    g[k] = (d * d * d) / env.half[k]!;
  }
  const l = Math.hypot(g[0], g[1], g[2]) || 1;
  return [g[0] / l, g[1] / l, g[2] / l];
}

/** Envelope from a set of positions (axis-aligned bounds). */
export function envelopeOf(points: ArrayLike<number>): BodyEnvelope {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, points[i + k]!);
      hi[k] = Math.max(hi[k]!, points[i + k]!);
    }
  }
  return {
    center: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2],
    half: [(hi[0]! - lo[0]!) / 2, (hi[1]! - lo[1]!) / 2, (hi[2]! - lo[2]!) / 2],
  };
}

interface Tri {
  i: [number, number, number];
  /** uv of the corners. */
  uv: [number, number, number, number, number, number];
}

/** Samples one panel's outer sheet; returns null when the panel has no outer sheet at this pitch. */
export function sampleSkin(
  mesh: SampleMesh,
  meta: { id: string; kind: string; material: string; attach: string[] },
  opts: SampleOptions,
): SkinPanelData | null {
  const P = mesh.position;
  const N = mesh.normal;
  const UV = mesh.uv;
  const idx = mesh.index;
  const h = opts.pitch;
  const minOut = opts.minOutward ?? 0.15;
  const pt = (i: number): [number, number, number] => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];

  // 1. outer triangles + metric scales
  const tris: Tri[] = [];
  let su = 0;
  let sv = 0;
  let wsum = 0;
  let area = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    const pa = pt(a);
    const pb = pt(b);
    const pc = pt(c);
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const ar = Math.hypot(cr[0]!, cr[1]!, cr[2]!);
    if (!(ar > 1e-12)) continue;
    const cen = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    const out = envelopeOutward(opts.envelope, cen);
    const cosOut = (cr[0]! * out[0] + cr[1]! * out[1] + cr[2]! * out[2]) / ar;
    if (cosOut < minOut) continue;
    // vertex normals must agree with the winding (excludes folded flanges)
    let vn = 0;
    for (const v of [a, b, c]) vn += (N[3 * v]! * cr[0]! + N[3 * v + 1]! * cr[1]! + N[3 * v + 2]! * cr[2]!) / ar;
    if (vn < 1.5) continue;
    const uv: Tri['uv'] = [UV[2 * a]!, UV[2 * a + 1]!, UV[2 * b]!, UV[2 * b + 1]!, UV[2 * c]!, UV[2 * c + 1]!];
    const du1 = uv[2] - uv[0];
    const dv1 = uv[3] - uv[1];
    const du2 = uv[4] - uv[0];
    const dv2 = uv[5] - uv[1];
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-14)) continue;
    // Jacobian columns ∂p/∂u, ∂p/∂v
    const pu = [0, 1, 2].map((k) => (e1[k]! * dv2 - e2[k]! * dv1) / det);
    const pv = [0, 1, 2].map((k) => (e2[k]! * du1 - e1[k]! * du2) / det);
    const w = ar / 2;
    su += w * Math.hypot(pu[0]!, pu[1]!, pu[2]!);
    sv += w * Math.hypot(pv[0]!, pv[1]!, pv[2]!);
    wsum += w;
    area += w;
    tris.push({ i: [a, b, c], uv });
  }
  if (tris.length === 0 || !(wsum > 0)) return null;
  su /= wsum;
  sv /= wsum;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      u0 = Math.min(u0, t.uv[2 * k]!);
      u1 = Math.max(u1, t.uv[2 * k]!);
      v0 = Math.min(v0, t.uv[2 * k + 1]!);
      v1 = Math.max(v1, t.uv[2 * k + 1]!);
    }
  }
  const nu = Math.max(1, Math.round(((u1 - u0) * su) / h));
  const nv = Math.max(1, Math.round(((v1 - v0) * sv) / h));
  const hu = (u1 - u0) / nu;
  const hv = (v1 - v0) / nv;

  // uv bucket grid over the outer triangles
  const BU = Math.max(1, Math.min(256, nu * 2));
  const BV = Math.max(1, Math.min(256, nv * 2));
  const bucket: number[][] = Array.from({ length: BU * BV }, () => []);
  const bu = (u: number): number => Math.min(BU - 1, Math.max(0, Math.floor(((u - u0) / (u1 - u0 || 1)) * BU)));
  const bv = (v: number): number => Math.min(BV - 1, Math.max(0, Math.floor(((v - v0) / (v1 - v0 || 1)) * BV)));
  tris.forEach((t, k) => {
    const us = [t.uv[0], t.uv[2], t.uv[4]];
    const vs = [t.uv[1], t.uv[3], t.uv[5]];
    for (let x = bu(Math.min(...us)); x <= bu(Math.max(...us)); x++)
      for (let y = bv(Math.min(...vs)); y <= bv(Math.max(...vs)); y++) bucket[y * BU + x]!.push(k);
  });

  const bary = (t: Tri, u: number, v: number): [number, number, number] => {
    const [ua, va, ub, vb, uc, vc] = t.uv;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    const l1 = ((u - ua) * (vc - va) - (uc - ua) * (v - va)) / det;
    const l2 = ((ub - ua) * (v - va) - (u - ua) * (vb - va)) / det;
    return [1 - l1 - l2, l1, l2];
  };
  const at = (t: Tri, l: readonly number[]): { p: number[]; n: number[] } => {
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = t.i[k]!;
      for (let d = 0; d < 3; d++) {
        p[d]! += l[k]! * P[3 * v + d]!;
        n[d]! += l[k]! * N[3 * v + d]!;
      }
    }
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    return { p, n: n.map((c) => c / nl) };
  };
  /** Closest point of triangle t to (u, v) in uv (barycentric, clamped to the triangle). */
  const closest = (t: Tri, u: number, v: number): { l: [number, number, number]; d: number } => {
    const l = bary(t, u, v);
    if (l[0] >= 0 && l[1] >= 0 && l[2] >= 0) return { l, d: 0 };
    let best = { l: [1, 0, 0] as [number, number, number], d: Infinity };
    const c = [
      [t.uv[0], t.uv[1]],
      [t.uv[2], t.uv[3]],
      [t.uv[4], t.uv[5]],
    ];
    for (let e = 0; e < 3; e++) {
      const a = c[e]!;
      const b = c[(e + 1) % 3]!;
      const ex = b[0]! - a[0]!;
      const ey = b[1]! - a[1]!;
      // distance in metric units (scale u, v by su, sv)
      const L2 = (ex * su) ** 2 + (ey * sv) ** 2;
      let s = L2 > 0 ? (((u - a[0]!) * ex * su * su + (v - a[1]!) * ey * sv * sv) / L2) : 0;
      s = Math.min(1, Math.max(0, s));
      const qx = a[0]! + s * ex;
      const qy = a[1]! + s * ey;
      const d = Math.hypot((u - qx) * su, (v - qy) * sv);
      if (d < best.d) {
        const l: [number, number, number] = [0, 0, 0];
        l[e] = 1 - s;
        l[(e + 1) % 3] = s;
        best = { l, d };
      }
    }
    return best;
  };

  // 2–3. grid nodes (one per sheet covering the point)
  interface GNode {
    i: number;
    j: number;
    p: number[];
    n: number[];
    snapped: boolean;
  }
  const nodes: GNode[] = [];
  const at2 = new Map<number, number[]>(); // key i*(nv+1)+j → node indices
  const key = (i: number, j: number): number => i * (nv + 1) + j;
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const u = u0 + i * hu;
      const v = v0 + j * hv;
      const cand = bucket[bv(v) * BU + bu(u)]!;
      const hits: { p: number[]; n: number[] }[] = [];
      for (const k of cand) {
        const t = tris[k]!;
        const l = bary(t, u, v);
        if (l[0] >= -1e-9 && l[1] >= -1e-9 && l[2] >= -1e-9) hits.push(at(t, l));
      }
      let snapped = false;
      if (hits.length === 0) {
        // nearest outer triangle within half a cell (metric), searched over the neighbouring buckets
        let best: { t: Tri; l: [number, number, number]; d: number } | null = null;
        const x0 = bu(u - hu);
        const x1 = bu(u + hu);
        const y0 = bv(v - hv);
        const y1 = bv(v + hv);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++)
            for (const k of bucket[y * BU + x]!) {
              const c = closest(tris[k]!, u, v);
              if (best === null || c.d < best.d - 1e-12) best = { t: tris[k]!, l: c.l, d: c.d };
            }
        if (best !== null && best.d <= 0.5 * h) {
          hits.push(at(best.t, best.l));
          snapped = true;
        }
      }
      // one node per distinct sheet
      const kept: number[] = [];
      for (const hit of hits) {
        if (kept.some((q) => Math.hypot(nodes[q]!.p[0]! - hit.p[0]!, nodes[q]!.p[1]! - hit.p[1]!, nodes[q]!.p[2]! - hit.p[2]!) < 0.5 * h)) continue;
        kept.push(nodes.length);
        nodes.push({ i, j, p: hit.p, n: hit.n, snapped });
      }
      if (kept.length > 0) at2.set(key(i, j), kept);
    }
  }
  if (nodes.length < 3) return null;

  // 4. merge near-coincident nodes (snapped boundary duplicates)
  const parent = nodes.map((_, k) => k);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let a = 0; a < nodes.length; a++) {
    const na = nodes[a]!;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const list = at2.get(key(na.i + di, na.j + dj));
        if (!list) continue;
        for (const b of list) {
          if (b <= a) continue;
          const nb = nodes[b]!;
          if (Math.hypot(na.p[0]! - nb.p[0]!, na.p[1]! - nb.p[1]!, na.p[2]! - nb.p[2]!) < 0.3 * h) {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
          }
        }
      }
  }
  const remap = new Int32Array(nodes.length).fill(-1);
  const out: GNode[] = [];
  for (let k = 0; k < nodes.length; k++) {
    const r = find(k);
    if (remap[r] === -1) {
      remap[r] = out.length;
      out.push(nodes[r]!);
    }
    remap[k] = remap[r]!;
  }
  for (const [k, list] of at2) at2.set(k, [...new Set(list.map((q) => remap[q]!))]);

  const dist = (a: number, b: number): number =>
    Math.hypot(out[a]!.p[0]! - out[b]!.p[0]!, out[a]!.p[1]! - out[b]!.p[1]!, out[a]!.p[2]! - out[b]!.p[2]!);
  const linked = (a: number, b: number): boolean => a !== b && dist(a, b) < 1.8 * h;
  const pick = (list: number[] | undefined, from: number): number => {
    if (!list) return -1;
    let best = -1;
    let bd = Infinity;
    for (const q of list) {
      if (!linked(from, q)) continue;
      const d = dist(from, q);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  };

  // 5. cells
  const triOut: number[] = [];
  const quadOut: number[] = [];
  const seenCell = new Set<string>();
  const outwardOf = (a: number): number[] => out[a]!.n;
  const ccw = (a: number, b: number, c: number): boolean => {
    const pa = out[a]!.p;
    const pb = out[b]!.p;
    const pc = out[c]!.p;
    const e1 = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
    const e2 = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const n = outwardOf(a);
    return cr[0]! * n[0]! + cr[1]! * n[1]! + cr[2]! * n[2]! > 0;
  };
  const pushTri = (a: number, b: number, c: number): void => {
    const k = [a, b, c].sort((x, y) => x - y).join(',');
    if (seenCell.has(k)) return;
    seenCell.add(k);
    if (ccw(a, b, c)) triOut.push(a, b, c);
    else triOut.push(a, c, b);
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const l00 = at2.get(key(i, j)) ?? [];
      for (const a of l00) {
        const b = pick(at2.get(key(i + 1, j)), a);
        const d = pick(at2.get(key(i, j + 1)), a);
        let c = -1;
        if (b >= 0) c = pick(at2.get(key(i + 1, j + 1)), b);
        else if (d >= 0) c = pick(at2.get(key(i + 1, j + 1)), d);
        if (b >= 0 && c >= 0 && d >= 0 && linked(c, d) && linked(a, c)) {
          const k = [a, b, c, d].sort((x, y) => x - y).join(',');
          if (seenCell.has(k)) continue;
          seenCell.add(k);
          // quad a b c d split along a–c; CCW from outside
          if (ccw(a, b, c)) {
            triOut.push(a, b, c, a, c, d);
            quadOut.push(a, b, c, d);
          } else {
            triOut.push(a, c, b, a, d, c);
            quadOut.push(a, d, c, b);
          }
        } else {
          const corners = [a, b, c, d].filter((q) => q >= 0);
          if (corners.length === 3 && linked(corners[0]!, corners[1]!) && linked(corners[1]!, corners[2]!) && linked(corners[0]!, corners[2]!)) pushTri(corners[0]!, corners[1]!, corners[2]!);
        }
      }
      // the lower-right triangle when (i, j) itself is missing
      if (l00.length === 0) {
        for (const b of at2.get(key(i + 1, j)) ?? []) {
          const c = pick(at2.get(key(i + 1, j + 1)), b);
          const d = c >= 0 ? pick(at2.get(key(i, j + 1)), c) : -1;
          if (c >= 0 && d >= 0 && linked(b, d)) pushTri(b, c, d);
        }
      }
    }
  }
  // drop nodes no cell uses
  const used = new Uint8Array(out.length);
  for (const v of triOut) used[v] = 1;
  const re = new Int32Array(out.length).fill(-1);
  const fin: GNode[] = [];
  out.forEach((n, k) => {
    if (used[k]) {
      re[k] = fin.length;
      fin.push(n);
    }
  });
  if (fin.length < 3) return null;
  const tr = triOut.map((v) => re[v]!);
  const qu = quadOut.map((v) => re[v]!);
  // boundary: an edge used by one triangle (quad diagonals are interior)
  const edgeUse = new Map<string, number>();
  for (let t = 0; t < tr.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tr[t + e]!;
      const b = tr[t + ((e + 1) % 3)]!;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  }
  const isEdge = new Uint8Array(fin.length);
  for (const [k, c] of edgeUse) {
    if (c !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    isEdge[a!] = 1;
    isEdge[b!] = 1;
  }
  fin.forEach((n, k) => {
    if (n.snapped) isEdge[k] = 1;
  });
  const edge: number[] = [];
  isEdge.forEach((e, k) => {
    if (e) edge.push(k);
  });
  return {
    id: meta.id,
    kind: meta.kind,
    material: meta.material,
    attach: meta.attach,
    pos: fin.flatMap((n) => n.p.map(r4)),
    nrm: fin.flatMap((n) => n.n.map(r3)),
    ij: fin.flatMap((n) => [n.i, n.j]),
    tris: tr,
    quads: qu,
    edge,
    area: r4(area),
  };
}

/** FNV-1a 32 over the numeric content of a skin set (regeneration check). */
export function hashSkins(panels: readonly SkinPanelData[]): number {
  let h = 0x811c9dc5;
  const mix = (x: number): void => {
    h ^= x & 0xffffffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const p of panels) {
    for (let k = 0; k < p.id.length; k++) mix(p.id.charCodeAt(k));
    for (const v of p.pos) mix(Math.round(v * 1e4));
    for (const v of p.tris) mix(v);
  }
  return h >>> 0;
}
