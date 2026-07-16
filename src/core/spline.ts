/**
 * Centripetal Catmull-Rom spline over [x,y,z] control points, open or closed.
 * Drives roads, terrain carving and AI routes — accuracy first, but query
 * paths (position/tangent/posAtDistance/closestPoint) allocate nothing:
 * scratch buffers live in the factory closure and results reuse caller- or
 * factory-owned storage.
 *
 * Parameterization: global t ∈ [0,1] maps uniformly over segments (clamped
 * when open, wrapped when closed). Within a segment, the centripetal knot
 * spacing (alpha = 0.5) is used via the Barry-Goldman recursive formulation,
 * which avoids cusps/self-intersections on uneven control spacing.
 */

import type { Vec3, Vec3Like } from './math';
import { clamp, vec3Normalize } from './math';

export interface ArcTable {
  /** Total arc length in meters (approximated by the sample chords). */
  readonly length: number;
  /** Position at arc distance s (clamped when open, wrapped when closed). */
  posAtDistance<T extends Vec3Like>(s: number, out: T): T;
  /** Spline parameter t for arc distance s. */
  tAtDistance(s: number): number;
}

export interface ClosestPointResult {
  t: number;
  distance: number;
  /** Reused scratch — copy it if you need to retain it across calls. */
  point: Vec3;
}

export interface Spline {
  readonly closed: boolean;
  readonly segmentCount: number;
  position<T extends Vec3Like>(t: number, out: T): T;
  /** Normalized tangent (unit direction of travel) at t. */
  tangent<T extends Vec3Like>(t: number, out: T): T;
  buildArcTable(samples?: number): ArcTable;
  /**
   * Nearest point on the spline to p: coarse scan over `coarseSamples`
   * params, then golden-section refinement. The coarse scan must be dense
   * enough to land in the basin of the true minimum for multi-lobed curves.
   * The returned object (and its `point`) is reused across calls.
   */
  closestPoint(p: Vec3Like, coarseSamples?: number, refineIters?: number): ClosestPointResult;
}

// Floor for knot intervals so coincident control points cannot divide by zero.
const KNOT_EPS = 1e-6;

export function createSpline(controlPoints: readonly Vec3Like[], closed = false): Spline {
  const n = controlPoints.length;
  if (n < (closed ? 3 : 2)) {
    throw new RangeError(`spline needs at least ${closed ? 3 : 2} control points`);
  }
  const segmentCount = closed ? n : n - 1;

  // Private copy: immune to caller mutating the source arrays afterwards.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = controlPoints[i] as Vec3Like;
    px[i] = p[0] as number;
    py[i] = p[1] as number;
    pz[i] = p[2] as number;
  }

  // --- scratch (factory-owned; queries never allocate) --------------------
  const s0: Vec3 = [0, 0, 0];
  const s1: Vec3 = [0, 0, 0];
  const s2: Vec3 = [0, 0, 0];
  const s3: Vec3 = [0, 0, 0];
  const a1: Vec3 = [0, 0, 0];
  const a2: Vec3 = [0, 0, 0];
  const a3: Vec3 = [0, 0, 0];
  const b1: Vec3 = [0, 0, 0];
  const b2: Vec3 = [0, 0, 0];
  const da1: Vec3 = [0, 0, 0];
  const da2: Vec3 = [0, 0, 0];
  const da3: Vec3 = [0, 0, 0];
  const db1: Vec3 = [0, 0, 0];
  const db2: Vec3 = [0, 0, 0];
  const qPos: Vec3 = [0, 0, 0];
  const closestResult: ClosestPointResult = { t: 0, distance: 0, point: [0, 0, 0] };

  const getPoint = (idx: number, out: Vec3): void => {
    if (closed) {
      const i = ((idx % n) + n) % n;
      out[0] = px[i] as number;
      out[1] = py[i] as number;
      out[2] = pz[i] as number;
      return;
    }
    if (idx < 0) {
      // Linear extrapolation phantom: keeps end knots non-degenerate.
      out[0] = 2 * (px[0] as number) - (px[1] as number);
      out[1] = 2 * (py[0] as number) - (py[1] as number);
      out[2] = 2 * (pz[0] as number) - (pz[1] as number);
      return;
    }
    if (idx > n - 1) {
      out[0] = 2 * (px[n - 1] as number) - (px[n - 2] as number);
      out[1] = 2 * (py[n - 1] as number) - (py[n - 2] as number);
      out[2] = 2 * (pz[n - 1] as number) - (pz[n - 2] as number);
      return;
    }
    out[0] = px[idx] as number;
    out[1] = py[idx] as number;
    out[2] = pz[idx] as number;
  };

  // Centripetal knot interval: |Pb - Pa|^0.5, floored to stay non-degenerate.
  const knotStep = (pa: Vec3, pb: Vec3): number => {
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const dz = pb[2] - pa[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Math.max(Math.sqrt(dist), KNOT_EPS);
  };

  const lerpKnot = (out: Vec3, x: Vec3, y: Vec3, ta: number, tb: number, tq: number): void => {
    const inv = 1 / (tb - ta);
    const wa = (tb - tq) * inv;
    const wb = (tq - ta) * inv;
    out[0] = wa * x[0] + wb * y[0];
    out[1] = wa * x[1] + wb * y[1];
    out[2] = wa * x[2] + wb * y[2];
  };

  /** Map global t to fractional segment coordinate f ∈ [0, segmentCount]. */
  const paramToF = (t: number): number => {
    if (closed) {
      t -= Math.floor(t);
    } else {
      t = clamp(t, 0, 1);
    }
    return t * segmentCount;
  };

  /**
   * Barry-Goldman evaluation with analytic first derivative (w.r.t. the knot
   * parameter — direction only; callers normalize).
   */
  const evaluate = (t: number, outPos: Vec3Like | null, outTan: Vec3Like | null): void => {
    const f = paramToF(t);
    let seg = Math.floor(f);
    if (seg > segmentCount - 1) seg = segmentCount - 1;
    const u = f - seg;

    getPoint(seg - 1, s0);
    getPoint(seg, s1);
    getPoint(seg + 1, s2);
    getPoint(seg + 2, s3);

    const d01 = knotStep(s0, s1);
    const d12 = knotStep(s1, s2);
    const d23 = knotStep(s2, s3);
    const t0 = 0;
    const t1 = d01;
    const t2 = d01 + d12;
    const t3 = d01 + d12 + d23;
    const tq = t1 + u * d12;

    lerpKnot(a1, s0, s1, t0, t1, tq);
    lerpKnot(a2, s1, s2, t1, t2, tq);
    lerpKnot(a3, s2, s3, t2, t3, tq);
    lerpKnot(b1, a1, a2, t0, t2, tq);
    lerpKnot(b2, a2, a3, t1, t3, tq);

    if (outPos !== null) {
      lerpKnot(qPos, b1, b2, t1, t2, tq);
      outPos[0] = qPos[0];
      outPos[1] = qPos[1];
      outPos[2] = qPos[2];
    }

    if (outTan !== null) {
      // dA_i = (P_{i+1} - P_i) / knot interval
      const i01 = 1 / d01;
      const i12 = 1 / d12;
      const i23 = 1 / d23;
      da1[0] = (s1[0] - s0[0]) * i01;
      da1[1] = (s1[1] - s0[1]) * i01;
      da1[2] = (s1[2] - s0[2]) * i01;
      da2[0] = (s2[0] - s1[0]) * i12;
      da2[1] = (s2[1] - s1[1]) * i12;
      da2[2] = (s2[2] - s1[2]) * i12;
      da3[0] = (s3[0] - s2[0]) * i23;
      da3[1] = (s3[1] - s2[1]) * i23;
      da3[2] = (s3[2] - s2[2]) * i23;
      // dB = ((tb-tq)·dX + (tq-ta)·dY + Y - X) / (tb-ta)
      const iB1 = 1 / (t2 - t0);
      const iB2 = 1 / (t3 - t1);
      db1[0] = ((t2 - tq) * da1[0] + (tq - t0) * da2[0] + a2[0] - a1[0]) * iB1;
      db1[1] = ((t2 - tq) * da1[1] + (tq - t0) * da2[1] + a2[1] - a1[1]) * iB1;
      db1[2] = ((t2 - tq) * da1[2] + (tq - t0) * da2[2] + a2[2] - a1[2]) * iB1;
      db2[0] = ((t3 - tq) * da2[0] + (tq - t1) * da3[0] + a3[0] - a2[0]) * iB2;
      db2[1] = ((t3 - tq) * da2[1] + (tq - t1) * da3[1] + a3[1] - a2[1]) * iB2;
      db2[2] = ((t3 - tq) * da2[2] + (tq - t1) * da3[2] + a3[2] - a2[2]) * iB2;
      const iC = 1 / (t2 - t1);
      outTan[0] = ((t2 - tq) * db1[0] + (tq - t1) * db2[0] + b2[0] - b1[0]) * iC;
      outTan[1] = ((t2 - tq) * db1[1] + (tq - t1) * db2[1] + b2[1] - b1[1]) * iC;
      outTan[2] = ((t2 - tq) * db1[2] + (tq - t1) * db2[2] + b2[2] - b1[2]) * iC;
    }
  };

  const position = <T extends Vec3Like>(t: number, out: T): T => {
    evaluate(t, out, null);
    return out;
  };

  const tangent = <T extends Vec3Like>(t: number, out: T): T => {
    evaluate(t, null, out);
    return vec3Normalize(out, out);
  };

  const buildArcTable = (samples = 256): ArcTable => {
    if (samples < 1) throw new RangeError('buildArcTable: samples must be >= 1');
    const cum = new Float64Array(samples + 1);
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    let acc = 0;
    for (let i = 0; i <= samples; i++) {
      evaluate(i / samples, qPos, null);
      if (i > 0) {
        const dx = qPos[0] - prevX;
        const dy = qPos[1] - prevY;
        const dz = qPos[2] - prevZ;
        acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      cum[i] = acc;
      prevX = qPos[0];
      prevY = qPos[1];
      prevZ = qPos[2];
    }
    const total = acc;

    const tAtDistance = (s: number): number => {
      if (total === 0) return 0;
      if (closed) {
        s = ((s % total) + total) % total;
      } else {
        s = clamp(s, 0, total);
      }
      // Largest sample index with cum[lo] <= s.
      let lo = 0;
      let hi = samples;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((cum[mid] as number) <= s) lo = mid;
        else hi = mid - 1;
      }
      if (lo >= samples) return 1;
      const c0 = cum[lo] as number;
      const c1 = cum[lo + 1] as number;
      const frac = c1 > c0 ? (s - c0) / (c1 - c0) : 0;
      return (lo + frac) / samples;
    };

    const posAtDistance = <T extends Vec3Like>(s: number, out: T): T =>
      position(tAtDistance(s), out);

    return { length: total, posAtDistance, tAtDistance };
  };

  const distSqAt = (t: number, p: Vec3Like): number => {
    evaluate(t, qPos, null);
    const dx = qPos[0] - (p[0] as number);
    const dy = qPos[1] - (p[1] as number);
    const dz = qPos[2] - (p[2] as number);
    return dx * dx + dy * dy + dz * dz;
  };

  const GOLDEN = 0.6180339887498949;

  const closestPoint = (p: Vec3Like, coarseSamples = 64, refineIters = 32): ClosestPointResult => {
    // Coarse scan to land in the basin of the global minimum.
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i <= coarseSamples; i++) {
      const d = distSqAt(i / coarseSamples, p);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const step = 1 / coarseSamples;
    // For closed splines the bracket may cross t=0/1; evaluate() wraps.
    let lo = bestI * step - step;
    let hi = bestI * step + step;
    if (!closed) {
      lo = Math.max(0, lo);
      hi = Math.min(1, hi);
    }
    // Golden-section over the unimodal bracket.
    let x1 = hi - GOLDEN * (hi - lo);
    let x2 = lo + GOLDEN * (hi - lo);
    let f1 = distSqAt(x1, p);
    let f2 = distSqAt(x2, p);
    for (let k = 0; k < refineIters; k++) {
      if (f1 <= f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - GOLDEN * (hi - lo);
        f1 = distSqAt(x1, p);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + GOLDEN * (hi - lo);
        f2 = distSqAt(x2, p);
      }
    }
    let tBest = (lo + hi) * 0.5;
    if (closed) tBest -= Math.floor(tBest);
    else tBest = clamp(tBest, 0, 1);

    closestResult.t = tBest;
    closestResult.distance = Math.sqrt(distSqAt(tBest, p));
    closestResult.point[0] = qPos[0];
    closestResult.point[1] = qPos[1];
    closestResult.point[2] = qPos[2];
    return closestResult;
  };

  return { closed, segmentCount, position, tangent, buildArcTable, closestPoint };
}
