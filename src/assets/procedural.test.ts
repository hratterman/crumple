import { describe, expect, it } from 'vitest';

import { TERRAIN_SLUGS, assetUrl } from './manifest';
import type { TerrainSlug } from './manifest';
import { makeFallbackMaps, makeFallbackSkyEquirect } from './procedural';
import type { RgbaImage } from './procedural';

const SIZE = 64;
const SEED = 7;

function meanRgb(img: RgbaImage): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    r += img.data[i * 4]!;
    g += img.data[i * 4 + 1]!;
    b += img.data[i * 4 + 2]!;
  }
  return [r / n, g / n, b / n];
}

function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// no @types/node in this project, so compare bytes without Buffer
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('makeFallbackMaps', () => {
  it('is deterministic: same (slug, size, seed) gives identical bytes', () => {
    const a = makeFallbackMaps('asphalt', SIZE, SEED);
    const b = makeFallbackMaps('asphalt', SIZE, SEED);
    expect(bytesEqual(a.color.data, b.color.data)).toBe(true);
    expect(bytesEqual(a.normal.data, b.normal.data)).toBe(true);
    expect(bytesEqual(a.rough.data, b.rough.data)).toBe(true);
  });

  it('changes with the seed', () => {
    const a = makeFallbackMaps('grass', SIZE, 1);
    const b = makeFallbackMaps('grass', SIZE, 2);
    expect(bytesEqual(a.color.data, b.color.data)).toBe(false);
  });

  it.each(TERRAIN_SLUGS.map((s) => [s] as const))('%s: RGBA sizes and opaque alpha', (slug) => {
    const maps = makeFallbackMaps(slug, SIZE, SEED);
    for (const img of [maps.color, maps.normal, maps.rough]) {
      expect(img.width).toBe(SIZE);
      expect(img.height).toBe(SIZE);
      expect(img.data.length).toBe(SIZE * SIZE * 4);
      for (let i = 3; i < img.data.length; i += 4 * 37) {
        // stride-sample alpha
        expect(img.data[i]).toBe(255);
      }
    }
  });

  it.each(TERRAIN_SLUGS.map((s) => [s] as const))(
    '%s: normals decode to roughly unit length, Z+ up',
    (slug) => {
      const { normal } = makeFallbackMaps(slug, SIZE, SEED);
      const n = normal.width * normal.height;
      for (let i = 0; i < n; i += 13) {
        const o = i * 4;
        const x = (normal.data[o]! - 127) / 127;
        const y = (normal.data[o + 1]! - 127) / 127;
        const z = (normal.data[o + 2]! - 127) / 127;
        const len = Math.sqrt(x * x + y * y + z * z);
        expect(len).toBeGreaterThan(0.9);
        expect(len).toBeLessThan(1.1);
        expect(z).toBeGreaterThan(0);
      }
    },
  );

  it('gives each slug a distinct mean color', () => {
    const means = new Map<TerrainSlug, [number, number, number]>();
    for (const slug of TERRAIN_SLUGS) {
      means.set(slug, meanRgb(makeFallbackMaps(slug, SIZE, SEED).color));
    }
    for (let i = 0; i < TERRAIN_SLUGS.length; i++) {
      for (let j = i + 1; j < TERRAIN_SLUGS.length; j++) {
        const a = TERRAIN_SLUGS[i]!;
        const b = TERRAIN_SLUGS[j]!;
        const d = rgbDistance(means.get(a)!, means.get(b)!);
        expect(d, `${a} vs ${b} mean-color distance`).toBeGreaterThan(20);
      }
    }
    // hue sanity: grass reads green, dirt reads warm brown, asphalt reads dark
    const grass = means.get('grass')!;
    expect(grass[1]).toBeGreaterThan(grass[0]);
    expect(grass[0]).toBeGreaterThan(grass[2]);
    const dirt = means.get('dirt')!;
    expect(dirt[0]).toBeGreaterThan(dirt[1]);
    expect(dirt[1]).toBeGreaterThan(dirt[2]);
    const asphalt = means.get('asphalt')!;
    expect((asphalt[0] + asphalt[1] + asphalt[2]) / 3).toBeLessThan(80);
  });

  it('produces plausible per-material roughness', () => {
    const mean = (slug: TerrainSlug): number => {
      const { rough } = makeFallbackMaps(slug, SIZE, SEED);
      let sum = 0;
      const n = rough.width * rough.height;
      for (let i = 0; i < n; i++) sum += rough.data[i * 4]!;
      return sum / n / 255;
    };
    for (const slug of TERRAIN_SLUGS) {
      const m = mean(slug);
      expect(m, `${slug} mean roughness`).toBeGreaterThan(0.5);
      expect(m, `${slug} mean roughness`).toBeLessThan(1);
    }
    // dirt is the most matte of the set; rock the most polished
    expect(mean('dirt')).toBeGreaterThan(mean('rock'));
  });
});

describe('makeFallbackSkyEquirect', () => {
  it('is a deterministic 2:1 opaque equirect', () => {
    const a = makeFallbackSkyEquirect(128);
    const b = makeFallbackSkyEquirect(128);
    expect(a.width).toBe(128);
    expect(a.height).toBe(64);
    expect(a.data.length).toBe(128 * 64 * 4);
    expect(bytesEqual(a.data, b.data)).toBe(true);
    for (let i = 3; i < a.data.length; i += 4 * 41) expect(a.data[i]).toBe(255);
  });

  it('has a bright sun disk and a golden-hour gradient', () => {
    const sky = makeFallbackSkyEquirect(256);
    let maxLum = 0;
    for (let i = 0; i < sky.width * sky.height; i++) {
      const o = i * 4;
      const lum = (sky.data[o]! + sky.data[o + 1]! + sky.data[o + 2]!) / 3;
      if (lum > maxLum) maxLum = lum;
    }
    expect(maxLum).toBeGreaterThan(240);

    // zenith (top row) is bluer and dimmer in red than the horizon row
    const rowMean = (y: number): [number, number, number] => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let x = 0; x < sky.width; x++) {
        const o = (y * sky.width + x) * 4;
        r += sky.data[o]!;
        g += sky.data[o + 1]!;
        b += sky.data[o + 2]!;
      }
      return [r / sky.width, g / sky.width, b / sky.width];
    };
    const top = rowMean(0);
    const horizon = rowMean(Math.floor(sky.height / 2) - 1);
    expect(top[2]).toBeGreaterThan(top[0]); // zenith: blue over red
    expect(horizon[0]).toBeGreaterThan(top[0]); // horizon much warmer
    expect(horizon[0]).toBeGreaterThan(horizon[2]);
  });
});

describe('assetUrl', () => {
  it('joins base and relative path without double slashes', () => {
    // vitest provides import.meta.env with BASE_URL '/'
    expect(assetUrl('assets/hdri/kiara_1_dawn_2k.hdr')).toBe('/assets/hdri/kiara_1_dawn_2k.hdr');
    expect(assetUrl('/assets/textures/grass/color.jpg')).toBe('/assets/textures/grass/color.jpg');
  });
});
