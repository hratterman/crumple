/**
 * Flexbody binder (A2): PanelGeometry[] + CompiledVehicle → BindingSet.
 * Pure and deterministic (no three, no RNG, fixed iteration order); the
 * contract — triad selection, rejection/repair, seam welding, the exact
 * reconstruction formula — lives in ./types.ts "FLEXBODY RECONSTRUCTION".
 *
 * `evalFlexVertex` / `evalFlexFrame` are the CPU mirror of the `flex1`
 * vertex shader (flexskin.ts): same formula, same floors and clamps, in f64.
 */
import { RIG_BEAM_TYPE_ID, type CompiledRig } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import {
  BindError,
  FLEX_CANDIDATE_STEPS,
  FLEX_CROSS_FLOOR,
  FLEX_GS_FLOOR,
  FLEX_MAX_AB,
  FLEX_MAX_ABS_C,
  FLEX_MAX_EDGE,
  FLEX_MAX_EDGE_RATIO,
  FLEX_MAX_OBJECT_NODES,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEX_MIN_ANGLE_DEG,
  FLEX_MIN_EDGE,
  FLEX_SEAM_QUANTUM,
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

/** cos of the triad angle limits: accept iff |cos θ| ≤ this. */
const MAX_ABS_COS = Math.cos((FLEX_MIN_ANGLE_DEG * Math.PI) / 180);
const MIN_EDGE2 = FLEX_MIN_EDGE * FLEX_MIN_EDGE;
const MAX_EDGE2 = FLEX_MAX_EDGE * FLEX_MAX_EDGE;
const MAX_RATIO2 = FLEX_MAX_EDGE_RATIO * FLEX_MAX_EDGE_RATIO;
/**
 * Below this length a reconstructed normal/tangent is replaced by +Y (CPU
 * and GLSL alike): only reachable when a whole triad collapses to a point,
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

// ====================================================================== triad search
interface TriadResult {
  r: number;
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d0: number;
  score: number;
  cosAbs: number;
}

/** Static triad record: R(3) e1(3) e2(3) n̂(3) |e1|² |e2|² e1·e2 1/det |cos θ|. */
const TS = 17;

/**
 * Vertex-independent triad data (edges, angle test, n̂, Gram inverse),
 * cached per panel by LOCAL bind-set indices: neighbouring vertices share
 * candidate sets, so each node triple is analysed once.
 */
class TriadCache {
  /** Dense key → slot+2 table for small bind sets (0 = unknown, 1 = rejected), else a Map. */
  private readonly dense: Int32Array | null;
  private readonly map = new Map<number, number>();
  data = new Float64Array(TS * 1024);
  private count = 0;
  private readonly pos: Float64Array;
  private readonly bindNodes: Uint16Array;
  constructor(pos: Float64Array, bindNodes: Uint16Array) {
    this.pos = pos;
    this.bindNodes = bindNodes;
    const nb = bindNodes.length;
    this.dense = nb <= 128 ? new Int32Array(nb * nb * nb) : null;
  }

  /** Slot offset into `data`, or −1 when the triple fails the static acceptance rules. */
  get(lr: number, lx: number, ly: number): number {
    const nb = this.bindNodes.length;
    const key = (lr * nb + lx) * nb + ly;
    const dense = this.dense;
    if (dense) {
      const v = dense[key]!;
      if (v !== 0) return v - 2;
      const s = this.build(this.bindNodes[lr]!, this.bindNodes[lx]!, this.bindNodes[ly]!);
      dense[key] = s + 2;
      return s;
    }
    let s = this.map.get(key);
    if (s === undefined) {
      s = this.build(this.bindNodes[lr]!, this.bindNodes[lx]!, this.bindNodes[ly]!);
      this.map.set(key, s);
    }
    return s;
  }

  private build(r: number, x: number, y: number): number {
    const pos = this.pos;
    const rx = pos[3 * r]!;
    const ry = pos[3 * r + 1]!;
    const rz = pos[3 * r + 2]!;
    const e1x = pos[3 * x]! - rx;
    const e1y = pos[3 * x + 1]! - ry;
    const e1z = pos[3 * x + 2]! - rz;
    const e2x = pos[3 * y]! - rx;
    const e2y = pos[3 * y + 1]! - ry;
    const e2z = pos[3 * y + 2]! - rz;
    const l1 = e1x * e1x + e1y * e1y + e1z * e1z;
    const l2 = e2x * e2x + e2y * e2y + e2z * e2z;
    if (l1 < MIN_EDGE2 || l1 > MAX_EDGE2 || l2 < MIN_EDGE2 || l2 > MAX_EDGE2) return -1;
    if (l1 > l2 * MAX_RATIO2 || l2 > l1 * MAX_RATIO2) return -1;
    const g12 = e1x * e2x + e1y * e2y + e1z * e2z;
    const cosAbs = Math.abs(g12) / Math.sqrt(l1 * l2);
    if (!(cosAbs <= MAX_ABS_COS)) return -1;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const inv = 1 / (cl > FLEX_CROSS_FLOOR ? cl : FLEX_CROSS_FLOOR);
    if ((this.count + 1) * TS > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count++ * TS;
    const d = this.data;
    d[o] = rx;
    d[o + 1] = ry;
    d[o + 2] = rz;
    d[o + 3] = e1x;
    d[o + 4] = e1y;
    d[o + 5] = e1z;
    d[o + 6] = e2x;
    d[o + 7] = e2y;
    d[o + 8] = e2z;
    d[o + 9] = cx * inv;
    d[o + 10] = cy * inv;
    d[o + 11] = cz * inv;
    d[o + 12] = l1;
    d[o + 13] = l2;
    d[o + 14] = g12;
    d[o + 15] = 1 / (l1 * l2 - g12 * g12);
    d[o + 16] = cosAbs;
    return o;
  }
}

/**
 * Evaluates the cached triad at slot `o` for rest point p: writes a, b, c,
 * d0, score into `res` and returns true iff the per-vertex rules accept it.
 */
function evalTriad(d: Float64Array, o: number, px: number, py: number, pz: number, res: TriadResult): boolean {
  const dx = px - d[o]!;
  const dy = py - d[o + 1]!;
  const dz = pz - d[o + 2]!;
  const c = dx * d[o + 9]! + dy * d[o + 10]! + dz * d[o + 11]!;
  if (!(Math.abs(c) <= FLEX_MAX_ABS_C)) return false;
  // Gram system on the in-plane part (n̂ ⟂ e1, e2, so d·e_i is unaffected by c).
  const d1 = dx * d[o + 3]! + dy * d[o + 4]! + dz * d[o + 5]!;
  const d2 = dx * d[o + 6]! + dy * d[o + 7]! + dz * d[o + 8]!;
  const l1 = d[o + 12]!;
  const l2 = d[o + 13]!;
  const g12 = d[o + 14]!;
  const invDet = d[o + 15]!;
  const a = (d1 * l2 - d2 * g12) * invDet;
  const b = (d2 * l1 - d1 * g12) * invDet;
  if (!(Math.abs(a) <= FLEX_MAX_AB && Math.abs(b) <= FLEX_MAX_AB)) return false;
  const d0 = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const over = Math.abs(a) + Math.abs(b) - 1;
  res.a = a;
  res.b = b;
  res.c = c;
  res.d0 = d0;
  res.score = Math.abs(c) + 0.5 * d0 + 0.2 * (over > 0 ? over : 0);
  res.cosAbs = d[o + 16]!;
  return true;
}

/** Lexicographic (score, iR, iX, iY) "is better" test. */
function better(s: number, r: number, x: number, y: number, best: TriadResult): boolean {
  if (s !== best.score) return s < best.score;
  if (r !== best.r) return r < best.r;
  if (x !== best.x) return x < best.x;
  return y < best.y;
}

function newResult(): TriadResult {
  return { r: -1, x: -1, y: -1, a: 0, b: 0, c: 0, d0: 0, score: Infinity, cosAbs: 0 };
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

  const stats = { vertices: 0, triangles: 0, repaired: 0, welded: 0, maxAbsC: 0, minAngleDeg: 180 };
  const panels: BindingPanel[] = [];
  for (let pi = 0; pi < def.panels.length; pi++) {
    const pdef = def.panels[pi]!;
    const geom = geoms[pi]!;
    if (geom.panelId !== pdef.id) {
      throw new BindError(`panel ${pi}: geometry '${geom.panelId}' does not match def '${pdef.id}'`);
    }
    panels.push(bindPanel(rig, pdef, geom, pi, stats));
  }
  return { vehicle: compiled.name, nodeCount: rig.nodeCount, rigHash: rigHashOf(rig), panels, stats };
};

function bindPanel(rig: CompiledRig, pdef: PanelDef, geom: PanelGeometry, panelIndex: number, stats: BindingSet['stats']): BindingPanel {
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

  const triad = new Uint16Array(vcount * 3);
  const coef = new Float32Array(vcount * 4);
  const frameNormal = new Float32Array(vcount * 3);
  const frameTangent = geom.tangent ? new Float32Array(vcount * 4) : null;

  // Candidate scratch.
  const nb = bindNodes.length;
  const dist = new Float64Array(nb);
  const order = new Int32Array(nb);
  const best = newResult();
  const tmp = newResult();
  const cache = new TriadCache(pos, bindNodes);
  const seam = new SeamIndex(vcount);
  const q = 1 / FLEX_SEAM_QUANTUM;

  for (let v = 0; v < vcount; v++) {
    const px = geom.position[3 * v]!;
    const py = geom.position[3 * v + 1]!;
    const pz = geom.position[3 * v + 2]!;
    if (!Number.isFinite(px + py + pz)) throw new BindError(`${what}: vertex ${v} is not finite`);
    const first = seam.find(v, Math.round(px * q), Math.round(py * q), Math.round(pz * q));
    if (first >= 0) {
      triad[3 * v] = triad[3 * first]!;
      triad[3 * v + 1] = triad[3 * first + 1]!;
      triad[3 * v + 2] = triad[3 * first + 2]!;
      for (let k = 0; k < 4; k++) coef[4 * v + k] = coef[4 * first + k]!;
      stats.welded++;
    } else {
      // Distances to every bind node; candidates sorted by (d², index).
      for (let k = 0; k < nb; k++) {
        const n = bindNodes[k]!;
        const dx = pos[3 * n]! - px;
        const dy = pos[3 * n + 1]! - py;
        const dz = pos[3 * n + 2]! - pz;
        dist[k] = dx * dx + dy * dy + dz * dz;
        order[k] = k;
      }
      best.score = Infinity;
      best.r = -1;
      let step = 0;
      let prevK = 0;
      for (; step < FLEX_CANDIDATE_STEPS.length; step++) {
        const k = Math.min(nb, FLEX_CANDIDATE_STEPS[step]!);
        if (k <= prevK) continue;
        selectNearest(dist, k, order);
        prevK = k;
        const rMax = Math.min(3, k);
        for (let ri = 0; ri < rMax; ri++) {
          const lr = order[ri]!;
          // score ≥ 0.5·|P − R|: a farther R cannot win.
          if (0.5 * Math.sqrt(dist[lr]!) > best.score) continue;
          const r = bindNodes[lr]!;
          for (let xi = 0; xi < k; xi++) {
            if (xi === ri) continue;
            for (let yi = xi + 1; yi < k; yi++) {
              if (yi === ri) continue;
              let lx = order[xi]!;
              let ly = order[yi]!;
              if (lx > ly) {
                const t = lx;
                lx = ly;
                ly = t;
              }
              const o = cache.get(lr, lx, ly);
              if (o < 0 || !evalTriad(cache.data, o, px, py, pz, tmp)) continue;
              const x = bindNodes[lx]!;
              const y = bindNodes[ly]!;
              if (better(tmp.score, r, x, y, best)) {
                best.r = r;
                best.x = x;
                best.y = y;
                best.a = tmp.a;
                best.b = tmp.b;
                best.c = tmp.c;
                best.d0 = tmp.d0;
                best.score = tmp.score;
                best.cosAbs = tmp.cosAbs;
              }
            }
          }
        }
        if (best.r >= 0) break;
        if (k >= nb) {
          step = FLEX_CANDIDATE_STEPS.length;
          break;
        }
      }
      if (best.r < 0) {
        throw new BindError(
          `${what}: vertex ${v} at (${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)}) has no acceptable triad among ${nb} bind nodes`,
        );
      }
      if (step > 0) stats.repaired++;
      triad[3 * v] = best.r;
      triad[3 * v + 1] = best.x;
      triad[3 * v + 2] = best.y;
      coef[4 * v] = best.a;
      coef[4 * v + 1] = best.b;
      coef[4 * v + 2] = best.c;
      coef[4 * v + 3] = best.d0;
      const absC = Math.abs(best.c);
      if (absC > stats.maxAbsC) stats.maxAbsC = absC;
      const ang = (Math.acos(Math.min(1, best.cosAbs)) * 180) / Math.PI;
      if (ang < stats.minAngleDeg) stats.minAngleDeg = ang;
    }
    // Per-vertex frame-local normal / tangent in the (shared) triad's rest GS frame.
    restFrame(pos, triad[3 * v]!, triad[3 * v + 1]!, triad[3 * v + 2]!, FRAME);
    const nx = geom.normal[3 * v]!;
    const ny = geom.normal[3 * v + 1]!;
    const nz = geom.normal[3 * v + 2]!;
    toFrame(FRAME, nx, ny, nz, frameNormal, 3 * v);
    if (frameTangent && geom.tangent) {
      toFrame(FRAME, geom.tangent[4 * v]!, geom.tangent[4 * v + 1]!, geom.tangent[4 * v + 2]!, frameTangent, 4 * v);
      frameTangent[4 * v + 3] = geom.tangent[4 * v + 3]! < 0 ? -1 : 1;
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

  const weight = new Float32Array(vcount);
  if (geom.damageWeight) weight.set(geom.damageWeight);
  else weight.fill(pdef.damageWeight ?? defaultDamageWeight(pdef.material));

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
    frameNormal,
    frameTangent,
    damageWeight: weight,
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

/**
 * order[0..k) = the k nearest local indices sorted by (dist, index): one
 * pass with insertion into the running top-k (k is 8 or 16 except for the
 * rare whole-set repair, which sorts everything).
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
/** GS frame f1, f2, f3 (row-major 9 floats). */
const FRAME = new Float64Array(9);

function restFrame(pos: Float64Array, r: number, x: number, y: number, out: Float64Array): void {
  gsFrame(
    pos[3 * x]! - pos[3 * r]!,
    pos[3 * x + 1]! - pos[3 * r + 1]!,
    pos[3 * x + 2]! - pos[3 * r + 2]!,
    pos[3 * y]! - pos[3 * r]!,
    pos[3 * y + 1]! - pos[3 * r + 1]!,
    pos[3 * y + 2]! - pos[3 * r + 2]!,
    out,
  );
}

/** Gram–Schmidt frame exactly as the shader: f1 = e1/max(|e1|,ε), f2 = t/max(|t|,ε), f3 = f1×f2. */
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

function toFrame(f: Float64Array, x: number, y: number, z: number, out: Float32Array, o: number): void {
  out[o] = x * f[0]! + y * f[1]! + z * f[2]!;
  out[o + 1] = x * f[3]! + y * f[4]! + z * f[5]!;
  out[o + 2] = x * f[6]! + y * f[7]! + z * f[8]!;
}

// ====================================================================== CPU mirror of the shader
const EVAL_FRAME = new Float64Array(9);

/**
 * Normalizes (x, y, z) into out[o..o+3). Degenerate (zero-length) input —
 * only possible when the whole triad collapsed — yields +Y instead of NaN
 * (the shader does the same; a NaN normal would poison the HDR post chain).
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
  const ir = panel.triad[3 * v]! * 3;
  const ix = panel.triad[3 * v + 1]! * 3;
  const iy = panel.triad[3 * v + 2]! * 3;
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
  const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const inv = 1 / Math.max(cl, FLEX_CROSS_FLOOR);
  const a = panel.coef[4 * v]!;
  const b = panel.coef[4 * v + 1]!;
  const c = panel.coef[4 * v + 2]! * inv;
  const d0 = panel.coef[4 * v + 3]!;
  const ox = a * e1x + b * e2x + c * cx;
  const oy = a * e1y + b * e2y + c * cy;
  const oz = a * e1z + b * e2z + c * cz;
  if (Math.sqrt(ox * ox + oy * oy + oz * oz) <= FLEX_MAX_STRETCH * d0 + FLEX_MAX_SLACK) {
    out[0] = rx + ox;
    out[1] = ry + oy;
    out[2] = rz + oz;
  } else {
    out[0] = rx;
    out[1] = ry;
    out[2] = rz;
  }
  const f = EVAL_FRAME;
  gsFrame(e1x, e1y, e1z, e2x, e2y, e2z, f);
  const fn = panel.frameNormal;
  const nx = fn[3 * v]!;
  const ny = fn[3 * v + 1]!;
  const nz = fn[3 * v + 2]!;
  normalizeInto(nx * f[0]! + ny * f[3]! + nz * f[6]!, nx * f[1]! + ny * f[4]! + nz * f[7]!, nx * f[2]! + ny * f[5]! + nz * f[8]!, out, 3);
  const ft = panel.frameTangent;
  if (tangentOut && ft) {
    const tx = ft[4 * v]!;
    const ty = ft[4 * v + 1]!;
    const tz = ft[4 * v + 2]!;
    normalizeInto(tx * f[0]! + ty * f[3]! + tz * f[6]!, tx * f[1]! + ty * f[4]! + tz * f[7]!, tx * f[2]! + ty * f[5]! + tz * f[8]!, tangentOut, 0);
    tangentOut[3] = ft[4 * v + 3]!;
  }
}
