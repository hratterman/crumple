/**
 * R-RIG: the physics-quality → rig-variant resolution (variants.ts): validated tiers are offered, an
 * experimental tier falls back to the next lower validated one (then standard) unless the caller opts in.
 */
import { describe, expect, it } from 'vitest';
import { STANDARD_VARIANTS } from './index';
import { HD_STATUS, loadVehicleVariant, variantTiers } from './variants';

describe('loadVehicleVariant', { timeout: 120_000 }, () => {
  const std = (car: keyof typeof STANDARD_VARIANTS) => async () => STANDARD_VARIANTS[car];

  it('delivers a validated tier and falls back past experimental ones', async () => {
    for (const [car, st] of Object.entries(HD_STATUS)) {
      for (const q of ['high', 'ultra'] as const) {
        const v = await loadVehicleVariant(car, q, std(car as keyof typeof STANDARD_VARIANTS));
        const want = st[q] === 'validated' ? q : q === 'ultra' && st.high === 'validated' ? 'high' : 'standard';
        expect(v.quality, `${car} ${q}`).toBe(want);
        expect(variantTiers(car)).toEqual(['standard', ...(['high', 'ultra'] as const).filter((t) => st[t] === 'validated')]);
      }
    }
  });

  it('delivers an experimental tier when asked', async () => {
    const v = await loadVehicleVariant('pickup', 'high', std('pickup'), { experimental: true });
    expect(v.quality).toBe('high');
    expect(v.def.body.nodes.length).toBeGreaterThan(STANDARD_VARIANTS.pickup.def.body.nodes.length);
    expect(variantTiers('pickup', true)).toEqual(['standard', 'high', 'ultra']);
    expect((await loadVehicleVariant('nosuchcar', 'ultra', std('sedan'))).quality).toBe('standard');
  });

  it('at least one car offers a validated HD tier', () => {
    expect(Object.values(HD_STATUS).some((st) => st.high === 'validated' || st.ultra === 'validated')).toBe(true);
  });
});
