import { describe, expect, it } from 'vitest';

import { RAIN_DROPS } from '../fx/rain';
import { wetSurface } from '../fx/index';
import { MaterialId } from '../../protocol/messages';
import { CLOUD_QUALITY } from './clouds';
import { envPatchFor, injectEnv } from './envPatch';
import { puddlePotential } from './puddles';

describe('puddle potential', () => {
  it('pools in bowls, not on flat ground or slopes', () => {
    const cols = 41;
    const rows = 41;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = c - 10;
        const z = r - 20;
        // left half: a 30 cm bowl around (10, 20); right half: a 20 % slope
        heights[r * cols + c] = c < 20 ? 0.3 * Math.min(1, (x * x + z * z) / 36) : 0.2 * c;
      }
    const { data, w } = puddlePotential({ heights, cols, rows, spacing: 1 }, 2);
    const at = (c: number, r: number) => data[(r >> 1) * w + (c >> 1)]!;
    expect(at(10, 20)).toBeGreaterThan(80); // bottom of the bowl
    expect(at(2, 2)).toBe(0); // flat corner
    expect(at(32, 20)).toBe(0); // slope drains
  });
});

describe('wet surfaces', () => {
  const shader = () => ({
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '',
    fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <clearcoat_normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n#include <emissivemap_fragment>',
  });
  it('ground gets puddles, paint gets beads, none gets nothing; keys differ', () => {
    const g = shader();
    injectEnv(g as never, { wet: 'ground' });
    expect(g.fragmentShader).toContain('#define CRUMPLE_WET 2');
    expect(g.fragmentShader).toContain('crumpleRipples');
    expect(g.uniforms.crumplePuddleMap).toBeDefined();
    const p = shader();
    injectEnv(p as never, { wet: 'paint' });
    expect(p.fragmentShader).toContain('#define CRUMPLE_WET 3');
    expect(p.fragmentShader).toContain('crumpleBeads( buv )');
    expect(p.uniforms.crumplePuddleMap).toBeUndefined();
    const n = shader();
    injectEnv(n as never, { wet: 'none' });
    expect(n.fragmentShader).toContain('#define CRUMPLE_WET 0');
    const keys = new Set([envPatchFor().key, envPatchFor({ wet: 'ground' }).key, envPatchFor({ wet: 'paint' }).key, envPatchFor({ lamp: 0.1 }).key]);
    expect(keys.size).toBe(4);
    expect(envPatchFor({ wet: 'ground' })).toBe(envPatchFor({ wet: 'ground' }));
  });
  it('tyres spray off sealed surfaces only', () => {
    expect(wetSurface(MaterialId.asphalt)).toBe(true);
    expect(wetSurface(MaterialId.concrete)).toBe(true);
    expect(wetSurface(MaterialId.grass)).toBe(false);
    expect(wetSurface(MaterialId.dirt)).toBe(false);
  });
});

describe('presets', () => {
  it('rain drops and cloud marching scale up with the preset', () => {
    const lv = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < lv.length; i++) {
      expect(RAIN_DROPS[lv[i]!]).toBeGreaterThan(RAIN_DROPS[lv[i - 1]!]);
      expect(CLOUD_QUALITY[lv[i]!].steps).toBeGreaterThan(CLOUD_QUALITY[lv[i - 1]!].steps);
      expect(CLOUD_QUALITY[lv[i]!].panorama[0]).toBeGreaterThanOrEqual(CLOUD_QUALITY[lv[i - 1]!].panorama[0]);
    }
    expect(CLOUD_QUALITY.low.lightSteps).toBe(0); // flat 2D layer
  });
});
