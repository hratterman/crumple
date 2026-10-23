/**
 * CARRIER SURFACES (R-PHYS2) — cargo beds, decks, walls and gates as
 * node-vs-triangle contact surfaces. WORKER ONLY (the registry `CARRIERS` is
 * plain data in ./carriers.ts).
 *
 * WHY: node-vs-node spheres leave gaps between a deck's nodes (a crate
 * corner drops between them or rides on 20 cm sphere tops). A carrier lists
 * quads of its own body nodes (floor, sides, front wall, tailgate / doors);
 * every triangle follows its nodes, so a gate that swings open (R-CRASH's
 * closures, the trailer's latched ramp) tips the cargo out by itself.
 * Registered cargo (spawnCargo) contacts these triangles instead of the
 * carrier's node spheres (the pair is excluded from node-vs-node contact).
 *
 * LAW (per cargo node, the deepest triangle it is inside of, plus the deepest one facing ≥ 60° away: a corner): signed distance
 * s = (p − A)·n − lift (n inward, `lift` = the surface above the node
 * centres), penetration δ = r − s for −SLAB < s < r; barycentric (u, v, w) of
 * the projection (inside with a small margin); m_c = 1/Σ(w_k²/m_k), m_r =
 * m_p·m_c/(m_p + m_c); k = min(CARRIER_K_MAX, 0.2·m_r/dt²), c = 2·0.65·√(k·m_r);
 * F_n = max(0, k·min(δ, 0.6r) − c·v_n), at most m_r·(PUSH_V − v_n)/dt; friction implicit on the relative
 * tangential velocity, F_t = −m_r·v_t/dt clamped to μ·F_n (μ = √(μ_node·
 * μ_deck)); F on the cargo node, −F·(u, v, w) on the triangle's nodes.
 * NUMERICS: + − × ÷ sqrt only, zero allocation in apply().
 */
import type { SimObject, SimState } from '../types';
import { NODE_FLAG_OBJ_CONTACT, SIM_OBJECT_FLAG_SLEEPING } from '../types';

export const CARRIER_K_MAX = 1e6;
/** A cargo node more than this far behind a triangle passed through it (or is under the deck): ignored. */
export const CARRIER_SLAB = 0.25;
/** Largest separating speed a contact may impart in one tick, m/s. */
export const CARRIER_PUSH_V = 0.5;
/** Barycentric margin (fraction) so seams between triangles never leak. */
const BARY_MARGIN = 0.02;

export interface CarrierRuntime {
  obj: SimObject;
  /** Object-local node indices, 3 per triangle, oriented so (B − A) × (C − A) points into the cargo space. */
  tri: Int32Array;
  /** Per triangle: 1 = surface disabled (a door opened by API). */
  off: Uint8Array;
  /** Per triangle: 1 = part of a `door` quad (setCargoDoor toggles `off` on these). */
  doors: Uint8Array;
  lift: number;
  friction: number;
  /** Registered cargo objects (spawnCargo); a cargo that leaves the carrier box is dropped at a rebuild. */
  cargo: SimObject[];
  /** Per cargo (parallel to `cargo`): the last tick one of its nodes touched a carrier surface. */
  touch: number[];
  /** Scratch per triangle (this tick): normal, A, edge dots. */
  nx: Float64Array;
  ny: Float64Array;
  nz: Float64Array;
  d00: Float64Array;
  d01: Float64Array;
  d11: Float64Array;
  inv: Float64Array;
  /** Penalty stiffness cap, N/m, and the penetration (× the node radius) the spring stops growing at. */
  kMax: number;
  penCap: number;
  /** Barycentric margin of the triangles (a face's edges reach this fraction beyond its nodes). */
  margin: number;
  /** findTri result scratch. */
  hitS: number;
  hitU: number;
  hitV: number;
  hitW: number;
}

export function createCarrierRuntime(obj: SimObject, tri: Int32Array, doors: Uint8Array, lift: number, friction: number): CarrierRuntime {
  const n = tri.length / 3;
  return {
    obj,
    tri,
    off: new Uint8Array(n),
    doors,
    lift,
    friction,
    cargo: [],
    touch: [],
    nx: new Float64Array(n),
    ny: new Float64Array(n),
    nz: new Float64Array(n),
    d00: new Float64Array(n),
    d01: new Float64Array(n),
    d11: new Float64Array(n),
    inv: new Float64Array(n),
    kMax: CARRIER_K_MAX,
    penCap: 0.6,
    margin: BARY_MARGIN,
    hitS: 0,
    hitU: 0,
    hitV: 0,
    hitW: 0,
  };
}

/** Carrier-surface contacts of every registered cargo of `c` (see the header). */
export function applyCarrier(state: SimState, c: CarrierRuntime, dt: number, tick: number, gx: number, gy: number, gz: number): void {
  if (c.cargo.length === 0) return;
  const { posX, posY, posZ, invMass, objRadius, flags } = state;
  const base = c.obj.nodeStart;
  const tri = c.tri;
  const nt = tri.length / 3;
  updateTriFrames(state, c);
  const lift = c.lift;
  const invDt = 1 / dt;
  const cargo = c.cargo;
  for (let q = 0; q < cargo.length; q++) {
    const o = cargo[q]!;
    if ((o.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
    const end = o.nodeStart + o.nodeCount;
    for (let i = o.nodeStart; i < end; i++) {
      const imp = invMass[i]!;
      if (imp === 0 || (flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const px = posX[i]!;
      const py = posY[i]!;
      const pz = posZ[i]!;
      const r = objRadius[i]!;
      // Deepest triangle containing the projection, then the deepest one facing another way (a corner node
      // presses on the deck AND a wall at once: one surface per tick lets it leak through the other).
      const t1 = findTri(state, c, base, 0, nt, lift, px, py, pz, r, -1);
      if (t1 < 0) continue;
      const s1 = c.hitS;
      const u1 = c.hitU;
      const v1 = c.hitV;
      const w1 = c.hitW;
      const t2 = findTri(state, c, base, 0, nt, lift, px, py, pz, r, t1);
      if (pushTri(state, c, i, t1, s1, u1, v1, w1, r, dt, invDt, gx, gy, gz)) c.touch[q] = tick;
      if (t2 >= 0 && pushTri(state, c, i, t2, c.hitS, c.hitU, c.hitV, c.hitW, r, dt, invDt, gx, gy, gz)) c.touch[q] = tick;
    }
  }
}

/** This tick's triangle frames (normal, edge dots) of a carrier / surface. */
export function updateTriFrames(state: SimState, c: CarrierRuntime): void {
  const { posX, posY, posZ } = state;
  const base = c.obj.nodeStart;
  const tri = c.tri;
  const nt = tri.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = base + tri[3 * t]!;
    const b = base + tri[3 * t + 1]!;
    const d = base + tri[3 * t + 2]!;
    const e0x = posX[b]! - posX[a]!;
    const e0y = posY[b]! - posY[a]!;
    const e0z = posZ[b]! - posZ[a]!;
    const e1x = posX[d]! - posX[a]!;
    const e1y = posY[d]! - posY[a]!;
    const e1z = posZ[d]! - posZ[a]!;
    let nx = e0y * e1z - e0z * e1y;
    let ny = e0z * e1x - e0x * e1z;
    let nz = e0x * e1y - e0y * e1x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-12) {
      c.inv[t] = 0;
      continue;
    }
    nx /= l;
    ny /= l;
    nz /= l;
    c.nx[t] = nx;
    c.ny[t] = ny;
    c.nz[t] = nz;
    const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
    const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
    const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const den = d00 * d11 - d01 * d01;
    c.d00[t] = d00;
    c.d01[t] = d01;
    c.d11[t] = d11;
    c.inv[t] = den > 1e-12 ? 1 / den : 0;
  }
}

/**
 * Deepest triangle of `c` whose (margin-grown) face contains the projection of the node at p and that it
 * penetrates (−SLAB < s < r). With `not` ≥ 0: only triangles whose normal is ≥ 60° off triangle `not`'s.
 * Result in c.hitS / hitU / hitV / hitW; returns the triangle or −1.
 */
export function findTri(state: SimState, c: CarrierRuntime, base: number, t0: number, t1: number, lift: number, px: number, py: number, pz: number, r: number, not: number): number {
  const { posX, posY, posZ } = state;
  const tri = c.tri;
  let best = -1;
  let bestS = Infinity;
  let bu = 0;
  let bv = 0;
  let bw = 0;
  for (let t = t0; t < t1; t++) {
    if (c.off[t] !== 0 || c.inv[t] === 0) continue;
    if (not >= 0 && c.nx[t]! * c.nx[not]! + c.ny[t]! * c.ny[not]! + c.nz[t]! * c.nz[not]! > 0.5) continue;
    const a = base + tri[3 * t]!;
    const qx = px - posX[a]!;
    const qy = py - posY[a]!;
    const qz = pz - posZ[a]!;
    const s = qx * c.nx[t]! + qy * c.ny[t]! + qz * c.nz[t]! - lift;
    if (s >= r || s <= -CARRIER_SLAB || s >= bestS) continue;
    const b = base + tri[3 * t + 1]!;
    const d = base + tri[3 * t + 2]!;
    const e0x = posX[b]! - posX[a]!;
    const e0y = posY[b]! - posY[a]!;
    const e0z = posZ[b]! - posZ[a]!;
    const e1x = posX[d]! - posX[a]!;
    const e1y = posY[d]! - posY[a]!;
    const e1z = posZ[d]! - posZ[a]!;
    const d20 = qx * e0x + qy * e0y + qz * e0z;
    const d21 = qx * e1x + qy * e1y + qz * e1z;
    const inv = c.inv[t]!;
    const v = (c.d11[t]! * d20 - c.d01[t]! * d21) * inv;
    const w = (c.d00[t]! * d21 - c.d01[t]! * d20) * inv;
    const u = 1 - v - w;
    const mg = c.margin;
    if (u < -mg || v < -mg || w < -mg) continue;
    best = t;
    bestS = s;
    bu = u < 0 ? 0 : u;
    bv = v < 0 ? 0 : v;
    bw = w < 0 ? 0 : w;
  }
  if (best < 0) return -1;
  const sum = bu + bv + bw;
  c.hitS = bestS;
  c.hitU = bu / sum;
  c.hitV = bv / sum;
  c.hitW = bw / sum;
  return best;
}

/** Contact force between cargo node i and triangle `best` (the law in the header); false when not pressing. */
export function pushTri(state: SimState, c: CarrierRuntime, i: number, best: number, bestS: number, bu: number, bv: number, bw: number, r: number, dt: number, invDt: number, gx: number, gy: number, gz: number): boolean {
  const { velX, velY, velZ, frcX, frcY, frcZ, invMass, friction } = state;
  const base = c.obj.nodeStart;
  const tri = c.tri;
  const imp = invMass[i]!;
  const a = base + tri[3 * best]!;
  const b = base + tri[3 * best + 1]!;
  const d = base + tri[3 * best + 2]!;
  const ima = invMass[a]!;
  const imb = invMass[b]!;
  const imd = invMass[d]!;
  const imc = bu * bu * ima + bv * bv * imb + bw * bw * imd;
  const imr = imp + imc;
  const mr = 1 / imr;
  let k = (0.2 * mr) / (dt * dt);
  if (k > c.kMax) k = c.kMax;
  const cdamp = 2 * 0.65 * Math.sqrt(k * mr);
  const nx = c.nx[best]!;
  const ny = c.ny[best]!;
  const nz = c.nz[best]!;
  const vcx = bu * velX[a]! + bv * velX[b]! + bw * velX[d]!;
  const vcy = bu * velY[a]! + bv * velY[b]! + bw * velY[d]!;
  const vcz = bu * velZ[a]! + bv * velZ[b]! + bw * velZ[d]!;
  const rx = velX[i]! - vcx;
  const ry = velY[i]! - vcy;
  const rz = velZ[i]! - vcz;
  const vn = rx * nx + ry * ny + rz * nz;
  let pen = r - bestS;
  const cap = c.penCap * r;
  if (pen > cap) pen = cap;
  let fn = k * pen - cdamp * vn;
  if (fn <= 0) return false;
  // Never push out faster than CARRIER_PUSH_V: a node that crosses a wall's top edge sideways is already
  // deep inside when it is first found, and the full spring would fire it off (a crate leaning over the
  // front rail flicked back at 5 m/s when it settled).
  const fmax = mr * (CARRIER_PUSH_V - vn) * invDt;
  if (fn > fmax) fn = fmax;
  // Implicit Coulomb on the relative tangential velocity.
  const tx = rx - vn * nx;
  const ty = ry - vn * ny;
  const tz = rz - vn * nz;
  let fx = fn * nx;
  let fy = fn * ny;
  let fz = fn * nz;
  // Request: stop the relative slide this tick AND hold the node's own tangential load (accumulated
  // force + its weight, its share m_r/m_p): without the load term a crate creeps down a tilted deck.
  const mp = 1 / imp;
  const sh = mr * imp;
  let lx = frcX[i]! + mp * gx;
  let ly = frcY[i]! + mp * gy;
  let lz = frcZ[i]! + mp * gz;
  const ln = lx * nx + ly * ny + lz * nz;
  lx -= ln * nx;
  ly -= ln * ny;
  lz -= ln * nz;
  const req = mr * invDt;
  let ftx = -req * tx - sh * lx;
  let fty = -req * ty - sh * ly;
  let ftz = -req * tz - sh * lz;
  const ft2 = ftx * ftx + fty * fty + ftz * ftz;
  if (ft2 > 0) {
    const mu = Math.sqrt(friction[i]! * c.friction);
    const ft = Math.sqrt(ft2);
    const lim = mu * fn;
    if (ft > lim) {
      const sc = lim / ft;
      ftx *= sc;
      fty *= sc;
      ftz *= sc;
    }
    fx += ftx;
    fy += fty;
    fz += ftz;
  }
  fn = 0;
  frcX[i] = frcX[i]! + fx;
  frcY[i] = frcY[i]! + fy;
  frcZ[i] = frcZ[i]! + fz;
  frcX[a] = frcX[a]! - bu * fx;
  frcY[a] = frcY[a]! - bu * fy;
  frcZ[a] = frcZ[a]! - bu * fz;
  frcX[b] = frcX[b]! - bv * fx;
  frcY[b] = frcY[b]! - bv * fy;
  frcZ[b] = frcZ[b]! - bv * fz;
  frcX[d] = frcX[d]! - bw * fx;
  frcY[d] = frcY[d]! - bw * fy;
  frcZ[d] = frcZ[d]! - bw * fz;
  return true;
}
