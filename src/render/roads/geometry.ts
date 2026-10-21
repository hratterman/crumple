/**
 * Ribbon mesher (pure, no three): turns resolved RoadProfiles into chunked,
 * LOD'd vertex/index arrays that sit exactly on the carved terrain.
 *
 * Cross-section per station (u = signed lateral offset, + right of travel):
 *   [-(core+fringe) … -core] [-core … -a] [-a … +a] [a … core] [core … core+fringe]
 *   fringe        verge       carriageway     verge        fringe
 * with a = width/2 and core = a + shoulder − fringeInset (+ curb-return
 * fillet room near junctions where this road yields). Columns at ±a keep
 * the carved cross-section's crease (h = y + bank·clamp(d, ±a)).
 *
 * Every vertex: (x, z) = station + right·u (+ tangent·beyond on end caps),
 * y = sampler.heightAt(x, z) + RIBBON_LIFT_M — the same bilinear surface the
 * tyres collide with — and normal = sampler.normalAt (C0, same as terrain).
 * The outermost fringe row tucks below the terrain (alpha is 0 there).
 *
 * Two index groups share the vertices: [0, coreCount) for the opaque core
 * material and [coreCount, end) for the transparent fringe material. The
 * shader splits them at q = core limit with complementary discards, so the
 * groups overlap geometrically only where needed (no gaps, no double blend).
 */
import {
  RIBBON_LATERAL_STEP_M,
  RIBBON_LIFT_M,
} from '../types';
import {
  ROAD_STATION_SPACING,
  ROAD_STATION_STRIDE,
  RoadStation,
  type RoadProfile,
  type TerrainSampler,
} from '../../world/types';
import { createRoadSample, sampleRoad, structureAt } from '../../world/roads';
import { detectJunctions, evalJunctionField, type JunctionSet } from './junctions';
import { computePassing, type PassingFlags } from './markings';
import type { CentrelineHit } from './spatial';
import { ROAD_STYLE_PARAMS, isRendered, styleForProfile, type RoadStyle } from './styles';

export interface RibbonLod {
  /** Use every k-th station. */
  stationStep: number;
  /** Max lateral spacing across the carriageway, m. */
  carriageStep: number;
  /** Max lateral spacing across the verge, m. */
  vergeStep: number;
  /** Fringe subdivisions per side. */
  fringeSlots: number;
}

export const RIBBON_LODS: readonly RibbonLod[] = [
  { stationStep: 1, carriageStep: RIBBON_LATERAL_STEP_M, vergeStep: 0.75, fringeSlots: 3 },
  { stationStep: 2, carriageStep: 2.5, vergeStep: 1.5, fringeSlots: 2 },
  { stationStep: 4, carriageStep: 8, vergeStep: 4, fringeSlots: 1 },
];
/** Stations per piece (piece ≈ 96 m of arc): the culling / LOD unit. */
export const PIECE_STATIONS = 48;
/** Closed roads scale v so the loop length is a multiple of this (texture/dash continuity). */
export const V_PERIOD_M = 48;
/** The fringe's outer row sits this far BELOW the terrain (tucked, alpha 0). */
export const FRINGE_TUCK_M = 0.04;
/** Lateral reach on the inner side of a bend, as a fraction of its radius. */
export const INNER_REACH = 0.8;

export const ATTR = {
  /** vec2 (u lateral m, v arc m) */
  roadUV: 2,
  /** vec4 (cutDist, markDist, xwDist, jDir) */
  junc: 4,
  /** vec4 (beyond, passR, passL, yieldNear) */
  misc: 4,
  /** float: distance to the curb-return start (edge lines break below 0) */
  mouth: 1,
} as const;

export interface RibbonGeometryData {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  roadUV: Float32Array;
  junc: Float32Array;
  misc: Float32Array;
  mouth: Float32Array;
  index: Uint32Array;
  /** Indices [0, coreCount) = core group, [coreCount, index.length) = fringe group. */
  coreCount: number;
  center: [number, number, number];
  radius: number;
}

export interface RibbonPiece {
  /** Index into RoadRibbons.roads. */
  road: number;
  s0: number;
  s1: number;
  lods: RibbonGeometryData[];
}

export interface RoadRibbonInfo {
  profile: RoadProfile;
  /** Index in TerrainData.roads. */
  terrainIndex: number;
  style: RoadStyle;
  halfWidth: number;
  /** Paved half-width + shoulder (verge outer edge), m. */
  vergeHalf: number;
  /** Opaque/transparent split, m (fillet excluded). */
  coreHalf: number;
  fringe: number;
  fillet: number;
  vScale: number;
  passing: PassingFlags;
}

export interface RoadRibbons {
  roads: RoadRibbonInfo[];
  pieces: RibbonPiece[];
  junctions: JunctionSet;
}

interface Station {
  x: number;
  z: number;
  tx: number;
  tz: number;
  s: number;
  beyond: number;
  passR: number;
  passL: number;
  extra: number;
  /** Signed plan curvature (+ right turn → right side is the inner side). */
  k: number;
}

export function buildRoadRibbons(
  allRoads: readonly RoadProfile[],
  sampler: TerrainSampler,
  lods: readonly RibbonLod[] = RIBBON_LODS,
): RoadRibbons {
  const terrainIdx: number[] = [];
  const profiles: RoadProfile[] = [];
  allRoads.forEach((r, i) => {
    if (isRendered(r) && r.stationCount >= 2) {
      profiles.push(r);
      terrainIdx.push(i);
    }
  });
  const junctions = detectJunctions(profiles);
  const roads: RoadRibbonInfo[] = profiles.map((p, i) => {
    const style = styleForProfile(p);
    const sp = ROAD_STYLE_PARAMS[style];
    const halfWidth = p.width / 2;
    const vergeHalf = halfWidth + p.shoulder;
    const coreHalf = Math.max(halfWidth + 0.1, vergeHalf - sp.fringeInset);
    const vScale = p.closed ? Math.max(1, Math.round(p.length / V_PERIOD_M)) * V_PERIOD_M / p.length : 1;
    return {
      profile: p,
      terrainIndex: terrainIdx[i]!,
      style,
      halfWidth,
      vergeHalf,
      coreHalf,
      fringe: sp.fringe,
      fillet: sp.fillet,
      vScale,
      passing: computePassing(p, style, ROAD_STATION_SPACING),
    };
  });

  const pieces: RibbonPiece[] = [];
  const field = new Float64Array(6);
  const hit: CentrelineHit = { s: 0, d: 0, dist: 0, beyond: 0, seg: 0 };
  const nrm = new Float64Array(3);

  roads.forEach((info, ri) => {
    const p = info.profile;
    const st = p.stations;
    const n = p.stationCount;
    const last = p.closed ? n : n - 1; // virtual station index range [0, last]

    // Fillet room: stations near a junction where this road yields.
    const yieldExtra = new Float64Array(last + 1);
    const partnersYield = junctions.partners[ri]!.filter((q) => q.beatsMe);
    if (partnersYield.length > 0) {
      for (let k = 0; k <= last; k++) {
        const i = k % n;
        const x = st[i * ROAD_STATION_STRIDE + RoadStation.x]!;
        const z = st[i * ROAD_STATION_STRIDE + RoadStation.z]!;
        for (const q of partnersYield) {
          if (Math.hypot(x - q.x, z - q.z) < info.fillet + p.width + profiles[q.other]!.width / 2 + 8) {
            yieldExtra[k] = info.fillet + 0.5;
          }
        }
      }
    }

    const stationAt = (k: number, out: Station): Station => {
      const i = k % n;
      const o = i * ROAD_STATION_STRIDE;
      out.x = st[o + RoadStation.x]!;
      out.z = st[o + RoadStation.z]!;
      out.tx = st[o + RoadStation.tx]!;
      out.tz = st[o + RoadStation.tz]!;
      out.s = k === n - 1 && !p.closed ? p.length : k >= n ? p.length : k * ROAD_STATION_SPACING;
      out.beyond = 0;
      out.passR = info.passing.passR[i]!;
      out.passL = info.passing.passL[i]!;
      out.extra = yieldExtra[k]!;
      out.k = st[o + RoadStation.curvature]!;
      return out;
    };

    const capLen = info.coreHalf + info.fringe + 0.5;
    for (let k0 = 0; k0 < last; k0 += PIECE_STATIONS) {
      const k1 = Math.min(last, k0 + PIECE_STATIONS);
      const piece: RibbonPiece = { road: ri, s0: 0, s1: 0, lods: [] };
      for (const lod of lods) {
        const seq: Station[] = [];
        const step = lod.stationStep;
        const capSteps = Math.max(1, Math.ceil(capLen / (ROAD_STATION_SPACING * step)));
        const caps = junctions.caps[ri]!;
        if (!p.closed && k0 === 0 && caps[0]) {
          const s0 = stationAt(0, mkStation());
          for (let c = capSteps; c >= 1; c--) {
            const e = (capLen * c) / capSteps;
            seq.push({ ...s0, x: s0.x - s0.tx * e, z: s0.z - s0.tz * e, s: -e, beyond: e, k: 0 });
          }
        }
        for (let k = k0; k < k1; k += step) seq.push(stationAt(k, mkStation()));
        seq.push(stationAt(k1, mkStation()));
        if (!p.closed && k1 === last && caps[1]) {
          const s1 = stationAt(last, mkStation());
          for (let c = 1; c <= capSteps; c++) {
            const e = (capLen * c) / capSteps;
            seq.push({ ...s1, x: s1.x + s1.tx * e, z: s1.z + s1.tz * e, s: p.length + e, beyond: e, k: 0 });
          }
        }
        piece.s0 = seq[0]!.s;
        piece.s1 = seq[seq.length - 1]!.s;
        piece.lods.push(buildPieceLod(info, ri, seq, lod, sampler, junctions, profiles, field, hit, nrm));
      }
      pieces.push(piece);
    }
  });
  return { roads, pieces, junctions };
}

function mkStation(): Station {
  return { x: 0, z: 0, tx: 0, tz: 1, s: 0, beyond: 0, passR: 0, passL: 0, extra: 0, k: 0 };
}

/** Lateral column offsets for a station: returns [-(core+fringe) … +(core+fringe)]. */
export function lateralColumns(
  halfWidth: number,
  coreHalf: number,
  fringe: number,
  lod: RibbonLod,
  maxCoreHalf: number,
): Float64Array {
  const nC = Math.max(2, Math.ceil((2 * halfWidth) / lod.carriageStep));
  const nV = Math.max(1, Math.ceil((maxCoreHalf - halfWidth) / lod.vergeStep));
  const nF = Math.max(1, lod.fringeSlots);
  const cols = new Float64Array(2 * (nF + nV) + nC + 1);
  let c = 0;
  for (let i = 0; i < nF; i++) cols[c++] = -(coreHalf + fringe) + (fringe * i) / nF;
  for (let i = 0; i < nV; i++) cols[c++] = -coreHalf + ((coreHalf - halfWidth) * i) / nV;
  for (let i = 0; i <= nC; i++) cols[c++] = -halfWidth + (2 * halfWidth * i) / nC;
  for (let i = 1; i <= nV; i++) cols[c++] = halfWidth + ((coreHalf - halfWidth) * i) / nV;
  for (let i = 1; i <= nF; i++) cols[c++] = coreHalf + (fringe * i) / nF;
  return cols;
}

function buildPieceLod(
  info: RoadRibbonInfo,
  ri: number,
  seq: readonly Station[],
  lod: RibbonLod,
  sampler: TerrainSampler,
  junctions: JunctionSet,
  profiles: readonly RoadProfile[],
  field: Float64Array,
  hit: CentrelineHit,
  nrm: Float64Array,
): RibbonGeometryData {
  let maxExtra = 0;
  for (const s of seq) if (s.extra > maxExtra) maxExtra = s.extra;
  const maxCore = info.coreHalf + maxExtra;
  const cols0 = lateralColumns(info.halfWidth, info.coreHalf, info.fringe, lod, maxCore);
  const nCols = cols0.length;
  const nRows = seq.length;
  const vc = nCols * nRows;
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const roadUV = new Float32Array(vc * 2);
  const junc = new Float32Array(vc * 4);
  const misc = new Float32Array(vc * 4);
  const mouth = new Float32Array(vc);
  const qv = new Float32Array(vc); // radial lateral (caps) for group classification
  const limit = new Float32Array(vc); // core limit at the vertex
  const hasPartners = junctions.partners[ri]!.length > 0;
  // Layout v6: rows inside a bridge span take the deck (profile) height instead of the terrain.
  const prof = profiles[ri]!;
  const halfA = prof.width / 2;
  let deck: Set<number> | null = null;
  const deckY = new Float64Array(nRows);
  const deckBank = new Float64Array(nRows);
  if (prof.structures?.some((st) => st.kind === 'bridge')) {
    const smp = createRoadSample();
    for (let r = 0; r < nRows; r++) {
      const st = structureAt(prof, seq[r]!.s);
      if (!st || st.kind !== 'bridge') continue;
      sampleRoad(prof, seq[r]!.s, smp);
      deck ??= new Set();
      deck.add(r);
      deckY[r] = smp.y;
      deckBank[r] = smp.bank;
    }
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let r = 0; r < nRows; r++) {
    const s = seq[r]!;
    const cols = s.extra > 0 || maxExtra === 0
      ? lateralColumns(info.halfWidth, info.coreHalf + s.extra, info.fringe, lod, maxCore)
      : lateralColumns(info.halfWidth, info.coreHalf, info.fringe, lod, maxCore);
    const rx = -s.tz;
    const rz = s.tx;
    // Never reach past the inner side's centre of curvature (rows would fold).
    const inner = Math.abs(s.k) > 1e-6 ? INNER_REACH / Math.abs(s.k) : Infinity;
    const innerSign = s.k > 0 ? 1 : -1;
    const innerMax = Math.max(Math.abs(cols[0]!), Math.abs(cols[nCols - 1]!));
    const squeeze = innerMax > inner ? inner / innerMax : 1;
    for (let c = 0; c < nCols; c++) {
      let u = cols[c]!;
      if (squeeze < 1 && u * innerSign > 0) u *= squeeze;
      const v = r * nCols + c;
      const x = s.x + rx * u;
      const z = s.z + rz * u;
      const outer = c === 0 || c === nCols - 1;
      let y: number;
      if (deck !== null && deck.has(r)) {
        // Layout v6 bridge span: the deck surface IS the profile (the terrain below is the lake /
        // the road passing under); the content's deck slabs sit exactly here.
        const d = u < -halfA ? -halfA : u > halfA ? halfA : u;
        y = deckY[r]! + deckBank[r]! * d + RIBBON_LIFT_M;
        const nl = Math.sqrt(1 + deckBank[r]! * deckBank[r]!);
        nrm[0] = (deckBank[r]! * rx) / -nl;
        nrm[1] = 1 / nl;
        nrm[2] = (deckBank[r]! * rz) / -nl;
      } else {
        y = sampler.heightAt(x, z) + (outer ? -FRINGE_TUCK_M : RIBBON_LIFT_M);
        sampler.normalAt(x, z, nrm);
      }
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      normals[v * 3] = nrm[0]!;
      normals[v * 3 + 1] = nrm[1]!;
      normals[v * 3 + 2] = nrm[2]!;
      roadUV[v * 2] = u;
      roadUV[v * 2 + 1] = s.s * info.vScale;
      if (hasPartners) {
        evalJunctionField(junctions, profiles, ri, x, z, s.s, field, hit);
      } else {
        field[0] = field[1] = field[2] = field[5] = 64;
        field[3] = field[4] = 0;
      }
      junc[v * 4] = field[0]!;
      junc[v * 4 + 1] = field[1]!;
      junc[v * 4 + 2] = field[2]!;
      junc[v * 4 + 3] = field[3]!;
      misc[v * 4] = s.beyond;
      misc[v * 4 + 1] = s.passR;
      misc[v * 4 + 2] = s.passL;
      misc[v * 4 + 3] = field[4]!;
      mouth[v] = field[5]!;
      qv[v] = s.beyond > 0 ? Math.hypot(u, s.beyond) : Math.abs(u);
      const cut = field[0]!;
      const fil = cut < info.fillet ? filletExtra(info.fillet, Math.max(0, cut)) : 0;
      limit[v] = info.coreHalf + fil;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  const core: number[] = [];
  const fringe: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    // Fully inside the winning road → never visible.
    if (junc[a * 4]! < -0.75 && junc[b * 4]! < -0.75 && junc[c * 4]! < -0.75) return;
    const m = 0.3;
    const inCore = qv[a]! <= limit[a]! + m || qv[b]! <= limit[b]! + m || qv[c]! <= limit[c]! + m;
    const inFringe =
      qv[a]! >= limit[a]! - m || qv[b]! >= limit[b]! - m || qv[c]! >= limit[c]! - m;
    if (inCore) core.push(a, b, c);
    if (inFringe) fringe.push(a, b, c);
  };
  for (let r = 0; r + 1 < nRows; r++) {
    for (let c = 0; c + 1 < nCols; c++) {
      const a = r * nCols + c;
      const b = a + 1;
      const d = a + nCols;
      const e = d + 1;
      // CCW seen from above (+Y): rows advance along +s, columns along +u (right).
      tri(a, b, d);
      tri(b, e, d);
    }
  }
  const index = new Uint32Array(core.length + fringe.length);
  index.set(core, 0);
  index.set(fringe, core.length);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const radius = Math.hypot(maxX - cx, maxY - cy, maxZ - cz);
  return {
    vertexCount: vc,
    positions,
    normals,
    roadUV,
    junc,
    misc,
    mouth,
    index,
    coreCount: core.length,
    center: [cx, cy, cz],
    radius,
  };
}

/** Curb-return widening at distance e (≥ 0) from the winner's edge, radius r. */
export function filletExtra(r: number, e: number): number {
  if (e >= r) return 0;
  const t = r - e;
  return r - Math.sqrt(Math.max(0, r * r - t * t));
}
