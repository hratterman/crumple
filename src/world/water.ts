/**
 * Water bodies (P5): one per lake zone, resolved against the generated
 * terrain (contract: WaterBody / ResolveWater in ./types). Pure and
 * deterministic: the worker uses it for buoyancy, main for the water mesh
 * and splash FX, on identical terrain.
 */
import { WATER_AABB_MARGIN_M, WATER_OPTICS_DEFAULTS, type ResolveWater, type TerrainData, type WaterBody } from './types';

export const resolveWater: ResolveWater = (layout, terrain) => {
  const bodies: WaterBody[] = [];
  const { cols, rows, spacing, originX, originZ, heights } = terrain;
  // Shared across lakes (layout v6 has several): a lake marks its samples with its own stamp.
  let seen: Uint32Array | null = null;
  let stack: Int32Array | null = null;
  let stampId = 0;
  for (const zone of layout.zones) {
    if (zone.kind !== 'lake') continue;
    // Layout v6: a basin's own surface height (ponds, fords), default the valley water plane.
    const level = zone.params.level ?? layout.waterLevel;
    const shape = zone.shape;
    if (shape.type !== 'circle' && shape.type !== 'ellipse') continue;
    const c0 = Math.min(cols - 1, Math.max(0, Math.round((shape.center[0] - originX) / spacing)));
    const r0 = Math.min(rows - 1, Math.max(0, Math.round((shape.center[1] - originZ) / spacing)));
    if (!(heights[r0 * cols + c0]! < level)) continue;
    // 4-connected flood fill over samples below the water level (explicit stack, fixed order).
    seen ??= new Uint32Array(cols * rows);
    stack ??= new Int32Array(cols * rows);
    const sv = ++stampId;
    let top = 0;
    stack[top++] = r0 * cols + c0;
    seen[r0 * cols + c0] = sv;
    let minC = c0;
    let maxC = c0;
    let minR = r0;
    let maxR = r0;
    let minH = Infinity;
    let samples = 0;
    while (top > 0) {
      const k = stack[--top]!;
      const r = (k / cols) | 0;
      const c = k - r * cols;
      samples++;
      const h = heights[k]!;
      if (h < minH) minH = h;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c > 0 && seen[k - 1] !== sv && heights[k - 1]! < level) (seen[k - 1] = sv), (stack[top++] = k - 1);
      if (c < cols - 1 && seen[k + 1] !== sv && heights[k + 1]! < level) (seen[k + 1] = sv), (stack[top++] = k + 1);
      if (r > 0 && seen[k - cols] !== sv && heights[k - cols]! < level) (seen[k - cols] = sv), (stack[top++] = k - cols);
      if (r < rows - 1 && seen[k + cols] !== sv && heights[k + cols]! < level) (seen[k + cols] = sv), (stack[top++] = k + cols);
    }
    bodies.push({
      id: zone.id,
      name: zone.name,
      level,
      minX: originX + minC * spacing - WATER_AABB_MARGIN_M,
      maxX: originX + maxC * spacing + WATER_AABB_MARGIN_M,
      minZ: originZ + minR * spacing - WATER_AABB_MARGIN_M,
      maxZ: originZ + maxR * spacing + WATER_AABB_MARGIN_M,
      maxDepth: level - minH,
      samples,
      optics: { ...WATER_OPTICS_DEFAULTS, ...(zone.params.water ?? {}) },
    });
  }
  return bodies;
};

/** Index of the water body containing (x, z) whose surface is above y, or −1. Allocation-free. */
export function waterAt(bodies: readonly WaterBody[], x: number, y: number, z: number): number {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    if (y < b.level && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return i;
  }
  return -1;
}

/**
 * Render-side field of one body over its rectangle, on the terrain grid
 * (one texel per terrain sample): water depth `level − h`, the flood mask
 * (the same 4-connected region resolveWater measured, seeded at the deepest
 * sample) and a signed chamfer distance to the shoreline, m (+ inside the
 * flooded region, − on dry/disconnected samples). Pure; used by the water
 * mesh (cell selection), the depth texture and the shoreline foam.
 */
export interface WaterField {
  originX: number;
  originZ: number;
  spacing: number;
  cols: number;
  rows: number;
  /** level − terrain height, m (row-major, rows × cols). */
  depth: Float32Array;
  /** 1 = flooded sample connected to the lake. */
  mask: Uint8Array;
  /** Signed distance to the shoreline, m (+ in water). */
  shoreDist: Float32Array;
}

export function waterField(terrain: TerrainData, body: WaterBody): WaterField {
  const { spacing, originX: tx, originZ: tz, cols: tc, rows: tr, heights } = terrain;
  const c0 = Math.max(0, Math.floor((body.minX - tx) / spacing));
  const c1 = Math.min(tc - 1, Math.ceil((body.maxX - tx) / spacing));
  const r0 = Math.max(0, Math.floor((body.minZ - tz) / spacing));
  const r1 = Math.min(tr - 1, Math.ceil((body.maxZ - tz) / spacing));
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const n = cols * rows;
  const depth = new Float32Array(n);
  let seed = -1;
  let best = Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[(r + r0) * tc + c + c0]!;
      const k = r * cols + c;
      depth[k] = body.level - h;
      if (h < body.level && h < best) (best = h), (seed = k);
    }
  }
  const mask = new Uint8Array(n);
  if (seed >= 0) {
    const stack = new Int32Array(n);
    let top = 0;
    stack[top++] = seed;
    mask[seed] = 1;
    while (top > 0) {
      const k = stack[--top]!;
      const r = (k / cols) | 0;
      const c = k - r * cols;
      if (c > 0 && !mask[k - 1] && depth[k - 1]! > 0) (mask[k - 1] = 1), (stack[top++] = k - 1);
      if (c < cols - 1 && !mask[k + 1] && depth[k + 1]! > 0) (mask[k + 1] = 1), (stack[top++] = k + 1);
      if (r > 0 && !mask[k - cols] && depth[k - cols]! > 0) (mask[k - cols] = 1), (stack[top++] = k - cols);
      if (r < rows - 1 && !mask[k + cols] && depth[k + cols]! > 0) (mask[k + cols] = 1), (stack[top++] = k + cols);
    }
  }
  const inside = chamfer(mask, cols, rows, 1);
  const outside = chamfer(mask, cols, rows, 0);
  const shoreDist = new Float32Array(n);
  for (let k = 0; k < n; k++) shoreDist[k] = (mask[k] ? inside[k]! - 0.5 : 0.5 - outside[k]!) * spacing;
  return { originX: tx + c0 * spacing, originZ: tz + r0 * spacing, spacing, cols, rows, depth, mask, shoreDist };
}

/** 8-neighbour two-pass chamfer distance (cells) from every sample with mask == v to the nearest sample with mask != v. */
function chamfer(mask: Uint8Array, cols: number, rows: number, v: number): Float32Array {
  const BIG = 1e6;
  const D = 1.4142135623730951;
  const d = new Float32Array(cols * rows);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] === v ? BIG : 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      let m = d[k]!;
      if (m === 0) continue;
      if (c > 0) m = Math.min(m, d[k - 1]! + 1);
      if (r > 0) {
        m = Math.min(m, d[k - cols]! + 1);
        if (c > 0) m = Math.min(m, d[k - cols - 1]! + D);
        if (c < cols - 1) m = Math.min(m, d[k - cols + 1]! + D);
      }
      d[k] = m;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const k = r * cols + c;
      let m = d[k]!;
      if (m === 0) continue;
      if (c < cols - 1) m = Math.min(m, d[k + 1]! + 1);
      if (r < rows - 1) {
        m = Math.min(m, d[k + cols]! + 1);
        if (c < cols - 1) m = Math.min(m, d[k + cols + 1]! + D);
        if (c > 0) m = Math.min(m, d[k + cols - 1]! + D);
      }
      d[k] = m;
    }
  }
  // Rect edges count as "unknown": cap so a region touching the border never reads as infinitely far.
  for (let k = 0; k < d.length; k++) if (d[k]! >= BIG) d[k] = cols + rows;
  return d;
}
