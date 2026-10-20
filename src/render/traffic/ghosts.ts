/**
 * Ghost traffic instancing (P6 T2): every ghost (and every awake car whose
 * soft body is not drawable yet) is a rigid instance of its variant's baked
 * LOD1 / LOD2 body + 4 wheel instances, plus a soft contact shadow.
 *
 * DRAWS (main pass): per variant 2 bodies + 2 wheel meshes, + 1 contact
 * shadow mesh for all = 5 with the one traffic sedan variant (contract ≤ 24,
 * T2 target ≤ 10). Shadow pass: one positions-only LOD2 caster per variant,
 * cascade 0 only (shadowlod.ts). Instances are packed per frame (CPU
 * frustum-culled), so an empty LOD is not drawn at all.
 *
 * Per-instance data: paint (linear rgb + metalness) and lamps (DRL/head,
 * brake, indicator L, indicator R — the caller blinks them); per vertex
 * the baked material code (bake.ts GHOST_MAT_*, GHOST_LAMP).
 */
import {
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RGBAFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  type Camera,
  type Material,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';

import type { LightingStack, PatchMaterial } from '../types';
import { clampRadiance } from '../vehicle/materials';
import { attachShadowLod, shadowLodAvailable } from '../vehicle/shadowlod';
import { wheelPbrHook } from '../vehicle/wheels';
import { GHOST_LAMP, GHOST_MAT_GLOSS, GHOST_MAT_PAINT, positionsOnly, wheelLocalMatrix, type GhostWheel } from './bake';

/** HDR lamp levels of a ghost (whole-lens fill; the soft body draws DRL strips / projector eyes). */
export const GHOST_LAMP_LEVELS = { drl: 1.5, head: 3.2, tail: 0.7, brake: 4.5, indicator: 10 } as const;

export interface GhostVariantMeshes {
  /** Baked bodies: [LOD1, LOD2] (bake.ts bakeGhostBody). */
  bodies: readonly [BufferGeometry, BufferGeometry];
  /** Baked wheels: [LOD1, LOD2] (bake.ts bakeGhostWheel), wheel-local. */
  wheels: readonly [BufferGeometry, BufferGeometry];
  /** Wheel frames at the template. */
  wheelFrames: readonly GhostWheel[];
  /** Paint roughness of the variant (palette colours vary, the finish does not). */
  paintRoughness: number;
  /** Rig-local footprint for the contact shadow: centre x/z, half extents x/z. */
  footprint: { cx: number; cz: number; hx: number; hz: number };
}

export interface GhostFleetOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  renderer?: WebGLRenderer | null;
  /** Instances per variant and LOD (agents). */
  capacity: number;
}

export interface GhostInstance {
  variant: number;
  /** 1 or 2 (ghost LOD; the soft body's LOD0 range draws LOD1). */
  lod: 1 | 2;
  /** Vehicle-frame placement (rig-local → world). */
  pose: Matrix4;
  /** Linear rgb + metalness. */
  paint: Color;
  metalness: number;
  /** 0/1 head (else DRL), 0..1 brake, 0/1 indicator L, 0/1 indicator R. */
  head: number;
  brake: number;
  indL: number;
  indR: number;
  /** Front-wheel yaw (rad, + = left about +Y), wheel roll angle (rad). */
  yaw: number;
  spin: number;
}

export interface GhostFleet {
  readonly object: Group;
  /** Starts a frame: camera for culling. */
  begin(camera: Camera): void;
  /** Adds one car (culled against the camera frustum). Returns true when drawn. */
  push(g: Readonly<GhostInstance>): boolean;
  /** Uploads the packed instances. */
  end(): void;
  readonly stats: { instances: number; draws: number; casters: number };
  dispose(): void;
}

// ------------------------------------------------------------ shaders
const BODY_VERTEX_PARS = /* glsl */ `
attribute vec4 crMat;
attribute vec4 crPaint;
attribute vec4 crLamp;
varying vec4 vCrMat;
varying vec4 vCrPaint;
varying vec4 vCrLamp;`;
const BODY_FRAGMENT_PARS = /* glsl */ `
uniform float uCrPaintRough;
varying vec4 vCrMat;
varying vec4 vCrPaint;
varying vec4 vCrLamp;`;

function bodyHook(paintRough: { value: number }) {
  return (shader: WebGLProgramParametersWithUniforms): void => {
    const vs = shader.vertexShader;
    const fs = shader.fragmentShader;
    for (const [src, chunk] of [
      [vs, '#include <common>'],
      [vs, 'void main() {'],
      [fs, '#include <common>'],
      [fs, '#include <color_fragment>'],
      [fs, '#include <roughnessmap_fragment>'],
      [fs, '#include <metalnessmap_fragment>'],
      [fs, '#include <emissivemap_fragment>'],
      [fs, '#include <lights_physical_fragment>'],
    ] as const) {
      if (!src.includes(chunk)) throw new Error(`ghost body: shader lacks ${chunk}`);
    }
    shader.uniforms.uCrPaintRough = paintRough;
    const L = GHOST_LAMP_LEVELS;
    shader.vertexShader = vs
      .replace('#include <common>', `#include <common>\n${BODY_VERTEX_PARS}`)
      .replace('void main() {', 'void main() {\n\tvCrMat = crMat;\n\tvCrPaint = crPaint;\n\tvCrLamp = crLamp;');
    shader.fragmentShader = fs
      .replace('#include <common>', `#include <common>\n${BODY_FRAGMENT_PARS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	float crPaintK = abs( vCrMat.x - ${GHOST_MAT_PAINT.toFixed(1)} ) < 0.5 ? 1.0 : 0.0;
	diffuseColor.rgb = mix( diffuseColor.rgb, vCrPaint.rgb, crPaintK );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( vCrMat.y, uCrPaintRough, crPaintK );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix( vCrMat.z, vCrPaint.a, crPaintK );')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	{
		float crL = vCrMat.w;
		vec3 crE = vec3( 0.0 );
		if ( abs( crL - ${GHOST_LAMP.head.toFixed(1)} ) < 0.5 ) crE = vec3( 1.0, 0.95, 0.86 ) * mix( ${L.drl.toFixed(2)}, ${L.head.toFixed(2)}, vCrLamp.x );
		else if ( abs( crL - ${GHOST_LAMP.tail.toFixed(1)} ) < 0.5 ) crE = vec3( 1.0, 0.025, 0.015 ) * ( vCrLamp.x * ${L.tail.toFixed(2)} + vCrLamp.y * ${L.brake.toFixed(2)} );
		else if ( abs( crL - ${GHOST_LAMP.indicatorL.toFixed(1)} ) < 0.5 ) crE = vec3( 1.0, 0.42, 0.04 ) * vCrLamp.z * ${L.indicator.toFixed(2)};
		else if ( abs( crL - ${GHOST_LAMP.indicatorR.toFixed(1)} ) < 0.5 ) crE = vec3( 1.0, 0.42, 0.04 ) * vCrLamp.w * ${L.indicator.toFixed(2)};
		totalEmissiveRadiance += crE;
	}`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
	material.clearcoat *= vCrMat.x > ${(GHOST_MAT_PAINT - 0.5).toFixed(1)} && vCrMat.x < ${(GHOST_MAT_GLOSS + 0.5).toFixed(1)} ? 1.0 : 0.0;
#endif`,
      );
    clampRadiance(shader);
  };
}

/** Soft elliptical contact shadow (alpha in every channel). */
function contactShadowTexture(): DataTexture {
  const W = 32;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = ((i + 0.5) / W) * 2 - 1;
      const y = ((j + 0.5) / H) * 2 - 1;
      // superellipse: a car is boxier than an ellipse
      const r = Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(y), 4), 0.25);
      const a = Math.max(0, Math.min(1, (1 - r) / 0.45));
      const v = Math.round(255 * a * a * (3 - 2 * a));
      data.set([v, v, v, v], 4 * (j * W + i));
    }
  }
  const t = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------ fleet
interface LodMeshes {
  body: InstancedMesh;
  wheels: InstancedMesh;
  paint: InstancedBufferAttribute;
  lamp: InstancedBufferAttribute;
  n: number;
  wn: number;
}
interface VariantMeshes {
  src: GhostVariantMeshes;
  lods: [LodMeshes, LodMeshes];
  caster: InstancedMesh | null;
  cn: number;
}

const _frustum = new Frustum();
const _pv = new Matrix4();
const _sphere = new Sphere();
const _local = new Matrix4();
const _w = new Matrix4();
const _shadow = new Matrix4();
const _cam = new Vector3();

export function createGhostFleet(variants: readonly GhostVariantMeshes[], opts: GhostFleetOptions): GhostFleet {
  const object = new Group();
  object.name = 'trafficGhosts';
  const cap = Math.max(1, opts.capacity);
  const csm = opts.lighting.csm;
  const owned = new Set<Material>();
  const geoms = new Set<BufferGeometry>();

  const own = <T extends { color: Material; depth: Material | null; distance: Material | null }>(set: T): T => {
    owned.add(set.color);
    if (set.depth) owned.add(set.depth);
    if (set.distance) owned.add(set.distance);
    return set;
  };
  const bodyMaterial = (paintRough: number): Material => {
    const m = new MeshPhysicalMaterial({ name: 'crGhostBody', vertexColors: true, roughness: 1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 });
    const u = { value: paintRough };
    m.onBeforeCompile = bodyHook(u) as typeof m.onBeforeCompile;
    m.customProgramCacheKey = () => 'crGhostBody1';
    return own(opts.patchMaterial(m, { csm })).color;
  };
  const wheelMat = ((): Material => {
    const m = new MeshStandardMaterial({ name: 'crGhostWheel', vertexColors: true, roughness: 1, metalness: 1 });
    m.onBeforeCompile = ((shader: WebGLProgramParametersWithUniforms) => {
      wheelPbrHook(shader);
      clampRadiance(shader);
    }) as typeof m.onBeforeCompile;
    m.customProgramCacheKey = () => 'crGhostWheel1';
    return own(opts.patchMaterial(m, { csm })).color;
  })();
  const shadowTex = contactShadowTexture();
  const shadowMat = new MeshBasicMaterial({
    name: 'crGhostContact',
    color: 0x000000,
    alphaMap: shadowTex,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  owned.add(shadowMat);
  const casterMat = new MeshBasicMaterial({ name: 'crGhostCaster', colorWrite: false, depthWrite: false });
  owned.add(casterMat);
  const shadowLod = shadowLodAvailable(opts.renderer);

  const inst = (geo: BufferGeometry, mat: Material, n: number, name: string): InstancedMesh => {
    geoms.add(geo);
    const mesh = new InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false; // culled per instance on the CPU
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.visible = false;
    mesh.name = name;
    object.add(mesh);
    return mesh;
  };

  const vms: VariantMeshes[] = variants.map((src, vi) => {
    const mat = bodyMaterial(src.paintRoughness);
    const lods = ([0, 1] as const).map((l): LodMeshes => {
      const geo = src.bodies[l];
      const paint = new InstancedBufferAttribute(new Float32Array(4 * cap), 4);
      const lamp = new InstancedBufferAttribute(new Float32Array(4 * cap), 4);
      paint.setUsage(DynamicDrawUsage);
      lamp.setUsage(DynamicDrawUsage);
      geo.setAttribute('crPaint', paint);
      geo.setAttribute('crLamp', lamp);
      const body = inst(geo, mat, cap, `ghostBody${vi}L${l + 1}`);
      const wheels = inst(src.wheels[l], wheelMat, cap * src.wheelFrames.length, `ghostWheels${vi}L${l + 1}`);
      return { body, wheels, paint, lamp, n: 0, wn: 0 };
    }) as [LodMeshes, LodMeshes];
    let caster: InstancedMesh | null = null;
    if (shadowLod) {
      caster = inst(positionsOnly(src.bodies[1]), casterMat, cap, `ghostCaster${vi}`);
      caster.castShadow = true;
      caster.receiveShadow = false;
    }
    return { src, lods, caster, cn: 0 };
  });

  const blobGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const blobCap = cap * Math.max(1, variants.length);
  const blob = inst(blobGeo, shadowMat, blobCap, 'ghostContactShadow');
  blob.receiveShadow = false;
  blob.renderOrder = -1;
  let blobN = 0;

  // Casters draw in CSM cascade 0 only.
  const detachShadow = shadowLod
    ? attachShadowLod(opts.renderer, opts.lighting, {
        shadowBegin() {
          for (const v of vms) if (v.caster) v.caster.visible = v.cn > 0;
        },
        shadowCascade(index: number) {
          for (const v of vms) if (v.caster) v.caster.visible = index === 0 && v.cn > 0;
        },
        shadowEnd() {
          for (const v of vms) if (v.caster) v.caster.visible = false;
        },
      })
    : () => {};

  const stats = { instances: 0, draws: 0, casters: 0 };
  /** Cascade-0 reach for the casters (m from the camera): beyond it a cascade-0 caster is wasted work. */
  const CASTER_REACH_M = 60;

  return {
    object,
    stats,
    begin(camera: Camera): void {
      camera.updateMatrixWorld();
      _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pv);
      _cam.setFromMatrixPosition(camera.matrixWorld);
      for (const v of vms) {
        v.cn = 0;
        for (const l of v.lods) l.n = l.wn = 0;
      }
      blobN = 0;
      stats.instances = 0;
    },
    push(g: Readonly<GhostInstance>): boolean {
      const v = vms[g.variant];
      if (!v) return false;
      const e = g.pose.elements;
      // body centre ≈ 0.7 m above the rig ground plane
      _sphere.center.set(e[12]! + e[4]! * 0.7, e[13]! + e[5]! * 0.7, e[14]! + e[6]! * 0.7);
      _sphere.radius = 3;
      const near = _sphere.center.distanceTo(_cam) < CASTER_REACH_M;
      if (near && v.caster && v.cn < cap) {
        g.pose.toArray(v.caster.instanceMatrix.array as Float32Array, 16 * v.cn);
        v.cn++;
      }
      if (!_frustum.intersectsSphere(_sphere)) return false;
      const L = v.lods[g.lod - 1]!;
      if (L.n >= cap) return false;
      const i = L.n++;
      g.pose.toArray(L.body.instanceMatrix.array as Float32Array, 16 * i);
      const pa = L.paint.array as Float32Array;
      pa[4 * i] = g.paint.r;
      pa[4 * i + 1] = g.paint.g;
      pa[4 * i + 2] = g.paint.b;
      pa[4 * i + 3] = g.metalness;
      const la = L.lamp.array as Float32Array;
      la[4 * i] = g.head;
      la[4 * i + 1] = g.brake;
      la[4 * i + 2] = g.indL;
      la[4 * i + 3] = g.indR;
      const wa = L.wheels.instanceMatrix.array as Float32Array;
      for (const w of v.src.wheelFrames) {
        wheelLocalMatrix(w, w.steered ? g.yaw : 0, g.spin, _local);
        _w.multiplyMatrices(g.pose, _local);
        _w.toArray(wa, 16 * L.wn++);
      }
      if (blobN < blobCap) {
        const f = v.src.footprint;
        _shadow.makeScale(2 * f.hx, 1, 2 * f.hz).setPosition(f.cx, 0.03, f.cz);
        _w.multiplyMatrices(g.pose, _shadow);
        _w.toArray(blob.instanceMatrix.array as Float32Array, 16 * blobN++);
      }
      stats.instances++;
      return true;
    },
    end(): void {
      let draws = 0;
      let casters = 0;
      for (const v of vms) {
        for (const L of v.lods) {
          L.body.count = L.n;
          L.body.visible = L.n > 0;
          L.wheels.count = L.wn;
          L.wheels.visible = L.wn > 0;
          if (L.n > 0) {
            L.body.instanceMatrix.needsUpdate = true;
            L.wheels.instanceMatrix.needsUpdate = true;
            L.paint.needsUpdate = true;
            L.lamp.needsUpdate = true;
            draws += 2;
          }
        }
        if (v.caster) {
          v.caster.count = v.cn;
          v.caster.visible = false;
          if (v.cn > 0) {
            v.caster.instanceMatrix.needsUpdate = true;
            casters++;
          }
        }
      }
      blob.count = blobN;
      blob.visible = blobN > 0;
      if (blobN > 0) {
        blob.instanceMatrix.needsUpdate = true;
        draws++;
      }
      stats.draws = draws;
      stats.casters = casters;
    },
    dispose(): void {
      detachShadow();
      object.removeFromParent();
      for (const m of owned) m.dispose();
      for (const g of geoms) g.dispose();
      shadowTex.dispose();
    },
  };
}
