/**
 * Traffic cone: 0.7 m tall, 4 kg (heavy rubber base 0.38 m square + PVC
 * shell). Elastic: it folds when run over and mostly springs back; a hard
 * hit yields the shell, only a violent one tears it.
 *
 * Nodes (r = 0.04, inset from the nominal surface):
 *   base_0..3   base square corners: front-left, front-right, rear-right, rear-left
 *   shell_{ring}_{k}  rings 0..2 bottom → top, 4 around (k aligned with base_k)
 *   tip
 */
import { buildPropRig, round, type PropBeamSpec, type PropNodeSpec } from './build';

const R = 0.04;
const BASE_HALF = 0.19 - R;
/** Ring (y, radius) of the shell node centres. */
const RINGS: readonly [number, number][] = [
  [0.09, 0.15 - R * 0.7],
  [0.32, 0.105 - R * 0.7],
  [0.52, 0.065 - R * 0.6],
];
const TIP_Y = 0.7 - R;

function build() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  // Base corners at 45° + 90°k: (−,−), (+,−), (+,+), (−,+) in (x, z).
  const sx = [-1, 1, 1, -1];
  const sz = [-1, -1, 1, 1];
  for (let k = 0; k < 4; k++) {
    nodes.push({ id: `base_${k}`, pos: [sx[k]! * BASE_HALF, R, sz[k]! * BASE_HALF], mass: 0.6 });
  }
  const ringMass = [0.16, 0.12, 0.08];
  RINGS.forEach(([y, rad], ring) => {
    const h = rad * Math.SQRT1_2;
    for (let k = 0; k < 4; k++) {
      nodes.push({ id: `shell_${ring}_${k}`, pos: [round(sx[k]! * h), y, round(sz[k]! * h)], mass: ringMass[ring]! });
    }
  });
  nodes.push({ id: 'tip', pos: [0, TIP_Y, 0], mass: 0.1 });

  const rubber = { yieldStrain: 0.2, breakStrain: 0.9 };
  const shell = { yieldStrain: 0.12, breakStrain: 0.6 };
  for (let k = 0; k < 4; k++) beams.push({ a: `base_${k}`, b: `base_${(k + 1) % 4}`, w: 1.5, ...rubber });
  beams.push({ a: 'base_0', b: 'base_2', w: 1, ...rubber }, { a: 'base_1', b: 'base_3', w: 1, ...rubber });
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    beams.push({ a: `base_${k}`, b: `shell_0_${k}`, w: 1.5, ...rubber });
    beams.push({ a: `base_${k}`, b: `shell_0_${k1}`, ...rubber });
    beams.push({ a: `base_${k1}`, b: `shell_0_${k}`, ...rubber });
  }
  for (let ring = 0; ring < RINGS.length; ring++) {
    for (let k = 0; k < 4; k++) beams.push({ a: `shell_${ring}_${k}`, b: `shell_${ring}_${(k + 1) % 4}`, ...shell });
    beams.push({ a: `shell_${ring}_0`, b: `shell_${ring}_2`, w: 0.6, ...shell });
    beams.push({ a: `shell_${ring}_1`, b: `shell_${ring}_3`, w: 0.6, ...shell });
    if (ring + 1 < RINGS.length) {
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        beams.push({ a: `shell_${ring}_${k}`, b: `shell_${ring + 1}_${k}`, w: 1.2, ...shell });
        beams.push({ a: `shell_${ring}_${k}`, b: `shell_${ring + 1}_${k1}`, w: 0.7, ...shell });
        beams.push({ a: `shell_${ring}_${k1}`, b: `shell_${ring + 1}_${k}`, w: 0.7, ...shell });
      }
    }
  }
  for (let k = 0; k < 4; k++) beams.push({ a: `shell_${RINGS.length - 1}_${k}`, b: 'tip', ...shell });
  return buildPropRig(nodes, beams, { name: 'cone', r: R, friction: 0.9, omegaDt: 0.42, zeta: 0.5 });
}

export const CONE_RIG = build().rig;
