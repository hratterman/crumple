/**
 * AI traffic — protocol contract (P6, additive; docs/CONTRACTS.md "P6
 * contracts"). Pure: no three, no DOM, no sim imports.
 *
 * SCHEDULING IS WORKER-INTERNAL. Main configures traffic once
 * (`setTraffic`) and may retune the density (`setTrafficDensity`); the
 * worker owns the route network, every agent's driver model, the awake ⇄
 * ghost scheduler and the spawns/despawns of awake cars, all on fixed tick
 * boundaries from seeded state. Main only READS the result: one TRAFFIC
 * SECTION per snapshot (below) with every agent's pose and AI intent.
 * WHY: promotion, demotion, respawn and AI inputs all depend on sim state
 * (the player's pose, contacts, damage); deciding them on main would make
 * them depend on frame timing, and every decision would have to be shipped
 * back as a command and logged for replay. In the worker they are a pure
 * function of (seed, command log), so the P1 determinism hash and the P7
 * replay cover traffic for free.
 *
 * AGENTS. `density.agents` agents (≤ TRAFFIC_MAX_AGENTS), index 0..n−1,
 * stable for the life of a `setTraffic` config. An agent is either
 *   GHOST  — a kinematic route follower (route s, speed v): zero soft-body
 *            cost, no collision, pose = routePose(path, s) placed so the
 *            variant's SETTLED template (TrafficReadyMsg) stands on the road;
 *   AWAKE  — a full soft-body vehicle, objectId = TRAFFIC_ID_BASE + agent
 *            index, driven by the same driver model through its ActionState.
 * Awake objects are ordinary snapshot objects (nodes, telemetry, events,
 * broken bits); main tells them apart with isTrafficObjectId().
 */
import type { VehicleDef } from '../sim/vehicle/types';

// ============================================================ ids
/**
 * Awake traffic objectIds: [TRAFFIC_ID_BASE, TRAFFIC_ID_BASE + TRAFFIC_MAX_AGENTS)
 * = TRAFFIC_ID_BASE + agent index. Inside the vehicle id range [1, 4096), so
 * awake traffic steps after the player (1) and the debug cube (2) and before
 * every prop. Main never spawns into this range.
 */
export const TRAFFIC_ID_BASE = 100;
/** Hard cap on agents per config (snapshot section capacity). */
export const TRAFFIC_MAX_AGENTS = 64;
/** Player rig beams already inside the measured baseline (the sedan, 2081); a heavier focus rig takes the excess from the traffic pool. */
export const TRAFFIC_PLAYER_BASELINE_BEAMS = 2100;
/** Hard cap on simultaneously awake traffic cars (any density). */
export const TRAFFIC_MAX_AWAKE = 6;

export function isTrafficObjectId(objectId: number): boolean {
  return objectId >= TRAFFIC_ID_BASE && objectId < TRAFFIC_ID_BASE + TRAFFIC_MAX_AGENTS;
}
export function trafficAgentOfObject(objectId: number): number {
  return isTrafficObjectId(objectId) ? objectId - TRAFFIC_ID_BASE : -1;
}

// ============================================================ config
/**
 * Density + awake budget (per QUALITY preset, `QualityPreset.traffic`; see
 * the CONTRACTS awake-budget table). The worker enforces, at every
 * scheduler tick,
 *   pool  = awakePoolBeams − (beams of awake props) − max(0, focus beams − TRAFFIC_PLAYER_BASELINE_BEAMS)
 *   effectiveMaxAwake = max(1, min(maxAwake, floor(pool / max variant beams)))
 * (min 1 while any agent exists: a ghost the player can reach must be
 * promotable; a heavier player rig — the box truck — eats into the pool).
 */
export interface TrafficDensity {
  /** Agents alive (ghost + awake), 0..TRAFFIC_MAX_AGENTS. 0 = no traffic. */
  agents: number;
  /** Awake soft-body cars at most, 0..TRAFFIC_MAX_AWAKE. */
  maxAwake: number;
  /** Beam pool shared by awake traffic AND awake props (the player is outside it). */
  awakePoolBeams: number;
}

/** One traffic car model. The worker compiles it once per config (never per promotion). */
export interface TrafficVariantSpec {
  /** VehicleCatalog id (render looks up the visual def by it). */
  catalogId: string;
  /** Plain-JSON def; validated against TRAFFIC_BEAM_BUDGET (1500) or rejected with `error`. */
  vehicle: VehicleDef;
  /** Relative spawn weight (> 0). */
  weight: number;
  /** Paint palette entries the worker may pick from (agent paint index ∈ [0, paletteCount)). */
  paletteCount: number;
}

/** Bubble radii around the focus vehicle's frame origin, m (hysteresis: promote < demote). */
export interface TrafficBubble {
  promoteM: number;
  demoteM: number;
}
export const TRAFFIC_BUBBLE_DEFAULTS: Readonly<TrafficBubble> = { promoteM: 110, demoteM: 160 };

// ============================================================ snapshot section
/**
 * TRAFFIC SECTION (snapshot, P6 additive; layout.ts HDR_TRAFFIC_*): up to
 * TRAFFIC_MAX_AGENTS records of TRAFFIC_RECORD_WORDS u32/f32 words, one per
 * live agent in ascending agent index, ghost AND awake. Count 0 when traffic
 * is off. Poses are the agent's VEHICLE FRAME placement: rig-local → world
 * is p_world = quat · p_local + pos, where p_local are the variant's settled
 * template nodes (TrafficReadyMsg). For an awake agent the pose is measured
 * from its nodes (frame origin / front / top basis, the same frame the
 * template is aligned to); main draws its nodes, not the pose.
 *
 * | word | field     | type | meaning                                                              |
 * |------|-----------|------|----------------------------------------------------------------------|
 * | 0    | agent     | u32  | agent index                                                          |
 * | 1    | objectId  | u32  | awake: TRAFFIC_ID_BASE + agent; ghost: 0                             |
 * | 2    | flags     | u32  | TRAFFIC_FLAG_* (AI intent + mode)                                    |
 * | 3    | look      | u32  | variant index (low 16 bits) | paint index (high 16 bits)            |
 * | 4    | state     | u32  | TrafficAiState                                                       |
 * | 5–7  | pos       | f32  | world m                                                              |
 * | 8–11 | quat      | f32  | [x, y, z, w], unit                                                   |
 * | 12   | speed     | f32  | m/s along the heading (signed)                                       |
 * | 13   | steer     | f32  | applied steer −1..1 (ghost: the pure-pursuit command; wheel yaw)     |
 * | 14   | brake     | f32  | brake lamp intensity 0..1                                            |
 * | 15   | path      | u32  | RoutePath index the agent follows (debug / minimap)                  |
 */
export const TRAFFIC_RECORD_WORDS = 16;
export const TRAFFIC_RECORD_BYTES = TRAFFIC_RECORD_WORDS * 4;
export const TR_AGENT = 0;
export const TR_OBJECT_ID = 1;
export const TR_FLAGS = 2;
export const TR_LOOK = 3;
export const TR_STATE = 4;
export const TR_POS = 5;
export const TR_QUAT = 8;
export const TR_SPEED = 12;
export const TR_STEER = 13;
export const TR_BRAKE = 14;
export const TR_PATH = 15;

/** Agent flags (word 2). */
export const TRAFFIC_FLAG_AWAKE = 1 << 0;
/** Brake lamps lit (awake: applied brake ≥ 0.05; ghost: commanded decel ≥ 1 m/s²). */
export const TRAFFIC_FLAG_BRAKE = 1 << 1;
export const TRAFFIC_FLAG_INDICATOR_L = 1 << 2;
export const TRAFFIC_FLAG_INDICATOR_R = 1 << 3;
/** Hazard lights (stuck, wrecked, broken down): both indicators blink. */
export const TRAFFIC_FLAG_HAZARD = 1 << 4;
export const TRAFFIC_FLAG_REVERSE = 1 << 5;
export const TRAFFIC_FLAG_HEADLIGHTS = 1 << 6;
/**
 * The pose jumped since the previous snapshot (spawn, respawn/recycle,
 * demotion snap): main must not interpolate it from the previous record.
 */
export const TRAFFIC_FLAG_TELEPORTED = 1 << 7;
/** Damaged beyond TRAFFIC_WRECK_DAMAGE / on its side / stuck: awaiting an out-of-sight respawn. */
export const TRAFFIC_FLAG_WRECKED = 1 << 8;
/** Waiting at a junction to give way. */
export const TRAFFIC_FLAG_YIELDING = 1 << 9;

/** Driver state (word 4). */
export const TrafficAiState = {
  cruise: 0,
  follow: 1,
  yield: 2,
  turn: 3,
  laneChange: 4,
  stopped: 5,
  stuck: 6,
  wrecked: 7,
} as const;
export type TrafficAiState = (typeof TrafficAiState)[keyof typeof TrafficAiState];

/** Decoded traffic record (main-side convenience; reuse instances). */
export interface TrafficAgentFrame {
  agent: number;
  objectId: number;
  flags: number;
  variant: number;
  paint: number;
  state: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  speed: number;
  steer: number;
  brake: number;
  path: number;
  /**
   * Main-side (SimClient.readTrafficAgents), not in the record: the awake
   * object exists in BOTH interpolation snapshots, so its interpolated nodes
   * are valid this frame. The soft-body visual takes over only then; until
   * then (and after a demotion until the ghost record is in both snapshots)
   * the rigid instance keeps drawing — no pop at the hand-over.
   */
  nodesReady: boolean;
}

export function createTrafficAgentFrame(): TrafficAgentFrame {
  return {
    agent: 0,
    objectId: 0,
    flags: 0,
    variant: 0,
    paint: 0,
    state: 0,
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    speed: 0,
    steer: 0,
    brake: 0,
    path: 0,
    nodesReady: false,
  };
}

/** Packs variant + paint into the `look` word. */
export function packTrafficLook(variant: number, paint: number): number {
  return ((variant & 0xffff) | ((paint & 0xffff) << 16)) >>> 0;
}

// ============================================================ worker constants (shared so render/tests agree)
/** The driver model + scheduler run every TRAFFIC_AI_TICKS fixed ticks (100 Hz at dt 1/2000), at the start of a tick. */
export const TRAFFIC_AI_TICKS = 20;
/** Telemetry damage above which an awake agent counts as wrecked (recycled out of sight). */
export const TRAFFIC_WRECK_DAMAGE = 0.15;
/** A ghost that cannot be promoted (no awake slot) is recycled before it gets this close to the focus, m. */
export const TRAFFIC_CONTACT_M = 45;
/** Respawns land at least this far from the focus, m, and never in its forward ±70° cone closer than TRAFFIC_SPAWN_CONE_M. */
export const TRAFFIC_SPAWN_MIN_M = 250;
export const TRAFFIC_SPAWN_CONE_M = 600;
