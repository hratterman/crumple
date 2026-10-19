/**
 * Small pure mesh builders for prop visuals (no three): lathes, rounded
 * boxes, sweeps, plates. Output is a MeshSurface (prop-local REST metres,
 * normals out, UVs in metres or atlas units as each builder documents);
 * tessellateSurface adds tangents. Triangles are oriented automatically
 * (CCW seen from the side the vertex normals point to).
 */
import type { MeshSurface } from '../vehicle/types';

export type V3 = [number, number, number];

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(p: readonly number[], n: readonly number[], u: number, v: number): number {
    const i = this.pos.length / 3;
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    // -0 → 0 keeps bit-equal seams (binder welds by quantized position).
    this.pos.push(p[0]! + 0, p[1]! + 0, p[2]! + 0);
    this.nrm.push(n[0]! / l, n[1]! / l, n[2]! / l);
    this.uv.push(u, v);
    return i;
  }

  /** Triangle, flipped if its geometric normal disagrees with the vertex normals. */
  tri(a: number, b: number, c: number): void {
    const P = this.pos;
    const N = this.nrm;
    const e1x = P[3 * b]! - P[3 * a]!, e1y = P[3 * b + 1]! - P[3 * a + 1]!, e1z = P[3 * b + 2]! - P[3 * a + 2]!;
    const e2x = P[3 * c]! - P[3 * a]!, e2y = P[3 * c + 1]! - P[3 * a + 1]!, e2z = P[3 * c + 2]! - P[3 * a + 2]!;
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-18) return; // degenerate (lathe pole)
    const nx = N[3 * a]! + N[3 * b]! + N[3 * c]!;
    const ny = N[3 * a + 1]! + N[3 * b + 1]! + N[3 * c + 1]!;
    const nz = N[3 * a + 2]! + N[3 * b + 2]! + N[3 * c + 2]!;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Appends another builder's mesh. */
  append(o: MeshBuilder): this {
    const base = this.vertexCount;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.uv.push(...o.uv);
    for (const i of o.idx) this.idx.push(i + base);
    return this;
  }

  /** Rigid transform of every vertex: p → f(p), normals through the same rotation (f must be rigid + translation). */
  transform(rot: (p: V3) => V3, offset: readonly number[] = [0, 0, 0]): this {
    for (let i = 0; i < this.pos.length; i += 3) {
      const p = rot([this.pos[i]!, this.pos[i + 1]!, this.pos[i + 2]!]);
      const n = rot([this.nrm[i]!, this.nrm[i + 1]!, this.nrm[i + 2]!]);
      this.pos[i] = p[0] + offset[0]! + 0;
      this.pos[i + 1] = p[1] + offset[1]! + 0;
      this.pos[i + 2] = p[2] + offset[2]! + 0;
      this.nrm[i] = n[0];
      this.nrm[i + 1] = n[1];
      this.nrm[i + 2] = n[2];
    }
    return this;
  }

  toSurface(): MeshSurface {
    return { type: 'mesh', position: this.pos.slice(), index: this.idx.slice(), normal: this.nrm.slice(), uv: this.uv.slice() };
  }
}

export const rotX = (a: number) => (p: V3): V3 => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
export const rotY = (a: number) => (p: V3): V3 => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];
export const rotZ = (a: number) => (p: V3): V3 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]];

// ============================================================ lathe
/** Profile point (radius, height); `crease` splits the normal there (hard edge). `v` overrides the arc-length v. */
export interface ProfilePoint {
  r: number;
  y: number;
  crease?: boolean;
  v?: number;
  /** Explicit (radial, vertical) normal (outward), e.g. where two lathes meet. */
  n?: readonly [number, number];
}

export interface LatheOptions {
  segments: number;
  /** u = θ / 2π · uRepeat + uOffset (θ from +X toward −Z, i.e. counter-clockwise seen from above). */
  uRepeat?: number;
  uOffset?: number;
  /** v = vOffset + vScale · arc length (or the point's own v). */
  vScale?: number;
  vOffset?: number;
  /** Normals point toward the axis (inner surfaces). */
  inward?: boolean;
}

/**
 * Revolves a (r, y) profile about +Y. Profile order is free; normals are
 * outward (away from the axis on vertical walls, along the profile's
 * perpendicular) unless `inward`. Points with r = 0 collapse to the axis.
 */
export function lathe(b: MeshBuilder, profile: readonly ProfilePoint[], opts: LatheOptions): void {
  const n = profile.length;
  const seg = opts.segments;
  const uR = opts.uRepeat ?? 1;
  const u0 = opts.uOffset ?? 0;
  const vS = opts.vScale ?? 1;
  const v0 = opts.vOffset ?? 0;
  // per-segment 2D normals (perp of the profile direction, oriented away from the axis side chosen below)
  const segN: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1]!.r - profile[i]!.r;
    const dy = profile[i + 1]!.y - profile[i]!.y;
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
  }
  // Orientation: majority of the profile's normals should point away from the axis (r grows) or up on caps.
  let score = 0;
  for (let i = 0; i < n - 1; i++) {
    const rm = (profile[i]!.r + profile[i + 1]!.r) / 2;
    score += segN[i]![0] * rm * Math.hypot(profile[i + 1]!.r - profile[i]!.r, profile[i + 1]!.y - profile[i]!.y);
  }
  // Explicit normals (if any) decide the orientation of the computed ones; else the heuristic.
  let agree = 0;
  for (let i = 0; i < n - 1; i++) {
    for (const j of [i, i + 1]) {
      const e = profile[j]!.n;
      if (e) agree += segN[i]![0] * e[0] + segN[i]![1] * e[1];
    }
  }
  const sgn = (agree !== 0 ? (agree > 0 ? 1 : -1) : score >= 0 ? 1 : -1) * (opts.inward ? -1 : 1);
  // rings: one per point, two at creases
  const rings: { r: number; y: number; nr: number; ny: number; v: number }[] = [];
  let arc = 0;
  for (let i = 0; i < n; i++) {
    const p = profile[i]!;
    if (i > 0) arc += Math.hypot(p.r - profile[i - 1]!.r, p.y - profile[i - 1]!.y);
    const v = p.v ?? v0 + vS * arc;
    const prev = i > 0 ? segN[i - 1]! : null;
    const next = i < n - 1 ? segN[i]! : null;
    if (p.n) {
      const f = opts.inward ? -1 : 1;
      rings.push({ r: p.r, y: p.y, nr: f * p.n[0], ny: f * p.n[1], v });
    } else if (p.crease && prev && next) {
      rings.push({ r: p.r, y: p.y, nr: sgn * prev[0], ny: sgn * prev[1], v });
      rings.push({ r: p.r, y: p.y, nr: sgn * next[0], ny: sgn * next[1], v });
    } else {
      const a = prev ?? next!;
      const c = next ?? prev!;
      rings.push({ r: p.r, y: p.y, nr: sgn * (a[0] + c[0]), ny: sgn * (a[1] + c[1]), v });
    }
  }
  const base: number[] = [];
  for (const ring of rings) {
    base.push(b.vertexCount);
    for (let j = 0; j <= seg; j++) {
      const t = j === seg ? 0 : (j / seg) * Math.PI * 2;
      const c = Math.cos(t);
      const s = -Math.sin(t);
      b.vert([ring.r * c, ring.y, ring.r * s], [ring.nr * c, ring.ny, ring.nr * s], u0 + (j / seg) * uR, ring.v);
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k]!;
    const B = rings[k + 1]!;
    if (A.r === B.r && A.y === B.y) continue; // crease duplicate
    for (let j = 0; j < seg; j++) {
      b.quad(base[k]! + j, base[k]! + j + 1, base[k + 1]! + j + 1, base[k + 1]! + j);
    }
  }
}

/** Flat disc / annulus at height y facing up (+1) or down (−1), concentric rings, uv = planar xz · uvScale + offset. */
export function disc(
  b: MeshBuilder,
  y: number,
  r0: number,
  r1: number,
  face: 1 | -1,
  segments: number,
  rings = 2,
  uv: { scale: number; ox: number; oy: number } = { scale: 1, ox: 0, oy: 0 },
): void {
  const base: number[] = [];
  for (let k = 0; k <= rings; k++) {
    const r = r0 + ((r1 - r0) * k) / rings;
    base.push(b.vertexCount);
    for (let j = 0; j <= segments; j++) {
      const t = j === segments ? 0 : (j / segments) * Math.PI * 2;
      const x = r * Math.cos(t);
      const z = -r * Math.sin(t);
      b.vert([x, y, z], [0, face, 0], uv.ox + x * uv.scale, uv.oy - z * uv.scale);
    }
  }
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < segments; j++) b.quad(base[k]! + j, base[k]! + j + 1, base[k + 1]! + j + 1, base[k + 1]! + j);
  }
}

// ============================================================ rounded box
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
export type BoxFace = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
const FACE_AXES: Record<BoxFace, { axis: 0 | 1 | 2; sign: 1 | -1; ua: 0 | 1 | 2; va: 0 | 1 | 2; uSign: 1 | -1 }> = {
  // (ua, va) chosen so the texture reads upright and un-mirrored seen from outside
  px: { axis: 0, sign: 1, ua: 2, va: 1, uSign: -1 },
  nx: { axis: 0, sign: -1, ua: 2, va: 1, uSign: 1 },
  pz: { axis: 2, sign: 1, ua: 0, va: 1, uSign: 1 },
  nz: { axis: 2, sign: -1, ua: 0, va: 1, uSign: -1 },
  py: { axis: 1, sign: 1, ua: 0, va: 2, uSign: 1 },
  ny: { axis: 1, sign: -1, ua: 0, va: 2, uSign: 1 },
};

/** Grid coordinates on [−h, h] with extra lines near the edges (bevel resolution) and ~`step` spacing inside. */
function edgeGrid(h: number, r: number, step: number): number[] {
  const out: number[] = [-h];
  if (r > 0) out.push(-h + r * 0.35, -h + r);
  const inner = h - r;
  const cells = Math.max(1, Math.ceil((2 * inner) / step));
  for (let k = 1; k < cells; k++) out.push(-inner + (2 * inner * k) / cells);
  if (r > 0) out.push(h - r, h - r * 0.35);
  out.push(h);
  return out;
}

export interface RoundedBoxOptions {
  /** Edge radius, m (0 = sharp box with split normals). */
  radius: number;
  /** Interior grid spacing, m. */
  step: number;
  /** Faces to emit (default all). */
  faces?: readonly BoxFace[];
  /** Per-face uv rect: the face's [−h, h]² maps onto it (atlas); default metres (u, v = face coordinates). */
  uv?: Partial<Record<BoxFace, UvRect>>;
}

/** Rounded box centred at c with half extents h; faces welded along shared edges (bit-equal positions). */
export function roundedBox(b: MeshBuilder, c: readonly number[], h: readonly number[], o: RoundedBoxOptions): void {
  const r = Math.min(o.radius, h[0]! * 0.9, h[1]! * 0.9, h[2]! * 0.9);
  const grids = [edgeGrid(h[0]!, r, o.step), edgeGrid(h[1]!, r, o.step), edgeGrid(h[2]!, r, o.step)];
  for (const face of o.faces ?? (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const)) {
    const { axis, sign, ua, va, uSign } = FACE_AXES[face];
    const gu = grids[ua]!;
    const gv = grids[va]!;
    const rect = o.uv?.[face];
    const base = b.vertexCount;
    for (let j = 0; j < gv.length; j++) {
      for (let i = 0; i < gu.length; i++) {
        const p = [0, 0, 0];
        p[axis] = sign * h[axis]!;
        p[ua] = gu[i]!;
        p[va] = gv[j]!;
        let q = p;
        let n = [0, 0, 0];
        if (r > 0) {
          q = p.map((x, k) => Math.min(h[k]! - r, Math.max(-(h[k]! - r), x)));
          const d = [p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!];
          const dl = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
          n = d.map((x) => x / dl);
          q = [q[0]! + r * n[0]!, q[1]! + r * n[1]!, q[2]! + r * n[2]!];
        } else {
          n[axis] = sign;
        }
        // face coordinate (−h..h along ua, va), u flipped where needed so text reads correctly from outside
        const fu = (uSign * gu[i]!) / h[ua]!; // −1..1
        const fv = (face === 'py' ? -gv[j]! : gv[j]!) / h[va]!;
        let u: number, v: number;
        if (rect) {
          u = rect.u0 + ((fu + 1) / 2) * (rect.u1 - rect.u0);
          v = rect.v0 + ((fv + 1) / 2) * (rect.v1 - rect.v0);
        } else {
          u = fu * h[ua]!;
          v = fv * h[va]!;
        }
        b.vert([c[0]! + q[0]!, c[1]! + q[1]!, c[2]! + q[2]!], n, u, v);
      }
    }
    const nu = gu.length;
    for (let j = 0; j < gv.length - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a = base + j * nu + i;
        b.quad(a, a + 1, a + nu + 1, a + nu);
      }
    }
  }
}

// ============================================================ sweep (tubes)
/**
 * Circular tube along a polyline `path` (≥ 2 points) with per-point radius;
 * frames by parallel transport from `up`. uv: u around (× uRepeat), v =
 * arc length. Optional end caps.
 */
export function tube(
  b: MeshBuilder,
  path: readonly V3[],
  radius: readonly number[],
  segments: number,
  opts: { uRepeat?: number; capStart?: boolean; capEnd?: boolean; up?: V3 } = {},
): void {
  const n = path.length;
  const tangents: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)]!;
    const c = path[Math.min(n - 1, i + 1)]!;
    const t: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const l = Math.hypot(...t) || 1;
    tangents.push([t[0] / l, t[1] / l, t[2] / l]);
  }
  let up: V3 = opts.up ?? [0, 0, 1];
  const rings: number[] = [];
  let arc = 0;
  for (let i = 0; i < n; i++) {
    const t = tangents[i]!;
    // side = normalize(up × t), up' = t × side
    let sx = up[1] * t[2] - up[2] * t[1], sy = up[2] * t[0] - up[0] * t[2], sz = up[0] * t[1] - up[1] * t[0];
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-6) {
      up = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      sx = up[1] * t[2] - up[2] * t[1];
      sy = up[2] * t[0] - up[0] * t[2];
      sz = up[0] * t[1] - up[1] * t[0];
      sl = Math.hypot(sx, sy, sz);
    }
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const ux = t[1] * sz - t[2] * sy, uy = t[2] * sx - t[0] * sz, uz = t[0] * sy - t[1] * sx;
    up = [ux, uy, uz];
    if (i > 0) arc += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], path[i]![2] - path[i - 1]![2]);
    rings.push(b.vertexCount);
    const r = radius[Math.min(i, radius.length - 1)]!;
    for (let j = 0; j <= segments; j++) {
      const a = j === segments ? 0 : (j / segments) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = c * sx + s * ux, ny = c * sy + s * uy, nz = c * sz + s * uz;
      b.vert([path[i]![0] + r * nx, path[i]![1] + r * ny, path[i]![2] + r * nz], [nx, ny, nz], (j / segments) * (opts.uRepeat ?? 1), arc);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segments; j++) b.quad(rings[i]! + j, rings[i]! + j + 1, rings[i + 1]! + j + 1, rings[i + 1]! + j);
  }
  const cap = (i: number, dir: 1 | -1): void => {
    const t = tangents[i]!;
    const nrm: V3 = [t[0] * dir, t[1] * dir, t[2] * dir];
    const c = b.vert(path[i]!, nrm, 0.5, 0.5);
    const first = b.vertexCount;
    for (let j = 0; j <= segments; j++) {
      const k = rings[i]! + j;
      b.vert([b.pos[3 * k]!, b.pos[3 * k + 1]!, b.pos[3 * k + 2]!], nrm, 0.5 + 0.5 * Math.cos((j / segments) * Math.PI * 2), 0.5 + 0.5 * Math.sin((j / segments) * Math.PI * 2));
    }
    for (let j = 0; j < segments; j++) b.tri(c, first + j, first + j + 1);
  };
  if (opts.capStart) cap(0, -1);
  if (opts.capEnd) cap(n - 1, 1);
}

/** A flat grid quad: origin o, edge vectors eu, ev (cells nu × nv), normal n; uv rect over it. */
export function gridQuad(b: MeshBuilder, o: V3, eu: V3, ev: V3, nu: number, nv: number, n: V3, uv: UvRect): void {
  const base = b.vertexCount;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const s = i / nu, t = j / nv;
      b.vert([o[0] + eu[0] * s + ev[0] * t, o[1] + eu[1] * s + ev[1] * t, o[2] + eu[2] * s + ev[2] * t], n, uv.u0 + (uv.u1 - uv.u0) * s, uv.v0 + (uv.v1 - uv.v0) * t);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i;
      b.quad(a, a + 1, a + nu + 2, a + nu + 1);
    }
  }
}
