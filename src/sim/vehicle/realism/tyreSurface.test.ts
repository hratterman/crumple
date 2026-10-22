/**
 * TYRE ON SURFACES (flat-track bench, passenger 205/55R16 at its static load):
 * wet asphalt, hydroplaning, loose and soft ground, against published
 * ranges. Sources:
 *  [ADAC]  ADAC / TÜV SÜD summer-tyre tests (205/55 R16 class): wet braking
 *          80 → 20 km/h in 26–34 m (≈ 0.65–0.8 of the dry deceleration);
 *          aquaplaning onset in 7–8 mm of water ≈ 80–90 km/h new, ≈ 65–75 km/h
 *          at 3–4 mm of tread.
 *  [PIARC] PIARC skid-resistance–speed gradient: wet μ falls with speed
 *          (≈ 0.3–0.6 %/(km/h) on dense asphalt), more on worn tread / smooth
 *          texture.
 *  [W]     J. Y. Wong, "Theory of Ground Vehicles", 4th ed. (2008): Table 1.1
 *          (C_rr: concrete 0.01–0.015, gravel road ≈ 0.02–0.05, field 0.08–0.35,
 *          sand 0.15–0.3), §2 (Bekker sinkage, Janosi–Hanamoto: on soil the
 *          thrust rises with slip toward the soil's shear strength, no peak).
 *  [ROAD]  Road-safety friction tables (e.g. NHTSA / accident reconstruction):
 *          dry gravel 0.55–0.7, dry dirt 0.65–0.75, grass 0.4–0.6, wet grass
 *          0.3–0.45, mud 0.2–0.4, loose sand 0.4–0.6.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MaterialId } from '../../../protocol/messages';
import type { VehicleRuntimeEx } from '../runtime';
import { benchStep, createTyreBench } from './tyreBench';
import { classWheel, meanOver, peakOf, TYRE_CLASSES } from './tyreClasses';
import { longitudinalSweep, type TyrePoint } from './tyreSweeps';

const { wheel, fz0 } = classWheel(TYRE_CLASSES.find((c) => c.id === 'passenger')!);
const fxB = (q: TyrePoint): number => -q.fx / q.fz;
const negK = (q: TyrePoint): number => -q.kappa;

interface SurfaceRun {
  muX: number;
  kPeak: number;
  /** Braking force at κ −0.5 ÷ the peak. */
  late: number;
  crr: number;
  sinkage: number;
  lift: number;
}

function brakeOn(materialId: number, speed: number, wetness = 0, rain = 0, mod: Partial<typeof wheel> = {}): SurfaceRun {
  const w = { ...wheel, ...mod };
  const br = longitudinalSweep(w, { load: fz0, kappaEnd: -0.6, speed, materialId, wetness, rain });
  const p = peakOf(br, fxB, negK);
  const b = createTyreBench(w, { load: fz0, speed, materialId, wetness, rain });
  let fx = 0;
  for (let i = 0; i < 2000; i++) {
    benchStep(b);
    fx += b.fx;
  }
  const t = (b.veh as VehicleRuntimeEx).tyres[0]!;
  return { muX: p.peak, kPeak: p.at, late: meanOver(br, fxB, 0.45, 0.55, negK) / p.peak, crr: -fx / 2000 / fz0, sinkage: t.sinkage, lift: t.lift };
}

const R: Record<string, SurfaceRun> = {};
beforeAll(() => {
  R.dry = brakeOn(MaterialId.asphalt, 15);
  R.wet15 = brakeOn(MaterialId.asphalt, 15, 1, 0.3);
  R.wet25 = brakeOn(MaterialId.asphalt, 25, 1, 0.3);
  R.flood33 = brakeOn(MaterialId.asphalt, 33, 1, 1);
  R.gravel = brakeOn(MaterialId.gravel, 15);
  R.dirt = brakeOn(MaterialId.dirt, 15);
  R.grass = brakeOn(MaterialId.grass, 15);
  R.wetGrass = brakeOn(MaterialId.wetGrass, 15);
  R.mud = brakeOn(MaterialId.mud, 10);
  R.sand = brakeOn(MaterialId.sand, 10);
  R.sandAired = brakeOn(MaterialId.sand, 10, 0, 0, { tyrePressure: 120 });
}, 600_000);

describe('tyre on surfaces (205/55R16 bench)', () => {
  it('wet asphalt: μ 20–40 % below dry at 54 km/h, falling further with speed [ADAC][PIARC]', () => {
    const r15 = R.wet15!.muX / R.dry!.muX;
    const r25 = R.wet25!.muX / R.dry!.muX;
    expect(r15).toBeGreaterThan(0.6);
    expect(r15).toBeLessThan(0.8);
    expect(r25).toBeLessThan(r15);
    expect(r25).toBeGreaterThan(0.5);
  });

  it('hydroplaning: in standing water (2.5 mm) at 120 km/h the patch lifts and grip collapses [ADAC]', () => {
    expect(R.flood33!.lift).toBeGreaterThan(0.5);
    expect(R.flood33!.muX).toBeLessThan(0.45 * R.dry!.muX);
    // a damp road (no standing water) never lifts the tyre at 90 km/h
    expect(R.wet25!.lift).toBe(0);
  });

  it('loose / soft ground: grip of the published range, rising with slip (no peak) [ROAD][W]', () => {
    const band: Record<string, [number, number]> = {
      gravel: [0.5, 0.72],
      dirt: [0.55, 0.78],
      grass: [0.4, 0.62],
      wetGrass: [0.28, 0.45],
      mud: [0.2, 0.4],
      sand: [0.4, 0.62],
    };
    for (const [k, [lo, hi]] of Object.entries(band)) {
      const r = R[k]!;
      expect(r.muX, k).toBeGreaterThan(lo);
      expect(r.muX, k).toBeLessThan(hi);
      // the soil's shear strength is reached at large slip: still ≥ 0.85 of the peak at κ −0.5, and the peak lies past κ 0.3
      expect(r.late, k).toBeGreaterThan(0.85);
      expect(r.kPeak, k).toBeGreaterThan(0.3);
    }
  });

  it('rolling resistance by surface: asphalt ≈ 0.01–0.02, gravel / dirt 0.02–0.06, grass 0.04–0.1, mud and sand 0.12–0.3 [W]', () => {
    expect(R.dry!.crr).toBeGreaterThan(0.007);
    expect(R.dry!.crr).toBeLessThan(0.02);
    for (const k of ['gravel', 'dirt']) {
      expect(R[k]!.crr, k).toBeGreaterThan(0.02);
      expect(R[k]!.crr, k).toBeLessThan(0.06);
    }
    expect(R.grass!.crr).toBeGreaterThan(0.04);
    expect(R.grass!.crr).toBeLessThan(0.1);
    for (const k of ['mud', 'sand']) {
      expect(R[k]!.crr, k).toBeGreaterThan(0.12);
      expect(R[k]!.crr, k).toBeLessThan(0.3);
    }
  });

  it('soft-soil sinkage: sand and mud 4–12 cm, firm soils ≤ 2.5 cm; airing down floats on sand (less sinkage and rolling resistance) [W §2]', () => {
    expect(R.sand!.sinkage).toBeGreaterThan(0.04);
    expect(R.sand!.sinkage).toBeLessThan(0.12);
    expect(R.mud!.sinkage).toBeGreaterThan(0.04);
    expect(R.mud!.sinkage).toBeLessThan(0.12);
    for (const k of ['gravel', 'dirt', 'grass']) expect(R[k]!.sinkage, k).toBeLessThan(0.025);
    expect(R.sandAired!.sinkage).toBeLessThan(0.9 * R.sand!.sinkage);
    expect(R.sandAired!.crr).toBeLessThan(0.9 * R.sand!.crr);
  });
});
