/**
 * R-PHYS STEERING SYSTEM (vehicle pre-step; the engine's hydro pass drives the
 * steering hydros from VehicleRuntime.steerOut when it is set). The `steer`
 * action is the STEERING-WHEEL angle the driver's hands hold (−1..1 of the
 * wheel's lock angle). Between the hands and the road wheels:
 *   - the torsion bar of the assist valve / torque sensor, k_tb (N·m/°), whose
 *     twist is the torque the driver feels: T_d = k_tb·(θ_sw − θ_p);
 *   - speed-sensitive power assist: the rack gets (1 + g(v))·T_d with
 *     g(v) = g∞ + (g0 − g∞) / (1 + (v / v_a)²), capped at the pump's / motor's maximum assist
 *     torque at the pinion (Harrer & Pfeffer, "Steering Handbook", 2017, ch. 6);
 *   - the pinion / rack / assist-motor inertia J, the controller's damping on the twist rate
 *     and the rack's own (hydraulic / seal) damping;
 *   - the tie-rod loads: each steering hydro's axial force F (tension +) acts
 *     on the pinion as the generalised force F·∂L_rest/∂θ_p — the tyres' self-
 *     aligning moments reach the rack through the rig's own kingpin geometry
 *     (caster trail, scrub radius, kingpin-inclination jacking), not a formula;
 *   - rack end stops at |θ_p| = θ_lock (the hydraulic / mechanical lock).
 * The hands follow the `steer` action at up to HAND_RATE. The rack position
 * θ_p / θ_lock drives the hydros (steerOut), so the road
 * wheels follow the hands through the system's compliance (steering-system
 * compliance understeer, Gillespie 1992 §6), and T_d is the steering feel.
 *
 * HOT LOOP: + − × ÷ sqrt only, zero allocation.
 */
import type { SimState } from '../types';
import type { CompiledRig } from '../rig/types';
import { RIG_BEAM_TYPE_ID } from '../rig/types';
import type { SteeringSystemDef } from './types';

export type SteeringSystemSpec = Required<SteeringSystemDef>;

/** A mid-size car's electric power steering (Harrer & Pfeffer 2017 ch. 6–7: 2.5–3 turns, ~2 N·m/° torsion bar). */
export const STEERING_DEFAULTS: SteeringSystemSpec = {
  ratio: 15,
  torsionBarNmPerDeg: 2,
  assistGain0: 20,
  assistGainHigh: 0.6,
  assistSpeed: 6,
  assistMaxNm: 80,
  inertia: 0.04,
};

export function steeringSpec(def: SteeringSystemDef | undefined): SteeringSystemSpec {
  return { ...STEERING_DEFAULTS, ...(def ?? {}) };
}

const DEG = Math.PI / 180;
/**
 * Damping ratio of the assisted torsion bar on the pinion inertia, acting on the twist RATE (the
 * EPS controller's torque-derivative damping): it stabilises the stiff assisted loop without
 * resisting a steady steering motion.
 */
const ASSIST_ZETA = 0.7;
/** Absolute rack damping at the pinion (hydraulic / seal viscous losses), N·m·s/rad. */
const RACK_DAMP = 0.5;
/**
 * Fastest the hands turn the steering wheel, rad/s (≈ 1400 °/s, an emergency swerve): a stepped `steer`
 * action is followed at this rate (an instantaneous step would put an unbounded twist rate through the
 * torsion bar).
 */
export const HAND_RATE = 25;
/** Torsion-bar viscous damping, N·m·s/rad. */
const TB_DAMP = 0.05;

export interface SteeringState {
  spec: SteeringSystemSpec;
  /** Lock angle at the pinion / steering wheel, rad (mean road-wheel lock × ratio). */
  thLock: number;
  ktb: number;
  /** Pinion angle, rad, and rate; previous steering-wheel angle. */
  th: number;
  om: number;
  swPrev: number;
  /** Driver torque at the wheel (torsion-bar twist), assist torque and tie-rod load torque at the pinion, N·m. */
  torque: number;
  assist: number;
  load: number;
  /** Steering hydros: rig-local beams, global beams (rebased), base rest length, travel. */
  local: Int32Array;
  beams: Int32Array;
  base: Float64Array;
  travel: Float64Array;
}

export function createSteering(def: SteeringSystemDef | undefined, maxWheelAngleDeg: number, rig: CompiledRig): SteeringState {
  const spec = steeringSpec(def);
  const loc: number[] = [];
  for (let i = 0; i < rig.beamCount; i++) if (rig.beamType[i] === RIG_BEAM_TYPE_ID.hydro) loc.push(i);
  const local = Int32Array.from(loc);
  const base = new Float64Array(local.length);
  const travel = new Float64Array(local.length);
  for (let h = 0; h < local.length; h++) {
    base[h] = rig.beamRestLen[local[h]!]!;
    travel[h] = rig.beamHydroTravel[local[h]!]!;
  }
  const ktb = spec.torsionBarNmPerDeg / DEG;
  return {
    spec,
    thLock: maxWheelAngleDeg * spec.ratio * DEG,
    ktb,
    th: 0,
    om: 0,
    swPrev: 0,
    torque: 0,
    assist: 0,
    load: 0,
    local,
    beams: Int32Array.from(local),
    base,
    travel,
  };
}

export function rebaseSteering(s: SteeringState, beamStart: number): void {
  for (let i = 0; i < s.local.length; i++) s.beams[i] = beamStart + s.local[i]!;
}

export function resetSteering(s: SteeringState): void {
  s.th = 0;
  s.om = 0;
  s.swPrev = 0;
  s.torque = 0;
  s.assist = 0;
  s.load = 0;
}

/** One tick: `steer` = the hands' steering-wheel command (−1..1), `speed` m/s. Returns the rack position (−1..1). */
export function stepSteering(state: SimState, s: SteeringState, steer: number, speed: number, dt: number): number {
  const { posX, posY, posZ, velX, velY, velZ, aIdx, bIdx, k: kArr, d: dArr, restLen, active } = state;
  const L = s.thLock;
  const target = (steer < -1 ? -1 : steer > 1 ? 1 : steer) * L;
  const step = HAND_RATE * dt;
  const dsw = target - s.swPrev;
  const sw = dsw > step ? s.swPrev + step : dsw < -step ? s.swPrev - step : target;
  const omSw = (sw - s.swPrev) / dt;
  s.swPrev = sw;
  // tie-rod loads on the pinion: Q = Σ F·∂L_rest/∂θ, ∂L_rest/∂θ = base·travel / θ_lock
  let tl = 0;
  const beams = s.beams;
  for (let h = 0; h < beams.length; h++) {
    const b = beams[h]!;
    if (active[b] === 0) continue;
    const ia = aIdx[b]!;
    const ib = bIdx[b]!;
    const dx = posX[ib]! - posX[ia]!;
    const dy = posY[ib]! - posY[ia]!;
    const dz = posZ[ib]! - posZ[ia]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-9) continue;
    const vrel = ((velX[ib]! - velX[ia]!) * dx + (velY[ib]! - velY[ia]!) * dy + (velZ[ib]! - velZ[ia]!) * dz) / dist;
    const F = kArr[b]! * (dist - restLen[b]!) + dArr[b]! * vrel;
    tl += (F * s.base[h]! * s.travel[h]!) / L;
  }
  s.load = tl;
  // speed-sensitive assist, limited by the assist capacity (one tick lagged)
  const sp = s.spec;
  const av = speed < 0 ? -speed : speed;
  const vr = av / sp.assistSpeed;
  let gain = sp.assistGainHigh + (sp.assistGain0 - sp.assistGainHigh) / (1 + vr * vr);
  const tPrev = s.torque < 0 ? -s.torque : s.torque;
  if (gain * tPrev > sp.assistMaxNm) gain = sp.assistMaxNm / tPrev;
  const K = s.ktb * (1 + gain);
  const J = sp.inertia;
  const Ct = TB_DAMP * (1 + gain) + 2 * ASSIST_ZETA * Math.sqrt(K * J);
  const C = Ct + RACK_DAMP;
  // semi-implicit in the assisted torsion bar and the damping
  let om = (s.om + (dt / J) * (K * (sw - s.th) + Ct * omSw + tl)) / (1 + (dt / J) * (C + dt * K));
  let th = s.th + dt * om;
  if (th > L) {
    th = L;
    if (om > 0) om = 0;
  } else if (th < -L) {
    th = -L;
    if (om < 0) om = 0;
  }
  s.th = th;
  s.om = om;
  s.torque = s.ktb * (sw - th) + TB_DAMP * (omSw - om);
  s.assist = gain * s.torque;
  return th / L;
}
