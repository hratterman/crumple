/**
 * Tyre characteristic sweeps on the flat-track bench (tyreBench.ts), and the
 * Pacejka "Magic Formula" reference shape they are judged against. Harness
 * only (allocates; Math.* allowed).
 */
import { SIM_HZ } from '../../engine';
import type { WheelDef } from '../types';
import { benchStep, createTyreBench, type TyreBench } from './tyreBench';

export const DEG = Math.PI / 180;

export interface TyrePoint {
  /** Slip angle, deg. */
  alphaDeg: number;
  /** Slip ratio. */
  kappa: number;
  fx: number;
  fy: number;
  fz: number;
  mz: number;
  dist: number;
}

/** Averages the bench measurements over `ticks` ticks. */
function averaged(b: TyreBench, ticks: number, each?: (b: TyreBench, i: number) => void): TyrePoint {
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let mz = 0;
  let kappa = 0;
  for (let i = 0; i < ticks; i++) {
    if (each) each(b, i);
    benchStep(b);
    fx += b.fx;
    fy += b.fy;
    fz += b.fz;
    mz += b.mz;
    kappa += b.veh.wheels[0]!.slipRatio;
  }
  return {
    alphaDeg: b.alpha / DEG,
    kappa: kappa / ticks,
    fx: fx / ticks,
    fy: fy / ticks,
    fz: fz / ticks,
    mz: mz / ticks,
    dist: b.dist,
  };
}

export interface SweepOptions {
  load: number;
  speed?: number;
  camberDeg?: number;
  materialId?: number;
}

/**
 * Lateral sweep: free rolling, slip angle ramped 0 → maxDeg at `rateDegS`
 * (quasi-static: the relaxation lag at 15 m/s is ~0.03 s), one averaged
 * point per 20 ms.
 */
export function lateralSweep(wheel: WheelDef, o: SweepOptions & { maxDeg?: number; rateDegS?: number }): TyrePoint[] {
  const b = createTyreBench(wheel, { load: o.load, speed: o.speed ?? 15, camber: (o.camberDeg ?? 0) * DEG, materialId: o.materialId });
  const max = (o.maxDeg ?? 20) * DEG;
  const rate = (o.rateDegS ?? 4) * DEG;
  const per = Math.round(SIM_HZ * 0.02);
  const out: TyrePoint[] = [];
  const dA = rate / SIM_HZ;
  while (b.alpha < max) {
    out.push(
      averaged(b, per, (bb) => {
        bb.alpha = Math.min(max, bb.alpha + dA);
      }),
    );
  }
  return out;
}

/**
 * Longitudinal sweep: slip angle 0, the wheel-speed servo ramps κ from 0 to
 * `kappaEnd` (negative = braking) at `rate` per second.
 */
export function longitudinalSweep(
  wheel: WheelDef,
  o: SweepOptions & { kappaEnd: number; rate?: number; alphaDeg?: number },
): TyrePoint[] {
  const b = createTyreBench(wheel, { load: o.load, speed: o.speed ?? 15, materialId: o.materialId });
  b.alpha = (o.alphaDeg ?? 0) * DEG;
  // let the lateral force build at the fixed slip angle first
  if (b.alpha !== 0) averaged(b, Math.round(0.3 * SIM_HZ));
  const w = b.veh.wheels[0]!;
  const rate = o.rate ?? 0.25;
  const per = Math.round(SIM_HZ * 0.02);
  const out: TyrePoint[] = [];
  let k = 0;
  const vx = b.speed * Math.cos(b.alpha);
  const dK = (rate / SIM_HZ) * Math.sign(o.kappaEnd);
  while (Math.abs(k) < Math.abs(o.kappaEnd)) {
    out.push(
      averaged(b, per, (bb) => {
        k += dK;
        bb.omegaCmd = (vx * (1 + k)) / w.rollRadius;
      }),
    );
  }
  return out;
}

export interface RelaxResult {
  /** Distance to reach 63 % of the steady lateral force after a slip-angle step, m. */
  relaxLength: number;
  trace: { dist: number; fy: number }[];
  steadyFy: number;
}

/** Slip-angle step 0 → stepDeg at `speed`; relaxation length from the 63 % rise distance. */
export function relaxationStep(wheel: WheelDef, o: SweepOptions & { stepDeg?: number }): RelaxResult {
  const b = createTyreBench(wheel, { load: o.load, speed: o.speed ?? 15, materialId: o.materialId });
  // Unaveraged per-tick trace (filtered lightly over a ray passage: 12 rays at 15 m/s ≈ 90 Hz).
  const d0 = b.dist;
  const target = (o.stepDeg ?? 2) * DEG;
  const trace: { dist: number; fy: number }[] = [];
  const ticks = Math.round((2.5 / b.speed) * SIM_HZ);
  let f = 0;
  const box: number[] = [];
  const nBox = Math.max(1, Math.round((wheel.radius * 2 * Math.PI) / wheel.rays / b.speed * SIM_HZ));
  // the steer step is a 10 ms ramp (a tester's steering actuator)
  const ramp = Math.round(0.01 * SIM_HZ);
  for (let i = 0; i < ticks; i++) {
    b.alpha = target * Math.min(1, (i + 1) / ramp);
    benchStep(b);
    box.push(b.fy);
    if (box.length > nBox) box.shift();
    f = box.reduce((a, x) => a + x, 0) / box.length;
    trace.push({ dist: b.dist - d0, fy: f });
  }
  const tail = trace.slice(Math.floor(trace.length * 0.6));
  const steady = tail.reduce((a, p) => a + p.fy, 0) / tail.length;
  // the box filter delays by half its length: subtract that distance
  const lag = (nBox / 2 / SIM_HZ) * b.speed;
  const hit = trace.find((p) => p.fy >= 0.632 * steady);
  return { relaxLength: hit ? hit.dist - lag : Infinity, trace, steadyFy: steady };
}

/** Free-rolling longitudinal force at α = 0 (rolling resistance), N (negative = drag). */
export function freeRolling(wheel: WheelDef, o: SweepOptions & { durationS?: number }): TyrePoint {
  const b = createTyreBench(wheel, { load: o.load, speed: o.speed ?? 15, camber: (o.camberDeg ?? 0) * DEG, materialId: o.materialId });
  return averaged(b, Math.round((o.durationS ?? 1) * SIM_HZ));
}

// ------------------------------------------------------------ reference
/**
 * Pacejka Magic Formula y = D·sin(C·atan(B·x − E·(B·x − atan(B·x)))).
 * Reference coefficients for a passenger-car radial on dry asphalt (Pacejka,
 * "Tyre and Vehicle Dynamics", 3rd ed., ch. 4: lateral C ≈ 1.3, peak at
 * α ≈ 6–9°, sliding/peak ≈ 0.75–0.85 at 20°; longitudinal C ≈ 1.65, peak at
 * κ ≈ 0.08–0.15, locked-wheel/peak ≈ 0.7–0.85).
 */
export function magicFormula(x: number, B: number, C: number, D: number, E: number): number {
  const bx = B * x;
  return D * Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

/** Reference lateral curve (normalised Fy/Fz vs α in deg) for a given peak μ and peak slip angle. */
export function refLateral(alphaDeg: number, mu: number, peakDeg = 7.5): number {
  const C = 1.3;
  const E = -0.6;
  // B from the peak position: B·x_peak solves C·atan(Bx − E(Bx − atan Bx)) = π/2.
  const B = solveB(C, E, peakDeg * DEG);
  return magicFormula(alphaDeg * DEG, B, C, mu, E);
}

/** Reference longitudinal curve (normalised Fx/Fz vs κ). */
export function refLongitudinal(kappa: number, mu: number, peakKappa = 0.12): number {
  const C = 1.65;
  const E = -0.2;
  const B = solveB(C, E, peakKappa);
  return magicFormula(kappa, B, C, mu, E);
}

function solveB(C: number, E: number, xPeak: number): number {
  // find u = B·x_peak with C·atan(u − E(u − atan u)) = π/2  ⇒  u − E(u − atan u) = tan(π/(2C))
  const target = Math.tan(Math.PI / (2 * C));
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 100; i++) {
    const u = (lo + hi) / 2;
    const v = u - E * (u - Math.atan(u));
    if (v < target) lo = u;
    else hi = u;
  }
  return (lo + hi) / 2 / xPeak;
}
