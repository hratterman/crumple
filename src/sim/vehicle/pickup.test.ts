/**
 * PICKUP (P6 F2) definition, handling and crash acceptance (docs/CONTRACTS.md
 * "Fleet targets": the pickup column; the sedan's harness thresholds apply
 * where the column lists none). Every scenario runs once (beforeAll) and the
 * table is printed, so the file doubles as the pickup's tuning report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { SimEngine, SIM_HZ } from '../engine';
import { compileRig, computeStabilityReport, GENERAL_OMEGA_DT_LIMIT, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { buildVehicleRig, compileVehicle, PLAYER_BEAM_BUDGET, validateVehicle, vehicleOmegaDtLimit } from './builder';
import { formatCrash, runCrash, type CrashResult } from './crash';
import { PICKUP, PICKUP_CRASH_PROBES, PICKUP_DESIGN, PICKUP_TARGETS } from './defs/pickup';
import {
  createHandlingSim,
  runBraking,
  runCircle,
  runCoastdown,
  runLaunch,
  runStatic,
  runStepSteer,
  runTopSpeed,
  stepN,
  type BrakeResult,
  type CircleResult,
  type CoastResult,
  type LaunchResult,
  type StaticResult,
  type StepSteerResult,
  type TopSpeedResult,
  setMotion,
} from './handling';
import type { CompiledVehicle, VehicleDef } from './types';

const cv: CompiledVehicle = compileVehicle(PICKUP);

// ====================================================================== definition
describe('PICKUP definition', () => {
  it('validates with no errors or warnings, one island, within the player beam budget (contract ≤ 3500)', () => {
    const r = validateVehicle(PICKUP);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.islands).toBe(1);
    expect(r.stats.beamCount).toBeLessThanOrEqual(PLAYER_BEAM_BUDGET);
    expect(r.stats.pinnedCount).toBe(0);
  });

  it('declared masses: every node within its group ω·dt limit, (Σd/m)·dt ≤ 1, no MINIMASS drift', () => {
    const merged = buildVehicleRig(PICKUP);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    for (let i = 0; i < rep.omegaDt.length; i++) {
      const g = merged.nodes[i]!.group;
      expect(rep.omegaDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(GENERAL_OMEGA_DT_LIMIT);
      expect(rep.omegaDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(vehicleOmegaDtLimit(g) * (1 + 1e-9));
      expect(rep.dampDt[i], merged.nodes[i]!.id).toBeLessThanOrEqual(1);
    }
    expect(cv.massDriftPct).toBeLessThan(1);
  });

  it('hits the mass (±2 %), axle split, wheelbase, track, 0.39 m tyres on 12 rays', () => {
    expect(cv.totalMass).toBeGreaterThan(PICKUP_TARGETS.totalMass * 0.98);
    expect(cv.totalMass).toBeLessThan(PICKUP_TARGETS.totalMass * 1.02);
    expect(PICKUP_DESIGN.frontAxleShare).toBeCloseTo(PICKUP_TARGETS.frontAxleShare, 2);
    const r = cv.rig;
    const z = (w: number): number => (r.nodePos[3 * cv.wheels[w]!.hubI + 2]! + r.nodePos[3 * cv.wheels[w]!.hubO + 2]!) / 2;
    expect(z(2) - z(0)).toBeCloseTo(PICKUP_TARGETS.wheelbase, 6);
    for (const w of cv.wheels) {
      const cx = (r.nodePos[3 * w.hubI]! + r.nodePos[3 * w.hubO]!) / 2;
      expect(Math.abs(cx)).toBeCloseTo(PICKUP_TARGETS.track / 2, 6);
      expect(w.radius).toBe(0.39);
      expect(w.rays).toBe(12);
    }
    // A real pickup's CG: 0.6–0.75 m at rest (base masses, not solved).
    expect(PICKUP_DESIGN.cg[1]).toBeGreaterThan(0.6);
    expect(PICKUP_DESIGN.cg[1]).toBeLessThan(0.75);
  });

  it('body-on-frame: frame, clip, cab and bed are separate sub-structures joined only by mount beams', () => {
    const part = (id: string): string | null => {
      const m = /^(f|s|c|b)\d+_/.exec(id);
      return m ? m[1]! : null;
    };
    const mounts = new Set([...PICKUP_DESIGN.cabMounts, ...PICKUP_DESIGN.bedMounts].map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
    expect(PICKUP_DESIGN.cabMounts.length).toBeGreaterThanOrEqual(12);
    expect(PICKUP_DESIGN.bedMounts.length).toBeGreaterThanOrEqual(12);
    for (const b of PICKUP.body.beams) {
      const pa = part(b.a);
      const pb = part(b.b);
      if (pa === null || pb === null || pa === pb) continue;
      const key = b.a < b.b ? `${b.a}|${b.b}` : `${b.b}|${b.a}`;
      if ((pa === 'c' && pb === 'f') || (pa === 'f' && pb === 'c') || (pa === 'b' && pb === 'f') || (pa === 'f' && pb === 'b')) {
        // Cab / bed ↔ frame: only the declared mounts (all breakable).
        expect(mounts.has(key), key).toBe(true);
        expect(Number.isFinite(b.breakF ?? Infinity) && (b.breakF ?? 0) > 0, key).toBe(true);
      }
      // The cab and the bed never touch each other.
      expect((pa === 'c' && pb === 'b') || (pa === 'b' && pb === 'c'), key).toBe(false);
    }
  });

  it('has a hood sub-rig (12 nodes) and a tailgate sub-rig (12 nodes) after the structure, hinged and latched', () => {
    const ids = PICKUP.body.nodes.map((n) => n.id);
    expect(ids.filter((id) => id.startsWith('hood_')).length).toBe(12);
    expect(ids.filter((id) => id.startsWith('tg_')).length).toBe(12);
    const firstSub = PICKUP.body.beams.findIndex((b) => /^(hood|tg)_/.test(b.a) || /^(hood|tg)_/.test(b.b));
    expect(PICKUP.body.beams.slice(firstSub).every((b) => /^(hood|tg)_/.test(b.a) || /^(hood|tg)_/.test(b.b))).toBe(true);
    const beam = (a: string, b: string) => PICKUP.body.beams.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    expect(beam('hood_0C', 's0_rt')!.breakF).toBeLessThan(1e4); // latch
    for (const [a, b] of PICKUP_DESIGN.tailgateHinges) expect(beam(a, b)!.breakF).toBeGreaterThanOrEqual(2e4);
    for (const [a, b] of PICKUP_DESIGN.tailgateLatches) expect(beam(a, b)!.breakF).toBeLessThan(2e4);
  });

  it('ground clearance ≥ 0.22 m and a live rear axle (one rigid housing, both hubs on it)', () => {
    let low = Infinity;
    let lowId = '';
    for (const n of PICKUP.body.nodes) {
      const r = n.radius ?? PICKUP.body.groupDefaults?.[n.group ?? '']?.radius ?? 0.05;
      if (n.pos[1] - r < low) [low, lowId] = [n.pos[1] - r, n.id];
    }
    // Rest pose; the truck settles ≈ 7 cm (asserted below), still well clear.
    expect(low - 0.08, lowId).toBeGreaterThanOrEqual(PICKUP_TARGETS.minGroundClearance);
    const beam = (a: string, b: string) => PICKUP.body.beams.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    expect(beam('RL_kU', 'RR_kU')).toBeDefined();
    expect(beam('RL.hubI', 'axD')).toBeDefined();
    expect(beam('RR.hubI', 'axD')).toBeDefined();
  });

  it('carries the V8 / 6-speed / RWD LSD spec (295 kW, 550 N·m)', () => {
    const d = cv.drivetrain;
    let peak = 0;
    let pmax = 0;
    for (let i = 0; i < d.torqueLut.length; i++) {
      peak = Math.max(peak, d.torqueLut[i]!);
      pmax = Math.max(pmax, (d.torqueLut[i]! * i * d.lutStepRpm * Math.PI) / 30);
    }
    expect(peak).toBeCloseTo(PICKUP_TARGETS.torqueNm, 6);
    expect(Math.abs(pmax / 1000 - PICKUP_TARGETS.powerKw) / PICKUP_TARGETS.powerKw).toBeLessThan(0.03);
    expect(d.gearRatioTable.length - 2).toBe(6);
    expect(d.diff).toBe(2); // limited
    expect(Array.from(d.drivenWheels)).toEqual([2, 3]);
    expect(PICKUP.drivetrain.tractionControl).toBeGreaterThan(0);
  });

  it('round-trips through JSON and compiles identically', () => {
    const copy = JSON.parse(JSON.stringify(PICKUP)) as VehicleDef;
    expect(copy).toEqual(PICKUP);
    expect(compileVehicle(copy)).toEqual(cv);
  });
});

// ====================================================================== handling
let st: StaticResult;
let load: StaticResult;
let launch: LaunchResult;
let coast: CoastResult;
let brake: BrakeResult;
let circle: CircleResult;
let step: StepSteerResult;
let top: TopSpeedResult;
let hardDrivingDamage = -1;
const TOP = { lowKmh: 175, highKmh: 200, straightFromKmh: 170 } as const;

/** 300 kg spread over the bed floor nodes. */
function bedLoaded(): VehicleDef {
  const d = structuredClone(PICKUP);
  const floor = d.body.nodes.filter((n) => /^b[0-3]_(fc|fl)/.test(n.id));
  for (const n of floor) n.mass += 300 / floor.length;
  return d;
}

/** Full throttle 3 s in auto, then full brake to a stop: count plastically deformed / broken beams. */
function hardDriving(): number {
  const sim = createHandlingSim({ def: PICKUP });
  const s = sim.eng.state;
  stepN(sim, 3000);
  sim.eng.setInput(1, { gearSelect: 1, throttle: 1 });
  stepN(sim, 6000);
  sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
  stepN(sim, 6000);
  let n = 0;
  for (let b = sim.obj.beamStart; b < sim.obj.beamStart + sim.obj.beamCount; b++) {
    if (s.type[b] === 3) continue;
    if (s.active[b] === 0 || Math.abs(s.restLen[b]! - s.restLen0[b]!) > 1e-4 * s.restLen0[b]!) n++;
  }
  return n;
}

// ====================================================================== crash
/**
 * The crash harness reports no per-beam state, so the mount check re-runs its frontal set-up
 * (plane, 0.5 s settle, rigid concrete wall 3 cm ahead, rolling release, 2 s) and counts the
 * broken cab / bed mount beams and front-bumper straps.
 */
function mountsBrokenInFrontal(kmh: number): { cab: number; bed: number; straps: number } {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  const obj = eng.spawnVehicle(1, PICKUP, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  const veh = eng.getVehicle(1)!;
  const s = eng.state;
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  let minZ = Infinity;
  for (let i = 0; i < cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[obj.nodeStart + i]! - s.radius[obj.nodeStart + i]!);
  eng.setExtraColliders([{ id: 'wall', kind: 'box', pos: [0, 1.5, minZ - 0.63], quat: [0, 0, 0, 1], size: [6, 1.5, 0.6], material: MaterialId.concrete }]);
  setMotion({ eng, obj, veh, cv: veh.vehicle, objectId: 1 }, kmh / 3.6, 0);
  for (let t = 0; t < 2.2 * SIM_HZ; t++) eng.step();
  const ids = cv.rig.nodeIds;
  const count = (list: readonly (readonly [string, string])[]): number => {
    let n = 0;
    for (const [a, b] of list) {
      for (let k = 0; k < cv.bodyBeamCount; k++) {
        const x = ids[cv.rig.beamA[k]!];
        const y = ids[cv.rig.beamB[k]!];
        if (((x === a && y === b) || (x === b && y === a)) && s.active[obj.beamStart + k] === 0) n++;
      }
    }
    return n;
  };
  return { cab: count(PICKUP_DESIGN.cabMounts), bed: count(PICKUP_DESIGN.bedMounts), straps: count(PICKUP_DESIGN.bumperStraps) };
}

let f50: CrashResult;
let f30: CrashResult;
let f10: CrashResult;
let pole: CrashResult;
let offset: CrashResult;
let f100: CrashResult;
let f50Mounts = { cab: -1, bed: -1, straps: -1 };
let f85Mounts = { cab: -1, bed: -1, straps: -1 };

beforeAll(() => {
  st = runStatic(PICKUP);
  load = runStatic(bedLoaded());
  launch = runLaunch(PICKUP, { durationS: 14 });
  coast = runCoastdown(PICKUP);
  brake = runBraking(PICKUP);
  circle = runCircle(PICKUP);
  step = runStepSteer(PICKUP);
  top = runTopSpeed(PICKUP, TOP);
  hardDrivingDamage = hardDriving();
  const probes = PICKUP_CRASH_PROBES as unknown as Parameters<typeof runCrash>[0]['probes'];
  f50 = runCrash({ kind: 'frontal', speedKmh: 50, def: PICKUP, probes });
  f30 = runCrash({ kind: 'frontal', speedKmh: 30, def: PICKUP, probes });
  f10 = runCrash({ kind: 'frontal', speedKmh: 10, def: PICKUP, probes });
  pole = runCrash({ kind: 'pole', speedKmh: 30, def: PICKUP, probes });
  offset = runCrash({ kind: 'offset', speedKmh: 64, overlap: 0.4, def: PICKUP, probes });
  f100 = runCrash({ kind: 'frontal', speedKmh: 100, def: PICKUP, probes });
  f50Mounts = mountsBrokenInFrontal(50);
  f85Mounts = mountsBrokenInFrontal(85);
}, 600_000);

afterAll(() => {
  if (!st) return;
  const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  const rows: [string, string, string][] = [
    ['static sag (m)', f(st.sag, 3), '0.03–0.08'],
    ['static creep (mm/s) / jitter (m/s)', `${f(st.creep * 1000, 3)} / ${f(st.jitter, 3)}`, '< 1 / < 0.15'],
    ['300 kg in the bed: sag (m)', f(load.sag, 3), '≤ 0.12'],
    ['0–100 km/h (s) / heading drift (deg)', `${f(launch.t100)} / ${f(launch.headingDrift100)}`, '6.5–8.0 / ≤ 3'],
    ['coastdown decel (m/s²)', f(coast.decel5, 3), ''],
    ['braking 100→0 (m) / drift (deg)', `${f(brake.distance, 1)} / ${f(brake.headingDrift)}`, '≤ 42 / < 5'],
    ['circle R40 max lateral (g)', f(circle.maxLatG), '0.75–0.92'],
    ['step steer 0.12 @ 60: overshoot / std / spun', `${f(step.overshoot)} / ${f(step.yawStd, 4)} / ${step.spun}`, '≤ 1.5 / < 0.03 / false'],
    ['WOT accel @175 / @200 km/h (m/s²)', `${f(top.accel200)} / ${f(top.accel210)}`, '> 0 / ≤ 0 (limiter)'],
    ['170 km/h WOT straight: max yaw / drift', `${f(top.maxYawRate, 3)} / ${f(top.headingDrift)}`, '< 0.05 / < 3'],
    ['hard driving: deformed beams', String(hardDrivingDamage), '0'],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  console.log('\nPICKUP handling report\n' + rows.map(([a, b, c]) => `  ${a.padEnd(w0)}  ${b.padStart(w1)}  ${c}`).join('\n'));
  const all = [f50, f30, f10, pole, offset, f100].filter(Boolean);
  if (all.length > 0) console.log('\nPICKUP crash report\n' + all.map((r) => '  ' + formatCrash(r)).join('\n') + `\n  50 km/h mounts broken: cab ${f50Mounts.cab}, bed ${f50Mounts.bed}`);
});

describe('PICKUP handling harness (fleet targets)', () => {
  it('static: sag 3–8 cm, no creep, no jitter; 300 kg in the bed sags ≤ 12 cm', () => {
    expect(st.sag).toBeGreaterThan(0.03);
    expect(st.sag).toBeLessThan(0.08);
    expect(st.creep).toBeLessThan(1e-3);
    expect(st.jitter).toBeLessThan(0.15);
    expect(load.sag).toBeLessThanOrEqual(0.12);
  });

  it('launch: 0–100 km/h 6.5–8.0 s with TC, straight (drift ≤ 3°)', () => {
    expect(launch.t100).toBeGreaterThanOrEqual(6.5);
    expect(launch.t100).toBeLessThanOrEqual(8.0);
    expect(launch.headingDrift100).toBeLessThanOrEqual(3);
  });

  it('coastdown and braking: 100–0 ≤ 42 m, straight', () => {
    expect(coast.decel5).toBeGreaterThan(0.25);
    expect(coast.decel5).toBeLessThan(0.7);
    expect(brake.distance).toBeLessThanOrEqual(42);
    expect(brake.headingDrift).toBeLessThan(5);
  });

  it('R40 circle 0.75–0.92 g; step steer 0.12 at 60 km/h: no spin, overshoot ≤ 1.5', () => {
    expect(circle.maxLatG).toBeGreaterThanOrEqual(0.75);
    expect(circle.maxLatG).toBeLessThanOrEqual(0.92);
    expect(step.spun).toBe(false);
    expect(step.yawSteady).toBeGreaterThan(0.05);
    expect(step.overshoot).toBeLessThanOrEqual(1.5);
    expect(step.yawStd).toBeLessThan(0.03);
  });

  it('top speed: still accelerating at 175 km/h, at the limiter by 200 km/h; a 170 km/h WOT straight stays straight', () => {
    expect(top.accel200).toBeGreaterThan(0);
    expect(top.accel210).toBeLessThanOrEqual(0);
    expect(top.maxYawRate).toBeLessThan(0.05);
    expect(top.headingDrift).toBeLessThan(3);
  });

  it('hard driving (full-throttle launch, full brake) leaves no plastic damage', () => {
    expect(hardDrivingDamage).toBe(0);
  });
});

/** "No explosion" (CONTRACTS crash targets). */
function expectNoExplosion(r: CrashResult): void {
  expect(r.finite).toBe(true);
  expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
  expect(r.keRatio).toBeLessThan(0.05);
  expect(r.maxSpan).toBeLessThan(3);
}

describe('PICKUP crash harness (fleet targets)', () => {
  it('50 km/h frontal: crush 30–55 cm, intrusion < 8 cm, spring-back ≤ 25 %, rebound 5–15 % of the impact speed, stable, wheels on, bed stays on', () => {
    expect(f50.crush).toBeGreaterThanOrEqual(0.3);
    expect(f50.crush).toBeLessThanOrEqual(0.55);
    expect(f50.crushMax).toBeLessThanOrEqual(0.7);
    expect(f50.springback).toBeLessThanOrEqual(0.25);
    expect(f50.intrusion).toBeLessThan(0.08);
    // R-CRASH: real cars rebound 5–15 % of the barrier speed (the old 1–4 m/s = 7–29 %).
    expect(f50.rebound / f50.initialSpeed).toBeGreaterThanOrEqual(0.05);
    expect(f50.rebound / f50.initialSpeed).toBeLessThanOrEqual(0.15);
    expectNoExplosion(f50);
    expect(f50.wheelsDetached).toBe(0);
    expect(f50Mounts.bed).toBeGreaterThanOrEqual(0);
    expect(f50Mounts.bed).toBeLessThan(0.5 * PICKUP_DESIGN.bedMounts.length);
  });

  it('30 km/h frontal: crush 12–28 cm, spring-back ≤ 25 %, intrusion < 3 cm, wheels on', () => {
    expect(f30.crush).toBeGreaterThanOrEqual(0.12);
    expect(f30.crush).toBeLessThanOrEqual(0.28);
    expect(f30.springback).toBeLessThanOrEqual(0.25);
    expect(f30.intrusion).toBeLessThan(0.03);
    expect(f30.wheelsDetached).toBe(0);
    expect(f30.bumperBrokenFraction).toBeLessThan(0.5);
  });

  it('10 km/h frontal: permanent crush ≤ 3 cm, no broken beams, ≤ 5 % plastic', () => {
    expect(f10.crush).toBeLessThanOrEqual(0.03);
    expect(f10.brokenBeams).toBe(0);
    expect(f10.plasticFraction).toBeLessThanOrEqual(0.05);
  });

  it('30 km/h side pole: door intrusion 20–35 cm, nothing pulled through the pole', () => {
    expect(pole.doorIntrusion).toBeGreaterThanOrEqual(0.2);
    expect(pole.doorIntrusion).toBeLessThanOrEqual(0.35);
    expect(pole.poleSideKept).toBe(true);
    expect(pole.finite).toBe(true);
  });

  it('64 km/h 40 % offset: cabin intrusion < 15 cm', () => {
    expect(offset.intrusion).toBeLessThan(0.15);
    expect(offset.finite).toBe(true);
  });

  it('front bumper: stays on (bent) at 50 km/h, tears off at 85 and 100 km/h', () => {
    // Every strap holding the bar must shear for it to come away; at 50 km/h none may.
    const n = PICKUP_DESIGN.bumperStraps.length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(f50Mounts.straps).toBe(0);
    expect(f30.bumperBrokenFraction).toBe(0);
    expect(f85Mounts.straps).toBe(n);
    expect(f100.bumperBrokenFraction).toBeGreaterThan(0);
  });

  it('100 km/h frontal: stable, hood latch broken, windscreen shattered', () => {
    expectNoExplosion(f100);
    expect(f100.latchBroken).toBe(true);
    expect(f100.windscreenBrokenFraction).toBeGreaterThanOrEqual(0.5);
  });
});
