/**
 * Guardrail crash harness (R-PHYS2, tests / tools): a run of W-beam panels
 * (`sections` panels, anchored terminals at both ends) along world x on flat
 * ground, the traffic face toward −z; a vehicle coasting at `speedKmh`
 * hits it at `angleDeg` (MASH TL-3: 2270 kg pickup, 100 km/h, 25°) near the
 * run's middle. Measures the rail's dynamic and permanent deflection, the
 * vehicle's exit angle / speed, roll, and what failed (rail links, splices,
 * post soil, bolts, terminal cables).
 *
 * References (MASH 2016 TL-3; Midwest Guardrail System crash tests, e.g.
 * MwRSF TRP-03-276-13: 2270P at 100 km/h 25° → dynamic deflection ≈ 1.0–
 * 1.1 m, working width ≈ 1.2 m, smoothly redirected, exit angle ≈ 10–15°
 * (exit box), stays upright; EN 1317 N2/H1 working widths W3–W5 = 0.6–1.7 m).
 */
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { setMotion, type HandlingSim } from '../vehicle/handling';
import type { VehicleDef } from '../vehicle/types';
import { getPropDef } from './catalog';
import { GUARDRAIL_LENGTH } from './defs/guardrail';
import { JointKind } from '../trailer/joints';

export interface GuardrailImpactResult {
  /** Max rail displacement toward the back (+z) during the hit / at the end, m. */
  dynamicDeflection: number;
  permanentDeflection: number;
  /** Vehicle COM velocity direction relative to the rail at the end (+ = still toward the rail), deg; speed, km/h. */
  exitAngleDeg: number;
  exitSpeedKmh: number;
  /** Peak roll / pitch magnitude of the vehicle, deg. */
  maxRollDeg: number;
  /** Vehicle COM got 1.5 m behind the rail line (through the barrier, not just into its deflection). */
  penetrated: boolean;
  railLinksBroken: number;
  splicesBroken: number;
  anchorsBroken: number;
  propBeamsBroken: number;
  vehiclePlastic: number;
  /** Rail z displacement (max over rows) per column along the run at the end, for plots. */
  profile: { x: number; dz: number }[];
}

export function runGuardrailImpact(def: VehicleDef, speedKmh = 100, angleDeg = 25, opts: { sections?: number; seconds?: number; ground?: number; trace?: (line: string) => void } = {}): GuardrailImpactResult {
  const n = opts.sections ?? 10;
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: n + 4, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, opts.ground ?? MaterialId.dirt);
  // The vehicle first (the arena orders objects by id: spawning it after the run would shift the run's
  // node indices), parked well clear while the run settles.
  // Vehicle heading (cos θ, 0, sin θ): forward (−Z) rotated by yaw ψ about +Y = (−sin ψ, 0, −cos ψ).
  const th = (angleDeg * Math.PI) / 180;
  const fx = Math.cos(th);
  const fz = Math.sin(th);
  const psi = Math.atan2(-fx, -fz);
  const quat: [number, number, number, number] = [0, Math.sin(psi / 2), 0, Math.cos(psi / 2)];
  // Settled well clear, later moved so its leading corner is 0.3 m (perpendicular) from the rail face at
  // x = 0 (the run's middle).
  eng.spawnVehicle(1, def, { pos: [-20, 0.02, -12], quat }, 'auto');
  for (let t = 0; t < 600; t++) eng.step();
  const veh = eng.getVehicle(1)!;
  const items = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * GUARDRAIL_LENGTH;
    items.push({ objectId: PROP_DYNAMIC_ID_BASE + i, prop: i === 0 || i === n - 1 ? ('guardrailEnd' as const) : ('guardrail' as const), transform: { pos: [x, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] }, asleep: false });
  }
  eng.spawnProps(items);
  const s = eng.state;
  for (let t = 0; t < 2000; t++) {
    eng.step();
    if (opts.trace && t % 250 === 0) {
      let mv = 0;
      for (let i = 0; i < s.nodeCount; i++) mv = Math.max(mv, Math.abs(s.velZ[i]!));
      opts.trace(`run settle ${t}: max |vz| ${mv.toFixed(3)}`);
    }
  }
  // Rail node rest z per prop (after settling).
  const rails: { g: number; x: number; z0: number }[] = [];
  const topRow: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = eng.arena.get(PROP_DYNAMIC_ID_BASE + i)!;
    const rig = getPropDef(items[i]!.prop).rig;
    rig.nodes.forEach((nd, k) => {
      if (/^r[tb]\d+$/.test(nd.id)) rails.push({ g: o.nodeStart + k, x: s.posX[o.nodeStart + k]!, z0: s.posZ[o.nodeStart + k]! });
      if (/^rt\d+$/.test(nd.id)) topRow.push(o.nodeStart + k);
    });
  }
  const rowLen = (): number => {
    let L = 0;
    for (let q = 0; q + 1 < topRow.length; q++) {
      const a = topRow[q]!;
      const b = topRow[q + 1]!;
      L += Math.hypot(s.posX[b]! - s.posX[a]!, s.posY[b]! - s.posY[a]!, s.posZ[b]! - s.posZ[a]!);
    }
    return L;
  };
  const L0 = rowLen();
  {
    const o = eng.arena.get(1)!;
    let zi = -1;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) if (zi < 0 || s.posZ[i]! > s.posZ[zi]!) zi = i;
    const dx = -s.posX[zi]!;
    const dz = -0.4 - s.posZ[zi]! - s.radius[zi]!;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      s.posX[i] = s.posX[i]! + dx;
      s.posZ[i] = s.posZ[i]! + dz;
    }
  }
  const sim: HandlingSim = { eng, obj: eng.arena.get(1)!, veh, cv: veh.vehicle, objectId: 1 };
  eng.setInput(1, { brake: 0, handbrake: 0, gearSelect: 0, throttle: 0 });
  setMotion(sim, speedKmh / 3.6, 0);
  const vo = eng.arena.get(1)!;
  /** COM z, velocity x / z, COM x. */
  const com = (): [number, number, number, number] => {
    let m = 0;
    let z = 0;
    let x = 0;
    let vx = 0;
    let vz = 0;
    for (let i = vo.nodeStart; i < vo.nodeStart + vo.nodeCount; i++) {
      const im = s.invMass[i]!;
      if (im === 0) continue;
      const mi = 1 / im;
      m += mi;
      z += mi * s.posZ[i]!;
      x += mi * s.posX[i]!;
      vx += mi * s.velX[i]!;
      vz += mi * s.velZ[i]!;
    }
    return [z / m, vx / m, vz / m, x / m];
  };
  // The exit is read when the car has slid to 6 m before the run's downstream end (or at the end of time):
  // past that it would leave the end of the barrier, not go through it.
  const endX = (n / 2) * GUARDRAIL_LENGTH - 6;
  const f = veh.vehicle.frameNodes;
  const up = (): [number, number, number] => {
    const o = vo.nodeStart + f[0]!;
    const a = vo.nodeStart + f[1]!;
    const tp = vo.nodeStart + f[2]!;
    let wx = s.posX[a]! - s.posX[o]!;
    let wy = s.posY[a]! - s.posY[o]!;
    let wz = s.posZ[a]! - s.posZ[o]!;
    const wl = Math.hypot(wx, wy, wz);
    wx /= wl;
    wy /= wl;
    wz /= wl;
    let ux = s.posX[tp]! - s.posX[o]!;
    let uy = s.posY[tp]! - s.posY[o]!;
    let uz = s.posZ[tp]! - s.posZ[o]!;
    const d = ux * wx + uy * wy + uz * wz;
    ux -= d * wx;
    uy -= d * wy;
    uz -= d * wz;
    const ul = Math.hypot(ux, uy, uz);
    return [ux / ul, uy / ul, uz / ul];
  };
  let dyn = 0;
  let maxTilt = 0;
  let penetrated = false;
  const seconds = opts.seconds ?? 3;
  for (let t = 1; t <= seconds * 2000; t++) {
    eng.step();
    if (t % 20 !== 0) continue;
    if (com()[3] > endX) break;
    for (const r of rails) {
      const dz = s.posZ[r.g]! - r.z0;
      if (dz > dyn) dyn = dz;
    }
    const u = up();
    const tilt = (Math.acos(Math.max(-1, Math.min(1, u[1]))) * 180) / Math.PI;
    if (tilt > maxTilt) maxTilt = tilt;
    if (com()[0] > 1.5) penetrated = true;
    if (opts.trace && t % 40 === 0) {
      let jf = 0;
      let nb = 0;
      let chord = 0;
      let splice = 0;
      let anchor = 0;
      for (const j of eng.towing.joints.joints) {
        if (j.force > jf) jf = j.force;
        if (j.broken) nb++;
        if (j.tag.startsWith('join:')) splice = Math.max(splice, j.force);
        else if (j.tag.startsWith('panchor:')) anchor = Math.max(anchor, j.force);
        else if (j.chain && j.kind === JointKind.link) chord = Math.max(chord, j.force);
      }
      let md = 0;
      let mx = 0;
      for (const r of rails) {
        const dz = s.posZ[r.g]! - r.z0;
        if (dz > md) {
          md = dz;
          mx = r.x;
        }
      }
      const cc = com();
      // Rail top / bottom row height and tilt at the car (the column nearest the car's COM x).
      let cy = 0;
      let cmx = 0;
      let cm = 0;
      for (let i = vo.nodeStart; i < vo.nodeStart + vo.nodeCount; i++) {
        const im = s.invMass[i]!;
        if (im === 0) continue;
        cm += 1 / im;
        cy += s.posY[i]! / im;
        cmx += s.posX[i]! / im;
      }
      cy /= cm;
      cmx /= cm;
      let near = 0;
      let nd = Infinity;
      for (let q = 0; q < topRow.length; q++) {
        const d = Math.abs(s.posX[topRow[q]!]! - (cmx + 1.5));
        if (d < nd) {
          nd = d;
          near = topRow[q]!;
        }
      }
      opts.trace(`   car COM y ${cy.toFixed(2)}, rail top at x ${s.posX[near]!.toFixed(1)}: y ${s.posY[near]!.toFixed(2)} z ${s.posZ[near]!.toFixed(2)}`);
      opts.trace(`${(t / 2000).toFixed(2)} s: car z ${cc[0].toFixed(2)} v ${(Math.hypot(cc[1], cc[2]) * 3.6).toFixed(1)} km/h, rail max dz ${md.toFixed(2)} at x ${mx.toFixed(1)}, top row +${((rowLen() - L0) * 1000).toFixed(0)} mm, ends x ${s.posX[topRow[0]!]!.toFixed(3)} / ${s.posX[topRow[topRow.length - 1]!]!.toFixed(3)}, max joint ${(jf / 1000).toFixed(0)} kN (chord ${(chord / 1000).toFixed(0)}, splice ${(splice / 1000).toFixed(0)}, anchor ${(anchor / 1000).toFixed(0)}), broken ${nb}`);
    }
  }
  const c = com();
  const speed = Math.hypot(c[1], c[2]);
  let perm = 0;
  const cols = new Map<number, number>();
  for (const r of rails) {
    const dz = s.posZ[r.g]! - r.z0;
    if (dz > perm) perm = dz;
    const key = Math.round(r.x * 1000);
    cols.set(key, Math.max(cols.get(key) ?? -Infinity, dz));
  }
  if (opts.trace) {
    const kinds = new Map<string, number>();
    for (const j of eng.towing.joints.joints) {
      if (!j.broken) continue;
      const rig = getPropDef(items[j.objA.objectId - PROP_DYNAMIC_ID_BASE]?.prop ?? 'guardrail').rig;
      const na = rig.nodes[j.nodeA]?.id.replace(/\d+$/, '') ?? '?';
      const rigB = getPropDef(items[j.objB.objectId - PROP_DYNAMIC_ID_BASE]?.prop ?? 'guardrail').rig;
      const nb = rigB.nodes[j.nodeB]?.id.replace(/\d+$/, '') ?? '?';
      const key = `${j.tag.split(':')[0]} ${na}-${nb}`;
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
    }
    opts.trace(`broken: ${[...kinds.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  }
  let railLinksBroken = 0;
  let splicesBroken = 0;
  let anchorsBroken = 0;
  for (const j of eng.towing.joints.joints) {
    if (!j.broken) continue;
    if (j.tag.startsWith('plink:')) railLinksBroken++;
    else if (j.tag.startsWith('panchor:')) anchorsBroken++;
    else if (j.tag.startsWith('join:') && j.kind === JointKind.ball) splicesBroken++;
  }
  let propBeamsBroken = 0;
  for (let i = 0; i < n; i++) {
    const o = eng.arena.get(PROP_DYNAMIC_ID_BASE + i)!;
    for (let b = o.beamStart; b < o.beamStart + o.beamCount; b++) if (s.active[b] === 0) propBeamsBroken++;
  }
  let plastic = 0;
  for (let b = vo.beamStart; b < vo.beamStart + veh.vehicle.bodyBeamCount; b++) if (s.active[b] !== 0 && Math.abs(s.restLen[b]! / s.restLen0[b]! - 1) > 0.005) plastic++;
  return {
    dynamicDeflection: dyn,
    permanentDeflection: perm,
    exitAngleDeg: (Math.atan2(c[2], c[1]) * 180) / Math.PI,
    exitSpeedKmh: speed * 3.6,
    maxRollDeg: maxTilt,
    penetrated,
    railLinksBroken,
    splicesBroken,
    anchorsBroken,
    propBeamsBroken,
    vehiclePlastic: plastic,
    profile: [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([x, dz]) => ({ x: x / 1000, dz })),
  };
}
