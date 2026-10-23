/**
 * R-RIG: closed-section members (pure generator, not a hot loop).
 *
 * A member is a thin-walled BOX SECTION (4 corner nodes per station) built
 * around a chain of backbone stations — a standard rail's low / high pair
 * (`rl`, `rh`), a sill node, a pillar node — at `pitch`, with
 *   per station  4 ring edges + 2 ring diagonals (the section holds its shape until it folds),
 *   per segment  4 longitudinal edges + 1 shear diagonal per face, the
 *                diagonal's direction alternating segment to segment
 *                (folds alternate in / out; the member is achiral),
 * CRUSH INITIATORS (beads) inside `beadSpan`: alternate rings ±`beads` in
 * section size and the beaded segments 15 % weaker, so axial crush folds the
 * walls ring by ring from the front (accordion) instead of buckling the
 * member as a whole.
 *
 * TWO-SCALE MODEL (why a SLEEVE, not a replacement). At dt = 1/2000 s a
 * node's Σk/m is capped (ω·dt ≤ 0.5): refining a member by n stations at
 * the same mass makes it ~n² softer axially, so a 6 cm-pitch crash can
 * built from its own steel (0.1 kg corners) is ~20× softer than the standard
 * rig's tuned can beams and would spring back like rubber. So the backbone's
 * coarse load path (heavy lumped nodes, stability-limited but tuned to the
 * crash targets) keeps carrying the crash force, and the member's walls are
 * a light sheet-metal box carried by the backbone station nodes (each major
 * ring tied to its station by short welds): as the stations close in, the
 * walls fold progressively between them — the fine-scale geometry of the
 * crush. Wall mass is the real steel (gauge × perimeter × length); the walls
 * yield at SKIN_YIELD_STRAIN like the sheets. A smaller dt (R-CORE) would let
 * the walls carry the load path themselves (budget ∝ 1/dt²).
 */
import { grade, tubeCrushForce } from './materials';
import { SKIN_TEAR_RATIO } from './skin';

export interface BoxMemberSpec {
  id: string;
  /** Backbone stations along the member: 1–2 node ids each (one section edge, or the section centre). */
  stations: readonly (readonly string[])[];
  /** Section width (across, toward `inward`) and height, m. */
  width: number;
  height: number;
  /** Direction the section's width extends from the station edge (the car's centre for a right-side member). */
  inward: readonly [number, number, number];
  grade: string;
  gauge: number;
  pitch: number;
  beads?: number;
  beadSpan?: readonly [number, number];
  /** Also build the mirror member (ids with _R ↔ _L swapped, inward x negated). */
  mirror?: boolean;
  /** Node-id prefix (default 'm': `m_<id>_<row>_<corner>`; suspension members use 'q'). */
  prefix?: string;
}

export type MemberBeamKind = 'long' | 'ring' | 'ringDiag' | 'shear' | 'tie';
export interface MemberBeam {
  a: string;
  b: string;
  kind: MemberBeamKind;
  /** Weight in the endpoint nodes' stiffness budget. */
  w: number;
  /** Bead segments yield earlier. */
  soft: number;
}

export interface BuiltMember {
  id: string;
  nodes: { id: string; pos: [number, number, number]; mass: number }[];
  beams: MemberBeam[];
  /** Backbone node ids the member is carried by. */
  chain: string[];
  /** Section mean crush force (Abramowicz–Jones), N — reported; the backbone carries the load path. */
  crushForce: number;
  /** Outer faces (collision / debug): 2 triangles per face per segment. */
  tris: [string, string, string][];
}

export const MEMBER_W: Readonly<Record<MemberBeamKind, number>> = { long: 2, ring: 1, ringDiag: 0.7, shear: 0.7, tie: 1.5 };
/**
 * Member walls set at the standard rig's bumper-class yield strain (2.5 %; crash class 1.8 %), so a
 * 10 km/h bump stays elastic like the backbone it wraps.
 */
export const MEMBER_YIELD_STRAIN = 0.025;
export const MEMBER_TEAR_RATIO = SKIN_TEAR_RATIO;
const BEAD_SOFTEN = 0.85;

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]): number => Math.sqrt(dot(a, a));
const unit = (a: readonly number[]): V3 => scale(a, 1 / (len(a) || 1));
const lerp = (a: readonly number[], b: readonly number[], t: number): V3 => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
export const beamKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The mirror image spec (R ↔ L). */
export function mirrorMember(m: BoxMemberSpec): BoxMemberSpec {
  const swap = (id: string): string => id.replace(/_R$/, '_#').replace(/_L$/, '_R').replace(/_#$/, '_L');
  return {
    ...m,
    id: m.id.replace(/R$/, '#').replace(/L$/, 'R').replace(/#$/, 'L'),
    stations: m.stations.map((s) => s.map(swap)),
    inward: [-m.inward[0], m.inward[1], m.inward[2]],
    mirror: false,
  };
}

export function buildMember(spec: BoxMemberSpec, posOf: (id: string) => readonly number[]): BuiltMember {
  const S = spec.stations;
  if (S.length < 2) throw new Error(`member ${spec.id}: needs ≥ 2 stations`);
  const cen = S.map((st) => st.map(posOf).reduce((a, p) => add(a, scale(p, 1 / st.length)), [0, 0, 0] as V3));
  // section frame per major station: axis a, across n (toward `inward`), up e
  const major: V3[][] = S.map((st, i) => {
    const axis = unit(sub(cen[Math.min(i + 1, S.length - 1)]!, cen[Math.max(i - 1, 0)]!));
    let e: V3;
    let base: V3;
    let h: number;
    if (st.length === 2) {
      const p0 = posOf(st[0]!);
      const p1 = posOf(st[1]!);
      e = unit(sub(p1, p0));
      base = p0 as V3;
      h = len(sub(p1, p0));
    } else {
      const up0: V3 = [0, 1, 0];
      e = unit(sub(up0, scale(axis, dot(up0, axis))));
      h = spec.height;
      base = sub(cen[i]!, scale(e, h / 2));
    }
    let n = sub(spec.inward, scale(axis, dot(spec.inward, axis)));
    n = unit(sub(n, scale(e, dot(n, e))));
    // the section straddles the station edge: half its width outboard
    const o = sub(base, scale(n, spec.width / 2));
    return [o, add(o, scale(e, h)), add(add(o, scale(e, h)), scale(n, spec.width)), add(o, scale(n, spec.width))];
  });
  const rows: V3[][] = [];
  const rowT: number[] = [];
  const rowMajor: number[] = [];
  const segLen: number[] = [];
  for (let i = 0; i + 1 < S.length; i++) segLen.push(len(sub(cen[i + 1]!, cen[i]!)));
  const total = segLen.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < S.length; i++) {
    rows.push(major[i]!);
    rowT.push(acc / total);
    rowMajor.push(i);
    if (i + 1 === S.length) break;
    const L = segLen[i]!;
    const n = Math.max(0, Math.ceil(L / spec.pitch) - 1);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      rows.push(major[i]!.map((c, q) => lerp(c, major[i + 1]![q]!, t)));
      rowT.push((acc + t * L) / total);
      rowMajor.push(-1);
    }
    acc += L;
  }
  const beads = spec.beads ?? 0;
  const span = spec.beadSpan ?? [0, 1];
  const beaded = rows.map((_, j) => beads > 0 && rowMajor[j]! < 0 && rowT[j]! >= span[0] - 1e-9 && rowT[j]! <= span[1] + 1e-9);
  rows.forEach((row, j) => {
    if (!beaded[j]) return;
    const sgn = j % 2 === 0 ? 1 : -1;
    const c = row.reduce((a, q) => add(a, scale(q, 0.25)), [0, 0, 0] as V3);
    rows[j] = row.map((q) => add(c, scale(sub(q, c), 1 + sgn * beads)));
  });

  const width = spec.width;
  const height = len(sub(rows[0]![1]!, rows[0]![0]!));
  const g = grade(spec.grade);
  const perimeter = 2 * (width + height);
  const ids = rows.map((_, j) => [0, 1, 2, 3].map((q) => `${spec.prefix ?? 'm'}_${spec.id}_${j}_${q}`));
  const nodes: BuiltMember['nodes'] = [];
  rows.forEach((row, j) => {
    const before = j > 0 ? len(sub(rows[j]![0]!, rows[j - 1]![0]!)) : 0;
    const after = j + 1 < rows.length ? len(sub(rows[j + 1]![0]!, rows[j]![0]!)) : 0;
    const m = (g.density * spec.gauge * perimeter * (before + after)) / 2 / 4;
    row.forEach((p, q) => nodes.push({ id: ids[j]![q]!, pos: p.map(r4) as V3, mass: m }));
  });
  const beams: MemberBeam[] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string, kind: MemberBeamKind, soft = 1): void => {
    const k = beamKey(a, b);
    if (a === b || seen.has(k)) return;
    seen.add(k);
    beams.push({ a, b, kind, w: MEMBER_W[kind], soft });
  };
  rows.forEach((_, j) => {
    const r = ids[j]!;
    const soft = beaded[j] ? BEAD_SOFTEN : 1;
    for (let q = 0; q < 4; q++) push(r[q]!, r[(q + 1) % 4]!, 'ring', soft);
    push(r[0]!, r[2]!, 'ringDiag', soft);
    push(r[1]!, r[3]!, 'ringDiag', soft);
    if (j + 1 === rows.length) return;
    const nx = ids[j + 1]!;
    const segSoft = beaded[j] || beaded[j + 1] ? BEAD_SOFTEN : 1;
    for (let q = 0; q < 4; q++) push(r[q]!, nx[q]!, 'long', segSoft);
    for (let q = 0; q < 4; q++) {
      const q1 = (q + 1) % 4;
      if (j % 2 === 0) push(r[q]!, nx[q1]!, 'shear', segSoft);
      else push(r[q1]!, nx[q]!, 'shear', segSoft);
    }
  });
  // ties: every corner of a major ring to the station's backbone nodes (welded to the station)
  rows.forEach((_, j) => {
    const i = rowMajor[j]!;
    if (i < 0) return;
    for (const q of [0, 1, 2, 3]) for (const b of S[i]!) push(ids[j]![q]!, b, 'tie');
  });
  const tris: [string, string, string][] = [];
  for (let j = 0; j + 1 < rows.length; j++)
    for (let q = 0; q < 4; q++) {
      const q1 = (q + 1) % 4;
      tris.push([ids[j]![q]!, ids[j + 1]![q]!, ids[j + 1]![q1]!], [ids[j]![q]!, ids[j + 1]![q1]!, ids[j]![q1]!]);
    }
  return { id: spec.id, nodes, beams, chain: [...new Set(S.flat())], crushForce: tubeCrushForce(spec.grade, spec.gauge, width, height), tris };
}
