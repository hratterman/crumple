/**
 * Test-only helpers: synthetic TerrainData from a height function (no
 * generator involved), for sampler and heightfield-collision tests.
 * Not imported by runtime code.
 */
import type { TerrainData } from './types';

export interface SyntheticTerrainOptions {
  cols: number;
  rows: number;
  spacing?: number;
  originX?: number;
  originZ?: number;
  /** World height at (x, z); stored as f32. */
  height: (x: number, z: number) => number;
  /** MaterialId per sample (default 0 = asphalt). */
  material?: (x: number, z: number, col: number, row: number) => number;
  /** 4 splat bytes per sample (default all zero = grass). */
  splat?: (col: number, row: number, out: Uint8Array) => void;
}

export function syntheticTerrain(o: SyntheticTerrainOptions): TerrainData {
  const spacing = o.spacing ?? 1;
  const originX = o.originX ?? (-(o.cols - 1) * spacing) / 2;
  const originZ = o.originZ ?? (-(o.rows - 1) * spacing) / 2;
  const n = o.cols * o.rows;
  const heights = new Float32Array(n);
  const material = new Uint8Array(n);
  const splat = new Uint8Array(n * 4);
  const px = new Uint8Array(4);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const x = originX + c * spacing;
      const z = originZ + r * spacing;
      const i = r * o.cols + c;
      const h = Math.fround(o.height(x, z));
      heights[i] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
      material[i] = o.material ? o.material(x, z, c, r) : 0;
      if (o.splat) {
        px.fill(0);
        o.splat(c, r, px);
        splat.set(px, i * 4);
      }
    }
  }
  return {
    layoutId: 'synthetic',
    layoutVersion: 1,
    seed: 0,
    originX,
    originZ,
    spacing,
    cols: o.cols,
    rows: o.rows,
    heights,
    splat,
    material,
    minHeight,
    maxHeight,
    waterLevel: -1e9,
    roads: [],
    spawns: [],
    hash: 0,
  };
}
