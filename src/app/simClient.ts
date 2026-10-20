/**
 * Main-thread client for the physics worker. No three imports: render code
 * consumes this through plain typed arrays.
 *
 * Buffer ownership (docs/CONTRACTS.md): main holds at most two snapshot
 * buffers (previous + current, for interpolation) and returns the older one
 * via `returnBuffer` the moment a newer snapshot arrives.
 *
 * Views returned by `strains()` and the ranges from `objectRanges()` are valid
 * until the next snapshot message is processed, i.e. for the rest of the
 * current task/frame. Do not hold them across frames.
 */
import type { Quat, Vec3 } from '../core/math';
import {
  createBeamBreakEvent,
  createImpactEvent,
  createSkidEvent,
  type BeamBreakEvent,
  type ImpactEvent,
  type SkidEvent,
} from '../protocol/events';
import {
  DEFAULT_SNAPSHOT_HZ,
  type ActionState,
  type MainToWorker,
  type MaterialId,
  type PropSpawn,
  type SnapshotCapacity,
  type SetTrafficMsg,
  type TerrainReadyMsg,
  type TrafficReadyMsg,
  type Transform,
  type WorkerToMain,
} from '../protocol/messages';
import { createTrafficAgentFrame, TRAFFIC_FLAG_AWAKE, TRAFFIC_FLAG_TELEPORTED, type TrafficAgentFrame, type TrafficDensity } from '../protocol/traffic';
import { NODE_STRIDE } from '../protocol/layout';
import { SnapshotReader } from '../protocol/codec';
import { readVehicleTelemetry, type VehicleTelemetryFrame } from '../protocol/telemetry';
import { compileRig } from '../sim/rig/builder';
import type { RigDef } from '../sim/rig/types';
import { buildVehicleRig } from '../sim/vehicle/builder';
import type { TransmissionMode, VehicleDef } from '../sim/vehicle/types';
import type { ColliderDef, WorldLayout } from '../world/types';
import type { ReplayFile } from '../protocol/replay';

export interface SimClientOptions {
  seed: number;
  gravity?: Vec3;
  snapshotHz?: number;
  debugStrains?: boolean;
  capacity?: SnapshotCapacity;
  /** Called once when the worker reports `fatal` or fails to load. */
  onFatal?: (message: string) => void;
}

/** One object's slice of the global node/strain arrays in the latest snapshot. */
export interface ObjectRange {
  objectId: number;
  flags: number;
  /** Element offsets (nodes / beams), not bytes. */
  nodeOffset: number;
  nodeCount: number;
  beamOffset: number;
  beamCount: number;
}

/** Main-side static facts about a spawned vehicle (object-local indices, canonical merged order). */
export interface VehicleInfo {
  /** Object-local node indices [origin, front, top] of VehicleDef.frame. */
  frameNodes: Int32Array;
  bodyNodeCount: number;
  nodeCount: number;
  beamCount: number;
}

export interface SimEventSink {
  impact?(e: Readonly<ImpactEvent>): void;
  beamBreak?(e: Readonly<BeamBreakEvent>): void;
  skid?(e: Readonly<SkidEvent>): void;
}

export interface SimClientStats {
  /** Measured snapshot arrival rate (Hz), refreshed about twice a second. */
  snapshotHz: number;
  /** Wall-clock ms since the latest snapshot arrived (Infinity before the first). */
  readonly snapshotAgeMs: number;
  snapshotsReceived: number;
  /** Main-side event queue drops (events not drained fast enough). */
  eventsDropped: number;
}

/** The worker's answer to `groundHeightfield` (TerrainReadyMsg without `type`). */
export type TerrainReadyInfo = Omit<TerrainReadyMsg, 'type'>;
/** The worker's answer to `setTraffic` (P6; TrafficReadyMsg without `type`). */
export type TrafficReadyInfo = Omit<TrafficReadyMsg, 'type'>;
/** `setTraffic` fields (P6). */
export type TrafficConfig = Omit<SetTrafficMsg, 'type'>;

interface PendingTerrain {
  hash: number;
  resolve(info: TerrainReadyInfo): void;
  reject(err: Error): void;
}

/** Main-side pending-event cap per kind; beyond it events are dropped and counted. */
const EVENT_QUEUE_CAP = 4096;

class EventQueue<T> {
  private readonly pool: T[] = [];
  count = 0;
  constructor(private readonly make: () => T) {}
  /** Next writable record, or null when full. */
  next(): T | null {
    if (this.count >= EVENT_QUEUE_CAP) return null;
    let rec = this.pool[this.count];
    if (!rec) {
      rec = this.make();
      this.pool.push(rec);
    }
    this.count++;
    return rec;
  }
  at(i: number): T {
    return this.pool[i]!;
  }
}

export class SimClient {
  private readonly worker: Worker;
  private readonly debugStrains: boolean;
  private readonly onFatal: ((message: string) => void) | undefined;

  private prev: SnapshotReader | null = null;
  private cur: SnapshotReader | null = null;
  private prevBuffer: ArrayBuffer | null = null;
  private curBuffer: ArrayBuffer | null = null;
  private spare: SnapshotReader = new SnapshotReader();

  private readonly ranges: ObjectRange[] = [];
  private rangeCount = 0;
  private readonly rangeView: ObjectRange[] = [];

  /** objectId → interleaved [a0, b0, a1, b1, …] object-local node indices. */
  private readonly pairs = new Map<number, Uint32Array>();
  private readonly vehicles = new Map<number, VehicleInfo>();

  private readonly impacts = new EventQueue(createImpactEvent);
  private readonly breaks = new EventQueue(createBeamBreakEvent);
  private readonly skids = new EventQueue(createSkidEvent);

  private lastArrivalMs = -1;
  private arrivalIntervalMs: number;
  private rateWindowStart = -1;
  private rateWindowCount = 0;

  private readonly pendingTerrain: PendingTerrain[] = [];
  /** `error` replies still due for terrainReady{matched:false} already resolved (hash mismatch). */
  private mismatchErrorsDue = 0;
  private _terrain: TerrainReadyInfo | null = null;
  private readonly pendingTraffic: { resolve(info: TrafficReadyInfo): void; reject(err: Error): void }[] = [];
  private _traffic: TrafficReadyInfo | null = null;
  private readonly trafficPrev = createTrafficAgentFrame();

  private _ready = false;
  private _fatal: string | null = null;
  private disposed = false;

  // ---- P7 replay seam (app/replay): recorder sink, presentation of recorded frames, worker requests
  private snapshotSink: ((r: SnapshotReader) => void) | null = null;
  /** P8: additional live-snapshot listeners (addSnapshotListener). */
  private readonly snapshotListeners: ((r: SnapshotReader) => void)[] = [];
  private replaying = false;
  private replayTime = 0;
  private livePrev: SnapshotReader | null = null;
  private liveCur: SnapshotReader | null = null;
  private livePrevBuffer: ArrayBuffer | null = null;
  private liveCurBuffer: ArrayBuffer | null = null;
  /** The newest live snapshot that arrived while replaying (applied on endReplay). */
  private pendingLive: ArrayBuffer | null = null;
  private readonly replayReaders = [new SnapshotReader(), new SnapshotReader()];
  private readonly replayEventReader = new SnapshotReader();
  /** Added to every LIVE repair epoch (replay seeks reset damage visuals; the offset keeps the live view continuous after exit). */
  private epochOffset = 0;
  private nextRequestId = 1;
  private readonly pendingPause: { resolve(v: { paused: boolean; tick: number; hash: number }): void; reject(e: Error): void }[] = [];
  private readonly pendingHash = new Map<number, { resolve(v: { tick: number; hash: number }): void; reject(e: Error): void }>();
  private readonly pendingFile = new Map<number, { resolve(f: ReplayFile): void; reject(e: Error): void }>();

  readonly stats: SimClientStats;

  constructor(opts: SimClientOptions) {
    this.debugStrains = opts.debugStrains ?? false;
    this.onFatal = opts.onFatal;
    const snapshotHz = opts.snapshotHz ?? DEFAULT_SNAPSHOT_HZ;
    this.arrivalIntervalMs = 1000 / snapshotHz;

    const self = this;
    this.stats = {
      snapshotHz: 0,
      get snapshotAgeMs(): number {
        return self.lastArrivalMs < 0 ? Infinity : performance.now() - self.lastArrivalMs;
      },
      snapshotsReceived: 0,
      eventsDropped: 0,
    };

    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.handle(ev.data);
    this.worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      this.fail(`worker error: ${ev.message || 'failed to load worker'}`);
    };
    this.worker.onmessageerror = () => console.warn('[sim] undeserializable message from worker');

    const init: MainToWorker = {
      type: 'init',
      seed: opts.seed,
      gravity: opts.gravity ?? [0, -9.81, 0],
      snapshotHz,
      debugStrains: this.debugStrains,
    };
    if (opts.capacity) init.capacity = opts.capacity;
    this.post(init);
  }

  // ------------------------------------------------------------ commands
  ground(y: number, materialId: MaterialId): void {
    this.post({ type: 'ground', mode: 'plane', y, materialId });
  }

  /**
   * Replaces the ground with the heightfield of `layout` (P3). The worker
   * regenerates the terrain itself and compares its hashTerrain() with
   * `terrainHash` (main's own result for the same layout; 0 = don't
   * compare). Resolves with the worker's `terrainReady` (also kept in
   * `terrain`); `matched: false` with a non-zero hash means build skew —
   * the worker still installed ITS terrain and also logs an `error`.
   * Rejects if the worker rejects the layout (e.g. WorldLayoutError) or
   * dies. Send it before spawning (spawns queue behind it) and INSTEAD of
   * `ground()`: switching plane ⇄ heightfield in one worker leaves the
   * contact kernels' sampler calls polymorphic (not inlined, slower).
   */
  groundHeightfield(layout: WorldLayout, terrainHash: number): Promise<TerrainReadyInfo> {
    if (this.disposed || this._fatal) {
      return Promise.reject(new Error(`[sim] groundHeightfield: worker ${this.disposed ? 'disposed' : 'dead'}`));
    }
    const hash = terrainHash >>> 0;
    return new Promise<TerrainReadyInfo>((resolve, reject) => {
      this.pendingTerrain.push({ hash, resolve, reject });
      this.post({ type: 'groundHeightfield', layout, terrainHash: hash });
    });
  }

  /** The latest `terrainReady` (null before the first heightfield is active). */
  get terrain(): TerrainReadyInfo | null {
    return this._terrain;
  }

  /**
   * Compiles the rig on main (pure) to keep the static beam index pairs, then
   * sends the same RigDef to the worker. Returns false if the rig is invalid.
   */
  spawn(objectId: number, rig: RigDef, transform: Transform): boolean {
    let compiled;
    try {
      compiled = compileRig(rig);
    } catch (err) {
      console.warn(`[sim] spawn ${objectId}: rig '${rig.name}' rejected on main:`, err);
      return false;
    }
    this.pairs.set(objectId, beamPairsOf(compiled.beamCount, compiled.beamA, compiled.beamB));
    this.vehicles.delete(objectId);
    this.post({ type: 'spawn', objectId, rig, transform: cloneTransform(transform) });
    return true;
  }

  /**
   * Spawns a vehicle. Main builds the merged rig (pure buildVehicleRig, same
   * canonical order the worker compiles; MINIMASS never changes topology) to
   * keep beam pairs and frame-node indices. Returns false if the def is invalid.
   */
  spawnVehicle(objectId: number, vehicle: VehicleDef, transform: Transform, transmission?: TransmissionMode, catalogId?: string, settle?: number): boolean {
    let rig: RigDef;
    let compiled;
    try {
      rig = buildVehicleRig(vehicle);
      compiled = compileRig(rig);
    } catch (err) {
      console.warn(`[sim] spawnVehicle ${objectId}: '${vehicle.name}' rejected on main:`, err);
      return false;
    }
    const nodeIndex = (id: string): number => rig.nodes.findIndex((n) => n.id === id);
    const f = vehicle.frame;
    this.pairs.set(objectId, beamPairsOf(compiled.beamCount, compiled.beamA, compiled.beamB));
    this.vehicles.set(objectId, {
      frameNodes: Int32Array.of(nodeIndex(f.origin), nodeIndex(f.front), nodeIndex(f.top)),
      bodyNodeCount: vehicle.body.nodes.length,
      nodeCount: rig.nodes.length,
      beamCount: compiled.beamCount,
    });
    const msg: MainToWorker = { type: 'spawnVehicle', objectId, vehicle, transform: cloneTransform(transform) };
    if (transmission) msg.transmission = transmission;
    if (catalogId !== undefined) msg.catalogId = catalogId;
    if (settle !== undefined && settle > 0) msg.settle = settle;
    this.post(msg);
    return true;
  }

  // ------------------------------------------------------------ traffic (P6)
  /**
   * Configures (full restart) AI traffic; resolves with the worker's
   * `trafficReady` (also kept in `trafficInfo`). Rejects when the worker
   * rejects the config (`error`), does not implement traffic yet
   * (`unimplemented`) or dies. Send after `groundHeightfield` and after the
   * focus vehicle's spawn.
   */
  setTraffic(config: TrafficConfig): Promise<TrafficReadyInfo> {
    if (this.disposed || this._fatal) {
      return Promise.reject(new Error(`[sim] setTraffic: worker ${this.disposed ? 'disposed' : 'dead'}`));
    }
    return new Promise<TrafficReadyInfo>((resolve, reject) => {
      this.pendingTraffic.push({ resolve, reject });
      this.post({ type: 'setTraffic', ...config, variants: config.variants.slice() });
    });
  }

  /** Retunes density without a restart (quality change, governor). */
  setTrafficDensity(density: TrafficDensity): void {
    this.post({ type: 'setTrafficDensity', density: { ...density } });
  }

  /** P8: worker-side driver for a spawned vehicle (protocol `setAutopilot`; challenge opponents). */
  setAutopilot(objectId: number, cfg: { mode: 'off' | 'ram'; targetObjectId?: number; aggression?: number; seed?: number }): void {
    this.post({ type: 'setAutopilot', objectId, ...cfg });
  }

  /**
   * P8: called with EVERY live snapshot as it arrives (120 Hz, independent of
   * the render loop; after the replay recorder's sink; never with replay
   * frames, which do not arrive while a replay is shown). The reader is only
   * valid during the call. Returns the unsubscribe function.
   */
  addSnapshotListener(fn: (r: SnapshotReader) => void): () => void {
    this.snapshotListeners.push(fn);
    return () => {
      const i = this.snapshotListeners.indexOf(fn);
      if (i >= 0) this.snapshotListeners.splice(i, 1);
    };
  }

  /** The latest `trafficReady` (null before traffic is configured). */
  get trafficInfo(): TrafficReadyInfo | null {
    return this._traffic;
  }

  /** Worker CPU ms per simulated ms of the latest snapshot (0 = not measured). Informational. */
  get workerLoad(): number {
    return this.cur ? this.cur.workerLoad : 0;
  }

  /** Traffic records in the latest snapshot. */
  get trafficCount(): number {
    return this.cur ? this.cur.trafficCount : 0;
  }

  /**
   * Decodes every traffic record of the latest snapshot into `out` (grown
   * with new frames when shorter; reuse the array: steady state allocates
   * nothing) and returns the count. Ghost poses, speed, steer and brake are
   * interpolated to `renderSimTime` between the previous and the latest
   * snapshot when the agent is in both, in the same mode (ghost/awake) and
   * not TELEPORTED; otherwise the latest values are used as-is. Sets
   * `nodesReady` (awake object present in both snapshots with the same node
   * count: its interpolated nodes are valid — the hand-over rule).
   */
  readTrafficAgents(renderSimTime: number, out: TrafficAgentFrame[]): number {
    const cur = this.cur;
    if (!cur) return 0;
    const n = cur.trafficCount;
    while (out.length < n) out.push(createTrafficAgentFrame());
    const prev = this.prev;
    const span = prev ? cur.simTime - prev.simTime : 0;
    let t = span > 0 && prev ? (renderSimTime - prev.simTime) / span : 1;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const p = this.trafficPrev;
    for (let i = 0; i < n; i++) {
      const o = cur.readTrafficAgent(i, out[i]!);
      const awake = (o.flags & TRAFFIC_FLAG_AWAKE) !== 0;
      o.nodesReady = false;
      if (awake && prev) {
        const ci = cur.findObject(o.objectId);
        const pi = prev.findObject(o.objectId);
        o.nodesReady = ci >= 0 && pi >= 0 && prev.objectNodeCount(pi) === cur.objectNodeCount(ci);
      }
      if (!prev || t >= 1 || (o.flags & TRAFFIC_FLAG_TELEPORTED) !== 0) continue;
      const j = prev.findTrafficAgent(o.agent);
      if (j < 0) continue;
      prev.readTrafficAgent(j, p);
      if (((p.flags & TRAFFIC_FLAG_AWAKE) !== 0) !== awake) continue;
      for (let k = 0; k < 3; k++) o.pos[k] = p.pos[k]! + (o.pos[k]! - p.pos[k]!) * t;
      // nlerp along the shorter arc.
      const dot = p.quat[0] * o.quat[0] + p.quat[1] * o.quat[1] + p.quat[2] * o.quat[2] + p.quat[3] * o.quat[3];
      const sg = dot < 0 ? -1 : 1;
      let len = 0;
      for (let k = 0; k < 4; k++) {
        const q = p.quat[k]! + (sg * o.quat[k]! - p.quat[k]!) * t;
        o.quat[k] = q;
        len += q * q;
      }
      len = len > 0 ? 1 / Math.sqrt(len) : 1;
      for (let k = 0; k < 4; k++) o.quat[k] = o.quat[k]! * len;
      o.speed = p.speed + (o.speed - p.speed) * t;
      o.steer = p.steer + (o.steer - p.steer) * t;
      o.brake = p.brake + (o.brake - p.brake) * t;
    }
    return n;
  }

  setTransmission(objectId: number, mode: TransmissionMode): void {
    this.post({ type: 'setTransmission', objectId, mode });
  }

  /** Driver assists (SetAssistsMsg): traction control on/off. */
  setAssists(objectId: number, assists: { tractionControl?: boolean }): void {
    const msg: MainToWorker = { type: 'setAssists', objectId };
    if (assists.tractionControl !== undefined) msg.tractionControl = assists.tractionControl;
    this.post(msg);
  }

  /** Rigidly re-places the current (deformed) vehicle upright; damage is kept (see RecoverMsg). */
  recover(objectId: number, pos?: Vec3): void {
    const msg: MainToWorker = { type: 'recover', objectId };
    if (pos) msg.pos = [pos[0], pos[1], pos[2]];
    this.post(msg);
  }

  despawn(objectId: number): void {
    this.pairs.delete(objectId);
    this.vehicles.delete(objectId);
    this.post({ type: 'despawn', objectId });
  }

  input(objectId: number, actions: Partial<ActionState>): void {
    this.post({ type: 'input', objectId, actions });
  }

  /** Full repair at `transform`; `settle` > 0 = a damage-free spawn-settle window (sim s, see ResetMsg). */
  reset(objectId: number, transform: Transform, settle?: number): void {
    const msg: MainToWorker = { type: 'reset', objectId, transform: cloneTransform(transform) };
    if (settle !== undefined && settle > 0) msg.settle = settle;
    this.post(msg);
  }

  setTimescale(value: number): void {
    this.post({ type: 'timescale', value });
  }

  // ------------------------------------------------------------ replay (P7)
  /** The live recorder: called with every live snapshot reader right after it becomes `cur` (not while replaying). */
  setSnapshotSink(fn: ((r: SnapshotReader) => void) | null): void {
    this.snapshotSink = fn;
  }

  /** True while recorded frames are presented instead of live snapshots. */
  get replayActive(): boolean {
    return this.replaying;
  }

  /** The live `cur` reader (the newest snapshot; null before the first). Valid until the next snapshot. */
  get liveReader(): SnapshotReader | null {
    return this.replaying ? this.liveCur : this.cur;
  }

  /**
   * Freezes the live view: the held live buffers are parked (not returned)
   * and every query answers from frames given to `presentReplay`. Live
   * snapshots arriving meanwhile are parked too (newest kept).
   */
  beginReplay(): void {
    if (this.replaying) return;
    this.replaying = true;
    this.livePrev = this.prev;
    this.liveCur = this.cur;
    this.livePrevBuffer = this.prevBuffer;
    this.liveCurBuffer = this.curBuffer;
    this.prev = null;
    this.prevBuffer = null;
    this.replayTime = this.liveCur ? this.liveCur.simTime : 0;
  }

  /**
   * Presents two decoded recorded frames (snapshot-layout buffers owned by
   * the caller; `prev` may be null) as the interpolation pair, with the
   * render clock at `time`. `events`: capture `cur`'s event rings (they are
   * delivered by the next drainEvents).
   */
  presentReplay(prev: ArrayBuffer | null, cur: ArrayBuffer, time: number, events: boolean): void {
    if (!this.replaying) throw new Error('presentReplay outside beginReplay/endReplay');
    const [a, b] = this.replayReaders as [SnapshotReader, SnapshotReader];
    this.cur = b.attach(cur);
    this.curBuffer = null;
    this.prev = prev ? a.attach(prev) : null;
    this.prevBuffer = null;
    this.replayTime = time;
    if (events) this.captureEvents(b);
    this.rebuildRanges(b);
  }

  /** Captures the event rings of a decoded frame the playhead passed (delivered by the next drainEvents). */
  pushReplayEvents(frame: ArrayBuffer): void {
    this.captureEvents(this.replayEventReader.attach(frame));
  }

  /** Drops every captured, undrained event. */
  discardEvents(): void {
    this.impacts.count = 0;
    this.breaks.count = 0;
    this.skids.count = 0;
  }

  /**
   * Restores the parked live view (then applies a live snapshot that arrived
   * meanwhile, if any). `epochOffset` is added to live repair epochs from now
   * on (the last presented frame's offset: no damage reset at the switch).
   */
  endReplay(epochOffset: number): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.epochOffset = epochOffset >>> 0;
    this.prev = this.livePrev;
    this.cur = this.liveCur;
    this.prevBuffer = this.livePrevBuffer;
    this.curBuffer = this.liveCurBuffer;
    // the spare reader may be one of the parked ones' predecessors: keep a fresh one
    if (this.spare === this.prev || this.spare === this.cur) this.spare = new SnapshotReader();
    this.livePrev = this.liveCur = null;
    this.livePrevBuffer = this.liveCurBuffer = null;
    if (this.cur) this.rebuildRanges(this.cur);
    this.discardEvents();
    const p = this.pendingLive;
    this.pendingLive = null;
    if (p) this.onSnapshot(p);
  }

  /** Freeze / resume worker stepping (`replayPause`); resolves with the worker's tick + state hash. */
  pauseSim(paused: boolean): Promise<{ paused: boolean; tick: number; hash: number }> {
    if (this.disposed || this._fatal) return Promise.reject(new Error('[sim] pauseSim: worker gone'));
    return new Promise((resolve, reject) => {
      this.pendingPause.push({ resolve, reject });
      this.post({ type: 'replayPause', paused });
    });
  }

  /** hashSimState() of the worker now. */
  stateHash(): Promise<{ tick: number; hash: number }> {
    if (this.disposed || this._fatal) return Promise.reject(new Error('[sim] stateHash: worker gone'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingHash.set(requestId, { resolve, reject });
      this.post({ type: 'stateHashRequest', requestId });
    });
  }

  /** The worker's ReplayFile of the run so far (build / paint not stamped). */
  requestReplayFile(): Promise<ReplayFile> {
    if (this.disposed || this._fatal) return Promise.reject(new Error('[sim] requestReplayFile: worker gone'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingFile.set(requestId, { resolve, reject });
      this.post({ type: 'replayFileRequest', requestId });
    });
  }

  /**
   * Node `local` of `objectId` interpolated at `time` between the held pair
   * (current snapshot when the object is missing from the previous one) into
   * out[0..2]. False when absent.
   */
  objectNode(objectId: number, local: number, time: number, out: { [i: number]: number }): boolean {
    const cur = this.cur;
    if (!cur) return false;
    const ci = cur.findObject(objectId);
    if (ci < 0 || local < 0 || local >= cur.objectNodeCount(ci)) return false;
    const cn = cur.nodes;
    const c = (cur.objectNodeOffset(ci) + local) * NODE_STRIDE;
    const prev = this.prev;
    const pi = prev ? prev.findObject(objectId) : -1;
    const span = prev ? cur.simTime - prev.simTime : 0;
    if (!prev || pi < 0 || prev.objectNodeCount(pi) !== cur.objectNodeCount(ci) || prev.objectRepairEpoch(pi) !== cur.objectRepairEpoch(ci) || !(span > 0)) {
      out[0] = cn[c]!;
      out[1] = cn[c + 1]!;
      out[2] = cn[c + 2]!;
      return true;
    }
    let t = (time - prev.simTime) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const pn = prev.nodes;
    const p = (prev.objectNodeOffset(pi) + local) * NODE_STRIDE;
    for (let k = 0; k < 3; k++) out[k] = pn[p + k]! + (cn[c + k]! - pn[p + k]!) * t;
    return true;
  }

  /** Bounding sphere of `objectId`'s nodes in the current snapshot: out = [cx, cy, cz, r]; false when absent. */
  objectBounds(objectId: number, out: { [i: number]: number }): boolean {
    const cur = this.cur;
    if (!cur) return false;
    const i = cur.findObject(objectId);
    if (i < 0) return false;
    const n = cur.objectNodeCount(i);
    if (n === 0) return false;
    const nodes = cur.nodes;
    const o = cur.objectNodeOffset(i) * NODE_STRIDE;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = nodes[o + 3 * k]!, y = nodes[o + 3 * k + 1]!, z = nodes[o + 3 * k + 2]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    out[0] = (x0 + x1) / 2;
    out[1] = (y0 + y1) / 2;
    out[2] = (z0 + z1) / 2;
    out[3] = 0.5 * Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectTerrain('[sim] worker disposed');
    this.prev = this.cur = null;
    this.prevBuffer = this.curBuffer = null;
  }

  // ------------------------------------------------------------ state
  get ready(): boolean {
    return this._ready;
  }
  get fatal(): string | null {
    return this._fatal;
  }
  /** Sim tick of the latest snapshot (0 before the first). */
  get latestTick(): number {
    return this.cur ? this.cur.tick : 0;
  }
  /** Sim time (s) of the latest snapshot (0 before the first). */
  get simTime(): number {
    return this.cur ? this.cur.simTime : 0;
  }
  /** Node count of the latest snapshot; `interpolate` writes 3× this many floats. */
  get nodeTotal(): number {
    return this.cur ? this.cur.nodeTotal : 0;
  }

  /**
   * Render clock about one snapshot behind the newest: sweeps from the
   * previous snapshot's simTime to the current one's over the measured
   * arrival interval, so interpolation always has both endpoints.
   */
  renderTime(nowMs: number = performance.now()): number {
    if (this.replaying) return this.replayTime;
    const cur = this.cur;
    if (!cur) return 0;
    const prev = this.prev;
    if (!prev) return cur.simTime;
    const a = Math.min(Math.max((nowMs - this.lastArrivalMs) / this.arrivalIntervalMs, 0), 1);
    return prev.simTime + (cur.simTime - prev.simTime) * a;
  }

  /**
   * Writes node positions (global snapshot order, xyz interleaved) lerped
   * between the two held snapshots at `renderSimTime` into `out`. Objects
   * missing from the previous snapshot (or whose node count changed) take the
   * current positions. Returns the number of nodes written.
   *
   * Objects whose repair epoch changed between the two snapshots (reset /
   * teleport / respawn: the worker bumps the epoch, also on a respawn of the
   * same objectId) take the current positions too: a lerp from the old pose
   * to a new one with another heading squeezes the body (at 180° it passes
   * through a point), and the damage visuals measured that squeeze as
   * plastic strain and shattered glass on a freshly repaired car.
   */
  interpolate(renderSimTime: number, out: Float32Array): number {
    const cur = this.cur;
    if (!cur) return 0;
    const total = cur.nodeTotal;
    if (out.length < total * NODE_STRIDE) {
      throw new RangeError(`interpolate: out holds ${out.length} floats, need ${total * NODE_STRIDE}`);
    }
    const curNodes = cur.nodes;
    const prev = this.prev;
    const span = prev ? cur.simTime - prev.simTime : 0;
    if (!prev || span <= 0) {
      out.set(curNodes);
      return total;
    }
    let t = (renderSimTime - prev.simTime) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const prevNodes = prev.nodes;
    for (let i = 0, n = cur.objectCount; i < n; i++) {
      const off = cur.objectNodeOffset(i) * NODE_STRIDE;
      const len = cur.objectNodeCount(i) * NODE_STRIDE;
      const p = prev.findObject(cur.objectId(i));
      if (p < 0 || prev.objectNodeCount(p) * NODE_STRIDE !== len || prev.objectRepairEpoch(p) !== cur.objectRepairEpoch(i)) {
        out.set(curNodes.subarray(off, off + len), off);
        continue;
      }
      const poff = prev.objectNodeOffset(p) * NODE_STRIDE;
      for (let k = 0; k < len; k++) {
        const a = prevNodes[poff + k]!;
        out[off + k] = a + (curNodes[off + k]! - a) * t;
      }
    }
    return total;
  }

  /** Object slices of the latest snapshot, ascending objectId. */
  objectRanges(): readonly ObjectRange[] {
    return this.rangeView;
  }

  /** Static beam endpoints (object-local node indices, interleaved a,b), or null if not spawned here. */
  beamPairs(objectId: number): Uint32Array | null {
    return this.pairs.get(objectId) ?? null;
  }

  /** Static vehicle facts for an object spawned via spawnVehicle, else null. */
  vehicleInfo(objectId: number): VehicleInfo | null {
    return this.vehicles.get(objectId) ?? null;
  }

  /**
   * Latest telemetry block (TELEMETRY_SLOTS f32, slot names in
   * protocol/telemetry.ts) for `objectId`, or null when absent. Valid until
   * the next snapshot is processed.
   */
  telemetry(objectId: number): Float32Array | null {
    const cur = this.cur;
    if (!cur) return null;
    const i = cur.findObject(objectId);
    return i < 0 ? null : cur.objectTelemetry(i);
  }

  /** Decodes the latest telemetry of `objectId` into `out`; false (out untouched) when absent. */
  readTelemetry(objectId: number, out: VehicleTelemetryFrame): boolean {
    const t = this.telemetry(objectId);
    if (!t) return false;
    readVehicleTelemetry(t, out);
    return true;
  }

  /** Latest strains for `objectId` (object-local beam order), or null (absent / no debugStrains). */
  strains(objectId: number): Float32Array | null {
    const cur = this.cur;
    if (!cur) return null;
    const i = cur.findObject(objectId);
    return i < 0 ? null : cur.objectStrains(i);
  }

  /**
   * P4: object-local broken flags of `objectId` in the latest snapshot (the
   * authoritative bitset section; 1 = broken, 0 = intact) written into
   * out[0..beamCount). Returns the broken count, or -1 (out untouched) when
   * the object is absent. All intact when the worker does not write the
   * section. Allocation-free.
   */
  brokenBeams(objectId: number, out: Uint8Array): number {
    const cur = this.cur;
    if (!cur) return -1;
    const i = cur.findObject(objectId);
    return i < 0 ? -1 : cur.readObjectBroken(i, out);
  }

  /** P4: OBJ_REPAIR_EPOCH of `objectId` in the latest snapshot (0 when absent / pre-P4 worker). */
  repairEpoch(objectId: number): number {
    const cur = this.cur;
    if (!cur) return 0;
    const i = cur.findObject(objectId);
    if (i < 0) return 0;
    // presented replay frames already carry their offset
    return this.replaying ? cur.objectRepairEpoch(i) : (cur.objectRepairEpoch(i) + this.epochOffset) >>> 0;
  }

  /** P4: the latest snapshot carries the broken-beam bitset section. */
  get hasBrokenBeams(): boolean {
    return this.cur ? this.cur.hasBrokenBeams : false;
  }

  /**
   * P4: replaces the EXTRA static collider set (appended after the layout's
   * own colliders; tests, set-ups, plane-ground demos). Invalid → worker
   * `error`, set unchanged.
   */
  setColliders(colliders: ColliderDef[]): void {
    this.post({ type: 'setColliders', colliders });
  }

  /**
   * P5: batch-spawn dynamic props (atomic; ids in the PROP_DYNAMIC range).
   * Layout props need no call: the worker spawns them on groundHeightfield.
   * Until the worker implements it, it answers `error` (unknown command).
   */
  spawnProps(items: PropSpawn[]): void {
    this.post({ type: 'spawnProps', items });
  }

  /** P5: full repair + re-place props asleep (omitted ids = every layout prop). */
  resetProps(objectIds?: number[]): void {
    this.post(objectIds ? { type: 'resetProps', objectIds } : { type: 'resetProps' });
  }

  /** Delivers and clears every event received since the last drain, in arrival order per kind. */
  drainEvents(cb: SimEventSink): void {
    if (cb.impact) for (let i = 0; i < this.impacts.count; i++) cb.impact(this.impacts.at(i));
    if (cb.beamBreak) for (let i = 0; i < this.breaks.count; i++) cb.beamBreak(this.breaks.at(i));
    if (cb.skid) for (let i = 0; i < this.skids.count; i++) cb.skid(this.skids.at(i));
    this.impacts.count = 0;
    this.breaks.count = 0;
    this.skids.count = 0;
  }

  // ------------------------------------------------------------ internals
  private post(msg: MainToWorker): void {
    if (this.disposed || this._fatal) return;
    this.worker.postMessage(msg);
  }

  private fail(message: string, stack?: string): void {
    if (this._fatal) return;
    this._fatal = message;
    this.rejectTerrain(`[sim] worker fatal: ${message}`);
    for (const p of this.pendingTraffic.splice(0)) p.reject(new Error(`[sim] worker fatal: ${message}`));
    for (const p of this.pendingPause.splice(0)) p.reject(new Error(`[sim] worker fatal: ${message}`));
    for (const p of this.pendingHash.values()) p.reject(new Error(`[sim] worker fatal: ${message}`));
    for (const p of this.pendingFile.values()) p.reject(new Error(`[sim] worker fatal: ${message}`));
    this.pendingHash.clear();
    this.pendingFile.clear();
    console.error(`[sim] fatal: ${message}${stack ? `\n${stack}` : ''}`);
    this.onFatal?.(message);
  }

  private handle(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'snapshot':
        this.onSnapshot(msg.buffer);
        break;
      case 'ready':
        this._ready = true;
        break;
      case 'error':
        console.warn(
          `[sim] ${msg.command} rejected${msg.objectId !== undefined ? ` (object ${msg.objectId})` : ''}: ${msg.message}`,
        );
        if (msg.command === 'groundHeightfield') {
          // A hash-mismatch error trails its (already resolved) terrainReady;
          // any other one means the request failed outright.
          if (this.mismatchErrorsDue > 0) this.mismatchErrorsDue--;
          else this.pendingTerrain.shift()?.reject(new Error(msg.message));
        }
        if (msg.command === 'setTraffic') this.pendingTraffic.shift()?.reject(new Error(msg.message));
        break;
      case 'trafficReady': {
        const { type: _type, ...info } = msg;
        this._traffic = info;
        this.pendingTraffic.shift()?.resolve(info);
        break;
      }
      case 'terrainReady': {
        const info: TerrainReadyInfo = {
          layoutId: msg.layoutId,
          terrainHash: msg.terrainHash,
          matched: msg.matched,
          generateMs: msg.generateMs,
        };
        this._terrain = info;
        const req = this.pendingTerrain.shift();
        if (req && req.hash !== 0 && !info.matched) this.mismatchErrorsDue++;
        req?.resolve(info);
        break;
      }
      case 'replayPaused':
        this.pendingPause.shift()?.resolve({ paused: msg.paused, tick: msg.tick, hash: msg.stateHash >>> 0 });
        break;
      case 'stateHash': {
        const p = this.pendingHash.get(msg.requestId);
        this.pendingHash.delete(msg.requestId);
        p?.resolve({ tick: msg.tick, hash: msg.hash >>> 0 });
        break;
      }
      case 'replayFile': {
        const p = this.pendingFile.get(msg.requestId);
        this.pendingFile.delete(msg.requestId);
        p?.resolve(msg.file);
        break;
      }
      case 'unimplemented':
        console.warn(`[sim] worker: '${msg.command}' not implemented yet`);
        if (msg.command === 'replayPause') this.pendingPause.shift()?.reject(new Error('replayPause not implemented by the worker'));
        if (msg.command === 'setTraffic') this.pendingTraffic.shift()?.reject(new Error('setTraffic not implemented by the worker'));
        break;
      case 'fatal':
        this.fail(msg.message, msg.stack);
        break;
    }
  }

  private onSnapshot(buffer: ArrayBuffer): void {
    if (this.disposed) return;
    if (this.replaying) {
      // parked: the newest live snapshot waits for endReplay, older ones go straight back
      if (this.pendingLive) this.returnBuffer(this.pendingLive);
      this.pendingLive = buffer;
      return;
    }
    const reader = this.spare;
    try {
      reader.attach(buffer);
    } catch (err) {
      console.error('[sim] dropping malformed snapshot:', err);
      this.returnBuffer(buffer);
      return;
    }

    // Rotate: the old `prev` buffer goes back to the worker's pool.
    if (this.prevBuffer) this.returnBuffer(this.prevBuffer);
    const freed = this.prev;
    this.prev = this.cur;
    this.prevBuffer = this.curBuffer;
    this.cur = reader;
    this.curBuffer = buffer;
    this.spare = freed ?? new SnapshotReader();

    this.captureEvents(reader);
    this.rebuildRanges(reader);
    this.snapshotSink?.(reader);
    // P8: live snapshot listeners (challenge runtime), after the replay recorder; never replay frames.
    for (let i = 0; i < this.snapshotListeners.length; i++) this.snapshotListeners[i]!(reader);

    const now = performance.now();
    if (this.lastArrivalMs >= 0) {
      const dt = now - this.lastArrivalMs;
      // Smoothed arrival interval drives renderTime; clamp outliers (tab stalls).
      this.arrivalIntervalMs += (Math.min(Math.max(dt, 1), 250) - this.arrivalIntervalMs) * 0.1;
    }
    this.lastArrivalMs = now;
    this.stats.snapshotsReceived++;
    if (this.rateWindowStart < 0) this.rateWindowStart = now;
    this.rateWindowCount++;
    const win = now - this.rateWindowStart;
    if (win >= 500) {
      this.stats.snapshotHz = (this.rateWindowCount * 1000) / win;
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
  }

  private rejectTerrain(reason: string): void {
    const pending = this.pendingTerrain.splice(0);
    for (const p of pending) p.reject(new Error(reason));
  }

  private returnBuffer(buffer: ArrayBuffer): void {
    if (this.disposed || this._fatal) return;
    this.worker.postMessage({ type: 'returnBuffer', buffer } satisfies MainToWorker, [buffer]);
  }

  private captureEvents(r: SnapshotReader): void {
    let dropped = 0;
    for (let i = 0, n = r.impactCount; i < n; i++) {
      const e = this.impacts.next();
      if (e) r.readImpact(i, e);
      else dropped++;
    }
    for (let i = 0, n = r.beamBreakCount; i < n; i++) {
      const e = this.breaks.next();
      if (e) r.readBeamBreak(i, e);
      else dropped++;
    }
    for (let i = 0, n = r.skidCount; i < n; i++) {
      const e = this.skids.next();
      if (e) r.readSkid(i, e);
      else dropped++;
    }
    this.stats.eventsDropped += dropped;
  }

  private rebuildRanges(r: SnapshotReader): void {
    const n = r.objectCount;
    for (let i = 0; i < n; i++) {
      let rec = this.ranges[i];
      if (!rec) {
        rec = { objectId: 0, flags: 0, nodeOffset: 0, nodeCount: 0, beamOffset: 0, beamCount: 0 };
        this.ranges.push(rec);
      }
      rec.objectId = r.objectId(i);
      rec.flags = r.objectFlags(i);
      rec.nodeOffset = r.objectNodeOffset(i);
      rec.nodeCount = r.objectNodeCount(i);
      rec.beamOffset = r.objectBeamOffset(i);
      rec.beamCount = r.objectBeamCount(i);
    }
    if (n !== this.rangeCount) {
      this.rangeView.length = 0;
      for (let i = 0; i < n; i++) this.rangeView.push(this.ranges[i]!);
      this.rangeCount = n;
    }
  }
}

function beamPairsOf(n: number, a: ArrayLike<number>, b: ArrayLike<number>): Uint32Array {
  const p = new Uint32Array(n * 2);
  for (let i = 0; i < n; i++) {
    p[2 * i] = a[i]!;
    p[2 * i + 1] = b[i]!;
  }
  return p;
}

function cloneTransform(t: Transform): Transform {
  return {
    pos: [t.pos[0], t.pos[1], t.pos[2]] as Vec3,
    quat: [t.quat[0], t.quat[1], t.quat[2], t.quat[3]] as Quat,
  };
}
