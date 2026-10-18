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
import type { RigDef } from '../sim/rig/types';

// ============================================================ MaterialId
/**
 * Surface/material ids — FROZEN numeric values. Canonical home is here (both
 * sides need it); `src/sim/types.ts` re-exports it.
 */
export const MaterialId = {
  asphalt: 0,
  grass: 1,
  dirt: 2,
  rock: 3,
  gravel: 4,
  concrete: 5,
  metal: 6,
} as const;
export type MaterialId = (typeof MaterialId)[keyof typeof MaterialId];
export const MATERIAL_COUNT = 7;

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
}
export const Action = {
  throttle: 0,
  brake: 1,
  steer: 2,
  handbrake: 3,
  clutch: 4,
  gearSelect: 5,
} as const satisfies Record<keyof ActionState, number>;
export type ActionIndex = (typeof Action)[keyof typeof Action];
export const ACTION_COUNT = 6;
/** Action names in index order. */
export const ACTION_NAMES: readonly (keyof ActionState)[] = [
  'throttle',
  'brake',
  'steer',
  'handbrake',
  'clutch',
  'gearSelect',
];
/** Inclusive [min, max] per action index (gearSelect max is per-vehicle; 16 is the protocol cap). */
export const ACTION_RANGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 1],
  [-1, 1],
  [0, 1],
  [0, 1],
  [-1, 16],
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
 * RESERVED for P3 (TerrainData freezes then). The worker answers
 * `unimplemented` until P3. `terrain` will become `TerrainData`.
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
/** Full repair: rest pose at `transform`, zero velocity, beams restored (restLen0/k0, active). */
export interface ResetMsg {
  type: 'reset';
  objectId: number;
  transform: Transform;
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

/** RESERVED (P6): awake bubble around the player. Worker may answer `unimplemented`. */
export interface SetBubbleMsg {
  type: 'setBubble';
  center: Vec3;
  radius: number;
}
/** RESERVED (P7): ask for a replay keyframe. Worker may answer `unimplemented`. */
export interface KeyframeRequestMsg {
  type: 'keyframeRequest';
  requestId: number;
}
/** RESERVED (P7): re-simulate to `tick`. Worker may answer `unimplemented`. */
export interface ReplaySeekMsg {
  type: 'replaySeek';
  tick: number;
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
  | SetBubbleMsg
  | KeyframeRequestMsg
  | ReplaySeekMsg;
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

export type WorkerToMain = ReadyMsg | SnapshotMsg | FatalMsg | UnimplementedMsg | ErrorMsg;
export type WorkerToMainType = WorkerToMain['type'];
