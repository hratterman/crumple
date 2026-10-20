/**
 * Vehicle-level realism metrics (harness only): roll gradient, pitch
 * gradient, skidpad, 100–0, step-steer yaw response time. Each runs the real
 * car through the P2 handling harness (handling.ts) and reduces the trace to
 * the number road tests and the vehicle-dynamics literature quote.
 */
import { G, runBraking, runCircle, runScenario, runStepSteer, type HandlingSample } from '../handling';
import type { VehicleDef } from '../types';

const RAD = 180 / Math.PI;

/** Least-squares slope through the origin-free line y = a + b·x. */
export function linFit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n < 2) return { a: NaN, b: NaN };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { a: (sy - b * sx) / n, b };
}

function rolling(samples: HandlingSample[], win: number, f: (s: HandlingSample) => number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    acc += f(samples[i]!);
    if (i >= win) acc -= f(samples[i - win]!);
    out.push(i >= win - 1 ? acc / win : NaN);
  }
  return out;
}

export interface SkidpadResult {
  /** Peak sustained lateral g on the circle. */
  maxLatG: number;
  /** Roll gradient, deg/g (fit of |roll| vs |ay| over 0.15–0.55 g, 1 s means). */
  rollGradient: number;
  /** (|ay| g, |roll| deg) pairs of the 1 s means. */
  rollCurve: [number, number][];
  /** Understeer gradient, deg/g: d(steer angle at the road wheel − L/R)/d(ay). */
  understeerGradient: number;
  samples: HandlingSample[];
}

/**
 * Constant-radius skidpad (SAE J266; R = 45.7 m = the 300 ft circle road
 * tests use), slow speed ramp. Lateral g as in runCircle; the roll gradient
 * from the same run.
 */
export function runSkidpad(def: VehicleDef, radius = 45.7, rampMs2 = 0.25): SkidpadResult {
  const c = runCircle(def, radius, rampMs2, 10);
  const s = c.samples;
  const win = 50; // 1 s at 50 Hz
  const ay = rolling(s, win, (x) => x.speed * x.yawRate);
  const roll = rolling(s, win, (x) => x.roll);
  const steer = rolling(s, win, (x) => x.steer);
  const xs: number[] = [];
  const ys: number[] = [];
  const curve: [number, number][] = [];
  const sx: number[] = [];
  const sy: number[] = [];
  let wheelbase = 2.7;
  {
    const zs = def.wheels.map((w) => (w.hubInner[2] + w.hubOuter[2]) / 2);
    wheelbase = Math.max(...zs) - Math.min(...zs);
  }
  const maxWheel = def.steering.maxWheelAngleDeg;
  for (let i = win; i < s.length; i += 10) {
    const g = Math.abs(ay[i]!) / G;
    if (!Number.isFinite(g) || s[i]!.t < 4) continue;
    if (g > c.maxLatG * 1.02) break;
    curve.push([g, Math.abs(roll[i]!) * RAD]);
    if (g >= 0.15 && g <= 0.55) {
      xs.push(g);
      ys.push(Math.abs(roll[i]!) * RAD);
      // road-wheel angle minus the Ackermann angle L/R (deg)
      sx.push(g);
      sy.push(Math.abs(steer[i]!) * maxWheel - (wheelbase / radius) * RAD);
    }
  }
  return {
    maxLatG: c.maxLatG,
    rollGradient: linFit(xs, ys).b,
    rollCurve: curve,
    understeerGradient: linFit(sx, sy).b,
    samples: s,
  };
}

export interface BrakeMetrics {
  /** 100–0 km/h distance, m. */
  distance: number;
  /** Mean deceleration over 80–20 km/h, g. */
  meanDecelG: number;
  /** Pitch gradient (nose-down) relative to rest, deg/g, over 80–20 km/h. */
  pitchGradient: number;
  /** Peak dive relative to rest, deg. */
  peakDiveDeg: number;
  samples: HandlingSample[];
}

/** Full ABS / full-pedal stop from 100 km/h (runBraking) with the pitch reduction. */
export function runBrakeMetrics(def: VehicleDef): BrakeMetrics {
  const b = runBraking(def);
  const s = b.samples;
  const p0 = s[0]!.pitch;
  let acc = 0;
  let pit = 0;
  let n = 0;
  let peak = 0;
  for (let i = 1; i < s.length; i++) {
    const x = s[i]!;
    peak = Math.max(peak, (x.pitch - p0) * RAD);
    const kmh = x.speed * 3.6;
    if (kmh > 80 || kmh < 20) continue;
    acc += -x.lonAcc;
    pit += x.pitch - p0;
    n++;
  }
  const dec = acc / n / G;
  return { distance: b.distance, meanDecelG: dec, pitchGradient: (pit / n) * RAD / dec, peakDiveDeg: peak, samples: s };
}

export interface SquatMetrics {
  /** Nose-up pitch per g of longitudinal acceleration in a full-throttle launch (1–3 s), deg/g. */
  squatGradient: number;
  samples: HandlingSample[];
}

export function runSquat(def: VehicleDef): SquatMetrics {
  const { samples } = runScenario({
    def,
    durationS: 4,
    sampleHz: 50,
    control: () => ({ gearSelect: 1, throttle: 1, steer: 0 }),
  });
  const p0 = samples[0]!.pitch;
  let acc = 0;
  let pit = 0;
  let n = 0;
  for (const x of samples) {
    if (x.t < 1 || x.t > 3) continue;
    acc += x.lonAcc;
    pit += -(x.pitch - p0);
    n++;
  }
  return { squatGradient: (pit / n) * RAD / (acc / n / G), samples };
}

export interface StepMetrics {
  /** ISO 7401 yaw-rate response time: 50 % steer input → 90 % of steady yaw rate, s. */
  t90: number;
  /** Peak response time: 50 % steer → yaw-rate peak, s. */
  tPeak: number;
  overshoot: number;
  latG: number;
  spun: boolean;
  samples: HandlingSample[];
}

/** Step steer at `kmh` (ISO 7401: 80 km/h) with steer scaled to land near `targetG` lateral. */
export function runStepMetrics(def: VehicleDef, steer: number, kmh = 80): StepMetrics {
  const r = runStepSteer(def, steer, kmh);
  const s = r.samples;
  const t50 = 0.5; // instantaneous step at 0.5 s (hydro lag included in the response)
  const ss = r.yawSteady;
  let t90 = Infinity;
  let tPeak = t50;
  let peak = 0;
  for (const x of s) {
    if (x.t < t50) continue;
    if (t90 === Infinity && Math.abs(x.yawRate) >= 0.9 * Math.abs(ss)) t90 = x.t - t50;
    if (Math.abs(x.yawRate) > peak) {
      peak = Math.abs(x.yawRate);
      tPeak = x.t - t50;
    }
  }
  return { t90, tPeak, overshoot: r.overshoot, latG: r.latG, spun: r.spun, samples: s };
}
