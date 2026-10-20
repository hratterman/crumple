import { describe, expect, it } from 'vitest';
import { createRng } from '../core/rng';
import { buildVertexNormals, createTerrainSampler, type HeightfieldSampler } from './sampler';
import { syntheticTerrain } from './sampler.testkit';

const out = new Float64Array(3);
const out2 = new Float64Array(3);

function normalDiff(s: HeightfieldSampler, x0: number, z0: number, x1: number, z1: number): number {
  s.normalAt(x0, z0, out);
  s.normalAt(x1, z1, out2);
  return Math.hypot(out[0]! - out2[0]!, out[1]! - out2[1]!, out[2]! - out2[2]!);
}

/** Rough random terrain (worst case for normal continuity): ±2 m white noise on a 1.5 m grid, off-integer origin. */
function roughSampler(): HeightfieldSampler {
  const rng = createRng(7);
  return createTerrainSampler(
    syntheticTerrain({ cols: 41, rows: 33, spacing: 1.5, originX: -30.25, originZ: 12.5, height: () => (rng.float() - 0.5) * 4 }),
  );
}

describe('createTerrainSampler', () => {
  it('heightAt is exact on vertices (dyadic spacing) and within 1e-6 m otherwise', () => {
    for (const spacing of [1, 0.5, 2]) {
      const rng = createRng(1);
      const t = syntheticTerrain({ cols: 17, rows: 9, spacing, originX: -8, originZ: 4, height: () => (rng.float() - 0.5) * 100 });
      const s = createTerrainSampler(t);
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          expect(s.heightAt(t.originX + c * spacing, t.originZ + r * spacing)).toBe(t.heights[r * t.cols + c]);
        }
      }
    }
    const s = roughSampler();
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const h = s.heightAt(s.originX + c * s.spacing, s.originZ + r * s.spacing);
        expect(Math.abs(h - s.heights[r * s.cols + c]!)).toBeLessThan(1e-6);
      }
    }
  });

  it('heightAt is bilinear inside a cell', () => {
    const t = syntheticTerrain({ cols: 2, rows: 2, spacing: 2, originX: 0, originZ: 0, height: (x, z) => (x === 0 ? (z === 0 ? 1 : 3) : z === 0 ? 2 : 7) });
    const s = createTerrainSampler(t);
    // corners h00=1 h10=2 h01=3 h11=7 at tx=0.25, tz=0.75
    const a = 1 + (2 - 1) * 0.25;
    const b = 3 + (7 - 3) * 0.25;
    expect(s.heightAt(0.5, 1.5)).toBeCloseTo(a + (b - a) * 0.75, 12);
  });

  it('height and normal are continuous across cell edges (random rough terrain)', () => {
    const s = roughSampler();
    const rng = createRng(3);
    const eps = 1e-7;
    let worstN = 0;
    let worstH = 0;
    let worstFacet = 0;
    for (let k = 0; k < 4000; k++) {
      const vertical = k % 2 === 0;
      const c = 1 + Math.floor(rng.float() * (s.cols - 2));
      const r = 1 + Math.floor(rng.float() * (s.rows - 2));
      const x = s.originX + (vertical ? c : c + rng.float()) * s.spacing;
      const z = s.originZ + (vertical ? r + rng.float() : r) * s.spacing;
      const [xa, za, xb, zb] = vertical ? [x - eps, z, x + eps, z] : [x, z - eps, x, z + eps];
      worstN = Math.max(worstN, normalDiff(s, xa, za, xb, zb));
      worstH = Math.max(worstH, Math.abs(s.heightAt(xa, za) - s.heightAt(xb, zb)));
      worstFacet = Math.max(worstFacet, facetJump(s, xa, za, xb, zb));
    }
    expect(worstN).toBeLessThan(1e-3);
    expect(worstH).toBeLessThan(1e-5);
    // The check discriminates: raw bilinear-patch normals jump across the same edges.
    expect(worstFacet).toBeGreaterThan(0.1);
  });

  it('normal is locally Lipschitz everywhere (finite differences at random points)', () => {
    const s = roughSampler();
    const rng = createRng(4);
    const d = 1e-6;
    let worst = 0;
    for (let k = 0; k < 20000; k++) {
      const x = s.originX + rng.float() * (s.cols - 1) * s.spacing;
      const z = s.originZ + rng.float() * (s.rows - 1) * s.spacing;
      const a = rng.float() * 2 * Math.PI;
      worst = Math.max(worst, normalDiff(s, x, z, x + d * Math.cos(a), z + d * Math.sin(a)) / d);
    }
    // ±2 m noise on 1.5 m cells: the blend varies by O(1) per cell → O(1)/m.
    // A jump anywhere would read ≥ 1e-2 / 1e-6 = 1e4.
    expect(worst).toBeLessThan(20);
  });

  it('tilted plane: exact slope normal everywhere (incl. border cells), bilinear height', () => {
    const a = 0.1;
    const b = -0.25;
    const s = createTerrainSampler(
      syntheticTerrain({ cols: 23, rows: 19, spacing: 1, originX: -11, originZ: -9, height: (x, z) => a * x + b * z + 3 }),
    );
    const l = Math.hypot(a, 1, b);
    const rng = createRng(5);
    for (let k = 0; k < 2000; k++) {
      const x = -11 + rng.float() * 22;
      const z = -9 + rng.float() * 18;
      s.normalAt(x, z, out);
      expect(Math.abs(out[0]! - -a / l)).toBeLessThan(1e-6);
      expect(Math.abs(out[1]! - 1 / l)).toBeLessThan(1e-6);
      expect(Math.abs(out[2]! - -b / l)).toBeLessThan(1e-6);
      expect(Math.abs(s.heightAt(x, z) - (a * x + b * z + 3))).toBeLessThan(1e-5);
      expect(Math.hypot(out[0]!, out[1]!, out[2]!)).toBeCloseTo(1, 12);
    }
  });

  it('smooth surface: normal within 5e-3 of the analytic normal at 1 m spacing', () => {
    const f = (x: number, z: number) => 3 * Math.sin(x / 7) * Math.cos(z / 9);
    const s = createTerrainSampler(syntheticTerrain({ cols: 81, rows: 81, height: f }));
    const rng = createRng(6);
    let worst = 0;
    for (let k = 0; k < 5000; k++) {
      const x = -38 + rng.float() * 76;
      const z = -38 + rng.float() * 76;
      const gx = (3 / 7) * Math.cos(x / 7) * Math.cos(z / 9);
      const gz = (-3 / 9) * Math.sin(x / 7) * Math.sin(z / 9);
      const l = Math.hypot(gx, 1, gz);
      s.normalAt(x, z, out);
      worst = Math.max(worst, Math.hypot(out[0]! + gx / l, out[1]! - 1 / l, out[2]! + gz / l));
    }
    expect(worst).toBeLessThan(5e-3);
  });

  it('materialAt / splatAt use the nearest sample', () => {
    const t = syntheticTerrain({
      cols: 6,
      rows: 5,
      spacing: 2,
      originX: 0,
      originZ: 0,
      height: () => 0,
      material: (_x, _z, c, r) => (c + 2 * r) % 7,
      splat: (c, r, px) => {
        px[0] = 10 * c;
        px[1] = 20 * r;
        px[2] = 5;
        px[3] = 1;
      },
    });
    const s = createTerrainSampler(t);
    const w = new Float64Array(5);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        for (const [dx, dz] of [
          [0, 0],
          [0.99, -0.99],
          [-0.99, 0.99],
        ] as const) {
          const x = c * 2 + dx;
          const z = r * 2 + dz;
          expect(s.materialAt(x, z)).toBe((c + 2 * r) % 7);
          s.splatAt(x, z, w);
          expect(w[0]).toBeCloseTo((10 * c) / 255, 12);
          expect(w[1]).toBeCloseTo((20 * r) / 255, 12);
          expect(w[0]! + w[1]! + w[2]! + w[3]! + w[4]!).toBeCloseTo(1, 12);
        }
      }
    }
    expect(s.materialAt(1.01, 0)).toBe(1); // nearer col 1
    expect(s.materialAt(0.99, 0)).toBe(0);
    expect(s.materialAt(-50, 3.1)).toBe((0 + 2 * 2) % 7); // clamped to col 0, nearest row 2
    expect(s.materialAt(500, 500)).toBe((5 + 2 * 4) % 7);
    // dropped splat → pure grass
    const s2 = createTerrainSampler({ ...t, splat: new Uint8Array(0) });
    s2.splatAt(3, 3, w);
    expect([...w]).toEqual([0, 0, 0, 0, 1]);
  });

  it('outside the grid: edge-clamped height; normal blends C0 into the flat extension within one cell', () => {
    const s = createTerrainSampler(
      syntheticTerrain({ cols: 11, rows: 11, spacing: 1, originX: 0, originZ: 0, height: (x, z) => 0.2 * x + 0.1 * z }),
    );
    expect(s.contains(5, 5)).toBe(true);
    expect(s.contains(0, 10)).toBe(true);
    expect(s.contains(-0.01, 5)).toBe(false);
    expect(s.contains(5, 10.01)).toBe(false);
    // past +X: height of the x = 10 edge, normal keeps the along-edge (z) slope only
    expect(s.heightAt(25, 4.5)).toBeCloseTo(s.heightAt(10, 4.5), 12);
    s.normalAt(25, 4.5, out);
    const l = Math.hypot(1, 0.1);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1 / l, 6);
    expect(out[2]).toBeCloseTo(-0.1 / l, 6);
    // exactly one cell out the blend is complete
    s.normalAt(11, 4.5, out2);
    expect([...out2]).toEqual([...out]);
    // C0 across the border itself and the ring line
    for (const [x0, z0, x1, z1] of [
      [10 - 1e-9, 3.3, 10 + 1e-9, 3.3],
      [11 - 1e-9, 3.3, 11 + 1e-9, 3.3],
      [4.2, -1e-9, 4.2, 1e-9],
      [-1e-9, -1e-9, 1e-9, 1e-9],
    ] as const) {
      expect(normalDiff(s, x0, z0, x1, z1)).toBeLessThan(1e-6);
    }
    // past a corner: flat
    expect(s.heightAt(-5, -5)).toBe(s.heightAt(0, 0));
    s.normalAt(-5, -5, out);
    expect([...out]).toEqual([0, 1, 0]);
    // far away / non-finite-safe indices (| 0 would wrap past 2^31)
    expect(s.materialAt(1e12, -1e12)).toBe(s.materialAt(10, 0));
    expect(s.heightAt(-1e12, 1e12)).toBe(s.heightAt(0, 10));
    s.normalAt(3e9, 5, out);
    expect(out[0]).toBe(0);
  });

  it('a flat grid reproduces the plane exactly (height, normal (0,1,0), material)', () => {
    const s = createTerrainSampler(syntheticTerrain({ cols: 9, rows: 7, spacing: 1.3, height: () => 0.25, material: () => 2 }));
    const rng = createRng(8);
    for (let k = 0; k < 1000; k++) {
      const x = (rng.float() - 0.5) * 30;
      const z = (rng.float() - 0.5) * 30;
      expect(s.heightAt(x, z)).toBe(0.25);
      s.normalAt(x, z, out);
      expect(Object.is(out[0], 0) && out[1] === 1 && Object.is(out[2], 0)).toBe(true);
      expect(s.materialAt(x, z)).toBe(2);
    }
  });

  it('rejects malformed grids', () => {
    const t = syntheticTerrain({ cols: 3, rows: 3, height: () => 0 });
    expect(() => createTerrainSampler({ ...t, heights: new Float32Array(8) })).toThrow(RangeError);
    expect(() => createTerrainSampler({ ...t, material: new Uint8Array(8) })).toThrow(RangeError);
    expect(() => createTerrainSampler({ ...t, cols: 1, rows: 9 })).toThrow(RangeError);
    expect(() => createTerrainSampler({ ...t, spacing: 0 })).toThrow(RangeError);
  });

  // 15 M sampler calls (warm-up included): ~0.8 s idle, far more on a loaded box — an explicit budget.
  it('hot path does not allocate (no GC during 3 M warmed-up calls, incl. a second sampler instance)', { timeout: 60_000 }, async () => {
    // node:v8 via a computed specifier: the project has no @types/node.
    const v8 = (await import(/* @vite-ignore */ ['node', 'v8'].join(':'))) as {
      GCProfiler: new () => { start(): void; stop(): { statistics: unknown[] } | undefined };
    };
    const proc = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process;
    const samplers = [roughSampler(), roughSampler()];
    const rng = createRng(9);
    const xs = new Float64Array(1024);
    const zs = new Float64Array(1024);
    const s0 = samplers[0]!;
    for (let i = 0; i < 1024; i++) {
      xs[i] = s0.originX - 3 + rng.float() * (s0.cols + 5) * s0.spacing; // includes out-of-bounds
      zs[i] = s0.originZ - 3 + rng.float() * (s0.rows + 5) * s0.spacing;
    }
    const acc = new Float64Array(1);
    const run = (s: HeightfieldSampler, n: number): void => {
      for (let k = 0; k < n; k++) {
        for (let i = 0; i < 1024; i++) {
          s.normalAt(xs[i]!, zs[i]!, out);
          acc[0] = s.heightAt(xs[i]!, zs[i]!) + out[1]! + s.materialAt(xs[i]!, zs[i]!);
        }
      }
    };
    // Warm up into optimized code (interpreted code boxes doubles), then
    // switch instance: the inlined code goes generic (see INLINING).
    run(samplers[0]!, 2000);
    run(samplers[1]!, 2000);
    // Best of 3 measured passes per instance. Optimization is a background (concurrent) compile: on a
    // starved box the first pass can still run in baseline code, which boxes doubles and allocates.
    // An allocating hot path allocates on EVERY call (3 M × ≥ 16 B ≫ the young generation), so it
    // GCs in every pass and still fails.
    for (const s of samplers) {
      let best = { gcs: Infinity, heap: Infinity };
      for (let attempt = 0; attempt < 3 && best.gcs > 0; attempt++) {
        const heap0 = proc.memoryUsage().heapUsed;
        const prof = new v8.GCProfiler();
        prof.start();
        run(s, 1000);
        const stats = prof.stop();
        const heap1 = proc.memoryUsage().heapUsed;
        const gcs = stats?.statistics.length ?? 0;
        if (gcs < best.gcs) best = { gcs, heap: heap1 - heap0 };
      }
      expect(best.gcs).toBe(0);
      expect(best.heap).toBeLessThan(256 * 1024);
    }
  });

  it('perf: default-size normal grid build time and sampler calls/s (clustered contact pattern)', { timeout: 30_000 }, () => {
    const cols = 1409;
    const heights = new Float32Array(cols * cols);
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 20 * Math.sin(c * 0.013) * Math.cos(r * 0.017);
    let build = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      buildVertexNormals(heights, cols, cols, 1);
      build = Math.min(build, performance.now() - t0);
    }
    const s = createTerrainSampler({
      ...syntheticTerrain({ cols: 2, rows: 2, height: () => 0 }),
      cols,
      rows: cols,
      originX: -704,
      originZ: -704,
      heights,
      material: new Uint8Array(cols * cols),
      splat: new Uint8Array(0),
    });
    const N = 1 << 14;
    const xs = new Float64Array(N);
    const zs = new Float64Array(N);
    const rng = createRng(10);
    for (let i = 0; i < N; i++) {
      xs[i] = 100 + rng.float() * 5; // one car's footprint
      zs[i] = -50 + rng.float() * 3;
    }
    const acc = new Float64Array(1);
    const bench = (fn: (i: number) => void): number => {
      for (let w = 0; w < 50; w++) for (let i = 0; i < N; i++) fn(i);
      let best = 0;
      for (let rep = 0; rep < 5; rep++) {
        const t0 = performance.now();
        for (let k = 0; k < 40; k++) for (let i = 0; i < N; i++) fn(i);
        best = Math.max(best, (40 * N) / (performance.now() - t0) / 1e3);
      }
      return best; // M calls/s
    };
    const h = bench((i) => {
      acc[0] = s.heightAt(xs[i]!, zs[i]!);
    });
    const n = bench((i) => {
      s.normalAt(xs[i]!, zs[i]!, out);
    });
    const m = bench((i) => {
      acc[0] = s.materialAt(xs[i]!, zs[i]!);
    });
    console.log(
      `[sampler] normal grid 1409² build ${build.toFixed(1)} ms (${((cols * cols * 12) / 1048576).toFixed(1)} MB); ` +
        `heightAt ${h.toFixed(1)} M/s, normalAt ${n.toFixed(1)} M/s, materialAt ${m.toFixed(1)} M/s`,
    );
    expect(build).toBeLessThan(500);
    // Target ≥ 20 M calls/s each: measured ~50–160 M/s on an idle 2.1 GHz
    // Xeon core (normalAt ~54). The asserted floor is lower because the
    // full suite runs files in parallel on shared cores.
    expect(h).toBeGreaterThan(5);
    expect(n).toBeGreaterThan(5);
    expect(m).toBeGreaterThan(5);
  });
});

/** |Δn| of the RAW bilinear-patch (facet) normal between two points (test reference only). */
function facetJump(s: HeightfieldSampler, x0: number, z0: number, x1: number, z1: number): number {
  const a = facetNormal(s, x0, z0);
  const b = facetNormal(s, x1, z1);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function facetNormal(s: HeightfieldSampler, x: number, z: number): [number, number, number] {
  const u = (x - s.originX) / s.spacing;
  const v = (z - s.originZ) / s.spacing;
  const c = Math.min(Math.floor(u), s.cols - 2);
  const r = Math.min(Math.floor(v), s.rows - 2);
  const tx = u - c;
  const tz = v - r;
  const H = s.heights;
  const i = r * s.cols + c;
  const h00 = H[i]!;
  const h10 = H[i + 1]!;
  const h01 = H[i + s.cols]!;
  const h11 = H[i + s.cols + 1]!;
  const gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / s.spacing;
  const gz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / s.spacing;
  const l = Math.hypot(gx, 1, gz);
  return [-gx / l, 1 / l, -gz / l];
}
