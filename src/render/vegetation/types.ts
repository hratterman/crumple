/**
 * Vegetation visuals — P5 contract (U4; docs/CONTRACTS.md "P5 contracts").
 * Change only via that doc. Main thread only. Input is the pure scatter
 * (src/world/vegetation.ts, computed in the terrain helper worker and
 * transferred with the terrain: LoadedTerrain.vegetation).
 *
 * DRAWING (per QualityPreset):
 *   - instance i is eligible iff rank[i] < vegetationDensity OR it is a
 *     collider (collider[i] ≥ 0: never culled by density);
 *   - trees within vegetationNearM: instanced MESH (≤ vegetationMeshCap,
 *     nearest first; LOD0 ≤ VEG_TREE_MAX_TRIS triangles), beyond it to
 *     vegetationFarM: IMPOSTOR (camera-facing billboard / octahedral
 *     atlas, cross-faded over VEG_LOD_FADE_M with dithering), beyond: none
 *     (fog + far land); shrubs/rocks/boulders: mesh only, culled at
 *     min(vegetationFarM, 350 m); per-chunk (64 m) CPU culling, instance
 *     buffers rebuilt only when the camera moves > 8 m or the level changes;
 *   - wind sway in the vertex shader (uniform time = WorldFrame.time,
 *     amplitude ∝ (height/treeHeight)², gusts from a scrolling noise),
 *     the SAME displacement in the depth material (shadows sway too);
 *   - shadows: tree meshes cast into cascades [0, vegetationShadowCascades)
 *     only; impostors, shrubs, rocks and grass never cast;
 *   - grass tufts: instanced cards within grassRadiusM on grass-splat
 *     ground (density ∝ grass weight, none on roads/verges), from camera-
 *     centred tiles with a deterministic per-tile hash, faded at the
 *     radius, LAYER_NO_REFLECTION;
 *   - every lit material via patchMaterial({csm}).
 * Budgets: ≤ VEG_DRAW_BUDGET draws in the main pass, ≤ 4 per casting cascade.
 */
import type { TerrainData, TerrainSampler, VegetationScatter } from '../../world/types';
import type { LightingStack, PatchMaterial, RenderContext, WorldLayerRenderer } from '../types';

export const VEG_TREE_MAX_TRIS = 1800;
export const VEG_LOD_FADE_M = 12;
export const VEG_DRAW_BUDGET = 14;

export interface VegetationStats {
  eligible: number;
  meshInstances: number;
  impostors: number;
  grassTufts: number;
  drawCalls: number;
}
export interface VegetationRenderer extends WorldLayerRenderer {
  readonly stats: VegetationStats;
}
export interface VegetationRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
/** U4: src/render/vegetation/index.ts. */
export type CreateVegetationRenderer = (
  ctx: RenderContext,
  scatter: VegetationScatter,
  terrain: TerrainData,
  sampler: TerrainSampler,
  opts: VegetationRendererOptions,
) => VegetationRenderer;
