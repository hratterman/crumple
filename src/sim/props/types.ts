/**
 * Soft-body PROP contracts — P5 (docs/CONTRACTS.md "P5 contracts").
 *
 * PURE DATA MODULE (like src/sim/rig/types.ts and the vehicle defs): no
 * engine/state/worker imports, no three, no DOM. Main-thread code may import
 * src/sim/props/{types,catalog,placement}.ts and src/sim/props/defs/*.ts
 * (P5 boundary amendment); src/protocol may `import type` from this file.
 *
 * A prop is an ordinary soft-body object (RigDef: nodes + beams, canonical
 * order) that the worker spawns from a catalog KEY. Everything the sim and
 * the renderer must agree on is here: the rig (rest pose), the contact
 * material, buoyancy density, the coarse proxy, sleep parameters and the
 * breakable ground anchor.
 *
 * PROP FRAME (rig-local REST pose): Y up; the BASE rests on y = 0 (lowest
 * node centre − its contact radius = 0, so a prop placed at terrain height
 * touches the ground without popping); "front" = local −Z (same as the
 * vehicle frame and PropPlacement.facing).
 */
import type { MaterialId } from '../../protocol/messages';
import type { PropPlacement } from '../../world/types';
import type { RigDef } from '../rig/types';

/**
 * Catalog keys (FROZEN names once U1 lands the catalog; the layout and saves
 * refer to props by key).
 *  cone          traffic cone, 0.7 m, 4 kg plastic (base square + hollow conical shell)
 *  barrel        200 L steel drum (0.585 m Ø × 0.88 m), 18 kg empty
 *  tire          loose car tyre (0.65 m Ø × 0.2 m), 9 kg, stacks (tire walls)
 *  boxCardboard  0.6 m cardboard box, 3 kg, stacks, crushes easily
 *  boxWood       0.8 m wooden crate, 25 kg, stacks, splinters (beams break)
 *  signPost      2.6 m steel post + 0.6 m sign plate, BREAKABLE ground anchor
 *  lightPole     8 m street light (pole + arm + lamp head), BREAKABLE ground anchor
 *  concreteBlock 1.2 × 0.6 × 0.6 m precast block, 1000 kg (heavy, near-rigid)
 */
export type PropKey =
  | 'cone'
  | 'barrel'
  | 'tire'
  | 'boxCardboard'
  | 'boxWood'
  | 'signPost'
  | 'lightPole'
  | 'concreteBlock';
export const PROP_KEYS: readonly PropKey[] = [
  'cone',
  'barrel',
  'tire',
  'boxCardboard',
  'boxWood',
  'signPost',
  'lightPole',
  'concreteBlock',
];

/** FX / audio surface class of an object (sparks only from metal/concrete; chips, dust, flakes otherwise). */
export type PropSurface = 'plastic' | 'metal' | 'rubber' | 'cardboard' | 'wood' | 'concrete';

/**
 * Coarse rig-local proxy (an axis-aligned box in the PROP frame). Used for:
 * spawn overlap validation (resolvePropInstances), the sleeping-object
 * broadphase box (rotated by the spawn transform; a sleeping prop never
 * moves), render culling of instance batches, and vegetation keep-out.
 * Must enclose every node sphere (node pos ± radius) of the rest pose.
 */
export interface PropProxy {
  center: readonly [number, number, number];
  halfExtents: readonly [number, number, number];
}

/**
 * SLEEP (U1, worker): checked every broadphase rebuild (8–16 steps). An
 * awake prop whose max node speed stays below `linearSpeed` for `holdS`
 * seconds of sim time falls asleep: velocities zeroed, skipped by every
 * pass (beams, contacts, water, integrate), snapshot OBJECT_FLAG_SLEEPING
 * set, positions unchanged. It WAKES when (a) an awake object's fattened
 * AABB overlaps its sleeping box (then the wake propagates once through
 * sleeping boxes touching it: a stack wakes together), (b) resetProps /
 * spawnProps{asleep: false}, (c) a static collider it rests on changes.
 * Vehicles never sleep (P6's bubble owns them).
 */
export interface PropSleepParams {
  /** m/s; max node speed below which the prop counts as still. */
  linearSpeed: number;
  /** s of continuous stillness before sleeping. */
  holdS: number;
  /** Spawn asleep (layout props always do; spawnProps default true). */
  startAsleep: boolean;
}
export const PROP_SLEEP_DEFAULTS: PropSleepParams = { linearSpeed: 0.05, holdS: 0.75, startAsleep: true };

/**
 * BREAKABLE GROUND ANCHOR (signPost, lightPole): the rig itself carries
 * PINNED anchor nodes (mass ≤ 0 → invMass 0, they never move) placed at or
 * just below the base, tied to the free base nodes by anchor beams with
 * breakF = `breakF` (N). A hard hit breaks the anchor beams (beamBreak
 * events → FX) and the post/pole falls as a free soft body. No collider
 * swap: ColliderDef.breakable stays RESERVED/unused (P5 decision).
 * `nodes` = anchor node id prefix glob, e.g. 'anchor_*' (resolved against
 * the rig; ≥ 3 pinned nodes, all with collidable false).
 */
export interface PropAnchor {
  nodes: string;
  /** Anchor beam break force, N (signPost ≈ 1.5e4, lightPole ≈ 4e4: a 50 km/h sedan snaps both). */
  breakF: number;
}

/**
 * The catalog entry. NODE NAMING (U2 binds visuals by these prefixes; ids
 * are `${prefix}${k}` or `${prefix}${ring}_${k}`; every node has one):
 *   cone          base_* (base square), shell_* (cone rings, bottom→top), tip
 *   barrel        rim0_* … rimN_* (rings bottom→top, 12 around), lidT_c, lidB_c (lid centres)
 *   tire          tI_* / tO_* (inner/outer bead rings), tT_* (tread ring)
 *   boxCardboard  c_* (8 corners), f_* (face centres, collision-only allowed)
 *   boxWood       c_*, f_*
 *   signPost      anchor_* (pinned), post_* (post, bottom→top), sign_* (plate corners/centre)
 *   lightPole     anchor_* (pinned), pole_* (bottom→top), arm_*, lamp_*
 *   concreteBlock c_*, f_*
 * Visual panels may bind to a prefix glob ('shell_*', 'sign_*'); a panel
 * must never span the anchor (anchor nodes are never bound).
 */
export interface PropDef {
  key: PropKey;
  name: string;
  /** Rest pose in the PROP frame (base on y = 0). rig.name === key. */
  rig: RigDef;
  surface: PropSurface;
  /**
   * Contact material other objects see in node-vs-node impact/skid events
   * (and buoyancy/FX lookups): plastic 7, metal 6, rubber 8, cardboard 10,
   * wood 9, concrete 5.
   */
  material: MaterialId;
  /**
   * Effective density for BUOYANCY, kg/m³ (node volume V_i = m_i / density;
   * see WATER_PHYSICS in src/world/types.ts). < 1000 floats: cone 600 (air
   * inside), barrel 200 (sealed, empty), tire 700, cardboard 150, wood 550;
   * > 1000 sinks: concreteBlock 2400, signPost/lightPole 7800.
   */
  density: number;
  /** Vertical pitch when stacked (PropPlacement.stack), m. 0 = not stackable. */
  stackHeight: number;
  proxy: PropProxy;
  sleep: PropSleepParams;
  anchor: PropAnchor | null;
  /** Rig-local node ids (origin, front, top) — visual anchor / orientation basis (like VehicleDef.frame). */
  frame: { origin: string; front: string; top: string };
}

/**
 * Rig budgets per prop (validated by U1's catalog test). Totals matter:
 * the awake set must stay inside ~10 M beam-updates/s with the player car
 * (≈ 3.5 k beams), so the AWAKE prop beams are budgeted at
 * PROP_AWAKE_BEAM_BUDGET; props that come to rest go back to sleep.
 */
export const PROP_RIG_BUDGET: Readonly<Record<PropKey, { nodes: number; beams: number }>> = {
  cone: { nodes: 20, beams: 80 },
  barrel: { nodes: 40, beams: 180 },
  tire: { nodes: 40, beams: 140 },
  boxCardboard: { nodes: 14, beams: 60 },
  boxWood: { nodes: 14, beams: 60 },
  signPost: { nodes: 24, beams: 90 },
  lightPole: { nodes: 36, beams: 140 },
  concreteBlock: { nodes: 14, beams: 60 },
};
/** Design budget for simultaneously awake prop beams (2 kHz). Not enforced in P5 (P6 governor). */
export const PROP_AWAKE_BEAM_BUDGET = 2500;
/** Every prop node's node-vs-node contact radius is ≥ this (thin shells must not tunnel at 30 m/s with 8-step rebuilds). */
export const PROP_MIN_OBJ_RADIUS = 0.04;

/**
 * One resolved prop object (pure output of resolvePropInstances, identical
 * in the worker and on main). `index` is the instance's position in the
 * expansion order; layout props get objectId = PROP_LAYOUT_ID_BASE + index.
 */
export interface PropInstance {
  index: number;
  objectId: number;
  /** `${placement.id}` for single props, `${placement.id}.${row}.${level}` for rows/stacks. */
  id: string;
  prop: PropKey;
  /** Rest pose placement: pos = base point (x, terrain y + level·stackHeight, z); quat yaw-only, built with sqrt only (no trig). */
  transform: { pos: [number, number, number]; quat: [number, number, number, number] };
  /** World AABB of the transformed proxy (min xyz, max xyz). */
  aabb: readonly [number, number, number, number, number, number];
  /** Copied from the PropDef (FX / audio need no catalog lookup). */
  surface: PropSurface;
  material: MaterialId;
  padId?: string;
}

/**
 * Pure, deterministic (U1: src/sim/props/placement.ts), used by the worker
 * (spawn on groundHeightfield) AND main (visuals, vegetation keep-out):
 * expands layout.props in declaration order — per placement, row copies
 * (row.count, ascending) × stack levels (bottom → top) — resolves y null
 * with heightAt(x, z) at the placement point (copies of a row each sample
 * their own point), builds yaw quats from `facing` with sqrt only
 * (facing (fx, fz) = local −Z; q = (0, s, 0, c) with c = sqrt((1 − fz)/2),
 * s = (fx > 0 ? −1 : 1)·sqrt((1 + fz)/2)), checks
 * unknown keys, stack on a non-stackable prop, > PROP_LAYOUT_MAX_INSTANCES
 * instances, overlapping proxies, and throws WorldLayoutError.
 */
export type ResolvePropInstances = (
  placements: readonly PropPlacement[],
  heightAt: (x: number, z: number) => number,
) => PropInstance[];
