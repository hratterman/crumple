/**
 * SEDAN visual definition (A1): the body surfaces, panels, glass, lamps,
 * trim and a simple interior that wrap the physics lattice of
 * src/sim/vehicle/defs/sedan.ts (wheelbase 2.75, track 1.56, 0.32 m tyres,
 * stations s0 (z −2.30) … s13 (z +2.40), hood sub-rig hood_{0..3}{L,C,R}).
 *
 * PURE DATA, generated once at module load (deterministic). The body is
 * cut from four MASTER surfaces so every shut line, highlight and crease
 * is continuous across panels:
 *   M1 body      sections along z from the front clip to the tail, u from
 *                the rocker's underside up the side (skirt crease, door
 *                face, shoulder crease, belt / fender-top corner) over the
 *                hood / tonneau / deck to the centre line. The end sections
 *                bend in plan view (hood front edge, ducktail). Flares: an
 *                analytic ring displacement around each arch.
 *   M4 greenhouse  belt → side glass → roof rail → roof centre, from the
 *                windscreen base (bent, on the cowl) to the rear-glass base
 *                on the deck (fastback C-pillar).
 *   M2 nose      a ribbon round the front: u chin → hood front edge, v from
 *                the fender front edge round the corner to x = 0; its first
 *                section and top rail ARE M1's front edge.
 *   M3 tail      the same at the back (bumper, lamps, rear panel).
 * Panels are rounded intersections of cuts on those sheets (loft.ts
 * cutPanel): param windows, side-view door / arch lines, top-view hood and
 * cowl edges, front-view lamp / grille / intake outlines. Shut lines are
 * real 4 mm gaps with rolled edges, flanges and black seal backing.
 *
 * Binding: each panel binds only the rig nodes that carry it (hood → hood
 * sub-rig, doors → their hinge / B-pillar / C-pillar frame, bumpers → the
 * bumper bulkheads s0 / s13 and must stay within 0.3 m of them
 * (FLEX_MAX_ABS_C), lamps → crash-can tips + radiator support, ...).
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
import type { BeamSelector, GlassSpec, MaterialSlot, PanelDef, PanelKind, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { once, setVisualExtras } from '../lods';

// ====================================================================== rig-matched dimensions
/** Asserted against compileVehicle(SEDAN) by sedan.test.ts. */
export const SEDAN_DIMS = {
  axleFrontZ: -1.375,
  axleRearZ: 1.375,
  halfTrack: 0.78,
  hubY: 0.32,
  tyreRadius: 0.32,
  /** Wheel-arch opening radius (lip), centred just above the hub. */
  archRadius: 0.374,
  archLift: 0.012,
} as const;

const ZF = SEDAN_DIMS.axleFrontZ;
const ZR = SEDAN_DIMS.axleRearZ;
const ARCH_Y = SEDAN_DIMS.hubY + SEDAN_DIMS.archLift;
const ARCH_R = SEDAN_DIMS.archRadius;

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
 * Every feature line as a function of z (forward −Z), REST pose (the car
 * settles ~3 cm). The front clip ends at z −2.03 on the side (the nose
 * takes over); hood front edge at z −2.10 … −2.17.
 */
const L = {
  /** Rocker / fender underside edge. */
  yBot: pchip([
    [-2.1, 0.285],
    [-1.85, 0.275],
    [-1.0, 0.19],
    [-0.8, 0.178],
    [0.8, 0.178],
    [1.0, 0.19],
    [1.85, 0.3],
    [2.15, 0.31],
  ]),
  /** Skirt crease height above yBot. */
  skirt: pchip([
    [-2.1, 0.06],
    [-1.0, 0.075],
    [1.0, 0.075],
    [2.15, 0.06],
  ]),
  /** Body side reference half width (plan view). */
  xSide: pchip([
    [-2.04, 0.836],
    [-1.92, 0.857],
    [-1.7, 0.873],
    [-1.375, 0.879],
    [-0.9, 0.88],
    [0, 0.881],
    [0.9, 0.881],
    [1.375, 0.881],
    [1.75, 0.876],
    [1.98, 0.862],
    [2.12, 0.844],
  ]),
  /** Shoulder crease height (rises gently toward the tail). */
  ySh: pchip([
    [-2.04, 0.66],
    [-1.8, 0.69],
    [-1.5, 0.716],
    [-1.2, 0.746],
    [-0.8, 0.77],
    [0, 0.788],
    [1.0, 0.804],
    [1.6, 0.814],
    [2.12, 0.82],
  ]),
  /** Top corner (fender-top roll / belt / deck corner) height. */
  yTop: pchip([
    [-2.04, 0.728],
    [-1.9, 0.762],
    [-1.64, 0.828],
    [-1.28, 0.896],
    [-1.0, 0.93],
    [-0.88, 0.948],
    [-0.7, 0.958],
    [0, 0.966],
    [0.8, 0.974],
    [1.1, 0.982],
    [1.4, 0.99],
    [2.0, 0.99],
    [2.12, 0.984],
  ]),
  xTop: pchip([
    [-2.04, 0.79],
    [-1.85, 0.832],
    [-1.5, 0.848],
    [-1.0, 0.853],
    [0, 0.855],
    [1.0, 0.854],
    [1.5, 0.848],
    [1.95, 0.83],
    [2.12, 0.808],
  ]),
  /** Hood / deck shut-line half width (CP9). */
  xHood: pchip([
    [-2.04, 0.705],
    [-1.75, 0.735],
    [-1.3, 0.748],
    [-0.95, 0.755],
    [0, 0.76],
    [1.2, 0.755],
    [1.7, 0.75],
    [2.12, 0.725],
  ]),
  /** Height at the hood / deck shut line; the hood rides ≈1.5 cm over the hood nodes (y 0.72 / 0.84 / 0.92 / 0.96 at z −2.0 / −1.64 / −1.28 / −0.92). */
  yHood: pchip([
    [-2.04, 0.762],
    [-2.0, 0.769],
    [-1.64, 0.858],
    [-1.28, 0.93],
    [-0.92, 0.967],
    [-0.8, 0.974],
    [0, 0.98],
    [1.0, 0.988],
    [1.4, 0.995],
    [1.8, 0.999],
    [2.12, 0.996],
  ]),
  /** Hood / trunk power-dome lift (0..1). */
  dome: pchip([
    [-2.1, 1],
    [-1.1, 1],
    [-0.95, 0],
    [1.4, 0],
    [1.6, 1],
    [2.2, 1],
  ]),
  /** Centre crown above the shut-line height. */
  crown: pchip([
    [-2.04, 0.03],
    [-1.6, 0.036],
    [-1.0, 0.03],
    [-0.8, 0.02],
    [1.1, 0.02],
    [1.4, 0.024],
    [2.12, 0.02],
  ]),
};

/**
 * Power-dome crease lines: outer (lower) and inner (upper) x of the step, and its lift. On the hood
 * the two creases converge toward the grille and the step is taller and tighter (crisper); the
 * trunk keeps the original parallel pair.
 */
const hoodW = (z: number): number => smoothstep(-0.98, -1.12, z);
const creaseX = (z: number): number => lerp(0.375, 0.282, smoothstep(-1.05, -2.05, z));
const creaseW = (z: number): number => lerp(0.03, 0.022, hoodW(z));
const domeLift = (z: number): number => lerp(0.004, 0.0065, hoodW(z)) * L.dome(z);

/** M1 top including the power-dome lift (≈ the evaluated M1 deck), for parts that sit on it. */
function m1Top(x: number, z: number): number {
  const xc = creaseX(z);
  return topY(x, z) + domeLift(z) * (1 - smoothstep(xc - creaseW(z), xc, Math.abs(x)));
}

/** M1 top surface height (hood / tonneau / deck) at (x, z), consistent with CP9..11. */
function topY(x: number, z: number): number {
  const xh = L.xHood(z);
  const t = Math.min(1, Math.abs(x) / xh);
  return L.yHood(z) + L.crown(z) * (1 - t * t);
}

// ====================================================================== M1 body master
/** M1 control-point indices of the feature lines. */
const K = { skirt: 2, shoulder: 6, top: 9, hood: 10 } as const;
const FRONT_BEND = [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.03, -0.07, -0.108, -0.112, -0.14];
const REAR_BEND = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.15, 0.192, 0.196, 0.215];
const M1_FRONT = -2.03;
const M1_REAR = 2.11;
const M1_STATIONS = [
  -2.03, -2.0, -1.95, -1.87, -1.77, -1.65, -1.52, -1.375, -1.23, -1.1, -0.99, -0.9, -0.83, -0.7, -0.5, -0.25, 0, 0.25, 0.5, 0.72, 0.9, 1.05, 1.18, 1.3,
  1.42, 1.55, 1.7, 1.83, 1.95, 2.04, 2.09, 2.11,
];

const fenderW = (z: number): number => 1 - smoothstep(-0.95, -0.6, z);

function m1Section(z: number): V3[] {
  const xs = L.xSide(z);
  const yb = L.yBot(z);
  const ysk = yb + L.skirt(z);
  const ysh = L.ySh(z);
  const yt = L.yTop(z);
  const pts: [number, number][] = [
    [xs - 0.075, yb - 0.004],
    [xs - 0.022, yb + 0.008],
    [xs - 0.003, ysk],
    [xs + 0.0025, lerp(ysk, ysh, 0.3)],
    [xs + 0.009, lerp(ysk, ysh, 0.7)],
    [xs + 0.0115, ysh - 0.026],
    [xs + 0.0108, ysh],
    [xs + 0.0035, ysh + 0.016],
    // Front fenders: the upper side keeps leaning in up to the top corner (a vertical band there
    // mirrors the dark horizon as a stripe along the fender top).
    [lerp(xs - 0.024, lerp(xs + 0.0035, L.xTop(z), 0.5), fenderW(z)), lerp(ysh, yt, 0.55)],
    [L.xTop(z), yt],
    [L.xHood(z), L.yHood(z)],
    // Power-dome crease: a step that lifts the centre of the hood (and trunk).
    [creaseX(z), topY(creaseX(z), z)],
    [creaseX(z) - creaseW(z), topY(creaseX(z) - creaseW(z), z) + domeLift(z)],
    [0, L.yHood(z) + L.crown(z) + domeLift(z)],
  ];
  const wf = 1 - smoothstep(M1_FRONT, -1.78, z);
  const wr = smoothstep(1.83, M1_REAR, z);
  // Ducktail: the deck kicks up toward its rear edge.
  const kick = 0.024 * smoothstep(1.9, M1_REAR, z) ** 2.5;
  return pts.map(([x, y], k) => [x, y + (k >= K.top ? kick * (k === K.top ? 0.5 : 1) : 0), z + wf * FRONT_BEND[k]! + wr * REAR_BEND[k]!] as V3);
}

/** Arch flares: ring displacement just outside each arch lip, fading below the shoulder and toward the top. */
function flare(p: V3): void {
  const ax = Math.abs(p[0]);
  if (ax < 0.7) return;
  const hf = smoothstep(0.76, 0.85, ax);
  const sh = L.ySh(p[2]);
  const vf = 1 - smoothstep(sh - 0.075, sh - 0.02, p[1]);
  if (hf * vf <= 0) return;
  let dx = 0;
  for (const [zc, amp, w0, w1] of [
    [ZF, 0.016, 0.03, 0.17],
    [ZR, 0.024, 0.04, 0.24],
  ] as const) {
    const d = Math.hypot(p[2] - zc, p[1] - ARCH_Y);
    dx += amp * (1 - smoothstep(ARCH_R + w0, ARCH_R + w0 + w1, d));
  }
  p[0] += Math.sign(p[0]) * dx * hf * vf;
}

// ====================================================================== M4 greenhouse master
const M4_FIRST = -0.9;
const M4_LAST = 1.78;
const M4_STATIONS = [-0.9, -0.85, -0.78, -0.68, -0.57, -0.45, -0.33, -0.22, -0.08, 0.1, 0.3, 0.48, 0.62, 0.74, 0.86, 0.96, 1.05, 1.13, 1.2, 1.27, 1.36, 1.46, 1.56, 1.64, 1.71, 1.78];
const G = {
  /** DLO top: A-pillar line, roof rail, C-pillar sweep down to the belt at z 1.0. */
  yGlass: pchip([
    [-0.9, 0.95],
    [-0.75, 1.055],
    [-0.6, 1.16],
    [-0.45, 1.262],
    [-0.33, 1.338],
    [-0.2, 1.377],
    [0.05, 1.39],
    [0.32, 1.386],
    [0.5, 1.372],
    [0.66, 1.338],
    [0.82, 1.272],
    [0.96, 1.185],
    [1.08, 1.095],
    [1.18, 1.025],
    [1.24, 0.99],
  ]),
  /** Centre line: windscreen base → header → roof crown → rear glass → deck. */
  yCentre: pchip([
    [-0.97, 0.99],
    [-0.64, 1.225],
    [-0.4, 1.39],
    [-0.27, 1.447],
    [-0.1, 1.469],
    [0.1, 1.476],
    [0.35, 1.471],
    [0.58, 1.455],
    [0.76, 1.426],
    [0.95, 1.352],
    [1.15, 1.258],
    [1.35, 1.163],
    [1.52, 1.092],
    [1.65, 1.05],
    [1.78, 1.03],
  ]),
  /** Side-glass tumblehome (Δx per Δy). */
  tumble: 0.5,
};
const FRONT_BEND4 = [0, 0, 0, 0, -0.004, -0.008, -0.05, -0.07];
const REAR_BEND4 = [-0.02, -0.02, -0.02, -0.02, -0.01, 0, 0.035, 0.05];
/** Windscreen header z (glass top) and rear-glass top z. */
const HEADER_Z = -0.3;
const REAR_TOP_Z = 0.78;
/** DLO tail (C-pillar front) z and the rear-door / quarter-window divider. */
const DLO_TAIL = 1.24;
const Q_FRONT = 0.996;
const Q_REAR = 1.046;

function m4Section(z: number): V3[] {
  const xb = L.xTop(z) - 0.003;
  const yb = L.yTop(z) - 0.004;
  const yg = Math.max(yb + 0.0015, z >= DLO_TAIL ? yb + 0.0015 : G.yGlass(z));
  const h = yg - yb;
  const xg = xb - G.tumble * h;
  const bulge = 0.016 * Math.min(1, h / 0.42);
  const p1: [number, number] = [xb - G.tumble * 0.18 * h - bulge * 0.5, yb + 0.18 * h];
  const p2: [number, number] = [xb - G.tumble * 0.58 * h - bulge, yb + 0.58 * h];
  const p3: [number, number] = [xg, yg];
  const yc = G.yCentre(z);
  // Windscreen edge (A-pillar inner edge) / roof edge / rear-glass edge: follows the centre line
  // (cross-section drop) once the DLO top falls away into the C-pillar.
  const xRoof = xg - 0.068;
  const yRoof = yg + 0.05;
  const tr = smoothstep(0.45, 0.95, z);
  const xRear = lerp(0.572, 0.7, smoothstep(0.6, M4_LAST, z));
  const yRear = lerp(yc - 0.034, m1Top(0.7, z) + 0.004, smoothstep(1.5, M4_LAST, z));
  const x5 = lerp(xRoof, xRear, tr);
  const y5 = Math.min(lerp(yRoof, yRear, tr), yc - 0.006);
  const ycap = Math.max(y5 + 0.004, yc);
  const dx = x5 - p3[0];
  const dy = y5 - p3[1];
  const dl = Math.hypot(dx, dy) || 1;
  const bulge4 = 0.012 * Math.min(1, dl / 0.08);
  const p4: [number, number] = [p3[0] + dx * 0.42 + (dy / dl) * bulge4, p3[1] + dy * 0.42 - (dx / dl) * bulge4];
  const pts: [number, number][] = [[xb, yb], p1, p2, p3, p4, [x5, y5], [x5 * 0.52, lerp(ycap, y5, 0.27)], [0, ycap]];
  const wf = 1 - smoothstep(M4_FIRST, -0.55, z);
  const wr = smoothstep(1.45, M4_LAST, z);
  // Never dip under the deck the rear glass sits on.
  return pts.map(([x, y], k) => {
    const zz = z + wf * FRONT_BEND4[k]! + wr * REAR_BEND4[k]!;
    return [x, z > 1.2 && k >= 4 ? Math.max(y, m1Top(x, zz) + 0.003) : y, zz] as V3;
  });
}

// ====================================================================== ribbons (M2 nose / M3 tail)
/** Arc-length samples of a plan polyline (x, z) with OUTWARD unit normals. */
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
  /** Outward normal from the travel direction. */
  outward: (dx: number, dz: number) => P2;
  /** (height, outward offset) for CP0..K.top. */
  profile: readonly (readonly [number, number])[];
  sections: number;
  /** Side-end x of the plan curve (offsets of the M1 profile are taken relative to it). */
  x0: number;
}

/** Ribbon sections: section 0 = M1 end section CP0..9, top rail = M1 end curve u9..1; the face blends in over the first ~30 %. */
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

// ====================================================================== build
export interface SedanBuildOptions {
  /** 0 = full detail, 1 ≈ 40 % of the triangles (render LOD1 ≥ 25 m), 2 ≈ 20 % (LOD2 ≥ 80 m, far shadows). */
  lod: 0 | 1 | 2;
}

/** Glass-class beams of the sedan rig (cw–rf, bt–rf, rf–dk across consecutive stations, pillars excluded). */
const GLASS_BEAMS = {
  windscreen: [
    ['s5_cw', 's6_rf'],
    ['s5_cw', 's6_rf_L'],
    ['s5_cw', 's6_rf_R'],
  ],
  rear: [
    ['s8_rf_R', 's9_dk'],
    ['s8_rf_L', 's9_dk'],
    ['s8_rf', 's9_dk'],
    ['s8_rf', 's9_dk_L'],
    ['s8_rf', 's9_dk_R'],
  ],
  sideFront: (s: 'L' | 'R') => [
    [`s6_bt_${s}`, `s7_rf_${s}`],
    [`s6_rf_${s}`, `s7_bt_${s}`],
  ],
  sideRear: (s: 'L' | 'R') => [
    [`s7_bt_${s}`, `s8_rf_${s}`],
    [`s7_rf_${s}`, `s8_bt_${s}`],
  ],
} as const;
const pairs = (p: readonly (readonly string[])[]): BeamSelector => ({ pairs: p.map((q) => [q[0]!, q[1]!] as const) });
const sideBind = (ids: readonly string[], s: 'L' | 'R'): string[] => ids.map((id) => id.replace(/\$/g, s));

/** Panels a LOD2 sedan leaves out (seals, handles, exhaust, small cabin parts behind the glass). */
const LOD2_DROP = /Seal[LR]?$|^handle|^exhaust|^steering$|^console$|^parcelShelf$|^mirrorGlass|^reflectors$|^plateFrame$/;

export function buildSedanVisual(opts: SedanBuildOptions = { lod: 0 }): VehicleVisualDef {
  const rs = opts.lod === 0 ? 1 : opts.lod === 1 ? 2.9 : 5.2;
  /** Rounded-box edge segments for explicit parts (big / small). */
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
    if (mesh.index.length === 0) throw new Error(`sedan visual: panel ${id} is empty`);
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
  /** Coarse sampling of M4 for hidden interior parts (headliner). */
  const S4lo = createSheet(loftSurface(m4Loft), { resolution: 0.22 * rs, maxAngleDeg: 28 * rs });
  const m1At = (u: number, v: number): V3 => S1.surface.point(u, v, [0, 0, 0]);
  /** Ribbon plan curves start on M1's end sections at the door-face control point. */
  const noseX0 = m1At(u1(4), 0)[0];
  const tailX0 = m1At(u1(4), 1)[0];

  const NOSE_PLAN = smooth2(
    [
      [noseX0, -2.03],
      [noseX0 - 0.004, -2.085],
      [noseX0 - 0.022, -2.15],
      [noseX0 - 0.062, -2.215],
      [noseX0 - 0.14, -2.27],
      [0.55, -2.312],
      [0.3, -2.334],
      [0, -2.341],
    ],
    10,
  );
  const NOSE_OUT = (dx: number, dz: number): P2 => [-dz, dx];
  const noseSecs = ribbonSections(
    {
      plan: NOSE_PLAN,
      outward: NOSE_OUT,
      profile: [
        [0.25, -0.05],
        [0.265, -0.012],
        [0.31, 0.0],
        [0.385, 0.004],
        [0.47, -0.004],
        [0.535, -0.02],
        [0.6, -0.042],
        [0.655, -0.066],
        [0.705, -0.094],
        [0.745, -0.125],
      ],
      sections: 13,
      x0: noseX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 0)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 0),
  );
  const m2Loft = createLoft(noseSecs, { symmetric: true });
  const S2 = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.08 * rs, maxAngleDeg: 12 * rs });
  /** Finer sampling of the ribbons for the small lamp parts (identical surface, so shared cut lines match). */
  const S2f = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.045 * Math.sqrt(rs), maxAngleDeg: 10 * Math.sqrt(rs) });

  const tailSecs = ribbonSections(
    {
      plan: smooth2(
        [
          [tailX0, 2.11],
          [tailX0 - 0.005, 2.165],
          [tailX0 - 0.026, 2.23],
          [tailX0 - 0.068, 2.29],
          [tailX0 - 0.145, 2.343],
          [0.55, 2.388],
          [0.3, 2.414],
          [0, 2.423],
        ],
        10,
      ),
      outward: (dx, dz) => [dz, -dx],
      profile: [
        [0.29, -0.065],
        [0.305, -0.022],
        [0.36, 0.01],
        [0.45, 0.024],
        [0.562, 0.02],
        [0.625, -0.014],
        [0.74, -0.03],
        [0.84, -0.055],
        [0.925, -0.085],
        [0.985, -0.115],
      ],
      sections: 13,
      x0: tailX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 1)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 1),
  );
  const m3Loft = createLoft(tailSecs, { symmetric: true });
  const S3 = createSheet(loftSurface(m3Loft), { resolution: 0.09 * rs, maxAngleDeg: 14 * rs });
  const S3f = createSheet(loftSurface(m3Loft), { resolution: 0.045 * Math.sqrt(rs), maxAngleDeg: 10 * Math.sqrt(rs) });

  // ---------------------------------------------------------------- cut helpers
  const lip: EdgeStyle = { inset: 0.002, roll: 0.003, wall: 0.025, segments: 1, seal: false };
  /** Lamp lens against a body panel: a full shut gap, small roll. */
  const lens: EdgeStyle = { inset: VISUAL_DEFAULTS.shutGap / 2 + 0.0015, roll: 0.0015, wall: 0.005, segments: 1, seal: false };
  interface CutOpts {
    corner?: number;
    offset?: number;
    thickness?: number;
    /** Grid limit: nodes whose rest position satisfies this (performance only; the cuts define the outline). */
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
  /** Side-view line through (z, y) points listed bottom → top; keep 'front' (smaller z) or 'rear'. */
  const vline = (pts: P2[], keep: 'front' | 'rear', edge: Cut['edge'] = 'shut'): Cut => {
    const sh = polyShape(smooth2(pts, 8), false);
    return sideCut(keep === 'front' ? sh : neg(sh), edge);
  };
  /** Plan-view (x, z) line listed from x = 0 outward; keep 'front' or 'rear'. */
  const planLine = (pts: P2[], keep: 'front' | 'rear', edge: Cut['edge'] = 'shut'): Cut => {
    const sh = polyShape(smooth2(pts, 8), false);
    return topCut(keep === 'rear' ? sh : neg(sh), edge);
  };
  /** Keep u at least `m` metres beyond u0 (metric along u). */
  const uAboveBy = (sheet: Sheet, u0: number, m: number, edge: Cut['edge']): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u, v) - sheet.metricU(u0, v)) * sheet.skew(u, v) - m, edge });
  const uBelowBy = (sheet: Sheet, u1: number, m: number, edge: Cut['edge']): Cut => ({ fn: (_p, u, v) => (sheet.metricU(u1, v) - sheet.metricU(u, v)) * sheet.skew(u, v) + m, edge });
  /** v on `sheet` at which the surface point at u has z = z0 (bisection; z increases with v). */
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
  /** Front-view (|x|, y) region from an inside-positive function. */
  const fv = (sd: (x: number, y: number) => number): Shape2 => ({ sd: (x, y) => sd(Math.abs(x), y) });

  // ---------------------------------------------------------------- side-view lines
  const FENDER_LINE: P2[] = [
    [-0.866, -0.2],
    [-0.866, 0.6],
    [-0.866, 1.2],
  ];
  const B_LINE: P2[] = [
    [0.105, -0.2],
    [0.122, 0.6],
    [0.14, 1.2],
  ];
  // Rear door rear edge: straight down to the rear arch, whose front quarter the door's lower corner forms.
  const REAR_DOOR_LINE: P2[] = [
    [1.016, -0.2],
    [1.018, 0.6],
    [1.02, 1.2],
  ];
  const archF = () => outsideCircle(ZF, ARCH_Y, ARCH_R);
  const archR = () => outsideCircle(ZR, ARCH_Y, ARCH_R);
  const HOOD_REAR: P2[] = [
    [0, -1.04],
    [0.4, -1.02],
    [0.75, -0.975],
    [1.2, -0.95],
  ];
  const WS_BASE: P2[] = [
    [0, -0.97],
    [0.4, -0.95],
    [0.78, -0.905],
    [1.2, -0.88],
  ];
  const REAR_GLASS_BASE: P2[] = [
    [0, 1.83],
    [0.4, 1.815],
    [0.74, 1.78],
    [1.2, 1.75],
  ];
  /** The trunk lid's front shut sits just behind the rear-glass base. */
  const TRUNK_FRONT: P2[] = REAR_GLASS_BASE.map(([x, z]) => [x, z + 0.012] as P2);
  const FUEL: [number, number, number] = [1.66, 0.79, 0.085];
  /** Taillight wrap onto the quarter (side view): a wedge tapering forward from the tail. */
  const Q_LAMP: Shape2 = { sd: (z, y) => Math.min(z - 1.93, 0.93 - y, y - lerp(0.9, 0.772, smoothstep(1.93, 2.1, z))) };

  // ---------------------------------------------------------------- M1 body panels
  const hoodBind = ['hood_*'];
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), vAbove(S1, 0), planLine(HOOD_REAR, 'front')], { thickness: 0.018, where: (p) => p[2] < -0.85 && p[1] > 0.6 });
    add('hood', 'hood', 'paint', m.mesh, hoodBind, { detach: { attach: 'boundary', minBrokenFraction: 0.85, mode: 'follow' } });
    add('hoodSeal', 'trim', 'rubber', m.seal, hoodBind, { damageWeight: 0, castShadow: false });
  }
  {
    const m = cutC(S1, [uAbove(S1, u1(K.top) + 0.004, 'seam'), planLine(HOOD_REAR, 'rear'), planLine(WS_BASE, 'front', 'seam')], {
      where: (p) => p[2] > -1.1 && p[2] < -0.8 && p[1] > 0.85,
      border: 'seam',
    });
    add('cowl', 'trim', 'trim', m.mesh, ['s5_cw*', 's5_fw_*', 's4_fd_*', 's5_hp_*'], { damageWeight: 0.6 });
  }
  const trunkBind = ['s10_ld*', 's11_ld*', 's12_ld*'];
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), planLine(TRUNK_FRONT, 'rear'), vBelow(S1, 1)], { where: (p) => p[2] > 1.35 && p[1] > 0.85 });
    add('trunk', 'trunk', 'paint', m.mesh, trunkBind);
    add('trunkSeal', 'trim', 'rubber', m.seal, trunkBind, { damageWeight: 0, castShadow: false });
  }

  for (const s of SIDES) {
    {
      const m = cut(S1, [uBelow(S1, u1(K.hood)), vAbove(S1, 0), vline(FENDER_LINE, 'front'), archF()], { where: (p) => p[2] < -0.75 });
      add(`fender${s}`, 'fender', 'paint', perSide(m.mesh, s), sideBind(['s1_fd_$', 's1_rh_$', 's1_rl_$', 's2_fd_$', 's2_rh_$', 's2_rl_$', 's3_fd_$', 's3_tw_$', 's3_rh_$', 's3_rl_$', 's4_fd_$', 's4_rh_$', 's4_rl_$', 's5_hp_$', 's5_cw_$', 's5_sl_$'], s));
    }
    const doorF = sideBind(['s5_hp_$', 's5_sl_$', 's5_cw_$', 's6_sl_$', 's6_dm_$', 's6_bt_$', 's7_sl_$', 's7_dm_$', 's7_bt_$'], s);
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(FENDER_LINE, 'rear'), vline(B_LINE, 'front')], { where: (p) => p[2] > -0.95 && p[2] < 0.25 && p[1] < 1.05 });
      add(`door${s}F`, 'door', 'paint', perSide(m.mesh, s), doorF);
      add(`door${s}FSeal`, 'trim', 'rubber', perSide(m.seal, s), doorF, { damageWeight: 0, castShadow: false });
    }
    const doorR = sideBind(['s7_sl_$', 's7_dm_$', 's7_bt_$', 's8_sl_$', 's8_dm_$', 's8_bt_$', 's9_sl_$', 's9_qm_$', 's9_dk_$'], s);
    {
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(B_LINE, 'rear'), vline(REAR_DOOR_LINE, 'front'), archR()], { where: (p) => p[2] > 0 && p[2] < 1.15 && p[1] < 1.05 });
      add(`door${s}R`, 'door', 'paint', perSide(m.mesh, s), doorR);
      add(`door${s}RSeal`, 'trim', 'rubber', perSide(m.seal, s), doorR, { damageWeight: 0, castShadow: false });
    }
    {
      const m = cut(S1, [uBelow(S1, u1(K.skirt)), vline(FENDER_LINE, 'rear'), vline(REAR_DOOR_LINE, 'front'), archR()], { where: (p) => p[2] > -0.95 && p[2] < 1.1 && p[1] < 0.4 });
      add(`sill${s}`, 'body', 'trim', perSide(m.mesh, s), sideBind(['s5_sl_$', 's5_fl_$', 's6_sl_$', 's6_fl_$', 's7_sl_$', 's7_fl_$', 's8_sl_$', 's8_fl_$', 's9_sl_$', 's9_fl_$'], s));
    }
    const quarterBind = sideBind(['s9_sl_$', 's9_qm_$', 's9_dk_$', 's10_rl_$', 's10_rh_$', 's10_tw_$', 's10_qt_$', 's10_ld_$', 's11_rl_$', 's11_rh_$', 's11_qt_$', 's11_ld_$', 's12_rl_$', 's12_rh_$', 's12_qt_$', 's12_ld_$'], s);
    {
      const cuts: Cut[] = [uBelow(S1, u1(K.hood)), vBelow(S1, 1), vline(REAR_DOOR_LINE, 'rear'), archR(), sideCut(neg(Q_LAMP), lens)];
      if (s === 'R') cuts.push(outsideCircle(FUEL[0], FUEL[1], FUEL[2], 'shut'));
      const m = cut(S1, cuts, { where: (p) => p[2] > 0.8 });
      add(`quarter${s}`, 'body', 'paint', perSide(m.mesh, s), quarterBind);
      if (s === 'R') {
        const f = cut(S1, [sideCut({ sd: (z, y) => FUEL[2] - Math.hypot(z - FUEL[0], y - FUEL[1]) }, 'shut')], { where: (p) => Math.abs(p[2] - FUEL[0]) < 0.15 && Math.abs(p[1] - FUEL[1]) < 0.15 });
        add('fuelDoor', 'trim', 'paint', f.mesh, quarterBind, { detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
      }
    }
  }

  // ---------------------------------------------------------------- greenhouse (M4)
  const B_FRONT = 0.07;
  /** Black mirror sail closes the DLO's front tip up to here. */
  const SAIL_Z = -0.69;
  const B_REAR = 0.205;
  const dloTop = u4(3);
  /** Black sash band above the DLO top, m. */
  const BAND = 0.016;
  {
    const wsHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), p[2] - HEADER_Z), edge: 'hem' };
    const rearHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), REAR_TOP_Z - p[2]), edge: 'hem' };
    const m = cutC(S4, [uAboveBy(S4, dloTop, BAND, 'hem'), vAbove(S4, 0, 'seam'), vBelow(S4, 1, 'seam'), wsHole, rearHole], { border: 'seam' });
    add('roof', 'roof', 'paint', m.mesh, ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*', 's9_qm_*', 's10_ld*', 's10_qt_*', 's11_ld*', 's11_qt_*']);
  }
  for (const s of SIDES) {
    const m = cut(S4, [uBelowBy(S4, dloTop, BAND, 'hem'), zAbove(DLO_TAIL - 0.04, 'seam'), vBelow(S4, 1, 'seam')], { border: 'seam', where: (p) => p[2] > 1.1 });
    add(`sail${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['s8_rf_$', 's8_bt_$', 's9_dk_$', 's9_qm_$', 's10_qt_$', 's10_ld_$', 's11_qt_$', 's11_ld_$'], s));
  }
  const glassSpec = (laminated: boolean, beams: BeamSelector): GlassSpec => ({
    laminated,
    beams,
    crackStrain: laminated ? 0.015 : 0.025,
    shatterStrain: laminated ? 0.05 : 0.045,
    crackImpulse: laminated ? 120 : 160,
    shatterImpulse: laminated ? 600 : 380,
    shatterBrokenFraction: 0.34,
  });
  const glassOpts = { castShadow: false, damageWeight: 0 } as const;
  {
    const m = cutC(S4, [uAbove(S4, u4(5) - 0.004, 'seam'), zBelow(HEADER_Z + 0.004, 'seam'), vAbove(S4, 0, 'seam')], { offset: -0.006, border: 'seam', where: (p) => p[2] < -0.2 });
    add('windscreen', 'glass', 'glass', m.mesh, ['s5_cw*', 's6_rf*', 's6_bt_*'], { ...glassOpts, glass: glassSpec(true, pairs(GLASS_BEAMS.windscreen)) });
  }
  {
    const m = cutC(S4, [uAbove(S4, u4(5) - 0.004, 'seam'), zAbove(REAR_TOP_Z - 0.004, 'seam'), vBelow(S4, 1, 'seam')], { offset: -0.006, border: 'seam', where: (p) => p[2] > 0.5 });
    add('rearGlass', 'glass', 'glass', m.mesh, ['s8_rf*', 's9_dk*', 's8_bt_*', 's10_ld*', 's11_ld*'], { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.rear)) });
  }
  for (const s of SIDES) {
    const dlo: Cut[] = [uAboveBy(S4, 0, 0.003, 'seam'), uBelowBy(S4, dloTop, 0.006, 'seam')];
    const fg = cut(S4, [...dlo, zBelow(B_FRONT + 0.03, 'seam'), zAbove(SAIL_Z - 0.02, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] < 0.2 });
    add(`glass${s}F`, 'glass', 'glass', perSide(fg.mesh, s), sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_rf_$', 's7_bt_$', 's7_rf_$'], s), { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.sideFront(s))) });
    const rg = cut(S4, [...dlo, zAbove(B_REAR - 0.03, 'seam'), zBelow(Q_FRONT + 0.03, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] > 0.1 && p[2] < 1.1 });
    add(`glass${s}R`, 'glass', 'glass', perSide(rg.mesh, s), sideBind(['s7_bt_$', 's7_rf_$', 's8_bt_$', 's8_rf_$', 's9_dk_$', 's9_qm_$'], s), { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.sideRear(s))) });
    // Fixed quarter window behind the rear door.
    const qg = cut(S4, [...dlo, zAbove(Q_REAR - 0.03, 'seam'), zBelow(DLO_TAIL - 0.035, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] > 0.9 && p[2] < 1.35 });
    add(`glass${s}Q`, 'glass', 'glass', perSide(qg.mesh, s), sideBind(['s8_bt_$', 's8_rf_$', 's9_dk_$', 's9_qm_$', 's10_qt_$', 's10_ld_$'], s), {
      ...glassOpts,
      glass: glassSpec(false, pairs([[`s8_bt_${s}`, `s9_dk_${s}`], [`s8_rf_${s}`, `s9_dk_${s}`]])),
    });
    // Black DLO sash band + B-pillar + quarter-window divider.
    const vTail = vAtZ(S4, dloTop, DLO_TAIL - 0.005);
    const band = stripMesh(S4, {
      u0: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) - 0.004),
      u1: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) + BAND + 0.001),
      v0: 0,
      v1: vTail,
      segV: Math.round(70 / rs),
      offset: 0.0006,
    });
    // the B-pillar / quarter divider are narrow cuts: a coarse LOD sheet zigzags their edges, so they keep a finer one
    const S4n = opts.lod === 0 ? S4 : createSheet(loftSurface(m4Loft), { resolution: 0.09 * Math.sqrt(rs), maxAngleDeg: 13 * Math.sqrt(rs) });
    const bp = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(B_FRONT, 'hem'), zBelow(B_REAR, 'hem')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0 && p[2] < 0.3 });
    const sail = cut(S4, [uAbove(S4, 0.002, 'seam'), uBelow(S4, dloTop, 'seam'), zBelow(SAIL_Z, 'hem'), vAbove(S4, 0, 'seam')], { offset: 0.0005, border: 'seam', where: (p) => p[2] < -0.55 });
    const qd = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(Q_FRONT, 'hem'), zBelow(Q_REAR, 'hem')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0.9 && p[2] < 1.15 });
    add(`dloTrim${s}`, 'trim', 'trim', perSide(mergeMeshes([band, bp.mesh, sail.mesh, qd.mesh]), s), sideBind(['s5_cw_$', 's6_rf_$', 's6_bt_$', 's7_rf_$', 's7_bt_$', 's8_rf_$', 's8_bt_$', 's9_dk_$', 's9_qm_$', 's10_qt_$'], s), { damageWeight: 0.5 });
    const seal = stripMesh(S4, { u0: () => 0, u1: (v) => uAtMetric(S4, v, 0.008), v0: vAtZ(S4, 0, -0.86), v1: vAtZ(S4, 0, 0.99), segV: Math.round(60 / rs), offset: 0.0015 });
    add(`beltSeal${s}`, 'trim', 'rubber', perSide(seal, s), sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_dm_$', 's6_rf_$', 's7_bt_$', 's7_dm_$', 's7_rf_$', 's8_bt_$', 's8_dm_$', 's8_rf_$', 's9_dk_$', 's9_qm_$'], s), { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- ribbon helpers
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
  /** v on the ribbon where the point at height y reaches |x| = x0 (x decreases with v). */
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
  /** v on the nose ribbon where the point at height y reaches z = z0 (z decreases with v). */
  const vAtZy = (sheet: Sheet, y: number, z0: number): number => {
    let lo = 0;
    let hi = 1;
    const q: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      sheet.surface.point(uAtY(sheet, mid, y), mid, q);
      if (q[2] > z0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const frontProj = (p: V3): P2 => [Math.abs(p[0]), p[1]];
  /**
   * (u, v) on a nose sheet at front-view (|x|, y): Newton warm-started from the previous solution
   * (callers walk small parts point by point), bisection guess when that does not converge.
   */
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
  /** Smooth (rounded) minimum of signed distances, the same rounding cutPanel applies between cuts. */
  const rmin = (r: number, ...a: number[]): number => {
    let g = a[0]!;
    for (let k = 1; k < a.length; k++) {
      const b = a[k]!;
      g = b < r && g < r ? r - Math.hypot(r - b, r - g) : Math.min(b, g);
    }
    return g;
  };

  /**
   * A strip conforming to a nose sheet along a front-view path (|x|, y)(t), t ∈ [0, 1]: `lifts` is the
   * cross profile (normal offsets at evenly spaced stations from −half to +half across the path).
   */
  const frontStrip = (sheet: Sheet, path: (t: number) => P2, half: number, n: number, lifts: readonly number[]): PanelMesh => {
    const nI = lifts.length - 1;
    return surfacePatch(
      sheet,
      nI,
      n,
      (i, j) => {
        const t = j / n;
        const c = path(t);
        const a = path(Math.max(0, t - 1e-3));
        const b = path(Math.min(1, t + 1e-3));
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const off = lerp(-half, half, i / nI);
        const [u, v] = onFront(sheet, c[0] - ((b[1] - a[1]) / l) * off, c[1] + ((b[0] - a[0]) / l) * off);
        return { u, v, lift: lifts[i]! };
      },
      { smoothNormals: true },
    );
  };

  // ---------------------------------------------------------------- nose (M2)
  // Front view (|x|, y). Slim, raked headlamps tucked under the hood edge (dark housing, two
  // projectors, an LED light guide along the bottom that hooks up the outer corner, a bright brow
  // line; the tail wraps onto the fender to a point) and a slim upper grille between them form one
  // dark band under the hood edge, split only by shut gaps on the rake lines. Below: one wide, low
  // mouth (honeycomb) split by raked body-colour fins into a centre intake and two vertical corner
  // intakes with LED indicator strips; air-curtain slots on the corners; a black chin with a
  // protruding splitter blade.
  const bumperFBind = ['s0_*'];
  const lampBind = ['s1_*', 's2_fd_*', 's2_rh_*', 's2_rl_*', 's2_rt'];
  const LAMP_Y0 = 0.672;
  const RAKE: [P2, P2] = [
    [0.468, LAMP_Y0],
    [0.384, 0.786],
  ];
  /** Signed distance to the lamp's inner rake line, outboard positive. */
  const rake = (x: number, y: number): number => {
    const [[x0, y0], [x1, y1]] = RAKE;
    const dx = x1 - x0;
    const dy = y1 - y0;
    return ((x - x0) * dy - (y - y0) * dx) / Math.hypot(dx, dy);
  };
  /** x of the rake line at height y. */
  const rakeX = (y: number): number => RAKE[0][0] + ((y - RAKE[0][1]) * (RAKE[1][0] - RAKE[0][0])) / (RAKE[1][1] - RAKE[0][1]);
  /** Side view: the lamp's top edge falls to a point as it wraps onto the fender. */
  const TAIL_SLOPE = 1.6;
  const tailTop = (z: number): number => LAMP_Y0 + 0.012 + TAIL_SLOPE * (-2.035 - z);
  /** The lamp opening as one region (> 0 inside), open toward the hood and fender edges. */
  const lampShape = (p: V3): number => rmin(0.01, p[1] - LAMP_Y0, rake(Math.abs(p[0]), p[1]), (tailTop(p[2]) - p[1]) / Math.hypot(1, TAIL_SLOPE));
  /** Upper grille bottom: dips toward the centre, meets the lamp bottom at the rake. */
  const ugBot = (x: number): number => LAMP_Y0 - 0.018 * (1 - smoothstep(0.05, 0.46, x));
  /** Upper grille: between the lamps (beyond a shut gap on the rake line), up to the hood edge. */
  const UPPER_GRILLE = fv((x, y) => rmin(0.01, y - ugBot(x), -rake(x, y)));
  /** Lamps + grille as one dark band: the bumper's top edge. */
  const band = (p: V3): number => Math.max(lampShape(p), Math.min(p[1] - ugBot(Math.abs(p[0])), 0.03 - rake(Math.abs(p[0]), p[1])));
  // The mouth: gull-wing top (rising toward the lamps), outer ends raked parallel to the fins.
  const MOUTH_BOT = 0.302;
  const MOUTH_RAKE = 0.36;
  const mouthTop = (x: number): number => 0.512 + 0.075 * smoothstep(0.28, 0.66, x);
  const mouthOuter = (y: number): number => 0.742 - MOUTH_RAKE * (y - MOUTH_BOT);
  const finX = (y: number): number => 0.452 - MOUTH_RAKE * (y - MOUTH_BOT);
  const MOUTH = fv((x, y) => rmin(0.02, (mouthOuter(y) - x) * 0.94, y - MOUTH_BOT, mouthTop(x) - y));
  const CURTAIN = fv((x, y) => rmin(0.004, x - 0.807, 0.823 - x, y - 0.4, 0.57 - y));
  const CHIN = fv((x, y) => Math.min(0.287 - y, 0.83 - x));
  const grow = (sh: Shape2, d: number): Shape2 => ({ sd: (a, b) => sh.sd(a, b) + d });
  {
    const m = cutC(
      S2,
      [
        uBelow(S2, 1),
        vAbove(S2, 0),
        { fn: (p) => -band(p), edge: 'shut' },
        frontCut(neg(MOUTH), 'lip'),
        frontCut(neg(CURTAIN), 'lip'),
        frontCut(neg(CHIN), 'hem'),
      ],
      { corner: 0.015 },
    );
    add('bumperF', 'bumper', 'paint', m.mesh, bumperFBind, { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    add('bumperFSeal', 'trim', 'rubber', m.seal, bumperFBind, { damageWeight: 0, castShadow: false });
    // Honeycomb inserts recessed behind the openings.
    const ug = cutC(S2, [frontCut(grow(UPPER_GRILLE, -0.006), 'lip'), frontCut(fv((x, y) => y - ugBot(x) + 0.008), 'seam')], { offset: -0.022, border: 'seam' });
    const mo = cutC(S2, [frontCut(grow(MOUTH, 0.012), 'seam')], { offset: -0.03, border: 'seam' });
    add('grille', 'grille', 'grille', mergeMeshes([ug.mesh, mo.mesh]), bumperFBind, { damageWeight: 0.8 });
    // Body-colour fins in the mouth (thinner than a sheet cell: conforming strips whose sides fall
    // back to the honeycomb).
    const finY = (t: number): number => lerp(MOUTH_BOT - 0.012, mouthTop(0.4) + 0.012, t);
    const fin = frontStrip(S2, (t) => [finX(finY(t)), finY(t)], 0.024, opts.lod === 0 ? 8 : 4, [-0.027, -0.007, -0.001, 0, -0.001, -0.007, -0.027]);
    add('intakeFins', 'bumper', 'paint', mergeMeshes([fin, mirrorMesh(fin)]), bumperFBind, { damageWeight: 1 });
    // Two gloss slats across the upper grille, stopping short of the lamp rake.
    const slats: PanelMesh[] = [];
    for (const ys of [0.695, 0.728]) {
      const xEnd = rakeX(ys) - 0.022;
      slats.push(frontStrip(S2, (t) => [xEnd * (1 - t), ys], 0.0055, opts.lod === 0 ? 12 : 6, [-0.02, -0.011, -0.01, -0.011, -0.02]));
    }
    const sl = mergeMeshes(slats);
    add('grilleSlats', 'trim', 'trim', mergeMeshes([sl, mirrorMesh(sl)]), bumperFBind, { damageWeight: 0.8 });
    // Black chin, air-curtain ducts and the splitter blade.
    const chin = cutC(S2, [frontCut(CHIN, 'hem')], { border: 'hem', corner: 0.01 });
    const duct = cutC(S2, [frontCut(grow(CURTAIN, 0.008), 'seam')], { offset: -0.022, border: 'seam' });
    const blade: V3[][] = [];
    const nBlade = opts.lod === 0 ? 16 : 10;
    const bladeT = Array.from({ length: nBlade + 1 }, (_, k) => lerp(0.2, 1, k / nBlade));
    for (const smp of sampleCurve(NOSE_PLAN, bladeT, NOSE_OUT)) {
      const x = Math.abs(smp.p[0]);
      const taper = 1 - smoothstep(0.62, 0.76, x);
      const out = 0.014 + 0.038 * taper;
      const y0 = 0.247;
      const y1 = 0.272 - 0.008 * (1 - taper);
      const ring: [number, number][] = [
        [-0.05, y0],
        [out - 0.006, y0],
        [out, y0 + 0.004],
        [out, y1 - 0.003],
        [out - 0.005, y1],
        [-0.05, y1],
      ];
      blade.push(ring.map(([r, y]) => [smp.p[0] + smp.n[0] * r, y, smp.p[1] + smp.n[1] * r] as V3));
    }
    const bladeM = gridLoftMesh(createLoft(blade, { closedU: true }), opts.lod === 0 ? 9 : 6, nBlade, { capStart: true });
    add('splitter', 'trim', 'trim', mergeMeshes([chin.mesh, duct.mesh, bladeM, mirrorMesh(bladeM)]), bumperFBind, { damageWeight: 0.8 });

    // Headlamps: housing (dark), light guide + projectors + brow (the lit lens, A3 lamp shader), chrome bezels.
    const housing = cutC(S2, [{ fn: (p) => lampShape(p), edge: lens }, uBelow(S2, 1), vAbove(S2, 0)], { corner: 0.01, offset: -0.004, where: (p) => p[1] > 0.6 && p[0] > 0.3 });
    add('headlampHousing', 'light', 'trim', housing.mesh, lampBind, { damageWeight: 0.3 });
    const Y0 = LAMP_Y0 + 0.006;
    const HB = 0.078;
    const hs = 0.2 * HB;
    const yMid = Y0 + hs / 2;
    const xIn = rakeX(yMid) + 0.012;
    const vIn = vAtX(S2f, yMid, xIn);
    const zTail = -2.035 - (Y0 + hs + 0.007 - LAMP_Y0 - 0.012) / TAIL_SLOPE;
    const vTail = vAtZy(S2f, yMid, zTail);
    const nGuide = opts.lod === 0 ? 40 : 18;
    const guide = surfacePatch(
      S2f,
      2,
      nGuide,
      (i, j) => {
        const v = lerp(vTail, vIn, j / nGuide);
        return { u: uAtY(S2f, v, Y0 + (hs * i) / 2), v, lift: i === 1 ? 0.0005 : -0.0015 };
      },
      { smoothNormals: true },
    );
    // Brow: a thin bright line under the hood edge (the top of the lamp box).
    const browX0 = rakeX(Y0 + HB - 0.003) + 0.012;
    const browX1 = 0.745;
    const vb0 = vAtX(S2f, Y0 + HB, browX1);
    const vb1 = vAtX(S2f, Y0 + HB, browX0);
    const nBrow = opts.lod === 0 ? 24 : 10;
    const brow = surfacePatch(
      S2f,
      1,
      nBrow,
      (i, j) => {
        const v = lerp(vb0, vb1, j / nBrow);
        return { u: uAtY(S2f, v, Y0 + HB - 0.0045 * (1 - i)), v, lift: -0.0015 };
      },
      { smoothNormals: true },
    );
    // The lamp shader lays its DRL bands and projector "eyes" out in the (|x|, y) box of every
    // lightHead part: measure it from the parts that span it (guide + brow); leg and projectors sit inside.
    let X0 = Infinity;
    let X1 = -Infinity;
    let YB0 = Infinity;
    let YB1 = -Infinity;
    for (const m of [guide, brow])
      for (let k = 0; k < m.position.length; k += 3) {
        X0 = Math.min(X0, Math.abs(m.position[k]!));
        X1 = Math.max(X1, Math.abs(m.position[k]!));
        YB0 = Math.min(YB0, m.position[k + 1]!);
        YB1 = Math.max(YB1, m.position[k + 1]!);
      }
    const W = X1 - X0;
    const HM = YB1 - YB0;
    // Hook: the light guide turns up the outer corner (the lamp shader's vertical DRL band).
    const legX = [X0 + 0.897 * W, X0 + 0.933 * W];
    const legUV = onFront(S2f, (legX[0]! + legX[1]!) / 2, yMid);
    const legP = S2f.surface.point(legUV[0], legUV[1], [0, 0, 0]);
    const legTop = Math.min(YB0 + 0.72 * HM, tailTop(legP[2]) - 0.012);
    const nLeg = 6;
    const leg = surfacePatch(
      S2f,
      2,
      nLeg,
      (i, j) => {
        const [u, v] = onFront(S2f, lerp(legX[0]!, legX[1]!, i / 2), lerp(yMid, legTop, j / nLeg));
        return { u, v, lift: i === 1 ? 0.0005 : -0.0015 };
      },
      { smoothNormals: true },
    );
    // Projectors at the lamp shader's two "eyes" (centres 34 % / 66 % across, 58 % up; lens + ring = 0.30 HB).
    const rd = 0.3 * HM;
    const eyeY = YB0 + 0.58 * HM;
    const nR = opts.lod === 0 ? 4 : 2;
    const nA = opts.lod === 0 ? 20 : 12;
    const discs: PanelMesh[] = [];
    const bezels: PanelMesh[] = [];
    for (const f of [0.34, 0.66]) {
      const ex = X0 + f * W;
      const polar = (r: number, j: number): [number, number] => onFront(S2f, ex + r * Math.cos((j / nA) * Math.PI * 2), eyeY + r * Math.sin((j / nA) * Math.PI * 2));
      discs.push(
        surfacePatch(
          S2f,
          nR,
          nA,
          (i, j) => {
            const r = (rd * i) / nR;
            const [u, v] = i === 0 ? onFront(S2f, ex, eyeY) : polar(r, j);
            return { u, v, lift: -0.0035 + 0.004 * (1 - (r / rd) ** 2) };
          },
          { closedJ: true, smoothNormals: true },
        ),
      );
      const br = [rd, rd + 0.0022, rd + 0.0048];
      const bl = [-0.0032, -0.0005, -0.0038];
      bezels.push(
        surfacePatch(
          S2f,
          2,
          nA,
          (i, j) => {
            const [u, v] = polar(br[i]!, j);
            return { u, v, lift: bl[i]! };
          },
          { closedJ: true, smoothNormals: true },
        ),
      );
    }
    const lit = mergeMeshes([guide, leg, ...discs, brow]);
    add('headlights', 'light', 'lightHead', mergeMeshes([lit, mirrorMesh(lit)]), lampBind, { lights: ['head', 'highBeam'], damageWeight: 0.3 });
    const bz = mergeMeshes(bezels);
    add('projectorBezels', 'trim', 'chrome', mergeMeshes([bz, mirrorMesh(bz)]), lampBind, { damageWeight: 0.3 });

    // LED indicator strips down the outer wall of the corner intakes.
    const nInd = opts.lod === 0 ? 10 : 5;
    const ind = surfacePatch(
      S2,
      1,
      nInd,
      (i, j) => {
        const y = lerp(MOUTH_BOT + 0.03, mouthTop(0.7) - 0.035, j / nInd);
        const [u, v] = onFront(S2, mouthOuter(y) - 0.018 - 0.007 * i, y);
        return { u, v, lift: -0.014 };
      },
      { smoothNormals: true },
    );
    for (const s of SIDES) add(`indicatorF${s}`, 'light', 'lightIndicator', perSide(ind, s), bumperFBind, { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
  }

  // ---------------------------------------------------------------- tail (M3)
  // Slim L-shaped lamps (top band to the corner, leg down the corner onto the side) joined by a light bar.
  const lampBand = (x: number, y: number): number => Math.min(y - (0.86 + 0.008 * smoothstep(0.42, 0.86, x)), 0.93 - y, x - 0.37);
  const lampLeg = (x: number, y: number): number => Math.min(y - 0.772, 0.93 - y, x - 0.7);
  const LAMP_R = fv((x, y) => Math.max(lampBand(x, y), lampLeg(x, y)));
  const DIFFUSER = fv((x, y) => Math.min(0.74 - x, 0.4 - 0.02 * smoothstep(0.5, 0.74, x) - y));
  const PIPE_X = 0.47;
  const PIPE_Y = 0.335;
  const PIPE = fv((x, y) => 0.05 - Math.hypot((x - PIPE_X) * 0.62, y - PIPE_Y));
  {
    const bumpTop = 0.6;
    const bandCut = (keepAbove: boolean, edge: Cut['edge']): Cut => frontCut({ sd: (_x, y) => (keepAbove ? y - bumpTop : bumpTop - y) }, edge);
    const b = cutC(S3, [bandCut(false, 'shut'), vAbove(S3, 0), frontCut(neg(DIFFUSER), 'hem'), frontCut(neg(PIPE), 'lip')], { corner: 0.02 });
    add('bumperR', 'bumper', 'paint', b.mesh, ['s13_*'], { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    add('bumperRSeal', 'trim', 'rubber', b.seal, ['s13_*'], { damageWeight: 0, castShadow: false });
    const d = cutC(S3, [frontCut(DIFFUSER, 'hem'), frontCut(neg(PIPE), 'lip')], { offset: -0.003, border: 'seam', corner: 0.02 });
    add('diffuser', 'trim', 'trim', d.mesh, ['s13_*'], { damageWeight: 0.8 });
    const rearPanelBind = ['s12_*', 's11_qt_*', 's11_ld*', 's11_rh_*'];
    const up = cutC(S3, [bandCut(true, 'shut'), vAbove(S3, 0), uBelow(S3, 1), frontCut(neg(LAMP_R), 'shut')], { corner: 0.02 });
    add('rearPanel', 'body', 'paint', up.mesh, rearPanelBind);
    add('rearPanelSeal', 'trim', 'rubber', up.seal, rearPanelBind, { damageWeight: 0, castShadow: false });
    const lampBind = ['s12_*', 's11_qt_*', 's11_rh_*'];
    const lamp = cutC(S3f, [frontCut(LAMP_R, lens), vAbove(S3f, 0, 'hem'), frontCut(fv((x, y) => Math.max(0.7 - x, y - 0.81)), 'hem')], { corner: 0.008, where: (p) => p[1] > 0.72 && p[0] > 0.3 });
    const vBar0 = vAtX(S3, 0.895, 0.385);
    const bar = stripMesh(S3, { u0: (v) => uAtY(S3, v, 0.889), u1: (v) => uAtY(S3, v, 0.901), v0: vBar0, v1: 1, segV: 16, offset: 0.0015 });
    const qLamp = cut(S1, [sideCut(Q_LAMP, lens), vBelow(S1, 1, 'hem')], { corner: 0.01, where: (p) => p[2] > 1.85 && p[1] > 0.7 && p[0] > 0.6 });
    add('taillights', 'light', 'lightTail', mergeMeshes([lamp.mesh, bar, mirrorMesh(bar), qLamp.mesh, mirrorMesh(qLamp.mesh)]), [...lampBind, 's12_qt_*', 's12_rh_*'], { lights: ['tail', 'brake'], damageWeight: 0.3 });
    // Reverse lamps: slim strips in the bumper, inboard of the reflectors.
    const rv0 = vAtX(S3, 0.445, 0.555);
    const rv1 = vAtX(S3, 0.445, 0.41);
    const rev = stripMesh(S3, { u0: (v) => uAtY(S3, v, 0.437), u1: (v) => uAtY(S3, v, 0.451), v0: rv0, v1: rv1, segV: 6, offset: 0.0012 });
    add('reverseLamps', 'light', 'lightReverse', mergeMeshes([rev, mirrorMesh(rev)]), ['s13_*'], { lights: ['reverse'], damageWeight: 0.3 });
    const v0r = vAtX(S3, 0.443, 0.8);
    const v1r = vAtX(S3, 0.443, 0.6);
    const refl = stripMesh(S3, { u0: (v) => uAtY(S3, v, 0.437), u1: (v) => uAtY(S3, v, 0.449), v0: v0r, v1: v1r, segV: 8, offset: 0.0012 });
    add('reflectors', 'trim', 'lightTail', mergeMeshes([refl, mirrorMesh(refl)]), ['s13_*'], { damageWeight: 0.3 });
    // Exhaust tips: chrome ovals behind the diffuser cut-outs.
    const tips: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      const secs: V3[][] = [];
      for (const [dz, sc] of [
        [-0.09, 0.92],
        [-0.03, 1],
        [0.015, 1],
        [0.028, 0.95],
      ] as const) {
        const ring: V3[] = [];
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ring.push([sx * PIPE_X + Math.cos(a) * 0.072 * sc, PIPE_Y + Math.sin(a) * 0.042 * sc, 2.375 + dz]);
        }
        secs.push(ring);
      }
      tips.push(gridLoftMesh(createLoft(secs, { closedU: true }), opts.lod === 0 ? 20 : 12, 6, { flip: sx < 0 }));
    }
    add('exhaust', 'trim', 'chrome', mergeMeshes(tips), ['s13_*', 's12_rl_*', 's12_tf'], { damageWeight: 0.6 });
    // Dark tail-pipe bores.
    const bores = [1, -1].map((sx) => roundedBoxMesh([sx * PIPE_X, PIPE_Y, 2.385], [0.062, 0.035, 0.004], 0.03, { segs: 1 }));
    add('exhaustBore', 'trim', 'underbody', mergeMeshes(bores), ['s13_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- lamps: rear indicators
  {
    const indR = cut(S3f, [frontCut(LAMP_R, lens), vAbove(S3f, 0), frontCut(fv((x, y) => Math.min(x - 0.7, 0.81 - y)), 'hem')], { corner: 0.006, where: (p) => p[0] > 0.6 && p[1] > 0.7 });
    for (const s of SIDES) {
      add(`indicatorR${s}`, 'light', 'lightIndicator', perSide(indR.mesh, s), sideBind(['s12_qt_$', 's12_rh_$', 's12_ld_$', 's11_qt_$', 's11_rh_$'], s), { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
    }
  }

  // ---------------------------------------------------------------- small exterior parts
  /** Body side x at (z, y) on the right: nearest M1 grid node (side region). */
  const sideX = (z: number, y: number): number => {
    let best = Infinity;
    let bx = 0.88;
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
  const ring = (cx: number, cy: number, cz: number, ly: number, lz: number, n: number, pFront = 2.3, pBack = 4.5): V3[] => {
    const out: V3[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const pw = c > 0 ? pBack : pFront;
      out.push([cx, cy + ly * Math.sign(sn) * Math.abs(sn) ** (2 / pw), cz + lz * Math.sign(c) * Math.abs(c) ** (2 / pw)]);
    }
    return out;
  };
  const doorFBind = (s: 'L' | 'R') => sideBind(['s5_hp_$', 's5_sl_$', 's5_cw_$', 's6_sl_$', 's6_dm_$', 's6_bt_$', 's7_sl_$', 's7_dm_$', 's7_bt_$'], s);
  const doorRBind = (s: 'L' | 'R') => sideBind(['s7_sl_$', 's7_dm_$', 's7_bt_$', 's8_sl_$', 's8_dm_$', 's8_bt_$', 's9_sl_$', 's9_qm_$', 's9_dk_$'], s);
  {
    // Mirrors: body-colour housing on a stalk from the sail, black base, mirror glass on the rear face.
    const st: [number, number, number, number, number][] = [
      // x, y centre, z centre, half height, half length
      [0.835, 0.992, -0.735, 0.026, 0.055],
      [0.865, 0.996, -0.735, 0.024, 0.048],
      [0.895, 1.008, -0.732, 0.033, 0.054],
      [0.925, 1.022, -0.728, 0.052, 0.07],
      [0.965, 1.026, -0.726, 0.058, 0.075],
      [1.005, 1.026, -0.725, 0.058, 0.075],
      [1.035, 1.024, -0.724, 0.052, 0.069],
      [1.055, 1.021, -0.724, 0.038, 0.054],
      [1.064, 1.019, -0.724, 0.014, 0.022],
    ];
    const housing = orientMesh(
      gridLoftMesh(
        createLoft(
          st.map(([x, y, z, ly, lz]) => ring(x, y, z, ly, lz, 20)),
          { closedU: true },
        ),
        opts.lod === 0 ? 24 : 14,
        opts.lod === 0 ? 10 : 6,
      ),
      [0.97, 1.02, -0.726],
    );
    const glassM = roundedBoxMesh([0.983, 1.025, -0.726 + 0.072], [0.068, 0.046, 0.003], 0.002, { segs: 1 });
    const baseM = roundedBoxMesh([0.84, 0.985, -0.735], [0.02, 0.03, 0.065], 0.012, { segs: SS });
    for (const s of SIDES) {
      const bind = sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_dm_$'], s);
      const det = { attach: 'boundary', minBrokenFraction: 0.34, mode: 'hide' } as const;
      add(`mirror${s}`, 'mirror', 'paint', perSide(housing, s), bind, { detach: det, damageWeight: 0.8 });
      add(`mirrorGlass${s}`, 'mirror', 'mirror', perSide(glassM, s), bind, { detach: det, damageWeight: 0 });
      add(`mirrorBase${s}`, 'trim', 'trim', perSide(baseM, s), bind, { damageWeight: 0.5 });
    }
  }
  {
    // Flush door handles just under the shoulder crease.
    const handle = (z: number): PanelMesh => {
      const y = L.ySh(z) - 0.038;
      return roundedBoxMesh([sideX(z, y) + 0.004, y, z], [0.008, 0.0135, 0.082], 0.007, { segs: SS });
    };
    const hf = handle(-0.06);
    const hr = handle(0.86);
    for (const s of SIDES) {
      add(`handle${s}F`, 'trim', 'chrome', perSide(hf, s), doorFBind(s), { damageWeight: 0.5 });
      add(`handle${s}R`, 'trim', 'chrome', perSide(hr, s), doorRBind(s), { damageWeight: 0.5 });
    }
  }
  {
    // Rear licence plate on the rear panel between the lamps.
    let lo = 0;
    let hi = 1;
    const p: V3 = [0, 0, 0];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      S3.surface.point(mid, 1, p);
      if (p[1] < 0.695) lo = mid;
      else hi = mid;
    }
    const zp = p[2] + 0.007;
    const W = 0.26;
    const H = 0.055;
    const face: PanelMesh = {
      position: [-W, 0.695 - H, zp, W, 0.695 - H, zp, W, 0.695 + H, zp, -W, 0.695 + H, zp],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv: [0, 0, 2 * W, 0, 2 * W, 2 * H, 0, 2 * H],
      tangent: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      index: [0, 1, 2, 0, 2, 3],
    };
    const plateBind = ['s12_*', 's11_qt_*', 's11_ld*', 's11_rh_*'];
    add('plate', 'trim', 'plate', face, plateBind, { damageWeight: 0.6, detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
    add('plateFrame', 'trim', 'trim', roundedBoxMesh([0, 0.695, zp - 0.009], [W + 0.008, H + 0.008, 0.004], 0.003, { segs: 1 }), plateBind, { damageWeight: 0.6 });
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
          [0.6, y, z],
          [0.75, y, z],
          [0.868, y, z],
        ]);
        wall.push([
          [0.6, ARCH_Y + 0.08 * Math.sin(a), zc - 0.08 * Math.cos(a)],
          [0.6, ARCH_Y + 0.25 * Math.sin(a), zc - 0.25 * Math.cos(a)],
          [0.6, y, z],
        ]);
      }
      const ref: V3 = [0.78, ARCH_Y, zc];
      return mergeMeshes([orientMesh(gridLoftMesh(createLoft(arcs), 3, 24), ref, false), orientMesh(gridLoftMesh(createLoft(wall), 2, 24), [0.9, ARCH_Y, zc], false)]);
    };
    const lf = liner(ZF);
    const lr = liner(ZR);
    for (const s of SIDES) {
      add(`linerF${s}`, 'trim', 'underbody', perSide(lf, s), sideBind(['s1_fd_$', 's1_rh_$', 's2_rl_$', 's2_rh_$', 's2_fd_$', 's3_rl_$', 's3_rh_$', 's3_tw_$', 's3_fd_$', 's4_rl_$', 's4_rh_$', 's4_fd_$', 's5_hp_$', 's5_sl_$'], s), { damageWeight: 0 });
      add(`linerR${s}`, 'trim', 'underbody', perSide(lr, s), sideBind(['s9_sl_$', 's9_qm_$', 's9_fl_$', 's10_rl_$', 's10_rh_$', 's10_tw_$', 's10_qt_$', 's11_rl_$', 's11_rh_$', 's11_qt_$'], s), { damageWeight: 0 });
    }
    const slab = (c: V3, h: V3): PanelMesh => roundedBoxMesh(c, h, 0.006, { segs: 1 });
    add('underbodyF', 'trim', 'underbody', slab([0, 0.25, -1.66], [0.56, 0.006, 0.5]), ['s1_rl_*', 's2_rl_*', 's2_rs', 's3_rl_*', 's4_rl_*', 's2_rh_*'], { damageWeight: 0 });
    add('underbodyM', 'trim', 'underbody', slab([0, 0.165, 0.09], [0.8, 0.006, 0.93]), ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's9_fl_*', 's9_tn', 's6_sl_*', 's8_sl_*'], { damageWeight: 0 });
    add('underbodyR', 'trim', 'underbody', slab([0, 0.3, 1.72], [0.56, 0.006, 0.52]), ['s10_rl_*', 's10_tf', 's11_rl_*', 's11_tf', 's12_rl_*', 's12_tf', 's10_rh_*'], { damageWeight: 0 });
    add('engineCover', 'trim', 'trim', roundedBoxMesh([0, 0.82, -1.33], [0.25, 0.065, 0.36], 0.05, { segs: SS }), ['eng_*', 'gbx_*'], { damageWeight: 0.4 });
    add('radiatorSupport', 'trim', 'underbody', roundedBoxMesh([0, 0.63, -2.0], [0.6, 0.1, 0.02], 0.01, { segs: 1 }), ['s1_*', 's2_*'], { damageWeight: 0 });
    add('firewall', 'trim', 'underbody', roundedBoxMesh([0, 0.76, -0.94], [0.7, 0.19, 0.012], 0.008, { segs: 1 }), ['s4_*', 's5_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- interior
  {
    const floorBind = ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's9_fl_*', 's9_tn', 's6_sl_*', 's8_sl_*'];
    const dashBind = ['s5_*', 's6_dm_*', 's6_bt_*', 's6_sl_*'];
    add('carpet', 'interior', 'interior', roundedBoxMesh([0, 0.24, 0.14], [0.79, 0.02, 0.98], 0.015, { segs: 1 }), floorBind, { damageWeight: 0 });
    const dash = mergeMeshes([
      roundedBoxMesh([0, 0.8, -0.76], [0.79, 0.13, 0.17], 0.06, { segs: SB, rot: rotX(0.12) }),
      roundedBoxMesh([0, 0.9, -0.9], [0.74, 0.05, 0.1], 0.03, { segs: SB }),
      roundedBoxMesh([-0.37, 0.955, -0.62], [0.16, 0.04, 0.075], 0.03, { segs: SB, rot: rotX(-0.15) }),
      roundedBoxMesh([0, 0.6, -0.68], [0.14, 0.2, 0.1], 0.04, { segs: SB }),
    ]);
    add('dash', 'interior', 'interiorTrim', dash, dashBind, { damageWeight: 0 });
    // Steering wheel (left-hand drive: driver on −x), tilted 24° back.
    const tilt = 0.42;
    const wc: V3 = [-0.37, 0.89, -0.49];
    const torus: V3[][] = [];
    const NR = opts.lod === 0 ? 16 : 12;
    for (let k = 0; k <= NR; k++) {
      const a = (k / NR) * Math.PI * 2;
      const sec: V3[] = [];
      for (let q = 0; q < 10; q++) {
        const b = (q / 10) * Math.PI * 2;
        const r = 0.185 + 0.017 * Math.cos(b);
        sec.push([Math.cos(a) * r, Math.sin(a) * r, 0.017 * Math.sin(b)]);
      }
      torus.push(sec);
    }
    const wheelLocal = mergeMeshes([
      orientMesh(gridLoftMesh(createLoft(torus, { closedU: true }), opts.lod === 0 ? 6 : 4, NR * 2), [0, 0, 0]),
      roundedBoxMesh([0, -0.01, 0.0], [0.06, 0.045, 0.025], 0.02, { segs: SS }),
      roundedBoxMesh([-0.11, -0.02, 0], [0.07, 0.016, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0.11, -0.02, 0], [0.07, 0.016, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0, -0.11, 0], [0.016, 0.07, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0, 0, -0.12], [0.03, 0.03, 0.1], 0.015, { segs: SS }),
    ]);
    const steering = transformMesh(wheelLocal, (q) => {
      const r = rotX(tilt)(q);
      return [r[0] + wc[0], r[1] + wc[1], r[2] + wc[2]];
    });
    add('steering', 'interior', 'interiorTrim', steering, dashBind, { damageWeight: 0 });
    add('console', 'interior', 'interiorTrim', roundedBoxMesh([0, 0.43, -0.2], [0.115, 0.13, 0.48], 0.04, { segs: SB }), ['s5_tn', 's5_fw_*', 's6_tn', 's6_fl_*', 's7_tn', 's7_fl_*', 's5_fl_*'], { damageWeight: 0 });
    const seat = (x: number, z: number, w: number): PanelMesh =>
      mergeMeshes([
        roundedBoxMesh([x, 0.4, z], [w, 0.07, 0.25], 0.05, { segs: SS }),
        roundedBoxMesh([x, 0.76, z + 0.3], [w, 0.31, 0.065], 0.055, { segs: SB, rot: rotX(-0.3) }),
        roundedBoxMesh([x - w + 0.03, 0.47, z], [0.035, 0.07, 0.24], 0.03, { segs: SS }),
        roundedBoxMesh([x + w - 0.03, 0.47, z], [0.035, 0.07, 0.24], 0.03, { segs: SS }),
        roundedBoxMesh([x, 1.16, z + 0.42], [0.13, 0.085, 0.055], 0.04, { segs: SB, rot: rotX(-0.3) }),
      ]);
    const frontSeatBind = ['s6_fl_*', 's6_tn', 's6_sl_*', 's6_dm_*', 's7_fl_*', 's7_tn', 's7_sl_*', 's7_dm_*', 's7_bt_*', 's6_bt_*'];
    add('seatsFront', 'interior', 'interior', mergeMeshes([seat(-0.38, -0.02, 0.24), seat(0.38, -0.02, 0.24)]), frontSeatBind, { damageWeight: 0 });
    const bench = mergeMeshes([
      roundedBoxMesh([0, 0.41, 0.76], [0.7, 0.08, 0.24], 0.06, { segs: SB }),
      roundedBoxMesh([0, 0.76, 1.03], [0.7, 0.3, 0.07], 0.06, { segs: SB, rot: rotX(-0.36) }),
      roundedBoxMesh([-0.4, 1.05, 1.1], [0.12, 0.05, 0.045], 0.03, { segs: SS, rot: rotX(-0.36) }),
      roundedBoxMesh([0.4, 1.05, 1.1], [0.12, 0.05, 0.045], 0.03, { segs: SS, rot: rotX(-0.36) }),
    ]);
    add('seatsRear', 'interior', 'interior', bench, ['s8_fl_*', 's8_tn', 's8_sl_*', 's8_dm_*', 's9_fl_*', 's9_tn', 's9_sl_*', 's9_qm_*', 's9_dk*', 's8_bt_*'], { damageWeight: 0 });
    add('parcelShelf', 'interior', 'interiorTrim', roundedBoxMesh([0, 0.985, 1.25], [0.7, 0.012, 0.17], 0.01, { segs: 1 }), ['s9_dk*', 's9_qm_*', 's10_ld*', 's10_qt_*'], { damageWeight: 0 });
    for (const s of SIDES) {
      const card = (z0: number, z1: number): PanelMesh =>
        mergeMeshes([
          // subdivided faces: a dented door skin is curved; a card of two big triangles stays a plane
          // between its corners and the skin bulged in past it (the brown patch at 80 km/h)
          roundedBoxMesh([0.815, 0.66, (z0 + z1) / 2], [0.022, 0.3, (z1 - z0) / 2], 0.018, { segs: SS, flat: opts.lod === 0 ? [1, 4, 6] : [1, 2, 3] }),
          roundedBoxMesh([0.775, 0.66, (z0 + z1) / 2 + 0.04], [0.035, 0.022, (z1 - z0) / 2 - 0.1], 0.015, { segs: SS }),
        ]);
      add(`doorCard${s}F`, 'interior', 'interiorTrim', perSide(card(-0.8, 0.09), s), doorFBind(s), { damageWeight: 0 });
      add(`doorCard${s}R`, 'interior', 'interiorTrim', perSide(card(0.16, 0.98), s), doorRBind(s), { damageWeight: 0 });
    }
    // Headliner + pillar trims: the greenhouse frame offset inward, facing in.
    const hl = cutC(S4lo, [uAbove(S4lo, dloTop - 0.01, 'seam'), vAbove(S4lo, 0, 'seam'), vBelow(S4lo, 1, 'seam'), sideCut({ sd: (_z, y) => y - 1.005 }, 'seam')], { offset: -0.014, border: 'seam' });
    const bpi = cut(S4, [uAbove(S4, 0.004, 'seam'), uBelow(S4, dloTop, 'seam'), zAbove(B_FRONT, 'seam'), zBelow(B_REAR, 'seam')], { offset: -0.03, border: 'seam', where: (p) => p[2] > 0 && p[2] < 0.3 });
    add('headliner', 'interior', 'interior', flipMesh(mergeMeshes([hl.mesh, bpi.mesh, mirrorMesh(bpi.mesh)])), ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*', 's10_ld*', 's11_ld*'], { damageWeight: 0, castShadow: false });
  }

  return {
    vehicle: 'sedan',
    // LOD2 (≥ 80 m, far shadows): small parts that are sub-pixel there are left out entirely
    panels: opts.lod === 2 ? panels.filter((p) => !LOD2_DROP.test(p.id)) : panels,
    paint: { color: 0x1f4f9a, metallic: 0.7, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.025, flake: { density: 0.7, scale: 0.6, intensity: 0.7 }, pearl: 0.12 },
    wheels: {
      rim: { style: 'spoke', spokes: 5, spokeWidth: 0.34, dish: 0.035, lip: 0.012, finish: 'gunmetal', boltCount: 5 },
      tire: { tread: 'sport', sidewallText: 'CRUMPLE SPORT', bulge: 0.08 },
      brake: { discRadius: 0.165, caliperColor: 0xb3121a },
    },
    plate: 'CR 4MPL',
  };
}

/** The sedan's full-detail visual definition (LOD0). */
export const SEDAN_VISUAL: VehicleVisualDef = buildSedanVisual({ lod: 0 });

/**
 * Interior door cards follow their door skins (binder.ts bindFollower): the
 * cards bound to the same door nodes with their own triads (built from sill
 * and belt nodes) stayed put while a dented skin folded inward through them
 * (the brown patch of an 80 km/h side hit).
 */
export const SEDAN_FOLLOW: Readonly<Record<string, string>> = {
  doorCardRF: 'doorRF',
  doorCardRR: 'doorRR',
  doorCardLF: 'doorLF',
  doorCardLR: 'doorLR',
};

setVisualExtras(SEDAN_VISUAL, {
  lods: [once(() => buildSedanVisual({ lod: 1 })), once(() => buildSedanVisual({ lod: 2 }))],
  follow: SEDAN_FOLLOW,
});
