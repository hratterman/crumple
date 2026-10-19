import { describe, expect, it } from 'vitest';
import { SMAAPreset } from 'postprocessing';

import { aoSettings, orderedEffects, postFlags, SANITIZE_FRAGMENT, SANITIZE_MAX, smaaPresetFor } from './post';
import { QUALITY_PRESETS } from './types';

describe('post stack (pure parts)', () => {
  it('maps presets to effect flags (the NaN guard rides with bloom)', () => {
    expect(postFlags(QUALITY_PRESETS.low)).toEqual({ ao: false, smaa: true, bloom: false, sanitize: false });
    expect(postFlags(QUALITY_PRESETS.high)).toEqual({ ao: true, smaa: true, bloom: true, sanitize: true });
    for (const q of Object.values(QUALITY_PRESETS)) expect(postFlags(q).sanitize).toBe(q.bloom);
  });

  it('keeps the frozen effect order and leaves disabled effects out', () => {
    const fx = { smaa: 'smaa', bloom: 'bloom', tone: 'tone', vignette: 'vignette' };
    expect(orderedEffects({ ao: true, smaa: true, bloom: true, sanitize: true }, fx)).toEqual(['smaa', 'bloom', 'tone', 'vignette']);
    expect(orderedEffects({ ao: false, smaa: true, bloom: false, sanitize: false }, fx)).toEqual(['smaa', 'tone', 'vignette']);
    expect(orderedEffects({ ao: false, smaa: false, bloom: true, sanitize: true }, fx)).toEqual(['bloom', 'tone', 'vignette']);
  });

  it('n8ao: denoise samples follow at half the AO samples; half-res only for the cheapest setting', () => {
    for (const q of Object.values(QUALITY_PRESETS)) {
      const s = aoSettings(q);
      expect(s.aoSamples).toBe(q.aoSamples);
      expect(s.denoiseSamples).toBe(q.aoSamples / 2);
    }
    expect(aoSettings(QUALITY_PRESETS.medium).halfRes).toBe(true);
    expect(aoSettings(QUALITY_PRESETS.high).halfRes).toBe(false);
  });

  it('SMAA search quality scales with the preset', () => {
    expect(smaaPresetFor(QUALITY_PRESETS.low)).toBe(SMAAPreset.LOW);
    expect(smaaPresetFor(QUALITY_PRESETS.medium)).toBe(SMAAPreset.MEDIUM);
    expect(smaaPresetFor(QUALITY_PRESETS.high)).toBe(SMAAPreset.HIGH);
    expect(smaaPresetFor(QUALITY_PRESETS.ultra)).toBe(SMAAPreset.ULTRA);
  });

  it('the sanitize pass replaces non-finite texels (bit test) and clamps overflow', () => {
    expect(SANITIZE_FRAGMENT).toContain('floatBitsToUint');
    expect(SANITIZE_FRAGMENT).toContain('0x7f800000u');
    expect(SANITIZE_FRAGMENT).toContain('isnan');
    expect(SANITIZE_FRAGMENT).toContain(`clamp(c, vec4(-${SANITIZE_MAX}.0), vec4(${SANITIZE_MAX}.0))`);
    expect(SANITIZE_MAX).toBeLessThan(65504);
    expect(SANITIZE_MAX).toBeGreaterThan(60); // above the sun disc radiance
  });
});
