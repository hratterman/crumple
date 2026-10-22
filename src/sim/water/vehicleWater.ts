/**
 * Vehicle water runtime (R-PHYS2) — WORKER ONLY. Replaces the P5 uniform
 * vehicle density + global flood level for vehicles that have a
 * VEHICLE_WATER_SPECS entry (./specs.ts has the model and its sources).
 *
 * Per tick, per awake vehicle near water (engine phase 3, before the ground
 * pass, like applyWater):
 *  1. NODES: body node i displaces V_i = m_i/ρ_solid (+ its compartment's air
 *     share); wheel nodes m_i/500 (tyre air). Buoyancy ρ_w·g·V_i·f_i with the
 *     P5 submerged fraction f_i (WATER_PHYSICS.nodeHalfDepth); a linear drag
 *     f_i·0.8·m_i·v (as P5: damps bobbing and rocking); wheel nodes also get
 *     the P5 per-node quadratic drag on their own velocity (a wheel spinning
 *     in water is slowed and paddles a little).
 *  2. BODY FORM DRAG on the vehicle's COM velocity: F = −½ρ_w·C_d·A·|v|·v with
 *     A = the submerged projected area along v (frame axes × rest extents ×
 *     submerged depth), spread over the submerged body nodes ∝ f_i·V_i, its
 *     impulse capped at the submerged body momentum.
 *  3. COMPARTMENTS: orifice in/outflow per opening (specs.ts), inside free
 *     surface h = y_low + (V_w/V_air)·(y_high − y_low) over the compartment's
 *     current node heights; the water's weight ρ_w·g·V_w is carried by the
 *     compartment nodes below h, ∝ their depth under it.
 *  4. HYDROLOCK: the intake below the water (+ the bow wave of a vehicle
 *     wading forward) while the crank turns above HYDROLOCK_MIN_RPM sets
 *     `hydrolocked` (sticky until `reset`). R-PHYS's engine model reads it
 *     (CONTRACTS "R-PHYS ↔ R-PHYS2").
 *
 * NUMERICS: + − × ÷ sqrt only, zero allocation (scratch preallocated per
 * vehicle), ascending node / beam / opening order.
 */
import { WATER_PHYSICS, type WaterBody } from '../../world/types';
import type { CompiledVehicle } from '../vehicle/types';
import { NODE_FLAG_COLLIDABLE, type SimState } from '../types';
import {
  AIR_POCKET_FRACTION,
  BOW_WAVE_K,
  BOW_WAVE_MAX_M,
  GLASS_STRAIN_MAX,
  GLASS_STRAIN_MIN,
  HYDROLOCK_MIN_RPM,
  ORIFICE_CD,
  TEAR_AREA_M2,
  TEAR_AREA_MAX_M2,
  VEHICLE_WATER_SPECS,
  type VehicleWaterSpec,
} from './specs';

/** Tyre section form-drag coefficient (a bluff, rounded section). */
export const WHEEL_DRAG_CD = 0.9;
/** Form drag share of a TRAILING wheel (in the wake of the leading wheels and the body: shielded). */
export const WHEEL_WAKE = 0.3;
/** Spin damping of a submerged wheel's nodes relative to its hub, 1/s (tread paddling). */
export const WHEEL_SPIN_DAMPING = 2;

export interface CompartmentRuntime {
  name: string;
  /** Object-local node indices of the shell. */
  nodes: Int32Array;
  /** Object-local beam indices: glass (open when broken) and structural (torn seams). */
  glass: Int32Array;
  tear: Int32Array;
  /** Open area per broken glass beam, m². */
  glassArea: number;
  /** Permanent openings: object-local node + area. */
  openNodes: Int32Array;
  openArea: Float64Array;
  airVolume: number;
  sealArea: number;
  /** Water inside, m³. */
  water: number;
  /** Diagnostics (world y): inside free surface, last tick; current open area, m². */
  surfaceY: number;
  openAreaNow: number;
}

export interface VehicleWaterState {
  spec: VehicleWaterSpec;
  bodyNodeCount: number;
  /** Object-local displaced volume per node, m³ (all nodes). */
  vol: Float64Array;
  /** Scratch: object-local submerged volume weight f_i·V_i (all nodes), this tick. */
  wsub: Float64Array;
  /** Wheels: object-local [nodeStart, nodeCount, hubI, hubO] per wheel, width (m) and radius (m). */
  wheels: Int32Array;
  wheelWidth: Float64Array;
  wheelRadius: Float64Array;
  comps: CompartmentRuntime[];
  /** Object-local intake node (−1 none). */
  intake: number;
  intakeOffset: number;
  /** Frame nodes (object-local origin, front, top) and rest half extents (length, width) + height of the body. */
  frame: Int32Array;
  halfL: number;
  halfW: number;
  height: number;
  /** 1 once water reached the running engine's intake (sticky until reset). */
  hydrolocked: number;
  /** Total water / total air volume of the compartments, 0..1. */
  flood: number;
  /** Diagnostics: submerged body volume m³ and the last form-drag force magnitude, N. */
  submergedVolume: number;
  dragForce: number;
}

/** True when `name` has a water spec (else the engine keeps the P5 law). */
export function hasVehicleWaterSpec(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VEHICLE_WATER_SPECS, name);
}

/** Builds the water runtime of a compiled vehicle (null without a spec). Throws on a spec that names unknown nodes. */
export function createVehicleWater(cv: CompiledVehicle): VehicleWaterState | null {
  if (!hasVehicleWaterSpec(nameOf(cv))) return null;
  const spec = VEHICLE_WATER_SPECS[nameOf(cv)]!;
  const r = cv.rig;
  const nb = cv.bodyNodeCount;
  const idx = (id: string): number => {
    const i = r.nodeIds.indexOf(id);
    if (i < 0 || i >= nb) throw new Error(`vehicle water (${nameOf(cv)}): unknown body node '${id}'`);
    return i;
  };
  const owner = new Int32Array(nb).fill(-1);
  const comps: CompartmentRuntime[] = spec.compartments.map((c, ci) => {
    const nodes: number[] = [];
    for (let i = 0; i < nb; i++) {
      const id = r.nodeIds[i]!;
      if (owner[i] === -1 && c.prefixes.some((p) => id.startsWith(p))) {
        nodes.push(i);
        owner[i] = ci;
      }
    }
    if (nodes.length === 0) throw new Error(`vehicle water (${nameOf(cv)}): compartment '${c.name}' matches no body node`);
    const open = c.openings ?? [];
    return {
      name: c.name,
      nodes: Int32Array.from(nodes),
      glass: new Int32Array(0),
      tear: new Int32Array(0),
      glassArea: 0,
      openNodes: Int32Array.from(open.map((o) => idx(o.node))),
      openArea: Float64Array.from(open.map((o) => o.area)),
      airVolume: c.airVolume,
      sealArea: c.sealArea,
      water: 0,
      surfaceY: 0,
      openAreaNow: 0,
    };
  });
  // Beams of each compartment (both ends in it): brittle glass vs structure.
  const glass: number[][] = comps.map(() => []);
  const tear: number[][] = comps.map(() => []);
  for (let b = 0; b < cv.bodyBeamCount; b++) {
    const a = r.beamA[b]!;
    const c = r.beamB[b]!;
    if (a >= nb || c >= nb) continue;
    const ca = owner[a]!;
    if (ca < 0 || ca !== owner[c]) continue;
    const k = r.beamK[b]!;
    const L = r.beamRestLen[b]!;
    const strain = r.beamBreakF[b]! / (k * L);
    const isGlass = r.beamDeform[b] === Infinity && strain > GLASS_STRAIN_MIN && strain < GLASS_STRAIN_MAX;
    if (isGlass) glass[ca]!.push(b);
    else if (Number.isFinite(r.beamBreakF[b]!)) tear[ca]!.push(b);
  }
  comps.forEach((c, ci) => {
    c.glass = Int32Array.from(glass[ci]!);
    c.tear = Int32Array.from(tear[ci]!);
    const ga = spec.compartments[ci]!.glazingArea;
    c.glassArea = c.glass.length > 0 ? ga / c.glass.length : 0;
  });
  // Displacement per node.
  const n = r.nodeCount;
  const vol = new Float64Array(n);
  const count = new Int32Array(comps.length);
  for (let i = 0; i < nb; i++) if (owner[i]! >= 0) count[owner[i]!]!++;
  for (let i = 0; i < n; i++) {
    const m = r.nodeInvMass[i]! > 0 ? 1 / r.nodeInvMass[i]! : 0;
    if (i >= nb) {
      vol[i] = m / WATER_PHYSICS.vehicleDensity;
      continue;
    }
    const ci = owner[i]!;
    // Solid share only: a compartment's air buoyancy is applied per compartment (stepVehicleWater §3).
    vol[i] = m / spec.solidDensity;
    void ci;
  }
  // Rest extents of the body (frame axes = rig axes at rest: forward −Z, up +Y, right +X).
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < nb; i++) {
    const x = r.nodePos[3 * i]!;
    const y = r.nodePos[3 * i + 1]!;
    const z = r.nodePos[3 * i + 2]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return {
    spec,
    bodyNodeCount: nb,
    vol,
    wsub: new Float64Array(n),
    wheels: Int32Array.from(cv.wheels.flatMap((wh) => [wh.nodeStart, wh.nodeCount, wh.hubI, wh.hubO])),
    wheelWidth: Float64Array.from(cv.wheels.map((wh) => wheelWidthOf(cv, wh.hubI, wh.hubO))),
    wheelRadius: Float64Array.from(cv.wheels.map((wh) => wh.radius)),
    comps,
    intake: spec.intake === null ? -1 : idx(spec.intake),
    intakeOffset: spec.intakeOffset,
    frame: Int32Array.from(cv.frameNodes),
    halfL: 0.5 * (z1 - z0),
    halfW: 0.5 * (x1 - x0),
    height: y1 - y0,
    hydrolocked: 0,
    flood: 0,
    submergedVolume: 0,
    dragForce: 0,
  };
}

/** Rest distance between a wheel's two hub nodes (its width), m. */
function wheelWidthOf(cv: CompiledVehicle, a: number, b: number): number {
  const p = cv.rig.nodePos;
  return Math.sqrt((p[3 * a]! - p[3 * b]!) ** 2 + (p[3 * a + 1]! - p[3 * b + 1]!) ** 2 + (p[3 * a + 2]! - p[3 * b + 2]!) ** 2);
}

/** Orifice flow (m³/s, + = inflow) through an opening of area `a` whose lower edge is at world `yo`, outside level `level`, inside surface `surf`. */
function orifice(level: number, surf: number, yo: number, a: number, twoG: number): number {
  const ho = level - yo;
  const hin = surf - yo;
  const dh = (ho > 0 ? ho : 0) - (hin > 0 ? hin : 0);
  if (dh === 0) return 0;
  return dh > 0 ? ORIFICE_CD * a * Math.sqrt(twoG * dh) : -ORIFICE_CD * a * Math.sqrt(-twoG * dh);
}

function nameOf(cv: CompiledVehicle): string {
  return cv.name;
}

/** Empties every compartment (reset / recover: the cabin drains). `clearHydrolock` on a full repair. */
export function drainVehicleWater(w: VehicleWaterState, clearHydrolock: boolean): void {
  for (let c = 0; c < w.comps.length; c++) w.comps[c]!.water = 0;
  w.flood = 0;
  if (clearHydrolock) w.hydrolocked = 0;
}

/**
 * One tick of vehicle water physics on nodes [first, first + count) of a
 * vehicle (see the header). `rpm` = the engine's crank speed this tick.
 * Returns the submerged body volume (0 = dry: nothing applied).
 */
export function stepVehicleWater(
  state: SimState,
  w: VehicleWaterState,
  first: number,
  count: number,
  beamStart: number,
  bodies: readonly WaterBody[],
  g: number,
  dt: number,
  rpm: number,
): number {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, flags, active } = state;
  const h = WATER_PHYSICS.nodeHalfDepth;
  const inv2h = 1 / (2 * h);
  const rhoW = WATER_PHYSICS.density;
  const lin = WATER_PHYSICS.linearDrag;
  const invDt = 1 / dt;
  const nb = bodies.length;
  const nBody = w.bodyNodeCount;
  const vol = w.vol;
  const wsub = w.wsub;
  // The vehicle's water body: the one under its frame origin (lakes are large; per-node rects below).
  const o0 = first + w.frame[0]!;
  let level = 0;
  let any = false;
  for (let k = 0; k < nb; k++) {
    const b = bodies[k]!;
    const x = posX[o0]!;
    const z = posZ[o0]!;
    if (x >= b.minX - 8 && x <= b.maxX + 8 && z >= b.minZ - 8 && z <= b.maxZ + 8) {
      level = b.level;
      any = true;
      break;
    }
  }
  // 1. Nodes: buoyancy + linear drag; wheel nodes also the P5 quadratic drag. Body COM velocity.
  let subV = 0;
  let subS = 0;
  let subM = 0;
  let M = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let yMin = Infinity;
  const end = first + count;
  for (let i = first; i < end; i++) {
    const im = invMass[i]!;
    const li = i - first;
    wsub[li] = 0;
    if (im === 0) continue;
    const m = 1 / im;
    const y = posY[i]!;
    if (li < nBody) {
      M += m;
      px += m * velX[i]!;
      py += m * velY[i]!;
      pz += m * velZ[i]!;
      if (y < yMin) yMin = y;
    }
    if ((flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue;
    const x = posX[i]!;
    const z = posZ[i]!;
    let lv = 0;
    let wet = false;
    for (let k = 0; k < nb; k++) {
      const b = bodies[k]!;
      if (y - h < b.level && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
        lv = b.level;
        wet = true;
        break;
      }
    }
    if (!wet) continue;
    let f = (lv - y + h) * inv2h;
    if (f > 1) f = 1;
    if (!(f > 0)) continue;
    const V = vol[li]!;
    const fb = rhoW * g * V * f;
    const vx = velX[i]!;
    const vy = velY[i]!;
    const vz = velZ[i]!;
    wsub[li] = f * V;
    if (li >= nBody) {
      // Wheel nodes: buoyancy here; drag per wheel below (translation of the hub, spin damping).
      frcY[i] = frcY[i]! + fb;
      continue;
    }
    subV += f * V;
    subS += f * V;
    subM += f * m;
    let c = f * lin * m;
    const cap = m * invDt;
    if (c > cap) c = cap;
    frcX[i] = frcX[i]! - c * vx;
    frcY[i] = frcY[i]! + fb - c * vy;
    frcZ[i] = frcZ[i]! - c * vz;
  }
  // Wheels: form drag of the submerged tyre section on the hub's velocity (½ρ·C_d·width·depth·|v|v, plus the
  // linear term), spread ∝ f·m over its nodes; a spinning wheel is slowed by WHEEL_SPIN_DAMPING on its nodes'
  // velocity relative to the hub (the tread paddles: real, but small for a road tyre).
  const wh = w.wheels;
  // Travel direction and mean hub position along it: wheels behind the mean are trailing (in the wake).
  let mvx = 0;
  let mvz = 0;
  let mpx = 0;
  let mpz = 0;
  for (let k = 0; k < wh.length; k += 4) {
    const hI = first + wh[k + 2]!;
    mvx += velX[hI]!;
    mvz += velZ[hI]!;
    mpx += posX[hI]!;
    mpz += posZ[hI]!;
  }
  const meanAlong = mpx * mvx + mpz * mvz;
  const nWheels = wh.length >> 2;
  for (let k = 0; k < wh.length; k += 4) {
    const ws = first + wh[k]!;
    const we = ws + wh[k + 1]!;
    const hI = first + wh[k + 2]!;
    const hO = first + wh[k + 3]!;
    let fm = 0;
    for (let i = ws; i < we; i++) {
      const im = invMass[i]!;
      if (im === 0) continue;
      const ws_ = wsub[i - first]!;
      if (ws_ > 0) fm += ws_ / (vol[i - first]! * im);
    }
    if (fm <= 0) continue;
    const hvx = 0.5 * (velX[hI]! + velX[hO]!);
    const hvy = 0.5 * (velY[hI]! + velY[hO]!);
    const hvz = 0.5 * (velZ[hI]! + velZ[hO]!);
    const hy = 0.5 * (posY[hI]! + posY[hO]!);
    const rad = w.wheelRadius[k >> 2]!;
    let dep = level - (hy - rad);
    if (dep > 2 * rad) dep = 2 * rad;
    if (dep < 0) dep = 0;
    const hv = Math.sqrt(hvx * hvx + hvy * hvy + hvz * hvz);
    const trailing = nWheels * (posX[hI]! * mvx + posZ[hI]! * mvz) < meanAlong;
    let c = 0.5 * rhoW * WHEEL_DRAG_CD * (trailing ? WHEEL_WAKE : 1) * w.wheelWidth[k >> 2]! * dep * hv + lin * fm;
    const cap = fm * invDt;
    if (c > cap) c = cap;
    const kx = (-c * hvx) / fm;
    const ky = (-c * hvy) / fm;
    const kz = (-c * hvz) / fm;
    for (let i = ws; i < we; i++) {
      const im = invMass[i]!;
      if (im === 0) continue;
      const wv = wsub[i - first]!;
      if (wv <= 0) continue;
      const fmi = wv / (vol[i - first]! * im); // f_i·m_i
      const sd = WHEEL_SPIN_DAMPING * fmi;
      frcX[i] = frcX[i]! + kx * fmi - sd * (velX[i]! - hvx);
      frcY[i] = frcY[i]! + ky * fmi - sd * (velY[i]! - hvy);
      frcZ[i] = frcZ[i]! + kz * fmi - sd * (velZ[i]! - hvz);
    }
  }
  w.dragForce = 0;
  // 3. Compartments (also while dry: a car pulled out drains through its openings).
  let totalWater = 0;
  let totalAir = 0;
  const twoG = 2 * g;
  for (let ci = 0; ci < w.comps.length; ci++) {
    const c = w.comps[ci]!;
    totalAir += c.airVolume;
    const cn = c.nodes;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < cn.length; k++) {
      const y = posY[first + cn[k]!]!;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const span = hi - lo > 0.05 ? hi - lo : 0.05;
    const full = c.airVolume * (1 - AIR_POCKET_FRACTION);
    const surf = lo + (c.water / c.airVolume) * span;
    c.surfaceY = surf;
    // Air buoyancy of the compartment: its volume below the outside water line (prismatic over the shell's
    // current height span), carried by the shell nodes under the water ∝ their depth (as the water inside).
    if (any && lo < level) {
      let sub = (level - lo) / span;
      if (sub > 1) sub = 1;
      let sw = 0;
      for (let k = 0; k < cn.length; k++) {
        const d = level - posY[first + cn[k]!]!;
        if (d > 0) sw += d;
      }
      if (sw > 0) {
        const B = (rhoW * g * c.airVolume * sub) / sw;
        for (let k = 0; k < cn.length; k++) {
          const i = first + cn[k]!;
          const d = level - posY[i]!;
          if (d > 0) frcY[i] = frcY[i]! + B * d;
        }
        subV += c.airVolume * sub;
      }
    }
    if (c.water <= 0 && (!any || lo >= level)) {
      c.openAreaNow = 0;
      continue;
    }
    // Orifice flow through every open opening at its lower edge.
    const lvl = any ? level : -Infinity;
    let q = orifice(lvl, surf, lo + 0.1 * span, c.sealArea, twoG);
    let area = 0;
    area += c.sealArea;
    const gl = c.glass;
    for (let k = 0; k < gl.length; k++) {
      const b = gl[k]!;
      if (active[beamStart + b] !== 0) continue;
      const ya = posY[state.aIdx[beamStart + b]!]!;
      const yb = posY[state.bIdx[beamStart + b]!]!;
      q += orifice(lvl, surf, ya < yb ? ya : yb, c.glassArea, twoG);
      area += c.glassArea;
    }
    const tr = c.tear;
    let tornArea = 0;
    for (let k = 0; k < tr.length && tornArea < TEAR_AREA_MAX_M2; k++) {
      const b = tr[k]!;
      if (active[beamStart + b] !== 0) continue;
      const ya = posY[state.aIdx[beamStart + b]!]!;
      const yb = posY[state.bIdx[beamStart + b]!]!;
      q += orifice(lvl, surf, 0.5 * (ya + yb), TEAR_AREA_M2, twoG);
      tornArea += TEAR_AREA_M2;
    }
    area += tornArea;
    for (let k = 0; k < c.openNodes.length; k++) {
      q += orifice(lvl, surf, posY[first + c.openNodes[k]!]!, c.openArea[k]!, twoG);
      area += c.openArea[k]!;
    }
    c.openAreaNow = area;
    let wv = c.water + q * dt;
    if (wv < 0) wv = 0;
    if (wv > full) wv = full;
    c.water = wv;
    totalWater += wv;
    if (wv <= 0) continue;
    // The water's weight on the shell nodes below the free surface, ∝ their depth under it.
    const surf2 = lo + (wv / c.airVolume) * span;
    c.surfaceY = surf2;
    let sw = 0;
    for (let k = 0; k < cn.length; k++) {
      const d = surf2 - posY[first + cn[k]!]!;
      if (d > 0) sw += d;
    }
    if (sw > 0) {
      const W = (rhoW * g * wv) / sw;
      for (let k = 0; k < cn.length; k++) {
        const i = first + cn[k]!;
        const d = surf2 - posY[i]!;
        if (d > 0) frcY[i] = frcY[i]! - W * d;
      }
    }
  }
  w.flood = totalAir > 0 ? totalWater / totalAir : 0;
  w.submergedVolume = subV;
  if (!any || subS <= 0 || M <= 0) return subV;
  // 2. Body form drag on the COM velocity over the submerged projected area.
  const vcx = px / M;
  const vcy = py / M;
  const vcz = pz / M;
  const v2 = vcx * vcx + vcy * vcy + vcz * vcz;
  const f0 = first + w.frame[0]!;
  const f1 = first + w.frame[1]!;
  const f2 = first + w.frame[2]!;
  let fx = posX[f1]! - posX[f0]!;
  let fy = posY[f1]! - posY[f0]!;
  let fz = posZ[f1]! - posZ[f0]!;
  let fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (fl < 1e-9) fl = 1e-9;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let ux = posX[f2]! - posX[f0]!;
  let uy = posY[f2]! - posY[f0]!;
  let uz = posZ[f2]! - posZ[f0]!;
  const ud = ux * fx + uy * fy + uz * fz;
  ux -= ud * fx;
  uy -= ud * fy;
  uz -= ud * fz;
  let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (ul < 1e-9) ul = 1e-9;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const rx = fy * uz - fz * uy;
  const ry = fz * ux - fx * uz;
  const rz = fx * uy - fy * ux;
  if (v2 > 1e-8) {
    const v = Math.sqrt(v2);
    const dx = vcx / v;
    const dy = vcy / v;
    const dz = vcz / v;
    let depth = level - yMin;
    if (depth > w.height) depth = w.height;
    if (depth < 0) depth = 0;
    const af = dx * fx + dy * fy + dz * fz;
    const ar = dx * rx + dy * ry + dz * rz;
    const au = dx * ux + dy * uy + dz * uz;
    const L = 2 * w.halfL;
    const W = 2 * w.halfW;
    const A = (af < 0 ? -af : af) * W * depth + (ar < 0 ? -ar : ar) * L * depth + (au < 0 ? -au : au) * L * W * (depth / w.height);
    let F = 0.5 * rhoW * w.spec.dragCoeff * A * v2;
    const capF = subM * v * invDt;
    if (F > capF) F = capF;
    w.dragForce = F;
    const kx = (-F * dx) / subS;
    const ky = (-F * dy) / subS;
    const kz = (-F * dz) / subS;
    const nB = first + nBody;
    for (let i = first; i < nB; i++) {
      const ws = wsub[i - first]!;
      if (ws <= 0) continue;
      frcX[i] = frcX[i]! + kx * ws;
      frcY[i] = frcY[i]! + ky * ws;
      frcZ[i] = frcZ[i]! + kz * ws;
    }
  }
  // 4. Hydrolock: the intake under the water (+ the bow wave) while the crank turns.
  if (w.intake >= 0 && w.hydrolocked === 0 && rpm > HYDROLOCK_MIN_RPM) {
    const ii = first + w.intake;
    const iy = posY[ii]! + w.intakeOffset * uy;
    const vf = vcx * fx + vcy * fy + vcz * fz;
    let bow = vf > 0 && level - yMin > 0.15 ? (BOW_WAVE_K * vf * vf) / twoG : 0;
    if (bow > BOW_WAVE_MAX_M) bow = BOW_WAVE_MAX_M;
    if (iy < level + bow) w.hydrolocked = 1;
  }
  return subV;
}
