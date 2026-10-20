/**
 * Worker-side replay log (P7): every state-changing command with the tick it
 * applied at, plus the compact per-action input log. The ReplayFile is built
 * from it on request (protocol/replay.ts). Input entries live in chunked
 * typed arrays (a chunk allocation every INPUT_CHUNK entries, never per
 * entry); commands are kept by reference (structured-cloned messages the
 * engine never mutates).
 */
import type { ActionState, InitMsg, MainToWorker, SnapshotCapacity } from '../../protocol/messages';
import { ACTION_COUNT, ACTION_NAMES } from '../../protocol/messages';
import {
  REPLAY_FILE_FORMAT,
  REPLAY_FILE_VERSION,
  REPLAY_INPUT_LOG_MAX,
  isReplayableCommand,
  type ReplayCommandEntry,
  type ReplayFile,
  type ReplayInit,
  type ReplayLayoutRef,
  type ReplayVehicleRef,
} from '../../protocol/replay';
import type { SimEngine } from '../engine';
import { hashSimState } from './hash';

const INPUT_CHUNK = 1 << 14;

export class ReplayLog {
  init: ReplayInit | null = null;
  layout: ReplayLayoutRef | null = null;
  readonly commands: ReplayCommandEntry[] = [];
  readonly vehicles: ReplayVehicleRef[] = [];
  inputCount = 0;
  truncated = false;
  private readonly tickChunks: Uint32Array[] = [];
  private readonly objChunks: Uint32Array[] = [];
  private readonly actChunks: Uint8Array[] = [];
  private readonly valChunks: Float64Array[] = [];
  private readonly before = new Float64Array(ACTION_COUNT);

  /** `init` applied: the log restarts. */
  reset(msg: InitMsg, capacity: SnapshotCapacity, snapshotHz: number): void {
    this.init = {
      seed: msg.seed,
      gravity: [msg.gravity[0], msg.gravity[1], msg.gravity[2]],
      snapshotHz,
      debugStrains: !!msg.debugStrains,
      capacity: { ...capacity },
    };
    this.layout = null;
    this.commands.length = 0;
    this.vehicles.length = 0;
    this.inputCount = 0;
    this.truncated = false;
    this.tickChunks.length = this.objChunks.length = this.actChunks.length = this.valChunks.length = 0;
  }

  /** Called right BEFORE the worker applies `msg` (logged even if it then fails: re-simulation fails the same way). */
  command(tick: number, msg: MainToWorker): void {
    if (!this.init || !isReplayableCommand(msg.type)) return;
    this.commands.push({ tick, input: this.inputCount, cmd: msg as ReplayCommandEntry['cmd'] });
    if (msg.type === 'spawnVehicle') {
      this.vehicles.push({ objectId: msg.objectId, catalogId: msg.catalogId ?? null, paint: null, spawnTick: tick });
    }
  }

  /** After a groundHeightfield installed (worker's own terrain hash). */
  setLayout(id: string, version: number, terrainHash: number): void {
    this.layout = { id, version, terrainHash: terrainHash >>> 0 };
  }

  /** Snapshot of an object's actions before an `input` applies (pair with `inputAfter`). */
  inputBefore(actions: Float64Array): void {
    this.before.set(actions.subarray(0, ACTION_COUNT));
  }

  /** Logs every action of `objectId` whose value changed since `inputBefore`. */
  inputAfter(tick: number, objectId: number, actions: Float64Array, msgActions: Partial<ActionState>): void {
    if (!this.init) return;
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (msgActions[ACTION_NAMES[i]!] === undefined) continue;
      const v = actions[i]!;
      if (Object.is(v, this.before[i]!)) continue;
      this.pushInput(tick, objectId, i, v);
    }
  }

  private pushInput(tick: number, objectId: number, action: number, value: number): void {
    if (this.inputCount >= REPLAY_INPUT_LOG_MAX) {
      this.truncated = true;
      return;
    }
    const c = this.inputCount >>> 14;
    const k = this.inputCount & (INPUT_CHUNK - 1);
    if (c >= this.tickChunks.length) {
      this.tickChunks.push(new Uint32Array(INPUT_CHUNK));
      this.objChunks.push(new Uint32Array(INPUT_CHUNK));
      this.actChunks.push(new Uint8Array(INPUT_CHUNK));
      this.valChunks.push(new Float64Array(INPUT_CHUNK));
    }
    this.tickChunks[c]![k] = tick;
    this.objChunks[c]![k] = objectId;
    this.actChunks[c]![k] = action;
    this.valChunks[c]![k] = value;
    this.inputCount++;
  }

  /** The ReplayFile of the run so far (input arrays are fresh copies: transferable). */
  build(engine: SimEngine): ReplayFile {
    if (!this.init) throw new Error('replay log: no init');
    const n = this.inputCount;
    const tick = new Uint32Array(n);
    const objectId = new Uint32Array(n);
    const action = new Uint8Array(n);
    const value = new Float64Array(n);
    for (let c = 0; c * INPUT_CHUNK < n; c++) {
      const len = Math.min(INPUT_CHUNK, n - c * INPUT_CHUNK);
      tick.set(this.tickChunks[c]!.subarray(0, len), c * INPUT_CHUNK);
      objectId.set(this.objChunks[c]!.subarray(0, len), c * INPUT_CHUNK);
      action.set(this.actChunks[c]!.subarray(0, len), c * INPUT_CHUNK);
      value.set(this.valChunks[c]!.subarray(0, len), c * INPUT_CHUNK);
    }
    return {
      format: REPLAY_FILE_FORMAT,
      version: REPLAY_FILE_VERSION,
      build: '',
      init: { ...this.init, gravity: [...this.init.gravity], capacity: { ...this.init.capacity } },
      layout: this.layout ? { ...this.layout } : null,
      vehicles: this.vehicles.map((v) => ({ ...v })),
      start: { kind: 'boot' },
      fromTick: 0,
      toTick: engine.tick,
      endStateHash: hashSimState(engine),
      commands: this.commands.slice(),
      inputs: { count: n, tick, objectId, action, value },
      truncated: this.truncated,
    };
  }
}
