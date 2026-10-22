/**
 * SUSPENSION KINEMATICS on the K&C rig (kcBench.ts: body clamped, frictionless
 * slip plates, ±4 cm heave), per car, against class references. Sources:
 *  [M]  Milliken & Milliken, "Race Car Vehicle Dynamics" (1995) ch. 17: roll
 *       centre and side-view swing-arm geometry; anti-dive / anti-lift (brakes
 *       outboard: contact-point path) and anti-squat (inboard drive:
 *       wheel-centre path) percentages; production cars ≈ 0–40 % anti-dive,
 *       0–50 % anti-lift / anti-squat.
 *  [R]  J. Reimpell, H. Stoll, J. Betzler, "The Automotive Chassis" (2001)
 *       ch. 3: kinematic roll-centre heights of independent suspensions
 *       ≈ 0–120 mm front, 50–150 mm rear; camber change of double wishbones
 *       ≈ −0.1 … −0.5 °/cm of bump.
 *  [G]  T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (1992) ch. 8:
 *       roll steer for understeer — front toe-OUT in bump (≈ 0.1–0.2 °/° of
 *       roll), rear toe-IN in bump (0–0.1 °/°); at half-track 0.7–0.8 m that is
 *       ≈ −0.15 … 0 °/cm front, 0 … +0.1 °/cm rear.
 * Set REALISM_OUT=<dir> to dump the sweeps.
 */
import { describe, expect, it } from 'vitest';
import { BEATER } from '../defs/beater';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import { SEDAN_TRAFFIC } from '../defs/sedanTraffic';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { runKC } from './kcBench';

interface Ref {
  def: VehicleDef;
  /** Independent rear (bands apply), else only the front is checked. */
  irs: boolean;
  /** Driven axle for the anti-squat check. */
  driven: 'rear' | 'front';
  /** Skip the anti-dive band (front). */
  noAntiDive?: boolean;
}
const CARS: Record<string, Ref> = {
  sedan: { def: SEDAN, irs: true, driven: 'rear' },
  // the coupe keeps its pro-dive front (−41 %): its upper-arm pivots are crash-path nodes and any change moved the
  // 50 km/h frontal spring-back past R-CRASH's 25 % (CONTRACTS R-PHYS ↔ R-CRASH)
  coupe: { def: COUPE, irs: true, driven: 'rear', noAntiDive: true },
  beater: { def: BEATER, irs: true, driven: 'front' },
  traffic: { def: SEDAN_TRAFFIC, irs: true, driven: 'rear' },
  pickup: { def: PICKUP, irs: false, driven: 'rear' },
};

describe.each(Object.entries(CARS))('suspension kinematics: %s', (name, ref) => {
  it('camber gain, roll centre, bump steer and anti geometry in the class bands [M][R][G]', async () => {
    const k = runKC(ref.def);
    await dumpJson(`kc_${name}`, k);
    const wheels = ref.def.wheels;
    wheels.forEach((w, i) => {
      const front = w.axle === 'front';
      if (!front && !ref.irs) return;
      expect(k.camberGain[i]).toBeLessThan(-0.1);
      expect(k.camberGain[i]).toBeGreaterThan(-0.5);
      expect(k.rollCentre[i]).toBeGreaterThan(front ? 0 : 0.0);
      expect(k.rollCentre[i]).toBeLessThan(front ? 0.14 : 0.15);
      if (front) {
        expect(k.bumpSteer[i]).toBeLessThan(0);
        expect(k.bumpSteer[i]).toBeGreaterThan(-0.15);
        if (!ref.noAntiDive) {
          expect(k.antiPct[i]).toBeGreaterThan(5);
          expect(k.antiPct[i]).toBeLessThan(40);
        }
      } else {
        expect(k.bumpSteer[i]).toBeGreaterThan(0);
        expect(k.bumpSteer[i]).toBeLessThan(0.1);
        expect(k.antiPct[i]).toBeGreaterThan(0);
        expect(k.antiPct[i]).toBeLessThan(50);
      }
      // driven rear: anti-squat 5–60 %; driven front (FWD): anti-lift in acceleration is small either way (± 40 %)
      if (w.axle === ref.driven && (front || ref.irs)) {
        expect(k.antiSquatPct[i]).toBeGreaterThan(front ? -40 : 5);
        expect(k.antiSquatPct[i]).toBeLessThan(front ? 40 : 60);
      }
    });
  }, 120_000);
});
