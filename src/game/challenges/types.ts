/**
 * Stunt challenges — the P8 contract (docs/CONTRACTS.md "P8 contracts").
 * Change only via that doc. Main thread only; pure data + pure evaluator
 * types here (no three, no DOM): the definitions, the per-snapshot sample
 * the evaluators read, the run state / events the UI reads, results,
 * medals, personal bests and ghost tracks.
 *
 * MODEL. A ChallengeDef is DATA: where you start (spawn pose), in what
 * (vehicle rule), what is placed for it (props, an optional extra collider
 * set, AI opponents, traffic density), what you must do (objectives), how
 * the run is scored (scoring) and the medal thresholds (bronze / silver /
 * gold + the hidden 'crumple' platinum). The runtime (runtime.ts) is a pure
 * state machine fed one ChallengeSample per LIVE SNAPSHOT (120 Hz, built
 * from the SnapshotReader by app/challenges.ts; never from replay frames),
 * so every timer and counter is in SIM time and keyed to worker ticks:
 *
 *   time   = (finishTick − goTick) / SIM_HZ, gate crossings interpolated
 *            between the two snapshot ticks around the crossing (sub-tick
 *            precise, independent of the render frame rate and of slow-mo);
 *   counts = flips / airtime / drift integrate snapshot to snapshot.
 *
 * Phases: idle → intro (fly-in, set-up applied) → countdown (3-2-1, the car
 * held by the input filter) → running → finished | failed. Restart = the
 * set-up re-applied (vehicle `reset` to the spawn pose, the challenge props
 * `resetProps`, opponents reset, evaluators cleared) → countdown again; it
 * needs no reload and no new spawn.
 */
import type { VehicleId } from '../catalogTypes';
import type { PropKey } from '../../sim/props/types';
import type { ColliderDef } from '../../world/types';

// ============================================================ geometry
/** World XZ point (m). */
export type XZ = readonly [number, number];
/** World position; y null = on the terrain (a gate's base, a spawn dropped onto the ground). */
export type PosDef = readonly [number, number | null, number];

/**
 * Start pose. yawDeg: 0 faces −Z (north), 90 faces −X (the `__crumple.place`
 * convention). y null = dropped onto the terrain by the rig's rest clearance
 * (app/spawn placeOnGround); a number = the ground plane height there (a
 * collider deck), the car placed on it pitched by pitchDeg (+ = nose up).
 */
export interface SpawnDef {
  pos: PosDef;
  yawDeg: number;
  pitchDeg?: number;
}

/**
 * A checkpoint gate: a vertical rectangle across the course. The car passes
 * it when its centre of mass crosses the gate plane in the travel direction
 * (yawDeg, same convention as SpawnDef) within ±width/2 of `pos` laterally
 * and between the base and base + height. y null = base on the terrain.
 */
export interface GateDef {
  pos: PosDef;
  yawDeg: number;
  /** m; default 10. */
  width?: number;
  /** m; default 5. */
  height?: number;
}

/** A plan-view zone (y ignored): rotated rectangle or circle. */
export type ZoneDef =
  | { kind: 'rect'; center: XZ; halfX: number; halfZ: number; yawDeg?: number }
  | { kind: 'circle'; center: XZ; radius: number };

// ============================================================ vehicle
export type VehicleRule =
  /** This car only (fairness: tuned on it); `palette` optional. */
  | { kind: 'forced'; id: VehicleId; palette?: string }
  /** The player's current car; `allowed` (default every player vehicle). */
  | { kind: 'choice'; allowed?: readonly VehicleId[] };

// ============================================================ objectives
/**
 * Objective roles: a GOAL must be met to finish (all goals met → finished);
 * a FAIL condition ends the run as failed; a METER only measures (it feeds
 * the score). Each type below states its role.
 */
export type ObjectiveDef =
  /** GOAL: pass every gate in order (the last one is the finish line). Missed gates are not skipped: the arrow points to the next one. */
  | { type: 'gates'; gates: readonly GateDef[] }
  /** FAIL ('fail') or GOAL ('finish': the run ends, scored as it stands) when the run clock reaches `seconds`. */
  | { type: 'timeLimit'; seconds: number; onExpire: 'fail' | 'finish' }
  /** GOAL: travel `meters` of COM path (ground + air). */
  | { type: 'distance'; meters: number }
  /**
   * METER (+ GOAL when `ends`): jumps. A jump starts when the car leaves the
   * ground (telemetry airborne, no body contact) — optionally only inside
   * `takeoff` — and lands on the first ground or body contact after
   * ≥ minAirtimeS (default 0.25 s). Measures distance (takeoff → touchdown,
   * horizontal), airtime and height (max COM rise). `ends`: the run finishes
   * `settleS` (default 2.5) after the first qualifying landing.
   */
  | { type: 'jump'; takeoff?: ZoneDef; minAirtimeS?: number; ends?: boolean; settleS?: number }
  /** METER: rotations integrated from the chassis orientation (roll = about forward, pitch = about right). */
  | { type: 'flips'; axis: 'roll' | 'pitch' | 'any' }
  /**
   * After the run's terminal event (landing / impact / finish), the car must
   * rest upright (up·Y ≥ 0.5) `settleS` later. 'require' fails otherwise;
   * 'bonus' multiplies the score by `factor` when NOT upright (e.g. 0.5).
   */
  | { type: 'landUpright'; mode: 'require' | 'bonus'; factor?: number }
  /** GOAL: reach `kmh` (inside `zone` when given). Always meters the top speed. */
  | { type: 'topSpeed'; kmh: number; zone?: ZoneDef }
  /** METER: drift score (see DRIFT below). */
  | { type: 'drift' }
  /** METER: destruction score from the event rings + broken beams of props / other vehicles (see DESTRUCTION). */
  | { type: 'destruction'; scope: 'props' | 'vehicles' | 'all' }
  /** METER: knocked-down count of the challenge props of group `group` (tilt > 35° or moved > 0.8 m). */
  | { type: 'pins'; group: string }
  /** FAIL: player telemetry damage above `max` (0..1). */
  | { type: 'damageCap'; max: number }
  /** FAIL: the car on its side / roof (up·Y < 0.5) for `graceS` (default 1.5). */
  | { type: 'upright'; graceS?: number }
  /** FAIL: the COM outside `zone` for `graceS` (default 2). */
  | { type: 'bounds'; zone: ZoneDef; graceS?: number }
  /** GOAL: come to rest (< maxKmh, default 2) inside `zone` and hold `holdS` (default 1). */
  | { type: 'stopInZone'; zone: ZoneDef; maxKmh?: number; holdS?: number }
  /**
   * GOAL: park in `bay` (all four wheel hubs inside the painted rectangle,
   * heading within maxYawDeg of yawDeg either way round unless `oriented`),
   * below 1 km/h for holdS (default 1.5). Meters the precision (centre
   * offset cm, yaw error °).
   */
  | { type: 'park'; bay: { center: XZ; yawDeg: number; halfWidth: number; halfLength: number }; maxYawDeg?: number; oriented?: boolean; holdS?: number }
  /**
   * GOAL: hit something at ≥ minKmh (body impact, not tyres); the run ends
   * `settleS` (default 2) later. Meters the impact speed (COM speed just
   * before the first body impulse ≥ 150 N·s) and the crush (CRUSH below).
   */
  | { type: 'impact'; minKmh: number; settleS?: number }
  /**
   * GOAL: last one moving. Opponents are OUT when their damage ≥ wreckDamage
   * or they moved < 1 m in immobileS; the player FAILS by the same rules.
   * Meters knock-outs and survival time.
   */
  | {
      type: 'derby';
      immobileS: number;
      /** Opponents are wrecked at this telemetry damage. */
      wreckDamage: number;
      /** The player's own stall limit (default immobileS): pinned by rammers is not stalling. */
      playerImmobileS?: number;
      /** The player's wreck damage (default wreckDamage): the beater crumples far sooner than a traffic sedan. */
      playerWreckDamage?: number;
    };

// ============================================================ set-up
/** Challenge props: spawned with `spawnProps` (dynamic ids) on start, `resetProps` on restart, despawned on exit. */
export interface ChallengePropDef {
  /** Group name (pins objective, destruction scope). */
  group: string;
  prop: PropKey;
  pos: PosDef;
  /** Unit (x, z) the prop's front looks at (layout convention); default (0, −1). */
  facing?: XZ;
}

/** AI opponents (derby): `spawnVehicle` + the worker's `setAutopilot` ram driver, targeting the player. */
export interface OpponentDef {
  vehicle: VehicleId;
  spawn: SpawnDef;
  /** Palette id; default the catalog order by index. */
  palette?: string;
  /** 0..1 (driver target speed and corner commitment); default 0.7. */
  aggression?: number;
}

/** Scoring: which metric is the score, which way is better, how it reads. */
export type ChallengeMetric =
  | 'time' //        run clock at finish, s (gates / stop / park)
  | 'jumpDistance' // best (or `ends`) jump distance, m
  | 'airtime' //     total airtime, s
  | 'rolls' //       roll rotations (count, 0.25 steps)
  | 'flips' //       pitch + roll rotations
  | 'crush' //       crush depth, cm
  | 'pins' //        props of the pins group down
  | 'drift' //       drift points
  | 'destruction' // destruction points
  | 'stunt' //       stunt points (air + flips + drift combos)
  | 'derby' //       derby points (knock-outs × 1000 + damage dealt to the rest × 500 per wreck + survival s × 10)
  | 'park' //        park points (see PARK)
  | 'topSpeed'; //   km/h

export interface ScoringDef {
  metric: ChallengeMetric;
  better: 'lower' | 'higher';
  /** Display unit ('s', 'm', 'cm', 'pts', 'pins', 'km/h', '×'). */
  unit: string;
  decimals: number;
}

/**
 * Medal thresholds in score units. better 'lower': score ≤ threshold earns
 * it; 'higher': score ≥ threshold. 'crumple' is the hidden platinum (its
 * threshold is not shown until earned). Every threshold comes from measured
 * runs (docs/CONTRACTS.md "P8 challenges as built" lists how).
 */
export interface MedalThresholds {
  bronze: number;
  silver: number;
  gold: number;
  crumple: number;
}
export type MedalId = 'none' | 'bronze' | 'silver' | 'gold' | 'crumple';
export const MEDAL_ORDER: readonly MedalId[] = ['none', 'bronze', 'silver', 'gold', 'crumple'];

export interface ChallengeDef {
  id: string;
  name: string;
  /** One line on the card. */
  blurb: string;
  /** Longer briefing on the intro / select detail. */
  brief: string;
  /** Location tag on the card ('Stunt Park', 'Ridge Pass', …). */
  where: string;
  /** Card accent / icon key. */
  icon: 'jump' | 'roll' | 'wall' | 'bowling' | 'drift' | 'truck' | 'derby' | 'climb' | 'park' | 'air';
  vehicle: VehicleRule;
  spawn: SpawnDef;
  /** Traffic agents while the challenge runs (0 = none); omitted = unchanged. */
  traffic?: number;
  props?: readonly ChallengePropDef[];
  /** Extra static colliders (protocol `setColliders`) while it runs; [] restored on exit. */
  colliders?: readonly ColliderDef[];
  opponents?: readonly OpponentDef[];
  /** Traction control forced for the run (restored after); omitted = the player's setting. */
  tractionControl?: boolean;
  objectives: readonly ObjectiveDef[];
  scoring: ScoringDef;
  medals: MedalThresholds;
  /** Optional camera fly-in start for the intro (world m); default behind the spawn. */
  introCamera?: { pos: readonly [number, number, number]; target: readonly [number, number, number] };
  /** Bot line for playtests / e2e (gate centres are used when omitted). */
  botLine?: readonly XZ[];
}

// ============================================================ per-snapshot sample
/**
 * What the evaluators read, one per live snapshot (built allocation-free by
 * app/challenges.ts from the SnapshotReader; reused object). All world m,
 * m/s, sim s. `valid` false = the player is absent (swap / despawn).
 */
export interface ChallengeSample {
  valid: boolean;
  tick: number;
  simTime: number;
  /** Frame-origin node (VehicleDef frame; the ghost is posed by it). */
  origin: [number, number, number];
  /** Centre of mass and its velocity (telemetry). */
  pos: [number, number, number];
  vel: [number, number, number];
  /** Chassis frame from the VehicleDef frame nodes (unit, orthonormal). */
  forward: [number, number, number];
  up: [number, number, number];
  /** Signed speed along forward, m/s. */
  speed: number;
  /** Telemetry airborne (no wheel on anything) AND no body contact event this snapshot. */
  airborne: boolean;
  /** Any wheel in contact (bit set in telemetry wheelContact). */
  wheelContact: number;
  /** Any player body (non-tyre) impact this snapshot, and its largest impulse (N·s). */
  bodyImpact: boolean;
  bodyImpulse: number;
  damage: number;
  /** Mean rear-wheel slip m/s (drift). */
  slip: number;
  /** Ground height under the COM (terrain; colliders not included). */
  groundY: number;
  /** Front crush (cm): rest − current length of the frame along forward (CRUSH). */
  crushCm: number;
  /** Wheel hub XZ positions FL FR RL RR (park). */
  hubs: [number, number, number, number, number, number, number, number];
  /** Destruction this snapshot (DESTRUCTION), split by scope. */
  propHits: number;
  vehicleHits: number;
  /** Pins down (by group), filled when the def has a pins objective. */
  pinsDown: Record<string, number>;
  /** Opponents (derby): per opponent damage, COM, alive flag (present in the snapshot). */
  opponents: { id: number; present: boolean; damage: number; pos: [number, number, number]; upY: number }[];
}

// ============================================================ run state / events
export type ChallengePhase = 'idle' | 'intro' | 'countdown' | 'running' | 'finished' | 'failed';

export interface ObjectiveStatus {
  /** Index into def.objectives. */
  index: number;
  type: ObjectiveDef['type'];
  /** One line for the HUD ("Gate 3 / 8", "Stay upright", "Pins 6 / 10"). */
  text: string;
  done: boolean;
  failed: boolean;
}

/** Popup kinds (HUD colours): air, flip, drift, smash, gate, warn, info. */
export type PopupKind = 'air' | 'flip' | 'drift' | 'smash' | 'gate' | 'warn' | 'info';

export type ChallengeEvent =
  | { type: 'phase'; phase: ChallengePhase }
  | { type: 'countdown'; n: number } // 3, 2, 1, 0 = GO
  | { type: 'gate'; index: number; count: number; split: number; delta: number | null }
  | { type: 'popup'; kind: PopupKind; text: string; sub?: string; points?: number }
  | { type: 'finish'; result: ChallengeResult };

export interface ChallengeRunState {
  phase: ChallengePhase;
  /** Run clock, sim s (0 until GO; frozen at the end). */
  clock: number;
  /** Countdown digit 3..1 while counting, 0 otherwise. */
  countdown: number;
  score: number;
  /** Score as displayed (decimals + unit). */
  scoreText: string;
  objectives: ObjectiveStatus[];
  /** Next gate index (gates objective), −1 none. */
  nextGate: number;
  /** Drift combo in progress (multiplier ≥ 1, points pending), or null. */
  combo: { multiplier: number; points: number; kind: 'drift' | 'air' } | null;
  failReason: string | null;
}

export interface ResultStat {
  label: string;
  value: string;
}

export interface ChallengeResult {
  id: string;
  completed: boolean;
  failReason: string | null;
  score: number;
  scoreText: string;
  medal: MedalId;
  /** Run clock at the end, s. */
  time: number;
  stats: ResultStat[];
  /** PB before this run (null = none) and whether this run beat it. */
  previousBest: number | null;
  isBest: boolean;
  vehicle: string;
  /** Worker ticks and sim times of GO and of the end (replay seek, input slice). */
  goTick: number;
  endTick: number;
  goSimTime: number;
  endSimTime: number;
}

// ============================================================ storage + ghosts
/** localStorage key of the personal bests (wrapped in try/catch everywhere). */
export const CHALLENGE_STORAGE_KEY = 'crumple.challenges.v1';

/**
 * GHOST TRACK (decision: pose keyframes, not re-simulation). The player's
 * frame-origin pose sampled at GHOST_HZ in run time (s since GO): x, y, z
 * as f32 + the chassis quaternion as 4 × i16 (×32767). 20 B per frame →
 * 600 B/s, a 90 s run ≈ 54 KB (72 KB base64). WHY not `resimulate` in a
 * hidden worker: a ReplayFile starts at `init`, so re-simulating a PB means
 * re-running the whole session (terrain generation + every command since
 * boot: seconds to minutes of CPU) and the reserved keyframe start does not
 * exist; keyframes are exact for the recorded run, cost nothing to play and
 * survive build changes (a re-simulation would refuse another build's file).
 * The PB's input log (worker ticks relative to GO, objectId 1) is stored
 * beside it (PbRecord.inputs) for validation / export.
 */
export const GHOST_HZ = 30;
export interface GhostTrack {
  hz: number;
  vehicle: string;
  palette: string | null;
  /** n frames. */
  count: number;
  /** 3 × count f32. */
  pos: Float32Array;
  /** 4 × count i16 (quat × 32767). */
  quat: Int16Array;
}

export interface PbRecord {
  best: number;
  medal: MedalId;
  /** ISO time of the PB. */
  at: string;
  vehicle: string;
  build: string;
  /** encodeGhost() base64, or absent. */
  ghost?: string;
  /** encodeInputs() base64 of the PB's input slice (tick − goTick, action, value), or absent (too large). */
  inputs?: string;
  /** Best medal ever earned (a later worse run never lowers it). */
  bestMedal: MedalId;
  attempts: number;
}
export interface ChallengeStore {
  version: 1;
  records: Record<string, PbRecord>;
}

// ============================================================ tuning constants (evaluators)
/**
 * DRIFT: per snapshot while on the ground, speed ≥ DRIFT_MIN_SPEED and the
 * slip angle between the velocity and the chassis forward ≥ DRIFT_MIN_ANGLE:
 * points += angle(°) × speed(m/s) × dt × DRIFT_POINTS_SCALE. A drift chain
 * banks when the angle stays below the minimum for DRIFT_CHAIN_GAP_S; each
 * DRIFT_COMBO_STEP_S of continuous drift raises the multiplier by 1 (≤
 * DRIFT_MAX_MULT); banked = chain points × multiplier. A body impact
 * (≥ DRIFT_BREAK_IMPULSE N·s) BREAKS the chain: its pending points are lost.
 */
export const DRIFT_MIN_SPEED = 8;
export const DRIFT_MIN_ANGLE_DEG = 12;
export const DRIFT_MAX_ANGLE_DEG = 110;
export const DRIFT_POINTS_SCALE = 0.1;
export const DRIFT_CHAIN_GAP_S = 0.8;
export const DRIFT_COMBO_STEP_S = 1.5;
export const DRIFT_MAX_MULT = 8;
export const DRIFT_BREAK_IMPULSE = 120;
/**
 * DESTRUCTION: every impact event on a prop / other vehicle object with
 * impulse ≥ 20 N·s adds impulse × 0.05 points, every broken beam of a prop
 * / other vehicle adds 4 points (prop / vehicle split by scope).
 */
export const DESTRUCTION_IMPULSE_MIN = 20;
export const DESTRUCTION_IMPULSE_POINTS = 0.05;
export const DESTRUCTION_BEAM_POINTS = 4;
/** STUNT points: per landed jump 100 × airtime s (+ 50 × height m), per rotation 500, per banked drift its points. */
export const STUNT_AIR_POINTS = 100;
export const STUNT_HEIGHT_POINTS = 50;
export const STUNT_ROTATION_POINTS = 500;
/** CRUSH: rest length of the frame (frame origin → front reference, plus the rear) minus the current one, cm (≥ 0). */
export const CRUSH_SETTLE_S = 1.5;
/**
 * PARK points: 1000 − 4 × centre offset (cm) − 15 × yaw error (°) − 10 × time (s), ≥ 0.
 */
export const PARK_BASE = 1000;
/** Run settle after a terminal event before the result (s, sim) unless the objective says otherwise. */
export const DEFAULT_SETTLE_S = 2;
/** Countdown: 3 ticks of 0.8 s sim time each, then GO. */
export const COUNTDOWN_STEP_S = 0.8;
