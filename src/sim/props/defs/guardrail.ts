/**
 * Guardrail section (layout v6, R-WORLD): a 4.1 m galvanised W-beam on three
 * driven posts, bolted through blockouts; the posts are driven into the ground
 * (BREAKABLE anchors: a hard hit pulls / snaps them and the section folds
 * away), the rail yields plastically (it wraps around a bumper) and rarely
 * tears.
 *
 * NODES (prop frame: base on y = 0, front = −Z = the traffic side):
 *   rail_{i}_{j}   W-beam, i = 0..16 stations every 0.25 m along X
 *                  (x = −2.0 … 2.0), j = 0 lower crown (y 0.45) / 1 upper crown (0.76),
 *                  z = −0.2 (in front of the posts, on 0.15 m blockouts);
 *                  j = 2 the profile's valley (y 0.605, 8 cm behind); station spacing
 *                  0.25 m keeps bumper nodes from slipping
 *                  between rail nodes (beams have no contact)
 *   p{k}_{l}_{n}   post k (x = −1.9, 0, +1.9: 1.9 m post spacing), level l (0 base,
 *                  1 top at 0.72 m), triangle node n (0 = front, −Z)
 *   p{k}_c, p{k}_t post axis at the base / top (frame origin / up)
 *   anchor_{3k+n}  pinned foundation of post k
 */
import { buildPropRig, ringPoint, round, type PropBeamSpec, type PropNodeSpec } from './build';

export const GUARDRAIL_ANCHOR_BREAK_F = 18_000;
const R = 0.05;
const POST_X = [-1.9, 0, 1.9];
const RAIL_Y = [0.45, 0.76];
const RAIL_Z = -0.2;
const STATIONS = 17;

function build() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  const steel = { yieldStrain: 0.02, breakStrain: 0.15 };
  const stiff = { breakF: 60_000, deform: 0 };
  // Posts (≈ 11.8 kg each).
  POST_X.forEach((px, k) => {
    [R, 0.72].forEach((y, l) => {
      for (let n = 0; n < 3; n++) {
        const p = ringPoint(0.07, y, n, 3);
        nodes.push({ id: `p${k}_${l}_${n}`, pos: [round(px + p[0]), y, p[2]], mass: l === 0 ? 4.0 : 3.5 });
      }
    });
    nodes.push({ id: `p${k}_c`, pos: [px, R, 0], mass: 1 });
    nodes.push({ id: `p${k}_t`, pos: [px, 0.72, 0], mass: 1 });
    for (let l = 0; l < 2; l++) {
      for (let n = 0; n < 3; n++) beams.push({ a: `p${k}_${l}_${n}`, b: `p${k}_${l}_${(n + 1) % 3}`, w: 0.4, ...stiff });
      for (let n = 0; n < 3; n++) beams.push({ a: `p${k}_${l === 0 ? 'c' : 't'}`, b: `p${k}_${l}_${n}`, w: 0.3, ...stiff });
    }
    for (let n = 0; n < 3; n++) {
      const n1 = (n + 1) % 3;
      beams.push({ a: `p${k}_0_${n}`, b: `p${k}_1_${n}`, w: 1, ...steel });
      beams.push({ a: `p${k}_0_${n}`, b: `p${k}_1_${n1}`, w: 0.35, ...steel });
      beams.push({ a: `p${k}_0_${n1}`, b: `p${k}_1_${n}`, w: 0.35, ...steel });
    }
    beams.push({ a: `p${k}_c`, b: `p${k}_t`, w: 0.3, ...steel });
  });
  // Rail (≈ 31 kg): the W profile as three rows — the two crowns (j 0, 1) toward traffic and the
  // valley (j 2) 8 cm behind — so the section has real out-of-plane bending and torsion stiffness.
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < 3; j++) nodes.push({ id: `rail_${i}_${j}`, pos: [round(-2 + i * 0.25), j < 2 ? RAIL_Y[j]! : (RAIL_Y[0]! + RAIL_Y[1]!) / 2, j < 2 ? RAIL_Z : RAIL_Z + 0.08], mass: 0.6 });
  }
  const rail = { yieldStrain: 0.008, breakStrain: 0.3 };
  for (let i = 0; i < STATIONS; i++) {
    beams.push({ a: `rail_${i}_0`, b: `rail_${i}_1`, w: 0.6, ...rail });
    beams.push({ a: `rail_${i}_0`, b: `rail_${i}_2`, w: 0.6, ...rail });
    beams.push({ a: `rail_${i}_1`, b: `rail_${i}_2`, w: 0.6, ...rail });
    if (i + 1 < STATIONS) {
      for (let j = 0; j < 3; j++) beams.push({ a: `rail_${i}_${j}`, b: `rail_${i + 1}_${j}`, w: 1, ...rail });
      beams.push({ a: `rail_${i}_0`, b: `rail_${i + 1}_1`, w: 0.4, ...rail });
      beams.push({ a: `rail_${i}_1`, b: `rail_${i + 1}_0`, w: 0.4, ...rail });
      beams.push({ a: `rail_${i}_2`, b: `rail_${i + 1}_0`, w: 0.4, ...rail });
      beams.push({ a: `rail_${i}_2`, b: `rail_${i + 1}_1`, w: 0.4, ...rail });
    }
    // bending stiffness across two stations
    if (i + 2 < STATIONS) for (let j = 0; j < 3; j++) beams.push({ a: `rail_${i}_${j}`, b: `rail_${i + 2}_${j}`, w: 0.5, ...rail });
  }
  // Blockouts + bolts: the stations at the posts (x = ±1.5, ±1.75) to the post tops; bolts shear.
  const bolt = { yieldStrain: 0.02, breakStrain: 0.12 };
  POST_X.forEach((px, k) => {
    const ic = Math.round((px + 2) / 0.25);
    for (const i of [ic - 1, ic, ic + 1].filter((v) => v >= 0 && v < STATIONS)) {
      for (let j = 0; j < 3; j++) {
        for (let n = 0; n < 3; n++) beams.push({ a: `rail_${i}_${j}`, b: `p${k}_1_${n}`, w: n === 0 ? 1 : 0.6, ...bolt });
        beams.push({ a: `rail_${i}_${j}`, b: `p${k}_t`, w: 0.6, ...bolt });
        beams.push({ a: `rail_${i}_${j}`, b: `p${k}_0_0`, w: 0.4, ...bolt });
      }
    }
  });
  // Driven-post foundations: 3 pinned anchors per post, tied to the base and strutted to the top.
  POST_X.forEach((px, k) => {
    for (let n = 0; n < 3; n++) {
      const p = ringPoint(0.24, R, n, 3, Math.PI / 3);
      nodes.push({ id: `anchor_${3 * k + n}`, pos: [round(px + p[0]), R, p[2]], mass: 0 });
    }
    const strut = { breakF: GUARDRAIL_ANCHOR_BREAK_F, deform: 0 };
    for (let n = 0; n < 3; n++) {
      const a = `anchor_${3 * k + n}`;
      const q = (n + 1) % 3;
      for (const l of [0, 1]) {
        beams.push({ a, b: `p${k}_${l}_${n}`, w: l === 0 ? 0.8 : 0.6, ...strut });
        beams.push({ a, b: `p${k}_${l}_${q}`, w: l === 0 ? 0.8 : 0.6, ...strut });
      }
    }
  });
  return buildPropRig(nodes, beams, { name: 'guardrail', r: R, friction: 0.35, omegaDt: 0.45, zeta: 0.4 });
}

export const GUARDRAIL_RIG = build().rig;
