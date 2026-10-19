import { MeshPhysicalMaterial, ShaderChunk, ShaderLib, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';

import { createVehicleTelemetryFrame } from '../../protocol/telemetry';
import { patchMaterial } from '../material';
import { QUALITY_PRESETS, type RenderContext, type ShaderPatch } from '../types';
import {
  createLightState,
  createVehicleMaterials,
  debugLampLevels,
  lightStateFromTelemetry,
  MATERIAL_SLOTS,
  PAINT_NAMES,
  PAINT_PALETTE,
  privacySplitZ,
  slotBox,
} from './materials';
import type { MaterialSlot, PanelDef, VehicleVisualDef } from './types';

const ctx = (level: 'high' | 'ultra' = 'high'): RenderContext => ({ quality: QUALITY_PRESETS[level] }) as unknown as RenderContext;

const quad = (x0: number, x1: number, y0: number, y1: number, z: number) => ({
  type: 'mesh' as const,
  position: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
  index: [0, 1, 2, 0, 2, 3],
});
const panel = (id: string, material: MaterialSlot, surface: PanelDef['surface']): PanelDef => ({
  id,
  kind: material === 'glass' ? 'glass' : 'light',
  material,
  surface,
  bind: ['*'],
  detach: null,
});
const DEF: VehicleVisualDef = {
  vehicle: 'test',
  paint: PAINT_PALETTE.midnightBlue,
  wheels: {
    rim: { style: 'spoke', spokes: 5, spokeWidth: 0.3, dish: 0.03, lip: 0.012, finish: 'gunmetal', boltCount: 5 },
    tire: { tread: 'street', sidewallText: null, bulge: 0.1 },
    brake: { discRadius: 0.15, caliperColor: 0xcc1111 },
  },
  panels: [
    panel('headR', 'lightHead', quad(0.4, 0.8, 0.6, 0.75, -2.2)),
    panel('headL', 'lightHead', quad(-0.8, -0.4, 0.6, 0.75, -2.2)),
    panel('tailR', 'lightTail', quad(0.45, 0.8, 0.7, 0.8, 2.2)),
    panel('screen', 'glass', quad(-0.7, 0.7, 0.9, 1.2, -0.8)),
    panel('rear', 'glass', quad(-0.6, 0.6, 0.9, 1.15, 1.2)),
    {
      id: 'loftLamp',
      kind: 'light',
      material: 'lightReverse',
      surface: {
        type: 'loft',
        resolution: 0.05,
        sections: [
          [
            [0.1, 0.7, 2.1],
            [0.2, 0.7, 2.1],
            [0.9, 0.7, 2.1],
          ],
          [
            [0.1, 0.8, 2.2],
            [0.2, 0.8, 2.2],
            [0.9, 0.8, 2.2],
          ],
        ],
        window: { u0: 0, u1: 0.5, v0: 0, v1: 1 },
      },
      bind: ['*'],
      detach: null,
    },
  ],
};

function physicalShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
  } as unknown as WebGLProgramParametersWithUniforms;
}

describe('palette', () => {
  it('has 8 valid factory colours', () => {
    expect(PAINT_NAMES).toHaveLength(8);
    for (const n of PAINT_NAMES) {
      const p = PAINT_PALETTE[n];
      for (const v of [p.metallic, p.roughness, p.clearcoat, p.clearcoatRoughness]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(p.color).toBeGreaterThanOrEqual(0);
      expect(p.color).toBeLessThanOrEqual(0xffffff);
    }
  });
});

describe('rest-space extents', () => {
  it('slotBox mirrors |x|; loft windows clip control points', () => {
    const b = slotBox(DEF, 'lightHead')!;
    expect(b.min.x).toBeCloseTo(0.4);
    expect(b.max.x).toBeCloseTo(0.8);
    expect(b.min.y).toBeCloseTo(0.6);
    const r = slotBox(DEF, 'lightReverse')!;
    expect(r.max.x).toBeCloseTo(0.2); // u ≤ 0.5 → the first two of three points
    expect(slotBox(DEF, 'lightIndicator')).toBeNull();
  });
  it('privacy split lies between the front-most and rear-most glass', () => {
    const z = privacySplitZ(DEF);
    expect(z).toBeGreaterThan(-0.8);
    expect(z).toBeLessThan(1.2);
    expect(privacySplitZ({ ...DEF, panels: [] })).toBe(Infinity);
  });
});

describe('createVehicleMaterials', () => {
  it('returns a base material for every slot', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    for (const s of MATERIAL_SLOTS) expect(set.base(s).isMaterial).toBe(true);
    expect(() => set.base('nope' as MaterialSlot)).toThrow();
    set.dispose();
  });

  it('hooks compile against three r185 physical sources (no chunk drift)', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    for (const s of ['paint', 'glass', 'lightHead', 'lightTail', 'lightReverse', 'lightIndicator'] as const) {
      const m = set.base(s);
      expect(Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')).toBe(true);
      const sh = physicalShader();
      m.onBeforeCompile(sh, null as never);
      expect(sh.vertexShader).toContain('vCrRest = position;');
      expect(sh.fragmentShader).toContain('varying vec3 vCrRest;');
    }
    const paint = physicalShader();
    set.base('paint').onBeforeCompile(paint, null as never);
    expect(paint.fragmentShader).toContain('crGlintN');
    expect(paint.fragmentShader).not.toContain('#include <lights_physical_pars_fragment>');
    expect(paint.uniforms.uCrFlake).toBeDefined();
    expect(ShaderChunk.lights_physical_pars_fragment).toContain('reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter');
    const glass = physicalShader();
    set.base('glass').onBeforeCompile(glass, null as never);
    expect(glass.fragmentShader).toContain('crTrans');
    const head = physicalShader();
    set.base('lightHead').onBeforeCompile(head, null as never);
    expect(head.fragmentShader.startsWith('#define CR_LAMP 1')).toBe(true);
    set.dispose();
  });

  it('grille: fine-detail fade compiles against r185 chunks; anisotropy follows the renderer max and the quality cap', () => {
    const r = (max: number) => ({ capabilities: { getMaxAnisotropy: () => max } });
    const set = createVehicleMaterials({ ...ctx('high'), renderer: r(16) } as unknown as RenderContext, DEF);
    const g = set.base('grille') as MeshPhysicalMaterial;
    const sh = physicalShader();
    g.onBeforeCompile(sh, null as never);
    expect(sh.fragmentShader).toContain('float crFineFade( vec2 uv )');
    expect(sh.fragmentShader).toContain('mapN.xy *= normalScale * crFine;');
    expect(sh.fragmentShader).toContain('crFineFade( vMapUv )');
    expect(sh.fragmentShader).not.toContain('#include <normal_fragment_maps>');
    expect(g.normalMap!.anisotropy).toBe(16);
    expect(g.normalMap!.generateMipmaps).toBe(true);
    set.dispose();
    const low = createVehicleMaterials({ ...ctx(), quality: QUALITY_PRESETS.low, renderer: r(16) } as unknown as RenderContext, DEF);
    expect((low.base('grille') as MeshPhysicalMaterial).map!.anisotropy).toBe(4);
    low.dispose();
    const weak = createVehicleMaterials({ ...ctx('high'), renderer: r(2) } as unknown as RenderContext, DEF);
    expect((weak.base('trim') as MeshPhysicalMaterial).normalMap!.anisotropy).toBe(2);
    weak.dispose();
  });

  it('distinct program keys per hooked slot', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    const keys = (['paint', 'glass', 'lightHead', 'lightTail', 'lightReverse', 'lightIndicator'] as const).map((s) => set.base(s).customProgramCacheKey());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('clones keep the hook + key, and setPaint reaches them', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    const base = set.base('paint') as MeshPhysicalMaterial;
    const clone = base.clone();
    expect(clone.onBeforeCompile).toBe(base.onBeforeCompile);
    expect(clone.customProgramCacheKey()).toBe(base.customProgramCacheKey());
    const clone2 = clone.clone();
    set.setPaint(PAINT_PALETTE.crimsonCandy);
    for (const m of [base, clone, clone2]) {
      expect(m.color.getHex()).toBe(PAINT_PALETTE.crimsonCandy.color);
      expect(m.metalness).toBe(PAINT_PALETTE.crimsonCandy.metallic);
    }
    set.setPaint(PAINT_PALETTE.graphite);
    expect(clone2.color.getHex()).toBe(PAINT_PALETTE.graphite.color);
    expect(clone2.normalScale.x).toBe(0); // solid paint: no flake normal
    set.dispose();
  });

  it('setLights drives the shared lamp uniforms of every clone', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    const tailClone = set.base('lightTail').clone();
    const s = createLightState();
    s.brake = 1;
    s.head = true;
    s.indicatorR = true;
    set.setLights(s);
    const sh = physicalShader();
    tailClone.onBeforeCompile(sh, null as never);
    const u = sh.uniforms.uCrLamp as { value: { x: number; y: number } };
    expect(u.value.y).toBe(1);
    expect(u.value.x).toBe(1);
    expect(debugLampLevels(set, 'lightIndicator')!.y).toBe(1);
    expect(debugLampLevels(set, 'lightHead')!.x).toBe(1); // DRL
    s.brake = 0;
    s.head = false;
    set.setLights(s);
    expect(u.value.y).toBe(0);
    set.dispose();
  });

  it('composes with patchMaterial: own hook first, flexbody patch after, keys concatenated', () => {
    const set = createVehicleMaterials(ctx(), DEF);
    const calls: string[] = [];
    const flex: ShaderPatch = {
      key: 'flexTest',
      targets: ['color', 'depth', 'distance'],
      apply(shader) {
        calls.push(shader.fragmentShader.includes('crGlintN') ? 'flex-after-paint' : 'flex-before-paint');
      },
    };
    const m = set.base('paint').clone();
    const patched = patchMaterial(m, { flexbody: flex });
    expect(patched.depth).not.toBeNull();
    expect(m.customProgramCacheKey()).toContain('crPaint1');
    expect(m.customProgramCacheKey()).toContain('flexTest');
    m.onBeforeCompile(physicalShader(), null as never);
    expect(calls).toEqual(['flex-after-paint']);
    set.dispose();
  });

  it('glass: transmission on ultra, premultiplied fresnel glass otherwise', () => {
    const hi = createVehicleMaterials(ctx('high'), DEF).base('glass') as MeshPhysicalMaterial;
    expect(hi.transmission).toBe(0);
    expect(hi.transparent).toBe(true);
    expect(hi.premultipliedAlpha).toBe(true);
    const ul = createVehicleMaterials(ctx('ultra'), DEF).base('glass') as MeshPhysicalMaterial;
    expect(ul.transmission).toBe(1);
    expect(ul.customProgramCacheKey()).not.toBe(hi.customProgramCacheKey());
  });
});

describe('lightStateFromTelemetry', () => {
  it('maps brake pedal and reverse gear; passes game lamps through', () => {
    const t = createVehicleTelemetryFrame();
    const s = createLightState();
    lightStateFromTelemetry(t, s, { head: true });
    expect(s).toMatchObject({ head: true, brake: 0, reverse: false });
    t.brake = 0.5;
    t.gear = -1;
    lightStateFromTelemetry(t, s);
    expect(s.brake).toBeGreaterThan(0.5);
    expect(s.reverse).toBe(true);
    expect(s.head).toBe(false);
    lightStateFromTelemetry(null, s);
    expect(s.brake).toBe(0);
  });
});
