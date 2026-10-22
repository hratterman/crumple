/**
 * R-CRASH ROOF STRENGTH harness (FMVSS 216a / IIHS roof strength; test / tool use only, never imported by
 * the engine): a rigid platen pressed quasi-statically onto the roof's front corner; the strength-to-weight
 * ratio SWR = the peak platen force within 127 mm of platen travel / the vehicle's weight.
 *
 * Set-up (FMVSS 216a S7): the body is held at its sills / floor (the test clamps the sills); the platen is
 * 1829 × 762 mm, its lower face pitched 5° forward (front edge down) and rolled 25° outboard (outer edge
 * down), its forward edge 254 mm ahead of the forward-most point of the roof, its long centreline over the
 * roof side rail; it moves along its own lower-face normal at a constant speed. References: FMVSS 216a
 * requires SWR ≥ 3 (vehicles ≤ 2722 kg; 1.5 up to 4536 kg); IIHS rates "good" at SWR ≥ 4; measured modern
 * sedans 4–6, pre-2009 cars ≈ 2–3.5.
 *
 * The platen is a box collider re-placed every few ticks (`setExtraColliders`); its force is the collider
 * contact law's normal force (collision/colliders.ts: k_c = min(KC_STABILITY·m/dt², COLLIDER_KC_MAX) on the
 * capped depth) summed over the nodes under its lower face — quasi-static, so the contact damping and the
 * unloading branch are left out (the platen only advances).
 */
import { COLLIDER_KC_MAX } from '../collision/types';
import { KC_STABILITY } from '../collision/ground';
import { SIM_DT, SIM_HZ } from '../engine';
import { MaterialId } from '../../protocol/messages';
import type { ColliderDef } from '../../world/types';
import { createHandlingSim, G } from './handling';
import type { VehicleDef } from './types';

export interface RoofStrengthSpec {
  def: VehicleDef;
  /** Roof side: the platen sits over this side's rail (driver side 'L'). */
  side?: 'L' | 'R';
  /** Node id at the forward-most point of the roof (windscreen header / roof front), side-agnostic (z only). */
  roofFront: string;
  /** Roof side-rail node the platen's long centreline passes over (`$` = side). */
  rail: string;
  /** Clamped nodes: ids matching this (`$` = either side). */
  pin: RegExp;
  /** Platen speed, m/s (FMVSS ≤ 13 mm/s; quasi-static here already at 0.05: the roof's lowest modes are > 20 Hz). */
  speed?: number;
  /** Travel to report the curve to, m (default 0.2; SWR is taken over the first 0.127). */
  travel?: number;
  /** Diagnostics hook, every sample (tool use). */
  onSample?: (sim: ReturnType<typeof createHandlingSim>, travel: number, force: number) => void;
}

export interface RoofStrengthResult {
  massKg: number;
  /** Peak platen force within 127 mm of travel, N. */
  peakForce: number;
  swr: number;
  /** Platen travel at the peak, m. */
  peakAt: number;
  /** Force at 127 mm, N. */
  forceAt127: number;
  /** (travel m, force N) samples every 5 mm. */
  curve: [number, number][];
  /** Roof rail (the rail node) drop at the end of the push, m (vertical). */
  loadedDrop: number;
  /** …and after the platen is withdrawn (permanent set), m. */
  permanentSet: number;
  /** Body beams yielded / broken after the test. */
  yielded: number;
  broken: number;
  finite: boolean;
}

const HALF = [0.381, 0.1, 0.9145] as const;
const REPLACE_EVERY = 4;

type V3 = [number, number, number];
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQ = (ax: V3, deg: number): Q => {
  const h = (deg * Math.PI) / 360;
  return [ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)];
};
/** Columns of the rotation matrix of q (local x, y, z axes in world). */
function axes(q: Q): [V3, V3, V3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export function runRoofStrength(spec: RoofStrengthSpec): RoofStrengthResult {
  const side = spec.side ?? 'L';
  const sx = side === 'L' ? -1 : 1;
  const speed = spec.speed ?? 0.05;
  const travelMax = spec.travel ?? 0.2;
  const sim = createHandlingSim({ def: spec.def });
  const { eng, obj, cv } = sim;
  const s = eng.state;
  const n0 = obj.nodeStart;
  const ids = cv.rig.nodeIds;
  const idx = (id: string): number => {
    const i = ids.indexOf(id);
    if (i < 0) throw new Error(`roofStrength: no node ${id}`);
    return n0 + i;
  };
  eng.setInput(obj.objectId, { gearSelect: 0, throttle: 0, brake: 1, handbrake: 1, steer: 0 });
  for (let t = 0; t < SIM_HZ; t++) eng.step();
  // clamp the sills / floor where they settled
  const pinned: number[] = [];
  for (let i = 0; i < cv.bodyNodeCount; i++) if (spec.pin.test(ids[i]!)) pinned.push(n0 + i);
  if (pinned.length === 0) throw new Error('roofStrength: nothing to clamp');
  for (const i of pinned) s.invMass[i] = 0;

  // platen orientation: roll 25° outboard (outer edge down), then pitch 5° forward (front edge down)
  const q = qmul(axisQ([1, 0, 0], -5), axisQ([0, 0, 1], -sx * 25));
  const [ex, ey, ez] = axes(q);
  const push: V3 = [-ey[0], -ey[1], -ey[2]];
  const rail = idx(spec.rail.replace(/\$/g, side));
  const zFront = s.posZ[idx(spec.roofFront)]!;
  // lower-face centre: over the rail, forward edge 254 mm ahead of the roof front (vehicle forward = −Z)
  const zc = zFront - 0.254 + HALF[2];
  // start clear of every body node (3 cm), along the push axis
  let lift = -Infinity;
  for (let i = 0; i < cv.bodyNodeCount; i++) {
    const j = n0 + i;
    const dx = s.posX[j]! - s.posX[rail]!;
    const dy = s.posY[j]! - s.posY[rail]!;
    const dz = s.posZ[j]! - zc;
    const lx = dx * ex[0] + dy * ex[1] + dz * ex[2];
    const lz = dx * ez[0] + dy * ez[1] + dz * ez[2];
    if (Math.abs(lx) > HALF[0] + 0.1 || Math.abs(lz) > HALF[2] + 0.1) continue;
    const up = dx * ey[0] + dy * ey[1] + dz * ey[2] + s.radius[j]!;
    if (up > lift) lift = up;
  }
  const c0: V3 = [s.posX[rail]! + ey[0] * (lift + 0.03), s.posY[rail]! + ey[1] * (lift + 0.03), zc + ey[2] * (lift + 0.03)];
  const kcStab = KC_STABILITY / (SIM_DT * SIM_DT);

  let travel = 0;
  const place = (d: number): V3 => {
    const c: V3 = [c0[0] + push[0] * d, c0[1] + push[1] * d, c0[2] + push[2] * d];
    const centre: V3 = [c[0] + ey[0] * HALF[1], c[1] + ey[1] * HALF[1], c[2] + ey[2] * HALF[1]];
    const platen: ColliderDef = { id: 'roofPlaten', kind: 'box', pos: centre, quat: q, size: [HALF[0], HALF[1], HALF[2]], material: MaterialId.metal };
    eng.setExtraColliders([platen]);
    return c;
  };
  /** Σ normal force of the nodes under the platen's lower face (centre c), along the push axis, N. */
  const force = (c: V3): number => {
    let f = 0;
    for (let i = 0; i < obj.nodeCount; i++) {
      const j = n0 + i;
      const im = s.invMass[j]!;
      if (im === 0) continue;
      const dx = s.posX[j]! - c[0];
      const dy = s.posY[j]! - c[1];
      const dz = s.posZ[j]! - c[2];
      const lx = dx * ex[0] + dy * ex[1] + dz * ex[2];
      const lz = dx * ez[0] + dy * ez[1] + dz * ez[2];
      if (Math.abs(lx) > HALF[0] || Math.abs(lz) > HALF[2]) continue;
      const below = -(dx * ey[0] + dy * ey[1] + dz * ey[2]);
      const r = s.radius[j]!;
      const depth = r - below;
      if (!(depth > 0) || below < -2 * HALF[1]) continue;
      const m = 1 / im;
      const kc = Math.min(kcStab * m, COLLIDER_KC_MAX);
      f += kc * Math.min(depth, 0.12);
    }
    return f;
  };

  let c = place(0);
  let contact = -1;
  const curve: [number, number][] = [];
  let peak = 0;
  let peakAt = 0;
  let at127 = 0;
  let nextSample = 0;
  const railY0 = s.posY[rail]!;
  const step = speed * SIM_DT * REPLACE_EVERY;
  let d = 0;
  for (let t = 0; t < 40 * SIM_HZ; t++) {
    if (t % REPLACE_EVERY === 0) {
      d += step;
      c = place(d);
    }
    eng.step();
    if (t % REPLACE_EVERY !== REPLACE_EVERY - 1) continue;
    const f = force(c);
    if (contact < 0) {
      if (f > 0.002 * cv.totalMass * G) contact = d;
      else continue;
    }
    travel = d - contact;
    if (travel <= 0.127 && f > peak) {
      peak = f;
      peakAt = travel;
    }
    if (travel <= 0.127) at127 = f;
    spec.onSample?.(sim, travel, f);
    if (travel >= nextSample) {
      curve.push([travel, f]);
      nextSample += 0.005;
    }
    if (travel >= travelMax) break;
  }
  const loadedDrop = railY0 - s.posY[rail]!;
  // withdraw, let the roof spring back, and read the set
  eng.setExtraColliders([]);
  for (let t = 0; t < 0.5 * SIM_HZ; t++) eng.step();
  let yielded = 0;
  let broken = 0;
  for (let b = obj.beamStart; b < obj.beamStart + cv.bodyBeamCount; b++) {
    if (s.active[b] === 0) broken++;
    else if (s.restLen[b] !== s.restLen0[b] && s.type[b] !== 3) yielded++;
  }
  let finite = true;
  for (let i = n0; i < n0 + obj.nodeCount; i++) if (!Number.isFinite(s.posX[i]!) || !Number.isFinite(s.posY[i]!)) finite = false;
  return {
    massKg: cv.totalMass,
    peakForce: peak,
    swr: peak / (cv.totalMass * G),
    peakAt,
    forceAt127: at127,
    curve,
    loadedDrop,
    permanentSet: railY0 - s.posY[rail]!,
    yielded,
    broken,
    finite,
  };
}

export function formatRoofStrength(name: string, r: RoofStrengthResult): string {
  const kn = (f: number): string => (f / 1000).toFixed(1);
  return (
    `${name}: SWR ${r.swr.toFixed(2)} (peak ${kn(r.peakForce)} kN at ${(r.peakAt * 1000).toFixed(0)} mm, ${kn(r.forceAt127)} kN at 127 mm, ` +
    `${r.massKg.toFixed(0)} kg), rail drop ${(r.loadedDrop * 100).toFixed(1)} → set ${(r.permanentSet * 100).toFixed(1)} cm, yielded ${r.yielded} broken ${r.broken}, finite ${r.finite}; ` +
    `curve ${r.curve.filter((_, k) => k % 4 === 0).map(([x, f]) => `${(x * 1000).toFixed(0)}:${kn(f)}`).join(' ')}`
  );
}

/**
 * Per-vehicle platen set-up and targets (keyed by VehicleDef.name; data, so a new rig only adds a row).
 * swr: [lo, hi] band; setFraction: minimum share of the rail's loaded drop kept after the platen leaves.
 * References: FMVSS 216a ≥ 3 (≤ 2722 kg), IIHS good ≥ 4; pre-2009 compacts 1.5–3.
 */
export const ROOF_CASES: Readonly<Record<string, Omit<RoofStrengthSpec, 'def'> & { swr: [number, number]; setFraction: number }>> = {
  sedan: { roofFront: 's6_rf', rail: 's6_rf_$', pin: /^s[5-9]_(sl|fl)_[LR]$|^s[5-9]_tn$/, swr: [3.5, 5.5], setFraction: 0.5 },
  sedanTraffic: { roofFront: 's7_rf', rail: 's7_rf_$', pin: /^s[5-9]_(sl|fl)_[LR]$|^s[5-9]_tn$/, swr: [3.5, 5.5], setFraction: 0.5 },
  coupe: { roofFront: 's6_rf', rail: 's6_rf_$', pin: /^s[5-8]_(sl|fl)_[LR]$|^s[5-8]_tn$/, swr: [2.8, 5], setFraction: 0.35 },
  beater: { roofFront: 's6_rf', rail: 's6_rf_$', pin: /^s[5-9]_(sl|fl)_[LR]$|^s[5-9]_tn$/, swr: [1.8, 3.2], setFraction: 0.4 },
  // open: the pickup's cab lattice is soft and springy (SWR 2.7 against FMVSS 216a's 3, real full-size pickups
  // 2015+: 4–6; 20 % of the platen travel kept as set)
  pickup: { roofFront: 'c1_rf', rail: 'c1_rf_$', pin: /^c[0-4]_(sl|fl)_[LR]$|^c[0-4]_tn$/, swr: [2.4, 5], setFraction: 0.15 },
};
