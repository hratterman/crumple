/**
 * Vegetation scatter (P5, U4). CONTRACT: VegetationScatter /
 * ScatterVegetation / HashVegetation in ./types (placement + collider rules
 * there). PURE and deterministic with the generator's numerics (core/rng
 * forked from layout.seed, core/noise, only + − × ÷ sqrt floor abs min max,
 * fixed loop order): the physics worker derives the tree colliders from the
 * same call, and both sides compare hashVegetation.
 *
 * Biomes (densities are acceptance probabilities of jittered-grid
 * candidates, followed by a minimum-spacing test = Poisson-disk-ish):
 *   - CONIFER forest on the mountain flanks and the North Downs, in
 *     noise-shaped stands with meadow gaps, thinning with altitude to a tree
 *     line, denser on shady north slopes, none on rock;
 *   - BROADLEAF groves (low-frequency clumps) and lone trees on the plains
 *     and western hills, galleries along drainage creases and toward the
 *     lake, and a mixed band on the lower mountain flanks;
 *   - SHRUBS: dry scrub on sunny south slopes, bushes at forest edges,
 *     REEDS in the lake shore band, ferns in the forest understory;
 *   - ROCKS on rock / scree splat and outcrop margins, BOULDERS near
 *     outcrops and under rock faces.
 * Clearings: the summit lookout (view south over the valley), a soft view
 * corridor along the highway, roadside thinning everywhere else.
 */
import { createSeededNoise2D } from '../core/noise';
import { createRng } from '../core/rng';
import { MaterialId } from '../protocol/messages';
import { colliderWorldAabb, resolveColliders } from './colliders';
import { compileShape, type CompiledShape } from './shapes';
import {
  RoadStation,
  ROAD_STATION_STRIDE,
  SPLAT_CHANNELS,
  VEG_BOULDER_CENTER_LIFT,
  VEG_BOULDER_RADIUS_M,
  VEG_COLLIDER_REACH_M,
  VEG_MAX_COLLIDERS,
  VEG_MAX_INSTANCES,
  VEG_ROAD_CLEARANCE_M,
  VEG_TREE_MIN_SPACING_M,
  VEG_TRUNK_HALF_HEIGHT_M,
  VEG_TRUNK_RADIUS_M,
  VegetationKind,
  type ColliderDef,
  type HashVegetation,
  type ScatterVegetation,
  type TerrainData,
  type VegetationScatter,
} from './types';

export function emptyScatter(): VegetationScatter {
  return {
    count: 0,
    kind: new Uint8Array(0),
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
    scale: new Float32Array(0),
    yaw: new Float32Array(0),
    variant: new Uint8Array(0),
    rank: new Float32Array(0),
    collider: new Int32Array(0),
    colliders: [],
    hash: 0,
  };
}

/** FNV-1a 32 over count, then per instance kind, x, y, z, scale (f32 bits), collider (contract word order). */
export const hashVegetation: HashVegetation = (s) => {
  let h = 0x811c9dc5;
  const mix = (w: number): void => {
    h = Math.imul(h ^ w, 0x01000193) >>> 0;
  };
  mix(s.count);
  const f = new Uint32Array(1);
  const ff = new Float32Array(f.buffer);
  for (let i = 0; i < s.count; i++) {
    mix(s.kind[i]!);
    ff[0] = s.x[i]!;
    mix(f[0]!);
    ff[0] = s.y[i]!;
    mix(f[0]!);
    ff[0] = s.z[i]!;
    mix(f[0]!);
    ff[0] = s.scale[i]!;
    mix(f[0]!);
    mix(s.collider[i]! >>> 0);
  }
  return h >>> 0;
};

/** Typed-array buffers of a scatter (transfer list for the terrain helper worker). */
export function scatterBuffers(s: VegetationScatter): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const a of [s.kind, s.x, s.y, s.z, s.scale, s.yaw, s.variant, s.rank, s.collider]) {
    if (a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0 && !out.includes(a.buffer)) out.push(a.buffer);
  }
  return out;
}

// ============================================================ tuning
/** Variants per kind (conifer, broadleaf, shrub, rock, boulder) the renderer builds; the scatter emits 0..n−1. */
export const VEG_VARIANTS: readonly number[] = [3, 3, 4, 4, 4];
/** Conifer: spruce, fir, pine. Broadleaf: oak, beech, birch. Shrub: bush, scrub, reeds, fern. */
export const VegVariant = {
  spruce: 0,
  fir: 1,
  pine: 2,
  oak: 0,
  beech: 1,
  birch: 2,
  bush: 0,
  scrub: 1,
  reeds: 2,
  fern: 3,
} as const;

/** Road distances are resolved up to this beyond the verge, m (larger reads as FAR_M). */
const ROAD_REACH_HW = 38;
const ROAD_REACH = 29;
const FAR_M = 40;
/** Road segment index cell, m. */
const ROAD_CELL = 24;
/** Jittered-grid cell per pass, m. */
const TREE_CELL = 4.4;
const SHRUB_CELL = 4;
/** Outcrop-proximity grid cell, samples. */
const ROCK_GRID = 4;
const ROCK_CELL = 4.5;
const BOULDER_CELL = 9;
/** Minimum plan distance shrub ↔ trunk and shrub ↔ shrub, m. */
const SHRUB_TREE_GAP = 1.8;
const SHRUB_GAP = 1.6;
/** Colliders (trees + boulders) keep at least this apart (the 8 m collider grid stays sparse). */
const COLLIDER_GAP = VEG_TREE_MIN_SPACING_M;
/** Summit lookout clearing (view over the valley to the south). */
const LOOKOUT_CLEAR_M = 70;
const LOOKOUT_FADE_M = 70;
/** Highway view corridor: trees thin out within this distance of its verge. */
const HIGHWAY_CORRIDOR_M = 34;
/** Tree line (height above the datum, m). */
const TREE_LINE_START = 105;
const TREE_LINE_END = 142;
/** Trees and shrubs need at least this normal.y (≈ 35°; contract ≥ 0.8). */
export const VEG_MIN_TREE_NY = 0.82;
const TWO_PI = 6.283185307179586;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const sstep = (a: number, b: number, x: number): number => smooth((x - a) / (b - a));

/**
 * Exact plan distance to the nearest carriageway + shoulder edge: every
 * station chord (2 m) of every road, bucketed into a ROAD_CELL grid (CSR)
 * by its capsule (half width + reach). A query tests only its cell's chords.
 */
class RoadIndex {
  private readonly cols: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  /** Per chord: ax, az, ex, ez, 1/|e|², half (verge edge), highway flag. */
  private readonly seg: Float64Array;
  /** Outputs of the last query. */
  d = FAR_M;
  hw = FAR_M;
  constructor(
    terrain: TerrainData,
    private readonly ox: number,
    private readonly oz: number,
    size: number,
  ) {
    this.cols = Math.floor(size / ROAD_CELL) + 1;
    const cols = this.cols;
    let nSeg = 0;
    for (const r of terrain.roads) nSeg += r.closed ? r.stationCount : r.stationCount - 1;
    const seg = new Float64Array(nSeg * 7);
    const bbox = new Int32Array(nSeg * 4);
    const count = new Int32Array(cols * cols + 1);
    let k = 0;
    for (const road of terrain.roads) {
      const half = road.width * 0.5 + road.shoulder;
      const isHw = road.kind === 'highway';
      const reach = half + (isHw ? ROAD_REACH_HW : ROAD_REACH);
      const st = road.stations;
      const n = road.stationCount;
      const segs = road.closed ? n : n - 1;
      for (let j = 0; j < segs; j++, k++) {
        const a = j * ROAD_STATION_STRIDE;
        const b = ((j + 1) % n) * ROAD_STATION_STRIDE;
        const ax = st[a + RoadStation.x]!;
        const az = st[a + RoadStation.z]!;
        const ex = st[b + RoadStation.x]! - ax;
        const ez = st[b + RoadStation.z]! - az;
        const l2 = ex * ex + ez * ez;
        const o = k * 7;
        seg[o] = ax;
        seg[o + 1] = az;
        seg[o + 2] = ex;
        seg[o + 3] = ez;
        seg[o + 4] = l2 > 0 ? 1 / l2 : 0;
        seg[o + 5] = half;
        seg[o + 6] = isHw ? 1 : 0;
        const c0 = this.cell(Math.min(ax, ax + ex) - reach - ox);
        const c1 = this.cell(Math.max(ax, ax + ex) + reach - ox);
        const r0 = this.cell(Math.min(az, az + ez) - reach - oz);
        const r1 = this.cell(Math.max(az, az + ez) + reach - oz);
        bbox[k * 4] = c0;
        bbox[k * 4 + 1] = c1;
        bbox[k * 4 + 2] = r0;
        bbox[k * 4 + 3] = r1;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) count[r * cols + c + 1]!++;
      }
    }
    for (let i = 1; i < count.length; i++) count[i]! += count[i - 1]!;
    const fill = count.slice(0, cols * cols);
    const items = new Int32Array(count[cols * cols]!);
    for (let s = 0; s < nSeg; s++) {
      for (let r = bbox[s * 4 + 2]!; r <= bbox[s * 4 + 3]!; r++) {
        for (let c = bbox[s * 4]!; c <= bbox[s * 4 + 1]!; c++) items[fill[r * cols + c]!++] = s;
      }
    }
    this.start = count;
    this.items = items;
    this.seg = seg;
  }
  private cell(v: number): number {
    const c = Math.floor(v / ROAD_CELL);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }
  /** Sets `d` (any road) and `hw` (highway) for (x, z), each min(distance, FAR_M). */
  query(x: number, z: number): void {
    const cell = this.cell(z - this.oz) * this.cols + this.cell(x - this.ox);
    let d2 = FAR_M;
    let h2 = FAR_M;
    const seg = this.seg;
    for (let j = this.start[cell]!, e = this.start[cell + 1]!; j < e; j++) {
      const o = this.items[j]! * 7;
      const px = x - seg[o]!;
      const pz = z - seg[o + 1]!;
      const ex = seg[o + 2]!;
      const ez = seg[o + 3]!;
      let t = (px * ex + pz * ez) * seg[o + 4]!;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - t * ex;
      const qz = pz - t * ez;
      const half = seg[o + 5]!;
      const isHw = seg[o + 6]! > 0;
      const lim = (isHw ? h2 : d2) + half;
      const q2 = qx * qx + qz * qz;
      if (q2 >= lim * lim) continue;
      const dist = Math.sqrt(q2) - half;
      if (dist < d2) d2 = dist;
      if (isHw) h2 = dist;
    }
    this.d = d2;
    this.hw = h2;
  }
}

/** Point hash for spacing tests (plan metres); `near` radius must be ≤ cell. */
class PointHash {
  private readonly head: Int32Array;
  private next = new Int32Array(1024);
  private px = new Float64Array(1024);
  private pz = new Float64Array(1024);
  private n = 0;
  private readonly cols: number;
  constructor(
    private readonly cell: number,
    private readonly ox: number,
    private readonly oz: number,
    size: number,
  ) {
    this.cols = Math.floor(size / cell) + 2;
    this.head = new Int32Array(this.cols * this.cols).fill(-1);
  }
  add(x: number, z: number): void {
    if (this.n === this.px.length) {
      const px = new Float64Array(this.n * 2);
      px.set(this.px);
      this.px = px;
      const pz = new Float64Array(this.n * 2);
      pz.set(this.pz);
      this.pz = pz;
      const nx = new Int32Array(this.n * 2);
      nx.set(this.next);
      this.next = nx;
    }
    let c = Math.floor((x - this.ox) / this.cell);
    let r = Math.floor((z - this.oz) / this.cell);
    c = c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    r = r < 0 ? 0 : r >= this.cols ? this.cols - 1 : r;
    const k = r * this.cols + c;
    this.px[this.n] = x;
    this.pz[this.n] = z;
    this.next[this.n] = this.head[k]!;
    this.head[k] = this.n++;
  }
  near(x: number, z: number, rad: number): boolean {
    const c = Math.floor((x - this.ox) / this.cell);
    const rr = Math.floor((z - this.oz) / this.cell);
    const r2 = rad * rad;
    for (let dr = -1; dr <= 1; dr++) {
      const row = rr + dr;
      if (row < 0 || row >= this.cols) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const col = c + dc;
        if (col < 0 || col >= this.cols) continue;
        for (let j = this.head[row * this.cols + col]!; j >= 0; j = this.next[j]!) {
          const dx = this.px[j]! - x;
          const dz = this.pz[j]! - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }
}

/** Growable SoA output. */
class Out {
  n = 0;
  kind: Uint8Array = new Uint8Array(4096);
  x: Float32Array = new Float32Array(4096);
  y: Float32Array = new Float32Array(4096);
  z: Float32Array = new Float32Array(4096);
  scale: Float32Array = new Float32Array(4096);
  yaw: Float32Array = new Float32Array(4096);
  variant: Uint8Array = new Uint8Array(4096);
  rank: Float32Array = new Float32Array(4096);
  collider: Int32Array = new Int32Array(4096);
  push(kind: number, x: number, y: number, z: number, scale: number, yaw: number, variant: number, rank: number): number {
    if (this.n === this.kind.length) {
      const cap = this.n * 2;
      const g8 = (a: Uint8Array): Uint8Array => {
        const b = new Uint8Array(cap);
        b.set(a);
        return b;
      };
      const g32 = (a: Float32Array): Float32Array => {
        const b = new Float32Array(cap);
        b.set(a);
        return b;
      };
      this.kind = g8(this.kind);
      this.variant = g8(this.variant);
      this.x = g32(this.x);
      this.y = g32(this.y);
      this.z = g32(this.z);
      this.scale = g32(this.scale);
      this.yaw = g32(this.yaw);
      this.rank = g32(this.rank);
      const c = new Int32Array(cap);
      c.set(this.collider);
      this.collider = c;
    }
    const i = this.n++;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.scale[i] = scale;
    this.yaw[i] = yaw;
    this.variant[i] = variant;
    this.rank[i] = rank;
    this.collider[i] = -1;
    return i;
  }
}

/** Cumulative wall ms at the end of each scatter stage (diagnostics only). */
export const lastScatterTimings: Record<string, number> = {};

/**
 * Plan exclusion boxes binned in BOX_CELL m cells (layout v6: thousands of content colliders —
 * the linear scan per candidate point was O(points × boxes)). Axis-aligned boxes and oriented
 * rectangles; a point is excluded when inside any. Exact (no false positives / negatives).
 */
const BOX_CELL = 32;
class BoxGrid {
  private readonly n: number;
  private readonly cells: number[][];
  /** Flat records: kind 0 = aabb [x0, z0, x1, z1]; kind 1 = obb [cx, cz, ax, az, hx, hz]. */
  private readonly recs: number[][] = [];
  constructor(
    private readonly ox: number,
    private readonly oz: number,
    size: number,
  ) {
    this.n = Math.ceil(size / BOX_CELL) + 1;
    this.cells = Array.from({ length: this.n * this.n }, () => []);
  }
  private bin(x0: number, z0: number, x1: number, z1: number, id: number): void {
    const n = this.n;
    const c0 = Math.max(0, Math.floor((x0 - this.ox) / BOX_CELL));
    const c1 = Math.min(n - 1, Math.floor((x1 - this.ox) / BOX_CELL));
    const r0 = Math.max(0, Math.floor((z0 - this.oz) / BOX_CELL));
    const r1 = Math.min(n - 1, Math.floor((z1 - this.oz) / BOX_CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * n + c]!.push(id);
  }
  add(x0: number, z0: number, x1: number, z1: number): void {
    this.recs.push([0, x0, z0, x1, z1]);
    this.bin(x0, z0, x1, z1, this.recs.length - 1);
  }
  addOriented(cx: number, cz: number, ax: number, az: number, hx: number, hz: number): void {
    this.recs.push([1, cx, cz, ax, az, hx, hz]);
    const ex = Math.abs(ax) * hx + Math.abs(az) * hz;
    const ez = Math.abs(az) * hx + Math.abs(ax) * hz;
    this.bin(cx - ex, cz - ez, cx + ex, cz + ez, this.recs.length - 1);
  }
  hit(x: number, z: number): boolean {
    const c = Math.floor((x - this.ox) / BOX_CELL);
    const r = Math.floor((z - this.oz) / BOX_CELL);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return false;
    for (const id of this.cells[r * this.n + c]!) {
      const b = this.recs[id]!;
      if (b[0] === 0) {
        if (x >= b[1]! && z >= b[2]! && x <= b[3]! && z <= b[4]!) return true;
      } else {
        const dx = x - b[1]!;
        const dz = z - b[2]!;
        const u = dx * b[3]! + dz * b[4]!;
        const v = -dx * b[4]! + dz * b[3]!;
        if (u >= -b[5]! && u <= b[5]! && v >= -b[6]! && v <= b[6]!) return true;
      }
    }
    return false;
  }
}

/** Fractional part × 2π (render yaw in [0, 2π)). */
const yawOf = (t: number): number => (t - Math.floor(t)) * TWO_PI;

/**
 * Deterministic scatter over the generated terrain (contract in ./types).
 * Reads `terrain.splat` (rock rule): the physics worker must call it BEFORE
 * dropping the splat (an empty splat reads as pure grass and changes the
 * result → hash mismatch).
 */
export const scatterVegetation: ScatterVegetation = (layout, terrain, extra) => {
  const tStart = performance.now();
  const { cols, rows, spacing, originX, originZ, heights, splat } = terrain;
  const size = (cols - 1) * spacing;
  const hasSplat = splat.length >= cols * rows * SPLAT_CHANNELS;
  const base = layout.terrain.baseHeight;
  const water = layout.waterLevel;

  // ---- grid queries (bilinear height; central-difference slope at 2 m) ----
  const hAt = (x: number, z: number): number => {
    let fx = (x - originX) / spacing;
    let fz = (z - originZ) / spacing;
    fx = fx < 0 ? 0 : fx > cols - 1 ? cols - 1 : fx;
    fz = fz < 0 ? 0 : fz > rows - 1 ? rows - 1 : fz;
    let c = Math.floor(fx);
    let r = Math.floor(fz);
    if (c > cols - 2) c = cols - 2;
    if (r > rows - 2) r = rows - 2;
    const tx = fx - c;
    const tz = fz - r;
    const i = r * cols + c;
    const a = heights[i]! + (heights[i + 1]! - heights[i]!) * tx;
    const b = heights[i + cols]! + (heights[i + cols + 1]! - heights[i + cols]!) * tx;
    return a + (b - a) * tz;
  };
  // Nearest-sample splat weights at the last splatAt query.
  let sPaved = 0;
  let sDirt = 0;
  let sRock = 0;
  let sGravel = 0;
  const splatAt = (x: number, z: number): void => {
    if (!hasSplat) {
      sPaved = sDirt = sRock = sGravel = 0;
      return;
    }
    let c = Math.floor((x - originX) / spacing + 0.5);
    let r = Math.floor((z - originZ) / spacing + 0.5);
    c = c < 0 ? 0 : c > cols - 1 ? cols - 1 : c;
    r = r < 0 ? 0 : r > rows - 1 ? rows - 1 : r;
    const i = (r * cols + c) * SPLAT_CHANNELS;
    sPaved = splat[i]! / 255;
    sDirt = splat[i + 1]! / 255;
    sRock = splat[i + 2]! / 255;
    sGravel = splat[i + 3]! / 255;
  };
  // Outcrop proximity: mean rock splat per ROCK_GRID cell, then a 3×3 box (≈ 12 m window), bilinear.
  const rgN = Math.floor((cols - 1) / ROCK_GRID) + 1;
  const rockGrid = new Float32Array(rgN * rgN);
  if (hasSplat) {
    const acc = new Float32Array(rgN * rgN);
    for (let r = 0; r < rows; r++) {
      const gr = Math.floor(r / ROCK_GRID) * rgN;
      for (let c = 0; c < cols; c++) {
        const g = gr + Math.floor(c / ROCK_GRID);
        acc[g] = acc[g]! + splat[(r * cols + c) * SPLAT_CHANNELS + 2]!;
      }
    }
    for (let r = 0; r < rgN; r++) {
      for (let c = 0; c < rgN; c++) {
        let sum = 0;
        for (let j = -1; j <= 1; j++) {
          const rr = r + j < 0 ? 0 : r + j >= rgN ? rgN - 1 : r + j;
          for (let i = -1; i <= 1; i++) {
            const cc = c + i < 0 ? 0 : c + i >= rgN ? rgN - 1 : c + i;
            sum += acc[rr * rgN + cc]!;
          }
        }
        rockGrid[r * rgN + c] = sum / (9 * ROCK_GRID * ROCK_GRID * 255);
      }
    }
  }
  const rockNear = (x: number, z: number): number => {
    let fx = (x - originX) / (spacing * ROCK_GRID) - 0.5;
    let fz = (z - originZ) / (spacing * ROCK_GRID) - 0.5;
    fx = fx < 0 ? 0 : fx > rgN - 1.001 ? rgN - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > rgN - 1.001 ? rgN - 1.001 : fz;
    const c = Math.floor(fx);
    const r = Math.floor(fz);
    const tx = fx - c;
    const tz = fz - r;
    const i = r * rgN + c;
    const a = rockGrid[i]! + (rockGrid[i + 1]! - rockGrid[i]!) * tx;
    const b = rockGrid[i + rgN]! + (rockGrid[i + rgN + 1]! - rockGrid[i + rgN]!) * tx;
    return a + (b - a) * tz;
  };
  // Height gradient (2 m central differences) at the last normalY query: slope aspect.
  let GX = 0;
  let GZ = 0;
  // The sampler's smoothed normal (src/world/sampler.ts semantics: bilinear blend of the 4 corner
  // vertex normals from central differences, renormalized), so the slope rule matches normalAt.
  const inv2s = 1 / (2 * spacing);
  let NX = 0;
  let NY = 0;
  let NZ = 0;
  const vertexN = (c: number, r: number, w: number): void => {
    const cm = c > 0 ? c - 1 : c;
    const cp = c < cols - 1 ? c + 1 : c;
    const rm = r > 0 ? r - 1 : r;
    const rp = r < rows - 1 ? r + 1 : r;
    const gx = ((heights[r * cols + cp]! - heights[r * cols + cm]!) * inv2s * 2) / (cp - cm);
    const gz = ((heights[rp * cols + c]! - heights[rm * cols + c]!) * inv2s * 2) / (rp - rm);
    const inv = w / Math.sqrt(gx * gx + 1 + gz * gz);
    NX -= gx * inv;
    NY += inv;
    NZ -= gz * inv;
  };
  const normalY = (x: number, z: number): number => {
    GX = (hAt(x + 2, z) - hAt(x - 2, z)) * 0.25;
    GZ = (hAt(x, z + 2) - hAt(x, z - 2)) * 0.25;
    let fx = (x - originX) / spacing;
    let fz = (z - originZ) / spacing;
    fx = fx < 0 ? 0 : fx > cols - 1 ? cols - 1 : fx;
    fz = fz < 0 ? 0 : fz > rows - 1 ? rows - 1 : fz;
    let c = Math.floor(fx);
    let r = Math.floor(fz);
    if (c > cols - 2) c = cols - 2;
    if (r > rows - 2) r = rows - 2;
    const tx = fx - c;
    const tz = fz - r;
    NX = NY = NZ = 0;
    vertexN(c, r, (1 - tx) * (1 - tz));
    vertexN(c + 1, r, tx * (1 - tz));
    vertexN(c, r + 1, (1 - tx) * tz);
    vertexN(c + 1, r + 1, tx * tz);
    return NY / Math.sqrt(NX * NX + NY * NY + NZ * NZ);
  };
  /** +1 on a slope facing south (+Z, downhill toward +Z), −1 facing north. */
  const southness = (): number => -GZ / Math.sqrt(GX * GX + GZ * GZ + 1e-4);
  /** Concavity at 14 m: + in creases / valleys (drainage lines), − on knolls and ridges. */
  const crease = (x: number, z: number, h: number): number =>
    (hAt(x + 14, z) + hAt(x - 14, z) + hAt(x, z + 14) + hAt(x, z - 14)) * 0.25 - h;

  // ---- zones / exclusions ----
  let range: CompiledShape | null = null;
  let hills: CompiledShape | null = null;
  const lakes: CompiledShape[] = [];
  const ponds: { s: CompiledShape; level: number }[] = [];
  const flats: CompiledShape[] = [];
  const arenas: CompiledShape[] = [];
  for (const zn of layout.zones) {
    const s = compileShape(zn.shape);
    if (zn.kind === 'mountains') range ??= s;
    else if (zn.kind === 'hills') hills ??= s;
    else if (zn.kind === 'lake') {
      lakes.push(s);
      // Layout v6: ponds / fords above the valley water plane keep their own shoreline clear.
      if (zn.params.level !== undefined && zn.params.level > water) ponds.push({ s, level: zn.params.level });
    }
    else if (zn.kind === 'town' || zn.kind === 'arena') {
      flats.push(s);
      if (zn.kind === 'arena') arenas.push(s);
    }
  }
  const pads = layout.pads.map((p) => compileShape(p.shape));
  const lookout = layout.pads.find((p) => p.purpose === 'lookout');
  const lookC = lookout ? compileShape(lookout.shape) : null;
  const lookX = lookC ? (lookC.minX + lookC.maxX) * 0.5 : 0;
  const lookZ = lookC ? (lookC.minZ + lookC.maxZ) * 0.5 : 0;

  // Static colliders (AABB + 2 m) and props (+ 3 m) as plan boxes; spawns 12 m.
  // Layout v6: + the world content's colliders / props / footprints, binned in a plan grid.
  const boxes = new BoxGrid(originX, originZ, size);
  for (const c of resolveColliders([...(layout.colliders ?? []), ...(extra?.colliders ?? [])], hAt)) {
    if (c.visual === 'lid') continue; // tunnel lids: the cover is excluded by its footprint instead
    const b = colliderWorldAabb(c, 2);
    boxes.add(b[0], b[2], b[3], b[5]);
  }
  for (const p of [...(layout.props ?? []), ...(extra?.props ?? [])]) {
    const n = p.row ? p.row.count : 1;
    for (let k = 0; k < n; k++) {
      const x = p.pos[0] + (p.row ? p.row.step[0] * k : 0);
      const z = p.pos[2] + (p.row ? p.row.step[1] * k : 0);
      boxes.add(x - 3, z - 3, x + 3, z + 3);
    }
  }
  for (const e of extra?.exclusions ?? []) boxes.addOriented(e.cx, e.cz, e.ax, e.az, e.hx, e.hz);
  const spawns = terrain.spawns.map((s) => [s.pos[0], s.pos[2]] as const);

  const roadIdx = new RoadIndex(terrain, originX, originZ, size);
  lastScatterTimings.field = performance.now() - tStart;

  /** Hard exclusions shared by every kind (water, flats, pads, colliders, props, spawns, map rim). */
  const blocked = (x: number, z: number, h: number, padMargin: number): boolean => {
    if (h < water + 0.4) return true;
    for (const p of ponds) if (h < p.level + 0.6 && p.s.outside(x, z) < p.s.blend + 6) return true;
    if (x < originX + 4 || x > originX + size - 4 || z < originZ + 4 || z > originZ + size - 4) return true;
    for (const f of flats) if (f.mask(x, z) > 0.1) return true;
    for (const p of pads) if (p.outside(x, z) < padMargin) return true;
    if (boxes.hit(x, z)) return true;
    for (const s of spawns) {
      const dx = x - s[0];
      const dz = z - s[1];
      if (dx * dx + dz * dz < 144) return true;
    }
    return false;
  };
  /** Within VEG_COLLIDER_REACH_M of a drivable area (road verge edges, pads, arena)? */
  const inReach = (x: number, z: number, roadDist: number): boolean => {
    if (roadDist <= VEG_COLLIDER_REACH_M) return true;
    for (const p of pads) if (p.outside(x, z) <= VEG_COLLIDER_REACH_M) return true;
    for (const a of arenas) if (a.outside(x, z) <= VEG_COLLIDER_REACH_M) return true;
    return false;
  };

  // ---- noise + streams (fixed stream ids) ----
  const rng = createRng(layout.seed).fork(0x7e6e7a11);
  const nStand = createSeededNoise2D(rng.fork(1));
  const nGrove = createSeededNoise2D(rng.fork(2));
  const nMix = createSeededNoise2D(rng.fork(3));
  const nScrub = createSeededNoise2D(rng.fork(4));
  const nDetail = createSeededNoise2D(rng.fork(5));
  const rTree = rng.fork(10);
  const rShrub = rng.fork(11);
  const rRock = rng.fork(12);
  const rBoulder = rng.fork(13);

  const out = new Out();
  const colliders: ColliderDef[] = [];
  const treeHash = new PointHash(VEG_TREE_MIN_SPACING_M, originX, originZ, size);
  const colliderHash = new PointHash(COLLIDER_GAP, originX, originZ, size);
  const shrubHash = new PointHash(SHRUB_TREE_GAP, originX, originZ, size);

  const addCollider = (i: number, kind: number, x: number, z: number, scale: number, h: number): void => {
    if (kind === VegetationKind.boulder) {
      const r = VEG_BOULDER_RADIUS_M * scale;
      colliders.push({
        id: `veg:${i}`,
        kind: 'sphere',
        pos: [x, h + VEG_BOULDER_CENTER_LIFT * r, z],
        quat: [0, 0, 0, 1],
        size: [r, 0, 0],
        material: MaterialId.rock,
        visual: 'none',
      });
    } else {
      colliders.push({
        id: `veg:${i}`,
        kind: 'cylinder',
        pos: [x, null, z],
        quat: [0, 0, 0, 1],
        size: [VEG_TRUNK_RADIUS_M[kind]! * scale, VEG_TRUNK_HALF_HEIGHT_M, 0],
        material: MaterialId.wood,
        visual: 'none',
      });
    }
    out.collider[i] = colliders.length - 1;
    colliderHash.add(x, z);
  };

  // ================================================================ trees
  const nt = Math.floor(size / TREE_CELL);
  for (let gr = 0; gr < nt; gr++) {
    for (let gc = 0; gc < nt; gc++) {
      // Every cell draws the same number of values: later cells never depend on earlier rejections.
      const x = originX + (gc + rTree.float()) * TREE_CELL;
      const z = originZ + (gr + rTree.float()) * TREE_CELL;
      const u = rTree.float();
      const u2 = rTree.float();
      const u3 = rTree.float();
      const u4 = rTree.float();
      const rank = rTree.float();
      if (out.n >= VEG_MAX_INSTANCES) continue;
      roadIdx.query(x, z);
      const rd = roadIdx.d;
      if (rd < VEG_ROAD_CLEARANCE_M[VegetationKind.conifer]!) continue;
      const h = hAt(x, z);
      if (blocked(x, z, h, 3)) continue;
      const ny = normalY(x, z);
      if (ny < VEG_MIN_TREE_NY) continue;
      splatAt(x, z);
      if (sRock >= 0.5) continue;
      const south = southness();
      const steep = 1 - ny;
      const alt = h - base;

      // --- biome weights ---
      const mtn = range ? range.mask(x, z) : 0;
      const hil = hills ? hills.mask(x, z) : 0;
      const stand = nStand(x * 0.0045, z * 0.0045) * 0.7 + nStand(x * 0.017 + 31, z * 0.017) * 0.3;
      const det = nDetail(x * 0.06, z * 0.06);
      // Conifer forest: mountains / downs in stands; shady slopes denser; tree line.
      const mtnLike = Math.max(mtn, sstep(22, 42, alt) * 0.8);
      let conifer = mtnLike * sstep(-0.5, -0.12, stand + 0.12 * det) * (0.8 + 0.2 * (0.5 - 0.5 * south));
      conifer *= 1 - sstep(TREE_LINE_START, TREE_LINE_END, alt + 10 * det);
      // Mixed lower flank: broadleaf share falls with altitude.
      const lowFlank = mtnLike * (1 - sstep(28, 60, alt));
      // Broadleaf: groves on the plains / hills, creases toward the lake, lone trees.
      const grove = nGrove(x * 0.0085, z * 0.0085) * 0.75 + nGrove(x * 0.03 + 7, z * 0.03) * 0.25;
      const cr = crease(x, z, h);
      let lakeNear = 0;
      for (const l of lakes) lakeNear = Math.max(lakeNear, 1 - sstep(10, 170, l.outside(x, z)));
      const open = (1 - mtnLike) * (1 - 0.5 * hil);
      let broad = open * (sstep(0.12, 0.42, grove) * 0.9 + 0.012);
      broad += (1 - mtnLike) * hil * sstep(0.05, 0.45, grove + 0.25 * stand) * 0.7;
      broad += (1 - mtnLike * 0.7) * sstep(0.25, 1.4, cr) * (0.25 + 0.5 * lakeNear) * sstep(-0.25, 0.4, grove + 0.3);
      broad += lowFlank * 0.45 * sstep(-0.2, 0.3, stand);
      broad *= 1 - sstep(TREE_LINE_START - 30, TREE_LINE_START + 10, alt);
      // Trees thin on steep ground, worn earth and gravel; never on rock.
      const soil = (1 - sRock * 1.6) * (1 - 0.4 * sGravel) * (1 - 0.25 * sDirt) * (1 - 1.2 * steep);
      let p = (conifer + broad) * (soil < 0 ? 0 : soil);
      // Clearings: summit lookout view, highway corridor, roadside thinning.
      if (lookout) {
        const dx = x - lookX;
        const dz = z - lookZ;
        const dl = Math.sqrt(dx * dx + dz * dz);
        const southward = dz > 0 ? 1 : 0.4;
        p *= 1 - (1 - sstep(LOOKOUT_CLEAR_M, LOOKOUT_CLEAR_M + LOOKOUT_FADE_M, dl)) * southward;
      }
      const hw = roadIdx.hw;
      p *= 0.25 + 0.75 * sstep(8, HIGHWAY_CORRIDOR_M, hw);
      p *= 0.55 + 0.45 * sstep(VEG_ROAD_CLEARANCE_M[0]! + 2, VEG_COLLIDER_REACH_M, rd);
      if (!(u < p)) continue;
      // Species.
      const mixN = nMix(x * 0.02, z * 0.02);
      const cw = conifer * (1.15 + 0.5 * mixN);
      const kind = u2 * (cw + broad) < cw ? VegetationKind.conifer : VegetationKind.broadleaf;
      if (rd < VEG_ROAD_CLEARANCE_M[kind]!) continue;
      if (treeHash.near(x, z, VEG_TREE_MIN_SPACING_M)) continue;
      const collide = inReach(x, z, rd);
      if (collide && (colliders.length >= VEG_MAX_COLLIDERS || colliderHash.near(x, z, COLLIDER_GAP))) continue;
      // Variant + size.
      let variant: number;
      let scale: number;
      if (kind === VegetationKind.conifer) {
        // Pines on sunny, high or rocky ground; firs in shady stands; spruce elsewhere.
        const pine = 0.15 + 0.5 * sstep(70, 120, alt) + 0.35 * sstep(0, 0.8, south) * sstep(0, 0.3, sRock + steep) + 0.25 * mixN;
        const fir = 0.3 + 0.4 * sstep(0, 0.8, -south) * sstep(-0.1, 0.4, stand);
        const t = 1 + (pine > 0 ? pine : 0) + fir;
        variant = u3 * t < pine ? VegVariant.pine : u3 * t < pine + fir ? VegVariant.fir : VegVariant.spruce;
        scale = 0.74 + 0.52 * u4 - 0.3 * sstep(TREE_LINE_START - 35, TREE_LINE_END, alt);
      } else {
        // Birches by water / in creases, oaks as lone trees in the open, beech in groves.
        const birch = 0.1 + 0.6 * lakeNear + 0.4 * sstep(0.4, 1.6, cr) + 0.2 * lowFlank;
        const oak = 0.2 + 0.8 * (1 - sstep(0.25, 0.55, grove)) * open;
        const t = 1 + birch + oak;
        variant = u3 * t < birch ? VegVariant.birch : u3 * t < birch + oak ? VegVariant.oak : VegVariant.beech;
        const lone = 1 - sstep(0.2, 0.5, grove);
        scale = 0.74 + 0.42 * u4 + 0.25 * lone * open;
      }
      if (scale < 0.6) scale = 0.6;
      const i = out.push(kind, x, h, z, scale, yawOf(u4 * 5.17 + u3), variant, rank);
      treeHash.add(x, z);
      if (collide) addCollider(i, kind, x, z, scale, h);
    }
  }

  lastScatterTimings.trees = performance.now() - tStart;
  // ================================================================ boulders
  const nb = Math.floor(size / BOULDER_CELL);
  for (let gr = 0; gr < nb; gr++) {
    for (let gc = 0; gc < nb; gc++) {
      const x = originX + (gc + rBoulder.float()) * BOULDER_CELL;
      const z = originZ + (gr + rBoulder.float()) * BOULDER_CELL;
      const u = rBoulder.float();
      const u2 = rBoulder.float();
      const u3 = rBoulder.float();
      const rank = rBoulder.float();
      if (out.n >= VEG_MAX_INSTANCES) continue;
      roadIdx.query(x, z);
      const rd = roadIdx.d;
      if (rd < VEG_ROAD_CLEARANCE_M[VegetationKind.boulder]!) continue;
      const h = hAt(x, z);
      if (blocked(x, z, h, 2)) continue;
      const ny = normalY(x, z);
      if (ny < 0.55) continue;
      splatAt(x, z);
      const rock = sRock;
      const grav = sGravel;
      const near = rockNear(x, z);
      // Outcrop margins and scree under rock faces; a few erratics in the open.
      const p = sstep(0.06, 0.4, near) * (0.55 - 0.35 * sstep(0.7, 1, rock)) + sstep(0.15, 0.6, grav) * 0.08 * (1.3 - ny) + 0.004;
      if (!(u < p)) continue;
      if (treeHash.near(x, z, 3)) continue;
      const collide = inReach(x, z, rd);
      if (collide && (colliders.length >= VEG_MAX_COLLIDERS || colliderHash.near(x, z, COLLIDER_GAP))) continue;
      const scale = 0.55 + 0.9 * u2 * u2 + 0.25 * near;
      const i = out.push(VegetationKind.boulder, x, h, z, scale, u3 * TWO_PI, Math.floor(u3 * 997) % VEG_VARIANTS[4]!, rank);
      treeHash.add(x, z);
      if (collide) addCollider(i, VegetationKind.boulder, x, z, scale, h);
    }
  }

  lastScatterTimings.boulders = performance.now() - tStart;
  // ================================================================ shrubs
  const ns = Math.floor(size / SHRUB_CELL);
  for (let gr = 0; gr < ns; gr++) {
    for (let gc = 0; gc < ns; gc++) {
      const x = originX + (gc + rShrub.float()) * SHRUB_CELL;
      const z = originZ + (gr + rShrub.float()) * SHRUB_CELL;
      const u = rShrub.float();
      const u2 = rShrub.float();
      const u3 = rShrub.float();
      const rank = rShrub.float();
      if (out.n >= VEG_MAX_INSTANCES) continue;
      roadIdx.query(x, z);
      const rd = roadIdx.d;
      if (rd < VEG_ROAD_CLEARANCE_M[VegetationKind.shrub]!) continue;
      const h = hAt(x, z);
      if (blocked(x, z, h, 2)) continue;
      const ny = normalY(x, z);
      if (ny < VEG_MIN_TREE_NY) continue;
      splatAt(x, z);
      if (sRock >= 0.5) continue;
      const alt = h - base;
      const south = southness();
      const slope = Math.sqrt(GX * GX + GZ * GZ);
      let shore = 0;
      for (const l of lakes) {
        const o = l.outside(x, z);
        shore = Math.max(shore, (1 - sstep(6, 30, o)) * (1 - sstep(water + 1.8, water + 3.6, h)));
      }
      const tn = treeHash.near(x, z, 4) ? 1 : 0;
      const sc = nScrub(x * 0.013, z * 0.013);
      const mtn = range ? range.mask(x, z) : 0;
      // Dry scrub on sunny slopes; bushes at forest edges; ferns in the understory; reeds at the shore.
      const dry = sstep(0.05, 0.6, south) * sstep(0.06, 0.3, slope) * (1 - sstep(115, 140, alt)) * sstep(-0.3, 0.3, sc) * 0.35;
      const edge = tn * 0.2 * sstep(-0.4, 0.2, sc);
      const fern = tn * mtn * 0.22 * (0.75 - 0.25 * south);
      const open = 0.012 + 0.035 * sstep(0.2, 0.7, sc);
      const reeds = shore * sstep(-0.5, 0.2, sc + 0.2) * 0.9;
      const soil = (1 - sRock * 1.8) * (1 - 0.6 * sPaved);
      const tot = dry + edge + fern + open + reeds;
      const p = 1.3 * tot * (soil < 0 ? 0 : soil);
      if (!(u < p)) continue;
      if (treeHash.near(x, z, SHRUB_TREE_GAP) || shrubHash.near(x, z, SHRUB_GAP)) continue;
      const pick = u2 * tot;
      const variant =
        pick < reeds ? VegVariant.reeds : pick < reeds + fern ? VegVariant.fern : pick < reeds + fern + dry ? VegVariant.scrub : VegVariant.bush;
      const scale = 0.65 + 0.7 * u3;
      out.push(VegetationKind.shrub, x, h, z, scale, yawOf(u3 * 7.31 + u2), variant, rank);
      shrubHash.add(x, z);
    }
  }

  lastScatterTimings.shrubs = performance.now() - tStart;
  // ================================================================ rocks
  const nr = Math.floor(size / ROCK_CELL);
  for (let gr = 0; gr < nr; gr++) {
    for (let gc = 0; gc < nr; gc++) {
      const x = originX + (gc + rRock.float()) * ROCK_CELL;
      const z = originZ + (gr + rRock.float()) * ROCK_CELL;
      const u = rRock.float();
      const u2 = rRock.float();
      const u3 = rRock.float();
      const rank = rRock.float();
      if (out.n >= VEG_MAX_INSTANCES) continue;
      roadIdx.query(x, z);
      const rd = roadIdx.d;
      if (rd < VEG_ROAD_CLEARANCE_M[VegetationKind.rock]!) continue;
      const h = hAt(x, z);
      if (blocked(x, z, h, 1)) continue;
      const ny = normalY(x, z);
      if (ny < 0.5) continue;
      splatAt(x, z);
      const rock = sRock;
      const grav = sGravel;
      const near = rockNear(x, z);
      const p = sstep(0.05, 0.5, near) * 0.45 + grav * 0.12 + sstep(0.2, 0.5, 1 - ny) * 0.15 + rock * 0.1 + 0.004;
      if (!(u < p)) continue;
      if (treeHash.near(x, z, 1.5)) continue;
      const scale = 0.45 + 0.8 * u2 * u2 * u2 + 0.35 * near;
      out.push(VegetationKind.rock, x, h, z, scale, u3 * TWO_PI, Math.floor(u3 * 1013) % VEG_VARIANTS[3]!, rank);
    }
  }

  lastScatterTimings.rocks = performance.now() - tStart;
  // ================================================================ plantings (layout v6)
  // Street / yard trees from the world content: always drawn (rank 0), the usual collider rule.
  const pr = rng.fork(14);
  for (const pl of extra?.plantings ?? []) {
    if (out.n >= VEG_MAX_INSTANCES) break;
    const h = hAt(pl.x, pl.z);
    const kind = pl.kind;
    const u = pr.float();
    const variant = kind === VegetationKind.broadleaf ? (u < 0.45 ? VegVariant.oak : u < 0.75 ? VegVariant.beech : VegVariant.birch) : kind === VegetationKind.conifer ? (u < 0.5 ? VegVariant.spruce : VegVariant.fir) : Math.floor(u * VEG_VARIANTS[kind]!);
    const i = out.push(kind, pl.x, h, pl.z, pl.scale, yawOf(pr.float()), variant, 0);
    roadIdx.query(pl.x, pl.z);
    if ((kind === VegetationKind.conifer || kind === VegetationKind.broadleaf) && colliders.length < VEG_MAX_COLLIDERS && inReach(pl.x, pl.z, roadIdx.d)) {
      addCollider(i, kind, pl.x, pl.z, pl.scale, h);
    }
  }
  const n = out.n;
  const s: VegetationScatter = {
    count: n,
    kind: out.kind.slice(0, n),
    x: out.x.slice(0, n),
    y: out.y.slice(0, n),
    z: out.z.slice(0, n),
    scale: out.scale.slice(0, n),
    yaw: out.yaw.slice(0, n),
    variant: out.variant.slice(0, n),
    rank: out.rank.slice(0, n),
    collider: out.collider.slice(0, n),
    colliders,
    hash: 0,
  };
  s.hash = hashVegetation(s);
  return s;
};
