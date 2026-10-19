/**
 * Dev-only stand-in for generateTerrain WITH roads (used by the road preview
 * only while src/world/terrain.ts is absent): B's synthetic heightfield, A's
 * resolveRoadProfiles, then the contract's carve + paint (world/types
 * "PROFILE RESOLUTION + CARVING" step 5–6), done by brute-force segment
 * rasterization. Never shipped.
 */
import { MaterialId } from '../src/protocol/messages';
import { resolveRoadProfiles } from '../src/world/roads';
import {
  ROAD_KIND_DEFAULTS,
  ROAD_STATION_STRIDE,
  RoadStation,
  type RoadProfile,
  type TerrainData,
  type WorldLayout,
} from '../src/world/types';
import { syntheticTerrain } from './synthetic';

const sstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function syntheticTerrainWithRoads(layout: WorldLayout): TerrainData {
  const t = syntheticTerrain(layout);
  const { cols, rows, spacing, originX, originZ, heights } = t;
  const hAt = (x: number, z: number): number => {
    const u = Math.min(Math.max((x - originX) / spacing, 0), cols - 1.001);
    const v = Math.min(Math.max((z - originZ) / spacing, 0), rows - 1.001);
    const c = Math.floor(u);
    const r = Math.floor(v);
    const tx = u - c;
    const tz = v - r;
    const i = r * cols + c;
    const a = heights[i]! + (heights[i + 1]! - heights[i]!) * tx;
    const b = heights[i + cols]! + (heights[i + cols + 1]! - heights[i + cols]!) * tx;
    return a + (b - a) * tz;
  };
  const roads = resolveRoadProfiles(layout, hAt);
  const order = roads
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ROAD_KIND_DEFAULTS[a.r.kind].priority - ROAD_KIND_DEFAULTS[b.r.kind].priority || a.i - b.i);
  const n = cols * rows;
  const best = new Float64Array(n);
  const bS = new Float64Array(n); // surface height (verge level) at the foot
  const bD = new Float64Array(n); // |d| or round-end distance
  for (const { r } of order) carve(r);

  function carve(p: RoadProfile): void {
    const kd = ROAD_KIND_DEFAULTS[p.kind];
    const a = p.width / 2;
    const b = a + p.shoulder;
    const R = b + kd.blend;
    best.fill(Infinity);
    const st = p.stations;
    const segs = p.closed ? p.stationCount : p.stationCount - 1;
    const touched: number[] = [];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % p.stationCount;
      const o0 = i * ROAD_STATION_STRIDE;
      const o1 = j * ROAD_STATION_STRIDE;
      const x0 = st[o0 + RoadStation.x]!;
      const z0 = st[o0 + RoadStation.z]!;
      const x1 = st[o1 + RoadStation.x]!;
      const z1 = st[o1 + RoadStation.z]!;
      const dx = x1 - x0;
      const dz = z1 - z0;
      const l2 = dx * dx + dz * dz || 1e-9;
      const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - R - originX) / spacing));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(x0, x1) + R - originX) / spacing));
      const r0 = Math.max(0, Math.floor((Math.min(z0, z1) - R - originZ) / spacing));
      const r1 = Math.min(rows - 1, Math.ceil((Math.max(z0, z1) + R - originZ) / spacing));
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          const x = originX + cc * spacing;
          const z = originZ + rr * spacing;
          let tt = ((x - x0) * dx + (z - z0) * dz) / l2;
          const roundEnd = !p.closed && ((i === 0 && tt < 0) || (i === segs - 1 && tt > 1));
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const fx = x0 + dx * tt;
          const fz = z0 + dz * tt;
          const ex = x - fx;
          const ez = z - fz;
          const dist2 = ex * ex + ez * ez;
          const k = rr * cols + cc;
          if (dist2 >= best[k]! || dist2 > R * R) continue;
          if (best[k] === Infinity) touched.push(k);
          best[k] = dist2;
          const len = Math.sqrt(l2);
          let d = (ex * -dz + ez * dx) / len;
          const y = st[o0 + RoadStation.y]! + (st[o1 + RoadStation.y]! - st[o0 + RoadStation.y]!) * tt;
          const bank = st[o0 + RoadStation.bank]! + (st[o1 + RoadStation.bank]! - st[o0 + RoadStation.bank]!) * tt;
          const dc = d < -a ? -a : d > a ? a : d;
          bS[k] = y + bank * dc;
          if (roundEnd) d = Math.sqrt(dist2);
          bD[k] = Math.abs(d);
        }
      }
    }
    const isRibbon = p.surface === 'ribbon';
    for (const k of touched) {
      const ad = bD[k]!;
      const h0 = heights[k]!;
      if (ad <= b) heights[k] = bS[k]!;
      else heights[k] = bS[k]! + (h0 - bS[k]!) * sstep((ad - b) / kd.blend);
      const sp = t.splat;
      if (ad <= a) {
        sp[k * 4] = isRibbon ? 255 : 0;
        sp[k * 4 + 1] = isRibbon ? 0 : 255;
        sp[k * 4 + 2] = 0;
        sp[k * 4 + 3] = 0;
        t.material[k] = p.material;
      } else if (ad <= b) {
        sp[k * 4] = 0;
        sp[k * 4 + 1] = 0;
        sp[k * 4 + 2] = 0;
        sp[k * 4 + 3] = 255;
        t.material[k] = MaterialId.gravel;
      }
    }
  }
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < n; i++) {
    minHeight = Math.min(minHeight, heights[i]!);
    maxHeight = Math.max(maxHeight, heights[i]!);
  }
  return { ...t, roads, minHeight, maxHeight, layoutVersion: layout.version };
}
