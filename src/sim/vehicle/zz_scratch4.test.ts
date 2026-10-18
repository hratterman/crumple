import { it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { SimEngine } from '../engine';
it('drive', () => {
  const cv = compileVehicle(SEDAN);
  for (const [label, input] of [['throttle', { gearSelect: 1, throttle: 1 }], ['brake', { gearSelect: 0, brake: 1 }], ['steerThrottle', { gearSelect: 1, throttle: 1, steer: 1 }]] as const) {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, 0);
  const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'manual');
  const s = eng.state;
  for (let i = 0; i < 4000; i++) eng.step();
  const P = (i: number) => [s.posX[obj.nodeStart + i]!, s.posY[obj.nodeStart + i]!, s.posZ[obj.nodeStart + i]!];
  const nrm = (v: number[]) => { const l = Math.hypot(...v); return v.map(c => c / l); };
  const frame = () => { const o = P(cv.frameNodes[0]!), f = P(cv.frameNodes[1]!), t = P(cv.frameNodes[2]!); const fw = nrm(f.map((c, k) => c - o[k]!)); let up = t.map((c, k) => c - o[k]!); const d = up[0]! * fw[0]! + up[1]! * fw[1]! + up[2]! * fw[2]!; up = nrm(up.map((c, k) => c - d * fw[k]!)); const right = [fw[1]! * up[2]! - fw[2]! * up[1]!, fw[2]! * up[0]! - fw[0]! * up[2]!, fw[0]! * up[1]! - fw[1]! * up[0]!]; return { fw, up, right }; };
  const axle = (w: typeof cv.wheels[0]) => { const a = P(w.hubI), b = P(w.hubO); const v = nrm(b.map((c, k) => c - a[k]!)); const F = frame(); const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!; return [dot(v, F.right), dot(v, F.up), -dot(v, F.fw)]; };
  const yaw = () => { const F = frame(); return Math.atan2(-F.fw[0]!, -F.fw[2]!) * 57.3; };
  // body heading from frame
  const ref = cv.wheels.map(w => axle(w));
  if (label === 'brake') { eng.setInput(1, { gearSelect: 1, throttle: 1 }); for (let i = 0; i < 4000; i++) eng.step(); }
  eng.setInput(1, input);
  const maxAng = [0, 0, 0, 0];
  const o = obj.nodeStart + cv.frameNodes[0]!;
  const z0 = s.posZ[o]!;
  for (let t = 1; t <= 2000; t++) {
    eng.step();
    cv.wheels.forEach((w, i) => { const a = axle(w), r = ref[i]!; const ang = Math.acos(Math.min(1, a[0]! * r[0]! + a[1]! * r[1]! + a[2]! * r[2]!)) * 57.3; maxAng[i] = Math.max(maxAng[i]!, ang); });
  }
  const v = eng.getVehicle(1)!;
  console.log(label, 'bodyYaw', yaw().toFixed(1), 'maxAxleDev deg', maxAng.map(a => a.toFixed(1)).join(' '), 'dz', (s.posZ[o]! - z0).toFixed(2), 'omega', v.wheels.map(w => w.omega.toFixed(1)).join(' '), 'speed', (-s.velZ[o]!).toFixed(2));
  }
});
