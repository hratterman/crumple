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

function inside(x: number, y: number, z: number, b: Aabb6): boolean {
  return x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
}

/**
 * Boxes that contain an end point are skipped: a prop's spawn box the crashed car now sits in (the
 * props moved) must not hide the car from every camera.
 */
export function createAabbOccluder(boxes: readonly Aabb6[]): (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean {
  return (ax, ay, az, bx, by, bz) => {
    for (const b of boxes) {
      if (inside(ax, ay, az, b) || inside(bx, by, bz, b)) continue;
      if (segmentHitsAabb(ax, ay, az, bx, by, bz, b)) return true;
    }
    return false;
  };
}

/**
 * Nearest point of the nearest box to (x, y, z) written to `out` [x, y, z]; returns its distance
 * (0 inside a box, Infinity when there are none). A camera's nearest occluder in its view cone is
 * foreground clutter.
 */
export function createAabbNearest(boxes: readonly Aabb6[]): (x: number, y: number, z: number, out: { x: number; y: number; z: number }) => number {
  return (x, y, z, out) => {
    let best = Infinity;
    for (const b of boxes) {
      const nx = x < b[0] ? b[0] : x > b[3] ? b[3] : x;
      const ny = y < b[1] ? b[1] : y > b[4] ? b[4] : y;
      const nz = z < b[2] ? b[2] : z > b[5] ? b[5] : z;
      const d = Math.hypot(nx - x, ny - y, nz - z);
      if (d < best) {
        best = d;
        out.x = nx;
        out.y = ny;
        out.z = nz;
      }
    }
    return best;
  };
}
