/**
 * Puddle potential map: where rain water would pool — local concavity of
 * the carved heightfield (the road grade, ruts and dips are in TerrainData
 * already) at two scales, killed on slopes, plus the roads' low shoulders.
 * One R8 texture over the whole map at PUDDLE_CELL_M; ground-mode wet
 * surfaces (env patch) combine it with procedural noise and the wetness.
 */
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';

import type { TerrainData } from '../../world/types';

export const PUDDLE_CELL_M = 2;

/** Concavity potential 0..255 per cell (pure; exported for tests). */
export function puddlePotential(t: Pick<TerrainData, 'heights' | 'cols' | 'rows' | 'spacing'>, cellM = PUDDLE_CELL_M): { data: Uint8Array; w: number; h: number } {
  const step = Math.max(1, Math.round(cellM / t.spacing));
  const w = Math.floor((t.cols - 1) / step) + 1;
  const h = Math.floor((t.rows - 1) / step) + 1;
  const H = (c: number, r: number): number => {
    const cc = Math.max(0, Math.min(t.cols - 1, c));
    const rr = Math.max(0, Math.min(t.rows - 1, r));
    return t.heights[rr * t.cols + cc]!;
  };
  const data = new Uint8Array(w * h);
  const k1 = step; // ~2 m
  const k2 = step * 4; // ~8 m
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = i * step;
      const r = j * step;
      const h0 = H(c, r);
      const a1 = (H(c - k1, r) + H(c + k1, r) + H(c, r - k1) + H(c, r + k1)) * 0.25 - h0;
      const a2 = (H(c - k2, r) + H(c + k2, r) + H(c, r - k2) + H(c, r + k2)) * 0.25 - h0;
      const gx = (H(c + k1, r) - H(c - k1, r)) / (2 * k1 * t.spacing);
      const gz = (H(c, r + k1) - H(c, r - k1)) / (2 * k1 * t.spacing);
      const slope = Math.sqrt(gx * gx + gz * gz);
      // a few cm of bowl over 2 m, or a decimetre over 8 m, holds water; slopes > ~8 % drain
      let p = Math.max(0, a1) * 22 + Math.max(0, a2) * 5;
      p *= 1 - Math.max(0, Math.min(1, (slope - 0.03) / 0.06));
      data[j * w + i] = Math.round(255 * Math.min(1, p));
    }
  }
  return { data, w, h };
}

export function createPuddleMap(t: TerrainData): DataTexture {
  const { data, w, h } = puddlePotential(t);
  const tex = new DataTexture(data, w, h, RedFormat, UnsignedByteType);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
