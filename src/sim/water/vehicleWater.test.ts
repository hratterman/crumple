/**
 * Vehicle water (R-PHYS2): floating attitude, time afloat vs openings, wading
 * drag, hydrolock, draining. References in ./specs.ts (McDonald & Giesbrecht
 * 2013: vehicles float 30–120 s; an open window floods within seconds once
 * under).
 */
import { describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { WATER_OPTICS_DEFAULTS, type WaterBody } from '../../world/types';
import { SimEngine } from '../engine';
import { compileVehicle } from '../vehicle/builder';
import { BEATER } from '../vehicle/defs/beater';
import { BOXTRUCK } from '../vehicle/defs/boxtruck';
import { COUPE } from '../vehicle/defs/coupe';
import { PICKUP } from '../vehicle/defs/pickup';
import { SEDAN } from '../vehicle/defs/sedan';
import type { VehicleRuntimeEx } from '../vehicle/runtime';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import type { VehicleDef } from '../vehicle/types';
import { VEHICLE_WATER_SPECS } from './specs';
import { createVehicleWater } from './vehicleWater';

const at = (x: number, y: number, z: number) => ({ pos: [x, y, z] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] });

function pool(depth: number): SimEngine {
  const water: WaterBody = { id: 'pool', name: 'Pool', level: 0, minX: -60, maxX: 60, minZ: -200, maxZ: 60, maxDepth: depth, samples: 0, optics: WATER_OPTICS_DEFAULTS };
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  // A flooded road (asphalt under the water: a dirt bed limits a RWD car's traction in the wading tests).
  eng.setGroundPlane(-depth, MaterialId.asphalt);
  eng.setWater([water]);
  return eng;
}

function com(eng: SimEngine, id: number): [number, number, number, number] {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0;
  let x = 0;
  let y = 0;
  let vz = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    const mi = 1 / s.invMass[i]!;
    m += mi;
    x += mi * s.posX[i]!;
    y += mi * s.posY[i]!;
    vz += mi * s.velZ[i]!;
  }
  return [x / m, y / m, 0, vz / m];
}

/** Pitch of the frame (deg, + nose up). */
function pitch(eng: SimEngine, id: number): number {
  const v = eng.getVehicle(id)!;
  const s = eng.state;
  const f0 = v.nodeStart + v.vehicle.frameNodes[0]!;
  const f1 = v.nodeStart + v.vehicle.frameNodes[1]!;
  const dy = s.posY[f1]! - s.posY[f0]!;
  const dh = Math.sqrt((s.posX[f1]! - s.posX[f0]!) ** 2 + (s.posZ[f1]! - s.posZ[f0]!) ** 2);
  return (Math.atan2(dy, dh) * 180) / Math.PI;
}

describe('vehicle water specs', () => {
  it('every spec names real body nodes and finds its glass', () => {
    const defs: Record<string, VehicleDef> = { sedan: SEDAN, sedanTraffic: SEDAN_TRAFFIC, coupe: COUPE, beater: BEATER, pickup: PICKUP, boxtruck: BOXTRUCK };
    for (const [name, def] of Object.entries(defs)) {
      expect(VEHICLE_WATER_SPECS[name], name).toBeDefined();
      const w = createVehicleWater(compileVehicle(def))!;
      expect(w, name).not.toBeNull();
      const glass = w.comps.reduce((n, c) => n + c.glass.length, 0);
      // The derby beater has no glass; every other car has its windows in the cabin / cab compartment.
      if (name === 'beater') expect(glass).toBe(0);
      else expect(glass, name).toBeGreaterThanOrEqual(4);
      let solid = 0;
      for (let i = 0; i < w.vol.length; i++) solid += w.vol[i]!;
      const spec = VEHICLE_WATER_SPECS[name]!;
      const sealed = spec.compartments.reduce((n, c) => n + c.airVolume, 0);
      // Total displacement = compartments' air + per-node solids + tyre air: well above the mass in m³ (it floats).
      const mass = compileVehicle(def).totalMass;
      expect(solid, name).toBeGreaterThan(0.1);
      expect((solid + sealed) * 1000, name).toBeGreaterThan(1.3 * mass);
    }
  });
});

describe('vehicle flooding', () => {
  it('closed sedan floats nose down for > 40 s; with its glass broken it is on the bottom within 40 s', () => {
    const closed = pool(6);
    closed.spawnVehicle(1, SEDAN, at(0, 0, 0));
    const open = pool(6);
    open.spawnVehicle(1, SEDAN, at(0, 0, 0));
    const vo = open.getVehicle(1)!;
    for (const c of vo.water!.comps) for (const b of c.glass) open.state.active[vo.beamStart + b] = 0;
    const ys: number[] = [];
    const yo: number[] = [];
    const pitches: number[] = [];
    for (let t = 0; t <= 40 * 2000; t++) {
      if (t % 4000 === 0) {
        ys.push(com(closed, 1)[1]);
        yo.push(com(open, 1)[1]);
        pitches.push(pitch(closed, 1));
      }
      closed.step();
      open.step();
    }
    console.log(`[water] closed COM y / 2 s: ${ys.map((y) => y.toFixed(2)).join(' ')}; pitch ${pitches.map((p) => p.toFixed(0)).join(' ')}; flood ${closed.floodLevel(1)!.toFixed(2)}`);
    console.log(`[water] glass broken COM y / 2 s: ${yo.map((y) => y.toFixed(2)).join(' ')}; flood ${open.floodLevel(1)!.toFixed(2)}`);
    // Afloat: nose down (engine bay mass, cabin air), still at the surface at 40 s, slowly flooding.
    expect(pitches[3]!).toBeLessThan(-4);
    expect(ys[20]!).toBeGreaterThan(-0.6);
    expect(closed.floodLevel(1)!).toBeGreaterThan(0.08);
    expect(closed.floodLevel(1)!).toBeLessThan(0.4);
    // Broken glass: once the window line reaches the water it floods in seconds and sinks.
    expect(yo[20]!).toBeLessThan(-3);
    expect(open.floodLevel(1)!).toBeGreaterThan(0.75);
  }, 300_000);

  it('the glassless derby beater floods through its window openings within ~25 s', () => {
    const eng = pool(6);
    eng.spawnVehicle(1, BEATER, at(0, 0, 0));
    let under = -1;
    for (let t = 0; t <= 30 * 2000; t++) {
      if (t % 1000 === 0 && under < 0 && com(eng, 1)[1] < -2) under = t / 2000;
      eng.step();
    }
    expect(under).toBeGreaterThan(8);
    expect(under).toBeLessThan(26);
  }, 300_000);
});

describe('wading + hydrolock', () => {
  /**
   * Drives `def` through water `depth` deep at `speed` (m/s held by a throttle P loop), `s` seconds; returns
   * the water state, the speed (at the moment of a hydrolock — the engine seizes then — else at the end) and
   * the mean body drag / (½ρ·1.8 m·(depth − 0.17 m)·v²) while faster than 2.5 m/s and running (the form-drag
   * reference: C_d over the submerged body section, 0.17 m ground clearance).
   */
  function wade(def: VehicleDef, depth: number, speed: number, s: number) {
    const eng = pool(depth);
    eng.spawnVehicle(1, def, at(0, -depth + 0.02, 0));
    const w = eng.getVehicle(1)!.water!;
    let drag = 0;
    let n = 0;
    let vLock = -1;
    const area = 1.8 * (depth - 0.17);
    for (let t = 0; t <= s * 2000; t++) {
      if (t % 20 === 0) {
        const v = -com(eng, 1)[3];
        const e = speed - v;
        eng.setInput(1, { gearSelect: 1, throttle: Math.max(0, Math.min(1, 0.15 + e * 0.8)), brake: e < -1 ? 0.3 : 0, handbrake: 0 });
      }
      eng.step();
      if (t % 20 !== 0) continue;
      const v = -com(eng, 1)[3];
      if (w.hydrolocked !== 0) {
        if (vLock < 0) vLock = v;
      } else if (v > 2.5) {
        drag += w.dragForce / (0.5 * 1000 * area * v * v);
        n++;
      }
    }
    return { w, eng, cd: n > 0 ? drag / n : NaN, v: vLock >= 0 ? vLock : -com(eng, 1)[3] };
  }

  it('the sedan wades 0.35 m at walking pace; fast, its bow wave reaches the intake: hydrolock', () => {
    // Intake ≈ 0.71 m: walking pace raises the bow wave ≈ 9 cm (0.44 m: dry), ≈ 3.5 m/s ≈ 0.5 m (wet).
    const slow = wade(SEDAN, 0.35, 1.5, 6);
    expect(slow.w.hydrolocked).toBe(0);
    const fast = wade(SEDAN, 0.35, 4, 6);
    console.log(`[water] wading 0.35 m: slow v ${slow.v.toFixed(2)}, fast v ${fast.v.toFixed(2)} at the hydrolock (${fast.w.hydrolocked}), body C_d ${fast.cd.toFixed(2)}`);
    expect(fast.v).toBeGreaterThan(2.5);
    expect(fast.w.hydrolocked).toBe(1);
    // R-PHYS engine systems: a hydrolocked engine is seized (stopped, locked; the starter cannot turn it).
    const es = (fast.eng.getVehicle(1)! as VehicleRuntimeEx).engineSys;
    expect(es.seized).toBe(1);
    expect(fast.eng.getVehicle(1)!.drivetrain.rpm).toBeLessThan(50);
    // Body form drag ½ρC_d·A·v² over the submerged body section: a bluff car front C_d ≈ 1, within 40 %.
    expect(fast.cd).toBeGreaterThan(0.6);
    expect(fast.cd).toBeLessThan(1.4);
  }, 300_000);

  it('the pickup wades 0.6 m slowly with its higher intake; the sedan cannot (hydrolocks or floats off)', () => {
    const p = wade(PICKUP, 0.6, 1.5, 5);
    expect(p.w.hydrolocked).toBe(0);
    expect(p.v).toBeGreaterThan(0.8);
    const s = wade(SEDAN, 0.6, 1.5, 5);
    const v = s.eng.getVehicle(1)!;
    const load = v.wheels.reduce((n, wh) => n + wh.load, 0);
    const weight = v.vehicle.totalMass * 9.81;
    console.log(`[water] 0.6 m: pickup v ${p.v.toFixed(2)}; sedan hydrolock ${s.w.hydrolocked}, wheel load ${((100 * load) / weight).toFixed(0)} % of weight`);
    expect(s.w.hydrolocked === 1 || load < 0.3 * weight).toBe(true);
  }, 300_000);

  it('recover drains the cabin and keeps the hydrolock; reset clears both', () => {
    const eng = pool(6);
    eng.spawnVehicle(1, SEDAN, at(0, 0, 0));
    for (let t = 0; t < 6000; t++) eng.step();
    const w = eng.getVehicle(1)!.water!;
    w.hydrolocked = 1;
    expect(eng.floodLevel(1)!).toBeGreaterThan(0);
    eng.recover(1, [0, 2, 0]);
    expect(eng.floodLevel(1)).toBe(0);
    expect(w.hydrolocked).toBe(1);
    eng.reset(1, at(0, 2, 0));
    expect(w.hydrolocked).toBe(0);
  }, 120_000);
});
