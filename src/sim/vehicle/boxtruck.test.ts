/**
 * BOX TRUCK (P6 F3) definition, handling, tip-over and crash acceptance
 * (docs/CONTRACTS.md "Fleet targets": the boxtruck column). Every scenario runs
 * once (beforeAll) and the table is printed, so the file doubles as the
 * truck's tuning report. Every assertion is at the column's target.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { SimEngine, SIM_HZ } from '../engine';
import { compileRig, computeStabilityReport, GENERAL_OMEGA_DT_LIMIT, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { buildVehicleRig, compileVehicle, PLAYER_BEAM_BUDGET, validateVehicle, vehicleOmegaDtLimit } from './builder';
import { formatCrash, runCrash, type CrashResult } from './crash';
import { SEDAN } from './defs/sedan';
import { BOX_DIMS, BOXTRUCK, BOXTRUCK_CRASH_PROBES, BOXTRUCK_DESIGN, BOXTRUCK_INNER_DUALS, BOXTRUCK_TARGETS } from './defs/boxtruck';
import {
  createHandlingSim,
  kinematics,
  runLaunch,
  runScenario,
  runStatic,
  runStepSteer,
  setMotion,
  stepN,
  type HandlingSample,
  type HandlingSim,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
} from './handling';
import { formatTurn, runJTurn, runRampSteer, runRollover, runSteadyLateral, type CrushProbe, type RampSteerResult, type RolloverResult, type SteadyLateralResult } from './rollover';
import type { VehicleDef } from './types';

const cv = compileVehicle(BOXTRUCK);
const report: string[] = [];
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// ====================================================================== definition
describe('BOXTRUCK definition', () => {
  it('validates with no errors, one island, within the player beam budget (≤ 3500, no exception)', () => {
    const r = validateVehicle(BOXTRUCK);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.islands).toBe(1);
    expect(r.stats.beamCount).toBeLessThanOrEqual(PLAYER_BEAM_BUDGET);
    expect(r.stats.pinnedCount).toBe(0);
  });

  it('declared masses: every node within its group ω·dt limit (0.5 % slack on the rim rows), (Σd/m)·dt ≤ 1, MINIMASS drift < 1 %', () => {
    const merged = buildVehicleRig(BOXTRUCK);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      const g = merged.nodes[i]!.group;
      expect(rep.omegaDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(GENERAL_OMEGA_DT_LIMIT);
      expect(rep.omegaDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(vehicleOmegaDtLimit(g) * 1.005);
      expect(rep.dampDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(1);
    }
    expect(cv.massDriftPct).toBeLessThan(1);
  });

  it('6.5 t (±2 %), a third on the front axle, 4.7 m wheelbase, dual rear wheels (4 driven, inner pair mirrored)', () => {
    expect(Math.abs(cv.totalMass - BOXTRUCK_TARGETS.totalMass) / BOXTRUCK_TARGETS.totalMass).toBeLessThan(0.02);
    expect(BOXTRUCK_DESIGN.frontAxleShare).toBeCloseTo(BOXTRUCK_TARGETS.frontAxleShare, 2);
    expect(BOXTRUCK.wheels.map((w) => w.id)).toEqual(['FL', 'FR', 'RL', 'RR', 'RLi', 'RRi']);
    expect(BOXTRUCK.wheels.filter((w) => w.driven).map((w) => w.id)).toEqual(['RL', 'RR', 'RLi', 'RRi']);
    expect(BOXTRUCK.drivetrain.diff).toBe('open');
    expect([...BOXTRUCK_INNER_DUALS]).toEqual(['RLi', 'RRi']);
    const p = cv.rig.nodePos;
    const hub = (i: number): number[] => [0, 1, 2].map((k) => (p[3 * cv.wheels[i]!.hubI + k]! + p[3 * cv.wheels[i]!.hubO + k]!) / 2);
    expect(hub(2)[2]! - hub(0)[2]!).toBeCloseTo(BOXTRUCK_TARGETS.wheelbase, 6);
    // Duals: the inner wheel sits inboard of the outer on the same axle line.
    expect(Math.abs(hub(2)[0]!) - Math.abs(hub(4)[0]!)).toBeCloseTo(BOXTRUCK_TARGETS.dualSpacing, 6);
    expect(hub(4)[2]).toBeCloseTo(hub(2)[2]!, 6);
    // 180 kW / 900 N·m turbo-diesel, governed (droop) above 2400 rpm.
    const tc = BOXTRUCK.drivetrain.torqueCurve;
    expect(Math.max(...tc.map((q) => q[1]))).toBe(BOXTRUCK_TARGETS.torqueNm);
    let kw = 0;
    for (let r = 0; r <= tc[tc.length - 1]![0]; r += 10) {
      let t = tc[0]![1];
      for (let i = 1; i < tc.length; i++)
        if (r <= tc[i]![0]) {
          const [r0, t0] = tc[i - 1]!;
          const [r1, t1] = tc[i]!;
          t = t0 + ((t1 - t0) * (r - r0)) / (r1 - r0);
          break;
        }
      kw = Math.max(kw, (t * r * Math.PI) / 30 / 1000);
    }
    expect(Math.abs(kw - BOXTRUCK_TARGETS.powerKw) / BOXTRUCK_TARGETS.powerKw).toBeLessThan(0.03);
  });

  it('separate cab and box: joined to the frame only by mount beams', () => {
    const part = (id: string): string | null => /^(f|c|b)\d+_/.exec(id)?.[1] ?? null;
    const mounts = new Set([...BOXTRUCK_DESIGN.cabMounts, ...BOXTRUCK_DESIGN.boxMounts].map(([a, b]) => [a, b].sort().join('|')));
    for (const b of BOXTRUCK.body.beams) {
      const pa = part(b.a);
      const pb = part(b.b);
      if (pa === null || pb === null || pa === pb) continue;
      if (pa !== 'f' && pb !== 'f') expect(`${b.a}-${b.b}`).toBe('cab and box never share a beam');
      else expect(mounts.has([b.a, b.b].sort().join('|')), `${b.a}-${b.b}`).toBe(true);
    }
    expect(BOXTRUCK_DESIGN.boxMounts.length).toBeGreaterThanOrEqual(40);
    expect(BOX_DIMS.roofY).toBeGreaterThan(3.3);
  });
});

// ====================================================================== handling
let st: StaticResult;
let cgRest = 0;
let launch: LaunchResult;
let launchMsPerSimS = 0;
let brake: { dist: number; drift: number };
let step: StepSteerResult;
let gov: { vmax: number; vEnd: number; yawMax: number };

/** Settled CG height (handbrake on, 2 s). */
function restCg(def: VehicleDef): number {
  const sim = createHandlingSim({ def });
  sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 1 });
  stepN(sim, 2 * SIM_HZ);
  const s = sim.eng.state;
  let m = 0;
  let y = 0;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) {
    m += 1 / s.invMass[i]!;
    y += s.posY[i]! / s.invMass[i]!;
  }
  return y / m;
}

/** 80 → 0 km/h, full brake: distance and max heading change (deg). */
function brake80(): { dist: number; drift: number } {
  const { samples } = runScenario({
    def: BOXTRUCK,
    initialSpeed: 80 / 3.6,
    initialGear: 0,
    durationS: 8,
    sampleHz: 100,
    control: () => ({ gearSelect: 0, throttle: 0, brake: 1, steer: 0 }),
    stop: (s) => s.groundSpeed < 0.1,
  });
  let drift = 0;
  for (const s of samples) drift = Math.max(drift, Math.abs(s.heading - samples[0]!.heading));
  return { dist: samples[samples.length - 1]!.dist, drift: (drift * 180) / Math.PI };
}

/** Full throttle in Drive from 90 km/h for 30 s: the governor's speed, and the yaw-rate noise above 100 km/h. */
function governed(): { vmax: number; vEnd: number; yawMax: number } {
  const { samples } = runScenario({ def: BOXTRUCK, initialSpeed: 90 / 3.6, durationS: 30, sampleHz: 20, control: () => ({ gearSelect: 1, throttle: 1, brake: 0, steer: 0 }) });
  let vmax = 0;
  let yawMax = 0;
  for (const s of samples) {
    vmax = Math.max(vmax, s.speed * 3.6);
    if (s.speed * 3.6 > 100) yawMax = Math.max(yawMax, Math.abs(s.yawRate));
  }
  return { vmax, vEnd: samples[samples.length - 1]!.speed * 3.6, yawMax };
}

// ====================================================================== tip-over
let ramp: RampSteerResult;
let j40: RampSteerResult;
let j70: RampSteerResult;
let steady: SteadyLateralResult;
let roof: RolloverResult;

/** Box: the roof centre over the floor centre at each inner station (worst one counts). */
const BOX_ROOF: CrushProbe[] = [1, 2, 3, 4, 5, 6].map((i) => ({ name: `b${i}`, roof: [`b${i}_rc`], floor: [`b${i}_fc`], across: [`b${i}_fi_L`, `b${i}_fi_R`] }));
/** Cab: the whole roof (c1–c3 roof rails and centre) over the whole floor — the survival space. */
const CAB_ROOF: CrushProbe[] = [
  {
    name: 'cab',
    roof: [1, 2, 3].flatMap((i) => [`c${i}_rf_L`, `c${i}_rf`, `c${i}_rf_R`]),
    floor: [1, 2, 3].flatMap((i) => [`c${i}_fl_L`, `c${i}_fl_R`]),
    across: ['c2_fl_L', 'c2_fl_R'],
  },
];

/** Lowest 0.1 s-mean corner load over the step steer, as a share of the corner's static load. */
function stepMinMeanShare(): number {
  const S = step.samples;
  let lo = Infinity;
  for (let w = 0; w < S[0]!.load.length; w++)
    for (let i = 9; i < S.length; i++) {
      let m = 0;
      for (let j = i - 9; j <= i; j++) m += S[j]!.load[w]! / 10;
      lo = Math.min(lo, m / S[0]!.load[w]!);
    }
  return lo;
}

// ====================================================================== crash
let f50: CrashResult;
let f64: CrashResult;
let box50: BoxFrontal;
let side: SideHit;
const probes = BOXTRUCK_CRASH_PROBES as unknown as Parameters<typeof runCrash>[0]['probes'];

function engine(): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 12288 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  return eng;
}
function spawn(eng: SimEngine, id: number, def: VehicleDef, pos: [number, number, number], quat: [number, number, number, number]): HandlingSim {
  const obj = eng.spawnVehicle(id, def, { pos, quat }, 'auto');
  const veh = eng.getVehicle(id)!;
  return { eng, obj, veh, cv: veh.vehicle, objectId: id };
}
function brokenCount(sim: HandlingSim, list: readonly (readonly [string, string])[]): number {
  const ids = sim.cv.rig.nodeIds;
  const s = sim.eng.state;
  const want = new Set(list.map(([a, b]) => [a, b].sort().join('|')));
  let n = 0;
  for (let k = 0; k < sim.cv.bodyBeamCount; k++) {
    if (s.active[sim.obj.beamStart + k] !== 0) continue;
    if (want.has([ids[sim.cv.rig.beamA[k]!]!, ids[sim.cv.rig.beamB[k]!]!].sort().join('|'))) n++;
  }
  return n;
}
function finite(sim: HandlingSim): boolean {
  const s = sim.eng.state;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) if (!Number.isFinite(s.posX[i]! + s.posY[i]! + s.posZ[i]!)) return false;
  return true;
}

interface BoxFrontal {
  /** Box (all wall / floor / roof ring nodes) moved along the frame axis relative to the rear frame, m: final and max. */
  shift: number;
  shiftMax: number;
  boxMountsBroken: number;
  cabMountsBroken: number;
  finite: boolean;
}

/** The crash.ts frontal set-up (concrete wall 3 cm ahead, rolling release, 2.2 s), tracking the box against the rear frame. */
function boxFrontal(kmh: number): BoxFrontal {
  const eng = engine();
  const sim = spawn(eng, 1, BOXTRUCK, [0, 0, 0], [0, 0, 0, 1]);
  const s = eng.state;
  const ids = sim.cv.rig.nodeIds;
  const idx = (re: RegExp): number[] => ids.flatMap((id, i) => (re.test(id) ? [sim.obj.nodeStart + i] : []));
  const box = idx(/^b[0-7]_(fi|fl|wl|wm|rl|rc|fc)/);
  const rear = idx(/^f(9|10|11|12|13)_(hi|lo)_/);
  const mid = idx(/^f(6|7|8)_(hi|lo)_/);
  const mean = (l: number[]): number[] => [0, 1, 2].map((k) => l.reduce((a, i) => a + [s.posX, s.posY, s.posZ][k]![i]!, 0) / l.length);
  const along = (): number => {
    const b = mean(box);
    const r = mean(rear);
    const m = mean(mid);
    const ax = [m[0]! - r[0]!, m[1]! - r[1]!, m[2]! - r[2]!];
    const l = Math.hypot(ax[0]!, ax[1]!, ax[2]!);
    return ((b[0]! - r[0]!) * ax[0]! + (b[1]! - r[1]!) * ax[1]! + (b[2]! - r[2]!) * ax[2]!) / l;
  };
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  let minZ = Infinity;
  for (let i = 0; i < sim.cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[sim.obj.nodeStart + i]! - s.radius[sim.obj.nodeStart + i]!);
  eng.setExtraColliders([{ id: 'wall', kind: 'box', pos: [0, 1.5, minZ - 0.63], quat: [0, 0, 0, 1], size: [6, 1.5, 0.6], material: MaterialId.concrete }]);
  const a0 = along();
  setMotion(sim, kmh / 3.6, 0);
  let shiftMax = 0;
  for (let t = 0; t < 2.2 * SIM_HZ; t++) {
    eng.step();
    if (t % 20 === 0) shiftMax = Math.max(shiftMax, Math.abs(along() - a0));
  }
  return {
    shift: Math.abs(along() - a0),
    shiftMax,
    boxMountsBroken: brokenCount(sim, BOXTRUCK_DESIGN.boxMounts),
    cabMountsBroken: brokenCount(sim, BOXTRUCK_DESIGN.cabMounts),
    finite: finite(sim),
  };
}

interface SideHit {
  /**
   * Local dent of the struck wall, m (max over time, and final): the largest inward displacement of a
   * struck-side wall node (posts, rails and the panel-centre skin nodes) beyond the displacement of the
   * box's own end frames (bilinear in z and y between the b0 and b7 corner posts), so the box sliding,
   * yawing or leaning away from the hit is not counted as a dent.
   */
  dentMax: number;
  dent: number;
  /** Box width (struck wall to far wall) lost, any station / row, m — max over time. */
  widthLossMax: number;
  boxMountsBroken: number;
  finite: boolean;
  sedanFinite: boolean;
}

/** The sedan at `kmh` square into the right side of the parked (braked) truck's box, ahead of the rear wheels. */
function sedanIntoBox(kmh: number): SideHit {
  const eng = engine();
  const q = Math.SQRT1_2;
  const truck = spawn(eng, 1, BOXTRUCK, [0, 0, 0], [0, 0, 0, 1]);
  const sedan = spawn(eng, 2, SEDAN, [6.2, 0, 0.3], [0, q, 0, q]);
  const s = eng.state;
  const ids = truck.cv.rig.nodeIds;
  const id = (n: string): number => truck.obj.nodeStart + ids.indexOf(n);
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1, handbrake: 1 });
  eng.setInput(2, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  expect(kinematics(sedan).fx).toBeLessThan(-0.9);
  const rows = ['fl', 'wl', 'wm', 'rl'];
  const last = BOX_DIMS.stations - 1;
  const wall = [
    ...rows.flatMap((r) => Array.from({ length: last - 1 }, (_, i) => `b${i + 1}_${r}_R`)),
    ...ids.filter((n) => /^bp\d+_\d_R$/.test(n)),
  ].map(id);
  // End-frame corners: [front low, front high, rear low, rear high].
  const corners = [`b0_fl_R`, `b0_rl_R`, `b${last}_fl_R`, `b${last}_rl_R`].map(id);
  const X0 = (i: number): number => s.posX[i]!;
  const rest = { x: wall.map(X0), y: wall.map((i) => s.posY[i]!), z: wall.map((i) => s.posZ[i]!), cx: corners.map(X0) };
  const [zF, zR] = [s.posZ[corners[0]!]!, s.posZ[corners[2]!]!];
  const [yLo, yHi] = [s.posY[corners[0]!]!, s.posY[corners[1]!]!];
  const dentNow = (): number => {
    const d = corners.map((c, k) => s.posX[c]! - rest.cx[k]!);
    let best = -Infinity;
    wall.forEach((n, k) => {
      const u = (rest.z[k]! - zF) / (zR - zF);
      const v = (rest.y[k]! - yLo) / (yHi - yLo);
      const ref = (1 - u) * ((1 - v) * d[0]! + v * d[1]!) + u * ((1 - v) * d[2]! + v * d[3]!);
      best = Math.max(best, ref - (s.posX[n]! - rest.x[k]!));
    });
    return best;
  };
  const width = (): number[] => rows.flatMap((r) => Array.from({ length: last + 1 }, (_, i) => Math.hypot(s.posX[id(`b${i}_${r}_R`)]! - s.posX[id(`b${i}_${r}_L`)]!, s.posY[id(`b${i}_${r}_R`)]! - s.posY[id(`b${i}_${r}_L`)]!)));
  const w0 = width();
  setMotion(sedan, kmh / 3.6, 0);
  let dentMax = 0;
  let widthLossMax = 0;
  for (let t = 0; t < 2.5 * SIM_HZ; t++) {
    eng.step();
    if (t % 20 !== 0) continue;
    dentMax = Math.max(dentMax, dentNow());
    width().forEach((w, i) => (widthLossMax = Math.max(widthLossMax, w0[i]! - w)));
  }
  return { dentMax, dent: dentNow(), widthLossMax, boxMountsBroken: brokenCount(truck, BOXTRUCK_DESIGN.boxMounts), finite: finite(truck), sedanFinite: finite(sedan) };
}

beforeAll(() => {
  st = runStatic(BOXTRUCK);
  cgRest = restCg(BOXTRUCK);
  const t0 = performance.now();
  launch = runLaunch(BOXTRUCK, { durationS: 40 });
  const simS = launch.samples[launch.samples.length - 1]!.t;
  launchMsPerSimS = (performance.now() - t0) / simS;
  brake = brake80();
  step = runStepSteer(BOXTRUCK, 0.06);
  gov = governed();
  ramp = runRampSteer(BOXTRUCK);
  j40 = runJTurn(BOXTRUCK, { speedKmh: 40 });
  j70 = runJTurn(BOXTRUCK, { speedKmh: 70 });
  steady = runSteadyLateral(BOXTRUCK, { latG: 0.35 });
  roof = runRollover(BOXTRUCK, { speedKmh: 50, rollRate: 0, invertedDropM: 0.5, durationS: 3, probes: { box: BOX_ROOF, cab: CAB_ROOF } });
  f50 = runCrash({ kind: 'frontal', speedKmh: 50, def: BOXTRUCK, probes });
  f64 = runCrash({ kind: 'frontal', speedKmh: 64, def: BOXTRUCK, probes });
  box50 = boxFrontal(50);
  side = sedanIntoBox(50);
}, 1_800_000);

afterAll(() => {
  const t80 = launch.samples.find((s: HandlingSample) => s.speed >= 80 / 3.6)?.t ?? Infinity;
  report.push(
    `static: sag ${f(st.sag * 100, 1)} cm, creep ${f(st.creep * 1000, 1)} mm/s, jitter ${f(st.jitter, 3)} m/s, CG at rest ${f(cgRest, 3)} m`,
    `launch: 0–80 ${f(t80, 1)} s, 0–100 ${f(launch.t100, 1)} s, drift ${f(launch.headingDrift100, 1)}°; physics ${f(launchMsPerSimS, 0)} ms/sim-s`,
    `brake 80–0: ${f(brake.dist, 1)} m, drift ${f(brake.drift, 1)}°`,
    `step 0.06 @ 60: overshoot ${f(step.overshoot)}, latG ${f(step.latG)}, spun ${step.spun}, min corner load ${f(Math.min(...step.samples.map((s) => Math.min(...s.load))), 0)} N (0.1 s mean ≥ ${f(stepMinMeanShare() * 100, 0)} % of static)`,
    `governed: max ${f(gov.vmax, 1)} km/h, after 30 s ${f(gov.vEnd, 1)} km/h, |yaw| > 100 km/h ≤ ${f(gov.yawMax, 3)} rad/s`,
    formatTurn('ramp-steer 60', ramp),
    formatTurn('J-turn 40', j40),
    formatTurn('J-turn 70', j70),
    `steady ${f(steady.latG)} g: roll ${f(steady.rollDeg, 1)}°, lifted ${steady.lifted}`,
    `roof landing at 50 km/h: box roof ${f(roof.crush.box! * 100, 1)} cm (${roof.worst.box}), cab roof ${f(roof.crush.cab! * 100, 1)} cm (max ${f(roof.crushMax.cab! * 100, 1)})`,
    formatCrash(f50),
    `  box shift ${f(box50.shift * 100, 1)} cm (max ${f(box50.shiftMax * 100, 1)}), box mounts broken ${box50.boxMountsBroken}/${BOXTRUCK_DESIGN.boxMounts.length}, cab mounts broken ${box50.cabMountsBroken}`,
    formatCrash(f64),
    `sedan 50 km/h into the box side: local dent ${f(side.dent * 100, 1)} cm (max ${f(side.dentMax * 100, 1)}), width lost max ${f(side.widthLossMax * 100, 1)} cm, box mounts broken ${side.boxMountsBroken}`,
  );
  console.log('\nBOXTRUCK report\n' + report.map((l) => '  ' + l).join('\n'));
});

describe('BOXTRUCK handling (fleet targets)', () => {
  it('static: sag 4–10 cm, parked (creep < 5 mm/s, jitter < 0.15 m/s), loaded CG ≥ 1.35 m at rest', () => {
    expect(st.sag).toBeGreaterThanOrEqual(0.04);
    expect(st.sag).toBeLessThanOrEqual(0.1);
    expect(st.creep).toBeLessThan(0.005);
    expect(st.jitter).toBeLessThan(0.15);
    expect(cgRest).toBeGreaterThanOrEqual(BOXTRUCK_TARGETS.cgHeightMin);
  });

  it('launch: 0–80 ≤ 20 s, straight', () => {
    const t80 = launch.samples.find((s) => s.speed >= 80 / 3.6)?.t ?? Infinity;
    expect(t80).toBeLessThanOrEqual(20);
    expect(launch.headingDrift100).toBeLessThan(3);
  });

  it('brakes: 80–0 ≤ 48 m, drift ≤ 5°', () => {
    expect(brake.dist).toBeLessThanOrEqual(48);
    expect(brake.drift).toBeLessThanOrEqual(5);
  });

  it('step steer 0.06 at 60 km/h: no spin, no wheel lift (every corner keeps ≥ 20 % of its load over any 0.1 s, never 0)', () => {
    expect(step.spun).toBe(false);
    // Lift is judged over rollover.ts's 0.1 s window: the solid rear axle's tramp makes the inside outer
    // dual's load chatter ±2–3 kN at 15–30 Hz, so a single 100 Hz sample says little about lift.
    const S = step.samples;
    for (let w = 0; w < S[0]!.load.length; w++) {
      const st = S[0]!.load[w]!;
      for (let i = 0; i < S.length; i++) {
        expect(S[i]!.load[w]!).toBeGreaterThan(0);
        if (i < 9) continue;
        let m = 0;
        for (let j = i - 9; j <= i; j++) m += S[j]!.load[w]! / 10;
        expect(m / st).toBeGreaterThanOrEqual(0.2);
      }
    }
  });

  it('governed at 105–115 km/h, no weave at 100+', () => {
    expect(gov.vmax).toBeGreaterThanOrEqual(105);
    expect(gov.vmax).toBeLessThanOrEqual(115);
    expect(gov.vEnd).toBeGreaterThanOrEqual(105);
    expect(gov.yawMax).toBeLessThan(0.02);
  });
});

describe('BOXTRUCK tips (rollover.ts)', () => {
  it('ramp-steer at 60 km/h: inside wheels lift at 0.45–0.60 g, rolls over while 0.65 g is demanded', () => {
    expect(ramp.liftG).toBeGreaterThanOrEqual(0.45);
    expect(ramp.liftG).toBeLessThanOrEqual(0.6);
    expect(ramp.rolled).toBe(true);
  });

  it('full-lock J-turn: rolls at 70 km/h, stays upright at 40 km/h (roll ≤ 12°)', () => {
    expect(j70.rolled).toBe(true);
    expect(j40.rolled).toBe(false);
    expect(j40.maxRollDeg).toBeLessThanOrEqual(12);
  });

  it('steady 0.35 g: roll ≤ 6°, all wheels down', () => {
    expect(steady.latG).toBeGreaterThan(0.33);
    expect(steady.rollDeg).toBeLessThanOrEqual(6);
    expect(steady.lifted).toBe(false);
  });

  it('rolled at 50 km/h (lands on its roof): the box roof crushes ≥ 20 cm, the cab roof ≤ 15 cm', () => {
    expect(roof.finite).toBe(true);
    expect(roof.finalRollDeg).toBeGreaterThan(150);
    expect(roof.crush.box).toBeGreaterThanOrEqual(0.2);
    expect(roof.crush.cab).toBeLessThanOrEqual(0.15);
  });
});

describe('BOXTRUCK crash', () => {
  it('50 km/h frontal: 25–50 cm permanent crush, cab intrusion < 12 cm, box shifts ≤ 30 cm and stays on, nothing explodes', () => {
    expect(f50.finite).toBe(true);
    expect(f50.intrusion).toBeLessThan(0.12);
    expect(f50.crushMax).toBeLessThan(1.3);
    // Column: 25–50 cm (horn tips to the cab floor, after the rebound).
    expect(f50.crush).toBeGreaterThanOrEqual(0.25);
    expect(f50.crush).toBeLessThanOrEqual(0.5);
    expect(f50.keRatio).toBeLessThan(0.05);
    expect(f50.maxSpeedLate).toBeLessThanOrEqual(f50.initialSpeed);
    expect(box50.finite).toBe(true);
    expect(box50.shiftMax).toBeLessThanOrEqual(0.3);
    expect(box50.boxMountsBroken).toBeLessThan(BOXTRUCK_DESIGN.boxMounts.length / 4);
  });

  it('64 km/h frontal: finite (the box may break mounts)', () => {
    expect(f64.finite).toBe(true);
    expect(f64.intrusion).toBeLessThan(0.2);
  });

  it('sedan into the box side at 50 km/h: the wall keeps a ≥ 15 cm dent, both finite, the box stays on', () => {
    expect(side.finite).toBe(true);
    expect(side.sedanFinite).toBe(true);
    expect(side.boxMountsBroken).toBeLessThan(BOXTRUCK_DESIGN.boxMounts.length / 4);
    // Column: ≥ 15 cm local dent, permanent (after the rebound), not just at the peak.
    expect(side.dent).toBeGreaterThanOrEqual(0.15);
  });
});
