/**
 * R-PHYS: engine systems (new module; runs around stepDrivetrain in the
 * vehicle pre-step): fuel, cooling, lubrication, engine health, stall and
 * starter. The drivetrain reads four DrivetrainStateEx fields set here
 * (engineOn, powerFactor, cranking / starterTorque, seized); everything else
 * lives in EngineSystemsState.
 *
 * FUEL — Willans line: fuel power = (P_brake⁺ + P_acc + P_friction + P_pumping) / η_i,
 *   P_acc = 400 W + 120 W per litre (alternator, pumps).
 *   P_friction = FMEP·V_d·ω/4π, FMEP = 0.8·(0.97 + 0.15·N + 0.05·N²) bar,
 *   N = rpm/1000 (Heywood, "Internal Combustion Engine Fundamentals" 1988,
 *   eq. 13.18 after Patton–Nitschke–Heywood; × 0.8 for a modern low-friction
 *   engine). Petrol pumping PMEP = 0.8·(1 − throttle) bar (part-throttle
 *   manifold vacuum); diesels are unthrottled. η_i 0.40 petrol / 0.46 diesel
 *   (gross indicated). Throttle shut above idle + 300 rpm on the overrun
 *   cuts the fuel (DFCO). Energy per litre 32.0 MJ petrol (LHV 43 MJ/kg ×
 *   0.745 kg/L) / 35.8 MJ diesel. An empty tank kills the engine.
 * COOLING — lumped block + coolant, C·dT/dt = 0.25·P_fuel − Q_rad − Q_nat:
 *   ≈ 25 % of the fuel energy reaches the coolant (Heywood ch. 12: 17–35 %).
 *   Q_rad = open(T)·level·(UA_fan·fan + UA_ram·v/30)·(T − T_amb), thermostat
 *   88 → 98 °C, fan on above 95 °C; UA sized from rated power so full power
 *   at 200 km/h holds ≈ 95–105 °C. A punctured radiator leaks (level falls,
 *   capacity falls with it): above 115 °C the ECU derates (powerFactor 1 →
 *   0.3 at 135 °C); above 130 °C the engine loses health ∝ (T − 130).
 * LUBRICATION — oil level 0..1; a pan strike (an engine 'lo' node hitting the
 *   ground at > 1.5 m/s) cracks the sump; below 30 % the oil pressure
 *   collapses and health falls ∝ rpm (≈ 90 s to seizure at 4000 rpm dry).
 * HEALTH 0 → seized: the engine stops, locks, and the starter cannot turn it.
 * STALL / STARTER — below STALL_RPM_FRACTION × idle the engine stalls (only a
 *   manual with the clutch assist off can drag it there). Starter: throttle
 *   with the clutch pedal down (or neutral) cranks at ≈ 250 rpm; after
 *   CRANK_S it fires if there is fuel and the engine is not seized.
 *
 * HOT LOOP: + − × ÷ sqrt only, zero allocation.
 */
import type { SimState } from '../types';
import type { DrivetrainStateEx } from './drivetrain';
import type { CompiledVehicle, VehicleRuntime } from './types';

export const AMBIENT_C = 25;
export const STALL_RPM_FRACTION = 0.45;
export const CRANK_RPM = 250;
export const CRANK_S = 0.6;
/** Bump start: the road must spin the engine above this through the engaged clutch, after the engine has been off this long. */
export const BUMP_START_RPM = 500;
/** After firing, the stall check waits this long (the engine catches and revs to idle), s. */
export const CATCH_S = 0.5;
export const BUMP_START_DELAY_S = 0.5;
export const THERMOSTAT_OPEN_C = 88;
export const THERMOSTAT_FULL_C = 98;
export const FAN_ON_C = 95;
export const DERATE_START_C = 115;
export const DERATE_FULL_C = 135;
export const DAMAGE_START_C = 130;
export const COOLANT_SHARE = 0.25;
/** Accessory drive (alternator, water / power-steering pumps), W: base + per litre of displacement. */
export const ACCESSORY_W = 400;
export const ACCESSORY_W_PER_L = 120;
/** Block / bay natural convection with the thermostat shut, W/K per J/K of thermal mass (≈ 28 W/K for a 3 L). */
export const NATURAL_UA_PER_CAP = 0.0008;
export const LOW_OIL = 0.3;
/** Radiator support pushed back relative to the frame origin: leak starts / is total, m. */
export const RADIATOR_CRUSH_LO = 0.04;
export const RADIATOR_CRUSH_HI = 0.15;
/** Coolant leak at a destroyed radiator, level fraction per s (≈ 50 s to empty). */
export const RADIATOR_LEAK_MAX = 0.02;
/** Sump strike: downward node speed that cracks the pan, m/s; leak per (m/s) of excess, level fraction per s. */
export const PAN_STRIKE_SPEED = 1.5;
export const PAN_LEAK_PER_MS = 0.004;

export interface EngineSpec {
  displacementL: number;
  diesel: boolean;
  tankL: number;
  startFuelL: number;
}

export interface EngineSystemsState {
  spec: EngineSpec;
  /** Displacement m³, η_i, J per litre, thermal mass J/K, radiator UA (fan, ram per 30 m/s) W/K. */
  vd: number;
  etaI: number;
  jPerL: number;
  heatCap: number;
  uaFan: number;
  uaRam: number;
  fuelL: number;
  /** Instantaneous fuel flow, L/h. */
  fuelRateLph: number;
  coolantC: number;
  coolantLevel: number;
  oilLevel: number;
  health: number;
  radiatorDamage: number;
  oilLeak: number;
  seized: number;
  stalled: number;
  crankT: number;
  /** Seconds since the engine stopped (bump-start guard). */
  offT: number;
  /** Seconds since the engine started running. */
  runT: number;
  /** Rig-local radiator support nodes, the frame origin, the sump (engine 'lo') nodes; rest radiator distance, m. */
  radNodes: Int32Array;
  panNodes: Int32Array;
  radRest: number;
}

const BAR = 1e5;
const INV_4PI = 1 / (4 * Math.PI);
const RPM_PER_RAD_S = 60 / (2 * Math.PI);

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Engine spec from DrivetrainDef.engine, or estimated from the torque curve (≈ 110 N·m per litre, petrol, 60 L tank). */
export function engineSpecOf(v: CompiledVehicle): EngineSpec {
  const e = v.drivetrain.engine;
  let peak = 0;
  const lut = v.drivetrain.torqueLut;
  for (let i = 0; i < lut.length; i++) if (lut[i]! > peak) peak = lut[i]!;
  const displacementL = e?.displacementL ?? Math.max(1, peak / 110);
  const tankL = e?.tankL ?? 60;
  return { displacementL, diesel: e?.fuel === 'diesel', tankL, startFuelL: e?.startFuelL ?? 0.75 * tankL };
}

export function createEngineSystems(v: CompiledVehicle): EngineSystemsState {
  const spec = engineSpecOf(v);
  const rig = v.rig;
  const rad: number[] = [];
  const pan: number[] = [];
  for (let i = 0; i < v.bodyNodeCount; i++) {
    const id = rig.nodeIds[i]!;
    if (/^s\d+_r[st]$/.test(id)) rad.push(i);
    else if (/^eng_[fr]lo_[LR]$/.test(id)) pan.push(i);
  }
  // rated power from the torque LUT (W)
  let pMax = 0;
  const lut = v.drivetrain.torqueLut;
  const step = v.drivetrain.lutStepRpm;
  for (let i = 0; i < lut.length; i++) {
    const p = lut[i]! * ((i * step) / RPM_PER_RAD_S);
    if (p > pMax) pMax = p;
  }
  const o = v.frameNodes[0]!;
  let radRest = 0;
  if (rad.length > 0) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const i of rad) {
      x += rig.nodePos[3 * i]!;
      y += rig.nodePos[3 * i + 1]!;
      z += rig.nodePos[3 * i + 2]!;
    }
    const n = rad.length;
    radRest = Math.hypot(x / n - rig.nodePos[3 * o]!, y / n - rig.nodePos[3 * o + 1]!, z / n - rig.nodePos[3 * o + 2]!);
  }
  const L = spec.displacementL;
  const s: EngineSystemsState = {
    spec,
    vd: L * 1e-3,
    etaI: spec.diesel ? 0.46 : 0.4,
    jPerL: spec.diesel ? 35.8e6 : 32.0e6,
    heatCap: spec.diesel ? 20e3 * L + 15e3 : 15e3 * L + 10e3,
    uaFan: 0.0018 * pMax,
    uaRam: 0.0045 * pMax,
    fuelL: spec.startFuelL,
    fuelRateLph: 0,
    coolantC: 90,
    coolantLevel: 1,
    oilLevel: 1,
    health: 1,
    radiatorDamage: 0,
    oilLeak: 0,
    seized: 0,
    stalled: 0,
    crankT: 0,
    offT: 0,
    runT: 10,
    radNodes: Int32Array.from(rad),
    panNodes: Int32Array.from(pan),
    radRest,
  };
  return s;
}

/** Full repair: a fresh, warm engine with the starting fuel. */
export function resetEngineSystems(s: EngineSystemsState): void {
  s.fuelL = s.spec.startFuelL;
  s.fuelRateLph = 0;
  s.coolantC = 90;
  s.coolantLevel = 1;
  s.oilLevel = 1;
  s.health = 1;
  s.radiatorDamage = 0;
  s.oilLeak = 0;
  s.seized = 0;
  s.stalled = 0;
  s.crankT = 0;
  s.offT = 0;
  s.runT = 10;
}

/** ECU over-temperature derate: 1 up to DERATE_START_C, 0.3 from DERATE_FULL_C. */
export function heatDerate(tC: number): number {
  if (tC <= DERATE_START_C) return 1;
  if (tC >= DERATE_FULL_C) return 0.3;
  return 1 - (0.7 * (tC - DERATE_START_C)) / (DERATE_FULL_C - DERATE_START_C);
}

/** Before stepDrivetrain: starter, derate, seizure flags into the drivetrain state. */
export function engineSystemsPre(es: EngineSystemsState, d: DrivetrainStateEx, throttle: number, clutch: number, select: number, dt: number): void {
  d.seized = es.seized;
  d.powerFactor = heatDerate(es.coolantC);
  if (d.engineOn !== 0) {
    d.cranking = 0;
    es.crankT = 0;
    return;
  }
  const can = es.seized === 0 && es.fuelL > 0 && es.health > 0;
  if (can && throttle > 0.3 && (clutch >= 0.9 || select === 0)) {
    d.cranking = 1;
    es.crankT += dt;
    if (es.crankT >= CRANK_S && d.rpm >= 0.8 * CRANK_RPM) {
      d.engineOn = 1;
      d.cranking = 0;
      es.crankT = 0;
      es.stalled = 0;
    }
  } else {
    d.cranking = 0;
    es.crankT = 0;
  }
}

/**
 * After stepDrivetrain: stall / bump start, fuel, coolant, oil, health.
 * `speed` = vehicle speed for the radiator airflow, m/s.
 */
export function engineSystemsPost(es: EngineSystemsState, d: DrivetrainStateEx, idleRpm: number, clutchApplied: number, speed: number, dt: number): void {
  const rpm = d.rpm;
  const om = d.engineOmega;
  // only a pedal-operated clutch can drag the engine below idle: the automatic clutch / torque converter opens
  const pedalOnly = d.transmission === 'manual' && !d.clutchAssist;
  es.offT = d.engineOn !== 0 ? 0 : es.offT + dt;
  es.runT = d.engineOn !== 0 ? es.runT + dt : 0;
  if (d.engineOn !== 0) {
    // a just-fired engine needs ≈ 0.3–0.5 s to catch and rev up to idle
    if (pedalOnly && d.cranking === 0 && es.runT > CATCH_S && rpm < STALL_RPM_FRACTION * idleRpm) {
      d.engineOn = 0;
      es.stalled = 1;
    }
  } else if (es.seized === 0 && es.fuelL > 0 && es.health > 0 && clutchApplied < 0.5 && es.offT > BUMP_START_DELAY_S && rpm > BUMP_START_RPM) {
    // bump start: the road turns the engine through the engaged clutch
    d.engineOn = 1;
    es.stalled = 0;
  }
  // ---- fuel
  let pFuel = 0;
  if (d.engineOn !== 0) {
    const n = rpm * 0.001;
    const dfco = d.throttle < 0.02 && rpm > idleRpm + 300;
    if (!dfco) {
      const pB = d.engineTorque > 0 ? d.engineTorque * om : 0;
      const fmep = 0.8 * BAR * (0.97 + 0.15 * n + 0.05 * n * n);
      const pmep = es.spec.diesel ? 0 : 0.8 * BAR * (1 - clamp01(d.throttle));
      pFuel = (pB + ACCESSORY_W + ACCESSORY_W_PER_L * es.spec.displacementL + (fmep + pmep) * es.vd * om * INV_4PI) / es.etaI;
    }
    const lps = pFuel / es.jPerL;
    es.fuelL -= lps * dt;
    es.fuelRateLph = lps * 3600;
    if (es.fuelL <= 0) {
      es.fuelL = 0;
      d.engineOn = 0;
    }
  } else {
    es.fuelRateLph = 0;
  }
  // ---- coolant
  const T = es.coolantC;
  const open = T <= THERMOSTAT_OPEN_C ? 0.03 : T >= THERMOSTAT_FULL_C ? 1 : 0.03 + (0.97 * (T - THERMOSTAT_OPEN_C)) / (THERMOSTAT_FULL_C - THERMOSTAT_OPEN_C);
  const av = speed < 0 ? -speed : speed;
  const air = av > 60 ? 2 : av / 30;
  const fan = T > FAN_ON_C && d.engineOn !== 0 ? 1 : 0.15;
  const ua = open * es.coolantLevel * (es.uaFan * fan + es.uaRam * air) + NATURAL_UA_PER_CAP * es.heatCap;
  const cap = es.heatCap * (0.6 + 0.4 * es.coolantLevel);
  es.coolantC = T + ((COOLANT_SHARE * pFuel - ua * (T - AMBIENT_C)) * dt) / cap;
  if (es.radiatorDamage > 0 && es.coolantLevel > 0) {
    es.coolantLevel -= RADIATOR_LEAK_MAX * es.radiatorDamage * dt;
    if (es.coolantLevel < 0) es.coolantLevel = 0;
  }
  // ---- oil
  if (es.oilLeak > 0 && es.oilLevel > 0) {
    es.oilLevel -= es.oilLeak * dt;
    if (es.oilLevel < 0) es.oilLevel = 0;
  }
  // ---- health
  if (d.engineOn !== 0) {
    let wear = 0;
    if (es.coolantC > DAMAGE_START_C) wear += (es.coolantC - DAMAGE_START_C) / 600;
    if (es.oilLevel < LOW_OIL) wear += ((rpm / 4000) * (LOW_OIL - es.oilLevel)) / (LOW_OIL * 90);
    if (wear > 0) {
      es.health -= wear * dt;
      if (es.health <= 0) {
        es.health = 0;
        es.seized = 1;
        d.engineOn = 0;
        d.seized = 1;
      }
    }
  }
}

/**
 * Damage detection (every tick, a few nodes): radiator support pushed back
 * toward the frame origin (plastic crush of the nose) → radiator leak; an
 * engine sump node hitting the ground hard → oil leak. Both only grow.
 */
export function detectEngineDamage(state: SimState, v: VehicleRuntime, es: EngineSystemsState): void {
  const base = v.nodeStart;
  const { posX, posY, posZ, velY, flags } = state;
  const rn = es.radNodes;
  if (rn.length > 0 && es.radiatorDamage < 1) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < rn.length; k++) {
      const g = base + rn[k]!;
      x += posX[g]!;
      y += posY[g]!;
      z += posZ[g]!;
    }
    const inv = 1 / rn.length;
    const o = base + v.vehicle.frameNodes[0]!;
    const dx = x * inv - posX[o]!;
    const dy = y * inv - posY[o]!;
    const dz = z * inv - posZ[o]!;
    const crush = es.radRest - Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (crush > RADIATOR_CRUSH_LO) {
      const dmg = clamp01((crush - RADIATOR_CRUSH_LO) / (RADIATOR_CRUSH_HI - RADIATOR_CRUSH_LO));
      if (dmg > es.radiatorDamage) es.radiatorDamage = dmg;
    }
  }
  const pn = es.panNodes;
  for (let k = 0; k < pn.length; k++) {
    const g = base + pn[k]!;
    if ((flags[g]! & 2) === 0) continue; // NODE_FLAG_IN_CONTACT
    const vy = -velY[g]!;
    if (vy > PAN_STRIKE_SPEED) {
      const leak = PAN_LEAK_PER_MS * (vy - PAN_STRIKE_SPEED);
      if (leak > es.oilLeak) es.oilLeak = leak;
    }
  }
}
