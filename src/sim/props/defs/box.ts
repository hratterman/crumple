/**
 * Box-shaped props (cardboard box, wooden crate, concrete block): 8 corner
 * nodes + 6 face-centre nodes, 55 beams (12 edges, 24 face spokes, 4 body
 * diagonals, 3 face-centre axes, 12 face-centre octahedron edges).
 *
 * Node ids (all inset by r from the nominal surface):
 *   c_k  corner k: x = k&1 ? +X : −X, y = k&2 ? top : bottom, z = k&4 ? +Z (rear) : −Z (front)
 *   f_0 −X, f_1 +X, f_2 bottom, f_3 top, f_4 front (−Z), f_5 rear (+Z)
 */
import { buildPropRig, type PropBeamSpec, type PropNodeSpec, type PropRigOptions } from './build';

export interface BoxPropSpec {
  name: string;
  /** Nominal outer size (x, y, z), m; the base rests on y = 0, centred on x = z = 0. */
  size: [number, number, number];
  /** Contact radius / inset, m. */
  r: number;
  cornerMass: number;
  faceMass: number;
  friction: number;
  omegaDt: number;
  zeta: number;
  /** Strains of the edge + spoke beams (0 = never). */
  yieldStrain: number;
  breakStrain: number;
}

const FACE_AXES: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 1],
  [2, -1],
  [2, 1],
];

export function boxRig(s: BoxPropSpec) {
  const hx = s.size[0] / 2 - s.r;
  const hz = s.size[2] / 2 - s.r;
  const y0 = s.r;
  const y1 = s.size[1] - s.r;
  const cy = (y0 + y1) / 2;
  const nodes: PropNodeSpec[] = [];
  for (let k = 0; k < 8; k++) {
    nodes.push({ id: `c_${k}`, pos: [k & 1 ? hx : -hx, k & 2 ? y1 : y0, k & 4 ? hz : -hz], mass: s.cornerMass });
  }
  const half = [hx, cy - y0, hz];
  FACE_AXES.forEach(([axis, sign], f) => {
    const p: [number, number, number] = [0, cy, 0];
    p[axis] = (axis === 1 ? cy : 0) + sign * half[axis]!;
    nodes.push({ id: `f_${f}`, pos: p, mass: s.faceMass });
  });

  const mat = { yieldStrain: s.yieldStrain, breakStrain: s.breakStrain };
  const beams: PropBeamSpec[] = [];
  // 12 edges: corner pairs differing in one bit.
  for (let k = 0; k < 8; k++) {
    for (const bit of [1, 2, 4]) if ((k & bit) === 0) beams.push({ a: `c_${k}`, b: `c_${k | bit}`, w: 1, ...mat });
  }
  // Face spokes: each face centre to its 4 corners.
  FACE_AXES.forEach(([axis, sign], f) => {
    const bit = axis === 0 ? 1 : axis === 1 ? 2 : 4;
    for (let k = 0; k < 8; k++) {
      if (((k & bit) !== 0) === sign > 0) beams.push({ a: `f_${f}`, b: `c_${k}`, w: 0.8, ...mat });
    }
  });
  // Body diagonals + face-centre axes (keep the box from shearing / the face centres from oil-canning).
  for (let k = 0; k < 4; k++) beams.push({ a: `c_${k}`, b: `c_${7 - k}`, w: 0.5, ...mat });
  for (let f = 0; f < 6; f += 2) beams.push({ a: `f_${f}`, b: `f_${f + 1}`, w: 0.4, ...mat });
  // Octahedron between adjacent face centres: a face centre's spokes are coplanar
  // (no first-order stiffness out of the face), these brace it in 3D.
  for (let f = 0; f < 6; f++) {
    for (let g = f + 1; g < 6; g++) if (g >> 1 !== f >> 1) beams.push({ a: `f_${f}`, b: `f_${g}`, w: 0.3, ...mat });
  }
  const opts: PropRigOptions = { name: s.name, r: s.r, friction: s.friction, omegaDt: s.omegaDt, zeta: s.zeta };
  return buildPropRig(nodes, beams, opts);
}

/** 0.6 m cardboard box, 3 kg: crumples at 2.5 % strain, tears at 30 %. */
export const BOX_CARDBOARD_RIG = boxRig({
  name: 'boxCardboard',
  size: [0.6, 0.6, 0.6],
  r: 0.05,
  cornerMass: 0.25,
  faceMass: 1 / 6,
  friction: 0.6,
  omegaDt: 0.42,
  zeta: 0.4,
  yieldStrain: 0.025,
  breakStrain: 0.3,
}).rig;

/** 0.8 m wooden crate, 25 kg: stiff, yields little (1.5 %), splinters (beams break) at 5 %. */
export const BOX_WOOD_RIG = boxRig({
  name: 'boxWood',
  size: [0.8, 0.8, 0.8],
  r: 0.06,
  cornerMass: 2.25,
  faceMass: 7 / 6,
  friction: 0.6,
  omegaDt: 0.42,
  zeta: 0.3,
  yieldStrain: 0.015,
  breakStrain: 0.05,
}).rig;

/** 1.2 × 0.6 × 0.6 m precast concrete block, 1000 kg: near-rigid, never yields or breaks. */
export const CONCRETE_BLOCK_RIG = boxRig({
  name: 'concreteBlock',
  size: [1.2, 0.6, 0.6],
  r: 0.06,
  cornerMass: 100,
  faceMass: 200 / 6,
  friction: 0.7,
  omegaDt: 0.35,
  zeta: 0.3,
  yieldStrain: 0,
  breakStrain: 0,
}).rig;
