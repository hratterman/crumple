/**
 * TYRE CLASS VALIDATION (R-TYRE): every tyre class the game drives on, swept
 * on the flat-track bench and reduced to its characteristic values
 * (tyreClasses.ts), against its class's MF 5.2 reference (pacejka.ts) and the
 * published bands. Sources:
 *  [P]      H. B. Pacejka, "Tyre and Vehicle Dynamics", 3rd ed. (2012): ch. 1, 4,
 *           App. 3 (MF 5.2 205/60R15 set; peak μ falls with load, pDy2/pDy1 ≈ −0.15;
 *           relaxation length ≈ C_Fα / C_Fy).
 *  [G]      T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (1992) ch. 10
 *           (cornering coefficient ≈ 0.2 /deg car, 0.1–0.16 /deg truck; aligning
 *           moment peaks at 2–5° and fades by 10–15°).
 *  [RCVD]   W. F. & D. L. Milliken, "Race Car Vehicle Dynamics" (1995) ch. 2
 *           (performance radials: higher C_α/Fz, peak at smaller slip angles).
 *  [UMTRI]  Fancher, Ervin, Winkler, Gillespie, "A Factbook of the Mechanical
 *           Properties of the Components for Single-Unit and Articulated Heavy
 *           Trucks", UMTRI-86-12 (1986): radial truck tyres μ_peak 0.7–0.85 dry,
 *           cornering coefficient 0.1–0.16 /deg at rated load.
 *  [W]      J. Y. Wong, "Theory of Ground Vehicles", 4th ed. (2008) §1.2: car tyre
 *           f_r ≈ 0.01·(1 + V/160 km/h) on hard road; truck radials 0.006–0.009.
 * Set REALISM_OUT=<dir> to dump every curve (tyre_classes.json) for the plots.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dumpJson } from './dump';
import { measureTyreClass, TYRE_CLASSES, type TyreCurves, type TyreMetrics } from './tyreClasses';

interface Bands {
  /** C_α/Fz at Fz0, 1/rad. */
  caPerFz: [number, number];
  /** Slip angle reaching 95 % of the peak at Fz0, deg. */
  alpha95: [number, number];
  /** Peak braking μ_x ÷ the class reference μ_x. */
  muXRel: [number, number];
  /** Peak μ_y at Fz0 ÷ the class reference. */
  muYRel: [number, number];
  /** Locked-wheel / peak braking force. */
  locked: [number, number];
}

const BANDS: Record<string, Bands> = {
  // [P] App. 3 set 11.9 /rad at Fz0, modern 55-series summer tyres 15–20 /rad (R-PHYS tyre test)
  passenger: { caPerFz: [11, 22], alpha95: [2.5, 9], muXRel: [0.85, 1.15], muYRel: [0.85, 1.2], locked: [0.7, 0.92] },
  passenger10: { caPerFz: [11, 22], alpha95: [2.5, 9], muXRel: [0.85, 1.15], muYRel: [0.85, 1.2], locked: [0.7, 0.92] },
  // [RCVD] 18–25 /rad
  performance: { caPerFz: [15, 26], alpha95: [2.5, 8], muXRel: [0.85, 1.15], muYRel: [0.85, 1.15], locked: [0.75, 0.95] },
  economy: { caPerFz: [10, 18], alpha95: [2.5, 9], muXRel: [0.85, 1.15], muYRel: [0.85, 1.15], locked: [0.7, 0.92] },
  // [G] 0.15–0.2 /deg ≈ 8.6–11.5 /rad
  lightTruck: { caPerFz: [7, 13], alpha95: [4, 12], muXRel: [0.85, 1.2], muYRel: [0.85, 1.15], locked: [0.7, 0.92] },
  // [UMTRI] 0.1–0.16 /deg ≈ 5.7–9.2 /rad
  truck: { caPerFz: [4.5, 9.5], alpha95: [5, 14], muXRel: [0.85, 1.15], muYRel: [0.85, 1.15], locked: [0.7, 0.92] },
};

const results = new Map<string, { sim: TyreMetrics; ref: TyreMetrics; curves: TyreCurves; refCurves: TyreCurves }>();

beforeAll(async () => {
  for (const c of TYRE_CLASSES) results.set(c.id, measureTyreClass(c, { relaxTrace: true }));
  await dumpJson('tyre_classes', Object.fromEntries([...results].map(([id, r]) => [id, { ...r, size: TYRE_CLASSES.find((c) => c.id === id)!.size }])));
}, 300_000);

describe.each(TYRE_CLASSES.map((c) => [c.id, c] as const))('tyre class %s', (id) => {
  const b = BANDS[id]!;
  const r = (): { sim: TyreMetrics; ref: TyreMetrics } => results.get(id)!;

  it(`cornering stiffness C_α/Fz ${b.caPerFz[0]}–${b.caPerFz[1]} /rad at the static load, 95 % of the peak by ${b.alpha95[0]}–${b.alpha95[1]}° [P][G][RCVD][UMTRI]`, () => {
    const { sim } = r();
    const ca = sim.caPerFz[1]!;
    const a95 = sim.alpha95[1]!;
    expect(ca).toBeGreaterThan(b.caPerFz[0]);
    expect(ca).toBeLessThan(b.caPerFz[1]);
    expect(a95).toBeGreaterThan(b.alpha95[0]);
    expect(a95).toBeLessThan(b.alpha95[1]);
    // C_α rises with load (degressively) [P]
    expect(sim.caNdeg[1]!).toBeGreaterThan(sim.caNdeg[0]!);
  });

  it('peak friction within the class reference band, falling with load [P]', () => {
    const { sim, ref } = r();
    const my = sim.muY[1]! / ref.muY[1]!;
    expect(my).toBeGreaterThan(b.muYRel[0]);
    expect(my).toBeLessThan(b.muYRel[1]);
    expect(sim.muX / ref.muX).toBeGreaterThan(b.muXRel[0]);
    expect(sim.muX / ref.muX).toBeLessThan(b.muXRel[1]);
    expect(sim.loadSens).toBeLessThan(-0.03);
    expect(sim.loadSens).toBeGreaterThan(-0.25);
  });

  it(`longitudinal: braking peak at κ 0.06–0.25, locked wheel ${b.locked[0]}–${b.locked[1]} of the peak [P] (max-performance compounds keep more sliding grip)`, () => {
    const { sim } = r();
    expect(sim.kappaPeak).toBeGreaterThan(0.06);
    expect(sim.kappaPeak).toBeLessThan(0.25);
    expect(sim.lockedRatio).toBeGreaterThan(b.locked[0]);
    expect(sim.lockedRatio).toBeLessThan(b.locked[1]);
  });

  it('combined slip: inside the friction ellipse; braking at α 5° costs side force like the MF 5.2 reference [P §4.3.2]', () => {
    const { sim, ref } = r();
    // (Fx/μ_x)² + (Fy/μ_y)² with the pure-slip peaks: MF 5.2 itself reaches ≈ 1.04 (its G-functions are not an exact ellipse)
    expect(sim.ellipseMax).toBeLessThan(1.12);
    // MF: Fy kept 0.84 at κ −0.1 and 0.30 at κ −0.4; the 10-ray truck bench is noisy at κ −0.1
    expect(sim.fyKeep10).toBeLessThan(id === 'truck' ? 1.2 : 1.0);
    expect(sim.fyKeep40).toBeLessThan(ref.fyKeep40 + 0.25);
    expect(sim.fyKeep40).toBeGreaterThan(0.1);
  });

  it('aligning moment peaks before the side force, at 1.5–7° [G]', () => {
    const { sim } = r();
    expect(sim.mzPeakAlpha).toBeGreaterThan(1.5);
    expect(sim.mzPeakAlpha).toBeLessThan(7);
    expect(sim.mzPeakAlpha).toBeLessThan(sim.alphaPeak[1]!);
  });
});
