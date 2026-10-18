/**
 * Snapshot event records — FROZEN (P1).
 *
 * Three event kinds travel worker→main inside every snapshot, each in its own
 * fixed-capacity section ("ring"): records [0, count) are valid, in DISCOVERY
 * order (the order the sim pushed them). Events discovered beyond capacity are
 * dropped and counted in the header's per-kind overflow counter.
 *
 * Events accumulate in the worker from one WRITTEN snapshot to the next: if a
 * snapshot is skipped (no free buffer), pending events carry over to the next
 * snapshot that is actually written (overflow counted as usual).
 *
 * Every record is a run of 4-byte words; integer fields are u32, real fields
 * f32, so the section is addressed with plain Uint32Array/Float32Array views
 * (word index = recordIndex * WORDS + FIELD).
 */

/** Event kind ids (used for overflow bookkeeping and generic dispatch). */
export const EventKind = {
  impact: 0,
  beamBreak: 1,
  skid: 2,
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];
export const EVENT_KIND_COUNT = 3;

// ---------------------------------------------------------------- impact
/** Contact impulse above the sim's impact threshold (ground or object). */
export interface ImpactEvent {
  objectId: number;
  /** MaterialId of the surface hit. */
  materialId: number;
  px: number;
  py: number;
  pz: number;
  /** Unit contact normal, pointing away from the surface into the object. */
  nx: number;
  ny: number;
  nz: number;
  /** Impulse magnitude, N·s. */
  impulse: number;
}
export const IMPACT_CAPACITY = 256;
export const IMPACT_OBJECT_ID = 0; // u32
export const IMPACT_MATERIAL_ID = 1; // u32
export const IMPACT_PX = 2; // f32
export const IMPACT_PY = 3;
export const IMPACT_PZ = 4;
export const IMPACT_NX = 5; // f32
export const IMPACT_NY = 6;
export const IMPACT_NZ = 7;
export const IMPACT_IMPULSE = 8; // f32
export const IMPACT_WORDS = 9;
export const IMPACT_BYTES = IMPACT_WORDS * 4;

// ---------------------------------------------------------------- beamBreak
/** A beam exceeded its break force and was deactivated. */
export interface BeamBreakEvent {
  objectId: number;
  /** OBJECT-LOCAL beam index (RigDef declaration order), not the global index. */
  beamIndex: number;
  /** Beam midpoint at the moment of breaking. */
  px: number;
  py: number;
  pz: number;
}
export const BEAM_BREAK_CAPACITY = 256;
export const BEAM_BREAK_OBJECT_ID = 0; // u32
export const BEAM_BREAK_BEAM_INDEX = 1; // u32
export const BEAM_BREAK_PX = 2; // f32
export const BEAM_BREAK_PY = 3;
export const BEAM_BREAK_PZ = 4;
export const BEAM_BREAK_WORDS = 5;
export const BEAM_BREAK_BYTES = BEAM_BREAK_WORDS * 4;

// ---------------------------------------------------------------- skid
/** A sliding contact (tyre or body scrape) above the sim's slip threshold. */
export interface SkidEvent {
  objectId: number;
  /** MaterialId of the surface being slid on. */
  materialId: number;
  px: number;
  py: number;
  pz: number;
  /** Tangential slip speed, m/s. */
  slip: number;
  /** Normal load, N. */
  load: number;
}
export const SKID_CAPACITY = 512;
export const SKID_OBJECT_ID = 0; // u32
export const SKID_MATERIAL_ID = 1; // u32
export const SKID_PX = 2; // f32
export const SKID_PY = 3;
export const SKID_PZ = 4;
export const SKID_SLIP = 5; // f32
export const SKID_LOAD = 6; // f32
export const SKID_WORDS = 7;
export const SKID_BYTES = SKID_WORDS * 4;

/** Allocates a reusable record (call once, outside hot paths). */
export function createImpactEvent(): ImpactEvent {
  return { objectId: 0, materialId: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, impulse: 0 };
}
export function createBeamBreakEvent(): BeamBreakEvent {
  return { objectId: 0, beamIndex: 0, px: 0, py: 0, pz: 0 };
}
export function createSkidEvent(): SkidEvent {
  return { objectId: 0, materialId: 0, px: 0, py: 0, pz: 0, slip: 0, load: 0 };
}
