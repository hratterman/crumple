/**
 * Deterministic noise built on simplex-noise@4 with the seeded RNG injected —
 * the same seed always yields the identical field in worker, main thread and
 * tests. Raw simplex output is in [-1, 1]; fbm helpers renormalize by total
 * amplitude so composites stay bounded.
 */

import { createNoise2D, createNoise3D } from 'simplex-noise';
import type { NoiseFunction2D, NoiseFunction3D } from 'simplex-noise';
import { createRng, type Rng } from './rng';

export type { NoiseFunction2D, NoiseFunction3D };

const toRng = (seedOrRng: number | Rng): Rng =>
  typeof seedOrRng === 'number' ? createRng(seedOrRng) : seedOrRng;

/** 2D simplex noise in [-1, 1], seeded via createRng. */
export function createSeededNoise2D(seedOrRng: number | Rng): NoiseFunction2D {
  return createNoise2D(toRng(seedOrRng).float);
}

/** 3D simplex noise in [-1, 1], seeded via createRng. */
export function createSeededNoise3D(seedOrRng: number | Rng): NoiseFunction3D {
  return createNoise3D(toRng(seedOrRng).float);
}

function amplitudeSum(octaves: number, gain: number): number {
  let amp = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp;
    amp *= gain;
  }
  return sum;
}

/**
 * Fractal Brownian motion over a 2D base noise. Output normalized to [-1, 1].
 */
export function createFbm2(
  noise: NoiseFunction2D,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): NoiseFunction2D {
  if (octaves < 1) throw new RangeError('fbm: octaves must be >= 1');
  const norm = 1 / amplitudeSum(octaves, gain);
  return (x: number, y: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq);
      amp *= gain;
      freq *= lacunarity;
    }
    return sum * norm;
  };
}

/**
 * Fractal Brownian motion over a 3D base noise. Output normalized to [-1, 1].
 */
export function createFbm3(
  noise: NoiseFunction3D,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): NoiseFunction3D {
  if (octaves < 1) throw new RangeError('fbm: octaves must be >= 1');
  const norm = 1 / amplitudeSum(octaves, gain);
  return (x: number, y: number, z: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      amp *= gain;
      freq *= lacunarity;
    }
    return sum * norm;
  };
}

/**
 * Ridged fractal (1 - |n| per octave): sharp crests for mountains/erosion.
 * Output normalized to [0, 1].
 */
export function createRidged2(
  noise: NoiseFunction2D,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): NoiseFunction2D {
  if (octaves < 1) throw new RangeError('ridged: octaves must be >= 1');
  const norm = 1 / amplitudeSum(octaves, gain);
  return (x: number, y: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      const n = noise(x * freq, y * freq);
      sum += amp * (1 - Math.abs(n));
      amp *= gain;
      freq *= lacunarity;
    }
    return sum * norm;
  };
}
