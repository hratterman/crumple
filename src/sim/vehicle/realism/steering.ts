/**
 * Steering-system metrics (harness only, steering.ts): parking effort at a
 * standstill and the on-centre / ramp-steer torque build-up at speed.
 */
import { createHandlingSim, kinematics, setMotion, stepN } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import type { SteeringState } from '../steering';
import type { VehicleDef } from '../types';

const DT = 1 / 2000;

export interface SteerSample {
  t: number;
  /** Hands (steer action) and rack position, −1..1. */
  hands: number;
  rack: number;
  /** Driver torque at the steering wheel, N·m (+ = toward + steer). */
  torque: number;
  /** Tie-rod load torque at the pinion, N·m, and the same as the total kingpin moment (× ratio), N·m. */
  load: number;
  kingpin: number;
  /** Lateral acceleration v·r, g (+ = toward + steer, i.e. right). */
  latG: number;
  speed: number;
}

function steeringOf(veh: VehicleRuntimeEx): SteeringState {
  const s = veh.steeringSys;
  if (!s) throw new Error('vehicle has no steering system');
  return s;
}

/** Standstill (service brake held): hands ramp 0 → `to` over `rampS`, then hold. Samples at 100 Hz. */
export function runParking(def: VehicleDef, to = 1, rampS = 3, holdS = 1): SteerSample[] {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const veh = sim.veh as VehicleRuntimeEx;
  const ss = steeringOf(veh);
  const out: SteerSample[] = [];
  const n = Math.round((rampS + holdS) / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const hands = to * Math.min(1, t / rampS);
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0.3, steer: hands });
    sim.eng.step();
    if (i % 20 === 19) out.push({ t, hands, rack: ss.th / ss.thLock, torque: ss.torque, load: ss.load, kingpin: ss.load * ss.spec.ratio, latG: 0, speed: 0 });
  }
  return out;
}

/**
 * Constant-speed ramp steer: hands ramp 0 → `to` over `rampS` after 0.5 s
 * straight, speed held by a throttle I controller. Lateral g = speed × the
 * velocity's course rate (0.1 s differences; not the yaw rate, which
 * swings with the body at the limit). Samples at 100 Hz.
 */
export function runRampSteer(def: VehicleDef, kmh: number, to: number, rampS: number): SteerSample[] {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const v0 = kmh / 3.6;
  setMotion(sim, v0);
  const veh = sim.veh as VehicleRuntimeEx;
  const ss = steeringOf(veh);
  const out: SteerSample[] = [];
  const n = Math.round((rampS + 0.5) / DT);
  const hist: number[] = [];
  let thr = 0.3;
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const hands = to * Math.min(1, Math.max(0, (t - 0.5) / rampS));
    if (i % 20 === 0) {
      const k = kinematics(sim);
      const v = k.vx * k.fx + k.vz * k.fz;
      thr = Math.min(1, Math.max(0, thr + 0.02 * (v0 - v)));
    }
    sim.eng.setInput(1, { gearSelect: 1, throttle: thr, brake: 0, steer: hands });
    sim.eng.step();
    if (i % 20 === 19) {
      const k = kinematics(sim);
      const h = Math.atan2(k.vx, -k.vz);
      hist.push(h);
      const speed = Math.hypot(k.vx, k.vz);
      let latG = 0;
      if (hist.length > 10) {
        let dh = h - hist[hist.length - 11]!;
        if (dh > Math.PI) dh -= 2 * Math.PI;
        if (dh < -Math.PI) dh += 2 * Math.PI;
        latG = (speed * dh) / 0.1 / 9.81;
      }
      out.push({ t, hands, rack: ss.th / ss.thLock, torque: ss.torque, load: ss.load, kingpin: ss.load * ss.spec.ratio, latG, speed });
    }
  }
  return out;
}

/**
 * Rack force limit (harness): a parked car (service brake on, hands at centre) gets a steering moment on its
 * front-left wheel — an equal and opposite fore-aft force pair `forceN` across the hub, ramped over 0.1 s and
 * held to 0.4 s. Returns the largest rack excursion (fraction of lock) and the peak tie-rod force.
 */
export function runWheelMoment(def: VehicleDef, forceN: number): { rackMax: number; peakTieRod: number; holdMax: number } {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  const ss = steeringOf(sim.veh as VehicleRuntimeEx);
  ss.peakForce = 0;
  const fl = sim.veh.wheels.find((w) => w.wheel.corner === 0)!;
  const s = sim.eng.state;
  let rackMax = 0;
  for (let i = 0; i < 1000; i++) {
    const f = i < 800 ? forceN * Math.min(1, i / 200) : 0;
    s.velZ[fl.hubO]! -= f * s.invMass[fl.hubO]! * DT;
    s.velZ[fl.hubI]! += f * s.invMass[fl.hubI]! * DT;
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1, steer: 0 });
    sim.eng.step();
    const r = Math.abs(ss.th / ss.thLock);
    if (r > rackMax) rackMax = r;
  }
  return { rackMax, peakTieRod: ss.peakForce, holdMax: ss.holdMax };
}

/** Peak tie-rod force (N) of a full step steer (hands to `steer` at t = 0.5 s) at `kmh`, light throttle. */
export function stepSteerTieRod(def: VehicleDef, steer: number, kmh: number): number {
  const sim = createHandlingSim({ def });
  stepN(sim, 3000);
  setMotion(sim, kmh / 3.6);
  const ss = steeringOf(sim.veh as VehicleRuntimeEx);
  ss.peakForce = 0;
  for (let i = 0; i < 6000; i++) {
    sim.eng.setInput(1, { gearSelect: 1, throttle: 0.3, steer: i > 1000 ? steer : 0 });
    sim.eng.step();
  }
  return ss.peakForce;
}
