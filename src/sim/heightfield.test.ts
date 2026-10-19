/**
 * Heightfield ground (P3, D): contact kernels against createTerrainSampler.
 * Synthetic TerrainData only (no generator): bit-identity with the plane,
 * resting on slopes, the SEDAN parked on a 10 % grade, and a rolling
 * "hum" check against an analytic (exact, smooth) reference surface.
 */
import { describe, expect, it } from 'vitest';
import { GAME_CAPACITY, type MainToWorker, type Transform, type WorkerToMain } from '../protocol/messages';
import { resolveWater } from '../world/water';
import { resolvePropInstances } from './props/placement';
import { DEFAULT_LAYOUT } from '../world/layout';
import { createTerrainSampler } from '../world/sampler';
import { syntheticTerrain } from '../world/sampler.testkit';
import { SIM_DT, SIM_HZ, SimEngine } from './engine';
import { softCube, wreckingBall } from './rig/testrigs';
import type { RigDef } from './rig/types';
import { SIM_OBJECT_FLAG_SLEEPING, type HeightSampler, type SimState } from './types';
import { WorkerHost, type TerrainDeps } from './worker';
import type { TerrainData, WorldLayout } from '../world/types';
import { SEDAN } from './vehicle/defs/sedan';
import { kinematics, setMotion, stepN, type HandlingSim } from './vehicle/handling';

const SMALL = { maxObjects: 4, nodeCapacity: 2048, beamCapacity: 8192 };

function hashState(s: SimState): string {
  let h = 0x811c9dc5;
  for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.restLen, s.k, s.active, s.strainOut]) {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i]!, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function engine(): SimEngine {
  return new SimEngine({ gravity: [0, -9.81, 0], debugStrains: true, capacity: SMALL });
}

/** Rotation about +X by `pitch` then about +Y by `yaw` (q = qYaw · qPitch). */
function yawPitch(yaw: number, pitch: number): Transform['quat'] {
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2);
  const cp = Math.cos(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

function vehicleSim(eng: SimEngine, transform: Transform): HandlingSim {
  const obj = eng.spawnVehicle(1, SEDAN, transform, 'auto');
  const veh = eng.getVehicle(1)!;
  return { eng, obj, veh, cv: veh.vehicle, objectId: 1 };
}

function maxNodeSpeed(s: SimState, start: number, count: number): number {
  let m = 0;
  for (let i = start; i < start + count; i++) m = Math.max(m, Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!));
  return m;
}

describe('heightfield ground', () => {
  it('a flat heightfield simulates bit-identically to the plane (rigs + SEDAN)', () => {
    const run = (hf: boolean): string => {
      const eng = engine();
      if (hf) eng.setGroundTerrain(syntheticTerrain({ cols: 81, rows: 61, spacing: 0.75, height: () => 0 }));
      else eng.setGroundPlane(0, 0);
      eng.spawn(2, softCube({ deform: 80, breakF: 400 }), { pos: [0, 3, 0], quat: [0.1, 0.2, 0.05, 0.97] });
      eng.spawn(3, wreckingBall(), { pos: [-6, 6, 0], quat: [0, 0, 0, 1] });
      eng.spawnVehicle(1, SEDAN, { pos: [8, 0.02, 4], quat: [0, 0, 0, 1] }, 'auto');
      eng.setInput(1, { throttle: 0.6, steer: 0.3 });
      for (let t = 0; t < 2500; t++) eng.step();
      return hashState(eng.state);
    };
    expect(run(true)).toBe(run(false));
  }, 60_000);

  it('a lone node and a soft cube come to rest on a curved slope, like on the exact surface', () => {
    const f = (x: number, z: number) => 0.2 * x + 0.05 * z + 0.3 * Math.sin(x / 3) * Math.cos(z / 4);
    const rest = (sampler: HeightSampler | null) => {
      const eng = engine();
      if (sampler) eng.sampler = sampler;
      else eng.setGroundTerrain(syntheticTerrain({ cols: 41, rows: 41, spacing: 0.5, height: f }));
      const s = eng.sampler!;
      const node: RigDef = { name: 'node', nodes: [{ id: 'n', pos: [0, 0, 0], mass: 2, radius: 0.05, friction: 1 }], beams: [] };
      eng.spawn(1, node, { pos: [3.3, s.heightAt(3.3, -2.1) + 0.3, -2.1], quat: [0, 0, 0, 1] });
      // softCube is 1.5 m centred on pos: drop it from 0.2 m above the highest ground under it.
      let top = -Infinity;
      for (let x = -2.75; x <= -1.25; x += 0.25) for (let z = 0.25; z <= 1.75; z += 0.25) top = Math.max(top, s.heightAt(x, z));
      eng.spawn(2, softCube(), { pos: [-2, top + 0.95, 1], quat: [0, 0, 0, 1] });
      const st = eng.state;
      const [n, cube] = eng.objects;
      const ni = n!.nodeStart;
      stepN({ eng } as HandlingSim, 1 * SIM_HZ);
      const p1 = [st.posX[ni]!, st.posY[ni]!, st.posZ[ni]!];
      let nodeV = 0;
      for (let t = 0; t < SIM_HZ; t++) {
        eng.step();
        nodeV = Math.max(nodeV, Math.hypot(st.velX[ni]!, st.velY[ni]!, st.velZ[ni]!));
      }
      const nodeDrift = Math.hypot(st.posX[ni]! - p1[0]!, st.posY[ni]! - p1[1]!, st.posZ[ni]! - p1[2]!);
      const gap = st.posY[ni]! - st.radius[ni]! - s.heightAt(st.posX[ni]!, st.posZ[ni]!);
      // The soft cube (ζ ≈ 0.17 lattice) lands on an edge and rocks for ~10 s on a slope.
      stepN({ eng } as HandlingSim, 11 * SIM_HZ);
      let cubeV = 0;
      for (let t = 0; t < SIM_HZ; t++) {
        eng.step();
        if (t % 5 === 0) cubeV = Math.max(cubeV, maxNodeSpeed(st, cube!.nodeStart, cube!.nodeCount));
      }
      return { nodeV, nodeDrift, gap, cubeV };
    };
    const analytic: HeightSampler = {
      heightAt: f,
      normalAt(x, z, out) {
        const e = 1e-4;
        const gx = (f(x + e, z) - f(x - e, z)) / (2 * e);
        const gz = (f(x, z + e) - f(x, z - e)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        out[0] = -gx / l;
        out[1] = 1 / l;
        out[2] = -gz / l;
      },
      materialAt: () => 0,
    };
    const hf = rest(null);
    const ref = rest(analytic);
    console.log(
      `[heightfield] resting on a curved slope: node max speed ${hf.nodeV.toExponential(2)} m/s, drift ${hf.nodeDrift.toExponential(2)} m; ` +
        `cube max node speed after 13 s ${hf.cubeV.toExponential(2)} m/s (exact surface ${ref.cubeV.toExponential(2)})`,
    );
    expect(hf.nodeV).toBeLessThan(1e-4);
    expect(hf.nodeDrift).toBeLessThan(1e-5);
    // Resting ON the surface: the vertical gap of the sphere's bottom is r·(1/n_y − 1) − depth/n_y (mm here).
    expect(Math.abs(hf.gap)).toBeLessThan(0.005);
    expect(hf.cubeV).toBeLessThan(2e-3);
    expect(hf.cubeV).toBeLessThan(1.5 * ref.cubeV + 2e-4);
  }, 60_000);

  it('SEDAN on a 10 % heightfield grade: brake holds (< 1 mm/s creep), released it rolls', () => {
    const run = (brake: number, grade: number): { creep: number; speed: number; jitter: number } => {
      const eng = engine();
      // uphill toward −Z (vehicle forward): h = −0.1·z, slight crown across
      eng.setGroundTerrain(
        syntheticTerrain({ cols: 61, rows: 61, spacing: 1, height: (x, z) => -grade * z - 0.01 * x * x * (grade / 0.1) }),
      );
      const sim = vehicleSim(eng, { pos: [0, 0.03, 0], quat: yawPitch(0, Math.atan(grade)) });
      eng.setInput(1, { gearSelect: 0, brake });
      stepN(sim, 3 * SIM_HZ);
      const k0 = kinematics(sim);
      let jitter = 0;
      for (let t = 0; t < 2 * SIM_HZ; t++) {
        eng.step();
        if (t % 20 === 0) jitter = Math.max(jitter, maxNodeSpeed(eng.state, sim.obj.nodeStart, sim.cv.bodyNodeCount));
      }
      const k1 = kinematics(sim);
      return { creep: Math.hypot(k1.cx - k0.cx, k1.cz - k0.cz) / 2, speed: Math.hypot(k1.vx, k1.vz), jitter };
    };
    const grade = 0.1;
    const held = run(1, grade);
    const flat = run(1, 0);
    const free = run(0, grade);
    console.log(
      `[heightfield] 10 % grade: braked creep ${(held.creep * 1000).toFixed(3)} mm/s, max body-node speed ` +
        `${held.jitter.toFixed(3)} m/s (flat: ${flat.jitter.toFixed(3)}); unbraked ${free.speed.toFixed(2)} m/s after 5 s`,
    );
    expect(held.creep).toBeLessThan(1e-3);
    // The parked sedan's body nodes carry ~0.14 m/s of residual vibration on
    // flat ground too (plane == flat heightfield, see the bit-identity test).
    expect(held.jitter).toBeLessThan(1.5 * flat.jitter);
    expect(free.speed).toBeGreaterThan(0.5); // the grade is real
  }, 60_000);

  it('SEDAN rolling over a smooth heightfield ramp does not hum (vs an exact analytic surface)', () => {
    // Heading yaw 0.5 rad (crosses both cell-edge families). Profile along
    // the heading s: flat, then a C1 blend into a 7 % downhill over 20 m,
    // plus 12–15 cm waves along and across (λ 16–19 m) so the normal varies
    // from cell to cell in x and z. (Measured: raw facet normals score the
    // same as smoothed ones on this metric in the current kernel — the
    // normal enters the depth only via n_y — so this guards the sampler
    // against regressions vs the exact surface rather than vs facets.)
    const yaw = 0.5;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const G = 0.07;
    const prof = (s: number): [number, number] => {
      if (s < 8) return [0, 0];
      if (s < 28) {
        const u = (s - 8) / 20;
        return [-G * 20 * (u * u * u - u * u * u * u / 2), -G * (3 * u * u - 2 * u * u * u)];
      }
      return [-G * 20 * 0.5 - G * (s - 28), -G];
    };
    const f = (x: number, z: number): number => {
      const s = x * dx + z * dz;
      const l = -x * dz + z * dx;
      return prof(s)[0] + (0.15 * Math.sin(l / 2.5) + 0.12 * Math.sin(s / 3)) * Math.min(1, Math.max(0, s / 8));
    };
    const terrain = syntheticTerrain({ cols: 161, rows: 161, spacing: 1, height: f });
    const hf = createTerrainSampler(terrain);
    // Analytic reference: same surface from the f64 formula with its exact normal.
    const analytic: HeightSampler = {
      heightAt: f,
      normalAt(x, z, out) {
        const e = 1e-4;
        const gx = (f(x + e, z) - f(x - e, z)) / (2 * e);
        const gz = (f(x, z + e) - f(x, z - e)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        out[0] = -gx / l;
        out[1] = 1 / l;
        out[2] = -gz / l;
      },
      materialAt: () => 0,
    };

    const hum = (sampler: HeightSampler): { noise: number; speed: number } => {
      const eng = engine();
      eng.sampler = sampler;
      const sim = vehicleSim(eng, { pos: [0, 0.02, 0], quat: yawPitch(yaw, 0) });
      eng.setInput(1, { gearSelect: 0 });
      stepN(sim, 1.5 * SIM_HZ);
      setMotion(sim, 15, 0);
      const st = eng.state;
      const hubs = sim.veh.wheels.flatMap((w) => [w.hubI, w.hubO]);
      const n = Math.round(3 * SIM_HZ);
      const acc = hubs.map(() => new Float64Array(n));
      const prev = hubs.map((h) => st.velY[h]!);
      for (let t = 0; t < n; t++) {
        eng.step();
        hubs.forEach((h, k) => {
          acc[k]![t] = (st.velY[h]! - prev[k]!) / SIM_DT;
          prev[k] = st.velY[h]!;
        });
      }
      // High-pass: deviation from a centred 41-tick (20 ms) moving average → content above ~50 Hz.
      const W = 20;
      let sum2 = 0;
      let cnt = 0;
      for (const a of acc) {
        for (let t = W; t < n - W; t++) {
          let m = 0;
          for (let q = t - W; q <= t + W; q++) m += a[q]!;
          const d = a[t]! - m / (2 * W + 1);
          sum2 += d * d;
          cnt++;
        }
      }
      const k = kinematics(sim);
      return { noise: Math.sqrt(sum2 / cnt), speed: Math.hypot(k.vx, k.vy, k.vz) };
    };
    const ref = hum(analytic);
    const got = hum(hf);
    console.log(
      `[heightfield] ramp hum (hub vertical accel > 50 Hz, RMS): heightfield ${got.noise.toFixed(2)} m/s², ` +
        `analytic ${ref.noise.toFixed(2)} m/s² (end speed ${got.speed.toFixed(1)} / ${ref.speed.toFixed(1)} m/s)`,
    );
    expect(got.speed).toBeGreaterThan(14); // it actually rolled down the ramp
    expect(Math.abs(got.speed - ref.speed)).toBeLessThan(0.3);
    expect(got.noise).toBeLessThan(1.25 * ref.noise + 0.5);
  }, 60_000);
});

describe('WorkerHost groundHeightfield', () => {
  function makeHost(deps?: TerrainDeps) {
    const posted: WorkerToMain[] = [];
    let now = 0;
    const host = new WorkerHost((msg) => posted.push(msg), { now: () => now, schedule: () => {} }, deps);
    return {
      host,
      posted,
      send: (m: MainToWorker) => host.handle(m),
      advance(ms: number) {
        now += ms;
        host.wake();
      },
      setNow(ms: number) {
        now = ms;
      },
    };
  }
  const INIT: MainToWorker = { type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: SMALL };

  /** Stub generator: a small synthetic tilted terrain per layout id; counts calls. */
  function stubDeps(hash = 0xdeadbeef) {
    const calls: string[] = [];
    const deps: TerrainDeps = {
      generateTerrain(layout: WorldLayout): TerrainData {
        calls.push(layout.id);
        if (layout.id === 'bad') throw new Error('WorldLayoutError: junction j1 is not on road r2');
        return { ...syntheticTerrain({ cols: 21, rows: 21, height: (x, z) => 0.1 * x + 0.05 * z, material: () => 2 }), layoutId: layout.id };
      },
      hashTerrain: () => hash,
    };
    return { deps, calls };
  }
  /** DEFAULT_LAYOUT under another id, without props (the stub terrain is tiny; P5 props are tested below). */
  const layout = (id: string): WorldLayout => ({ ...DEFAULT_LAYOUT, id, props: [] });

  it('installs the regenerated terrain and answers terrainReady (matched / unchecked / mismatch + error)', () => {
    const { deps, calls } = stubDeps();
    const h = makeHost(deps);
    h.send({ type: 'groundHeightfield', layout: layout('a'), terrainHash: 1 });
    expect(h.posted.at(-1)).toMatchObject({ type: 'error', command: 'groundHeightfield', message: 'not initialized' });
    h.send(INIT);
    h.posted.length = 0;

    h.send({ type: 'groundHeightfield', layout: layout('a'), terrainHash: 0xdeadbeef });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ type: 'terrainReady', layoutId: 'a', terrainHash: 0xdeadbeef, matched: true });
    const eng = h.host.engine!;
    expect(eng.terrain?.layoutId).toBe('a');
    expect(eng.terrain?.splat.length).toBe(0); // dropped in the worker
    expect(eng.sampler!.heightAt(2, 4)).toBeCloseTo(0.1 * 2 + 0.05 * 4, 6);
    expect(eng.sampler!.materialAt(0, 0)).toBe(2);

    h.send({ type: 'groundHeightfield', layout: layout('b'), terrainHash: 0 });
    expect(h.posted.slice(1)).toEqual([expect.objectContaining({ type: 'terrainReady', layoutId: 'b', matched: false })]);

    h.posted.length = 0;
    h.send({ type: 'groundHeightfield', layout: layout('c'), terrainHash: 0x1234 });
    expect(h.posted.map((m) => m.type)).toEqual(['terrainReady', 'error']);
    expect(h.posted[0]).toMatchObject({ layoutId: 'c', terrainHash: 0xdeadbeef, matched: false });
    expect(h.posted[1]).toMatchObject({ command: 'groundHeightfield' });
    expect((h.posted[1] as { message: string }).message).toMatch(/hash mismatch.*0xdeadbeef.*0x00001234/);
    expect(eng.terrain?.layoutId).toBe('c'); // installed anyway
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('rejects bad layouts / hashes with an error and keeps the previous ground', () => {
    const { deps } = stubDeps();
    const h = makeHost(deps);
    h.send(INIT);
    h.send({ type: 'ground', mode: 'plane', y: 0.5, materialId: 0 });
    h.posted.length = 0;
    h.send({ type: 'groundHeightfield', layout: layout('bad'), terrainHash: 0 });
    h.send({ type: 'groundHeightfield', layout: layout('a'), terrainHash: -1 });
    h.send({ type: 'groundHeightfield', layout: null as unknown as WorldLayout, terrainHash: 0 });
    expect(h.posted.map((m) => m.type)).toEqual(['error', 'error', 'error']);
    expect(h.posted[0]).toMatchObject({ command: 'groundHeightfield', message: expect.stringContaining('WorldLayoutError') });
    expect(h.host.engine!.terrain).toBeNull();
    expect(h.host.engine!.sampler!.heightAt(0, 0)).toBe(0.5);
    expect(h.posted.map((m) => m.type)).not.toContain('fatal');
  });

  it('a slow generation is skipped, not caught up; queued spawns land on the heightfield', () => {
    const { deps } = stubDeps();
    const slow: TerrainDeps = {
      generateTerrain: (l) => {
        h.setNow(5000); // generation "took" 5 s of wall time
        return deps.generateTerrain(l);
      },
      hashTerrain: deps.hashTerrain,
    };
    const h = makeHost(slow);
    h.send(INIT);
    h.send({ type: 'groundHeightfield', layout: layout('a'), terrainHash: 0xdeadbeef });
    expect(h.posted.at(-1)).toMatchObject({ type: 'terrainReady', generateMs: 5000 });
    h.send({ type: 'spawn', objectId: 1, rig: softCube(), transform: { pos: [0, 2, 0], quat: [0, 0, 0, 1] } });
    h.advance(10);
    expect(h.host.engine!.tick).toBe(20); // no 200-step burst for the 5 s spent generating
    expect(h.host.droppedSteps).toBe(0);
    for (let k = 0; k < 150; k++) h.advance(10); // 1.5 s
    const st = h.host.engine!.state;
    const s = h.host.engine!.sampler!;
    for (let i = 0; i < st.nodeCount; i++) {
      expect(st.posY[i]! - st.radius[i]! - s.heightAt(st.posX[i]!, st.posZ[i]!)).toBeGreaterThan(-0.05);
    }
  });

  it('DEFAULT_LAYOUT end to end: the real generator, u32 hash, cube rests on a resolved spawn', () => {
    const h = makeHost();
    h.send({ ...INIT, capacity: GAME_CAPACITY } as MainToWorker);
    h.posted.length = 0;
    const t0 = performance.now();
    h.send({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
    const loadMs = performance.now() - t0;
    const ready = h.posted[0];
    if (ready?.type !== 'terrainReady') throw new Error(`expected terrainReady, got ${JSON.stringify(h.posted)}`);
    expect(ready.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(Number.isInteger(ready.terrainHash) && ready.terrainHash > 0 && ready.terrainHash <= 0xffffffff).toBe(true);
    expect(ready.matched).toBe(false);
    expect(h.posted.filter((m) => m.type === 'error')).toEqual([]);
    const eng = h.host.engine!;
    // P5: every layout prop is spawned asleep at its resolved placement.
    const instances = resolvePropInstances(DEFAULT_LAYOUT.props, (x, z) => eng.sampler!.heightAt(x, z));
    expect(ready.props).toBe(instances.length);
    for (const inst of instances) {
      const o = eng.arena.get(inst.objectId)!;
      expect(o.flags & SIM_OBJECT_FLAG_SLEEPING).toBe(SIM_OBJECT_FLAG_SLEEPING);
    }
    expect(ready.waterBodies).toBe(resolveWater(DEFAULT_LAYOUT, eng.terrain!).length);
    const t = eng.terrain!;
    expect(t.cols * t.rows).toBe(t.heights.length);
    const sp = t.spawns[0]!;
    h.send({ type: 'spawn', objectId: 1, rig: softCube(), transform: { pos: [sp.pos[0], sp.pos[1] + 1.2, sp.pos[2]], quat: [0, 0, 0, 1] } });
    for (let k = 0; k < 200; k++) h.advance(10); // 2 s
    const st = eng.state;
    let maxV = 0;
    for (let i = 0; i < st.nodeCount; i++) {
      maxV = Math.max(maxV, Math.hypot(st.velX[i]!, st.velY[i]!, st.velZ[i]!));
      expect(st.posY[i]! - st.radius[i]! - eng.sampler!.heightAt(st.posX[i]!, st.posZ[i]!)).toBeGreaterThan(-0.05);
    }
    console.log(`[heightfield] DEFAULT_LAYOUT worker load ${loadMs.toFixed(0)} ms, hash 0x${ready.terrainHash.toString(16)}`);
    expect(maxV).toBeLessThan(0.5);
  }, 60_000);
});
