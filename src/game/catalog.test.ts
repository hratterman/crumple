import { describe, expect, it } from 'vitest';

import { compileVehicle, validateVehicle } from '../sim/vehicle/builder';
import {
  DEFAULT_VEHICLE_ID,
  isVehicleId,
  paletteOf,
  PLAYER_VEHICLE_IDS,
  trafficVariantEntries,
  VEHICLE_CATALOG,
  type VehicleCatalogEntry,
} from './catalog';

const entries = Object.values(VEHICLE_CATALOG) as VehicleCatalogEntry[];

/** Peak power of a torque curve, kW (piecewise-linear, sampled every 10 rpm). */
function peakKw(curve: readonly (readonly [number, number])[]): number {
  let best = 0;
  const last = curve[curve.length - 1]![0];
  for (let rpm = curve[0]![0]; rpm <= last; rpm += 10) {
    let t = curve[curve.length - 1]![1];
    for (let i = 1; i < curve.length; i++) {
      const [r1, t1] = curve[i]!;
      const [r0, t0] = curve[i - 1]!;
      if (rpm <= r1) {
        t = t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
        break;
      }
    }
    best = Math.max(best, (t * rpm * 2 * Math.PI) / 60 / 1000);
  }
  return best;
}

describe('vehicle catalog (P6 contract)', () => {
  it('lists every id once, keyed by its own id', () => {
    for (const [k, e] of Object.entries(VEHICLE_CATALOG)) expect(e.id).toBe(k);
    expect(isVehicleId('sedan')).toBe(true);
    expect(isVehicleId('tank')).toBe(false);
    expect(VEHICLE_CATALOG[DEFAULT_VEHICLE_ID].available).toBe(true);
  });

  it('player ids are exactly the selectable entries, in showroom order', () => {
    expect(entries.filter((e) => e.selectable).map((e) => e.id).sort()).toEqual([...PLAYER_VEHICLE_IDS].sort());
    expect(PLAYER_VEHICLE_IDS[0]).toBe(DEFAULT_VEHICLE_ID);
  });

  it('every entry has ≥ 4 uniquely named palettes and sane cards', () => {
    for (const e of entries) {
      expect(e.palettes.length, e.id).toBeGreaterThanOrEqual(4);
      expect(new Set(e.palettes.map((p) => p.id)).size, e.id).toBe(e.palettes.length);
      for (const p of e.palettes) {
        expect(p.paint.color, `${e.id}/${p.id}`).toBeGreaterThanOrEqual(0);
        expect(p.paint.color, `${e.id}/${p.id}`).toBeLessThanOrEqual(0xffffff);
      }
      const r = e.stats.ratings;
      for (const v of [r.speed, r.handling, r.toughness]) expect(v >= 1 && v <= 5, e.id).toBe(true);
      expect(paletteOf(e, 'nope')).toBe(e.palettes[0]);
      if (e.trafficEligible) expect(e.beamBudget, e.id).toBeLessThanOrEqual(1500);
      else expect(e.beamBudget, e.id).toBeLessThanOrEqual(3500);
    }
  });

  it('unavailable entries reject load(); traffic variants are available + eligible only', async () => {
    for (const e of entries.filter((x) => !x.available)) await expect(e.load(), e.id).rejects.toThrow();
    for (const e of trafficVariantEntries()) expect(e.available && e.trafficEligible).toBe(true);
  });

  // Runs for every AVAILABLE entry: a fleet unit flipping `available` is covered automatically.
  // One case per vehicle with its own budget: load() imports the visual def, whose module evaluation
  // lofts and tessellates the whole LOD0 body (0.4–1.7 s per vehicle on an idle core, the bulk of
  // this file; 3–4 s for all six together, which crossed vitest's 5 s default on a loaded box).
  it.each(entries.filter((x) => x.available).map((e) => [e.id, e] as const))(
    'available entry %s loads defs that match its card and budget',
    async (_id, e) => {
      const { sim, visual } = await e.load();
      expect(visual.vehicle, e.id).toBe(sim.name);
      expect(visual.paint, `${e.id} palettes[0] = the visual def's paint`).toEqual(e.palettes[0]!.paint);
      const cv = compileVehicle(sim);
      expect(Math.abs(cv.totalMass - e.stats.massKg) / e.stats.massKg, `${e.id} mass`).toBeLessThan(0.02);
      expect(Math.abs(peakKw(sim.drivetrain.torqueCurve) - e.stats.powerKw) / e.stats.powerKw, `${e.id} power`).toBeLessThan(0.03);
      expect(Math.max(...sim.drivetrain.torqueCurve.map((p) => p[1])), `${e.id} torque`).toBe(e.stats.torqueNm);
      const front = sim.wheels.some((w) => w.driven && w.axle === 'front');
      const rear = sim.wheels.some((w) => w.driven && w.axle === 'rear');
      expect(front && rear ? 'AWD' : front ? 'FWD' : 'RWD', `${e.id} drivetrain`).toBe(e.stats.drivetrain);
      const report = validateVehicle(sim, e.beamBudget);
      expect(report.errors, e.id).toEqual([]);
      expect(cv.rig.beamCount, `${e.id} beams`).toBeLessThanOrEqual(e.beamBudget);
    },
    30_000,
  );
});
