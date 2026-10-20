/**
 * Prop visuals — P5 contract (U2; docs/CONTRACTS.md "P5 contracts").
 * Change only via that doc. Main thread only (three allowed); imports the
 * pure prop modules (src/sim/props/{types,catalog,placement}.ts, P5
 * boundary amendment), never sim internals.
 *
 * INSTANCED FLEXBODY (why: 100–250 small props; one flexskin + node texture
 * + draw per panel per prop would cost hundreds of draws per pass):
 *   - per PropKey ONE binding: bindRigPanels(compileRig(def.rig), key,
 *     visual.panels, tessellate(visual)) — every instance of a key shares
 *     the rest geometry, triads and coefficients;
 *   - ONE shared props node texture (RGBA32F, width NODE_TEX_WIDTH = 64,
 *     Nearest, texelFetch): instance j's nodes occupy texels
 *     [base_j, base_j + nodeCount) of block A (xyz = world − propsOrigin,
 *     w = NODE_TEX_FLAG_*), block B (strain, scuff, 0, 0) like vehicles;
 *     propsOrigin = camera position snapped to 64 m (f32 precision),
 *     the props root Object3D sits there;
 *   - per (key, material slot) ONE InstancedBufferGeometry draw; per-
 *     instance attribute `propNodeBase` (float, exact) is added to every
 *     triad index; patch key PROP_FLEX_PATCH_KEY, same v2 reconstruction as
 *     'flex2' (types.ts "FLEXBODY RECONSTRUCTION v2"), targets color +
 *     depth + distance (props cast deformed shadows);
 *   - per frame: instances culled by their current node AABB (+ margin)
 *     and compacted (instanceCount); sleeping objects (OBJECT_FLAG_SLEEPING)
 *     skip their texel writes; the texture uploads only when a snapshot
 *     tick changed something.
 * Budgets: main pass ≤ PROP_DRAW_BUDGET draws for all props; props cast
 * only into CSM cascades [0, PROP_SHADOW_CASCADES); no per-prop lights.
 */
import type { Object3D } from 'three';

import type { BeamBreakEvent, ImpactEvent } from '../../protocol/events';
import type { PropInstance, PropKey } from '../../sim/props/types';
import type { LightingStack, PatchMaterial, RenderContext, WorldLayerRenderer } from '../types';
import type { PanelDef, SurfaceSpec } from '../vehicle/types';

/** Prop material slots (U2 creates one base material per slot, patched once per (key, slot) batch). */
export type PropMaterialSlot =
  | 'conePlastic' //   fluorescent orange PE, slightly translucent look (no transmission)
  | 'reflective' //    retro-reflective sleeve / sign sheeting (bright at grazing headlight angles)
  | 'barrelPaint' //   painted steel drum (chipped, dented → strain shading)
  | 'rubber' //        tyre rubber (sidewall + tread pattern)
  | 'cardboard'
  | 'wood'
  | 'concrete'
  | 'galvanized' //    pole / post steel
  | 'signFace' //      printed sign face (procedural canvas texture)
  | 'lampLens'; //     light-pole lamp (emissive at night: off in golden hour)

/** One prop's visual: panels bound to the catalog rig's nodes (node-id prefixes per PropDef doc). */
export interface PropVisualDef {
  prop: PropKey;
  /** kind is 'body' for every prop panel; detach/glass unused (null / absent). */
  panels: readonly PanelDef<PropMaterialSlot>[];
}
/** Same schema as vehicle panels (LoftSurface | MeshSurface, rig-local REST, prop frame). */
export type PropSurfaceSpec = SurfaceSpec;

export const PROP_FLEX_PATCH_KEY = 'flexI1';
export const PROP_DRAW_BUDGET = 24;
export const PROP_SHADOW_CASCADES = 2;

export interface PropRendererStats {
  instances: number;
  visibleInstances: number;
  awake: number;
  drawCalls: number;
}

export interface PropRenderer extends WorldLayerRenderer {
  /** Dynamic props (spawnProps): adds instances (objectId must be a prop id); safe at any time. */
  addInstances(list: readonly PropInstance[]): void;
  removeInstance(objectId: number): void;
  /** Optional prop scuffs / crush shading (events of prop objects only). */
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  readonly stats: PropRendererStats;
  /** For the near-caster / perf overlay. */
  readonly root: Object3D;
  /**
   * P7 replay (additive): copies the visual damage + node-texture state
   * (scuffs, broken flags, strain persistence, written poses, the texture
   * itself) into `into` (reused when it fits). Restoring reproduces the
   * look exactly; the next update rewrites every prop present in the frame
   * from its nodes WITHOUT the reset-jump damage clear (`rewrite`, seeks).
   */
  saveState(into?: PropVisualState | null): PropVisualState;
  restoreState(s: PropVisualState, rewrite?: boolean): void;
}
/** Opaque PropRenderer.saveState snapshot. */
export interface PropVisualState {
  readonly ids: Int32Array;
  readonly f32: Float32Array;
  readonly f64: Float64Array;
  readonly u8: Uint8Array;
  readonly tex: Float32Array;
}
export interface PropRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
/** U2: src/render/props/index.ts. `instances` = resolvePropInstances(layout.props, heightAt) (main, same as the worker). */
export type CreatePropRenderer = (ctx: RenderContext, instances: readonly PropInstance[], opts: PropRendererOptions) => PropRenderer;
