/**
 * Powertrain metrics (harness only): steady-speed fuel consumption, idle
 * fuel flow, coast-down road-load fit, manual-clutch stall / starter.
 */
import type { DrivetrainStateEx } from '../drivetrain';
import { createHandlingSim, kinematics, setMotion, stepN, type HandlingSim } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import type { TransmissionMode, VehicleDef } from '../types';

const DT = 1 / 2000;

export function engineSys(sim: HandlingSim): VehicleRuntimeEx['engineSys'] {
  return (sim.veh as VehicleRuntimeEx).engineSys;
}
export function dtState(sim: HandlingSim): DrivetrainStateEx {
  return sim.veh.drivetrain as DrivetrainStateEx;
}
/** The gear an automatic would hold at v: the highest with the engine ≥ 1.6 × idle (1st when none). */
export function gearFor(sim: HandlingSim, v: number): number {
  const d = sim.cv.drivetrain;
  const r = sim.veh.wheels[0]!.rollRadius;
  let gear = 1;
  for (let g = 1; g <= d.gearCount; g++) {
    const rpm = ((v / r) * d.gearRatioTable[g + 1]! * d.finalDrive * 60) / (2 * Math.PI);
    if (rpm >= 1.6 * d.idleRpm && rpm <= 0.9 * d.redlineRpm) gear = g;
  }
  return gear;
}
const speedOf = (sim: HandlingSim): number => {
  const k = kinematics(sim);
  return Math.hypot(k.vx, k.vz);
};

export interface CruiseResult {
  lPer100km: number;
  rpm: number;
  gear: number;
  throttle: number;
  coolantC: number;
}

/** Holds `kmh` with a PI throttle in auto (top gear by the box's own choice), then measures fuel over `measureS`. */
export function runCruise(def: VehicleDef, kmh: number, measureS = 8): CruiseResult {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const v0 = kmh / 3.6;
  setMotion(sim, v0, gearFor(sim, v0));
  let integ = 0.2;
  let fuel0 = 0;
  let x0 = 0;
  let z0 = 0;
  const settle = 6;
  const total = settle + measureS;
  let rpm = 0;
  let gear = 0;
  let thr = 0;
  let n = 0;
  for (let t = 0; t < total / DT; t++) {
    if (t % 20 === 0) {
      const e = v0 - speedOf(sim);
      integ += 0.02 * e * (20 * DT) * 50;
      if (integ < 0) integ = 0;
      if (integ > 1) integ = 1;
      let u = integ + 0.15 * e;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      sim.eng.setInput(1, { gearSelect: 1, throttle: u, brake: 0 });
    }
    sim.eng.step();
    if (t === Math.round(settle / DT)) {
      fuel0 = engineSys(sim).fuelL;
      const k = kinematics(sim);
      x0 = k.cx;
      z0 = k.cz;
    }
    if (t > settle / DT) {
      const d = dtState(sim);
      rpm += d.rpm;
      gear += d.gear;
      thr += d.throttle;
      n++;
    }
  }
  const k = kinematics(sim);
  const dist = Math.hypot(k.cx - x0, k.cz - z0);
  const used = fuel0 - engineSys(sim).fuelL;
  return { lPer100km: (used / dist) * 1e5, rpm: rpm / n, gear: gear / n, throttle: thr / n, coolantC: engineSys(sim).coolantC };
}

/** Idle fuel flow, L/h (parked in neutral, warm). */
export function runIdle(def: VehicleDef, seconds = 4): number {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const f0 = engineSys(sim).fuelL;
  for (let t = 0; t < seconds / DT; t++) {
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
    sim.eng.step();
  }
  return ((f0 - engineSys(sim).fuelL) / seconds) * 3600;
}

export interface LaunchResult {
  sim: HandlingSim;
  stalled: boolean;
  minRpm: number;
  speedAfter: number;
}

/**
 * Manual box with the clutch assist off: hold the clutch down in 1st at `rpm`
 * (throttle holds it), then release the pedal over `releaseS`.
 */
export function runClutchLaunch(def: VehicleDef, throttle: number, releaseS: number, transmission: TransmissionMode = 'manual', clutchAssist = false): LaunchResult {
  const sim = createHandlingSim({ def, transmission });
  sim.eng.setAssists(1, { clutchAssist });
  stepN(sim, 3000);
  // clutch down, 1st, rev
  for (let t = 0; t < 1 / DT; t++) {
    sim.eng.setInput(1, { gearSelect: 1, clutch: 1, throttle, brake: 0 });
    sim.eng.step();
  }
  let minRpm = Infinity;
  let stalled = false;
  const n = Math.max(1, Math.round(releaseS / DT));
  for (let t = 0; t < 3 / DT; t++) {
    const c = t < n ? 1 - t / n : 0;
    sim.eng.setInput(1, { gearSelect: 1, clutch: c, throttle, brake: 0 });
    sim.eng.step();
    const d = dtState(sim);
    if (d.rpm < minRpm) minRpm = d.rpm;
    if (d.engineOn === 0) stalled = true;
  }
  return { sim, stalled, minRpm, speedAfter: speedOf(sim) };
}

/** After a stall: clutch down + throttle cranks; returns seconds until the engine runs (Infinity = never in 3 s). */
export function runRestart(sim: HandlingSim): number {
  for (let t = 0; t < 3 / DT; t++) {
    sim.eng.setInput(1, { gearSelect: 1, clutch: 1, throttle: 0.5, brake: 1 });
    sim.eng.step();
    if (dtState(sim).engineOn !== 0) return t * DT;
  }
  return Infinity;
}

/** Full throttle in auto from `fromKmh` for `seconds`: the highest speed reached, km/h. */
export function runTopSpeed(def: VehicleDef, fromKmh: number, seconds = 30): number {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  setMotion(sim, fromKmh / 3.6, gearFor(sim, fromKmh / 3.6));
  let vmax = 0;
  for (let t = 0; t < seconds / DT; t++) {
    sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0 });
    sim.eng.step();
    if (t % 200 === 0) vmax = Math.max(vmax, speedOf(sim) * 3.6);
  }
  return vmax;
}

export { setMotion };
