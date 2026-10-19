import { ShaderLib, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';

import { createRng } from '../../core/rng';

const mulberry32 = (seed: number): (() => number) => {
  const r = createRng(seed);
  return () => r.float();
};
import { QUALITY_PRESETS, type RenderContext } from '../types';
import { SEDAN_VISUAL } from './defs/sedan';
import { createVehicleMaterials, materialFinish, MATERIAL_SLOTS } from './materials';
import type { PanelDef, VehicleVisualDef } from './types';
import {
  applyWeatherGlsl,
  buildFinishData,
  createFinishTexture,
  createWeatherUniforms,
  FINISH_ALWAYS,
  FINISH_NEVER,
  FINISH_TEX_WIDTH,
  finishMasks,
  finishRow,
  finishThreshold,
  peelField,
  primerField,
  rustField,
  setFinishExtras,
  SEVEN_SEGMENT,
  WEATHER_KEY,
} from './weathering';

const ctx = { quality: QUALITY_PRESETS.high } as unknown as RenderContext;

function physical(): WebGLProgramParametersWithUniforms {
  return { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader } as unknown as WebGLProgramParametersWithUniforms;
}

/** A flat door-like side panel at x = 0.85, y 0.2..1.0, z −1..0 (rest metres). */
const door = (finish: PanelDef['finish'], id = 'door'): PanelDef => ({
  id,
  kind: 'door',
  material: 'paint',
  surface: { type: 'mesh', position: [0.85, 0.2, -1, 0.85, 0.2, 0, 0.85, 1, 0, 0.85, 1, -1], index: [0, 1, 2, 0, 2, 3] },
  bind: ['*'],
  detach: null,
  ...(finish ? { finish } : {}),
});
const lens = (finish: PanelDef['finish']): PanelDef => ({
  id: 'headR',
  kind: 'light',
  material: 'lightHead',
  surface: { type: 'mesh', position: [0.5, 0.6, -2, 0.8, 0.6, -2, 0.8, 0.75, -2, 0.5, 0.75, -2], index: [0, 1, 2, 0, 2, 3] },
  bind: ['*'],
  detach: null,
  ...(finish ? { finish } : {}),
});
const defWith = (panels: PanelDef[]): VehicleVisualDef => ({ ...SEDAN_VISUAL, vehicle: 'test', panels });

/** Fraction of seeded-random points of the panel where `pick` is set. */
function coverage(p: PanelDef, pick: (m: ReturnType<typeof finishMasks>) => number, yLo = 0.2, yHi = 1, n = 4000): number {
  const row = finishRow(p);
  const rnd = mulberry32(1234);
  let on = 0;
  for (let i = 0; i < n; i++) {
    const y = yLo + (yHi - yLo) * rnd();
    on += pick(finishMasks(row, 0.85, y, -rnd(), []));
  }
  return on / n;
}

describe('panel finish: threshold calibration (CPU mirror)', () => {
  it('thresholds are monotone and saturate at 0 / 1', () => {
    for (const k of ['primer', 'peel', 'rust'] as const) {
      expect(finishThreshold(k, 0)).toBe(FINISH_NEVER);
      expect(finishThreshold(k, 1)).toBe(FINISH_ALWAYS);
      let prev = Infinity;
      for (const a of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
        const t = finishThreshold(k, a);
        expect(t).toBeLessThan(prev);
        prev = t;
      }
    }
  });

  it('primer / peel amounts are area coverage (±0.06) at fresh random points', () => {
    const rnd = mulberry32(99);
    for (const [k, field] of [
      ['primer', primerField],
      ['peel', peelField],
    ] as const) {
      for (const a of [0.15, 0.35, 0.6]) {
        const t = finishThreshold(k, a);
        let on = 0;
        const N = 5000;
        for (let i = 0; i < N; i++) on += field(4 * rnd() - 2, 1.5 * rnd(), 2 * rnd() - 1) >= t ? 1 : 0;
        expect(Math.abs(on / N - a), `${k} ${a}`).toBeLessThan(0.06);
      }
    }
  });

  it('rust grows from the panel lower edge; holes are the deepest rust', () => {
    const p = door({ rust: 0.3, holes: 0.5 });
    const all = coverage(p, (m) => m.rust);
    const low = coverage(p, (m) => m.rust, 0.2, 0.4);
    const high = coverage(p, (m) => m.rust, 0.6, 1);
    expect(all).toBeGreaterThan(0.12);
    expect(all).toBeLessThan(0.5);
    expect(low).toBeGreaterThan(2 * high);
    const holes = coverage(p, (m) => m.hole);
    const holeOutsideRust = coverage(p, (m) => (m.hole && !m.rust ? 1 : 0));
    expect(holes).toBeGreaterThan(0);
    expect(holes).toBeLessThan(all * 0.5);
    expect(holeOutsideRust).toBe(0);
    expect(coverage(door({ rust: 0.3 }), (m) => m.hole)).toBe(0);
  });

  it('arch lips rust: points on the lip of a registered arch are rustier than the panel middle', () => {
    const row = finishRow(door({ rust: 0.25 }));
    const arch = [{ z: -0.5, y: 0.3, r: 0.38, xMin: 0.6 }];
    const rnd = mulberry32(7);
    let lip = 0;
    let mid = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const a = Math.PI * (0.15 + 0.7 * rnd());
      lip += finishMasks(row, 0.85, 0.3 + 0.38 * Math.sin(a), -0.5 + 0.38 * Math.cos(a), arch).rust;
      mid += finishMasks(row, 0.85, 0.75 + 0.2 * rnd(), -0.5 + 0.4 * (rnd() - 0.5), arch).rust;
    }
    expect(lip / N).toBeGreaterThan(2 * (mid / N) + 0.1);
    expect(rustField(0, 0, 0, 1)).toBeGreaterThan(rustField(0, 0, 0, 0));
  });

  it('dirt sits low; fade is stronger on top surfaces', () => {
    const row = finishRow(door({ dirt: 0.8, fade: 0.8 }));
    const lo = finishMasks(row, 0.85, 0.2, -0.5);
    const hi = finishMasks(row, 0.85, 1.0, -0.5);
    expect(lo.dirt).toBeGreaterThan(hi.dirt + 0.2);
    const roof = finishMasks(row, 0.0, 1.4, 0.2);
    expect(roof.fade).toBeGreaterThan(finishMasks(row, 0.85, 0.3, 0.2).fade);
  });
});

describe('panel finish: data texture', () => {
  it('pristine defs produce no finished rows; finished rows carry colour (linear), thresholds, number and extents', () => {
    expect(buildFinishData(SEDAN_VISUAL).finished).toBe(0);
    const def = defWith([
      door(undefined, 'clean'),
      door({ color: 0xffffff, solid: true, primer: 1, number: { text: '7', center: [0, 0.6, -0.5], height: 0.4, color: 0xffffff, axis: 'x', background: 0x101010 } }, 'num'),
      lens({ crack: 0.8 }),
    ]);
    const fd = buildFinishData(def);
    expect(fd.finished).toBe(2);
    expect([...fd.slots].sort()).toEqual(['lightHead', 'paint']);
    expect(fd.rows).toBe(3);
    expect(fd.data.length).toBe(3 * FINISH_TEX_WIDTH * 4);
    const W = FINISH_TEX_WIDTH * 4;
    // clean row: never-thresholds, skip flag 0
    expect(fd.data[4 + 2]).toBe(FINISH_NEVER);
    expect(fd.data[12 + 3]).toBe(0);
    // numbered row
    expect(fd.data[W + 0]).toBeCloseTo(1);
    expect(fd.data[W + 3]).toBe(1);
    expect(fd.data[W + 4]).toBe(1); // solid
    expect(fd.data[W + 6]).toBe(FINISH_ALWAYS); // primer everywhere
    expect(fd.data[W + 12 + 3]).toBe(1); // finished flag
    expect(fd.data[W + 16 + 3]).toBeCloseTo(0.4); // digit height
    expect(fd.data[W + 24]).toBe(SEVEN_SEGMENT['7']);
    expect(fd.data[W + 24 + 3]).toBe(1);
    expect(fd.data[W + 32 + 3]).toBe(1); // background on
    expect(fd.data[W + 32]).toBeLessThan(0.01); // 0x10 sRGB → linear
    // lens row: crack + centre
    expect(fd.data[2 * W + 8 + 3]).toBeCloseTo(0.8);
    expect(fd.data[2 * W + 28 + 2]).toBeCloseTo(-2);
    const tex = createFinishTexture(fd);
    expect(tex.image.width).toBe(FINISH_TEX_WIDTH);
    expect(tex.image.height).toBe(3);
    tex.dispose();
  });

  it('seven-segment table covers every digit', () => {
    for (let d = 0; d <= 9; d++) expect(SEVEN_SEGMENT[String(d)]).toBeGreaterThan(0);
    expect(SEVEN_SEGMENT['8']).toBe(127);
  });
});

describe('panel finish: materials', () => {
  it('existing vehicles compile exactly as before (no weathering hook, same keys)', () => {
    const set = createVehicleMaterials(ctx, SEDAN_VISUAL);
    expect(materialFinish(set)).toBeNull();
    for (const s of MATERIAL_SLOTS) {
      expect(set.base(s).customProgramCacheKey()).not.toContain(WEATHER_KEY);
      const sh = physical();
      set.base(s).onBeforeCompile(sh, null as never);
      expect(sh.fragmentShader).not.toContain('crWx');
    }
    set.dispose();
  });

  it('a finished def hooks only its finished slots, gates flake glint / pearl, and shares one texture', () => {
    const def = defWith([door({ rust: 0.4, solid: true }), door(undefined, 'clean'), lens({ crack: 0.5 })]);
    setFinishExtras(def, { arches: [{ z: -1.3, y: 0.3, r: 0.38, xMin: 0.6 }] });
    const set = createVehicleMaterials(ctx, def);
    const fin = materialFinish(set);
    expect(fin).not.toBeNull();
    expect(set.base('paint').customProgramCacheKey()).toBe(`crPaint1|clamp1|${WEATHER_KEY}`);
    expect(set.base('lightHead').customProgramCacheKey()).toContain(WEATHER_KEY);
    expect(set.base('trim').customProgramCacheKey()).not.toContain(WEATHER_KEY);
    const sh = physical();
    set.base('paint').clone().onBeforeCompile(sh, null as never);
    expect(sh.fragmentShader).toContain('crGlintW = crWxFlake * crOn * uCrFlake.w');
    expect(sh.fragmentShader).toContain('uCrPearl.a * crWxPearl * crGraze');
    expect(sh.fragmentShader.indexOf('float crWxH = 0.0;')).toBeLessThan(sh.fragmentShader.indexOf('#include <normal_fragment_begin>'));
    expect(sh.fragmentShader.indexOf('crWxBump( - vViewPosition')).toBeLessThan(sh.fragmentShader.indexOf('#include <clearcoat_normal_fragment_begin>'));
    expect((sh.uniforms.uCrWxFinish as { value: unknown }).value).toBe(fin!.texture);
    const arch = (sh.uniforms.uCrWxArch as { value: { x: number; z: number }[] }).value;
    expect(arch[0]!.x).toBeCloseTo(-1.3);
    expect(arch[1]!.z).toBe(0);
    set.dispose();
  });

  it('the hook applies to a bare physical program and throws on chunk drift', () => {
    const fd = buildFinishData(defWith([door({ dirt: 0.5 })]));
    const u = createWeatherUniforms(createFinishTexture(fd), []);
    const sh = physical();
    applyWeatherGlsl(sh, u);
    expect(sh.fragmentShader).toContain('uniform highp sampler2D uCrWxFinish;');
    expect(sh.fragmentShader).toContain('material.clearcoat *= crWxCoat;');
    expect(() => applyWeatherGlsl({ uniforms: {}, vertexShader: '', fragmentShader: 'void main() {}' } as never, u)).toThrow(/chunk drift/);
  });
});
