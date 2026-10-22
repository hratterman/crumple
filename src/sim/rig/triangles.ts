/**
 * R-CORE collision triangles: compile declared ones (RigDef.triangles),
 * derive them for rigs that declare none, and the per-rig contact data
 * (edge beams for tearing, self-collision exclusions). PURE (no engine /
 * state imports): main may import it like the rest of src/sim/rig.
 *
 * DERIVATION (`deriveCollisionTriangles`): the collision surface of a node-
 * and-beam body is the set of its beam triangles (3-cycles of the beam
 * graph) that face open space in the rest pose:
 *   1. every 3-cycle among the chosen nodes, skipping slivers, plus every
 *      planar 4-cycle without a diagonal beam as two triangles over a
 *      virtual diagonal (lattice panels braced only at their edges);
 *   2. per side (±n) four rays (from the centroid and from points halfway to
 *      each vertex) are cast against all other candidates; a side is OPEN
 *      when at least two escape and no fewer than on the other side. One
 *      open side → kept, wound so the normal points out; both equally open →
 *      kept two-sided (a lone sheet); none → interior, dropped;
 *   3. a crossbraced quad yields four overlapping coplanar triangles: in
 *      canonical (a < b < c) order, a candidate that shares an edge with an
 *      accepted coplanar triangle and lies on the same side of that edge is
 *      dropped (one diagonal survives).
 * Rest-pose geometry only; O(T · rays · cells) through a uniform grid.
 */
import {
  RIG_NODE_FLAG_COLLIDABLE,
  RIG_NODE_FLAG_OBJ_CONTACT,
  RIG_TRI_FLAG_SELF,
  RIG_TRI_FLAG_TWO_SIDED,
  type CompiledRig,
  type CompiledTriangles,
  type RigTriangleDef,
} from './types';

/** Default contact material of declared triangles without one (MaterialId.metal). */
export const TRIANGLE_DEFAULT_MATERIAL = 6;
/** Candidates with a smaller area (m²) or a smaller altitude (m) are slivers. */
const MIN_AREA = 2e-4;
const MIN_ALTITUDE = 0.01;
/** Coplanar test for the quad dedupe: |n_a · n_b| above this. */
const COPLANAR_COS = Math.cos((10 * Math.PI) / 180);
/** A 4-cycle is a planar quad when its 4th node is within this fraction of the diagonal off the plane. */
const QUAD_PLANAR = 0.15;
/** Diagnostics: quad-face candidates of the last derivation. */
export let quadTris = 0;
/** Ray start offset off the triangle plane, m. */
const RAY_EPS = 1e-3;
/**
 * Self-collision exclusion: a node within this distance (+ its radius +
 * the triangle's half thickness) of a triangle in the rest pose never
 * collides with it (it touches it by design).
 */
export const SELF_REST_GAP = 0.03;

export function emptyTriangles(): CompiledTriangles {
  return { count: 0, a: new Int32Array(0), b: new Int32Array(0), c: new Int32Array(0), flags: new Uint8Array(0), material: new Uint8Array(0), thickness: new Float64Array(0) };
}

/** Compiles declared triangles (node ids → indices); throws on unknown / repeated vertices or bad values. */
export function compileTriangleDefs(defs: readonly RigTriangleDef[], index: ReadonlyMap<string, number>): CompiledTriangles {
  const n = defs.length;
  const out: CompiledTriangles = {
    count: n,
    a: new Int32Array(n),
    b: new Int32Array(n),
    c: new Int32Array(n),
    flags: new Uint8Array(n),
    material: new Uint8Array(n),
    thickness: new Float64Array(n),
  };
  for (let t = 0; t < n; t++) {
    const d = defs[t]!;
    const ia = index.get(d.a);
    const ib = index.get(d.b);
    const ic = index.get(d.c);
    if (ia === undefined || ib === undefined || ic === undefined) throw new Error(`triangle ${t}: unknown node (${d.a}, ${d.b}, ${d.c})`);
    if (ia === ib || ib === ic || ia === ic) throw new Error(`triangle ${t}: repeated node`);
    const mat = d.material ?? TRIANGLE_DEFAULT_MATERIAL;
    if (!Number.isInteger(mat) || mat < 0 || mat > 254) throw new Error(`triangle ${t}: invalid material ${String(mat)}`);
    const h = d.thickness ?? 0;
    if (!(h >= 0) || !Number.isFinite(h)) throw new Error(`triangle ${t}: thickness must be ≥ 0`);
    out.a[t] = ia;
    out.b[t] = ib;
    out.c[t] = ic;
    out.flags[t] = (d.twoSided ? RIG_TRI_FLAG_TWO_SIDED : 0) | (d.selfCollide === false ? 0 : RIG_TRI_FLAG_SELF);
    out.material[t] = mat;
    out.thickness[t] = h;
  }
  return out;
}

// ------------------------------------------------------------------ derivation
interface Cand {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Uniform grid over candidate triangle AABBs (rest pose) for the visibility rays. */
class TriGrid {
  readonly cell: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly start: Int32Array;
  readonly items: Int32Array;
  constructor(
    private readonly P: Float64Array,
    private readonly cands: readonly Cand[],
    cell: number,
  ) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const t of cands) {
      for (const v of [t.a, t.b, t.c]) {
        x0 = Math.min(x0, P[3 * v]!); y0 = Math.min(y0, P[3 * v + 1]!); z0 = Math.min(z0, P[3 * v + 2]!);
        x1 = Math.max(x1, P[3 * v]!); y1 = Math.max(y1, P[3 * v + 1]!); z1 = Math.max(z1, P[3 * v + 2]!);
      }
    }
    this.cell = cell;
    this.ox = x0 - cell;
    this.oy = y0 - cell;
    this.oz = z0 - cell;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 2);
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 2);
    this.nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 2);
    const cells = this.nx * this.ny * this.nz;
    const count = new Int32Array(cells + 1);
    const ranges: number[][] = [];
    for (let i = 0; i < cands.length; i++) {
      const r = this.range(cands[i]!);
      ranges.push(r);
      for (let z = r[2]!; z <= r[5]!; z++) for (let y = r[1]!; y <= r[4]!; y++) for (let x = r[0]!; x <= r[3]!; x++) count[this.id(x, y, z) + 1]!++;
    }
    for (let i = 0; i < cells; i++) count[i + 1]! += count[i]!;
    this.start = count;
    this.items = new Int32Array(count[cells]!);
    const fill = count.slice(0, cells);
    for (let i = 0; i < cands.length; i++) {
      const r = ranges[i]!;
      for (let z = r[2]!; z <= r[5]!; z++) for (let y = r[1]!; y <= r[4]!; y++) for (let x = r[0]!; x <= r[3]!; x++) this.items[fill[this.id(x, y, z)]!++] = i;
    }
  }
  private id(x: number, y: number, z: number): number {
    return (z * this.ny + y) * this.nx + x;
  }
  private range(t: Cand): number[] {
    const P = this.P;
    const ix = (v: number, k: number, o: number, n: number): number => Math.min(n - 1, Math.max(0, Math.floor((P[3 * v + k]! - o) / this.cell)));
    const xs = [t.a, t.b, t.c].map((v) => ix(v, 0, this.ox, this.nx));
    const ys = [t.a, t.b, t.c].map((v) => ix(v, 1, this.oy, this.ny));
    const zs = [t.a, t.b, t.c].map((v) => ix(v, 2, this.oz, this.nz));
    return [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  }
  /** True when the ray from (x, y, z) along unit (dx, dy, dz) hits a candidate other than `self` (3D DDA). */
  hits(x: number, y: number, z: number, dx: number, dy: number, dz: number, self: number, mark: Int32Array, stamp: number): boolean {
    const c = this.cell;
    let cx = Math.floor((x - this.ox) / c);
    let cy = Math.floor((y - this.oy) / c);
    let cz = Math.floor((z - this.oz) / c);
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(c / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(c / dz) : Infinity;
    let tmx = dx !== 0 ? ((this.ox + (cx + (dx > 0 ? 1 : 0)) * c - x) / dx) : Infinity;
    let tmy = dy !== 0 ? ((this.oy + (cy + (dy > 0 ? 1 : 0)) * c - y) / dy) : Infinity;
    let tmz = dz !== 0 ? ((this.oz + (cz + (dz > 0 ? 1 : 0)) * c - z) / dz) : Infinity;
    while (cx >= 0 && cy >= 0 && cz >= 0 && cx < this.nx && cy < this.ny && cz < this.nz) {
      const cid = this.id(cx, cy, cz);
      for (let k = this.start[cid]!; k < this.start[cid + 1]!; k++) {
        const t = this.items[k]!;
        if (t === self || mark[t] === stamp) continue;
        mark[t] = stamp;
        if (rayHitsTri(this.P, this.cands[t]!, x, y, z, dx, dy, dz)) return true;
      }
      if (tmx <= tmy && tmx <= tmz) {
        cx += sx;
        tmx += tdx;
      } else if (tmy <= tmz) {
        cy += sy;
        tmy += tdy;
      } else {
        cz += sz;
        tmz += tdz;
      }
    }
    return false;
  }
}

/** Möller–Trumbore, t > 0, edges inclusive. */
function rayHitsTri(P: Float64Array, t: Cand, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  const ax = P[3 * t.a]!, ay = P[3 * t.a + 1]!, az = P[3 * t.a + 2]!;
  const e1x = P[3 * t.b]! - ax, e1y = P[3 * t.b + 1]! - ay, e1z = P[3 * t.b + 2]! - az;
  const e2x = P[3 * t.c]! - ax, e2y = P[3 * t.c + 1]! - ay, e2z = P[3 * t.c + 2]! - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return false;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt > 1e-9;
}

export interface DeriveOptions {
  /** Rig-local nodes considered (default: the first `nodeCount`... all collidable / object-contact nodes). */
  nodeCount?: number;
  /** Contact material of the derived triangles. Default metal. */
  material?: number;
}

/**
 * Derives the collision surface of `rig` (see header) over nodes
 * [0, opts.nodeCount ?? rig.nodeCount) that are collidable or object-contact.
 */
export function deriveCollisionTriangles(rig: CompiledRig, opts: DeriveOptions = {}): CompiledTriangles {
  const N = Math.min(opts.nodeCount ?? rig.nodeCount, rig.nodeCount);
  const P = rig.nodePos;
  const use = new Uint8Array(N);
  for (let i = 0; i < N; i++) use[i] = (rig.nodeFlags[i]! & (RIG_NODE_FLAG_COLLIDABLE | RIG_NODE_FLAG_OBJ_CONTACT)) !== 0 ? 1 : 0;
  // Sorted adjacency (higher neighbours only) over the chosen nodes.
  const nb: Set<number>[] = [];
  for (let i = 0; i < N; i++) nb.push(new Set());
  for (let b = 0; b < rig.beamCount; b++) {
    const u = rig.beamA[b]!;
    const v = rig.beamB[b]!;
    if (u >= N || v >= N || u === v || !use[u] || !use[v]) continue;
    nb[Math.min(u, v)]!.add(Math.max(u, v));
  }
  const adj = nb.map((s) => Int32Array.from([...s].sort((x, y) => x - y)));
  const has = (u: number, v: number): boolean => {
    const lo = Math.min(u, v);
    const hi = Math.max(u, v);
    const a = adj[lo]!;
    let l = 0;
    let h = a.length - 1;
    while (l <= h) {
      const m = (l + h) >> 1;
      if (a[m] === hi) return true;
      if (a[m]! < hi) l = m + 1;
      else h = m - 1;
    }
    return false;
  };
  // 1. candidates
  const cands: Cand[] = [];
  for (let i = 0; i < N; i++) {
    const ai = adj[i]!;
    for (let x = 0; x < ai.length; x++) {
      const j = ai[x]!;
      for (let y = x + 1; y < ai.length; y++) {
        const k = ai[y]!;
        if (!has(j, k)) continue;
        const e1x = P[3 * j]! - P[3 * i]!, e1y = P[3 * j + 1]! - P[3 * i + 1]!, e1z = P[3 * j + 2]! - P[3 * i + 2]!;
        const e2x = P[3 * k]! - P[3 * i]!, e2y = P[3 * k + 1]! - P[3 * i + 1]!, e2z = P[3 * k + 2]! - P[3 * i + 2]!;
        const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const area = 0.5 * len;
        if (area < MIN_AREA) continue;
        const e3 = Math.max(Math.hypot(e1x, e1y, e1z), Math.hypot(e2x, e2y, e2z), Math.hypot(e2x - e1x, e2y - e1y, e2z - e1z));
        if ((2 * area) / e3 < MIN_ALTITUDE) continue;
        cands.push({ a: i, b: j, c: k, nx: cx / len, ny: cy / len, nz: cz / len });
      }
    }
  }
  // 1b. planar quads WITHOUT a diagonal beam (a lattice panel braced only at its edges): two triangles over a
  // virtual diagonal (the lower-index pair), so the surface has no holes where the rig has no diagonals.
  const triCount = cands.length;
  for (let i = 0; i < N; i++) {
    const ai = adj[i]!;
    for (let x = 0; x < ai.length; x++) {
      const j = ai[x]!;
      for (let y = x + 1; y < ai.length; y++) {
        const k = ai[y]!;
        if (has(j, k)) continue; // a triangle, handled above
        // l: common neighbour of j and k, l > i, not adjacent to i (no diagonal i–l).
        const aj = adj[j]!;
        for (let z = 0; z < aj.length; z++) {
          const l = aj[z]!;
          if (l === k || l <= i || !has(k, l) || has(i, l)) continue;
          // Planarity: l's distance from plane (i, j, k) under QUAD_PLANAR of the diagonal j–k.
          const e1x = P[3 * j]! - P[3 * i]!, e1y = P[3 * j + 1]! - P[3 * i + 1]!, e1z = P[3 * j + 2]! - P[3 * i + 2]!;
          const e2x = P[3 * k]! - P[3 * i]!, e2y = P[3 * k + 1]! - P[3 * i + 1]!, e2z = P[3 * k + 2]! - P[3 * i + 2]!;
          const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (!(ln > 0)) continue;
          const off = Math.abs((P[3 * l]! - P[3 * i]!) * nx + (P[3 * l + 1]! - P[3 * i + 1]!) * ny + (P[3 * l + 2]! - P[3 * i + 2]!) * nz) / ln;
          const diag = Math.hypot(P[3 * k]! - P[3 * j]!, P[3 * k + 1]! - P[3 * j + 1]!, P[3 * k + 2]! - P[3 * j + 2]!);
          if (off > QUAD_PLANAR * diag) continue;
          // Convex quad i–j–l–k: j and k on opposite sides of the virtual diagonal i–l.
          for (const [p, q2, r] of [[i, j, l], [i, l, k]] as const) {
            const f1x = P[3 * q2]! - P[3 * p]!, f1y = P[3 * q2 + 1]! - P[3 * p + 1]!, f1z = P[3 * q2 + 2]! - P[3 * p + 2]!;
            const f2x = P[3 * r]! - P[3 * p]!, f2y = P[3 * r + 1]! - P[3 * p + 1]!, f2z = P[3 * r + 2]! - P[3 * p + 2]!;
            const cx = f1y * f2z - f1z * f2y, cy = f1z * f2x - f1x * f2z, cz = f1x * f2y - f1y * f2x;
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
            if (0.5 * len < MIN_AREA) continue;
            cands.push({ a: p, b: q2, c: r, nx: cx / len, ny: cy / len, nz: cz / len });
          }
        }
      }
    }
  }
  quadTris = cands.length - triCount;
  if (cands.length === 0) return emptyTriangles();
  // 2. open sides
  const grid = new TriGrid(P, cands, 0.25);
  const mark = new Int32Array(cands.length);
  let stamp = 0;
  /** Rays (of 4) along sgn·n that escape the candidate set. */
  const open = (t: number, sgn: number): number => {
    const c = cands[t]!;
    const dx = sgn * c.nx, dy = sgn * c.ny, dz = sgn * c.nz;
    const gx = (P[3 * c.a]! + P[3 * c.b]! + P[3 * c.c]!) / 3;
    const gy = (P[3 * c.a + 1]! + P[3 * c.b + 1]! + P[3 * c.c + 1]!) / 3;
    const gz = (P[3 * c.a + 2]! + P[3 * c.b + 2]! + P[3 * c.c + 2]!) / 3;
    let escaped = 0;
    for (let s = 0; s < 4; s++) {
      let x = gx, y = gy, z = gz;
      if (s > 0) {
        const v = s === 1 ? c.a : s === 2 ? c.b : c.c;
        x = 0.5 * (gx + P[3 * v]!);
        y = 0.5 * (gy + P[3 * v + 1]!);
        z = 0.5 * (gz + P[3 * v + 2]!);
      }
      stamp++;
      if (!grid.hits(x + dx * RAY_EPS, y + dy * RAY_EPS, z + dz * RAY_EPS, dx, dy, dz, t, mark, stamp)) escaped++;
    }
    return escaped;
  };
  // 3. keep + orient + quad dedupe
  const keptA: number[] = [];
  const keptB: number[] = [];
  const keptC: number[] = [];
  const keptFlags: number[] = [];
  const keptN: number[] = [];
  const byEdge = new Map<number, number[]>();
  const ek = (u: number, v: number): number => Math.min(u, v) * 1048576 + Math.max(u, v);
  for (let t = 0; t < cands.length; t++) {
    const c = cands[t]!;
    // A side is OPEN when at least half its rays escape (a face seen through a gap in the structure in
    // front of it still faces out); the normal points to the more open side.
    const nUp = open(t, 1);
    const nDown = open(t, -1);
    const up = nUp >= 2 && nUp >= nDown;
    const down = nDown >= 2 && nDown >= nUp;
    if (!up && !down) continue;
    // Quad dedupe against accepted coplanar triangles sharing an edge.
    let overlap = false;
    const verts = [c.a, c.b, c.c];
    for (let e = 0; e < 3 && !overlap; e++) {
      const u = verts[e]!;
      const v = verts[(e + 1) % 3]!;
      const w = verts[(e + 2) % 3]!;
      for (const k of byEdge.get(ek(u, v)) ?? []) {
        const n0 = keptN[3 * k]!, n1 = keptN[3 * k + 1]!, n2 = keptN[3 * k + 2]!;
        if (Math.abs(n0 * c.nx + n1 * c.ny + n2 * c.nz) < COPLANAR_COS) continue;
        const o = keptA[k] !== u && keptA[k] !== v ? keptA[k]! : keptB[k] !== u && keptB[k] !== v ? keptB[k]! : keptC[k]!;
        if (sameSide(P, u, v, w, o, c)) {
          overlap = true;
          break;
        }
      }
    }
    if (overlap) continue;
    const id = keptA.length;
    // Wind so the normal points to the open side (both open: keep, two-sided).
    if (!up && down) {
      keptA.push(c.a);
      keptB.push(c.c);
      keptC.push(c.b);
      keptN.push(-c.nx, -c.ny, -c.nz);
    } else {
      keptA.push(c.a);
      keptB.push(c.b);
      keptC.push(c.c);
      keptN.push(c.nx, c.ny, c.nz);
    }
    keptFlags.push((up && down ? RIG_TRI_FLAG_TWO_SIDED : 0) | RIG_TRI_FLAG_SELF);
    for (let e = 0; e < 3; e++) {
      const key = ek(verts[e]!, verts[(e + 1) % 3]!);
      let list = byEdge.get(key);
      if (!list) byEdge.set(key, (list = []));
      list.push(id);
    }
  }
  const n = keptA.length;
  return {
    count: n,
    a: Int32Array.from(keptA),
    b: Int32Array.from(keptB),
    c: Int32Array.from(keptC),
    flags: Uint8Array.from(keptFlags),
    material: new Uint8Array(n).fill(opts.material ?? TRIANGLE_DEFAULT_MATERIAL),
    thickness: new Float64Array(n),
  };
}

/** Third vertices w (candidate) and o (accepted) on the same side of edge (u, v), in the plane of the candidate. */
function sameSide(P: Float64Array, u: number, v: number, w: number, o: number, c: Cand): boolean {
  const ex = P[3 * v]! - P[3 * u]!, ey = P[3 * v + 1]! - P[3 * u + 1]!, ez = P[3 * v + 2]! - P[3 * u + 2]!;
  // In-plane edge normal m = n × e.
  const mx = c.ny * ez - c.nz * ey, my = c.nz * ex - c.nx * ez, mz = c.nx * ey - c.ny * ex;
  const sw = (P[3 * w]! - P[3 * u]!) * mx + (P[3 * w + 1]! - P[3 * u + 1]!) * my + (P[3 * w + 2]! - P[3 * u + 2]!) * mz;
  const so = (P[3 * o]! - P[3 * u]!) * mx + (P[3 * o + 1]! - P[3 * u + 1]!) * my + (P[3 * o + 2]! - P[3 * u + 2]!) * mz;
  return sw * so > 0;
}

// ------------------------------------------------------------------ contact data
/**
 * Per-rig contact data for the triangle kernel (collision/triangles.ts):
 * the beams along each triangle edge (a triangle is TORN once one edge has
 * beams and all of them are broken) and the self-collision exclusion list
 * per triangle (sorted rig-local node indices).
 */
export interface TriangleSet {
  tris: CompiledTriangles;
  /** CSR over 3·t + edge (edge 0 = a–b, 1 = b–c, 2 = c–a): rig-local beam indices. */
  edgeStart: Int32Array;
  edgeBeams: Int32Array;
  /** CSR over triangles: sorted rig-local nodes that never self-collide with it. */
  exclStart: Int32Array;
  excl: Int32Array;
  /** Max half thickness over the set, m. */
  maxThickness: number;
}

const setCache = new WeakMap<CompiledRig, WeakMap<CompiledTriangles, TriangleSet>>();

/** Builds (once per rig + triangle set) the edge-beam and exclusion tables. */
export function triangleSetOf(rig: CompiledRig, tris: CompiledTriangles): TriangleSet {
  let byTris = setCache.get(rig);
  if (!byTris) setCache.set(rig, (byTris = new WeakMap()));
  const hit = byTris.get(tris);
  if (hit) return hit;
  const T = tris.count;
  const n = rig.nodeCount;
  // Beam lists per unordered node pair + neighbour lists.
  const pairBeams = new Map<number, number[]>();
  const nbrs: number[][] = [];
  for (let i = 0; i < n; i++) nbrs.push([]);
  const key = (u: number, v: number): number => Math.min(u, v) * 1048576 + Math.max(u, v);
  for (let b = 0; b < rig.beamCount; b++) {
    const u = rig.beamA[b]!;
    const v = rig.beamB[b]!;
    const k = key(u, v);
    let l = pairBeams.get(k);
    if (!l) pairBeams.set(k, (l = []));
    l.push(b);
    nbrs[u]!.push(v);
    nbrs[v]!.push(u);
  }
  const edgeStart = new Int32Array(3 * T + 1);
  const edgeList: number[] = [];
  const exclStart = new Int32Array(T + 1);
  const exclList: number[] = [];
  const P = rig.nodePos;
  let maxH = 0;
  for (let t = 0; t < T; t++) {
    const v = [tris.a[t]!, tris.b[t]!, tris.c[t]!];
    for (let e = 0; e < 3; e++) {
      edgeStart[3 * t + e] = edgeList.length;
      for (const b of pairBeams.get(key(v[e]!, v[(e + 1) % 3]!)) ?? []) edgeList.push(b);
    }
    const h = tris.thickness[t]!;
    if (h > maxH) maxH = h;
    const ex = new Set<number>(v);
    for (const x of v) for (const y of nbrs[x]!) ex.add(y);
    if ((tris.flags[t]! & RIG_TRI_FLAG_SELF) !== 0) {
      for (let i = 0; i < n; i++) {
        if (ex.has(i) || !selfNode(rig, i)) continue;
        const d = pointTriangleDistance(P, 3 * i, v[0]!, v[1]!, v[2]!);
        if (d < rig.nodeRadius[i]! + h + SELF_REST_GAP) ex.add(i);
      }
    }
    exclStart[t] = exclList.length;
    for (const x of [...ex].sort((p, q) => p - q)) exclList.push(x);
  }
  edgeStart[3 * T] = edgeList.length;
  exclStart[T] = exclList.length;
  const set: TriangleSet = { tris, edgeStart, edgeBeams: Int32Array.from(edgeList), exclStart, excl: Int32Array.from(exclList), maxThickness: maxH };
  byTris.set(tris, set);
  return set;
}

/** Self-collision participant: CompiledRig.nodeSelfCollide, else collidable. */
export function selfNode(rig: CompiledRig, i: number): boolean {
  const s = rig.nodeSelfCollide;
  return s ? s[i] !== 0 : (rig.nodeFlags[i]! & RIG_NODE_FLAG_COLLIDABLE) !== 0;
}

/** Distance from point P[o..o+2] to triangle (a, b, c) of the rig's rest positions. */
function pointTriangleDistance(P: Float64Array, o: number, a: number, b: number, c: number): number {
  const px = P[o]!, py = P[o + 1]!, pz = P[o + 2]!;
  const ax = P[3 * a]!, ay = P[3 * a + 1]!, az = P[3 * a + 2]!;
  const abx = P[3 * b]! - ax, aby = P[3 * b + 1]! - ay, abz = P[3 * b + 2]! - az;
  const acx = P[3 * c]! - ax, acy = P[3 * c + 1]! - ay, acz = P[3 * c + 2]! - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const dist = (x: number, y: number, z: number): number => Math.hypot(px - x, py - y, pz - z);
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = px - P[3 * b]!, bpy = py - P[3 * b + 1]!, bpz = pz - P[3 * b + 2]!;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(P[3 * b]!, P[3 * b + 1]!, P[3 * b + 2]!);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist(ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = px - P[3 * c]!, cpy = py - P[3 * c + 1]!, cpz = pz - P[3 * c + 2]!;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(P[3 * c]!, P[3 * c + 1]!, P[3 * c + 2]!);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist(ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bx = P[3 * b]!, by = P[3 * b + 1]!, bz = P[3 * b + 2]!;
    return dist(bx + w * (P[3 * c]! - bx), by + w * (P[3 * c + 1]! - by), bz + w * (P[3 * c + 2]! - bz));
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
