/**
 * Beam kernel: spring-damper forces, plastic deformation, breaking.
 *
 * R-CORE: src/sim/wasm/kernel.c mirrors this loop (R-CRASH crush unloading included) for the WASM kernels and
 * must stay bit-identical (kernelParity.test.ts): change both together; the
 * constants below reach the C side through set_params.
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
/**
 * R-CRASH CRUSH UNLOADING (per beam: SimState.unloadGain / unloadTrig, compiled by compileVehicle).
 * WHY: real sheet steel unloads along its elastic modulus, so a member loaded to its crash force gives
 * back only its tiny elastic strain (≈ 0.2 %). The sim's beams are stability-capped at 1–4e5 N/m, so a
 * crash-loaded member carries its force at 1–20 % elastic strain (the sedan's rear bay "is strong" only
 * by carrying 12 % elastic strain), and that energy — 17 kJ in a 50 km/h sedan frontal: rear-bay rails,
 * rack / subframe links, engine mounts, cell spans; 27 kJ in the cell spans alone at 100 km/h — pushed
 * the car back off the wall: rebound 21–23 % of the impact speed (real cars 5–15 %).
 * ARMING: only while the object is in a crash (`crashArmed`: its shell has released nodes since the last
 * capture, shell.ts shellCrashArmed — driving, kerbs and drops release nothing), a beam whose |F|
 * exceeds unloadTrig is "crash loaded" for a hold window. While crash loaded, a member that is
 * compressed and lengthening (or stretched and shortening) unloads with α = 1 + |unloadGain| times its
 * stiffness: its effective rest length follows (α − 1)·Δlength toward the current length (never past
 * it, never below the compression floor).
 *   PERMANENT (plastic unloading, CRUSH_UNLOAD_HOLD): a crumple-zone member (unloadGain > 0) that has
 *     yielded: the rest length itself moves. Bit 15 of crushHold.
 *   TEMPORARY: every other crash-loaded member — held structure (safety cell, firewall, suspension
 *     links: unloadGain < 0; the real car keeps those elastic and far stiffer; relax CRUSH_RELAX_TAU)
 *     and crumple members loaded hard without yielding (relax CRUSH_RELAX_TAU_CRUMPLE), both held
 *     CRUSH_HELD_HOLD after the load drops: the shift goes into hystOff, which relaxes back once the hold
 *     ends, i.e. after the car has left the wall. The stored energy comes back as internal motion
 *     (damped by the beams and the shell) instead of push-off, and the member ends in its own shape.
 * A beam that yields folds its offset into the rest length (the ratchet works on the effective rest).
 * Measured (crashRing.test.ts, rigid wall, 50 / 100 km/h): sedan 21 / 23 → 10 / 9 %, coupe 21 / 22 →
 * 11 / 8 %, traffic 21 / 15 → 9 / 7 % (with the wall-contact hysteresis, colliders.ts).
 */
export const CRUSH_UNLOAD_HOLD = 600;
/** Hold of a temporary offset, ticks: short, so the offsets are gone before the shell's post-impact set (≥ 0.15 s) recaptures the crushed shape. */
export const CRUSH_HELD_HOLD = 100;
/** Relaxation time constant of a temporary offset after its hold, s. */
export const CRUSH_RELAX_TAU = 0.03;
/**
 * Relaxation time constant of a crumple member's temporary offset (loaded hard but not yielded), s:
 * slower than the held members' (the stored energy comes back after the car has left the wall, as internal motion the
 * beams damp out; τ 0.4 s left the crush creeping 2–3 cm half a second after the peak), and the member ends in its own shape (a permanent set there froze the crash's
 * nose-dive into the front structure: the bumper dragged on the ground and slid under a wall).
 */
export const CRUSH_RELAX_TAU_CRUMPLE = 0.15;
/** Fixed sim step (CLAUDE.md: dt = 1/2000 s): the unloading increment is vrel·dt. */
export const CRUSH_HYST_DT = 1 / 2000;
const HYST_DT = CRUSH_HYST_DT;
export const CRUSH_RELAX_KEEP = 1 - HYST_DT / CRUSH_RELAX_TAU;
const RELAX_KEEP = CRUSH_RELAX_KEEP;
export const CRUSH_RELAX_KEEP_CRUMPLE = 1 - HYST_DT / CRUSH_RELAX_TAU_CRUMPLE;
const RELAX_KEEP_CRUMPLE = CRUSH_RELAX_KEEP_CRUMPLE;
/** Below this length a beam has no defined direction and exerts no force. */
export const BEAM_MIN_DIST = 1e-9;
const MIN_DIST = BEAM_MIN_DIST;

const T_BOUNDED = BeamType.bounded;
const T_SUPPORT = BeamType.support;
const T_SHOCK = BeamType.shock;

export const applyBeamForces: ApplyBeamForces = (state, first, count, events, debugStrains, crashArmed = false) => {
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
  const unloadGain = state.unloadGain;
  const unloadTrig = state.unloadTrig;
  const crushHold = state.crushHold;
  const hystOff = state.hystOff;
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
    let rest = restLen[b]!;
    const gain = unloadGain[b]!;
    if (gain !== 0) {
      // crush unloading (see CRUSH_UNLOAD_HOLD); rest = the EFFECTIVE rest length below
      let off = hystOff[b]!;
      const hold = crushHold[b]!;
      if (hold !== 0) {
        // low 15 bits: ticks left; bit 15: permanent (plastic) unloading
        const ticks = (hold & 0x7fff) - 1;
        crushHold[b] = ticks > 0 ? (hold & 0x8000) | ticks : 0;
        const re = rest + off;
        const vr = ((velX[ib]! - velX[ia]!) * dx + (velY[ib]! - velY[ia]!) * dy + (velZ[ib]! - velZ[ia]!) * dz) * inv;
        if ((dist < re && vr > 0) || (dist > re && vr < 0)) {
          let r = re - (gain < 0 ? -gain : gain) * vr * HYST_DT;
          if (vr > 0 ? r < dist : r > dist) r = dist;
          const floor = PLASTIC_COMPRESS_FLOOR * restLen0[b]!;
          if (r < floor) r = floor < re ? floor : re;
          if ((hold & 0x8000) !== 0) {
            rest = r - off;
            restLen[b] = rest;
          } else {
            off = r - rest;
            hystOff[b] = off;
          }
        }
      } else if (off !== 0) {
        off = off * (gain > 0 ? RELAX_KEEP_CRUMPLE : RELAX_KEEP);
        if (off < 1e-7 && off > -1e-7) off = 0;
        hystOff[b] = off;
      }
      rest += off;
    }
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
    if (crashArmed && gain !== 0 && fAbs > unloadTrig[b]!) {
      // crash loaded: a crumple member that yielded or carries a real crash load unloads plastically
      const perm = gain > 0 && restLen[b] !== restLen0[b];
      const cur = crushHold[b]!;
      crushHold[b] = perm || (cur & 0x8000) !== 0 ? 0x8000 | CRUSH_UNLOAD_HOLD  : CRUSH_HELD_HOLD;
    }
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
        // a yielding member's temporary crush offset becomes part of its (plastic) rest length
        if (gain !== 0) hystOff[b] = 0;
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
