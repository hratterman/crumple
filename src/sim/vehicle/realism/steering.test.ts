/**
 * STEERING SYSTEM (steering.ts) against production references. Sources:
 *  [HP] M. Harrer, P. Pfeffer (eds.), "Steering Handbook", Springer 2017:
 *       ch. 2 / 6 — parking rack forces of mid-size cars ≈ 6–12 kN on
 *       0.1–0.15 m steering arms (total kingpin moment ≈ 0.6–1.8 kN·m),
 *       pickups / vans up to ≈ 2.5 kN·m, medium trucks several kN·m;
 *       assisted parking effort ≈ 2–5 N·m
 *       at the steering wheel; torsion bars ≈ 1.5–3 N·m/°.
 *  [N]  D. J. Norman, "Objective Evaluation of On-Center Handling
 *       Performance", SAE 840069 (1984): steering-wheel torque builds
 *       roughly linearly with lateral acceleration on centre, a few N·m per
 *       0.1–0.3 g on production cars at 100 km/h.
 *  [P]  H. B. Pacejka, "Tire and Vehicle Dynamics", 3rd ed. 2012, ch. 1 / 3:
 *       the pneumatic trail collapses as the front tyres approach their
 *       peak side force — the aligning moment (steering effort) peaks and
 *       falls BEFORE the lateral-force limit ("the steering goes light").
 *  [G]  T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (1992) §6:
 *       steering-system compliance adds understeer (the road wheels lag
 *       the steering wheel by the aligning moment over the system stiffness).
 * Set REALISM_OUT=<dir> to dump the time series.
 */
import { describe, expect, it } from 'vitest';
import { BEATER } from '../defs/beater';
import { BOXTRUCK } from '../defs/boxtruck';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { runParking, runRampSteer, type SteerSample } from './steering';

const peakAbs = (xs: SteerSample[], f: (s: SteerSample) => number): number => xs.reduce((m, s) => Math.max(m, Math.abs(f(s))), 0);

interface Ref {
  def: VehicleDef;
  /** Parking kingpin moment band, N·m [HP]. */
  park: [number, number];
  /** Assisted parking effort band, N·m [HP]. */
  effort: [number, number];
}
const CARS: Record<string, Ref> = {
  sedan: { def: SEDAN, park: [600, 1800], effort: [1.5, 5] },
  coupe: { def: COUPE, park: [600, 1800], effort: [1.5, 5] },
  beater: { def: BEATER, park: [600, 1800], effort: [2, 7] },
  pickup: { def: PICKUP, park: [900, 2500], effort: [2, 7] },
  truck: { def: BOXTRUCK, park: [1500, 8000], effort: [2, 8] },
};

describe.each(Object.entries(CARS))('steering system: %s', (name, ref) => {
  it('parking: kingpin moment and assisted effort in the production bands, the rack reaches lock [HP]', async () => {
    const xs = runParking(ref.def, 1, 3, 1);
    await dumpJson(`steer_park_${name}`, xs);
    const kp = peakAbs(xs, (s) => s.kingpin);
    const eff = peakAbs(xs, (s) => s.torque);
    expect(kp).toBeGreaterThan(ref.park[0]);
    expect(kp).toBeLessThan(ref.park[1]);
    expect(eff).toBeGreaterThan(ref.effort[0]);
    expect(eff).toBeLessThan(ref.effort[1]);
    // the tyres resist the steer (load against the hands), the assist still takes the rack to lock
    const last = xs[xs.length - 1]!;
    expect(last.load).toBeLessThan(0);
    expect(last.torque).toBeGreaterThan(0);
    expect(last.rack).toBeGreaterThan(0.97);
    expect(last.rack).toBeLessThanOrEqual(1);
  }, 120_000);
});

describe('steering system: on centre and at the limit (sedan, 100 km/h)', () => {
  it('self-aligning torque builds with lateral g, then falls off before the limit; compliance understeer [N][P][G]', async () => {
    const xs = runRampSteer(SEDAN, 100, 0.12, 10);
    await dumpJson('steer_ramp_sedan', xs);
    // on centre: 0.05–0.25 g, driver torque toward the turn, rising with g
    const oc = xs.filter((s) => s.latG > 0.05 && s.latG < 0.25);
    expect(oc.length).toBeGreaterThan(20);
    for (const s of oc) expect(s.torque).toBeGreaterThan(0);
    // least-squares torque gradient, N·m/g
    const mx = oc.reduce((a, s) => a + s.latG, 0) / oc.length;
    const my = oc.reduce((a, s) => a + s.torque, 0) / oc.length;
    const grad = oc.reduce((a, s) => a + (s.latG - mx) * (s.torque - my), 0) / oc.reduce((a, s) => a + (s.latG - mx) ** 2, 0);
    expect(grad).toBeGreaterThan(3);
    expect(grad).toBeLessThan(25);
    // the effort peaks before the lateral limit [P]: 0.3 s means; near the limit (≥ 90 % of the peak
    // lateral g) the effort has fallen below 80 % of its build-up maximum
    const sm = (f: (s: SteerSample) => number): number[] => xs.map((_, i) => {
      const w = xs.slice(Math.max(0, i - 15), i + 15);
      return w.reduce((a, s) => a + f(s), 0) / w.length;
    });
    const gS = sm((s) => s.latG);
    const tS = sm((s) => s.torque);
    const gMax = Math.max(...gS);
    let tBuild = 0;
    let tLimit = 0;
    let nLimit = 0;
    for (let i = 0; i < xs.length; i++) {
      if (gS[i]! < 0.7 * gMax) tBuild = Math.max(tBuild, tS[i]!);
      if (gS[i]! >= 0.9 * gMax) {
        tLimit += tS[i]!;
        nLimit++;
      }
    }
    expect(nLimit).toBeGreaterThan(10);
    expect(tLimit / nLimit).toBeLessThan(0.8 * tBuild);
    // compliance: the rack lags the hands by 0.02–1.5° of road wheel per g [G]
    const dmax = SEDAN.steering.maxWheelAngleDeg;
    const at = oc[oc.length - 1]!;
    const lagDegPerG = ((at.hands - at.rack) * dmax) / at.latG;
    expect(lagDegPerG).toBeGreaterThan(0.02);
    expect(lagDegPerG).toBeLessThan(1.5);
  }, 120_000);

  it('speed-sensitive assist: the same 0.3 g takes more effort at 100 km/h than at 40 km/h [HP]', () => {
    const at = (kmh: number, to: number): number => {
      const xs = runRampSteer(SEDAN, kmh, to, 6);
      let best = xs[0]!;
      for (const s of xs) if (Math.abs(s.latG - 0.3) < Math.abs(best.latG - 0.3)) best = s;
      expect(Math.abs(best.latG - 0.3)).toBeLessThan(0.05);
      return best.torque;
    };
    expect(at(100, 0.2)).toBeGreaterThan(1.3 * at(40, 0.4));
  }, 120_000);
});
