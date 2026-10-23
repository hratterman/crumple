/**
 * Physics bench scenes (tools only; bundled by tools/bench-physics.mjs).
 * Each scene returns an engine already warmed up and driving; the bench
 * times eng.step() over whole simulated seconds.
 */
import { GAME_CAPACITY, MaterialId } from '../../src/protocol/messages';
import { SimEngine } from '../../src/sim/engine';
import { SEDAN } from '../../src/sim/vehicle/defs/sedan';
import { BOXTRUCK } from '../../src/sim/vehicle/defs/boxtruck';
import { placePlayer, trafficWorld } from '../../src/sim/traffic/testkit';
import type { VehicleDef } from '../../src/sim/vehicle/types';
import { vehicleVariantSync } from '../../src/sim/vehicle/defs/hd/index';
import { setMotion } from '../../src/sim/vehicle/handling';

export interface Scene {
  name: string;
  eng: SimEngine;
  beams: number;
}

function planeCar(name: string, def: VehicleDef, throttle: number): Scene {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, MaterialId.asphalt);
  eng.spawnVehicle(1, def, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  const obj = eng.arena.get(1)!;
  obj.actions[0] = throttle;
  obj.actions[5] = 1;
  for (let i = 0; i < 4000; i++) eng.step();
  eng.events.clear();
  return { name, eng, beams: obj.beamCount };
}

export function sedanScene(): Scene {
  return planeCar('sedan (plane, launching)', SEDAN, 0.6);
}

export function truckScene(): Scene {
  return planeCar('box truck (plane, launching)', BOXTRUCK, 0.6);
}

/** Player sedan + 3 awake traffic sedans on the Crumple Valley highway (the real scene: heightfield, colliders, props asleep). */
export function trafficScene(n = 3): Scene {
  const w = trafficWorld({ agents: n, maxAwake: n, player: [360, 400, 0], bubble: { promoteM: 5000, demoteM: 6000 } });
  placePlayer(w.eng, 1, 600);
  w.host.handle({ type: 'input', objectId: 1, actions: { throttle: 0.35, gearSelect: 1 } });
  for (let k = 0; k < n; k++) w.tr.placeAgent(k, k % 2 === 0 ? 1 : 0, 640 + 40 * k, 22);
  for (let i = 0; i < 4000; i++) w.eng.step();
  w.eng.events.clear();
  let beams = 0;
  for (const o of w.eng.objects) if ((o.flags & 1) === 0) beams += o.beamCount;
  return { name: `traffic (player + ${w.tr.awakeCount} awake, valley)`, eng: w.eng, beams };
}

/** R-RIG's HD sedan (sheet-metal skins) at `tier`, launching on a plane. */
export function sedanHdScene(tier: 'high' | 'ultra'): Scene {
  return planeCar(`HD sedan ${tier} (plane, launching)`, vehicleVariantSync('sedan', tier).def, 0.6);
}

/** A sedan at 15 m/s ploughing through a 6 × 10 grid of awake props (cones, barrels, tyres, boxes) on a plane. */
export function propsScene(): Scene {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 128, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, MaterialId.asphalt);
  eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 6], quat: [0, 0, 0, 1] }, 'auto');
  const keys = ['cone', 'barrel', 'tire', 'boxCardboard', 'boxWood', 'barrel'] as const;
  let id = 100;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 6; c++) {
      const key = keys[(r * 6 + c) % keys.length]!;
      eng.spawnProp(id++, key, { pos: [-2.5 + c * 1.0, 0.6, -2 - r * 1.2], quat: [0, 0, 0, 1] }, false);
    }
  }
  for (let i = 0; i < 1000; i++) eng.step();
  const car = eng.arena.get(1)!;
  const veh = eng.getVehicle(1)!;
  setMotion({ eng, obj: car, veh, cv: veh.vehicle, objectId: 1 }, 15);
  car.actions[0] = 0.5;
  car.actions[5] = 1;
  for (let i = 0; i < 400; i++) eng.step();
  eng.events.clear();
  let beams = 0;
  for (const o of eng.objects) if ((o.flags & 1) === 0) beams += o.beamCount;
  return { name: `props (sedan through 60 awake props)`, eng, beams };
}

export const SCENES: Record<string, () => Scene> = {
  props: propsScene,
  sedan: sedanScene,
  truck: truckScene,
  traffic: () => trafficScene(3),
  sedanHigh: () => sedanHdScene('high'),
  sedanUltra: () => sedanHdScene('ultra'),
};
