import { describe, expect, it } from 'vitest';
import { resolveColliders } from '../../world/colliders';
import type { ColliderDef } from '../../world/types';
import { MaterialId, NODE_FLAG_COLLIDABLE, NODE_FLAG_IN_CONTACT, type EventSink, type SimState } from '../types';
import { applyColliderContacts, compileColliders } from './colliders';
import { DEFAULT_MATERIALS } from './materials';
import { COLLIDER_GRID_CELL } from './types';

const DT = 1 / 2000;
const G = -9.81;

function makeState(nodes: number): SimState {
  const f64 = (n: number) => new Float64Array(n);
  return {
    nodeCapacity: nodes,
    beamCapacity: 0,
    nodeCount: nodes,
    beamCount: 0,
    posX: f64(nodes),
    posY: f64(nodes),
    posZ: f64(nodes),
    velX: f64(nodes),
    velY: f64(nodes),
    velZ: f64(nodes),
    frcX: f64(nodes),
    frcY: f64(nodes),
    frcZ: f64(nodes),
    invMass: f64(nodes).fill(1),
    radius: f64(nodes).fill(0.05),
    friction: f64(nodes).fill(1),
    contactK: f64(nodes),
    treadAxX: f64(nodes),
    treadAxY: f64(nodes),
    treadAxZ: f64(nodes),
    treadF: f64(nodes),
    objRadius: f64(nodes),
    flags: new Uint8Array(nodes).fill(NODE_FLAG_COLLIDABLE),
    aIdx: new Int32Array(0),
    bIdx: new Int32Array(0),
    k: f64(0),
    d: f64(0),
    restLen: f64(0),
    restLen0: f64(0),
    k0: f64(0),
    deform: f64(0),
    breakF: f64(0),
    boundsLow: f64(0),
    boundsHigh: f64(0),
    preload: f64(0),
    type: new Uint8Array(0),
    active: new Uint8Array(0),
    strainOut: new Float32Array(0),
  };
}

class Sink implements EventSink {
  impacts: number[][] = [];
  skids = 0;
  impact(...a: number[]): void {
    this.impacts.push(a);
  }
  beamBreak(): void {}
  skid(): void {
    this.skids++;
  }
}

function integrate(s: SimState): void {
  for (let i = 0; i < s.nodeCount; i++) {
    const im = s.invMass[i]!;
    s.velX[i] = s.velX[i]! + s.frcX[i]! * im * DT;
    s.velY[i] = s.velY[i]! + (s.frcY[i]! * im + G) * DT;
    s.velZ[i] = s.velZ[i]! + s.frcZ[i]! * im * DT;
    s.posX[i] = s.posX[i]! + s.velX[i]! * DT;
    s.posY[i] = s.posY[i]! + s.velY[i]! * DT;
    s.posZ[i] = s.posZ[i]! + s.velZ[i]! * DT;
    s.frcX[i] = 0;
    s.frcY[i] = 0;
    s.frcZ[i] = 0;
  }
}

const world = (defs: ColliderDef[]) => compileColliders(resolveColliders(defs, () => 0));
const run = (s: SimState, w: ReturnType<typeof world>, steps: number, sink = new Sink(), each?: () => void): Sink => {
  for (let t = 0; t < steps; t++) {
    applyColliderContacts(s, 0, s.nodeCount, w, DEFAULT_MATERIALS, DT, 7, sink, 0, G, 0);
    integrate(s);
    each?.();
  }
  return sink;
};
const wall: ColliderDef = { id: 'wall', kind: 'box', pos: [0, 1, 0], quat: [0, 0, 0, 1], size: [10, 1, 0.6], material: MaterialId.concrete };

describe('compileColliders', () => {
  it('builds SoA, rotation, slope normal and an ascending CSR grid', () => {
    const w = world([
      wall,
      { id: 'r', kind: 'ramp', pos: [30, null, 0], quat: [0, 0, 0, 1], size: [2.5, 0.7, 4.5], material: MaterialId.concrete },
      { id: 'p', kind: 'cylinder', pos: [5, null, 5], quat: [0, 0, 0, 1], size: [0.15, 3, 0], material: MaterialId.metal },
    ]);
    const c = w.colliders;
    expect(c.count).toBe(3);
    expect(Array.from(c.kind)).toEqual([0, 4, 1]);
    expect(c.rot[0]).toBe(1);
    expect(c.slopeNormal[3 + 1]).toBeCloseTo(4.5 / Math.hypot(4.5, 0.7), 12);
    expect(w.grid.cellSize).toBe(COLLIDER_GRID_CELL);
    for (let k = 0; k < w.grid.cols * w.grid.rows; k++) {
      for (let j = w.grid.cellStart[k]! + 1; j < w.grid.cellStart[k + 1]!; j++) {
        expect(w.grid.cellItems[j]!).toBeGreaterThan(w.grid.cellItems[j - 1]!);
      }
    }
  });
});

describe('applyColliderContacts', () => {
  it('a node dropped on a box comes to rest on its top face (one impact event, concrete)', () => {
    const s = makeState(1);
    s.posY[0] = 3;
    const sink = run(s, world([wall]), 4000);
    expect(s.posY[0]).toBeGreaterThan(2 + 0.05 - 0.002);
    expect(s.posY[0]).toBeLessThan(2.05);
    expect(Math.abs(s.velY[0]!)).toBeLessThan(1e-3);
    expect(sink.impacts.length).toBeGreaterThanOrEqual(1); // touchdown (+ small bounces)
    expect(sink.impacts[0]![8]).toBeCloseTo(Math.sqrt(2 * 9.81 * 0.95), 1);
    expect(sink.impacts[0]![0]).toBe(7);
    expect(sink.impacts[0]![1]).toBe(MaterialId.concrete);
    expect(s.flags[0]! & NODE_FLAG_IN_CONTACT).toBeTruthy();
  });

  it('holds a heavy node fired into a wall at 30 m/s within a few cm, and friction stops a slide', () => {
    const s = makeState(2);
    s.invMass[0] = 1 / 10;
    s.posY[0] = 1;
    s.posZ[0] = 2;
    s.velZ[0] = -30;
    // Node 1 slides along the top at 5 m/s.
    s.posY[1] = 2.05;
    s.velX[1] = 5;
    let minZ = Infinity;
    const sink = run(s, world([wall]), 3000, new Sink(), () => {
      minZ = Math.min(minZ, s.posZ[0]!);
    });
    expect(0.6 + 0.05 - minZ).toBeLessThan(0.15);
    expect(s.posZ[0]).toBeGreaterThan(0.6);
    expect(s.velZ[0]).toBeGreaterThanOrEqual(0); // bounced back, not tunnelled
    expect(Math.abs(s.velX[1]!)).toBeLessThan(1e-6); // μ 1 stopped it (5 m/s at 9.8 m/s² ≈ 0.5 s)
    expect(sink.skids).toBeGreaterThan(0);
  });

  it('a heavy fast node does not tunnel through a thin plate (bounces back out of its entry face)', () => {
    const s = makeState(1);
    s.invMass[0] = 1 / 10;
    s.posZ[0] = 0.5;
    s.posY[0] = 1;
    s.velZ[0] = -40;
    const plate: ColliderDef = { ...wall, size: [10, 1, 0.05] };
    let minZ = Infinity;
    run(s, world([plate]), 600, new Sink(), () => {
      minZ = Math.min(minZ, s.posZ[0]!);
    });
    expect(minZ).toBeGreaterThan(-0.05);
    expect(s.posZ[0]).toBeGreaterThan(0.1);
    expect(s.velZ[0]).toBeGreaterThan(0);
  });

  it('a pole is never passed through by a fast node (pushed back to the impact side)', () => {
    const s = makeState(1);
    s.invMass[0] = 1 / 8;
    s.posX[0] = 1;
    s.posY[0] = 1;
    s.velX[0] = -25;
    const pole: ColliderDef = { id: 'p', kind: 'cylinder', pos: [0, 3, 0], quat: [0, 0, 0, 1], size: [0.15, 3, 0], material: MaterialId.metal };
    let minX = Infinity;
    run(s, world([pole]), 2000, new Sink(), () => {
      minX = Math.min(minX, s.posX[0]!);
    });
    expect(minX).toBeGreaterThan(0);
    expect(s.posX[0]).toBeGreaterThan(0.15);
  });

  it('a node sliding down a ramp follows the slope (normal ⟂ slope, no tunnelling)', () => {
    const s = makeState(1);
    const ramp: ColliderDef = { id: 'r', kind: 'ramp', pos: [0, 0.7, 0], quat: [0, 0, 0, 1], size: [2.5, 0.7, 4.5], material: MaterialId.metal };
    s.friction[0] = 0.1;
    s.posZ[0] = -3; // surface y = 0.7 − 0.7·z/4.5
    s.posY[0] = 0.7 + (0.7 * 3) / 4.5 + 0.06;
    run(s, world([ramp]), 2000);
    const surf = 0.7 - (0.7 * s.posZ[0]!) / 4.5;
    expect(s.posZ[0]).toBeGreaterThan(-3); // slid toward the toe (+Z)
    expect(Math.abs(s.posY[0]! - surf - 0.05)).toBeLessThan(0.01);
  });

  it('nodes far from every collider are untouched (broadphase) and the kernel is deterministic', () => {
    const mk = () => {
      const s = makeState(64);
      for (let i = 0; i < 64; i++) {
        s.posX[i] = (i % 8) * 0.3 - 1;
        s.posY[i] = 2.3 + Math.floor(i / 8) * 0.1;
        s.posZ[i] = 0.2 * (i % 3);
        s.velY[i] = -3;
      }
      return s;
    };
    const w = world([wall, { id: 'far', kind: 'sphere', pos: [500, 1, 500], quat: [0, 0, 0, 1], size: [1, 0, 0], material: MaterialId.rock }]);
    const a = mk();
    const b = mk();
    run(a, w, 1500);
    run(b, w, 1500);
    expect(Array.from(a.posY)).toEqual(Array.from(b.posY));
    const far = makeState(1);
    far.posX[0] = 100;
    far.posY[0] = 1;
    const sink = run(far, w, 10);
    expect(sink.impacts.length).toBe(0);
    expect(far.flags[0]! & NODE_FLAG_IN_CONTACT).toBe(0);
  });
});

describe('engine + worker integration', () => {
  it('groundHeightfield installs the layout colliders; setColliders replaces the extra set; snapshots carry epoch + broken bits', async () => {
    const { WorkerHost } = await import('../worker');
    const { syntheticTerrain } = await import('../../world/sampler.testkit');
    const { DEFAULT_LAYOUT } = await import('../../world/layout');
    const { SnapshotReader } = await import('../../protocol/codec');
    const { softCube } = await import('../rig/testrigs');
    type Msg = import('../../protocol/messages').WorkerToMain;
    const posted: Msg[] = [];
    let now = 0;
    const host = new WorkerHost((m) => posted.push(m), { now: () => now, schedule: () => {} }, {
      generateTerrain: (layout) => ({ ...syntheticTerrain({ cols: 21, rows: 21, height: () => 1 }), layoutId: layout.id }),
      hashTerrain: () => 1,
    });
    host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 1024, beamCapacity: 4096 } });
    // Without props: the layout's P5 props would not fit this capacity (tested in props/props.test.ts).
    host.handle({ type: 'groundHeightfield', layout: { ...DEFAULT_LAYOUT, props: [], zones: DEFAULT_LAYOUT.zones.filter((z) => z.kind !== 'lake') }, terrainHash: 0 });
    const eng = host.engine!;
    expect(eng.colliderWorld!.colliders.ids).toEqual(DEFAULT_LAYOUT.colliders.map((c) => c.id));
    // Wall rests on the terrain (height 1 everywhere in the stub): centre y = 1 + 1.
    expect(eng.colliderWorld!.colliders.pos[1]).toBeCloseTo(2, 9);

    host.handle({ type: 'setColliders', colliders: [{ ...wall, id: 'extra', pos: [0, null, 0] }] });
    expect(eng.colliderWorld!.colliders.ids.at(-1)).toBe('extra');
    const n = eng.colliderWorld!.colliders.count;
    posted.length = 0;
    host.handle({ type: 'setColliders', colliders: [{ ...wall, id: 'crashWall' }] }); // clashes with a layout id
    host.handle({ type: 'setColliders', colliders: [{ ...wall, quat: [0, 0, 0, 2] }] });
    expect(posted.map((m) => m.type)).toEqual(['error', 'error']);
    expect(eng.colliderWorld!.colliders.count).toBe(n);
    host.handle({ type: 'setColliders', colliders: [] });
    expect(eng.colliderWorld!.colliders.count).toBe(DEFAULT_LAYOUT.colliders.length);

    host.handle({ type: 'spawn', objectId: 3, rig: softCube(), transform: { pos: [0, 3, 0], quat: [0, 0, 0, 1] } });
    host.handle({ type: 'reset', objectId: 3, transform: { pos: [0, 3, 0], quat: [0, 0, 0, 1] } });
    posted.length = 0;
    now += 20;
    host.wake();
    const snap = posted.find((m) => m.type === 'snapshot') as Extract<Msg, { type: 'snapshot' }>;
    const r = new SnapshotReader();
    r.attach(snap.buffer);
    expect(r.hasBrokenBeams).toBe(true);
    expect(r.objectRepairEpoch(0)).toBe(1);
  });
});

describe('candidate overflow (R-PHYS: R-WORLD ask)', () => {
  it('more colliders than COLLIDER_MAX_CANDIDATES near one object truncates deterministically instead of throwing', () => {
    // 100 small boxes in a 10 × 10 grid under a node spread over all of them
    const defs: ColliderDef[] = [];
    for (let i = 0; i < 100; i++) {
      defs.push({ id: `b${i}`, kind: 'box', pos: [(i % 10) * 0.5, 0.25, Math.floor(i / 10) * 0.5], quat: [0, 0, 0, 1], size: [0.2, 0.25, 0.2], material: MaterialId.concrete });
    }
    const make = (): SimState => {
      const s = makeState(2);
      s.posX[0] = 0;
      s.posY[0] = 0.52;
      s.posZ[0] = 0;
      s.posX[1] = 4.5;
      s.posY[1] = 0.52;
      s.posZ[1] = 4.5;
      return s;
    };
    const a = make();
    const b = make();
    const wa = world(defs);
    const wb = world(defs);
    expect(() => run(a, wa, 200)).not.toThrow();
    run(b, wb, 200);
    expect(wa.overflow ?? 0).toBeGreaterThan(0);
    // deterministic, and the node sitting on a kept (low-index) box still rests on it
    expect(a.posY[0]).toBe(b.posY[0]);
    expect(a.posY[0]!).toBeGreaterThan(0.5);
  });
});
