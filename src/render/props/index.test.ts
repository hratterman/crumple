import { PerspectiveCamera, ShaderLib, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';

import { OBJECT_FLAG_SLEEPING } from '../../protocol/layout';
import { compilePropRig, PROP_CATALOG } from '../../sim/props/catalog';
import type { PropInstance, PropKey } from '../../sim/props/types';
import { patchMaterial } from '../material';
import { QUALITY_PRESETS, type LightingStack, type RenderContext, type SimObjectSlice, type WorldFrame } from '../types';
import { NODE_TEX_WIDTH } from '../vehicle/types';
import { createPropRenderer, PROP_STRAIN } from './index';
import { applySlotHook, PROP_MATERIAL_SLOTS } from './materials';
import { applyPropFlexGlsl, PROP_VERTEX_PARS } from './patch';
import { propTextures } from './textures';

function inst(index: number, prop: PropKey, x: number, z: number): PropInstance {
  const def = PROP_CATALOG[prop];
  return {
    index,
    objectId: 4096 + index,
    id: `p${index}`,
    prop,
    transform: { pos: [x, 0, z], quat: [0, 0, 0, 1] },
    aabb: [x - 1, 0, z - 1, x + 1, 2, z + 1],
    surface: def.surface,
    material: def.material,
  };
}

function setup(list: PropInstance[]) {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 2000);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const ctx = { renderer: { shadowMap: {} }, scene: null, camera, quality: QUALITY_PRESETS.high, width: 1280, height: 720, sampler: null } as unknown as RenderContext;
  const lighting = { csm: null } as unknown as LightingStack;
  const r = createPropRenderer(ctx, list, { lighting, patchMaterial });
  const slices: SimObjectSlice[] = [];
  let total = 0;
  for (const p of list) {
    const n = compilePropRig(p.prop).nodeCount;
    slices.push({ objectId: p.objectId, flags: 0, nodeOffset: total, nodeCount: n, beamOffset: 0, beamCount: 0 });
    total += n;
  }
  const nodes = new Float32Array(total * 3);
  const place = (j: number, dx = 0, dy = 0, dz = 0, squash = 1): void => {
    const p = list[j]!;
    const rig = compilePropRig(p.prop);
    for (let i = 0; i < rig.nodeCount; i++) {
      const o = 3 * (slices[j]!.nodeOffset + i);
      nodes[o] = rig.nodePos[3 * i]! + p.transform.pos[0] + dx;
      nodes[o + 1] = rig.nodePos[3 * i + 1]! * squash + dy;
      nodes[o + 2] = rig.nodePos[3 * i + 2]! + p.transform.pos[2] + dz;
    }
  };
  list.forEach((_, j) => place(j));
  const frame: WorldFrame = { dtS: 1 / 60, time: 0, simTime: 0, timeScale: 1, camera, nodes, interpolated: true, objects: slices, tick: 1 };
  return { r, frame, slices, place, camera };
}

/** The props node texture data, fetched through a batch material's uniforms (as the GPU sees it). */
function nodeTexture(r: ReturnType<typeof setup>['r']): { data: Float32Array; rows: number } {
  const mesh = r.root.children[0] as unknown as { material: { onBeforeCompile: (s: WebGLProgramParametersWithUniforms) => void } };
  const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader } as unknown as WebGLProgramParametersWithUniforms;
  mesh.material.onBeforeCompile(shader);
  const tex = (shader.uniforms as Record<string, { value: { image: { data: Float32Array; height: number } } }>).uPropNodes!.value;
  return { data: tex.image.data, rows: tex.image.height / 2 };
}

describe('prop renderer', () => {
  it('batches per (key, slot), culls and compacts instances', () => {
    const list = [inst(0, 'cone', -1, 0), inst(1, 'cone', 1, 0), inst(2, 'barrel', 0, -2), inst(3, 'cone', 0, 40)];
    const { r, frame, camera } = setup(list);
    r.update(frame);
    expect(r.stats.instances).toBe(4);
    expect(r.stats.visibleInstances).toBe(3); // the cone behind the camera is culled
    const meshes = r.root.children as unknown as { name: string; visible: boolean; geometry: { instanceCount: number } }[];
    const cone = meshes.find((m) => m.name === 'props:cone:conePlastic:lod0')!;
    expect(cone.geometry.instanceCount).toBe(2);
    expect(r.stats.drawCalls).toBe(meshes.filter((m) => m.visible).length);
    camera.position.set(0, 2, 60);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    frame.tick++;
    r.update(frame);
    expect(r.stats.visibleInstances).toBe(4);
    // ≥ 32 m away: every instance draws LOD1
    const lod1 = meshes.find((m) => m.name === 'props:cone:conePlastic:lod1')!;
    expect(lod1.geometry.instanceCount).toBe(2);
  }, 60_000);

  it('writes texels relative to the 64 m-snapped origin, skips sleeping objects, detects re-placement', () => {
    const list = [inst(0, 'boxCardboard', 100.3, 0)];
    const { r, frame, slices, place, camera } = setup(list);
    camera.position.set(100, 2, 10);
    camera.updateMatrixWorld();
    r.update(frame);
    expect(r.root.position.x).toBe(128); // round(100 / 64) · 64
    const x0 = () => nodeTexture(r).data[0]! + 128;
    const rest = x0();
    // asleep: small moves are not rewritten (sleeping objects never move in the sim); a > 5 cm jump is a re-placement
    slices[0]!.flags = OBJECT_FLAG_SLEEPING;
    frame.tick++;
    r.update(frame);
    place(0, 0.01, 0, 0);
    frame.tick++;
    r.update(frame);
    expect(x0()).toBeCloseTo(rest, 5);
    place(0, 3, 0, 0);
    frame.tick++;
    r.update(frame);
    expect(x0()).toBeCloseTo(rest + 3, 4);
    expect(r.stats.awake).toBe(0);
  }, 60_000);

  it('derives strain from beam lengths with a persistence filter', () => {
    const list = [inst(0, 'boxCardboard', 0, 0)];
    const { r, frame, place } = setup(list);
    place(0, 0, 0, 0, 0.6); // squashed 40 % vertically
    r.update(frame); // first tick: the persistence filter still holds the previous strain (0)
    const blockB = (t: { rows: number }) => 4 * NODE_TEX_WIDTH * t.rows;
    let t = nodeTexture(r);
    let max = 0;
    for (let i = 0; i < 14; i++) max = Math.max(max, t.data[blockB(t) + 4 * i]!);
    expect(max).toBe(0);
    frame.tick++;
    r.update(frame);
    t = nodeTexture(r);
    for (let i = 0; i < 14; i++) max = Math.max(max, t.data[blockB(t) + 4 * i]!);
    expect(max).toBeGreaterThan(0.5);
    expect(PROP_STRAIN.full).toBeGreaterThan(PROP_STRAIN.deadzone);
  }, 60_000);
});

describe('prop shaders', () => {
  it('flexI1 edits the standard program for every target', () => {
    for (const target of ['color', 'depth', 'distance'] as const) {
      const s = { vertexShader: target === 'color' ? ShaderLib.standard.vertexShader : ShaderLib.depth.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader };
      applyPropFlexGlsl(s, target);
      expect(s.vertexShader).toContain('propEvaluate();');
      expect(s.vertexShader).toContain('vec3 transformed = flexP;');
      expect(s.vertexShader.includes('#define FLEXBODY_COLOR')).toBe(target === 'color');
    }
    expect(PROP_VERTEX_PARS).toContain('ivec3( tri.xyz + 0.5 ) + base');
  }, 60_000);

  it('every slot hook finds its chunks', () => {
    const grime = propTextures.grime();
    for (const slot of PROP_MATERIAL_SLOTS) {
      const s = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader } as unknown as WebGLProgramParametersWithUniforms;
      applySlotHook(slot, s, grime);
      expect(s.fragmentShader).toContain('propGrime');
      expect((s.uniforms as Record<string, unknown>).uPropGrime).toBeDefined();
    }
  }, 60_000);
});

describe('prop renderer replay state (P7)', () => {
  it('saveState / restoreState: scuffs, broken flags and the node texture come back exactly; a seek restore does not clear them', () => {
    const list = [inst(0, 'cone', -1, 0), inst(1, 'barrel', 1, 0)];
    const { r, frame, place } = setup(list);
    r.update(frame);
    const p0 = list[1]!.transform.pos;
    r.onImpact({ objectId: 4097, materialId: 6, px: p0[0], py: 0.5, pz: p0[2], nx: 0, ny: 0, nz: 1, impulse: 200 });
    r.onBeamBreak({ objectId: 4097, beamIndex: 3, px: p0[0], py: 0.3, pz: p0[2] });
    place(1, 0, 0, 0, 0.9);
    frame.tick++;
    r.update(frame);
    const tex = nodeTexture(r);
    const before = tex.data.slice();
    const st = r.saveState();
    // a later state: knocked away (a sleeping jump would clear damage), more scuff
    place(1, 3, 0, 0);
    frame.objects[1]!.flags = OBJECT_FLAG_SLEEPING;
    frame.tick++;
    r.update(frame);
    r.onImpact({ objectId: 4096, materialId: 6, px: -1, py: 0.3, pz: 0, nx: 0, ny: 0, nz: 1, impulse: 300 });
    expect(Array.from(nodeTexture(r).data)).not.toEqual(Array.from(before));
    r.restoreState(st);
    expect(Array.from(nodeTexture(r).data)).toEqual(Array.from(before));
    // seek restore (rewrite): the next update rewrites poses from the frame without clearing the scuffs
    r.restoreState(st, true);
    frame.tick++;
    r.update(frame);
    const d = nodeTexture(r);
    const blockB = 4 * NODE_TEX_WIDTH * d.rows;
    let scuff = 0;
    for (let i = 0; i < compilePropRig('barrel').nodeCount; i++) scuff += d.data[blockB + 4 * (compilePropRig('cone').nodeCount + i) + 1]!;
    expect(scuff).toBeGreaterThan(0);
  });
});
