import { describe, expect, it } from 'vitest';

import { MaterialId } from '../../protocol/messages';
import {
  GROUND_HARD,
  GROUND_OBJECT,
  GROUND_SOFT,
  IMPACT_CHIPS,
  IMPACT_CLOD,
  IMPACT_NONE,
  IMPACT_SPARKS,
  SCRAPE_CHIPS,
  SCRAPE_DUST,
  SCRAPE_NONE,
  SCRAPE_SPARKS,
  SURF_CARDBOARD,
  SURF_METAL,
  SURF_PLASTIC,
  SURF_TYRE,
  SURF_WOOD,
  WHEEL_ROOST,
  WHEEL_RUT,
  WHEEL_SKID,
  WHEEL_SMOKE,
  WHEEL_SPRAY,
  groundClass,
  impactEffect,
  rutStrength,
  scrapeEffect,
  skidStrength,
  smokeRate,
  sparkBurstCount,
  surfaceCode,
  sweptWidth,
  wheelEffects,
} from './rules';

describe('fx rules — contract table (docs/CONTRACTS.md "FX event → effect")', () => {
  it('classifies ground materials', () => {
    for (const m of [MaterialId.asphalt, MaterialId.concrete, MaterialId.rock, MaterialId.metal]) expect(groundClass(m)).toBe(GROUND_HARD);
    for (const m of [MaterialId.grass, MaterialId.dirt, MaterialId.gravel]) expect(groundClass(m)).toBe(GROUND_SOFT);
    for (const m of [MaterialId.plastic, MaterialId.rubber, MaterialId.wood, MaterialId.cardboard]) expect(groundClass(m)).toBe(GROUND_OBJECT);
  });

  it('impact rows', () => {
    // metal/concrete mover on hard ground ≥ 6 N·s → sparks
    expect(impactEffect(SURF_METAL, MaterialId.concrete, 10)).toBe(IMPACT_SPARKS);
    expect(impactEffect(SURF_METAL, MaterialId.metal, 6)).toBe(IMPACT_SPARKS);
    expect(impactEffect(SURF_METAL, MaterialId.asphalt, 5.9)).toBe(IMPACT_NONE);
    // tyres never spark
    expect(impactEffect(SURF_TYRE, MaterialId.asphalt, 50)).toBe(IMPACT_NONE);
    // soft ground ≥ 10 → clods (any mover, tyres included)
    expect(impactEffect(SURF_METAL, MaterialId.dirt, 12)).toBe(IMPACT_CLOD);
    expect(impactEffect(SURF_TYRE, MaterialId.grass, 12)).toBe(IMPACT_CLOD);
    expect(impactEffect(SURF_METAL, MaterialId.gravel, 9)).toBe(IMPACT_NONE);
    // soft movers / soft object materials → chips, no sparks
    expect(impactEffect(SURF_PLASTIC, MaterialId.asphalt, 8)).toBe(IMPACT_CHIPS);
    expect(impactEffect(SURF_WOOD, MaterialId.concrete, 8)).toBe(IMPACT_CHIPS);
    expect(impactEffect(SURF_METAL, MaterialId.plastic, 8)).toBe(IMPACT_CHIPS);
    expect(impactEffect(SURF_METAL, MaterialId.cardboard, 3)).toBe(IMPACT_NONE);
  });

  it('scrape rows (non-tyre skid events)', () => {
    expect(scrapeEffect(SURF_METAL, MaterialId.asphalt, 3, 200)).toBe(SCRAPE_SPARKS);
    expect(scrapeEffect(SURF_METAL, MaterialId.asphalt, 3, 50)).toBe(SCRAPE_DUST);
    expect(scrapeEffect(SURF_METAL, MaterialId.asphalt, 1, 500)).toBe(SCRAPE_NONE);
    expect(scrapeEffect(SURF_METAL, MaterialId.grass, 5, 500)).toBe(SCRAPE_DUST);
    expect(scrapeEffect(SURF_CARDBOARD, MaterialId.asphalt, 3, 500)).toBe(SCRAPE_CHIPS);
    expect(scrapeEffect(SURF_TYRE, MaterialId.asphalt, 10, 4000)).toBe(SCRAPE_NONE);
  });

  it('wheel telemetry rows', () => {
    expect(wheelEffects(MaterialId.asphalt, 4, 3000, 10, true)).toBe(WHEEL_SMOKE | WHEEL_SKID);
    expect(wheelEffects(MaterialId.asphalt, 2.5, 3000, 10, true)).toBe(WHEEL_SKID);
    expect(wheelEffects(MaterialId.asphalt, 2.5, 500, 10, true)).toBe(0);
    expect(wheelEffects(MaterialId.asphalt, 10, 3000, 10, false)).toBe(0);
    expect(wheelEffects(MaterialId.dirt, 1.5, 3000, 10, true)).toBe(WHEEL_RUT | WHEEL_SPRAY | WHEEL_ROOST);
    expect(wheelEffects(MaterialId.gravel, 0, 3000, 7, true)).toBe(WHEEL_ROOST);
    expect(wheelEffects(MaterialId.grass, 0, 3000, 20, true)).toBe(0);
    expect(wheelEffects(MaterialId.grass, 2, 3000, 20, true)).toBe(WHEEL_RUT | WHEEL_SPRAY);
  });

  it('rates and strengths are monotonic, bounded and zero below thresholds', () => {
    expect(smokeRate(2.9, 4000)).toBe(0);
    expect(smokeRate(6, 3500)).toBeGreaterThan(smokeRate(4, 3500));
    expect(smokeRate(6, 5000)).toBeGreaterThan(smokeRate(6, 2000));
    expect(smokeRate(1000, 1e6)).toBeLessThanOrEqual(150);
    expect(skidStrength(2, 3500)).toBe(0);
    let prev = 0;
    for (let s = 2.5; s < 20; s += 0.5) {
      const v = skidStrength(s, 3500);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(rutStrength(0.5, 3500)).toBe(0);
    expect(rutStrength(3, 3500)).toBeGreaterThan(0);
    expect(sparkBurstCount(1e6)).toBeLessThanOrEqual(90);
  });

  it('swept width: tread when rolling straight, patch length when sliding sideways', () => {
    // axle along +X; path along −Z (rolling) vs along X (sideways)
    expect(sweptWidth(0.22, 0.2, 1, 0, 0, -1)).toBeCloseTo(0.22);
    expect(sweptWidth(0.22, 0.2, 1, 0, 1, 0)).toBeCloseTo(0.2);
    const d = Math.SQRT1_2;
    expect(sweptWidth(0.22, 0.2, 1, 0, d, -d)).toBeCloseTo((0.22 + 0.2) * d);
  });

  it('prop surfaces map to codes', () => {
    expect(surfaceCode('metal')).toBe(SURF_METAL);
    expect(surfaceCode('plastic')).toBe(SURF_PLASTIC);
    expect(surfaceCode('wood')).toBe(SURF_WOOD);
  });
});
