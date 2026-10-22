import { describe, expect, it } from 'vitest';

import { MaterialId } from '../../protocol/messages';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { resolveRoadProfiles } from '../../world/roads';
import { createTerrainSampler } from '../../world/sampler';
import { syntheticTerrain } from '../../world/sampler.testkit';
import {
  ROAD_STATION_SPACING,
  ROAD_STATION_STRIDE,
  RoadStation,
  type RoadKind,
  type RoadMarkings,
  type RoadProfile,
} from '../../world/types';
import { RIBBON_LATERAL_STEP_M, RIBBON_LIFT_M } from '../types';
import {
  buildRoadRibbons,
  filletExtra,
  FRINGE_TUCK_M,
  lateralColumns,
  RIBBON_LODS,
  V_PERIOD_M,
} from './geometry';
import { detectJunctions, evalJunctionField } from './junctions';
import { computePassing } from './markings';
import { makeRoadNoise } from './noise';
import { createCentrelineIndex, type CentrelineHit } from './spatial';

/** Profile through plan points (x, z) resampled every ROAD_STATION_SPACING; y from h(x, z). */
function makeProfile(
  id: string,
  pts: readonly [number, number][],
  opts: { kind?: RoadKind; closed?: boolean; width?: number; markings?: RoadMarkings; h?: (x: number, z: number) => number } = {},
): RoadProfile {
  const closed = opts.closed ?? false;
  const h = opts.h ?? (() => 0);
  const poly = closed ? [...pts, pts[0]!] : [...pts];
  const cum = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]));
  }
  const length = cum[cum.length - 1]!;
  const n = closed ? Math.floor(length / ROAD_STATION_SPACING) : Math.ceil(length / ROAD_STATION_SPACING) + 1;
  const st = new Float64Array(n * ROAD_STATION_STRIDE);
  const at = (s: number): [number, number, number, number] => {
    let k = 1;
    while (k < cum.length - 1 && cum[k]! < s) k++;
    const a = poly[k - 1]!;
    const b = poly[k]!;
    const seg = cum[k]! - cum[k - 1]!;
    const t = seg > 0 ? (s - cum[k - 1]!) / seg : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
  };
  for (let i = 0; i < n; i++) {
    const s = !closed && i === n - 1 ? length : i * ROAD_STATION_SPACING;
    const [x, z, tx, tz] = at(Math.min(s, length - 1e-9));
    const o = i * ROAD_STATION_STRIDE;
    st[o + RoadStation.x] = x;
    st[o + RoadStation.y] = h(x, z);
    st[o + RoadStation.z] = z;
    st[o + RoadStation.tx] = tx;
    st[o + RoadStation.tz] = tz;
  }
  // Curvature from tangent turn per arc.
  for (let i = 0; i < n; i++) {
    const p = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const q = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const ds = Math.max(1e-9, (closed ? 2 : q - p) * ROAD_STATION_SPACING);
    const o = i * ROAD_STATION_STRIDE;
    const dtx = st[q * ROAD_STATION_STRIDE + RoadStation.tx]! - st[p * ROAD_STATION_STRIDE + RoadStation.tx]!;
    const dtz = st[q * ROAD_STATION_STRIDE + RoadStation.tz]! - st[p * ROAD_STATION_STRIDE + RoadStation.tz]!;
    st[o + RoadStation.curvature] = (dtx * -st[o + RoadStation.tz]! + dtz * st[o + RoadStation.tx]!) / ds;
  }
  const kind = opts.kind ?? 'country';
  return {
    id,
    kind,
    closed,
    width: opts.width ?? 8,
    lanes: 1,
    shoulder: 1.5,
    material: MaterialId.asphalt,
    markings: opts.markings ?? 'center',
    surface: kind === 'dirt' ? 'splat' : 'ribbon',
    length,
    stationCount: n,
    stations: st,
  };
}

const hill = (x: number, z: number): number => 10 + 0.04 * x + 2 * Math.sin(z / 30);
const terrain = syntheticTerrain({ cols: 257, rows: 257, spacing: 1, height: hill });
const sampler = createTerrainSampler(terrain);

describe('road ribbons: conforming geometry', () => {
  // Straight → R60 left-hand arc → straight, densely sampled (smooth tangents).
  const pts: [number, number][] = [];
  for (let x = -260; x < -20; x += 1) pts.push([x, -60]); // ≥ 2 pieces of PIECE_STATIONS
  for (let a = 0; a <= 90; a += 1) {
    const t = (a * Math.PI) / 180;
    pts.push([-20 + 60 * Math.sin(t), -60 - 60 * (1 - Math.cos(t))]);
  }
  for (let z = -121; z > -126; z -= 1) pts.push([40, z]);
  const road = makeProfile('a', pts);
  const rb = buildRoadRibbons([road], sampler);

  it('chunks the road into contiguous pieces with 3 LODs each', () => {
    expect(rb.pieces.length).toBeGreaterThan(1);
    for (let i = 1; i < rb.pieces.length; i++) {
      expect(rb.pieces[i]!.s0).toBeCloseTo(rb.pieces[i - 1]!.s1, 6);
    }
    for (const p of rb.pieces) {
      expect(p.lods.length).toBe(RIBBON_LODS.length);
      const tris = p.lods.map((l) => l.index.length);
      expect(tris[0]!).toBeGreaterThan(tris[1]!);
      expect(tris[1]!).toBeGreaterThan(tris[2]!);
    }
    // Open road: round caps extend past both ends.
    expect(rb.pieces[0]!.s0).toBeLessThan(0);
    expect(rb.pieces[rb.pieces.length - 1]!.s1).toBeGreaterThan(road.length);
  });

  it('every vertex sits on the collision surface (+ lift, outer fringe row tucked under)', () => {
    let maxErr = 0;
    let tucked = 0;
    for (const p of rb.pieces) {
      for (const g of p.lods) {
        for (let v = 0; v < g.vertexCount; v++) {
          const x = g.positions[v * 3]!;
          const y = g.positions[v * 3 + 1]!;
          const z = g.positions[v * 3 + 2]!;
          const h = sampler.heightAt(x, z);
          const lift = y - h;
          if (lift < 0) {
            tucked++;
            expect(lift).toBeCloseTo(-FRINGE_TUCK_M, 4);
          } else maxErr = Math.max(maxErr, Math.abs(lift - RIBBON_LIFT_M));
          const nx = g.normals[v * 3]!;
          const ny = g.normals[v * 3 + 1]!;
          const nz = g.normals[v * 3 + 2]!;
          expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
          expect(ny).toBeGreaterThan(0.5);
        }
      }
    }
    expect(maxErr).toBeLessThan(1e-4);
    expect(tucked).toBeGreaterThan(0);
  });

  it('u is the signed lateral offset and v the arc distance', () => {
    const idx = createCentrelineIndex(road);
    const hit: CentrelineHit = { s: 0, d: 0, dist: 0, beyond: 0, seg: 0 };
    const g = rb.pieces[1]!.lods[0]!;
    for (let v = 0; v < g.vertexCount; v += 7) {
      const u = g.roadUV[v * 2]!;
      const s = g.roadUV[v * 2 + 1]!;
      if (Math.abs(u) > 6 || g.misc[v * 4]! > 0) continue; // skip far fringe + end-cap rows
      expect(idx.nearest(g.positions[v * 3]!, g.positions[v * 3 + 2]!, 20, hit)).toBe(true);
      expect(hit.d).toBeCloseTo(u, 1);
      expect(Math.abs(hit.s - s)).toBeLessThan(Math.abs(u) * 0.2 + 0.05);
    }
  });

  it('triangles face up and split into core + fringe groups', () => {
    for (const p of rb.pieces) {
      const g = p.lods[0]!;
      expect(g.coreCount).toBeGreaterThan(0);
      expect(g.index.length).toBeGreaterThan(g.coreCount);
      for (let t = 0; t < g.index.length; t += 3) {
        const a = g.index[t]!;
        const b = g.index[t + 1]!;
        const c = g.index[t + 2]!;
        const ux = g.positions[b * 3]! - g.positions[a * 3]!;
        const uz = g.positions[b * 3 + 2]! - g.positions[a * 3 + 2]!;
        const vx = g.positions[c * 3]! - g.positions[a * 3]!;
        const vz = g.positions[c * 3 + 2]! - g.positions[a * 3 + 2]!;
        // y of (b−a)×(c−a) > 0 ⇔ CCW seen from above.
        expect(uz * vx - ux * vz).toBeGreaterThan(0);
      }
    }
  });

  it('carriageway columns: include ±halfWidth and 0, ≤ RIBBON_LATERAL_STEP_M apart', () => {
    const cols = lateralColumns(4, 5.15, 1.5, RIBBON_LODS[0]!, 5.15);
    expect(cols).toContain(-4);
    expect(cols).toContain(4);
    expect(Array.from(cols).some((c) => Math.abs(c) < 1e-9)).toBe(true);
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]!).toBeGreaterThan(cols[i - 1]!);
      if (Math.abs(cols[i]!) <= 4 && Math.abs(cols[i - 1]!) <= 4) {
        expect(cols[i]! - cols[i - 1]!).toBeLessThanOrEqual(RIBBON_LATERAL_STEP_M + 1e-9);
      }
    }
    expect(cols[0]).toBeCloseTo(-6.65, 9);
    expect(cols[cols.length - 1]).toBeCloseTo(6.65, 9);
  });

  it('closed loops scale v to a whole number of texture/dash periods', () => {
    const pts: [number, number][] = [];
    for (let k = 0; k < 24; k++) pts.push([60 * Math.cos((k / 24) * Math.PI * 2), 60 * Math.sin((k / 24) * Math.PI * 2)]);
    const loop = makeProfile('loop', pts, { closed: true, kind: 'highway', markings: 'highway', width: 12 });
    const r = buildRoadRibbons([loop], sampler);
    const total = loop.length * r.roads[0]!.vScale;
    expect(Math.abs(total / V_PERIOD_M - Math.round(total / V_PERIOD_M))).toBeLessThan(1e-9);
    const last = r.pieces[r.pieces.length - 1]!.lods[0]!;
    expect(Math.max(...Array.from(last.roadUV.filter((_, i) => i % 2 === 1)))).toBeCloseTo(total, 4);
  });

  it('dirt trails get an overlay, splat roads of other kinds do not exist', () => {
    const trail = makeProfile('t', [
      [0, 0],
      [0, 80],
    ], { kind: 'dirt', markings: 'none', width: 5 });
    const r = buildRoadRibbons([trail], sampler);
    expect(r.roads.length).toBe(1);
    expect(r.roads[0]!.style).toBe('dirt');
  });
});

describe('road ribbons: junctions', () => {
  // Through road along x; branch from the north ending on its centreline.
  const through = makeProfile('through', [
    [-100, 0],
    [100, 0],
  ], { kind: 'highway', markings: 'highway', width: 14 });
  const branch = makeProfile('branch', [
    [0, -90],
    [0, 0],
  ], { kind: 'country', width: 7.5 });
  const roads = [through, branch];

  it('detects the T junction and who yields', () => {
    const set = detectJunctions(roads);
    expect(set.junctions.length).toBe(1);
    const j = set.junctions[0]!;
    expect(Math.hypot(j.x, j.z)).toBeLessThan(2.5);
    const roles = Object.fromEntries(j.members.map((m) => [roads[m.road]!.id, m.role]));
    expect(roles).toEqual({ through: 'through', branch: 'branch' });
    expect(set.partners[1]![0]!.beatsMe).toBe(true);
    expect(set.partners[0]![0]!.beatsMe).toBe(false);
  });

  it('cut distance is negative inside the winner and positive outside', () => {
    const set = detectJunctions(roads);
    const out = new Float64Array(5);
    const hit: CentrelineHit = { s: 0, d: 0, dist: 0, beyond: 0, seg: 0 };
    evalJunctionField(set, roads, 1, 0, -3, branch.length - 3, out, hit);
    expect(out[0]).toBeCloseTo(-4, 5); // 3 m from the centreline, 7 m half width
    expect(out[3]).toBe(1); // junction ahead
    expect(out[4]).toBe(1);
    evalJunctionField(set, roads, 1, 0, -12, branch.length - 12, out, hit);
    expect(out[0]).toBeCloseTo(5, 5);
    // The through road never yields: its cut stays far, its marks break at the mouth.
    evalJunctionField(set, roads, 0, 1, -6, 101, out, hit);
    expect(out[0]).toBe(64);
    expect(out[1]).toBeLessThan(0);
    expect(out[3]).toBe(0);
  });

  it('the yielding ribbon drops triangles buried in the winner and widens for curb returns', () => {
    const rb = buildRoadRibbons(roads, sampler);
    const bi = rb.roads.findIndex((r) => r.profile.id === 'branch');
    const last = rb.pieces.filter((p) => p.road === bi).pop()!.lods[0]!;
    let maxU = 0;
    for (let v = 0; v < last.vertexCount; v++) maxU = Math.max(maxU, Math.abs(last.roadUV[v * 2]!));
    expect(maxU).toBeGreaterThan(rb.roads[bi]!.coreHalf + rb.roads[bi]!.fillet);
    for (let t = 0; t < last.index.length; t += 3) {
      const cuts = [0, 1, 2].map((k) => last.junc[last.index[t + k]! * 4]!);
      expect(Math.max(...cuts)).toBeGreaterThanOrEqual(-0.75);
    }
  });

  it('curb-return fillet profile', () => {
    expect(filletExtra(6, 0)).toBeCloseTo(6, 9);
    expect(filletExtra(6, 6)).toBe(0);
    expect(filletExtra(6, 9)).toBe(0);
    let prev = Infinity;
    for (let e = 0; e <= 6; e += 0.5) {
      const f = filletExtra(6, e);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('road markings + noise', () => {
  it('mountain passing zones are asymmetric look-ahead; bends are solid', () => {
    const pts: [number, number][] = [[0, 0], [0, 400]];
    for (let k = 1; k <= 12; k++) pts.push([30 - 30 * Math.cos((k / 12) * Math.PI), 400 + 30 * Math.sin((k / 12) * Math.PI)]);
    pts.push([60, 0]);
    const p = makeProfile('m', pts, { kind: 'mountain' });
    const f = computePassing(p, 'mountain', ROAD_STATION_SPACING);
    const at = (s: number): [number, number] => {
      const i = Math.round(s / ROAD_STATION_SPACING);
      return [f.passR[i]!, f.passL[i]!];
    };
    expect(at(100)).toEqual([1, 1]); // straight: clear both ways
    expect(at(330)).toEqual([0, 1]); // bend ahead for forward traffic, clear behind
    expect(at(410)).toEqual([0, 0]); // in the hairpin
    const country = computePassing(p, 'country', ROAD_STATION_SPACING);
    expect(country.passR[Math.round(100 / ROAD_STATION_SPACING)]).toBe(1);
    expect(country.passR[Math.round(430 / ROAD_STATION_SPACING)]).toBe(0);
    const hw = computePassing(p, 'highway', ROAD_STATION_SPACING);
    expect(Math.max(...Array.from(hw.passR))).toBe(0);
  });

  it('noise atlas is deterministic and tiles seamlessly', () => {
    const a = makeRoadNoise(64, 7);
    const b = makeRoadNoise(64, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
    // Wrap continuity of the fbm channels: edge-to-edge step ≈ interior steps.
    let edge = 0;
    let inner = 0;
    for (let y = 0; y < 64; y++) {
      for (const ch of [0, 1]) {
        edge += Math.abs(a[(y * 64 + 63) * 4 + ch]! - a[(y * 64) * 4 + ch]!);
        inner += Math.abs(a[(y * 64 + 31) * 4 + ch]! - a[(y * 64 + 32) * 4 + ch]!);
      }
    }
    expect(edge).toBeLessThan(inner * 2.5 + 64);
  });
});

describe('road ribbons: default map', () => {
  it('recovers every layout junction (members + who yields) from the resolved profiles', () => {
    const profiles = resolveRoadProfiles(DEFAULT_LAYOUT, () => 10);
    const rb = buildRoadRibbons(profiles, createTerrainSampler(syntheticTerrain({ cols: 9, rows: 9, spacing: 200, height: () => 10 })));
    const ids = rb.roads.map((r) => r.profile.id);
    expect(rb.junctions.junctions.length).toBe(DEFAULT_LAYOUT.junctions.length);
    for (const lj of DEFAULT_LAYOUT.junctions) {
      const j = rb.junctions.junctions.find((q) => Math.hypot(q.x - lj.pos[0], q.z - lj.pos[1]) < 3);
      expect(j, lj.id).toBeDefined();
      expect(j!.members.map((m) => ids[m.road]).sort()).toEqual([...lj.roads].sort());
    }
    // Through roads never yield to their branches.
    const hwy = ids.indexOf('highway');
    expect(rb.junctions.partners[hwy]!.every((p) => !p.beatsMe)).toBe(true);
    const ring = ids.indexOf('townRing');
    expect(rb.junctions.partners[ring]!.every((p) => !p.beatsMe)).toBe(true);
    const main = ids.indexOf('mainStreet');
    expect(rb.junctions.partners[main]!.filter((p) => p.beatsMe).length).toBe(4);
  }, 60_000); // layout v6: ribbons for every road of the 2560 m map (≈ 5 s on a loaded box)
});
