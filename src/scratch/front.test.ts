import { it } from 'vitest';
import { MaterialId } from '../protocol/messages';
import { SimEngine } from '../sim/engine';
import { BOXTRUCK, BOXTRUCK_CRASH_PROBES } from '../sim/vehicle/defs/boxtruck';
import { setMotion } from '../sim/vehicle/handling';
import { formatCrash, runCrash } from '../sim/vehicle/crash';

const kmh = Number(process.env.KMH ?? 50);
it('front', () => {
  const probes = BOXTRUCK_CRASH_PROBES as never;
  if (process.env.HARNESS !== '0') {
    const r = runCrash({ kind: 'frontal', speedKmh: kmh, def: BOXTRUCK, probes });
    console.log(formatCrash(r));
    console.log('trace', r.crushTrace.filter((_, i) => i % 4 === 0).map((c) => (c * 100).toFixed(0)).join(' '));
  }
  if (process.env.SIDE !== '1') return;
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  const obj = eng.spawnVehicle(1, BOXTRUCK, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  const veh = eng.getVehicle(1)!;
  const sim = { eng, obj, veh, cv: veh.vehicle, objectId: 1 };
  const s = eng.state; const ids = sim.cv.rig.nodeIds; const n0 = obj.nodeStart;
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 1000; t++) eng.step();
  let minZ = Infinity; for (let i = 0; i < sim.cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[n0 + i]! - s.radius[n0 + i]!);
  eng.setExtraColliders([{ id: 'w', kind: 'box', pos: [0, 1.5, minZ - 0.03 - 0.6], quat: [0, 0, 0, 1], size: [6, 1.5, 0.6], material: MaterialId.concrete }]);
  setMotion(sim, kmh / 3.6, 0);
  const watch = ['bf_bl_R', 'bf_bu_R', 'f0_lo_R', 'f0_hi_R', 'f1_lo_R', 'f1_hi_R', 'f2_lo_R', 'f2_hi_R', 'f3_lo_R', 'f3_hi_R', 'f4_lo_R', 'f4_hi_R', 'f5_hi_R', 'f6_hi_R', 'f8_hi_R', 'f10_hi_R', 'f13_hi_R', 'eng_flo_R', 'eng_rhi_R', 'c0_fl_R', 'c3_fl_R', 'c3_rf'];
  const dump = (tag: string) => console.log(tag + ' ' + watch.map((w) => { const i = n0 + ids.indexOf(w); return `${w}(${s.posZ[i]!.toFixed(2)},${s.posY[i]!.toFixed(2)})`; }).join(' '));
  dump('t0');
  const dz = (a: string, b: string) => { const i = n0 + ids.indexOf(a), j = n0 + ids.indexOf(b); return Math.hypot(s.posX[i]! - s.posX[j]!, s.posY[i]! - s.posY[j]!, s.posZ[i]! - s.posZ[j]!); };
  const rest = { horn: dz('f0_lo_R', 'f3_lo_R'), hornHi: dz('f0_hi_R', 'f3_hi_R'), mid: dz('f3_lo_R', 'f7_lo_R'), cab: dz('c3_fl_R', 'f7_lo_R'), bump: dz('bf_bk_R', 'f0_lo_R') };
  const lens = (tag: string) => console.log(`${tag} horn f0-f3 lo ${(rest.horn - dz('f0_lo_R', 'f3_lo_R')).toFixed(3)} hi ${(rest.hornHi - dz('f0_hi_R', 'f3_hi_R')).toFixed(3)} | f3-f7 ${(rest.mid - dz('f3_lo_R', 'f7_lo_R')).toFixed(3)} | cab c3-f7 ${(rest.cab - dz('c3_fl_R', 'f7_lo_R')).toFixed(3)} | bumper bracket ${(rest.bump - dz('bf_bk_R', 'f0_lo_R')).toFixed(3)}`);
  const plast = (tag: string) => {
    const rows: [string, number][] = [];
    for (let b = 0; b < sim.cv.bodyBeamCount; b++) {
      const g = obj.beamStart + b;
      const a = ids[sim.cv.rig.beamA[b]!]!, c = ids[sim.cv.rig.beamB[b]!]!;
      if (!/^(f\d|kb|bf|c\d|b\d|eng|gbx)/.test(a) && !/^(f\d|kb|bf)/.test(c)) continue;
      const r = s.active[g] === 0 ? -9 : (s.restLen[g]! - s.restLen0[g]!) / s.restLen0[g]!;
      if (Math.abs(r) > 0.02) rows.push([`${a}-${c}`, r]);
    }
    rows.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    console.log(tag + ' plastic: ' + rows.slice(0, 40).map(([n, r]) => `${n} ${(r * 100).toFixed(0)}%`).join(', '));
  };
  for (let t = 1; t <= 4400; t++) { eng.step(); if ([100, 200, 400, 800, 1600, 4400].includes(t)) dump(`t${t}`); if (t === 400 || t === 4400) plast(`t${t}`); if ([200, 400, 800, 4400].includes(t)) lens(`L${t}`); }
}, 600000);
