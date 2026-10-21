/**
 * Post-crash settling per vehicle (feel pass): after a 50 / 100 km/h rigid-wall frontal the crush must stop
 * moving — no visible wobble half a second after the peak — and the wall rebound must not regress.
 *
 * Before this pass the crushed front swung for 0.5–2 s after the impact (50 km/h sedan: ±2 cm at ~4 Hz to
 * 0.6 s; 100 km/h sedan / traffic: 3–5 cm still at 0.5 s): the released crumple zone and cell were a loose
 * beam mechanism until the 1 s calm recapture. The post-impact set (shellDefs RECAPTURE_IMPACT_*) re-sets
 * the shell in its crushed shape once the impact is over.
 * R-CRASH: every vehicle's wall rebound lies in the real-car band, 5–15 % of the impact speed, at 50 and
 * 100 km/h (before: sedan 21 / 23 %, coupe 21 / 22 %, traffic 21 / 15 %; beams.ts crush unloading +
 * colliders.ts hysteretic contact, CONTRACTS "R-CRASH").
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
  /** Rebound / impact speed band, both speeds. */
  rebound: [number, number];
}

const CASES: Case[] = [
  { name: 'sedan', def: SEDAN, probes: SEDAN_CRASH_PROBES, ring: [0.01, 0.06], rebound: [0.05, 0.15] },
  { name: 'coupe', def: COUPE, probes: COUPE_CRASH_PROBES, ring: [0.01, 0.025], rebound: [0.05, 0.15] },
  { name: 'pickup', def: PICKUP, probes: PICKUP_CRASH_PROBES as CrashProbes, ring: [0.01, 0.025], rebound: [0.05, 0.15] },
  // ring 50 km/h 2 → 2.5 cm (R-CRASH): the paper beater's crush, no longer partly absorbed by 4 cm of wall penetration, settles 2.1 cm
  { name: 'beater', def: BEATER, probes: BEATER_CRASH_PROBES, ring: [0.025, 0.045], rebound: [0.05, 0.15] },
  { name: 'traffic sedan', def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES, ring: [0.01, 0.025], rebound: [0.05, 0.15] },
  // ring 50 km/h 2 → 3 cm (R-CRASH): with the 8 MN/m wall contact the frame horns no longer sink 10 cm into the wall, so the box's late
  // shunt on its mounts moves the measured crush 2.4 cm 0.5 s after the peak (box truck frame / mounts: R-PHYS).
  { name: 'box truck', def: BOXTRUCK, probes: BOXTRUCK_CRASH_PROBES as unknown as CrashProbes, ring: [0.03, 0.03], rebound: [0.05, 0.15] },
];

describe('post-crash settling (rigid wall frontal)', () => {
  for (const c of CASES) {
    it(`${c.name}: 50 and 100 km/h — the crush stops moving within 0.5 s of its peak, rebound 5–15 %`, () => {
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
        checks.push(() => expect(reb).toBeGreaterThanOrEqual(c.rebound[0]));
        checks.push(() => expect(reb).toBeLessThanOrEqual(c.rebound[1]));
      });
      console.log(`[settle] ${c.name}\n  ${lines.join("\n  ")}`);
      for (const ch of checks) ch();
    }, 600_000);
  }
});
