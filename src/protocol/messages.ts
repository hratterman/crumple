/**
 * Worker⇄main message contract — FROZEN (P1).
 *
 * All messages are plain structured-cloneable objects discriminated by `type`.
 * Only `snapshot` (worker→main) and `returnBuffer` (main→worker) carry a
 * transferable ArrayBuffer; always post them with the buffer in the transfer
 * list. See codec.ts for the 3-buffer pool ownership rules.
 *
 * Commands are applied by the worker in arrival order at the start of the
 * next fixed step (never mid-step), which keeps the sim deterministic for a
 * given (tick, command) log.
 */
import type { Quat, Vec3 } from '../core/math';
import type { PropKey } from '../sim/props/types';
import type { RigDef } from '../sim/rig/types';
import type { TransmissionMode, VehicleDef } from '../sim/vehicle/types';
import type { ColliderDef, WorldLayout } from '../world/types';
import type { ReplayFile } from './replay';
import type { TrafficBubble, TrafficDensity, TrafficVariantSpec } from './traffic';

// ============================================================ MaterialId
/**
 * Surface/material ids — FROZEN numeric values. Canonical home is here (both
 * sides need it); `src/sim/types.ts` re-exports it.
 *
 * P5 additive (7..10): OBJECT materials. They never appear in the terrain
 * material map (the generator paints 0..6 only; world/validate keeps roads
 * and pads to 0..6) but are valid for static colliders (tree trunks = wood)
 * and are the `materialId` of node-vs-node contact events (the OTHER
 * object's contact material: PropDef.material, vehicles = metal). FX keys
 * sparks / chips / dust on them (docs/CONTRACTS.md "FX event → effect").
 */
export const MaterialId = {
  asphalt: 0,
  grass: 1,
  dirt: 2,
  rock: 3,
  gravel: 4,
  concrete: 5,
  metal: 6,
  plastic: 7,
  rubber: 8,
  wood: 9,
  cardboard: 10,
  // Layout v6 (R-WORLD) additive TERRAIN surfaces: painted into the terrain material map by
  // surface patches / roads, physics per src/world/surfaces.ts SURFACE_PHYSICS
  // (docs/CONTRACTS.md "R-WORLD contracts" → surfaces).
  mud: 11,
  sand: 12,
  wetGrass: 13,
  asphaltWorn: 14,
} as const;
export type MaterialId = (typeof MaterialId)[keyof typeof MaterialId];
export const MATERIAL_COUNT = 15;
/** Terrain-paintable materials are [0, TERRAIN_MATERIAL_COUNT) (P1 values) plus TERRAIN_SURFACE_IDS (v6). */
export const TERRAIN_MATERIAL_COUNT = 7;
/** Layout v6: every MaterialId the terrain material map may hold (P1 0..6 + mud, sand, wetGrass, asphaltWorn). */
export const TERRAIN_SURFACE_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14];
/** True for a terrain-paintable MaterialId (layout v6). */
export function isTerrainMaterial(id: number): boolean {
  return (id >= 0 && id < TERRAIN_MATERIAL_COUNT) || (id >= 11 && id <= 14);
}

// ============================================================ ActionState
/**
 * Driver action state — FROZEN names and numeric indices. Indices address a
 * Float64Array(ACTION_COUNT) in the worker and the replay input log
 * `(tick, actionIndex, value)`.
 *
 * | idx | name       | range    | meaning                                         |
 * |-----|------------|----------|-------------------------------------------------|
 * | 0   | throttle   | 0..1     | accelerator pedal                               |
 * | 1   | brake      | 0..1     | service brake pedal                             |
 * | 2   | steer      | -1..1    | -1 full left, +1 full right                     |
 * | 3   | handbrake  | 0..1     | parking/hand brake lever                        |
 * | 4   | clutch     | 0..1     | 0 engaged, 1 fully disengaged (pedal depressed) |
 * | 5   | gearSelect | integer  | -1 reverse, 0 neutral, 1..n forward gears       |
 * | 6   | horn       | 0..1     | P8 (additive): ≥ 0.5 sounds the horn             |
 *
 * The worker clamps to these ranges (gearSelect is rounded, then clamped to
 * the vehicle's gear count). Unset actions default to 0.
 */
export interface ActionState {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: number;
  clutch: number;
  gearSelect: number;
  /** P8 (additive, optional): horn button; recorded in the replay input log like any action. */
  horn?: number;
}
export const Action = {
  throttle: 0,
  brake: 1,
  steer: 2,
  handbrake: 3,
  clutch: 4,
  gearSelect: 5,
  horn: 6,
} as const satisfies Record<keyof ActionState, number>;
export type ActionIndex = (typeof Action)[keyof typeof Action];
export const ACTION_COUNT = 7;
/** Action names in index order. */
export const ACTION_NAMES: readonly (keyof ActionState)[] = [
  'throttle',
  'brake',
  'steer',
  'handbrake',
  'clutch',
  'gearSelect',
  'horn',
];
/** Inclusive [min, max] per action index (gearSelect max is per-vehicle; 16 is the protocol cap). */
export const ACTION_RANGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 1],
  [-1, 1],
  [0, 1],
  [0, 1],
  [-1, 16],
  [0, 1],
];

// ============================================================ shared shapes
/** Rigid placement applied to a rig's rest pose. quat is [x, y, z, w]. */
export interface Transform {
  pos: Vec3;
  quat: Quat;
}

/** Snapshot buffer sizing; fixed for the worker's lifetime (set at init). */
export interface SnapshotCapacity {
  maxObjects: number;
  nodeCapacity: number;
  beamCapacity: number;
}
export const DEFAULT_SNAPSHOT_HZ = 120;
export const DEFAULT_CAPACITY: SnapshotCapacity = {
  maxObjects: 64,
  nodeCapacity: 32768,
  beamCapacity: 131072,
};
/**
 * P5: the game's init capacity (layout props are separate objects: up to
 * PROP_LAYOUT_MAX_INSTANCES of them plus vehicles and dynamic props).
 * DEFAULT_CAPACITY stays the P1 value for tests.
 */
export const GAME_CAPACITY: SnapshotCapacity = {
  maxObjects: 320,
  nodeCapacity: 32768,
  beamCapacity: 131072,
};

// ---------------------------------------------------------------- object id ranges (P5)
/**
 * objectId ranges (u32; convention shared by worker and main — objects stay
 * ordered by ascending id, so props always step AFTER vehicles):
 *   [1, PROP_LAYOUT_ID_BASE)            vehicles + main-spawned rigs (player 1, debug cube 2, P6 traffic 100+)
 *   [PROP_LAYOUT_ID_BASE, +MAX)         LAYOUT props, auto-spawned by the worker on groundHeightfield:
 *                                       objectId = PROP_LAYOUT_ID_BASE + PropInstance.index
 *   [PROP_DYNAMIC_ID_BASE, +MAX)        props spawned by `spawnProps` (challenge set-ups, debug)
 */
export const PROP_LAYOUT_ID_BASE = 4096;
export const PROP_LAYOUT_MAX_INSTANCES = 256;
export const PROP_DYNAMIC_ID_BASE = 8192;
export const PROP_DYNAMIC_MAX = 4096;
export function isLayoutPropId(objectId: number): boolean {
  return objectId >= PROP_LAYOUT_ID_BASE && objectId < PROP_LAYOUT_ID_BASE + PROP_LAYOUT_MAX_INSTANCES;
}
export function isPropObjectId(objectId: number): boolean {
  return isLayoutPropId(objectId) || (objectId >= PROP_DYNAMIC_ID_BASE && objectId < PROP_DYNAMIC_ID_BASE + PROP_DYNAMIC_MAX);
}

// ============================================================ main → worker
export interface InitMsg {
  type: 'init';
  /** Seed for the worker's core/rng streams. */
  seed: number;
  /** m/s², e.g. [0, -9.81, 0]. */
  gravity: Vec3;
  /** Snapshot rate in Hz (default 120). Snapshots land on fixed ticks. */
  snapshotHz: number;
  /** When true, snapshots carry the beam-strain section. Fixed for the session. */
  debugStrains: boolean;
  /** Optional sizing; DEFAULT_CAPACITY when omitted. Spawns that would exceed it get an `error`. */
  capacity?: SnapshotCapacity;
}

export interface GroundPlaneMsg {
  type: 'ground';
  mode: 'plane';
  /** Plane height (world Y). */
  y: number;
  materialId: MaterialId;
}
/**
 * SUPERSEDED (P3) by `groundHeightfield` below; kept so the P1 union stays
 * unchanged. The worker keeps answering `unimplemented` for this variant.
 */
export interface GroundHeightfieldMsg {
  type: 'ground';
  mode: 'heightfield';
  terrain: unknown;
}
export type GroundMsg = GroundPlaneMsg | GroundHeightfieldMsg;

/**
 * Spawn a rig. objectId is chosen by main, must be unique among live objects
 * and is a u32. Snapshot objects are listed by ascending objectId.
 */
export interface SpawnMsg {
  type: 'spawn';
  objectId: number;
  rig: RigDef;
  transform: Transform;
}
export interface DespawnMsg {
  type: 'despawn';
  objectId: number;
}
/** Merges the given actions into the object's current ActionState (missing keys unchanged). */
export interface InputMsg {
  type: 'input';
  objectId: number;
  actions: Partial<ActionState>;
}
/** Spawn settle window main sends with player spawns / teleports / repairs, sim s (`settle` on reset / spawnVehicle). */
export const SPAWN_SETTLE_S = 0.4;
/** Upper bound of a settle window, sim s (larger values are clamped). */
export const SPAWN_SETTLE_MAX_S = 2;
/** Full repair: rest pose at `transform`, zero velocity, beams restored (restLen0/k0, active). */
export interface ResetMsg {
  type: 'reset';
  objectId: number;
  transform: Transform;
  /**
   * Spawn-settle additive: sim seconds (clamped to [0, SPAWN_SETTLE_MAX_S],
   * rounded to ticks; omitted / 0 = none) during which the object drops onto
   * its suspension without damage: its beams neither yield nor break and its
   * impact / skid events are dropped. Part of the logged command, so replay
   * and resimulate reproduce it. Main sends SPAWN_SETTLE_S for player spawns,
   * teleports and repairs.
   */
  settle?: number;
}
/** Sim-time scale, clamped by the worker to [0.05, 1] (0 pauses). */
export interface TimescaleMsg {
  type: 'timescale';
  value: number;
}
/** Returns a snapshot buffer to the worker's pool. Transfer the buffer. */
export interface ReturnBufferMsg {
  type: 'returnBuffer';
  buffer: ArrayBuffer;
}

// ---------------------------------------------------------------- vehicles (P2, additive)
/**
 * Spawn a vehicle: the worker runs compileVehicle(vehicle) (body + generated
 * wheels in canonical order, MINIMASS) and inserts the merged rig exactly
 * like `spawn`, plus a vehicle runtime (drivetrain, wheels, telemetry).
 * Snapshot node/beam ranges follow the merged canonical order, so main
 * compiles the same def (compileVehicle is pure) to map nodes. Invalid defs
 * get `error`. `transmission` overrides drivetrain.transmission.
 */
export interface SpawnVehicleMsg {
  type: 'spawnVehicle';
  objectId: number;
  vehicle: VehicleDef;
  transform: Transform;
  transmission?: TransmissionMode;
  /**
   * P6 additive: VehicleCatalog id of `vehicle` (src/game/catalog.ts), e.g.
   * 'coupe'. Informational for the worker (kept per object for the P7
   * replay header and logs); `vehicle` stays authoritative — the worker
   * never looks a def up by id. Omitted = unknown / ad-hoc def.
   */
  catalogId?: string;
  /**
   * Spawn-settle additive: sim seconds (clamped to [0, SPAWN_SETTLE_MAX_S],
   * rounded to ticks; omitted / 0 = none) during which the object drops onto
   * its suspension without damage: its beams neither yield nor break and its
   * impact / skid events are dropped. Part of the logged command, so replay
   * and resimulate reproduce it. Main sends SPAWN_SETTLE_S for player spawns,
   * teleports and repairs.
   */
  settle?: number;
}
/**
 * Switch a vehicle between automatic and manual shifting. gearSelect
 * semantics: auto: −1 R, 0 N, ≥ 1 Drive (worker picks 1..n); manual: the
 * exact gear (clamped to the vehicle's gear count).
 */
export interface SetTransmissionMsg {
  type: 'setTransmission';
  objectId: number;
  mode: TransmissionMode;
}
/**
 * Driver assists (additive P5): `tractionControl` engages / releases the
 * vehicle's traction control (default on at spawn; kept across reset and
 * recover). Omitted fields are unchanged. Non-vehicle ids answer `error`.
 */
export interface SetAssistsMsg {
  type: 'setAssists';
  objectId: number;
  tractionControl?: boolean;
}
/**
 * Recover (R): rigidly re-place the CURRENT (deformed) node set upright —
 * vehicle frame up → world +Y, heading kept — with its frame origin at
 * `pos` (default: current origin + 0.5 m up, ground-clearance adjusted),
 * zero velocities, drivetrain state kept. Damage is NOT repaired (that is
 * `reset`).
 */
export interface RecoverMsg {
  type: 'recover';
  objectId: number;
  pos?: Vec3;
}

// ---------------------------------------------------------------- terrain (P3, additive)
/**
 * Replace the ground with the heightfield of `layout`. The worker runs the
 * PURE generateTerrain(layout) itself (src/world/terrain.ts) instead of
 * receiving ~18 MB of arrays: the layout is a few KB of JSON, and
 * collision == visual by construction. It then compares
 * hashTerrain(its terrain) with `terrainHash` (main's result for the same
 * layout):
 *   - match    → installs the heightfield sampler, posts `terrainReady`;
 *   - mismatch → STILL installs its own terrain (the car must have ground),
 *                posts `terrainReady{matched:false}` and an `error`
 *                (build skew / non-determinism bug — surface loudly).
 * Generation blocks the worker (~1 s); commands queued behind it (spawns)
 * apply afterwards in arrival order, so send this BEFORE spawning. Ticks
 * that fall due meanwhile are dropped by the backlog cap (no catch-up).
 * Main may skip waiting for its own hash by sending terrainHash = 0
 * (no comparison; `matched` reports false).
 */
export interface GroundHeightfieldCmd {
  type: 'groundHeightfield';
  layout: WorldLayout;
  /** u32 hashTerrain() of main's generateTerrain(layout); 0 = don't compare. */
  terrainHash: number;
}

// ---------------------------------------------------------------- colliders (P4, additive)
/**
 * Replace the EXTRA static-collider set (tests, challenge set-ups, the
 * plane-ground soft-cube demo). The layout's own `colliders` are installed
 * by `groundHeightfield` and are not affected; the active set is layout
 * colliders (declaration order) followed by these. `y: null` resolves
 * against the current ground (plane or heightfield) when the command
 * applies. Invalid defs → `error` (set unchanged). [] clears the extra set.
 */
export interface SetCollidersMsg {
  type: 'setColliders';
  colliders: ColliderDef[];
}

// ---------------------------------------------------------------- props (P5, additive)
/** One prop to spawn: the worker compiles PROP_CATALOG[prop].rig (pure, cached per key). */
export interface PropSpawn {
  /** In [PROP_DYNAMIC_ID_BASE, +PROP_DYNAMIC_MAX); unique among live objects. */
  objectId: number;
  prop: PropKey;
  /** Rig rest pose (base on local y = 0) placed by this transform. */
  transform: Transform;
  /** Start asleep (frozen in the rest pose until woken). Default true. */
  asleep?: boolean;
}
/**
 * Batch spawn (atomic: every item is validated first — unknown key, id out
 * of the dynamic range or in use, capacity — and on any failure NOTHING
 * spawns and one `error` names the first bad item). Layout props are NOT
 * spawned with this: the worker spawns them itself on `groundHeightfield`.
 */
export interface SpawnPropsMsg {
  type: 'spawnProps';
  items: PropSpawn[];
}
/**
 * Full repair + re-place props at their spawn transforms, asleep: layout
 * props at their resolved placement, dynamic props at the transform they
 * were spawned with. `objectIds` omitted = every LAYOUT prop (the arena
 * "reset props" key). Unknown / non-prop ids → `error`, nothing changes.
 * Each repaired prop's OBJ_REPAIR_EPOCH increments (visual damage clears).
 */
export interface ResetPropsMsg {
  type: 'resetProps';
  objectIds?: number[];
}

// ---------------------------------------------------------------- traffic (P6, additive; protocol/traffic.ts)
/**
 * Configure (or restart) AI traffic. FULL REPLACE: every existing agent and
 * awake traffic object is removed at the step boundary, then the worker
 * builds the RouteNetwork from its installed layout + terrain
 * (buildRouteNetwork, src/world/routes.ts; requires `groundHeightfield`
 * first, else `error`), compiles each variant once (validateVehicle at
 * TRAFFIC_BEAM_BUDGET; failure → `error`, traffic stays off), settles each
 * variant's rest pose on a private plane (the SETTLED TEMPLATE), places
 * `density.agents` ghosts with its seeded rng (never inside the bubble or
 * the focus's forward cone) and answers `trafficReady`. `enabled: false`
 * (or agents 0) = traffic off, answered with trafficReady{agentCount: 0}.
 * Deterministic: same (layout, seed, variants, density, focus) and command
 * tick ⇒ same agents, poses and decisions.
 */
export interface SetTrafficMsg {
  type: 'setTraffic';
  enabled: boolean;
  /** Seed of the traffic rng stream (independent of InitMsg.seed). */
  seed: number;
  /** ≥ 1 when enabled; agent variant index = index into this array. */
  variants: TrafficVariantSpec[];
  density: TrafficDensity;
  /** The vehicle the awake bubble follows (the player, objectId 1). Missing object = no promotions (all ghosts). */
  focusObjectId: number;
  /** Default TRAFFIC_BUBBLE_DEFAULTS. */
  bubble?: TrafficBubble;
}
/**
 * Retune density without a restart (quality change, the main-side
 * governor). Fewer agents: the highest-index agents retire (awake ones
 * despawn only once out of sight, ghosts at once); more agents: new ones
 * spawn by the respawn rule. Lower maxAwake: the farthest undamaged awake
 * cars demote at the next scheduler tick. No traffic configured → `error`.
 */
export interface SetTrafficDensityMsg {
  type: 'setTrafficDensity';
  density: TrafficDensity;
}
/**
 * SUPERSEDED (P6) by setTraffic.focusObjectId + bubble (the bubble follows a
 * sim object, so it is deterministic without main sending positions). The
 * worker keeps answering `unimplemented`.
 */
export interface SetBubbleMsg {
  type: 'setBubble';
  center: Vec3;
  radius: number;
}
/**
 * RESERVED (P1; P7 keeps it reserved for P8 'keyframe' starts): ask for a
 * replay keyframe. Worker answers `unimplemented`.
 */
export interface KeyframeRequestMsg {
  type: 'keyframeRequest';
  requestId: number;
}
/**
 * SUPERSEDED (P7): scrubbing plays the main-side live replay buffer (no
 * re-simulation on seek; docs/CONTRACTS.md "P7 contracts"). Re-simulation of
 * a ReplayFile runs in its own worker host (src/sim/replay/resim.ts). The
 * worker keeps answering `unimplemented`.
 */
export interface ReplaySeekMsg {
  type: 'replaySeek';
  tick: number;
}

// ---------------------------------------------------------------- replay (P7, additive; protocol/replay.ts)
/**
 * Freeze / unfreeze stepping for the replay viewer. While paused the worker
 * takes no steps at all (independent of `timescale`, which is kept), its
 * pacing clock is re-based every wake (no catch-up burst on resume), and
 * commands still apply (and are logged) as usual — main sends none while
 * replaying. Answered with `replayPaused` carrying the tick and the state
 * hash at that moment: the hash at resume equals the hash at pause when
 * nothing was sent in between (e2e). Idempotent.
 */
export interface ReplayPauseMsg {
  type: 'replayPause';
  paused: boolean;
}
/** Ask for hashSimState() now (answered with `stateHash`; no state change). */
export interface StateHashRequestMsg {
  type: 'stateHashRequest';
  requestId: number;
}
/** Ask for the ReplayFile of the run so far (answered with `replayFile`; input arrays transferred). */
export interface ReplayFileRequestMsg {
  type: 'replayFileRequest';
  requestId: number;
}

// ---------------------------------------------------------------- autopilot (P8, additive; docs/CONTRACTS.md "P8 contracts")
/**
 * Worker-side driver for a main-spawned vehicle (challenge opponents). Mode
 * 'ram': every TRAFFIC_AI_TICKS (100 Hz) at the START of a tick, before
 * phase 1, the worker writes the object's throttle / brake / steer /
 * handbrake / gearSelect from sim state only (its frame nodes and COM, the
 * target's COM + velocity): pursue the target's predicted position, reverse
 * out when stuck or overshot, never trig (sim numerics, src/sim/traffic/
 * autopilot.ts). Deterministic: a pure function of (state, command log).
 * 'off' releases the object (actions zeroed). Main `input` for an
 * autopiloted object is accepted but overwritten at the next AI tick.
 * Unknown / non-vehicle objectId → `error`. Despawn / reset keep the
 * autopilot (reset clears its internal timers); despawn removes it.
 */
export interface SetAutopilotMsg {
  type: 'setAutopilot';
  objectId: number;
  mode: 'off' | 'ram';
  /** The object to ram (default 1, the player). */
  targetObjectId?: number;
  /** 0..1 (default 0.7): target speed 9 + 16·a m/s, lead time, commitment. */
  aggression?: number;
  /** Per-car rng seed (reaction jitter, reverse lengths); default objectId. */
  seed?: number;
}

export type MainToWorker =
  | InitMsg
  | GroundMsg
  | SpawnMsg
  | DespawnMsg
  | InputMsg
  | ResetMsg
  | TimescaleMsg
  | ReturnBufferMsg
  | SpawnVehicleMsg
  | SetTransmissionMsg
  | SetAssistsMsg
  | RecoverMsg
  | GroundHeightfieldCmd
  | SetCollidersMsg
  | SpawnPropsMsg
  | ResetPropsMsg
  | SetTrafficMsg
  | SetTrafficDensityMsg
  | SetAutopilotMsg
  | SetBubbleMsg
  | KeyframeRequestMsg
  | ReplaySeekMsg
  | ReplayPauseMsg
  | StateHashRequestMsg
  | ReplayFileRequestMsg;
export type MainToWorkerType = MainToWorker['type'];

// ============================================================ worker → main
/** Sent once after `init` has been applied. */
export interface ReadyMsg {
  type: 'ready';
}
/** A filled snapshot buffer (layout.ts). Transferred; main must return it via `returnBuffer`. */
export interface SnapshotMsg {
  type: 'snapshot';
  buffer: ArrayBuffer;
}
/** Unrecoverable worker failure; the sim has stopped. */
export interface FatalMsg {
  type: 'fatal';
  message: string;
  stack?: string;
}
/** Answer to a reserved command (or a reserved variant such as ground/heightfield). */
export interface UnimplementedMsg {
  type: 'unimplemented';
  command: MainToWorkerType;
}
/** Recoverable command rejection (unknown objectId, capacity exceeded, invalid rig…). Sim continues. */
export interface ErrorMsg {
  type: 'error';
  command: MainToWorkerType;
  message: string;
  objectId?: number;
}

/** Answer to `groundHeightfield` once the heightfield is active (P3, additive). */
export interface TerrainReadyMsg {
  type: 'terrainReady';
  layoutId: string;
  /** The worker's own hashTerrain(). */
  terrainHash: number;
  /** terrainHash equals the one main sent. */
  matched: boolean;
  /** Worker generation time, ms (perf telemetry). */
  generateMs: number;
  /**
   * P5 additive (absent from pre-P5 workers): layout prop instances spawned
   * (objectIds PROP_LAYOUT_ID_BASE + [0, props)), vegetation colliders
   * installed after the layout colliders, hashVegetation() of the worker's
   * scatter (main compares it with its own; mismatch = console error, like
   * terrainHash), water bodies installed for buoyancy.
   */
  props?: number;
  vegetationColliders?: number;
  vegetationHash?: number;
  waterBodies?: number;
  /**
   * Layout v6 additive (R-WORLD): hashContent() of the worker's buildWorldContent (main
   * compares it with its own; mismatch = console error, like terrainHash), content colliders
   * installed after the layout colliders (before the vegetation colliders) and content props
   * appended after the layout props (their instance indices follow the layout's).
   */
  contentHash?: number;
  contentColliders?: number;
  contentProps?: number;
}

/** One traffic variant's settled template (TrafficReadyMsg.variants, same order as SetTrafficMsg.variants). */
export interface TrafficTemplate {
  catalogId: string;
  /** CompiledVehicle node count (merged canonical order). */
  nodeCount: number;
  /**
   * RIG-LOCAL node positions (xyz × nodeCount) of the variant at rest after
   * TRAFFIC settling (1.5 s on a plane, neutral, brakes on), rigidly
   * re-aligned so its frame (VehicleDef.frame origin/front/top basis)
   * coincides with the rest frame. Ghost pose p_world = quat · p + pos;
   * promotion spawns exactly these nodes under the agent's pose (+ rigid
   * velocity, wheels pre-spun), so the rigid ghost instance and the
   * soft-body car agree at the hand-over.
   */
  settled: Float32Array;
}
/** Answer to `setTraffic` (P6) once the agents exist. */
export interface TrafficReadyMsg {
  type: 'trafficReady';
  /** hashRouteNetwork() of the worker's network (main may compare with its own build). */
  routeHash: number;
  /** RoutePath count of the network (0 when traffic is off). */
  pathCount: number;
  agentCount: number;
  variants: TrafficTemplate[];
  /** Worker time spent building the network + compiling + settling, ms. */
  setupMs: number;
}

/** Answer to `replayPause` (P7). */
export interface ReplayPausedMsg {
  type: 'replayPaused';
  paused: boolean;
  /** engine.tick at the moment the pause state applied. */
  tick: number;
  /** hashSimState() at that tick (u32). */
  stateHash: number;
}
/** Answer to `stateHashRequest` (P7). */
export interface StateHashMsg {
  type: 'stateHash';
  requestId: number;
  tick: number;
  hash: number;
}
/** Answer to `replayFileRequest` (P7). `file.build` is '' (main stamps it), vehicle paints null. */
export interface ReplayFileMsg {
  type: 'replayFile';
  requestId: number;
  file: ReplayFile;
}

export type WorkerToMain =
  | ReadyMsg
  | SnapshotMsg
  | FatalMsg
  | UnimplementedMsg
  | ErrorMsg
  | TerrainReadyMsg
  | TrafficReadyMsg
  | ReplayPausedMsg
  | StateHashMsg
  | ReplayFileMsg;
export type WorkerToMainType = WorkerToMain['type'];
