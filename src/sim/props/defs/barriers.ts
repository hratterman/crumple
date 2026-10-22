/**
 * R-PHYS2 props: road barriers, farm and cargo items (PURE DATA, solved by
 * ./build.ts like the P5 catalog). Real masses and failure modes:
 *
 *  waterBarrier  plastic water-filled barrier (Yodock 2001-class): 1.8 m ×
 *                0.55 m base × 0.8 m, 27 kg empty + 420 L → ≈ 450 kg. HDPE
 *                shell: yields at 4 %, tears at 25 % (then drains:
 *                PropDef.fluid). Long axis along X, traffic face −Z.
 *  jerseyBarrier precast concrete F-shape safety-shape barrier: 3.0 m ×
 *                0.61 m base / 0.15 m top × 0.81 m, ≈ 1800 kg (AASHTO / FHWA
 *                temporary concrete barrier, 2.5–2.7 t/m³). Rigid; adjacent
 *                segments end to end are pinned together (the engine joins
 *                them: pin-and-loop, PIN joint in ../runtime.ts).
 *  hayBale       round bale 1.5 m Ø × 1.2 m, ≈ 320 kg (dry hay ≈ 150 kg/m³),
 *                net-wrapped straw: soft, heavily damped, plastic (absorbs a
 *                hit), never tears. Lies on its side, axis along X.
 *  pallet        48 × 40" (1.22 × 1.02 m) GMA wooden pallet, 0.144 m, 25 kg;
 *                splinters at 5 %.
 *  fencePanel    2.4 m wooden picket fence section, 1.0 m: two 4×4 posts
 *                set in the ground (BREAKABLE anchors, 7 kN: a car snaps
 *                them), two rails, seven pickets nailed on (nails pull at ≈
 *                1.2 kN), a Z-brace; rails / pickets splinter (break 3–4 %):
 *                the panel comes apart in pieces.
 */
import { buildPropRig, ringPoint, round, type PropBeamSpec, type PropNodeSpec } from './build';

// ------------------------------------------------------------------ water-filled barrier
const WB_R = 0.06;
export const WATER_BARRIER_WATER_KG = 420;

function buildWaterBarrier() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const L = 0.9 - WB_R;
  const xs = [-L, 0, L];
  // Section corners (node centres): base (±0.275 − r, r), top (±0.15 − r, 0.8 − r).
  const sec: [string, number, number][] = [
    ['bL', -(0.275 - WB_R), WB_R],
    ['bR', 0.275 - WB_R, WB_R],
    ['tR', 0.15 - WB_R, 0.8 - WB_R],
    ['tL', -(0.15 - WB_R), 0.8 - WB_R],
  ];
  // Shell 27 kg on the 12 section nodes + 2 end centres; water 420 kg spread over all 15 (incl. the core).
  const per = WATER_BARRIER_WATER_KG / 15;
  xs.forEach((x, i) => {
    for (const [tag, z, y] of sec) nodes.push({ id: `s${i}_${tag}`, pos: [round(x), round(y), round(z)], mass: 2 + per });
  });
  nodes.push({ id: 'end_0', pos: [-L, 0.4, 0], mass: 1.5 + per });
  nodes.push({ id: 'end_1', pos: [L, 0.4, 0], mass: 1.5 + per });
  nodes.push({ id: 'core', pos: [0, 0.4, 0], mass: per });
  // HDPE shell: the water inside makes it hydraulically stiff (the stiffness solve on the full mass), so it bursts
  // at a seam (≈ 3 % on the full-mass stiffness) rather than denting first; then it drains (PropDef.fluid).
  const pe = { yieldStrain: 0.012, breakStrain: 0.03 };
  const tags = sec.map((s) => s[0]);
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 4; k++) beams.push({ a: `s${i}_${tags[k]}`, b: `s${i}_${tags[(k + 1) % 4]}`, w: 1, ...pe });
    beams.push({ a: `s${i}_bL`, b: `s${i}_tR`, w: 0.6, ...pe }, { a: `s${i}_bR`, b: `s${i}_tL`, w: 0.6, ...pe });
    if (i < 2) {
      for (let k = 0; k < 4; k++) {
        beams.push({ a: `s${i}_${tags[k]}`, b: `s${i + 1}_${tags[k]}`, w: 1, ...pe });
        beams.push({ a: `s${i}_${tags[k]}`, b: `s${i + 1}_${tags[(k + 1) % 4]}`, w: 0.5, ...pe });
        beams.push({ a: `s${i}_${tags[(k + 1) % 4]}`, b: `s${i + 1}_${tags[k]}`, w: 0.5, ...pe });
      }
    }
    for (const t of tags) beams.push({ a: 'core', b: `s${i}_${t}`, w: 0.4, ...pe });
  }
  for (const [e, i] of [
    ['end_0', 0],
    ['end_1', 2],
  ] as const) {
    for (const t of tags) beams.push({ a: e, b: `s${i}_${t}`, w: 0.6, ...pe });
    beams.push({ a: e, b: 'core', w: 0.4, ...pe });
  }
  return buildPropRig(nodes, beams, { name: 'waterBarrier', r: WB_R, friction: 0.55, omegaDt: 0.42, zeta: 0.45 });
}

// ------------------------------------------------------------------ concrete F-shape (jersey) barrier
const JB_R = 0.06;
export const JERSEY_LENGTH = 3.0;

function buildJerseyBarrier() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const L = JERSEY_LENGTH / 2 - JB_R;
  const xs = [-L, -L / 3, L / 3, L];
  // F-shape section: toe (base ±0.305), the 55° → 84° break point at 0.33 m (±0.2), top (±0.075).
  const sec: [string, number, number][] = [
    ['bL', -(0.305 - JB_R), JB_R],
    ['kL', -(0.2 - JB_R * 0.6), 0.33],
    ['tL', -(0.075), 0.81 - JB_R],
    ['tR', 0.075, 0.81 - JB_R],
    ['kR', 0.2 - JB_R * 0.6, 0.33],
    ['bR', 0.305 - JB_R, JB_R],
  ];
  // 1800 kg over 24 nodes (the toe carries more: the section is widest at the base).
  const m: Record<string, number> = { bL: 115, bR: 115, kL: 80, kR: 80, tL: 30, tR: 30 };
  xs.forEach((x, i) => {
    for (const [tag, z, y] of sec) nodes.push({ id: `s${i}_${tag}`, pos: [round(x), round(y), round(z)], mass: m[tag]! });
  });
  // Precast concrete: elastic, never yields; only a violent hit spalls / cracks a member (2 % of a stiff member's
  // length is far past any elastic strain concrete takes: the segment survives a 50 km/h car, as real ones do).
  const conc = { breakStrain: 0.02 };
  const tags = sec.map((s) => s[0]);
  for (let i = 0; i < xs.length; i++) {
    for (let k = 0; k < 6; k++) beams.push({ a: `s${i}_${tags[k]}`, b: `s${i}_${tags[(k + 1) % 6]}`, w: 1, ...conc });
    beams.push({ a: `s${i}_bL`, b: `s${i}_kR`, w: 0.6, ...conc }, { a: `s${i}_bR`, b: `s${i}_kL`, w: 0.6, ...conc });
    beams.push({ a: `s${i}_kL`, b: `s${i}_tR`, w: 0.6, ...conc }, { a: `s${i}_kR`, b: `s${i}_tL`, w: 0.6, ...conc });
    if (i + 1 < xs.length) {
      for (let k = 0; k < 6; k++) {
        beams.push({ a: `s${i}_${tags[k]}`, b: `s${i + 1}_${tags[k]}`, w: 1, ...conc });
        beams.push({ a: `s${i}_${tags[k]}`, b: `s${i + 1}_${tags[(k + 1) % 6]}`, w: 0.5, ...conc });
        beams.push({ a: `s${i}_${tags[(k + 1) % 6]}`, b: `s${i + 1}_${tags[k]}`, w: 0.5, ...conc });
      }
    }
  }
  return buildPropRig(nodes, beams, { name: 'jerseyBarrier', r: JB_R, friction: 0.7, omegaDt: 0.35, zeta: 0.3 });
}

// ------------------------------------------------------------------ round hay bale
const HB_R = 0.08;
const HB_N = 8;

function buildHayBale() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const rad = 0.75 - HB_R;
  const half = 0.6 - HB_R;
  // Rings in the YZ plane at x = ±half (axis along X), centred 0.75 m up; node k = 0 at the bottom.
  for (const [e, x] of [
    [0, -half],
    [1, half],
  ] as const) {
    for (let k = 0; k < HB_N; k++) {
      const p = ringPoint(rad, 0, k, HB_N);
      // ringPoint gives (x, y, z) = (r·sin, 0, −r·cos); map its (x, z) → (z, y): k = 0 at the bottom, 4 on top, 6 in front (−Z).
      nodes.push({ id: `r${e}_${k}`, pos: [round(x), round(0.75 + p[2]), round(p[0])], mass: 17 });
    }
    nodes.push({ id: `ax_${e}`, pos: [round(x), 0.75, 0], mass: 12 });
  }
  nodes.push({ id: 'core', pos: [0, 0.75, 0], mass: 24 });
  const straw = { yieldStrain: 0.025, zeta: 0.9 };
  for (let e = 0; e < 2; e++) {
    for (let k = 0; k < HB_N; k++) {
      beams.push({ a: `r${e}_${k}`, b: `r${e}_${(k + 1) % HB_N}`, w: 1, ...straw });
      beams.push({ a: `r${e}_${k}`, b: `r${e}_${(k + 2) % HB_N}`, w: 0.4, ...straw });
      beams.push({ a: `r${e}_${k}`, b: `ax_${e}`, w: 0.5, ...straw });
    }
  }
  for (let k = 0; k < HB_N; k++) {
    const k1 = (k + 1) % HB_N;
    beams.push({ a: `r0_${k}`, b: `r1_${k}`, w: 1, ...straw });
    beams.push({ a: `r0_${k}`, b: `r1_${k1}`, w: 0.5, ...straw });
    beams.push({ a: `r0_${k1}`, b: `r1_${k}`, w: 0.5, ...straw });
    beams.push({ a: `r0_${k}`, b: 'core', w: 0.3, ...straw }, { a: `r1_${k}`, b: 'core', w: 0.3, ...straw });
  }
  beams.push({ a: 'ax_0', b: 'core', w: 0.5, ...straw }, { a: 'ax_1', b: 'core', w: 0.5, ...straw });
  // Soft: a bale squashes 10–20 cm under a car (stiffness solved well below the ω·dt budget), plastically.
  return buildPropRig(nodes, beams, { name: 'hayBale', r: HB_R, friction: 0.6, omegaDt: 0.14, zeta: 0.9, dampDt: 0.8 });
}

// ------------------------------------------------------------------ pallet
const PL_R = 0.05;

function buildPallet() {
  // A flat box truss (deck boards over three stringers): corners + edge midpoints top / bottom.
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const hx = 0.61 - PL_R;
  const hz = 0.51 - PL_R;
  const y0 = PL_R;
  const y1 = 0.144 - PL_R;
  const xs = [-hx, 0, hx];
  const zs = [-hz, 0, hz];
  for (const [l, y] of [
    ['b', y0],
    ['t', y1],
  ] as const) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nodes.push({ id: `${l}${i}${j}`, pos: [round(xs[i]!), round(y), round(zs[j]!)], mass: 25 / 18 });
  }
  const wood = { yieldStrain: 0.015, breakStrain: 0.05 };
  for (const l of ['b', 't']) {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        if (i < 2) beams.push({ a: `${l}${i}${j}`, b: `${l}${i + 1}${j}`, w: 1, ...wood });
        if (j < 2) beams.push({ a: `${l}${i}${j}`, b: `${l}${i}${j + 1}`, w: 1, ...wood });
        if (i < 2 && j < 2) {
          beams.push({ a: `${l}${i}${j}`, b: `${l}${i + 1}${j + 1}`, w: 0.5, ...wood });
          beams.push({ a: `${l}${i + 1}${j}`, b: `${l}${i}${j + 1}`, w: 0.5, ...wood });
        }
      }
  }
  // Stringer blocks: top ↔ bottom at every node + diagonals along the stringers.
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      beams.push({ a: `b${i}${j}`, b: `t${i}${j}`, w: 1, ...wood });
      if (j < 2) beams.push({ a: `b${i}${j}`, b: `t${i}${j + 1}`, w: 0.5, ...wood }, { a: `t${i}${j}`, b: `b${i}${j + 1}`, w: 0.5, ...wood });
      if (i < 2) beams.push({ a: `b${i}${j}`, b: `t${i + 1}${j}`, w: 0.4, ...wood });
    }
  return buildPropRig(nodes, beams, { name: 'pallet', r: PL_R, friction: 0.6, omegaDt: 0.42, zeta: 0.35 });
}

// ------------------------------------------------------------------ wooden picket fence section
const FP_R = 0.04;
export const FENCE_ANCHOR_BREAK_F = 7000;

function buildFencePanel() {
  // Three 4×4 posts (ends + middle: a 2.4 m section is two 1.2 m bays), two 2×4 rails as two-row trusses
  // (the board's flat-wise depth: a single chain of nodes has no bending stiffness), seven pickets.
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const wood = { yieldStrain: 0.01, breakStrain: 0.035 };
  const post = { yieldStrain: 0.012, breakStrain: 0.04 };
  const PX = [-1.2 + FP_R + 0.06, 0, 1.2 - FP_R - 0.06];
  PX.forEach((x, p) => {
    for (const [l, y] of [
      [0, FP_R],
      [1, 1.05],
    ] as const) {
      for (let k = 0; k < 3; k++) {
        const q = ringPoint(0.06, y, k, 3);
        nodes.push({ id: `p${p}_${l}_${k}`, pos: [round(x + q[0]), y, q[2]], mass: 1.9 });
      }
    }
    nodes.push({ id: `p${p}_c`, pos: [round(x), FP_R, 0], mass: 0.5 });
    for (let k = 0; k < 3; k++) {
      const q = ringPoint(0.17, FP_R, k, 3, Math.PI / 3);
      nodes.push({ id: `anchor_${3 * p + k}`, pos: [round(x + q[0]), FP_R, q[2]], mass: 0 });
    }
  });
  const RX = [-1.06, -0.53, 0, 0.53, 1.06];
  const RZ = [0.045, 0.165];
  for (const [r, y] of [
    [0, 0.25],
    [1, 0.85],
  ] as const) {
    RZ.forEach((z, w) => RX.forEach((x, i) => nodes.push({ id: `rail${r}${w}_${i}`, pos: [x, y, z], mass: 0.45 })));
  }
  const PK = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];
  PK.forEach((x, i) => {
    nodes.push({ id: `pk${i}_b`, pos: [x, FP_R + 0.02, 0.2], mass: 0.6 });
    nodes.push({ id: `pk${i}_t`, pos: [x, 1.0, 0.2], mass: 0.5 });
  });
  for (let p = 0; p < PX.length; p++) {
    for (let l = 0; l < 2; l++) for (let k = 0; k < 3; k++) beams.push({ a: `p${p}_${l}_${k}`, b: `p${p}_${l}_${(k + 1) % 3}`, w: 0.4, breakF: 4e4 });
    for (let k = 0; k < 3; k++) beams.push({ a: `p${p}_c`, b: `p${p}_0_${k}`, w: 0.3, breakF: 4e4 }, { a: `p${p}_c`, b: `p${p}_1_${k}`, w: 0.2, breakF: 4e4 });
    for (let k = 0; k < 3; k++) {
      const k1 = (k + 1) % 3;
      beams.push({ a: `p${p}_0_${k}`, b: `p${p}_1_${k}`, w: 1, ...post });
      beams.push({ a: `p${p}_0_${k}`, b: `p${p}_1_${k1}`, w: 0.4, ...post });
      beams.push({ a: `p${p}_0_${k1}`, b: `p${p}_1_${k}`, w: 0.4, ...post });
      // Set in the ground: anchors to the base and up the post (they snap as a unit).
      beams.push({ a: `anchor_${3 * p + k}`, b: `p${p}_0_${k}`, w: 0.8, breakF: FENCE_ANCHOR_BREAK_F });
      beams.push({ a: `anchor_${3 * p + k}`, b: `p${p}_0_${k1}`, w: 0.8, breakF: FENCE_ANCHOR_BREAK_F });
      beams.push({ a: `anchor_${3 * p + k}`, b: `p${p}_1_${k}`, w: 0.6, breakF: FENCE_ANCHOR_BREAK_F });
    }
  }
  // Rails: two rows (truss with X bays), nailed to the posts they cross (end + middle posts).
  for (let r = 0; r < 2; r++) {
    for (let w = 0; w < 2; w++) for (let i = 0; i + 1 < RX.length; i++) beams.push({ a: `rail${r}${w}_${i}`, b: `rail${r}${w}_${i + 1}`, w: 1, ...wood });
    for (let i = 0; i < RX.length; i++) beams.push({ a: `rail${r}0_${i}`, b: `rail${r}1_${i}`, w: 0.6, ...wood });
    for (let i = 0; i + 1 < RX.length; i++) beams.push({ a: `rail${r}0_${i}`, b: `rail${r}1_${i + 1}`, w: 0.5, ...wood }, { a: `rail${r}1_${i}`, b: `rail${r}0_${i + 1}`, w: 0.5, ...wood });
    for (const [i, p] of [
      [0, 0],
      [2, 1],
      [RX.length - 1, 2],
    ] as const) {
      for (let k = 0; k < 3; k++) beams.push({ a: `rail${r}0_${i}`, b: `p${p}_${r}_${k}`, w: 0.4, breakF: 2500 }, { a: `rail${r}1_${i}`, b: `p${p}_${r}_${k}`, w: 0.3, breakF: 2500 });
    }
  }
  // Rails to each other through the post-free bays: the two rails + pickets make the panel's in-plane truss.
  for (let i = 0; i + 1 < RX.length; i++) beams.push({ a: `rail00_${i}`, b: `rail10_${i + 1}`, w: 0.4, ...wood }, { a: `rail10_${i}`, b: `rail00_${i + 1}`, w: 0.4, ...wood });
  // Pickets: board (bottom–top), nailed to both rails' outer row at the nearest rail nodes (nails pull at ≈ 1.2 kN).
  PK.forEach((x, i) => {
    beams.push({ a: `pk${i}_b`, b: `pk${i}_t`, w: 1, ...wood });
    let j = 0;
    for (let q = 1; q < RX.length; q++) if (Math.abs(RX[q]! - x) < Math.abs(RX[j]! - x)) j = q;
    for (const r of [0, 1]) {
      for (const w of [0, 1]) {
        beams.push({ a: `pk${i}_b`, b: `rail${r}${w}_${j}`, w: 0.2, breakF: 1200 });
        beams.push({ a: `pk${i}_t`, b: `rail${r}${w}_${j}`, w: 0.2, breakF: 1200 });
      }
    }
  });
  return buildPropRig(nodes, beams, { name: 'fencePanel', r: FP_R, friction: 0.6, omegaDt: 0.46, zeta: 0.4 });
}

export const WATER_BARRIER_RIG = buildWaterBarrier().rig;
export const JERSEY_BARRIER_RIG = buildJerseyBarrier().rig;
export const HAY_BALE_RIG = buildHayBale().rig;
export const PALLET_RIG = buildPallet().rig;
export const FENCE_PANEL_RIG = buildFencePanel().rig;
