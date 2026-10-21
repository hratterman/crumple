import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector2 } from 'three';

import { QUALITY_PRESETS } from '../types';
import { postFlags } from '../post';
import { applyJitter, halton, jitterOffset, TAA_SAMPLES } from './taa';

describe('TAA', () => {
  it('Halton(2, 3) jitter is centred, sub-pixel and covers the pixel over one cycle', () => {
    expect(halton(1, 2)).toBeCloseTo(0.5);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    const v = new Vector2();
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < TAA_SAMPLES; i++) {
      jitterOffset(i, v);
      expect(Math.abs(v.x)).toBeLessThan(0.5);
      expect(Math.abs(v.y)).toBeLessThan(0.5);
      sx += v.x;
      sy += v.y;
    }
    expect(Math.abs(sx / TAA_SAMPLES)).toBeLessThan(0.1);
    expect(Math.abs(sy / TAA_SAMPLES)).toBeLessThan(0.1);
  });

  it('jitter shifts the projection by whole-pixel fractions in NDC and is reversible', () => {
    const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    const before = cam.projectionMatrix.clone();
    applyJitter(cam, new Vector2(0.5, -0.25), 1920, 1080, 1);
    expect(cam.projectionMatrix.elements[8]! - before.elements[8]!).toBeCloseTo(1 / 1920);
    expect(cam.projectionMatrix.elements[9]! - before.elements[9]!).toBeCloseTo(-0.5 / 1080);
    applyJitter(cam, new Vector2(0.5, -0.25), 1920, 1080, -1);
    expect(cam.projectionMatrix.elements[8]).toBeCloseTo(before.elements[8]!);
  });

  it('presets: TAA everywhere replaces SMAA; motion blur only on high / ultra', () => {
    for (const q of Object.values(QUALITY_PRESETS)) {
      expect(q.taa).toBe(true);
      expect(postFlags(q).smaa).toBe(false);
    }
    expect(QUALITY_PRESETS.low.motionBlur).toBe(0);
    expect(QUALITY_PRESETS.high.motionBlur).toBeGreaterThan(0);
  });
});
