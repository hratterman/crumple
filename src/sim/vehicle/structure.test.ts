/**
 * R-CRASH IIHS-style structural intrusion (crash.ts `StructureProbes`, `rateStructure`): the post-crash
 * displacement of the driver-side lower / upper hinge pillar, toepan and rocker relative to the undeformed
 * rear of the occupant compartment, rated on the IIHS structure bands (IIHS_STRUCTURE_BANDS), in three
 * frontal tests per vehicle:
 *  - full width, rigid wall, 56 km/h (US NCAP);
 *  - moderate overlap, 40 % of the width, 64 km/h (IIHS / Euro NCAP ODB; our barrier is rigid, harsher
 *    than their deformable honeycomb face);
 *  - small overlap, 25 % of the width, 64 km/h (IIHS small overlap, rigid barrier): the barrier bypasses the
 *    main rails and loads the wheel and the hinge pillar directly.
 * Targets from the real fleet: a modern car (sedan, coupe, traffic sedan, pickup) keeps its compartment in
 * the full-width and moderate-overlap tests (good / acceptable); a 1990s compact (the beater) collapses in
 * the offset tests (marginal / poor); the small overlap intrudes the upper hinge pillar more than the
 * moderate overlap on every car (why IIHS added it in 2012: many cars rated good in the moderate overlap
 * were poor there — our sedan included, a pre-2012 design).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatCrash, runCrash, type CrashProbes, type CrashResult, type StructureRating } from './crash';
import { BEATER, BEATER_CRASH_PROBES } from './defs/beater';
import { COUPE, COUPE_CRASH_PROBES } from './defs/coupe';
import { PICKUP, PICKUP_CRASH_PROBES } from './defs/pickup';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC, SEDAN_TRAFFIC_CRASH_PROBES } from './defs/sedanTraffic';
import type { VehicleDef } from './types';

interface Case {
  name: string;
  def: VehicleDef;
  probes?: CrashProbes;
  /** Allowed ratings: full width, moderate overlap. */
  full: readonly StructureRating[];
  moderate: readonly StructureRating[];
}
const MODERN: readonly StructureRating[] = ['good', 'acceptable'];
const CASES: readonly Case[] = [
  { name: 'sedan', def: SEDAN, full: MODERN, moderate: MODERN },
  { name: 'coupe', def: COUPE, probes: COUPE_CRASH_PROBES, full: MODERN, moderate: MODERN },
  { name: 'traffic sedan', def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES, full: MODERN, moderate: MODERN },
  { name: 'pickup', def: PICKUP, probes: PICKUP_CRASH_PROBES as unknown as CrashProbes, full: MODERN, moderate: MODERN },
  // a 1990s compact: the full-width wall loads both rails and the cell holds; the offsets fold its A-pillar
  { name: 'beater', def: BEATER, probes: BEATER_CRASH_PROBES, full: MODERN, moderate: ['marginal', 'poor'] },
];

const lines: string[] = [];
afterAll(() => {
  if (lines.length > 0) console.log('\nIIHS-style structure (driver side, final intrusion)\n' + lines.map((l) => '  ' + l).join('\n'));
});

describe('IIHS-style structural intrusion', () => {
  for (const c of CASES) {
    it(`${c.name}: full width / moderate overlap ratings, the small overlap intrudes the hinge pillar more`, () => {
      const run = (kind: 'frontal' | 'offset', speedKmh: number, overlap?: number): CrashResult => {
        const r = runCrash({ kind, speedKmh, def: c.def, ...(c.probes ? { probes: c.probes } : {}), ...(overlap ? { overlap } : {}) });
        const t = formatCrash(r);
        lines.push(`${c.name} ${kind}${overlap ? ` ${overlap * 100} %` : ''} ${speedKmh} km/h: ${t.slice(t.indexOf('structure'))}`);
        return r;
      };
      const full = run('frontal', 56);
      const moderate = run('offset', 64, 0.4);
      const small = run('offset', 64, 0.25);
      for (const r of [full, moderate, small]) {
        expect(r.finite).toBe(true);
        expect(r.structure).toBeDefined();
      }
      expect(c.full).toContain(full.structureRating);
      expect(c.moderate).toContain(moderate.structureRating);
      expect(small.structure!.upperHingePillar!).toBeGreaterThan(moderate.structure!.upperHingePillar!);
    }, 900_000);
  }
});
