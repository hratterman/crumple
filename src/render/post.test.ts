import { describe, expect, it } from 'vitest';

import { aoSettings, orderedEffects, postFlags } from './post';
import { QUALITY_PRESETS } from './types';

describe('post stack (pure parts)', () => {
  it('maps presets to effect flags', () => {
    expect(postFlags(QUALITY_PRESETS.low)).toEqual({ ao: false, smaa: true, bloom: false });
    expect(postFlags(QUALITY_PRESETS.high)).toEqual({ ao: true, smaa: true, bloom: true });
  });

  it('keeps the frozen effect order and leaves disabled effects out', () => {
    const fx = { smaa: 'smaa', bloom: 'bloom', tone: 'tone', vignette: 'vignette' };
    expect(orderedEffects({ ao: true, smaa: true, bloom: true }, fx)).toEqual(['smaa', 'bloom', 'tone', 'vignette']);
    expect(orderedEffects({ ao: false, smaa: true, bloom: false }, fx)).toEqual(['smaa', 'tone', 'vignette']);
    expect(orderedEffects({ ao: false, smaa: false, bloom: true }, fx)).toEqual(['bloom', 'tone', 'vignette']);
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
});
