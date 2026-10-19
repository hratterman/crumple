/**
 * Procedural vegetation meshes (pure: plain typed arrays, no three, so the
 * builders unit-test in node). Every mesh is in the instance's local frame:
 * trunk foot / rock centre at the origin, +Y up, size at scale 1.
 *
 * Vertex attributes: position, normal, uv (into the shared atlas, see
 * textures.ts) and `veg` = (leaf 0|1, ambient occlusion 0..1, sway weight
 * (height/treeHeight)², flutter weight 0..1). Merged multi-variant meshes add
 * `vvar` (variant id) for the vertex-stage variant select.
 *
 * Trees: conifer = spruce / fir / pine (whorls of folded needle-sprig cards
 * around a tapered trunk, a crossed-card core and leader); broadleaf = oak /
 * beech / birch (trunk + limbs + sub-branches as tapered tubes, leaf-cluster
 * card pairs on an ellipsoidal crown shell with spherical normals). LOD1 is
 * the same tree (same random stream for the skeleton) with far fewer,
 * larger cards. Shrubs: bush, scrub, reeds, fern. Rocks: displaced
 * icospheres (two detail levels).
 */
import { atlasRect, BARK_V_M, type AtlasRegion, type UvRect } from './atlas';

export interface VegMeshData {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  veg: Float32Array;
  /** Present on merged multi-variant meshes. */
  vvar: Float32Array | null;
  index: Uint32Array;
  vertexCount: number;
  triangles: number;
  /** Bounding sphere centre height and radius, and the top height (m, scale 1). */
  centerY: number;
  radius: number;
  height: number;
}

type V3 = [number, number, number];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Any unit vector perpendicular to `d`. */
function perp(d: V3): V3 {
  const a: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return norm(cross(d, a));
}

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  veg: number[] = [];
  vvar: number[] = [];
  idx: number[] = [];
  variant = 0;
  /** Tree height for sway weights. */
  swayH = 1;
  vert(p: V3, n: V3, u: number, v: number, leaf: number, ao: number, flutter: number, swayExtra = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    const nn = norm(n);
    this.nrm.push(nn[0], nn[1], nn[2]);
    this.uv.push(u, v);
    const h = Math.max(0, Math.min(1, p[1] / this.swayH));
    this.veg.push(leaf, ao, Math.min(1.3, h * h + swayExtra), flutter);
    this.vvar.push(this.variant);
    return i;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  get triangles(): number {
    return this.idx.length / 3;
  }
  /** Append another builder's mesh (keeps its vvar). */
  append(o: MeshBuilder): void {
    const base = this.pos.length / 3;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.uv.push(...o.uv);
    this.veg.push(...o.veg);
    this.vvar.push(...o.vvar);
    for (const i of o.idx) this.idx.push(i + base);
  }
  build(withVariant: boolean): VegMeshData {
    const n = this.pos.length / 3;
    let maxY = 0;
    let minY = Infinity;
    for (let i = 0; i < n; i++) {
      maxY = Math.max(maxY, this.pos[i * 3 + 1]!);
      minY = Math.min(minY, this.pos[i * 3 + 1]!);
    }
    const cy = (maxY + Math.max(0, minY)) * 0.5;
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3]!;
      const dy = this.pos[i * 3 + 1]! - cy;
      const dz = this.pos[i * 3 + 2]!;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      uv: new Float32Array(this.uv),
      veg: new Float32Array(this.veg),
      vvar: withVariant ? new Float32Array(this.vvar) : null,
      index: new Uint32Array(this.idx),
      vertexCount: n,
      triangles: this.idx.length / 3,
      centerY: cy,
      radius: Math.sqrt(r2),
      height: maxY,
    };
  }
}

// ------------------------------------------------------------ primitives
/**
 * Tapered tube along `pts` with radii `rad`; bark UV: u around (one repeat
 * in the strip), v = arc length / BARK_V_M (wraps vertically in the atlas).
 */
function tube(b: MeshBuilder, pts: V3[], rad: number[], sides: number, bark: UvRect, ao0: number, ao1: number, cap: boolean): void {
  const rings: number[][] = [];
  let arc = 0;
  let prevT: V3 = norm(sub(pts[1]!, pts[0]!));
  let side = perp(prevT);
  for (let i = 0; i < pts.length; i++) {
    const t = norm(i < pts.length - 1 ? sub(pts[i + 1]!, pts[i]!) : sub(pts[i]!, pts[i - 1]!));
    const tt = i > 0 && i < pts.length - 1 ? norm(add(t, norm(sub(pts[i]!, pts[i - 1]!)))) : t;
    // Parallel transport of the side vector (no twisting).
    side = norm(sub(side, mul(tt, dot(side, tt))));
    if (!Number.isFinite(side[0]) || len(side) < 0.5) side = perp(tt);
    const bin = cross(tt, side);
    if (i > 0) arc += len(sub(pts[i]!, pts[i - 1]!));
    const ring: number[] = [];
    const s = i / (pts.length - 1);
    const ao = ao0 + (ao1 - ao0) * s;
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const n: V3 = add(mul(side, Math.cos(a)), mul(bin, Math.sin(a)));
      const p = add(pts[i]!, mul(n, rad[i]!));
      ring.push(b.vert(p, n, bark.u + (k / sides) * bark.du, arc / BARK_V_M, 0, ao, 0));
    }
    rings.push(ring);
    prevT = tt;
  }
  void prevT;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < sides; k++) b.quad(rings[i]![k]!, rings[i]![k + 1]!, rings[i + 1]![k + 1]!, rings[i + 1]![k]!);
  }
  if (cap) {
    const last = pts[pts.length - 1]!;
    const t = norm(sub(last, pts[pts.length - 2]!));
    const c = b.vert(add(last, mul(t, rad[rad.length - 1]! * 0.8)), t, bark.u + bark.du * 0.5, arc / BARK_V_M, 0, ao1, 0);
    const ring = rings[rings.length - 1]!;
    for (let k = 0; k < sides; k++) b.tri(ring[k]!, ring[k + 1]!, c);
  }
}

/**
 * Leaf/needle card: a quad strip along `axis` (length L, `segs` segments,
 * bending by `bend(t)` added along `up`), width W across `across`. UV: u
 * along the card (region left → right), v across. Normals blend the card
 * normal with the radial direction from `center` (soft, volumetric foliage).
 */
function card(
  b: MeshBuilder,
  origin: V3,
  axis: V3,
  across: V3,
  L: number,
  W: number,
  segs: number,
  bend: (t: number) => V3,
  rect: UvRect,
  center: V3,
  radial: number,
  ao: (p: V3) => number,
  vAcross0 = 0,
  vAcross1 = 1,
  flutterBase = 0.15,
): void {
  const cardN = norm(cross(axis, across));
  let prev: number[] | null = null;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const c = add(add(origin, mul(axis, L * t)), bend(t));
    const row: number[] = [];
    for (let k = 0; k <= 1; k++) {
      const off = (k - 0.5) * W * (1 - 0.15 * t);
      const p = add(c, mul(across, off));
      let rn = sub(p, center);
      if (len(rn) < 1e-3) rn = cardN;
      const n = norm(lerp3(dot(cardN, rn) >= 0 ? cardN : mul(cardN, -1), norm(rn), radial));
      const v = vAcross0 + (vAcross1 - vAcross0) * k;
      row.push(b.vert(p, n, rect.u + rect.du * t, rect.v + rect.dv * v, 1, ao(p), flutterBase + (1 - flutterBase) * t));
    }
    if (prev) b.quad(prev[0]!, prev[1]!, row[1]!, row[0]!);
    prev = row;
  }
}

// ------------------------------------------------------------ conifers
export interface ConiferParams {
  height: number;
  baseRadius: number;
  crownStart: number; // fraction of height where foliage begins
  crownWidth: number; // max crown radius, m
  whorlStep: number;
  perWhorl: number;
  droop: number;
  upturn: number;
  shapeExp: number; // crown profile exponent
  region: AtlasRegion;
  pine: boolean;
  tiers: number;
  /** Tier apex height as a multiple of the tier spacing (overlap). */
  tierOverlap: number;
  /** Rim drop below the tier plane, fraction of the rim radius. */
  tierDrop: number;
}
export const CONIFER_PARAMS: readonly ConiferParams[] = [
  // spruce: dense, broad cone, drooping branches with upturned tips
  { height: 18, baseRadius: 0.2, crownStart: 0.08, crownWidth: 3.6, whorlStep: 0.95, perWhorl: 4, droop: 0.35, upturn: 0.45, shapeExp: 1.0, region: 'sprig', pine: false, tiers: 9, tierOverlap: 1.9, tierDrop: 0.3 },
  // fir: narrow spire, horizontal branches
  { height: 20, baseRadius: 0.2, crownStart: 0.12, crownWidth: 2.6, whorlStep: 0.85, perWhorl: 4, droop: 0.12, upturn: 0.25, shapeExp: 0.85, region: 'sprig', pine: false, tiers: 11, tierOverlap: 1.8, tierDrop: 0.18 },
  // pine: tall bare bole, rounded open crown of upswept branches
  { height: 19, baseRadius: 0.21, crownStart: 0.5, crownWidth: 3.4, whorlStep: 0.95, perWhorl: 4, droop: -0.55, upturn: 0.2, shapeExp: 0.6, region: 'pine', pine: true, tiers: 3, tierOverlap: 1.4, tierDrop: 0.05 },
];

/** Crown radius at height y for a conifer (0 outside the crown). */
function coniferCrown(p: ConiferParams, y: number): number {
  const y0 = p.height * p.crownStart;
  if (y < y0) return 0;
  const t = (y - y0) / (p.height - y0);
  if (p.pine) {
    // Rounded: widest around 35 % into the crown.
    const k = t < 0.35 ? 0.55 + 0.45 * smooth(t / 0.35) : Math.pow(Math.max(0, 1 - (t - 0.35) / 0.65), p.shapeExp);
    return p.crownWidth * k + 0.2;
  }
  // Slight belly near the base then a straight-ish cone.
  const belly = t < 0.08 ? 0.75 + 0.25 * (t / 0.08) : 1;
  return p.crownWidth * Math.pow(1 - t, p.shapeExp) * belly + 0.18;
}

export function buildConifer(variant: number, lod: 0 | 1): MeshBuilder {
  const P = CONIFER_PARAMS[variant]!;
  const r = rng(0x5eed + variant * 977);
  const b = new MeshBuilder();
  b.swayH = P.height;
  const bark = atlasRect('barkConifer');
  const rect = atlasRect(P.region);
  const H = P.height;
  // Trunk: slight lean / wobble.
  const trunk: V3[] = [];
  const rad: number[] = [];
  const nT = lod === 0 ? 9 : 4;
  const lean: V3 = [(r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25];
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    const y = -0.4 + (H * 0.97 + 0.4) * t;
    const w = lod === 0 ? (r() - 0.5) * 0.06 : 0;
    trunk.push([lean[0] * t * t + w, y, lean[2] * t * t + w]);
    const flare = 1 + 0.5 * Math.max(0, 1 - (y + 0.4) / 1.0);
    rad.push(P.baseRadius * (1 - 0.88 * t) * flare);
  }
  tube(b, trunk, rad, lod === 0 ? 8 : 5, bark, 0.45, 0.9, false);
  const trunkAt = (y: number): V3 => {
    const t = Math.max(0, Math.min(1, (y + 0.4) / (H * 0.97 + 0.4)));
    return [lean[0] * t * t, y, lean[2] * t * t];
  };
  const center: V3 = [0, H * (P.pine ? 0.72 : 0.42), 0];
  const aoOf = (p: V3): number => {
    const cr = coniferCrown(P, p[1]) || 0.5;
    const radial = Math.sqrt(p[0] * p[0] + p[2] * p[2]) / cr;
    const hTop = p[1] / H;
    return Math.max(0.25, Math.min(1, 0.32 + 0.55 * radial + 0.3 * hTop));
  };
  // Dead branch stubs on the pine's bare bole (LOD0 only).
  if (P.pine && lod === 0) {
    for (let k = 0; k < 7; k++) {
      const y = 2 + r() * (H * P.crownStart - 2.5);
      const a = r() * Math.PI * 2;
      const o = trunkAt(y);
      const d: V3 = norm([Math.cos(a), 0.25, Math.sin(a)]);
      tube(b, [o, add(o, mul(d, 0.5 + r() * 0.6))], [0.035, 0.012], 3, bark, 0.5, 0.6, false);
    }
  }
  const y0 = H * P.crownStart;
  // Tiers: drooping cones of wedge cards (the crown's solid volume; jagged rims from the spray tips).
  const tiers = lod === 0 || P.pine ? P.tiers : Math.max(5, P.tiers - 2);
  const wedges = lod === 0 || P.pine ? 8 : 6;
  const span = H - 0.6 - y0;
  for (let t = 0; t < tiers; t++) {
    const rimY = y0 + (span * t) / tiers + (r() - 0.5) * 0.2;
    const apexY = Math.min(H - 0.2, rimY + (span / tiers) * P.tierOverlap);
    const rim = coniferCrown(P, rimY) * 0.98;
    const drop = rim * P.tierDrop;
    const rot = r() * Math.PI * 2;
    const o = trunkAt(apexY);
    for (let w = 0; w < wedges; w++) {
      const a0 = rot + (w / wedges) * Math.PI * 2 + (r() - 0.5) * 0.25;
      const dirOut: V3 = [Math.cos(a0 + Math.PI / wedges), 0, Math.sin(a0 + Math.PI / wedges)];
      const across: V3 = norm(cross([0, 1, 0], dirOut));
      const L = Math.hypot(rim, apexY - rimY + drop) * (0.92 + 0.16 * r());
      const down = norm([dirOut[0] * rim, -(apexY - rimY), dirOut[2] * rim]);
      const W = 2 * rim * Math.sin(Math.PI / wedges) * 1.35 + 0.3;
      const sag = drop * 0.6;
      card(b, o, down, across, L, W, lod === 0 ? 2 : 1, (s) => [0, -sag * s * (1 - s) * 2.2, 0], rect, center, 0.65, aoOf, 0, 1, 0.12);
    }
  }
  // Individual branch sprays over the tiers (ragged silhouette, depth up close). Pines instead get
  // visible upswept limbs ending in needle tufts (3-D crossed cards), in both LODs from the same
  // random stream so LOD0 ↔ LOD1 ↔ impostor match.
  if (lod === 0 || P.pine) {
    const step = P.whorlStep;
    let az = r() * Math.PI * 2;
    for (let y = y0 + step * 0.5; y < H - 1.2; y += step * (0.85 + 0.3 * r())) {
      const cr = coniferCrown(P, y);
      for (let k = 0; k < P.perWhorl; k++) {
        az += 2.39996 + (r() - 0.5) * 0.5; // golden angle
        const o = trunkAt(y + (r() - 0.5) * step * 0.4);
        const L = cr * (0.9 + 0.25 * r());
        const dir: V3 = norm([Math.cos(az), -P.droop * 0.5, Math.sin(az)]);
        const side: V3 = norm(cross([0, 1, 0], dir));
        if (P.pine) {
          const tip = add(o, mul(dir, L * 0.92));
          const mid = add(o, mul(dir, L * 0.55));
          if (lod === 0) tube(b, [o, mid, tip], [0.07, 0.045, 0.02], 4, bark, 0.55, 0.7, false);
          for (const [at, sz] of [
            [tip, 1.9],
            [mid, 1.4],
          ] as const) {
            const tilt: V3 = norm(add(dir, [(r() - 0.5) * 0.6, 0.5 + r() * 0.4, (r() - 0.5) * 0.6]));
            const ax = norm(cross(tilt, side));
            const s2 = sz * (lod === 0 ? 1 : 1.25);
            card(b, sub(at, mul(ax, s2 * 0.5)), ax, side, s2, s2 * 0.8, 1, () => [0, 0, 0], rect, center, 0.75, aoOf, 0, 1, 0.25);
            card(b, sub(at, mul(side, s2 * 0.45)), side, tilt, s2 * 0.9, s2 * 0.75, 1, () => [0, 0, 0], rect, center, 0.75, aoOf, 0, 1, 0.25);
            if (lod === 0) card(b, sub(at, mul(tilt, s2 * 0.4)), tilt, ax, s2 * 0.8, s2 * 0.75, 1, () => [0, 0, 0], rect, center, 0.75, aoOf, 0, 1, 0.25);
          }
          continue;
        }
        const W = 0.6 * L + 0.5;
        const droop = P.droop * L * 0.35;
        const up = P.upturn * L * 0.3;
        const bend = (t: number): V3 => [0, -droop * t * t * 1.4 + up * Math.max(0, t - 0.6) * 2.5, 0];
        const fold = 0.42;
        const leftAcross: V3 = norm(add(mul(side, Math.cos(fold)), [0, Math.sin(fold), 0]));
        const rightAcross: V3 = norm(add(mul(side, -Math.cos(fold)), [0, Math.sin(fold), 0]));
        card(b, add(o, mul(leftAcross, W * 0.25)), dir, leftAcross, L, W * 0.5, 2, bend, rect, center, 0.6, aoOf, 0.5, 1);
        card(b, add(o, mul(rightAcross, W * 0.25)), dir, rightAcross, L, W * 0.5, 2, bend, rect, center, 0.6, aoOf, 0.5, 0);
      }
    }
  }
  // Leader.
  if (!P.pine) {
    for (let k = 0; k < 2; k++) {
      const a = k * (Math.PI / 2) + 0.3;
      card(b, trunkAt(H - 2.4), [0, 1, 0], [Math.cos(a), 0, Math.sin(a)], 2.8, 0.8, 1, () => [0, 0, 0], rect, center, 0.5, aoOf, 0, 1, 0.1);
    }
  }
  return b;
}

// ------------------------------------------------------------ broadleaves
export interface BroadleafParams {
  height: number;
  baseRadius: number;
  forkH: number;
  crownC: number; // crown centre height
  crownR: V3; // ellipsoid radii (x, y, z)
  limbs: number;
  limbAngle: [number, number]; // from vertical, rad
  clusters: number;
  clusterSize: [number, number];
  region: AtlasRegion;
  bark: AtlasRegion;
  leader: boolean;
  gnarl: number;
  /** Fraction of clusters gathered in lobes around branch ends, and the lobe radius (m). */
  lobes: number;
  lobeR: number;
}
export const BROADLEAF_PARAMS: readonly BroadleafParams[] = [
  // oak: low fork, wide spreading crown, gnarly limbs
  { height: 13.5, baseRadius: 0.28, forkH: 2.8, crownC: 8.2, crownR: [6.2, 4.6, 6.0], limbs: 5, limbAngle: [0.75, 1.15], clusters: 140, clusterSize: [2.0, 2.8], region: 'leaves', bark: 'barkBroad', leader: false, gnarl: 0.35, lobes: 0.7, lobeR: 1.9 },
  // beech: taller, ovoid crown
  { height: 16.5, baseRadius: 0.28, forkH: 4.2, crownC: 10.8, crownR: [4.6, 5.6, 4.6], limbs: 4, limbAngle: [0.4, 0.7], clusters: 130, clusterSize: [1.9, 2.6], region: 'leaves', bark: 'barkBroad', leader: false, gnarl: 0.15, lobes: 0.6, lobeR: 1.8 },
  // birch: slender leader, narrow drooping crown, white bark
  { height: 15, baseRadius: 0.22, forkH: 3.2, crownC: 9.8, crownR: [2.9, 5.0, 2.9], limbs: 6, limbAngle: [0.55, 0.95], clusters: 110, clusterSize: [1.5, 2.1], region: 'birchLeaves', bark: 'barkBirch', leader: true, gnarl: 0.08, lobes: 0.55, lobeR: 1.3 },
];

export function buildBroadleaf(variant: number, lod: 0 | 1): MeshBuilder {
  const P = BROADLEAF_PARAMS[variant]!;
  const r = rng(0xbeef + variant * 1231);
  const b = new MeshBuilder();
  b.swayH = P.height;
  const bark = atlasRect(P.bark);
  const rect = atlasRect(P.region);
  const C: V3 = [0, P.crownC, 0];
  const R = P.crownR;
  const ell = (p: V3): number => {
    const d = sub(p, C);
    return Math.sqrt((d[0] / R[0]) ** 2 + (d[1] / R[1]) ** 2 + (d[2] / R[2]) ** 2);
  };
  const aoOf = (p: V3): number => Math.max(0.22, Math.min(1, 0.25 + 0.75 * smooth(ell(p)) + 0.15 * ((p[1] - C[1]) / R[1])));
  // The random stream is consumed identically for both LODs (LOD1 = the same skeleton and crown,
  // coarser tubes, a subset of the clusters scaled up), so LOD0 ↔ LOD1 ↔ impostor match.
  const trunkTop = P.leader ? P.height * 0.95 : P.forkH;
  const nT = P.leader ? 8 : 5;
  const trunk: V3[] = [];
  const rad: number[] = [];
  const lean: V3 = [(r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6];
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    const y = -0.4 + (trunkTop + 0.4) * t;
    const g = P.gnarl * 0.25;
    trunk.push([lean[0] * t + (r() - 0.5) * g, y, lean[2] * t + (r() - 0.5) * g]);
    const flare = 1 + 0.6 * Math.max(0, 1 - (y + 0.4) / 1.1);
    rad.push(P.baseRadius * (P.leader ? 1 - 0.85 * t : 1 - 0.25 * t) * flare);
  }
  const coarse = <T,>(a: T[]): T[] => (lod === 0 ? a : a.filter((_, i) => i % 2 === 0 || i === a.length - 1));
  tube(b, coarse(trunk), coarse(rad), lod === 0 ? 8 : 5, bark, 0.5, 0.75, P.leader);
  const fork = trunk[trunk.length - 1]!;
  // Limbs from the fork (or spaced up the leader) to points on the inner crown shell.
  const ends: { p: V3; d: V3 }[] = [];
  const nL = P.limbs;
  let az = r() * Math.PI * 2;
  for (let k = 0; k < nL; k++) {
    az += (Math.PI * 2) / nL + (r() - 0.5) * 0.6;
    const ang = P.limbAngle[0] + (P.limbAngle[1] - P.limbAngle[0]) * r();
    const start: V3 = P.leader ? lerp3(trunk[0]!, trunk[trunk.length - 1]!, 0.3 + 0.6 * (k / Math.max(1, nL - 1))) : fork;
    const dir: V3 = norm([Math.sin(ang) * Math.cos(az), Math.cos(ang), Math.sin(ang) * Math.sin(az)]);
    // March to ~0.75 of the crown shell.
    let L = 1;
    while (L < 20 && ell(add(start, mul(dir, L))) < 0.72) L += 0.25;
    const lr = r();
    if (P.leader) L = Math.min(L, 2.6 + lr * 1.5);
    const segs = 4;
    const pts: V3[] = [start];
    const rr: number[] = [P.leader ? P.baseRadius * 0.35 : P.baseRadius * 0.62];
    let p = start;
    let d = dir;
    for (let s = 1; s <= segs; s++) {
      d = norm(add(d, [(r() - 0.5) * P.gnarl, (r() - 0.5) * P.gnarl * 0.5 + (P.leader ? -0.15 : 0), (r() - 0.5) * P.gnarl]));
      p = add(p, mul(d, L / segs));
      pts.push(p);
      rr.push(rr[0]! * (1 - (0.75 * s) / segs));
    }
    if (lod === 0 || k < 3) tube(b, coarse(pts), coarse(rr), lod === 0 ? 5 : 3, bark, 0.45, 0.65, false);
    ends.push({ p, d });
    // Sub-branches.
    for (let s = 0; s < 2; s++) {
      const at = pts[1 + Math.floor(r() * (pts.length - 2))]!;
      const sd = norm(add(d, [(r() - 0.5) * 1.6, 0.2 + r() * 0.3, (r() - 0.5) * 1.6]));
      let SL = 0.8;
      while (SL < 12 && ell(add(at, mul(sd, SL))) < 0.85) SL += 0.25;
      const e = add(at, mul(sd, SL));
      const mid = add(lerp3(at, e, 0.5), [(r() - 0.5) * 0.3, 0.1, (r() - 0.5) * 0.3]);
      if (lod === 0) tube(b, [at, mid, e], [rr[1]! * 0.55, rr[1]! * 0.32, rr[1]! * 0.1], 4, bark, 0.5, 0.7, false);
      ends.push({ p: e, d: sd });
    }
  }
  // Leaf clusters on the crown shell, attracted toward branch ends (LOD1: 3 of every 5, larger).
  const sizeK = lod === 0 ? 1 : 1.32;
  for (let k = 0; k < P.clusters; k++) {
    const u = r() * 2 - 1;
    const th = r() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    const rad = 0.3 + 0.7 * Math.cbrt(r());
    const shell: V3 = add(C, [R[0] * sq * Math.cos(th) * rad, R[1] * u * rad, R[2] * sq * Math.sin(th) * rad]);
    const lift = r();
    const e = ends[Math.floor(r() * ends.length)]!;
    // Billowy crown: some clusters gather in lobes around the branch ends (cloud-like clumps on the
    // silhouette), the rest fill the crown volume (no hollow core to see through).
    const lobe = r() < P.lobes;
    const lr = P.lobeR * (0.3 + 0.7 * Math.cbrt(r()));
    const rdir: V3 = [sq * Math.cos(th), u, sq * Math.sin(th)];
    let p: V3 = lobe ? add(lerp3(e.p, C, 0.22), mul(rdir, lr)) : lerp3(shell, e.p, 0.12);
    // Below the crown base: reflect upward (no pile-up layer at the base).
    const base = P.leader ? P.height * 0.3 : P.forkH + 1.0;
    if (p[1] < base) p[1] = base + (C[1] - base) * lift;
    const out = norm(sub(p, C));
    const tilt: V3 = norm(add(out, [(r() - 0.5) * 1.1, (P.leader ? -0.25 : 0.05) + (r() - 0.5) * 0.7, (r() - 0.5) * 1.1]));
    const s = (P.clusterSize[0] + (P.clusterSize[1] - P.clusterSize[0]) * r()) * sizeK;
    const a1 = perp(tilt);
    const rot = r() * Math.PI;
    if (lod === 1 && k % 5 >= 3) continue;
    // Three mutually orthogonal cards per cluster (a 3-D cross): some card always faces the viewer,
    // so crowns never show edge-on holes from below or above. LOD1 keeps two.
    const ax: V3 = norm(add(mul(a1, Math.cos(rot)), mul(cross(tilt, a1), Math.sin(rot))));
    const ay = norm(cross(tilt, ax));
    const droop = P.leader ? 0.35 : 0.1;
    const bend = (t: number): V3 => [0, -droop * s * t * t, 0];
    card(b, sub(p, mul(ax, s * 0.5)), ax, ay, s, s, 1, bend, rect, C, 0.82, aoOf, 0, 1, 0.3);
    card(b, sub(p, mul(ay, s * 0.45)), ay, tilt, s * 0.9, s * 0.9, 1, bend, rect, C, 0.82, aoOf, 0, 1, 0.3);
    if (lod === 0) card(b, sub(p, mul(tilt, s * 0.45)), tilt, ax, s * 0.9, s * 0.9, 1, bend, rect, C, 0.82, aoOf, 0, 1, 0.3);
  }
  return b;
}

// ------------------------------------------------------------ shrubs
export function buildShrub(variant: number): MeshBuilder {
  const r = rng(0x5ab + variant * 313);
  const b = new MeshBuilder();
  b.variant = variant;
  const C: V3 = [0, 0.5, 0];
  const aoOf = (p: V3): number => Math.max(0.3, Math.min(1, 0.35 + 0.6 * (p[1] / 1.2) + 0.25 * Math.sqrt(p[0] * p[0] + p[2] * p[2])));
  if (variant === 0) {
    b.swayH = 1.3;
    const rect = atlasRect('leaves');
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + r() * 0.5;
      const up = k < 6 ? 0.25 + r() * 0.35 : 0.85;
      const out: V3 = norm([Math.cos(a) * (1 - up), up, Math.sin(a) * (1 - up)]);
      const p: V3 = add([0, 0.55, 0], mul(out, 0.45 + r() * 0.15));
      const s = 0.95 + r() * 0.4;
      const ax = perp(out);
      const ay = norm(cross(out, ax));
      card(b, sub(sub(p, mul(ax, s * 0.5)), mul(ay, 0)), ax, ay, s, s, 1, () => [0, 0, 0], rect, C, 0.8, aoOf, 0, 1, 0.3);
      const bx = norm(add(ax, out));
      card(b, sub(p, mul(bx, s * 0.45)), bx, ay, s * 0.9, s * 0.9, 1, () => [0, 0, 0], rect, C, 0.8, aoOf, 0, 1, 0.3);
    }
  } else if (variant === 1) {
    b.swayH = 1.1;
    const rect = atlasRect('scrub');
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI + r() * 0.3;
      verticalCard(b, [(r() - 0.5) * 0.2, -0.05, (r() - 0.5) * 0.2], [Math.cos(a), 0, Math.sin(a)], 1.5 + r() * 0.3, 1.0 + r() * 0.25, rect, aoOf);
    }
  } else if (variant === 2) {
    b.swayH = 1.6;
    const rect = atlasRect('reeds');
    for (let c = 0; c < 2; c++) {
      const o: V3 = [(r() - 0.5) * 0.9, -0.05, (r() - 0.5) * 0.9];
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI + r();
        const across: V3 = [Math.cos(a), 0, Math.sin(a)];
        // Vertical card: u runs bottom → top in the reed texture (rotated region use: v across).
        verticalCard(b, o, across, 0.9 + r() * 0.3, 1.5 + r() * 0.4, rect, aoOf);
      }
    }
  } else {
    b.swayH = 0.9;
    const rect = atlasRect('fern');
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r() * 0.4;
      const dir: V3 = norm([Math.cos(a), 0.9, Math.sin(a)]);
      const side: V3 = norm(cross([0, 1, 0], dir));
      const L = 0.8 + r() * 0.35;
      fernFrond(b, [0, 0.02, 0], dir, side, L, rect, aoOf);
    }
  }
  return b;
}

/** Vertical card with the texture upright (region y down = card up). */
function verticalCard(b: MeshBuilder, o: V3, across: V3, w: number, h: number, rect: UvRect, aoOf: (p: V3) => number): void {
  const n = norm(cross(across, [0, 1, 0]));
  const rows = 2;
  let prev: number[] | null = null;
  for (let s = 0; s <= rows; s++) {
    const t = s / rows;
    const row: number[] = [];
    for (let k = 0; k <= 1; k++) {
      const p = add(o, add(mul(across, (k - 0.5) * w), [0, h * t, 0]));
      row.push(b.vert(p, norm(add(n, [0, 0.6, 0])), rect.u + rect.du * k, rect.v + rect.dv * t, 1, aoOf(p), t));
    }
    if (prev) b.quad(prev[0]!, prev[1]!, row[1]!, row[0]!);
    prev = row;
  }
}

/** Arched fern frond: texture v runs base → tip, u across. */
function fernFrond(b: MeshBuilder, o: V3, dir: V3, side: V3, L: number, rect: UvRect, aoOf: (p: V3) => number): void {
  const segs = 3;
  let prev: number[] | null = null;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const c: V3 = add(o, [dir[0] * L * t * 1.1, L * (0.75 * t - 0.65 * t * t), dir[2] * L * t * 1.1]);
    const row: number[] = [];
    for (let k = 0; k <= 1; k++) {
      const p = add(c, mul(side, (k - 0.5) * 0.42 * L));
      row.push(b.vert(p, [0, 1, 0], rect.u + rect.du * k, rect.v + rect.dv * t, 1, aoOf(p), t));
    }
    if (prev) b.quad(prev[0]!, prev[1]!, row[1]!, row[0]!);
    prev = row;
  }
}

/** All shrub variants merged (vvar = variant). */
export function buildShrubs(variants: number): MeshBuilder {
  const all = new MeshBuilder();
  for (let v = 0; v < variants; v++) all.append(buildShrub(v));
  return all;
}

// ------------------------------------------------------------ rocks
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  let acc = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1;
    const dy = (k >> 1) & 1;
    const dz = (k >> 2) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    acc += w * hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  }
  return acc;
}

/** Unit icosphere (subdivided), shared vertices. */
function icosphere(sub: number): { v: V3[]; f: [number, number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let v: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => norm(p as V3));
  let f: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let i = cache.get(k);
      if (i === undefined) {
        i = v.length;
        v.push(norm(lerp3(v[a]!, v[b]!, 0.5)));
        cache.set(k, i);
      }
      return i;
    };
    const nf: [number, number, number][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
    v = v.slice();
  }
  return { v, f };
}

/**
 * Rock of unit radius: displaced icosphere, flattened underside, faceted
 * by a few planar cuts. Normals from the displaced faces (smooth).
 */
export function buildRock(detail: number, seed = 7): MeshBuilder {
  const { v, f } = icosphere(detail);
  const b = new MeshBuilder();
  b.swayH = 1e9;
  const cuts: { n: V3; d: number }[] = [];
  const r = rng(seed);
  for (let k = 0; k < 8; k++) {
    const u = r() * 1.7 - 0.7;
    const th = r() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    cuts.push({ n: [sq * Math.cos(th), u, sq * Math.sin(th)], d: 0.6 + r() * 0.22 });
  }
  const P: V3[] = v.map((p) => {
    let rad = 1 + 0.16 * (vnoise3(p[0] * 1.6 + 3, p[1] * 1.6, p[2] * 1.6, seed) - 0.5) * 2 + 0.06 * (vnoise3(p[0] * 4.5, p[1] * 4.5, p[2] * 4.5, seed + 1) - 0.5) * 2;
    rad = Math.min(rad, 1.04);
    let q = mul(p, rad);
    for (const c of cuts) {
      const e = dot(q, c.n) - c.d;
      if (e > 0) q = sub(q, mul(c.n, e));
    }
    if (q[1] < -0.35) q[1] = -0.35 + (q[1] + 0.35) * 0.3;
    return [q[0] * 1.12, q[1] * 0.8, q[2] * 0.95];
  });
  // Smooth normals from faces.
  const N: V3[] = P.map(() => [0, 0, 0]);
  for (const [a, b2, c] of f) {
    const n = cross(sub(P[b2]!, P[a]!), sub(P[c]!, P[a]!));
    N[a] = add(N[a]!, n);
    N[b2] = add(N[b2]!, n);
    N[c] = add(N[c]!, n);
  }
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    const ao = Math.max(0.35, Math.min(1, 0.55 + 0.45 * (p[1] + 0.3)));
    b.vert(p, N[i]!, 0, 0, 0, ao, 0);
  }
  for (const [a, b2, c] of f) b.tri(a, b2, c);
  return b;
}
