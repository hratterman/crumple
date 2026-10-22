/**
 * Dolly rollover harness (R-PHYS2, tests / tools): FMVSS 208's dolly
 * rollover set-up — the vehicle tilted 23° toward its leading side, moving
 * sideways at `speedKmh` with its leading tyres a few cm above the ground,
 * tripped by a 10 cm flange (the dolly's curb: here a static kerb box just
 * ahead of the leading tyres, which is what the decelerating dolly's flange
 * does to the car) — on flat ground of `materialId`. Measures how a whole wreck tumbles:
 * accumulated roll (quarter turns), peak and decaying roll rate, travel and
 * mean deceleration (the reconstructionists' rollover drag factor), and the
 * COM's bounce.
 *
 * Reference (staged dolly rollovers, 48 km/h passenger cars: Orlowski et al.
 * SAE 851730, Cooperrider et al. SAE 900366, Carter et al. SAE 2002-01-0694):
 * the vehicle rolls ≈ 4–10 quarter turns over ≈ 20–40 m in ≈ 3–5 s, peak
 * roll rates 250–500 °/s, a drag factor v²/(2·g·d) of ≈ 0.38–0.5, roll rate decaying in bursts at each ground contact (not a
 * ball's elastic bouncing, not a sliding brick).
 */
import { MaterialId } from '../../protocol/messages';
import { SimEngine } from '../engine';
import type { VehicleDef } from '../vehicle/types';

export interface DollyResult {
  /** Accumulated roll about the body's long axis, quarter turns. */
  quarterTurns: number;
  peakRollRateDeg: number;
  /** Roll rate (deg/s) sampled every 50 ms. */
  rollRate: number[];
  /** Lateral travel of the COM until it came to rest (or the end), m. */
  travel: number;
  /** Time until the COM speed fell below 0.5 m/s, s. */
  duration: number;
  /** Drag factor v0² / (2·g·travel) — the reconstructionists' rollover drag factor. */
  dragG: number;
  /** Highest COM rise above its launch height, m. */
  bounce: number;
  /** Final roof-up (+1) / on its side (0) / on its roof (−1) — up vector · world Y. */
  finalUp: number;
  /** Body beams broken / plastically deformed. */
  broken: number;
  plastic: number;
}

export function runDollyRollover(def: VehicleDef, speedKmh = 48, materialId: number = MaterialId.dirt, seconds = 7): DollyResult {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, materialId);
  eng.enableSoftGround();
  // Roll 23° about the long axis (−Z): leading side (+X, the travel direction) down.
  const a = (-23 * Math.PI) / 180;
  const q: [number, number, number, number] = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
  eng.spawnVehicle(1, def, { pos: [0, 2, 0], quat: q }, 'auto');
  const s = eng.state;
  const o = eng.arena.get(1)!;
  const v = eng.getVehicle(1)!;
  // Lowest node 6 cm above the ground.
  let ymin = Infinity;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) ymin = Math.min(ymin, s.posY[i]! - s.radius[i]!);
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) s.posY[i] = s.posY[i]! - ymin + 0.06;
  // The trip flange: 10 cm above the leading tyres' bottom (the dolly's platform), 6 m long, 2 cm ahead of
  // the leading (+X) tyres.
  let xmax = -Infinity;
  let ywheel = Infinity;
  for (const w of v.wheels) {
    for (let k = 0; k < w.ringCount; k++) {
      const i = w.tireStart + k;
      xmax = Math.max(xmax, s.posX[i]! + s.radius[i]!);
      ywheel = Math.min(ywheel, s.posY[i]! - s.radius[i]!);
    }
  }
  const top = ywheel + 0.1;
  eng.setExtraColliders([{ id: 'flange', kind: 'box', pos: [xmax + 0.02 + 0.1, top / 2, 0], quat: [0, 0, 0, 1], size: [0.1, top / 2, 3], material: MaterialId.concrete }]);
  const v0 = speedKmh / 3.6;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) s.velX[i] = v0;
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
  const f = v.vehicle.frameNodes;
  const fo = o.nodeStart + f[0]!;
  const ff = o.nodeStart + f[1]!;
  const ft = o.nodeStart + f[2]!;
  const basis = (): [number, number, number, number, number, number] => {
    let fx = s.posX[ff]! - s.posX[fo]!;
    let fy = s.posY[ff]! - s.posY[fo]!;
    let fz = s.posZ[ff]! - s.posZ[fo]!;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    let ux = s.posX[ft]! - s.posX[fo]!;
    let uy = s.posY[ft]! - s.posY[fo]!;
    let uz = s.posZ[ft]! - s.posZ[fo]!;
    const d = ux * fx + uy * fy + uz * fz;
    ux -= d * fx;
    uy -= d * fy;
    uz -= d * fz;
    const ul = Math.hypot(ux, uy, uz);
    return [fx, fy, fz, ux / ul, uy / ul, uz / ul];
  };
  const com = (): [number, number, number, number] => {
    let m = 0;
    let x = 0;
    let y = 0;
    let vx = 0;
    let vz = 0;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      const mi = 1 / s.invMass[i]!;
      m += mi;
      x += mi * s.posX[i]!;
      y += mi * s.posY[i]!;
      vx += mi * s.velX[i]!;
      vz += mi * s.velZ[i]!;
    }
    return [x / m, y / m, Math.hypot(vx, vz) / m, 0];
  };
  const c0 = com();
  let prevUp = basis();
  let roll = 0;
  let peak = 0;
  const rate: number[] = [];
  let bounce = 0;
  let duration = seconds;
  let travel = 0;
  for (let t = 1; t <= seconds * 2000; t++) {
    eng.step();
    if (t % 100 !== 0) continue;
    const b = basis();
    // Rotation of the up vector about the (current) long axis since the last sample.
    const crossx = prevUp[4] * b[5] - prevUp[5] * b[4];
    const crossy = prevUp[5] * b[3] - prevUp[3] * b[5];
    const crossz = prevUp[3] * b[4] - prevUp[4] * b[3];
    const sinA = crossx * b[0] + crossy * b[1] + crossz * b[2];
    const cosA = prevUp[3] * b[3] + prevUp[4] * b[4] + prevUp[5] * b[5];
    const dA = Math.atan2(sinA, cosA);
    roll += dA;
    const r = Math.abs((dA * 180) / Math.PI) / 0.05;
    rate.push(r);
    peak = Math.max(peak, r);
    prevUp = b;
    const c = com();
    bounce = Math.max(bounce, c[1] - c0[1]);
    if (duration === seconds && c[2] < 0.5 && t > 2000) {
      duration = t / 2000;
      travel = c[0] - c0[0];
    }
  }
  if (duration === seconds) travel = com()[0] - c0[0];
  let broken = 0;
  let plastic = 0;
  for (let bi = o.beamStart; bi < o.beamStart + v.vehicle.bodyBeamCount; bi++) {
    if (s.active[bi] === 0) broken++;
    else if (Math.abs(s.restLen[bi]! / s.restLen0[bi]! - 1) > 0.005) plastic++;
  }
  const fin = basis();
  return {
    quarterTurns: Math.abs(roll) / (Math.PI / 2),
    peakRollRateDeg: peak,
    rollRate: rate,
    travel,
    duration,
    dragG: (v0 * v0) / (2 * 9.81 * (travel > 0.1 ? travel : 0.1)),
    bounce,
    finalUp: fin[4],
    broken,
    plastic,
  };
}
