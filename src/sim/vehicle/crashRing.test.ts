/**
 * Post-crash settling per vehicle (feel pass): after a 50 / 100 km/h rigid-wall frontal the crush must stop
 * moving — no visible wobble half a second after the peak — and the wall rebound must not regress.
 *
 * Before this pass the crushed front swung for 0.5–2 s after the impact (50 km/h sedan: ±2 cm at ~4 Hz to
 * 0.6 s; 100 km/h sedan / traffic: 3–5 cm still at 0.5 s): the released crumple zone and cell were a loose
 * beam mechanism until the 1 s calm recapture. The post-impact set (shellDefs RECAPTURE_IMPACT_*) re-sets
 * the shell in its crushed shape once the impact is over. The rebound bounds are no-regression limits
 * measured at the same time (the 5–15 % real-car range is met by the pickup, beater and box truck; the
 * sedans and the coupe still rebound 21–23 %, see CONTRACTS "Crash settling" and PLAN).
 */
import { describe, expect, it } from 'vitest';
import { crushSettle, runCrash, SEDAN_CRASH_PROBES, type CrashProbes } from './crash';
import { BEATER, BEATER_CRASH_PROBES } from './defs/beater';
import { BOXTRUCK, BOXTRUCK_CRASH_PROBES } from './defs/boxtruck';
import { COUPE, COUPE_CRASH_PROBES } from './defs/coupe';
import { PICKUP, PICKUP_CRASH_PROBES } from './defs/pickup';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC, SEDAN_TRAFFIC_CRASH_PROBES } from './defs/sedanTraffic';
import type { VehicleDef } from './types';

interface Case {
  name: string;
  def: VehicleDef;
  probes: CrashProbes;
  /** Max |crush − final| from 0.5 s after the peak, m, at 50 / 100 km/h. */
  ring: [number, number];
  /** Max rebound / impact speed at 50 / 100 km/h. */
  rebound: [number, number];
}

const CASES: Case[] = [
  { name: 'sedan', def: SEDAN, probes: SEDAN_CRASH_PROBES, ring: [0.01, 0.06], rebound: [0.23, 0.25] },
  { name: 'coupe', def: COUPE, probes: COUPE_CRASH_PROBES, ring: [0.01, 0.025], rebound: [0.23, 0.24] },
  { name: 'pickup', def: PICKUP, probes: PICKUP_CRASH_PROBES as CrashProbes, ring: [0.01, 0.025], rebound: [0.13, 0.1] },
  { name: 'beater', def: BEATER, probes: BEATER_CRASH_PROBES, ring: [0.02, 0.045], rebound: [0.15, 0.1] },
  { name: 'traffic sedan', def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES, ring: [0.01, 0.025], rebound: [0.23, 0.17] },
  { name: 'box truck', def: BOXTRUCK, probes: BOXTRUCK_CRASH_PROBES as unknown as CrashProbes, ring: [0.02, 0.03], rebound: [0.17, 0.07] },
];

describe('post-crash settling (rigid wall frontal)', () => {
  for (const c of CASES) {
    it(`${c.name}: 50 and 100 km/h — the crush stops moving within 0.5 s of its peak, rebound does not regress`, () => {
      const lines: string[] = [];
      const checks: (() => void)[] = [];
      ([50, 100] as const).forEach((v, k) => {
        const r = runCrash({ kind: 'frontal', speedKmh: v, def: c.def, probes: c.probes });
        const s = crushSettle(r.crushTrace);
        const ring = s.ringAfter(0.5);
        const reb = r.rebound / (v / 3.6);
        lines.push(
          `${v} km/h: crush ${(r.crush * 100).toFixed(1)} (peak ${(r.crushMax * 100).toFixed(1)}) cm, overshoot ${(s.overshoot * 100).toFixed(1)} cm, ` +
            `ring 0.25 / 0.5 / 1 s after the peak ${(s.ringAfter(0.25) * 100).toFixed(1)} / ${(ring * 100).toFixed(1)} / ${(s.ringAfter(1) * 100).toFixed(1)} cm, ` +
            `rebound ${r.rebound.toFixed(2)} m/s (${(reb * 100).toFixed(0)} %)`,
        );
        checks.push(() => expect(r.finite).toBe(true));
        checks.push(() => expect(ring).toBeLessThan(c.ring[k]!));
        checks.push(() => expect(reb).toBeLessThan(c.rebound[k]!));
      });
      console.log(`[settle] ${c.name}\n  ${lines.join("\n  ")}`);
      for (const ch of checks) ch();
    }, 600_000);
  }
});
