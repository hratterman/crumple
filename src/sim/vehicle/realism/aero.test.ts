/**
 * AERO + ROAD LOAD. Sources:
 *  [W]  J. Y. Wong, "Theory of Ground Vehicles", 4th ed.: road load
 *       F = ½ρ·CdA·v² + m·g·f_r, f_r = c₀·(1 + v/160 km/h) (eq. 1.12; c₀ ≈ 0.01
 *       cars, 0.011–0.012 light trucks).
 *  [H]  W.-H. Hucho, "Aerodynamics of Road Vehicles", 4th ed. (1998): lift
 *       acts at the axles — front / rear lift coefficients are quoted per
 *       axle; production saloons Cl_f ≈ 0.05–0.15, Cl_r ≈ 0–0.15.
 */
import { describe, expect, it } from 'vitest';
import { BEATER } from '../defs/beater';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { axleLoadsAt, steadyRoadLoad } from './aero';

describe('aero', () => {
  it('lift acts at the axles: a front Cl·A of 1 m² unloads the front axle by ½ρv² (±10 %) and leaves the rear (±5 %) [H]', () => {
    const base = { ...SEDAN, aero: { ...SEDAN.aero, liftFront: 0, liftRear: 0 } };
    const z = axleLoadsAt(base, 150);
    const f1 = axleLoadsAt({ ...base, aero: { ...base.aero, liftFront: 1 } }, 150);
    const q = 0.5 * 1.225 * z.v * z.v;
    expect((z.front - f1.front) / q).toBeGreaterThan(0.9);
    expect((z.front - f1.front) / q).toBeLessThan(1.1);
    expect(Math.abs(z.rear - f1.rear) / q).toBeLessThan(0.05);
  }, 120_000);
});

const CARS: Record<string, { def: VehicleDef; c0: number }> = {
  sedan: { def: SEDAN, c0: 0.01 },
  coupe: { def: COUPE, c0: 0.011 },
  pickup: { def: PICKUP, c0: 0.011 },
  beater: { def: BEATER, c0: 0.012 },
};
describe.each(Object.entries(CARS))('road load: %s', (name, ref) => {
  it('steady-state road load at 50 / 80 / 110 km/h within ±20 % of ½ρCdA·v² + m·g·c₀(1 + v/160) [W]', async () => {
    const out: [number, number, number][] = [];
    for (const kmh of [50, 80, 110]) {
      const v = kmh / 3.6;
      const F = steadyRoadLoad(ref.def, kmh);
      const { createHandlingSim } = await import('../handling');
      const m = createHandlingSim({ def: ref.def }).cv.totalMass;
      const Fref = 0.5 * 1.225 * ref.def.aero.dragCoeffArea * v * v + m * 9.81 * ref.c0 * (1 + kmh / 160);
      out.push([kmh, F, Fref]);
      expect(F / Fref).toBeGreaterThan(0.8);
      expect(F / Fref).toBeLessThan(1.2);
    }
    await dumpJson(`roadload_${name}`, out);
  }, 180_000);
});
