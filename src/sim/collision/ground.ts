/**
 * Ground contact kernel: penalty normal force + slip-regularized Coulomb
 * friction against a HeightSampler (plane in P1, heightfield in P3).
 *
 * Written in the general normal-projected form: the ground is approximated
 * per node by the tangent plane through (x, h(x,z), z) with the sampler's
 * smoothed normal n, so swapping in a heightfield needs no kernel changes.
 *
 * NUMERICS: the per-node loop uses only + - * / sqrt (no Math.tanh etc.),
 * iterates in ascending index order and allocates nothing.
 */
import {
  NODE_FLAG_COLLIDABLE,
  NODE_FLAG_IN_CONTACT,
  type ApplyGroundContacts,
  type EventSink,
  type HeightSampler,
  type MaterialTable,
  type SimState,
} from '../types';

// ------------------------------------------------------------ tuning
/**
 * Contact stiffness cap, N/m. Per node kc = min(KC_MAX, KC_STABILITY·m/dt²).
 *
 * WHY the m/dt² term: integration is explicit semi-implicit Euler. A penalty
 * spring of stiffness kc on a node of mass m has ω·dt = sqrt(kc/m)·dt; with
 * KC_STABILITY = 0.2 that is ≤ 0.447. Beams are already validated to ≤ 0.35
 * per node for structure, so the combined sqrt(Σk/m)·dt ≤ sqrt(0.35² + 0.2)
 * ≈ 0.57, comfortably inside the explicit envelope (hard limit 2, project
 * budget 0.5–0.6 with damping). The damper c = 2·ζ·sqrt(kc·m) then gives
 * c·dt/m = 2ζ·sqrt(0.2) ≈ 0.58 < 1, so a single step can never reverse the
 * normal velocity (no damper-driven sign flip / chatter). KC_MAX bounds the
 * stiffness for heavy nodes so the penetration of a resting node stays a
 * few mm (m·g/KC_MAX) without creating 2 kHz ringing.
 */
const KC_MAX = 2.5e5;
const KC_STABILITY = 0.2;
/**
 * Contact damping ratio ζ. The damper acts in both directions (approach and
 * rebound) with the total normal force clamped ≥ 0: an approach-only damper
 * (c·max(0, -vn)) measured restitution e ≈ 0.5 for a lone node and a 30 m/s
 * drop was still bouncing after 3 s; two-sided gives e ≈ 0.24 (the ≥ 0 clamp
 * lets the node separate while still moving, so e is above the unclamped
 * exp(-ζπ/sqrt(1-ζ²)) ≈ 0.07) and resting contacts settle quickly.
 */
const CONTACT_ZETA = 0.65;
/**
 * Viscous cap on friction, as a fraction of m/dt: |Ft| ≤ KT_FRACTION·(m/dt)·|vt|
 * means one step removes at most that fraction of the tangential velocity, so
 * friction can never overshoot and reverse the slip direction (explicit
 * stability of the stiff regularized-Coulomb branch under impact loads).
 */
const KT_FRACTION = 0.5;
/** Slip-velocity regularization scale (m/s) of the μ·tanh(v/V) friction law. */
const SLIP_REG_INV = 1 / 0.3;
/**
 * Minimum touchdown impulse (N·s) that emits an impact event. The reported
 * impulse is the approach momentum m·max(0, -vn) the contact must arrest:
 * on the touchdown step depth ≤ |v|·dt, so Fn·dt there is ~c·vn·dt — orders
 * of magnitude below the real collision impulse — whereas m·vn is the impulse
 * the full contact event delivers (lower bound, excluding restitution).
 */
const IMPACT_MIN_IMPULSE = 0.5;
/** Skid events: slip speed threshold (m/s), minimum load (N), per-node cooldown (steps). */
const SKID_MIN_SLIP = 0.5;
const SKID_MIN_LOAD = 1;
const SKID_COOLDOWN_STEPS = 20;
/**
 * Normal sampling early-out: nodes higher than SLOPE_SKIP·radius above the
 * ground height are skipped without sampling the normal. Exact for slopes up
 * to acos(1/SLOPE_SKIP) ≈ 75.5°; steeper than that a heightfield is a wall,
 * which ground contact does not model anyway.
 */
const SLOPE_SKIP = 4;

// ------------------------------------------------------------ helpers
/**
 * Rational tanh approximant, clamped to 1: x(27+x²)/(27+9x²) is the [3/2]
 * Padé form; it reaches exactly 1 at x = 3 (where (x-3)³ = 0) with zero slope,
 * so the clamp is C1. Max absolute error vs tanh ≈ 0.024 (~2.4%, near
 * x ≈ 1.6); odd, monotone on [0, 3]. Only + - * / (numerics contract).
 */
export function tanhR(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Flat ground at height `y` with a single material. Mutable so the `ground` command can retarget it. */
export class PlaneSampler implements HeightSampler {
  constructor(
    public y: number,
    public materialId: number,
  ) {}
  heightAt(_x: number, _z: number): number {
    return this.y;
  }
  normalAt(_x: number, _z: number, out: Float64Array): void {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
  }
  materialAt(_x: number, _z: number): number {
    return this.materialId;
  }
}

// ------------------------------------------------------------ per-state scratch
const normal = new Float64Array(3);
/**
 * Per-node skid cooldown (steps remaining), keyed by arena. Allocated once per
 * SimState (outside the node loop); WeakMap so test fixtures don't leak.
 */
const skidCooldowns = new WeakMap<SimState, Uint8Array>();

function cooldownsFor(state: SimState): Uint8Array {
  let cd = skidCooldowns.get(state);
  if (cd === undefined || cd.length < state.nodeCapacity) {
    const next = new Uint8Array(state.nodeCapacity);
    if (cd !== undefined) next.set(cd);
    cd = next;
    skidCooldowns.set(state, cd);
  }
  return cd;
}

/** Clears skid cooldowns for nodes [first, first+count) (e.g. on reset/spawn). */
export function resetGroundContactState(state: SimState, first: number, count: number): void {
  cooldownsFor(state).fill(0, first, first + count);
}

// ------------------------------------------------------------ per-node query
const queryNormal = new Float64Array(3);

/**
 * Normal force (N, ≥ 0) that applyGroundContacts would apply to node `i`
 * for the CURRENT positions/velocities: same early-outs, stiffness clamp,
 * two-sided damper and ≥ 0 clamp as the kernel (keep the two in sync). 0 for
 * non-collidable, pinned or non-penetrating nodes. When `normalOut` is given
 * and the node is in contact, the sampled unit normal is written there.
 * Used by the vehicle pre-step (wheel load, parking clamp cap), which runs
 * before the ground pass with unchanged positions, so the value equals this
 * tick's contact force. Hot path: + - * / sqrt only, no allocation.
 */
export function groundNormalForce(
  state: SimState,
  i: number,
  sampler: HeightSampler,
  dt: number,
  normalOut?: Float64Array,
): number {
  if ((state.flags[i]! & NODE_FLAG_COLLIDABLE) === 0) return 0;
  const im = state.invMass[i]!;
  if (im === 0) return 0;
  const x = state.posX[i]!;
  const y = state.posY[i]!;
  const z = state.posZ[i]!;
  const r = state.radius[i]!;
  const h = sampler.heightAt(x, z);
  if (y - h > SLOPE_SKIP * r) return 0;
  const out = normalOut ?? queryNormal;
  sampler.normalAt(x, z, out);
  const nx = out[0]!;
  const ny = out[1]!;
  const nz = out[2]!;
  const depth = (h - y) * ny + r;
  if (!(depth > 0)) return 0;
  const m = 1 / im;
  const invDt = 1 / dt;
  const kcm = KC_STABILITY * invDt * invDt * m;
  const kc = kcm < KC_MAX ? kcm : KC_MAX;
  const c = 2 * CONTACT_ZETA * Math.sqrt(kc * m);
  const vn = state.velX[i]! * nx + state.velY[i]! * ny + state.velZ[i]! * nz;
  const fn = kc * depth - c * vn;
  return fn > 0 ? fn : 0;
}

// ------------------------------------------------------------ kernel
export const applyGroundContacts: ApplyGroundContacts = (
  state: SimState,
  first: number,
  count: number,
  sampler: HeightSampler,
  materials: MaterialTable,
  dt: number,
  objectId: number,
  events: EventSink,
): void => {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, radius, friction, flags } =
    state;
  const matFriction = materials.friction;
  const cooldown = cooldownsFor(state);
  const invDt = 1 / dt;
  const kcStab = KC_STABILITY * invDt * invDt;
  const end = first + count;

  for (let i = first; i < end; i++) {
    const f = flags[i]!;
    if ((f & NODE_FLAG_COLLIDABLE) === 0) {
      flags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    const im = invMass[i]!;
    if (im === 0) {
      flags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    const cd = cooldown[i]!;
    if (cd > 0) cooldown[i] = cd - 1;

    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    const r = radius[i]!;
    const h = sampler.heightAt(x, z);
    if (y - h > SLOPE_SKIP * r) {
      flags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }
    sampler.normalAt(x, z, normal);
    const nx = normal[0]!;
    const ny = normal[1]!;
    const nz = normal[2]!;
    // Signed distance of the node centre from the local tangent plane through
    // (x, h, z) is (y - h)·ny (the x/z offsets are zero); penetration = r - that.
    const depth = (h - y) * ny + r;
    if (!(depth > 0)) {
      flags[i] = f & ~NODE_FLAG_IN_CONTACT;
      continue;
    }

    const m = 1 / im;
    const kcm = kcStab * m;
    const kc = kcm < KC_MAX ? kcm : KC_MAX;
    const c = 2 * CONTACT_ZETA * Math.sqrt(kc * m);

    const vx = velX[i]!;
    const vy = velY[i]!;
    const vz = velZ[i]!;
    const vn = vx * nx + vy * ny + vz * nz;
    // Two-sided damper, total clamped ≥ 0 (never pulls the node down).
    let fn = kc * depth - c * vn;
    if (fn < 0) fn = 0;

    let fx = fn * nx;
    let fy = fn * ny;
    let fz = fn * nz;

    // Tangential slip and regularized Coulomb friction.
    const tx = vx - vn * nx;
    const ty = vy - vn * ny;
    const tz = vz - vn * nz;
    const vt2 = tx * tx + ty * ty + tz * tz;
    const mat = sampler.materialAt(x, z);
    let vt = 0;
    if (vt2 > 1e-24) {
      vt = Math.sqrt(vt2);
      const mu = friction[i]! * matFriction[mat]!;
      const coulomb = mu * fn * tanhR(vt * SLIP_REG_INV);
      const viscous = KT_FRACTION * m * invDt * vt;
      const ft = coulomb < viscous ? coulomb : viscous;
      const s = ft / vt;
      fx -= s * tx;
      fy -= s * ty;
      fz -= s * tz;
    }

    frcX[i] = frcX[i]! + fx;
    frcY[i] = frcY[i]! + fy;
    frcZ[i] = frcZ[i]! + fz;

    // Contact point on the ground surface below the node centre.
    const px = x - nx * r;
    const py = y - ny * r;
    const pz = z - nz * r;

    if ((f & NODE_FLAG_IN_CONTACT) === 0) {
      const impulse = vn < 0 ? -vn * m : 0;
      if (impulse > IMPACT_MIN_IMPULSE) {
        events.impact(objectId, mat, px, py, pz, nx, ny, nz, impulse);
      }
    }
    flags[i] = f | NODE_FLAG_IN_CONTACT;

    if (vt > SKID_MIN_SLIP && fn > SKID_MIN_LOAD && cooldown[i] === 0) {
      cooldown[i] = SKID_COOLDOWN_STEPS;
      events.skid(objectId, mat, px, py, pz, vt, fn);
    }
  }
};
