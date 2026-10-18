import { it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
it('settle', () => {
  const cv = compileVehicle(SEDAN);
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, 0);
  const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
  const s = eng.state;
  const nb = cv.bodyNodeCount;
  const y0 = new Float64Array(nb);
  for (let i = 0; i < nb; i++) y0[i] = s.posY[obj.nodeStart + i]!;
  const report = (t: number) => {
    let sum = 0, n = 0, maxV = 0, nan = 0;
    let fr = 0, rr = 0, fn = 0, rn = 0;
    for (let i = 0; i < nb; i++) {
      const id = cv.rig.nodeIds[i]!;
      if (id.includes('_k')) continue;
      const g = obj.nodeStart + i;
      const dy = s.posY[g]! - y0[i]!;
      if (!Number.isFinite(dy)) nan++;
      sum += dy; n++;
      const z = cv.rig.nodePos[3 * i + 2]!;
      if (z < -1.0) { fr += dy; fn++; } if (z > 1.0) { rr += dy; rn++; }
      maxV = Math.max(maxV, Math.hypot(s.velX[g]!, s.velY[g]!, s.velZ[g]!));
    }
    const o = obj.nodeStart + cv.frameNodes[0]!;
    console.log(`t=${t.toFixed(2)} meanDy=${(sum / n * 100).toFixed(2)}cm front=${(fr/fn*100).toFixed(2)} rear=${(rr/rn*100).toFixed(2)} originY=${s.posY[o]!.toFixed(4)} x=${s.posX[o]!.toFixed(4)} z=${s.posZ[o]!.toFixed(4)} maxV=${maxV.toFixed(4)} nan=${nan}`);
  };
  for (let step = 1; step <= 8000; step++) {
    eng.step();
    if (step % 1000 === 0) report(step / 2000);
  }
  // strains: max |strain| per class among body beams; and force
  let maxF = 0, idx = -1; let broken = 0, deformed = 0;
  const forces: [number, number][] = [];
  for (let b = 0; b < cv.bodyBeamCount; b++) {
    const g = obj.beamStart + b;
    if (s.active[g] === 0) broken++;
    if (Math.abs(s.restLen[g]! - s.restLen0[g]!) > 1e-6) deformed++;
    const ia = s.aIdx[g]!, ib = s.bIdx[g]!;
    const L = Math.hypot(s.posX[ib]! - s.posX[ia]!, s.posY[ib]! - s.posY[ia]!, s.posZ[ib]! - s.posZ[ia]!);
    const f = s.k[g]! * (L - s.restLen[g]!);
    forces.push([Math.abs(f), b]);
  }
  forces.sort((a, b) => b[0] - a[0]);
  for (const [f, b] of forces.slice(0, 12)) {
    const bd = SEDAN.body.beams[b]!;
    console.log(`  F=${f.toFixed(0)} ${bd.a}-${bd.b} ${bd.type} k=${bd.k} deform=${bd.deform}`);
  }
  console.log('broken', broken, 'deformed', deformed);
  const v = eng.getVehicle(1)!;
  console.log('wheel loads', v.wheels.map(w => w.load.toFixed(0)), 'total', (v.wheels.reduce((a, w) => a + w.load, 0) / 9.81).toFixed(1));
});
