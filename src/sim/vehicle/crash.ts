/**
 * Headless crash harness (worker-side, test/tool use only; docs/CONTRACTS.md
 * "Crash tuning targets"). Drives a VehicleDef into a rigid static collider
 * in a real SimEngine and measures crush, cabin intrusion, rebound, damage
 * and stability.
 *
 * Set-up: plane ground y = 0 (concrete), the vehicle settled 0.5 s at rest,
 * then every node given the test velocity (wheel rings pre-spun to rolling
 * for frontal tests), no throttle/brake, neutral; 2.0 s simulated after the
 * first contact. Measures use node ids (the vehicle frame; P6: per-vehicle
 * sets in `CrashSpec.probes`, the sedan's ids below are SEDAN_CRASH_PROBES):
 *   crush       rest − final distance between the crash-can tips (mean of
 *               s1_rl_*, s1_rh_*) and the B-pillar floor (s7_fl_*, s7_sl_*),
 *               along the safety cell's long axis (s9 ring → s5 ring).
 *   intrusion   same for the firewall ring (s5_fl_*, s5_sl_*, s5_hp_*, s5_cw_*).
 *   doorIntrusion (side pole) rest − final width s6_dm_R ↔ s6_dm_L.
 *   rebound     peak COM speed away from the barrier after contact ends.
 *
 * Not a hot path (allocates); never imported by the engine.
 */
import { MaterialId } from '../../protocol/messages';
import type { ColliderDef } from '../../world/types';
import { SimEngine, SIM_HZ } from '../engine';
import type { SimObject } from '../types';
import { SEDAN } from './defs/sedan';
import { setMotion, type HandlingSim } from './handling';
import type { CompiledVehicle, VehicleDef, VehicleRuntime } from './types';
import { polar3 } from './shell';

export type CrashKind = 'frontal' | 'offset' | 'pole';

/**
 * P6: the node-id sets a vehicle is measured by (one per VehicleDef; the
 * sedan's are SEDAN_CRASH_PROBES). Patterns as in `nodesMatching` (exact
 * id, or a prefix ending in `*`); beam pairs match either orientation.
 * Every fleet def exports its own probes next to its VehicleDef.
 */
export interface CrashProbes {
  /** Front crush reference (crash-can tips / the frame horns). */
  front: readonly string[];
  /** Cabin reference the crush and intrusion are measured to (B-pillar floor). */
  cabin: readonly string[];
  /** Firewall ring (frontal intrusion). */
  firewall: readonly string[];
  /** Safety-cell long axis: rear ring → front ring (crush is measured along it). */
  cellRear: readonly string[];
  cellFront: readonly string[];
  /** Side pole: the struck door's mid nodes (pole z = their mean) and the door / sill width pairs (single ids). */
  doorMid: readonly string[];
  doorR: string;
  doorL: string;
  sillR: string;
  sillL: string;
  /** Body-node id prefixes of detachable sub-rigs, exempt from the "no node far from its neighbours" span check. */
  exemptPrefixes: readonly string[];
  /** Hood latch beams (a, b) — `latchBroken` = any broken. Empty = no hood (reported false). */
  latch: readonly (readonly [string, string])[];
  /** Front bumper: beams from a node with this prefix to a node without it. */
  bumperPrefix: string;
  /** Windscreen glass beams: from a node with prefix [0] to one with prefix [1]. Empty = none. */
  windscreen: readonly [string, string] | null;
}

export const SEDAN_CRASH_PROBES: CrashProbes = {
  front: ['s1_rl_*', 's1_rh_*'],
  cabin: ['s7_fl_*', 's7_sl_*'],
  firewall: ['s5_fl_*', 's5_sl_*', 's5_hp_*', 's5_cw_*'],
  cellRear: ['s9_*'],
  cellFront: ['s5_*'],
  doorMid: ['s6_dm_*'],
  doorR: 's6_dm_R',
  doorL: 's6_dm_L',
  sillR: 's6_sl_R',
  sillL: 's6_sl_L',
  exemptPrefixes: ['s0_', 's13_', 'hood_'],
  latch: [['hood_0C', 's2_rt']],
  bumperPrefix: 's0_',
  windscreen: ['s5_cw', 's6_rf'],
};

export interface CrashSpec {
  kind: CrashKind;
  speedKmh: number;
  /** Offset frontal: overlap fraction of the body width (struck side = vehicle left). Default 0.4. */
  overlap?: number;
  def?: VehicleDef;
  /** Node sets to measure `def` by (P6). Default SEDAN_CRASH_PROBES. */
  probes?: CrashProbes;
  /** Seconds simulated after first contact. Default 2.0. */
  afterContactS?: number;
  /** Diagnostics: called after every step from the first contact on (`since` = ticks after contact). */
  onStep?: (eng: SimEngine, obj: SimObject, since: number) => void;
}

export interface CrashResult {
  spec: CrashSpec;
  /** Permanent (final) and max dynamic crush, m. */
  crush: number;
  crushMax: number;
  intrusion: number;
  intrusionMax: number;
  /** Side pole: final / max door intrusion, m; also the sill width change. */
  doorIntrusion: number;
  doorIntrusionMax: number;
  sillIntrusion: number;
  /** (crushMax − crush) / crushMax: how much of the peak crush springs back (0 = fully plastic). */
  springback: number;
  /** Peak COM speed away from the barrier, m/s. */
  rebound: number;
  /** Max penetration of any node into the barrier, m. */
  maxPenetration: number;
  finite: boolean;
  /** Max node speed after 1 s, m/s (must stay ≤ the initial speed). */
  maxSpeedLate: number;
  initialSpeed: number;
  /** KE at the end / initial KE. */
  keRatio: number;
  /** Longest beam (both ends non-exempt) at the end, m. */
  maxSpan: number;
  brokenBeams: number;
  /** Body beams plastically deformed (|L0 − L0_orig| > 0.1 %) / body beams (hydros excluded). */
  plasticFraction: number;
  /** Bitmask FL 1, FR 2, RL 4, RR 8. */
  wheelsDetached: number;
  /** Hood centre latch hood_0C–s2_rt broken / any latch broken. */
  latchBroken: boolean;
  /** Fraction of the front bumper's boundary beams (s0_* ↔ rest) broken. */
  bumperBrokenFraction: number;
  /** Fraction of windscreen glass beams (s5_cw* ↔ s6_rf*) broken. */
  windscreenBrokenFraction: number;
  /** Pole: every node stayed on the impact side of the pole axis (else the first offender). */
  poleSideKept: boolean;
  poleViolator: string;
  /** Node id of maxSpeedLate. */
  fastestLateNode: string;
  /** Crush (m) sampled every 5 ms after contact (diagnostics). */
  crushTrace: number[];
  /**
   * Feel pass (additive): SAFETY-CELL shape. Cell = 'body' nodes between the
   * cellFront and cellRear rings (rest z); deviation = distance from the
   * rigid best fit of the pre-impact cell (max over the nodes; side pole:
   * nodes within 0.8 m of the pole axis excluded — the local dent), final /
   * peak; `doorWave` = RMS residual of the side-skin cell nodes after an
   * affine fit of their residual over (y, z) per side (rippling), final.
   */
  cellDev: number;
  cellDevMax: number;
  /** Node id of the final cellDev. */
  cellWorst: string;
  doorWave: number;
}

const G = 9.81;
const SETTLE_S = 0.5;
/** Gap between the vehicle and the barrier at release, m. */
const GAP = 0.03;
const POLE_RADIUS = 0.15;
/** Pole pull-through check: nodes within this distance (along the car) of the pole axis, i.e. inside its footprint (r 0.15 + node radius); nodes farther away may wrap past the axis plane. */
const POLE_NEAR = 0.2;

interface Sim extends HandlingSim {
  eng: SimEngine;
  obj: SimObject;
  veh: VehicleRuntime;
  cv: CompiledVehicle;
}

function createSim(def: VehicleDef): Sim {
  const eng = new SimEngine({
    gravity: [0, -G, 0],
    debugStrains: false,
    capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 },
  });
  eng.setGroundPlane(0, MaterialId.concrete);
  const objectId = 1;
  const obj = eng.spawnVehicle(objectId, def, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  const veh = eng.getVehicle(objectId)!;
  return { eng, obj, veh, cv: veh.vehicle, objectId };
}

/** Node indices (rig-local) matching any of the patterns (`*` = any suffix). */
export function nodesMatching(cv: CompiledVehicle, patterns: readonly string[]): number[] {
  const out: number[] = [];
  const ids = cv.rig.nodeIds;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p))) out.push(i);
  }
  if (out.length === 0) throw new Error(`crash: no nodes match ${patterns.join(', ')}`);
  return out;
}

export function runCrash(spec: CrashSpec): CrashResult {
  const sim = createSim(spec.def ?? SEDAN);
  const { eng, obj, cv, veh } = sim;
  const s = eng.state;
  const n0 = obj.nodeStart;
  const nN = obj.nodeCount;
  const P = (i: number): [number, number, number] => [s.posX[n0 + i]!, s.posY[n0 + i]!, s.posZ[n0 + i]!];
  const mean = (ids: number[]): [number, number, number] => {
    const m: [number, number, number] = [0, 0, 0];
    for (const i of ids) {
      const p = P(i);
      for (let k = 0; k < 3; k++) m[k] = m[k]! + p[k]! / ids.length;
    }
    return m;
  };
  const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

  const pr = spec.probes ?? SEDAN_CRASH_PROBES;
  const tips = nodesMatching(cv, pr.front);
  const bpillar = nodesMatching(cv, pr.cabin);
  const firewall = nodesMatching(cv, pr.firewall);
  const [dmR] = nodesMatching(cv, [pr.doorR]);
  const [dmL] = nodesMatching(cv, [pr.doorL]);
  const [slR] = nodesMatching(cv, [pr.sillR]);
  const [slL] = nodesMatching(cv, [pr.sillL]);

  // Rest references come from the undeformed rig (before settling).
  const restP = (i: number): number[] => [cv.rig.nodePos[3 * i]!, cv.rig.nodePos[3 * i + 1]!, cv.rig.nodePos[3 * i + 2]!];
  const restMean = (ids: number[]): number[] => {
    const m = [0, 0, 0];
    for (const i of ids) for (let k = 0; k < 3; k++) m[k]! += restP(i)[k]! / ids.length;
    return m;
  };
  /**
   * Crush is measured ALONG the vehicle's long axis, taken from the safety
   * cell (s9 rear-bulkhead ring → s5 firewall ring, which stays rigid; a
   * long baseline, insensitive to the cell's small pitch): crash-can tips
   * splayed sideways or folded down do not count as length kept.
   */
  const axial = (a: number[], b: number[], fw: number[]): number => {
    const ux = fw[0]! - b[0]!;
    const uy = fw[1]! - b[1]!;
    const uz = fw[2]! - b[2]!;
    const l = Math.hypot(ux, uy, uz);
    return ((a[0]! - b[0]!) * ux + (a[1]! - b[1]!) * uy + (a[2]! - b[2]!) * uz) / l;
  };
  const cellRear = nodesMatching(cv, pr.cellRear);
  const cellFront = nodesMatching(cv, pr.cellFront);
  const axisNow = (): number[] => {
    const f = mean(cellFront);
    const r = mean(cellRear);
    const b = mean(bpillar);
    return [b[0]! + f[0]! - r[0]!, b[1]! + f[1]! - r[1]!, b[2]! + f[2]! - r[2]!];
  };
  const restAxis = (): number[] => {
    const f = restMean(cellFront);
    const r = restMean(cellRear);
    const b = restMean(bpillar);
    return [b[0]! + f[0]! - r[0]!, b[1]! + f[1]! - r[1]!, b[2]! + f[2]! - r[2]!];
  };
  const crushNow = (): number => crushRest - axial(mean(tips), mean(bpillar), axisNow());
  const crushRest = axial(restMean(tips), restMean(bpillar), restAxis());
  const intrRest = dist(restMean(firewall), restMean(bpillar));
  const doorRest = dist(restP(dmR!), restP(dmL!));
  const sillRest = dist(restP(slR!), restP(slL!));

  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < SETTLE_S * SIM_HZ; t++) eng.step();
  // Safety cell (feel pass): body nodes between the cell rings, pre-impact reference shape.
  const zF = restMean(cellFront)[2]!;
  const zR = restMean(cellRear)[2]!;
  const bodyGroup = cv.rig.groups.indexOf('body');
  const cell: number[] = [];
  for (let i = 0; i < cv.bodyNodeCount; i++) {
    const z = cv.rig.nodePos[3 * i + 2]!;
    if (cv.rig.nodeGroup[i] === bodyGroup && z >= Math.min(zF, zR) - 0.02 && z <= Math.max(zF, zR) + 0.02) cell.push(i);
  }
  const cellRef = cell.map((i) => P(i));

  // Body extent after settling (vehicle frame = world here: identity spawn).
  let minZ = Infinity;
  let maxX = -Infinity;
  let minX = Infinity;
  for (let i = 0; i < cv.bodyNodeCount; i++) {
    const p = P(i);
    const r = s.radius[n0 + i]!;
    minZ = Math.min(minZ, p[2] - r);
    maxX = Math.max(maxX, p[0] + r);
    minX = Math.min(minX, p[0] - r);
  }
  for (let i = cv.bodyNodeCount; i < nN; i++) {
    maxX = Math.max(maxX, P(i)[0] + s.radius[n0 + i]!);
    minX = Math.min(minX, P(i)[0] - s.radius[n0 + i]!);
  }

  const v = spec.speedKmh / 3.6;
  // Barrier + impact direction d (unit, the direction the car travels).
  let barrier: ColliderDef;
  let dir: [number, number, number];
  let poleX = 0;
  let faceZ = 0;
  if (spec.kind === 'pole') {
    const zPole = mean(nodesMatching(cv, pr.doorMid))[2];
    poleX = maxX + GAP + POLE_RADIUS;
    barrier = { id: 'crashPole', kind: 'cylinder', pos: [poleX, 3, zPole], quat: [0, 0, 0, 1], size: [POLE_RADIUS, 3, 0], material: MaterialId.metal };
    dir = [1, 0, 0];
  } else {
    faceZ = minZ - GAP;
    const hz = 0.6;
    if (spec.kind === 'frontal') {
      barrier = { id: 'crashWall', kind: 'box', pos: [0, 1.5, faceZ - hz], quat: [0, 0, 0, 1], size: [6, 1.5, hz], material: MaterialId.concrete };
    } else {
      // Struck side = vehicle left (−X): the barrier covers overlap × body width from the left edge.
      const width = maxX - minX;
      const edge = minX + (spec.overlap ?? 0.4) * width;
      const hx = 4;
      barrier = { id: 'crashWall', kind: 'box', pos: [edge - hx, 1.5, faceZ - hz], quat: [0, 0, 0, 1], size: [hx, 1.5, hz], material: MaterialId.concrete };
    }
    dir = [0, 0, -1];
  }
  eng.setExtraColliders([barrier]);

  // Release: rigid velocity along dir; frontal tests roll the wheels.
  if (spec.kind === 'pole') {
    for (let i = n0; i < n0 + nN; i++) {
      s.velX[i] = v;
      s.velY[i] = 0;
      s.velZ[i] = 0;
    }
  } else {
    setMotion(sim, v, 0);
  }

  let ke0 = 0;
  for (let i = n0; i < n0 + nN; i++) {
    const m = 1 / s.invMass[i]!;
    ke0 += 0.5 * m * (s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2);
  }

  /** Penetration of node i into the barrier (> 0 = inside the contact shell). */
  const penetration = (i: number): number => {
    const p = P(i);
    const r = s.radius[n0 + i]!;
    if (spec.kind === 'pole') {
      const dx = p[0] - poleX;
      const dz = p[2] - barrier.pos[2];
      return r + POLE_RADIUS - Math.hypot(dx, dz);
    }
    const inX = spec.kind === 'frontal' || p[0] <= barrier.pos[0] + barrier.size[0];
    return inX && p[1] < 3 ? r - (p[2] - faceZ) : -Infinity;
  };

  const maxSteps = Math.round((spec.afterContactS ?? 2.0) * SIM_HZ);
  let contactTick = -1;
  let inContact = false;
  let contactEnded = false;
  let crushMax = 0;
  let intrMax = 0;
  let doorMax = 0;
  let rebound = 0;
  let maxPen = 0;
  let maxSpeedLate = 0;
  let poleSideKept = true;
  let poleViolator = '';
  let fastestLateNode = '';
  const crushTrace: number[] = [];
  const comVel = (): number => {
    let m = 0;
    let vd = 0;
    for (let i = n0; i < n0 + nN; i++) {
      const mi = 1 / s.invMass[i]!;
      m += mi;
      vd += mi * (s.velX[i]! * dir[0] + s.velY[i]! * dir[1] + s.velZ[i]! * dir[2]);
    }
    return vd / m;
  };
  let cellDevMax = 0;
  // side pole: the dent region (pre-impact positions within 0.8 m of the pole axis) is not the cell's shape
  const keepSet = new Set(cell.filter((_, k) => spec.kind !== 'pole' || Math.hypot(cellRef[k]![0]! - poleX, cellRef[k]![2]! - barrier.pos[2]) > 0.8));
  const cellKeep = (i: number): boolean => keepSet.has(i);
  const hardCap = maxSteps + SIM_HZ; // contact must start within 1 s
  for (let t = 0; t < hardCap; t++) {
    eng.step();
    let touching = false;
    for (let i = 0; i < nN; i++) {
      const pen = penetration(i);
      if (pen > 0) {
        touching = true;
        if (pen > maxPen) maxPen = pen;
      }
      if (spec.kind === 'pole' && P(i)[0] > poleX && Math.abs(P(i)[2] - barrier.pos[2]) < POLE_NEAR && poleSideKept) {
        poleSideKept = false;
        poleViolator = `${cv.rig.nodeIds[i]!}@${t - contactTick} past ${((P(i)[0] - poleX) * 100).toFixed(1)} cm, dz ${((P(i)[2] - barrier.pos[2]) * 100).toFixed(1)} cm`;
      }
    }
    if (contactTick < 0 && touching) contactTick = t;
    if (contactTick < 0) continue;
    if (touching) inContact = true;
    else if (inContact) contactEnded = true;
    const since = t - contactTick;
    spec.onStep?.(eng, obj, since);
    const crush = crushNow();
    const intr = intrRest - dist(mean(firewall), mean(bpillar));
    const door = doorRest - dist(P(dmR!), P(dmL!));
    if (crush > crushMax) crushMax = crush;
    if (intr > intrMax) intrMax = intr;
    if (door > doorMax) doorMax = door;
    if (since % 10 === 0) crushTrace.push(crush);
    if (since % 20 === 0 && cell.length > 3) cellDevMax = Math.max(cellDevMax, cellFit(cell, cellRef, P, cellKeep).max);
    if (contactEnded) rebound = Math.max(rebound, -comVel());
    if (since >= SIM_HZ) {
      // Body nodes and wheel hubs (a free-spinning wheel's rim/tyre nodes legitimately exceed the car's speed).
      for (let i = n0; i < n0 + nN; i++) {
        if (i - n0 >= cv.bodyNodeCount && !/\.hub[IO]$/.test(cv.rig.nodeIds[i - n0]!)) continue;
        const sp = Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!);
        if (sp > maxSpeedLate) {
          maxSpeedLate = sp;
          fastestLateNode = cv.rig.nodeIds[i - n0]!;
        }
      }
    }
    if (since >= maxSteps) break;
  }
  if (contactTick < 0) throw new Error(`crash ${spec.kind}: no contact within 1 s`);

  // ---- final state
  let finite = true;
  let ke = 0;
  for (let i = n0; i < n0 + nN; i++) {
    for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ]) if (!Number.isFinite(a[i]!)) finite = false;
    const m = 1 / s.invMass[i]!;
    ke += 0.5 * m * (s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2);
  }
  const ids = cv.rig.nodeIds;
  const exempt = (i: number): boolean => i >= cv.bodyNodeCount || pr.exemptPrefixes.some((p) => ids[i]!.startsWith(p));
  const b0 = obj.beamStart;
  let maxSpan = 0;
  let broken = 0;
  let plastic = 0;
  let bodyBeams = 0;
  for (let b = 0; b < cv.rig.beamCount; b++) {
    const g = b0 + b;
    const a = s.aIdx[g]! - n0;
    const c = s.bIdx[g]! - n0;
    if (s.active[g] === 0) broken++;
    if (!exempt(a) && !exempt(c)) maxSpan = Math.max(maxSpan, dist(P(a), P(c)));
    if (b < cv.bodyBeamCount && s.type[g] !== 3) {
      bodyBeams++;
      if (s.active[g] === 0 || Math.abs(s.restLen[g]! - s.restLen0[g]!) > 1e-3 * s.restLen0[g]!) plastic++;
    }
  }
  let detached = 0;
  for (const w of veh.wheels) if (w.detached !== 0) detached |= 1 << w.wheel.corner;

  const beamsWhere = (pred: (a: string, b: string) => boolean): number[] => {
    const out: number[] = [];
    for (let b = 0; b < cv.bodyBeamCount; b++) {
      const a = ids[cv.rig.beamA[b]!]!;
      const c = ids[cv.rig.beamB[b]!]!;
      if (pred(a, c) || pred(c, a)) out.push(b);
    }
    return out;
  };
  const brokenFraction = (list: number[]): number => (list.length === 0 ? 0 : list.filter((b) => s.active[b0 + b] === 0).length / list.length);
  const latch = beamsWhere((a, c) => pr.latch.some(([la, lb]) => a === la && c === lb));
  const bumper = beamsWhere((a, c) => a.startsWith(pr.bumperPrefix) && !c.startsWith(pr.bumperPrefix));
  const ws = pr.windscreen;
  const windscreen = ws ? beamsWhere((a, c) => a.startsWith(ws[0]) && c.startsWith(ws[1])) : [];

  const fit = cell.length > 3 ? cellFit(cell, cellRef, P, cellKeep) : { max: 0, wave: 0, worst: -1 };
  return {
    spec,
    cellDev: fit.max,
    cellWorst: fit.worst >= 0 ? cv.rig.nodeIds[fit.worst]! : '',
    cellDevMax: Math.max(cellDevMax, fit.max),
    doorWave: fit.wave,
    crush: crushNow(),
    springback: crushMax > 0 ? (crushMax - crushNow()) / crushMax : 0,
    crushMax,
    intrusion: intrRest - dist(mean(firewall), mean(bpillar)),
    intrusionMax: intrMax,
    doorIntrusion: doorRest - dist(P(dmR!), P(dmL!)),
    doorIntrusionMax: doorMax,
    sillIntrusion: sillRest - dist(P(slR!), P(slL!)),
    rebound,
    maxPenetration: maxPen,
    finite,
    maxSpeedLate,
    initialSpeed: v,
    keRatio: ke / ke0,
    maxSpan,
    brokenBeams: broken,
    plasticFraction: plastic / bodyBeams,
    wheelsDetached: detached,
    latchBroken: brokenFraction(latch) > 0,
    bumperBrokenFraction: brokenFraction(bumper),
    windscreenBrokenFraction: brokenFraction(windscreen),
    poleSideKept,
    poleViolator,
    fastestLateNode,
    crushTrace,
  };
}

/**
 * Rigid best fit (polar decomposition) of `ref` to the current positions of
 * `ids`: max residual over the nodes passing `keep`, and the side-skin
 * waviness (see CrashResult.doorWave).
 */
function cellFit(ids: number[], ref: number[][], P: (i: number) => [number, number, number], keep: (i: number) => boolean): { max: number; wave: number; worst: number } {
  const n = ids.length;
  const cur = ids.map(P);
  const c = [0, 0, 0];
  const r = [0, 0, 0];
  for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) {
    c[d]! += cur[k]![d]! / n;
    r[d]! += ref[k]![d]! / n;
  }
  const A = new Float64Array(9);
  for (let k = 0; k < n; k++) for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) A[3 * u + v]! += (cur[k]![u]! - c[u]!) * (ref[k]![v]! - r[v]!);
  const R = new Float64Array(9);
  if (!polar3(A, R)) return { max: Infinity, wave: Infinity, worst: -1 };
  const res: number[][] = [];
  let max = 0;
  let worst = -1;
  for (let k = 0; k < n; k++) {
    const q = [ref[k]![0]! - r[0]!, ref[k]![1]! - r[1]!, ref[k]![2]! - r[2]!];
    const e = [0, 1, 2].map((d) => cur[k]![d]! - (c[d]! + R[3 * d]! * q[0]! + R[3 * d + 1]! * q[1]! + R[3 * d + 2]! * q[2]!));
    res.push(e);
    if (keep(ids[k]!) && Math.hypot(e[0]!, e[1]!, e[2]!) > max) {
      max = Math.hypot(e[0]!, e[1]!, e[2]!);
      worst = ids[k]!;
    }
  }
  // side skins: |x| ≥ 0.8·max|x| of the reference, per side; affine fit of each residual component over (1, y, z)
  let xMax = 0;
  for (const p of ref) xMax = Math.max(xMax, Math.abs(p[0]!));
  let sum = 0;
  let cnt = 0;
  for (const side of [-1, 1]) {
    const sel: number[] = [];
    for (let k = 0; k < n; k++) if (ref[k]![0]! * side >= 0.8 * xMax && keep(ids[k]!)) sel.push(k);
    if (sel.length < 4) continue;
    for (let d = 0; d < 3; d++) {
      // normal equations 3×3
      const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const b = [0, 0, 0];
      for (const k of sel) {
        const f = [1, ref[k]![1]!, ref[k]![2]!];
        for (let u = 0; u < 3; u++) {
          b[u]! += f[u]! * res[k]![d]!;
          for (let v = 0; v < 3; v++) M[3 * u + v]! += f[u]! * f[v]!;
        }
      }
      const x = solve3(M, b);
      for (const k of sel) {
        const e = res[k]![d]! - (x[0]! + x[1]! * ref[k]![1]! + x[2]! * ref[k]![2]!);
        sum += e * e;
        cnt++;
      }
    }
  }
  return { max, wave: cnt > 0 ? Math.sqrt((3 * sum) / cnt) : 0, worst };
}

function solve3(m: number[], b: number[]): number[] {
  const det = (a: number[]): number => a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return [0, 0, 0];
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const t = m.slice();
    for (let r = 0; r < 3; r++) t[3 * r + c] = b[r]!;
    out.push(det(t) / d);
  }
  return out;
}

/** One-line summary (reports). */
/**
 * Feel pass: how the crush settles after its peak (crushTrace, 5 ms samples). `final` = mean of the last
 * 0.5 s; `overshoot` = how far the crush springs back below `final`; `ringAfter(t)` = max |crush − final|
 * from t seconds after the peak on (the visible post-crash wobble).
 */
export function crushSettle(trace: readonly number[]): { tPeak: number; final: number; overshoot: number; ringAfter: (t: number) => number } {
  const dt = 0.005;
  let ip = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i]! > trace[ip]!) ip = i;
  const tail = trace.slice(Math.max(0, trace.length - 100));
  const final = tail.reduce((a, b) => a + b, 0) / tail.length;
  let mn = Infinity;
  for (let i = ip; i < trace.length; i++) mn = Math.min(mn, trace[i]!);
  return {
    tPeak: ip * dt,
    final,
    overshoot: Math.max(0, final - mn),
    ringAfter: (t) => {
      let r = 0;
      for (let i = ip + Math.round(t / dt); i < trace.length; i++) r = Math.max(r, Math.abs(trace[i]! - final));
      return r;
    },
  };
}

export function formatCrash(r: CrashResult): string {
  const f = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));
  const cm = (x: number): string => f(x * 100);
  const head = `${r.spec.kind} ${r.spec.speedKmh} km/h`;
  const main =
    r.spec.kind === 'pole'
      ? `door ${cm(r.doorIntrusion)} cm (max ${cm(r.doorIntrusionMax)}), sill ${cm(r.sillIntrusion)} cm, poleSide ${r.poleSideKept}`
      : `crush ${cm(r.crush)} cm (max ${cm(r.crushMax)}, springback ${f(r.springback * 100, 0)} %), intrusion ${cm(r.intrusion)} cm (max ${cm(r.intrusionMax)})`;
  return (
    `${head}: ${main}, rebound ${f(r.rebound, 2)} m/s, pen ${cm(r.maxPenetration)} cm, ` +
    `broken ${r.brokenBeams}, plastic ${f(r.plasticFraction * 100)} %, wheels ${r.wheelsDetached}, ` +
    `latch ${r.latchBroken ? 'broken' : 'held'}, bumper ${f(r.bumperBrokenFraction * 100, 0)} %, ` +
    `windscreen ${f(r.windscreenBrokenFraction * 100, 0)} %, KE ${f(r.keRatio * 100)} %, ` +
    `cell ${cm(r.cellDev)} cm ${r.cellWorst} (max ${cm(r.cellDevMax)}), doorWave ${f(r.doorWave * 1000)} mm, vLate ${f(r.maxSpeedLate, 2)}/${f(r.initialSpeed, 2)} (${r.fastestLateNode})`+(r.poleViolator ? ` poleViolator ${r.poleViolator}` : '')+`, span ${f(r.maxSpan, 2)} m, finite ${r.finite}`
  );
}

