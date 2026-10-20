/**
 * AI traffic route network (P6, T1): `buildRouteNetwork(layout, terrain)`
 * turns the resolved roads into drivable LANE and CONNECTOR paths with
 * station polylines, successors, junction right-of-way and conflicts;
 * `routePose(path, s, out)` places a car on a path. Contract and rules:
 * src/world/types.ts "P6 route network" + docs/CONTRACTS.md "RouteNetwork".
 *
 * PURE and deterministic (generator numerics: only + − × ÷ sqrt floor abs
 * min max; fixed iteration order: roads in layout order, directions +1
 * then −1, lanes inner → outer, junctions in layout order). Not a hot loop
 * except routePose / sampleRoute (allocation-free).
 *
 * Construction:
 *  1. CUTS. Every junction listing a routed road projects onto it (s_j).
 *     The road is cut into the box [s_j − JUNCTION_BOX_M, s_j + JUNCTION_BOX_M]
 *     (two boxes closer than 2·box + MIN_LANE_M share the gap: each keeps
 *     half of it minus MIN_LANE_M / 2). An open road end that is not at a
 *     junction is a DEAD END: its lanes stop DEAD_END_M before the end and
 *     a U-turn loop joins them to the opposite direction.
 *  2. LANES per interval between boxes, direction +1 then −1, lane 0
 *     (inner) → n−1 (kerb): the road-frame offset d = dir·(k+0.5)·laneW,
 *     point = centre + d·right, y = y + bank·d (the carved surface), sampled
 *     every 1 m of road s and resampled every ROUTE_STATION_SPACING of lane
 *     arc length.
 *  3. CONNECTORS per junction: for each incoming lane (legs in junction
 *     road order, side "before" then "after") to every other leg: the same
 *     road's opposite leg = straight (same lane index), another road's leg
 *     = right (kerb → kerb) or left (inner → inner) by the plan cross
 *     product. Cubic Hermite lane end → lane start, tangent length
 *     0.5·chord. Then the dead-end U-turns.
 *  4. Right of way (types.ts RIGHT-OF-WAY) and conflicts (polylines within
 *     CONFLICT_M = 2.5 m away from a shared start lane, or a shared end lane).
 */
import { projectToRoad, sampleRoad, createRoadProjection, createRoadSample } from './roads';
import { buildSignalPlans } from './signals';
import {
  JUNCTION_BOX_M,
  ROAD_KIND_DEFAULTS,
  ROUTE_SPEED_LIMITS,
  ROUTE_STATION_SPACING,
  ROUTE_STATION_STRIDE,
  TRAFFIC_ROAD_KINDS,
  WorldLayoutError,
  type RoadProfile,
  type RouteJunction,
  type RouteNetwork,
  type RoutePath,
  type RoutePose,
  type RouteTurn,
  type TerrainData,
  type Vec2,
  type WorldLayout,
} from './types';

const SP = ROUTE_STATION_SPACING;
const STRIDE = ROUTE_STATION_STRIDE;
/** Lane ends clear the other roads' carriageway + shoulder by this much, m (junction box sizing). */
export const BOX_CLEARANCE_M = 3;
/** Junction box half-length cap, m. */
export const MAX_BOX_M = 30;
/** Shortest lane kept between two junction boxes, m. */
export const MIN_LANE_M = 2;
/** Dead-end lanes stop this far before the road end; the U-turn loop uses the rest (+ the verge / pad beyond). */
export const DEAD_END_M = 14;
/** Connectors closer than this (plan, m) conflict. */
export const CONFLICT_M = 2.5;
/** Turn / U-turn connector speed caps, m/s. */
export const TURN_SPEED_LIMIT = 40 / 3.6;
export const UTURN_SPEED_LIMIT = 15 / 3.6;
/** U-turn loop radius floor, m (types.ts: max(width/2 + shoulder, 6)). */
const UTURN_MIN_R = 6;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// ------------------------------------------------------------ polyline helpers
/** Dense polyline under construction: x, y, z, bank per point. */
interface Poly {
  x: number[];
  y: number[];
  z: number[];
  bank: number[];
}
const newPoly = (): Poly => ({ x: [], y: [], z: [], bank: [] });
function pushPt(p: Poly, x: number, y: number, z: number, bank: number): void {
  const n = p.x.length;
  // Drop exact duplicates (zero-length segments break the tangents).
  if (n > 0) {
    const dx = x - p.x[n - 1]!;
    const dy = y - p.y[n - 1]!;
    const dz = z - p.z[n - 1]!;
    if (dx * dx + dy * dy + dz * dz < 1e-10) return;
  }
  p.x.push(x);
  p.y.push(y);
  p.z.push(z);
  p.bank.push(bank);
}

/**
 * Resamples a dense polyline at ROUTE_STATION_SPACING of 3D arc length (the
 * last station at the full length) and fills tangents (unit 3D, central
 * differences) and signed plan curvature (+ = right). Returns the packed
 * stations and the length.
 */
function resample(p: Poly): { stations: Float64Array; length: number; count: number } {
  const n = p.x.length;
  if (n < 2) throw new WorldLayoutError('routes: degenerate path (fewer than 2 points)');
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = p.x[i]! - p.x[i - 1]!;
    const dy = p.y[i]! - p.y[i - 1]!;
    const dz = p.z[i]! - p.z[i - 1]!;
    cum[i] = cum[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const length = cum[n - 1]!;
  let count = Math.floor(length / SP) + 1;
  if (length - (count - 1) * SP > 1e-6) count++;
  if (count < 2) count = 2;
  const st = new Float64Array(count * STRIDE);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = k === count - 1 ? length : k * SP;
    while (seg < n - 2 && cum[seg + 1]! < s) seg++;
    const l = cum[seg + 1]! - cum[seg]!;
    let u = l > 0 ? (s - cum[seg]!) / l : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const v = 1 - u;
    const o = k * STRIDE;
    st[o] = p.x[seg]! * v + p.x[seg + 1]! * u;
    st[o + 1] = p.y[seg]! * v + p.y[seg + 1]! * u;
    st[o + 2] = p.z[seg]! * v + p.z[seg + 1]! * u;
    st[o + 6] = p.bank[seg]! * v + p.bank[seg + 1]! * u;
  }
  // Tangents: central differences of the stations (one-sided at the ends).
  for (let k = 0; k < count; k++) {
    const a = (k === 0 ? 0 : k - 1) * STRIDE;
    const b = (k === count - 1 ? count - 1 : k + 1) * STRIDE;
    let tx = st[b]! - st[a]!;
    let ty = st[b + 1]! - st[a + 1]!;
    let tz = st[b + 2]! - st[a + 2]!;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > 1e-12) {
      tx /= tl;
      ty /= tl;
      tz /= tl;
    }
    const o = k * STRIDE;
    st[o + 3] = tx;
    st[o + 4] = ty;
    st[o + 5] = tz;
  }
  // Plan curvature: (Δt_h · right_h) / Δs over the neighbours (+ = turning right).
  for (let k = 0; k < count; k++) {
    const ka = k === 0 ? 0 : k - 1;
    const kb = k === count - 1 ? count - 1 : k + 1;
    const o = k * STRIDE;
    if (kb === ka) {
      st[o + 7] = 0;
      continue;
    }
    const a = ka * STRIDE;
    const b = kb * STRIDE;
    const ha = hNorm(st[a + 3]!, st[a + 5]!);
    const hb = hNorm(st[b + 3]!, st[b + 5]!);
    const hk = hNorm(st[o + 3]!, st[o + 5]!);
    const sa = ka === count - 1 ? length : ka * SP;
    const sb = kb === count - 1 ? length : kb * SP;
    const ds = sb - sa;
    // right of the station tangent = (−tz, tx)
    st[o + 7] = ds > 1e-9 ? ((hb[0] - ha[0]) * -hk[1] + (hb[1] - ha[1]) * hk[0]) / ds : 0;
  }
  return { stations: st, length, count };
}

function hNorm(x: number, z: number): [number, number] {
  const l = Math.sqrt(x * x + z * z);
  return l > 1e-12 ? [x / l, z / l] : [0, -1];
}

// ------------------------------------------------------------ build state
interface Cut {
  junction: number;
  s: number;
  /** Box half-lengths before / after s_j (shrunk when two boxes are close). */
  before: number;
  after: number;
  atStart: boolean;
  atEnd: boolean;
}

/** Interval end in road s: a junction box edge (junction index) or a dead end / loop. */
interface Interval {
  a: number;
  b: number;
  /** Junction index at a / b, −1 = dead end (open road end) or −2 = loop (closed road with no junction). */
  ja: number;
  jb: number;
}

interface LaneRec {
  path: RoutePathBuild;
  road: number;
  interval: number;
  /** Junction index (−1 dead end, −2 loop) at the travel start / end. */
  jStart: number;
  jEnd: number;
}

type RoutePathBuild = {
  -readonly [K in keyof RoutePath]: RoutePath[K] extends readonly (infer T)[] ? T[] : RoutePath[K];
};

interface Leg {
  road: number;
  /** 'before' = the side s < s_j, 'after' = s > s_j. */
  side: -1 | 1;
  /** Outward unit plan direction from the junction along the road. */
  ox: number;
  oz: number;
  incoming: LaneRec[];
  outgoing: LaneRec[];
}

/** Builds the route network. Throws WorldLayoutError on a layout it cannot route. */
export function buildRouteNetwork(layout: WorldLayout, terrain: TerrainData): RouteNetwork {
  if (terrain.roads.length !== layout.roads.length) throw new WorldLayoutError('routes: terrain.roads does not match layout.roads');
  const roads = terrain.roads;
  const routed = roads.map((r) => TRAFFIC_ROAD_KINDS.includes(r.kind));
  const roadIndex = new Map(layout.roads.map((r, i) => [r.id, i]));
  const proj = createRoadProjection();
  const smp = createRoadSample();

  // ---- 1. cuts
  const cuts: Cut[][] = roads.map(() => []);
  layout.junctions.forEach((j, ji) => {
    // Plan tangent of every routed road at the junction (box sizing).
    const here: { ri: number; s: number; tx: number; tz: number }[] = [];
    for (const id of j.roads) {
      const ri = roadIndex.get(id);
      if (ri === undefined) throw new WorldLayoutError(`routes: junction ${j.id} lists unknown road ${id}`);
      if (!routed[ri]) continue;
      const road = roads[ri]!;
      projectToRoad(road, j.pos[0], j.pos[1], proj);
      sampleRoad(road, proj.s, smp);
      here.push({ ri, s: proj.s, tx: smp.tx, tz: smp.tz });
    }
    for (const h of here) {
      const road = roads[h.ri]!;
      // Box: at least JUNCTION_BOX_M, and long enough that this road's lane ends clear every
      // other road's carriageway by BOX_CLEARANCE_M (shallow-angle junctions: L = (W/2 + c)/sin θ).
      let box = JUNCTION_BOX_M;
      for (const o of here) {
        if (o === h) continue;
        const sin = Math.abs(h.tx * o.tz - h.tz * o.tx);
        const other = roads[o.ri]!;
        const need = (other.width / 2 + other.shoulder + BOX_CLEARANCE_M) / Math.max(sin, 0.05);
        box = Math.max(box, Math.min(need, MAX_BOX_M));
      }
      cuts[h.ri]!.push({
        junction: ji,
        s: h.s,
        before: box,
        after: box,
        atStart: !road.closed && h.s < box,
        atEnd: !road.closed && h.s > road.length - box,
      });
    }
  });
  for (let ri = 0; ri < roads.length; ri++) {
    const cs = cuts[ri]!;
    cs.sort((p, q) => p.s - q.s || p.junction - q.junction);
    const road = roads[ri]!;
    const m = cs.length;
    const pairs = road.closed ? m : m - 1;
    for (let k = 0; k < pairs && m > 0; k++) {
      const c0 = cs[k]!;
      const c1 = cs[(k + 1) % m]!;
      let gap = c1.s - c0.s;
      if (road.closed && k === m - 1) gap += road.length;
      if (m === 1 && road.closed) gap = road.length;
      const need = c0.after + c1.before + MIN_LANE_M;
      if (gap < need) {
        const half = Math.max((gap - MIN_LANE_M) / 2, 1);
        c0.after = Math.min(c0.after, half);
        c1.before = Math.min(c1.before, half);
      }
    }
  }

  // ---- intervals per road
  const intervals: Interval[][] = roads.map((road, ri) => {
    if (!routed[ri]) return [];
    const cs = cuts[ri]!;
    const out: Interval[] = [];
    if (road.closed) {
      if (cs.length === 0) return [{ a: 0, b: road.length, ja: -2, jb: -2 }];
      for (let k = 0; k < cs.length; k++) {
        const c0 = cs[k]!;
        const c1 = cs[(k + 1) % cs.length]!;
        let b = c1.s - c1.before;
        const a = c0.s + c0.after;
        if (k === cs.length - 1) b += road.length;
        out.push({ a, b, ja: c0.junction, jb: c1.junction });
      }
      return out;
    }
    let a = 0;
    let ja = -1;
    for (const c of cs) {
      if (c.atStart) {
        a = c.s + c.after;
        ja = c.junction;
        continue;
      }
      out.push({ a, b: c.s - c.before, ja, jb: c.junction });
      if (c.atEnd) {
        a = -1;
        break;
      }
      a = c.s + c.after;
      ja = c.junction;
    }
    if (a >= 0) out.push({ a, b: road.length, ja, jb: -1 });
    // Dead-end lanes stop DEAD_END_M short of the end (the U-turn loop).
    for (const iv of out) {
      if (iv.ja === -1) iv.a = Math.min(DEAD_END_M, iv.b - MIN_LANE_M);
      if (iv.jb === -1) iv.b = Math.max(road.length - DEAD_END_M, iv.a + MIN_LANE_M);
    }
    return out.filter((iv) => iv.b - iv.a >= MIN_LANE_M * 0.5);
  });

  // ---- 2. lanes
  const paths: RoutePathBuild[] = [];
  const lanes: LaneRec[] = [];
  /** lanes[road][interval][dir 0 = +1, 1 = −1][k] */
  const laneGrid: LaneRec[][][][] = roads.map(() => []);
  for (let ri = 0; ri < roads.length; ri++) {
    if (!routed[ri]) continue;
    const road = roads[ri]!;
    const oneWay = layout.roads[ri]!.oneWay === true;
    const laneW = oneWay ? road.width / road.lanes : road.width / (2 * road.lanes);
    intervals[ri]!.forEach((iv, ii) => {
      const grid: LaneRec[][] = [[], []];
      for (const dir of oneWay ? ([1] as const) : ([1, -1] as const)) {
        for (let k = 0; k < road.lanes; k++) {
          // Layout v6 one-way roads (ramps): lane k centred at (k + 0.5 − lanes/2)·width/lanes.
          const offset = oneWay ? (k + 0.5 - road.lanes / 2) * laneW : dir * (k + 0.5) * laneW;
          const poly = newPoly();
          const len = iv.b - iv.a;
          const steps = Math.max(1, Math.floor(len) + 1);
          for (let q = 0; q <= steps; q++) {
            const u = q / steps;
            const s = dir === 1 ? iv.a + len * u : iv.b - len * u;
            sampleRoad(road, s, smp);
            pushPt(poly, smp.x + offset * smp.rx, smp.y + smp.bank * offset, smp.z + offset * smp.rz, dir * smp.bank);
          }
          const rs = resample(poly);
          const wrapS = (s: number): number => (road.closed ? s - Math.floor(s / road.length) * road.length : s);
          const path: RoutePathBuild = {
            index: paths.length,
            kind: 'lane',
            road: road.id,
            dir,
            lane: k,
            offset,
            sFrom: wrapS(dir === 1 ? iv.a : iv.b),
            sTo: wrapS(dir === 1 ? iv.b : iv.a),
            length: rs.length,
            speedLimit: ROUTE_SPEED_LIMITS[road.kind],
            stationCount: rs.count,
            stations: rs.stations,
            next: [],
            prev: [],
            junction: null,
            turn: null,
            yield: false,
            conflicts: [],
            left: -1,
            right: -1,
          };
          paths.push(path);
          const rec: LaneRec = {
            path,
            road: ri,
            interval: ii,
            jStart: dir === 1 ? iv.ja : iv.jb,
            jEnd: dir === 1 ? iv.jb : iv.ja,
          };
          path.junction = rec.jEnd >= 0 ? layout.junctions[rec.jEnd]!.id : null;
          lanes.push(rec);
          grid[dir === 1 ? 0 : 1]!.push(rec);
        }
      }
      for (const g of grid) {
        for (let k = 0; k < g.length; k++) {
          // Right-hand traffic: lane k−1 (toward the centre line) is on the LEFT of travel.
          g[k]!.path.left = k > 0 ? g[k - 1]!.path.index : -1;
          g[k]!.path.right = k + 1 < g.length ? g[k + 1]!.path.index : -1;
        }
      }
      laneGrid[ri]![ii] = grid;
    });
  }
  const laneCount = paths.length;
  let laneLength = 0;
  for (const p of paths) laneLength += p.length;

  // Loop lanes (closed road, no junction): each lane follows itself.
  for (const l of lanes) if (l.jEnd === -2) l.path.next.push(l.path.index);

  // ---- 3. connectors per junction
  const plans = buildSignalPlans(layout, terrain);
  let planCount = 0;
  const signalPlanOf = layout.junctions.map((j) => (j.control === 'signal' ? planCount++ : -1));
  const connectorsOf: number[][] = layout.junctions.map(() => []);
  const throughOf: number[] = layout.junctions.map(() => -1);
  layout.junctions.forEach((j, ji) => {
    // Through road: highest-priority ROUTED road (ties: layout order).
    let through = -1;
    for (let ri = 0; ri < roads.length; ri++) {
      if (!routed[ri] || !j.roads.includes(roads[ri]!.id)) continue;
      if (through < 0 || ROAD_KIND_DEFAULTS[roads[ri]!.kind].priority > ROAD_KIND_DEFAULTS[roads[through]!.kind].priority) through = ri;
    }
    throughOf[ji] = through;
    const legs: Leg[] = [];
    for (const id of j.roads) {
      const ri = roadIndex.get(id)!;
      if (!routed[ri]) continue;
      const cut = cuts[ri]!.find((c) => c.junction === ji)!;
      const road = roads[ri]!;
      sampleRoad(road, cut.s, smp);
      for (const side of [-1, 1] as const) {
        if (side === -1 && cut.atStart) continue;
        if (side === 1 && cut.atEnd) continue;
        const leg: Leg = { road: ri, side, ox: smp.tx * side, oz: smp.tz * side, incoming: [], outgoing: [] };
        for (const l of lanes) {
          if (l.road !== ri) continue;
          const d = l.path.dir;
          // side −1: lanes ending here travel +1 (incoming), lanes starting here travel −1.
          if (l.jEnd === ji && d === -side && laneTouches(l, cut, side, road)) leg.incoming.push(l);
          if (l.jStart === ji && d === side && laneTouches(l, cut, side, road)) leg.outgoing.push(l);
        }
        leg.incoming.sort((p, q) => p.path.lane - q.path.lane);
        leg.outgoing.sort((p, q) => p.path.lane - q.path.lane);
        legs.push(leg);
      }
    }
    for (const A of legs) {
      for (const inc of A.incoming) {
        for (const B of legs) {
          if (B === A) continue;
          let turn: RouteTurn;
          let out: LaneRec | undefined;
          if (B.road === A.road) {
            turn = 'straight';
            out = B.outgoing.find((o) => o.path.lane === inc.path.lane);
          } else {
            // travel in = −A.outward; right of travel = (−tz, tx).
            const ix = -A.ox;
            const iz = -A.oz;
            const right = B.ox * -iz + B.oz * ix > 0;
            turn = right ? 'right' : 'left';
            const nIn = A.incoming.length;
            const nOut = B.outgoing.length;
            if (right) {
              if (inc.path.lane !== nIn - 1) continue;
              out = B.outgoing[nOut - 1];
            } else {
              if (inc.path.lane !== 0) continue;
              out = B.outgoing[0];
            }
          }
          if (!out) continue;
          // Layout v6: at a junction with a one-way road (ramp merges / diverges) no connector
          // turns back by more than 135° (a merge never feeds the opposite carriageway).
          if ((layout.roads[A.road]!.oneWay || layout.roads[B.road]!.oneWay) && -A.ox * B.ox + -A.oz * B.oz < -0.7071) continue;
          const c = makeConnector(paths, inc.path, out.path, turn, j.id);
          const branchStart = A.road !== through;
          c.yield = branchStart || turn === 'left';
          // Layout v6 traffic control (types.ts RoutePath.signal / .stop).
          const plan = signalPlanOf[ji]!;
          if (plan >= 0) {
            const leg = plans[plan]!.legs.findIndex((l) => l.road === roads[A.road]!.id && l.side === A.side);
            c.signal = leg >= 0 ? { plan, leg } : null;
          }
          if (j.control === 'allStop' || (j.control === 'stop' && branchStart)) c.stop = true;
          connectorsOf[ji]!.push(c.index);
        }
      }
    }
  });

  // ---- dead-end U-turns (roads in layout order, end of road then start)
  for (let ri = 0; ri < roads.length; ri++) {
    if (!routed[ri] || layout.roads[ri]!.oneWay) continue;
    const road = roads[ri]!;
    const ivs = intervals[ri]!;
    ivs.forEach((iv, ii) => {
      const grid = laneGrid[ri]![ii]!;
      for (const atEnd of [true, false]) {
        if ((atEnd ? iv.jb : iv.ja) !== -1) continue;
        // Arriving lanes: dir +1 at the end, dir −1 at the start; leave by the opposite direction's kerb lane.
        const inc = grid[atEnd ? 0 : 1]!;
        const outs = grid[atEnd ? 1 : 0]!;
        const out = outs[outs.length - 1]!;
        for (const l of inc) {
          const c = makeUTurn(paths, l.path, out.path, Math.max(road.width / 2 + road.shoulder, UTURN_MIN_R));
          c.speedLimit = Math.min(c.speedLimit, UTURN_SPEED_LIMIT);
        }
      }
    });
  }

  // ---- successors / predecessors (ascending)
  for (const p of paths) {
    if (p.kind !== 'connector') continue;
    const from = p.prev[0]!;
    const to = p.next[0]!;
    paths[from]!.next.push(p.index);
    paths[to]!.prev.push(p.index);
  }
  for (const l of lanes) if (l.jEnd === -2) l.path.prev.push(l.path.index);
  for (const p of paths) {
    p.next.sort((a, b) => a - b);
    p.prev.sort((a, b) => a - b);
  }

  // ---- 4. conflicts per junction (connector pairs)
  for (const list of connectorsOf) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = paths[list[x]!]!;
        const b = paths[list[y]!]!;
        const merge = a.next[0] === b.next[0];
        const sameStart = a.prev[0] === b.prev[0];
        if (merge || (!sameStart && polylinesWithin(a, b, CONFLICT_M))) {
          a.conflicts.push(b.index);
          b.conflicts.push(a.index);
        }
      }
    }
  }
  for (const p of paths) p.conflicts.sort((a, b) => a - b);

  const junctions: RouteJunction[] = layout.junctions.map((j, ji) => ({
    id: j.id,
    pos: [j.pos[0], j.pos[1]] as Vec2,
    control: j.control ?? 'none',
    through: throughOf[ji]! >= 0 ? roads[throughOf[ji]!]!.id : '',
    connectors: [...connectorsOf[ji]!].sort((a, b) => a - b),
  }));
  const net: RouteNetwork = {
    layoutId: layout.id,
    layoutVersion: layout.version,
    paths: paths as RoutePath[],
    junctions,
    laneCount,
    laneLength,
    hash: 0,
  };
  return { ...net, hash: hashRouteNetwork(net.paths) };
}

/** The lane's end at this cut lies on the given side of the junction (closed roads: both sides share a junction id). */
function laneTouches(l: LaneRec, cut: Cut, side: -1 | 1, road: RoadProfile): boolean {
  const p = l.path;
  // The lane end/start s that touches the junction box.
  const touchS = l.jEnd >= 0 && p.dir === -side ? p.sTo : p.sFrom;
  const edge = side === -1 ? cut.s - cut.before : cut.s + cut.after;
  let d = touchS - edge;
  if (road.closed) {
    d = d - Math.floor(d / road.length + 0.5) * road.length;
  }
  return d * d < 1;
}

/** Cubic Hermite connector from `from`'s last station to `to`'s first. Appended to `paths`. */
function makeConnector(paths: RoutePathBuild[], from: RoutePathBuild, to: RoutePathBuild, turn: RouteTurn, junction: string | null): RoutePathBuild {
  const a = (from.stationCount - 1) * STRIDE;
  const fs = from.stations;
  const ts = to.stations;
  const p0 = [fs[a]!, fs[a + 1]!, fs[a + 2]!];
  const t0 = [fs[a + 3]!, fs[a + 4]!, fs[a + 5]!];
  const p1 = [ts[0]!, ts[1]!, ts[2]!];
  const t1 = [ts[3]!, ts[4]!, ts[5]!];
  const dx = p1[0]! - p0[0]!;
  const dy = p1[1]! - p0[1]!;
  const dz = p1[2]! - p0[2]!;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const L = 0.5 * chord;
  const poly = newPoly();
  const N = Math.max(8, Math.floor(chord * 2));
  const b0 = fs[a + 6]!;
  const b1 = ts[6]!;
  for (let q = 0; q <= N; q++) {
    const u = q / N;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    pushPt(
      poly,
      h00 * p0[0]! + h10 * L * t0[0]! + h01 * p1[0]! + h11 * L * t1[0]!,
      h00 * p0[1]! + h10 * L * t0[1]! + h01 * p1[1]! + h11 * L * t1[1]!,
      h00 * p0[2]! + h10 * L * t0[2]! + h01 * p1[2]! + h11 * L * t1[2]!,
      b0 * (1 - u) + b1 * u,
    );
  }
  return pushConnector(paths, from, to, poly, turn, junction, true);
}

/**
 * Dead-end U-turn loop (right-hand traffic: turns LEFT): from the arriving
 * lane's end out to a semicircle of radius r centred between the two lanes
 * `r` beyond the lane ends, back into the opposite kerb lane. The arc is
 * stepped by a fixed rotation (cos/sin of π/16 by half-angle sqrt: generator
 * numerics).
 */
function makeUTurn(paths: RoutePathBuild[], from: RoutePathBuild, to: RoutePathBuild, r: number): RoutePathBuild {
  const a = (from.stationCount - 1) * STRIDE;
  const fs = from.stations;
  const ts = to.stations;
  const p0 = [fs[a]!, fs[a + 1]!, fs[a + 2]!];
  const [fx, fz] = hNorm(fs[a + 3]!, fs[a + 5]!);
  const p1 = [ts[0]!, ts[1]!, ts[2]!];
  // Left of travel = (tz, −tx).
  const lx = fz;
  const lz = -fx;
  const cx = (p0[0]! + p1[0]!) / 2 + fx * r;
  const cz = (p0[2]! + p1[2]!) / 2 + fz * r;
  const cy = (p0[1]! + p1[1]!) / 2;
  // cos/sin(π/16) from cos(π/2) = 0 by three half-angle steps.
  let c = 0;
  for (let k = 0; k < 3; k++) c = Math.sqrt((1 + c) / 2);
  const s = Math.sqrt(1 - c * c);
  const poly = newPoly();
  pushPt(poly, p0[0]!, p0[1]!, p0[2]!, 0);
  // Arc start: the circle point on the right side (−left·r from the centre), heading forward.
  let vx = -lx * r;
  let vz = -lz * r;
  const steps = 16;
  // Rotating LEFT about +Y (seen from above with forward f, left l): v → v·cos + (f-ish) — use the
  // rotation that maps −l·r toward +f·r then +l·r: v' = v·c + (l × … ) — explicit 2D: the angle runs
  // from −l through +f to +l, i.e. v' = c·v + s·w where w = v rotated +90° toward f.
  for (let k = 0; k <= steps; k++) {
    pushPt(poly, cx + vx, cy, cz + vz, 0);
    // w = component rotated toward f: for v = −l·r → w = f·r; for v = f·r → w = l·r.
    // In (f, l) coordinates v = (vf, vl), w = (−vl, vf).
    const vf = vx * fx + vz * fz;
    const vl = vx * lx + vz * lz;
    const nf = c * vf - s * vl;
    const nl = c * vl + s * vf;
    vx = nf * fx + nl * lx;
    vz = nf * fz + nl * lz;
  }
  pushPt(poly, p1[0]!, p1[1]!, p1[2]!, 0);
  // Smooth the joins: rebuild as Hermite pieces is unnecessary at walking pace; the
  // resampler's central-difference tangents round the corners at 2 m.
  const conn = pushConnector(paths, from, to, poly, 'uturn', null);
  return conn;
}

function pushConnector(
  paths: RoutePathBuild[],
  from: RoutePathBuild,
  to: RoutePathBuild,
  poly: Poly,
  turn: RouteTurn,
  junction: string | null,
  endTangents = false,
): RoutePathBuild {
  const rs = resample(poly);
  if (endTangents) {
    // The Hermite's end tangents ARE the lane tangents: copy them (heading continuity).
    const a = (from.stationCount - 1) * STRIDE;
    const z = (rs.count - 1) * STRIDE;
    for (let k = 3; k < 6; k++) {
      rs.stations[k] = from.stations[a + k]!;
      rs.stations[z + k] = to.stations[k]!;
    }
  }
  let limit = Math.min(from.speedLimit, to.speedLimit);
  if (turn === 'left' || turn === 'right') limit = Math.min(limit, TURN_SPEED_LIMIT);
  if (turn === 'uturn') limit = Math.min(limit, UTURN_SPEED_LIMIT);
  const c: RoutePathBuild = {
    index: paths.length,
    kind: 'connector',
    road: null,
    dir: 0,
    lane: -1,
    offset: 0,
    sFrom: 0,
    sTo: rs.length,
    length: rs.length,
    speedLimit: limit,
    stationCount: rs.count,
    stations: rs.stations,
    next: [to.index],
    prev: [from.index],
    junction,
    turn,
    yield: false,
    conflicts: [],
    left: -1,
    right: -1,
    signal: null,
    stop: false,
  };
  paths.push(c);
  return c;
}

/** Plan distance between two polylines (stations vs the other's segments) below `d`. */
function polylinesWithin(a: RoutePath, b: RoutePath, d: number): boolean {
  const d2 = d * d;
  return pointsNearSegments(a, b, d2) || pointsNearSegments(b, a, d2);
}
function pointsNearSegments(a: RoutePath, b: RoutePath, d2: number): boolean {
  const sa = a.stations;
  const sb = b.stations;
  for (let i = 0; i < a.stationCount; i++) {
    const x = sa[i * STRIDE]!;
    const z = sa[i * STRIDE + 2]!;
    for (let k = 0; k + 1 < b.stationCount; k++) {
      const ax = sb[k * STRIDE]!;
      const az = sb[k * STRIDE + 2]!;
      const ex = sb[(k + 1) * STRIDE]! - ax;
      const ez = sb[(k + 1) * STRIDE + 2]! - az;
      const l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = x - ax - t * ex;
      const qz = z - az - t * ez;
      if (qx * qx + qz * qz < d2) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ hash
function mix(h: number, w: number): number {
  return Math.imul(h ^ (w >>> 0), FNV_PRIME) >>> 0;
}
/**
 * FNV-1a 32 word-wise (hashTerrain's rule) over the path count, then per
 * path kind (0 lane, 1 connector), dir, lane, next count + indices, and
 * the stations as raw u32 words (f64 → 2 words, platform order).
 */
export function hashRouteNetwork(paths: readonly RoutePath[]): number {
  let h = FNV_OFFSET;
  h = mix(h, paths.length);
  for (const p of paths) {
    h = mix(h, p.kind === 'lane' ? 0 : 1);
    h = mix(h, p.dir);
    h = mix(h, p.lane);
    h = mix(h, p.next.length);
    for (const n of p.next) h = mix(h, n);
    const w = new Uint32Array(p.stations.buffer, p.stations.byteOffset, p.stations.length * 2);
    for (let i = 0; i < w.length; i++) h = mix(h, w[i]!);
  }
  return h >>> 0;
}

// ------------------------------------------------------------ sampling / pose
/** Reusable output of sampleRoute. */
export interface RouteSample {
  x: number;
  y: number;
  z: number;
  /** Unit 3D tangent. */
  tx: number;
  ty: number;
  tz: number;
  bank: number;
  curvature: number;
}
export function createRouteSample(): RouteSample {
  return { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: -1, bank: 0, curvature: 0 };
}

/** Station-polyline sample at arc s (clamped to [0, length]); tangent renormalized. Allocation-free. */
export function sampleRoute(path: RoutePath, s: number, out: RouteSample): RouteSample {
  const n = path.stationCount;
  const st = path.stations;
  const len = path.length;
  if (!(s > 0)) s = 0;
  if (s > len) s = len;
  let i = Math.floor(s / SP);
  if (i > n - 2) i = n - 2;
  const segEnd = i + 1 === n - 1 ? len : (i + 1) * SP;
  const sl = segEnd - i * SP;
  let u = sl > 0 ? (s - i * SP) / sl : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const v = 1 - u;
  const a = i * STRIDE;
  const b = a + STRIDE;
  out.x = st[a]! * v + st[b]! * u;
  out.y = st[a + 1]! * v + st[b + 1]! * u;
  out.z = st[a + 2]! * v + st[b + 2]! * u;
  let tx = st[a + 3]! * v + st[b + 3]! * u;
  let ty = st[a + 4]! * v + st[b + 4]! * u;
  let tz = st[a + 5]! * v + st[b + 5]! * u;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl > 1e-12) {
    tx /= tl;
    ty /= tl;
    tz /= tl;
  } else {
    tx = st[a + 3]!;
    ty = st[a + 4]!;
    tz = st[a + 5]!;
  }
  out.tx = tx;
  out.ty = ty;
  out.tz = tz;
  out.bank = st[a + 6]! * v + st[b + 6]! * u;
  out.curvature = st[a + 7]! * v + st[b + 7]! * u;
  return out;
}

export function createRoutePose(): RoutePose {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], forward: [0, 0, -1], up: [0, 1, 0], curvature: 0, speedLimit: 0 };
}

const poseSample = createRouteSample();

/**
 * Vehicle-frame placement at arc s (types.ts POSE): position = station
 * point, forward = unit 3D tangent, right = horizontal right raised by the
 * bank, up = right × forward, Gram-Schmidt (forward exact), quat by
 * Shepperd (sqrt only). Local −Z → forward, +Y → up. Allocation-free.
 */
export function routePose(path: RoutePath, s: number, out: RoutePose): RoutePose {
  const q = sampleRoute(path, s, poseSample);
  poseFromFrame(q.x, q.y, q.z, q.tx, q.ty, q.tz, q.bank, out);
  out.curvature = q.curvature;
  out.speedLimit = path.speedLimit;
  return out;
}

/** Pose from a point, a unit forward and a bank (shared by routePose and the traffic sim). */
export function poseFromFrame(x: number, y: number, z: number, fx: number, fy: number, fz: number, bank: number, out: RoutePose): RoutePose {
  // right = horizontal right (−fz, 0, fx) + bank·Y, normalized
  let rx = -fz;
  let ry = bank;
  let rz = fx;
  let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rl < 1e-12) {
    rx = 1;
    ry = 0;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up = right × forward
  let ux = ry * fz - rz * fy;
  let uy = rz * fx - rx * fz;
  let uz = rx * fy - ry * fx;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // Gram-Schmidt: forward exact; up ⟂ forward; right = forward × up
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  const ul2 = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul2;
  uy /= ul2;
  uz /= ul2;
  rx = fy * uz - fz * uy;
  ry = fz * ux - fx * uz;
  rz = fx * uy - fy * ux;
  out.pos[0] = x;
  out.pos[1] = y;
  out.pos[2] = z;
  out.forward[0] = fx;
  out.forward[1] = fy;
  out.forward[2] = fz;
  out.up[0] = ux;
  out.up[1] = uy;
  out.up[2] = uz;
  // Rotation matrix columns: X → right, Y → up, Z → −forward.
  quatFromBasis(rx, ry, rz, ux, uy, uz, -fx, -fy, -fz, out.quat);
  return out;
}

/** Shepperd's method from the column basis (m00 m10 m20 = X column, …). sqrt only. */
export function quatFromBasis(
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
  q: [number, number, number, number],
): void {
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[3] = 0.25 * s;
    q[0] = (m21 - m12) / s;
    q[1] = (m02 - m20) / s;
    q[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q[3] = (m21 - m12) / s;
    q[0] = 0.25 * s;
    q[1] = (m01 + m10) / s;
    q[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q[3] = (m02 - m20) / s;
    q[0] = (m01 + m10) / s;
    q[1] = 0.25 * s;
    q[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q[3] = (m10 - m01) / s;
    q[0] = (m02 + m20) / s;
    q[1] = (m12 + m21) / s;
    q[2] = 0.25 * s;
  }
  // Canonical sign (w ≥ 0) so equal frames give bit-equal quats.
  if (q[3] < 0) {
    q[0] = -q[0];
    q[1] = -q[1];
    q[2] = -q[2];
    q[3] = -q[3];
  }
}

/**
 * Projects a plan point onto a path: nearest station segment (plan), within
 * ±window stations of `hintS` when given. Returns s and the signed lateral
 * offset (+ = right of travel) in `out`. Allocation-free.
 */
export function projectToRoute(path: RoutePath, x: number, z: number, out: { s: number; d: number; dist: number }, hintS?: number, window = 16): { s: number; d: number; dist: number } {
  const n = path.stationCount;
  const st = path.stations;
  let lo = 0;
  let hi = n - 2;
  if (hintS !== undefined && Number.isFinite(hintS)) {
    const h = Math.floor(hintS / SP);
    lo = h - window < 0 ? 0 : h - window;
    hi = h + window > n - 2 ? n - 2 : h + window;
  }
  let best = lo;
  let bestD = Infinity;
  let bestT = 0;
  for (let k = lo; k <= hi; k++) {
    const a = k * STRIDE;
    const b = a + STRIDE;
    const ax = st[a]!;
    const az = st[a + 2]!;
    const ex = st[b]! - ax;
    const ez = st[b + 2]! - az;
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x - ax - t * ex;
    const qz = z - az - t * ez;
    const d = qx * qx + qz * qz;
    if (d < bestD) {
      bestD = d;
      best = k;
      bestT = t;
    }
  }
  const segEnd = best + 1 === n - 1 ? path.length : (best + 1) * SP;
  const s = best * SP + bestT * (segEnd - best * SP);
  const a = best * STRIDE;
  const b = a + STRIDE;
  const ex = st[b]! - st[a]!;
  const ez = st[b + 2]! - st[a + 2]!;
  const el = Math.sqrt(ex * ex + ez * ez);
  const px = st[a]! + bestT * ex;
  const pz = st[a + 2]! + bestT * ez;
  // right of travel = (−ez, ex)/el
  const d = el > 0 ? ((x - px) * -ez + (z - pz) * ex) / el : 0;
  out.s = s;
  out.d = d;
  out.dist = Math.sqrt(bestD);
  return out;
}
