/**
 * 200 L steel drum: 0.585 m Ø × 0.88 m, 18 kg empty, sealed (floats).
 * Thin shell that DENTS: low yield strain on the shell, high break strain
 * (a steel drum crumples long before it tears).
 *
 * Nodes (inset by r from the nominal surface):
 *   rim{ring}_{k}  rings 0..2 bottom → top, 8 around (k = 0 faces −Z, then clockwise seen from above: +X at k = 2)
 *   lidB_c, lidT_c  bottom / top lid centres
 * Node r = 0.06 (P5 integration; was 12 around at r = 0.04): a third fewer
 * nodes / beams for the 2 kHz awake budget, and the 0.19 m ring pitch minus
 * two 0.06 m radii still leaves no gap a 0.04 m prop node slips through.
 */
import { buildPropRig, ringPoint, type PropBeamSpec, type PropNodeSpec } from './build';

const R = 0.06;
const N = 8;
const RAD = 0.2925 - R;
const HEIGHT = 0.88;
const RING_Y = [R, HEIGHT / 2, HEIGHT - R];

function build() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  // Mass: chime rings + lids 13.2 kg, middle wall ring 4.8 kg = 18 kg.
  const ringMass = [0.75, 0.6, 0.75];
  RING_Y.forEach((y, ring) => {
    for (let k = 0; k < N; k++) nodes.push({ id: `rim${ring}_${k}`, pos: ringPoint(RAD, y, k, N), mass: ringMass[ring]! });
  });
  nodes.push({ id: 'lidB_c', pos: [0, R, 0], mass: 0.6 });
  nodes.push({ id: 'lidT_c', pos: [0, HEIGHT - R, 0], mass: 0.6 });

  // Chime rings (rolled lid seams) are stiffer than the wall; everything dents at ~2 % and tears at ~35 %.
  const wall = { yieldStrain: 0.02, breakStrain: 0.35 };
  const chime = { yieldStrain: 0.025, breakStrain: 0.4 };
  for (let ring = 0; ring < 3; ring++) {
    const edge = ring === 1 ? wall : chime;
    for (let k = 0; k < N; k++) beams.push({ a: `rim${ring}_${k}`, b: `rim${ring}_${(k + 1) % N}`, w: ring === 1 ? 1 : 1.6, ...edge });
  }
  for (let ring = 0; ring < 2; ring++) {
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      beams.push({ a: `rim${ring}_${k}`, b: `rim${ring + 1}_${k}`, w: 1, ...wall });
      beams.push({ a: `rim${ring}_${k}`, b: `rim${ring + 1}_${k1}`, w: 0.6, ...wall });
      beams.push({ a: `rim${ring}_${k1}`, b: `rim${ring + 1}_${k}`, w: 0.6, ...wall });
    }
  }
  // Lids: spokes from the centres to their chime ring.
  for (let k = 0; k < N; k++) {
    beams.push({ a: 'lidB_c', b: `rim0_${k}`, w: 0.8, ...chime });
    beams.push({ a: 'lidT_c', b: `rim2_${k}`, w: 0.8, ...chime });
  }
  // Inner bracing so the drum keeps its round section (air pressure / the
  // corrugation hoops in a real drum): middle ring to both lid centres.
  for (let k = 0; k < N; k += 2) {
    beams.push({ a: 'lidB_c', b: `rim1_${k}`, w: 0.3, ...wall });
    beams.push({ a: 'lidT_c', b: `rim1_${k + 1}`, w: 0.3, ...wall });
  }
  beams.push({ a: 'lidB_c', b: 'lidT_c', w: 0.5, ...wall });
  return buildPropRig(nodes, beams, { name: 'barrel', r: R, friction: 0.5, omegaDt: 0.42, zeta: 0.5 });
}

export const BARREL_RIG = build().rig;
