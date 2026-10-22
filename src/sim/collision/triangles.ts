/**
 * R-CORE NODE-VS-TRIANGLE contact (docs/CONTRACTS.md "R-CORE"). WORKER ONLY.
 *
 * Three sources of collision triangles, one kernel:
 *   - OBJECT triangles (RigDef.triangles or derived, rig/triangles.ts) hit by
 *     the object-contact nodes of OTHER objects that also have triangles
 *     (SolverOptions.triangleContact);
 *   - the same triangles hit by their own object's self-collide nodes
 *     (SolverOptions.selfCollision), minus the per-triangle exclusions;
 *   - STATIC meshes (ColliderDef kind 'mesh', world space, infinite mass)
 *     hit by every awake object's collidable nodes (props included).
 *
 * BROADPHASE (`rebuild`, with the node-vs-node rebuild interval): per object
 * a binned-SAH AABB tree over its intact triangles (a triangle is TORN once
 * an edge has beams and all are broken), boxes fattened by the half
 * thickness + its own motion bound over the interval; each querying node
 * looks up its box grown by its contact radius + its object's motion bound.
 * Candidate keys node·2^21 + global triangle id (objects in slot order, then
 * static meshes) are sorted: CANONICAL pair order (node ascending, then
 * triangle owner, then triangle index). Pair state survives a rebuild by a
 * sorted merge on the keys.
 *
 * CONTACT LAW (`apply`, every tick, canonical order), per pair (node p,
 * triangle a b c, normal n = (b − a) × (c − a) / |…|):
 *   d = (p − a)·n; barycentrics (u, v, w) of the projection (outside the
 *   triangle by more than BARY_EPS: no contact);
 *   SIDE (fixed when the pair is first seen): +1 for one-sided triangles,
 *   sign(d) for two-sided ones; a one-sided pair first seen with the node
 *   already deeper than its contact radius behind the face is BEHIND and
 *   ignored until the node is in front again (never pulled through);
 *   gap = side·d − (r_p + h);
 *   m_t = 1 / (u²/m_a + v²/m_b + w²/m_c) (barycentric point mass; static: ∞),
 *   m_r = reduced mass of p and the triangle point;
 *   s = max(contacts of p, contacts of the triangle) during the previous tick;
 *   gap < 0 (penetrating): k = min(TRI_KC_MAX, 0.2·m_r/dt²)/s,
 *     c = 2·ζ_pair·sqrt(k·m_r), Fn = max(0, k·min(−gap, TRI_DEPTH_CAP) − c·v_n);
 *   gap ≥ 0 with SPECULATIVE CCD (SolverOptions.ccd): with the predicted
 *     relative normal velocity v* (current + this tick's accumulated forces),
 *     gap + v*·dt < 0 → Fn = m_r·(−gap/dt − v*)/(dt·s): the pair closes the
 *     gap exactly at the end of the tick instead of crossing a thin face;
 *   friction: implicit Coulomb on the relative tangential velocity,
 *     F_t = −m_r·v_t/(dt·s) clamped to μ_pair·Fn;
 *   p gets F = Fn·side·n + F_t; a, b, c get −u·F, −v·F, −w·F (momentum exact).
 * μ and ζ come from the material pair (contactMaterials.ts): node material
 * (CompiledRig.nodeMaterial, else tread → rubber, else the object's) vs the
 * triangle's.
 * EVENTS: impact for both sides (the static side has none) on the tick a pair
 * enters contact with m_r·approach ≥ TRI_IMPACT_MIN_IMPULSE (materialId = the
 * other side's material, normal = the force direction on the receiver); skid
 * (scrape) for a dynamic side sliding faster than SKID_MIN_SLIP under
 * SKID_MIN_LOAD, shared per-node cooldown (metal on a hard surface → FX
 * sparks).
 *
 * NUMERICS: hot loop only + − × ÷ sqrt, fixed order, preallocated scratch.
 */
import type { CompiledTriangles } from '../rig/types';
import { RIG_TRI_FLAG_SELF, RIG_TRI_FLAG_TWO_SIDED } from '../rig/types';
import type { TriangleSet } from '../rig/triangles';
import { NODE_FLAG_OBJ_CONTACT, NODE_FLAG_TREAD, NODE_FLAG_COLLIDABLE, MATERIAL_COUNT, type EventSink, type SimState } from '../types';
import { CONTACT_MU, CONTACT_ZETA } from './contactMaterials';
import { cooldownsFor, SKID_COOLDOWN_STEPS, SKID_MIN_LOAD, SKID_MIN_SLIP } from './ground';

export const TRI_KC_MAX = 2e6;
export const TRI_KC_STABILITY = 0.2;
/** The penalty spring uses min(−gap, TRI_DEPTH_CAP): a deep pair separates over a few ticks. */
export const TRI_DEPTH_CAP = 0.08;
export const TRI_IMPACT_MIN_IMPULSE = 2;
/**
 * Speculative CCD floor: a pair never ends a tick penetrating deeper than this
 * fraction of its contact distance (node radius + half thickness), so a node
 * centre never reaches a face's plane.
 */
export const TRI_SPEC_DEPTH = 0.5;
/** Beyond (r + h) + this, m, behind its face a node is not the face's contact (released / BEHIND). */
export const TRI_MAX_PENETRATION = 0.1;
/** Constant broadphase pad on top of the motion bounds, m. */
export const TRI_MARGIN = 0.02;
/** Barycentric tolerance: the projection may lie this far (fraction) outside a triangle (seams). */
const BARY_EPS = 0.02;
/** Pair key = node·KEY_SHIFT + global triangle id (exact in f64: node < 2^24, triangles < 2^21). */
const KEY_SHIFT = 2097152;
const MAT_RUBBER = 8;
const BINS = 8;

function binIndex(c: number, cmin: number, scale: number): number {
  const j = Math.floor((c - cmin) * scale);
  return j < 0 ? 0 : j >= BINS ? BINS - 1 : j;
}

/** Half the surface area of a box [min xyz, max xyz] (SAH cost). */
function halfArea(b: Float64Array): number {
  const dx = b[3]! - b[0]!, dy = b[4]! - b[1]!, dz = b[5]! - b[2]!;
  return dx < 0 ? 0 : dx * dy + dy * dz + dz * dx;
}
const MAT_DEFAULT = 255;

// pair state bits
const ST_INIT = 1;
const ST_NEG = 2;
const ST_BEHIND = 4;
const ST_CONTACT = 8;
// pair kind bits
const K_STATIC = 1;
const K_TWO_SIDED = 2;

export interface TriangleContactStats {
  pairs: number;
  active: number;
  speculative: number;
  rebuilds: number;
  overflow: number;
  /** Max penetration (−gap) over pairs in contact during the last tick, m. */
  maxDepth: number;
}

/** Binned-SAH AABB tree over item boxes (6 f64 per item); deterministic, preallocated, grows on demand. */
export class Bvh {
  nodeBox = new Float64Array(0);
  /** Internal: left child (right = left + 1); leaf: −1 − first item slot. */
  nodeChild = new Int32Array(0);
  nodeCount_ = new Int32Array(0);
  items = new Int32Array(0);
  private cent = new Float64Array(0);
  private stack = new Int32Array(128);
  private work = new Int32Array(0);
  private readonly binCount = new Int32Array(BINS);
  private readonly binBox = new Float64Array(6 * BINS);
  private readonly accL = new Float64Array(6);
  private readonly accR = new Float64Array(6);
  nodes = 0;
  count = 0;

  private ensure(n: number): void {
    if (this.items.length >= n) return;
    const cap = Math.max(16, n * 2);
    this.nodeBox = new Float64Array(6 * 2 * cap);
    this.nodeChild = new Int32Array(2 * cap);
    this.nodeCount_ = new Int32Array(2 * cap);
    this.items = new Int32Array(cap);
    this.cent = new Float64Array(3 * cap);
  }

  /** Builds over items 0..n−1 whose boxes are boxes[6i..6i+5] (min xyz, max xyz). */
  build(boxes: Float64Array, n: number): void {
    this.ensure(n);
    this.count = n;
    const items = this.items;
    const cent = this.cent;
    for (let i = 0; i < n; i++) {
      items[i] = i;
      cent[3 * i] = 0.5 * (boxes[6 * i]! + boxes[6 * i + 3]!);
      cent[3 * i + 1] = 0.5 * (boxes[6 * i + 1]! + boxes[6 * i + 4]!);
      cent[3 * i + 2] = 0.5 * (boxes[6 * i + 2]! + boxes[6 * i + 5]!);
    }
    this.nodes = 0;
    if (n === 0) return;
    // Depth-first work stack of (node, lo, hi) triples.
    if (this.work.length < 3 * (2 * n + 2)) this.work = new Int32Array(3 * (2 * n + 2));
    const work = this.work;
    let sp = 0;
    const root = this.nodes++;
    work[sp++] = root;
    work[sp++] = 0;
    work[sp++] = n;
    while (sp > 0) {
      const hi = work[--sp]!;
      const lo = work[--sp]!;
      const node = work[--sp]!;
      this.fitNode(node, boxes, lo, hi);
      const cnt = hi - lo;
      if (cnt <= 4) {
        this.nodeChild[node] = -1 - lo;
        this.nodeCount_[node] = cnt;
        continue;
      }
      const mid = this.split(boxes, lo, hi);
      const left = this.nodes;
      this.nodes += 2;
      this.nodeChild[node] = left;
      this.nodeCount_[node] = 0;
      work[sp++] = left + 1;
      work[sp++] = mid;
      work[sp++] = hi;
      work[sp++] = left;
      work[sp++] = lo;
      work[sp++] = mid;
    }
  }

  private fitNode(node: number, boxes: Float64Array, lo: number, hi: number): void {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = lo; k < hi; k++) {
      const b = 6 * this.items[k]!;
      if (boxes[b]! < x0) x0 = boxes[b]!;
      if (boxes[b + 1]! < y0) y0 = boxes[b + 1]!;
      if (boxes[b + 2]! < z0) z0 = boxes[b + 2]!;
      if (boxes[b + 3]! > x1) x1 = boxes[b + 3]!;
      if (boxes[b + 4]! > y1) y1 = boxes[b + 4]!;
      if (boxes[b + 5]! > z1) z1 = boxes[b + 5]!;
    }
    const o = 6 * node;
    const B = this.nodeBox;
    B[o] = x0;
    B[o + 1] = y0;
    B[o + 2] = z0;
    B[o + 3] = x1;
    B[o + 4] = y1;
    B[o + 5] = z1;
  }

  /** Binned SAH (BINS bins) on the widest centroid axis; median fallback. Returns the split index. */
  private split(boxes: Float64Array, lo: number, hi: number): number {
    const items = this.items;
    const cent = this.cent;
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let k = lo; k < hi; k++) {
      const i = 3 * items[k]!;
      if (cent[i]! < c0x) c0x = cent[i]!;
      if (cent[i]! > c1x) c1x = cent[i]!;
      if (cent[i + 1]! < c0y) c0y = cent[i + 1]!;
      if (cent[i + 1]! > c1y) c1y = cent[i + 1]!;
      if (cent[i + 2]! < c0z) c0z = cent[i + 2]!;
      if (cent[i + 2]! > c1z) c1z = cent[i + 2]!;
    }
    const ex = c1x - c0x, ey = c1y - c0y, ez = c1z - c0z;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const cmin = axis === 0 ? c0x : axis === 1 ? c0y : c0z;
    const ext = axis === 0 ? ex : axis === 1 ? ey : ez;
    const mid0 = (lo + hi) >> 1;
    if (!(ext > 1e-9)) return mid0;
    const binCount = this.binCount;
    const binBox = this.binBox;
    binCount.fill(0);
    for (let j = 0; j < BINS; j++) {
      binBox[6 * j] = binBox[6 * j + 1] = binBox[6 * j + 2] = Infinity;
      binBox[6 * j + 3] = binBox[6 * j + 4] = binBox[6 * j + 5] = -Infinity;
    }
    const scale = BINS / ext;
    for (let k = lo; k < hi; k++) {
      const it = items[k]!;
      const j = binIndex(cent[3 * it + axis]!, cmin, scale);
      binCount[j]!++;
      const b = 6 * it;
      for (let q = 0; q < 3; q++) {
        if (boxes[b + q]! < binBox[6 * j + q]!) binBox[6 * j + q] = boxes[b + q]!;
        if (boxes[b + 3 + q]! > binBox[6 * j + 3 + q]!) binBox[6 * j + 3 + q] = boxes[b + 3 + q]!;
      }
    }
    const L = this.accL;
    const R = this.accR;
    let best = -1;
    let bestCost = Infinity;
    for (let sIdx = 1; sIdx < BINS; sIdx++) {
      L[0] = L[1] = L[2] = R[0] = R[1] = R[2] = Infinity;
      L[3] = L[4] = L[5] = R[3] = R[4] = R[5] = -Infinity;
      let nl = 0;
      let nr = 0;
      for (let j = 0; j < BINS; j++) {
        if (binCount[j] === 0) continue;
        const T = j < sIdx ? L : R;
        if (j < sIdx) nl += binCount[j]!;
        else nr += binCount[j]!;
        for (let q = 0; q < 3; q++) {
          if (binBox[6 * j + q]! < T[q]!) T[q] = binBox[6 * j + q]!;
          if (binBox[6 * j + 3 + q]! > T[3 + q]!) T[3 + q] = binBox[6 * j + 3 + q]!;
        }
      }
      if (nl === 0 || nr === 0) continue;
      const cost = nl * halfArea(L) + nr * halfArea(R);
      if (cost < bestCost) {
        bestCost = cost;
        best = sIdx;
      }
    }
    if (best < 0) return mid0;
    // Stable partition by bin < best (deterministic).
    if (this.stack.length < hi - lo) this.stack = new Int32Array(2 * (hi - lo));
    const tmp = this.stack;
    let w = lo;
    let t = 0;
    for (let k = lo; k < hi; k++) {
      const it = items[k]!;
      if (binIndex(cent[3 * it + axis]!, cmin, scale) < best) items[w++] = it;
      else tmp[t++] = it;
    }
    for (let k = 0; k < t; k++) items[w + k] = tmp[k]!;
    return w;
  }

  /** Items whose boxes overlap [x0..x1]×[y0..y1]×[z0..z1] → out[0..n) (traversal order). */
  query(boxes: Float64Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: Int32Array, max: number, stack: Int32Array): number {
    if (this.nodes === 0) return 0;
    const B = this.nodeBox;
    let sp = 0;
    stack[sp++] = 0;
    let n = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const o = 6 * node;
      if (B[o]! > x1 || B[o + 3]! < x0 || B[o + 1]! > y1 || B[o + 4]! < y0 || B[o + 2]! > z1 || B[o + 5]! < z0) continue;
      const ch = this.nodeChild[node]!;
      if (ch >= 0) {
        stack[sp++] = ch + 1;
        stack[sp++] = ch;
        continue;
      }
      const first = -1 - ch;
      const end = first + this.nodeCount_[node]!;
      for (let k = first; k < end; k++) {
        const it = this.items[k]!;
        const b = 6 * it;
        if (boxes[b]! > x1 || boxes[b + 3]! < x0 || boxes[b + 1]! > y1 || boxes[b + 4]! < y0 || boxes[b + 2]! > z1 || boxes[b + 5]! < z0) continue;
        if (n < max) out[n++] = it;
      }
    }
    return n;
  }
}

/** One object's triangles (engine-owned, per object; rig-local indices). */
export interface TriangleSlot {
  set: TriangleSet;
  /** Rig-local self-collision participants or null (= collidable). */
  nodeSelf: Uint8Array | null;
}

/** Static mesh (world space). */
interface StaticMesh {
  pos: Float64Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  boxes: Float64Array;
  bvh: Bvh;
  material: number;
  twoSided: boolean;
  count: number;
  /** World AABB of the whole mesh. */
  box: Float64Array;
}

export interface StaticMeshInput {
  /** World-space vertex positions xyz. */
  positions: Float64Array;
  indices: Int32Array;
  material: number;
  twoSided: boolean;
}

/** Per-slot dynamic BVH + scratch (reused). */
interface SlotTree {
  bvh: Bvh;
  boxes: Float64Array;
  /** BVH item → rig-local triangle index (intact ones only). */
  triOf: Int32Array;
  count: number;
}

export interface SolverFlags {
  triangleContact: boolean;
  selfCollision: boolean;
  ccd: boolean;
}

export class TriangleContacts {
  readonly maxObjects: number;
  /** R-PHYS2: object-id pairs (key lo·65536 + hi, collision/objects.ts `pairKey`) that never use triangle contact. */
  excludedPairs: Set<number> | null = null;
  // ---- per arena slot, filled by the engine (`setObject`) before each rebuild
  private readonly slots: (TriangleSlot | null)[];
  private readonly oStart: Int32Array;
  private readonly oCount: Int32Array;
  private readonly oBeam: Int32Array;
  private readonly oId: Float64Array;
  private readonly oMat: Uint8Array;
  private readonly oNodeMat: (Uint8Array | null)[];
  private readonly trees: (SlotTree | null)[];
  private readonly slotBase: Int32Array;
  private statics: StaticMesh[] = [];
  private staticBase = 0;
  // ---- pair list (canonical)
  pairNode: Int32Array;
  pairKey: Float64Array;
  pairA: Int32Array;
  pairB: Int32Array;
  pairC: Int32Array;
  /** Global triangle id (contact counts) */
  pairTri: Int32Array;
  pairKind: Uint8Array;
  pairState: Uint8Array;
  pairH: Float64Array;
  pairMu: Float64Array;
  pairZeta: Float64Array;
  pairMatNode: Uint8Array;
  pairMatTri: Uint8Array;
  pairIdNode: Float64Array;
  pairIdTri: Float64Array;
  /** Barycentric (u, v) of the last tick in contact (load bookkeeping across rebuilds). */
  pairU: Float64Array;
  pairV: Float64Array;
  pairCount = 0;
  private keys: Float64Array<ArrayBufferLike>;
  private keyCount = 0;
  private prevKey: Float64Array;
  private prevState: Uint8Array;
  private prevU: Float64Array;
  private prevV: Float64Array;
  // ---- per node contact LOAD (previous / current tick): Σ w² over the contacts the node takes part in,
  // w = 1 as the contact point, the barycentric weight as a triangle vertex (penalty normalization).
  private loadPrev: Float64Array;
  private loadCur: Float64Array;
  private readonly hits = new Int32Array(512);
  private readonly stack = new Int32Array(256);
  readonly stats: TriangleContactStats = { pairs: 0, active: 0, speculative: 0, rebuilds: 0, overflow: 0, maxDepth: 0 };

  constructor(nodeCapacity: number, maxObjects: number, pairCapacity = 65536) {
    this.maxObjects = maxObjects;
    this.slots = new Array<TriangleSlot | null>(maxObjects).fill(null);
    this.oStart = new Int32Array(maxObjects);
    this.oCount = new Int32Array(maxObjects);
    this.oBeam = new Int32Array(maxObjects);
    this.oId = new Float64Array(maxObjects);
    this.oMat = new Uint8Array(maxObjects);
    this.oNodeMat = new Array<Uint8Array | null>(maxObjects).fill(null);
    this.trees = new Array<SlotTree | null>(maxObjects).fill(null);
    this.slotBase = new Int32Array(maxObjects + 1);
    this.pairNode = new Int32Array(pairCapacity);
    this.pairKey = new Float64Array(pairCapacity);
    this.pairA = new Int32Array(pairCapacity);
    this.pairB = new Int32Array(pairCapacity);
    this.pairC = new Int32Array(pairCapacity);
    this.pairTri = new Int32Array(pairCapacity);
    this.pairKind = new Uint8Array(pairCapacity);
    this.pairState = new Uint8Array(pairCapacity);
    this.pairH = new Float64Array(pairCapacity);
    this.pairMu = new Float64Array(pairCapacity);
    this.pairZeta = new Float64Array(pairCapacity);
    this.pairMatNode = new Uint8Array(pairCapacity);
    this.pairMatTri = new Uint8Array(pairCapacity);
    this.pairIdNode = new Float64Array(pairCapacity);
    this.pairIdTri = new Float64Array(pairCapacity);
    this.pairU = new Float64Array(pairCapacity);
    this.pairV = new Float64Array(pairCapacity);
    this.prevU = new Float64Array(pairCapacity);
    this.prevV = new Float64Array(pairCapacity);
    this.keys = new Float64Array(pairCapacity);
    this.prevKey = new Float64Array(pairCapacity);
    this.prevState = new Uint8Array(pairCapacity);
    this.loadPrev = new Float64Array(nodeCapacity);
    this.loadCur = new Float64Array(nodeCapacity);
  }

  /**
   * Slot `o` (arena order) for the next rebuild: node / beam range, object id,
   * default contact material, rig-local node materials (255 = default) and
   * its triangles (null = none).
   */
  setObject(o: number, nodeStart: number, nodeCount: number, beamStart: number, objectId: number, material: number, nodeMaterial: Uint8Array | null, tris: TriangleSlot | null): void {
    this.oStart[o] = nodeStart;
    this.oCount[o] = nodeCount;
    this.oBeam[o] = beamStart;
    this.oId[o] = objectId;
    this.oMat[o] = material;
    this.oNodeMat[o] = nodeMaterial;
    this.slots[o] = tris;
  }

  /** Forgets every pair (spawn / despawn shift global node indices). */
  clear(): void {
    this.pairCount = 0;
    this.stats.pairs = 0;
    this.stats.active = 0;
  }

  get hasStatic(): boolean {
    return this.statics.length > 0;
  }

  /** Installs the static meshes (world space). Not per tick: builds their trees. */
  setStaticMeshes(meshes: readonly StaticMeshInput[]): void {
    this.statics = meshes.map((m) => {
      const n = m.indices.length / 3;
      const a = new Int32Array(n);
      const b = new Int32Array(n);
      const c = new Int32Array(n);
      const boxes = new Float64Array(6 * n);
      const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      const P = m.positions;
      for (let t = 0; t < n; t++) {
        a[t] = m.indices[3 * t]!;
        b[t] = m.indices[3 * t + 1]!;
        c[t] = m.indices[3 * t + 2]!;
        for (let q = 0; q < 3; q++) {
          const v0 = P[3 * a[t]! + q]!, v1 = P[3 * b[t]! + q]!, v2 = P[3 * c[t]! + q]!;
          const lo = Math.min(v0, v1, v2);
          const hi = Math.max(v0, v1, v2);
          boxes[6 * t + q] = lo;
          boxes[6 * t + 3 + q] = hi;
          if (lo < box[q]!) box[q] = lo;
          if (hi > box[3 + q]!) box[3 + q] = hi;
        }
      }
      const bvh = new Bvh();
      bvh.build(boxes, n);
      return { pos: m.positions, a, b, c, boxes, bvh, material: m.material, twoSided: m.twoSided, count: n, box };
    });
    this.pairCount = 0;
  }

  /**
   * Rebuilds the pair list. `box`/`vmax`/`valid`/`stat` are the node-vs-node
   * broadphase's per-slot node-centre boxes, max speeds, validity and sleep
   * flags (ObjectContacts), filled for slots [0, n).
   */
  rebuild(state: SimState, n: number, box: Float64Array, vmax: Float64Array, valid: Uint8Array, stat: Uint8Array, interval: number, dt: number, solver: SolverFlags): void {
    const prevCount = this.pairCount;
    // Swap the previous list's keys + states out.
    let tk = this.prevKey;
    this.prevKey = this.pairKey;
    this.pairKey = tk;
    const ts = this.prevState;
    this.prevState = this.pairState;
    this.pairState = ts;
    let tu = this.prevU;
    this.prevU = this.pairU;
    this.pairU = tu;
    tu = this.prevV;
    this.prevV = this.pairV;
    this.pairV = tu;
    this.pairCount = 0;
    this.keyCount = 0;
    const span = interval * dt;
    // Global triangle ids: slots in order, then static meshes.
    let base = 0;
    for (let o = 0; o < n; o++) {
      this.slotBase[o] = base;
      const sl = this.slots[o];
      if (sl) base += sl.set.tris.count;
    }
    this.slotBase[n] = base;
    this.staticBase = base;
    for (const m of this.statics) base += m.count;
    // Per-slot trees over intact triangles (only slots that will be queried against).
    const wantTrees = solver.triangleContact || solver.selfCollision;
    for (let o = 0; o < n; o++) {
      const sl = this.slots[o];
      if (!sl || !wantTrees || valid[o] === 0) continue;
      this.buildTree(state, o, sl, (stat[o] !== 0 ? 0 : vmax[o]!) * span + TRI_MARGIN);
    }
    const P = state;
    // Object pairs (p queries with its nodes, q provides triangles).
    for (let p = 0; p < n; p++) {
      if (valid[p] === 0 || stat[p] !== 0) continue;
      const vp = vmax[p]! * span + TRI_MARGIN;
      const hasTris = this.slots[p] !== null;
      for (let q = 0; q < n; q++) {
        const slq = this.slots[q];
        if (!slq || valid[q] === 0) continue;
        if (q === p) {
          if (!solver.selfCollision) continue;
          this.queryNodes(P, p, q, slq, vp, true);
          continue;
        }
        if (!solver.triangleContact || !hasTris) continue;
        const ex = this.excludedPairs;
        if (ex !== null && ex.size > 0) {
          const a = this.oId[p]!;
          const b = this.oId[q]!;
          if (ex.has(a < b ? a * 65536 + b : b * 65536 + a)) continue;
        }
        const pad = vp + (stat[q] !== 0 ? 0 : vmax[q]!) * span + TRI_MARGIN + 0.5;
        if (!boxesNear(box, p, q, pad)) continue;
        this.queryNodes(P, p, q, slq, vp, false);
      }
      // Static meshes: every awake object.
      if (this.statics.length > 0) {
        const o6 = 6 * p;
        for (let m = 0; m < this.statics.length; m++) {
          const sm = this.statics[m]!;
          const pad = vp + 0.5;
          if (box[o6]! - pad > sm.box[3]! || box[o6 + 3]! + pad < sm.box[0]! || box[o6 + 1]! - pad > sm.box[4]! || box[o6 + 4]! + pad < sm.box[1]! || box[o6 + 2]! - pad > sm.box[5]! || box[o6 + 5]! + pad < sm.box[2]!) continue;
          this.queryStatic(P, p, m, vp);
        }
      }
    }
    // Canonical order.
    this.sortKeys();
    this.materialize(state, n);
    // Merge pair states of persisting pairs (both lists sorted by key).
    let j = 0;
    const pk = this.pairKey;
    const st = this.pairState;
    for (let i = 0; i < this.pairCount && j < prevCount; i++) {
      const k = pk[i]!;
      while (j < prevCount && this.prevKey[j]! < k) j++;
      if (j < prevCount && this.prevKey[j] === k) {
        st[i] = this.prevState[j]!;
        this.pairU[i] = this.prevU[j]!;
        this.pairV[i] = this.prevV[j]!;
      }
    }
    // Contact loads of the new list's nodes from the carried-over states (exact: last barycentrics).
    const L = this.loadPrev;
    for (let i = 0; i < this.pairCount; i++) {
      L[this.pairNode[i]!] = 0;
      if ((this.pairKind[i]! & K_STATIC) === 0) {
        L[this.pairA[i]!] = 0;
        L[this.pairB[i]!] = 0;
        L[this.pairC[i]!] = 0;
      }
    }
    for (let i = 0; i < this.pairCount; i++) {
      if ((st[i]! & ST_CONTACT) === 0) continue;
      L[this.pairNode[i]!] = L[this.pairNode[i]!]! + 1;
      if ((this.pairKind[i]! & K_STATIC) === 0) {
        const u = this.pairU[i]!;
        const v = this.pairV[i]!;
        const w = 1 - u - v;
        L[this.pairA[i]!] = L[this.pairA[i]!]! + u * u;
        L[this.pairB[i]!] = L[this.pairB[i]!]! + v * v;
        L[this.pairC[i]!] = L[this.pairC[i]!]! + w * w;
      }
    }
    this.stats.pairs = this.pairCount;
    this.stats.rebuilds++;
  }

  private buildTree(state: SimState, o: number, sl: TriangleSlot, pad: number): void {
    const tris = sl.set.tris;
    let tr = this.trees[o];
    if (!tr || tr.triOf.length < tris.count) {
      const cap = Math.max(16, tris.count);
      tr = { bvh: tr?.bvh ?? new Bvh(), boxes: new Float64Array(6 * cap), triOf: new Int32Array(cap), count: 0 };
      this.trees[o] = tr;
    }
    const { posX, posY, posZ, active } = state;
    const ns = this.oStart[o]!;
    const bs = this.oBeam[o]!;
    const set = sl.set;
    let m = 0;
    for (let t = 0; t < tris.count; t++) {
      if (torn(set, t, active, bs)) continue;
      const a = ns + tris.a[t]!;
      const b = ns + tris.b[t]!;
      const c = ns + tris.c[t]!;
      const h = tris.thickness[t]! + pad;
      const B = tr.boxes;
      const o6 = 6 * m;
      B[o6] = Math.min(posX[a]!, posX[b]!, posX[c]!) - h;
      B[o6 + 1] = Math.min(posY[a]!, posY[b]!, posY[c]!) - h;
      B[o6 + 2] = Math.min(posZ[a]!, posZ[b]!, posZ[c]!) - h;
      B[o6 + 3] = Math.max(posX[a]!, posX[b]!, posX[c]!) + h;
      B[o6 + 4] = Math.max(posY[a]!, posY[b]!, posY[c]!) + h;
      B[o6 + 5] = Math.max(posZ[a]!, posZ[b]!, posZ[c]!) + h;
      tr.triOf[m] = t;
      m++;
    }
    tr.count = m;
    tr.bvh.build(tr.boxes, m);
  }

  /** Nodes of slot p against slot q's tree (self: p === q, with exclusions). */
  private queryNodes(state: SimState, p: number, q: number, slq: TriangleSlot, pad: number, self: boolean): void {
    const tr = this.trees[q];
    if (!tr || tr.count === 0) return;
    const { posX, posY, posZ, radius, flags } = state;
    const start = this.oStart[p]!;
    const count = this.oCount[p]!;
    const set = slq.set;
    const tris = set.tris;
    const triBase = this.slotBase[q]!;
    const hits = this.hits;
    const sel = slq.nodeSelf;
    for (let li = 0; li < count; li++) {
      const i = start + li;
      const f = flags[i]!;
      if (self) {
        if (sel ? sel[li] === 0 : (f & NODE_FLAG_COLLIDABLE) === 0) continue;
      } else if ((f & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      const r = radius[i]! + pad;
      const x = posX[i]!, y = posY[i]!, z = posZ[i]!;
      const nh = tr.bvh.query(tr.boxes, x - r, y - r, z - r, x + r, y + r, z + r, hits, hits.length, this.stack);
      for (let k = 0; k < nh; k++) {
        const t = tr.triOf[hits[k]!]!;
        if (self) {
          if ((tris.flags[t]! & RIG_TRI_FLAG_SELF) === 0) continue;
          if (excluded(set, t, li)) continue;
        }
        if (!this.push(i * KEY_SHIFT + triBase + t)) return;
      }
    }
  }

  private queryStatic(state: SimState, p: number, m: number, pad: number): void {
    const sm = this.statics[m]!;
    const { posX, posY, posZ, radius, flags } = state;
    const start = this.oStart[p]!;
    const count = this.oCount[p]!;
    let triBase = this.staticBase;
    for (let k = 0; k < m; k++) triBase += this.statics[k]!.count;
    const hits = this.hits;
    for (let i = start; i < start + count; i++) {
      if ((flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue;
      const r = radius[i]! + pad;
      const x = posX[i]!, y = posY[i]!, z = posZ[i]!;
      const nh = sm.bvh.query(sm.boxes, x - r, y - r, z - r, x + r, y + r, z + r, hits, hits.length, this.stack);
      for (let k = 0; k < nh; k++) if (!this.push(i * KEY_SHIFT + triBase + hits[k]!)) return;
    }
  }

  private keysTmp: Float64Array<ArrayBufferLike> = new Float64Array(0);

  /** Bottom-up merge sort of keys[0, keyCount) (allocation-free once warm). */
  private sortKeys(): void {
    const n = this.keyCount;
    if (this.keysTmp.length < this.keys.length) this.keysTmp = new Float64Array(this.keys.length);
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

  private push(key: number): boolean {
    if (this.keyCount >= this.keys.length) {
      this.stats.overflow++;
      return false;
    }
    this.keys[this.keyCount++] = key;
    return true;
  }

  /** Sorted keys → pair arrays (deduped). */
  private materialize(state: SimState, n: number): void {
    const keys = this.keys;
    const flags = state.flags;
    let m = 0;
    let last = -1;
    for (let k = 0; k < this.keyCount; k++) {
      const key = keys[k]!;
      if (key === last) continue;
      last = key;
      const node = Math.floor(key / KEY_SHIFT);
      const g = key - node * KEY_SHIFT;
      const ps = this.slotOfNode(node, n);
      const nodeMat = this.nodeMaterial(ps, node, flags[node]!);
      this.pairNode[m] = node;
      this.pairKey[m] = key;
      this.pairTri[m] = g;
      this.pairState[m] = 0;
      this.pairU[m] = 0;
      this.pairV[m] = 0;
      this.pairIdNode[m] = this.oId[ps]!;
      this.pairMatNode[m] = nodeMat;
      let triMat: number;
      if (g >= this.staticBase) {
        let t = g - this.staticBase;
        let mi = 0;
        while (t >= this.statics[mi]!.count) t -= this.statics[mi++]!.count;
        const sm = this.statics[mi]!;
        this.pairA[m] = sm.a[t]!;
        this.pairB[m] = sm.b[t]!;
        this.pairC[m] = sm.c[t]!;
        this.pairKind[m] = K_STATIC | (sm.twoSided ? K_TWO_SIDED : 0);
        this.pairH[m] = 0;
        this.pairIdTri[m] = -1 - mi;
        triMat = sm.material;
      } else {
        let q = 0;
        while (q + 1 < n && this.slotBase[q + 1]! <= g) q++;
        const sl = this.slots[q]!;
        const t = g - this.slotBase[q]!;
        const tris: CompiledTriangles = sl.set.tris;
        const ns = this.oStart[q]!;
        this.pairA[m] = ns + tris.a[t]!;
        this.pairB[m] = ns + tris.b[t]!;
        this.pairC[m] = ns + tris.c[t]!;
        this.pairKind[m] = (tris.flags[t]! & RIG_TRI_FLAG_TWO_SIDED) !== 0 ? K_TWO_SIDED : 0;
        this.pairH[m] = tris.thickness[t]!;
        this.pairIdTri[m] = this.oId[q]!;
        triMat = tris.material[t]!;
      }
      this.pairMatTri[m] = triMat;
      const pi = nodeMat * MATERIAL_COUNT + triMat;
      this.pairMu[m] = CONTACT_MU[pi]!;
      this.pairZeta[m] = CONTACT_ZETA[pi]!;
      m++;
    }
    this.pairCount = m;
  }

  private slotOfNode(node: number, n: number): number {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.oStart[mid]! <= node) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private nodeMaterial(slot: number, node: number, flags: number): number {
    const nm = this.oNodeMat[slot];
    if (nm) {
      const v = nm[node - this.oStart[slot]!]!;
      if (v !== MAT_DEFAULT) return v;
    }
    if ((flags & NODE_FLAG_TREAD) !== 0) return MAT_RUBBER;
    return this.oMat[slot]!;
  }

  /** One tick of contact forces over the pair list (see header). */
  apply(state: SimState, dt: number, events: EventSink, gx: number, gy: number, gz: number, ccd: boolean): void {
    const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, radius } = state;
    const cooldown = cooldownsFor(state);
    const n = this.pairCount;
    const prevL = this.loadPrev;
    const curL = this.loadCur;
    const invDt = 1 / dt;
    const kStab = TRI_KC_STABILITY * invDt * invDt;
    for (let i = 0; i < n; i++) {
      curL[this.pairNode[i]!] = 0;
      if ((this.pairKind[i]! & K_STATIC) === 0) {
        curL[this.pairA[i]!] = 0;
        curL[this.pairB[i]!] = 0;
        curL[this.pairC[i]!] = 0;
      }
    }
    let active = 0;
    let spec = 0;
    let maxDepth = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pairNode[i]!;
      const ia = this.pairA[i]!;
      const ib = this.pairB[i]!;
      const ic = this.pairC[i]!;
      const kind = this.pairKind[i]!;
      let st = this.pairState[i]!;
      const isStatic = (kind & K_STATIC) !== 0;
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number;
      if (isStatic) {
        const sm = this.statics[-1 - this.pairIdTri[i]!]!;
        const S = sm.pos;
        ax = S[3 * ia]!; ay = S[3 * ia + 1]!; az = S[3 * ia + 2]!;
        bx = S[3 * ib]!; by = S[3 * ib + 1]!; bz = S[3 * ib + 2]!;
        cx = S[3 * ic]!; cy = S[3 * ic + 1]!; cz = S[3 * ic + 2]!;
      } else {
        ax = posX[ia]!; ay = posY[ia]!; az = posZ[ia]!;
        bx = posX[ib]!; by = posY[ib]!; bz = posZ[ib]!;
        cx = posX[ic]!; cy = posY[ic]!; cz = posZ[ic]!;
      }
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len2 = nx * nx + ny * ny + nz * nz;
      if (!(len2 > 1e-16)) {
        this.pairState[i] = st & ~ST_CONTACT;
        continue;
      }
      const il = 1 / Math.sqrt(len2);
      nx *= il;
      ny *= il;
      nz *= il;
      const px = posX[p]!, py = posY[p]!, pz = posZ[p]!;
      const wx = px - ax, wy = py - ay, wz = pz - az;
      const d = wx * nx + wy * ny + wz * nz;
      const rr = radius[p]! + this.pairH[i]!;
      // Side (first sight) / behind bookkeeping.
      if ((st & ST_INIT) === 0) {
        st |= ST_INIT;
        if ((kind & K_TWO_SIDED) !== 0) {
          if (d < 0) st |= ST_NEG;
        } else if (d < -rr) st |= ST_BEHIND;
      }
      if ((st & ST_BEHIND) !== 0) {
        if (d >= 0) st &= ~ST_BEHIND;
        else {
          this.pairState[i] = st & ~ST_CONTACT;
          continue;
        }
      }
      const side = (st & ST_NEG) !== 0 ? -1 : 1;
      const sd = side * d;
      const gap = sd - rr;
      // A node far behind the face (it got there some other way: through another face, a seam, a torn
      // panel) is not this face's contact: release it rather than drag it back through the body.
      if (gap < -TRI_MAX_PENETRATION - rr) {
        this.pairState[i] = (st & ~ST_CONTACT) | ((kind & K_TWO_SIDED) === 0 ? ST_BEHIND : 0);
        continue;
      }
      // Barycentrics of the projection.
      const d00 = e1x * e1x + e1y * e1y + e1z * e1z;
      const d01 = e1x * e2x + e1y * e2y + e1z * e2z;
      const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
      const d20 = wx * e1x + wy * e1y + wz * e1z;
      const d21 = wx * e2x + wy * e2y + wz * e2z;
      const den = d00 * d11 - d01 * d01;
      if (!(den > 0)) {
        this.pairState[i] = st & ~ST_CONTACT;
        continue;
      }
      const iden = 1 / den;
      const bv = (d11 * d20 - d01 * d21) * iden;
      const bw = (d00 * d21 - d01 * d20) * iden;
      const bu = 1 - bv - bw;
      if (bu < -BARY_EPS || bv < -BARY_EPS || bw < -BARY_EPS) {
        this.pairState[i] = st & ~ST_CONTACT;
        continue;
      }
      // Relative velocity of p w.r.t. the triangle point; masses.
      const imp = invMass[p]!;
      let tvx = 0, tvy = 0, tvz = 0, imt = 0;
      if (!isStatic) {
        tvx = bu * velX[ia]! + bv * velX[ib]! + bw * velX[ic]!;
        tvy = bu * velY[ia]! + bv * velY[ib]! + bw * velY[ic]!;
        tvz = bu * velZ[ia]! + bv * velZ[ib]! + bw * velZ[ic]!;
        imt = bu * bu * invMass[ia]! + bv * bv * invMass[ib]! + bw * bw * invMass[ic]!;
      }
      const imSum = imp + imt;
      if (!(imSum > 0)) {
        this.pairState[i] = st & ~ST_CONTACT;
        continue;
      }
      const mr = 1 / imSum;
      const snx = side * nx, sny = side * ny, snz = side * nz;
      const rvx = velX[p]! - tvx, rvy = velY[p]! - tvy, rvz = velZ[p]! - tvz;
      const vn = rvx * snx + rvy * sny + rvz * snz;
      // Penalty normalization: the largest previous-tick contact load among the node and the triangle's
      // vertices (each vertex then sees ≤ one contact's worth of stiffness: Σ w²·k/s ≤ k).
      let s = prevL[p]!;
      if (!isStatic) {
        if (prevL[ia]! > s) s = prevL[ia]!;
        if (prevL[ib]! > s) s = prevL[ib]!;
        if (prevL[ic]! > s) s = prevL[ic]!;
      }
      if (s < 1) s = 1;
      // Penalty (penetrating), then the speculative floor: the pair never ends the tick deeper than
      // TRI_SPEC_DEPTH·(r + h) — a fast node stops on a thin face instead of crossing it, while a
      // normal-speed contact (which ends shallower) sees the penalty law alone (restitution intact).
      let fn = 0;
      if (gap < 0) {
        let k = kStab * mr;
        if (k > TRI_KC_MAX) k = TRI_KC_MAX;
        k = k / s;
        const c = 2 * this.pairZeta[i]! * Math.sqrt(k * mr);
        const depth = -gap < TRI_DEPTH_CAP ? -gap : TRI_DEPTH_CAP;
        if (-gap > maxDepth) maxDepth = -gap;
        fn = k * depth - c * vn;
        if (fn < 0) fn = 0;
      }
      if (ccd) {
        // Predicted relative normal velocity at the end of the tick from the forces accumulated so far.
        let apx = frcX[p]! * imp, apy = frcY[p]! * imp, apz = frcZ[p]! * imp;
        if (isStatic) {
          apx += gx;
          apy += gy;
          apz += gz;
        } else {
          apx -= bu * frcX[ia]! * invMass[ia]! + bv * frcX[ib]! * invMass[ib]! + bw * frcX[ic]! * invMass[ic]!;
          apy -= bu * frcY[ia]! * invMass[ia]! + bv * frcY[ib]! * invMass[ib]! + bw * frcY[ic]! * invMass[ic]!;
          apz -= bu * frcZ[ia]! * invMass[ia]! + bv * frcZ[ib]! * invMass[ib]! + bw * frcZ[ic]! * invMass[ic]!;
        }
        const vstar = vn + (apx * snx + apy * sny + apz * snz) * dt + fn * imSum * dt;
        // End-of-tick floor: TRI_SPEC_DEPTH·(r + h) deep, or where the pair already is if deeper (never
        // pulled out in one tick: the penalty spring separates it).
        const floor0 = -TRI_SPEC_DEPTH * rr;
        const floor = gap < floor0 ? gap : floor0;
        if (gap + vstar * dt < floor) {
          // Not normalized: pairs run in sequence and each sees the forces already applied this tick (frc*).
          fn += mr * ((floor - gap) * invDt - vstar) * invDt;
          spec++;
        }
      }
      if (!(fn > 0)) {
        this.pairState[i] = st & ~ST_CONTACT;
        continue;
      }
      active++;
      this.pairU[i] = bu;
      this.pairV[i] = bv;
      curL[p] = curL[p]! + 1;
      if (!isStatic) {
        curL[ia] = curL[ia]! + bu * bu;
        curL[ib] = curL[ib]! + bv * bv;
        curL[ic] = curL[ic]! + bw * bw;
      }
      // Implicit Coulomb on the relative tangential velocity.
      const tx = rvx - vn * snx;
      const ty = rvy - vn * sny;
      const tz = rvz - vn * snz;
      const req = (-mr * invDt) / s;
      let fx = req * tx;
      let fy = req * ty;
      let fz = req * tz;
      const cone = this.pairMu[i]! * fn;
      const f2 = fx * fx + fy * fy + fz * fz;
      if (f2 > cone * cone) {
        const sc = cone / Math.sqrt(f2);
        fx *= sc;
        fy *= sc;
        fz *= sc;
      }
      fx += fn * snx;
      fy += fn * sny;
      fz += fn * snz;
      frcX[p] = frcX[p]! + fx;
      frcY[p] = frcY[p]! + fy;
      frcZ[p] = frcZ[p]! + fz;
      if (!isStatic) {
        frcX[ia] = frcX[ia]! - bu * fx;
        frcY[ia] = frcY[ia]! - bu * fy;
        frcZ[ia] = frcZ[ia]! - bu * fz;
        frcX[ib] = frcX[ib]! - bv * fx;
        frcY[ib] = frcY[ib]! - bv * fy;
        frcZ[ib] = frcZ[ib]! - bv * fz;
        frcX[ic] = frcX[ic]! - bw * fx;
        frcY[ic] = frcY[ic]! - bw * fy;
        frcZ[ic] = frcZ[ic]! - bw * fz;
      }
      // Contact point on the face.
      const qx = px - snx * sd;
      const qy = py - sny * sd;
      const qz = pz - snz * sd;
      if ((st & ST_CONTACT) === 0) {
        const impulse = vn < 0 ? -vn * mr : 0;
        if (impulse >= TRI_IMPACT_MIN_IMPULSE) {
          const idN = this.pairIdNode[i]!;
          const idT = this.pairIdTri[i]!;
          const self = idN === idT;
          if (!self) events.impact(idN, this.pairMatTri[i]!, qx, qy, qz, snx, sny, snz, impulse);
          if (!isStatic) events.impact(idT, this.pairMatNode[i]!, qx, qy, qz, -snx, -sny, -snz, impulse);
        }
      }
      st |= ST_CONTACT;
      const vt2 = tx * tx + ty * ty + tz * tz;
      if (vt2 > SKID_MIN_SLIP * SKID_MIN_SLIP && fn > SKID_MIN_LOAD && cooldown[p] === 0) {
        cooldown[p] = SKID_COOLDOWN_STEPS;
        events.skid(this.pairIdNode[i]!, this.pairMatTri[i]!, qx, qy, qz, Math.sqrt(vt2), fn);
      }
      this.pairState[i] = st;
    }
    this.loadPrev = curL;
    this.loadCur = prevL;
    this.stats.active = active;
    this.stats.speculative = spec;
    this.stats.maxDepth = maxDepth;
  }
}

function boxesNear(B: Float64Array, p: number, q: number, pad: number): boolean {
  const a = 6 * p;
  const b = 6 * q;
  return B[a]! <= B[b + 3]! + pad && B[b]! <= B[a + 3]! + pad && B[a + 1]! <= B[b + 4]! + pad && B[b + 1]! <= B[a + 4]! + pad && B[a + 2]! <= B[b + 5]! + pad && B[b + 2]! <= B[a + 5]! + pad;
}

/** A triangle is torn once one of its edges has beams and all of them are broken. */
function torn(set: TriangleSet, t: number, active: Uint8Array, beamStart: number): boolean {
  for (let e = 0; e < 3; e++) {
    const s = set.edgeStart[3 * t + e]!;
    const end = set.edgeStart[3 * t + e + 1]!;
    if (s === end) continue;
    let any = false;
    for (let k = s; k < end; k++) {
      if (active[beamStart + set.edgeBeams[k]!] !== 0) {
        any = true;
        break;
      }
    }
    if (!any) return true;
  }
  return false;
}

/** Rig-local node `li` is in triangle t's self-collision exclusion list (binary search). */
function excluded(set: TriangleSet, t: number, li: number): boolean {
  let lo = set.exclStart[t]!;
  let hi = set.exclStart[t + 1]! - 1;
  const ex = set.excl;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const v = ex[m]!;
    if (v === li) return true;
    if (v < li) lo = m + 1;
    else hi = m - 1;
  }
  return false;
}
