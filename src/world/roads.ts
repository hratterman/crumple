/**
 * Road profiles (A): resolution of RoadDefs into RoadProfiles (stations every
 * ROAD_STATION_SPACING m) plus the allocation-free query helpers sampleRoad /
 * projectToRoad that ribbons (E), AI and spawns use.
 *
 * Resolution pipeline per road (see PROFILE RESOLUTION in types.ts):
 *   1. null control-point y → disc average of the pre-road terrain;
 *   2. centreline = createSpline(points, closed); stations by arc length;
 *      stations between two null control points follow the (disc-averaged)
 *      terrain itself rather than the spline's interpolated y, so a
 *      terrain-following road hugs crests and dips between its controls;
 *   3. curvature from the plan tangents; bank ∝ curvature, 30 m average;
 *   4. roads resolve by priority DESC: vertical moving average, junction
 *      easing onto the already-resolved partner's surface (bank faded),
 *      grade limit at 0.95·maxGrade with the junction stations pinned
 *      (Lipschitz envelope midpoint: exact at pins, never above the limit),
 *      a second light smoothing, re-pin, and a final limiter pass.
 * Numerics: only + − × ÷ sqrt floor abs min max (DETERMINISM in types.ts).
 */
import { createSpline } from '../core/spline';
import {
  JUNCTION_EASE_M,
  ROAD_KIND_DEFAULTS,
  ROAD_STATION_SPACING,
  ROAD_STATION_STRIDE,
  WorldLayoutError,
  type RoadDef,
  type RoadStructure,
  type RoadKindDefaults,
  type RoadProfile,
  type RoadProjection,
  type RoadSample,
  type WorldLayout,
} from './types';

const SP = ROAD_STATION_SPACING;
const STRIDE = ROAD_STATION_STRIDE;

export function createRoadSample(): RoadSample {
  return { s: 0, x: 0, y: 0, z: 0, tx: 0, tz: -1, rx: 1, rz: 0, bank: 0, curvature: 0 };
}

export function createRoadProjection(): RoadProjection {
  return { s: 0, d: 0, dist: 0, y: 0 };
}

/** Arc length of segment i (station i → i+1, wrapping on closed roads). */
function segLength(road: RoadProfile, i: number): number {
  const n = road.stationCount;
  if (road.closed) return i === n - 1 ? road.length - (n - 1) * SP : SP;
  return i === n - 2 ? road.length - (n - 2) * SP : SP;
}

/** Station-polyline sample at arc distance s (clamped open, wrapped closed). Allocation-free. */
export function sampleRoad(road: RoadProfile, s: number, out: RoadSample): RoadSample {
  const n = road.stationCount;
  const st = road.stations;
  const len = road.length;
  let i: number;
  let j: number;
  if (road.closed) {
    s = s - Math.floor(s / len) * len;
    if (s >= len) s = 0;
    i = Math.floor(s / SP);
    if (i > n - 1) i = n - 1;
    j = i + 1 === n ? 0 : i + 1;
  } else {
    s = s < 0 ? 0 : s > len ? len : s;
    i = Math.floor(s / SP);
    if (i > n - 2) i = n - 2;
    j = i + 1;
  }
  const sl = segLength(road, i);
  let u = sl > 0 ? (s - i * SP) / sl : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const a = i * STRIDE;
  const b = j * STRIDE;
  const v = 1 - u;
  out.s = s;
  out.x = st[a]! * v + st[b]! * u;
  out.y = st[a + 1]! * v + st[b + 1]! * u;
  out.z = st[a + 2]! * v + st[b + 2]! * u;
  let tx = st[a + 3]! * v + st[b + 3]! * u;
  let tz = st[a + 4]! * v + st[b + 4]! * u;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl > 1e-12) {
    tx /= tl;
    tz /= tl;
  } else {
    tx = st[a + 3]!;
    tz = st[a + 4]!;
  }
  out.tx = tx;
  out.tz = tz;
  out.rx = -tz;
  out.rz = tx;
  out.bank = st[a + 5]! * v + st[b + 5]! * u;
  out.curvature = st[a + 6]! * v + st[b + 6]! * u;
  return out;
}

const wrapIdx = (segs: number, closed: boolean, k: number): number => (closed ? ((k % segs) + segs) % segs : k);

/** Window (segments each side) of the hinted local search. */
const HINT_WINDOW = 24;

function segDist2(st: Float64Array, i: number, j: number, x: number, z: number): number {
  const a = i * STRIDE;
  const b = j * STRIDE;
  const ax = st[a]!;
  const az = st[a + 2]!;
  const ex = st[b]! - ax;
  const ez = st[b + 2]! - az;
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x - ax - t * ex;
  const qz = z - az - t * ez;
  return qx * qx + qz * qz;
}

/**
 * Closest centreline point in plan view. Without `hintS` every segment is
 * tested; with it, a ±24-segment window around the hint, extended while the
 * best hit sits on the window edge (per-frame tracking). Allocation-free.
 */
export function projectToRoad(
  road: RoadProfile,
  x: number,
  z: number,
  out: RoadProjection,
  hintS?: number,
): RoadProjection {
  const n = road.stationCount;
  const st = road.stations;
  const closed = road.closed;
  const segs = closed ? n : n - 1;
  let best = -1;
  let bestD = Infinity;
  if (hintS !== undefined && segs > 2 * HINT_WINDOW + 1 && Number.isFinite(hintS)) {
    let h = Math.floor(hintS / SP);
    if (closed) h = ((h % segs) + segs) % segs;
    else h = h < 0 ? 0 : h > segs - 1 ? segs - 1 : h;
    let lo = h - HINT_WINDOW;
    let hi = h + HINT_WINDOW;
    if (!closed) {
      if (lo < 0) lo = 0;
      if (hi > segs - 1) hi = segs - 1;
    }
    for (let k = lo; k <= hi; k++) {
      const i = wrapIdx(segs, closed, k);
      const d = segDist2(st, i, i + 1 === n ? 0 : i + 1, x, z);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    // Walk outwards while the optimum is pinned to the window edge.
    let guard = segs;
    while (best === lo && (closed || lo > 0) && guard-- > 0) {
      lo--;
      const i = wrapIdx(segs, closed, lo);
      const d = segDist2(st, i, i + 1 === n ? 0 : i + 1, x, z);
      if (d < bestD) {
        bestD = d;
        best = lo;
      } else break;
    }
    guard = segs;
    while (best === hi && (closed || hi < segs - 1) && guard-- > 0) {
      hi++;
      const i = wrapIdx(segs, closed, hi);
      const d = segDist2(st, i, i + 1 === n ? 0 : i + 1, x, z);
      if (d < bestD) {
        bestD = d;
        best = hi;
      } else break;
    }
    best = wrapIdx(segs, closed, best);
  } else {
    for (let i = 0; i < segs; i++) {
      const d = segDist2(st, i, i + 1 === n ? 0 : i + 1, x, z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  const i = best;
  const j = i + 1 === n ? 0 : i + 1;
  const a = i * STRIDE;
  const b = j * STRIDE;
  const ax = st[a]!;
  const az = st[a + 2]!;
  const ex = st[b]! - ax;
  const ez = st[b + 2]! - az;
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x - ax - t * ex;
  const qz = z - az - t * ez;
  const v = 1 - t;
  let tx = st[a + 3]! * v + st[b + 3]! * t;
  let tz = st[a + 4]! * v + st[b + 4]! * t;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl > 1e-12) {
    tx /= tl;
    tz /= tl;
  }
  const d = qx * -tz + qz * tx;
  const sl = segLength(road, i);
  out.s = i * SP + t * sl;
  if (closed && out.s >= road.length) out.s -= road.length;
  out.d = d;
  out.dist = Math.sqrt(qx * qx + qz * qz);
  out.y = st[a + 1]! * v + st[b + 1]! * t + (st[a + 5]! * v + st[b + 5]! * t) * d;
  return out;
}

/**
 * atan2(y, x) from + − × ÷ sqrt only (range reduction to |u| ≤ tan 15° and
 * an odd series; |error| < 1e-9 rad). Deterministic across engines.
 */
export function detAtan2(y: number, x: number): number {
  const PI = 3.141592653589793;
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  // atan of r = min/max ∈ [0, 1]
  const swap = ay > ax;
  let r = swap ? ax / ay : ay / ax;
  let base = 0;
  const T15 = 0.2679491924311227; // tan(π/12)
  if (r > T15) {
    const S3 = 1.7320508075688772;
    r = (r * S3 - 1) / (r + S3);
    base = PI / 6;
  }
  const r2 = r * r;
  // atan(r) = r − r³/3 + r⁵/5 − … (|r| ≤ 0.268: 9 terms → < 1e-11)
  let term = r;
  let sum = r;
  for (let k = 1; k <= 9; k++) {
    term *= -r2;
    sum += term / (2 * k + 1);
  }
  let a = base + sum;
  if (swap) a = PI / 2 - a;
  if (x < 0) a = PI - a;
  if (y < 0) a = -a;
  return a;
}

/** Yaw (about +Y; 0 faces −Z, π/2 faces −X) of the plan heading (hx, hz). */
export function headingToYaw(hx: number, hz: number): number {
  return detAtan2(-hx, -hz);
}

// =========================================================== resolution
/** Vertical smoothing window (moving average, m) per road kind — internal tuning. */
const VERTICAL_SMOOTH_M: Readonly<Record<RoadDef['kind'], number>> = {
  highway: 140,
  country: 60,
  mountain: 26,
  street: 30,
  arena: 30,
  dirt: 14,
  track: 40,
};
/** Grade limiter target as a fraction of maxGrade (margin for the second smoothing). */
const GRADE_MARGIN = 0.95;
const BANK_AVG_M = 30;
const CURVATURE_AVG_M = 8;
/** Bank fades to 0 over this distance at open road ends, m. */
const END_FLAT_M = 20;

interface RoadWork {
  def: RoadDef;
  kd: RoadKindDefaults;
  index: number;
  n: number;
  length: number;
  s: Float64Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
  bank: Float64Array;
  curv: Float64Array;
  profile: RoadProfile | null;
}

/** Disc average of `heightAt` (radius r) on a fixed 37-point pattern. */
export function discAverage(heightAt: (x: number, z: number) => number, x: number, z: number, r: number): number {
  let sum = 0;
  let cnt = 0;
  const step = r / 3;
  for (let j = -3; j <= 3; j++) {
    for (let i = -3; i <= 3; i++) {
      if (i * i + j * j > 10) continue;
      sum += heightAt(x + i * step, z + j * step);
      cnt++;
    }
  }
  return sum / cnt;
}

/** Symmetric moving average (window m) — open ends shrink the window so endpoints keep their value. */
function movingAverage(v: Float64Array, n: number, closed: boolean, windowM: number, tmp: Float64Array): void {
  const k = Math.floor(windowM / (2 * SP) + 0.5);
  if (k < 1) return;
  for (let i = 0; i < n; i++) {
    let kk = k;
    if (!closed) {
      if (kk > i) kk = i;
      if (kk > n - 1 - i) kk = n - 1 - i;
    } else if (2 * kk + 1 > n) {
      kk = (n - 1) >> 1;
    }
    let sum = 0;
    for (let o = -kk; o <= kk; o++) {
      let q = i + o;
      if (closed) q = q < 0 ? q + n : q >= n ? q - n : q;
      sum += v[q]!;
    }
    tmp[i] = sum / (2 * kk + 1);
  }
  v.set(tmp.subarray(0, n));
}

/** Arc gap from station i−1 to i (i = 0 on closed: the wrap gap). */
function gapBefore(w: RoadWork, i: number): number {
  if (i === 0) return w.length - w.s[w.n - 1]!;
  return w.s[i]! - w.s[i - 1]!;
}

/** Plan (horizontal) distance from station i−1 to i (i = 0 on closed: the wrap gap) — grades are rise / plan run. */
function planGap(w: RoadWork, i: number): number {
  const p = i === 0 ? w.n - 1 : i - 1;
  const dx = w.x[i]! - w.x[p]!;
  const dz = w.z[i]! - w.z[p]!;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Lipschitz sweeps along the road: env[i] = min_j (src[j] + g·dist(i, j))
 * (sign = +1) or max_j (src[j] − g·dist) (sign = −1). Two laps each way on
 * closed roads give the exact circular distance.
 */
function envelope(w: RoadWork, src: Float64Array, out: Float64Array, g: number, sign: number): void {
  const n = w.n;
  const closed = w.def.closed;
  out.set(src.subarray(0, n));
  const laps = closed ? 2 : 1;
  for (let lap = 0; lap < laps; lap++) {
    for (let i = closed ? 0 : 1; i < n; i++) {
      const p = i === 0 ? n - 1 : i - 1;
      const c = out[p]! + sign * g * planGap(w, i);
      if (sign > 0 ? c < out[i]! : c > out[i]!) out[i] = c;
    }
  }
  for (let lap = 0; lap < laps; lap++) {
    for (let i = closed ? n - 1 : n - 2; i >= 0; i--) {
      const q = i === n - 1 ? 0 : i + 1;
      const c = out[q]! + sign * g * planGap(w, q);
      if (sign > 0 ? c < out[i]! : c > out[i]!) out[i] = c;
    }
  }
}

/** Grade limit: clamp to pinned stations' cones, then the envelope midpoint. */
function limitGrade(w: RoadWork, g: number, pinned: Uint8Array, s1: Float64Array, s2: Float64Array, s3: Float64Array): void {
  const n = w.n;
  const y = w.y;
  let anyPin = false;
  for (let i = 0; i < n; i++) if (pinned[i]) anyPin = true;
  if (anyPin) {
    for (let i = 0; i < n; i++) s3[i] = pinned[i] ? y[i]! : Infinity;
    envelope(w, s3, s1, g, 1);
    for (let i = 0; i < n; i++) s3[i] = pinned[i] ? y[i]! : -Infinity;
    envelope(w, s3, s2, g, -1);
    for (let i = 0; i < n; i++) {
      const v = y[i]!;
      y[i] = v < s2[i]! ? s2[i]! : v > s1[i]! ? s1[i]! : v;
    }
  }
  envelope(w, y, s1, g, 1);
  envelope(w, y, s2, g, -1);
  for (let i = 0; i < n; i++) y[i] = pinned[i] ? y[i]! : 0.5 * (s1[i]! + s2[i]!);
}

function packProfile(w: RoadWork): RoadProfile {
  const n = w.n;
  const st = new Float64Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    st[o] = w.x[i]!;
    st[o + 1] = w.y[i]!;
    st[o + 2] = w.z[i]!;
    st[o + 3] = w.tx[i]!;
    st[o + 4] = w.tz[i]!;
    st[o + 5] = w.bank[i]!;
    st[o + 6] = w.curv[i]!;
  }
  const d = w.def;
  return {
    id: d.id,
    kind: d.kind,
    closed: d.closed,
    width: d.width,
    lanes: d.lanes,
    shoulder: d.shoulder,
    material: d.material,
    markings: d.markings,
    surface: w.kd.surface,
    length: w.length,
    stationCount: n,
    stations: st,
  };
}

/**
 * Layout v6: copies the road's oneWay / sidewalk / wear and resolves its structure spans
 * (RoadStructureDef from / to projected onto the finished centreline; s0 < s1, ascending s0).
 */
function decorateProfile(p: RoadProfile, def: RoadDef): RoadProfile {
  if (def.oneWay) p.oneWay = true;
  if (def.sidewalk) p.sidewalk = { width: def.sidewalk.width, kerb: def.sidewalk.kerb };
  if (def.wear) p.wear = def.wear;
  if (def.structures && def.structures.length > 0) {
    const proj = createRoadProjection();
    const spans: RoadStructure[] = def.structures.map((st) => {
      const a = projectToRoad(p, st.from[0], st.from[1], proj).s;
      const b = projectToRoad(p, st.to[0], st.to[1], proj).s;
      if (!(Math.abs(b - a) > 4)) throw new WorldLayoutError(`roads '${def.id}': structure '${st.id}' spans ${Math.abs(b - a).toFixed(1)} m (min 4)`);
      return { id: st.id, kind: st.kind, s0: a < b ? a : b, s1: a < b ? b : a };
    });
    spans.sort((u, v) => u.s0 - v.s0);
    for (let k = 1; k < spans.length; k++) {
      if (spans[k]!.s0 < spans[k - 1]!.s1) throw new WorldLayoutError(`roads '${def.id}': structures '${spans[k - 1]!.id}' and '${spans[k]!.id}' overlap`);
    }
    p.structures = spans;
  }
  return p;
}

/** The structure span containing road arc s (layout v6), or null. */
export function structureAt(p: RoadProfile, s: number): RoadStructure | null {
  const sp = p.structures;
  if (!sp) return null;
  for (const st of sp) if (s >= st.s0 && s <= st.s1) return st;
  return null;
}

/** Writes the through road's carriageway surface (verge-level clamp) at (x, z) for easing. */
function throughSurface(p: RoadProfile, x: number, z: number, proj: RoadProjection, smp: RoadSample): number {
  projectToRoad(p, x, z, proj);
  sampleRoad(p, proj.s, smp);
  const a = p.width / 2;
  const d = proj.d < -a ? -a : proj.d > a ? a : proj.d;
  return smp.y + smp.bank * d;
}

/** Junction position tolerance (m): the contract's 1 m plus station chord error. */
export const JUNCTION_TOLERANCE_M = 1.05;

/**
 * Resolve every RoadDef of `layout` into a RoadProfile (layout order) on the
 * pre-road terrain `heightAt` (bilinear). Throws WorldLayoutError when a
 * junction's road misses its position.
 */
export function resolveRoadProfiles(
  layout: WorldLayout,
  heightAt: (x: number, z: number) => number,
): RoadProfile[] {
  const works: RoadWork[] = [];
  const pt: [number, number, number] = [0, 0, 0];
  const tan: [number, number, number] = [0, 0, 0];
  let maxN = 0;

  layout.roads.forEach((def, index) => {
    const kd = ROAD_KIND_DEFAULTS[def.kind];
    const m = def.points.length;
    const isNull = new Uint8Array(m);
    const ctrl: [number, number, number][] = def.points.map((p, k) => {
      if (p[1] === null) {
        isNull[k] = 1;
        return [p[0], discAverage(heightAt, p[0], p[2], kd.smoothRadius), p[2]];
      }
      return [p[0], p[1], p[2]];
    });
    const spline = createSpline(ctrl, def.closed);
    let poly = 0;
    for (let k = 1; k < m; k++) {
      const a = ctrl[k - 1]!;
      const b = ctrl[k]!;
      const ex = b[0] - a[0];
      const ez = b[2] - a[2];
      poly += Math.sqrt(ex * ex + ez * ez);
    }
    const arc = spline.buildArcTable(Math.max(spline.segmentCount * 64, Math.ceil(poly * 2.5)));
    const length = arc.length;
    if (!(length > 2 * SP)) throw new WorldLayoutError(`roads '${def.id}': too short (${length.toFixed(2)} m)`);
    let n: number;
    if (def.closed) {
      n = Math.ceil(length / SP);
      if (length - (n - 1) * SP < 0.25) n--;
    } else {
      n = Math.ceil(length / SP) + 1;
      if (length - (n - 2) * SP < 0.25) n--;
    }
    const w: RoadWork = {
      def,
      kd,
      index,
      n,
      length,
      s: new Float64Array(n),
      x: new Float64Array(n),
      y: new Float64Array(n),
      z: new Float64Array(n),
      tx: new Float64Array(n),
      tz: new Float64Array(n),
      bank: new Float64Array(n),
      curv: new Float64Array(n),
      profile: null,
    };
    const segCount = spline.segmentCount;
    for (let i = 0; i < n; i++) {
      const s = !def.closed && i === n - 1 ? length : i * SP;
      w.s[i] = s;
      const t = arc.tAtDistance(s);
      spline.position(t, pt);
      spline.tangent(t, tan);
      w.x[i] = pt[0];
      w.z[i] = pt[2];
      let hx = tan[0];
      let hz = tan[2];
      const hl = Math.sqrt(hx * hx + hz * hz);
      if (hl > 1e-12) {
        hx /= hl;
        hz /= hl;
      } else {
        hx = 0;
        hz = -1;
      }
      w.tx[i] = hx;
      w.tz[i] = hz;
      // Terrain-follow weight: fraction of null-y control points around t.
      let f = t * segCount;
      if (def.closed) f -= Math.floor(f / segCount) * segCount;
      let seg = Math.floor(f);
      if (seg > segCount - 1) seg = segCount - 1;
      const u = f - seg;
      const c0 = isNull[seg]!;
      const c1 = isNull[seg + 1 === m ? 0 : seg + 1]!;
      const wNull = c0 * (1 - u) + c1 * u;
      let y = pt[1];
      if (wNull > 0) y = y * (1 - wNull) + discAverage(heightAt, pt[0], pt[2], kd.smoothRadius) * wNull;
      w.y[i] = y;
    }
    if (n > maxN) maxN = n;
    works.push(w);
  });

  const t1 = new Float64Array(maxN);
  const t2 = new Float64Array(maxN);
  const t3 = new Float64Array(maxN);

  // Curvature (plan, + = turning right) and bank.
  for (const w of works) {
    const n = w.n;
    const closed = w.def.closed;
    for (let i = 0; i < n; i++) {
      let p = i - 1;
      let q = i + 1;
      if (closed) {
        p = p < 0 ? n - 1 : p;
        q = q >= n ? 0 : q;
      } else {
        p = p < 0 ? 0 : p;
        q = q >= n ? n - 1 : q;
      }
      let ds = closed ? gapBefore(w, i) + gapBefore(w, q) : w.s[q]! - w.s[p]!;
      if (!(ds > 1e-9)) ds = 1e-9;
      const dtx = w.tx[q]! - w.tx[p]!;
      const dtz = w.tz[q]! - w.tz[p]!;
      w.curv[i] = (dtx * -w.tz[i]! + dtz * w.tx[i]!) / ds;
    }
    movingAverage(w.curv, n, closed, CURVATURE_AVG_M, t1);
    const bank = w.def.bank ?? 0;
    const rf = w.kd.bankFullRadius;
    for (let i = 0; i < n; i++) {
      const k = w.curv[i]!;
      const ak = k < 0 ? -k : k;
      const mag = bank * (ak * rf < 1 ? ak * rf : 1);
      w.bank[i] = k > 0 ? -mag : k < 0 ? mag : 0;
    }
    movingAverage(w.bank, n, closed, BANK_AVG_M, t1);
    if (!closed) {
      // Open ends run out flat (they end in junctions, pads or nothing).
      for (let i = 0; i < n; i++) {
        const e = Math.min(w.s[i]!, w.length - w.s[i]!) / END_FLAT_M;
        if (e < 1) w.bank[i] = w.bank[i]! * e * e * (3 - 2 * e);
      }
    }
  }

  // Junction membership + geometric validation (station of each road nearest pos).
  const byId = new Map<string, RoadWork>();
  for (const w of works) byId.set(w.def.id, w);
  const proj = createRoadProjection();
  const smp = createRoadSample();
  const jStation = layout.junctions.map((j) =>
    j.roads.map((id) => {
      const w = byId.get(id)!;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < w.n; i++) {
        const dx = w.x[i]! - j.pos[0];
        const dz = w.z[i]! - j.pos[1];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Distance to the polyline around the best station.
      let segBest = Math.sqrt(bestD);
      for (const k of [best - 1, best]) {
        const a = w.def.closed ? (k + w.n) % w.n : k;
        const b = w.def.closed ? (a + 1) % w.n : a + 1;
        if (a < 0 || b >= w.n) continue;
        const ex = w.x[b]! - w.x[a]!;
        const ez = w.z[b]! - w.z[a]!;
        const l2 = ex * ex + ez * ez;
        let t = l2 > 0 ? ((j.pos[0] - w.x[a]!) * ex + (j.pos[1] - w.z[a]!) * ez) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = j.pos[0] - w.x[a]! - t * ex;
        const qz = j.pos[1] - w.z[a]! - t * ez;
        const d = Math.sqrt(qx * qx + qz * qz);
        if (d < segBest) segBest = d;
      }
      if (segBest > JUNCTION_TOLERANCE_M) {
        throw new WorldLayoutError(
          `junction '${j.id}': road '${id}' passes ${segBest.toFixed(2)} m from (${j.pos[0]}, ${j.pos[1]}) (max 1 m)`,
        );
      }
      return best;
    }),
  );

  // Resolve by priority DESC (ties: declaration order).
  const order = works.slice().sort((a, b) => b.kd.priority - a.kd.priority || a.index - b.index);
  const resolved = new Set<RoadWork>();
  const pinned = new Uint8Array(maxN);
  const pinTarget = new Float64Array(maxN);

  for (const w of order) {
    const n = w.n;
    const closed = w.def.closed;
    const g = w.kd.maxGrade * GRADE_MARGIN;
    pinned.fill(0, 0, n);
    movingAverage(w.y, n, closed, VERTICAL_SMOOTH_M[w.def.kind], t1);

    // Junction easing onto the highest-priority already-resolved partner.
    layout.junctions.forEach((j, ji) => {
      const me = j.roads.indexOf(w.def.id);
      if (me < 0) return;
      let partner: RoadWork | null = null;
      for (const o of order) {
        if (o === w) break;
        if (resolved.has(o) && j.roads.includes(o.def.id)) {
          partner = o;
          break;
        }
      }
      if (!partner) return;
      const p = partner.profile!;
      const J = jStation[ji]![me]!;
      const sJ = w.s[J]!;
      for (let i = 0; i < n; i++) {
        let ds = w.s[i]! - sJ;
        if (ds < 0) ds = -ds;
        if (closed && ds > w.length / 2) ds = w.length - ds;
        if (ds >= JUNCTION_EASE_M) continue;
        const tt = 1 - ds / JUNCTION_EASE_M;
        const wt = tt * tt * (3 - 2 * tt);
        const target = throughSurface(p, w.x[i]!, w.z[i]!, proj, smp);
        w.y[i] = w.y[i]! * (1 - wt) + target * wt;
        w.bank[i] = w.bank[i]! * (1 - wt);
      }
      pinned[J] = 1;
      pinTarget[J] = throughSurface(p, w.x[J]!, w.z[J]!, proj, smp);
      w.y[J] = pinTarget[J]!;
      w.bank[J] = 0;
    });

    limitGrade(w, g, pinned, t1, t2, t3);
    // Light second smoothing rounds the limiter's kinks (vertical curves).
    movingAverage(w.y, n, closed, Math.max(12, VERTICAL_SMOOTH_M[w.def.kind] * 0.4), t1);
    // Re-pin junction stations with a short smoothstep correction.
    for (let J = 0; J < n; J++) {
      if (!pinned[J]) continue;
      const delta = pinTarget[J]! - w.y[J]!;
      if (delta === 0) continue;
      for (let i = 0; i < n; i++) {
        let ds = w.s[i]! - w.s[J]!;
        if (ds < 0) ds = -ds;
        if (closed && ds > w.length / 2) ds = w.length - ds;
        if (ds >= 24) continue;
        const tt = 1 - ds / 24;
        w.y[i] = w.y[i]! + delta * tt * tt * (3 - 2 * tt);
      }
    }
    limitGrade(w, w.kd.maxGrade * 0.98, pinned, t1, t2, t3);
    w.profile = decorateProfile(packProfile(w), w.def);
    resolved.add(w);
  }
  return works.map((w) => w.profile!);
}
