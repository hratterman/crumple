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
/* Ground contact (collision/ground.ts) per-node inputs. */
static f64 *radiusArr, *frictionArr, *contactKArr, *treadAxX, *treadAxY, *treadAxZ, *treadF;

/* Pointer table layout (u32 byte offsets), shared with src/sim/wasm/kernel.ts STATE_PTRS. */
enum {
  P_POSX, P_POSY, P_POSZ, P_VELX, P_VELY, P_VELZ, P_FRCX, P_FRCY, P_FRCZ, P_INVMASS,
  P_AIDX, P_BIDX, P_K, P_D, P_RESTLEN, P_RESTLEN0, P_K0, P_DEFORM, P_BREAKF,
  P_BOUNDSLOW, P_BOUNDSHIGH, P_PRELOAD, P_TYPE, P_ACTIVE, P_STRAINOUT, P_BREAKLIST,
  P_FLAGS,
  P_UNLOADGAIN, P_UNLOADTRIG, P_CRUSHHOLD, P_HYSTOFF,
  P_RADIUS, P_FRICTION, P_CONTACTK, P_TREADAXX, P_TREADAXY, P_TREADAXZ, P_TREADF,
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
  radiusArr = (f64 *)ptrTable[P_RADIUS];
  frictionArr = (f64 *)ptrTable[P_FRICTION];
  contactKArr = (f64 *)ptrTable[P_CONTACTK];
  treadAxX = (f64 *)ptrTable[P_TREADAXX];
  treadAxY = (f64 *)ptrTable[P_TREADAXY];
  treadAxZ = (f64 *)ptrTable[P_TREADAXZ];
  treadF = (f64 *)ptrTable[P_TREADF];
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
  const f64 trig = (f64)unloadTrig[b];
  if ((armed || trig < 0) && gain != 0 && fAbs > (trig < 0 ? -trig : trig)) {
    /* crash loaded: a crumple member that yielded (or a SET member, trig < 0) unloads plastically */
    const int perm = gain > 0 && (trig < 0 || restLen[b] != restLen0[b]);
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
  const f64 t0 = (f64)unloadTrig[b], t1 = (f64)unloadTrig[b1];
  const int trig = (unloadGain[b] != 0 && (armed || t0 < 0) && wasm_f64x2_extract_lane(fAbs, 0) > (t0 < 0 ? -t0 : t0)) ||
                   (unloadGain[b1] != 0 && (armed || t1 < 0) && wasm_f64x2_extract_lane(fAbs, 1) > (t1 < 0 ? -t1 : t1));
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

/* ------------------------------------------------------------ ground (collision/ground.ts applyGroundContacts) */
/*
 * The ground pass of one object, exactly applyGroundContacts' loop body, on
 * the engine's sampler mirrored here:
 *   G_PLANE        ground.ts PlaneSampler (height y, one material);
 *   G_HEIGHTFIELD  world/sampler.ts createTerrainSampler: heightAt (bilinear
 *                  heights), normalAt (bilinear vertex normals, renormalized),
 *                  materialAt (nearest sample) — same clamps, same f32 grids.
 * The heightfield grids stay in JS; the kernel reads a TILE CACHE of them
 * (32 × 32 cells per tile, with the one-sample apron bilinear reads need):
 * per grid a tile table (byte offset of a resident tile, 0 = absent). A node
 * whose tile is absent stops the pass BEFORE anything of that node is
 * written (ground() returns its index, G_MISS_* say which tile); the glue
 * copies the tile in and resumes at that node. Impact / skid events are
 * appended to an event buffer (the glue emits them in order); a pass also
 * stops before a node when the buffer could overflow.
 */
#define NODE_FLAG_COLLIDABLE 1
#define NODE_FLAG_TREAD 4
#define TILE 32
#define TILE_S 33
#define G_PLANE 1
#define G_HEIGHTFIELD 2

static f64 KC_MAX_G, KC_STAB, CONTACT_ZETA_G, SOFT_ZETA, SLOPE_SKIP_G, IMPACT_MIN, SKID_SLIP, SKID_LOAD;
static int32_t SKID_COOLDOWN;

EXPORT(set_ground_params)
void set_ground_params(f64 kcMax, f64 kcStab, f64 zeta, f64 softZeta, f64 slopeSkip, f64 impactMin, f64 skidSlip, f64 skidLoad, int32_t skidCooldown) {
  KC_MAX_G = kcMax;
  KC_STAB = kcStab;
  CONTACT_ZETA_G = zeta;
  SOFT_ZETA = softZeta;
  SLOPE_SKIP_G = slopeSkip;
  IMPACT_MIN = impactMin;
  SKID_SLIP = skidSlip;
  SKID_LOAD = skidLoad;
  SKID_COOLDOWN = skidCooldown;
}

/* Ground description + buffers, written by the glue (G_* slots of the header it owns). */
enum {
  G_KIND, G_PLANE_Y, G_PLANE_MAT,
  G_OX, G_OZ, G_NOX, G_NOZ, G_INVS, G_MAXU, G_MAXV, G_NMAXU, G_NMAXV, G_COLS, G_LASTU, G_LASTV,
  G_HTILES, G_HTX, G_NTILES, G_NTX, G_MTILES, G_MTX,
  G_MATF, G_COOLDOWN, G_EVENTS, G_EV_CAP,
  /* per-node sample cache of this tick (wheel_sample → ground): stamp per node, ref = its sample entry */
  G_CSTAMP, G_CREF, G_STAMP,
  /* outputs */
  G_EV_COUNT, G_MISS_GRID, G_MISS_TILE,
  G_HEADER
};
static f64 *GH;

EXPORT(set_ground) void set_ground(f64 *header) { GH = header; }

/*
 * The heightfield constants, loaded from the header into a local struct once
 * per call (header loads in the node loop would be re-read after every frc*
 * store: same memory, may alias).
 */
typedef struct {
  f64 ox, oz, nox, noz, invS, maxU, maxV, nmaxU, nmaxV;
  int lastU, lastV, htx, ntx, mtx;
  const uint32_t *ht, *nt, *mt;
} Hf;

static inline void hf_load(Hf *h) {
  h->ox = GH[G_OX];
  h->oz = GH[G_OZ];
  h->nox = GH[G_NOX];
  h->noz = GH[G_NOZ];
  h->invS = GH[G_INVS];
  h->maxU = GH[G_MAXU];
  h->maxV = GH[G_MAXV];
  h->nmaxU = GH[G_NMAXU];
  h->nmaxV = GH[G_NMAXV];
  h->lastU = (int)GH[G_LASTU];
  h->lastV = (int)GH[G_LASTV];
  h->htx = (int)GH[G_HTX];
  h->ntx = (int)GH[G_NTX];
  h->mtx = (int)GH[G_MTX];
  h->ht = (const uint32_t *)(uint32_t)GH[G_HTILES];
  h->nt = (const uint32_t *)(uint32_t)GH[G_NTILES];
  h->mt = (const uint32_t *)(uint32_t)GH[G_MTILES];
}

/* heightAt's cell (c, r) and fractions; NaN coordinates take cell 0 like `| 0`. */
static inline void h_cell(const Hf *H, f64 x, f64 z, int *pc, int *pr, f64 *ptx, f64 *ptz) {
  f64 u = (x - H->ox) * H->invS;
  f64 v = (z - H->oz) * H->invS;
  if (u < 0) u = 0;
  else if (u > H->maxU) u = H->maxU;
  if (v < 0) v = 0;
  else if (v > H->maxV) v = H->maxV;
  int c = u == u ? (int)u : 0;
  int r = v == v ? (int)v : 0;
  if (c > H->lastU) c = H->lastU;
  if (r > H->lastV) r = H->lastV;
  *pc = c;
  *pr = r;
  *ptx = u - c;
  *ptz = v - r;
}

/* Tile lookups: 0 when absent (the caller records the miss). */
static inline const void *tile_at(const uint32_t *table, int tx, int c, int r, int *miss) {
  const int t = (r >> 5) * tx + (c >> 5);
  const uint32_t at = table[t];
  if (at == 0) *miss = t;
  return (const void *)at;
}

static inline f64 h_sample(const float *T, int c, int r, f64 tx, f64 tz) {
  const int l = (r & (TILE - 1)) * TILE_S + (c & (TILE - 1));
  const f64 h00 = T[l];
  const f64 h01 = T[l + TILE_S];
  const f64 a = h00 + ((f64)T[l + 1] - h00) * tx;
  return a + (h01 + ((f64)T[l + TILE_S + 1] - h01) * tx - a) * tz;
}

static inline void n_cell(const Hf *H, f64 x, f64 z, int *pc, int *pr, f64 *ptx, f64 *ptz) {
  f64 u = (x - H->nox) * H->invS;
  f64 v = (z - H->noz) * H->invS;
  if (u < 0) u = 0;
  else if (u > H->nmaxU) u = H->nmaxU;
  if (v < 0) v = 0;
  else if (v > H->nmaxV) v = H->nmaxV;
  const int c = u == u ? (int)u : 0;
  const int r = v == v ? (int)v : 0;
  *pc = c;
  *pr = r;
  *ptx = u - c;
  *ptz = v - r;
}

/* normalAt: three bilinear lerps of the f32 vertex normals, then 1/sqrt renormalization. */
static inline void n_sample(const float *T, int c, int r, f64 tx, f64 tz, f64 *out) {
  const int l = (r & (TILE - 1)) * TILE_S + (c & (TILE - 1));
  const int l1 = l + 1, j = l + TILE_S, j1 = j + 1;
  const float *X = T, *Y = T + TILE_S * TILE_S, *Z = T + 2 * TILE_S * TILE_S;
  f64 a = X[l], b = X[j];
  a = a + ((f64)X[l1] - a) * tx;
  b = b + ((f64)X[j1] - b) * tx;
  const f64 nx = a + (b - a) * tz;
  a = Y[l];
  b = Y[j];
  a = a + ((f64)Y[l1] - a) * tx;
  b = b + ((f64)Y[j1] - b) * tx;
  const f64 ny = a + (b - a) * tz;
  a = Z[l];
  b = Z[j];
  a = a + ((f64)Z[l1] - a) * tx;
  b = b + ((f64)Z[j1] - b) * tx;
  const f64 nz = a + (b - a) * tz;
  const f64 inv = 1 / __builtin_sqrt(nx * nx + ny * ny + nz * nz);
  out[0] = nx * inv;
  out[1] = ny * inv;
  out[2] = nz * inv;
}

/* materialAt's nearest sample (c, r). */
static inline void m_cell(const Hf *H, f64 x, f64 z, int *pc, int *pr) {
  f64 u = (x - H->ox) * H->invS + 0.5;
  f64 v = (z - H->oz) * H->invS + 0.5;
  if (u < 0) u = 0;
  else if (u > H->maxU) u = H->maxU;
  if (v < 0) v = 0;
  else if (v > H->maxV) v = H->maxV;
  *pc = u == u ? (int)u : 0;
  *pr = v == v ? (int)v : 0;
}

/*
 * applyGroundContacts over nodes [first, first + count). Returns the index of
 * the first node NOT processed (first + count when done): a missing tile
 * (G_MISS_GRID 1 heights / 2 normals / 3 material, G_MISS_TILE its index) or
 * a full event buffer (G_MISS_GRID 0).
 */
EXPORT(ground) int ground(int first, int count, f64 dt, f64 gx, f64 gy, f64 gz) {
  const int end = first + count;
  const int kind = (int)GH[G_KIND];
  const f64 *matF = (const f64 *)(uint32_t)GH[G_MATF];
  uint8_t *cooldown = (uint8_t *)(uint32_t)GH[G_COOLDOWN];
  f64 *ev = (f64 *)(uint32_t)GH[G_EVENTS];
  const int evCap = (int)GH[G_EV_CAP];
  int nev = 0;
  const f64 invDt = 1 / dt;
  const f64 kcStab = KC_STAB * invDt * invDt;
  const f64 planeY = GH[G_PLANE_Y];
  const int planeMat = (int)GH[G_PLANE_MAT];
  const f64 kcMax = KC_MAX_G, zeta = CONTACT_ZETA_G, softZeta = SOFT_ZETA, slopeSkip = SLOPE_SKIP_G;
  const f64 impactMin = IMPACT_MIN, skidSlip = SKID_SLIP, skidLoad = SKID_LOAD;
  const uint8_t skidCooldown = (uint8_t)SKID_COOLDOWN;
  Hf H;
  if (kind == G_HEIGHTFIELD) hf_load(&H);
  const uint32_t *cStamp = (const uint32_t *)(uint32_t)GH[G_CSTAMP];
  const uint32_t *cRef = (const uint32_t *)(uint32_t)GH[G_CREF];
  const uint32_t stamp = (uint32_t)GH[G_STAMP];
  GH[G_MISS_GRID] = 0;
  for (int i = first; i < end; i++) {
    const uint8_t f = nodeFlags[i];
    if ((f & NODE_FLAG_COLLIDABLE) == 0) {
      nodeFlags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    const f64 im = invMass[i];
    if (im == 0) {
      nodeFlags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    if (nev + 2 > evCap) {
      GH[G_EV_COUNT] = nev;
      return i;
    }
    const f64 x = posX[i];
    const f64 y = posY[i];
    const f64 z = posZ[i];
    const f64 r = radiusArr[i];
    f64 h;
    f64 nrm[3];
    int mat;
    int skip;
    if (kind == G_PLANE) {
      h = planeY;
      skip = y - h > slopeSkip * r;
      nrm[0] = 0;
      nrm[1] = 1;
      nrm[2] = 0;
      mat = planeMat;
    } else {
      /* Every tile this node may read is checked before anything is written. */
      if (cStamp[i] == stamp) {
        /* sampled by this tick's wheel pre-step (same position): its h / normal / material */
        const f64 *cs = (const f64 *)cRef[i];
        h = cs[1];
        skip = y - h > slopeSkip * r;
        mat = 0;
        if (!skip) {
          nrm[0] = cs[2];
          nrm[1] = cs[3];
          nrm[2] = cs[4];
          mat = (int)cs[5];
        }
        goto sampled;
      }
      int miss = -1, hc, hr, nc, nr, mc, mr;
      f64 htx, htz, ntx, ntz;
      h_cell(&H, x, z, &hc, &hr, &htx, &htz);
      const float *HT = (const float *)tile_at(H.ht, H.htx, hc, hr, &miss);
      if (HT == 0) {
        GH[G_MISS_GRID] = 1;
        GH[G_MISS_TILE] = miss;
        GH[G_EV_COUNT] = nev;
        return i;
      }
      h = h_sample(HT, hc, hr, htx, htz);
      skip = y - h > slopeSkip * r;
      mat = 0;
      if (!skip) {
        n_cell(&H, x, z, &nc, &nr, &ntx, &ntz);
        const float *NT = (const float *)tile_at(H.nt, H.ntx, nc, nr, &miss);
        if (NT == 0) {
          GH[G_MISS_GRID] = 2;
          GH[G_MISS_TILE] = miss;
          GH[G_EV_COUNT] = nev;
          return i;
        }
        m_cell(&H, x, z, &mc, &mr);
        const uint8_t *MT = (const uint8_t *)tile_at(H.mt, H.mtx, mc, mr, &miss);
        if (MT == 0) {
          GH[G_MISS_GRID] = 3;
          GH[G_MISS_TILE] = miss;
          GH[G_EV_COUNT] = nev;
          return i;
        }
        n_sample(NT, nc, nr, ntx, ntz, nrm);
        mat = MT[(mr & (TILE - 1)) * TILE + (mc & (TILE - 1))];
      }
    }
  sampled:;
    const uint8_t cd = cooldown[i];
    if (cd > 0) cooldown[i] = cd - 1;
    if (skip) {
      nodeFlags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    const f64 nx = nrm[0], ny = nrm[1], nz = nrm[2];
    const f64 depth = (h - y) * ny + r;
    if (!(depth > 0)) {
      nodeFlags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    const f64 m = 1 / im;
    const f64 kcm = kcStab * m;
    const f64 soft = contactKArr[i];
    f64 kc, c;
    if (soft > 0) {
      kc = soft < kcm ? soft : kcm;
      const f64 ramp = depth < r ? depth / r : 1;
      c = 2 * softZeta * __builtin_sqrt(kc * m) * ramp;
    } else {
      kc = kcm < kcMax ? kcm : kcMax;
      c = 2 * zeta * __builtin_sqrt(kc * m);
    }
    const f64 vx = velX[i], vy = velY[i], vz = velZ[i];
    const f64 vn = vx * nx + vy * ny + vz * nz;
    f64 fn = kc * depth - c * vn;
    if (fn < 0) fn = 0;
    f64 fx = fn * nx, fy = fn * ny, fz = fn * nz;
    const f64 tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    const f64 vt = __builtin_sqrt(tx * tx + ty * ty + tz * tz);
    const f64 ax = frcX[i] + m * gx;
    const f64 ay = frcY[i] + m * gy;
    const f64 az = frcZ[i] + m * gz;
    const f64 an = ax * nx + ay * ny + az * nz;
    const f64 mdt = m * invDt;
    f64 rx = -(mdt * tx + ax - an * nx);
    f64 ry = -(mdt * ty + ay - an * ny);
    f64 rz = -(mdt * tz + az - an * nz);
    f64 cone = frictionArr[i] * matF[mat] * fn;
    if ((f & NODE_FLAG_TREAD) != 0) {
      const f64 fb = treadF[i];
      const f64 muN = cone;
      const f64 rem = cone * cone - fb * fb;
      cone = rem > 0 ? __builtin_sqrt(rem) : 0;
      f64 lx = treadAxX[i], ly = treadAxY[i], lz = treadAxZ[i];
      const f64 la = __builtin_sqrt(lx * lx + ly * ly + lz * lz);
      if (la > 0) {
        lx /= la;
        ly /= la;
        lz /= la;
      }
      const f64 rl = rx * lx + ry * ly + rz * lz;
      const f64 latCap = la * muN - fb > 0 ? la * muN - fb : 0;
      const f64 rlc = rl > latCap ? latCap : rl < -latCap ? -latCap : rl;
      const f64 dl = rlc - rl;
      rx += dl * lx;
      ry += dl * ly;
      rz += dl * lz;
    }
    const f64 r2 = rx * rx + ry * ry + rz * rz;
    if (r2 > 0) {
      if (r2 <= cone * cone) {
        fx += rx;
        fy += ry;
        fz += rz;
      } else {
        const f64 sc = cone / __builtin_sqrt(r2);
        fx += sc * rx;
        fy += sc * ry;
        fz += sc * rz;
      }
    }
    frcX[i] = frcX[i] + fx;
    frcY[i] = frcY[i] + fy;
    frcZ[i] = frcZ[i] + fz;
    const f64 px = x - nx * r, py = y - ny * r, pz = z - nz * r;
    if ((f & NODE_FLAG_IN_CONTACT) == 0) {
      const f64 impulse = vn < 0 ? -vn * m : 0;
      if (impulse > impactMin) {
        f64 *e = ev + 9 * nev++;
        e[0] = 1; e[1] = mat; e[2] = px; e[3] = py; e[4] = pz; e[5] = nx; e[6] = ny; e[7] = nz; e[8] = impulse;
      }
    }
    nodeFlags[i] = f | NODE_FLAG_IN_CONTACT;
    if (vt > skidSlip && fn > skidLoad && cooldown[i] == 0) {
      cooldown[i] = skidCooldown;
      f64 *e = ev + 9 * nev++;
      e[0] = 2; e[1] = mat; e[2] = px; e[3] = py; e[4] = pz; e[5] = vt; e[6] = fn; e[7] = 0; e[8] = 0;
    }
  }
  GH[G_EV_COUNT] = nev;
  return end;
}

/* Test hooks: the mirrored sampler at one point (out: h, nx, ny, nz, mat); returns 0 on a missing tile. */
EXPORT(ground_sample) int ground_sample(f64 x, f64 z, f64 *out) {
  int miss = -1, hc, hr, nc, nr, mc, mr;
  f64 htx, htz, ntx, ntz;
  Hf H;
  hf_load(&H);
  h_cell(&H, x, z, &hc, &hr, &htx, &htz);
  n_cell(&H, x, z, &nc, &nr, &ntx, &ntz);
  m_cell(&H, x, z, &mc, &mr);
  const float *HT = (const float *)tile_at(H.ht, H.htx, hc, hr, &miss);
  if (HT == 0) { GH[G_MISS_GRID] = 1; GH[G_MISS_TILE] = miss; return 0; }
  const float *NT = (const float *)tile_at(H.nt, H.ntx, nc, nr, &miss);
  if (NT == 0) { GH[G_MISS_GRID] = 2; GH[G_MISS_TILE] = miss; return 0; }
  const uint8_t *MT = (const uint8_t *)tile_at(H.mt, H.mtx, mc, mr, &miss);
  if (MT == 0) { GH[G_MISS_GRID] = 3; GH[G_MISS_TILE] = miss; return 0; }
  out[0] = h_sample(HT, hc, hr, htx, htz);
  n_sample(NT, nc, nr, ntx, ntz, out + 1);
  out[4] = MT[(mr & (TILE - 1)) * TILE + (mc & (TILE - 1))];
  return 1;
}

/* ------------------------------------------------------------ vehicle body passes (vehicle/runtime.ts) */
/*
 * The whole-body node loops of R-PHYS's runtime.ts, operation for operation
 * (the TS stays the reference; kernelParity covers them):
 *   body_momentum  applyAero's first pass: Σ m·v over the body (m = 1/im);
 *   body_accel     applyAero's last pass: frc += a·m;
 *   drive_reaction applyDriveReaction's three body passes (COM, I about the
 *                  couple axis, the rigid-body force field).
 * Sums accumulate in node order (lanes only compute); the force scatter
 * touches each node once, so SIMD pairs store directly.
 */
EXPORT(body_momentum) void body_momentum(int start, int end, f64 *out) {
  f64 px = 0, py = 0, pz = 0;
  int i = start;
#ifdef CRUMPLE_SIMD
  const v128_t one = wasm_f64x2_splat(1.0);
  for (; i + 1 < end; i += 2) {
    const v128_t im = wasm_v128_load(invMass + i);
    const v128_t m = wasm_f64x2_div(one, im);
    const v128_t mx = wasm_f64x2_mul(m, wasm_v128_load(velX + i));
    const v128_t my = wasm_f64x2_mul(m, wasm_v128_load(velY + i));
    const v128_t mz = wasm_f64x2_mul(m, wasm_v128_load(velZ + i));
    if (wasm_f64x2_extract_lane(im, 0) != 0) {
      px += wasm_f64x2_extract_lane(mx, 0);
      py += wasm_f64x2_extract_lane(my, 0);
      pz += wasm_f64x2_extract_lane(mz, 0);
    }
    if (wasm_f64x2_extract_lane(im, 1) != 0) {
      px += wasm_f64x2_extract_lane(mx, 1);
      py += wasm_f64x2_extract_lane(my, 1);
      pz += wasm_f64x2_extract_lane(mz, 1);
    }
  }
#endif
  for (; i < end; i++) {
    const f64 im = invMass[i];
    if (im == 0) continue;
    const f64 m = 1 / im;
    px += m * velX[i];
    py += m * velY[i];
    pz += m * velZ[i];
  }
  out[0] = px;
  out[1] = py;
  out[2] = pz;
}

EXPORT(body_accel) void body_accel(int start, int end, f64 ax, f64 ay, f64 az) {
  int i = start;
#ifdef CRUMPLE_SIMD
  const v128_t one = wasm_f64x2_splat(1.0), vax = wasm_f64x2_splat(ax), vay = wasm_f64x2_splat(ay), vaz = wasm_f64x2_splat(az);
  for (; i + 1 < end; i += 2) {
    const v128_t im = wasm_v128_load(invMass + i);
    if (wasm_f64x2_extract_lane(im, 0) == 0 || wasm_f64x2_extract_lane(im, 1) == 0) {
      for (int q = i; q < i + 2; q++) {
        const f64 iq = invMass[q];
        if (iq == 0) continue;
        const f64 m = 1 / iq;
        frcX[q] = frcX[q] + ax * m;
        frcY[q] = frcY[q] + ay * m;
        frcZ[q] = frcZ[q] + az * m;
      }
      continue;
    }
    const v128_t m = wasm_f64x2_div(one, im);
    wasm_v128_store(frcX + i, wasm_f64x2_add(wasm_v128_load(frcX + i), wasm_f64x2_mul(vax, m)));
    wasm_v128_store(frcY + i, wasm_f64x2_add(wasm_v128_load(frcY + i), wasm_f64x2_mul(vay, m)));
    wasm_v128_store(frcZ + i, wasm_f64x2_add(wasm_v128_load(frcZ + i), wasm_f64x2_mul(vaz, m)));
  }
#endif
  for (; i < end; i++) {
    const f64 im = invMass[i];
    if (im == 0) continue;
    const f64 m = 1 / im;
    frcX[i] = frcX[i] + ax * m;
    frcY[i] = frcY[i] + ay * m;
    frcZ[i] = frcZ[i] + az * m;
  }
}

/* One node of applyDriveReaction's last pass. */
static inline void drive_node(int i, f64 g, f64 cx, f64 cy, f64 cz, f64 ux, f64 uy, f64 uz) {
  const f64 im = invMass[i];
  if (im == 0) return;
  const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
  const f64 a = rx * ux + ry * uy + rz * uz;
  const f64 px = rx - a * ux, py = ry - a * uy, pz = rz - a * uz;
  const f64 k = g / im;
  frcX[i] = frcX[i] + k * (uy * pz - uz * py);
  frcY[i] = frcY[i] + k * (uz * px - ux * pz);
  frcZ[i] = frcZ[i] + k * (ux * py - uy * px);
}

EXPORT(drive_reaction) void drive_reaction(int start, int end, f64 ux, f64 uy, f64 uz, f64 tl) {
  f64 m = 0, cx = 0, cy = 0, cz = 0;
  int i = start;
#ifdef CRUMPLE_SIMD
  const v128_t one = wasm_f64x2_splat(1.0);
  for (; i + 1 < end; i += 2) {
    const v128_t im = wasm_v128_load(invMass + i);
    const v128_t mi = wasm_f64x2_div(one, im);
    const v128_t qx = wasm_f64x2_div(wasm_v128_load(posX + i), im);
    const v128_t qy = wasm_f64x2_div(wasm_v128_load(posY + i), im);
    const v128_t qz = wasm_f64x2_div(wasm_v128_load(posZ + i), im);
    if (wasm_f64x2_extract_lane(im, 0) != 0) {
      m += wasm_f64x2_extract_lane(mi, 0);
      cx += wasm_f64x2_extract_lane(qx, 0);
      cy += wasm_f64x2_extract_lane(qy, 0);
      cz += wasm_f64x2_extract_lane(qz, 0);
    }
    if (wasm_f64x2_extract_lane(im, 1) != 0) {
      m += wasm_f64x2_extract_lane(mi, 1);
      cx += wasm_f64x2_extract_lane(qx, 1);
      cy += wasm_f64x2_extract_lane(qy, 1);
      cz += wasm_f64x2_extract_lane(qz, 1);
    }
  }
#endif
  for (; i < end; i++) {
    const f64 im = invMass[i];
    if (im == 0) continue;
    m += 1 / im;
    cx += posX[i] / im;
    cy += posY[i] / im;
    cz += posZ[i] / im;
  }
  if (!(m > 0)) return;
  cx /= m;
  cy /= m;
  cz /= m;
  f64 I = 0;
  i = start;
#ifdef CRUMPLE_SIMD
  const v128_t vcx = wasm_f64x2_splat(cx), vcy = wasm_f64x2_splat(cy), vcz = wasm_f64x2_splat(cz);
  const v128_t vux = wasm_f64x2_splat(ux), vuy = wasm_f64x2_splat(uy), vuz = wasm_f64x2_splat(uz);
  for (; i + 1 < end; i += 2) {
    const v128_t im = wasm_v128_load(invMass + i);
    const v128_t rx = wasm_f64x2_sub(wasm_v128_load(posX + i), vcx);
    const v128_t ry = wasm_f64x2_sub(wasm_v128_load(posY + i), vcy);
    const v128_t rz = wasm_f64x2_sub(wasm_v128_load(posZ + i), vcz);
    const v128_t a = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(rx, vux), wasm_f64x2_mul(ry, vuy)), wasm_f64x2_mul(rz, vuz));
    const v128_t px = wasm_f64x2_sub(rx, wasm_f64x2_mul(a, vux));
    const v128_t py = wasm_f64x2_sub(ry, wasm_f64x2_mul(a, vuy));
    const v128_t pz = wasm_f64x2_sub(rz, wasm_f64x2_mul(a, vuz));
    const v128_t t = wasm_f64x2_div(
        wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(px, px), wasm_f64x2_mul(py, py)), wasm_f64x2_mul(pz, pz)), im);
    if (wasm_f64x2_extract_lane(im, 0) != 0) I += wasm_f64x2_extract_lane(t, 0);
    if (wasm_f64x2_extract_lane(im, 1) != 0) I += wasm_f64x2_extract_lane(t, 1);
  }
#endif
  for (; i < end; i++) {
    const f64 im = invMass[i];
    if (im == 0) continue;
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 a = rx * ux + ry * uy + rz * uz;
    const f64 px = rx - a * ux, py = ry - a * uy, pz = rz - a * uz;
    I += (px * px + py * py + pz * pz) / im;
  }
  if (!(I > 1e-9)) return;
  const f64 g = tl / I;
  i = start;
#ifdef CRUMPLE_SIMD
  const v128_t vg = wasm_f64x2_splat(g);
  for (; i + 1 < end; i += 2) {
    const v128_t im = wasm_v128_load(invMass + i);
    if (wasm_f64x2_extract_lane(im, 0) == 0 || wasm_f64x2_extract_lane(im, 1) == 0) {
      drive_node(i, g, cx, cy, cz, ux, uy, uz);
      drive_node(i + 1, g, cx, cy, cz, ux, uy, uz);
      continue;
    }
    const v128_t rx = wasm_f64x2_sub(wasm_v128_load(posX + i), vcx);
    const v128_t ry = wasm_f64x2_sub(wasm_v128_load(posY + i), vcy);
    const v128_t rz = wasm_f64x2_sub(wasm_v128_load(posZ + i), vcz);
    const v128_t a = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(rx, vux), wasm_f64x2_mul(ry, vuy)), wasm_f64x2_mul(rz, vuz));
    const v128_t px = wasm_f64x2_sub(rx, wasm_f64x2_mul(a, vux));
    const v128_t py = wasm_f64x2_sub(ry, wasm_f64x2_mul(a, vuy));
    const v128_t pz = wasm_f64x2_sub(rz, wasm_f64x2_mul(a, vuz));
    const v128_t k = wasm_f64x2_div(vg, im);
    const v128_t fx = wasm_f64x2_mul(k, wasm_f64x2_sub(wasm_f64x2_mul(vuy, pz), wasm_f64x2_mul(vuz, py)));
    const v128_t fy = wasm_f64x2_mul(k, wasm_f64x2_sub(wasm_f64x2_mul(vuz, px), wasm_f64x2_mul(vux, pz)));
    const v128_t fz = wasm_f64x2_mul(k, wasm_f64x2_sub(wasm_f64x2_mul(vux, py), wasm_f64x2_mul(vuy, px)));
    wasm_v128_store(frcX + i, wasm_f64x2_add(wasm_v128_load(frcX + i), fx));
    wasm_v128_store(frcY + i, wasm_f64x2_add(wasm_v128_load(frcY + i), fy));
    wasm_v128_store(frcZ + i, wasm_f64x2_add(wasm_v128_load(frcZ + i), fz));
  }
#endif
  for (; i < end; i++) drive_node(i, g, cx, cy, cz, ux, uy, uz);
}

/* ------------------------------------------------------------ wheels (vehicle/wheels.ts) */
/*
 * R-PHYS's per-wheel node loops, operation for operation (wheels.ts stays the
 * reference; kernelParity covers them): estimateWheelOmega, applyAxleTorque,
 * applyUprightReaction, applyTreadBrush (+ applyRimTorque), applyHoopTension.
 * One header block per WheelRuntime (W_* slots, written by the glue; the
 * runtime's tread / index arrays live in the block, shared with JS).
 *
 * Ground: wheel_omega samples every tyre node the way groundNormalForce would
 * (plane or the mirrored heightfield, before anything is written: a missing
 * tile returns 0 like ground()) into the block's sample cache; the tread brush
 * reads the same samples later in the same pre-step (positions do not move in
 * between), where wheels.ts samples the JS sampler again — same values.
 */
enum {
  W_HUBI, W_HUBO, W_RIM, W_TIRE, W_N, W_RAYS, W_SPIN, W_TRR, W_RIMR, W_RIMHOOP, W_TREADHOOP, W_BRUSHK, W_BRUSHC,
  W_NLINK, W_LINKS, W_NATT, W_ATT, W_NREACT, W_REACT, W_TLOAD, W_TNRM, W_TBRUSH, W_SAMP,
  /* in / out */
  W_OMEGA, W_ROLLR, W_DETACHED, W_LOAD, W_CONTACT, W_SLIPSPEED, W_SLIPRATIO, W_CACHE,
  W_HEADER
};

static f64 WH_SLIP_MIN, WH_INV_2PI, WH_INV_4PI, WH_ROLL_ALPHA, WH_TREAD_DAMP, WH_ATTACH_MIN, WH_DEADZONE, WH_SHARE_V0, WH_HOOP_MAX;

EXPORT(set_wheel_params)
void set_wheel_params(f64 slipMin, f64 inv2pi, f64 inv4pi, f64 rollAlpha, f64 treadDamp, f64 attachMin, f64 deadzone, f64 shareV0, f64 hoopMax) {
  WH_SLIP_MIN = slipMin;
  WH_INV_2PI = inv2pi;
  WH_INV_4PI = inv4pi;
  WH_ROLL_ALPHA = rollAlpha;
  WH_TREAD_DAMP = treadDamp;
  WH_ATTACH_MIN = attachMin;
  WH_DEADZONE = deadzone;
  WH_SHARE_V0 = shareV0;
  WH_HOOP_MAX = hoopMax;
}

/* axleFrame: hub midpoint + unit spin axis s; 0 when degenerate. */
static inline int axle_frame(const f64 *W, f64 *F) {
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  const f64 sx = posX[ho] - posX[hi], sy = posY[ho] - posY[hi], sz = posZ[ho] - posZ[hi];
  const f64 l = __builtin_sqrt(sx * sx + sy * sy + sz * sz);
  if (!(l > 1e-9)) return 0;
  const f64 k = W[W_SPIN] / l;
  F[0] = (posX[hi] + posX[ho]) * 0.5;
  F[1] = (posY[hi] + posY[ho]) * 0.5;
  F[2] = (posZ[hi] + posZ[ho]) * 0.5;
  F[3] = sx * k;
  F[4] = sy * k;
  F[5] = sz * k;
  return 1;
}

/* Sample cache per tyre node j: [state (0 none, 1 h only, 2 h + normal + material), h, nx, ny, nz, material]. */
#define WS 6

/* Fills the sample cache for the tyre ring; 0 on a missing tile (GH miss slots set; nothing else written). */
static int wheel_sample(f64 *W) {
  f64 *S = (f64 *)(uint32_t)W[W_SAMP];
  const int t0 = (int)W[W_TIRE], n = (int)W[W_N];
  const int kind = (int)GH[G_KIND];
  const f64 slopeSkip = SLOPE_SKIP_G;
  Hf H;
  if (kind == G_HEIGHTFIELD) hf_load(&H);
  const f64 planeY = GH[G_PLANE_Y];
  const int planeMat = (int)GH[G_PLANE_MAT];
  uint32_t *cStamp = (uint32_t *)(uint32_t)GH[G_CSTAMP];
  uint32_t *cRef = (uint32_t *)(uint32_t)GH[G_CREF];
  const uint32_t stamp = (uint32_t)GH[G_STAMP];
  for (int j = 0; j < n; j++) {
    const int i = t0 + j;
    f64 *s = S + WS * j;
    s[0] = 0;
    cStamp[i] = 0;
    if ((nodeFlags[i] & NODE_FLAG_COLLIDABLE) == 0 || invMass[i] == 0) continue;
    cRef[i] = (uint32_t)s;
    const f64 x = posX[i], y = posY[i], z = posZ[i];
    if (kind == G_PLANE) {
      s[1] = planeY;
      if (y - planeY > slopeSkip * radiusArr[i]) {
        s[0] = 1;
        continue;
      }
      s[0] = 2;
      s[2] = 0;
      s[3] = 1;
      s[4] = 0;
      s[5] = planeMat;
      continue;
    }
    int miss = -1, hc, hr, nc, nr, mc, mr;
    f64 htx, htz, ntx, ntz;
    h_cell(&H, x, z, &hc, &hr, &htx, &htz);
    const float *HT = (const float *)tile_at(H.ht, H.htx, hc, hr, &miss);
    if (HT == 0) {
      GH[G_MISS_GRID] = 1;
      GH[G_MISS_TILE] = miss;
      return 0;
    }
    const f64 h = h_sample(HT, hc, hr, htx, htz);
    s[1] = h;
    if (y - h > slopeSkip * radiusArr[i]) {
      s[0] = 1;
      cStamp[i] = stamp;
      continue;
    }
    n_cell(&H, x, z, &nc, &nr, &ntx, &ntz);
    const float *NT = (const float *)tile_at(H.nt, H.ntx, nc, nr, &miss);
    if (NT == 0) {
      GH[G_MISS_GRID] = 2;
      GH[G_MISS_TILE] = miss;
      return 0;
    }
    m_cell(&H, x, z, &mc, &mr);
    const uint8_t *MT = (const uint8_t *)tile_at(H.mt, H.mtx, mc, mr, &miss);
    if (MT == 0) {
      GH[G_MISS_GRID] = 3;
      GH[G_MISS_TILE] = miss;
      return 0;
    }
    n_sample(NT, nc, nr, ntx, ntz, s + 2);
    s[5] = MT[(mr & (TILE - 1)) * TILE + (mc & (TILE - 1))];
    s[0] = 2;
    cStamp[i] = stamp;
  }
  return 1;
}

/* groundNormalForce of tyre node j from the cache (nrm out when in contact). */
static inline f64 wheel_gnf(const f64 *s, int i, f64 dt) {
  if (s[0] != 2) return 0;
  const f64 r = radiusArr[i];
  const f64 nx = s[2], ny = s[3], nz = s[4];
  const f64 depth = (s[1] - posY[i]) * ny + r;
  if (!(depth > 0)) return 0;
  const f64 m = 1 / invMass[i];
  const f64 invDt = 1 / dt;
  const f64 kcm = KC_STAB * invDt * invDt * m;
  const f64 soft = contactKArr[i];
  f64 kc, c;
  if (soft > 0) {
    kc = soft < kcm ? soft : kcm;
    c = 2 * SOFT_ZETA * __builtin_sqrt(kc * m) * (depth < r ? depth / r : 1);
  } else {
    kc = kcm < KC_MAX_G ? kcm : KC_MAX_G;
    c = 2 * CONTACT_ZETA_G * __builtin_sqrt(kc * m);
  }
  const f64 vn = velX[i] * nx + velY[i] * ny + velZ[i] * nz;
  const f64 fn = kc * depth - c * vn;
  return fn > 0 ? fn : 0;
}

/*
 * estimateWheelOmega. ground: 1 when a ground is registered (else the tyre
 * loads are cleared). Returns 0 on a missing tile (nothing written).
 */
EXPORT(wheel_omega) int wheel_omega(f64 *W, int ground, f64 dt) {
  f64 F[6];
  W[W_CACHE] = 0;
  if (!axle_frame(W, F)) {
    W[W_OMEGA] = 0;
    return 1;
  }
  if (ground && !wheel_sample(W)) return 0;
  const f64 cx = F[0], cy = F[1], cz = F[2], sx = F[3], sy = F[4], sz = F[5];
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  const f64 vcx = (velX[hi] + velX[ho]) * 0.5;
  const f64 vcy = (velY[hi] + velY[ho]) * 0.5;
  const f64 vcz = (velZ[hi] + velZ[ho]) * 0.5;
  const int n = (int)W[W_N];
  f64 lSum = 0, iSum = 0;
  const int r0 = (int)W[W_RIM], r1 = r0 + 2 * n;
  for (int i = r0; i < r1; i++) {
    const f64 im = invMass[i];
    if (im == 0) continue;
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 ax = rx * sx + ry * sy + rz * sz;
    const f64 px = rx - ax * sx, py = ry - ax * sy, pz = rz - ax * sz;
    const f64 tx = sy * pz - sz * py, ty = sz * px - sx * pz, tz = sx * py - sy * px;
    const f64 m = 1 / im;
    lSum += m * ((velX[i] - vcx) * tx + (velY[i] - vcy) * ty + (velZ[i] - vcz) * tz);
    iSum += m * (px * px + py * py + pz * pz);
  }
  const f64 omega = iSum > 0 ? lSum / iSum : 0;
  W[W_OMEGA] = omega;
  f64 *tLoad = (f64 *)(uint32_t)W[W_TLOAD];
  f64 *tNrm = (f64 *)(uint32_t)W[W_TNRM];
  const int ts = (int)W[W_TIRE];
  {
    const int half = n >> 1;
    f64 cSum = 0, per = 0;
    int cN = 0;
    for (int row = 0; row < 2; row++) {
      const int b0 = ts + row * half;
      for (int q = 0; q < half; q++) {
        const int q1 = q + 1 == half ? 0 : q + 1;
        const int a = b0 + q, b = b0 + q1;
        const f64 ex = posX[b] - posX[a], ey = posY[b] - posY[a], ez = posZ[b] - posZ[a];
        const f64 len = __builtin_sqrt(ex * ex + ey * ey + ez * ez);
        per += len;
        if (tLoad[row * half + q] > 0 && tLoad[row * half + q1] > 0) {
          cSum += len;
          cN++;
        }
      }
    }
    const f64 target = cN > 0 ? (cSum / cN) * half * WH_INV_2PI : per * WH_INV_4PI;
    W[W_ROLLR] = W[W_ROLLR] + (target - W[W_ROLLR]) * WH_ROLL_ALPHA;
  }
  if (W[W_DETACHED] == 0) {
    const int nl = (int)W[W_NLINK];
    if (nl > 0) {
      const int32_t *links = (const int32_t *)(uint32_t)W[W_LINKS];
      int broken = 0;
      for (int j = 0; j < nl; j++)
        if (activeArr[links[j]] == 0) broken++;
      if (broken == nl) W[W_DETACHED] = 1;
    }
  }
  f64 load = 0, slipSum = 0, gnx = 0, gny = 0, gnz = 0;
  int contacts = 0;
  if (ground) {
    const f64 *S = (const f64 *)(uint32_t)W[W_SAMP];
    for (int j = 0; j < n; j++) {
      const int i = ts + j;
      const f64 *s = S + WS * j;
      const f64 fn = wheel_gnf(s, i, dt);
      if (!(fn > 0)) {
        tLoad[j] = 0;
        continue;
      }
      const f64 nx = s[2], ny = s[3], nz = s[4];
      tLoad[j] = fn;
      tNrm[3 * j] = nx;
      tNrm[3 * j + 1] = ny;
      tNrm[3 * j + 2] = nz;
      const f64 vx = velX[i], vy = velY[i], vz = velZ[i];
      const f64 vn = vx * nx + vy * ny + vz * nz;
      const f64 tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
      slipSum += __builtin_sqrt(tx * tx + ty * ty + tz * tz);
      load += fn;
      gnx += fn * nx;
      gny += fn * ny;
      gnz += fn * nz;
      contacts++;
    }
    W[W_CACHE] = 1;
  } else {
    for (int j = 0; j < n; j++) tLoad[j] = 0;
  }
  W[W_LOAD] = load;
  W[W_CONTACT] = contacts > 0 ? 1 : 0;
  W[W_SLIPSPEED] = contacts > 0 ? slipSum / contacts : 0;
  if (contacts > 0) {
    const f64 gl = __builtin_sqrt(gnx * gnx + gny * gny + gnz * gnz);
    gnx /= gl;
    gny /= gl;
    gnz /= gl;
  } else {
    gnx = 0;
    gny = 1;
    gnz = 0;
  }
  f64 fx = sy * gnz - sz * gny, fy = sz * gnx - sx * gnz, fz = sx * gny - sy * gnx;
  const f64 fl = __builtin_sqrt(fx * fx + fy * fy + fz * fz);
  f64 vFwd = 0;
  if (fl > 1e-9) {
    fx /= fl;
    fy /= fl;
    fz /= fl;
    vFwd = vcx * fx + vcy * fy + vcz * fz;
  }
  const f64 den = vFwd < 0 ? -vFwd : vFwd;
  W[W_SLIPRATIO] = (omega * W[W_ROLLR] - vFwd) / (den > WH_SLIP_MIN ? den : WH_SLIP_MIN);
  return 1;
}

/* applyAxleTorque. */
EXPORT(wheel_axle) void wheel_axle(f64 *W, f64 tau) {
  f64 F[6];
  if (tau == 0 || !axle_frame(W, F)) return;
  const f64 cx = F[0], cy = F[1], cz = F[2], sx = F[3], sy = F[4], sz = F[5];
  const int n = (int)W[W_N];
  const f64 coef = tau / (n * W[W_TRR]);
  f64 sumX = 0, sumY = 0, sumZ = 0;
  const int t0 = (int)W[W_TIRE], t1 = t0 + n;
  for (int i = t0; i < t1; i++) {
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 ax = rx * sx + ry * sy + rz * sz;
    const f64 px = rx - ax * sx, py = ry - ax * sy, pz = rz - ax * sz;
    const f64 pl = __builtin_sqrt(px * px + py * py + pz * pz);
    if (!(pl > 1e-9)) continue;
    const f64 g = coef / pl;
    const f64 fx = g * (sy * pz - sz * py), fy = g * (sz * px - sx * pz), fz = g * (sx * py - sy * px);
    frcX[i] = frcX[i] + fx;
    frcY[i] = frcY[i] + fy;
    frcZ[i] = frcZ[i] + fz;
    sumX += fx;
    sumY += fy;
    sumZ += fz;
  }
  const f64 hx = -0.5 * sumX, hy = -0.5 * sumY, hz = -0.5 * sumZ;
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  frcX[hi] = frcX[hi] + hx;
  frcY[hi] = frcY[hi] + hy;
  frcZ[hi] = frcZ[hi] + hz;
  frcX[ho] = frcX[ho] + hx;
  frcY[ho] = frcY[ho] + hy;
  frcZ[ho] = frcZ[ho] + hz;
}

/* applyUprightReaction (the glue checks reactNodes / detached); si = caliperInboard. */
EXPORT(wheel_upright) void wheel_upright(f64 *W, f64 tau, f64 si) {
  f64 F[6];
  const int nr = (int)W[W_NREACT];
  if (tau == 0 || nr == 0 || W[W_DETACHED] != 0 || !axle_frame(W, F)) return;
  const int32_t *nodes = (const int32_t *)(uint32_t)W[W_REACT];
  const f64 cx = F[0], cy = F[1], cz = F[2], sx = F[3], sy = F[4], sz = F[5];
  f64 r2 = 0;
  for (int q = 0; q < nr; q++) {
    const int i = nodes[q];
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 ax = rx * sx + ry * sy + rz * sz;
    const f64 px = rx - ax * sx, py = ry - ax * sy, pz = rz - ax * sz;
    r2 += px * px + py * py + pz * pz;
  }
  if (!(r2 > 1e-6)) return;
  const f64 k = -tau / r2;
  f64 tx = 0, ty = 0, tz = 0;
  for (int q = 0; q < nr; q++) {
    const int i = nodes[q];
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 ax = rx * sx + ry * sy + rz * sz;
    const f64 px = rx - ax * sx, py = ry - ax * sy, pz = rz - ax * sz;
    const f64 fx = k * (sy * pz - sz * py), fy = k * (sz * px - sx * pz), fz = k * (sx * py - sy * px);
    frcX[i] = frcX[i] + fx;
    frcY[i] = frcY[i] + fy;
    frcZ[i] = frcZ[i] + fz;
    tx += fx;
    ty += fy;
    tz += fz;
  }
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  const f64 so = 1 - si;
  frcX[hi] = frcX[hi] - si * tx;
  frcY[hi] = frcY[hi] - si * ty;
  frcZ[hi] = frcZ[hi] - si * tz;
  frcX[ho] = frcX[ho] - so * tx;
  frcY[ho] = frcY[ho] - so * ty;
  frcZ[ho] = frcZ[ho] - so * tz;
}

/* applyRimTorque with the frame F of the calling pass. */
static void rim_torque(const f64 *W, const f64 *F, f64 tau) {
  if (tau == 0) return;
  const f64 cx = F[0], cy = F[1], cz = F[2], sx = F[3], sy = F[4], sz = F[5];
  const int n = (int)W[W_N];
  const f64 per = tau / n;
  f64 sumX = 0, sumY = 0, sumZ = 0;
  const int r0 = (int)W[W_RIM], r1 = r0 + n;
  for (int i = r0; i < r1; i++) {
    const f64 rx = posX[i] - cx, ry = posY[i] - cy, rz = posZ[i] - cz;
    const f64 ax = rx * sx + ry * sy + rz * sz;
    const f64 px = rx - ax * sx, py = ry - ax * sy, pz = rz - ax * sz;
    const f64 p2 = px * px + py * py + pz * pz;
    if (!(p2 > 1e-12)) continue;
    const f64 g = per / p2;
    const f64 fx = g * (sy * pz - sz * py), fy = g * (sz * px - sx * pz), fz = g * (sx * py - sy * px);
    frcX[i] = frcX[i] + fx;
    frcY[i] = frcY[i] + fy;
    frcZ[i] = frcZ[i] + fz;
    sumX += fx;
    sumY += fy;
    sumZ += fz;
  }
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  frcX[hi] = frcX[hi] - 0.5 * sumX;
  frcY[hi] = frcY[hi] - 0.5 * sumY;
  frcZ[hi] = frcZ[hi] - 0.5 * sumZ;
  frcX[ho] = frcX[ho] - 0.5 * sumX;
  frcY[ho] = frcY[ho] - 0.5 * sumY;
  frcZ[ho] = frcZ[ho] - 0.5 * sumZ;
}

/*
 * applyTreadBrush (brushK > 0 checked by the glue). ground: a ground is
 * registered (the sample cache of this pre-step's wheel_omega is valid).
 */
EXPORT(wheel_brush) void wheel_brush(f64 *W, int ground, f64 dt, f64 slipRatio, f64 latMu) {
  f64 F[6];
  const f64 k = W[W_BRUSHK];
  const int n = (int)W[W_N];
  const int t0 = (int)W[W_TIRE];
  f64 *brush = (f64 *)(uint32_t)W[W_TBRUSH];
  if (!ground || !axle_frame(W, F)) {
    for (int j = 0; j < 3 * n; j++) brush[j] = 0;
    for (int j = 0; j < n; j++) treadF[t0 + j] = 0;
    return;
  }
  const f64 *tLoad = (const f64 *)(uint32_t)W[W_TLOAD];
  const f64 *tNrm = (const f64 *)(uint32_t)W[W_TNRM];
  const f64 *S = (const f64 *)(uint32_t)W[W_SAMP];
  const f64 *matF = (const f64 *)(uint32_t)GH[G_MATF];
  const f64 cx = F[0], cy = F[1], cz = F[2], sx = F[3], sy = F[4], sz = F[5];
  const int hi = (int)W[W_HUBI], ho = (int)W[W_HUBO];
  const f64 vcx = (velX[hi] + velX[ho]) * 0.5;
  const f64 vcy = (velY[hi] + velY[ho]) * 0.5;
  const f64 vcz = (velZ[hi] + velZ[ho]) * 0.5;
  const f64 c = W[W_BRUSHC];
  const f64 invDt = 1 / dt;
  const f64 fwx = -sz, fwz = sx;
  const f64 fl = __builtin_sqrt(fwx * fwx + fwz * fwz);
  f64 uxLong = 0;
  if (fl > 1e-6) {
    f64 vf = (vcx * fwx + vcz * fwz) / fl;
    if (vf < 0) vf = -vf;
    const f64 sr = slipRatio < 0 ? -slipRatio : slipRatio;
    if (sr > WH_DEADZONE) uxLong = (sr - WH_DEADZONE) * (vf > 1 ? vf : 1);
  }
  f64 Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
  for (int j = 0; j < n; j++) {
    const int i = t0 + j;
    const f64 fn = tLoad[j];
    if (!(fn > 0)) {
      brush[3 * j] = 0;
      treadAxX[i] = 0;
      treadAxY[i] = 0;
      treadAxZ[i] = 0;
      treadF[i] = 0;
      continue;
    }
    const int j3 = 3 * j;
    const f64 nx = tNrm[j3], ny = tNrm[j3 + 1], nz = tNrm[j3 + 2];
    const f64 sn = sx * nx + sy * ny + sz * nz;
    f64 ax = sx - sn * nx, ay = sy - sn * ny, az = sz - sn * nz;
    const f64 al = __builtin_sqrt(ax * ax + ay * ay + az * az);
    if (!(al > 1e-6)) {
      brush[j3] = 0;
      treadF[i] = 0;
      continue;
    }
    ax /= al;
    ay /= al;
    az /= al;
    const f64 u = vcx * ax + vcy * ay + vcz * az;
    f64 d = brush[j3] + u * dt;
    f64 f = -k * d - c * u;
    const f64 ua = u < 0 ? -u : u;
    const f64 share = (ua + WH_SHARE_V0) / (__builtin_sqrt(u * u + uxLong * uxLong) + WH_SHARE_V0);
    const f64 *s = S + WS * j;
    const f64 cap = share * latMu * frictionArr[i] * matF[(int)s[5]] * fn;
    if (f > cap || f < -cap) {
      f = f > 0 ? cap : -cap;
      const f64 dMax = cap / k;
      if (d > dMax) d = dMax;
      else if (d < -dMax) d = -dMax;
    }
    brush[j3] = d;
    treadAxX[i] = ax * latMu;
    treadAxY[i] = ay * latMu;
    treadAxZ[i] = az * latMu;
    treadF[i] = f < 0 ? -f : f;
    const f64 px = posX[i], py = posY[i], pz = posZ[i];
    const f64 hgt = (py - s[1]) * ny;
    const f64 rx = px - nx * hgt - cx, ry = py - ny * hgt - cy, rz = pz - nz * hgt - cz;
    const f64 fx = f * ax, fy = f * ay, fz = f * az;
    Fx += fx;
    Fy += fy;
    Fz += fz;
    Mx += ry * fz - rz * fy;
    My += rz * fx - rx * fz;
    Mz += rx * fy - ry * fx;
    const f64 cn = (WH_TREAD_DAMP * invDt) / invMass[i];
    const f64 wl = (velX[i] - vcx) * ax + (velY[i] - vcy) * ay + (velZ[i] - vcz) * az;
    frcX[i] = frcX[i] - cn * wl * ax;
    frcY[i] = frcY[i] - cn * wl * ay;
    frcZ[i] = frcZ[i] - cn * wl * az;
  }
  const f64 ms = Mx * sx + My * sy + Mz * sz;
  f64 mpx = Mx - ms * sx, mpy = My - ms * sy, mpz = Mz - ms * sz;
  f64 hx = 0.5 * Fx, hy = 0.5 * Fy, hz = 0.5 * Fz;
  const int na = (int)W[W_NATT];
  if (na > 0) {
    const int32_t *att = (const int32_t *)(uint32_t)W[W_ATT];
    f64 gnx = 0, gny = 0, gnz = 0;
    for (int j = 0; j < n; j++) {
      const f64 fnj = tLoad[j];
      gnx += fnj * tNrm[3 * j];
      gny += fnj * tNrm[3 * j + 1];
      gnz += fnj * tNrm[3 * j + 2];
    }
    const f64 gl = __builtin_sqrt(gnx * gnx + gny * gny + gnz * gnz);
    f64 ax = 0, ay = 0, az = 0;
    for (int q = 0; q < na; q++) {
      const int a = att[q];
      ax += posX[a];
      ay += posY[a];
      az += posZ[a];
    }
    ax = ax / na - cx;
    ay = ay / na - cy;
    az = az / na - cz;
    if (gl > 0) {
      gnx /= gl;
      gny /= gl;
      gnz /= gl;
      const f64 h = ax * gnx + ay * gny + az * gnz;
      f64 fwx2 = sy * gnz - sz * gny, fwy2 = sz * gnx - sx * gnz, fwz2 = sx * gny - sy * gnx;
      const f64 fwl = __builtin_sqrt(fwx2 * fwx2 + fwy2 * fwy2 + fwz2 * fwz2);
      if (h > WH_ATTACH_MIN && fwl > 1e-6) {
        fwx2 /= fwl;
        fwy2 /= fwl;
        fwz2 /= fwl;
        const f64 mf = mpx * fwx2 + mpy * fwy2 + mpz * fwz2;
        mpx -= mf * fwx2;
        mpy -= mf * fwy2;
        mpz -= mf * fwz2;
        const f64 g = mf / h;
        const f64 vx = (fwy2 * gnz - fwz2 * gny) * g;
        const f64 vy = (fwz2 * gnx - fwx2 * gnz) * g;
        const f64 vz = (fwx2 * gny - fwy2 * gnx) * g;
        const f64 per = 1.0 / na;
        for (int q = 0; q < na; q++) {
          const int a = att[q];
          frcX[a] = frcX[a] + vx * per;
          frcY[a] = frcY[a] + vy * per;
          frcZ[a] = frcZ[a] + vz * per;
        }
        hx -= 0.5 * vx;
        hy -= 0.5 * vy;
        hz -= 0.5 * vz;
      }
    }
  }
  const f64 lx = posX[ho] - posX[hi], ly = posY[ho] - posY[hi], lz = posZ[ho] - posZ[hi];
  const f64 l2 = lx * lx + ly * ly + lz * lz;
  const f64 qx = (mpy * lz - mpz * ly) / l2;
  const f64 qy = (mpz * lx - mpx * lz) / l2;
  const f64 qz = (mpx * ly - mpy * lx) / l2;
  frcX[ho] = frcX[ho] + hx + qx;
  frcY[ho] = frcY[ho] + hy + qy;
  frcZ[ho] = frcZ[ho] + hz + qz;
  frcX[hi] = frcX[hi] + hx - qx;
  frcY[hi] = frcY[hi] + hy - qy;
  frcZ[hi] = frcZ[hi] + hz - qz;
  rim_torque(W, F, ms);
}

/* hoopRing: tension m·g along each segment of the closed ring start..start+n−1. */
static void hoop_ring(int start, int n, f64 g) {
  for (int k = 0; k < n; k++) {
    const int a = start + k;
    const int b = k + 1 == n ? start : a + 1;
    const f64 dx = posX[b] - posX[a], dy = posY[b] - posY[a], dz = posZ[b] - posZ[a];
    const f64 L = __builtin_sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-9)) continue;
    const f64 sc = (0.5 * (1 / invMass[a] + 1 / invMass[b]) * g) / L;
    frcX[a] = frcX[a] + sc * dx;
    frcY[a] = frcY[a] + sc * dy;
    frcZ[a] = frcZ[a] + sc * dz;
    frcX[b] = frcX[b] - sc * dx;
    frcY[b] = frcY[b] - sc * dy;
    frcZ[b] = frcZ[b] - sc * dz;
  }
}

/* applyHoopTension (uses W_OMEGA). */
EXPORT(wheel_hoop) void wheel_hoop(f64 *W) {
  const f64 rim = W[W_RIMHOOP], tread = W[W_TREADHOOP];
  if (!(rim > 0) && !(tread > 0)) return;
  const f64 w0 = W[W_OMEGA];
  f64 om = w0 < 0 ? -w0 : w0;
  if (om > WH_HOOP_MAX) om = WH_HOOP_MAX;
  const f64 w2 = om * om;
  if (!(w2 > 0)) return;
  const int n = (int)W[W_RAYS];
  if (rim > 0) {
    const f64 g = w2 * rim * W[W_RIMR];
    hoop_ring((int)W[W_RIM], n, g);
    hoop_ring((int)W[W_RIM] + n, n, g);
  }
  if (tread > 0) {
    const f64 g = w2 * tread * W[W_TRR];
    hoop_ring((int)W[W_TIRE], n, g);
    hoop_ring((int)W[W_TIRE] + n, n, g);
  }
}
