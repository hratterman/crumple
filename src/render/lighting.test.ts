import { describe, expect, it } from 'vitest';
import { DataUtils, Euler, Matrix3, Matrix4, Vector3 } from 'three';

import {
  analyzeEquirect,
  cascadeSplits,
  CSM_SPLIT_NEAR_M,
  envYawFor,
  equirectDirection,
  gradeEquirect,
  liftSunElevation,
} from './lighting';
import type { EquirectImage } from './lighting';

const W = 256;
const H = 128;

/** three's equirectUv (common.glsl) */
function equirectUv(d: Vector3): [number, number] {
  return [Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5, Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5];
}

function dirFromAzEl(azDeg: number, elDeg: number): Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
}

/** Synthetic dawn: blue sky, dark ground, a wide warm glow at (az 40°, el 6°), a tiny bright "moon" at (az −120°, el 40°). */
function syntheticSky(half = false): EquirectImage {
  const glow = dirFromAzEl(40, 6);
  const moon = dirFromAzEl(-120, 40);
  const data = half ? new Uint16Array(W * H * 4) : new Float32Array(W * H * 4);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const d = new Vector3(...equirectDirection(col, row, W, H));
      let r: number;
      let g: number;
      let b: number;
      if (d.y >= 0) {
        r = 0.5;
        g = 0.55;
        b = 1.3;
      } else {
        r = g = b = 0.2;
      }
      const cg = Math.max(0, d.dot(glow));
      const gl = 30 * cg ** 40;
      r += gl;
      g += gl * 0.45;
      b += gl * 0.25;
      if (d.dot(moon) > Math.cos((1.2 * Math.PI) / 180)) r = g = b = 60; // brighter peak, tiny area
      const i = (row * W + col) * 4;
      const v = [r, g, b, 1];
      for (let k = 0; k < 4; k++) data[i + k] = half ? DataUtils.toHalfFloat(v[k]!) : v[k]!;
    }
  }
  return { width: W, height: H, data, encoding: half ? 'half' : 'float', channels: 4 };
}

const deg = (rad: number): number => (rad * 180) / Math.PI;

describe('equirectDirection', () => {
  it("inverts three's equirectUv (row 0 = zenith)", () => {
    for (const [col, row] of [
      [0, 0],
      [17, 40],
      [128, 64],
      [200, 100],
      [255, 127],
    ] as const) {
      const d = new Vector3(...equirectDirection(col, row, W, H));
      expect(d.length()).toBeCloseTo(1, 6);
      const [u, v] = equirectUv(d);
      expect(u * W - 0.5).toBeCloseTo(col, 4);
      expect((1 - v) * H - 0.5).toBeCloseTo(row, 4);
    }
    expect(equirectDirection(0, 0, W, H)[1]).toBeGreaterThan(0.99);
  });
});

describe('analyzeEquirect', () => {
  for (const half of [false, true]) {
    it(`finds the glow (not the brighter tiny moon) — ${half ? 'half' : 'float'} data`, () => {
      const a = analyzeEquirect(syntheticSky(half));
      const d = new Vector3(...a.sunDirection);
      const glow = dirFromAzEl(40, 6);
      expect(deg(d.angleTo(glow))).toBeLessThan(3);
      expect(a.sunColor[0]).toBe(1);
      expect(a.sunColor[2]).toBeLessThan(a.sunColor[1]); // warm
    });
  }

  it('fits the horizon model: bright warm toward the sun, blue away, sane lobe', () => {
    const a = analyzeEquirect(syntheticSky());
    expect(a.horizonAway[2]).toBeGreaterThan(a.horizonAway[0]); // blue away from the sun
    const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(lum(a.horizonSun)).toBeGreaterThan(2 * lum(a.horizonAway));
    expect(a.horizonLobe).toBeGreaterThanOrEqual(1);
    expect(a.horizonLobe).toBeLessThanOrEqual(64);
    expect(a.zenith[2]).toBeCloseTo(1.3, 1);
  });

  it('reads 8-bit sRGB data (procedural fallback)', () => {
    const data = new Uint8Array(W * H * 4).fill(40);
    // bright patch at a known pixel
    for (let row = 50; row < 56; row++) for (let col = 30; col < 36; col++) data.set([255, 230, 180, 255], (row * W + col) * 4);
    const a = analyzeEquirect({ width: W, height: H, data, encoding: 'srgb8', channels: 4 });
    const expected = new Vector3(...equirectDirection(32.5, 52.5, W, H));
    expect(deg(new Vector3(...a.sunDirection).angleTo(expected))).toBeLessThan(2);
  });
});

describe('liftSunElevation', () => {
  it('keeps azimuth, raises low elevation, leaves high suns alone', () => {
    const low = dirFromAzEl(48, 5);
    const lifted = new Vector3(...liftSunElevation([low.x, low.y, low.z], 16));
    expect(deg(Math.asin(lifted.y))).toBeCloseTo(16, 6);
    expect(deg(Math.atan2(lifted.z, lifted.x))).toBeCloseTo(48, 6);
    expect(lifted.length()).toBeCloseTo(1, 9);
    const high = dirFromAzEl(10, 40);
    expect(liftSunElevation([high.x, high.y, high.z], 16)).toEqual([high.x, high.y, high.z]);
  });
});

describe('cascadeSplits', () => {
  it('is increasing, ends at 1, and gives a tight first cascade', () => {
    for (const [n, far] of [
      [2, 150],
      [3, 250],
      [4, 400],
      [4, 600],
    ] as const) {
      const s = cascadeSplits(n, 0.1, far);
      expect(s.length).toBe(n);
      expect(s[n - 1]).toBe(1);
      for (let i = 1; i < n; i++) expect(s[i]!).toBeGreaterThan(s[i - 1]!);
      expect(s[0]! * far).toBeGreaterThan(CSM_SPLIT_NEAR_M);
      expect(s[0]! * far).toBeLessThan(far / n); // tighter than a uniform split
    }
    // high preset: first cascade ≈ 17 m (car-scale texels at 2048²)
    const hi = cascadeSplits(4, 0.1, 400);
    expect(hi[0]! * 400).toBeGreaterThan(10);
    expect(hi[0]! * 400).toBeLessThan(25);
  });

  it('writes into the provided array (CSM custom callback form)', () => {
    const target = [9, 9, 9, 9, 9, 9];
    cascadeSplits(3, 0.1, 250, undefined, target);
    expect(target.length).toBe(3);
  });
});

describe('gradeEquirect', () => {
  it('applies per-channel gains', () => {
    const img: EquirectImage = { width: 1, height: 1, data: new Float32Array([1, 2, 4, 1]), encoding: 'float', channels: 4 };
    gradeEquirect(img, [0.5, 1, 0.25]);
    expect(Array.from(img.data as Float32Array)).toEqual([0.5, 2, 1, 1]);
  });

  it('soft shoulder compresses highlights monotonically and leaves the knee untouched', () => {
    const values = [0.5, 3, 5, 10, 30, 3000];
    const data = new Float32Array(values.length * 4);
    values.forEach((v, i) => data.set([v, v, v, 1], i * 4));
    const img: EquirectImage = { width: values.length, height: 1, data, encoding: 'float', channels: 4 };
    gradeEquirect(img, [1, 1, 1], { knee: 3, range: 6 });
    const out = values.map((_, i) => data[i * 4]!);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(3, 6);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    expect(out[out.length - 1]!).toBeLessThan(9); // bounded by knee + range
    expect(out[4]!).toBeGreaterThan(6); // gradation kept in the glow
  });

  it('round-trips half floats', () => {
    const data = new Uint16Array([DataUtils.toHalfFloat(2), DataUtils.toHalfFloat(1), DataUtils.toHalfFloat(0.5), DataUtils.toHalfFloat(1)]);
    gradeEquirect({ width: 1, height: 1, data, encoding: 'half', channels: 4 }, [2, 2, 2]);
    expect(DataUtils.fromHalfFloat(data[0]!)).toBeCloseTo(4, 3);
    expect(DataUtils.fromHalfFloat(data[2]!)).toBeCloseTo(1, 3);
  });
});

describe('envYawFor', () => {
  it("rotates the environment so the HDRI sun lands on the requested sun (three's envMapRotation convention)", () => {
    const hdri = dirFromAzEl(48, 16);
    const world = dirFromAzEl(-100, 16);
    const yaw = envYawFor(hdri.toArray(), world.toArray());
    // three: envMapRotation uniform = rotationFromEuler(scene.environmentRotation)^T; lookup dir = M · worldDir
    const m = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(0, yaw, 0))).transpose();
    const looked = world.clone().applyMatrix3(m);
    expect(deg(looked.angleTo(hdri))).toBeLessThan(1e-6);
  });
});
