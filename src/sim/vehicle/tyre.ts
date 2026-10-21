/**
 * TYRE MODEL (worker-only, R-PHYS): the friction state of the soft-body
 * tyre. The tyre's FORCES stay emergent (tread nodes, contact layer, lateral
 * brush, carcass, ring; wheels.ts / ground.ts); this module sets, every
 * tick before the brush and the ground pass, the Coulomb μ every tread node
 * of the wheel sees — so the brush cap, the node-level stick and the
 * friction cone all follow it — and adds the rolling-loss correction.
 *
 *   μ_node = μ_base · f_load · f_slip
 *
 * - f_load (LOAD SENSITIVITY): μ falls as the tyre is loaded harder,
 *   f = 1 − ls·(F̄z/Fz0 − 1), clamped to [0.7, 1.2]; ls = WheelDef
 *   tyreLoadSensitivity (passenger radials 0.08–0.15 per unit of relative
 *   load: Pacejka "Tyre and Vehicle Dynamics" 3rd ed. §4.3, pDy2 ≈ −0.1);
 *   Fz0 = the tyre's design load (the car's weight shared over its wheels);
 *   F̄z = the wheel load low-passed over LOAD_TAU (the patch alternates
 *   between 1 and 2 rays per row, ±20 % per ray).
 * - f_slip (SLIDING FRICTION FALL-OFF): rubber on asphalt grips best at a
 *   small sliding share; a fully sliding tyre (locked wheel, big slip angle)
 *   keeps μ_slide/μ_peak ≈ 0.7–0.85 (dry asphalt; Pacejka §1.2, Gillespie
 *   "Fundamentals of Vehicle Dynamics" fig. 10.6 locked-wheel vs peak).
 *   σ = |slip velocity of the rigid wheel at the contact| / max(V, SIGMA_V_MIN)
 *   ≈ √(tan²α + κ²) (theoretical combined slip), f = 1 − (1 − r)·S(σ) with S a
 *   smoothstep from σ_peak to σ_slide. Using the COMBINED slip makes the
 *   lateral and longitudinal grip fall together (friction ellipse with
 *   fall-off) and gives the force curves a peak (≈ 6–9° / κ ≈ 0.1–0.15) and a
 *   gradual decline instead of a plateau: the slide progresses and can be
 *   caught, a locked wheel stops shorter than ABS cannot.
 * - ROLLING-LOSS CORRECTION. The 12-ray tread polygon excites ring
 *   vibration whose damping costs far more than a real belt's hysteresis at
 *   speed (measured coasting in neutral, sedan: C_rr 0.016 at 40 km/h,
 *   0.068 at 120, 0.156 at 160 km/h — a real car tyre is 0.01·(1 + V/160 km/h),
 *   Wong "Theory of Ground Vehicles" eq. 1.12). WheelDef.rollingLossComp is a
 *   per-tyre table (every 20 km/h of tread speed from 0) of the measured
 *   EXCESS loss per unit load; it is fed back as a torque in the rolling
 *   direction, −(excess)·load·r_roll, with the reaction on the upright (it
 *   stands in for a ground force), so a coasting car follows the reference
 *   road load. Calibrated by realism/coastdown (see the def comments).
 *
 * Hot path: only + − × ÷ sqrt, no allocation, fixed order.
 */
import type { SimState } from '../types';
import type { WheelRuntime } from './types';

/** Low-pass time constant of the wheel load feeding f_load, s. */
export const LOAD_TAU = 0.03;
/** Floor of the speed normalising σ, m/s (a car sliding sideways at walking pace still slides). */
export const SIGMA_V_MIN = 3;
/** Low-pass of σ, s (ω ripple of the soft ring). */
export const SIGMA_TAU = 0.01;
/** Clamp of the load factor. */
export const LOAD_FACTOR_MIN = 0.7;
export const LOAD_FACTOR_MAX = 1.2;
/** Defaults for the optional WheelDef fields. */
export const TYRE_DEFAULTS = {
  loadSensitivity: 0,
  slideRatio: 1,
  peakSlip: 0.1,
  slideSlip: 0.6,
} as const;
/** Speed step of WheelDef.rollingLossComp, m/s (20 km/h). */
export const ROLL_COMP_STEP = 20 / 3.6;

/** Per-wheel tyre state (preallocated at spawn; worker-only). */
export interface TyreState {
  /** Base μ of each tyre ring node (rig nodeFriction), 2·rays. */
  base: Float64Array;
  /** Design load Fz0, N. */
  fz0: number;
  loadSensitivity: number;
  slideRatio: number;
  peakSlip: number;
  slideSlip: number;
  /** Rolling-loss correction table (per unit load, every ROLL_COMP_STEP), may be empty. */
  rollComp: Float64Array;
  /** Low-passed load (N) and combined slip. */
  load: number;
  sigma: number;
  /** Last μ factor applied. */
  factor: number;
}

export function createTyreState(
  base: Float64Array,
  fz0: number,
  def: { tyreLoadSensitivity?: number; tyreSlideRatio?: number; tyrePeakSlip?: number; tyreSlideSlip?: number; rollingLossComp?: readonly number[] },
): TyreState {
  return {
    base,
    fz0: fz0 > 0 ? fz0 : 1,
    loadSensitivity: def.tyreLoadSensitivity ?? TYRE_DEFAULTS.loadSensitivity,
    slideRatio: def.tyreSlideRatio ?? TYRE_DEFAULTS.slideRatio,
    peakSlip: def.tyrePeakSlip ?? TYRE_DEFAULTS.peakSlip,
    slideSlip: def.tyreSlideSlip ?? TYRE_DEFAULTS.slideSlip,
    rollComp: Float64Array.from(def.rollingLossComp ?? []),
    load: fz0,
    sigma: 0,
    factor: 1,
  };
}

export function resetTyreState(t: TyreState): void {
  t.load = t.fz0;
  t.sigma = 0;
  t.factor = 1;
}

/**
 * Sets the μ of the wheel's tyre ring nodes for this tick (call after
 * estimateWheelOmega, before the brush and the ground pass) and returns the
 * rolling-loss correction torque about the spin axis (N·m, signed with ω; 0
 * when none), which the caller adds to the wheel's axle torque.
 */
export function stepTyre(state: SimState, w: WheelRuntime, t: TyreState, dt: number): number {
  const { velX, velY, velZ, posX, posY, posZ, friction } = state;
  // ---- load (low-passed)
  t.load += (w.load - t.load) * (dt / (LOAD_TAU + dt));
  // ---- combined slip of the rigid wheel at the contact
  const hi = w.hubI;
  const ho = w.hubO;
  const vx = (velX[hi]! + velX[ho]!) * 0.5;
  const vy = (velY[hi]! + velY[ho]!) * 0.5;
  const vz = (velZ[hi]! + velZ[ho]!) * 0.5;
  let sx = posX[ho]! - posX[hi]!;
  let sy = posY[ho]! - posY[hi]!;
  let sz = posZ[ho]! - posZ[hi]!;
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let sigma = 0;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (sl > 1e-9 && w.contact !== 0) {
    sx /= sl;
    sy /= sl;
    sz /= sl;
    // lateral slip: hub velocity along the axle (≈ ground plane); longitudinal: ω·r − v_x via slipRatio
    const uLat = vx * sx + vy * sy + vz * sz;
    const vFwd2 = speed * speed - uLat * uLat;
    const vFwd = vFwd2 > 0 ? Math.sqrt(vFwd2) : 0;
    const uLon = w.slipRatio * (vFwd > 0.5 ? vFwd : 0.5);
    const den = speed > SIGMA_V_MIN ? speed : SIGMA_V_MIN;
    sigma = Math.sqrt(uLat * uLat + uLon * uLon) / den;
  }
  t.sigma += (sigma - t.sigma) * (dt / (SIGMA_TAU + dt));
  // ---- μ factor
  let fl = 1 - t.loadSensitivity * (t.load / t.fz0 - 1);
  fl = fl < LOAD_FACTOR_MIN ? LOAD_FACTOR_MIN : fl > LOAD_FACTOR_MAX ? LOAD_FACTOR_MAX : fl;
  let fs = 1;
  if (t.slideRatio < 1) {
    let x = (t.sigma - t.peakSlip) / (t.slideSlip - t.peakSlip);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    fs = 1 - (1 - t.slideRatio) * x * x * (3 - 2 * x);
  }
  const f = fl * fs;
  t.factor = f;
  const base = t.base;
  const t0 = w.tireStart;
  const n = w.ringCount;
  for (let j = 0; j < n; j++) friction[t0 + j] = base[j]! * f;
  // ---- rolling-loss correction (tread speed, per unit load, linear in the table)
  const tab = t.rollComp;
  const nt = tab.length;
  if (nt === 0 || !(w.load > 0) || w.detached !== 0) return 0;
  const om = w.omega;
  let vt = om * w.rollRadius;
  if (vt < 0) vt = -vt;
  const xi = vt / ROLL_COMP_STEP;
  const i = xi | 0;
  let c: number;
  if (i >= nt - 1) c = tab[nt - 1]!;
  else c = tab[i]! + (tab[i + 1]! - tab[i]!) * (xi - i);
  if (!(c > 0)) return 0;
  const tau = c * w.load * w.rollRadius;
  return om > 0 ? tau : -tau;
}
