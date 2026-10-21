/**
 * R-PHYS: asymmetric, digressive dampers (vehicle pre-step, new physics in its
 * own module). The beam kernel applies every shock beam's linear damping
 * d·v (symmetric). Real passenger-car dampers are not linear:
 *  - REBOUND (extension) is 2–3.5× stiffer than BUMP (compression) at the
 *    same piston speed, so a bump is absorbed softly and the body is kept
 *    from floating back up (Dixon, "The Shock Absorber Handbook", 2nd ed.
 *    2007, ch. 1 / 7: rebound : bump ≈ 3 : 1 typical for passenger cars,
 *    total ζ ≈ 0.2–0.4 split unequally);
 *  - DIGRESSIVE: the force–velocity slope drops past a knee at ≈ 0.05–0.15
 *    m/s piston speed (blow-off valves open) to 0.3–0.5× the low-speed rate,
 *    which keeps body control (low speed: roll / pitch / heave) without
 *    making sharp bumps harsh (high speed: wheel motion) (Dixon ch. 5;
 *    Milliken, "Race Car Vehicle Dynamics", ch. 21).
 * Per shock beam, the pre-step adds the correction ΔF = F(v) − d·v along the
 * beam (tension positive, kernel sign convention), so the total damper force
 * is F(v). Rates are fractions of the def's calibrated symmetric d (tuned for
 * ζ ≈ 0.3): rebound 1.15 d, bump 0.45 d by default (2.6 : 1; mean 0.8 d, so
 * ζ ≈ 0.24 averaged over a cycle, ≈ 0.35 on the rebound stroke that controls
 * the body's return).
 *
 * HOT LOOP: + − × ÷ sqrt only, fixed order, zero allocation.
 */
import { BeamType, type SimState } from '../types';
import type { CompiledVehicle, DamperCurveDef } from './types';

/**
 * DamperCurveDef (types.ts): `bump` / `rebound` = low-speed rates as
 * fractions of the beam's d (defaults 0.45 / 1.15), `kneeSpeed` = piston
 * speed of the digressive knee (m/s; default 0.1), `highSpeedRatio` =
 * high-speed slope as a fraction of the low-speed slope (default 0.4).
 */
export const DAMPER_DEFAULTS: Required<DamperCurveDef> = { bump: 0.5, rebound: 1.3, kneeSpeed: 0.1, highSpeedRatio: 0.5 };

/**
 * Piston speeds beyond any road input (kerb strikes reach ≈ 1 m/s; crashes
 * 3–10 m/s): the correction fades out between these, m/s, so a crash sees the
 * def's linear damping it was tuned with (crashRing / boxtruck crash tests).
 */
export const CRASH_SPEED_LO = 1.2;
export const CRASH_SPEED_HI = 2;

export interface DamperState {
  /** Rig-local shock beam indices. */
  local: Int32Array;
  /** Global beam indices (rebased). */
  beams: Int32Array;
  /** Per beam: bump / rebound fractions of d, knee speed, high-speed ratio. */
  bump: Float64Array;
  rebound: Float64Array;
  knee: Float64Array;
  hs: Float64Array;
}

/** Damper force, tension positive, for a piston speed v (extension positive) and the beam's symmetric rate d. */
export function damperForce(v: number, d: number, bump: number, rebound: number, knee: number, hs: number): number {
  const c = v > 0 ? d * rebound : d * bump;
  const a = v < 0 ? -v : v;
  const f = a < knee ? c * a : c * (knee + hs * (a - knee));
  return v < 0 ? -f : f;
}

export function createDamperState(local: Int32Array, defs: readonly Required<DamperCurveDef>[]): DamperState {
  const n = local.length;
  const s: DamperState = {
    local,
    beams: new Int32Array(n),
    bump: new Float64Array(n),
    rebound: new Float64Array(n),
    knee: new Float64Array(n),
    hs: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const d = defs[i]!;
    s.bump[i] = d.bump;
    s.rebound[i] = d.rebound;
    s.knee[i] = d.kneeSpeed;
    s.hs[i] = d.highSpeedRatio;
  }
  return s;
}

/**
 * The vehicle's damper state (null when VehicleDef.dampers is unset): every
 * shock beam, assigned to the axle of the wheel whose inner hub node is
 * nearest one of its ends at rest.
 */
export function createVehicleDampers(v: CompiledVehicle): DamperState | null {
  const cfg = v.dampers;
  if (!cfg) return null;
  const rig = v.rig;
  const P = rig.nodePos;
  const local: number[] = [];
  const defs: Required<DamperCurveDef>[] = [];
  for (let b = 0; b < rig.beamCount; b++) {
    if (rig.beamType[b] !== BeamType.shock) continue;
    let best = Infinity;
    let axle: 'front' | 'rear' = 'front';
    for (const w of v.wheels) {
      for (const n of [rig.beamA[b]!, rig.beamB[b]!]) {
        const dx = P[n * 3]! - P[w.hubI * 3]!;
        const dy = P[n * 3 + 1]! - P[w.hubI * 3 + 1]!;
        const dz = P[n * 3 + 2]! - P[w.hubI * 3 + 2]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) {
          best = d2;
          axle = w.axle;
        }
      }
    }
    const c = cfg[axle];
    if (!c) continue;
    local.push(b);
    defs.push({ ...DAMPER_DEFAULTS, ...(c === true ? {} : c) });
  }
  return local.length > 0 ? createDamperState(Int32Array.from(local), defs) : null;
}

export function rebaseDampers(s: DamperState, beamStart: number): void {
  for (let i = 0; i < s.local.length; i++) s.beams[i] = beamStart + s.local[i]!;
}

/** Adds F(v) − d·v along every intact shock beam. */
export function applyDampers(state: SimState, s: DamperState): void {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, aIdx, bIdx, d: dArr, active } = state;
  const beams = s.beams;
  for (let i = 0; i < beams.length; i++) {
    const b = beams[i]!;
    if (active[b] === 0) continue;
    const ia = aIdx[b]!;
    const ib = bIdx[b]!;
    const dx = posX[ib]! - posX[ia]!;
    const dy = posY[ib]! - posY[ia]!;
    const dz = posZ[ib]! - posZ[ia]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) continue;
    const inv = 1 / dist;
    const v = ((velX[ib]! - velX[ia]!) * dx + (velY[ib]! - velY[ia]!) * dy + (velZ[ib]! - velZ[ia]!) * dz) * inv;
    const d = dArr[b]!;
    const av = v < 0 ? -v : v;
    if (av >= CRASH_SPEED_HI) continue;
    let df = damperForce(v, d, s.bump[i]!, s.rebound[i]!, s.knee[i]!, s.hs[i]!) - d * v;
    if (av > CRASH_SPEED_LO) df *= (CRASH_SPEED_HI - av) / (CRASH_SPEED_HI - CRASH_SPEED_LO);
    const f = df * inv;
    const fx = f * dx;
    const fy = f * dy;
    const fz = f * dz;
    frcX[ia] = frcX[ia]! + fx;
    frcY[ia] = frcY[ia]! + fy;
    frcZ[ia] = frcZ[ia]! + fz;
    frcX[ib] = frcX[ib]! - fx;
    frcY[ib] = frcY[ib]! - fy;
    frcZ[ib] = frcZ[ib]! - fz;
  }
}
