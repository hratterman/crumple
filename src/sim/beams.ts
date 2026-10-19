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
/**
 * Fraction of the excess (beyond-threshold) elastic stretch absorbed into
 * restLen per step (time constant ≈ 1/RATCHET steps = 5 ms).
 * WHY 0.1 (was 0.02): at crash rates a 0.3 m member strains ~1 %/step, and
 * the 0.02 ratchet lagged ~25 ms, so members carried several × their
 * yield force elastically and gave most of it back on unloading. Full
 * return mapping (1) made yield rate-independent but then no ductile member
 * could ever exceed `deform`, i.e. reach `breakF`; at 0.1 the force
 * overshoots the threshold in proportion to the crush RATE, which is what
 * lets a 100 km/h hit tear the bumper off while a 30 km/h one only bends
 * it (crash.ts harness), and adds rate-dependent crush resistance.
 */
export const PLASTIC_RATCHET = 0.1;
/**
 * Compression lockup: plastic shortening stops at this fraction of the
 * original rest length (a fully folded crash rail is a solid stack of
 * metal). Past it the beam is elastic again about the floor length and
 * cannot break in compression, so a crushed zone hardens and hands the
 * load to the next zone back (progressive crush), and nodes never pass
 * through each other along a crushed member.
 */
export const PLASTIC_COMPRESS_FLOOR = 0.3;
/**
 * Stiffness multiplier per plastic step (1 = no weakening).
 * WHY 1 (was 0.985): weakened members store the same yield force at a
 * larger elastic stretch, so a crushed nose sprang back further (50 km/h
 * frontal: permanent crush 31 → 22 cm, rebound 3.6 → 4.4 m/s).
 */
export const PLASTIC_WEAKEN = 1;
/**
 * Reverse-yield hysteresis: a member already plastically shortened (rest <
 * rest0) yields in TENSION only at this multiple of `deform`, and one
 * already stretched yields in compression only at this multiple.
 * WHY: crashes store elastic energy all around the crushed zone (safety
 * cell, suspension, engine mounts). With symmetric yield that energy
 * pulled the folded rails straight again in tension while the car
 * rebounded (a 50 km/h frontal: peak ~96 cm of crush, final 37 cm).
 * Folded sheet metal does not unfold under those loads. 2 rather than
 * higher: members that reverse during the crush itself (diagonals) stay
 * elastic longer and store energy that springs back (4 measured worse).
 */
export const PLASTIC_REVERSE_FACTOR = 2;
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
  const restLen0 = state.restLen0;
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
    if (fAbs > bf && !(fs < 0 && rest <= PLASTIC_COMPRESS_FLOOR * restLen0[b]!)) {
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
      // Reverse yield (pulling a crushed member back out, or pushing a
      // stretched one back in) needs PLASTIC_REVERSE_FACTOR × the threshold.
      const r0 = restLen0[b]!;
      const dfe = (fs > 0 ? rest < r0 : rest > r0) ? df * PLASTIC_REVERSE_FACTOR : df;
      if (fAbs > dfe) {
        // Ratchet rest length toward the current length by PLASTIC_RATCHET of
        // the excess (beyond-threshold) elastic stretch, then weaken k.
        const excess = (fAbs - dfe) / kb;
        if (fs > 0) {
          restLen[b] = rest + PLASTIC_RATCHET * excess;
        } else {
          const floor = PLASTIC_COMPRESS_FLOOR * r0;
          const r = rest - PLASTIC_RATCHET * excess;
          restLen[b] = r > floor ? r : floor < rest ? floor : rest;
        }
        const kFloor = PLASTIC_K_FLOOR * k0Arr[b]!;
        const kNew = kb * PLASTIC_WEAKEN;
        kArr[b] = kNew > kFloor ? kNew : kFloor;
      }
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
