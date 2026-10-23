/**
 * R-RIG: suspension members (pure generator, not a hot loop).
 *
 * R-PHYS's suspension is a link model: each control arm is one or two stiff beams from the upright (a wheel hub
 * node or the knuckle top `kU`) to subframe pivot nodes, the subframe a frame of stiff beams between those
 * pivots, and the hardpoints are those nodes. The HD rig keeps every link beam and node as tuned (K&C, rates)
 * and builds the PARTS around them, two-scale like the rail members (member.ts):
 *   A-arms     each arm leg (upright → pivot) a box tube of real arm steel (S500MC 3 mm, 50 × 30 mm), its end
 *              rings welded to the leg's end nodes and the pivot ring also to the arm's OTHER pivot — that
 *              node lies on the arm's hinge axis, so the tie never resists suspension travel, and the upright
 *              end is tied to the ball-joint node alone (it never resists steer / camber), yet the tube cannot
 *              spin about its own axis;
 *   subframe   the arm mount rails and straight cross members (`isSubframeMember`) as 60 × 50 mm, 2.5 mm HSLA
 *              boxes, tied to their end nodes and to the subframe node farthest off their axis at each end
 *              (the subframe is one rigid frame).
 * Single links (toe links, the steering tie rod — a hydro whose length IS the steering) get no tube: a tube
 * would resist the steering, and a lone 2-force link has no hinge axis to anchor its spin.
 * The walls are light (≈ 1.5 kg per arm leg) and stability-budget stiff, so they add < 1 % to a link's
 * stiffness: K&C unchanged (validation: realism/kcBench.ts standard vs HD); in a crash the link beams yield
 * and the walls fold / bend with them.
 */
import type { CompiledVehicle, VehicleDef } from '../../vehicle/types';
import { buildMember, type BoxMemberSpec, type BuiltMember } from './member';

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));
const unit = (a: readonly number[]): V3 => {
  const l = norm(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

export const SUSPENSION_ARM = { width: 0.05, height: 0.03, grade: 'S500MC', gauge: 0.003, pitch: 0.1 } as const;
export const SUSPENSION_SUBFRAME = { width: 0.06, height: 0.05, grade: 'HSLA340', gauge: 0.0025, pitch: 0.12, minLength: 0.3 } as const;
const UPRIGHT = /^(knuckle|wheelHub)$/;

/**
 * Which subframe links are real members (station-lattice ids `<corner>_lp<i>`): an arm's mount rail (`lp0`–`lp1`
 * of one corner) and the straight cross members (`FL_lpi`–`FR_lpi`). The X braces, the rack / toe-link pivot
 * links and the upper-pivot links are the model's bracing of separate brackets, not parts.
 */
function isSubframeMember(a: string, b: string): boolean {
  const ma = /^([FR])([LR])_lp(\d)$/.exec(a);
  const mb = /^([FR])([LR])_lp(\d)$/.exec(b);
  if (!ma || !mb || ma[1] !== mb[1]) return false;
  return ma[2] === mb[2] ? ma[3] !== mb[3] : ma[3] === mb[3];
}

/** The suspension members of a standard def (ids `q_<id>_<row>_<corner>`); each with its extra anchor ties. */
export function suspensionMembers(base: VehicleDef, cv: CompiledVehicle, posOf: (id: string) => readonly number[]): BuiltMember[] {
  const rig = cv.rig;
  const idx = new Map<string, number>();
  rig.nodeIds.forEach((id, i) => idx.set(id, i));
  const group = (id: string): string => (idx.has(id) ? (rig.groups[rig.nodeGroup[idx.get(id)!]!] ?? '') : '');
  const neighbours = new Map<string, Set<string>>();
  for (const b of base.body.beams) {
    if (!neighbours.has(b.a)) neighbours.set(b.a, new Set());
    if (!neighbours.has(b.b)) neighbours.set(b.b, new Set());
    neighbours.get(b.a)!.add(b.b);
    neighbours.get(b.b)!.add(b.a);
  }
  // A-arm legs: upright node → its normal links to subframe pivots; exactly two = an A-arm
  const legs = new Map<string, string[]>();
  for (const b of base.body.beams) {
    if (b.type !== 'normal') continue;
    const [u, p] = UPRIGHT.test(group(b.a)) && group(b.b) === 'subframe' ? [b.a, b.b] : UPRIGHT.test(group(b.b)) && group(b.a) === 'subframe' ? [b.b, b.a] : [null, null];
    if (!u || !p) continue;
    if (!legs.has(u)) legs.set(u, []);
    legs.get(u)!.push(p);
  }
  const out: BuiltMember[] = [];
  const tube = (id: string, a: string, b: string, sec: { width: number; height: number; grade: string; gauge: number; pitch: number }, anchors: [string | null, string | null]): void => {
    const pa = posOf(a);
    const pb = posOf(b);
    const axis = unit(sub(pb, pa));
    const up: V3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const spec: BoxMemberSpec = { id, prefix: 'q', stations: [[a], [b]], width: sec.width, height: sec.height, inward: unit(cross(axis, up)), grade: sec.grade, gauge: sec.gauge, pitch: sec.pitch };
    const m = buildMember(spec, posOf);
    const rows = m.nodes.length / 4;
    anchors.forEach((anchor, end) => {
      if (!anchor) return;
      const j = end === 0 ? 0 : rows - 1;
      for (let q = 0; q < 4; q++) m.beams.push({ a: `q_${id}_${j}_${q}`, b: anchor, kind: 'tie', w: 1.5, soft: 1 });
    });
    m.chain = [...new Set([...m.chain, ...anchors.filter((x): x is string => !!x)])];
    out.push(m);
  };
  for (const [u, ps] of [...legs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (ps.length !== 2) continue;
    ps.forEach((p, k) => tube(`${u}-${p}`, p, u, SUSPENSION_ARM, [ps[1 - k]!, null]));
  }
  // subframe members: both ends subframe, long enough to be a member (not a pivot bracket)
  const seen = new Set<string>();
  for (const b of base.body.beams) {
    if (b.type !== 'normal' || group(b.a) !== 'subframe' || group(b.b) !== 'subframe') continue;
    if (!isSubframeMember(b.a, b.b)) continue;
    const key = [b.a, b.b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const pa = posOf(b.a);
    const pb = posOf(b.b);
    if (norm(sub(pb, pa)) < SUSPENSION_SUBFRAME.minLength) continue;
    const axis = unit(sub(pb, pa));
    const anchorOf = (end: string, other: string): string | null => {
      let best: string | null = null;
      let bestD = 0.05;
      for (const n of neighbours.get(end) ?? []) {
        if (n === other || group(n) !== 'subframe') continue;
        const d = sub(posOf(n), posOf(end));
        const off = norm(sub(d, axis.map((c) => c * dot(d, axis))));
        if (off > bestD) [best, bestD] = [n, off];
      }
      return best;
    };
    tube(`${b.a}-${b.b}`, b.a, b.b, SUSPENSION_SUBFRAME, [anchorOf(b.a, b.b), anchorOf(b.b, b.a)]);
  }
  return out;
}
