/**
 * POWERTRAIN REALISM: fuel consumption, road load, stall / starter and
 * engine damage on the real soft-body cars. Sources:
 *  [W]   J. Y. Wong, "Theory of Ground Vehicles", 4th ed., eq. 1.12: car
 *        tyre rolling resistance f_r ≈ 0.01·(1 + V/160 km/h) (light trucks
 *        ≈ 0.011–0.012, truck tyres ≈ 0.0065·(1 + V/160)).
 *  [ADAC] constant-speed consumption (ADAC Ecotest / Auto Motor und Sport
 *        constant-speed runs, 2010s cars): 3 L petrol mid-size sedan at
 *        100 km/h ≈ 5.5–8 L/100 km; 4 L V8 sports coupe ≈ 7–10.5; 5 L V8
 *        full-size pickup ≈ 9.5–14; a 1990s 1.6 L 4-speed-automatic compact
 *        ≈ 5.5–8.5; a 6.7 L
 *        medium-duty diesel box truck at 90 km/h ≈ 18–30.
 *  [ANL] Argonne National Laboratory, idle fuel use ≈ 0.6–1.5 L/h for
 *        1.6–3 L petrol engines.
 *  [SAE] starter cranking ≈ 0.5–1.5 s to fire a warm engine; a manual car
 *        stalls when the clutch is dumped at idle in 1st.
 *  [IIHS] low-speed crash practice: a 10 km/h bumper hit leaves the
 *        radiator intact; a 50 km/h frontal destroys it.
 */
import { describe, expect, it } from 'vitest';
import { runCrash, SEDAN_CRASH_PROBES } from '../crash';
import { BEATER } from '../defs/beater';
import { BOXTRUCK } from '../defs/boxtruck';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import type { VehicleRuntimeEx } from '../runtime';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { runClutchLaunch, runCruise, runIdle, runRestart } from './powertrain';

const FUEL: Record<string, { def: VehicleDef; kmh: number; band: [number, number] }> = {
  sedan: { def: SEDAN, kmh: 100, band: [5.5, 8] },
  coupe: { def: COUPE, kmh: 100, band: [7, 10.5] },
  pickup: { def: PICKUP, kmh: 100, band: [9.5, 14] },
  beater: { def: BEATER, kmh: 100, band: [5.5, 8.5] },
  boxtruck: { def: BOXTRUCK, kmh: 90, band: [18, 30] },
};

describe.each(Object.entries(FUEL))('fuel: %s', (name, ref) => {
  it(`steady ${ref.kmh} km/h: ${ref.band[0]}–${ref.band[1]} L/100 km in top gear [ADAC]`, async () => {
    const c = runCruise(ref.def, ref.kmh);
    await dumpJson(`cruise_${name}`, c);
    expect(c.lPer100km).toBeGreaterThan(ref.band[0]);
    expect(c.lPer100km).toBeLessThan(ref.band[1]);
  }, 120_000);
});

describe('engine: idle, stall, starter, radiator', () => {
  it('sedan idles on 0.6–1.5 L/h [ANL]', () => {
    const l = runIdle(SEDAN);
    expect(l).toBeGreaterThan(0.6);
    expect(l).toBeLessThan(1.5);
  }, 60_000);

  it('manual, clutch assist off: dumping the clutch at idle in 1st stalls, clutch + throttle restarts it in 0.5–1.5 s; a 0.35-throttle, 1.2 s release pulls away; with the assist it never stalls [SAE]', () => {
    const dump = runClutchLaunch(SEDAN, 0, 0.05);
    expect(dump.stalled).toBe(true);
    // clutch down + throttle cranks the starter; a warm engine fires in 0.5–1.5 s
    const tStart = runRestart(dump.sim);
    expect(tStart).toBeGreaterThan(0.5);
    expect(tStart).toBeLessThan(1.5);
    const good = runClutchLaunch(SEDAN, 0.35, 1.2);
    expect(good.stalled).toBe(false);
    expect(good.speedAfter).toBeGreaterThan(3);
    expect(runClutchLaunch(SEDAN, 0, 0.05, 'manual', true).stalled).toBe(false);
  }, 60_000);

  it('a 50 km/h frontal destroys the sedan radiator, 8 km/h leaves it intact [IIHS]', () => {
    const rad = (kmh: number): number => {
      let r = 0;
      runCrash({ kind: 'frontal', speedKmh: kmh, def: SEDAN, probes: SEDAN_CRASH_PROBES, onStep: (eng) => {
        r = (eng.getVehicle(1)! as unknown as VehicleRuntimeEx).engineSys.radiatorDamage;
      } });
      return r;
    };
    expect(rad(8)).toBe(0);
    expect(rad(50)).toBeGreaterThan(0.8);
  }, 120_000);
});
