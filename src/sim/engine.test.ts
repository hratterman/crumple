/**
 * Engine + worker-host integration tests. These depend on sibling modules
 * (rig builder/testrigs, ground collision, materials); if any is missing the
 * whole suite is skipped with a message instead of failing on import.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BufferPool, SnapshotReader, SnapshotWriter } from '../protocol/codec';
import { BEAM_BREAK_CAPACITY } from '../protocol/events';
import { computeSnapshotLayout } from '../protocol/layout';
import type { MainToWorker, Transform, WorkerToMain } from '../protocol/messages';
import type { RigDef } from './rig/types';
import type { SimState } from './types';

const SIBLINGS = ['./rig/builder.ts', './rig/testrigs.ts', './collision/ground.ts', './collision/materials.ts'];
const present = import.meta.glob(['./rig/builder.ts', './rig/testrigs.ts', './collision/ground.ts', './collision/materials.ts']);
const missing = SIBLINGS.filter((p) => !(p in present));
if (missing.length > 0) {
  console.warn(`[engine.test] SKIPPED: sibling modules not present yet: ${missing.join(', ')}`);
}

type EngineMod = typeof import('./engine');
type WorkerMod = typeof import('./worker');
type RigsMod = typeof import('./rig/testrigs');
let E: EngineMod;
let W: WorkerMod;
let R: RigsMod;

const ID: Transform = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
const at = (x: number, y: number, z: number): Transform => ({ pos: [x, y, z], quat: [0, 0, 0, 1] });
const SMALL = { maxObjects: 8, nodeCapacity: 1024, beamCapacity: 8192 };

function hydroRig(): RigDef {
  return {
    name: 'hydro',
    nodes: [
      { id: 'a', pos: [0, 0, 0], mass: 0 },
      { id: 'b', pos: [1, 0, 0], mass: 0 },
    ],
    beams: [{ a: 'a', b: 'b', type: 'hydro', k: 1e4, d: 10, hydroTravel: 0.2 }],
  };
}

function hashState(s: SimState): string {
  let h = 0x811c9dc5;
  for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.restLen, s.k, s.active, s.strainOut]) {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i]!, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe.skipIf(missing.length > 0)('SimEngine', () => {
  beforeAll(async () => {
    E = await import('./engine');
    W = await import('./worker');
    R = await import('./rig/testrigs');
  });

  it('softCube dropped on a plane: 2000 steps, no NaN, comes to rest above ground', () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: SMALL });
    eng.setGroundPlane(0, 0);
    const obj = eng.spawn(1, R.softCube(), at(0, 1.25, 0)); // bottom face 0.5 m up
    const s = eng.state;
    for (let t = 0; t < 2000; t++) eng.step();
    expect(eng.tick).toBe(2000);
    let minY = Infinity;
    let sumY = 0;
    let maxSpeed = 0;
    for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
      for (const v of [s.posX[i]!, s.posY[i]!, s.posZ[i]!, s.velX[i]!, s.velY[i]!, s.velZ[i]!]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      minY = Math.min(minY, s.posY[i]!);
      sumY += s.posY[i]!;
      maxSpeed = Math.max(maxSpeed, Math.sqrt(s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2));
    }
    const meanY = sumY / obj.nodeCount;
    expect(minY).toBeGreaterThan(-0.05); // only penalty-depth penetration
    expect(meanY).toBeGreaterThan(0.5); // still a cube (centre ~0.75)
    expect(meanY).toBeLessThan(1.0); // and it actually landed
    expect(maxSpeed).toBeLessThan(0.5); // settling
    for (let b = obj.beamStart; b < obj.beamStart + obj.beamCount; b++) {
      expect(s.active[b]).toBe(1);
      expect(Math.abs(s.strainOut[b]!)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps objects in ascending id order with packed, re-indexed ranges across spawn/despawn', () => {
    const eng = new E.SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: SMALL });
    const pend = R.beamPendulum();
    const cube = R.softCube({ seg: 1 });
    eng.spawn(5, cube, at(10, 0, 0));
    eng.spawn(2, pend, at(0, 0, 0));
    eng.spawn(9, pend, at(20, 0, 0));
    expect(eng.objects.map((o) => o.objectId)).toEqual([2, 5, 9]);
    let n = 0;
    let b = 0;
    for (const o of eng.objects) {
      expect(o.nodeStart).toBe(n);
      expect(o.beamStart).toBe(b);
      n += o.nodeCount;
      b += o.beamCount;
    }
    expect(eng.state.nodeCount).toBe(n);
    expect(eng.state.beamCount).toBe(b);
    const s = eng.state;
    const checkBeams = (): void => {
      for (const o of eng.objects) {
        for (let k = o.beamStart; k < o.beamStart + o.beamCount; k++) {
          expect(s.aIdx[k]).toBeGreaterThanOrEqual(o.nodeStart);
          expect(s.bIdx[k]).toBeLessThan(o.nodeStart + o.nodeCount);
        }
      }
    };
    checkBeams();
    const nine = eng.objects[2]!;
    expect(s.posX[nine.nodeStart + 1]).toBeCloseTo(21, 12); // pendulum bob at +1 x
    eng.despawn(5);
    expect(eng.objects.map((o) => o.objectId)).toEqual([2, 9]);
    expect(eng.objects[1]!.nodeStart).toBe(2);
    expect(s.posX[eng.objects[1]!.nodeStart + 1]).toBeCloseTo(21, 12);
    checkBeams();
    expect(() => eng.despawn(5)).toThrow(E.SimCommandError);
    expect(() => eng.spawn(2, pend, ID)).toThrow(/already exists/);
  });

  it('rejects spawns beyond capacity and invalid rigs without corrupting state', () => {
    const eng = new E.SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: { maxObjects: 1, nodeCapacity: 2, beamCapacity: 1 } });
    eng.spawn(1, R.beamPendulum(), ID);
    expect(() => eng.spawn(2, R.beamPendulum(), ID)).toThrow(/capacity/);
    expect(() => eng.spawn(3, { name: 'bad', nodes: [], beams: [{ a: 'x', b: 'y', type: 'normal' }] }, ID)).toThrow(
      E.SimCommandError,
    );
    expect(eng.objects).toHaveLength(1);
    expect(eng.state.nodeCount).toBe(2);
  });

  it('applies rotation from the spawn quaternion', () => {
    const eng = new E.SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: SMALL });
    const h = Math.SQRT1_2;
    const o = eng.spawn(1, R.beamPendulum(), { pos: [1, 2, 3], quat: [0, h, 0, h] }); // +90° about Y: +x → -z
    const s = eng.state;
    expect(s.posX[o.nodeStart + 1]).toBeCloseTo(1, 12);
    expect(s.posY[o.nodeStart + 1]).toBeCloseTo(2, 12);
    expect(s.posZ[o.nodeStart + 1]).toBeCloseTo(2, 12);
  });

  it('drives hydro rest length from steer: base·(1 + travel·steer)', () => {
    const eng = new E.SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: SMALL });
    const o = eng.spawn(3, hydroRig(), ID);
    eng.setInput(3, { steer: 0.5, throttle: 7 });
    expect(o.actions[0]).toBe(1); // clamped
    eng.step();
    expect(eng.state.restLen[o.hydroBeams[0]!]).toBeCloseTo(1.1, 12);
    eng.setInput(3, { steer: -1 });
    eng.step();
    expect(eng.state.restLen[o.hydroBeams[0]!]).toBeCloseTo(0.8, 12);
    expect(() => eng.setInput(3, { steer: NaN })).toThrow(E.SimCommandError);
    expect(() => eng.setInput(99, { steer: 0 })).toThrow(/unknown objectId/);
  });

  it('reset fully repairs: rest pose, zero velocity, beams restored', () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: SMALL });
    eng.setGroundPlane(0, 0);
    const o = eng.spawn(1, R.softCube({ deform: 50, breakF: 300 }), at(0, 4, 0));
    for (let t = 0; t < 3000; t++) eng.step();
    const s = eng.state;
    let damaged = 0;
    for (let b = o.beamStart; b < o.beamStart + o.beamCount; b++) if (s.active[b] === 0 || s.restLen[b] !== s.restLen0[b]) damaged++;
    expect(damaged).toBeGreaterThan(0);
    eng.reset(1, at(0, 5, 0));
    for (let b = o.beamStart; b < o.beamStart + o.beamCount; b++) {
      expect(s.active[b]).toBe(1);
      expect(s.restLen[b]).toBe(s.restLen0[b]);
      expect(s.k[b]).toBe(s.k0[b]);
      expect(s.strainOut[b]).toBe(0);
    }
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      expect(s.velY[i]).toBe(0);
      expect(s.posY[i]).toBeGreaterThan(4.2);
    }
  });

  it('beam breaks become object-local events; overflow is dropped and counted; snapshot round-trips', () => {
    const eng = new E.SimEngine({ gravity: [0, 0, 0], debugStrains: true, capacity: SMALL });
    eng.spawn(4, R.beamPendulum(), ID);
    const cube = eng.spawn(7, R.softCube({ seg: 1 }), at(5, 1, 0));
    eng.events.beamBreak(cube.beamStart + 3, 1, 2, 3);
    for (let i = 0; i < BEAM_BREAK_CAPACITY + 10; i++) eng.events.beamBreak(0, 0, 0, 0);
    const layout = computeSnapshotLayout(SMALL.maxObjects, SMALL.nodeCapacity, SMALL.beamCapacity, true);
    const pool = new BufferPool(layout.totalBytes);
    const writer = new SnapshotWriter(layout);
    const buf = pool.acquire()!;
    writer.attach(buf);
    eng.step();
    eng.writeSnapshot(writer, 0.5);
    const r = new SnapshotReader().attach(buf);
    expect(r.tick).toBe(1);
    expect(r.timeScale).toBe(0.5);
    expect(r.objectCount).toBe(2);
    expect([r.objectId(0), r.objectId(1)]).toEqual([4, 7]);
    expect(r.beamBreakCount).toBe(BEAM_BREAK_CAPACITY);
    expect(r.beamBreakOverflow).toBe(11);
    expect([r.beamBreakObjectId(0), r.beamBreakBeamIndex(0)]).toEqual([7, 3]);
    expect([r.beamBreakObjectId(1), r.beamBreakBeamIndex(1)]).toEqual([4, 0]);
    const s = eng.state;
    const nodes = r.objectNodes(1);
    for (let i = 0; i < cube.nodeCount; i++) {
      expect(nodes[3 * i]).toBe(Math.fround(s.posX[cube.nodeStart + i]!));
      expect(nodes[3 * i + 1]).toBe(Math.fround(s.posY[cube.nodeStart + i]!));
    }
    expect(r.objectStrains(1)!.length).toBe(cube.beamCount);
    for (let t = 0; t < 32; t++) expect(r.telemetry(0, t)).toBe(0);
    // Events were flushed: the next snapshot carries none.
    writer.attach(pool.acquire()!);
    eng.writeSnapshot(writer);
    expect(eng.events.breakCount).toBe(0);
  });

  it('is deterministic, including with snapshots interleaved', () => {
    const runOnce = (snap: boolean): string => {
      const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: SMALL });
      eng.setGroundPlane(0, 0);
      eng.spawn(2, R.softCube({ deform: 80, breakF: 400 }), { pos: [0, 3, 0], quat: [0.1, 0.2, 0.05, 0.97] });
      eng.spawn(1, R.wreckingBall(), at(-6, 6, 0));
      const layout = computeSnapshotLayout(SMALL.maxObjects, SMALL.nodeCapacity, SMALL.beamCapacity, true);
      const pool = new BufferPool(layout.totalBytes);
      const writer = new SnapshotWriter(layout);
      for (let t = 0; t < 2500; t++) {
        eng.step();
        if (snap && t % 17 === 0) {
          const b = pool.acquire()!;
          writer.attach(b);
          eng.writeSnapshot(writer);
          pool.release(b);
        }
      }
      return hashState(eng.state);
    };
    const a = runOnce(false);
    expect(runOnce(false)).toBe(a);
    expect(runOnce(true)).toBe(a);
  });
});

describe.skipIf(missing.length > 0)('WorkerHost', () => {
  beforeAll(async () => {
    E = await import('./engine');
    W = await import('./worker');
    R = await import('./rig/testrigs');
  });

  function makeHost() {
    const posted: { msg: WorkerToMain; transfer?: Transferable[] }[] = [];
    let now = 0;
    let wakes = 0;
    const host = new W.WorkerHost((msg, transfer) => posted.push({ msg, transfer }), {
      now: () => now,
      schedule: () => {
        wakes++;
      },
    });
    return {
      host,
      posted,
      advance(ms: number) {
        now += ms;
        host.wake();
      },
      get wakes() {
        return wakes;
      },
      send(m: MainToWorker) {
        host.handle(m);
      },
      types: () => posted.map((p) => p.msg.type),
    };
  }

  it('handles the command set, paces in fixed steps, caps backlog and snapshots via the pool', () => {
    const h = makeHost();
    h.send({ type: 'spawn', objectId: 1, rig: R.softCube(), transform: ID });
    expect(h.posted[0]!.msg).toMatchObject({ type: 'error', command: 'spawn' });
    h.send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: true, capacity: SMALL });
    expect(h.posted[1]!.msg.type).toBe('ready');
    h.send({ type: 'ground', mode: 'plane', y: 0, materialId: 0 });
    h.send({ type: 'ground', mode: 'heightfield', terrain: null });
    h.send({ type: 'setBubble', center: [0, 0, 0], radius: 1 });
    h.send({ type: 'keyframeRequest', requestId: 1 });
    h.send({ type: 'replaySeek', tick: 0 });
    expect(h.types().slice(2)).toEqual(['unimplemented', 'unimplemented', 'unimplemented', 'unimplemented']);
    h.send({ type: 'spawn', objectId: 1, rig: R.softCube(), transform: at(0, 1, 0) });
    h.send({ type: 'input', objectId: 42, actions: { steer: 1 } });
    expect(h.posted.at(-1)!.msg).toMatchObject({ type: 'error', command: 'input', objectId: 42 });
    const before = h.posted.length;

    h.advance(50); // 100 steps → crosses 6 snapshot ticks, writes only the last
    expect(h.host.engine!.tick).toBe(100);
    const snaps = h.posted.slice(before).filter((p) => p.msg.type === 'snapshot');
    expect(snaps).toHaveLength(1);
    const snap = snaps[0]!;
    if (snap.msg.type !== 'snapshot') throw new Error('unreachable');
    expect(snap.transfer).toEqual([snap.msg.buffer]);
    const r = new SnapshotReader().attach(snap.msg.buffer);
    expect(r.tick).toBe(100);
    expect(r.objectCount).toBe(1);
    expect(r.hasStrains).toBe(true);

    h.send({ type: 'timescale', value: 0.5 });
    h.advance(10); // 5 ms sim → 10 steps
    expect(h.host.engine!.tick).toBe(110);

    h.send({ type: 'timescale', value: 1 });
    h.advance(1000); // 2000 steps due, capped at 200
    expect(h.host.engine!.tick).toBe(310);
    expect(h.host.droppedSteps).toBe(1800);

    // Pool exhaustion: 3 buffers out → further snapshots are skipped, not blocking.
    h.advance(20);
    h.advance(20);
    const out = h.posted.filter((p) => p.msg.type === 'snapshot');
    expect(out.length).toBe(3);
    expect(h.host.pool!.misses).toBeGreaterThan(0);
    const first = out[0]!.msg;
    if (first.type !== 'snapshot') throw new Error('unreachable');
    h.send({ type: 'returnBuffer', buffer: first.buffer });
    expect(h.host.pool!.available).toBe(1);
    h.send({ type: 'returnBuffer', buffer: new ArrayBuffer(8) });
    expect(h.posted.at(-1)!.msg).toMatchObject({ type: 'error', command: 'returnBuffer' });

    h.send({ type: 'timescale', value: 0 });
    const t0 = h.host.engine!.tick;
    h.advance(100);
    expect(h.host.engine!.tick).toBe(t0);
    h.send({ type: 'despawn', objectId: 1 });
    expect(h.host.engine!.objects).toHaveLength(0);
    expect(h.types()).not.toContain('fatal');
  });

  it('reports fatal on a stepping failure and stops', () => {
    const h = makeHost();
    h.send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: SMALL });
    h.host.engine!.step = () => {
      throw new Error('boom');
    };
    h.advance(5);
    expect(h.posted.at(-1)!.msg).toMatchObject({ type: 'fatal', message: 'boom' });
    expect(h.host.dead).toBe(true);
  });
});
