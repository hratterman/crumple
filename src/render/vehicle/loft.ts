/**
 * Body surface generator (A1): lofted cross-sections → panel meshes.
 *
 * PIPELINE
 *   Loft        sections × control points, centripetal Catmull–Rom in u
 *               (along each section) then v (rails through the sections'
 *               points). Exactly the Barry–Goldman formula of core/spline,
 *               evaluated per segment (O(1) per point) so the end phantoms
 *               can be mirror-symmetric: a section/rail ending ON x = 0 of
 *               a mirrorX surface takes its phantom from the mirror image, so
 *               the centre line is tangent-continuous with its mirror (no
 *               ridge down the roof or hood).
 *   (u, v)      arc-length normalized: control point k sits at u_k = the mean
 *               normalized arc length to k over all sections (likewise v_j),
 *               linear in spline parameter inside a span. Iso-u lines through
 *               a control point are therefore exactly its rail: authors put a
 *               control point on every feature line (shoulder, belt, shut).
 *   Sheet       an adaptive sample grid of one master surface (segments per
 *               span from max edge length AND turning angle), with outward
 *               normals (finite differences, mirror-reflected at the centre),
 *               u-tangents and METRIC uv tables (arc length in metres).
 *   cutPanel    a panel = sheet ∩ region. The region is the rounded
 *               intersection of signed-distance cuts (metres, > 0 inside):
 *               iso-param window edges, side/top/front-view curves, circles.
 *               Grid nodes are evaluated, nodes near the boundary snapped onto
 *               it, triangles clipped (Sutherland–Hodgman, roots by Illinois
 *               on the true surface), so every boundary vertex lies exactly on
 *               its cut. Every boundary edge then gets the edge treatment of
 *               its active cut: a rolled edge + flange (shut lines: the flat
 *               skin is inset by gap/2 + roll radius so the outermost point
 *               of the roll sits gap/2 off the cut), a deep wheel-arch lip, a
 *               small hem, or nothing (seams). Optional inner shell
 *               (thickness), offset along the normal (glass inset), mirror.
 *   tessellateVehicle  (frozen contract) PanelDef surfaces → PanelGeometry:
 *               LoftSurface via the same sheet/cut path (window + inset as
 *               iso cuts), MeshSurface passed through (normals/uv filled in
 *               when absent); tangents from uv for every panel.
 *
 * Pure and deterministic (fixed iteration order, no RNG); Math.* allowed
 * (spawn-time code, not a sim hot loop).
 */
import type { LoftSurface, MeshSurface, PanelGeometry, SurfaceSpec, Vec3T, VehicleVisualDef } from './types';
import { VISUAL_DEFAULTS } from './types';

export type V3 = [number, number, number];
export type P2 = readonly [number, number];

// ====================================================================== Catmull–Rom
const KNOT_EPS = 1e-6;

const knotStep = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const dz = b[2]! - a[2]!;
  return Math.max(Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)), KNOT_EPS);
};

/**
 * Centripetal Catmull–Rom segment p1 → p2 at local s ∈ [0, 1]
 * (Barry–Goldman; identical arithmetic to core/spline `evaluate`).
 */
export function crSegment(
  p0: ArrayLike<number>,
  p1: ArrayLike<number>,
  p2: ArrayLike<number>,
  p3: ArrayLike<number>,
  s: number,
  out: V3,
): V3 {
  const d01 = knotStep(p0, p1);
  const d12 = knotStep(p1, p2);
  const d23 = knotStep(p2, p3);
  const t1 = d01;
  const t2 = d01 + d12;
  const t3 = t2 + d23;
  const tq = t1 + s * d12;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - tq) * p0[k]! + tq * p1[k]!) / t1;
    const a2 = ((t2 - tq) * p1[k]! + (tq - t1) * p2[k]!) / (t2 - t1);
    const a3 = ((t3 - tq) * p2[k]! + (tq - t2) * p3[k]!) / (t3 - t2);
    const b1 = ((t2 - tq) * a1 + tq * a2) / t2;
    const b2 = ((t3 - tq) * a2 + (tq - t1) * a3) / (t3 - t1);
    out[k] = ((t2 - tq) * b1 + (tq - t1) * b2) / (t2 - t1);
  }
  return out;
}

/** Phantom control point beyond `end` (away from `inner`): mirror image across x = 0 when symmetric and `end` lies on it, else linear extrapolation (core/spline). */
function phantom(end: ArrayLike<number>, inner: ArrayLike<number>, symmetric: boolean, out: V3): V3 {
  if (symmetric && end[0] === 0) {
    out[0] = -inner[0]!;
    out[1] = inner[1]!;
    out[2] = inner[2]!;
  } else {
    out[0] = 2 * end[0]! - inner[0]!;
    out[1] = 2 * end[1]! - inner[1]!;
    out[2] = 2 * end[2]! - inner[2]!;
  }
  return out;
}

/** Span lookup: knots ascending, knots[0] = 0, knots[last] = 1. Returns span index in [0, len − 2]; writes the local fraction to loc[0]. */
function locate(knots: Float64Array, x: number, loc: Float64Array): number {
  const n = knots.length;
  if (!(x > 0)) {
    loc[0] = 0;
    return 0;
  }
  if (x >= 1) {
    loc[0] = 1;
    return n - 2;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = knots[lo]!;
  const b = knots[lo + 1]!;
  loc[0] = b > a ? (x - a) / (b - a) : 0;
  return lo;
}

// ====================================================================== loft
export interface Loft {
  readonly sections: readonly (readonly V3[])[];
  readonly closedU: boolean;
  /** Mirror-symmetric phantoms on the x = 0 ends (mirrorX surfaces). */
  readonly symmetric: boolean;
  /** Control points per section. */
  readonly nu: number;
  readonly nv: number;
  /** u of each control point (closed: nu + 1 entries, the last = 1 ≡ CP 0). */
  readonly uKnots: Float64Array;
  /** v of each section. */
  readonly vKnots: Float64Array;
  /** u-direction ends on x = 0 (every section's last / first CP): reflected derivatives there. */
  readonly symU1: boolean;
  readonly symU0: boolean;
  /** v-direction ends on x = 0 (every point of the last / first section). */
  readonly symV1: boolean;
  readonly symV0: boolean;
  point(u: number, v: number, out: V3): V3;
}

export interface LoftOptions {
  closedU?: boolean;
  symmetric?: boolean;
}

/** Throws Error on malformed sections. */
export function createLoft(sectionsIn: readonly (readonly Vec3T[])[], opts: LoftOptions = {}): Loft {
  const closedU = opts.closedU === true;
  const symmetric = opts.symmetric === true;
  const nv = sectionsIn.length;
  if (nv < 2) throw new Error(`loft: need ≥ 2 sections, got ${nv}`);
  const nu = sectionsIn[0]!.length;
  if (nu < (closedU ? 3 : 2)) throw new Error(`loft: need ≥ ${closedU ? 3 : 2} control points per section, got ${nu}`);
  const sections: V3[][] = sectionsIn.map((s, j) => {
    if (s.length !== nu) throw new Error(`loft: section ${j} has ${s.length} control points, expected ${nu}`);
    return s.map((p, k) => {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) throw new Error(`loft: section ${j} point ${k} is not finite`);
      return [p[0] === 0 ? 0 : p[0], p[1], p[2]] as V3;
    });
  });

  const sp0: V3 = [0, 0, 0];
  const sp3: V3 = [0, 0, 0];
  /** Section j at span k, local s. */
  const sectionPoint = (j: number, k: number, s: number, out: V3): V3 => {
    const sec = sections[j]!;
    if (closedU) {
      const g = (i: number): V3 => sec[((i % nu) + nu) % nu]!;
      return crSegment(g(k - 1), g(k), g(k + 1), g(k + 2), s, out);
    }
    const p1 = sec[k]!;
    const p2 = sec[k + 1]!;
    const p0 = k > 0 ? sec[k - 1]! : phantom(sec[0]!, sec[1]!, symmetric, sp0);
    const p3 = k + 2 < nu ? sec[k + 2]! : phantom(sec[nu - 1]!, sec[nu - 2]!, symmetric, sp3);
    return crSegment(p0, p1, p2, p3, s, out);
  };

  // ---- knots: mean normalized arc length
  const SUB = 8;
  const tmpA: V3 = [0, 0, 0];
  const tmpB: V3 = [0, 0, 0];
  const uSpans = closedU ? nu : nu - 1;
  const uAcc = new Float64Array(uSpans + 1);
  let uCount = 0;
  for (let j = 0; j < nv; j++) {
    const cum = new Float64Array(uSpans + 1);
    for (let k = 0; k < uSpans; k++) {
      let len = 0;
      sectionPoint(j, k, 0, tmpA);
      for (let q = 1; q <= SUB; q++) {
        sectionPoint(j, k, q / SUB, tmpB);
        len += Math.hypot(tmpB[0] - tmpA[0], tmpB[1] - tmpA[1], tmpB[2] - tmpA[2]);
        tmpA[0] = tmpB[0];
        tmpA[1] = tmpB[1];
        tmpA[2] = tmpB[2];
      }
      cum[k + 1] = cum[k]! + len;
    }
    const total = cum[uSpans]!;
    if (!(total > 1e-9)) continue;
    for (let k = 0; k <= uSpans; k++) uAcc[k] = uAcc[k]! + cum[k]! / total;
    uCount++;
  }
  const uKnots = new Float64Array(uSpans + 1);
  for (let k = 0; k <= uSpans; k++) uKnots[k] = uCount > 0 ? uAcc[k]! / uCount : k / uSpans;
  normalizeKnots(uKnots);

  const r0: V3 = [0, 0, 0];
  const r3: V3 = [0, 0, 0];
  const railArc = (pts: readonly V3[]): Float64Array => {
    const cum = new Float64Array(nv);
    for (let j = 0; j + 1 < nv; j++) {
      const p0 = j > 0 ? pts[j - 1]! : phantom(pts[0]!, pts[1]!, symmetric, r0);
      const p3 = j + 2 < nv ? pts[j + 2]! : phantom(pts[nv - 1]!, pts[nv - 2]!, symmetric, r3);
      let len = 0;
      tmpA[0] = pts[j]![0];
      tmpA[1] = pts[j]![1];
      tmpA[2] = pts[j]![2];
      for (let q = 1; q <= SUB; q++) {
        crSegment(p0, pts[j]!, pts[j + 1]!, p3, q / SUB, tmpB);
        len += Math.hypot(tmpB[0] - tmpA[0], tmpB[1] - tmpA[1], tmpB[2] - tmpA[2]);
        tmpA[0] = tmpB[0];
        tmpA[1] = tmpB[1];
        tmpA[2] = tmpB[2];
      }
      cum[j + 1] = cum[j]! + len;
    }
    return cum;
  };
  const vAcc = new Float64Array(nv);
  let vCount = 0;
  for (let k = 0; k < nu; k++) {
    const cum = railArc(sections.map((s) => s[k]!));
    const total = cum[nv - 1]!;
    if (!(total > 1e-9)) continue;
    for (let j = 0; j < nv; j++) vAcc[j] = vAcc[j]! + cum[j]! / total;
    vCount++;
  }
  const vKnots = new Float64Array(nv);
  for (let j = 0; j < nv; j++) vKnots[j] = vCount > 0 ? vAcc[j]! / vCount : j / (nv - 1);
  normalizeKnots(vKnots);

  const symU1 = symmetric && !closedU && sections.every((s) => s[nu - 1]![0] === 0);
  const symU0 = symmetric && !closedU && sections.every((s) => s[0]![0] === 0);
  const symV1 = symmetric && sections[nv - 1]!.every((p) => p[0] === 0);
  const symV0 = symmetric && sections[0]!.every((p) => p[0] === 0);

  const loc = new Float64Array(1);
  const R: V3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const point = (u: number, v: number, out: V3): V3 => {
    let uu = u;
    if (closedU) uu -= Math.floor(uu);
    const k = locate(uKnots, uu, loc);
    const s = loc[0]!;
    const j = locate(vKnots, v, loc);
    const t = loc[0]!;
    for (let q = -1; q <= 2; q++) {
      const idx = j + q;
      if (idx >= 0 && idx < nv) sectionPoint(idx, k, s, R[q + 1]!);
    }
    if (j - 1 < 0) phantom(R[1]!, R[2]!, symmetric, R[0]!);
    if (j + 2 > nv - 1) phantom(R[2]!, R[1]!, symmetric, R[3]!);
    crSegment(R[0]!, R[1]!, R[2]!, R[3]!, t, out);
    if (out[0] === 0) out[0] = 0; // no −0
    return out;
  };

  return { sections, closedU, symmetric, nu, nv, uKnots, vKnots, symU0, symU1, symV0, symV1, point };
}

function normalizeKnots(k: Float64Array): void {
  const n = k.length;
  k[0] = 0;
  k[n - 1] = 1;
  for (let i = 1; i < n - 1; i++) k[i] = Math.min(Math.max(k[i]!, k[i - 1]! + 1e-7), 1 - (n - 1 - i) * 1e-7);
}

// ====================================================================== surfaces
/** A parametric master surface on [0, 1]² with outward normals. */
export interface ParamSurface {
  readonly loft: Loft;
  point(u: number, v: number, out: V3): V3;
  /** Outward unit normal n and param derivatives pu, pv at (u, v). Returns false when degenerate everywhere nearby. */
  frame(u: number, v: number, n: V3, pu: V3, pv: V3): boolean;
}

export interface SurfaceOptions {
  /** Reverse the normal (authoring order). */
  flip?: boolean;
  /** Analytic displacement added after the loft (flares, character lines); p is modified in place. */
  displace?: (p: V3, u: number, v: number) => void;
}

const FD_H = 2e-5;

export function loftSurface(loft: Loft, opts: SurfaceOptions = {}): ParamSurface {
  const flip = opts.flip === true;
  const displace = opts.displace;
  const raw = (u: number, v: number, out: V3): V3 => {
    loft.point(u, v, out);
    if (displace) displace(out, u, v);
    if (out[0] === 0) out[0] = 0;
    return out;
  };
  /** Evaluation that continues past the domain: mirror-reflected across symmetric centre ends, else clamped. */
  const ext = (u: number, v: number, out: V3): V3 => {
    let mirror = false;
    let uu = u;
    let vv = v;
    if (!loft.closedU) {
      if (uu > 1) {
        if (loft.symU1) {
          uu = 2 - uu;
          mirror = !mirror;
        } else uu = 1;
      } else if (uu < 0) {
        if (loft.symU0) {
          uu = -uu;
          mirror = !mirror;
        } else uu = 0;
      }
    }
    if (vv > 1) {
      if (loft.symV1) {
        vv = 2 - vv;
        mirror = !mirror;
      } else vv = 1;
    } else if (vv < 0) {
      if (loft.symV0) {
        vv = -vv;
        mirror = !mirror;
      } else vv = 0;
    }
    raw(uu, vv, out);
    if (mirror) out[0] = -out[0];
    return out;
  };
  const a: V3 = [0, 0, 0];
  const b: V3 = [0, 0, 0];
  const tryFrame = (u: number, v: number, n: V3, pu: V3, pv: V3): boolean => {
    const u0 = loft.closedU || loft.symU0 ? u - FD_H : Math.max(0, u - FD_H);
    const u1 = loft.closedU || loft.symU1 ? u + FD_H : Math.min(1, u + FD_H);
    ext(u0, v, a);
    ext(u1, v, b);
    for (let k = 0; k < 3; k++) pu[k] = (b[k]! - a[k]!) / (u1 - u0);
    const v0 = loft.symV0 ? v - FD_H : Math.max(0, v - FD_H);
    const v1 = loft.symV1 ? v + FD_H : Math.min(1, v + FD_H);
    ext(u, v0, a);
    ext(u, v1, b);
    for (let k = 0; k < 3; k++) pv[k] = (b[k]! - a[k]!) / (v1 - v0);
    cross(pu, pv, n);
    const ln = Math.hypot(n[0], n[1], n[2]);
    const lu = Math.hypot(pu[0], pu[1], pu[2]);
    const lv = Math.hypot(pv[0], pv[1], pv[2]);
    if (!(ln > 1e-7 * lu * lv) || !(lu > 1e-9) || !(lv > 1e-9)) return false;
    const s = flip ? -1 / ln : 1 / ln;
    n[0] *= s;
    n[1] *= s;
    n[2] *= s;
    return true;
  };
  const frame = (u: number, v: number, n: V3, pu: V3, pv: V3): boolean => {
    if (tryFrame(u, v, n, pu, pv)) return true;
    // Collapsed span (pole, zero-height window tip): step into the domain.
    for (const d of [2e-4, 1e-3, 4e-3, 1.5e-2]) {
      const du = u < 0.5 ? d : -d;
      const dv = v < 0.5 ? d : -d;
      if (tryFrame(u, v + dv, n, pu, pv) || tryFrame(u + du, v, n, pu, pv) || tryFrame(u + du, v + dv, n, pu, pv)) return true;
    }
    n[0] = 1;
    n[1] = 0;
    n[2] = 0;
    return false;
  };
  return { loft, point: raw, frame };
}

// ====================================================================== vec helpers
const cross = (a: ArrayLike<number>, b: ArrayLike<number>, out: V3): V3 => {
  const x = a[1]! * b[2]! - a[2]! * b[1]!;
  const y = a[2]! * b[0]! - a[0]! * b[2]!;
  const z = a[0]! * b[1]! - a[1]! * b[0]!;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
};
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l > 0) {
    a[0] /= l;
    a[1] /= l;
    a[2] /= l;
  }
  return a;
};

// ====================================================================== sheet (sampled master)
export interface SheetOptions {
  /** Max edge length, m. */
  resolution: number;
  /** Max turning angle per segment, degrees (default 9). */
  maxAngleDeg?: number;
  /** Minimum segments per span (default 1). */
  minSegments?: number;
}

/** A master surface sampled on an adaptive grid; panels are cut from it. */
export interface Sheet {
  readonly surface: ParamSurface;
  readonly us: Float64Array;
  readonly vs: Float64Array;
  /** Node (i, j) at index j·us.length + i: position, outward normal, unit u-tangent, handedness, metric uv. */
  readonly P: Float64Array;
  readonly N: Float64Array;
  readonly T: Float64Array;
  readonly W: Float64Array;
  readonly UV: Float64Array;
  /** Metric arc length along u (resp. v) at an arbitrary (u, v): bilinear in the grid cell. */
  metricU(u: number, v: number): number;
  metricV(u: number, v: number): number;
  /** sin of the angle between ∂P/∂u and ∂P/∂v (param skew): metric Δu × skew = distance across an iso-u line. */
  skew(u: number, v: number): number;
}

function spanCounts(
  spans: number,
  probes: readonly number[],
  evalAt: (span: number, s: number, probe: number, out: V3) => void,
  res: number,
  maxAngle: number,
  minSeg: number,
): number[] {
  const SUB = 12;
  const counts: number[] = [];
  const pts: V3[] = Array.from({ length: SUB + 1 }, () => [0, 0, 0] as V3);
  for (let k = 0; k < spans; k++) {
    let best = minSeg;
    for (const pr of probes) {
      for (let q = 0; q <= SUB; q++) evalAt(k, q / SUB, pr, pts[q]!);
      let len = 0;
      let ang = 0;
      let pdx = 0;
      let pdy = 0;
      let pdz = 0;
      let pl = 0;
      for (let q = 1; q <= SUB; q++) {
        const dx = pts[q]![0] - pts[q - 1]![0];
        const dy = pts[q]![1] - pts[q - 1]![1];
        const dz = pts[q]![2] - pts[q - 1]![2];
        const l = Math.hypot(dx, dy, dz);
        len += l;
        if (pl > 1e-9 && l > 1e-9) {
          const c = (pdx * dx + pdy * dy + pdz * dz) / (pl * l);
          ang += Math.acos(Math.max(-1, Math.min(1, c)));
        }
        if (l > 1e-9) {
          pdx = dx;
          pdy = dy;
          pdz = dz;
          pl = l;
        }
      }
      best = Math.max(best, Math.ceil(len / res - 1e-9), Math.ceil(ang / maxAngle - 1e-9));
    }
    counts.push(Math.min(best, 400));
  }
  return counts;
}

export function createSheet(surface: ParamSurface, opts: SheetOptions): Sheet {
  const loft = surface.loft;
  const res = opts.resolution;
  if (!(res > 0)) throw new Error(`sheet: resolution must be > 0, got ${res}`);
  const maxAngle = ((opts.maxAngleDeg ?? 9) * Math.PI) / 180;
  const minSeg = Math.max(1, opts.minSegments ?? 1);
  const uK = loft.uKnots;
  const vK = loft.vKnots;
  const probesFor = (knots: Float64Array): number[] => {
    const p: number[] = [];
    for (let i = 0; i < knots.length; i++) {
      p.push(knots[i]!);
      if (i + 1 < knots.length) p.push((knots[i]! + knots[i + 1]!) / 2);
    }
    return p;
  };
  const uCounts = spanCounts(
    uK.length - 1,
    probesFor(vK),
    (k, s, v, out) => surface.point(uK[k]! + s * (uK[k + 1]! - uK[k]!), v, out),
    res,
    maxAngle,
    minSeg,
  );
  const vCounts = spanCounts(
    vK.length - 1,
    probesFor(uK),
    (j, s, u, out) => surface.point(u, vK[j]! + s * (vK[j + 1]! - vK[j]!), out),
    res,
    maxAngle,
    minSeg,
  );
  const expand = (knots: Float64Array, counts: number[]): Float64Array => {
    const out: number[] = [];
    for (let k = 0; k < counts.length; k++) {
      const a = knots[k]!;
      const b = knots[k + 1]!;
      const c = counts[k]!;
      for (let q = 0; q < c; q++) out.push(a + ((b - a) * q) / c);
    }
    out.push(1);
    return Float64Array.from(out);
  };
  const us = expand(uK, uCounts);
  const vs = expand(vK, vCounts);
  const nU = us.length;
  const nV = vs.length;
  const count = nU * nV;
  const P = new Float64Array(count * 3);
  const N = new Float64Array(count * 3);
  const T = new Float64Array(count * 3);
  const W = new Float64Array(count);
  const UV = new Float64Array(count * 2);
  const SK = new Float64Array(count);
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  const pu: V3 = [0, 0, 0];
  const pv: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const id = j * nU + i;
      surface.point(us[i]!, vs[j]!, p);
      surface.frame(us[i]!, vs[j]!, n, pu, pv);
      P.set(p, id * 3);
      N.set(n, id * 3);
      tangentFrom(n, pu, pv, t);
      T.set(t, id * 3);
      W[id] = handedness(n, t, pv);
      const lu = Math.hypot(pu[0], pu[1], pu[2]);
      const lv = Math.hypot(pv[0], pv[1], pv[2]);
      const c = cross(pu, pv, [0, 0, 0]);
      SK[id] = lu > 1e-9 && lv > 1e-9 ? Math.min(1, Math.max(0.2, Math.hypot(c[0], c[1], c[2]) / (lu * lv))) : 1;
    }
  }
  for (let j = 0; j < nV; j++) {
    for (let i = 1; i < nU; i++) {
      const a = (j * nU + i - 1) * 3;
      const b = (j * nU + i) * 3;
      UV[(j * nU + i) * 2] = UV[(j * nU + i - 1) * 2]! + Math.hypot(P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!);
    }
  }
  for (let i = 0; i < nU; i++) {
    for (let j = 1; j < nV; j++) {
      const a = ((j - 1) * nU + i) * 3;
      const b = (j * nU + i) * 3;
      UV[(j * nU + i) * 2 + 1] = UV[((j - 1) * nU + i) * 2 + 1]! + Math.hypot(P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!);
    }
  }
  const loc = new Float64Array(1);
  const skewAt = (u: number, v: number): number => {
    const i = locate(us, Math.min(1, Math.max(0, u)), loc);
    const fu = loc[0]!;
    const j = locate(vs, Math.min(1, Math.max(0, v)), loc);
    const fv = loc[0]!;
    const a = SK[j * nU + i]!;
    const b = SK[j * nU + i + 1]!;
    const c = SK[(j + 1) * nU + i]!;
    const d = SK[(j + 1) * nU + i + 1]!;
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
  const bilinear = (u: number, v: number, comp: number): number => {
    const i = locate(us, Math.min(1, Math.max(0, u)), loc);
    const fu = loc[0]!;
    const j = locate(vs, Math.min(1, Math.max(0, v)), loc);
    const fv = loc[0]!;
    const a = UV[(j * nU + i) * 2 + comp]!;
    const b = UV[(j * nU + i + 1) * 2 + comp]!;
    const c = UV[((j + 1) * nU + i) * 2 + comp]!;
    const d = UV[((j + 1) * nU + i + 1) * 2 + comp]!;
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
  return {
    surface,
    us,
    vs,
    P,
    N,
    T,
    W,
    UV,
    metricU: (u, v) => bilinear(u, v, 0),
    metricV: (u, v) => bilinear(u, v, 1),
    skew: skewAt,
  };
}

function tangentFrom(n: V3, pu: V3, pv: V3, out: V3): V3 {
  let lu = Math.hypot(pu[0], pu[1], pu[2]);
  let src: V3 = pu;
  if (!(lu > 1e-9)) {
    // u collapsed: tangent ⟂ pv.
    cross(pv, n, out);
    lu = Math.hypot(out[0], out[1], out[2]);
    src = out;
  }
  const d = dot3(src, n);
  out[0] = src[0] - d * n[0];
  out[1] = src[1] - d * n[1];
  out[2] = src[2] - d * n[2];
  if (!(Math.hypot(out[0], out[1], out[2]) > 1e-12)) {
    // Pick any vector ⟂ n.
    const ax = Math.abs(n[0]) < 0.9 ? 1 : 0;
    out[0] = ax;
    out[1] = 1 - ax;
    out[2] = 0;
    const e = dot3(out, n);
    out[0] -= e * n[0];
    out[1] -= e * n[1];
    out[2] -= e * n[2];
  }
  return norm3(out);
}

function handedness(n: V3, t: V3, pv: V3): number {
  const b: V3 = [0, 0, 0];
  cross(n, t, b);
  return dot3(b, pv) < 0 ? -1 : 1;
}

/** Param box (expanded by one grid cell) of the sheet nodes whose position satisfies `pred`; null when none does. */
export function boundsWhere(sheet: Sheet, pred: (p: V3) => boolean): { u0: number; u1: number; v0: number; v1: number } | null {
  const nU = sheet.us.length;
  const nV = sheet.vs.length;
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  const p: V3 = [0, 0, 0];
  for (let j = 0; j < nV; j++)
    for (let i = 0; i < nU; i++) {
      const id = (j * nU + i) * 3;
      p[0] = sheet.P[id]!;
      p[1] = sheet.P[id + 1]!;
      p[2] = sheet.P[id + 2]!;
      if (!pred(p)) continue;
      i0 = Math.min(i0, i);
      i1 = Math.max(i1, i);
      j0 = Math.min(j0, j);
      j1 = Math.max(j1, j);
    }
  if (i0 === Infinity) return null;
  return {
    u0: sheet.us[Math.max(0, i0 - 1)]!,
    u1: sheet.us[Math.min(nU - 1, i1 + 1)]!,
    v0: sheet.vs[Math.max(0, j0 - 1)]!,
    v1: sheet.vs[Math.min(nV - 1, j1 + 1)]!,
  };
}

// ====================================================================== 2-D shapes (signed distance, metres)
/** Signed-distance shape in a 2-D projection: > 0 inside / on the positive side. */
export interface Shape2 {
  sd(x: number, y: number): number;
}

/** Dense polyline through 2-D control points (centripetal Catmull–Rom), `per` samples per span. */
export function smooth2(points: readonly P2[], per = 8, closed = false): P2[] {
  const n = points.length;
  if (n < 2) return points.slice();
  const pts3 = points.map((p) => [p[0], p[1], 0] as V3);
  const out: P2[] = [];
  const tmp: V3 = [0, 0, 0];
  const ph0: V3 = [0, 0, 0];
  const ph3: V3 = [0, 0, 0];
  const spans = closed ? n : n - 1;
  const g = (i: number): V3 => {
    if (closed) return pts3[((i % n) + n) % n]!;
    if (i < 0) return phantom(pts3[0]!, pts3[1]!, false, ph0);
    if (i > n - 1) return phantom(pts3[n - 1]!, pts3[n - 2]!, false, ph3);
    return pts3[i]!;
  };
  for (let k = 0; k < spans; k++) {
    for (let q = 0; q < per; q++) {
      crSegment(g(k - 1), g(k), g(k + 1), g(k + 2), q / per, tmp);
      out.push([tmp[0], tmp[1]]);
    }
  }
  if (!closed) out.push([points[n - 1]![0], points[n - 1]![1]]);
  return out;
}

/**
 * Polyline shape. closed: inside (either winding) positive. Open: the LEFT
 * side of the direction of travel is positive (end segments extended 50 m,
 * so an open cut line splits the whole plane).
 */
export function polyShape(pointsIn: readonly P2[], closed: boolean): Shape2 {
  const pts = pointsIn.slice();
  if (!closed && pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    pts[0] = [a[0] + ((a[0] - b[0]) / la) * 50, a[1] + ((a[1] - b[1]) / la) * 50];
    const m = pts.length;
    const c = pts[m - 1]!;
    const d = pts[m - 2]!;
    const lc = Math.hypot(c[0] - d[0], c[1] - d[1]) || 1;
    pts[m - 1] = [c[0] + ((c[0] - d[0]) / lc) * 50, c[1] + ((c[1] - d[1]) / lc) * 50];
  }
  const n = pts.length;
  const xs = Float64Array.from(pts, (p) => p[0]);
  const ys = Float64Array.from(pts, (p) => p[1]);
  const segs = closed ? n : n - 1;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  return {
    sd(x: number, y: number): number {
      let best = Infinity;
      let bestSide = 0;
      for (let s = 0; s < segs; s++) {
        const i0 = s;
        const i1 = (s + 1) % n;
        const ax = xs[i0]!;
        const ay = ys[i0]!;
        const dx = xs[i1]! - ax;
        const dy = ys[i1]! - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - x;
        const qy = ay + t * dy - y;
        const d2 = qx * qx + qy * qy;
        if (d2 < best - 1e-18) {
          best = d2;
          // Left of travel: cross(d, p − a) > 0. Endpoint ties resolved by the pseudo-normal below.
          bestSide = dx * (y - ay) - dy * (x - ax);
          if (!closed && (t === 0 || t === 1)) {
            const j = t === 0 ? s - 1 : s + 1;
            if (j >= 0 && j < segs) {
              const bx = xs[j + 1]! - xs[j]!;
              const by = ys[j + 1]! - ys[j]!;
              const lb = Math.hypot(bx, by) || 1;
              const la = Math.sqrt(l2) || 1;
              // Average of both segments' left normals.
              const nx = -dy / la - by / lb;
              const ny = dx / la + bx / lb;
              bestSide = -(qx * nx + qy * ny);
            }
          }
        }
      }
      const dist = Math.sqrt(best);
      if (!closed) return bestSide >= 0 ? dist : -dist;
      if (x < minX || x > maxX || y < minY || y > maxY) return -dist;
      // Even-odd point in polygon.
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ys[i]!;
        const yj = ys[j]!;
        if (yi > y !== yj > y && x < ((xs[j]! - xs[i]!) * (y - yi)) / (yj - yi) + xs[i]!) inside = !inside;
      }
      return inside ? dist : -dist;
    },
  };
}

export function circleShape(cx: number, cy: number, r: number): Shape2 {
  return { sd: (x, y) => r - Math.hypot(x - cx, y - cy) };
}

/** Rounded rectangle (centre, half extents, corner radius), inside positive. */
export function roundRectShape(cx: number, cy: number, hx: number, hy: number, r: number): Shape2 {
  return {
    sd(x, y) {
      const qx = Math.abs(x - cx) - (hx - r);
      const qy = Math.abs(y - cy) - (hy - r);
      const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      return -out;
    },
  };
}

export const invertShape = (s: Shape2): Shape2 => ({ sd: (x, y) => -s.sd(x, y) });
export const offsetShape = (s: Shape2, d: number): Shape2 => ({ sd: (x, y) => s.sd(x, y) + d });

// ====================================================================== cuts + edges
/** Region function: signed distance in metres (> 0 keeps), evaluated on the master point p at (u, v). */
export type RegionFn = (p: V3, u: number, v: number) => number;

/** Edge treatment of a boundary. */
export interface EdgeStyle {
  /** Extra inset of the cut beyond `gap / 2` (shut) — the flat skin stops this far inside. */
  inset: number;
  /** Rolled edge radius, m (0 = none). */
  roll: number;
  /** Flange depth below the roll, m (0 = none). */
  wall: number;
  /** Roll segments. */
  segments: number;
  /** Emit a seal strip (black rubber backing) under this edge. */
  seal: boolean;
  /**
   * Roll sweep, degrees (default 90: the roll ends pointing straight in).
   * > 90 curls the edge back under the panel so the flange is undercut:
   * seen through a shut gap only the dark seal shows, never a lit wall.
   */
  curl?: number;
}

export type EdgeKind = 'shut' | 'arch' | 'hem' | 'seam' | 'lip';

const SHUT_ROLL = 0.0022;
export const EDGE_STYLES: Readonly<Record<EdgeKind, EdgeStyle>> = {
  /** Panel shut line: skin stops gap/2 + roll inside, 2.2 mm roll, 10 mm flange, seal backing. */
  shut: { inset: VISUAL_DEFAULTS.shutGap / 2 + SHUT_ROLL, roll: SHUT_ROLL, wall: 0.006, segments: 2, seal: true, curl: 165 },
  /** Wheel-arch lip: 7 mm roll returning 32 mm into the wheel well. */
  arch: { inset: 0.007, roll: 0.007, wall: 0.032, segments: 2, seal: false },
  /** Small hem (trim strips, lamp lenses): 1.5 mm roll, 5 mm return. */
  hem: { inset: 0.0015, roll: 0.0015, wall: 0.005, segments: 1, seal: false },
  /** Hidden edge or a crease join with an abutting panel: nothing. */
  seam: { inset: 0, roll: 0, wall: 0, segments: 0, seal: false },
  /** Opening edge (grille / intake / lamp cavity): 3 mm roll, 25 mm return. */
  lip: { inset: 0.003, roll: 0.003, wall: 0.025, segments: 2, seal: false },
};

export interface Cut {
  fn: RegionFn;
  edge: EdgeKind | EdgeStyle;
}

const styleOf = (e: EdgeKind | EdgeStyle): EdgeStyle => (typeof e === 'string' ? EDGE_STYLES[e] : e);

// ---- cut constructors
/** Side view (z, y) shape. */
export const sideCut = (shape: Shape2, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (p) => shape.sd(p[2], p[1]), edge });
/** Top view (x, z) shape. */
export const topCut = (shape: Shape2, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (p) => shape.sd(p[0], p[2]), edge });
/** Front view (x, y) shape. */
export const frontCut = (shape: Shape2, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (p) => shape.sd(p[0], p[1]), edge });
/** Keep u ≥ u0 (metric along u). */
export const uAbove = (sheet: Sheet, u0: number, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u, v) - sheet.metricU(u0, v)) * sheet.skew(u, v), edge });
export const uBelow = (sheet: Sheet, u1: number, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u1, v) - sheet.metricU(u, v)) * sheet.skew(u, v), edge });
export const vAbove = (sheet: Sheet, v0: number, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (_p, u, v) => (sheet.metricV(u, v) - sheet.metricV(u, v0)) * sheet.skew(u, v), edge });
export const vBelow = (sheet: Sheet, v1: number, edge: EdgeKind | EdgeStyle = 'shut'): Cut => ({ fn: (_p, u, v) => (sheet.metricV(u, v1) - sheet.metricV(u, v)) * sheet.skew(u, v), edge });

// ====================================================================== cutPanel
export interface PanelCutSpec {
  sheet: Sheet;
  /** Param box limiting the grid (performance; the cuts define the true outline). Default whole sheet. */
  bounds?: { u0: number; u1: number; v0: number; v1: number };
  cuts: readonly Cut[];
  /** Corner rounding radius between cuts, m (default 0.012). */
  corner?: number;
  /** Edge treatment of boundaries that are the sheet's own border (no cut active). Default 'seam'. */
  border?: EdgeKind | EdgeStyle;
  /** Shift the result along the normal, m (glass inset < 0, proud trim > 0). */
  offset?: number;
  /** Inner shell offset (> 0) with closing flanges. */
  thickness?: number;
  /** Also emit the mirror image across x = 0 into the same mesh. */
  mirrorX?: boolean;
  /** Snap band as a fraction of the edge (default 0.2). */
  snap?: number;
}

/** Mesh with normals, uvs (metres) and tangents (xyzw); convertible to MeshSurface. */
export interface PanelMesh {
  position: number[];
  normal: number[];
  uv: number[];
  tangent: number[];
  index: number[];
}

export interface CutResult {
  mesh: PanelMesh;
  /** Black rubber backing strips under the shut edges (empty when none). */
  seal: PanelMesh;
}

interface Builder {
  pos: number[];
  nrm: number[];
  tan: number[];
  uvs: number[];
  idx: number[];
}
const newBuilder = (): Builder => ({ pos: [], nrm: [], tan: [], uvs: [], idx: [] });
function pushVert(b: Builder, p: ArrayLike<number>, n: ArrayLike<number>, t: ArrayLike<number>, w: number, u: number, v: number): number {
  const id = b.pos.length / 3;
  b.pos.push(p[0]!, p[1]!, p[2]!);
  b.nrm.push(n[0]!, n[1]!, n[2]!);
  b.tan.push(t[0]!, t[1]!, t[2]!, w);
  b.uvs.push(u, v);
  return id;
}

export function cutPanel(spec: PanelCutSpec): CutResult {
  const sheet = spec.sheet;
  const surf = sheet.surface;
  const us = sheet.us;
  const vs = sheet.vs;
  const nU = us.length;
  const corner = spec.corner ?? 0.012;
  const border = styleOf(spec.border ?? 'seam');
  const cuts = spec.cuts;
  const styles = cuts.map((c) => styleOf(c.edge));
  const snapFrac = spec.snap ?? 0.2;

  // ---- grid range
  const bnd = spec.bounds ?? { u0: 0, u1: 1, v0: 0, v1: 1 };
  const loc = new Float64Array(1);
  const i0 = Math.max(0, locate(us, bnd.u0, loc));
  let i1 = locate(us, bnd.u1, loc) + 1;
  if (bnd.u1 >= 1) i1 = nU - 1;
  const j0 = Math.max(0, locate(vs, bnd.v0, loc));
  let j1 = locate(vs, bnd.v1, loc) + 1;
  if (bnd.v1 >= 1) j1 = vs.length - 1;
  i1 = Math.min(nU - 1, Math.max(i1, i0 + 1));
  j1 = Math.min(vs.length - 1, Math.max(j1, j0 + 1));

  // ---- region value: rounded intersection of (cut − inset); writes the active cut index.
  let lastActive = -1;
  const region = (p: V3, u: number, v: number): number => {
    let g = Infinity;
    let act = -1;
    for (let c = 0; c < cuts.length; c++) {
      const a = cuts[c]!.fn(p, u, v) - styles[c]!.inset;
      if (g === Infinity) {
        g = a;
        act = c;
        continue;
      }
      if (a < g) act = c;
      if (corner > 0 && a < corner && g < corner) g = corner - Math.hypot(corner - a, corner - g);
      else g = Math.min(a, g);
    }
    lastActive = act;
    return g === Infinity ? 1 : g;
  };

  // ---- working vertex arrays (grid nodes first, then created ones)
  const vu: number[] = [];
  const vv: number[] = [];
  const vp: number[] = [];
  const vn: number[] = [];
  const vt: number[] = [];
  const vw: number[] = [];
  const vuv: number[] = [];
  const vg: number[] = [];
  const vact: number[] = [];
  const locked: boolean[] = [];
  const W = i1 - i0 + 1;
  const H = j1 - j0 + 1;
  const tp: V3 = [0, 0, 0];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const id = j * nU + i;
      vu.push(us[i]!);
      vv.push(vs[j]!);
      for (let k = 0; k < 3; k++) {
        vp.push(sheet.P[id * 3 + k]!);
        vn.push(sheet.N[id * 3 + k]!);
        vt.push(sheet.T[id * 3 + k]!);
      }
      vw.push(sheet.W[id]!);
      vuv.push(sheet.UV[id * 2]!, sheet.UV[id * 2 + 1]!);
      tp[0] = sheet.P[id * 3]!;
      tp[1] = sheet.P[id * 3 + 1]!;
      tp[2] = sheet.P[id * 3 + 2]!;
      vg.push(region(tp, us[i]!, vs[j]!));
      vact.push(lastActive);
      locked.push(false);
    }
  }
  const node = (i: number, j: number): number => (j - j0) * W + (i - i0);
  const P3 = (a: number): V3 => [vp[a * 3]!, vp[a * 3 + 1]!, vp[a * 3 + 2]!];
  const dist = (a: number, b: number): number => Math.hypot(vp[a * 3]! - vp[b * 3]!, vp[a * 3 + 1]! - vp[b * 3 + 1]!, vp[a * 3 + 2]! - vp[b * 3 + 2]!);

  // ---- root along a param segment a→b (g_a > 0 > g_b or reverse): returns t
  const pt: V3 = [0, 0, 0];
  const gAt = (a: number, b: number, t: number): number => {
    const u = vu[a]! + (vu[b]! - vu[a]!) * t;
    const v = vv[a]! + (vv[b]! - vv[a]!) * t;
    surf.point(u, v, pt);
    return region(pt, u, v);
  };
  const rootCache = new Map<number, number>();
  const root = (a: number, b: number): number => {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    const hit = rootCache.get(key);
    if (hit !== undefined) return a < b ? hit : 1 - hit;
    const t = rootSolve(a, b);
    rootCache.set(key, a < b ? t : 1 - t);
    return t;
  };
  const rootSolve = (a: number, b: number): number => {
    let ta = 0;
    let ga = vg[a]!;
    let tb = 1;
    let gb = vg[b]!;
    let side = 0;
    let t = 0.5;
    for (let it = 0; it < 30; it++) {
      t = ga !== gb ? (ta * gb - tb * ga) / (gb - ga) : (ta + tb) / 2;
      if (!(t > ta && t < tb)) t = (ta + tb) / 2;
      const g = gAt(a, b, t);
      if (Math.abs(g) < 5e-6 || tb - ta < 1e-7) break;
      if (g > 0 === ga > 0) {
        ta = t;
        ga = g;
        if (side === -1) gb /= 2;
        side = -1;
      } else {
        tb = t;
        gb = g;
        if (side === 1) ga /= 2;
        side = 1;
      }
    }
    return t;
  };
  const n3: V3 = [0, 0, 0];
  const pu3: V3 = [0, 0, 0];
  const pv3: V3 = [0, 0, 0];
  const t3: V3 = [0, 0, 0];
  /** Write a vertex at param lerp(a, b, t) into slot `dst` (new when dst < 0). */
  const placeOnEdge = (a: number, b: number, t: number, dst: number): number => {
    const u = vu[a]! + (vu[b]! - vu[a]!) * t;
    const v = vv[a]! + (vv[b]! - vv[a]!) * t;
    surf.point(u, v, pt);
    region(pt, u, v);
    const act = lastActive;
    surf.frame(u, v, n3, pu3, pv3);
    tangentFrom(n3, pu3, pv3, t3);
    const w = handedness(n3, t3, pv3);
    const U = vuv[a * 2]! + (vuv[b * 2]! - vuv[a * 2]!) * t;
    const V = vuv[a * 2 + 1]! + (vuv[b * 2 + 1]! - vuv[a * 2 + 1]!) * t;
    let id = dst;
    if (id < 0) {
      id = vu.length;
      vu.push(u);
      vv.push(v);
      vp.push(pt[0], pt[1], pt[2]);
      vn.push(n3[0], n3[1], n3[2]);
      vt.push(t3[0], t3[1], t3[2]);
      vw.push(w);
      vuv.push(U, V);
      vg.push(0);
      vact.push(act);
      locked.push(true);
    } else {
      vu[id] = u;
      vv[id] = v;
      for (let k = 0; k < 3; k++) {
        vp[id * 3 + k] = pt[k]!;
        vn[id * 3 + k] = n3[k]!;
        vt[id * 3 + k] = t3[k]!;
      }
      vw[id] = w;
      vuv[id * 2] = U;
      vuv[id * 2 + 1] = V;
      vg[id] = 0;
      vact[id] = act;
      locked[id] = true;
    }
    return id;
  };

  // ---- triangles of the grid (diagonal = shorter 3-D diagonal)
  const tris: number[] = [];
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const a = node(i, j);
      const b = node(i + 1, j);
      const c = node(i + 1, j + 1);
      const d = node(i, j + 1);
      if (dist(a, c) <= dist(b, d)) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
    }
  }
  // Orientation: grid (u, v) CCW is outward when n ∥ pu × pv; a flipped surface reverses it. Vote over cells.
  const flip = (() => {
    let vote = 0;
    const c: V3 = [0, 0, 0];
    const stepI = Math.max(1, (W - 1) >> 3);
    const stepJ = Math.max(1, (H - 1) >> 3);
    for (let j = j0; j < j1; j += stepJ) {
      for (let i = i0; i < i1; i += stepI) {
        const a = node(i, j);
        const pa = P3(a);
        const pb = P3(node(i + 1, j));
        const pd = P3(node(i, j + 1));
        cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]], c);
        vote += dot3(c, [vn[a * 3]!, vn[a * 3 + 1]!, vn[a * 3 + 2]!]);
      }
    }
    return vote < 0;
  })();
  // Shortest incident grid edge per node (snap moves stay well inside the 1-ring).
  const minEdge = new Float64Array(W * H).fill(Infinity);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const a = node(i, j);
      if (i < i1) {
        const d = dist(a, node(i + 1, j));
        if (d > 1e-7) {
          minEdge[a] = Math.min(minEdge[a]!, d);
          minEdge[node(i + 1, j)] = Math.min(minEdge[node(i + 1, j)]!, d);
        }
      }
      if (j < j1) {
        const d = dist(a, node(i, j + 1));
        if (d > 1e-7) {
          minEdge[a] = Math.min(minEdge[a]!, d);
          minEdge[node(i, j + 1)] = Math.min(minEdge[node(i, j + 1)]!, d);
        }
      }
    }
  }

  // ---- snap pass: crossings very close to a node move the node onto the boundary
  if (snapFrac > 0) {
    const seen = new Set<number>();
    for (let q = 0; q < tris.length; q += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[q + e]!;
        const b = tris[q + ((e + 1) % 3)]!;
        const key = a < b ? a * 1e7 + b : b * 1e7 + a;
        if (seen.has(key)) continue;
        seen.add(key);
        const ga = vg[a]!;
        const gb = vg[b]!;
        if (!((ga > 0 && gb < 0) || (ga < 0 && gb > 0))) continue;
        const t = root(a, b);
        const l = dist(a, b);
        if (t < snapFrac && !locked[a] && t * l < 0.3 * minEdge[a]!) placeOnEdge(a, b, t, a);
        else if (t > 1 - snapFrac && !locked[b] && (1 - t) * l < 0.3 * minEdge[b]!) placeOnEdge(a, b, t, b);
      }
    }
  }

  // ---- clip
  const out: number[] = [];
  const crossCache = new Map<number, number>();
  const crossing = (a: number, b: number): number => {
    if (vg[a] === 0) return a;
    if (vg[b] === 0) return b;
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    const hit = crossCache.get(key);
    if (hit !== undefined) return hit;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const t = root(lo, hi);
    const id = placeOnEdge(lo, hi, t, -1);
    crossCache.set(key, id);
    return id;
  };
  const centroidInside = (a: number, b: number, c: number): boolean => {
    const u = (vu[a]! + vu[b]! + vu[c]!) / 3;
    const v = (vv[a]! + vv[b]! + vv[c]!) / 3;
    surf.point(u, v, pt);
    return region(pt, u, v) >= 0;
  };
  for (let q = 0; q < tris.length; q += 3) {
    const ids = [tris[q]!, tris[q + 1]!, tris[q + 2]!];
    const ins = ids.map((x) => vg[x]! >= 0);
    const nIn = (ins[0] ? 1 : 0) + (ins[1] ? 1 : 0) + (ins[2] ? 1 : 0);
    if (nIn === 0) continue;
    if (nIn === 3) {
      if (vg[ids[0]!] === 0 && vg[ids[1]!] === 0 && vg[ids[2]!] === 0 && !centroidInside(ids[0]!, ids[1]!, ids[2]!)) continue;
      out.push(ids[0]!, ids[1]!, ids[2]!);
      continue;
    }
    // Rotate so the polygon walk starts consistently.
    const poly: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = ids[e]!;
      const b = ids[(e + 1) % 3]!;
      const ia = ins[e]!;
      const ib = ins[(e + 1) % 3]!;
      if (ia) poly.push(a);
      if (ia !== ib) {
        const x = ia ? crossing(a, b) : crossing(b, a);
        if (poly[poly.length - 1] !== x) poly.push(x);
      }
    }
    // Remove duplicates (wrap).
    const clean: number[] = [];
    for (const x of poly) if (clean[clean.length - 1] !== x) clean.push(x);
    while (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    for (let k = 1; k + 1 < clean.length; k++) out.push(clean[0]!, clean[k]!, clean[k + 1]!);
  }

  // ---- compact + drop degenerate
  const remap = new Int32Array(vu.length).fill(-1);
  const body = newBuilder();
  const ensure = (a: number): number => {
    if (remap[a]! >= 0) return remap[a]!;
    const id = pushVert(body, P3(a), [vn[a * 3]!, vn[a * 3 + 1]!, vn[a * 3 + 2]!], [vt[a * 3]!, vt[a * 3 + 1]!, vt[a * 3 + 2]!], vw[a]!, vuv[a * 2]!, vuv[a * 2 + 1]!);
    remap[a] = id;
    return id;
  };
  const actOf: number[] = [];
  for (let q = 0; q < out.length; q += 3) {
    let a = out[q]!;
    let b = out[q + 1]!;
    const c = out[q + 2]!;
    if (a === b || b === c || a === c) continue;
    const pa = P3(a);
    const pb = P3(b);
    const pc = P3(c);
    const cr: V3 = [0, 0, 0];
    cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]], cr);
    if (!(Math.hypot(cr[0], cr[1], cr[2]) > 2e-11)) continue;
    if (flip) {
      const s = a;
      a = b;
      b = s;
    }
    // Local fold-over (snapped node, collapsed span): orient the triangle by its vertex normals.
    {
      const nx = vn[a * 3]! + vn[b * 3]! + vn[c * 3]!;
      const ny = vn[a * 3 + 1]! + vn[b * 3 + 1]! + vn[c * 3 + 1]!;
      const nz = vn[a * 3 + 2]! + vn[b * 3 + 2]! + vn[c * 3 + 2]!;
      const qa = P3(a);
      const qb = P3(b);
      const qc = P3(c);
      const f = cross([qb[0] - qa[0], qb[1] - qa[1], qb[2] - qa[2]], [qc[0] - qa[0], qc[1] - qa[1], qc[2] - qa[2]], [0, 0, 0]);
      if (f[0] * nx + f[1] * ny + f[2] * nz < 0) {
        const s = a;
        a = b;
        b = s;
      }
    }
    const ra = ensure(a);
    const rb = ensure(b);
    const rc = ensure(c);
    body.idx.push(ra, rb, rc);
  }
  for (let a = 0; a < vu.length; a++) if (remap[a]! >= 0) actOf[remap[a]!] = vg[a] === 0 ? vact[a]! : -1;

  // Offset the skin first: flanges then hang off the offset edge (offsetting rotated flange normals would fold them).
  if (spec.offset) offsetAlongNormal(body, spec.offset);
  const seal = newBuilder();
  addFlanges(body, actOf, styles, border, spec.thickness ?? 0, seal);

  if (spec.mirrorX) {
    mirrorInto(body);
    mirrorInto(seal);
  }
  return { mesh: toPanelMesh(body), seal: toPanelMesh(seal) };
}

const toPanelMesh = (b: Builder): PanelMesh => ({ position: b.pos, normal: b.nrm, uv: b.uvs, tangent: b.tan, index: b.idx });

function offsetAlongNormal(b: Builder, d: number): void {
  for (let i = 0; i < b.pos.length; i++) b.pos[i] = b.pos[i]! + d * b.nrm[i]!;
}

/** Append the x-mirrored copy (winding reversed, handedness flipped). */
function mirrorInto(b: Builder): void {
  const n = b.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = -b.pos[i * 3]!;
    b.pos.push(x === 0 ? 0 : x, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!);
    b.nrm.push(-b.nrm[i * 3]!, b.nrm[i * 3 + 1]!, b.nrm[i * 3 + 2]!);
    b.tan.push(-b.tan[i * 4]!, b.tan[i * 4 + 1]!, b.tan[i * 4 + 2]!, -b.tan[i * 4 + 3]!);
    b.uvs.push(b.uvs[i * 2]!, b.uvs[i * 2 + 1]!);
  }
  const m = b.idx.length;
  for (let q = 0; q < m; q += 3) b.idx.push(b.idx[q]! + n, b.idx[q + 2]! + n, b.idx[q + 1]! + n);
}

/** Mirror a whole mesh across x = 0 (a separate L panel from an R one). */
export function mirrorMesh(m: PanelMesh): PanelMesh {
  const b: Builder = { pos: [], nrm: [], tan: [], uvs: [], idx: [] };
  const n = m.position.length / 3;
  for (let i = 0; i < n; i++) {
    const x = -m.position[i * 3]!;
    b.pos.push(x === 0 ? 0 : x, m.position[i * 3 + 1]!, m.position[i * 3 + 2]!);
    b.nrm.push(-m.normal[i * 3]!, m.normal[i * 3 + 1]!, m.normal[i * 3 + 2]!);
    b.tan.push(-m.tangent[i * 4]!, m.tangent[i * 4 + 1]!, m.tangent[i * 4 + 2]!, -m.tangent[i * 4 + 3]!);
    b.uvs.push(m.uv[i * 2]!, m.uv[i * 2 + 1]!);
  }
  for (let q = 0; q < m.index.length; q += 3) b.idx.push(m.index[q]!, m.index[q + 2]!, m.index[q + 1]!);
  return toPanelMesh(b);
}

/** Param u at which metricU(·, v) equals `m` (bisection; metricU is monotone in u). */
export function uAtMetric(sheet: Sheet, v: number, m: number): number {
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (sheet.metricU(mid, v) < m) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A band between two u-curves u0(v) … u1(v) for v ∈ [v0, v1], meshed directly
 * on the surface (narrow strips — seals, window bands — that are thinner than
 * a sheet cell and would vanish when clipped). Outward-facing, metric uv.
 */
export function stripMesh(
  sheet: Sheet,
  o: { u0: (v: number) => number; u1: (v: number) => number; v0: number; v1: number; segV: number; segU?: number; offset?: number },
): PanelMesh {
  const surf = sheet.surface;
  const segU = o.segU ?? 1;
  const b = newBuilder();
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  const pu: V3 = [0, 0, 0];
  const pv: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  const d = o.offset ?? 0;
  for (let j = 0; j <= o.segV; j++) {
    const v = o.v0 + ((o.v1 - o.v0) * j) / o.segV;
    const ua = o.u0(v);
    const ub = o.u1(v);
    for (let i = 0; i <= segU; i++) {
      const u = ua + ((ub - ua) * i) / segU;
      surf.point(u, v, p);
      surf.frame(u, v, n, pu, pv);
      tangentFrom(n, pu, pv, t);
      pushVert(b, [p[0] + d * n[0], p[1] + d * n[1], p[2] + d * n[2]], n, t, handedness(n, t, pv), sheet.metricU(u, v), sheet.metricV(u, v));
    }
  }
  const cols = segU + 1;
  // Orientation vote (grid CCW in (u, v) is outward unless the surface is flipped).
  let vote = 0;
  for (let j = 0; j < o.segV; j++) {
    const a = j * cols;
    const e1 = [b.pos[(a + 1) * 3]! - b.pos[a * 3]!, b.pos[(a + 1) * 3 + 1]! - b.pos[a * 3 + 1]!, b.pos[(a + 1) * 3 + 2]! - b.pos[a * 3 + 2]!];
    const e2 = [b.pos[(a + cols) * 3]! - b.pos[a * 3]!, b.pos[(a + cols) * 3 + 1]! - b.pos[a * 3 + 1]!, b.pos[(a + cols) * 3 + 2]! - b.pos[a * 3 + 2]!];
    const c = cross(e1, e2, [0, 0, 0]);
    vote += c[0] * b.nrm[a * 3]! + c[1] * b.nrm[a * 3 + 1]! + c[2] * b.nrm[a * 3 + 2]!;
  }
  for (let j = 0; j < o.segV; j++)
    for (let i = 0; i < segU; i++) {
      const a = j * cols + i;
      if (vote >= 0) b.idx.push(a, a + 1, a + cols + 1, a, a + cols + 1, a + cols);
      else b.idx.push(a, a + cols + 1, a + 1, a, a + cols, a + cols + 1);
    }
  return toPanelMesh(b);
}

/**
 * (u, v) on `sheet` whose surface point has the 2-D projection `target`
 * (proj picks two coordinates, e.g. front view (|x|, y)). Damped Newton
 * with finite-difference Jacobian from `guess`, clamped to the unit square.
 * The projection must be locally invertible (e.g. a ribbon whose u runs
 * up and whose v runs across in that view).
 */
export function paramAt(sheet: Sheet, proj: (p: V3) => P2, target: P2, guess: P2 = [0.5, 0.5]): [number, number] {
  const surf = sheet.surface;
  const q: V3 = [0, 0, 0];
  const at = (u: number, v: number): P2 => proj(surf.point(u, v, q));
  let u = guess[0];
  let v = guess[1];
  const h = 1e-5;
  for (let it = 0; it < 40; it++) {
    const f = at(u, v);
    const ex = f[0] - target[0];
    const ey = f[1] - target[1];
    if (Math.hypot(ex, ey) < 1e-7) break;
    const uu = u + h <= 1 ? h : -h;
    const vv = v + h <= 1 ? h : -h;
    const fu = at(u + uu, v);
    const fv = at(u, v + vv);
    const a = (fu[0] - f[0]) / uu;
    const c = (fu[1] - f[1]) / uu;
    const b = (fv[0] - f[0]) / vv;
    const d = (fv[1] - f[1]) / vv;
    const det = a * d - b * c;
    if (!(Math.abs(det) > 1e-12)) break;
    let du = (d * ex - b * ey) / det;
    let dv = (-c * ex + a * ey) / det;
    const step = Math.hypot(du, dv);
    if (step > 0.1) {
      du *= 0.1 / step;
      dv *= 0.1 / step;
    }
    u = Math.min(1, Math.max(0, u - du));
    v = Math.min(1, Math.max(0, v - dv));
  }
  return [u, v];
}

/**
 * A small part conforming to a sheet: an (nI + 1) × (nJ + 1) grid (nJ
 * columns when closedJ) whose node (i, j) sits at surface (u, v) lifted
 * `lift` metres along the normal. Faces are wound outward (agreeing with
 * the surface normal); smoothNormals recomputes vertex normals from the
 * lifted geometry (domes, beads). Rings collapsed to one point (a disc
 * centre) are allowed: zero-area triangles are dropped.
 */
export function surfacePatch(
  sheet: Sheet,
  nI: number,
  nJ: number,
  at: (i: number, j: number) => { u: number; v: number; lift: number },
  opts: { closedJ?: boolean; smoothNormals?: boolean } = {},
): PanelMesh {
  const surf = sheet.surface;
  const b = newBuilder();
  const cols = opts.closedJ ? nJ : nJ + 1;
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  const pu: V3 = [0, 0, 0];
  const pv: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  const sn: number[] = [];
  for (let i = 0; i <= nI; i++) {
    for (let j = 0; j < cols; j++) {
      const s = at(i, j);
      surf.point(s.u, s.v, p);
      surf.frame(s.u, s.v, n, pu, pv);
      tangentFrom(n, pu, pv, t);
      sn.push(n[0], n[1], n[2]);
      pushVert(b, [p[0] + s.lift * n[0], p[1] + s.lift * n[1], p[2] + s.lift * n[2]], n, t, handedness(n, t, pv), sheet.metricU(s.u, s.v), sheet.metricV(s.u, s.v));
    }
  }
  const P = b.pos;
  const same = (x: number, y: number): boolean => P[x * 3] === P[y * 3] && P[x * 3 + 1] === P[y * 3 + 1] && P[x * 3 + 2] === P[y * 3 + 2];
  const tri = (x: number, y: number, z: number): void => {
    if (same(x, y) || same(y, z) || same(x, z)) return;
    const f = cross([P[y * 3]! - P[x * 3]!, P[y * 3 + 1]! - P[x * 3 + 1]!, P[y * 3 + 2]! - P[x * 3 + 2]!], [P[z * 3]! - P[x * 3]!, P[z * 3 + 1]! - P[x * 3 + 1]!, P[z * 3 + 2]! - P[x * 3 + 2]!], [0, 0, 0]);
    if (!(Math.hypot(f[0], f[1], f[2]) > 1e-12)) return;
    const d = f[0] * (sn[x * 3]! + sn[y * 3]! + sn[z * 3]!) + f[1] * (sn[x * 3 + 1]! + sn[y * 3 + 1]! + sn[z * 3 + 1]!) + f[2] * (sn[x * 3 + 2]! + sn[y * 3 + 2]! + sn[z * 3 + 2]!);
    if (d >= 0) b.idx.push(x, y, z);
    else b.idx.push(x, z, y);
  };
  for (let i = 0; i < nI; i++)
    for (let j = 0; j < nJ; j++) {
      const j2 = opts.closedJ ? (j + 1) % nJ : j + 1;
      const a = i * cols + j;
      const c = i * cols + j2;
      const d = (i + 1) * cols + j2;
      const e = (i + 1) * cols + j;
      tri(a, c, d);
      tri(a, d, e);
    }
  if (opts.smoothNormals) {
    const nn = computeNormals(b.pos, b.idx);
    for (let k = 0; k < nn.length; k += 3) {
      const s = nn[k]! * sn[k]! + nn[k + 1]! * sn[k + 1]! + nn[k + 2]! * sn[k + 2]! < 0 ? -1 : 1;
      b.nrm[k] = nn[k]! * s;
      b.nrm[k + 1] = nn[k + 1]! * s;
      b.nrm[k + 2] = nn[k + 2]! * s;
      // Keep the tangent ⟂ the new normal.
      const ti = (k / 3) * 4;
      const dd = b.tan[ti]! * b.nrm[k]! + b.tan[ti + 1]! * b.nrm[k + 1]! + b.tan[ti + 2]! * b.nrm[k + 2]!;
      const tt = norm3([b.tan[ti]! - dd * b.nrm[k]!, b.tan[ti + 1]! - dd * b.nrm[k + 1]!, b.tan[ti + 2]! - dd * b.nrm[k + 2]!]);
      b.tan[ti] = tt[0];
      b.tan[ti + 1] = tt[1];
      b.tan[ti + 2] = tt[2];
    }
  }
  return toPanelMesh(b);
}

/** Boundary loops of a mesh (vertex indices, each loop with the mesh on its left seen from outside). */
export function boundaryLoops(m: PanelMesh): number[][] {
  const nV = m.position.length / 3;
  const key = (a: number, b: number): number => a * nV + b;
  const edges = new Set<number>();
  for (let q = 0; q < m.index.length; q += 3) for (let e = 0; e < 3; e++) edges.add(key(m.index[q + e]!, m.index[q + ((e + 1) % 3)]!));
  const next = new Map<number, number>();
  for (let q = 0; q < m.index.length; q += 3)
    for (let e = 0; e < 3; e++) {
      const a = m.index[q + e]!;
      const b = m.index[q + ((e + 1) % 3)]!;
      if (!edges.has(key(b, a)) && !next.has(a)) next.set(a, b);
    }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const s of [...next.keys()].sort((x, y) => x - y)) {
    if (seen.has(s)) continue;
    const loop: number[] = [];
    let c = s;
    while (!seen.has(c) && next.has(c)) {
      seen.add(c);
      loop.push(c);
      c = next.get(c)!;
    }
    if (c === s && loop.length > 2) loops.push(loop);
  }
  return loops;
}

/**
 * A rounded bead / frame along every closed boundary loop of `m` (a region
 * mesh cut with 'seam' borders): it spans `inner` metres inside to `outer`
 * metres outside the outline, raised `lift` above the surface, rolled down
 * at both edges. For surrounds that are thinner than a sheet cell.
 */
export function outlineBand(m: PanelMesh, inner: number, outer: number, lift: number, opts: { skipCentre?: boolean } = {}): PanelMesh {
  const b = newBuilder();
  const P = (i: number): V3 => [m.position[i * 3]!, m.position[i * 3 + 1]!, m.position[i * 3 + 2]!];
  // Profile across the band: (offset along e, offset along n, normal angle toward e).
  const prof: [number, number, number][] = [
    [-inner, -0.002, -1.2],
    [-inner + lift * 0.8, lift * 0.85, -0.5],
    [(outer - inner) / 2, lift, 0],
    [outer - lift * 0.8, lift * 0.85, 0.5],
    [outer, -0.002, 1.2],
  ];
  for (const loop of boundaryLoops(m)) {
    const L = loop.length;
    const base = b.pos.length / 3;
    let arc = 0;
    for (let k = 0; k < L; k++) {
      const i = loop[k]!;
      const p = P(i);
      const pp = P(loop[(k - 1 + L) % L]!);
      const pn = P(loop[(k + 1) % L]!);
      if (k > 0) arc += Math.hypot(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      const n: V3 = [m.normal[i * 3]!, m.normal[i * 3 + 1]!, m.normal[i * 3 + 2]!];
      const t = norm3([pn[0] - pp[0], pn[1] - pp[1], pn[2] - pp[2]]);
      const e = norm3(cross(t, n, [0, 0, 0]));
      prof.forEach(([de, dn, ang], r) => {
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        pushVert(b, [p[0] + de * e[0] + dn * n[0], p[1] + de * e[1] + dn * n[1], p[2] + de * e[2] + dn * n[2]], [c * n[0] + sn * e[0], c * n[1] + sn * e[1], c * n[2] + sn * e[2]], t, 1, arc, r * 0.005);
      });
    }
    const R = prof.length;
    for (let k = 0; k < L; k++) {
      // Edges lying on the mirror plane are seams of a half mesh, not outline.
      if (opts.skipCentre && m.position[loop[k]! * 3] === 0 && m.position[loop[(k + 1) % L]! * 3] === 0) continue;
      const a0 = base + k * R;
      const b0 = base + ((k + 1) % L) * R;
      // e points out of the region (right of travel): rows run inner → outer = left → right.
      for (let r = 0; r + 1 < R; r++) b.idx.push(a0 + r, b0 + r, b0 + r + 1, a0 + r, b0 + r + 1, a0 + r + 1);
    }
  }
  return orientByNormals(toPanelMesh(b));
}

/** Flip triangles whose winding disagrees with their vertex normals (per triangle). */
function orientByNormals(m: PanelMesh): PanelMesh {
  const idx = m.index.slice();
  const p = m.position;
  for (let q = 0; q < idx.length; q += 3) {
    const a = idx[q]! * 3;
    const b = idx[q + 1]! * 3;
    const c = idx[q + 2]! * 3;
    const f = cross([p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!], [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!], [0, 0, 0]);
    const nx = m.normal[a]! + m.normal[b]! + m.normal[c]!;
    const ny = m.normal[a + 1]! + m.normal[b + 1]! + m.normal[c + 1]!;
    const nz = m.normal[a + 2]! + m.normal[b + 2]! + m.normal[c + 2]!;
    if (f[0] * nx + f[1] * ny + f[2] * nz < 0) {
      const t = idx[q + 1]!;
      idx[q + 1] = idx[q + 2]!;
      idx[q + 2] = t;
    }
  }
  return { ...m, index: idx };
}

/** Reverse winding and normals (handedness kept consistent). */
export function flipMesh(m: PanelMesh): PanelMesh {
  const b = newBuilder();
  b.pos.push(...m.position);
  for (let i = 0; i < m.normal.length; i++) b.nrm.push(-m.normal[i]!);
  for (let i = 0; i < m.tangent.length; i += 4) b.tan.push(m.tangent[i]!, m.tangent[i + 1]!, m.tangent[i + 2]!, -m.tangent[i + 3]!);
  b.uvs.push(...m.uv);
  for (let q = 0; q < m.index.length; q += 3) b.idx.push(m.index[q]!, m.index[q + 2]!, m.index[q + 1]!);
  return toPanelMesh(b);
}

/** Flip a closed-ish part so its normals point away from (away = true) or toward `ref` on average. */
export function orientMesh(m: PanelMesh, ref: Vec3T, away = true): PanelMesh {
  let s = 0;
  for (let i = 0; i < m.position.length; i += 3) {
    s += (m.position[i]! - ref[0]) * m.normal[i]! + (m.position[i + 1]! - ref[1]) * m.normal[i + 1]! + (m.position[i + 2]! - ref[2]) * m.normal[i + 2]!;
  }
  return s >= 0 === away ? m : flipMesh(m);
}

export function mergeMeshes(parts: readonly PanelMesh[]): PanelMesh {
  const b = newBuilder();
  for (const m of parts) {
    const base = b.pos.length / 3;
    b.pos.push(...m.position);
    b.nrm.push(...m.normal);
    b.tan.push(...m.tangent);
    b.uvs.push(...m.uv);
    for (const i of m.index) b.idx.push(i + base);
  }
  return toPanelMesh(b);
}

export function toMeshSurface(m: PanelMesh): MeshSurface {
  return { type: 'mesh', position: m.position, index: m.index, normal: m.normal, uv: m.uv };
}

// ====================================================================== flanges
/**
 * Boundary loops of the body mesh get their edge treatment. A boundary edge
 * a→b of a CCW (outside) triangle has the panel on its left seen from
 * outside; outward e = t × n.
 */
function addFlanges(b: Builder, actOf: readonly number[], styles: readonly EdgeStyle[], border: EdgeStyle, thickness: number, seal: Builder): void {
  const nVert = b.pos.length / 3;
  const edgeKey = (x: number, y: number): number => x * nVert + y;
  const edges = new Set<number>();
  for (let q = 0; q < b.idx.length; q += 3) for (let e = 0; e < 3; e++) edges.add(edgeKey(b.idx[q + e]!, b.idx[q + ((e + 1) % 3)]!));
  const next = new Map<number, number>();
  for (let q = 0; q < b.idx.length; q += 3) {
    for (let e = 0; e < 3; e++) {
      const x = b.idx[q + e]!;
      const y = b.idx[q + ((e + 1) % 3)]!;
      if (!edges.has(edgeKey(y, x)) && !next.has(x)) next.set(x, y);
    }
  }
  if (next.size === 0 && thickness <= 0) return;

  // Inner shell first (so flanges can close onto it).
  let innerBase = -1;
  if (thickness > 0) {
    innerBase = nVert;
    for (let i = 0; i < nVert; i++) {
      const p: V3 = [b.pos[i * 3]! - thickness * b.nrm[i * 3]!, b.pos[i * 3 + 1]! - thickness * b.nrm[i * 3 + 1]!, b.pos[i * 3 + 2]! - thickness * b.nrm[i * 3 + 2]!];
      pushVert(b, p, [-b.nrm[i * 3]!, -b.nrm[i * 3 + 1]!, -b.nrm[i * 3 + 2]!], [b.tan[i * 4]!, b.tan[i * 4 + 1]!, b.tan[i * 4 + 2]!], -b.tan[i * 4 + 3]!, b.uvs[i * 2]!, b.uvs[i * 2 + 1]!);
    }
    const m = b.idx.length;
    for (let q = 0; q < m; q += 3) b.idx.push(b.idx[q]! + innerBase, b.idx[q + 2]! + innerBase, b.idx[q + 1]! + innerBase);
  }

  const visited = new Set<number>();
  const starts = [...next.keys()].sort((x, y) => x - y);
  for (const s of starts) {
    if (visited.has(s)) continue;
    const loop: number[] = [];
    let cur = s;
    while (!visited.has(cur) && next.has(cur)) {
      visited.add(cur);
      loop.push(cur);
      cur = next.get(cur)!;
    }
    const closed = cur === s;
    if (loop.length < 2) continue;
    emitLoopFlange(b, loop, closed, actOf, styles, border, thickness, innerBase, seal);
  }
}

function emitLoopFlange(
  b: Builder,
  loop: readonly number[],
  closed: boolean,
  actOf: readonly number[],
  styles: readonly EdgeStyle[],
  border: EdgeStyle,
  thickness: number,
  innerBase: number,
  seal: Builder,
): void {
  const m = loop.length;
  const P = (i: number): V3 => [b.pos[i * 3]!, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!];
  const style = (i: number): EdgeStyle => {
    const a = actOf[i] ?? -1;
    return a >= 0 ? styles[a]! : border;
  };
  // Per loop vertex: outward e, profile rings.
  type Ring = number[];
  const rings: Ring[] = [];
  const sealIn: number[] = [];
  const sealOut: number[] = [];
  const n: V3 = [0, 0, 0];
  for (let k = 0; k < m; k++) {
    const i = loop[k]!;
    const prev = loop[closed ? (k - 1 + m) % m : Math.max(0, k - 1)]!;
    const nxt = loop[closed ? (k + 1) % m : Math.min(m - 1, k + 1)]!;
    const p = P(i);
    const pp = P(prev);
    const pn = P(nxt);
    n[0] = b.nrm[i * 3]!;
    n[1] = b.nrm[i * 3 + 1]!;
    n[2] = b.nrm[i * 3 + 2]!;
    const t = norm3([pn[0] - pp[0], pn[1] - pp[1], pn[2] - pp[2]]);
    const e = norm3(cross(t, n, [0, 0, 0]));
    // uv outward: right of the uv travel direction.
    const tu = b.uvs[nxt * 2]! - b.uvs[prev * 2]!;
    const tv = b.uvs[nxt * 2 + 1]! - b.uvs[prev * 2 + 1]!;
    const tl = Math.hypot(tu, tv) || 1;
    const ou = tv / tl;
    const ov = -tu / tl;
    const st = style(i);
    const ring: Ring = [i];
    const w = b.tan[i * 4 + 3]!;
    const tan: V3 = [b.tan[i * 4]!, b.tan[i * 4 + 1]!, b.tan[i * 4 + 2]!];
    const U0 = b.uvs[i * 2]!;
    const V0 = b.uvs[i * 2 + 1]!;
    let arc = 0;
    let lde = 0;
    let ldn = 0;
    const add = (de: number, dn: number, phi: number): void => {
      arc += Math.hypot(de - lde, dn - ldn);
      lde = de;
      ldn = dn;
      const q: V3 = [p[0] + de * e[0] + dn * n[0], p[1] + de * e[1] + dn * n[1], p[2] + de * e[2] + dn * n[2]];
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const nn: V3 = [c * n[0] + s * e[0], c * n[1] + s * e[1], c * n[2] + s * e[2]];
      const d = dot3(tan, nn);
      const tt = norm3([tan[0] - d * nn[0], tan[1] - d * nn[1], tan[2] - d * nn[2]]);
      ring.push(pushVert(b, q, nn, tt, w, U0 + ou * arc, V0 + ov * arc));
    };
    const sweep = ((st.curl ?? 90) * Math.PI) / 180;
    if (st.roll > 0) {
      for (let s = 1; s <= st.segments; s++) {
        const th = (sweep * s) / st.segments;
        add(st.roll * Math.sin(th), -st.roll * (1 - Math.cos(th)), th);
      }
    }
    if (sweep > Math.PI / 2 + 1e-6 && st.wall > 0) {
      // Undercut return: straight on along the roll's end tangent, normal facing in.
      add(lde - st.wall * Math.cos(sweep - Math.PI / 2), ldn - st.wall * Math.sin(sweep - Math.PI / 2), sweep);
    } else {
      const depth = thickness > 0 ? thickness : st.roll + st.wall;
      if ((st.wall > 0 || (thickness > 0 && st.roll > 0)) && depth > -ldn + 1e-6) add(st.roll, -depth, Math.PI / 2);
    }
    if (thickness > 0 && innerBase >= 0) {
      // Hard crease: duplicate the last ring with the normal of the closing strip (last ring → inner shell).
      if (ring.length > 1) {
        // Strip tangent (−lde, −thickness − ldn) in (e, n); its normal (rotated +90°) = (thickness + ldn, −lde).
        const phi = Math.atan2(thickness + ldn, -lde);
        const save = arc;
        add(lde, ldn, phi);
        arc = save;
      }
      // Marker: close onto this vertex's inner-shell twin.
      ring.push(-1);
    }
    rings.push(ring);
    if (st.seal) {
      const dn = ldn - 0.0025;
      const pin: V3 = [p[0] - 0.003 * e[0] + dn * n[0], p[1] - 0.003 * e[1] + dn * n[1], p[2] - 0.003 * e[2] + dn * n[2]];
      const pout: V3 = [p[0] + 0.011 * e[0] + dn * n[0], p[1] + 0.011 * e[1] + dn * n[1], p[2] + 0.011 * e[2] + dn * n[2]];
      sealIn.push(pushVert(seal, pin, n, tan, w, U0 - ou * 0.003, V0 - ov * 0.003));
      sealOut.push(pushVert(seal, pout, n, tan, w, U0 + ou * 0.011, V0 + ov * 0.011));
    } else {
      sealIn.push(-1);
      sealOut.push(-1);
    }
  }
  const segs = closed ? m : m - 1;
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % m;
    const ra = rings[k]!;
    const rb = rings[k2]!;
    const ia = loop[k]!;
    const ib = loop[k2]!;
    // Resolve inner-shell markers.
    const at = (r: Ring, idx: number, base: number): number => (r[idx] === -1 ? innerBase + base : r[idx]!);
    const len = Math.min(ra.length, rb.length);
    for (let r = 0; r + 1 < len; r++) {
      const a0 = at(ra, r, ia);
      const b0 = at(rb, r, ib);
      const a1 = at(ra, r + 1, ia);
      const b1 = at(rb, r + 1, ib);
      // Strip to the right of a→b: (b0, a0, a1), (b0, a1, b1).
      b.idx.push(b0, a0, a1, b0, a1, b1);
    }
    if (ra.length !== rb.length) {
      // Style change between neighbours: close the longer profile with a fan to the shorter's last.
      const longR = ra.length > rb.length ? ra : rb;
      const shortR = ra.length > rb.length ? rb : ra;
      const longBase = ra.length > rb.length ? ia : ib;
      const shortBase = ra.length > rb.length ? ib : ia;
      const sLast = at(shortR, shortR.length - 1, shortBase);
      for (let r = len - 1; r + 1 < longR.length; r++) {
        const x = at(longR, r, longBase);
        const y = at(longR, r + 1, longBase);
        if (longR === ra) b.idx.push(sLast, x, y);
        else b.idx.push(sLast, y, x);
      }
    }
    if (sealIn[k]! >= 0 && sealIn[k2]! >= 0) seal.idx.push(sealIn[k2]!, sealIn[k]!, sealOut[k]!, sealIn[k2]!, sealOut[k]!, sealOut[k2]!);
  }
}

// ====================================================================== simple meshes
/** A closed or open loft evaluated on a regular grid (small parts: mirrors, seats, tubes). */
export function gridLoftMesh(loft: Loft, nuSeg: number, nvSeg: number, opts: { flip?: boolean; capStart?: boolean; capEnd?: boolean } = {}): PanelMesh {
  const surf = loftSurface(loft, { flip: opts.flip });
  const b = newBuilder();
  const cols = nuSeg + 1;
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  const pu: V3 = [0, 0, 0];
  const pv: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  const pts: V3[] = [];
  for (let j = 0; j <= nvSeg; j++) {
    for (let i = 0; i <= nuSeg; i++) {
      const u = i / nuSeg;
      const v = j / nvSeg;
      surf.point(u, v, p);
      surf.frame(loft.closedU && i === nuSeg ? 0 : u, v, n, pu, pv);
      tangentFrom(n, pu, pv, t);
      pts.push([p[0], p[1], p[2]]);
      pushVert(b, loft.closedU && i === nuSeg ? pts[j * cols]! : p, n, t, handedness(n, t, pv), 0, 0);
    }
  }
  // Metric uv.
  for (let j = 0; j <= nvSeg; j++)
    for (let i = 1; i <= nuSeg; i++) {
      const a = pts[j * cols + i - 1]!;
      const c = pts[j * cols + i]!;
      b.uvs[(j * cols + i) * 2] = b.uvs[(j * cols + i - 1) * 2]! + Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    }
  for (let i = 0; i <= nuSeg; i++)
    for (let j = 1; j <= nvSeg; j++) {
      const a = pts[(j - 1) * cols + i]!;
      const c = pts[j * cols + i]!;
      b.uvs[(j * cols + i) * 2 + 1] = b.uvs[((j - 1) * cols + i) * 2 + 1]! + Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    }
  for (let j = 0; j < nvSeg; j++)
    for (let i = 0; i < nuSeg; i++) {
      const a = j * cols + i;
      const c = a + 1;
      const d = a + cols + 1;
      const e = a + cols;
      if (opts.flip) b.idx.push(a, d, c, a, e, d);
      else b.idx.push(a, c, d, a, d, e);
    }
  const cap = (j: number, dir: number): void => {
    // Fan cap around the ring centroid, facing along ∓v.
    const c: V3 = [0, 0, 0];
    for (let i = 0; i < nuSeg; i++) {
      const q = pts[j * cols + i]!;
      c[0] += q[0] / nuSeg;
      c[1] += q[1] / nuSeg;
      c[2] += q[2] / nuSeg;
    }
    const a = pts[j * cols]!;
    const bb = pts[j * cols + Math.max(1, nuSeg >> 2)]!;
    const nn = norm3(cross([a[0] - c[0], a[1] - c[1], a[2] - c[2]], [bb[0] - c[0], bb[1] - c[1], bb[2] - c[2]], [0, 0, 0]));
    // Orient the cap outward: away from the neighbouring ring.
    const other = pts[(j === 0 ? 1 : j - 1) * cols]!;
    const away: V3 = [c[0] - other[0], c[1] - other[1], c[2] - other[2]];
    let sgn = dot3(nn, away) >= 0 ? 1 : -1;
    void dir;
    const nrm: V3 = [nn[0] * sgn, nn[1] * sgn, nn[2] * sgn];
    const tt = norm3([a[0] - c[0], a[1] - c[1], a[2] - c[2]]);
    const ci = pushVert(b, c, nrm, tt, 1, 0, 0);
    const ring: number[] = [];
    for (let i = 0; i < nuSeg; i++) {
      const q = pts[j * cols + i]!;
      ring.push(pushVert(b, q, nrm, tt, 1, q[0] - c[0], q[1] - c[1]));
    }
    // Winding so the face normal agrees with nrm.
    const q0 = pts[j * cols]!;
    const q1 = pts[j * cols + 1]!;
    const fc = cross([q0[0] - c[0], q0[1] - c[1], q0[2] - c[2]], [q1[0] - c[0], q1[1] - c[1], q1[2] - c[2]], [0, 0, 0]);
    sgn = dot3(fc, nrm) >= 0 ? 1 : -1;
    for (let i = 0; i < nuSeg; i++) {
      const x = ring[i]!;
      const y = ring[(i + 1) % nuSeg]!;
      if (sgn > 0) b.idx.push(ci, x, y);
      else b.idx.push(ci, y, x);
    }
  };
  if (opts.capStart) cap(0, -1);
  if (opts.capEnd) cap(nvSeg, 1);
  return toPanelMesh(b);
}

/**
 * Rounded box: centre c, half extents h, edge radius r; 6 face grids whose
 * points are pushed onto the inner box + r (exact normals). `rot` maps the
 * local frame (applied before translation).
 */
export function roundedBoxMesh(c: Vec3T, h: Vec3T, r: number, opts: { segs?: number; flat?: number; rot?: (p: V3) => V3 } = {}): PanelMesh {
  const segs = opts.segs ?? 3;
  const flatSegs = opts.flat ?? 1;
  const rr = Math.min(r, h[0] * 0.999, h[1] * 0.999, h[2] * 0.999);
  const rot = opts.rot ?? ((p: V3): V3 => p);
  const axisSamples = (H: number): number[] => {
    const inner = H - rr;
    const out: number[] = [];
    for (let s = segs; s >= 1; s--) out.push(-(inner + rr * Math.tan(((Math.PI / 4) * s) / segs)));
    for (let s = 0; s <= flatSegs; s++) out.push(-inner + (2 * inner * s) / flatSegs);
    for (let s = 1; s <= segs; s++) out.push(inner + rr * Math.tan(((Math.PI / 4) * s) / segs));
    return out;
  };
  const b = newBuilder();
  const faces: [number, number, number, number][] = [
    // [normal axis, sign, axis a, axis b] with a × b = sign·normal
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0],
  ];
  for (const [ax, sg, aa, ab] of faces) {
    const sa = axisSamples(h[aa]!);
    const sb = axisSamples(h[ab]!);
    const base = b.pos.length / 3;
    for (let j = 0; j < sb.length; j++) {
      for (let i = 0; i < sa.length; i++) {
        const q: V3 = [0, 0, 0];
        q[ax] = sg * h[ax]!;
        q[aa] = sa[i]!;
        q[ab] = sb[j]!;
        const inner: V3 = [0, 0, 0];
        for (let k = 0; k < 3; k++) inner[k] = Math.max(-(h[k]! - rr), Math.min(h[k]! - rr, q[k]!));
        const n = norm3([q[0] - inner[0], q[1] - inner[1], q[2] - inner[2]]);
        const p: V3 = [inner[0] + rr * n[0], inner[1] + rr * n[1], inner[2] + rr * n[2]];
        const pr = rot(p);
        const nr = norm3(rot(n));
        const t0: V3 = [0, 0, 0];
        t0[aa] = 1;
        const tr = rot(t0);
        const d = dot3(tr, nr);
        const t = norm3([tr[0] - d * nr[0], tr[1] - d * nr[1], tr[2] - d * nr[2]]);
        pushVert(b, [pr[0] + c[0], pr[1] + c[1], pr[2] + c[2]], nr, t, 1, q[aa]!, q[ab]!);
      }
    }
    const cols = sa.length;
    for (let j = 0; j + 1 < sb.length; j++)
      for (let i = 0; i + 1 < cols; i++) {
        const v0 = base + j * cols + i;
        b.idx.push(v0, v0 + 1, v0 + cols + 1, v0, v0 + cols + 1, v0 + cols);
      }
  }
  return toPanelMesh(b);
}

/** Rotation helpers for roundedBoxMesh / transformMesh (radians). */
export const rotX = (a: number) => (p: V3): V3 => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
export const rotY = (a: number) => (p: V3): V3 => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];
export const rotZ = (a: number) => (p: V3): V3 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]];

/** Apply a point transform to a mesh (positions; normals/tangents by the linear part estimated numerically). */
export function transformMesh(m: PanelMesh, f: (p: V3) => V3): PanelMesh {
  const out = newBuilder();
  const n = m.position.length / 3;
  const eps = 1e-4;
  for (let i = 0; i < n; i++) {
    const p: V3 = [m.position[i * 3]!, m.position[i * 3 + 1]!, m.position[i * 3 + 2]!];
    const q = f(p);
    const tr = (d: V3): V3 => {
      const a = f([p[0] + d[0] * eps, p[1] + d[1] * eps, p[2] + d[2] * eps]);
      return [(a[0] - q[0]) / eps, (a[1] - q[1]) / eps, (a[2] - q[2]) / eps];
    };
    const nn: V3 = [m.normal[i * 3]!, m.normal[i * 3 + 1]!, m.normal[i * 3 + 2]!];
    const tt: V3 = [m.tangent[i * 4]!, m.tangent[i * 4 + 1]!, m.tangent[i * 4 + 2]!];
    // Normal transforms by the inverse transpose: rebuild from two tangent directions.
    const t1 = tr(tt);
    const t2 = tr(cross(nn, tt, [0, 0, 0]));
    const nw = norm3(cross(t1, t2, [0, 0, 0]));
    pushVert(out, q, nw, norm3(t1), m.tangent[i * 4 + 3]!, m.uv[i * 2]!, m.uv[i * 2 + 1]!);
  }
  out.idx.push(...m.index);
  return toPanelMesh(out);
}

// ====================================================================== tessellateVehicle (frozen contract)
export interface TessellateOptions {
  /** Multiplies every LoftSurface resolution (LOD1 ≈ 1.7). */
  resolutionScale?: number;
}

/** LoftSurface → PanelMesh with the documented window / inset / thickness / flip / mirrorX semantics. */
export function tessellateLoft(s: LoftSurface, opts: TessellateOptions = {}): PanelMesh {
  if (!(s.resolution > 0)) throw new Error(`loft: resolution must be > 0, got ${s.resolution}`);
  const loft = createLoft(s.sections, { closedU: s.closedU, symmetric: s.mirrorX });
  const surf = loftSurface(loft, { flip: s.flip });
  const sheet = createSheet(surf, { resolution: s.resolution * (opts.resolutionScale ?? 1) });
  const w = s.window ?? { u0: 0, u1: 1, v0: 0, v1: 1 };
  if (!(w.u0 >= 0 && w.u1 <= 1 && w.u0 < w.u1 && w.v0 >= 0 && w.v1 <= 1 && w.v0 < w.v1)) throw new Error(`loft: bad window ${JSON.stringify(w)}`);
  const windowed = s.window !== undefined;
  const inset = s.inset ?? (windowed ? VISUAL_DEFAULTS.shutGap / 2 : 0);
  const roll = Math.min(SHUT_ROLL, inset);
  const edge: EdgeStyle = inset > 0 ? { inset: inset + roll, roll, wall: roll > 0 ? 0.008 : 0, segments: roll > 0 ? 2 : 0, seal: false } : EDGE_STYLES.seam;
  const cuts: Cut[] = [];
  // Window edges get the inset; edges on a mirror centre line (x = 0) are seams, never inset.
  const edgeAt = (atBorder: boolean, onCentre: boolean): boolean => (onCentre ? !atBorder : !atBorder || inset > 0);
  if (edgeAt(w.u0 === 0, loft.symU0 && w.u0 === 0)) cuts.push(uAbove(sheet, w.u0, edge));
  if (edgeAt(w.u1 === 1, loft.symU1 && w.u1 === 1)) cuts.push(uBelow(sheet, w.u1, edge));
  if (edgeAt(w.v0 === 0, loft.symV0 && w.v0 === 0)) cuts.push(vAbove(sheet, w.v0, edge));
  if (edgeAt(w.v1 === 1, loft.symV1 && w.v1 === 1)) cuts.push(vBelow(sheet, w.v1, edge));
  const res = cutPanel({ sheet, bounds: w, cuts, corner: 0, thickness: s.thickness, mirrorX: s.mirrorX });
  return res.mesh;
}

/** Smooth area-weighted normals for an indexed mesh (vertices with bit-equal positions are NOT merged: explicit parts author their creases). */
function computeNormals(pos: ArrayLike<number>, idx: ArrayLike<number>): Float32Array {
  const n = new Float32Array(pos.length);
  for (let q = 0; q < idx.length; q += 3) {
    const a = idx[q]! * 3;
    const b = idx[q + 1]! * 3;
    const c = idx[q + 2]! * 3;
    const cr = cross([pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!], [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!], [0, 0, 0]);
    for (const v of [a, b, c]) {
      n[v] = n[v]! + cr[0];
      n[v + 1] = n[v + 1]! + cr[1];
      n[v + 2] = n[v + 2]! + cr[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 0) {
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    } else n[i + 1] = 1;
  }
  return n;
}

/** Planar uv in metres: project each vertex onto the plane ⟂ its dominant normal axis. */
function planarUv(pos: ArrayLike<number>, nrm: ArrayLike<number>): Float32Array {
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    const ax = Math.abs(nrm[i * 3]!);
    const ay = Math.abs(nrm[i * 3 + 1]!);
    const az = Math.abs(nrm[i * 3 + 2]!);
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    if (ax >= ay && ax >= az) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else if (ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  return uv;
}

/** Per-vertex tangents (xyzw) from uv derivatives, Gram–Schmidt against the normal (MikkTSpace-style accumulation). */
export function computeTangents(pos: ArrayLike<number>, nrm: ArrayLike<number>, uv: ArrayLike<number>, idx: ArrayLike<number>): Float32Array {
  const nv = pos.length / 3;
  const tan = new Float64Array(nv * 3);
  const bit = new Float64Array(nv * 3);
  for (let q = 0; q < idx.length; q += 3) {
    const i0 = idx[q]!;
    const i1 = idx[q + 1]!;
    const i2 = idx[q + 2]!;
    const e1 = [pos[i1 * 3]! - pos[i0 * 3]!, pos[i1 * 3 + 1]! - pos[i0 * 3 + 1]!, pos[i1 * 3 + 2]! - pos[i0 * 3 + 2]!];
    const e2 = [pos[i2 * 3]! - pos[i0 * 3]!, pos[i2 * 3 + 1]! - pos[i0 * 3 + 1]!, pos[i2 * 3 + 2]! - pos[i0 * 3 + 2]!];
    const du1 = uv[i1 * 2]! - uv[i0 * 2]!;
    const dv1 = uv[i1 * 2 + 1]! - uv[i0 * 2 + 1]!;
    const du2 = uv[i2 * 2]! - uv[i0 * 2]!;
    const dv2 = uv[i2 * 2 + 1]! - uv[i0 * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-14)) continue;
    const r = 1 / det;
    for (let k = 0; k < 3; k++) {
      const t = (e1[k]! * dv2 - e2[k]! * dv1) * r;
      const b = (e2[k]! * du1 - e1[k]! * du2) * r;
      for (const i of [i0, i1, i2]) {
        tan[i * 3 + k] = tan[i * 3 + k]! + t;
        bit[i * 3 + k] = bit[i * 3 + k]! + b;
      }
    }
  }
  const out = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const n: V3 = [nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!];
    const t: V3 = [tan[i * 3]!, tan[i * 3 + 1]!, tan[i * 3 + 2]!];
    const d = dot3(t, n);
    t[0] -= d * n[0];
    t[1] -= d * n[1];
    t[2] -= d * n[2];
    if (!(Math.hypot(t[0], t[1], t[2]) > 1e-12)) {
      const ax = Math.abs(n[0]) < 0.9 ? 1 : 0;
      t[0] = ax;
      t[1] = 1 - ax;
      t[2] = 0;
      const e = dot3(t, n);
      t[0] -= e * n[0];
      t[1] -= e * n[1];
      t[2] -= e * n[2];
    }
    norm3(t);
    const c = cross(n, t, [0, 0, 0]);
    const w = dot3(c, [bit[i * 3]!, bit[i * 3 + 1]!, bit[i * 3 + 2]!]) < 0 ? -1 : 1;
    out.set([t[0], t[1], t[2], w], i * 4);
  }
  return out;
}

function meshToGeometry(panelId: string, s: MeshSurface): PanelGeometry {
  const nv = s.position.length / 3;
  if (!Number.isInteger(nv) || nv === 0) throw new Error(`panel ${panelId}: mesh position length ${s.position.length} is not a positive multiple of 3`);
  for (const i of s.index) if (!(i >= 0 && i < nv && Number.isInteger(i))) throw new Error(`panel ${panelId}: index ${i} out of range`);
  if (s.index.length % 3 !== 0) throw new Error(`panel ${panelId}: index length ${s.index.length} not a multiple of 3`);
  const position = new Float32Array(s.position.length);
  for (let i = 0; i < s.position.length; i++) {
    const x = s.position[i]!;
    if (!Number.isFinite(x)) throw new Error(`panel ${panelId}: position ${i} is not finite`);
    position[i] = x === 0 ? 0 : x;
  }
  const index = Uint32Array.from(s.index);
  let normal: Float32Array;
  if (s.normal && s.normal.length === s.position.length) {
    normal = new Float32Array(s.normal.length);
    for (let i = 0; i < s.normal.length; i += 3) {
      const l = Math.hypot(s.normal[i]!, s.normal[i + 1]!, s.normal[i + 2]!) || 1;
      normal[i] = s.normal[i]! / l;
      normal[i + 1] = s.normal[i + 1]! / l;
      normal[i + 2] = s.normal[i + 2]! / l;
    }
  } else normal = computeNormals(position, index);
  const uv = s.uv && s.uv.length === nv * 2 ? Float32Array.from(s.uv) : planarUv(position, normal);
  const tangent = computeTangents(position, normal, uv, index);
  return { panelId, position, normal, uv, tangent, index, damageWeight: null };
}

/** Tessellate one surface spec (pure). */
export function tessellateSurface(panelId: string, s: SurfaceSpec, opts: TessellateOptions = {}): PanelGeometry {
  if (s.type === 'mesh') return meshToGeometry(panelId, s);
  if (s.type === 'loft') {
    let m: PanelMesh;
    try {
      m = tessellateLoft(s, opts);
    } catch (e) {
      throw new Error(`panel ${panelId}: ${(e as Error).message}`);
    }
    if (m.index.length === 0) throw new Error(`panel ${panelId}: loft produced no triangles`);
    return meshToGeometry(panelId, { type: 'mesh', position: m.position, index: m.index, normal: m.normal, uv: m.uv });
  }
  throw new Error(`panel ${panelId}: unknown surface type`);
}

/** (def) → one PanelGeometry per PanelDef, same order. Pure, deterministic; throws Error on malformed specs. */
export function tessellateVehicle(def: VehicleVisualDef, opts: TessellateOptions = {}): PanelGeometry[] {
  const seen = new Set<string>();
  return def.panels.map((p) => {
    if (!/^[A-Za-z0-9_]+$/.test(p.id)) throw new Error(`panel id '${p.id}' must match [A-Za-z0-9_]+`);
    if (seen.has(p.id)) throw new Error(`duplicate panel id '${p.id}'`);
    seen.add(p.id);
    return tessellateSurface(p.id, p.surface, opts);
  });
}
