/**
 * R-CORE: the kernel's ground pass (kernel.c `ground`, with the PlaneSampler
 * and world/sampler.ts heightfield sampler mirrored over a terrain tile cache)
 * is BIT-IDENTICAL to collision/ground.ts + the JS sampler:
 *   (1) the mirrored sampler against heightAt / normalAt / materialAt at
 *       random points, grid / tile boundaries and far outside the grid;
 *   (2) tile-cache eviction (more tiles than the pool holds, visited twice);
 *   (3) whole-engine runs on a hilly multi-material heightfield (a sedan
 *       driving and steering across many tiles, a box dropped on a slope),
 *       state + impact / skid events hash-compared across js / wasm / simd.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { MaterialId } from '../../protocol/messages';
import type { TerrainData } from '../../world/types';
import { SimEngine } from '../engine';
import { JS_KERNEL, type KernelFactory } from '../kernel';
import { SEDAN } from '../vehicle/defs/sedan';
import { SIMD_KERNEL, WASM_KERNEL, simdSupported, type WasmSimKernel } from './kernel';

const KERNELS: KernelFactory[] = simdSupported() ? [WASM_KERNEL, SIMD_KERNEL] : [WASM_KERNEL];
const N_MAT = 15;

function terrain(cols: number, rows: number, spacing: number, ox: number, oz: number, seed: number): TerrainData {
  const rng = createRng(seed);
  const heights = new Float32Array(cols * rows);
  const material = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * spacing;
      const z = r * spacing;
      heights[r * cols + c] = 1.5 * Math.sin(x * 0.07) * Math.cos(z * 0.05) + 0.4 * Math.sin(x * 0.31 + z * 0.17) + 0.03 * rng.float();
      material[r * cols + c] = rng.float() < 0.7 ? MaterialId.asphalt : rng.int(0, N_MAT - 1);
    }
  }
  return {
    layoutId: 'test',
    layoutVersion: 1,
    seed,
    originX: ox,
    originZ: oz,
    spacing,
    cols,
    rows,
    heights,
    splat: new Uint8Array(0),
    material,
    minHeight: -3,
    maxHeight: 3,
    waterLevel: -100,
    roads: [],
    spawns: [],
    hash: 0,
  };
}

function engineOn(kf: KernelFactory, t: TerrainData): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, kernel: kf, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundTerrain(t);
  return eng;
}

const same = (a: number, b: number): boolean => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

describe('kernel ground parity (bit-identical to collision/ground.ts + world/sampler.ts)', () => {
  for (const kf of KERNELS) {
    it(`${kf.kind}: mirrored heightfield sampler = JS sampler (random, boundary and outside points)`, () => {
      const t = terrain(141, 103, 1.25, -80.5, -60.25, 7);
      const eng = engineOn(kf, t);
      const s = eng.sampler!;
      const k = eng.kernel as WasmSimKernel;
      const rng = createRng(11);
      const pts: [number, number][] = [];
      const x0 = t.originX;
      const z0 = t.originZ;
      const x1 = x0 + (t.cols - 1) * t.spacing;
      const z1 = z0 + (t.rows - 1) * t.spacing;
      for (let i = 0; i < 20000; i++) pts.push([rng.range(x0 - 12, x1 + 12), rng.range(z0 - 12, z1 + 12)]);
      // Grid samples, cell / tile boundaries (32-cell tiles), the edges and corners, beyond them.
      for (let c = 0; c < t.cols; c += 1) for (const r of [0, 1, 31, 32, 33, 63, 64, t.rows - 2, t.rows - 1]) pts.push([x0 + c * t.spacing, z0 + r * t.spacing]);
      for (const x of [x0 - 1e6, x0 - t.spacing, x0 - 0.5 * t.spacing, x0, x1, x1 + 0.5 * t.spacing, x1 + t.spacing, x1 + 1e6]) {
        for (const z of [z0 - 1e6, z0 - t.spacing, z0, 0.5 * (z0 + z1), z1, z1 + t.spacing, z1 + 1e6]) pts.push([x, z]);
      }
      pts.push([NaN, 0], [0, NaN]);
      const n = new Float64Array(3);
      let bad = 0;
      for (const [x, z] of pts) {
        const got = k.groundSample(s, x, z)!;
        expect(got).not.toBeNull();
        s.normalAt(x, z, n);
        const want = [s.heightAt(x, z), n[0]!, n[1]!, n[2]!, s.materialAt(x, z)];
        for (let q = 0; q < 5; q++) {
          if (!same(got[q]!, want[q]!)) {
            if (bad++ < 5) expect.fail(`(${x}, ${z}) slot ${q}: kernel ${got[q]} vs JS ${want[q]}`);
          }
        }
      }
      expect(bad).toBe(0);
    });

    it(`${kf.kind}: tile cache evicts and reloads (more tiles than the pool), still identical`, () => {
      const t = terrain(420, 420, 1, -210, -210, 3);
      const eng = engineOn(kf, t);
      const s = eng.sampler!;
      const k = eng.kernel as WasmSimKernel;
      const n = new Float64Array(3);
      for (let pass = 0; pass < 2; pass++) {
        for (let tz = 0; tz < 14; tz++) {
          for (let tx = 0; tx < 14; tx++) {
            const x = -210 + tx * 32 + 7.3;
            const z = -210 + tz * 32 + 19.1;
            const got = k.groundSample(s, x, z)!;
            s.normalAt(x, z, n);
            expect([got[0], got[1], got[2], got[3], got[4]]).toEqual([s.heightAt(x, z), n[0], n[1], n[2], s.materialAt(x, z)]);
          }
        }
      }
    });
  }

  function hashRun(eng: SimEngine, ticks: number, perTick?: (i: number) => void): string {
    let h = 0x811c9dc5;
    const f = new Float64Array(1);
    const u = new Uint32Array(f.buffer);
    const word = (x: number): void => {
      f[0] = x;
      h = Math.imul(h ^ u[0]!, 0x01000193) >>> 0;
      h = Math.imul(h ^ u[1]!, 0x01000193) >>> 0;
    };
    let impacts = 0;
    let skids = 0;
    for (let i = 0; i < ticks; i++) {
      perTick?.(i);
      eng.step();
      if (i % 50 === 49) {
        const ev = eng.events;
        for (let e = 0; e < ev.impactCount * 9; e++) word(ev.impacts[e]!);
        for (let e = 0; e < ev.skidCount * 7; e++) word(ev.skids[e]!);
        impacts += ev.impactCount;
        skids += ev.skidCount;
        ev.clear();
      }
    }
    const s = eng.state;
    for (let i = 0; i < s.nodeCount; i++) {
      word(s.posX[i]!);
      word(s.posY[i]!);
      word(s.posZ[i]!);
      word(s.velX[i]!);
      word(s.velY[i]!);
      word(s.velZ[i]!);
      word(s.frcX[i]!);
      word(s.flags[i]!);
    }
    return `${h >>> 0}:${impacts}:${skids}`;
  }

  it('sedan driving and steering across a hilly multi-material heightfield (many tiles): identical on every kernel', () => {
    const t = terrain(260, 200, 1, -40, -100, 5);
    const run = (kf: KernelFactory): string => {
      const eng = engineOn(kf, t);
      const s = eng.sampler!;
      eng.spawnVehicle(1, SEDAN, { pos: [0, s.heightAt(0, 0) + 0.6, 0], quat: [0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4)] }, 'auto');
      const obj = eng.arena.get(1)!;
      obj.actions[0] = 0.8;
      obj.actions[5] = 1;
      return hashRun(eng, 6000, (i) => {
        obj.actions[2] = Math.sin(i / 700);
        if (i === 4500) {
          obj.actions[0] = 0;
          obj.actions[1] = 1;
        }
      });
    };
    const ref = run(JS_KERNEL);
    const [, impacts, skids] = ref.split(':');
    expect(Number(impacts) + Number(skids)).toBeGreaterThan(0);
    for (const kf of KERNELS) expect(run(kf), kf.kind).toBe(ref);
  }, 300_000);

  it('plane ground: the sedan crash-dropped from 3 m (impacts, skids) is identical on every kernel', () => {
    const run = (kf: KernelFactory): string => {
      const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, kernel: kf, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
      eng.setGroundPlane(0.25, MaterialId.concrete);
      eng.spawnVehicle(1, SEDAN, { pos: [0, 3, 0], quat: [0.2, 0, 0.1, Math.sqrt(1 - 0.05)] }, 'auto');
      return hashRun(eng, 3000);
    };
    const ref = run(JS_KERNEL);
    for (const kf of KERNELS) expect(run(kf), kf.kind).toBe(ref);
  }, 300_000);
});
