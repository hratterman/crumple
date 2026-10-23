/**
 * W-BEAM GUARDRAIL (R-PHYS2): one 3.81 m (12.5 ft) rail panel of a strong-
 * post W-beam system (MASH / MGS-like: 12-gauge W-beam, top at 0.787 m,
 * W6×8.5 steel posts every 1.905 m on 0.3 m blockouts, posts embedded
 * ≈ 1.1 m in soil). Sections tile along x every 3.81 m; PROP_JOINS splices
 * them (8-bolt lap splice: ball joints between the coincident end columns).
 *
 * MECHANISM (the reason a guardrail redirects a car): the rail first bends
 * between the posts and the posts rotate back through the soil, then the
 * rail works as a TENSION MEMBER anchored at the ends of the run — the car
 * is redirected by membrane tension. A lattice of 1–2 kg nodes cannot carry
 * steel's stiffness with explicit 2 kHz beams (a panel could not even hold
 * its own weight past a post), so every structural member is also an
 * IMPLICIT link (PropDef.links → the engine's JointSet, backward Euler: any
 * stiffness is stable): the rail chords at steel's own EA, solved EXACTLY
 * along each rail row of the whole spliced run (JointSpec.chain), web
 * diagonals and the W section (yielding at the real section's forces:
 * rest lengths ratchet, the rail bends, flattens and stretches, the chords
 * harden to rupture at 18 % strain), post members, soil, blockouts. The
 * explicit beams only set the node budget. Lattice: the two W peaks (rt, rb)
 * + the valley row 6 cm behind (rv), X-braced faces (a closed triangular
 * tube: torsion-stiff).
 *
 * CONTACT: vehicles meet the rail's FACE as triangles (props/railContact.ts:
 * the two peak rows, one quad per bay), not node spheres (a car corner
 * caught in the valleys between 0.24 m-spaced spheres); posts and blockouts
 * are contact-free (see railContact.ts).
 *
 * POSTS: a 3-node triangle at ground level and one at 0.66 m (the W6 flange
 * width × depth) on PINNED soil anchors 0.6 m down: post members yield at
 * 60 kN (weak axis), soil links yield so the post rotates through the soil
 * at ≈ 45 kN at rail height and tear out at 120 kN. The rail is bolted
 * through the blockout: ball joints to bolt-head nodes on the blockout,
 * releasing at 50 kN.
 *
 * END SECTION (`guardrailEnd`): the same panel with the run's end anchored —
 * the terminal (19 mm anchor cable + end-post strut) holds each rail end at
 * its place: zero-length ball anchors (2 cm play, 3·10⁷ N/m, each breaks
 * at 180 kN) to pinned points `ea{0,1}{t,b}`: without anchorage a run cannot
 * develop tension and the car just pushes the whole run over (BCT / ET-style
 * terminals anchor both ends of every run). Both ends carry anchors; the
 * end that gets spliced to the next panel drops them (PropLink.end), so one
 * key terminates either end of a run.
 *
 * Node ids:
 *   rt{k} / rb{k}   rail peaks (top 0.74 / bottom 0.52 m), k = 0..16 along x (−1.905 … +1.905)
 *   rv{k}           valley (0.63 m, 6 cm back), even k
 *   p{i}_{0,1,2}    post i (0 at x = −0.9525, 1 at +0.9525) ground triangle; p{i}_{3,4,5} top triangle
 *   k{i}t / k{i}b   blockout (top / bottom); h{i}t / h{i}b bolt heads (on the rail)
 *   a{i}_{0,1,2}    pinned soil anchors; ea{0,1}{t,b} terminal anchors (guardrailEnd)
 */
import type { PropLink } from '../types';
import { buildPropRig, round, type PropBeamSpec, type PropNodeSpec } from './build';

export const GUARDRAIL_LENGTH = 3.81;
export const GUARDRAIL_COLUMNS = 17;
const PITCH = GUARDRAIL_LENGTH / (GUARDRAIL_COLUMNS - 1);
const R_RAIL = 0.1;
const Y_TOP = 0.74;
const Y_BOT = 0.52;
const Y_VAL = 0.63;
const Z_VAL = 0.06;
const POST_X = [-0.9525, 0.9525];
const POST_Z = 0.36;
const POST_D = 0.15;
const POST_W = 0.1;

/** Implicit rail members (PropDef.links) per kind: N/m, N·s/m, yield / rupture N (see the builder). */
const RAIL = {
  // Steel's own axial stiffness (EA ≈ 4·10⁸ N over the section: 35 / 35 / 30 %): the chains are solved
  // exactly, so the real value is stable.
  chord: { k: 5.9e8, c: 2e3, yieldF: 2.2e5, breakF: 3.1e5, ruptureStrain: 0.18, chain: true },
  valley: { k: 2.5e8, c: 1e3, yieldF: 1.6e5, breakF: 2.2e5, ruptureStrain: 0.18, chain: true },
  shear: { k: 3e7, c: 1.5e3, yieldF: 6e4, breakF: 1e8 },
  section: { k: 2e7, c: 1e3, yieldF: 3e4, breakF: 1e8 },
} as const;
export const GUARDRAIL_LINK = RAIL.chord;
/** Soil yield / tear-out of a post's anchor beams, N; bolt pull-through, N. */
export const GUARDRAIL_SOIL_YIELD = 1.5e4;
/** Post member yield, N (the weak axis governs: a wheel driven into a post folds it over). */
const POST_YIELD = 6e4;
/** Soil link stiffness, N/m (calibrated: ≈ 45 kN at rail height after ≈ 5 cm). */
const SOIL_K = 3e6;
export const GUARDRAIL_SOIL_BREAK = 1.2e5;
export const GUARDRAIL_BOLT_BREAK = 5e4;

type PropLinkSpec = PropLink;

/** Cable anchor of an end section. */
export const GUARDRAIL_ANCHOR = { k: 3e7, c: 2e3, breakF: 1.8e5, play: 0.02 } as const;

function buildGuardrail(end: boolean) {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const x = (k: number): number => round(-GUARDRAIL_LENGTH / 2 + k * PITCH);
  // Rail ≈ 50 kg (12 ga W-beam ≈ 13 kg/m incl. splice hardware).
  for (let k = 0; k < GUARDRAIL_COLUMNS; k++) {
    // The face is contacted as triangles (props/railContact.ts), not spheres: no node-vs-node contact.
    nodes.push({ id: `rt${k}`, pos: [x(k), Y_TOP, 0], mass: 1.2, r: R_RAIL, objContact: false });
    nodes.push({ id: `rb${k}`, pos: [x(k), Y_BOT, 0], mass: 1.2, r: R_RAIL, objContact: false });
    if (k % 2 === 0) nodes.push({ id: `rv${k}`, pos: [x(k), Y_VAL, Z_VAL], mass: 1.0, r: 0.05, objContact: false });
  }
  // RAIL MEMBERS. Each is an explicit beam (budget-soft, it sets nothing but the node budget) AND an
  // implicit link carrying the real stiffness: a 2 kHz lattice of 1 kg nodes is ~10⁶× too soft in bending
  // (the panel could not even carry its own weight past a post). Forces from the real section (12 ga
  // W-beam, ≈ 2000 mm², 345 / 483 MPa): the peaks (rt, rb) carry 35 % each, the valley (rv) 30 % → chord
  // yield 220 / 160 kN, rupture 310 / 220 kN (the splice: 300 kN per row);
  // lateral plastic moment ≈ rv yield × 0.06 m ≈ 9.6 kN·m (W-beam ≈ 8); web shear ≈ 60 kN per diagonal;
  // the W's section flattens at ≈ 30 kN per member.
  type Kind = 'chord' | 'valley' | 'shear' | 'section';
  const members: { a: string; b: string; w: number; kind: Kind }[] = [];
  for (let k = 0; k < GUARDRAIL_COLUMNS; k++) {
    members.push({ a: `rt${k}`, b: `rb${k}`, w: 1, kind: 'section' });
    if (k % 2 === 0) members.push({ a: `rt${k}`, b: `rv${k}`, w: 1, kind: 'section' }, { a: `rb${k}`, b: `rv${k}`, w: 1, kind: 'section' });
    if (k + 1 < GUARDRAIL_COLUMNS) {
      members.push({ a: `rt${k}`, b: `rt${k + 1}`, w: 0.5, kind: 'chord' }, { a: `rb${k}`, b: `rb${k + 1}`, w: 0.5, kind: 'chord' });
      members.push({ a: `rt${k}`, b: `rb${k + 1}`, w: 0.6, kind: 'shear' }, { a: `rb${k}`, b: `rt${k + 1}`, w: 0.6, kind: 'shear' });
      const ve = k % 2 === 0 ? k : k + 1;
      const vo = k % 2 === 0 ? k + 1 : k;
      members.push({ a: `rv${ve}`, b: `rt${vo}`, w: 0.6, kind: 'shear' }, { a: `rv${ve}`, b: `rb${vo}`, w: 0.6, kind: 'shear' });
    }
    if (k % 2 === 0 && k + 2 < GUARDRAIL_COLUMNS) members.push({ a: `rv${k}`, b: `rv${k + 2}`, w: 0.6, kind: 'valley' });
  }
  for (const m of members) beams.push({ a: m.a, b: m.b, w: m.w, deform: RAIL[m.kind].yieldF });
  // Posts, blockouts, soil.
  const bolts: PropLinkSpec[] = [];
  const postLinks: PropLinkSpec[] = [];
  POST_X.forEach((px, i) => {
    const tri = (y: number, base: number, m: number): void => {
      nodes.push({ id: `p${i}_${base}`, pos: [round(px - POST_W / 2), y, POST_Z], mass: m, r: 0.06, objContact: false });
      nodes.push({ id: `p${i}_${base + 1}`, pos: [round(px + POST_W / 2), y, POST_Z], mass: m, r: 0.06, objContact: false });
      nodes.push({ id: `p${i}_${base + 2}`, pos: [round(px), y, POST_Z + POST_D], mass: m, r: 0.06, objContact: false });
    };
    tri(0.06, 0, 4);
    tri(0.66, 3, 3);
    // Blockout (0.2 m tall): two nodes, so the rail section cannot pivot about a single bolt point.
    nodes.push({ id: `k${i}t`, pos: [round(px), 0.66, 0.2], mass: 1.5, r: 0.07, objContact: false });
    nodes.push({ id: `k${i}b`, pos: [round(px), Y_BOT, 0.2], mass: 1.5, r: 0.07, objContact: false });
    for (let a = 0; a < 3; a++) {
      const off = a === 0 ? [-0.25, -0.05] : a === 1 ? [0.25, -0.05] : [0, 0.45];
      nodes.push({ id: `a${i}_${a}`, pos: [round(px + off[0]!), -0.6, round(POST_Z + off[1]!)], mass: 0 });
    }
    // Post, soil and blockout members: explicit beams for the node budget + IMPLICIT links for the real
    // stiffness (the budget-soft lattice let a post lean 0.3 m under 10 kN). W6×8.5: plastic moment ≈ 33 kN·m
    // strong axis / 6 kN·m weak over the 0.15 / 0.1 m flange spacing → ≈ 200 / 60 kN member forces; the
    // triangle truss shares members between the axes, so the weak axis (60 kN) governs. Soil: the
    // anchor links yield so the post rotates through the soil at ≈ 45 kN at rail height (≈ 5 cm first), and
    // tear out at GUARDRAIL_SOIL_BREAK.
    const post = { k: 3e7, c: 2e3, yieldF: POST_YIELD, breakF: 1e8 };
    const soil = { k: SOIL_K, c: 3e3, yieldF: GUARDRAIL_SOIL_YIELD, breakF: GUARDRAIL_SOIL_BREAK };
    const blk = { k: 2e7, c: 1e3, breakF: 1e8 };
    const member = (a: string, b: string, w: number, l: Omit<PropLinkSpec, 'a' | 'b'>): void => {
      beams.push({ a, b, w });
      postLinks.push({ a, b, ...l });
    };
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        member(`p${i}_${a}`, `p${i}_${b}`, 1, post);
        member(`p${i}_${a + 3}`, `p${i}_${b + 3}`, 1, post);
      }
      member(`p${i}_${a}`, `p${i}_${a + 3}`, 1.2, post);
      member(`p${i}_${a}`, `p${i}_${((a + 1) % 3) + 3}`, 0.7, post);
      member(`p${i}_${(a + 1) % 3}`, `p${i}_${a + 3}`, 0.7, post);
      // Soil: each ground node to the three anchors, each top node to one (the embedded length's moment arm).
      for (let s = 0; s < 3; s++) member(`p${i}_${a}`, `a${i}_${s}`, 0.8, soil);
      member(`p${i}_${a + 3}`, `a${i}_${a}`, 0.4, soil);
    }
    // Blockout on the post's front flange (top level), bolted through the rail at the post's column.
    const kt = `k${i}t`;
    const kb = `k${i}b`;
    member(kt, kb, 1, blk);
    for (const k of [kt, kb]) {
      member(k, `p${i}_3`, 1, blk);
      member(k, `p${i}_4`, 1, blk);
      member(k, `p${i}_5`, 0.6, blk);
      member(k, `p${i}_0`, 0.4, blk);
      member(k, `p${i}_1`, 0.4, blk);
    }
    const col = Math.round((px + GUARDRAIL_LENGTH / 2) / PITCH);
    // The rail is BOLTED through the blockout: "bolt head" nodes on the blockout (rigidly tied to it and the
    // post) at the rail's rest position, ball-jointed to the rail at the post's column (a distance link let
    // the rail swing around the blockout and leave the post behind). The joint carries bearing and the bolt
    // until GUARDRAIL_BOLT_BREAK (≈ the post's own soil capacity: the rail stays on a post that is driven back
    // and lets go of one that snags or is pushed down).
    const hd = ['t', 'b'] as const;
    for (const h of hd) {
      const id = `h${i}${h}`;
      nodes.push({ id, pos: [x(col), h === 't' ? Y_TOP : Y_BOT, 0], mass: 0.5, r: 0.04, objContact: false });
      for (const k of [kt, kb, `p${i}_3`, `p${i}_4`]) member(id, k, 0.6, blk);
      bolts.push({ a: h === 't' ? `rt${col}` : `rb${col}`, b: id, k: 5e7, c: 2e3, breakF: GUARDRAIL_BOLT_BREAK, kind: 'ball' });
    }
  });
  if (end) {
    // Terminal anchorage points at the rail ends' rest positions (pinned): the terminal (cable + end-post
    // strut) holds the rail end in place — a distance cable alone let the end swing in like a pendulum and
    // the run never came taut.
    for (const [e, k] of [
      [0, 0],
      [1, GUARDRAIL_COLUMNS - 1],
    ] as const) {
      nodes.push({ id: `ea${e}t`, pos: [x(k), Y_TOP, 0], mass: 0 });
      nodes.push({ id: `ea${e}b`, pos: [x(k), Y_BOT, 0], mass: 0 });
    }
  }
  const rig = buildPropRig(nodes, beams, { name: end ? 'guardrailEnd' : 'guardrail', r: R_RAIL, friction: 0.4, omegaDt: 0.42, zeta: 0.3 });
  const links: PropLinkSpec[] = [...members.map((m) => ({ a: m.a, b: m.b, ...RAIL[m.kind] })), ...postLinks, ...bolts];
  if (end) {
    const A = GUARDRAIL_ANCHOR;
    const last = GUARDRAIL_COLUMNS - 1;
    links.push({ a: 'rt0', b: 'ea0t', k: A.k, c: A.c, breakF: A.breakF, end: 0, kind: 'ball', play: A.play, chain: true });
    links.push({ a: 'rb0', b: 'ea0b', k: A.k, c: A.c, breakF: A.breakF, end: 0, kind: 'ball', play: A.play, chain: true });
    links.push({ a: `rt${last}`, b: 'ea1t', k: A.k, c: A.c, breakF: A.breakF, end: 1, kind: 'ball', play: A.play, chain: true });
    links.push({ a: `rb${last}`, b: 'ea1b', k: A.k, c: A.c, breakF: A.breakF, end: 1, kind: 'ball', play: A.play, chain: true });
  }
  return { rig: rig.rig, links };
}

const MID = buildGuardrail(false);
const END = buildGuardrail(true);
export const GUARDRAIL_RIG = MID.rig;
export const GUARDRAIL_LINKS: readonly PropLinkSpec[] = MID.links;
export const GUARDRAIL_END_RIG = END.rig;
export const GUARDRAIL_END_LINKS: readonly PropLinkSpec[] = END.links;
