/**
 * BRAKE SYSTEM (worker-only, R-PHYS): hydraulic pressure per wheel, ABS
 * (wheel-slip control by pressure modulation), EBD (rear proportioning) and
 * ESC (yaw control by single-wheel braking). Runs every tick right after
 * stepDrivetrain, which has written each wheel's PEDAL-demanded brake torque
 * (service · bias, handbrake, line lock) into WheelRuntime.brakeTorque; this
 * module replaces the service part with the modulated caliper pressure.
 *
 * HYDRAULICS. The caliper pressure p ∈ [0, 1] (fraction of the line pressure
 * at full pedal; torque = p · CompiledWheel.brakeTorque) follows the master
 * cylinder (pedal) with a first-order lag BRAKE_LAG_S (≈ 30 ms: a real
 * booster + line reaches full pressure ≈ 0.1–0.15 s after a pedal stab), the
 * ABS modulator limiting how it may rise and fall (Bosch ABS 2/5 valve
 * logic: build / hold / dump).
 *
 * ABS (per wheel, a 3-phase cycle like a production 4-channel system,
 * Bosch Automotive Handbook "Antilock braking system"; Burckhardt 1993):
 *   - reference speed v_ref: estimated from the WHEEL speeds only (no ground
 *     truth), the fastest wheel, never falling faster than ABS_REF_DECEL
 *     (a real ECU's plausibility ramp); slip λ = (v_ref − ω·r)/v_ref.
 *   - DUMP when λ > ABS_SLIP_HI or the wheel decelerates harder than
 *     ABS_DECEL_LOCK (incipient lock): pressure falls at ABS_DUMP_RATE.
 *   - HOLD once the wheel re-accelerates (dω·r/dt > ABS_REACCEL) or the slip is
 *     back under ABS_SLIP_LO.
 *   - BUILD slowly (ABS_BUILD_RATE, the "staircase" reapply) until the next
 *     dump. The cycle repeats at ≈ 4–10 Hz with the slip oscillating around
 *     the tyre's μ-slip peak; it shows directly in the slip trace.
 *   ABS is off below ABS_MIN_SPEED (the last metres lock, like a real car).
 * EBD: a rear wheel's dump threshold follows the front axle's slip (+ margin),
 *   so the rear never locks before the fronts (stability under braking).
 * ESC: reference yaw rate from the linear bicycle model, r_ref = v·δ/(L(1 +
 *   K_us·v²)), clipped to the friction limit μ·g/v; when the measured yaw rate
 *   exceeds it (oversteer) the OUTER front wheel is braked, when it falls
 *   short (understeer) the INNER rear wheel is braked, proportional to the
 *   yaw-rate error beyond a dead band. Its pressure adds to the pedal's and
 *   passes through the same ABS limiter.
 *
 * Hot path: only + − × ÷ sqrt, no allocation, wheels in declaration order.
 */
import { Action } from '../../protocol/messages';
import type { SimState } from '../types';
import type { DrivetrainStateEx } from './drivetrain';
import type { VehicleRuntime } from './types';

/** Pedal → caliper pressure lag, s. */
export const BRAKE_LAG_S = 0.03;
/** ABS: slip thresholds (dump above HI, hold below LO). */
export const ABS_SLIP_HI = 0.12;
export const ABS_SLIP_LO = 0.05;
/**
 * ABS: wheel deceleration (m/s², at the tread, ≈ 2.5 g) that dumps once the
 * slip is past ABS_DECEL_MIN_SLIP (incipient lock; alone it fires on the
 * soft ring's ω ripple).
 */
export const ABS_DECEL_LOCK = 40;
export const ABS_DECEL_MIN_SLIP = 0.06;
/** ABS: wheel acceleration (m/s²) above which a dump turns into a hold (the wheel stopped decelerating), and that keeps a hold. */
export const ABS_REACCEL = 20;
/** ABS: pressure dump / slow build rates (fraction of line pressure per second). */
export const ABS_DUMP_RATE = 15;
export const ABS_BUILD_RATE = 2;
/** ABS: after a dump the pressure is rebuilt quickly to this fraction of the pressure that locked the wheel, then slowly. */
export const ABS_FAST_REBUILD = 0.8;
/** ABS: one dump-valve pulse and the hold that checks the wheel's reaction after it, s. */
export const ABS_DUMP_PULSE_S = 0.012;
export const ABS_HOLD_CHECK_S = 0.02;
/** ABS: a wheel counts as cycling this long after its last dump, s. */
export const ABS_CYCLE_S = 0.4;
/** ABS: reference-speed plausibility ramps (m/s²: down, up while braking) and cut-off speed (m/s). */
export const ABS_REF_DECEL = 13;
export const ABS_REF_ACCEL = 15;
/** Wheel-speed sensor + ECU filter time constant, s (the soft ring's ω ripple is ±1–2 m/s at the tread). */
export const WHEEL_SPEED_TAU = 0.01;
export const ABS_MIN_SPEED = 2;
/** EBD: a rear wheel's pressure stops rising while its slip exceeds the front axle's by this. */
export const EBD_MARGIN = 0.03;
/** ESC: yaw-rate dead band (rad/s + fraction of the reference), gain (pressure per rad/s), max pressure. */
export const ESC_DEADBAND = 0.05;
export const ESC_DEADBAND_FRAC = 0.12;
export const ESC_GAIN = 2.5;
export const ESC_MAX = 0.6;
/** ESC: active above this speed (m/s), linear understeer coefficient of the reference model (s²/m²). */
export const ESC_MIN_SPEED = 5;
export const ESC_KUS = 0.0012;
/** ESC reference friction (g) for the yaw-rate ceiling. */
export const ESC_MU = 0.95;

const PHASE_BUILD = 0;
const PHASE_DUMP = 1;
const PHASE_HOLD = 2;

/** Per-vehicle brake system state (preallocated at spawn). */
export interface BrakeSystemState {
  /** Caliper pressure per wheel, 0..1 of line pressure. */
  pressure: Float64Array;
  /** ABS phase per wheel (0 build, 1 dump, 2 hold). */
  phase: Uint8Array;
  /** Filtered tread speed ω·r per wheel (m/s) and its low-passed derivative. */
  vPrev: Float64Array;
  accel: Float64Array;
  /** ABS slip per wheel (last tick). */
  slip: Float64Array;
  /** ESC extra pressure per wheel (last tick). */
  esc: Float64Array;
  /** ABS: pressure at the wheel's last dump, and time since it (s). */
  pMem: Float64Array;
  cycleT: Float64Array;
  /** ABS: time left in the current dump pulse / hold check, s. */
  phaseT: Float64Array;
  /** Reference speed estimate, m/s. */
  vRef: number;
  /** ABS-only reference fall ramp, m/s² (1.15 × the tyres' μ × g). */
  refDecel: number;
  /** 1 while any wheel's ABS is modulating (dump/hold within the last 0.2 s). */
  absActive: number;
  absTimer: number;
  /** 1 while ESC brakes a wheel. */
  escActive: number;
  /** Measured yaw rate (rad/s, + right) and the model's reference. */
  yawRate: number;
  yawRef: number;
  /** Wheelbase (m) and per-wheel side (−1 left, +1 right) from the rest geometry. */
  wheelbase: number;
  side: Float64Array;
  /** Previous heading vector (for the yaw rate). */
  hx: number;
  hz: number;
}

export function createBrakeSystem(vehicle: VehicleRuntime): BrakeSystemState {
  const n = vehicle.wheels.length;
  const rig = vehicle.vehicle.rig;
  const side = new Float64Array(n);
  let zF = 0;
  let zR = 0;
  let nF = 0;
  let nR = 0;
  for (let w = 0; w < n; w++) {
    const cw = vehicle.vehicle.wheels[w]!;
    const x = (rig.nodePos[3 * cw.hubI]! + rig.nodePos[3 * cw.hubO]!) / 2;
    const z = (rig.nodePos[3 * cw.hubI + 2]! + rig.nodePos[3 * cw.hubO + 2]!) / 2;
    side[w] = x < 0 ? -1 : 1;
    if (cw.axle === 'front') {
      zF += z;
      nF++;
    } else {
      zR += z;
      nR++;
    }
  }
  const wheelbase = nF > 0 && nR > 0 ? zR / nR - zF / nF : 2.7;
  let muMax = 0;
  for (const cw of vehicle.vehicle.wheels) if (cw.friction > muMax) muMax = cw.friction;
  const refDecel = 1.15 * 9.81 * (muMax > 0 ? muMax : 1);
  return {
    pressure: new Float64Array(n),
    phase: new Uint8Array(n),
    vPrev: new Float64Array(n),
    accel: new Float64Array(n),
    slip: new Float64Array(n),
    esc: new Float64Array(n),
    pMem: new Float64Array(n),
    cycleT: new Float64Array(n).fill(1e9),
    phaseT: new Float64Array(n),
    vRef: 0,
    refDecel,
    absActive: 0,
    absTimer: 0,
    escActive: 0,
    yawRate: 0,
    yawRef: 0,
    wheelbase,
    side,
    hx: 0,
    hz: 0,
  };
}

export function resetBrakeSystem(b: BrakeSystemState): void {
  b.pressure.fill(0);
  b.phase.fill(0);
  b.vPrev.fill(0);
  b.accel.fill(0);
  b.slip.fill(0);
  b.esc.fill(0);
  b.pMem.fill(0);
  b.cycleT.fill(1e9);
  b.phaseT.fill(0);
  b.vRef = 0;
  b.absActive = 0;
  b.absTimer = 0;
  b.escActive = 0;
  b.yawRate = 0;
  b.yawRef = 0;
  b.hx = 0;
  b.hz = 0;
}

/** ABS-only reference: the fastest wheel inside a plausibility band (falls ≤ refDecel; while cycling rises ≤ ABS_REF_ACCEL). */
function wheelReference(b: BrakeSystemState, vMax: number, dt: number, n: number): number {
  const floor = b.vRef - b.refDecel * dt;
  let cycling = false;
  for (let w = 0; w < n; w++) if (b.cycleT[w]! < ABS_CYCLE_S) cycling = true;
  const ceil = cycling ? b.vRef + ABS_REF_ACCEL * dt : Infinity;
  let vr = vMax > floor ? vMax : floor > 0 ? floor : 0;
  if (vr > ceil) vr = ceil;
  return vr;
}

/** Inertial-sensor reference filter, s. */
export const IMU_TAU = 0.01;

/** Wheel-speed derivative filter time constant, s. */
const ACCEL_TAU = 0.015;

/**
 * One tick of the brake system. Reads the pedal/handbrake actions and the
 * stepDrivetrain brake demand, writes the modulated WheelRuntime.brakeTorque.
 */
export function stepBrakes(state: SimState, vehicle: VehicleRuntime, actions: Float64Array, dt: number, b: BrakeSystemState): void {
  const wheels = vehicle.wheels;
  const n = wheels.length;
  const dts = vehicle.drivetrain as DrivetrainStateEx;
  const brakesDef = vehicle.vehicle.brakes;
  const absOn = brakesDef.abs === true && dts.abs !== false;
  const escOn = brakesDef.esc === true && dts.esc !== false;
  let pedal = actions[Action.brake]!;
  pedal = pedal < 0 ? 0 : pedal > 1 ? 1 : pedal;
  const hand = actions[Action.handbrake]!;
  const lineLock = dts.lineLock === true;

  // ---- wheel speeds, their derivative, reference speed (wheel speeds only)
  let vMax = 0;
  const kv = dt / (WHEEL_SPEED_TAU + dt);
  const ka = dt / (ACCEL_TAU + dt);
  for (let w = 0; w < n; w++) {
    const wr = wheels[w]!;
    let v = wr.omega * wr.rollRadius;
    if (v < 0) v = -v;
    const vp = b.vPrev[w]!;
    const vf = vp + (v - vp) * kv;
    b.accel[w] = b.accel[w]! + ((vf - vp) / dt - b.accel[w]!) * ka;
    b.vPrev[w] = vf;
    if (wr.detached === 0 && wr.contact !== 0 && vf > vMax) vMax = vf;
  }
  // reference speed. With ESC fitted the ECU has an inertial sensor cluster and fuses it (body speed along the
  // heading); ABS-only: the fastest wheel inside a plausibility band (falls ≤ the tyres' friction limit;
  // while a wheel is cycling rises ≤ ABS_REF_ACCEL).
  if (brakesDef.esc === true) {
    const fr = vehicle.vehicle.frameNodes;
    let vxs = 0;
    let vzs = 0;
    for (let q = 0; q < 3; q++) {
      const i = vehicle.nodeStart + fr[q]!;
      vxs += state.velX[i]!;
      vzs += state.velZ[i]!;
    }
    const o = vehicle.nodeStart + fr[0]!;
    const f = vehicle.nodeStart + fr[1]!;
    let hx = state.posX[f]! - state.posX[o]!;
    let hz = state.posZ[f]! - state.posZ[o]!;
    const hl = Math.sqrt(hx * hx + hz * hz);
    let vb = 0;
    if (hl > 1e-6) vb = ((vxs * hx + vzs * hz) / hl) * (1 / 3);
    if (vb < 0) vb = -vb;
    b.vRef += (vb - b.vRef) * (dt / (IMU_TAU + dt));
  } else {
    b.vRef = wheelReference(b, vMax, dt, n);
  }
  const vRef = b.vRef;


  // ---- ESC: yaw rate from the frame heading, bicycle-model reference
  for (let w = 0; w < n; w++) b.esc[w] = 0;
  b.escActive = 0;
  {
    const fr = vehicle.vehicle.frameNodes;
    const o = vehicle.nodeStart + fr[0]!;
    const f = vehicle.nodeStart + fr[1]!;
    let hx = state.posX[f]! - state.posX[o]!;
    let hz = state.posZ[f]! - state.posZ[o]!;
    const hl = Math.sqrt(hx * hx + hz * hz);
    if (hl > 1e-6) {
      hx /= hl;
      hz /= hl;
      // + = turning right (toward +X from −Z): cross(prev, cur)_y < 0 for a right turn
      const cr = b.hx * hz - b.hz * hx;
      b.yawRate = b.hx === 0 && b.hz === 0 ? 0 : -cr / dt;
      b.hx = hx;
      b.hz = hz;
    }
    if (escOn && vRef > ESC_MIN_SPEED && dts.gear >= 0) {
      const steer = actions[Action.steer]!;
      const delta = steer * vehicle.vehicle.steering.maxWheelAngleDeg * (Math.PI / 180);
      let rRef = (vRef * delta) / (b.wheelbase * (1 + ESC_KUS * vRef * vRef));
      const rMax = (ESC_MU * 9.81) / vRef;
      if (rRef > rMax) rRef = rMax;
      else if (rRef < -rMax) rRef = -rMax;
      b.yawRef = rRef;
      const r = b.yawRate;
      const band = ESC_DEADBAND + ESC_DEADBAND_FRAC * (rRef < 0 ? -rRef : rRef);
      const err = r - rRef;
      const ea = err < 0 ? -err : err;
      if (ea > band) {
        let p = ESC_GAIN * (ea - band);
        if (p > ESC_MAX) p = ESC_MAX;
        const turnSign = rRef !== 0 ? (rRef > 0 ? 1 : -1) : r > 0 ? 1 : -1;
        // oversteer: |r| beyond the reference in the turn direction → brake the OUTER front;
        // understeer: short of it → brake the INNER rear.
        const over = (r - rRef) * turnSign > 0;
        for (let w = 0; w < n; w++) {
          const cw = wheels[w]!.wheel;
          if (!cw.braked) continue;
          const outer = b.side[w]! * turnSign < 0; // right turn (+): the left wheels are outer
          if (over ? cw.axle === 'front' && outer : cw.axle === 'rear' && !outer) b.esc[w] = p;
        }
        b.escActive = 1;
      }
    } else {
      b.yawRef = 0;
    }
  }

  // ---- front axle slip (EBD reference)
  let slipF = 0;
  let nF = 0;
  for (let w = 0; w < n; w++) {
    const wr = wheels[w]!;
    const v = b.vPrev[w]!;
    const lam = vRef > 0.5 ? (vRef - v) / vRef : 0;
    b.slip[w] = lam;
    if (wr.wheel.axle === 'front' && wr.contact !== 0) {
      slipF += lam;
      nF++;
    }
  }
  slipF = nF > 0 ? slipF / nF : 0;

  // ---- per wheel: master demand → ABS-limited caliper pressure → torque
  let anyAbs = false;
  const kLag = dt / (BRAKE_LAG_S + dt);
  for (let w = 0; w < n; w++) {
    const wr = wheels[w]!;
    const cw = wr.wheel;
    let demand = cw.braked && !(lineLock && cw.driven) ? pedal : 0;
    demand += b.esc[w]!;
    if (demand > 1) demand = 1;
    let p = b.pressure[w]!;
    const target = p + (demand - p) * kLag;
    b.cycleT[w] = b.cycleT[w]! + dt;
    if (absOn && cw.braked && vRef > ABS_MIN_SPEED && wr.contact !== 0 && demand > 0) {
      const lam = b.slip[w]!;
      const acc = b.accel[w]!;
      let ph = b.phase[w]!;
      const locking = lam > ABS_SLIP_HI || (acc < -ABS_DECEL_LOCK && lam > ABS_DECEL_MIN_SLIP);
      let pt = b.phaseT[w]! - dt;
      if (ph === PHASE_BUILD) {
        if (locking) {
          b.pMem[w] = p;
          ph = PHASE_DUMP;
          pt = ABS_DUMP_PULSE_S;
        }
      } else if (ph === PHASE_DUMP) {
        // one valve pulse, then hold and look at the wheel
        if (pt <= 0) {
          ph = PHASE_HOLD;
          pt = ABS_HOLD_CHECK_S;
        }
      } else if (lam < ABS_SLIP_LO) {
        ph = PHASE_BUILD;
      } else if (pt <= 0) {
        // still not re-accelerating while slipping: another dump pulse; recovering: keep holding
        if (acc < ABS_REACCEL && lam > ABS_DECEL_MIN_SLIP) {
          ph = PHASE_DUMP;
          pt = ABS_DUMP_PULSE_S;
        } else {
          pt = ABS_HOLD_CHECK_S;
        }
      }
      if (ph !== PHASE_BUILD) b.cycleT[w] = 0;
      b.phaseT[w] = pt;
      b.phase[w] = ph;
      if (ph === PHASE_DUMP) {
        p -= ABS_DUMP_RATE * dt;
        if (p < 0) p = 0;
        anyAbs = true;
      } else if (ph === PHASE_HOLD) {
        anyAbs = true;
        if (target < p) p = target;
      } else {
        // build: plain lag, but while cycling only fast up to ABS_FAST_REBUILD × the lock pressure, then a slow staircase
        let next = target;
        if (b.cycleT[w]! < ABS_CYCLE_S) {
          const knee = ABS_FAST_REBUILD * b.pMem[w]!;
          const slow = p + ABS_BUILD_RATE * dt;
          const cap = p < knee ? (knee > slow ? knee : slow) : slow;
          if (next > cap) next = cap;
        }
        // EBD: a rear wheel's pressure does not rise while it slips more than the front axle
        if (cw.axle === 'rear' && lam > slipF + EBD_MARGIN && next > p) next = p;
        p = next;
      }
    } else {
      b.phase[w] = PHASE_BUILD;
      p = target;
    }
    b.pressure[w] = p;
    const service = p * cw.brakeTorque;
    const hb = cw.handbrake ? hand * cw.handbrakeTorque : 0;
    wr.brakeTorque = service > hb ? service : hb;
  }
  if (anyAbs) b.absTimer = 0.2;
  else if (b.absTimer > 0) b.absTimer = b.absTimer > dt ? b.absTimer - dt : 0;
  b.absActive = b.absTimer > 0 ? 1 : 0;
}
