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
