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
  NODE_FLAG_TREAD,
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
export const KC_STABILITY = 0.2;
/**
 * Contact damping ratio ζ. The damper acts in both directions (approach and
 * rebound) with the total normal force clamped ≥ 0: an approach-only damper
 * (c·max(0, -vn)) measured restitution e ≈ 0.5 for a lone node and a 30 m/s
 * drop was still bouncing after 3 s; two-sided gives e ≈ 0.24 (the ≥ 0 clamp
 * lets the node separate while still moving, so e is above the unclamped
 * exp(-ζπ/sqrt(1-ζ²)) ≈ 0.07) and resting contacts settle quickly.
 */
export const CONTACT_ZETA = 0.65;
/**
 * SOFT-LAYER contact law (nodes with contactK > 0: tyre tread). The penalty
 * stiffness is the node's contactK (stability-capped like the rigid law)
 * and the damper is scaled by penetration, c·min(1, depth/radius)
 * (Hunt–Crossley style: zero damper force at touchdown).
 *
 * WHY: a 12-ray tread ring is a chain of point masses with no belt bending
 * stiffness, so a tread node runs on its circle until it touches down at
 * ~0.4·v (sedan at 25 m/s: 9.7 m/s) and the rigid law stopped it within
 * ~3 steps; every damper on that path (contact ζ 0.65, sidewalls) then ate
 * the node's normal kinetic energy each pass: ~55 kW of "rolling
 * resistance" at 90 km/h (coastdown 1.8 m/s², ≈ 5× real). The pass rate
 * (rays·ω ≈ 1000 rad/s at 25 m/s) is above any tread-node frequency the
 * explicit budget allows (ω·dt ≤ 0.5 → 1000 rad/s), so the node cannot
 * follow the flattened patch quasi-statically. A soft layer lets it keep
 * its circular path into the rubber and get the stored energy back on the
 * way out (the loss left is real-ish hysteresis). It also makes the
 * polygon "flat spots" shallow, which removed a fore/aft rocking mode of a
 * parked car (stuck contact nodes, 0.6 Hz, ±5 cm).
 */
const SOFT_LAYER_ZETA = 0.08;
/**
 * FRICTION LAW — implicit (backward-Euler) Coulomb, evaluated per node AFTER
 * every other force of this tick has been accumulated (beams, wheel torque,
 * parking clamp, aero; the ground pass is the last force pass before
 * integration). With F_t the tangential part of (accumulated force + m·g)
 * and v_t the tangential velocity, the force that brings v_t to exactly 0
 * at the end of the step is
 *   F_req = −(m·v_t/dt + F_t)
 * and the applied friction is F_req clamped to the cone |F| ≤ μ·N. Inside
 * the cone the node STICKS (the tread holds; longitudinal/lateral tyre
 * stiffness then comes from the soft-body carcass, as in a real tyre);
 * outside it slides with |F| = μN along F_req, which is the exact implicit
 * Coulomb direction (friction opposes the END-of-step slip velocity).
 *
 * WHY not μ·tanh(v/0.3) with a viscous cap (the P1 law): its effective
 * tangential "spring" is a damper KT·m/dt ≈ 667 N per m/s on a 0.67 kg
 * tread node, so carrying 2 kN at a contact node needed ~3–4 m/s of
 * SLIDING (measured: sedan launch, rear contact nodes at 4.4 m/s, ~2/3 of
 * μN) — the car wheelspun and spun out on throttle, and the slide added a
 * large rolling loss. The projection never overshoots (it targets v_t = 0
 * exactly, so no sign flip or 2 kHz chatter) and a node pinned
 * tangentially does not raise any neighbour's ω·dt.
 */
/**
 * Minimum touchdown impulse (N·s) that emits an impact event. The reported
 * impulse is the approach momentum m·max(0, -vn) the contact must arrest:
 * on the touchdown step depth ≤ |v|·dt, so Fn·dt there is ~c·vn·dt — orders
 * of magnitude below the real collision impulse — whereas m·vn is the impulse
 * the full contact event delivers (lower bound, excluding restitution).
 */
export const IMPACT_MIN_IMPULSE = 0.5;
/** Skid events: slip speed threshold (m/s), minimum load (N), per-node cooldown (steps). */
export const SKID_MIN_SLIP = 0.5;
export const SKID_MIN_LOAD = 1;
export const SKID_COOLDOWN_STEPS = 20;
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

/** The per-node skid cooldown table (shared with the static-collider pass). */
export function cooldownsFor(state: SimState): Uint8Array {
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
 * two-sided damper (rigid or soft-layer law) and ≥ 0 clamp as the kernel
 * (keep the two in sync). 0 for
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
  const soft = state.contactK[i]!;
  let kc: number;
  let c: number;
  if (soft > 0) {
    kc = soft < kcm ? soft : kcm;
    c = 2 * SOFT_LAYER_ZETA * Math.sqrt(kc * m) * (depth < r ? depth / r : 1);
  } else {
    kc = kcm < KC_MAX ? kcm : KC_MAX;
    c = 2 * CONTACT_ZETA * Math.sqrt(kc * m);
  }
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
  gx = 0,
  gy = 0,
  gz = 0,
): void => {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, radius, friction, contactK, flags } =
    state;
  const treadF = state.treadF;
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
    const soft = contactK[i]!;
    let kc: number;
    let c: number;
    if (soft > 0) {
      kc = soft < kcm ? soft : kcm;
      const ramp = depth < r ? depth / r : 1;
      c = 2 * SOFT_LAYER_ZETA * Math.sqrt(kc * m) * ramp;
    } else {
      kc = kcm < KC_MAX ? kcm : KC_MAX;
      c = 2 * CONTACT_ZETA * Math.sqrt(kc * m);
    }

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

    // Implicit Coulomb friction (see FRICTION LAW); tread nodes get none
    // here (NODE_FLAG_TREAD: the vehicle's tread brush supplies it).
    const tx = vx - vn * nx;
    const ty = vy - vn * ny;
    const tz = vz - vn * nz;
    const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const mat = sampler.materialAt(x, z);
    const ax = frcX[i]! + m * gx;
    const ay = frcY[i]! + m * gy;
    const az = frcZ[i]! + m * gz;
    const an = ax * nx + ay * ny + az * nz;
    const mdt = m * invDt;
    let rx = -(mdt * tx + ax - an * nx);
    let ry = -(mdt * ty + ay - an * ny);
    let rz = -(mdt * tz + az - an * nz);
    let cone = friction[i]! * matFriction[mat]! * fn;
    if ((f & NODE_FLAG_TREAD) !== 0) {
      // treadAx = the brush axis â scaled by the tyre's μ_y/μ_x (wheels.ts applyTreadBrush); 0 = the brush did
      // not see this node in contact this tick (plain friction cone below).
      let lx = state.treadAxX[i]!;
      let ly = state.treadAxY[i]!;
      let lz = state.treadAxZ[i]!;
      const la = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (la > 0) {
        // R-TYRE FRICTION ELLIPSE per tread node, (F_lon/μ_x N)² + (F_lat/μ_y N)² ≤ 1, μ_y = la·μ_x, shared in
        // this order: (1) the brush's lateral force F_b (on the rigid wheel, wheels.ts); (2) the node stick's
        // LONGITUDINAL part r_o (along the request off the brush axis), capped at the remainder
        // μ_x N·√(1 − (F_b/μ_y N)²) — sliding along its request; (3) the stick's LATERAL part r_l, capped at what
        // is left, μ_y N·√(1 − (F_lon/μ_x N)²) − F_b. The lateral stick only steadies the heavy tread nodes (with
        // none a parked truck's fluttered sideways at 2.5 m/s, R-PHYS); ranking it last keeps its jitter from
        // eating a braking tyre's longitudinal grip. WHY the ellipse: the earlier circle √((μ_x N)² − F_b²) let a
        // tyre corner at its full μ_y while braking at 0.6 μ_x (bench, sedan α 5°, κ −0.1: (Fx/μ_x)² + (Fy/μ_y)² =
        // 1.27): trail braking and ABS in a bend had grip no tyre has. treadFl = the longitudinal friction
        // applied, NEGATIVE when it was capped (the node slid): the brush reads the patch's sliding share.
        lx /= la;
        ly /= la;
        lz /= la;
        const fb = treadF[i]!;
        const L = la * cone;
        const rl = rx * lx + ry * ly + rz * lz;
        let ox = rx - rl * lx;
        let oy = ry - rl * ly;
        let oz = rz - rl * lz;
        const yb = L > 0 ? fb / L : 1;
        const remO = 1 - yb * yb;
        const oCap = remO > 0 ? cone * Math.sqrt(remO) : 0;
        let ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
        let slid = false;
        if (ol > oCap) {
          const sc = oCap / ol;
          ox *= sc;
          oy *= sc;
          oz *= sc;
          ol = oCap;
          slid = true;
        }
        const xo = cone > 0 ? ol / cone : 1;
        const remL = 1 - xo * xo;
        let latCap = (remL > 0 ? L * Math.sqrt(remL) : 0) - fb;
        if (latCap < 0) latCap = 0;
        const rlc = rl > latCap ? latCap : rl < -latCap ? -latCap : rl;
        state.treadFl[i] = slid ? -ol : ol;
        rx = rlc * lx + ox;
        ry = rlc * ly + oy;
        rz = rlc * lz + oz;
        cone = Infinity; // already inside the ellipse
      } else {
        state.treadFl[i] = 0;
      }
    }
    const r2 = rx * rx + ry * ry + rz * rz;
    if (r2 > 0) {
      if (r2 <= cone * cone) {
        fx += rx;
        fy += ry;
        fz += rz;
      } else {
        const sc = cone / Math.sqrt(r2);
        fx += sc * rx;
        fy += sc * ry;
        fz += sc * rz;
      }
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
