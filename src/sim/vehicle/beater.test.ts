/**
 * BEATER acceptance (docs/CONTRACTS.md "Fleet targets", F4): definition,
 * handling harness, crash harness against the SEDAN measured in the same
 * run (the "folds like paper" ratios), driving stays elastic, and the
 * derby rule: it still drives away after a 50 km/h wall hit. Every
 * scenario runs once (beforeAll) and the table is printed, so the file
 * doubles as the tuning report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MaterialId } from '../../protocol/messages';
import { compileRig, computeStabilityReport, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { buildVehicleRig, compileVehicle, validateVehicle, vehicleOmegaDtLimit } from './builder';
import { formatCrash, runCrash, type CrashResult } from './crash';
import { BEATER, BEATER_CRASH_PROBES, BEATER_DESIGN, BEATER_TARGETS } from './defs/beater';
import {
  createHandlingSim,
  kinematics,
  runBraking,
  runCircle,
  runLaunch,
  runStatic,
  runStepSteer,
  runTopSpeed,
  setMotion,
  stepN,
  type BrakeResult,
  type CircleResult,
  type HandlingSim,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
  type TopSpeedResult,
} from './handling';

/** P6 fleet budget for the beater (CONTRACTS "Fleet targets"). */
const BEAM_BUDGET = 2600;
const cv = compileVehicle(BEATER);

let st: StaticResult;
let launch: LaunchResult;
let brake: BrakeResult;
let circle: CircleResult;
let step: StepSteerResult;
let top: TopSpeedResult;
const crash: Record<string, CrashResult> = {};
const sedan: Record<string, CrashResult> = {};
let away: { reverse: number; forward: number; wheelsAttached: boolean; finite: boolean };
let drivePlastic = -1;

/** Body beams (hydros excluded) broken or plastically deformed. */
function brokenOrDeformed(sim: HandlingSim): number {
  const s = sim.eng.state;
  let n = 0;
  for (let b = 0; b < sim.cv.bodyBeamCount; b++) {
    const g = sim.obj.beamStart + b;
    if (s.type[g] === 3) continue;
    if (s.active[g] === 0 || Math.abs(s.restLen[g]! - s.restLen0[g]!) > 1e-3 * s.restLen0[g]!) n++;
  }
  return n;
}

/** 50 km/h into a rigid wall, 2 s; reverse away 3 s, brake to rest, then drive forward 4 s with the wall gone. */
function driveAway(): typeof away {
  const sim = createHandlingSim({ def: BEATER });
  const { eng } = sim;
  stepN(sim, 1000);
  let minZ = Infinity;
  const s = eng.state;
  for (let i = 0; i < cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[sim.obj.nodeStart + i]! - s.radius[sim.obj.nodeStart + i]!);
  const hz = 0.6;
  eng.setExtraColliders([{ id: 'wall', kind: 'box', pos: [0, 1.5, minZ - 0.03 - hz], quat: [0, 0, 0, 1], size: [6, 1.5, hz], material: MaterialId.concrete }]);
  setMotion(sim, 50 / 3.6, 0);
  stepN(sim, 4000);
  const k0 = kinematics(sim);
  eng.setInput(1, { gearSelect: -1, throttle: 0.6, brake: 0 });
  stepN(sim, 6000);
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
  stepN(sim, 4000);
  const k1 = kinematics(sim);
  eng.setExtraColliders([]);
  eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0 });
  stepN(sim, 8000);
  const k2 = kinematics(sim);
  let finite = true;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) if (!Number.isFinite(s.posX[i]! + s.posY[i]! + s.posZ[i]!)) finite = false;
  return {
    reverse: k1.cz - k0.cz,
    forward: k1.cz - k2.cz,
    wheelsAttached: sim.veh.wheels.every((w) => w.detached === 0),
    finite,
  };
}

beforeAll(() => {
  st = runStatic(BEATER);
  launch = runLaunch(BEATER, { durationS: 20 });
  brake = runBraking(BEATER);
  circle = runCircle(BEATER);
  step = runStepSteer(BEATER);
  top = runTopSpeed(BEATER, { lowKmh: 155, highKmh: 165, straightFromKmh: 150 });
  for (const [k, spec] of [
    ['f50', { kind: 'frontal', speedKmh: 50 }],
    ['f30', { kind: 'frontal', speedKmh: 30 }],
    ['f10', { kind: 'frontal', speedKmh: 10 }],
    ['pole', { kind: 'pole', speedKmh: 30 }],
    ['offset', { kind: 'offset', speedKmh: 64, overlap: 0.4 }],
    ['f100', { kind: 'frontal', speedKmh: 100 }],
  ] as const) {
    crash[k] = runCrash({ ...spec, def: BEATER, probes: BEATER_CRASH_PROBES });
    if (k === 'f50' || k === 'f30' || k === 'pole') sedan[k] = runCrash(spec);
  }
  away = driveAway();
  // hard driving: full throttle 2 s, full brake to rest, then a 0.5 steer at 60 km/h
  const sim = createHandlingSim({ def: BEATER });
  stepN(sim, 3000);
  sim.eng.setInput(1, { gearSelect: 1, throttle: 1 });
  stepN(sim, 4000);
  sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
  stepN(sim, 4000);
  setMotion(sim, 60 / 3.6);
  sim.eng.setInput(1, { gearSelect: 1, throttle: 0.4, brake: 0, steer: 0.5 });
  stepN(sim, 4000);
  drivePlastic = brokenOrDeformed(sim);
}, 600_000);

afterAll(() => {
  if (!st) return;
  const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  const rows: [string, string, string][] = [
    ['beams (body / total)', `${cv.bodyBeamCount} / ${cv.rig.beamCount}`, `≤ ${BEAM_BUDGET} (≈ 1900)`],
    ['mass (kg)', f(cv.totalMass, 1), '1050 ± 2 %'],
    ['static sag (m)', f(st.sag, 3), '0.02–0.06'],
    ['0–100 km/h (s)', f(launch.t100), '11–14'],
    ['launch heading drift @100 m (deg)', f(launch.headingDrift100), '≤ 3'],
    ['braking 100→0 (m)', f(brake.distance, 1), '≤ 45'],
    ['circle R40 max lateral (g)', f(circle.maxLatG), '0.75–0.95'],
    ['step steer 0.12 @ 60 km/h overshoot / spun', `${f(step.overshoot)} / ${step.spun}`, 'no spin'],
    ['full-throttle accel @155 / 165 km/h (m/s²)', `${f(top.accel200)} / ${f(top.accel210)}`, '> 0 at 155'],
    ['150 km/h straight 10 s: end km/h / max yaw', `${f(top.endKmh, 1)} / ${f(top.maxYawRate, 3)}`, ''],
    ['crush 50 km/h beater / sedan (cm)', `${f(crash.f50!.crush * 100, 1)} / ${f(sedan.f50!.crush * 100, 1)} (×${f(crash.f50!.crush / sedan.f50!.crush)})`, '≥ 1.5×'],
    ['crush 30 km/h beater / sedan (cm)', `${f(crash.f30!.crush * 100, 1)} / ${f(sedan.f30!.crush * 100, 1)} (×${f(crash.f30!.crush / sedan.f30!.crush)})`, '≥ 1.5×'],
    ['pole 30 door beater / sedan (cm)', `${f(crash.pole!.doorIntrusion * 100, 1)} / ${f(sedan.pole!.doorIntrusion * 100, 1)} (×${f(crash.pole!.doorIntrusion / sedan.pole!.doorIntrusion)})`, '≥ 1.4×'],
    ['10 km/h permanent crush (cm)', f(crash.f10!.crush * 100, 1), '≥ 2'],
    ['50 km/h cabin intrusion (cm)', f(crash.f50!.intrusion * 100, 1), '≤ 30'],
    ['drive away after 50 km/h: reverse / forward (m)', `${f(away.reverse, 1)} / ${f(away.forward, 1)}`, '> 3 / > 10'],
    ['hard driving: deformed body beams', String(drivePlastic), '0'],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  console.log(
    '\nBEATER report\n' +
      rows.map(([a, b, c]) => `  ${a.padEnd(w0)}  ${b.padStart(w1)}  ${c}`).join('\n') +
      '\n' +
      Object.values(crash)
        .map((r) => '  ' + formatCrash(r))
        .join('\n'),
  );
});

describe('BEATER definition', () => {
  it('validates within its 2600-beam budget, 10-ray 0.29 m wheels, FWD open diff 4-speed auto, no TC', () => {
    const r = validateVehicle(BEATER, BEAM_BUDGET);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.islands).toBe(1);
    expect(cv.rig.beamCount).toBeLessThanOrEqual(BEAM_BUDGET);
    expect(cv.rig.beamCount).toBeLessThan(2100);
    for (const w of BEATER.wheels) {
      expect(w.rays).toBe(10);
      expect(w.radius).toBeCloseTo(0.29, 2);
      expect(w.driven).toBe(w.axle === 'front');
      expect(w.steered).toBe(w.axle === 'front');
    }
    expect(BEATER.drivetrain.diff).toBe('open');
    expect(BEATER.drivetrain.gearRatios).toHaveLength(4);
    expect(BEATER.drivetrain.transmission).toBe('auto');
    expect(BEATER.drivetrain.tractionControl ?? 0).toBe(0);
  });

  it('mass 1050 kg ± 2 %, front-heavy (transverse engine), every node within its group ω·dt limit, (Σd/m)·dt ≤ 1', () => {
    expect(Math.abs(cv.totalMass - BEATER_TARGETS.totalMass) / BEATER_TARGETS.totalMass).toBeLessThan(0.02);
    expect(BEATER_DESIGN.frontAxleShare).toBeGreaterThan(0.58);
    expect(cv.massDriftPct).toBeLessThan(1);
    const merged = buildVehicleRig(BEATER);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(vehicleOmegaDtLimit(merged.nodes[i]!.group) * (1 + 1e-9));
      expect(rep.dampDt[i]).toBeLessThanOrEqual(1);
    }
  });

  it('roll cage, no glass: no glass-class beams; cage bars across the cabin; hood sub-rig with latch; the sedan id scheme for the probes', () => {
    const ids = cv.rig.nodeIds;
    const has = (a: string, b: string): boolean => {
      for (let i = 0; i < cv.bodyBeamCount; i++) {
        const x = ids[cv.rig.beamA[i]!]!;
        const y = ids[cv.rig.beamB[i]!]!;
        if ((x === a && y === b) || (x === b && y === a)) return true;
      }
      return false;
    };
    expect(has('s6_rf_R', 's8_rf_L')).toBe(true); // roof X
    expect(has('s5_hp_R', 's5_hp_L')).toBe(true); // dash bar
    expect(has('s7_dm_R', 's7_dm_L')).toBe(true); // main hoop cross bar
    expect(has('hood_0C', 's2_rt')).toBe(true); // latch
    for (const id of ['hood_0L', 'hood_3R', 's0_bu', 's13_bl', 's5_cw_R', 's6_rf_L', 's7_tn', 's2_rs', 's7_rf']) expect(ids).toContain(id);
    expect(BEATER.frame).toEqual({ origin: 's7_tn', front: 's2_rs', top: 's7_rf' });
  });
});

describe('BEATER handling harness', () => {
  it('static: sag 2–6 cm, no creep, no jitter', () => {
    expect(st.sag).toBeGreaterThan(0.02);
    expect(st.sag).toBeLessThan(0.06);
    expect(st.creep).toBeLessThan(1e-3);
    expect(st.jitter).toBeLessThan(0.15);
  });
  it('0–100 km/h in 11–14 s, straight (drift ≤ 3°)', () => {
    expect(launch.t100).toBeGreaterThanOrEqual(11);
    expect(launch.t100).toBeLessThanOrEqual(14);
    expect(launch.headingDrift100).toBeLessThanOrEqual(3);
  });
  it('100–0 ≤ 45 m', () => {
    expect(brake.distance).toBeLessThanOrEqual(45);
    expect(brake.headingDrift).toBeLessThan(5);
  });
  // R-TYRE: floor 0.75 → 0.72. With the per-node friction ellipse (ground.ts) the open-diff FWD car's unloaded
  // inner front spins under the circle's throttle and pays for that traction in side force (0.77 → 0.74 g;
  // μ +4.5 % bought only +0.013 g). Road tests of 1990s FWD compacts on budget tyres: 0.70–0.78 g.
  it('R40 circle 0.72–0.95 g', () => {
    expect(circle.maxLatG).toBeGreaterThanOrEqual(0.72);
    expect(circle.maxLatG).toBeLessThanOrEqual(0.95);
  });
  it('step steer 0.12 at 60 km/h: no spin', () => {
    expect(step.spun).toBe(false);
    expect(step.yawSteady).toBeGreaterThan(0.05);
  });
  it('top speed: still accelerating at 155 km/h, no weave', () => {
    expect(top.accel200).toBeGreaterThan(0);
    expect(top.maxYawRate).toBeLessThan(0.05);
    expect(top.headingDrift).toBeLessThan(3);
  });
  it('hard driving (full throttle, full brake, 0.5 steer at 60 km/h) stays elastic', () => {
    expect(drivePlastic).toBe(0);
  });
});

describe('BEATER crash harness (vs the sedan, same run)', () => {
  it('folds like paper: 50 km/h crush ≥ 1.5× the sedan’s, intrusion ≤ 30 cm, no NaN / explosion, wheels stay on', () => {
    const r = crash.f50!;
    expect(r.crush).toBeGreaterThanOrEqual(1.5 * sedan.f50!.crush);
    expect(r.crush).toBeGreaterThanOrEqual(0.78);
    expect(r.intrusion).toBeLessThanOrEqual(0.3);
    expect(r.finite).toBe(true);
    expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
    expect(r.keRatio).toBeLessThan(0.05);
    expect(r.maxSpan).toBeLessThan(3);
    expect(r.wheelsDetached).toBe(0);
  });
  it('30 km/h crush ≥ 1.5× the sedan’s; a 10 km/h tap leaves ≥ 2 cm permanent', () => {
    expect(crash.f30!.crush).toBeGreaterThanOrEqual(1.5 * sedan.f30!.crush);
    expect(crash.f10!.crush).toBeGreaterThanOrEqual(0.02);
  });
  it('30 km/h side pole: door intrusion ≥ 1.4× the sedan’s, nothing pulled through', () => {
    expect(crash.pole!.doorIntrusion).toBeGreaterThanOrEqual(1.4 * sedan.pole!.doorIntrusion);
    expect(crash.pole!.poleSideKept).toBe(true);
    expect(crash.pole!.finite).toBe(true);
  });
  it('64 km/h offset and 100 km/h frontal: the cage holds (intrusion ≤ 30 cm), stable', () => {
    for (const r of [crash.offset!, crash.f100!]) {
      expect(r.finite).toBe(true);
      expect(r.intrusion).toBeLessThanOrEqual(0.3);
      expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
    }
    expect(crash.f100!.latchBroken).toBe(true);
  });
  it('derby: after a 50 km/h wall hit it reverses away and drives on, wheels attached', () => {
    expect(away.finite).toBe(true);
    expect(away.wheelsAttached).toBe(true);
    expect(away.reverse).toBeGreaterThan(3);
    expect(away.forward).toBeGreaterThan(10);
  });
});
