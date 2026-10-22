/**
 * Prop impact harness (R-PHYS2, tests / tools): a vehicle at `speedKmh`
 * (coasting, neutral) runs head-on into one catalog prop on flat concrete;
 * measures the vehicle's speed change, the prop's launch speed, the
 * momentum balance, damage on both sides and the prop's failure (anchor,
 * splinters, burst / drained contents). The reference for the vehicle's
 * Δv is the perfectly inelastic collision Δv = v·m/(M + m) (a light prop
 * is thrown faster than the car, Δv below the line; a heavy one that
 * slides on the ground takes friction impulse, Δv above it).
 */
import { MaterialId } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { setMotion, type HandlingSim } from '../vehicle/handling';
import type { VehicleDef } from '../vehicle/types';
import { compilePropRig, PROP_CATALOG } from './catalog';
import type { PropKey } from './types';

export interface ImpactResult {
  key: PropKey;
  propKg: number;
  carKg: number;
  v0: number;
  /** Vehicle COM speed just before contact and 0.5 s after it, m/s (v1 corrected for the coasting loss). */
  vPre: number;
  v1: number;
  dvKmh: number;
  /** Perfectly inelastic reference Δv (from the contact speed), km/h. */
  dvInelasticKmh: number;
  /** Peak prop COM speed after the hit, m/s, and its ratio to v0. */
  propSpeed: number;
  /** Prop displacement after 3 s, m. */
  propMoved: number;
  /** Vehicle body beams plastically deformed (> 0.5 % rest-length change) / broken. */
  carPlastic: number;
  carBroken: number;
  /** Prop beams broken (incl. anchors) / plastically deformed. */
  propBroken: number;
  propPlastic: number;
  /** Anchored prop: the base let go. */
  anchorBroken: boolean;
  /** Contents left (kg) for liquid-filled props. */
  fluidLeft: number | null;
  /** Peak deceleration of the vehicle COM (g), 5 ms filtered. */
  peakG: number;
}

function comOf(eng: SimEngine, id: number): [number, number, number, number, number, number, number] {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    if (s.invMass[i] === 0) continue;
    const mi = 1 / s.invMass[i]!;
    m += mi;
    x += mi * s.posX[i]!;
    y += mi * s.posY[i]!;
    z += mi * s.posZ[i]!;
    vx += mi * s.velX[i]!;
    vy += mi * s.velY[i]!;
    vz += mi * s.velZ[i]!;
  }
  return [x / m, y / m, z / m, vx / m, vy / m, vz / m, m];
}

export function runPropImpact(vehicle: VehicleDef, key: PropKey, speedKmh = 50, opts: { offsetX?: number; facing?: [number, number]; gap?: number } = {}): ImpactResult {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 8, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  eng.spawnVehicle(1, vehicle, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { brake: 0.4 });
  for (let t = 0; t < 1000; t++) eng.step();
  const veh = eng.getVehicle(1)!;
  const rig = veh.vehicle.rig;
  // The car's nose: min z of its body nodes (forward = −Z).
  let nose = Infinity;
  for (let i = 0; i < veh.vehicle.bodyNodeCount; i++) nose = Math.min(nose, eng.state.posZ[veh.nodeStart + i]!);
  const def = PROP_CATALOG[key];
  const f = opts.facing ?? [0, 1];
  // yaw quat for facing (fx, fz) = local −Z (sqrt-only form of props/placement facingQuat)
  const c = Math.sqrt(Math.max(0, (1 - f[1]) / 2));
  const sgn = (f[0] > 0 ? -1 : 1) * Math.sqrt(Math.max(0, (1 + f[1]) / 2));
  const q: [number, number, number, number] = [0, sgn, 0, c];
  // Rear face of the prop's proxy toward the car, `gap` m ahead of the nose.
  const hz = def.proxy.halfExtents[0]! * Math.abs(2 * sgn * c) + def.proxy.halfExtents[2]! * Math.abs(1 - 2 * sgn * sgn);
  const pz = nose - (opts.gap ?? 1.5) - hz;
  eng.spawnProp(4096, key, { pos: [opts.offsetX ?? 0, 0, pz], quat: q }, true);
  const prop = eng.arena.get(4096)!;
  const pc0 = comOf(eng, 4096);
  const sim: HandlingSim = { eng, obj: eng.arena.get(1)!, veh, cv: veh.vehicle, objectId: 1 };
  eng.setInput(1, { brake: 0, handbrake: 0, gearSelect: 0, throttle: 0 });
  const v0 = speedKmh / 3.6;
  setMotion(sim, v0, 0);
  let contact = -1;
  let v1 = NaN;
  let vPre = v0;
  let propSpeed = 0;
  let peakG = 0;
  let prevV = v0;
  let filt = 0;
  for (let t = 0; t < 2000 * 4; t++) {
    eng.step();
    if (t % 10 === 0) {
      const cc = comOf(eng, 1);
      const v = -cc[5];
      const a = (prevV - v) / (10 / 2000);
      prevV = v;
      filt += 0.5 * (a - filt);
      if (contact >= 0) peakG = Math.max(peakG, filt / 9.81);
      const pc = comOf(eng, 4096);
      const ps = Math.hypot(pc[3], pc[4], pc[5]);
      if (contact < 0 && ps > 0.05) contact = t;
      if (contact < 0) vPre = v;
      if (contact >= 0) propSpeed = Math.max(propSpeed, ps);
      // 0.5 s after contact, plus the coasting loss over that time (rate measured on the approach).
      if (contact >= 0 && Number.isNaN(v1) && t - contact >= 1000) v1 = v + ((v0 - vPre) / Math.max(1, contact)) * 1000;
    }
  }
  const pc1 = comOf(eng, 4096);
  const s = eng.state;
  let carPlastic = 0;
  let carBroken = 0;
  for (let b = veh.beamStart; b < veh.beamStart + veh.vehicle.bodyBeamCount; b++) {
    if (s.active[b] === 0) carBroken++;
    else if (Math.abs(s.restLen[b]! / s.restLen0[b]! - 1) > 0.005) carPlastic++;
  }
  let propBroken = 0;
  let propPlastic = 0;
  for (let b = prop.beamStart; b < prop.beamStart + prop.beamCount; b++) {
    if (s.active[b] === 0) propBroken++;
    else if (Math.abs(s.restLen[b]! / s.restLen0[b]! - 1) > 0.005) propPlastic++;
  }
  const rt = eng.getProp(4096)!;
  let anchorBroken = false;
  for (const ab of rt.anchorBeams) if (s.active[prop.beamStart + ab] === 0) anchorBroken = true;
  const propKg = (() => {
    const cr = compilePropRig(key);
    let m = 0;
    for (let i = 0; i < cr.nodeCount; i++) if (cr.nodeInvMass[i]! > 0) m += 1 / cr.nodeInvMass[i]!;
    return m;
  })();
  const carKg = veh.vehicle.totalMass;
  void rig;
  return {
    key,
    propKg,
    carKg,
    v0,
    vPre,
    v1,
    dvKmh: (vPre - v1) * 3.6,
    dvInelasticKmh: (vPre * 3.6 * propKg) / (carKg + propKg),
    propSpeed,
    propMoved: Math.hypot(pc1[0] - pc0[0], pc1[2] - pc0[2]),
    carPlastic,
    carBroken,
    propBroken,
    propPlastic,
    anchorBroken,
    fluidLeft: rt.fluid ? rt.fluid.remaining : null,
    peakG,
  };
}
