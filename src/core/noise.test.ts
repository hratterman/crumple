import { describe, expect, it } from 'vitest';
import {
  createFbm2,
  createFbm3,
  createRidged2,
  createSeededNoise2D,
  createSeededNoise3D,
} from './noise';
import { createRng } from './rng';

const GRID = 24;
const SCALE = 0.37;

function sample2D(fn: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      out.push(fn(i * SCALE, j * SCALE));
    }
  }
  return out;
}

function sample3D(fn: (x: number, y: number, z: number) => number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 8; k++) {
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 8; i++) {
        out.push(fn(i * SCALE, j * SCALE, k * SCALE));
      }
    }
  }
  return out;
}

describe('seeded noise', () => {
  it('same seed produces the identical 2D field', () => {
    const a = sample2D(createSeededNoise2D(1234));
    const b = sample2D(createSeededNoise2D(1234));
    expect(a).toEqual(b);
  });

  it('same seed produces the identical 3D field', () => {
    const a = sample3D(createSeededNoise3D(777));
    const b = sample3D(createSeededNoise3D(777));
    expect(a).toEqual(b);
  });

  it('different seeds produce different fields', () => {
    const a = sample2D(createSeededNoise2D(1));
    const b = sample2D(createSeededNoise2D(2));
    expect(a).not.toEqual(b);
  });

  it('accepts an injected Rng and forked streams stay independent', () => {
    const noiseA = createSeededNoise2D(createRng(50).fork(1));
    const noiseB = createSeededNoise2D(createRng(50).fork(1));
    expect(sample2D(noiseA)).toEqual(sample2D(noiseB));
    const noiseC = createSeededNoise2D(createRng(50).fork(2));
    expect(sample2D(noiseA)).not.toEqual(sample2D(noiseC));
  });

  it('raw output stays within [-1, 1] and actually varies', () => {
    const vals = sample2D(createSeededNoise2D(9));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.5);
  });
});

describe('fbm', () => {
  it('fbm2 is deterministic per seed', () => {
    const a = sample2D(createFbm2(createSeededNoise2D(42), 5, 2, 0.5));
    const b = sample2D(createFbm2(createSeededNoise2D(42), 5, 2, 0.5));
    expect(a).toEqual(b);
  });

  it('fbm2 output stays within [-1, 1] across octave settings', () => {
    for (const octaves of [1, 3, 6]) {
      const vals = sample2D(createFbm2(createSeededNoise2D(7), octaves, 2, 0.5));
      for (const v of vals) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fbm3 output stays within [-1, 1]', () => {
    const vals = sample3D(createFbm3(createSeededNoise3D(11), 4, 2, 0.5));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('single-octave fbm equals the base noise', () => {
    const base = createSeededNoise2D(31);
    const fbm = createFbm2(createSeededNoise2D(31), 1, 2, 0.5);
    expect(sample2D(fbm)).toEqual(sample2D(base));
  });

  it('more octaves add detail (fields differ)', () => {
    const one = sample2D(createFbm2(createSeededNoise2D(3), 1, 2, 0.5));
    const five = sample2D(createFbm2(createSeededNoise2D(3), 5, 2, 0.5));
    expect(one).not.toEqual(five);
  });

  it('rejects octaves < 1', () => {
    expect(() => createFbm2(createSeededNoise2D(1), 0)).toThrow(RangeError);
  });
});

describe('ridged2', () => {
  it('is deterministic per seed', () => {
    const a = sample2D(createRidged2(createSeededNoise2D(88), 4, 2, 0.5));
    const b = sample2D(createRidged2(createSeededNoise2D(88), 4, 2, 0.5));
    expect(a).toEqual(b);
  });

  it('output stays within [0, 1]', () => {
    const vals = sample2D(createRidged2(createSeededNoise2D(13), 5, 2.1, 0.55));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('produces high values at base-noise zero crossings (ridges)', () => {
    // 1 - |n| peaks where n = 0, so ridged values should reach near the top.
    const vals = sample2D(createRidged2(createSeededNoise2D(21), 1, 2, 0.5));
    expect(Math.max(...vals)).toBeGreaterThan(0.9);
  });
});
