/**
 * Snapshot binary layout — FROZEN (P1).
 *
 * One snapshot = one ArrayBuffer laid out as consecutive sections, each
 * starting on a SECTION_ALIGN boundary so plain typed-array views work
 * (no DataView anywhere). Byte order is the platform's (little-endian on all
 * supported targets); worker and main always share it.
 *
 *   [header][objects][impacts][beamBreaks][skids][nodes][strains?]
 *
 * Fixed-size sections (header, objects, events) come first; their byte
 * offsets depend only on maxObjects. The header ALSO stores every section
 * offset, so a reader never needs the capacities to decode.
 *
 * Indexing convention: `*_BYTE` constants are byte offsets; `HDR_U32_*`,
 * `HDR_F32_*`, `HDR_F64_*` are element indices into Uint32Array /
 * Float32Array / Float64Array views over the WHOLE buffer (byteOffset 0).
 * Section offsets are in bytes; divide by 4 for u32/f32 word indices.
 */
import {
  BEAM_BREAK_BYTES,
  BEAM_BREAK_CAPACITY,
  IMPACT_BYTES,
  IMPACT_CAPACITY,
  SKID_BYTES,
  SKID_CAPACITY,
} from './events';

/** 'CRMP' read as a little-endian u32 (bytes 43 52 4D 50). */
export const SNAPSHOT_MAGIC = 0x504d5243;
export const SNAPSHOT_VERSION = 1;
export const SECTION_ALIGN = 16;

// ============================================================ header
export const HEADER_BYTES = 128;

export const HDR_MAGIC_BYTE = 0; // u32
export const HDR_VERSION_BYTE = 4; // u32
export const HDR_TICK_BYTE = 8; // u32, sim tick (dt = 1/2000 s) at capture
export const HDR_TIMESCALE_BYTE = 12; // f32
export const HDR_SIMTIME_BYTE = 16; // f64, seconds of sim time at capture
export const HDR_OBJECT_COUNT_BYTE = 24; // u32
export const HDR_NODE_TOTAL_BYTE = 28; // u32
export const HDR_BEAM_TOTAL_BYTE = 32; // u32
export const HDR_FLAGS_BYTE = 36; // u32, SNAPSHOT_FLAG_*
export const HDR_IMPACT_COUNT_BYTE = 40; // u32
export const HDR_IMPACT_OVERFLOW_BYTE = 44; // u32, events dropped beyond capacity
export const HDR_BEAM_BREAK_COUNT_BYTE = 48; // u32
export const HDR_BEAM_BREAK_OVERFLOW_BYTE = 52; // u32
export const HDR_SKID_COUNT_BYTE = 56; // u32
export const HDR_SKID_OVERFLOW_BYTE = 60; // u32
export const HDR_OBJECTS_OFFSET_BYTE = 64; // u32 byte offset of objects section
export const HDR_IMPACTS_OFFSET_BYTE = 68; // u32
export const HDR_BEAM_BREAKS_OFFSET_BYTE = 72; // u32
export const HDR_SKIDS_OFFSET_BYTE = 76; // u32
export const HDR_NODES_OFFSET_BYTE = 80; // u32
export const HDR_STRAINS_OFFSET_BYTE = 84; // u32, 0 when the strain section is absent
export const HDR_MAX_OBJECTS_BYTE = 88; // u32 capacity
export const HDR_NODE_CAPACITY_BYTE = 92; // u32 capacity
export const HDR_BEAM_CAPACITY_BYTE = 96; // u32 capacity
export const HDR_TOTAL_BYTES_BYTE = 100; // u32, layout size (buffer may be larger)
// bytes 104..127 reserved (zero)

export const HDR_U32_MAGIC = HDR_MAGIC_BYTE >> 2;
export const HDR_U32_VERSION = HDR_VERSION_BYTE >> 2;
export const HDR_U32_TICK = HDR_TICK_BYTE >> 2;
export const HDR_F32_TIMESCALE = HDR_TIMESCALE_BYTE >> 2;
export const HDR_F64_SIMTIME = HDR_SIMTIME_BYTE >> 3;
export const HDR_U32_OBJECT_COUNT = HDR_OBJECT_COUNT_BYTE >> 2;
export const HDR_U32_NODE_TOTAL = HDR_NODE_TOTAL_BYTE >> 2;
export const HDR_U32_BEAM_TOTAL = HDR_BEAM_TOTAL_BYTE >> 2;
export const HDR_U32_FLAGS = HDR_FLAGS_BYTE >> 2;
export const HDR_U32_IMPACT_COUNT = HDR_IMPACT_COUNT_BYTE >> 2;
export const HDR_U32_IMPACT_OVERFLOW = HDR_IMPACT_OVERFLOW_BYTE >> 2;
export const HDR_U32_BEAM_BREAK_COUNT = HDR_BEAM_BREAK_COUNT_BYTE >> 2;
export const HDR_U32_BEAM_BREAK_OVERFLOW = HDR_BEAM_BREAK_OVERFLOW_BYTE >> 2;
export const HDR_U32_SKID_COUNT = HDR_SKID_COUNT_BYTE >> 2;
export const HDR_U32_SKID_OVERFLOW = HDR_SKID_OVERFLOW_BYTE >> 2;
export const HDR_U32_OBJECTS_OFFSET = HDR_OBJECTS_OFFSET_BYTE >> 2;
export const HDR_U32_IMPACTS_OFFSET = HDR_IMPACTS_OFFSET_BYTE >> 2;
export const HDR_U32_BEAM_BREAKS_OFFSET = HDR_BEAM_BREAKS_OFFSET_BYTE >> 2;
export const HDR_U32_SKIDS_OFFSET = HDR_SKIDS_OFFSET_BYTE >> 2;
export const HDR_U32_NODES_OFFSET = HDR_NODES_OFFSET_BYTE >> 2;
export const HDR_U32_STRAINS_OFFSET = HDR_STRAINS_OFFSET_BYTE >> 2;
export const HDR_U32_MAX_OBJECTS = HDR_MAX_OBJECTS_BYTE >> 2;
export const HDR_U32_NODE_CAPACITY = HDR_NODE_CAPACITY_BYTE >> 2;
export const HDR_U32_BEAM_CAPACITY = HDR_BEAM_CAPACITY_BYTE >> 2;
export const HDR_U32_TOTAL_BYTES = HDR_TOTAL_BYTES_BYTE >> 2;

/** Header flag bits. */
export const SNAPSHOT_FLAG_DEBUG_STRAINS = 1 << 0;

// ============================================================ objects
/**
 * Fixed-size object records, ascending objectId, `objectCount` valid.
 * Fields are u32 words except the telemetry block (f32).
 * nodeOffset/beamOffset are ELEMENT indices (nodes, beams) into the global
 * node/strain arrays, not bytes. Objects are packed contiguously in record
 * order, so object i's nodes are [nodeOffset, nodeOffset + nodeCount).
 */
export const OBJ_ID = 0; // u32
export const OBJ_FLAGS = 1; // u32, OBJECT_FLAG_*
export const OBJ_NODE_OFFSET = 2; // u32
export const OBJ_NODE_COUNT = 3; // u32
export const OBJ_BEAM_OFFSET = 4; // u32
export const OBJ_BEAM_COUNT = 5; // u32
export const OBJ_RESERVED0 = 6; // u32, zero
export const OBJ_RESERVED1 = 7; // u32, zero
export const OBJ_TELEMETRY = 8; // first f32 of the telemetry block
export const TELEMETRY_SLOTS = 32;
export const OBJ_RECORD_WORDS = OBJ_TELEMETRY + TELEMETRY_SLOTS; // 40
export const OBJ_RECORD_BYTES = OBJ_RECORD_WORDS * 4; // 160

export const OBJECT_FLAG_SLEEPING = 1 << 0;

/**
 * Telemetry slot indices (f32, relative to OBJ_TELEMETRY). All zeros in P1;
 * vehicles fill them from P2. Slots 26..31 are assigned in telemetry.ts
 * (`VehicleTelemetry`, the full P2 table and exact semantics); never
 * renumber these.
 */
export const Telemetry = {
  speed: 0, // m/s, signed along vehicle forward
  engineRpm: 1,
  gear: 2, // current gear (-1 R, 0 N, 1..n)
  throttle: 3, // applied (post-assist) 0..1
  brake: 4, // applied 0..1
  steer: 5, // applied -1..1
  clutch: 6, // applied 0..1
  handbrake: 7, // applied 0..1
  wheelSlipFL: 8, // m/s, mean tangential ground velocity of in-contact tyre nodes
  wheelSlipFR: 9,
  wheelSlipRL: 10,
  wheelSlipRR: 11,
  wheelLoadFL: 12, // N
  wheelLoadFR: 13,
  wheelLoadRL: 14,
  wheelLoadRR: 15,
  comX: 16, // centre of mass, world m
  comY: 17,
  comZ: 18,
  velX: 19, // centre-of-mass velocity, world m/s
  velY: 20,
  velZ: 21,
  engineTorque: 22, // N·m
  damage: 23, // 0..1 fraction of beams broken or plastically deformed (P2; was 'plastic work J' placeholder)
  airborne: 24, // 1 when no attached wheel touches ground
  wheelsDetached: 25, // bitmask FL=1 FR=2 RL=4 RR=8, as f32
} as const;
/** First slot beyond the P1 names; 26..31 are assigned by telemetry.ts (no spares remain after P2). */
export const TELEMETRY_FIRST_SPARE = 26;

// ============================================================ nodes / strains
/** Node positions: f32 x,y,z interleaved, nodeTotal entries. */
export const NODE_STRIDE = 3;
export const NODE_BYTES = NODE_STRIDE * 4;
/**
 * Beam strains (only with SNAPSHOT_FLAG_DEBUG_STRAINS): f32 per beam,
 * beamTotal entries, strain = signed force / breakForce clamped to [-1, 1]
 * (positive = tension, negative = compression), NaN for broken beams.
 */
export const STRAIN_BYTES = 4;

// ============================================================ layout calc
export interface SnapshotLayout {
  maxObjects: number;
  nodeCapacity: number;
  beamCapacity: number;
  debugStrains: boolean;
  objectsOffset: number;
  impactsOffset: number;
  beamBreaksOffset: number;
  skidsOffset: number;
  nodesOffset: number;
  /** 0 when !debugStrains. */
  strainsOffset: number;
  totalBytes: number;
}

export function alignUp(n: number, a: number = SECTION_ALIGN): number {
  return Math.ceil(n / a) * a;
}

export function computeSnapshotLayout(
  maxObjects: number,
  nodeCapacity: number,
  beamCapacity: number,
  debugStrains: boolean,
): SnapshotLayout {
  const objectsOffset = HEADER_BYTES;
  const impactsOffset = alignUp(objectsOffset + maxObjects * OBJ_RECORD_BYTES);
  const beamBreaksOffset = alignUp(impactsOffset + IMPACT_CAPACITY * IMPACT_BYTES);
  const skidsOffset = alignUp(beamBreaksOffset + BEAM_BREAK_CAPACITY * BEAM_BREAK_BYTES);
  const nodesOffset = alignUp(skidsOffset + SKID_CAPACITY * SKID_BYTES);
  const nodesEnd = alignUp(nodesOffset + nodeCapacity * NODE_BYTES);
  const strainsOffset = debugStrains ? nodesEnd : 0;
  const totalBytes = debugStrains ? alignUp(nodesEnd + beamCapacity * STRAIN_BYTES) : nodesEnd;
  return {
    maxObjects,
    nodeCapacity,
    beamCapacity,
    debugStrains,
    objectsOffset,
    impactsOffset,
    beamBreaksOffset,
    skidsOffset,
    nodesOffset,
    strainsOffset,
    totalBytes,
  };
}

export function computeSnapshotBytes(
  maxObjects: number,
  nodeCapacity: number,
  beamCapacity: number,
  debugStrains: boolean,
): number {
  return computeSnapshotLayout(maxObjects, nodeCapacity, beamCapacity, debugStrains).totalBytes;
}
