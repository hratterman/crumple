import { describe, expect, it } from 'vitest';
import { compileRig, computeStabilityReport, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import type { RigBeamDef, RigNodeDef } from '../rig/types';
import {
  buildVehicleRig,
  compileVehicle,
  PLAYER_BEAM_BUDGET,
  sampleTorqueCurve,
  TRAFFIC_BEAM_BUDGET,
  TREAD_OMEGA_DT_LIMIT,
  validateVehicle,
  VehicleCompileError,
} from './builder';
import { buildTorqueLut } from './drivetrain';
import { DIFF_TYPE_ID, WHEEL_BEAMS_PER_RAY, WHEEL_CORNER, WHEEL_DEFAULTS, wheelNodeId, type VehicleDef, type WheelDef } from './types';
import { WHEEL_TUNING_205_55R16 } from './wheelrig';

/** 8-node box chassis (heavy nodes, soft beams: stable) + 4 wheels bolted to its bottom corners. */
function testCar(): VehicleDef {
  const nodes: RigNodeDef[] = [];
  const P: Record<string, [number, number, number]> = {};
  for (const x of [-0.7, 0.7])
    for (const y of [0.3, 0.9])
      for (const z of [-1.4, 1.4]) {
        const id = `${x < 0 ? 'L' : 'R'}${y < 0.5 ? 'lo' : 'hi'}${z < 0 ? 'F' : 'B'}`;
        P[id] = [x, y, z];
        nodes.push({ id, pos: [x, y, z], mass: 150 });
      }
  const ids = Object.keys(P);
  const beams: RigBeamDef[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) beams.push({ a: ids[i]!, b: ids[j]!, type: 'normal', k: 2e5, d: 500 });
  beams.push({ a: 'LloF', b: 'RloF', type: 'hydro', k: 1e5, d: 100, hydroTravel: 0.01 }); // duplicate pair is allowed
  const wheel = (id: 'FL' | 'FR' | 'RL' | 'RR'): WheelDef => {
    const left = id[1] === 'L';
    const front = id[0] === 'F';
    const s = left ? -1 : 1;
    const z = front ? -1.4 : 1.4;
    const lo = `${left ? 'L' : 'R'}lo${front ? 'F' : 'B'}`;
    const hi = `${left ? 'L' : 'R'}hi${front ? 'F' : 'B'}`;
    return {
      ...WHEEL_TUNING_205_55R16,
      id,
      hubInner: [0.72 * s, 0.32, z],
      hubOuter: [0.9 * s, 0.32, z],
      axle: front ? 'front' : 'rear',
      steered: front,
      driven: !front,
      braked: true,
      brakeTorqueMax: 2000,
      handbrake: !front,
      attach: [lo, hi],
    };
  };
  return {
    name: 'testCar',
    body: { name: 'testCar.body', nodes, beams },
    wheels: [wheel('FL'), wheel('FR'), wheel('RL'), wheel('RR')],
    drivetrain: {
      torqueCurve: [
        [1000, 100],
        [4000, 200],
        [6000, 150],
      ],
      idleRpm: 900,
      redlineRpm: 6000,
      revLimitRpm: 6200,
      engineInertia: 0.2,
      engineBrakeTorque: 40,
      gearRatios: [3, 2, 1],
      reverseRatio: 3.2,
      finalDrive: 4,
      shiftTimeS: 0.2,
      autoShiftUpRpm: 5500,
      autoShiftDownRpm: 2000,
      diff: 'limited',
      diffLockTorque: 300,
      clutchMaxTorque: 400,
    },
    brakes: { frontBias: 0.65, handbrakeTorqueMax: 1200 },
    aero: { dragCoeffArea: 0.7, liftCoeffArea: 0 },
    steering: { maxWheelAngleDeg: 30 },
    frame: { origin: 'LloF', front: 'RloF', top: 'LhiF' },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('buildVehicleRig', () => {
  it('merges body first, then each wheel in declaration order (canonical order)', () => {
    const def = testCar();
    const merged = buildVehicleRig(def);
    const n = def.wheels[0]!.rays;
    expect(merged.nodes.length).toBe(def.body.nodes.length + 4 * (2 + 4 * n));
    expect(merged.nodes.slice(0, def.body.nodes.length).map((x) => x.id)).toEqual(def.body.nodes.map((x) => x.id));
    expect(merged.beams.slice(0, def.body.beams.length)).toEqual(def.body.beams);
    let at = def.body.nodes.length;
    for (const w of def.wheels) {
      const want = [
        wheelNodeId(w.id, 'hubI'),
        wheelNodeId(w.id, 'hubO'),
        ...[...Array(n).keys()].map((k) => wheelNodeId(w.id, 'rimI', k)),
        ...[...Array(n).keys()].map((k) => wheelNodeId(w.id, 'rimO', k)),
        ...[...Array(n).keys()].map((k) => wheelNodeId(w.id, 'tireI', k)),
        ...[...Array(n).keys()].map((k) => wheelNodeId(w.id, 'tireO', k)),
      ];
      expect(merged.nodes.slice(at, at + want.length).map((x) => x.id)).toEqual(want);
      at += want.length;
    }
    // Attach beams lead each wheel's beam block.
    const b0 = def.body.beams.length;
    expect(merged.beams[b0]).toMatchObject({ a: 'FL.hubI', b: 'LloF' });
    expect(merged.beams[b0 + 1]).toMatchObject({ a: 'FL.hubO', b: 'LloF' });
    expect(merged.beams[b0 + 4]).toMatchObject({ a: 'FL.hubI', b: 'FL.hubO' });
  });

  it('does not alias or mutate the input', () => {
    const def = testCar();
    const snapshot = clone(def);
    const merged = buildVehicleRig(def);
    merged.nodes[0]!.pos[0] = 99;
    merged.nodes[0]!.mass = 1;
    merged.beams[0]!.k = 1;
    expect(def).toEqual(snapshot);
  });

  it('lets body beams reference generated wheel nodes', () => {
    const def = testCar();
    def.body.beams.push({ a: 'FL.hubI', b: 'LloB', type: 'normal', k: 1e4 });
    expect(() => compileRig(buildVehicleRig(def))).not.toThrow();
  });

  it('rejects duplicate wheel ids and unknown attach ids with VehicleCompileError', () => {
    const dup = testCar();
    dup.wheels[1]!.id = 'FL';
    expect(() => buildVehicleRig(dup)).toThrow(VehicleCompileError);
    const bad = testCar();
    bad.wheels[0]!.attach = ['nope'];
    expect(() => buildVehicleRig(bad)).toThrow(VehicleCompileError);
  });
});

describe('compileVehicle', () => {
  it('builds wheel ranges, corners, spin signs, hub links and biased brakes', () => {
    const def = testCar();
    const cv = compileVehicle(def);
    const n = def.wheels[0]!.rays;
    expect(cv.bodyNodeCount).toBe(8);
    expect(cv.bodyBeamCount).toBe(def.body.beams.length);
    expect(cv.rig.nodeCount).toBe(8 + 4 * (2 + 4 * n));
    let nodeStart = 8;
    let beamStart = def.body.beams.length;
    for (const [i, w] of cv.wheels.entries()) {
      expect(w.index).toBe(i);
      expect(w.nodeStart).toBe(nodeStart);
      expect(w.nodeCount).toBe(2 + 4 * n);
      expect(cv.rig.nodeIds[w.hubI]).toBe(`${w.id}.hubI`);
      expect(cv.rig.nodeIds[w.hubO]).toBe(`${w.id}.hubO`);
      expect(cv.rig.nodeIds[w.rimStart + 3]).toBe(`${w.id}.rimI3`);
      expect(cv.rig.nodeIds[w.rimStart + n + 3]).toBe(`${w.id}.rimO3`);
      expect(cv.rig.nodeIds[w.tireStart + 5]).toBe(`${w.id}.tireI5`);
      expect(cv.rig.nodeIds[w.tireStart + n + 5]).toBe(`${w.id}.tireO5`);
      expect(w.beamStart).toBe(beamStart);
      expect(w.beamCount).toBe(2 * 2 + 1 + WHEEL_BEAMS_PER_RAY * n);
      expect(w.tireRingRadius).toBeCloseTo(0.32 - WHEEL_TUNING_205_55R16.tireNodeRadius, 12);
      // Hub links: the 4 attach beams, ascending.
      expect(Array.from(w.hubLinkBeams)).toEqual([beamStart, beamStart + 1, beamStart + 2, beamStart + 3]);
      nodeStart += w.nodeCount;
      beamStart += w.beamCount;
    }
    expect(beamStart).toBe(cv.rig.beamCount);
    expect(cv.wheels.map((w) => w.corner)).toEqual([WHEEL_CORNER.FL, WHEEL_CORNER.FR, WHEEL_CORNER.RL, WHEEL_CORNER.RR]);
    // Left wheels: hubO − hubI points −X (vehicle left) → +1.
    expect(cv.wheels.map((w) => w.spinSign)).toEqual([1, -1, 1, -1]);
    // 65/35 bias: front reaches brakeTorqueMax, rear 2000·0.35/0.65.
    expect(cv.wheels[0]!.brakeTorque).toBeCloseTo(2000, 9);
    expect(cv.wheels[2]!.brakeTorque).toBeCloseTo((2000 * 0.35) / 0.65, 9);
    expect(cv.wheels.map((w) => w.handbrakeTorque)).toEqual([0, 0, 1200, 1200]);
    expect(Array.from(cv.frameNodes)).toEqual(['LloF', 'RloF', 'LhiF'].map((id) => cv.rig.nodeIds.indexOf(id)));
  });

  it('counts body beams touching the hubs as hub links', () => {
    const def = testCar();
    def.body.beams.push({ a: 'LloB', b: 'FL.hubO', type: 'normal', k: 1e4 });
    const cv = compileVehicle(def);
    const links = Array.from(cv.wheels[0]!.hubLinkBeams);
    expect(links).toContain(def.body.beams.length - 1);
    expect(links).toEqual([...links].sort((a, b) => a - b));
  });

  it('builds the drivetrain tables', () => {
    const def = testCar();
    const cv = compileVehicle(def);
    const d = cv.drivetrain;
    expect(Array.from(d.gearRatioTable)).toEqual([-3.2, 0, 3, 2, 1]);
    expect(d.gearCount).toBe(3);
    expect(Array.from(d.drivenWheels)).toEqual([2, 3]);
    expect(d.diff).toBe(DIFF_TYPE_ID.limited);
    expect(d.diffLockTorque).toBe(300);
    expect(d.transmission).toBe('auto');
    expect(d.lutStepRpm).toBe(50);
    expect(d.torqueLut[0]).toBe(100); // clamped below the first point
    expect(d.torqueLut[4000 / 50]).toBeCloseTo(200, 12);
    expect(d.torqueLut[2500 / 50]).toBeCloseTo(150, 12);
    expect(d.torqueLut[d.torqueLut.length - 1]).toBe(150);
    // Same sampling rule as the worker drivetrain.
    expect(Array.from(sampleTorqueCurve(def.drivetrain.torqueCurve))).toEqual(Array.from(buildTorqueLut(def.drivetrain.torqueCurve)));
  });

  it('applies MINIMASS (raise only) and reports the drift', () => {
    const def = testCar();
    def.body.nodes[0]!.mass = 0.5; // 7 beams of 2e5 + hydro + attach: far above ω·dt 0.35
    const cv = compileVehicle(def);
    expect(cv.rig.nodeMass[0]).toBeGreaterThan(0.5);
    expect(cv.massDriftPct).toBeGreaterThan(0);
    const rep = computeStabilityReport(cv.rig, { limit: STRUCTURE_OMEGA_DT_LIMIT });
    // Tread nodes may run up to TREAD_OMEGA_DT_LIMIT, everything else 0.35.
    for (let i = 0; i < cv.rig.nodeCount; i++) {
      const tread = cv.rig.groups[cv.rig.nodeGroup[i]!] === WHEEL_DEFAULTS.tireGroup;
      expect(rep.omegaDt[i]).toBeLessThanOrEqual((tread ? TREAD_OMEGA_DT_LIMIT : STRUCTURE_OMEGA_DT_LIMIT) * (1 + 1e-9));
    }
    let total = 0;
    for (let i = 0; i < cv.rig.nodeCount; i++) total += cv.rig.nodeMass[i]!;
    expect(cv.totalMass).toBeCloseTo(total, 9);
    for (let i = 0; i < 8; i++) expect(cv.rig.nodeMass[i]).toBeGreaterThanOrEqual(def.body.nodes[i]!.mass);
  });

  it('is deterministic and structured-cloneable', () => {
    const a = compileVehicle(testCar());
    const b = compileVehicle(testCar());
    expect(b).toEqual(a);
    expect(structuredClone(a)).toEqual(a);
  });

  it('throws VehicleCompileError for malformed definitions', () => {
    const noFrame = testCar();
    noFrame.frame.top = 'missing';
    expect(() => compileVehicle(noFrame)).toThrow(VehicleCompileError);
    const badCurve = testCar();
    badCurve.drivetrain.torqueCurve = [[1000, 100]];
    expect(() => compileVehicle(badCurve)).toThrow(VehicleCompileError);
    const badRays = testCar();
    badRays.wheels[0]!.rays = 11;
    expect(() => compileVehicle(badRays)).toThrow(VehicleCompileError);
    const badBeam = testCar();
    badBeam.body.beams.push({ a: 'LloF', b: 'ghost', type: 'normal' });
    expect(() => compileVehicle(badBeam)).toThrow(VehicleCompileError);
  });
});

describe('validateVehicle', () => {
  it('passes a well-formed vehicle', () => {
    const r = validateVehicle(testCar());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.beamBudget).toBe(PLAYER_BEAM_BUDGET);
    expect(r.islands).toBe(1);
    expect(r.stability.ok).toBe(true);
    expect(r.stats.nodeCount).toBe(8 + 4 * 50);
  });

  it('hard-fails over the beam budget', () => {
    const r = validateVehicle(testCar(), TRAFFIC_BEAM_BUDGET / 2);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/beam budget/);
  });

  it('hard-fails disconnected node islands', () => {
    const def = testCar();
    def.body.nodes.push({ id: 'stray1', pos: [0, 2, 0], mass: 10 }, { id: 'stray2', pos: [0, 2.5, 0], mass: 10 });
    def.body.beams.push({ a: 'stray1', b: 'stray2', type: 'normal', k: 1e4 });
    const r = validateVehicle(def);
    expect(r.ok).toBe(false);
    expect(r.islands).toBe(2);
    expect(r.errors.join()).toMatch(/disconnected.*stray1/);
  });

  it('hard-fails a wheel that is not attached', () => {
    const def = testCar();
    def.wheels[3]!.attach = [];
    const r = validateVehicle(def);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/wheel "RR" is not attached/);
  });

  it('hard-fails pinned nodes', () => {
    const def = testCar();
    def.body.nodes[7]!.mass = 0;
    expect(validateVehicle(def).errors.join()).toMatch(/pinned/);
  });

  it('judges declared masses: ω·dt > 0.5 errors, > 0.35 warns', () => {
    const hard = testCar();
    hard.body.nodes[0]!.mass = 0.5;
    const rh = validateVehicle(hard);
    expect(rh.ok).toBe(false);
    expect(rh.errors.join()).toMatch(/exceed ω·dt 0\.5.*LloF/);
    expect(rh.stability.ok).toBe(true); // post-MINIMASS report is what the sim runs

    // Σk at LloF ≈ 7·2e5 + 1e5 + 2·rimSpring: pick m so 0.35 < ω·dt < 0.5.
    const soft = testCar();
    const rig = compileRig(buildVehicleRig(soft));
    const sumK = computeStabilityReport(rig).omegaDt[0]! ** 2 * 4e6 * 150;
    soft.body.nodes[0]!.mass = sumK / (0.42 * 2000) ** 2;
    const rs = validateVehicle(soft);
    expect(rs.errors).toEqual([]);
    expect(rs.warnings.join()).toMatch(/structure ω·dt 0\.35.*LloF/);
  });

  it('autoRaiseMasses turns ω violations into a drift report', () => {
    const def = testCar();
    def.body.nodes[0]!.mass = 0.5;
    const r = validateVehicle(def, PLAYER_BEAM_BUDGET, { autoRaiseMasses: true });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.massDriftPct).toBeGreaterThan(0);
    expect(r.warnings.join()).toMatch(/MINIMASS raised/);
  });

  it('never throws: malformed input becomes errors', () => {
    const def = testCar();
    def.wheels[0]!.attach = ['ghost'];
    const r = validateVehicle(def);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/ghost/);
    const r2 = validateVehicle({ ...testCar(), frame: { origin: 'x', front: 'y', top: 'z' } });
    expect(r2.ok).toBe(false);
    expect(r2.errors.join()).toMatch(/frame\.origin/);
  });

  it('warns about steered wheels without steering hydros', () => {
    const def = testCar();
    def.body.beams = def.body.beams.filter((b) => b.type !== 'hydro');
    expect(validateVehicle(def).warnings.join()).toMatch(/no hydro/);
  });
});
