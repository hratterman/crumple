/**
 * Flexbody binder (A2): PanelGeometry[] + CompiledVehicle → BindingSet.
 * Pure and deterministic (no three, no RNG, fixed iteration order); the
 * contract — triad pool, K-triad selection + continuous weights, repair,
 * seam welding, the exact reconstruction formula — lives in ./types.ts
 * "FLEXBODY RECONSTRUCTION v2".
 *
 * `evalFlexVertex` / `evalFlexFrame` are the CPU mirror of the `flex2`
 * vertex shader (flexskin.ts): same formula, same floors and clamps, in f64.
 */
import { RIG_BEAM_TYPE_ID, type CompiledRig } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import {
  BindError,
  FLEX_AGREE_FLOOR,
  FLEX_CONSENSUS,
  FLEX_CROSS_FLOOR,
  FLEX_GS_FLOOR,
  FLEX_HEALTHY_SLACK,
  FLEX_HEALTHY_STRETCH,
  FLEX_MAX_AB,
  FLEX_MAX_ABS_C,
  FLEX_MAX_EDGE,
  FLEX_MAX_EDGE_RATIO,
  FLEX_MAX_OBJECT_NODES,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEX_MIN_ANGLE_DEG,
  FLEX_MIN_EDGE,
  FLEX_POOL_STEPS,
  FLEX_QUALITY_FLOOR,
  FLEX_SEAM_QUANTUM,
  FLEX_SIN_FLOOR,
  FLEX_SIZE_WEIGHT,
  FLEX_TRIADS,
  type BeamSelector,
  type BindingPanel,
  type BindingSet,
  type BindPanels,
  type EvalFlexVertex,
  type MaterialSlot,
  type NodeSelector,
  type PanelDef,
  type PanelGeometry,
  type Vec3T,
} from './types';

const K = FLEX_TRIADS;
/** cos of the triad angle limits: accept iff |cos θ| ≤ this. */
const MAX_ABS_COS = Math.cos((FLEX_MIN_ANGLE_DEG * Math.PI) / 180);
const MIN_EDGE2 = FLEX_MIN_EDGE * FLEX_MIN_EDGE;
const MAX_EDGE2 = FLEX_MAX_EDGE * FLEX_MAX_EDGE;
const MAX_RATIO2 = FLEX_MAX_EDGE_RATIO * FLEX_MAX_EDGE_RATIO;
/**
 * Below this length a reconstructed normal/tangent is replaced by +Y (CPU
 * and GLSL alike): only reachable when every triad collapses to a point,
 * where `normalize` would return NaN and poison the HDR post chain.
 */
export const FLEX_NORMAL_EPS = 1e-10;

// ====================================================================== selectors
const globCache = new Map<string, RegExp | null>();
function globOf(pattern: string): RegExp | null {
  let re = globCache.get(pattern);
  if (re === undefined) {
    re = pattern.includes('*')
      ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      : null;
    globCache.set(pattern, re);
  }
  return re;
}

/** Resolves a NodeSelector to sorted unique object-local indices; an entry matching nothing throws BindError. */
export function resolveNodeSelector(rig: CompiledRig, sel: NodeSelector, what: string): Uint16Array {
  const hit = new Uint8Array(rig.nodeCount);
  let byId: Map<string, number> | null = null;
  for (const entry of sel) {
    const re = globOf(entry);
    let matched = false;
    if (re) {
      for (let i = 0; i < rig.nodeCount; i++) {
        if (re.test(rig.nodeIds[i]!)) {
          hit[i] = 1;
          matched = true;
        }
      }
    } else {
      byId ??= nodeIdMap(rig);
      const i = byId.get(entry);
      if (i !== undefined) {
        hit[i] = 1;
        matched = true;
      }
    }
    if (!matched) throw new BindError(`${what}: node selector '${entry}' matches no node of rig '${rig.name}'`);
  }
  let n = 0;
  for (let i = 0; i < hit.length; i++) n += hit[i]!;
  const out = new Uint16Array(n);
  for (let i = 0, k = 0; i < hit.length; i++) if (hit[i]) out[k++] = i;
  return out;
}

const idMaps = new WeakMap<CompiledRig, Map<string, number>>();
function nodeIdMap(rig: CompiledRig): Map<string, number> {
  let m = idMaps.get(rig);
  if (!m) {
    m = new Map();
    for (let i = 0; i < rig.nodeCount; i++) m.set(rig.nodeIds[i]!, i);
    idMaps.set(rig, m);
  }
  return m;
}

/** Resolves a BeamSelector to ascending object-local beam indices (BindError on a missing pair). */
export function resolveBeamSelector(rig: CompiledRig, sel: BeamSelector, what: string): Int32Array {
  const out: number[] = [];
  if ('pairs' in sel) {
    const ids = nodeIdMap(rig);
    const want = new Set<number>();
    for (const [a, b] of sel.pairs) {
      const ia = ids.get(a);
      const ib = ids.get(b);
      if (ia === undefined || ib === undefined) {
        throw new BindError(`${what}: beam pair ${a}–${b} names an unknown node of rig '${rig.name}'`);
      }
      const key = ia < ib ? ia * 65536 + ib : ib * 65536 + ia;
      let found = false;
      for (let i = 0; i < rig.beamCount; i++) {
        const x = rig.beamA[i]!;
        const y = rig.beamB[i]!;
        if ((x < y ? x * 65536 + y : y * 65536 + x) === key) {
          want.add(i);
          found = true;
        }
      }
      if (!found) throw new BindError(`${what}: no beam ${a}–${b} in rig '${rig.name}'`);
    }
    out.push(...want);
  } else {
    const inA = new Uint8Array(rig.nodeCount);
    const inB = new Uint8Array(rig.nodeCount);
    for (const i of resolveNodeSelector(rig, sel.between[0], what)) inA[i] = 1;
    for (const i of resolveNodeSelector(rig, sel.between[1], what)) inB[i] = 1;
    for (let i = 0; i < rig.beamCount; i++) {
      const a = rig.beamA[i]!;
      const b = rig.beamB[i]!;
      if ((inA[a] && inB[b]) || (inA[b] && inB[a])) out.push(i);
    }
  }
  out.sort((x, y) => x - y);
  if (out.length === 0) throw new BindError(`${what}: beam selector matches no beam`);
  return Int32Array.from(out);
}

/** 'boundary' attach set: beams with exactly one endpoint in `bind`, minus support and never-breaking beams. */
export function boundaryBeams(rig: CompiledRig, bind: Uint16Array): Int32Array {
  const inSet = new Uint8Array(rig.nodeCount);
  for (const i of bind) inSet[i] = 1;
  const out: number[] = [];
  for (let i = 0; i < rig.beamCount; i++) {
    if (inSet[rig.beamA[i]!] === inSet[rig.beamB[i]!]) continue;
    if (rig.beamType[i] === RIG_BEAM_TYPE_ID.support) continue;
    if (!(rig.beamBreakF[i]! < Infinity)) continue;
    out.push(i);
  }
  return Int32Array.from(out);
}

// ====================================================================== hashing
/** FNV-1a over node ids, rest positions (f32 bits) and beam endpoint pairs. */
export function rigHashOf(rig: CompiledRig): number {
  let h = 0x811c9dc5;
  const byte = (b: number): void => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const word = (w: number): void => {
    byte(w);
    byte(w >>> 8);
    byte(w >>> 16);
    byte(w >>> 24);
  };
  for (let i = 0; i < rig.nodeCount; i++) {
    const id = rig.nodeIds[i]!;
    for (let k = 0; k < id.length; k++) {
      const c = id.charCodeAt(k);
      byte(c);
      byte(c >>> 8);
    }
    byte(0);
  }
  const f = new Float32Array(rig.nodeCount * 3);
  for (let i = 0; i < f.length; i++) f[i] = rig.nodePos[i]!;
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < u.length; i++) word(u[i]!);
  for (let i = 0; i < rig.beamCount; i++) {
    word(rig.beamA[i]!);
    word(rig.beamB[i]!);
  }
  return h >>> 0;
}

// ====================================================================== triad pool
/**
 * Pool triad record (f64): R0(3) e1₀(3) e2₀(3) n̂₀(3) |e1|² |e2|² e1·e2
 * 1/det g(3) ρ κ |cos θ| F0(9: rest GS frame f1, f2, f3).
 */
const TS = 32;
const T_R = 0;
const T_E1 = 3;
const T_E2 = 6;
const T_N = 9;
const T_L1 = 12;
const T_L2 = 13;
const T_G12 = 14;
const T_INVDET = 15;
const T_G = 16;
const T_RHO = 19;
const T_KAPPA = 20;
const T_COS = 21;
const T_F = 22;
/** Selection grid cell, m. */
const GRID_CELL = 0.15;
/** A full-set repair pool larger than this many triples falls back to a 32-node neighbourhood. */
const MAX_FULL_TRIPLES = 120_000;

/**
 * Statically accepted triads of one panel's bind set (TRIAD POOL in
 * types.ts) + a dense centroid grid for exact nearest-metric queries.
 */
interface TriadPool {
  count: number;
  /** Global node indices (R, X, Y) per triad. */
  nodes: Int32Array;
  data: Float64Array;
  /** Grid origin (cell coords of the min corner) and dims. */
  ox: number;
  oy: number;
  oz: number;
  nx: number;
  ny: number;
  nz: number;
  /** CSR: cell c holds triads cellItems[cellStart[c] .. cellStart[c + 1]). */
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** min over the pool of κ·FLEX_SIZE_WEIGHT·ρ: μ ≥ |p − g| + this (ring-search stop bound). */
  minExtra: number;
}

function buildPool(pos: Float64Array, bindNodes: Uint16Array, neighbours: number): TriadPool {
  const nb = bindNodes.length;
  let m = Math.min(nb - 1, neighbours);
  if (!(m < nb - 1) && (nb * (nb - 1) * (nb - 2)) / 6 > MAX_FULL_TRIPLES) m = Math.min(nb - 1, 32);
  const all = m >= nb - 1;
  // Unique triples (local indices a < b < c) in ascending key order.
  const keys: number[] = [];
  if (all) {
    for (let a = 0; a < nb; a++) for (let b = a + 1; b < nb; b++) for (let c = b + 1; c < nb; c++) keys.push((a * nb + b) * nb + c);
  } else {
    const seen = new Set<number>();
    const dist = new Float64Array(nb);
    const order = new Int32Array(nb);
    const near = new Int32Array(m);
    for (let i = 0; i < nb; i++) {
      const n = bindNodes[i]!;
      for (let k = 0; k < nb; k++) {
        const o = bindNodes[k]!;
        const dx = pos[3 * o]! - pos[3 * n]!;
        const dy = pos[3 * o + 1]! - pos[3 * n + 1]!;
        const dz = pos[3 * o + 2]! - pos[3 * n + 2]!;
        dist[k] = k === i ? Infinity : dx * dx + dy * dy + dz * dz;
      }
      selectNearest(dist, m, order);
      for (let k = 0; k < m; k++) near[k] = order[k]!;
      for (let p = 0; p < m; p++) {
        for (let q = p + 1; q < m; q++) {
          let a = i;
          let b = near[p]!;
          let c = near[q]!;
          if (a > b) [a, b] = [b, a];
          if (b > c) [b, c] = [c, b];
          if (a > b) [a, b] = [b, a];
          const key = (a * nb + b) * nb + c;
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
      }
    }
    keys.sort((x, y) => x - y);
  }

  const nodes = new Int32Array(keys.length * 3);
  let data = new Float64Array(TS * Math.max(16, keys.length));
  let count = 0;
  const F = new Float64Array(9);
  for (const key of keys) {
    const c = key % nb;
    const b = ((key - c) / nb) % nb;
    const a = (key - c - b * nb) / (nb * nb);
    const g = [bindNodes[a]!, bindNodes[b]!, bindNodes[c]!];
    // R = the corner whose angle is closest to 90° (largest |sin|; ties: lower index).
    let ri = 0;
    let bestSin = -1;
    for (let k = 0; k < 3; k++) {
      const r = g[k]!;
      const u = g[(k + 1) % 3]!;
      const w = g[(k + 2) % 3]!;
      const ux = pos[3 * u]! - pos[3 * r]!, uy = pos[3 * u + 1]! - pos[3 * r + 1]!, uz = pos[3 * u + 2]! - pos[3 * r + 2]!;
      const wx = pos[3 * w]! - pos[3 * r]!, wy = pos[3 * w + 1]! - pos[3 * r + 1]!, wz = pos[3 * w + 2]! - pos[3 * r + 2]!;
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      const den = Math.sqrt((ux * ux + uy * uy + uz * uz) * (wx * wx + wy * wy + wz * wz));
      const sin = den > 0 ? Math.sqrt(cx * cx + cy * cy + cz * cz) / den : 0;
      if (sin > bestSin + 1e-12) {
        bestSin = sin;
        ri = k;
      }
    }
    const r = g[ri]!;
    let x = g[(ri + 1) % 3]!;
    let y = g[(ri + 2) % 3]!;
    if (x > y) [x, y] = [y, x];
    if ((count + 1) * TS > data.length) {
      const grown = new Float64Array(data.length * 2);
      grown.set(data);
      data = grown;
    }
    if (!staticTriad(pos, r, x, y, data, count * TS, F)) continue;
    nodes[3 * count] = r;
    nodes[3 * count + 1] = x;
    nodes[3 * count + 2] = y;
    count++;
  }

  // Dense centroid grid (CSR, triads in pool order inside each cell).
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < count; t++) {
    const o = t * TS + T_G;
    const cx = Math.floor(data[o]! / GRID_CELL), cy = Math.floor(data[o + 1]! / GRID_CELL), cz = Math.floor(data[o + 2]! / GRID_CELL);
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
  }
  if (count === 0) minX = minY = minZ = maxX = maxY = maxZ = 0;
  const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1;
  const cells = nx * ny * nz;
  const cellOf = new Int32Array(count);
  const cellStart = new Int32Array(cells + 1);
  for (let t = 0; t < count; t++) {
    const o = t * TS + T_G;
    const cx = Math.floor(data[o]! / GRID_CELL) - minX, cy = Math.floor(data[o + 1]! / GRID_CELL) - minY, cz = Math.floor(data[o + 2]! / GRID_CELL) - minZ;
    const c = (cz * ny + cy) * nx + cx;
    cellOf[t] = c;
    cellStart[c + 1]!++;
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
  const fill = cellStart.slice(0, cells);
  const cellItems = new Int32Array(count);
  for (let t = 0; t < count; t++) cellItems[fill[cellOf[t]!]!++] = t;
  let minExtra = Infinity;
  for (let t = 0; t < count; t++) minExtra = Math.min(minExtra, data[t * TS + T_KAPPA]! * FLEX_SIZE_WEIGHT * data[t * TS + T_RHO]!);
  return { count, nodes, data, ox: minX, oy: minY, oz: minZ, nx, ny, nz, cellStart, cellItems, minExtra: count ? minExtra : 0 };
}

/** Static acceptance + record of triad (r, x, y) at data[o..o+TS); false when rejected. */
function staticTriad(pos: Float64Array, r: number, x: number, y: number, d: Float64Array, o: number, F: Float64Array): boolean {
  const rx = pos[3 * r]!, ry = pos[3 * r + 1]!, rz = pos[3 * r + 2]!;
  const e1x = pos[3 * x]! - rx, e1y = pos[3 * x + 1]! - ry, e1z = pos[3 * x + 2]! - rz;
  const e2x = pos[3 * y]! - rx, e2y = pos[3 * y + 1]! - ry, e2z = pos[3 * y + 2]! - rz;
  const l1 = e1x * e1x + e1y * e1y + e1z * e1z;
  const l2 = e2x * e2x + e2y * e2y + e2z * e2z;
  if (l1 < MIN_EDGE2 || l1 > MAX_EDGE2 || l2 < MIN_EDGE2 || l2 > MAX_EDGE2) return false;
  if (l1 > l2 * MAX_RATIO2 || l2 > l1 * MAX_RATIO2) return false;
  const g12 = e1x * e2x + e1y * e2y + e1z * e2z;
  const cosAbs = Math.abs(g12) / Math.sqrt(l1 * l2);
  if (!(cosAbs <= MAX_ABS_COS)) return false;
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz);
  d[o + T_R] = rx;
  d[o + T_R + 1] = ry;
  d[o + T_R + 2] = rz;
  d[o + T_E1] = e1x;
  d[o + T_E1 + 1] = e1y;
  d[o + T_E1 + 2] = e1z;
  d[o + T_E2] = e2x;
  d[o + T_E2 + 1] = e2y;
  d[o + T_E2 + 2] = e2z;
  d[o + T_N] = cx * inv;
  d[o + T_N + 1] = cy * inv;
  d[o + T_N + 2] = cz * inv;
  d[o + T_L1] = l1;
  d[o + T_L2] = l2;
  d[o + T_G12] = g12;
  d[o + T_INVDET] = 1 / (l1 * l2 - g12 * g12);
  const gx = (3 * rx + e1x + e2x) / 3;
  const gy = (3 * ry + e1y + e2y) / 3;
  const gz = (3 * rz + e1z + e2z) / 3;
  d[o + T_G] = gx;
  d[o + T_G + 1] = gy;
  d[o + T_G + 2] = gz;
  let rho = 0;
  for (const n of [r, x, y]) {
    const dx = pos[3 * n]! - gx, dy = pos[3 * n + 1]! - gy, dz = pos[3 * n + 2]! - gz;
    rho = Math.max(rho, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  d[o + T_RHO] = rho;
  d[o + T_KAPPA] = 1 + 0.5 * (1 - Math.sqrt(1 - cosAbs * cosAbs));
  d[o + T_COS] = cosAbs;
  gsFrame(e1x, e1y, e1z, e2x, e2y, e2z, F);
  for (let k = 0; k < 9; k++) d[o + T_F + k] = F[k]!;
  return true;
}

/** Candidate list entry. */
interface Cand {
  t: number;
  mu: number;
  a: number;
  b: number;
  c: number;
  d0: number;
}

/**
 * The K + 1 accepted pool triads with the lowest selection metric for rest
 * point p (exact: ring search over the centroid grid stops once no farther
 * cell can beat the (K+1)-th). Writes them ascending (μ, pool index) into
 * `top`; returns the count.
 */
function queryPool(pool: TriadPool, px: number, py: number, pz: number, top: Cand[]): number {
  const want = FLEX_TRIADS + 1;
  let n = 0;
  if (pool.count === 0) return 0;
  const d = pool.data;
  const cx = Math.floor(px / GRID_CELL) - pool.ox;
  const cy = Math.floor(py / GRID_CELL) - pool.oy;
  const cz = Math.floor(pz / GRID_CELL) - pool.oz;
  const { nx, ny, nz } = pool;
  // Rings beyond this cover nothing new.
  const maxRing = Math.max(cx, nx - 1 - cx, cy, ny - 1 - cy, cz, nz - 1 - cz, 0);
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= nz) continue;
      const az = dz < 0 ? -dz : dz;
      for (let dy = -ring; dy <= ring; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= ny) continue;
        const ay = dy < 0 ? -dy : dy;
        const edge = az === ring || ay === ring;
        for (let dx = -ring; dx <= ring; dx += edge ? 1 : 2 * ring || 1) {
          const x = cx + dx;
          if (x < 0 || x >= nx) continue;
          const c = (z * ny + y) * nx + x;
          for (let s = pool.cellStart[c]!, e = pool.cellStart[c + 1]!; s < e; s++) {
            const t = pool.cellItems[s]!;
            const o = t * TS;
            const gx = px - d[o + T_G]!, gy = py - d[o + T_G + 1]!, gz = pz - d[o + T_G + 2]!;
            const mu = d[o + T_KAPPA]! * (Math.sqrt(gx * gx + gy * gy + gz * gz) + FLEX_SIZE_WEIGHT * d[o + T_RHO]!);
            if (n === want && !lessCand(mu, t, top[want - 1]!)) continue;
            if (!evalTriad(d, o, px, py, pz, SCRATCH)) continue;
            // insert sorted
            let j = n < want ? n++ : want - 1;
            const slot = top[j]!;
            while (j > 0 && lessCand(mu, t, top[j - 1]!)) {
              top[j] = top[j - 1]!;
              j--;
            }
            top[j] = slot;
            slot.t = t;
            slot.mu = mu;
            slot.a = SCRATCH.a;
            slot.b = SCRATCH.b;
            slot.c = SCRATCH.c;
            slot.d0 = SCRATCH.d0;
          }
        }
      }
    }
    // Every triad in a farther ring has |p − g| ≥ ring·cell, so μ ≥ ring·cell + minExtra.
    if (n === want && top[want - 1]!.mu <= ring * GRID_CELL + pool.minExtra) break;
  }
  return n;
}

function lessCand(mu: number, t: number, other: Cand): boolean {
  return mu < other.mu || (mu === other.mu && t < other.t);
}

const SCRATCH = { a: 0, b: 0, c: 0, d0: 0 };

/** Per-vertex acceptance of the pool triad at slot `o` for rest point p: writes a, b, c, d0. */
function evalTriad(d: Float64Array, o: number, px: number, py: number, pz: number, res: typeof SCRATCH): boolean {
  const dx = px - d[o + T_R]!;
  const dy = py - d[o + T_R + 1]!;
  const dz = pz - d[o + T_R + 2]!;
  const c = dx * d[o + T_N]! + dy * d[o + T_N + 1]! + dz * d[o + T_N + 2]!;
  if (!(Math.abs(c) <= FLEX_MAX_ABS_C)) return false;
  // Gram system on the in-plane part (n̂ ⟂ e1, e2, so d·e_i is unaffected by c).
  const d1 = dx * d[o + T_E1]! + dy * d[o + T_E1 + 1]! + dz * d[o + T_E1 + 2]!;
  const d2 = dx * d[o + T_E2]! + dy * d[o + T_E2 + 1]! + dz * d[o + T_E2 + 2]!;
  const l1 = d[o + T_L1]!;
  const l2 = d[o + T_L2]!;
  const g12 = d[o + T_G12]!;
  const invDet = d[o + T_INVDET]!;
  const a = (d1 * l2 - d2 * g12) * invDet;
  const b = (d2 * l1 - d1 * g12) * invDet;
  if (!(Math.abs(a) <= FLEX_MAX_AB && Math.abs(b) <= FLEX_MAX_AB)) return false;
  res.a = a;
  res.b = b;
  res.c = c;
  res.d0 = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return true;
}

// ====================================================================== bindPanels
function defaultDamageWeight(slot: MaterialSlot): number {
  switch (slot) {
    case 'glass':
    case 'interior':
    case 'interiorTrim':
    case 'rubber':
      return 0;
    case 'lightHead':
    case 'lightTail':
    case 'lightIndicator':
    case 'lightReverse':
      return 0.3;
    default:
      return 1;
  }
}

interface StatsAcc {
  vertices: number;
  triangles: number;
  repaired: number;
  welded: number;
  maxAbsC: number;
  minAngleDeg: number;
  poolTriads: number;
  bound: number;
  triads: number;
}

export const bindPanels: BindPanels = (compiled: CompiledVehicle, def, geoms) => {
  const rig = compiled.rig;
  if (def.vehicle !== compiled.name) {
    throw new BindError(`visual def is for '${def.vehicle}', compiled vehicle is '${compiled.name}'`);
  }
  if (rig.nodeCount > FLEX_MAX_OBJECT_NODES) {
    throw new BindError(`rig '${rig.name}' has ${rig.nodeCount} nodes > ${FLEX_MAX_OBJECT_NODES} (Uint16 triads)`);
  }
  if (geoms.length !== def.panels.length) {
    throw new BindError(`${geoms.length} panel geometries for ${def.panels.length} panel defs`);
  }
  const ids = new Set<string>();
  for (const p of def.panels) {
    if (ids.has(p.id)) throw new BindError(`duplicate panel id '${p.id}'`);
    ids.add(p.id);
  }

  const acc: StatsAcc = { vertices: 0, triangles: 0, repaired: 0, welded: 0, maxAbsC: 0, minAngleDeg: 180, poolTriads: 0, bound: 0, triads: 0 };
  const panels: BindingPanel[] = [];
  for (let pi = 0; pi < def.panels.length; pi++) {
    const pdef = def.panels[pi]!;
    const geom = geoms[pi]!;
    if (geom.panelId !== pdef.id) {
      throw new BindError(`panel ${pi}: geometry '${geom.panelId}' does not match def '${pdef.id}'`);
    }
    panels.push(bindPanel(rig, pdef, geom, pi, acc));
  }
  const stats = {
    vertices: acc.vertices,
    triangles: acc.triangles,
    repaired: acc.repaired,
    welded: acc.welded,
    maxAbsC: acc.maxAbsC,
    minAngleDeg: acc.minAngleDeg,
    poolTriads: acc.poolTriads,
    meanTriads: acc.bound ? acc.triads / acc.bound : 0,
  };
  return { vehicle: compiled.name, nodeCount: rig.nodeCount, rigHash: rigHashOf(rig), panels, stats };
};

function bindPanel(rig: CompiledRig, pdef: PanelDef, geom: PanelGeometry, panelIndex: number, stats: StatsAcc): BindingPanel {
  const what = `panel '${pdef.id}'`;
  const bindNodes = resolveNodeSelector(rig, pdef.bind, what);
  const pos = rig.nodePos;
  const vcount = geom.position.length / 3;
  if (!Number.isInteger(vcount) || geom.normal.length !== vcount * 3 || geom.uv.length !== vcount * 2) {
    throw new BindError(`${what}: malformed geometry (position/normal/uv lengths)`);
  }
  if (geom.tangent && geom.tangent.length !== vcount * 4) throw new BindError(`${what}: tangent length`);
  if (geom.damageWeight && geom.damageWeight.length !== vcount) throw new BindError(`${what}: damageWeight length`);
  for (let i = 0; i < geom.index.length; i++) {
    if (geom.index[i]! >= vcount) throw new BindError(`${what}: index ${geom.index[i]} out of range`);
  }
  if (bindNodes.length < 3) throw new BindError(`${what}: bind set has ${bindNodes.length} nodes (< 3)`);

  const triad = new Uint16Array(vcount * K * 3);
  const coef = new Float32Array(vcount * K * 4);
  const weight = new Float32Array(vcount * K);
  const frameNormal = new Float32Array(vcount * K * 3);
  const frameTangent = geom.tangent ? new Float32Array(vcount * K * 3) : null;
  /** Pool triad (and pool step) per slot of bound vertices, for the frame pass. */
  const slotTriad = new Int32Array(vcount * K).fill(-1);
  const slotPool = new Int8Array(vcount);
  const owner = new Int32Array(vcount); // first vertex of each seam group

  const top: Cand[] = Array.from({ length: K + 1 }, () => ({ t: -1, mu: 0, a: 0, b: 0, c: 0, d0: 0 }));
  const seam = new SeamIndex(vcount);
  const q = 1 / FLEX_SEAM_QUANTUM;
  const pools: TriadPool[] = [];
  let pending: number[] = [];
  for (let v = 0; v < vcount; v++) {
    const px = geom.position[3 * v]!;
    const py = geom.position[3 * v + 1]!;
    const pz = geom.position[3 * v + 2]!;
    if (!Number.isFinite(px + py + pz)) throw new BindError(`${what}: vertex ${v} is not finite`);
    const first = seam.find(v, Math.round(px * q), Math.round(py * q), Math.round(pz * q));
    owner[v] = first >= 0 ? first : v;
    if (first < 0) pending.push(v);
    else stats.welded++;
  }

  for (let step = 0; step < FLEX_POOL_STEPS.length && pending.length > 0; step++) {
    const pool = buildPool(pos, bindNodes, FLEX_POOL_STEPS[step]!);
    pools.push(pool);
    stats.poolTriads += pool.count;
    const failed: number[] = [];
    for (const v of pending) {
      const px = geom.position[3 * v]!;
      const py = geom.position[3 * v + 1]!;
      const pz = geom.position[3 * v + 2]!;
      const n = queryPool(pool, px, py, pz, top);
      if (n === 0) {
        failed.push(v);
        continue;
      }
      if (step > 0) stats.repaired++;
      slotPool[v] = step;
      // Weights: inverse metric minus the first rejected candidate's (continuity), normalized.
      const used = Math.min(K, n);
      const ref = n > K ? 1 / top[K]!.mu : 0;
      let sum = 0;
      for (let k = 0; k < used; k++) {
        const w = 1 / top[k]!.mu - ref;
        WTMP[k] = w > 0 ? w : 0;
        sum += WTMP[k]!;
      }
      if (!(sum > 0)) {
        for (let k = 0; k < used; k++) WTMP[k] = 1;
        sum = used;
      }
      for (let k = 0; k < K; k++) {
        const src = top[k < used ? k : 0]!;
        const s = K * v + k;
        const t = src.t;
        slotTriad[s] = t;
        triad[3 * s] = pool.nodes[3 * t]!;
        triad[3 * s + 1] = pool.nodes[3 * t + 1]!;
        triad[3 * s + 2] = pool.nodes[3 * t + 2]!;
        coef[4 * s] = src.a;
        coef[4 * s + 1] = src.b;
        coef[4 * s + 2] = src.c;
        coef[4 * s + 3] = src.d0;
        const w = k < used ? WTMP[k]! / sum : 0;
        weight[s] = w;
        if (w > 0) {
          stats.triads++;
          const absC = Math.abs(src.c);
          if (absC > stats.maxAbsC) stats.maxAbsC = absC;
          const ang = (Math.acos(Math.min(1, pool.data[t * TS + T_COS]!)) * 180) / Math.PI;
          if (ang < stats.minAngleDeg) stats.minAngleDeg = ang;
        }
      }
      stats.bound++;
    }
    pending = failed;
  }
  if (pending.length > 0) {
    const v = pending[0]!;
    throw new BindError(
      `${what}: vertex ${v} at (${geom.position[3 * v]!.toFixed(3)}, ${geom.position[3 * v + 1]!.toFixed(3)}, ${geom.position[3 * v + 2]!.toFixed(3)}) has no acceptable triad among ${bindNodes.length} bind nodes`,
    );
  }

  // Welded copies + per-vertex frame-local normals / tangents in each slot's rest GS frame.
  for (let v = 0; v < vcount; v++) {
    const o = owner[v]!;
    if (o !== v) {
      triad.copyWithin(3 * K * v, 3 * K * o, 3 * K * (o + 1));
      coef.copyWithin(4 * K * v, 4 * K * o, 4 * K * (o + 1));
      weight.copyWithin(K * v, K * o, K * (o + 1));
    }
    const pool = pools[slotPool[o]!]!;
    const nx = geom.normal[3 * v]!;
    const ny = geom.normal[3 * v + 1]!;
    const nz = geom.normal[3 * v + 2]!;
    for (let k = 0; k < K; k++) {
      const s = K * v + k;
      const fo = slotTriad[K * o + k]! * TS + T_F;
      toFrame(pool.data, fo, nx, ny, nz, frameNormal, 3 * s);
      if (frameTangent && geom.tangent) {
        toFrame(pool.data, fo, geom.tangent[4 * v]!, geom.tangent[4 * v + 1]!, geom.tangent[4 * v + 2]!, frameTangent, 3 * s);
      }
    }
  }
  stats.vertices += vcount;
  stats.triangles += Math.floor(geom.index.length / 3);

  // Nodes referenced by triads.
  const used = new Uint8Array(rig.nodeCount);
  for (let i = 0; i < triad.length; i++) used[triad[i]!] = 1;
  let nu = 0;
  for (let i = 0; i < used.length; i++) nu += used[i]!;
  const nodes = new Uint16Array(nu);
  for (let i = 0, k = 0; i < used.length; i++) if (used[i]) nodes[k++] = i;

  // Rest bounding sphere (AABB centre).
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const x = geom.position[3 * v]!, y = geom.position[3 * v + 1]!, z = geom.position[3 * v + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const restCenter: Vec3T = vcount ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] : [0, 0, 0];
  let r2 = 0;
  for (let v = 0; v < vcount; v++) {
    const dx = geom.position[3 * v]! - restCenter[0];
    const dy = geom.position[3 * v + 1]! - restCenter[1];
    const dz = geom.position[3 * v + 2]! - restCenter[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }

  let detach: BindingPanel['detach'] = null;
  if (pdef.detach) {
    const d = pdef.detach;
    if (!(d.minBrokenFraction > 0 && d.minBrokenFraction <= 1)) {
      throw new BindError(`${what}: detach.minBrokenFraction ${d.minBrokenFraction} not in (0, 1]`);
    }
    const attachBeams = d.attach === 'boundary' ? boundaryBeams(rig, bindNodes) : resolveBeamSelector(rig, d.attach, `${what} detach`);
    if (attachBeams.length === 0) throw new BindError(`${what}: empty detach attach set`);
    detach = { attachBeams, minBrokenFraction: d.minBrokenFraction, mode: d.mode };
  }
  let glass: BindingPanel['glass'] = null;
  if (pdef.glass) {
    const { beams, ...rest } = pdef.glass;
    glass = { ...rest, beams: resolveBeamSelector(rig, beams, `${what} glass`) };
  }

  const damageWeight = new Float32Array(vcount);
  if (geom.damageWeight) damageWeight.set(geom.damageWeight);
  else damageWeight.fill(pdef.damageWeight ?? defaultDamageWeight(pdef.material));

  return {
    panelId: pdef.id,
    panelIndex,
    kind: pdef.kind,
    material: pdef.material,
    vertexCount: vcount,
    restPosition: Float32Array.from(geom.position),
    restNormal: Float32Array.from(geom.normal),
    restTangent: geom.tangent ? Float32Array.from(geom.tangent) : null,
    uv: Float32Array.from(geom.uv),
    index: Uint32Array.from(geom.index),
    triad,
    coef,
    weight,
    frameNormal,
    frameTangent,
    damageWeight,
    nodes,
    bindNodes,
    restCenter,
    restRadius: Math.sqrt(r2),
    detach,
    glass,
    lights: pdef.lights ?? [],
    castShadow: pdef.castShadow ?? !(pdef.kind === 'glass' || pdef.material === 'glass'),
  };
}

const WTMP = new Float64Array(FLEX_TRIADS);

/**
 * order[0..k) = the k nearest local indices sorted by (dist, index): one
 * pass with insertion into the running top-k.
 */
function selectNearest(dist: Float64Array, k: number, order: Int32Array): void {
  const n = dist.length;
  if (k >= n) {
    const all = Array.from({ length: n }, (_, i) => i);
    all.sort((a, b) => dist[a]! - dist[b]! || a - b);
    order.set(all);
    return;
  }
  let count = 0;
  for (let i = 0; i < n; i++) {
    const d = dist[i]!;
    if (count === k && !(d < dist[order[k - 1]!]!)) continue;
    // Stable: equal distances keep the lower index (seen first) in front.
    let j = count < k ? count++ : k - 1;
    while (j > 0 && dist[order[j - 1]!]! > d) {
      order[j] = order[j - 1]!;
      j--;
    }
    order[j] = i;
  }
}

/**
 * Seam lookup on quantized rest positions: open-addressing hash of the
 * integer triple → first vertex with that triple (exact compare on hit).
 */
class SeamIndex {
  private readonly slots: Int32Array;
  private readonly qx: Float64Array;
  private readonly qy: Float64Array;
  private readonly qz: Float64Array;
  private readonly mask: number;
  constructor(n: number) {
    let size = 16;
    while (size < n * 2) size <<= 1;
    this.slots = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    this.qx = new Float64Array(n);
    this.qy = new Float64Array(n);
    this.qz = new Float64Array(n);
  }
  /** First vertex with the same quantized position, or −1 (then v is recorded as the first). */
  find(v: number, x: number, y: number, z: number): number {
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & this.mask;
    for (;;) {
      const s = this.slots[h]!;
      if (s < 0) {
        this.slots[h] = v;
        this.qx[v] = x;
        this.qy[v] = y;
        this.qz[v] = z;
        return -1;
      }
      if (this.qx[s] === x && this.qy[s] === y && this.qz[s] === z) return s;
      h = (h + 1) & this.mask;
    }
  }
}

// ====================================================================== frames
/** Gram–Schmidt frame exactly as the shader: f1 = e1/max(|e1|,ε), f2 = t/max(|t|,ε), f3 = f1×f2 (row-major f1, f2, f3). */
function gsFrame(e1x: number, e1y: number, e1z: number, e2x: number, e2y: number, e2z: number, out: Float64Array): void {
  const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
  const i1 = 1 / (l1 > FLEX_GS_FLOOR ? l1 : FLEX_GS_FLOOR);
  const f1x = e1x * i1;
  const f1y = e1y * i1;
  const f1z = e1z * i1;
  const p = e2x * f1x + e2y * f1y + e2z * f1z;
  const tx = e2x - p * f1x;
  const ty = e2y - p * f1y;
  const tz = e2z - p * f1z;
  const lt = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const it = 1 / (lt > FLEX_GS_FLOOR ? lt : FLEX_GS_FLOOR);
  const f2x = tx * it;
  const f2y = ty * it;
  const f2z = tz * it;
  out[0] = f1x;
  out[1] = f1y;
  out[2] = f1z;
  out[3] = f2x;
  out[4] = f2y;
  out[5] = f2z;
  out[6] = f1y * f2z - f1z * f2y;
  out[7] = f1z * f2x - f1x * f2z;
  out[8] = f1x * f2y - f1y * f2x;
}

/** Rest vector (x, y, z) in the GS frame stored at f[fo..fo+9). */
function toFrame(f: Float64Array, fo: number, x: number, y: number, z: number, out: Float32Array, o: number): void {
  out[o] = x * f[fo]! + y * f[fo + 1]! + z * f[fo + 2]!;
  out[o + 1] = x * f[fo + 3]! + y * f[fo + 4]! + z * f[fo + 5]!;
  out[o + 2] = x * f[fo + 6]! + y * f[fo + 7]! + z * f[fo + 8]!;
}

// ====================================================================== CPU mirror of the shader
const EVAL_FRAME = new Float64Array(9);
/** Offsets at least this long are treated as garbage (GLSL: `lo < FLEX_FAR`, else o = 0). */
export const FLEX_FAR = 1e20;
/** Per-slot scratch: P(3) N(3) T(3) W, FINITE flag. */
const SLOT = 11;
const TRI = new Float64Array(SLOT * FLEX_TRIADS);

/** GLSL smoothstep (e0 < e1). */
function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * Normalizes (x, y, z) into out[o..o+3). Degenerate (zero-length) input —
 * only possible when every triad collapsed — yields +Y instead of NaN (the
 * shader does the same; a NaN normal would poison the HDR post chain).
 */
function normalizeInto(x: number, y: number, z: number, out: Float64Array, o: number): void {
  const l = Math.sqrt(x * x + y * y + z * z);
  if (l > FLEX_NORMAL_EPS) {
    out[o] = x / l;
    out[o + 1] = y / l;
    out[o + 2] = z / l;
  } else {
    out[o] = 0;
    out[o + 1] = 1;
    out[o + 2] = 0;
  }
}

/** Reconstructed position + normal of vertex v (contract formula, f64): out[0..3) P, out[3..6) N. */
export const evalFlexVertex: EvalFlexVertex = (panel, v, nodes, out) => {
  evalFlexFrame(panel, v, nodes, out, null);
};

/**
 * One triad (types.ts "FLEXBODY RECONSTRUCTION v2") into TRI[k·SLOT ..]:
 * P_k, N_k = F_k·fn_k, T_k = F_k·ft_k, W_k, finite flag. NaN / absurd node
 * data (the skin sanitizes NaN before the GPU sees it) gives P = R, W at
 * the quality floor and no frame.
 */
function evalTriadSlot(panel: BindingPanel, s: number, k: number, nodes: ArrayLike<number>, withTangent: boolean): void {
  const o = k * SLOT;
  const w = panel.weight[s]!;
  TRI[o + 9] = 0;
  TRI[o + 10] = 0;
  if (!(w > 0)) return;
  const ir = panel.triad[3 * s]! * 3;
  const ix = panel.triad[3 * s + 1]! * 3;
  const iy = panel.triad[3 * s + 2]! * 3;
  const rx = nodes[ir]!;
  const ry = nodes[ir + 1]!;
  const rz = nodes[ir + 2]!;
  const e1x = nodes[ix]! - rx;
  const e1y = nodes[ix + 1]! - ry;
  const e1z = nodes[ix + 2]! - rz;
  const e2x = nodes[iy]! - rx;
  const e2y = nodes[iy + 1]! - ry;
  const e2z = nodes[iy + 2]! - rz;
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  const L = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
  const l2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
  const m = Math.max(l1 * l2, FLEX_CROSS_FLOOR);
  const inv = 1 / Math.max(L, FLEX_SIN_FLOOR * m);
  const a = panel.coef[4 * s]!;
  const b = panel.coef[4 * s + 1]!;
  const c = panel.coef[4 * s + 2]! * inv;
  const d0 = panel.coef[4 * s + 3]!;
  let ox = a * e1x + b * e2x + c * cx;
  let oy = a * e1y + b * e2y + c * cy;
  let oz = a * e1z + b * e2z + c * cz;
  const lo = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const lim = FLEX_MAX_STRETCH * d0 + FLEX_MAX_SLACK;
  let q = 0;
  let finite = true;
  if (lo <= lim) {
    q = (1 - smoothstep(FLEX_HEALTHY_STRETCH * d0 + FLEX_HEALTHY_SLACK, lim, lo)) * smoothstep(0.5 * FLEX_SIN_FLOOR, 2 * FLEX_SIN_FLOOR, L / m);
    if (!(q >= 0)) q = 0;
  } else if (lo < FLEX_FAR) {
    const kk = lim / lo;
    ox *= kk;
    oy *= kk;
    oz *= kk;
  } else {
    ox = oy = oz = 0;
    finite = false;
  }
  TRI[o] = rx + ox;
  TRI[o + 1] = ry + oy;
  TRI[o + 2] = rz + oz;
  TRI[o + 9] = w * Math.max(q, FLEX_QUALITY_FLOOR);
  if (!finite || !Number.isFinite(rx + ry + rz)) {
    TRI[o] = Number.isFinite(rx) ? rx : 0;
    TRI[o + 1] = Number.isFinite(ry) ? ry : 0;
    TRI[o + 2] = Number.isFinite(rz) ? rz : 0;
    return;
  }
  TRI[o + 10] = 1;
  const f = EVAL_FRAME;
  gsFrame(e1x, e1y, e1z, e2x, e2y, e2z, f);
  const fn = panel.frameNormal;
  const nx = fn[3 * s]!;
  const ny = fn[3 * s + 1]!;
  const nz = fn[3 * s + 2]!;
  TRI[o + 3] = nx * f[0]! + ny * f[3]! + nz * f[6]!;
  TRI[o + 4] = nx * f[1]! + ny * f[4]! + nz * f[7]!;
  TRI[o + 5] = nx * f[2]! + ny * f[5]! + nz * f[8]!;
  const ft = panel.frameTangent;
  if (withTangent && ft) {
    const tx = ft[3 * s]!;
    const ty = ft[3 * s + 1]!;
    const tz = ft[3 * s + 2]!;
    TRI[o + 6] = tx * f[0]! + ty * f[3]! + tz * f[6]!;
    TRI[o + 7] = tx * f[1]! + ty * f[4]! + tz * f[7]!;
    TRI[o + 8] = tx * f[2]! + ty * f[5]! + tz * f[8]!;
  }
}

const CW = new Float64Array(FLEX_TRIADS);
const NRM = new Float64Array(3);

/**
 * Like evalFlexVertex, plus the tangent (xyz + handedness) into tangentOut
 * when the panel has frame tangents (else tangentOut is left untouched).
 */
export function evalFlexFrame(
  panel: BindingPanel,
  v: number,
  nodes: ArrayLike<number>,
  out: Float64Array,
  tangentOut: Float64Array | null,
): void {
  const withTangent = tangentOut !== null && panel.frameTangent !== null;
  for (let k = 0; k < K; k++) evalTriadSlot(panel, K * v + k, k, nodes, withTangent);
  // Pass 1: quality-weighted mean.
  let sw = 0, mx = 0, my = 0, mz = 0;
  for (let k = 0; k < K; k++) {
    const o = k * SLOT;
    const W = TRI[o + 9]!;
    sw += W;
    mx += W * TRI[o]!;
    my += W * TRI[o + 1]!;
    mz += W * TRI[o + 2]!;
  }
  mx /= sw;
  my /= sw;
  mz /= sw;
  // Pass 2: consensus.
  const ic2 = 1 / (FLEX_CONSENSUS * FLEX_CONSENSUS);
  let sc = 0, px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < K; k++) {
    const o = k * SLOT;
    const dx = TRI[o]! - mx, dy = TRI[o + 1]! - my, dz = TRI[o + 2]! - mz;
    const C = TRI[o + 9]! / (1 + (dx * dx + dy * dy + dz * dz) * ic2);
    CW[k] = C;
    sc += C;
    px += C * TRI[o]!;
    py += C * TRI[o + 1]!;
    pz += C * TRI[o + 2]!;
    if (TRI[o + 10]) {
      nx += C * TRI[o + 3]!;
      ny += C * TRI[o + 4]!;
      nz += C * TRI[o + 5]!;
    }
  }
  out[0] = px / sc;
  out[1] = py / sc;
  out[2] = pz / sc;
  normalizeInto(nx, ny, nz, NRM, 0);
  let ax = 0, ay = 0, az = 0, tx = 0, ty = 0, tz = 0;
  for (let k = 0; k < K; k++) {
    const o = k * SLOT;
    if (!TRI[o + 10]) continue;
    const agree = TRI[o + 3]! * NRM[0]! + TRI[o + 4]! * NRM[1]! + TRI[o + 5]! * NRM[2]!;
    const A = CW[k]! * (FLEX_AGREE_FLOOR + smoothstep(-0.2, 0.8, agree));
    ax += A * TRI[o + 3]!;
    ay += A * TRI[o + 4]!;
    az += A * TRI[o + 5]!;
    tx += A * TRI[o + 6]!;
    ty += A * TRI[o + 7]!;
    tz += A * TRI[o + 8]!;
  }
  normalizeInto(ax, ay, az, out, 3);
  if (withTangent && tangentOut) {
    const qx = out[3]!, qy = out[4]!, qz = out[5]!;
    const p = tx * qx + ty * qy + tz * qz;
    normalizeInto(tx - p * qx, ty - p * qy, tz - p * qz, tangentOut, 0);
    tangentOut[3] = panel.restTangent ? (panel.restTangent[4 * v + 3]! < 0 ? -1 : 1) : 1;
  }
}
