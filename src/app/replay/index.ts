/**
 * Live replay controller (P7, R1). CONTRACT: ./types.ts (R2 consumes the
 * ReplayController part); the ReplayDriver surface is main.ts's.
 *
 * Recording: SimClient hands every live snapshot to the ReplayBuffer
 * (decimated to the preset's recordHz). Playback: frames around the playhead
 * are decoded into snapshot buffers (a 3-slot cache) and PRESENTED through
 * SimClient (prev/cur + render clock), so every consumer renders them through
 * its normal path. Events: the frames the playhead passes moving forward are
 * decoded (event rings only) and captured for main's drain.
 *
 * Seek generations: every damage reset (settled seek, each reverse-play
 * frame) bumps `gen`; presented repair epochs carry `gen · EPOCH_STRIDE`, so
 * every damage visual resets and re-derives from the presented frame.
 */
import { SnapshotWriter } from '../../protocol/codec';
import { computeSnapshotLayout } from '../../protocol/layout';
import type { ReplayFile } from '../../protocol/replay';
import { VehicleTelemetry } from '../../protocol/telemetry';
import { createTrafficAgentFrame, isTrafficObjectId, TRAFFIC_ID_BASE, type TrafficAgentFrame } from '../../protocol/traffic';
import { isPropObjectId } from '../../protocol/messages';
import type { QualityLevel } from '../../render/types';
import type { SimClient } from '../simClient';
import { ReplayBuffer, type WheelHubs } from './buffer';
import {
  REPLAY_BUFFER_PRESETS,
  REPLAY_FX_PRIME_S,
  REPLAY_SPEEDS,
  type ReplayController,
  type ReplayDebugApi,
  type ReplayEnterOptions,
  type ReplayEvent,
  type ReplayMarker,
  type ReplayPhase,
  type ReplaySpeed,
  type ReplayStats,
  type ReplayTarget,
} from './types';

export * from './types';
export { ReplayBuffer } from './buffer';

/** Repair-epoch increment per seek generation (keeps generations apart from real repairs). */
const EPOCH_STRIDE = 0x100000;

/**
 * Main's visual pipeline during a settled seek (all optional; without them a
 * seek only presents frames). Order: present(start, no events) →
 * primeBegin(seed) → for every frame start..target: present(k, events) +
 * primeFrame(time) → present(target bracket) → primeEnd().
 */
export interface ReplayVisualHooks {
  /** Replay starts (freeze skidmarks, gate input, release keys). */
  enter?(): void;
  /** Replay ended; live view restored. */
  exit?(): void;
  /** A settle starts on the presented first prime frame: reset damage (update visuals once), clear transient FX with `seed`, drop queued events. */
  primeBegin?(seed: number): void;
  /** One prime frame is presented (its events captured): route events, run FX emitters to `time`. */
  primeFrame?(time: number): void;
  primeEnd?(): void;
}

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
  /** Tyre hubs per vehicle (marker tyre-contact exclusion), or null. */
  wheelsOf?(objectId: number): WheelHubs | null;
  visuals?: ReplayVisualHooks;
}

/** Main-side driver surface (main.ts only; R2 uses the ReplayController part). */
export interface ReplayDriver extends ReplayController {
  /** Once per render frame BEFORE SimClient.interpolate: advances the playhead and presents frames. */
  update(dtRealS: number): void;
  /** Quality preset changed: re-sizes the buffer (drops it) when its config differs. Deferred while replaying. */
  setQuality(level: QualityLevel): void;
  /** Late-bound hooks (main builds its renderers after the controller). */
  setVisuals(v: ReplayVisualHooks): void;
  readonly buffer: ReplayBuffer;
  readonly debug: ReplayDebugApi;
  dispose(): void;
}

function hash32(x: number): number {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createReplayController(deps: ReplayDeps): ReplayDriver {
  const client = deps.client;
  let level = deps.level;
  let pendingLevel: QualityLevel | null = null;
  let buf = new ReplayBuffer(REPLAY_BUFFER_PRESETS[level]);
  let visuals: ReplayVisualHooks = deps.visuals ?? {};
  const listeners = new Set<(e: ReplayEvent) => void>();
  const emit = (e: ReplayEvent): void => {
    for (const fn of listeners) fn(e);
  };

  const stats: ReplayStats = {
    frames: 0,
    keyframes: 0,
    bytes: 0,
    allocatedBytes: 0,
    budgetBytes: buf.config.budgetBytes,
    bytesPerFrame: 0,
    seconds: 0,
    recordHz: buf.config.recordHz,
    recordMs: 0,
    recordMsMax: 0,
    lastRecordMs: 0,
    decodeMs: 0,
    lastSeekMs: 0,
    lastSettleMs: 0,
    evicted: 0,
  };
  const refreshStats = (): void => {
    stats.frames = buf.count;
    stats.keyframes = buf.keyframes;
    stats.bytes = buf.bytes;
    stats.allocatedBytes = buf.allocatedBytes;
    stats.budgetBytes = buf.config.budgetBytes;
    stats.bytesPerFrame = buf.count > 0 ? buf.bytes / buf.count : 0;
    stats.seconds = buf.endTime - buf.startTime;
    stats.recordHz = buf.config.recordHz;
    stats.evicted = buf.evicted;
  };

  const bindBuffer = (): void => {
    buf.wheelsOf = deps.wheelsOf ?? null;
    buf.onMarker = (m) => emit({ type: 'marker', marker: m });
  };
  bindBuffer();

  // ---- recording (live)
  client.setSnapshotSink((r) => {
    if (phase !== 'live') return;
    const t0 = performance.now();
    if (buf.record(r)) {
      const ms = performance.now() - t0;
      stats.lastRecordMs = ms;
      stats.recordMs = stats.recordMs === 0 ? ms : stats.recordMs + 0.05 * (ms - stats.recordMs);
      if (ms > stats.recordMsMax) stats.recordMsMax = ms;
    }
  });

  // ---- playback state
  let phase: ReplayPhase = 'live';
  let time = 0;
  let speed: ReplaySpeed = 1;
  let direction: 1 | -1 = 1;
  let playing = false;
  let gen = 0;
  /** FX / damage match the playhead (settled seek or forward play since). */
  let consistent = false;
  let pauseHash: { tick: number; hash: number } | null = null;
  let resumeHash: { tick: number; hash: number } | null = null;

  // ---- decoded frame cache (3 slots) + an events scratch buffer
  let slotBufs: ArrayBuffer[] = [];
  let slotWriters: SnapshotWriter[] = [];
  const slotSeq = [-1, -1, -1];
  const slotGen = [-1, -1, -1];
  let slotUse = [0, 0, 0];
  let useClock = 0;
  let evBuf: ArrayBuffer | null = null;
  let evWriter: SnapshotWriter | null = null;
  let layoutKey = '';
  const ensureSlots = (): void => {
    const key = `${buf.maxObjects}|${buf.nodeCapacity}|${buf.beamCapacity}`;
    if (key === layoutKey) return;
    layoutKey = key;
    const layout = computeSnapshotLayout(buf.maxObjects, buf.nodeCapacity, buf.beamCapacity, false);
    slotBufs = [0, 1, 2].map(() => new ArrayBuffer(layout.totalBytes));
    slotWriters = slotBufs.map((b) => new SnapshotWriter(layout).attach(b));
    slotSeq.fill(-1);
    evBuf = new ArrayBuffer(layout.totalBytes);
    evWriter = new SnapshotWriter(layout).attach(evBuf);
  };
  /** Decoded buffer of held frame i (cached by sequence + generation), never the slot `keep`. */
  const frameBuffer = (i: number, keep: number): number => {
    const seq = buf.frameSeq(i);
    for (let s = 0; s < 3; s++) {
      if (slotSeq[s] === seq && slotGen[s] === gen) {
        slotUse[s] = ++useClock;
        return s;
      }
    }
    let victim = -1;
    for (let s = 0; s < 3; s++) {
      if (s === keep) continue;
      if (victim < 0 || slotUse[s]! < slotUse[victim]!) victim = s;
    }
    const t0 = performance.now();
    buf.decode(i, slotWriters[victim]!, gen * EPOCH_STRIDE, true);
    const ms = performance.now() - t0;
    stats.decodeMs = stats.decodeMs === 0 ? ms : stats.decodeMs + 0.05 * (ms - stats.decodeMs);
    slotSeq[victim] = seq;
    slotGen[victim] = gen;
    slotUse[victim] = ++useClock;
    return victim;
  };
  /** Presents the pair around t (cur = the first frame at or after t, prev the one before). */
  const presentAt = (t: number, events: boolean): void => {
    const n = buf.count;
    let i1 = buf.findFrame(t);
    if (buf.frameTime(i1) < t && i1 < n - 1) i1++;
    if (i1 < 1) i1 = 1;
    const sCur = frameBuffer(i1, -1);
    const sPrev = frameBuffer(i1 - 1, sCur);
    client.presentReplay(slotBufs[sPrev]!, slotBufs[sCur]!, t, events);
  };
  /** Presents held frame i alone at its own time (prime frames). */
  const presentFrame = (i: number, events: boolean): void => {
    const s = frameBuffer(i, -1);
    const p = i > 0 ? frameBuffer(i - 1, s) : -1;
    client.presentReplay(p >= 0 ? slotBufs[p]! : null, slotBufs[s]!, buf.frameTime(i), events);
  };
  /** Captures the events of every held frame with time in (t0, t1]. */
  const passEvents = (t0: number, t1: number): void => {
    if (!(t1 > t0) || !evWriter || !evBuf) return;
    let i = buf.findFrame(t0);
    if (buf.frameTime(i) <= t0) i++;
    for (; i < buf.count && buf.frameTime(i) <= t1; i++) {
      buf.decodeEvents(i, evWriter);
      client.pushReplayEvents(evBuf);
    }
  };

  const clampTime = (t: number): number => (t < buf.startTime ? buf.startTime : t > buf.endTime ? buf.endTime : t);

  /** Damage reset + deterministic FX re-run up to t (see ReplayVisualHooks). */
  const settle = (t: number): void => {
    const t0 = performance.now();
    gen++;
    const target = buf.findFrame(t);
    const start = buf.findFrame(t - REPLAY_FX_PRIME_S);
    presentFrame(start, false);
    client.discardEvents();
    visuals.primeBegin?.(hash32(buf.frameSeq(start)));
    for (let k = start; k <= target; k++) {
      presentFrame(k, true);
      visuals.primeFrame?.(buf.frameTime(k));
    }
    // events of the bracket's frames up to t are already delivered: present without events
    presentAt(t, false);
    visuals.primeEnd?.();
    consistent = true;
    stats.lastSettleMs = performance.now() - t0;
  };

  const seekTo = (t: number, settled: boolean): void => {
    if (phase !== 'replay') return;
    const t0 = performance.now();
    time = clampTime(t);
    if (settled) settle(time);
    else {
      presentAt(time, false);
      consistent = false;
    }
    stats.lastSeekMs = performance.now() - t0;
    emit({ type: 'seek', time, settled });
  };

  const applyLevel = (l: QualityLevel): void => {
    const cfg = REPLAY_BUFFER_PRESETS[l];
    level = l;
    const c = buf.config;
    if (c.seconds === cfg.seconds && c.recordHz === cfg.recordHz && c.budgetBytes === cfg.budgetBytes && c.keyframeEvery === cfg.keyframeEvery) return;
    buf = new ReplayBuffer(cfg);
    bindBuffer();
    layoutKey = '';
    refreshStats();
  };

  // ---- targets
  const scratch3 = [0, 0, 0];
  const scratch3b = [0, 0, 0];
  const bounds = [0, 0, 0, 0];
  const agents: TrafficAgentFrame[] = [createTrafficAgentFrame()];
  const tel = (id: number, out: ReplayTarget): void => {
    const t = client.telemetry(id);
    if (t) {
      out.velocity[0] = t[VehicleTelemetry.velX]!;
      out.velocity[1] = t[VehicleTelemetry.velY]!;
      out.velocity[2] = t[VehicleTelemetry.velZ]!;
    } else out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
  };
  const presentedTime = (): number => client.renderTime();
  const quatAxes = (q: readonly number[], out: ReplayTarget): void => {
    const [x, y, z, w] = q as [number, number, number, number];
    // forward = q · (0, 0, −1), up = q · (0, 1, 0)
    out.forward[0] = -(2 * (x * z + w * y));
    out.forward[1] = -(2 * (y * z - w * x));
    out.forward[2] = -(1 - 2 * (x * x + y * y));
    out.up[0] = 2 * (x * y - w * z);
    out.up[1] = 1 - 2 * (x * x + z * z);
    out.up[2] = 2 * (y * z + w * x);
  };
  const norm = (v: number[]): void => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (l > 1e-9) {
      v[0]! /= l;
      v[1]! /= l;
      v[2]! /= l;
    }
  };
  const target = (objectId: number, out: ReplayTarget): boolean => {
    out.objectId = objectId;
    out.valid = false;
    const t = presentedTime();
    const info = client.vehicleInfo(objectId);
    if (!client.objectBounds(objectId, bounds)) {
      // a ghost traffic agent has no nodes: its record pose
      if (isTrafficObjectId(objectId)) return trafficTarget(objectId - TRAFFIC_ID_BASE, out, t);
      return false;
    }
    out.radius = bounds[3]!;
    if (info) {
      out.kind = objectId === deps.playerObjectId ? 'player' : 'object';
      const f = info.frameNodes;
      if (!client.objectNode(objectId, f[0]!, t, out.position)) return false;
      client.objectNode(objectId, f[1]!, t, scratch3);
      client.objectNode(objectId, f[2]!, t, scratch3b);
      for (let k = 0; k < 3; k++) {
        out.forward[k] = scratch3[k]! - out.position[k]!;
        out.up[k] = scratch3b[k]! - out.position[k]!;
      }
      norm(out.forward);
      norm(out.up);
      tel(objectId, out);
      out.valid = true;
      return true;
    }
    if (isTrafficObjectId(objectId) && trafficTarget(objectId - TRAFFIC_ID_BASE, out, t)) {
      out.radius = bounds[3]!;
      return true;
    }
    out.kind = isPropObjectId(objectId) ? 'prop' : 'object';
    out.position[0] = bounds[0]!;
    out.position[1] = bounds[1]!;
    out.position[2] = bounds[2]!;
    out.forward[0] = 0;
    out.forward[1] = 0;
    out.forward[2] = -1;
    out.up[0] = 0;
    out.up[1] = 1;
    out.up[2] = 0;
    out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
    out.valid = true;
    return true;
  };
  const trafficTarget = (agent: number, out: ReplayTarget, t: number): boolean => {
    const n = client.readTrafficAgents(t, agents);
    for (let i = 0; i < n; i++) {
      const a = agents[i]!;
      if (a.agent !== agent) continue;
      out.kind = 'traffic';
      out.objectId = TRAFFIC_ID_BASE + agent;
      out.position[0] = a.pos[0];
      out.position[1] = a.pos[1];
      out.position[2] = a.pos[2];
      quatAxes(a.quat, out);
      out.velocity[0] = out.forward[0] * a.speed;
      out.velocity[1] = out.forward[1] * a.speed;
      out.velocity[2] = out.forward[2] * a.speed;
      if (a.objectId !== 0) tel(a.objectId, out);
      if (!(out.radius > 0)) out.radius = 2.4;
      out.valid = true;
      return true;
    }
    return false;
  };

  const ctl: ReplayDriver = {
    get phase() {
      return phase;
    },
    get active() {
      return phase === 'replay';
    },
    get start() {
      return buf.startTime;
    },
    get end() {
      return buf.endTime;
    },
    get duration() {
      return buf.endTime - buf.startTime;
    },
    get time() {
      return phase === 'replay' ? time : buf.endTime;
    },
    get speed() {
      return speed;
    },
    get direction() {
      return direction;
    },
    get playing() {
      return playing;
    },
    get frameDuration() {
      return 1 / buf.config.recordHz;
    },
    playerObjectId: deps.playerObjectId,
    get buffer() {
      return buf;
    },

    async enter(opts?: ReplayEnterOptions): Promise<boolean> {
      if (phase !== 'live' || client.fatal) return false;
      phase = 'entering';
      try {
        const p = await client.pauseSim(true);
        pauseHash = { tick: p.tick, hash: p.hash };
        // the buffer ends exactly at the live view
        const live = client.liveReader;
        if (live) buf.recordNow(live);
        if (buf.count < 2) {
          await client.pauseSim(false);
          phase = 'live';
          return false;
        }
        ensureSlots();
        client.beginReplay();
        phase = 'replay';
        visuals.enter?.();
        speed = opts?.speed ?? speed;
        direction = opts?.direction ?? 1;
        playing = false;
        refreshStats();
        emit({ type: 'enter' });
        seekTo(opts?.time ?? buf.endTime, true);
        if (opts?.play) ctl.play();
        return true;
      } catch (e) {
        console.error('[replay] enter failed', e);
        phase = 'live';
        return false;
      }
    },

    async exit(): Promise<void> {
      if (phase !== 'replay') return;
      playing = false;
      seekTo(buf.endTime, true);
      phase = 'exiting';
      client.endReplay(gen * EPOCH_STRIDE);
      visuals.exit?.();
      try {
        const r = await client.pauseSim(false);
        resumeHash = { tick: r.tick, hash: r.hash };
      } catch (e) {
        console.error('[replay] resume failed', e);
      }
      phase = 'live';
      if (pendingLevel) {
        applyLevel(pendingLevel);
        pendingLevel = null;
      }
      emit({ type: 'exit' });
    },

    play(): void {
      if (phase !== 'replay' || playing) return;
      // at an end in the playing direction: restart from the other end
      if (direction > 0 && time >= buf.endTime) seekTo(buf.startTime, true);
      else if (direction < 0 && time <= buf.startTime) seekTo(buf.endTime, true);
      else if (direction > 0 && !consistent) settle(time);
      playing = true;
      emit({ type: 'play' });
    },
    pause(): void {
      if (!playing) return;
      playing = false;
      if (!consistent && phase === 'replay') settle(time);
      emit({ type: 'pause' });
    },
    togglePlay(): void {
      if (playing) ctl.pause();
      else ctl.play();
    },
    setSpeed(s: number): void {
      let best: ReplaySpeed = REPLAY_SPEEDS[0];
      for (const v of REPLAY_SPEEDS) if (Math.abs(Math.log(v / s)) < Math.abs(Math.log(best / s))) best = v;
      if (!(s > 0)) best = speed;
      speed = best;
      emit({ type: 'speed', speed, direction });
    },
    setDirection(d: 1 | -1): void {
      const nd: 1 | -1 = d < 0 ? -1 : 1;
      if (nd === direction) return;
      direction = nd;
      if (nd > 0 && playing && !consistent) settle(time);
      emit({ type: 'speed', speed, direction });
    },
    seek(t: number, opts?: { settle?: boolean }): void {
      seekTo(t, opts?.settle ?? true);
    },
    step(frames: number): void {
      if (phase !== 'replay' || frames === 0) return;
      if (playing) {
        playing = false;
        emit({ type: 'pause' });
      }
      const cur = buf.findFrame(time + 1e-9);
      const i = Math.max(0, Math.min(buf.count - 1, cur + Math.trunc(frames)));
      const t = buf.frameTime(i);
      if (frames > 0 && consistent) {
        // forward from a consistent state: play the frames (events, FX continue)
        passEvents(time, t);
        time = t;
        presentAt(time, false);
        emit({ type: 'seek', time, settled: true });
      } else seekTo(t, true);
    },
    markers(): readonly ReplayMarker[] {
      return buf.markers();
    },
    target,
    targets(out: ReplayTarget[]): number {
      let n = 0;
      const get = (): ReplayTarget => {
        if (out.length <= n) out.push({ objectId: 0, kind: 'object', valid: false, position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], velocity: [0, 0, 0], radius: 0 });
        return out[n]!;
      };
      if (target(deps.playerObjectId, get())) n++;
      const t = presentedTime();
      const m = client.readTrafficAgents(t, agents);
      for (let i = 0; i < m; i++) {
        const o = get();
        o.radius = 0;
        // (target() re-reads `agents` at the same time: identical contents)
        if (target(TRAFFIC_ID_BASE + agents[i]!.agent, o)) n++;
      }
      return n;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stats,

    update(dt: number): void {
      if (phase !== 'replay') {
        if ((stats.frames & 15) === 0 || stats.frames !== buf.count) refreshStats();
        return;
      }
      if (!playing || !(dt > 0)) return;
      const t0 = time;
      let t1 = t0 + direction * speed * dt;
      let ended: 'start' | 'end' | null = null;
      if (t1 >= buf.endTime) {
        t1 = buf.endTime;
        ended = 'end';
      } else if (t1 <= buf.startTime) {
        t1 = buf.startTime;
        ended = 'start';
      }
      time = t1;
      if (direction > 0) {
        passEvents(t0, t1);
        presentAt(t1, false);
      } else {
        // reverse: damage re-derives every frame (no ratchet backwards), FX are not re-run
        gen++;
        consistent = false;
        presentAt(t1, false);
      }
      if (ended) {
        playing = false;
        if (!consistent) settle(time);
        emit({ type: 'end', at: ended });
        emit({ type: 'pause' });
      }
    },
    setQuality(l: QualityLevel): void {
      if (l === level) return;
      if (phase !== 'live') pendingLevel = l;
      else applyLevel(l);
    },
    setVisuals(v: ReplayVisualHooks): void {
      visuals = v;
    },
    dispose(): void {
      client.setSnapshotSink(null);
      listeners.clear();
    },
    debug: null as unknown as ReplayDebugApi,
  };

  const debug: ReplayDebugApi = {
    controller: ctl,
    get state() {
      return {
        phase,
        time: ctl.time,
        start: ctl.start,
        end: ctl.end,
        duration: ctl.duration,
        speed,
        direction,
        playing,
        frames: buf.count,
        markers: buf.markers().length,
      };
    },
    enter: (o) => ctl.enter(o),
    exit: () => ctl.exit(),
    seek: (t, settle) => ctl.seek(t, { settle: settle ?? true }),
    play: () => ctl.play(),
    pause: () => ctl.pause(),
    setSpeed: (s) => ctl.setSpeed(s),
    setDirection: (d) => ctl.setDirection(d),
    step: (n) => ctl.step(n),
    markers: () => buf.markers().map((m) => ({ ...m, pos: [m.pos[0], m.pos[1], m.pos[2]] as const })),
    get stats() {
      refreshStats();
      return { ...stats };
    },
    stateHash: () => client.stateHash(),
    get pauseHash() {
      return pauseHash;
    },
    get resumeHash() {
      return resumeHash;
    },
    async exportFile(): Promise<ReplayFile> {
      const f = await client.requestReplayFile();
      f.build = deps.build;
      for (const v of f.vehicles) v.paint = deps.paintOf ? deps.paintOf(v.objectId) : null;
      return f;
    },
  };
  (ctl as { debug: ReplayDebugApi }).debug = debug;
  return ctl;
}
