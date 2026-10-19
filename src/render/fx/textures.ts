/**
 * Procedural FX textures (no canvas: node tests build them too).
 * Puff atlas: one RGBA8 texture, each channel an independent billowy smoke
 * puff (radial falloff × warped billow fbm), zero at the border so rotated
 * UVs never show the quad's edge. Particles pick a channel per seed.
 */
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType } from 'three';

import { createSeededNoise3D } from '../../core/noise';

export const PUFF_SIZE = 128;

/** Density of puff `channel` at (u, v) ∈ [−1, 1]² — exported for tests. */
export function puffDensity(noise: (x: number, y: number, z: number) => number, u: number, v: number, channel: number): number {
  const r2 = u * u + v * v;
  if (r2 >= 1) return 0;
  const z = channel * 9.17;
  // domain warp → curly cauliflower edges
  const wx = noise(u * 1.3 + 3.1, v * 1.3, z + 1.7) * 0.35;
  const wy = noise(u * 1.3, v * 1.3 + 5.2, z - 2.3) * 0.35;
  const x = u + wx;
  const y = v + wy;
  let billow = 0;
  let amp = 0.55;
  let f = 1.6;
  for (let o = 0; o < 4; o++) {
    billow += amp * (1 - Math.abs(noise(x * f, y * f, z + o * 3.3)));
    amp *= 0.5;
    f *= 2.07;
  }
  billow /= 1.03; // ≈ 0..1
  const rr = Math.sqrt(x * x + y * y);
  const fall = Math.max(0, 1 - rr * rr);
  const edge = Math.max(0, 1 - r2); // hard zero at the quad's inscribed circle
  const d = fall * (0.35 + 0.95 * billow) - 0.12 * (1 - fall);
  return Math.min(1, Math.max(0, d * Math.min(1, edge * 3)));
}

const cache = new Map<number, Uint8Array>();
function puffData(seed: number): Uint8Array {
  let data = cache.get(seed);
  if (data) return data;
  const n = PUFF_SIZE;
  data = new Uint8Array(n * n * 4);
  const noise = createSeededNoise3D(seed);
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) / n) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      const o = (j * n + i) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.round(puffDensity(noise, u, v, c) * 255);
    }
  }
  cache.set(seed, data);
  return data;
}

/** The puff atlas (texels generated once per seed and process). */
export function createPuffTexture(seed = 0x5e0c3): DataTexture {
  const n = PUFF_SIZE;
  const data = puffData(seed);
  const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  tex.name = 'fx.puff';
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
