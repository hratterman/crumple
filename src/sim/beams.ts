/**
 * Beam kernel: spring-damper forces, plastic deformation, breaking.
 *
 * HOT LOOP: only + - * / and Math.sqrt (numerics contract), no allocation,
 * ascending beam order. Beam type is a small-int branch inside one
 * monomorphic loop.
 *
 * Sign convention: `fs` / `f` are the axial force with TENSION POSITIVE.
 * dir = (p_b - p_a)/dist; node a receives +f·dir, node b receives -f·dir.
 *
 * Plasticity / breaking / strain all use the elastic force `fs` (spring +
 * bounds ramp + preload), not the damping term, so fast vibration never
 * yields or snaps a beam that is within its strength.
 */
import { BeamType, type ApplyBeamForces } from './types';

/** Extra stiffness (multiple of k) beyond bounded/shock bounds. Keeps ω·dt within the explicit-Euler envelope. */
export const BOUND_STIFFNESS_RAMP = 4;
/** Fraction of the excess plastic strain absorbed into restLen per step. */
export const PLASTIC_RATCHET = 0.02;
/** Stiffness multiplier per plastic step. */
export const PLASTIC_WEAKEN = 0.985;
/** Plastic weakening never takes k below this fraction of k0. */
export const PLASTIC_K_FLOOR = 0.25;
/** Below this length a beam has no defined direction and exerts no force. */
const MIN_DIST = 1e-9;

const T_BOUNDED = BeamType.bounded;
const T_SUPPORT = BeamType.support;
const T_SHOCK = BeamType.shock;

export const applyBeamForces: ApplyBeamForces = (state, first, count, events, debugStrains) => {
  const posX = state.posX;
  const posY = state.posY;
  const posZ = state.posZ;
  const velX = state.velX;
  const velY = state.velY;
  const velZ = state.velZ;
  const frcX = state.frcX;
  const frcY = state.frcY;
  const frcZ = state.frcZ;
  const aIdx = state.aIdx;
  const bIdx = state.bIdx;
  const kArr = state.k;
  const k0Arr = state.k0;
  const dArr = state.d;
  const restLen = state.restLen;
  const deform = state.deform;
  const breakF = state.breakF;
  const boundsLow = state.boundsLow;
  const boundsHigh = state.boundsHigh;
  const preload = state.preload;
  const type = state.type;
  const active = state.active;
  const strainOut = state.strainOut;
  const end = first + count;

  for (let b = first; b < end; b++) {
    if (active[b] === 0) continue;
    const ia = aIdx[b]!;
    const ib = bIdx[b]!;
    const dx = posX[ib]! - posX[ia]!;
    const dy = posY[ib]! - posY[ia]!;
    const dz = posZ[ib]! - posZ[ia]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < MIN_DIST) {
      if (debugStrains) strainOut[b] = 0;
      continue;
    }
    const inv = 1 / dist;
    const kb = kArr[b]!;
    const rest = restLen[b]!;
    const stretch = dist - rest;
    const t = type[b]!;

    let fs = kb * stretch;
    let slack = false;
    if (t !== 0) {
      if (t === T_BOUNDED || t === T_SHOCK) {
        const hi = boundsHigh[b]! * rest;
        const lo = boundsLow[b]! * rest;
        if (stretch > hi) fs += kb * BOUND_STIFFNESS_RAMP * (stretch - hi);
        else if (stretch < -lo) fs += kb * BOUND_STIFFNESS_RAMP * (stretch + lo);
        if (t === T_SHOCK) fs -= preload[b]!;
      } else if (t === T_SUPPORT) {
        if (stretch > 0) slack = true;
      }
      // hydro: plain spring; restLen is driven per tick by the engine.
    }
    if (slack) {
      if (debugStrains) strainOut[b] = 0;
      continue;
    }

    const fAbs = fs < 0 ? -fs : fs;
    const bf = breakF[b]!;
    if (fAbs > bf) {
      active[b] = 0;
      strainOut[b] = NaN;
      events.beamBreak(
        b,
        (posX[ia]! + posX[ib]!) * 0.5,
        (posY[ia]! + posY[ib]!) * 0.5,
        (posZ[ia]! + posZ[ib]!) * 0.5,
      );
      continue;
    }

    const df = deform[b]!;
    if (fAbs > df) {
      // Ratchet rest length toward the current length by PLASTIC_RATCHET of
      // the excess (beyond-threshold) elastic stretch, then weaken k.
      const excess = (fAbs - df) / kb;
      restLen[b] = fs > 0 ? rest + PLASTIC_RATCHET * excess : rest - PLASTIC_RATCHET * excess;
      const kFloor = PLASTIC_K_FLOOR * k0Arr[b]!;
      const kNew = kb * PLASTIC_WEAKEN;
      kArr[b] = kNew > kFloor ? kNew : kFloor;
    }

    const vrel = ((velX[ib]! - velX[ia]!) * dx + (velY[ib]! - velY[ia]!) * dy + (velZ[ib]! - velZ[ia]!) * dz) * inv;
    const f = (fs + dArr[b]! * vrel) * inv;
    const fx = f * dx;
    const fy = f * dy;
    const fz = f * dz;
    frcX[ia] = frcX[ia]! + fx;
    frcY[ia] = frcY[ia]! + fy;
    frcZ[ia] = frcZ[ia]! + fz;
    frcX[ib] = frcX[ib]! - fx;
    frcY[ib] = frcY[ib]! - fy;
    frcZ[ib] = frcZ[ib]! - fz;

    if (debugStrains) {
      const s = fs / bf; // Infinity breakF → 0
      strainOut[b] = s > 1 ? 1 : s < -1 ? -1 : s;
    }
  }
};
