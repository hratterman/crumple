import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, PerspectiveCamera, ShaderLib, Vector3, Vector4 } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

import { syntheticTerrain } from '../../world/sampler.testkit';
import { WATER_OPTICS_DEFAULTS } from '../../world/types';
import type { WaterBody } from '../../world/types';
import { waterField } from '../../world/water';
import type { SimObjectSlice, WorldFrame } from '../types';
import { createWaterMaterial, createWaterUniforms } from './material';
import { buildReflectionProxy, WATER_REFLECTION_LAYER } from './proxy';
import { PlanarReflection } from './reflection';
import { MAX_CONTACTS, MAX_RIPPLES, WaterInteraction } from './ripples';
import { buildSurfaceGeometry, selectSurfaceCells } from './surface';
import { WATER_MAX_RADIANCE } from './types';
import { buildNoiseTexture, buildWaveTexture } from './waves';

// Bowl lake: level 0, 6 m deep, rim r = 20 m; dry land (+2 m) around it.
const terrain = syntheticTerrain({
  cols: 81,
  rows: 81,
  height: (x, z) => {
    const r = Math.sqrt(x * x + z * z);
    return r < 20 ? -6 * (1 - (r * r) / 400) : 2;
  },
});
const body: WaterBody = {
  id: 'lake',
  name: 'Lake',
  level: 0,
  minX: -22,
  maxX: 22,
  minZ: -22,
  maxZ: 22,
  maxDepth: 6,
  samples: 0,
  optics: WATER_OPTICS_DEFAULTS,
};

describe('wave textures', () => {
  const w = buildWaveTexture(64);
  it('encodes two slope spectra around 0.5 with positive decode scales', () => {
    expect(w.data.length).toBe(64 * 64 * 4);
    expect(w.scaleA).toBeGreaterThan(0);
    expect(w.scaleB).toBeGreaterThan(0);
    for (let ch = 0; ch < 4; ch++) {
      let sum = 0;
      for (let i = ch; i < w.data.length; i += 4) sum += w.data[i]!;
      expect(sum / (64 * 64)).toBeGreaterThan(115);
      expect(sum / (64 * 64)).toBeLessThan(140);
    }
  });

  it('tiles seamlessly (wrap-around steps are like interior steps)', () => {
    const at = (c: number, r: number, ch: number) => w.data[(r * 64 + c) * 4 + ch]!;
    let wrap = 0;
    let interior = 0;
    for (let r = 0; r < 64; r++) {
      for (let ch = 0; ch < 4; ch++) {
        wrap += Math.abs(at(63, r, ch) - at(0, r, ch));
        interior += Math.abs(at(31, r, ch) - at(32, r, ch));
      }
    }
    expect(wrap).toBeLessThan(interior * 1.6 + 64);
  });

  it('is deterministic', () => {
    expect(buildWaveTexture(32).data).toEqual(buildWaveTexture(32).data);
    const n = buildNoiseTexture(32);
    expect(n).toEqual(buildNoiseTexture(32));
    expect(Math.min(...n)).toBe(0);
    expect(Math.max(...n)).toBe(255);
  });
});

describe('surface mesh', () => {
  const field = waterField(terrain, body);
  const cells = selectSurfaceCells(field, 4);

  it('covers every flooded sample and skips cells far out on dry land', () => {
    for (let r = 0; r < field.rows; r++) {
      for (let c = 0; c < field.cols; c++) {
        if (!field.mask[r * field.cols + c]) continue;
        const x = field.originX + c * field.spacing;
        const z = field.originZ + r * field.spacing;
        const i = Math.min(cells.nx - 1, Math.floor((x - cells.originX) / cells.cell));
        const j = Math.min(cells.nz - 1, Math.floor((z - cells.originZ) / cells.cell));
        expect(cells.keep[j * cells.nx + i]).toBe(1);
      }
    }
    // a corner cell of the rect is all dry land (r ≈ 28 m > 20 m rim)
    expect(cells.keep[0]).toBe(0);
    expect(cells.kept).toBeLessThan(cells.nx * cells.nz);
  });

  it('builds flat up-facing geometry at the level', () => {
    const g = buildSurfaceGeometry(cells, 0.5);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBe(0.5);
    expect(g.getIndex()!.count).toBe(cells.kept * 6);
    // CCW from above: the first triangle's normal points up
    const idx = g.getIndex()!;
    const a = new Vector3().fromBufferAttribute(p, idx.getX(0));
    const b = new Vector3().fromBufferAttribute(p, idx.getX(1));
    const c = new Vector3().fromBufferAttribute(p, idx.getX(2));
    expect(b.sub(a).cross(c.sub(a)).y).toBeGreaterThan(0);
  });
});

describe('planar reflection placement', () => {
  it('maps points on the plane to the main camera uv, mirrored in x (the mirrored camera sees them that way)', () => {
    const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 3000);
    cam.position.set(3, 7.5, 40);
    cam.lookAt(-10, 1, -30);
    cam.updateMatrixWorld();
    const refl = new PlanarReflection();
    expect(refl.place(cam, 2)).toBe(true);
    for (const [x, z] of [
      [0, 0],
      [-12, -20],
      [8, 5],
    ] as const) {
      const p = new Vector3(x, 2, z);
      const ndc = p.clone().project(cam);
      const t = new Vector4(x, 2, z, 1).applyMatrix4(refl.textureMatrix);
      expect(t.x / t.w).toBeCloseTo(0.5 - ndc.x * 0.5, 4);
      expect(t.y / t.w).toBeCloseTo(ndc.y * 0.5 + 0.5, 4);
    }
    // the mirrored camera sits below the plane; the reflection camera sees the reflection layer
    expect(refl.camera.position.y).toBeCloseTo(2 * 2 - 7.5, 6);
    expect(refl.camera.layers.isEnabled(WATER_REFLECTION_LAYER)).toBe(true);
    refl.dispose();
  });

  it('clips at the water plane (oblique near plane) and refuses cameras under it', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 3000);
    cam.position.set(0, 10, 0);
    cam.lookAt(0, 9, -20);
    cam.updateMatrixWorld();
    const refl = new PlanarReflection();
    refl.place(cam, 0);
    const rc = refl.camera;
    const inClip = (y: number) => {
      const v = new Vector4(0, y, -30, 1).applyMatrix4(rc.matrixWorldInverse).applyMatrix4(rc.projectionMatrix);
      return v.z >= -v.w;
    };
    expect(inClip(5)).toBe(true); // above the water: kept
    expect(inClip(-5)).toBe(false); // below the water: clipped by the near plane
    cam.position.y = -1;
    cam.updateMatrixWorld();
    expect(refl.place(cam, 0)).toBe(false);
    refl.dispose();
  });
});

describe('water interaction (ripples + contacts)', () => {
  const frame = (nodes: number[], time: number): WorldFrame => {
    const objects: SimObjectSlice[] = [{ objectId: 1, flags: 0, nodeOffset: 0, nodeCount: nodes.length / 3, beamOffset: 0, beamCount: 0 }];
    return {
      dtS: 1 / 60,
      time,
      simTime: time,
      timeScale: 1,
      camera: new PerspectiveCamera(),
      nodes: new Float32Array(nodes),
      interpolated: true,
      objects,
      tick: 0,
    };
  };

  it('emits a ripple and a contact for nodes at the surface, nothing for nodes in the air or outside', () => {
    const w = new WaterInteraction([body]);
    w.update(frame([0, 3, 0, 1, 3, 0], 0));
    expect(w.contactCount).toBe(0);
    expect(w.ripples.every((v) => v === 0)).toBe(true);
    w.update(frame([50, 0, 50], 0.1)); // outside the rect
    expect(w.contactCount).toBe(0);
    w.update(frame([0, 0.1, 0, 1, -0.1, 0], 0.2));
    expect(w.contactCount).toBe(1);
    expect(w.contacts[0]).toBeCloseTo(0.5, 5);
    expect(w.contacts[3]).toBeGreaterThan(0);
    expect(w.ripples[3]).toBeGreaterThan(0);
  });

  it('keeps a bounded ring buffer', () => {
    const w = new WaterInteraction([body]);
    for (let i = 0; i < MAX_RIPPLES * 3; i++) w.emit(i, 0, i, 1);
    expect(w.ripples.length).toBe(MAX_RIPPLES * 4);
    expect(w.ripples[0]).toBe(MAX_RIPPLES * 2);
    expect(w.contacts.length).toBe(MAX_CONTACTS * 4);
  });
});

describe('water material', () => {
  it('patches the standard shader (normal, roughness, output) with a radiance cap', () => {
    const u = createWaterUniforms(WATER_OPTICS_DEFAULTS, 0);
    const m = createWaterMaterial(u);
    expect(m).toBeInstanceOf(MeshStandardMaterial);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(true);
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    } as unknown as WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as never);
    expect(shader.vertexShader).toContain('vWaterPos =');
    expect(shader.fragmentShader).toContain(`#define WATER_MAX_RADIANCE ${WATER_MAX_RADIANCE.toFixed(1)}`);
    expect(shader.fragmentShader).toContain('clamp(col, vec3(0.0), vec3(WATER_MAX_RADIANCE))');
    expect(shader.fragmentShader).not.toContain('#include <opaque_fragment>');
    expect(shader.uniforms.tField).toBe(u.tField);
    // optics colours arrive linear
    expect(u.uDeep.value.r).toBeLessThan(0.05);
  });
});

describe('reflection proxy', () => {
  it('is one reflection-only mesh with vertex colours, dropping deep underwater cells', () => {
    const proxy = buildReflectionProxy(terrain, [body])!;
    expect(proxy.layers.isEnabled(WATER_REFLECTION_LAYER)).toBe(true);
    expect(proxy.layers.isEnabled(0)).toBe(false);
    const g = proxy.geometry;
    expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
    const idx = g.getIndex()!;
    const pos = g.getAttribute('position');
    let minTriTop = Infinity;
    for (let i = 0; i < idx.count; i += 3) {
      const top = Math.max(pos.getY(idx.getX(i)), pos.getY(idx.getX(i + 1)), pos.getY(idx.getX(i + 2)));
      minTriTop = Math.min(minTriTop, top);
    }
    expect(minTriTop).toBeGreaterThanOrEqual(-6);
    expect(buildReflectionProxy(terrain, [])).toBeNull();
  });
});
