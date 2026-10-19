/**
 * Traffic commands through the worker host (P6, T1): setTraffic /
 * setTrafficDensity / trafficReady, validation, the snapshot traffic
 * section, the settled template and the initial ghost placement rule.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SnapshotReader } from '../../protocol/codec';
import { GAME_CAPACITY, type TrafficReadyMsg, type WorkerToMain } from '../../protocol/messages';
import {
  createTrafficAgentFrame,
  TRAFFIC_FLAG_AWAKE,
  TRAFFIC_FLAG_HEADLIGHTS,
  TRAFFIC_SPAWN_CONE_M,
  TRAFFIC_SPAWN_MIN_M,
} from '../../protocol/traffic';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { buildRouteNetwork } from '../../world/routes';
import { hashTerrain } from '../../world/terrain';
import { SEDAN } from '../vehicle/defs/sedan';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import { WorkerHost } from '../worker';
import { trafficCommand, trafficWorld, valleyTerrain, yawQuat } from './testkit';

beforeAll(() => {
  valleyTerrain();
}, 120_000);

function bareHost(): { host: WorkerHost; out: WorkerToMain[] } {
  const out: WorkerToMain[] = [];
  const host = new WorkerHost((m) => out.push(m), { now: () => 0, schedule: () => {} }, { generateTerrain: () => valleyTerrain(), hashTerrain });
  host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
  return { host, out };
}

describe('setTraffic validation', () => {
  it('rejects setTraffic before the heightfield, setTrafficDensity without traffic, rigs over the traffic budget; traffic stays off', () => {
    const { host, out } = bareHost();
    host.handle(trafficCommand({ agents: 4, maxAwake: 1 }));
    expect(out.at(-1)).toMatchObject({ type: 'error', command: 'setTraffic' });
    host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
    host.handle({ type: 'setTrafficDensity', density: { agents: 2, maxAwake: 1, awakePoolBeams: 2000 } });
    expect(out.at(-1)).toMatchObject({ type: 'error', command: 'setTrafficDensity' });
    host.handle({ ...trafficCommand({ agents: 4, maxAwake: 1 }), variants: [{ catalogId: 'sedan', vehicle: SEDAN, weight: 1, paletteCount: 6 }] });
    const err = out.at(-1)!;
    expect(err).toMatchObject({ type: 'error', command: 'setTraffic' });
    expect((err as { message: string }).message).toMatch(/beam budget/);
    expect(host.engine!.traffic).toBeNull();
    expect(out.some((m) => m.type === 'trafficReady')).toBe(false);
  }, 60_000);

  it('enabled: false (or agents 0) answers trafficReady with no agents', () => {
    const { host, out } = bareHost();
    host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
    host.handle({ ...trafficCommand({ agents: 4, maxAwake: 1 }), enabled: false });
    expect(out.at(-1)).toMatchObject({ type: 'trafficReady', agentCount: 0, pathCount: 0, variants: [] });
    expect(host.engine!.traffic).toBeNull();
  }, 60_000);

  it('main may not spawn into the traffic objectId range', () => {
    const { host, out } = bareHost();
    host.handle({ type: 'spawnVehicle', objectId: 105, vehicle: SEDAN_TRAFFIC, transform: { pos: [0, 50, 0], quat: [0, 0, 0, 1] } });
    expect(out.at(-1)).toMatchObject({ type: 'error', command: 'spawnVehicle', objectId: 105 });
  });
});

describe('trafficReady + snapshot section', () => {
  let world: ReturnType<typeof trafficWorld>;
  let ready: TrafficReadyMsg;
  const player: [number, number, number] = [360, 400, 0];
  beforeAll(() => {
    world = trafficWorld({ agents: 20, maxAwake: 3, player });
    ready = world.out.find((m) => m.type === 'trafficReady') as TrafficReadyMsg;
  }, 120_000);

  it('reports the route network, agents and the settled template', () => {
    const net = buildRouteNetwork(DEFAULT_LAYOUT, valleyTerrain());
    expect(ready.routeHash).toBe(net.hash);
    expect(ready.pathCount).toBe(net.paths.length);
    expect(ready.agentCount).toBe(20);
    expect(ready.variants.length).toBe(1);
    const t = ready.variants[0]!;
    expect(t.catalogId).toBe('sedanTraffic');
    expect(t.nodeCount).toBe(world.tr.variants[0]!.compiled.rig.nodeCount);
    expect(t.settled.length).toBe(3 * t.nodeCount);
    expect(ready.setupMs).toBeGreaterThanOrEqual(0);
    // Template: the frame is the rest frame (orientation + x/z), tyres stand on y = 0 (the rig ground plane).
    const cv = world.tr.variants[0]!.compiled;
    const fr = cv.frameNodes;
    for (const k of [0, 2]) expect(Math.abs(t.settled[3 * fr[0]! + k]! - cv.rig.nodePos[3 * fr[0]! + k]!)).toBeLessThan(1e-4);
    let minTyre = Infinity;
    for (const w of cv.wheels) for (let i = w.tireStart; i < w.tireStart + 2 * w.rays; i++) minTyre = Math.min(minTyre, t.settled[3 * i + 1]! - cv.rig.nodeRadius[i]!);
    // Tread nodes sit in the soft contact layer at rest (≈ 3–4 cm, wheelrig.ts), never above the ground.
    expect(minTyre).toBeLessThan(0.005);
    expect(minTyre).toBeGreaterThan(-0.06);
    // Body nodes: settled ≠ rest (the suspension sagged) but close (wheel rings may turn a little).
    let maxDev = 0;
    for (let i = 0; i < 3 * cv.bodyNodeCount; i++) maxDev = Math.max(maxDev, Math.abs(t.settled[i]! - cv.rig.nodePos[i]!));
    expect(maxDev).toBeGreaterThan(0.005);
    expect(maxDev).toBeLessThan(0.15);
  });

  it('initial ghosts obey the spawn rule (≥ 250 m from the focus, outside its forward ±70° cone closer than 600 m)', () => {
    for (const a of world.tr.agents) {
      if (!a.alive) continue;
      expect(a.awake).toBe(false);
      const dx = a.pos[0] - player[0];
      const dz = a.pos[2] - player[1];
      const d = Math.hypot(dx, dz);
      expect(d).toBeGreaterThanOrEqual(TRAFFIC_SPAWN_MIN_M - 1);
      // Player yaw 0 faces −Z.
      if (d < TRAFFIC_SPAWN_CONE_M) expect(-dz / d).toBeLessThanOrEqual(Math.cos((70 * Math.PI) / 180) + 0.02);
    }
  });

  it('every snapshot carries one record per agent (ascending), ghost poses on their paths, and the worker load', () => {
    const { host, out, eng } = world;
    host.runSteps(400);
    const snaps = out.filter((m) => m.type === 'snapshot');
    expect(snaps.length).toBeGreaterThan(0);
    const r = new SnapshotReader();
    r.attach((snaps.at(-1) as { buffer: ArrayBuffer }).buffer);
    expect(r.trafficCount).toBe(20);
    const rec = createTrafficAgentFrame();
    let prev = -1;
    for (let i = 0; i < r.trafficCount; i++) {
      r.readTrafficAgent(i, rec);
      expect(rec.agent).toBeGreaterThan(prev);
      prev = rec.agent;
      const a = eng.traffic!.agents[rec.agent]!;
      expect(rec.objectId).toBe(a.awake ? a.objectId : 0);
      expect((rec.flags & TRAFFIC_FLAG_AWAKE) !== 0).toBe(a.awake);
      expect(rec.flags & TRAFFIC_FLAG_HEADLIGHTS).not.toBe(0);
      expect(rec.path).toBe(a.plan[0]);
      expect(Math.hypot(rec.quat[0], rec.quat[1], rec.quat[2], rec.quat[3])).toBeCloseTo(1, 4);
      expect(rec.speed).toBeGreaterThanOrEqual(0);
      // Ghost record pose = agent pose extrapolated by < 1 AI tick.
      if (!a.awake) expect(Math.hypot(rec.pos[0] - a.pos[0], rec.pos[2] - a.pos[2])).toBeLessThan(a.v * 0.011 + 0.01);
    }
    expect(r.workerLoad).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('setTrafficDensity retires the highest-index ghosts and revives them by the respawn rule', () => {
    const { host, eng } = world;
    host.handle({ type: 'setTrafficDensity', density: { agents: 6, maxAwake: 1, awakePoolBeams: 2500 } });
    host.runSteps(40);
    expect(eng.traffic!.agentCount).toBe(6);
    expect(eng.traffic!.agents.slice(6).every((a) => !a.alive)).toBe(true);
    host.handle({ type: 'setTrafficDensity', density: { agents: 12, maxAwake: 2, awakePoolBeams: 4000 } });
    host.runSteps(40);
    expect(eng.traffic!.agentCount).toBe(12);
  }, 60_000);

  it('a restart (setTraffic again) replaces every agent and removes awake traffic objects', () => {
    const { host, eng, out } = world;
    host.handle({ type: 'spawnVehicle', objectId: 2, vehicle: SEDAN_TRAFFIC, transform: { pos: [player[0] + 10, 60, player[1]], quat: yawQuat(0) } });
    host.handle(trafficCommand({ agents: 5, maxAwake: 1, seed: 99 }));
    expect(out.at(-1)).toMatchObject({ type: 'trafficReady', agentCount: 5 });
    expect(eng.objects.some((o) => o.objectId >= 100 && o.objectId < 164)).toBe(false);
    expect(eng.arena.get(2)).toBeDefined();
  }, 60_000);
});
