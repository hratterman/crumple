/**
 * Prop objects in the engine / worker (P5, U1): layout spawn on
 * groundHeightfield, spawnProps (atomic), resetProps, the sleeping flag in
 * snapshots and the internal damping.
 */
import { describe, expect, it } from 'vitest';
import { SnapshotReader } from '../../protocol/codec';
import { OBJECT_FLAG_SLEEPING } from '../../protocol/layout';
import {
  MaterialId,
  PROP_DYNAMIC_ID_BASE,
  PROP_LAYOUT_ID_BASE,
  type MainToWorker,
  type WorkerToMain,
} from '../../protocol/messages';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { syntheticTerrain } from '../../world/sampler.testkit';
import type { TerrainData, WorldLayout } from '../../world/types';
import { SimEngine } from '../engine';
import { SIM_OBJECT_FLAG_SLEEPING } from '../types';
import { WorkerHost, type TerrainDeps } from '../worker';
import { compilePropRig } from './catalog';

const CAP = { maxObjects: 64, nodeCapacity: 8192, beamCapacity: 32768 };
const ID = (x: number, y: number, z: number) => ({ pos: [x, y, z] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] });

function host() {
  const posted: WorkerToMain[] = [];
  const deps: TerrainDeps = {
    generateTerrain: (l: WorldLayout): TerrainData => ({
      ...syntheticTerrain({ cols: 81, rows: 81, height: () => 1, material: () => MaterialId.concrete }),
      layoutId: l.id,
    }),
    hashTerrain: () => 7,
  };
  let now = 0;
  let last: ArrayBuffer | null = null;
  const h = new WorkerHost(
    (m) => {
      posted.push(m);
      // Keep only the newest snapshot buffer; hand the older one back to the pool (as main does).
      if (m.type === 'snapshot') {
        if (last) h.handle({ type: 'returnBuffer', buffer: last });
        last = m.buffer;
      }
    },
    { now: () => now, schedule: () => {} },
    deps,
  );
  return {
    h,
    posted,
    send: (m: MainToWorker) => h.handle(m),
    advance(ms: number) {
      now += ms;
      h.wake();
    },
  };
}

const LAYOUT: WorldLayout = {
  ...DEFAULT_LAYOUT,
  id: 'props-test',
  props: [
    { id: 'cones', prop: 'cone', pos: [0, null, 0], row: { count: 3, step: [1, 0] } },
    { id: 'boxes', prop: 'boxCardboard', pos: [0, null, 5], stack: 2 },
    { id: 'sign', prop: 'signPost', pos: [5, null, 5], facing: [1, 0] },
  ],
};

describe('props in the worker', () => {
  it('groundHeightfield spawns the layout props asleep and reports them in terrainReady', () => {
    const t = host();
    t.send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: CAP });
    t.posted.length = 0;
    t.send({ type: 'groundHeightfield', layout: LAYOUT, terrainHash: 0 });
    expect(t.posted[0]).toMatchObject({ type: 'terrainReady', props: 6, vegetationColliders: 0 });
    expect(t.posted.filter((m) => m.type === 'error')).toEqual([]);
    const eng = t.h.engine!;
    expect(eng.objects.map((o) => o.objectId)).toEqual([0, 1, 2, 3, 4, 5].map((i) => PROP_LAYOUT_ID_BASE + i));
    for (const o of eng.objects) expect(o.flags & SIM_OBJECT_FLAG_SLEEPING).toBe(SIM_OBJECT_FLAG_SLEEPING);
    // Asleep: frozen exactly in the rest pose, and the snapshot carries the flag.
    const before = Float64Array.from(eng.state.posY.subarray(0, eng.state.nodeCount));
    t.advance(50);
    expect(Float64Array.from(eng.state.posY.subarray(0, eng.state.nodeCount))).toEqual(before);
    const snap = t.posted.filter((m) => m.type === 'snapshot').at(-1);
    if (snap?.type !== 'snapshot') throw new Error('no snapshot');
    const r = new SnapshotReader();
    r.attach(snap.buffer);
    expect(r.objectCount).toBe(6);
    for (let i = 0; i < 6; i++) expect(r.objectFlags(i) & OBJECT_FLAG_SLEEPING).toBe(OBJECT_FLAG_SLEEPING);
    // Re-sending the ground replaces (not duplicates) the layout props.
    t.send({ type: 'groundHeightfield', layout: LAYOUT, terrainHash: 0 });
    expect(eng.objects).toHaveLength(6);
  });

  it('spawnProps is atomic; resetProps repairs, re-places and bumps the repair epoch', () => {
    const t = host();
    t.send({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: CAP });
    t.send({ type: 'groundHeightfield', layout: { ...LAYOUT, props: [] }, terrainHash: 0 });
    t.posted.length = 0;
    const a = PROP_DYNAMIC_ID_BASE;
    t.send({
      type: 'spawnProps',
      items: [
        { objectId: a, prop: 'barrel', transform: ID(0, 1, 0), asleep: false },
        { objectId: a + 1, prop: 'piano' as never, transform: ID(3, 1, 0) },
      ],
    });
    expect(t.posted).toEqual([expect.objectContaining({ type: 'error', command: 'spawnProps', message: expect.stringContaining('piano') })]);
    expect(t.h.engine!.objects).toHaveLength(0);
    t.send({ type: 'spawnProps', items: [{ objectId: 5, prop: 'cone', transform: ID(0, 1, 0) }] });
    expect(t.posted.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('dynamic prop range') });
    t.posted.length = 0;
    t.send({
      type: 'spawnProps',
      items: [
        { objectId: a, prop: 'barrel', transform: ID(0, 3, 0), asleep: false },
        { objectId: a + 1, prop: 'cone', transform: ID(3, 1, 0) },
      ],
    });
    expect(t.posted).toEqual([]);
    const eng = t.h.engine!;
    const barrel = eng.arena.get(a)!;
    expect(barrel.flags & SIM_OBJECT_FLAG_SLEEPING).toBe(0);
    expect(eng.arena.get(a + 1)!.flags & SIM_OBJECT_FLAG_SLEEPING).toBe(SIM_OBJECT_FLAG_SLEEPING);
    for (let k = 0; k < 50; k++) t.advance(10); // the awake barrel drops 2 m and lands
    expect(eng.state.posY[barrel.nodeStart]!).toBeLessThan(2);
    t.send({ type: 'resetProps', objectIds: [a, 77] });
    expect(t.posted.at(-1)).toMatchObject({ type: 'error', command: 'resetProps' });
    t.send({ type: 'resetProps', objectIds: [a] });
    const rig = compilePropRig('barrel');
    expect(eng.state.posY[barrel.nodeStart]!).toBeCloseTo(3 + rig.nodePos[1]!, 12);
    expect(barrel.flags & SIM_OBJECT_FLAG_SLEEPING).toBe(SIM_OBJECT_FLAG_SLEEPING);
    t.advance(20);
    const snap = t.posted.filter((m) => m.type === 'snapshot').at(-1);
    if (snap?.type !== 'snapshot') throw new Error('no snapshot');
    const r = new SnapshotReader();
    r.attach(snap.buffer);
    expect(r.objectRepairEpoch(0)).toBe(1);
  });
});

describe('prop internal damping', () => {
  it('leaves free flight and tumbling untouched (rigid-body motion is not damped)', () => {
    const eng = new SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: CAP });
    eng.spawnProp(PROP_DYNAMIC_ID_BASE, 'boxWood', ID(0, 10, 0), false);
    const s = eng.state;
    const o = eng.objects[0]!;
    // Spin about +Y at 3 rad/s while translating at 5 m/s (rigid motion).
    let cx = 0;
    let cz = 0;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      cx += s.posX[i]!;
      cz += s.posZ[i]!;
    }
    cx /= o.nodeCount;
    cz /= o.nodeCount;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      s.velX[i] = 5 + 3 * (s.posZ[i]! - cz);
      s.velZ[i] = -3 * (s.posX[i]! - cx);
    }
    const ke = () => {
      let e = 0;
      for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) e += (s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2) / s.invMass[i]!;
      return e / 2;
    };
    const e0 = ke();
    for (let k = 0; k < 2000; k++) eng.step();
    // A rotating soft body stretches a little (centrifugal), so allow ~1 %; viscous damping at
    // c = 4 /s on absolute velocities would have removed 1 − e^{−8} of it.
    expect(ke()).toBeGreaterThan(0.99 * e0);
  });
});
