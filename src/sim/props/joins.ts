/**
 * Prop-to-prop couplings (R-PHYS2) — WORKER ONLY. Segments placed end to end
 * are joined like the real thing: concrete F-shape barrier segments by their
 * pin-and-loop connections (a steel pin through interlocking loops: some
 * play, then a stiff link that breaks at the pin's shear strength), so a
 * barrier RUN deflects as a chain (FHWA / MASH free-standing temporary
 * barrier: 0.5–1.2 m dynamic deflection at TL-3) instead of segments being
 * punched out one by one.
 *
 * W-beam guardrail panels by their lap splice (8 bolts: the rail is
 * continuous in tension across the splice, ≈ 400–600 kN): a BALL joint
 * between the coincident end columns, and the two panels do not collide
 * with each other (their end spheres overlap by construction).
 *
 * Rule (deterministic, after a spawn batch): for every pair of props of one
 * join GROUP, in ascending objectId order, each node of one END of A is
 * paired with the nearest node of an END of B; if every pair is within
 * `reach`, one joint per pair (LINK: rest = the current distance; BALL:
 * zero length; a spawn offset beyond its play becomes its play — the panels of a run laid on a
 * changing grade meet within a centimetre, taken up as hole slop at installation, not as preload) is made.
 */
import { JointKind, type JointSet, type JointSpec } from '../trailer/joints';
import type { SimObject, SimState } from '../types';
import type { CompiledRig } from '../rig/types';
import type { PropKey } from './types';

export interface PropJoinSpec {
  /** The two ends' node ids (rig-local). */
  ends: readonly [readonly string[], readonly string[]];
  k: number;
  c: number;
  play: number;
  breakF: number;
  /** Max distance between paired end nodes, m. */
  reach: number;
  /** Joint kind (default link). */
  kind?: 'link' | 'ball';
  /** Keys of one group join each other (default: the key alone). */
  group?: string;
  /** Joined pairs get no node-vs-node contact (`onJoin` is told). */
  exclusive?: boolean;
  /** The joints are axial chain members (trailer/joints.ts: a guardrail's rail rows run through the splice). */
  chain?: boolean;
}

const SPLICE: PropJoinSpec = {
  ends: [
    ['rt0', 'rb0', 'rv0'],
    ['rt16', 'rb16', 'rv16'],
  ],
  // Bolted lap: steel-stiff once the bolts bear; 3 mm of slip in the oversized holes.
  k: 5e8,
  c: 2e3,
  play: 0.003,
  breakF: 3e5,
  reach: 0.05,
  kind: 'ball',
  group: 'guardrail',
  exclusive: true,
  chain: true,
};

export const PROP_JOINS: Readonly<Partial<Record<PropKey, PropJoinSpec>>> = {
  // Pin-and-loop: 2 loop pairs per joint (toe + top), modelled on the 4 end-face corners; a 25 mm pin shears
  // at ≈ 120 kN per connection (≈ 60 kN per link pair).
  jerseyBarrier: {
    ends: [
      ['s0_kL', 's0_kR', 's0_tL', 's0_tR'],
      ['s3_kL', 's3_kR', 's3_tL', 's3_tR'],
    ],
    k: 3e6,
    c: 2e4,
    play: 0.012,
    breakF: 6e4,
    reach: 0.22,
  },
  guardrail: SPLICE,
  guardrailEnd: SPLICE,
};

/** Joins every joinable prop pair among `objs` (see the header). Returns the number of joints made. */
export function joinProps(
  joints: JointSet,
  state: SimState,
  objs: readonly { obj: SimObject; key: PropKey; rig: CompiledRig }[],
  onJoin?: (a: SimObject, b: SimObject, exclusive: boolean, endA: number, endB: number) => void,
): number {
  let made = 0;
  const sorted = [...objs].filter((o) => PROP_JOINS[o.key] !== undefined).sort((a, b) => a.obj.objectId - b.obj.objectId);
  const pos = (o: SimObject, local: number): [number, number, number] => {
    const g = o.nodeStart + local;
    return [state.posX[g]!, state.posY[g]!, state.posZ[g]!];
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const A = sorted[i]!;
      const B = sorted[j]!;
      const spec = PROP_JOINS[A.key]!;
      const specB = PROP_JOINS[B.key]!;
      if ((spec.group ?? A.key) !== (specB.group ?? B.key)) continue;
      if (joints.joints.some((q) => (q.objA === A.obj && q.objB === B.obj) || (q.objA === B.obj && q.objB === A.obj))) continue;
      let done = false;
      for (let ka = 0; ka < spec.ends.length && !done; ka++) {
        const ea = spec.ends[ka]!;
        for (let kb = 0; kb < specB.ends.length; kb++) {
          const eb = specB.ends[kb]!;
          const ia = ea.map((id) => A.rig.nodeIds.indexOf(id));
          const ib = eb.map((id) => B.rig.nodeIds.indexOf(id));
          if (ia.some((x) => x < 0) || ib.some((x) => x < 0)) continue;
          const pairs: [number, number, number][] = [];
          let ok = true;
          for (const a of ia) {
            const pa = pos(A.obj, a);
            let best = -1;
            let bd = Infinity;
            for (const b of ib) {
              const pb = pos(B.obj, b);
              const d = Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2);
              if (d < bd) {
                bd = d;
                best = b;
              }
            }
            if (!(bd <= spec.reach)) {
              ok = false;
              break;
            }
            pairs.push([a, best, bd]);
          }
          if (!ok) continue;
          const kind = spec.kind === 'ball' ? JointKind.ball : JointKind.link;
          for (const [a, b, d] of pairs) {
            const js: JointSpec = { kind, tag: `join:${A.obj.objectId}:${B.obj.objectId}`, objA: A.obj, nodeA: a, objB: B.obj, nodeB: b, k: spec.k, c: spec.c, rest: kind === JointKind.ball ? 0 : d, play: kind === JointKind.ball && d > spec.play ? d : spec.play, breakF: spec.breakF };
            if (spec.chain) js.chain = true;
            joints.add(js);
            made++;
          }
          onJoin?.(A.obj, B.obj, spec.exclusive === true, ka, kb);
          done = true;
          break;
        }
      }
    }
  }
  return made;
}
