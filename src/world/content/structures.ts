/**
 * Bridges + tunnels (layout v6, R-WORLD): colliders, lights, vegetation
 * exclusions and render records from every RoadProfile.structures span.
 *  - bridge: deck slabs (`deckSlab`, top = the profile surface, ≤ 10 m pieces
 *    overlapping 5 cm, 1 m onto each abutment), parapets (`railing`, 1.05 m),
 *    piers (`pier`) just outside every road crossing under the span and at
 *    ≤ 34 m spacing elsewhere, from the ground to the deck soffit.
 *  - tunnel: lining walls + roof (`tunnelWall`, ≤ 8 m pieces), raised service
 *    walkways (`kerb`), invisible `lid` planes over the render-only cover
 *    (8 m tiles wherever the cover stands > 0.3 m above the carved terrain),
 *    lining lights every 9 m on both sides.
 * Generator numerics throughout (the colliders are hashed and installed by the worker).
 */
import { MaterialId } from '../../protocol/messages';
import { createRoadProjection, projectToRoad } from '../roads';
import { quatFromBasis } from '../routes';
import type { ColliderDef, RoadProfile, RoadStructure, TerrainData } from '../types';
import type { ContentExclusion, StructureInstance, WorldLight } from './types';
import { box, mm, pieces, roadBox, roadFrame, roadPoint, yawQuatDir, type Quat } from './util';

export const DECK_DEPTH_M = 1.1;
export const PARAPET_H_M = 1.05;
export const TUNNEL_CLEAR_H_M = 6.4;
export const TUNNEL_WALKWAY_M = 1.0;
const LID_TILE = 8;

export interface StructureOut {
  colliders: ColliderDef[];
  lights: WorldLight[];
  exclusions: ContentExclusion[];
  render: StructureInstance[];
}

function heightAt(t: TerrainData, x: number, z: number): number {
  let fx = (x - t.originX) / t.spacing;
  let fz = (z - t.originZ) / t.spacing;
  fx = fx < 0 ? 0 : fx > t.cols - 1 ? t.cols - 1 : fx;
  fz = fz < 0 ? 0 : fz > t.rows - 1 ? t.rows - 1 : fz;
  let c = Math.floor(fx);
  let r = Math.floor(fz);
  if (c > t.cols - 2) c = t.cols - 2;
  if (r > t.rows - 2) r = t.rows - 2;
  const tx = fx - c;
  const tz = fz - r;
  const i = r * t.cols + c;
  const H = t.heights;
  const a = H[i]! + (H[i + 1]! - H[i]!) * tx;
  const b = H[i + t.cols]! + (H[i + t.cols + 1]! - H[i + t.cols]!) * tx;
  return a + (b - a) * tz;
}

/** s-intervals of [s0, s1] where another road's carriageway + verge (+ margin) passes under. */
function crossings(t: TerrainData, p: RoadProfile, st: RoadStructure, margin: number): [number, number][] {
  const out: [number, number][] = [];
  const proj = createRoadProjection();
  let open = -1;
  for (let s = st.s0; s <= st.s1 + 1e-9; s += 1) {
    const f = roadFrame(p, s);
    let hit = false;
    for (const o of t.roads) {
      if (o.id === p.id) continue;
      projectToRoad(o, f.x, f.z, proj);
      if (proj.dist < o.width / 2 + o.shoulder + margin) {
        hit = true;
        break;
      }
    }
    if (hit && open < 0) open = s;
    if (!hit && open >= 0) {
      out.push([open, s - 1]);
      open = -1;
    }
  }
  if (open >= 0) out.push([open, st.s1]);
  return out;
}

function bridge(t: TerrainData, p: RoadProfile, st: RoadStructure, o: StructureOut): void {
  const half = p.width / 2 + p.shoulder;
  const pre = `w:br:${st.id}`;
  // Deck slabs (1 m onto each abutment) and parapets.
  pieces(st.s0 - 1, st.s1 + 1, 10, (sa, sb, k) => {
    o.colliders.push(roadBox(`${pre}:d${k}`, p, sa, sb, 0, 0, DECK_DEPTH_M, half + 0.6, 0.05, MaterialId.concrete, 'deckSlab'));
  });
  for (const side of [-1, 1] as const) {
    pieces(st.s0 - 1, st.s1 + 1, 10, (sa, sb, k) => {
      o.colliders.push(roadBox(`${pre}:p${side > 0 ? 'R' : 'L'}${k}`, p, sa, sb, side * (half + 0.3), PARAPET_H_M, PARAPET_H_M + 0.2, 0.25, 0.03, MaterialId.concrete, 'railing'));
    });
  }
  // Piers: just outside every road passing under, then evenly ≤ 34 m apart, ≥ 5 m from the abutments.
  const cross = crossings(t, p, st, 1.5);
  const at: number[] = [];
  for (const [a, b] of cross) {
    if (a - 0.6 > st.s0 + 5) at.push(a - 0.6);
    if (b + 0.6 < st.s1 - 5) at.push(b + 0.6);
  }
  const free: [number, number][] = [];
  let cur = st.s0;
  for (const [a, b] of cross) {
    if (a > cur) free.push([cur, a]);
    cur = b > cur ? b : cur;
  }
  if (st.s1 > cur) free.push([cur, st.s1]);
  for (const [a, b] of free) {
    const n = Math.floor((b - a) / 34);
    for (let k = 1; k <= n; k++) at.push(a + ((b - a) * k) / (n + 1));
  }
  at.sort((u, v) => u - v);
  at.forEach((s, k) => {
    const f = roadFrame(p, s);
    const soffit = f.y - DECK_DEPTH_M;
    const g = Math.min(heightAt(t, f.x - f.rx * half * 0.6, f.z - f.rz * half * 0.6), heightAt(t, f.x + f.rx * half * 0.6, f.z + f.rz * half * 0.6)) - 1.5;
    if (!(soffit - g > 1.5)) return;
    const q = yawQuatDir(f.tx, f.tz);
    o.colliders.push(box(`${pre}:pier${k}`, [f.x, (soffit + g) / 2, f.z], q, half * 0.82, (soffit - g) / 2, 0.55, MaterialId.concrete, 'pier'));
  });
  o.render.push({ id: st.id, kind: 'bridge', road: p.id, s0: st.s0, s1: st.s1, params: { half, deck: DECK_DEPTH_M, parapet: PARAPET_H_M } });
  // Deck lighting: lamp standards on alternating parapets every 30 m (overpass: one each side).
  pieces(st.s0, st.s1, 30, (sa, sb, k) => {
    const s = (sa + sb) / 2;
    const side = k % 2 === 0 ? 1 : -1;
    const f = roadFrame(p, s);
    const head = roadPoint(p, s, side * (half - 1.2), 9.2);
    o.lights.push({ kind: 'street', pos: [mm(head[0]), mm(head[1]), mm(head[2])], dir: [mm(-f.rx * side * 0.25), -0.97, mm(-f.rz * side * 0.25)], color: 0xffd9a8, intensity: 11000, range: 30, angle: 1.05, night: true });
  });
}

function tunnel(t: TerrainData, p: RoadProfile, st: RoadStructure, o: StructureOut): void {
  const half = p.width / 2 + p.shoulder;
  const pre = `w:tn:${st.id}`;
  const wallD = half + TUNNEL_WALKWAY_M + 0.4;
  for (const side of [-1, 1] as const) {
    const tag = side > 0 ? 'R' : 'L';
    pieces(st.s0, st.s1, 8, (sa, sb, k) => {
      o.colliders.push(roadBox(`${pre}:w${tag}${k}`, p, sa, sb, side * wallD, TUNNEL_CLEAR_H_M, TUNNEL_CLEAR_H_M + 1.5, 0.4, 0.03, MaterialId.concrete, 'tunnelWall'));
      o.colliders.push(roadBox(`${pre}:k${tag}${k}`, p, sa, sb, side * (half + TUNNEL_WALKWAY_M / 2), 0.22, 0.6, TUNNEL_WALKWAY_M / 2, 0.03, MaterialId.concrete, 'kerb'));
    });
  }
  pieces(st.s0, st.s1, 8, (sa, sb, k) => {
    o.colliders.push(roadBox(`${pre}:roof${k}`, p, sa, sb, 0, TUNNEL_CLEAR_H_M + 1.0, 1.0, wallD + 0.4, 0.03, MaterialId.concrete, 'tunnelWall'));
  });
  // Lights: two rows high on the lining, every 9 m.
  pieces(st.s0, st.s1, 9, (sa, sb) => {
    const s = (sa + sb) / 2;
    for (const side of [-1, 1] as const) {
      const pt = roadPoint(p, s, side * (wallD - 0.6), TUNNEL_CLEAR_H_M - 0.5);
      const f = roadFrame(p, s);
      o.lights.push({ kind: 'tunnel', pos: [mm(pt[0]), mm(pt[1]), mm(pt[2])], dir: [mm(-f.rx * side * 0.5), -0.87, mm(-f.rz * side * 0.5)], color: 0xffe6b8, intensity: 2500, range: 14, angle: 1.2, night: false, area: 'northgateTunnel' });
    }
  });
  // Vegetation stays off the cover (the scatter sees the carved trench, the renderer the ridge).
  const a = roadFrame(p, st.s0);
  const b = roadFrame(p, st.s1);
  const cx = (a.x + b.x) / 2;
  const cz = (a.z + b.z) / 2;
  let ax = b.x - a.x;
  let az = b.z - a.z;
  const L = Math.sqrt(ax * ax + az * az);
  ax /= L;
  az /= L;
  o.exclusions.push({ cx, cz, ax, az, hx: L / 2 + 4, hz: half + 64, detail: true });
  o.render.push({ id: st.id, kind: 'tunnel', road: p.id, s0: st.s0, s1: st.s1, params: { half, wall: wallD, clear: TUNNEL_CLEAR_H_M } });
  // Lids over the cover.
  const cover = t.covers?.find((c) => c.id === st.id);
  if (!cover) return;
  const ch = (c: number, r: number): number => cover.heights[r * cover.cols + c]!;
  const carved = (c: number, r: number): number => t.heights[(cover.row0 + r) * t.cols + cover.col0 + c]!;
  let k = 0;
  for (let r = 0; r + LID_TILE < cover.rows; r += LID_TILE) {
    for (let c = 0; c + LID_TILE < cover.cols; c += LID_TILE) {
      const h00 = ch(c, r);
      const h10 = ch(c + LID_TILE, r);
      const h01 = ch(c, r + LID_TILE);
      const h11 = ch(c + LID_TILE, r + LID_TILE);
      if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) continue;
      const lift = Math.max(h00 - carved(c, r), h10 - carved(c + LID_TILE, r), h01 - carved(c, r + LID_TILE), h11 - carved(c + LID_TILE, r + LID_TILE));
      if (lift < 0.3) continue;
      const S = LID_TILE * t.spacing;
      // Plane through the mean of the corners, normal from the diagonals.
      const gx = (h10 - h00 + h11 - h01) / (2 * S);
      const gz = (h01 - h00 + h11 - h10) / (2 * S);
      let nx = -gx;
      let ny = 1;
      let nz = -gz;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      // local X = world X tilted into the plane, local Y = normal, local Z = X × Y.
      let xx = 1 - nx * nx;
      let xy = -nx * ny;
      let xz = -nx * nz;
      const xl = Math.sqrt(xx * xx + xy * xy + xz * xz);
      xx /= xl;
      xy /= xl;
      xz /= xl;
      const zx = xy * nz - xz * ny;
      const zy = xz * nx - xx * nz;
      const zz = xx * ny - xy * nx;
      const q: Quat = [0, 0, 0, 1];
      quatFromBasis(xx, xy, xz, nx, ny, nz, zx, zy, zz, q);
      const x0 = t.originX + (cover.col0 + c) * t.spacing;
      const z0 = t.originZ + (cover.row0 + r) * t.spacing;
      const cy = (h00 + h10 + h01 + h11) / 4;
      o.colliders.push({
        id: `${pre}:lid${k++}`,
        kind: 'plane',
        pos: [mm(x0 + S / 2), mm(cy), mm(z0 + S / 2)],
        quat: q,
        size: [mm((S / 2) * Math.sqrt(1 + gx * gx) + 0.05), 0, mm((S / 2) * Math.sqrt(1 + gz * gz) + 0.05)],
        material: MaterialId.rock,
        visual: 'lid',
      });
    }
  }
}

/** Every bridge / tunnel span of every road, layout order. */
export function buildStructures(t: TerrainData): StructureOut {
  const o: StructureOut = { colliders: [], lights: [], exclusions: [], render: [] };
  for (const p of t.roads) {
    for (const st of p.structures ?? []) {
      if (st.kind === 'bridge') bridge(t, p, st, o);
      else tunnel(t, p, st, o);
    }
  }
  return o;
}
