/**
 * Water bodies (P5): one per lake zone, resolved against the generated
 * terrain (contract: WaterBody / ResolveWater in ./types). Pure and
 * deterministic: the worker uses it for buoyancy, main for the water mesh
 * and splash FX, on identical terrain.
 */
import { WATER_AABB_MARGIN_M, WATER_OPTICS_DEFAULTS, type ResolveWater, type WaterBody } from './types';

export const resolveWater: ResolveWater = (layout, terrain) => {
  const bodies: WaterBody[] = [];
  const { cols, rows, spacing, originX, originZ, heights } = terrain;
  const level = layout.waterLevel;
  for (const zone of layout.zones) {
    if (zone.kind !== 'lake') continue;
    const shape = zone.shape;
    if (shape.type !== 'circle' && shape.type !== 'ellipse') continue;
    const c0 = Math.min(cols - 1, Math.max(0, Math.round((shape.center[0] - originX) / spacing)));
    const r0 = Math.min(rows - 1, Math.max(0, Math.round((shape.center[1] - originZ) / spacing)));
    if (!(heights[r0 * cols + c0]! < level)) continue;
    // 4-connected flood fill over samples below the water level (explicit stack, fixed order).
    const seen = new Uint8Array(cols * rows);
    const stack = new Int32Array(cols * rows);
    let top = 0;
    stack[top++] = r0 * cols + c0;
    seen[r0 * cols + c0] = 1;
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
      if (c > 0 && !seen[k - 1] && heights[k - 1]! < level) (seen[k - 1] = 1), (stack[top++] = k - 1);
      if (c < cols - 1 && !seen[k + 1] && heights[k + 1]! < level) (seen[k + 1] = 1), (stack[top++] = k + 1);
      if (r > 0 && !seen[k - cols] && heights[k - cols]! < level) (seen[k - cols] = 1), (stack[top++] = k - cols);
      if (r < rows - 1 && !seen[k + cols] && heights[k + cols]! < level) (seen[k + cols] = 1), (stack[top++] = k + cols);
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
