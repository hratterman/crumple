/**
 * R-RIG: sheet-metal skins (pure generator, not a hot loop).
 *
 * A SkinPanelData grid becomes a sheet of light nodes (real areal mass:
 * gauge × density) with
 *  - in-plane MEMBRANE beams: the grid edges + both diagonals of every quad
 *    (X-braced: shear-rigid and achiral);
 *  - out-of-plane BENDING beams: every second node along each grid line
 *    (i−1 → i+1, j−1 → j+1). On the crowned (curved) body panels they carry
 *    the sheet's bending to first order, so a pushed panel dents locally and
 *    holds its crown instead of folding like cloth;
 *  - SEAMS to the structure the render panel rests on (SkinPanelData.attach):
 *    every boundary node is joined to its two nearest attach nodes (spot-weld
 *    seam / hem / bolts / adhesive: SeamKind sets the tear strain), and
 *    interior nodes get one soft standoff to the nearest attach node within
 *    SkinSpec.standoff (door inner panel, anti-flutter mastic, roof bows).
 * Stiffness: every sheet node splits its stability budget (ω·dt target) over
 * its beams by weight; a seam takes the sheet side's share (the frame side
 * is re-budgeted by the refine step). Sheets yield at SKIN_YIELD_STRAIN
 * (dents set), tear at SKIN_TEAR_RATIO × that force (only fast, gross
 * stretching reaches it through the plastic ratchet's rate overshoot), and
 * seams break elastically at their kind's strain — load sheds to the
 * neighbouring welds, so a seam unzips as a group.
 */
import { sheetMass } from './materials';
import type { SeamKind, SkinPanelData, SkinSpec } from './types';

export const SKIN_YIELD_STRAIN = 0.015;
export const SKIN_TEAR_RATIO = 30;
export const SKIN_ZETA = 0.3;
/** Beam weights in a sheet node's budget. */
export const SKIN_W = { edge: 1, diagonal: 0.5, bending: 0.4, seam: 1.2, standoff: 0.3 } as const;
/** Seam tear strain (elastic, stretch / rest length) by kind. */
export const SEAM_TEAR_STRAIN: Readonly<Record<SeamKind, number>> = { weld: 0.45, hem: 0.6, bolt: 0.8, glue: 0.3 };
/** Seam partners of every second boundary node (the others get one), and the shortest / longest seam beam, m. */
export const SEAM_PARTNERS = 2;
export const SEAM_MIN_LEN = 0.03;
export const SEAM_MAX_LEN = 0.6;

export type SkinBeamKind = 'edge' | 'diagonal' | 'bending' | 'seam' | 'standoff';

export interface SkinBeam {
  a: string;
  b: string;
  kind: SkinBeamKind;
  w: number;
}

export interface BuiltSkin {
  panel: string;
  prefix: string;
  ids: string[];
  pos: [number, number, number][];
  mass: number[];
  beams: SkinBeam[];
  seam: SeamKind;
  /** Collision / render triangles as node ids, CCW from outside. */
  tris: [string, string, string][];
}

const dist3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * Builds one sheet. `attachPos` = rest positions of the candidate attach
 * nodes (backbone ids → position). Nodes / beams in a fixed order.
 */
export function buildSkin(data: SkinPanelData, spec: SkinSpec, attachPos: ReadonlyMap<string, readonly number[]>): BuiltSkin {
  const prefix = spec.prefix ?? `k_${data.id}`;
  const n = data.pos.length / 3;
  const ids: string[] = [];
  const pos: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    ids.push(`${prefix}_${i}`);
    pos.push([data.pos[3 * i]!, data.pos[3 * i + 1]!, data.pos[3 * i + 2]!]);
  }
  // node masses: triangle-area shares scaled to the sampled outer area
  const share = new Float64Array(n);
  let triArea = 0;
  for (let t = 0; t < data.tris.length; t += 3) {
    const [a, b, c] = [data.tris[t]!, data.tris[t + 1]!, data.tris[t + 2]!];
    const e1 = [pos[b]![0] - pos[a]![0], pos[b]![1] - pos[a]![1], pos[b]![2] - pos[a]![2]];
    const e2 = [pos[c]![0] - pos[a]![0], pos[c]![1] - pos[a]![1], pos[c]![2] - pos[a]![2]];
    const ar = 0.5 * Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!);
    triArea += ar;
    share[a]! += ar / 3;
    share[b]! += ar / 3;
    share[c]! += ar / 3;
  }
  const areal = sheetMass(spec.grade, spec.gauge);
  const scale = triArea > 0 ? data.area / triArea : 1;
  const mean = (data.area * areal) / n;
  // floor at 40 % of the mean so corner nodes keep a usable stiffness budget
  const mass = Array.from(share, (s) => Math.max(0.4 * mean, s * scale * areal));
  const fix = (data.area * areal) / mass.reduce((x, y) => x + y, 0);
  for (let i = 0; i < n; i++) mass[i] = mass[i]! * fix;

  const beams: SkinBeam[] = [];
  const seen = new Set<string>();
  const add = (a: number | string, b: number | string, kind: SkinBeamKind): void => {
    const ia = typeof a === 'number' ? ids[a]! : a;
    const ib = typeof b === 'number' ? ids[b]! : b;
    if (ia === ib) return;
    const k = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
    if (seen.has(k)) return;
    seen.add(k);
    beams.push({ a: ia, b: ib, kind, w: SKIN_W[kind] });
  };
  // membrane: triangle edges (the quad split diagonal is a 'diagonal')
  const quadDiag = new Set<string>();
  for (let q = 0; q < data.quads.length; q += 4) {
    const [a, b, c, d] = [data.quads[q]!, data.quads[q + 1]!, data.quads[q + 2]!, data.quads[q + 3]!];
    quadDiag.add(a < c ? `${a},${c}` : `${c},${a}`);
    quadDiag.add(b < d ? `${b},${d}` : `${d},${b}`);
  }
  for (let t = 0; t < data.tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = data.tris[t + e]!;
      const b = data.tris[t + ((e + 1) % 3)]!;
      add(a, b, quadDiag.has(a < b ? `${a},${b}` : `${b},${a}`) ? 'diagonal' : 'edge');
    }
  }
  for (let q = 0; q < data.quads.length; q += 4) add(data.quads[q + 1]!, data.quads[q + 3]!, 'diagonal');
  // bending: i−1 → i+1 and j−1 → j+1 through a node, when both links are membrane edges
  const adj = new Map<number, Set<number>>();
  for (const bm of beams) {
    if (bm.kind !== 'edge') continue;
    const a = Number(bm.a.slice(prefix.length + 1));
    const b = Number(bm.b.slice(prefix.length + 1));
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  const I = (k: number): number => data.ij[2 * k]!;
  const J = (k: number): number => data.ij[2 * k + 1]!;
  for (let m = 0; m < n; m++) {
    const nb = [...(adj.get(m) ?? [])].sort((x, y) => x - y);
    for (const [di, dj] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const fwd = nb.find((q) => I(q) - I(m) === di && J(q) - J(m) === dj);
      const back = nb.find((q) => I(m) - I(q) === di && J(m) - J(q) === dj);
      if (fwd !== undefined && back !== undefined) add(back, fwd, 'bending');
    }
  }
  // seams: boundary nodes → nearest attach nodes; standoffs: interior → nearest attach within reach
  const cand = [...attachPos.entries()];
  const nearest = (p: readonly number[], count: number, maxLen: number): string[] =>
    cand
      .map(([id, q]) => [id, dist3(p, q)] as const)
      .filter(([, d]) => d >= SEAM_MIN_LEN && d <= maxLen)
      .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, count)
      .map(([id]) => id);
  const isEdge = new Uint8Array(n);
  for (const e of data.edge) isEdge[e] = 1;
  // checkerboard by grid parity: every boundary node gets one seam, half of them a second (a spot-weld
  // pitch of ~1.5 sheet cells); half of the interior nodes get a standoff
  for (let i = 0; i < n; i++) {
    const even = (I(i) + J(i)) % 2 === 0;
    if (isEdge[i]) for (const id of nearest(pos[i]!, even ? SEAM_PARTNERS : 1, SEAM_MAX_LEN)) add(i, id, 'seam');
    else if (even && (spec.standoff ?? 0) > 0) for (const id of nearest(pos[i]!, 1, spec.standoff!)) add(i, id, 'standoff');
  }
  const tris: [string, string, string][] = [];
  for (let t = 0; t < data.tris.length; t += 3) tris.push([ids[data.tris[t]!]!, ids[data.tris[t + 1]!]!, ids[data.tris[t + 2]!]!]);
  return { panel: data.id, prefix, ids, pos, mass, beams, seam: spec.seam, tris };
}
