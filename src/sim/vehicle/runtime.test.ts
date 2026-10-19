/**
 * Vehicle runtime + engine/worker integration. Uses a tiny self-contained
 * test car (8-node braced box + 4 generated wheels) compiled by the sibling
 * builder; the sedan-based determinism test is skipped (with a message)
 * until src/sim/vehicle/defs/sedan.ts exists.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BufferPool, SnapshotReader, SnapshotWriter } from '../../protocol/codec';
import { computeSnapshotLayout, TELEMETRY_SLOTS } from '../../protocol/layout';
import type { MainToWorker, Transform, WorkerToMain } from '../../protocol/messages';
import { VehicleTelemetry } from '../../protocol/telemetry';
import type { RigBeamDef, RigNodeDef } from '../rig/types';
import type { SimState } from '../types';
import type { VehicleDef, WheelDef } from './types';

const SIBLINGS = ['./builder.ts', './wheelrig.ts', './wheels.ts'];
const present = import.meta.glob(['./builder.ts', './wheelrig.ts', './wheels.ts', './defs/sedan.ts']);
const missing = SIBLINGS.filter((p) => !(p in present));
const hasSedan = './defs/sedan.ts' in present;
if (missing.length > 0) console.warn(`[runtime.test] SKIPPED: sibling modules not present yet: ${missing.join(', ')}`);
if (!hasSedan) console.warn('[runtime.test] sedan determinism SKIPPED: src/sim/vehicle/defs/sedan.ts not present yet');

type EngineMod = typeof import('../engine');
type RuntimeMod = typeof import('./runtime');
type BuilderMod = typeof import('./builder');
type WorkerMod = typeof import('../worker');
type WheelRigMod = typeof import('./wheelrig');
let E: EngineMod;
let RT: RuntimeMod;
let B: BuilderMod;
let W: WorkerMod;
let WR: WheelRigMod;

const CAP = { maxObjects: 8, nodeCapacity: 4096, beamCapacity: 16384 };
const at = (x: number, y: number, z: number): Transform => ({ pos: [x, y, z], quat: [0, 0, 0, 1] });

/** 8-node braced box, forward −Z, 4 wheels attached to body corners. */
function testCar(weak = false): VehicleDef {
  const xs = [-0.7, 0.7];
  const ys = [0.25, 0.75];
  const zs = [-1.4, 1.4];
  const nodes: RigNodeDef[] = [];
  for (const y of ys) {
    for (const z of zs) {
      for (const x of xs) {
        const id = `${y < 0.5 ? 'b' : 't'}${z < 0 ? 'f' : 'r'}${x < 0 ? 'l' : 'r'}`;
        nodes.push({ id, pos: [x, y, z], mass: 110, friction: 0.5, radius: 0.05 });
      }
    }
  }
  const beams: RigBeamDef[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) beams.push({
        a: nodes[i]!.id,
        b: nodes[j]!.id,
        type: 'normal',
        k: 2e6,
        d: 2000,
        ...(weak ? { deform: 3e3, breakF: 1.5e4 } : {}),
      });
  }
  const R = 0.32;
  const wheel = (id: string, x: number, z: number, axle: 'front' | 'rear', attach: string[]): WheelDef => ({
    ...WR.WHEEL_TUNING_205_55R16,
    id,
    hubInner: [x, R, z],
    hubOuter: [x + (x < 0 ? -0.18 : 0.18), R, z],
    axle,
    steered: axle === 'front',
    driven: axle === 'rear',
    braked: true,
    brakeTorqueMax: axle === 'front' ? 1800 : 1200,
    handbrake: axle === 'rear',
    attach,
    attachSpring: 1.5e5,
    attachDamp: 800,
  });
  return {
    name: 'testcar',
    body: { name: 'testcar-body', nodes, beams },
    wheels: [
      wheel('FL', -0.75, -1.2, 'front', ['bfl', 'tfl', 'bfr', 'brl']),
      wheel('FR', 0.75, -1.2, 'front', ['bfr', 'tfr', 'bfl', 'brr']),
      wheel('RL', -0.75, 1.2, 'rear', ['brl', 'trl', 'brr', 'bfl']),
      wheel('RR', 0.75, 1.2, 'rear', ['brr', 'trr', 'brl', 'bfr']),
    ],
    drivetrain: {
      torqueCurve: [
        [0, 120],
        [1000, 180],
        [4000, 250],
        [6000, 220],
        [7000, 180],
      ],
      idleRpm: 800,
      redlineRpm: 6500,
      revLimitRpm: 6800,
      engineInertia: 0.2,
      engineBrakeTorque: 80,
      gearRatios: [3.5, 2.1, 1.4, 1.0, 0.8],
      reverseRatio: 3.3,
      finalDrive: 3.9,
      shiftTimeS: 0.25,
      autoShiftUpRpm: 6000,
      autoShiftDownRpm: 2500,
      diff: 'open',
      clutchMaxTorque: 450,
    },
    brakes: { frontBias: 0.65, handbrakeTorqueMax: 1500 },
    aero: { dragCoeffArea: 0.7, liftCoeffArea: 0 },
    steering: { maxWheelAngleDeg: 35 },
    frame: { origin: 'brl', front: 'bfl', top: 'trl' },
  };
}

function hashState(s: SimState): string {
  let h = 0x811c9dc5;
  for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.restLen, s.k, s.active, s.flags]) {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i]!, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function finite(s: SimState, start: number, count: number): boolean {
  for (let i = start; i < start + count; i++) {
    for (const v of [s.posX[i]!, s.posY[i]!, s.posZ[i]!, s.velX[i]!, s.velY[i]!, s.velZ[i]!]) if (!Number.isFinite(v)) return false;
  }
  return true;
}

describe.skipIf(missing.length > 0)('vehicle runtime', () => {
  beforeAll(async () => {
    E = await import('../engine');
    RT = await import('./runtime');
    B = await import('./builder');
    W = await import('../worker');
    WR = await import('./wheelrig');
  });

  function engineWithCar(y = 0.02): { eng: InstanceType<EngineMod['SimEngine']>; id: number } {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
    eng.setGroundPlane(0, 0);
    eng.spawnVehicle(5, testCar(), at(0, y, 0));
    return { eng, id: 5 };
  }

  it('createVehicleRuntime maps wheel ranges to global indices; rebase follows lower-id spawns', () => {
    const { eng } = engineWithCar();
    const v = eng.getVehicle(5)!;
    const obj = eng.arena.get(5)!;
    const cv = v.vehicle;
    expect(v.nodeStart).toBe(obj.nodeStart);
    expect(v.wheels).toHaveLength(4);
    expect(v.wheels[2]!.hubI).toBe(obj.nodeStart + cv.wheels[2]!.hubI);
    expect(v.wheels[2]!.tireStart).toBe(obj.nodeStart + cv.wheels[2]!.tireStart);
    expect(v.wheels[2]!.ringCount).toBe(2 * cv.wheels[2]!.rays);
    // A lower objectId spawns in front: everything shifts and is rebased.
    eng.spawn(1, {
      name: 'pt',
      nodes: [
        { id: 'a', pos: [0, 0, 0], mass: 1 },
        { id: 'b', pos: [0, 1, 0], mass: 1 },
      ],
      beams: [{ a: 'a', b: 'b', type: 'normal' }],
    }, at(10, 5, 10));
    const obj2 = eng.arena.get(5)!;
    expect(obj2.nodeStart).toBe(2);
    expect(v.nodeStart).toBe(2);
    expect(v.beamStart).toBe(obj2.beamStart);
    expect(v.wheels[3]!.hubO).toBe(2 + cv.wheels[3]!.hubO);
    for (let j = 0; j < cv.wheels[0]!.hubLinkBeams.length; j++) {
      expect(v.wheels[0]!.hubLinkBeams[j]).toBe(obj2.beamStart + cv.wheels[0]!.hubLinkBeams[j]!);
    }
    eng.despawn(1);
    expect(v.nodeStart).toBe(0);
    expect(v.wheels[3]!.hubO).toBe(cv.wheels[3]!.hubO);
  });

  it('settles on its wheels, then drives forward under throttle (auto box)', () => {
    const { eng, id } = engineWithCar();
    const v = eng.getVehicle(id)!;
    const obj = eng.arena.get(id)!;
    for (let t = 0; t < 2000; t++) eng.step();
    expect(finite(eng.state, obj.nodeStart, obj.nodeCount)).toBe(true);
    let tel = RT.writeVehicleTelemetry(eng.state, v);
    expect(tel[VehicleTelemetry.airborne]).toBe(0);
    expect(tel[VehicleTelemetry.wheelContact]).toBe(15);
    expect(Math.abs(tel[VehicleTelemetry.speed]!)).toBeLessThan(0.2);
    let load = 0;
    for (const w of v.wheels) load += w.load;
    expect(load).toBeGreaterThan(0.6 * v.vehicle.totalMass * 9.81);
    expect(load).toBeLessThan(1.4 * v.vehicle.totalMass * 9.81);

    eng.setInput(id, { throttle: 1, gearSelect: 1 });
    let maxRpm = 0;
    for (let t = 0; t < 6000; t++) {
      eng.step();
      maxRpm = Math.max(maxRpm, v.drivetrain.rpm);
    }
    expect(finite(eng.state, obj.nodeStart, obj.nodeCount)).toBe(true);
    tel = RT.writeVehicleTelemetry(eng.state, v);
    expect(tel[VehicleTelemetry.speed]).toBeGreaterThan(5);
    // Moved toward −Z (forward).
    expect(tel[VehicleTelemetry.comZ]).toBeLessThan(-3);
    expect(tel[VehicleTelemetry.gear]).toBeGreaterThanOrEqual(1);
    expect(maxRpm).toBeLessThan(6800 + 100);
    expect(v.drivetrain.rpm).toBeGreaterThan(700);
    expect(tel[VehicleTelemetry.wheelOmegaRL]).toBeGreaterThan(0);

    // Brake to a stop.
    eng.setInput(id, { throttle: 0, brake: 1 });
    for (let t = 0; t < 8000; t++) eng.step();
    tel = RT.writeVehicleTelemetry(eng.state, v);
    expect(Math.abs(tel[VehicleTelemetry.speed]!)).toBeLessThan(0.3);
    expect(finite(eng.state, obj.nodeStart, obj.nodeCount)).toBe(true);
  });

  it('damage is 0 at spawn and grows when beams break or deform', () => {
    const { eng, id } = engineWithCar();
    const v = eng.getVehicle(id)!;
    const s = eng.state;
    expect(RT.computeDamage(s, v)).toBe(0);
    for (let t = 0; t < 400; t++) eng.step();
    expect(RT.computeDamage(s, v)).toBe(0);
    const b0 = v.beamStart;
    s.active[b0] = 0;
    const d1 = RT.computeDamage(s, v);
    expect(d1).toBeGreaterThan(0);
    s.active[b0 + 1] = 0;
    const d2 = RT.computeDamage(s, v);
    expect(d2).toBeGreaterThan(d1);
    s.restLen[b0 + 2] = s.restLen0[b0 + 2]! * 0.9; // heavily deformed = full weight
    expect(RT.computeDamage(s, v)).toBeCloseTo(d2 + d1, 12);
    for (let b = b0; b < b0 + v.vehicle.rig.beamCount; b++) s.active[b] = 0;
    expect(RT.computeDamage(s, v)).toBe(1);
    // Snapshot telemetry carries it; reset repairs it.
    expect(RT.writeVehicleTelemetry(s, v)[VehicleTelemetry.damage]).toBe(1);
    eng.reset(id, at(0, 0.02, 0));
    expect(RT.computeDamage(s, v)).toBe(0);
  });

  it('damage grows in a real crash (high-speed drop of a weak-bodied car)', () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
    eng.setGroundPlane(0, 0);
    const id = 5;
    eng.spawnVehicle(id, testCar(true), at(0, 0.02, 0));
    const v = eng.getVehicle(id)!;
    const obj = eng.arena.get(id)!;
    // Fling the car into the ground at 40 m/s.
    for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
      eng.state.posY[i] = eng.state.posY[i]! + 1;
      eng.state.velY[i] = -40;
    }
    expect(RT.computeDamage(eng.state, v)).toBe(0);
    for (let t = 0; t < 1000; t++) eng.step();
    expect(RT.computeDamage(eng.state, v)).toBeGreaterThan(0);
    expect(finite(eng.state, obj.nodeStart, obj.nodeCount)).toBe(true);
  });

  it('aero drag opposes the COM velocity, ∝ v², distributed by mass', () => {
    const { eng, id } = engineWithCar(5);
    const v = eng.getVehicle(id)!;
    const s = eng.state;
    const cv = v.vehicle;
    const n0 = v.nodeStart;
    for (let i = n0; i < n0 + cv.rig.nodeCount; i++) {
      s.velZ[i] = -30;
      s.frcX[i] = s.frcY[i] = s.frcZ[i] = 0;
    }
    RT.applyAero(s, v);
    let fz = 0;
    let fx = 0;
    for (let i = n0; i < n0 + cv.rig.nodeCount; i++) {
      fz += s.frcZ[i]!;
      fx += s.frcX[i]!;
    }
    expect(fz).toBeCloseTo(0.5 * RT.AIR_DENSITY * 0.7 * 900, 6);
    expect(fx).toBeCloseTo(0, 9);
    // Only body nodes, proportional to mass.
    const w0 = n0 + cv.bodyNodeCount;
    expect(s.frcZ[w0]).toBe(0);
    const a0 = s.frcZ[n0]! * s.invMass[n0]!;
    const a1 = s.frcZ[n0 + 3]! * s.invMass[n0 + 3]!;
    expect(a1).toBeCloseTo(a0, 9);
  });

  it('recover uprights a flipped car in place, keeping heading and damage', () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
    eng.setGroundPlane(0, 0);
    // Upside down (180° about the forward axis Z), yawed 90° by spawning then rotating heading below.
    const s9 = Math.SQRT1_2;
    // yaw +90° about Y then roll 180° about the car's own Z: q = q_yaw * q_roll
    const qy = [0, s9, 0, s9];
    const qr = [0, 0, 1, 0];
    const q: [number, number, number, number] = [
      qy[3]! * qr[0]! + qy[0]! * qr[3]! + qy[1]! * qr[2]! - qy[2]! * qr[1]!,
      qy[3]! * qr[1]! - qy[0]! * qr[2]! + qy[1]! * qr[3]! + qy[2]! * qr[0]!,
      qy[3]! * qr[2]! + qy[0]! * qr[1]! - qy[1]! * qr[0]! + qy[2]! * qr[3]!,
      qy[3]! * qr[3]! - qy[0]! * qr[0]! - qy[1]! * qr[1]! - qy[2]! * qr[2]!,
    ];
    eng.spawnVehicle(3, testCar(), { pos: [2, 1.5, -4], quat: q });
    const v = eng.getVehicle(3)!;
    const obj = eng.arena.get(3)!;
    const s = eng.state;
    for (let t = 0; t < 3000; t++) eng.step();
    const fr = v.vehicle.frameNodes;
    const o = obj.nodeStart + fr[0]!;
    const f = obj.nodeStart + fr[1]!;
    const tp = obj.nodeStart + fr[2]!;
    expect(s.posY[tp]!).toBeLessThan(s.posY[o]!); // lying on its roof
    const headX = s.posX[f]! - s.posX[o]!;
    const headZ = s.posZ[f]! - s.posZ[o]!;
    s.active[obj.beamStart] = 0; // some damage to keep
    s.restLen[obj.beamStart + 3] = s.restLen0[obj.beamStart + 3]! * 1.05;
    const dmg = RT.computeDamage(s, v);
    const lens: number[] = [];
    for (let i = obj.nodeStart; i < obj.nodeStart + 8; i++) lens.push(Math.hypot(s.posX[i]! - s.posX[o]!, s.posY[i]! - s.posY[o]!, s.posZ[i]! - s.posZ[o]!));

    eng.recover(3);
    let minGap = Infinity;
    expect(s.posY[tp]! - s.posY[o]!).toBeGreaterThan(0.45); // up is +Y again
    const h2x = s.posX[f]! - s.posX[o]!;
    const h2z = s.posZ[f]! - s.posZ[o]!;
    expect((h2x * headX + h2z * headZ) / (Math.hypot(h2x, h2z) * Math.hypot(headX, headZ))).toBeGreaterThan(0.999);
    expect(Math.abs(s.posY[f]! - s.posY[o]!)).toBeLessThan(0.05);
    for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
      expect(s.velX[i]).toBe(0);
      expect(s.velY[i]).toBe(0);
      expect(s.posY[i]! - s.radius[i]!).toBeGreaterThan(0.049 - 1e-9);
      minGap = Math.min(minGap, s.posY[i]! - s.radius[i]!);
    }
    expect(minGap).toBeLessThan(0.31); // gentle drop
    for (let i = obj.nodeStart; i < obj.nodeStart + 8; i++) {
      const l = Math.hypot(s.posX[i]! - s.posX[o]!, s.posY[i]! - s.posY[o]!, s.posZ[i]! - s.posZ[o]!);
      expect(l).toBeCloseTo(lens[i - obj.nodeStart]!, 9); // rigid
    }
    expect(RT.computeDamage(s, v)).toBe(dmg);
    // It lands on its wheels and stays sane.
    for (let t = 0; t < 6000; t++) eng.step();
    expect(finite(s, obj.nodeStart, obj.nodeCount)).toBe(true);
    expect(s.posY[tp]!).toBeGreaterThan(s.posY[o]!);
    const tel = RT.writeVehicleTelemetry(s, v);
    expect(tel[VehicleTelemetry.airborne]).toBe(0);
  });

  it('setTransmission switches modes; manual honours gearSelect', () => {
    const { eng, id } = engineWithCar();
    const v = eng.getVehicle(id)!;
    eng.setTransmission(id, 'manual');
    expect(v.drivetrain.transmission).toBe('manual');
    eng.setInput(id, { gearSelect: 3 });
    for (let t = 0; t < 2000; t++) eng.step();
    expect(v.drivetrain.gear).toBe(3);
    expect(() => eng.setTransmission(id, 'cvt' as 'auto')).toThrow();
    eng.spawn(9, { name: 'p', nodes: [{ id: 'a', pos: [0, 0, 0], mass: 1 }], beams: [] }, at(0, 9, 0));
    expect(() => eng.setTransmission(9, 'auto')).toThrow();
    expect(() => eng.recover(9)).toThrow();
  });

  it('snapshot carries vehicle telemetry; plain rigs stay zero', () => {
    const { eng, id } = engineWithCar();
    eng.spawn(9, { name: 'p', nodes: [{ id: 'a', pos: [0, 0, 0], mass: 1 }], beams: [] }, at(0, 9, 0));
    eng.setInput(id, { throttle: 0.5, gearSelect: 1 });
    for (let t = 0; t < 1000; t++) eng.step();
    const layout = computeSnapshotLayout(CAP.maxObjects, CAP.nodeCapacity, CAP.beamCapacity, false);
    const pool = new BufferPool(layout.totalBytes);
    const writer = new SnapshotWriter(layout);
    const buf = pool.acquire()!;
    writer.attach(buf);
    eng.writeSnapshot(writer);
    const r = new SnapshotReader();
    r.attach(buf);
    const tv = r.objectTelemetry(0);
    expect(tv[VehicleTelemetry.engineRpm]).toBeGreaterThan(700);
    expect(tv[VehicleTelemetry.gear]).toBe(1);
    expect(tv[VehicleTelemetry.throttle]).toBeGreaterThan(0);
    expect(tv[VehicleTelemetry.comY]).toBeGreaterThan(0);
    const tp = r.objectTelemetry(1);
    for (let k = 0; k < TELEMETRY_SLOTS; k++) expect(tp[k]).toBe(0);
  });

  it('determinism: test car driven with inputs, plus a plain rig spawned/despawned mid-run', () => {
    const run = (): string => {
      const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: CAP });
      eng.setGroundPlane(0, 0);
      eng.spawnVehicle(5, testCar(), at(0, 0.02, 0));
      for (let t = 0; t < 3000; t++) {
        if (t === 200) eng.setInput(5, { throttle: 1, gearSelect: 1, steer: 0.3 });
        if (t === 900) eng.spawn(2, { name: 'p', nodes: [{ id: 'a', pos: [0, 0, 0], mass: 1 }], beams: [] }, at(5, 2, 5));
        if (t === 1500) eng.setInput(5, { throttle: 0, brake: 0.7, handbrake: 1 });
        if (t === 2000) eng.despawn(2);
        if (t === 2500) eng.recover(5);
        eng.step();
      }
      return hashState(eng.state);
    };
    expect(run()).toBe(run());
  });

  it.skipIf(!hasSedan)('determinism: sedan spawned and driven hashes identically', async () => {
    const mod = (await present['./defs/sedan.ts']!()) as { SEDAN: VehicleDef };
    const run = (): string => {
      const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: CAP });
      eng.setGroundPlane(0, 0);
      eng.spawnVehicle(1, mod.SEDAN, at(0, 0.05, 0));
      for (let t = 0; t < 3000; t++) {
        if (t === 500) eng.setInput(1, { throttle: 1, gearSelect: 1, steer: -0.4 });
        if (t === 2200) eng.setInput(1, { throttle: 0, brake: 1 });
        eng.step();
      }
      const obj = eng.arena.get(1)!;
      expect(finite(eng.state, obj.nodeStart, obj.nodeCount)).toBe(true);
      return hashState(eng.state);
    };
    expect(run()).toBe(run());
  });

  it('worker: spawnVehicle / setTransmission / recover messages', () => {
    const out: WorkerToMain[] = [];
    const host = new W.WorkerHost((m) => out.push(m), { now: () => 0, schedule: () => {} });
    const send = (m: MainToWorker): void => host.handle(m);
    send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: CAP });
    send({ type: 'ground', mode: 'plane', y: 0, materialId: 0 });
    send({ type: 'spawnVehicle', objectId: 4, vehicle: testCar(), transform: at(0, 0.02, 0), transmission: 'manual' });
    send({ type: 'setTransmission', objectId: 4, mode: 'auto' });
    send({ type: 'input', objectId: 4, actions: { throttle: 0.3, gearSelect: 1 } });
    host.runSteps(100);
    send({ type: 'recover', objectId: 4 });
    send({ type: 'recover', objectId: 4, pos: [0, 2, 0] });
    host.runSteps(20);
    expect(out.filter((m) => m.type === 'error')).toEqual([]);
    expect(host.engine!.getVehicle(4)!.drivetrain.transmission).toBe('auto');
    send({ type: 'recover', objectId: 77 });
    send({ type: 'spawnVehicle', objectId: 6, vehicle: { ...testCar(), wheels: [] , frame: { origin: 'nope', front: 'x', top: 'y' } }, transform: at(0, 0, 0) });
    const errs = out.filter((m) => m.type === 'error');
    expect(errs.map((e) => (e as { command: string }).command)).toEqual(['recover', 'spawnVehicle']);
    expect(host.engine!.arena.get(6)).toBeUndefined();
  });

  it('compileVehicle output feeds createVehicleRuntime directly', () => {
    const cv = B.compileVehicle(testCar());
    const rt = RT.createVehicleRuntime(1, cv, 100, 1000, 'manual');
    expect(rt.drivetrain.transmission).toBe('manual');
    expect(rt.wheels[1]!.rimStart).toBe(100 + cv.wheels[1]!.rimStart);
    expect(rt.damageBeams.length).toBeGreaterThan(0);
    expect(rt.damageBeams.length).toBeLessThan(cv.rig.beamCount); // tyre beams excluded
    expect(rt.bodyMass).toBeGreaterThan(8 * 110 - 1e-6);
  });
});
