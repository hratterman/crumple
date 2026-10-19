import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYOUT } from './layout';
import { syntheticTerrain } from './sampler.testkit';
import type { WorldLayout } from './types';
import { WATER_OPTICS_DEFAULTS } from './types';
import { resolveWater, waterAt, waterField } from './water';

const lake = DEFAULT_LAYOUT.zones.find((z) => z.kind === 'lake')!;

function layoutWith(level: number): WorldLayout {
  return { ...DEFAULT_LAYOUT, waterLevel: level, zones: [{ ...lake, shape: { type: 'circle', center: [0, 0], radius: 10, blend: 2 } }] };
}

describe('resolveWater', () => {
  // Bowl 6 m deep at the centre, rim at r = 10 m above level 0; a separate dry-land pit far away stays out.
  const terrain = syntheticTerrain({
    cols: 61,
    rows: 61,
    height: (x, z) => {
      if ((x - 25) ** 2 + (z - 25) ** 2 < 4) return -3;
      const r = Math.sqrt(x * x + z * z);
      return r < 10 ? -6 * (1 - (r * r) / 100) + 0.0 : 2;
    },
  });

  it('floods the connected basin and builds its AABB + margin', () => {
    const [b, ...rest] = resolveWater(layoutWith(0), terrain);
    expect(rest).toHaveLength(0);
    expect(b!.id).toBe(lake.id);
    expect(b!.level).toBe(0);
    expect(b!.maxDepth).toBeCloseTo(6, 3);
    expect(b!.minX).toBeGreaterThanOrEqual(-12.01);
    expect(b!.maxX).toBeLessThanOrEqual(12.01);
    expect(b!.maxX).toBeLessThan(23); // the isolated pit at (25, 25) is not connected
    expect(b!.optics).toEqual(WATER_OPTICS_DEFAULTS);
  });

  it('answers point queries', () => {
    const bodies = resolveWater(layoutWith(0), terrain);
    expect(waterAt(bodies, 0, -1, 0)).toBe(0);
    expect(waterAt(bodies, 0, 0.5, 0)).toBe(-1);
    expect(waterAt(bodies, 25, -2, 25)).toBe(-1);
  });

  it('skips a lake whose centre is dry', () => {
    expect(resolveWater(layoutWith(-10), terrain)).toHaveLength(0);
  });
});

describe('waterField', () => {
  const terrain = syntheticTerrain({
    cols: 61,
    rows: 61,
    height: (x, z) => {
      if ((x - 25) ** 2 + (z - 25) ** 2 < 4) return -3;
      const r = Math.sqrt(x * x + z * z);
      return r < 10 ? -6 * (1 - (r * r) / 100) : 2;
    },
  });
  const [body] = resolveWater(layoutWith(0), terrain);
  const f = waterField(terrain, body!);

  it('covers the body rect on the terrain grid with level − height depths', () => {
    expect(f.originX).toBeLessThanOrEqual(body!.minX);
    expect(f.originX + (f.cols - 1) * f.spacing).toBeGreaterThanOrEqual(body!.maxX);
    const c = Math.round((0 - f.originX) / f.spacing);
    const r = Math.round((0 - f.originZ) / f.spacing);
    expect(f.depth[r * f.cols + c]).toBeCloseTo(6, 3);
  });

  it('floods exactly the samples resolveWater counted, with a signed shore distance', () => {
    let n = 0;
    for (let k = 0; k < f.mask.length; k++) {
      if (f.mask[k]) {
        n++;
        expect(f.depth[k]).toBeGreaterThan(0);
        expect(f.shoreDist[k]).toBeGreaterThan(0);
      } else {
        expect(f.shoreDist[k]).toBeLessThan(0);
      }
    }
    expect(n).toBe(body!.samples);
    // the centre is ~10 m from the rim; the rim samples are ~0.5 m in
    const centre = Math.round((0 - f.originZ) / f.spacing) * f.cols + Math.round((0 - f.originX) / f.spacing);
    expect(f.shoreDist[centre]).toBeGreaterThan(8);
    expect(f.shoreDist[centre]).toBeLessThan(11);
  });
});
