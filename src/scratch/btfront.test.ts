import { it } from 'vitest';
import { MaterialId } from '../protocol/messages';
import { SimEngine } from '../sim/engine';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { setMotion } from '../sim/vehicle/handling';
it('bt front', () => {
  const kmh = Number(process.env.KMH ?? 50);
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 12000 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  const obj = eng.spawnVehicle(1, BOXTRUCK, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'auto');
  const veh = eng.getVehicle(1)!; const cv = veh.vehicle; const s = eng.state; const ids = cv.rig.nodeIds;
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 1000; t++) eng.step();
  let minZ = Infinity; for (let i = 0; i < cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[obj.nodeStart + i]! - s.radius[obj.nodeStart + i]!);
  eng.setExtraColliders([{ id: 'w', kind: 'box', pos: [0, 1.5, minZ - 0.63], quat: [0, 0, 0, 1], size: [6, 1.5, 0.6], material: MaterialId.concrete }]);
  setMotion({ eng, obj, veh, cv, objectId: 1 }, kmh / 3.6, 0);
  const id = (n: string) => obj.nodeStart + ids.indexOf(n);
  const ref = id('c3_fl_L');
  const names = ['bf_bk_L', 'f0_lo_L', 'f0_hi_L', 'f1_lo_L', 'f1_hi_L', 'f2_lo_L', 'f2_hi_L', 'f3_lo_L', 'f3_hi_L', 'eng_flo_L', 's0_rs_L'].filter((n) => ids.includes(n));
  const rest = names.map((n) => [s.posY[id(n)]!, s.posZ[id(n)]! - s.posZ[ref]!]);
  const dump = (tag: string) => console.log(tag, names.map((n, k) => `${n} dy ${(s.posY[id(n)]! - rest[k]![0]!).toFixed(2)} dz ${(s.posZ[id(n)]! - s.posZ[ref]! - rest[k]![1]!).toFixed(2)}`).join(' | '));
  let maxC = 0; let tMax = 0;
  // energy: track top elastic beams at max crush
  for (let t = 0; t < 4000; t++) {
    eng.step();
    const c = -(s.posZ[id('f0_lo_L')]! - s.posZ[ref]! - rest[1]![1]!);
    if (-c > maxC) { maxC = -c; tMax = t; }
    if (t % 250 === 0) { const P = (n: string) => { const i = id(n); return `${s.posX[i]!.toFixed(2)},${s.posY[i]!.toFixed(2)},${s.posZ[i]!.toFixed(2)}`; }; console.log('ATT', t, 'c3_rf', P('c3_rf'), 'b7_rc', P('b7_rc'), 'b7_fl_L', P('b7_fl_L'), 'b7_fl_R', P('b7_fl_R'), 'f13_lo_L', P('f13_lo_L'), 'RA_lp_L', P('RA_lp_L'), 'RA_ab_L', P('RA_ab_L')); }
    if (t === Number(process.env.TSNAP ?? 190)) {
      const E: [number, string][] = []; let tot = 0; const byCls = new Map<string, number>();
      for (let b = 0; b < cv.bodyBeamCount; b++) { const g = obj.beamStart + b; if (s.active[g] === 0) continue; const ia = s.aIdx[g]!, ib = s.bIdx[g]!; const L = Math.hypot(s.posX[ia]! - s.posX[ib]!, s.posY[ia]! - s.posY[ib]!, s.posZ[ia]! - s.posZ[ib]!); let x = L - s.restLen[g]!; if (s.type[g] === 2 && x > 0) x = 0; const e = 0.5 * s.k[g]! * x * x; tot += e; const an = ids[cv.rig.beamA[b]!]!, bn = ids[cv.rig.beamB[b]!]!; const key = an.replace(/_[LR]$/, '').replace(/\d+/, '#') + '|' + bn.replace(/_[LR]$/, '').replace(/\d+/, '#'); byCls.set(key, (byCls.get(key) ?? 0) + e); E.push([e, `${an}-${bn} x ${x.toFixed(3)} k ${s.k[g]!.toExponential(2)}`]); }
      E.sort((a, b) => b[0] - a[0]); console.log('SNAP total elastic', tot.toFixed(0), '\n' + E.slice(0, 25).map(([e, n]) => `${n} ${e.toFixed(0)}J`).join('\n'));
      console.log('BYCLS', [...byCls].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, e]) => `${k} ${e.toFixed(0)}`).join(' | '));
    }
    { const i = id('RA_lp_L'); const v = Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!); if (false) console.log('VL', t, v.toFixed(2), 'y', s.posY[i]!.toFixed(3), 'vy', s.velY[i]!.toFixed(2), 'vz', s.velZ[i]!.toFixed(2), 'vx', s.velX[i]!.toFixed(2)); }
  }
  console.log('maxC', maxC, 'at', tMax);
  const br: string[] = []; for (let b = 0; b < cv.bodyBeamCount; b++) if (s.active[obj.beamStart + b] === 0) br.push(`${ids[cv.rig.beamA[b]!]}-${ids[cv.rig.beamB[b]!]}`); console.log('BROKEN', br.join(' '));
  for (const n of ['RA_lp_L', 'RA_lp_R', 'FA_lp_L', 'arbR_U_L']) { const i = id(n); console.log('V', n, Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!).toFixed(2)); }
  // beams with most stored elastic energy at the end
  const E: [number, string][] = [];
  for (let b = 0; b < cv.bodyBeamCount; b++) { const g = obj.beamStart + b; if (s.active[g] === 0) continue; const ia = s.aIdx[g]!, ib = s.bIdx[g]!; const L = Math.hypot(s.posX[ia]! - s.posX[ib]!, s.posY[ia]! - s.posY[ib]!, s.posZ[ia]! - s.posZ[ib]!); const e = 0.5 * s.k[g]! * (L - s.restLen[g]!) ** 2; E.push([e, `${ids[cv.rig.beamA[b]!]}-${ids[cv.rig.beamB[b]!]} ${(L - s.restLen[g]!).toFixed(3)}`]); }
  E.sort((a, b) => b[0] - a[0]); console.log(E.slice(0, 15).map(([e, n]) => `${n} ${e.toFixed(0)}J`).join('\n'));
}, 900000);
