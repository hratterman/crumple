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

export const SCENES: Record<string, () => Scene> = {
  sedan: sedanScene,
  truck: truckScene,
  traffic: () => trafficScene(3),
};
