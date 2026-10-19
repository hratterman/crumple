/**
 * Drivetrain: engine, auto-clutch, gearbox, final drive, differential and
 * brakes. WORKER-ONLY (runs inside the 2 kHz step).
 *
 * stepDrivetrain only COMPUTES torques: it reads the driven wheels' ω
 * (estimated earlier in the tick), integrates the engine, and writes each
 * WheelRuntime's driveTorque / brakeTorque plus the cheap telemetry slots.
 * vehiclePreStep (runtime.ts) then applies them with applyWheelTorques.
 *
 * COUPLING (why it is stable at dt = 1/2000 with soft-body wheels):
 * the clutch and the locked/limited diff are torsional spring-dampers whose
 * gains are SCHEDULED from the reflected inertias, solved backward-Euler
 * ("implicit-ish") on a rigid two-inertia model:
 *   I_ref = Σ I_wheel / G²  (driven, attached wheels; G = ratio·finalDrive)
 *   I_m   = I_e·I_ref / (I_e + I_ref)        (relative-mode inertia)
 *   k = I_m·W², c = 2ζ·I_m·W,  W·dt = CLUTCH_W_DT
 *   Δ⁺ = Δ + dt·(T_eng/I_e − T/I_m),  T = k(θ + dt·Δ⁺) + c·Δ⁺
 *   ⇒ T = (kθ + (k·dt + c)(Δ + dt·T_eng/I_e)) / (1 + (k·dt + c)·dt/I_m)
 * then |T| ≤ clutch capacity; the windup θ integrates the measured slip Δ
 * and is clamped to ±capacity/k
 * (anti-windup), so slip → lock is one continuous law (no mode switch).
 * I_wheel counts only rim + tyre ring masses: the true reflected inertia
 * (car mass through grip) is larger, which only lowers the coupling's
 * natural frequency, so the minimum-inertia tuning is the conservative one.
 * The spring term gives zero steady-state slip when locked.
 *
 * NUMERICS: hot path uses only + − × ÷ (and an exact integer truncation for
 * the LUT index); zero allocation; fixed iteration order.
 */
import { Action } from '../../protocol/messages';
import { VehicleTelemetry } from '../../protocol/telemetry';
import type { SimState } from '../types';
import {
  DIFF_TYPE_ID,
  TORQUE_LUT_STEP_RPM,
  type CompiledDrivetrain,
  type CompiledVehicle,
  type DrivetrainState,
  type StepDrivetrain,
  type TransmissionMode,
  type VehicleRuntime,
} from './types';

/** rad/s → rpm. */
export const RPM_PER_RAD_S = 60 / (2 * Math.PI);
const RAD_S_PER_RPM = 1 / RPM_PER_RAD_S;

// ------------------------------------------------------------ tuning
/**
 * Clutch coupling natural frequency × dt (see header): 60 rad/s at 2 kHz.
 * Must stay well below the tyre-carcass torsional mode (~250–300 rad/s for
 * the 205/55R16 tuning): torque is applied to the TYRE ring but ω is
 * measured on the RIM, a non-collocated loop that limit-cycles (±capacity
 * clutch chatter) when the coupling is stiffer than the sidewall. Measured:
 * 0.15 chattered on the sedan, 0.03 is smooth.
 */
export const CLUTCH_W_DT = 0.03;
export const CLUTCH_ZETA = 0.7;
/** Diff coupling natural frequency × dt and damping ratio. */
export const DIFF_W_DT = 0.03;
export const DIFF_ZETA = 0.8;
/** Per-wheel torque cap of the locked diff's coupling, N·m. */
export const LOCKED_DIFF_MAX_TORQUE = 20000;
/** Downshift rev-match: throttle per rad/s of engine-speed deficit to the target gear. */
export const REV_MATCH_GAIN = 0.05;
/** Rev limiter hysteresis: fuel returns below revLimitRpm − this. */
export const REV_LIMIT_HYSTERESIS_RPM = 200;
/** Idle governor: full throttle this many rpm below idle (proportional). */
export const IDLE_GOVERNOR_BAND_RPM = 150;
/**
 * Auto-clutch (launch control). Engagement e = max(eEng, eRoad):
 *   eEng  = smoothstep over ENGINE rpm  [lo, idle·(AUTO_CLUTCH_LOCK + AUTO_CLUTCH_LAUNCH·thr)]
 *   eRoad = smoothstep over GEARBOX rpm [idle, max(idle·AUTO_CLUTCH_LOCK, lo)]
 *   lo = idle·(1.05 + AUTO_CLUTCH_LAUNCH_LO·thr)
 * so a launch slips at a throttle-dependent rpm (where throttle·T(rpm) =
 * capacity·e), and the clutch closes progressively as the road speed
 * catches up: it is fully engaged once the gearbox side alone is ≥ ~1.3×
 * idle (the road keeps the engine alive), and opens again near idle.
 */
export const AUTO_CLUTCH_LOCK = 1.3;
export const AUTO_CLUTCH_LAUNCH_LO = 0.8;
export const AUTO_CLUTCH_LAUNCH = 1.6;
/** Auto-clutch engagement low-pass time constant, s. */
export const AUTO_CLUTCH_TAU = 0.05;
/**
 * Traction control: reference speeds below this (m/s) use it as the slip
 * denominator, so a launch may spin the driven wheels by tcSlip·this.
 */
export const TC_MIN_REF_SPEED = 5;
/** TC never cuts below this × idle rpm (clutch slip handles the launch; cutting there bogged the engine). */
export const TC_RPM_FLOOR = 2.5;
/** Throttle cut per m/s of excess driven-wheel speed. */
export const TC_GAIN = 0.5;
/** Cut attack / release time constants, s. */
export const TC_ATTACK = 0.02;
export const TC_RELEASE = 0.15;
/** Minimum time between automatic shifts, s (anti-hunting). */
export const AUTO_SHIFT_COOLDOWN = 0.6;
/**
 * Part-throttle upshift point: autoShiftUpRpm is the FULL-throttle point;
 * at zero throttle the box upshifts at AUTO_UP_LIGHT·autoShiftDownRpm, lerped.
 */
export const AUTO_UP_LIGHT = 1.5;
/** Throttle at/above which a kickdown downshift is allowed. */
export const KICKDOWN_THROTTLE = 0.95;
/** Kickdown: shift down if the lower gear lands at ≤ this × autoShiftUpRpm. */
export const KICKDOWN_UP_FRACTION = 0.9;
/** Never downshift into a gear whose rpm would be above this × autoShiftUpRpm. */
export const DOWNSHIFT_MAX_UP_FRACTION = 0.9;
/** Never upshift into a gear whose rpm would be below this × autoShiftDownRpm. */
export const UPSHIFT_MIN_DOWN_FRACTION = 1.05;

// ------------------------------------------------------------ torque LUT
/**
 * Samples a (rpm, N·m) curve every `stepRpm` from 0 to the last point
 * (inclusive, rounded up) with linear interpolation; clamped at both ends.
 * Not a hot path.
 */
export function buildTorqueLut(curve: readonly (readonly [number, number])[], stepRpm = TORQUE_LUT_STEP_RPM): Float64Array {
  if (curve.length < 1) throw new RangeError('torqueCurve needs at least one point');
  if (!(stepRpm > 0)) throw new RangeError('stepRpm must be > 0');
  for (let i = 1; i < curve.length; i++) {
    if (!(curve[i]![0] > curve[i - 1]![0])) throw new RangeError('torqueCurve rpm must be strictly ascending');
  }
  const last = curve[curve.length - 1]![0];
  const n = Math.max(2, Math.ceil(last / stepRpm) + 1);
  const lut = new Float64Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const rpm = i * stepRpm;
    if (rpm <= curve[0]![0]) {
      lut[i] = curve[0]![1];
      continue;
    }
    if (rpm >= last) {
      lut[i] = curve[curve.length - 1]![1];
      continue;
    }
    while (curve[seg + 1]![0] < rpm) seg++;
    const [r0, t0] = curve[seg]!;
    const [r1, t1] = curve[seg + 1]!;
    lut[i] = t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
  }
  return lut;
}

/** LUT lookup with linear interpolation, clamped at both ends. Hot path. */
export function sampleTorqueLut(lut: Float64Array, stepRpm: number, rpm: number): number {
  const last = lut.length - 1;
  if (!(rpm > 0)) return lut[0]!;
  const x = rpm / stepRpm;
  const i = x | 0; // x > 0 and far below 2^31: truncation == floor
  if (i >= last) return lut[last]!;
  const a = lut[i]!;
  return a + (lut[i + 1]! - a) * (x - i);
}

// ------------------------------------------------------------ state
/**
 * DrivetrainState plus private integrator state. createDrivetrainState is the
 * only constructor; VehicleRuntime.drivetrain always holds one of these.
 */
export interface DrivetrainStateEx extends DrivetrainState {
  /** Filtered auto-clutch engagement 0..1. */
  autoEngage: number;
  /** Traction-control throttle cut 0..1 (low-passed). */
  tcCut: number;
  /** Clutch spring windup, rad (engine side). */
  clutchWind: number;
  /** Clutch torque this tick, N·m (+ drives the wheels forward in a forward gear). */
  clutchTorque: number;
  /** Gearbox input ω (ratio·finalDrive·mean driven ω), rad/s. */
  gearboxOmega: number;
  /** s until the next automatic shift may start. */
  shiftCooldown: number;
  /** Gear engaged when the current shift started. */
  shiftFrom: number;
  /** Per wheel (VehicleDef order) rotational inertia about the axle, kg·m². */
  wheelInertia: Float64Array;
  /** Locked-diff angle deviation per wheel, rad. */
  diffPhi: Float64Array;
}

/**
 * Fresh drivetrain at idle in neutral. `wheelInertia` (per wheel, kg·m²) comes
 * from computeWheelInertia; tests may pass their own.
 */
export function createDrivetrainState(
  dt: CompiledDrivetrain,
  wheelInertia: Float64Array,
  mode: TransmissionMode = dt.transmission,
): DrivetrainStateEx {
  return {
    engineOmega: dt.idleRpm * RAD_S_PER_RPM,
    rpm: dt.idleRpm,
    gear: 0,
    transmission: mode,
    shiftTimer: 0,
    targetGear: 0,
    clutch: 1,
    throttle: 0,
    revLimiterActive: false,
    engineTorque: 0,
    driveTorque: 0,
    autoEngage: 0,
    tcCut: 0,
    clutchWind: 0,
    clutchTorque: 0,
    gearboxOmega: 0,
    shiftCooldown: 0,
    shiftFrom: 0,
    wheelInertia,
    diffPhi: new Float64Array(wheelInertia.length),
  };
}

/** Restores a state in place to createDrivetrainState values (keeps the transmission mode). */
export function resetDrivetrainState(s: DrivetrainStateEx, dt: CompiledDrivetrain): void {
  s.engineOmega = dt.idleRpm * RAD_S_PER_RPM;
  s.rpm = dt.idleRpm;
  s.gear = 0;
  s.shiftTimer = 0;
  s.targetGear = 0;
  s.clutch = 1;
  s.throttle = 0;
  s.revLimiterActive = false;
  s.engineTorque = 0;
  s.driveTorque = 0;
  s.autoEngage = 0;
  s.tcCut = 0;
  s.clutchWind = 0;
  s.clutchTorque = 0;
  s.gearboxOmega = 0;
  s.shiftCooldown = 0;
  s.shiftFrom = 0;
  s.diffPhi.fill(0);
}

/**
 * Rotational inertia of each wheel about its axle from the compiled rig's
 * rest geometry and post-MINIMASS masses (rim + tyre ring nodes; hubs sit on
 * the axis). Spawn-time only.
 */
export function computeWheelInertia(vehicle: CompiledVehicle): Float64Array {
  const out = new Float64Array(vehicle.wheels.length);
  const p = vehicle.rig.nodePos;
  const inv = vehicle.rig.nodeInvMass;
  for (let w = 0; w < vehicle.wheels.length; w++) {
    const wh = vehicle.wheels[w]!;
    const ix = wh.hubI;
    const ox = wh.hubO;
    const cx = (p[3 * ix]! + p[3 * ox]!) / 2;
    const cy = (p[3 * ix + 1]! + p[3 * ox + 1]!) / 2;
    const cz = (p[3 * ix + 2]! + p[3 * ox + 2]!) / 2;
    let ax = p[3 * ox]! - p[3 * ix]!;
    let ay = p[3 * ox + 1]! - p[3 * ix + 1]!;
    let az = p[3 * ox + 2]! - p[3 * ix + 2]!;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    let I = 0;
    const ring = 2 * wh.rays;
    for (const start of [wh.rimStart, wh.tireStart]) {
      for (let k = 0; k < ring; k++) {
        const n = start + k;
        const im = inv[n]!;
        if (!(im > 0)) continue;
        const dx = p[3 * n]! - cx;
        const dy = p[3 * n + 1]! - cy;
        const dz = p[3 * n + 2]! - cz;
        const along = dx * ax + dy * ay + dz * az;
        const r2 = dx * dx + dy * dy + dz * dz - along * along;
        I += r2 / im;
      }
    }
    out[w] = I > 1e-6 ? I : 1e-6;
  }
  return out;
}

// ------------------------------------------------------------ helpers
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** C1 smoothstep of x over [e0, e1] (arithmetic only). */
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function startShift(s: DrivetrainStateEx, target: number, shiftTimeS: number): void {
  s.shiftFrom = s.gear;
  s.targetGear = target;
  s.clutchWind = 0;
  if (shiftTimeS > 0) {
    s.shiftTimer = shiftTimeS;
  } else {
    s.gear = target;
    s.shiftTimer = 0;
  }
  s.shiftCooldown = AUTO_SHIFT_COOLDOWN;
}

/**
 * Picks the gear the box should be heading to (or −2 for "no change").
 * `rpmG` = gearbox-side rpm in the CURRENT gear (from wheel speed).
 */
function chooseGear(
  s: DrivetrainStateEx,
  d: CompiledDrivetrain,
  select: number,
  throttle: number,
  rpmG: number,
): number {
  const n = d.gearCount;
  if (s.transmission === 'manual') {
    let g = select;
    if (g < -1) g = -1;
    if (g > n) g = n;
    return g;
  }
  // auto: −1 R, 0 N, ≥ 1 Drive
  if (select < 0) return -1;
  if (select === 0) return 0;
  const g = s.gear;
  if (g < 1) return 1;
  if (s.shiftCooldown > 0) return g;
  const table = d.gearRatioTable;
  const r = table[g + 1]!;
  const upLight = d.autoShiftDownRpm * AUTO_UP_LIGHT;
  const up = upLight < d.autoShiftUpRpm ? upLight + (d.autoShiftUpRpm - upLight) * throttle : d.autoShiftUpRpm;
  if (g < n && rpmG >= up) {
    const rpmNext = (rpmG * table[g + 2]!) / r;
    if (rpmNext >= d.autoShiftDownRpm * UPSHIFT_MIN_DOWN_FRACTION) return g + 1;
  }
  if (g > 1) {
    const rpmPrev = (rpmG * table[g]!) / r;
    if (rpmPrev <= d.autoShiftUpRpm * DOWNSHIFT_MAX_UP_FRACTION) {
      if (rpmG <= d.autoShiftDownRpm) return g - 1;
      if (throttle >= KICKDOWN_THROTTLE && rpmPrev <= d.autoShiftUpRpm * KICKDOWN_UP_FRACTION) return g - 1;
    }
  }
  return g;
}

// ------------------------------------------------------------ step
/**
 * One drivetrain tick. Reads `actions` and every wheel's `omega`/`detached`
 * (set earlier this tick), integrates the engine, and writes per-wheel
 * driveTorque (signed, + forward) / brakeTorque (magnitude) for
 * applyWheelTorques, plus telemetry slots rpm, gear, applied pedals/steer/
 * clutch, engineTorque and driveTorque into `telemetryOut`. `state` is unused
 * (wheel ω is already estimated) and kept for the frozen signature.
 */
export const stepDrivetrain: StepDrivetrain = (
  _state: SimState,
  vehicle: VehicleRuntime,
  actions: Float64Array,
  dt: number,
  telemetryOut: Float32Array,
): void => {
  const s = vehicle.drivetrain as DrivetrainStateEx;
  const d = vehicle.vehicle.drivetrain;
  const wheels = vehicle.wheels;
  const driven = d.drivenWheels;
  const inertia = s.wheelInertia;

  const pedalThrottle = clamp01(actions[Action.throttle]!);
  const brake = clamp01(actions[Action.brake]!);
  const handbrake = clamp01(actions[Action.handbrake]!);
  const pedalClutch = clamp01(actions[Action.clutch]!);
  const select = actions[Action.gearSelect]!;

  // ---- driven-wheel speed (open-diff speed averaging over attached wheels)
  let nAttached = 0;
  let omegaSum = 0;
  let inertiaSum = 0;
  for (let j = 0; j < driven.length; j++) {
    const w = driven[j]!;
    const wr = wheels[w]!;
    if (wr.detached !== 0) continue;
    nAttached++;
    omegaSum += wr.omega;
    inertiaSum += inertia[w]!;
  }
  const omegaMean = nAttached > 0 ? omegaSum / nAttached : 0;

  // ---- gearbox / shifting
  if (s.shiftCooldown > 0) s.shiftCooldown = s.shiftCooldown > dt ? s.shiftCooldown - dt : 0;
  const halfShift = d.shiftTimeS * 0.5;
  let shiftOpen = 0; // clutch opening forced by the shift, 0..1
  let shiftCut = false;
  if (s.shiftTimer > 0) {
    s.shiftTimer -= dt;
    if (s.shiftTimer <= 0) {
      s.shiftTimer = 0;
      s.gear = s.targetGear;
    } else if (s.shiftTimer <= halfShift) {
      if (s.gear !== s.targetGear) {
        s.gear = s.targetGear;
        s.clutchWind = 0;
      }
      shiftOpen = s.shiftTimer / halfShift; // re-engage ramp over the second half
    } else {
      shiftOpen = 1;
      // Torque cut on upshifts (and into neutral); downshifts keep the pedal (rev-match/kickdown).
      shiftCut = !(s.targetGear > 0 && s.shiftFrom > 0 && s.targetGear < s.shiftFrom);
    }
  }
  const table = d.gearRatioTable;
  const fd = d.finalDrive;
  if (s.shiftTimer === 0) {
    const gCur = table[s.gear + 1]! * fd;
    let rpmG = gCur * omegaMean * RPM_PER_RAD_S;
    if (rpmG < 0) rpmG = -rpmG;
    const target = chooseGear(s, d, select, pedalThrottle, rpmG);
    if (target !== s.gear) startShift(s, target, d.shiftTimeS);
    if (s.shiftTimer > 0) {
      shiftOpen = 1;
      shiftCut = !(target > 0 && s.shiftFrom > 0 && target < s.shiftFrom);
    }
  }
  const G = table[s.gear + 1]! * fd;
  const omegaG = G * omegaMean;
  s.gearboxOmega = omegaG;

  // ---- throttle: driver → shift cut → rev limiter → idle governor
  const idle = d.idleRpm;
  const rpm = s.engineOmega * RPM_PER_RAD_S;
  if (s.revLimiterActive) {
    if (rpm < d.revLimitRpm - REV_LIMIT_HYSTERESIS_RPM) s.revLimiterActive = false;
  } else if (rpm >= d.revLimitRpm) {
    s.revLimiterActive = true;
  }
  let throttle = shiftCut ? 0 : pedalThrottle;
  // Downshift rev-match blip while the clutch is open (first half of the shift).
  if (shiftOpen === 1 && !shiftCut && s.targetGear > 0) {
    const wTarget = table[s.targetGear + 1]! * fd * omegaMean;
    const blip = clamp01((wTarget - s.engineOmega) * REV_MATCH_GAIN);
    if (blip > throttle) throttle = blip;
  }
  // Traction control: compare the fastest driven wheel's rolling speed with
  // the undriven (reference) wheels' mean, cut throttle on the excess.
  if (d.tcSlip > 0) {
    let target = 0;
    if (s.gear > 0 && throttle > 0 && rpm > idle * TC_RPM_FLOOR) {
      let vRef = 0;
      let nRef = 0;
      let vDrv = -Infinity;
      for (let w = 0; w < wheels.length; w++) {
        const wr = wheels[w]!;
        if (wr.detached !== 0) continue;
        const v = wr.omega * wr.rollRadius;
        if (wr.wheel.driven) {
          if (v > vDrv) vDrv = v;
        } else if (wr.contact !== 0) {
          vRef += v;
          nRef++;
        }
      }
      if (nRef > 0 && vDrv > -Infinity) {
        vRef /= nRef;
        const den = vRef > TC_MIN_REF_SPEED ? vRef : TC_MIN_REF_SPEED;
        const excess = vDrv - vRef - d.tcSlip * den;
        if (excess > 0) target = excess * TC_GAIN > 1 ? 1 : excess * TC_GAIN;
      }
    }
    const tau = target > s.tcCut ? TC_ATTACK : TC_RELEASE;
    s.tcCut += (target - s.tcCut) * (dt / (tau + dt));
    throttle *= 1 - s.tcCut;
  }
  if (s.revLimiterActive) throttle = 0;
  const gov = clamp01((idle - rpm) / IDLE_GOVERNOR_BAND_RPM);
  if (gov > throttle) throttle = gov;

  // ---- engine torque
  const full = sampleTorqueLut(d.torqueLut, d.lutStepRpm, rpm);
  let rr = rpm / d.redlineRpm;
  rr = rr < 0 ? 0 : rr > 1 ? 1 : rr;
  const tEng = throttle * full - (1 - throttle) * d.engineBrakeTorque * rr;

  // ---- auto-clutch (engagement target, low-passed)
  const rpmGSigned = omegaG * RPM_PER_RAD_S;
  const lo = idle * (1.05 + AUTO_CLUTCH_LAUNCH_LO * pedalThrottle);
  const roadLock = idle * AUTO_CLUTCH_LOCK;
  const eRoad = smooth(idle, roadLock > lo ? roadLock : lo, rpmGSigned);
  const eEng = smooth(lo, idle * (AUTO_CLUTCH_LOCK + AUTO_CLUTCH_LAUNCH * pedalThrottle), rpm);
  const eTarget = eRoad > eEng ? eRoad : eEng;
  const alpha = dt / (AUTO_CLUTCH_TAU + dt);
  s.autoEngage += (eTarget - s.autoEngage) * alpha;
  let applied = 1 - s.autoEngage;
  if (pedalClutch > applied) applied = pedalClutch;
  if (shiftOpen > applied) applied = shiftOpen;
  s.clutch = applied;

  // ---- clutch coupling (implicit spring-damper, see header)
  const Ie = d.engineInertia;
  const cap = d.clutchMaxTorque * (1 - applied);
  let tClutch = 0;
  if (G !== 0 && nAttached > 0 && cap > 0) {
    const Iref = inertiaSum / (G * G);
    const Im = (Ie * Iref) / (Ie + Iref);
    const W = CLUTCH_W_DT / dt;
    const k = Im * W * W;
    const c = 2 * CLUTCH_ZETA * Im * W;
    const kc = k * dt + c;
    const delta = s.engineOmega - omegaG;
    tClutch = (k * s.clutchWind + kc * (delta + (dt * tEng) / Ie)) / (1 + (kc * dt) / Im);
    if (tClutch > cap) tClutch = cap;
    else if (tClutch < -cap) tClutch = -cap;
    // Windup integrates the MEASURED slip: the prediction above assumes the
    // minimum inertia, so integrating it would leave a steady slip when the
    // real (car-loaded) inertia is larger.
    let wind = s.clutchWind + dt * delta;
    const wMax = cap / k;
    if (wind > wMax) wind = wMax;
    else if (wind < -wMax) wind = -wMax;
    s.clutchWind = wind;
  } else {
    s.clutchWind = 0;
  }
  s.clutchTorque = tClutch;

  // ---- engine integration
  let we = s.engineOmega + (dt * (tEng - tClutch)) / Ie;
  const weMax = (d.revLimitRpm * 1.5) * RAD_S_PER_RPM;
  if (we < 0) we = 0;
  else if (we > weMax) we = weMax;
  s.engineOmega = we;
  s.rpm = we * RPM_PER_RAD_S;
  s.throttle = throttle;
  s.engineTorque = tEng;

  // ---- differential
  const tWheels = tClutch * G;
  s.driveTorque = nAttached > 0 ? tWheels : 0;
  for (let w = 0; w < wheels.length; w++) wheels[w]!.driveTorque = 0;
  if (nAttached > 0) {
    const share = tWheels / nAttached;
    const phi = s.diffPhi;
    if (d.diff === DIFF_TYPE_ID.open || nAttached === 1) {
      for (let j = 0; j < driven.length; j++) {
        const w = driven[j]!;
        if (wheels[w]!.detached === 0) wheels[w]!.driveTorque = share;
        phi[w] = 0;
      }
    } else {
      const W = DIFF_W_DT / dt;
      const locked = d.diff === DIFF_TYPE_ID.locked;
      const capD = locked ? LOCKED_DIFF_MAX_TORQUE : d.diffLockTorque;
      let mean = 0;
      for (let j = 0; j < driven.length; j++) {
        const w = driven[j]!;
        const wr = wheels[w]!;
        if (wr.detached !== 0) {
          phi[w] = 0;
          continue;
        }
        const I = inertia[w]!;
        const k = locked ? I * W * W : 0;
        const c = 2 * DIFF_ZETA * I * W;
        const kc = k * dt + c;
        const delta = wr.omega - omegaMean;
        let t = -(k * phi[w]! + kc * delta) / (1 + (kc * dt) / I);
        if (t > capD) t = capD;
        else if (t < -capD) t = -capD;
        if (locked) {
          let p = phi[w]! + dt * delta;
          const pMax = capD / k;
          if (p > pMax) p = pMax;
          else if (p < -pMax) p = -pMax;
          phi[w] = p;
        } else {
          phi[w] = 0;
        }
        wr.driveTorque = t;
        mean += t;
      }
      mean /= nAttached;
      // Remove any net from the per-wheel caps: the diff only REDISTRIBUTES.
      for (let j = 0; j < driven.length; j++) {
        const wr = wheels[driven[j]!]!;
        if (wr.detached === 0) wr.driveTorque = share + wr.driveTorque - mean;
      }
    }
  }

  // ---- brakes (service with bias, handbrake; wheel gets the max)
  for (let w = 0; w < wheels.length; w++) {
    const wr = wheels[w]!;
    const cw = wr.wheel;
    const sb = brake * cw.brakeTorque;
    const hb = handbrake * cw.handbrakeTorque;
    wr.brakeTorque = sb > hb ? sb : hb;
  }

  // ---- telemetry (cheap slots)
  const T = VehicleTelemetry;
  telemetryOut[T.engineRpm] = s.rpm;
  telemetryOut[T.gear] = s.gear;
  telemetryOut[T.throttle] = throttle;
  telemetryOut[T.brake] = brake;
  telemetryOut[T.steer] = actions[Action.steer]!;
  telemetryOut[T.clutch] = applied;
  telemetryOut[T.handbrake] = handbrake;
  telemetryOut[T.engineTorque] = tEng;
  telemetryOut[T.driveTorque] = s.driveTorque;
};
