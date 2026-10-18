import { it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
it('brake trace', () => {
  const cv = compileVehicle(SEDAN);
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, 0);
  const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'manual');
  const s = eng.state;
  const id = (n: string) => cv.rig.nodeIds.indexOf(n);
  const Pi = (i: number) => [s.posX[obj.nodeStart + i]!, s.posY[obj.nodeStart + i]!, s.posZ[obj.nodeStart + i]!];
  const nrm = (v: number[]) => { const l = Math.hypot(...v); return v.map(c => c / l); };
  const local = (n: string) => { const o = Pi(cv.frameNodes[0]!), f = Pi(cv.frameNodes[1]!), t = Pi(cv.frameNodes[2]!); const fw = nrm(f.map((c, k) => c - o[k]!)); let up = t.map((c, k) => c - o[k]!); const d = up.reduce((a, c, k) => a + c * fw[k]!, 0); up = nrm(up.map((c, k) => c - d * fw[k]!)); const rt = [fw[1]! * up[2]! - fw[2]! * up[1]!, fw[2]! * up[0]! - fw[0]! * up[2]!, fw[0]! * up[1]! - fw[1]! * up[0]!]; const p = Pi(id(n)).map((c, k) => c - o[k]!); const dt = (a: number[]) => a.reduce((x, c, k) => x + c * p[k]!, 0); return [dt(rt), dt(up), -dt(fw)]; };
  for (let i = 0; i < 4000; i++) eng.step();
  eng.setInput(1, { gearSelect: 1, throttle: 1 }); for (let i = 0; i < 4000; i++) eng.step();
  const r0 = Object.fromEntries(['FR.hubI', 'FR.hubO', 'FR_kU', 'FR_rack'].map(n => [n, local(n)]));
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
  const D = (a: string, b: string) => Math.hypot(...Pi(id(a)).map((c, k) => c - Pi(id(b))[k]!));
  for (let t = 1; t <= 1400; t++) {
    eng.step();
    if (t % 50 === 0) {
      const I = local('FR.hubI'), O = local('FR.hubO'), U = local('FR_kU');
      const ax = O.map((c, k) => c - I[k]!);
      const yaw = Math.atan2(-ax[2]!, ax[0]!) * 57.3;
      console.log(`t=${(t/2000).toFixed(3)} yaw=${yaw.toFixed(1)} dI=${I.map((c,k)=>((c-r0['FR.hubI']![k]!)*1000).toFixed(0)).join(',')} dO=${O.map((c,k)=>((c-r0['FR.hubO']![k]!)*1000).toFixed(0)).join(',')} dU=${U.map((c,k)=>((c-r0['FR_kU']![k]!)*1000).toFixed(0)).join(',')} U0=${D('FR_kU','FR_up0').toFixed(3)} U1=${D('FR_kU','FR_up1').toFixed(3)} L0=${D('FR.hubI','FR_lp0').toFixed(3)} L1=${D('FR.hubI','FR_lp1').toFixed(3)} up0tw=${D('FR_up0','s3_tw_R').toFixed(3)} up1tw=${D('FR_up1','s3_tw_R').toFixed(3)} up01=${D('FR_up0','FR_up1').toFixed(3)} lp0rl=${D('FR_lp0','s3_rl_R').toFixed(3)} shock=${D('FR.hubI','s3_tw_R').toFixed(3)}`);
    }
  }
});
