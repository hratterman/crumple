import { it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
it('hydro break', () => {
  const cv = compileVehicle(SEDAN);
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, 0);
  const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'manual');
  for (let i = 0; i < 3000; i++) eng.step();
  eng.setInput(1, { steer: 1 });
  for (let i = 0; i < 200; i++) eng.step();
  for (let b = 0; b < cv.rig.beamCount; b++) if (eng.state.active[obj.beamStart + b] === 0) console.log('BROKEN', cv.rig.nodeIds[cv.rig.beamA[b]!], cv.rig.nodeIds[cv.rig.beamB[b]!]);
});
