import { describe, expect, it } from 'vitest';

import { SnapshotReader, SnapshotWriter } from './codec';
import { computeSnapshotLayout, HDR_TRAFFIC_OFFSET_BYTE, SNAPSHOT_FLAG_TRAFFIC, TRAFFIC_SECTION_BYTES } from './layout';
import {
  createTrafficAgentFrame,
  isTrafficObjectId,
  TRAFFIC_FLAG_AWAKE,
  TRAFFIC_FLAG_BRAKE,
  TRAFFIC_FLAG_INDICATOR_L,
  TRAFFIC_ID_BASE,
  TRAFFIC_MAX_AGENTS,
  trafficAgentOfObject,
  TrafficAiState,
} from './traffic';
import { PROP_LAYOUT_ID_BASE } from './messages';

function snapshot(): { w: SnapshotWriter; buf: ArrayBuffer } {
  const L = computeSnapshotLayout(8, 64, 128, false);
  const buf = new ArrayBuffer(L.totalBytes);
  const w = new SnapshotWriter(L).attach(buf);
  w.begin(40, 0.02, 1);
  return { w, buf };
}

describe('traffic protocol (P6)', () => {
  it('id range sits in the vehicle range, below props', () => {
    expect(isTrafficObjectId(TRAFFIC_ID_BASE)).toBe(true);
    expect(isTrafficObjectId(TRAFFIC_ID_BASE + TRAFFIC_MAX_AGENTS)).toBe(false);
    expect(isTrafficObjectId(1)).toBe(false);
    expect(TRAFFIC_ID_BASE + TRAFFIC_MAX_AGENTS).toBeLessThanOrEqual(PROP_LAYOUT_ID_BASE);
    expect(trafficAgentOfObject(TRAFFIC_ID_BASE + 5)).toBe(5);
    expect(trafficAgentOfObject(7)).toBe(-1);
  });

  it('the section follows the broken bitset, 16-byte aligned, always flagged', () => {
    const L = computeSnapshotLayout(8, 64, 128, true);
    expect(L.trafficOffset % 16).toBe(0);
    expect(L.trafficOffset).toBeGreaterThan(L.brokenOffset);
    expect(L.totalBytes).toBeGreaterThanOrEqual(L.trafficOffset + TRAFFIC_SECTION_BYTES);
    const { buf } = snapshot();
    const r = new SnapshotReader().attach(buf);
    expect(r.flags & SNAPSHOT_FLAG_TRAFFIC).toBe(SNAPSHOT_FLAG_TRAFFIC);
    expect(new Uint32Array(buf, HDR_TRAFFIC_OFFSET_BYTE, 1)[0]).toBeGreaterThan(0);
    expect(r.trafficCount).toBe(0);
  });

  it('round-trips records and the worker load; begin() clears them', () => {
    const { w, buf } = snapshot();
    const a = createTrafficAgentFrame();
    a.agent = 3;
    a.objectId = TRAFFIC_ID_BASE + 3;
    a.flags = TRAFFIC_FLAG_AWAKE | TRAFFIC_FLAG_BRAKE;
    a.variant = 1;
    a.paint = 6;
    a.state = TrafficAiState.follow;
    a.pos = [10.5, 2.25, -300];
    a.quat = [0, 0.5, 0, 0.75]; // f32-exact values (the record is f32)
    a.speed = 21.5;
    a.steer = -0.25;
    a.brake = 0.5;
    a.path = 17;
    expect(w.pushTrafficAgent(a)).toBe(0);
    const b = { ...createTrafficAgentFrame(), agent: 9, flags: TRAFFIC_FLAG_INDICATOR_L, paint: 65535, path: 2 };
    expect(w.pushTrafficAgent(b)).toBe(1);
    expect(() => w.pushTrafficAgent(a)).toThrow(RangeError); // not ascending
    w.setWorkerLoad(0.42);

    const r = new SnapshotReader().attach(buf);
    expect(r.trafficCount).toBe(2);
    expect(r.workerLoad).toBeCloseTo(0.42, 6);
    expect(r.findTrafficAgent(9)).toBe(1);
    expect(r.findTrafficAgent(4)).toBe(-1);
    const out = createTrafficAgentFrame();
    r.readTrafficAgent(0, out);
    expect(out).toEqual({ ...a, nodesReady: false });
    r.readTrafficAgent(1, out);
    expect([out.agent, out.flags, out.paint, out.variant, out.path]).toEqual([9, TRAFFIC_FLAG_INDICATOR_L, 65535, 0, 2]);

    w.begin(80, 0.04, 1);
    const r2 = new SnapshotReader().attach(buf);
    expect(r2.trafficCount).toBe(0);
    expect(r2.workerLoad).toBe(0);
  });

  it('caps the section at TRAFFIC_MAX_AGENTS', () => {
    const { w } = snapshot();
    const a = createTrafficAgentFrame();
    for (let i = 0; i < TRAFFIC_MAX_AGENTS; i++) {
      a.agent = i;
      w.pushTrafficAgent(a);
    }
    a.agent = TRAFFIC_MAX_AGENTS;
    expect(() => w.pushTrafficAgent(a)).toThrow(RangeError);
  });
});
