/**
 * Prop runtime (P5, U1) — WORKER ONLY (imports sim state types).
 *
 * INTERNAL DAMPING: beam dampers act along beams with ζ relative to each
 * beam's own (2 kHz-scale) frequency, i.e. stiffness-proportional damping:
 * a prop's lowest structural modes (a cone's 5 Hz sway, a pole's 1 Hz
 * sway) get ζ_mode ≈ ζ_beam·ω_mode/ω_beam ≈ 1 % and rang for many seconds
 * (keeping the prop awake). Every awake prop therefore also gets a
 * mass-proportional damper on its velocity RELATIVE TO ITS RIGID-BODY
 * MOTION, F_i = −c·m_i·(v_i − V − ω × (p_i − C)) (C, V = centre of mass and
 * its velocity, ω = I⁻¹·L the best-fit angular velocity), which leaves
 * flight and tumbling untouched; while the prop is still ANCHORED (some
 * anchor beam intact) the reference is the ground (F_i = −c·m_i·v_i), and
 * likewise while its rigid motion is slower than PROP_SETTLE_SPEED (a
 * settling prop: friction holds its base, so the rigid fit would read half
 * of a sway as rotation and leave it undamped).
 * c = PROP_INTERNAL_DAMPING: ζ = c/(2ω) is 6 % at 5 Hz, 30 % at 1 Hz, and
 * c·dt = 0.002 (explicitly stable). Forces are accumulated before the
 * ground pass so the implicit friction sees them.
 *
 * NUMERICS: hot loop, + − × ÷ only, no allocation, ascending node order.
 */
import type { Transform } from '../../protocol/messages';
import type { CompiledRig } from '../rig/types';
import type { EventSink, SimObject, SimState } from '../types';
import type { PropDef, PropKey } from './types';

/** Internal (rigid-relative) damping rate, 1/s. */
export const PROP_INTERNAL_DAMPING = 4;
/** Below this rigid-body speed (COM, and ω at the gyration radius), m/s, the damping reference is the ground. */
export const PROP_SETTLE_SPEED = 0.25;

export interface PropRuntime {
  key: PropKey;
  def: PropDef;
  /** Spawn / reset transform (resetProps re-places here). */
  spawn: Transform;
  /** Object-local indices of the anchor beams (beams touching a pinned node); empty = free prop. */
  anchorBeams: Int32Array;
  /** Seconds of continuous stillness (sleep bookkeeping). */
  stillS: number;
  /** Moved (max node speed ≥ sleep.linearSpeed at a rebuild) since it last woke; unmoved props re-sleep after PROP_UNMOVED_HOLD_FRACTION · holdS. */
  moved: boolean;
  /** While asleep: node-centre box of the contact nodes (min xyz, max xyz) and max contact radius. */
  sleepBox: Float64Array;
  sleepRmax: number;
  /** R-PHYS2: liquid contents (PropDef.fluid), null for dry props. */
  fluid: PropFluidState | null;
}

/** R-PHYS2: draining state of a prop's liquid contents (PropDef.fluid). */
export interface PropFluidState {
  /** Contents left, kg. */
  remaining: number;
  /** Current mass scale of the prop (1 = full) applied to node masses and beam forces. */
  scale: number;
  /** Shell mass (everything but the contents) and the full total, kg. */
  shell: number;
  total0: number;
}

/** Leak update interval, ticks (the mass changes slowly; every tick would rescale ~100 beams for nothing). */
export const FLUID_TICKS = 20;
/** Orifice discharge coefficient of a torn seam. */
const LEAK_CD = 0.6;

export function createFluidState(def: PropDef, rig: CompiledRig): PropFluidState | null {
  if (!def.fluid) return null;
  let total = 0;
  for (let i = 0; i < rig.nodeCount; i++) if (rig.nodeInvMass[i]! > 0) total += 1 / rig.nodeInvMass[i]!;
  return { remaining: def.fluid.mass, scale: 1, shell: total - def.fluid.mass, total0: total };
}

export function resetFluidState(f: PropFluidState, def: PropDef): void {
  f.remaining = def.fluid ? def.fluid.mass : 0;
  f.scale = 1;
}

/**
 * Drains a torn container (every FLUID_TICKS ticks while awake): Torricelli
 * outflow through the broken beams' share of open area, then node masses
 * and beam stiffness / damping / yield / break forces rescaled by the mass
 * ratio (keeps every node's ω·dt; a drained drum is the thin empty shell
 * again). Deterministic; + − × ÷ sqrt.
 */
export function stepPropFluid(state: SimState, obj: SimObject, rt: PropRuntime, g: number, dt: number): void {
  const f = rt.fluid;
  const spec = rt.def.fluid;
  if (f === null || spec === undefined || f.remaining <= 0) return;
  const { active, restLen, restLen0 } = state;
  let broken = 0;
  const be = obj.beamStart + obj.beamCount;
  const crack = spec.crackStrain ?? Infinity;
  for (let b = obj.beamStart; b < be; b++) {
    if (active[b] === 0) broken++;
    else if (crack < Infinity) {
      const e = restLen[b]! / restLen0[b]! - 1;
      if (e > crack || e < -crack) broken++;
    }
  }
  if (broken === 0) return;
  let area = broken * spec.areaPerBreak;
  if (area > spec.maxArea) area = spec.maxArea;
  const h = (spec.height * f.remaining) / spec.mass;
  const q = LEAK_CD * area * Math.sqrt(2 * g * (h > 0 ? h : 0));
  let rem = f.remaining - 1000 * q * FLUID_TICKS * dt;
  if (rem < 0) rem = 0;
  f.remaining = rem;
  const scale = (f.shell + rem) / f.total0;
  const r = scale / f.scale;
  if (r > 0.999999) return;
  f.scale = scale;
  const { invMass, k, d, deform, breakF } = state;
  const ne = obj.nodeStart + obj.nodeCount;
  const ir = 1 / r;
  for (let i = obj.nodeStart; i < ne; i++) if (invMass[i]! > 0) invMass[i] = invMass[i]! * ir;
  for (let b = obj.beamStart; b < be; b++) {
    k[b] = k[b]! * r;
    d[b] = d[b]! * r;
    deform[b] = deform[b]! * r;
    breakF[b] = breakF[b]! * r;
  }
}

/**
 * Awake budget (P5 integration): a prop woken by a passing mover that never
 * actually moved goes back to sleep after this fraction of its holdS (the
 * barrel wall's untouched drums cost a full 0.75 s of 2 kHz stepping each).
 */
export const PROP_UNMOVED_HOLD_FRACTION = 0.3;
/**
 * Awake budget (P5 integration): while the awake props carry more than
 * PROP_AWAKE_BEAM_BUDGET beams, props slower than this (max node speed, m/s)
 * that no moving object could reach before the next rebuild go to sleep at
 * once, slowest first (a soft cap: woken props are never refused, and fast
 * ones always stay awake).
 */
export const PROP_BUDGET_SLEEP_SPEED = 0.3;

/** Waking speed: only an awake object whose max node speed exceeds this wakes sleeping neighbours (still neighbours would ping-pong). */
export const PROP_WAKE_SPEED = 0.1;

/**
 * True while the prop's anchor is intact. BREAKAWAY: the base fails as a
 * unit — once any anchor beam has broken, every remaining one is released
 * here (beamBreak events, discovery order), so the post falls free instead
 * of hanging on its upper struts while the snapped base swings up.
 */
export function propAnchored(state: SimState, rt: PropRuntime, beamStart: number, events: EventSink): boolean {
  const ab = rt.anchorBeams;
  const active = state.active;
  let intact = 0;
  for (let i = 0; i < ab.length; i++) if (active[beamStart + ab[i]!] !== 0) intact++;
  if (intact === ab.length) return true;
  if (intact > 0) {
    const { posX, posY, posZ, aIdx, bIdx, strainOut } = state;
    for (let i = 0; i < ab.length; i++) {
      const b = beamStart + ab[i]!;
      if (active[b] === 0) continue;
      active[b] = 0;
      strainOut[b] = NaN;
      const p = aIdx[b]!;
      const q = bIdx[b]!;
      events.beamBreak(b, (posX[p]! + posX[q]!) * 0.5, (posY[p]! + posY[q]!) * 0.5, (posZ[p]! + posZ[q]!) * 0.5);
    }
  }
  return false;
}

/** Applies the internal damping force to nodes [first, first+count) (see header). */
export function applyPropDamping(state: SimState, first: number, count: number, c: number, anchored: boolean): void {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass } = state;
  const end = first + count;
  if (anchored) {
    for (let i = first; i < end; i++) {
      const im = invMass[i]!;
      if (im === 0) continue;
      const k = c / im;
      frcX[i] = frcX[i]! - k * velX[i]!;
      frcY[i] = frcY[i]! - k * velY[i]!;
      frcZ[i] = frcZ[i]! - k * velZ[i]!;
    }
    return;
  }
  // Pass 1: mass, COM, momentum, angular momentum about the origin, raw inertia sums.
  let M = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let lx = 0;
  let ly = 0;
  let lz = 0;
  let sxx = 0;
  let syy = 0;
  let szz = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = first; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const m = 1 / im;
    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    const vx = velX[i]!;
    const vy = velY[i]!;
    const vz = velZ[i]!;
    M += m;
    mx += m * x;
    my += m * y;
    mz += m * z;
    px += m * vx;
    py += m * vy;
    pz += m * vz;
    lx += m * (y * vz - z * vy);
    ly += m * (z * vx - x * vz);
    lz += m * (x * vy - y * vx);
    sxx += m * x * x;
    syy += m * y * y;
    szz += m * z * z;
    sxy += m * x * y;
    sxz += m * x * z;
    syz += m * y * z;
  }
  if (!(M > 0)) return;
  const iM = 1 / M;
  const cx = mx * iM;
  const cy = my * iM;
  const cz = mz * iM;
  const vcx = px * iM;
  const vcy = py * iM;
  const vcz = pz * iM;
  // About the COM: L_c = L − M·C×V; second moments S_c = S − M·C Cᵀ.
  const Lx = lx - M * (cy * vcz - cz * vcy);
  const Ly = ly - M * (cz * vcx - cx * vcz);
  const Lz = lz - M * (cx * vcy - cy * vcx);
  const cxx = sxx - M * cx * cx;
  const cyy = syy - M * cy * cy;
  const czz = szz - M * cz * cz;
  const cxy = sxy - M * cx * cy;
  const cxz = sxz - M * cx * cz;
  const cyz = syz - M * cy * cz;
  // Inertia tensor I = tr(S)·1 − S (symmetric), ω = I⁻¹ L by cofactors.
  const a = cyy + czz;
  const b = cxx + czz;
  const d = cxx + cyy;
  const e = -cxy;
  const f = -cxz;
  const g = -cyz;
  // | a e f |
  // | e b g |
  // | f g d |
  const A00 = b * d - g * g;
  const A01 = f * g - e * d;
  const A02 = e * g - b * f;
  const A11 = a * d - f * f;
  const A12 = e * f - a * g;
  const A22 = a * b - e * e;
  const det = a * A00 + e * A01 + f * A02;
  let wx = 0;
  let wy = 0;
  let wz = 0;
  const scale = a + b + d;
  if (det > 1e-12 * scale * scale * scale) {
    const id = 1 / det;
    wx = (A00 * Lx + A01 * Ly + A02 * Lz) * id;
    wy = (A01 * Lx + A11 * Ly + A12 * Lz) * id;
    wz = (A02 * Lx + A12 * Ly + A22 * Lz) * id;
  }
  // Settling: a prop whose rigid motion is slow (COM and gyration-radius
  // speeds below PROP_SETTLE_SPEED) is resting or about to; its reference
  // is the ground (absolute damping), which kills the sway of a prop whose
  // base is held by friction (the rigid fit would call half of it rotation).
  const rot2 = (wx * wx + wy * wy + wz * wz) * scale * 0.5 * iM;
  const s2 = PROP_SETTLE_SPEED * PROP_SETTLE_SPEED;
  let rvx = vcx;
  let rvy = vcy;
  let rvz = vcz;
  if (vcx * vcx + vcy * vcy + vcz * vcz < s2 && rot2 < s2) {
    rvx = 0;
    rvy = 0;
    rvz = 0;
    wx = 0;
    wy = 0;
    wz = 0;
  }
  // Pass 2: F_i = −c·m_i·(v_i − V − ω×r_i).
  for (let i = first; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const k = c / im;
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ux = velX[i]! - rvx - (wy * rz - wz * ry);
    const uy = velY[i]! - rvy - (wz * rx - wx * rz);
    const uz = velZ[i]! - rvz - (wx * ry - wy * rx);
    frcX[i] = frcX[i]! - k * ux;
    frcY[i] = frcY[i]! - k * uy;
    frcZ[i] = frcZ[i]! - k * uz;
  }
}
