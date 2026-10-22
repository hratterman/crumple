/*
 * CRUMPLE physics kernel (R-CORE): the hot loops of src/sim/{beams,integrator}.ts
 * in freestanding C for wasm32, built twice by tools/build-wasm.sh:
 *   kernel-scalar.wasm   plain wasm32 (no SIMD)
 *   kernel-simd.wasm     -msimd128 (f64x2 lanes, CRUMPLE_SIMD defined)
 *
 * BIT-IDENTITY CONTRACT (determinism, replays): every result must equal the JS
 * kernel's bit for bit. So:
 *   - the same IEEE operations in the same order (left-associative sums as JS
 *     writes them, no algebraic rewrites), f64 everywhere the JS uses numbers;
 *   - -ffp-contract=off (no fused multiply-add) and no -ffast-math;
 *   - sqrt = f64.sqrt / f64x2.sqrt (correctly rounded, = Math.sqrt);
 *   - force accumulation into frc* in ascending beam order, one beam at a
 *     time (f64 addition is not associative); SIMD lanes only compute, the
 *     scatter stays sequential;
 *   - any SIMD pair with a rare case (non-normal type, inactive, degenerate,
 *     past deform / break) is recomputed by the scalar path from unchanged
 *     state, so the rare logic exists once.
 * Constants (plasticity etc.) come from the JS modules through set_params:
 * the TS sources stay the single source of truth.
 *
 * Memory: imported (JS owns the WebAssembly.Memory). The SoA arrays of
 * SimState live in linear memory above __heap_base; JS registers their byte
 * offsets with bind_state and reads/writes them through typed-array views
 * (no copies per step).
 */
#include <stdint.h>

#ifdef CRUMPLE_SIMD
#include <wasm_simd128.h>
#endif

#define EXPORT(name) __attribute__((export_name(#name)))

typedef double f64;

/* ------------------------------------------------------------ bound state */
static f64 *posX, *posY, *posZ, *velX, *velY, *velZ, *frcX, *frcY, *frcZ, *invMass;
static int32_t *aIdx, *bIdx;
static f64 *kArr, *dArr, *restLen, *restLen0, *k0Arr, *deformArr, *breakFArr, *boundsLow, *boundsHigh, *preloadArr;
static uint8_t *typeArr, *activeArr;
static float *strainOut;
/* Beams broken by the last beams() call, in discovery order (JS emits the events). */
static int32_t *breakList;
static uint8_t *nodeFlags;
/* R-CRASH crush unloading (beams.ts CRUSH_UNLOAD_HOLD): per-beam gain α − 1, trigger, hold ticks + permanent bit, offset. */
static float *unloadGain, *unloadTrig;
static int32_t *crushHold;
static f64 *hystOff;

/* Pointer table layout (u32 byte offsets), shared with src/sim/wasm/kernel.ts STATE_PTRS. */
enum {
  P_POSX, P_POSY, P_POSZ, P_VELX, P_VELY, P_VELZ, P_FRCX, P_FRCY, P_FRCZ, P_INVMASS,
  P_AIDX, P_BIDX, P_K, P_D, P_RESTLEN, P_RESTLEN0, P_K0, P_DEFORM, P_BREAKF,
  P_BOUNDSLOW, P_BOUNDSHIGH, P_PRELOAD, P_TYPE, P_ACTIVE, P_STRAINOUT, P_BREAKLIST,
  P_FLAGS,
  P_UNLOADGAIN, P_UNLOADTRIG, P_CRUSHHOLD, P_HYSTOFF,
  P_COUNT
};

static uint32_t ptrTable[P_COUNT];

EXPORT(ptr_table) uint32_t *ptr_table(void) { return ptrTable; }

EXPORT(bind_state) void bind_state(void) {
  posX = (f64 *)ptrTable[P_POSX];
  posY = (f64 *)ptrTable[P_POSY];
  posZ = (f64 *)ptrTable[P_POSZ];
  velX = (f64 *)ptrTable[P_VELX];
  velY = (f64 *)ptrTable[P_VELY];
  velZ = (f64 *)ptrTable[P_VELZ];
  frcX = (f64 *)ptrTable[P_FRCX];
  frcY = (f64 *)ptrTable[P_FRCY];
  frcZ = (f64 *)ptrTable[P_FRCZ];
  invMass = (f64 *)ptrTable[P_INVMASS];
  aIdx = (int32_t *)ptrTable[P_AIDX];
  bIdx = (int32_t *)ptrTable[P_BIDX];
  kArr = (f64 *)ptrTable[P_K];
  dArr = (f64 *)ptrTable[P_D];
  restLen = (f64 *)ptrTable[P_RESTLEN];
  restLen0 = (f64 *)ptrTable[P_RESTLEN0];
  k0Arr = (f64 *)ptrTable[P_K0];
  deformArr = (f64 *)ptrTable[P_DEFORM];
  breakFArr = (f64 *)ptrTable[P_BREAKF];
  boundsLow = (f64 *)ptrTable[P_BOUNDSLOW];
  boundsHigh = (f64 *)ptrTable[P_BOUNDSHIGH];
  preloadArr = (f64 *)ptrTable[P_PRELOAD];
  typeArr = (uint8_t *)ptrTable[P_TYPE];
  activeArr = (uint8_t *)ptrTable[P_ACTIVE];
  strainOut = (float *)ptrTable[P_STRAINOUT];
  breakList = (int32_t *)ptrTable[P_BREAKLIST];
  nodeFlags = (uint8_t *)ptrTable[P_FLAGS];
  unloadGain = (float *)ptrTable[P_UNLOADGAIN];
  unloadTrig = (float *)ptrTable[P_UNLOADTRIG];
  crushHold = (int32_t *)ptrTable[P_CRUSHHOLD];
  hystOff = (f64 *)ptrTable[P_HYSTOFF];
}

/* ------------------------------------------------------------ parameters (from beams.ts) */
static f64 BOUND_RAMP, RATCHET, COMPRESS_FLOOR, WEAKEN, REVERSE_FACTOR, K_FLOOR, MIN_DIST;

EXPORT(set_params)
void set_params(f64 boundRamp, f64 ratchet, f64 compressFloor, f64 weaken, f64 reverse, f64 kFloor, f64 minDist) {
  BOUND_RAMP = boundRamp;
  RATCHET = ratchet;
  COMPRESS_FLOOR = compressFloor;
  WEAKEN = weaken;
  REVERSE_FACTOR = reverse;
  K_FLOOR = kFloor;
  MIN_DIST = minDist;
}

/* R-CRASH crush unloading constants (beams.ts, passed by set_crash_params). */
static f64 HYST_DT, RELAX_KEEP, RELAX_KEEP_CRUMPLE;
static int32_t UNLOAD_HOLD, HELD_HOLD;

EXPORT(set_crash_params)
void set_crash_params(f64 hystDt, f64 relaxKeep, f64 relaxKeepCrumple, int32_t unloadHold, int32_t heldHold) {
  HYST_DT = hystDt;
  RELAX_KEEP = relaxKeep;
  RELAX_KEEP_CRUMPLE = relaxKeepCrumple;
  UNLOAD_HOLD = unloadHold;
  HELD_HOLD = heldHold;
}

#define T_BOUNDED 1
#define T_SUPPORT 2
#define T_SHOCK 4

/* ------------------------------------------------------------ beams (scalar) */
/*
 * One beam, exactly applyBeamForces' loop body. Returns 1 when the beam
 * broke (caller appends it to breakList).
 */
static inline int beam_scalar(int b, int dbg, int armed) {
  if (activeArr[b] == 0) return 0;
  const int32_t ia = aIdx[b];
  const int32_t ib = bIdx[b];
  const f64 dx = posX[ib] - posX[ia];
  const f64 dy = posY[ib] - posY[ia];
  const f64 dz = posZ[ib] - posZ[ia];
  const f64 dist = __builtin_sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < MIN_DIST) {
    if (dbg) strainOut[b] = 0.0f;
    return 0;
  }
  const f64 inv = 1.0 / dist;
  const f64 kb = kArr[b];
  f64 rest = restLen[b];
  const f64 gain = (f64)unloadGain[b];
  if (gain != 0) {
    /* crush unloading (beams.ts CRUSH_UNLOAD_HOLD); rest = the EFFECTIVE rest length below */
    f64 off = hystOff[b];
    const int32_t hold = crushHold[b];
    if (hold != 0) {
      const int32_t ticks = (hold & 0x7fff) - 1;
      crushHold[b] = ticks > 0 ? (hold & 0x8000) | ticks : 0;
      const f64 re = rest + off;
      const f64 vr = ((velX[ib] - velX[ia]) * dx + (velY[ib] - velY[ia]) * dy + (velZ[ib] - velZ[ia]) * dz) * inv;
      if ((dist < re && vr > 0) || (dist > re && vr < 0)) {
        f64 r = re - (gain < 0 ? -gain : gain) * vr * HYST_DT;
        if (vr > 0 ? r < dist : r > dist) r = dist;
        const f64 floor = COMPRESS_FLOOR * restLen0[b];
        if (r < floor) r = floor < re ? floor : re;
        if ((hold & 0x8000) != 0) {
          rest = r - off;
          restLen[b] = rest;
        } else {
          off = r - rest;
          hystOff[b] = off;
        }
      }
    } else if (off != 0) {
      off = off * (gain > 0 ? RELAX_KEEP_CRUMPLE : RELAX_KEEP);
      if (off < 1e-7 && off > -1e-7) off = 0;
      hystOff[b] = off;
    }
    rest += off;
  }
  const f64 stretch = dist - rest;
  const int t = typeArr[b];

  f64 fs = kb * stretch;
  int slack = 0;
  if (t != 0) {
    if (t == T_BOUNDED || t == T_SHOCK) {
      const f64 hi = boundsHigh[b] * rest;
      const f64 lo = boundsLow[b] * rest;
      if (stretch > hi) fs += kb * BOUND_RAMP * (stretch - hi);
      else if (stretch < -lo) fs += kb * BOUND_RAMP * (stretch + lo);
      if (t == T_SHOCK) fs -= preloadArr[b];
    } else if (t == T_SUPPORT) {
      if (stretch > 0) slack = 1;
    }
  }
  if (slack) {
    if (dbg) strainOut[b] = 0.0f;
    return 0;
  }

  const f64 fAbs = fs < 0 ? -fs : fs;
  const f64 bf = breakFArr[b];
  if (armed && gain != 0 && fAbs > (f64)unloadTrig[b]) {
    /* crash loaded: a crumple member that yielded unloads plastically */
    const int perm = gain > 0 && restLen[b] != restLen0[b];
    const int32_t cur = crushHold[b];
    crushHold[b] = perm || (cur & 0x8000) != 0 ? 0x8000 | UNLOAD_HOLD : HELD_HOLD;
  }
  if (fAbs > bf && !(fs < 0 && rest <= COMPRESS_FLOOR * restLen0[b])) {
    activeArr[b] = 0;
    strainOut[b] = __builtin_nanf("");
    return 1;
  }

  const f64 df = deformArr[b];
  if (fAbs > df) {
    const f64 r0 = restLen0[b];
    const f64 dfe = (fs > 0 ? rest < r0 : rest > r0) ? df * REVERSE_FACTOR : df;
    if (fAbs > dfe) {
      const f64 excess = (fAbs - dfe) / kb;
      if (fs > 0) {
        restLen[b] = rest + RATCHET * excess;
      } else {
        const f64 floor = COMPRESS_FLOOR * r0;
        const f64 r = rest - RATCHET * excess;
        restLen[b] = r > floor ? r : floor < rest ? floor : rest;
      }
      /* a yielding member's temporary crush offset becomes part of its (plastic) rest length */
      if (gain != 0) hystOff[b] = 0;
      const f64 kFloor = K_FLOOR * k0Arr[b];
      const f64 kNew = kb * WEAKEN;
      kArr[b] = kNew > kFloor ? kNew : kFloor;
    }
  }

  const f64 vrel = ((velX[ib] - velX[ia]) * dx + (velY[ib] - velY[ia]) * dy + (velZ[ib] - velZ[ia]) * dz) * inv;
  const f64 f = (fs + dArr[b] * vrel) * inv;
  const f64 fx = f * dx;
  const f64 fy = f * dy;
  const f64 fz = f * dz;
  frcX[ia] = frcX[ia] + fx;
  frcY[ia] = frcY[ia] + fy;
  frcZ[ia] = frcZ[ia] + fz;
  frcX[ib] = frcX[ib] - fx;
  frcY[ib] = frcY[ib] - fy;
  frcZ[ib] = frcZ[ib] - fz;

  if (dbg) {
    const f64 s = fs / bf;
    strainOut[b] = (float)(s > 1 ? 1 : s < -1 ? -1 : s);
  }
  return 0;
}

#ifdef CRUMPLE_SIMD
/*
 * Two beams in f64x2 lanes. Fast path = both active, type normal,
 * non-degenerate, |fs| ≤ deform and ≤ breakF (no plasticity, no break):
 * then the per-lane arithmetic is the scalar path's, op for op. Otherwise
 * both beams run the scalar path (nothing was written yet). Returns a
 * bitmask: bit 0 = beam b broke, bit 1 = beam b + 1 broke.
 */
static inline int beam_pair(int b, int dbg, int armed) {
  const int b1 = b + 1;
  /* crush unloading in flight (a hold or an offset) runs the scalar path */
  if ((activeArr[b] & activeArr[b1]) == 0 || (typeArr[b] | typeArr[b1]) != 0 || (crushHold[b] | crushHold[b1]) != 0 ||
      hystOff[b] != 0 || hystOff[b1] != 0) {
    const int r0 = beam_scalar(b, dbg, armed);
    return r0 | (beam_scalar(b1, dbg, armed) << 1);
  }
  const int32_t ia0 = aIdx[b], ia1 = aIdx[b1];
  const int32_t ib0 = bIdx[b], ib1 = bIdx[b1];
  const v128_t dx = wasm_f64x2_sub(wasm_f64x2_make(posX[ib0], posX[ib1]), wasm_f64x2_make(posX[ia0], posX[ia1]));
  const v128_t dy = wasm_f64x2_sub(wasm_f64x2_make(posY[ib0], posY[ib1]), wasm_f64x2_make(posY[ia0], posY[ia1]));
  const v128_t dz = wasm_f64x2_sub(wasm_f64x2_make(posZ[ib0], posZ[ib1]), wasm_f64x2_make(posZ[ia0], posZ[ia1]));
  const v128_t dist = wasm_f64x2_sqrt(
      wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(dx, dx), wasm_f64x2_mul(dy, dy)), wasm_f64x2_mul(dz, dz)));
  const v128_t kb = wasm_v128_load(kArr + b);
  const v128_t stretch = wasm_f64x2_sub(dist, wasm_v128_load(restLen + b));
  const v128_t fs = wasm_f64x2_mul(kb, stretch);
  const v128_t fAbs = wasm_f64x2_abs(fs); /* comparisons only: |−0| and NaN compare like the ternary */
  const v128_t bf = wasm_v128_load(breakFArr + b);
  const v128_t rare = wasm_v128_or(
      wasm_v128_or(wasm_f64x2_lt(dist, wasm_f64x2_splat(MIN_DIST)), wasm_f64x2_gt(fAbs, bf)),
      wasm_f64x2_gt(fAbs, wasm_v128_load(deformArr + b)));
  /* a crash trigger (armed, gain ≠ 0, |F| past the trigger) starts a hold: scalar path */
  const int trig = armed && ((unloadGain[b] != 0 && wasm_f64x2_extract_lane(fAbs, 0) > (f64)unloadTrig[b]) ||
                             (unloadGain[b1] != 0 && wasm_f64x2_extract_lane(fAbs, 1) > (f64)unloadTrig[b1]));
  if (wasm_v128_any_true(rare) || trig) {
    const int r0 = beam_scalar(b, dbg, armed);
    return r0 | (beam_scalar(b1, dbg, armed) << 1);
  }
  const v128_t inv = wasm_f64x2_div(wasm_f64x2_splat(1.0), dist);
  const v128_t dvx = wasm_f64x2_sub(wasm_f64x2_make(velX[ib0], velX[ib1]), wasm_f64x2_make(velX[ia0], velX[ia1]));
  const v128_t dvy = wasm_f64x2_sub(wasm_f64x2_make(velY[ib0], velY[ib1]), wasm_f64x2_make(velY[ia0], velY[ia1]));
  const v128_t dvz = wasm_f64x2_sub(wasm_f64x2_make(velZ[ib0], velZ[ib1]), wasm_f64x2_make(velZ[ia0], velZ[ia1]));
  const v128_t vrel = wasm_f64x2_mul(
      wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(dvx, dx), wasm_f64x2_mul(dvy, dy)), wasm_f64x2_mul(dvz, dz)), inv);
  const v128_t f = wasm_f64x2_mul(wasm_f64x2_add(fs, wasm_f64x2_mul(wasm_v128_load(dArr + b), vrel)), inv);
  const v128_t fx = wasm_f64x2_mul(f, dx);
  const v128_t fy = wasm_f64x2_mul(f, dy);
  const v128_t fz = wasm_f64x2_mul(f, dz);
  /* Sequential scatter in beam order (beam b fully, then b + 1). */
  const f64 fx0 = wasm_f64x2_extract_lane(fx, 0), fy0 = wasm_f64x2_extract_lane(fy, 0), fz0 = wasm_f64x2_extract_lane(fz, 0);
  const f64 fx1 = wasm_f64x2_extract_lane(fx, 1), fy1 = wasm_f64x2_extract_lane(fy, 1), fz1 = wasm_f64x2_extract_lane(fz, 1);
  frcX[ia0] = frcX[ia0] + fx0;
  frcY[ia0] = frcY[ia0] + fy0;
  frcZ[ia0] = frcZ[ia0] + fz0;
  frcX[ib0] = frcX[ib0] - fx0;
  frcY[ib0] = frcY[ib0] - fy0;
  frcZ[ib0] = frcZ[ib0] - fz0;
  frcX[ia1] = frcX[ia1] + fx1;
  frcY[ia1] = frcY[ia1] + fy1;
  frcZ[ia1] = frcZ[ia1] + fz1;
  frcX[ib1] = frcX[ib1] - fx1;
  frcY[ib1] = frcY[ib1] - fy1;
  frcZ[ib1] = frcZ[ib1] - fz1;
  if (dbg) {
    const v128_t s = wasm_f64x2_div(fs, bf);
    const f64 s0 = wasm_f64x2_extract_lane(s, 0), s1 = wasm_f64x2_extract_lane(s, 1);
    strainOut[b] = (float)(s0 > 1 ? 1 : s0 < -1 ? -1 : s0);
    strainOut[b1] = (float)(s1 > 1 ? 1 : s1 < -1 ? -1 : s1);
  }
  return 0;
}
#endif

/*
 * applyBeamForces over beams [first, first + count). Returns the number of
 * beams broken; their indices are breakList[0..n) in discovery order.
 */
EXPORT(beams) int beams(int first, int count, int dbg, int armed) {
  const int end = first + count;
  int nb = 0;
  int b = first;
#ifdef CRUMPLE_SIMD
  for (; b + 1 < end; b += 2) {
    const int r = beam_pair(b, dbg, armed);
    if (r != 0) {
      if (r & 1) breakList[nb++] = b;
      if (r & 2) breakList[nb++] = b + 1;
    }
  }
#endif
  for (; b < end; b++) {
    if (beam_scalar(b, dbg, armed)) breakList[nb++] = b;
  }
  return nb;
}

/* ------------------------------------------------------------ integrator */
/* integrateNodes over [first, first + count). */
EXPORT(integrate) void integrate(int first, int count, f64 dt, f64 gx, f64 gy, f64 gz) {
  const int end = first + count;
  for (int i = first; i < end; i++) {
    const f64 im = invMass[i];
    if (im == 0) {
      velX[i] = 0;
      velY[i] = 0;
      velZ[i] = 0;
    } else {
      const f64 vx = velX[i] + (frcX[i] * im + gx) * dt;
      const f64 vy = velY[i] + (frcY[i] * im + gy) * dt;
      const f64 vz = velZ[i] + (frcZ[i] * im + gz) * dt;
      velX[i] = vx;
      velY[i] = vy;
      velZ[i] = vz;
      posX[i] = posX[i] + vx * dt;
      posY[i] = posY[i] + vy * dt;
      posZ[i] = posZ[i] + vz * dt;
    }
    frcX[i] = 0;
    frcY[i] = 0;
    frcZ[i] = 0;
  }
}

/* ------------------------------------------------------------ shell clusters (vehicle/shell.ts applyShell) */
/*
 * Per-runtime header block (f64 slots; ints stored exactly), written by the
 * glue (src/sim/wasm/kernel.ts SHELL_*), outputs written back by shell().
 */
enum {
  SH_N, SH_NTIERS, SH_NODES, SH_W, SH_MASS, SH_REST, SH_VS, SH_TIER, SH_GONE, SH_RELEASE, SH_WHOLE, SH_YIELDS,
  SH_TRIPPED, SH_R, SH_K, SH_CD, SH_CONTACT_RELEASE,
  /* outputs */
  SH_RELEASED_INC, SH_NEW_RELEASE, SH_MAX_DEV2, SH_MAX_REL2, SH_SUM_REL2, SH_NREL, SH_CX, SH_CY, SH_CZ,
  SH_HEADER
};

#define NODE_FLAG_IN_CONTACT 2
#define NODE_FLAG_OBJ_TOUCH 16
#define NODE_FLAG_OBJ_IMPACT 32
#define POLAR_ITERS 12

/* polar3 of shell.ts: rotation factor by scaled Newton iteration; 0 when det ≤ 1e-30. */
static int polar3(const f64 *a, f64 *out) {
  f64 x0 = a[0], x1 = a[1], x2 = a[2], x3 = a[3], x4 = a[4], x5 = a[5], x6 = a[6], x7 = a[7], x8 = a[8];
  for (int it = 0; it < POLAR_ITERS; it++) {
    const f64 c0 = x4 * x8 - x5 * x7;
    const f64 c1 = x5 * x6 - x3 * x8;
    const f64 c2 = x3 * x7 - x4 * x6;
    const f64 c3 = x2 * x7 - x1 * x8;
    const f64 c4 = x0 * x8 - x2 * x6;
    const f64 c5 = x1 * x6 - x0 * x7;
    const f64 c6 = x1 * x5 - x2 * x4;
    const f64 c7 = x2 * x3 - x0 * x5;
    const f64 c8 = x0 * x4 - x1 * x3;
    const f64 det = x0 * c0 + x1 * c1 + x2 * c2;
    if (!(det > 1e-30)) return 0;
    const f64 inv = 1 / det;
    const f64 nx = x0 * x0 + x1 * x1 + x2 * x2 + x3 * x3 + x4 * x4 + x5 * x5 + x6 * x6 + x7 * x7 + x8 * x8;
    const f64 ni = (c0 * c0 + c1 * c1 + c2 * c2 + c3 * c3 + c4 * c4 + c5 * c5 + c6 * c6 + c7 * c7 + c8 * c8) * inv * inv;
    const f64 g = __builtin_sqrt(__builtin_sqrt(ni / nx));
    const f64 ga = 0.5 * g;
    const f64 gb = (0.5 / g) * inv;
    const f64 y0 = ga * x0 + gb * c0;
    const f64 y1 = ga * x1 + gb * c1;
    const f64 y2 = ga * x2 + gb * c2;
    const f64 y3 = ga * x3 + gb * c3;
    const f64 y4 = ga * x4 + gb * c4;
    const f64 y5 = ga * x5 + gb * c5;
    const f64 y6 = ga * x6 + gb * c6;
    const f64 y7 = ga * x7 + gb * c7;
    const f64 y8 = ga * x8 + gb * c8;
    const f64 d = (y0 - x0) * (y0 - x0) + (y1 - x1) * (y1 - x1) + (y2 - x2) * (y2 - x2) +
        (y3 - x3) * (y3 - x3) + (y4 - x4) * (y4 - x4) + (y5 - x5) * (y5 - x5) +
        (y6 - x6) * (y6 - x6) + (y7 - x7) * (y7 - x7) + (y8 - x8) * (y8 - x8);
    x0 = y0; x1 = y1; x2 = y2; x3 = y3; x4 = y4; x5 = y5; x6 = y6; x7 = y7; x8 = y8;
    if (d < 1e-26) break;
  }
  out[0] = x0; out[1] = x1; out[2] = x2; out[3] = x3; out[4] = x4; out[5] = x5; out[6] = x6; out[7] = x7; out[8] = x8;
  return 1;
}

/* Accumulators of the shell's force pass (pass 3). */
typedef struct {
  f64 maxDev2, maxRel2, sumRel2;
  int nRel, newRelease, releasedInc;
} ShellAcc;

/* Pass 3 for one cluster node q: exactly applyShell's loop body. */
static inline void shell_node(int q, const int32_t *nodes, f64 *w, const f64 *mass, f64 *rest, const f64 *vs,
                              const uint8_t *tier, const uint8_t *gone, const f64 *rel, const uint8_t *whole,
                              const uint8_t *yields, uint8_t *tripped, const f64 *R, f64 cx, f64 cy, f64 cz,
                              f64 rx, f64 ry, f64 rz, f64 vx, f64 vy, f64 vz, f64 ox, f64 oy, f64 oz, f64 beta,
                              f64 kdt, f64 cr, f64 idt, f64 inv1b, ShellAcc *acc) {
  const f64 r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
  const f64 wq = w[q];
  const int32_t i = nodes[q];
  if (invMass[i] == 0) return;
  const f64 px = posX[i], py = posY[i], pz = posZ[i];
  const f64 qx = rest[3 * q] - rx, qy = rest[3 * q + 1] - ry, qz = rest[3 * q + 2] - rz;
  const f64 ex = px - (cx + r0 * qx + r1 * qy + r2 * qz);
  const f64 ey = py - (cy + r3 * qx + r4 * qy + r5 * qz);
  const f64 ez = pz - (cz + r6 * qx + r7 * qy + r8 * qz);
  const f64 dx = px - cx, dy = py - cy, dz = pz - cz;
  const f64 ux = vx + (oy * dz - oz * dy) - vs[3 * q];
  const f64 uy = vy + (oz * dx - ox * dz) - vs[3 * q + 1];
  const f64 uz = vz + (ox * dy - oy * dx) - vs[3 * q + 2];
  if (wq == 0) {
    if (gone[q] != 0) return;
    const f64 r2v = ux * ux + uy * uy + uz * uz;
    if (r2v > acc->maxRel2) acc->maxRel2 = r2v;
    acc->sumRel2 += r2v;
    acc->nRel++;
    return;
  }
  const f64 e2 = ex * ex + ey * ey + ez * ez;
  if (e2 > acc->maxDev2) acc->maxDev2 = e2;
  const f64 u2 = ux * ux + uy * uy + uz * uz;
  f64 wn = wq;
  const int tq = tier[q];
  const int ro = 4 * tq;
  const f64 lo = rel[ro];
  const f64 vlo = rel[ro + 2];
  if (tripped[tq] != 0) {
    wn = 0;
    w[q] = 0;
    if (wq == 1) acc->releasedInc++;
    acc->newRelease = 1;
  } else if (yields[tq] != 0 && u2 <= vlo * vlo && ((nodeFlags[i] & (NODE_FLAG_IN_CONTACT | NODE_FLAG_OBJ_TOUCH)) == 0 || e2 <= cr * cr) &&
             /* R-CRASH: a crumple-zone node struck by another object releases its zone */
             !((nodeFlags[i] & NODE_FLAG_OBJ_IMPACT) != 0 && whole[tq] != 0)) {
    if (e2 > lo * lo) {
      const f64 f = 1 - lo / __builtin_sqrt(e2);
      const f64 fx = ex * f, fy = ey * f, fz = ez * f;
      rest[3 * q] += r0 * fx + r3 * fy + r6 * fz;
      rest[3 * q + 1] += r1 * fx + r4 * fy + r7 * fz;
      rest[3 * q + 2] += r2 * fx + r5 * fy + r8 * fz;
    }
  } else if (e2 > lo * lo || u2 > vlo * vlo || ((nodeFlags[i] & NODE_FLAG_OBJ_IMPACT) != 0 && whole[tq] != 0)) {
    f64 t = e2 > lo * lo && yields[tq] == 0 ? (rel[ro + 1] - __builtin_sqrt(e2)) / (rel[ro + 1] - lo) : 1;
    /* R-CRASH: pressed into a contact past CONTACT_RELEASE, or struck by another object (whole tiers): let go now */
    const uint8_t fl = nodeFlags[i];
    if (yields[tq] != 0 && ((((fl & (NODE_FLAG_IN_CONTACT | NODE_FLAG_OBJ_TOUCH)) != 0) && e2 > cr * cr) || ((fl & NODE_FLAG_OBJ_IMPACT) != 0 && whole[tq] != 0))) t = 0;
    if (u2 > vlo * vlo) {
      const f64 tv = (rel[ro + 3] - __builtin_sqrt(u2)) / (rel[ro + 3] - vlo);
      if (tv < t) t = tv;
    }
    f64 wt = t < 0 ? 0 : t;
    if (wt < wq && whole[tq] != 0) {
      tripped[tq] = 1;
      wt = 0;
    }
    if (wt < wq) {
      wn = wt;
      if (wq == 1) acc->releasedInc++;
      w[q] = wt;
      acc->newRelease = 1;
    }
  }
  if (wn < 1) {
    if (u2 > acc->maxRel2) acc->maxRel2 = u2;
    acc->sumRel2 += u2;
    acc->nRel++;
  }
  if (wn == 0) return;
  const f64 f = wn * mass[q] * idt * inv1b;
  frcX[i] += f * (beta * ux - kdt * ex);
  frcY[i] += f * (beta * uy - kdt * ey);
  frcZ[i] += f * (beta * uz - kdt * ez);
}

#ifdef CRUMPLE_SIMD
#define V2(a, b) wasm_f64x2_make((a), (b))
#define SPL(a) wasm_f64x2_splat(a)
#define ADD wasm_f64x2_add
#define SUB wasm_f64x2_sub
#define MUL wasm_f64x2_mul
#define L0(v) wasm_f64x2_extract_lane((v), 0)
#define L1(v) wasm_f64x2_extract_lane((v), 1)
#endif

/*
 * applyShell up to (excluding) the recapture check, which the glue runs in JS
 * (shellRecaptureCheck) from the outputs. Returns 1 when the force pass ran,
 * 0 on the early-outs (no weight, degenerate rotation) like the JS returns.
 * SIMD build: per-node products in f64x2 lanes (two cluster nodes), every
 * reduction accumulated in node order exactly as the scalar loop does; in the
 * force pass a pair where either node could change state (weight < 1, tripped
 * tier, past its yield / release limits, pinned) runs shell_node in order.
 */
EXPORT(shell) int shell(f64 *H, f64 dt, f64 gx, f64 gy, f64 gz) {
  const int n = (int)H[SH_N];
  const int32_t *nodes = (const int32_t *)(uint32_t)H[SH_NODES];
  f64 *w = (f64 *)(uint32_t)H[SH_W];
  const f64 *mass = (const f64 *)(uint32_t)H[SH_MASS];
  f64 *rest = (f64 *)(uint32_t)H[SH_REST];
  f64 *vs = (f64 *)(uint32_t)H[SH_VS];
  const uint8_t *tier = (const uint8_t *)(uint32_t)H[SH_TIER];
  const uint8_t *gone = (const uint8_t *)(uint32_t)H[SH_GONE];
  const f64 *rel = (const f64 *)(uint32_t)H[SH_RELEASE];
  const uint8_t *whole = (const uint8_t *)(uint32_t)H[SH_WHOLE];
  const uint8_t *yields = (const uint8_t *)(uint32_t)H[SH_YIELDS];
  uint8_t *tripped = (uint8_t *)(uint32_t)H[SH_TRIPPED];
  f64 *Rout = (f64 *)(uint32_t)H[SH_R];

  f64 W = 0;
  f64 cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, rx = 0, ry = 0, rz = 0;
  int k = 0;
#ifdef CRUMPLE_SIMD
  {
    const v128_t vdt = SPL(dt), vgx = SPL(gx), vgy = SPL(gy), vgz = SPL(gz);
    for (; k + 1 < n; k += 2) {
      const int32_t i0 = nodes[k], i1 = nodes[k + 1];
      const v128_t im = V2(invMass[i0], invMass[i1]);
      const v128_t v0 = ADD(V2(velX[i0], velX[i1]), MUL(ADD(MUL(V2(frcX[i0], frcX[i1]), im), vgx), vdt));
      const v128_t v1 = ADD(V2(velY[i0], velY[i1]), MUL(ADD(MUL(V2(frcY[i0], frcY[i1]), im), vgy), vdt));
      const v128_t v2 = ADD(V2(velZ[i0], velZ[i1]), MUL(ADD(MUL(V2(frcZ[i0], frcZ[i1]), im), vgz), vdt));
      vs[3 * k] = L0(v0); vs[3 * k + 1] = L0(v1); vs[3 * k + 2] = L0(v2);
      vs[3 * k + 3] = L1(v0); vs[3 * k + 4] = L1(v1); vs[3 * k + 5] = L1(v2);
      const v128_t m = MUL(wasm_v128_load(w + k), wasm_v128_load(mass + k));
      const v128_t mpx = MUL(m, V2(posX[i0], posX[i1])), mpy = MUL(m, V2(posY[i0], posY[i1])), mpz = MUL(m, V2(posZ[i0], posZ[i1]));
      const v128_t mvx = MUL(m, v0), mvy = MUL(m, v1), mvz = MUL(m, v2);
      const v128_t mrx = MUL(m, V2(rest[3 * k], rest[3 * k + 3])), mry = MUL(m, V2(rest[3 * k + 1], rest[3 * k + 4])), mrz = MUL(m, V2(rest[3 * k + 2], rest[3 * k + 5]));
      if (!(L0(m) == 0 || L0(im) == 0)) {
        W += L0(m);
        cx += L0(mpx); cy += L0(mpy); cz += L0(mpz);
        vx += L0(mvx); vy += L0(mvy); vz += L0(mvz);
        rx += L0(mrx); ry += L0(mry); rz += L0(mrz);
      }
      if (!(L1(m) == 0 || L1(im) == 0)) {
        W += L1(m);
        cx += L1(mpx); cy += L1(mpy); cz += L1(mpz);
        vx += L1(mvx); vy += L1(mvy); vz += L1(mvz);
        rx += L1(mrx); ry += L1(mry); rz += L1(mrz);
      }
    }
  }
#endif
  for (; k < n; k++) {
    const int32_t i = nodes[k];
    const f64 im = invMass[i];
    const f64 v0 = velX[i] + (frcX[i] * im + gx) * dt;
    const f64 v1 = velY[i] + (frcY[i] * im + gy) * dt;
    const f64 v2 = velZ[i] + (frcZ[i] * im + gz) * dt;
    vs[3 * k] = v0;
    vs[3 * k + 1] = v1;
    vs[3 * k + 2] = v2;
    const f64 m = w[k] * mass[k];
    if (m == 0 || im == 0) continue;
    W += m;
    cx += m * posX[i]; cy += m * posY[i]; cz += m * posZ[i];
    vx += m * v0; vy += m * v1; vz += m * v2;
    rx += m * rest[3 * k]; ry += m * rest[3 * k + 1]; rz += m * rest[3 * k + 2];
  }
  if (!(W > 0)) return 0;
  const f64 iW = 1 / W;
  cx *= iW; cy *= iW; cz *= iW; vx *= iW; vy *= iW; vz *= iW; rx *= iW; ry *= iW; rz *= iW;
  f64 A[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
  f64 lx = 0, ly = 0, lz = 0;
  f64 ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
  k = 0;
#ifdef CRUMPLE_SIMD
  {
    const v128_t vcx = SPL(cx), vcy = SPL(cy), vcz = SPL(cz), vrx = SPL(rx), vry = SPL(ry), vrz = SPL(rz), vvx = SPL(vx), vvy = SPL(vy), vvz = SPL(vz);
    for (; k + 1 < n; k += 2) {
      const int32_t i0 = nodes[k], i1 = nodes[k + 1];
      const v128_t m = MUL(wasm_v128_load(w + k), wasm_v128_load(mass + k));
      const int ok0 = !(L0(m) == 0) && !(invMass[i0] == 0);
      const int ok1 = !(L1(m) == 0) && !(invMass[i1] == 0);
      if (!ok0 && !ok1) continue;
      const v128_t dx = SUB(V2(posX[i0], posX[i1]), vcx), dy = SUB(V2(posY[i0], posY[i1]), vcy), dz = SUB(V2(posZ[i0], posZ[i1]), vcz);
      const v128_t qx = SUB(V2(rest[3 * k], rest[3 * k + 3]), vrx), qy = SUB(V2(rest[3 * k + 1], rest[3 * k + 4]), vry), qz = SUB(V2(rest[3 * k + 2], rest[3 * k + 5]), vrz);
      const v128_t mdx = MUL(m, dx), mdy = MUL(m, dy), mdz = MUL(m, dz);
      const v128_t a0 = MUL(mdx, qx), a1 = MUL(mdx, qy), a2 = MUL(mdx, qz);
      const v128_t a3 = MUL(mdy, qx), a4 = MUL(mdy, qy), a5 = MUL(mdy, qz);
      const v128_t a6 = MUL(mdz, qx), a7 = MUL(mdz, qy), a8 = MUL(mdz, qz);
      const v128_t ux = SUB(V2(vs[3 * k], vs[3 * k + 3]), vvx), uy = SUB(V2(vs[3 * k + 1], vs[3 * k + 4]), vvy), uz = SUB(V2(vs[3 * k + 2], vs[3 * k + 5]), vvz);
      const v128_t tlx = MUL(m, SUB(MUL(dy, uz), MUL(dz, uy)));
      const v128_t tly = MUL(m, SUB(MUL(dz, ux), MUL(dx, uz)));
      const v128_t tlz = MUL(m, SUB(MUL(dx, uy), MUL(dy, ux)));
      const v128_t txx = MUL(m, ADD(MUL(dy, dy), MUL(dz, dz)));
      const v128_t tyy = MUL(m, ADD(MUL(dx, dx), MUL(dz, dz)));
      const v128_t tzz = MUL(m, ADD(MUL(dx, dx), MUL(dy, dy)));
      const v128_t txy = MUL(mdx, dy), txz = MUL(mdx, dz), tyz = MUL(mdy, dz);
#define SHELL_ACC2(L)                                                                                     \
  A[0] += L(a0); A[1] += L(a1); A[2] += L(a2); A[3] += L(a3); A[4] += L(a4); A[5] += L(a5);           \
  A[6] += L(a6); A[7] += L(a7); A[8] += L(a8);                                                          \
  lx += L(tlx); ly += L(tly); lz += L(tlz);                                                             \
  ixx += L(txx); iyy += L(tyy); izz += L(tzz);                                                          \
  ixy -= L(txy); ixz -= L(txz); iyz -= L(tyz);
      if (ok0) { SHELL_ACC2(L0) }
      if (ok1) { SHELL_ACC2(L1) }
#undef SHELL_ACC2
    }
  }
#endif
  for (; k < n; k++) {
    const f64 m = w[k] * mass[k];
    if (m == 0) continue;
    const int32_t i = nodes[k];
    if (invMass[i] == 0) continue;
    const f64 dx = posX[i] - cx, dy = posY[i] - cy, dz = posZ[i] - cz;
    const f64 qx = rest[3 * k] - rx, qy = rest[3 * k + 1] - ry, qz = rest[3 * k + 2] - rz;
    A[0] += m * dx * qx; A[1] += m * dx * qy; A[2] += m * dx * qz;
    A[3] += m * dy * qx; A[4] += m * dy * qy; A[5] += m * dy * qz;
    A[6] += m * dz * qx; A[7] += m * dz * qy; A[8] += m * dz * qz;
    const f64 ux = vs[3 * k] - vx, uy = vs[3 * k + 1] - vy, uz = vs[3 * k + 2] - vz;
    lx += m * (dy * uz - dz * uy);
    ly += m * (dz * ux - dx * uz);
    lz += m * (dx * uy - dy * ux);
    ixx += m * (dy * dy + dz * dz);
    iyy += m * (dx * dx + dz * dz);
    izz += m * (dx * dx + dy * dy);
    ixy -= m * dx * dy;
    ixz -= m * dx * dz;
    iyz -= m * dy * dz;
  }
  f64 R[9];
  if (!polar3(A, R)) return 0;
  for (int j = 0; j < 9; j++) Rout[j] = R[j];
  const f64 j0 = iyy * izz - iyz * iyz;
  const f64 j1 = ixz * iyz - ixy * izz;
  const f64 j2 = ixy * iyz - ixz * iyy;
  const f64 det = ixx * j0 + ixy * j1 + ixz * j2;
  f64 ox = 0, oy = 0, oz = 0;
  if (det > 1e-30) {
    const f64 j4 = ixx * izz - ixz * ixz;
    const f64 j5 = ixy * ixz - ixx * iyz;
    const f64 j8 = ixx * iyy - ixy * ixy;
    const f64 id = 1 / det;
    ox = (j0 * lx + j1 * ly + j2 * lz) * id;
    oy = (j1 * lx + j4 * ly + j5 * lz) * id;
    oz = (j2 * lx + j5 * ly + j8 * lz) * id;
  }
  const f64 kk = H[SH_K];
  const f64 beta = H[SH_CD] * dt + kk * dt * dt;
  const f64 inv1b = 1 / (1 + beta);
  const f64 kdt = kk * dt;
  const f64 cr = H[SH_CONTACT_RELEASE];
  const f64 idt = 1 / dt;
  ShellAcc acc = {0, 0, 0, 0, 0, 0};
  int q = 0;
#ifdef CRUMPLE_SIMD
  {
    const v128_t r0 = SPL(R[0]), r1 = SPL(R[1]), r2 = SPL(R[2]), r3 = SPL(R[3]), r4 = SPL(R[4]), r5 = SPL(R[5]), r6 = SPL(R[6]), r7 = SPL(R[7]), r8 = SPL(R[8]);
    const v128_t vcx = SPL(cx), vcy = SPL(cy), vcz = SPL(cz), vrx = SPL(rx), vry = SPL(ry), vrz = SPL(rz);
    const v128_t vvx = SPL(vx), vvy = SPL(vy), vvz = SPL(vz), vox = SPL(ox), voy = SPL(oy), voz = SPL(oz);
    const v128_t vbeta = SPL(beta), vkdt = SPL(kdt), vidt = SPL(idt), vinv1b = SPL(inv1b), one = SPL(1.0);
    for (; q + 1 < n; q += 2) {
      const int32_t i0 = nodes[q], i1 = nodes[q + 1];
      const int t0 = tier[q], t1 = tier[q + 1];
      /* (R-CRASH: a node struck by another object on a whole-zone tier releases even inside its limits) */
      if (w[q] != 1 || w[q + 1] != 1 || invMass[i0] == 0 || invMass[i1] == 0 || tripped[t0] != 0 || tripped[t1] != 0 ||
          ((nodeFlags[i0] & NODE_FLAG_OBJ_IMPACT) != 0 && whole[t0] != 0) || ((nodeFlags[i1] & NODE_FLAG_OBJ_IMPACT) != 0 && whole[t1] != 0)) {
        shell_node(q, nodes, w, mass, rest, vs, tier, gone, rel, whole, yields, tripped, R, cx, cy, cz, rx, ry, rz, vx, vy, vz, ox, oy, oz, beta, kdt, cr, idt, inv1b, &acc);
        shell_node(q + 1, nodes, w, mass, rest, vs, tier, gone, rel, whole, yields, tripped, R, cx, cy, cz, rx, ry, rz, vx, vy, vz, ox, oy, oz, beta, kdt, cr, idt, inv1b, &acc);
        continue;
      }
      const v128_t px = V2(posX[i0], posX[i1]), py = V2(posY[i0], posY[i1]), pz = V2(posZ[i0], posZ[i1]);
      const v128_t qx = SUB(V2(rest[3 * q], rest[3 * q + 3]), vrx), qy = SUB(V2(rest[3 * q + 1], rest[3 * q + 4]), vry), qz = SUB(V2(rest[3 * q + 2], rest[3 * q + 5]), vrz);
      const v128_t ex = SUB(px, ADD(ADD(ADD(vcx, MUL(r0, qx)), MUL(r1, qy)), MUL(r2, qz)));
      const v128_t ey = SUB(py, ADD(ADD(ADD(vcy, MUL(r3, qx)), MUL(r4, qy)), MUL(r5, qz)));
      const v128_t ez = SUB(pz, ADD(ADD(ADD(vcz, MUL(r6, qx)), MUL(r7, qy)), MUL(r8, qz)));
      const v128_t dx = SUB(px, vcx), dy = SUB(py, vcy), dz = SUB(pz, vcz);
      const v128_t ux = SUB(ADD(vvx, SUB(MUL(voy, dz), MUL(voz, dy))), V2(vs[3 * q], vs[3 * q + 3]));
      const v128_t uy = SUB(ADD(vvy, SUB(MUL(voz, dx), MUL(vox, dz))), V2(vs[3 * q + 1], vs[3 * q + 4]));
      const v128_t uz = SUB(ADD(vvz, SUB(MUL(vox, dy), MUL(voy, dx))), V2(vs[3 * q + 2], vs[3 * q + 5]));
      const v128_t e2 = ADD(ADD(MUL(ex, ex), MUL(ey, ey)), MUL(ez, ez));
      const v128_t u2 = ADD(ADD(MUL(ux, ux), MUL(uy, uy)), MUL(uz, uz));
      const f64 lo0 = rel[4 * t0], vlo0 = rel[4 * t0 + 2], lo1 = rel[4 * t1], vlo1 = rel[4 * t1 + 2];
      /* Inside both limits: no branch of shell_node changes any state (weight stays 1, rest unchanged). */
      if (!(L0(e2) <= lo0 * lo0 && L0(u2) <= vlo0 * vlo0 && L1(e2) <= lo1 * lo1 && L1(u2) <= vlo1 * vlo1)) {
        shell_node(q, nodes, w, mass, rest, vs, tier, gone, rel, whole, yields, tripped, R, cx, cy, cz, rx, ry, rz, vx, vy, vz, ox, oy, oz, beta, kdt, cr, idt, inv1b, &acc);
        shell_node(q + 1, nodes, w, mass, rest, vs, tier, gone, rel, whole, yields, tripped, R, cx, cy, cz, rx, ry, rz, vx, vy, vz, ox, oy, oz, beta, kdt, cr, idt, inv1b, &acc);
        continue;
      }
      if (L0(e2) > acc.maxDev2) acc.maxDev2 = L0(e2);
      if (L1(e2) > acc.maxDev2) acc.maxDev2 = L1(e2);
      const v128_t f = MUL(MUL(MUL(one, wasm_v128_load(mass + q)), vidt), vinv1b);
      const v128_t fx = MUL(f, SUB(MUL(vbeta, ux), MUL(vkdt, ex)));
      const v128_t fy = MUL(f, SUB(MUL(vbeta, uy), MUL(vkdt, ey)));
      const v128_t fz = MUL(f, SUB(MUL(vbeta, uz), MUL(vkdt, ez)));
      frcX[i0] += L0(fx); frcY[i0] += L0(fy); frcZ[i0] += L0(fz);
      frcX[i1] += L1(fx); frcY[i1] += L1(fy); frcZ[i1] += L1(fz);
    }
  }
#endif
  for (; q < n; q++)
    shell_node(q, nodes, w, mass, rest, vs, tier, gone, rel, whole, yields, tripped, R, cx, cy, cz, rx, ry, rz, vx, vy, vz, ox, oy, oz, beta, kdt, cr, idt, inv1b, &acc);
  H[SH_RELEASED_INC] = acc.releasedInc;
  H[SH_NEW_RELEASE] = acc.newRelease;
  H[SH_MAX_DEV2] = acc.maxDev2;
  H[SH_MAX_REL2] = acc.maxRel2;
  H[SH_SUM_REL2] = acc.sumRel2;
  H[SH_NREL] = acc.nRel;
  H[SH_CX] = cx;
  H[SH_CY] = cy;
  H[SH_CZ] = cz;
  return 1;
}
