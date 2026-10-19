/**
 * Plan-view projection onto a resolved road centreline (station polyline),
 * accelerated by a uniform segment hash. Pure (no three): used by the ribbon
 * mesher for junction trimming / marking masks, and by tests.
 *
 * The polyline is the station chain itself (2 m chords), so results agree
 * with world/roads sampleRoad's linear interpolation between stations.
 */
import { ROAD_STATION_SPACING, ROAD_STATION_STRIDE, RoadStation, type RoadProfile } from '../../world/types';

export interface CentrelineHit {
  /** Arc distance of the closest point (clamped to [0, length] on open roads). */
  s: number;
  /** Signed lateral offset from the closest segment (+ = right of travel). */
  d: number;
  /** Plan distance to the polyline (round ends on open roads). */
  dist: number;
  /** Metres past an open end along its tangent (0 when the foot is interior). */
  beyond: number;
  /** Segment index of the foot point. */
  seg: number;
}

export interface CentrelineIndex {
  readonly profile: RoadProfile;
  /** Arc position of station i. */
  stationS(i: number): number;
  /**
   * Closest point within `maxDist` (plan). Returns false (out untouched) when
   * no segment is that close. Allocation-free.
   */
  nearest(x: number, z: number, maxDist: number, out: CentrelineHit): boolean;
}

const CELL = 16;

export function stationS(profile: RoadProfile, i: number): number {
  if (!profile.closed && i >= profile.stationCount - 1) return profile.length;
  return i * ROAD_STATION_SPACING;
}

export function createCentrelineIndex(profile: RoadProfile): CentrelineIndex {
  const st = profile.stations;
  const n = profile.stationCount;
  const segCount = profile.closed ? n : n - 1;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = st[i * ROAD_STATION_STRIDE + RoadStation.x]!;
    const z = st[i * ROAD_STATION_STRIDE + RoadStation.z]!;
    xs[i] = x;
    zs[i] = z;
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  }
  const ox = minX - CELL;
  const oz = minZ - CELL;
  const gw = Math.max(1, Math.ceil((maxX - ox + CELL) / CELL));
  const gh = Math.max(1, Math.ceil((maxZ - oz + CELL) / CELL));
  // CSR buckets of segment ids per cell (segment AABB rasterized).
  const counts = new Uint32Array(gw * gh + 1);
  const segCells = (i: number, fn: (c: number) => void): void => {
    const j = (i + 1) % n;
    const c0 = Math.floor((Math.min(xs[i]!, xs[j]!) - ox) / CELL);
    const c1 = Math.floor((Math.max(xs[i]!, xs[j]!) - ox) / CELL);
    const r0 = Math.floor((Math.min(zs[i]!, zs[j]!) - oz) / CELL);
    const r1 = Math.floor((Math.max(zs[i]!, zs[j]!) - oz) / CELL);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * gw + c);
  };
  for (let i = 0; i < segCount; i++) segCells(i, (c) => (counts[c + 1] = counts[c + 1]! + 1));
  for (let c = 0; c < gw * gh; c++) counts[c + 1] = counts[c + 1]! + counts[c]!;
  const fill = counts.slice(0, gw * gh);
  const items = new Uint32Array(counts[gw * gh]!);
  for (let i = 0; i < segCount; i++) segCells(i, (c) => {
      items[fill[c]!] = i;
      fill[c] = fill[c]! + 1;
    });
  const stamp = new Uint32Array(segCount);
  let epoch = 0;

  const sAt = (i: number): number => stationS(profile, i);
  const segLen = (i: number): number => (i === n - 1 ? profile.length - sAt(i) : sAt(i + 1) - sAt(i));

  return {
    profile,
    stationS: sAt,
    nearest(x, z, maxDist, out) {
      epoch = (epoch + 1) >>> 0;
      if (epoch === 0) {
        stamp.fill(0);
        epoch = 1;
      }
      const c0 = Math.max(0, Math.floor((x - maxDist - ox) / CELL));
      const c1 = Math.min(gw - 1, Math.floor((x + maxDist - ox) / CELL));
      const r0 = Math.max(0, Math.floor((z - maxDist - oz) / CELL));
      const r1 = Math.min(gh - 1, Math.floor((z + maxDist - oz) / CELL));
      let best = maxDist * maxDist;
      let found = false;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const cell = r * gw + c;
          for (let k = counts[cell]!; k < counts[cell + 1]!; k++) {
            const i = items[k]!;
            if (stamp[i] === epoch) continue;
            stamp[i] = epoch;
            const j = (i + 1) % n;
            const ax = xs[i]!;
            const az = zs[i]!;
            const dx = xs[j]! - ax;
            const dz = zs[j]! - az;
            const l2 = dx * dx + dz * dz;
            const tRaw = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
            const fx = ax + dx * t - x;
            const fz = az + dz * t - z;
            const d2 = fx * fx + fz * fz;
            if (d2 <= best) {
              best = d2;
              found = true;
              const len = Math.sqrt(l2) || 1;
              out.seg = i;
              out.s = sAt(i) + t * segLen(i);
              // Lateral from the segment's right vector (−dz, dx)/len.
              out.d = ((x - ax) * -dz + (z - az) * dx) / len;
              out.dist = Math.sqrt(d2);
              out.beyond = 0;
              if (!profile.closed) {
                if (i === 0 && tRaw < 0) out.beyond = -tRaw * len;
                else if (i === segCount - 1 && tRaw > 1) out.beyond = (tRaw - 1) * len;
              }
            }
          }
        }
      }
      return found;
    },
  };
}
