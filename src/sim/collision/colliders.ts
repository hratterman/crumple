/**
 * Static-collider contact kernel (P4; contract and law in ./types.ts).
 *
 * compileColliders: ResolvedCollider[] → SoA + XZ grid (CSR). Not a hot
 * path. applyColliderContacts: per object per tick, the object's node AABB
 * gathers candidate colliders from the grid (deduped by a stamp, sorted
 * ascending), then every collidable free node is tested against each
 * candidate in index order with the rigid ground law (penalty + two-sided
 * damper, ≥ 0 clamp, implicit backward-Euler Coulomb on the accumulated
 * force + m·g).
 *
 * NUMERICS: hot loop uses only + − × ÷ sqrt, fixed order, no allocation
 * (scratch arrays are module-level / owned by the ColliderWorld).
 */
import { colliderWorldAabb, quatToMatrix } from '../../world/colliders';
import type { ResolvedCollider } from '../../world/types';
import { NODE_FLAG_COLLIDABLE, NODE_FLAG_IN_CONTACT, type SimState } from '../types';
import {
  CONTACT_ZETA,
  cooldownsFor,
  IMPACT_MIN_IMPULSE,
  KC_STABILITY,
  SKID_COOLDOWN_STEPS,
  SKID_MIN_LOAD,
  SKID_MIN_SLIP,
} from './ground';
import {
  COLLIDER_GRID_CELL,
  COLLIDER_KC_MAX,
  COLLIDER_MAX_CANDIDATES,
  COLLIDER_PLANE_DEPTH,
  ColliderKindId,
  type ApplyColliderContacts,
  type ColliderGrid,
  type ColliderWorld,
  type CompileColliders,
  type CompiledColliders,
} from './types';

/** AABB fattening (m), see CompiledColliders.aabbMin. */
const AABB_FATTEN = 0.1;
/** Grid cell count cap: a far-flung extra set coarsens the cells instead of allocating a huge grid. */
const MAX_GRID_CELLS = 1 << 18;
/**
 * Inside-solid face skipping (contract: least-penetration face, skipping
 * faces with v·n > 0) applies only when that face is deeper than
 * min(this, half the solid's extent along the face normal), m (the
 * latter keeps thin plates working: a node past the mid-plane).
 * WHY: a node REBOUNDING out of a legit contact also has v·n > 0 at its
 * nearest face; skipping there would eject it through a far face (a car
 * pressed into the ramp, then ejected out of its bottom). At
 * COLLIDER_KC_MAX a real contact 10 cm deep is 200 kN on one node, which
 * no crash reaches, so deeper means tunnelled (the thin-wall case).
 */
const SKIP_MIN_DEPTH = 0.1;
/**
 * The penalty spring uses min(depth, DEPTH_CAP): a tunnelled node is pushed
 * out with a bounded force (kc·cap) over a few steps instead of one
 * explosive step.
 */
const DEPTH_CAP = 0.12;
/** Nodes this close to a cylinder axis / sphere centre take the motion-based normal. */
const AXIS_EPS = 1e-3;

const KIND_BY_NAME: Record<ResolvedCollider['kind'], number> = ColliderKindId;

// ------------------------------------------------------------------ compile
export const compileColliders: CompileColliders = (resolved) => {
  const n = resolved.length;
  const c: CompiledColliders = {
    count: n,
    ids: resolved.map((r) => r.id),
    kind: new Uint8Array(n),
    material: new Uint8Array(n),
    pos: new Float64Array(3 * n),
    rot: new Float64Array(9 * n),
    size: new Float64Array(3 * n),
    slopeNormal: new Float64Array(3 * n),
    aabbMin: new Float64Array(3 * n),
    aabbMax: new Float64Array(3 * n),
    breakForce: new Float64Array(n),
    active: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = resolved[i]!;
    const kind = KIND_BY_NAME[r.kind];
    if (kind === undefined) throw new Error(`collider '${r.id}': unknown kind ${String(r.kind)}`);
    c.kind[i] = kind;
    c.material[i] = r.material;
    for (let k = 0; k < 3; k++) {
      c.pos[3 * i + k] = r.pos[k]!;
      c.size[3 * i + k] = r.size[k]!;
    }
    quatToMatrix(r.quat, c.rot, 9 * i);
    if (kind === ColliderKindId.ramp) {
      // Sloped face y = −hy·z/hz through the local origin: outward normal ∝ (0, hz, hy).
      const hy = r.size[1]!;
      const hz = r.size[2]!;
      const l = Math.sqrt(hz * hz + hy * hy);
      c.slopeNormal[3 * i + 1] = hz / l;
      c.slopeNormal[3 * i + 2] = hy / l;
    }
    const bb = colliderWorldAabb(r, AABB_FATTEN);
    for (let k = 0; k < 3; k++) {
      c.aabbMin[3 * i + k] = bb[k]!;
      c.aabbMax[3 * i + k] = bb[k + 3]!;
    }
    c.breakForce[i] = r.breakable ? r.breakable.anchorForce : Infinity;
    c.active[i] = 1;
  }
  return {
    colliders: c,
    grid: buildGrid(c),
    candidates: new Int32Array(COLLIDER_MAX_CANDIDATES),
    // Last slot holds the running stamp epoch.
    stamp: new Uint32Array(n + 1),
  };
};

function buildGrid(c: CompiledColliders): ColliderGrid {
  const n = c.count;
  if (n === 0) {
    return { cellSize: COLLIDER_GRID_CELL, originX: 0, originZ: 0, cols: 0, rows: 0, cellStart: new Int32Array(1), cellItems: new Int32Array(0) };
  }
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, c.aabbMin[3 * i]!);
    z0 = Math.min(z0, c.aabbMin[3 * i + 2]!);
    x1 = Math.max(x1, c.aabbMax[3 * i]!);
    z1 = Math.max(z1, c.aabbMax[3 * i + 2]!);
  }
  let cell = COLLIDER_GRID_CELL;
  let cols = Math.floor((x1 - x0) / cell) + 1;
  let rows = Math.floor((z1 - z0) / cell) + 1;
  while (cols * rows > MAX_GRID_CELLS) {
    cell *= 2;
    cols = Math.floor((x1 - x0) / cell) + 1;
    rows = Math.floor((z1 - z0) / cell) + 1;
  }
  const cellOf = (v: number, o: number, lim: number): number => Math.min(lim - 1, Math.max(0, Math.floor((v - o) / cell)));
  const counts = new Int32Array(cols * rows + 1);
  const span = (i: number): [number, number, number, number] => [
    cellOf(c.aabbMin[3 * i]!, x0, cols),
    cellOf(c.aabbMax[3 * i]!, x0, cols),
    cellOf(c.aabbMin[3 * i + 2]!, z0, rows),
    cellOf(c.aabbMax[3 * i + 2]!, z0, rows),
  ];
  for (let i = 0; i < n; i++) {
    const [ca, cb, ra, rb] = span(i);
    for (let r = ra; r <= rb; r++) for (let q = ca; q <= cb; q++) counts[r * cols + q + 1]!++;
  }
  for (let k = 1; k < counts.length; k++) counts[k] = counts[k]! + counts[k - 1]!;
  const cellStart = counts.slice();
  const fill = counts.slice();
  const cellItems = new Int32Array(cellStart[cols * rows]!);
  // Ascending collider index within each cell (outer loop over colliders).
  for (let i = 0; i < n; i++) {
    const [ca, cb, ra, rb] = span(i);
    for (let r = ra; r <= rb; r++) for (let q = ca; q <= cb; q++) cellItems[fill[r * cols + q]!++] = i;
  }
  return { cellSize: cell, originX: x0, originZ: z0, cols, rows, cellStart, cellItems };
}

/** Empty world (no colliders): applyColliderContacts returns immediately. */
export function emptyColliderWorld(): ColliderWorld {
  return compileColliders([]);
}

// ------------------------------------------------------------------ per-state memory
/** Per-node "touched a collider last tick" (impact events fire on touchdown), keyed by arena. */
const contactMemory = new WeakMap<SimState, Uint8Array>();

function memoryFor(state: SimState): Uint8Array {
  let m = contactMemory.get(state);
  if (m === undefined || m.length < state.nodeCapacity) {
    const next = new Uint8Array(state.nodeCapacity);
    if (m !== undefined) next.set(m);
    m = next;
    contactMemory.set(state, m);
  }
  return m;
}

/** Per node: deepest (capped) penetration of the current contact, m (CONTACT_UNLOAD). */
const depthMemory = new WeakMap<SimState, Float64Array>();
function depthMaxFor(state: SimState): Float64Array {
  let m = depthMemory.get(state);
  if (m === undefined || m.length < state.nodeCapacity) {
    const next = new Float64Array(state.nodeCapacity);
    if (m !== undefined) next.set(m);
    m = next;
    depthMemory.set(state, m);
  }
  return m;
}
/**
 * R-CRASH hysteretic contact (Walton–Braun): the penalty spring loads at kc and UNLOADS at
 * kc / CONTACT_UNLOAD_E2 from the deepest point of the contact, F = (kc/e²)·(d − d0), d0 = d_max·(1 − e²)
 * (continuous at d_max, zero at d0; reloading follows the unloading line back up to d_max, then kc).
 * WHY: a rigid barrier stores no energy, but the stability-capped penalty holds ½·F²/kc per node: a
 * 50 km/h frontal pressed the engine and the suspension pivots 4–5 cm into the wall (at the old 2 MN/m
 * cap) and the contact springs gave back 1.3–2.4 kJ of the rebound (coupe: 2.4 of its 3.6 kJ rebound
 * KE). e² = 0.05 (contact restitution ≈ 0.22) dissipates ~95 % of that store; at rest (no unloading)
 * the law is the plain penalty.
 */
export const CONTACT_UNLOAD_E2 = 0.05;
/**
 * …and the remembered deepest point relaxes toward the current depth with this time constant, s: a rigid
 * barrier keeps no indentation, so a node left at rest inside the unloading line (zero force at 95 % of its
 * deepest penetration) is eased back out instead of staying embedded in the wall.
 */
export const CONTACT_UNLOAD_RELAX_S = 0.2;
/**
 * The unloading stiffness never exceeds this × m/dt² (ω·dt = 1, half the explicit-Euler bound): for a light
 * node already at the 0.2·m/dt² stability cap, kc/e² would sit at ω·dt = 2 and ring (the effective e² is
 * then kc / this ≥ 0.2: a node of ≤ 10 kg keeps ≥ 80 % of the dissipation).
 */
export const CONTACT_UNLOAD_STAB = 1.0;

/** Clears collider contact memory for nodes [first, first+count) (spawn/reset/despawn re-pack). */
export function resetColliderContactState(state: SimState, first: number, count: number): void {
  memoryFor(state).fill(0, first, first + count);
  depthMaxFor(state).fill(0, first, first + count);
}

// ------------------------------------------------------------------ narrow phase
/**
 * Narrow-phase result in the collider's LOCAL frame: [sd, nx, ny, nz]
 * (signed distance of the node centre to the solid, outward unit normal).
 */
const hit = new Float64Array(4);

/**
 * Box: exact closest feature outside; inside → least-penetration face,
 * skipping faces the node moves out through (v·n > 0) when deeper than
 * SKIP_MIN_DEPTH. Always writes `hit`.
 */
function boxDistance(px: number, py: number, pz: number, vx: number, vy: number, vz: number, hx: number, hy: number, hz: number): void {
  const ax = px < 0 ? -px : px;
  const ay = py < 0 ? -py : py;
  const az = pz < 0 ? -pz : pz;
  const ox = ax - hx;
  const oy = ay - hy;
  const oz = az - hz;
  if (ox > 0 || oy > 0 || oz > 0) {
    const cx = ox > 0 ? ox : 0;
    const cy = oy > 0 ? oy : 0;
    const cz = oz > 0 ? oz : 0;
    const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (d > 1e-9) {
      hit[0] = d;
      hit[1] = (px < 0 ? -cx : cx) / d;
      hit[2] = (py < 0 ? -cy : cy) / d;
      hit[3] = (pz < 0 ? -cz : cz) / d;
      return;
    }
  }
  // Inside (or on the surface): six faces, penetration = h ∓ p.
  let best = Infinity;
  let bn = 0; // face code: 0..5 = +x, −x, +y, −y, +z, −z
  let any = Infinity;
  let an = 0;
  for (let f = 0; f < 6; f++) {
    const axis = f >> 1;
    const sgn = (f & 1) === 0 ? 1 : -1;
    const p = axis === 0 ? px : axis === 1 ? py : pz;
    const h = axis === 0 ? hx : axis === 1 ? hy : hz;
    const v = axis === 0 ? vx : axis === 1 ? vy : vz;
    const pen = h - sgn * p;
    if (pen < any) {
      any = pen;
      an = f;
    }
    const skipAt = 0.5 * h < SKIP_MIN_DEPTH ? 0.5 * h : SKIP_MIN_DEPTH;
    if (sgn * v > 0 && pen > skipAt) continue;
    if (pen < best) {
      best = pen;
      bn = f;
    }
  }
  if (best === Infinity) {
    best = any;
    bn = an;
  }
  const axis = bn >> 1;
  const sgn = (bn & 1) === 0 ? 1 : -1;
  hit[0] = -best;
  hit[1] = axis === 0 ? sgn : 0;
  hit[2] = axis === 1 ? sgn : 0;
  hit[3] = axis === 2 ? sgn : 0;
}

/**
 * Ramp wedge = box ∩ {n_s·p ≤ 0}: max over the face planes' signed
 * distances (exact on face regions, slightly conservative near edges);
 * inside → least-penetration face with the same skip rule as the box.
 */
function rampDistance(
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  hx: number,
  hy: number,
  hz: number,
  sy: number,
  sz: number,
): void {
  // Faces: 0 +x, 1 −x, 2 bottom (−y), 3 back (−z), 4 toe (+z), 5 slope.
  let maxD = -Infinity;
  let mf = 0;
  let best = Infinity;
  let bf = -1;
  for (let f = 0; f < 6; f++) {
    let d: number;
    let vn: number;
    if (f === 0) {
      d = px - hx;
      vn = vx;
    } else if (f === 1) {
      d = -px - hx;
      vn = -vx;
    } else if (f === 2) {
      d = -py - hy;
      vn = -vy;
    } else if (f === 3) {
      d = -pz - hz;
      vn = -vz;
    } else if (f === 4) {
      d = pz - hz;
      vn = vz;
    } else {
      d = py * sy + pz * sz;
      vn = vy * sy + vz * sz;
    }
    if (d > maxD) {
      maxD = d;
      mf = f;
    }
    const pen = -d;
    if (vn > 0 && pen > SKIP_MIN_DEPTH) continue;
    if (pen < best) {
      best = pen;
      bf = f;
    }
  }
  const f = maxD > 0 || bf < 0 ? mf : bf;
  hit[0] = maxD > 0 || bf < 0 ? maxD : -best;
  hit[1] = f === 0 ? 1 : f === 1 ? -1 : 0;
  hit[2] = f === 2 ? -1 : f === 5 ? sy : 0;
  hit[3] = f === 3 ? -1 : f === 4 ? 1 : f === 5 ? sz : 0;
}

/** Cylinder (axis local +Y, flat caps). */
function cylinderDistance(px: number, py: number, pz: number, vx: number, vy: number, vz: number, rad: number, hh: number): void {
  const rho = Math.sqrt(px * px + pz * pz);
  // Radial unit (motion-based near the axis: opposite the horizontal velocity, else +X).
  let ux: number;
  let uz: number;
  if (rho > AXIS_EPS) {
    ux = px / rho;
    uz = pz / rho;
  } else {
    const vh = Math.sqrt(vx * vx + vz * vz);
    if (vh > 1e-9) {
      ux = -vx / vh;
      uz = -vz / vh;
    } else {
      ux = 1;
      uz = 0;
    }
  }
  const ay = py < 0 ? -py : py;
  const oy = ay - hh;
  const orr = rho - rad;
  if (orr > 0 || oy > 0) {
    if (oy <= 0) {
      hit[0] = orr;
      hit[1] = ux;
      hit[2] = 0;
      hit[3] = uz;
    } else if (orr <= 0) {
      hit[0] = oy;
      hit[1] = 0;
      hit[2] = py < 0 ? -1 : 1;
      hit[3] = 0;
    } else {
      const d = Math.sqrt(orr * orr + oy * oy);
      hit[0] = d;
      hit[1] = (ux * orr) / d;
      hit[2] = ((py < 0 ? -1 : 1) * oy) / d;
      hit[3] = (uz * orr) / d;
    }
    return;
  }
  // Inside: radial (or, moving out through it deep, the opposite side it came in from), top, bottom.
  let pen = rad - rho;
  let nx = ux;
  let ny = 0;
  let nz = uz;
  const skipR = 0.5 * rad < SKIP_MIN_DEPTH ? 0.5 * rad : SKIP_MIN_DEPTH;
  const skipY = 0.5 * hh < SKIP_MIN_DEPTH ? 0.5 * hh : SKIP_MIN_DEPTH;
  if (vx * ux + vz * uz > 0 && pen > skipR) {
    pen = rad + rho;
    nx = -ux;
    nz = -uz;
  }
  const pt = hh - py;
  if (pt < pen && !(vy > 0 && pt > skipY)) {
    pen = pt;
    nx = 0;
    ny = 1;
    nz = 0;
  }
  const pb = hh + py;
  if (pb < pen && !(vy < 0 && pb > skipY)) {
    pen = pb;
    nx = 0;
    ny = -1;
    nz = 0;
  }
  hit[0] = -pen;
  hit[1] = nx;
  hit[2] = ny;
  hit[3] = nz;
}

function sphereDistance(px: number, py: number, pz: number, vx: number, vy: number, vz: number, rad: number): void {
  const d = Math.sqrt(px * px + py * py + pz * pz);
  if (d > AXIS_EPS) {
    hit[0] = d - rad;
    hit[1] = px / d;
    hit[2] = py / d;
    hit[3] = pz / d;
    return;
  }
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
  hit[0] = d - rad;
  if (v > 1e-9) {
    hit[1] = -vx / v;
    hit[2] = -vy / v;
    hit[3] = -vz / v;
  } else {
    hit[1] = 0;
    hit[2] = 1;
    hit[3] = 0;
  }
}

// ------------------------------------------------------------------ kernel
export const applyColliderContacts: ApplyColliderContacts = (state, first, count, world, materials, dt, objectId, events, gx, gy, gz) => {
  const C = world.colliders;
  if (C.count === 0 || count === 0) return;
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, radius, friction, flags } = state;
  const end = first + count;

  // ---- broadphase: object AABB (+ max radius) → grid cells → candidates.
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  let rMax = 0;
  for (let i = first; i < end; i++) {
    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    const r = radius[i]!;
    if (r > rMax) rMax = r;
  }
  if (!(x1 >= x0)) return; // NaN positions: nothing sensible to collide
  x0 -= rMax;
  y0 -= rMax;
  z0 -= rMax;
  x1 += rMax;
  y1 += rMax;
  z1 += rMax;
  const G = world.grid;
  const cs = G.cellSize;
  let ca = Math.floor((x0 - G.originX) / cs);
  let cb = Math.floor((x1 - G.originX) / cs);
  let ra = Math.floor((z0 - G.originZ) / cs);
  let rb = Math.floor((z1 - G.originZ) / cs);
  if (cb < 0 || rb < 0 || ca >= G.cols || ra >= G.rows) return;
  if (ca < 0) ca = 0;
  if (ra < 0) ra = 0;
  if (cb >= G.cols) cb = G.cols - 1;
  if (rb >= G.rows) rb = G.rows - 1;
  const stamp = world.stamp;
  const epochSlot = C.count;
  let epoch = stamp[epochSlot]! + 1;
  if (epoch > 0xfffffff0) {
    stamp.fill(0);
    epoch = 1;
  }
  stamp[epochSlot] = epoch;
  const cand = world.candidates;
  const cap = cand.length;
  const aMin = C.aabbMin;
  const aMax = C.aabbMax;
  let nc = 0;
  for (let r = ra; r <= rb; r++) {
    for (let q = ca; q <= cb; q++) {
      const k = r * G.cols + q;
      const s1 = G.cellStart[k + 1]!;
      for (let s = G.cellStart[k]!; s < s1; s++) {
        const c = G.cellItems[s]!;
        if (stamp[c] === epoch) continue;
        stamp[c] = epoch;
        if (C.active[c] === 0) continue;
        const c3 = 3 * c;
        if (aMin[c3]! > x1 || aMax[c3]! < x0 || aMin[c3 + 1]! > y1 || aMax[c3 + 1]! < y0 || aMin[c3 + 2]! > z1 || aMax[c3 + 2]! < z0) continue;
        if (nc >= cap) throw new Error(`applyColliderContacts: more than ${cap} candidate colliders for object ${objectId}`);
        // Insertion keeps candidates ascending (fixed contact order).
        let j = nc++;
        while (j > 0 && cand[j - 1]! > c) {
          cand[j] = cand[j - 1]!;
          j--;
        }
        cand[j] = c;
      }
    }
  }
  if (nc === 0) {
    // Nothing near: only forget last tick's contacts.
    const mem = memoryFor(state);
    mem.fill(0, first, end);
    depthMaxFor(state).fill(0, first, end);
    return;
  }

  // ---- narrow phase + contact law
  const mem = memoryFor(state);
  const dmax = depthMaxFor(state);
  const ie2 = 1 / CONTACT_UNLOAD_E2;
  const relax = dt / CONTACT_UNLOAD_RELAX_S;
  const cooldown = cooldownsFor(state);
  const matFriction = materials.friction;
  const invDt = 1 / dt;
  const kuStab = CONTACT_UNLOAD_STAB * invDt * invDt;
  const kcStab = KC_STABILITY * invDt * invDt;
  const P = C.pos;
  const R = C.rot;
  const S = C.size;
  const SN = C.slopeNormal;
  const kinds = C.kind;
  const mats = C.material;

  for (let i = first; i < end; i++) {
    const f0 = flags[i]!;
    const im = invMass[i]!;
    if ((f0 & NODE_FLAG_COLLIDABLE) === 0 || im === 0) {
      mem[i] = 0;
      dmax[i] = 0;
      continue;
    }
    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    const rn = radius[i]!;
    let touched = 0;
    for (let q = 0; q < nc; q++) {
      const c = cand[q]!;
      const c3 = 3 * c;
      if (x + rn < aMin[c3]! || x - rn > aMax[c3]! || y + rn < aMin[c3 + 1]! || y - rn > aMax[c3 + 1]! || z + rn < aMin[c3 + 2]! || z - rn > aMax[c3 + 2]!) {
        continue;
      }
      const c9 = 9 * c;
      const r00 = R[c9]!;
      const r01 = R[c9 + 1]!;
      const r02 = R[c9 + 2]!;
      const r10 = R[c9 + 3]!;
      const r11 = R[c9 + 4]!;
      const r12 = R[c9 + 5]!;
      const r20 = R[c9 + 6]!;
      const r21 = R[c9 + 7]!;
      const r22 = R[c9 + 8]!;
      // local = Rᵀ·(p − pos)
      const dx = x - P[c3]!;
      const dy = y - P[c3 + 1]!;
      const dz = z - P[c3 + 2]!;
      const lx = r00 * dx + r10 * dy + r20 * dz;
      const ly = r01 * dx + r11 * dy + r21 * dz;
      const lz = r02 * dx + r12 * dy + r22 * dz;
      const vx = velX[i]!;
      const vy = velY[i]!;
      const vz = velZ[i]!;
      const lvx = r00 * vx + r10 * vy + r20 * vz;
      const lvy = r01 * vx + r11 * vy + r21 * vz;
      const lvz = r02 * vx + r12 * vy + r22 * vz;
      const kind = kinds[c]!;
      if (kind === ColliderKindId.box) {
        boxDistance(lx, ly, lz, lvx, lvy, lvz, S[c3]!, S[c3 + 1]!, S[c3 + 2]!);
      } else if (kind === ColliderKindId.cylinder) {
        cylinderDistance(lx, ly, lz, lvx, lvy, lvz, S[c3]!, S[c3 + 1]!);
      } else if (kind === ColliderKindId.ramp) {
        rampDistance(lx, ly, lz, lvx, lvy, lvz, S[c3]!, S[c3 + 1]!, S[c3 + 2]!, SN[c3 + 1]!, SN[c3 + 2]!);
      } else if (kind === ColliderKindId.sphere) {
        sphereDistance(lx, ly, lz, lvx, lvy, lvz, S[c3]!);
      } else {
        // plane: one-sided slab below local y = 0 over the rectangle.
        if (lx > S[c3]! || lx < -S[c3]! || lz > S[c3 + 2]! || lz < -S[c3 + 2]! || ly < -COLLIDER_PLANE_DEPTH) continue;
        hit[0] = ly;
        hit[1] = 0;
        hit[2] = 1;
        hit[3] = 0;
      }
      const depth = rn - hit[0]!;
      if (!(depth > 0)) continue;
      // World normal n = R·n_local.
      const hx = hit[1]!;
      const hy = hit[2]!;
      const hz = hit[3]!;
      const nx = r00 * hx + r01 * hy + r02 * hz;
      const ny = r10 * hx + r11 * hy + r12 * hz;
      const nz = r20 * hx + r21 * hy + r22 * hz;

      const m = 1 / im;
      const kcm = kcStab * m;
      const kc = kcm < COLLIDER_KC_MAX ? kcm : COLLIDER_KC_MAX;
      const cd = 2 * CONTACT_ZETA * Math.sqrt(kc * m);
      const vn = vx * nx + vy * ny + vz * nz;
      const dc = depth < DEPTH_CAP ? depth : DEPTH_CAP;
      const dm = dmax[i]!;
      let fs = kc * dc;
      if (dc >= dm) dmax[i] = dc;
      else {
        // unloading / reloading below the deepest point: steep line through d0 = dm·(1 − kc/ku)
        let ku = kc * ie2;
        const kum = kuStab * m;
        if (ku > kum) ku = kum;
        const fu = kc * dm - ku * (dm - dc);
        fs = fu < 0 ? 0 : fu;
        dmax[i] = dm - (dm - dc) * relax;
      }
      let fn = fs - cd * vn;
      if (fn < 0) fn = 0;
      let fx = fn * nx;
      let fy = fn * ny;
      let fz = fn * nz;

      // Implicit Coulomb (ground.ts FRICTION LAW) on accumulated force + m·g.
      const tx = vx - vn * nx;
      const ty = vy - vn * ny;
      const tz = vz - vn * nz;
      const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const mat = mats[c]!;
      const ax = frcX[i]! + m * gx;
      const ay = frcY[i]! + m * gy;
      const az = frcZ[i]! + m * gz;
      const an = ax * nx + ay * ny + az * nz;
      const mdt = m * invDt;
      const qx = -(mdt * tx + ax - an * nx);
      const qy = -(mdt * ty + ay - an * ny);
      const qz = -(mdt * tz + az - an * nz);
      const cone = friction[i]! * matFriction[mat]! * fn;
      const q2 = qx * qx + qy * qy + qz * qz;
      if (q2 > 0) {
        if (q2 <= cone * cone) {
          fx += qx;
          fy += qy;
          fz += qz;
        } else {
          const sc = cone / Math.sqrt(q2);
          fx += sc * qx;
          fy += sc * qy;
          fz += sc * qz;
        }
      }
      frcX[i] = frcX[i]! + fx;
      frcY[i] = frcY[i]! + fy;
      frcZ[i] = frcZ[i]! + fz;

      const px = x - nx * rn;
      const py = y - ny * rn;
      const pz = z - nz * rn;
      if (mem[i] === 0 && touched === 0) {
        const impulse = vn < 0 ? -vn * m : 0;
        if (impulse > IMPACT_MIN_IMPULSE) events.impact(objectId, mat, px, py, pz, nx, ny, nz, impulse);
      }
      touched = 1;
      if (vt > SKID_MIN_SLIP && fn > SKID_MIN_LOAD && cooldown[i] === 0) {
        cooldown[i] = SKID_COOLDOWN_STEPS;
        events.skid(objectId, mat, px, py, pz, vt, fn);
      }
    }
    mem[i] = touched;
    if (touched !== 0) flags[i] = flags[i]! | NODE_FLAG_IN_CONTACT;
    else dmax[i] = 0;
  }
};
