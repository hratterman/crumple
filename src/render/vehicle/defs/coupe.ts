/**
 * COUPE visual definition (F1, P6): the "Vortex RS" body, glass, lamps,
 * trim and a 2+2 interior that wrap the physics lattice of
 * src/sim/vehicle/defs/coupe.ts (wheelbase 2.55, track 1.64, 0.33 m tyres,
 * stations s0 (z −2.16) … s12 (z +2.15), hood sub-rig hood_{0..3}{L,C,R}).
 *
 * PURE DATA, generated once at module load (deterministic). Built the same
 * way as the sedan (defs/sedan.ts: four master surfaces, panels cut from
 * them with rounded intersections of cuts, real shut gaps), with the
 * coupe's own design language:
 *   - long, low hood with a raised V8 power bulge faired into the hood
 *     surface (a soft S-shoulder each side, no step), narrowing toward the nose;
 *   - a knife-edge SHOULDER crease running from the headlamp tip over the
 *     front arch, along the long door and up onto a WIDE REAR HAUNCH (the
 *     body widens ~6 cm from the door to the rear arch), with a sculpted
 *     concave door face under it and a side intake scoop ahead of the rear
 *     wheel;
 *   - a fastback greenhouse: steep A-pillar, frameless door glass, a
 *     quarter window that sweeps to a point, one long rear glass falling
 *     onto a DUCKTAIL deck lid;
 *   - nose: slim blade headlamps tucked under the hood corners, a
 *     body-colour beak between them, one wide low mouth split by raked
 *     fins, vertical air curtains and a carbon splitter;
 *   - tail: a FULL-WIDTH light bar under the ducktail lip that hooks down
 *     the corners, a deep diffuser and QUAD exhausts.
 *
 * Binding: each panel binds only the rig nodes that carry it (hood → hood
 * sub-rig, the long door → its hinge pillar / B-pillar frame, bumpers →
 * the bumper bulkheads s0 / s12, lamps → crash-can tips / rear panel, ...).
 */
import {
  boundsWhere,
  createLoft,
  createSheet,
  cutPanel,
  EDGE_STYLES,
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
import type { BeamSelector, GlassSpec, MaterialSlot, PaintDef, PanelDef, PanelKind, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { once, setVisualExtras } from '../lods';

// ====================================================================== rig-matched dimensions
/** Asserted against compileVehicle(COUPE) by coupe.test.ts. */
export const COUPE_DIMS = {
  axleFrontZ: -1.275,
  axleRearZ: 1.275,
  halfTrack: 0.82,
  hubY: 0.33,
  tyreRadius: 0.33,
  /** Tyre section half width as rendered (wheels.ts wheelDims: ring half spacing 0.095 × 1.36). */
  tyreHalfW: 0.129,
  /** Wheel-arch opening radius (lip), centred just above the hub. */
  archRadius: 0.37,
  archLift: 0.012,
} as const;

const ZF = COUPE_DIMS.axleFrontZ;
const ZR = COUPE_DIMS.axleRearZ;
const ARCH_Y = COUPE_DIMS.hubY + COUPE_DIMS.archLift;
const ARCH_R = COUPE_DIMS.archRadius;

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
/** Rounded minimum of two signed distances (the rounding cutPanel applies between cuts). */
const rmin2 = (r: number, a: number, b: number): number => (a < r && b < r ? r - Math.hypot(r - a, r - b) : Math.min(a, b));

// ====================================================================== body lines
/**
 * Feature lines as functions of z (forward −Z), REST pose. The front clip
 * ends at z −1.95 on the side (the nose takes over), the tail at +2.0.
 */
const L = {
  /** Rocker / fender underside edge. */
  yBot: pchip([
    [-1.95, 0.25],
    [-1.75, 0.24],
    [-0.75, 0.19],
    [-0.55, 0.178],
    [0.55, 0.178],
    [0.85, 0.2],
    [1.75, 0.27],
    [2.02, 0.285],
  ]),
  /** Skirt crease height above yBot. */
  skirt: pchip([
    [-1.95, 0.055],
    [-0.8, 0.07],
    [0.8, 0.07],
    [2.0, 0.055],
  ]),
  /** Body side reference half width (plan view): narrow waist at the door, wide rear haunch. */
  xSide: pchip([
    [-1.95, 0.855],
    [-1.82, 0.885],
    [-1.55, 0.902],
    [-1.275, 0.908],
    [-0.9, 0.906],
    [-0.4, 0.9],
    [0.2, 0.902],
    [0.6, 0.914],
    [0.95, 0.934],
    [1.275, 0.944],
    [1.6, 0.94],
    [1.85, 0.922],
    [2.02, 0.895],
  ]),
  /** Shoulder crease height: low at the nose, rising along the door onto the haunch. */
  ySh: pchip([
    [-1.95, 0.6],
    [-1.7, 0.632],
    [-1.3, 0.662],
    [-0.8, 0.686],
    [-0.2, 0.7],
    [0.4, 0.716],
    [0.85, 0.746],
    [1.2, 0.776],
    [1.6, 0.792],
    [2.02, 0.79],
  ]),
  /** Top corner (fender-top roll / belt / deck corner) height. */
  yTop: pchip([
    [-1.95, 0.665],
    [-1.8, 0.7],
    [-1.55, 0.742],
    [-1.275, 0.776],
    [-0.95, 0.806],
    [-0.65, 0.835],
    [-0.3, 0.852],
    [0.3, 0.862],
    [0.8, 0.875],
    [1.2, 0.895],
    [1.6, 0.912],
    [1.9, 0.914],
    [2.02, 0.908],
  ]),
  xTop: pchip([
    [-1.95, 0.79],
    [-1.8, 0.838],
    [-1.5, 0.862],
    [-1.0, 0.866],
    [-0.4, 0.858],
    [0.3, 0.858],
    [0.8, 0.87],
    [1.275, 0.888],
    [1.7, 0.878],
    [2.02, 0.84],
  ]),
  /** Hood / deck shut-line half width. */
  xHood: pchip([
    [-1.95, 0.665],
    [-1.7, 0.7],
    [-1.3, 0.716],
    [-0.8, 0.722],
    [0, 0.724],
    [1.2, 0.73],
    [1.7, 0.73],
    [2.02, 0.71],
  ]),
  /** Height at the hood / deck shut line; the hood rides ≈ 1.5 cm over the hood nodes (y 0.66 / 0.765 / 0.835 / 0.87 at z −1.94 / −1.5 / −1.07 / −0.66). */
  yHood: pchip([
    [-1.95, 0.69],
    [-1.9, 0.705],
    [-1.5, 0.784],
    [-1.07, 0.85],
    [-0.66, 0.884],
    [-0.55, 0.89],
    [0, 0.9],
    [1.0, 0.925],
    [1.4, 0.942],
    [1.75, 0.952],
    [2.02, 0.952],
  ]),
  /** Hood power-bulge lift (0..1): the V8 bulge on the hood only (the deck carries the ducktail). */
  dome: pchip([
    [-2.0, 1],
    [-1.05, 1],
    [-0.64, 0],
    [2.2, 0],
  ]),
  /** Centre crown above the shut-line height. */
  crown: pchip([
    [-1.95, 0.026],
    [-1.5, 0.032],
    [-0.9, 0.028],
    [-0.6, 0.02],
    [1.2, 0.02],
    [1.6, 0.03],
    [2.02, 0.026],
  ]),
};

/**
 * Hood power bulge: centre line x of its shoulder, the shoulder's half width
 * and the lift. The shoulder is an S from the hood surface (x = xc + w) up to
 * the bulge top (x = xc − w), so the bulge is faired into the hood with no
 * crease: at a 2–3 cm step it read as two hard lines down the hood and broke
 * the nose highlight. It narrows toward the nose and fades out over the last
 * 0.4 m before the windscreen.
 */
const creaseX = (z: number): number => lerp(0.36, 0.22, smoothstep(-0.8, -2.0, z));
const creaseW = (z: number): number => lerp(0.085, 0.06, smoothstep(-0.8, -1.9, z));
const domeLift = (z: number): number => 0.013 * L.dome(z);
/** Shoulder profile across x: 0 on the hood surface, 1 on the bulge top (C¹ smoothstep). */
const bulgeT = (x: number, z: number): number => 1 - smoothstep(creaseX(z) - creaseW(z), creaseX(z) + creaseW(z), Math.abs(x));

/** M1 top including the bulge lift (≈ the evaluated M1 deck), for parts that sit on it. */
function m1Top(x: number, z: number): number {
  return topY(x, z) + domeLift(z) * bulgeT(x, z);
}

/** M1 top surface height (hood / tonneau / deck) at (x, z). */
function topY(x: number, z: number): number {
  const xh = L.xHood(z);
  const t = Math.min(1, Math.abs(x) / xh);
  return L.yHood(z) + L.crown(z) * (1 - t * t);
}

// ====================================================================== M1 body master
/** M1 control-point indices of the feature lines. */
const K = { skirt: 2, shoulder: 6, top: 9, hood: 10 } as const;
const FRONT_BEND = [0, 0, 0, 0, 0, 0, 0, 0, -0.01, -0.04, -0.09, -0.14, -0.148, -0.156, -0.178];
const REAR_BEND = [0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.065, 0.13, 0.175, 0.177, 0.179, 0.192];
const M1_FRONT = -1.95;
const M1_REAR = 2.02;
const M1_STATIONS = [
  -1.95, -1.92, -1.87, -1.8, -1.71, -1.6, -1.47, -1.32, -1.16, -1.0, -0.88, -0.78, -0.7, -0.6, -0.45, -0.25, 0, 0.25, 0.5, 0.68, 0.84, 0.98, 1.1, 1.22,
  1.34, 1.46, 1.6, 1.74, 1.86, 1.95, 2.0, 2.02,
];

const fenderW = (z: number): number => 1 - smoothstep(-0.8, -0.5, z);
/** Door scallop depth, m (0 at the arches). */
const scallop = (z: number): number => 0.016 * smoothstep(-0.85, -0.45, z) * (1 - smoothstep(0.55, 0.9, z));

function m1Section(z: number): V3[] {
  const xs = L.xSide(z);
  const yb = L.yBot(z);
  const ysk = yb + L.skirt(z);
  const ysh = L.ySh(z);
  const yt = L.yTop(z);
  const pts: [number, number][] = [
    [xs - 0.07, yb - 0.004],
    [xs - 0.02, yb + 0.008],
    [xs - 0.002, ysk],
    // Sculpted lower body side: a concave scallop under the knife-edge shoulder, deepest along the
    // door, running out into the side scoop ahead of the rear wheel.
    [xs - 0.0035 - 0.75 * scallop(z), lerp(ysk, ysh, 0.35)],
    [xs + 0.002 - scallop(z), lerp(ysk, ysh, 0.72)],
    [xs + 0.014, ysh - 0.018],
    [xs + 0.0155, ysh],
    [xs + 0.003, ysh + 0.012],
    [lerp(xs - 0.026, lerp(xs + 0.002, L.xTop(z), 0.5), fenderW(z)), lerp(ysh, yt, 0.55)],
    [L.xTop(z), yt],
    [L.xHood(z), L.yHood(z)],
    // Power bulge: foot, mid-shoulder and top of the S (see creaseX), then the centre line.
    [creaseX(z) + creaseW(z), m1Top(creaseX(z) + creaseW(z), z)],
    [creaseX(z), m1Top(creaseX(z), z)],
    [creaseX(z) - creaseW(z), m1Top(creaseX(z) - creaseW(z), z)],
    [0, L.yHood(z) + L.crown(z) + domeLift(z)],
  ];
  const wf = 1 - smoothstep(M1_FRONT, -1.6, z);
  const wr = smoothstep(1.74, M1_REAR, z);
  // Ducktail: the deck kicks up toward its rear edge.
  const kick = 0.034 * smoothstep(1.78, M1_REAR, z) ** 2.2;
  return pts.map(([x, y], k) => [x, y + (k >= K.top ? kick * (k === K.top ? 0.45 : 1) : 0), z + wf * FRONT_BEND[k]! + wr * REAR_BEND[k]!] as V3);
}

/** Arch flares: ring displacement just outside each arch lip, fading below the shoulder and toward the top. */
function flare(p: V3): void {
  const ax = Math.abs(p[0]);
  if (ax < 0.74) return;
  const hf = smoothstep(0.8, 0.88, ax);
  const sh = L.ySh(p[2]);
  const vf = 1 - smoothstep(sh - 0.06, sh - 0.012, p[1]);
  if (hf * vf <= 0) return;
  let dx = 0;
  for (const [zc, amp, w0, w1] of [
    [ZF, 0.034, 0.03, 0.22],
    // The rear haunch: a broad, muscular flare that swells up into the shoulder.
    [ZR, 0.046, 0.04, 0.4],
  ] as const) {
    const d = Math.hypot(p[2] - zc, p[1] - ARCH_Y);
    dx += amp * (1 - smoothstep(ARCH_R + w0, ARCH_R + w0 + w1, d));
  }
  p[0] += Math.sign(p[0]) * dx * hf * vf;
}

// ====================================================================== M4 greenhouse master
const M4_FIRST = -0.68;
const M4_LAST = 1.62;
const M4_STATIONS = [-0.68, -0.63, -0.56, -0.47, -0.37, -0.26, -0.15, -0.04, 0.1, 0.26, 0.42, 0.56, 0.68, 0.79, 0.89, 0.98, 1.06, 1.14, 1.22, 1.3, 1.38, 1.46, 1.53, 1.58, 1.62];
const G = {
  /** DLO top: steep A-pillar, short roof rail, then the window line sweeping down to a point at z 1.08. */
  yGlass: pchip([
    [-0.68, 0.84],
    [-0.55, 0.928],
    [-0.4, 1.03],
    [-0.25, 1.117],
    [-0.12, 1.158],
    [0.05, 1.178],
    [0.25, 1.178],
    [0.42, 1.162],
    [0.6, 1.122],
    [0.78, 1.058],
    [0.92, 0.988],
    [1.02, 0.93],
    [1.08, 0.892],
  ]),
  /** Centre line: windscreen base → header → roof crown → long fastback rear glass → ducktail deck. */
  yCentre: pchip([
    [-0.74, 0.893],
    [-0.45, 1.075],
    [-0.22, 1.192],
    [-0.06, 1.24],
    [0.12, 1.254],
    [0.3, 1.252],
    [0.48, 1.236],
    [0.68, 1.2],
    [0.9, 1.146],
    [1.12, 1.078],
    [1.32, 1.022],
    [1.48, 0.985],
    [1.62, 0.968],
  ]),
  /** Side-glass tumblehome (Δx per Δy). */
  tumble: 0.6,
};
const FRONT_BEND4 = [0, 0, 0, 0, -0.004, -0.008, -0.05, -0.07];
const REAR_BEND4 = [-0.02, -0.02, -0.02, -0.02, -0.01, 0, 0.03, 0.045];
/** Windscreen header z (glass top) and rear-glass top z. */
const HEADER_Z = -0.12;
const REAR_TOP_Z = 0.56;
/** DLO tail (quarter window point) z, and the door-glass / quarter-window divider. */
const DLO_TAIL = 1.08;
const Q_FRONT = 0.47;
const Q_REAR = 0.51;

function m4Section(z: number): V3[] {
  const xb = L.xTop(z) - 0.003;
  const yb = L.yTop(z) - 0.004;
  const yg = Math.max(yb + 0.0015, z >= DLO_TAIL ? yb + 0.0015 : G.yGlass(z));
  const h = yg - yb;
  const xg = xb - G.tumble * h;
  const bulge = 0.018 * Math.min(1, h / 0.34);
  const p1: [number, number] = [xb - G.tumble * 0.18 * h - bulge * 0.5, yb + 0.18 * h];
  const p2: [number, number] = [xb - G.tumble * 0.58 * h - bulge, yb + 0.58 * h];
  const p3: [number, number] = [xg, yg];
  const yc = G.yCentre(z);
  // Roof edge → rear-glass edge: follows the centre line once the DLO top falls away into the C-pillar.
  const xRoof = xg - 0.07;
  const yRoof = yg + 0.046;
  const tr = smoothstep(0.35, 0.9, z);
  const xRear = lerp(0.56, 0.7, smoothstep(0.5, M4_LAST, z));
  const yRear = lerp(yc - 0.03, m1Top(0.7, z) + 0.004, smoothstep(1.35, M4_LAST, z));
  const x5 = lerp(xRoof, xRear, tr);
  const y5 = Math.min(lerp(yRoof, yRear, tr), yc - 0.006);
  const ycap = Math.max(y5 + 0.004, yc);
  const dx = x5 - p3[0];
  const dy = y5 - p3[1];
  const dl = Math.hypot(dx, dy) || 1;
  const bulge4 = 0.012 * Math.min(1, dl / 0.08);
  const p4: [number, number] = [p3[0] + dx * 0.42 + (dy / dl) * bulge4, p3[1] + dy * 0.42 - (dx / dl) * bulge4];
  const pts: [number, number][] = [[xb, yb], p1, p2, p3, p4, [x5, y5], [x5 * 0.52, lerp(ycap, y5, 0.27)], [0, ycap]];
  const wf = 1 - smoothstep(M4_FIRST, -0.35, z);
  const wr = smoothstep(1.3, M4_LAST, z);
  // Never dip under the deck the rear glass sits on.
  return pts.map(([x, y], k) => {
    const zz = z + wf * FRONT_BEND4[k]! + wr * REAR_BEND4[k]!;
    return [x, z > 1.0 && k >= 4 ? Math.max(y, m1Top(x, zz) + 0.003) : y, zz] as V3;
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
export interface CoupeBuildOptions {
  /** 0 = full detail, 1 ≈ 40 % of the triangles (render LOD1 ≥ 25 m), 2 (LOD2 ≥ 80 m, far shadows). */
  lod: 0 | 1 | 2;
}

/** Glass-class beams of the coupe rig (cw–rf, bt–rf, rf–dk across consecutive stations, pillars excluded). */
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
  door: (s: 'L' | 'R') => [
    [`s6_bt_${s}`, `s7_rf_${s}`],
    [`s6_rf_${s}`, `s7_bt_${s}`],
  ],
  quarter: (s: 'L' | 'R') => [
    [`s7_bt_${s}`, `s8_rf_${s}`],
    [`s7_rf_${s}`, `s8_bt_${s}`],
  ],
} as const;
const pairs = (p: readonly (readonly string[])[]): BeamSelector => ({ pairs: p.map((q) => [q[0]!, q[1]!] as const) });
const sideBind = (ids: readonly string[], s: 'L' | 'R'): string[] => ids.map((id) => id.replace(/\$/g, s));

/** Panels a LOD2 coupe leaves out (seals, handles, small cabin parts behind the glass, exhaust detail). */
const LOD2_DROP = /Seal[LR]?$|^handle|^exhaustBore$|^steering$|^console$|^rearSeats$|^mirrorGlass|^plateFrame$|^scoopGrille|^projectorBezels$|^hoodLouvres$/;

export function buildCoupeVisual(opts: CoupeBuildOptions = { lod: 0 }): VehicleVisualDef {
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
    if (mesh.index.length === 0) throw new Error(`coupe visual: panel ${id} is empty`);
    panels.push({ id, kind, material, surface: toMeshSurface(mesh), bind, detach: null, ...extra });
  };
  const SIDES = ['R', 'L'] as const;
  const perSide = (m: PanelMesh, s: 'L' | 'R'): PanelMesh => (s === 'R' ? m : mirrorMesh(m));

  // ---------------------------------------------------------------- masters
  const m1Loft = createLoft(M1_STATIONS.map(m1Section), { symmetric: true });
  const S1 = createSheet(loftSurface(m1Loft, { displace: flare }), { resolution: 0.09 * rs, maxAngleDeg: 14 * rs });
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

  const NOSE_TIP = -2.2;
  const NOSE_PLAN = smooth2(
    [
      [noseX0, -1.95],
      [noseX0 - 0.006, -2.0],
      [noseX0 - 0.026, -2.055],
      [noseX0 - 0.075, -2.11],
      [noseX0 - 0.16, -2.155],
      [0.56, -2.183],
      [0.3, -2.197],
      [0, NOSE_TIP],
    ],
    10,
  );
  const NOSE_OUT = (dx: number, dz: number): P2 => [-dz, dx];
  const noseSecs = ribbonSections(
    {
      plan: NOSE_PLAN,
      outward: NOSE_OUT,
      profile: [
        [0.225, -0.05],
        [0.24, -0.014],
        [0.285, -0.002],
        [0.355, 0.002],
        [0.43, -0.004],
        [0.49, -0.014],
        [0.545, -0.028],
        [0.592, -0.045],
        [0.632, -0.066],
        [0.662, -0.092],
      ],
      sections: 13,
      x0: noseX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 0)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 0),
  );
  const m2Loft = createLoft(noseSecs, { symmetric: true });
  const S2 = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.09 * rs, maxAngleDeg: 13 * rs });
  /** Finer sampling of the ribbons for the small lamp parts (identical surface, so shared cut lines match). */
  const S2f = createSheet(loftSurface(m2Loft, { flip: true }), { resolution: 0.045 * Math.sqrt(rs), maxAngleDeg: 10 * Math.sqrt(rs) });

  const TAIL_PLAN = smooth2(
    [
      [tailX0, 2.02],
      [tailX0 - 0.006, 2.07],
      [tailX0 - 0.028, 2.12],
      [tailX0 - 0.075, 2.165],
      [tailX0 - 0.16, 2.2],
      [0.56, 2.222],
      [0.3, 2.234],
      [0, 2.238],
    ],
    10,
  );
  const tailSecs = ribbonSections(
    {
      plan: TAIL_PLAN,
      outward: (dx, dz) => [dz, -dx],
      profile: [
        [0.26, -0.07],
        [0.275, -0.028],
        [0.33, 0.0],
        [0.42, 0.012],
        [0.5, 0.01],
        [0.58, -0.01],
        [0.68, -0.032],
        [0.78, -0.05],
        [0.86, -0.046],
        [0.912, -0.034],
      ],
      sections: 13,
      x0: tailX0,
    },
    Array.from({ length: K.hood + 1 }, (_, k) => m1At(u1(k), 1)),
    (f) => m1At(lerp(u1(K.hood), 1, f), 1),
  );
  const m3Loft = createLoft(tailSecs, { symmetric: true });
  const S3 = createSheet(loftSurface(m3Loft), { resolution: 0.095 * rs, maxAngleDeg: 15 * rs });
  const S3f = createSheet(loftSurface(m3Loft), { resolution: 0.045 * Math.sqrt(rs), maxAngleDeg: 10 * Math.sqrt(rs) });

  // ---------------------------------------------------------------- cut helpers
  const lip: EdgeStyle = { inset: 0.002, roll: 0.003, wall: 0.025, segments: 1, seal: false };
  const SHUT_NO_SEAL: EdgeStyle = { ...EDGE_STYLES.shut, seal: false };
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
  /** Door front edge (behind the front arch, ahead of the hinge pillar s5_hp at z −0.55). */
  const FENDER_LINE: P2[] = [
    [-0.63, -0.2],
    [-0.625, 0.6],
    [-0.6, 1.2],
  ];
  /** Door rear edge: just behind the B-pillar hoop (s7, z 0.46), leaning back with the shoulder. */
  const B_LINE: P2[] = [
    [0.47, -0.2],
    [0.5, 0.6],
    [0.53, 1.2],
  ];
  const archF = () => outsideCircle(ZF, ARCH_Y, ARCH_R);
  const archR = () => outsideCircle(ZR, ARCH_Y, ARCH_R);
  const HOOD_REAR: P2[] = [
    [0, -0.812],
    [0.4, -0.796],
    [0.72, -0.758],
    [1.2, -0.736],
  ];
  const WS_BASE: P2[] = [
    [0, -0.74],
    [0.4, -0.722],
    [0.78, -0.68],
    [1.2, -0.66],
  ];
  const REAR_GLASS_BASE: P2[] = [
    [0, 1.62],
    [0.4, 1.605],
    [0.72, 1.57],
    [1.2, 1.54],
  ];
  /** The deck lid's front shut sits just behind the rear-glass base. */
  const TRUNK_FRONT: P2[] = REAR_GLASS_BASE.map(([x, z]) => [x, z + 0.012] as P2);
  const FUEL: [number, number, number] = [1.6, 0.78, 0.075];
  /** Side intake scoop ahead of the rear wheel (side view): a raked wedge under the shoulder. */
  const SCOOP: Shape2 = {
    sd: (z, y) => {
      const top = 0.632 + 0.018 * smoothstep(0.56, 0.88, z);
      // Lower edge rises toward the front: the opening is a wedge pointing forward along the shoulder.
      const bot = 0.405 + 0.72 * (0.875 - z);
      return Math.min((y - bot) / Math.hypot(1, 0.72), top - y, 0.872 - z);
    },
  };
  /** Rear lamp wrap onto the quarter (side view): the light bar's end hooks round the corner. */
  const Q_LAMP: Shape2 = { sd: (z, y) => Math.min(z - 1.9, 0.875 - y, y - lerp(0.84, 0.79, smoothstep(1.9, 2.04, z))) };

  // ---------------------------------------------------------------- M1 body panels
  const hoodBind = ['hood_*'];
  /** Heat-extractor vents (plan view |x|, z): one raked louvre panel each side of the bulge, over the V8's banks. */
  const VENT = (x: number, z: number): number => rmin2(0.02, 0.07 - Math.abs(Math.abs(x) - 0.45 - 0.22 * (z + 1.4)), 0.12 - Math.abs(z + 1.4));
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), vAbove(S1, 0), planLine(HOOD_REAR, 'front'), { fn: (p) => -VENT(p[0], p[2]), edge: 'lip' }], { thickness: 0.018, where: (p) => p[2] < -0.7 && p[1] > 0.55 });
    add('hood', 'hood', 'paint', m.mesh, hoodBind, { detach: { attach: 'boundary', minBrokenFraction: 0.85, mode: 'follow' } });
    add('hoodSeal', 'trim', 'rubber', m.seal, hoodBind, { damageWeight: 0, castShadow: false });
    // Small part: a coarse LOD grid can miss it entirely, so it keeps a finer sheet of M1.
    // (LOD2's grid is capped at LOD1's: at its own 0.2 m the 14 cm vent fell between grid lines.)
    const rv = Math.min(rs, 2.9);
    const S1v = opts.lod === 0 ? S1 : createSheet(loftSurface(m1Loft, { displace: flare }), { resolution: 0.09 * Math.sqrt(rv), maxAngleDeg: 14 * Math.sqrt(rv) });
    const v = cutC(S1v, [{ fn: (p) => VENT(p[0], p[2]) + 0.008, edge: 'seam' }], { offset: -0.022, border: 'seam', where: (p) => p[2] < -1.0 && p[2] > -1.8 && p[1] > 0.55 });
    // Louvre blades across each vent.
    const blades: PanelMesh[] = [];
    for (const zb of [-1.47, -1.4, -1.33]) {
      const xc = 0.45 + 0.22 * (zb + 1.4);
      blades.push(roundedBoxMesh([xc, m1Top(xc, zb) - 0.006, zb], [0.06, 0.004, 0.012], 0.002, { segs: 0, rot: rotX(-0.5) }));
    }
    const bl = mergeMeshes(blades);
    add('hoodVents', 'grille', 'grille', v.mesh, hoodBind, { damageWeight: 0.8 });
    add('hoodLouvres', 'trim', 'trim', mergeMeshes([bl, mirrorMesh(bl)]), hoodBind, { damageWeight: 0.8 });
  }
  {
    const m = cutC(S1, [uAbove(S1, u1(K.top) + 0.004, 'seam'), planLine(HOOD_REAR, 'rear'), planLine(WS_BASE, 'front', 'seam')], {
      where: (p) => p[2] > -0.9 && p[2] < -0.55 && p[1] > 0.8,
      border: 'seam',
    });
    add('cowl', 'trim', 'trim', m.mesh, ['s5_cw*', 's5_fw_*', 's4_fd_*', 's5_hp_*'], { damageWeight: 0.6 });
  }
  // R-CRASH hinged closures (src/sim/vehicle/closures.ts): the trunk lid (tk_*) and the doors (dR_* / dL_*)
  // are their own sub-rigs in the sim, so their panels, handles, cards, door glass and mirrors bind to the
  // closure nodes and swing with them
  const trunkBind = ['tk_0*', 'tk_1*', 'tk_2*'];
  {
    const m = cutC(S1, [uAbove(S1, u1(K.hood)), planLine(TRUNK_FRONT, 'rear'), vBelow(S1, 1)], { where: (p) => p[2] > 1.45 && p[1] > 0.85 });
    add('trunk', 'trunk', 'paint', m.mesh, trunkBind);
    add('trunkSeal', 'trim', 'rubber', m.seal, trunkBind, { damageWeight: 0, castShadow: false });
  }

  /** A door closure's skin grid (rows 0–3; not its inner-panel nodes `_i*`, 14 cm inboard). */
  const doorBind = (s: 'L' | 'R'): string[] => [0, 1, 2, 3].map((r) => `d${s}_${r}*`);
  for (const s of SIDES) {
    {
      const m = cut(S1, [uBelow(S1, u1(K.hood)), vAbove(S1, 0), vline(FENDER_LINE, 'front'), archF()], { where: (p) => p[2] < -0.5 });
      add(`fender${s}`, 'fender', 'paint', perSide(m.mesh, s), sideBind(['s1_fd_$', 's1_rh_$', 's1_rl_$', 's2_fd_$', 's2_rh_$', 's2_rl_$', 's3_fd_$', 's3_tw_$', 's3_rh_$', 's3_rl_$', 's4_fd_$', 's4_rh_$', 's4_rl_$', 's5_hp_$', 's5_cw_$', 's5_sl_$'], s));
    }
    {
      // The vertical shut lines cross the knife-edge shoulder, where an inward seal strip folds over
      // itself: those edges keep the curled flange but no rubber backing (the sill edge has one).
      const m = cut(S1, [uAbove(S1, u1(K.skirt)), uBelow(S1, u1(K.top) - 0.0005, 'hem'), vline(FENDER_LINE, 'rear', SHUT_NO_SEAL), vline(B_LINE, 'front', SHUT_NO_SEAL)], { where: (p) => p[2] > -0.75 && p[2] < 0.65 && p[1] < 1.0 });
      add(`door${s}`, 'door', 'paint', perSide(m.mesh, s), doorBind(s));
      add(`door${s}Seal`, 'trim', 'rubber', perSide(m.seal, s), doorBind(s), { damageWeight: 0, castShadow: false });
    }
    {
      const m = cut(S1, [uBelow(S1, u1(K.skirt)), vline(FENDER_LINE, 'rear'), vline(B_LINE, 'front')], { where: (p) => p[2] > -0.75 && p[2] < 0.65 && p[1] < 0.4 });
      add(`sill${s}`, 'body', 'trim', perSide(m.mesh, s), sideBind(['s5_sl_$', 's5_fl_$', 's6_sl_$', 's6_fl_$', 's7_sl_$', 's7_fl_$'], s));
    }
    const quarterBind = sideBind(['s7_sl_$', 's7_dm_$', 's7_bt_$', 's8_sl_$', 's8_qm_$', 's8_bt_$', 's9_rl_$', 's9_rh_$', 's9_tw_$', 's9_qt_$', 's9_dk_$', 's10_rl_$', 's10_rh_$', 's10_qt_$', 's10_ld_$', 's11_rl_$', 's11_rh_$', 's11_qt_$', 's11_ld_$'], s);
    {
      const cuts: Cut[] = [uBelow(S1, u1(K.hood)), vBelow(S1, 1), vline(B_LINE, 'rear'), archR(), sideCut(neg(Q_LAMP), lens), sideCut(neg(SCOOP), 'lip')];
      if (s === 'R') cuts.push(outsideCircle(FUEL[0], FUEL[1], FUEL[2], 'shut'));
      const m = cut(S1, cuts, { where: (p) => p[2] > 0.3 });
      add(`quarter${s}`, 'body', 'paint', perSide(m.mesh, s), quarterBind);
      // Scoop insert: dark mesh recessed behind the opening.
      const g = cut(S1, [sideCut({ sd: (z, y) => SCOOP.sd(z, y) + 0.012 }, 'seam')], { offset: -0.028, border: 'seam', where: (p) => p[2] > 0.45 && p[2] < 0.95 && p[1] > 0.3 && p[1] < 0.75 });
      add(`scoopGrille${s}`, 'grille', 'grille', perSide(g.mesh, s), quarterBind, { damageWeight: 0.6 });
      if (s === 'R') {
        const f = cut(S1, [sideCut({ sd: (z, y) => FUEL[2] - Math.hypot(z - FUEL[0], y - FUEL[1]) }, 'shut')], { where: (p) => Math.abs(p[2] - FUEL[0]) < 0.15 && Math.abs(p[1] - FUEL[1]) < 0.15 });
        add('fuelDoor', 'trim', 'paint', f.mesh, quarterBind, { detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
      }
    }
  }

  // ---------------------------------------------------------------- greenhouse (M4)
  /** Black mirror sail closes the DLO's front tip up to here. */
  const SAIL_Z = -0.5;
  const dloTop = u4(3);
  /** Black frameless-glass surround band above the DLO top, m. */
  const BAND = 0.014;
  {
    const wsHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), p[2] - HEADER_Z), edge: 'hem' };
    const rearHole: Cut = { fn: (p, u, v) => Math.max(S4.metricU(u4(5), v) - S4.metricU(u, v), REAR_TOP_Z - p[2]), edge: 'hem' };
    const m = cutC(S4, [uAboveBy(S4, dloTop, BAND, 'hem'), vAbove(S4, 0, 'seam'), vBelow(S4, 1, 'seam'), wsHole, rearHole], { border: 'seam' });
    add('roof', 'roof', 'paint', m.mesh, ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*', 's9_qt_*', 's10_ld*', 's10_qt_*']);
  }
  for (const s of SIDES) {
    const m = cut(S4, [uBelowBy(S4, dloTop, BAND, 'hem'), zAbove(DLO_TAIL - 0.05, 'seam'), vBelow(S4, 1, 'seam')], { border: 'seam', where: (p) => p[2] > 0.9 });
    add(`sail${s}`, 'body', 'paint', perSide(m.mesh, s), sideBind(['s7_rf_$', 's7_bt_$', 's8_rf_$', 's8_bt_$', 's8_qm_$', 's9_dk_$', 's9_qt_$', 's10_qt_$', 's10_ld_$'], s));
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
    const m = cutC(S4, [uAbove(S4, u4(5) - 0.004, 'seam'), zBelow(HEADER_Z + 0.004, 'seam'), vAbove(S4, 0, 'seam')], { offset: -0.006, border: 'seam', where: (p) => p[2] < 0 });
    add('windscreen', 'glass', 'glass', m.mesh, ['s5_cw*', 's6_rf*', 's6_bt_*'], { ...glassOpts, glass: glassSpec(true, pairs(GLASS_BEAMS.windscreen)) });
  }
  {
    const m = cutC(S4, [uAbove(S4, u4(5) - 0.004, 'seam'), zAbove(REAR_TOP_Z - 0.004, 'seam'), vBelow(S4, 1, 'seam')], { offset: -0.006, border: 'seam', where: (p) => p[2] > 0.4 });
    add('rearGlass', 'glass', 'glass', m.mesh, ['s7_rf*', 's8_rf*', 's8_bt_*', 's9_dk*'], { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.rear)) });
  }
  for (const s of SIDES) {
    const dlo: Cut[] = [uAboveBy(S4, 0, 0.003, 'seam'), uBelowBy(S4, dloTop, 0.006, 'seam')];
    const dg = cut(S4, [...dlo, zBelow(Q_FRONT + 0.004, 'seam'), zAbove(SAIL_Z - 0.02, 'seam')], { offset: -0.01, border: 'seam', where: (p) => p[2] < 0.55 });
    // frameless door glass: on the door's belt row + frame top (it swings with the door); cracks from the door
    // frame's quad diagonals (a bent door) or the aperture's cage diagonals (a racked opening)
    const doorGlass = [[`d${s}_20`, `d${s}_31`], [`d${s}_21`, `d${s}_32`], [`d${s}_22`, `d${s}_31`], ...GLASS_BEAMS.door(s).map((q) => [...q])];
    add(`glass${s}`, 'glass', 'glass', perSide(dg.mesh, s), [`d${s}_2*`, `d${s}_3*`], { ...glassOpts, glass: glassSpec(false, pairs(doorGlass)) });
    const qg = cut(S4, [...dlo, zAbove(Q_REAR - 0.03, 'seam'), zBelow(DLO_TAIL - 0.03, 'seam')], { offset: -0.012, border: 'seam', where: (p) => p[2] > 0.35 && p[2] < 1.15 });
    add(`glass${s}Q`, 'glass', 'glass', perSide(qg.mesh, s), sideBind(['s7_bt_$', 's7_rf_$', 's8_bt_$', 's8_rf_$', 's8_qm_$', 's9_dk_$'], s), { ...glassOpts, glass: glassSpec(false, pairs(GLASS_BEAMS.quarter(s))) });
    // Black DLO surround band + the slim divider between the door glass and the quarter window + the mirror sail.
    const vTail = vAtZ(S4, dloTop, DLO_TAIL - 0.005);
    const band = stripMesh(S4, {
      u0: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) - 0.004),
      u1: (v) => uAtMetric(S4, v, S4.metricU(dloTop, v) + BAND + 0.001),
      v0: 0,
      v1: vTail,
      segV: Math.round(70 / rs),
      offset: 0.0006,
    });
    const S4n = opts.lod === 0 ? S4 : createSheet(loftSurface(m4Loft), { resolution: 0.085 * Math.sqrt(rs), maxAngleDeg: 13 * Math.sqrt(rs) });
    const qd = cut(S4n, [uAbove(S4n, 0.002, 'seam'), uBelow(S4n, dloTop, 'seam'), zAbove(Q_FRONT, 'hem'), zBelow(Q_REAR, 'hem')], { offset: 0.0005, border: 'seam', where: (p) => p[2] > 0.35 && p[2] < 0.65 });
    const sail = cut(S4, [uAbove(S4, 0.002, 'seam'), uBelow(S4, dloTop, 'seam'), zBelow(SAIL_Z, 'hem'), vAbove(S4, 0, 'seam')], { offset: 0.0005, border: 'seam', where: (p) => p[2] < -0.35 });
    add(`dloTrim${s}`, 'trim', 'trim', perSide(mergeMeshes([band, qd.mesh, sail.mesh]), s), sideBind(['s5_cw_$', 's6_rf_$', 's6_bt_$', 's7_rf_$', 's7_bt_$', 's8_rf_$', 's8_bt_$', 's9_dk_$'], s), { damageWeight: 0.5 });
    const seal = stripMesh(S4, { u0: () => 0, u1: (v) => uAtMetric(S4, v, 0.008), v0: vAtZ(S4, 0, -0.64), v1: vAtZ(S4, 0, DLO_TAIL - 0.04), segV: Math.round(50 / rs), offset: 0.0015 });
    add(`beltSeal${s}`, 'trim', 'rubber', perSide(seal, s), sideBind(['s5_cw_$', 's5_hp_$', 's6_bt_$', 's6_dm_$', 's6_rf_$', 's7_bt_$', 's7_dm_$', 's7_rf_$', 's8_bt_$', 's8_rf_$'], s), { damageWeight: 0 });
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
  /** (u, v) on a nose sheet at front-view (|x|, y): Newton warm-started from the previous solution. */
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
  /** A strip conforming to a ribbon sheet along a front-view path (|x|, y)(t); `lifts` = cross profile (normal offsets). */
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
  // Front view (|x|, y). Slim blade headlamps tucked under the hood corners
  // (dark housing, two small projectors, an LED light guide along the bottom
  // that hooks up the outer corner, a bright brow) with a body-colour beak
  // between them; below, one wide low mouth (honeycomb) split by raked
  // body-colour fins into a centre grille and two corner intakes with LED
  // indicator strips; vertical air curtains; a black chin and a splitter blade.
  const bumperFBind = ['s0_*'];
  const lampBind = ['s1_*', 's2_fd_*', 's2_rh_*', 's2_rl_*', 's2_rt'];
  const LAMP_Y0 = 0.562;
  const RAKE: [P2, P2] = [
    [0.53, LAMP_Y0],
    [0.45, 0.672],
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
  const TAIL_SLOPE = 1.25;
  const LAMP_TAIL_Z = -1.9;
  const tailTop = (z: number): number => LAMP_Y0 + 0.01 + TAIL_SLOPE * (LAMP_TAIL_Z - z);
  /** The lamp opening as one region (> 0 inside), open toward the hood and fender edges. */
  const lampShape = (p: V3): number => rmin(0.008, p[1] - LAMP_Y0, rake(Math.abs(p[0]), p[1]), (tailTop(p[2]) - p[1]) / Math.hypot(1, TAIL_SLOPE));
  // Openings: a centre grille (trapezoid narrowing upward) and two big corner intakes whose tops
  // climb outward toward the lamps, separated by raked body-colour bridges.
  const MOUTH_BOT = 0.268;
  const MOUTH_RAKE = 0.26;
  /** Centre grille half width at height y. */
  const gx = (y: number): number => 0.35 - MOUTH_RAKE * (y - MOUTH_BOT);
  const GRILLE_TOP = 0.505;
  /** Corner intake: inner edge parallel to the grille side (bridge width BRIDGE), top rising outward. */
  const BRIDGE = 0.068;
  const intakeTop = (x: number): number => 0.43 + 0.13 * smoothstep(0.42, 0.8, x);
  const mouthOuter = (y: number): number => 0.815 - 0.12 * (y - MOUTH_BOT);
  const CENTRE = fv((x, y) => rmin(0.022, (gx(y) - x) * 0.97, y - MOUTH_BOT, GRILLE_TOP - y));
  const INTAKE = fv((x, y) => rmin(0.018, (x - gx(y) - BRIDGE) * 0.97, (mouthOuter(y) - x) * 0.99, y - MOUTH_BOT, intakeTop(x) - y));
  const MOUTH: Shape2 = { sd: (x, y) => Math.max(CENTRE.sd(x, y), INTAKE.sd(x, y)) };
  const CURTAIN = fv((x, y) => rmin(0.004, x - 0.835, 0.852 - x, y - 0.35, 0.52 - y));
  const CHIN = fv((x, y) => Math.min(0.253 - y, 0.86 - x));
  const grow = (sh: Shape2, d: number): Shape2 => ({ sd: (a, b) => sh.sd(a, b) + d });
  {
    const m = cutC(
      S2,
      [
        uBelow(S2, 1),
        vAbove(S2, 0),
        { fn: (p) => -lampShape(p), edge: 'shut' },
        frontCut(neg(CENTRE), 'lip'),
        frontCut(neg(INTAKE), 'lip'),
        frontCut(neg(CURTAIN), 'lip'),
        frontCut(neg(CHIN), 'hem'),
      ],
      { corner: 0.015 },
    );
    add('bumperF', 'bumper', 'paint', m.mesh, bumperFBind, { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    add('bumperFSeal', 'trim', 'rubber', m.seal, bumperFBind, { damageWeight: 0, castShadow: false });
    // Honeycomb insert recessed behind the mouth.
    const mo = cutC(S2, [frontCut(grow(MOUTH, 0.012), 'seam')], { offset: -0.034, border: 'seam' });
    add('grille', 'grille', 'grille', mo.mesh, bumperFBind, { damageWeight: 0.8 });
    // Two gloss blades across the centre grille and one splitting each corner intake.
    const slats: PanelMesh[] = [];
    for (const ys of [0.355, 0.43]) slats.push(frontStrip(S2, (t) => [(gx(ys) - 0.028) * (1 - t), ys], 0.0055, opts.lod === 0 ? 12 : 6, [-0.03, -0.02, -0.019, -0.02, -0.03]));
    {
      const ys = 0.37;
      const x0 = gx(ys) + BRIDGE + 0.025;
      const x1 = mouthOuter(ys) - 0.045;
      slats.push(frontStrip(S2, (t) => [lerp(x0, x1, t), ys + 0.05 * t], 0.0055, opts.lod === 0 ? 10 : 5, [-0.032, -0.022, -0.021, -0.022, -0.032]));
    }
    const sl = mergeMeshes(slats);
    add('grilleSlats', 'trim', 'trim', mergeMeshes([sl, mirrorMesh(sl)]), bumperFBind, { damageWeight: 0.8 });
    // Black chin, air-curtain ducts and the carbon splitter blade.
    const chin = cutC(S2, [frontCut(CHIN, 'hem')], { border: 'hem', corner: 0.01 });
    const duct = cutC(S2, [frontCut(grow(CURTAIN, 0.008), 'seam')], { offset: -0.024, border: 'seam' });
    const blade: V3[][] = [];
    const nBlade = opts.lod === 0 ? 12 : 8;
    const bladeT = Array.from({ length: nBlade + 1 }, (_, k) => lerp(0.15, 1, k / nBlade));
    for (const smp of sampleCurve(NOSE_PLAN, bladeT, NOSE_OUT)) {
      const x = Math.abs(smp.p[0]);
      const taper = 1 - smoothstep(0.66, 0.82, x);
      const out = 0.016 + 0.05 * taper;
      const y0 = 0.205;
      const y1 = 0.232 - 0.008 * (1 - taper);
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

    // Headlamps: housing (dark), light guide + projectors + brow (the lit lens), chrome bezels.
    const housing = cutC(S2, [{ fn: (p) => lampShape(p), edge: lens }, uBelow(S2, 1), vAbove(S2, 0)], { corner: 0.008, offset: -0.004, where: (p) => p[1] > 0.52 && p[0] > 0.38 });
    add('headlampHousing', 'light', 'trim', housing.mesh, lampBind, { damageWeight: 0.3 });
    const Y0 = LAMP_Y0 + 0.006;
    const HB = 0.062;
    const hs = 0.22 * HB;
    const yMid = Y0 + hs / 2;
    const xIn = rakeX(yMid) + 0.012;
    const vIn = vAtX(S2f, yMid, xIn);
    const zTail = LAMP_TAIL_Z - (Y0 + hs + 0.007 - LAMP_Y0 - 0.01) / TAIL_SLOPE;
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
    const browX1 = 0.8;
    const vb0 = vAtX(S2f, Y0 + HB, browX1);
    const vb1 = vAtX(S2f, Y0 + HB, browX0);
    const nBrow = opts.lod === 0 ? 24 : 10;
    const brow = surfacePatch(
      S2f,
      1,
      nBrow,
      (i, j) => {
        const v = lerp(vb0, vb1, j / nBrow);
        return { u: uAtY(S2f, v, Y0 + HB - 0.004 * (1 - i)), v, lift: -0.0015 };
      },
      { smoothNormals: true },
    );
    // The lamp shader lays its DRL bands and projector "eyes" out in the (|x|, y) box of every
    // lightHead part: measure it from the parts that span it (guide + brow).
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
    const legTop = Math.min(YB0 + 0.72 * HM, tailTop(legP[2]) - 0.01);
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
    // Projectors at the lamp shader's two "eyes" (centres 34 % / 66 % across, 58 % up).
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
      const br = [rd, rd + 0.002, rd + 0.0044];
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
        const y = lerp(MOUTH_BOT + 0.03, intakeTop(0.78) - 0.035, j / nInd);
        const [u, v] = onFront(S2, mouthOuter(y) - 0.02 - 0.007 * i, y);
        return { u, v, lift: -0.016 };
      },
      { smoothNormals: true },
    );
    for (const s of SIDES) add(`indicatorF${s}`, 'light', 'lightIndicator', perSide(ind, s), bumperFBind, { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
  }

  // ---------------------------------------------------------------- tail (M3)
  // A full-width light bar under the ducktail lip whose ends hook down the
  // corners; body-colour rear panel; bumper with a deep diffuser and quad exhausts.
  const BAR_Y0 = 0.812;
  const BAR_Y1 = 0.848;
  const lampBar = (x: number, y: number): number => Math.min(y - BAR_Y0, BAR_Y1 - y);
  const lampHook = (x: number, y: number): number => Math.min(y - 0.715, BAR_Y1 - y, x - 0.745 - 0.25 * (BAR_Y0 - y));
  const LAMP_R = fv((x, y) => Math.max(lampBar(x, y), lampHook(x, y)));
  const DIFFUSER = fv((x, y) => rmin(0.02, 0.76 - x, 0.405 - 0.035 * smoothstep(0.55, 0.76, x) - y));
  /** Rear fascia band (front view): full width between the lamp hooks, tapering at its ends. */
  const FASCIA = fv((x, y) => rmin(0.03, 0.66 - x - 0.4 * (y - 0.57), y - 0.57, 0.735 - y));
  /** Quad exhausts: two round tips per side. */
  const PIPES: readonly [number, number][] = [
    [0.36, 0.33],
    [0.5, 0.33],
  ];
  const PIPE_R = 0.046;
  const PIPE = fv((x, y) => Math.max(...PIPES.map(([px, py]) => PIPE_R + 0.008 - Math.hypot(x - px, y - py))));
  {
    const bumpTop = 0.52;
    const bandCut = (keepAbove: boolean, edge: Cut['edge']): Cut => frontCut({ sd: (_x, y) => (keepAbove ? y - bumpTop : bumpTop - y) }, edge);
    const b = cutC(S3, [bandCut(false, 'shut'), vAbove(S3, 0), frontCut(neg(DIFFUSER), 'hem'), frontCut(neg(PIPE), 'lip')], { corner: 0.02 });
    add('bumperR', 'bumper', 'paint', b.mesh, ['s12_*'], { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    add('bumperRSeal', 'trim', 'rubber', b.seal, ['s12_*'], { damageWeight: 0, castShadow: false });
    const d = cutC(S3, [frontCut(DIFFUSER, 'hem'), frontCut(neg(PIPE), 'lip')], { offset: -0.003, border: 'seam', corner: 0.02 });
    // Diffuser fins (vertical strakes).
    const fins: PanelMesh[] = [];
    for (const xf of [0.12, 0.25, 0.62]) {
      const fs = frontStrip(S3, (t) => [xf, lerp(0.255, 0.37, t)], 0.004, opts.lod === 0 ? 6 : 3, [-0.002, 0.03, 0.03, -0.002]);
      fins.push(fs, mirrorMesh(fs));
    }
    add('diffuser', 'trim', 'trim', mergeMeshes([d.mesh, ...fins]), ['s12_*'], { damageWeight: 0.8 });
    const rearPanelBind = ['s11_*', 's10_qt_*', 's10_ld*', 's10_rh_*'];
    const up = cutC(S3, [bandCut(true, 'shut'), vAbove(S3, 0), uBelow(S3, 1), frontCut(neg(LAMP_R), 'shut'), frontCut(neg(FASCIA), 'lip')], { corner: 0.012 });
    add('rearPanel', 'body', 'paint', up.mesh, rearPanelBind);
    add('rearPanelSeal', 'trim', 'rubber', up.seal, rearPanelBind, { damageWeight: 0, castShadow: false });
    // Gloss-black fascia recessed between the lamp hooks: carries the plate, breaks up the tail.
    const fascia = cutC(S3, [frontCut(grow(FASCIA, 0.01), 'seam')], { offset: -0.012, border: 'seam', corner: 0.02 });
    add('rearFascia', 'trim', 'trim', fascia.mesh, rearPanelBind, { damageWeight: 0.8 });
    const lampBind = ['s11_*', 's10_qt_*', 's10_rh_*'];
    // Corner hooks (upper half; the lower half is the indicator) cut from the fine ribbon, and the
    // full-width bar as a conforming strip: a 3.6 cm band is thinner than a coarse LOD grid cell.
    const hook = cutC(S3f, [frontCut(LAMP_R, lens), vAbove(S3f, 0, 'hem'), frontCut(fv((x, y) => Math.min(x - 0.72, y - 0.79)), 'hem')], { corner: 0.006, where: (p) => p[1] > 0.7 && p[0] > 0.55 });
    const yBar = (BAR_Y0 + BAR_Y1) / 2;
    const bar = stripMesh(S3, { u0: (v) => uAtY(S3, v, BAR_Y0 + 0.003), u1: (v) => uAtY(S3, v, BAR_Y1 - 0.003), v0: vAtX(S3, yBar, 0.75), v1: 1, segV: opts.lod === 0 ? 24 : 10, offset: -0.0015 });
    const qLamp = cut(S1, [sideCut(Q_LAMP, lens), vBelow(S1, 1, 'hem')], { corner: 0.008, where: (p) => p[2] > 1.82 && p[1] > 0.7 && p[0] > 0.6 });
    add('taillights', 'light', 'lightTail', mergeMeshes([hook.mesh, bar, mirrorMesh(bar), qLamp.mesh, mirrorMesh(qLamp.mesh)]), [...lampBind, 's11_qt_*', 's11_rh_*'], { lights: ['tail', 'brake'], damageWeight: 0.3 });
    // Reverse lamps + reflectors: slim strips low in the bumper corners.
    const rv0 = vAtX(S3, 0.43, 0.7);
    const rv1 = vAtX(S3, 0.43, 0.6);
    const rev = stripMesh(S3, { u0: (v) => uAtY(S3, v, 0.424), u1: (v) => uAtY(S3, v, 0.438), v0: rv0, v1: rv1, segV: 6, offset: 0.0012 });
    add('reverseLamps', 'light', 'lightReverse', mergeMeshes([rev, mirrorMesh(rev)]), ['s12_*'], { lights: ['reverse'], damageWeight: 0.3 });
    const v0r = vAtX(S3, 0.43, 0.84);
    const v1r = vAtX(S3, 0.43, 0.73);
    const refl = stripMesh(S3, { u0: (v) => uAtY(S3, v, 0.424), u1: (v) => uAtY(S3, v, 0.436), v0: v0r, v1: v1r, segV: 8, offset: 0.0012 });
    add('reflectors', 'trim', 'lightTail', mergeMeshes([refl, mirrorMesh(refl)]), ['s12_*'], { damageWeight: 0.3 });
    // Quad exhaust tips: chrome rings behind the diffuser cut-outs.
    const tips: PanelMesh[] = [];
    const bores: PanelMesh[] = [];
    for (const sx of [1, -1])
      for (const [px, py] of PIPES) {
        const secs: V3[][] = [];
        for (const [dz, sc] of [
          [-0.1, 0.9],
          [-0.03, 1],
          [0.012, 1],
          [0.024, 0.93],
        ] as const) {
          const ringPts: V3[] = [];
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            ringPts.push([sx * px + Math.cos(a) * PIPE_R * sc, py + Math.sin(a) * PIPE_R * sc, 2.205 + dz]);
          }
          secs.push(ringPts);
        }
        tips.push(gridLoftMesh(createLoft(secs, { closedU: true }), opts.lod === 0 ? 16 : 10, 5, { flip: sx < 0 }));
        bores.push(roundedBoxMesh([sx * px, py, 2.2], [PIPE_R * 0.78, PIPE_R * 0.78, 0.004], 0.01, { segs: 0 }));
      }
    add('exhaust', 'trim', 'chrome', mergeMeshes(tips), ['s12_*', 's11_rl_*', 's11_tf'], { damageWeight: 0.6 });
    add('exhaustBore', 'trim', 'underbody', mergeMeshes(bores), ['s12_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- lamps: rear indicators (the lower half of each corner hook)
  {
    const indR = cut(S3f, [frontCut(LAMP_R, lens), vAbove(S3f, 0), frontCut(fv((x, y) => Math.min(x - 0.76, 0.79 - y)), 'hem')], { corner: 0.006, where: (p) => p[0] > 0.6 && p[1] > 0.65 });
    for (const s of SIDES) {
      add(`indicatorR${s}`, 'light', 'lightIndicator', perSide(indR.mesh, s), sideBind(['s11_qt_$', 's11_rh_$', 's11_ld_$', 's10_qt_$', 's10_rh_$'], s), { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'], damageWeight: 0.3 });
    }
  }

  // ---------------------------------------------------------------- small exterior parts
  /** Body side x at (z, y) on the right: nearest M1 grid node (side region). */
  const sideX = (z: number, y: number): number => {
    let best = Infinity;
    let bx = 0.9;
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
  {
    // Mirrors: a slim wing-shaped body-colour housing on a stalk from the door's front corner.
    const st: [number, number, number, number, number][] = [
      // x, y centre, z centre, half height, half length
      [0.84, 0.885, -0.5, 0.016, 0.045],
      [0.875, 0.895, -0.5, 0.014, 0.04],
      [0.905, 0.915, -0.497, 0.026, 0.05],
      [0.935, 0.93, -0.492, 0.042, 0.068],
      [0.975, 0.935, -0.49, 0.048, 0.074],
      [1.015, 0.934, -0.489, 0.047, 0.072],
      [1.045, 0.931, -0.489, 0.04, 0.064],
      [1.064, 0.928, -0.489, 0.026, 0.048],
      [1.072, 0.926, -0.489, 0.01, 0.018],
    ];
    const housing = orientMesh(
      gridLoftMesh(
        createLoft(
          st.map(([x, y, z, ly, lz]) => ring(x, y, z, ly, lz, 20, 2.2, 5)),
          { closedU: true },
        ),
        opts.lod === 0 ? 24 : 14,
        opts.lod === 0 ? 10 : 6,
      ),
      [0.98, 0.93, -0.49],
    );
    const glassM = roundedBoxMesh([0.99, 0.933, -0.49 + 0.066], [0.06, 0.038, 0.003], 0.002, { segs: 1 });
    const baseM = roundedBoxMesh([0.845, 0.878, -0.5], [0.018, 0.022, 0.055], 0.01, { segs: SS });
    for (const s of SIDES) {
      // door-mounted mirrors: on the door's front-top corner (they swing with the door)
      const bind = [`d${s}_10`, `d${s}_20`, `d${s}_21`, `d${s}_31`];
      const det = { attach: 'boundary', minBrokenFraction: 0.34, mode: 'hide' } as const;
      add(`mirror${s}`, 'mirror', 'paint', perSide(housing, s), bind, { detach: det, damageWeight: 0.8 });
      add(`mirrorGlass${s}`, 'mirror', 'mirror', perSide(glassM, s), bind, { detach: det, damageWeight: 0 });
      add(`mirrorBase${s}`, 'trim', 'trim', perSide(baseM, s), bind, { damageWeight: 0.5 });
    }
  }
  {
    // Flush door handle just under the shoulder crease, near the door's rear edge.
    const z = 0.3;
    const y = L.ySh(z) - 0.03;
    const hd = roundedBoxMesh([sideX(z, y) + 0.004, y, z], [0.008, 0.012, 0.075], 0.0065, { segs: SS });
    for (const s of SIDES) add(`handle${s}`, 'trim', 'chrome', perSide(hd, s), doorBind(s), { damageWeight: 0.5 });
  }
  {
    // Rear licence plate on the rear panel, centred under the light bar.
    let lo = 0;
    let hi = 1;
    const p: V3 = [0, 0, 0];
    const PY = 0.64;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      S3.surface.point(mid, 1, p);
      if (p[1] < PY) lo = mid;
      else hi = mid;
    }
    const zp = p[2] + 0.007;
    const W = 0.25;
    const H = 0.052;
    const face: PanelMesh = {
      position: [-W, PY - H, zp, W, PY - H, zp, W, PY + H, zp, -W, PY + H, zp],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv: [0, 0, 2 * W, 0, 2 * W, 2 * H, 0, 2 * H],
      tangent: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      index: [0, 1, 2, 0, 2, 3],
    };
    const plateBind = ['s11_*', 's10_qt_*', 's10_ld*', 's10_rh_*'];
    add('plate', 'trim', 'plate', face, plateBind, { damageWeight: 0.6, detach: { attach: 'boundary', minBrokenFraction: 0.5, mode: 'hide' } });
    add('plateFrame', 'trim', 'trim', roundedBoxMesh([0, PY, zp - 0.009], [W + 0.008, H + 0.008, 0.004], 0.003, { segs: 1 }), plateBind, { damageWeight: 0.6 });
  }

  // ---------------------------------------------------------------- wheel wells, underbody, bay
  {
    const liner = (zc: number, xOut: number): PanelMesh => {
      const arcs: V3[][] = [];
      const wall: V3[][] = [];
      const R = ARCH_R + 0.012;
      for (let k = 0; k <= 16; k++) {
        const a = -0.3 + ((Math.PI + 0.6) * k) / 16;
        const y = ARCH_Y + R * Math.sin(a);
        const z = zc - R * Math.cos(a);
        arcs.push([
          [0.6, y, z],
          [0.76, y, z],
          [xOut, y, z],
        ]);
        wall.push([
          [0.6, ARCH_Y + 0.08 * Math.sin(a), zc - 0.08 * Math.cos(a)],
          [0.6, ARCH_Y + 0.25 * Math.sin(a), zc - 0.25 * Math.cos(a)],
          [0.6, y, z],
        ]);
      }
      const ref: V3 = [0.8, ARCH_Y, zc];
      return mergeMeshes([orientMesh(gridLoftMesh(createLoft(arcs), 3, 24), ref, false), orientMesh(gridLoftMesh(createLoft(wall), 2, 24), [0.9, ARCH_Y, zc], false)]);
    };
    const lf = liner(ZF, 0.9);
    const lr = liner(ZR, 0.93);
    for (const s of SIDES) {
      add(`linerF${s}`, 'trim', 'underbody', perSide(lf, s), sideBind(['s1_fd_$', 's1_rh_$', 's2_rl_$', 's2_rh_$', 's2_fd_$', 's3_rl_$', 's3_rh_$', 's3_tw_$', 's3_fd_$', 's4_rl_$', 's4_rh_$', 's4_fd_$', 's5_hp_$', 's5_sl_$'], s), { damageWeight: 0 });
      add(`linerR${s}`, 'trim', 'underbody', perSide(lr, s), sideBind(['s8_sl_$', 's8_qm_$', 's8_fl_$', 's9_rl_$', 's9_rh_$', 's9_tw_$', 's9_qt_$', 's10_rl_$', 's10_rh_$', 's10_qt_$'], s), { damageWeight: 0 });
    }
    const slab = (c: V3, h: V3): PanelMesh => roundedBoxMesh(c, h, 0.006, { segs: 1 });
    add('underbodyF', 'trim', 'underbody', slab([0, 0.22, -1.55], [0.56, 0.006, 0.5]), ['s1_rl_*', 's2_rl_*', 's2_rs', 's3_rl_*', 's4_rl_*', 's2_rh_*'], { damageWeight: 0 });
    add('underbodyM', 'trim', 'underbody', slab([0, 0.19, 0.2], [0.82, 0.006, 0.72]), ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's6_sl_*'], { damageWeight: 0 });
    add('underbodyR', 'trim', 'underbody', slab([0, 0.29, 1.62], [0.56, 0.006, 0.45]), ['s9_rl_*', 's9_tf', 's10_rl_*', 's10_tf', 's11_rl_*', 's11_tf', 's9_rh_*'], { damageWeight: 0 });
    add('engineCover', 'trim', 'trim', roundedBoxMesh([0, 0.7, -1.13], [0.3, 0.06, 0.34], 0.05, { segs: SS }), ['eng_*', 'gbx_*'], { damageWeight: 0.4 });
    add('radiatorSupport', 'trim', 'underbody', roundedBoxMesh([0, 0.53, -1.9], [0.6, 0.09, 0.02], 0.01, { segs: 1 }), ['s1_*', 's2_*'], { damageWeight: 0 });
    add('firewall', 'trim', 'underbody', roundedBoxMesh([0, 0.66, -0.7], [0.72, 0.17, 0.012], 0.008, { segs: 1 }), ['s4_*', 's5_*'], { damageWeight: 0 });
  }

  // ---------------------------------------------------------------- interior
  {
    const floorBind = ['s5_fl_*', 's5_tn', 's6_fl_*', 's6_tn', 's7_fl_*', 's7_tn', 's8_fl_*', 's8_tn', 's6_sl_*'];
    const dashBind = ['s5_*', 's6_dm_*', 's6_bt_*', 's6_sl_*'];
    add('carpet', 'interior', 'interior', roundedBoxMesh([0, 0.235, 0.2], [0.8, 0.02, 0.76], 0.015, { segs: 1 }), floorBind, { damageWeight: 0 });
    const dash = mergeMeshes([
      roundedBoxMesh([0, 0.7, -0.52], [0.8, 0.12, 0.17], 0.06, { segs: SB, rot: rotX(0.14) }),
      roundedBoxMesh([0, 0.8, -0.64], [0.75, 0.045, 0.1], 0.03, { segs: 1 }),
      // Driver binnacle.
      roundedBoxMesh([-0.37, 0.845, -0.4], [0.15, 0.035, 0.07], 0.03, { segs: SB, rot: rotX(-0.15) }),
      // Centre stack sweeping down into the high console.
      roundedBoxMesh([0, 0.55, -0.44], [0.13, 0.18, 0.1], 0.04, { segs: 1 }),
    ]);
    add('dash', 'interior', 'interiorTrim', dash, dashBind, { damageWeight: 0 });
    // Steering wheel (left-hand drive: driver on −x), tilted back, flat-bottomed.
    const tilt = 0.36;
    const wc: V3 = [-0.37, 0.76, -0.28];
    const torus: V3[][] = [];
    const NR = opts.lod === 0 ? 14 : 10;
    for (let k = 0; k <= NR; k++) {
      const a = (k / NR) * Math.PI * 2;
      const sec: V3[] = [];
      for (let q = 0; q < 10; q++) {
        const b = (q / 10) * Math.PI * 2;
        const r = 0.18 + 0.018 * Math.cos(b);
        const flat = Math.sin(a) < -0.8 ? 0.8 / -Math.sin(a) : 1;
        sec.push([Math.cos(a) * r, Math.sin(a) * r * flat, 0.018 * Math.sin(b)]);
      }
      torus.push(sec);
    }
    const wheelLocal = mergeMeshes([
      orientMesh(gridLoftMesh(createLoft(torus, { closedU: true }), opts.lod === 0 ? 5 : 4, NR * 2), [0, 0, 0]),
      roundedBoxMesh([0, -0.01, 0.0], [0.06, 0.045, 0.025], 0.02, { segs: SS }),
      roundedBoxMesh([-0.11, -0.02, 0], [0.07, 0.016, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0.11, -0.02, 0], [0.07, 0.016, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0, -0.1, 0], [0.016, 0.06, 0.01], 0.008, { segs: SS }),
      roundedBoxMesh([0, 0, -0.12], [0.03, 0.03, 0.1], 0.015, { segs: SS }),
    ]);
    const steering = transformMesh(wheelLocal, (q) => {
      const r = rotX(tilt)(q);
      return [r[0] + wc[0], r[1] + wc[1], r[2] + wc[2]];
    });
    add('steering', 'interior', 'interiorTrim', steering, dashBind, { damageWeight: 0 });
    add('console', 'interior', 'interiorTrim', roundedBoxMesh([0, 0.4, 0.0], [0.12, 0.15, 0.42], 0.04, { segs: SB }), ['s5_tn', 's5_fw_*', 's6_tn', 's6_fl_*', 's7_tn', 's7_fl_*', 's5_fl_*'], { damageWeight: 0 });
    // Sport buckets: bolstered cushion + tall back with an integrated headrest.
    const bucket = (x: number, z: number, w: number): PanelMesh =>
      mergeMeshes([
        roundedBoxMesh([x, 0.33, z], [w, 0.06, 0.25], 0.05, { segs: SS }),
        roundedBoxMesh([x, 0.66, z + 0.3], [w, 0.33, 0.065], 0.05, { segs: SB, rot: rotX(-0.32) }),
        roundedBoxMesh([x - w + 0.03, 0.42, z], [0.04, 0.08, 0.24], 0.03, { segs: SS }),
        roundedBoxMesh([x + w - 0.03, 0.42, z], [0.04, 0.08, 0.24], 0.03, { segs: SS }),
        roundedBoxMesh([x - w + 0.025, 0.66, z + 0.29], [0.035, 0.26, 0.07], 0.03, { segs: 1, rot: rotX(-0.32) }),
        roundedBoxMesh([x + w - 0.025, 0.66, z + 0.29], [0.035, 0.26, 0.07], 0.03, { segs: 1, rot: rotX(-0.32) }),
      ]);
    const frontSeatBind = ['s6_fl_*', 's6_tn', 's6_sl_*', 's6_dm_*', 's7_fl_*', 's7_tn', 's7_sl_*', 's7_dm_*', 's7_bt_*', 's6_bt_*'];
    add('seatsFront', 'interior', 'interior', mergeMeshes([bucket(-0.37, 0.1, 0.25), bucket(0.37, 0.1, 0.25)]), frontSeatBind, { damageWeight: 0 });
    // +2 rear seats sculpted into the bulkhead under the fastback.
    const rear = mergeMeshes([
      roundedBoxMesh([-0.36, 0.34, 0.74], [0.22, 0.06, 0.17], 0.05, { segs: SB }),
      roundedBoxMesh([0.36, 0.34, 0.74], [0.22, 0.06, 0.17], 0.05, { segs: SB }),
      roundedBoxMesh([0, 0.6, 0.92], [0.66, 0.24, 0.06], 0.05, { segs: SB, rot: rotX(-0.55) }),
    ]);
    add('rearSeats', 'interior', 'interior', rear, ['s7_fl_*', 's7_tn', 's7_sl_*', 's8_fl_*', 's8_tn', 's8_sl_*', 's8_qm_*', 's8_bt_*'], { damageWeight: 0 });
    for (const s of SIDES) {
      const card = mergeMeshes([
        // subdivided faces so the card follows a dented door skin (see the sedan)
        roundedBoxMesh([0.84, 0.6, -0.08], [0.022, 0.26, 0.5], 0.018, { segs: SS, flat: opts.lod === 0 ? [1, 4, 6] : [1, 2, 3] }),
        roundedBoxMesh([0.8, 0.6, -0.04], [0.035, 0.022, 0.4], 0.015, { segs: SS }),
      ]);
      add(`doorCard${s}`, 'interior', 'interiorTrim', perSide(card, s), doorBind(s), { damageWeight: 0 });
    }
    // Headliner: the greenhouse frame offset inward, facing in.
    // ends inside the windscreen / rear-glass openings (see the sedan: a lining spanning them is a brown sheet once the glass shatters)
    const hl = cutC(S4lo, [uAbove(S4lo, dloTop - 0.01, 'seam'), zAbove(HEADER_Z - 0.02, 'seam'), zBelow(REAR_TOP_Z + 0.02, 'seam'), sideCut({ sd: (_z, y) => y - 0.9 }, 'seam')], { offset: -0.014, border: 'seam' });
    add('headliner', 'interior', 'interior', flipMesh(hl.mesh), ['s5_cw*', 's6_rf*', 's6_bt_*', 's7_rf*', 's7_bt_*', 's8_rf*', 's8_bt_*', 's9_dk*'], { damageWeight: 0, castShadow: false });
  }

  return {
    vehicle: 'coupe',
    // LOD2 (≥ 80 m, far shadows): small parts that are sub-pixel there are left out entirely
    panels: opts.lod === 2 ? panels.filter((p) => !LOD2_DROP.test(p.id)) : panels,
    paint: COUPE_PAINT,
    wheels: {
      rim: { style: 'mesh', spokes: 7, spokeWidth: 0.42, dish: 0.045, lip: 0.016, finish: 'black', boltCount: 5 },
      tire: { tread: 'sport', sidewallText: 'CRUMPLE CORSA', bulge: 0.06 },
      brake: { discRadius: 0.19, caliperColor: 0xd4141c },
    },
    plate: 'VRTX RS',
  };
}

/** Velocity Yellow (the catalog's palettes[0]). */
export const COUPE_PAINT: PaintDef = { color: 0xf2b705, metallic: 0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, flake: null, pearl: 0.15 };

/** The coupe's full-detail visual definition (LOD0). */
export const COUPE_VISUAL: VehicleVisualDef = buildCoupeVisual({ lod: 0 });

/** Interior door cards follow their door skins (binder.ts bindFollower; see the sedan). */
export const COUPE_FOLLOW: Readonly<Record<string, string>> = {
  doorCardR: 'doorR',
  doorCardL: 'doorL',
};

setVisualExtras(COUPE_VISUAL, {
  lods: [once(() => buildCoupeVisual({ lod: 1 })), once(() => buildCoupeVisual({ lod: 2 }))],
  follow: COUPE_FOLLOW,
});
