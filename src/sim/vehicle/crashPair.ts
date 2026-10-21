/**
 * R-CRASH two-vehicle crash harness (worker-side, test/tool use only, like crash.ts): two VehicleDefs in
 * one SimEngine on a concrete plane, node-vs-node contact (collision/objects.ts), no barrier.
 *   headon  A drives −Z, B faces A (+Z) and drives toward it; `overlap` < 1 = offset frontal (A's left
 *           side, B's left side — the driver sides meet, as in Euro NCAP MPDB / IIHS car-to-car).
 *   rear    A drives −Z into the rear of B (same heading; B parked or slower), full width.
 *   tbone   A drives −Z into B's right side; B stands across A's path (B forward = −X), the impact point
 *           on B's side at `tbonePoint` (fraction of B's body length from its front; default its cabin).
 * Measures the momentum of the pair along the impact axis before the first contact and after the
 * impact (when the contact impulse ends, or at the end), each car's COM delta-v, the restitution
 * e = −(v_A' − v_B')·d / (v_A − v_B)·d, the deepest cross-object node-sphere overlap (pass-through /
 * gap interlock: a node driven through the other car's skin shows as an overlap of most of r_a + r_b),
 * and per car the crush (its CrashProbes, frontal) and stability. Not a hot path (allocates).
 */
import { MaterialId } from '../../protocol/messages';
import { SimEngine, SIM_HZ } from '../engine';
import { NODE_FLAG_OBJ_CONTACT, type SimObject } from '../types';
import { nodesMatching, SEDAN_CRASH_PROBES, type CrashProbes } from './crash';
import { setMotion } from './handling';
import type { CompiledVehicle, VehicleDef, VehicleRuntime } from './types';

export type PairKind = 'headon' | 'tbone' | 'rear';

export interface PairCar {
  def: VehicleDef;
  probes?: CrashProbes;
  speedKmh: number;
}

export interface PairSpec {
  kind: PairKind;
  a: PairCar;
  b: PairCar;
  /** headon: overlap fraction of the narrower car's width (1 = full). */
  overlap?: number;
  /** rear: B's rear crush reference nodes (default the sedans' s12 rear rail tips). */
  rearTips?: readonly string[];
  /** tbone: impact point on B's side, fraction of B's body length from its front (default 0.45). */
  tbonePoint?: number;
  /** Simulated after the first contact, s (default 1.5). */
  afterContactS?: number;
  /**
   * false = zero gravity, no ground (the cars float into each other): only the contact and the two
   * structures act, so the pair's momentum must be conserved exactly (the momentum-conservation check;
   * on the ground, tyre / scrape friction is a real external impulse). Default true.
   */
  ground?: boolean;
  /** Diagnostics: called every 20 ticks after the first contact with both COM velocities along d. */
  trace?: (ms: number, va: number, vb: number) => void;
  /** Diagnostics: every step from the first contact on. */
  onStep?: (eng: SimEngine, a: SimObject, b: SimObject, since: number) => void;
}

export interface PairCarResult {
  mass: number;
  /** COM velocity along the impact axis d (A's travel direction), m/s: before / after. */
  vBefore: number;
  vAfter: number;
  deltaV: number;
  /** Lateral COM speed after (perpendicular to d, horizontal), m/s. */
  vLateralAfter: number;
  /** Frontal crush (rest − final length of the probe front ↔ cabin, along the cell axis), m. 0 for a struck side. */
  crush: number;
  finite: boolean;
  /** Max body-node / hub speed in the last 0.5 s, m/s. */
  maxSpeedLate: number;
}

export interface PairResult {
  spec: PairSpec;
  a: PairCarResult;
  b: PairCarResult;
  /** Pair momentum along d, N·s: before / after; relErr = |Δ| / (Σ m|v| before). */
  pBefore: number;
  pAfter: number;
  momentumErr: number;
  /**
   * The moment the closing speed along d first reaches zero (maximum engagement, end of the main pulse):
   * both cars' velocities and the plastic-collision ideal (m_a v_a + m_b v_b)/(m_a + m_b) for comparison.
   */
  common: { ms: number; va: number; vb: number; ideal: number };
  restitution: number;
  /** Impact duration (first contact → contact impulse ends), s. */
  contactS: number;
  /** Deepest cross-object node-sphere overlap over the run, m, and the pair. */
  maxOverlap: number;
  overlapPair: string;
  /** Overlap relative to r_a + r_b of that pair (1 = coincident centres). */
  maxOverlapFrac: number;
  /** Cross-object node pairs still overlapping by > half of r_a + r_b at the end. */
  deepPairsEnd: number;
}

interface Car {
  obj: SimObject;
  veh: VehicleRuntime;
  cv: CompiledVehicle;
  objectId: number;
  probes: CrashProbes;
}

const G = 9.81;
const SETTLE_S = 0.5;
const GAP = 0.15;

export function runPairCrash(spec: PairSpec): PairResult {
  const ground = spec.ground ?? true;
  const eng = new SimEngine({ gravity: [0, ground ? -G : 0, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  if (ground) eng.setGroundPlane(0, MaterialId.concrete);
  // spawn far apart, settle, then place by the settled extents
  const spawn = (id: number, car: PairCar, x: number): Car => {
    const obj = eng.spawnVehicle(id, car.def, { pos: [x, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
    const veh = eng.getVehicle(id)!;
    return { obj, veh, cv: veh.vehicle, objectId: id, probes: car.probes ?? SEDAN_CRASH_PROBES };
  };
  const A = spawn(1, spec.a, 0);
  const B = spawn(2, spec.b, 30);
  for (const c of [A, B]) eng.setInput(c.objectId, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  if (ground) for (let t = 0; t < SETTLE_S * SIM_HZ; t++) eng.step();
  const s = eng.state;

  /** Rigidly moves car c: rotate about its frame origin by yaw (from the current, identity heading), then put the origin at (x, z). */
  const transform = (c: Car, yaw: number, x: number, z: number): void => {
    const n0 = c.obj.nodeStart;
    const o = n0 + c.cv.frameNodes[0]!;
    const ox = s.posX[o]!;
    const oz = s.posZ[o]!;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let i = n0; i < n0 + c.obj.nodeCount; i++) {
      const dx = s.posX[i]! - ox;
      const dz = s.posZ[i]! - oz;
      // yaw about +Y: x' = x cos + z sin, z' = −x sin + z cos
      s.posX[i] = x + dx * cs + dz * sn;
      s.posZ[i] = z - dx * sn + dz * cs;
      s.velX[i] = 0;
      s.velY[i] = 0;
      s.velZ[i] = 0;
    }
  };
  const extent = (c: Car): { minX: number; maxX: number; minZ: number; maxZ: number; ox: number; oz: number } => {
    const n0 = c.obj.nodeStart;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = n0; i < n0 + c.obj.nodeCount; i++) {
      if ((s.flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const r = s.objRadius[i]!;
      minX = Math.min(minX, s.posX[i]! - r);
      maxX = Math.max(maxX, s.posX[i]! + r);
      minZ = Math.min(minZ, s.posZ[i]! - r);
      maxZ = Math.max(maxZ, s.posZ[i]! + r);
    }
    const o = n0 + c.cv.frameNodes[0]!;
    return { minX, maxX, minZ, maxZ, ox: s.posX[o]!, oz: s.posZ[o]! };
  };

  transform(A, 0, 0, 0);
  const ea = extent(A);
  if (spec.kind === 'headon') {
    transform(B, Math.PI, 0, 0);
    const eb = extent(B);
    // B's front (now at its max z… B faces +Z after the turn: its front is its MIN z? B forward = +Z, front = max z)
    // A's front is at ea.minZ (forward −Z); B's front must sit GAP ahead of it: B front z = ea.minZ − GAP.
    const wa = ea.maxX - ea.minX;
    const wb = eb.maxX - eb.minX;
    const ov = (spec.overlap ?? 1) * Math.min(wa, wb);
    // offset: the driver (left, −X for A) sides meet; B turned 180° has its left side at +X
    const dx = spec.overlap !== undefined && spec.overlap < 1 ? ea.minX + ov - eb.maxX : (ea.minX + ea.maxX) / 2 - (eb.minX + eb.maxX) / 2;
    const dz = ea.minZ - GAP - eb.maxZ;
    transform(B, 0, eb.ox + dx, eb.oz + dz);
  } else if (spec.kind === 'rear') {
    const eb = extent(B);
    const dx = (ea.minX + ea.maxX) / 2 - (eb.minX + eb.maxX) / 2;
    const dz = ea.minZ - GAP - eb.maxZ;
    transform(B, 0, eb.ox + dx, eb.oz + dz);
  } else {
    // B across A's path, facing −X (yaw +90°): its right side faces +Z (towards A)
    transform(B, Math.PI / 2, 0, 0);
    const eb = extent(B);
    const len = eb.maxX - eb.minX;
    const xHit = eb.minX + (spec.tbonePoint ?? 0.45) * len; // B's front is at min x
    const dx = (ea.minX + ea.maxX) / 2 - xHit;
    const dz = ea.minZ - GAP - eb.maxZ;
    transform(B, 0, eb.ox + dx, eb.oz + dz);
  }
  // let the moved cars sit for a few ms (contacts / shells re-seat), then launch
  for (let t = 0; t < 40; t++) eng.step();
  const sim = (c: Car) => ({ eng, obj: c.obj, veh: c.veh, cv: c.cv, objectId: c.objectId });
  setMotion(sim(A), spec.a.speedKmh / 3.6, 0);
  if (spec.b.speedKmh !== 0) setMotion(sim(B), spec.b.speedKmh / 3.6, 0);

  // impact axis d = A's travel direction (−Z)
  const dX = 0, dZ = -1;
  const com = (c: Car): { m: number; vd: number; vl: number } => {
    let m = 0, vd = 0, vl = 0;
    for (let i = c.obj.nodeStart; i < c.obj.nodeStart + c.obj.nodeCount; i++) {
      const mi = 1 / s.invMass[i]!;
      m += mi;
      vd += mi * (s.velX[i]! * dX + s.velZ[i]! * dZ);
      vl += mi * (s.velX[i]! * -dZ + s.velZ[i]! * dX);
    }
    return { m, vd: vd / m, vl: vl / m };
  };
  const a0 = com(A);
  const b0 = com(B);
  const pBefore = a0.m * a0.vd + b0.m * b0.vd;
  const scale = a0.m * Math.abs(a0.vd) + b0.m * Math.abs(b0.vd);

  // crush reference along each car's own cell axis (frontal: probes front ↔ cabin)
  const crushOf = (c: Car): (() => number) => {
    const P = (i: number): number[] => [s.posX[c.obj.nodeStart + i]!, s.posY[c.obj.nodeStart + i]!, s.posZ[c.obj.nodeStart + i]!];
    const mean = (ids: number[]): number[] => {
      const m = [0, 0, 0];
      for (const i of ids) for (let k = 0; k < 3; k++) m[k]! += P(i)[k]! / ids.length;
      return m;
    };
    const tips = nodesMatching(c.cv, c.probes.front);
    const cab = nodesMatching(c.cv, c.probes.cabin);
    const rear = nodesMatching(c.cv, c.probes.cellRear);
    const front = nodesMatching(c.cv, c.probes.cellFront);
    const len = (): number => {
      const f = mean(front);
      const r = mean(rear);
      const u = [f[0]! - r[0]!, f[1]! - r[1]!, f[2]! - r[2]!];
      const l = Math.hypot(u[0]!, u[1]!, u[2]!);
      const t = mean(tips);
      const b = mean(cab);
      return ((t[0]! - b[0]!) * u[0]! + (t[1]! - b[1]!) * u[1]! + (t[2]! - b[2]!) * u[2]!) / l;
    };
    const l0 = len();
    return () => l0 - len();
  };
  const crushA = crushOf(A);
  const crushB = crushOf(B);
  /** Rear crush of B (rear kind): rest − current distance, along d, from its cabin probes to its rear crash-can tips (`rearTips`, default the sedan's s12 rails). */
  const rearOf = (c: Car, tipsPat: readonly string[]): (() => number) => {
    const n0 = c.obj.nodeStart;
    const cab = nodesMatching(c.cv, c.probes.cabin);
    const tips = nodesMatching(c.cv, tipsPat);
    const len = (): number => {
      let cz = 0;
      for (const i of cab) cz += s.posZ[n0 + i]! / cab.length;
      let rz = 0;
      for (const i of tips) rz += s.posZ[n0 + i]! / tips.length;
      return rz - cz;
    };
    const l0 = len();
    return () => l0 - len();
  };
  const rearB = spec.kind === 'rear' ? rearOf(B, spec.rearTips ?? ['s12_rl_*', 's12_rh_*']) : null;

  // cross-object sphere overlap (every 10 ticks, grid hash of B)
  const nA = A.obj.nodeCount;
  const nB = B.obj.nodeCount;
  const overlap = (): { max: number; frac: number; pair: string; deep: number } => {
    const cell = 0.5;
    const grid = new Map<string, number[]>();
    for (let j = B.obj.nodeStart; j < B.obj.nodeStart + nB; j++) {
      if ((s.flags[j]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const key = `${Math.floor(s.posX[j]! / cell)},${Math.floor(s.posY[j]! / cell)},${Math.floor(s.posZ[j]! / cell)}`;
      let l = grid.get(key);
      if (!l) grid.set(key, (l = []));
      l.push(j);
    }
    let max = 0, frac = 0, deep = 0;
    let pair = '';
    for (let i = A.obj.nodeStart; i < A.obj.nodeStart + nA; i++) {
      if ((s.flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const cx = Math.floor(s.posX[i]! / cell), cy = Math.floor(s.posY[i]! / cell), cz = Math.floor(s.posZ[i]! / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const l = grid.get(`${cx + ox},${cy + oy},${cz + oz}`);
        if (!l) continue;
        for (const j of l) {
          const d = Math.hypot(s.posX[j]! - s.posX[i]!, s.posY[j]! - s.posY[i]!, s.posZ[j]! - s.posZ[i]!);
          const rr = s.objRadius[i]! + s.objRadius[j]!;
          const depth = rr - d;
          if (depth > max) {
            max = depth;
            frac = depth / rr;
            pair = `${A.cv.rig.nodeIds[i - A.obj.nodeStart]} / ${B.cv.rig.nodeIds[j - B.obj.nodeStart]}`;
          }
          if (depth > 0.5 * rr) deep++;
        }
      }
    }
    return { max, frac, pair, deep };
  };

  const maxSteps = Math.round((spec.afterContactS ?? 1.5) * SIM_HZ);
  let contactTick = -1;
  let lastContactTick = -1;
  let maxOverlap = 0;
  let maxOverlapFrac = 0;
  let overlapPair = '';
  let after: { a: ReturnType<typeof com>; b: ReturnType<typeof com> } | null = null;
  let common: PairResult['common'] | null = null;
  const ideal = pBefore / (a0.m + b0.m);
  let quiet = 0;
  const lateMax = [0, 0];
  for (let t = 0; t < maxSteps + SIM_HZ; t++) {
    eng.step();
    const pairs = eng.contacts.pairCount;
    // in contact: any cross pair actually touching (the pair list holds near pairs; test a sample of depths)
    let touching = false;
    if (pairs > 0 && t % 2 === 0) touching = overlapQuick();
    if (touching) {
      if (contactTick < 0) contactTick = t;
      lastContactTick = t;
      quiet = 0;
    } else if (contactTick >= 0) quiet++;
    if (contactTick >= 0) spec.onStep?.(eng, A.obj, B.obj, t - contactTick);
    if (contactTick >= 0 && (t - contactTick) % 20 === 0 && spec.trace) spec.trace((t - contactTick) / 2, com(A).vd, com(B).vd);
    if (contactTick >= 0 && common === null) {
      const ca = com(A);
      const cb = com(B);
      if (ca.vd - cb.vd <= 0) common = { ms: (t - contactTick) / 2, va: ca.vd, vb: cb.vd, ideal };
    }
    if (contactTick >= 0 && t % 10 === 0) {
      const o = overlap();
      if (o.max > maxOverlap) {
        maxOverlap = o.max;
        maxOverlapFrac = o.frac;
        overlapPair = o.pair;
      }
    }
    // after = when the contact impulse has ended (40 ms without touching) or the cars move together
    if (contactTick >= 0 && after === null) {
      const ca = com(A);
      const cb = com(B);
      const sep = quiet > 80;
      const together = t - contactTick > 200 && Math.abs(ca.vd - cb.vd) < 0.05;
      if (sep || together) after = { a: ca, b: cb };
    }
    if (contactTick >= 0 && t - contactTick > maxSteps - SIM_HZ / 2) {
      for (const [k, c] of [A, B].entries()) {
        for (let i = c.obj.nodeStart; i < c.obj.nodeStart + c.obj.nodeCount; i++) {
          if (i - c.obj.nodeStart >= c.cv.bodyNodeCount && !/\.hub[IO]$/.test(c.cv.rig.nodeIds[i - c.obj.nodeStart]!)) continue;
          lateMax[k] = Math.max(lateMax[k]!, Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!));
        }
      }
    }
    if (contactTick >= 0 && t - contactTick >= maxSteps) break;
  }
  if (contactTick < 0) throw new Error('pair crash: no contact');
  if (after === null) after = { a: com(A), b: com(B) };
  const pAfter = after.a.m * after.a.vd + after.b.m * after.b.vd;
  const end = overlap();
  const finiteOf = (c: Car): boolean => {
    for (let i = c.obj.nodeStart; i < c.obj.nodeStart + c.obj.nodeCount; i++) {
      if (!Number.isFinite(s.posX[i]!) || !Number.isFinite(s.velX[i]!) || !Number.isFinite(s.posY[i]!) || !Number.isFinite(s.posZ[i]!)) return false;
    }
    return true;
  };
  const relA = a0.vd - b0.vd;
  return {
    spec,
    a: { mass: a0.m, vBefore: a0.vd, vAfter: after.a.vd, deltaV: after.a.vd - a0.vd, vLateralAfter: after.a.vl, crush: crushA(), finite: finiteOf(A), maxSpeedLate: lateMax[0]! },
    b: { mass: b0.m, vBefore: b0.vd, vAfter: after.b.vd, deltaV: after.b.vd - b0.vd, vLateralAfter: after.b.vl, crush: spec.kind === 'headon' ? crushB() : rearB ? rearB() : 0, finite: finiteOf(B), maxSpeedLate: lateMax[1]! },
    pBefore,
    pAfter,
    momentumErr: Math.abs(pAfter - pBefore) / scale,
    common: common ?? { ms: NaN, va: NaN, vb: NaN, ideal },
    restitution: relA !== 0 ? -(after.a.vd - after.b.vd) / relA : 0,
    contactS: (lastContactTick - contactTick) / SIM_HZ,
    maxOverlap,
    overlapPair,
    maxOverlapFrac,
    deepPairsEnd: end.deep,
  };

  /** Any cross pair within contact (cheap: the engine's pair list is near pairs; test the depth of each). */
  function overlapQuick(): boolean {
    const c = eng.contacts;
    const n = c.pairCount;
    const pa = c.pairA;
    const pb = c.pairB;
    for (let k = 0; k < n; k++) {
      const i = pa[k]!;
      const j = pb[k]!;
      const d = Math.hypot(s.posX[j]! - s.posX[i]!, s.posY[j]! - s.posY[i]!, s.posZ[j]! - s.posZ[i]!);
      if (d < s.objRadius[i]! + s.objRadius[j]!) return true;
    }
    return false;
  }
}

export function formatPair(r: PairResult): string {
  const f = (x: number, d = 2): string => x.toFixed(d);
  const car = (n: string, c: PairCarResult): string =>
    `${n} ${f(c.mass, 0)} kg v ${f(c.vBefore)} → ${f(c.vAfter)} m/s (Δv ${f(c.deltaV)}, lateral ${f(c.vLateralAfter)}), crush ${f(c.crush * 100, 1)} cm, finite ${c.finite}, vLate ${f(c.maxSpeedLate)}`;
  return (
    `${r.spec.kind}${r.spec.overlap !== undefined ? ` ${Math.round(r.spec.overlap * 100)} %` : ''}: ${car('A', r.a)}; ${car('B', r.b)}; ` +
    `p ${f(r.pBefore, 0)} → ${f(r.pAfter, 0)} N·s (err ${f(r.momentumErr * 100, 1)} %), common v at ${f(r.common.ms, 0)} ms ${f(r.common.va)} / ${f(r.common.vb)} (ideal ${f(r.common.ideal)}), ` +
    `e ${f(r.restitution, 3)}, contact ${f(r.contactS * 1000, 0)} ms, ` +
    `overlap max ${f(r.maxOverlap * 100, 1)} cm (${f(r.maxOverlapFrac * 100, 0)} % of r_a + r_b: ${r.overlapPair}), deep pairs at end ${r.deepPairsEnd}`
  );
}
