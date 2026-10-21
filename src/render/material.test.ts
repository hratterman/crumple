import { describe, expect, it } from 'vitest';
import { Material, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

import { isPatched, PATCH_INFO, patchMaterial } from './material';
import './lighting/envPatch'; // registers the env patch injector (the lazily loaded lighting chunk does it in the app)
import type { PatchInfo } from './material';
import type { PatchTarget, ShaderPatch } from './types';

const renderer = {} as WebGLRenderer;

function freshShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n#include <beginnormal_vertex>',
    fragmentShader: '#include <lights_fragment_end>',
  } as unknown as WebGLProgramParametersWithUniforms;
}

function makeCsm(cascades = 3): CSM {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  return new CSM({ camera, parent: new Scene(), cascades, maxFar: 300, lightDirection: new Vector3(-1, -1, -1).normalize() });
}

function recorder(name: string, targets: readonly PatchTarget[], log: string[], inspect?: (s: WebGLProgramParametersWithUniforms) => void): ShaderPatch {
  return {
    key: `${name}-v1`,
    targets,
    apply(shader, target) {
      inspect?.(shader);
      log.push(`${name}@${target}`);
      shader.uniforms[`u_${name}`] = { value: 1 };
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n// ${name}`);
    },
  };
}

function run(material: Material, shader = freshShader()): WebGLProgramParametersWithUniforms {
  material.onBeforeCompile(shader, renderer);
  return shader;
}

describe('patchMaterial', () => {
  it('without features returns the material and null shadow twins', () => {
    const m = new MeshStandardMaterial();
    const set = patchMaterial(m, {});
    expect(set.color).toBe(m);
    expect(set.depth).toBeNull();
    expect(set.distance).toBeNull();
    expect(isPatched(m)).toBe(true);
  });

  it('throws when the same material is patched twice', () => {
    const m = new MeshStandardMaterial();
    patchMaterial(m, {});
    expect(() => patchMaterial(m, {})).toThrow(/already patched/);
    // a clone is a fresh material
    expect(() => patchMaterial(m.clone(), {})).not.toThrow();
  });

  it("preserves CSM's onBeforeCompile (uniform hook + shader registration)", () => {
    const csm = makeCsm(3);
    const m = new MeshStandardMaterial();
    patchMaterial(m, { csm });
    expect(m.defines?.USE_CSM).toBe(1);
    expect(m.defines?.CSM_CASCADES).toBe(3);
    const shader = run(m);
    expect(shader.uniforms.CSM_cascades).toBeDefined();
    expect((shader.uniforms.CSM_cascades!.value as unknown[]).length).toBe(3);
    expect(shader.uniforms.shadowFar).toBeDefined();
    expect(shader.uniforms.cameraNear).toBeDefined();
    // CSM keeps a handle on the compiled shader to refresh uniforms each frame
    expect(csm.shaders.get(m)).toBe(shader);
  });

  it('composes in PATCH_ORDER (csm → flexbody → damage) regardless of object key order', () => {
    const csm = makeCsm(4);
    const log: string[] = [];
    const flex = recorder('flexbody', ['color', 'depth', 'distance'], log, (s) => {
      // CSM's hook must already have run when flexbody applies
      expect(s.uniforms.CSM_cascades).toBeDefined();
    });
    const damage = recorder('damage', ['color'], log, (s) => {
      expect(s.uniforms.u_flexbody).toBeDefined();
    });
    const m = new MeshStandardMaterial();
    const set = patchMaterial(m, { damage, flexbody: flex, csm });
    run(set.color);
    expect(log).toEqual(['flexbody@color', 'damage@color']);
    // R-GFX: world-lit (csm) materials also get the environment patch, last
    expect((m as unknown as Record<symbol, PatchInfo>)[PATCH_INFO]!.features).toEqual(['csm', 'flexbody', 'damage', 'env']);
    expect(m.customProgramCacheKey()).toMatch(/csm4f?\|flexbody:flexbody-v1\|damage:damage-v1\|env:env\d+$/);
  });

  it('adds the env patch only with a csm, and env: false opts out', () => {
    const withCommon = (): WebGLProgramParametersWithUniforms => {
      const s = freshShader();
      s.fragmentShader = `#include <common>\n${s.fragmentShader}`;
      return s;
    };
    const a = new MeshStandardMaterial();
    patchMaterial(a, { csm: makeCsm() });
    const sa = run(a, withCommon());
    expect(sa.fragmentShader).toContain('#define CRUMPLE_ENV');
    expect(sa.uniforms.crumpleHazeSH).toBeDefined();
    expect(sa.uniforms.crumpleLightGrid).toBeDefined();
    const b = new MeshStandardMaterial();
    patchMaterial(b, { csm: makeCsm(), env: false });
    expect(run(b, withCommon()).fragmentShader).not.toContain('CRUMPLE_ENV');
    const c = new MeshStandardMaterial();
    patchMaterial(c, { damage: recorder('damage', ['color'], []) });
    expect(run(c, withCommon()).fragmentShader).not.toContain('CRUMPLE_ENV');
    // shared uniform objects: one write reaches every program
    const d = new MeshStandardMaterial();
    patchMaterial(d, { csm: makeCsm() });
    expect(run(d, withCommon()).uniforms.crumpleSunDir).toBe(sa.uniforms.crumpleSunDir);
    // a shader without <common> is left alone (no undeclared uniforms behind the define)
    expect(run(new MeshStandardMaterial(), freshShader()).fragmentShader).not.toContain('CRUMPLE_ENV');
  });

  it('applies depth/distance-targeting features to the shadow twins only for their targets', () => {
    const log: string[] = [];
    const flex = recorder('flexbody', ['color', 'depth', 'distance'], log);
    const damage = recorder('damage', ['color'], log);
    const set = patchMaterial(new MeshStandardMaterial(), { flexbody: flex, damage, csm: makeCsm() });
    expect(set.depth).not.toBeNull();
    expect(set.distance).not.toBeNull();
    log.length = 0;
    const ds = run(set.depth!);
    expect(log).toEqual(['flexbody@depth']);
    expect(ds.uniforms.CSM_cascades).toBeUndefined(); // CSM never touches depth
    log.length = 0;
    run(set.distance!);
    expect(log).toEqual(['flexbody@distance']);
    expect(set.depth!.customProgramCacheKey()).toBe('depth|flexbody-v1');
    expect(set.distance!.customProgramCacheKey()).toBe('distance|flexbody-v1');
  });

  it('a color-only feature leaves shadow twins null (three defaults are correct)', () => {
    const set = patchMaterial(new MeshStandardMaterial(), { damage: recorder('damage', ['color'], []) });
    expect(set.depth).toBeNull();
    expect(set.distance).toBeNull();
  });

  it('the composed hook is idempotent per compile (same output for every fresh shader)', () => {
    const log: string[] = [];
    const m = new MeshStandardMaterial();
    patchMaterial(m, { csm: makeCsm(), flexbody: recorder('flexbody', ['color', 'depth'], log), damage: recorder('damage', ['color'], log) });
    const a = run(m);
    const b = run(m);
    expect(b.vertexShader).toBe(a.vertexShader);
    expect(b.fragmentShader).toBe(a.fragmentShader);
    expect(Object.keys(b.uniforms).sort()).toEqual(Object.keys(a.uniforms).sort());
    expect(a.vertexShader.match(/\/\/ flexbody/g)!.length).toBe(1);
    expect(m.customProgramCacheKey()).toBe(m.customProgramCacheKey());
  });

  it("keeps the material's own pre-existing hook and cache key alongside CSM's", () => {
    const m = new MeshStandardMaterial();
    let ownRan = 0;
    m.onBeforeCompile = (shader) => {
      ownRan++;
      shader.uniforms.uSplat = { value: null };
    };
    m.customProgramCacheKey = () => 'terrain-splat-v2';
    patchMaterial(m, { csm: makeCsm() });
    const s = run(m);
    expect(ownRan).toBe(1);
    expect(s.uniforms.uSplat).toBeDefined();
    expect(s.uniforms.CSM_cascades).toBeDefined();
    expect(m.customProgramCacheKey().startsWith('terrain-splat-v2|csm')).toBe(true);
  });

  it('distinct feature sets produce distinct program cache keys', () => {
    const a = new MeshStandardMaterial();
    const b = new MeshStandardMaterial();
    const c = new MeshStandardMaterial();
    patchMaterial(a, {});
    patchMaterial(b, { csm: makeCsm(3) });
    patchMaterial(c, { csm: makeCsm(3), damage: recorder('damage', ['color'], []) });
    const keys = new Set([a.customProgramCacheKey(), b.customProgramCacheKey(), c.customProgramCacheKey()]);
    expect(keys.size).toBe(3);
  });

  it('sets needsUpdate (bumps the material version)', () => {
    const m = new MeshStandardMaterial();
    const v = m.version;
    patchMaterial(m, {});
    expect(m.version).toBeGreaterThan(v);
  });
});
