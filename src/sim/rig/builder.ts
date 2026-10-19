/**
 * Rig compiler + stability validator.
 *
 * PURE DATA MODULE (see docs/CONTRACTS.md boundary amendment): imported by
 * both the worker and main thread. No engine/state/worker imports, no three,
 * no DOM. Not a hot loop, so allocation and Math.* are fine here.
 */
import {
  RIG_BEAM_TYPE_ID,
  RIG_DEFAULTS,
  OBJ_RADIUS_MAX,
  OBJ_RADIUS_MIN,
  OBJ_RADIUS_SPACING_FACTOR,
  RIG_NODE_FLAG_COLLIDABLE,
  RIG_NODE_FLAG_OBJ_CONTACT,
  RIG_NODE_FLAG_TREAD,
  type CompiledRig,
  type RigBeamType,
  type RigDef,
  type RigStats,
  type StabilityReport,
} from './types';

/** Fixed sim step (CLAUDE.md physics budget). */
export const RIG_DT = 1 / 2000;
/** ω·dt budget for structural nodes (headroom for contacts). */
export const STRUCTURE_OMEGA_DT_LIMIT = 0.35;
/** ω·dt hard limit for any node. */
export const GENERAL_OMEGA_DT_LIMIT = 0.5;
/** (Σd/m)·dt limit. */
export const DAMP_DT_LIMIT = 1;
/** Relative slack on limit checks so masses set exactly at the limit pass despite rounding. */
const LIMIT_EPS = 1e-9;
const WORST_COUNT = 8;

/** Thrown by compileRig for malformed definitions. */
export class RigCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RigCompileError';
  }
}

function fail(rig: string, msg: string): never {
  throw new RigCompileError(`compileRig("${rig}"): ${msg}`);
}

function checkFinite(rig: string, where: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(rig, `${where} ${field} must be a finite number (got ${String(v)})`);
  }
  return v;
}

function checkNonNeg(rig: string, where: string, field: string, v: unknown): number {
  const n = checkFinite(rig, where, field, v);
  if (n < 0) fail(rig, `${where} ${field} must be >= 0 (got ${n})`);
  return n;
}

/** Resolves an optional numeric field: undefined → fallback, otherwise must be finite (and >= 0 if nonNeg). */
function opt(
  rig: string,
  where: string,
  field: string,
  v: unknown,
  fallback: number,
  nonNeg: boolean,
): number {
  if (v === undefined) return fallback;
  return nonNeg ? checkNonNeg(rig, where, field, v) : checkFinite(rig, where, field, v);
}

const BEAM_TYPES = Object.keys(RIG_BEAM_TYPE_ID) as RigBeamType[];

/**
 * Resolves a RigDef into typed arrays. Node/beam order is DECLARATION order
 * (frozen canonical ordering). Precedence per node field:
 * node value → groupDefaults[group] → RIG_DEFAULTS. Beams: value → RIG_DEFAULTS.
 * mass <= 0 → pinned (nodeMass 0, invMass 0). deform/breakF <= 0 → Infinity.
 */
export function compileRig(def: RigDef): CompiledRig {
  if (def === null || typeof def !== 'object') {
    throw new RigCompileError('compileRig: definition must be an object');
  }
  const rig = typeof def.name === 'string' ? def.name : '?';
  if (typeof def.name !== 'string' || def.name.length === 0) fail(rig, 'name must be a non-empty string');
  if (!Array.isArray(def.nodes)) fail(rig, 'nodes must be an array');
  if (!Array.isArray(def.beams)) fail(rig, 'beams must be an array');

  const groupDefaults = def.groupDefaults ?? {};
  for (const g of Object.keys(groupDefaults)) {
    const gd = groupDefaults[g];
    if (gd === undefined || gd === null || typeof gd !== 'object') fail(rig, `groupDefaults["${g}"] must be an object`);
    if (gd.friction !== undefined) checkNonNeg(rig, `groupDefaults["${g}"]`, 'friction', gd.friction);
    if (gd.radius !== undefined) checkNonNeg(rig, `groupDefaults["${g}"]`, 'radius', gd.radius);
    if (gd.contactSpring !== undefined) checkNonNeg(rig, `groupDefaults["${g}"]`, 'contactSpring', gd.contactSpring);
  }

  const nodeCount = def.nodes.length;
  const beamCount = def.beams.length;
  const nodeIds: string[] = new Array<string>(nodeCount);
  const nodePos = new Float64Array(nodeCount * 3);
  const nodeMass = new Float64Array(nodeCount);
  const nodeInvMass = new Float64Array(nodeCount);
  const nodeFriction = new Float64Array(nodeCount);
  const nodeRadius = new Float64Array(nodeCount);
  const nodeContactK = new Float64Array(nodeCount);
  const nodeObjRadius = new Float64Array(nodeCount);
  /** Explicit RigNodeDef.objRadius (> 0) or 0 = derive from the incident beams below. */
  const objRadiusDecl = new Float64Array(nodeCount);
  const nodeFlags = new Uint8Array(nodeCount);
  const nodeGroup = new Int32Array(nodeCount);
  const groups: string[] = [];
  const groupIndex = new Map<string, number>();
  const indexOf = new Map<string, number>();

  for (let i = 0; i < nodeCount; i++) {
    const n = def.nodes[i];
    if (n === undefined || n === null || typeof n !== 'object') fail(rig, `node[${i}] must be an object`);
    if (typeof n.id !== 'string' || n.id.length === 0) fail(rig, `node[${i}] id must be a non-empty string`);
    const where = `node[${i}] "${n.id}"`;
    const prev = indexOf.get(n.id);
    if (prev !== undefined) fail(rig, `duplicate node id "${n.id}" at node[${i}] (first declared at node[${prev}])`);
    indexOf.set(n.id, i);
    nodeIds[i] = n.id;

    if (!Array.isArray(n.pos) || n.pos.length !== 3) fail(rig, `${where} pos must be [x, y, z]`);
    nodePos[i * 3] = checkFinite(rig, where, 'pos[0]', n.pos[0]);
    nodePos[i * 3 + 1] = checkFinite(rig, where, 'pos[1]', n.pos[1]);
    nodePos[i * 3 + 2] = checkFinite(rig, where, 'pos[2]', n.pos[2]);

    const mass = checkFinite(rig, where, 'mass', n.mass);
    if (mass > 0) {
      nodeMass[i] = mass;
      nodeInvMass[i] = 1 / mass;
    }

    let gd: { friction?: number; radius?: number; contactSpring?: number } | undefined;
    if (n.group !== undefined) {
      if (typeof n.group !== 'string') fail(rig, `${where} group must be a string`);
      let gi = groupIndex.get(n.group);
      if (gi === undefined) {
        gi = groups.length;
        groups.push(n.group);
        groupIndex.set(n.group, gi);
      }
      nodeGroup[i] = gi;
      gd = groupDefaults[n.group];
    } else {
      nodeGroup[i] = -1;
    }
    nodeFriction[i] = opt(rig, where, 'friction', n.friction, gd?.friction ?? RIG_DEFAULTS.friction, true);
    nodeRadius[i] = opt(rig, where, 'radius', n.radius, gd?.radius ?? RIG_DEFAULTS.radius, true);
    nodeContactK[i] = opt(rig, where, 'contactSpring', n.contactSpring, gd?.contactSpring ?? 0, true);
    if (n.collidable !== undefined && typeof n.collidable !== 'boolean') fail(rig, `${where} collidable must be a boolean`);
    if (n.tread !== undefined && typeof n.tread !== 'boolean') fail(rig, `${where} tread must be a boolean`);
    if (n.objContact !== undefined && typeof n.objContact !== 'boolean') fail(rig, `${where} objContact must be a boolean`);
    objRadiusDecl[i] = opt(rig, where, 'objRadius', n.objRadius, 0, false);
    const objContact = n.objContact ?? n.collidable !== false;
    nodeFlags[i] =
      (n.collidable === false ? 0 : RIG_NODE_FLAG_COLLIDABLE) |
      (n.tread === true ? RIG_NODE_FLAG_TREAD : 0) |
      (objContact ? RIG_NODE_FLAG_OBJ_CONTACT : 0);
  }

  const beamA = new Int32Array(beamCount);
  const beamB = new Int32Array(beamCount);
  const beamType = new Uint8Array(beamCount);
  const beamRestLen = new Float64Array(beamCount);
  const beamK = new Float64Array(beamCount);
  const beamD = new Float64Array(beamCount);
  const beamDeform = new Float64Array(beamCount);
  const beamBreakF = new Float64Array(beamCount);
  const beamBoundsLow = new Float64Array(beamCount);
  const beamBoundsHigh = new Float64Array(beamCount);
  const beamPreload = new Float64Array(beamCount);
  const beamHydroTravel = new Float64Array(beamCount);

  for (let i = 0; i < beamCount; i++) {
    const b = def.beams[i];
    if (b === undefined || b === null || typeof b !== 'object') fail(rig, `beam[${i}] must be an object`);
    const where = `beam[${i}] (${String(b.a)}-${String(b.b)})`;
    const ia = indexOf.get(b.a);
    if (ia === undefined) fail(rig, `${where} references unknown node "${String(b.a)}" (endpoint a)`);
    const ib = indexOf.get(b.b);
    if (ib === undefined) fail(rig, `${where} references unknown node "${String(b.b)}" (endpoint b)`);
    if (ia === ib) fail(rig, `${where} connects node "${b.a}" to itself`);
    if (!BEAM_TYPES.includes(b.type)) fail(rig, `${where} has unknown type "${String(b.type)}"`);
    beamA[i] = ia;
    beamB[i] = ib;
    beamType[i] = RIG_BEAM_TYPE_ID[b.type];

    const dx = nodePos[ib * 3]! - nodePos[ia * 3]!;
    const dy = nodePos[ib * 3 + 1]! - nodePos[ia * 3 + 1]!;
    const dz = nodePos[ib * 3 + 2]! - nodePos[ia * 3 + 2]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9)) fail(rig, `${where} has zero rest length (nodes "${b.a}" and "${b.b}" coincide)`);
    beamRestLen[i] = len;

    beamK[i] = opt(rig, where, 'k', b.k, RIG_DEFAULTS.k, true);
    beamD[i] = opt(rig, where, 'd', b.d, RIG_DEFAULTS.d, true);
    const deform = opt(rig, where, 'deform', b.deform, RIG_DEFAULTS.deform, false);
    beamDeform[i] = deform > 0 ? deform : Infinity;
    const breakF = opt(rig, where, 'breakF', b.breakF, RIG_DEFAULTS.breakF, false);
    beamBreakF[i] = breakF > 0 ? breakF : Infinity;
    beamBoundsLow[i] = opt(rig, where, 'boundsLow', b.boundsLow, RIG_DEFAULTS.boundsLow, true);
    beamBoundsHigh[i] = opt(rig, where, 'boundsHigh', b.boundsHigh, RIG_DEFAULTS.boundsHigh, true);
    beamPreload[i] = opt(rig, where, 'preload', b.preload, RIG_DEFAULTS.preload, false);
    beamHydroTravel[i] = opt(rig, where, 'hydroTravel', b.hydroTravel, RIG_DEFAULTS.hydroTravel, false);
  }

  // P5 object-contact radius: explicit, else 0.6 × median incident rest length (clamped).
  const incident: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < beamCount; i++) {
    incident[beamA[i]!]!.push(beamRestLen[i]!);
    incident[beamB[i]!]!.push(beamRestLen[i]!);
  }
  for (let i = 0; i < nodeCount; i++) {
    const decl = objRadiusDecl[i]!;
    if (decl > 0) {
      nodeObjRadius[i] = decl;
      continue;
    }
    const lens = incident[i]!.sort((x, y) => x - y);
    const n = lens.length;
    const median = n === 0 ? nodeRadius[i]! / OBJ_RADIUS_SPACING_FACTOR : n & 1 ? lens[n >> 1]! : (lens[n / 2 - 1]! + lens[n / 2]!) / 2;
    const r = OBJ_RADIUS_SPACING_FACTOR * median;
    nodeObjRadius[i] = r < OBJ_RADIUS_MIN ? OBJ_RADIUS_MIN : r > OBJ_RADIUS_MAX ? OBJ_RADIUS_MAX : r;
  }

  return {
    name: def.name,
    nodeCount,
    beamCount,
    nodeIds,
    nodePos,
    nodeMass,
    nodeInvMass,
    nodeFriction,
    nodeContactK,
    nodeObjRadius,
    nodeRadius,
    nodeFlags,
    groups,
    nodeGroup,
    beamA,
    beamB,
    beamType,
    beamRestLen,
    beamK,
    beamD,
    beamDeform,
    beamBreakF,
    beamBoundsLow,
    beamBoundsHigh,
    beamPreload,
    beamHydroTravel,
  };
}

function isCompiled(x: RigDef | CompiledRig): x is CompiledRig {
  return (x as CompiledRig).nodeInvMass instanceof Float64Array;
}

export interface StabilityOptions {
  /** Step, s. Default RIG_DT (1/2000). */
  dt?: number;
  /** ω·dt limit. Default STRUCTURE_OMEGA_DT_LIMIT (0.35). */
  limit?: number;
}

/**
 * Per-node explicit-integration stability: ω·dt = sqrt(Σ incident k / m)·dt
 * and (Σ incident d / m)·dt. Pinned nodes are excluded (0). Incident beams
 * to pinned nodes still count for the free endpoint.
 */
export function computeStabilityReport(
  rig: RigDef | CompiledRig,
  opts: StabilityOptions = {},
): StabilityReport {
  const c = isCompiled(rig) ? rig : compileRig(rig);
  const dt = opts.dt ?? RIG_DT;
  const limit = opts.limit ?? STRUCTURE_OMEGA_DT_LIMIT;
  const n = c.nodeCount;
  const sumK = new Float64Array(n);
  const sumD = new Float64Array(n);
  for (let i = 0; i < c.beamCount; i++) {
    const a = c.beamA[i]!;
    const b = c.beamB[i]!;
    const k = c.beamK[i]!;
    const d = c.beamD[i]!;
    sumK[a]! += k;
    sumK[b]! += k;
    sumD[a]! += d;
    sumD[b]! += d;
  }

  const omegaDt = new Float64Array(n);
  const dampDt = new Float64Array(n);
  const suggestedMinMass = new Float64Array(n);
  let violations = 0;
  let declared = 0;
  let raised = 0;
  for (let i = 0; i < n; i++) {
    const m = c.nodeMass[i]!;
    if (!(c.nodeInvMass[i]! > 0)) continue;
    const sk = sumK[i]!;
    const sd = sumD[i]!;
    const w = Math.sqrt(sk / m) * dt;
    const z = (sd / m) * dt;
    omegaDt[i] = w;
    dampDt[i] = z;
    const minM = Math.max((sk * dt * dt) / (limit * limit), (sd * dt) / DAMP_DT_LIMIT);
    suggestedMinMass[i] = minM;
    if (w > limit * (1 + LIMIT_EPS) || z > DAMP_DT_LIMIT * (1 + LIMIT_EPS)) violations++;
    declared += m;
    raised += Math.max(m, minM);
  }

  const order: number[] = [];
  for (let i = 0; i < n; i++) if (c.nodeInvMass[i]! > 0) order.push(i);
  order.sort((x, y) => omegaDt[y]! - omegaDt[x]! || x - y);
  const worst = order.slice(0, WORST_COUNT).map((index) => ({
    index,
    id: c.nodeIds[index]!,
    omegaDt: omegaDt[index]!,
    dampDt: dampDt[index]!,
  }));

  return {
    dt,
    limit,
    omegaDt,
    dampDt,
    worst,
    suggestedMinMass,
    violations,
    massDriftPct: declared > 0 ? ((raised - declared) / declared) * 100 : 0,
    ok: violations === 0,
  };
}

/**
 * MINIMASS: per-node masses (declaration order) raised to satisfy ω·dt ≤
 * target and (Σd/m)·dt ≤ 1. Never lowers a mass, never un-pins (pinned nodes
 * keep their declared value). driftPct = total free-mass increase in %.
 */
export function suggestMinimumMasses(
  def: RigDef,
  target: number = STRUCTURE_OMEGA_DT_LIMIT,
): { masses: number[]; driftPct: number } {
  const report = computeStabilityReport(def, { limit: target });
  const masses = def.nodes.map((node, i) =>
    node.mass > 0 ? Math.max(node.mass, report.suggestedMinMass[i]!) : node.mass,
  );
  return { masses, driftPct: report.massDriftPct };
}

/** Returns a copy of `def` with node masses replaced (declaration order). */
export function withMasses(def: RigDef, masses: readonly number[]): RigDef {
  if (masses.length !== def.nodes.length) {
    throw new RigCompileError(
      `withMasses("${def.name}"): got ${masses.length} masses for ${def.nodes.length} nodes`,
    );
  }
  return { ...def, nodes: def.nodes.map((n, i) => ({ ...n, mass: masses[i]! })) };
}

/** Summary numbers for debug overlays / logging. */
export function computeRigStats(c: CompiledRig): RigStats {
  const beamsByType: Record<RigBeamType, number> = { normal: 0, bounded: 0, support: 0, hydro: 0, shock: 0 };
  for (let i = 0; i < c.beamCount; i++) beamsByType[BEAM_TYPES[c.beamType[i]!]!]++;
  let pinned = 0;
  let collidable = 0;
  let total = 0;
  let minM = Infinity;
  let maxM = 0;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.nodeCount; i++) {
    const m = c.nodeMass[i]!;
    if (c.nodeInvMass[i]! > 0) {
      total += m;
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
    } else {
      pinned++;
    }
    if (c.nodeFlags[i]! & RIG_NODE_FLAG_COLLIDABLE) collidable++;
    for (let a = 0; a < 3; a++) {
      const p = c.nodePos[i * 3 + a]!;
      if (p < lo[a]!) lo[a] = p;
      if (p > hi[a]!) hi[a] = p;
    }
  }
  let minL = Infinity;
  let maxL = 0;
  for (let i = 0; i < c.beamCount; i++) {
    const l = c.beamRestLen[i]!;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  const empty = c.nodeCount === 0;
  return {
    name: c.name,
    nodeCount: c.nodeCount,
    beamCount: c.beamCount,
    pinnedCount: pinned,
    collidableCount: collidable,
    totalMass: total,
    minNodeMass: Number.isFinite(minM) ? minM : 0,
    maxNodeMass: maxM,
    beamsByType,
    boundsMin: empty ? [0, 0, 0] : lo,
    boundsMax: empty ? [0, 0, 0] : hi,
    minRestLen: c.beamCount > 0 ? minL : 0,
    maxRestLen: maxL,
  };
}
