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
/** R-PHYS: idle controller authority (throttle-equivalent), see the governor in stepDrivetrain. */
export const IDLE_GOVERNOR_MAX = 0.4;
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
/**
 * Traction control is a PI controller on the excess driven-wheel speed
 * (m/s): cut = TC_GAIN·e + ∫TC_KI·e dt (integral clamped to [0, 1]), the
 * excess first low-passed (TC_FILTER) and the cut slewed (TC_ATTACK /
 * TC_RELEASE). WHY: the old proportional cut (0.5 per m/s, 20 ms attack,
 * 150 ms release) limit-cycled at ~6 Hz with the tyre's stick-slip (a
 * sawtooth throttle and ±2–3 m/s² of surging on every launch); the integral
 * settles on the cut that holds the slip instead of hunting around it.
 */
export const TC_GAIN = 0.15;
export const TC_KI = 1.2;
export const TC_FILTER = 0.03;
/** Cut attack / release time constants, s. */
export const TC_ATTACK = 0.03;
export const TC_RELEASE = 0.06;
/**
 * POWER-ON UPSHIFT (clutch-to-clutch, like a torque-converter automatic or a
 * DCT): the new ratio is selected at once and the clutch slips at the
 * torque that keeps the wheel torque where it was (and always
 * Ie·UPSHIFT_MIN_DECEL above the engine torque) while the throttle is
 * retarded to UPSHIFT_TORQUE_FACTOR, so the clutch pulls the engine down to
 * the new gear's speed with the wheels still driven; the throttle returns
 * as the slip falls through UPSHIFT_RAMP_SLIP, so the clutch locks
 * (slip < UPSHIFT_SYNC_RAD_S) onto a driven engine. WHY: the old upshift opened the clutch for half the shift
 * time (zero drive torque: the car pitched and the tyres' wound-up carcass
 * snapped back, −5 m/s²) and then re-closed it on an engine ~2000 rpm above
 * the new gear (its flywheel energy dumped into the tyres: a 2× torque spike
 * and wheelspin) — the "jittery acceleration" at every gear change.
 * Downshifts keep the open-clutch rev-matched shift.
 */
export const UPSHIFT_TORQUE_FACTOR = 0.3;
/** Launch control engine speed (× idle) and its throttle band (rpm). */
export const LAUNCH_RPM_FACTOR = 4;
export const LAUNCH_RPM_BAND = 800;
/** Launch control fades out between these road speeds, m/s. */
export const LAUNCH_FADE_LO = 3;
export const LAUNCH_FADE_HI = 7;
/** Launch control clutch limit: this × the driven tyres' μ·load·r. */
export const LAUNCH_TRACTION_MARGIN = 0.9;
/** Low-pass time constant of the launch control's traction estimate, s. */
export const LAUNCH_TRACTION_TAU = 0.4;
/** The inertia phase clutch capacity always exceeds the engine torque by Ie × this (rad/s²): synchronisation is guaranteed. */
export const UPSHIFT_MIN_DECEL = 600;
/** Throttle comes back while the slip falls below this (rad/s), so the clutch locks onto a driven engine (no dip). */
export const UPSHIFT_RAMP_SLIP = 60;
/** Inertia phase never lasts longer than this (then the clutch locks anyway), s. */
export const UPSHIFT_MAX_S = 1;
/** Engine-to-gearbox slip at which the inertia phase ends (clutch locks), rad/s. */
export const UPSHIFT_SYNC_RAD_S = 3;
/**
 * LINE LOCK (burnouts, P5): with traction control OFF, throttle and service
 * brake both ≥ LINE_LOCK_PEDAL in a forward gear while the undriven wheels
 * roll slower than LINE_LOCK_SPEED m/s, the driven wheels' SERVICE brakes are
 * released (the undriven ones hold the car; the handbrake still acts).
 */
export const LINE_LOCK_PEDAL = 0.5;
export const LINE_LOCK_SPEED = 3;
/** Minimum time between automatic shifts, s (anti-hunting). */
export const AUTO_SHIFT_COOLDOWN = 0.6;
/**
 * Part-throttle upshift point: autoShiftUpRpm is the FULL-throttle point;
 * at zero throttle the box upshifts at AUTO_UP_LIGHT·autoShiftDownRpm, lerped.
 */
export const AUTO_UP_LIGHT = 1.5;
/**
 * R-PHYS economy schedule: at light throttle the DOWNSHIFT point falls from
 * autoShiftDownRpm (at ECO_THROTTLE and above) to ECO_DOWN_IDLE × idle (at
 * zero throttle), and the light upshift point follows it (× AUTO_UP_LIGHT),
 * so a cruising automatic sits in top gear at 1500–2500 rpm like a real one
 * (it held 3300 rpm in 5th at 100 km/h: 10 L/100 km instead of ≈ 6.5).
 */
export const ECO_DOWN_IDLE = 1.5;
export const ECO_THROTTLE = 0.6;
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
  /** Line lock engaged this tick (driven wheels' service brakes released; see LINE_LOCK_PEDAL). */
  lineLock: boolean;
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
  /** Power-on upshift phase: 0 none, 1 inertia phase (clutch slipping onto the new ratio). */
  upshift: number;
  /** Clutch capacity held during the inertia phase, N·m. */
  upshiftCap: number;
  /** Inertia phase elapsed / UPSHIFT_MAX_S. */
  upshiftRamp: number;
  /** TC integral term and filtered excess (m/s). */
  tcI: number;
  tcExcess: number;
  /** Launch control: low-passed driven-tyre traction torque μ·load·r, N·m (0 = not launching). */
  launchTrac: number;
  /** Per wheel (VehicleDef order) rotational inertia about the axle, kg·m². */
  wheelInertia: Float64Array;
  /** Locked-diff angle deviation per wheel, rad. */
  diffPhi: Float64Array;
  /** R-PHYS driver assists (setAssists): ABS / ESC switched on (effective only when BrakesDef fits them). */
  abs: boolean;
  esc: boolean;
  /** ESC engine torque reduction request 0..1 (brakes.ts, applied next tick). */
  escCut: number;
  /** R-PHYS engine systems (engineSystems.ts): 1 running / 0 off (stalled, out of fuel, seized). */
  engineOn: number;
  /** Over-temperature derate of the full-load torque, 0..1. */
  powerFactor: number;
  /** Starter engaged this tick (1), seized engine (1: locked at 0 rpm). */
  cranking: number;
  seized: number;
  /** Starter torque limit, N·m. */
  starterTorque: number;
  /** Clutch assist (setAssists): true = automatic clutch in every mode; false = a manual box uses the clutch pedal only (it can stall). */
  clutchAssist: boolean;
}

/** Starter target speed, rpm (engineSystems.ts CRANK_RPM). */
export const STARTER_RPM = 250;

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
    tractionControl: true,
    autoEngage: 0,
    tcCut: 0,
    lineLock: false,
    clutchWind: 0,
    clutchTorque: 0,
    gearboxOmega: 0,
    shiftCooldown: 0,
    shiftFrom: 0,
    upshift: 0,
    upshiftCap: 0,
    upshiftRamp: 0,
    tcI: 0,
    tcExcess: 0,
    launchTrac: 0,
    wheelInertia,
    diffPhi: new Float64Array(wheelInertia.length),
    abs: true,
    esc: true,
    escCut: 0,
    engineOn: 1,
    powerFactor: 1,
    cranking: 0,
    seized: 0,
    starterTorque: 60,
    clutchAssist: true,
  };
}

/** Restores a state in place to createDrivetrainState values (keeps the transmission mode and the assists). */
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
  s.lineLock = false;
  s.clutchWind = 0;
  s.clutchTorque = 0;
  s.gearboxOmega = 0;
  s.shiftCooldown = 0;
  s.shiftFrom = 0;
  s.upshift = 0;
  s.upshiftCap = 0;
  s.upshiftRamp = 0;
  s.tcI = 0;
  s.tcExcess = 0;
  s.launchTrac = 0;
  s.escCut = 0;
  s.engineOn = 1;
  s.powerFactor = 1;
  s.cranking = 0;
  s.seized = 0;
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

function startShift(s: DrivetrainStateEx, target: number, shiftTimeS: number, table: Float64Array): void {
  s.shiftFrom = s.gear;
  s.targetGear = target;
  s.clutchWind = 0;
  if (shiftTimeS > 0 && target > s.gear && s.gear > 0) {
    // power-on upshift: new ratio now; the clutch slips at the torque that keeps the WHEEL torque where it
    // was (clutch torque × old / new ratio; applyClutch adds the sync minimum), see UPSHIFT_*
    const t = s.clutchTorque > 0 ? s.clutchTorque : 0;
    s.upshiftCap = (t * table[s.gear + 1]!) / table[target + 1]!;
    s.gear = target;
    s.upshift = 1;
    s.upshiftRamp = 0;
    s.shiftTimer = 0;
  } else if (shiftTimeS > 0) {
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
  const table = d.gearRatioTable;
  const r = table[g + 1]!;
  const ecoLo = d.idleRpm * ECO_DOWN_IDLE;
  const down = ecoLo < d.autoShiftDownRpm ? ecoLo + (d.autoShiftDownRpm - ecoLo) * clamp01(throttle / ECO_THROTTLE) : d.autoShiftDownRpm;
  // closed-throttle coast-down shifts are not rate-limited (the box steps down through the gears as the car
  // stops, ending in 1st), everything else waits for the cooldown
  if (s.shiftCooldown > 0 && !(throttle < 0.05 && g > 1 && rpmG <= down)) return g;
  const upLight = down * AUTO_UP_LIGHT;
  const up = upLight < d.autoShiftUpRpm ? upLight + (d.autoShiftUpRpm - upLight) * throttle : d.autoShiftUpRpm;
  if (g < n && rpmG >= up) {
    const rpmNext = (rpmG * table[g + 2]!) / r;
    if (rpmNext >= down * UPSHIFT_MIN_DOWN_FRACTION) return g + 1;
  }
  if (g > 1) {
    const rpmPrev = (rpmG * table[g]!) / r;
    if (rpmPrev <= d.autoShiftUpRpm * DOWNSHIFT_MAX_UP_FRACTION) {
      if (rpmG <= down) return g - 1;
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
    if (target !== s.gear) startShift(s, target, d.shiftTimeS, table);
    if (s.shiftTimer > 0) {
      shiftOpen = 1;
      shiftCut = !(target > 0 && s.shiftFrom > 0 && target < s.shiftFrom);
    }
  }
  // Power-on upshift: inertia phase until the engine is synchronised with the new ratio (≤ UPSHIFT_MAX_S).
  let upFactor = 1;
  if (s.upshift === 1) {
    s.upshiftRamp += dt / UPSHIFT_MAX_S;
    const slip = s.engineOmega - table[s.gear + 1]! * fd * omegaMean;
    if (slip < UPSHIFT_SYNC_RAD_S || s.upshiftRamp >= 1) {
      s.upshift = 0;
      s.upshiftRamp = 0;
    } else {
      const r = 1 - (slip < UPSHIFT_RAMP_SLIP ? slip / UPSHIFT_RAMP_SLIP : 1);
      upFactor = UPSHIFT_TORQUE_FACTOR + (1 - UPSHIFT_TORQUE_FACTOR) * r;
    }
  }
  if (s.gear <= 0 || s.shiftTimer > 0) s.upshift = 0;
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
  let throttle = shiftCut ? 0 : pedalThrottle * upFactor;
  // Downshift rev-match blip while the clutch is open (first half of the shift).
  if (shiftOpen === 1 && !shiftCut && s.targetGear > 0) {
    const wTarget = table[s.targetGear + 1]! * fd * omegaMean;
    const blip = clamp01((wTarget - s.engineOmega) * REV_MATCH_GAIN);
    if (blip > throttle) throttle = blip;
  }
  let tcThrottleShare = 1;
  // Launch control state: road speed from the undriven wheels, fade 0 (launch) → 1 (rolling). Active with TC
  // on, and always on a car without TC (its auto box launches like a torque converter: it never dumps the
  // clutch); TC off on a car that has it = raw launches and burnouts.
  let launchFade = 1;
  let tTrac = 0;
  if ((d.tcSlip > 0 ? s.tractionControl : true) && s.gear > 0) {
    let vRoad = 0;
    let nR = 0;
    for (let w = 0; w < wheels.length; w++) {
      const wr = wheels[w]!;
      if (wr.wheel.driven || wr.detached !== 0) continue;
      const v = wr.omega * wr.rollRadius;
      vRoad += v < 0 ? -v : v;
      nR++;
    }
    if (nR > 0) launchFade = smooth(LAUNCH_FADE_LO, LAUNCH_FADE_HI, vRoad / nR);
    // driven tyres' traction torque μ·load·r; none on the ground (airborne, lifted): no launch control
    for (let j = 0; j < driven.length; j++) {
      const wr = wheels[driven[j]!]!;
      if (wr.detached === 0) tTrac += wr.wheel.friction * wr.load * wr.rollRadius;
    }
    if (!(tTrac > 0)) launchFade = 1;
  }
  // Traction control: compare the fastest driven wheel's rolling speed with
  // the undriven (reference) wheels' mean, cut throttle on the excess.
  if (d.tcSlip > 0 && s.tractionControl) {
    let target = 0;
    if (s.gear > 0 && throttle > 0) {
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
        s.tcExcess += (excess - s.tcExcess) * (dt / (TC_FILTER + dt));
        const e = s.tcExcess;
        let ii = s.tcI + TC_KI * e * dt;
        ii = ii < 0 ? 0 : ii > 1 ? 1 : ii;
        s.tcI = ii;
        const u = TC_GAIN * e + ii;
        target = u < 0 ? 0 : u > 1 ? 1 : u;
      }
    } else {
      // inactive (lifted, neutral, low rpm): the integral bleeds off
      s.tcI *= 1 - dt / TC_RELEASE;
      s.tcExcess = 0;
    }
    const tau = target > s.tcCut ? TC_ATTACK : TC_RELEASE;
    s.tcCut += (target - s.tcCut) * (dt / (tau + dt));
    // Above TC_RPM_FLOOR·idle the cut retards the engine; below it (a launch, the clutch still slipping) it
    // opens the clutch instead (cutting the throttle there bogged the engine), blended over 1–1.3× the floor.
    tcThrottleShare = smooth(idle * TC_RPM_FLOOR, idle * TC_RPM_FLOOR * 1.3, rpm);
    throttle *= 1 - s.tcCut * tcThrottleShare;
  } else {
    s.tcCut = 0;
    s.tcI = 0;
    s.tcExcess = 0;
  }
  if (s.escCut > 0) throttle *= 1 - s.escCut;
  // R-PHYS electronic top-speed governor (DrivetrainDef.speedLimitKmh): fades the throttle over the last 2 m/s
  const vLim = d.speedLimit;
  if (vLim !== undefined && vLim > 0 && nAttached > 0) {
    const vd = omegaMean * wheels[driven[0]!]!.rollRadius;
    const g = (vLim - (vd < 0 ? -vd : vd)) * 0.5;
    if (g < 1) throttle *= g > 0 ? g : 0;
  }
  if (s.revLimiterActive) throttle = 0;
  // Launch control holds the engine near LAUNCH_RPM_FACTOR × idle while the clutch slips (from the limiter
  // the flywheel dumped its energy into the tyres when the clutch locked: wheelspin, TC cut, surging).
  if (launchFade < 1) {
    const rpmL = idle * LAUNCH_RPM_FACTOR;
    let lim = (rpmL - rpm) / LAUNCH_RPM_BAND;
    lim = lim < 0 ? 0 : lim > 1 ? 1 : lim;
    lim = lim + (1 - lim) * launchFade;
    if (throttle > lim) throttle = lim;
  }
  const running = s.engineOn !== 0;
  if (running) {
    let gov = clamp01((idle - rpm) / IDLE_GOVERNOR_BAND_RPM);
    // R-PHYS: the idle controller's authority is an idle-air reserve, not full load: a dumped clutch at idle
    // stalls a manual (engineSystems.ts) instead of pulling away on full torque at 650 rpm
    if (gov > IDLE_GOVERNOR_MAX) gov = IDLE_GOVERNOR_MAX;
    if (gov > throttle) throttle = gov;
  } else {
    throttle = 0;
  }

  // ---- engine torque
  const full = sampleTorqueLut(d.torqueLut, d.lutStepRpm, rpm) * s.powerFactor;
  let rr = rpm / d.redlineRpm;
  rr = rr < 0 ? 0 : rr > 1 ? 1 : rr;
  let tEng = throttle * full - (1 - throttle) * d.engineBrakeTorque * rr;
  if (!running) {
    // engine off: friction + pumping drag down to standstill (≥ 30 % of the overrun torque at any speed),
    // plus the starter while cranking (a speed controller toward STARTER_RPM, capped)
    tEng = -d.engineBrakeTorque * (0.3 + 0.7 * rr);
    if (s.engineOmega <= 0) tEng = 0;
    if (s.cranking !== 0) {
      let st = (d.engineInertia * (STARTER_RPM * RAD_S_PER_RPM - s.engineOmega)) / 0.05 + d.engineBrakeTorque * (0.3 + 0.7 * rr);
      if (st > s.starterTorque) st = s.starterTorque;
      if (st > 0) tEng += st;
    }
  }

  // ---- auto-clutch (engagement target, low-passed)
  const rpmGSigned = omegaG * RPM_PER_RAD_S;
  const lo = idle * (1.05 + AUTO_CLUTCH_LAUNCH_LO * pedalThrottle);
  const roadLock = idle * AUTO_CLUTCH_LOCK;
  const eRoad = smooth(idle, roadLock > lo ? roadLock : lo, rpmGSigned);
  const eEng = smooth(lo, idle * (AUTO_CLUTCH_LOCK + AUTO_CLUTCH_LAUNCH * pedalThrottle), rpm);
  const eTarget = eRoad > eEng ? eRoad : eEng;
  const alpha = dt / (AUTO_CLUTCH_TAU + dt);
  s.autoEngage += (eTarget - s.autoEngage) * alpha;
  const pedalOnly = s.transmission === 'manual' && !s.clutchAssist;
  if (!running && !pedalOnly) s.autoEngage = 0;
  let applied = pedalOnly ? 0 : 1 - s.autoEngage;
  if (pedalClutch > applied) applied = pedalClutch;
  if (shiftOpen > applied) applied = shiftOpen;
  // Upshift inertia phase: the clutch slips at the held torque (capacity = upshiftCap).
  if (s.upshift === 1 && d.clutchMaxTorque > 0) {
    const a = 1 - s.upshiftCap / d.clutchMaxTorque;
    if (a > applied) applied = a;
  }
  s.clutch = applied;

  // ---- clutch coupling (implicit spring-damper, see header)
  const Ie = d.engineInertia;
  let cap = d.clutchMaxTorque * (1 - applied);
  if (s.tcCut > 0 && tcThrottleShare < 1) cap *= 1 - s.tcCut * (1 - tcThrottleShare);
  // Launch control (see launchFade; road speed below LAUNCH_FADE_*): the clutch never passes more torque than the driven
  // tyres can put down (μ·load·r per wheel, × LAUNCH_TRACTION_MARGIN). The auto-clutch closes in ~50 ms,
  // far faster than any slip feedback: without this every launch dumped ~1.8× the traction torque into the
  // tyres (slip ratio ≈ 11, then ~1.5 s of ±5 m/s² surging while it recovered).
  if (launchFade < 1 && G !== 0 && nAttached > 0) {
    // low-passed: the instantaneous load follows the body's squat / pitch, and a limit on it closed a
    // feedback loop (more torque → more squat → more rear load → more torque) that surged at ~5 Hz
    s.launchTrac = s.launchTrac > 0 ? s.launchTrac + (tTrac - s.launchTrac) * (dt / (LAUNCH_TRACTION_TAU + dt)) : tTrac;
    const lim = (LAUNCH_TRACTION_MARGIN * s.launchTrac) / (G < 0 ? -G : G);
    const c = lim + (cap - lim) * launchFade;
    if (c < cap) cap = c;
  } else {
    s.launchTrac = 0;
  }
  // Upshift inertia phase: always enough capacity to pull the engine down onto the new ratio.
  if (s.upshift === 1) {
    // the deceleration margin fades with the slip so the lock-up does not overshoot the held torque
    let sl = (s.engineOmega - omegaG) / UPSHIFT_RAMP_SLIP;
    sl = sl < 0.15 ? 0.15 : sl > 1 ? 1 : sl;
    const need = tEng + Ie * UPSHIFT_MIN_DECEL * sl;
    if (cap < need) cap = need < d.clutchMaxTorque ? need : d.clutchMaxTorque;
  }
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

  // ---- engine integration (a seized engine is locked: the clutch then holds the driveline against it)
  let we = s.seized !== 0 ? 0 : s.engineOmega + (dt * (tEng - tClutch)) / Ie;
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

  // ---- line lock (TC off: throttle + brake at a standstill = burnout)
  let lineLock = false;
  if (!s.tractionControl && s.gear > 0 && pedalThrottle >= LINE_LOCK_PEDAL && brake >= LINE_LOCK_PEDAL) {
    let vRef = 0;
    let nRef = 0;
    for (let w = 0; w < wheels.length; w++) {
      const wr = wheels[w]!;
      if (wr.wheel.driven || wr.detached !== 0) continue;
      const v = wr.omega * wr.rollRadius;
      vRef += v < 0 ? -v : v;
      nRef++;
    }
    lineLock = nRef > 0 && vRef < LINE_LOCK_SPEED * nRef;
  }
  s.lineLock = lineLock;

  // ---- brakes (service with bias, handbrake; wheel gets the max)
  for (let w = 0; w < wheels.length; w++) {
    const wr = wheels[w]!;
    const cw = wr.wheel;
    const sb = lineLock && cw.driven ? 0 : brake * cw.brakeTorque;
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
