/**
 * Tileable RGBA8 noise atlas for the ribbon shader (pure, seeded; built once
 * on the main thread, ~20 ms at 256²). Channels:
 *   R  value-noise fbm, 4 octaves, base period 4 cells (patch masks, wear)
 *   G  value-noise fbm, other seed, base period 2 cells (macro tint, tiling breakup)
 *   B  cellular F2−F1 (0 on cell borders) → crack / tar-snake / joint lines
 *   A  per-texel hash (grain; mips average it out → no shimmer)
 * Everything wraps at the texture edge so RepeatWrapping is seamless.
 */
import { createRng } from '../../core/rng';

export const ROAD_NOISE_SIZE = 256;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueFbm(size: number, basePeriod: number, octaves: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = basePeriod << o;
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.float();
    const scale = cells / size;
    for (let y = 0; y < size; y++) {
      const fy = y * scale;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      const r0 = (y0 % cells) * cells;
      const r1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const fx = x * scale;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const c0 = x0 % cells;
        const c1 = (x0 + 1) % cells;
        const a = lattice[r0 + c0]! + (lattice[r0 + c1]! - lattice[r0 + c0]!) * tx;
        const b = lattice[r1 + c0]! + (lattice[r1 + c1]! - lattice[r1 + c0]!) * tx;
        out[y * size + x] = out[y * size + x]! + (a + (b - a) * ty) * amp;
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

function cellular(size: number, cells: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const fx = new Float32Array(cells * cells);
  const fz = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    fx[i] = 0.1 + 0.8 * rng.float();
    fz[i] = 0.1 + 0.8 * rng.float();
  }
  const out = new Float32Array(size * size);
  const cs = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / cs;
      const py = (y + 0.5) / cs;
      const cx = Math.floor(px);
      const cy = Math.floor(py);
      let f1 = Infinity;
      let f2 = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const k = wy * cells + wx;
          const dx = gx + fx[k]! - px;
          const dy = gy + fz[k]! - py;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      }
      out[y * size + x] = f2 - f1;
    }
  }
  return out;
}

export function makeRoadNoise(size = ROAD_NOISE_SIZE, seed = 0x0a5f417): Uint8Array {
  const r = valueFbm(size, 4, 4, seed);
  const g = valueFbm(size, 2, 5, seed ^ 0x9e3779b9);
  const b = cellular(size, 16, seed ^ 0x51ed27);
  const rng = createRng(seed ^ 0x2545f491);
  const out = new Uint8Array(size * size * 4);
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < size * size; i++) {
    // Stretch fbm contrast (value noise clusters around 0.5).
    out[i * 4] = q(0.5 + (r[i]! - 0.5) * 1.9);
    out[i * 4 + 1] = q(0.5 + (g[i]! - 0.5) * 1.9);
    out[i * 4 + 2] = q(Math.min(1, b[i]! * 1.6));
    out[i * 4 + 3] = q(rng.float());
  }
  return out;
}
