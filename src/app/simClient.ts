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
  type SnapshotCapacity,
  type Transform,
  type WorkerToMain,
} from '../protocol/messages';
import { NODE_STRIDE } from '../protocol/layout';
import { SnapshotReader } from '../protocol/codec';
import { compileRig } from '../sim/rig/builder';
import type { RigDef } from '../sim/rig/types';

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

  private readonly impacts = new EventQueue(createImpactEvent);
  private readonly breaks = new EventQueue(createBeamBreakEvent);
  private readonly skids = new EventQueue(createSkidEvent);

  private lastArrivalMs = -1;
  private arrivalIntervalMs: number;
  private rateWindowStart = -1;
  private rateWindowCount = 0;

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
    const n = compiled.beamCount;
    const p = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      p[2 * i] = compiled.beamA[i]!;
      p[2 * i + 1] = compiled.beamB[i]!;
    }
    this.pairs.set(objectId, p);
    this.post({ type: 'spawn', objectId, rig, transform: cloneTransform(transform) });
    return true;
  }

  despawn(objectId: number): void {
    this.pairs.delete(objectId);
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

  /** Latest strains for `objectId` (object-local beam order), or null (absent / no debugStrains). */
  strains(objectId: number): Float32Array | null {
    const cur = this.cur;
    if (!cur) return null;
    const i = cur.findObject(objectId);
    return i < 0 ? null : cur.objectStrains(i);
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
        break;
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

function cloneTransform(t: Transform): Transform {
  return {
    pos: [t.pos[0], t.pos[1], t.pos[2]] as Vec3,
    quat: [t.quat[0], t.quat[1], t.quat[2], t.quat[3]] as Quat,
  };
}
