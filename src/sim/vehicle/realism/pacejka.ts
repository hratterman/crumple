/**
 * PACEJKA 2002 (Magic Formula 5.2) REFERENCE TYRES — harness only (never
 * imported by the engine; Math.* allowed).
 *
 * Pure-slip longitudinal / lateral force and aligning moment plus the MF 5.2
 * combined-slip weighting functions, without camber, shifts or scaling
 * factors (λ = 1, γ = 0: the bench references are straight-ahead, flat
 * road). Sign convention of the bench (tyreBench.ts): α > 0 = velocity right
 * of the heading, Fy > 0 opposes the slip, κ > 0 = driving, Fx > 0 forward,
 * Mz > 0 aligns (turns the wheel toward its velocity). Coefficients are
 * therefore stored as MAGNITUDES (the book's pDy1 = −0.990 for the ISO axis
 * system is 0.990 here, pDy2 keeps the sign that makes |μ_y| fall with load).
 *
 * Formulas (Pacejka, "Tyre and Vehicle Dynamics", 3rd ed. 2012, §4.3.2):
 *   dfz = (Fz − Fz0)/Fz0
 *   Fx0 = Dx·sin(Cx·atan(Bx·κ − Ex·(Bx·κ − atan(Bx·κ))))
 *     Cx = pCx1, Dx = (pDx1 + pDx2·dfz)·Fz, Ex = pEx1 + pEx2·dfz + pEx3·dfz²,
 *     Kx = Fz·(pKx1 + pKx2·dfz)·exp(pKx3·dfz), Bx = Kx/(Cx·Dx)
 *   Fy0 = Dy·sin(Cy·atan(By·α − Ey·(By·α − atan(By·α))))
 *     Cy = pCy1, Dy = (pDy1 + pDy2·dfz)·Fz, Ey = pEy1 + pEy2·dfz,
 *     Ky = pKy1·Fz0·sin(2·atan(Fz/(pKy2·Fz0))), By = Ky/(Cy·Dy)
 *   Mz0 = t·Fy0, t = Dt·cos(Ct·atan(Bt·α − Et·(Bt·α − atan(Bt·α))))·cos α
 *     Bt = qBz1 + qBz2·dfz, Ct = qCz1, Dt = (qDz1 + qDz2·dfz)·R0,
 *     Et = qEz1·(1 + qEz4·(2/π)·atan(Bt·Ct·α))
 *   combined: Fx = Gxα·Fx0, Gxα = cos(rCx1·atan(Bxα·α)), Bxα = rBx1·cos(atan(rBx2·κ));
 *             Fy = Gyκ·Fy0, Gyκ = cos(rCy1·atan(Byκ·κ)), Byκ = rBy1·cos(atan(rBy2·(α − rBy3)))
 */

export interface MF52 {
  /** Short id and the source of the set. */
  name: string;
  source: string;
  /** Nominal load, N, and unloaded radius, m. */
  Fz0: number;
  R0: number;
  pCx1: number;
  pDx1: number;
  pDx2: number;
  pEx1: number;
  pEx2: number;
  pEx3: number;
  pKx1: number;
  pKx2: number;
  pKx3: number;
  pCy1: number;
  pDy1: number;
  pDy2: number;
  pEy1: number;
  pEy2: number;
  pKy1: number;
  pKy2: number;
  qBz1: number;
  qBz2: number;
  qCz1: number;
  qDz1: number;
  qDz2: number;
  qEz1: number;
  qEz4: number;
  rBx1: number;
  rBx2: number;
  rCx1: number;
  rBy1: number;
  rBy2: number;
  rBy3: number;
  rCy1: number;
}

const clampE = (e: number): number => (e > 1 ? 1 : e);

/** Pure longitudinal force, N (κ > 0 driving). */
export function mfFx0(p: MF52, kappa: number, Fz: number): number {
  const dfz = (Fz - p.Fz0) / p.Fz0;
  const C = p.pCx1;
  const D = (p.pDx1 + p.pDx2 * dfz) * Fz;
  const E = clampE(p.pEx1 + p.pEx2 * dfz + p.pEx3 * dfz * dfz);
  const K = Fz * (p.pKx1 + p.pKx2 * dfz) * Math.exp(p.pKx3 * dfz);
  const B = K / (C * D);
  const bx = B * kappa;
  return D * Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

/** Pure lateral force, N (α rad, Fy > 0 opposes α > 0). */
export function mfFy0(p: MF52, alpha: number, Fz: number): number {
  const dfz = (Fz - p.Fz0) / p.Fz0;
  const C = p.pCy1;
  const D = (p.pDy1 + p.pDy2 * dfz) * Fz;
  const E = clampE(p.pEy1 + p.pEy2 * dfz);
  const K = p.pKy1 * p.Fz0 * Math.sin(2 * Math.atan(Fz / (p.pKy2 * p.Fz0)));
  const B = K / (C * D);
  const by = B * alpha;
  return D * Math.sin(C * Math.atan(by - E * (by - Math.atan(by))));
}

/** Pneumatic trail, m. */
export function mfTrail(p: MF52, alpha: number, Fz: number): number {
  const dfz = (Fz - p.Fz0) / p.Fz0;
  const B = p.qBz1 + p.qBz2 * dfz;
  const C = p.qCz1;
  const D = (p.qDz1 + p.qDz2 * dfz) * p.R0;
  const E = clampE(p.qEz1 * (1 + p.qEz4 * (2 / Math.PI) * Math.atan(B * C * alpha)));
  const bt = B * alpha;
  return D * Math.cos(C * Math.atan(bt - E * (bt - Math.atan(bt)))) * Math.cos(alpha);
}

/** Pure-slip aligning moment, N·m (> 0 aligns). */
export function mfMz0(p: MF52, alpha: number, Fz: number): number {
  return mfTrail(p, alpha, Fz) * mfFy0(p, alpha, Fz);
}

/** Combined slip: [Fx, Fy] at (κ, α). */
export function mfCombined(p: MF52, kappa: number, alpha: number, Fz: number): [number, number] {
  const bxa = p.rBx1 * Math.cos(Math.atan(p.rBx2 * kappa));
  const gxa = Math.cos(p.rCx1 * Math.atan(bxa * alpha));
  const byk = p.rBy1 * Math.cos(Math.atan(p.rBy2 * (alpha - p.rBy3)));
  const gyk = Math.cos(p.rCy1 * Math.atan(byk * kappa)) / Math.cos(p.rCy1 * Math.atan(byk * 0));
  return [gxa * mfFx0(p, kappa, Fz), gyk * mfFy0(p, alpha, Fz)];
}

/** pKy1 that gives cornering stiffness C_α/Fz = `ca` (1/rad) at Fz0 for a given pKy2. */
function pKy1For(ca: number, pKy2: number): number {
  return ca / Math.sin(2 * Math.atan(1 / pKy2));
}

/**
 * PASSENGER — Pacejka (2012) Appendix 3, MF 5.2 parameter set of a
 * 205/60R15 car tyre (Fz0 4 kN, R0 0.313 m), as reproduced in MF-Tyre 5.2
 * examples: pure-slip Fx / Fy and the combined-slip coefficients. Its
 * aligning-moment block is replaced by a representative trail law matched
 * to Gillespie fig. 10.13 (Mz peak at 3–5°, trail gone by ≈ 11°, t0 ≈ 0.12·R0).
 */
export const MF_PASSENGER: MF52 = {
  name: 'passenger',
  source: 'Pacejka 2012 App. 3 (205/60R15 MF 5.2), Mz block representative [G]',
  Fz0: 4000,
  R0: 0.313,
  pCx1: 1.65,
  pDx1: 1.21,
  pDx2: -0.037,
  pEx1: 0.344,
  pEx2: 0.095,
  pEx3: -0.02,
  pKx1: 21.51,
  pKx2: -0.163,
  pKx3: 0.245,
  pCy1: 1.193,
  pDy1: 0.99,
  pDy2: -0.145,
  pEy1: -1.003,
  pEy2: -0.537,
  pKy1: 14.95,
  pKy2: 2.13,
  qBz1: 10,
  qBz2: -1.5,
  qCz1: 1.2,
  qDz1: 0.12,
  qDz2: 0.02,
  qEz1: -2,
  qEz4: 0,
  rBx1: 12.35,
  rBx2: -10.77,
  rCx1: 1.092,
  rBy1: 6.461,
  rBy2: 4.196,
  rBy3: -0.015,
  rCy1: 1.081,
};

/**
 * Representative MF 5.2 sets for the other classes: the passenger set's
 * shape coefficients with the characteristic values (peak μ, its load
 * sensitivity, cornering / slip stiffness per load, curvature) set to the
 * published values of the class (sources on each set). They are reference
 * CURVES for those values, not measured tyres.
 */
export const MF_PERFORMANCE: MF52 = {
  ...MF_PASSENGER,
  name: 'performance',
  source:
    'representative 255/35R19 max-performance summer: μx ≈ 1.3–1.4, μy ≈ 1.15–1.25, Cα/Fz ≈ 18–22 /rad, peak α ≈ 5–7° [RCVD ch. 2][P §1.2]',
  Fz0: 4000,
  R0: 0.33,
  pCx1: 1.65,
  pDx1: 1.36,
  pDx2: -0.05,
  pKx1: 26,
  pCy1: 1.3,
  pDy1: 1.2,
  pDy2: -0.12,
  pEy1: -0.6,
  pEy2: -0.3,
  pKy2: 2.4,
  pKy1: pKy1For(19.5, 2.4),
};

export const MF_ECONOMY: MF52 = {
  ...MF_PASSENGER,
  name: 'economy',
  source: 'representative 175/70R14 budget summer: μx ≈ 1.05, μy ≈ 0.92, Cα/Fz ≈ 11–14 /rad [G ch. 10][P §1.2]',
  Fz0: 2600,
  R0: 0.29,
  pDx1: 1.08,
  pDy1: 0.93,
  pKx1: 20,
  pKy1: pKy1For(12.5, 2.13),
};

export const MF_LIGHT_TRUCK: MF52 = {
  ...MF_PASSENGER,
  name: 'lightTruck',
  source:
    'representative LT265/70R17 all-terrain: μx ≈ 1.0, μy ≈ 0.88, cornering coefficient ≈ 0.15–0.2 /deg (Cα/Fz ≈ 9–11 /rad), peak α ≈ 8–12° [G ch. 10]',
  Fz0: 5200,
  R0: 0.39,
  pDx1: 1.02,
  pDx2: -0.05,
  pKx1: 18,
  pCy1: 1.25,
  pDy1: 0.9,
  pDy2: -0.11,
  pEy1: -1.1,
  pKy2: 2.4,
  pKy1: pKy1For(10, 2.4),
  qDz1: 0.13,
};

export const MF_TRUCK: MF52 = {
  ...MF_PASSENGER,
  name: 'truck',
  source:
    'representative 245/70R19.5–295/80R22.5 radial truck: μ peak ≈ 0.75–0.85 dry, cornering coefficient 0.10–0.16 /deg at rated load (Cα/Fz ≈ 6–9 /rad), peak α ≈ 10–14° [UMTRI-86-12]',
  Fz0: 10600,
  R0: 0.43,
  pDx1: 0.82,
  pDx2: -0.06,
  pKx1: 14,
  pCy1: 1.3,
  pDy1: 0.78,
  pDy2: -0.09,
  pEy1: -1.2,
  pKy2: 2.8,
  pKy1: pKy1For(7, 2.8),
  qDz1: 0.1,
};
