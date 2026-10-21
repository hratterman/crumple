/**
 * World-content mesh builder (R-WORLD render): world-space triangle soup with
 * normals, metre-scale UVs and optional linear vertex colours, merged per
 * material into one BufferGeometry per (material, cell). Pure three-free
 * arrays until build(); no per-frame work.
 */
import { BufferAttribute, BufferGeometry } from 'three';

export type V3 = [number, number, number];
export type Q = readonly [number, number, number, number];

export function qrot(q: Q, v: readonly [number, number, number]): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const scale = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
export const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
export const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export function norm(a: readonly number[]): V3 {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
}

/** sRGB hex → linear [r, g, b] (vertex colours are linear). */
export function linear(hex: number, k = 1): V3 {
  const f = (v: number): number => {
    const c = v / 255;
    return (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * k;
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

export class Geo {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** Extra per-vertex vec4 (e.g. interior-mapping room ids, emissive masks), optional. */
  readonly ext: number[] = [];
  color: V3 = [1, 1, 1];
  extra: [number, number, number, number] = [0, 0, 0, 0];
  constructor(
    readonly colored = false,
    readonly withExtra = false,
  ) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private vtx(p: readonly number[], n: readonly number[], u: number, v: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0]!, p[1]!, p[2]!);
    this.nrm.push(n[0]!, n[1]!, n[2]!);
    this.uv.push(u, v);
    if (this.colored) this.col.push(this.color[0], this.color[1], this.color[2]);
    if (this.withExtra) this.ext.push(this.extra[0], this.extra[1], this.extra[2], this.extra[3]);
    return i;
  }

  /** Planar convex polygon (CCW seen from the front); UV = projection on (uAxis, vAxis) in metres (+ offsets). */
  poly(pts: readonly (readonly number[])[], uAxis?: readonly number[], vAxis?: readonly number[], u0 = 0, v0 = 0): void {
    const n = norm(cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!)));
    let ua = uAxis;
    let va = vAxis;
    if (!ua || !va) {
      // default: u along the first edge, v along n × u
      ua = norm(sub(pts[1]!, pts[0]!));
      va = cross(n, ua);
    }
    const base = this.vertexCount;
    for (const p of pts) this.vtx(p, n, dot(p, ua) + u0, dot(p, va) + v0);
    for (let k = 1; k + 1 < pts.length; k++) this.idx.push(base, base + k, base + k + 1);
  }

  /** poly() whose front face points along `hint` (the point order is reversed when needed). */
  polyFacing(pts: readonly (readonly number[])[], hint: readonly number[], uAxis?: readonly number[], vAxis?: readonly number[], u0 = 0, v0 = 0): void {
    const n = cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!));
    this.poly(dot(n, hint) >= 0 ? pts : [...pts].reverse(), uAxis, vAxis, u0, v0);
  }

  /** Quad with explicit UVs per corner (a b c d CCW). */
  quadUV(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], uv: readonly number[], n?: readonly number[]): void {
    const nn = n ?? norm(cross(sub(b, a), sub(c, a)));
    const base = this.vertexCount;
    this.vtx(a, nn, uv[0]!, uv[1]!);
    this.vtx(b, nn, uv[2]!, uv[3]!);
    this.vtx(c, nn, uv[4]!, uv[5]!);
    this.vtx(d, nn, uv[6]!, uv[7]!);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Oriented box (centre, unit quat, half extents). `faces` bitmask: +X 1, −X 2, +Y 4, −Y 8, +Z 16, −Z 32. */
  box(c: readonly number[], q: Q, hx: number, hy: number, hz: number, faces = 63): void {
    const P = (x: number, y: number, z: number): V3 => add(c, qrot(q, [x, y, z]));
    const ax = qrot(q, [1, 0, 0]);
    const ay = qrot(q, [0, 1, 0]);
    const az = qrot(q, [0, 0, 1]);
    const nx = scale(ax, -1);
    const nz = scale(az, -1);
    if (faces & 16) this.poly([P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], ax, ay);
    if (faces & 32) this.poly([P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], nx, ay);
    if (faces & 1) this.poly([P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], nz, ay);
    if (faces & 2) this.poly([P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], az, ay);
    if (faces & 4) this.poly([P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], ax, nz);
    if (faces & 8) this.poly([P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], ax, az);
  }

  /** Axis-aligned box from min / max corners. */
  aabb(min: readonly number[], max: readonly number[], faces = 63): void {
    this.box([(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2], [0, 0, 0, 1], (max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2, faces);
  }

  /** Cylinder between two points (open or capped), smooth sides, u around (metres), v along. */
  cylinder(a: readonly number[], b: readonly number[], r: number, segs = 10, caps = true, r2 = r): void {
    const axis = sub(b, a);
    const L = Math.hypot(axis[0], axis[1], axis[2]);
    const d = norm(axis);
    const t = Math.abs(d[1]) < 0.9 ? norm(cross(d, [0, 1, 0])) : norm(cross(d, [1, 0, 0]));
    const bt = cross(d, t);
    const base = this.vertexCount;
    for (let k = 0; k <= segs; k++) {
      const ang = (k / segs) * Math.PI * 2;
      const n: V3 = add(scale(t, Math.cos(ang)), scale(bt, Math.sin(ang)));
      this.vtx(add(a, scale(n, r)), n, (k / segs) * Math.PI * 2 * r, 0);
      this.vtx(add(b, scale(n, r2)), n, (k / segs) * Math.PI * 2 * r, L);
    }
    for (let k = 0; k < segs; k++) {
      const i = base + k * 2;
      this.idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
    if (caps) {
      for (const [p, rr, s] of [
        [b, r2, 1],
        [a, r, -1],
      ] as const) {
        const nn = scale(d, s);
        const c0 = this.vtx(p, nn, 0, 0);
        for (let k = 0; k <= segs; k++) {
          const ang = (k / segs) * Math.PI * 2;
          const off: V3 = add(scale(t, Math.cos(ang) * rr), scale(bt, Math.sin(ang) * rr));
          this.vtx(add(p, off), nn, off[0], off[2]);
        }
        for (let k = 0; k < segs; k++) {
          if (s > 0) this.idx.push(c0, c0 + 1 + k, c0 + 2 + k);
          else this.idx.push(c0, c0 + 2 + k, c0 + 1 + k);
        }
      }
    }
  }

  /**
   * Sweeps a 2D cross-section (x right, y up; CCW → outward normals) along a 3D path with
   * per-point right / up axes. u = section arc length (m), v = path distance (m). Smooth normals
   * across the section where `smooth`.
   */
  sweep(section: readonly (readonly [number, number])[], path: readonly V3[], rights: readonly V3[], ups: readonly V3[], closed = false, smooth = false): void {
    const ns = section.length;
    const segs = closed ? ns : ns - 1;
    let v = 0;
    const sectU: number[] = [0];
    for (let k = 1; k < ns; k++) sectU.push(sectU[k - 1]! + Math.hypot(section[k]![0] - section[k - 1]![0], section[k]![1] - section[k - 1]![1]));
    for (let i = 0; i + 1 < path.length; i++) {
      const p0 = path[i]!;
      const p1 = path[i + 1]!;
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      for (let k = 0; k < segs; k++) {
        const a = section[k]!;
        const b = section[(k + 1) % ns]!;
        const A0 = add(p0, add(scale(rights[i]!, a[0]), scale(ups[i]!, a[1])));
        const B0 = add(p0, add(scale(rights[i]!, b[0]), scale(ups[i]!, b[1])));
        const A1 = add(p1, add(scale(rights[i + 1]!, a[0]), scale(ups[i + 1]!, a[1])));
        const B1 = add(p1, add(scale(rights[i + 1]!, b[0]), scale(ups[i + 1]!, b[1])));
        const ua = sectU[k]!;
        const ub = k + 1 < ns ? sectU[k + 1]! : sectU[k]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (smooth) {
          // per-vertex normals from the section's local edge normals (averaged at a / b)
          const en = (s0: readonly number[], s1: readonly number[]): [number, number] => {
            const ex = s1[0]! - s0[0]!;
            const ey = s1[1]! - s0[1]!;
            const l = Math.hypot(ex, ey) || 1;
            return [-ey / l, ex / l]; // left normal = the quads' winding normal (see quadUV order)
          };
          const prev = section[(k - 1 + ns) % ns]!;
          const next = section[(k + 2) % ns]!;
          const na = k === 0 && !closed ? en(a, b) : avg2(en(prev, a), en(a, b));
          const nb = k + 1 === ns - 1 && !closed ? en(a, b) : avg2(en(a, b), en(b, next));
          const N = (n2: [number, number], i2: number): V3 => norm(add(scale(rights[i2]!, n2[0]), scale(ups[i2]!, n2[1])));
          const base = this.vertexCount;
          this.vtx(A0, N(na, i), ua, v);
          this.vtx(B0, N(nb, i), ub, v);
          this.vtx(B1, N(nb, i + 1), ub, v + L);
          this.vtx(A1, N(na, i + 1), ua, v + L);
          this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        } else {
          this.quadUV(A0, B0, B1, A1, [ua, v, ub, v, ub, v + L, ua, v + L]);
        }
      }
      v += L;
    }
  }

  /** Appends another builder's triangles (loops: spread arguments overflow on big arrays). */
  append(o: Geo): void {
    const base = this.vertexCount;
    const n = o.vertexCount;
    for (let i = 0; i < o.pos.length; i++) this.pos.push(o.pos[i]!);
    for (let i = 0; i < o.nrm.length; i++) this.nrm.push(o.nrm[i]!);
    for (let i = 0; i < o.uv.length; i++) this.uv.push(o.uv[i]!);
    if (this.colored) {
      if (o.colored) for (let i = 0; i < o.col.length; i++) this.col.push(o.col[i]!);
      else for (let i = 0; i < n; i++) this.col.push(1, 1, 1);
    }
    if (this.withExtra) {
      if (o.withExtra) for (let i = 0; i < o.ext.length; i++) this.ext.push(o.ext[i]!);
      else for (let i = 0; i < n; i++) this.ext.push(0, 0, 0, 0);
    }
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i]! + base);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    if (this.colored) g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (this.withExtra) g.setAttribute('aExtra', new BufferAttribute(new Float32Array(this.ext), 4));
    const n = this.vertexCount;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function avg2(a: [number, number], b: [number, number]): [number, number] {
  const x = a[0] + b[0];
  const y = a[1] + b[1];
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
