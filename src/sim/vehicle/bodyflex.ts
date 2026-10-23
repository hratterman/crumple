/**
 * Headless BODY-FLEX harness (worker-side, test/tool use only; allocates):
 * how stiff the body shell is and how much it visibly bends under driving
 * loads. Real car bodies: torsion 15–40 kN·m/deg, first global modes
 * 25–50 Hz, extremity deflection under 1 g driving loads ≲ 1–2 mm.
 *
 * - `bodyProbe(cv)`: the shell nodes (group 'body'; hood / tailgate / engine
 *   / suspension groups excluded), the extremity subset (front-most and
 *   rear-most 0.3 m, top 0.12 m) and the suspension mounts per corner (the
 *   first 'body' / 'subframe' nodes reached from the hubs through unsprung
 *   groups).
 * - Deflection = node position minus the RIGID best fit (weighted Kabsch,
 *   polar decomposition by Newton iteration) of the reference shape to the
 *   current shape: rigid motion, roll and pitch on the springs are removed,
 *   only the body's own bending / twisting remains.
 * - `runTorsion`: gravity off, rear mounts pinned, a vertical force couple
 *   on the front mounts (torque T about the car's long axis), damped static
 *   solve → T / twist (N·m/deg). `runBending`: mounts pinned, vertical load
 *   on the mid-cabin sill/floor nodes → N/mm.
 * - `runModes`: gravity off, wheel nodes pinned (the body hangs on its
 *   springs), a twist / bend velocity field on the shell, free decay; the
 *   twist / bend coordinate's spectrum peak = first torsion / bending mode.
 * - `runDrive`: launch (full throttle, 6 s, gear changes), hard brake from
 *   100 km/h, steady lateral demand, curb strike (one side, 50 km/h):
 *   extremity deflection vs the settled reference shape, its decay after the
 *   curb, and the CG longitudinal acceleration (1 kHz) for the jitter
 *   spectrum.
 */
import { MaterialId } from '../../protocol/messages';
import type { ColliderDef } from '../../world/types';
import { SimEngine, SIM_DT, SIM_HZ } from '../engine';
import { createHandlingSim, kinematics, setMotion, type HandlingSim } from './handling';
import type { CompiledVehicle, VehicleDef } from './types';
import type { DrivetrainStateEx } from './drivetrain';
import { compileVehicle } from './builder';

export interface BodyProbe {
  /** Rig-local shell node indices (all parts, concatenated in part order). */
  shell: number[];
  /**
   * Rigid bodies measured separately, as [start, end) ranges into `shell`:
   * one per shell cluster of the def (a body-on-frame vehicle's cab, box, …)
   * plus the remaining 'body' nodes (e.g. a ladder frame) when ≥ 12; the
   * def's shell `exclude` nodes (anti-roll bar arms) are left out.
   */
  parts: [number, number][];
  /** Subset of `shell` (indices INTO shell) at the extremities. */
  extremity: number[];
  /** Rig-local mount nodes per corner FL, FR, RL, RR (all wheels of that corner merged). */
  mounts: number[][];
  /** Mid-cabin low nodes (bending load points), rig-local. */
  midLow: number[];
}

const UNSPRUNG_GROUPS = new Set(['knuckle', 'axle', 'wheelHub', 'wheelRim', 'wheelTire']);
const MOUNT_GROUPS = new Set(['body', 'subframe', 'frame', 'cab', 'bed']);

export function bodyProbe(cv: CompiledVehicle, partsFrom?: CompiledVehicle, clustersOnly = false): BodyProbe {
  const rig = cv.rig;
  const groupOf = (i: number): string => rig.groups[rig.nodeGroup[i]!] ?? '';
  const src = partsFrom ?? cv;
  const shell: number[] = [];
  const parts: [number, number][] = [];
  const used = new Uint8Array(rig.nodeCount);
  for (const c of src.shell) {
    const a = shell.length;
    for (const n of c.nodes) {
      shell.push(n);
      used[n] = 1;
    }
    parts.push([a, shell.length]);
  }
  // nodes the def keeps out of every cluster on purpose (shell `exclude`) are not body structure
  const excl = new Uint8Array(rig.nodeCount);
  // (with `partsFrom`, only ITS body nodes: R-RIG measures an HD rig on the standard car's own structure)
  for (let i = 0; i < src.bodyNodeCount; i++) if (groupOf(i) === 'body' && !used[i]) excl[i] = 1;
  const rest: number[] = [];
  for (let i = 0; i < src.bodyNodeCount; i++) if (excl[i] && !/^arb/.test(rig.nodeIds[i]!)) rest.push(i);
  if ((rest.length >= 12 && !clustersOnly) || parts.length === 0) {
    const a = shell.length;
    shell.push(...rest);
    parts.push([a, shell.length]);
  }
  let zMin = Infinity;
  let zMax = -Infinity;
  let yMax = -Infinity;
  for (const i of shell) {
    zMin = Math.min(zMin, rig.nodePos[3 * i + 2]!);
    zMax = Math.max(zMax, rig.nodePos[3 * i + 2]!);
    yMax = Math.max(yMax, rig.nodePos[3 * i + 1]!);
  }
  const extremity: number[] = [];
  shell.forEach((i, k) => {
    const z = rig.nodePos[3 * i + 2]!;
    const y = rig.nodePos[3 * i + 1]!;
    if (z < zMin + 0.3 || z > zMax - 0.3 || y > yMax - 0.12) extremity.push(k);
  });
  // adjacency
  const adj: number[][] = Array.from({ length: rig.nodeCount }, () => []);
  for (let b = 0; b < rig.beamCount; b++) {
    adj[rig.beamA[b]!]!.push(rig.beamB[b]!);
    adj[rig.beamB[b]!]!.push(rig.beamA[b]!);
  }
  const wheelNode = new Uint8Array(rig.nodeCount);
  for (const w of cv.wheels) for (let i = w.nodeStart; i < w.nodeStart + w.nodeCount; i++) wheelNode[i] = 1;
  const mounts: number[][] = [[], [], [], []];
  for (const w of cv.wheels) {
    const x = rig.nodePos[3 * w.hubI]! + rig.nodePos[3 * w.hubO]!;
    const corner = (w.axle === 'front' ? 0 : 2) + (x > 0 ? 1 : 0);
    const seen = new Set<number>([w.hubI, w.hubO]);
    let frontier = [w.hubI, w.hubO];
    const found = new Set<number>();
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: number[] = [];
      for (const n of frontier)
        for (const m of adj[n]!) {
          if (seen.has(m) || wheelNode[m]) continue;
          seen.add(m);
          const g = groupOf(m);
          if (MOUNT_GROUPS.has(g)) found.add(m);
          else if (UNSPRUNG_GROUPS.has(g)) next.push(m);
        }
      frontier = next;
    }
    // a live axle reaches both sides' mounts: keep this side's half
    for (const m of found) if (Math.sign(rig.nodePos[3 * m]!) === Math.sign(x) || Math.abs(rig.nodePos[3 * m]!) < 0.05) mounts[corner]!.push(m);
  }
  for (const m of mounts) m.sort((a, b) => a - b);
  // mid-cabin low nodes: shell nodes within 0.35 m of the wheelbase centre, in the lowest 0.15 m of them
  const zs = cv.wheels.map((w) => rig.nodePos[3 * w.hubI + 2]!);
  const zc = (Math.min(...zs) + Math.max(...zs)) / 2;
  const near = shell.filter((i) => Math.abs(rig.nodePos[3 * i + 2]! - zc) < 0.35);
  const yLow = Math.min(...near.map((i) => rig.nodePos[3 * i + 1]!));
  const midLow = near.filter((i) => rig.nodePos[3 * i + 1]! < yLow + 0.15);
  return { shell, parts, extremity, mounts, midLow };
}

// ------------------------------------------------------------ rigid fit
/** Polar decomposition rotation of a 3×3 (row-major) by Newton iteration R ← ½(R + R⁻ᵀ). */
export function polarRotation(a: Float64Array, out: Float64Array): void {
  let n = 0;
  for (let i = 0; i < 9; i++) n += a[i]! * a[i]!;
  n = Math.sqrt(n / 3) || 1;
  const r = new Float64Array(9);
  for (let i = 0; i < 9; i++) r[i] = a[i]! / n;
  for (let it = 0; it < 30; it++) {
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = r as unknown as number[];
    // cofactor matrix C; R⁻ᵀ = C / det
    const c0 = m4! * m8! - m5! * m7!;
    const c1 = -(m3! * m8! - m5! * m6!);
    const c2 = m3! * m7! - m4! * m6!;
    const c3 = -(m1! * m8! - m2! * m7!);
    const c4 = m0! * m8! - m2! * m6!;
    const c5 = -(m0! * m7! - m1! * m6!);
    const c6 = m1! * m5! - m2! * m4!;
    const c7 = -(m0! * m5! - m2! * m3!);
    const c8 = m0! * m4! - m1! * m3!;
    const det = m0! * c0 + m1! * c1 + m2! * c2;
    const c = [c0, c1, c2, c3, c4, c5, c6, c7, c8];
    let d = 0;
    for (let i = 0; i < 9; i++) {
      const v = 0.5 * (r[i]! + c[i]! / det);
      d += Math.abs(v - r[i]!);
      r[i] = v;
    }
    if (d < 1e-14) break;
  }
  out.set(r);
}

export interface FlexFrame {
  /** Max |residual| over the shell / the extremity nodes, m. */
  maxAll: number;
  maxExt: number;
  rmsAll: number;
}

/** Residual of the current shell positions against the rigid best fit of `ref` (shell-ordered xyz). */
export function rigidResidual(eng: SimEngine, nodeStart: number, shell: readonly number[], ext: readonly number[], ref: Float64Array, resid?: Float64Array): FlexFrame {
  const s = eng.state;
  const n = shell.length;
  let cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0;
  for (let k = 0; k < n; k++) {
    const i = nodeStart + shell[k]!;
    cx += s.posX[i]!; cy += s.posY[i]!; cz += s.posZ[i]!;
    rx += ref[3 * k]!; ry += ref[3 * k + 1]!; rz += ref[3 * k + 2]!;
  }
  cx /= n; cy /= n; cz /= n; rx /= n; ry /= n; rz /= n;
  const a = new Float64Array(9);
  for (let k = 0; k < n; k++) {
    const i = nodeStart + shell[k]!;
    const p = [s.posX[i]! - cx, s.posY[i]! - cy, s.posZ[i]! - cz];
    const q = [ref[3 * k]! - rx, ref[3 * k + 1]! - ry, ref[3 * k + 2]! - rz];
    for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) a[3 * u + v]! += p[u]! * q[v]!;
  }
  const R = new Float64Array(9);
  polarRotation(a, R);
  let maxAll = 0, maxExt = 0, sum = 0;
  const isExt = new Uint8Array(n);
  for (const e of ext) isExt[e] = 1;
  for (let k = 0; k < n; k++) {
    const i = nodeStart + shell[k]!;
    const qx = ref[3 * k]! - rx, qy = ref[3 * k + 1]! - ry, qz = ref[3 * k + 2]! - rz;
    const gx = cx + R[0]! * qx + R[1]! * qy + R[2]! * qz;
    const gy = cy + R[3]! * qx + R[4]! * qy + R[5]! * qz;
    const gz = cz + R[6]! * qx + R[7]! * qy + R[8]! * qz;
    const dx = s.posX[i]! - gx, dy = s.posY[i]! - gy, dz = s.posZ[i]! - gz;
    if (resid) { resid[3 * k] = dx; resid[3 * k + 1] = dy; resid[3 * k + 2] = dz; }
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sum += d * d;
    if (d > maxAll) maxAll = d;
    if (isExt[k] && d > maxExt) maxExt = d;
  }
  return { maxAll, maxExt, rmsAll: Math.sqrt(sum / n) };
}

/** rigidResidual per part (each fitted on its own), resid in shell order; max / ext over all parts. */
export function partsResidual(eng: SimEngine, nodeStart: number, p: BodyProbe, ref: Float64Array, resid?: Float64Array): FlexFrame {
  let maxAll = 0;
  let maxExt = 0;
  let sum = 0;
  const isExt = new Uint8Array(p.shell.length);
  for (const e of p.extremity) isExt[e] = 1;
  for (const [a, b] of p.parts) {
    if (b - a < 4) continue;
    const nodes = p.shell.slice(a, b);
    const ext: number[] = [];
    for (let k = a; k < b; k++) if (isExt[k]) ext.push(k - a);
    const r = resid ? new Float64Array((b - a) * 3) : undefined;
    const f = rigidResidual(eng, nodeStart, nodes, ext, ref.subarray(3 * a, 3 * b), r);
    if (resid && r) resid.set(r, 3 * a);
    maxAll = Math.max(maxAll, f.maxAll);
    maxExt = Math.max(maxExt, f.maxExt);
    sum += f.rmsAll * f.rmsAll * (b - a);
  }
  return { maxAll, maxExt, rmsAll: Math.sqrt(sum / Math.max(1, p.shell.length)) };
}

export function captureShell(eng: SimEngine, nodeStart: number, shell: readonly number[], out?: Float64Array): Float64Array {
  const s = eng.state;
  const r = out ?? new Float64Array(shell.length * 3);
  shell.forEach((i, k) => {
    r[3 * k] = s.posX[nodeStart + i]!;
    r[3 * k + 1] = s.posY[nodeStart + i]!;
    r[3 * k + 2] = s.posZ[nodeStart + i]!;
  });
  return r;
}

// ------------------------------------------------------------ static stiffness
function zeroGEngine(def: VehicleDef): { eng: SimEngine; cv: CompiledVehicle; start: number } {
  const eng = new SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(-50, MaterialId.asphalt);
  const obj = eng.spawnVehicle(1, def, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { gearSelect: 0 });
  return { eng, cv: eng.getVehicle(1)!.vehicle, start: obj.nodeStart };
}

function dampedSteps(eng: SimEngine, start: number, count: number, ticks: number, damp: number, force?: (s: SimEngine['state']) => void): void {
  const s = eng.state;
  for (let t = 0; t < ticks; t++) {
    if (force) force(s);
    eng.step();
    for (let i = start; i < start + count; i++) {
      s.velX[i]! *= 1 - damp;
      s.velY[i]! *= 1 - damp;
      s.velZ[i]! *= 1 - damp;
    }
  }
}

function pin(s: SimEngine['state'], idx: number): void {
  s.invMass[idx] = 0;
  s.velX[idx] = 0;
  s.velY[idx] = 0;
  s.velZ[idx] = 0;
}

export interface TorsionResult {
  /** N·m per degree. */
  stiffness: number;
  twistDeg: number;
  torque: number;
}

/** Rear mounts pinned, torque `torque` N·m applied as a vertical couple on the front mounts. */
export function runTorsion(def: VehicleDef, torque = 3000): TorsionResult {
  const { eng, cv, start } = zeroGEngine(def);
  const p = bodyProbe(cv);
  const s = eng.state;
  for (const m of [...p.mounts[2]!, ...p.mounts[3]!]) pin(s, start + m);
  const n = eng.arena.get(1)!.nodeCount;
  dampedSteps(eng, start, n, 1000, 0.01);
  const fl = p.mounts[0]!.map((m) => start + m);
  const fr = p.mounts[1]!.map((m) => start + m);
  const y0 = (ids: number[]): number => ids.reduce((a, i) => a + s.posY[i]!, 0) / ids.length;
  const x0 = (ids: number[]): number => ids.reduce((a, i) => a + s.posX[i]!, 0) / ids.length;
  const yl0 = y0(fl);
  const yr0 = y0(fr);
  const arm = x0(fr) - x0(fl);
  // couple: +F on the left mounts, −F on the right (spread per node), torque = F·arm
  const F = torque / arm;
  const ramp = 600;
  let tick = 0;
  dampedSteps(eng, start, n, 4000, 0.01, (st) => {
    const f = F * Math.min(1, tick++ / ramp);
    for (const i of fl) st.velY[i]! += (f / fl.length) * st.invMass[i]! * SIM_DT;
    for (const i of fr) st.velY[i]! -= (f / fr.length) * st.invMass[i]! * SIM_DT;
  });
  const twist = Math.atan2(y0(fl) - yl0 - (y0(fr) - yr0), arm);
  const twistDeg = (twist * 180) / Math.PI;
  return { stiffness: torque / twistDeg, twistDeg, torque };
}

export interface BendingResult {
  /** N per mm at the load points. */
  stiffness: number;
  deflectionMm: number;
}

export function runBending(def: VehicleDef, load = 4000): BendingResult {
  const { eng, cv, start } = zeroGEngine(def);
  const p = bodyProbe(cv);
  const s = eng.state;
  for (const c of p.mounts) for (const m of c) pin(s, start + m);
  const n = eng.arena.get(1)!.nodeCount;
  dampedSteps(eng, start, n, 1000, 0.01);
  const ids = p.midLow.map((m) => start + m);
  const y0 = ids.reduce((a, i) => a + s.posY[i]!, 0) / ids.length;
  let tick = 0;
  dampedSteps(eng, start, n, 4000, 0.01, (st) => {
    const f = (load / ids.length) * Math.min(1, tick++ / 600);
    for (const i of ids) st.velY[i]! -= f * st.invMass[i]! * SIM_DT;
  });
  const y1 = ids.reduce((a, i) => a + s.posY[i]!, 0) / ids.length;
  const d = (y0 - y1) * 1000;
  return { stiffness: load / d, deflectionMm: d };
}

// ------------------------------------------------------------ modes
/** Amplitude spectrum peak (Hz) of a uniformly sampled series between fLo and fHi. */
export function spectrumPeak(x: ArrayLike<number>, hz: number, fLo: number, fHi: number, df = 0.25): { f: number; amp: number } {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  let best = 0;
  let bestF = NaN;
  for (let f = fLo; f <= fHi; f += df) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / hz;
    for (let i = 0; i < n; i++) {
      const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const v = (x[i]! - mean) * h;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    const a = Math.sqrt(re * re + im * im);
    if (a > best) {
      best = a;
      bestF = f;
    }
  }
  return { f: bestF, amp: best };
}

export interface ModesResult {
  /** Spectrum peak (Hz) of the twist / bend deformation coordinate (rigid motion removed). */
  torsionHz: number;
  bendingHz: number;
  /** Deformation coordinates over time (2 kHz): twist deg, bend mm. */
  twist: Float64Array;
  bend: Float64Array;
  /** Time for the twist / bend envelope to fall below 10 % of its peak, s (NaN = never in the record). */
  torsionDecayS: number;
  bendDecayS: number;
}

function decayTime(x: Float64Array, hz: number): number {
  let peak = 0;
  const win = Math.round(hz * 0.01);
  const env: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let a = 0;
    for (let j = i; j < i + win; j++) a = Math.max(a, Math.abs(x[j]!));
    env.push(a);
    peak = Math.max(peak, a);
  }
  // last window index whose envelope is still ≥ 10 % of the peak
  let last = -1;
  for (let k = 0; k < env.length; k++) if (env[k]! >= 0.1 * peak) last = k;
  return last + 1 < env.length ? ((last + 1) * win) / hz : NaN;
}

/**
 * Free-free modal tap: gravity off, no ground contact, the shell given a
 * twist (roll rate ∝ z) or bend (ends vs middle) velocity field of a few
 * cm/s; the deformation is the shell's residual from its rigid best fit,
 * projected on the twist (front roll − rear roll of the residual) and bend
 * (middle − ends) shapes.
 */
export function runModes(def: VehicleDef, durationS = 1.0, fLo = 3, measureAs?: VehicleDef, clustersOnly = false): ModesResult {
  const partsFrom = measureAs ? compileVehicle(measureAs) : undefined;
  const out: number[][] = [];
  for (const kind of ['twist', 'bend'] as const) {
    const { eng, cv, start } = zeroGEngine(def);
    const p = bodyProbe(cv, partsFrom, clustersOnly);
    const s = eng.state;
    const n = eng.arena.get(1)!.nodeCount;
    dampedSteps(eng, start, n, 1000, 0.01);
    const ref = captureShell(eng, start, p.shell);
    const rig = cv.rig;
    const zs = p.shell.map((i) => rig.nodePos[3 * i + 2]!);
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    const zc = (zMin + zMax) / 2;
    const half = (zMax - zMin) / 2;
    for (let i = 0; i < cv.bodyNodeCount; i++) {
      const x = rig.nodePos[3 * i]!;
      const u = (rig.nodePos[3 * i + 2]! - zc) / half;
      if (kind === 'twist') s.velY[start + i] = 0.1 * x * u;
      else s.velY[start + i] = 0.03 * (1 - 2 * u * u);
    }
    // shape weights over shell nodes
    const wTw: number[] = [];
    const wBd: number[] = [];
    for (const i of p.shell) {
      const x = rig.nodePos[3 * i]!;
      const u = (rig.nodePos[3 * i + 2]! - zc) / half;
      wTw.push(x * u);
      wBd.push(1 - 2 * u * u);
    }
    const nTw = wTw.reduce((a, v) => a + v * v, 0);
    const nBd = wBd.reduce((a, v) => a + v * v, 0);
    const resid = new Float64Array(p.shell.length * 3);
    const series: number[] = [];
    const ticks = Math.round(durationS * SIM_HZ);
    for (let t = 0; t < ticks; t++) {
      eng.step();
      partsResidual(eng, start, p, ref, resid);
      let a = 0;
      for (let k = 0; k < p.shell.length; k++) a += (kind === 'twist' ? wTw[k]! : wBd[k]!) * resid[3 * k + 1]!;
      // twist: least-squares coefficient of y = θ'·x·u → angle per half length (deg); bend: mm at the shape peak
      series.push(kind === 'twist' ? ((a / nTw) * 180) / Math.PI : (a / nBd) * 1000);
    }
    out.push(series);
  }
  const twist = Float64Array.from(out[0]!);
  const bend = Float64Array.from(out[1]!);
  const tp = spectrumPeak(twist, SIM_HZ, fLo, 200, 0.5);
  const bp = spectrumPeak(bend, SIM_HZ, fLo, 200, 0.5);
  return { torsionHz: tp.f, bendingHz: bp.f, twist, bend, torsionDecayS: decayTime(twist, SIM_HZ), bendDecayS: decayTime(bend, SIM_HZ) };
}

// ------------------------------------------------------------ driving loads
export interface DriveTrace {
  t: number[];
  /** Max extremity / all-shell deflection, mm. */
  ext: number[];
  all: number[];
  /** CG longitudinal acceleration (vehicle forward), m/s², sampled at `hz`. */
  lonAcc: number[];
  /** Shell (sprung body) COM longitudinal acceleration, m/s². */
  bodyLonAcc: number[];
  /** Shell COM vertical acceleration, m/s². */
  bodyVertAcc: number[];
  speed: number[];
  gear: number[];
  latG: number[];
  /** Drivetrain channels (rpm, applied throttle, tcCut, clutchTorque, driveTorque, driven ω, driven slip ratio, clutch). */
  dt: Record<string, number[]>;
  hz: number;
}

export interface DriveResult {
  maxExtMm: number;
  maxAllMm: number;
  /** Most shell-cluster nodes released (weight < 1) at any sample (driving loads must release none). */
  maxReleased: number;
  /** Beams broken at the end (driving loads, kerbs and drops must break none — glass included). */
  broken: number;
  trace: DriveTrace;
}

export type DriveKind = 'launch' | 'brake' | 'corner' | 'curb';

export interface DriveOptions {
  /** Corner: lateral demand, g (default 0.9). */
  latG?: number;
  /** Corner speed, km/h (default 70). */
  cornerKmh?: number;
  /** Launch duration, s (default 6). */
  launchS?: number;
  /** Curb height, m (default 0.08). */
  curbH?: number;
  curbKmh?: number;
  /** Measure with this def's shell-cluster partition (e.g. the shell-on def while running with shell: false). */
  measureAs?: VehicleDef;
  /** Measure the shell clusters only (leave out body nodes in no cluster, e.g. a ladder frame). */
  clustersOnly?: boolean;
}

function settle(sim: HandlingSim, s: number): void {
  for (let i = 0; i < Math.round(s * SIM_HZ); i++) sim.eng.step();
}

/**
 * One driving-load scenario. The reference shape is the shell's mean pose
 * over the last 0.2 s of a 2 s settle at rest (static sag excluded).
 */
export function runDrive(def: VehicleDef, kind: DriveKind, opts: DriveOptions = {}): DriveResult {
  const sim = createHandlingSim({ def });
  const cv = sim.cv;
  const p = bodyProbe(cv, opts.measureAs ? compileVehicle(opts.measureAs) : undefined, opts.clustersOnly);
  const start = sim.obj.nodeStart;
  sim.eng.setInput(sim.objectId, { gearSelect: 0, throttle: 0, brake: 0, steer: 0 });
  settle(sim, 1.8);
  const ref = new Float64Array(p.shell.length * 3);
  const tmp = new Float64Array(p.shell.length * 3);
  const nAvg = 40;
  for (let k = 0; k < nAvg; k++) {
    for (let j = 0; j < 10; j++) sim.eng.step();
    captureShell(sim.eng, start, p.shell, tmp);
    for (let i = 0; i < ref.length; i++) ref[i]! += tmp[i]! / nAvg;
  }
  const hz = 1000;
  const every = SIM_HZ / hz;
  const trace: DriveTrace = { t: [], ext: [], all: [], lonAcc: [], bodyLonAcc: [], bodyVertAcc: [], speed: [], gear: [], latG: [], dt: { rpm: [], thr: [], tcCut: [], clutchT: [], driveT: [], omegaDriven: [], slipDriven: [], clutch: [], loadF: [], loadR: [] }, hz };
  let control: (t: number, sp: number, latG: number) => Record<string, number>;
  let duration: number;
  const zs = def.wheels.map((w) => (w.hubInner[2] + w.hubOuter[2]) / 2);
  const wheelbase = Math.max(...zs) - Math.min(...zs);
  const maxWheel = (def.steering.maxWheelAngleDeg * Math.PI) / 180;
  if (kind === 'launch') {
    duration = opts.launchS ?? 6;
    control = () => ({ gearSelect: 1, throttle: 1, brake: 0, steer: 0 });
  } else if (kind === 'brake') {
    setMotion(sim, 100 / 3.6, 0);
    duration = 5;
    control = (t) => ({ gearSelect: 0, throttle: 0, brake: t > 0.3 ? 1 : 0, steer: 0 });
  } else if (kind === 'corner') {
    const v0 = (opts.cornerKmh ?? 70) / 3.6;
    setMotion(sim, v0);
    const target = opts.latG ?? 0.9;
    let steerI = 0;
    let thrI = 0;
    let yawF = 0;
    duration = 7;
    control = (t, sp) => {
      const demand = 9.81 * Math.min(target, 0.4 * Math.max(0, t - 0.3));
      const v = Math.max(3, sp);
      const kT = demand / (v * v);
      const yr = trace.latG.length ? (trace.latG[trace.latG.length - 1]! * 9.81) / v : 0;
      yawF += (yr / v - yawF) * 0.05;
      const err = kT - yawF;
      const g = wheelbase / maxWheel;
      steerI = Math.min(1, Math.max(-1, steerI + 0.8 * g * err * 0.01));
      const steer = Math.min(1, Math.max(-1, g * kT + steerI + 0.4 * g * err));
      const ev = v0 - sp;
      thrI = Math.min(1, Math.max(0, thrI + 0.08 * ev * 0.01));
      return { gearSelect: 1, throttle: Math.min(1, Math.max(0, 0.15 + 0.35 * ev + thrI)), brake: 0, steer };
    };
  } else {
    // curb: a box under the LEFT wheels only, 0.6 m long, 8 cm high, 6 m ahead of the front axle
    const h = opts.curbH ?? 0.08;
    const k = kinematics(sim);
    const zFront = Math.min(...zs);
    const xs = def.wheels.map((w) => (w.hubInner[0] + w.hubOuter[0]) / 2);
    const xl = Math.min(...xs);
    const curb: ColliderDef = {
      id: 'curb',
      kind: 'box',
      pos: [xl, h / 2, k.cz + zFront - 6],
      quat: [0, 0, 0, 1],
      size: [0.35, h / 2, 0.3],
      material: MaterialId.concrete,
    };
    sim.eng.setExtraColliders([curb]);
    setMotion(sim, (opts.curbKmh ?? 50) / 3.6);
    duration = 2.5;
    control = () => ({ gearSelect: 1, throttle: 0.25, brake: 0, steer: 0 });
  }
  const total = Math.round(duration * SIM_HZ);
  let maxReleased = 0;
  const countReleased = (): number => {
    let n = 0;
    for (const c of sim.veh.shell ?? []) for (let k = 0; k < c.w.length; k++) if (c.w[k]! < 1) n++;
    return n;
  };
  let prevV: [number, number, number] | null = null;
  let prevB: [number, number, number] | null = null;
  const st = sim.eng.state;
  const shellVel = (): [number, number, number] => {
    let m = 0, x = 0, y = 0, z = 0;
    for (const i of p.shell) {
      const mi = 1 / st.invMass[start + i]!;
      m += mi;
      x += mi * st.velX[start + i]!;
      y += mi * st.velY[start + i]!;
      z += mi * st.velZ[start + i]!;
    }
    return [x / m, y / m, z / m];
  };
  let prevYaw = NaN;
  let latG = 0;
  for (let tick = 0; tick < total; tick++) {
    if (tick % 20 === 0) {
      const k = kinematics(sim);
      const sp = k.vx * k.fx + k.vz * k.fz;
      sim.eng.setInput(sim.objectId, control(tick * SIM_DT, sp, latG));
    }
    sim.eng.step();
    if ((tick + 1) % every !== 0) continue;
    maxReleased = Math.max(maxReleased, countReleased());
    const k = kinematics(sim);
    const f = partsResidual(sim.eng, start, p, ref);
    const yaw = Math.atan2(k.fx, -k.fz);
    let lon = 0;
    if (prevV) {
      const ax = (k.vx - prevV[0]) * hz;
      const az = (k.vz - prevV[2]) * hz;
      lon = ax * k.fx + az * k.fz;
      let dy = yaw - prevYaw;
      if (dy > Math.PI) dy -= 2 * Math.PI;
      if (dy < -Math.PI) dy += 2 * Math.PI;
      const sp = Math.hypot(k.vx, k.vz);
      latG += ((sp * dy * hz) / 9.81 - latG) * 0.02;
    }
    const bv = shellVel();
    if (prevB) {
      trace.bodyLonAcc.push(((bv[0] - prevB[0]) * k.fx + (bv[2] - prevB[2]) * k.fz) * hz);
      trace.bodyVertAcc.push((bv[1] - prevB[1]) * hz);
    } else {
      trace.bodyLonAcc.push(0);
      trace.bodyVertAcc.push(0);
    }
    prevB = bv;
    prevV = [k.vx, k.vy, k.vz];
    prevYaw = yaw;
    trace.t.push((tick + 1) * SIM_DT);
    trace.ext.push(f.maxExt * 1000);
    trace.all.push(f.maxAll * 1000);
    trace.lonAcc.push(lon);
    trace.speed.push(k.vx * k.fx + k.vz * k.fz);
    trace.gear.push(sim.veh.drivetrain.gear);
    trace.latG.push(latG);
    const d = sim.veh.drivetrain as DrivetrainStateEx;
    const ch = trace.dt;
    ch.rpm!.push(d.rpm);
    ch.thr!.push(d.throttle);
    ch.tcCut!.push(d.tcCut);
    ch.clutchT!.push(d.clutchTorque);
    ch.driveT!.push(d.driveTorque);
    ch.clutch!.push(d.clutch);
    let om = 0, sl = 0, nd = 0, lf = 0, lr = 0;
    for (const w of sim.veh.wheels) {
      if (w.wheel.axle === 'front') lf += w.load; else lr += w.load;
      if (!w.wheel.driven) continue;
      om += w.omega; sl += w.slipRatio; nd++;
    }
    ch.omegaDriven!.push(om / nd);
    ch.slipDriven!.push(sl / nd);
    ch.loadF!.push(lf);
    ch.loadR!.push(lr);
  }
  let maxExt = 0;
  let maxAll = 0;
  for (let i = 0; i < trace.ext.length; i++) {
    maxExt = Math.max(maxExt, trace.ext[i]!);
    maxAll = Math.max(maxAll, trace.all[i]!);
  }
  let broken = 0;
  const b0 = sim.obj.beamStart;
  for (let b = 0; b < sim.obj.beamCount; b++) if (sim.eng.state.active[b0 + b] === 0) broken++;
  return { maxExtMm: maxExt, maxAllMm: maxAll, maxReleased, broken, trace };
}

export interface DropResult {
  broken: number;
  maxReleased: number;
}

/** Spawn drop: released `heightM` above the ground (a teleport / spawn), settled 2 s. */
export function runDrop(def: VehicleDef, heightM = 0.5): DropResult {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, MaterialId.asphalt);
  const obj = eng.spawnVehicle(1, def, { pos: [0, heightM, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { gearSelect: 0 });
  const veh = eng.getVehicle(1)!;
  let maxReleased = 0;
  for (let t = 0; t < 2 * SIM_HZ; t++) {
    eng.step();
    if (t % 20 === 0) {
      let n = 0;
      for (const c of veh.shell ?? []) for (let k = 0; k < c.w.length; k++) if (c.w[k]! < 1) n++;
      maxReleased = Math.max(maxReleased, n);
    }
  }
  let broken = 0;
  for (let b = 0; b < obj.beamCount; b++) if (eng.state.active[obj.beamStart + b] === 0) broken++;
  return { broken, maxReleased };
}

/** Time after the peak until the trace stays below `frac` × peak (and ≤ floor), s; 0 if it never rises above floor. */
export function settleTime(t: readonly number[], x: readonly number[], frac = 0.2, floorMm = 0.5): number {
  let iPeak = 0;
  for (let i = 1; i < x.length; i++) if (x[i]! > x[iPeak]!) iPeak = i;
  const lim = Math.max(frac * x[iPeak]!, floorMm);
  let last = iPeak;
  for (let i = iPeak; i < x.length; i++) if (x[i]! > lim) last = i;
  return x[iPeak]! <= floorMm ? 0 : t[last]! - t[iPeak]!;
}

/** Compiled probe for a def (convenience). */
export function probeOf(def: VehicleDef): BodyProbe {
  return bodyProbe(compileVehicle(def));
}
