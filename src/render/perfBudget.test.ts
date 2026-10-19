/**
 * Render budget switches (perf pass): CSM far-cascade throttling, the
 * vehicle's per-cascade shadow LOD and the low preset's lite shader paths.
 */
import { describe, expect, it } from 'vitest';

import { cascadeDue, cascadesOverlapping, cascadeSplits, CSM_THROTTLE_FROM } from './lighting';
import { RD_LITE_DEFINE, roadLite } from './roads/index';
import { ROAD_FRAGMENT_SURFACE } from './roads/shader';
import { terrainAnisotropy } from './terrain/renderer';
import { applyTerrainColorPatch, createTerrainUniforms, TERRAIN_LITE_DEFINE, terrainLite } from './terrain/shader';
import { terrainTextureSize } from './terrain/textures';
import { QUALITY_LEVELS, QUALITY_PRESETS } from './types';

describe('CSM throttling', () => {
  it('renders near cascades every frame and staggers the far ones', () => {
    for (let f = 0; f < 8; f++) {
      for (let i = 0; i < CSM_THROTTLE_FROM; i++) expect(cascadeDue(i, f)).toBe(true);
      // 4 cascades: exactly one of cascades 2/3 per frame
      expect(Number(cascadeDue(2, f)) + Number(cascadeDue(3, f))).toBe(1);
    }
  });
});

describe('cascadesOverlapping (vehicle shadow LOD)', () => {
  const far = 400;
  const breaks = cascadeSplits(4, 0.1, far); // ≈ [16.7, 45, 125, 400] m
  it('a chase-cam car only reaches the first cascade', () => {
    expect(cascadesOverlapping(breaks, far, 0, 15)).toBe(0b0001);
  });
  it('a distant car reaches the cascades around it, never the near ones', () => {
    const m = cascadesOverlapping(breaks, far, 60, 80);
    expect(m & 0b0011).toBe(0);
    expect(m & 0b0100).toBeTruthy();
  });
  it('spans the fade band of a boundary', () => {
    const edge = breaks[0]! * far;
    expect(cascadesOverlapping(breaks, far, edge - 1, edge + 1)).toBe(0b0011);
  });
  it('never returns an empty mask', () => {
    expect(cascadesOverlapping(breaks, far, 5000, 6000)).toBe(0b1000);
  });
});

describe('low preset lite paths', () => {
  it('only low uses the lite terrain / road shaders and texture setup', () => {
    for (const level of QUALITY_LEVELS) {
      expect(terrainLite(level)).toBe(level === 'low');
      expect(roadLite(level)).toBe(level === 'low');
    }
    expect(terrainAnisotropy('low', 16)).toBe(1);
    expect(terrainAnisotropy('high', 16)).toBe(8);
    expect(terrainTextureSize('low')).toBeLessThan(terrainTextureSize('medium'));
    expect(terrainTextureSize('high')).toBe(2048);
    expect(QUALITY_PRESETS.low.level).toBe('low');
  });

  it('the terrain patch carries the TERRAIN_LITE branch (one tap, no hex/triplanar/far detail)', () => {
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader:
        '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <aomap_fragment>',
    };
    applyTerrainColorPatch(shader as never, createTerrainUniforms());
    const fs = shader.fragmentShader;
    expect(fs).toContain(`#ifdef ${TERRAIN_LITE_DEFINE}`);
    expect(fs).toContain('tSamplePlain(pY');
    // the hex grid and the side planes sit behind #ifndef/#else of the lite define
    const lite = fs.indexOf('#ifdef TERRAIN_LITE\n  vec3 tw');
    expect(lite).toBeGreaterThan(0);
    expect(fs.indexOf('THex gY = tHexGrid(pY);')).toBeGreaterThan(lite);
  });

  it('the road shader carries the RD_LITE one-tap branch', () => {
    expect(RD_LITE_DEFINE).toBe('RD_LITE');
    expect(ROAD_FRAGMENT_SURFACE).toContain('#ifdef RD_LITE');
  });
});
