/**
 * Snapshot codec + buffer pool — FROZEN API (P1).
 *
 * BUFFER POOL SEMANTICS (3 buffers, explicit ownership):
 * - The worker allocates SNAPSHOT_POOL_SIZE (3) buffers of
 *   computeSnapshotBytes(capacity…) at `init` and owns them in a BufferPool.
 * - Each snapshot tick the worker `acquire()`s a free buffer, writes it with
 *   SnapshotWriter, and posts `{type:'snapshot', buffer}` with the buffer in
 *   the transfer list (ownership moves to main; the worker's reference is
 *   detached and must be dropped).
 * - If no buffer is free, the worker SKIPS that snapshot (pool.misses++) and
 *   keeps stepping — the sim never blocks on main. Pending events carry over.
 * - Main keeps at most two buffers (previous + current, for interpolation)
 *   and returns the older one via `{type:'returnBuffer', buffer}` (transferred)
 *   as soon as a newer snapshot arrives. The worker `release()`s it.
 * - A buffer is only ever owned by one side; neither side reads a buffer it
 *   has transferred away.
 *
 * ALLOCATION: `attach()` creates a handful of typed-array views (once per
 * buffer handoff — transferred buffers arrive as new ArrayBuffer objects so
 * views cannot be cached across handoffs). Every other method is
 * allocation-free; reader subarray views are created lazily at most once per
 * attach and then cached.
 */
import {
  BEAM_BREAK_BEAM_INDEX,
  BEAM_BREAK_CAPACITY,
  BEAM_BREAK_OBJECT_ID,
  BEAM_BREAK_PX,
  BEAM_BREAK_PY,
  BEAM_BREAK_PZ,
  BEAM_BREAK_WORDS,
  EventKind,
  IMPACT_CAPACITY,
  IMPACT_IMPULSE,
  IMPACT_MATERIAL_ID,
  IMPACT_NX,
  IMPACT_NY,
  IMPACT_NZ,
  IMPACT_OBJECT_ID,
  IMPACT_PX,
  IMPACT_PY,
  IMPACT_PZ,
  IMPACT_WORDS,
  SKID_CAPACITY,
  SKID_LOAD,
  SKID_MATERIAL_ID,
  SKID_OBJECT_ID,
  SKID_PX,
  SKID_PY,
  SKID_PZ,
  SKID_SLIP,
  SKID_WORDS,
  type BeamBreakEvent,
  type ImpactEvent,
  type SkidEvent,
} from './events';
import {
  HDR_F32_TIMESCALE,
  HDR_F64_SIMTIME,
  HDR_U32_BEAM_BREAK_COUNT,
  HDR_U32_BEAM_BREAK_OVERFLOW,
  HDR_U32_BEAM_BREAKS_OFFSET,
  HDR_U32_BEAM_CAPACITY,
  HDR_U32_BEAM_TOTAL,
  HDR_U32_BROKEN_OFFSET,
  HDR_U32_FLAGS,
  HDR_U32_IMPACT_COUNT,
  HDR_U32_IMPACT_OVERFLOW,
  HDR_U32_IMPACTS_OFFSET,
  HDR_U32_MAGIC,
  HDR_U32_MAX_OBJECTS,
  HDR_U32_NODE_CAPACITY,
  HDR_U32_NODE_TOTAL,
  HDR_U32_NODES_OFFSET,
  HDR_U32_OBJECT_COUNT,
  HDR_U32_OBJECTS_OFFSET,
  HDR_U32_SKID_COUNT,
  HDR_U32_SKID_OVERFLOW,
  HDR_U32_SKIDS_OFFSET,
  HDR_U32_STRAINS_OFFSET,
  HDR_U32_TICK,
  HDR_U32_TOTAL_BYTES,
  HDR_U32_VERSION,
  HEADER_BYTES,
  NODE_STRIDE,
  OBJ_BEAM_COUNT,
  OBJ_BEAM_OFFSET,
  OBJ_FLAGS,
  OBJ_ID,
  OBJ_NODE_COUNT,
  OBJ_NODE_OFFSET,
  OBJ_RECORD_WORDS,
  OBJ_REPAIR_EPOCH,
  OBJ_RESERVED1,
  OBJ_TELEMETRY,
  SNAPSHOT_FLAG_BROKEN_BEAMS,
  SNAPSHOT_FLAG_DEBUG_STRAINS,
  SNAPSHOT_MAGIC,
  SNAPSHOT_VERSION,
  TELEMETRY_SLOTS,
  type SnapshotLayout,
} from './layout';

export const SNAPSHOT_POOL_SIZE = 3;

// ============================================================ validation
export type SnapshotCheck = 'ok' | 'too-small' | 'bad-magic' | 'bad-version' | 'bad-layout';

export class SnapshotFormatError extends Error {
  constructor(
    readonly code: Exclude<SnapshotCheck, 'ok'>,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

/** Validates magic, version and declared size. Allocates (one small view); not for hot paths. */
export function checkSnapshot(buffer: ArrayBuffer): SnapshotCheck {
  if (buffer.byteLength < HEADER_BYTES) return 'too-small';
  const u32 = new Uint32Array(buffer, 0, HEADER_BYTES >> 2);
  if (u32[HDR_U32_MAGIC] !== SNAPSHOT_MAGIC) return 'bad-magic';
  if (u32[HDR_U32_VERSION] !== SNAPSHOT_VERSION) return 'bad-version';
  const total = u32[HDR_U32_TOTAL_BYTES]!;
  if (total > buffer.byteLength || total % 8 !== 0) return 'bad-layout';
  return 'ok';
}

// ============================================================ writer
/**
 * Worker-side writer. Usage per snapshot:
 *   w.attach(buf); w.begin(tick, simTime, timeScale);
 *   for objects in ASCENDING objectId: i = w.addObject(...); w.writeNodesSoA(i, …);
 *     w.writeStrains(i, …); w.writeBrokenBeams(i, …) (P4); w.setRepairEpoch(i, n) (P4);
 *     w.setTelemetry(i, slot, v)…
 *   w.pushImpact(…)… (any time after begin; discovery order)
 */
export class SnapshotWriter {
  readonly layout: SnapshotLayout;
  private u32 = new Uint32Array(0);
  private f32 = new Float32Array(0);
  private f64 = new Float64Array(0);
  private readonly objW: number;
  private readonly impW: number;
  private readonly bbW: number;
  private readonly skW: number;
  private readonly nodeW: number;
  private readonly strainW: number;
  private readonly brokenW: number;
  private lastObjectId = -1;

  constructor(layout: SnapshotLayout) {
    this.layout = layout;
    this.objW = layout.objectsOffset >> 2;
    this.impW = layout.impactsOffset >> 2;
    this.bbW = layout.beamBreaksOffset >> 2;
    this.skW = layout.skidsOffset >> 2;
    this.nodeW = layout.nodesOffset >> 2;
    this.strainW = layout.strainsOffset >> 2;
    this.brokenW = layout.brokenOffset >> 2;
  }

  /** Binds the writer to `buffer` (creates views) and writes the static header. */
  attach(buffer: ArrayBuffer): this {
    const L = this.layout;
    if (buffer.byteLength < L.totalBytes) {
      throw new RangeError(`snapshot buffer ${buffer.byteLength} B < layout ${L.totalBytes} B`);
    }
    this.u32 = new Uint32Array(buffer, 0, L.totalBytes >> 2);
    this.f32 = new Float32Array(buffer, 0, L.totalBytes >> 2);
    this.f64 = new Float64Array(buffer, 0, HEADER_BYTES >> 3);
    const u = this.u32;
    for (let i = 0; i < HEADER_BYTES >> 2; i++) u[i] = 0;
    u[HDR_U32_MAGIC] = SNAPSHOT_MAGIC;
    u[HDR_U32_VERSION] = SNAPSHOT_VERSION;
    u[HDR_U32_FLAGS] = (L.debugStrains ? SNAPSHOT_FLAG_DEBUG_STRAINS : 0) | SNAPSHOT_FLAG_BROKEN_BEAMS;
    u[HDR_U32_OBJECTS_OFFSET] = L.objectsOffset;
    u[HDR_U32_IMPACTS_OFFSET] = L.impactsOffset;
    u[HDR_U32_BEAM_BREAKS_OFFSET] = L.beamBreaksOffset;
    u[HDR_U32_SKIDS_OFFSET] = L.skidsOffset;
    u[HDR_U32_NODES_OFFSET] = L.nodesOffset;
    u[HDR_U32_STRAINS_OFFSET] = L.strainsOffset;
    u[HDR_U32_MAX_OBJECTS] = L.maxObjects;
    u[HDR_U32_NODE_CAPACITY] = L.nodeCapacity;
    u[HDR_U32_BEAM_CAPACITY] = L.beamCapacity;
    u[HDR_U32_TOTAL_BYTES] = L.totalBytes;
    u[HDR_U32_BROKEN_OFFSET] = L.brokenOffset;
    this.lastObjectId = -1;
    return this;
  }

  /** Starts a frame: sets time fields and zeroes all counts/overflows. */
  begin(tick: number, simTime: number, timeScale: number): void {
    const u = this.u32;
    this.setTick(tick);
    this.setSimTime(simTime);
    this.setTimeScale(timeScale);
    u[HDR_U32_OBJECT_COUNT] = 0;
    u[HDR_U32_NODE_TOTAL] = 0;
    u[HDR_U32_BEAM_TOTAL] = 0;
    u[HDR_U32_IMPACT_COUNT] = 0;
    u[HDR_U32_IMPACT_OVERFLOW] = 0;
    u[HDR_U32_BEAM_BREAK_COUNT] = 0;
    u[HDR_U32_BEAM_BREAK_OVERFLOW] = 0;
    u[HDR_U32_SKID_COUNT] = 0;
    u[HDR_U32_SKID_OVERFLOW] = 0;
    this.lastObjectId = -1;
  }

  setTick(tick: number): void {
    this.u32[HDR_U32_TICK] = tick;
  }
  setSimTime(t: number): void {
    this.f64[HDR_F64_SIMTIME] = t;
  }
  setTimeScale(s: number): void {
    this.f32[HDR_F32_TIMESCALE] = s;
  }

  /**
   * Appends an object record (ids must be strictly ascending) and reserves
   * its node/beam ranges. Telemetry, the repair epoch and the object's
   * broken-beam bits are zeroed. Returns the object index.
   * Capacity overruns are programming errors and throw.
   */
  addObject(objectId: number, flags: number, nodeCount: number, beamCount: number): number {
    const u = this.u32;
    const L = this.layout;
    const index = u[HDR_U32_OBJECT_COUNT]!;
    const nodeOffset = u[HDR_U32_NODE_TOTAL]!;
    const beamOffset = u[HDR_U32_BEAM_TOTAL]!;
    if (objectId <= this.lastObjectId) throw new RangeError(`objectId ${objectId} not ascending`);
    if (index >= L.maxObjects) throw new RangeError('snapshot maxObjects exceeded');
    if (nodeOffset + nodeCount > L.nodeCapacity) throw new RangeError('snapshot nodeCapacity exceeded');
    if (beamOffset + beamCount > L.beamCapacity) throw new RangeError('snapshot beamCapacity exceeded');
    this.lastObjectId = objectId;
    const r = this.objW + index * OBJ_RECORD_WORDS;
    u[r + OBJ_ID] = objectId;
    u[r + OBJ_FLAGS] = flags;
    u[r + OBJ_NODE_OFFSET] = nodeOffset;
    u[r + OBJ_NODE_COUNT] = nodeCount;
    u[r + OBJ_BEAM_OFFSET] = beamOffset;
    u[r + OBJ_BEAM_COUNT] = beamCount;
    u[r + OBJ_REPAIR_EPOCH] = 0;
    u[r + OBJ_RESERVED1] = 0;
    this.clearBrokenRange(beamOffset, beamCount);
    const f = this.f32;
    const t = r + OBJ_TELEMETRY;
    for (let s = 0; s < TELEMETRY_SLOTS; s++) f[t + s] = 0;
    u[HDR_U32_OBJECT_COUNT] = index + 1;
    u[HDR_U32_NODE_TOTAL] = nodeOffset + nodeCount;
    u[HDR_U32_BEAM_TOTAL] = beamOffset + beamCount;
    return index;
  }

  setObjectFlags(objectIndex: number, flags: number): void {
    this.u32[this.objW + objectIndex * OBJ_RECORD_WORDS + OBJ_FLAGS] = flags;
  }

  /** P4: the object's repair epoch (0 at spawn, +1 per `reset`; see OBJ_REPAIR_EPOCH). */
  setRepairEpoch(objectIndex: number, epoch: number): void {
    this.u32[this.objW + objectIndex * OBJ_RECORD_WORDS + OBJ_REPAIR_EPOCH] = epoch;
  }

  private clearBrokenRange(first: number, count: number): void {
    const u = this.u32;
    const end = first + count;
    let g = first;
    // Partial leading word, whole words, partial trailing word.
    while (g < end && (g & 31) !== 0) {
      u[this.brokenW + (g >>> 5)]! &= ~(1 << (g & 31));
      g++;
    }
    while (g + 32 <= end) {
      u[this.brokenW + (g >>> 5)] = 0;
      g += 32;
    }
    while (g < end) {
      u[this.brokenW + (g >>> 5)]! &= ~(1 << (g & 31));
      g++;
    }
  }

  /**
   * P4: packs object `objectIndex`'s broken flags from the sim's per-beam
   * `active` array (1 = intact, 0 = broken) starting at `srcStart` into the
   * broken-beam bitset. Writes every bit of the object's range.
   */
  writeBrokenBeams(objectIndex: number, active: Uint8Array, srcStart: number): void {
    const rec = this.objW + objectIndex * OBJ_RECORD_WORDS;
    const n = this.u32[rec + OBJ_BEAM_COUNT]!;
    const off = this.u32[rec + OBJ_BEAM_OFFSET]!;
    this.clearBrokenRange(off, n);
    const u = this.u32;
    const w = this.brokenW;
    for (let i = 0; i < n; i++) {
      if (active[srcStart + i] === 0) {
        const g = off + i;
        u[w + (g >>> 5)]! |= 1 << (g & 31);
      }
    }
  }

  /** P4: sets one broken bit by GLOBAL snapshot beam index. */
  setBeamBroken(globalBeamIndex: number, broken: boolean): void {
    const i = this.brokenW + (globalBeamIndex >>> 5);
    const bit = 1 << (globalBeamIndex & 31);
    if (broken) this.u32[i]! |= bit;
    else this.u32[i]! &= ~bit;
  }

  /** Copies object `objectIndex`'s nodes from f64 SoA arrays starting at `srcStart` (f64→f32). */
  writeNodesSoA(
    objectIndex: number,
    posX: Float64Array,
    posY: Float64Array,
    posZ: Float64Array,
    srcStart: number,
  ): void {
    const rec = this.objW + objectIndex * OBJ_RECORD_WORDS;
    const n = this.u32[rec + OBJ_NODE_COUNT]!;
    const f = this.f32;
    let w = this.nodeW + this.u32[rec + OBJ_NODE_OFFSET]! * NODE_STRIDE;
    for (let i = 0; i < n; i++) {
      const s = srcStart + i;
      f[w] = posX[s]!;
      f[w + 1] = posY[s]!;
      f[w + 2] = posZ[s]!;
      w += 3;
    }
  }

  /** Sets one node by GLOBAL snapshot node index. */
  setNode(globalIndex: number, x: number, y: number, z: number): void {
    const w = this.nodeW + globalIndex * NODE_STRIDE;
    const f = this.f32;
    f[w] = x;
    f[w + 1] = y;
    f[w + 2] = z;
  }

  /** Copies object `objectIndex`'s strains from `src[srcStart..]`. No-op without debugStrains. */
  writeStrains(objectIndex: number, src: Float32Array, srcStart: number): void {
    if (!this.layout.debugStrains) return;
    const rec = this.objW + objectIndex * OBJ_RECORD_WORDS;
    const n = this.u32[rec + OBJ_BEAM_COUNT]!;
    const f = this.f32;
    const w = this.strainW + this.u32[rec + OBJ_BEAM_OFFSET]!;
    for (let i = 0; i < n; i++) f[w + i] = src[srcStart + i]!;
  }

  /** Sets one strain by GLOBAL snapshot beam index. No-op without debugStrains. */
  setStrain(globalBeamIndex: number, strain: number): void {
    if (!this.layout.debugStrains) return;
    this.f32[this.strainW + globalBeamIndex] = strain;
  }

  setTelemetry(objectIndex: number, slot: number, value: number): void {
    this.f32[this.objW + objectIndex * OBJ_RECORD_WORDS + OBJ_TELEMETRY + slot] = value;
  }

  /** Returns false (and counts overflow) when the impact section is full. */
  pushImpact(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    impulse: number,
  ): boolean {
    const u = this.u32;
    const i = u[HDR_U32_IMPACT_COUNT]!;
    if (i >= IMPACT_CAPACITY) {
      u[HDR_U32_IMPACT_OVERFLOW]!++;
      return false;
    }
    const w = this.impW + i * IMPACT_WORDS;
    const f = this.f32;
    u[w + IMPACT_OBJECT_ID] = objectId;
    u[w + IMPACT_MATERIAL_ID] = materialId;
    f[w + IMPACT_PX] = px;
    f[w + IMPACT_PY] = py;
    f[w + IMPACT_PZ] = pz;
    f[w + IMPACT_NX] = nx;
    f[w + IMPACT_NY] = ny;
    f[w + IMPACT_NZ] = nz;
    f[w + IMPACT_IMPULSE] = impulse;
    u[HDR_U32_IMPACT_COUNT] = i + 1;
    return true;
  }

  /** beamIndex is OBJECT-LOCAL. Returns false (and counts overflow) when full. */
  pushBeamBreak(objectId: number, beamIndex: number, px: number, py: number, pz: number): boolean {
    const u = this.u32;
    const i = u[HDR_U32_BEAM_BREAK_COUNT]!;
    if (i >= BEAM_BREAK_CAPACITY) {
      u[HDR_U32_BEAM_BREAK_OVERFLOW]!++;
      return false;
    }
    const w = this.bbW + i * BEAM_BREAK_WORDS;
    const f = this.f32;
    u[w + BEAM_BREAK_OBJECT_ID] = objectId;
    u[w + BEAM_BREAK_BEAM_INDEX] = beamIndex;
    f[w + BEAM_BREAK_PX] = px;
    f[w + BEAM_BREAK_PY] = py;
    f[w + BEAM_BREAK_PZ] = pz;
    u[HDR_U32_BEAM_BREAK_COUNT] = i + 1;
    return true;
  }

  /** Returns false (and counts overflow) when the skid section is full. */
  pushSkid(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    slip: number,
    load: number,
  ): boolean {
    const u = this.u32;
    const i = u[HDR_U32_SKID_COUNT]!;
    if (i >= SKID_CAPACITY) {
      u[HDR_U32_SKID_OVERFLOW]!++;
      return false;
    }
    const w = this.skW + i * SKID_WORDS;
    const f = this.f32;
    u[w + SKID_OBJECT_ID] = objectId;
    u[w + SKID_MATERIAL_ID] = materialId;
    f[w + SKID_PX] = px;
    f[w + SKID_PY] = py;
    f[w + SKID_PZ] = pz;
    f[w + SKID_SLIP] = slip;
    f[w + SKID_LOAD] = load;
    u[HDR_U32_SKID_COUNT] = i + 1;
    return true;
  }

  /** Adds drops that happened upstream (e.g. in the worker's pending-event queue). */
  addOverflow(kind: EventKind, n: number): void {
    const idx =
      kind === EventKind.impact
        ? HDR_U32_IMPACT_OVERFLOW
        : kind === EventKind.beamBreak
          ? HDR_U32_BEAM_BREAK_OVERFLOW
          : HDR_U32_SKID_OVERFLOW;
    this.u32[idx] = this.u32[idx]! + n;
  }
}

// ============================================================ reader
type Vec3Out = { [i: number]: number };

/** Main-side reader. attach() validates (throws SnapshotFormatError) and binds. */
export class SnapshotReader {
  private u32 = new Uint32Array(0);
  private f32 = new Float32Array(0);
  private f64 = new Float64Array(0);
  private objW = 0;
  private impW = 0;
  private bbW = 0;
  private skW = 0;
  private nodeW = 0;
  private strainW = 0;
  private brokenW = 0;
  private _hasBroken = false;
  private _objectCount = 0;
  private _nodeTotal = 0;
  private _beamTotal = 0;
  private _hasStrains = false;
  private nodesView: Float32Array | null = null;
  private strainsView: Float32Array | null = null;
  private objNodes: (Float32Array | null)[] = [];
  private objStrains: (Float32Array | null)[] = [];
  private objTelemetry: (Float32Array | null)[] = [];

  attach(buffer: ArrayBuffer): this {
    const check = checkSnapshot(buffer);
    if (check !== 'ok') throw new SnapshotFormatError(check, `invalid snapshot: ${check}`);
    const hdr = new Uint32Array(buffer, 0, HEADER_BYTES >> 2);
    const total = hdr[HDR_U32_TOTAL_BYTES]!;
    this.u32 = new Uint32Array(buffer, 0, total >> 2);
    this.f32 = new Float32Array(buffer, 0, total >> 2);
    this.f64 = new Float64Array(buffer, 0, HEADER_BYTES >> 3);
    const u = this.u32;
    this.objW = u[HDR_U32_OBJECTS_OFFSET]! >> 2;
    this.impW = u[HDR_U32_IMPACTS_OFFSET]! >> 2;
    this.bbW = u[HDR_U32_BEAM_BREAKS_OFFSET]! >> 2;
    this.skW = u[HDR_U32_SKIDS_OFFSET]! >> 2;
    this.nodeW = u[HDR_U32_NODES_OFFSET]! >> 2;
    this.strainW = u[HDR_U32_STRAINS_OFFSET]! >> 2;
    this._objectCount = u[HDR_U32_OBJECT_COUNT]!;
    this._nodeTotal = u[HDR_U32_NODE_TOTAL]!;
    this._beamTotal = u[HDR_U32_BEAM_TOTAL]!;
    this._hasStrains =
      (u[HDR_U32_FLAGS]! & SNAPSHOT_FLAG_DEBUG_STRAINS) !== 0 && u[HDR_U32_STRAINS_OFFSET]! !== 0;
    this.brokenW = u[HDR_U32_BROKEN_OFFSET]! >> 2;
    this._hasBroken = (u[HDR_U32_FLAGS]! & SNAPSHOT_FLAG_BROKEN_BEAMS) !== 0 && this.brokenW !== 0;
    this.nodesView = null;
    this.strainsView = null;
    const n = this._objectCount;
    for (const cache of [this.objNodes, this.objStrains, this.objTelemetry]) {
      for (let i = 0; i < n; i++) cache[i] = null;
    }
    return this;
  }

  // ---------------- header
  get tick(): number {
    return this.u32[HDR_U32_TICK]!;
  }
  get simTime(): number {
    return this.f64[HDR_F64_SIMTIME]!;
  }
  get timeScale(): number {
    return this.f32[HDR_F32_TIMESCALE]!;
  }
  get flags(): number {
    return this.u32[HDR_U32_FLAGS]!;
  }
  get objectCount(): number {
    return this._objectCount;
  }
  get nodeTotal(): number {
    return this._nodeTotal;
  }
  get beamTotal(): number {
    return this._beamTotal;
  }
  get hasStrains(): boolean {
    return this._hasStrains;
  }
  /** P4: the broken-beam bitset section is present (false for pre-P4 writers). */
  get hasBrokenBeams(): boolean {
    return this._hasBroken;
  }
  get maxObjects(): number {
    return this.u32[HDR_U32_MAX_OBJECTS]!;
  }
  get nodeCapacity(): number {
    return this.u32[HDR_U32_NODE_CAPACITY]!;
  }
  get beamCapacity(): number {
    return this.u32[HDR_U32_BEAM_CAPACITY]!;
  }
  get impactCount(): number {
    return this.u32[HDR_U32_IMPACT_COUNT]!;
  }
  get impactOverflow(): number {
    return this.u32[HDR_U32_IMPACT_OVERFLOW]!;
  }
  get beamBreakCount(): number {
    return this.u32[HDR_U32_BEAM_BREAK_COUNT]!;
  }
  get beamBreakOverflow(): number {
    return this.u32[HDR_U32_BEAM_BREAK_OVERFLOW]!;
  }
  get skidCount(): number {
    return this.u32[HDR_U32_SKID_COUNT]!;
  }
  get skidOverflow(): number {
    return this.u32[HDR_U32_SKID_OVERFLOW]!;
  }

  // ---------------- objects
  private rec(i: number): number {
    return this.objW + i * OBJ_RECORD_WORDS;
  }
  objectId(i: number): number {
    return this.u32[this.rec(i) + OBJ_ID]!;
  }
  objectFlags(i: number): number {
    return this.u32[this.rec(i) + OBJ_FLAGS]!;
  }
  objectNodeOffset(i: number): number {
    return this.u32[this.rec(i) + OBJ_NODE_OFFSET]!;
  }
  objectNodeCount(i: number): number {
    return this.u32[this.rec(i) + OBJ_NODE_COUNT]!;
  }
  objectBeamOffset(i: number): number {
    return this.u32[this.rec(i) + OBJ_BEAM_OFFSET]!;
  }
  objectBeamCount(i: number): number {
    return this.u32[this.rec(i) + OBJ_BEAM_COUNT]!;
  }
  telemetry(i: number, slot: number): number {
    return this.f32[this.rec(i) + OBJ_TELEMETRY + slot]!;
  }
  /** P4: object i's repair epoch (OBJ_REPAIR_EPOCH; 0 from pre-P4 writers). */
  objectRepairEpoch(i: number): number {
    return this.u32[this.rec(i) + OBJ_REPAIR_EPOCH]!;
  }
  /** P4: GLOBAL snapshot beam `g` is broken (false when the section is absent). */
  isBeamBroken(globalBeamIndex: number): boolean {
    if (!this._hasBroken) return false;
    return ((this.u32[this.brokenW + (globalBeamIndex >>> 5)]! >>> (globalBeamIndex & 31)) & 1) === 1;
  }
  /**
   * P4: writes object i's broken flags (object-local beam order, 1 = broken,
   * 0 = intact) into out[0..beamCount). Returns the number of broken beams.
   * All zeros when the section is absent. Allocation-free.
   */
  readObjectBroken(i: number, out: Uint8Array): number {
    const n = this.objectBeamCount(i);
    if (out.length < n) throw new RangeError(`readObjectBroken: out holds ${out.length}, need ${n}`);
    if (!this._hasBroken) {
      out.fill(0, 0, n);
      return 0;
    }
    const off = this.objectBeamOffset(i);
    const u = this.u32;
    const w = this.brokenW;
    let broken = 0;
    for (let k = 0; k < n; k++) {
      const g = off + k;
      const b = (u[w + (g >>> 5)]! >>> (g & 31)) & 1;
      out[k] = b;
      broken += b;
    }
    return broken;
  }
  /** Object index for `objectId` (binary search; ids are ascending), or -1. */
  findObject(objectId: number): number {
    let lo = 0;
    let hi = this._objectCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const id = this.objectId(mid);
      if (id === objectId) return mid;
      if (id < objectId) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Lazy cached view: object i's TELEMETRY_SLOTS f32. */
  objectTelemetry(i: number): Float32Array {
    let v = this.objTelemetry[i];
    if (!v) {
      const s = this.rec(i) + OBJ_TELEMETRY;
      v = this.objTelemetry[i] = this.f32.subarray(s, s + TELEMETRY_SLOTS);
    }
    return v;
  }

  // ---------------- nodes / strains
  /** Lazy cached view: all node positions, xyz interleaved, nodeTotal*3 f32. */
  get nodes(): Float32Array {
    return (this.nodesView ??= this.f32.subarray(this.nodeW, this.nodeW + this._nodeTotal * NODE_STRIDE));
  }
  /** Lazy cached view: object i's node positions (xyz interleaved). */
  objectNodes(i: number): Float32Array {
    let v = this.objNodes[i];
    if (!v) {
      const s = this.nodeW + this.objectNodeOffset(i) * NODE_STRIDE;
      v = this.objNodes[i] = this.f32.subarray(s, s + this.objectNodeCount(i) * NODE_STRIDE);
    }
    return v;
  }
  /** Lazy cached view: all beam strains, or null when the section is absent. */
  get strains(): Float32Array | null {
    if (!this._hasStrains) return null;
    return (this.strainsView ??= this.f32.subarray(this.strainW, this.strainW + this._beamTotal));
  }
  /** Lazy cached view: object i's strains (object-local beam order), or null. */
  objectStrains(i: number): Float32Array | null {
    if (!this._hasStrains) return null;
    let v = this.objStrains[i];
    if (!v) {
      const s = this.strainW + this.objectBeamOffset(i);
      v = this.objStrains[i] = this.f32.subarray(s, s + this.objectBeamCount(i));
    }
    return v;
  }

  // ---------------- impacts
  impactObjectId(i: number): number {
    return this.u32[this.impW + i * IMPACT_WORDS + IMPACT_OBJECT_ID]!;
  }
  impactMaterialId(i: number): number {
    return this.u32[this.impW + i * IMPACT_WORDS + IMPACT_MATERIAL_ID]!;
  }
  impactPos(i: number, out: Vec3Out, o = 0): void {
    const w = this.impW + i * IMPACT_WORDS;
    out[o] = this.f32[w + IMPACT_PX]!;
    out[o + 1] = this.f32[w + IMPACT_PY]!;
    out[o + 2] = this.f32[w + IMPACT_PZ]!;
  }
  impactNormal(i: number, out: Vec3Out, o = 0): void {
    const w = this.impW + i * IMPACT_WORDS;
    out[o] = this.f32[w + IMPACT_NX]!;
    out[o + 1] = this.f32[w + IMPACT_NY]!;
    out[o + 2] = this.f32[w + IMPACT_NZ]!;
  }
  impactImpulse(i: number): number {
    return this.f32[this.impW + i * IMPACT_WORDS + IMPACT_IMPULSE]!;
  }
  readImpact(i: number, out: ImpactEvent): ImpactEvent {
    const w = this.impW + i * IMPACT_WORDS;
    const f = this.f32;
    out.objectId = this.u32[w + IMPACT_OBJECT_ID]!;
    out.materialId = this.u32[w + IMPACT_MATERIAL_ID]!;
    out.px = f[w + IMPACT_PX]!;
    out.py = f[w + IMPACT_PY]!;
    out.pz = f[w + IMPACT_PZ]!;
    out.nx = f[w + IMPACT_NX]!;
    out.ny = f[w + IMPACT_NY]!;
    out.nz = f[w + IMPACT_NZ]!;
    out.impulse = f[w + IMPACT_IMPULSE]!;
    return out;
  }

  // ---------------- beam breaks
  beamBreakObjectId(i: number): number {
    return this.u32[this.bbW + i * BEAM_BREAK_WORDS + BEAM_BREAK_OBJECT_ID]!;
  }
  beamBreakBeamIndex(i: number): number {
    return this.u32[this.bbW + i * BEAM_BREAK_WORDS + BEAM_BREAK_BEAM_INDEX]!;
  }
  beamBreakPos(i: number, out: Vec3Out, o = 0): void {
    const w = this.bbW + i * BEAM_BREAK_WORDS;
    out[o] = this.f32[w + BEAM_BREAK_PX]!;
    out[o + 1] = this.f32[w + BEAM_BREAK_PY]!;
    out[o + 2] = this.f32[w + BEAM_BREAK_PZ]!;
  }
  readBeamBreak(i: number, out: BeamBreakEvent): BeamBreakEvent {
    const w = this.bbW + i * BEAM_BREAK_WORDS;
    const f = this.f32;
    out.objectId = this.u32[w + BEAM_BREAK_OBJECT_ID]!;
    out.beamIndex = this.u32[w + BEAM_BREAK_BEAM_INDEX]!;
    out.px = f[w + BEAM_BREAK_PX]!;
    out.py = f[w + BEAM_BREAK_PY]!;
    out.pz = f[w + BEAM_BREAK_PZ]!;
    return out;
  }

  // ---------------- skids
  skidObjectId(i: number): number {
    return this.u32[this.skW + i * SKID_WORDS + SKID_OBJECT_ID]!;
  }
  skidMaterialId(i: number): number {
    return this.u32[this.skW + i * SKID_WORDS + SKID_MATERIAL_ID]!;
  }
  skidPos(i: number, out: Vec3Out, o = 0): void {
    const w = this.skW + i * SKID_WORDS;
    out[o] = this.f32[w + SKID_PX]!;
    out[o + 1] = this.f32[w + SKID_PY]!;
    out[o + 2] = this.f32[w + SKID_PZ]!;
  }
  skidSlip(i: number): number {
    return this.f32[this.skW + i * SKID_WORDS + SKID_SLIP]!;
  }
  skidLoad(i: number): number {
    return this.f32[this.skW + i * SKID_WORDS + SKID_LOAD]!;
  }
  readSkid(i: number, out: SkidEvent): SkidEvent {
    const w = this.skW + i * SKID_WORDS;
    const f = this.f32;
    out.objectId = this.u32[w + SKID_OBJECT_ID]!;
    out.materialId = this.u32[w + SKID_MATERIAL_ID]!;
    out.px = f[w + SKID_PX]!;
    out.py = f[w + SKID_PY]!;
    out.pz = f[w + SKID_PZ]!;
    out.slip = f[w + SKID_SLIP]!;
    out.load = f[w + SKID_LOAD]!;
    return out;
  }
}

// ============================================================ pool
/**
 * Free-list of equally sized snapshot buffers (worker side; see the pool
 * semantics at the top of this file). Pure — importable on both sides.
 * Never grows beyond the buffers it was given, so it does not allocate after
 * construction.
 */
export class BufferPool {
  readonly byteLength: number;
  /** Number of acquire() calls that found no free buffer (= skipped snapshots). */
  misses = 0;
  private readonly free: ArrayBuffer[] = [];
  private readonly capacity: number;

  constructor(byteLength: number, count: number = SNAPSHOT_POOL_SIZE) {
    this.byteLength = byteLength;
    this.capacity = count;
    for (let i = 0; i < count; i++) this.free.push(new ArrayBuffer(byteLength));
  }

  /** Free buffers currently owned by the pool. */
  get available(): number {
    return this.free.length;
  }
  /** Total buffers in circulation (owned here or lent out). */
  get size(): number {
    return this.capacity;
  }

  /** Takes a free buffer, or returns null (and counts a miss) — never blocks. */
  acquire(): ArrayBuffer | null {
    const b = this.free.pop();
    if (b === undefined) {
      this.misses++;
      return null;
    }
    return b;
  }

  /** Gives a buffer back (e.g. from a `returnBuffer` message). Rejects foreign/detached/duplicate buffers. */
  release(buffer: ArrayBuffer): void {
    if (buffer.byteLength !== this.byteLength) {
      throw new RangeError(
        `BufferPool.release: ${buffer.byteLength} B buffer does not belong to this pool (${this.byteLength} B)` +
          (buffer.byteLength === 0 ? ' — detached?' : ''),
      );
    }
    if (this.free.length >= this.capacity || this.free.includes(buffer)) {
      throw new Error('BufferPool.release: buffer already in pool');
    }
    this.free.push(buffer);
  }
}
