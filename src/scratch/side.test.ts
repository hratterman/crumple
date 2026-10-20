import { expect, it } from 'vitest';
import { MaterialId } from '../protocol/messages';
import { SimEngine, SIM_HZ } from '../sim/engine';
import { SEDAN } from '../sim/vehicle/defs/sedan';
import { BOX_DIMS, BOXTRUCK, BOXTRUCK_DESIGN } from '../sim/vehicle/defs/boxtruck';
import { kinematics, setMotion, stepN, type HandlingSim } from '../sim/vehicle/handling';
import type { VehicleDef } from '../sim/vehicle/types';
function engine(): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 12288 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  return eng;
}
function spawn(eng: SimEngine, id: number, def: VehicleDef, pos: [number, number, number], quat: [number, number, number, number]): HandlingSim {
  const obj = eng.spawnVehicle(id, def, { pos, quat }, 'auto');
  const veh = eng.getVehicle(id)!;
  return { eng, obj, veh, cv: veh.vehicle, objectId: id };
}
function brokenCount(sim: HandlingSim, list: readonly (readonly [string, string])[]): number {
  const ids = sim.cv.rig.nodeIds;
  const s = sim.eng.state;
  const want = new Set(list.map(([a, b]) => [a, b].sort().join('|')));
  let n = 0;
  for (let k = 0; k < sim.cv.bodyBeamCount; k++) {
    if (s.active[sim.obj.beamStart + k] !== 0) continue;
    if (want.has([ids[sim.cv.rig.beamA[k]!]!, ids[sim.cv.rig.beamB[k]!]!].sort().join('|'))) n++;
  }
  return n;
}
function finite(sim: HandlingSim): boolean {
  const s = sim.eng.state;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) if (!Number.isFinite(s.posX[i]! + s.posY[i]! + s.posZ[i]!)) return false;
  return true;
}

interface SideHit {
  /**
   * Local dent of the struck wall, m (max over time, and final): the largest inward displacement of a
   * struck-side wall node (posts, rails and the panel-centre skin nodes) beyond the displacement of the
   * box's own end frames (bilinear in z and y between the b0 and b7 corner posts), so the box sliding,
   * yawing or leaning away from the hit is not counted as a dent.
   */
  dentMax: number;
  dent: number;
  /** Box width (struck wall to far wall) lost, any station / row, m — max over time. */
  widthLossMax: number;
  boxMountsBroken: number;
  finite: boolean;
  sedanFinite: boolean;
}

/** The sedan at `kmh` square into the right side of the parked (braked) truck's box, ahead of the rear wheels. */
function sedanIntoBox(kmh: number): SideHit {
  const eng = engine();
  const q = Math.SQRT1_2;
  const truck = spawn(eng, 1, BOXTRUCK, [0, 0, 0], [0, 0, 0, 1]);
  const sedan = spawn(eng, 2, SEDAN, [6.2, 0, 0.3], [0, q, 0, q]);
  const s = eng.state;
  const ids = truck.cv.rig.nodeIds;
  const id = (n: string): number => truck.obj.nodeStart + ids.indexOf(n);
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1, handbrake: 1 });
  eng.setInput(2, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  expect(kinematics(sedan).fx).toBeLessThan(-0.9);
  const rows = ['fl', 'wl', 'wm', 'rl'];
  const last = BOX_DIMS.stations - 1;
  const wall = [
    ...rows.flatMap((r) => Array.from({ length: last - 1 }, (_, i) => `b${i + 1}_${r}_R`)),
    ...ids.filter((n) => /^bp\d+_\d_R$/.test(n)),
  ].map(id);
  // End-frame corners: [front low, front high, rear low, rear high].
  const corners = [`b0_fl_R`, `b0_rl_R`, `b${last}_fl_R`, `b${last}_rl_R`].map(id);
  const X0 = (i: number): number => s.posX[i]!;
  const rest = { x: wall.map(X0), y: wall.map((i) => s.posY[i]!), z: wall.map((i) => s.posZ[i]!), cx: corners.map(X0) };
  const [zF, zR] = [s.posZ[corners[0]!]!, s.posZ[corners[2]!]!];
  const [yLo, yHi] = [s.posY[corners[0]!]!, s.posY[corners[1]!]!];
  const per = (): number[] => {
    const d = corners.map((c, k) => s.posX[c]! - rest.cx[k]!);
    return wall.map((n, k) => {
      const u = (rest.z[k]! - zF) / (zR - zF);
      const v = (rest.y[k]! - yLo) / (yHi - yLo);
      const ref = (1 - u) * ((1 - v) * d[0]! + v * d[1]!) + u * ((1 - v) * d[2]! + v * d[3]!);
      return ref - (s.posX[n]! - rest.x[k]!);
    });
  };
  const dentNow = (): number => Math.max(...per());
  (globalThis as any).__dump = () => { const p = per(); const o = p.map((v, k) => [v, ids[wall[k]! - truck.obj.nodeStart]!] as const).sort((a, b) => b[0] - a[0]).slice(0, 8); return o.map(([v, n]) => `${n} ${(v * 100).toFixed(1)}`).join(' '); };
  const width = (): number[] => rows.flatMap((r) => Array.from({ length: last + 1 }, (_, i) => Math.hypot(s.posX[id(`b${i}_${r}_R`)]! - s.posX[id(`b${i}_${r}_L`)]!, s.posY[id(`b${i}_${r}_R`)]! - s.posY[id(`b${i}_${r}_L`)]!)));
  const w0 = width();
  setMotion(sedan, kmh / 3.6, 0);
  let dentMax = 0;
  let widthLossMax = 0;
  for (let t = 0; t < 2.5 * SIM_HZ; t++) {
    eng.step();
    if (t % 20 !== 0) continue;
    const dn = dentNow(); if (dn > dentMax) { dentMax = dn; (globalThis as any).__atMax = (globalThis as any).__dump();
      const cv = truck.cv; const obj = truck.obj; const byCls = new Map<string, number>(); const E: [number, string][] = [];
      for (let b = 0; b < cv.bodyBeamCount; b++) { const g = obj.beamStart + b; if (s.active[g] === 0) continue; const ia = s.aIdx[g]!, ib = s.bIdx[g]!; const L = Math.hypot(s.posX[ia]! - s.posX[ib]!, s.posY[ia]! - s.posY[ib]!, s.posZ[ia]! - s.posZ[ib]!); let x = L - s.restLen[g]!; if (s.type[g] === 2 && x > 0) x = 0; const e = 0.5 * s.k[g]! * x * x; const an = ids[cv.rig.beamA[b]!]!, bn = ids[cv.rig.beamB[b]!]!; const key = an.replace(/_[LR]$/, '').replace(/\d+/, '#') + '|' + bn.replace(/_[LR]$/, '').replace(/\d+/, '#'); byCls.set(key, (byCls.get(key) ?? 0) + e); E.push([e, `${an}-${bn} x ${x.toFixed(3)} k ${s.k[g]!.toExponential(2)}`]); }
      E.sort((a, b) => b[0] - a[0]); (globalThis as any).__E = E.slice(0, 12).map(([e, n]) => `${n} ${e.toFixed(0)}J`).join('\n') + '\nBYCLS ' + [...byCls].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, e]) => `${k} ${e.toFixed(0)}`).join(' | ');
    }
    width().forEach((w, i) => (widthLossMax = Math.max(widthLossMax, w0[i]! - w)));
  }
  console.log('ATMAX', (globalThis as any).__atMax); console.log('EN', (globalThis as any).__E); console.log('FINAL', (globalThis as any).__dump());
  return { dentMax, dent: dentNow(), widthLossMax, boxMountsBroken: brokenCount(truck, BOXTRUCK_DESIGN.boxMounts), finite: finite(truck), sedanFinite: finite(sedan) };
}


interface BoxFrontal {
  /** Box (all wall / floor / roof ring nodes) moved along the frame axis relative to the rear frame, m: final and max. */
  shift: number;
  shiftMax: number;
  boxMountsBroken: number;
  cabMountsBroken: number;
  finite: boolean;
}

/** The crash.ts frontal set-up (concrete wall 3 cm ahead, rolling release, 2.2 s), tracking the box against the rear frame. */
function boxFrontal(kmh: number): BoxFrontal {
  const eng = engine();
  const sim = spawn(eng, 1, BOXTRUCK, [0, 0, 0], [0, 0, 0, 1]);
  const s = eng.state;
  const ids = sim.cv.rig.nodeIds;
  const idx = (re: RegExp): number[] => ids.flatMap((id, i) => (re.test(id) ? [sim.obj.nodeStart + i] : []));
  const box = idx(/^b[0-7]_(fi|fl|wl|wm|rl|rc|fc)/);
  const rear = idx(/^f(9|10|11|12|13)_(hi|lo)_/);
  const mid = idx(/^f(6|7|8)_(hi|lo)_/);
  const mean = (l: number[]): number[] => [0, 1, 2].map((k) => l.reduce((a, i) => a + [s.posX, s.posY, s.posZ][k]![i]!, 0) / l.length);
  const along = (): number => {
    const b = mean(box);
    const r = mean(rear);
    const m = mean(mid);
    const ax = [m[0]! - r[0]!, m[1]! - r[1]!, m[2]! - r[2]!];
    const l = Math.hypot(ax[0]!, ax[1]!, ax[2]!);
    return ((b[0]! - r[0]!) * ax[0]! + (b[1]! - r[1]!) * ax[1]! + (b[2]! - r[2]!) * ax[2]!) / l;
  };
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 0 });
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  let minZ = Infinity;
  for (let i = 0; i < sim.cv.bodyNodeCount; i++) minZ = Math.min(minZ, s.posZ[sim.obj.nodeStart + i]! - s.radius[sim.obj.nodeStart + i]!);
  eng.setExtraColliders([{ id: 'wall', kind: 'box', pos: [0, 1.5, minZ - 0.63], quat: [0, 0, 0, 1], size: [6, 1.5, 0.6], material: MaterialId.concrete }]);
  const a0 = along();
  setMotion(sim, kmh / 3.6, 0);
  let shiftMax = 0;
  for (let t = 0; t < 2.2 * SIM_HZ; t++) {
    eng.step();
    if (t % 20 === 0) shiftMax = Math.max(shiftMax, Math.abs(along() - a0));
  }
  return {
    shift: Math.abs(along() - a0),
    shiftMax,
    boxMountsBroken: brokenCount(sim, BOXTRUCK_DESIGN.boxMounts),
    cabMountsBroken: brokenCount(sim, BOXTRUCK_DESIGN.cabMounts),
    finite: finite(sim),
  };
}


it('side', () => {
  if (process.env.BOXF === '1') { const b = boxFrontal(50); console.log(`BOXF shift ${(b.shift * 100).toFixed(1)} max ${(b.shiftMax * 100).toFixed(1)} mounts ${b.boxMountsBroken}`); return; }
  const r = sedanIntoBox(Number(process.env.KMH ?? 50));
  console.log(`SIDE dent ${(r.dent * 100).toFixed(1)} max ${(r.dentMax * 100).toFixed(1)} widthLoss ${(r.widthLossMax * 100).toFixed(1)} mounts ${r.boxMountsBroken} finite ${r.finite} ${r.sedanFinite}`);
}, 900000);
