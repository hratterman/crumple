/**
 * MILLBROOK (layout v6, R-WORLD): buildings on lots along every town street,
 * the landmark sites (gas station, diner, garage, sheriff, town hall, church,
 * freight depot, grocery), kerb colliders behind every sidewalk kerb line
 * (dropped at junction mouths and driveways), street lights (soft
 * `lightPole` props), stop signs (soft `signPost`), traffic-signal masts,
 * power lines, street trees, driveways, parking lots with parked cars and
 * the small furniture (benches, bins, hydrants, mailboxes, planters).
 *
 * Generator numerics for everything hashed (colliders, props); render-only
 * records may use any math. Deterministic: core/rng streams forked from the
 * layout seed, streets in layout order, sides −1 then +1.
 */
import { createRng, type Rng } from '../../core/rng';
import { MaterialId } from '../../protocol/messages';
import { createRoadProjection, projectToRoad } from '../roads';
import type { ColliderDef, PropPlacement, RoadProfile, TerrainData, Vec2, WorldLayout, WorldVec3 } from '../types';
import { SIDEWALK_RAMP_M } from '../types';
import type { SignalPlan } from '../signals';
import type {
  BuildingInstance,
  BuildingStyle,
  CableInstance,
  ContentExclusion,
  DecalInstance,
  ItemInstance,
  StripInstance,
  WorldLight,
} from './types';
import { box, cylinder, mm, pieces, roadBox, roadFrame, yawQuatDir } from './util';

/** Streets that get lots (layout order is kept; mill road only inside the town zone). */
const TOWN_STREETS = ['townRing', 'mainStreet', 'gateStreet', 'birchLane', 'cedarLane', 'parkStreetE', 'parkStreetW', 'millRoad'] as const;
type Zoning = 'commercial' | 'mixed' | 'residential' | 'industrial';
const ZONING: Readonly<Record<string, Zoning>> = {
  mainStreet: 'commercial',
  townRing: 'mixed',
  gateStreet: 'industrial',
  birchLane: 'residential',
  cedarLane: 'residential',
  parkStreetE: 'residential',
  parkStreetW: 'mixed',
  millRoad: 'residential',
};

export interface TownOut {
  colliders: ColliderDef[];
  props: PropPlacement[];
  exclusions: ContentExclusion[];
  lights: WorldLight[];
  plantings: { kind: number; x: number; z: number; scale: number }[];
  buildings: BuildingInstance[];
  items: ItemInstance[];
  decals: DecalInstance[];
  strips: StripInstance[];
  cables: CableInstance[];
}

// ------------------------------------------------------------------ occupancy grid
const CELL = 1;
const FREE = 0;
const ROAD = 1;
const BUILT = 2;
const LOT = 3;

class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly a: Uint8Array;
  constructor(
    readonly x0: number,
    readonly z0: number,
    x1: number,
    z1: number,
  ) {
    this.cols = Math.ceil((x1 - x0) / CELL);
    this.rows = Math.ceil((z1 - z0) / CELL);
    this.a = new Uint8Array(this.cols * this.rows);
  }
  /** Mark a disc (centre, radius) with v where currently < v. */
  disc(x: number, z: number, r: number, v: number): void {
    const c0 = Math.max(0, Math.floor((x - r - this.x0) / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((x + r - this.x0) / CELL));
    const r0 = Math.max(0, Math.floor((z - r - this.z0) / CELL));
    const r1 = Math.min(this.rows - 1, Math.floor((z + r - this.z0) / CELL));
    for (let rr = r0; rr <= r1; rr++) {
      const cz = this.z0 + (rr + 0.5) * CELL - z;
      for (let cc = c0; cc <= c1; cc++) {
        const cx = this.x0 + (cc + 0.5) * CELL - x;
        if (cx * cx + cz * cz > r * r) continue;
        const i = rr * this.cols + cc;
        if (this.a[i]! < v) this.a[i] = v;
      }
    }
  }
  /** Oriented rect test / mark: centre, unit axis (along +X local), half extents. */
  rect(cx: number, cz: number, ax: number, az: number, hx: number, hz: number, mark: number | null): boolean {
    const ex = Math.abs(ax) * hx + Math.abs(az) * hz;
    const ez = Math.abs(az) * hx + Math.abs(ax) * hz;
    const c0 = Math.floor((cx - ex - this.x0) / CELL);
    const c1 = Math.floor((cx + ex - this.x0) / CELL);
    const r0 = Math.floor((cz - ez - this.z0) / CELL);
    const r1 = Math.floor((cz + ez - this.z0) / CELL);
    if (mark === null && (c0 < 0 || r0 < 0 || c1 >= this.cols || r1 >= this.rows)) return false;
    for (let rr = Math.max(0, r0); rr <= Math.min(this.rows - 1, r1); rr++) {
      const pz = this.z0 + (rr + 0.5) * CELL - cz;
      for (let cc = Math.max(0, c0); cc <= Math.min(this.cols - 1, c1); cc++) {
        const px = this.x0 + (cc + 0.5) * CELL - cx;
        const u = px * ax + pz * az;
        const v = -px * az + pz * ax;
        if (u < -hx || u > hx || v < -hz || v > hz) continue;
        const i = rr * this.cols + cc;
        if (mark === null) {
          if (this.a[i] !== FREE) return false;
        } else if (this.a[i]! < mark) this.a[i] = mark;
      }
    }
    return true;
  }
}

// ------------------------------------------------------------------ palettes
const WALLS_HOUSE = [0xe8e2d0, 0xd9c8a8, 0xb9c9cf, 0xc7d3b7, 0xe6d3c2, 0xf0ece4, 0xa9b8c4, 0xd8bfa0, 0xcfd6dd, 0xe3d9b8];
const WALLS_BRICK = [0x9a5a44, 0x8c4f3c, 0xa8664b, 0x7d4a3a, 0xb07a5c];
const WALLS_STUCCO = [0xd8cdb8, 0xc9b9a0, 0xe0d6c4, 0xbfc3c0];
const TRIMS = [0xf4f1ea, 0xffffff, 0x3f4a3c, 0x5a4636, 0x2f3c4d, 0x7d2e2a];
const ROOFS = [0x4a4440, 0x5a3b32, 0x3c4048, 0x6b5f53, 0x403a36, 0x55606a];
const CAR_PAINTS = [0xb9bec4, 0x1c2a3f, 0x8b1e1e, 0xe9e7e1, 0x2f3a2e, 0x1a1a1c, 0x6b7b8c, 0xc9a24a, 0x3d5f7e, 0x7a2f4f];

const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng.float() * a.length) % a.length]!;

// ------------------------------------------------------------------ helpers
function profile(t: TerrainData, id: string): RoadProfile | null {
  return t.roads.find((r) => r.id === id) ?? null;
}
const kerbLine = (p: RoadProfile): number => p.width / 2 + p.shoulder;
const frontEdge = (p: RoadProfile): number => kerbLine(p) + (p.sidewalk ? p.sidewalk.width : 2.5);

export function buildTown(layout: WorldLayout, t: TerrainData, signals: readonly SignalPlan[], propBase: number): TownOut {
  const o: TownOut = { colliders: [], props: [], exclusions: [], lights: [], plantings: [], buildings: [], items: [], decals: [], strips: [], cables: [] };
  const zone = layout.zones.find((z) => z.id === 'millbrook');
  if (!zone || zone.shape.type !== 'rect') return o;
  const zc = zone.shape.center;
  const zx = zone.shape.halfX;
  const zz = zone.shape.halfZ;
  const inTown = (x: number, z: number, m = 0): boolean => Math.abs(x - zc[0]) <= zx - m && Math.abs(z - zc[1]) <= zz - m;
  const g = new Grid(zc[0] - zx - 20, zc[1] - zz - 20, zc[0] + zx + 20, zc[1] + zz + 20);
  const rng = createRng(layout.seed).fork(0x70a11);

  // ---- keep-out: every road's carriageway + verge + sidewalk (+ 0.8 m), junction mouths, layout colliders / props
  for (const p of t.roads) {
    const reach = frontEdge(p) + 0.8;
    const st = p.stations;
    for (let i = 0; i < p.stationCount; i++) {
      const x = st[i * 7]!;
      const z = st[i * 7 + 2]!;
      if (!inTown(x, z, -reach - 10)) continue;
      g.disc(x, z, reach, ROAD);
    }
  }
  for (const j of layout.junctions) {
    if (!inTown(j.pos[0], j.pos[1], -20)) continue;
    g.disc(j.pos[0], j.pos[1], 14, ROAD);
  }
  for (const c of layout.colliders) {
    if (!inTown(c.pos[0], c.pos[2], -20)) continue;
    g.disc(c.pos[0], c.pos[2], Math.max(c.size[0], c.size[2]) + 2, ROAD);
  }
  for (const pr of layout.props) {
    const n = pr.row ? pr.row.count : 1;
    for (let k = 0; k < n; k++) g.disc(pr.pos[0] + (pr.row ? pr.row.step[0] * k : 0), pr.pos[2] + (pr.row ? pr.row.step[1] * k : 0), 2.5, ROAD);
  }

  const driveways: { road: string; side: number; s0: number; s1: number }[] = [];
  let bIdx = 0;
  const addBuilding = (
    style: BuildingStyle,
    cx: number,
    cz: number,
    front: Vec2,
    hw: number,
    hd: number,
    height: number,
    floors: number,
    roof: BuildingInstance['roof'],
    wall: number,
    trim: number,
    roofColor: number,
    sign?: string,
    collide = true,
  ): void => {
    const id = `w:bld${bIdx++}`;
    const y = t.heights[Math.round(cz - t.originZ) * t.cols + Math.round(cx - t.originX)]!;
    const b: BuildingInstance = { id, style, pos: [cx, y, cz], front, hw, hd, height, floors, roof, wall, trim, roofColor, seed: Math.floor(rng.float() * 1e9) };
    if (sign) b.sign = sign;
    o.buildings.push(b);
    // front = local −Z → the quat maps local −Z to `front`; local X spans the width (hw), Z the depth (hd).
    if (collide) o.colliders.push(box(id, [cx, null, cz], yawQuatDir(front[0], front[1]), hw, height / 2, hd, MaterialId.concrete, 'building'));
    // Footprint keep-out (+ 2 m between buildings): the right axis is (−front.z, front.x).
    g.rect(cx, cz, -front[1], front[0], hw + 2, hd + 2, BUILT);
    o.exclusions.push({ cx, cz, ax: -front[1], az: front[0], hx: hw + 1.5, hz: hd + 1.5, detail: true });
  };

  /** Lot origin on a street side: centre of a footprint whose front edge sits `setback` behind the sidewalk. */
  const lotCentre = (p: RoadProfile, s: number, side: number, setback: number, hd: number): { x: number; z: number; front: Vec2; f: ReturnType<typeof roadFrame> } => {
    const f = roadFrame(p, s);
    const d = side * (frontEdge(p) + setback + hd);
    return { x: f.x + f.rx * d, z: f.z + f.rz * d, front: [-side * f.rx, -side * f.rz], f };
  };
  const fits = (x: number, z: number, front: Vec2, hw: number, hd: number, margin: number): boolean =>
    inTown(x, z, Math.max(hw, hd) + 1) && g.rect(x, z, -front[1], front[0], hw + margin, hd + margin, null);

  // ---- landmark sites (placed first; positions hand-picked around the ring)
  type Site = { style: BuildingStyle; road: string; at: Vec2; side: -1 | 1; hw: number; hd: number; h: number; floors: number; roof: BuildingInstance['roof']; wall: number; trim: number; roofC: number; sign: string; setback: number };
  const sites: Site[] = [
    { style: 'diner', road: 'mainStreet', at: [154, 368], side: -1, hw: 9, hd: 6, h: 4.4, floors: 1, roof: 'flat', wall: 0xd7d9db, trim: 0xb3202a, roofC: 0x6a6f74, sign: "ROSIE'S DINER", setback: 9 },
    { style: 'office', road: 'mainStreet', at: [146, 322], side: 1, hw: 9, hd: 8, h: 9.5, floors: 2, roof: 'flat', wall: 0xc9b9a0, trim: 0xf4f1ea, roofC: 0x5c5650, sign: 'TOWN HALL', setback: 3 },
    { style: 'office', road: 'mainStreet', at: [146, 362], side: 1, hw: 8, hd: 7, h: 7.2, floors: 2, roof: 'flat', wall: 0x8c4f3c, trim: 0xf4f1ea, roofC: 0x4a4440, sign: 'SHERIFF', setback: 2 },
    { style: 'garage', road: 'townRing', at: [94, 300], side: 1, hw: 9, hd: 7, h: 5.5, floors: 1, roof: 'flat', wall: 0xb9c9cf, trim: 0x2f3c4d, roofC: 0x55606a, sign: "HANK'S GARAGE", setback: 6 },
    { style: 'warehouse', road: 'townRing', at: [94, 380], side: 1, hw: 12, hd: 9, h: 8, floors: 1, roof: 'barrel', wall: 0x9aa3a8, trim: 0x2f3c4d, roofC: 0x6b7680, sign: 'MILLBROOK FREIGHT', setback: 4 },
    { style: 'church', road: 'parkStreetW', at: [100, 444], side: -1, hw: 6.5, hd: 9, h: 8, floors: 1, roof: 'gable', wall: 0xf0ece4, trim: 0x5a4636, roofC: 0x403a36, sign: '', setback: 5 },
    { style: 'shop', road: 'townRing', at: [86, 290], side: -1, hw: 12, hd: 9, h: 6, floors: 1, roof: 'flat', wall: 0xe0d6c4, trim: 0x3f4a3c, roofC: 0x5a5a58, sign: 'VALLEY GROCERY', setback: 12 },
  ];
  const sproj = createRoadProjection();
  for (const st of sites) {
    const p = profile(t, st.road);
    if (!p) continue;
    const sAt = projectToRoad(p, st.at[0], st.at[1], sproj).s;
    const c = lotCentre(p, sAt, st.side, st.setback, st.hd);
    if (!fits(c.x, c.z, c.front, st.hw, st.hd, 0.5)) continue;
    addBuilding(st.style, c.x, c.z, c.front, st.hw, st.hd, st.h, st.floors, st.roof, st.wall, st.trim, st.roofC, st.sign || undefined);
    // Paved forecourt / lot between the building and the sidewalk (+ parked cars for the grocery / diner).
    if (st.setback >= 6) {
      const f = c.f;
      const lotD = st.setback;
      const lx = f.x + f.rx * st.side * (frontEdge(p) + lotD / 2);
      const lz = f.z + f.rz * st.side * (frontEdge(p) + lotD / 2);
      o.decals.push({ kind: 'lotAsphalt', pos: [lx, 0, lz], dir: [f.tx, f.tz], hl: st.hw + 3, hw: lotD / 2, variant: 0 });
      g.rect(lx, lz, f.tx, f.tz, st.hw + 3, lotD / 2, LOT);
      driveways.push({ road: st.road, side: st.side, s0: sAt - st.hw - 2, s1: sAt + st.hw + 2 });
      const bays = Math.floor((2 * st.hw) / 2.7);
      for (let k = 0; k < bays; k++) {
        const along = -st.hw + 1.35 + k * 2.7;
        const bx = lx + f.tx * along;
        const bz = lz + f.tz * along;
        o.decals.push({ kind: 'bayLine', pos: [bx + f.tx * 1.35, 0, bz + f.tz * 1.35], dir: [f.rx * st.side, f.rz * st.side], hl: 2.3, hw: 0.06, variant: 0 });
        if (lotD >= 9 && rng.float() < 0.55) parkedCar(o, `${st.style}${k}`, bx, bz, [-st.side * f.rx, -st.side * f.rz], rng);
      }
    }
  }
  gasStation(o, t, g, rng, addBuilding);

  // ---- street frontage: houses / shops along every town street side
  for (const id of TOWN_STREETS) {
    const p = profile(t, id);
    if (!p) continue;
    const zoning = ZONING[id] ?? 'residential';
    for (const side of [-1, 1] as const) {
      const sr = rng.fork(id.length * 31 + (side + 1));
      let s = 4;
      while (s < p.length - 4) {
        const style: BuildingStyle =
          zoning === 'commercial' ? (sr.float() < 0.55 ? 'shopRow' : 'shop') : zoning === 'industrial' ? (sr.float() < 0.5 ? 'warehouse' : 'garage') : zoning === 'mixed' ? (sr.float() < 0.3 ? 'shop' : sr.float() < 0.5 ? 'houseTwoStorey' : 'house') : sr.float() < 0.4 ? 'houseTwoStorey' : sr.float() < 0.6 ? 'bungalow' : 'house';
        const res = style === 'house' || style === 'houseTwoStorey' || style === 'bungalow';
        const hw = res ? sr.range(4.2, 6.2) : style === 'shopRow' ? sr.range(7, 10) : style === 'warehouse' ? sr.range(8, 12) : sr.range(4.5, 6.5);
        const hd = res ? sr.range(4.5, 6.5) : style === 'warehouse' ? sr.range(7, 10) : sr.range(5, 7.5);
        const setback = res ? sr.range(5.5, 9) : style === 'warehouse' ? sr.range(4, 8) : sr.range(0.3, 1.2);
        const frontage = 2 * hw + (res ? sr.range(5, 9) : sr.range(0.6, 2));
        const sMid = s + frontage / 2;
        const c = lotCentre(p, sMid, side, setback, hd);
        if (!fits(c.x, c.z, c.front, hw, hd, res ? 1.5 : 0.4)) {
          s += 3;
          continue;
        }
        const floors = style === 'houseTwoStorey' || style === 'shopRow' ? 2 : style === 'shop' && sr.float() < 0.3 ? 2 : 1;
        const storey = res ? 2.9 : style === 'warehouse' ? 7 : 3.6;
        const height = floors * storey + (res ? 0.4 : 0.8);
        const roof: BuildingInstance['roof'] = res ? (sr.float() < 0.7 ? 'gable' : 'hip') : style === 'warehouse' ? (sr.float() < 0.5 ? 'barrel' : 'shed') : 'flat';
        const wall = style === 'shopRow' || style === 'shop' ? (sr.float() < 0.55 ? pick(sr, WALLS_BRICK) : pick(sr, WALLS_STUCCO)) : style === 'warehouse' || style === 'garage' ? pick(sr, [0x9aa3a8, 0xb5b0a4, 0x8d9a8f, 0xa59e90]) : pick(sr, WALLS_HOUSE);
        addBuilding(style, c.x, c.z, c.front, hw, hd, height, floors, roof, wall, pick(sr, TRIMS), pick(sr, ROOFS), res ? undefined : shopSign(sr, style));
        if (res) residentialLot(o, g, sr, p, sMid, side, hw, hd, setback, c, driveways);
        else if (style === 'shopRow' || style === 'shop') {
          // Awning + bench / planter on the sidewalk in front.
          o.items.push({ kind: 'awning', pos: [c.x + c.front[0] * (hd + 0.05), 0, c.z + c.front[1] * (hd + 0.05)], dir: c.front, scale: hw, variant: Math.floor(sr.float() * 4), color: pick(sr, [0x7d2e2a, 0x2f4a3c, 0x2f3c4d, 0xc9a24a, 0x5a4636]) });
        }
        s += frontage;
      }
    }
  }

  // ---- kerb colliders + sidewalk strips (dropped at junction mouths, driveways, bridge spans)
  const mouths = layout.junctions.map((j) => {
    let r = 0;
    for (const id of j.roads) {
      const p = profile(t, id);
      if (p) r = Math.max(r, p.width / 2 + p.shoulder);
    }
    return { x: j.pos[0], z: j.pos[1], r: r + 5.5 };
  });
  for (const p of t.roads) {
    if (!p.sidewalk) continue;
    const kl = kerbLine(p);
    for (const side of [-1, 1] as const) {
      const tag = side > 0 ? 'R' : 'L';
      // runs of s where the kerb exists
      let run0 = -1;
      const runs: [number, number][] = [];
      for (let s = 0; s <= p.length + 1e-9; s += 1) {
        const f = roadFrame(p, Math.min(s, p.length));
        const kx = f.x + f.rx * side * kl;
        const kz = f.z + f.rz * side * kl;
        let ok = true;
        for (const m of mouths) {
          const dx = kx - m.x;
          const dz = kz - m.z;
          if (dx * dx + dz * dz < m.r * m.r) ok = false;
        }
        for (const st of p.structures ?? []) if (s >= st.s0 - 4 && s <= st.s1 + 4) ok = false;
        for (const dw of driveways) if (dw.road === p.id && dw.side === side && s >= dw.s0 && s <= dw.s1) ok = false;
        if (ok && run0 < 0) run0 = s;
        if (!ok && run0 >= 0) {
          if (s - 1 - run0 >= 2) runs.push([run0, s - 1]);
          run0 = -1;
        }
      }
      if (run0 >= 0 && p.length - run0 >= 2) runs.push([run0, p.length]);
      runs.forEach(([a, b], ri) => {
        // Piece length from the run's tightest bend: chord sag ≤ 5 cm (L = √(8·0.05 / κ)), 1.5–8 m.
        let kMax = 0;
        for (let s2 = a; s2 <= b; s2 += 2) {
          const i2 = Math.min(p.stationCount - 1, Math.floor(s2 / 2));
          const kk = Math.abs(p.stations[i2 * 7 + 6]!);
          if (kk > kMax) kMax = kk;
        }
        const maxLen = kMax > 0 ? Math.min(8, Math.max(1.5, Math.sqrt(0.4 / kMax))) : 8;
        pieces(a, b, maxLen, (sa, sb, k) => {
          o.colliders.push(roadBox(`w:kerb:${p.id}:${tag}${ri}:${k}`, p, sa, sb, side * (kl + SIDEWALK_RAMP_M / 2), p.sidewalk!.kerb, p.sidewalk!.kerb + 0.35, SIDEWALK_RAMP_M / 2, 0.02, MaterialId.concrete, 'kerb'));
        });
        // render strip along the kerb line (the slab covers the ramp band and the raised sidewalk)
        const pts: number[] = [];
        const steps = Math.max(1, Math.ceil((b - a) / 2));
        for (let k = 0; k <= steps; k++) {
          const s = a + ((b - a) * k) / steps;
          const f = roadFrame(p, s);
          pts.push(f.x + f.rx * side * kl, f.y + f.bank * side * kl, f.z + f.rz * side * kl);
        }
        o.strips.push({ kind: 'sidewalk', points: pts, width: p.sidewalk!.width, height: p.sidewalk!.kerb, side });
      });
    }
  }

  // ---- street lights (soft light poles), every ~32 m alternating, on the kerb side of the sidewalk
  let lightIdx = 0;
  for (const id of TOWN_STREETS) {
    const p = profile(t, id);
    if (!p || !p.sidewalk) continue;
    const n = Math.floor(p.length / 32);
    for (let k = 0; k < n; k++) {
      const s = 16 + k * 32;
      if (s > p.length - 6) break;
      const side = k % 2 === 0 ? 1 : -1;
      const f = roadFrame(p, s);
      const d = side * (kerbLine(p) + 0.75);
      const x = f.x + f.rx * d;
      const z = f.z + f.rz * d;
      if (!inTown(x, z, 2)) continue;
      let nearMouth = false;
      for (const m of mouths) if ((x - m.x) * (x - m.x) + (z - m.z) * (z - m.z) < (m.r + 2) * (m.r + 2)) nearMouth = true;
      if (nearMouth) continue;
      const pid = `w:light${lightIdx++}`;
      const facing: Vec2 = [mm(-side * f.rx), mm(-side * f.rz)];
      const fl = Math.sqrt(facing[0] * facing[0] + facing[1] * facing[1]);
      o.props.push({ id: pid, prop: 'lightPole', pos: [mm(x), null, mm(z)], facing: [facing[0] / fl, facing[1] / fl] });
      o.lights.push({ kind: 'prop', pos: [x - side * f.rx * 2.4, f.y + 8.6, z - side * f.rz * 2.4], dir: [0, -1, 0], color: 0xffd6a0, intensity: 9000, range: 28, angle: 1.1, night: true, propIndex: propBase + o.props.length - 1, area: 'millbrook' });
      g.disc(x, z, 1.2, BUILT);
    }
  }

  // ---- stop signs (soft sign posts) on stop-controlled approaches; traffic-signal masts
  for (const j of layout.junctions) {
    if (j.control !== 'stop' && j.control !== 'allStop' && j.control !== 'yield') continue;
    let through: RoadProfile | null = null;
    for (const id of j.roads) {
      const p = profile(t, id);
      if (p && (!through || prioOf(p) > prioOf(through))) through = p;
    }
    for (const id of j.roads) {
      const p = profile(t, id);
      if (!p || (j.control !== 'allStop' && p === through)) continue;
      if (p.kind === 'dirt' || p.kind === 'arena' || p.kind === 'track') continue;
      const proj = projectToRoad(p, j.pos[0], j.pos[1], createRoadProjection());
      for (const side of [-1, 1] as const) {
        const sStop = proj.s + side * 14;
        if (sStop < 2 || sStop > p.length - 2) continue;
        if (p.oneWay && side > 0) continue;
        const f = roadFrame(p, sStop);
        // approaching lanes travel toward the junction: from side −1 that is +t; sign on their right
        const tx = -side * f.tx;
        const tz = -side * f.tz;
        const rx = -tz;
        const rz = tx;
        const d = kerbLine(p) + (p.sidewalk ? 0.6 : 1.2);
        const x = f.x + rx * d;
        const z = f.z + rz * d;
        o.props.push({ id: `w:stop:${j.id}:${p.id}:${side > 0 ? 'b' : 'a'}`, prop: 'signPost', pos: [mm(x), null, mm(z)], facing: [-tx, -tz] });
        o.items.push({ kind: j.control === 'yield' ? 'signYield' : 'signStop', pos: [x, 0, z], dir: [-tx, -tz], scale: 1, variant: o.props.length - 1 + propBase });
      }
    }
  }
  signalMasts(o, t, signals);

  // ---- power lines behind the sidewalks of the residential lanes + Mill Road; street trees on Main St / the ring
  for (const id of ['birchLane', 'cedarLane', 'millRoad', 'parkStreetE', 'parkStreetW']) {
    const p = profile(t, id);
    if (!p) continue;
    const side = id === 'millRoad' ? 1 : -1;
    const d = side * (kerbLine(p) + (p.sidewalk ? p.sidewalk.width + 0.4 : 3.5));
    const pts: number[] = [];
    let k = 0;
    for (let s = 6; s < p.length - 4; s += 34) {
      const f = roadFrame(p, s);
      const x = f.x + f.rx * d;
      const z = f.z + f.rz * d;
      if (!inTown(x, z, -60)) continue;
      const gy = t.heights[Math.round(z - t.originZ) * t.cols + Math.round(x - t.originX)]!;
      o.colliders.push(cylinder(`w:pole:${id}:${k++}`, [mm(x), null, mm(z)], [0, 0, 0, 1], 0.14, 4.5, MaterialId.wood, 'pole'));
      o.items.push({ kind: 'powerPole', pos: [x, gy, z], dir: [f.tx, f.tz], scale: 1, variant: 0 });
      pts.push(x, gy + 8.4, z);
      g.disc(x, z, 1, BUILT);
    }
    if (pts.length >= 6) {
      for (const off of [-0.7, 0, 0.7]) {
        const q: number[] = [];
        for (let i = 0; i < pts.length; i += 3) {
          const k2 = Math.min(i, pts.length - 6);
          const ax = pts[k2 + 3]! - pts[k2]!;
          const az = pts[k2 + 5]! - pts[k2 + 2]!;
          const l = Math.hypot(ax, az) || 1;
          q.push(pts[i]! - (az / l) * off, pts[i + 1]! + (off === 0 ? 0.6 : 0), pts[i + 2]! + (ax / l) * off);
        }
        o.cables.push({ kind: 'power', points: q, sag: 0.55 });
      }
    }
  }
  for (const id of ['mainStreet', 'townRing', 'parkStreetE', 'parkStreetW', 'gateStreet']) {
    const p = profile(t, id);
    if (!p || !p.sidewalk) continue;
    for (const side of [-1, 1] as const) {
      for (let s = 9; s < p.length - 6; s += id === 'mainStreet' ? 14 : 19) {
        const f = roadFrame(p, s);
        const d = side * (kerbLine(p) + 1.3);
        const x = f.x + f.rx * d;
        const z = f.z + f.rz * d;
        if (!g.rect(x, z, 1, 0, 1.2, 1.2, null)) continue;
        g.disc(x, z, 1.5, BUILT);
        o.plantings.push({ kind: 1, x: mm(x), z: mm(z), scale: mm(0.75 + 0.3 * rng.float()) });
        o.items.push({ kind: 'treeGrate', pos: [x, f.y + p.sidewalk.kerb, z], dir: [f.tx, f.tz], scale: 1, variant: 0 });
      }
    }
  }
  // Main St furniture: benches, bins, newspaper boxes, hydrants, a bus shelter.
  const main = profile(t, 'mainStreet');
  if (main && main.sidewalk) {
    for (const side of [-1, 1] as const) {
      for (let s = 20; s < main.length - 10; s += 23) {
        const f = roadFrame(main, s);
        const d = side * (kerbLine(main) + main.sidewalk.width - 0.7);
        const x = f.x + f.rx * d;
        const z = f.z + f.rz * d;
        if (!g.rect(x, z, f.tx, f.tz, 1.2, 0.5, null)) continue;
        const kind = ['bench', 'bin', 'newsBox', 'planter', 'hydrant'][Math.floor(rng.float() * 5)]!;
        o.items.push({ kind, pos: [x, f.y + main.sidewalk.kerb, z], dir: [-side * f.rx, -side * f.rz], scale: 1, variant: Math.floor(rng.float() * 3) });
        g.disc(x, z, 1, BUILT);
      }
    }
  }
  // Road wear decals: manholes, patches, oil, cracks on the town streets.
  for (const id of TOWN_STREETS) {
    const p = profile(t, id);
    if (!p) continue;
    for (let s = 7; s < p.length - 5; s += 9 + rng.float() * 14) {
      const f = roadFrame(p, s);
      const d = (rng.float() - 0.5) * p.width * 0.8;
      const kind = ['manhole', 'patch', 'oil', 'crack', 'crack', 'patch'][Math.floor(rng.float() * 6)]!;
      o.decals.push({ kind, pos: [f.x + f.rx * d, f.y + f.bank * d, f.z + f.rz * d], dir: [f.tx, f.tz], hl: kind === 'manhole' ? 0.4 : rng.range(0.6, 2.4), hw: kind === 'manhole' ? 0.4 : rng.range(0.4, 1.4), variant: Math.floor(rng.float() * 4) });
    }
  }
  return o;
}

function prioOf(p: RoadProfile): number {
  const order = ['dirt', 'street', 'country', 'mountain', 'arena', 'track', 'highway'];
  return order.indexOf(p.kind);
}

function shopSign(rng: Rng, style: BuildingStyle): string {
  const a = ['HARDWARE', 'BAKERY', 'BARBER', 'BOOKS', 'PHARMACY', 'FLORIST', 'TAILOR', 'PIZZA', 'DELI', 'BANK', 'POST OFFICE', 'ANTIQUES', 'CAFE', 'TOYS', 'LAUNDRY', 'VIDEO', 'RADIO', 'SHOES', 'OPTICIAN', 'BAR'];
  const ind = ['TIRES', 'BODY SHOP', 'AUTO PARTS', 'FEED & SEED', 'LUMBER', 'STORAGE'];
  return style === 'warehouse' || style === 'garage' ? pick(rng, ind) : pick(rng, a);
}

function parkedCar(o: TownOut, key: string, x: number, z: number, dir: Vec2, rng: Rng): void {
  const id = `w:car:${key}:${o.items.length}`;
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1]);
  const fx = dir[0] / l;
  const fz = dir[1] / l;
  const variant = Math.floor(rng.float() * 3); // 0 sedan, 1 hatch, 2 pickup
  const len = variant === 2 ? 2.7 : variant === 1 ? 2.05 : 2.35;
  o.colliders.push(box(id, [mm(x), null, mm(z)], yawQuatDir(fx, fz), 0.9, 0.72, len, MaterialId.metal, 'parked'));
  o.items.push({ kind: 'parkedCar', pos: [x, 0, z], dir: [fx, fz], scale: 1, variant, color: pick(rng, CAR_PAINTS) });
}

/** Residential lot: driveway (kerb drop), maybe a parked car, mailbox, picket fence, yard trees. */
function residentialLot(
  o: TownOut,
  g: Grid,
  rng: Rng,
  p: RoadProfile,
  sMid: number,
  side: -1 | 1,
  hw: number,
  hd: number,
  setback: number,
  c: { x: number; z: number; front: Vec2; f: ReturnType<typeof roadFrame> },
  driveways: { road: string; side: number; s0: number; s1: number }[],
): void {
  const f = c.f;
  const dwSide = rng.float() < 0.5 ? -1 : 1;
  const sDw = sMid + dwSide * (hw + 1.8);
  driveways.push({ road: p.id, side, s0: sDw - 1.6, s1: sDw + 1.6 });
  const fe = kerbLine(p) + (p.sidewalk ? p.sidewalk.width : 2.5);
  const fd = roadFrame(p, sDw);
  const dLen = setback + hd * 1.2;
  const dx = fd.x + fd.rx * side * (fe + dLen / 2);
  const dz = fd.z + fd.rz * side * (fe + dLen / 2);
  o.decals.push({ kind: 'driveway', pos: [dx, 0, dz], dir: [fd.rx * side, fd.rz * side], hl: dLen / 2, hw: 1.5, variant: Math.floor(rng.float() * 3) });
  g.rect(dx, dz, fd.rx * side, fd.rz * side, dLen / 2, 1.7, LOT);
  if (rng.float() < 0.45) {
    const px = fd.x + fd.rx * side * (fe + 3.2);
    const pz = fd.z + fd.rz * side * (fe + 3.2);
    parkedCar(o, `${p.id}${Math.round(sMid)}`, px, pz, [-side * fd.rx, -side * fd.rz], rng);
  }
  // Mailbox at the sidewalk's back edge beside the driveway (static here; soft mailboxes are a prop follow-up).
  const mb = roadFrame(p, sDw + dwSide * 2.2);
  o.items.push({ kind: 'mailbox', pos: [mb.x + mb.rx * side * (fe + 0.4), 0, mb.z + mb.rz * side * (fe + 0.4)], dir: [-side * mb.rx, -side * mb.rz], scale: 1, variant: Math.floor(rng.float() * 3) });
  // Picket / rail fence along the front of the yard (render), gap at the driveway.
  if (rng.float() < 0.55) {
    const a = sMid - hw - 0.6 + (dwSide < 0 ? 3.6 : 0);
    const b = sMid + hw + 0.6 - (dwSide > 0 ? 3.6 : 0);
    const pts: number[] = [];
    for (let k = 0; k <= 4; k++) {
      const fs = roadFrame(p, a + ((b - a) * k) / 4);
      pts.push(fs.x + fs.rx * side * (fe + 0.6), 0, fs.z + fs.rz * side * (fe + 0.6));
    }
    o.strips.push({ kind: rng.float() < 0.6 ? 'fencePicket' : 'fenceRail', points: pts, width: 0, height: 1, side });
  }
  // Yard trees + shrubs behind / beside the house.
  for (let k = 0; k < 2; k++) {
    const along = (rng.float() - 0.5) * (2 * hw + 4);
    const back = setback + 2 * hd + 2.5 + rng.float() * 3;
    const fs = roadFrame(p, sMid + along);
    const x = fs.x + fs.rx * side * (fe + back);
    const z = fs.z + fs.rz * side * (fe + back);
    if (!g.rect(x, z, 1, 0, 1.5, 1.5, null)) continue;
    g.disc(x, z, 2, BUILT);
    o.plantings.push({ kind: rng.float() < 0.7 ? 1 : 0, x: mm(x), z: mm(z), scale: mm(0.7 + 0.45 * rng.float()) });
  }
  void f;
}

/** Valley Gas: canopy over two pump islands on the ring's north-east corner, kiosk behind. */
function gasStation(
  o: TownOut,
  t: TerrainData,
  g: Grid,
  rng: Rng,
  addBuilding: (style: BuildingStyle, cx: number, cz: number, front: Vec2, hw: number, hd: number, height: number, floors: number, roof: BuildingInstance['roof'], wall: number, trim: number, roofColor: number, sign?: string, collide?: boolean) => void,
): void {
  const cx = 179;
  const cz = 276;
  if (!g.rect(cx, cz, 1, 0, 12, 13, null)) return;
  const y = t.heights[Math.round(cz - t.originZ) * t.cols + Math.round(cx - t.originX)]!;
  // Forecourt (concrete), canopy (render) on four posts (colliders), two pump islands (colliders).
  o.decals.push({ kind: 'forecourt', pos: [cx, y, cz + 2], dir: [1, 0], hl: 12.5, hw: 11, variant: 0 });
  g.rect(cx, cz + 2, 1, 0, 12.5, 11, LOT);
  o.items.push({ kind: 'gasCanopy', pos: [cx, y, cz], dir: [0, -1], scale: 1, variant: 0 });
  for (const [px, pz] of [
    [-7.5, -4.5],
    [7.5, -4.5],
    [-7.5, 4.5],
    [7.5, 4.5],
  ] as const) {
    o.colliders.push(cylinder(`w:gas:post${px > 0 ? 'E' : 'W'}${pz > 0 ? 'S' : 'N'}`, [cx + px, null, cz + pz], [0, 0, 0, 1], 0.22, 2.6, MaterialId.metal, 'pole'));
  }
  for (const ix of [-4.5, 4.5]) {
    o.colliders.push(box(`w:gas:island${ix > 0 ? 'E' : 'W'}`, [cx + ix, null, cz], [0, 0, 0, 1], 0.7, 0.1, 3.2, MaterialId.concrete, 'kerb'));
    o.items.push({ kind: 'fuelPump', pos: [cx + ix, y + 0.2, cz - 1.4], dir: [1, 0], scale: 1, variant: 0 });
    o.items.push({ kind: 'fuelPump', pos: [cx + ix, y + 0.2, cz + 1.4], dir: [1, 0], scale: 1, variant: 1 });
  }
  addBuilding('gasStation', cx + 2, cz + 17.5, [0, -1], 8, 5, 4.2, 1, 'flat', 0xe9e7e1, 0xc52b22, 0x6a6f74, 'VALLEY GAS');
  o.items.push({ kind: 'priceSign', pos: [cx - 11, y, cz - 11.5], dir: [0, -1], scale: 1, variant: 0 });
  o.lights.push({ kind: 'flood', pos: [cx, y + 5.1, cz], dir: [0, -1, 0], color: 0xf4f6ff, intensity: 20000, range: 24, angle: 1.3, night: true, area: 'millbrook' });
  void rng;
}

/** Signal masts at every signalled junction leg: pole + mast arm over the approach, heads per leg (render), pole collider. */
function signalMasts(o: TownOut, t: TerrainData, plans: readonly SignalPlan[]): void {
  plans.forEach((plan, pi) => {
    plan.legs.forEach((leg, li) => {
      const p = t.roads.find((r) => r.id === leg.road);
      if (!p) return;
      // pole at the right kerb of the approach, just past the stop line
      const rx = -leg.dir[1];
      const rz = leg.dir[0];
      const d = kerbLine(p) + (p.sidewalk ? 0.8 : 1.6);
      const x = leg.stop[0] + rx * d + leg.dir[0] * 1.5;
      const z = leg.stop[2] + rz * d + leg.dir[1] * 1.5;
      o.colliders.push(cylinder(`w:sig:${plan.junction}:${li}`, [mm(x), null, mm(z)], [0, 0, 0, 1], 0.16, 3.2, MaterialId.metal, 'pole'));
      o.items.push({ kind: 'signalMast', pos: [x, leg.stop[1], z], dir: [leg.dir[0], leg.dir[1]], scale: d, variant: pi * 64 + li });
      for (const lamp of ['red', 'amber', 'green'] as const) {
        const hy = lamp === 'red' ? 6.35 : lamp === 'amber' ? 6.05 : 5.75;
        const arm = d - p.width / 4;
        o.lights.push({ kind: 'signal', pos: [x - rx * arm, leg.stop[1] + hy, z - rz * arm], dir: [-leg.dir[0], 0, -leg.dir[1]], color: lamp === 'red' ? 0xff2a1a : lamp === 'amber' ? 0xffa21a : 0x2aff7a, intensity: 600, range: 60, angle: 0.35, night: false, signal: { plan: pi, leg: li, lamp } });
      }
    });
  });
  void ({} as WorldVec3);
}
