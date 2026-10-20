/**
 * PICKUP visual definition (P6 F2): a full-size crew-cab pickup wrapping the
 * body-on-frame lattice of src/sim/vehicle/defs/pickup.ts (wheelbase 3.70,
 * track 1.72, 0.39 m all-terrain tyres; frame f0 (z −2.72) … f11 (z +3.00),
 * clip s0..s2, cab c0 (z −0.95) … c4 (z +0.98), bed b0 (z 1.10) … b3 (z
 * 2.92), hood_{r}{L,C,R}, tailgate tg_*, bumpers bf_* / br_* + hitch).
 *
 * PURE DATA, generated once at module load (deterministic), like the sedan's
 * def (copied and adapted, never imported). Masters:
 *   M1 cab side   sections along z from the front clip to the cab back:
 *                 rocker → lower crease → door face → shoulder crease →
 *                 fender top / belt → hood shut line → hood crown (power
 *                 dome) to the centre line. Doors, fenders, hood and the
 *                 cab corners are cut from it, so every shut line is
 *                 continuous.
 *   M2 nose       a ribbon from M1's front section round the corner to the
 *                 centre: the upright truck face (headlamps, the big grille).
 *   M4 greenhouse belt → glass → roof rail → roof crown, windscreen base to
 *                 the cab back.
 *   M5 bed        sections along z: bed-side skirt → side face (shoulder
 *                 crease continued from the cab) → rail cap → inner wall →
 *                 corrugated floor to the centre line. Bed side, rail caps,
 *                 inner walls and floor are cut from it.
 * Explicit parts: chrome bumpers (+ hitch receiver, step pads, fogs), fender
 * flares, tailgate, cab back panel, running boards, towing mirrors,
 * interior, frame rails / axle / tank / spare underneath.
 *
 * Binding: each panel binds only to the rig nodes that carry it (front clip
 * parts → s*; cab skin → c*; bed → b*; tailgate → tg_*; bumpers → bf_* /
 * br_*; hood → hood_*), so a torn cab or bed mount separates panels instead
 * of stretching one.
 */
import {
  boundsWhere,
  createLoft,
  createSheet,
  cutPanel,
  flipMesh,
  frontCut,
  gridLoftMesh,
  loftSurface,
  mergeMeshes,
  mirrorMesh,
  orientMesh,
  paramAt,
  polyShape,
  rotX,
  roundedBoxMesh,
  sideCut,
  smooth2,
  stripMesh,
  surfacePatch,
  toMeshSurface,
  transformMesh,
  topCut,
  uAbove,
  uAtMetric,
  uBelow,
  vAbove,
  vBelow,
  type Cut,
  type EdgeStyle,
  type P2,
  type PanelMesh,
  type Shape2,
  type Sheet,
  type V3,
} from '../loft';
import type { BeamSelector, DetachSpec, GlassSpec, MaterialSlot, PanelDef, PanelKind, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { once, setVisualExtras } from '../lods';

// ====================================================================== rig-matched dimensions
/** Asserted against compileVehicle(PICKUP) by pickup.test.ts. */
export const PICKUP_DIMS = {
  axleFrontZ: -1.85,
  axleRearZ: 1.85,
  halfTrack: 0.86,
  hubY: 0.39,
  tyreRadius: 0.39,
  /** Wheel-arch opening radius (lip): long travel, a truck's tall arch gap. */
  archRadius: 0.47,
  archLift: 0.03,
} as const;

const ZF = PICKUP_DIMS.axleFrontZ;
const ZR = PICKUP_DIMS.axleRearZ;
const ARCH_Y = PICKUP_DIMS.hubY + PICKUP_DIMS.archLift;
const ARCH_R = PICKUP_DIMS.archRadius;

// ====================================================================== interpolation
type Keys = readonly (readonly [number, number])[];
/** Monotone cubic (Fritsch–Carlson) through keys; flat outside. */
function pchip(keys: Keys): (x: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    d.push((ys[i + 1]! - ys[i]!) / h[i]!);
  }
  const m: number[] = new Array<number>(n).fill(0);
  if (n === 2) m[0] = m[1] = d[0]!;
  else {
    for (let i = 1; i + 1 < n; i++) {
      if (d[i - 1]! * d[i]! <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i]! + h[i - 1]!;
        const w2 = h[i]! + 2 * h[i - 1]!;
        m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!);
      }
    }
    const end = (h0: number, h1: number, d0: number, d1: number): number => {
      let e = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(e) !== Math.sign(d0)) e = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(e) > Math.abs(3 * d0)) e = 3 * d0;
      return e;
    };
    m[0] = end(h[0]!, h[1]!, d[0]!, d[1]!);
    m[n - 1] = end(h[n - 2]!, h[n - 3]!, d[n - 2]!, d[n - 3]!);
  }
  return (x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i + 2 < n && x > xs[i + 1]!) i++;
    const t = (x - xs[i]!) / h[i]!;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h[i]! * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h[i]! * m[i + 1]!;
  };
}
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ====================================================================== cab / front body lines (rest pose)
/** M1 runs from the front clip's face corner to the cab back. */
const M1_FRONT = -2.735;
const M1_REAR = 0.975;
const L = {
  /** Rocker / fender underside edge. */
  yBot: pchip([
    [-2.74, 0.64],
    [-2.3, 0.63],
    [-1.25, 0.62],
    [-0.98, 0.575],
    [-0.9, 0.56],
    [0.9, 0.56],
    [0.975, 0.57],
  ]),
  /** Lower crease height above yBot. */
  skirt: pchip([
    [-2.74, 0.07],
    [-0.95, 0.08],
    [0.975, 0.08],
  ]),
  /** Body-side half width (plan). */
  xSide: pchip([
    [-2.74, 0.958],
    [-2.66, 0.982],
    [-2.5, 0.993],
    [-1.85, 0.998],
    [-1.0, 0.996],
    [0.0, 0.994],
    [0.8, 0.992],
    [0.9, 0.988],
    [0.94, 0.979],
    [0.96, 0.966],
    [0.975, 0.95],
  ]),
  /** Shoulder (character) crease — continues straight along the bed. */
  ySh: pchip([
    [-2.74, 1.04],
    [-1.0, 1.065],
    [0.975, 1.075],
  ]),
  /** Fender top corner / belt. */
  yTop: pchip([
    [-2.74, 1.225],
    [-2.4, 1.245],
    [-1.8, 1.268],
    [-1.25, 1.29],
    [-1.06, 1.3],
    [-0.94, 1.318],
    [-0.86, 1.328],
    [0.975, 1.33],
  ]),
  xTop: pchip([
    [-2.74, 0.905],
    [-2.6, 0.93],
    [-1.5, 0.94],
    [-0.94, 0.94],
    [-0.86, 0.95],
    [0.975, 0.95],
  ]),
  /** Hood / cowl shut-line half width. */
  xHood: pchip([
    [-2.74, 0.78],
    [-2.5, 0.8],
    [-1.06, 0.81],
    [-0.9, 0.82],
    [0.975, 0.82],
  ]),
  /** Height at the hood shut line; the hood rides ≈ 2 cm over the hood nodes (y 1.18 / 1.22 / 1.26 / 1.29 at z −2.52 / −2.0 / −1.5 / −1.08). */
  yHood: pchip([
    [-2.74, 1.232],
    [-2.52, 1.252],
    [-2.0, 1.278],
    [-1.5, 1.298],
    [-1.08, 1.31],
    [-0.98, 1.312],
    [-0.88, 1.322],
    [0.975, 1.33],
  ]),
  /** Hood power-dome lift (0..1): the raised centre section of the hood. */
  dome: pchip([
    [-2.74, 1],
    [-1.12, 1],
    [-1.0, 0],
    [0.975, 0],
  ]),
  crown: pchip([
    [-2.74, 0.02],
    [-1.0, 0.02],
    [0.975, 0.01],
  ]),
};
const DOME_X = 0.42;
const DOME_W = 0.035;
const domeLift = (z: number): number => 0.03 * L.dome(z);

/** M1 top surface height (hood / cowl) at (x, z). */
function topY(x: number, z: number): number {
  const xh = L.xHood(z);
  const t = Math.min(1, Math.abs(x) / xh);
  return L.yHood(z) + L.crown(z) * (1 - t * t);
}
function m1Top(x: number, z: number): number {
  return topY(x, z) + domeLift(z) * (1 - smoothstep(DOME_X - DOME_W, DOME_X, Math.abs(x)));
}

const K = { skirt: 2, shoulder: 6, top: 9, hood: 10 } as const;
const M1_STATIONS = [
  -2.735, -2.72, -2.69, -2.64, -2.56, -2.44, -2.3, -2.15, -2.0, -1.85, -1.7, -1.55, -1.4, -1.25, -1.12, -1.04, -0.97, -0.92, -0.85, -0.7, -0.45, -0.2, 0.05, 0.3, 0.55, 0.75,
  0.88, 0.93, 0.955, 0.975,
];

function m1Section(z: number): V3[] {
  const xs = L.xSide(z);
  const yb = L.yBot(z);
  const ysk = yb + L.skirt(z);
  const ysh = L.ySh(z);
  const yt = L.yTop(z);
  // A pickup's flanks are slab-sided: almost no tumblehome, a crisp shoulder with a small shelf above it.
  const pts: [number, number][] = [
    [xs - 0.07, yb - 0.004],
    [xs - 0.02, yb + 0.008],
    [xs - 0.002, ysk],
    [xs + 0.004, lerp(ysk, ysh, 0.35)],
    [xs + 0.008, lerp(ysk, ysh, 0.75)],
    [xs + 0.016, ysh - 0.02],
    [xs + 0.018, ysh],
    [xs + 0.0, ysh + 0.012],
    [xs - 0.01, lerp(ysh, yt, 0.6)],
    [L.xTop(z), yt],
    [L.xHood(z), L.yHood(z)],
    [DOME_X, topY(DOME_X, z)],
    [DOME_X - DOME_W, topY(DOME_X - DOME_W, z) + domeLift(z)],
    [0, L.yHood(z) + L.crown(z) + domeLift(z)],
  ];
  return pts.map(([x, y]) => [x, y, z] as V3);
}

/** Arch flares (sheet metal under the black flare mouldings): small ring lift just outside each arch. */
function flare(p: V3): void {
  const ax = Math.abs(p[0]);
  if (ax < 0.8 || p[2] > 1.0) return;
  const hf = smoothstep(0.86, 0.95, ax);
  const vf = 1 - smoothstep(L.ySh(p[2]) - 0.06, L.ySh(p[2]) - 0.01, p[1]);
  if (hf * vf <= 0) return;
  const d = Math.hypot(p[2] - ZF, p[1] - ARCH_Y);
  p[0] += Math.sign(p[0]) * 0.012 * (1 - smoothstep(ARCH_R + 0.02, ARCH_R + 0.16, d)) * hf * vf;
}

// ====================================================================== greenhouse (M4)
const M4_FIRST = -0.98;
const M4_LAST = 0.975;
const M4_STATIONS = [-0.98, -0.93, -0.86, -0.77, -0.67, -0.57, -0.47, -0.39, -0.3, -0.15, 0.05, 0.25, 0.45, 0.62, 0.76, 0.86, 0.92, 0.95, 0.975];
const GH = {
  /** DLO top: A-pillar line then the roof rail, squared off at the cab back. */
  yGlass: pchip([
    [-0.98, 1.335],
    [-0.86, 1.43],
    [-0.7, 1.56],
    [-0.55, 1.68],
    [-0.42, 1.775],
    [-0.3, 1.8],
    [0.6, 1.805],
    [0.975, 1.8],
  ]),
  /** Centre line: windscreen base → header → roof → cab back. */
  yCentre: pchip([
    [-1.02, 1.322],
    [-0.75, 1.55],
    [-0.5, 1.77],
    [-0.38, 1.88],
    [-0.28, 1.915],
    [-0.1, 1.932],
    [0.3, 1.936],
    [0.7, 1.93],
    [0.975, 1.915],
  ]),
  tumble: 0.17,
};
const HEADER_Z = -0.385;
/** B-pillar (black, between the doors) and the rear door's rear frame. */
const B_FRONT = 0.07;
const B_REAR = 0.17;
const DLO_TAIL = 0.9;

function m4Section(z: number): V3[] {
  const xb = L.xTop(z) - 0.003;
  const yb = L.yTop(z) - 0.004;
  const yg = Math.max(yb + 0.0015, GH.yGlass(z));
  const h = yg - yb;
  const xg = xb - GH.tumble * h;
  const p1: [number, number] = [xb - GH.tumble * 0.2 * h - 0.003, yb + 0.2 * h];
  const p2: [number, number] = [xb - GH.tumble * 0.6 * h - 0.005, yb + 0.6 * h];
  const p3: [number, number] = [xg, yg];
  const yc = GH.yCentre(z);
  // Roof edge (drip rail) just above the DLO top; across the windscreen it follows the centre line's drop.
  const tr = smoothstep(-0.55, -0.32, z);
  const x5 = lerp(xg - 0.05, xg - 0.075, tr);
  const y5 = Math.min(lerp(yg + 0.03, yc - 0.045, 1 - tr) * (1 - tr) + (yg + 0.055) * tr, yc - 0.004);
  const p4: [number, number] = [lerp(xg, x5, 0.45) + 0.006, lerp(yg, y5, 0.55) + 0.004];
  const pts: [number, number][] = [[xb, yb], p1, p2, p3, p4, [x5, y5], [x5 * 0.5, lerp(yc, y5, 0.22)], [0, yc]];
  return pts.map(([x, y]) => [x, y, z] as V3);
}

// ====================================================================== bed (M5)
const BED_FRONT = 1.035;
const BED_REAR = 2.995;
const BED_STATIONS = [1.035, 1.05, 1.08, 1.15, 1.3, 1.45, 1.6, 1.75, 1.85, 1.95, 2.1, 2.25, 2.4, 2.55, 2.7, 2.82, 2.9, 2.95, 2.975, 2.995];
const BED = {
  xOut: pchip([
    [1.035, 0.975],
    [1.05, 0.99],
    [1.1, 0.998],
    [2.8, 0.998],
    [2.995, 0.996],
  ]),
  yBot: pchip([
    [1.035, 0.6],
    [2.6, 0.6],
    [2.995, 0.62],
  ]),
  yRail: 1.37,
  xIn: 0.855,
  yFloor: 0.952,
};
/** Bed corrugation: ribs along z across the floor (rest-space displacement, inner floor only). */
function bedRibs(p: V3): void {
  const ax = Math.abs(p[0]);
  if (ax > 0.78 || p[1] > 1.0 || p[1] < 0.9 || p[2] < 1.12 || p[2] > 2.94) return;
  const ph = (ax / 0.17) * Math.PI * 2;
  p[1] += 0.009 * (0.5 + 0.5 * Math.cos(ph)) * smoothstep(0.78, 0.72, ax) * smoothstep(1.12, 1.18, p[2]) * smoothstep(2.94, 2.88, p[2]);
}
function m5Section(z: number): V3[] {
  const xo = BED.xOut(z);
  const yb = BED.yBot(z);
  const ysh = L.ySh(Math.min(z, M1_REAR));
  const yr = BED.yRail;
  const pts: [number, number][] = [
    [xo - 0.06, yb - 0.004],
    [xo - 0.015, yb + 0.008],
    [xo, yb + 0.06],
    [xo + 0.006, lerp(yb + 0.06, ysh, 0.5)],
    [xo + 0.011, ysh - 0.02],
    [xo + 0.012, ysh],
    [xo, ysh + 0.014],
    [xo - 0.006, lerp(ysh, yr, 0.6)],
    [xo - 0.012, yr - 0.02],
    [xo - 0.035, yr],
    [BED.xIn + 0.03, yr + 0.004],
    [BED.xIn + 0.004, yr - 0.025],
    [BED.xIn, lerp(yr, BED.yFloor, 0.5)],
    [BED.xIn - 0.004, BED.yFloor + 0.03],
    [BED.xIn - 0.04, BED.yFloor],
    [0.42, BED.yFloor],
    [0, BED.yFloor],
  ];
  // Front end: the side rounds into the front wall (a 4 cm corner).
  const wf = 1 - smoothstep(BED_FRONT, 1.1, z);
  return pts.map(([x, y], k) => [k <= 9 ? x - 0.03 * wf * wf : x, y, z] as V3);
}
const KB = { skirt: 2, shoulder: 5, railOut: 9, railIn: 11, wallLow: 13, floor: 14 } as const;

// ====================================================================== ribbons (M2 nose)
/** Front bumper straps (sim PICKUP_DESIGN.bumperStraps; pickup.test.ts checks they match). */
export const PICKUP_BUMPER_STRAPS: readonly (readonly [string, string])[] = [
  ['bf_bl_L', 'f3_lo_L'],
  ['bf_bu_L', 'f3_hi_L'],
  ['bf_bl_R', 'f3_lo_R'],
  ['bf_bu_R', 'f3_hi_R'],
];

/**
 * Brute's grille emblem: a flat-topped hex-nut prism facing forward (-z), with a chamfered front edge so
 * the chrome catches a highlight ring. `c` is the centre of the back face; R the corner radius.
 */
function hexNutMesh(c: V3, R: number, depth: number, chamfer: number): PanelMesh {
  const out: PanelMesh = { position: [], normal: [], uv: [], tangent: [], index: [] };
  const quad = (p: readonly V3[], n: V3): void => {
    const base = out.position.length / 3;
    const t = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!) || 1;
    for (let k = 0; k < p.length; k++) {
      out.position.push(p[k]![0], p[k]![1], p[k]![2]);
      out.normal.push(n[0], n[1], n[2]);
      out.tangent.push(t[0]! / tl, t[1]! / tl, t[2]! / tl, 1);
      out.uv.push(p[k]![0] - c[0], p[k]![1] - c[1]);
    }
    for (let k = 1; k + 1 < p.length; k++) out.index.push(base, base + k, base + k + 1);
  };
  const corner = (r: number, i: number, z: number): V3 => [c[0] + r * Math.cos((i * Math.PI) / 3), c[1] + r * Math.sin((i * Math.PI) / 3), z];
  const zBack = c[2];
  const zEdge = c[2] - depth + chamfer;
  const zFront = c[2] - depth;
  const ri = R - chamfer;
  // Front face (fan, wound to face -z).
  quad([0, 5, 4, 3, 2, 1].map((i) => corner(ri, i, zFront)), [0, 0, -1]);
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const mid = ((i + 0.5) * Math.PI) / 3;
    const nx = Math.cos(mid);
    const ny = Math.sin(mid);
    // Chamfer (45°) and the flank back to the grille.
    quad([corner(ri, i, zFront), corner(ri, j, zFront), corner(R, j, zEdge), corner(R, i, zEdge)], [nx * Math.SQRT1_2, ny * Math.SQRT1_2, -Math.SQRT1_2]);
    quad([corner(R, i, zEdge), corner(R, j, zEdge), corner(R, j, zBack), corner(R, i, zBack)], [nx, ny, 0]);
  }
  return out;
}

function sampleCurve(poly: readonly P2[], ts: readonly number[], outward: (dx: number, dz: number) => P2): { p: P2; n: P2 }[] {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  return ts.map((t) => {
    const s = t * total;
    let i = 1;
    while (i < poly.length - 1 && cum[i]! < s) i++;
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const f = (s - cum[i - 1]!) / Math.max(1e-9, cum[i]! - cum[i - 1]!);
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return { p: [a[0] + dx * f, a[1] + dz * f] as P2, n: outward(dx / l, dz / l) };
  });
}
interface RibbonSpec {
  plan: P2[];
  outward: (dx: number, dz: number) => P2;
  profile: readonly (readonly [number, number])[];
  sections: number;
  x0: number;
}
function ribbonSections(spec: RibbonSpec, endCp: readonly V3[], endCurve: (f: number) => V3): V3[][] {
  const J = spec.sections;
  const samples = sampleCurve(
    spec.plan,
    Array.from({ length: J }, (_, j) => (j / (J - 1)) ** 1.1),
    spec.outward,
  );
  return samples.map((smp, j) => {
    if (j === 0) return endCp.map((p) => [p[0], p[1], p[2]] as V3);
    const f = j / (J - 1);
    const blend = smoothstep(0, 0.22, f);
    const sec: V3[] = [];
    for (let k = 0; k < spec.profile.length; k++) {
      const [y, r] = spec.profile[k]!;
      const side = endCp[k]!;
      const rs = side[0] - spec.x0;
      const ro = lerp(rs, r, blend);
      sec.push([smp.p[0] + smp.n[0] * ro, lerp(side[1], y, blend), smp.p[1] + smp.n[1] * ro]);
    }
    sec.push(endCurve(f));
    if (j === J - 1) for (const p of sec) p[0] = 0;
    return sec;
  });
}

// ====================================================================== glass beams (rig ids)
/**
 * Glass-class beams of the pickup rig (src/sim/vehicle/defs/pickup.ts: cw / ap ↔ rf across c0 → c1,
 * bt ↔ rf across consecutive cab stations, bt ↔ rf in the c4 back wall); selectors resolve against
 * compileVehicle(PICKUP) (pickup.test.ts).
 */
const GLASS_BEAMS = {
  windscreen: [
    ['c0_cw', 'c1_rf'],
    ['c0_cw', 'c1_rf_L'],
    ['c0_cw', 'c1_rf_R'],
    ['c0_ap_L', 'c1_rf'],
    ['c0_ap_R', 'c1_rf'],
  ],
  back: [
    ['c4_bt_R', 'c4_rf'],
    ['c4_bt_L', 'c4_rf'],
  ],
  side: (a: number, s: 'L' | 'R') => [
    [`c${a}_bt_${s}`, `c${a + 1}_rf_${s}`],
    [`c${a}_rf_${s}`, `c${a + 1}_bt_${s}`],
  ],
} as const;
const pairs = (p: readonly (readonly string[])[]): BeamSelector => ({ pairs: p.map((q) => [q[0]!, q[1]!] as const) });
const sideBind = (ids: readonly string[], s: 'L' | 'R'): string[] => ids.map((id) => id.replace(/\$/g, s));

/** Panels a LOD2 pickup leaves out (seals, handles, small cabin / underbody parts). */
const LOD2_DROP = /Seal[LR]?$|^handle|^steering$|^console$|^mirrorGlass|^plateFrame$|^wipers$|^towHooks$|^spare$|^exhaust$|^bedTieDowns$|^badges$|^badgeFace$|^hoodVents$|Badge[LR]?$/;

export interface PickupBuildOptions {
  /** 0 = full detail, 1 ≈ 40 % of the triangles (LOD1 ≥ 25 m), 2 ≈ 20 % (LOD2 ≥ 80 m, far shadows). */
  lod: 0 | 1 | 2;
}

/** Oxford White (palettes[0] of src/game/vehicles/pickup.ts must equal it). */
export const PICKUP_PAINT = { color: 0xe6e6e1, metallic: 0, roughness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.06, flake: null } as const;

export function buildPickupVisual(opts: PickupBuildOptions = { lod: 0 }): VehicleVisualDef {
  const rs = opts.lod === 0 ? 1 : opts.lod === 1 ? 2.9 : 5.2;
  const SB = opts.lod === 0 ? 2 : 1;
  const SS = 1;
  const panels: PanelDef[] = [];
  const add = (
    id: string,
    kind: PanelKind,
    material: MaterialSlot,
    mesh: PanelMesh,
    bind: readonly string[],
    extra: Partial<Pick<PanelDef, 'detach' | 'glass' | 'lights' | 'damageWeight' | 'castShadow'>> = {},
  ): void => {
    if (mesh.index.length === 0) throw new Error(`pickup visual: panel ${id} is empty`);
    panels.push({ id, kind, material, surface: toMeshSurface(mesh), bind, detach: null, ...extra });
  };
  const SIDES = ['R', 'L'] as const;
  const perSide = (m: PanelMesh, s: 'L' | 'R'): PanelMesh => (s === 'R' ? m : mirrorMesh(m));

  // ---------------------------------------------------------------- masters
  const m1Loft = createLoft(M1_STATIONS.map(m1Section), { symmetric: true });
  const S1 = createSheet(loftSurface(m1Loft, { displace: flare }), { resolution: 0.09 * rs, maxAngleDeg: 14 * rs });
  const u1 = (k: number): number => m1Loft.uKnots[k]!;
  const m4Loft = createLoft(M4_STATIONS.map(m4Section), { symmetric: true });
  const S4 = createSheet(loftSurface(m4Loft), { resolution: 0.1 * rs, maxAngleDeg: 13 * rs });
  const u4 = (k: number): number => m4Loft.uKnots[k]!;
  const S4lo = createSheet(loftSurface(m4Loft), { resolution: 0.25 * rs, maxAngleDeg: 28 * rs });
  const m5Loft = createLoft(BED_STATIONS.map(m5Section), { symmetric: true });
  const S5 = createSheet(loftSurface(m5Loft, { displace: bedRibs }), { resolution: 0.09 * rs, maxAngleDeg: 14 * rs });
  const u5 = (k: number): number => m5Loft.uKnots[k]!;
  /** Finer sampling of M5 for small cut parts (fuel door, lamp wrap): same surface, so cut lines match. */
  const S5f = opts.lod === 0 ? S5 : createSheet(loftSurface(m5Loft, { displace: bedRibs }), { resolution: 0.09, maxAngleDeg: 14 });
  const m1At = (u: number, v: number): V3 => S1.surface.point(u, v, [0, 0, 0]);
  const noseX0 = m1At(u1(4), 0)[0];

  // Nose: the upright truck face. Plan: the fender front corner rolls round to a flat face at z ≈ −2.80.
  const NOSE_PLAN = smooth2(
    [
      [noseX0, -2.735],
      [noseX0 - 0.006, -2.77],
      [noseX0 - 0.03, -2.795],
      [noseX0 - 0.08, -2.808],
      [0.6, -2.818],
      [0.3, -2.826],
      [0, -2.828],
    ],
    10,
  );
  const NOSE_OUT = (dx: number, dz: number): P2 => [-dz, dx];
  const noseSecs = ribbonSections(
    {
      plan: NOSE_PLAN,
      outward: NOSE_OUT,
      // (height, outward offset) for CP0..K.hood: an upright face that leans back 2 cm at the top.
      profile: [
        [0.62, -0.06],
        [0.635, -0.015],
        [0.7, 0.0],
        [0.8, 0.0],
        [0.92, 0.0],
        [1.02, -0.002],
        [1.08, -0.005],
        [1.13, -0.009],
        [1.18, -0.016],
        [1.218, -0.032],
      ],
      sections: 13,
      x0: noseX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 0)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 0),
  );
  const m2Loft = createLoft(noseSecs, { symmetric: true });
  const S2 = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.08 * rs, maxAngleDeg: 12 * rs });
  const S2f = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.045 * Math.sqrt(rs), maxAngleDeg: 10 * Math.sqrt(rs) });

  // ---------------------------------------------------------------- cut helpers
  const lip: EdgeStyle = { inset: 0.002, roll: 0.003, wall: 0.025, segments: 1, seal: false };
  const lens: EdgeStyle = { inset: VISUAL_DEFAULTS.shutGap / 2 + 0.0015, roll: 0.0015, wall: 0.005, segments: 1, seal: false };
  interface CutOpts {
    corner?: number;
    offset?: number;
    thickness?: number;
    where?: (p: V3) => boolean;
    border?: EdgeStyle | 'seam' | 'shut' | 'hem' | 'lip' | 'arch';
    mirror?: boolean;
  }
  const cut = (sheet: Sheet, cuts: Cut[], o: CutOpts = {}) =>
    cutPanel({
      sheet,
      cuts,
      corner: o.corner ?? 0.015,
      offset: o.offset,
      thickness: o.thickness,
      bounds: o.where ? (boundsWhere(sheet, o.where) ?? undefined) : undefined,
      border: o.border ?? lip,
      mirrorX: o.mirror,
    });
  const cutC = (sheet: Sheet, cuts: Cut[], o: CutOpts = {}) => cut(sheet, cuts, { ...o, mirror: true });
  const neg = (s: Shape2): Shape2 => ({ sd: (a, b) => -s.sd(a, b) });
  const vline = (pts: P2[], keep: 'front' | 'rear', edge: Cut['edge'] = 'shut'): Cut => {
    const sh = polyShape(smooth2(pts, 8), false);
    return sideCut(keep === 'front' ? sh : neg(sh), edge);
  };
  const planLine = (pts: P2[], keep: 'front' | 'rear', edge: Cut['edge'] = 'shut'): Cut => {
    const sh = polyShape(smooth2(pts, 8), false);
    return topCut(keep === 'rear' ? sh : neg(sh), edge);
  };
  const uAboveBy = (sheet: Sheet, u0: number, m: number, edge: Cut['edge']): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u, v) - sheet.metricU(u0, v)) * sheet.skew(u, v) - m, edge });
  const uBelowBy = (sheet: Sheet, u1v: number, m: number, edge: Cut['edge']): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u1v, v) - sheet.metricU(u, v)) * sheet.skew(u, v) + m, edge });
  const vAtZ = (sheet: Sheet, u: number, z0: number): number => {
    let lo = 0;
    let hi = 1;
    const q: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      sheet.surface.point(u, mid, q);
      if (q[2] < z0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const zAbove = (z0: number, edge: Cut['edge'] = 'shut'): Cut => sideCut({ sd: (z) => z - z0 }, edge);
  const zBelow = (z1: number, edge: Cut['edge'] = 'shut'): Cut => sideCut({ sd: (z) => z1 - z }, edge);
  const outsideCircle = (zc: number, yc: number, r: number, edge: Cut['edge'] = 'arch'): Cut => sideCut({ sd: (z, y) => Math.hypot(z - zc, y - yc) - r }, edge);
  const fv = (sd: (x: number, y: number) => number): Shape2 => ({ sd: (x, y) => sd(Math.abs(x), y) });
  const rmin = (r: number, ...a: number[]): number => {
    let g = a[0]!;
    for (let k = 1; k < a.length; k++) {
      const b = a[k]!;
      g = b < r && g < r ? r - Math.hypot(r - b, r - g) : Math.min(b, g);
    }
    return g;
  };

  // ---------------------------------------------------------------- side-view lines (cab)
  const FENDER_LINE: P2[] = [
    [-0.975, 0.3],
    [-0.972, 0.9],
    [-0.968, 1.4],
  ];
  const B_LINE: P2[] = [
    [0.104, 0.3],
    [0.11, 0.9],
    [0.118, 1.4],
  ];
  const REAR_DOOR_LINE: P2[] = [
    [0.925, 0.3],
    [0.925, 0.9],
    [0.925, 1.4],
  ];
  const archF = () => outsideCircle(ZF, ARCH_Y, ARCH_R);
  const HOOD_REAR: P2[] = [
    [0, -1.075],
    [0.4, -1.07],
    [0.8, -1.06],
    [1.2, -1.05],
  ];
  const WS_BASE: P2[] = [
    [0, -1.0],
    [0.4, -0.99],
    [0.8, -0.965],
    [1.2, -0.95],
  ];

  // ---------------------------------------------------------------- bind sets (rig ids)
  const hoodBind = ['hood_*'];
  const clipBind = (s: 'L' | 'R') => sideBind(['s0_fd_$', 's0_rh_$', 's0_rl_$', 's1_*_$', 's2_*_$'], s);
  const doorFBind = (s: 'L' | 'R') => sideBind(['c0_hp_$', 'c0_sl_$', 'c0_ap_$', 'c1_sl_$', 'c1_dm_$', 'c1_bt_$', 'c2_sl_$', 'c2_dm_$', 'c2_bt_$'], s);
  const doorRBind = (s: 'L' | 'R') => sideBind(['c2_sl_$', 'c2_dm_$', 'c2_bt_$', 'c3_sl_$', 'c3_dm_$', 'c3_bt_$', 'c4_sl_$', 'c4_qm_$', 'c4_bt_$'], s);
  const cabBackBind = ['c4_*'];
  const roofBind = ['c0_ap_*', 'c0_cw', 'c1_rf*', 'c1_bt_*', 'c2_rf*', 'c2_bt_*', 'c3_rf*', 'c3_bt_*', 'c4_rf*', 'c4_bt_*'];
  const bedSideBind = (s: 'L' | 'R') => sideBind(['b0_bo_$', 'b0_rl_$', 'b0_fl_$', 'b1_bo_$', 'b1_rl_$', 'b1_fl_$', 'b2_bo_$', 'b2_rl_$', 'b2_fl_$', 'b3_bo_$', 'b3_rl_$', 'b3_fl_$'], s);
  const bedFloorBind = ['b0_fc', 'b0_fl_*', 'b0_cx', 'b1_fc', 'b1_fl_*', 'b1_cx', 'b2_fc', 'b2_fl_*', 'b2_cx', 'b3_fc', 'b3_fl_*', 'b3_cx'];
  const bumperFBind = ['bf_*'];
  const bumperRBind = ['br_*', 'hitch'];
  const tgBind = ['tg_*'];
  const follow = (attach: DetachSpec['attach'], f = 1): DetachSpec => ({ attach, minBrokenFraction: f, mode: 'follow' });

  // ---------------------------------------------------------------- M1: hood, cowl, fenders, doors, rockers, cab corners
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), vAbove(S1, 0), planLine(HOOD_REAR, 'front')], { thickness: 0.02, where: (p) => p[2] < -0.95 && p[1] > 1.05 });
    add('hood', 'hood', 'paint', m.mesh, hoodBind, { detach: follow('boundary', 0.85) });
    add('hoodSeal', 'trim', 'rubber', m.seal, hoodBind, { damageWeight: 0, castShadow: false });
  }
  {
    const m = cutC(S1, [uAbove(S1, u1(K.top) + 0.004, 'seam'), planLine(HOOD_REAR, 'rear'), planLine(WS_BASE, 'front', 'seam')], {
      where: (p) => p[2] > -1.15 && p[2] < -0.9 && p[1] > 1.2,
      border: 'seam',
    });
    add('cowl', 'trim', 'trim', m.mesh, ['c0_ap_*', 'c0_cw', 'c0_fw_*', 'c0_hp_*'], { damageWeight: 0.6 });
  }
  for (const s of SIDES) {
    {
      const m = cut(S1, [uBelow(S1, u1(K.hood)), vAbove(S1, 0), vline(FENDER_LINE, 'front'), archF()], { where: (p) => p[2] < -0.85 });
      add(`fender${s}`, 'fender', 'paint', perSide(m.mesh, s), clipBind(s));
    }
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(FENDER_LINE, 'rear'), vline(B_LINE, 'front')], { where: (p) => p[2] > -1.05 && p[2] < 0.2 && p[1] < 1.4 });
      add(`door${s}F`, 'door', 'paint', perSide(m.mesh, s), doorFBind(s));
      add(`door${s}FSeal`, 'trim', 'rubber', perSide(m.seal, s), doorFBind(s), { damageWeight: 0, castShadow: false });
    }
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(B_LINE, 'rear'), vline(REAR_DOOR_LINE, 'front')], { where: (p) => p[2] > 0 && p[2] < 0.95 && p[1] < 1.4 });
      add(`door${s}R`, 'door', 'paint', perSide(m.mesh, s), doorRBind(s));
      add(`door${s}RSeal`, 'trim', 'rubber', perSide(m.seal, s), doorRBind(s), { damageWeight: 0, castShadow: false });
    }
    {
      const m = cut(S1, [uBelow(S1, u1(K.skirt)), vline(FENDER_LINE, 'rear')], { where: (p) => p[2] > -1.05 && p[1] < 0.75 });
      add(`rocker${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['c0_sl_$', 'c0_fl_$', 'c1_sl_$', 'c1_fl_$', 'c2_sl_$', 'c2_fl_$', 'c3_sl_$', 'c3_fl_$', 'c4_sl_$', 'c4_fl_$'], s));
    }
    {
      // Cab back corner: the strip behind the rear door rolling round into the back panel.
      const m = cut(S1, [uBelow(S1, u1(K.top) + 0.004, 'seam'), uAbove(S1, u1(K.skirt), 'seam'), vline(REAR_DOOR_LINE, 'rear')], { where: (p) => p[2] > 0.85 && p[1] < 1.4 && p[1] > 0.55, border: 'seam' });
      add(`cabCorner${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['c4_sl_$', 'c4_qm_$', 'c4_bt_$', 'c3_dm_$', 'c3_bt_$'], s));
    }
  }

  // ---------------------------------------------------------------- greenhouse (M4)
  const dloTop = u4(3);
  const BAND = 0.014;
  {
    const wsHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), p[2] - HEADER_Z), edge: 'hem' };
    const m = cutC(S4, [uAboveBy(S4, dloTop, BAND, 'hem'), vAbove(S4, 0, 'seam'), vBelow(S4, 1, 'seam'), wsHole], { border: 'seam' });
    add('roof', 'roof', 'paint', m.mesh, roofBind);
  }
  const glassSpec = (laminated: boolean, beams: BeamSelector): GlassSpec => ({
    laminated,
    beams,
    crackStrain: laminated ? 0.012 : 0.025,
    shatterStrain: laminated ? 0.04 : 0.045,
    crackImpulse: laminated ? 140 : 180,
    shatterImpulse: laminated ? 700 : 420,
    shatterBrokenFraction: 0.34,
  });
  const glassOpts = { castShadow: false, damageWeight: 0 } as const;
  {
    const m = cutC(S4, [uAbove(S4, u4(5) - 0.004, 'seam'), zBelow(HEADER_Z + 0.004, 'seam'), vAbove(S4, 0, 'seam')], { offset: -0.006, border: 'seam', where: (p) => p[2] < -0.3 });
    add('windscreen', 'glass', 'glass', m.mesh, ['c0_ap_*', 'c0_cw', 'c1_rf*', 'c1_bt_*'], { ...glassOpts, glass: glassSpec(true, pairs(GLASS_BEAMS.windscreen)) });
  }
  const SAIL_Z = -0.74;
  for (const s of SIDES) {
    const dlo: Cut[] = [uAboveBy(S4, 0, 0.003, 'seam'), uBelowBy(S4, dloTop, 0.006, 'seam')];
    const fg = cut(S4, [...dlo, zBelow(B_FRONT + 0.03, 'seam'), zAbove(SAIL_Z - 0.02, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] < 0.2 });
    add(`glass${s}F`, 'glass', 'glass', perSide(fg.mesh, s), sideBind(['c0_ap_$', 'c0_hp_$', 'c1_bt_$', 'c1_rf_$', 'c2_bt_$', 'c2_rf_$'], s), { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.side(1, s))) });
    const rg = cut(S4, [...dlo, zAbove(B_REAR - 0.03, 'seam'), zBelow(DLO_TAIL + 0.02, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] > 0.1 && p[2] < 0.95 });
    add(`glass${s}R`, 'glass', 'glass', perSide(rg.mesh, s), sideBind(['c2_bt_$', 'c2_rf_$', 'c3_bt_$', 'c3_rf_$', 'c4_bt_$', 'c4_rf_$'], s), { ...glassOpts, glass: glassSpec(false, pairs([...GLASS_BEAMS.side(2, s), ...GLASS_BEAMS.side(3, s)])) });
    // Black B-pillar, mirror sail, C-pillar strip and the DLO sash band.
    const vTail = vAtZ(S4, dloTop, M4_LAST);
    const band = stripMesh(S4, {
      u0: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) - 0.004),
      u1: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) + BAND + 0.001),
      v0: 0,
      v1: vTail,
      segV: Math.round(60 / rs),
      offset: 0.0006,
    });
    const S4n = opts.lod === 0 ? S4 : createSheet(loftSurface(m4Loft), { resolution: 0.1 * Math.sqrt(rs), maxAngleDeg: 13 * Math.sqrt(rs) });
    const bp = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(B_FRONT, 'hem'), zBelow(B_REAR, 'hem')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0 && p[2] < 0.3 });
    const sail = cut(S4, [uAbove(S4, 0.002, "seam"), uBelow(S4, dloTop, "seam"), zBelow(SAIL_Z, "hem"), vAbove(S4, 0, "seam")], { offset: 0.0005, border: "seam", where: (p) => p[2] < -0.6 });
    const cp = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(DLO_TAIL, 'hem'), vBelow(S4n, 1, 'seam')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0.8 });
    add(`dloTrim${s}`, 'trim', 'trim', perSide(mergeMeshes([band, bp.mesh, sail.mesh, cp.mesh]), s), sideBind(['c0_ap_$', 'c1_rf_$', 'c1_bt_$', 'c2_rf_$', 'c2_bt_$', 'c3_rf_$', 'c3_bt_$', 'c4_rf_$', 'c4_bt_$'], s), { damageWeight: 0.5 });
    const seal = stripMesh(S4, { u0: () => 0, u1: (v) => uAtMetric(S4, v, 0.008), v0: vAtZ(S4, 0, -0.95), v1: vAtZ(S4, 0, 0.92), segV: Math.round(50 / rs), offset: 0.0015 });
    add(`beltSeal${s}`, 'trim', 'rubber', perSide(seal, s), sideBind(['c0_ap_$', 'c0_hp_$', 'c1_bt_$', 'c1_dm_$', 'c2_bt_$', 'c2_dm_$', 'c3_bt_$', 'c3_dm_$', 'c4_bt_$', 'c4_qm_$'], s), { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- cab back panel + back glass
  {
    // The back wall: the closing face of M1 + M4 at z = M1_REAR, from the cab floor line to the roof.
    // Built as a loft of horizontal rows (y) across x (side → centre) following both masters' end sections.
    const sideAt = (y: number): number => {
      // Outline half-width at height y: M1 end below the belt, M4 end above.
      const sec1 = m1Section(M1_REAR);
      const sec4 = m4Section(M4_LAST);
      const poly = [...sec1.slice(0, K.top + 1), ...sec4.slice(1, 6)];
      for (let k = 1; k < poly.length; k++) {
        const a = poly[k - 1]!;
        const b = poly[k]!;
        if ((y - a[1]) * (y - b[1]) <= 0 && a[1] !== b[1]) return lerp(a[0], b[0], (y - a[1]) / (b[1] - a[1]));
      }
      return poly[0]![0];
    };
    const ys = [0.6, 0.66, 0.8, 0.95, 1.1, 1.25, 1.33, 1.45, 1.6, 1.72, 1.82, 1.87];
    const yc = GH.yCentre(M4_LAST);
    const rows: V3[][] = ys.map((y) => {
      const xr = sideAt(y) - 0.012;
      // Slightly bowed back panel (2 mm at the centre), right half listed centre → side.
      return [1, 0.75, 0.5, 0.25, 0].map((f) => [xr * (1 - f), y, M1_REAR - 0.008 * f * (1 - f)] as V3);
    });
    const back = orientMesh(gridLoftMesh(createLoft(rows), opts.lod === 0 ? 8 : 4, opts.lod === 0 ? 22 : 10), [0, 1.2, 0], true);
    const backL = mirrorMesh(back);
    // Rear window cut-out is a separate pane in front of the panel (the panel itself is body colour).
    add('cabBack', 'body', 'paint', mergeMeshes([back, backL]), cabBackBind);
    const winY0 = 1.4;
    const winY1 = 1.76;
    const winX = 0.66;
    const win: V3[][] = [winY0, winY0 + 0.12, winY1 - 0.12, winY1].map((y) => [-winX, -winX * 0.5, 0, winX * 0.5, winX].map((x) => [x * (1 - 0.05 * (y - winY0)), y, M1_REAR + 0.006] as V3));
    const winM = orientMesh(gridLoftMesh(createLoft(win), 4, 3), [0, 1.5, 0], true);
    add('backGlass', 'glass', 'glass', winM, ['c4_bt_*', 'c4_rf*'], { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.back)) });
    const frame = roundedBoxMesh([0, (winY0 + winY1) / 2, M1_REAR + 0.003], [winX + 0.035, (winY1 - winY0) / 2 + 0.035, 0.004], 0.03, { segs: SS });
    add('backGlassFrame', 'trim', 'rubber', frame, ['c4_bt_*', 'c4_rf*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- nose (M2): headlamps + grille (front clip)
  const noseBind = ['s0_*'];
  const LAMP = { x0: 0.645, x1: 0.952, y0: 1.0, y1: 1.212 };
  /** Black lower corner inserts under the headlamps (air curtains + LED turn strip). */
  const CORNER = { x0: 0.668, x1: 0.95, y0: 0.745, y1: 0.955 };
  const cornerShape = fv((x, y) => rmin(0.03, x - CORNER.x0 - 0.04 * smoothstep(CORNER.y1, CORNER.y0, y), CORNER.x1 - x, y - CORNER.y0, CORNER.y1 - y));
  const GRILLE = { x: 0.635, y0: 0.72, y1: 1.208 };
  const lampShape = fv((x, y) => rmin(0.025, x - LAMP.x0, LAMP.x1 - x, y - LAMP.y0 - 0.06 * (1 - smoothstep(LAMP.x0, LAMP.x1, x)), LAMP.y1 - y));
  const grilleShape = fv((x, y) => rmin(0.04, GRILLE.x - x, y - GRILLE.y0, GRILLE.y1 - y));
  /** u on a ribbon where the surface reaches height y at v (bisection). */
  const uAtY = (sheet: Sheet, v: number, y: number): number => {
    let lo = 0;
    let hi = 1;
    const q: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      sheet.surface.point(mid, v, q);
      if (q[1] < y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const vAtX = (sheet: Sheet, y: number, x0: number): number => {
    let lo = 0;
    let hi = 1;
    const q: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      sheet.surface.point(uAtY(sheet, mid, y), mid, q);
      if (q[0] > x0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const frontProj = (p: V3): P2 => [Math.abs(p[0]), p[1]];
  const lastUV = new Map<Sheet, [number, number]>();
  const onFront = (sheet: Sheet, x: number, y: number): [number, number] => {
    const q: V3 = [0, 0, 0];
    const hit = (uv: [number, number]): boolean => {
      sheet.surface.point(uv[0], uv[1], q);
      return Math.hypot(Math.abs(q[0]) - x, q[1] - y) < 1e-6;
    };
    const last = lastUV.get(sheet);
    let uv = last ? paramAt(sheet, frontProj, [x, y], last) : null;
    if (!uv || !hit(uv)) {
      const v0 = vAtX(sheet, y, x);
      uv = paramAt(sheet, frontProj, [x, y], [uAtY(sheet, v0, y), v0]);
    }
    lastUV.set(sheet, uv);
    return uv;
  };
  {
    // Front fascia (body colour) round the lamps and grille, down to the bumper.
    const m = cutC(S2, [uBelow(S2, 1), vAbove(S2, 0), frontCut(neg(lampShape), lens), frontCut(neg(grilleShape), 'lip'), frontCut(neg(cornerShape), 'lip')], { corner: 0.015 });
    add('fascia', 'body', 'paint', m.mesh, noseBind);
    add('fasciaSeal', 'trim', 'rubber', m.seal, noseBind, { damageWeight: 0, castShadow: false });
    // Grille: chrome surround, black mesh insert recessed behind it, two chrome bars across.
    const surround = cutC(S2, [frontCut(grilleShape, 'hem'), frontCut(neg(fv((x, y) => rmin(0.03, GRILLE.x - 0.045 - x, y - GRILLE.y0 - 0.045, GRILLE.y1 - 0.04 - y))), 'lip')], { offset: 0.012, border: 'hem', corner: 0.02 });
    add('grilleSurround', 'grille', 'chrome', surround.mesh, noseBind, { damageWeight: 0.8 });
    const mesh = cutC(S2, [frontCut(fv((x, y) => rmin(0.03, GRILLE.x - 0.03 - x, y - GRILLE.y0 - 0.03, GRILLE.y1 - 0.025 - y)), 'seam')], { offset: -0.035, border: 'seam' });
    add('grille', 'grille', 'grille', mesh.mesh, noseBind, { damageWeight: 0.8 });
    const bars: PanelMesh[] = [];
    // Two bold chrome bars across the grille (a 4 cm blade with bevelled edges) and a thin one below.
    for (const [yb, hh, lift] of [
      [0.865, 0.012, 0.008],
      [0.985, 0.022, 0.016],
      [1.125, 0.022, 0.016],
    ] as const) {
      const segs = opts.lod === 0 ? 14 : 6;
      const prof = [-1, -0.7, 0.7, 1];
      const lifts = [-0.004, lift, lift, -0.004];
      bars.push(
        surfacePatch(
          S2,
          3,
          segs,
          (i, j) => {
            const x = (GRILLE.x - 0.04) * (1 - j / segs);
            const [u, v] = onFront(S2, x, yb + prof[i]! * hh);
            return { u, v, lift: lifts[i]! };
          },
          { smoothNormals: true },
        ),
      );
    }
    const bm = mergeMeshes(bars);
    add('grilleBars', 'grille', 'chrome', mergeMeshes([bm, mirrorMesh(bm)]), noseBind, { damageWeight: 0.8 });
    // Emblem: the Brute hex nut — a chrome nut on the upper bar, black-enamel face, chrome bore boss.
    {
      const zb = -2.83 - 0.03;
      const nut = hexNutMesh([0, 0.985, zb], 0.07, 0.016, 0.006);
      const face = hexNutMesh([0, 0.985, zb - 0.0155], 0.05, 0.003, 0.0015);
      const boss = hexNutMesh([0, 0.985, zb - 0.018], 0.022, 0.004, 0.002);
      add('badges', 'trim', 'chrome', mergeMeshes([nut, boss]), noseBind, { damageWeight: 0.6 });
      add('badgeFace', 'trim', 'trim', face, noseBind, { damageWeight: 0.6, castShadow: false });
    }
    // Headlamps: dark housing recess, lit lens (lamp shader: projector eyes + C-shaped DRL), chrome eye bezels.
    const housing = cutC(S2, [frontCut(lampShape, lens)], { corner: 0.01, offset: -0.006, where: (p) => p[1] > 0.85 && p[0] > 0.5 });
    add('headlampHousing', 'light', 'trim', housing.mesh, noseBind, { damageWeight: 0.3 });
    const lensM = cutC(S2f, [frontCut(fv((x, y) => rmin(0.02, x - LAMP.x0 - 0.008, LAMP.x1 - 0.008 - x, y - LAMP.y0 - 0.008 - 0.06 * (1 - smoothstep(LAMP.x0, LAMP.x1, x)), LAMP.y1 - 0.008 - y)), 'seam')], { offset: -0.002, border: 'seam', where: (p) => p[1] > 0.85 && p[0] > 0.5 });
    add('headlights', 'light', 'lightHead', lensM.mesh, noseBind, { lights: ['head', 'highBeam'], damageWeight: 0.3 });
    // Eye bezels at the shader's projector eyes (34 % / 66 % across, 58 % up the lightHead box, radius 0.27·H).
    let X0 = Infinity;
    let X1 = -Infinity;
    let Y0 = Infinity;
    let Y1 = -Infinity;
    for (let k = 0; k < lensM.mesh.position.length; k += 3) {
      X0 = Math.min(X0, Math.abs(lensM.mesh.position[k]!));
      X1 = Math.max(X1, Math.abs(lensM.mesh.position[k]!));
      Y0 = Math.min(Y0, lensM.mesh.position[k + 1]!);
      Y1 = Math.max(Y1, lensM.mesh.position[k + 1]!);
    }
    const H = Y1 - Y0;
    const rd = 0.27 * H;
    const nA = opts.lod === 0 ? 20 : 12;
    const bezels: PanelMesh[] = [];
    for (const f of [0.34, 0.66]) {
      const ex = X0 + f * (X1 - X0);
      const ey = Y0 + 0.58 * H;
      const br = [rd, rd + 0.003, rd + 0.007];
      const bl = [-0.003, 0.0, -0.004];
      bezels.push(
        surfacePatch(
          S2f,
          2,
          nA,
          (i, j) => {
            const [u, v] = onFront(S2f, ex + br[i]! * Math.cos((j / nA) * Math.PI * 2), ey + br[i]! * Math.sin((j / nA) * Math.PI * 2));
            return { u, v, lift: bl[i]! };
          },
          { closedJ: true, smoothNormals: true },
        ),
      );
    }
    const bz = mergeMeshes(bezels);
    add('projectorBezels', 'trim', 'chrome', mergeMeshes([bz, mirrorMesh(bz)]), noseBind, { damageWeight: 0.3 });
    // Black corner inserts below the lamps (recessed), an LED turn strip along their top edge.
    const corner = cutC(S2, [frontCut(cornerShape, 'seam')], { offset: -0.014, border: 'seam', where: (p) => p[1] < 1.0 && p[0] > 0.6 });
    add('fasciaCorners', 'grille', 'trim', corner.mesh, noseBind, { damageWeight: 0.8 });
    const ind = surfacePatch(
      S2,
      1,
      opts.lod === 0 ? 8 : 4,
      (i, j) => {
        const n = opts.lod === 0 ? 8 : 4;
        const [u, v] = onFront(S2, lerp(CORNER.x0 + 0.03, CORNER.x1 - 0.025, j / n), CORNER.y1 - 0.035 + 0.016 * i);
        return { u, v, lift: -0.011 };
      },
      { smoothNormals: true },
    );
    for (const s of SIDES) add(`indicatorF${s}`, 'light', 'lightIndicator', perSide(ind, s), noseBind, { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
    // Radiator / core support behind the grille mesh.
    add('radiator', 'trim', 'underbody', roundedBoxMesh([0, 0.96, -2.68], [0.64, 0.26, 0.04], 0.01, { segs: 1 }), ['s0_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- hood vents, fender badges
  {
    const vents: PanelMesh[] = [];
    for (const sx of [1, -1])
      for (let k = 0; k < 3; k++) {
        const z = -2.42 + k * 0.045;
        vents.push(roundedBoxMesh([sx * 0.2, m1Top(0.2, z) + 0.006, z], [0.13, 0.008, 0.012], 0.006, { segs: 1, rot: rotX(-0.05) }));
      }
    add('hoodVents', 'trim', 'trim', mergeMeshes(vents), hoodBind, { damageWeight: 0.6 });
    const badge = roundedBoxMesh([L.xSide(-1.18) + 0.01, 1.0, -1.18], [0.006, 0.026, 0.09], 0.005, { segs: 1 });
    for (const s of SIDES) add(`fenderBadge${s}`, 'trim', 'chrome', perSide(badge, s), clipBind(s), { damageWeight: 0.6 });
  }

  // ---------------------------------------------------------------- front bumper (chrome, on the frame horns)
  {
    // A C-section bar lofted along a plan curve that wraps round the corners.
    const plan = smooth2(
      [
        [-1.0, -2.68],
        [-0.985, -2.79],
        [-0.88, -2.885],
        [-0.5, -2.915],
        [0, -2.922],
        [0.5, -2.915],
        [0.88, -2.885],
        [0.985, -2.79],
        [1.0, -2.68],
      ],
      8,
    );
    const nPlan = opts.lod === 0 ? 40 : 18;
    const out = (dx: number, dz: number): P2 => [dz, -dx];
    const smp = sampleCurve(plan, Array.from({ length: nPlan + 1 }, (_, k) => k / nPlan), out);
    // Profile (outward offset, y): top return, upper face, centre crease (step), lower face, bottom return.
    const prof: [number, number][] = [
      [-0.1, 0.795],
      [-0.012, 0.8],
      [0.0, 0.788],
      [0.01, 0.74],
      [0.014, 0.7],
      [0.004, 0.686],
      [0.01, 0.665],
      [0.006, 0.57],
      [-0.006, 0.528],
      [-0.03, 0.515],
      [-0.1, 0.515],
    ];
    const secs: V3[][] = smp.map(({ p, n }) => {
      const endT = Math.max(Math.abs(p[0]) - 0.9, 0) / 0.1;
      const shrink = 1 - 0.25 * endT;
      return prof.map(([o, y]) => [p[0] + n[0] * o, lerp(0.66, y, shrink), p[1] + n[1] * o] as V3);
    });
    const bar = orientMesh(gridLoftMesh(createLoft(secs.map((s) => s)), opts.lod === 0 ? 30 : 12, nPlan), [0, 0.67, -2.6], true);
    // The bar bears on the horns through compression-only crush brackets and is held on only by the
    // straps back to the f3 crossmember (sim PICKUP_DESIGN.bumperStraps): it comes away when they all shear.
    add('bumperF', 'bumper', 'chrome', bar, bumperFBind, { detach: follow({ pairs: PICKUP_BUMPER_STRAPS }, 1), damageWeight: 1 });
    // Black lower valance / skid plate, fog lamps in black bezels, tow hooks.
    const valance = roundedBoxMesh([0, 0.49, -2.86], [0.8, 0.028, 0.045], 0.02, { segs: SS });
    const skid = transformMesh(roundedBoxMesh([0, 0.43, -2.74], [0.5, 0.012, 0.16], 0.01, { segs: 1 }), (q) => {
      const r = rotX(-0.25)([q[0], q[1] - 0.43, q[2] + 2.74]);
      return [r[0], r[1] + 0.43, r[2] - 2.74];
    });
    add('bumperFLower', 'trim', 'trim', mergeMeshes([valance, skid]), bumperFBind, { damageWeight: 0.8 });
    const fogBezel: PanelMesh[] = [];
    const fogLens: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      fogBezel.push(roundedBoxMesh([sx * 0.72, 0.6, -2.912], [0.08, 0.04, 0.012], 0.02, { segs: SS }));
      fogLens.push(roundedBoxMesh([sx * 0.72, 0.6, -2.924], [0.058, 0.025, 0.004], 0.015, { segs: SS }));
    }
    add('fogBezels', 'trim', 'trim', mergeMeshes(fogBezel), bumperFBind, { damageWeight: 0.6 });
    add('fogLamps', 'light', 'lightReverse', mergeMeshes(fogLens), bumperFBind, { lights: ['fog'], damageWeight: 0.3 });
    const hooks: PanelMesh[] = [];
    for (const sx of [1, -1]) hooks.push(roundedBoxMesh([sx * 0.42, 0.5, -2.89], [0.02, 0.035, 0.04], 0.012, { segs: SS }));
    add('towHooks', 'trim', 'underbody', mergeMeshes(hooks), bumperFBind, { damageWeight: 0.4 });
  }

  // ---------------------------------------------------------------- fender flares (black mouldings round the arches)
  const flareMesh = (zc: number, xFace: (z: number) => number, a0: number, a1: number, yCut: number): PanelMesh => {
    const n = opts.lod === 0 ? 30 : 14;
    const secs: V3[][] = [];
    for (let k = 0; k <= n; k++) {
      const a = lerp(a0, a1, k / n);
      const cz = Math.cos(a);
      const sy = Math.sin(a);
      const r0 = ARCH_R - 0.025;
      const z0 = zc - r0 * cz;
      const x = xFace(z0);
      const pt = (r: number, dx: number): V3 => [x + dx, Math.max(ARCH_Y + r * sy, yCut), zc - r * cz];
      secs.push([pt(ARCH_R - 0.035, -0.04), pt(ARCH_R - 0.03, 0.026), pt(ARCH_R - 0.008, 0.046), pt(ARCH_R + 0.075, 0.042), pt(ARCH_R + 0.105, 0.016), pt(ARCH_R + 0.11, -0.006)]);
    }
    return orientMesh(gridLoftMesh(createLoft(secs), opts.lod === 0 ? 8 : 4, n), [0.5, ARCH_Y, zc], true);
  };
  for (const s of SIDES) {
    const fF = flareMesh(ZF, (z) => L.xSide(z) + 0.002, -0.05, Math.PI + 0.05, 0.62);
    add(`flareF${s}`, 'trim', 'trim', perSide(fF, s), clipBind(s), { damageWeight: 0.8 });
    const fR = flareMesh(ZR, () => BED.xOut(ZR) + 0.006, -0.03, Math.PI + 0.03, 0.6);
    add(`flareR${s}`, 'trim', 'trim', perSide(fR, s), bedSideBind(s), { damageWeight: 0.8 });
  }

  // ---------------------------------------------------------------- bed (M5)
  const archR = () => outsideCircle(ZR, ARCH_Y, ARCH_R);
  const TAIL_LAMP = { y0: 0.95, y1: 1.33, z0: 2.9 };
  for (const s of SIDES) {
    const side = cut(S5, [uBelow(S5, u5(KB.railOut) - 0.002, 'hem'), archR(), sideCut(neg({ sd: (z, y) => rmin(0.01, z - TAIL_LAMP.z0, y - TAIL_LAMP.y0, TAIL_LAMP.y1 - y) }), lens)], { where: (p) => p[0] > 0.9 });
    add(`bedSide${s}`, 'body', 'paint', perSide(side.mesh, s), bedSideBind(s));
    const cap = cut(S5, [uAbove(S5, u5(KB.railOut), 'seam'), uBelow(S5, u5(KB.railIn), 'seam')], { offset: 0.003, border: 'hem', where: (p) => p[1] > 1.3 });
    add(`bedRail${s}`, 'trim', 'trim', perSide(cap.mesh, s), bedSideBind(s), { damageWeight: 0.6 });
    const inner = cut(S5, [uAbove(S5, u5(KB.railIn), 'seam'), uBelow(S5, u5(KB.floor), 'seam')], { border: 'seam', where: (p) => p[0] > 0.7 && p[1] > 0.9 });
    add(`bedInner${s}`, 'body', 'paint', perSide(inner.mesh, s), bedSideBind(s), { damageWeight: 0.7 });
  }
  {
    const floor = cutC(S5, [uAbove(S5, u5(KB.floor), 'seam')], { border: 'seam', where: (p) => p[1] < 1.0 && p[0] < 0.86 });
    add('bedFloor', 'body', 'trim', floor.mesh, bedFloorBind, { damageWeight: 0.5 });
  }
  {
    // Inner wheel tubs (humps over the rear tyres) inside the bed.
    const tubs: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      const n = opts.lod === 0 ? 16 : 8;
      const secs: V3[][] = [];
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI;
        const r = ARCH_R + 0.03;
        const z = ZR - r * Math.cos(a);
        const y = Math.max(ARCH_Y + r * Math.sin(a), BED.yFloor + 0.002);
        secs.push([
          [sx * (BED.xIn + 0.002), y, z],
          [sx * (BED.xIn - 0.13), y - 0.004, z],
          [sx * (BED.xIn - 0.17), y - 0.03, z],
          [sx * (BED.xIn - 0.18), BED.yFloor - 0.005, z],
        ]);
      }
      tubs.push(orientMesh(gridLoftMesh(createLoft(secs), 4, n), [sx * 1.2, ARCH_Y, ZR], false));
    }
    for (const [i, s] of SIDES.entries()) add(`bedTub${s}`, 'body', 'paint', i === 0 ? tubs[0]! : tubs[1]!, bedSideBind(s), { damageWeight: 0.6 });
    // Front wall of the bed (inner face visible in the bed, outer face toward the cab).
    const fw: V3[][] = [];
    for (const y of [BED.yFloor - 0.01, 1.1, 1.3, BED.yRail - 0.005]) fw.push([-0.96, -0.5, 0, 0.5, 0.96].map((x) => [x * (Math.abs(x) > 0.9 ? 1 : 1), y, BED_FRONT + 0.012] as V3));
    const wallIn = gridLoftMesh(createLoft(fw), 4, 3);
    const wallFace = orientMesh(wallIn, [0, 1.15, 2.0], false);
    const wallTop = roundedBoxMesh([0, BED.yRail - 0.005, BED_FRONT + 0.025], [0.9, 0.012, 0.028], 0.01, { segs: SS });
    add('bedFront', 'body', 'paint', mergeMeshes([wallFace, flipMesh(wallFace), wallTop]), ['b0_*'], { damageWeight: 0.7 });
    // Tie-down cleats in the bed corners.
    const td: PanelMesh[] = [];
    for (const sx of [1, -1]) for (const z of [1.2, 2.82]) td.push(roundedBoxMesh([sx * (BED.xIn - 0.005), 1.3, z], [0.008, 0.02, 0.03], 0.006, { segs: 1 }));
    add('bedTieDowns', 'trim', 'chrome', mergeMeshes(td), bedFloorBind.concat(['b0_rl_*', 'b3_rl_*']), { damageWeight: 0.5 });
  }
  {
    // Tail lamps: vertical lenses on the bed's rear corner posts, wrapping onto the side (cut above).
    const tl = cut(S5f, [sideCut({ sd: (z, y) => rmin(0.01, z - TAIL_LAMP.z0, y - TAIL_LAMP.y0, TAIL_LAMP.y1 - y) }, lens), uBelow(S5f, u5(KB.railOut) - 0.002, 'hem')], { corner: 0.008, where: (p) => p[2] > 2.85 && p[0] > 0.9 });
    const post = (top: number, bot: number): PanelMesh => roundedBoxMesh([0.935, (top + bot) / 2, BED_REAR + 0.003], [0.064, (top - bot) / 2, 0.006], 0.012, { segs: SS });
    const tailFace = post(TAIL_LAMP.y1, 1.06);
    const revFace = post(1.05, 1.0);
    const indFace = post(0.99, TAIL_LAMP.y0);
    const tails = mergeMeshes([tl.mesh, tailFace]);
    for (const s of SIDES) {
      const bind = sideBind(['b3_bo_$', 'b3_rl_$', 'b3_fl_$', 'b2_rl_$', 'b2_bo_$'], s);
      add(`taillight${s}`, 'light', 'lightTail', perSide(tails, s), bind, { lights: ['tail', 'brake'], damageWeight: 0.3 });
      add(`reverse${s}`, 'light', 'lightReverse', perSide(revFace, s), bind, { lights: ['reverse'], damageWeight: 0.3 });
      add(`indicatorR${s}`, 'light', 'lightIndicator', perSide(indFace, s), bind, { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
      // Corner post face below and around the lamp (body colour).
      add(`bedPost${s}`, 'body', 'paint', perSide(mergeMeshes([post(0.94, 0.62), roundedBoxMesh([0.935, 1.355, BED_REAR - 0.004], [0.064, 0.016, 0.01], 0.008, { segs: SS })]), s), bind, { damageWeight: 0.7 });
    }
  }

  // ---------------------------------------------------------------- tailgate (sub-rig tg_*)
  {
    const xs = [-0.86, -0.7, -0.35, 0, 0.35, 0.7, 0.86];
    const rowsY = [0.64, 0.66, 0.85, 1.05, 1.07, 1.25, 1.33, 1.345];
    const zOut = (x: number, y: number): number => BED_REAR + 0.03 + 0.012 * (1 - (x / 0.86) ** 2) - 0.006 * (y > 1.06 && y < 1.08 ? 1 : 0) - 0.004 * smoothstep(1.3, 1.345, y);
    const rows: V3[][] = rowsY.map((y) => xs.map((x) => [x, y, zOut(x, y)] as V3));
    const outer = orientMesh(gridLoftMesh(createLoft(rows), opts.lod === 0 ? 24 : 10, opts.lod === 0 ? 14 : 7), [0, 1.0, 2.0], true);
    const inner = flipMesh(transformMesh(outer, (q) => [q[0], q[1], BED_REAR - 0.045]));
    const cap = roundedBoxMesh([0, 1.35, BED_REAR - 0.005], [0.865, 0.012, 0.045], 0.01, { segs: SS });
    const sidesTG = [1, -1].map((sx) => roundedBoxMesh([sx * 0.862, 0.995, BED_REAR - 0.005], [0.006, 0.355, 0.042], 0.004, { segs: 1 }));
    const bottom = roundedBoxMesh([0, 0.64, BED_REAR - 0.005], [0.865, 0.008, 0.045], 0.006, { segs: 1 });
    add('tailgate', 'trunk', 'paint', mergeMeshes([outer, inner, cap, bottom, ...sidesTG]), tgBind, { detach: follow('boundary', 0.75) });
    add('tailgateBadge', 'trim', 'chrome', roundedBoxMesh([0, 1.13, BED_REAR + 0.046], [0.16, 0.035, 0.006], 0.006, { segs: 1 }), tgBind, { damageWeight: 0.6 });
    add('tailgateHandle', 'trim', 'trim', roundedBoxMesh([0, 1.3, BED_REAR + 0.047], [0.13, 0.025, 0.012], 0.01, { segs: SS }), tgBind, { damageWeight: 0.5 });
    add('tailgateSpoiler', 'trim', 'trim', roundedBoxMesh([0, 1.36, BED_REAR + 0.02], [0.84, 0.01, 0.02], 0.008, { segs: 1 }), tgBind, { damageWeight: 0.5 });
  }

  // ---------------------------------------------------------------- rear bumper (chrome step bumper) + hitch
  {
    const xsB = [-1.0, -0.92, -0.6, -0.2, 0, 0.2, 0.6, 0.92, 1.0];
    const prof: [number, number][] = [
      [0.48, 3.04],
      [0.49, 3.15],
      [0.52, 3.19],
      [0.62, 3.2],
      [0.66, 3.185],
      [0.7, 3.2],
      [0.78, 3.19],
      [0.8, 3.15],
      [0.805, 3.04],
    ];
    const secs: V3[][] = xsB.map((x) => {
      const wrap = Math.max(Math.abs(x) - 0.9, 0) / 0.1;
      return prof.map(([y, z]) => [x, y, z - 0.09 * wrap * wrap * (z - 3.04) / 0.16] as V3);
    });
    const bar = orientMesh(gridLoftMesh(createLoft(secs), opts.lod === 0 ? 20 : 8, opts.lod === 0 ? 24 : 10), [0, 0.65, 2.9], true);
    add('bumperR', 'bumper', 'chrome', bar, bumperRBind, { detach: follow('boundary', 1) });
    const pads: PanelMesh[] = [roundedBoxMesh([0, 0.805, 3.12], [0.24, 0.006, 0.06], 0.004, { segs: 1 })];
    for (const sx of [1, -1]) pads.push(roundedBoxMesh([sx * 0.78, 0.805, 3.12], [0.16, 0.006, 0.06], 0.004, { segs: 1 }));
    add('stepPads', 'trim', 'trim', mergeMeshes(pads), bumperRBind, { damageWeight: 0.5 });
    const recv = mergeMeshes([
      roundedBoxMesh([0, 0.47, 3.17], [0.045, 0.045, 0.13], 0.008, { segs: SS }),
      roundedBoxMesh([0, 0.47, 3.302], [0.032, 0.032, 0.004], 0.003, { segs: 1 }),
    ]);
    add('hitchReceiver', 'trim', 'underbody', recv, ['hitch', 'br_bl', 'br_bl_L', 'br_bl_R'], { damageWeight: 0.3 });
    // Licence plate in the bumper recess.
    const zp = 3.205;
    const W = 0.15;
    const Hh = 0.075;
    const face: PanelMesh = {
      position: [-W, 0.615 - Hh, zp, W, 0.615 - Hh, zp, W, 0.615 + Hh, zp, -W, 0.615 + Hh, zp],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv: [0, 0, 2 * W, 0, 2 * W, 2 * Hh, 0, 2 * Hh],
      tangent: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      index: [0, 1, 2, 0, 2, 3],
    };
    add('plate', 'trim', 'plate', face, bumperRBind, { damageWeight: 0.6, detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
    add('plateFrame', 'trim', 'trim', roundedBoxMesh([0, 0.615, zp - 0.008], [W + 0.01, Hh + 0.01, 0.004], 0.003, { segs: 1 }), bumperRBind, { damageWeight: 0.6 });
  }

  // ---------------------------------------------------------------- running boards, mirrors, handles, fuel door
  for (const s of SIDES) {
    const board = mergeMeshes([
      roundedBoxMesh([1.03, 0.5, -0.02], [0.065, 0.022, 0.9], 0.02, { segs: SS }),
      roundedBoxMesh([1.03, 0.523, -0.02], [0.058, 0.003, 0.88], 0.002, { segs: 1 }),
      ...[-0.7, 0.0, 0.72].map((z) => roundedBoxMesh([0.97, 0.53, z], [0.035, 0.02, 0.03], 0.008, { segs: 1 })),
    ]);
    add(`runningBoard${s}`, 'trim', 'trim', perSide(board, s), sideBind(['c0_sl_$', 'c1_sl_$', 'c2_sl_$', 'c3_sl_$', 'c4_sl_$', 'c2_fl_$'], s), { damageWeight: 0.7 });
  }
  {
    // Tall towing-style mirrors on the front doors.
    const housing = roundedBoxMesh([1.13, 1.38, -0.86], [0.1, 0.13, 0.05], 0.04, { segs: SB });
    const cap = roundedBoxMesh([1.13, 1.38, -0.885], [0.096, 0.126, 0.03], 0.038, { segs: SB });
    const glassM = roundedBoxMesh([1.13, 1.38, -0.808], [0.082, 0.112, 0.003], 0.02, { segs: 1 });
    const arm = mergeMeshes([roundedBoxMesh([1.03, 1.33, -0.86], [0.05, 0.02, 0.025], 0.01, { segs: SS }), roundedBoxMesh([1.03, 1.44, -0.86], [0.05, 0.015, 0.02], 0.01, { segs: SS })]);
    const base = roundedBoxMesh([0.99, 1.36, -0.88], [0.02, 0.06, 0.07], 0.015, { segs: SS });
    for (const s of SIDES) {
      const bind = sideBind(['c0_ap_$', 'c0_hp_$', 'c1_bt_$', 'c1_dm_$'], s);
      const det = { attach: 'boundary', minBrokenFraction: 0.34, mode: 'hide' } as const;
      add(`mirror${s}`, 'mirror', 'trim', perSide(mergeMeshes([housing, arm, base]), s), bind, { detach: det, damageWeight: 0.8 });
      add(`mirrorCap${s}`, 'mirror', 'chrome', perSide(cap, s), bind, { detach: det, damageWeight: 0.8 });
      add(`mirrorGlass${s}`, 'mirror', 'mirror', perSide(glassM, s), bind, { detach: det, damageWeight: 0 });
    }
  }
  {
    const sideX = (z: number, y: number): number => {
      let best = Infinity;
      let bx = 1.0;
      for (let i = 0; i < S1.P.length; i += 3) {
        if (S1.P[i]! < 0.8) continue;
        const d = Math.hypot(S1.P[i + 2]! - z, S1.P[i + 1]! - y);
        if (d < best) {
          best = d;
          bx = S1.P[i]!;
        }
      }
      return bx;
    };
    const handle = (z: number): PanelMesh => {
      const y = L.ySh(z) + 0.06;
      return roundedBoxMesh([sideX(z, y) + 0.008, y, z], [0.012, 0.018, 0.085], 0.01, { segs: SS });
    };
    const hf = handle(-0.0);
    const hr = handle(0.78);
    for (const s of SIDES) {
      add(`handle${s}F`, 'trim', 'chrome', perSide(hf, s), doorFBind(s), { damageWeight: 0.5 });
      add(`handle${s}R`, 'trim', 'chrome', perSide(hr, s), doorRBind(s), { damageWeight: 0.5 });
    }
    // Fuel door on the left bed side, ahead of the rear arch.
    const fd = cut(S5f, [sideCut({ sd: (z, y) => rmin(0.012, 0.09 - Math.abs(z - 1.25), 0.07 - Math.abs(y - 1.17)) }, 'shut')], { where: (p) => Math.abs(p[2] - 1.25) < 0.15 && Math.abs(p[1] - 1.17) < 0.12 && p[0] > 0.9 });
    add('fuelDoor', 'trim', 'paint', mirrorMesh(fd.mesh), sideBind(['b0_bo_$', 'b0_rl_$', 'b1_bo_$', 'b1_rl_$', 'b0_fl_$', 'b1_fl_$'], 'L'), { detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
    // Wipers on the cowl.
    const wip: PanelMesh[] = [];
    for (const [x0, x1] of [
      [-0.62, 0.02],
      [0.08, 0.66],
    ]) {
      const n = 8;
      const secs: V3[][] = [];
      for (let k = 0; k <= n; k++) {
        const x = lerp(x0!, x1!, k / n);
        const z = -0.985 + 0.02 * Math.abs(x) - 0.02;
        const y = 1.325 + 0.01;
        secs.push([
          [x, y, z - 0.008],
          [x, y + 0.012, z],
          [x, y, z + 0.008],
        ]);
      }
      wip.push(gridLoftMesh(createLoft(secs), 2, n));
    }
    add('wipers', 'trim', 'rubber', orientMesh(mergeMeshes(wip), [0, 1.0, 0], true), ['c0_ap_*', 'c0_cw', 'c0_fw_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- wheel wells, underbody, frame
  {
    const liner = (zc: number, x0: number, x1: number): PanelMesh => {
      const arcs: V3[][] = [];
      const R = ARCH_R + 0.01;
      for (let k = 0; k <= 16; k++) {
        const a = -0.15 + ((Math.PI + 0.3) * k) / 16;
        const y = ARCH_Y + R * Math.sin(a);
        const z = zc - R * Math.cos(a);
        arcs.push([
          [x0, y, z],
          [lerp(x0, x1, 0.5), y, z],
          [x1, y, z],
        ]);
      }
      return orientMesh(gridLoftMesh(createLoft(arcs), 2, 20), [lerp(x0, x1, 0.5), ARCH_Y, zc], false);
    };
    const lf = liner(ZF, 0.62, 0.985);
    const lr = liner(ZR, 0.62, 0.99);
    for (const s of SIDES) {
      add(`linerF${s}`, 'trim', 'underbody', perSide(lf, s), clipBind(s), { damageWeight: 0 });
      add(`linerR${s}`, 'trim', 'underbody', perSide(lr, s), bedSideBind(s), { damageWeight: 0 });
    }
    // Frame rails (boxed, black), one part per segment bound to its own stations.
    const rail = (z0: number, z1: number, y0: number, y1: number, x: number): PanelMesh => roundedBoxMesh([x, (y0 + y1) / 2, (z0 + z1) / 2], [0.045, (y1 - y0) / 2, (z1 - z0) / 2], 0.012, { segs: 1, flat: [1, 1, 4] });
    const front: PanelMesh[] = [];
    const mid: PanelMesh[] = [];
    const rear: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      front.push(rail(-2.75, -1.4, 0.47, 0.7, sx * 0.47));
      mid.push(rail(-1.4, 1.2, 0.43, 0.72, sx * 0.525));
      rear.push(rail(1.2, 3.02, 0.6, 0.84, sx * 0.53));
    }
    add('frameFront', 'trim', 'underbody', mergeMeshes(front), ['f0_*', 'f1_*', 'f2_*', 'f3_lo_*', 'f3_hi_*', 'f4_*'], { damageWeight: 0.6 });
    add('frameMid', 'trim', 'underbody', mergeMeshes(mid), ['f4_*', 'f5_*', 'f6_*', 'f7_*', 'f8_*'], { damageWeight: 0.4 });
    add('frameRear', 'trim', 'underbody', mergeMeshes([...rear, roundedBoxMesh([0, 0.7, 3.0], [0.53, 0.06, 0.04], 0.01, { segs: 1 })]), ['f8_*', 'f9_lo_*', 'f9_hi_*', 'f10_*', 'f11_*'], { damageWeight: 0.4 });
    // Fuel tank between the rails, rear axle housing, spare tyre under the bed, exhaust.
    add('fuelTank', 'trim', 'underbody', roundedBoxMesh([-0.75, 0.62, 0.55], [0.17, 0.12, 0.4], 0.05, { segs: SS }), ['c3_fl_L', 'c3_sl_L', 'c4_fl_L', 'c4_sl_L', 'c2_fl_L', 'c2_sl_L'], { damageWeight: 0 });
    const tube = (x0: number, x1: number, y: number, z: number, r: number): PanelMesh => {
      const secs: V3[][] = [];
      for (const x of [x0, x1]) {
        const ring: V3[] = [];
        for (let k = 0; k < 12; k++) ring.push([x, y + r * Math.sin((k / 12) * Math.PI * 2), z + r * Math.cos((k / 12) * Math.PI * 2)]);
        secs.push(ring);
      }
      return orientMesh(gridLoftMesh(createLoft(secs, { closedU: true }), 12, 1, { capStart: true, capEnd: true }), [(x0 + x1) / 2, y, z], true);
    };
    add('axleHousing', 'trim', 'underbody', mergeMeshes([tube(-0.74, 0.74, 0.39, ZR, 0.055), roundedBoxMesh([0, 0.4, ZR - 0.02], [0.16, 0.14, 0.13], 0.09, { segs: SS })]), ['RL_kU', 'RR_kU', 'RL_ab', 'RR_ab', 'axD'], { damageWeight: 0, castShadow: true });
    const spare: PanelMesh = (() => {
      const secs: V3[][] = [];
      for (const [r, y] of [
        [0.0, 0.66],
        [0.2, 0.66],
        [0.3, 0.665],
        [0.36, 0.69],
        [0.37, 0.74],
        [0.36, 0.79],
        [0.3, 0.815],
        [0.2, 0.82],
        [0.0, 0.82],
      ] as const) {
        const ring: V3[] = [];
        for (let k = 0; k < 20; k++) ring.push([r * Math.cos((k / 20) * Math.PI * 2), y, 2.6 + r * Math.sin((k / 20) * Math.PI * 2)]);
        secs.push(ring);
      }
      return orientMesh(gridLoftMesh(createLoft(secs.map((r) => r)), 20, 8), [0, 0.74, 2.6], true);
    })();
    add('spare', 'trim', 'underbody', spare, ['f10_*', 'f11_*'], { damageWeight: 0 });
    const pipeSecs: V3[][] = [];
    for (const [x, y, z] of [
      [0.3, 0.5, 0.0],
      [0.35, 0.5, 1.2],
      [0.62, 0.52, 2.3],
      [0.72, 0.5, 3.02],
      [0.73, 0.5, 3.08],
    ] as const) {
      const ring: V3[] = [];
      for (let k = 0; k < 10; k++) ring.push([x + 0.04 * Math.cos((k / 10) * Math.PI * 2), y + 0.04 * Math.sin((k / 10) * Math.PI * 2), z]);
      pipeSecs.push(ring);
    }
    add('exhaust', 'trim', 'chrome', orientMesh(gridLoftMesh(createLoft(pipeSecs, { closedU: true }), 10, 24), [0.5, 0.5, 1.5], true), ['f7_*', 'f8_*', 'f9_lo_*', 'f9_hi_*', 'f10_*', 'f11_*'], { damageWeight: 0.3 });
    add('engine', 'trim', 'underbody', roundedBoxMesh([0, 0.88, -1.9], [0.36, 0.22, 0.45], 0.06, { segs: SS }), ['eng_*', 'gbx_*'], { damageWeight: 0.3 });
    add('firewall', 'trim', 'underbody', roundedBoxMesh([0, 1.05, -1.0], [0.82, 0.24, 0.012], 0.01, { segs: 1 }), ['c0_*'], { damageWeight: 0 });
    add('underbody', 'trim', 'underbody', roundedBoxMesh([0, 0.8, -0.0], [0.93, 0.008, 0.93], 0.01, { segs: 1 }), ['c0_fl_*', 'c0_tn', 'c1_fl_*', 'c1_tn', 'c2_fl_*', 'c2_tn', 'c3_fl_*', 'c3_tn', 'c4_fl_*', 'c4_tn'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- interior
  {
    const floorBind = ['c0_fl_*', 'c0_tn', 'c1_fl_*', 'c1_tn', 'c2_fl_*', 'c2_tn', 'c3_fl_*', 'c3_tn', 'c4_fl_*', 'c4_tn'];
    const dashBind = ['c0_*', 'c1_dm_*', 'c1_bt_*', 'c1_sl_*'];
    add('carpet', 'interior', 'interior', roundedBoxMesh([0, 0.84, -0.02], [0.92, 0.02, 0.95], 0.015, { segs: 1 }), floorBind, { damageWeight: 0 });
    const dash = mergeMeshes([
      roundedBoxMesh([0, 1.2, -0.84], [0.9, 0.14, 0.15], 0.06, { segs: SB, rot: rotX(0.1) }),
      roundedBoxMesh([0, 1.31, -0.93], [0.86, 0.04, 0.09], 0.03, { segs: SB }),
      roundedBoxMesh([-0.45, 1.33, -0.72], [0.2, 0.05, 0.08], 0.03, { segs: SB, rot: rotX(-0.15) }),
      roundedBoxMesh([0, 1.0, -0.78], [0.18, 0.24, 0.12], 0.05, { segs: SB }),
    ]);
    add('dash', 'interior', 'interiorTrim', dash, dashBind, { damageWeight: 0 });
    const tilt = 0.5;
    const wc: V3 = [-0.45, 1.24, -0.6];
    const torus: V3[][] = [];
    const NR = opts.lod === 0 ? 16 : 12;
    for (let k = 0; k <= NR; k++) {
      const a = (k / NR) * Math.PI * 2;
      const sec: V3[] = [];
      for (let q = 0; q < 10; q++) {
        const b = (q / 10) * Math.PI * 2;
        const r = 0.2 + 0.019 * Math.cos(b);
        sec.push([Math.cos(a) * r, Math.sin(a) * r, 0.019 * Math.sin(b)]);
      }
      torus.push(sec);
    }
    const wheelLocal = mergeMeshes([
      orientMesh(gridLoftMesh(createLoft(torus, { closedU: true }), opts.lod === 0 ? 6 : 4, NR * 2), [0, 0, 0]),
      roundedBoxMesh([0, -0.01, 0.0], [0.07, 0.05, 0.028], 0.02, { segs: SS }),
      roundedBoxMesh([-0.12, -0.02, 0], [0.08, 0.018, 0.012], 0.008, { segs: SS }),
      roundedBoxMesh([0.12, -0.02, 0], [0.08, 0.018, 0.012], 0.008, { segs: SS }),
      roundedBoxMesh([0, -0.12, 0], [0.018, 0.08, 0.012], 0.008, { segs: SS }),
      roundedBoxMesh([0, 0, -0.13], [0.035, 0.035, 0.11], 0.015, { segs: SS }),
    ]);
    const steering = transformMesh(wheelLocal, (q) => {
      const r = rotX(tilt)(q);
      return [r[0] + wc[0], r[1] + wc[1], r[2] + wc[2]];
    });
    add('steering', 'interior', 'interiorTrim', steering, dashBind, { damageWeight: 0 });
    add('console', 'interior', 'interiorTrim', roundedBoxMesh([0, 1.0, -0.3], [0.17, 0.14, 0.45], 0.05, { segs: SB }), floorBind, { damageWeight: 0 });
    const seat = (x: number, z: number, w: number): PanelMesh =>
      mergeMeshes([
        roundedBoxMesh([x, 1.0, z], [w, 0.08, 0.27], 0.05, { segs: SS }),
        roundedBoxMesh([x, 1.38, z + 0.32], [w, 0.33, 0.07], 0.06, { segs: SB, rot: rotX(-0.25) }),
        roundedBoxMesh([x, 1.8, z + 0.43], [0.14, 0.09, 0.06], 0.04, { segs: SB, rot: rotX(-0.25) }),
      ]);
    const frontSeatBind = ['c1_fl_*', 'c1_tn', 'c1_sl_*', 'c1_dm_*', 'c2_fl_*', 'c2_tn', 'c2_sl_*', 'c2_dm_*', 'c2_bt_*', 'c1_bt_*'];
    add('seatsFront', 'interior', 'interior', mergeMeshes([seat(-0.45, -0.25, 0.27), seat(0.45, -0.25, 0.27)]), frontSeatBind, { damageWeight: 0 });
    const bench = mergeMeshes([
      roundedBoxMesh([0, 1.0, 0.55], [0.86, 0.08, 0.25], 0.06, { segs: SB }),
      roundedBoxMesh([0, 1.36, 0.86], [0.86, 0.32, 0.07], 0.06, { segs: SB, rot: rotX(-0.2) }),
      ...[-0.5, 0, 0.5].map((x) => roundedBoxMesh([x, 1.74, 0.94], [0.12, 0.07, 0.05], 0.03, { segs: SS, rot: rotX(-0.2) })),
    ]);
    add('seatsRear', 'interior', 'interior', bench, ['c3_fl_*', 'c3_tn', 'c3_sl_*', 'c3_dm_*', 'c4_fl_*', 'c4_tn', 'c4_sl_*', 'c4_qm_*', 'c4_bt_*', 'c3_bt_*'], { damageWeight: 0 });
    for (const s of SIDES) {
      const card = (z0: number, z1: number): PanelMesh =>
        mergeMeshes([
          roundedBoxMesh([0.925, 1.0, (z0 + z1) / 2], [0.025, 0.32, (z1 - z0) / 2], 0.018, { segs: SS, flat: opts.lod === 0 ? [1, 4, 6] : [1, 2, 3] }),
          roundedBoxMesh([0.885, 1.04, (z0 + z1) / 2 + 0.04], [0.035, 0.024, (z1 - z0) / 2 - 0.12], 0.015, { segs: SS }),
        ]);
      add(`doorCard${s}F`, 'interior', 'interiorTrim', perSide(card(-0.9, 0.06), s), doorFBind(s), { damageWeight: 0 });
      add(`doorCard${s}R`, 'interior', 'interiorTrim', perSide(card(0.2, 0.88), s), doorRBind(s), { damageWeight: 0 });
    }
    // ends inside the windscreen opening (see the sedan: a lining spanning it is a brown sheet once the glass is gone)
    const hl = cutC(S4lo, [uAbove(S4lo, dloTop - 0.01, 'seam'), zAbove(HEADER_Z - 0.02, 'seam'), vBelow(S4lo, 1, 'seam'), sideCut({ sd: (_z, y) => y - 1.5 }, 'seam')], { offset: -0.016, border: 'seam' });
    add('headliner', 'interior', 'interior', flipMesh(hl.mesh), roofBind, { damageWeight: 0, castShadow: false });
  }

  return {
    vehicle: 'pickup',
    panels: opts.lod === 2 ? panels.filter((p) => !LOD2_DROP.test(p.id)) : panels,
    paint: { ...PICKUP_PAINT },
    wheels: {
      rim: { style: 'spoke', spokes: 6, spokeWidth: 0.42, dish: 0.045, lip: 0.014, finish: 'silver', boltCount: 6 },
      tire: { tread: 'allTerrain', sidewallText: 'CRUMPLE TERRAIN A/T', bulge: 0.12 },
      brake: { discRadius: 0.2, caliperColor: 0x1a1a1c },
    },
    plate: 'BRT 500',
  };
}

/** The pickup's full-detail visual definition (LOD0). */
export const PICKUP_VISUAL: VehicleVisualDef = buildPickupVisual({ lod: 0 });

/** Interior door cards follow their door skins (binder.ts bindFollower; see the sedan). */
export const PICKUP_FOLLOW: Readonly<Record<string, string>> = {
  doorCardRF: 'doorRF',
  doorCardRR: 'doorRR',
  doorCardLF: 'doorLF',
  doorCardLR: 'doorLR',
};

setVisualExtras(PICKUP_VISUAL, {
  lods: [once(() => buildPickupVisual({ lod: 1 })), once(() => buildPickupVisual({ lod: 2 }))],
  follow: PICKUP_FOLLOW,
});
