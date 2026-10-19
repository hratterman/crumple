/**
 * Route network (P6, T1) on Crumple Valley: deterministic, every path
 * connected both ways, lanes continuous through connectors, lane offsets /
 * speed limits / right-of-way per the contract, routePose frames.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from './layout';
import { createRoadProjection, projectToRoad } from './roads';
import {
  buildRouteNetwork,
  createRoutePose,
  createRouteSample,
  hashRouteNetwork,
  projectToRoute,
  routePose,
  sampleRoute,
  TURN_SPEED_LIMIT,
  UTURN_SPEED_LIMIT,
} from './routes';
import { generateTerrain } from './terrain';
import { ROUTE_SPEED_LIMITS, ROUTE_STATION_STRIDE, type RouteNetwork, type TerrainData } from './types';

let terrain: TerrainData;
let net: RouteNetwork;

beforeAll(() => {
  terrain = generateTerrain(DEFAULT_LAYOUT);
  net = buildRouteNetwork(DEFAULT_LAYOUT, terrain);
}, 60_000);

const S = ROUTE_STATION_STRIDE;
const last = (st: Float64Array, n: number, k: number): number => st[(n - 1) * S + k]!;

describe('buildRouteNetwork (Crumple Valley)', () => {
  it('is deterministic: same paths and hash on a rebuild; hash matches hashRouteNetwork', () => {
    const again = buildRouteNetwork(DEFAULT_LAYOUT, terrain);
    expect(again.hash).toBe(net.hash);
    expect(again.paths.length).toBe(net.paths.length);
    expect(hashRouteNetwork(net.paths)).toBe(net.hash);
    console.log(`[routes] ${net.paths.length} paths (${net.laneCount} lanes, ${(net.laneLength / 1000).toFixed(1)} km), ${net.junctions.length} junctions, hash 0x${net.hash.toString(16)}`);
  }, 60_000);

  it('lanes first, then connectors; indices match; only routed road kinds', () => {
    net.paths.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.kind).toBe(i < net.laneCount ? 'lane' : 'connector');
    });
    const kinds = new Set(net.paths.filter((p) => p.kind === 'lane').map((p) => DEFAULT_LAYOUT.roads.find((r) => r.id === p.road)!.kind));
    expect([...kinds].sort()).toEqual(['country', 'highway', 'mountain', 'street']);
    expect(net.paths.some((p) => p.road === 'dirtTrail' || p.road === 'arenaRunway')).toBe(false);
  }, 60_000);

  it('connectivity: every path has a successor and a predecessor; every lane reaches every lane (with highway lane changes)', () => {
    for (const p of net.paths) {
      expect(p.next.length, `path ${p.index} next`).toBeGreaterThan(0);
      expect(p.prev.length, `path ${p.index} prev`).toBeGreaterThan(0);
      for (const n of p.next) expect(net.paths[n]!.prev).toContain(p.index);
    }
    const reach = (from: number, dirNext: boolean): Set<number> => {
      const seen = new Set([from]);
      const stack = [from];
      while (stack.length) {
        const p = net.paths[stack.pop()!]!;
        const nb = [...(dirNext ? p.next : p.prev), p.left, p.right].filter((q) => q >= 0);
        for (const q of nb) if (!seen.has(q)) (seen.add(q), stack.push(q));
      }
      return seen;
    };
    const fwd = reach(0, true);
    const bwd = reach(0, false);
    for (let i = 0; i < net.laneCount; i++) {
      expect(fwd.has(i), `lane ${i} reachable`).toBe(true);
      expect(bwd.has(i), `lane ${i} reaches lane 0`).toBe(true);
    }
  }, 60_000);

  it('lane continuity at junctions: connector ends coincide with their lanes (position + heading)', () => {
    for (const c of net.paths) {
      if (c.kind !== 'connector') continue;
      const a = net.paths[c.prev[0]!]!;
      const b = net.paths[c.next[0]!]!;
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(c.stations[k]! - last(a.stations, a.stationCount, k))).toBeLessThan(1e-6);
        expect(Math.abs(last(c.stations, c.stationCount, k) - b.stations[k]!)).toBeLessThan(1e-6);
      }
      if (c.turn === 'uturn') continue;
      // Heading continuity (plan tangents within ~10°).
      const dotIn = c.stations[3]! * last(a.stations, a.stationCount, 3) + c.stations[5]! * last(a.stations, a.stationCount, 5);
      const dotOut = last(c.stations, c.stationCount, 3) * b.stations[3]! + last(c.stations, c.stationCount, 5) * b.stations[5]!;
      expect(dotIn).toBeGreaterThan(0.98);
      expect(dotOut).toBeGreaterThan(0.98);
    }
  }, 60_000);

  it('stations every 2 m, unit tangents, finite; lanes sit at dir·(k + 0.5)·laneW from the road centre', () => {
    const proj = createRoadProjection();
    for (const p of net.paths) {
      for (let i = 0; i < p.stationCount; i++) {
        const t = Math.hypot(p.stations[i * S + 3]!, p.stations[i * S + 4]!, p.stations[i * S + 5]!);
        expect(Math.abs(t - 1)).toBeLessThan(1e-9);
        for (let k = 0; k < S; k++) expect(Number.isFinite(p.stations[i * S + k]!)).toBe(true);
        if (i > 0 && i < p.stationCount - 1 && p.turn !== 'uturn') {
          const d = Math.hypot(p.stations[i * S]! - p.stations[(i - 1) * S]!, p.stations[i * S + 1]! - p.stations[(i - 1) * S + 1]!, p.stations[i * S + 2]! - p.stations[(i - 1) * S + 2]!);
          // 2 m of arc: the chord is shorter on bends (tight turn connectors ≈ 1.88).
          expect(d).toBeLessThanOrEqual(2 + 1e-9);
          expect(d).toBeGreaterThan(p.kind === 'lane' ? 1.97 : 1.85);
        }
      }
      if (p.kind !== 'lane') continue;
      const ri = DEFAULT_LAYOUT.roads.findIndex((r) => r.id === p.road);
      const road = terrain.roads[ri]!;
      const laneW = road.width / (2 * road.lanes);
      expect(p.offset).toBeCloseTo(p.dir * (p.lane + 0.5) * laneW, 9);
      const mid = Math.floor(p.stationCount / 2) * S;
      projectToRoad(road, p.stations[mid]!, p.stations[mid + 2]!, proj);
      expect(Math.abs(proj.d - p.offset)).toBeLessThan(0.05);
      expect(Math.abs(proj.y - p.stations[mid + 1]!)).toBeLessThan(0.05);
      // Neighbour lanes: same road and direction, one lane index apart (left = toward the centre line).
      if (p.left >= 0) expect([net.paths[p.left]!.road, net.paths[p.left]!.dir, net.paths[p.left]!.lane]).toEqual([p.road, p.dir, p.lane - 1]);
      if (p.right >= 0) expect([net.paths[p.right]!.road, net.paths[p.right]!.dir, net.paths[p.right]!.lane]).toEqual([p.road, p.dir, p.lane + 1]);
    }
  }, 60_000);

  it('speed limits per road kind; turns ≤ 40 km/h, U-turns ≤ 15 km/h; U-turns only at dead ends', () => {
    for (const p of net.paths) {
      if (p.kind === 'lane') {
        const kind = DEFAULT_LAYOUT.roads.find((r) => r.id === p.road)!.kind;
        expect(p.speedLimit).toBe(ROUTE_SPEED_LIMITS[kind]);
      } else {
        const lim = Math.min(net.paths[p.prev[0]!]!.speedLimit, net.paths[p.next[0]!]!.speedLimit);
        expect(p.speedLimit).toBeLessThanOrEqual(lim + 1e-12);
        if (p.turn === 'left' || p.turn === 'right') expect(p.speedLimit).toBeLessThanOrEqual(TURN_SPEED_LIMIT + 1e-12);
        if (p.turn === 'uturn') {
          expect(p.speedLimit).toBeLessThanOrEqual(UTURN_SPEED_LIMIT + 1e-12);
          expect(p.junction).toBeNull();
        }
      }
    }
    // Ridge Pass ends at the summit, Arena Gate at the arena: two dead ends, one 1-lane U-turn each.
    expect(net.paths.filter((p) => p.turn === 'uturn').length).toBe(2);
  }, 60_000);

  it('right of way: through straights/rights never yield, through lefts and every branch connector do; conflicts are symmetric', () => {
    for (const j of net.junctions) {
      for (const ci of j.connectors) {
        const c = net.paths[ci]!;
        expect(c.junction).toBe(j.id);
        const fromRoad = net.paths[c.prev[0]!]!.road;
        if (fromRoad === j.through) expect(c.yield).toBe(c.turn === 'left');
        else expect(c.yield).toBe(true);
        for (const o of c.conflicts) expect(net.paths[o]!.conflicts).toContain(ci);
      }
    }
    // Highway T-junction with Lakeshore: the branch's left turn crosses both highway directions.
    const hwy = net.junctions.find((j) => j.id === 'hwyWest')!;
    expect(hwy.through).toBe('highway');
    const branchLeft = hwy.connectors.map((i) => net.paths[i]!).find((c) => net.paths[c.prev[0]!]!.road === 'lakeshore' && c.turn === 'left')!;
    const crossed = new Set(branchLeft.conflicts.map((i) => net.paths[i]!).filter((c) => c.turn === 'straight').map((c) => net.paths[c.prev[0]!]!.dir));
    expect([...crossed].sort()).toEqual([-1, 1]);
  }, 60_000);

  it('routePose: local −Z → forward (3D tangent), +Y → up (bank applied), position on the station polyline', () => {
    const pose = createRoutePose();
    const smp = createRouteSample();
    const rot = (q: readonly number[], v: readonly number[]): number[] => {
      const [x, y, z, w] = q as [number, number, number, number];
      const tx = 2 * (y * v[2]! - z * v[1]!);
      const ty = 2 * (z * v[0]! - x * v[2]!);
      const tz = 2 * (x * v[1]! - y * v[0]!);
      return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
    };
    for (const p of net.paths) {
      for (const s of [0, p.length * 0.37, p.length]) {
        routePose(p, s, pose);
        sampleRoute(p, s, smp);
        const f = rot(pose.quat, [0, 0, -1]);
        const u = rot(pose.quat, [0, 1, 0]);
        expect(Math.hypot(f[0]! - smp.tx, f[1]! - smp.ty, f[2]! - smp.tz)).toBeLessThan(1e-9);
        expect(Math.hypot(u[0]! - pose.up[0], u[1]! - pose.up[1], u[2]! - pose.up[2])).toBeLessThan(1e-9);
        expect(u[1]!).toBeGreaterThan(0.9);
        expect([pose.pos[0], pose.pos[1], pose.pos[2]]).toEqual([smp.x, smp.y, smp.z]);
        expect(pose.speedLimit).toBe(p.speedLimit);
        // Bank: the right vector rises by the path bank (+ = right side higher).
        const r = rot(pose.quat, [1, 0, 0]);
        expect(Math.abs(r[1]! - smp.bank / Math.sqrt(1 + smp.bank * smp.bank))).toBeLessThan(0.02);
      }
    }
  }, 60_000);

  it('projectToRoute inverts the station polyline (s, lateral offset)', () => {
    const out = { s: 0, d: 0, dist: 0 };
    const smp = createRouteSample();
    const p = net.paths[0]!;
    for (const s of [3, p.length / 2, p.length - 5]) {
      sampleRoute(p, s, smp);
      const hl = Math.hypot(smp.tx, smp.tz);
      const rx = -smp.tz / hl;
      const rz = smp.tx / hl;
      projectToRoute(p, smp.x + 1.2 * rx, smp.z + 1.2 * rz, out);
      expect(out.s).toBeCloseTo(s, 1);
      expect(out.d).toBeCloseTo(1.2, 2);
      projectToRoute(p, smp.x - 0.7 * rx, smp.z - 0.7 * rz, out, s);
      expect(out.d).toBeCloseTo(-0.7, 2);
    }
  }, 60_000);
});
