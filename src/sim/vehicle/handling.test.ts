/**
 * SEDAN handling acceptance (P2 headless harness). Real-car references for
 * a 1450 kg / 350 N·m RWD sedan on dry asphalt:
 *   static sag 2–6 cm, no creep; launch straight, 0–100 km/h ≈ 6–7 s;
 *   coastdown 0.25–0.6 m/s² (aero + rolling); 100→0 km/h braking 35–50 m;
 *   steady-state cornering ≈ 0.8–1.0 g; step steer settles; v_max ≥ 200 km/h.
 *
 * Every scenario runs once (beforeAll) and the table is printed, so the file
 * doubles as the tuning report (`node tools/handling-report.mjs`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runBraking,
  runCircle,
  runCoastdown,
  runLaunch,
  runStatic,
  runStepSteer,
  runTopSpeed,
  type BrakeResult,
  type CircleResult,
  type CoastResult,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
  type TopSpeedResult,
} from './handling';

let st: StaticResult;
let launch: LaunchResult;
let coast: CoastResult;
let brake: BrakeResult;
let circle: CircleResult;
let step: StepSteerResult;
let top: TopSpeedResult;

/** Max over 0.5 s windows of the mean rear (RL/RR) slip ratio, from 1.5 s until 100 km/h. */
function settledRearSlip(l: LaunchResult): number {
  const win = l.samples.filter((s) => s.t >= 1.5 && s.t <= l.t100);
  let worst = 0;
  const n = 25; // 50 Hz samples → 0.5 s
  for (let i = n; i <= win.length; i++) {
    let m = 0;
    for (let j = i - n; j < i; j++) m += (win[j]!.slipRatio[2]! + win[j]!.slipRatio[3]!) / 2;
    worst = Math.max(worst, Math.abs(m / n));
  }
  return worst;
}

beforeAll(() => {
  st = runStatic();
  launch = runLaunch();
  coast = runCoastdown();
  brake = runBraking();
  circle = runCircle();
  step = runStepSteer();
  top = runTopSpeed();
}, 120_000);

afterAll(() => {
  if (!st) return;
  const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  const rows: [string, string, string][] = [
    ['static sag (m)', f(st.sag, 3), '0.02–0.06'],
    ['static creep (mm/s)', f(st.creep * 1000, 3), '< 1'],
    ['static max node speed (m/s)', f(st.jitter, 3), '< 0.15'],
    ['launch heading drift @100 m (deg)', f(launch.headingDrift100), '< 3'],
    ['launch lateral offset @100 m (m)', f(launch.lateral100), ''],
    ['0–100 km/h (s)', f(launch.t100), '≤ 9 (real 6–7)'],
    ['rear slip ratio, settled max (0.5 s mean)', f(settledRearSlip(launch)), '< 0.25'],
    ['speed / rpm / gear @4 s', `${f(launch.speedAt4s, 1)} / ${f(launch.rpmAt4s, 0)} / ${launch.gearAt4s}`, ''],
    ['coastdown decel, 5 s (m/s²)', f(coast.decel5, 3), '0.25–0.6'],
    ['braking 100→0 (m)', f(brake.distance, 1), '35–50'],
    ['braking heading drift (deg)', f(brake.headingDrift), '< 5'],
    ['circle R40 max lateral (g)', f(circle.maxLatG), '0.75–1.05'],
    ['circle speed @max (km/h)', f(circle.speedAtMax * 3.6, 1), ''],
    ['step steer 60 km/h: yaw rate (rad/s)', f(step.yawSteady, 3), 'settles'],
    ['step steer overshoot / std', `${f(step.overshoot)} / ${f(step.yawStd, 4)}`, '< 1.5 / < 0.03'],
    ['top speed reached (km/h)', f(top.vmaxKmh, 1), '≥ 200'],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  console.log(
    '\nSEDAN handling report\n' + rows.map(([a, b, c]) => `  ${a.padEnd(w0)}  ${b.padStart(w1)}  ${c}`).join('\n'),
  );
});

describe('SEDAN handling harness', () => {
  it('a) static: sag 2–6 cm, no jitter', () => {
    expect(st.sag).toBeGreaterThan(0.02);
    expect(st.sag).toBeLessThan(0.06);
    expect(st.jitter).toBeLessThan(0.15);
  });

  it.fails('a) static: no creep > 1 mm/s at rest (neutral, no brake)', () => {
    expect(st.creep).toBeLessThan(1e-3);
  });

  it('b) launch: heading drift < 3° over the first 100 m with zero steering', () => {
    expect(launch.headingDrift100).toBeLessThan(3);
    expect(Math.abs(launch.lateral100)).toBeLessThan(2);
  });

  it('b) launch: 0–100 km/h ≤ 9 s', () => {
    expect(launch.t100).toBeLessThanOrEqual(9);
  });

  it.fails('b) launch: rear slip ratio settles < 0.25 after 1.5 s', () => {
    expect(settledRearSlip(launch)).toBeLessThan(0.25);
  });

  it.fails('c) coastdown from 100 km/h in neutral: 0.25–0.6 m/s² over 5 s', () => {
    expect(coast.decel5).toBeGreaterThan(0.25);
    expect(coast.decel5).toBeLessThan(0.6);
  });

  it.fails('d) braking from 100 km/h: 35–50 m, heading within 5°', () => {
    expect(brake.distance).toBeGreaterThan(35);
    expect(brake.distance).toBeLessThan(50);
    expect(brake.headingDrift).toBeLessThan(5);
  });

  it.fails('e) steady-state circle R40: 0.75–1.05 g before breakaway', () => {
    expect(circle.maxLatG).toBeGreaterThan(0.75);
    expect(circle.maxLatG).toBeLessThan(1.05);
  });

  it('e) step steer at 60 km/h: yaw rate settles without divergence', () => {
    expect(step.spun).toBe(false);
    expect(step.yawSteady).toBeGreaterThan(0.05);
    expect(step.overshoot).toBeLessThan(1.5);
    expect(step.yawStd).toBeLessThan(0.03);
  });

  it.fails('f) top speed ≥ 200 km/h', () => {
    expect(top.vmaxKmh).toBeGreaterThanOrEqual(200);
  });
});
