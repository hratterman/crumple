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
  type TerrainReadyMsg,
  type Transform,
  type WorkerToMain,
} from '../protocol/messages';
import { NODE_STRIDE } from '../protocol/layout';
import { SnapshotReader } from '../protocol/codec';
import { readVehicleTelemetry, type VehicleTelemetryFrame } from '../protocol/telemetry';
import { compileRig } from '../sim/rig/builder';
import type { RigDef } from '../sim/rig/types';
import { buildVehicleRig } from '../sim/vehicle/builder';
import type { TransmissionMode, VehicleDef } from '../sim/vehicle/types';
import type { ColliderDef, WorldLayout } from '../world/types';

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

  private _ready = false;
  private _fatal: string | null = null;
  private disposed = false;

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
  spawnVehicle(objectId: number, vehicle: VehicleDef, transform: Transform, transmission?: TransmissionMode): boolean {
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
    this.post(msg);
    return true;
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

  reset(objectId: number, transform: Transform): void {
    this.post({ type: 'reset', objectId, transform: cloneTransform(transform) });
  }

  setTimescale(value: number): void {
    this.post({ type: 'timescale', value });
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
      if (p < 0 || prev.objectNodeCount(p) * NODE_STRIDE !== len) {
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
    return i < 0 ? 0 : cur.objectRepairEpoch(i);
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
        break;
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
      case 'unimplemented':
        console.warn(`[sim] worker: '${msg.command}' not implemented yet`);
        break;
      case 'fatal':
        this.fail(msg.message, msg.stack);
        break;
    }
  }

  private onSnapshot(buffer: ArrayBuffer): void {
    if (this.disposed) return;
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
