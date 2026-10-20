/**
 * SEDAN_TRAFFIC (P6, T1): the cheaper AI-traffic sedan rig. Fleet targets
 * (docs/CONTRACTS.md "Fleet targets", sedanTraffic column): ≤ 1500 beams (≈ 1300 target),
 * 4 × 10-ray wheels, the sedan's mass / wheelbase / track / drivetrain and
 * node ids at the same rest positions, sag 2–7 cm, 0–100 ≤ 9 s (drift
 * ≤ 3°), 100–0 ≤ 45 m, R40 ≥ 0.85 g, step steer no spin, no weave at
 * 195 km/h, 50 km/h frontal crush 35–55 cm — and still 35–55 cm at ±5 % speed
 * and with a 10 % offset (90 % overlap) — with intrusion < 15 cm, 100 km/h
 * no explosion, and the player sedan into its side at 50 km/h: no NaN, no
 * interlock (the cars separate again).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { compileRig, computeStabilityReport, GENERAL_OMEGA_DT_LIMIT, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { SimEngine } from '../engine';
import { buildVehicleRig, compileVehicle, TRAFFIC_BEAM_BUDGET, validateVehicle, vehicleOmegaDtLimit } from './builder';
import { runCrash, type CrashResult } from './crash';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC, SEDAN_TRAFFIC_CRASH_PROBES, SEDAN_TRAFFIC_TARGETS, SKIP_STATIONS } from './defs/sedanTraffic';
import {
  runBraking,
  runCircle,
  runLaunch,
  runStatic,
  runStepSteer,
  runTopSpeed,
  setMotion,
  type BrakeResult,
  type CircleResult,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
  type TopSpeedResult,
} from './handling';

const cv = compileVehicle(SEDAN_TRAFFIC);
const sedan = compileVehicle(SEDAN);

describe('SEDAN_TRAFFIC definition', () => {
  it('validates at the traffic beam budget (≤ 1500), one island, no warnings', () => {
    const r = validateVehicle(SEDAN_TRAFFIC, TRAFFIC_BEAM_BUDGET);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.islands).toBe(1);
    expect(r.stats.beamCount).toBeLessThanOrEqual(TRAFFIC_BEAM_BUDGET);
    // The ≈ 1300 target (CONTRACTS fleet table), not just the 1500 ceiling.
    expect(r.stats.beamCount).toBeLessThanOrEqual(1360);
    console.log(`[sedanTraffic] ${cv.rig.nodeCount} nodes, ${cv.rig.beamCount} beams (body ${cv.bodyBeamCount}); sedan ${sedan.rig.beamCount}`);
  });

  it('declared masses are stable per group, no MINIMASS drift', () => {
    const merged = buildVehicleRig(SEDAN_TRAFFIC);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(GENERAL_OMEGA_DT_LIMIT);
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(vehicleOmegaDtLimit(merged.nodes[i]!.group) * (1 + 1e-9));
      expect(rep.dampDt[i]).toBeLessThanOrEqual(1);
    }
    expect(cv.massDriftPct).toBeLessThan(1);
  });

  it("has the sedan's mass, wheelbase, track, drivetrain, brakes, aero and steering; 4 × 10-ray wheels", () => {
    expect(Math.abs(cv.totalMass - sedan.totalMass) / sedan.totalMass).toBeLessThan(0.02);
    expect(cv.totalMass).toBeCloseTo(SEDAN_TRAFFIC_TARGETS.totalMass, -1);
    expect(SEDAN_TRAFFIC.drivetrain).toEqual(SEDAN.drivetrain);
    expect(SEDAN_TRAFFIC.brakes).toEqual(SEDAN.brakes);
    expect(SEDAN_TRAFFIC.aero).toEqual(SEDAN.aero);
    expect(SEDAN_TRAFFIC.steering).toEqual(SEDAN.steering);
    expect(SEDAN_TRAFFIC.frame).toEqual(SEDAN.frame);
    expect(SEDAN_TRAFFIC.wheels.map((w) => w.id)).toEqual(['FL', 'FR', 'RL', 'RR']);
    for (let i = 0; i < 4; i++) {
      const a = SEDAN_TRAFFIC.wheels[i]!;
      const b = SEDAN.wheels[i]!;
      expect(a.rays).toBe(10);
      expect(a.hubInner).toEqual(b.hubInner);
      expect(a.hubOuter).toEqual(b.hubOuter);
      expect(a.radius).toBe(b.radius);
      for (const k of ['steered', 'driven', 'braked', 'handbrake', 'brakeTorqueMax'] as const) expect(a[k]).toBe(b[k]);
    }
  });

  it("uses the sedan's node ids at the sedan's rest positions (± 1 cm) for every node it keeps", () => {
    const ref = new Map(SEDAN.body.nodes.map((n) => [n.id, n.pos]));
    for (const n of SEDAN_TRAFFIC.body.nodes) {
      const p = ref.get(n.id);
      expect(p, n.id).toBeDefined();
      for (let k = 0; k < 3; k++) expect(Math.abs(n.pos[k]! - p![k]!), n.id).toBeLessThanOrEqual(0.01);
    }
    // No hood sub-rig; every bumper / station of the sedan's shell is kept.
    expect(SEDAN_TRAFFIC.body.nodes.some((n) => n.id.startsWith('hood_'))).toBe(false);
    for (let st = 0; st <= 13; st++) expect(SEDAN_TRAFFIC.body.nodes.some((n) => n.id.startsWith(`s${st}_`)), `s${st}`).toBe(!SKIP_STATIONS.has(st));
  });
});

describe('SEDAN_TRAFFIC handling (sedan harness)', () => {
  let st: StaticResult;
  let launch: LaunchResult;
  let brake: BrakeResult;
  let circle: CircleResult;
  let step: StepSteerResult;
  let top: TopSpeedResult;
  beforeAll(() => {
    st = runStatic(SEDAN_TRAFFIC);
    launch = runLaunch(SEDAN_TRAFFIC);
    brake = runBraking(SEDAN_TRAFFIC);
    circle = runCircle(SEDAN_TRAFFIC);
    step = runStepSteer(SEDAN_TRAFFIC);
    top = runTopSpeed(SEDAN_TRAFFIC);
    console.log(
      `[sedanTraffic] sag ${(st.sag * 100).toFixed(1)} cm, 0–100 ${launch.t100.toFixed(2)} s (drift ${launch.headingDrift100.toFixed(2)}°), ` +
        `100–0 ${brake.distance.toFixed(1)} m, R40 ${circle.maxLatG.toFixed(2)} g, step overshoot ${step.overshoot.toFixed(2)}, ` +
        `accel@200 ${top.accel200.toFixed(2)} m/s², 195 km/h straight yaw ${top.maxYawRate.toFixed(3)} rad/s (end ${top.endKmh.toFixed(0)} km/h)`,
    );
  }, 240_000);

  it('static sag 2–7 cm, no creep', () => {
    expect(st.sag).toBeGreaterThan(0.02);
    expect(st.sag).toBeLessThan(0.07);
    expect(st.creep).toBeLessThan(1e-3);
  });
  it('0–100 km/h ≤ 9 s with TC, heading drift ≤ 3°', () => {
    expect(launch.t100).toBeLessThanOrEqual(9);
    expect(launch.headingDrift100).toBeLessThanOrEqual(3);
  });
  it('100–0 km/h ≤ 45 m', () => {
    expect(brake.distance).toBeLessThanOrEqual(45);
    expect(brake.headingDrift).toBeLessThan(5);
  });
  it('R40 circle ≥ 0.85 g', () => {
    expect(circle.maxLatG).toBeGreaterThanOrEqual(0.85);
  });
  it('step steer 0.12 at 60 km/h: no spin', () => {
    expect(step.spun).toBe(false);
    expect(step.overshoot).toBeLessThan(1.5);
  });
  it('still accelerates at 200 km/h; a 10 s full-throttle straight from 195 km/h does not weave', () => {
    expect(top.accel200).toBeGreaterThan(0);
    expect(top.maxYawRate).toBeLessThan(0.05);
    expect(top.headingDrift).toBeLessThan(3);
  });
});

describe('SEDAN_TRAFFIC crashes', () => {
  const crash = (speedKmh: number): CrashResult =>
    runCrash({ kind: 'frontal', speedKmh, def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES });

  it('50 km/h frontal: crush 35–55 cm, intrusion < 15 cm, no NaN', () => {
    const r = crash(50);
    console.log(`[sedanTraffic] 50 km/h: crush ${(r.crush * 100).toFixed(1)} cm (peak ${(r.crushMax * 100).toFixed(1)}), intrusion ${(r.intrusion * 100).toFixed(1)} cm`);
    expect(r.finite).toBe(true);
    expect(r.crush).toBeGreaterThanOrEqual(0.35);
    expect(r.crush).toBeLessThanOrEqual(0.55);
    expect(r.intrusion).toBeLessThan(0.15);
    expect(r.wheelsDetached).toBe(0);
  }, 60_000);

  it('the 50 km/h crush is robust: 35–55 cm at 47.5 and 52.5 km/h and with a 10 % offset (90 % overlap), spread ≤ 8 cm', () => {
    const runs = [
      crash(47.5),
      crash(52.5),
      runCrash({ kind: 'offset', overlap: 0.9, speedKmh: 50, def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES }),
    ];
    console.log(`[sedanTraffic] robustness: ${runs.map((r) => `${r.spec.kind} ${r.spec.speedKmh} km/h${r.spec.overlap !== undefined ? ` ${r.spec.overlap * 100} %` : ''}: ${(r.crush * 100).toFixed(1)} cm`).join(', ')}`);
    for (const r of runs) {
      expect(r.finite).toBe(true);
      expect(r.crush).toBeGreaterThanOrEqual(0.35);
      expect(r.crush).toBeLessThanOrEqual(0.55);
      expect(r.intrusion).toBeLessThan(0.15);
    }
    const c = runs.map((r) => r.crush);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(0.08);
  }, 180_000);

  it('100 km/h frontal: no explosion', () => {
    const r = crash(100);
    expect(r.finite).toBe(true);
    expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
    expect(r.keRatio).toBeLessThan(0.05);
  }, 60_000);

  it('the player sedan at 50 km/h into the side of a parked traffic sedan: no NaN, no interlock, separable', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
    eng.setGroundPlane(0, MaterialId.asphalt);
    const h = Math.SQRT1_2;
    // Player faces +X (yaw −90°), its nose 0.3 m from the traffic car's right-hand doors.
    eng.spawnVehicle(1, SEDAN, { pos: [-3.2, 0.01, 0.3], quat: [0, -h, 0, h] });
    eng.spawnVehicle(2, SEDAN_TRAFFIC, { pos: [0, 0.01, 0], quat: [0, 0, 0, 1] });
    eng.setInput(2, { brake: 1, handbrake: 1, gearSelect: 0 });
    for (let i = 0; i < 1000; i++) eng.step();
    const p = eng.arena.get(1)!;
    const t = eng.arena.get(2)!;
    const veh = eng.getVehicle(1)!;
    setMotion({ eng, obj: p, veh, cv: veh.vehicle, objectId: 1 }, 50 / 3.6);
    const s = eng.state;
    let finite = true;
    let contacted = false;
    for (let i = 0; i < 4000; i++) {
      eng.step();
      eng.events.clear();
      if (eng.contacts.pairCount > 0) contacted = true;
    }
    for (let n = 0; n < s.nodeCount; n++) if (!Number.isFinite(s.posX[n]! + s.posY[n]! + s.posZ[n]!)) finite = false;
    expect(finite).toBe(true);
    expect(contacted).toBe(true);
    // Back the player out at 4 m/s: interlocked nodes would drag the traffic car along (or tear).
    setMotion({ eng, obj: p, veh, cv: veh.vehicle, objectId: 1 }, -4);
    for (let i = 0; i < 3000; i++) {
      eng.step();
      eng.events.clear();
    }
    const box = (o: typeof p): number[] => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let n = o.nodeStart; n < o.nodeStart + o.nodeCount; n++) {
        b[0] = Math.min(b[0]!, s.posX[n]!);
        b[1] = Math.min(b[1]!, s.posZ[n]!);
        b[2] = Math.max(b[2]!, s.posX[n]!);
        b[3] = Math.max(b[3]!, s.posZ[n]!);
      }
      return b;
    };
    const a = box(p);
    const b = box(t);
    const gapX = Math.max(b[0]! - a[2]!, a[0]! - b[2]!);
    const gapZ = Math.max(b[1]! - a[3]!, a[1]! - b[3]!);
    expect(Math.max(gapX, gapZ)).toBeGreaterThan(0.05);
    expect(eng.contacts.pairCount).toBe(0);
  }, 60_000);
});
