/**
 * Vehicle builder + validator: VehicleDef → merged RigDef → CompiledVehicle.
 *
 * PURE DATA MODULE (docs/CONTRACTS.md boundary amendment, P2): main-thread
 * code may import it. No engine/state/worker imports, no three, no DOM. Not a
 * hot loop: allocation and Math.* are fine here.
 *
 * Merged order is the FROZEN canonical order (./types.ts): body nodes/beams
 * in declaration order, then each wheel in declaration order exactly as
 * buildWheelRig generates it.
 */
import {
  computeRigStats,
  computeStabilityReport,
  compileRig,
  GENERAL_OMEGA_DT_LIMIT,
  DAMP_DT_LIMIT,
  RIG_DT,
  RigCompileError,
  STRUCTURE_OMEGA_DT_LIMIT,
  withMasses,
} from '../rig/builder';
import { OBJ_RADIUS_MIN, RIG_BEAM_TYPE_ID, type CompiledRig, type RigBeamDef, type RigDef, type RigNodeDef, type RigStats, type StabilityReport } from '../rig/types';
import {
  DIFF_TYPE_ID,
  TORQUE_LUT_STEP_RPM,
  WHEEL_BEAMS_PER_RAY,
  WHEEL_CORNER,
  WHEEL_DEFAULTS,
  wheelNodeId,
  type BuildVehicleRig,
  type CompiledDrivetrain,
  type CompiledVehicle,
  type CompiledWheel,
  type CompileVehicle,
  type VehicleDef,
  type VehicleValidationReport,
  type WheelDef,
} from './types';
import { buildWheelRig } from './wheelrig';
import { compileShells, type CompiledShell } from './shellDefs';

/** Beam budgets (CLAUDE.md physics budgets). */
export const PLAYER_BEAM_BUDGET = 3500;
export const TRAFFIC_BEAM_BUDGET = 1500;
/** MINIMASS drift above this (%) is reported as a warning. */
export const MASS_DRIFT_WARN_PCT = 10;

/** Thrown by buildVehicleRig / compileVehicle for malformed definitions. */
export class VehicleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VehicleCompileError';
  }
}

function fail(name: string, msg: string): never {
  throw new VehicleCompileError(`vehicle "${name}": ${msg}`);
}

function vehicleName(def: VehicleDef): string {
  return def !== null && typeof def === 'object' && typeof def.name === 'string' ? def.name : '?';
}

// ------------------------------------------------------------------ merge
/**
 * Merged RigDef BEFORE MINIMASS: body nodes, then per wheel (declaration
 * order) the generated nodes; body beams, then per wheel the generated beams.
 * Body beams may reference generated wheel node ids (resolved by compileRig).
 * Inputs are copied, never aliased.
 */
export const buildVehicleRig: BuildVehicleRig = (def) => {
  const name = vehicleName(def);
  if (def === null || typeof def !== 'object') fail(name, 'definition must be an object');
  if (typeof def.name !== 'string' || def.name.length === 0) fail(name, 'name must be a non-empty string');
  const body = def.body;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.nodes) || !Array.isArray(body.beams)) {
    fail(name, 'body must be a RigDef with nodes[] and beams[]');
  }
  if (!Array.isArray(def.wheels)) fail(name, 'wheels must be an array');

  const lookup = new Map<string, RigNodeDef>();
  for (const n of body.nodes) if (n && typeof n.id === 'string' && !lookup.has(n.id)) lookup.set(n.id, n);
  const nodes: RigNodeDef[] = body.nodes.map((n) => ({ ...n, pos: [n.pos[0], n.pos[1], n.pos[2]] }));
  const beams: RigBeamDef[] = body.beams.map((b) => ({ ...b }));
  const seen = new Set<string>();
  for (let w = 0; w < def.wheels.length; w++) {
    const wheel = def.wheels[w]!;
    if (wheel === null || typeof wheel !== 'object') fail(name, `wheels[${w}] must be an object`);
    if (seen.has(wheel.id)) fail(name, `duplicate wheel id "${wheel.id}"`);
    seen.add(wheel.id);
    const gen = buildWheelRig(wheel, (id) => lookup.get(id));
    for (const n of gen.nodes) nodes.push(n);
    for (const b of gen.beams) beams.push(b);
  }
  const merged: RigDef = { name: def.name, nodes, beams };
  if (body.groupDefaults !== undefined) merged.groupDefaults = { ...body.groupDefaults };
  // R-CORE: declared collision triangles reference body node ids (unchanged by the merge).
  if (body.triangles !== undefined) merged.triangles = body.triangles.map((t) => ({ ...t }));
  return merged;
};

// ------------------------------------------------------------------ torque LUT
/**
 * Full-throttle torque LUT: the curve sampled every `stepRpm` from 0 to the
 * last point (inclusive, rounded up), linear interpolation, clamped at both
 * ends. Same sampling rule as the worker's drivetrain (kept local so this
 * module stays main-thread importable).
 */
export function sampleTorqueCurve(
  curve: readonly (readonly [number, number])[],
  stepRpm: number = TORQUE_LUT_STEP_RPM,
): Float64Array {
  const last = curve[curve.length - 1]![0];
  const n = Math.max(2, Math.ceil(last / stepRpm) + 1);
  const lut = new Float64Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const rpm = i * stepRpm;
    if (rpm <= curve[0]![0]) {
      lut[i] = curve[0]![1];
      continue;
    }
    if (rpm >= last) {
      lut[i] = curve[curve.length - 1]![1];
      continue;
    }
    while (curve[seg + 1]![0] < rpm) seg++;
    const [r0, t0] = curve[seg]!;
    const [r1, t1] = curve[seg + 1]!;
    lut[i] = t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
  }
  return lut;
}

// ------------------------------------------------------------------ def checks
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Structural checks on the non-rig parts of a VehicleDef. Returns error strings. */
function checkDefinition(def: VehicleDef): string[] {
  const errors: string[] = [];
  const bodyIds = new Set<string>();
  if (def.body && Array.isArray(def.body.nodes)) for (const n of def.body.nodes) if (n) bodyIds.add(n.id);

  const f = def.frame;
  if (!f || typeof f !== 'object') errors.push('frame {origin, front, top} missing');
  else {
    for (const key of ['origin', 'front', 'top'] as const) {
      if (!bodyIds.has(f[key])) errors.push(`frame.${key} "${String(f[key])}" is not a body node id`);
    }
    if (f.origin === f.front || f.origin === f.top || f.front === f.top) errors.push('frame origin/front/top must be distinct nodes');
  }

  const d = def.drivetrain;
  if (!d || typeof d !== 'object') errors.push('drivetrain missing');
  else {
    const c = d.torqueCurve;
    if (!Array.isArray(c) || c.length < 2) errors.push('drivetrain.torqueCurve needs >= 2 [rpm, Nm] points');
    else {
      for (let i = 0; i < c.length; i++) {
        const p = c[i];
        if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1]) || p[0] < 0) {
          errors.push(`drivetrain.torqueCurve[${i}] must be [rpm >= 0, Nm] finite`);
        } else if (i > 0 && Array.isArray(c[i - 1]) && !(p[0] > c[i - 1]![0])) {
          errors.push('drivetrain.torqueCurve rpm must be strictly ascending');
        }
      }
    }
    for (const key of ['idleRpm', 'redlineRpm', 'revLimitRpm', 'engineInertia', 'finalDrive', 'reverseRatio', 'clutchMaxTorque'] as const) {
      if (!isNum(d[key]) || !(d[key] > 0)) errors.push(`drivetrain.${key} must be > 0`);
    }
    for (const key of ['engineBrakeTorque', 'shiftTimeS', 'autoShiftUpRpm', 'autoShiftDownRpm'] as const) {
      if (!isNum(d[key]) || d[key] < 0) errors.push(`drivetrain.${key} must be >= 0`);
    }
    if (isNum(d.idleRpm) && isNum(d.redlineRpm) && !(d.idleRpm < d.redlineRpm)) errors.push('drivetrain idleRpm must be < redlineRpm');
    if (isNum(d.redlineRpm) && isNum(d.revLimitRpm) && d.revLimitRpm < d.redlineRpm) errors.push('drivetrain revLimitRpm must be >= redlineRpm');
    if (isNum(d.autoShiftUpRpm) && isNum(d.autoShiftDownRpm) && !(d.autoShiftDownRpm < d.autoShiftUpRpm)) {
      errors.push('drivetrain autoShiftDownRpm must be < autoShiftUpRpm');
    }
    if (!Array.isArray(d.gearRatios) || d.gearRatios.length === 0 || !d.gearRatios.every((r) => isNum(r) && r > 0)) {
      errors.push('drivetrain.gearRatios must be a non-empty list of positive ratios');
    }
    if (!(d.diff in DIFF_TYPE_ID)) errors.push(`drivetrain.diff "${String(d.diff)}" unknown`);
    if (d.diffLockTorque !== undefined && (!isNum(d.diffLockTorque) || d.diffLockTorque < 0)) errors.push('drivetrain.diffLockTorque must be >= 0');
    if (d.transmission !== undefined && d.transmission !== 'auto' && d.transmission !== 'manual') errors.push('drivetrain.transmission must be auto|manual');
    if (d.tractionControl !== undefined && (!isNum(d.tractionControl) || d.tractionControl < 0)) errors.push('drivetrain.tractionControl must be >= 0');
  }

  const b = def.brakes;
  if (!b || !isNum(b.frontBias) || b.frontBias < 0 || b.frontBias > 1) errors.push('brakes.frontBias must be in [0, 1]');
  if (!b || !isNum(b.handbrakeTorqueMax) || b.handbrakeTorqueMax < 0) errors.push('brakes.handbrakeTorqueMax must be >= 0');
  const a = def.aero;
  if (!a || !isNum(a.dragCoeffArea) || a.dragCoeffArea < 0 || !isNum(a.liftCoeffArea)) errors.push('aero {dragCoeffArea >= 0, liftCoeffArea} must be finite');
  if (!def.steering || !isNum(def.steering.maxWheelAngleDeg) || def.steering.maxWheelAngleDeg < 0) errors.push('steering.maxWheelAngleDeg must be >= 0');

  if (Array.isArray(def.wheels)) {
    for (const w of def.wheels) {
      if (!w || typeof w !== 'object') continue;
      if (w.axle !== 'front' && w.axle !== 'rear') errors.push(`wheel "${w.id}" axle must be front|rear`);
      if (!isNum(w.brakeTorqueMax) || w.brakeTorqueMax < 0) errors.push(`wheel "${w.id}" brakeTorqueMax must be >= 0`);
      if (w.attach === undefined || !Array.isArray(w.attach)) errors.push(`wheel "${w.id}" attach must be an array`);
    }
  }
  return errors;
}

// ------------------------------------------------------------------ compile
function brakeAxleFactor(frontBias: number, axle: 'front' | 'rear'): number {
  const denom = Math.max(frontBias, 1 - frontBias);
  if (!(denom > 0)) return 0;
  return (axle === 'front' ? frontBias : 1 - frontBias) / denom;
}

function compileWheels(def: VehicleDef, rig: CompiledRig, bodyNodeCount: number, bodyBeamCount: number): CompiledWheel[] {
  const name = def.name;
  const out: CompiledWheel[] = [];
  const takenCorners = new Set<number>();
  let nodeStart = bodyNodeCount;
  let beamStart = bodyBeamCount;
  for (let w = 0; w < def.wheels.length; w++) {
    const wd: WheelDef = def.wheels[w]!;
    const n = wd.rays;
    const nodeCount = 2 + 4 * n;
    const beamCount = 2 * wd.attach.length + 1 + WHEEL_BEAMS_PER_RAY * n;
    const hubI = nodeStart;
    const hubO = nodeStart + 1;
    if (rig.nodeIds[hubI] !== wheelNodeId(wd.id, 'hubI') || rig.nodeIds[hubO] !== wheelNodeId(wd.id, 'hubO')) {
      fail(name, `internal: wheel "${wd.id}" node range does not match the canonical order`);
    }
    const p = rig.nodePos;
    const ax = p[3 * hubO]! - p[3 * hubI]!;
    const spinSign: 1 | -1 = ax < 0 ? 1 : -1;
    const left = ax < 0;
    const cornerKey = wd.axle === 'front' ? (left ? 'FL' : 'FR') : left ? 'RL' : 'RR';
    let corner: number = WHEEL_CORNER[cornerKey];
    if (takenCorners.has(corner)) corner = -1;
    else takenCorners.add(corner);

    const links: number[] = [];
    const end = nodeStart + nodeCount;
    for (let b = 0; b < rig.beamCount; b++) {
      const a = rig.beamA[b]!;
      const c = rig.beamB[b]!;
      const aHub = a === hubI || a === hubO;
      const cHub = c === hubI || c === hubO;
      if (aHub && (c < nodeStart || c >= end)) links.push(b);
      else if (cHub && (a < nodeStart || a >= end)) links.push(b);
    }

    out.push({
      id: wd.id,
      index: w,
      axle: wd.axle,
      spinSign,
      corner,
      rays: n,
      radius: wd.radius,
      rimRadius: wd.rimRadius,
      tireRingRadius: wd.radius - (wd.tireNodeRadius ?? WHEEL_DEFAULTS.tireNodeRadius),
      nodeStart,
      nodeCount,
      hubI,
      hubO,
      rimStart: nodeStart + 2,
      tireStart: nodeStart + 2 + 2 * n,
      beamStart,
      beamCount,
      hubLinkBeams: Int32Array.from(links),
      attachNodes: Int32Array.from(wd.attach.map((id) => rig.nodeIds.indexOf(id))),
      steered: wd.steered,
      driven: wd.driven,
      braked: wd.braked,
      handbrake: wd.handbrake,
      brakeTorque: wd.braked ? wd.brakeTorqueMax * brakeAxleFactor(def.brakes.frontBias, wd.axle) : 0,
      handbrakeTorque: wd.handbrake ? def.brakes.handbrakeTorqueMax : 0,
      rollingResistance: wd.rollingResistance ?? 0,
      brushK: wd.treadBrushStiffness ?? 0,
      brushC: wd.treadBrushDamping ?? 0,
      rimHoop: (wd.rimHoopTension ?? 0) / (2 * Math.sin(Math.PI / n)),
      treadHoop: (wd.treadHoopTension ?? 0) / (2 * Math.sin(Math.PI / n)),
      friction: wd.friction,
      tyre: {
        loadSensitivity: wd.tyreLoadSensitivity ?? 0,
        slideRatio: wd.tyreSlideRatio ?? 1,
        peakSlip: wd.tyrePeakSlip ?? 0.1,
        slideSlip: wd.tyreSlideSlip ?? 0.6,
        rollingLossComp: wd.rollingLossComp ? [...wd.rollingLossComp] : [],
        designLoad: wd.tyreDesignLoad ?? 0,
        lateralMu: wd.tyreLateralMu ?? 1,
      },
      caliperInboard: wd.caliperInboard ?? 0.5,
      brakeDiscMass: wd.braked ? (wd.brakeDiscMass ?? (wd.brakeTorqueMax * brakeAxleFactor(def.brakes.frontBias, wd.axle)) / 300) : 0,
      brakeDiscVented: wd.brakeDiscVented ?? wd.axle === 'front',
    });
    nodeStart += nodeCount;
    beamStart += beamCount;
  }
  if (nodeStart !== rig.nodeCount || beamStart !== rig.beamCount) {
    fail(name, 'internal: wheel ranges do not cover the merged rig');
  }
  return out;
}

function compileDrivetrain(def: VehicleDef): CompiledDrivetrain {
  const d = def.drivetrain;
  const table = new Float64Array(d.gearRatios.length + 2);
  table[0] = -d.reverseRatio;
  table[1] = 0;
  for (let g = 0; g < d.gearRatios.length; g++) table[g + 2] = d.gearRatios[g]!;
  const driven: number[] = [];
  for (let w = 0; w < def.wheels.length; w++) if (def.wheels[w]!.driven) driven.push(w);
  return {
    torqueLut: sampleTorqueCurve(d.torqueCurve, TORQUE_LUT_STEP_RPM),
    lutStepRpm: TORQUE_LUT_STEP_RPM,
    idleRpm: d.idleRpm,
    redlineRpm: d.redlineRpm,
    revLimitRpm: d.revLimitRpm,
    engineInertia: d.engineInertia,
    engineBrakeTorque: d.engineBrakeTorque,
    gearRatioTable: table,
    gearCount: d.gearRatios.length,
    finalDrive: d.finalDrive,
    shiftTimeS: d.shiftTimeS,
    autoShiftUpRpm: d.autoShiftUpRpm,
    autoShiftDownRpm: d.autoShiftDownRpm,
    diff: DIFF_TYPE_ID[d.diff],
    diffLockTorque: d.diffLockTorque ?? 0,
    clutchMaxTorque: d.clutchMaxTorque,
    tcSlip: d.tractionControl ?? 0,
    drivenWheels: Int32Array.from(driven),
    transmission: d.transmission ?? 'auto',
    driveReaction: d.driveReaction ?? 'body',
    ...(d.engine ? { engine: { ...d.engine } } : {}),
    ...(d.speedLimitKmh ? { speedLimit: d.speedLimitKmh / 3.6 } : {}),
    ...(d.lsd ? { lsd: { ...d.lsd } } : {}),
    ...(d.viscousCoeff !== undefined ? { viscousCoeff: d.viscousCoeff } : {}),
    ...(d.halfshaftBreakTorque !== undefined ? { halfshaftBreakTorque: d.halfshaftBreakTorque } : {}),
  };
}

/** P5: body node object-contact radius cap, m (the 0.6 × spacing default reached 0.35 on 0.6 m sedan beams). */
export const VEHICLE_OBJ_RADIUS_MAX = 0.2;
/** P5: a body node's contact sphere keeps this clearance above the rest ground plane, m. */
export const VEHICLE_OBJ_CLEARANCE = 0.1;

/**
 * P5 vehicle contact-sphere policy (body nodes without an explicit
 * objRadius): r ≤ VEHICLE_OBJ_RADIUS_MAX and r ≤ (rest height above the
 * tyre contact plane) − VEHICLE_OBJ_CLEARANCE, floored at OBJ_RADIUS_MIN.
 * WHY: with the generic default the floor-rail spheres (0.35 m at 0.17 m
 * height) reached 18 cm below the ground and trapped cones under the car.
 * Wheel nodes keep the default (a rotating ring node must not change size).
 */
function limitBodyObjRadius(def: VehicleDef, rig: CompiledRig): void {
  let ground = Infinity;
  for (let i = def.body.nodes.length; i < rig.nodeCount; i++) {
    const y = rig.nodePos[3 * i + 1]! - rig.nodeRadius[i]!;
    if (y < ground) ground = y;
  }
  if (!Number.isFinite(ground)) ground = 0;
  def.body.nodes.forEach((n, i) => {
    if (n.objRadius !== undefined && n.objRadius > 0) return;
    let r = rig.nodeObjRadius[i]!;
    const lift = rig.nodePos[3 * i + 1]! - ground - VEHICLE_OBJ_CLEARANCE;
    if (r > VEHICLE_OBJ_RADIUS_MAX) r = VEHICLE_OBJ_RADIUS_MAX;
    if (r > lift) r = lift;
    rig.nodeObjRadius[i] = r < OBJ_RADIUS_MIN ? OBJ_RADIUS_MIN : r;
  });
}

function compileMerged(name: string, merged: RigDef): CompiledRig {
  try {
    return compileRig(merged);
  } catch (e) {
    if (e instanceof RigCompileError) fail(name, e.message);
    throw e;
  }
}

/**
 * Per-node ω·dt target of the vehicle MINIMASS: STRUCTURE_OMEGA_DT_LIMIT,
 * except tyre TREAD nodes (group WHEEL_DEFAULTS.tireGroup), which may run up
 * to TREAD_OMEGA_DT_LIMIT. WHY: tread nodes are not structure (they never
 * deform plastically or carry crash loads) and the tread mass is what
 * smacks into the ground every pass: rolling loss ∝ tread mass / carcass
 * stiffness, so holding them at 0.35 forced a 2× heavy tyre (16 kg) and
 * ~2× the rolling resistance. 0.49 leaves headroom under the 0.5 general
 * limit; the soft-layer contact spring adds ≈ 0.2 in quadrature.
 */
export const TREAD_OMEGA_DT_LIMIT = 0.49;
/**
 * Crash-shell nodes (group SHELL_GROUP) may run up to SHELL_OMEGA_DT_LIMIT
 * (P4 crash amendment, docs/CONTRACTS.md). WHY: a crash is
 * stiffness-limited. The shell must carry a 250–400 kN crush force, and
 * at 0.35 its sections were so soft that a 30 km/h frontal compressed the
 * nose elastically by ~60 cm and gave it back. (0.495/0.35)² = 2× the
 * stiffness at the same mass; still under the 0.5 general limit. Ground /
 * collider contact adds ≤ sqrt(0.2) in quadrature (≤ 0.68 per node), far
 * inside the explicit-Euler bound of 2.
 */
export const SHELL_OMEGA_DT_LIMIT = 0.495;
export const SHELL_GROUP = 'body';

/** Per-node ω·dt limit of the vehicle MINIMASS / validation by node group. */
export function vehicleOmegaDtLimit(group: string | undefined): number {
  if (group === WHEEL_DEFAULTS.tireGroup) return TREAD_OMEGA_DT_LIMIT;
  if (group === SHELL_GROUP) return SHELL_OMEGA_DT_LIMIT;
  return STRUCTURE_OMEGA_DT_LIMIT;
}

export function minimumMasses(merged: RigDef): number[] {
  const structure = computeStabilityReport(merged, { limit: STRUCTURE_OMEGA_DT_LIMIT });
  const tread = computeStabilityReport(merged, { limit: TREAD_OMEGA_DT_LIMIT });
  const shell = computeStabilityReport(merged, { limit: SHELL_OMEGA_DT_LIMIT });
  return merged.nodes.map((n, i) => {
    if (!(n.mass > 0)) return n.mass;
    const lim = vehicleOmegaDtLimit(n.group);
    const rep = lim === TREAD_OMEGA_DT_LIMIT ? tread : lim === SHELL_OMEGA_DT_LIMIT ? shell : structure;
    return Math.max(n.mass, rep.suggestedMinMass[i]!);
  });
}

/**
 * buildVehicleRig → MINIMASS at STRUCTURE_OMEGA_DT_LIMIT (tread nodes: TREAD_OMEGA_DT_LIMIT) (raises masses
 * only, never softens k) → compileRig → wheel/drivetrain tables.
 * Throws VehicleCompileError on malformed definitions.
 */
export const compileVehicle: CompileVehicle = (def) => {
  const name = vehicleName(def);
  const merged = buildVehicleRig(def);
  const defErrors = checkDefinition(def);
  if (defErrors.length > 0) fail(name, defErrors.join('; '));
  compileMerged(name, merged); // reports malformed rigs before MINIMASS (which compiles too)
  const masses = minimumMasses(merged);
  const rig = compileMerged(name, withMasses(merged, masses));
  limitBodyObjRadius(def, rig);

  let declared = 0;
  for (const n of merged.nodes) if (n.mass > 0) declared += n.mass;
  let total = 0;
  for (let i = 0; i < rig.nodeCount; i++) if (rig.nodeInvMass[i]! > 0) total += rig.nodeMass[i]!;

  const bodyNodeCount = def.body.nodes.length;
  const bodyBeamCount = def.body.beams.length;
  const index = new Map<string, number>();
  for (let i = 0; i < bodyNodeCount; i++) index.set(rig.nodeIds[i]!, i);
  const frameNodes = Int32Array.from([def.frame.origin, def.frame.front, def.frame.top].map((id) => index.get(id)!));
  const shell = compileShells(rig, bodyNodeCount, def.shell);
  setCrushUnload(def, rig, shell);

  return {
    name: def.name,
    rig,
    bodyNodeCount,
    bodyBeamCount,
    wheels: compileWheels(def, rig, bodyNodeCount, bodyBeamCount),
    drivetrain: compileDrivetrain(def),
    brakes: { ...def.brakes },
    aero: { ...def.aero },
    steering: { ...def.steering },
    frameNodes,
    totalMass: total,
    massDriftPct: declared > 0 ? ((total - declared) / declared) * 100 : 0,
    shell,
    ...(def.dampers ? { dampers: def.dampers } : {}),
  };
};

/** R-CRASH: default VehicleDef.crushUnload α (unloading stiffness multiple of a crash-loaded member; beams.ts CRUSH_UNLOAD_HOLD). */
export const CRUSH_UNLOAD_DEFAULT = 40;
/** A crumple-zone member is crash loaded from this fraction of its yield force (only while the car is in a crash). */
export const CRUSH_TRIGGER_YIELD = 0.3;
/** A held (cell / firewall / box / cab) or never-yielding member (engine block, subframe) is crash loaded from this force, N. */
export const CRUSH_TRIGGER_HELD = 10e3;

/**
 * R-CRASH crush unloading (beams.ts CRUSH_UNLOAD_HOLD): per body beam of type normal, the unloading gain
 * and trigger force. Crumple-zone members (finite yield, not both ends in a HELD shell tier) get +(α − 1);
 * held / never-yielding members get −(α_held − 1) (temporary offsets only). Wheels, shocks, hydros and
 * support rests are left out (their trigger loads are never reached in a crash, measured).
 */
/** Node groups of hinged closures (their body attachment beams take no crush unloading). */
const CRUSH_CLOSURE_GROUPS: ReadonlySet<string> = new Set(['hood', 'door', 'trunk', 'tailgate']);
/** Node groups of the running gear and powertrain (temporary unloading only). */
const CRUSH_RUNNING_GEAR = /^(knuckle|wheel)/;
function setCrushUnload(def: VehicleDef, rig: CompiledRig, shells: readonly CompiledShell[]): void {
  const alpha = def.crushUnload ?? CRUSH_UNLOAD_DEFAULT;
  const alphaHeld = def.crushUnloadHeld ?? alpha;
  if (!(alpha > 1) && !(alphaHeld > 1)) return;
  // HELD nodes: every zone tier except the crumple zones (yield + whole): the safety cell, the firewall
  // ring, a truck box / pickup cab.
  const held = new Uint8Array(rig.nodeCount);
  for (const sh of shells) {
    for (let k = 0; k < sh.nodes.length; k++) {
      const t = sh.tier[k]!;
      if (t > 0 && !(sh.yields[t] !== 0 && sh.whole[t] !== 0)) held[sh.nodes[k]!] = 1;
    }
  }
  const gain = new Float32Array(rig.beamCount);
  const trig = new Float32Array(rig.beamCount).fill(Infinity);
  const n = def.body.beams.length;
  const groupOf = (i: number): string => rig.groups[rig.nodeGroup[i]!] ?? '';
  for (let b = 0; b < n; b++) {
    if (rig.beamType[b] !== RIG_BEAM_TYPE_ID.normal) continue;
    const df = rig.beamDeform[b]!;
    const ga = groupOf(rig.beamA[b]!);
    const gb = groupOf(rig.beamB[b]!);
    // hinges / latches / rests of the closures and the hood: elastic until they bend or break (no set)
    if (ga !== gb && (CRUSH_CLOSURE_GROUPS.has(ga) || CRUSH_CLOSURE_GROUPS.has(gb))) continue;
    // suspension, subframe, engine mounts: forged / cast parts that bend or break, never take a crush
    // set from a crash load (a permanent set there froze the crash's nose-dive into the suspension:
    // the 58 km/h wall-hit sedan sat on its floor and could not drive away); temporary unloading only
    const isHeld = (held[rig.beamA[b]!] !== 0 && held[rig.beamB[b]!] !== 0) || CRUSH_RUNNING_GEAR.test(ga) || CRUSH_RUNNING_GEAR.test(gb);
    if (isHeld || !Number.isFinite(df)) {
      if (!(alphaHeld > 1)) continue;
      gain[b] = -(alphaHeld - 1);
      trig[b] = CRUSH_TRIGGER_HELD;
    } else if (alpha > 1) {
      gain[b] = alpha - 1;
      trig[b] = CRUSH_TRIGGER_YIELD * df;
    }
  }
  rig.beamUnload = gain;
  rig.beamUnloadTrig = trig;
}

// ------------------------------------------------------------------ validate
export interface ValidateVehicleOptions {
  /**
   * Apply MINIMASS before judging per-node stability (masses raised to
   * ω·dt ≤ 0.35): ω violations become a mass-drift report instead of errors.
   * Default false: declared masses are judged (> 0.5 error, > 0.35 warning).
   */
  autoRaiseMasses?: boolean;
}

/** VehicleValidationReport plus the declared-mass analysis (additive). */
export interface VehicleValidationReportEx extends VehicleValidationReport {
  /** Stability of the DECLARED masses (before MINIMASS), structure limit 0.35. */
  declaredStability: StabilityReport;
  /** MINIMASS mass increase, % of declared (what compileVehicle will add). */
  massDriftPct: number;
  /** Connected components of the merged rig (1 = fully connected). */
  islands: number;
}

const MAX_LISTED = 6;

function emptyStats(name: string): RigStats {
  return {
    name,
    nodeCount: 0,
    beamCount: 0,
    pinnedCount: 0,
    collidableCount: 0,
    totalMass: 0,
    minNodeMass: 0,
    maxNodeMass: 0,
    beamsByType: { normal: 0, bounded: 0, support: 0, hydro: 0, shock: 0 },
    boundsMin: [0, 0, 0],
    boundsMax: [0, 0, 0],
    minRestLen: 0,
    maxRestLen: 0,
  };
}

function emptyStability(): StabilityReport {
  return {
    dt: RIG_DT,
    limit: STRUCTURE_OMEGA_DT_LIMIT,
    omegaDt: new Float64Array(0),
    dampDt: new Float64Array(0),
    worst: [],
    suggestedMinMass: new Float64Array(0),
    violations: 0,
    massDriftPct: 0,
    ok: false,
  };
}

/** Union-find connected components over beams; returns component id per node. */
function components(rig: CompiledRig): { count: number; comp: Int32Array } {
  const parent = new Int32Array(rig.nodeCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let b = 0; b < rig.beamCount; b++) {
    const ra = find(rig.beamA[b]!);
    const rb = find(rig.beamB[b]!);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  }
  const comp = new Int32Array(rig.nodeCount);
  const ids = new Map<number, number>();
  for (let i = 0; i < rig.nodeCount; i++) {
    const r = find(i);
    let c = ids.get(r);
    if (c === undefined) {
      c = ids.size;
      ids.set(r, c);
    }
    comp[i] = c;
  }
  return { count: ids.size, comp };
}

/**
 * Validates a VehicleDef without throwing. Hard errors: malformed ids/refs
 * (anything compileVehicle would reject), beam budget, pinned nodes,
 * disconnected node islands, wheels without hub links, per-node ω·dt > 0.5
 * or (Σd/m)·dt > 1 on DECLARED masses (unless autoRaiseMasses). Warnings:
 * ω·dt > 0.35 (MINIMASS will raise those nodes), mass drift > 10 %,
 * duplicate corners, steered wheels without steering hydros, no driven wheel,
 * frame axes far from −Z / +Y.
 * `stability` is the report AFTER MINIMASS (what the sim runs; ok when the
 * rig compiles); `declaredStability` judges the authored masses.
 */
export function validateVehicle(
  def: VehicleDef,
  beamBudget: number = PLAYER_BEAM_BUDGET,
  opts: ValidateVehicleOptions = {},
): VehicleValidationReportEx {
  const name = vehicleName(def);
  const errors: string[] = [];
  const warnings: string[] = [];
  const bad = (stats: RigStats = emptyStats(name)): VehicleValidationReportEx => ({
    ok: false,
    errors,
    warnings,
    stats,
    stability: emptyStability(),
    declaredStability: emptyStability(),
    massDriftPct: 0,
    islands: 0,
    beamBudget,
  });

  let merged: RigDef;
  let rig: CompiledRig;
  try {
    merged = buildVehicleRig(def);
    rig = compileMerged(name, merged);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return bad();
  }
  errors.push(...checkDefinition(def));
  const stats = computeRigStats(rig);

  if (rig.beamCount > beamBudget) errors.push(`beam budget exceeded: ${rig.beamCount} > ${beamBudget}`);
  if (stats.pinnedCount > 0) errors.push(`${stats.pinnedCount} pinned node(s) (mass <= 0): vehicles must be fully free`);

  // Islands.
  const { count: islands, comp } = components(rig);
  if (islands > 1) {
    const sizes = new Int32Array(islands);
    for (let i = 0; i < rig.nodeCount; i++) sizes[comp[i]!]!++;
    let main = 0;
    for (let c = 1; c < islands; c++) if (sizes[c]! > sizes[main]!) main = c;
    const stray: string[] = [];
    for (let i = 0; i < rig.nodeCount && stray.length < MAX_LISTED; i++) if (comp[i] !== main) stray.push(rig.nodeIds[i]!);
    errors.push(`${islands} disconnected node islands; nodes outside the main structure include: ${stray.join(', ')}`);
  }

  // Wheel attachment + corners + steering.
  let compiledWheels: CompiledWheel[] = [];
  try {
    compiledWheels = compileWheels(def, rig, def.body.nodes.length, def.body.beams.length);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  for (const w of compiledWheels) {
    if (w.hubLinkBeams.length === 0) errors.push(`wheel "${w.id}" is not attached (no beam links its hubs to the body)`);
    if (w.corner < 0) warnings.push(`wheel "${w.id}" shares a telemetry corner with an earlier wheel`);
  }
  if (def.wheels.length > 0 && !def.wheels.some((w) => w.driven)) warnings.push('no driven wheel');
  if (def.wheels.some((w) => w.steered) && !def.body.beams.some((b) => b.type === 'hydro')) {
    warnings.push('steered wheels but no hydro (steering) beams in body');
  }

  // Frame axes.
  if (errors.length === 0) {
    const ix = new Map<string, number>();
    for (let i = 0; i < rig.nodeCount; i++) ix.set(rig.nodeIds[i]!, i);
    const pos = (id: string): [number, number, number] => {
      const i = ix.get(id)!;
      return [rig.nodePos[3 * i]!, rig.nodePos[3 * i + 1]!, rig.nodePos[3 * i + 2]!];
    };
    const o = pos(def.frame.origin);
    const fw = pos(def.frame.front);
    const tp = pos(def.frame.top);
    const dir = (p: number[]): number[] => {
      const v = [p[0]! - o[0], p[1]! - o[1], p[2]! - o[2]];
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
      return v.map((c) => c / l);
    };
    if (dir(fw)[2]! > -0.9) warnings.push('frame forward (front − origin) is not close to −Z');
    if (dir(tp)[1]! < 0.7) warnings.push('frame up (top − origin) is not close to +Y');
  }

  // Stability: declared masses, then after MINIMASS.
  const declaredStability = computeStabilityReport(rig, { limit: STRUCTURE_OMEGA_DT_LIMIT });
  const masses = minimumMasses(merged);
  let declaredFree = 0;
  let raisedFree = 0;
  for (let i = 0; i < merged.nodes.length; i++) {
    const m = merged.nodes[i]!.mass;
    if (m > 0) {
      declaredFree += m;
      raisedFree += masses[i]!;
    }
  }
  const driftPct = declaredFree > 0 ? ((raisedFree - declaredFree) / declaredFree) * 100 : 0;
  const raised = compileRig(withMasses(merged, masses));
  const limitOf = (i: number): number => vehicleOmegaDtLimit(merged.nodes[i]!.group);
  // Post-MINIMASS report judged per node group (tread / shell / structure).
  const raisedReport = computeStabilityReport(raised, { limit: STRUCTURE_OMEGA_DT_LIMIT });
  let unstable = 0;
  for (let i = 0; i < raised.nodeCount; i++) {
    const lim = limitOf(i);
    if (raisedReport.omegaDt[i]! > lim * (1 + 1e-9) || raisedReport.dampDt[i]! > DAMP_DT_LIMIT * (1 + 1e-9)) unstable++;
  }
  const stability: StabilityReport = { ...raisedReport, violations: unstable, ok: unstable === 0 };
  if (unstable > 0) errors.push(`internal: ${unstable} node(s) still unstable after MINIMASS`);

  if (opts.autoRaiseMasses) {
    if (driftPct > 0) {
      const msg = `MINIMASS raised node masses by ${driftPct.toFixed(2)} % (${declaredStability.violations} node(s))`;
      if (driftPct > MASS_DRIFT_WARN_PCT) warnings.push(`${msg} > ${MASS_DRIFT_WARN_PCT} %`);
      else warnings.push(msg);
    }
  } else {
    const hard: string[] = [];
    const soft: string[] = [];
    let hardN = 0;
    let softN = 0;
    for (let i = 0; i < rig.nodeCount; i++) {
      const w = declaredStability.omegaDt[i]!;
      const z = declaredStability.dampDt[i]!;
      if (w > GENERAL_OMEGA_DT_LIMIT * (1 + 1e-9) || z > DAMP_DT_LIMIT * (1 + 1e-9)) {
        hardN++;
        if (hard.length < MAX_LISTED) hard.push(`${rig.nodeIds[i]} (ω·dt ${w.toFixed(3)}, Σd/m·dt ${z.toFixed(3)})`);
      } else if (w > limitOf(i) * (1 + 1e-9)) {
        softN++;
        if (soft.length < MAX_LISTED) soft.push(`${rig.nodeIds[i]} (${w.toFixed(3)})`);
      }
    }
    if (hardN > 0) errors.push(`${hardN} node(s) exceed ω·dt ${GENERAL_OMEGA_DT_LIMIT} or (Σd/m)·dt ${DAMP_DT_LIMIT}: ${hard.join(', ')}`);
    if (softN > 0) warnings.push(`${softN} node(s) exceed structure ω·dt ${STRUCTURE_OMEGA_DT_LIMIT} (tread ${TREAD_OMEGA_DT_LIMIT}, shell ${SHELL_OMEGA_DT_LIMIT}; MINIMASS raises them): ${soft.join(', ')}`);
    if (driftPct > MASS_DRIFT_WARN_PCT) warnings.push(`MINIMASS would raise node masses by ${driftPct.toFixed(2)} % > ${MASS_DRIFT_WARN_PCT} %`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats,
    stability,
    declaredStability,
    massDriftPct: driftPct,
    islands,
    beamBudget,
  };
}
