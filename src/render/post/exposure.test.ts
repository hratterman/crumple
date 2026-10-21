import { describe, expect, it } from 'vitest';

import { adaptExposure, EXPOSURE_RANGE, EXPOSURE_REF_LUM, exposureTarget, METER_H, METER_W, meteredLog2 } from './exposure';

const grid = (f: (u: number, v: number) => number): Float32Array => {
  const a = new Float32Array(METER_W * METER_H * 4);
  for (let y = 0; y < METER_H; y++) for (let x = 0; x < METER_W; x++) a[(y * METER_W + x) * 4] = f((x + 0.5) / METER_W, (y + 0.5) / METER_H);
  return a;
};

describe('auto exposure', () => {
  it('maps the reference luminance to 1 and adapts partially', () => {
    expect(exposureTarget(Math.log2(EXPOSURE_REF_LUM))).toBeCloseTo(1, 9);
    const darker = exposureTarget(Math.log2(EXPOSURE_REF_LUM / 16));
    expect(darker).toBeGreaterThan(4);
    expect(darker).toBeLessThan(16); // partial: the night stays darker than the day
    expect(exposureTarget(-40)).toBe(EXPOSURE_RANGE[1]);
    expect(exposureTarget(20)).toBe(EXPOSURE_RANGE[0]);
  });
  it('meters centre-weighted and lets a bright sky band count less', () => {
    const flat = meteredLog2(grid(() => -3));
    expect(flat).toBeCloseTo(-3, 9);
    const sky = meteredLog2(grid((_u, v) => (v > 0.7 ? 2 : -3)));
    const ground = meteredLog2(grid((_u, v) => (v < 0.3 ? 2 : -3)));
    expect(sky).toBeLessThan(ground + 0.5);
    expect(Number.isFinite(meteredLog2(grid(() => Number.NaN)))).toBe(false);
  });
  it('adapts toward light faster than toward dark (in EV)', () => {
    const up = adaptExposure(1, 8, 0.5); // raising exposure = dark adaptation (slow)
    const down = adaptExposure(8, 1, 0.5); // bright scene: fast
    expect(Math.log2(up)).toBeLessThan(3 - Math.log2(down));
    expect(adaptExposure(2, 2, 1)).toBeCloseTo(2, 12);
  });
});
