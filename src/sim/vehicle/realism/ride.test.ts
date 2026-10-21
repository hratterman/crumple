/**
 * RIDE REALISM: body bounce frequency and damping per axle, and what the
 * asymmetric digressive dampers (dampers.ts) do over bumps. Sources:
 *  [G]  T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (1992), ch. 5:
 *       passenger-car body bounce ≈ 1.0–1.5 Hz, sports cars higher (≈ 1.5–2
 *       Hz [M ch. 16]); damping ratios 0.2–0.4; Olley's flat-ride rule: the
 *       rear frequency ≈ 10–30 % above the front.
 *  [D]  J. C. Dixon, "The Shock Absorber Handbook", 2nd ed. (2007): rebound
 *       ≈ 2–3.5 × bump, digressive valving past ≈ 0.1 m/s: softer impact
 *       on sharp bumps at unchanged low-speed body control.
 * Set REALISM_OUT=<dir> to dump the traces for the plots.
 */
import { describe, expect, it } from 'vitest';
import { BEATER } from '../defs/beater';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import { SEDAN_TRAFFIC } from '../defs/sedanTraffic';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { runBump, runHeave } from './ride';

const CARS: Record<string, { def: VehicleDef; f: [number, number] }> = {
  sedan: { def: SEDAN, f: [1.0, 1.7] },
  coupe: { def: COUPE, f: [1.4, 2.2] },
  pickup: { def: PICKUP, f: [1.1, 1.9] },
  beater: { def: BEATER, f: [1.0, 1.7] },
  traffic: { def: SEDAN_TRAFFIC, f: [1.0, 1.7] },
};

describe.each(Object.entries(CARS))('ride realism: %s', (name, ref) => {
  it(`body bounce ${ref.f[0]}–${ref.f[1]} Hz per axle, rear 0–35 % above front, ζ 0.2–0.45 [G]`, async () => {
    const h = runHeave(ref.def);
    await dumpJson(`heave_${name}`, { front: h.front, rear: h.rear });
    for (const a of [h.front, h.rear]) {
      expect(a.freq).toBeGreaterThan(ref.f[0]);
      expect(a.freq).toBeLessThan(ref.f[1]);
      expect(a.zeta).toBeGreaterThan(0.2);
      expect(a.zeta).toBeLessThan(0.45);
    }
    expect(h.rear.freq / h.front.freq).toBeGreaterThan(1);
    expect(h.rear.freq / h.front.freq).toBeLessThan(1.35);
  }, 60_000);
});

describe('dampers (asymmetric, digressive)', () => {
  it('sedan over a 4 cm × 0.4 m cleat at 50 km/h: ≥ 12 % lower peak body acceleration than linear dampers, wheels stay down; speed hump (8 cm × 3.5 m, 30 km/h) settles to ≤ 30 % [D]', async () => {
    const lin = { ...SEDAN, dampers: undefined };
    const a = runBump(SEDAN, 50, 0.04, 0.4);
    const b = runBump(lin, 50, 0.04, 0.4);
    const hump = runBump(SEDAN, 30, 0.08, 3.5);
    await dumpJson('bump_sedan', { asym: a.samples, lin: b.samples, hump: hump.samples });
    expect(a.peakAccG).toBeLessThan(0.88 * b.peakAccG);
    expect(a.maxAirborneS).toBeLessThan(0.02);
    expect(hump.residual).toBeLessThan(0.3);
    expect(hump.maxAirborneS).toBeLessThan(0.03);
  }, 60_000);
});
