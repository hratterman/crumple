/**
 * Ribbon materials: MeshPhysicalMaterial (specularIntensity 0.3) + the procedural road shader
 * (shader.ts), one core (opaque) and one fringe (alpha-blended) material per
 * road. Programs are shared per (style, markings, fringe) variant; uniforms
 * are per road.
 *
 * CSM: patchMaterial({ csm }) runs first (it owns onBeforeCompile). The road
 * splice is composed AFTER whatever hook is installed — via an accessor, so
 * a later csm.setupMaterial() (quality change) cannot drop it.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshPhysicalMaterial,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import type { CSM } from 'three/examples/jsm/csm/CSM.js';

import type { TerrainTextureSet } from '../../assets/loader';
import type { PatchMaterial, PatchedMaterialSet, TerrainMaterialSet } from '../types';
import { TERRAIN_TILE_M } from '../types';
import type { RoadRibbonInfo } from './geometry';
import { makeRoadNoise, ROAD_NOISE_SIZE } from './noise';
import {
  ROAD_FRAGMENT_AO,
  ROAD_FRAGMENT_EMISSIVE,
  ROAD_FRAGMENT_NORMAL,
  ROAD_FRAGMENT_PARS,
  ROAD_FRAGMENT_ROUGHNESS,
  ROAD_FRAGMENT_SURFACE,
  ROAD_VERTEX_BEGIN,
  ROAD_VERTEX_PARS,
  ROAD_VERTEX_PROJECT,
} from './shader';
import { ROAD_STYLE_PARAMS } from './styles';

/** specularIntensity of the surfaces (paint is boosted per pixel in the shader). */
export const ROAD_SPECULAR = 0.3;

/** Depth pull ∝ dist² (m per m²): ~0.08 m at 100 m, ~2 m at 500 m. */
export const ROAD_PULL_K = 8e-6;

export function createRoadNoiseTexture(): DataTexture {
  const tex = new DataTexture(makeRoadNoise(), ROAD_NOISE_SIZE, ROAD_NOISE_SIZE, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function createWhiteTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

export interface RoadMaterialPair {
  core: MeshPhysicalMaterial;
  fringe: MeshPhysicalMaterial;
  coreSet: PatchedMaterialSet<MeshPhysicalMaterial>;
  fringeSet: PatchedMaterialSet<MeshPhysicalMaterial>;
  uniforms: Record<string, IUniform>;
}

export interface RoadMaterialDeps {
  materials: TerrainMaterialSet;
  noise: Texture;
  white: Texture;
  patchMaterial: PatchMaterial;
  csm: CSM | null;
}

function spliceRoadShader(shader: WebGLProgramParametersWithUniforms, uniforms: Record<string, IUniform>): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${ROAD_VERTEX_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROAD_VERTEX_BEGIN}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${ROAD_VERTEX_PROJECT}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${ROAD_FRAGMENT_PARS}`)
    .replace('#include <map_fragment>', ROAD_FRAGMENT_SURFACE)
    .replace('#include <roughnessmap_fragment>', ROAD_FRAGMENT_ROUGHNESS)
    .replace('#include <normal_fragment_maps>', ROAD_FRAGMENT_NORMAL)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${ROAD_FRAGMENT_EMISSIVE}`)
    .replace('#include <aomap_fragment>', ROAD_FRAGMENT_AO)
    .replace('float specularIntensityFactor = specularIntensity;', 'float specularIntensityFactor = specularIntensity * rdSpecMul;');
}

/** Compose the road splice after any present or future onBeforeCompile hook. */
function installRoadHook(mat: MeshPhysicalMaterial, uniforms: Record<string, IUniform>, key: string): void {
  let prior = mat.onBeforeCompile;
  const composed = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer): void => {
    prior.call(mat, shader, renderer);
    spliceRoadShader(shader, uniforms);
  };
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get: () => composed,
    set: (fn: typeof prior) => {
      prior = fn;
    },
  });
  const priorKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${priorKey()}|road:${key}`;
}

function primarySet(info: RoadRibbonInfo, m: TerrainMaterialSet): { set: TerrainTextureSet; tile: number } {
  if (info.style === 'dirt') return { set: m.dirt, tile: TERRAIN_TILE_M.dirt };
  return { set: m.asphalt, tile: TERRAIN_TILE_M.asphalt };
}

export function createRoadMaterials(info: RoadRibbonInfo, seed: number, deps: RoadMaterialDeps): RoadMaterialPair {
  const sp = ROAD_STYLE_PARAMS[info.style];
  const { set, tile } = primarySet(info, deps.materials);
  const p = info.profile;
  const g = deps.materials.gravel;
  // Closed loops keep v-periods integral (V_PERIOD_M): no v offset there.
  const seedV = p.closed ? 0 : ((seed * 37.17) % 48) + 3;
  const uniforms: Record<string, IUniform> = {
    tCol: { value: set.color },
    tNrm: { value: set.normal },
    tRgh: { value: set.rough },
    tAO: { value: set.ao ?? deps.white },
    tGCol: { value: g.color },
    tGNrm: { value: g.normal },
    tNoise: { value: deps.noise },
    uHalfW: { value: info.halfWidth },
    uShoulder: { value: p.shoulder },
    uInset: { value: info.vergeHalf + 0 - info.coreHalf },
    uFringeW: { value: info.fringe },
    uFillet: { value: info.fillet },
    uLanes: { value: Math.max(1, p.lanes) },
    uTile: { value: tile },
    uSeed: { value: new Vector2(((seed * 13.7) % 24) + 1, seedV) },
    uWear: { value: sp.wear },
    uRetro: { value: 0.5 },
    uPullK: { value: ROAD_PULL_K },
    uPullRank: { value: info.style === 'dirt' ? 0 : 1 },
  };
  const markDefine = info.style === 'dirt' ? 'MARK_NONE' : `MARK_${p.markings.toUpperCase()}`;
  const styleDefine = `STYLE_${info.style.toUpperCase()}`;
  const make = (fringe: boolean): { mat: MeshPhysicalMaterial; set: PatchedMaterialSet<MeshPhysicalMaterial> } => {
    const mat = new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      // Rough asphalt/gravel/dirt: a full-strength F0 sheens white under the dawn sky.
      specularIntensity: ROAD_SPECULAR,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      transparent: fringe,
      depthWrite: !fringe,
    });
    mat.name = `road:${p.id}:${fringe ? 'fringe' : 'core'}`;
    mat.defines = { [styleDefine]: '', [markDefine]: '', ...(fringe ? { RD_FRINGE: '' } : {}) };
    const patched = deps.patchMaterial(mat, { csm: deps.csm });
    installRoadHook(mat, uniforms, `${info.style}.${markDefine}.${fringe ? 'f' : 'c'}`);
    mat.needsUpdate = true;
    return { mat, set: patched };
  };
  const core = make(false);
  const fr = make(true);
  return { core: core.mat, fringe: fr.mat, coreSet: core.set, fringeSet: fr.set, uniforms };
}
