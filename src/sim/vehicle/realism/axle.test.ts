/**
 * LIVE-AXLE BEHAVIOUR of the pickup under hard braking and a straight launch.
 *  - Brake hop: a solid rear axle whose locating links / pivots are too soft winds up under the brake torque
 *    and hops (the housing rotates until the wheel unloads, springs back, repeats at 5–8 Hz). Production
 *    trucks are tuned so it does not happen on dry pavement with or without ABS (J. C. Dixon, "Suspension
 *    Geometry and Computation", 2009, ch. 6 on axle wind-up; Gillespie §8: brake hop / axle tramp as a
 *    design failure). Bands: a full ABS stop keeps every rear wheel on the road and the rear load within
 *    ± 40 % (RMS); a locked-wheel stop (ABS off) leaves a rear wheel unloaded < 2 % of the time.
 *  - ESC must not intervene in a straight full-throttle launch (no yaw demand, no yaw).
 * Before the rear-frame pivot fix (defs/pickup.ts REAR_RAIL): ABS stop ± 57 %, 0.3 % unloaded; locked
 * 19.6 % unloaded. After: ± 32 %, 0; locked 0.17 %.
 */
import { describe, expect, it } from 'vitest';
import { PICKUP } from '../defs/pickup';
import { createHandlingSim, kinematics, setMotion, stepN } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import type { VehicleDef } from '../types';

function stop(def: VehicleDef, abs: boolean): { unloaded: number; rearRms: number; distance: number } {
  const sim = createHandlingSim({ def });
  sim.eng.setAssists(1, { abs });
  stepN(sim, 3000);
  setMotion(sim, 100 / 3.6, 0);
  const k0 = kinematics(sim);
  const loads: number[] = [];
  let zero = 0;
  let n = 0;
  for (let t = 0; t < 12000; t++) {
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1, steer: 0 });
    sim.eng.step();
    const k = kinematics(sim);
    if (Math.hypot(k.vx, k.vz) < 1) break;
    for (const w of sim.veh.wheels) {
      if (w.wheel.axle !== 'rear') continue;
      loads.push(w.load);
      n++;
      if (w.load < 50) zero++;
    }
  }
  const k1 = kinematics(sim);
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  const rms = Math.sqrt(loads.reduce((a, b) => a + (b - mean) ** 2, 0) / loads.length) / mean;
  return { unloaded: zero / n, rearRms: rms, distance: Math.hypot(k1.cx - k0.cx, k1.cz - k0.cz) };
}

describe('pickup live axle', () => {
  it('full ABS stop from 100 km/h: no brake hop (rear wheels down, rear load within ± 40 % RMS) [Dixon][Gillespie]', () => {
    const s = stop(PICKUP, true);
    expect(s.unloaded).toBeLessThan(0.005);
    expect(s.rearRms).toBeLessThan(0.4);
  }, 120_000);

  it('locked-wheel stop (ABS off): rear wheels unloaded < 2 % of the stop', () => {
    expect(stop(PICKUP, false).unloaded).toBeLessThan(0.02);
  }, 120_000);

  it('a straight full-throttle launch never wakes ESC', () => {
    const sim = createHandlingSim({ def: PICKUP });
    stepN(sim, 3000);
    const b = (sim.veh as VehicleRuntimeEx).brakeSys;
    let active = 0;
    for (let t = 0; t < 16000; t++) {
      sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0, steer: 0 });
      sim.eng.step();
      active += b.escActive;
    }
    expect(active).toBe(0);
  }, 120_000);
});
