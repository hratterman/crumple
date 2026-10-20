/**
 * P7 live replay buffer: codec round trip, decimation + event aggregation,
 * ring wrap / group eviction with sleeping-object references, memory
 * accounting on a realistic scene (player sedan + 6 awake traffic + the
 * arena props), zero steady-state allocation, seek correctness, markers.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { SnapshotReader, SnapshotWriter } from '../../protocol/codec';
import { computeSnapshotLayout, OBJECT_FLAG_SLEEPING, TELEMETRY_SLOTS } from '../../protocol/layout';
import { PROP_LAYOUT_ID_BASE } from '../../protocol/messages';
import { TRAFFIC_FLAG_AWAKE, TRAFFIC_FLAG_TELEPORTED, TRAFFIC_ID_BASE, createTrafficAgentFrame } from '../../protocol/traffic';
import { compilePropRig } from '../../sim/props/catalog';
import { resolvePropInstances } from '../../sim/props/placement';
import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import { SEDAN_TRAFFIC } from '../../sim/vehicle/defs/sedanTraffic';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { ReplayBuffer } from './buffer';
import { REPLAY_BUFFER_PRESETS, REPLAY_CHUNK_BYTES, type ReplayBufferConfig } from './types';

interface SceneObject {
  id: number;
  nodes: number;
  beams: number;
  /** Rest offsets (xyz × nodes). */
  rest: Float32Array;
  sleeping: boolean;
  vehicle: boolean;
  /** Spread of the object, m. */
  size: number;
  x0: number;
  z0: number;
}

const CAP = { maxObjects: 320, nodeCapacity: 32768, beamCapacity: 131072 };

function makeObject(id: number, nodes: number, beams: number, size: number, sleeping: boolean, vehicle: boolean, rng: ReturnType<typeof createRng>): SceneObject {
  const rest = new Float32Array(nodes * 3);
  for (let i = 0; i < rest.length; i++) rest[i] = (rng.float() - 0.5) * size;
  return { id, nodes, beams, rest, sleeping, vehicle, size, x0: rng.range(-200, 200), z0: rng.range(-200, 200) };
}

/** Writes one deterministic scene snapshot at `tick` into `buf`; returns the reader. */
class SceneWriter {
  readonly layout = computeSnapshotLayout(CAP.maxObjects, CAP.nodeCapacity, CAP.beamCapacity, false);
  readonly buf = new ArrayBuffer(this.layout.totalBytes);
  readonly w = new SnapshotWriter(this.layout).attach(this.buf);
  readonly r = new SnapshotReader();
  private readonly tr = createTrafficAgentFrame();
  constructor(readonly objects: SceneObject[], readonly ghosts = 0) {}
  write(tick: number, opts: { impacts?: number; breaks?: number; brokenFrom?: number; teleport?: boolean; impulse?: number } = {}): SnapshotReader {
    const w = this.w;
    const t = tick / 2000;
    w.begin(tick, t, 1);
    let gb = 0;
    for (const o of this.objects) {
      const i = w.addObject(o.id, o.sleeping ? OBJECT_FLAG_SLEEPING : 0, o.nodes, o.beams);
      w.setRepairEpoch(i, o.id % 3);
      const g0 = this.nodeBase(o);
      const v = o.sleeping ? 0 : 12;
      for (let k = 0; k < o.nodes; k++) {
        const wob = o.sleeping ? 0 : 0.02 * Math.sin(t * 7 + k);
        w.setNode(g0 + k, o.x0 + v * t + o.rest[3 * k]! + wob, 1 + o.rest[3 * k + 1]!, o.z0 + o.rest[3 * k + 2]!);
      }
      if (o.vehicle) for (let s = 0; s < TELEMETRY_SLOTS; s++) w.setTelemetry(i, s, s === 23 ? Math.min(1, (opts.brokenFrom ?? Infinity) <= tick ? 0.3 : 0) : Math.sin(t + s));
      if (opts.brokenFrom !== undefined && tick >= opts.brokenFrom && o.vehicle) {
        for (let b = 0; b < o.beams; b += 7) w.setBeamBroken(gb + b, true);
      }
      gb += o.beams;
    }
    for (let k = 0; k < (opts.impacts ?? 0); k++) w.pushImpact(this.objects[0]!.id, 5, k, 1, 2, 0, 0, 1, opts.impulse ?? 3 + k);
    for (let k = 0; k < (opts.breaks ?? 0); k++) w.pushBeamBreak(this.objects[0]!.id, k, 1, 2, 3);
    w.pushSkid(this.objects[0]!.id, 0, tick, 0, 0, 3, 900);
    for (let a = 0; a < this.ghosts; a++) {
      const tr = this.tr;
      tr.agent = a;
      tr.objectId = 0;
      tr.flags = opts.teleport && a === 1 ? TRAFFIC_FLAG_TELEPORTED : 0;
      tr.variant = 0;
      tr.paint = a % 8;
      tr.state = 0;
      tr.pos[0] = a * 10 + t * 20;
      tr.pos[1] = 2;
      tr.pos[2] = -a;
      tr.quat[0] = 0;
      tr.quat[1] = Math.sin(t);
      tr.quat[2] = 0;
      tr.quat[3] = Math.cos(t);
      tr.speed = 20;
      tr.steer = 0.1;
      tr.brake = 0;
      tr.path = a;
      w.pushTrafficAgent(tr);
    }
    return this.r.attach(this.buf);
  }
  nodeBase(o: SceneObject): number {
    let g = 0;
    for (const p of this.objects) {
      if (p === o) return g;
      g += p.nodes;
    }
    return g;
  }
}

function realisticScene(awakeProps: number): SceneObject[] {
  const rng = createRng(3);
  const sedan = compileVehicle(SEDAN);
  const traffic = compileVehicle(SEDAN_TRAFFIC);
  const objs: SceneObject[] = [makeObject(1, sedan.rig.nodeCount, sedan.rig.beamCount, 4.6, false, true, rng)];
  for (let a = 0; a < 6; a++) objs.push(makeObject(TRAFFIC_ID_BASE + a, traffic.rig.nodeCount, traffic.rig.beamCount, 4.6, false, true, rng));
  const props = resolvePropInstances(DEFAULT_LAYOUT.props, () => 0);
  props.forEach((p, k) => {
    const rig = compilePropRig(p.prop);
    objs.push(makeObject(PROP_LAYOUT_ID_BASE + p.index, rig.nodeCount, rig.beamCount, 1, k >= awakeProps, false, rng));
  });
  return objs;
}

function decodeTo(buf: ReplayBuffer, i: number, epochOffset = 0, strains = false): SnapshotReader {
  const layout = computeSnapshotLayout(buf.maxObjects, buf.nodeCapacity, buf.beamCapacity, strains);
  const out = new ArrayBuffer(layout.totalBytes);
  buf.decode(i, new SnapshotWriter(layout).attach(out), epochOffset);
  return new SnapshotReader().attach(out);
}

/** Every field of `a` (decoded) matches `b` (source) — nodes within the quantization step. */
function expectFrameEqual(a: SnapshotReader, b: SnapshotReader, epochOffset = 0): number {
  expect(a.tick).toBe(b.tick);
  expect(a.simTime).toBe(b.simTime);
  expect(a.objectCount).toBe(b.objectCount);
  let maxErr = 0;
  const an = a.nodes;
  const bn = b.nodes;
  for (let i = 0; i < b.objectCount; i++) {
    expect(a.objectId(i)).toBe(b.objectId(i));
    expect(a.objectFlags(i)).toBe(b.objectFlags(i));
    expect(a.objectNodeCount(i)).toBe(b.objectNodeCount(i));
    expect(a.objectBeamCount(i)).toBe(b.objectBeamCount(i));
    expect(a.objectRepairEpoch(i)).toBe(b.objectRepairEpoch(i) + epochOffset);
    for (let s = 0; s < TELEMETRY_SLOTS; s++) expect(a.telemetry(i, s)).toBe(b.telemetry(i, s));
    const o = b.objectNodeOffset(i) * 3;
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < b.objectNodeCount(i) * 3; k++) {
      lo[k % 3] = Math.min(lo[k % 3]!, bn[o + k]!);
      hi[k % 3] = Math.max(hi[k % 3]!, bn[o + k]!);
    }
    for (let k = 0; k < b.objectNodeCount(i) * 3; k++) {
      const step = (hi[k % 3]! - lo[k % 3]!) / 65535;
      const err = Math.abs(an[o + k]! - bn[o + k]!);
      expect(err).toBeLessThanOrEqual(step * 0.5 + 1e-5 + Math.abs(bn[o + k]!) * 2e-7);
      if (err > maxErr) maxErr = err;
    }
    lo = hi = [];
  }
  for (let g = 0; g < b.beamTotal; g++) expect(a.isBeamBroken(g)).toBe(b.isBeamBroken(g));
  expect(a.trafficCount).toBe(b.trafficCount);
  const ta = createTrafficAgentFrame();
  const tb = createTrafficAgentFrame();
  for (let i = 0; i < b.trafficCount; i++) {
    a.readTrafficAgent(i, ta);
    b.readTrafficAgent(i, tb);
    ta.flags &= ~TRAFFIC_FLAG_TELEPORTED;
    tb.flags &= ~TRAFFIC_FLAG_TELEPORTED;
    expect(ta).toEqual(tb);
  }
  return maxErr;
}

const SMALL: ReplayBufferConfig = { seconds: 30, recordHz: 60, budgetBytes: 64 * 1024 * 1024, keyframeEvery: 30 };

describe('replay buffer codec', () => {
  it('round-trips every field (nodes within half a quantization step)', () => {
    const rng = createRng(1);
    // object 2's beams start at global 2000 (2000 % 32 = 16): misaligned broken words
    const objs = [makeObject(1, 600, 2000, 4.6, false, true, rng), makeObject(2, 300, 1013, 4.6, false, true, rng), makeObject(4100, 30, 90, 1, true, false, rng), makeObject(4101, 30, 90, 1, false, false, rng)];
    const scene = new SceneWriter(objs, 5);
    const buf = new ReplayBuffer(SMALL);
    const src = scene.write(500, { impacts: 3, breaks: 2, brokenFrom: 0 });
    expect(buf.record(src)).toBe(true);
    // the seek-generation epoch offset applies to traffic objects only (none here)
    const out = decodeTo(buf, 0, 7);
    const err = expectFrameEqual(out, src, 0);
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(1e-4);
    expect(out.impactCount).toBe(3);
    expect(out.beamBreakCount).toBe(2);
    expect(out.skidCount).toBe(1);
    const e = out.readImpact(2, { objectId: 0, materialId: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, impulse: 0 });
    expect(e).toEqual({ objectId: 1, materialId: 5, px: 2, py: 1, pz: 2, nx: 0, ny: 0, nz: 1, impulse: 5 });
  });

  it('records the debug strain section (i8 per beam) while recordStrains is on', () => {
    const rng = createRng(11);
    const objs = [makeObject(1, 40, 300, 4, false, true, rng), makeObject(4100, 20, 50, 1, true, false, rng)];
    const layout = computeSnapshotLayout(CAP.maxObjects, CAP.nodeCapacity, CAP.beamCapacity, true);
    const sbuf = new ArrayBuffer(layout.totalBytes);
    const w = new SnapshotWriter(layout).attach(sbuf);
    w.begin(100, 0.05, 1);
    let g = 0;
    for (const o of objs) {
      const i = w.addObject(o.id, o.sleeping ? OBJECT_FLAG_SLEEPING : 0, o.nodes, o.beams);
      for (let k = 0; k < o.nodes; k++) w.setNode(g + k, o.rest[3 * k]!, o.rest[3 * k + 1]!, o.rest[3 * k + 2]!);
      g += o.nodes;
      void i;
    }
    for (let b = 0; b < 350; b++) w.setStrain(b, b === 17 ? Number.NaN : Math.sin(b) * 0.9);
    const src = new SnapshotReader().attach(sbuf);
    const buf = new ReplayBuffer(SMALL);
    buf.recordStrains = true;
    buf.record(src);
    expect(buf.hasStrainFrames).toBe(true);
    const out = decodeTo(buf, 0, 0, true);
    const a = out.strains!;
    for (let b = 0; b < 350; b++) {
      if (b === 17) expect(a[b]).toBeNaN();
      else expect(Math.abs(a[b]! - Math.sin(b) * 0.9)).toBeLessThanOrEqual(0.5 / 127 + 1e-6);
    }
  });

  it('decimates 120 Hz snapshots to the record rate and aggregates events + teleports', () => {
    const rng = createRng(2);
    const scene = new SceneWriter([makeObject(1, 50, 100, 4, false, true, rng)], 3);
    const buf = new ReplayBuffer(SMALL);
    let recorded = 0;
    let sent = 0;
    for (let i = 1; i <= 240; i++) {
      const tick = Math.ceil((i * 2000) / 120);
      sent += 2; // 1 impact + 1 skid each
      if (buf.record(scene.write(tick, { impacts: 1, teleport: i === 3 }))) recorded++;
    }
    expect(recorded).toBeGreaterThanOrEqual(118);
    expect(recorded).toBeLessThanOrEqual(121);
    let got = 0;
    let teleports = 0;
    for (let f = 0; f < buf.count; f++) {
      const r = decodeTo(buf, f);
      got += r.impactCount + r.skidCount;
      const ta = createTrafficAgentFrame();
      for (let k = 0; k < r.trafficCount; k++) if ((r.readTrafficAgent(k, ta).flags & TRAFFIC_FLAG_TELEPORTED) !== 0) teleports++;
    }
    // every event lands in exactly one recorded frame (the trailing staged ones are not written yet)
    expect(sent - got).toBeLessThanOrEqual(2);
    expect(teleports).toBe(1);
  });

  it('wraps the chunk ring, evicts whole keyframe groups and keeps sleeping references valid', { timeout: 60_000 }, () => {
    const rng = createRng(4);
    // big frames: ~150 KB each → 26 per chunk; budget 3 chunks
    const objs = [makeObject(1, 20000, 100, 4, false, true, rng), ...Array.from({ length: 20 }, (_, k) => makeObject(4096 + k, 200, 50, 1, true, false, rng))];
    const scene = new SceneWriter(objs);
    const cfg: ReplayBufferConfig = { seconds: 60, recordHz: 60, budgetBytes: 3 * REPLAY_CHUNK_BYTES, keyframeEvery: 10 };
    const buf = new ReplayBuffer(cfg);
    const ticks: number[] = [];
    for (let i = 0; i < 300; i++) {
      const tick = 34 * (i + 1);
      ticks.push(tick);
      buf.record(scene.write(tick));
    }
    expect(buf.allocatedBytes).toBe(3 * REPLAY_CHUNK_BYTES);
    expect(buf.evicted).toBeGreaterThan(0);
    expect(buf.isKeyframe(0)).toBe(true);
    expect(buf.count + buf.evicted).toBe(300);
    expect(buf.bytes).toBeLessThanOrEqual(buf.allocatedBytes);
    // every held frame decodes to its source (sleeping props by reference)
    for (const f of [0, 1, 5, buf.count >> 1, buf.count - 1]) {
      const tick = buf.frameTick(f);
      expectFrameEqual(decodeTo(buf, f), scene.write(tick));
    }
    expect(buf.endTime).toBeCloseTo(ticks[299]! / 2000, 9);
  });

  it('evicts frames older than the configured seconds', () => {
    const rng = createRng(5);
    const scene = new SceneWriter([makeObject(1, 40, 10, 4, false, true, rng)]);
    const buf = new ReplayBuffer({ seconds: 2, recordHz: 60, budgetBytes: 64 * 1024 * 1024, keyframeEvery: 30 });
    for (let i = 0; i < 600; i++) buf.record(scene.write(34 * (i + 1)));
    expect(buf.endTime - buf.startTime).toBeLessThanOrEqual(2);
    expect(buf.endTime - buf.startTime).toBeGreaterThan(1.4);
  });
});

describe('replay buffer memory + cost (realistic scene)', () => {
  it('30 s of player + 6 awake traffic + the arena props fits the high budget (≤ 64 MB)', () => {
    const scene = new SceneWriter(realisticScene(12), 20);
    const cfg = REPLAY_BUFFER_PRESETS.high;
    const buf = new ReplayBuffer(cfg);
    const frames = cfg.seconds * cfg.recordHz;
    const t0 = performance.now();
    let recMs = 0;
    for (let i = 0; i < frames; i++) {
      const r = scene.write(Math.ceil(((i + 1) * 2000) / 60), { impacts: 4 });
      const a = performance.now();
      buf.record(r);
      if (i >= 600) recMs += performance.now() - a;
    }
    const nodes = scene.objects.reduce((s, o) => s + o.nodes, 0);
    const awakeNodes = scene.objects.reduce((s, o) => s + (o.sleeping ? 0 : o.nodes), 0);
    const per = buf.bytes / buf.count;
    const mb = (per * frames) / (1024 * 1024);
    console.log(
      `[replay] realistic scene: ${scene.objects.length} objects, ${nodes} nodes (${awakeNodes} awake), ${(per / 1024).toFixed(1)} KB/frame, ` +
        `30 s @ 60 Hz = ${mb.toFixed(1)} MB (held ${buf.count} frames, ${(buf.bytes / 1048576).toFixed(1)} MB in ${(buf.allocatedBytes / 1048576).toFixed(0)} MB of chunks), ` +
        `record ${(recMs / (frames - 600)).toFixed(3)} ms/frame (after warm-up) (wall ${(performance.now() - t0).toFixed(0)} ms incl. scene writes)`,
    );
    expect(buf.count).toBe(frames);
    expect(mb).toBeLessThan(64);
    expect(buf.allocatedBytes).toBeLessThanOrEqual(cfg.budgetBytes);
    // seek correctness on the realistic scene: a random held frame decodes to its source
    const f = 1234;
    expectFrameEqual(decodeTo(buf, f), scene.write(buf.frameTick(f), { impacts: 4 }));
    expect(buf.findFrame(buf.frameTime(f))).toBe(f);
    expect(buf.findFrame(buf.frameTime(f) + 0.5 / 60)).toBe(f);
  }, 60_000);

  it('records with zero steady-state allocation (no scavenge over 40k frames once the ring wrapped)', async () => {
    const rng = createRng(6);
    const objs = [makeObject(1, 120, 300, 4, false, true, rng), makeObject(4100, 30, 90, 1, true, false, rng), makeObject(4101, 26, 97, 1, false, false, rng)];
    const scene = new SceneWriter(objs, 4);
    const buf = new ReplayBuffer({ seconds: 5, recordHz: 60, budgetBytes: 2 * REPLAY_CHUNK_BYTES, keyframeEvery: 30 });
    // pre-build readers so the loop itself only records (the scene writer is test code)
    const readers: SnapshotReader[] = [];
    const sceneBufs: ArrayBuffer[] = [];
    for (let i = 0; i < 64; i++) {
      scene.write(34 * (i + 1), { impacts: 2, breaks: 1, brokenFrom: 34 * 40 });
      const b = scene.buf.slice(0);
      sceneBufs.push(b);
      const r = new SnapshotReader().attach(b);
      void r.nodes;
      readers.push(r);
    }
    // warm-up: wrap the ring several times
    let tick = 0;
    const feed = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const r = readers[i & 63]!;
        // fake a monotonic tick on the shared buffers: rewrite the tick word in place
        tick += 34;
        new Uint32Array(sceneBufs[i & 63]!, 8, 1)[0] = tick;
        buf.record(r);
      }
    };
    feed(5000);
    let scavenges = 0;
    // node's GC entries (no @types/node in this repo: typed locally)
    const perfHooks = 'node:perf_hooks';
    type Obs = { observe(o: { entryTypes: string[] }): void; disconnect(): void };
    const { PerformanceObserver } = (await import(/* @vite-ignore */ perfHooks)) as {
      PerformanceObserver: new (cb: (list: { getEntries(): unknown[] }) => void) => Obs;
    };
    // start from a collected heap (garbage of the earlier tests must not be blamed on this loop)
    const v8m = 'node:v8';
    const vmm = 'node:vm';
    const v8 = (await import(/* @vite-ignore */ v8m)) as { setFlagsFromString(f: string): void };
    const vm = (await import(/* @vite-ignore */ vmm)) as { runInNewContext(code: string): unknown };
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    gc();
    const obs = new PerformanceObserver((list) => {
      scavenges += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    // the tick rewrite above allocates a view per frame; measure with a pre-made view table instead
    const tickViews = sceneBufs.map((b) => new Uint32Array(b, 8, 1));
    await new Promise((r) => setTimeout(r, 20));
    scavenges = 0;
    const t0 = performance.now();
    for (let i = 0; i < 40000; i++) {
      tick += 34;
      tickViews[i & 63]![0] = tick;
      buf.record(readers[i & 63]!);
    }
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 20));
    obs.disconnect();
    console.log(`[replay] zero-alloc loop: 40k frames in ${ms.toFixed(0)} ms, ${scavenges} GC events`);
    expect(scavenges).toBe(0);
  }, 60_000);
});

describe('replay markers', () => {
  it('a hard hit becomes one merged marker with the peak frame', () => {
    const rng = createRng(7);
    const scene = new SceneWriter([makeObject(1, 50, 100, 4, false, true, rng)]);
    const buf = new ReplayBuffer(SMALL);
    const seen: number[] = [];
    buf.onMarker = (m) => seen.push(m.id);
    for (let i = 1; i <= 120; i++) {
      const tick = 34 * i;
      const hit = i >= 60 && i < 64;
      buf.record(scene.write(tick, hit ? { impacts: 10, impulse: i === 61 ? 500 : 100, breaks: i === 62 ? 30 : 0 } : {}));
    }
    const ms = buf.markers();
    expect(ms.length).toBe(1);
    const m = ms[0]!;
    expect(m.objectId).toBe(1);
    expect(m.severity).toBeGreaterThan(0.5);
    expect(m.breaks).toBe(30);
    expect(m.time).toBeCloseTo((34 * 61) / 2000, 6);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
