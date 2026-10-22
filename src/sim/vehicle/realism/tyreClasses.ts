/**
 * TYRE CLASS VALIDATION (harness only; Math.* and allocation allowed): every
 * tyre the game drives on, swept on the flat-track bench (tyreBench.ts) and
 * reduced to the characteristic values tyre engineers quote, next to the
 * same values read off a Pacejka 2002 (MF 5.2) reference curve of its class
 * (pacejka.ts). One function, `measureTyreClass`, so the test, the report
 * and the plots read the same numbers.
 *
 * Characteristic values (per class, at Fz0 = the vehicle's static wheel load
 * unless noted):
 *  - lateral, at 0.5 / 1 / 1.5·Fz0: peak μ_y, the slip angle of the peak and
 *    of 95 % of it, cornering stiffness C_α (N/deg, secant 0 → 1°) and C_α/Fz,
 *    sliding ratio (mean of 16–20° / peak);
 *  - load sensitivity: dμ_y/d(dfz), dfz = Fz/Fz0 − 1 (MF pDy2/pDy1);
 *  - aligning moment: peak and where, the fraction left at 13–16°, the
 *    pneumatic trail at 1° (t0) and the slip angle where the trail is gone;
 *  - longitudinal (braking and driving): peak μ_x, slip ratio of the peak,
 *    locked-wheel ratio (κ −0.6…−0.8 / peak), slip stiffness C_κ/Fz (secant 0 → 2 %);
 *  - combined: side force kept while braking at α 5° (κ −0.1 and −0.4) and the
 *    exponent n of the best-fit friction "ellipse" |x|ⁿ + |y|ⁿ = 1;
 *  - relaxation length after a 2° step at 5 / 15 / 30 m/s;
 *  - rolling resistance coefficient at 36 / 72 / 108 / 144 km/h.
 */
import { compileVehicle } from '../builder';
import { BEATER } from '../defs/beater';
import { BOXTRUCK } from '../defs/boxtruck';
import { COUPE } from '../defs/coupe';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import { SEDAN_TRAFFIC } from '../defs/sedanTraffic';
import type { VehicleDef, WheelDef } from '../types';
import { MF_ECONOMY, MF_LIGHT_TRUCK, MF_PASSENGER, MF_PERFORMANCE, MF_TRUCK, mfCombined, mfFx0, mfFy0, mfMz0, type MF52 } from './pacejka';
import { DEG, freeRolling, lateralSweep, longitudinalSweep, relaxationStep, type TyrePoint } from './tyreSweeps';

export interface TyreClass {
  id: string;
  /** Tyre the def models (its comment). */
  size: string;
  vehicle: VehicleDef;
  /** Which of the vehicle's wheels is benched (the front: steer axle). */
  wheelIndex: number;
  mf: MF52;
}

export const TYRE_CLASSES: readonly TyreClass[] = [
  { id: 'passenger', size: '205/55R16 summer (sedan)', vehicle: SEDAN, wheelIndex: 0, mf: MF_PASSENGER },
  { id: 'passenger10', size: '205/55R16, 10-ray traffic rig', vehicle: SEDAN_TRAFFIC, wheelIndex: 0, mf: MF_PASSENGER },
  { id: 'performance', size: '255/35R19 max-performance (coupe)', vehicle: COUPE, wheelIndex: 0, mf: MF_PERFORMANCE },
  { id: 'economy', size: '175/70R14 budget (beater)', vehicle: BEATER, wheelIndex: 0, mf: MF_ECONOMY },
  { id: 'lightTruck', size: 'LT265/70R17 all-terrain (pickup)', vehicle: PICKUP, wheelIndex: 0, mf: MF_LIGHT_TRUCK },
  { id: 'truck', size: '245/70R19.5 regional truck (box truck)', vehicle: BOXTRUCK, wheelIndex: 0, mf: MF_TRUCK },
];

/** Static wheel load of the vehicle (its tyre model's default Fz0), N. */
export function staticWheelLoad(def: VehicleDef): number {
  const cv = compileVehicle(def);
  return (cv.totalMass * 9.81) / def.wheels.length;
}

/** The benched wheel def with the vehicle's design load. */
export function classWheel(c: TyreClass): { wheel: WheelDef; fz0: number } {
  const fz0 = staticWheelLoad(c.vehicle);
  const w = c.vehicle.wheels[c.wheelIndex]!;
  return { wheel: { ...w, tyreDesignLoad: w.tyreDesignLoad ?? fz0 }, fz0 };
}

export const LOAD_FACTORS = [0.5, 1, 1.5] as const;
export const RELAX_SPEEDS = [5, 15, 30] as const;
export const ROLL_SPEEDS = [10, 20, 30, 40] as const;

export interface TyreCurves {
  fz0: number;
  lat: TyrePoint[][];
  brake: TyrePoint[];
  drive: TyrePoint[];
  /** Braking sweeps at α 5°. */
  comb: TyrePoint[];
  relax: { speed: number; length: number; trace?: { dist: number; fy: number }[] }[];
  roll: { speed: number; crr: number }[];
}

export interface TyreMetrics {
  fz0: number;
  muY: number[];
  alphaPeak: number[];
  alpha95: number[];
  caNdeg: number[];
  caPerFz: number[];
  slideRatio: number[];
  loadSens: number;
  mzPeak: number;
  mzPeakAlpha: number;
  mzFall: number;
  trail0: number;
  trailZeroAlpha: number;
  muX: number;
  kappaPeak: number;
  lockedRatio: number;
  kxPerFz: number;
  muXDrive: number;
  kappaPeakDrive: number;
  fyKeep10: number;
  fyKeep40: number;
  ellipseN: number;
  /** Max over the combined sweep of (Fx/(μ_x·Fz))² + (Fy/(μ_y·Fz))² with the pure-slip peaks (≤ 1: inside the friction ellipse). */
  ellipseMax: number;
  relax: number[];
  crr: number[];
}

// ------------------------------------------------------------ sweeps
/** Runs every sweep of the class on the bench (≈ 3–5 s of CPU). */
export function sweepClass(c: TyreClass, opts: { relaxTrace?: boolean } = {}): TyreCurves {
  const { wheel, fz0 } = classWheel(c);
  return sweepWheel(wheel, fz0, opts);
}

export function sweepWheel(wheel: WheelDef, fz0: number, opts: { relaxTrace?: boolean; materialId?: number } = {}): TyreCurves {
  const m = opts.materialId;
  const lat = LOAD_FACTORS.map((f) => lateralSweep(wheel, { load: fz0 * f, maxDeg: 20, materialId: m }));
  const brake = longitudinalSweep(wheel, { load: fz0, kappaEnd: -0.8, materialId: m });
  const drive = longitudinalSweep(wheel, { load: fz0, kappaEnd: 0.5, materialId: m });
  const comb = longitudinalSweep(wheel, { load: fz0, kappaEnd: -0.5, alphaDeg: 5, materialId: m });
  const relax = RELAX_SPEEDS.map((speed) => {
    const r = relaxationStep(wheel, { load: fz0, speed, stepDeg: 2, materialId: m });
    return { speed, length: r.relaxLength, ...(opts.relaxTrace ? { trace: r.trace } : {}) };
  });
  const roll = ROLL_SPEEDS.map((speed) => {
    const p = freeRolling(wheel, { load: fz0, speed, durationS: 1, materialId: m });
    return { speed, crr: -p.fx / p.fz };
  });
  return { fz0, lat, brake, drive, comb, relax, roll };
}

/** The same curves from an MF 5.2 set (no relaxation / rolling data: NaN). */
export function mfCurves(p: MF52, fz0: number): TyreCurves {
  const pt = (alphaDeg: number, kappa: number, fx: number, fy: number, fz: number, mz: number): TyrePoint => ({
    alphaDeg,
    kappa,
    fx,
    fy,
    fz,
    mz,
    dist: 0,
  });
  const lat = LOAD_FACTORS.map((f) => {
    const fz = fz0 * f;
    const out: TyrePoint[] = [];
    for (let a = 0.08; a <= 20.0001; a += 0.08) out.push(pt(a, 0, 0, mfFy0(p, a * DEG, fz), fz, mfMz0(p, a * DEG, fz)));
    return out;
  });
  const lon = (end: number): TyrePoint[] => {
    const out: TyrePoint[] = [];
    const n = Math.round(Math.abs(end) / 0.005);
    for (let i = 1; i <= n; i++) {
      const k = (end * i) / n;
      out.push(pt(0, k, mfFx0(p, k, fz0), 0, fz0, 0));
    }
    return out;
  };
  const comb: TyrePoint[] = [];
  for (let i = 0; i <= 100; i++) {
    const k = (-0.5 * i) / 100;
    const [fx, fy] = mfCombined(p, k, 5 * DEG, fz0);
    comb.push(pt(5, k, fx, fy, fz0, 0));
  }
  return {
    fz0,
    lat,
    brake: lon(-0.8),
    drive: lon(0.5),
    comb,
    relax: RELAX_SPEEDS.map((speed) => ({ speed, length: NaN })),
    roll: ROLL_SPEEDS.map((speed) => ({ speed, crr: NaN })),
  };
}

// ------------------------------------------------------------ reduction
/** Peak of the 5-point moving mean of y, and the x at its centre. */
export function peakOf(pts: TyrePoint[], y: (p: TyrePoint) => number, x: (p: TyrePoint) => number): { peak: number; at: number } {
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

export function meanOver(pts: TyrePoint[], y: (p: TyrePoint) => number, lo: number, hi: number, x: (p: TyrePoint) => number): number {
  const sel = pts.filter((p) => x(p) >= lo && x(p) <= hi);
  return sel.reduce((a, p) => a + y(p), 0) / sel.length;
}

/** Value of y at the first point whose x ≥ x0 (linear between neighbours). */
function at(pts: TyrePoint[], y: (p: TyrePoint) => number, x: (p: TyrePoint) => number, x0: number): number {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x(b) >= x0) {
      const t = (x0 - x(a)) / (x(b) - x(a) || 1);
      return y(a) + (y(b) - y(a)) * Math.min(1, Math.max(0, t));
    }
  }
  return y(pts[pts.length - 1]!);
}

const fyFz = (p: TyrePoint): number => p.fy / p.fz;
const alphaOf = (p: TyrePoint): number => p.alphaDeg;
const negK = (p: TyrePoint): number => -p.kappa;

export function reduceCurves(c: TyreCurves): TyreMetrics {
  const muY: number[] = [];
  const alphaPeak: number[] = [];
  const alpha95: number[] = [];
  const caNdeg: number[] = [];
  const caPerFz: number[] = [];
  const slideRatio: number[] = [];
  for (const lat of c.lat) {
    const p = peakOf(lat, fyFz, alphaOf);
    muY.push(p.peak);
    alphaPeak.push(p.at);
    // 95 % of the peak, on a 5-point smoothed curve
    let a95 = NaN;
    for (let i = 4; i < lat.length; i++) {
      let s = 0;
      for (let j = i - 4; j <= i; j++) s += fyFz(lat[j]!);
      if (s / 5 >= 0.95 * p.peak) {
        a95 = lat[i - 2]!.alphaDeg;
        break;
      }
    }
    alpha95.push(a95);
    const fy1 = at(lat, (q) => q.fy, alphaOf, 1);
    const fz = lat[0]!.fz;
    caNdeg.push(fy1);
    caPerFz.push(fy1 / fz / DEG);
    slideRatio.push(meanOver(lat, fyFz, 16, 20, alphaOf) / p.peak);
  }
  // load sensitivity: least squares of μ_y on dfz
  const xs = c.lat.map((l) => l[0]!.fz / c.fz0 - 1);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = muY.reduce((a, b) => a + b, 0) / muY.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (muY[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const loadSens = sxy / sxx;
  // aligning moment at Fz0
  const nom = c.lat[1]!;
  const mz = peakOf(nom, (q) => q.mz, alphaOf);
  const mzFall = meanOver(nom, (q) => q.mz, 13, 16, alphaOf) / mz.peak;
  const trail0 = at(nom, (q) => q.mz, alphaOf, 1) / at(nom, (q) => q.fy, alphaOf, 1);
  let trailZeroAlpha = NaN;
  for (let i = 4; i < nom.length; i++) {
    let s = 0;
    for (let j = i - 4; j <= i; j++) s += nom[j]!.mz;
    if (nom[i]!.alphaDeg > mz.at && s <= 0) {
      trailZeroAlpha = nom[i - 2]!.alphaDeg;
      break;
    }
  }
  // longitudinal
  const fxB = (q: TyrePoint): number => -q.fx / q.fz;
  const pb = peakOf(c.brake, fxB, negK);
  const lockedRatio = meanOver(c.brake, fxB, 0.6, 0.8, negK) / pb.peak;
  const kxPerFz = at(c.brake, fxB, negK, 0.02) / 0.02;
  const pd = peakOf(c.drive, (q) => q.fx / q.fz, (q) => q.kappa);
  // combined at α 5°
  // reference: the pure-slip side force at α 5° (lateral sweep, ±0.4°); combined values averaged over κ ± 0.02
  const fy0 = meanOver(nom, (q) => q.fy, 4.6, 5.4, alphaOf);
  const fyKeep10 = meanOver(c.comb, (q) => q.fy, 0.08, 0.12, negK) / fy0;
  const fyKeep40 = meanOver(c.comb, (q) => q.fy, 0.38, 0.42, negK) / fy0;
  const fxMax = Math.max(...c.comb.map((q) => -q.fx));
  let bestN = 2;
  let bestErr = Infinity;
  for (let n = 1; n <= 4.0001; n += 0.05) {
    let e = 0;
    let cnt = 0;
    for (const q of c.comb) {
      const x = -q.fx / fxMax;
      const y = q.fy / fy0;
      if (x < 0.05 || y < 0.05) continue;
      // only up to the Fx peak (the ellipse describes the envelope)
      if (-q.kappa > 0.25) continue;
      e += (x ** n + y ** n - 1) ** 2;
      cnt++;
    }
    if (cnt > 0 && e / cnt < bestErr) {
      bestErr = e / cnt;
      bestN = n;
    }
  }
  let ellipseMax = 0;
  for (let i = 2; i < c.comb.length - 2; i++) {
    let fx = 0;
    let fy = 0;
    for (let j = i - 2; j <= i + 2; j++) {
      fx += c.comb[j]!.fx / c.comb[j]!.fz;
      fy += c.comb[j]!.fy / c.comb[j]!.fz;
    }
    const e = (fx / 5 / pb.peak) ** 2 + (fy / 5 / muY[1]!) ** 2;
    if (e > ellipseMax) ellipseMax = e;
  }
  return {
    fz0: c.fz0,
    muY,
    alphaPeak,
    alpha95,
    caNdeg,
    caPerFz,
    slideRatio,
    loadSens,
    mzPeak: mz.peak,
    mzPeakAlpha: mz.at,
    mzFall,
    trail0,
    trailZeroAlpha,
    muX: pb.peak,
    kappaPeak: pb.at,
    lockedRatio,
    kxPerFz,
    muXDrive: pd.peak,
    kappaPeakDrive: pd.at,
    fyKeep10,
    fyKeep40,
    ellipseN: bestN,
    ellipseMax,
    relax: c.relax.map((r) => r.length),
    crr: c.roll.map((r) => r.crr),
  };
}

/** Bench + MF reference metrics of one class. */
export function measureTyreClass(c: TyreClass, opts: { relaxTrace?: boolean } = {}): {
  sim: TyreMetrics;
  ref: TyreMetrics;
  curves: TyreCurves;
  refCurves: TyreCurves;
} {
  const curves = sweepClass(c, opts);
  const { fz0 } = classWheel(c);
  const refCurves = mfCurves(c.mf, fz0);
  return { sim: reduceCurves(curves), ref: reduceCurves(refCurves), curves, refCurves };
}
