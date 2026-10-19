import { describe, expect, it } from 'vitest';
import { Material, MeshDepthMaterial, MeshDistanceMaterial, MeshPhysicalMaterial, ShaderLib, Sphere, Vector3 } from 'three';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';

import { patchMaterial } from '../material';
import type { LightingStack } from '../types';
import { bindPanels, evalFlexVertex, FLEX_NORMAL_EPS } from './binder';
import {
  applyFlexGlsl,
  cloneBaseMaterial,
  createFlexSkin,
  FLEX_NORMAL_CHUNK,
  FLEX_POSITION_CHUNK,
  FLEX_VERTEX_PARS,
  nodeTextureRows,
} from './flexskin';
import { syntheticCubeSubject } from './synthetic';
import {
  FLEX_CROSS_FLOOR,
  FLEX_GS_FLOOR,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEXBODY_PATCH_KEY,
  NODE_TEX_FLAG_BROKEN,
  type VehicleFrameInput,
  type VehicleMaterialSet,
} from './types';

const subject = syntheticCubeSubject(12);
const binding = bindPanels(subject.compiled, subject.def, subject.geoms);
const renderer = {} as WebGLRenderer;

function stubMaterials(): VehicleMaterialSet {
  const paint = new MeshPhysicalMaterial({ color: 0xaa2222, clearcoat: 1 });
  return { base: () => paint, setPaint() {}, setLights() {}, dispose() {} };
}
const lighting = { csm: null } as unknown as LightingStack;

function program(src: { vertexShader: string; fragmentShader: string }): WebGLProgramParametersWithUniforms {
  return { uniforms: {}, vertexShader: src.vertexShader, fragmentShader: src.fragmentShader } as unknown as WebGLProgramParametersWithUniforms;
}

function frameFor(nodes: Float32Array, nodeOffset = 0): VehicleFrameInput {
  return { nodes, nodeOffset, tick: 1, broken: new Uint8Array(0), repairEpoch: 0, telemetry: null, dtS: 1 / 60 };
}

describe('flex1 GLSL', () => {
  it('bakes the shared contract constants into the shader', () => {
    const glsl = FLEX_VERTEX_PARS + FLEX_POSITION_CHUNK + FLEX_NORMAL_CHUNK;
    expect(glsl).toContain(`max( length( flexCr ), ${FLEX_CROSS_FLOOR} )`);
    expect(glsl).toContain(`${FLEX_MAX_STRETCH}.0 * flexCoef.w + ${FLEX_MAX_SLACK}`);
    expect(glsl).toContain(`max( length( e1 ), ${FLEX_GS_FLOOR} )`);
    expect(glsl).toContain(`l > ${FLEX_NORMAL_EPS}`);
    expect(glsl).toContain('texelFetch( uFlexNodes, ivec2( i & 63, ( i >> 6 ) + block * uFlexRows ), 0 )');
    expect(glsl).toContain(`& ${NODE_TEX_FLAG_BROKEN}`);
  });

  it.each([
    ['color', ShaderLib.physical],
    ['depth', ShaderLib.depth],
    ['distance', ShaderLib.distanceRGBA ?? ShaderLib.distance],
  ] as const)('patches the real three %s program', (target, lib) => {
    const shader = program(lib as { vertexShader: string; fragmentShader: string });
    applyFlexGlsl(shader, target);
    expect(shader.vertexShader.startsWith('#define FLEXBODY\n')).toBe(true);
    expect(shader.vertexShader).not.toContain('#include <begin_vertex>');
    expect(shader.vertexShader).toContain('flexLoad( flexIdx, flexR, flexE1, flexE2 )');
    if (target === 'color') {
      expect(shader.vertexShader).not.toContain('#include <beginnormal_vertex>');
      expect(shader.vertexShader).toContain('#define FLEXBODY_COLOR');
      expect(shader.fragmentShader).toContain('varying vec4 vFlexDamage;');
    } else {
      expect(shader.vertexShader).not.toContain('#define FLEXBODY_COLOR');
    }
  });
});

describe('createFlexSkin', () => {
  it('sizes the node texture per contract', () => {
    expect(nodeTextureRows(1)).toBe(1);
    expect(nodeTextureRows(64)).toBe(1);
    expect(nodeTextureRows(65)).toBe(2);
    const skin = createFlexSkin(binding, { materials: stubMaterials(), damage: null, lighting, patchMaterial });
    expect(skin.rows).toBe(1);
    expect(skin.nodeTexture.image.width).toBe(64);
    expect(skin.nodeTexture.image.height).toBe(2);
    expect(skin.nodeData.length).toBe(64 * 2 * 4);
    skin.dispose();
  });

  it('builds one mesh per panel with flex attributes and deforming shadow materials', () => {
    const skin = createFlexSkin(binding, { materials: stubMaterials(), damage: null, lighting, patchMaterial });
    expect(skin.meshes.length).toBe(2);
    expect(skin.patch.key).toBe(FLEXBODY_PATCH_KEY);
    for (const [i, mesh] of skin.meshes.entries()) {
      const g = mesh.geometry;
      for (const a of ['position', 'normal', 'uv', 'flexTriad', 'flexCoef', 'flexNormal', 'flexDamage', 'tangent', 'flexTangent']) {
        expect(g.getAttribute(a), a).toBeDefined();
      }
      expect(g.getAttribute('flexTriad').array[0]).toBe(binding.panels[i]!.triad[0]);
      expect(mesh.customDepthMaterial).toBeInstanceOf(MeshDepthMaterial);
      expect(mesh.customDistanceMaterial).toBeInstanceOf(MeshDistanceMaterial);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
      // The depth twin really reconstructs (shadows of the deformed body).
      const depth = program(ShaderLib.depth);
      mesh.customDepthMaterial!.onBeforeCompile(depth, renderer);
      expect(depth.vertexShader).toContain('flexCoef.z');
      expect(depth.uniforms.uFlexNodes!.value).toBe(skin.nodeTexture);
      expect(depth.uniforms.uFlexRows!.value).toBe(1);
      const color = program(ShaderLib.physical);
      (mesh.material as Material).onBeforeCompile(color, renderer);
      expect(color.vertexShader).toContain('vFlexDamage = flexDamageBlend( flexIdx );');
      expect(color.uniforms.uFlexNodes!.value).toBe(skin.nodeTexture);
    }
    skin.setPanelVisible(1, false);
    expect(skin.meshes[1]!.visible).toBe(false);
    skin.dispose();
  });

  it('writes skin-space block A + flags, sits at the anchor, and bounds every deformed vertex', () => {
    const anchorNode = subject.compiled.frameNodes[0]!;
    const skin = createFlexSkin(binding, { materials: stubMaterials(), damage: null, lighting, patchMaterial, anchorNode });
    const rig = subject.compiled.rig;
    // Global array with another object's 5 nodes in front; deformed + far from the origin.
    const offset = 5;
    const nodes = new Float32Array((offset + rig.nodeCount) * 3).fill(123);
    for (let i = 0; i < rig.nodeCount; i++) {
      const x = rig.nodePos[3 * i]!, y = rig.nodePos[3 * i + 1]!, z = rig.nodePos[3 * i + 2]!;
      nodes[3 * (offset + i)] = 700 + 1.2 * x + 0.3 * y;
      nodes[3 * (offset + i) + 1] = 40 + y * (y > 0 ? 0.6 : 1) + 0.1 * Math.sin(5 * x);
      nodes[3 * (offset + i) + 2] = -650 + z;
    }
    // A collapsed lid node pair (flying debris) must still be inside the bounds.
    skin.nodeFlags[7] = NODE_TEX_FLAG_BROKEN;
    skin.update(frameFor(nodes, offset));
    const ax = nodes[3 * (offset + anchorNode)]!;
    expect(skin.anchor[0]).toBe(ax);
    expect(skin.object.position.x).toBe(ax);
    expect(skin.nodeData[4 * 7 + 3]).toBe(NODE_TEX_FLAG_BROKEN);
    expect(skin.nodeData[4 * anchorNode]).toBe(0);
    expect(skin.nodeData[4 * 3]).toBeCloseTo(nodes[3 * (offset + 3)]! - ax, 4);
    expect(skin.nodeTexture.version).toBeGreaterThan(0);

    const skinNodes = new Float64Array(rig.nodeCount * 3);
    for (let i = 0; i < rig.nodeCount; i++) for (let k = 0; k < 3; k++) skinNodes[3 * i + k] = skin.nodeData[4 * i + k]!;
    const out = new Float64Array(6);
    for (const [pi, mesh] of skin.meshes.entries()) {
      const sphere = mesh.geometry.boundingSphere as Sphere;
      const p = binding.panels[pi]!;
      for (let v = 0; v < p.vertexCount; v++) {
        evalFlexVertex(p, v, skinNodes, out);
        expect(sphere.containsPoint(new Vector3(out[0], out[1], out[2]))).toBe(true);
      }
    }
    skin.dispose();
  });

  it('ignores a frame whose anchor is not finite (keeps the last good pose)', () => {
    const skin = createFlexSkin(binding, { materials: stubMaterials(), damage: null, lighting, patchMaterial });
    const nodes = new Float32Array(64 * 3).fill(1);
    skin.update(frameFor(nodes));
    const before = skin.nodeData.slice();
    nodes[0] = NaN;
    skin.update(frameFor(nodes));
    expect(skin.nodeData).toEqual(before);
    skin.dispose();
  });

  it('keeps a base material hook through cloning', () => {
    const base = new MeshPhysicalMaterial();
    const hook = (): void => {};
    base.onBeforeCompile = hook;
    base.customProgramCacheKey = () => 'flake1';
    const c = cloneBaseMaterial(base);
    expect(c).not.toBe(base);
    expect(c.onBeforeCompile).toBe(hook);
    expect(c.customProgramCacheKey()).toBe('flake1');
  });
});
