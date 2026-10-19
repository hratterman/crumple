/**
 * Terrain chunk geometry (B). Pure typed-array builders plus the three
 * BufferGeometry wrapper; the renderer schedules them across frames.
 *
 * Chunk (cx, cz) covers samples col ∈ [cx·64, cx·64 + 64], row likewise.
 * LOD k uses every 2^k-th sample (n = 64 >> k cells per side).
 *
 * GEOMORPH (CDLOD-style, vertical only): every vertex carries `aMorph.x`,
 * the height of the NEXT coarser LOD's surface at its (x, z). Cells are all
 * split along the same (+col, +row) diagonal, so an odd vertex lies on an
 * edge or on the diagonal of the coarse cell, and its coarse height is the
 * mean of the two even neighbours along that line. With morph = 1 the LOD k
 * mesh is therefore geometrically IDENTICAL to LOD k+1 (every fine triangle
 * lies inside one planar coarse triangle). The vertex shader morphs by the
 * per-vertex camera distance, reaching 1 before the chunk's LOD switch
 * distance, so switches never pop and borders with a one-level-coarser
 * neighbour are watertight. Bigger jumps (low preset) are hidden by skirts.
 *
 * `aMorph.y` is the LOD index (selects the morph range uniform).
 */
import { BufferAttribute, BufferGeometry, Box3, Sphere, Vector3 } from 'three';

import { TERRAIN_SKIRT_M } from '../types';
import { TERRAIN_CHUNK_CELLS } from '../../world/types';
import type { TerrainData } from '../../world/types';

export const TERRAIN_LOD_COUNT = 4;

/** Cells per side at LOD k. */
export function lodCells(lod: number): number {
  return TERRAIN_CHUNK_CELLS >> lod;
}

/** Triangles of one chunk at LOD k (grid + skirt). */
export function lodTriangles(lod: number): number {
  const n = lodCells(lod);
  return 2 * n * n + 8 * n;
}

export interface ChunkLodData {
  /** xyz per vertex: (n+1)² grid vertices then 4n skirt vertices. */
  positions: Float32Array;
  /** (coarse-surface height, lod) per vertex. */
  morph: Float32Array;
  /** Skirt depth used, m (≥ TERRAIN_SKIRT_M). */
  skirtDepth: number;
}

/** Perimeter of an n-cell grid as a closed loop of (i, j) grid indices, 4n entries, counter-clockwise seen from +Y. */
function perimeter(n: number): Int32Array {
  const out = new Int32Array(8 * n);
  let k = 0;
  const push = (i: number, j: number): void => {
    out[k++] = i;
    out[k++] = j;
  };
  for (let i = 0; i < n; i++) push(i, 0); // j = 0 edge, +i
  for (let j = 0; j < n; j++) push(n, j); // i = n edge, +j
  for (let i = n; i > 0; i--) push(i, n); // j = n edge, −i
  for (let j = n; j > 0; j--) push(0, j); // i = 0 edge, −j
  return out;
}

const indexCache = new Map<number, BufferAttribute>();

/**
 * Shared index buffer for LOD k (identical topology for every chunk, so
 * one GPU buffer serves them all). Grid cells use the (0,0)→(1,1) diagonal
 * (the geomorph relies on it); skirt quads face outward.
 */
export function lodIndex(lod: number): BufferAttribute {
  const cached = indexCache.get(lod);
  if (cached) return cached;
  const n = lodCells(lod);
  const v = n + 1;
  const tris = lodTriangles(lod);
  const idx = new Uint16Array(tris * 3);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * v + i;
      const b = a + 1;
      const c = a + v;
      const d = c + 1;
      // (a, d, b) and (a, c, d): both +Y facing (x = i, z = j).
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = b;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  const per = perimeter(n);
  const m = 4 * n;
  const skirt0 = v * v;
  for (let s = 0; s < m; s++) {
    const s1 = (s + 1) % m;
    const a = per[2 * s + 1]! * v + per[2 * s]!;
    const b = per[2 * s1 + 1]! * v + per[2 * s1]!;
    const sa = skirt0 + s;
    const sb = skirt0 + s1;
    // Loop runs CCW seen from +Y: edge a→b, outward = (dz, −dx) of the edge
    // direction. Quad (a, b, sb, sa): normal (b−a)×(sa−a) = d×(0,−1,0) =
    // (dz, 0, −dx) → outward. Triangles (a, sa, b)…: pick the outward order.
    idx[k++] = a;
    idx[k++] = b;
    idx[k++] = sa;
    idx[k++] = b;
    idx[k++] = sb;
    idx[k++] = sa;
  }
  const attr = new BufferAttribute(idx, 1);
  indexCache.set(lod, attr);
  return attr;
}

/**
 * Skirt depth for a chunk: TERRAIN_SKIRT_M plus the worst border deviation
 * between the full-resolution heights and the coarsest LOD's linear border,
 * so a neighbour at ANY LOD can never open a gap deeper than the skirt.
 */
export function chunkSkirtDepth(t: TerrainData, cx: number, cz: number): number {
  const { cols, heights: H } = t;
  const C = TERRAIN_CHUNK_CELLS;
  const c0 = cx * C;
  const r0 = cz * C;
  const cstep = 1 << (TERRAIN_LOD_COUNT - 1);
  let err = 0;
  for (let e = 0; e < 4; e++) {
    // Edge e as (start index, stride along the edge).
    const start = e === 0 ? r0 * cols + c0 : e === 1 ? r0 * cols + c0 + C : e === 2 ? (r0 + C) * cols + c0 : r0 * cols + c0;
    const stride = e === 0 || e === 2 ? 1 : cols;
    for (let k0 = 0; k0 < C; k0 += cstep) {
      const a = H[start + k0 * stride]!;
      const b = H[start + (k0 + cstep) * stride]!;
      for (let f = 1; f < cstep; f++) {
        const d = Math.abs(H[start + (k0 + f) * stride]! - (a + ((b - a) * f) / cstep));
        if (d > err) err = d;
      }
    }
  }
  return TERRAIN_SKIRT_M + err;
}

const perimeterCache = new Map<number, Int32Array>();
function cachedPerimeter(n: number): Int32Array {
  let p = perimeterCache.get(n);
  if (!p) {
    p = perimeter(n);
    perimeterCache.set(n, p);
  }
  return p;
}

/**
 * Resumable build of positions + morph targets for chunk (cx, cz) at LOD k:
 * step(rows) fills that many grid rows, then the skirt, so the renderer can
 * slice a LOD 0 build (65 rows) across frames. Pure (no three).
 */
export class ChunkBuild {
  readonly data: ChunkLodData;
  readonly lod: number;
  done = false;
  private row = 0;
  private readonly t: TerrainData;
  private readonly c0: number;
  private readonly r0: number;

  constructor(t: TerrainData, cx: number, cz: number, lod: number, skirtDepth: number) {
    const n = lodCells(lod);
    const v = n + 1;
    const verts = v * v + 4 * n;
    this.t = t;
    this.lod = lod;
    this.c0 = cx * TERRAIN_CHUNK_CELLS;
    this.r0 = cz * TERRAIN_CHUNK_CELLS;
    this.data = { positions: new Float32Array(verts * 3), morph: new Float32Array(verts * 2), skirtDepth };
  }

  /** Fill up to `rows` more grid rows (then the skirt). Returns true when complete. */
  step(rows: number): boolean {
    if (this.done) return true;
    const { t, lod, c0, r0 } = this;
    const { positions, morph, skirtDepth } = this.data;
    const n = lodCells(lod);
    const v = n + 1;
    const step = 1 << lod;
    const { cols, heights: H, spacing, originX, originZ } = t;
    const coarse = lod < TERRAIN_LOD_COUNT - 1;
    const rowStride = step * cols;
    const base0 = r0 * cols + c0;
    const jEnd = Math.min(v, this.row + rows);
    for (let j = this.row; j < jEnd; j++) {
      const z = originZ + (r0 + j * step) * spacing;
      const rowBase = base0 + j * rowStride;
      const oj = j & 1;
      let p = j * v * 3;
      let q = j * v * 2;
      for (let i = 0; i < v; i++) {
        const idx = rowBase + i * step;
        const y = H[idx]!;
        positions[p++] = originX + (c0 + i * step) * spacing;
        positions[p++] = y;
        positions[p++] = z;
        let my = y;
        if (coarse) {
          const oi = i & 1;
          if (oi && oj) my = 0.5 * (H[idx - rowStride - step]! + H[idx + rowStride + step]!);
          else if (oi) my = 0.5 * (H[idx - step]! + H[idx + step]!);
          else if (oj) my = 0.5 * (H[idx - rowStride]! + H[idx + rowStride]!);
        }
        morph[q++] = my;
        morph[q++] = lod;
      }
    }
    this.row = jEnd;
    if (jEnd < v) return false;
    const per = cachedPerimeter(n);
    let p = v * v * 3;
    let q = v * v * 2;
    for (let s = 0; s < 4 * n; s++) {
      const src = per[2 * s + 1]! * v + per[2 * s]!;
      positions[p++] = positions[src * 3]!;
      positions[p++] = positions[src * 3 + 1]! - skirtDepth;
      positions[p++] = positions[src * 3 + 2]!;
      morph[q++] = morph[src * 2]! - skirtDepth;
      morph[q++] = lod;
    }
    this.done = true;
    return true;
  }
}

/** One-shot build (tests, LOD 3 at start-up). */
export function buildChunkLod(
  t: TerrainData,
  cx: number,
  cz: number,
  lod: number,
  skirtDepth = chunkSkirtDepth(t, cx, cz),
): ChunkLodData {
  const b = new ChunkBuild(t, cx, cz, lod, skirtDepth);
  b.step(Infinity);
  return b.data;
}

/** Chunk AABB over the FULL-resolution samples (valid for every LOD), skirts excluded. */
export function chunkHeightRange(t: TerrainData, cx: number, cz: number): [min: number, max: number] {
  const { cols, heights: H } = t;
  const c0 = cx * TERRAIN_CHUNK_CELLS;
  const r0 = cz * TERRAIN_CHUNK_CELLS;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= TERRAIN_CHUNK_CELLS; j++) {
    const base = (r0 + j) * cols + c0;
    for (let i = 0; i <= TERRAIN_CHUNK_CELLS; i++) {
      const y = H[base + i]!;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  return [lo, hi];
}

const _v = new Vector3();

/** Wrap built data as a BufferGeometry sharing the LOD's index buffer. */
export function makeChunkGeometry(data: ChunkLodData, lod: number, box: Box3): BufferGeometry {
  const g = new BufferGeometry();
  g.setIndex(lodIndex(lod));
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('aMorph', new BufferAttribute(data.morph, 2));
  g.boundingBox = box.clone();
  g.boundingBox.min.y -= data.skirtDepth;
  g.boundingSphere = new Sphere(g.boundingBox.getCenter(_v).clone(), g.boundingBox.getSize(_v).length() * 0.5);
  return g;
}
