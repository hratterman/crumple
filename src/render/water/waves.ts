/**
 * Procedural, tileable water textures generated at load (no assets).
 *
 * WAVE SLOPE TEXTURE (RGBA8): two independent wind-aligned wave spectra,
 * RG = slope (∂h/∂x, ∂h/∂z) of spectrum A, BA = spectrum B, encoded
 * `slope / scale · 0.5 + 0.5` (the returned scales undo it). Each spectrum
 * is a sum of sharpened sinusoids ("Gerstner-ish": crests narrower than
 * troughs, h = a·(2·((1 + sin θ)/2)^p − 1)) whose wave vectors are INTEGER
 * multiples of the tile's fundamental, so the tile wraps exactly; directions
 * cluster around the wind (spread widens for short waves), steepness is
 * constant across wavelengths. The phase index (m·p mod N) is an integer,
 * so every wave is one table lookup per texel.
 *
 * NOISE TEXTURE (R8): smooth tileable fbm-like noise (integer-frequency
 * sinusoid sum), used for wind gust patches ("cat's paws") and foam breakup.
 */
import { createRng } from '../../core/rng';

export interface WaveTextureData {
  size: number;
  /** RGBA8, size² texels. */
  data: Uint8Array;
  /** Slope = (texel·2 − 1) · scale, per spectrum (A in RG, B in BA). */
  scaleA: number;
  scaleB: number;
}

export interface WaveSpectrumParams {
  /** Wind heading in the tile (radians, atan2(z, x) convention: 0 = +X). */
  windAngle: number;
  /** Number of component waves. */
  count: number;
  /** Wavenumber range in tile fundamentals (|m| from min to max, log-spaced). */
  minFreq: number;
  maxFreq: number;
  /** Max slope of one component (a·k). */
  steepness: number;
  /** Std-dev of the direction spread around the wind at the longest wave, rad. */
  spread: number;
  /** Crest sharpening exponent p (1 = plain sine). */
  sharpness: number;
}

export const WAVE_SPECTRUM_A: WaveSpectrumParams = {
  windAngle: 0,
  count: 40,
  minFreq: 2,
  maxFreq: 34,
  steepness: 0.11,
  spread: 0.45,
  sharpness: 1.7,
};
export const WAVE_SPECTRUM_B: WaveSpectrumParams = {
  windAngle: 0,
  count: 40,
  minFreq: 3,
  maxFreq: 48,
  steepness: 0.1,
  spread: 0.7,
  sharpness: 1.4,
};

/** Slopes of one spectrum into sx/sz (size², row-major, z = row). */
function spectrumSlopes(size: number, p: WaveSpectrumParams, seed: number, sx: Float32Array, sz: Float32Array): void {
  const rng = createRng(seed);
  const sinT = new Float32Array(size);
  const cosT = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    sinT[i] = Math.sin((2 * Math.PI * i) / size);
    cosT[i] = Math.cos((2 * Math.PI * i) / size);
  }
  // Per-phase-index slope factor of the sharpened profile: dh/dθ = a·p·((1+s)/2)^(p−1)·cos θ.
  const prof = new Float32Array(size);
  for (let i = 0; i < size; i++) prof[i] = p.sharpness * Math.pow((1 + sinT[i]!) / 2, p.sharpness - 1) * cosT[i]!;
  const used = new Set<string>();
  const ratio = Math.pow(p.maxFreq / p.minFreq, 1 / Math.max(1, p.count - 1));
  for (let w = 0; w < p.count; w++) {
    const f = p.minFreq * Math.pow(ratio, w) * (0.9 + 0.2 * rng.float());
    // Short waves spread wider (they respond to local gusts); a few run against the wind.
    const spread = p.spread * (1 + 0.8 * (w / p.count));
    const g = (rng.float() + rng.float() + rng.float() - 1.5) * 2 * spread;
    const ang = p.windAngle + g;
    let mx = Math.round(f * Math.cos(ang));
    let mz = Math.round(f * Math.sin(ang));
    if (mx === 0 && mz === 0) mx = 1;
    let key = `${mx},${mz}`;
    let guard = 0;
    while (used.has(key) && guard++ < 8) {
      mx += rng.float() < 0.5 ? 1 : -1;
      key = `${mx},${mz}`;
    }
    used.add(key);
    const k = Math.sqrt(mx * mx + mz * mz); // in tile fundamentals
    // Constant steepness a·k → slope amplitude independent of wavelength; a little jitter.
    const amp = p.steepness * (0.6 + 0.8 * rng.float());
    const phase = Math.floor(rng.float() * size);
    const mxm = ((mx % size) + size) % size;
    const mzm = ((mz % size) + size) % size;
    const ux = mx / k;
    const uz = mz / k;
    for (let r = 0; r < size; r++) {
      let idx = (mzm * r + phase) % size;
      const row = r * size;
      for (let c = 0; c < size; c++) {
        const d = amp * prof[idx]!;
        sx[row + c] = sx[row + c]! + d * ux;
        sz[row + c] = sz[row + c]! + d * uz;
        idx += mxm;
        if (idx >= size) idx -= size;
      }
    }
  }
}

function encode(sx: Float32Array, sz: Float32Array, out: Uint8Array, offset: number): number {
  let m = 1e-6;
  for (let i = 0; i < sx.length; i++) m = Math.max(m, Math.abs(sx[i]!), Math.abs(sz[i]!));
  const scale = m * 1.02;
  for (let i = 0; i < sx.length; i++) {
    out[i * 4 + offset] = Math.round((sx[i]! / scale) * 127.5 + 127.5);
    out[i * 4 + offset + 1] = Math.round((sz[i]! / scale) * 127.5 + 127.5);
  }
  return scale;
}

/** Two-spectrum wave slope texture (see file header). size must be a power of two. */
export function buildWaveTexture(
  size = 256,
  seed = 0x5eed_a7e2,
  a: WaveSpectrumParams = WAVE_SPECTRUM_A,
  b: WaveSpectrumParams = WAVE_SPECTRUM_B,
): WaveTextureData {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const sx = new Float32Array(n);
  const sz = new Float32Array(n);
  spectrumSlopes(size, a, seed, sx, sz);
  const scaleA = encode(sx, sz, data, 0);
  sx.fill(0);
  sz.fill(0);
  spectrumSlopes(size, b, seed ^ 0x9e37_79b9, sx, sz);
  const scaleB = encode(sx, sz, data, 2);
  return { size, data, scaleA, scaleB };
}

/** Tileable smooth noise in [0, 255] (R8, size²): integer-frequency sinusoid octaves, normalised. */
export function buildNoiseTexture(size = 128, seed = 0x0f0a_11ce): Uint8Array {
  const rng = createRng(seed);
  const n = size * size;
  const acc = new Float32Array(n);
  const sinT = new Float32Array(size);
  for (let i = 0; i < size; i++) sinT[i] = Math.sin((2 * Math.PI * i) / size);
  for (let octave = 0; octave < 4; octave++) {
    const base = 2 << octave; // 2, 4, 8, 16 cycles per tile
    const amp = 1 / (1 << octave);
    for (let w = 0; w < 6; w++) {
      const ang = rng.float() * 2 * Math.PI;
      const f = base * (0.8 + 0.4 * rng.float());
      const mx = Math.round(f * Math.cos(ang));
      const mz = Math.round(f * Math.sin(ang));
      if (mx === 0 && mz === 0) continue;
      const mxm = ((mx % size) + size) % size;
      const mzm = ((mz % size) + size) % size;
      const phase = Math.floor(rng.float() * size);
      for (let r = 0; r < size; r++) {
        let idx = (mzm * r + phase) % size;
        for (let c = 0; c < size; c++) {
          acc[r * size + c] = acc[r * size + c]! + amp * sinT[idx]!;
          idx += mxm;
          if (idx >= size) idx -= size;
        }
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) (lo = Math.min(lo, acc[i]!)), (hi = Math.max(hi, acc[i]!));
  const out = new Uint8Array(n);
  const inv = 255 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < n; i++) out[i] = Math.round((acc[i]! - lo) * inv);
  return out;
}
