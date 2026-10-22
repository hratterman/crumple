/**
 * Vehicle telemetry slots — FROZEN (P2).
 *
 * The object record carries TELEMETRY_SLOTS (32) f32 at OBJ_TELEMETRY.
 * Slots 0..25 were named in P1 (layout.ts `Telemetry`, never renumbered);
 * P2 assigns the spare slots 26..31. Non-vehicle objects leave all zeros.
 * Everything is written by the worker's vehicle step (once per tick, copied
 * at snapshot time); damage is evaluated only when a snapshot is written.
 *
 * | slot  | name                | unit / meaning                                                      |
 * |-------|---------------------|---------------------------------------------------------------------|
 * | 0     | speed               | m/s, COM velocity · vehicle forward (signed, + forward)             |
 * | 1     | engineRpm           | rpm                                                                 |
 * | 2     | gear                | engaged gear −1 R, 0 N, 1..n                                        |
 * | 3–7   | throttle … handbrake| APPLIED values (post limiter/auto-clutch), same ranges as actions   |
 * | 8–11  | wheelSlip FL..RR    | m/s, mean |tangential ground velocity| of in-contact tyre nodes      |
 * | 12–15 | wheelLoad FL..RR    | N, Σ ground normal force on the wheel's tyre nodes                  |
 * | 16–18 | comX/Y/Z            | world m                                                             |
 * | 19–21 | velX/Y/Z            | COM velocity, world m/s                                             |
 * | 22    | engineTorque        | N·m net crank torque                                                |
 * | 23    | damage              | 0..1 fraction of beams broken or plastically deformed               |
 * | 24    | airborne            | 1 when no attached wheel touches ground                             |
 * | 25    | wheelsDetached      | bitmask FL=1 FR=2 RL=4 RR=8 (as f32)                                |
 * | 26–29 | wheelOmega FL..RR   | rad/s about the spin axis, + = rolling forward                      |
 * | 30    | driveTorque         | N·m total delivered to the driven wheels (signed)                   |
 * | 31    | wheelContact        | bitmask FL=1 FR=2 RL=4 RR=8 (as f32), tyre touching ground          |
 *
 * Per-wheel slots follow CompiledWheel.corner (FL, FR, RL, RR); a vehicle
 * with more wheels reports the first declared wheel per corner. Slip RATIO
 * has no slot: derive it with `estimateSlipRatio` (main knows the radius).
 */
import { TELEMETRY_SLOTS, Telemetry } from './layout';

export const VehicleTelemetry = {
  ...Telemetry,
  wheelOmegaFL: 26,
  wheelOmegaFR: 27,
  wheelOmegaRL: 28,
  wheelOmegaRR: 29,
  driveTorque: 30,
  wheelContact: 31,
} as const;
export type VehicleTelemetrySlot = (typeof VehicleTelemetry)[keyof typeof VehicleTelemetry];

/** Corner order shared by every per-wheel slot group. */
export const TELEMETRY_CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
export const TELEMETRY_CORNER_COUNT = 4;
/** Bit per corner in wheelsDetached / wheelContact. */
export const CORNER_BIT: readonly number[] = [1, 2, 4, 8];

/** Slot of corner c (0..3) in each per-wheel group. */
export const WHEEL_SLIP_SLOTS: readonly number[] = [8, 9, 10, 11];
export const WHEEL_LOAD_SLOTS: readonly number[] = [12, 13, 14, 15];
export const WHEEL_OMEGA_SLOTS: readonly number[] = [26, 27, 28, 29];

/** Every slot is assigned in P2; no spares remain. */
export const TELEMETRY_SLOTS_USED: typeof TELEMETRY_SLOTS = 32;

/** Reads a bitmask slot (f32-stored integer) and tests corner c. */
export function cornerFlag(telemetry: ArrayLike<number>, slot: number, corner: number): boolean {
  const bits = telemetry[slot] ?? 0;
  return ((bits | 0) & (CORNER_BIT[corner] ?? 0)) !== 0;
}

/**
 * Longitudinal slip ratio estimate for HUD/audio: (ω·radius − v) / max(|v|, 0.5),
 * with v the vehicle speed (slot 0). Positive = wheelspin, negative = lockup.
 */
export function estimateSlipRatio(omega: number, radius: number, speed: number): number {
  const av = speed < 0 ? -speed : speed;
  return (omega * radius - speed) / (av > 0.5 ? av : 0.5);
}

/** Decoded vehicle telemetry (main-thread convenience; reuse one instance). */
export interface VehicleTelemetryFrame {
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  clutch: number;
  handbrake: number;
  engineTorque: number;
  driveTorque: number;
  damage: number;
  airborne: boolean;
  /** Per corner FL, FR, RL, RR. */
  wheelOmega: [number, number, number, number];
  wheelSlip: [number, number, number, number];
  wheelLoad: [number, number, number, number];
  wheelContact: [boolean, boolean, boolean, boolean];
  wheelDetached: [boolean, boolean, boolean, boolean];
}

export function createVehicleTelemetryFrame(): VehicleTelemetryFrame {
  return {
    speed: 0,
    rpm: 0,
    gear: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    clutch: 0,
    handbrake: 0,
    engineTorque: 0,
    driveTorque: 0,
    damage: 0,
    airborne: false,
    wheelOmega: [0, 0, 0, 0],
    wheelSlip: [0, 0, 0, 0],
    wheelLoad: [0, 0, 0, 0],
    wheelContact: [false, false, false, false],
    wheelDetached: [false, false, false, false],
  };
}

/** Decodes one object's telemetry block (e.g. SnapshotReader.objectTelemetry(i)) into `out`. Allocation-free. */
export function readVehicleTelemetry(t: ArrayLike<number>, out: VehicleTelemetryFrame): VehicleTelemetryFrame {
  const T = VehicleTelemetry;
  out.speed = t[T.speed] ?? 0;
  out.rpm = t[T.engineRpm] ?? 0;
  out.gear = Math.round(t[T.gear] ?? 0);
  out.throttle = t[T.throttle] ?? 0;
  out.brake = t[T.brake] ?? 0;
  out.steer = t[T.steer] ?? 0;
  out.clutch = t[T.clutch] ?? 0;
  out.handbrake = t[T.handbrake] ?? 0;
  out.engineTorque = t[T.engineTorque] ?? 0;
  out.driveTorque = t[T.driveTorque] ?? 0;
  out.damage = t[T.damage] ?? 0;
  out.airborne = (t[T.airborne] ?? 0) >= 0.5;
  for (let c = 0; c < TELEMETRY_CORNER_COUNT; c++) {
    out.wheelOmega[c] = t[WHEEL_OMEGA_SLOTS[c]!] ?? 0;
    out.wheelSlip[c] = t[WHEEL_SLIP_SLOTS[c]!] ?? 0;
    out.wheelLoad[c] = t[WHEEL_LOAD_SLOTS[c]!] ?? 0;
    out.wheelContact[c] = cornerFlag(t, T.wheelContact, c);
    out.wheelDetached[c] = cornerFlag(t, T.wheelsDetached, c);
  }
  return out;
}

/**
 * R-PHYS VEHICLE EXT TELEMETRY (additive section, layout.ts
 * HDR_VEHICLE_EXT_OFFSET_BYTE; VEHICLE_EXT_SLOTS = 16 f32 per object, zeros
 * for non-vehicles and pre-R-PHYS writers). Written by the worker's vehicle
 * step with the snapshot; recorded and replayed by the replay buffer.
 *
 * | slot  | name            | unit / meaning                                                           |
 * |-------|-----------------|--------------------------------------------------------------------------|
 * | 0–3   | brakeTemp FL..RR| °C, brake disc temperature (brakeHeat.ts); 0 = unbraked corner         |
 * | 4     | coolantTemp     | °C (engineSystems.ts)                                                    |
 * | 5     | coolantLevel    | 0..1                                                                     |
 * | 6     | oilLevel        | 0..1                                                                     |
 * | 7     | fuel            | litres in the tank                                                       |
 * | 8     | fuelRate        | L/h, instantaneous                                                       |
 * | 9     | engineHealth    | 0..1 (0 = seized)                                                        |
 * | 10    | assistBits      | EXT_ASSIST_* bitmask (as f32): ABS / ESC / TC active this tick + enabled |
 * | 11    | engineBits      | EXT_ENGINE_* bitmask (as f32)                                            |
 * | 12    | radiatorDamage  | 0..1 (coolant leak rate ∝)                                               |
 * | 13    | powerFactor     | 0..1, over-temperature derate of full-load torque                       |
 * | 14    | fuelTank        | litres, tank capacity                                                    |
 * | 15    | drivelineBits   | broken halfshaft bitmask per corner FL=1 FR=2 RL=4 RR=8 (as f32)         |
 */
export const VehicleTelemetryExt = {
  brakeTempFL: 0,
  brakeTempFR: 1,
  brakeTempRL: 2,
  brakeTempRR: 3,
  coolantTemp: 4,
  coolantLevel: 5,
  oilLevel: 6,
  fuel: 7,
  fuelRate: 8,
  engineHealth: 9,
  assistBits: 10,
  engineBits: 11,
  radiatorDamage: 12,
  powerFactor: 13,
  fuelTank: 14,
  drivelineBits: 15,
} as const;
export const BRAKE_TEMP_SLOTS: readonly number[] = [0, 1, 2, 3];
/** assistBits: ABS / ESC / TC intervening this tick, and switched on (and fitted). */
export const EXT_ASSIST_ABS_ACTIVE = 1;
export const EXT_ASSIST_ESC_ACTIVE = 2;
export const EXT_ASSIST_TC_ACTIVE = 4;
export const EXT_ASSIST_ABS_ON = 8;
export const EXT_ASSIST_ESC_ON = 16;
export const EXT_ASSIST_TC_ON = 32;
/** engineBits. */
export const EXT_ENGINE_RUNNING = 1;
export const EXT_ENGINE_STALLED = 2;
export const EXT_ENGINE_CRANKING = 4;
export const EXT_ENGINE_OVERHEAT = 8;
export const EXT_ENGINE_SEIZED = 16;
export const EXT_ENGINE_RADIATOR_LEAK = 32;
export const EXT_ENGINE_OIL_LEAK = 64;
export const EXT_ENGINE_LOW_FUEL = 128;
export const EXT_ENGINE_LOW_OIL = 256;

/** Decoded ext telemetry (main-thread convenience; reuse one instance). */
export interface VehicleTelemetryExtFrame {
  present: boolean;
  brakeTemp: [number, number, number, number];
  coolantTemp: number;
  coolantLevel: number;
  oilLevel: number;
  fuel: number;
  fuelRate: number;
  fuelTank: number;
  engineHealth: number;
  radiatorDamage: number;
  powerFactor: number;
  assistBits: number;
  engineBits: number;
  drivelineBits: number;
}

export function createVehicleTelemetryExtFrame(): VehicleTelemetryExtFrame {
  return {
    present: false,
    brakeTemp: [0, 0, 0, 0],
    coolantTemp: 0,
    coolantLevel: 0,
    oilLevel: 0,
    fuel: 0,
    fuelRate: 0,
    fuelTank: 0,
    engineHealth: 0,
    radiatorDamage: 0,
    powerFactor: 0,
    assistBits: 0,
    engineBits: 0,
    drivelineBits: 0,
  };
}

function extAt(t: ArrayLike<number> | null, i: number): number {
  return t ? (t[i] ?? 0) : 0;
}

/** Decodes one object's ext block (SnapshotReader.objectTelemetryExt(i), null = absent) into `out`. Allocation-free. */
export function readVehicleTelemetryExt(t: ArrayLike<number> | null, out: VehicleTelemetryExtFrame): VehicleTelemetryExtFrame {
  const X = VehicleTelemetryExt;
  out.present = t !== null;
  for (let c = 0; c < TELEMETRY_CORNER_COUNT; c++) out.brakeTemp[c] = extAt(t, BRAKE_TEMP_SLOTS[c]!);
  out.coolantTemp = extAt(t, X.coolantTemp);
  out.coolantLevel = extAt(t, X.coolantLevel);
  out.oilLevel = extAt(t, X.oilLevel);
  out.fuel = extAt(t, X.fuel);
  out.fuelRate = extAt(t, X.fuelRate);
  out.fuelTank = extAt(t, X.fuelTank);
  out.engineHealth = extAt(t, X.engineHealth);
  out.radiatorDamage = extAt(t, X.radiatorDamage);
  out.powerFactor = extAt(t, X.powerFactor);
  out.assistBits = Math.round(extAt(t, X.assistBits));
  out.engineBits = Math.round(extAt(t, X.engineBits));
  out.drivelineBits = Math.round(extAt(t, X.drivelineBits));
  return out;
}
