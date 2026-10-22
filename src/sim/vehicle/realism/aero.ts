/**
 * Aero metrics (harness only): per-axle lift at speed (axle loads with the
 * def's lift vs without) and a coast-down road-load fit F = A + B·v + C·v²
 * (SAE J2263 practice) from short neutral coasts.
 */
import { createHandlingSim, kinematics, setMotion, stepN, type HandlingSim } from '../handling';
import type { VehicleDef } from '../types';

const DT = 1 / 2000;
const speedOf = (sim: HandlingSim): number => {
  const k = kinematics(sim);
  return Math.hypot(k.vx, k.vz);
};

/** Mean front / rear axle loads (Σ wheel load, N) while coasting at ≈ kmh for 1 s. */
export function axleLoadsAt(def: VehicleDef, kmh: number): { front: number; rear: number; v: number } {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  setMotion(sim, kmh / 3.6, 0);
  stepN(sim, 1000);
  let f = 0;
  let r = 0;
  let v = 0;
  const n = 2000;
  for (let t = 0; t < n; t++) {
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
    sim.eng.step();
    for (const w of sim.veh.wheels) {
      if (w.wheel.axle === 'front') f += w.load;
      else r += w.load;
    }
    v += speedOf(sim);
  }
  return { front: f / n, rear: r / n, v: v / n };
}

export interface CoastFit {
  A: number;
  B: number;
  C: number;
  points: [number, number][];
}

/** Neutral coasts of `windowS` from each start speed; force = m·decel at the window's mean speed; least squares A + Bv + Cv². */
export function coastDownFit(def: VehicleDef, kmhs = [40, 60, 80, 100, 120, 140], windowS = 2.5): CoastFit {
  const pts: [number, number][] = [];
  let mass = 0;
  for (const kmh of kmhs) {
    const sim = createHandlingSim({ def });
    mass = sim.cv.totalMass;
    stepN(sim, 3000);
    setMotion(sim, kmh / 3.6, 0);
    stepN(sim, 1000);
    const v0 = speedOf(sim);
    let vs = 0;
    const n = Math.round(windowS / DT);
    for (let t = 0; t < n; t++) {
      sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
      sim.eng.step();
      vs += speedOf(sim);
    }
    const v1 = speedOf(sim);
    pts.push([vs / n, (mass * (v0 - v1)) / windowS]);
  }
  // normal equations for [1, v, v²]
  const S = [0, 0, 0, 0, 0];
  const Y = [0, 0, 0];
  for (const [v, F] of pts) {
    for (let p = 0; p < 5; p++) S[p] = S[p]! + v ** p;
    for (let p = 0; p < 3; p++) Y[p] = Y[p]! + F * v ** p;
  }
  const M = [
    [S[0]!, S[1]!, S[2]!],
    [S[1]!, S[2]!, S[3]!],
    [S[2]!, S[3]!, S[4]!],
  ];
  const det = (m: number[][]): number => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(M);
  const col = (k: number): number[][] => M.map((row, i) => row.map((x, j) => (j === k ? Y[i]! : x)));
  return { A: det(col(0)) / D, B: det(col(1)) / D, C: det(col(2)) / D, points: pts };
}

/**
 * Steady-state road load at `kmh`, N: fixed gear (no shift transients), PI cruise, then the driven
 * wheels' drive force minus m·a over a 2 s window (realism road-load probe).
 */
export function steadyRoadLoad(def: VehicleDef, kmh: number): number {
  const sim = createHandlingSim({ def, transmission: 'manual' });
  stepN(sim, 2000);
  const v0 = kmh / 3.6;
  const dtc = sim.cv.drivetrain;
  const r = sim.veh.wheels[0]!.rollRadius;
  let gear = 0;
  for (let g = 1; g <= dtc.gearCount; g++) {
    const rpm = ((v0 / r) * dtc.gearRatioTable[g + 1]! * dtc.finalDrive * 60) / (2 * Math.PI);
    if (rpm <= 0.9 * dtc.redlineRpm && (gear === 0 || rpm >= 0.35 * dtc.redlineRpm)) gear = g;
  }
  setMotion(sim, v0, gear);
  let integ = 0.3;
  let f = 0;
  let n = 0;
  let vA = 0;
  for (let t = 0; t < 5 / DT; t++) {
    if (t % 10 === 0) {
      const e = v0 - speedOf(sim);
      integ = Math.min(1, Math.max(0, integ + 0.5 * e * 10 * DT));
      sim.eng.setInput(1, { gearSelect: gear, throttle: Math.min(1, Math.max(0, integ + 0.3 * e)), brake: 0 });
    }
    sim.eng.step();
    if (t === Math.round(3 / DT)) vA = speedOf(sim);
    if (t > 3 / DT) {
      for (const w of sim.veh.wheels) f += w.driveTorque / w.rollRadius;
      n++;
    }
  }
  const acc = (speedOf(sim) - vA) / 2;
  return f / n - sim.cv.totalMass * acc;
}
