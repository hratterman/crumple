/**
 * R-CRASH roof strength (FMVSS 216a / IIHS platen, roofStrength.ts): every car's strength-to-weight ratio
 * inside its band (ROOF_CASES) and a crushed roof that stays crushed (plastic set), never an elastic roof
 * that springs back. Before R-CRASH: sedan SWR 5.9 held by the rigid shell, 18 cm loaded drop springing
 * back to 1.6 cm; no rollover dented a roof.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BEATER } from './defs/beater';
import { COUPE } from './defs/coupe';
import { PICKUP } from './defs/pickup';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC } from './defs/sedanTraffic';
import { formatRoofStrength, ROOF_CASES, runRoofStrength } from './roofStrength';

const lines: string[] = [];
afterAll(() => {
  if (lines.length > 0) console.log('\nroof strength (platen)\n' + lines.map((l) => '  ' + l).join('\n'));
});

describe('roof strength (FMVSS 216a platen)', () => {
  for (const def of [SEDAN, SEDAN_TRAFFIC, COUPE, BEATER, PICKUP]) {
    it(`${def.name}: SWR in its band, the crushed roof keeps its set, finite`, () => {
      const c = ROOF_CASES[def.name]!;
      const r = runRoofStrength({ def, ...c, travel: 0.14 });
      lines.push(formatRoofStrength(def.name, r));
      expect(r.finite).toBe(true);
      expect(r.swr).toBeGreaterThanOrEqual(c.swr[0]);
      expect(r.swr).toBeLessThanOrEqual(c.swr[1]);
      expect(r.permanentSet).toBeGreaterThanOrEqual(c.setFraction * r.loadedDrop);
    }, 900_000);
  }
});
