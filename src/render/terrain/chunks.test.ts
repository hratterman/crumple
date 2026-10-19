import { describe, expect, it } from 'vitest';

import { TERRAIN_CHUNK_CELLS } from '../../world/types';
import type { TerrainData } from '../../world/types';
import { buildChunkLod, chunkHeightRange, lodCells, lodIndex, lodTriangles, TERRAIN_LOD_COUNT } from './chunks';

function synthetic(chunks = 2): TerrainData {
  const cols = chunks * TERRAIN_CHUNK_CELLS + 1;
  const heights = new Float32Array(cols * cols);
  for (let r = 0; r < cols; r++)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = 10 + 8 * Math.sin(c * 0.13) * Math.cos(r * 0.07) + ((c * 7 + r * 13) % 5) * 0.3;
  return {
    layoutId: 't', layoutVersion: 1, seed: 1, originX: -64, originZ: -64, spacing: 1, cols, rows: cols,
    heights, splat: new Uint8Array(cols * cols * 4), material: new Uint8Array(cols * cols),
    minHeight: 0, maxHeight: 30, waterLevel: 0, roads: [], spawns: [], hash: 0,
  };
}

/** Height of a triangulated LOD surface (diagonal (i,j)→(i+1,j+1)) at grid point (gx, gz) in fine samples. */
function surfaceAt(pos: Float32Array, n: number, step: number, gx: number, gz: number): number {
  const v = n + 1;
  const fx = gx / step;
  const fz = gz / step;
  const i = Math.min(Math.floor(fx), n - 1);
  const j = Math.min(Math.floor(fz), n - 1);
  const tx = fx - i;
  const tz = fz - j;
  const y = (a: number, b: number): number => pos[((j + b) * v + (i + a)) * 3 + 1]!;
  // Lower triangle (a, d, b) where tx ≥ tz; upper (a, c, d) otherwise.
  if (tx >= tz) return y(0, 0) + (y(1, 0) - y(0, 0)) * (tx - tz) + (y(1, 1) - y(0, 0)) * tz;
  return y(0, 0) + (y(0, 1) - y(0, 0)) * (tz - tx) + (y(1, 1) - y(0, 0)) * tx;
}

describe('terrain chunks', () => {
  const t = synthetic();

  it('sizes and shared index buffers match the LOD topology', () => {
    for (let k = 0; k < TERRAIN_LOD_COUNT; k++) {
      const n = lodCells(k);
      const d = buildChunkLod(t, 1, 0, k);
      expect(d.positions.length).toBe(((n + 1) ** 2 + 4 * n) * 3);
      expect(d.morph.length).toBe(((n + 1) ** 2 + 4 * n) * 2);
      const idx = lodIndex(k);
      expect(idx.count).toBe(lodTriangles(k) * 3);
      expect(lodIndex(k)).toBe(idx);
      for (let i = 0; i < idx.count; i++) expect(idx.getX(i)).toBeLessThan((n + 1) ** 2 + 4 * n);
    }
  });

  it('vertex heights are the exact samples', () => {
    const d = buildChunkLod(t, 1, 1, 0);
    const c0 = 64;
    const r0 = 64;
    for (const [i, j] of [[0, 0], [5, 7], [64, 64], [33, 2]] as const) {
      const p = (j * 65 + i) * 3;
      expect(d.positions[p + 1]).toBe(t.heights[(r0 + j) * t.cols + c0 + i]);
      expect(d.positions[p]).toBe(t.originX + c0 + i);
      expect(d.positions[p + 2]).toBe(t.originZ + r0 + j);
    }
  });

  it('fully morphed LOD k is geometrically identical to LOD k+1 (no pop, watertight borders)', () => {
    for (let k = 0; k < TERRAIN_LOD_COUNT - 1; k++) {
      const fine = buildChunkLod(t, 1, 0, k);
      const coarse = buildChunkLod(t, 1, 0, k + 1);
      const n = lodCells(k);
      const step = 1 << k;
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const m = fine.morph[(j * (n + 1) + i) * 2]!;
          const want = surfaceAt(coarse.positions, lodCells(k + 1), 2 * step, i * step, j * step);
          expect(Math.abs(m - want)).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('coarsest LOD does not morph and every vertex carries its LOD id', () => {
    const k = TERRAIN_LOD_COUNT - 1;
    const d = buildChunkLod(t, 0, 0, k);
    const n = lodCells(k);
    for (let i = 0; i < (n + 1) ** 2; i++) {
      expect(d.morph[i * 2]).toBe(d.positions[i * 3 + 1]);
      expect(d.morph[i * 2 + 1]).toBe(k);
    }
  });

  it('skirts hang at least TERRAIN_SKIRT_M below the border and face outward', () => {
    const k = 1;
    const d = buildChunkLod(t, 0, 1, k);
    const n = lodCells(k);
    const v = n + 1;
    expect(d.skirtDepth).toBeGreaterThanOrEqual(2);
    const idx = lodIndex(k);
    const P = d.positions;
    const cx = t.originX + 32;
    const cz = t.originZ + 64 + 32;
    for (let tri = 2 * n * n; tri < lodTriangles(k); tri++) {
      const a = idx.getX(tri * 3);
      const b = idx.getX(tri * 3 + 1);
      const c = idx.getX(tri * 3 + 2);
      const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
      const e1 = [P[b * 3]! - ax, P[b * 3 + 1]! - ay, P[b * 3 + 2]! - az];
      const e2 = [P[c * 3]! - ax, P[c * 3 + 1]! - ay, P[c * 3 + 2]! - az];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const mx = (ax + P[b * 3]! + P[c * 3]!) / 3 - cx;
      const mz = (az + P[b * 3 + 2]! + P[c * 3 + 2]!) / 3 - cz;
      expect(nx * mx + nz * mz).toBeGreaterThan(0);
    }
    for (let s = 0; s < 4 * n; s++) expect(d.positions[(v * v + s) * 3 + 1]).toBeLessThan(40);
  });

  it('grid triangles face +Y', () => {
    const idx = lodIndex(2);
    const d = buildChunkLod(synthetic(1), 0, 0, 2);
    const P = d.positions;
    for (let tri = 0; tri < 2 * lodCells(2) ** 2; tri++) {
      const [a, b, c] = [idx.getX(tri * 3), idx.getX(tri * 3 + 1), idx.getX(tri * 3 + 2)];
      const e1x = P[b * 3]! - P[a * 3]!, e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const e2x = P[c * 3]! - P[a * 3]!, e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
      expect(e1z * e2x - e1x * e2z).toBeGreaterThan(0);
    }
  });

  it('height range covers every sample of the chunk', () => {
    const [lo, hi] = chunkHeightRange(t, 1, 1);
    for (let j = 64; j <= 128; j++)
      for (let i = 64; i <= 128; i++) {
        const h = t.heights[j * t.cols + i]!;
        expect(h).toBeGreaterThanOrEqual(lo);
        expect(h).toBeLessThanOrEqual(hi);
      }
  });

  it('LOD 0 builds fast enough to stream under the frame budget', () => {
    for (let i = 0; i < 20; i++) buildChunkLod(t, i & 1, (i >> 1) & 1, 0);
    const t0 = performance.now();
    const N = 40;
    for (let i = 0; i < N; i++) buildChunkLod(t, i & 1, (i >> 1) & 1, 0);
    const ms = (performance.now() - t0) / N;
    expect(ms).toBeLessThan(4);
  });
});
