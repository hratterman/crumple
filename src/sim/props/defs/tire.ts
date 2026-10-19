/**
 * Loose car tyre lying flat (axis = +Y): 0.65 m Ø × 0.2 m, 9 kg, stacks at
 * 0.2 m (tyre walls). Rubber: soft, elastic, practically untearable.
 *
 * Nodes (r = 0.05, inset from the nominal surface), 12 around (k = 0 faces
 * −Z, clockwise seen from above):
 *   tI_k  lower bead / sidewall ring (ground side), y = r
 *   tO_k  upper bead / sidewall ring, y = 0.2 − r
 *   tT_k  tread ring, mid height, outer radius
 */
import { buildPropRig, ringPoint, type PropBeamSpec, type PropNodeSpec } from './build';

const R = 0.05;
const N = 12;
const HEIGHT = 0.2;
/** Sidewall ring radius (inner hole ≈ 0.19 m, a 16" rim seat) and tread ring radius (0.325 − r). */
const SIDE_RAD = 0.24;
const TREAD_RAD = 0.325 - R;

function build() {
  const nodes: PropNodeSpec[] = [];
  const beams: PropBeamSpec[] = [];
  for (let k = 0; k < N; k++) nodes.push({ id: `tI_${k}`, pos: ringPoint(SIDE_RAD, R, k, N), mass: 0.22 });
  for (let k = 0; k < N; k++) nodes.push({ id: `tO_${k}`, pos: ringPoint(SIDE_RAD, HEIGHT - R, k, N), mass: 0.22 });
  for (let k = 0; k < N; k++) nodes.push({ id: `tT_${k}`, pos: ringPoint(TREAD_RAD, HEIGHT / 2, k, N, Math.PI / N), mass: 0.31 });

  const rubber = { yieldStrain: 0.3, breakStrain: 1.2 };
  for (const p of ['tI', 'tO', 'tT']) {
    for (let k = 0; k < N; k++) beams.push({ a: `${p}_${k}`, b: `${p}_${(k + 1) % N}`, w: 1.4, ...rubber });
  }
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    const km = (k + N - 1) % N;
    // Sidewalls: each bead node to the two tread nodes flanking it (the tread ring is offset half a pitch).
    beams.push({ a: `tI_${k}`, b: `tT_${k}`, ...rubber }, { a: `tI_${k}`, b: `tT_${km}`, ...rubber });
    beams.push({ a: `tO_${k}`, b: `tT_${k}`, ...rubber }, { a: `tO_${k}`, b: `tT_${km}`, ...rubber });
    // Bead cylinder (inner face), X-braced.
    beams.push({ a: `tI_${k}`, b: `tO_${k}`, w: 1.2, ...rubber }, { a: `tI_${k}`, b: `tO_${k1}`, w: 0.5, ...rubber });
    // Tread hoop chords (belt).
    beams.push({ a: `tT_${k}`, b: `tT_${(k + 2) % N}`, w: 0.6, ...rubber });
  }
  // Diameters keep the ring round under a stack's weight.
  for (let k = 0; k < N / 2; k++) {
    beams.push({ a: `tI_${k}`, b: `tI_${k + N / 2}`, w: 0.25, ...rubber });
    beams.push({ a: `tO_${k}`, b: `tO_${k + N / 2}`, w: 0.25, ...rubber });
  }
  return buildPropRig(nodes, beams, { name: 'tire', r: R, friction: 1.0, omegaDt: 0.42, zeta: 0.35 });
}

export const TIRE_RIG = build().rig;
