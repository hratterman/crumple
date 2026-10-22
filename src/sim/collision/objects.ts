/**
 * NODE-VS-NODE contact between objects (P5, U1; docs/CONTRACTS.md "Sim
 * (U1)"). WORKER ONLY.
 *
 * BROADPHASE (`rebuild`, every OBJ_REBUILD_TICKS ticks; the engine fills the
 * per-object slots first): object pairs (slot order = ascending objectId,
 * lower first), at least one awake, whose node-centre boxes come within
 * pad = r_maxA + r_maxB + margin (margin = (v_maxA + v_maxB)·interval·dt +
 * OBJ_MARGIN: the velocity-fattened AABB test) → each object's contact
 * nodes within pad of the other's box → candidate node pairs with
 * |p_a − p_b| < r_a + r_b + margin. Small sets are tested brute force, large ones
 * through a spatial hash of B's nodes (cell = r_maxA + r_maxB + margin, 27
 * neighbour cells, candidates sorted + deduped). Pairs come out in
 * CANONICAL order (lower objectId node first, then node a, then b; global
 * node indices ascend with objectId); the per-pair contact flag survives a
 * rebuild by a sorted merge with the previous list. Capacity
 * OBJ_PAIR_CAPACITY per rebuild; the tail beyond it is dropped (counted).
 *
 * CONTACT LAW (`applyObjectContacts`, every tick, canonical pair order):
 *   d = p_b − p_a, depth = r_a + r_b − |d|, n = d/|d| (A → B)
 *   m_r = m_a·m_b/(m_a + m_b); a STATIC side (sleeping object or pinned
 *   node) has infinite mass: m_r = the free side's mass, and gets no force
 *   k = min(OBJ_KC_MAX, OBJ_KC_STABILITY·m_r/dt²) / s,  c = 2·ζ·sqrt(k·m_r)
 *   Fn = max(0, k·min(depth, cap) − c·(v_rel·n)),  cap = OBJ_DEPTH_CAP·min(r_a, r_b)
 *   friction: implicit backward-Euler on the relative tangential velocity,
 *   F_req = −m_r·v_t/(dt·s) clamped to μ·Fn, μ = sqrt(μ_a·μ_b)
 *   B gets +Fn·n + F_t, A the opposite.
 *   s = max(contacts of node a, contacts of node b) during the previous
 *   tick (≥ 1): MULTI-CONTACT NORMALIZATION (U1 amendment): a light prop
 *   node pressed by several overlapping car-node spheres otherwise sums
 *   several springs/dampers each at the stability limit (4 contacts:
 *   Σc·dt/m ≈ 2.3 > 2, the damper diverges) and several friction requests
 *   each stopping the full slip (overshoot chatter).
 * EVENTS: impact for BOTH objects (lower id first) on the tick a pair
 * enters contact, when m_r·approach speed ≥ OBJ_IMPACT_MIN_IMPULSE
 * (materialId = the OTHER object's material; normal into the receiving
 * object; point = between the sphere surfaces); skid for each free side
 * sliding faster than the ground's SKID_MIN_SLIP under SKID_MIN_LOAD, with
 * the shared per-node cooldown.
 *
 * NUMERICS: hot loop: only + − × ÷ sqrt, fixed order, no allocation (all
 * scratch is preallocated in the ObjectContacts instance).
 */
import { NODE_FLAG_OBJ_CONTACT, NODE_FLAG_OBJ_IMPACT, NODE_FLAG_OBJ_TOUCH, type EventSink, type SimState } from '../types';
import { cooldownsFor, SKID_COOLDOWN_STEPS, SKID_MIN_LOAD, SKID_MIN_SLIP } from './ground';

export const OBJ_KC_MAX = 8e6;
export const OBJ_KC_STABILITY = 0.2;
export const OBJ_CONTACT_ZETA = 0.65;
/** N·s: impacts below this approach momentum are not reported. */
export const OBJ_IMPACT_MIN_IMPULSE = 2;
export const OBJ_PAIR_CAPACITY = 32768;
/** Rebuild interval, ticks (OBJ_REBUILD_TICKS_SLOW while every awake object is slower than OBJ_SLOW_SPEED). */
export const OBJ_REBUILD_TICKS = 8;
export const OBJ_REBUILD_TICKS_SLOW = 16;
export const OBJ_SLOW_SPEED = 2;
/** Constant broadphase margin on top of the motion bound, m. */
export const OBJ_MARGIN = 0.02;
/** The penalty spring uses min(depth, OBJ_DEPTH_CAP·min(r_a, r_b)): a tunnelled pair separates over a few ticks instead of exploding. */
export const OBJ_DEPTH_CAP = 0.6;
/**
 * R-CRASH hysteretic contact (Walton–Braun, as colliders.ts CONTACT_UNLOAD_E2): a pair's spring loads at k
 * and unloads at k/e² from the deepest (capped) depth of the contact, d0 = d_max·(1 − e²); the remembered
 * depth relaxes toward the current one with OBJ_UNLOAD_RELAX_S. WHY: car-to-car the penalty springs of the
 * touching node spheres (k ≤ 1 MN/m, 10–15 cm deep) gave their energy back: a 6.5 t truck at 50 km/h into
 * a parked sedan's side threw the sedan off at 14 m/s, faster than the truck (restitution 0.29; real side
 * impacts ≈ 0–0.1). Measured after: crashPair.test.ts.
 */
export const OBJ_UNLOAD_E2 = 0.05;
/** Approach speed (m/s) from which a contact flags NODE_FLAG_OBJ_IMPACT (≈ 11 km/h: parking bumps stay below). */
export const OBJ_IMPACT_RELEASE_SPEED = 3;
export const OBJ_UNLOAD_RELAX_S = 0.2;
/** Unloading stiffness cap × m_r/dt² (ω·dt = 1; see colliders.ts CONTACT_UNLOAD_STAB). */
export const OBJ_UNLOAD_STAB = 1.0;
/**
 * Unloading deadband, m: within this much of the deepest point the pair stays on its loading line (k·d);
 * the stiff unloading line only takes over beyond it (continuous at the band edge). WHY: a light node
 * (a box-truck wall sheet node, 2–3 kg) rattling in a sustained contact unloaded on the stiff line on every
 * millimetre-scale vibration: the averaged contact force fell and the struck wall kept a 11 cm dent where
 * the plain spring left 16 cm (boxtruck.test.ts side hit). Macro unloading (a car leaving a car) is
 * centimetres: unchanged.
 */
export const OBJ_UNLOAD_BAND = 0.005;

const FLAG_STATIC_A = 1;
const FLAG_STATIC_B = 2;
const FLAG_IN_CONTACT = 4;
/** Above this many node-pair tests per object pair the B side is hashed. */
const BRUTE_MAX = 2048;
/** Hash table: next power of two ≥ 2 × B's node count, at most HASH_MAX buckets (cleared per object pair). */
const HASH_MIN = 64;
const HASH_MAX = 4096;
/** Max hashed B candidates gathered for one A node (more are a dense pile; the tail is ignored). */
const GATHER_MAX = 256;
/** Pair key = a·KEY_SHIFT + b (node indices < 2^24: exact in f64). */
const KEY_SHIFT = 16777216;

export interface ObjectContactStats {
  /** Pairs in the current list. */
  pairs: number;
  /** Node-pair distance tests of the last rebuild (brute force + hashed). */
  candidatesTested: number;
  /** Pairs dropped by the capacity (cumulative). */
  overflow: number;
  rebuilds: number;
  /** Pairs in contact during the last tick. */
  active: number;
  /** Profiling (only while `ObjectContacts.profile`): cumulative ms in rebuild / apply, node-pair tests, pair-ticks applied. */
  rebuildMs: number;
  applyMs: number;
  testsTotal: number;
  pairTicks: number;
}

/**
 * Preallocated broadphase + pair state for one SimState. The engine fills
 * the per-object slots (`setObject`) before each `rebuild`.
 */
export class ObjectContacts {
  readonly maxObjects: number;
  // ---- per object slot (slot = index in arena.objects at rebuild time)
  readonly oStart: Int32Array;
  readonly oCount: Int32Array;
  readonly oId: Float64Array;
  /**
   * R-PHYS2 (additive): object pairs with NO node-vs-node contact (`pairKey(idA, idB)`), e.g. a carrier and
   * the cargo it holds through its deck surfaces (src/sim/trailer/carrier.ts). Checked once per object pair
   * per rebuild.
   */
  readonly excludedPairs = new Set<number>();
  /**
   * R-PHYS2: object pairs kept on node-vs-node spheres even when both collide through triangles (a trailer and
   * its tow vehicle: the coupler sits on the hitch ball, the drawbar under the bumper — only the spheres know to
   * skip the tongue). Shared with TriangleContacts (`excludedPairs`), which skips these pairs.
   */
  readonly triExcludedPairs = new Set<number>();
  readonly oMat: Uint8Array;
  /** 1 = sleeping (static). */
  readonly oStatic: Uint8Array;
  /** 1 = has a valid box (some contact node). */
  readonly oValid: Uint8Array;
  /** Node-centre box min xyz / max xyz (6 per slot). */
  readonly oBox: Float64Array;
  readonly oVmax: Float64Array;
  readonly oRmax: Float64Array;
  /**
   * R-CORE: 1 = the slot collides through its triangles (SolverOptions.triangleContact):
   * a pair of two such slots gets node-vs-triangle contact instead of spheres.
   */
  readonly oTriangles: Uint8Array;
  objectCount = 0;
  // ---- pair list (canonical order)
  pairA: Int32Array;
  pairB: Int32Array;
  pairIdA: Float64Array;
  pairIdB: Float64Array;
  pairMatA: Uint8Array;
  pairMatB: Uint8Array;
  pairMu: Float64Array;
  pairFlags: Uint8Array;
  /** Deepest (capped) depth of the pair's current contact, m (OBJ_UNLOAD_E2); carried across rebuilds. */
  pairDmax: Float64Array;
  pairCount = 0;
  /** Pair sort keys a·2^24 + b (exact in f64) + merge-sort scratch. */
  private keys: Float64Array;
  private keysTmp: Float64Array;
  private keyCount = 0;
  // previous list (merge source for the contact flags)
  private prevA: Int32Array;
  private prevB: Int32Array;
  private prevFlags: Uint8Array;
  private prevDmax: Float64Array;
  // ---- per node scratch
  /** Contacts per node: previous tick (read) / this tick (written); swapped every tick. */
  private cntPrev: Uint8Array;
  private cntCur: Uint8Array;
  /** Nodes flagged NODE_FLAG_OBJ_TOUCH on the previous tick (cleared at the next apply). */
  private readonly touched: Int32Array;
  private touchedCount = 0;
  private staleTouch = false;
  private readonly listA: Int32Array;
  private readonly listB: Int32Array;
  // ---- hash (CSR over B's list)
  private readonly bucketStart: Int32Array;
  private readonly bucketFill: Int32Array;
  private readonly bucketItems: Int32Array;
  private readonly cellKey: Int32Array;
  private readonly gather: Int32Array;
  readonly stats: ObjectContactStats = {
    pairs: 0,
    candidatesTested: 0,
    overflow: 0,
    rebuilds: 0,
    active: 0,
    rebuildMs: 0,
    applyMs: 0,
    testsTotal: 0,
    pairTicks: 0,
  };
  /** Accumulate timings into `stats` (perf probes / tests; off in the game). */
  profile = false;

  constructor(nodeCapacity: number, maxObjects: number, pairCapacity = OBJ_PAIR_CAPACITY) {
    this.maxObjects = maxObjects;
    this.oStart = new Int32Array(maxObjects);
    this.oCount = new Int32Array(maxObjects);
    this.oId = new Float64Array(maxObjects);
    this.oMat = new Uint8Array(maxObjects);
    this.oStatic = new Uint8Array(maxObjects);
    this.oValid = new Uint8Array(maxObjects);
    this.oBox = new Float64Array(6 * maxObjects);
    this.oVmax = new Float64Array(maxObjects);
    this.oRmax = new Float64Array(maxObjects);
    this.oTriangles = new Uint8Array(maxObjects);
    this.pairA = new Int32Array(pairCapacity);
    this.pairB = new Int32Array(pairCapacity);
    this.pairIdA = new Float64Array(pairCapacity);
    this.pairIdB = new Float64Array(pairCapacity);
    this.pairMatA = new Uint8Array(pairCapacity);
    this.pairMatB = new Uint8Array(pairCapacity);
    this.pairMu = new Float64Array(pairCapacity);
    this.pairFlags = new Uint8Array(pairCapacity);
    this.pairDmax = new Float64Array(pairCapacity);
    this.keys = new Float64Array(pairCapacity);
    this.keysTmp = new Float64Array(pairCapacity);
    this.prevA = new Int32Array(pairCapacity);
    this.prevB = new Int32Array(pairCapacity);
    this.prevFlags = new Uint8Array(pairCapacity);
    this.prevDmax = new Float64Array(pairCapacity);
    this.cntPrev = new Uint8Array(nodeCapacity);
    this.cntCur = new Uint8Array(nodeCapacity);
    this.touched = new Int32Array(2 * pairCapacity);
    this.listA = new Int32Array(nodeCapacity);
    this.listB = new Int32Array(nodeCapacity);
    this.bucketStart = new Int32Array(HASH_MAX + 1);
    this.bucketFill = new Int32Array(HASH_MAX);
    this.bucketItems = new Int32Array(nodeCapacity);
    this.cellKey = new Int32Array(nodeCapacity);
    this.gather = new Int32Array(GATHER_MAX);
  }

  /** Forgets every pair and contact flag (spawn/despawn shift global node indices). */
  clear(): void {
    // node indices shift on spawn / despawn: drop the touched list (the re-packed flags are cleared lazily)
    this.touchedCount = 0;
    this.staleTouch = true;
    this.pairCount = 0;
    this.stats.pairs = 0;
    this.stats.active = 0;
  }

  /**
   * Computes slot `o`'s node-centre box over its contact nodes from the
   * CURRENT positions, its max node speed (all free nodes) and max contact
   * radius. Sleeping objects pass their stored box via `setStaticBox`.
   * Returns the max node speed.
   */
  measureObject(state: SimState, o: number, start: number, count: number, objectId: number, mat: number): number {
    const { posX, posY, posZ, velX, velY, velZ, invMass, objRadius, flags } = state;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    let v2 = 0;
    let rmax = 0;
    const end = start + count;
    for (let i = start; i < end; i++) {
      if (invMass[i] !== 0) {
        const s = velX[i]! * velX[i]! + velY[i]! * velY[i]! + velZ[i]! * velZ[i]!;
        if (s > v2) v2 = s;
      }
      if ((flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const x = posX[i]!;
      const y = posY[i]!;
      const z = posZ[i]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      const r = objRadius[i]!;
      if (r > rmax) rmax = r;
    }
    const b = 6 * o;
    this.oStart[o] = start;
    this.oCount[o] = count;
    this.oId[o] = objectId;
    this.oMat[o] = mat;
    this.oStatic[o] = 0;
    this.oValid[o] = x0 <= x1 ? 1 : 0;
    this.oBox[b] = x0;
    this.oBox[b + 1] = y0;
    this.oBox[b + 2] = z0;
    this.oBox[b + 3] = x1;
    this.oBox[b + 4] = y1;
    this.oBox[b + 5] = z1;
    this.oRmax[o] = rmax;
    const v = Math.sqrt(v2);
    this.oVmax[o] = v;
    return v;
  }

  /** Slot `o` is a SLEEPING object: static, with its stored node-centre box and max contact radius. */
  setStaticBox(o: number, start: number, count: number, objectId: number, mat: number, box: Float64Array, boxOffset: number, rmax: number): void {
    this.oStart[o] = start;
    this.oCount[o] = count;
    this.oId[o] = objectId;
    this.oMat[o] = mat;
    this.oStatic[o] = 1;
    this.oValid[o] = box[boxOffset]! <= box[boxOffset + 3]! ? 1 : 0;
    for (let k = 0; k < 6; k++) this.oBox[6 * o + k] = box[boxOffset + k]!;
    this.oVmax[o] = 0;
    this.oRmax[o] = rmax;
  }

  /** True when the node-centre boxes of slots p and q are within `pad` of each other on every axis. */
  boxesNear(p: number, q: number, pad: number): boolean {
    const a = 6 * p;
    const b = 6 * q;
    const B = this.oBox;
    return (
      B[a]! <= B[b + 3]! + pad &&
      B[b]! <= B[a + 3]! + pad &&
      B[a + 1]! <= B[b + 4]! + pad &&
      B[b + 1]! <= B[a + 4]! + pad &&
      B[a + 2]! <= B[b + 5]! + pad &&
      B[b + 2]! <= B[a + 5]! + pad
    );
  }

  /** Broadphase margin of a slot pair: motion bound over the interval + OBJ_MARGIN. */
  margin(p: number, q: number, interval: number, dt: number): number {
    return (this.oVmax[p]! + this.oVmax[q]!) * interval * dt + OBJ_MARGIN;
  }

  /**
   * Rebuilds the pair list over slots [0, objectCount) (node-centre boxes,
   * radii and speeds filled by the caller), keeping the contact flags of
   * pairs that persist.
   */
  rebuild(state: SimState, interval: number, dt: number, friction: Float64Array): void {
    if (!this.profile) {
      this.rebuildInner(state, interval, dt, friction);
      return;
    }
    const t0 = performance.now();
    this.rebuildInner(state, interval, dt, friction);
    this.stats.rebuildMs += performance.now() - t0;
    this.stats.testsTotal += this.stats.candidatesTested;
  }

  private rebuildInner(state: SimState, interval: number, dt: number, friction: Float64Array): void {
    // Previous list becomes the merge source.
    let t32 = this.prevA;
    this.prevA = this.pairA;
    this.pairA = t32;
    t32 = this.prevB;
    this.prevB = this.pairB;
    this.pairB = t32;
    const t8 = this.prevFlags;
    this.prevFlags = this.pairFlags;
    this.pairFlags = t8;
    const t64 = this.prevDmax;
    this.prevDmax = this.pairDmax;
    this.pairDmax = t64;
    const prevCount = this.pairCount;
    this.pairCount = 0;
    this.keyCount = 0;
    this.stats.candidatesTested = 0;
    const n = this.objectCount;
    // Only pairs with an awake member: O(awake × objects), not O(objects²) (sleeping props cost ~0).
    for (let p = 0; p < n; p++) {
      if (this.oValid[p] === 0 || this.oStatic[p] !== 0) continue;
      for (let q = 0; q < n; q++) {
        if (q === p || this.oValid[q] === 0) continue;
        if (q < p && this.oStatic[q] === 0) continue; // awake–awake pairs once, from the lower slot
        const lo = p < q ? p : q;
        const hi = p < q ? q : p;
        if (this.oTriangles[lo] !== 0 && this.oTriangles[hi] !== 0 && !(this.triExcludedPairs.size > 0 && this.triExcludedPairs.has(pairKey(this.oId[lo]!, this.oId[hi]!)))) continue; // R-CORE: triangle contact instead
        if (this.excludedPairs.size > 0 && this.excludedPairs.has(pairKey(this.oId[lo]!, this.oId[hi]!))) continue;
        const margin = this.margin(lo, hi, interval, dt);
        if (!this.boxesNear(lo, hi, this.oRmax[lo]! + this.oRmax[hi]! + margin)) continue;
        this.pairObjects(state, lo, hi, margin);
      }
    }
    this.sortKeys();
    this.materialize(state, friction);
    // Carry the in-contact flag of persisting pairs (both lists sorted by (a, b)).
    let j = 0;
    const pa = this.pairA;
    const pb = this.pairB;
    const fl = this.pairFlags;
    for (let i = 0; i < this.pairCount && j < prevCount; i++) {
      const a = pa[i]!;
      const b = pb[i]!;
      while (j < prevCount && (this.prevA[j]! < a || (this.prevA[j] === a && this.prevB[j]! < b))) j++;
      if (j < prevCount && this.prevA[j] === a && this.prevB[j] === b) {
        fl[i] = fl[i]! | (this.prevFlags[j]! & FLAG_IN_CONTACT);
        this.pairDmax[i] = this.prevDmax[j]!;
      }
    }
    // Fresh per-node contact counts for the new list's nodes.
    for (let i = 0; i < this.pairCount; i++) {
      this.cntPrev[pa[i]!] = 0;
      this.cntPrev[pb[i]!] = 0;
    }
    for (let i = 0; i < this.pairCount; i++) {
      if ((fl[i]! & FLAG_IN_CONTACT) !== 0) {
        this.cntPrev[pa[i]!]!++;
        this.cntPrev[pb[i]!]!++;
      }
    }
    this.stats.pairs = this.pairCount;
    this.stats.rebuilds++;
  }

  /** Collects the contact nodes of slot `o` whose centre lies within `pad` of slot `box`'s node box. */
  private collect(state: SimState, o: number, box: number, pad: number, out: Int32Array): number {
    const { posX, posY, posZ, flags } = state;
    const B = this.oBox;
    const b = 6 * box;
    const x0 = B[b]! - pad;
    const y0 = B[b + 1]! - pad;
    const z0 = B[b + 2]! - pad;
    const x1 = B[b + 3]! + pad;
    const y1 = B[b + 4]! + pad;
    const z1 = B[b + 5]! + pad;
    const start = this.oStart[o]!;
    const end = start + this.oCount[o]!;
    let n = 0;
    for (let i = start; i < end; i++) {
      if ((flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const x = posX[i]!;
      const y = posY[i]!;
      const z = posZ[i]!;
      if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
      out[n++] = i;
    }
    return n;
  }

  private pairObjects(state: SimState, p: number, q: number, margin: number): void {
    const pad = this.oRmax[p]! + this.oRmax[q]! + margin;
    const la = this.collect(state, p, q, pad, this.listA);
    if (la === 0) return;
    const lb = this.collect(state, q, p, pad, this.listB);
    if (lb === 0) return;
    const { posX, posY, posZ, objRadius } = state;
    const listA = this.listA;
    const listB = this.listB;
    if (la * lb <= BRUTE_MAX) {
      this.stats.candidatesTested += la * lb;
      for (let ia = 0; ia < la; ia++) {
        const a = listA[ia]!;
        const ax = posX[a]!;
        const ay = posY[a]!;
        const az = posZ[a]!;
        const ra = objRadius[a]! + margin;
        for (let ib = 0; ib < lb; ib++) {
          const b = listB[ib]!;
          const dx = posX[b]! - ax;
          const dy = posY[b]! - ay;
          const dz = posZ[b]! - az;
          const lim = ra + objRadius[b]!;
          if (dx * dx + dy * dy + dz * dz >= lim * lim) continue;
          if (!this.push(a, b)) return;
        }
      }
      return;
    }
    // Spatial hash of B's nodes: cell = rmaxA + rmaxB + margin, so every partner lies in the 27 neighbours.
    const cell = this.oRmax[p]! + this.oRmax[q]! + margin;
    const inv = 1 / cell;
    const B = this.oBox;
    const ox = B[6 * p]!;
    const oy = B[6 * p + 1]!;
    const oz = B[6 * p + 2]!;
    const start = this.bucketStart;
    const fill = this.bucketFill;
    const items = this.bucketItems;
    const key = this.cellKey;
    let size = HASH_MIN;
    while (size < 2 * lb && size < HASH_MAX) size *= 2;
    const mask = size - 1;
    start.fill(0, 0, size + 1);
    for (let ib = 0; ib < lb; ib++) {
      const b = listB[ib]!;
      const h = cellHash(Math.floor((posX[b]! - ox) * inv), Math.floor((posY[b]! - oy) * inv), Math.floor((posZ[b]! - oz) * inv)) & mask;
      key[ib] = h;
      start[h + 1]!++;
    }
    for (let h = 0; h < size; h++) {
      start[h + 1]! += start[h]!;
      fill[h] = start[h]!;
    }
    for (let ib = 0; ib < lb; ib++) items[fill[key[ib]!]!++] = listB[ib]!;
    const g = this.gather;
    for (let ia = 0; ia < la; ia++) {
      const a = listA[ia]!;
      const ax = posX[a]!;
      const ay = posY[a]!;
      const az = posZ[a]!;
      const cx = Math.floor((ax - ox) * inv);
      const cy = Math.floor((ay - oy) * inv);
      const cz = Math.floor((az - oz) * inv);
      let ng = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const h = cellHash(cx + dx, cy + dy, cz + dz) & mask;
            const e = start[h + 1]!;
            for (let k = start[h]!; k < e && ng < GATHER_MAX; k++) g[ng++] = items[k]!;
          }
        }
      }
      // Insertion sort (small) then dedupe: canonical b order, buckets may repeat through hash collisions.
      for (let k = 1; k < ng; k++) {
        const v = g[k]!;
        let m = k - 1;
        while (m >= 0 && g[m]! > v) {
          g[m + 1] = g[m]!;
          m--;
        }
        g[m + 1] = v;
      }
      const ra = objRadius[a]! + margin;
      let last = -1;
      for (let k = 0; k < ng; k++) {
        const b = g[k]!;
        if (b === last) continue;
        last = b;
        this.stats.candidatesTested++;
        const dx = posX[b]! - ax;
        const dy = posY[b]! - ay;
        const dz = posZ[b]! - az;
        const lim = ra + objRadius[b]!;
        if (dx * dx + dy * dy + dz * dz >= lim * lim) continue;
        if (!this.push(a, b)) return;
      }
    }
  }

  /** Appends a candidate key; false (and counts the overflow) when the list is full. */
  private push(a: number, b: number): boolean {
    if (this.keyCount >= this.keys.length) {
      this.stats.overflow++;
      return false;
    }
    this.keys[this.keyCount++] = a * KEY_SHIFT + b;
    return true;
  }

  /** Bottom-up merge sort of keys[0, keyCount) (allocation-free; runs are already sorted per object pair). */
  private sortKeys(): void {
    const n = this.keyCount;
    let src = this.keys;
    let dst = this.keysTmp;
    for (let w = 1; w < n; w *= 2) {
      for (let lo = 0; lo < n; lo += 2 * w) {
        const mid = lo + w < n ? lo + w : n;
        const hi = lo + 2 * w < n ? lo + 2 * w : n;
        let i = lo;
        let j = mid;
        let k = lo;
        while (i < mid && j < hi) dst[k++] = src[i]! <= src[j]! ? src[i++]! : src[j++]!;
        while (i < mid) dst[k++] = src[i++]!;
        while (j < hi) dst[k++] = src[j++]!;
      }
      const t = src;
      src = dst;
      dst = t;
    }
    if (src !== this.keys) {
      this.keysTmp = this.keys;
      this.keys = src;
    }
  }

  /** Slot owning arena node `i` (slots are packed in ascending node ranges). */
  private ownerSlot(i: number): number {
    let lo = 0;
    let hi = this.objectCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.oStart[mid]! <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Sorted keys → pair arrays (owners, materials, μ, static flags). */
  private materialize(state: SimState, friction: Float64Array): void {
    const invMass = state.invMass;
    const keys = this.keys;
    let m = 0;
    for (let i = 0; i < this.keyCount; i++) {
      const key = keys[i]!;
      const a = Math.floor(key / KEY_SHIFT);
      const b = key - a * KEY_SHIFT;
      const p = this.ownerSlot(a);
      const q = this.ownerSlot(b);
      let f = (this.oStatic[p] !== 0 ? FLAG_STATIC_A : 0) | (this.oStatic[q] !== 0 ? FLAG_STATIC_B : 0);
      if (invMass[a] === 0) f |= FLAG_STATIC_A;
      if (invMass[b] === 0) f |= FLAG_STATIC_B;
      if ((f & (FLAG_STATIC_A | FLAG_STATIC_B)) === (FLAG_STATIC_A | FLAG_STATIC_B)) continue;
      this.pairA[m] = a;
      this.pairB[m] = b;
      this.pairIdA[m] = this.oId[p]!;
      this.pairIdB[m] = this.oId[q]!;
      this.pairMatA[m] = this.oMat[p]!;
      this.pairMatB[m] = this.oMat[q]!;
      this.pairMu[m] = Math.sqrt(friction[a]! * friction[b]!);
      this.pairFlags[m] = f;
      this.pairDmax[m] = 0;
      m++;
    }
    this.pairCount = m;
  }

  /** One tick of contact forces over the pair list (see header). */
  apply(state: SimState, dt: number, events: EventSink): void {
    if (!this.profile) {
      this.applyInner(state, dt, events);
      return;
    }
    const t0 = performance.now();
    this.applyInner(state, dt, events);
    this.stats.applyMs += performance.now() - t0;
    this.stats.pairTicks += this.pairCount;
  }

  private applyInner(state: SimState, dt: number, events: EventSink): void {
    const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, objRadius } = state;
    const cooldown = cooldownsFor(state);
    const pa = this.pairA;
    const pb = this.pairB;
    const fl = this.pairFlags;
    const mu = this.pairMu;
    const dmax = this.pairDmax;
    const ie2 = 1 / OBJ_UNLOAD_E2;
    const relax = dt / OBJ_UNLOAD_RELAX_S;
    const prev = this.cntPrev;
    const cur = this.cntCur;
    const n = this.pairCount;
    const invDt = 1 / dt;
    const kuStab = OBJ_UNLOAD_STAB * invDt * invDt;
    const kStab = OBJ_KC_STABILITY * invDt * invDt;
    for (let i = 0; i < n; i++) {
      cur[pa[i]!] = 0;
      cur[pb[i]!] = 0;
    }
    const nflags = state.flags;
    const touched = this.touched;
    for (let i = 0; i < this.touchedCount; i++) {
      const t = touched[i]!;
      nflags[t] = nflags[t]! & ~(NODE_FLAG_OBJ_TOUCH | NODE_FLAG_OBJ_IMPACT);
    }
    if (this.staleTouch) {
      this.staleTouch = false;
      for (let i = 0; i < state.nodeCount; i++) nflags[i] = nflags[i]! & ~(NODE_FLAG_OBJ_TOUCH | NODE_FLAG_OBJ_IMPACT);
    }
    let nt = 0;
    let active = 0;
    for (let i = 0; i < n; i++) {
      const a = pa[i]!;
      const b = pb[i]!;
      const f = fl[i]!;
      const dx = posX[b]! - posX[a]!;
      const dy = posY[b]! - posY[a]!;
      const dz = posZ[b]! - posZ[a]!;
      const ra = objRadius[a]!;
      const rb = objRadius[b]!;
      const rs = ra + rb;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rs * rs || d2 === 0) {
        fl[i] = f & ~FLAG_IN_CONTACT;
        dmax[i] = 0;
        continue;
      }
      active++;
      cur[a]!++;
      cur[b]!++;
      if ((nflags[a]! & NODE_FLAG_OBJ_TOUCH) === 0) {
        nflags[a] = nflags[a]! | NODE_FLAG_OBJ_TOUCH;
        touched[nt++] = a;
      }
      if ((nflags[b]! & NODE_FLAG_OBJ_TOUCH) === 0) {
        nflags[b] = nflags[b]! | NODE_FLAG_OBJ_TOUCH;
        touched[nt++] = b;
      }
      const dist = Math.sqrt(d2);
      const inv = 1 / dist;
      const nx = dx * inv;
      const ny = dy * inv;
      const nz = dz * inv;
      const staticA = (f & FLAG_STATIC_A) !== 0;
      const staticB = (f & FLAG_STATIC_B) !== 0;
      const ima = staticA ? 0 : invMass[a]!;
      const imb = staticB ? 0 : invMass[b]!;
      const mr = 1 / (ima + imb);
      const sa = prev[a]!;
      const sb = prev[b]!;
      const s = sa > sb ? sa : sb > 1 ? sb : 1;
      let k = kStab * mr;
      if (k > OBJ_KC_MAX) k = OBJ_KC_MAX;
      k = k / s;
      const c = 2 * OBJ_CONTACT_ZETA * Math.sqrt(k * mr);
      // Relative velocity of B w.r.t. A (a static side moves with zero velocity).
      const vax = staticA ? 0 : velX[a]!;
      const vay = staticA ? 0 : velY[a]!;
      const vaz = staticA ? 0 : velZ[a]!;
      const rvx = (staticB ? 0 : velX[b]!) - vax;
      const rvy = (staticB ? 0 : velY[b]!) - vay;
      const rvz = (staticB ? 0 : velZ[b]!) - vaz;
      const vn = rvx * nx + rvy * ny + rvz * nz;
      if (vn < -OBJ_IMPACT_RELEASE_SPEED) {
        nflags[a] = nflags[a]! | NODE_FLAG_OBJ_IMPACT;
        nflags[b] = nflags[b]! | NODE_FLAG_OBJ_IMPACT;
      }
      let depth = rs - dist;
      const cap = OBJ_DEPTH_CAP * (ra < rb ? ra : rb);
      if (depth > cap) depth = cap;
      // hysteretic spring: unloads at k/e² below the contact's deepest point
      const dm = dmax[i]!;
      let fs = k * depth;
      if (depth >= dm) dmax[i] = depth;
      else {
        let ku = k * ie2;
        const kum = (kuStab * mr) / s;
        if (ku > kum) ku = kum;
        const excess = dm - depth - OBJ_UNLOAD_BAND;
        if (excess > 0) {
          const fu = fs - (ku - k) * excess;
          fs = fu < 0 ? 0 : fu;
        }
        dmax[i] = dm - (dm - depth) * relax;
      }
      let fn = fs - c * vn;
      if (fn < 0) fn = 0;
      // Implicit Coulomb on the relative tangential velocity.
      const tx = rvx - vn * nx;
      const ty = rvy - vn * ny;
      const tz = rvz - vn * nz;
      const req = -mr * invDt / s;
      let fx = req * tx;
      let fy = req * ty;
      let fz = req * tz;
      const cone = mu[i]! * fn;
      const f2 = fx * fx + fy * fy + fz * fz;
      if (f2 > cone * cone) {
        const sc = cone / Math.sqrt(f2);
        fx *= sc;
        fy *= sc;
        fz *= sc;
      }
      fx += fn * nx;
      fy += fn * ny;
      fz += fn * nz;
      if (!staticB) {
        frcX[b] = frcX[b]! + fx;
        frcY[b] = frcY[b]! + fy;
        frcZ[b] = frcZ[b]! + fz;
      }
      if (!staticA) {
        frcX[a] = frcX[a]! - fx;
        frcY[a] = frcY[a]! - fy;
        frcZ[a] = frcZ[a]! - fz;
      }
      // Contact point between the two sphere surfaces.
      const t = ra - 0.5 * (rs - dist);
      const px = posX[a]! + nx * t;
      const py = posY[a]! + ny * t;
      const pz = posZ[a]! + nz * t;
      if ((f & FLAG_IN_CONTACT) === 0) {
        fl[i] = f | FLAG_IN_CONTACT;
        const impulse = vn < 0 ? -vn * mr : 0;
        if (impulse >= OBJ_IMPACT_MIN_IMPULSE) {
          events.impact(this.pairIdA[i]!, this.pairMatB[i]!, px, py, pz, -nx, -ny, -nz, impulse);
          events.impact(this.pairIdB[i]!, this.pairMatA[i]!, px, py, pz, nx, ny, nz, impulse);
        }
      }
      const vt2 = tx * tx + ty * ty + tz * tz;
      if (vt2 > SKID_MIN_SLIP * SKID_MIN_SLIP && fn > SKID_MIN_LOAD) {
        const vt = Math.sqrt(vt2);
        if (!staticA && cooldown[a] === 0) {
          cooldown[a] = SKID_COOLDOWN_STEPS;
          events.skid(this.pairIdA[i]!, this.pairMatB[i]!, px, py, pz, vt, fn);
        }
        if (!staticB && cooldown[b] === 0) {
          cooldown[b] = SKID_COOLDOWN_STEPS;
          events.skid(this.pairIdB[i]!, this.pairMatA[i]!, px, py, pz, vt, fn);
        }
      }
    }
    this.touchedCount = nt;
    this.cntPrev = cur;
    this.cntCur = prev;
    this.stats.active = active;
  }
}

/** Integer cell → hash (3 large primes; the caller masks it to the table size). */
function cellHash(x: number, y: number, z: number): number {
  return Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
}

/** Key of an unordered object-id pair for ObjectContacts.excludedPairs. */
export function pairKey(idA: number, idB: number): number {
  return idA < idB ? idA * 65536 + idB : idB * 65536 + idA;
}
