/**
 * Mode areas, infrastructure furniture and landmarks (layout v6, R-WORLD):
 *  - Raceway: armco both sides at 15 m (concrete pit wall along the pit straight), tyre walls
 *    behind the gravel traps, red/white apex kerbs, pit garages + race control, grandstands,
 *    the start-lights gantry, start / finish line, grid boxes and pit boxes.
 *  - Interchange: armco along the ramps, overhead gantry signs on the highway.
 *  - Dragway: concrete walls, the Christmas tree, timing-beam posts, start line, grandstand.
 *  - Proving ground: hangars on the apron, runway markings; crash lab: hall, rigid + offset
 *    barriers, the side pole, the side-impact sled and its rails.
 *  - Quarry: container stacks, wreck yard, concrete pipes, gantry crane, a destruction course
 *    of soft props and ramps.
 *  - Off-road park: log pile, rock garden; rally stage: tape lines + spectators at hairpins,
 *    start / finish arches; landmarks: radio mast, Hartley Farm, the lakeside campsite, the
 *    Northgate lookout.
 * Everything that reaches the sim (colliders, props) uses the generator numerics (+ − × ÷
 * sqrt floor abs min max, mm-rounded) and fixed iteration order.
 */
import { createRng, type Rng } from '../../core/rng';
import { MaterialId } from '../../protocol/messages';
import { createRoadProjection, projectToRoad } from '../roads';
import type { ColliderDef, PropPlacement, RoadProfile, TerrainData, Vec2, WorldLayout } from '../types';
import type { BuildingInstance, BuildingStyle, CableInstance, ContentExclusion, DecalInstance, ItemInstance, StripInstance, StructureInstance, WorldLight } from './types';
import { heightAt as terrainHeight } from './structures';
import { box, cylinder, hash01, mm, pieces, roadBox, roadFrame, yawQuatDir, type Quat } from './util';

export interface AreaOut {
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
  structures: StructureInstance[];
}

const PROJ = createRoadProjection();
const WRECK_PAINTS = [0x6b3a24, 0x5a4a3a, 0x3d4a52, 0x7a5a2a, 0x4a2a22, 0x5c5f58];

interface Ctx {
  o: AreaOut;
  t: TerrainData;
  rng: Rng;
  propBase: number;
  /** Nearest-sample terrain height. */
  H(x: number, z: number): number;
  prof(id: string): RoadProfile | null;
  bIdx: number;
}

export function buildAreas(layout: WorldLayout, t: TerrainData, propBase: number): AreaOut {
  const o: AreaOut = { colliders: [], props: [], exclusions: [], lights: [], plantings: [], buildings: [], items: [], decals: [], strips: [], cables: [], structures: [] };
  const H = (x: number, z: number): number => {
    const c = Math.min(t.cols - 1, Math.max(0, Math.round((x - t.originX) / t.spacing)));
    const r = Math.min(t.rows - 1, Math.max(0, Math.round((z - t.originZ) / t.spacing)));
    return t.heights[r * t.cols + c]!;
  };
  const byId = new Map(t.roads.map((p) => [p.id, p]));
  const cx: Ctx = { o, t, rng: createRng(((layout.seed ?? 1) ^ 0x5a17) >>> 0), propBase, H, prof: (id) => byId.get(id) ?? null, bIdx: 0 };
  const has = (id: string): boolean => byId.has(id);
  if (has('raceway')) raceway(cx);
  if (has('rampNE')) interchange(cx);
  if (has('dragStrip')) dragway(cx);
  if (has('runway')) provingGround(cx);
  if (has('crashLane')) crashLab(cx);
  if (has('quarryRoad')) quarry(cx);
  if (has('offroadTrail')) offroad(cx);
  if (has('rallyStage')) rally(cx);
  landmarks(cx, layout);
  puddles(cx);
  return o;
}

// ------------------------------------------------------------------ shared helpers

function building(
  c: Ctx,
  style: BuildingStyle,
  x: number,
  z: number,
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
): void {
  const id = `w:a:bld${c.bIdx++}`;
  const b: BuildingInstance = { id, style, pos: [x, c.H(x, z), z], front, hw, hd, height, floors, roof, wall, trim, roofColor, seed: Math.floor(c.rng.float() * 1e9) };
  if (sign) b.sign = sign;
  c.o.buildings.push(b);
  c.o.colliders.push(box(id, [x, null, z], yawQuatDir(front[0], front[1]), hw, height / 2, hd, MaterialId.concrete, 'building'));
  c.o.exclusions.push({ cx: x, cz: z, ax: -front[1], az: front[0], hx: hw + 2, hz: hd + 2, detail: true });
}

/** True when (x, z) lies within `margin` of the carriageway + shoulder of any road other than `self` (crossings, merges). */
const BOUNDS = new WeakMap<RoadProfile, [number, number, number, number]>();
function boundsOf(p: RoadProfile): [number, number, number, number] {
  let b = BOUNDS.get(p);
  if (!b) {
    b = [Infinity, -Infinity, Infinity, -Infinity];
    for (let s = 0; s <= p.length + 5; s += 5) {
      const f = roadFrame(p, Math.min(s, p.length));
      b[0] = Math.min(b[0], f.x);
      b[1] = Math.max(b[1], f.x);
      b[2] = Math.min(b[2], f.z);
      b[3] = Math.max(b[3], f.z);
    }
    BOUNDS.set(p, b);
  }
  return b;
}

function nearOtherRoad(c: Ctx, self: string, x: number, z: number, margin: number): boolean {
  for (const p of c.t.roads) {
    if (p.id === self) continue;
    const reach = p.width / 2 + p.shoulder + margin;
    // cheap reject on the (5 m sampled, padded) plan bounds; projection is O(stations)
    const b = boundsOf(p);
    if (x < b[0] - reach - 3 || x > b[1] + reach + 3 || z < b[2] - reach - 3 || z > b[3] + reach + 3) continue;
    const pr = projectToRoad(p, x, z, PROJ);
    if (pr.dist < reach) return true;
  }
  return false;
}

type BarrierKind = 'armco' | 'wall' | 'tyres';

/**
 * A barrier along road `p` at lateral offset `d` over [s0, s1]: box colliders in ≤ `maxLen` m pieces
 * (skipped where `skip` says or near another road), render strips per contiguous run.
 */
function barrier(c: Ctx, p: RoadProfile, s0: number, s1: number, d: number, kind: BarrierKind, tag: string, skip?: (x: number, z: number) => boolean, maxLen = 8): void {
  const spec =
    kind === 'armco'
      ? { top: 0.75, depth: 1.1, halfW: 0.12, mat: MaterialId.metal, strip: 'armco' as const }
      : kind === 'wall'
        ? { top: 1.05, depth: 1.4, halfW: 0.3, mat: MaterialId.concrete, strip: 'kerbConcrete' as const }
        : { top: 0.9, depth: 1.0, halfW: 0.62, mat: MaterialId.rubber, strip: 'tyreWall' as const };
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 6) c.o.strips.push({ kind: spec.strip, points: run, width: spec.halfW * 2, height: spec.top, side: d >= 0 ? 1 : -1 });
    run = [];
  };
  let k = 0;
  pieces(s0, s1, maxLen, (sa, sb) => {
    const fm = roadFrame(p, (sa + sb) / 2);
    const mx = fm.x + fm.rx * d;
    const mz = fm.z + fm.rz * d;
    if ((skip && skip(mx, mz)) || nearOtherRoad(c, p.id, mx, mz, 2.5)) {
      flush();
      return;
    }
    c.o.colliders.push(roadBox(`w:${tag}:${k++}`, p, sa, sb, d, spec.top, spec.depth, spec.halfW, 0.05, spec.mat, 'armco'));
    const fa = roadFrame(p, sa);
    const fb = roadFrame(p, sb);
    if (run.length === 0) run.push(fa.x + fa.rx * d, fa.y + fa.bank * d, fa.z + fa.rz * d);
    run.push(fb.x + fb.rx * d, fb.y + fb.bank * d, fb.z + fb.rz * d);
    c.o.exclusions.push({ cx: mx, cz: mz, ax: fm.tx, az: fm.tz, hx: (sb - sa) / 2 + 1, hz: spec.halfW + 1.5, detail: false });
  });
  flush();
}

/** Free-standing barrier along a plan polyline (tyre walls behind gravel traps). */
function barrierLine(c: Ctx, pts: [number, number][], kind: BarrierKind, tag: string): void {
  const halfW = kind === 'tyres' ? 0.62 : kind === 'wall' ? 0.3 : 0.12;
  const top = kind === 'tyres' ? 0.9 : kind === 'wall' ? 1.05 : 0.75;
  const run: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]!;
    run.push(x, c.H(x, z), z);
    if (i === 0) continue;
    const [ax, az] = pts[i - 1]!;
    const dx = x - ax;
    const dz = z - az;
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L < 0.05) continue;
    c.o.colliders.push(box(`w:${tag}:${i - 1}`, [(ax + x) / 2, null, (az + z) / 2], yawQuatDir(dx, dz), halfW, top / 2, L / 2 + 0.05, kind === 'tyres' ? MaterialId.rubber : MaterialId.concrete, 'armco'));
  }
  if (run.length >= 6) c.o.strips.push({ kind: kind === 'tyres' ? 'tyreWall' : 'kerbConcrete', points: run, width: halfW * 2, height: top, side: 1 });
}

function paint(c: Ctx, kind: string, x: number, z: number, dir: Vec2, hl: number, hw: number, variant = 0): void {
  c.o.decals.push({ kind, pos: [x, 0, z], dir, hl, hw, variant });
}

function grandstand(c: Ctx, x: number, z: number, front: Vec2, hw: number, rows: number, tag: string): void {
  // Seating rises away from the front: depth 0.85 m per row, 0.45 m rise per row, roof on columns.
  const hd = (rows * 0.85) / 2 + 1;
  const h = rows * 0.45 + 1.2;
  c.o.colliders.push(box(`w:${tag}`, [x, null, z], yawQuatDir(front[0], front[1]), hw, h / 2, hd, MaterialId.concrete, 'building'));
  c.o.structures.push({ id: tag, kind: 'grandstand', pos: [x, c.H(x, z), z], dir: front, params: { hw, hd, rows } });
  c.o.exclusions.push({ cx: x, cz: z, ax: -front[1], az: front[0], hx: hw + 3, hz: hd + 3, detail: true });
}

function floodlight(c: Ctx, x: number, z: number, aim: Vec2, h: number, area: string, tag: string): void {
  c.o.colliders.push(cylinder(`w:${tag}`, [x, null, z], [0, 0, 0, 1], 0.22, h / 2, MaterialId.metal, 'pole'));
  c.o.items.push({ kind: 'floodMast', pos: [x, 0, z], dir: aim, scale: h / 18, variant: 0 });
  c.o.lights.push({ kind: 'flood', pos: [x, c.H(x, z) + h, z], dir: [aim[0] * 0.7, -0.7, aim[1] * 0.7], color: 0xf2f4ff, intensity: 60000, range: 90, angle: 0.7, night: true, area });
}

/**
 * Unit direction k of N around the circle without trig (generator numerics): a point walking the
 * unit square's perimeter, normalised (angles slightly uneven; fine for scatter / outlines).
 */
function ringDir(k: number, N: number): [number, number] {
  const u = ((k % N) + N) % N / N * 8; // 0..8 along the perimeter (side length 2)
  const side = Math.floor(u / 2);
  const f = u - side * 2 - 1; // −1..1
  const px = side === 0 ? 1 : side === 1 ? -f : side === 2 ? -1 : f;
  const pz = side === 0 ? f : side === 1 ? 1 : side === 2 ? -f : -1;
  const l = Math.sqrt(px * px + pz * pz);
  return [px / l, pz / l];
}

/** Uniform point in the unit disc by rejection (seeded rng; sqrt-free). */
function discPoint(rng: Rng): [number, number] {
  for (;;) {
    const x = rng.float() * 2 - 1;
    const z = rng.float() * 2 - 1;
    if (x * x + z * z <= 1) return [x, z];
  }
}

/** Turn direction at s: +1 turning right (inside = +d), −1 left, by the tangent change over ±4 m. */
function turnSign(p: RoadProfile, s: number): number {
  const a = roadFrame(p, Math.max(0, s - 4));
  const b = roadFrame(p, Math.min(p.length, s + 4));
  const cr = a.tx * b.tz - a.tz * b.tx;
  return cr > 0 ? 1 : -1;
}

// ------------------------------------------------------------------ raceway

function raceway(c: Ctx): void {
  const p = c.prof('raceway')!;
  const pit = c.prof('pitLane');
  const traps = [
    [486, 818, 34, 26],
    [500, 1112, 30, 26],
    [-506, 1050, 22, 46],
    [-100, 1112, 50, 10],
    [-500, 828, 18, 34],
  ] as const;
  const inTrap = (x: number, z: number, grow: number): boolean => {
    for (const [ex, ez, rx, rz] of traps) {
      const u = (x - ex) / (rx + grow);
      const v = (z - ez) / (rz + grow);
      if (u * u + v * v < 1) return true;
    }
    return false;
  };
  // Pit straight: the north side (d < 0 while the straight runs +x) is the pit wall where the pit lane runs alongside.
  const pitWallSide = (x: number, z: number): boolean => {
    if (!pit) return false;
    const pr = projectToRoad(pit, x, z, PROJ);
    return pr.dist < 16 && pr.s > 30 && pr.s < pit.length - 30;
  };
  const D = 15;
  // Run-off is clear ground: no trees / shrubs within 26 m of the centreline (barriers at 15 m, traps beyond).
  pieces(0, p.length, 20, (sa, sb) => {
    const f = roadFrame(p, (sa + sb) / 2);
    c.o.exclusions.push({ cx: f.x, cz: f.z, ax: f.tx, az: f.tz, hx: (sb - sa) / 2 + 2, hz: 26, detail: false });
  });
  for (const side of [-1, 1] as const) {
    barrier(c, p, 0, p.length, side * D, 'armco', `rw:armco${side > 0 ? 'R' : 'L'}`, (x, z) => inTrap(x, z, 5) || pitWallSide(x, z));
  }
  // Concrete pit wall with a catch fence between the pit lane and the straight.
  if (pit) {
    const a = 46;
    const b = pit.length - 40;
    barrier(c, pit, a, b, 11.5, 'wall', 'rw:pitwall', undefined, 10);
    const pts: number[] = [];
    pieces(a, b, 10, (sa, sb, k) => {
      const f = roadFrame(pit, k === 0 ? sa : sb);
      if (k === 0) pts.push(f.x + f.rx * 11.5, f.y + 1.05, f.z + f.rz * 11.5);
      else pts.push(f.x + f.rx * 11.5, f.y + 1.05, f.z + f.rz * 11.5);
    });
    c.o.strips.push({ kind: 'fenceChain', points: pts, width: 0, height: 3, side: 1 });
  }
  // Tyre walls along the back of each gravel trap (the part of the trap boundary away from the track).
  traps.forEach(([ex, ez, rx, rz], ti) => {
    let run: [number, number][] = [];
    let seg = 0;
    const N = 48;
    for (let k = 0; k <= N; k++) {
      const [ux, uz] = ringDir(k, N);
      const x = ex + (rx + 3) * ux;
      const z = ez + (rz + 3) * uz;
      const pr = projectToRoad(p, x, z, PROJ);
      const ok = pr.dist > 17 && !nearOtherRoad(c, 'raceway', x, z, 3);
      if (ok) run.push([mm(x), mm(z)]);
      if ((!ok || k === N) && run.length > 0) {
        if (run.length >= 3) barrierLine(c, run, 'tyres', `rw:tyres${ti}:${seg++}`);
        run = [];
      }
    }
  });
  // Red / white kerbs on both edges wherever the circuit turns tighter than R 160 m (render: a flat
  // painted kerb 1.2 m wide just outside the white edge line).
  const step = 4;
  let kStart = -1;
  let kSide = 0;
  const closeKerb = (sEnd: number): void => {
    if (kStart < 0) return;
    for (const side of [-1, 1]) {
      const pts: number[] = [];
      for (let s = kStart; s <= sEnd + 1e-6; s += 2) {
        const f = roadFrame(p, s);
        const d = side * (p.width / 2);
        pts.push(f.x + f.rx * d, f.y + f.bank * d, f.z + f.rz * d);
      }
      if (pts.length >= 6) c.o.strips.push({ kind: 'kerbRedWhite', points: pts, width: side === kSide ? 1.4 : 1.0, height: 0.06, side: side as 1 | -1 });
    }
    kStart = -1;
  };
  for (let s = 0; s <= p.length; s += step) {
    const a = roadFrame(p, Math.max(0, s - 3));
    const b = roadFrame(p, Math.min(p.length, s + 3));
    const cr = a.tx * b.tz - a.tz * b.tx; // ≈ 6 m / R
    const tight = Math.abs(cr) > 6 / 160;
    if (tight && kStart < 0) {
      kStart = Math.max(0, s - 6);
      kSide = cr > 0 ? 1 : -1;
    } else if (!tight && kStart >= 0) closeKerb(Math.min(p.length, s + 6));
  }
  closeKerb(p.length);

  // Start / finish line (checkered band) + grid boxes; start-lights gantry over the line.
  const sf = projectToRoad(p, 60, 800, PROJ).s;
  const f = roadFrame(p, sf);
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 2; j++) {
      if ((i + j) % 2 === 1) continue;
      const d = -p.width / 2 + (i + 0.5) * (p.width / 12);
      const along = (j - 0.5) * 0.5;
      paint(c, 'paint', f.x + f.rx * d + f.tx * along, f.z + f.rz * d + f.tz * along, [f.tx, f.tz], 0.25, p.width / 24);
    }
  }
  for (let k = 0; k < 12; k++) {
    const gx = 60 - 10 - k * 8;
    const gz = 800 + (k % 2 === 0 ? -3.2 : 3.2);
    const g = roadFrame(p, projectToRoad(p, gx, gz, PROJ).s);
    // front line + two side ticks of the grid slot (the car's nose sits on the front line)
    paint(c, 'paint', gx + g.tx * 2.4, gz + g.tz * 2.4, [g.rx, g.rz], 1.3, 0.08);
    for (const sd of [-1, 1]) paint(c, 'paint', gx + g.tx * 1.6 + g.rx * sd * 1.3, gz + g.tz * 1.6 + g.rz * sd * 1.3, [g.tx, g.tz], 0.8, 0.06);
  }
  c.o.structures.push({ id: 'rw:startGantry', kind: 'startGantry', pos: [f.x, f.y, f.z], dir: [f.tx, f.tz], params: { span: D - 4, clear: 6.2 } });
  for (const sd of [-1, 1]) c.o.colliders.push(cylinder(`w:rw:gantryPost${sd > 0 ? 'R' : 'L'}`, [f.x + f.rx * sd * (D - 4), null, f.z + f.rz * sd * (D - 4)], [0, 0, 0, 1], 0.3, 3.8, MaterialId.metal, 'pole'));
  c.o.lights.push({ kind: 'sign', pos: [f.x, f.y + 7.2, f.z], dir: [-f.tx, 0, -f.tz], color: 0xff2a1a, intensity: 2000, range: 120, angle: 0.5, night: false, area: 'raceway' });

  // Pit garages (one long block, 8 boxes) + race control + hospitality, all facing the pit lane.
  if (pit) {
    building(c, 'pitGarage', 4, 763.5, [0, 1], 98, 8, 7.2, 2, 'flat', 0xe4e6e8, 0x2b4c7e, 0x8c9196, 'CRUMPLE VALLEY RACEWAY');
    building(c, 'office', 160, 762, [0, 1], 16, 9, 12, 3, 'flat', 0xdfe2e6, 0x1f2a36, 0x6a6f74, 'RACE CONTROL');
    building(c, 'office', -150, 762, [0, 1], 22, 8, 8, 2, 'flat', 0xe9e4da, 0x7a2f2f, 0x6a6f74);
    for (let k = 0; k < 8; k++) {
      const x = -80 + k * 24;
      // pit box: yellow outline in front of each garage
      paint(c, 'paintYellow', x, 777 - 1.6, [1, 0], 3.2, 0.07);
      paint(c, 'paintYellow', x - 3.2, 777, [0, 1], 1.6, 0.07);
      paint(c, 'paintYellow', x + 3.2, 777, [0, 1], 1.6, 0.07);
    }
    // pit-lane speed line (white) at both ends
    for (const s of [40, pit.length - 36]) {
      const g = roadFrame(pit, s);
      paint(c, 'paint', g.x, g.z, [g.rx, g.rz], pit.width / 2, 0.15);
    }
    // paddock: team trucks (parked colliders) behind the garages
    for (let k = 0; k < 6; k++) {
      const x = -60 + k * 34;
      const id = `w:rw:truck${k}`;
      c.o.colliders.push(box(id, [x, null, 738], yawQuatDir(1, 0), 1.3, 1.9, 7.5, MaterialId.metal, 'parked'));
      c.o.items.push({ kind: 'truck', pos: [x, 0, 738], dir: [1, 0], scale: 1, variant: k % 3, color: [0x2b4c7e, 0xc52b22, 0xe9e7e1, 0x1a1a1c, 0xd9a21b, 0x2f6b3a][k]! });
    }
  }
  // Grandstands on the outside of the main straight (behind the armco), facing the pits; another at the hairpin.
  grandstand(c, 0, 832, [0, -1], 48, 14, 'rw:standA');
  grandstand(c, 120, 832, [0, -1], 48, 14, 'rw:standB');
  grandstand(c, -548, 1112, [1, 0], 26, 10, 'rw:standHairpin');
  grandstand(c, 560, 1080, [-1, 0], 22, 10, 'rw:standCarousel');
  // Floodlight masts along the straight (night racing).
  for (let k = 0; k < 5; k++) floodlight(c, -200 + k * 120, 820, [0, -1], 22, 'raceway', `rw:flood${k}`);
  // Marshal posts / distance boards before the big stops (render items).
  for (const [x, z, dx, dz] of [
    [330, 812, 1, 0],
    [280, 812, 1, 0],
    [230, 812, 1, 0],
  ] as const) c.o.items.push({ kind: 'distanceBoard', pos: [x, 0, z + 6], dir: [-dx, -dz], scale: 1, variant: Math.round((380 - x) / 50) - 1 });
}

// ------------------------------------------------------------------ interchange

/**
 * A W-beam guardrail RUN (R-PHYS2 props `guardrail` / `guardrailEnd`, sim/props/defs/guardrail.ts) along
 * [s0, s1] at offset d, rail toward traffic; returns the arc actually covered. The 3.81 m panels are
 * laid as CHORDS of the offset line (3D: each panel's two end columns sit on the line, so neighbours
 * share their ends and the sim lap-splices them into one tension member), tilted with the road's grade
 * (`slope`), standing on the terrain at d (the highest ground under the rail and its posts); the two end panels are `guardrailEnd` (the run's ends cable-anchored).
 */
export const GR_PANEL = 3.81;
/** Height of the rail's centre (its valley row) above a panel's base, m. */
export const GR_RAIL_Y = 0.63;
function softRail(c: Ctx, p: RoadProfile, s0: number, s1: number, d: number, tag: string): number {
  const side = d >= 0 ? 1 : -1;
  // A panel end on the offset line at the highest ground under the rail and the post line behind it
  // (0.36–0.51 m back): no post starts buried (a buried node pops out at several m/s).
  const at = (s: number): readonly [number, number, number] => {
    const f = roadFrame(p, s);
    const x = f.x + f.rx * d;
    const z = f.z + f.rz * d;
    let y = -Infinity;
    for (const b of [0, 0.36, 0.51]) y = Math.max(y, terrainHeight(c.t, x + side * f.rx * b, z + side * f.rz * b));
    return [x, y, z];
  };
  const ends: { s: number; P: readonly [number, number, number] }[] = [{ s: s0, P: at(s0) }];
  const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  for (;;) {
    const a = ends[ends.length - 1]!;
    if (dist(a.P, at(s1)) < GR_PANEL) break;
    // Bisection for the arc point exactly one panel (3D chord) further on.
    let lo = a.s;
    let hi = s1;
    for (let it = 0; it < 48; it++) {
      const m = (lo + hi) / 2;
      if (dist(a.P, at(m)) < GR_PANEL) lo = m;
      else hi = m;
    }
    const sb = (lo + hi) / 2;
    ends.push({ s: sb, P: at(sb) });
  }
  const n = ends.length - 1;
  for (let k = 0; k < n; k++) {
    const A = ends[k]!.P;
    const B = ends[k + 1]!.P;
    const dx = B[0] - A[0];
    const dz = B[2] - A[2];
    const h = Math.hypot(dx, dz);
    const tx = dx / h;
    const tz = dz / h;
    // front (−Z, the rail) faces the carriageway (−side · right), perpendicular to the chord
    const f = roadFrame(p, (ends[k]!.s + ends[k + 1]!.s) / 2);
    let fx = -tz;
    let fz = tx;
    if (fx * -side * f.rx + fz * -side * f.rz < 0) {
      fx = -fx;
      fz = -fz;
    }
    // local +X = (−fz, fx): the slope raises it
    const toB = -fz * tx + fx * tz > 0;
    const slope = Math.round((((toB ? B[1] - A[1] : A[1] - B[1]) / h) || 0) * 1e4) / 1e4;
    // The tilt pivots about the RAIL (GR_RAIL_Y up), not the base: neighbours with different grades then
    // still meet at the splice (a base pivot shifts the rail ends by 0.6 m × Δθ, past the splice reach).
    const cosT = 1 / Math.sqrt(1 + slope * slope);
    const sinT = slope * cosT;
    const ox = GR_RAIL_Y * sinT;
    c.o.props.push({
      id: `w:${tag}:${k}`,
      prop: k === 0 || k === n - 1 ? 'guardrailEnd' : 'guardrail',
      pos: [mm((A[0] + B[0]) / 2 - fz * ox), mm((A[1] + B[1]) / 2 + GR_RAIL_Y * (1 - cosT)), mm((A[2] + B[2]) / 2 + fx * ox)],
      facing: [mm(fx), mm(fz)],
      slope,
    });
  }
  return ends[n]!.s;
}

function interchange(c: Ctx): void {
  // Ramps: soft (deformable) guardrail on the outside of the first 42 m off each terminal, where a
  // car overcooks the ramp curve; rigid armco on the rest.
  for (const id of ['rampNE', 'rampNW', 'rampSW', 'rampSE']) {
    const p = c.prof(id);
    if (!p) continue;
    const d = p.width / 2 + p.shoulder + 0.6;
    // the terminal (racewayRoad end) is the ramp's end for the off-ramps (NE, SW), its start for the on-ramps
    const termAtEnd = id === 'rampNE' || id === 'rampSW';
    const outside = -turnSign(p, termAtEnd ? p.length - 40 : 40);
    for (const side of [-1, 1] as const) {
      const tag = `ix:${id}${side > 0 ? 'R' : 'L'}`;
      if (side === outside) {
        if (termAtEnd) {
          const a = p.length - 25 - 42;
          softRail(c, p, a, p.length - 25, side * d, `${tag}:gr`);
          barrier(c, p, 25, a, side * d, 'armco', tag);
        } else {
          const e = softRail(c, p, 25, 25 + 42, side * d, `${tag}:gr`);
          barrier(c, p, e, p.length - 25, side * d, 'armco', tag);
        }
      } else barrier(c, p, 25, p.length - 25, side * d, 'armco', tag);
    }
  }
  // Raceway Road approaches to the overpass: soft guardrail on both sides.
  const rr = c.prof('racewayRoad');
  if (rr) {
    const proj = (x: number, z: number): number => projectToRoad(rr, x, z, PROJ).s;
    const d = rr.width / 2 + rr.shoulder + 0.5;
    for (const side of [-1, 1] as const) {
      // (to z 570.5 / from z 629.5: clear of the overpass deck's ends at z 572 / 628 — a run's end columns sit on s0 / s1)
      softRail(c, rr, proj(150, 553), proj(150, 570.5), side * d, `ix:rrN${side > 0 ? 'R' : 'L'}`);
      softRail(c, rr, proj(150, 629.5), proj(150, 652), side * d, `ix:rrS${side > 0 ? 'R' : 'L'}`);
    }
  }
  // Overhead gantry signs on the highway ~400 m before each exit (both directions).
  const hw = c.prof('highway');
  if (hw) {
    // (x, z) on the highway ~ 1/4 mile before the exit; `travel` = the approaching traffic's direction
    // along the highway's arc (+1 with increasing s = westbound here).
    for (const [x, z, travel, texts] of [
      [440, 596, 1, ['EXIT 4  MILLBROOK', 'RACEWAY  1/4 MI']],
      [-260, 601, -1, ['EXIT 4  MILLBROOK', 'RACEWAY  1/4 MI']],
    ] as const) {
      const s = projectToRoad(hw, x, z, PROJ).s;
      const f0 = roadFrame(hw, s);
      const f = { ...f0, tx: f0.tx * travel, tz: f0.tz * travel, rx: f0.rx * travel, rz: f0.rz * travel };
      const span = hw.width / 2 + hw.shoulder + 1.2;
      c.o.structures.push({ id: `ix:gantry${x}`, kind: 'gantry', pos: [f.x, f.y, f.z], dir: [f.tx, f.tz], params: { span, clear: 5.6 }, texts: [...texts] });
      for (const sd of [-1, 1]) c.o.colliders.push(box(`w:ix:gantry${x}:${sd > 0 ? 'R' : 'L'}`, [f.x + f.rx * sd * span, null, f.z + f.rz * sd * span], yawQuatDir(f.tx, f.tz), 0.35, 3.6, 0.35, MaterialId.metal, 'pole'));
      c.o.lights.push({ kind: 'sign', pos: [f.x, f.y + 6.6, f.z], dir: [-f.tx, -0.2, -f.tz], color: 0xf0f4ff, intensity: 800, range: 150, angle: 0.6, night: true, area: 'interchange' });
    }
  }
}

// ------------------------------------------------------------------ dragway

function dragway(c: Ctx): void {
  const p = c.prof('dragStrip')!;
  const d = p.width / 2 + 1.2;
  for (const side of [-1, 1] as const) barrier(c, p, 22, p.length - 40, side * d, 'wall', `dr:wall${side > 0 ? 'R' : 'L'}`, undefined, 10);
  const startZ = 330;
  const s0 = projectToRoad(p, 1060, startZ, PROJ).s;
  const f = roadFrame(p, s0);
  // Tree between the lanes, 2 m past the line (the staging beams are on the line).
  const tz = startZ - 2.2;
  c.o.structures.push({ id: 'dr:tree', kind: 'tree', pos: [1060, c.H(1060, tz), tz], dir: [f.tx, f.tz] });
  c.o.colliders.push(cylinder('w:dr:tree', [1060, null, tz], [0, 0, 0, 1], 0.16, 1.8, MaterialId.metal, 'pole'));
  for (const lamp of ['amber', 'green', 'red'] as const) {
    c.o.lights.push({ kind: 'sign', pos: [1060, c.H(1060, tz) + (lamp === 'red' ? 0.9 : lamp === 'green' ? 1.2 : 2.0), tz], dir: [-f.tx, 0, -f.tz], color: lamp === 'red' ? 0xff2a1a : lamp === 'amber' ? 0xffb21a : 0x2aff7a, intensity: 400, range: 40, angle: 0.6, night: false, area: 'dragway' });
  }
  // Start line + lane line + burnout box behind the line.
  paint(c, 'paint', f.x, f.z, [f.rx, f.rz], p.width / 2, 0.12);
  paint(c, 'paintYellow', 1060, startZ - 200, [0, 1], 200, 0.08);
  paint(c, 'patch', 1060, startZ + 22, [0, 1], 9, 7.5);
  // Timing-beam posts (both sides) at 60 / 330 / 660 / 1000 ft and the 1320 ft finish; finish line paint.
  const FT = 0.3048;
  for (const ft of [0, 60, 330, 660, 1000, 1320]) {
    const z = startZ - ft * FT;
    for (const sd of [-1, 1]) c.o.items.push({ kind: 'beamPost', pos: [1060 + sd * (d - 0.8), 0, z], dir: [-sd, 0], scale: 1, variant: ft === 1320 ? 1 : 0 });
    if (ft === 1320) {
      paint(c, 'paint', 1060, z, [1, 0], p.width / 2, 0.15);
      c.o.structures.push({ id: 'dr:finish', kind: 'gantry', pos: [1060, c.H(1060, z), z], dir: [0, -1], params: { span: d + 1.2, clear: 5.4, banner: 1 }, texts: ['FINISH'] });
      for (const sd of [-1, 1]) c.o.colliders.push(box(`w:dr:finish${sd > 0 ? 'R' : 'L'}`, [1060 + sd * (d + 1.2), null, z], [0, 0, 0, 1], 0.3, 3.4, 0.3, MaterialId.metal, 'pole'));
    }
  }
  // Grandstand west of the start area, behind the wall; staging lanes / pits are the dragPits pad.
  grandstand(c, 1036, 300, [1, 0], 30, 12, 'dr:stand');
  building(c, 'tower', 1084, 352, [-1, 0], 4, 4, 9, 3, 'flat', 0xe4e6e8, 0x1f2a36, 0x6a6f74, 'TIMING');
  for (let k = 0; k < 4; k++) floodlight(c, 1046, 300 - k * 130, [1, 0], 18, 'dragway', `dr:flood${k}`);
}

// ------------------------------------------------------------------ proving ground

function provingGround(c: Ctx): void {
  const p = c.prof('runway')!;
  // Hangars on the apron's west edge, doors east.
  for (const [k, z] of [250, 330, 410].entries()) {
    building(c, 'hangar', 721, z, [1, 0], 18, 22, 11, 1, 'barrel', [0xc9ccce, 0xb9bdc0, 0xd4d1c8][k]!, 0x3d4a52, 0x9aa0a6, `HANGAR ${k + 1}`);
  }
  building(c, 'tower', 735, 455, [1, 0], 4.5, 4.5, 16, 4, 'flat', 0xe9e7e1, 0x23262a, 0x6a6f74, 'EASTFIELD');
  // Runway markings: threshold piano keys, designators (blocks), centreline dashes, touchdown bars, edge lines.
  const half = p.width / 2;
  for (const [s, dir] of [
    [40, 1],
    [p.length - 40, -1],
  ] as const) {
    const f = roadFrame(p, s);
    for (let k = 0; k < 8; k++) {
      const d = -half + 1.8 + k * ((p.width - 3.6) / 7);
      if (Math.abs(d) < 2.2) continue;
      paint(c, 'paint', f.x + f.rx * d + f.tx * dir * 15, f.z + f.rz * d + f.tz * dir * 15, [f.tx, f.tz], 15, 0.9);
    }
    // touchdown zone bars at 150 m
    for (const sd of [-1, 1]) {
      const g = roadFrame(p, s + dir * 150);
      paint(c, 'paint', g.x + g.rx * sd * 6, g.z + g.rz * sd * 6, [g.tx, g.tz], 11, 1.5);
      const h = roadFrame(p, s + dir * 300);
      paint(c, 'paint', h.x + h.rx * sd * 6, h.z + h.rz * sd * 6, [h.tx, h.tz], 11, 0.9);
    }
  }
  for (let s = 120; s < p.length - 120; s += 50) {
    const f = roadFrame(p, s);
    paint(c, 'paint', f.x, f.z, [f.tx, f.tz], 15, 0.3);
  }
  for (const sd of [-1, 1]) {
    for (let s = 20; s < p.length - 20; s += 60) {
      const f = roadFrame(p, s + 30);
      paint(c, 'paint', f.x + f.rx * sd * (half - 0.6), f.z + f.rz * sd * (half - 0.6), [f.tx, f.tz], 30, 0.4);
    }
  }
  // Speed trap / brake marker boards and timing posts at the POIs.
  for (const z of [600, 700]) for (const sd of [-1, 1]) c.o.items.push({ kind: 'beamPost', pos: [880 + sd * (half + 3), 0, z], dir: [-sd, 0], scale: 1, variant: 0 });
  for (let k = 0; k < 6; k++) c.o.props.push({ id: `w:pg:cone${k}`, prop: 'cone', pos: [mm(880 - 12 + k * 4.8), null, 760] });
  // Windsock + apron floodlights.
  c.o.items.push({ kind: 'windsock', pos: [915, 0, -600], dir: [1, 0], scale: 1, variant: 0 });
  for (let k = 0; k < 3; k++) floodlight(c, 790, 250 + k * 80, [-1, 0], 18, 'provingGround', `pg:flood${k}`);
}

// ------------------------------------------------------------------ crash lab

function crashLab(c: Ctx): void {
  const X = 760;
  const BZ = -128;
  // Lab hall behind the barrier block (the run-up lane ends at the block face).
  building(c, 'lab', 756, -88, [0, -1], 14, 12, 9, 2, 'flat', 0xe8eaec, 0x1f4f8a, 0x6a6f74, 'CRASH LAB');
  // Rigid barrier: a 4 m wide, 3 m deep reinforced block faced with a steel plate; 1.5 m tall.
  c.o.colliders.push(box('w:cl:barrier', [X, null, BZ + 1.5], [0, 0, 0, 1], 2.0, 0.75, 1.5, MaterialId.concrete, 'crashBarrier'));
  // Offset barrier (40 % overlap face, 1 m wide) to the right of the main lane.
  c.o.colliders.push(box('w:cl:offset', [X + 12, null, BZ + 1.5], [0, 0, 0, 1], 0.8, 0.75, 1.5, MaterialId.concrete, 'crashBarrier'));
  // Side-impact pole: 254 mm rigid steel pole.
  c.o.colliders.push(cylinder('w:cl:pole', [X - 13, null, BZ + 14], [0, 0, 0, 1], 0.127, 2.0, MaterialId.metal, 'crashBarrier'));
  // Sled (moving deformable barrier carriage, parked on its rails).
  c.o.colliders.push(box('w:cl:sled', [784, null, -96], yawQuatDir(-1, 0), 0.85, 0.55, 1.2, MaterialId.metal, 'sled'));
  for (const sd of [-1, 1]) paint(c, 'rail', 784 + 20, -96 + sd * 0.75, [1, 0], 22, 0.06);
  // Target marks: yellow/black impact cross on the approach, high-speed camera towers, floods.
  paint(c, 'paintYellow', X, BZ - 6, [0, 1], 4, 0.1);
  paint(c, 'paintYellow', X, BZ - 6, [1, 0], 2, 0.1);
  for (const sd of [-1, 1]) {
    c.o.items.push({ kind: 'cameraTower', pos: [X + sd * 9, 0, BZ - 10], dir: [-sd, 0], scale: 1, variant: 0 });
    c.o.colliders.push(box(`w:cl:cam${sd > 0 ? 'R' : 'L'}`, [X + sd * 9, null, BZ - 10], [0, 0, 0, 1], 0.5, 2, 0.5, MaterialId.metal, 'pole'));
    c.o.lights.push({ kind: 'flood', pos: [X + sd * 9, c.H(X, BZ) + 4.2, BZ - 10], dir: [-sd * 0.6, -0.4, 0.6], color: 0xffffff, intensity: 80000, range: 40, angle: 0.5, night: false, area: 'crashLab' });
  }
  // Run-up lane: distance boards every 50 m.
  for (let z = -540; z < -170; z += 50) c.o.items.push({ kind: 'distanceBoard', pos: [X + 7.5, 0, z], dir: [-1, 0], scale: 0.8, variant: 3 });
}

// ------------------------------------------------------------------ quarry

function quarry(c: Ctx): void {
  const rng = c.rng;
  // Container stacks (yard): 3 rows × up to 3 high, 40 ft boxes, corrugated, mixed liveries.
  const CONT = [0x8b2a1e, 0x1f4f8a, 0x2f6b3a, 0xc9a24a, 0x6b6f72, 0xb4561e];
  let ci = 0;
  for (let r = 0; r < 3; r++) {
    const levels = r === 1 ? 3 : 2;
    for (let l = 0; l < levels; l++) {
      const x = 575 + (r - 1) * 2.6;
      const z = -1070 + (l === 2 ? 1.5 : 0);
      const y0 = c.H(x, z);
      const y = y0 + 1.3 + l * 2.6;
      c.o.colliders.push(box(`w:q:cont${ci}`, [x, mm(y), z], [0, 0, 0, 1], 1.22, 1.295, 6.06, MaterialId.metal, 'parked'));
      c.o.items.push({ kind: 'container', pos: [x, mm(y - 1.295), z], dir: [0, 1], scale: 1, variant: 0, color: CONT[ci % CONT.length] });
      ci++;
    }
  }
  // two loose containers forming a wall on the course
  for (let k = 0; k < 2; k++) {
    const x = 680 + k * 14;
    const z = -1072;
    c.o.colliders.push(box(`w:q:cont${ci}`, [x, null, z], yawQuatDir(1, 0), 1.22, 1.295, 6.06, MaterialId.metal, 'parked'));
    c.o.items.push({ kind: 'container', pos: [x, 0, z], dir: [1, 0], scale: 1, variant: 0, color: CONT[ci % CONT.length] });
    ci++;
  }
  // Wreck yard: rows of rusting cars (static), a few stacked two high.
  for (let k = 0; k < 14; k++) {
    const row = Math.floor(k / 7);
    const x = 616 + (k % 7) * 4.2;
    const z = -1016 + row * 8;
    const v = Math.floor(rng.float() * 3);
    const len = v === 2 ? 2.7 : v === 1 ? 2.05 : 2.35;
    const sk = (rng.float() - 0.5) * 0.5;
    const sl = Math.sqrt(1 + sk * sk);
    const dir: Vec2 = [mm(sk / sl), mm(1 / sl)];
    c.o.colliders.push(box(`w:q:wreck${k}`, [x, null, z], yawQuatDir(dir[0], dir[1]), 0.9, 0.6, len, MaterialId.metal, 'parked'));
    c.o.items.push({ kind: 'parkedCar', pos: [x, 0, z], dir, scale: 1, variant: v, color: WRECK_PAINTS[k % WRECK_PAINTS.length] });
    c.o.items.push({ kind: 'wreckDamage', pos: [x, 0, z], dir, scale: 1, variant: v });
    if (k % 3 === 0) {
      const y = c.H(x, z) + 1.2 + 0.62;
      c.o.colliders.push(box(`w:q:wreckTop${k}`, [x, mm(y), z], yawQuatDir(dir[1], -dir[0]), 0.9, 0.6, 2.2, MaterialId.metal, 'parked'));
      c.o.items.push({ kind: 'parkedCar', pos: [x, mm(y - 0.62), z], dir: [dir[1], -dir[0]], scale: 1, variant: 0, color: WRECK_PAINTS[(k + 3) % WRECK_PAINTS.length] });
      c.o.items.push({ kind: 'wreckDamage', pos: [x, mm(y - 0.62), z], dir: [dir[1], -dir[0]], scale: 1, variant: 0 });
    }
  }
  // Concrete pipes (1.2 m bore) lying in a row: horizontal cylinders (axis along +X).
  const qPipe: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  for (let k = 0; k < 4; k++) {
    const x = 590;
    const z = -1000 + k * 1.9;
    c.o.colliders.push(cylinder(`w:q:pipe${k}`, [x, mm(c.H(x, z) + 0.75), z], qPipe, 0.75, 1.25, MaterialId.concrete, 'pipe'));
  }
  // Gantry crane over the container stack.
  c.o.structures.push({ id: 'q:crane', kind: 'crane', pos: [610, c.H(610, -1068), -1068], dir: [1, 0], params: { span: 22, height: 16 } });
  for (const sx of [-11, 11]) for (const sz of [-4, 4]) c.o.colliders.push(box(`w:q:craneLeg${sx > 0 ? 'E' : 'W'}${sz > 0 ? 'S' : 'N'}`, [610 + sx, null, -1068 + sz], [0, 0, 0, 1], 0.4, 8, 0.4, MaterialId.metal, 'pole'));
  c.o.lights.push({ kind: 'beacon', pos: [610, c.H(610, -1068) + 17.5, -1068], dir: [0, 1, 0], color: 0xff3020, intensity: 200, range: 400, angle: 0, night: true, area: 'quarry' });
  // Destruction course on the pit floor: barrel walls, box stacks, tyre stacks, a concrete-block chicane, two kicker ramps.
  const P = c.o.props;
  P.push({ id: 'w:q:barrels', prop: 'barrel', pos: [700, null, -1040], row: { count: 10, step: [0, 0.62] } });
  P.push({ id: 'w:q:barrels2', prop: 'barrel', pos: [700.6, null, -1039.7], row: { count: 9, step: [0, 0.62] }, stack: 1 });
  P.push({ id: 'w:q:boxes', prop: 'boxCardboard', pos: [722, null, -1050], row: { count: 6, step: [0, 0.9] }, stack: 3 });
  P.push({ id: 'w:q:crates', prop: 'boxWood', pos: [745, null, -1028], row: { count: 4, step: [1.1, 0] }, stack: 2 });
  P.push({ id: 'w:q:tyres', prop: 'tire', pos: [760, null, -1060], row: { count: 5, step: [0, 0.75] }, stack: 4 });
  P.push({ id: 'w:q:blocksA', prop: 'concreteBlock', pos: [775, null, -1046], row: { count: 4, step: [0, 1.6] } });
  P.push({ id: 'w:q:blocksB', prop: 'concreteBlock', pos: [790, null, -1036], row: { count: 4, step: [0, 1.6] } });
  for (let k = 0; k < 8; k++) P.push({ id: `w:q:cone${k}`, prop: 'cone', pos: [mm(705 + k * 10), null, mm(-1060 + (k % 2) * 6)] });
  c.o.colliders.push({ id: 'w:q:ramp1', kind: 'ramp', pos: [772, null, -1082], quat: yawQuatDir(1, 0), size: [2.5, 0.8, 5], material: MaterialId.concrete, visual: 'ramp' });
  c.o.colliders.push({ id: 'w:q:ramp2', kind: 'ramp', pos: [765, null, -1018], quat: yawQuatDir(-1, 0), size: [2.5, 1.1, 6], material: MaterialId.concrete, visual: 'ramp' });
  // Weighbridge office + workshop at the gate.
  building(c, 'shed', 562, -1018, [1, 0], 4, 3, 3.2, 1, 'shed', 0xc9b48a, 0x5a4632, 0x6e7377, 'WEIGHBRIDGE');
  building(c, 'warehouse', 594, -1085, [0, 1], 12, 9, 8, 1, 'gable', 0x9aa0a6, 0x5a5f63, 0x6e7377, 'NORTHGATE AGGREGATES');
  for (let k = 0; k < 3; k++) floodlight(c, 640 + k * 50, -1092, [0, 1], 18, 'quarry', `q:flood${k}`);
  // Spoil heaps / boulders around the pit rim.
  for (let k = 0; k < 14; k++) {
    const [ux, uz] = ringDir(k, 14);
    const x = 740 + ux * 78;
    const z = -1050 + uz * 58;
    const r = 0.8 + rng.float() * 0.9;
    c.o.items.push({ kind: 'boulder', pos: [mm(x), 0, mm(z)], dir: ringDir(k * 5, 14), scale: mm(r), variant: k % 4 });
    c.o.colliders.push({ id: `w:q:rock${k}`, kind: 'sphere', pos: [mm(x), mm(c.H(x, z) + r * 0.45), mm(z)], quat: [0, 0, 0, 1], size: [mm(r), 0, 0], material: MaterialId.rock, visual: 'lid' });
  }
}

// ------------------------------------------------------------------ off-road park

function offroad(c: Ctx): void {
  const rng = c.rng;
  // Log pile: logs lying across the line of travel, staggered (drive over / crawl).
  for (let k = 0; k < 7; k++) {
    const x = -800 + (k - 3) * 3.2;
    const z = 820 + (k % 2) * 1.5;
    const r = 0.22 + rng.float() * 0.12;
    const qLog: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // axis along Z
    c.o.colliders.push(cylinder(`w:or:log${k}`, [mm(x), mm(c.H(x, z) + r * 0.85), mm(z)], qLog, mm(r), mm(3.2 + rng.float()), MaterialId.wood, 'log'));
  }
  // Rock garden: half-buried boulders of mixed size.
  for (let k = 0; k < 26; k++) {
    const [ux, uz] = discPoint(rng);
    const x = -1080 + ux * 26;
    const z = 1010 + uz * 26;
    const r = 0.5 + rng.float() * 1.1;
    c.o.items.push({ kind: 'boulder', pos: [mm(x), 0, mm(z)], dir: ringDir(k * 7, 26), scale: mm(r), variant: k % 4 });
    c.o.colliders.push({ id: `w:or:rock${k}`, kind: 'sphere', pos: [mm(x), mm(c.H(x, z) + r * 0.35), mm(z)], quat: [0, 0, 0, 1], size: [mm(r), 0, 0], material: MaterialId.rock, visual: 'lid' });
  }
  // Marker posts (orange) around the mud wallows and the water crossing; a tyre-stack kicker.
  for (const [cxp, czp, rad] of [
    [-905, 760, 16],
    [-1060, 870, 18],
    [-830, 935, 14],
    [-758, 940, 30],
  ] as const) {
    for (let k = 0; k < 6; k++) {
      const [ux, uz] = ringDir(k, 6);
      c.o.items.push({ kind: 'markerPost', pos: [mm(cxp + ux * rad), 0, mm(czp + uz * rad)], dir: [1, 0], scale: 1, variant: 0 });
    }
  }
  c.o.props.push({ id: 'w:or:tyres', prop: 'tire', pos: [-940, null, 700], row: { count: 4, step: [0.75, 0] }, stack: 3 });
  building(c, 'shed', -900, 650, [0, 1], 5, 4, 3.4, 1, 'shed', 0x7a5a3a, 0x3d2a1e, 0x5a5f63, 'BADLANDS 4x4');
}

// ------------------------------------------------------------------ rally stage

function rally(c: Ctx): void {
  const p = c.prof('rallyStage')!;
  const rng = c.rng;
  // Tape lines + spectators on the outside of every hairpin (turn tighter than R 30 m), 10 m back.
  let last = -1e9;
  let spot = 0;
  for (let s = 40; s < p.length - 40; s += 5) {
    const a = roadFrame(p, s - 6);
    const b = roadFrame(p, s + 6);
    const cr = a.tx * b.tz - a.tz * b.tx; // ≈ 12 / R
    if (Math.abs(cr) < 12 / 45 || s - last < 100) continue;
    last = s;
    const outside = cr > 0 ? -1 : 1;
    const pts: number[] = [];
    for (let k = -4; k <= 4; k++) {
      const f = roadFrame(p, s + k * 5);
      const d = outside * (p.width / 2 + 8);
      const x = f.x + f.rx * d;
      const z = f.z + f.rz * d;
      pts.push(x, c.H(x, z) + 0.9, z);
      if (k % 2 === 0) c.o.items.push({ kind: 'tapePost', pos: [mm(x), 0, mm(z)], dir: [f.tx, f.tz], scale: 1, variant: 0 });
      if (k > -4 && k < 4 && rng.float() < 0.75) {
        const back = 1.2 + rng.float() * 4;
        const xs = x + f.rx * outside * back;
        const zs = z + f.rz * outside * back;
        c.o.items.push({ kind: 'spectator', pos: [mm(xs), 0, mm(zs)], dir: [-f.rx * outside, -f.rz * outside], scale: mm(0.92 + rng.float() * 0.16), variant: Math.floor(rng.float() * 6), color: [0xc52b22, 0x1f4f8a, 0x2f6b3a, 0xd9a21b, 0x1a1a1c, 0xe9e7e1][Math.floor(rng.float() * 6)] });
      }
    }
    c.o.cables.push({ kind: 'tape', points: pts, sag: 0.08 });
    // chevron boards on the outside, facing the approach (render)
    for (const k of [-1, 0, 1]) {
      const f = roadFrame(p, s + k * 7);
      const d = outside * (p.width / 2 + 3);
      c.o.items.push({ kind: 'chevron', pos: [mm(f.x + f.rx * d), 0, mm(f.z + f.rz * d)], dir: [-f.tx, -f.tz], scale: 1, variant: outside > 0 ? 0 : 1 });
    }
    // a parked spectator car behind the crowd
    if (spot++ % 2 === 0) {
      const f = roadFrame(p, s);
      const d = outside * (p.width / 2 + 16);
      const x = f.x + f.rx * d;
      const z = f.z + f.rz * d;
      c.o.items.push({ kind: 'parkedCar', pos: [mm(x), 0, mm(z)], dir: [f.tx, f.tz], scale: 1, variant: Math.floor(rng.float() * 3), color: WRECK_PAINTS[spot % WRECK_PAINTS.length] });
    }
  }
  // Start + finish arches; split / stop-control boards.
  for (const [id, x, z, text] of [
    ['start', -886, 121, 'STAGE START'],
    ['finish', -172, -1006, 'FLYING FINISH'],
  ] as const) {
    const s = projectToRoad(p, x, z, PROJ).s;
    const f = roadFrame(p, s);
    const span = p.width / 2 + 2.2;
    c.o.structures.push({ id: `ra:${id}`, kind: 'gantry', pos: [f.x, f.y, f.z], dir: [f.tx, f.tz], params: { span, clear: 4.6, banner: 1 }, texts: [text] });
    for (const sd of [-1, 1]) c.o.colliders.push(box(`w:ra:${id}${sd > 0 ? 'R' : 'L'}`, [f.x + f.rx * sd * span, null, f.z + f.rz * sd * span], yawQuatDir(f.tx, f.tz), 0.2, 2.6, 0.2, MaterialId.metal, 'pole'));
  }
}

// ------------------------------------------------------------------ landmarks

function landmarks(c: Ctx, layout: WorldLayout): void {
  const poi = (id: string): [number, number] | null => {
    const q = layout.pois?.find((x) => x.id === id);
    return q ? [q.pos[0], q.pos[2]] : null;
  };
  // Radio mast: 120 m guyed lattice mast with red aviation beacons, guy cables, equipment hut.
  const mast = poi('landmark.radioMast');
  if (mast) {
    const [x, z] = mast;
    const y = c.H(x, z);
    c.o.structures.push({ id: 'lm:mast', kind: 'mast', pos: [x, y, z], dir: [1, 0], params: { height: 120 } });
    c.o.colliders.push(box('w:lm:mast', [x, null, z], [0, 0, 0, 1], 1.0, 3, 1.0, MaterialId.metal, 'pole'));
    for (const h of [40, 80, 120]) c.o.lights.push({ kind: 'beacon', pos: [x, y + h, z], dir: [0, 1, 0], color: 0xff2010, intensity: 2000, range: 3000, angle: 0, night: true, area: 'radioMast' });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      for (const h of [40, 80, 118]) {
        const r = h * 0.55;
        c.o.cables.push({ kind: 'wire', points: [x, y + h, z, x + Math.cos(a) * r, c.H(x + Math.cos(a) * r, z + Math.sin(a) * r) + 0.3, z + Math.sin(a) * r], sag: 0.3 });
      }
    }
    building(c, 'shed', x + 8, z + 6, [0, 1], 3, 2.5, 3, 1, 'flat', 0xb9bdc0, 0x5a5f63, 0x6e7377);
  }
  // Northgate lookout: railing arc on the pad's valley side, benches, coin binoculars.
  const look = poi('landmark.northLookout');
  if (look) {
    const [x, z] = look;
    const pts: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = Math.PI * 0.15 + (k / 10) * Math.PI * 0.7;
      const px = x + Math.cos(a) * 15;
      const pz = z + Math.sin(a) * 15;
      pts.push(px, c.H(px, pz), pz);
    }
    c.o.strips.push({ kind: 'fenceRail', points: pts, width: 0, height: 1.1, side: 1 });
    for (let k = 0; k < 3; k++) c.o.items.push({ kind: 'bench', pos: [x - 6 + k * 6, 0, z + 9], dir: [0, -1], scale: 1, variant: 0 });
    c.o.items.push({ kind: 'binoculars', pos: [x, 0, z + 13], dir: [0, -1], scale: 1, variant: 0 });
  }
  // Hartley Farm: farmhouse, two barns, three silos, machine shed, fenced paddock.
  const silo = poi('landmark.farmSilos');
  if (silo) {
    const [x, z] = silo;
    for (let k = 0; k < 3; k++) {
      const sx = x + k * 7.5;
      const r = k === 2 ? 2.6 : 3.2;
      const h = k === 2 ? 14 : 18;
      c.o.structures.push({ id: `lm:silo${k}`, kind: 'mast', pos: [sx, c.H(sx, z), z], dir: [1, 0], params: { silo: 1, r, height: h } });
      c.o.colliders.push(cylinder(`w:lm:silo${k}`, [sx, null, z], [0, 0, 0, 1], r, h / 2, MaterialId.metal, 'pole'));
    }
    building(c, 'barn', x - 22, z + 26, [1, 0], 9, 15, 6, 1, 'gable', 0x8b2a1e, 0xe9e7e1, 0x5a5f63, 'HARTLEY');
    building(c, 'barn', x + 30, z + 32, [0, -1], 12, 8, 5, 1, 'gable', 0x7a2a22, 0xe9e7e1, 0x6e7377);
    building(c, 'warehouse', x + 6, z - 26, [0, 1], 10, 7, 5, 1, 'shed', 0x9aa0a6, 0x5a5f63, 0x6e7377);
    building(c, 'houseTwoStorey', x - 40, z - 12, [1, 0], 6, 5, 6, 2, 'gable', 0xe9e4da, 0x3d4a52, 0x4a4f53);
    // paddock fence (render) + hay bales (items) + a tractor (parked)
    const fx0 = x - 70;
    const fz0 = z - 60;
    const fpts = [fx0, 0, fz0, fx0 + 50, 0, fz0, fx0 + 50, 0, fz0 + 50, fx0, 0, fz0 + 50, fx0, 0, fz0 + 6];
    c.o.strips.push({ kind: 'fenceRail', points: fpts, width: 0, height: 1.2, side: 1 });
    for (let k = 0; k < 8; k++) c.o.items.push({ kind: 'hayBale', pos: [mm(x + 18 + (k % 4) * 1.6), 0, mm(z + 12 + Math.floor(k / 4) * 1.6)], dir: [1, 0], scale: 1, variant: 0 });
    c.o.colliders.push(box('w:lm:tractor', [x + 14, null, z - 6], yawQuatDir(1, 0.3), 1.1, 1.3, 2.0, MaterialId.metal, 'parked'));
    c.o.items.push({ kind: 'tractor', pos: [x + 14, 0, z - 6], dir: [mm(1 / Math.sqrt(1.09)), mm(0.3 / Math.sqrt(1.09))], scale: 1, variant: 0 });
  }
  // Lakeside campsite: cabins, tents, picnic tables, the campfire (light), a camp store.
  const fire = poi('landmark.campfire');
  if (fire) {
    const [x, z] = fire;
    c.o.items.push({ kind: 'campfire', pos: [x, 0, z], dir: [1, 0], scale: 1, variant: 0 });
    c.o.lights.push({ kind: 'beacon', pos: [x, c.H(x, z) + 0.6, z], dir: [0, 1, 0], color: 0xff8a2a, intensity: 300, range: 14, angle: 0, night: true, area: 'campsite' });
    const sp = c.t.spawns.find((q) => q.id === 'campsite');
    const spawnAt = sp ? ([sp.pos[0], sp.pos[2]] as const) : null;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const tx = x + Math.cos(a) * 12;
      const tz = z + Math.sin(a) * 9;
      if (spawnAt && Math.hypot(tx - spawnAt[0], tz - spawnAt[1]) < 8) continue; // keep the spawn clear
      c.o.items.push({ kind: 'tent', pos: [mm(x + Math.cos(a) * 12), 0, mm(z + Math.sin(a) * 9)], dir: [mm(-Math.cos(a)), mm(-Math.sin(a))], scale: 1, variant: k % 3, color: [0x2f6b3a, 0xd9a21b, 0x1f4f8a, 0xc52b22][k % 4] });
    }
    for (let k = 0; k < 4; k++) c.o.items.push({ kind: 'picnicTable', pos: [x - 14 + k * 5, 0, z - 14], dir: [0, 1], scale: 1, variant: 0 });
    building(c, 'cabin', x + 22, z - 20, [0, 1], 4, 3.5, 3, 1, 'gable', 0x7a5a3a, 0xe9e4da, 0x4a3a2a, 'CAMP STORE');
    building(c, 'cabin', x - 24, z - 22, [0, 1], 3.5, 3, 2.8, 1, 'gable', 0x6b4a30, 0xe9e4da, 0x3d4a52);
    building(c, 'cabin', x - 30, z + 12, [1, 0], 3.5, 3, 2.8, 1, 'gable', 0x6b4a30, 0xe9e4da, 0x3d4a52);
  }
}

// ------------------------------------------------------------------ puddles (render-only decals)

/**
 * Standing water: in the dips of every dirt road (local minima of the profile, 60 % of them),
 * in the gutters of worn town streets, and over the off-road mud wallows. Render-only decals
 * (`puddle`, glossy water material); R-GFX may scale them with rain.
 */
function puddles(c: Ctx): void {
  const o = c.o;
  for (const p of c.t.roads) {
    const dirt = p.surface === 'splat' && (p.material === MaterialId.dirt || p.material === MaterialId.gravel || p.material === MaterialId.mud);
    const worn = p.wear === 'worn' || p.wear === 'patched';
    if (!dirt && !worn) continue;
    if (dirt) {
      for (let s = 12; s < p.length - 12; s += 6) {
        const y = roadFrame(p, s).y;
        if (!(y < roadFrame(p, s - 10).y - 0.04 && y < roadFrame(p, s + 10).y - 0.04)) continue;
        const h = hash01(`pd:${p.id}`, Math.round(s));
        if (h > 0.6) continue;
        const f = roadFrame(p, s);
        const d = (hash01(`pdd:${p.id}`, Math.round(s)) - 0.5) * (p.width * 0.6);
        o.decals.push({ kind: 'puddle', pos: [f.x + f.rx * d, f.y, f.z + f.rz * d], dir: [f.tx, f.tz], hl: 1.2 + h * 3, hw: 0.8 + h * 1.6, variant: Math.floor(h * 40) % 4 });
        s += 14;
      }
    } else {
      for (let s = 20; s < p.length - 20; s += 45) {
        const h = hash01(`pw:${p.id}`, Math.round(s));
        if (h > 0.45) continue;
        const f = roadFrame(p, s);
        const side = h < 0.22 ? 1 : -1;
        const d = side * (p.width / 2 - 0.5);
        o.decals.push({ kind: 'puddle', pos: [f.x + f.rx * d, f.y, f.z + f.rz * d], dir: [f.tx, f.tz], hl: 1.0 + h * 3, hw: 0.45 + h * 0.6, variant: Math.floor(h * 40) % 4 });
      }
    }
  }
  for (const [x, z, r] of [
    [-905, 760, 9],
    [-1060, 870, 11],
    [-830, 935, 7],
  ] as const) {
    for (let k = 0; k < 3; k++) {
      const h = hash01('pm', x * 7 + k);
      o.decals.push({ kind: 'puddle', pos: [x + (h - 0.5) * r, 0, z + (hash01('pmz', x + k) - 0.5) * r], dir: [1, h - 0.5], hl: r * (0.35 + 0.3 * h), hw: r * (0.25 + 0.2 * h), variant: k });
    }
  }
}
