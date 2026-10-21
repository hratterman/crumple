/**
 * Render-side contracts — FROZEN (P3). Types + small constant tables only;
 * implementations live in the modules named on each factory. Main thread
 * only (three allowed); never imports src/sim.
 *
 * Frame order (main.ts / app loop), every frame:
 *   1. sim interpolation → vehicle/FX updates
 *   2. camera update
 *   3. lighting.update(camera)   (CSM cascade fit — needs the final camera)
 *   4. terrain.update(camera), roads.update(camera)   (LOD / culling)
 *   5. quality.frame(dtS)        (adaptive resolution; may call setSize)
 *   6. post.render(dtS)          (never renderer.render directly)
 */
import type {
  Camera,
  DirectionalLight,
  Material,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from 'three';
import type { TrafficDensity } from '../protocol/traffic';
import type { CSM } from 'three/examples/jsm/csm/CSM.js';
import type { EffectComposer } from 'postprocessing';

import type { TerrainTextureSet } from '../assets/loader';
import type { HdriName, TerrainSlug } from '../assets/manifest';
import type { TerrainData, TerrainSampler } from '../world/types';
import type { EnvironmentController, WeatherPreset } from './lighting/environment';
import type { EnvOptions } from './lighting/envUniforms';

// ============================================================ quality
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface AdaptiveResolution {
  enabled: boolean;
  /** Frame-rate the controller defends (EMA of frame time). */
  targetFps: number;
  /** Lowest render scale (fraction of the capped pixel ratio), 0..1. */
  minScale: number;
}

export interface QualityPreset {
  level: QualityLevel;
  /** renderer.setPixelRatio(min(devicePixelRatio, cap) × adaptive scale). */
  pixelRatioCap: number;
  /** Per-cascade shadow map edge, px. */
  shadowMapSize: number;
  csmCascades: number;
  /** CSM maxFar, m (shadows end there; fade on). */
  csmFar: number;
  aoEnabled: boolean;
  /** n8ao aoSamples (denoise samples follow at half). */
  aoSamples: number;
  bloom: boolean;
  smaa: boolean;
  /** Multiplies terrain/road LOD switch distances (1 = TERRAIN_LOD_DISTANCES). */
  terrainLodBias: number;
  /** P5: 0..1 fraction of the vegetation instance budget (instance i drawn iff rank < density, or it is a collider). */
  vegetationDensity: number;
  /** P5: max live particles across all FX pools. */
  particleBudget: number;
  /** P5 FX: skidmark ribbon segment pool (all wheels; the oldest segment is recycled). */
  skidSegments: number;
  /** P5 FX: pooled rigid debris chunks (instanced; oldest recycled). */
  debrisBudget: number;
  /** P5 vegetation: mesh → impostor switch distance, m (× nothing; already per level). */
  vegetationNearM: number;
  /** P5 vegetation: impostors culled beyond this, m (fog + far land take over). */
  vegetationFarM: number;
  /** P5 vegetation: max near-mesh tree instances drawn per frame (nearest first). */
  vegetationMeshCap: number;
  /** P5 vegetation: grass-tuft radius around the camera, m (0 = no grass). */
  grassRadiusM: number;
  /** P5 vegetation: tree meshes cast into CSM cascades [0, n) only (0 = no tree shadows; impostors never cast). */
  vegetationShadowCascades: number;
  /** P5 water: 'env' = fresnel × environment/sky only; 'planar' = + planar reflection render. */
  waterReflection: 'env' | 'planar';
  /** P5 water: planar reflection target size as a fraction of the drawing buffer (ignored for 'env'). */
  waterReflectionScale: number;
  /**
   * P6 AI traffic density + awake budget (sent in `setTraffic` /
   * `setTrafficDensity`; a quality change retunes it without a restart).
   * Physics cost, not GPU: see the CONTRACTS P6 awake-budget table.
   */
  traffic: TrafficDensity;
  adaptiveResolution: AdaptiveResolution;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualityPreset>> = {
  low: {
    level: 'low',
    pixelRatioCap: 1,
    shadowMapSize: 1024,
    csmCascades: 2,
    csmFar: 150,
    aoEnabled: false,
    aoSamples: 8,
    bloom: false,
    smaa: true,
    terrainLodBias: 0.6,
    vegetationDensity: 0.25,
    particleBudget: 600,
    skidSegments: 512,
    debrisBudget: 48,
    vegetationNearM: 50,
    vegetationFarM: 300,
    vegetationMeshCap: 300,
    grassRadiusM: 0,
    vegetationShadowCascades: 0,
    waterReflection: 'env',
    waterReflectionScale: 0,
    traffic: { agents: 8, maxAwake: 1, awakePoolBeams: 2500 },
    adaptiveResolution: { enabled: true, targetFps: 50, minScale: 0.6 },
  },
  medium: {
    level: 'medium',
    pixelRatioCap: 1.25,
    shadowMapSize: 2048,
    csmCascades: 3,
    csmFar: 250,
    aoEnabled: true,
    aoSamples: 8,
    bloom: true,
    smaa: true,
    terrainLodBias: 1,
    vegetationDensity: 0.5,
    particleBudget: 1500,
    skidSegments: 1024,
    debrisBudget: 96,
    vegetationNearM: 80,
    vegetationFarM: 450,
    vegetationMeshCap: 800,
    grassRadiusM: 25,
    vegetationShadowCascades: 1,
    waterReflection: 'env',
    waterReflectionScale: 0,
    traffic: { agents: 14, maxAwake: 2, awakePoolBeams: 4000 },
    adaptiveResolution: { enabled: true, targetFps: 60, minScale: 0.7 },
  },
  high: {
    level: 'high',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    csmCascades: 4,
    csmFar: 400,
    aoEnabled: true,
    aoSamples: 16,
    bloom: true,
    smaa: true,
    terrainLodBias: 1.4,
    vegetationDensity: 0.8,
    particleBudget: 3000,
    skidSegments: 2048,
    debrisBudget: 192,
    vegetationNearM: 120,
    vegetationFarM: 650,
    vegetationMeshCap: 1600,
    grassRadiusM: 40,
    vegetationShadowCascades: 2,
    waterReflection: 'planar',
    waterReflectionScale: 0.5,
    traffic: { agents: 20, maxAwake: 3, awakePoolBeams: 5000 },
    adaptiveResolution: { enabled: true, targetFps: 60, minScale: 0.75 },
  },
  ultra: {
    level: 'ultra',
    pixelRatioCap: 2,
    shadowMapSize: 4096,
    csmCascades: 4,
    csmFar: 600,
    aoEnabled: true,
    aoSamples: 32,
    bloom: true,
    smaa: true,
    terrainLodBias: 2,
    vegetationDensity: 1,
    particleBudget: 6000,
    skidSegments: 4096,
    debrisBudget: 320,
    vegetationNearM: 170,
    vegetationFarM: 900,
    vegetationMeshCap: 3000,
    grassRadiusM: 60,
    vegetationShadowCascades: 3,
    waterReflection: 'planar',
    waterReflectionScale: 0.75,
    traffic: { agents: 28, maxAwake: 4, awakePoolBeams: 6500 },
    adaptiveResolution: { enabled: false, targetFps: 60, minScale: 1 },
  },
};
/** Default when settings hold nothing (1080p mid-range target: 60 fps). */
export const DEFAULT_QUALITY: QualityLevel = 'high';

// ============================================================ P5 world layer (shared)
/**
 * Render layer for objects that must NOT appear in the water's planar
 * reflection (particles, skidmarks, grass, the water itself). Such objects
 * enable this layer IN ADDITION to layer 0's role: they call
 * `obj.layers.set(LAYER_NO_REFLECTION)` and the main camera enables it
 * (`camera.layers.enable(LAYER_NO_REFLECTION)`, done once in main.ts); the
 * reflection camera only sees layer 0. (CSM shadow passes test layers
 * against the VIEW camera, so these still follow castShadow.)
 */
export const LAYER_NO_REFLECTION = 2;

/** Structural twin of SimClient's ObjectRange (render must not import src/app). */
export interface SimObjectSlice {
  objectId: number;
  /** Snapshot OBJECT_FLAG_* (bit0 sleeping). */
  flags: number;
  nodeOffset: number;
  nodeCount: number;
  beamOffset: number;
  beamCount: number;
}

/**
 * One frame of world-layer input, built ONCE per frame by main.ts and
 * handed to every P5 renderer's update(frame) (props, FX, vegetation,
 * water). Valid only during the frame (arrays are reused).
 */
export interface WorldFrame {
  /** Render dt, s (0 on the boot frame). */
  dtS: number;
  /** Wall-clock seconds since boot (wind, waves, flicker): monotonic, never scaled. */
  time: number;
  /** Interpolated sim time, s (FX ages scale with the sim: slow-mo slows smoke). */
  simTime: number;
  /** Sim timescale in effect (0 paused … 1). */
  timeScale: number;
  /** The final camera of this frame (main updates it before the camera-dependent renderers run). */
  camera: PerspectiveCamera;
  /** SimClient.interpolate output (global, xyz interleaved, world m); length ≥ 3·Σ nodeCount. */
  nodes: Float32Array;
  /** false when no snapshot pair was available this frame (nodes stale: keep last state). */
  interpolated: boolean;
  /** Ascending objectId (SimClient.objectRanges()). */
  objects: readonly SimObjectSlice[];
  /** Latest snapshot tick (snapshot-rate work runs when it changes). */
  tick: number;
}

/** Common shape of the P5 world-layer renderers (props, FX, vegetation, water). */
export interface WorldLayerRenderer {
  /** Add to the scene by the caller. */
  readonly object: Object3D;
  update(frame: WorldFrame): void;
  setQuality(q: QualityPreset): void;
  dispose(): void;
}

// ============================================================ context
/**
 * Shared render state handed to every stack/renderer factory. `quality` is
 * the CURRENT preset; whoever changes it (QualityController) calls
 * setQuality on every stack. The renderer is created by app code with
 * { antialias: false, powerPreference: 'high-performance' } (SMAA does AA),
 * outputColorSpace sRGB, toneMapping NoToneMapping (ACES is an effect),
 * shadowMap.enabled = true.
 */
export interface RenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  quality: QualityPreset;
  /** CSS-pixel drawing size (before pixel ratio). */
  width: number;
  height: number;
  /** Terrain queries for cameras/placement (null until the world loads). */
  sampler: TerrainSampler | null;
}

// ============================================================ lighting (C: src/render/lighting.ts)
export interface LightingOptions {
  /** Default 'kiara_1_dawn' (golden hour); loader falls back to the procedural sky. */
  hdri?: HdriName;
  /** Unit vector from the ground TOWARD the sun; default matched to the HDRI's sun. */
  sunDirection?: readonly [number, number, number];
  /** Linear RGB hex; default warm 0xffd9a8. */
  sunColor?: number;
  /** Physical-ish intensity of the key light (each CSM cascade light); default ~6. */
  sunIntensity?: number;
  /** scene.environmentIntensity; default 1. */
  envIntensity?: number;
  /** Height-fog density (FogExp2) at the base height, 0 disables; default 0.00045 (gentle haze over 1.4 km). */
  fogDensity?: number;
  /** R-GFX time of day: initial local solar hours (default DEFAULT_TIME_OF_DAY, golden afternoon). */
  time?: number;
  /** R-GFX: game seconds per real second (0 = frozen, the default). */
  timeSpeed?: number;
  /** R-GFX: initial weather preset (default 'clear'). */
  weather?: WeatherPreset;
}

export interface LightingStack {
  /**
   * Key-light descriptor. With CSM active, CSM's cascade lights carry the
   * illumination and `sun` is NOT in the scene (direction/color holder for
   * sky, fog, water, lens FX). With csm = null (fallback when the GPU lacks
   * texture units) `sun` is a shadow-casting light in the scene.
   */
  readonly sun: DirectionalLight;
  /** Unit vector toward the sun (shared, do not mutate). */
  readonly sunDirection: Vector3;
  readonly csm: CSM | null;
  /** PMREM-filtered environment (scene.environment). */
  readonly environment: Texture;
  /**
   * R-GFX (additive): time of day + weather controller (lighting/environment.ts).
   * Absent on stand-in stacks (showroom studio, dev harnesses).
   */
  readonly env?: EnvironmentController;
  /** Fit cascades to the camera; call once per frame after the camera moved. */
  update(camera: Camera): void;
  /** Rebuild cascades / shadow maps for a new preset (re-patches CSM uniforms). */
  setQuality(q: QualityPreset): void;
  dispose(): void;
}
/** Async because the HDRI loads; never rejects for missing assets (procedural fallback). */
export type CreateLightingStack = (ctx: RenderContext, opts?: LightingOptions) => Promise<LightingStack>;

// ============================================================ post (C: src/render/post.ts)
/**
 * Pipeline (FROZEN order): RenderPass → N8AOPostPass → [SanitizePass, when
 * bloom is on: NaN/Inf/overflow guard, docs/CONTRACTS.md "Render budget
 * amendments"] → EffectPass(SMAA, Bloom, [DoF P7], ToneMapping ACES_FILMIC). Composer frameBufferType
 * HalfFloatType, multisampling 0. n8ao `gammaCorrection = false` (the final
 * EffectPass does the sRGB output conversion); `configuration.screenSpaceRadius`
 * false, aoRadius ~2 m. Disabled effects are removed from the pass, not
 * just zeroed (no cost).
 */
export interface PostStack {
  readonly composer: EffectComposer;
  /** Renders the frame (the ONLY place the scene is drawn). */
  render(dtS: number): void;
  /** CSS pixels; applies the current pixel ratio × adaptive scale. */
  setSize(width: number, height: number): void;
  setQuality(q: QualityPreset): void;
  /** Reserved P7 (photo mode / slow-mo DoF): null disables. */
  setDepthOfField?(opts: { focusDistance: number; focalLength: number; bokehScale: number } | null): void;
  /**
   * R-GFX (additive) eye adaptation: the current auto-exposure factor
   * (applied after bloom, before tone mapping; renderer.toneMappingExposure
   * stays the photo-mode EV) and `snap()` to skip the adaptation after a cut.
   */
  readonly exposure?: { readonly value: number; snap(): void; readonly target?: number; set?(value: number, target?: number): void };
  /** R-GFX (additive): rain drops on the lens, 0 = off (the pass is removed). */
  setLensRain?(amount: number, timeS: number): void;
  dispose(): void;
}
export type CreatePostStack = (ctx: RenderContext) => PostStack;

// ============================================================ quality controller (C: src/app/quality.ts)
/**
 * Owns ctx.quality. Adaptive resolution: EMA of frame time (τ ≈ 1 s); below
 * targetFps·0.9 for 2 s → scale −0.1; above targetFps·1.15 for 4 s → +0.05;
 * clamp [minScale, 1]; applied via renderer.setPixelRatio + post.setSize.
 */
export interface QualityController {
  readonly preset: QualityPreset;
  /** Current adaptive render scale (1 = full). */
  readonly scale: number;
  setLevel(level: QualityLevel): void;
  frame(dtS: number): void;
}
export type CreateQualityController = (
  ctx: RenderContext,
  targets: { lighting: LightingStack; post: PostStack; others?: readonly { setQuality(q: QualityPreset): void }[] },
) => QualityController;

// ============================================================ material patching (C: src/render/material.ts)
/**
 * One shader feature. `apply` edits the program parameters inside the
 * composed onBeforeCompile (chunk replacement on shader.vertexShader /
 * fragmentShader, uniforms on shader.uniforms). It must be idempotent per
 * compile, and `key` must uniquely describe everything that changes the
 * generated GLSL (it becomes part of customProgramCacheKey).
 */
export interface ShaderPatch {
  readonly key: string;
  /** Which materials of the set this patch touches. */
  readonly targets: readonly PatchTarget[];
  apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget, renderer: WebGLRenderer): void;
}
export type PatchTarget = 'color' | 'depth' | 'distance';

export interface MaterialFeatures {
  /** Receive cascaded shadows (every lit, shadow-receiving material: terrain, roads, cars, props). */
  csm?: CSM | null;
  /** P4 flexbody skinning (vertex chunk: node-texture triad skinning of position/normal/tangent). Targets color + depth + distance. */
  flexbody?: ShaderPatch;
  /** P4 damage (plastic strain → darken/roughen/normal perturb; uniforms + fragment chunks). Targets color only unless it displaces. */
  damage?: ShaderPatch;
  /**
   * R-GFX: the environment patch (aerial perspective + time-of-day / weather
   * uniforms) is added automatically to every material patched with a CSM;
   * false opts out (e.g. materials with their own sky handling); options:
   * `lamp` = a lamp lens whose emissive runs at that fraction by day.
   */
  env?: false | EnvOptions;
}

/**
 * Result of patchMaterial. Assign ALL of them to the mesh:
 *   mesh.material = set.color;
 *   mesh.customDepthMaterial = set.depth ?? undefined;     // directional/spot shadows (CSM cascades)
 *   mesh.customDistanceMaterial = set.distance ?? undefined; // point-light shadows
 * depth/distance are null when no feature targets them (three's defaults are
 * then correct: geometry is not deformed in the vertex stage).
 */
export interface PatchedMaterialSet<M extends Material = Material> {
  color: M;
  depth: MeshDepthMaterial | null;
  distance: MeshDistanceMaterial | null;
}

/**
 * COMPOSITION ORDER — FROZEN (PATCH_ORDER):
 *   1. csm       csm.setupMaterial(color) FIRST. It sets defines
 *                (USE_CSM, CSM_CASCADES, CSM_FADE) and OVERWRITES
 *                color.onBeforeCompile with its uniform hook. patchMaterial
 *                captures that hook and only then installs the composed
 *                hook. Never applied to depth/distance (cascade lights
 *                render those with the plain depth path). CSM's global
 *                ShaderChunk swap (lights_*_begin) only activates under
 *                USE_CSM, so un-patched materials are unaffected — but they
 *                receive NO cascaded shadows.
 *   2. flexbody  vertex stage: replaces <begin_vertex>, <beginnormal_vertex>
 *                (and tangent) with triad skinning; applied to color AND
 *                depth (RGBADepthPacking) AND distance materials — otherwise
 *                shadows are cast by the undeformed body.
 *   3. damage    fragment uniforms/chunks after flexbody (reads the skinned
 *                normal); color only unless its targets say otherwise.
 * Composed hook per material: prior hook (CSM's, or the material's own
 * pre-existing one) → each feature's apply in PATCH_ORDER for that target.
 * customProgramCacheKey = previous key + '|' + feature keys in PATCH_ORDER.
 * patchMaterial sets needsUpdate; calling it twice on one material throws
 * (patch a fresh clone instead).
 */
export const PATCH_ORDER = ['csm', 'flexbody', 'damage'] as const;
export type PatchMaterial = <M extends Material>(material: M, features: MaterialFeatures) => PatchedMaterialSet<M>;

// ============================================================ terrain (B: src/render/terrain/)
/** The 5 loaded PBR sets (assets/loader loadAllTerrainSets). */
export type TerrainMaterialSet = Readonly<Record<TerrainSlug, TerrainTextureSet>>;

/** World-space texture tile size per set, m (one texture repeat). */
export const TERRAIN_TILE_M: Readonly<Record<TerrainSlug, number>> = {
  asphalt: 4,
  grass: 3,
  dirt: 3.5,
  rock: 6,
  gravel: 2.5,
};
/**
 * Chunked LOD: chunks of TERRAIN_CHUNK_CELLS (world/types) cells; LOD k
 * uses every 2^k-th sample. Switch distances (camera → chunk AABB, m),
 * multiplied by QualityPreset.terrainLodBias. Beyond the last entry: LOD 3.
 * Adjacent chunks may differ by any number of levels: skirts
 * (TERRAIN_SKIRT_M deep) hide cracks; no stitching required.
 */
export const TERRAIN_LOD_DISTANCES: readonly number[] = [96, 220, 480];
export const TERRAIN_SKIRT_M = 2;

export interface TerrainRendererOptions {
  /** For patchMaterial({ csm }) on the terrain material. */
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
/**
 * Terrain mesh + splat material. Material contract:
 *  - vertex heights from TerrainData.heights; vertex normals = the
 *    sampler's smoothed normal (same formula as collision);
 *  - splat = DataTexture(RGBA8, linear filter, no mips) of TerrainData.splat;
 *    weights per SPLAT_* with implicit grass (world/types);
 *  - each set sampled in world XZ at TERRAIN_TILE_M, with TRIPLANAR on rock
 *    (and any fragment whose normal.y < 0.7) to avoid stretching on cliffs;
 *    height-blend sharpening between sets is allowed, colour must stay
 *    within the 5-weight blend;
 *  - concrete (material map == MaterialId.concrete) = paved set, tinted
 *    lighter/greyer (material map uploaded as an R8 nearest texture);
 *  - receives CSM shadows (patchMaterial csm), casts shadows only at LOD ≥ 1
 *    chunks within csmFar (self-shadowing of hills at golden hour).
 */
export interface TerrainRenderer {
  /** Add to the scene by the caller. */
  readonly object: Object3D;
  update(camera: Camera): void;
  setQuality(q: QualityPreset): void;
  readonly stats: { chunks: number; visibleChunks: number; triangles: number };
  dispose(): void;
}
export type CreateTerrainRenderer = (
  ctx: RenderContext,
  terrain: TerrainData,
  materials: TerrainMaterialSet,
  opts: TerrainRendererOptions,
) => TerrainRenderer;

// ============================================================ roads (E: src/render/roads/)
/** Ribbon vertices sit this far above the carved terrain (plus polygonOffset −1/−1). */
export const RIBBON_LIFT_M = 0.03;
/** Max lateral vertex spacing across a ribbon, m (conforms to the banked, carved cross-section). */
export const RIBBON_LATERAL_STEP_M = 1;
/**
 * Road ribbons for every RoadProfile with surface 'ribbon':
 *  - one strip per road from TerrainData.roads stations (ROAD_STATION_SPACING
 *    along, ≤ RIBBON_LATERAL_STEP_M across the carriageway width); vertex
 *    y = sampler.heightAt(x, z) + RIBBON_LIFT_M (collision == visual);
 *  - UV: u = signed lateral offset d in m (+ right of travel), v = arc
 *    distance s in m — markings are procedural in the fragment shader from
 *    (u, v, lanes, markings, curvature attribute), so nothing is texture-
 *    baked; asphalt set at TERRAIN_TILE_M.asphalt (concrete roads tinted);
 *  - junctions: a lower-priority road's ribbon stops at the higher-priority
 *    road's carriageway edge (that ribbon covers the junction area); its
 *    markings fade out over the last 6 m. Equal-priority crossings (town
 *    streets): the earlier-declared road is continuous, the other stops;
 *  - verges are terrain splat (gravel), not ribbon;
 *  - receives CSM; never casts.
 * Chunked like the terrain (per 64 m chunk) for frustum culling; no LOD
 * below ribbon level (thin geometry), but chunks beyond csmFar drop markings.
 */
export interface RoadRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
export interface RoadRenderer {
  readonly object: Object3D;
  update(camera: Camera): void;
  setQuality(q: QualityPreset): void;
  dispose(): void;
}
export type CreateRoadRenderer = (
  ctx: RenderContext,
  terrain: TerrainData,
  sampler: TerrainSampler,
  materials: TerrainMaterialSet,
  opts: RoadRendererOptions,
) => RoadRenderer;
