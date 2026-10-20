/**
 * P7 deterministic replay: a live run on a WorkerHost (irregular wakes,
 * snapshots written and returned late so the pool skips some, inputs every
 * frame, reset / recover / props / colliders, a replay pause in the middle)
 * exports a ReplayFile whose re-simulation from boot reproduces the live
 * state hash bit-exactly.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { MaterialId, PROP_DYNAMIC_ID_BASE, type MainToWorker, type WorkerToMain } from '../../protocol/messages';
import { checkReplayFile, REPLAY_FILE_FORMAT, type ReplayFile } from '../../protocol/replay';
import { SEDAN } from '../vehicle/defs/sedan';
import { WorkerHost } from '../worker';
import { hashSimState } from './hash';
import { resimulate } from './resim';

interface Live {
  host: WorkerHost;
  out: WorkerToMain[];
  held: ArrayBuffer[];
}

function liveHost(): Live {
  const out: WorkerToMain[] = [];
  const held: ArrayBuffer[] = [];
  const host = new WorkerHost((m) => {
    if (m.type === 'snapshot') held.push(m.buffer);
    else out.push(m);
  }, { now: () => 0, schedule: () => {} });
  return { host, out, held };
}

function lastOf<T extends WorkerToMain['type']>(out: WorkerToMain[], type: T): Extract<WorkerToMain, { type: T }> {
  for (let i = out.length - 1; i >= 0; i--) if (out[i]!.type === type) return out[i] as Extract<WorkerToMain, { type: T }>;
  throw new Error(`no ${type}`);
}

function runLive(): { live: Live; file: ReplayFile; hash: number } {
  const live = liveHost();
  const { host } = live;
  const send = (m: MainToWorker): void => host.handle(m);
  send({ type: 'init', seed: 77, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 16, nodeCapacity: 8192, beamCapacity: 32768 } });
  send({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
  send({ type: 'setColliders', colliders: [{ id: 'wall', kind: 'box', pos: [0, 1, -40], quat: [0, 0, 0, 1], size: [6, 1, 0.6], material: MaterialId.concrete }] });
  send({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [0, 0.05, 0], quat: [0, 0, 0, 1] }, catalogId: 'sedan' });
  send({
    type: 'spawnProps',
    items: [
      { objectId: PROP_DYNAMIC_ID_BASE, prop: 'cone', transform: { pos: [0.4, 0, -18], quat: [0, 0, 0, 1] } },
      { objectId: PROP_DYNAMIC_ID_BASE + 1, prop: 'barrel', transform: { pos: [-0.5, 0, -24], quat: [0, 0, 0, 1] } },
    ],
  });
  const rng = createRng(5);
  let frame = 0;
  // ~4 s of sim in irregular wakes (8–40 steps), input every "frame", buffers returned late.
  while (host.engine!.tick < 8000) {
    const steps = 8 + Math.floor(rng.float() * 33);
    host.runSteps(steps);
    frame++;
    const t = host.engine!.tick / 2000;
    send({ type: 'input', objectId: 1, actions: { throttle: t < 2.6 ? 1 : 0, brake: t > 3 ? 0.6 : 0, steer: Math.round(Math.sin(t * 3) * 20) / 40, gearSelect: 1, handbrake: 0, clutch: 0 } });
    if (frame % 3 === 0) while (live.held.length > 0) send({ type: 'returnBuffer', buffer: live.held.shift()! });
    if (frame === 40) send({ type: 'timescale', value: 0.25 });
    if (frame === 60) {
      send({ type: 'replayPause', paused: true });
      host.runSteps(0);
      send({ type: 'stateHashRequest', requestId: 3 });
      send({ type: 'replayPause', paused: false });
    }
    if (frame === 120) send({ type: 'recover', objectId: 1 });
    if (frame === 200) send({ type: 'setAssists', objectId: 1, tractionControl: false });
    if (frame === 260) send({ type: 'resetProps', objectIds: [PROP_DYNAMIC_ID_BASE] });
    if (frame === 330) send({ type: 'reset', objectId: 1, transform: { pos: [0, 0.05, 0], quat: [0, 0, 0, 1] } });
    if (frame === 331) send({ type: 'input', objectId: 99, actions: { throttle: 1 } }); // rejected: unknown object
  }
  const hash = hashSimState(host.engine!);
  send({ type: 'replayFileRequest', requestId: 9 });
  const file = lastOf(live.out, 'replayFile').file;
  return { live, file, hash };
}

describe('ReplayFile (P7)', () => {
  const { live, file, hash } = runLive();

  it('pause answers carry the tick and an unchanged hash', () => {
    const paused = live.out.filter((m) => m.type === 'replayPaused') as Extract<WorkerToMain, { type: 'replayPaused' }>[];
    expect(paused.map((p) => p.paused)).toEqual([true, false]);
    expect(paused[1]!.tick).toBe(paused[0]!.tick);
    expect(paused[1]!.stateHash).toBe(paused[0]!.stateHash);
    expect(lastOf(live.out, 'stateHash').hash).toBe(paused[0]!.stateHash);
  });

  it('exports a well-formed file', () => {
    expect(file.format).toBe(REPLAY_FILE_FORMAT);
    expect(checkReplayFile({ ...file, build: 'abc' }, 'abc')).toBe('ok');
    expect(checkReplayFile({ ...file, build: 'abc' }, 'def')).toBe('build-mismatch');
    expect(file.toTick).toBe(live.host.engine!.tick);
    expect(file.endStateHash).toBe(hash);
    expect(file.vehicles).toEqual([{ objectId: 1, catalogId: 'sedan', paint: null, spawnTick: 0 }]);
    expect(file.commands.map((c) => c.cmd.type)).toEqual(['ground', 'setColliders', 'spawnVehicle', 'spawnProps', 'recover', 'setAssists', 'resetProps', 'reset']);
    // Inputs log only clamped CHANGES: far fewer than 6 per frame.
    expect(file.inputs.count).toBeGreaterThan(50);
    expect(file.inputs.count).toBeLessThan(6 * 400);
    console.log(`[replay] live run: ${file.toTick} ticks, ${file.commands.length} commands, ${file.inputs.count} input entries, hash 0x${hash.toString(16)}`);
  });

  it('re-simulating from boot reproduces the live state hash', () => {
    const r = resimulate(file);
    expect(r.hash).toBe(hash);
    expect(r.host.engine!.tick).toBe(file.toTick);
    // The re-simulated run logs the same file (exportable again).
    r.host.handle({ type: 'replayFileRequest', requestId: 1 });
    const again = lastOf(r.messages, 'replayFile').file;
    expect(again.inputs.count).toBe(file.inputs.count);
    expect(again.commands.length).toBe(file.commands.length);
    expect(again.endStateHash).toBe(hash);
  }, 120_000);

  it('a perturbed input log diverges (the hash is sensitive)', () => {
    const v = file.inputs.value.slice();
    const k = Math.floor(file.inputs.count / 2);
    v[k] = v[k]! + 0.01;
    const r = resimulate({ ...file, inputs: { ...file.inputs, value: v } });
    expect(r.hash).not.toBe(hash);
  }, 120_000);
});

describe('ReplayFile with the heightfield, layout props and traffic (P7)', () => {
  it('re-simulation reproduces a live run with AI traffic promotions', async () => {
    const { valleyTerrain, trafficCommand } = await import('../traffic/testkit');
    const { DEFAULT_LAYOUT } = await import('../../world/layout');
    const { hashTerrain } = await import('../../world/terrain');
    const deps = { generateTerrain: () => valleyTerrain(), hashTerrain };
    const out: WorkerToMain[] = [];
    let ref: WorkerHost | null = null;
    const host = new WorkerHost((m) => {
      if (m.type === 'snapshot') ref?.handle({ type: 'returnBuffer', buffer: m.buffer });
      else out.push(m);
    }, { now: () => 0, schedule: () => {} }, deps);
    ref = host;
    host.handle({ type: 'init', seed: 3, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 320, nodeCapacity: 32768, beamCapacity: 131072 } });
    host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
    const eng = host.engine!;
    const sp = valleyTerrain().spawns.find((s) => s.id === 'highway')!;
    host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [sp.pos[0], sp.pos[1] + 0.6, sp.pos[2]], quat: [0, Math.sin(sp.yaw / 2), 0, Math.cos(sp.yaw / 2)] }, catalogId: 'sedan' });
    host.handle(trafficCommand({ agents: 12, maxAwake: 2, seed: 4 }));
    while (eng.tick < 6000) {
      host.runSteps(33);
      host.handle({ type: 'input', objectId: 1, actions: { throttle: 0.7, gearSelect: 1 } });
    }
    const hash = hashSimState(eng);
    host.handle({ type: 'replayFileRequest', requestId: 1 });
    const file = lastOf(out, 'replayFile').file;
    expect(file.layout?.id).toBe(DEFAULT_LAYOUT.id);
    expect(file.commands.map((c) => c.cmd.type)).toEqual(['groundHeightfield', 'spawnVehicle', 'setTraffic']);
    const r = resimulate(file, { terrainDeps: deps });
    console.log(`[replay] valley + traffic: ${eng.objects.length} objects, hash 0x${hash.toString(16)} / resim 0x${r.hash.toString(16)}`);
    expect(r.hash).toBe(hash);
  }, 300_000);
});
