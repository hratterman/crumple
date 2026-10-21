/**
 * Sim-core shared types — FROZEN (P1). Worker-only (never imported by
 * render/ui/game). Declarations only; implementations live in the engine and
 * kernel modules.
 *
 * ======================================================================
 * CANONICAL ORDERING RULE (FROZEN — determinism and GPU bindings depend on it)
 * ----------------------------------------------------------------------
 * 1. Nodes and beams keep RigDef DECLARATION order: rig node i is arena node
 *    object.nodeStart + i and snapshot node nodeOffset + i; same for beams.
 *    Nothing ever sorts, dedupes or compacts them (broken beams stay in place
 *    with active = 0).
 * 2. Objects are processed and serialized by ASCENDING objectId, every step
 *    and every snapshot; arena ranges are allocated in that order too
 *    (re-packed on spawn/despawn if necessary).
 * 3. Within a step the phase order is fixed: commands (arrival order) →
 *    per object ascending: applyBeamForces → applyGroundContacts → other
 *    contact/drive forces → integrateNodes. Each kernel loops its range in
 *    ascending index order.
 * 4. Events are pushed and serialized in DISCOVERY order (the order the
 *    above loops produce them); never sorted.
 * 5. Cross-object contact pairs (P6) are sorted canonically (lower object id,
 *    then lower node index) before force application.
 * ======================================================================
 *
 * WHY f64 vs f32: P0 bench measured Float64Array FASTER than Float32Array on
 * V8 for the beam loop (no f32↔f64 conversion per load/store; JS numbers are
 * f64). So every array that is read/written in hot loops is f64. f32 is used
 * only where data leaves the sim (strainOut → copied straight into the f32
 * snapshot). Integer/flag arrays use the narrowest int type (Int32 indices,
 * Uint8 flags/types) for cache density; they are never mixed into float math.
 */
import { ACTION_COUNT, MaterialId } from '../protocol/messages';

export { MaterialId, MATERIAL_COUNT } from '../protocol/messages';
export { ACTION_COUNT };

// ============================================================ terrain query
/** Ground query used by contact kernels (plane in P1, heightfield in P3). Must be deterministic and allocation-free. */
export interface HeightSampler {
  /** Ground height (world Y) at (x, z). */
  heightAt(x: number, z: number): number;
  /** Unit, C0-continuous smoothed surface normal at (x, z); writes x,y,z into out[0..2]. */
  normalAt(x: number, z: number, out: Float64Array): void;
  /** MaterialId at (x, z). */
  materialAt(x: number, z: number): number;
}

/**
 * Per-material ground response, indexed by MaterialId. Effective contact
 * μ = node friction × friction[material].
 */
export interface MaterialTable {
  readonly friction: Float64Array;
}

// ============================================================ enums
export const BeamType = {
  normal: 0,
  bounded: 1,
  support: 2,
  hydro: 3,
  shock: 4,
} as const;
export type BeamType = (typeof BeamType)[keyof typeof BeamType];

/** SimState.flags bits (per node). */
export const NODE_FLAG_COLLIDABLE = 1 << 0;
/** Set by applyGroundContacts when the node touched ground this step; cleared otherwise. */
export const NODE_FLAG_IN_CONTACT = 1 << 1;
/**
 * Tyre tread node (RigNodeDef.tread, additive P2): applyGroundContacts adds
 * only the normal force; the vehicle pre-step's tread brush supplies the
 * tangential force (vehicle/wheels.ts applyTreadBrush).
 */
export const NODE_FLAG_TREAD = 1 << 2;
/** P5: node-vs-node contact participant (= RIG_NODE_FLAG_OBJ_CONTACT; collision/objects.ts). */
export const NODE_FLAG_OBJ_CONTACT = 1 << 3;
/**
 * R-CRASH: the node touched ANOTHER OBJECT's node this tick (set by collision/objects.ts, cleared the next
 * tick). Kept apart from NODE_FLAG_IN_CONTACT (ground / static contact: tyres, telemetry, parking clamp);
 * the shell's contact release (shell.ts CONTACT_RELEASE) honours both, so a car pushed by another car
 * releases its crumple zone instead of being carried along rigid.
 */
export const NODE_FLAG_OBJ_TOUCH = 1 << 4;
/**
 * R-CRASH: …and was struck by it at ≥ OBJ_IMPACT_RELEASE_SPEED (collision/objects.ts) this tick. A crumple
 * zone (shell whole + yield tier) with such a node releases whole: a car pushed by another car moves as a
 * rigid block otherwise (the shell's implicit damper spreads the contact impulse over the whole body and
 * the node never leaves its 4 mm yield bond), so a 50 km/h rear-end crushed the struck rear 1 cm.
 */
export const NODE_FLAG_OBJ_IMPACT = 1 << 5;

/** SimObject.flags bits (same value as protocol OBJECT_FLAG_SLEEPING). */
export const SIM_OBJECT_FLAG_SLEEPING = 1 << 0;

// ============================================================ arena
/**
 * Structure-of-arrays arena holding every node and beam of every object.
 * Arrays are allocated at capacity once; nodeCount/beamCount are the used
 * prefix. Beam aIdx/bIdx are GLOBAL node indices.
 */
export interface SimState {
  nodeCapacity: number;
  beamCapacity: number;
  nodeCount: number;
  beamCount: number;

  // ---- nodes (f64: hot-loop read/write every step)
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  /** Force accumulators; zeroed by integrateNodes after use. */
  frcX: Float64Array;
  frcY: Float64Array;
  frcZ: Float64Array;
  /** 0 = pinned. f64: multiplied with frc every step. */
  invMass: Float64Array;
  /** Contact radius, m. f64: used in contact math. */
  radius: Float64Array;
  /** Node μ. f64: used in contact math. */
  friction: Float64Array;
  /** Soft-layer ground stiffness N/m, 0 = rigid-contact law (additive P2; CompiledRig.nodeContactK). */
  contactK: Float64Array;
  /**
   * Tread nodes (NODE_FLAG_TREAD), additive P2, written each tick by the
   * vehicle tread brush before the ground pass: unit lateral (axle,
   * ground-tangent) direction the brush owns — the ground kernel's stick
   * drops that component — and the brush force magnitude on the node (N),
   * which the ground kernel's friction cone leaves to the brush. 0 = none.
   */
  treadAxX: Float64Array;
  treadAxY: Float64Array;
  treadAxZ: Float64Array;
  treadF: Float64Array;
  /** P5 node-vs-node contact radius, m (CompiledRig.nodeObjRadius). f64: contact math. */
  objRadius: Float64Array;
  /** NODE_FLAG_* bits (u8: dense, bit tests only). */
  flags: Uint8Array;

  // ---- beams
  /** Global node indices (i32: indices, never in float math). */
  aIdx: Int32Array;
  bIdx: Int32Array;
  /** Current stiffness N/m (reduced by deformation). f64: hot. */
  k: Float64Array;
  /** Damping N·s/m. f64: hot. */
  d: Float64Array;
  /** Current rest length m (plastic ratchet, hydro drive). f64: hot. */
  restLen: Float64Array;
  /** Original rest length (repair/reset). f64: copied into restLen. */
  restLen0: Float64Array;
  /** Original stiffness (repair/reset). */
  k0: Float64Array;
  /** Plastic threshold force N (Infinity = never). f64: compared with f64 force. */
  deform: Float64Array;
  /** Break force N (Infinity = unbreakable). */
  breakF: Float64Array;
  /** Bounded/shock compression/extension fractions of restLen. */
  boundsLow: Float64Array;
  boundsHigh: Float64Array;
  /** Shock preload force N. */
  preload: Float64Array;
  /** BeamType (u8). */
  type: Uint8Array;
  /** 1 = intact, 0 = broken (u8). */
  active: Uint8Array;
  /**
   * Signed force/breakF clamped to [-1, 1] (tension positive), NaN when
   * broken. f32 because it only leaves the sim (copied to the snapshot);
   * written by applyBeamForces only when debugStrains.
   */
  strainOut: Float32Array;
  /**
   * R-CRASH crush unloading (beams.ts CRUSH_UNLOAD_HOLD): per beam the unloading gain α − 1 (0 = off;
   * > 0 permanent, < 0 temporary offset), the trigger force (N), the ticks left in the crash-loaded
   * window and the temporary rest-length offset (m). Loaded from CompiledRig.beamUnload / beamUnloadTrig.
   */
  unloadGain: Float32Array;
  unloadTrig: Float32Array;
  crushHold: Uint16Array;
  hystOff: Float64Array;
}

// ============================================================ objects
/** One spawned object's slot in the arena. */
export interface SimObject {
  objectId: number;
  /** First arena node / count (contiguous, declaration order). */
  nodeStart: number;
  nodeCount: number;
  /** First arena beam / count (contiguous, declaration order). */
  beamStart: number;
  beamCount: number;
  /** SIM_OBJECT_FLAG_* bits. */
  flags: number;
  /** Current actions indexed by protocol `Action` (length ACTION_COUNT). */
  actions: Float64Array;
  /** Global beam indices of this object's hydro beams, ascending. */
  hydroBeams: Int32Array;
  /** Base rest length per hydro beam (parallel to hydroBeams). */
  hydroBase: Float64Array;
  /** hydroTravel per hydro beam (parallel to hydroBeams). */
  hydroTravel: Float64Array;
}

// ============================================================ events
/**
 * Event sink the kernels push into (discovery order). Implemented by the
 * engine; buffers events until the next written snapshot. Must not allocate.
 */
export interface EventSink {
  impact(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    impulse: number,
  ): void;
  /**
   * `beamIndex` is the GLOBAL arena beam index (kernels do not know the
   * owner); the sink resolves owner objectId and converts to the
   * object-local index used in the protocol.
   */
  beamBreak(beamIndex: number, px: number, py: number, pz: number): void;
  skid(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    slip: number,
    load: number,
  ): void;
}

// ============================================================ kernels
/**
 * Accumulates spring/damper forces of beams [first, first+count) into frc*,
 * applies plastic deformation, breaks beams over breakF (active=0, emits
 * beamBreak), and writes strainOut when debugStrains.
 */
export type ApplyBeamForces = (
  state: SimState,
  first: number,
  count: number,
  events: EventSink,
  debugStrains: boolean,
  /** R-CRASH: the object is in a crash, crush unloading may arm (beams.ts CRUSH_UNLOAD_HOLD). Default false. */
  crashArmed?: boolean,
) => void;

/**
 * Semi-implicit Euler for nodes [first, first+count):
 * v += (frc·invMass + g)·dt; p += v·dt; frc = 0. Pinned nodes (invMass 0)
 * keep zero velocity.
 */
export type IntegrateNodes = (
  state: SimState,
  first: number,
  count: number,
  dt: number,
  gx: number,
  gy: number,
  gz: number,
) => void;

/**
 * Penalty ground contact + slip-regularized Coulomb friction for collidable
 * nodes [first, first+count) of object `objectId`; maintains
 * NODE_FLAG_IN_CONTACT and emits impact/skid events.
 */
export type ApplyGroundContacts = (
  state: SimState,
  first: number,
  count: number,
  sampler: HeightSampler,
  materials: MaterialTable,
  dt: number,
  objectId: number,
  events: EventSink,
  /**
   * Gravity (m/s²), additive P2 amendment: the implicit friction law needs
   * the tangential part of m·g (slopes). Omitted = 0 (P1 callers).
   */
  gx?: number,
  gy?: number,
  gz?: number,
) => void;
