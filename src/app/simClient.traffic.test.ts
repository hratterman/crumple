/**
 * SimClient traffic accessors (P6 pre-wired seam) against a stub Worker:
 * setTraffic resolution/rejection, ghost pose interpolation, TELEPORTED,
 * and the `nodesReady` hand-over flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotWriter } from '../protocol/codec';
import { computeSnapshotLayout } from '../protocol/layout';
import type { MainToWorker, WorkerToMain } from '../protocol/messages';
import { createTrafficAgentFrame, TRAFFIC_FLAG_AWAKE, TRAFFIC_FLAG_TELEPORTED, TRAFFIC_ID_BASE, type TrafficAgentFrame } from '../protocol/traffic';
import { SimClient } from './simClient';

class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: MainToWorker[] = [];
  onmessage: ((ev: { data: WorkerToMain }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: MainToWorker): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  reply(msg: WorkerToMain): void {
    this.onmessage!({ data: msg });
  }
}

const L = computeSnapshotLayout(4, 16, 16, false);
function snap(tick: number, agents: TrafficAgentFrame[], awakeObject = false): ArrayBuffer {
  const buf = new ArrayBuffer(L.totalBytes);
  const w = new SnapshotWriter(L).attach(buf);
  w.begin(tick, tick / 2000, 1);
  if (awakeObject) w.addObject(TRAFFIC_ID_BASE, 0, 4, 2);
  for (const a of agents) w.pushTrafficAgent(a);
  w.setWorkerLoad(0.5);
  return buf;
}
function agent(over: Partial<TrafficAgentFrame>): TrafficAgentFrame {
  return { ...createTrafficAgentFrame(), ...over };
}

describe('SimClient traffic (P6)', () => {
  let saved: unknown;
  beforeEach(() => {
    const g = globalThis as { Worker?: unknown };
    saved = g.Worker;
    g.Worker = FakeWorker;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = saved;
    vi.restoreAllMocks();
  });

  it('setTraffic resolves with trafficReady and rejects when unimplemented', async () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    const density = { agents: 4, maxAwake: 1, awakePoolBeams: 2500 };
    const p = client.setTraffic({ enabled: true, seed: 7, variants: [], density, focusObjectId: 1 });
    expect(w.sent.at(-1)).toMatchObject({ type: 'setTraffic', seed: 7, focusObjectId: 1 });
    w.reply({ type: 'trafficReady', routeHash: 5, pathCount: 10, agentCount: 4, variants: [], setupMs: 3 });
    await expect(p).resolves.toMatchObject({ routeHash: 5, agentCount: 4 });
    expect(client.trafficInfo?.pathCount).toBe(10);
    const q = client.setTraffic({ enabled: false, seed: 0, variants: [], density, focusObjectId: 1 });
    w.reply({ type: 'unimplemented', command: 'setTraffic' });
    await expect(q).rejects.toThrow(/not implemented/);
    client.setTrafficDensity(density);
    expect(w.sent.at(-1)).toEqual({ type: 'setTrafficDensity', density });
    client.dispose();
  });

  it('interpolates ghost poses, honours TELEPORTED and flags nodesReady only with the object in both snapshots', () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    const q = Math.SQRT1_2;
    w.reply({ type: 'snapshot', buffer: snap(0, [agent({ agent: 0, pos: [0, 0, 0], speed: 10 }), agent({ agent: 1, pos: [0, 0, 0] })]) });
    w.reply({
      type: 'snapshot',
      buffer: snap(20, [
        agent({ agent: 0, pos: [2, 0, -4], quat: [0, q, 0, q], speed: 12 }),
        agent({ agent: 1, pos: [50, 0, 0], flags: TRAFFIC_FLAG_TELEPORTED }),
      ]),
    });
    expect(client.trafficCount).toBe(2);
    expect(client.workerLoad).toBeCloseTo(0.5);
    const out: TrafficAgentFrame[] = [];
    const t0 = 0;
    const t1 = 20 / 2000;
    expect(client.readTrafficAgents((t0 + t1) / 2, out)).toBe(2);
    expect(out[0]!.pos[0]).toBeCloseTo(1);
    expect(out[0]!.pos[2]).toBeCloseTo(-2);
    expect(out[0]!.speed).toBeCloseTo(11);
    const n = Math.hypot(...out[0]!.quat);
    expect(n).toBeCloseTo(1, 6);
    expect(out[1]!.pos[0]).toBe(50); // teleported: no interpolation
    expect(out[0]!.nodesReady).toBe(false);

    // Promotion: the awake object appears in the newest snapshot only → not ready; next snapshot → ready.
    const awake = agent({ agent: 0, objectId: TRAFFIC_ID_BASE, flags: TRAFFIC_FLAG_AWAKE, pos: [3, 0, -6] });
    w.reply({ type: 'snapshot', buffer: snap(40, [awake], true) });
    client.readTrafficAgents(t1, out);
    expect(out[0]!.nodesReady).toBe(false);
    expect(out[0]!.pos[0]).toBe(3); // mode switch ghost → awake: latest pose as-is
    w.reply({ type: 'snapshot', buffer: snap(60, [awake], true) });
    client.readTrafficAgents(50 / 2000, out);
    expect(out[0]!.nodesReady).toBe(true);
    client.dispose();
  });
});
