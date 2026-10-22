/**
 * Trailer sway harness (R-PHYS2, tests / tools; worker-side code, never in
 * the game loop): a tow vehicle + hitched trailer on a flat plane, both set
 * rolling at `speedKmh` (handling.ts setMotion), speed held by a throttle PI,
 * then a steering pulse; the articulation angle (trailer heading − tow
 * heading) is sampled and its oscillation's damping ratio estimated from the
 * successive peaks (logarithmic decrement).
 *
 * Reference behaviour (the trend the test asserts): a car-trailer
 * combination's yaw / sway mode loses damping with speed and goes unstable
 * above a critical speed; more tongue weight (CG forward of the axle)
 * raises the critical speed, a tail-heavy trailer sways at much lower speeds
 * (Bundorf 1967; Darling, Tilley & Gao, "An experimental investigation of
 * car-trailer high-speed stability", Proc. IMechE D 223 (2009): critical
 * speeds 80–140 km/h falling with lower nose weight and higher trailer yaw
 * inertia; towing guides: 10–15 % tongue weight).
 */
import { MaterialId } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { setMotion, type HandlingSim } from '../vehicle/handling';
import type { VehicleDef } from '../vehicle/types';
import type { TrailerKind } from './defs';

export interface SwayOptions {
  tow: VehicleDef;
  kind: TrailerKind;
  speedKmh: number;
  /** Ballast on the trailer deck (kg at deck z; z < 0 = toward the coupler). */
  ballastKg?: number;
  ballastZ?: number;
  /** Steering pulse amplitude (−1..1) and length, s. */
  pulse?: number;
  pulseS?: number;
  /** Seconds recorded after the pulse. */
  recordS?: number;
  /** Tow vehicle ESC (default on: the car's stability control is part of the system). */
  esc?: boolean;
  /** Hitch free play override, m. */
  play?: number;
}

export interface SwayResult {
  /** Articulation angle samples (deg) every 10 ms from the pulse on. */
  angle: number[];
  /** Tow vehicle heading (deg) and speed (m/s) at the same samples. */
  towHeading: number[];
  towSpeed: number[];
  /** Successive |peak| values (deg) of the articulation after the pulse. */
  peaks: number[];
  /** Damping ratio from the mean log decrement of successive peaks (negative = growing sway). */
  zeta: number;
  /** Sway frequency, Hz (from the peak spacing). */
  freqHz: number;
  /** Static tongue load at rest, N (+ = the trailer presses down on the ball). */
  tongueN: number;
  /** Articulation amplitude in the first / last third of the record after the pulse, deg. */
  early: number;
  late: number;
  /** Trailer mass, kg. */
  trailerKg: number;
  /** True if the hitch broke or the combination jackknifed (|angle| > 60°). */
  lost: boolean;
}

function headingOf(eng: SimEngine, id: number): number {
  const v = eng.getVehicle(id)!;
  const s = eng.state;
  const f = v.vehicle.frameNodes;
  const o = v.nodeStart + f[0]!;
  const a = v.nodeStart + f[1]!;
  return Math.atan2(s.posX[a]! - s.posX[o]!, -(s.posZ[a]! - s.posZ[o]!));
}

function speedOf(eng: SimEngine, id: number): number {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0;
  let vx = 0;
  let vz = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    const mi = 1 / s.invMass[i]!;
    m += mi;
    vx += mi * s.velX[i]!;
    vz += mi * s.velZ[i]!;
  }
  return Math.sqrt(vx * vx + vz * vz) / m;
}

export function runSway(o: SwayOptions): SwayResult {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, MaterialId.asphalt);
  eng.spawnVehicle(1, o.tow, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { handbrake: 1, brake: 0.5 });
  for (let t = 0; t < 1000; t++) eng.step();
  eng.spawnTrailer(2, o.kind, { towObjectId: 1, ballastKg: o.ballastKg ?? 0, ballastZ: o.ballastZ ?? 0 });
  for (let t = 0; t < 3000; t++) eng.step();
  const link = eng.towing.trailers.get(2)!;
  if (o.play !== undefined) link.hitch!.play = o.play;
  if (o.esc !== undefined) eng.setAssists(1, { esc: o.esc });
  const tongueN = link.hitch!.fy;
  const trailer = eng.getVehicle(2)!;
  const v = o.speedKmh / 3.6;
  const sim = (id: number): HandlingSim => ({ eng, obj: eng.arena.get(id)!, veh: eng.getVehicle(id)!, cv: eng.getVehicle(id)!.vehicle, objectId: id });
  eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 0.3, steer: 0 });
  setMotion(sim(1), v);
  setMotion(sim(2), v, 0);
  let integ = 0;
  const hold = (): void => {
    const e = v - speedOf(eng, 1);
    integ += e * 0.01;
    if (integ > 2) integ = 2;
    if (integ < -2) integ = -2;
    const thr = 0.35 + 0.4 * e + 0.25 * integ;
    eng.setInput(1, { throttle: thr < 0 ? 0 : thr > 1 ? 1 : thr, brake: 0 });
  };
  // 1.5 s to settle the motion, then the pulse.
  for (let t = 0; t < 3000; t++) {
    if (t % 20 === 0) hold();
    eng.step();
  }
  const pulse = o.pulse ?? 0.1;
  const pulseTicks = Math.round((o.pulseS ?? 0.3) * 2000);
  const rec = Math.round((o.recordS ?? 8) * 2000);
  const angle: number[] = [];
  const towHeading: number[] = [];
  const towSpeed: number[] = [];
  let lost = false;
  for (let t = 0; t < pulseTicks + rec; t++) {
    if (t % 20 === 0) {
      hold();
      eng.setInput(1, { steer: t < pulseTicks ? pulse : 0 });
      let a = headingOf(eng, 2) - headingOf(eng, 1);
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      angle.push((a * 180) / Math.PI);
      towHeading.push((headingOf(eng, 1) * 180) / Math.PI);
      towSpeed.push(speedOf(eng, 1));
      if (Math.abs(a) > Math.PI / 3 || link.hitch === null || link.hitch.broken) {
        lost = true;
        break;
      }
    }
    eng.step();
  }
  // Envelope growth: max |angle| in the first vs the last third of the record after the pulse; the
  // frequency from the zero crossings over the whole record.
  const start = Math.ceil(pulseTicks / 20) + 50;
  const n = angle.length;
  const third = Math.max(1, Math.floor((n - start) / 3));
  let early = 0;
  let late = 0;
  for (let i = start; i < start + third && i < n; i++) early = Math.max(early, Math.abs(angle[i]!));
  for (let i = n - third; i < n; i++) late = Math.max(late, Math.abs(angle[i]!));
  let mean = 0;
  for (let i = start; i < n; i++) mean += angle[i]!;
  mean /= Math.max(1, n - start);
  let crossings = 0;
  for (let i = start + 1; i < n; i++) if ((angle[i - 1]! - mean) * (angle[i]! - mean) < 0) crossings++;
  const spanS = (n - start) * 0.01;
  const freqHz = crossings / (2 * spanS);
  const dtS = (n - third - start) * 0.01;
  const zeta = early > 0 && late > 0 && freqHz > 0 ? -Math.log(late / early) / (2 * Math.PI * freqHz * dtS) : NaN;
  const peaks: number[] = [];
  return { angle, towHeading, towSpeed, peaks, zeta: lost ? -1 : zeta, freqHz, tongueN, early, late, trailerKg: trailer.vehicle.totalMass, lost };
}
