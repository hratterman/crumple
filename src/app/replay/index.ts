/**
 * Live replay controller (P7, R1). CONTRACT: ./types.ts.
 *
 * STUB (contracts commit): the frozen factory signature with an inert
 * controller (empty buffer, `enter` resolves false), already wired into
 * main.ts as `replay` + `window.__crumple.replay`. R1 replaces the body.
 */
import type { SimClient } from '../simClient';
import type { QualityLevel } from '../../render/types';
import type { ReplayFile } from '../../protocol/replay';
import {
  REPLAY_BUFFER_PRESETS,
  REPLAY_SPEEDS,
  type ReplayController,
  type ReplayDebugApi,
  type ReplayEvent,
  type ReplayMarker,
  type ReplaySpeed,
  type ReplayStats,
  type ReplayTarget,
} from './types';

export * from './types';

/** What main gives the controller. */
export interface ReplayDeps {
  client: SimClient;
  /** objectId of the player vehicle (1). */
  playerObjectId: number;
  /** Initial quality level (buffer preset). */
  level: QualityLevel;
  /** Build hash stamped into exported ReplayFiles. */
  build: string;
  /** Palette id per vehicle objectId (stamped into exported files), or null. */
  paintOf?(objectId: number): string | null;
}

/** Main-side driver surface (main.ts only; R2 uses the ReplayController part). */
export interface ReplayDriver extends ReplayController {
  /** Once per render frame BEFORE SimClient.interpolate: advances the playhead and presents frames. */
  update(dtRealS: number): void;
  /** Quality preset changed: re-sizes the buffer (drops it). */
  setQuality(level: QualityLevel): void;
  readonly debug: ReplayDebugApi;
  dispose(): void;
}

export function createReplayController(deps: ReplayDeps): ReplayDriver {
  const cfg = REPLAY_BUFFER_PRESETS[deps.level];
  const listeners = new Set<(e: ReplayEvent) => void>();
  const stats: ReplayStats = {
    frames: 0,
    keyframes: 0,
    bytes: 0,
    allocatedBytes: 0,
    budgetBytes: cfg.budgetBytes,
    bytesPerFrame: 0,
    seconds: 0,
    recordHz: cfg.recordHz,
    recordMs: 0,
    recordMsMax: 0,
    lastRecordMs: 0,
    decodeMs: 0,
    lastSeekMs: 0,
    lastSettleMs: 0,
    evicted: 0,
  };
  const markers: ReplayMarker[] = [];
  const ctl: ReplayDriver = {
    phase: 'live',
    active: false,
    get start() {
      return deps.client.simTime;
    },
    get end() {
      return deps.client.simTime;
    },
    duration: 0,
    get time() {
      return deps.client.simTime;
    },
    speed: 1 as ReplaySpeed,
    direction: 1,
    playing: false,
    frameDuration: 1 / cfg.recordHz,
    playerObjectId: deps.playerObjectId,
    enter: async () => false,
    exit: async () => {},
    play() {},
    pause() {},
    togglePlay() {},
    setSpeed(s: number) {
      void REPLAY_SPEEDS.indexOf(s as ReplaySpeed);
    },
    setDirection() {},
    seek() {},
    step() {},
    markers: () => markers,
    target: (_id: number, out: ReplayTarget) => {
      out.valid = false;
      return false;
    },
    targets: () => 0,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stats,
    update() {},
    setQuality() {},
    dispose() {
      listeners.clear();
    },
    debug: null as unknown as ReplayDebugApi,
  };
  const debug: ReplayDebugApi = {
    controller: ctl,
    get state() {
      return { phase: ctl.phase, time: ctl.time, start: ctl.start, end: ctl.end, duration: ctl.duration, speed: ctl.speed, direction: ctl.direction, playing: ctl.playing, frames: stats.frames, markers: markers.length };
    },
    enter: (o) => ctl.enter(o),
    exit: () => ctl.exit(),
    seek: (t, settle) => ctl.seek(t, { settle: settle ?? true }),
    play: () => ctl.play(),
    pause: () => ctl.pause(),
    setSpeed: (s) => ctl.setSpeed(s),
    setDirection: (d) => ctl.setDirection(d),
    step: (n) => ctl.step(n),
    markers: () => markers.slice(),
    stats,
    stateHash: () => Promise.reject(new Error('replay: not implemented yet')),
    pauseHash: null,
    resumeHash: null,
    exportFile: (): Promise<ReplayFile> => Promise.reject(new Error('replay: not implemented yet')),
  };
  (ctl as { debug: ReplayDebugApi }).debug = debug;
  return ctl;
}
