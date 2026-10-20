/**
 * Live replay — the R2-facing API (P7 contract; docs/CONTRACTS.md "P7
 * contracts"). Change only via that doc. Main thread only; no three here.
 *
 * WHAT IT IS. A rolling buffer (last 20–60 s by quality preset) of every
 * snapshot the renderer consumed, recorded on MAIN as snapshots arrive
 * (decimated to `recordHz`): per object quantized node positions (16 bit
 * per axis in the object's per-frame bbox), telemetry, broken-beam bits,
 * repair epoch and flags; the traffic records; the impact / beamBreak /
 * skid rings. Playback decodes recorded frames back into snapshot buffers
 * and PRESENTS them through SimClient, so every consumer (flexbody skin,
 * damage, wheels, traffic ghosts / hand-over, props, FX, HUD telemetry,
 * cameras) renders replay frames through its normal code path.
 *
 * LIFECYCLE. `enter()` pauses the worker (`replayPause`; the sim state is
 * frozen, never rewound) and parks the playhead at `end`, paused. `exit()`
 * seeks to `end`, hands SimClient back its live buffers and resumes the
 * worker: the run continues exactly where it stopped (same state hash).
 * While active, main sends NO commands to the worker (input is gated).
 *
 * TIME. All times are SIM seconds (snapshot simTime). The playhead moves at
 * `direction × speed` sim-seconds per real second while `playing`, and
 * pauses itself at either end. Node positions, ghost poses and telemetry
 * are interpolated between the two recorded frames around the playhead
 * (smooth 1/8× slow-mo). Events are delivered when the playhead passes
 * their frame moving FORWARD (FX spawn exactly as live); moving backward
 * delivers none.
 *
 * SEEK + FX. A settled seek (default) resets the visual damage of every
 * object (it re-derives from the frame: broken bits → detach / glass
 * shatter, geometry → crumple shading) and re-runs the FX emitters over the
 * recorded frames of the last REPLAY_FX_PRIME_S before the target with a
 * seed fixed by the start frame, so particles / debris at the target are
 * deterministic (same target → same picture). Skidmarks are not re-laid:
 * the live marks are shown filtered by birth ≤ playhead. `seek(t, {settle:
 * false})` is the cheap preview for timeline drags (nodes only; call a
 * settled seek on release).
 */

import type { QualityLevel } from '../../render/types';

// ============================================================ configuration
/** Playback speed magnitudes (`setSpeed` snaps to the nearest). Direction is separate (`setDirection`). */
export const REPLAY_SPEEDS = [0.125, 0.25, 0.5, 1, 2] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * Buffer sizing per quality preset. `seconds` is the retained duration
 * (older frames are evicted); `budgetBytes` is the hard memory cap (the
 * slab grows in REPLAY_CHUNK_BYTES chunks up to it, then the ring wraps:
 * zero steady-state allocation); `recordHz` the decimated record rate
 * (snapshots arrive at 120 Hz). `keyframeEvery`: every n-th frame stores
 * every object in full (sleeping objects are otherwise stored once and
 * referenced), bounding seek cost and eviction groups.
 */
export interface ReplayBufferConfig {
  seconds: number;
  recordHz: number;
  budgetBytes: number;
  keyframeEvery: number;
}
const MiB = 1024 * 1024;
export const REPLAY_BUFFER_PRESETS: Readonly<Record<QualityLevel, Readonly<ReplayBufferConfig>>> = {
  low: { seconds: 20, recordHz: 30, budgetBytes: 24 * MiB, keyframeEvery: 15 },
  medium: { seconds: 30, recordHz: 60, budgetBytes: 48 * MiB, keyframeEvery: 30 },
  high: { seconds: 30, recordHz: 60, budgetBytes: 64 * MiB, keyframeEvery: 30 },
  ultra: { seconds: 60, recordHz: 60, budgetBytes: 128 * MiB, keyframeEvery: 30 },
};
export const REPLAY_CHUNK_BYTES = 4 * MiB;
/** FX re-run window before a settled seek target, sim s (particles older than this are not reconstructed). */
export const REPLAY_FX_PRIME_S = 6;

// ============================================================ markers + targets
/**
 * A crash / impact moment detected while recording (live and in replay):
 * the timeline ticks and the crash-cam director consume them. One marker per
 * burst: frames within REPLAY_MARKER_MERGE_S of the previous marker merge
 * into it (the marker keeps the PEAK frame's time and position).
 * severity 0..1 = max(Σ impulse on the object / 4000 N·s, broken beams / 60,
 * Δ telemetry damage / 0.08), clamped; a frame becomes a marker at
 * severity ≥ REPLAY_MARKER_MIN_SEVERITY. Tyre contacts (impacts within the
 * wheel radius of a vehicle's hubs) never count.
 */
export interface ReplayMarker {
  /** Monotonic id (stable across buffer eviction). */
  readonly id: number;
  /** Sim time of the peak frame, s. */
  readonly time: number;
  readonly tick: number;
  /** The object that took the hardest hit. */
  readonly objectId: number;
  readonly kind: 'impact' | 'break';
  readonly severity: number;
  /** Σ impulse on `objectId` over the burst, N·s. */
  readonly impulse: number;
  /** Beams broken over the burst (all objects). */
  readonly breaks: number;
  /** Impulse-weighted contact position of the peak frame, world m. */
  readonly pos: readonly [number, number, number];
}
export const REPLAY_MARKER_MERGE_S = 0.6;
export const REPLAY_MARKER_MIN_SEVERITY = 0.12;

export type ReplayTargetKind = 'player' | 'traffic' | 'prop' | 'object';

/**
 * A camera subject at the CURRENT presented time (replay playhead, or the
 * live render time when not replaying). Vehicles: position = frame-origin
 * node (player / spawnVehicle objects) or the traffic record's pose
 * (traffic), forward/up from the frame nodes / pose; props / plain rigs:
 * node centroid, forward −Z, up +Y. velocity from telemetry COM velocity
 * (vehicles) or the two presented frames. radius = bounding sphere of the
 * nodes (m).
 */
export interface ReplayTarget {
  objectId: number;
  kind: ReplayTargetKind;
  valid: boolean;
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  velocity: [number, number, number];
  radius: number;
}
export function createReplayTarget(): ReplayTarget {
  return { objectId: 0, kind: 'object', valid: false, position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], velocity: [0, 0, 0], radius: 0 };
}

// ============================================================ state + events
export type ReplayPhase = 'live' | 'entering' | 'replay' | 'exiting';

export interface ReplayStats {
  /** Frames / keyframes held. */
  frames: number;
  keyframes: number;
  /** Bytes used by held frames / allocated slab bytes / budget. */
  bytes: number;
  allocatedBytes: number;
  budgetBytes: number;
  /** Mean bytes per frame over the held frames. */
  bytesPerFrame: number;
  /** Duration held, s. */
  seconds: number;
  recordHz: number;
  /** Record cost per recorded frame (EMA / max since boot / last), ms. */
  recordMs: number;
  recordMsMax: number;
  lastRecordMs: number;
  /** Decode cost per decoded frame (EMA), ms. */
  decodeMs: number;
  /** Last seek: decode + present (ms) and the settle (damage reset + FX prime) on top (ms). */
  lastSeekMs: number;
  lastSettleMs: number;
  /** Frames evicted since boot. */
  evicted: number;
}

export type ReplayEvent =
  | { type: 'enter' }
  | { type: 'exit' }
  | { type: 'seek'; time: number; settled: boolean }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: ReplaySpeed; direction: 1 | -1 }
  /** The playhead reached an end of the buffer while playing (it pauses there). */
  | { type: 'end'; at: 'start' | 'end' }
  /** A new marker was detected (live recording) or an existing one grew. */
  | { type: 'marker'; marker: ReplayMarker };

// ============================================================ the controller
export interface ReplayEnterOptions {
  /** Initial playhead (default: end). */
  time?: number;
  /** Start playing at once (default false: paused at the playhead). */
  play?: boolean;
  speed?: ReplaySpeed;
  direction?: 1 | -1;
}

export interface ReplayController {
  readonly phase: ReplayPhase;
  /** phase === 'replay' (frames are presented from the buffer). */
  readonly active: boolean;
  /** Oldest / newest recorded frame time, s (valid live too: the timeline exists before entering). */
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  /** Playhead (replay) / newest frame time (live), s. */
  readonly time: number;
  readonly speed: ReplaySpeed;
  readonly direction: 1 | -1;
  readonly playing: boolean;
  /** 1 / recordHz: one `step(1)`. */
  readonly frameDuration: number;
  /** The player vehicle's objectId (1). */
  readonly playerObjectId: number;

  /** Pause the sim and start presenting the buffer. Resolves false when there is nothing to replay (< 2 frames) or not live. */
  enter(opts?: ReplayEnterOptions): Promise<boolean>;
  /** Seek to end, restore the live view, resume the sim. */
  exit(): Promise<void>;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Snaps to the nearest REPLAY_SPEEDS entry. */
  setSpeed(speed: number): void;
  setDirection(direction: 1 | -1): void;
  /** Clamped to [start, end]. settle (default true): see SEEK + FX above. */
  seek(time: number, opts?: { settle?: boolean }): void;
  /** Pause and move the playhead by n recorded frames (snapped to frame times; settled). */
  step(frames: number): void;
  /** Markers inside the buffer, oldest first (the array is reused: copy to keep). */
  markers(): readonly ReplayMarker[];
  /** Camera subject `objectId` at the presented time; false (out untouched except valid) when absent. */
  target(objectId: number, out: ReplayTarget): boolean;
  /** Every vehicle target (player first, then traffic by agent) into `out` (grown as needed); returns the count. */
  targets(out: ReplayTarget[]): number;
  on(listener: (e: ReplayEvent) => void): () => void;
  readonly stats: ReplayStats;
}

/** `window.__crumple.replay` (e2e / console). */
export interface ReplayDebugApi {
  readonly controller: ReplayController;
  readonly state: {
    phase: ReplayPhase;
    time: number;
    start: number;
    end: number;
    duration: number;
    speed: number;
    direction: number;
    playing: boolean;
    frames: number;
    markers: number;
  };
  enter(opts?: ReplayEnterOptions): Promise<boolean>;
  exit(): Promise<void>;
  seek(time: number, settle?: boolean): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  setDirection(direction: 1 | -1): void;
  step(frames: number): void;
  markers(): ReplayMarker[];
  readonly stats: ReplayStats;
  /** hashSimState() of the worker now. */
  stateHash(): Promise<{ tick: number; hash: number }>;
  /** The worker's answers to the pause on enter / the resume on exit (null before the first). */
  readonly pauseHash: { tick: number; hash: number } | null;
  readonly resumeHash: { tick: number; hash: number } | null;
  /** The run's ReplayFile (build + paint stamped). */
  exportFile(): Promise<import('../../protocol/replay').ReplayFile>;
}
