/**
 * The live replay buffer (P7, R1): recorder + codec + ring. Pure (no three,
 * no DOM): node tests drive it with real snapshot buffers.
 *
 * STORAGE. Frames are variable-length records appended to a ring of
 * REPLAY_CHUNK_BYTES chunks (allocated lazily up to the budget, then reused:
 * zero steady-state allocation). A frame never straddles chunks. A frame
 * index ring (SoA typed arrays) maps sequence numbers → (chunk, offset,
 * length, time, tick, keyframe). Eviction drops whole keyframe GROUPS from
 * the head (oldest), so a REPEAT reference (below) never dangles.
 *
 * FRAME RECORD (byte offsets from the 8-aligned frame start; u32 words
 * unless noted):
 *   0 flags (bit0 keyframe)   1 byteLength   2 tick   3 objectCount
 *   4–5 simTime f64           6 timeScale f32 7 seq
 *   8 impacts  9 beamBreaks  10 skids  11 traffic records
 *   12 events (byte offset of the first event word)
 *   13 frame flags (FRAME_BODY_HIT)  14–15 reserved
 *   16… object table, OBJ_W words per object (ascending id):
 *     id, flags (sim flags & 0xffff | REC_* bits), nodeCount, beamCount,
 *     epoch, nodes (byte offset in this frame, or SOURCE SEQ when REPEAT),
 *     telemetry (byte offset, 0 = none), broken (byte offset, 0 = none),
 *     strains (byte offset, 0 = none: i8 per beam = round(strain·127),
 *     −128 = broken / NaN; only while `recordStrains`)
 *   then per object data, 4-aligned: nodes = min xyz f32, scale xyz f32,
 *     u16 × 3n (q = round((x − min)/scale), x' = min + q·scale);
 *     telemetry = 32 f32 + 16 f32 R-PHYS ext telemetry (zeros when the snapshot had none);
 *     broken = ⌈beamCount/32⌉ u32, OBJECT-LOCAL bits
 *   then events in protocol word layout: impacts (9 words), beam breaks
 *   (5), skids (7), traffic records (16).
 * REPEAT: a sleeping object unchanged since the previous recorded frame
 * (same epoch / node count, still asleep) stores no nodes / broken bits and
 * points at the frame that holds them (≥ the group's keyframe).
 */
import {
  BEAM_BREAK_WORDS,
  IMPACT_WORDS,
  SKID_WORDS,
  createBeamBreakEvent,
  createImpactEvent,
  createSkidEvent,
} from '../../protocol/events';
import type { SnapshotReader, SnapshotWriter } from '../../protocol/codec';
import { NODE_STRIDE, OBJECT_FLAG_SLEEPING, TELEMETRY_SLOTS, VEHICLE_EXT_SLOTS } from '../../protocol/layout';
import { PROP_LAYOUT_ID_BASE } from '../../protocol/messages';
import { VehicleTelemetry } from '../../protocol/telemetry';
import { isTrafficObjectId } from '../../protocol/traffic';
import {
  TRAFFIC_FLAG_TELEPORTED,
  TRAFFIC_MAX_AGENTS,
  TRAFFIC_RECORD_WORDS,
  TR_AGENT,
  TR_BRAKE,
  TR_FLAGS,
  TR_LOOK,
  TR_OBJECT_ID,
  TR_PATH,
  TR_POS,
  TR_QUAT,
  TR_SPEED,
  TR_STATE,
  TR_STEER,
  createTrafficAgentFrame,
} from '../../protocol/traffic';
import {
  REPLAY_CHUNK_BYTES,
  REPLAY_MARKER_MERGE_S,
  REPLAY_MARKER_MIN_SEVERITY,
  type ReplayBufferConfig,
  type ReplayMarker,
} from './types';

const HDR_WORDS = 16;
const OBJ_W = 9;
const O_ID = 0;
const O_FLAGS = 1;
const O_NODES = 2;
const O_BEAMS = 3;
const O_EPOCH = 4;
const O_DATA = 5;
const O_TEL = 6;
const O_BROKEN = 7;
const O_STRAIN = 8;
const REC_REPEAT = 1 << 16;
/** Frame flag: a non-tyre impact ≥ BODY_HIT_IMPULSE on a vehicle (replay settles replay these frames' damage). */
export const FRAME_BODY_HIT = 1;
/** Frame flag: an impact (≥ 1 N·s) or beam break on a prop. */
export const FRAME_PROP_HIT = 2;
const BODY_HIT_IMPULSE = 3;
const SIM_FLAGS_MASK = 0xffff;
const Q = 65535;
/** objectIds below this can be stored by reference while asleep (all protocol ranges fit). */
const ID_SPACE = 16384;
const STAGE_FACTOR = 4;
const IMPACT_STAGE = 256 * STAGE_FACTOR;
const BREAK_STAGE = 256 * STAGE_FACTOR;
const SKID_STAGE = 512 * STAGE_FACTOR;

/** Wheel hubs of a vehicle (tyre-contact exclusion for markers): interleaved hubI, hubO object-local node pairs + tyre radius. */
export interface WheelHubs {
  hubs: Int32Array;
  radius: number;
}

interface Chunk {
  u8: Uint8Array;
  i8: Int8Array;
  u16: Uint16Array;
  u32: Uint32Array;
  f32: Float32Array;
  f64: Float64Array;
}

function makeChunk(bytes: number): Chunk {
  const b = new ArrayBuffer(bytes);
  return { u8: new Uint8Array(b), i8: new Int8Array(b), u16: new Uint16Array(b), u32: new Uint32Array(b), f32: new Float32Array(b), f64: new Float64Array(b) };
}

interface MutableMarker {
  id: number;
  time: number;
  tick: number;
  objectId: number;
  kind: 'impact' | 'break';
  severity: number;
  impulse: number;
  breaks: number;
  pos: [number, number, number];
  /** Last frame time that fed it (merge window). */
  last: number;
}

export class ReplayBuffer {
  readonly config: Readonly<ReplayBufferConfig>;
  readonly maxChunks: number;
  readonly capFrames: number;
  /** Minimum tick spacing between recorded frames (2000 / recordHz, floored). */
  readonly intervalTicks: number;

  // ---- frame index ring
  private readonly fChunk: Int32Array;
  private readonly fOff: Int32Array;
  private readonly fLen: Int32Array;
  private readonly fTime: Float64Array;
  private readonly fTick: Uint32Array;
  private readonly fKey: Uint8Array;
  private headIdx = 0;
  private headSeq = 0;
  private _count = 0;
  private nextSeq = 0;
  private lastKeySeq = -1;
  private _bytes = 0;
  private _keyframes = 0;
  evicted = 0;

  // ---- chunk ring
  private readonly chunks: Chunk[] = [];
  private writeChunk = -1;
  private writeOff = 0;

  // ---- per objectId history (REPEAT decisions)
  private readonly seenSeq = new Int32Array(ID_SPACE).fill(-1);
  private readonly dataSeq = new Int32Array(ID_SPACE).fill(-1);
  private readonly lastEpoch = new Uint32Array(ID_SPACE);
  private readonly lastNodes = new Uint32Array(ID_SPACE);
  private readonly lastSleep = new Uint8Array(ID_SPACE);

  // ---- per-record scratch (grown when the object count grows)
  private sRepeat = new Uint8Array(64);
  private sTel = new Uint8Array(64);
  private sBroken = new Int32Array(64);
  private brokenScratch = new Uint32Array(256);

  // ---- staged events (aggregated across decimated snapshots)
  private readonly impStage = new Float32Array(IMPACT_STAGE * IMPACT_WORDS);
  private readonly impStageU = new Uint32Array(this.impStage.buffer);
  /** 1 = tyre contact (classified against the snapshot that carried the event). */
  private readonly impTyre = new Uint8Array(IMPACT_STAGE);
  private impN = 0;
  private lastStageTime = Number.NaN;
  private readonly brkStage = new Float32Array(BREAK_STAGE * BEAM_BREAK_WORDS);
  private readonly brkStageU = new Uint32Array(this.brkStage.buffer);
  private brkN = 0;
  private readonly skStage = new Float32Array(SKID_STAGE * SKID_WORDS);
  private readonly skStageU = new Uint32Array(this.skStage.buffer);
  private skN = 0;
  /** Events dropped by the staging caps since boot. */
  stagedDropped = 0;
  private readonly teleported = new Uint8Array(TRAFFIC_MAX_AGENTS);
  private lastRecTick = -1;

  private readonly impRec = createImpactEvent();
  private readonly brkRec = createBeamBreakEvent();
  private readonly skRec = createSkidEvent();
  private readonly trRec = createTrafficAgentFrame();

  /** Record the debug strain section too (i8 per beam) while true (main: the beam view is shown). */
  recordStrains = false;
  /** Frames with a recorded strain section are held (decode writes strains). */
  hasStrainFrames = false;
  /**
   * Time-window eviction never drops a frame newer than this tick (the
   * replay's damage checkpoints must cover every evicted frame); space /
   * index pressure ignores it. Infinity = no limit.
   */
  evictLimitTick = Infinity;
  /** Tick of the newest evicted frame (−1 = none). */
  lastEvictedTick = -1;

  // ---- capacities of the recorded snapshots (synthetic layout)
  maxObjects = 0;
  nodeCapacity = 0;
  beamCapacity = 0;

  // ---- markers
  private readonly markerPool: MutableMarker[] = [];
  private readonly markerList: MutableMarker[] = [];
  private nextMarkerId = 1;
  private readonly impulseBy = new Float64Array(ID_SPACE);
  private readonly touched = new Int32Array(1024);
  private readonly lastDamage = new Float32Array(ID_SPACE).fill(Number.NaN);
  /** Tyre-contact classification for markers (main supplies per vehicle; null = count every impact). */
  wheelsOf: ((objectId: number) => WheelHubs | null) | null = null;
  /** Called when a marker is created or grows. */
  onMarker: ((m: ReplayMarker) => void) | null = null;

  constructor(config: ReplayBufferConfig) {
    this.config = { ...config };
    this.maxChunks = Math.max(2, Math.floor(config.budgetBytes / REPLAY_CHUNK_BYTES));
    this.capFrames = Math.ceil(config.seconds * config.recordHz * 1.25) + 2 * config.keyframeEvery + 8;
    this.intervalTicks = Math.max(1, Math.floor(2000 / config.recordHz));
    const n = this.capFrames;
    this.fChunk = new Int32Array(n);
    this.fOff = new Int32Array(n);
    this.fLen = new Int32Array(n);
    this.fTime = new Float64Array(n);
    this.fTick = new Uint32Array(n);
    this.fKey = new Uint8Array(n);
  }

  // ------------------------------------------------------------ queries
  get count(): number {
    return this._count;
  }
  get bytes(): number {
    return this._bytes;
  }
  get keyframes(): number {
    return this._keyframes;
  }
  get allocatedBytes(): number {
    return this.chunks.length * REPLAY_CHUNK_BYTES;
  }
  get startTime(): number {
    return this._count > 0 ? this.fTime[this.headIdx]! : 0;
  }
  get endTime(): number {
    return this._count > 0 ? this.fTime[this.ringIndex(this._count - 1)]! : 0;
  }
  /** Ring slot of the i-th held frame (0 = oldest). */
  private ringIndex(i: number): number {
    const j = this.headIdx + i;
    return j >= this.capFrames ? j - this.capFrames : j;
  }
  frameTime(i: number): number {
    return this.fTime[this.ringIndex(i)]!;
  }
  frameTick(i: number): number {
    return this.fTick[this.ringIndex(i)]!;
  }
  frameSeq(i: number): number {
    return this.headSeq + i;
  }
  /** Index of the held frame recorded at exactly `tick`, or −1. */
  indexOfTick(tick: number): number {
    let lo = 0;
    let hi = this._count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.fTick[this.ringIndex(mid)]!;
      if (t === tick) return mid;
      if (t < tick) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  /** Tick of the newest recorded frame (−1 before the first). */
  get lastTick(): number {
    return this.lastRecTick;
  }
  /** FRAME_BODY_HIT etc. of held frame i. */
  frameFlags(i: number): number {
    const slot = this.ringIndex(i);
    return this.chunks[this.fChunk[slot]!]!.u32[(this.fOff[slot]! >>> 2) + 13]!;
  }
  isKeyframe(i: number): boolean {
    return this.fKey[this.ringIndex(i)] === 1;
  }
  /** Index (0 = oldest) of the last frame with time ≤ t (0 when t is before the start; −1 when empty). */
  findFrame(t: number): number {
    const n = this._count;
    if (n === 0) return -1;
    let lo = 0;
    let hi = n - 1;
    if (t >= this.frameTime(hi)) return hi;
    if (t <= this.frameTime(0)) return 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.frameTime(mid) <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Markers inside the buffer, oldest first (reused array). */
  markers(): readonly ReplayMarker[] {
    const start = this.startTime;
    let k = 0;
    while (k < this.markerList.length && this.markerList[k]!.time < start) k++;
    if (k > 0) this.markerPool.push(...this.markerList.splice(0, k));
    return this.markerList;
  }

  // ------------------------------------------------------------ recording
  /** Drops every frame (keeps allocated chunks). */
  clear(): void {
    this.headIdx = 0;
    this.headSeq = this.nextSeq;
    this._count = 0;
    this._bytes = 0;
    this._keyframes = 0;
    this.lastKeySeq = -1;
    this.writeChunk = -1;
    this.writeOff = 0;
    this.seenSeq.fill(-1);
    this.dataSeq.fill(-1);
    this.impN = this.brkN = this.skN = 0;
    this.teleported.fill(0);
    this.lastRecTick = -1;
    this.lastStageTime = Number.NaN;
    this.markerPool.push(...this.markerList.splice(0));
    this.lastDamage.fill(Number.NaN);
  }

  /**
   * Feed every live snapshot as it arrives (in order). Events and traffic
   * teleports are staged; a frame is written when the tick advanced by at
   * least `intervalTicks` since the last recorded frame. Returns true when
   * a frame was recorded. Allocation-free after warm-up.
   */
  record(r: SnapshotReader): boolean {
    this.stageEvents(r);
    const tick = r.tick;
    if (this.lastRecTick >= 0 && tick - this.lastRecTick < this.intervalTicks) return false;
    return this.commit(r);
  }

  /**
   * Records `r` now if its tick is newer than the last recorded frame,
   * ignoring the decimation interval (replay entry: the buffer ends exactly
   * at the live state). Its events must already have been staged by record().
   */
  recordNow(r: SnapshotReader): boolean {
    if (this.lastRecTick >= 0 && r.tick <= this.lastRecTick) return false;
    return this.commit(r);
  }

  private commit(r: SnapshotReader): boolean {
    const tick = r.tick;
    if (this.maxObjects === 0) {
      this.maxObjects = r.maxObjects;
      this.nodeCapacity = r.nodeCapacity;
      this.beamCapacity = r.beamCapacity;
    }
    this.lastRecTick = tick;
    this.writeFrame(r);
    return true;
  }

  private stageEvents(r: SnapshotReader): void {
    const ic = r.impactCount;
    for (let i = 0; i < ic; i++) {
      if (this.impN >= IMPACT_STAGE) {
        this.stagedDropped += ic - i;
        break;
      }
      const e = r.readImpact(i, this.impRec);
      this.impTyre[this.impN] = this.isTyre(r, e.objectId, e.px, e.py, e.pz) ? 1 : 0;
      const w = this.impN++ * IMPACT_WORDS;
      this.impStageU[w] = e.objectId;
      this.impStageU[w + 1] = e.materialId;
      const f = this.impStage;
      f[w + 2] = e.px;
      f[w + 3] = e.py;
      f[w + 4] = e.pz;
      f[w + 5] = e.nx;
      f[w + 6] = e.ny;
      f[w + 7] = e.nz;
      f[w + 8] = e.impulse;
    }
    const bc = r.beamBreakCount;
    for (let i = 0; i < bc; i++) {
      if (this.brkN >= BREAK_STAGE) {
        this.stagedDropped += bc - i;
        break;
      }
      const e = r.readBeamBreak(i, this.brkRec);
      const w = this.brkN++ * BEAM_BREAK_WORDS;
      this.brkStageU[w] = e.objectId;
      this.brkStageU[w + 1] = e.beamIndex;
      this.brkStage[w + 2] = e.px;
      this.brkStage[w + 3] = e.py;
      this.brkStage[w + 4] = e.pz;
    }
    const sc = r.skidCount;
    for (let i = 0; i < sc; i++) {
      if (this.skN >= SKID_STAGE) {
        this.stagedDropped += sc - i;
        break;
      }
      const e = r.readSkid(i, this.skRec);
      const w = this.skN++ * SKID_WORDS;
      this.skStageU[w] = e.objectId;
      this.skStageU[w + 1] = e.materialId;
      const f = this.skStage;
      f[w + 2] = e.px;
      f[w + 3] = e.py;
      f[w + 4] = e.pz;
      f[w + 5] = e.slip;
      f[w + 6] = e.load;
    }
    this.lastStageTime = r.simTime;
    for (let i = 0, n = r.trafficCount; i < n; i++) {
      if ((r.trafficFlags(i) & TRAFFIC_FLAG_TELEPORTED) !== 0) {
        const a = r.trafficAgent(i);
        if (a < TRAFFIC_MAX_AGENTS) this.teleported[a] = 1;
      }
    }
  }

  private ensureScratch(n: number): void {
    if (this.sRepeat.length >= n) return;
    const m = Math.max(n, this.sRepeat.length * 2);
    this.sRepeat = new Uint8Array(m);
    this.sTel = new Uint8Array(m);
    this.sBroken = new Int32Array(m);
  }

  private writeFrame(r: SnapshotReader): void {
    const seq = this.nextSeq;
    const n = r.objectCount;
    this.ensureScratch(n);
    const key = this.lastKeySeq < 0 || seq - this.lastKeySeq >= this.config.keyframeEvery;
    const strains = this.recordStrains && r.hasStrains;
    // ---- pass 1: decisions + size
    let size = HDR_WORDS * 4 + n * OBJ_W * 4;
    const nodes = r.nodes;
    for (let i = 0; i < n; i++) {
      const id = r.objectId(i);
      const flags = r.objectFlags(i);
      const nc = r.objectNodeCount(i);
      const sleeping = (flags & OBJECT_FLAG_SLEEPING) !== 0;
      let repeat = 0;
      if (!key && sleeping && id < ID_SPACE) {
        const ds = this.dataSeq[id]!;
        if (
          this.seenSeq[id] === seq - 1 &&
          this.lastSleep[id] === 1 &&
          this.lastEpoch[id] === r.objectRepairEpoch(i) &&
          this.lastNodes[id] === nc &&
          ds >= this.lastKeySeq &&
          ds >= this.headSeq
        ) {
          repeat = 1;
        }
      }
      this.sRepeat[i] = repeat;
      let tel = 0;
      // props (and anything above the vehicle id range) never carry telemetry
      for (let s = 0; s < TELEMETRY_SLOTS && id < PROP_LAYOUT_ID_BASE; s++) {
        if (r.telemetry(i, s) !== 0) {
          tel = 1;
          break;
        }
      }
      this.sTel[i] = tel;
      if (tel) size += (TELEMETRY_SLOTS + VEHICLE_EXT_SLOTS) * 4;
      let broken = 0;
      if (!repeat) {
        size += 24 + ((nc * 6 + 3) & ~3);
        const bc = r.objectBeamCount(i);
        if (bc > 0 && r.hasBrokenBeams) {
          const words = (bc + 31) >>> 5;
          if (this.brokenScratch.length < words) this.brokenScratch = new Uint32Array(Math.max(words, this.brokenScratch.length * 2));
          broken = r.readObjectBrokenBits(i, this.brokenScratch);
          if (broken > 0) size += words * 4;
        }
        if (strains && bc > 0) size += (bc + 3) & ~3;
      }
      this.sBroken[i] = broken;
    }
    const tc = r.trafficCount;
    size += (this.impN * IMPACT_WORDS + this.brkN * BEAM_BREAK_WORDS + this.skN * SKID_WORDS + tc * TRAFFIC_RECORD_WORDS) * 4;
    size = (size + 7) & ~7;
    if (size > REPLAY_CHUNK_BYTES) throw new RangeError(`replay frame ${size} B exceeds a chunk`);

    // ---- space: chunk + index slot (evicting whole groups from the head)
    const c = this.reserve(size, this.frameTimeOf(r));
    const ch = this.chunks[c]!;
    const base = this.writeOff;
    this.writeOff += size;
    const bw = base >>> 2;
    const u32 = ch.u32;
    const f32 = ch.f32;
    u32[bw] = key ? 1 : 0;
    u32[bw + 1] = size;
    u32[bw + 2] = r.tick;
    u32[bw + 3] = n;
    ch.f64[(base >>> 3) + 2] = r.simTime;
    f32[bw + 6] = r.timeScale;
    u32[bw + 7] = seq;
    u32[bw + 8] = this.impN;
    u32[bw + 9] = this.brkN;
    u32[bw + 10] = this.skN;
    u32[bw + 11] = tc;
    u32[bw + 12] = u32[bw + 13] = u32[bw + 14] = u32[bw + 15] = 0;
    let off = base + (HDR_WORDS + n * OBJ_W) * 4;
    for (let i = 0; i < n; i++) {
      const id = r.objectId(i);
      const flags = r.objectFlags(i);
      const nc = r.objectNodeCount(i);
      const bc = r.objectBeamCount(i);
      const epoch = r.objectRepairEpoch(i);
      const t = bw + HDR_WORDS + i * OBJ_W;
      const repeat = this.sRepeat[i] === 1;
      u32[t + O_ID] = id;
      u32[t + O_FLAGS] = (flags & SIM_FLAGS_MASK) | (repeat ? REC_REPEAT : 0);
      u32[t + O_NODES] = nc;
      u32[t + O_BEAMS] = bc;
      u32[t + O_EPOCH] = epoch;
      u32[t + O_TEL] = 0;
      u32[t + O_BROKEN] = 0;
      u32[t + O_STRAIN] = 0;
      if (repeat) {
        u32[t + O_DATA] = this.dataSeq[id]!;
      } else {
        u32[t + O_DATA] = off - base;
        off = this.writeNodes(ch, off, nodes, r.objectNodeOffset(i) * NODE_STRIDE, nc);
        if (this.sBroken[i]! > 0) {
          // re-read: the scratch holds only the LAST object's bits
          r.readObjectBrokenBits(i, this.brokenScratch);
          u32[t + O_BROKEN] = off - base;
          const words = (bc + 31) >>> 5;
          const w0 = off >>> 2;
          const bs = this.brokenScratch;
          for (let k = 0; k < words; k++) u32[w0 + k] = bs[k]!;
          off += words * 4;
        }
        if (strains && bc > 0) {
          u32[t + O_STRAIN] = off - base;
          const so = r.objectStrains(i);
          const i8 = ch.i8;
          for (let b = 0; b < bc; b++) {
            const v = so ? so[b]! : 0;
            i8[off + b] = v === v ? Math.round((v < -1 ? -1 : v > 1 ? 1 : v) * 127) : -128;
          }
          off += (bc + 3) & ~3;
          this.hasStrainFrames = true;
        }
        if (id < ID_SPACE) this.dataSeq[id] = seq;
      }
      if (this.sTel[i] === 1) {
        u32[t + O_TEL] = off - base;
        const w0 = off >>> 2;
        for (let s = 0; s < TELEMETRY_SLOTS; s++) f32[w0 + s] = r.telemetry(i, s);
        for (let s = 0; s < VEHICLE_EXT_SLOTS; s++) f32[w0 + TELEMETRY_SLOTS + s] = r.telemetryExt(i, s);
        off += (TELEMETRY_SLOTS + VEHICLE_EXT_SLOTS) * 4;
      }
      if (id < ID_SPACE) {
        this.seenSeq[id] = seq;
        this.lastEpoch[id] = epoch;
        this.lastNodes[id] = nc;
        this.lastSleep[id] = (flags & OBJECT_FLAG_SLEEPING) !== 0 ? 1 : 0;
      }
    }
    // events (staged, protocol word layout) + traffic records
    u32[bw + 12] = off - base;
    let fflags = 0;
    for (let e = 0; e < this.impN; e++) {
      const k = e * IMPACT_WORDS;
      const id = this.impStageU[k]!;
      const j = this.impStage[k + 8]!;
      if (this.impTyre[e] === 0 && id < PROP_LAYOUT_ID_BASE && j >= BODY_HIT_IMPULSE) fflags |= FRAME_BODY_HIT;
      else if (id >= PROP_LAYOUT_ID_BASE && j >= 1) fflags |= FRAME_PROP_HIT;
    }
    for (let e = 0; e < this.brkN; e++) {
      const id = this.brkStageU[e * BEAM_BREAK_WORDS]!;
      if (id >= PROP_LAYOUT_ID_BASE) fflags |= FRAME_PROP_HIT;
      else fflags |= FRAME_BODY_HIT;
    }
    u32[bw + 13] = fflags;
    let w = off >>> 2;
    // plain loops: subarray() would allocate a view per frame
    for (let k = 0, m = this.impN * IMPACT_WORDS, src = this.impStageU; k < m; k++) u32[w++] = src[k]!;
    for (let k = 0, m = this.brkN * BEAM_BREAK_WORDS, src = this.brkStageU; k < m; k++) u32[w++] = src[k]!;
    for (let k = 0, m = this.skN * SKID_WORDS, src = this.skStageU; k < m; k++) u32[w++] = src[k]!;
    const tr = this.trRec;
    for (let i = 0; i < tc; i++) {
      r.readTrafficAgent(i, tr);
      u32[w + TR_AGENT] = tr.agent;
      u32[w + TR_OBJECT_ID] = tr.objectId;
      u32[w + TR_FLAGS] = tr.flags | (tr.agent < TRAFFIC_MAX_AGENTS && this.teleported[tr.agent] === 1 ? TRAFFIC_FLAG_TELEPORTED : 0);
      u32[w + TR_LOOK] = ((tr.variant & 0xffff) | ((tr.paint & 0xffff) << 16)) >>> 0;
      u32[w + TR_STATE] = tr.state;
      f32[w + TR_POS] = tr.pos[0];
      f32[w + TR_POS + 1] = tr.pos[1];
      f32[w + TR_POS + 2] = tr.pos[2];
      f32[w + TR_QUAT] = tr.quat[0];
      f32[w + TR_QUAT + 1] = tr.quat[1];
      f32[w + TR_QUAT + 2] = tr.quat[2];
      f32[w + TR_QUAT + 3] = tr.quat[3];
      f32[w + TR_SPEED] = tr.speed;
      f32[w + TR_STEER] = tr.steer;
      f32[w + TR_BRAKE] = tr.brake;
      u32[w + TR_PATH] = tr.path;
      w += TRAFFIC_RECORD_WORDS;
    }
    // ---- index
    const slot = this.ringIndex(this._count);
    this.fChunk[slot] = c;
    this.fOff[slot] = base;
    this.fLen[slot] = size;
    this.fTime[slot] = r.simTime;
    this.fTick[slot] = r.tick;
    this.fKey[slot] = key ? 1 : 0;
    this._count++;
    this._bytes += size;
    if (key) {
      this.lastKeySeq = seq;
      this._keyframes++;
    }
    this.nextSeq++;
    this.detectMarker(r);
    this.impN = this.brkN = this.skN = 0;
    this.teleported.fill(0);
  }

  private frameTimeOf(r: SnapshotReader): number {
    return r.simTime;
  }

  /** Quantizes n nodes at nodes[src..] into the chunk at byte `off`; returns the next 4-aligned offset. */
  private writeNodes(ch: Chunk, off: number, nodes: Float32Array, src: number, n: number): number {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let k = 0, j = src; k < n; k++, j += 3) {
      const x = nodes[j]!;
      const y = nodes[j + 1]!;
      const z = nodes[j + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!(minX <= maxX)) minX = maxX = 0;
    if (!(minY <= maxY)) minY = maxY = 0;
    if (!(minZ <= maxZ)) minZ = maxZ = 0;
    const f32 = ch.f32;
    const w = off >>> 2;
    f32[w] = minX;
    f32[w + 1] = minY;
    f32[w + 2] = minZ;
    f32[w + 3] = (maxX - f32[w]!) / Q;
    f32[w + 4] = (maxY - f32[w + 1]!) / Q;
    f32[w + 5] = (maxZ - f32[w + 2]!) / Q;
    // quantize against the stored (f32) min / scale so decode error ≤ scale / 2
    const ox = f32[w]!;
    const oy = f32[w + 1]!;
    const oz = f32[w + 2]!;
    const ix = f32[w + 3]! > 0 ? 1 / f32[w + 3]! : 0;
    const iy = f32[w + 4]! > 0 ? 1 / f32[w + 4]! : 0;
    const iz = f32[w + 5]! > 0 ? 1 / f32[w + 5]! : 0;
    const u16 = ch.u16;
    let h = (off + 24) >>> 1;
    for (let k = 0, j = src; k < n; k++, j += 3) {
      // x ≥ min, so round = floor(v + 0.5) = (v + 0.5) | 0; NaN | 0 = 0
      let qx = ((nodes[j]! - ox) * ix + 0.5) | 0;
      let qy = ((nodes[j + 1]! - oy) * iy + 0.5) | 0;
      let qz = ((nodes[j + 2]! - oz) * iz + 0.5) | 0;
      if (qx > Q) qx = Q;
      if (qy > Q) qy = Q;
      if (qz > Q) qz = Q;
      if (qx < 0) qx = 0;
      if (qy < 0) qy = 0;
      if (qz < 0) qz = 0;
      u16[h] = qx;
      u16[h + 1] = qy;
      u16[h + 2] = qz;
      h += 3;
    }
    return off + 24 + ((n * 6 + 3) & ~3);
  }

  /** Finds room for `size` bytes (returns the chunk); evicts whole groups as needed. */
  private reserve(size: number, time: number): number {
    // time window: evict groups older than `seconds` before this frame
    while (this._count > 0 && time - this.fTime[this.headIdx]! > this.config.seconds && this.headGroupEndTick() <= this.evictLimitTick) this.evictGroup();
    // index ring full
    while (this._count >= this.capFrames - 1) this.evictGroup();
    if (this.writeChunk < 0 || this.writeOff + size > REPLAY_CHUNK_BYTES) {
      let next = this.writeChunk + 1;
      if (next >= this.chunks.length) {
        if (this.chunks.length < this.maxChunks) this.chunks.push(makeChunk(REPLAY_CHUNK_BYTES));
        else next = 0;
      }
      this.writeChunk = next;
      this.writeOff = 0;
      // the chunk we enter holds the oldest frames: drop them (and the rest of their groups)
      while (this._count > 0 && this.fChunk[this.headIdx] === next) this.evictGroup();
    }
    return this.writeChunk;
  }

  /** Tick of the last frame of the head keyframe group. */
  private headGroupEndTick(): number {
    let i = 1;
    while (i < this._count && this.fKey[this.ringIndex(i)] !== 1) i++;
    return this.fTick[this.ringIndex(i - 1)]!;
  }

  /** Evicts the head frame, then every following non-key frame (one keyframe group). */
  private evictGroup(): void {
    do {
      this.evictHead();
    } while (this._count > 0 && this.fKey[this.headIdx] !== 1);
  }

  private evictHead(): void {
    const i = this.headIdx;
    this.lastEvictedTick = this.fTick[i]!;
    this._bytes -= this.fLen[i]!;
    if (this.fKey[i] === 1) this._keyframes--;
    this.headIdx = i + 1 === this.capFrames ? 0 : i + 1;
    this.headSeq++;
    this._count--;
    this.evicted++;
    if (this._count === 0) this.lastKeySeq = -1;
  }

  // ------------------------------------------------------------ markers
  private detectMarker(r: SnapshotReader): void {
    const time = r.simTime;
    const imp = this.impStage;
    const impU = this.impStageU;
    let touched = 0;
    for (let e = 0; e < this.impN; e++) {
      const w = e * IMPACT_WORDS;
      const id = impU[w]!;
      if (id >= ID_SPACE || this.impTyre[e] === 1) continue;
      if (this.impulseBy[id] === 0 && touched < this.touched.length) this.touched[touched++] = id;
      this.impulseBy[id] = this.impulseBy[id]! + imp[w + 8]!;
    }
    let best = -1;
    let bestJ = 0;
    for (let k = 0; k < touched; k++) {
      const id = this.touched[k]!;
      const J = this.impulseBy[id]!;
      if (J > bestJ) {
        bestJ = J;
        best = id;
      }
    }
    for (let k = 0; k < touched; k++) this.impulseBy[this.touched[k]!] = 0;
    // telemetry damage jump (vehicles)
    let dDamage = 0;
    let dmgId = -1;
    for (let i = 0, n = r.objectCount; i < n; i++) {
      const id = r.objectId(i);
      if (id >= ID_SPACE) continue;
      const d = r.telemetry(i, VehicleTelemetry.damage);
      const prev = this.lastDamage[id]!;
      this.lastDamage[id] = d;
      if (prev === prev && d - prev > dDamage) {
        dDamage = d - prev;
        dmgId = id;
      }
    }
    const breaks = this.brkN;
    let sev = bestJ / 4000;
    if (breaks / 60 > sev) sev = breaks / 60;
    if (dDamage / 0.08 > sev) sev = dDamage / 0.08;
    if (sev > 1) sev = 1;
    if (sev < REPLAY_MARKER_MIN_SEVERITY) return;
    let objectId = best >= 0 ? best : dmgId >= 0 ? dmgId : breaks > 0 ? this.brkStageU[0]! : 0;
    if (objectId < 0) objectId = 0;
    // impulse-weighted contact position of that object (break midpoints when it had no impacts)
    let px = 0;
    let py = 0;
    let pz = 0;
    let wsum = 0;
    for (let e = 0; e < this.impN; e++) {
      const w = e * IMPACT_WORDS;
      if (impU[w] !== objectId || this.impTyre[e] === 1) continue;
      const j = imp[w + 8]!;
      px += imp[w + 2]! * j;
      py += imp[w + 3]! * j;
      pz += imp[w + 4]! * j;
      wsum += j;
    }
    if (wsum <= 0) {
      for (let e = 0; e < this.brkN; e++) {
        const w = e * BEAM_BREAK_WORDS;
        px += this.brkStage[w + 2]!;
        py += this.brkStage[w + 3]!;
        pz += this.brkStage[w + 4]!;
        wsum += 1;
      }
    }
    if (wsum > 0) {
      px /= wsum;
      py /= wsum;
      pz /= wsum;
    }
    const kind: 'impact' | 'break' = breaks > 0 && breaks / 60 >= bestJ / 4000 ? 'break' : 'impact';
    const list = this.markerList;
    const last = list.length > 0 ? list[list.length - 1]! : null;
    let m: MutableMarker;
    if (last && time - last.last <= REPLAY_MARKER_MERGE_S) {
      m = last;
      m.last = time;
      m.breaks += breaks;
      if (objectId === m.objectId) m.impulse += bestJ;
      if (sev > m.severity) {
        m.severity = sev;
        m.time = time;
        m.tick = r.tick;
        m.objectId = objectId;
        m.kind = kind;
        m.pos[0] = px;
        m.pos[1] = py;
        m.pos[2] = pz;
      }
    } else {
      m = this.markerPool.pop() ?? { id: 0, time: 0, tick: 0, objectId: 0, kind: 'impact', severity: 0, impulse: 0, breaks: 0, pos: [0, 0, 0], last: 0 };
      m.id = this.nextMarkerId++;
      m.time = m.last = time;
      m.tick = r.tick;
      m.objectId = objectId;
      m.kind = kind;
      m.severity = sev;
      m.impulse = bestJ;
      m.breaks = breaks;
      m.pos[0] = px;
      m.pos[1] = py;
      m.pos[2] = pz;
      list.push(m);
      if (list.length > 256) this.markerPool.push(list.shift()!);
    }
    this.onMarker?.(m);
  }

  /**
   * Tyre contact: within (tyre radius + 0.15 m) of the segment a hub midpoint
   * swept back along the vehicle's COM velocity over the time since the
   * previous staged snapshot (events accumulate over skipped snapshots: at
   * speed the contact lies metres behind the hubs of the carrying snapshot).
   */
  private isTyre(r: SnapshotReader, id: number, px: number, py: number, pz: number): boolean {
    const wh = this.wheelsOf ? this.wheelsOf(id) : null;
    if (!wh) return false;
    const oi = r.findObject(id);
    if (oi < 0) return false;
    let back = this.lastStageTime === this.lastStageTime ? r.simTime - this.lastStageTime : 0.02;
    back = (back < 0 ? 0 : back > 0.25 ? 0.25 : back) + 0.01;
    const sx = -r.telemetry(oi, VehicleTelemetry.velX) * back;
    const sy = -r.telemetry(oi, VehicleTelemetry.velY) * back;
    const sz = -r.telemetry(oi, VehicleTelemetry.velZ) * back;
    const ss = sx * sx + sy * sy + sz * sz;
    const nodes = r.nodes;
    const base = r.objectNodeOffset(oi) * 3;
    const lim = wh.radius + 0.15;
    const lim2 = lim * lim;
    const h = wh.hubs;
    for (let k = 0; k + 1 < h.length; k += 2) {
      const a = base + h[k]! * 3;
      const b = base + h[k + 1]! * 3;
      const dx = px - 0.5 * (nodes[a]! + nodes[b]!);
      const dy = py - 0.5 * (nodes[a + 1]! + nodes[b + 1]!);
      const dz = pz - 0.5 * (nodes[a + 2]! + nodes[b + 2]!);
      let u = ss > 1e-12 ? (dx * sx + dy * sy + dz * sz) / ss : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = dx - u * sx;
      const ey = dy - u * sy;
      const ez = dz - u * sz;
      if (ex * ex + ey * ey + ez * ez < lim2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ decoding
  /**
   * Writes held frame `i` (0 = oldest) into a snapshot buffer through
   * `w` (attached to a buffer of the recorded capacities, debugStrains off):
   * header, objects (epoch + `epochOffset`), dequantized nodes, telemetry,
   * broken bits, events (when `events`), traffic records. Allocation-free.
   */
  decode(i: number, w: SnapshotWriter, epochOffset = 0, events = true): void {
    const slot = this.ringIndex(i);
    const ch = this.chunks[this.fChunk[slot]!]!;
    const base = this.fOff[slot]!;
    const bw = base >>> 2;
    const u32 = ch.u32;
    const f32 = ch.f32;
    const n = u32[bw + 3]!;
    w.begin(u32[bw + 2]!, ch.f64[(base >>> 3) + 2]!, f32[bw + 6]!);
    let g = 0;
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const t = bw + HDR_WORDS + k * OBJ_W;
      const id = u32[t + O_ID]!;
      const flags = u32[t + O_FLAGS]!;
      const nc = u32[t + O_NODES]!;
      const bc = u32[t + O_BEAMS]!;
      const oi = w.addObject(id, flags & SIM_FLAGS_MASK, nc, bc);
      // the seek generation resets only traffic visuals (player / props restore damage checkpoints instead)
      w.setRepairEpoch(oi, (u32[t + O_EPOCH]! + (isTrafficObjectId(id) ? epochOffset : 0)) >>> 0);
      // nodes + broken: here, or in the source frame for REPEAT
      let dch = ch;
      let dbase = base;
      let dt = t;
      if ((flags & REC_REPEAT) !== 0) {
        const src = this.locateObject(u32[t + O_DATA]!, id);
        if (src >= 0) {
          const sslot = this.slotOfSeq(u32[t + O_DATA]!);
          dch = this.chunks[this.fChunk[sslot]!]!;
          dbase = this.fOff[sslot]!;
          dt = src;
        } else dt = -1;
      }
      if (dt >= 0) {
        const doff = dch.u32[dt + O_DATA]!;
        this.readNodes(dch, dbase + doff, nc, w, g);
        const bo = dch.u32[dt + O_BROKEN]!;
        if (bo !== 0) {
          const w0 = (dbase + bo) >>> 2;
          const du = dch.u32;
          for (let b = 0; b < bc; b++) if (((du[w0 + (b >>> 5)]! >>> (b & 31)) & 1) !== 0) w.setBeamBroken(gb + b, true);
        }
        if (w.layout.debugStrains) {
          const so = dch.u32[dt + O_STRAIN]!;
          if (so !== 0) {
            const i8 = dch.i8;
            const s0 = dbase + so;
            for (let b = 0; b < bc; b++) {
              const q = i8[s0 + b]!;
              w.setStrain(gb + b, q === -128 ? Number.NaN : q / 127);
            }
          } else for (let b = 0; b < bc; b++) w.setStrain(gb + b, 0);
        }
      } else if (w.layout.debugStrains) {
        for (let b = 0; b < bc; b++) w.setStrain(gb + b, 0);
      }
      const to = u32[t + O_TEL]!;
      if (to !== 0) {
        const w0 = (base + to) >>> 2;
        for (let s = 0; s < TELEMETRY_SLOTS; s++) w.setTelemetry(oi, s, f32[w0 + s]!);
        for (let s = 0; s < VEHICLE_EXT_SLOTS; s++) w.setTelemetryExt(oi, s, f32[w0 + TELEMETRY_SLOTS + s]!);
      }
      g += nc;
      gb += bc;
    }
    // events + traffic sit at the end of the record: walk back from the length
    const ni = u32[bw + 8]!;
    const nb = u32[bw + 9]!;
    const ns = u32[bw + 10]!;
    const nt = u32[bw + 11]!;
    let e = (base + u32[bw + 12]!) >>> 2;
    if (events) {
      for (let k = 0; k < ni; k++, e += IMPACT_WORDS) w.pushImpact(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!, f32[e + 5]!, f32[e + 6]!, f32[e + 7]!, f32[e + 8]!);
      for (let k = 0; k < nb; k++, e += BEAM_BREAK_WORDS) w.pushBeamBreak(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!);
      for (let k = 0; k < ns; k++, e += SKID_WORDS) w.pushSkid(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!, f32[e + 5]!, f32[e + 6]!);
    } else e += ni * IMPACT_WORDS + nb * BEAM_BREAK_WORDS + ns * SKID_WORDS;
    const tr = this.trRec;
    for (let k = 0; k < nt; k++, e += TRAFFIC_RECORD_WORDS) {
      tr.agent = u32[e + TR_AGENT]!;
      tr.objectId = u32[e + TR_OBJECT_ID]!;
      tr.flags = u32[e + TR_FLAGS]!;
      const look = u32[e + TR_LOOK]!;
      tr.variant = look & 0xffff;
      tr.paint = look >>> 16;
      tr.state = u32[e + TR_STATE]!;
      tr.pos[0] = f32[e + TR_POS]!;
      tr.pos[1] = f32[e + TR_POS + 1]!;
      tr.pos[2] = f32[e + TR_POS + 2]!;
      tr.quat[0] = f32[e + TR_QUAT]!;
      tr.quat[1] = f32[e + TR_QUAT + 1]!;
      tr.quat[2] = f32[e + TR_QUAT + 2]!;
      tr.quat[3] = f32[e + TR_QUAT + 3]!;
      tr.speed = f32[e + TR_SPEED]!;
      tr.steer = f32[e + TR_STEER]!;
      tr.brake = f32[e + TR_BRAKE]!;
      tr.path = u32[e + TR_PATH]!;
      w.pushTrafficAgent(tr);
    }
  }

  /** Header + the event rings of held frame `i` only (no objects): for events of frames the playhead passes. */
  decodeEvents(i: number, w: SnapshotWriter): void {
    const slot = this.ringIndex(i);
    const ch = this.chunks[this.fChunk[slot]!]!;
    const base = this.fOff[slot]!;
    const bw = base >>> 2;
    const u32 = ch.u32;
    const f32 = ch.f32;
    w.begin(u32[bw + 2]!, ch.f64[(base >>> 3) + 2]!, f32[bw + 6]!);
    let e = (base + u32[bw + 12]!) >>> 2;
    const ni = u32[bw + 8]!;
    const nb = u32[bw + 9]!;
    const ns = u32[bw + 10]!;
    for (let k = 0; k < ni; k++, e += IMPACT_WORDS) w.pushImpact(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!, f32[e + 5]!, f32[e + 6]!, f32[e + 7]!, f32[e + 8]!);
    for (let k = 0; k < nb; k++, e += BEAM_BREAK_WORDS) w.pushBeamBreak(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!);
    for (let k = 0; k < ns; k++, e += SKID_WORDS) w.pushSkid(u32[e]!, u32[e + 1]!, f32[e + 2]!, f32[e + 3]!, f32[e + 4]!, f32[e + 5]!, f32[e + 6]!);
  }

  private readNodes(ch: Chunk, off: number, n: number, w: SnapshotWriter, g: number): void {
    const f32 = ch.f32;
    const b = off >>> 2;
    const ox = f32[b]!;
    const oy = f32[b + 1]!;
    const oz = f32[b + 2]!;
    const sx = f32[b + 3]!;
    const sy = f32[b + 4]!;
    const sz = f32[b + 5]!;
    const u16 = ch.u16;
    let h = (off + 24) >>> 1;
    for (let k = 0; k < n; k++, h += 3) w.setNode(g + k, ox + u16[h]! * sx, oy + u16[h + 1]! * sy, oz + u16[h + 2]! * sz);
  }

  private slotOfSeq(seq: number): number {
    return this.ringIndex(seq - this.headSeq);
  }

  /** Word index of `id`'s object entry in the frame with sequence `seq`, or −1 (evicted / absent). */
  private locateObject(seq: number, id: number): number {
    if (seq < this.headSeq || seq >= this.headSeq + this._count) return -1;
    const slot = this.slotOfSeq(seq);
    const ch = this.chunks[this.fChunk[slot]!]!;
    const bw = this.fOff[slot]! >>> 2;
    const u32 = ch.u32;
    let lo = 0;
    let hi = u32[bw + 3]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = bw + HDR_WORDS + mid * OBJ_W;
      const v = u32[t + O_ID]!;
      if (v === id) return t;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}
