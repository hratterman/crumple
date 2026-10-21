/**
 * TYRE REALISM (flat-track bench, tyreBench.ts): the soft-body sedan tyre
 * (205/55R16 class, WHEEL_TUNING_205_55R16) against published passenger-car
 * tyre behaviour. Sources:
 *  [P] H. B. Pacejka, "Tyre and Vehicle Dynamics", 3rd ed. (2012): ch. 1, 4
 *      (Magic Formula shapes: lateral peak at α ≈ 6–9°, C_α/Fz ≈ 15–20 /rad
 *      for passenger radials at nominal load, sliding/peak ≈ 0.75–0.9,
 *      longitudinal peak at κ ≈ 0.1–0.2, locked/peak ≈ 0.7–0.85, μ falling
 *      with load (pDy2 ≈ −0.1), relaxation length ≈ 0.3–0.6 m, pneumatic
 *      trail collapsing past the peak).
 *  [G] T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (1992): ch. 10
 *      (camber thrust of radial car tyres ≈ 0.004–0.012·Fz per degree;
 *      aligning moment peaks at ≈ 2–5° and returns toward 0 near 10–15°).
 *  [W] J. Y. Wong, "Theory of Ground Vehicles", 4th ed.: eq. 1.12, car
 *      tyre rolling resistance f_r ≈ 0.01·(1 + V/160 km/h).
 * Set REALISM_OUT=<dir> to dump the curves for the plots.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SEDAN } from '../defs/sedan';
import { dumpJson } from './dump';
import { DEG, freeRolling, lateralSweep, longitudinalSweep, relaxationStep, type TyrePoint } from './tyreSweeps';

const W = SEDAN.wheels[0]!;
let lat2: TyrePoint[];
let lat4: TyrePoint[];
let lat6: TyrePoint[];
let brake: TyrePoint[];
let comb: TyrePoint[];
let relax: ReturnType<typeof relaxationStep>;
let camber: TyrePoint[];
let roll: TyrePoint[];

/** Peak of the 5-point moving mean of y over the sweep, and where (x). */
function peakOf(pts: TyrePoint[], y: (p: TyrePoint) => number, x: (p: TyrePoint) => number): { peak: number; at: number } {
  let best = -Infinity;
  let at = 0;
  for (let i = 5; i <= pts.length; i++) {
    let a = 0;
    for (let j = i - 5; j < i; j++) a += y(pts[j]!);
    a /= 5;
    if (a > best) {
      best = a;
      at = x(pts[i - 3]!);
    }
  }
  return { peak: best, at };
}
const meanOver = (pts: TyrePoint[], y: (p: TyrePoint) => number, lo: number, hi: number, x: (p: TyrePoint) => number): number => {
  const sel = pts.filter((p) => x(p) >= lo && x(p) <= hi);
  return sel.reduce((a, p) => a + y(p), 0) / sel.length;
};
const fyFz = (p: TyrePoint): number => p.fy / p.fz;
const alpha = (p: TyrePoint): number => p.alphaDeg;

beforeAll(async () => {
  lat2 = lateralSweep(W, { load: 2000, maxDeg: 20 });
  lat4 = lateralSweep(W, { load: 4000, maxDeg: 20 });
  lat6 = lateralSweep(W, { load: 6000, maxDeg: 20 });
  brake = longitudinalSweep(W, { load: 4000, kappaEnd: -0.8 });
  comb = longitudinalSweep(W, { load: 4000, kappaEnd: -0.5, alphaDeg: 5 });
  relax = relaxationStep(W, { load: 4000, stepDeg: 2 });
  camber = [-4, 0, 4].map((c) => freeRolling(W, { load: 4000, camberDeg: c, durationS: 0.6 }));
  roll = [15, 30].map((v) => freeRolling(W, { load: 4000, speed: v, durationS: 1 }));
  await dumpJson('tyre_after', { lat_2000: lat2, lat_4000: lat4, lat_6000: lat6, long_brake: brake, comb_5: comb, relax, camber, roll });
}, 240_000);

describe('tyre realism (205/55R16 class on the flat-track bench)', () => {
  it('lateral: peak at 5–10° slip angle at nominal load, C_α/Fz 12–22 /rad [P]', () => {
    const p = peakOf(lat4, fyFz, alpha);
    expect(p.at).toBeGreaterThan(5);
    expect(p.at).toBeLessThan(10);
    const c1 = lat4.find((q) => q.alphaDeg >= 1)!;
    const ca = fyFz(c1) / (c1.alphaDeg * DEG);
    expect(ca).toBeGreaterThan(12);
    expect(ca).toBeLessThan(22);
  });

  it('lateral: gradual fall-off past the peak, sliding (16–20°) at 0.75–0.95 of the peak [P]', () => {
    const p = peakOf(lat4, fyFz, alpha);
    const slide = meanOver(lat4, fyFz, 16, 20, alpha);
    expect(slide / p.peak).toBeGreaterThan(0.75);
    expect(slide / p.peak).toBeLessThan(0.95);
  });

  it('load sensitivity: peak μ falls with load, μ(6 kN)/μ(2 kN) 0.78–0.95 [P pDy2 ≈ −0.1]', () => {
    const r = peakOf(lat6, fyFz, alpha).peak / peakOf(lat2, fyFz, alpha).peak;
    expect(r).toBeGreaterThan(0.78);
    expect(r).toBeLessThan(0.95);
  });

  it('longitudinal (braking): peak at κ 0.08–0.25, locked wheel 0.7–0.9 of the peak [P]', () => {
    const fx = (p: TyrePoint): number => -p.fx / p.fz;
    const p = peakOf(brake, fx, (q) => -q.kappa);
    expect(p.at).toBeGreaterThan(0.08);
    expect(p.at).toBeLessThan(0.25);
    const locked = meanOver(brake, fx, 0.6, 0.8, (q) => -q.kappa);
    expect(locked / p.peak).toBeGreaterThan(0.7);
    expect(locked / p.peak).toBeLessThan(0.9);
  });

  it('combined slip: braking to κ ≈ −0.4 at α 5° costs ≥ 35 % of the side force (friction ellipse) [P ch. 4.3]', () => {
    const fy0 = meanOver(comb, fyFz, 0, 0.02, (q) => -q.kappa);
    const fyHard = meanOver(comb, fyFz, 0.35, 0.45, (q) => -q.kappa);
    expect(fyHard / fy0).toBeLessThan(0.65);
    // and the resultant never exceeds the peak friction by more than 10 %
    for (const q of comb) expect(Math.hypot(q.fx, q.fy) / q.fz).toBeLessThan(1.1 * 1.2);
  });

  it('aligning moment: peaks at 2–6° and has lost ≥ 60 % of it by 13–16° (pneumatic trail collapse) [G]', () => {
    const p = peakOf(lat4, (q) => q.mz, alpha);
    expect(p.at).toBeGreaterThan(2);
    expect(p.at).toBeLessThan(6);
    expect(meanOver(lat4, (q) => q.mz, 13, 16, alpha) / p.peak).toBeLessThan(0.4);
  });

  it('relaxation length 0.2–0.7 m [P]', () => {
    expect(relax.relaxLength).toBeGreaterThan(0.2);
    expect(relax.relaxLength).toBeLessThan(0.7);
  });

  it('camber thrust toward the lean, 0.002–0.015·Fz per degree [G]', () => {
    const perDeg = (fyFz(camber[2]!) - fyFz(camber[0]!)) / 8;
    expect(perDeg).toBeGreaterThan(0.002);
    expect(perDeg).toBeLessThan(0.015);
  });

  it('rolling resistance C_rr: 0.007–0.02 at 54 km/h, ≤ 2.5× the reference at 108 km/h [W]', () => {
    const c15 = -roll[0]!.fx / roll[0]!.fz;
    const c30 = -roll[1]!.fx / roll[1]!.fz;
    expect(c15).toBeGreaterThan(0.007);
    expect(c15).toBeLessThan(0.02);
    expect(c30).toBeLessThan(2.5 * 0.01 * (1 + 108 / 160));
  });
});
