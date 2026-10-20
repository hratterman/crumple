/**
 * Static occluders for camera line of sight (CameraWorld.occluded): the
 * layout colliders' world AABBs (walls, barriers, ramps, poles), tested with
 * an exact segment / slab test. Conservative for yawed boxes (their AABB),
 * cheap enough for a test per shot per frame.
 */
export type Aabb6 = readonly [number, number, number, number, number, number];

let t0 = 0;
let t1 = 1;
/** One slab of the segment test; false when the segment misses it (allocation-free). */
function slab(o: number, d: number, lo: number, hi: number): boolean {
  if (hi < lo) return false;
  if (d > -1e-9 && d < 1e-9) return o >= lo && o <= hi;
  let ta = (lo - o) / d;
  let tb = (hi - o) / d;
  if (ta > tb) {
    const t = ta;
    ta = tb;
    tb = t;
  }
  if (ta > t0) t0 = ta;
  if (tb < t1) t1 = tb;
  return t0 <= t1;
}

/** Segment a→b against a [minX, minY, minZ, maxX, maxY, maxZ] box shrunk by `pad` m (grazing hits don't count). */
export function segmentHitsAabb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, box: Aabb6, pad = 0.05): boolean {
  t0 = 0;
  t1 = 1;
  return (
    slab(ax, bx - ax, box[0] + pad, box[3] - pad) &&
    slab(ay, by - ay, box[1] + pad, box[4] - pad) &&
    slab(az, bz - az, box[2] + pad, box[5] - pad)
  );
}

export function createAabbOccluder(boxes: readonly Aabb6[]): (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean {
  return (ax, ay, az, bx, by, bz) => {
    for (const b of boxes) if (segmentHitsAabb(ax, ay, az, bx, by, bz, b)) return true;
    return false;
  };
}
