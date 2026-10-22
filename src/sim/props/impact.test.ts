/**
 * Prop impacts at 50 km/h (R-PHYS2): a sedan coasting head-on into each
 * prop. Momentum: the car's Δv against the perfectly inelastic reference
 * v·m/(M + m) (light props are thrown faster than the car: Δv near the
 * line; heavy ones that slide on the ground add friction impulse: above it).
 * Failure modes: the full drum and the water barrier split and drain, the
 * fence splinters, the sign's breakaway base lets go inside the occupant
 * impact velocity limit (MASH: OIV ≤ 5 m/s, breakaway hardware ≤ 3 m/s
 * preferred), the jersey barrier barely moves.
 */
import { describe, expect, it } from 'vitest';
import { SEDAN } from '../vehicle/defs/sedan';
import { runPropImpact, type ImpactResult } from './impact';
import type { PropKey } from './types';

function hit(key: PropKey): ImpactResult {
  const r = runPropImpact(SEDAN, key, 50);
  console.log(
    `[impact] ${key.padEnd(13)} ${r.propKg.toFixed(0).padStart(5)} kg: car Δv ${r.dvKmh.toFixed(1)} km/h (inelastic ${r.dvInelasticKmh.toFixed(1)}), prop ${r.propSpeed.toFixed(1)} m/s, moved ${r.propMoved.toFixed(1)} m, ` +
      `car plastic ${r.carPlastic} / broken ${r.carBroken}, prop broken ${r.propBroken} / plastic ${r.propPlastic}, anchor ${r.anchorBroken}, contents ${r.fluidLeft?.toFixed(0) ?? '-'} kg, peak ${r.peakG.toFixed(1)} g`,
  );
  return r;
}

describe('prop impacts at 50 km/h', () => {
  it('light props: cone, tyre and empty drum fly off; the car barely notices', () => {
    const cone = hit('cone');
    expect(cone.propSpeed / cone.v0).toBeGreaterThan(1.0);
    expect(cone.propSpeed / cone.v0).toBeLessThan(1.7);
    expect(cone.dvKmh).toBeLessThan(1.5);
    expect(cone.carPlastic).toBe(0);
    const tire = hit('tire');
    expect(tire.dvKmh).toBeLessThan(3);
    const drum = hit('barrel');
    expect(drum.dvKmh).toBeLessThan(2);
    expect(drum.propPlastic).toBeGreaterThan(0); // dented
  }, 120_000);

  it('filled props: the full drum and the water barrier split and drain; the hay bale squashes', () => {
    for (const key of ['barrelFull', 'waterBarrier', 'hayBale'] as const) {
      const r = hit(key);
      expect(r.dvKmh).toBeGreaterThan(0.9 * r.dvInelasticKmh);
      expect(r.dvKmh).toBeLessThan(1.6 * r.dvInelasticKmh);
      expect(r.carPlastic).toBeGreaterThan(0);
      expect(r.peakG).toBeLessThan(10);
      if (key === 'barrelFull') expect(r.fluidLeft!).toBeLessThan(180);
      if (key === 'waterBarrier') expect(r.fluidLeft!).toBeLessThan(380);
      if (key === 'hayBale') expect(r.propPlastic).toBeGreaterThan(0);
    }
  }, 120_000);

  it('breakaway: the fence splinters and the sign post base lets go below the occupant-impact limit', () => {
    const fence = hit('fencePanel');
    expect(fence.propBroken).toBeGreaterThan(10);
    expect(fence.anchorBroken).toBe(true);
    expect(fence.dvKmh).toBeLessThan(5);
    const sign = hit('signPost');
    expect(sign.anchorBroken).toBe(true);
    expect(sign.dvKmh).toBeLessThan(10.8);
  }, 120_000);

  it('a 1.8 t jersey barrier barely moves and stops the car hard', () => {
    const r = hit('jerseyBarrier');
    expect(r.dvKmh).toBeGreaterThan(r.dvInelasticKmh);
    expect(r.propMoved).toBeLessThan(5);
    expect(r.carPlastic).toBeGreaterThan(20);
    expect(r.peakG).toBeLessThan(20);
  }, 120_000);
});
