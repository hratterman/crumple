/**
 * Terrain generator (A): generateTerrain(layout) → TerrainData, and
 * hashTerrain. PURE and deterministic (see DETERMINISM in types.ts): seeded
 * core/rng + core/noise only, + − × ÷ sqrt floor abs min max, fixed order.
 *
 * Pipeline
 *  1. COARSE grid (4 × spacing): domain-warped layered noise per zone in the
 *     contract order (detail → plains → hills → mountains (smooth-max peaks +
 *     ridged multifractal) → edge rim), then particle hydraulic erosion
 *     (erosion.ts) where the relief is (mountains / hills / rim).
 *  2. FULL grid: cubic B-spline upsample of the eroded coarse field, plus the
 *     octaves too fine for the coarse grid and slope-scaled micro roughness.
 *  3. Lake basin + beach, town / arena flats, layout pads (all at full res).
 *  4. Roads: profiles resolved on this pre-road terrain (roads.ts), then
 *     carved: carriageway + verges are set exactly to the profile cross
 *     section (priority ASC, so the higher priority wins overlaps); outside
 *     them the natural terrain is clamped into a slope envelope around every
 *     road / pad core (chamfer distance transforms): 1:2 for the first 6 m of
 *     height, then 1:1, then 2:1, for fills and cuts alike. The envelope is
 *     continuous by construction (no cliffs, no seams between hairpin legs)
 *     and the creases are rounded by blurring the carve delta away from the
 *     cores.
 *  5. Splat (over-composited layers, quantized so R+G+B+A ≤ 255) and the
 *     material byte = dominant splat channel.
 */
import { createSeededNoise2D, type NoiseFunction2D } from '../core/noise';
import { createRng } from '../core/rng';
import { DEFAULT_EROSION, erodeHeightfield } from './erosion';
import {
  createRoadSample,
  headingToYaw,
  resolveRoadProfiles,
  sampleRoad,
} from './roads';
import { compileShape, smooth01, type CompiledShape } from './shapes';
import {
  ROAD_KIND_DEFAULTS,
  ROAD_STATION_STRIDE,
  SPLAT_CHANNELS,
  type NoiseParams,
  type ResolvedSpawn,
  type RoadProfile,
  type TerrainData,
  type WorldLayout,
  type ZoneDef,
} from './types';
import { validateLayout } from './validate';

// MaterialId values (FROZEN, protocol/messages.ts) — world may only `import type` from protocol.
const MAT_ASPHALT = 0;
const MAT_GRASS = 1;
const MAT_DIRT = 2;
const MAT_ROCK = 3;
const MAT_GRAVEL = 4;
const MAT_CONCRETE = 5;

/** Coarse grid factor (coarse spacing = COARSE × spacing). */
const COARSE = 4;
/** Octaves with wavelength ≥ this many coarse cells are evaluated on the coarse grid. */
const COARSE_MIN_CELLS = 4;

/** Road / pad slope envelope tiers: g(d) = max_k (m_k·d − c_k). */
const ENV_M = [0.5, 1.0, 2.0] as const;
const ENV_C = [0, 6, 26] as const;
const OWNER_NONE = 255;
const OWNER_PAD = 254;
/** Road influence beyond the verge for the gravel fringe paint, m. */
const FRINGE_M = 3;
/** Pad samples within this distance of a road core are released to the slope envelope, m. */
const PAD_RELEASE_M = 6;

// Noise stream ids (rng.fork) — fixed forever (hash stability).
const S_WARP_X = 1;
const S_WARP_Z = 2;
const S_DETAIL = 3;
const S_RIM = 4;
const S_RIM_RIDGE = 5;
const S_MICRO_A = 6;
const S_MICRO_B = 7;
const S_LAKEBED = 8;
const S_PAINT_A = 9;
const S_PAINT_B = 10;
const S_PAINT_C = 11;
const S_EROSION = 12;
const S_CRAG = 13;
const S_CRAG_PATCH = 14;
const S_LAKE_WARP = 15;
const S_ZONE = 100; // + zone index (×2 for secondary)

const WARP_AMP = 40;
/** Mountain ridged detail: amplitude × GAIN × (0.6 + 2.4·u·(1 − u)), u = macro/peakMax (strongest mid-slope, calmer summits), centred by BIAS (ridges AND valleys). */
const MTN_RIDGE_GAIN = 3.0;
/** Extra domain-warp amplitude inside mountain zones, m. */
const MTN_WARP_AMP = 45;
const MTN_RIDGE_BIAS = 0.3;
/** Close-range crag relief on the mountains, m. */
const CRAG_AMP = 2.4;
const WARP_WAVELENGTH = 340;
/** Lake shoreline wander (m) and its noise frequency (1/m). */
const LAKE_WARP_M = 14;
const LAKE_WARP_F = 1 / 70;

// ============================================================ noise helpers
interface Layer {
  noise: NoiseFunction2D;
  invL: number;
  octaves: number;
  lac: number;
  gain: number;
  /** 1 / Σ gain^k over all octaves. */
  norm: number;
  /** Octaves [0, split) on the coarse grid, [split, octaves) on the full grid. */
  split: number;
  /** gain^split, lac^split. */
  ampSplit: number;
  freqSplit: number;
}

function makeLayer(noise: NoiseFunction2D, p: NoiseParams, coarseSpacing: number): Layer {
  const lac = p.lacunarity ?? 2;
  const gain = p.gain ?? 0.5;
  let sum = 0;
  let amp = 1;
  let wl = p.wavelength;
  let split = 0;
  for (let k = 0; k < p.octaves; k++) {
    sum += amp;
    amp *= gain;
    if (wl >= COARSE_MIN_CELLS * coarseSpacing) split = k + 1;
    wl /= lac;
  }
  let ampSplit = 1;
  let freqSplit = 1;
  for (let k = 0; k < split; k++) {
    ampSplit *= gain;
    freqSplit *= lac;
  }
  return { noise, invL: 1 / p.wavelength, octaves: p.octaves, lac, gain, norm: 1 / sum, split, ampSplit, freqSplit };
}

/** Σ amp_k·noise over octaves [k0, k1), normalized by the full layer norm. */
function fbmRange(L: Layer, x: number, z: number, k0: number, k1: number, amp0: number, freq0: number): number {
  let sum = 0;
  let amp = amp0;
  let f = freq0 * L.invL;
  const nz = L.noise;
  for (let k = k0; k < k1; k++) {
    sum += amp * nz(x * f, z * f);
    amp *= L.gain;
    f *= L.lac;
  }
  return sum * L.norm;
}

/** Ridged carry weight out-param (module scratch: a module-level `let` double would be boxed per write). */
const CARRY = new Float64Array(1);
/** Ridged multifractal octaves [k0, k1): (1−|n|)² weighted by the previous octave; leaves the weight in CARRY[0]. */
function ridgedRange(L: Layer, x: number, z: number, k0: number, k1: number, amp0: number, freq0: number, w0: number): number {
  let sum = 0;
  let amp = amp0;
  let f = freq0 * L.invL;
  let w = w0;
  const nz = L.noise;
  for (let k = k0; k < k1; k++) {
    let n = nz(x * f, z * f);
    n = n < 0 ? -n : n;
    let r = 1 - n;
    r = r * r * w;
    sum += r * amp;
    w = r * 2;
    if (w > 1) w = 1;
    amp *= L.gain;
    f *= L.lac;
  }
  CARRY[0] = w;
  return sum * L.norm;
}

// ============================================================ value noise
/**
 * Cheap hashed lattice value noise in [−1, 1] (smoothstep-interpolated) for
 * sub-10 m micro relief and splat breakup, where simplex quality is not
 * needed. Integer hashing (Math.imul) only: exact across engines.
 */
export function createValueNoise2D(seed: number): (x: number, z: number) => number {
  const s = seed | 0;
  const hash = (ix: number, iz: number): number => {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ s;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h & 0xffff) * (2 / 65535) - 1;
  };
  return (x: number, z: number): number => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = hash(x0, z0);
    const b = hash(x0 + 1, z0);
    const c = hash(x0, z0 + 1);
    const d = hash(x0 + 1, z0 + 1);
    const ab = a + (b - a) * ux;
    return ab + (c + (d - c) * ux - ab) * uz;
  };
}

// ============================================================ grid helpers
/** Separable box blur (radius r, clamped edges) of A in place, using tmp. */
function boxBlur(A: Float32Array, tmp: Float32Array, cols: number, rows: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let row = 0; row < rows; row++) {
    const o = row * cols;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += A[o + (k < 0 ? 0 : k > cols - 1 ? cols - 1 : k)]!;
    for (let c = 0; c < cols; c++) {
      tmp[o + c] = sum * inv;
      const add = c + r + 1;
      const sub = c - r;
      sum += A[o + (add > cols - 1 ? cols - 1 : add)]! - A[o + (sub < 0 ? 0 : sub)]!;
    }
  }
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : k > rows - 1 ? rows - 1 : k) * cols + c]!;
    for (let row = 0; row < rows; row++) {
      A[row * cols + c] = sum * inv;
      const add = row + r + 1;
      const sub = row - r;
      sum += tmp[(add > rows - 1 ? rows - 1 : add) * cols + c]! - tmp[(sub < 0 ? 0 : sub) * cols + c]!;
    }
  }
}

/** Bilinear sampler over a row-major grid (edge clamped). */
function bilinear(A: ArrayLike<number>, cols: number, rows: number, ox: number, oz: number, sp: number, x: number, z: number): number {
  let u = (x - ox) / sp;
  let v = (z - oz) / sp;
  u = u < 0 ? 0 : u > cols - 1 ? cols - 1 : u;
  v = v < 0 ? 0 : v > rows - 1 ? rows - 1 : v;
  let c = Math.floor(u);
  let r = Math.floor(v);
  if (c > cols - 2) c = cols - 2;
  if (r > rows - 2) r = rows - 2;
  const fu = u - c;
  const fv = v - r;
  const i = r * cols + c;
  const a = A[i]! + (A[i + 1]! - A[i]!) * fu;
  const b = A[i + cols]! + (A[i + cols + 1]! - A[i + cols]!) * fu;
  return a + (b - a) * fv;
}

// ============================================================ splat compositing
/** Working splat weights [paved, dirt, rock, gravel] (grass = 1 − Σ). Module scratch: no per-sample allocation. */
const W = new Float64Array(4);
/** "Over" composite: channel ch (−1 = grass) with coverage cov ∈ [0, 1]. */
function over(ch: number, cov: number): void {
  if (cov <= 0) return;
  if (cov > 1) cov = 1;
  const k = 1 - cov;
  W[0] = W[0]! * k;
  W[1] = W[1]! * k;
  W[2] = W[2]! * k;
  W[3] = W[3]! * k;
  if (ch >= 0) W[ch] = W[ch]! + cov;
}
function load(splat: Uint8Array, i: number): void {
  const o = i * 4;
  W[0] = splat[o]! / 255;
  W[1] = splat[o + 1]! / 255;
  W[2] = splat[o + 2]! / 255;
  W[3] = splat[o + 3]! / 255;
}
/** Quantize W into splat (R+G+B+A ≤ 255) and write the dominant material. */
function store(splat: Uint8Array, material: Uint8Array, i: number, pavedMat: number): void {
  let q0 = Math.floor(W[0]! * 255 + 0.5);
  let q1 = Math.floor(W[1]! * 255 + 0.5);
  let q2 = Math.floor(W[2]! * 255 + 0.5);
  let q3 = Math.floor(W[3]! * 255 + 0.5);
  let sum = q0 + q1 + q2 + q3;
  while (sum > 255) {
    if (q0 >= q1 && q0 >= q2 && q0 >= q3) q0--;
    else if (q1 >= q2 && q1 >= q3) q1--;
    else if (q2 >= q3) q2--;
    else q3--;
    sum--;
  }
  const o = i * 4;
  splat[o] = q0;
  splat[o + 1] = q1;
  splat[o + 2] = q2;
  splat[o + 3] = q3;
  material[i] = dominantMaterial(q0, q1, q2, q3, pavedMat);
}
const chanOfMat = (m: number): number =>
  m === MAT_ASPHALT || m === MAT_CONCRETE || m === 6 ? 0 : m === MAT_DIRT ? 1 : m === MAT_ROCK ? 2 : m === MAT_GRAVEL ? 3 : -1;

// ============================================================ generator
/** Stage timings (ms) of the last generateTerrain call — diagnostics only, never hashed. */
export const lastTerrainTimings: Record<string, number> = {};
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/**
 * Hot loops live in small top-level functions (one per stage) so the JIT
 * optimizes each quickly; a single giant generator body stays in the
 * baseline tiers and boxes every double.
 */
interface FullGrid {
  cols: number;
  rows: number;
  N: number;
  ox: number;
  oz: number;
  sp: number;
}
interface CoarseGrid {
  nc: number;
  NC: number;
  cs: number;
  /** Full-grid col/row → coarse cell index (≤ nc − 2) and fraction. */
  cIdx: Int32Array;
  cFrac: Float64Array;
}
interface Peak {
  cx: number;
  cz: number;
  h: number;
  irx2: number;
  irz2: number;
  ax: number;
  az: number;
}
interface ZoneRt {
  kind: ZoneDef['kind'];
  shape: CompiledShape;
  layer: Layer | null;
  amp: number;
  lift: number;
  peaks: Peak[];
  peakMax: number;
  /** Coarse weight / ridged carry of this layer's fine octaves (null when all octaves are coarse). */
  fineW: Float32Array | null;
  carry: Float32Array | null;
}
interface FineLayer {
  L: Layer;
  w: Float32Array;
  carry: Float32Array | null;
}
interface CoarseFields {
  hC: Float64Array;
  spawnC: Float32Array;
  roughC: Float32Array;
  /** Σ mask·macro/peakMax (0..1): rockiness / alpine weight. */
  mtnC: Float32Array;
  hillC: Float32Array;
  warpXC: Float32Array;
  warpZC: Float32Array;
  eroC: Float32Array;
  mslopeC: Float32Array;
}
interface Flat {
  shape: CompiledShape;
  height: number;
  kind: 'arena' | 'town' | 'pad';
  material: number | undefined;
}

/** Grid index box [c0, c1] × [r0, r1] covering world box (clamped). */
function boxOf(g: FullGrid, minX: number, maxX: number, minZ: number, maxZ: number): [number, number, number, number] {
  const cl = (v: number): number => (v < 0 ? 0 : v > g.cols - 1 ? g.cols - 1 : v);
  return [
    cl(Math.floor((minX - g.ox) / g.sp)),
    cl(Math.floor((maxX - g.ox) / g.sp) + 1),
    cl(Math.floor((minZ - g.oz) / g.sp)),
    cl(Math.floor((maxZ - g.oz) / g.sp) + 1),
  ];
}

const smax = (a: number, b: number, k: number): number => {
  const d = a > b ? a - b : b - a;
  const m = a > b ? a : b;
  if (d >= k) return m;
  const t = k - d;
  return m + (t * t) / (4 * k);
};

/** Bilinear read of a coarse field at coarse cell i00 (fractions fx, fz). */
function cbl(A: Float32Array, nc: number, i00: number, fx: number, fz: number): number {
  const a = A[i00]! + (A[i00 + 1]! - A[i00]!) * fx;
  const b = A[i00 + nc]! + (A[i00 + nc + 1]! - A[i00 + nc]!) * fx;
  return a + (b - a) * fz;
}

// ------------------------------------------------------------ 1. coarse relief
/** Per-sample relief-zone masks (module scratch). */
let MASKS = new Float64Array(8);
function coarseRelief(
  layout: WorldLayout,
  cg: CoarseGrid,
  F: CoarseFields,
  relief: readonly ZoneRt[],
  detail: Layer,
  detailFineW: Float32Array | null,
  warpX: Layer,
  warpZ: Layer,
  rimL: Layer,
  rimRidge: Layer,
): void {
  const T = layout.terrain;
  const half = layout.size / 2;
  const er = T.edgeRise;
  const { nc, cs } = cg;
  const o = -half;
  if (MASKS.length < relief.length) MASKS = new Float64Array(relief.length);
  for (let r = 0; r < nc; r++) {
    const z = o + r * cs;
    for (let c = 0; c < nc; c++) {
      const x = o + c * cs;
      const i = r * nc + c;
      // Zone masks once per sample; mountains get a stronger warp (twisted ridges, not a radial dome).
      let wa = WARP_AMP;
      for (let k = 0; k < relief.length; k++) {
        const zr = relief[k]!;
        const m = zr.shape.mask(x, z);
        MASKS[k] = m;
        if (zr.kind === 'mountains') wa += MTN_WARP_AMP * m;
      }
      const wx = x + wa * fbmRange(warpX, x, z, 0, 2, 1, 1);
      const wz = z + wa * fbmRange(warpZ, x, z, 0, 2, 1, 1);
      F.warpXC[i] = wx - x;
      F.warpZC[i] = wz - z;
      let h = T.baseHeight + T.detail.amplitude * fbmRange(detail, wx, wz, 0, detail.split, 1, 1);
      if (detailFineW) detailFineW[i] = T.detail.amplitude;
      let rough = 0.1;
      let spawn = 0;
      let mtnW = 0;
      let hillW = 0;
      for (let k = 0; k < relief.length; k++) {
        const zr = relief[k]!;
        const L = zr.layer!;
        const m = MASKS[k]!;
        if (zr.kind === 'plains') {
          if (m <= 0) continue;
          h += m * zr.amp * fbmRange(L, wx, wz, 0, L.split, 1, 1);
          if (zr.fineW) zr.fineW[i] = m * zr.amp;
        } else if (zr.kind === 'hills') {
          if (m <= 0) continue;
          h += m * (zr.lift + zr.amp * fbmRange(L, wx, wz, 0, L.split, 1, 1));
          if (zr.fineW) zr.fineW[i] = m * zr.amp;
          rough += 0.3 * m;
          spawn += 0.25 * m;
          hillW += m;
        } else {
          // Mountains: smooth-max over the peak bumps (unmasked), masked ridged multifractal.
          let macro = 0;
          for (let p = 0; p < zr.peaks.length; p++) {
            const pk = zr.peaks[p]!;
            const dx = x - pk.cx;
            const dz = z - pk.cz;
            const lx = dx * pk.ax + dz * pk.az;
            const lz = dz * pk.ax - dx * pk.az;
            const u2 = lx * lx * pk.irx2 + lz * lz * pk.irz2;
            if (u2 >= 1) continue;
            const q = 1 - u2;
            macro = smax(macro, pk.h * q * q, 14);
          }
          h += macro;
          const rel = macro / zr.peakMax;
          const wgt = m * (rel > 1 ? 1 : rel);
          if (wgt > 0) {
            const rc = rel > 1 ? 1 : rel;
            const ramp = wgt * zr.amp * MTN_RIDGE_GAIN * (0.6 + 2.4 * rc * (1 - rc));
            h += ramp * (ridgedRange(L, wx, wz, 0, L.split, 1, 1, 1) - MTN_RIDGE_BIAS);
            if (zr.fineW) {
              zr.fineW[i] = ramp;
              zr.carry![i] = CARRY[0]!;
            }
          }
          const reliefW = rel * 3 > 1 ? 1 : rel * 3;
          mtnW += wgt;
          rough += 0.9 * reliefW;
          spawn += reliefW;
        }
      }
      // Edge rim: hills hiding the map edge (height ±28 %, wandering foot, ridged shoulders).
      if (er.width > 0) {
        const ex = half - (x < 0 ? -x : x);
        const ez = half - (z < 0 ? -z : z);
        // Edge distance with rounded corners (no diagonal crease where both edges are near).
        const qx = er.width - ex;
        const qz = er.width - ez;
        const ed = qx > 0 && qz > 0 ? er.width - Math.sqrt(qx * qx + qz * qz) : ex < ez ? ex : ez;
        if (ed < er.width) {
          const n01 = 0.5 + 0.5 * fbmRange(rimL, wx, wz, 0, rimL.octaves, 1, 1);
          const m = smooth01(1 - ed / (er.width * (0.6 + 0.4 * n01)));
          const ridge = ridgedRange(rimRidge, wx, wz, 0, rimRidge.octaves, 1, 1, 1);
          h += er.height * m * (0.72 + 0.56 * n01) + er.height * 0.35 * m * ridge;
          rough += 0.7 * m;
          spawn += 0.9 * m;
        }
      }
      F.hC[i] = h;
      F.roughC[i] = rough > 1 ? 1 : rough;
      F.spawnC[i] = spawn > 1 ? 1 : spawn;
      F.mtnC[i] = mtnW > 1 ? 1 : mtnW;
      F.hillC[i] = hillW > 1 ? 1 : hillW;
    }
  }
}

/** Two passes of 3×3 binomial smoothing (removes single-cell erosion pits). */
function smoothCoarse(A: Float32Array, tmp: Float32Array, nc: number): void {
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < nc; r++) {
      const o = r * nc;
      for (let c = 0; c < nc; c++) {
        const cl = c > 0 ? c - 1 : c;
        const cr = c < nc - 1 ? c + 1 : c;
        tmp[o + c] = 0.25 * A[o + cl]! + 0.5 * A[o + c]! + 0.25 * A[o + cr]!;
      }
    }
    for (let r = 0; r < nc; r++) {
      const ru = (r > 0 ? r - 1 : r) * nc;
      const rd = (r < nc - 1 ? r + 1 : r) * nc;
      const o = r * nc;
      for (let c = 0; c < nc; c++) A[o + c] = 0.25 * tmp[ru + c]! + 0.5 * tmp[o + c]! + 0.25 * tmp[rd + c]!;
    }
  }
}

function coarseSlope(hC: Float64Array, nc: number, cs: number, out: Float32Array): void {
  for (let r = 0; r < nc; r++) {
    const ru = r > 0 ? r - 1 : r;
    const rd = r < nc - 1 ? r + 1 : r;
    for (let c = 0; c < nc; c++) {
      const cl = c > 0 ? c - 1 : c;
      const cr = c < nc - 1 ? c + 1 : c;
      const gx = (hC[r * nc + cr]! - hC[r * nc + cl]!) / ((cr - cl) * cs);
      const gz = (hC[rd * nc + c]! - hC[ru * nc + c]!) / ((rd - ru) * cs);
      out[r * nc + c] = Math.sqrt(gx * gx + gz * gz);
    }
  }
}

// ------------------------------------------------------------ 2. full grid
/** Separable cubic B-spline upsample of the coarse field (C2, no overshoot). */
function upsampleBSpline(hC: Float64Array, nc: number, g: FullGrid, out: Float32Array): void {
  const { cols, rows } = g;
  const tapI = new Int32Array(cols * 4);
  const tapW = new Float64Array(cols * 4);
  for (let c = 0; c < cols; c++) {
    const ci = Math.floor(c / COARSE);
    const f = (c - ci * COARSE) / COARSE;
    const f2 = f * f;
    const f3 = f2 * f;
    const gg = 1 - f;
    tapW[c * 4] = (gg * gg * gg) / 6;
    tapW[c * 4 + 1] = (3 * f3 - 6 * f2 + 4) / 6;
    tapW[c * 4 + 2] = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6;
    tapW[c * 4 + 3] = f3 / 6;
    for (let k = 0; k < 4; k++) {
      let q = ci - 1 + k;
      q = q < 0 ? 0 : q > nc - 1 ? nc - 1 : q;
      tapI[c * 4 + k] = q;
    }
  }
  const tmp = new Float64Array(nc * cols);
  for (let r = 0; r < nc; r++) {
    const o = r * nc;
    const to = r * cols;
    for (let c = 0; c < cols; c++) {
      const k = c * 4;
      tmp[to + c] =
        tapW[k]! * hC[o + tapI[k]!]! +
        tapW[k + 1]! * hC[o + tapI[k + 1]!]! +
        tapW[k + 2]! * hC[o + tapI[k + 2]!]! +
        tapW[k + 3]! * hC[o + tapI[k + 3]!]!;
    }
  }
  for (let r = 0; r < rows; r++) {
    const k = r * 4;
    const w0 = tapW[k]!;
    const w1 = tapW[k + 1]!;
    const w2 = tapW[k + 2]!;
    const w3 = tapW[k + 3]!;
    const o0 = tapI[k]! * cols;
    const o1 = tapI[k + 1]! * cols;
    const o2 = tapI[k + 2]! * cols;
    const o3 = tapI[k + 3]! * cols;
    const o = r * cols;
    for (let c = 0; c < cols; c++) out[o + c] = w0 * tmp[o0 + c]! + w1 * tmp[o1 + c]! + w2 * tmp[o2 + c]! + w3 * tmp[o3 + c]!;
  }
}

type Noise2 = (x: number, z: number) => number;

/** Octaves too fine for the coarse grid, micro roughness and mountain crags. */
function fineDetail(
  nat: Float32Array,
  g: FullGrid,
  cg: CoarseGrid,
  F: CoarseFields,
  fine: readonly FineLayer[],
  microA: Noise2,
  microB: Noise2,
  cragA: Noise2,
  cragP: Noise2,
): void {
  const { cols, rows, ox, oz, sp } = g;
  const { nc, cIdx, cFrac } = cg;
  const nf = fine.length;
  for (let r = 0; r < rows; r++) {
    const z = oz + r * sp;
    const rz = cIdx[r]!;
    const fz = cFrac[r]!;
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      const x = ox + c * sp;
      const i00 = rz * nc + cIdx[c]!;
      const fx = cFrac[c]!;
      let h = nat[o + c]!;
      let wx = 0;
      let wz = 0;
      let warped = false;
      for (let k = 0; k < nf; k++) {
        const fl = fine[k]!;
        const fw = fl.w;
        if (fw[i00]! === 0 && fw[i00 + 1]! === 0 && fw[i00 + nc]! === 0 && fw[i00 + nc + 1]! === 0) continue;
        const w = cbl(fw, nc, i00, fx, fz);
        if (w <= 1e-5) continue;
        if (!warped) {
          wx = x + cbl(F.warpXC, nc, i00, fx, fz);
          wz = z + cbl(F.warpZC, nc, i00, fx, fz);
          warped = true;
        }
        const L = fl.L;
        if (fl.carry) {
          h += w * ridgedRange(L, wx, wz, L.split, L.octaves, L.ampSplit, L.freqSplit, cbl(fl.carry, nc, i00, fx, fz));
        } else {
          h += w * fbmRange(L, wx, wz, L.split, L.octaves, L.ampSplit, L.freqSplit);
        }
      }
      const rough = cbl(F.roughC, nc, i00, fx, fz);
      if (rough > 1e-4) h += rough * (0.32 * microA(x * 0.11, z * 0.11) + 0.1 * microB(x * 0.29, z * 0.29));
      const mtn = cbl(F.mtnC, nc, i00, fx, fz);
      if (mtn > 1e-3) {
        // Crags: sharp ridged outcrops on steep, rocky mountain ground (patchy).
        const ms = cbl(F.mslopeC, nc, i00, fx, fz);
        const w = mtn * smooth01((ms - 0.35) / 0.4 + 0.8 * cragP(x * 0.012, z * 0.012));
        if (w > 1e-3) {
          let n = cragA(x * 0.07, z * 0.07);
          n = 1 - (n < 0 ? -n : n);
          let m = cragA(x * 0.17 + 31.7, z * 0.17 - 12.3);
          m = 1 - (m < 0 ? -m : m);
          h += w * CRAG_AMP * (0.75 * n * n + 0.25 * m * m * n - 0.3);
        }
      }
      nat[o + c] = h;
    }
  }
}

// ------------------------------------------------------------ 3. lake, flats, pads
/** Lake bowl h = wl − depth·(1 − r²) (lakebed noise), dry beach ramp in the blend band. */
function carveLake(nat: Float32Array, g: FullGrid, s: CompiledShape, wl: number, depth: number, lift: number, bed: Noise2, warp: Noise2): void {
  const [c0, c1, r0, r1] = boxOf(g, s.minX - LAKE_WARP_M, s.maxX + LAKE_WARP_M, s.minZ - LAKE_WARP_M, s.maxZ + LAKE_WARP_M);
  const blend = s.blend;
  for (let r = r0; r <= r1; r++) {
    const z = g.oz + r * g.sp;
    for (let c = c0; c <= c1; c++) {
      const x = g.ox + c * g.sp;
      const i = r * g.cols + c;
      // Shoreline wanders ±LAKE_WARP_M: the ellipse is evaluated at a warped point.
      const lx = x + LAKE_WARP_M * warp(x * LAKE_WARP_F, z * LAKE_WARP_F);
      const lz = z + LAKE_WARP_M * warp(z * LAKE_WARP_F + 17.3, x * LAKE_WARP_F - 5.1);
      const rr = s.radius(lx, lz);
      if (rr <= 1) {
        nat[i] = wl - depth * (1 - rr * rr) * (1 + 0.15 * bed(x * 0.012, z * 0.012));
        continue;
      }
      const e = s.outside(lx, lz);
      if (blend <= 0 || e >= blend) continue;
      const m = smooth01(1 - e / blend);
      let t = e / (0.5 * blend);
      if (t > 1) t = 1;
      const beach = wl + lift * (1 - (1 - t) * (1 - t));
      const h0 = nat[i]!;
      const dry = h0 > wl + lift ? h0 : wl + lift;
      nat[i] = dry + (beach - dry) * m;
    }
  }
}

/** Mean height over the shape's interior (null pad heights). */
function meanInside(nat: Float32Array, g: FullGrid, s: CompiledShape): number {
  const [c0, c1, r0, r1] = boxOf(g, s.minX, s.maxX, s.minZ, s.maxZ);
  let sum = 0;
  let cnt = 0;
  for (let r = r0; r <= r1; r++) {
    const z = g.oz + r * g.sp;
    for (let c = c0; c <= c1; c++) {
      if (s.outside(g.ox + c * g.sp, z) <= 0) {
        sum += nat[r * g.cols + c]!;
        cnt++;
      }
    }
  }
  return cnt > 0 ? sum / cnt : bilinear(nat, g.cols, g.rows, g.ox, g.oz, g.sp, (s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2);
}

/** h = lerp(h, H, mask); the interior (mask 1) becomes an exact pad core. */
function flatten(nat: Float32Array, owner: Uint8Array, coreT: Float32Array, g: FullGrid, s: CompiledShape, H: number): void {
  const [c0, c1, r0, r1] = boxOf(g, s.minX, s.maxX, s.minZ, s.maxZ);
  for (let r = r0; r <= r1; r++) {
    const z = g.oz + r * g.sp;
    for (let c = c0; c <= c1; c++) {
      const m = s.mask(g.ox + c * g.sp, z);
      if (m <= 0) continue;
      const i = r * g.cols + c;
      nat[i] = nat[i]! + (H - nat[i]!) * m;
      if (m >= 1) {
        owner[i] = OWNER_PAD;
        coreT[i] = H;
      }
    }
  }
}

// ------------------------------------------------------------ 4. roads
/**
 * Rasterize one road: samples within the verge (|d| ≤ width/2 + shoulder,
 * round caps at open ends) become cores at the profile cross-section height
 * (verge-level clamp of the bank); the nearest segment of the road wins,
 * a later (higher-priority) road overwrites. Outside the verge, absD keeps
 * the distance past the nearest verge (fringe paint, pad release).
 */
function rasterRoad(
  prof: RoadProfile,
  ri: number,
  g: FullGrid,
  owner: Uint8Array,
  coreT: Float32Array,
  absD: Float32Array,
  stamp: Uint8Array,
  bestD2: Float32Array,
): void {
  const { cols, ox, oz, sp } = g;
  const st = prof.stations;
  const n = prof.stationCount;
  const segs = prof.closed ? n : n - 1;
  const a = prof.width / 2;
  const b = a + prof.shoulder;
  const b2 = b * b;
  const reach = b + PAD_RELEASE_M;
  const reach2 = reach * reach;
  const sv = ri + 1;
  for (let k = 0; k < segs; k++) {
    const pa = k * ROAD_STATION_STRIDE;
    const pb = (k + 1 === n ? 0 : k + 1) * ROAD_STATION_STRIDE;
    const xa = st[pa]!;
    const za = st[pa + 2]!;
    const ex = st[pb]! - xa;
    const ez = st[pb + 2]! - za;
    const l2 = ex * ex + ez * ez;
    const il2 = l2 > 0 ? 1 / l2 : 0;
    const ya = st[pa + 1]!;
    const dy = st[pb + 1]! - ya;
    const ba = st[pa + 5]!;
    const dbk = st[pb + 5]! - ba;
    const rxa = -st[pa + 4]!;
    const rza = st[pa + 3]!;
    const drx = -st[pb + 4]! - rxa;
    const drz = st[pb + 3]! - rza;
    const capStart = !prof.closed && k === 0;
    const capEnd = !prof.closed && k === segs - 1;
    const [c0, c1, r0, r1] = boxOf(
      g,
      (ex < 0 ? xa + ex : xa) - reach - sp,
      (ex > 0 ? xa + ex : xa) + reach + sp,
      (ez < 0 ? za + ez : za) - reach - sp,
      (ez > 0 ? za + ez : za) + reach + sp,
    );
    for (let r = r0; r <= r1; r++) {
      const pz = oz + r * sp - za;
      for (let c = c0; c <= c1; c++) {
        const px = ox + c * sp - xa;
        let t = (px * ex + pz * ez) * il2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - t * ex;
        const qz = pz - t * ez;
        const d2 = qx * qx + qz * qz;
        if (d2 > reach2) continue;
        const i = r * cols + c;
        if (d2 > b2) {
          const ow = owner[i]!;
          if (ow === OWNER_NONE || ow === OWNER_PAD) {
            const f = Math.sqrt(d2) - b;
            if (f < absD[i]!) absD[i] = f;
          }
          continue;
        }
        if (stamp[i] === sv && d2 >= bestD2[i]!) continue;
        stamp[i] = sv;
        bestD2[i] = d2;
        let rx = rxa + drx * t;
        let rz = rza + drz * t;
        const rl = Math.sqrt(rx * rx + rz * rz);
        rx /= rl;
        rz /= rl;
        const d = qx * rx + qz * rz;
        const dc = d < -a ? -a : d > a ? a : d;
        coreT[i] = ya + dy * t + (ba + dbk * t) * dc;
        owner[i] = ri;
        const capped = (capStart && t <= 0) || (capEnd && t >= 1);
        absD[i] = capped ? Math.sqrt(d2) : d < 0 ? -d : d;
      }
    }
  }
}

/**
 * Release pad samples next to a road: road and pad (both exact) may sit at
 * different heights (a road climbing into a lookout), so the strip between
 * them is left to the slope envelope instead of forming a step.
 */
function releasePads(owner: Uint8Array, absD: Float32Array, N: number): void {
  for (let i = 0; i < N; i++) if (owner[i] === OWNER_PAD && absD[i]! < PAD_RELEASE_M) owner[i] = OWNER_NONE;
}

const BIG = 1e9;

/** Embankment / cutting profile: g(d) = max_k(m_k·d − c_k) (1:2, then 1:1, then 2:1). */
function envG(d: number): number {
  let g = ENV_M[0] * d - ENV_C[0];
  const g1 = ENV_M[1] * d - ENV_C[1];
  const g2 = ENV_M[2] * d - ENV_C[2];
  if (g1 > g) g = g1;
  if (g2 > g) g = g2;
  return g;
}

/**
 * Slope envelope around every core (road verges + pads): the terrain must lie
 * between L(x) = max_c (T_c − g(|x − c|)) and U(x) = min_c (T_c + g(|x − c|)).
 * Computed per source, exactly: two raster passes propagate, per sample, the
 * core sample that maximizes L (resp. minimizes U) among its own and its
 * scanned neighbours' best sources, re-evaluating g with the Euclidean
 * distance (vector distance-transform style; neighbours sharing the current
 * source cost nothing). heights = clamp(nat, L, U); where two cores are too
 * close for the slopes (L > U) the bounds are blended by distance so the
 * surface still meets both cores without a step. Also writes the distance to
 * the nearest core into `dist` (crease ramp).
 */
function slopeEnvelope(
  g: FullGrid,
  owner: Uint8Array,
  coreT: Float32Array,
  nat: Float32Array,
  heights: Float32Array,
  srcL: Int32Array,
  srcU: Int32Array,
  dist: Float32Array,
): void {
  const { cols, rows, N, sp } = g;
  for (let i = 0; i < N; i++) {
    const core = owner[i] !== OWNER_NONE;
    srcL[i] = core ? i : -1;
    srcU[i] = core ? i : -1;
    dist[i] = core ? 0 : BIG;
  }
  chamferDist(dist, cols, rows, sp);
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    const back = fwd ? 1 : -1;
    for (let rr = 0; rr < rows; rr++) {
      const r = fwd ? rr : rows - 1 - rr;
      const hasRow = fwd ? r > 0 : r < rows - 1;
      const uo = (r - back) * cols;
      for (let cc = 0; cc < cols; cc++) {
        const c = fwd ? cc : cols - 1 - cc;
        const i = r * cols + c;
        if (owner[i] !== OWNER_NONE) continue;
        let bl = srcL[i]!;
        let bu = srcU[i]!;
        let vl = -BIG;
        let vu = BIG;
        if (bl >= 0) vl = envValue(coreT, bl, cols, c, r, sp, -1);
        if (bu >= 0) vu = envValue(coreT, bu, cols, c, r, sp, 1);
        // Scanned neighbours: previous in the row, and three in the previous row.
        for (let k = 0; k < 4; k++) {
          let n: number;
          if (k === 0) {
            if (!(fwd ? c > 0 : c < cols - 1)) continue;
            n = i - back;
          } else {
            if (!hasRow) continue;
            const cn = c + k - 2;
            if (cn < 0 || cn >= cols) continue;
            n = uo + cn;
          }
          const sl = srcL[n]!;
          if (sl >= 0 && sl !== bl) {
            const v = envValue(coreT, sl, cols, c, r, sp, -1);
            if (v > vl) {
              vl = v;
              bl = sl;
            }
          }
          const su = srcU[n]!;
          if (su >= 0 && su !== bu) {
            const v = envValue(coreT, su, cols, c, r, sp, 1);
            if (v < vu) {
              vu = v;
              bu = su;
            }
          }
        }
        srcL[i] = bl;
        srcU[i] = bu;
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (owner[i] !== OWNER_NONE) {
        heights[i] = coreT[i]!;
        continue;
      }
      const sl = srcL[i]!;
      const su = srcU[i]!;
      let h = nat[i]!;
      if (sl < 0 || su < 0) {
        heights[i] = h;
        continue;
      }
      const lo = envValue(coreT, sl, cols, c, r, sp, -1);
      const hi = envValue(coreT, su, cols, c, r, sp, 1);
      if (lo <= hi) {
        if (h < lo) h = lo;
        if (h > hi) h = hi;
      } else {
        // Infeasible between two cores: blend by distance (meets each core exactly).
        const dl = srcDist(sl, cols, c, r, sp);
        const du = srcDist(su, cols, c, r, sp);
        h = lo + ((hi - lo) * dl) / (dl + du);
      }
      heights[i] = h;
    }
  }
}

function srcDist(src: number, cols: number, c: number, r: number, sp: number): number {
  const sr = (src / cols) | 0;
  const dx = c - (src - sr * cols);
  const dz = r - sr;
  return Math.sqrt(dx * dx + dz * dz) * sp;
}

/** T_src ∓ g(distance to the sample): sign −1 → lower bound, +1 → upper bound. */
function envValue(coreT: Float32Array, src: number, cols: number, c: number, r: number, sp: number, sign: number): number {
  return coreT[src]! + sign * envG(srcDist(src, cols, c, r, sp));
}

/** Chamfer (1, √2) distance transform, in place: sources 0, others BIG. */
function chamferDist(A: Float32Array, cols: number, rows: number, sp: number): void {
  const a = sp;
  const d = sp * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    const back = fwd ? 1 : -1;
    for (let rr = 0; rr < rows; rr++) {
      const r = fwd ? rr : rows - 1 - rr;
      const hasRow = fwd ? r > 0 : r < rows - 1;
      const uo = (r - back) * cols;
      for (let cc = 0; cc < cols; cc++) {
        const c = fwd ? cc : cols - 1 - cc;
        const i = r * cols + c;
        let v = A[i]!;
        if (v === 0) continue;
        if (fwd ? c > 0 : c < cols - 1) {
          const t = A[i - back]! + a;
          if (t < v) v = t;
        }
        if (hasRow) {
          const u = uo + c;
          let t = A[u]! + a;
          if (t < v) v = t;
          if (c > 0) {
            t = A[u - 1]! + d;
            if (t < v) v = t;
          }
          if (c < cols - 1) {
            t = A[u + 1]! + d;
            if (t < v) v = t;
          }
        }
        A[i] = v;
      }
    }
  }
}

/** Round the envelope creases: blur the carve delta, blend it in 0 → 3 m from the cores; final clamp. */
function roundCreases(
  g: FullGrid,
  owner: Uint8Array,
  nat: Float32Array,
  heights: Float32Array,
  dist: Float32Array,
  s1: Float32Array,
  s2: Float32Array,
  minH: number,
  maxH: number,
): void {
  const { cols, rows, N } = g;
  for (let i = 0; i < N; i++) s1[i] = heights[i]! - nat[i]!;
  boxBlur(s1, s2, cols, rows, 2);
  boxBlur(s1, s2, cols, rows, 2);
  for (let i = 0; i < N; i++) {
    let h = heights[i]!;
    if (owner[i] === OWNER_NONE) {
      const raw = h - nat[i]!;
      const d = dist[i]!;
      const w = d >= 3 ? 1 : smooth01(d / 3);
      h = nat[i]! + raw + (s1[i]! - raw) * w;
    }
    heights[i] = h < minH ? minH : h > maxH ? maxH : h;
  }
}

// ------------------------------------------------------------ 5. paint
function slopeAt(h: Float32Array, cols: number, rows: number, i: number, r: number, c: number, inv2: number): number {
  const cl = c > 0 ? i - 1 : i;
  const cr = c < cols - 1 ? i + 1 : i;
  const ru = r > 0 ? i - cols : i;
  const rd = r < rows - 1 ? i + cols : i;
  const gx = (h[cr]! - h[cl]!) * (c > 0 && c < cols - 1 ? inv2 : 2 * inv2);
  const gz = (h[rd]! - h[ru]!) * (r > 0 && r < rows - 1 ? inv2 : 2 * inv2);
  return Math.sqrt(gx * gx + gz * gz);
}

/** Natural ground cover everywhere: worn earth, erosion beds/fans, scree, rock. */
function paintNatural(
  g: FullGrid,
  cg: CoarseGrid,
  F: CoarseFields,
  nAC: Float32Array,
  heights: Float32Array,
  splat: Uint8Array,
  material: Uint8Array,
  pB: Noise2,
  rockSlope: number,
): void {
  const { cols, rows, ox, oz, sp } = g;
  const { nc, cIdx, cFrac } = cg;
  const { mslopeC, eroC, mtnC, hillC } = F;
  const inv2 = 1 / (2 * sp);
  for (let r = 0; r < rows; r++) {
    const z = oz + r * sp;
    const rz = cIdx[r]!;
    const fz = cFrac[r]!;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = ox + c * sp;
      const i00 = rz * nc + cIdx[c]!;
      const fx = cFrac[c]!;
      const h = heights[i]!;
      const slope = slopeAt(heights, cols, rows, i, r, c, inv2);
      const w00 = (1 - fx) * (1 - fz);
      const w10 = fx * (1 - fz);
      const w01 = (1 - fx) * fz;
      const w11 = fx * fz;
      const i10 = i00 + 1;
      const i01 = i00 + nc;
      const i11 = i01 + 1;
      const mslope = w00 * mslopeC[i00]! + w10 * mslopeC[i10]! + w01 * mslopeC[i01]! + w11 * mslopeC[i11]!;
      const ero = w00 * eroC[i00]! + w10 * eroC[i10]! + w01 * eroC[i01]! + w11 * eroC[i11]!;
      const mtn = w00 * mtnC[i00]! + w10 * mtnC[i10]! + w01 * mtnC[i01]! + w11 * mtnC[i11]!;
      const hill = w00 * hillC[i00]! + w10 * hillC[i10]! + w01 * hillC[i01]! + w11 * hillC[i11]!;
      const nA = w00 * nAC[i00]! + w10 * nAC[i10]! + w01 * nAC[i01]! + w11 * nAC[i11]!;
      const nB = pB(x * 0.16, z * 0.16);
      W[0] = 0;
      W[1] = 0;
      W[2] = 0;
      W[3] = 0;
      // Worn earth on moderate slopes and in patches.
      over(1, smooth01((slope - 0.42) / 0.3 + 0.35 * nB) * 0.75);
      over(1, smooth01((nA - 0.45) / 0.25 + 0.3 * nB) * (0.25 + 0.45 * hill + 0.4 * mtn) * 0.6);
      // Erosion: gravel channel beds, earthy deposition fans.
      if (ero < -0.1) over(3, smooth01((-ero - 1.0) / 2 + 0.35 * nB) * 0.6);
      else if (ero > 0.1) over(1, smooth01((ero - 0.4) / 1.2 + 0.3 * nB) * 0.3);
      if (mtn > 1e-3) {
        // Scree under steep mountain ground; macro rock faces (rockSlope); alpine heights.
        over(3, smooth01((slope - 0.55) / 0.3 + 0.4 * nB + 0.3 * nA) * 0.4 * mtn);
        over(2, smooth01((mslope - rockSlope) / 0.3 + 0.6 * nA + 0.25 * nB) * 0.8 * mtn);
        over(2, smooth01((h - 115) / 30 + 0.6 * nA + 0.3 * nB) * 0.85 * mtn);
      }
      // Rock crags on any steep ground (cut faces, rim, gullies).
      if (slope > 0.5) over(2, smooth01((slope - 0.95) / 0.45 + 0.35 * nB + 0.2 * nA));
      store(splat, material, i, MAT_ASPHALT);
    }
  }
}

/** Lake: muddy bed, gravel waterline, beach fading into grass. */
function paintLake(g: FullGrid, s: CompiledShape, heights: Float32Array, wl: number, splat: Uint8Array, material: Uint8Array, pB: Noise2, warp: Noise2): void {
  const [c0, c1, r0, r1] = boxOf(g, s.minX - LAKE_WARP_M, s.maxX + LAKE_WARP_M, s.minZ - LAKE_WARP_M, s.maxZ + LAKE_WARP_M);
  const band = 0.6 * s.blend;
  for (let r = r0; r <= r1; r++) {
    const z = g.oz + r * g.sp;
    for (let c = c0; c <= c1; c++) {
      const x = g.ox + c * g.sp;
      const i = r * g.cols + c;
      const lx = x + LAKE_WARP_M * warp(x * LAKE_WARP_F, z * LAKE_WARP_F);
      const lz = z + LAKE_WARP_M * warp(z * LAKE_WARP_F + 17.3, x * LAKE_WARP_F - 5.1);
      const rr = s.radius(lx, lz);
      const nB = pB(x * 0.16, z * 0.16);
      if (rr <= 1) {
        load(splat, i);
        over(1, 1);
        over(3, smooth01((heights[i]! - (wl - 1.2)) / 1.0 + 0.4 * nB));
      } else {
        const e = s.outside(lx, lz);
        if (e >= band) continue;
        load(splat, i);
        over(3, smooth01(1 - e / band + 0.35 * nB) * 0.9);
      }
      store(splat, material, i, MAT_ASPHALT);
    }
  }
}

/** Arena: paved (concrete) interior with a gravel apron; material pads: noisy-edged core. */
function paintFlat(g: FullGrid, f: Flat, splat: Uint8Array, material: Uint8Array, pB: Noise2): void {
  const s = f.shape;
  const ch = f.kind === 'arena' ? 0 : chanOfMat(f.material!);
  const pavedMat = f.material === MAT_ASPHALT ? MAT_ASPHALT : f.material === undefined ? MAT_CONCRETE : f.material;
  const [c0, c1, r0, r1] = boxOf(g, s.minX, s.maxX, s.minZ, s.maxZ);
  for (let r = r0; r <= r1; r++) {
    const z = g.oz + r * g.sp;
    for (let c = c0; c <= c1; c++) {
      const x = g.ox + c * g.sp;
      const i = r * g.cols + c;
      const nB = pB(x * 0.16, z * 0.16);
      if (f.kind === 'arena') {
        const e = s.outside(x, z);
        if (e >= 4) continue;
        load(splat, i);
        if (e <= 0) over(0, 1);
        else over(3, smooth01(1 - e / 4 + 0.4 * nB));
      } else {
        const cov = smooth01((s.mask(x, z) - 0.35) / 0.3 + 0.35 * nB);
        if (cov <= 0) continue;
        load(splat, i);
        over(ch, cov);
      }
      store(splat, material, i, ch === 0 ? pavedMat : MAT_ASPHALT);
    }
  }
}

/** Earthworks (cut / fill faces), verge fringe and the roads themselves (last: roads win). */
function paintRoads(
  g: FullGrid,
  layout: WorldLayout,
  profiles: readonly RoadProfile[],
  owner: Uint8Array,
  absD: Float32Array,
  heights: Float32Array,
  nat: Float32Array,
  splat: Uint8Array,
  material: Uint8Array,
  pB: Noise2,
  pC: Noise2,
): void {
  const { cols, rows, ox, oz, sp } = g;
  const nr = layout.roads.length;
  const isConcrete = new Uint8Array(nr);
  const isSplat = new Uint8Array(nr);
  const roadCh = new Int32Array(nr);
  const roadA = new Float64Array(nr);
  for (let k = 0; k < nr; k++) {
    const rd = layout.roads[k]!;
    isConcrete[k] = rd.material === MAT_CONCRETE ? 1 : 0;
    isSplat[k] = profiles[k]!.surface === 'splat' ? 1 : 0;
    roadCh[k] = chanOfMat(rd.material);
    roadA[k] = rd.width / 2;
  }
  for (let r = 0; r < rows; r++) {
    const z = oz + r * sp;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const own = owner[i]!;
      const dh = heights[i]! - nat[i]!;
      const fd = absD[i]!;
      const isRoad = own !== OWNER_NONE && own !== OWNER_PAD;
      if (!isRoad && fd >= FRINGE_M && dh > -0.5 && dh < 0.8) continue;
      const x = ox + c * sp;
      const nB = pB(x * 0.16, z * 0.16);
      load(splat, i);
      let pavedMat = material[i] === MAT_CONCRETE ? MAT_CONCRETE : MAT_ASPHALT;
      // Already paved ground (arena, paved pads) keeps its surface around roads.
      const onPaved = W[0]! >= 0.5;
      if (onPaved && !(isRoad && roadA[own]! >= absD[i]!)) continue;
      if (!isRoad) {
        if (dh < -0.5) over(1, smooth01((-dh - 0.6) / 2.5 + 0.3 * nB) * 0.6);
        else if (dh > 0.8) over(1, smooth01((dh - 1) / 4 + 0.3 * nB) * 0.3);
        if (own === OWNER_NONE && fd < FRINGE_M) {
          over(3, smooth01(1 - fd / FRINGE_M + 0.45 * nB + 0.1 * pC(x * 0.5, z * 0.5)) * 0.8);
        }
      } else {
        const a = roadA[own]!;
        if (isSplat[own]) {
          // Dirt trail: packed earth with ragged edges and a faint grassy crown.
          over(3, 0.45 + 0.3 * nB);
          over(roadCh[own]!, smooth01((a - fd) / 1.2 + 0.35 + 0.3 * nB));
          if (fd < 0.5) over(-1, smooth01(0.2 + 0.5 * nB) * 0.35);
        } else if (fd <= a) {
          over(0, 1);
          pavedMat = isConcrete[own] ? MAT_CONCRETE : MAT_ASPHALT;
        } else {
          over(3, 1);
        }
      }
      store(splat, material, i, pavedMat);
    }
  }
}

// ------------------------------------------------------------ driver
/** Pure, deterministic terrain generator (see the file header and types.ts). Throws WorldLayoutError. */
export function generateTerrain(layout: WorldLayout): TerrainData {
  validateLayout(layout);
  let tMark = now();
  const mark = (name: string): void => {
    const t = now();
    lastTerrainTimings[name] = t - tMark;
    tMark = t;
  };
  const T = layout.terrain;
  const sp = T.spacing;
  const cells = Math.round(layout.size / sp);
  const cols = cells + 1;
  const N = cols * cols;
  const ox = -layout.size / 2;
  const oz = -layout.size / 2;
  const wl = layout.waterLevel;
  const g: FullGrid = { cols, rows: cols, N, ox, oz, sp };

  const rng = createRng(layout.seed);
  const noiseFor = (stream: number): NoiseFunction2D => createSeededNoise2D(rng.fork(stream));
  const vseed = (stream: number): number => Math.floor(rng.fork(stream).float() * 4294967296) | 0;

  // ---------------------------------------------------------- coarse relief
  const cs = sp * COARSE;
  const nc = cells / COARSE + 1;
  const NC = nc * nc;
  const cIdx = new Int32Array(cols);
  const cFrac = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    let ci = Math.floor(c / COARSE);
    if (ci > nc - 2) ci = nc - 2;
    cIdx[c] = ci;
    cFrac[c] = (c - ci * COARSE) / COARSE;
  }
  const cg: CoarseGrid = { nc, NC, cs, cIdx, cFrac };
  const F: CoarseFields = {
    hC: new Float64Array(NC),
    spawnC: new Float32Array(NC),
    roughC: new Float32Array(NC),
    mtnC: new Float32Array(NC),
    hillC: new Float32Array(NC),
    warpXC: new Float32Array(NC),
    warpZC: new Float32Array(NC),
    eroC: new Float32Array(NC),
    mslopeC: new Float32Array(NC),
  };
  const warpX = makeLayer(noiseFor(S_WARP_X), { amplitude: 1, wavelength: WARP_WAVELENGTH, octaves: 2 }, cs);
  const warpZ = makeLayer(noiseFor(S_WARP_Z), { amplitude: 1, wavelength: WARP_WAVELENGTH, octaves: 2 }, cs);
  const detail = makeLayer(noiseFor(S_DETAIL), T.detail, cs);
  const rimL = makeLayer(noiseFor(S_RIM), { amplitude: 1, wavelength: 260, octaves: 2 }, cs);
  const rimRidge = makeLayer(noiseFor(S_RIM_RIDGE), { amplitude: 1, wavelength: 150, octaves: 4 }, cs);

  const zones: ZoneRt[] = layout.zones.map((z, zi) => {
    const zr: ZoneRt = {
      kind: z.kind,
      shape: compileShape(z.shape),
      layer: null,
      amp: 0,
      lift: 0,
      peaks: [],
      peakMax: 1,
      fineW: null,
      carry: null,
    };
    let p: NoiseParams | null = null;
    if (z.kind === 'plains') p = z.params.detail;
    else if (z.kind === 'hills') {
      p = z.params.noise;
      zr.lift = z.params.lift;
    } else if (z.kind === 'mountains') {
      p = z.params.ridged;
      let peakMax = 0;
      zr.peaks = z.params.peaks.map((pk) => {
        if (pk.height > peakMax) peakMax = pk.height;
        return {
          cx: pk.center[0],
          cz: pk.center[1],
          h: pk.height,
          irx2: 1 / (pk.radiusX * pk.radiusX),
          irz2: 1 / (pk.radiusZ * pk.radiusZ),
          ax: pk.axis ? pk.axis[0] : 1,
          az: pk.axis ? pk.axis[1] : 0,
        };
      });
      zr.peakMax = peakMax > 0 ? peakMax : 1;
    }
    if (p) {
      zr.layer = makeLayer(noiseFor(S_ZONE + 2 * zi), p, cs);
      zr.amp = p.amplitude;
      if (zr.layer.split < zr.layer.octaves) {
        zr.fineW = new Float32Array(NC);
        if (z.kind === 'mountains') zr.carry = new Float32Array(NC);
      }
    }
    return zr;
  });
  const relief = (['plains', 'hills', 'mountains'] as const).flatMap((k) => zones.filter((z) => z.kind === k));
  const fine: FineLayer[] = [];
  const detailFineW = detail.split < detail.octaves ? new Float32Array(NC) : null;
  if (detailFineW) fine.push({ L: detail, w: detailFineW, carry: null });
  for (const z of relief) if (z.fineW) fine.push({ L: z.layer!, w: z.fineW, carry: z.carry });
  const firstMtn = layout.zones.find((z) => z.kind === 'mountains');
  const rockSlope = firstMtn && firstMtn.kind === 'mountains' ? firstMtn.params.rockSlope : 0.65;

  coarseRelief(layout, cg, F, relief, detail, detailFineW, warpX, warpZ, rimL, rimRidge);
  mark('coarse');

  // ---------------------------------------------------------- erosion
  const hC0 = Float64Array.from(F.hC);
  const droplets = Math.round((DEFAULT_EROSION.droplets * NC) / (353 * 353));
  erodeHeightfield(F.hC, nc, nc, rng.fork(S_EROSION), { ...DEFAULT_EROSION, droplets }, F.spawnC);
  for (let i = 0; i < NC; i++) F.eroC[i] = F.hC[i]! - hC0[i]!;
  smoothCoarse(F.eroC, new Float32Array(NC), nc);
  for (let i = 0; i < NC; i++) F.hC[i] = hC0[i]! + F.eroC[i]!;
  coarseSlope(F.hC, nc, cs, F.mslopeC);
  mark('erosion');

  // ---------------------------------------------------------- full grid
  const nat = new Float32Array(N);
  upsampleBSpline(F.hC, nc, g, nat);
  fineDetail(
    nat,
    g,
    cg,
    F,
    fine,
    createValueNoise2D(vseed(S_MICRO_A)),
    createValueNoise2D(vseed(S_MICRO_B)),
    noiseFor(S_CRAG),
    noiseFor(S_CRAG_PATCH),
  );
  mark('fullGrid');

  // ---------------------------------------------------------- lake, flats, pads
  const lakebed = noiseFor(S_LAKEBED);
  const lakeWarp = noiseFor(S_LAKE_WARP);
  layout.zones.forEach((z, zi) => {
    if (z.kind === 'lake') carveLake(nat, g, zones[zi]!.shape, wl, z.params.depth, z.params.shoreLift, lakebed, lakeWarp);
  });
  const owner = new Uint8Array(N).fill(OWNER_NONE);
  const coreT = new Float32Array(N);
  const flats: Flat[] = [];
  for (const kind of ['town', 'arena'] as const) {
    layout.zones.forEach((z, zi) => {
      if (z.kind === 'town' && kind === 'town') flats.push({ shape: zones[zi]!.shape, height: z.params.height, kind, material: undefined });
      if (z.kind === 'arena' && kind === 'arena') flats.push({ shape: zones[zi]!.shape, height: z.params.height, kind, material: z.params.material });
    });
  }
  // Zone flats first (contract order: zones → edge rise → pads; the rim lives in the coarse field).
  for (const f of flats) flatten(nat, owner, coreT, g, f.shape, f.height);
  for (const p of layout.pads) {
    const s = compileShape(p.shape);
    const H = p.height ?? meanInside(nat, g, s);
    flatten(nat, owner, coreT, g, s, H);
    flats.push({ shape: s, height: H, kind: 'pad', material: p.material });
  }
  mark('flats');

  // ---------------------------------------------------------- roads
  const profiles = resolveRoadProfiles(layout, (x, z) => bilinear(nat, cols, cols, ox, oz, sp, x, z));
  mark('roadProfiles');
  const s1 = new Float32Array(N);
  const s2 = new Float32Array(N);
  const s3 = new Float32Array(N);
  const absD = new Float32Array(N).fill(99);
  const stamp = new Uint8Array(N);
  // Carve in priority ASC (ties: later declared first) so the road resolved first wins.
  const carveOrder = layout.roads
    .map((r, i) => ({ i, p: ROAD_KIND_DEFAULTS[r.kind].priority }))
    .sort((a, b) => a.p - b.p || b.i - a.i)
    .map((o) => o.i);
  for (const ri of carveOrder) rasterRoad(profiles[ri]!, ri, g, owner, coreT, absD, stamp, s1);
  releasePads(owner, absD, N);
  mark('roadRaster');
  const heights = new Float32Array(N);
  slopeEnvelope(g, owner, coreT, nat, heights, new Int32Array(s1.buffer), new Int32Array(s2.buffer), s3);
  mark('envelope');
  roundCreases(g, owner, nat, heights, s3, s1, s2, T.minHeight, T.maxHeight);
  mark('creases');

  // ---------------------------------------------------------- splat + material
  const splat = new Uint8Array(N * SPLAT_CHANNELS);
  const material = new Uint8Array(N);
  const pB = createValueNoise2D(vseed(S_PAINT_B));
  const pC = createValueNoise2D(vseed(S_PAINT_C));
  const pA = noiseFor(S_PAINT_A);
  const nAC = new Float32Array(NC); // patch noise (~30 m) is smooth: coarse grid
  for (let r = 0; r < nc; r++) for (let c = 0; c < nc; c++) nAC[r * nc + c] = pA((ox + c * cs) * 0.035, (oz + r * cs) * 0.035);
  paintNatural(g, cg, F, nAC, heights, splat, material, pB, rockSlope);
  layout.zones.forEach((z, zi) => {
    if (z.kind === 'lake') paintLake(g, zones[zi]!.shape, heights, wl, splat, material, pB, lakeWarp);
  });
  for (const f of flats) {
    if (f.kind === 'arena' || (f.kind === 'pad' && f.material !== undefined)) paintFlat(g, f, splat, material, pB);
  }
  paintRoads(g, layout, profiles, owner, absD, heights, nat, splat, material, pB, pC);
  mark('paint');

  // ---------------------------------------------------------- spawns, stats
  const smp = createRoadSample();
  const spawns: ResolvedSpawn[] = layout.spawnPoints.map((s) => {
    if (s.road) {
      const ri = layout.roads.findIndex((r) => r.id === s.road!.id);
      sampleRoad(profiles[ri]!, s.road.s, smp);
      const x = smp.x + smp.rx * s.road.d;
      const z = smp.z + smp.rz * s.road.d;
      const y = bilinear(heights, cols, cols, ox, oz, sp, x, z);
      const yaw = s.road.reverse ? headingToYaw(-smp.tx, -smp.tz) : headingToYaw(smp.tx, smp.tz);
      return { id: s.id, name: s.name, pos: [x, y, z] as const, yaw };
    }
    const [x, z] = s.pos!;
    return { id: s.id, name: s.name, pos: [x, bilinear(heights, cols, cols, ox, oz, sp, x, z), z] as const, yaw: s.yaw ?? 0 };
  });
  const range = heightRange(heights);
  const terrain: TerrainData = {
    layoutId: layout.id,
    layoutVersion: layout.version,
    seed: layout.seed,
    originX: ox,
    originZ: oz,
    spacing: sp,
    cols,
    rows: cols,
    heights,
    splat,
    material,
    minHeight: range[0],
    maxHeight: range[1],
    waterLevel: wl,
    roads: profiles,
    spawns,
    hash: 0,
  };
  terrain.hash = hashTerrain(terrain);
  mark('hash');
  return terrain;
}

function heightRange(h: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Dominant splat channel → MaterialId (ties: paved > dirt > rock > gravel > grass). */
export function dominantMaterial(q0: number, q1: number, q2: number, q3: number, pavedMat: number): number {
  const grass = 255 - (q0 + q1 + q2 + q3);
  let best = q0;
  let mat = pavedMat;
  if (q1 > best) {
    best = q1;
    mat = MAT_DIRT;
  }
  if (q2 > best) {
    best = q2;
    mat = MAT_ROCK;
  }
  if (q3 > best) {
    best = q3;
    mat = MAT_GRAVEL;
  }
  if (grass > best) mat = MAT_GRASS;
  return mat;
}

// ============================================================ hash
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function hashWords(h: number, w: Uint32Array): number {
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i]!, FNV_PRIME) >>> 0;
  return h;
}

function hashBytes(h: number, b: Uint8Array): number {
  const n = b.length;
  const words = n >>> 2;
  if ((b.byteOffset & 3) === 0) {
    h = hashWords(h, new Uint32Array(b.buffer, b.byteOffset, words));
  } else {
    for (let k = 0; k < words; k++) {
      const o = k << 2;
      const v = (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
      h = Math.imul(h ^ v, FNV_PRIME) >>> 0;
    }
  }
  const rem = n & 3;
  if (rem > 0) {
    const o = words << 2;
    let v = 0;
    for (let k = 0; k < rem; k++) v |= b[o + k]! << (8 * k);
    h = Math.imul(h ^ (v >>> 0), FNV_PRIME) >>> 0;
  }
  return h;
}

/**
 * FNV-1a 32 word-wise over cols, rows, heights (raw f32 words), material and
 * splat (u32 words, zero-padded tail), then per road stationCount + stations
 * (raw f64 → 2 words, platform (little-endian) order). Returns u32.
 */
export function hashTerrain(t: TerrainData): number {
  let h = FNV_OFFSET;
  h = Math.imul(h ^ (t.cols >>> 0), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ (t.rows >>> 0), FNV_PRIME) >>> 0;
  const hb = t.heights;
  h = hashBytes(h, new Uint8Array(hb.buffer, hb.byteOffset, hb.byteLength));
  h = hashBytes(h, t.material);
  h = hashBytes(h, t.splat);
  for (const r of t.roads) {
    h = Math.imul(h ^ (r.stationCount >>> 0), FNV_PRIME) >>> 0;
    const s = r.stations;
    h = hashBytes(h, new Uint8Array(s.buffer, s.byteOffset, s.byteLength));
  }
  return h >>> 0;
}

