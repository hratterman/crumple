import { describe, expect, it } from 'vitest';
import { Material, MeshDepthMaterial, MeshDistanceMaterial, MeshPhysicalMaterial, PerspectiveCamera, ShaderLib, Sphere, Vector3 } from 'three';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';

import { patchMaterial } from '../material';
import type { LightingStack } from '../types';
import { bindPanels, evalFlexVertex, FLEX_NORMAL_EPS } from './binder';
import {
  applyFlexGlsl,
  cloneBaseMaterial,
  createFlexSkin,
  FLEX_MAIN_CALL,
  FLEXBODY_SINGLE_PATCH_KEY,
  FLEX_NORMAL_CHUNK,
  FLEX_POSITION_CHUNK,
  FLEX_VERTEX_PARS,
  nodeTextureRows,
  SETTLE_DEFAULTS,
} from './flexskin';
import { syntheticCubeSubject } from './synthetic';
import {
  FLEX_AGREE_FLOOR,
  FLEX_CROSS_FLOOR,
  FLEX_CRUMPLE_AMP,
  FLEX_GS_FLOOR,
  FLEX_HEALTHY_SLACK,
  FLEX_HEALTHY_STRETCH,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEX_QUALITY_FLOOR,
  FLEX_SIN_FLOOR,
  FLEX_TRIADS,
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

describe('flex2 GLSL', () => {
  it('bakes the shared contract constants into the shader', () => {
    const glsl = FLEX_VERTEX_PARS + FLEX_POSITION_CHUNK + FLEX_NORMAL_CHUNK;
    expect(glsl).toContain(`max( l1 * length( e2 ), ${FLEX_CROSS_FLOOR} )`);
    expect(glsl).toContain(`max( L, ${FLEX_SIN_FLOOR} * m )`);
    expect(glsl).toContain(`float lim = ${FLEX_MAX_STRETCH} * coef.w + ${FLEX_MAX_SLACK};`);
    expect(glsl).toContain(`smoothstep( ${FLEX_HEALTHY_STRETCH} * coef.w + ${FLEX_HEALTHY_SLACK}, lim, lo )`);
    expect(glsl).toContain(`max( q, ${FLEX_QUALITY_FLOOR} )`);
    expect(glsl).toContain(`max( l1, ${FLEX_GS_FLOOR} )`);
    expect(glsl).toContain(`l > ${FLEX_NORMAL_EPS}`);
    expect(glsl).toContain(`${FLEX_AGREE_FLOOR} + smoothstep( -0.2, 0.8, dot( N, Nm ) )`);
    expect(glsl).toContain(`${FLEX_CRUMPLE_AMP} * accD.x * flexFrameU.z * flexCrumple( position )`);
    expect(glsl).toContain('texelFetch( uFlexNodes, ivec2( i & 63, ( i >> 6 ) + block * uFlexRows ), 0 )');
    expect(glsl).toContain(`& ${NODE_TEX_FLAG_BROKEN}`);
    for (let k = 0; k < FLEX_TRIADS; k++) expect(glsl).toContain(`flexTriad( flexTriad${k}, flexCoef${k}, flexFrame${k}.xyz`);
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
    expect(shader.vertexShader).toContain(`void main() {\n${FLEX_MAIN_CALL}`);
    expect(shader.vertexShader).toContain('vec3 transformed = flexP;');
    if (target === 'color') {
      expect(shader.vertexShader).not.toContain('#include <beginnormal_vertex>');
      expect(shader.vertexShader).toContain('#define FLEXBODY_COLOR');
      expect(shader.vertexShader).toContain('vec3 objectNormal = flexN;');
      expect(shader.fragmentShader).toContain('varying vec4 vFlexDamage;');
      expect(shader.vertexShader).not.toContain('#define FLEXBODY_SINGLE');
    } else {
      expect(shader.vertexShader).not.toContain('#define FLEXBODY_COLOR');
      // depth / distance: one triad (slot 0, the strongest weight)
      expect(shader.vertexShader).toContain('#define FLEXBODY_SINGLE');
    }
  });

  it('single-triad colour variant (LOD ≥ 1) and the hidden-panel early-out', () => {
    const shader = program(ShaderLib.physical);
    applyFlexGlsl(shader, 'color', true);
    expect(shader.vertexShader).toContain('#define FLEXBODY_COLOR\n#define FLEXBODY_SINGLE');
    expect(shader.vertexShader).toContain('flexTriad( vec4( flexTriad0.xyz, 1.0 ), flexCoef0, flexFrame0.xyz, ft0, P0, W0, N0, T0, accD );');
    expect(shader.vertexShader).toContain('vec3 ft0 = vec3( flexFrame0.w, flexFrameU.xy );');
    expect(FLEX_VERTEX_PARS).toContain('int p = int( flexFrameU.w + 0.5 );');
    expect(FLEX_VERTEX_PARS).toContain('texelFetch( uFlexHidden, ivec2( p & 63, p >> 6 ), 0 ).r > 0.5');
    expect(shader.fragmentShader).toContain('flat varying float vFlexPanel;');
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

  it('merges panels into one draw per material: flex attributes, panel ids, hidden mask, deforming shadow materials', () => {
    const skin = createFlexSkin(binding, { materials: stubMaterials(), damage: null, lighting, patchMaterial });
    // both synthetic panels are paint → one draw
    expect(skin.meshes.length).toBe(1);
    expect(Array.from(skin.panelDraw)).toEqual([0, 0]);
    expect(skin.patch.key).toBe(FLEXBODY_PATCH_KEY);
    const mesh = skin.meshes[0]!;
    const g = mesh.geometry;
    const attrs = ['position', 'normal', 'uv', 'tangent', 'flexFrameT', 'flexFrameU'];
    for (let k = 0; k < FLEX_TRIADS; k++) attrs.push(`flexTriad${k}`, `flexCoef${k}`, `flexFrame${k}`);
    for (const a of attrs) expect(g.getAttribute(a), a).toBeDefined();
    // ≤ 16 vertex attribute slots (WebGL2 minimum), `normal` included even though flex2 never reads it.
    expect(Object.keys(g.attributes).length).toBeLessThanOrEqual(15);
    let vo = 0;
    for (const p of binding.panels) {
      const t1 = g.getAttribute('flexTriad1').array;
      expect([t1[4 * vo], t1[4 * vo + 1], t1[4 * vo + 2], t1[4 * vo + 3]]).toEqual([p.triad[3], p.triad[4], p.triad[5], p.weight[1]]);
      expect(g.getAttribute('flexCoef2').array[4 * vo + 3]).toBe(p.coef[4 * 2 + 3]);
      const fT = g.getAttribute('flexFrameT').array;
      expect([fT[4 * vo], fT[4 * vo + 1], fT[4 * vo + 2], fT[4 * vo + 3]]).toEqual([p.frameTangent![1], p.frameTangent![2], p.frameTangent![4], p.frameTangent![5]]);
      const fU = g.getAttribute('flexFrameU').array;
      for (const v of [0, p.vertexCount - 1]) {
        expect(fU[4 * (vo + v) + 3]).toBe(p.panelIndex); // panel id → hidden-mask texel
      }
      expect([fU[4 * vo], fU[4 * vo + 1], fU[4 * vo + 2]]).toEqual([p.frameTangent![7], p.frameTangent![8], p.damageWeight[0]]);
      vo += p.vertexCount;
    }
    expect(g.getAttribute('position').count).toBe(vo);
    expect(g.getIndex()!.count).toBe(binding.panels.reduce((n, p) => n + p.index.length, 0));
    expect(mesh.customDepthMaterial).toBeInstanceOf(MeshDepthMaterial);
    expect(mesh.customDistanceMaterial).toBeInstanceOf(MeshDistanceMaterial);
    // no renderer hook → "direct" mode: the colour draw casts its own (single-triad) shadow
    expect(skin.casters.length).toBe(0);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    // The depth twin really reconstructs (shadows of the deformed body), with one triad.
    const depth = program(ShaderLib.depth);
    mesh.customDepthMaterial!.onBeforeCompile(depth, renderer);
    expect(depth.vertexShader).toContain('flexEvaluate();');
    expect(depth.vertexShader).toContain('#define FLEXBODY_SINGLE');
    expect(depth.uniforms.uFlexNodes!.value).toBe(skin.nodeTexture);
    expect(depth.uniforms.uFlexRows!.value).toBe(1);
    expect(depth.uniforms.uFlexHidden!.value).toBe(skin.hiddenMask);
    const color = program(ShaderLib.physical);
    (mesh.material as Material).onBeforeCompile(color, renderer);
    expect(color.vertexShader).toContain('vFlexDamage = vec4( accD.xyz * flexFrameU.z, accD.w );');
    expect(color.uniforms.uFlexNodes!.value).toBe(skin.nodeTexture);
    // hiding a panel flips its mask texel (the merged draw stays)
    const v0 = skin.hiddenMask.version;
    skin.setPanelVisible(1, false);
    expect(skin.panelVisible(1)).toBe(false);
    expect(skin.panelVisible(0)).toBe(true);
    expect((skin.hiddenMask.image.data as Uint8Array)[1]).toBe(255);
    expect(skin.hiddenMask.version).toBeGreaterThan(v0);
    expect(mesh.visible).toBe(true);
    skin.setPanelVisible(1, true);
    expect((skin.hiddenMask.image.data as Uint8Array)[1]).toBe(0);
    skin.dispose();
  });

  it('LOD levels + shadow casters: caster LOD per cascade around the shadow pass, colour LOD by camera distance', () => {
    let shadowRenders = 0;
    const seen: string[] = [];
    let skinRef: ReturnType<typeof createFlexSkin> | null = null;
    const fakeRenderer = {
      shadowMap: {
        render(): void {
          shadowRenders++;
          const s = skinRef!;
          seen.push(s.casters.map((c) => (c.visible ? 1 : 0)).join(''));
          for (const m of s.levels.flat()) expect(m.castShadow).toBe(false);
        },
      },
    } as unknown as WebGLRenderer;
    const coarse = bindPanels(subject.compiled, subject.def, syntheticCubeSubject(5).geoms);
    const skin = createFlexSkin(binding, {
      materials: stubMaterials(),
      damage: null,
      lighting,
      patchMaterial,
      lods: [coarse, coarse],
      renderer: fakeRenderer,
    });
    skinRef = skin;
    expect(skin.levels.length).toBe(3);
    expect(skin.casters.length).toBe(2);
    expect(skin.casters[0]).not.toBe(skin.casters[1]); // [cascade 0: LOD1, cascades ≥ 1: LOD2]
    expect(skin.casters[0]!.castShadow).toBe(true);
    expect(skin.patchSingle.key).toBe(FLEXBODY_SINGLE_PATCH_KEY);
    const lod1 = skin.levels[1]![0]!;
    expect(lod1.geometry.getAttribute('flexTriad1')).toBeUndefined(); // single-triad layout
    expect(lod1.geometry.getAttribute('flexFrameU').array[3]).toBe(0);
    expect(skin.casters[0]!.visible).toBe(false);
    (fakeRenderer.shadowMap.render as unknown as () => void)();
    expect(shadowRenders).toBe(1);
    expect(seen).toEqual(['10']); // no CSM: the cascade-0 caster (LOD1) only
    expect(skin.casters[0]!.visible).toBe(false); // colour pass: casters hidden again
    // colour LOD from the camera, with hysteresis
    const cam = new PerspectiveCamera(60);
    const nodes = new Float32Array(subject.compiled.rig.nodeCount * 3);
    const at = (d: number): number => {
      cam.position.set(d, 0, 0);
      cam.updateMatrixWorld();
      skin.update({ ...frameFor(nodes), camera: cam });
      return skin.lod;
    };
    expect(at(10)).toBe(0);
    expect(at(26)).toBe(0); // inside the hysteresis band
    expect(at(28)).toBe(1);
    expect(at(24)).toBe(1);
    expect(at(22)).toBe(0);
    expect(at(90)).toBe(2);
    expect(skin.levels[2]![0]!.visible).toBe(true);
    expect(skin.meshes[0]!.visible).toBe(false);
    skin.setForcedLod(0);
    expect(at(90)).toBe(0);
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
    for (const p of binding.panels) {
      const sphere = skin.meshes[skin.panelDraw[p.panelIndex]!]!.geometry.boundingSphere as Sphere;
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

  it('settle calibration: a static sag at rest is hidden, a car on its roof is left alone, a wreck never calibrates', () => {
    const rig = subject.compiled.rig;
    const settle = { restNodes: rig.nodePos, frameNodes: subject.compiled.frameNodes, bodyNodeCount: rig.nodeCount };
    const skin = createFlexSkin(binding, {
      materials: stubMaterials(),
      damage: null,
      lighting,
      patchMaterial,
      anchorNode: subject.compiled.frameNodes[0]!,
      settle,
    });
    const SAG = 7;
    const yaw = 0.5;
    const pose = (flip: boolean, sag: number): Float32Array => {
      const out = new Float32Array(rig.nodeCount * 3);
      for (let i = 0; i < rig.nodeCount; i++) {
        let x = rig.nodePos[3 * i]!;
        let y = rig.nodePos[3 * i + 1]! - (i === SAG ? sag : 0);
        const z = rig.nodePos[3 * i + 2]!;
        if (flip) [x, y] = [-x, -y]; // rolled onto its roof (about the forward axis)
        out[3 * i] = 50 + Math.cos(yaw) * x + Math.sin(yaw) * z;
        out[3 * i + 1] = 3 + y;
        out[3 * i + 2] = -20 - Math.sin(yaw) * x + Math.cos(yaw) * z;
      }
      return out;
    };
    const run = (nodes: Float32Array, seconds: number, broken = new Uint8Array(4), epoch = 0): void => {
      for (let t = 0; t < seconds * 60; t++) skin.update({ ...frameFor(nodes), dtS: 1 / 60, broken, repairEpoch: epoch });
    };
    const skinPos = (i: number): number[] => [0, 1, 2].map((k) => skin.nodeData[4 * i + k]!);
    const anchor = subject.compiled.frameNodes[0]!;
    const rigid = pose(false, 0);
    const want = (i: number): number[] => [0, 1, 2].map((k) => rigid[3 * i + k]! - rigid[3 * anchor + k]!);

    // A wreck that comes to rest (a beam is broken) is never calibrated.
    run(pose(false, 0.06), 2, Uint8Array.of(0, 1, 0, 0));
    expect(skin.settle!.calibrated).toBe(false);
    // Spawn / repair (new epoch): settles, calibrates, fades in.
    run(pose(false, 0.06), SETTLE_DEFAULTS.waitS + SETTLE_DEFAULTS.sampleS + SETTLE_DEFAULTS.fadeS + 0.3, new Uint8Array(4), 1);
    expect(skin.settle!.calibrated).toBe(true);
    expect(skin.settle!.maxOffset).toBeCloseTo(0.06, 4);
    expect(skin.settle!.strength).toBe(1);
    for (const i of [SAG, 3, 40]) {
      const got = skinPos(i);
      const exp = want(i);
      for (let k = 0; k < 3; k++) expect(got[k]!).toBeCloseTo(exp[k]!, 4);
    }
    // Rolled onto its roof: the sag points the other way, so no correction at all.
    const rolled = pose(true, -0.06);
    run(rolled, 0.1, new Uint8Array(4), 1);
    expect(skin.settle!.strength).toBe(0);
    expect(skin.nodeData[4 * SAG + 1]!).toBeCloseTo(rolled[3 * SAG + 1]! - rolled[3 * anchor + 1]!, 5);
    skin.dispose();
  });
});
