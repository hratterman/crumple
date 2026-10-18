import { it } from 'vitest';
import { SEDAN, SEDAN_DESIGN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
it('steer', () => {
  console.log('hydroTravel', SEDAN_DESIGN.hydroTravel, 'tie', SEDAN_DESIGN.tieRodLength);
  const cv = compileVehicle(SEDAN);
  for (const st of [-1, -0.5, 0.5, 1]) {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
    eng.setGroundPlane(0, 0);
    const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'manual');
    const s = eng.state;
    for (let i = 0; i < 3000; i++) eng.step();
    eng.setInput(1, { steer: st });
    const ang: string[] = [];
    for (let t = 1; t <= 6000; t++) { eng.step(); if (t % 1000 === 0) { const out = cv.wheels.slice(0, 2).map(w => { const a = obj.nodeStart + w.hubI, b = obj.nodeStart + w.hubO; const ax = [s.posX[b]! - s.posX[a]!, s.posZ[b]! - s.posZ[a]!]; const sgn = w.spinSign; return (Math.atan2(-ax[1]! * -sgn, ax[0]! * -sgn) * 57.3).toFixed(1); }); ang.push(out.join('/')); } }
    console.log('steer', st, 'wheel yaw deg (FL/FR) over time', ang.join(' '));
  }
});
