/**
 * Heightfield sampler over TerrainData (D, P3). Implements the FROZEN
 * TerrainSampler (structurally identical to sim's HeightSampler), so the
 * same object drives ground collision (worker, 2 kHz per contact node),
 * cameras and ribbon conforming (main).
 *
 * Semantics (src/world/types.ts):
 *  - heightAt: bilinear interpolation of the 4 surrounding samples, in f64
 *    from the f32 grid; EXACT at grid vertices (penetration depth).
 *  - normalAt: C0-continuous smoothed normal = bilinear blend of the 4
 *    corner VERTEX normals, renormalized. Vertex normal = normalize(
 *    −∂h/∂x, 1, −∂h/∂z) by central differences (one-sided on the grid's
 *    border rows/cols, so a tilted plane reads its exact slope everywhere).
 *    The raw bilinear-patch normal jumps across every cell edge, and a
 *    rolling tyre crosses ~25 edges/s per node at 25 m/s → 2 kHz chatter.
 *  - materialAt: material[nearest sample].
 *  - splatAt / contains: nearest-sample splat weights / grid bounds test.
 *
 * OUTSIDE THE GRID (documented edge rule): heightAt clamps (x, z) to the
 * grid, so the surface is the border row/col extruded outward (flat
 * extension; the layout's edge rise already walls the map in). normalAt
 * blends, over the first cell outside the border, from the border vertex
 * normal to that extension's own normal (outward slope component zeroed,
 * renormalized; +Y past a corner) and is constant beyond. So the normal is
 * C0 everywhere, and a node far past the edge gets no phantom sideways
 * push from a slope it is not on.
 *
 * Vertex normals are precomputed ONCE at construction into three planar
 * f32 grids with that one-vertex ring around the terrain plus one pad
 * row/col (24 MB, ~30–45 ms for the default 1409² map in node;
 * sampler.test.ts measures it). Per call that leaves 12 reads, one sqrt and
 * one divide; the build-free alternative (4 vertex normals from a
 * 12-sample stencil, 5 sqrt) measured ~21 M calls/s vs ~32 M. The pad lets
 * a clamped point on the last ring line use the generic cell path (its far
 * corners get weight 0), which keeps normalAt small.
 *
 * INLINING (why the methods look the way they do). A sampler call that V8
 * does NOT inline passes x and z as boxed HeapNumbers, i.e. allocates on
 * every contact query (measured: a 647-byte normalAt made the 2 kHz ground
 * pass allocate ~7 MB per simulated second and run ~30 % slower). Hence:
 *  - each method stays under V8's 460-byte bytecode inlining limit
 *    (normalAt is ~448 — re-check with `node --print-bytecode
 *    --print-bytecode-filter=normalAt` after ANY edit to it);
 *  - the methods are closures over bindMethods' PARAMETERS (cheaper to
 *    load than `this.` fields, and no TDZ hole checks);
 *  - clamps assign `max * 1`, not `max`: once a second sampler exists the
 *    inlined code reads the context generically (tagged), and a phi of a
 *    double with a tagged value boxes the double on every call; `* 1`
 *    makes it a number-typed float64 (exact).
 * The engine stays allocation-free with any number of heightfields, but a
 * worker that switches plane ⇄ heightfield makes the kernel call sites
 * polymorphic (no longer inlined): send groundHeightfield INSTEAD of a
 * plane, not after one.
 *
 * HOT PATH (numerics contract): heightAt / normalAt / materialAt use only
 * + − × ÷ sqrt, comparisons and integer truncation (`| 0` on a value
 * clamped ≥ 0 = floor), never allocate, and are deterministic.
 * A perfectly flat grid returns exactly the PlaneSampler values (height
 * bit-exact, normal exactly (0, 1, 0)), so a flat heightfield simulates
 * bit-identically to the plane.
 */
import type { TerrainData, TerrainSampler } from './types';

/** TerrainSampler plus the grid it reads (read-only views; do not mutate). */
export interface HeightfieldSampler extends TerrainSampler {
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  readonly material: Uint8Array;
  /** May be empty (the worker drops splat); splatAt then reports pure grass. */
  readonly splat: Uint8Array;
  /** Unit vertex normals, planar with ring + pad (layout in buildVertexNormals). */
  readonly normals: VertexNormals;
  /** Wall-clock ms spent building `normals` (perf telemetry). */
  readonly buildMs: number;
}

/** FROZEN entry point (CreateTerrainSampler). Builds the vertex-normal grids once (see INLINING above). */
export function createTerrainSampler(terrain: TerrainData): HeightfieldSampler {
  const { cols, rows, spacing, heights, material, originX, originZ } = terrain;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) {
    throw new RangeError(`terrain grid must be at least 2×2 (got ${cols}×${rows})`);
  }
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError(`terrain spacing must be > 0 (got ${spacing})`);
  if (!Number.isFinite(originX) || !Number.isFinite(originZ)) throw new RangeError('terrain origin must be finite');
  const n = cols * rows;
  if (heights.length !== n) throw new RangeError(`heights holds ${heights.length} samples, expected ${n}`);
  if (material.length !== n) throw new RangeError(`material holds ${material.length} samples, expected ${n}`);
  const splat: Uint8Array = terrain.splat ?? new Uint8Array(0);
  if (splat.length !== 0 && splat.length !== n * 4) {
    throw new RangeError(`splat holds ${splat.length} bytes, expected ${n * 4} (or 0)`);
  }
  const now = globalThis.performance ? () => globalThis.performance.now() : () => Date.now();
  const t0 = now();
  const N = buildVertexNormals(heights, cols, rows, spacing);
  const buildMs = now() - t0;

  const methods = bindMethods(
    heights,
    material,
    splat,
    N.x,
    N.y,
    N.z,
    originX,
    originZ,
    originX - spacing,
    originZ - spacing,
    1 / spacing,
    cols,
    cols - 1,
    rows - 1,
    cols - 2,
    rows - 2,
    cols + 3,
    cols + 1,
    rows + 1,
  );
  return { cols, rows, originX, originZ, spacing, heights, material, splat, normals: N, buildMs, ...methods };
}

/**
 * The hot methods, as closures over this function's PARAMETERS only
 * (parameters have no temporal dead zone, so the bytecode carries no hole
 * checks; see INLINING above for why every byte matters).
 */
function bindMethods(
  H: Float32Array,
  M: Uint8Array,
  S: Uint8Array,
  NX: Float32Array,
  NY: Float32Array,
  NZ: Float32Array,
  ox: number,
  oz: number,
  /** Normal-grid origin: one cell out (ring, see buildVertexNormals). */
  nox: number,
  noz: number,
  invS: number,
  cols: number,
  maxU: number,
  maxV: number,
  /** Last cell index (heights). */
  lastU: number,
  lastV: number,
  /** Normal-grid row stride (cols + 3) and last vertex index (cols + 1, rows + 1). */
  pc: number,
  nmaxU: number,
  nmaxV: number,
): TerrainSampler {
  /** Index of the nearest sample to (x, z), edge-clamped (clamp BEFORE `| 0`: it wraps past 2³¹). */
  const nearest = (x: number, z: number): number => {
    let u = (x - ox) * invS + 0.5;
    let v = (z - oz) * invS + 0.5;
    if (u < 0) u = 0;
    else if (u > maxU) u = maxU * 1;
    if (v < 0) v = 0;
    else if (v > maxV) v = maxV * 1;
    return (v | 0) * cols + (u | 0);
  };

  return {
    heightAt(x: number, z: number): number {
      let u = (x - ox) * invS;
      let v = (z - oz) * invS;
      if (u < 0) u = 0;
      else if (u > maxU) u = maxU * 1;
      if (v < 0) v = 0;
      else if (v > maxV) v = maxV * 1;
      let c = u | 0;
      let r = v | 0;
      if (c > lastU) c = lastU;
      if (r > lastV) r = lastV;
      const tx = u - c;
      const tz = v - r;
      const i = r * cols + c;
      const j = i + cols;
      const h00 = H[i]!;
      const h01 = H[j]!;
      const a = h00 + (H[i + 1]! - h00) * tx;
      const b = h01 + (H[j + 1]! - h01) * tx;
      return a + (b - a) * tz;
    },

    normalAt(x: number, z: number, out: Float64Array): void {
      // Normal-grid coordinates: vertex (c, r) of the terrain is (c+1, r+1)
      // here (one ring of flat-extension normals around the grid).
      let u = (x - nox) * invS;
      let v = (z - noz) * invS;
      if (u < 0) u = 0;
      else if (u > nmaxU) u = nmaxU * 1;
      if (v < 0) v = 0;
      else if (v > nmaxV) v = nmaxV * 1;
      const c = u | 0;
      const r = v | 0;
      const tx = u - c;
      const tz = v - r;
      const i = r * pc + c;
      const i1 = i + 1;
      const j = i + pc;
      const j1 = j + 1;
      const X = NX;
      const Y = NY;
      const Z = NZ;
      // lerp form: an all-(0,1,0) neighbourhood blends to exactly (0,1,0).
      // (Plain `a = a + …`, not `a += …`: fewer bytecodes.)
      let a = X[i]!;
      let b = X[j]!;
      a = a + (X[i1]! - a) * tx;
      b = b + (X[j1]! - b) * tx;
      const nx = a + (b - a) * tz;
      a = Y[i]!;
      b = Y[j]!;
      a = a + (Y[i1]! - a) * tx;
      b = b + (Y[j1]! - b) * tx;
      const ny = a + (b - a) * tz;
      a = Z[i]!;
      b = Z[j]!;
      a = a + (Z[i1]! - a) * tx;
      b = b + (Z[j1]! - b) * tx;
      const nz = a + (b - a) * tz;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      out[0] = nx * inv;
      out[1] = ny * inv;
      out[2] = nz * inv;
    },

    materialAt(x: number, z: number): number {
      return M[nearest(x, z)]!;
    },

    splatAt(x: number, z: number, out: Float64Array): void {
      if (S.length === 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 1;
        return;
      }
      const k = nearest(x, z) * 4;
      const p = S[k]!;
      const d = S[k + 1]!;
      const rk = S[k + 2]!;
      const g = S[k + 3]!;
      out[0] = p / 255;
      out[1] = d / 255;
      out[2] = rk / 255;
      out[3] = g / 255;
      out[4] = (255 - p - d - rk - g) / 255;
    },

    contains(x: number, z: number): boolean {
      const u = (x - ox) * invS;
      const v = (z - oz) * invS;
      return u >= 0 && u <= maxU && v >= 0 && v <= maxV;
    },
  };
}

/** Planar vertex-normal grids, (cols + 3) × (rows + 3), row stride cols + 3. */
export interface VertexNormals {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Row stride (= cols + 3). */
  stride: number;
}

/**
 * Unit vertex normals: central differences in the interior, one-sided on
 * the border rows/cols, written as (h_left − h_right)·k so a level
 * neighbourhood yields +0 (never −0). Terrain vertex (col, row) is stored
 * at (row + 1)·stride + col + 1. Around it:
 *  - a RING (index 0 and cols+1 / rows+1) holding the flat-extension normal
 *    of the adjacent border vertex (outward component zeroed, renormalized;
 *    +Y at the corners), so outside the grid the normal blends C0 into the
 *    clamped surface's normal within one cell and is constant beyond;
 *  - one more PAD column/row (index cols+2 / rows+2), a copy that is only
 *    ever read with interpolation weight 0 (a clamped coordinate on the
 *    last ring line then needs no special case in normalAt).
 */
export function buildVertexNormals(heights: Float32Array, cols: number, rows: number, spacing: number): VertexNormals {
  const stride = cols + 3;
  const size = stride * (rows + 3);
  const nx = new Float32Array(size);
  const ny = new Float32Array(size);
  const nz = new Float32Array(size);
  const inv1 = 1 / spacing;
  const inv2 = 1 / (2 * spacing);
  for (let r = 0; r < rows; r++) {
    const rowOff = r * cols;
    const up = r > 0 ? rowOff - cols : rowOff;
    const dn = r < rows - 1 ? rowOff + cols : rowOff;
    const kz = r > 0 && r < rows - 1 ? inv2 : inv1;
    const base = (r + 1) * stride + 1;
    for (let c = 0; c < cols; c++) {
      const lf = c > 0 ? c - 1 : c;
      const rt = c < cols - 1 ? c + 1 : c;
      const kx = c > 0 && c < cols - 1 ? inv2 : inv1;
      const dx = (heights[rowOff + lf]! - heights[rowOff + rt]!) * kx;
      const dz = (heights[up + c]! - heights[dn + c]!) * kz;
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const o = base + c;
      nx[o] = dx * inv;
      ny[o] = inv;
      nz[o] = dz * inv;
    }
  }
  // Ring: flat extension of the border (x-ring zeroes nx, z-ring zeroes nz).
  const ringZ = (o: number, from: number): void => {
    const y = ny[from]!;
    const z = nz[from]!;
    const l = Math.sqrt(y * y + z * z);
    nx[o] = 0;
    ny[o] = y / l;
    nz[o] = z / l;
  };
  const ringX = (o: number, from: number): void => {
    const x = nx[from]!;
    const y = ny[from]!;
    const l = Math.sqrt(x * x + y * y);
    nx[o] = x / l;
    ny[o] = y / l;
    nz[o] = 0;
  };
  for (let r = 1; r <= rows; r++) {
    ringZ(r * stride, r * stride + 1);
    ringZ(r * stride + cols + 1, r * stride + cols);
  }
  for (let c = 1; c <= cols; c++) {
    ringX(c, stride + c);
    ringX((rows + 1) * stride + c, rows * stride + c);
  }
  for (const o of [0, cols + 1, (rows + 1) * stride, (rows + 1) * stride + cols + 1]) {
    nx[o] = 0;
    ny[o] = 1;
    nz[o] = 0;
  }
  // Pad: last column and last row duplicate their neighbours (weight 0).
  for (let r = 0; r < rows + 2; r++) {
    const o = r * stride + cols + 2;
    nx[o] = nx[o - 1]!;
    ny[o] = ny[o - 1]!;
    nz[o] = nz[o - 1]!;
  }
  const last = (rows + 2) * stride;
  nx.copyWithin(last, last - stride, last);
  ny.copyWithin(last, last - stride, last);
  nz.copyWithin(last, last - stride, last);
  return { x: nx, y: ny, z: nz, stride };
}
