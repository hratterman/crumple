/**
 * Engine rock metrics (harness only): the powertrain's roll (longitudinal
 * engine, about the crank) or pitch (transverse) on its mounts relative to
 * the body, and the body's own roll, through a free-revving blip in neutral
 * and a full-throttle launch in 1st.
 */
import { attitudeOf, createHandlingSim, stepN, type HandlingSim } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import type { VehicleDef } from '../types';

const DT = 1 / 2000;

function nodeIdx(sim: HandlingSim, id: string): number {
  return sim.obj.nodeStart + sim.cv.rig.nodeIds.indexOf(id);
}

/** Block angle relative to the body, rad: roll about the crank for a longitudinal engine (+ = right side down), pitch (front down +) for a transverse one. */
export function blockAngle(sim: HandlingSim, transverse: boolean): number {
  const s = sim.eng.state;
  const fr = sim.cv.frameNodes;
  const o = sim.obj.nodeStart + fr[0]!;
  const t = sim.obj.nodeStart + fr[2]!;
  // body up vector
  let ux = s.posX[t]! - s.posX[o]!;
  let uy = s.posY[t]! - s.posY[o]!;
  let uz = s.posZ[t]! - s.posZ[o]!;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const [a, b] = transverse ? ['eng_fhi_L', 'eng_rhi_L'] : ['eng_fhi_L', 'eng_fhi_R'];
  const ia = nodeIdx(sim, a);
  const ib = nodeIdx(sim, b);
  const dx = s.posX[ib]! - s.posX[ia]!;
  const dy = s.posY[ib]! - s.posY[ia]!;
  const dz = s.posZ[ib]! - s.posZ[ia]!;
  const l = Math.hypot(dx, dy, dz);
  // component of the block's L→R (or front→rear) axis along body-up: sin(angle)
  return Math.asin((dx * ux + dy * uy + dz * uz) / l);
}

export interface RockResult {
  /** Peak |block angle change| during the event, deg; body roll peak change, deg. */
  blockDeg: number;
  bodyRollDeg: number;
  trace: [number, number, number][];
}

export function runRock(def: VehicleDef, kind: 'blip' | 'launch'): RockResult {
  const sim = createHandlingSim({ def });
  sim.eng.setAssists(1, { tractionControl: false, esc: false });
  stepN(sim, 4000);
  const tr = (sim.veh as VehicleRuntimeEx).engineTransverse;
  const b0 = blockAngle(sim, tr);
  const r0 = attitudeOf(sim).roll;
  let bMax = 0;
  let rMax = 0;
  const trace: [number, number, number][] = [];
  const n = Math.round(1.5 / DT);
  for (let t = 0; t < n; t++) {
    const time = t * DT;
    if (kind === 'blip') sim.eng.setInput(1, { gearSelect: 0, throttle: time < 0.25 ? 1 : 0, brake: 1 });
    else sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0 });
    sim.eng.step();
    const b = ((blockAngle(sim, tr) - b0) * 180) / Math.PI;
    const r = ((attitudeOf(sim).roll - r0) * 180) / Math.PI;
    if (Math.abs(b) > Math.abs(bMax)) bMax = b;
    if (Math.abs(r) > Math.abs(rMax)) rMax = r;
    if (t % 20 === 0) trace.push([time, b, r]);
  }
  return { blockDeg: bMax, bodyRollDeg: rMax, trace };
}
