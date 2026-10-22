/**
 * Sim worker entry: message handling, real-time pacing and snapshot output.
 *
 * Pacing: each wake adds real elapsed time × timeScale to an accumulator and
 * runs whole SIM_DT steps, at most MAX_STEPS_PER_WAKE; any further backlog is
 * DROPPED (counted in droppedSteps) so a stall never causes a spiral of
 * death. Snapshots land on fixed ticks (every SIM_HZ/snapshotHz ticks); when
 * one wake crosses several snapshot ticks only the last is written. Commands
 * are applied as they arrive, which is always between steps.
 */
import { BufferPool, SnapshotWriter } from '../protocol/codec';
import { computeSnapshotLayout } from '../protocol/layout';
import {
  DEFAULT_CAPACITY,
  DEFAULT_SNAPSHOT_HZ,
  type MainToWorker,
  type MainToWorkerType,
  type WorkerToMain,
} from '../protocol/messages';
import type { TerrainData, VegetationExtra, VegetationScatter, WorldLayout } from '../world/types';
import { generateTerrain, hashTerrain } from '../world/terrain';
import { scatterVegetation } from '../world/vegetation';
import { buildWorldContent } from '../world/content';
import type { WorldContent } from '../world/content/types';
import { resolveWater } from '../world/water';
import { resolvePropInstances } from './props/placement';
import { SIM_DT, SIM_HZ, SimCommandError, SimEngine } from './engine';
import { setDefaultKernel } from './kernel';
import { hashSimState } from './replay/hash';
import { ReplayLog } from './replay/log';

export const MAX_STEPS_PER_WAKE = 200;

export type PostFn = (msg: WorkerToMain, transfer?: Transferable[]) => void;

export interface HostScheduler {
  /** Milliseconds, monotonic. */
  now(): number;
  /** Run `fn` soon; `immediate` = backlog pending (no timer clamp wanted). */
  schedule(fn: () => void, immediate: boolean): void;
}

function defaultScheduler(): HostScheduler {
  const perf = globalThis.performance;
  const now = perf ? () => perf.now() : () => Date.now();
  let channel: MessageChannel | null = null;
  let pending: (() => void) | null = null;
  if (typeof MessageChannel !== 'undefined') {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const fn = pending;
      pending = null;
      fn?.();
    };
  }
  return {
    now,
    schedule(fn, immediate) {
      if (immediate && channel) {
        pending = fn;
        channel.port2.postMessage(0);
      } else {
        setTimeout(fn, 0);
      }
    },
  };
}

/** Terrain source for `groundHeightfield` (injectable for tests). */
export interface TerrainDeps {
  generateTerrain(layout: WorldLayout): TerrainData;
  hashTerrain(terrain: TerrainData): number;
  /** P5 (optional for older test doubles; default the real scatter). */
  scatterVegetation?(layout: WorldLayout, terrain: TerrainData, extra?: VegetationExtra | null): VegetationScatter;
  /** Layout v6 (R-WORLD; optional for older test doubles; default the real content builder, sim part only). */
  buildWorldContent?(layout: WorldLayout, terrain: TerrainData, opts: { render: boolean }): WorldContent;
}

const DEFAULT_TERRAIN_DEPS: TerrainDeps = { generateTerrain, hashTerrain, scatterVegetation, buildWorldContent };

function hex(h: number): string {
  return `0x${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Worker logic, independent of the global scope (testable in node). */
export class WorkerHost {
  engine: SimEngine | null = null;
  pool: BufferPool | null = null;
  writer: SnapshotWriter | null = null;
  timeScale = 1;
  snapshotHz = DEFAULT_SNAPSHOT_HZ;
  /** Steps dropped by the per-wake cap (real time the sim did not simulate). */
  droppedSteps = 0;
  snapshotsSent = 0;
  dead = false;
  /** P7: stepping frozen by `replayPause` (independent of timeScale). */
  paused = false;
  /** P7: deterministic command + input log since init (ReplayFile). */
  readonly log = new ReplayLog();

  private acc = 0;
  private lastWall = 0;
  private scheduled = false;
  private nextSnapIndex = 1;
  private nextSnapTick = 0;
  private dirty = false;
  private readonly scheduler: HostScheduler;
  /** The layout of the last groundHeightfield (route network source for setTraffic). */
  layout: WorldLayout | null = null;
  /** Worker load (CPU ms per simulated ms), smoothed over ~1 s of stepping; informational (snapshot header). */
  workerLoad = 0;
  private loadCpuMs = 0;
  private loadSimMs = 0;

  constructor(
    private readonly post: PostFn,
    scheduler?: HostScheduler,
    private readonly terrainDeps: TerrainDeps = DEFAULT_TERRAIN_DEPS,
  ) {
    this.scheduler = scheduler ?? defaultScheduler();
  }

  handle(msg: MainToWorker): void {
    if (this.dead) return;
    const type = (msg as { type?: unknown } | null)?.type as MainToWorkerType;
    try {
      switch (msg.type) {
        case 'init':
          this.init(msg);
          return;
        case 'setBubble':
        case 'keyframeRequest':
        case 'replaySeek':
          this.post({ type: 'unimplemented', command: msg.type });
          return;
        case 'returnBuffer':
          if (!this.pool) throw new SimCommandError('returnBuffer before init');
          this.pool.release(msg.buffer);
          return;
        case 'timescale': {
          const v = msg.value;
          if (typeof v !== 'number' || Number.isNaN(v)) throw new SimCommandError('timescale must be a number');
          this.timeScale = v <= 0 ? 0 : v < 0.05 ? 0.05 : v > 1 ? 1 : v;
          return;
        }
        default:
          break;
      }
      const engine = this.engine;
      if (!engine) throw new SimCommandError('not initialized');
      this.log.command(engine.tick, msg);
      switch (msg.type) {
        case 'replayPause':
          this.paused = !!msg.paused;
          this.lastWall = this.scheduler.now();
          this.post({ type: 'replayPaused', paused: this.paused, tick: engine.tick, stateHash: hashSimState(engine) });
          return;
        case 'stateHashRequest':
          this.post({ type: 'stateHash', requestId: msg.requestId, tick: engine.tick, hash: hashSimState(engine) });
          return;
        case 'replayFileRequest': {
          const file = this.log.build(engine);
          const i = file.inputs;
          this.post({ type: 'replayFile', requestId: msg.requestId, file }, [i.tick.buffer, i.objectId.buffer, i.action.buffer, i.value.buffer] as ArrayBuffer[]);
          return;
        }
        case 'ground':
          if (msg.mode === 'plane') {
            engine.setGroundPlane(msg.y, msg.materialId);
            this.dirty = true;
          } else {
            this.post({ type: 'unimplemented', command: 'ground' });
          }
          return;
        case 'groundHeightfield':
          this.groundHeightfield(engine, msg);
          return;
        case 'spawn':
          engine.spawn(msg.objectId, msg.rig, msg.transform);
          this.dirty = true;
          return;
        case 'despawn':
          engine.despawn(msg.objectId);
          this.dirty = true;
          return;
        case 'reset':
          engine.reset(msg.objectId, msg.transform, msg.settle);
          this.dirty = true;
          return;
        case 'input': {
          const obj = engine.arena.get(msg.objectId);
          if (obj) this.log.inputBefore(obj.actions);
          engine.setInput(msg.objectId, msg.actions);
          if (obj) this.log.inputAfter(engine.tick, msg.objectId, obj.actions, msg.actions);
          return;
        }
        case 'spawnVehicle':
          engine.spawnVehicle(msg.objectId, msg.vehicle, msg.transform, msg.transmission, msg.catalogId, msg.settle);
          this.dirty = true;
          return;
        case 'setTraffic': {
          const t0 = this.scheduler.now();
          const info = engine.setTraffic(msg, this.layout);
          const t1 = this.scheduler.now();
          // Setup blocks the worker (route network + settling): skip that time rather than catch up.
          this.lastWall = t1;
          this.dirty = true;
          this.post(
            { type: 'trafficReady', ...info, setupMs: t1 - t0 },
            info.variants.map((v) => v.settled.buffer as ArrayBuffer),
          );
          return;
        }
        case 'setTrafficDensity':
          engine.setTrafficDensity(msg.density);
          return;
        case 'setAutopilot':
          engine.setAutopilot(msg);
          return;
        case 'setTransmission':
          engine.setTransmission(msg.objectId, msg.mode);
          return;
        case 'setAssists':
          engine.setAssists(msg.objectId, msg);
          return;
        case 'recover':
          engine.recover(msg.objectId, msg.pos);
          this.dirty = true;
          return;
        case 'setColliders':
          engine.setExtraColliders(msg.colliders);
          this.dirty = true;
          return;
        case 'spawnProps':
          engine.spawnProps(msg.items);
          this.dirty = true;
          return;
        case 'resetProps':
          engine.resetProps(msg.objectIds);
          this.dirty = true;
          return;
        case 'setSolver':
          engine.setSolver(msg.options);
          return;
        default:
          throw new SimCommandError(`unknown command ${String(type)}`);
      }
    } catch (e) {
      const objectId =
        e instanceof SimCommandError && e.objectId !== undefined
          ? e.objectId
          : typeof (msg as { objectId?: unknown }).objectId === 'number'
            ? (msg as { objectId: number }).objectId
            : undefined;
      const reply: WorkerToMain = { type: 'error', command: type, message: errMessage(e) };
      if (objectId !== undefined) reply.objectId = objectId;
      this.post(reply);
    }
  }

  private init(msg: Extract<MainToWorker, { type: 'init' }>): void {
    const capacity = msg.capacity ?? DEFAULT_CAPACITY;
    const hz = msg.snapshotHz === undefined ? DEFAULT_SNAPSHOT_HZ : msg.snapshotHz;
    if (typeof hz !== 'number' || !(hz > 0) || hz > SIM_HZ) {
      throw new SimCommandError(`snapshotHz must be in (0, ${SIM_HZ}]`);
    }
    const engine = new SimEngine({
      gravity: msg.gravity,
      debugStrains: !!msg.debugStrains,
      capacity,
      seed: msg.seed,
    });
    const layout = computeSnapshotLayout(
      capacity.maxObjects,
      capacity.nodeCapacity,
      capacity.beamCapacity,
      engine.debugStrains,
    );
    this.engine = engine;
    this.paused = false;
    this.log.reset(msg, capacity, hz);
    this.pool = new BufferPool(layout.totalBytes);
    this.writer = new SnapshotWriter(layout);
    this.snapshotHz = hz;
    this.acc = 0;
    this.droppedSteps = 0;
    this.snapshotsSent = 0;
    this.nextSnapIndex = 1;
    this.nextSnapTick = this.snapTickFor(1);
    this.dirty = true;
    this.lastWall = this.scheduler.now();
    this.post({ type: 'ready', kernel: engine.kernel.kind });
    this.requestWake(false);
  }

  /**
   * `groundHeightfield`: regenerate the terrain from the layout (pure, same
   * code as main), hash it, install it as the ground (even on a hash
   * mismatch: the car must have ground) and answer `terrainReady`; a
   * mismatch with a non-zero main hash also posts `error`. The splat
   * weights are dropped after hashing (render-only, 8 MB). `generateMs` is
   * the whole blocking time (generate + hash + sampler build). The layout's
   * static colliders install with it (resolved against this terrain; an
   * invalid set posts `error` after terrainReady and leaves the previous
   * layout set). P5 sequence: vegetation scatter (needs the splat) →
   * heightfield → layout + vegetation colliders → water bodies → layout
   * props (resolvePropInstances, spawned asleep) → terrainReady with the
   * P5 counts; each failing stage posts its own `error` after
   * terrainReady and the rest still installs. Generation
   * blocks the worker for a while: the wall clock is re-based afterwards,
   * so that time is skipped rather than caught up (no 200-step burst).
   */
  private groundHeightfield(engine: SimEngine, msg: Extract<MainToWorker, { type: 'groundHeightfield' }>): void {
    const layout = msg.layout;
    if (!layout || typeof layout !== 'object') throw new SimCommandError('groundHeightfield: layout must be a WorldLayout');
    const expected = msg.terrainHash;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || expected > 0xffffffff) {
      throw new SimCommandError('groundHeightfield: terrainHash must be a u32 (0 = do not compare)');
    }
    const t0 = this.scheduler.now();
    const terrain = this.terrainDeps.generateTerrain(layout);
    this.layout = layout;
    const hash = this.terrainDeps.hashTerrain(terrain) >>> 0;
    const errors: string[] = [];
    // Layout v6 (R-WORLD): the generated world content (buildings, kerbs, structures, area
    // furniture; sim part only) — before the scatter, which keeps clear of it.
    const contentFn = this.terrainDeps.buildWorldContent ?? null;
    let content: WorldContent | null = null;
    if (contentFn) {
      try {
        content = contentFn(layout, terrain, { render: false });
      } catch (e) {
        errors.push(`world content not built: ${errMessage(e)}`);
      }
    }
    // P5: the vegetation scatter needs the splat weights, so it runs before they are dropped.
    const scatterFn = this.terrainDeps.scatterVegetation ?? scatterVegetation;
    let scatter: VegetationScatter | null = null;
    try {
      scatter = scatterFn(layout, terrain, content);
    } catch (e) {
      errors.push(`vegetation not scattered: ${errMessage(e)}`);
    }
    engine.setGroundTerrain({ ...terrain, splat: new Uint8Array(0), covers: undefined });
    // Layout colliders resolve against this terrain (same helper as main's meshes),
    // then the content colliders (ids w:*), then the vegetation colliders (ids veg:*), before the extra set.
    const contentColliders = content?.colliders ?? [];
    const vegColliders = scatter?.colliders ?? [];
    let vegInstalled = 0;
    let contentInstalled = 0;
    try {
      engine.setLayoutColliders([...(layout.colliders ?? []), ...contentColliders, ...vegColliders]);
      vegInstalled = vegColliders.length;
      contentInstalled = contentColliders.length;
    } catch (e) {
      try {
        engine.setLayoutColliders([...(layout.colliders ?? []), ...contentColliders]);
        contentInstalled = contentColliders.length;
        errors.push(`vegetation colliders not installed: ${errMessage(e)}`);
      } catch (e2) {
        try {
          engine.setLayoutColliders(layout.colliders ?? []);
          errors.push(`content colliders not installed: ${errMessage(e2)}`);
        } catch (e3) {
          errors.push(`layout colliders not installed: ${errMessage(e3)}`);
        }
      }
    }
    let waterBodies = 0;
    try {
      engine.setWater(resolveWater(layout, terrain));
      waterBodies = engine.water.length;
    } catch (e) {
      engine.setWater([]);
      errors.push(`water not installed: ${errMessage(e)}`);
    }
    let props = 0;
    try {
      const sampler = engine.sampler!;
      const instances = resolvePropInstances([...(layout.props ?? []), ...(content?.props ?? [])], (x, z) => sampler.heightAt(x, z));
      engine.spawnLayoutProps(instances);
      props = instances.length;
    } catch (e) {
      errors.push(`layout props not spawned: ${errMessage(e)}`);
    }
    const t1 = this.scheduler.now();
    this.lastWall = t1;
    this.dirty = true;
    this.log.setLayout(terrain.layoutId, terrain.layoutVersion, hash);
    const matched = expected !== 0 && hash === expected;
    const ready: WorkerToMain = {
      type: 'terrainReady',
      layoutId: terrain.layoutId,
      terrainHash: hash,
      matched,
      generateMs: t1 - t0,
      props,
      vegetationColliders: vegInstalled,
      waterBodies,
    };
    if (scatter) ready.vegetationHash = scatter.hash >>> 0;
    if (content) {
      ready.contentHash = content.hash >>> 0;
      ready.contentColliders = contentInstalled;
      ready.contentProps = content.props.length;
    }
    this.post(ready);
    for (const message of errors) this.post({ type: 'error', command: 'groundHeightfield', message });
    if (expected !== 0 && !matched) {
      this.post({
        type: 'error',
        command: 'groundHeightfield',
        message:
          `terrain hash mismatch for layout '${terrain.layoutId}' v${terrain.layoutVersion}: ` +
          `worker ${hex(hash)} vs main ${hex(expected)} (build skew or non-deterministic generator); worker terrain installed`,
      });
    }
  }

  private snapTickFor(index: number): number {
    return Math.ceil((index * SIM_HZ) / this.snapshotHz);
  }

  private requestWake(immediate: boolean): void {
    if (this.scheduled || this.dead) return;
    this.scheduled = true;
    this.scheduler.schedule(this.wake, immediate);
  }

  /** One pacing iteration (public for tests). */
  readonly wake = (): void => {
    this.scheduled = false;
    const engine = this.engine;
    if (this.dead || !engine) return;
    let backlog = false;
    try {
      const now = this.scheduler.now();
      let elapsed = (now - this.lastWall) / 1000;
      this.lastWall = now;
      if (!(elapsed > 0) || this.paused) elapsed = 0;
      this.acc += elapsed * this.timeScale;
      let steps = Math.floor(this.acc / SIM_DT);
      this.acc -= steps * SIM_DT;
      if (steps > MAX_STEPS_PER_WAKE) {
        this.droppedSteps += steps - MAX_STEPS_PER_WAKE;
        steps = MAX_STEPS_PER_WAKE;
        backlog = true;
      }
      const c0 = this.scheduler.now();
      this.runSteps(steps);
      this.noteLoad(this.scheduler.now() - c0, steps * SIM_DT * 1000);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.requestWake(backlog);
  };

  /** Accumulates CPU vs simulated time; the load updates every ~250 ms of sim (EMA ≈ 1 s). */
  private noteLoad(cpuMs: number, simMs: number): void {
    if (!(simMs > 0)) return;
    this.loadCpuMs += cpuMs > 0 ? cpuMs : 0;
    this.loadSimMs += simMs;
    if (this.loadSimMs >= 250) {
      const x = this.loadCpuMs / this.loadSimMs;
      this.workerLoad = this.workerLoad === 0 ? x : this.workerLoad + 0.25 * (x - this.workerLoad);
      this.loadCpuMs = 0;
      this.loadSimMs = 0;
    }
  }

  /** Steps `steps` ticks, writing the last snapshot tick crossed (if any). */
  runSteps(steps: number): void {
    const engine = this.engine;
    if (!engine) return;
    for (let i = 0; i < steps; i++) {
      engine.step();
      if (engine.tick >= this.nextSnapTick) {
        while (this.nextSnapTick <= engine.tick) this.nextSnapTick = this.snapTickFor(++this.nextSnapIndex);
        const remaining = steps - 1 - i;
        if (engine.tick + remaining < this.nextSnapTick) this.sendSnapshot();
      }
    }
    if (steps === 0 && this.dirty) this.sendSnapshot();
  }

  private sendSnapshot(): void {
    const engine = this.engine;
    const pool = this.pool;
    const writer = this.writer;
    if (!engine || !pool || !writer) return;
    const buffer = pool.acquire();
    if (buffer === null) return; // skipped; pending events carry over
    writer.attach(buffer);
    engine.writeSnapshot(writer, this.timeScale);
    writer.setWorkerLoad(this.workerLoad);
    this.dirty = false;
    this.snapshotsSent++;
    this.post({ type: 'snapshot', buffer }, [buffer]);
  }

  fail(e: unknown): void {
    if (this.dead) return;
    this.dead = true;
    const msg: WorkerToMain = { type: 'fatal', message: errMessage(e) };
    if (e instanceof Error && e.stack) msg.stack = e.stack;
    this.post(msg);
  }
}

// ------------------------------------------------------------ global install
interface WorkerScopeLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
}

function isWorkerScope(): boolean {
  const g = globalThis as { WorkerGlobalScope?: abstract new () => unknown };
  return typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope;
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as WorkerScopeLike;
  const host = new WorkerHost((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  const deliver = (msg: MainToWorker): void => {
    try {
      host.handle(msg);
    } catch (e) {
      host.fail(e);
    }
  };
  // R-CORE: the WASM solver kernel loads lazily (its own chunk); messages queue until it is installed
  // (or the JS kernel stays the default when WebAssembly / SIMD is unavailable). Bit-identical either way.
  let queue: MainToWorker[] | null = [];
  scope.addEventListener('message', (ev) => {
    const msg = (ev as MessageEvent<MainToWorker>).data;
    if (queue) queue.push(msg);
    else deliver(msg);
  });
  const ready = (): void => {
    const q = queue ?? [];
    queue = null;
    for (const m of q) deliver(m);
  };
  import('./wasm/kernel')
    .then((k) => {
      const best = k.bestWasmKernel();
      if (best) setDefaultKernel(best);
    })
    .catch(() => {})
    .finally(ready);
  scope.addEventListener('error', (ev) => {
    const e = ev as ErrorEvent;
    host.fail(e.error ?? new Error(e.message));
  });
  scope.addEventListener('unhandledrejection', (ev) => {
    host.fail((ev as PromiseRejectionEvent).reason);
  });
}
