/**
 * Rig definition types — FROZEN (P1).
 *
 * PURE DATA MODULE: no imports from sim engine/state/worker, no three, no DOM.
 * Main-thread code may import this file (see docs/CONTRACTS.md boundary
 * amendment). RigDef is plain JSON (structured-cloneable, no Infinity/NaN,
 * no class instances) so it can be authored as data and posted in `spawn`.
 *
 * CANONICAL ORDERING: nodes and beams keep RigDef declaration order through
 * compileRig, the sim arena, snapshots (object-local indices) and GPU
 * bindings. Never sort, dedupe or reorder them.
 *
 * Units: SI (m, kg, N, N/m, N·s/m). Positions are rig-local, Y-up.
 */

export type RigBeamType = 'normal' | 'bounded' | 'support' | 'hydro' | 'shock';

export interface RigNodeDef {
  /** Unique within the rig; beams reference nodes by id. */
  id: string;
  /** Rest position, rig-local metres. */
  pos: [number, number, number];
  /**
   * kg. mass <= 0 means PINNED: invMass = 0, the node never moves (forces on
   * it are discarded). The stability validator may RAISE masses of free nodes
   * (never lowers, never un-pins).
   */
  mass: number;
  /** Coulomb μ against ground (multiplied by the material μ). Default: group → RIG_DEFAULTS.friction. */
  friction?: number;
  /** Contact sphere radius, m. Default: group → RIG_DEFAULTS.radius. */
  radius?: number;
  /** Free-form group name (e.g. 'tire', 'chassis'); selects groupDefaults. */
  group?: string;
  /** Participates in collisions. Default true. */
  collidable?: boolean;
  /**
   * Ground contact stiffness, N/m (additive P2 field). > 0 selects the
   * SOFT-LAYER contact law for this node (tyre tread rubber): penalty
   * stiffness = min(contactSpring, stability cap), damping scaled by
   * depth/radius (see collision/ground.ts). Default: group → 0 = the
   * rigid-contact law (auto stiffness).
   */
  contactSpring?: number;
  /**
   * Tyre TREAD node (additive P2 field): the ground kernel applies only the
   * normal force; the vehicle's tread brush model supplies the tangential
   * (friction) force. Default false.
   */
  tread?: boolean;
  /**
   * P5 NODE-VS-NODE contact (additive): participates in contact with OTHER
   * objects' nodes. Default = `collidable`. A node with collidable false and
   * objContact true is a COLLISION-ONLY node (mid-panel nodes against gap
   * interlock: ground/collider passes skip it, object contact uses it).
   * Compiled into RIG_NODE_FLAG_OBJ_CONTACT.
   */
  objContact?: boolean;
  /**
   * P5 exterior contact radius against other objects' nodes, m (additive).
   * Default (≤ 0 / absent): 0.6 × the node's median incident beam rest
   * length, clamped to [0.04, 0.35] (≈ 0.6 × local node spacing, so
   * neighbouring spheres overlap and an object's skin has no gaps).
   * Independent of `radius` (ground/collider contact), which stays small.
   * Compiled into CompiledRig.nodeObjRadius (U1 adds it in the rig builder).
   */
  objRadius?: number;
}

/** P5: compiled node flag — node-vs-node contact participant (sim NODE_FLAG_OBJ_CONTACT, same bit; U1 sets it in compileRig). */
export const RIG_NODE_FLAG_OBJ_CONTACT = 1 << 3;

export interface RigBeamDef {
  /** Node ids. */
  a: string;
  b: string;
  type: RigBeamType;
  /** Spring stiffness N/m. Default RIG_DEFAULTS.k. */
  k?: number;
  /** Damping N·s/m. Default RIG_DEFAULTS.d. */
  d?: number;
  /**
   * Plastic-deformation threshold force, N: beyond it the rest length
   * ratchets toward the current length and strength degrades.
   * Default RIG_DEFAULTS.deform; <= 0 means never deforms (compiled: Infinity).
   */
  deform?: number;
  /** Break force, N: beyond it the beam deactivates and emits beamBreak. Default RIG_DEFAULTS.breakF; <= 0 means unbreakable (compiled: Infinity). */
  breakF?: number;
  /**
   * 'bounded' / 'shock' only: allowed compression / extension as fractions of
   * rest length (RoR shortbound/longbound). Beyond them the beam goes rigid
   * (bounded) or hits a bump stop (shock). Defaults RIG_DEFAULTS.boundsLow/High.
   */
  boundsLow?: number;
  boundsHigh?: number;
  /** 'shock' only: constant preload force, N, positive pushes nodes apart. Default 0. */
  preload?: number;
  /**
   * 'hydro' only: rest length = base · (1 + hydroTravel · steer), steer ∈ [-1, 1]
   * (signed fraction of rest length). Default 0.
   */
  hydroTravel?: number;
}

export interface RigGroupDefaults {
  friction?: number;
  radius?: number;
  contactSpring?: number;
}

export interface RigDef {
  name: string;
  nodes: RigNodeDef[];
  beams: RigBeamDef[];
  groupDefaults?: Record<string, RigGroupDefaults>;
}

/** Defaults applied by compileRig (RoR reference values). */
export const RIG_DEFAULTS = {
  k: 9e6,
  d: 12e3,
  deform: 4e5,
  breakF: 1e6,
  boundsLow: 0.1,
  boundsHigh: 0.1,
  preload: 0,
  hydroTravel: 0,
  friction: 0.5,
  radius: 0.05,
} as const;

/** Numeric beam type ids used in compiled/sim arrays (same values as sim BeamType). */
export const RIG_BEAM_TYPE_ID: Readonly<Record<RigBeamType, number>> = {
  normal: 0,
  bounded: 1,
  support: 2,
  hydro: 3,
  shock: 4,
};

/** Compiled node flag bits (same values as sim NODE_FLAG_*). */
export const RIG_NODE_FLAG_COLLIDABLE = 1 << 0;
/** Tread node (RigNodeDef.tread); same bit as sim NODE_FLAG_TREAD. Bit 1 is the sim's IN_CONTACT. */
export const RIG_NODE_FLAG_TREAD = 1 << 2;

/**
 * Output of compileRig: defaults resolved, ids resolved to indices, all
 * arrays in DECLARATION order. Typed arrays → still structured-cloneable.
 */
export interface CompiledRig {
  name: string;
  nodeCount: number;
  beamCount: number;
  /** Node ids by index (declaration order). */
  nodeIds: string[];
  /** Rest positions xyz interleaved, length 3·nodeCount. */
  nodePos: Float64Array;
  /** Declared mass, kg; 0 for pinned nodes (mass <= 0 normalized to 0). */
  nodeMass: Float64Array;
  /** 1/mass, 0 for pinned. */
  nodeInvMass: Float64Array;
  nodeFriction: Float64Array;
  nodeRadius: Float64Array;
  /** Per-node soft-layer ground stiffness N/m, 0 = rigid-contact law (additive P2). */
  nodeContactK: Float64Array;
  /** RIG_NODE_FLAG_* bits. */
  nodeFlags: Uint8Array;
  /** Group names in first-seen order; nodeGroup indexes into it (-1 = none). */
  groups: string[];
  nodeGroup: Int32Array;
  /** Beam endpoints (node indices). */
  beamA: Int32Array;
  beamB: Int32Array;
  /** RIG_BEAM_TYPE_ID values. */
  beamType: Uint8Array;
  /** Rest length from rest positions, m. */
  beamRestLen: Float64Array;
  beamK: Float64Array;
  beamD: Float64Array;
  /** Infinity when never-deforming. */
  beamDeform: Float64Array;
  /** Infinity when unbreakable. */
  beamBreakF: Float64Array;
  beamBoundsLow: Float64Array;
  beamBoundsHigh: Float64Array;
  beamPreload: Float64Array;
  beamHydroTravel: Float64Array;
}

/** Per-node stability analysis (validator, P2). Limit: ω·dt = sqrt(Σk/m)·dt ≤ limit. */
export interface StabilityReport {
  dt: number;
  /** ω·dt limit used (0.5 general, 0.35 structure). */
  limit: number;
  /** Per node sqrt(Σ k_b / m)·dt; 0 for pinned nodes. */
  omegaDt: Float64Array;
  /** Per node (Σ d_b / m)·dt; must be ≤ 1. */
  dampDt: Float64Array;
  /** Worst nodes by omegaDt, descending (at most a handful). */
  worst: { index: number; id: string; omegaDt: number; dampDt: number }[];
  /** Per node minimum mass (kg) satisfying both limits; 0 for pinned. */
  suggestedMinMass: Float64Array;
  /** Nodes currently violating a limit. */
  violations: number;
  /** (Σ suggested-or-declared mass − Σ declared mass) / Σ declared mass · 100. */
  massDriftPct: number;
  ok: boolean;
}

export interface RigStats {
  name: string;
  nodeCount: number;
  beamCount: number;
  pinnedCount: number;
  collidableCount: number;
  /** kg, free nodes only. */
  totalMass: number;
  minNodeMass: number;
  maxNodeMass: number;
  beamsByType: Record<RigBeamType, number>;
  /** Rest-pose AABB, rig-local. */
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  minRestLen: number;
  maxRestLen: number;
}
