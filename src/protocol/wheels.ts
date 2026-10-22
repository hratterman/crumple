/**
 * TYRE / WHEEL TELEMETRY — protocol contract (R-TYRE, additive;
 * docs/CONTRACTS.md "R-TYRE"). Pure: no three, no DOM, no sim imports.
 *
 * One WHEEL SECTION per snapshot (always present, header flag
 * SNAPSHOT_FLAG_WHEELS, offset at HDR_WHEELS_OFFSET_BYTE; the section's first
 * u32 is the record count, records after a 16-byte section header): a record per wheel
 * of every vehicle object, objects ascending, wheels in VehicleDef.wheels
 * order. The 32 vehicle telemetry slots are full (and corner-indexed: four
 * wheels only); this section carries what a TPMS, a tyre-temperature HUD,
 * the FX (rim sparks, hydroplaning spray) and the audio need, for any
 * wheel count (the box truck has six).
 *
 * Record: 16 words (64 B), u32 then f32:
 *   0 objectId u32, 1 wheel u32 (index in VehicleDef.wheels), 2 flags u32
 *   (WHEEL_FLAG_*), 3 materialId u32 (the surface under the patch),
 *   4 pressure kPa (gauge, hot), 5 / 6 / 7 surface / carcass / inflation-air
 *   temperature °C, 8 tread depth mm, 9 brake disc °C (R-PHYS brakeHeat.ts;
 *   the ambient on an unbraked wheel), 10 soil sinkage m, 11 grip factor
 *   (the tread's μ ÷ its dry-asphalt nominal: temperature, inflation, wear,
 *   surface, water), 12 hydroplaning lift 0..1, 13 slip ratio, 14 slip angle
 *   rad (+ = velocity right of the wheel's heading), 15 load N.
 */

export const WHEEL_RECORD_WORDS = 16;
export const WHEEL_RECORD_BYTES = WHEEL_RECORD_WORDS * 4;
/** Section capacity (records). A worker with more vehicle wheels drops the tail (counted nowhere: 96 = 16 six-wheelers). */
export const WHEEL_SECTION_RECORDS = 96;
/** Section header: u32 0 = the records written this snapshot; words 1–3 zero. */
export const WHEEL_SECTION_HEADER_WORDS = 4;
export const WHEEL_SECTION_BYTES = WHEEL_SECTION_HEADER_WORDS * 4 + WHEEL_SECTION_RECORDS * WHEEL_RECORD_BYTES;

export const WR_OBJECT_ID = 0;
export const WR_WHEEL = 1;
export const WR_FLAGS = 2;
export const WR_MATERIAL = 3;
export const WR_PRESSURE = 4;
export const WR_T_SURFACE = 5;
export const WR_T_CARCASS = 6;
export const WR_T_GAS = 7;
export const WR_TREAD = 8;
export const WR_T_DISC = 9;
export const WR_SINKAGE = 10;
export const WR_GRIP = 11;
export const WR_LIFT = 12;
export const WR_SLIP_RATIO = 13;
export const WR_SLIP_ANGLE = 14;
export const WR_LOAD = 15;

/** In ground contact. */
export const WHEEL_FLAG_CONTACT = 1 << 0;
/** Losing air (a puncture that has not emptied the tyre yet). */
export const WHEEL_FLAG_LEAKING = 1 << 1;
/** Flat: below 25 kPa gauge. */
export const WHEEL_FLAG_FLAT = 1 << 2;
/** The bead has unseated: the tread slips on the rim. */
export const WHEEL_FLAG_DEBEADED = 1 << 3;
/** TPMS warning: 25 % or more below the cold placard pressure (FMVSS 138). */
export const WHEEL_FLAG_TPMS = 1 << 4;
/** Hydroplaning: lift above 0.5. */
export const WHEEL_FLAG_HYDROPLANING = 1 << 5;
/** Torn off the car. */
export const WHEEL_FLAG_DETACHED = 1 << 6;
/** The rim itself touches the ground or a collider (a flat running on its rim: sparks). */
export const WHEEL_FLAG_ON_RIM = 1 << 7;

/** One decoded record (main side; SnapshotReader.readWheel). */
export interface WheelFrame {
  objectId: number;
  wheel: number;
  flags: number;
  materialId: number;
  pressureKpa: number;
  tSurface: number;
  tCarcass: number;
  tGas: number;
  treadMm: number;
  tDisc: number;
  sinkage: number;
  grip: number;
  lift: number;
  slipRatio: number;
  slipAngle: number;
  load: number;
}

export function createWheelFrame(): WheelFrame {
  return {
    objectId: 0,
    wheel: 0,
    flags: 0,
    materialId: 0,
    pressureKpa: 0,
    tSurface: 0,
    tCarcass: 0,
    tGas: 0,
    treadMm: 0,
    tDisc: 0,
    sinkage: 0,
    grip: 0,
    lift: 0,
    slipRatio: 0,
    slipAngle: 0,
    load: 0,
  };
}
