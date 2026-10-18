import { describe, expect, it } from 'vitest';
import {
  BufferPool,
  SNAPSHOT_POOL_SIZE,
  SnapshotFormatError,
  SnapshotReader,
  SnapshotWriter,
  checkSnapshot,
} from './codec';
import {
  BEAM_BREAK_CAPACITY,
  EventKind,
  IMPACT_CAPACITY,
  SKID_CAPACITY,
  createBeamBreakEvent,
  createImpactEvent,
  createSkidEvent,
} from './events';
import {
  HDR_U32_MAGIC,
  HDR_U32_VERSION,
  HEADER_BYTES,
  OBJECT_FLAG_SLEEPING,
  SECTION_ALIGN,
  SNAPSHOT_FLAG_DEBUG_STRAINS,
  Telemetry,
  computeSnapshotBytes,
  computeSnapshotLayout,
} from './layout';

function makeLayout(debugStrains = true) {
  return computeSnapshotLayout(4, 64, 128, debugStrains);
}

function writeFrame(w: SnapshotWriter, tick: number): void {
  w.begin(tick, tick / 2000, 0.5);
  const xs = new Float64Array([9, 1, 2, 3, 4]);
  const ys = new Float64Array([9, 10, 20, 30, 40]);
  const zs = new Float64Array([9, -1, -2, -3, -4]);
  const a = w.addObject(3, 0, 2, 3);
  w.writeNodesSoA(a, xs, ys, zs, 1);
  w.writeStrains(a, new Float32Array([0.25, -1, NaN]), 0);
  w.setTelemetry(a, Telemetry.speed, 12.5);
  const b = w.addObject(7, OBJECT_FLAG_SLEEPING, 2, 1);
  w.writeNodesSoA(b, xs, ys, zs, 3);
  w.writeStrains(b, new Float32Array([0, 0.75]), 1);
  w.setTelemetry(b, Telemetry.engineRpm, 3000);
}

describe('layout', () => {
  it('aligns every section and sizes strains only when enabled', () => {
    const L = makeLayout(true);
    for (const off of [L.objectsOffset, L.impactsOffset, L.beamBreaksOffset, L.skidsOffset, L.nodesOffset, L.strainsOffset]) {
      expect(off % SECTION_ALIGN).toBe(0);
    }
    expect(L.objectsOffset).toBe(HEADER_BYTES);
    expect(L.totalBytes).toBeGreaterThanOrEqual(L.strainsOffset + 128 * 4);
    const noStrain = makeLayout(false);
    expect(noStrain.strainsOffset).toBe(0);
    expect(noStrain.totalBytes).toBeLessThan(L.totalBytes);
    expect(computeSnapshotBytes(4, 64, 128, true)).toBe(L.totalBytes);
  });
});

describe('codec roundtrip', () => {
  it('roundtrips header, objects, nodes, strains, telemetry', () => {
    const L = makeLayout(true);
    const buf = new ArrayBuffer(L.totalBytes);
    const w = new SnapshotWriter(L).attach(buf);
    writeFrame(w, 4000);
    const r = new SnapshotReader().attach(buf);

    expect(r.tick).toBe(4000);
    expect(r.simTime).toBe(2);
    expect(r.timeScale).toBe(0.5);
    expect(r.flags & SNAPSHOT_FLAG_DEBUG_STRAINS).toBeTruthy();
    expect(r.objectCount).toBe(2);
    expect(r.nodeTotal).toBe(4);
    expect(r.beamTotal).toBe(4);
    expect([r.maxObjects, r.nodeCapacity, r.beamCapacity]).toEqual([4, 64, 128]);

    expect(r.objectId(0)).toBe(3);
    expect(r.objectId(1)).toBe(7);
    expect(r.objectFlags(1)).toBe(OBJECT_FLAG_SLEEPING);
    expect([r.objectNodeOffset(1), r.objectNodeCount(1), r.objectBeamOffset(1), r.objectBeamCount(1)]).toEqual([2, 2, 3, 1]);
    expect(r.findObject(7)).toBe(1);
    expect(r.findObject(5)).toBe(-1);

    expect(Array.from(r.nodes)).toEqual([1, 10, -1, 2, 20, -2, 3, 30, -3, 4, 40, -4]);
    expect(Array.from(r.objectNodes(1))).toEqual([3, 30, -3, 4, 40, -4]);
    expect(r.objectNodes(1)).toBe(r.objectNodes(1)); // cached, no per-call allocation

    const s = r.strains!;
    expect(s.length).toBe(4);
    expect([s[0], s[1], s[3]]).toEqual([0.25, -1, 0.75]);
    expect(Number.isNaN(s[2])).toBe(true);
    expect(Array.from(r.objectStrains(1)!)).toEqual([0.75]);

    expect(r.telemetry(0, Telemetry.speed)).toBe(12.5);
    expect(r.objectTelemetry(1)[Telemetry.engineRpm]).toBe(3000);
    expect(r.telemetry(1, Telemetry.speed)).toBe(0);
  });

  it('omits strains when debugStrains is off', () => {
    const L = makeLayout(false);
    const buf = new ArrayBuffer(L.totalBytes);
    const w = new SnapshotWriter(L).attach(buf);
    writeFrame(w, 1);
    const r = new SnapshotReader().attach(buf);
    expect(r.hasStrains).toBe(false);
    expect(r.strains).toBeNull();
    expect(r.objectStrains(0)).toBeNull();
    expect(r.nodeTotal).toBe(4);
  });

  it('roundtrips all three event kinds and counts overflow', () => {
    const L = makeLayout(true);
    const buf = new ArrayBuffer(L.totalBytes);
    const w = new SnapshotWriter(L).attach(buf);
    w.begin(1, 0, 1);
    for (let i = 0; i < IMPACT_CAPACITY + 5; i++) {
      const ok = w.pushImpact(i, 6, i, 1, 2, 0, 1, 0, i * 0.5);
      expect(ok).toBe(i < IMPACT_CAPACITY);
    }
    for (let i = 0; i < BEAM_BREAK_CAPACITY + 2; i++) w.pushBeamBreak(1, i, 0.5, i, 1.5);
    for (let i = 0; i < SKID_CAPACITY + 7; i++) w.pushSkid(2, 1, i, 0, 0, 3.5, 4000);
    w.addOverflow(EventKind.skid, 3);

    const r = new SnapshotReader().attach(buf);
    expect([r.impactCount, r.impactOverflow]).toEqual([IMPACT_CAPACITY, 5]);
    expect([r.beamBreakCount, r.beamBreakOverflow]).toEqual([BEAM_BREAK_CAPACITY, 2]);
    expect([r.skidCount, r.skidOverflow]).toEqual([SKID_CAPACITY, 10]);

    const imp = r.readImpact(10, createImpactEvent());
    expect(imp).toEqual({ objectId: 10, materialId: 6, px: 10, py: 1, pz: 2, nx: 0, ny: 1, nz: 0, impulse: 5 });
    expect(r.impactObjectId(255)).toBe(255);
    const v = new Float32Array(6);
    r.impactPos(3, v, 0);
    r.impactNormal(3, v, 3);
    expect(Array.from(v)).toEqual([3, 1, 2, 0, 1, 0]);
    expect(r.impactImpulse(3)).toBe(1.5);

    expect(r.readBeamBreak(7, createBeamBreakEvent())).toEqual({ objectId: 1, beamIndex: 7, px: 0.5, py: 7, pz: 1.5 });
    expect(r.beamBreakBeamIndex(BEAM_BREAK_CAPACITY - 1)).toBe(BEAM_BREAK_CAPACITY - 1);

    expect(r.readSkid(511, createSkidEvent())).toEqual({ objectId: 2, materialId: 1, px: 511, py: 0, pz: 0, slip: 3.5, load: 4000 });
    expect([r.skidObjectId(0), r.skidMaterialId(0), r.skidSlip(0), r.skidLoad(0)]).toEqual([2, 1, 3.5, 4000]);

    // begin() resets counts and overflow
    w.begin(2, 0, 1);
    r.attach(buf);
    expect([r.impactCount, r.impactOverflow, r.skidOverflow, r.objectCount]).toEqual([0, 0, 0, 0]);
  });

  it('writer and reader re-attach to different buffers', () => {
    const L = makeLayout(true);
    const b1 = new ArrayBuffer(L.totalBytes);
    const b2 = new ArrayBuffer(L.totalBytes + 64); // larger buffers are fine
    const w = new SnapshotWriter(L);
    w.attach(b1);
    writeFrame(w, 10);
    w.attach(b2);
    w.begin(20, 0.01, 1);
    w.addObject(1, 0, 1, 0);
    w.setNode(0, 5, 6, 7);
    w.pushImpact(1, 0, 0, 0, 0, 0, 1, 0, 1);

    const r = new SnapshotReader();
    r.attach(b1);
    expect(r.tick).toBe(10);
    expect(r.objectCount).toBe(2);
    expect(r.objectNodes(1).length).toBe(6);
    expect(r.impactCount).toBe(0);
    r.attach(b2);
    expect(r.tick).toBe(20);
    expect(r.objectCount).toBe(1);
    expect(Array.from(r.objectNodes(0))).toEqual([5, 6, 7]); // cache invalidated
    expect(r.nodes.length).toBe(3);
    expect(r.impactCount).toBe(1);
    r.attach(b1);
    expect(r.tick).toBe(10);
    expect(Array.from(r.objectNodes(0))).toEqual([1, 10, -1, 2, 20, -2]);
  });

  it('rejects non-ascending ids and capacity overruns', () => {
    const L = makeLayout(true);
    const w = new SnapshotWriter(L).attach(new ArrayBuffer(L.totalBytes));
    w.begin(0, 0, 1);
    w.addObject(5, 0, 1, 1);
    expect(() => w.addObject(5, 0, 1, 1)).toThrow(RangeError);
    expect(() => w.addObject(6, 0, 1000, 1)).toThrow(RangeError);
    expect(() => new SnapshotWriter(L).attach(new ArrayBuffer(L.totalBytes - 16))).toThrow(RangeError);
  });
});

describe('format validation', () => {
  it('detects magic and version mismatch', () => {
    const L = makeLayout(false);
    const buf = new ArrayBuffer(L.totalBytes);
    new SnapshotWriter(L).attach(buf).begin(0, 0, 1);
    expect(checkSnapshot(buf)).toBe('ok');
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 4))).toBe('CRMP');

    const u = new Uint32Array(buf);
    u[HDR_U32_VERSION] = 999;
    expect(checkSnapshot(buf)).toBe('bad-version');
    expect(() => new SnapshotReader().attach(buf)).toThrow(SnapshotFormatError);
    try {
      new SnapshotReader().attach(buf);
    } catch (e) {
      expect((e as SnapshotFormatError).code).toBe('bad-version');
    }
    u[HDR_U32_MAGIC] = 0xdeadbeef;
    expect(checkSnapshot(buf)).toBe('bad-magic');
    expect(checkSnapshot(new ArrayBuffer(16))).toBe('too-small');
    expect(checkSnapshot(new ArrayBuffer(HEADER_BYTES))).toBe('bad-magic');
  });
});

describe('BufferPool', () => {
  it('hands out 3 buffers, skips when empty, accepts returns', () => {
    const pool = new BufferPool(256);
    expect(pool.size).toBe(SNAPSHOT_POOL_SIZE);
    const got = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(got.every((b) => b instanceof ArrayBuffer && b.byteLength === 256)).toBe(true);
    expect(pool.acquire()).toBeNull();
    expect(pool.misses).toBe(1);
    pool.release(got[0]!);
    expect(pool.available).toBe(1);
    expect(() => pool.release(got[0]!)).toThrow();
    expect(() => pool.release(new ArrayBuffer(128))).toThrow(RangeError);
    expect(pool.acquire()).toBe(got[0]);
  });
});
