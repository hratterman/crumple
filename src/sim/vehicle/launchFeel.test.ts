/**
 * Launch feel per vehicle (feel pass): a full-throttle standing start
 * through the gear changes, default assists. The body's fore-aft
 * acceleration (rigid shell centroid) must be smooth: its 2–8 Hz (surging:
 * TC hunting, shift dips) and 8–25 Hz (shunt, driveline / tyre wind-up)
 * band RMS stay small relative to the mean acceleration. Before the
 * drivetrain fixes (drivetrain.ts: PI traction control, launch control,
 * power-on upshifts) the sedan measured 2–8 Hz 0.89 m/s² and 8–25 Hz 0.50
 * m/s² on a 3.7 m/s² mean, with a −5 m/s² dip and a 2× torque spike at every
 * upshift.
 */
import { describe, expect, it } from 'vitest';
import { runDrive } from './bodyflex';
import { BEATER } from './defs/beater';
import { BOXTRUCK } from './defs/boxtruck';
import { COUPE } from './defs/coupe';
import { PICKUP } from './defs/pickup';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC } from './defs/sedanTraffic';
import type { VehicleDef } from './types';

/** Band RMS (lo ≤ f < hi, Hz) of a uniformly sampled series, by DFT + Parseval (mean removed). */
export function bandRms(x: readonly number[], hz: number, lo: number, hi: number): number {
  const n = x.length;
  let mean = 0;
  for (const v of x) mean += v;
  mean /= n;
  let e = 0;
  const k0 = Math.max(1, Math.ceil((lo * n) / hz));
  const k1 = Math.min(Math.floor((n - 1) / 2), Math.ceil((hi * n) / hz) - 1);
  for (let k = k0; k <= k1; k++) {
    const w = (2 * Math.PI * k) / n;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i]! - mean;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    e += 2 * (re * re + im * im);
  }
  return Math.sqrt(e) / n;
}

interface Case {
  name: string;
  def: VehicleDef;
  launchS: number;
  /** Max 2–8 Hz and 8–25 Hz band RMS / mean acceleration. */
  surge: number;
  shunt: number;
}

const CASES: Case[] = [
  { name: 'sedan', def: SEDAN, launchS: 7, surge: 0.15, shunt: 0.15 },
  { name: 'coupe', def: COUPE, launchS: 6, surge: 0.15, shunt: 0.15 },
  { name: 'pickup', def: PICKUP, launchS: 8, surge: 0.15, shunt: 0.15 },
  { name: 'beater', def: BEATER, launchS: 10, surge: 0.15, shunt: 0.17 },
  { name: 'traffic sedan', def: SEDAN_TRAFFIC, launchS: 8, surge: 0.15, shunt: 0.15 },
  // Box truck: 0.42 m/s² (0.25) of 2–8 Hz surge left (was 0.57): a ≈ 5 Hz chassis / rear-axle mode rings for
  // ≈ 1 s after the launch with a smooth drive torque (frame damping does not touch it) — see PLAN, open item.
  { name: 'box truck', def: BOXTRUCK, launchS: 12, surge: 0.3, shunt: 0.15 },
];

describe('launch feel (smooth acceleration through the gears)', () => {
  for (const c of CASES) {
    it(`${c.name}: full-throttle launch, no surging, no shift shunt`, () => {
      const r = runDrive(c.def, 'launch', { launchS: c.launchS });
      const { t, bodyLonAcc: a, gear, speed } = r.trace;
      const from = t.findIndex((x) => x > 0.3);
      const acc = a.slice(from);
      const mean = acc.reduce((s, v) => s + v, 0) / acc.length;
      const surge = bandRms(acc, r.trace.hz, 2, 8);
      const shunt = bandRms(acc, r.trace.hz, 8, 25);
      let shifts = 0;
      for (let i = from + 1; i < gear.length; i++) if (gear[i]! > gear[i - 1]!) shifts++;
      console.log(
        `[launch] ${c.name.padEnd(13)} ${(speed[speed.length - 1]! * 3.6).toFixed(0)} km/h in ${c.launchS} s, ${shifts} upshifts, mean ${mean.toFixed(2)} m/s²` +
          `  2–8 Hz ${surge.toFixed(2)} (${(surge / mean).toFixed(3)})  8–25 Hz ${shunt.toFixed(2)} (${(shunt / mean).toFixed(3)})`,
      );
      expect(shifts).toBeGreaterThanOrEqual(1);
      expect(surge / mean).toBeLessThan(c.surge);
      expect(shunt / mean).toBeLessThan(c.shunt);
    }, 600_000);
  }
});
