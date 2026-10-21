/**
 * Wheel runtime kernels (worker-only): ω estimate + per-wheel bookkeeping,
 * the torque law and the parking clamp. Contracts in ./types.ts
 * (EstimateWheelOmega, ApplyWheelTorques, ApplyParkingClamp).
 *
 * HOT PATH: only + - * / sqrt, no allocation, fixed iteration order (ring
 * nodes ascending, wheels in declaration order).
 *
 * GROUND: the frozen kernel signatures carry no HeightSampler, so the
 * engine registers the active ground with setWheelGround() at init and on
 * every `ground` command (null = no ground: no load/contact, no clamp).
 */
import { Action } from '../../protocol/messages';
import { groundNormalForce, tanhR } from '../collision/ground';
import { DEFAULT_MATERIALS } from '../collision/materials';
import type { HeightSampler, MaterialTable, SimState } from '../types';
import type { DrivetrainStateEx } from './drivetrain';
import {
  BRAKE_OMEGA_EPS,
  ROLL_RES_OMEGA_EPS,
  PARK_GAIN,
  PARK_SPEED,
  type ApplyParkingClamp,
  type ApplyWheelTorques,
  type EstimateWheelOmega,
  type VehicleRuntime,
  type WheelRuntime,
} from './types';

let groundSampler: HeightSampler | null = null;
let groundMaterials: MaterialTable = DEFAULT_MATERIALS;
/** Step for groundNormalForce's stiffness clamp in estimateWheelOmega (its frozen signature has no dt). */
let groundDt = 1 / 2000;

/**
 * Registers the ground the wheel kernels query. Call at init and on every
 * `ground` command (null clears it). `dt` = the fixed sim step.
 */
export function setWheelGround(
  sampler: HeightSampler | null,
  materials: MaterialTable = DEFAULT_MATERIALS,
  dt = 1 / 2000,
): void {
  groundSampler = sampler;
  groundMaterials = materials;
  groundDt = dt;
}

/** Slip ratio denominator floor, m/s (see WheelRuntime.slipRatio). */
const SLIP_RATIO_MIN_SPEED = 0.5;
/** Pedal threshold that arms the parking clamp. */
const PARK_PEDAL = 0.1;
const SLIP_REG_INV = 1 / 0.3;
/**
 * WHY the clamp has two anchors on top of the contract's viscous term
 * (cart rigs in wheels.test.ts, 10 % grade, full brake: no clamp creeps
 * 0.31 m per 2 s, the viscous term alone ~0.15 m, both anchors 0.2 mm):
 *
 * 1. Sliding. The ground kernel caps friction at KT_FRACTION·m/dt·|v_t| per
 *    node and PARK_GAIN adds 0.25·m/dt, so a static tangential force F on a
 *    node of mass m needs a steady slip F·dt/(0.75·m) (~0.2 m/s for a
 *    0.67 kg tyre node carrying 200 N). Each in-contact node of a clamped
 *    wheel therefore also gets a tangential spring k = PARK_ANCHOR_K·m/dt²
 *    toward the point where it touched down, inside the same
 *    μN(1 − tanhR(|v_t|/0.3)) cap (ground friction + clamp ≤ μN). Past the
 *    cap the anchor is dragged along (sliding, no stored wind-up). ω·dt of
 *    that spring alone = sqrt(0.05) ≈ 0.22, inside the contact headroom of
 *    ground.ts.
 * 2. Rolling. A rolling wheel's contact nodes do not slide, so no contact
 *    force can stop it; only the brake can, and the contract's brake ramp
 *    (−T·ω/1 rad/s below 1 rad/s) is viscous: a 10 % grade rolls a sedan at
 *    ~2 cm/s. Clamped wheels get a brake-pad stiction spring on the wheel
 *    angle accumulated since engagement, τ = −PARK_HOLD_K·(I/dt²)·θ, with
 *    service + hold torque capped at the wheel's available brake torque
 *    (θ is re-based at the cap: slips, no wind-up). ω·dt on the bare wheel
 *    inertia = sqrt(0.02) ≈ 0.14 (on the ground the car's mass adds inertia).
 * Both are capped forces/torques, never position constraints.
 */
const PARK_ANCHOR_K = 0.05;
const INV_4PI = 1 / (4 * Math.PI);
const INV_2PI = 1 / (2 * Math.PI);
/** Rolling-radius low-pass per tick: dt/(τ + dt), τ = 50 ms at dt = 1/2000. */
const ROLL_RADIUS_ALPHA = (1 / 2000) / (0.05 + 1 / 2000);
const PARK_HOLD_K = 0.02;
/** Squared anchor distance (m²) treated as stale (re-armed in place), 5 cm. */
const PARK_ANCHOR_STALE2 = 0.05 * 0.05;


// ---- module scratch (reused; nothing is allocated per call)
const nrm = new Float64Array(3);
/** Axle frame of the last axleFrame() call: centre xyz, unit spin axis s xyz. */
const frame = new Float64Array(6);

/** Per-wheel parking state, allocated once per WheelRuntime on first clamp use (never per tick). */
interface ParkState {
  /** Contact anchor xyz per tyre ring node. */
  anchor: Float64Array;
  armed: Uint8Array;
  /** Wheel angle since the hold engaged, rad. */
  theta: number;
  holding: boolean;
}
const parkStates = new WeakMap<WheelRuntime, ParkState>();

function parkStateFor(w: WheelRuntime): ParkState {
  let p = parkStates.get(w);
  if (p === undefined) {
    p = { anchor: new Float64Array(w.ringCount * 3), armed: new Uint8Array(w.ringCount), theta: 0, holding: false };
    parkStates.set(w, p);
  }
  return p;
}

function release(w: WheelRuntime): void {
  const p = parkStates.get(w);
  if (p !== undefined && p.holding) {
    p.armed.fill(0);
    p.theta = 0;
    p.holding = false;
  }
}

/** Writes hub midpoint + unit spin axis s = spinSign·normalize(hubO − hubI) into `frame`. False if degenerate. */
function axleFrame(state: SimState, w: WheelRuntime): boolean {
  const { posX, posY, posZ } = state;
  const hi = w.hubI;
  const ho = w.hubO;
  const sx = posX[ho]! - posX[hi]!;
  const sy = posY[ho]! - posY[hi]!;
  const sz = posZ[ho]! - posZ[hi]!;
  const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (!(l > 1e-9)) return false;
  const k = w.wheel.spinSign / l;
  frame[0] = (posX[hi]! + posX[ho]!) * 0.5;
  frame[1] = (posY[hi]! + posY[ho]!) * 0.5;
  frame[2] = (posZ[hi]! + posZ[ho]!) * 0.5;
  frame[3] = sx * k;
  frame[4] = sy * k;
  frame[5] = sz * k;
  return true;
}

/**
 * Torque τ about s (+ = forward): τ/(N·r)·t̂_i on the N tyre ring nodes,
 * t̂_i = s × ρ̂_i, and −ΣF/2 on each hub, so the net force is exactly zero.
 */
function applyAxleTorque(state: SimState, w: WheelRuntime, tau: number): void {
  if (tau === 0 || !axleFrame(state, w)) return;
  const { posX, posY, posZ, frcX, frcY, frcZ } = state;
  const cx = frame[0]!;
  const cy = frame[1]!;
  const cz = frame[2]!;
  const sx = frame[3]!;
  const sy = frame[4]!;
  const sz = frame[5]!;
  const n = w.ringCount;
  const coef = tau / (n * w.wheel.tireRingRadius);
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  const t0 = w.tireStart;
  const t1 = t0 + n;
  for (let i = t0; i < t1; i++) {
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (!(pl > 1e-9)) continue;
    const g = coef / pl;
    const fx = g * (sy * pz - sz * py);
    const fy = g * (sz * px - sx * pz);
    const fz = g * (sx * py - sy * px);
    frcX[i] = frcX[i]! + fx;
    frcY[i] = frcY[i]! + fy;
    frcZ[i] = frcZ[i]! + fz;
    sumX += fx;
    sumY += fy;
    sumZ += fz;
  }
  const hx = -0.5 * sumX;
  const hy = -0.5 * sumY;
  const hz = -0.5 * sumZ;
  const hi = w.hubI;
  const ho = w.hubO;
  frcX[hi] = frcX[hi]! + hx;
  frcY[hi] = frcY[hi]! + hy;
  frcZ[hi] = frcZ[hi]! + hz;
  frcX[ho] = frcX[ho]! + hx;
  frcY[ho] = frcY[ho]! + hy;
  frcZ[ho] = frcZ[ho]! + hz;
}

/**
 * ω about s, plus bookkeeping: detached (sticky), load, contact, slipSpeed,
 * slipRatio.
 *
 * ω is the INERTIA-WEIGHTED mean over the rim AND tyre rings,
 * Σ m_i (v_i − v_c)·(s × ρ_i) / Σ m_i |ρ_i|² = L_axle / I_axle (the frozen
 * doc's per-node mean over the rim only, with masses as weights and the tyre
 * ring included). WHY: torques act on the tyre ring; a rim-only estimate is
 * non-collocated, and the brake ramp's ~T/(1 rad/s) gain fed by it pumped
 * the ~50 Hz rim–tyre torsional mode unstable at full brake (cart test).
 * L/I is blind to that internal mode (it conserves L), so brake, clutch and
 * diff feedback only ever see rigid wheel rotation.
 *
 * Load/contact/slip use groundNormalForce on the tyre nodes (this tick's
 * contact force; zero without a registered ground).
 */
export const estimateWheelOmega: EstimateWheelOmega = (state, w) => {
  if (!axleFrame(state, w)) {
    w.omega = 0;
    return;
  }
  const { posX, posY, posZ, velX, velY, velZ, invMass } = state;
  const cx = frame[0]!;
  const cy = frame[1]!;
  const cz = frame[2]!;
  const sx = frame[3]!;
  const sy = frame[4]!;
  const sz = frame[5]!;
  const hi = w.hubI;
  const ho = w.hubO;
  const vcx = (velX[hi]! + velX[ho]!) * 0.5;
  const vcy = (velY[hi]! + velY[ho]!) * 0.5;
  const vcz = (velZ[hi]! + velZ[ho]!) * 0.5;

  // ---- ω (rim and tyre rings are contiguous: rimStart .. rimStart + 2·ringCount)
  const n = w.ringCount;
  let lSum = 0;
  let iSum = 0;
  const r0 = w.rimStart;
  const r1 = r0 + 2 * n;
  for (let i = r0; i < r1; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    const tx = sy * pz - sz * py;
    const ty = sz * px - sx * pz;
    const tz = sx * py - sy * px;
    const m = 1 / im;
    lSum += m * ((velX[i]! - vcx) * tx + (velY[i]! - vcy) * ty + (velZ[i]! - vcz) * tz);
    iSum += m * (px * px + py * py + pz * pz);
  }
  const omega = iSum > 0 ? lSum / iSum : 0;
  w.omega = omega;

  // ---- rolling radius from the tread chords: contact tread nodes stick,
  // so per ray the hub advances one chord between consecutive CONTACT nodes
  // (r = chord·rays/2π). The free ring (stretched by centrifugal load) is
  // not what rolls. Uses last tick's contact loads; without a contact pair
  // the whole-ring perimeter stands in. Low-passed (ROLL_RADIUS_ALPHA):
  // the patch alternates between 1 and 2 rays in contact.
  {
    const half = n >> 1;
    const ts = w.tireStart;
    const tl = w.treadLoad;
    let cSum = 0;
    let cN = 0;
    let per = 0;
    for (let row = 0; row < 2; row++) {
      const b0 = ts + row * half;
      for (let q = 0; q < half; q++) {
        const q1 = q + 1 === half ? 0 : q + 1;
        const a = b0 + q;
        const b = b0 + q1;
        const ex = posX[b]! - posX[a]!;
        const ey = posY[b]! - posY[a]!;
        const ez = posZ[b]! - posZ[a]!;
        const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
        per += len;
        if (tl[row * half + q]! > 0 && tl[row * half + q1]! > 0) {
          cSum += len;
          cN++;
        }
      }
    }
    const target = cN > 0 ? (cSum / cN) * half * INV_2PI : per * INV_4PI;
    w.rollRadius += (target - w.rollRadius) * ROLL_RADIUS_ALPHA;
  }

  // ---- detached: every hub link broken (sticky until reset)
  if (w.detached === 0) {
    const links = w.hubLinkBeams;
    const nl = links.length;
    if (nl > 0) {
      let broken = 0;
      for (let j = 0; j < nl; j++) if (state.active[links[j]!] === 0) broken++;
      if (broken === nl) w.detached = 1;
    }
  }

  // ---- ground load / contact / slip
  const sampler = groundSampler;
  let load = 0;
  let slipSum = 0;
  let contacts = 0;
  let gnx = 0;
  let gny = 0;
  let gnz = 0;
  let rollSum = 0;
  const tLoad = w.treadLoad;
  const tNrm = w.treadNormal;
  if (sampler !== null) {
    const t0 = w.tireStart;
    const t1 = t0 + n;
    for (let i = t0; i < t1; i++) {
      const j = i - t0;
      const fn = groundNormalForce(state, i, sampler, groundDt, nrm);
      if (!(fn > 0)) {
        tLoad[j] = 0;
        continue;
      }
      const nx = nrm[0]!;
      const ny = nrm[1]!;
      const nz = nrm[2]!;
      tLoad[j] = fn;
      tNrm[3 * j] = nx;
      tNrm[3 * j + 1] = ny;
      tNrm[3 * j + 2] = nz;
      // Axle height above the ground under this node, along the normal.
      const px = posX[i]!;
      const py = posY[i]!;
      const pz = posZ[i]!;
      rollSum += fn * ((cx - px) * nx + (cy - py) * ny + (cz - pz) * nz + (py - sampler.heightAt(px, pz)) * ny);
      const vx = velX[i]!;
      const vy = velY[i]!;
      const vz = velZ[i]!;
      const vn = vx * nx + vy * ny + vz * nz;
      const tx = vx - vn * nx;
      const ty = vy - vn * ny;
      const tz = vz - vn * nz;
      slipSum += Math.sqrt(tx * tx + ty * ty + tz * tz);
      load += fn;
      gnx += fn * nx;
      gny += fn * ny;
      gnz += fn * nz;
      contacts++;
    }
  }
  if (sampler === null) tLoad.fill(0);
  w.load = load;
  w.contact = contacts > 0 ? 1 : 0;
  w.slipSpeed = contacts > 0 ? slipSum / contacts : 0;

  // forward = s × n (n: load-weighted contact normal, +Y when airborne).
  if (contacts > 0) {
    const gl = Math.sqrt(gnx * gnx + gny * gny + gnz * gnz);
    gnx /= gl;
    gny /= gl;
    gnz /= gl;
  } else {
    gnx = 0;
    gny = 1;
    gnz = 0;
  }
  let fx = sy * gnz - sz * gny;
  let fy = sz * gnx - sx * gnz;
  let fz = sx * gny - sy * gnx;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  let vFwd = 0;
  if (fl > 1e-9) {
    fx /= fl;
    fy /= fl;
    fz /= fl;
    vFwd = vcx * fx + vcy * fy + vcz * fz;
  }
  const den = vFwd < 0 ? -vFwd : vFwd;
  w.slipRatio = (omega * w.rollRadius - vFwd) / (den > SLIP_RATIO_MIN_SPEED ? den : SLIP_RATIO_MIN_SPEED);
};

/**
 * REACTION COUPLE (R-PHYS; amends the P2 "no body reaction couple"): a torque
 * τ put into the wheel by something mounted on the upright (caliper, a live
 * axle's differential) reacts on that
 * upright as −τ about the spin axis s. Without it every brake applied an
 * external torque to the car and the braking load transfer was
 * m·a·(h − r)/L instead of m·a·h/L (sedan, measured on the axle loads:
 * 1305 N/g vs 2473 N/g; the car dived and loaded its fronts half as much as
 * a real one).
 * Distribution: on the upright nodes j (WheelRuntime.reactNodes, the upright
 * top / knuckle), F_j = −τ·(s × ρ_j)/Σ|ρ|² (ρ_j ⊥ s from the axle), whose
 * moment about the axle is exactly −τ·s; the hubs take −ΣF_j, split
 * `caliperInboard` : 1 − caliperInboard between hubI and hubO (zero net
 * force). For a rigid upright the split is immaterial; on the budget-stiff
 * beam upright it sets where the caliper bracket bolts on and so the
 * brake compliance steer (sedan front, 0.9 g stop: 0.5 → 0.9° toe-in per
 * wheel, 0.75 → 0.2°; real cars 0.1–0.3°, designed toward toe-in).
 * Only + − × ÷ sqrt, no allocation.
 */
export function applyUprightReaction(state: SimState, w: WheelRuntime, tau: number): void {
  const nodes = w.reactNodes;
  if (tau === 0 || nodes === undefined || nodes.length === 0 || w.detached !== 0 || !axleFrame(state, w)) return;
  const { posX, posY, posZ, frcX, frcY, frcZ } = state;
  const cx = frame[0]!;
  const cy = frame[1]!;
  const cz = frame[2]!;
  const sx = frame[3]!;
  const sy = frame[4]!;
  const sz = frame[5]!;
  const nr = nodes.length;
  let r2 = 0;
  for (let q = 0; q < nr; q++) {
    const i = nodes[q]!;
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    r2 += px * px + py * py + pz * pz;
  }
  if (!(r2 > 1e-6)) return;
  const k = -tau / r2;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (let q = 0; q < nr; q++) {
    const i = nodes[q]!;
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    const fx = k * (sy * pz - sz * py);
    const fy = k * (sz * px - sx * pz);
    const fz = k * (sx * py - sy * px);
    frcX[i] = frcX[i]! + fx;
    frcY[i] = frcY[i]! + fy;
    frcZ[i] = frcZ[i]! + fz;
    tx += fx;
    ty += fy;
    tz += fz;
  }
  const hi = w.hubI;
  const ho = w.hubO;
  const si = w.caliperInboard ?? 0.5;
  const so = 1 - si;
  frcX[hi] = frcX[hi]! - si * tx;
  frcY[hi] = frcY[hi]! - si * ty;
  frcZ[hi] = frcZ[hi]! - si * tz;
  frcX[ho] = frcX[ho]! - so * tx;
  frcY[ho] = frcY[ho]! - so * ty;
  frcZ[ho] = frcZ[ho]! - so * tz;
}

/** Hub speeds (m/s) between which the brake reaction couple fades in (see applyWheelTorques). */
const REACT_ZERO_SPEED = 0.3;
const REACT_FULL_SPEED = 1;

/**
 * Whether the drive torque reacts on the upright (live axle) — set per
 * vehicle by vehiclePreStep through `setDriveOnUpright` (module state: the
 * frozen ApplyWheelTorques signature has no vehicle).
 */
let driveOnUpright = false;
export function setDriveOnUpright(on: boolean): void {
  driveOnUpright = on;
}

/**
 * TORQUE LAW: τ = drive (0 when detached) + brake ramped as
 * −brakeTorque·clamp(ω/BRAKE_OMEGA_EPS, −1, 1), applied by applyAxleTorque.
 * R-PHYS: brake + rolling resistance (+ drive on a live axle) react on the
 * upright (applyUprightReaction); a body-mounted differential's drive
 * reaction is applied by the runtime (runtime.ts applyDriveReaction).
 */
export const applyWheelTorques: ApplyWheelTorques = (state, w, driveTorque, brakeTorque) => {
  const drive = w.detached !== 0 ? 0 : driveTorque;
  let ramp = w.omega / BRAKE_OMEGA_EPS;
  if (ramp > 1) ramp = 1;
  else if (ramp < -1) ramp = -1;
  const brake = brakeTorque > 0 ? -brakeTorque * ramp : 0;
  w.driveTorque = drive;
  w.brakeTorque = brake;
  // Rolling resistance (tyre hysteresis): Coulomb-like, ramped through 0.
  const crr = w.wheel.rollingResistance;
  let roll = 0;
  if (crr > 0 && w.load > 0) {
    let rr = w.omega / ROLL_RES_OMEGA_EPS;
    if (rr > 1) rr = 1;
    else if (rr < -1) rr = -1;
    roll = -crr * w.load * w.rollRadius * rr;
  }
  const extra = w.extraTorque;
  if (extra !== undefined) roll += extra;
  applyAxleTorque(state, w, drive + brake + roll);
  // Rolling resistance (and the tyre model's loss correction in `roll`) is a ground-contact moment: the
  // ground, not the upright, takes its reaction. The brake's reaction fades out below walking pace: at rest the
  // parking clamp is a numerical holding device (stiction spring on the wheel angle) and with the couple it wound
  // the box truck's live axle up through the spawn settle (−8 mm of CG on its handbrake).
  const hx = (state.velX[w.hubI]! + state.velX[w.hubO]!) * 0.5;
  const hz = (state.velZ[w.hubI]! + state.velZ[w.hubO]!) * 0.5;
  const v2 = hx * hx + hz * hz;
  let fr = 1;
  if (v2 < REACT_FULL_SPEED * REACT_FULL_SPEED) {
    const v = Math.sqrt(v2);
    fr = v > REACT_ZERO_SPEED ? (v - REACT_ZERO_SPEED) / (REACT_FULL_SPEED - REACT_ZERO_SPEED) : 0;
  }
  applyUprightReaction(state, w, driveOnUpright ? drive + brake * fr : brake * fr);
};

/**
 * TREAD BRUSH — LATERAL (wheels with brushK > 0; their tyre nodes carry
 * NODE_FLAG_TREAD). Per in-contact tread node j (load N_j and normal n from
 * estimateWheelOmega this tick), â = the axle direction s projected onto the
 * ground tangent plane, q_j = the ground point under the node:
 *   u   = v_c·â   (rigid-wheel lateral slip speed; spin adds nothing along s)
 *   δ_j += u·dt   (reset to 0 when the node leaves the ground)
 *   F_j = −k·δ_j − c·u,  |F_j| ≤ share·μ·N_j (δ_j clipped at the cap:
 *         sliding), share = (|u| + V0)/(|(u, u_x)| + V0), u_x = sliding
 *         speed of a locked/spinning wheel (slip ratio beyond 0.12 × v):
 *         combined slip, V0 = 0.5 m/s
 * The lateral contact forces F_j·â at the q_j are applied as a wrench on the
 * RIGID wheel they were measured on (see the wrench split at the end). The node-level ground stick keeps the
 * longitudinal direction (drops the â component, cone √((μN)² − F_j²)):
 * state.treadAxX/Y/Z and treadF hand it â and |F_j|. Each tread node also gets a
 * lateral damper −c_n·((v_j − v_c)·â)·â, c_n = TREAD_NODE_DAMP·m_j/dt.
 *
 * WHY lateral brush: with node stick alone the only lateral compliance
 * between road and rim is the carcass, ~2e4 N/m per tread node (bench: hubs
 * held, 5 mm push; every sidewall topology tried lands at 2–2.5e4 because
 * the rim's own lateral support is in series), and the explicit budget
 * (ω·dt ≤ 0.5 on a 0.33 kg node → Σk ≤ 3.2e5) cannot reach the ~2e5 a real
 * belt + tread gives: cornering stiffness was ~130 N/deg (real ≈ 1000–1500)
 * and the car spun out at 0.5 g. The brush force depends on the wheel's
 * kinematics, not on any node position, so it adds no node stiffness.
 * WHY on the rigid wheel: applied to the tread nodes the loop is
 * non-collocated across the soft carcass and fluttered (m/s node speeds on
 * a parked car). WHY lateral only: a longitudinal brush is ~1.2e5 N per unit
 * slip stiff and fought the stuck tread polygon over sub-percent rolling-
 * radius mismatch (0.8–2.4 kN of drag on a free-rolling wheel); the
 * carcass already gives a realistic longitudinal stiffness (κ ≈ 0.03 at
 * 500 N·m on the bench).
 */
const TREAD_NODE_DAMP = 0.1;
/** Minimum attach-node height above the wheel centre (m) for the ball-joint load path. */
const ATTACH_MIN_HEIGHT = 0.05;
/** Slip ratio below which the brush keeps its full lateral share. */
const BRUSH_SLIP_DEADZONE = 0.12;
/** Combined-slip blend speed, m/s (see applyTreadBrush). */
const BRUSH_SHARE_V0 = 0.5;

/**
 * HOOP TENSION (wheels with rimHoop / treadHoop > 0). A rim is a stiff
 * alloy hoop and a tyre's steel belt is near-inextensible: neither grows
 * much with speed, and the belt's hoop tension (ρ·v²) is what keeps a real
 * tyre's tread on its circle. The explicit node budget affords only ~5e4
 * N/m spokes / sidewalls, so at 200 km/h (ω ≈ 170 rad/s, m·ω²·r ≈ 3–6 kN
 * per node) the rim rings ballooned ~7 cm and the tread ~5 cm, lifting the
 * car 7.5 cm; above ~205 km/h the tread fell into a standing-wave state
 * (rolling radius dropped 10 %, the free fronts jumped from −4 % to +5 %
 * slip) and the car settled into a ±0.1 rad/s yaw limit cycle.
 * Each ring segment (k, k+1) gets the tension a spinning hoop carries,
 * T = f·m·ω̂²·r/(2·sin(π/n)) (m = mean endpoint mass, r = the ring's
 * design radius, ω̂ = min(|ω|, HOOP_OMEGA_MAX), f = the def's fraction,
 * folded into rimHoop / treadHoop with the 1/(2·sin(π/n))); on a regular
 * polygon its resultant is f·m·ω²·r toward the axle. Internal forces (equal
 * and opposite along each segment): no net force or torque on the wheel,
 * and a flattened contact patch gets none (straight segments). The
 * tension's geometric stiffness 2T/L adds ω_g = √f·ω̂/(√2·sin(π/n)) (2.7·√f·ω̂
 * at 12 rays) to the ring nodes in quadrature; HOOP_OMEGA_MAX caps it
 * (≈ 245 km/h) so the sedan's rim (0.35 → 0.46) and tread (0.45 → 0.50
 * at f = 0.5) stay within ω·dt ≤ 0.5.
 */
export const HOOP_OMEGA_MAX = 220;

export function applyHoopTension(state: SimState, w: WheelRuntime): void {
  const rim = w.wheel.rimHoop;
  const tread = w.wheel.treadHoop;
  if (!(rim > 0) && !(tread > 0)) return;
  let om = w.omega < 0 ? -w.omega : w.omega;
  if (om > HOOP_OMEGA_MAX) om = HOOP_OMEGA_MAX;
  const w2 = om * om;
  if (!(w2 > 0)) return;
  const n = w.wheel.rays;
  if (rim > 0) {
    const g = w2 * rim * w.wheel.rimRadius;
    hoopRing(state, w.rimStart, n, g);
    hoopRing(state, w.rimStart + n, n, g);
  }
  if (tread > 0) {
    const g = w2 * tread * w.wheel.tireRingRadius;
    hoopRing(state, w.tireStart, n, g);
    hoopRing(state, w.tireStart + n, n, g);
  }
}

/** Tension m·g along each segment of the closed ring start..start+n−1 (m = mean endpoint mass). */
function hoopRing(state: SimState, start: number, n: number, g: number): void {
  const { posX, posY, posZ, frcX, frcY, frcZ, invMass } = state;
  for (let k = 0; k < n; k++) {
    const a = start + k;
    const b = k + 1 === n ? start : a + 1;
    const dx = posX[b]! - posX[a]!;
    const dy = posY[b]! - posY[a]!;
    const dz = posZ[b]! - posZ[a]!;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-9)) continue;
    const sc = (0.5 * (1 / invMass[a]! + 1 / invMass[b]!) * g) / L;
    frcX[a] = frcX[a]! + sc * dx;
    frcY[a] = frcY[a]! + sc * dy;
    frcZ[a] = frcZ[a]! + sc * dz;
    frcX[b] = frcX[b]! - sc * dx;
    frcY[b] = frcY[b]! - sc * dy;
    frcZ[b] = frcZ[b]! - sc * dz;
  }
}

export function applyTreadBrush(state: SimState, w: WheelRuntime, dt: number): void {
  const k = w.wheel.brushK;
  if (!(k > 0)) return;
  const sampler = groundSampler;
  const tLoad = w.treadLoad;
  const tNrm = w.treadNormal;
  const brush = w.treadBrush;
  const n = w.ringCount;
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, friction, treadAxX, treadAxY, treadAxZ, treadF } =
    state;
  const t0 = w.tireStart;
  if (sampler === null || !axleFrame(state, w)) {
    brush.fill(0);
    for (let j = 0; j < n; j++) treadF[t0 + j] = 0;
    return;
  }
  const matFriction = groundMaterials.friction;
  const cx = frame[0]!;
  const cy = frame[1]!;
  const cz = frame[2]!;
  const sx = frame[3]!;
  const sy = frame[4]!;
  const sz = frame[5]!;
  const hi = w.hubI;
  const ho = w.hubO;
  const vcx = (velX[hi]! + velX[ho]!) * 0.5;
  const vcy = (velY[hi]! + velY[ho]!) * 0.5;
  const vcz = (velZ[hi]! + velZ[ho]!) * 0.5;
  const c = w.wheel.brushC;
  const latMu = w.latMu ?? 1;
  const invDt = 1 / dt;
  // Longitudinal sliding speed for the combined-slip share: only slip
  // beyond BRUSH_SLIP_DEADZONE counts (a locked or spinning wheel). Using
  // the raw slip VELOCITY scaled with road speed: at 185 km/h a normal
  // 1.5 % drive slip (and the free wheels' −6 % rolling-radius bias) took
  // 60 % of the rear's lateral grip under power and the car weaved into a
  // spin.
  const fwx = -sz;
  const fwz = sx;
  const fl = Math.sqrt(fwx * fwx + fwz * fwz);
  let uxLong = 0;
  if (fl > 1e-6) {
    let vf = (vcx * fwx + vcz * fwz) / fl;
    if (vf < 0) vf = -vf;
    const sr = w.slipRatio < 0 ? -w.slipRatio : w.slipRatio;
    if (sr > BRUSH_SLIP_DEADZONE) uxLong = (sr - BRUSH_SLIP_DEADZONE) * (vf > 1 ? vf : 1);
  }
  // Contact wrench about the wheel centre.
  let Fx = 0;
  let Fy = 0;
  let Fz = 0;
  let Mx = 0;
  let My = 0;
  let Mz = 0;
  for (let j = 0; j < n; j++) {
    const i = t0 + j;
    const fn = tLoad[j]!;
    if (!(fn > 0)) {
      brush[3 * j] = 0;
      treadAxX[i] = 0;
      treadAxY[i] = 0;
      treadAxZ[i] = 0;
      treadF[i] = 0;
      continue;
    }
    const j3 = 3 * j;
    const nx = tNrm[j3]!;
    const ny = tNrm[j3 + 1]!;
    const nz = tNrm[j3 + 2]!;
    // Lateral direction â: s in the ground tangent plane.
    const sn = sx * nx + sy * ny + sz * nz;
    let ax = sx - sn * nx;
    let ay = sy - sn * ny;
    let az = sz - sn * nz;
    const al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (!(al > 1e-6)) {
      brush[j3] = 0;
      treadF[i] = 0;
      continue;
    }
    ax /= al;
    ay /= al;
    az /= al;
    const u = vcx * ax + vcy * ay + vcz * az;
    let d = brush[j3]! + u * dt;
    let f = -k * d - c * u;
    // Combined slip: the brush gets the lateral share of the slip velocity,
    // (|u_y| + V0)/(|u| + V0) — ≈ 1 when cornering or rolling, small on a
    // locked or spinning wheel (the stick takes the longitudinal rest).
    const ua = u < 0 ? -u : u;
    const share = (ua + BRUSH_SHARE_V0) / (Math.sqrt(u * u + uxLong * uxLong) + BRUSH_SHARE_V0);
    const cap = share * latMu * friction[i]! * matFriction[sampler.materialAt(posX[i]!, posZ[i]!)]! * fn;
    if (f > cap || f < -cap) {
      f = f > 0 ? cap : -cap;
      const dMax = cap / k;
      if (d > dMax) d = dMax;
      else if (d < -dMax) d = -dMax;
    }
    brush[j3] = d;
    // the axis carries μ_y/μ_x in its length (ground.ts caps the node stick's lateral share with it)
    treadAxX[i] = ax * latMu;
    treadAxY[i] = ay * latMu;
    treadAxZ[i] = az * latMu;
    treadF[i] = f < 0 ? -f : f;
    // Ground point under the node centre, relative to the wheel centre.
    const px = posX[i]!;
    const py = posY[i]!;
    const pz = posZ[i]!;
    const hgt = (py - sampler.heightAt(px, pz)) * ny;
    const rx = px - nx * hgt - cx;
    const ry = py - ny * hgt - cy;
    const rz = pz - nz * hgt - cz;
    const fx = f * ax;
    const fy = f * ay;
    const fz = f * az;
    Fx += fx;
    Fy += fy;
    Fz += fz;
    Mx += ry * fz - rz * fy;
    My += rz * fx - rx * fz;
    Mz += rx * fy - ry * fx;
    // Lateral tread vibration damper relative to the rigid wheel.
    const cn = (TREAD_NODE_DAMP * invDt) / invMass[i]!;
    const wl = (velX[i]! - vcx) * ax + (velY[i]! - vcy) * ay + (velZ[i]! - vcz) * az;
    frcX[i] = frcX[i]! - cn * wl * ax;
    frcY[i] = frcY[i]! - cn * wl * ay;
    frcZ[i] = frcZ[i]! - cn * wl * az;
  }
  // Net force: half on each hub. Moment about the centre: the spin part
  // (≈ 0 for lateral forces) to the rim ring; the overturning part (about
  // forward f = s × n) as a lateral force pair between the upright top
  // (WheelDef.attach nodes, height h above the centre) and the hubs, F =
  // M_f/h — the ball-joint load path; the hub pair (0.24 m apart, held
  // vertically only by the upright's own beams) progressively cambered the
  // loaded front wheel 20° under it. The rest (aligning) as a hub couple
  // F = (M × l)/|l|² on hubO, −F on hubI (l = hubO − hubI).
  const ms = Mx * sx + My * sy + Mz * sz;
  let mpx = Mx - ms * sx;
  let mpy = My - ms * sy;
  let mpz = Mz - ms * sz;
  let hx = 0.5 * Fx;
  let hy = 0.5 * Fy;
  let hz = 0.5 * Fz;
  const att = w.attachNodes;
  const na = att.length;
  if (na > 0) {
    // Ground normal (load-weighted) and forward axis f = s × n.
    let gnx = 0;
    let gny = 0;
    let gnz = 0;
    for (let j = 0; j < n; j++) {
      const fnj = tLoad[j]!;
      gnx += fnj * tNrm[3 * j]!;
      gny += fnj * tNrm[3 * j + 1]!;
      gnz += fnj * tNrm[3 * j + 2]!;
    }
    const gl = Math.sqrt(gnx * gnx + gny * gny + gnz * gnz);
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let q = 0; q < na; q++) {
      const a = att[q]!;
      ax += posX[a]!;
      ay += posY[a]!;
      az += posZ[a]!;
    }
    ax = ax / na - cx;
    ay = ay / na - cy;
    az = az / na - cz;
    if (gl > 0) {
      gnx /= gl;
      gny /= gl;
      gnz /= gl;
      const h = ax * gnx + ay * gny + az * gnz;
      let fwx = sy * gnz - sz * gny;
      let fwy = sz * gnx - sx * gnz;
      let fwz = sx * gny - sy * gnx;
      const fwl = Math.sqrt(fwx * fwx + fwy * fwy + fwz * fwz);
      if (h > ATTACH_MIN_HEIGHT && fwl > 1e-6) {
        fwx /= fwl;
        fwy /= fwl;
        fwz /= fwl;
        const mf = mpx * fwx + mpy * fwy + mpz * fwz;
        mpx -= mf * fwx;
        mpy -= mf * fwy;
        mpz -= mf * fwz;
        // v = f × n (lateral), force +mf/h·v on the attach nodes, −mf/h·v on the hubs.
        const g = mf / h;
        const vx = (fwy * gnz - fwz * gny) * g;
        const vy = (fwz * gnx - fwx * gnz) * g;
        const vz = (fwx * gny - fwy * gnx) * g;
        const per = 1 / na;
        for (let q = 0; q < na; q++) {
          const a = att[q]!;
          frcX[a] = frcX[a]! + vx * per;
          frcY[a] = frcY[a]! + vy * per;
          frcZ[a] = frcZ[a]! + vz * per;
        }
        hx -= 0.5 * vx;
        hy -= 0.5 * vy;
        hz -= 0.5 * vz;
      }
    }
  }
  const lx = posX[ho]! - posX[hi]!;
  const ly = posY[ho]! - posY[hi]!;
  const lz = posZ[ho]! - posZ[hi]!;
  const l2 = lx * lx + ly * ly + lz * lz;
  const qx = (mpy * lz - mpz * ly) / l2;
  const qy = (mpz * lx - mpx * lz) / l2;
  const qz = (mpx * ly - mpy * lx) / l2;
  frcX[ho] = frcX[ho]! + hx + qx;
  frcY[ho] = frcY[ho]! + hy + qy;
  frcZ[ho] = frcZ[ho]! + hz + qz;
  frcX[hi] = frcX[hi]! + hx - qx;
  frcY[hi] = frcY[hi]! + hy - qy;
  frcZ[hi] = frcZ[hi]! + hz - qz;
  applyRimTorque(state, w, ms);
}

/**
 * Torque τ about s (+ = forward) as tangential forces on the RIM ring
 * nodes, τ/(N·r_i)·t̂_i, with −ΣF/2 on each hub (zero net force).
 */
function applyRimTorque(state: SimState, w: WheelRuntime, tau: number): void {
  if (tau === 0) return;
  const { posX, posY, posZ, frcX, frcY, frcZ } = state;
  const cx = frame[0]!;
  const cy = frame[1]!;
  const cz = frame[2]!;
  const sx = frame[3]!;
  const sy = frame[4]!;
  const sz = frame[5]!;
  const n = w.ringCount;
  const per = tau / n;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  const r0 = w.rimStart;
  const r1 = r0 + n;
  for (let i = r0; i < r1; i++) {
    const rx = posX[i]! - cx;
    const ry = posY[i]! - cy;
    const rz = posZ[i]! - cz;
    const ax = rx * sx + ry * sy + rz * sz;
    const px = rx - ax * sx;
    const py = ry - ax * sy;
    const pz = rz - ax * sz;
    const p2 = px * px + py * py + pz * pz;
    if (!(p2 > 1e-12)) continue;
    // |s × ρ| = |ρ|; force τ_i/|ρ| along t̂ = (s × ρ)/|ρ| → (s × ρ)·τ_i/|ρ|².
    const g = per / p2;
    const fx = g * (sy * pz - sz * py);
    const fy = g * (sz * px - sx * pz);
    const fz = g * (sx * py - sy * px);
    frcX[i] = frcX[i]! + fx;
    frcY[i] = frcY[i]! + fy;
    frcZ[i] = frcZ[i]! + fz;
    sumX += fx;
    sumY += fy;
    sumZ += fz;
  }
  const hi = w.hubI;
  const ho = w.hubO;
  frcX[hi] = frcX[hi]! - 0.5 * sumX;
  frcY[hi] = frcY[hi]! - 0.5 * sumY;
  frcZ[hi] = frcZ[hi]! - 0.5 * sumZ;
  frcX[ho] = frcX[ho]! - 0.5 * sumX;
  frcY[ho] = frcY[ho]! - 0.5 * sumY;
  frcZ[ho] = frcZ[ho]! - 0.5 * sumZ;
}

/**
 * PARKING CLAMP. Engaged below PARK_SPEED (horizontal speed of the object's
 * mass-weighted mean velocity) on wheels whose brake is held: braked wheels with brake ≥ 0.1,
 * handbrake wheels with handbrake ≥ 0.1. Per engaged wheel:
 *  - brake hold (see the WHY above PARK_ANCHOR_K), capped at the wheel's
 *    available brake torque max(brakeTorque·brake, handbrakeTorque·handbrake);
 *  - per in-contact tyre node: the contract's PARK_GAIN·m/dt·|v_t| viscous
 *    term plus the contact anchor spring, together capped at
 *    μN·(1 − tanhR(|v_t|/0.3)) (N from groundNormalForce, μ = node × material).
 * Run after applyWheelTorques (it reads w.omega and w.brakeTorque).
 */
export const applyParkingClamp: ApplyParkingClamp = (state, vehicle, actions, dt) => {
  const wheels = vehicle.wheels;
  const nw = wheels.length;
  const brake = actions[Action.brake]!;
  const hand = actions[Action.handbrake]!;
  const brakeOn = brake >= PARK_PEDAL;
  const handOn = hand >= PARK_PEDAL;
  const lineLock = (vehicle.drivetrain as DrivetrainStateEx).lineLock === true;
  if ((!brakeOn && !handOn) || !(comSpeed(state, vehicle) < PARK_SPEED)) {
    for (let k = 0; k < nw; k++) release(wheels[k]!);
    return;
  }
  const sampler = groundSampler;
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, friction } = state;
  const matFriction = groundMaterials.friction;
  const invDt = 1 / dt;
  const viscGain = PARK_GAIN * invDt;
  const anchorGain = PARK_ANCHOR_K * invDt * invDt;
  for (let k = 0; k < nw; k++) {
    const w = wheels[k]!;
    const cw = w.wheel;
    // Line lock (drivetrain, TC off): the driven wheels' service brakes are released.
    const service = cw.braked && brakeOn && !(lineLock && cw.driven) ? cw.brakeTorque * brake : 0;
    const parking = cw.handbrake && handOn ? cw.handbrakeTorque * hand : 0;
    const brakeMax = service > parking ? service : parking;
    if (!(brakeMax > 0)) {
      release(w);
      continue;
    }
    const ps = parkStateFor(w);
    ps.holding = true;

    // ---- brake hold on the wheel angle
    ps.theta += w.omega * dt;
    let inertia = 0;
    const r0 = w.rimStart;
    const r1 = r0 + 2 * w.ringCount;
    const rimR = cw.rimRadius;
    const tireR = cw.tireRingRadius;
    const rimR2 = rimR * rimR;
    const tireR2 = tireR * tireR;
    for (let i = r0; i < r1; i++) {
      const im = invMass[i]!;
      if (im !== 0) inertia += (i < w.tireStart ? rimR2 : tireR2) / im;
    }
    const kHold = PARK_HOLD_K * inertia * invDt * invDt;
    const prior = w.brakeTorque;
    let total = prior - kHold * ps.theta;
    if (total > brakeMax || total < -brakeMax) {
      total = total > 0 ? brakeMax : -brakeMax;
      ps.theta = (prior - total) / kHold;
    }
    const hold = total - prior;
    w.brakeTorque = total;
    // (the hold is a numerical stiction device that winds up through the spawn settle, not a caliper load: no
    // reaction couple — on the box truck's live axle it pitched the parked truck and lowered its CG 8 mm)
    applyAxleTorque(state, w, hold);

    // ---- contact nodes: viscous + anchor, capped at μN(1 − tanhR(|v_t|/0.3))
    // (brush wheels: the tread brush already anchors the contact).
    if (sampler === null || cw.brushK > 0) continue;
    const anchor = ps.anchor;
    const armed = ps.armed;
    const n = w.ringCount;
    for (let j = 0; j < n; j++) {
      const i = w.tireStart + j;
      const fn = groundNormalForce(state, i, sampler, dt, nrm);
      if (!(fn > 0)) {
        armed[j] = 0;
        continue;
      }
      const nx = nrm[0]!;
      const ny = nrm[1]!;
      const nz = nrm[2]!;
      const px = posX[i]!;
      const py = posY[i]!;
      const pz = posZ[i]!;
      const j3 = 3 * j;
      if (armed[j] !== 0) {
        // Teleport (reset/recover) while parked: never yank toward a stale anchor.
        const ex = px - anchor[j3]!;
        const ey = py - anchor[j3 + 1]!;
        const ez = pz - anchor[j3 + 2]!;
        if (ex * ex + ey * ey + ez * ez > PARK_ANCHOR_STALE2) armed[j] = 0;
      }
      if (armed[j] === 0) {
        anchor[j3] = px;
        anchor[j3 + 1] = py;
        anchor[j3 + 2] = pz;
        armed[j] = 1;
      }
      const m = 1 / invMass[i]!;
      const vx = velX[i]!;
      const vy = velY[i]!;
      const vz = velZ[i]!;
      const vn = vx * nx + vy * ny + vz * nz;
      const tx = vx - vn * nx;
      const ty = vy - vn * ny;
      const tz = vz - vn * nz;
      const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const dx = px - anchor[j3]!;
      const dy = py - anchor[j3 + 1]!;
      const dz = pz - anchor[j3 + 2]!;
      const dn = dx * nx + dy * ny + dz * nz;
      const ox = dx - dn * nx;
      const oy = dy - dn * ny;
      const oz = dz - dn * nz;
      const ka = anchorGain * m;
      const cv = viscGain * m;
      let fx = -ka * ox - cv * tx;
      let fy = -ka * oy - cv * ty;
      let fz = -ka * oz - cv * tz;
      const f2 = fx * fx + fy * fy + fz * fz;
      if (!(f2 > 0)) continue;
      const mu = friction[i]! * matFriction[sampler.materialAt(px, pz)]!;
      const cap = mu * fn * (1 - tanhR(vt * SLIP_REG_INV));
      const f = Math.sqrt(f2);
      if (f > cap) {
        const sc = cap / f;
        fx *= sc;
        fy *= sc;
        fz *= sc;
        // Drag the anchor so the spring alone sits at the cap (no wind-up).
        const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const maxOff = cap / ka;
        if (ol > maxOff) {
          const pull = (ol - maxOff) / ol;
          anchor[j3] = anchor[j3]! + ox * pull;
          anchor[j3 + 1] = anchor[j3 + 1]! + oy * pull;
          anchor[j3 + 2] = anchor[j3 + 2]! + oz * pull;
        }
      }
      frcX[i] = frcX[i]! + fx;
      frcY[i] = frcY[i]! + fy;
      frcZ[i] = frcZ[i]! + fz;
    }
  }
};

/**
 * Horizontal speed of the object's mass-weighted mean velocity, m/s. The
 * vertical component is left out on purpose: body/tyre bounce reaches
 * ~0.3 m/s on a parked car and would otherwise release the clamp (and
 * re-base its anchors) every bounce cycle.
 */
function comSpeed(state: SimState, vehicle: VehicleRuntime): number {
  const { velX, velZ, invMass } = state;
  const start = vehicle.nodeStart;
  const end = start + vehicle.vehicle.rig.nodeCount;
  let m = 0;
  let px = 0;
  let pz = 0;
  for (let i = start; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) continue;
    const mi = 1 / im;
    m += mi;
    px += mi * velX[i]!;
    pz += mi * velZ[i]!;
  }
  if (!(m > 0)) return 0;
  return Math.sqrt(px * px + pz * pz) / m;
}
