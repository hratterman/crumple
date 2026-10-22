/**
 * R-PHYS ext telemetry section (layout.ts HDR_VEHICLE_EXT_OFFSET_BYTE,
 * telemetry.ts VehicleTelemetryExt): written with every snapshot.
 */
import { describe, expect, it } from 'vitest';
import { BufferPool, SnapshotReader, SnapshotWriter } from '../../protocol/codec';
import { computeSnapshotLayout } from '../../protocol/layout';
import {
  EXT_ASSIST_ABS_ON,
  EXT_ASSIST_ESC_ON,
  EXT_ASSIST_TC_ON,
  EXT_ENGINE_RUNNING,
  createVehicleTelemetryExtFrame,
  readVehicleTelemetryExt,
} from '../../protocol/telemetry';
import { SimEngine } from '../engine';
import { SEDAN } from './defs/sedan';

const CAP = { maxObjects: 4, nodeCapacity: 2048, beamCapacity: 8192 };

describe('vehicle ext telemetry', () => {
  it('a parked sedan reports warm coolant, 45 of 60 L fuel, full oil, ambient brake discs, engine running, ABS/ESC/TC on; a plain rig reads zeros', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
    eng.setGroundPlane(0, 0);
    eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
    eng.spawn(9, { name: 'p', nodes: [{ id: 'a', pos: [0, 0, 0], mass: 1 }], beams: [] }, { pos: [0, 9, 0], quat: [0, 0, 0, 1] });
    for (let t = 0; t < 500; t++) eng.step();
    const layout = computeSnapshotLayout(CAP.maxObjects, CAP.nodeCapacity, CAP.beamCapacity, false);
    const buf = new BufferPool(layout.totalBytes).acquire()!;
    eng.writeSnapshot(new SnapshotWriter(layout).attach(buf));
    const r = new SnapshotReader().attach(buf);
    expect(r.hasTelemetryExt).toBe(true);
    const x = readVehicleTelemetryExt(r.objectTelemetryExt(0), createVehicleTelemetryExtFrame());
    expect(x.present).toBe(true);
    expect(x.coolantTemp).toBeGreaterThan(85);
    expect(x.coolantTemp).toBeLessThan(95);
    expect(x.fuel).toBeCloseTo(45, 1);
    expect(x.fuelTank).toBe(60);
    expect(x.oilLevel).toBe(1);
    expect(x.engineHealth).toBe(1);
    for (const tC of x.brakeTemp) expect(tC).toBeCloseTo(25, 0);
    expect(x.engineBits & EXT_ENGINE_RUNNING).toBe(EXT_ENGINE_RUNNING);
    expect(x.assistBits & (EXT_ASSIST_ABS_ON | EXT_ASSIST_ESC_ON | EXT_ASSIST_TC_ON)).toBe(EXT_ASSIST_ABS_ON | EXT_ASSIST_ESC_ON | EXT_ASSIST_TC_ON);
    const p = r.objectTelemetryExt(1)!;
    for (let s = 0; s < p.length; s++) expect(p[s]).toBe(0);
  });
});
