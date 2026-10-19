import { describe, expect, it } from 'vitest';

import {
  brakeDiscImages,
  flakeNormalImage,
  grainNormalImage,
  hash3,
  heightToNormal,
  honeycombImages,
  lensNormalImage,
  orangePeelImage,
  periodicNoise,
  plateImage,
  sidewallImages,
  treadImages,
  vehicleTextures,
  type PixelImage,
} from './textures';

function decode(img: PixelImage, i: number): [number, number, number] {
  const d = img.data;
  return [(d[i * 4]! / 255) * 2 - 1, (d[i * 4 + 1]! / 255) * 2 - 1, (d[i * 4 + 2]! / 255) * 2 - 1];
}

function checkNormalMap(img: PixelImage): void {
  expect(img.data.length).toBe(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i += 97) {
    const [x, y, z] = decode(img, i);
    expect(Math.hypot(x, y, z)).toBeGreaterThan(0.97);
    expect(Math.hypot(x, y, z)).toBeLessThan(1.03);
    expect(z).toBeGreaterThan(0.3);
  }
}

/** Mean absolute difference between the first and last column vs between two adjacent interior columns. */
function seamRatio(img: PixelImage, channel = 0): number {
  const { width: w, height: h, data } = img;
  let seam = 0;
  let inner = 0;
  for (let y = 0; y < h; y++) {
    seam += Math.abs(data[(y * w) * 4 + channel]! - data[(y * w + w - 1) * 4 + channel]!);
    inner += Math.abs(data[(y * w + w / 2) * 4 + channel]! - data[(y * w + w / 2 - 1) * 4 + channel]!);
  }
  return seam / Math.max(1, inner);
}

describe('procedural primitives', () => {
  it('hash3 is deterministic and in [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = hash3(i, i * 7 - 3, 11);
      expect(v).toBe(hash3(i, i * 7 - 3, 11));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(hash3(1, 2, 3)).not.toBe(hash3(2, 1, 3));
  });

  it('periodic noise tiles with its period', () => {
    for (let k = 0; k < 50; k++) {
      const x = k * 0.37;
      const y = k * 0.91;
      expect(periodicNoise(x + 8, y, 8, 5)).toBeCloseTo(periodicNoise(x, y, 8, 5), 10);
      expect(periodicNoise(x, y - 16, 8, 5)).toBeCloseTo(periodicNoise(x, y, 8, 5), 10);
    }
  });

  it('heightToNormal: flat height gives +Z, a ramp tilts against the slope', () => {
    const flat = heightToNormal(new Float32Array(16), 4, 4, 1);
    expect(decode(flat, 5)[2]).toBeGreaterThan(0.99);
    const ramp = new Float32Array(64);
    for (let i = 0; i < 64; i++) ramp[i] = (i % 8) * 0.1;
    const n = decode(heightToNormal(ramp, 8, 8, 1, false), 8 * 3 + 3);
    expect(n[0]).toBeLessThan(-0.05);
  });
});

describe('vehicle texture generators', () => {
  it('flake map: deterministic, unit normals, flat pigment share ≈ 1 − density, tiles', () => {
    const a = flakeNormalImage(128, 4, 0.6, 0.55, 3);
    const b = flakeNormalImage(128, 4, 0.6, 0.55, 3);
    expect(a.data.every((v, i) => v === b.data[i])).toBe(true);
    checkNormalMap(a);
    let flat = 0;
    for (let i = 0; i < 128 * 128; i++) if (decode(a, i)[2] > 0.995) flat++;
    expect(flat / (128 * 128)).toBeGreaterThan(0.25);
    expect(flat / (128 * 128)).toBeLessThan(0.6);
  });

  it('orange peel, grains and lenses are valid tileable normal maps', () => {
    const peel = orangePeelImage(64);
    checkNormalMap(peel);
    expect(seamRatio(peel)).toBeLessThan(3);
    for (const k of ['plastic', 'leather', 'fabric', 'rubber'] as const) {
      const g = grainNormalImage(k, 64);
      checkNormalMap(g);
      expect(seamRatio(g)).toBeLessThan(4);
    }
    for (const k of ['reflector', 'prism'] as const) checkNormalMap(lensNormalImage(k));
    const honey = honeycombImages();
    checkNormalMap(honey.normal);
    expect(honey.color.width).toBe(honey.normal.width);
  });

  it('tread: grooves darker than ribs at the given band fractions', () => {
    const grooves = [
      { v: 0.3, w: 0.06 },
      { v: 0.7, w: 0.06 },
    ];
    for (const p of ['street', 'sport', 'allTerrain'] as const) {
      const t = treadImages(p, grooves, 4);
      checkNormalMap(t.normal);
      const shade = (v: number): number => {
        const y = Math.floor(v * t.color.height);
        let s = 0;
        for (let x = 0; x < t.color.width; x++) s += t.color.data[(y * t.color.width + x) * 4]!;
        return s / t.color.width;
      };
      expect(shade(0.3)).toBeLessThan(shade(0.5) - 20);
    }
  });

  it('brake disc has drilled holes; sidewall and plate degrade without a canvas', () => {
    const d = brakeDiscImages();
    let dark = 0;
    for (let i = 0; i < d.color.width * d.color.height; i++) if (d.color.data[i * 4]! < 60) dark++;
    expect(dark).toBeGreaterThan(100);
    const s = sidewallImages('Crumple');
    checkNormalMap(s.normal);
    const p = plateImage('AB 123');
    expect(p.width).toBe(512);
  });

  it('cached accessors return shared textures', () => {
    expect(vehicleTextures.orangePeel()).toBe(vehicleTextures.orangePeel());
    expect(vehicleTextures.lens('prism')).toBe(vehicleTextures.lens('prism'));
    const t = vehicleTextures.honeycomb();
    expect(t.normal).toBe(vehicleTextures.honeycomb().normal);
    expect(t.color.colorSpace).toBe('srgb');
    expect(t.normal.colorSpace).not.toBe('srgb');
  });
});
