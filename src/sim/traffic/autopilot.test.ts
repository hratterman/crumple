import { describe, expect, it } from 'vitest';

import { GAME_CAPACITY, MaterialId, type WorkerToMain } from '../../protocol/messages';
import { hashSimState } from '../replay/hash';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import { WorkerHost } from '../worker';
import { yawQuat } from './testkit';

function world(): { host: WorkerHost; out: WorkerToMain[] } {
  const out: WorkerToMain[] = [];
  let ref: WorkerHost | null = null;
  const host = new WorkerHost(
    (m) => {
      if (m.type === 'snapshot') ref?.handle({ type: 'returnBuffer', buffer: m.buffer });
      else out.push(m);
    },
    { now: () => 0, schedule: () => {} },
  );
  ref = host;
  host.handle({ type: 'init', seed: 3, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
  host.handle({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.concrete });
  host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN_TRAFFIC, transform: { pos: [0, 0.05, 0], quat: yawQuat(0) } });
  // The opponent 40 m north, facing AWAY from the target: it has to turn round first.
  host.handle({ type: 'spawnVehicle', objectId: 10, vehicle: SEDAN_TRAFFIC, transform: { pos: [6, 0.05, -40], quat: yawQuat(0) } });
  return { host, out };
}

function framePos(host: WorkerHost, id: number): [number, number, number] {
  const e = host.engine!;
  const fr = new Int32Array(3);
  expect(e.frameNodesOf(id, fr)).toBe(true);
  const s = e.state;
  return [s.posX[fr[0]!]!, s.posY[fr[0]!]!, s.posZ[fr[0]!]!];
}

describe('setAutopilot (ram driver)', () => {
  it('turns round and rams the target; deterministic; logged for the replay file', () => {
    const run = (): { hash: number; hitAt: number; host: WorkerHost } => {
      const { host } = world();
      host.runSteps(1000); // settle 0.5 s
      host.handle({ type: 'setAutopilot', objectId: 10, mode: 'ram', targetObjectId: 1, aggression: 0.8, seed: 5 });
      let hitAt = -1;
      for (let k = 0; k < 28 && hitAt < 0; k++) {
        host.runSteps(1000);
        const a = framePos(host, 1);
        const b = framePos(host, 10);
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) < 4.2) hitAt = (k + 1) * 0.5;
      }
      return { hash: hashSimState(host.engine!), hitAt, host };
    };
    const r1 = run();
    expect(r1.hitAt).toBeGreaterThan(0);
    expect(r1.hitAt).toBeLessThan(14);
    const r2 = run();
    expect(r2.hitAt).toBe(r1.hitAt);
    expect(r2.hash).toBe(r1.hash);
    const file = r1.host.log.build(r1.host.engine!);
    expect(file.commands.some((c) => c.cmd.type === 'setAutopilot')).toBe(true);
  }, 120_000);

  it('rejects non-vehicles, turns off cleanly and survives a despawn', () => {
    const { host, out } = world();
    host.handle({ type: 'setAutopilot', objectId: 77, mode: 'ram' });
    expect(out.some((m) => m.type === 'error' && m.command === 'setAutopilot')).toBe(true);
    host.handle({ type: 'setAutopilot', objectId: 10, mode: 'ram' });
    host.runSteps(400);
    const obj = host.engine!.arena.get(10)!;
    expect(obj.actions[0]).toBeGreaterThan(0); // throttle on
    host.handle({ type: 'setAutopilot', objectId: 10, mode: 'off' });
    expect(Array.from(obj.actions).every((v) => v === 0)).toBe(true);
    host.handle({ type: 'setAutopilot', objectId: 10, mode: 'ram' });
    host.handle({ type: 'despawn', objectId: 10 });
    expect(host.engine!.autopilots.size).toBe(0);
    host.runSteps(100);
    expect(out.some((m) => m.type === 'fatal')).toBe(false);
  }, 60_000);
});
