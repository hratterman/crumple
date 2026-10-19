/**
 * Driver assists (P5 integration): traction control on/off via
 * `SimEngine.setAssists` / the `setAssists` protocol message. With TC off
 * the sedan can do a burnout (throttle + service brake at standstill): the
 * rear brakes (front bias 0.6) hold less than first-gear torque, so the
 * driven wheels spin up; with TC on the throttle is cut instead.
 */
import { describe, expect, it } from 'vitest';
import type { MainToWorker, WorkerToMain } from '../../protocol/messages';
import { WorkerHost } from '../worker';
import { createHandlingSim, stepN } from './handling';
import { SEDAN } from './defs/sedan';

/** Max rear tyre slip (m/s) over a 2 s throttle + brake hold from standstill. */
function burnout(tc: boolean): { rearSlip: number; frontSlip: number; travelled: number } {
  const sim = createHandlingSim();
  stepN(sim, 1000); // settle
  if (!tc) sim.eng.setAssists(1, { tractionControl: false });
  sim.eng.setInput(1, { throttle: 1, brake: 1, gearSelect: 1 });
  const s = sim.eng.state;
  const o = sim.obj.nodeStart;
  const x0 = s.posZ[o]!;
  let rearSlip = 0;
  let frontSlip = 0;
  for (let t = 0; t < 4000; t++) {
    sim.eng.step();
    if (t % 20 !== 0) continue;
    // Tread speed relative to the (nearly still) car: the tyre slip the FX read.
    for (const w of sim.veh.wheels) {
      const v = Math.abs(w.omega * w.rollRadius);
      if (w.wheel.driven) rearSlip = Math.max(rearSlip, v);
      else frontSlip = Math.max(frontSlip, v);
    }
  }
  return { rearSlip, frontSlip, travelled: Math.abs(s.posZ[o]! - x0) };
}

describe('driver assists', () => {
  it('TC on (default) holds a throttle + brake launch; TC off lets the rears spin (burnout)', () => {
    const on = burnout(true);
    const off = burnout(false);
    console.log(`[assists] burnout 2 s: TC on rear slip ${on.rearSlip.toFixed(1)} m/s, TC off ${off.rearSlip.toFixed(1)} m/s (front ${off.frontSlip.toFixed(1)}, moved ${off.travelled.toFixed(2)} m)`);
    expect(on.rearSlip).toBeLessThan(3);
    // Above the FX tyre-smoke (3 m/s) and skidmark (2 m/s) thresholds, fronts held by the brakes.
    expect(off.rearSlip).toBeGreaterThan(6);
    expect(off.frontSlip).toBeLessThan(1);
    expect(off.travelled).toBeLessThan(2);
  }, 60_000);

  it('setAssists keeps TC across reset, validates input; the worker message toggles it', () => {
    const sim = createHandlingSim();
    expect(sim.veh.drivetrain.tractionControl).toBe(true);
    sim.eng.setAssists(1, { tractionControl: false });
    sim.eng.reset(1, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
    expect(sim.veh.drivetrain.tractionControl).toBe(false);
    sim.eng.setAssists(1, {});
    expect(sim.veh.drivetrain.tractionControl).toBe(false);
    expect(() => sim.eng.setAssists(1, { tractionControl: 1 as unknown as boolean })).toThrow();
    expect(() => sim.eng.setAssists(9, { tractionControl: true })).toThrow();

    const out: WorkerToMain[] = [];
    const host = new WorkerHost((m) => out.push(m), { now: () => 0, schedule: () => {} });
    const send = (m: MainToWorker): void => host.handle(m);
    send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 2048, beamCapacity: 8192 } });
    send({ type: 'ground', mode: 'plane', y: 0, materialId: 0 });
    send({ type: 'spawnVehicle', objectId: 3, vehicle: SEDAN, transform: { pos: [0, 0.05, 0], quat: [0, 0, 0, 1] } });
    send({ type: 'setAssists', objectId: 3, tractionControl: false });
    expect(host.engine!.getVehicle(3)!.drivetrain.tractionControl).toBe(false);
    send({ type: 'setAssists', objectId: 3, tractionControl: true });
    expect(host.engine!.getVehicle(3)!.drivetrain.tractionControl).toBe(true);
    expect(out.filter((m) => m.type === 'error')).toEqual([]);
    send({ type: 'setAssists', objectId: 77, tractionControl: true });
    expect(out.filter((m) => m.type === 'error').map((e) => (e as { command: string }).command)).toEqual(['setAssists']);
  });
});
