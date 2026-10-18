import { it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
import type { VehicleDef } from './types';
function probe(def: VehicleDef, label: string) {
  const cv = compileVehicle(def);
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, 0);
  const obj = eng.spawnVehicle(1, def, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
  const s = eng.state; const nb = cv.bodyNodeCount;
  for (let step = 0; step < 8000; step++) eng.step();
  const isBody = (i: number) => i < nb && !cv.rig.nodeIds[i]!.includes('_k');
  const avg = (zlo: number, zhi: number) => { let a = 0, n = 0; for (let i = 0; i < nb; i++) { if (!isBody(i)) continue; const z = cv.rig.nodePos[3*i+2]!; if (z >= zlo && z <= zhi) { a += s.posY[obj.nodeStart + i]!; n++; } } return a / n; };
  const f0 = avg(-1.8, -1.0), r0 = avg(1.0, 1.8);
  for (let i = 0; i < nb; i++) if (isBody(i)) s.velY[obj.nodeStart + i] = -0.25;
  const fT: number[] = [], rT: number[] = [];
  for (let step = 0; step < 6000; step++) { eng.step(); if (step % 10 === 0) { fT.push(avg(-1.8, -1.0) - f0); rT.push(avg(1.0, 1.8) - r0); } }
  const an = (tr: number[]) => { const zc: number[] = []; for (let i = 1; i < tr.length; i++) if (tr[i - 1]! < 0 && tr[i]! >= 0) zc.push(i * 0.005); return zc.length > 2 ? (zc.length - 1) / (zc[zc.length - 1]! - zc[0]!) : NaN; };
  console.log(label, 'f front', an(fT).toFixed(3), 'rear', an(rT).toFixed(3));
}
it('dyn', () => {
  probe(SEDAN, 'base');
  for (const [lab, mod] of [['k x0.5', (b: any) => { if (b.type === 'shock') b.k *= 0.5; }], ['noARB', (b: any) => { if (b.a.endsWith('hubI') && b.b.endsWith('_kU') || b.a.endsWith('_kU') && b.b.endsWith('hubI')) { if (b.a.slice(0, 2) !== b.b.slice(0, 2)) b.k = 1; } }], ['dampOnly0.3', (b: any) => { if (b.type === 'shock') b.d *= 0.3; }]] as const) {
    const x: VehicleDef = JSON.parse(JSON.stringify(SEDAN)); for (const b of x.body.beams) mod(b); probe(x, lab);
  }
});
