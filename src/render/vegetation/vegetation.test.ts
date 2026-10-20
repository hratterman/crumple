import { ShaderLib } from 'three';
import { describe, expect, it } from 'vitest';

import { MaterialId } from '../../protocol/messages';
import type { TerrainSampler } from '../../world/types';
import { QUALITY_PRESETS, QUALITY_LEVELS } from '../types';
import { ATLAS_PX, ATLAS_SIZE, atlasRect, type AtlasRegion } from './atlas';
import { buildBroadleaf, buildConifer, buildRock, buildShrubs, type VegMeshData } from './geometry';
import { buildTuft, fillGrassTile, GRASS_STRIDE } from './grass';
import { ATLAS_MIP_LEVELS, atlasMips } from './textures';
import { impostorPatch, type ImpostorAtlas } from './impostor';
import { vegetationBands } from './index';
import { createVegUniforms, vegPatch } from './shader';
import { VEG_DRAW_BUDGET, VEG_TREE_MAX_TRIS } from './types';
import { Vector4 } from 'three';
import type { Texture, WebGLProgramParametersWithUniforms } from 'three';

function finite(m: VegMeshData): boolean {
  for (const a of [m.position, m.normal, m.uv, m.veg]) for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}

describe('vegetation meshes', { timeout: 30_000 }, () => {
  const lod0 = [0, 1, 2].flatMap((v) => [buildConifer(v, 0).build(false), buildBroadleaf(v, 0).build(false)]);
  const lod1 = [0, 1, 2].flatMap((v) => [buildConifer(v, 1).build(false), buildBroadleaf(v, 1).build(false)]);

  it('LOD0 trees stay within VEG_TREE_MAX_TRIS; LOD1 is a fraction of it', () => {
    for (const m of lod0) {
      expect(m.triangles).toBeLessThanOrEqual(VEG_TREE_MAX_TRIS);
      expect(m.triangles).toBeGreaterThan(400);
    }
    for (let i = 0; i < lod1.length; i++) expect(lod1[i]!.triangles).toBeLessThan(lod0[i]!.triangles * 0.45);
  });

  it('attributes are finite, normals unit, veg weights in range, indices valid', () => {
    let bad = 0;
    for (const m of [...lod0, ...lod1, buildShrubs(4).build(true), buildRock(2).build(false), buildRock(1).build(false)]) {
      if (!finite(m)) bad++;
      for (let i = 0; i < m.vertexCount; i++) {
        const l = Math.hypot(m.normal[i * 3]!, m.normal[i * 3 + 1]!, m.normal[i * 3 + 2]!);
        const ao = m.veg[i * 4 + 1]!;
        if (Math.abs(l - 1) > 1e-3 || ao < 0 || ao > 1 || m.veg[i * 4 + 2]! < 0) bad++;
      }
      for (const ix of m.index) if (ix >= m.vertexCount) bad++;
    }
    expect(bad).toBe(0);
  }, 30_000);

  it('trees stand on the origin and fit their bounding sphere (impostor bake frame)', () => {
    for (const m of lod0) {
      expect(m.height).toBeGreaterThan(10);
      expect(m.radius).toBeGreaterThan(m.height * 0.45);
      let out = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        const d = Math.hypot(m.position[i * 3]!, m.position[i * 3 + 1]! - m.centerY, m.position[i * 3 + 2]!);
        if (d > m.radius + 1e-4) out++;
      }
      expect(out).toBe(0);
    }
  }, 30_000);

  it('trunk base matches the collider radius at scale 1 (VEG_TRUNK_RADIUS_M)', () => {
    // Bark vertices at y ≈ 1.2 m (above the root flare): radius within 25 % of the collider's.
    for (const [m, r] of [
      [lod0[0]!, 0.2],
      [lod0[1]!, 0.28],
    ] as const) {
      let best = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        if (m.veg[i * 4]! > 0.5) continue;
        const y = m.position[i * 3 + 1]!;
        if (Math.abs(y - 1.2) > 0.6) continue;
        best = Math.max(best, Math.hypot(m.position[i * 3]!, m.position[i * 3 + 2]!));
      }
      expect(best).toBeGreaterThan(r * 0.75);
      expect(best).toBeLessThan(r * 1.6);
    }
  });

  it('merged meshes tag every vertex with its variant', () => {
    const sh = buildShrubs(4).build(true);
    const seen = new Set(Array.from(sh.vvar!));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('rocks: outward normals, unit-ish radius', () => {
    const m = buildRock(2).build(false);
    let out = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const p = [m.position[i * 3]!, m.position[i * 3 + 1]!, m.position[i * 3 + 2]!];
      const d = p[0]! * m.normal[i * 3]! + p[1]! * m.normal[i * 3 + 1]! + p[2]! * m.normal[i * 3 + 2]!;
      if (d > 0) out++;
      if (Math.hypot(p[0]!, p[1]!, p[2]!) > 1.2) out = -1e9;
    }
    expect(out / m.vertexCount).toBeGreaterThan(0.95);
  });
});

describe('atlas layout', () => {
  it('regions lie inside the atlas and never overlap', () => {
    const keys = Object.keys(ATLAS_PX) as AtlasRegion[];
    for (const k of keys) {
      const p = ATLAS_PX[k];
      expect(p.x >= 0 && p.y >= 0 && p.x + p.w <= ATLAS_SIZE && p.y + p.h <= ATLAS_SIZE).toBe(true);
      const r = atlasRect(k);
      expect(r.u).toBeGreaterThanOrEqual(0);
      expect(r.v).toBeGreaterThanOrEqual(0);
      expect(r.u + r.du).toBeLessThanOrEqual(1);
      expect(r.v + r.dv).toBeLessThanOrEqual(1);
    }
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = ATLAS_PX[keys[i]!];
        const b = ATLAS_PX[keys[j]!];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('atlas mips', () => {
  it('never bleed across regions and keep alpha-test coverage', () => {
    const S = ATLAS_SIZE;
    const l0 = new Uint8Array(S * S * 4);
    // rows stored bottom-up: canvas region (x, y, w, h) → stored rows S − (y + h) … S − y
    const fill = (k: AtlasRegion, f: (x: number, y: number) => [number, number, number, number]): void => {
      const p = ATLAS_PX[k];
      for (let y = S - (p.y + p.h); y < S - p.y; y++) for (let x = p.x; x < p.x + p.w; x++) l0.set(f(x, y), (y * S + x) * 4);
    };
    for (const k of Object.keys(ATLAS_PX) as AtlasRegion[]) fill(k, () => [40, 90, 30, 0]);
    fill('barkBirch', () => [230, 225, 215, 255]);
    // leaves: random 8-px blocks (~40 % coverage) on a transparent mean colour
    const hash = (x: number, y: number): number => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000) / 1000;
    fill('leaves', (x, y) => (hash(x >> 3, y >> 3) < 0.4 ? [50, 100, 30, 255] : [50, 100, 30, 0]));
    const mips = atlasMips(l0, S, 'albedo');
    expect(mips.length).toBe(ATLAS_MIP_LEVELS);
    const p = ATLAS_PX.leaves;
    const cov = (L: number): number => {
      const m = mips[L]!;
      let c = 0;
      let n = 0;
      for (let y = (S - (p.y + p.h)) >> L; y < (S - p.y) >> L; y++) {
        for (let x = p.x >> L; x < (p.x + p.w) >> L; x++) {
          const o = (y * m.width + x) * 4;
          expect(m.data[o]!).toBeLessThan(120); // no white birch bark in a leaf texel
          if (m.data[o + 3]! >= 128) c++;
          n++;
        }
      }
      return c / n;
    };
    const c0 = cov(0);
    for (let L = 1; L < ATLAS_MIP_LEVELS; L++) expect(Math.abs(cov(L) - c0)).toBeLessThan(0.15); // 4-step alpha quantisation of the blocky test pattern
    // card UVs stay ≥ half a coarsest-level-but-one texel inside their region
    const r = atlasRect('leaves');
    expect(r.u * S - p.x).toBeGreaterThanOrEqual(8);
  }, 30_000);
});

describe('grass', () => {
  it('tuft indices are valid', () => {
    const t = buildTuft();
    for (const i of t.index) expect(i).toBeLessThan(t.position.length / 3);
    expect(t.index.length / 3).toBeLessThanOrEqual(40);
  });

  const sampler = (paved: (x: number) => boolean): TerrainSampler => ({
    heightAt: () => 10,
    normalAt: (_x, _z, out) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    },
    materialAt: () => MaterialId.grass,
    splatAt: (x, _z, out) => {
      const p = paved(x) ? 1 : 0;
      out[0] = p;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      out[4] = 1 - p;
    },
    contains: () => true,
  });

  it('tiles are deterministic, grow only on grass and stay out of water', () => {
    const s = sampler((x) => x < 4);
    const a = fillGrassTile(0, 0, s, 0, null);
    const b = fillGrassTile(0, 0, s, 0, null);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length / GRASS_STRIDE).toBeGreaterThan(40);
    for (let i = 0; i < a.length; i += GRASS_STRIDE) {
      expect(a[i]!).toBeGreaterThanOrEqual(4);
      expect(a[i + 3]!).toBeGreaterThan(0.1);
    }
    expect(fillGrassTile(0, 0, s, 20, null).length).toBe(0);
    expect(Array.from(fillGrassTile(1, 0, s, 0, null))).not.toEqual(Array.from(a));
  });
});

describe('presets and budgets', () => {
  it('LOD bands are ordered for every level', () => {
    for (const l of QUALITY_LEVELS) {
      const b = vegetationBands(QUALITY_PRESETS[l]);
      expect(b.lod0).toBeLessThanOrEqual(80);
      expect(b.lod0).toBeLessThan(b.near);
      expect(b.near).toBeLessThan(b.far);
      expect(b.smallFar).toBeLessThanOrEqual(350);
    }
    // 6 LOD0 + 2 LOD1 + impostors + shrubs + 2 rocks + grass.
    expect(13).toBeLessThanOrEqual(VEG_DRAW_BUDGET);
  });
});

describe('shader patches compose with three r185 chunks', () => {
  const run = (patch: ReturnType<typeof vegPatch>, lib: 'standard' | 'depth', target: 'color' | 'depth'): WebGLProgramParametersWithUniforms => {
    const shader = {
      vertexShader: ShaderLib[lib].vertexShader,
      fragmentShader: ShaderLib[lib].fragmentShader,
      uniforms: {},
    } as unknown as WebGLProgramParametersWithUniforms;
    patch.apply(shader, target, null as never);
    return shader;
  };
  it('vegetation patch rewrites begin_vertex (color + depth), fade, normals', () => {
    const u = createVegUniforms();
    for (const kind of ['tree', 'shrub', 'rock'] as const) {
      const p = vegPatch({ kind, variantSelect: kind === 'shrub', fade: { value: new Vector4() }, bend: 0.4, sizeCull: kind === 'rock' ? 200 : undefined }, u);
      const c = run(p, 'standard', 'color');
      expect(c.vertexShader).not.toContain('#include <begin_vertex>');
      expect(c.vertexShader).toContain('attribute vec4 iA;');
      expect(c.vertexShader).toContain('transformedNormal = normalize(normalMatrix * vegN)');
      expect(c.fragmentShader).toContain('vegDither()');
      if (kind === 'rock') expect(c.fragmentShader).not.toContain('#include <map_fragment>');
      else expect(c.fragmentShader).not.toContain('#include <normal_fragment_begin>');
      const d = run(p, 'depth', 'depth');
      expect(d.vertexShader).not.toContain('#include <begin_vertex>');
      expect(d.vertexShader).toContain('vegGust');
      expect(c.uniforms.uVegWind).toBe(u.uVegWind);
    }
  });
  it('impostor patch replaces the map, normal and billboard chunks', () => {
    const atlas: ImpostorAtlas = {
      albedo: {} as Texture,
      normal: {} as Texture,
      frames: 8,
      cols: 3,
      rows: 2,
      bounds: Array.from({ length: 6 }, () => ({ centerY: 8, radius: 9 })),
      ms: 0,
      dispose() {},
    };
    const p = impostorPatch(atlas, createVegUniforms(), { value: new Vector4() });
    const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
    p.apply(shader, 'color', null as never);
    for (const chunk of ['begin_vertex', 'map_fragment', 'normal_fragment_begin']) {
      expect(shader.vertexShader + shader.fragmentShader).not.toContain(`#include <${chunk}>`);
    }
    expect(shader.vertexShader).toContain('uniform vec4 uImpVar[6];');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance +=');
  });
});
