/**
 * ReplayFile — the deterministic replay contract (P7; docs/CONTRACTS.md
 * "P7 contracts"). FROZEN at the end of P7. Pure: no three, no DOM, no sim
 * imports (type-only refs are erased).
 *
 * TWO REPLAY MECHANISMS (decision, P7):
 *  1. The LIVE REPLAY BUFFER (main thread, src/app/replay/**) records what
 *     the renderer consumed — quantized node positions, telemetry, broken
 *     bits, traffic records, the event rings — for the last 20–60 s. It
 *     drives scrubbing, slow-mo, reverse and the free camera. It is NOT a
 *     ReplayFile and never leaves the page.
 *  2. The REPLAY FILE (this module) is the deterministic COMMAND LOG kept by
 *     the worker since `init`: every state-changing command with the tick it
 *     was applied at, and the per-action input log `(tick, objectId,
 *     action, value)` (PLAN: "inputs are recorded in-worker"). Re-simulating
 *     it from the start reference on the same build reproduces the live run
 *     bit-exactly (same state hash). Used by P8 ghost runs and export.
 *
 * RE-SIMULATION ORDER (exact): create the worker host, apply `init`, then
 * walk the command list and the input log merged by (tick, then log order:
 * a command applies after the first `ReplayCommandEntry.input` input
 * entries); before applying an entry, step the engine until its tick equals
 * the entry's tick. Finally step to `toTick`. Snapshots are irrelevant to
 * the state (writing them never changes it), so a re-simulation may write
 * none. `src/sim/replay/resim.ts` implements this (worker-side helper).
 */
import type { Vec3 } from '../core/math';
import type { MainToWorker, SnapshotCapacity } from './messages';

export const REPLAY_FILE_FORMAT = 'crumple.replay';
/** Bump on any change to the file shape or to the meaning of a logged command. */
export const REPLAY_FILE_VERSION = 1;

/**
 * Commands that change sim state and therefore go into the log, in the
 * order the worker applied them. NOT logged: `init` (it is the file's
 * `init`), `input` (the compact input log instead), `timescale` (pacing
 * only), `returnBuffer`, the P7 replay/hash/file requests and the reserved
 * commands answered `unimplemented`. A logged command that the worker
 * rejected (`error`) stays in the log: re-simulation rejects it the same way.
 */
export const REPLAYABLE_COMMANDS = [
  'ground',
  'groundHeightfield',
  'spawn',
  'despawn',
  'reset',
  'spawnVehicle',
  'setTransmission',
  'setAssists',
  'recover',
  'setColliders',
  'spawnProps',
  'resetProps',
  'setTraffic',
  'setTrafficDensity',
] as const satisfies readonly MainToWorker['type'][];
export type ReplayableCommandType = (typeof REPLAYABLE_COMMANDS)[number];
export type ReplayableCommand = Extract<MainToWorker, { type: ReplayableCommandType }>;

export function isReplayableCommand(type: string): type is ReplayableCommandType {
  return (REPLAYABLE_COMMANDS as readonly string[]).includes(type);
}

/** The worker's `init` parameters (capacity resolved to the value in effect). */
export interface ReplayInit {
  seed: number;
  gravity: Vec3;
  snapshotHz: number;
  debugStrains: boolean;
  capacity: SnapshotCapacity;
}

/** The world the run took place in (the last `groundHeightfield`; null = plane ground / none). */
export interface ReplayLayoutRef {
  /** WorldLayout.id */
  id: string;
  /** WorldLayout.version (bumps whenever terrain or colliders change). */
  version: number;
  /** The worker's hashTerrain() of that layout. */
  terrainHash: number;
}

/** One vehicle spawned during the run (objectId 1 = the player). */
export interface ReplayVehicleRef {
  objectId: number;
  /** spawnVehicle.catalogId, or null for ad-hoc defs. */
  catalogId: string | null;
  /** Palette id (main-side knowledge: main stamps it before export; the worker writes null). */
  paint: string | null;
  /** Tick of the spawnVehicle command. */
  spawnTick: number;
}

/**
 * Where re-simulation starts.
 *  - 'boot': an empty worker; `init` + the whole command log from tick 0.
 *  - 'keyframe': RESERVED for P8 (time-trial ghosts start from a captured
 *    state at `tick` whose state hash is `stateHash`; not produced in P7).
 */
export type ReplayStart = { kind: 'boot' } | { kind: 'keyframe'; tick: number; stateHash: number };

/** One logged command. */
export interface ReplayCommandEntry {
  /** engine.tick when the worker applied it (commands apply between steps). */
  tick: number;
  /** Number of input-log entries logged before this command (orders commands and inputs within a tick). */
  input: number;
  cmd: ReplayableCommand;
}

/**
 * The input log, SoA, `count` valid entries in application order. One entry
 * per action whose CLAMPED value changed when an `input` command applied
 * (engine.setInput semantics: ACTION_RANGES clamp, gearSelect rounded).
 * Re-simulation sets `actions[action] = value` directly (idempotent clamp).
 */
export interface ReplayInputLog {
  count: number;
  tick: Uint32Array;
  objectId: Uint32Array;
  /** ActionIndex (protocol/messages.ts Action). */
  action: Uint8Array;
  value: Float64Array;
}

export interface ReplayFile {
  format: typeof REPLAY_FILE_FORMAT;
  version: number;
  /** Build hash (vite define __BUILD_HASH__); main stamps it. Playback refuses another build's file. */
  build: string;
  init: ReplayInit;
  layout: ReplayLayoutRef | null;
  vehicles: ReplayVehicleRef[];
  start: ReplayStart;
  /** First tick covered (0 for 'boot'). */
  fromTick: number;
  /** engine.tick when the file was produced. */
  toTick: number;
  /** hashSimState() at toTick (re-simulation must reproduce it). */
  endStateHash: number;
  commands: ReplayCommandEntry[];
  inputs: ReplayInputLog;
  /**
   * The input log hit REPLAY_INPUT_LOG_MAX and stopped recording: the file
   * cannot reproduce the run past `toTick` of the last good entry (P7 keeps
   * logging otherwise unbounded in chunks; ≈ 1 KB/s of steady steering).
   */
  truncated: boolean;
}

/** Hard cap on input-log entries (≈ 9 h of continuous 60 Hz steering). */
export const REPLAY_INPUT_LOG_MAX = 1 << 21;

export type ReplayFileCheck = 'ok' | 'bad-format' | 'bad-version' | 'build-mismatch' | 'truncated';

/** Validates a file for playback on this build (`build` = this build's hash; '' skips the build check). */
export function checkReplayFile(f: unknown, build: string): ReplayFileCheck {
  const r = f as Partial<ReplayFile> | null;
  if (!r || typeof r !== 'object' || r.format !== REPLAY_FILE_FORMAT) return 'bad-format';
  if (r.version !== REPLAY_FILE_VERSION) return 'bad-version';
  if (build !== '' && r.build !== build) return 'build-mismatch';
  if (r.truncated) return 'truncated';
  return 'ok';
}
