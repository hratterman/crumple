/**
 * HIGH-RESOLUTION TYRE (tyreHiRes.ts, physics quality high / ultra): the
 * 16-ray tyre with carcass compliance reproduces the standard tyre's bench
 * curves (same tyre, finer rig) and adds a real relaxation length.
 * Sources: [P] Pacejka, "Tyre and Vehicle Dynamics" 3rd ed. (2012) §7
 * (relaxation length of passenger radials ≈ 0.3–0.6 m, roughly constant
 * with speed); [W] Wong, "Theory of Ground Vehicles" (C_rr of car tyres
 * 0.008–0.015 on asphalt, rising ≈ 0.01·V/160 km/h).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildVehicleRig, compileVehicle, TREAD_OMEGA_DT_LIMIT } from '../builder';
import { compileRig, computeStabilityReport } from '../../rig/builder';
import { WHEEL_DEFAULTS } from '../types';
import { hiResWheel, hiResWheels, HIRES_RAYS, HIRES_ROLL_DELTA_205_55R16 } from '../tyreHiRes';
import { classWheel, reduceCurves, sweepWheel, TYRE_CLASSES, type TyreMetrics } from './tyreClasses';

const cls = TYRE_CLASSES.find((c) => c.id === 'passenger')!;
const { wheel, fz0 } = classWheel(cls);
let std: TyreMetrics;
let hi: TyreMetrics;
beforeAll(() => {
  std = reduceCurves(sweepWheel(wheel, fz0));
  hi = reduceCurves(sweepWheel(hiResWheel(wheel, { rollDelta: HIRES_ROLL_DELTA_205_55R16 }), fz0));
}, 600_000);

describe('high-resolution tyre (passenger 205/55R16, 16 rays + carcass)', () => {
  it('compiles inside the tread ω·dt budget with no MINIMASS drift', () => {
    const def = { ...cls.vehicle, wheels: hiResWheels(cls.vehicle.wheels) };
    expect(def.wheels[0]!.rays).toBe(HIRES_RAYS);
    const cv = compileVehicle(def);
    expect(Math.abs(cv.massDriftPct)).toBeLessThan(0.01);
    const merged = buildVehicleRig(def);
    const rep = computeStabilityReport(compileRig(merged), { limit: TREAD_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      if (merged.nodes[i]!.group === WHEEL_DEFAULTS.tireGroup) expect(rep.omegaDt[i]!).toBeLessThanOrEqual(TREAD_OMEGA_DT_LIMIT);
    }
  });

  it('the same cornering stiffness per load (±12 %), peak μ_y and μ_x (±6 %) as the standard tyre', () => {
    for (let l = 0; l < 3; l++) {
      expect(hi.caNdeg[l]! / std.caNdeg[l]!).toBeGreaterThan(0.88);
      expect(hi.caNdeg[l]! / std.caNdeg[l]!).toBeLessThan(1.12);
      expect(Math.abs(hi.muY[l]! / std.muY[l]! - 1)).toBeLessThan(0.06);
    }
    expect(Math.abs(hi.muX / std.muX - 1)).toBeLessThan(0.06);
    expect(hi.caNdeg[2]!).toBeGreaterThan(hi.caNdeg[0]!);
  });

  it('relaxation length 0.3–0.7 m at 5 and 15 m/s (the standard rigid-carcass brush: ≈ 0.2 m) [P]', () => {
    expect(hi.relax[0]!).toBeGreaterThan(0.3);
    expect(hi.relax[1]!).toBeGreaterThan(0.3);
    expect(hi.relax[1]!).toBeLessThan(0.7);
    expect(hi.relax[1]! / std.relax[1]!).toBeGreaterThan(1.8);
  });

  it('rolling resistance at 36–108 km/h within 0.006–0.02 [W]', () => {
    for (let i = 0; i < 3; i++) {
      expect(hi.crr[i]!).toBeGreaterThan(0.006);
      expect(hi.crr[i]!).toBeLessThan(0.02);
    }
  });
});
