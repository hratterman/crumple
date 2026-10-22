/**
 * Static-collider contracts — P4 (worker-only; implementations in
 * src/sim/collision/colliders.ts, P4 agent 5).
 *
 * WHY HERE and not in src/world/types.ts: the DEFINITION (ColliderDef,
 * ResolvedCollider) is shared layout data and lives in src/world/types.ts
 * (render draws what the sim collides with; render may not import
 * src/sim). The COMPILED SoA form, the broadphase grid and the kernel
 * signature reference SimState / EventSink, which are worker internals,
 * so they live beside the ground kernel. Main-thread code must not import
 * this file.
 *
 * PHASE ORDER (amends canonical rule 3): per object ascending,
 *   vehicle pre-step → steering hydros → beams → applyGroundContacts
 *   → applyColliderContacts → integrate.
 * The collider pass is the LAST force pass, so its implicit friction sees
 * every other force of the tick, including the ground's (a car pressed
 * against a wall while standing on the ground is resolved Gauss–Seidel:
 * ground first, then collider). It ORs NODE_FLAG_IN_CONTACT (never clears
 * the ground's bit).
 *
 * CONTACT LAW (identical in form to the RIGID ground law in ground.ts —
 * keep them in sync):
 *   per collidable, free node i (radius r, mass m) and candidate collider c:
 *     signed distance sd of the node centre to c's solid (closest feature,
 *     outward normal n), depth = r − sd; contact iff depth > 0.
 *     kc = min(COLLIDER_KC_MAX, KC_STABILITY·m/dt²)    (KC_STABILITY 0.2 as ground)
 *     c_d = 2·CONTACT_ZETA·sqrt(kc·m)                   (ζ 0.65 two-sided, as ground)
 *     Fn = max(0, kc·depth − c_d·(v·n))   (R-CRASH: kc·depth → hysteretic spring, below)
 *     friction: implicit backward-Euler Coulomb, F_t = tangential part of
 *     (accumulated force + m·g), F_req = −(m·v_t/dt + F_t) clamped to
 *     μ·Fn with μ = node friction × materials.friction[c.material]
 *     (sticks inside the cone, slides along F_req outside). The soft-layer
 *     law (contactK) and the tread cone (treadF) are GROUND-only; colliders
 *     always use the rigid law.
 *   A node touching several colliders gets each contact in collider index
 *   order (fixed order: determinism).
 *   Events: impact on touchdown (approach momentum m·max(0, −v·n) ≥ the
 *   ground's IMPACT_MIN_IMPULSE, materialId = collider material, normal n);
 *   skid when sliding ≥ the ground's skid thresholds (same per-node cooldown
 *   table as ground).
 * WHY a higher stiffness cap than the ground's KC_MAX (2.5e5): a crash
 * presses ~10 nodes into a wall; at 2.5e5 N/m each node sinks 10–30 cm
 * into a rigid barrier and through a 0.15 m pole (pull-through). The cap
 * here keeps ω·dt ≤ sqrt(0.2) ≈ 0.447 per node (same stability argument
 * as ground) while holding penetration to a few cm.
 * R-CRASH 2e6 → 8e6: at 2 MN/m the heavy front nodes (engine block, suspension pivots, truck frame horns)
 * still sank 4–9 cm into a rigid barrier at 50–100 km/h (box truck 22 cm) and the crumple zone's crush
 * went partly into the wall. Nodes lighter than kc_max·dt²/0.2 = 10 kg stay at the 0.2·m/dt² stability
 * bound (unchanged); heavier ones press in 4× less (fleet: 1.4–5.7 cm at 50–100 km/h).
 * HYSTERETIC UNLOADING (colliders.ts CONTACT_UNLOAD_E2 / _RELAX_S): Fn's spring term unloads at kc/e²
 * from the contact's deepest point (Walton–Braun), so a rigid barrier no longer returns the contact
 * spring energy as rebound.
 *
 * SIGNED DISTANCE per kind (local frame, see ColliderDef):
 *   box/ramp: closest-feature distance outside the solid. For a node whose
 *     centre is INSIDE, n = outward normal of the least-penetration face,
 *     skipping faces with v·n > 0 (the node is moving out through that
 *     side, so it entered elsewhere): a node driven past the mid-plane of
 *     a thin wall is still pushed back out of the face it entered, never
 *     out of the far side. Stateless (no per-node contact memory).
 *   cylinder: radial distance to the axis segment (caps are flat discs);
 *     a node within 1 mm of the axis takes n = −v_horizontal normalized
 *     (or +X if at rest) — never NaN.
 *   sphere: radial. plane: local y within [−COLLIDER_PLANE_DEPTH, r] over
 *     the rectangle, n = local +Y.
 *
 * NUMERICS: worker hot loop — only + − × ÷ sqrt, no allocation, fixed
 * iteration order (nodes ascending, candidates in collider index order).
 */
import type { ResolvedCollider } from '../../world/types';
import type { EventSink, MaterialTable, SimState } from '../types';

/** Numeric collider kind ids (CompiledColliders.kind). */
/** R-CORE: mesh = 5 (its triangles go to the static triangle-mesh contact pass; the primitive kernel skips it). */
export const ColliderKindId = { box: 0, cylinder: 1, sphere: 2, plane: 3, ramp: 4, mesh: 5 } as const;
export type ColliderKindId = (typeof ColliderKindId)[keyof typeof ColliderKindId];

/** Penalty stiffness cap for collider contacts, N/m (see header WHY). */
export const COLLIDER_KC_MAX = 8e6;
/** Plane colliders are a slab this deep below their surface, m. */
export const COLLIDER_PLANE_DEPTH = 0.5;
/** Broadphase grid cell edge (XZ), m. */
export const COLLIDER_GRID_CELL = 8;
/** Max candidate colliders gathered per object per tick (scratch size); more is a layout error. */
export const COLLIDER_MAX_CANDIDATES = 64;

/**
 * Structure-of-arrays compiled colliders (index = position in the active
 * list: layout colliders in declaration order, then the setColliders extra
 * set). Built once per install; never resized in the step loop.
 */
export interface CompiledColliders {
  count: number;
  ids: string[];
  /** ColliderKindId. */
  kind: Uint8Array;
  /** MaterialId. */
  material: Uint8Array;
  /** World centre, 3 per collider. */
  pos: Float64Array;
  /** Rotation matrix, 9 per collider, row-major R (world = R·local + pos). */
  rot: Float64Array;
  /** ColliderDef.size, 3 per collider. */
  size: Float64Array;
  /** Ramp only: unit outward normal of the sloped face in LOCAL coordinates, 3 per collider (0 otherwise). */
  slopeNormal: Float64Array;
  /** World AABB (fattened by 0.1 m), 3 per collider each. */
  aabbMin: Float64Array;
  aabbMax: Float64Array;
  /** breakable.anchorForce or Infinity (RESERVED P5; P4 never breaks). */
  breakForce: Float64Array;
  /** 1 active, 0 removed (RESERVED P5 broken poles). */
  active: Uint8Array;
}

/**
 * Uniform XZ grid over the colliders' AABB union (CSR): cell (cx, cz) lists
 * collider indices ascending in cellItems[cellStart[k] .. cellStart[k+1]),
 * k = cz·cols + cx. Queries outside the grid return nothing.
 */
export interface ColliderGrid {
  cellSize: number;
  originX: number;
  originZ: number;
  cols: number;
  rows: number;
  cellStart: Int32Array;
  cellItems: Int32Array;
}

export interface ColliderWorld {
  colliders: CompiledColliders;
  grid: ColliderGrid;
  /** Per-object candidate scratch (COLLIDER_MAX_CANDIDATES) + a visited-stamp per collider for dedup. */
  candidates: Int32Array;
  stamp: Uint32Array;
  /** R-PHYS (additive): candidate overflows so far (an object near more than COLLIDER_MAX_CANDIDATES colliders; truncated, never thrown). */
  overflow?: number;
}

/** Builds the SoA + grid (not a hot path; allocates). Order = input order. */
export type CompileColliders = (colliders: readonly ResolvedCollider[]) => ColliderWorld;

/**
 * Static-collider contacts for collidable nodes [first, first+count) of
 * object `objectId`. Broadphase: the object's node AABB this tick (+ max
 * node radius) → grid cells → candidate colliders (deduped, ascending) →
 * per-node narrow phase against each candidate's fattened AABB first.
 * Same argument conventions as ApplyGroundContacts (gravity for the
 * tangential part of m·g).
 */
export type ApplyColliderContacts = (
  state: SimState,
  first: number,
  count: number,
  world: ColliderWorld,
  materials: MaterialTable,
  dt: number,
  objectId: number,
  events: EventSink,
  gx: number,
  gy: number,
  gz: number,
) => void;
