/**
 * Junction analysis for the ribbon mesher (pure). TerrainData carries no
 * junction list, so junctions are recovered geometrically from the resolved
 * centrelines (the layout guarantees roads meet only at junctions, within
 * 1 m of the junction point).
 *
 * Who yields: at each junction a road that passes THROUGH beats a road that
 * starts/ends there (a branch); then higher kind priority wins; then the
 * earlier-declared road. The loser's ribbon is discarded inside the winner's
 * carriageway (per-fragment, from an interpolated signed distance), gets a
 * curb-return fillet, a stop line and fading markings; the winner keeps a
 * continuous surface and breaks its edge line across the loser's mouth.
 */
import type { RoadProfile } from '../../world/types';
import { createCentrelineIndex, type CentrelineHit, type CentrelineIndex } from './spatial';
import { kindPriority, ROAD_STYLE_PARAMS, styleForProfile } from './styles';

export type JunctionRole = 'through' | 'branch';

export interface JunctionMember {
  /** Index into the road list given to detectJunctions. */
  road: number;
  /** Arc distance of the junction on this road. */
  s: number;
  role: JunctionRole;
}

export interface RoadJunction {
  x: number;
  z: number;
  members: JunctionMember[];
}

export interface Partner {
  other: number;
  junction: number;
  /** True when `other` wins (this road yields to it). */
  beatsMe: boolean;
  /** This road's arc distance at the junction. */
  sMine: number;
  x: number;
  z: number;
}

/** Plan distance under which two centrelines are considered to meet. */
const CONTACT_DIST = 2.0;
/** A junction this close (arc) to an open road's end makes it a branch there. */
const BRANCH_END_TOL = 8;
/** Contacts closer than this merge into one junction. */
const MERGE_DIST = 10;
/** Vertices farther than this from a junction ignore it. */
export const JUNCTION_RADIUS = 48;

export interface JunctionSet {
  readonly junctions: readonly RoadJunction[];
  readonly partners: readonly (readonly Partner[])[];
  readonly indices: readonly CentrelineIndex[];
  /**
   * Per road: [start, end] get a round end cap. Open ends get one unless the
   * road WINS a junction there (it ends square; the yielding road's own cap
   * covers the outer corner of the turn). Closed roads: none.
   */
  readonly caps: readonly (readonly [boolean, boolean])[];
}

export function roleAt(p: RoadProfile, s: number): JunctionRole {
  if (p.closed) return 'through';
  return s < BRANCH_END_TOL || p.length - s < BRANCH_END_TOL ? 'branch' : 'through';
}

/** True when road a beats road b at a junction (b yields). Declaration order = list order. */
export function beats(
  roads: readonly RoadProfile[],
  a: JunctionMember,
  b: JunctionMember,
): boolean {
  const ra = a.role === 'through' ? 1 : 0;
  const rb = b.role === 'through' ? 1 : 0;
  if (ra !== rb) return ra > rb;
  const pa = kindPriority(roads[a.road]!.kind);
  const pb = kindPriority(roads[b.road]!.kind);
  if (pa !== pb) return pa > pb;
  return a.road < b.road;
}

export function detectJunctions(roads: readonly RoadProfile[]): JunctionSet {
  const indices = roads.map((r) => createCentrelineIndex(r));
  const hit: CentrelineHit = { s: 0, d: 0, dist: 0, beyond: 0, seg: 0 };
  interface Contact {
    x: number;
    z: number;
    a: number;
    sa: number;
    b: number;
    sb: number;
  }
  const contacts: Contact[] = [];
  for (let a = 0; a < roads.length; a++) {
    for (let b = 0; b < roads.length; b++) {
      if (a === b) continue;
      const pb = roads[b]!;
      const st = pb.stations;
      const stride = st.length / pb.stationCount;
      let run: Contact | null = null;
      let runBest = Infinity;
      const flush = (): void => {
        if (run) contacts.push(run);
        run = null;
        runBest = Infinity;
      };
      for (let i = 0; i < pb.stationCount; i++) {
        const x = st[i * stride]!;
        const z = st[i * stride + 2]!;
        if (indices[a]!.nearest(x, z, CONTACT_DIST, hit) && hit.beyond < 1) {
          if (hit.dist < runBest) {
            runBest = hit.dist;
            run = { x, z, a, sa: hit.s, b, sb: indices[b]!.stationS(i) };
          }
        } else flush();
      }
      flush();
    }
  }
  const junctions: RoadJunction[] = [];
  for (const c of contacts) {
    let j = junctions.find((q) => Math.hypot(q.x - c.x, q.z - c.z) < MERGE_DIST);
    if (!j) {
      j = { x: c.x, z: c.z, members: [] };
      junctions.push(j);
    }
    for (const [road, s] of [
      [c.a, c.sa],
      [c.b, c.sb],
    ] as const) {
      if (!j.members.some((m) => m.road === road)) {
        j.members.push({ road, s, role: roleAt(roads[road]!, s) });
      }
    }
  }
  for (const j of junctions) j.members.sort((m, n) => m.road - n.road);

  const partners: Partner[][] = roads.map(() => []);
  junctions.forEach((j, ji) => {
    for (const m of j.members) {
      for (const o of j.members) {
        if (o === m) continue;
        partners[m.road]!.push({
          other: o.road,
          junction: ji,
          beatsMe: beats(roads, o, m),
          sMine: m.s,
          x: j.x,
          z: j.z,
        });
      }
    }
  });
  const caps = roads.map((r, i): [boolean, boolean] => {
    if (r.closed) return [false, false];
    const winsAt = (atStart: boolean): boolean => {
      const ps = partners[i]!.filter((p) => (atStart ? p.sMine < BRANCH_END_TOL : r.length - p.sMine < BRANCH_END_TOL));
      return ps.length > 0 && ps.every((p) => !p.beatsMe);
    };
    return [!winsAt(true), !winsAt(false)];
  });
  return { junctions, partners, indices, caps };
}

/**
 * Per-vertex junction field. out = [cutDist, markDist, xwDist, jDir, yieldNear, mouth]:
 *  - cutDist: signed plan distance to the nearest WINNING road's carriageway
 *    (negative inside → fragment discarded);
 *  - markDist: same over every partner (markings break inside / near it);
 *  - xwDist: lateral-only distance to that partner's carriageway edge
 *    (crosswalk/stop-line bands run parallel to it);
 *  - jDir: +1 / −1 = the yield junction lies ahead / behind in arc (stop-line
 *    lane side), 0 when this road does not yield there;
 *  - yieldNear: 1 within JUNCTION_RADIUS of a junction where this road
 *    yields (depth priority over the winner's verge);
 *  - mouth: distance to where curb returns begin — the yielding road's
 *    fillet radius is subtracted, so edge lines on BOTH roads stop exactly
 *    where the curb return starts.
 * Values clamp to ±FAR when nothing is near.
 */
export const FIELD_FAR = 64;

export function evalJunctionField(
  set: JunctionSet,
  roads: readonly RoadProfile[],
  road: number,
  x: number,
  z: number,
  s: number,
  out: Float64Array,
  hit: CentrelineHit,
): void {
  let cut = FIELD_FAR;
  let mark = FIELD_FAR;
  let xw = FIELD_FAR;
  let jDir = 0;
  let yieldNear = 0;
  let mouth = FIELD_FAR;
  const myFillet = ROAD_STYLE_PARAMS[styleForProfile(roads[road]!)].fillet;
  for (const p of set.partners[road]!) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz > JUNCTION_RADIUS * JUNCTION_RADIUS) continue;
    const o = roads[p.other]!;
    const half = o.width / 2;
    if (p.beatsMe) yieldNear = 1;
    if (!set.indices[p.other]!.nearest(x, z, FIELD_FAR, hit)) continue;
    // Square ends where the partner has no cap (box distance), round otherwise.
    const capped = hit.beyond > 0 && set.caps[p.other]![hit.s <= 0 ? 0 : 1]!;
    const ex = Math.abs(hit.d) - half;
    const sd = hit.beyond > 0 && !capped
      ? ex > 0 ? Math.sqrt(ex * ex + hit.beyond * hit.beyond) : hit.beyond
      : hit.dist - half;
    if (p.beatsMe && sd < cut) cut = sd;
    const m = sd - (p.beatsMe ? myFillet : ROAD_STYLE_PARAMS[styleForProfile(o)].fillet);
    if (m < mouth) mouth = m;
    if (sd < mark) {
      mark = sd;
      xw = Math.abs(hit.d) - half;
      let ds = p.sMine - s;
      const self = roads[road]!;
      if (self.closed) {
        if (ds > self.length / 2) ds -= self.length;
        else if (ds < -self.length / 2) ds += self.length;
      }
      jDir = p.beatsMe ? (ds >= 0 ? 1 : -1) : 0;
    }
  }
  out[0] = Math.max(-FIELD_FAR, Math.min(FIELD_FAR, cut));
  out[1] = Math.max(-FIELD_FAR, Math.min(FIELD_FAR, mark));
  out[2] = Math.max(-FIELD_FAR, Math.min(FIELD_FAR, xw));
  out[3] = jDir;
  out[4] = yieldNear;
  out[5] = Math.max(-FIELD_FAR, Math.min(FIELD_FAR, mouth));
}
