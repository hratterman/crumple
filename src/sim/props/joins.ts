/**
 * Prop-to-prop couplings (R-PHYS2) — WORKER ONLY. Segments placed end to end
 * are joined like the real thing: concrete F-shape barrier segments by their
 * pin-and-loop connections (a steel pin through interlocking loops: some
 * play, then a stiff link that breaks at the pin's shear strength), so a
 * barrier RUN deflects as a chain (FHWA / MASH free-standing temporary
 * barrier: 0.5–1.2 m dynamic deflection at TL-3) instead of segments being
 * punched out one by one.
 *
 * Rule (deterministic, after a spawn batch): for every pair of props of a
 * joinable key, in ascending objectId order, each node of one END of A is
 * paired with the nearest node of an END of B; if every pair is within
 * `reach`, one LINK joint per pair (rest = the current distance) is made.
 */
import { JointKind, type JointSet } from '../trailer/joints';
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
}

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
};

/** Joins every joinable prop pair among `objs` (see the header). Returns the number of joints made. */
export function joinProps(
  joints: JointSet,
  state: SimState,
  objs: readonly { obj: SimObject; key: PropKey; rig: CompiledRig }[],
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
      if (A.key !== B.key) continue;
      const spec = PROP_JOINS[A.key]!;
      if (joints.joints.some((q) => (q.objA === A.obj && q.objB === B.obj) || (q.objA === B.obj && q.objB === A.obj))) continue;
      let done = false;
      for (const ea of spec.ends) {
        if (done) break;
        for (const eb of spec.ends) {
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
          for (const [a, b, d] of pairs) {
            joints.add({ kind: JointKind.link, tag: `join:${A.obj.objectId}:${B.obj.objectId}`, objA: A.obj, nodeA: a, objB: B.obj, nodeB: b, k: spec.k, c: spec.c, rest: d, play: spec.play, breakF: spec.breakF });
            made++;
          }
          done = true;
          break;
        }
      }
    }
  }
  return made;
}
