/**
 * RIGID SHELL CLUSTER: a shape-matching blend that makes the body shell
 * behave like stiff steel while driving and lets go wherever a crash
 * deforms it. WORKER hot path (applyShell) + pure compile/runtime helpers.
 *
 * WHY (measured, bodyflex.ts): with every node at the ω·dt ≤ 0.5 budget at
 * dt = 1/2000, beams can only be ~1–4e5 N/m on 5–13 kg nodes, and a
 * 134-node lattice of such beams is a mechanism-like jelly: sedan torsion
 * 1.8 kN·m/deg (real 15–40), first torsion / bending modes 7.5 / 5 Hz
 * (real 25–50), extremity deflection 6–33 mm under launch / brake / 1 g /
 * curb loads (real ≲ 2 mm). Global modes sit ~20× below the node-local
 * frequency, so no triangulation within the budget reaches 25 Hz.
 *
 * MODEL. The cluster = the shell nodes (groups SHELL_GROUPS) with rest
 * shape r_i and weights w_i ∈ [0, 1]. Every tick, after all forces and
 * before integration:
 *   v*_i = v_i + (F_i/m_i + g)·dt                    (predicted velocity)
 *   c, v_c   = Σ w m x / W,  Σ w m v* / W            (W = Σ w m)
 *   R        = polar(Σ w m (x − c)(r − r̄)ᵀ)           (best-fit rotation)
 *   ω        = I⁻¹ Σ w m (x − c) × (v* − v_c)        (cluster spin)
 *   g_i = c + R(r_i − r̄),  vg_i = v_c + ω × (x_i − c)
 *   Δv_i = [β (vg_i − v*_i) − k·dt (x_i − g_i)] / (1 + β),  β = c_d·dt + k·dt²
 *   F_i += w_i m_i Δv_i / dt
 * i.e. each node is tied to its goal by a spring-damper (k = ω_s², c_d =
 * 2ζω_s per unit mass) solved BACKWARD-EULER with the goal held for the
 * tick: unconditionally stable, so it adds no explicit stiffness to the
 * ω·dt budget (the beams keep theirs). Linear and angular momentum are
 * conserved exactly (Σ w m (x − g) = 0 and Σ w m d × (x − g) = 0 at the
 * Procrustes optimum; the damping term targets the cluster's own rigid
 * velocity field). Only + − × ÷ sqrt (polar by scaled Newton iteration).
 *
 * RELEASE / YIELD (per node tier, shellDefs.ts ShellZone): a node's weight
 * drops (sticky) when its deviation e_i = |x_i − g_i| or its speed relative
 * to the rigid motion passes the tier's thresholds; a WHOLE tier lets go
 * entirely once any of its nodes starts to (crumple zones: the crush then
 * runs on the beams alone, exactly as tuned); a YIELD tier instead lets the
 * rest position flow past `lo` (perfectly plastic bond: the safety cell
 * keeps its shape and dents only where a load exceeds it), and still
 * releases on an impact at the node or when pressed into a contact.
 * RECAPTURE. Once some nodes are released and the car has been calm for
 * RECAPTURE_S (released nodes' speed relative to the rigid field below
 * RECAPTURE_SPEED, no new release), the current shape becomes the new rest
 * shape and every node whose incident beams are all intact rejoins (a
 * crumpled car drives on as a stiff crumpled car). Reset (repair) restores
 * the original rest shape and weights.
 */
import { NODE_FLAG_IN_CONTACT, NODE_FLAG_OBJ_IMPACT, NODE_FLAG_OBJ_TOUCH, type SimState } from '../types';
import type { CompiledRig } from '../rig/types';
import { CONTACT_RELEASE, RECAPTURE_IMPACT_MAX_S, RECAPTURE_IMPACT_S, RECAPTURE_IMPACT_SPEED, RECAPTURE_SPEED, type CompiledShell } from './shellDefs';

const POLAR_ITERS = 12;

export interface ShellRuntime {
  shell: CompiledShell;
  /** GLOBAL node indices (rebased). */
  nodes: Int32Array;
  /** GLOBAL beam index offset (rig-local beam + beamOffset). */
  beamOffset: number;
  /** Current rest shape (recaptured after crashes). */
  rest: Float64Array;
  /** Weights 0..1 (sticky minimum). */
  w: Float64Array;
  mass: Float64Array;
  /** Last best-fit rotation (row-major) and centroid (diagnostics / recapture). */
  R: Float64Array;
  /** Nodes released (w < 1) since the last capture. */
  released: number;
  /** 1 = left out at the last recapture (a broken incident beam): ignored until repair. */
  gone: Uint8Array;
  /** Per tier: a WHOLE tier has tripped (all its nodes released). */
  tripped: Uint8Array;
  /** R-CRASH per tier: its latch has broken (ShellZone.latch): released for good until repair. */
  latchOff: Uint8Array;
  calmTicks: number;
  /** Ticks since a node last newly released (post-impact set, RECAPTURE_IMPACT_S). */
  quietTicks: number;
  /** Max deviation this tick, m (diagnostics). */
  maxDev: number;
  /** Scratch: per-node goal xyz. */
  gx: Float64Array;
  /** Scratch: predicted velocities. */
  vs: Float64Array;
}

export function createShellRuntime(shell: CompiledShell, rig: CompiledRig): ShellRuntime {
  const n = shell.nodes.length;
  const mass = new Float64Array(n);
  for (let k = 0; k < n; k++) mass[k] = 1 / rig.nodeInvMass[shell.nodes[k]!]!;
  return {
    shell,
    nodes: Int32Array.from(shell.nodes),
    beamOffset: 0,
    rest: Float64Array.from(shell.rest),
    w: new Float64Array(n).fill(1),
    mass,
    R: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    released: 0,
    gone: new Uint8Array(n),
    tripped: new Uint8Array(shell.whole.length),
    latchOff: new Uint8Array(shell.whole.length),
    calmTicks: 0,
    quietTicks: 0,
    maxDev: 0,
    gx: new Float64Array(3 * n),
    vs: new Float64Array(3 * n),
  };
}

export function rebaseShell(rt: ShellRuntime, nodeStart: number, beamStart: number): void {
  const s = rt.shell.nodes;
  for (let k = 0; k < s.length; k++) rt.nodes[k] = nodeStart + s[k]!;
  rt.beamOffset = beamStart;
}

/**
 * R-CRASH: the vehicle is in a crash (beams.ts crush unloading armed): some shell node has been released by
 * an impact since the last capture. Driving loads, kerbs and drops release nothing (bodyflex tests).
 */
export function shellCrashArmed(shells: readonly ShellRuntime[] | undefined): boolean {
  if (shells === undefined) return false;
  for (let c = 0; c < shells.length; c++) if (shells[c]!.released > 0) return true;
  return false;
}

/** Full repair: original rest shape, every node rejoined. */
export function resetShell(rt: ShellRuntime): void {
  rt.rest.set(rt.shell.rest);
  rt.w.fill(1);
  rt.gone.fill(0);
  rt.tripped.fill(0);
  rt.latchOff.fill(0);
  rt.released = 0;
  rt.calmTicks = 0;
  rt.quietTicks = 0;
  rt.R.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/**
 * Rotation factor of the 3×3 row-major `a` by scaled Newton iteration
 * X ← ½(γX + X⁻ᵀ/γ), γ = sqrt(‖X⁻¹‖_F / ‖X‖_F). Writes `out`; returns
 * false when det(a) ≤ 0 (reflected / collapsed cluster: skip).
 */
export function polar3(a: Float64Array, out: Float64Array): boolean {
  let x0 = a[0]!, x1 = a[1]!, x2 = a[2]!, x3 = a[3]!, x4 = a[4]!, x5 = a[5]!, x6 = a[6]!, x7 = a[7]!, x8 = a[8]!;
  for (let it = 0; it < POLAR_ITERS; it++) {
    // cofactors (C = det · X⁻ᵀ)
    const c0 = x4 * x8 - x5 * x7;
    const c1 = x5 * x6 - x3 * x8;
    const c2 = x3 * x7 - x4 * x6;
    const c3 = x2 * x7 - x1 * x8;
    const c4 = x0 * x8 - x2 * x6;
    const c5 = x1 * x6 - x0 * x7;
    const c6 = x1 * x5 - x2 * x4;
    const c7 = x2 * x3 - x0 * x5;
    const c8 = x0 * x4 - x1 * x3;
    const det = x0 * c0 + x1 * c1 + x2 * c2;
    if (!(det > 1e-30)) return false;
    const inv = 1 / det;
    const nx = x0 * x0 + x1 * x1 + x2 * x2 + x3 * x3 + x4 * x4 + x5 * x5 + x6 * x6 + x7 * x7 + x8 * x8;
    const ni = (c0 * c0 + c1 * c1 + c2 * c2 + c3 * c3 + c4 * c4 + c5 * c5 + c6 * c6 + c7 * c7 + c8 * c8) * inv * inv;
    const g = Math.sqrt(Math.sqrt(ni / nx));
    const ga = 0.5 * g;
    const gb = (0.5 / g) * inv;
    const y0 = ga * x0 + gb * c0;
    const y1 = ga * x1 + gb * c1;
    const y2 = ga * x2 + gb * c2;
    const y3 = ga * x3 + gb * c3;
    const y4 = ga * x4 + gb * c4;
    const y5 = ga * x5 + gb * c5;
    const y6 = ga * x6 + gb * c6;
    const y7 = ga * x7 + gb * c7;
    const y8 = ga * x8 + gb * c8;
    const d =
      (y0 - x0) * (y0 - x0) + (y1 - x1) * (y1 - x1) + (y2 - x2) * (y2 - x2) +
      (y3 - x3) * (y3 - x3) + (y4 - x4) * (y4 - x4) + (y5 - x5) * (y5 - x5) +
      (y6 - x6) * (y6 - x6) + (y7 - x7) * (y7 - x7) + (y8 - x8) * (y8 - x8);
    x0 = y0; x1 = y1; x2 = y2; x3 = y3; x4 = y4; x5 = y5; x6 = y6; x7 = y7; x8 = y8;
    if (d < 1e-26) break;
  }
  out[0] = x0; out[1] = x1; out[2] = x2; out[3] = x3; out[4] = x4; out[5] = x5; out[6] = x6; out[7] = x7; out[8] = x8;
  return true;
}

const A = new Float64Array(9);
const R = new Float64Array(9);

/**
 * The shell pass (see header). Runs per vehicle after every force pass of
 * the tick and before integrateNodes. Allocation-free.
 */
export function applyShell(s: SimState, rt: ShellRuntime, dt: number, gx: number, gy: number, gz: number): void {
  const nodes = rt.nodes;
  const n = nodes.length;
  const w = rt.w;
  // R-CRASH latched zones: a broken latch beam trips the zone for good (shellDefs ShellZone.latch)
  {
    const ls = rt.shell.latchStart;
    const lb = rt.shell.latchBeams;
    const active = s.active;
    for (let t = 1; t + 1 < ls.length; t++) {
      if (rt.latchOff[t] !== 0) continue;
      for (let j = ls[t]!; j < ls[t + 1]!; j++) {
        if (active[rt.beamOffset + lb[j]!] === 0) {
          rt.latchOff[t] = 1;
          rt.tripped[t] = 1;
          // the latch has popped: every latch beam of the zone lets go with it (a racking sensor broke)
          for (let q = ls[t]!; q < ls[t + 1]!; q++) active[rt.beamOffset + lb[q]!] = 0;
          break;
        }
      }
    }
  }
  const mass = rt.mass;
  const rest = rt.rest;
  const vs = rt.vs;
  const posX = s.posX, posY = s.posY, posZ = s.posZ;
  const velX = s.velX, velY = s.velY, velZ = s.velZ;
  const frcX = s.frcX, frcY = s.frcY, frcZ = s.frcZ;
  const invMass = s.invMass;
  // ---- pass 1: weighted centroid, predicted momentum, rest centroid
  let W = 0;
  let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, rx = 0, ry = 0, rz = 0;
  for (let k = 0; k < n; k++) {
    const i = nodes[k]!;
    const im = invMass[i]!;
    const v0 = velX[i]! + (frcX[i]! * im + gx) * dt;
    const v1 = velY[i]! + (frcY[i]! * im + gy) * dt;
    const v2 = velZ[i]! + (frcZ[i]! * im + gz) * dt;
    vs[3 * k] = v0;
    vs[3 * k + 1] = v1;
    vs[3 * k + 2] = v2;
    const m = w[k]! * mass[k]!;
    if (m === 0 || im === 0) continue;
    W += m;
    cx += m * posX[i]!; cy += m * posY[i]!; cz += m * posZ[i]!;
    vx += m * v0; vy += m * v1; vz += m * v2;
    rx += m * rest[3 * k]!; ry += m * rest[3 * k + 1]!; rz += m * rest[3 * k + 2]!;
  }
  if (!(W > 0)) return;
  const iW = 1 / W;
  cx *= iW; cy *= iW; cz *= iW; vx *= iW; vy *= iW; vz *= iW; rx *= iW; ry *= iW; rz *= iW;
  // ---- pass 2: covariance, angular momentum, inertia
  A.fill(0);
  let lx = 0, ly = 0, lz = 0;
  let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
  for (let k = 0; k < n; k++) {
    const m = w[k]! * mass[k]!;
    if (m === 0) continue;
    const i = nodes[k]!;
    if (invMass[i] === 0) continue;
    const dx = posX[i]! - cx, dy = posY[i]! - cy, dz = posZ[i]! - cz;
    const qx = rest[3 * k]! - rx, qy = rest[3 * k + 1]! - ry, qz = rest[3 * k + 2]! - rz;
    A[0]! += m * dx * qx; A[1]! += m * dx * qy; A[2]! += m * dx * qz;
    A[3]! += m * dy * qx; A[4]! += m * dy * qy; A[5]! += m * dy * qz;
    A[6]! += m * dz * qx; A[7]! += m * dz * qy; A[8]! += m * dz * qz;
    const ux = vs[3 * k]! - vx, uy = vs[3 * k + 1]! - vy, uz = vs[3 * k + 2]! - vz;
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
  if (!polar3(A, R)) return;
  rt.R.set(R);
  // ω = I⁻¹ L (symmetric 3×3 inverse by cofactors)
  const j0 = iyy * izz - iyz * iyz;
  const j1 = ixz * iyz - ixy * izz;
  const j2 = ixy * iyz - ixz * iyy;
  const det = ixx * j0 + ixy * j1 + ixz * j2;
  let ox = 0, oy = 0, oz = 0;
  if (det > 1e-30) {
    const j4 = ixx * izz - ixz * ixz;
    const j5 = ixy * ixz - ixx * iyz;
    const j8 = ixx * iyy - ixy * ixy;
    const id = 1 / det;
    ox = (j0 * lx + j1 * ly + j2 * lz) * id;
    oy = (j1 * lx + j4 * ly + j5 * lz) * id;
    oz = (j2 * lx + j5 * ly + j8 * lz) * id;
  }
  // ---- pass 3: goals, release, corrective forces
  const sh = rt.shell;
  const k = sh.k;
  const beta = sh.cd * dt + k * dt * dt;
  const inv1b = 1 / (1 + beta);
  const kdt = k * dt;
  const rel = sh.release;
  const tier = sh.tier;
  const flags = s.flags;
  const whole = sh.whole;
  const yields = sh.yields;
  const tripped = rt.tripped;
  const idt = 1 / dt;
  let maxDev2 = 0;
  let maxRel2 = 0;
  let sumRel2 = 0;
  let nRel = 0;
  let newRelease = false;
  const r0 = R[0]!, r1 = R[1]!, r2 = R[2]!, r3 = R[3]!, r4 = R[4]!, r5 = R[5]!, r6 = R[6]!, r7 = R[7]!, r8 = R[8]!;
  for (let q = 0; q < n; q++) {
    const wq = w[q]!;
    const i = nodes[q]!;
    if (invMass[i] === 0) continue;
    const px = posX[i]!, py = posY[i]!, pz = posZ[i]!;
    const qx = rest[3 * q]! - rx, qy = rest[3 * q + 1]! - ry, qz = rest[3 * q + 2]! - rz;
    const ex = px - (cx + r0 * qx + r1 * qy + r2 * qz);
    const ey = py - (cy + r3 * qx + r4 * qy + r5 * qz);
    const ez = pz - (cz + r6 * qx + r7 * qy + r8 * qz);
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const ux = vx + (oy * dz - oz * dy) - vs[3 * q]!;
    const uy = vy + (oz * dx - ox * dz) - vs[3 * q + 1]!;
    const uz = vz + (ox * dy - oy * dx) - vs[3 * q + 2]!;
    if (wq === 0) {
      if (rt.gone[q] !== 0) continue;
      const r2v = ux * ux + uy * uy + uz * uz;
      if (r2v > maxRel2) maxRel2 = r2v;
      sumRel2 += r2v;
      nRel++;
      continue;
    }
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > maxDev2) maxDev2 = e2;
    const u2 = ux * ux + uy * uy + uz * uz;
    let wn = wq;
    const tq = tier[q]!;
    const ro = 4 * tq;
    const lo = rel[ro]!;
    const vlo = rel[ro + 2]!;
    if (tripped[tq] !== 0) {
      wn = 0;
      w[q] = 0;
      if (wq === 1) rt.released++;
      newRelease = true;
    } else if (
      yields[tq] !== 0 &&
      u2 <= vlo * vlo &&
      ((flags[i]! & (NODE_FLAG_IN_CONTACT | NODE_FLAG_OBJ_TOUCH)) === 0 || e2 <= CONTACT_RELEASE * CONTACT_RELEASE) &&
      // R-CRASH: a crumple-zone node struck by another object (NODE_FLAG_OBJ_IMPACT) releases its zone
      !((flags[i]! & NODE_FLAG_OBJ_IMPACT) !== 0 && whole[tq] !== 0)
    ) {
      // plastic flow: the rest position follows past lo (this tick's force uses the full e: momentum exact)
      if (e2 > lo * lo) {
        const f = 1 - lo / Math.sqrt(e2);
        const fx = ex * f, fy = ey * f, fz = ez * f;
        rest[3 * q]! += r0 * fx + r3 * fy + r6 * fz;
        rest[3 * q + 1]! += r1 * fx + r4 * fy + r7 * fz;
        rest[3 * q + 2]! += r2 * fx + r5 * fy + r8 * fz;
      }
    } else if (e2 > lo * lo || u2 > vlo * vlo || ((flags[i]! & NODE_FLAG_OBJ_IMPACT) !== 0 && whole[tq] !== 0)) {
      // a yield tier gets here only by speed (an impact at this node) or pressed into a contact: release
      let t = e2 > lo * lo && yields[tq] === 0 ? (rel[ro + 1]! - Math.sqrt(e2)) / (rel[ro + 1]! - lo) : 1;
      // pressed into a contact past CONTACT_RELEASE, or struck by another object (whole tiers): let go now
      // (R-CRASH: the yield-tier contact release computed t = 1 here and never released)
      const fl = flags[i]!;
      if (yields[tq] !== 0 && (((fl & (NODE_FLAG_IN_CONTACT | NODE_FLAG_OBJ_TOUCH)) !== 0 && e2 > CONTACT_RELEASE * CONTACT_RELEASE) || ((fl & NODE_FLAG_OBJ_IMPACT) !== 0 && whole[tq] !== 0))) t = 0;
      if (u2 > vlo * vlo) {
        const tv = (rel[ro + 3]! - Math.sqrt(u2)) / (rel[ro + 3]! - vlo);
        if (tv < t) t = tv;
      }
      let wt = t < 0 ? 0 : t;
      if (wt < wq && whole[tq] !== 0) {
        tripped[tq] = 1;
        wt = 0;
      }
      if (wt < wq) {
        wn = wt;
        if (wq === 1) rt.released++;
        w[q] = wt;
        newRelease = true;
      }
    }
    if (wn < 1) {
      if (u2 > maxRel2) maxRel2 = u2;
      sumRel2 += u2;
      nRel++;
    }
    if (wn === 0) continue;
    const f = wn * mass[q]! * idt * inv1b;
    frcX[i]! += f * (beta * ux - kdt * ex);
    frcY[i]! += f * (beta * uy - kdt * ey);
    frcZ[i]! += f * (beta * uz - kdt * ez);
  }
  rt.maxDev = Math.sqrt(maxDev2);
  // ---- recapture after a crash once calm
  if (rt.released > 0) {
    rt.quietTicks = newRelease ? 0 : rt.quietTicks + 1;
    if (newRelease || maxRel2 > RECAPTURE_SPEED * RECAPTURE_SPEED) rt.calmTicks = 0;
    else rt.calmTicks++;
    if (rt.calmTicks * dt >= sh.recaptureS || (rt.quietTicks * dt >= RECAPTURE_IMPACT_S && sumRel2 <= nRel * RECAPTURE_IMPACT_SPEED * RECAPTURE_IMPACT_SPEED) || rt.quietTicks * dt >= RECAPTURE_IMPACT_MAX_S) {
      recapture(s, rt, cx, cy, cz);
    }
  }
}

/** Current shape → rest shape (body frame R, centroid c); nodes with every incident beam intact rejoin. */
function recapture(s: SimState, rt: ShellRuntime, cx: number, cy: number, cz: number): void {
  const R0 = rt.R;
  const sh = rt.shell;
  const n = rt.nodes.length;
  for (let k = 0; k < n; k++) {
    const i = rt.nodes[k]!;
    const dx = s.posX[i]! - cx, dy = s.posY[i]! - cy, dz = s.posZ[i]! - cz;
    // Rᵀ d
    rt.rest[3 * k] = R0[0]! * dx + R0[3]! * dy + R0[6]! * dz;
    rt.rest[3 * k + 1] = R0[1]! * dx + R0[4]! * dy + R0[7]! * dz;
    rt.rest[3 * k + 2] = R0[2]! * dx + R0[5]! * dy + R0[8]! * dz;
    let intact = true;
    for (let b = sh.beamStart[k]!; b < sh.beamStart[k + 1]!; b++) {
      if (s.active[rt.beamOffset + sh.beams[b]!] === 0) {
        intact = false;
        break;
      }
    }
    const keep = intact && rt.latchOff[sh.tier[k]!] === 0;
    rt.w[k] = keep ? 1 : 0;
    rt.gone[k] = keep ? 0 : 1;
  }
  rt.tripped.fill(0);
  rt.released = 0;
  rt.calmTicks = 0;
  rt.quietTicks = 0;
}
