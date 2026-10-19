/**
 * Water — P5 contract (U5; docs/CONTRACTS.md "P5 contracts"). Change only
 * via that doc. Main thread only. Input: resolveWater(layout, terrain)
 * (src/world/water.ts; the worker uses the same bodies for buoyancy).
 *
 * SURFACE: per WaterBody a flat grid at y = level over [minX, maxX] ×
 * [minZ, maxZ], cells whose four terrain corners are all above
 * level + 0.5 dropped. Material (own ShaderMaterial or a patched standard
 * one; receives CSM via patchMaterial({csm}) for sun-glint masking):
 *   - normals: two scrolling normal maps (procedural, WaterOptics
 *     waveScale/waveSpeed, WorldFrame.time), distance-faded;
 *   - DEPTH: a float height texture of the terrain over the body rect
 *     (R32F, linear) → water depth d = level − h at the fragment; view
 *     path ≈ d / max(cos θ_view, 0.2); colour = mix(shallowColor,
 *     deepColor, 1 − exp(−absorption·path)) over the refracted bed, alpha
 *     from the same absorption (soft intersection: alpha → 0 as d → 0, so
 *     no hard shoreline seam); shoreline foam where d < foamDepth (noise-
 *     broken band);
 *   - REFLECTION: Schlick fresnel × (planar texture | PMREM env / sky)
 *     + sun specular (GGX, roughness from the wave normal);
 *   - RADIANCE CAP: final colour finite and ≤ WATER_MAX_RADIANCE (sun glints
 *     otherwise reach Inf in HalfFloat; the post SanitizePass is the last
 *     line of defence, not the plan);
 *   - transparent, depthWrite true, renderOrder WATER_RENDER_ORDER (after
 *     opaque, before particles), never casts, LAYER_NO_REFLECTION.
 * PLANAR REFLECTION (QualityPreset.waterReflection 'planar'): inside
 * update(frame), after lighting/terrain/vegetation updates, before
 * post.render: mirror the camera about y = level, oblique near plane at
 * the surface, render layer 0 only (no particles/grass/water) into a
 * HalfFloat target at waterReflectionScale × drawing buffer, shadow-map
 * auto-update off for the pass, ≤ WATER_REFLECTION_DRAW_BUDGET draws
 * (colliders, props, vehicles, tree impostors; the terrain chunks and road
 * ribbons are replaced for the pass by ONE coarse vertex-coloured terrain
 * proxy on WATER_REFLECTION_LAYER 3, seen only by the reflection camera:
 * the chunked terrain alone was ~300 draws looking across the lake);
 * skipped when no body is in the frustum, the camera is farther than
 * WATER_REFLECTION_MAX_DIST_M from the body rect, or the CSM shadow maps do
 * not exist yet (the pass samples them without rendering them).
 * REFRACTION: the water's onBeforeRender copies the bound colour buffer
 * (copyFramebufferToTexture, once per render call) as the refracted bed.
 */
import type { TerrainData, WaterBody } from '../../world/types';
import type { LightingStack, PatchMaterial, RenderContext, WorldLayerRenderer } from '../types';

export const WATER_MAX_RADIANCE = 64;
export const WATER_RENDER_ORDER = 10;
export const WATER_REFLECTION_DRAW_BUDGET = 80;
export const WATER_REFLECTION_MAX_DIST_M = 900;

export interface WaterStats {
  bodies: number;
  reflectionRendered: boolean;
  reflectionDraws: number;
}
export interface WaterRenderer extends WorldLayerRenderer {
  readonly stats: WaterStats;
}
export interface WaterRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
/** U5: src/render/water/index.ts. */
export type CreateWaterRenderer = (
  ctx: RenderContext,
  bodies: readonly WaterBody[],
  terrain: TerrainData,
  opts: WaterRendererOptions,
) => WaterRenderer;
