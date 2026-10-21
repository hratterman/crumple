/**
 * Breakable posts (sign post, street light).
 *
 * STRUCTURE: a triangular steel truss (3 nodes per level, X-braced faces)
 * with few, long bays: in an explicit 2 kHz sim a node of mass m carries at
 * most Σk ≈ (ω/dt)²·m, so the truss's bending stiffness EI ≈ k·L·1.5ρ² grows
 * with the bay length L and the triangle radius ρ; a fine truss of light
 * nodes buckled under its own weight. Between the levels sit SPINE nodes on
 * the centreline (contact radius = the column's radius) so a bumper cannot
 * slip between two levels; each hangs on a tripod to its nearest level and
 * is linked to its neighbour.
 *
 * ANCHOR: PINNED anchor nodes (mass 0 → never move, collidable false) in a
 * wider triangle at the base, tied to level 0 and strutted to higher levels
 * by anchor beams with breakF = PropAnchor.breakF and no yield: a hard
 * enough hit snaps them (beamBreak events) and the post falls as a free
 * soft body. Anchor beams are invisible and never collide (beams have no
 * contact), so the struts work like a buried, braced foundation.
 *
 * Triangle node k of a level (tri()): 0 front (x = 0, −Z), 1 rear-right,
 * 2 rear-left: the post is symmetric about the YZ plane (an asymmetric
 * section twisted the long, shear-soft bays sideways under the arm's
 * weight). Ids: `${prefix}${level}_${k}`; spine `${prefix}s${j}` bottom →
 * top, s0 = the BASE CENTRE (on the axis at level 0's height: the frame
 * origin, with forward = level-0 node 0 exactly −Z of it).
 */
import { buildPropRig, ringPoint, type PropBeamSpec, type PropNodeSpec } from './build';

/** Anchor beam break forces, N (PropAnchor.breakF). */
export const SIGN_POST_ANCHOR_BREAK_F = 15_000;
export const LIGHT_POLE_ANCHOR_BREAK_F = 40_000;

interface PostSpec {
  prefix: string;
  /** Level node-centre heights, bottom → top. */
  levels: number[];
  /** Triangle circumradius per level. */
  rho: number[];
  /** Node mass per level (each of the 3). */
  levelMass: number[];
  /** Spine heights per bay (bay b between levels b and b+1; ascending). */
  spine: number[][];
  spineMass: number;
  /** Node contact radius (inset). */
  r: number;
}

function tri(prefix: string, level: number, radius: number, y: number, mass: number, nodes: PropNodeSpec[]): void {
  for (let k = 0; k < 3; k++) nodes.push({ id: `${prefix}${level}_${k}`, pos: ringPoint(radius, y, k, 3), mass });
}

/** Adds the column's nodes and beams. */
function column(p: PostSpec, nodes: PropNodeSpec[], beams: PropBeamSpec[], steel: Partial<PropBeamSpec>): void {
  p.levels.forEach((y, l) => tri(p.prefix, l, p.rho[l]!, y, p.levelMass[l]!, nodes));
  const base = `${p.prefix}s0`;
  nodes.push({ id: base, pos: [0, p.levels[0]!, 0], mass: p.spineMass });
  let j = 1;
  const spineIds: string[][] = p.spine.map((bay, b) =>
    bay.map((y) => {
      const t = (y - p.levels[b]!) / (p.levels[b + 1]! - p.levels[b]!);
      const rho = p.rho[b]! + (p.rho[b + 1]! - p.rho[b]!) * t;
      const id = `${p.prefix}s${j++}`;
      nodes.push({ id, pos: [0, y, 0], mass: p.spineMass, r: Math.round((rho + p.r) * 1e6) / 1e6 });
      return id;
    }),
  );
  const L = (l: number, k: number) => `${p.prefix}${l}_${k}`;
  const stiffBase = { breakF: 60_000, deform: 0 };
  for (let k = 0; k < 3; k++) beams.push({ a: base, b: L(0, k), w: 0.3, ...stiffBase });
  beams.push({ a: base, b: spineIds[0]![0]!, w: 0.3, ...stiffBase });
  // Section rings and spine links are short: a strain-based yield would be a few hundred N
  // there, so they stay elastic (force-limited by the rails, which do yield) and break high.
  const stiff = { breakF: 60_000, deform: 0 };
  for (let l = 0; l < p.levels.length; l++) {
    for (let k = 0; k < 3; k++) beams.push({ a: L(l, k), b: L(l, (k + 1) % 3), w: 0.3, ...stiff });
  }
  for (let l = 0; l + 1 < p.levels.length; l++) {
    for (let k = 0; k < 3; k++) {
      const k1 = (k + 1) % 3;
      beams.push({ a: L(l, k), b: L(l + 1, k), w: 1, ...steel });
      beams.push({ a: L(l, k), b: L(l + 1, k1), w: 0.35, ...steel });
      beams.push({ a: L(l, k1), b: L(l + 1, k), w: 0.35, ...steel });
    }
    // Spine: lower half hangs on the level below, upper half on the level above, chained.
    const ids = spineIds[l] ?? [];
    ids.forEach((id, s) => {
      const lev = s < ids.length / 2 ? l : l + 1;
      for (let k = 0; k < 3; k++) beams.push({ a: id, b: L(lev, k), w: 0.3, ...stiff });
      if (s + 1 < ids.length) beams.push({ a: id, b: ids[s + 1]!, w: 0.3, ...stiff });
    });
  }
}

function anchors(radius: number, y: number, nodes: PropNodeSpec[]): void {
  // Anchors at 60°, 180°, 300°: anchor k faces the post edge between nodes k and k+1.
  for (let k = 0; k < 3; k++) nodes.push({ id: `anchor_${k}`, pos: ringPoint(radius, y, k, 3, Math.PI / 3), mass: 0 });
}

/**
 * Anchor k ties to the two post nodes flanking it on level 0 and struts to
 * the same pair on each `strutLevels` level. Never yields; snaps at breakF.
 */
function anchorBeams(prefix: string, beams: PropBeamSpec[], breakF: number, strutLevels: number[]): void {
  const strut = { breakF, deform: 0 };
  for (let k = 0; k < 3; k++) {
    const p = k;
    const q = (k + 1) % 3;
    for (const l of [0, ...strutLevels]) {
      const w = l === 0 ? 0.8 : 0.6;
      beams.push({ a: `anchor_${k}`, b: `${prefix}${l}_${p}`, w, ...strut });
      beams.push({ a: `anchor_${k}`, b: `${prefix}${l}_${q}`, w, ...strut });
    }
  }
}

// ------------------------------------------------------------------ sign post
const SP_R = 0.04;
/** Sign plate corner rows (node centres) and plate plane. */
const SIGN_YB = 2.04;
const SIGN_YT = 2.6 - SP_R;
const SIGN_Z = -0.12;
const SIGN_HALF = 0.3 - SP_R;

function buildSignPost(name: 'signPost' | 'stopSign' = 'signPost') {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const steel = { yieldStrain: 0.015, breakStrain: 0.1 };
  // 2.6 m galvanised post ≈ 12 kg + 0.6 m aluminium sign with brackets ≈ 4.4 kg.
  column(
    {
      prefix: 'post_',
      levels: [SP_R, 1.3, SIGN_YT],
      rho: [0.06, 0.06, 0.06],
      levelMass: [1.4, 1.2, 1.0],
      spine: [
        [0.45, 0.88],
        [1.72, 2.14],
      ],
      spineMass: 0.4,
      r: SP_R,
    },
    nodes,
    beams,
    steel,
  );
  nodes.push({ id: 'sign_0', pos: [-SIGN_HALF, SIGN_YB, SIGN_Z], mass: 0.8 });
  nodes.push({ id: 'sign_1', pos: [SIGN_HALF, SIGN_YB, SIGN_Z], mass: 0.8 });
  nodes.push({ id: 'sign_2', pos: [SIGN_HALF, SIGN_YT, SIGN_Z], mass: 0.8 });
  nodes.push({ id: 'sign_3', pos: [-SIGN_HALF, SIGN_YT, SIGN_Z], mass: 0.8 });
  nodes.push({ id: 'sign_c', pos: [0, (SIGN_YB + SIGN_YT) / 2, SIGN_Z], mass: 1.2 });
  anchors(0.22, SP_R, nodes);

  const plate = { yieldStrain: 0.01, breakStrain: 0.12 };
  for (let k = 0; k < 4; k++) beams.push({ a: `sign_${k}`, b: `sign_${(k + 1) % 4}`, w: 0.6, ...plate });
  for (let k = 0; k < 4; k++) beams.push({ a: `sign_${k}`, b: 'sign_c', w: 0.6, ...plate });
  // Brackets (bolts shear at ~6 % strain): top corners to the top level, the
  // bottom corners and the centre to the upper spine node and the top level.
  const bracket = { yieldStrain: 0.01, breakStrain: 0.06 };
  beams.push({ a: 'sign_3', b: 'post_2_0', w: 0.5, ...bracket }, { a: 'sign_3', b: 'post_2_2', w: 0.5, ...bracket });
  beams.push({ a: 'sign_2', b: 'post_2_0', w: 0.5, ...bracket }, { a: 'sign_2', b: 'post_2_1', w: 0.5, ...bracket });
  beams.push({ a: 'sign_0', b: 'post_s4', w: 0.5, ...bracket }, { a: 'sign_1', b: 'post_s4', w: 0.5, ...bracket });
  beams.push({ a: 'sign_0', b: 'post_2_2', w: 0.3, ...bracket }, { a: 'sign_1', b: 'post_2_1', w: 0.3, ...bracket });
  beams.push({ a: 'sign_c', b: 'post_s4', w: 0.5, ...bracket }, { a: 'sign_c', b: 'post_2_0', w: 0.5, ...bracket });
  anchorBeams('post_', beams, SIGN_POST_ANCHOR_BREAK_F, [1]);
  return buildPropRig(nodes, beams, { name, r: SP_R, friction: 0.5, omegaDt: 0.45, zeta: 0.45 });
}

// ------------------------------------------------------------------ light pole
const LP_R = 0.04;
const LP_TOP = 7.7;
const ARM_Z = [-0.6, -1.2];

function buildLightPole() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const steel = { yieldStrain: 0.015, breakStrain: 0.1 };
  // Galvanised steel pole ≈ 102 kg tapering upward, arm 9 kg, lamp head 8 kg.
  column(
    {
      prefix: 'pole_',
      levels: [LP_R, 1.3, 3.3, 5.5, LP_TOP],
      rho: [0.13, 0.12, 0.11, 0.1, 0.09],
      levelMass: [8.5, 7.5, 6.5, 5.5, 4.5],
      spine: [
        [0.47, 0.9],
        [1.95, 2.65],
        [4.0, 4.8],
        [6.6],
      ],
      spineMass: 1.5,
      r: LP_R,
    },
    nodes,
    beams,
    steel,
  );
  // Arm toward −Z (front): 2 stations, triangle section in the XY plane (apex up).
  ARM_Z.forEach((z, s) => {
    nodes.push({ id: `arm_${s}_0`, pos: [0, LP_TOP + 0.12, z], mass: 1.5 });
    nodes.push({ id: `arm_${s}_1`, pos: [-0.12, LP_TOP - 0.1, z], mass: 1.5 });
    nodes.push({ id: `arm_${s}_2`, pos: [0.12, LP_TOP - 0.1, z], mass: 1.5 });
  });
  // Lamp head: a flat box under the arm tip.
  const ly = LP_TOP - 0.2;
  nodes.push({ id: 'lamp_0', pos: [-0.14, ly, -1.0], mass: 2 });
  nodes.push({ id: 'lamp_1', pos: [0.14, ly, -1.0], mass: 2 });
  nodes.push({ id: 'lamp_2', pos: [0.14, ly, -1.45], mass: 2 });
  nodes.push({ id: 'lamp_3', pos: [-0.14, ly, -1.45], mass: 2 });
  anchors(0.36, LP_R, nodes);

  const T = (k: number) => `pole_4_${k}`;
  const arm = { w: 0.5, ...steel };
  for (const s of [0, 1]) for (let k = 0; k < 3; k++) beams.push({ a: `arm_${s}_${k}`, b: `arm_${s}_${(k + 1) % 3}`, ...arm });
  // Arm root (symmetric): apex to all three top-level nodes, each lower chord to the front node and its own side.
  beams.push({ a: 'arm_0_0', b: T(0), ...arm }, { a: 'arm_0_0', b: T(1), ...arm }, { a: 'arm_0_0', b: T(2), ...arm });
  beams.push({ a: 'arm_0_1', b: T(0), ...arm }, { a: 'arm_0_1', b: T(2), ...arm });
  beams.push({ a: 'arm_0_2', b: T(0), ...arm }, { a: 'arm_0_2', b: T(1), ...arm });
  for (let k = 0; k < 3; k++) {
    const k1 = (k + 1) % 3;
    beams.push({ a: `arm_0_${k}`, b: `arm_1_${k}`, ...arm });
    beams.push({ a: `arm_0_${k}`, b: `arm_1_${k1}`, w: 0.35, ...steel }, { a: `arm_0_${k1}`, b: `arm_1_${k}`, w: 0.35, ...steel });
  }
  // Bracket struts from level 3 (2.2 m below) to the arm's lower chords, each side from its own
  // rear pole node: the arm is a braced truss with a real lever, not a cantilever off the top triangle.
  for (const s of [0, 1]) {
    beams.push({ a: 'pole_3_2', b: `arm_${s}_1`, w: 0.4, ...steel });
    beams.push({ a: 'pole_3_1', b: `arm_${s}_2`, w: 0.4, ...steel });
  }
  const head = { deform: 0, breakF: 20_000 };
  for (let k = 0; k < 4; k++) beams.push({ a: `lamp_${k}`, b: `lamp_${(k + 1) % 4}`, w: 0.6, ...head });
  beams.push({ a: 'lamp_0', b: 'lamp_2', w: 0.4, ...head });
  // Mounts: every corner to all three arm-tip nodes (two would leave a hinge).
  for (let k = 0; k < 4; k++) {
    for (const a of ['arm_1_0', 'arm_1_1', 'arm_1_2']) beams.push({ a: `lamp_${k}`, b: a, w: 0.4, ...head });
  }
  anchorBeams('pole_', beams, LIGHT_POLE_ANCHOR_BREAK_F, [2, 3]);
  return buildPropRig(nodes, beams, { name: 'lightPole', r: LP_R, friction: 0.5, omegaDt: 0.48, zeta: 0.25 });
}

// ------------------------------------------------------------------ mailbox (layout v6, R-WORLD)
export const MAILBOX_ANCHOR_BREAK_F = 5_000;
const MB_R = 0.04;

/** Rural mailbox: a 1 m timber post (truss column) with a 0.5 m steel box on a bracket; the post snaps out of the ground. */
function buildMailbox() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const wood = { yieldStrain: 0.012, breakStrain: 0.05 };
  column(
    {
      prefix: 'post_',
      levels: [MB_R, 0.5, 0.96],
      rho: [0.06, 0.06, 0.06],
      levelMass: [0.9, 0.8, 0.7],
      spine: [[0.27], [0.73]],
      spineMass: 0.3,
      r: MB_R,
    },
    nodes,
    beams,
    wood,
  );
  // Box corners (x ±0.09, y 1.0 … 1.22, z ±0.25), ≈ 2.8 kg sheet steel.
  let k = 0;
  for (const y of [1.0, 1.22]) for (const z of [-0.25, 0.25]) for (const x of [-0.09, 0.09]) nodes.push({ id: `box_${k++}`, pos: [x, y, z], mass: 0.35 });
  const sheet = { yieldStrain: 0.01, breakStrain: 0.2 };
  const edge = (a: number, b: number, w = 1): void => void beams.push({ a: `box_${a}`, b: `box_${b}`, w, ...sheet });
  // 12 edges, 12 face diagonals, 4 body diagonals: a closed, crushable box
  for (const [a, b] of [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ] as const) edge(a, b);
  for (const [a, b] of [
    [0, 3], [1, 2], [4, 7], [5, 6], [0, 5], [1, 4], [2, 7], [3, 6], [0, 6], [2, 4], [1, 7], [3, 5],
  ] as const) edge(a, b, 0.5);
  for (const [a, b] of [
    [0, 7], [1, 6], [2, 5], [3, 4],
  ] as const) edge(a, b, 0.4);
  // Bracket: the four bottom corners to the top level + the top spine node (screws pull out at 8 %).
  const screw = { yieldStrain: 0.02, breakStrain: 0.08 };
  for (const b of [0, 1, 2, 3]) {
    for (let n = 0; n < 3; n++) beams.push({ a: `box_${b}`, b: `post_2_${n}`, w: 0.5, ...screw });
    beams.push({ a: `box_${b}`, b: 'post_s2', w: 0.4, ...screw });
  }
  anchors(0.16, MB_R, nodes);
  anchorBeams('post_', beams, MAILBOX_ANCHOR_BREAK_F, [1]);
  return buildPropRig(nodes, beams, { name: 'mailbox', r: MB_R, friction: 0.6, omegaDt: 0.45, zeta: 0.45 });
}

export const SIGN_POST_RIG = buildSignPost().rig;
export const MAILBOX_RIG = buildMailbox().rig;
/** Layout v6 (R-WORLD): the same post with an octagonal STOP plate (the plate nodes are the same square). */
export const STOP_SIGN_RIG = buildSignPost('stopSign').rig;
export const LIGHT_POLE_RIG = buildLightPole().rig;
