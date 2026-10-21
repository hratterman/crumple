/**
 * Vehicle-level realism metrics (harness only): roll gradient, pitch
 * gradient, skidpad, 100–0, step-steer yaw response time. Each runs the real
 * car through the P2 handling harness (handling.ts) and reduces the trace to
 * the number road tests and the vehicle-dynamics literature quote.
 */
import { G, createHandlingSim, kinematics, runBraking, runCircle, runScenario, runStepSteer, setMotion, stepN, type HandlingSample } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
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
export function runSkidpad(def: VehicleDef, radius = 45.7, rampMs2 = 0.3, startSpeed = 13): SkidpadResult {
  // 13 → 25 m/s over the 40 s run: 0.38 → 1.4 g on the 45.7 m circle (the limit is always inside the ramp)
  const c = runCircle(def, radius, rampMs2, startSpeed);
  const s = c.samples;
  const win = 100; // 2 s at 50 Hz
  // the MEASURED lateral acceleration (v·r overstates it while the slip angle changes, e.g. a spin starting)
  const ay = rolling(s, win, (x) => x.latAcc);
  const vr = rolling(s, win, (x) => x.speed);
  const rr = rolling(s, win, (x) => x.yawRate);
  const roll = rolling(s, 50, (x) => x.roll);
  const steer = rolling(s, 50, (x) => x.steer);
  let best = 0;
  for (let i = win; i < s.length; i++) {
    if (s[i]!.t < 4) continue;
    const R = Math.abs(rr[i]!) > 1e-3 ? vr[i]! / Math.abs(rr[i]!) : Infinity;
    const dBeta = Math.abs(s[i]!.sideslip - s[i - win]!.sideslip);
    if (R > radius * 1.15 || R < radius * 0.85 || dBeta > (1.5 * Math.PI) / 180) continue;
    const g = Math.abs(ay[i]!) / G;
    if (g > best) best = g;
  }
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
  const ay1 = rolling(s, 50, (x) => x.speed * x.yawRate);
  for (let i = 50; i < s.length; i += 10) {
    const g = Math.abs(ay1[i]!) / G;
    if (!Number.isFinite(g) || s[i]!.t < 4) continue;
    if (g > best * 1.02) break;
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
    maxLatG: best,
    rollGradient: linFit(xs, ys).b,
    rollCurve: curve,
    understeerGradient: linFit(sx, sy).b,
    samples: s,
  };
}

export interface SineDwellResult {
  /** Steer amplitude used (action units). */
  amplitude: number;
  /** FMVSS 126: yaw rate 1.0 s / 1.75 s after the completion of steer, as a fraction of the peak yaw rate. */
  ratio100: number;
  ratio175: number;
  /** Lateral displacement of the CG 1.07 s after the beginning of steer, m. */
  lateral107: number;
  peakYaw: number;
  /** Max |sideslip| over the run, deg. */
  maxSlipDeg: number;
  samples: HandlingSample[];
}

/**
 * FMVSS 126 / UN R140 Sine with Dwell: 80 km/h, coasting from the beginning
 * of steer (BOS), steer A·sin(2π·0.7·t) through 3/4 of a period, a 0.5 s
 * dwell at the second peak, then the last quarter; completion of steer
 * (COS) at 1.929 s. Pass: yaw rate ≤ 35 % of the peak 1.0 s after COS,
 * ≤ 20 % after 1.75 s; lateral displacement ≥ 1.83 m 1.07 s after BOS
 * (responsiveness, vehicles ≤ 3.5 t).
 */
export function runSineWithDwell(def: VehicleDef, amplitude: number, kmh = 80): SineDwellResult {
  const f = 0.7;
  const w = 2 * Math.PI * f;
  const t0 = 1; // BOS after 1 s of steady running
  const tq = 0.75 / f;
  const cos = t0 + 1 / f + 0.5;
  const steerAt = (t: number): number => {
    const u = t - t0;
    if (u < 0) return 0;
    if (u < tq) return amplitude * Math.sin(w * u);
    if (u < tq + 0.5) return -amplitude;
    if (u < 1 / f + 0.5) return amplitude * Math.sin(w * (u - 0.5));
    return 0;
  };
  const v0 = kmh / 3.6;
  const { samples } = runScenario({
    def,
    initialSpeed: v0,
    durationS: cos + 2.2,
    sampleHz: 100,
    controlHz: 500,
    control: (ctx) => {
      const s = ctx.last;
      const ev = s === null ? 0 : v0 - s.speed;
      const thr = ctx.t < t0 ? Math.min(1, Math.max(0, 0.25 + 0.3 * ev)) : 0;
      return { gearSelect: 1, throttle: thr, brake: 0, steer: steerAt(ctx.t) };
    },
  });
  let peak = 0;
  let maxSlip = 0;
  for (const x of samples) {
    if (x.t >= t0 + tq * 0.66 && x.t <= cos) peak = Math.max(peak, Math.abs(x.yawRate));
    maxSlip = Math.max(maxSlip, Math.abs(x.sideslip));
  }
  const at = (t: number): HandlingSample => samples.find((x) => x.t >= t) ?? samples[samples.length - 1]!;
  const s0 = at(t0);
  const s107 = at(t0 + 1.07);
  // lateral displacement perpendicular to the initial heading
  const hx = Math.sin(s0.heading);
  const hz = -Math.cos(s0.heading);
  const lat = (s107.comX - s0.comX) * -hz + (s107.comZ - s0.comZ) * hx;
  return {
    amplitude,
    ratio100: Math.abs(at(cos + 1).yawRate) / peak,
    ratio175: Math.abs(at(cos + 1.75).yawRate) / peak,
    lateral107: Math.abs(lat),
    peakYaw: peak,
    maxSlipDeg: (maxSlip * 180) / Math.PI,
    samples,
  };
}

/** Steer amplitude (action units) that gives ≈ 0.3 g steady state at `kmh` (linear range). */
export function steerFor03g(def: VehicleDef, kmh = 80): number {
  const probe = 0.03;
  const r = runStepSteer(def, probe, kmh);
  const g = Math.abs(r.latG);
  return g > 0.01 ? (probe * 0.3) / g : probe * 3;
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
  // ISO 7401 peak response time: the FIRST yaw-rate maximum after the step (a local maximum over
  // ± 100 ms); a later, slower drift of the steady state (roll / compliance settling) is not the response
  // peak. Falls back to the global maximum when the response rises monotonically.
  let first = -1;
  for (let i = 0; i < s.length; i++) {
    const x = s[i]!;
    if (x.t < t50) continue;
    const a = Math.abs(x.yawRate);
    if (t90 === Infinity && a >= 0.9 * Math.abs(ss)) t90 = x.t - t50;
    if (a > peak) {
      peak = a;
      tPeak = x.t - t50;
    }
    if (first < 0 && t90 !== Infinity) {
      let held = true;
      for (let j = i + 1; j < s.length && s[j]!.t <= x.t + 0.1; j++) if (Math.abs(s[j]!.yawRate) >= a) held = false;
      let rising = true;
      for (let j = i - 1; j >= 0 && s[j]!.t >= x.t - 0.1; j--) if (Math.abs(s[j]!.yawRate) > a) rising = false;
      if (held && rising) first = i;
    }
  }
  if (first >= 0) tPeak = s[first]!.t - t50;
  return { t90, tPeak, overshoot: r.overshoot, latG: r.latG, spun: r.spun, samples: s };
}

export interface FadeMetrics {
  /** Per stop: distance m, front disc temperature at the end of the stop, °C. */
  stops: { distance: number; frontTemp: number }[];
  /** Mean deceleration over the first 1 s at a fixed light pedal, cold and after the stops, m/s². */
  pedalDecelCold: number;
  pedalDecelHot: number;
  /** Front disc temperature before the hot pedal check, °C. */
  hotTemp: number;
}

/**
 * Brake fade: `n` back-to-back full-pedal (ABS) stops from 100 km/h (each a
 * teleport back to speed, so the discs only cool while stopping), then the
 * same fixed light pedal from 100 km/h as on the cold car.
 */
export function runRepeatedStops(def: VehicleDef, n = 15, pedal = 0.3): FadeMetrics {
  const v0 = 100 / 3.6;
  const DT = 1 / 2000;
  const pedalDecel = (sim: ReturnType<typeof createHandlingSim>): number => {
    setMotion(sim, v0, 0);
    const k0 = kinematics(sim);
    for (let i = 0; i < 2000; i++) {
      sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: pedal });
      sim.eng.step();
    }
    const k1 = kinematics(sim);
    return Math.hypot(k0.vx, k0.vz) - Math.hypot(k1.vx, k1.vz);
  };
  const heat = (sim: ReturnType<typeof createHandlingSim>): Float64Array => (sim.veh as VehicleRuntimeEx).brakeHeat.temp;
  const front = (sim: ReturnType<typeof createHandlingSim>): number => {
    let t = 0;
    let c = 0;
    sim.veh.wheels.forEach((w, i) => {
      if (w.wheel.axle === 'front') {
        t += heat(sim)[i]!;
        c++;
      }
    });
    return t / c;
  };
  const cold = createHandlingSim({ def });
  stepN(cold, 3000);
  const pedalDecelCold = pedalDecel(cold);
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const stops: { distance: number; frontTemp: number }[] = [];
  for (let k = 0; k < n; k++) {
    setMotion(sim, v0, 0);
    const p0 = kinematics(sim);
    let t = 0;
    for (;;) {
      sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
      sim.eng.step();
      t += DT;
      const kk = kinematics(sim);
      if (Math.hypot(kk.vx, kk.vz) < 0.1 || t > 8) break;
    }
    const p1 = kinematics(sim);
    stops.push({ distance: Math.hypot(p1.cx - p0.cx, p1.cz - p0.cz), frontTemp: front(sim) });
  }
  const hotTemp = front(sim);
  return { stops, pedalDecelCold, pedalDecelHot: pedalDecel(sim), hotTemp };
}
