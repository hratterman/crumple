/**
 * Driveline metrics (harness only): split-μ launch for the differential
 * torque split. One driven tyre stands on "ice" (its tyre base μ × 0.15),
 * full throttle in 1st with TC / ESC off; the per-wheel drive torques the
 * differential delivers are averaged while the low-μ wheel spins.
 */
import { createHandlingSim, kinematics, stepN } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import type { VehicleDef } from '../types';

const DT = 1 / 2000;

export interface SplitMuResult {
  /** Mean drive torque of the low-μ and the high-μ driven wheel, N·m (wheel side), and their sum. */
  tLow: number;
  tHigh: number;
  tIn: number;
  /** Mean wheel-speed difference high − low over the window, rad/s (negative = the ice wheel spins up). */
  dOmega: number;
  /** Mean forward acceleration over the window, m/s². */
  accel: number;
  /** Ice wheel tread-speed / car speed at the end (wheelspin ratio). */
  spin: number;
}

export function runSplitMu(def: VehicleDef, iceFactor = 0.15, t0 = 0.4, t1 = 1.4, throttle = 1): SplitMuResult {
  const sim = createHandlingSim({ def });
  sim.eng.setAssists(1, { tractionControl: false, esc: false, abs: false });
  stepN(sim, 3000);
  const veh = sim.veh as VehicleRuntimeEx;
  const driven = Array.from(sim.cv.drivetrain.drivenWheels);
  // the first driven wheel on the left side goes on ice
  const ice = driven.find((w) => sim.eng.state.posX[veh.wheels[w]!.hubO]! < 0) ?? driven[0]!;
  const high = driven.find((w) => w !== ice && veh.wheels[w]!.wheel.axle === veh.wheels[ice]!.wheel.axle)!;
  const tb = veh.tyres[ice]!;
  for (let j = 0; j < tb.base.length; j++) tb.base[j] = tb.base[j]! * iceFactor;
  let tL = 0;
  let tH = 0;
  let dw = 0;
  let n = 0;
  let v0 = 0;
  let tA = 0;
  for (let t = 0; t < t1 / DT; t++) {
    sim.eng.setInput(1, { gearSelect: 1, throttle, brake: 0, handbrake: 0 });
    sim.eng.step();
    const time = t * DT;
    if (time >= t0) {
      if (n === 0) {
        const k = kinematics(sim);
        v0 = Math.hypot(k.vx, k.vz);
        tA = time;
      }
      tL += veh.wheels[ice]!.driveTorque;
      tH += veh.wheels[high]!.driveTorque;
      dw += veh.wheels[high]!.omega - veh.wheels[ice]!.omega;
      n++;
    }
  }
  const k = kinematics(sim);
  const v1 = Math.hypot(k.vx, k.vz);
  const wi = veh.wheels[ice]!;
  return {
    tLow: tL / n,
    tHigh: tH / n,
    tIn: (tL + tH) / n,
    dOmega: dw / n,
    accel: (v1 - v0) / (t1 - tA),
    spin: (wi.omega * wi.rollRadius) / Math.max(0.5, v1),
  };
}
