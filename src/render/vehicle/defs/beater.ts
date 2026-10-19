/**
 * BEATER visual definition (P6, F4): a 1990s boxy compact sedan prepared
 * for a demolition derby, wrapping the physics lattice of
 * src/sim/vehicle/defs/beater.ts (wheelbase 2.47, track 1.42, 0.29 m tyres,
 * stations s0 (z −2.08) … s13 (z +2.12), hood sub-rig hood_{0..3}{L,C,R}).
 *
 * PURE DATA, generated once at module load (deterministic). Built the way
 * the sedan is (copy-and-adapt, P6 rule): four MASTER surfaces with every
 * panel cut from them so shut lines and highlights stay continuous —
 *   M1 body       slab sides, one crisp waist crease, flat hood and deck;
 *   M4 greenhouse upright, square glasshouse (no glass: derby rules);
 *   M2 nose       flat face: rectangular composite lamps, slatted grille,
 *                 a wraparound bumper with a rubbing strip;
 *   M3 tail       square three-section lamp clusters, a black plastic bumper.
 * The derby build on top (character, not decoration):
 *   - no glass but a steel MESH screen in the windscreen opening;
 *   - a ROLL CAGE in safety yellow through the empty windows (material slot
 *     'caliper': the cage colour is WheelVisualDef.brake.caliperColor — the
 *     steel wheels hide the calipers);
 *   - battered REST shape: dents baked into the door / quarter / hood skins
 *     and a front bumper whose right end is bent down and out, held on by a
 *     chain (right) and a ratchet strap (left);
 *   - per-panel PanelFinish: faded single-stage paint, a primer-grey right
 *     fender, a mismatched maroon rear-left door, rust along the sills and
 *     arches (eaten through in places), grime, clear-coat peel, a cracked
 *     headlamp and tail lamp, a hand-painted number on both front doors and
 *     the roof; missing trim (the right mirror is gone, a grille slat too);
 *   - steel wheels on worn tyres, a rusty single exhaust.
 * Binding: each panel binds only the rig nodes that carry it (as the sedan).
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
  polyShape,
  rotX,
  roundedBoxMesh,
  sideCut,
  smooth2,
  stripMesh,
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
import { once, setVisualExtras } from '../lods';
import type { MaterialSlot, PanelDef, PanelFinish, PanelKind, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { setFinishExtras } from '../weathering';

// ====================================================================== rig-matched dimensions
/** Asserted against compileVehicle(BEATER) by beater.test.ts. */
export const BEATER_DIMS = {
  axleFrontZ: -1.235,
  axleRearZ: 1.235,
  halfTrack: 0.71,
  hubY: 0.29,
  tyreRadius: 0.29,
  /** Wheel-arch opening radius (lip), centred just above the hub. */
  archRadius: 0.35,
  archLift: 0.012,
} as const;

const ZF = BEATER_DIMS.axleFrontZ;
const ZR = BEATER_DIMS.axleRearZ;
const ARCH_Y = BEATER_DIMS.hubY + BEATER_DIMS.archLift;
const ARCH_R = BEATER_DIMS.archRadius;

/** The paint (palettes[0] of the catalog entry: faded single-stage teal). */
export const BEATER_PAINT = { color: 0x3f7f7a, metallic: 0, roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.4, flake: null } as const;
/** Roll-cage colour (safety yellow, brush-painted): the 'caliper' slot colour. */
export const CAGE_COLOR = 0xc9971c;

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

// ====================================================================== body lines
/**
 * Feature lines as functions of z (forward −Z), REST pose. Slab sides with
 * almost no tumblehome, one horizontal waist crease, a flat hood that
 * rides ≈ 1.5 cm over the hood nodes (y 0.74 / 0.83 / 0.88 / 0.91 at
 * z −1.84 / −1.52 / −1.18 / −0.84) and a flat deck over the trunk-lid
 * nodes (y ≈ 0.95).
 */
const L = {
  yBot: pchip([
    [-1.96, 0.28],
    [-1.7, 0.27],
    [-0.95, 0.205],
    [-0.75, 0.188],
    [0.85, 0.188],
    [1.05, 0.205],
    [1.7, 0.29],
    [1.98, 0.3],
  ]),
  skirt: pchip([
    [-2, 0.07],
    [2, 0.07],
  ]),
  xSide: pchip([
    [-1.96, 0.79],
    [-1.88, 0.81],
    [-1.7, 0.822],
    [-1.235, 0.827],
    [0, 0.83],
    [1.235, 0.83],
    [1.7, 0.826],
    [1.9, 0.816],
    [1.98, 0.802],
  ]),
  /** Waist crease height. */
  ySh: pchip([
    [-1.96, 0.7],
    [-1.5, 0.705],
    [0, 0.716],
    [1.5, 0.726],
    [1.98, 0.73],
  ]),
  /** Top corner (fender top / belt / deck corner). */
  yTop: pchip([
    [-1.96, 0.726],
    [-1.84, 0.744],
    [-1.52, 0.828],
    [-1.18, 0.874],
    [-0.9, 0.9],
    [-0.75, 0.91],
    [0, 0.924],
    [0.9, 0.934],
    [1.2, 0.942],
    [1.98, 0.944],
  ]),
  xTop: pchip([
    [-1.96, 0.772],
    [-1.8, 0.8],
    [-1.4, 0.807],
    [0, 0.812],
    [1.4, 0.81],
    [1.9, 0.8],
    [1.98, 0.788],
  ]),
  /** Hood / deck shut-line half width. */
  xHood: pchip([
    [-1.96, 0.7],
    [-1.7, 0.735],
    [-1.2, 0.745],
    [0, 0.75],
    [1.4, 0.746],
    [1.98, 0.73],
  ]),
  yHood: pchip([
    [-1.96, 0.744],
    [-1.84, 0.758],
    [-1.52, 0.848],
    [-1.18, 0.897],
    [-0.84, 0.926],
    [-0.72, 0.932],
    [0, 0.94],
    [1.0, 0.952],
    [1.4, 0.958],
    [1.98, 0.958],
  ]),
  crown: pchip([
    [-2, 0.014],
    [2, 0.01],
  ]),
};

/** M1 top surface height (hood / deck) at (x, z). */
function topY(x: number, z: number): number {
  const xh = L.xHood(z);
  const t = Math.min(1, Math.abs(x) / xh);
  return L.yHood(z) + L.crown(z) * (1 - t * t);
}

// ====================================================================== M1 body master
/** M1 control-point indices of the feature lines (the sedan's layout, flat top). */
const K = { skirt: 2, shoulder: 6, top: 9, hood: 10 } as const;
const FRONT_BEND = [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.012, -0.024, -0.03, -0.032, -0.034];
const REAR_BEND = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.012, 0.024, 0.03, 0.032, 0.034];
const M1_FRONT = -1.96;
const M1_REAR = 1.98;
const M1_STATIONS = [
  -1.96, -1.93, -1.88, -1.8, -1.7, -1.6, -1.48, -1.36, -1.235, -1.11, -0.99, -0.88, -0.8, -0.7, -0.5, -0.25, 0, 0.25, 0.5, 0.72, 0.88, 1.0, 1.11, 1.235,
  1.36, 1.48, 1.6, 1.72, 1.84, 1.92, 1.96, 1.98,
];

function m1Section(z: number): V3[] {
  const xs = L.xSide(z);
  const yb = L.yBot(z);
  const ysk = yb + L.skirt(z);
  const ysh = L.ySh(z);
  const yt = L.yTop(z);
  const xh = L.xHood(z);
  const pts: [number, number][] = [
    [xs - 0.07, yb - 0.004],
    [xs - 0.02, yb + 0.006],
    [xs - 0.004, ysk],
    [xs, lerp(ysk, ysh, 0.3)],
    [xs + 0.003, lerp(ysk, ysh, 0.7)],
    [xs + 0.005, ysh - 0.018],
    // the waist crease: a crisp horizontal step
    [xs + 0.0065, ysh],
    [xs + 0.0005, ysh + 0.01],
    [lerp(xs - 0.004, L.xTop(z), 0.5), lerp(ysh, yt, 0.55)],
    [L.xTop(z), yt],
    [xh, L.yHood(z)],
    [xh * 0.62, topY(xh * 0.62, z)],
    [xh * 0.3, topY(xh * 0.3, z)],
    [0, L.yHood(z) + L.crown(z)],
  ];
  const wf = 1 - smoothstep(M1_FRONT, -1.8, z);
  const wr = smoothstep(1.84, M1_REAR, z);
  return pts.map(([x, y], k) => [x, y, z + wf * FRONT_BEND[k]! + wr * REAR_BEND[k]!] as V3);
}

/** Arch flares: a small lip ring just outside each arch. */
function flare(p: V3): void {
  const ax = Math.abs(p[0]);
  if (ax < 0.7) return;
  const hf = smoothstep(0.75, 0.81, ax);
  const sh = L.ySh(p[2]);
  const vf = 1 - smoothstep(sh - 0.06, sh - 0.015, p[1]);
  if (hf * vf <= 0) return;
  let dx = 0;
  for (const zc of [ZF, ZR]) {
    const d = Math.hypot(p[2] - zc, p[1] - ARCH_Y);
    dx += 0.007 * (1 - smoothstep(ARCH_R + 0.01, ARCH_R + 0.08, d));
  }
  p[0] += Math.sign(p[0]) * dx * hf * vf;
}

// ====================================================================== battered rest shape
/**
 * A dent: a smooth dish pushed in along `dir` (unit, into the body), centre
 * c, radii (r along the panel), depth d. Applied to finished per-side
 * meshes (transformMesh carries the normals), so left and right differ.
 */
interface Dent {
  c: V3;
  r: V3;
  d: number;
  dir: V3;
  /** Sharp crease along the dent's long axis (0..1). */
  crease?: number;
}
function dentField(dents: readonly Dent[]): (p: V3) => V3 {
  return (p) => {
    let x = p[0];
    let y = p[1];
    let z = p[2];
    for (const t of dents) {
      const q = Math.hypot((p[0] - t.c[0]) / t.r[0], (p[1] - t.c[1]) / t.r[1], (p[2] - t.c[2]) / t.r[2]);
      if (q >= 1) continue;
      const s = 1 - q * q;
      // a soft dish with a sharper (but smooth) floor along the long axis when creased
      const prof = s * s * (1 + (t.crease ?? 0) * 0.6 * Math.exp(-(((p[1] - t.c[1]) / t.r[1]) ** 2) * 12));
      x += t.dir[0] * t.d * prof;
      y += t.dir[1] * t.d * prof;
      z += t.dir[2] * t.d * prof;
    }
    return [x, y, z];
  };
}
/** Dents per right/left side panel (rest metres; dir points INTO the body). */
const DENTS: Readonly<Record<string, readonly Dent[]>> = {
  doorRF: [{ c: [0.83, 0.5, -0.42], r: [0.2, 0.17, 0.22], d: 0.028, dir: [-1, 0, 0] }],
  doorRR: [
    { c: [0.83, 0.42, 0.55], r: [0.2, 0.12, 0.3], d: 0.022, dir: [-1, 0, 0] },
    { c: [0.83, 0.62, 0.3], r: [0.2, 0.09, 0.1], d: 0.012, dir: [-1, 0, 0] },
  ],
  doorLF: [{ c: [-0.83, 0.62, -0.1], r: [0.2, 0.1, 0.16], d: 0.016, dir: [1, 0, 0] }],
  quarterL: [{ c: [-0.83, 0.68, 1.62], r: [0.2, 0.18, 0.26], d: 0.034, dir: [1, 0, 0] }],
  quarterR: [{ c: [0.83, 0.5, 1.82], r: [0.2, 0.14, 0.16], d: 0.02, dir: [-1, 0, 0] }],
  fenderL: [{ c: [-0.82, 0.66, -1.62], r: [0.2, 0.13, 0.17], d: 0.024, dir: [1, 0, 0] }],
  hood: [
    { c: [0.22, 0.88, -1.42], r: [0.24, 0.2, 0.24], d: 0.02, dir: [0, -1, 0] },
    { c: [-0.42, 0.82, -1.7], r: [0.18, 0.2, 0.14], d: 0.012, dir: [0, -1, 0] },
  ],
  trunk: [{ c: [0.35, 0.96, 1.85], r: [0.2, 0.2, 0.14], d: 0.016, dir: [0, -1, 0] }],
  roof: [{ c: [-0.25, 1.4, 0.35], r: [0.3, 0.2, 0.32], d: 0.015, dir: [0, -1, 0] }],
};
const dented = (id: string, m: PanelMesh): PanelMesh => (DENTS[id] ? transformMesh(m, dentField(DENTS[id]!)) : m);

/**
 * The front bumper's RIGHT end bent down and out (a derby hit): rotate about
 * a hinge at x 0.22 with a droop growing toward the corner. Every part on
 * the bumper (strip, intake, indicator) gets the same map.
 */
function bumperBend(p: V3): V3 {
  const t = smoothstep(0.22, 0.8, p[0]);
  const droop = 0.085 * t * t;
  const out = 0.045 * t * t;
  const twist = 0.25 * t * t * (p[1] - 0.42);
  return [p[0] - 0.012 * t * t, p[1] - droop, p[2] - out - twist];
}

// ====================================================================== M4 greenhouse master
const M4_FIRST = -0.86;
const M4_LAST = 1.3;
const M4_STATIONS = [-0.86, -0.82, -0.76, -0.68, -0.58, -0.48, -0.38, -0.28, -0.16, 0, 0.2, 0.4, 0.56, 0.68, 0.78, 0.88, 0.96, 1.03, 1.09, 1.15, 1.21, 1.26, 1.3];
const G = {
  /** DLO top: A-pillar, flat roof rail, a steep C-pillar to the belt at z ≈ 1.07. */
  yGlass: pchip([
    [-0.84, 0.935],
    [-0.7, 1.03],
    [-0.55, 1.13],
    [-0.4, 1.225],
    [-0.28, 1.295],
    [-0.15, 1.322],
    [0.2, 1.33],
    [0.55, 1.322],
    [0.68, 1.296],
    [0.8, 1.235],
    [0.9, 1.15],
    [0.98, 1.07],
    [1.04, 1.0],
    [1.07, 0.97],
  ]),
  /** Centre line: windscreen base → header → flat roof → rear glass → deck. */
  yCentre: pchip([
    [-0.9, 0.95],
    [-0.62, 1.145],
    [-0.38, 1.305],
    [-0.22, 1.372],
    [-0.05, 1.392],
    [0.4, 1.396],
    [0.62, 1.385],
    [0.74, 1.345],
    [0.88, 1.23],
    [1.02, 1.11],
    [1.16, 1.01],
    [1.3, 0.972],
  ]),
  tumble: 0.3,
};
const FRONT_BEND4 = [0, 0, 0, 0, -0.003, -0.006, -0.02, -0.03];
const REAR_BEND4 = [-0.01, -0.01, -0.01, -0.01, -0.005, 0, 0.02, 0.03];
const HEADER_Z = -0.26;
const REAR_TOP_Z = 0.72;
const DLO_TAIL = 1.05;

function m1Top(x: number, z: number): number {
  return topY(x, z);
}

function m4Section(z: number): V3[] {
  const xb = L.xTop(z) - 0.003;
  const yb = L.yTop(z) - 0.004;
  const yg = Math.max(yb + 0.0015, z >= DLO_TAIL ? yb + 0.0015 : G.yGlass(z));
  const h = yg - yb;
  const xg = xb - G.tumble * h;
  const bulge = 0.008 * Math.min(1, h / 0.4);
  const p1: [number, number] = [xb - G.tumble * 0.18 * h - bulge * 0.5, yb + 0.18 * h];
  const p2: [number, number] = [xb - G.tumble * 0.58 * h - bulge, yb + 0.58 * h];
  const p3: [number, number] = [xg, yg];
  const yc = G.yCentre(z);
  const xRoof = xg - 0.05;
  const yRoof = yg + 0.042;
  const tr = smoothstep(0.62, 1.05, z);
  const xRear = lerp(0.6, 0.7, smoothstep(0.7, M4_LAST, z));
  const yRear = lerp(yc - 0.026, m1Top(0.7, z) + 0.004, smoothstep(1.1, M4_LAST, z));
  const x5 = lerp(xRoof, xRear, tr);
  const y5 = Math.min(lerp(yRoof, yRear, tr), yc - 0.005);
  const ycap = Math.max(y5 + 0.004, yc);
  const dx = x5 - p3[0];
  const dy = y5 - p3[1];
  const dl = Math.hypot(dx, dy) || 1;
  const bulge4 = 0.008 * Math.min(1, dl / 0.08);
  const p4: [number, number] = [p3[0] + dx * 0.42 + (dy / dl) * bulge4, p3[1] + dy * 0.42 - (dx / dl) * bulge4];
  const pts: [number, number][] = [[xb, yb], p1, p2, p3, p4, [x5, y5], [x5 * 0.52, lerp(ycap, y5, 0.2)], [0, ycap]];
  const wf = 1 - smoothstep(M4_FIRST, -0.6, z);
  const wr = smoothstep(1.1, M4_LAST, z);
  return pts.map(([x, y], k) => {
    const zz = z + wf * FRONT_BEND4[k]! + wr * REAR_BEND4[k]!;
    return [x, z > 1.0 && k >= 4 ? Math.max(y, m1Top(x, zz) + 0.003) : y, zz] as V3;
  });
}

// ====================================================================== ribbons (M2 nose / M3 tail)
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
  /** (height, outward offset) for CP0..K.top. */
  profile: readonly (readonly [number, number])[];
  sections: number;
  x0: number;
}

function ribbonSections(spec: RibbonSpec, endCp: readonly V3[], endCurve: (f: number) => V3): V3[][] {
  const J = spec.sections;
  const samples = sampleCurve(
    spec.plan,
    Array.from({ length: J }, (_, j) => (j / (J - 1)) ** 1.15),
    spec.outward,
  );
  return samples.map((smp, j) => {
    if (j === 0) return endCp.map((p) => [p[0], p[1], p[2]] as V3);
    const f = j / (J - 1);
    const blend = smoothstep(0, 0.3, f);
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

// ====================================================================== tubes
/** A round tube along a polyline (cage bars, exhaust, strap edges): rings of `sides`, radius r. */
function tubeMesh(path: readonly V3[], r: number, sides: number, perSeg: number): PanelMesh {
  const pts: V3[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      pts.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
    }
  }
  pts.push(path[path.length - 1]!);
  const rings: V3[][] = [];
  let prevN: V3 | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[Math.min(pts.length - 1, i + 1)]!;
    const o = pts[Math.max(0, i - 1)]!;
    let tx = q[0] - o[0];
    let ty = q[1] - o[1];
    let tz = q[2] - o[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // parallel-transported normal (no twist along the bar)
    let n: V3 = prevN ?? (Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const dp = n[0] * tx + n[1] * ty + n[2] * tz;
    n = [n[0] - dp * tx, n[1] - dp * ty, n[2] - dp * tz];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    prevN = n;
    const bx = ty * n[2] - tz * n[1];
    const by = tz * n[0] - tx * n[2];
    const bz = tx * n[1] - ty * n[0];
    const ring: V3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      ring.push([p[0] + n[0] * c + bx * s, p[1] + n[1] * c + by * s, p[2] + n[2] * c + bz * s]);
    }
    rings.push(ring);
  }
  const m = gridLoftMesh(createLoft(rings, { closedU: true }), sides, rings.length - 1);
  // outward: away from the tube axis (the loft's own orientation is arbitrary)
  let s = 0;
  const N = m.position.length / 3;
  for (let i = 0; i < N; i++) {
    const v = Math.min(pts.length - 1, Math.round((Math.floor(i / (sides + 1)) / Math.max(1, rings.length - 1)) * (pts.length - 1)));
    const c = pts[v]!;
    s += (m.position[3 * i]! - c[0]) * m.normal[3 * i]! + (m.position[3 * i + 1]! - c[1]) * m.normal[3 * i + 1]! + (m.position[3 * i + 2]! - c[2]) * m.normal[3 * i + 2]!;
  }
  return s >= 0 ? m : flipMesh(m);
}

/** A flat strap (ratchet strap / screen wire) along a polyline: width w, thickness th, normal hint `up`. */
function strapMesh(path: readonly V3[], w: number, th: number, up: V3): PanelMesh {
  const parts: PanelMesh[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-6)) continue;
    const t: V3 = [dx / l, dy / l, dz / l];
    // frame: t, side = t × up, normal = side × t
    let sx = t[1] * up[2] - t[2] * up[1];
    let sy = t[2] * up[0] - t[0] * up[2];
    let sz = t[0] * up[1] - t[1] * up[0];
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const nx = sy * t[2] - sz * t[1];
    const ny = sz * t[0] - sx * t[2];
    const nz = sx * t[1] - sy * t[0];
    const box = roundedBoxMesh([0, 0, 0], [w / 2, th / 2, l / 2 + 0.002], Math.min(th / 2, w / 2) * 0.9, { segs: 1 });
    parts.push(
      transformMesh(box, (p) => [c[0] + sx * p[0] + nx * p[1] + t[0] * p[2], c[1] + sy * p[0] + ny * p[1] + t[1] * p[2], c[2] + sz * p[0] + nz * p[1] + t[2] * p[2]]),
    );
  }
  return mergeMeshes(parts);
}

/**
 * A two-sided flat ribbon along a polyline (screen wires): width w across
 * `up` × tangent, front and back faces (seen from outside and from the cab).
 */
function ribbonMesh(path: readonly V3[], w: number, up: V3): PanelMesh {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const tangent: number[] = [];
  const index: number[] = [];
  const n = path.length;
  for (const face of [1, -1]) {
    const base = position.length / 3;
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)]!;
      const b = path[Math.min(n - 1, i + 1)]!;
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let sx = ty * up[2] - tz * up[1];
      let sy = tz * up[0] - tx * up[2];
      let sz = tx * up[1] - ty * up[0];
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const nx = (sy * tz - sz * ty) * face;
      const ny = (sz * tx - sx * tz) * face;
      const nz = (sx * ty - sy * tx) * face;
      const p = path[i]!;
      for (const k of [-0.5, 0.5]) {
        position.push(p[0] + sx * w * k + nx * 0.0008, p[1] + sy * w * k + ny * 0.0008, p[2] + sz * w * k + nz * 0.0008);
        normal.push(nx, ny, nz);
        uv.push(k * w, i * 0.05);
        tangent.push(tx, ty, tz, 1);
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = base + 2 * i;
      // CCW seen along +normal: (a, a+1, a+3), (a, a+3, a+2) for the front; reversed for the back
      if (face > 0) index.push(a, a + 3, a + 1, a, a + 2, a + 3);
      else index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  return orientRibbon({ position, normal, uv, tangent, index });
}
/** Fix the winding of each triangle to agree with its vertex normals (ribbon helper). */
function orientRibbon(m: PanelMesh): PanelMesh {
  const p = m.position;
  const idx = m.index.slice();
  for (let q = 0; q < idx.length; q += 3) {
    const a = idx[q]! * 3;
    const b = idx[q + 1]! * 3;
    const c = idx[q + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const f = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const d = f[0]! * m.normal[a]! + f[1]! * m.normal[a + 1]! + f[2]! * m.normal[a + 2]!;
    if (d < 0) {
      const t = idx[q + 1]!;
      idx[q + 1] = idx[q + 2]!;
      idx[q + 2] = t;
    }
  }
  return { ...m, index: idx };
}

/** A chain: alternating flat oval links along a polyline. */
function chainMesh(a: V3, b: V3, link: number, wire: number): PanelMesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const l = Math.hypot(dx, dy, dz);
  const t: V3 = [dx / l, dy / l, dz / l];
  const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  const n = Math.max(2, Math.round(l / (link * 0.78)));
  const links: PanelMesh[] = [];
  for (let k = 0; k < n; k++) {
    const s = (k + 0.5) / n;
    const c: V3 = [a[0] + dx * s, a[1] + dy * s, a[2] + dz * s];
    const side = k % 2 === 0 ? u : v;
    const ring: V3[] = [];
    const hl = link / 2;
    const hw = link * 0.32;
    for (let q = 0; q <= 8; q++) {
      const ang = (q / 8) * Math.PI * 2;
      const cl = Math.cos(ang);
      const sn = Math.sin(ang);
      const along = Math.sign(cl) * Math.abs(cl) ** 0.7 * hl;
      const across = Math.sign(sn) * Math.abs(sn) ** 0.7 * hw;
      ring.push([c[0] + t[0] * along + side[0] * across, c[1] + t[1] * along + side[1] * across, c[2] + t[2] * along + side[2] * across]);
    }
    links.push(tubeMesh(ring, wire, 4, 1));
  }
  return mergeMeshes(links);
}

// ====================================================================== build
export interface BeaterBuildOptions {
  /** 0 = full detail, 1 ≈ 40 % of the triangles (render LOD1 ≥ 25 m), 2 (LOD2 ≥ 80 m, far shadows). */
  lod: 0 | 1 | 2;
}

const sideBind = (ids: readonly string[], s: 'L' | 'R'): string[] => ids.map((id) => id.replace(/\$/g, s));

/** Panels a LOD2 beater leaves out (seals, handles, chain / strap, small cabin parts, screen wires). */
const LOD2_DROP = /Seal[LR]?$|^handle|^exhaust|^steering$|^chain|^strap|^screen$|^mirrorGlass|^plateFrame$|^cageRear$|^cageDoor/;

/** Weathering shared by most body panels (faded single-stage, road grime, a little rust and peel). */
const BODY: PanelFinish = { solid: true, fade: 0.55, dirt: 0.45, rust: 0.08, holes: 0.2, primer: 0.04 };
const RUSTY_LOW: PanelFinish = { ...BODY, rust: 0.22, holes: 0.35, dirt: 0.6 };
const NUMBER = '47';

export function buildBeaterVisual(opts: BeaterBuildOptions = { lod: 0 }): VehicleVisualDef {
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
    extra: Partial<Pick<PanelDef, 'detach' | 'glass' | 'lights' | 'damageWeight' | 'castShadow' | 'finish'>> = {},
  ): void => {
    if (mesh.index.length === 0) throw new Error(`beater visual: panel ${id} is empty`);
    panels.push({ id, kind, material, surface: toMeshSurface(mesh), bind, detach: null, ...extra });
  };
  const SIDES = ['R', 'L'] as const;
  const perSide = (m: PanelMesh, s: 'L' | 'R'): PanelMesh => (s === 'R' ? m : mirrorMesh(m));

  // ---------------------------------------------------------------- masters
  const m1Loft = createLoft(M1_STATIONS.map(m1Section), { symmetric: true });
  const S1 = createSheet(loftSurface(m1Loft, { displace: flare }), { resolution: 0.085 * rs, maxAngleDeg: 14 * rs });
  const u1 = (k: number): number => m1Loft.uKnots[k]!;
  const m4Loft = createLoft(M4_STATIONS.map(m4Section), { symmetric: true });
  const S4 = createSheet(loftSurface(m4Loft), { resolution: 0.09 * rs, maxAngleDeg: 13 * rs });
  const u4 = (k: number): number => m4Loft.uKnots[k]!;
  const S4lo = createSheet(loftSurface(m4Loft), { resolution: 0.22 * rs, maxAngleDeg: 28 * rs });
  const m1At = (u: number, v: number): V3 => S1.surface.point(u, v, [0, 0, 0]);
  const noseX0 = m1At(u1(4), 0)[0];
  const tailX0 = m1At(u1(4), 1)[0];

  const NOSE_PLAN = smooth2(
    [
      [noseX0, -1.96],
      [noseX0 - 0.004, -1.995],
      [noseX0 - 0.018, -2.04],
      [noseX0 - 0.05, -2.08],
      [noseX0 - 0.11, -2.105],
      [0.55, -2.12],
      [0.3, -2.126],
      [0, -2.128],
    ],
    10,
  );
  const NOSE_OUT = (dx: number, dz: number): P2 => [-dz, dx];
  const noseSecs = ribbonSections(
    {
      plan: NOSE_PLAN,
      outward: NOSE_OUT,
      profile: [
        [0.25, -0.045],
        [0.262, -0.012],
        [0.3, 0.0],
        [0.4, 0.012],
        [0.5, 0.01],
        [0.545, -0.004],
        [0.575, -0.03],
        [0.64, -0.034],
        [0.7, -0.038],
        [0.728, -0.046],
      ],
      sections: 13,
      x0: noseX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 0)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 0),
  );
  const m2Loft = createLoft(noseSecs, { symmetric: true });
  const S2 = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.07 * rs, maxAngleDeg: 12 * rs });
  /** Finer sampling for the small lamp parts (same surface: shared cut lines match). */
  const S2f = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: opts.lod === 2 ? 0.045 : 0.03, maxAngleDeg: 10 * Math.sqrt(rs) });

  const tailSecs = ribbonSections(
    {
      plan: smooth2(
        [
          [tailX0, 1.98],
          [tailX0 - 0.004, 2.015],
          [tailX0 - 0.018, 2.06],
          [tailX0 - 0.05, 2.1],
          [tailX0 - 0.11, 2.13],
          [0.55, 2.148],
          [0.3, 2.155],
          [0, 2.157],
        ],
        10,
      ),
      outward: (dx, dz) => [dz, -dx],
      profile: [
        [0.27, -0.05],
        [0.285, -0.015],
        [0.33, 0.0],
        [0.42, 0.012],
        [0.52, 0.01],
        [0.55, -0.018],
        [0.62, -0.022],
        [0.72, -0.026],
        [0.83, -0.032],
        [0.905, -0.042],
      ],
      sections: 13,
      x0: tailX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 1)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 1),
  );
  const m3Loft = createLoft(tailSecs, { symmetric: true });
  const S3 = createSheet(loftSurface(m3Loft), { resolution: 0.075 * rs, maxAngleDeg: 14 * rs });
  const S3f = createSheet(loftSurface(m3Loft), { resolution: opts.lod === 2 ? 0.045 : 0.03, maxAngleDeg: 10 * Math.sqrt(rs) });

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
  /** Front-view rounded rectangle (|x|, y), > 0 inside. */
  const rrect = (x0: number, x1: number, y0: number, y1: number, r = 0.012): Shape2 =>
    fv((x, y) => {
      const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
      const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
      const inside = Math.min(x - x0, x1 - x, y - y0, y1 - y);
      return dx > 0 && dy > 0 ? r - Math.hypot(dx, dy) : inside;
    });
  // ---------------------------------------------------------------- side-view lines
  const FENDER_LINE: P2[] = [
    [-0.79, -0.2],
    [-0.79, 0.6],
    [-0.785, 1.2],
  ];
  const B_LINE: P2[] = [
    [0.155, -0.2],
    [0.16, 0.6],
    [0.165, 1.2],
  ];
  const REAR_DOOR_LINE: P2[] = [
    [0.975, -0.2],
    [0.975, 0.6],
    [0.975, 1.2],
  ];
  const archF = () => outsideCircle(ZF, ARCH_Y, ARCH_R);
  const archR = () => outsideCircle(ZR, ARCH_Y, ARCH_R);
  const HOOD_REAR: P2[] = [
    [0, -0.97],
    [0.4, -0.96],
    [0.75, -0.945],
    [1.2, -0.935],
  ];
  const WS_BASE: P2[] = [
    [0, -0.88],
    [0.4, -0.87],
    [0.78, -0.84],
    [1.2, -0.83],
  ];
  const REAR_GLASS_BASE: P2[] = [
    [0, 1.31],
    [0.4, 1.3],
    [0.74, 1.27],
    [1.2, 1.25],
  ];
  const TRUNK_FRONT: P2[] = REAR_GLASS_BASE.map(([x, z]) => [x, z + 0.012] as P2);

  // ---------------------------------------------------------------- M1 body panels
  const hoodBind = ['hood_*'];
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), vAbove(S1, 0), planLine(HOOD_REAR, 'front')], { thickness: 0.016, where: (p) => p[2] < -0.8 && p[1] > 0.6 });
    add('hood', 'hood', 'paint', dented('hood', m.mesh), hoodBind, { detach: { attach: 'boundary', minBrokenFraction: 0.85, mode: 'follow' }, finish: { ...BODY, fade: 0.7, peel: 0.3, rust: 0.05, dirt: 0.25 } });
    add('hoodSeal', 'trim', 'rubber', m.seal, hoodBind, { damageWeight: 0, castShadow: false });
  }
  {
    const m = cutC(S1, [uAbove(S1, u1(K.top) + 0.004, 'seam'), planLine(HOOD_REAR, 'rear'), planLine(WS_BASE, 'front', 'seam')], {
      where: (p) => p[2] > -1.0 && p[2] < -0.75 && p[1] > 0.85,
      border: 'seam',
    });
    add('cowl', 'trim', 'trim', m.mesh, ['s5_cw*', 's5_fw_*', 's4_fd_*', 's5_hp_*'], { damageWeight: 0.6 });
  }
  const trunkBind = ['s10_ld*', 's11_ld*', 's12_ld*'];
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), planLine(TRUNK_FRONT, 'rear'), vBelow(S1, 1)], { where: (p) => p[2] > 1.2 && p[1] > 0.85 });
    add('trunk', 'trunk', 'paint', dented('trunk', m.mesh), trunkBind, { finish: { ...BODY, fade: 0.8, peel: 0.25, rust: 0.06, holes: 0.3 } });
    add('trunkSeal', 'trim', 'rubber', m.seal, trunkBind, { damageWeight: 0, castShadow: false });
  }

  const doorFBind = (s: 'L' | 'R') => sideBind(['s5_hp_$', 's5_sl_$', 's5_cw_$', 's6_sl_$', 's6_dm_$', 's6_bt_$', 's7_sl_$', 's7_dm_$', 's7_bt_$'], s);
  const doorRBind = (s: 'L' | 'R') => sideBind(['s7_sl_$', 's7_dm_$', 's7_bt_$', 's8_sl_$', 's8_dm_$', 's8_bt_$', 's9_sl_$', 's9_qm_$', 's9_dk_$'], s);
  const doorNumber = (s: 'L' | 'R'): PanelFinish['number'] => ({ text: NUMBER, center: [s === 'R' ? 0.83 : -0.83, 0.5, -0.4], height: 0.3, color: 0xf3f1e8, axis: 'x', background: 0x1a1a1a });
  for (const s of SIDES) {
    {
      const m = cut(S1, [uBelow(S1, u1(K.hood)), vAbove(S1, 0), vline(FENDER_LINE, 'front'), archF()], { where: (p) => p[2] < -0.7 });
      // the right fender is a junkyard replacement in grey primer
      const fin: PanelFinish = s === 'R' ? { solid: true, primer: 1, rust: 0.18, holes: 0.3, dirt: 0.55 } : RUSTY_LOW;
      add(`fender${s}`, 'fender', 'paint', dented(`fender${s}`, perSide(m.mesh, s)), sideBind(['s1_fd_$', 's1_rh_$', 's1_rl_$', 's2_fd_$', 's2_rh_$', 's2_rl_$', 's3_fd_$', 's3_tw_$', 's3_rh_$', 's3_rl_$', 's4_fd_$', 's4_rh_$', 's4_rl_$', 's5_hp_$', 's5_cw_$', 's5_sl_$'], s), { finish: fin });
    }
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(FENDER_LINE, 'rear'), vline(B_LINE, 'front')], { where: (p) => p[2] > -0.85 && p[2] < 0.25 && p[1] < 1.05 });
      add(`door${s}F`, 'door', 'paint', dented(`door${s}F`, perSide(m.mesh, s)), doorFBind(s), { finish: { ...BODY, rust: 0.12, number: doorNumber(s) } });
      add(`door${s}FSeal`, 'trim', 'rubber', perSide(m.seal, s), doorFBind(s), { damageWeight: 0, castShadow: false });
    }
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(B_LINE, 'rear'), vline(REAR_DOOR_LINE, 'front'), archR()], { where: (p) => p[2] > 0.05 && p[2] < 1.1 && p[1] < 1.05 });
      // the left rear door comes off a maroon donor car
      const fin: PanelFinish = s === 'L' ? { solid: true, color: 0x5e1d1f, fade: 0.45, rust: 0.2, holes: 0.25, dirt: 0.5, peel: 0.1 } : { ...BODY, rust: 0.14 };
      add(`door${s}R`, 'door', 'paint', dented(`door${s}R`, perSide(m.mesh, s)), doorRBind(s), { finish: fin });
      add(`door${s}RSeal`, 'trim', 'rubber', perSide(m.seal, s), doorRBind(s), { damageWeight: 0, castShadow: false });
    }
    {
      // painted sill under the doors: where the rust lives
      const m = cut(S1, [uBelow(S1, u1(K.skirt)), vline(FENDER_LINE, 'rear'), vline(REAR_DOOR_LINE, 'front'), archR()], { where: (p) => p[2] > -0.85 && p[2] < 1.1 && p[1] < 0.4 });
      add(`sill${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['s5_sl_$', 's5_fl_$', 's6_sl_$', 's6_fl_$', 's7_sl_$', 's7_fl_$', 's8_sl_$', 's8_fl_$', 's9_sl_$', 's9_fl_$'], s), {
        finish: { solid: true, fade: 0.5, rust: 0.6, holes: 0.55, dirt: 0.85 },
      });
    }
    {
      const m = cut(S1, [uBelow(S1, u1(K.hood)), vBelow(S1, 1), vline(REAR_DOOR_LINE, 'rear'), archR()], { where: (p) => p[2] > 0.8 });
      add(`quarter${s}`, 'body', 'paint', dented(`quarter${s}`, perSide(m.mesh, s)), sideBind(['s9_sl_$', 's9_qm_$', 's9_dk_$', 's10_rl_$', 's10_rh_$', 's10_tw_$', 's10_qt_$', 's10_ld_$', 's11_rl_$', 's11_rh_$', 's11_qt_$', 's11_ld_$', 's12_rl_$', 's12_rh_$', 's12_qt_$', 's12_ld_$'], s), {
        finish: { ...RUSTY_LOW, rust: 0.3, holes: 0.45 },
      });
    }
  }

  // ---------------------------------------------------------------- greenhouse (M4): roof + pillars, no glass
  const B_FRONT = 0.12;
  const B_REAR = 0.25;
  const dloTop = u4(3);
  const BAND = 0.014;
  {
    const wsHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), p[2] - HEADER_Z), edge: 'hem' };
    const rearHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), REAR_TOP_Z - p[2]), edge: 'hem' };
    const m = cutC(S4, [uAboveBy(S4, dloTop, BAND, 'hem'), vAbove(S4, 0, 'seam'), vBelow(S4, 1, 'seam'), wsHole, rearHole], { border: 'seam' });
    add('roof', 'roof', 'paint', dented('roof', m.mesh), ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*', 's9_qm_*', 's10_ld*', 's10_qt_*', 's11_ld*', 's11_qt_*'], {
      finish: { solid: true, fade: 1, peel: 0.4, rust: 0.06, dirt: 0.15, number: { text: NUMBER, center: [0, 1.4, 0.2], height: 0.62, color: 0x151515, axis: 'y' } },
    });
  }
  for (const s of SIDES) {
    // C-pillar (sail): body colour from the DLO tail back to the deck
    const m = cut(S4, [uBelowBy(S4, dloTop, BAND, 'hem'), zAbove(DLO_TAIL - 0.03, 'seam'), vBelow(S4, 1, 'seam')], { border: 'seam', where: (p) => p[2] > 0.9 });
    add(`sail${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['s8_rf_$', 's8_bt_$', 's9_dk_$', 's9_qm_$', 's10_qt_$', 's10_ld_$', 's11_qt_$', 's11_ld_$'], s), { finish: BODY });
  }
  for (const s of SIDES) {
    // Black window frames: DLO sash band, B-pillar, the empty glass channels.
    const vTail = vAtZ(S4, dloTop, DLO_TAIL - 0.005);
    const band = stripMesh(S4, {
      u0: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) - 0.004),
      u1: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) + BAND + 0.001),
      v0: 0,
      v1: vTail,
      segV: Math.round(60 / rs),
      offset: 0.0006,
    });
    const S4n = opts.lod === 0 ? S4 : createSheet(loftSurface(m4Loft), { resolution: 0.09 * Math.sqrt(rs), maxAngleDeg: 13 * Math.sqrt(rs) });
    const bp = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(B_FRONT, 'hem'), zBelow(B_REAR, 'hem')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0 && p[2] < 0.35 });
    // A-pillar: the strip between the windscreen opening and the side window
    const ap = cut(S4n, [uAbove(S4n, u4(3) + 0.002, 'seam'), uBelow(S4n, u4(5) - 0.002, 'seam'), zBelow(HEADER_Z + 0.02, 'seam')], { offset: 0.0005, border: 'seam', where: (p) => p[2] < -0.1 });
    add(`dloTrim${s}`, 'trim', 'trim', perSide(mergeMeshes([band, bp.mesh, ap.mesh]), s), sideBind(['s5_cw_$', 's6_rf_$', 's6_bt_$', 's7_rf_$', 's7_bt_$', 's8_rf_$', 's8_bt_$', 's9_dk_$', 's9_qm_$', 's10_qt_$'], s), { damageWeight: 0.5, finish: { dirt: 0.3 } });
    const seal = stripMesh(S4, { u0: () => 0, u1: (v) => uAtMetric(S4, v, 0.008), v0: vAtZ(S4, 0, -0.82), v1: vAtZ(S4, 0, DLO_TAIL - 0.01), segV: Math.round(50 / rs), offset: 0.0015 });
    add(`beltSeal${s}`, 'trim', 'rubber', perSide(seal, s), sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_dm_$', 's6_rf_$', 's7_bt_$', 's7_dm_$', 's7_rf_$', 's8_bt_$', 's8_dm_$', 's8_rf_$', 's9_dk_$', 's9_qm_$'], s), { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- windscreen: a steel mesh (diamond wire) in the opening
  {
    const q: V3 = [0, 0, 0];
    const vWs0 = vAtZ(S4, 1, -0.86);
    const vWs1 = vAtZ(S4, 1, HEADER_Z - 0.01);
    const uEdge = u4(5) + 0.004;
    /** Screen point at (s ∈ [−1, 1] across, t ∈ [0, 1] up), pulled 1 cm inside. */
    const at = (s: number, t: number): V3 => {
      const v = lerp(vWs0, vWs1, t);
      const u = lerp(1, uEdge, Math.min(1, Math.abs(s)));
      S4.surface.point(u, v, q);
      return [Math.sign(s) * Math.abs(q[0]), q[1] - 0.006, q[2] + 0.008];
    };
    const wires: PanelMesh[] = [];
    const pitch = opts.lod === 0 ? 0.1 : 0.18;
    const width = opts.lod === 0 ? 0.0035 : 0.007;
    const N = Math.round(2.6 / pitch);
    for (const dir of [1, -1]) {
      for (let k = -N; k <= N; k++) {
        // diagonal lines s = s0 + dir·0.9·t (screen coords), clipped to the screen
        const s0 = k * pitch * 1.1;
        const path: V3[] = [];
        for (let j = 0; j <= 8; j++) {
          const t = j / 8;
          const sv = s0 + dir * 0.9 * t;
          if (sv < -0.985 || sv > 0.985) continue;
          path.push(at(sv, t));
        }
        if (path.length >= 2) wires.push(ribbonMesh(path, width, [0, 0.6, -0.8]));
      }
    }
    // frame: a flat bar round the opening
    const frame: V3[] = [];
    for (let j = 0; j <= 10; j++) frame.push(at(-0.99, j / 10));
    for (let j = 0; j <= 16; j++) frame.push(at(-0.99 + (1.98 * j) / 16, 1));
    for (let j = 10; j >= 0; j--) frame.push(at(0.99, j / 10));
    wires.push(ribbonMesh(frame, 0.02, [0, 0.6, -0.8]));
    add('screen', 'grille', 'mirror', mergeMeshes(wires), ['s5_cw*', 's6_rf*', 's6_bt_*'], { damageWeight: 0.6, castShadow: true, finish: { dirt: 0.35, rust: 0.1 } });
  }

  // ---------------------------------------------------------------- nose (M2): flat face, square lamps, slat grille, bumper
  const bumperFBind = ['s0_*'];
  const lampBind = ['s1_*', 's2_fd_*', 's2_rh_*', 's2_rl_*', 's2_rt'];
  const HL = { x0: 0.44, x1: 0.775, y0: 0.582, y1: 0.704 };
  const GR = { x1: 0.41, y0: 0.582, y1: 0.704 };
  const BUMP_TOP = 0.556;
  const RUB = { y0: 0.4, y1: 0.452 };
  const INTAKE = rrect(-0.32, 0.32, 0.29, 0.365, 0.015);
  const HEAD = rrect(HL.x0, HL.x1, HL.y0, HL.y1, 0.01);
  const GRILLE = rrect(-GR.x1, GR.x1, GR.y0, GR.y1, 0.012);
  {
    // front panel: the body-colour strip between the bumper and the hood edge, round the lamps / grille
    const fp = cutC(S2, [uBelow(S2, 1), vAbove(S2, 0), frontCut(fv((_x, y) => y - BUMP_TOP), 'shut'), frontCut(neg(HEAD), lens), frontCut(neg(GRILLE), 'lip')], { corner: 0.01 });
    add('frontPanel', 'body', 'paint', fp.mesh, lampBind, { finish: { ...BODY, rust: 0.1 } });
    // bumper: below BUMP_TOP, bent at the right end
    const bm = cutC(S2, [frontCut(fv((_x, y) => BUMP_TOP - y), 'shut'), vAbove(S2, 0), frontCut(neg(INTAKE), 'lip')], { corner: 0.015 });
    add('bumperF', 'bumper', 'paint', transformMesh(bm.mesh, bumperBend), bumperFBind, { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' }, finish: { ...BODY, fade: 0.7, rust: 0.18, holes: 0.2, dirt: 0.7 } });
    add('bumperFSeal', 'trim', 'rubber', transformMesh(bm.seal, bumperBend), bumperFBind, { damageWeight: 0, castShadow: false });
    // black rubbing strip across the bumper, proud of the face
    const rub = cutC(S2f, [frontCut(fv((_x, y) => Math.min(y - RUB.y0, RUB.y1 - y)), 'hem'), vAbove(S2f, 0)], { offset: 0.009, border: 'hem', corner: 0.006 });
    add('bumperStrip', 'trim', 'trim', transformMesh(rub.mesh, bumperBend), bumperFBind, { damageWeight: 0.8, finish: { dirt: 0.5 } });
    // intake mesh + grille insert (recessed)
    const im = cutC(S2, [frontCut(offsetIn(INTAKE, 0.012), 'seam')], { offset: -0.03, border: 'seam' });
    const gm = cutC(S2, [frontCut(offsetIn(GRILLE, 0.008), 'seam')], { offset: -0.025, border: 'seam' });
    add('grille', 'grille', 'grille', mergeMeshes([gm.mesh, transformMesh(im.mesh, bumperBend)]), [...bumperFBind, 's1_rh_*', 's2_rt', 's2_rh_*'], { damageWeight: 0.8 });
    // three black grille slats; the top one on the left fell off
    const slats: PanelMesh[] = [];
    const sheetY = (x: number, y: number): V3 => {
      const uv = onFront(S2, x, y);
      return S2.surface.point(uv[0], uv[1], [0, 0, 0]);
    };
    for (const [ys, skipLeft] of [
      [0.612, false],
      [0.643, false],
      [0.674, true],
    ] as const) {
      const x0 = skipLeft ? 0.02 : -GR.x1 + 0.03;
      const x1 = GR.x1 - 0.03;
      const p0 = sheetY(Math.abs(x0), ys);
      const p1 = sheetY(Math.abs(x1), ys);
      slats.push(strapMesh([[x0, p0[1], p0[2] - 0.004], [x1, p1[1], p1[2] - 0.004]], 0.012, 0.006, [0, 0, -1]));
    }
    add('grilleSlats', 'trim', 'trim', mergeMeshes(slats), ['s1_rh_*', 's2_rt', 's2_rh_*', 's2_fd_*'], { damageWeight: 0.8, finish: { dirt: 0.4 } });
    // headlamps: one lens per side (the right one cracked and chipped), chrome-less 90s units
    const hm = cut(S2f, [frontCut(HEAD, lens)], { corner: 0.008, where: (p) => p[0] > 0.3 && p[1] > 0.55 });
    for (const s of SIDES) {
      add(`headlight${s}`, 'light', 'lightHead', perSide(hm.mesh, s), lampBind, { lights: ['head', 'highBeam'], damageWeight: 0.3, finish: { crack: s === 'R' ? 0.85 : 0.25, dirt: 0.35 } });
    }
    // amber indicators in the bumper corners (move with the bent bumper)
    const im2 = cut(S2f, [frontCut(rrect(0.58, 0.72, 0.468, 0.534, 0.006), lens)], { corner: 0.005, where: (p) => p[0] > 0.45 && p[1] > 0.42 && p[1] < 0.58 });
    for (const s of SIDES) {
      add(`indicatorF${s}`, 'light', 'lightIndicator', transformMesh(perSide(im2.mesh, s), bumperBend), bumperFBind, { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3, finish: { dirt: 0.5 } });
    }
  }

  // ---------------------------------------------------------------- tail (M3)
  const TL = { x0: 0.4, x1: 0.792, y0: 0.66, y1: 0.812 };
  const TAIL = rrect(TL.x0, TL.x1, TL.y0, TL.y1, 0.01);
  const RB_TOP = 0.548;
  {
    const rearPanelBind = ['s12_*', 's11_qt_*', 's11_ld*', 's11_rh_*'];
    const up = cutC(S3, [frontCut(fv((_x, y) => y - RB_TOP), 'shut'), vAbove(S3, 0), uBelow(S3, 1), frontCut(neg(TAIL), lens)], { corner: 0.012 });
    add('rearPanel', 'body', 'paint', up.mesh, rearPanelBind, { finish: { ...BODY, rust: 0.16, holes: 0.3, dirt: 0.55 } });
    add('rearPanelSeal', 'trim', 'rubber', up.seal, rearPanelBind, { damageWeight: 0, castShadow: false });
    const b = cutC(S3, [frontCut(fv((_x, y) => RB_TOP - y), 'shut'), vAbove(S3, 0)], { corner: 0.02 });
    add('bumperR', 'bumper', 'trim', b.mesh, ['s13_*'], { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' }, finish: { dirt: 0.6, fade: 0.3 } });
    const rubR = cutC(S3f, [frontCut(fv((_x, y) => Math.min(y - 0.405, 0.452 - y)), 'hem'), vAbove(S3f, 0)], { offset: 0.008, border: 'hem', corner: 0.006 });
    add('bumperRStrip', 'trim', 'trim', rubR.mesh, ['s13_*'], { damageWeight: 0.8 });
    add('bumperRSeal', 'trim', 'rubber', b.seal, ['s13_*'], { damageWeight: 0, castShadow: false });
    // three-section clusters: reverse (inboard, white), tail / brake (red), indicator (outboard, amber)
    const lampBind = ['s12_*', 's11_qt_*', 's11_rh_*'];
    const sec = (x0: number, x1: number) => cutC(S3f, [frontCut(rrect(x0, x1, TL.y0 + 0.004, TL.y1 - 0.004, 0.006), lens)], { corner: 0.006, where: (p) => Math.abs(p[0]) > 0.3 && p[1] > 0.6 });
    const red = sec(0.492, 0.668);
    const rev = sec(TL.x0 + 0.004, 0.484);
    add('taillights', 'light', 'lightTail', red.mesh, lampBind, { lights: ['tail', 'brake'], damageWeight: 0.3, finish: { crack: 0.35, dirt: 0.35 } });
    add('reverseLamps', 'light', 'lightReverse', rev.mesh, lampBind, { lights: ['reverse'], damageWeight: 0.3, finish: { dirt: 0.4 } });
    const half = cut(S3f, [frontCut(rrect(0.676, TL.x1 - 0.006, TL.y0 + 0.004, TL.y1 - 0.004, 0.006), lens)], { corner: 0.006, where: (p) => p[0] > 0.5 && p[1] > 0.6 });
    for (const s of SIDES) {
      add(`indicatorR${s}`, 'light', 'lightIndicator', perSide(half.mesh, s), sideBind(['s12_qt_$', 's12_rh_$', 's12_ld_$', 's11_qt_$', 's11_rh_$'], s), { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3, finish: { dirt: 0.4 } });
    }
    // black cluster housings round the lenses
    const housing = cutC(S3, [frontCut(TAIL, 'seam')], { offset: -0.006, border: 'seam', corner: 0.01, where: (p) => Math.abs(p[0]) > 0.3 && p[1] > 0.6 });
    add('tailHousing', 'light', 'trim', housing.mesh, lampBind, { damageWeight: 0.3 });
    // rusty single exhaust poking out under the left of the bumper
    const ex = tubeMesh(
      [
        [-0.42, 0.24, 1.6],
        [-0.45, 0.235, 1.95],
        [-0.47, 0.245, 2.16],
      ],
      0.024,
      opts.lod === 0 ? 10 : 6,
      opts.lod === 0 ? 4 : 2,
    );
    add('exhaust', 'trim', 'underbody', ex, ['s13_*', 's12_rl_*', 's12_tf'], { damageWeight: 0.6, finish: { rust: 0.7, dirt: 0.6 } });
  }

  // ---------------------------------------------------------------- small exterior parts
  const sideX = (z: number, y: number): number => {
    let best = Infinity;
    let bx = 0.83;
    for (let i = 0; i < S1.P.length; i += 3) {
      if (S1.P[i]! < 0.7) continue;
      const d = Math.hypot(S1.P[i + 2]! - z, S1.P[i + 1]! - y);
      if (d < best) {
        best = d;
        bx = S1.P[i]!;
      }
    }
    return bx;
  };
  {
    // Mirrors: square black 90s units on a triangular base; the right one is gone (base only).
    const housing = roundedBoxMesh([0.93, 1.0, -0.7], [0.075, 0.055, 0.03], 0.018, { segs: SS });
    const glassM = roundedBoxMesh([0.935, 1.0, -0.668], [0.064, 0.046, 0.003], 0.002, { segs: 1 });
    const baseM = roundedBoxMesh([0.84, 0.97, -0.72], [0.025, 0.04, 0.07], 0.012, { segs: SS });
    const stalk = roundedBoxMesh([0.875, 0.985, -0.705], [0.03, 0.012, 0.02], 0.008, { segs: 1 });
    for (const s of SIDES) {
      const bind = sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_dm_$'], s);
      if (s === 'L') {
        const det = { attach: 'boundary', minBrokenFraction: 0.34, mode: 'hide' } as const;
        add('mirrorL', 'mirror', 'trim', perSide(mergeMeshes([housing, stalk]), s), bind, { detach: det, damageWeight: 0.8, finish: { dirt: 0.3 } });
        add('mirrorGlassL', 'mirror', 'mirror', perSide(glassM, s), bind, { detach: det, damageWeight: 0.6, finish: { crack: 0.3 } });
      }
      add(`mirrorBase${s}`, 'trim', 'trim', perSide(baseM, s), bind, { damageWeight: 0.5 });
    }
  }
  {
    // Black pull handles under the waist crease.
    const handle = (z: number): PanelMesh => {
      const y = L.ySh(z) - 0.03;
      return roundedBoxMesh([sideX(z, y) + 0.006, y, z], [0.01, 0.016, 0.075], 0.008, { segs: SS });
    };
    const hf = handle(-0.08);
    const hr = handle(0.82);
    for (const s of SIDES) {
      add(`handle${s}F`, 'trim', 'trim', perSide(hf, s), doorFBind(s), { damageWeight: 0.5 });
      add(`handle${s}R`, 'trim', 'trim', perSide(hr, s), doorRBind(s), { damageWeight: 0.5 });
    }
  }
  {
    // Rear plate on the rear panel between the clusters.
    let lo = 0;
    let hi = 1;
    const p: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      S3.surface.point(mid, 1, p);
      if (p[1] < 0.69) lo = mid;
      else hi = mid;
    }
    const zp = p[2] + 0.006;
    const W = 0.26;
    const H = 0.055;
    const face: PanelMesh = {
      position: [-W, 0.69 - H, zp, W, 0.69 - H, zp, W, 0.69 + H, zp, -W, 0.69 + H, zp],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv: [0, 0, 2 * W, 0, 2 * W, 2 * H, 0, 2 * H],
      tangent: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      index: [0, 1, 2, 0, 2, 3],
    };
    const plateBind = ['s12_*', 's11_qt_*', 's11_ld*', 's11_rh_*'];
    add('plate', 'trim', 'plate', face, plateBind, { damageWeight: 0.6, detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' }, finish: { dirt: 0.55, rust: 0.12 } });
    add('plateFrame', 'trim', 'trim', roundedBoxMesh([0, 0.69, zp - 0.008], [W + 0.008, H + 0.008, 0.004], 0.003, { segs: 1 }), plateBind, { damageWeight: 0.6 });
  }
  {
    // The bent bumper's right end chained up to the radiator support; a yellow ratchet strap on the left.
    const bR = bumperBend([0.69, 0.5, -2.118]);
    const chain = chainMesh([bR[0], bR[1], bR[2] - 0.012], [0.6, 0.742, -1.985], opts.lod === 0 ? 0.034 : 0.06, opts.lod === 0 ? 0.0045 : 0.007);
    add('chainR', 'trim', 'underbody', chain, ['s0_*', 's1_*'], { damageWeight: 0.4, finish: { rust: 0.5, dirt: 0.4 } });
    const strap = strapMesh(
      [
        [-0.37, 0.49, -2.14],
        [-0.365, 0.545, -2.132],
        [-0.36, 0.575, -2.1],
        [-0.355, 0.62, -2.06],
        [-0.35, 0.69, -2.03],
        [-0.34, 0.69, -1.96],
      ],
      0.032,
      0.0025,
      [0, 0.2, -1],
    );
    add('strapL', 'trim', 'caliper', strap, ['s0_*', 's1_*'], { damageWeight: 0.4, finish: { dirt: 0.5 } });
  }

  // ---------------------------------------------------------------- wheel wells, underbody, bay
  {
    const liner = (zc: number): PanelMesh => {
      const arcs: V3[][] = [];
      const wall: V3[][] = [];
      const R = ARCH_R + 0.012;
      for (let k = 0; k <= 16; k++) {
        const a = -0.3 + ((Math.PI + 0.6) * k) / 16;
        const y = ARCH_Y + R * Math.sin(a);
        const z = zc - R * Math.cos(a);
        arcs.push([
          [0.55, y, z],
          [0.69, y, z],
          [0.815, y, z],
        ]);
        wall.push([
          [0.55, ARCH_Y + 0.08 * Math.sin(a), zc - 0.08 * Math.cos(a)],
          [0.55, ARCH_Y + 0.22 * Math.sin(a), zc - 0.22 * Math.cos(a)],
          [0.55, y, z],
        ]);
      }
      return mergeMeshes([orientMesh(gridLoftMesh(createLoft(arcs), 3, 24), [0.7, ARCH_Y, zc], false), orientMesh(gridLoftMesh(createLoft(wall), 2, 24), [0.85, ARCH_Y, zc], false)]);
    };
    const lf = liner(ZF);
    const lr = liner(ZR);
    for (const s of SIDES) {
      add(`linerF${s}`, 'trim', 'underbody', perSide(lf, s), sideBind(['s1_fd_$', 's1_rh_$', 's2_rl_$', 's2_rh_$', 's2_fd_$', 's3_rl_$', 's3_rh_$', 's3_tw_$', 's3_fd_$', 's4_rl_$', 's4_rh_$', 's4_fd_$', 's5_hp_$', 's5_sl_$'], s), { damageWeight: 0, finish: { rust: 0.3, dirt: 0.8 } });
      add(`linerR${s}`, 'trim', 'underbody', perSide(lr, s), sideBind(['s9_sl_$', 's9_qm_$', 's9_fl_$', 's10_rl_$', 's10_rh_$', 's10_tw_$', 's10_qt_$', 's11_rl_$', 's11_rh_$', 's11_qt_$'], s), { damageWeight: 0, finish: { rust: 0.3, dirt: 0.8 } });
    }
    const slab = (c: V3, h: V3): PanelMesh => roundedBoxMesh(c, h, 0.006, { segs: 1 });
    add('underbodyF', 'trim', 'underbody', slab([0, 0.24, -1.5], [0.52, 0.006, 0.45]), ['s1_rl_*', 's2_rl_*', 's2_rs', 's3_rl_*', 's4_rl_*', 's2_rh_*'], { damageWeight: 0 });
    add('underbodyM', 'trim', 'underbody', slab([0, 0.175, 0.16], [0.76, 0.006, 0.86]), ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's9_fl_*', 's9_tn', 's6_sl_*', 's8_sl_*'], { damageWeight: 0 });
    add('underbodyR', 'trim', 'underbody', slab([0, 0.29, 1.6], [0.52, 0.006, 0.45]), ['s10_rl_*', 's10_tf', 's11_rl_*', 's11_tf', 's12_rl_*', 's12_tf', 's10_rh_*'], { damageWeight: 0 });
    add('engine', 'trim', 'underbody', mergeMeshes([roundedBoxMesh([0, 0.56, -1.3], [0.3, 0.17, 0.13], 0.04, { segs: SS }), roundedBoxMesh([0, 0.75, -1.3], [0.22, 0.03, 0.08], 0.02, { segs: SS })]), ['eng_*', 'gbx_*'], { damageWeight: 0.4, finish: { rust: 0.25, dirt: 0.7 } });
    add('radiatorSupport', 'trim', 'underbody', roundedBoxMesh([0, 0.58, -1.86], [0.56, 0.12, 0.02], 0.01, { segs: 1 }), ['s1_*', 's2_*'], { damageWeight: 0 });
    add('firewall', 'trim', 'underbody', roundedBoxMesh([0, 0.74, -0.86], [0.66, 0.17, 0.012], 0.008, { segs: 1 }), ['s4_*', 's5_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- roll cage (safety yellow), seen through the empty windows
  {
    const SIDE_X = 0.7;
    const sides = opts.lod === 0 ? 10 : 6;
    const per = opts.lod === 0 ? 3 : 1;
    const R = 0.021;
    const hoop = (s: number): V3[] => [
      [s * SIDE_X, 0.24, 0.22],
      [s * (SIDE_X + 0.02), 0.82, 0.21],
      [s * 0.62, 1.22, 0.2],
      [s * 0.48, 1.31, 0.2],
    ];
    const hoopTop: V3[] = [
      [-0.48, 1.31, 0.2],
      [0, 1.32, 0.2],
      [0.48, 1.31, 0.2],
    ];
    const main = mergeMeshes([tubeMesh(hoop(1), R, sides, per), tubeMesh(hoop(-1), R, sides, per), tubeMesh(hoopTop, R, sides, per)]);
    add('cageHoop', 'trim', 'caliper', main, ['s7_*', 's6_rf*', 's8_rf*'], { damageWeight: 0.5, finish: { dirt: 0.25, rust: 0.05 } });
    for (const s of SIDES) {
      const sx = s === 'R' ? 1 : -1;
      // A-pillar bar + roof halo to the hoop
      const ab: V3[] = [
        [sx * 0.7, 0.26, -0.64],
        [sx * 0.71, 0.82, -0.66],
        [sx * 0.62, 1.12, -0.46],
        [sx * 0.52, 1.28, -0.22],
        [sx * 0.48, 1.31, 0.2],
      ];
      const door1: V3[] = [
        [sx * 0.75, 0.33, -0.6],
        [sx * 0.76, 0.72, 0.17],
      ];
      const door2: V3[] = [
        [sx * 0.76, 0.74, -0.6],
        [sx * 0.75, 0.34, 0.17],
      ];
      const door3: V3[] = [
        [sx * 0.75, 0.33, 0.25],
        [sx * 0.75, 0.66, 0.95],
      ];
      add(`cageA${s}`, 'trim', 'caliper', tubeMesh(ab, R, sides, per), sideBind(['s5_*', 's6_bt_$', 's6_rf_$', 's6_dm_$', 's7_rf_$', 's7_bt_$'], s), { damageWeight: 0.5, finish: { dirt: 0.25 } });
      add(`cageDoor${s}F`, 'trim', 'caliper', mergeMeshes([tubeMesh(door1, R, sides, 1), tubeMesh(door2, R, sides, 1)]), doorFBind(s), { damageWeight: 0.5, finish: { dirt: 0.3 } });
      add(`cageDoor${s}R`, 'trim', 'caliper', tubeMesh(door3, R, sides, 1), doorRBind(s), { damageWeight: 0.5, finish: { dirt: 0.3 } });
    }
    // rear stays: hoop top back down to the rear bulkhead
    const rear = mergeMeshes(
      [1, -1].map((sx) =>
        tubeMesh(
          [
            [sx * 0.48, 1.31, 0.22],
            [sx * 0.52, 0.98, 0.98],
          ],
          R,
          sides,
          per,
        ),
      ),
    );
    add('cageRear', 'trim', 'caliper', rear, ['s7_rf*', 's8_rf*', 's8_bt_*', 's9_dk*', 's9_qm_*'], { damageWeight: 0.5 });
  }

  // ---------------------------------------------------------------- interior: stripped (dash, wheel, one bucket seat)
  {
    const dashBind = ['s5_*', 's6_dm_*', 's6_bt_*', 's6_sl_*'];
    const floorBind = ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's9_fl_*', 's9_tn', 's6_sl_*', 's8_sl_*'];
    add('floor', 'interior', 'underbody', roundedBoxMesh([0, 0.23, 0.18], [0.76, 0.012, 0.86], 0.01, { segs: 1 }), floorBind, { damageWeight: 0, finish: { rust: 0.35, dirt: 0.8 } });
    const dash = mergeMeshes([
      roundedBoxMesh([0, 0.78, -0.7], [0.76, 0.12, 0.15], 0.03, { segs: SB, rot: rotX(0.08) }),
      roundedBoxMesh([0, 0.88, -0.8], [0.72, 0.04, 0.09], 0.02, { segs: SB }),
      roundedBoxMesh([-0.36, 0.92, -0.6], [0.15, 0.045, 0.06], 0.02, { segs: SB }),
    ]);
    add('dash', 'interior', 'interiorTrim', dash, dashBind, { damageWeight: 0, finish: { dirt: 0.4, crack: 0.2 } });
    const tilt = 0.5;
    const wc: V3 = [-0.36, 0.86, -0.46];
    const torus: V3[][] = [];
    const NR = opts.lod === 0 ? 16 : 12;
    for (let k = 0; k <= NR; k++) {
      const a = (k / NR) * Math.PI * 2;
      const sec: V3[] = [];
      for (let q = 0; q < 8; q++) {
        const b = (q / 8) * Math.PI * 2;
        const r = 0.175 + 0.015 * Math.cos(b);
        sec.push([Math.cos(a) * r, Math.sin(a) * r, 0.015 * Math.sin(b)]);
      }
      torus.push(sec);
    }
    const wheelLocal = mergeMeshes([
      orientMesh(gridLoftMesh(createLoft(torus, { closedU: true }), opts.lod === 0 ? 6 : 4, NR * 2), [0, 0, 0]),
      roundedBoxMesh([0, 0, 0.0], [0.05, 0.05, 0.03], 0.02, { segs: SS }),
      roundedBoxMesh([-0.1, 0, 0], [0.07, 0.014, 0.01], 0.006, { segs: SS }),
      roundedBoxMesh([0.1, 0, 0], [0.07, 0.014, 0.01], 0.006, { segs: SS }),
      roundedBoxMesh([0, 0, -0.12], [0.03, 0.03, 0.1], 0.015, { segs: SS }),
    ]);
    const steering = transformMesh(wheelLocal, (q) => {
      const r = rotX(tilt)(q);
      return [r[0] + wc[0], r[1] + wc[1], r[2] + wc[2]];
    });
    add('steering', 'interior', 'interiorTrim', steering, dashBind, { damageWeight: 0 });
    // racing bucket for the driver (left), nothing else
    const x = -0.36;
    const z = 0.0;
    const seat = mergeMeshes([
      roundedBoxMesh([x, 0.36, z], [0.22, 0.06, 0.24], 0.045, { segs: SS }),
      roundedBoxMesh([x, 0.76, z + 0.27], [0.22, 0.34, 0.05], 0.045, { segs: SB, rot: rotX(-0.22) }),
      roundedBoxMesh([x - 0.2, 0.62, z + 0.2], [0.035, 0.24, 0.12], 0.03, { segs: SS, rot: rotX(-0.22) }),
      roundedBoxMesh([x + 0.2, 0.62, z + 0.2], [0.035, 0.24, 0.12], 0.03, { segs: SS, rot: rotX(-0.22) }),
      roundedBoxMesh([x, 1.12, z + 0.36], [0.12, 0.08, 0.05], 0.035, { segs: SB, rot: rotX(-0.22) }),
    ]);
    add('seatsFront', 'interior', 'interior', seat, ['s6_fl_*', 's6_tn', 's6_sl_*', 's6_dm_*', 's7_fl_*', 's7_tn', 's7_sl_*', 's7_dm_*', 's7_bt_*', 's6_bt_*'], { damageWeight: 0, finish: { dirt: 0.4 } });
    for (const s of SIDES) {
      // stripped door inners: bare metal sheet behind the skins
      const card = (z0: number, z1: number): PanelMesh =>
        roundedBoxMesh([0.79, 0.6, (z0 + z1) / 2], [0.016, 0.26, (z1 - z0) / 2], 0.012, { segs: SS, flat: opts.lod === 0 ? [1, 4, 6] : [1, 2, 3] });
      add(`doorCard${s}F`, 'interior', 'interiorTrim', perSide(card(-0.7, 0.12), s), doorFBind(s), { damageWeight: 0 });
      add(`doorCard${s}R`, 'interior', 'interiorTrim', perSide(card(0.24, 0.92), s), doorRBind(s), { damageWeight: 0 });
    }
    // roof lining only between the windscreen header and the rear-window top (the openings stay open)
    const hl = cutC(S4lo, [uAbove(S4lo, dloTop - 0.01, 'seam'), zAbove(HEADER_Z - 0.01, 'seam'), zBelow(REAR_TOP_Z + 0.01, 'seam'), sideCut({ sd: (_z, y) => y - 1.0 }, 'seam')], { offset: -0.012, border: 'seam' });
    const bpi = cut(S4, [uAbove(S4, 0.004, 'seam'), uBelow(S4, dloTop, 'seam'), zAbove(B_FRONT, 'seam'), zBelow(B_REAR, 'seam')], { offset: -0.03, border: 'seam', where: (p) => p[2] > 0 && p[2] < 0.35 });
    // parcel shelf + the rear bulkhead (rear seat removed): close the cabin off from the trunk
    add('parcelShelf', 'interior', 'interiorTrim', roundedBoxMesh([0, 0.93, 1.17], [0.68, 0.012, 0.14], 0.01, { segs: 1 }), ['s9_dk*', 's9_qm_*', 's10_ld*', 's10_qt_*'], { damageWeight: 0, finish: { dirt: 0.4 } });
    add('rearBulkhead', 'interior', 'underbody', roundedBoxMesh([0, 0.58, 1.05], [0.72, 0.34, 0.01], 0.008, { segs: 1 }), ['s9_*', 's8_fl_*', 's8_sl_*'], { damageWeight: 0, finish: { rust: 0.2, dirt: 0.6 } });
    add('headliner', 'interior', 'interior', flipMesh(mergeMeshes([hl.mesh, bpi.mesh, mirrorMesh(bpi.mesh)])), ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*', 's10_ld*', 's11_ld*'], { damageWeight: 0, castShadow: false });
  }

  return {
    vehicle: 'beater',
    panels: opts.lod === 2 ? panels.filter((p) => !LOD2_DROP.test(p.id)) : panels,
    paint: { ...BEATER_PAINT },
    wheels: {
      rim: { style: 'steel', spokes: 6, spokeWidth: 0.9, dish: 0.035, lip: 0.01, finish: 'black', boltCount: 4 },
      tire: { tread: 'street', sidewallText: 'RETREAD 175/70R14', bulge: 0.1 },
      brake: { discRadius: 0.12, caliperColor: CAGE_COLOR },
    },
    plate: 'JNK 47',
  };

  /** Shrink a front-view region inward by d (> 0 inside). */
  function offsetIn(s: Shape2, d: number): Shape2 {
    return { sd: (a, b) => s.sd(a, b) - d };
  }
  /** (u, v) on a nose / tail sheet at front-view (|x|, y): Newton from a coarse guess. */
  function onFront(sheet: Sheet, x: number, y: number): [number, number] {
    let best: [number, number] = [0.5, 0.5];
    let bd = Infinity;
    const q: V3 = [0, 0, 0];
    for (let i = 0; i <= 12; i++)
      for (let j = 0; j <= 12; j++) {
        sheet.surface.point(i / 12, j / 12, q);
        const d = Math.hypot(Math.abs(q[0]) - x, q[1] - y);
        if (d < bd) {
          bd = d;
          best = [i / 12, j / 12];
        }
      }
    let [u, v] = best;
    for (let it = 0; it < 30; it++) {
      sheet.surface.point(u, v, q);
      const ex = Math.abs(q[0]) - x;
      const ey = q[1] - y;
      if (Math.hypot(ex, ey) < 1e-7) break;
      const h = 1e-5;
      const qa: V3 = [0, 0, 0];
      const qb: V3 = [0, 0, 0];
      sheet.surface.point(Math.min(1, u + h), v, qa);
      sheet.surface.point(u, Math.min(1, v + h), qb);
      const a = (Math.abs(qa[0]) - Math.abs(q[0])) / h;
      const c = (qa[1] - q[1]) / h;
      const b = (Math.abs(qb[0]) - Math.abs(q[0])) / h;
      const d = (qb[1] - q[1]) / h;
      const det = a * d - b * c;
      if (!(Math.abs(det) > 1e-12)) break;
      u = Math.min(1, Math.max(0, u - (d * ex - b * ey) / det));
      v = Math.min(1, Math.max(0, v - (-c * ex + a * ey) / det));
    }
    return [u, v];
  }
}

/** The beater's full-detail visual definition (LOD0). */
export const BEATER_VISUAL: VehicleVisualDef = buildBeaterVisual({ lod: 0 });

/** Interior door inners follow their door skins (binder.ts bindFollower), as the sedan's door cards. */
export const BEATER_FOLLOW: Readonly<Record<string, string>> = {
  doorCardRF: 'doorRF',
  doorCardRR: 'doorRR',
  doorCardLF: 'doorLF',
  doorCardLR: 'doorLR',
};

setVisualExtras(BEATER_VISUAL, {
  lods: [once(() => buildBeaterVisual({ lod: 1 })), once(() => buildBeaterVisual({ lod: 2 }))],
  follow: BEATER_FOLLOW,
});
setFinishExtras(BEATER_VISUAL, {
  lamps: 'classic',
  worn: true,
  arches: [
    { z: ZF, y: ARCH_Y, r: ARCH_R, xMin: 0.7 },
    { z: ZR, y: ARCH_Y, r: ARCH_R, xMin: 0.7 },
  ],
});
