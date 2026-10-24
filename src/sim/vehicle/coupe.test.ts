/**
 * COUPE (F1, P6) definition + handling + crash acceptance
 * (docs/CONTRACTS.md "Fleet targets", coupe column; the sedan's harness
 * thresholds apply where the coupe lists none). Every harness scenario
 * runs once (beforeAll) and the tables are printed, so the file doubles as
 * the coupe's tuning report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileRig, computeStabilityReport, GENERAL_OMEGA_DT_LIMIT, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { buildVehicleRig, compileVehicle, validateVehicle, vehicleOmegaDtLimit } from './builder';
import { formatCrash, nodesMatching, runCrash, type CrashResult } from './crash';
import { COUPE, COUPE_CRASH_PROBES, COUPE_DESIGN, COUPE_TARGETS } from './defs/coupe';
import {
  runBraking,
  runCircle,
  runLaunch,
  runStatic,
  runStepSteer,
  runTopSpeed,
  type BrakeResult,
  type CircleResult,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
  type TopSpeedResult,
} from './handling';
import type { ShellDef } from './shellDefs';
import { wheelNodeId, type CompiledVehicle } from './types';

const T = COUPE_TARGETS.acceptance;
const cv: CompiledVehicle = compileVehicle(COUPE);

describe('COUPE definition', () => {
  it('validates with no errors or warnings, within its beam budget (≤ 3000)', () => {
    const r = validateVehicle(COUPE, T.beamBudget);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.islands).toBe(1);
    expect(r.stats.beamCount).toBeLessThanOrEqual(T.beamBudget);
    expect(r.stats.pinnedCount).toBe(0);
  });

  it('declared masses: every node within its group ω·dt limit, (Σd/m)·dt ≤ 1, no MINIMASS drift', () => {
    const merged = buildVehicleRig(COUPE);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      const g = merged.nodes[i]!.group;
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(GENERAL_OMEGA_DT_LIMIT);
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(vehicleOmegaDtLimit(g) * (1 + 1e-9));
      expect(rep.dampDt[i]).toBeLessThanOrEqual(1);
    }
    expect(cv.massDriftPct).toBeLessThan(0.5);
  });

  it('hits mass (1300 kg ± 2 %), wheelbase 2.55 m, CG ≈ 0.45 m and the rear-biased axle split', () => {
    const r = cv.rig;
    let m = 0;
    let my = 0;
    for (let i = 0; i < r.nodeCount; i++) {
      m += r.nodeMass[i]!;
      my += r.nodeMass[i]! * r.nodePos[3 * i + 1]!;
    }
    expect(Math.abs(m - 1300) / 1300).toBeLessThan(0.02);
    const z = (w: number): number => r.nodePos[3 * cv.wheels[w]!.hubI + 2]!;
    expect((z(2) + z(3)) / 2 - (z(0) + z(1)) / 2).toBeCloseTo(2.55, 6);
    expect(my / m).toBeGreaterThan(0.42);
    expect(my / m).toBeLessThan(0.48);
    expect(COUPE_DESIGN.frontAxleShare).toBeCloseTo(COUPE_TARGETS.frontAxleShare, 3);
    for (const w of cv.wheels) {
      expect(w.radius).toBe(0.33);
      expect(w.rays).toBe(12);
    }
  });

  it('carries the 300 kW / 520 N·m V8, 7-speed auto, LSD, RWD and traction control', () => {
    const d = cv.drivetrain;
    let peak = 0;
    let pmax = 0;
    for (let i = 0; i < d.torqueLut.length; i++) {
      peak = Math.max(peak, d.torqueLut[i]!);
      pmax = Math.max(pmax, (d.torqueLut[i]! * i * d.lutStepRpm * Math.PI) / 30);
    }
    expect(peak).toBeCloseTo(520, 6);
    expect(Math.abs(pmax - 300e3) / 300e3).toBeLessThan(0.03);
    expect(d.gearCount).toBe(7);
    expect(d.diff).toBe(2); // limited
    expect(Array.from(d.drivenWheels)).toEqual([2, 3]);
    expect(d.tcSlip).toBeGreaterThan(0);
    expect(COUPE.drivetrain.transmission).toBe('auto');
  });

  it('has the hood sub-rig (12 nodes after the structure: hinges, latch, support rests) and a crumple-zone-first structure', () => {
    const body = COUPE.body;
    const ids = body.nodes.map((n) => n.id);
    const expected: string[] = [];
    for (let r = 0; r < 4; r++) for (const s of ['L', 'C', 'R']) expected.push(`hood_${r}${s}`);
    // appended after every structure node; only the R-CRASH hinged closures (doors dR / dL, trunk lid tk) follow it
    const after = ids.slice(ids.indexOf('hood_0L'));
    expect(after.slice(0, 12)).toEqual(expected);
    for (const id of after.slice(12)) expect(id).toMatch(/^(d[LR]|tk)_(\d\d|i\d)$/);
    const beam = (a: string, b: string) => body.beams.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    for (const s of ['L', 'R']) {
      for (const t of [`s5_cw_${s}`, `s4_fd_${s}`]) expect(beam(`hood_3${s}`, t)!.breakF).toBeGreaterThanOrEqual(2e4);
      expect(beam(`hood_0${s}`, `s2_fd_${s}`)!.breakF).toBeLessThan(1e4);
      expect(beam(`hood_1${s}`, `s2_fd_${s}`)!.type).toBe('support');
    }
    expect(beam('hood_0C', 's2_rt')!.breakF).toBeLessThan(1e4);
    // The ends yield before any safety-cell member (s5..s8 minus door panels, window frames, firewall panel).
    const st = (id: string): number => Number(/^s(\d+)_/.exec(id)?.[1] ?? -1);
    const shellDef = (Array.isArray(COUPE.shell) ? COUPE.shell[0] : COUPE.shell) as ShellDef;
    const latchPairs = new Set((shellDef.zones ?? []).flatMap((z) => (z.latch ?? []).map(([p, q]) => `${p}|${q}`)));
    const deformOf = (pred: (a: string, b: string) => boolean): number[] =>
      body.beams.filter((b) => b.type === 'normal' && pred(b.a, b.b)).map((b) => b.deform ?? 0);
    const front = deformOf((a, b) => st(a) >= 0 && st(a) <= 1 && st(b) >= 0 && st(b) <= 2);
    const cage = deformOf(
      (a, b) =>
        st(a) >= 5 && st(a) <= 8 && st(b) >= 5 && st(b) <= 8 && !/_(bt|rf|cw)/.test(a + b) && !/^s6_(dm|bt|sl|fl)_/.test(a) && !/^s6_(dm|bt|sl|fl)_/.test(b) &&
        !(/_hp/.test(a + b) && st(a) !== st(b)) && !/s5_fw_/.test(a + b) &&
        !latchPairs.has(`${a}|${b}`), // R-CRASH door-aperture racking sensors (elastic, unlatch the doors)
    );
    expect(front.length).toBeGreaterThan(10);
    expect(cage.length).toBeGreaterThan(20);
    expect(Math.max(...front)).toBeLessThan(Math.min(...cage));
    // Brittle glass: windscreen and rear-glass beams exist and shatter at a few % strain.
    for (const [a, b] of [['s5_cw', 's6_rf'], ['s8_rf', 's9_dk']]) expect(beam(a!, b!)!.breakF).toBeLessThan(2e4);
  });

  it('crash probes resolve to rig nodes', () => {
    const p = COUPE_CRASH_PROBES;
    for (const set of [p.front, p.cabin, p.firewall, p.cellRear, p.cellFront, p.doorMid, [p.doorR], [p.doorL], [p.sillR], [p.sillL]]) expect(nodesMatching(cv, set).length).toBeGreaterThan(0);
    for (const [a, b] of p.latch) {
      expect(cv.rig.nodeIds).toContain(a);
      expect(cv.rig.nodeIds).toContain(b);
    }
  });

  it('keeps canonical merged order and round-trips through JSON', () => {
    expect(cv.rig.nodeIds.slice(0, COUPE.body.nodes.length)).toEqual(COUPE.body.nodes.map((n) => n.id));
    expect(cv.wheels.map((w) => w.id)).toEqual(['FL', 'FR', 'RL', 'RR']);
    expect(cv.rig.nodeIds[cv.wheels[0]!.nodeStart]).toBe(wheelNodeId('FL', 'hubI'));
    const copy = JSON.parse(JSON.stringify(COUPE)) as typeof COUPE;
    expect(compileVehicle(copy)).toEqual(cv);
  });
});

// ------------------------------------------------------------------ handling harness
let st: StaticResult;
let launch: LaunchResult;
let brake: BrakeResult;
let circle: CircleResult;
let step: StepSteerResult;
let top: TopSpeedResult;

/** Max over 0.5 s windows of the mean rear slip ratio, from 1.5 s until 100 km/h. */
function settledRearSlip(l: LaunchResult): number {
  const win = l.samples.filter((s) => s.t >= 1.5 && s.t <= l.t100);
  let worst = 0;
  const n = 25;
  for (let i = n; i <= win.length; i++) {
    let m = 0;
    for (let j = i - n; j < i; j++) m += (win[j]!.slipRatio[2]! + win[j]!.slipRatio[3]!) / 2;
    worst = Math.max(worst, Math.abs(m / n));
  }
  return worst;
}

describe('COUPE handling harness', () => {
  beforeAll(() => {
    st = runStatic(COUPE);
    launch = runLaunch(COUPE);
    brake = runBraking(COUPE);
    circle = runCircle(COUPE);
    step = runStepSteer(COUPE);
    top = runTopSpeed(COUPE, T.topSpeed);
  }, 900_000);

  afterAll(() => {
    if (!top) return;
    const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
    const rows: [string, string, string][] = [
      ['static sag (m)', f(st.sag, 3), '0.02–0.05'],
      ['static creep (mm/s) / max node speed (m/s)', `${f(st.creep * 1000, 3)} / ${f(st.jitter, 3)}`, '< 1 / < 0.15'],
      ['0–100 km/h (s)', f(launch.t100), '3.9–4.6'],
      ['launch heading drift @100 m (deg)', f(launch.headingDrift100), '≤ 3'],
      ['rear slip ratio, settled max (0.5 s mean)', f(settledRearSlip(launch)), '< 0.3'],
      ['braking 100→0 (m) / drift (deg)', `${f(brake.distance, 1)} / ${f(brake.headingDrift)}`, '≤ 34.5 / < 5'],
      ['circle R40 max lateral (g)', f(circle.maxLatG), '≥ 1.05'],
      ['step steer 0.12 @60: overshoot / std / spun', `${f(step.overshoot)} / ${f(step.yawStd, 4)} / ${step.spun}`, '≤ 1.35 / < 0.03 / false'],
      ['full-throttle accel @250 / 260 km/h (m/s²)', `${f(top.accel200)} / ${f(top.accel210)} (gear ${top.gear200}/${top.gear210})`, '> 0'],
      ['245 km/h straight, 10 s WOT: end speed / max |yaw| / drift', `${f(top.endKmh, 1)} / ${f(top.maxYawRate, 3)} / ${f(top.headingDrift)}`, '— / < 0.05 / < 3'],
    ];
    const w0 = Math.max(...rows.map((r) => r[0].length));
    const w1 = Math.max(...rows.map((r) => r[1].length));
    console.log('\nCOUPE handling report\n' + rows.map(([a, b, c]) => `  ${a.padEnd(w0)}  ${b.padStart(w1)}  ${c}`).join('\n'));
  });

  it('static: sag 2–5 cm, no creep, no jitter', () => {
    expect(st.sag).toBeGreaterThan(T.staticSag[0]);
    expect(st.sag).toBeLessThan(T.staticSag[1]);
    expect(st.creep).toBeLessThan(1e-3);
    expect(st.jitter).toBeLessThan(0.15);
  });

  it('launch (TC on): 0–100 km/h in 3.9–4.6 s, straight (drift ≤ 3°), rear slip settles', () => {
    expect(launch.t100).toBeGreaterThanOrEqual(T.zeroTo100S[0]);
    expect(launch.t100).toBeLessThanOrEqual(T.zeroTo100S[1]);
    expect(launch.headingDrift100).toBeLessThanOrEqual(T.launchDriftDeg);
    expect(settledRearSlip(launch)).toBeLessThan(0.3);
  });

  it('braking 100→0 ≤ 34.5 m, straight', () => {
    expect(brake.distance).toBeLessThanOrEqual(T.brake100M);
    expect(brake.headingDrift).toBeLessThan(5);
  });

  it('steady-state circle R40 ≥ 1.05 g', () => {
    expect(circle.maxLatG).toBeGreaterThanOrEqual(T.circleR40G);
  });

  it('step steer 0.12 at 60 km/h: no spin, overshoot ≤ 1.35, settles', () => {
    expect(step.spun).toBe(false);
    expect(step.yawSteady).toBeGreaterThan(0.05);
    expect(step.overshoot).toBeLessThanOrEqual(T.stepSteerOvershoot);
    expect(step.yawStd).toBeLessThan(0.03);
  });

  it('top speed: still accelerating at 250 and 260 km/h; a 10 s full-throttle straight from 245 km/h does not weave', () => {
    expect(top.accel200).toBeGreaterThan(0);
    expect(top.accel210).toBeGreaterThan(0);
    expect(top.maxYawRate).toBeLessThan(0.05);
    expect(top.headingDrift).toBeLessThan(3);
  });
});

// ------------------------------------------------------------------ crash harness
let f50: CrashResult;
let f30: CrashResult;
let f10: CrashResult;
let pole: CrashResult;
let offset: CrashResult;
let f100: CrashResult;

/** "No explosion" (CONTRACTS): finite, no body node faster than the impact speed after 1 s, KE at 2 s < 5 %, no beam span > 3 m. */
function expectNoExplosion(r: CrashResult): void {
  expect(r.finite).toBe(true);
  expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
  expect(r.keRatio).toBeLessThan(0.05);
  expect(r.maxSpan).toBeLessThan(3);
}

describe('COUPE crash harness', () => {
  const crash = (kind: 'frontal' | 'pole' | 'offset', speedKmh: number): CrashResult =>
    runCrash({ kind, speedKmh, def: COUPE, probes: COUPE_CRASH_PROBES, ...(kind === 'offset' ? { overlap: 0.4 } : {}) });
  beforeAll(() => {
    f50 = crash('frontal', 50);
    f30 = crash('frontal', 30);
    f10 = crash('frontal', 10);
    pole = crash('pole', 30);
    offset = crash('offset', 64);
    f100 = crash('frontal', 100);
  }, 900_000);

  afterAll(() => {
    const all = [f50, f30, f10, pole, offset, f100].filter(Boolean);
    if (all.length > 0) console.log('\nCOUPE crash report\n' + all.map((r) => '  ' + formatCrash(r)).join('\n'));
  });

  it('50 km/h frontal: crush 35–60 cm (peak ≤ 70), spring-back ≤ 28 %, intrusion < 8 cm, rebound 5–15 % of the impact speed, stable, wheels on, penetration < 5 cm', () => {
    const t = T.frontal50;
    expect(f50.crush).toBeGreaterThanOrEqual(t.crush[0]);
    expect(f50.crush).toBeLessThanOrEqual(t.crush[1]);
    expect(f50.crushMax).toBeLessThanOrEqual(t.crushMax);
    expect(f50.springback).toBeLessThanOrEqual(t.springback);
    expect(f50.intrusion).toBeLessThan(t.intrusion);
    expect(f50.rebound).toBeGreaterThanOrEqual(t.rebound[0]);
    expect(f50.rebound).toBeLessThanOrEqual(t.rebound[1]);
    expectNoExplosion(f50);
    expect(f50.wheelsDetached).toBe(0);
    expect(f50.maxPenetration).toBeLessThan(0.05);
  });

  it('30 km/h frontal: crush 15–30 cm, spring-back ≤ 25 %, intrusion < 3 cm, wheels and bumper stay on', () => {
    const t = T.frontal30;
    expect(f30.crush).toBeGreaterThanOrEqual(t.crush[0]);
    expect(f30.crush).toBeLessThanOrEqual(t.crush[1]);
    expect(f30.springback).toBeLessThanOrEqual(t.springback);
    expect(f30.intrusion).toBeLessThan(t.intrusion);
    expect(f30.wheelsDetached).toBe(0);
    expect(f30.bumperBrokenFraction).toBeLessThan(0.5);
  });

  it('10 km/h frontal: permanent crush ≤ 3 cm, no broken beams, ≤ 5 % of body beams plastic', () => {
    expect(f10.crush).toBeLessThanOrEqual(T.frontal10.crush);
    expect(f10.brokenBeams).toBe(0);
    expect(f10.plasticFraction).toBeLessThanOrEqual(T.frontal10.plastic);
  });

  it('30 km/h side pole at the door: door intrusion 20–40 cm, nothing pulled through the pole', () => {
    expect(pole.doorIntrusion).toBeGreaterThanOrEqual(T.pole30.door[0]);
    expect(pole.doorIntrusion).toBeLessThanOrEqual(T.pole30.door[1]);
    expect(pole.poleSideKept).toBe(true);
    expect(pole.finite).toBe(true);
  });

  it('64 km/h 40 % offset frontal: cabin intrusion < 15 cm', () => {
    expect(offset.intrusion).toBeLessThan(T.offset64.intrusion);
    expect(offset.finite).toBe(true);
  });

  it('100 km/h frontal: stable, hood latch broken, bumper torn (≥ half its mounts), windscreen shattered', () => {
    expectNoExplosion(f100);
    expect(f100.latchBroken).toBe(true);
    expect(f100.bumperBrokenFraction).toBeGreaterThanOrEqual(0.5);
    expect(f100.windscreenBrokenFraction).toBeGreaterThanOrEqual(0.5);
  });
});
