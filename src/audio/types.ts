/**
 * Public surface of the audio system (P8). main.ts imports only TYPES from
 * here; the implementation (src/audio/index.ts) is a lazily loaded chunk.
 */
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';
import type { TrafficAgentFrame } from '../protocol/traffic';
import type { ReplayController } from '../app/replay/types';

/** Volume settings (GameSettings fields, 0..1). */
export interface AudioSettingsLike {
  volume: number;
  engineVolume: number;
  effectsVolume: number;
  ambienceVolume: number;
  muted: boolean;
}

/** What the audio needs to know about the player vehicle (changes on a swap). */
export interface AudioPlayerInfo {
  /** Catalog id ('sedan', 'coupe', …): selects the engine profile. */
  id: string;
  /** DrivetrainDef numbers: idle / redline / limiter / torque curve / shift time. */
  drivetrain: { idleRpm: number; redlineRpm: number; revLimitRpm: number; torqueCurve: readonly (readonly [number, number])[]; shiftTimeS: number };
  /** Object-local hub node indices (hubI, hubO per wheel) and the largest wheel radius. */
  hubs: Int32Array;
  wheelRadius: number;
  /** Body length, m (exhaust / intake placement). */
  length: number;
}

/** The minimum of SimClient the audio reads (type-only; fakes in tests). */
export interface AudioSimSource {
  telemetry(objectId: number): Float32Array | null;
  readTrafficAgents(renderSimTime: number, out: TrafficAgentFrame[]): number;
  renderTime(): number;
  objectRanges(): readonly { objectId: number; nodeOffset: number; nodeCount: number }[];
}

export interface AudioDeps {
  sim: AudioSimSource;
  /** camera.matrixWorld.elements of the frame's final camera. */
  cameraMatrix(): ArrayLike<number>;
  replay: Pick<ReplayController, 'active' | 'playing' | 'speed' | 'direction' | 'phase' | 'on'>;
  playerObjectId: number;
  player(): AudioPlayerInfo | null;
  /** Interpolated node positions of this frame (SimClient.interpolate output). */
  nodes(): Float32Array;
  /** Player pose: frame origin + forward (null when not valid this frame). */
  playerForward(out: Float64Array): boolean;
  /** Ground material under (x, z) (MaterialId). */
  materialAt(x: number, z: number): number;
  /** Ambient zone weights at (x, z): arena / town / lake shore, 0..1 each, and terrain height. */
  zones(x: number, z: number, out: Float64Array): void;
  /** Prop key of a prop object id ('barrel', 'cone', …) or null. */
  propKey(objectId: number): string | null;
  settings(): Readonly<AudioSettingsLike>;
  /** Live sim timescale (0 paused … 1). */
  timeScale(): number;
  /** The live crash cam's instant replay is playing. */
  crashCam(): boolean;
  /** The player's damage FX hook (glass shatter / crack); the audio chains itself in. */
  playerDamage(): { onFx: ((fx: { type: string; pos: readonly number[] | ArrayLike<number> }) => void) | null } | null;
  /** HRTF on the player car's voices (quality ≥ medium). */
  hrtf(): boolean;
  /** Max awake traffic engine voices / ghost pass-by voices. */
  trafficVoices(): { awake: number; ghosts: number };
}

export interface AudioDebug {
  readonly state: string;
  readonly worklet: boolean;
  readonly sampleRate: number;
  readonly voices: { engine: number; traffic: number; ghosts: number; oneShots: number; oneShotCap: number };
  readonly oneShotsPlayed: number;
  readonly oneShotsDropped: number;
  readonly bankReady: boolean;
  /** Main-thread update cost, ms (EMA / max since start). */
  readonly updateMs: number;
  readonly updateMsMax: number;
  readonly frames: number;
  readonly errors: readonly string[];
  readonly lastCrash: { gain: number; kind: string; t: number } | null;
  readonly engine: { rpm: number; load: number; pitch: number; limiter: boolean; crank: boolean; profile: string };
  readonly world: { rate: number; pitch: number; lowpass: number; gain: number };
  /** Resume the context (tests; a user gesture does this in the game). */
  resume(): Promise<string>;
}

export interface AudioSystem {
  /** Once per rendered world frame (wall dt, s). */
  update(dt: number): void;
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  readonly debug: AudioDebug;
  dispose(): void;
}
