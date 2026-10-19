/**
 * BOX TRUCK visual definition (P6 F3): a short-hood conventional medium-duty
 * truck with an aluminium box body, wrapping the physics lattice of
 * src/sim/vehicle/defs/boxtruck.ts (wheelbase 4.70, 0.43 m tyres, front
 * track 2.00, dual rear wheels at ±0.735 / ±1.065; frame f0 … f13, cab
 * c0 … c3, box b0 … b7, clip s0 … s2, hood sub-rig hood_{0..3}{L,C,R}).
 *
 * PURE DATA, generated once at module load (deterministic). Surfaces:
 *   CAB master   sections along z from the cowl (z −2.38) to the back wall,
 *                u from the rocker up the door face, belt and roof-side
 *                radius to the roof centre; the front sections are lower
 *                (cowl height), so the loft itself rakes up into the
 *                windscreen and wraps the A-pillar corners. Doors, door
 *                glass and the windscreen are cut from it (real shut lines).
 *   NOSE master  hood + fenders (a fibreglass tilt nose): the hood is the
 *                |x| < 0.755 window (binds the hood sub-rig), the fenders
 *                the outer windows with flared wheel arches.
 *   flat sheets  cab back wall, nose front face (grille + lamp openings).
 *   box          explicit grids (flat aluminium panels, white finish), seam
 *                battens + rivet lines, extruded rails / corner posts, roller
 *                door slats, livery decals (stroke-font lettering).
 *   chassis      ladder rails, crossmembers, axles, leaf springs, shocks,
 *                driveshaft, fuel tank, battery box, exhaust stack, side
 *                guards, steps, mud flaps, rear underride bar.
 *
 * Binding: every panel binds only the rig nodes that carry it (cab skin →
 * cab nodes, box skin → box nodes, chassis parts → frame / axle nodes);
 * the hood binds the hood sub-rig and the bumpers their bumper stations
 * (follow-mode detach). Every slot keeps ONE damage weight, so each slot is
 * one merged draw (≤ 15 body draws + 5 wheel draws).
 */
import { BOXTRUCK } from '../../../sim/vehicle/defs/boxtruck';
import {
  boundsWhere,
  createLoft,
  createSheet,
  cutPanel,
  frontCut,
  gridLoftMesh,
  loftSurface,
  mergeMeshes,
  mirrorMesh,
  orientMesh,
  polyShape,
  roundedBoxMesh,
  roundRectShape,
  rotX,
  rotY,
  rotZ,
  sideCut,
  smooth2,
  toMeshSurface,
  topCut,
  transformMesh,
  type Cut,
  type EdgeStyle,
  type P2,
  type PanelMesh,
  type Shape2,
  type Sheet,
  type V3,
} from '../loft';
import { once, setVisualExtras } from '../lods';
import type { BeamSelector, GlassSpec, MaterialSlot, PaintDef, PanelDef, PanelFinish, PanelKind, VehicleVisualDef } from '../types';
import { VISUAL_DEFAULTS } from '../types';
import { setFinishExtras } from '../weathering';

// ====================================================================== rig-matched dimensions
/** Asserted against compileVehicle(BOXTRUCK) by boxtruck.test.ts. */
export const BOXTRUCK_DIMS = {
  axleFrontZ: -2.75,
  axleRearZ: 1.95,
  halfTrackFront: 1.0,
  dualInnerX: 0.735,
  dualOuterX: 1.065,
  hubY: 0.43,
  tyreRadius: 0.43,
  /** Visual tyre half width (wheels.ts wheelDims: rowHalf 0.1 × 1.36). */
  tyreHalfW: 0.136,
  /** Front wheel-arch opening radius (lip), centred just above the hub. */
  archRadius: 0.53,
  archLift: 0.03,
} as const;

/** Fleet White (catalog palettes[0]): solid single-stage white. */
export const BOXTRUCK_PAINT: PaintDef = { color: 0xeeeeea, metallic: 0, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.06, flake: null };

/**
 * "Valley Freight" livery (fixed colours from the game's PAINT_PALETTE:
 * midnight blue + sunset orange) on the white box; the cab follows the
 * palette.
 */
export const BOXTRUCK_LIVERY = {
  box: 0xf2f1ec,
  rail: 0xbfc3c7,
  roller: 0xe4e4e0,
  blue: 0x0c2148,
  orange: 0xd4470f,
  tapeRed: 0xb3141b,
  tapeWhite: 0xf7f7f2,
  rubber: 0x18191b,
} as const;

const ZF = BOXTRUCK_DIMS.axleFrontZ;
const ZR = BOXTRUCK_DIMS.axleRearZ;
const ARCH_Y = BOXTRUCK_DIMS.hubY + BOXTRUCK_DIMS.archLift;
const ARCH_R = BOXTRUCK_DIMS.archRadius;

/** Box body (rig: BOX_DIMS): walls at |x| 1.24, floor 1.14, roof 3.40, z −0.60 … 3.70. */
const BOX = { x: 1.24, floor: 1.14, roof: 3.4, z0: -0.6, z1: 3.7 } as const;
const BOX_ST = [-0.6, 0.0, 0.62, 1.28, 1.95, 2.6, 3.15, 3.7] as const;
/** Cab: cowl / windscreen base z, header z, back wall z, roof height. */
const CAB = { cowlZ: -2.38, headerZ: -2.1, backZ: -0.87, cowlY: 1.98, roofY: 2.56 } as const;
/** Nose: front face z, rear (cowl) z. */
const NOSE = { z0: -3.64, z1: -2.44 } as const;

// ====================================================================== small math
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const add3 = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const sub3 = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const scale3 = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot3 = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross3 = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm3 = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

// ====================================================================== mesh builders
interface Buf {
  position: number[];
  normal: number[];
  uv: number[];
  tangent: number[];
  index: number[];
}
const newBuf = (): Buf => ({ position: [], normal: [], uv: [], tangent: [], index: [] });
function vert(b: Buf, p: readonly number[], n: readonly number[], u: number, v: number, t: readonly number[] = [1, 0, 0]): number {
  const id = b.position.length / 3;
  b.position.push(p[0]!, p[1]!, p[2]!);
  b.normal.push(n[0]!, n[1]!, n[2]!);
  b.uv.push(u, v);
  b.tangent.push(t[0]!, t[1]!, t[2]!, 1);
  return id;
}

/**
 * Bilinear patch p00 → p10 (u) → p11 / p01 (v) on an nu × nv grid, flat
 * normal, faces wound so the normal agrees with `out` (a direction).
 */
function patch(p00: V3, p10: V3, p01: V3, p11: V3, nu: number, nv: number, out: readonly number[]): PanelMesh {
  const b = newBuf();
  const eu = sub3(p10, p00);
  const ev = sub3(p01, p00);
  let n = norm3(cross3(eu, ev));
  const flip = dot3(n, out) < 0;
  if (flip) n = scale3(n, -1);
  const lu = Math.hypot(...eu);
  const lv = Math.hypot(...ev);
  const t = norm3(eu);
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const s = i / nu;
      const r = j / nv;
      const a = add3(scale3(p00, (1 - s) * (1 - r)), scale3(p10, s * (1 - r)));
      const c = add3(scale3(p01, (1 - s) * r), scale3(p11, s * r));
      vert(b, add3(a, c), n, s * lu, r * lv, t);
    }
  const cols = nu + 1;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const q = j * cols + i;
      if (flip) b.index.push(q, q + cols + 1, q + 1, q, q + cols, q + cols + 1);
      else b.index.push(q, q + 1, q + cols + 1, q, q + cols + 1, q + cols);
    }
  return b;
}

/**
 * Sharp axis-aligned box (centre, half extents) with flat faces: 2 triangles
 * per face. `skip` leaves out the faces whose outward axis is listed (a
 * strip glued to a wall needs no back face): '+x', '-x', '+y', ...
 */
function slab(c: readonly number[], h: readonly number[], skip: readonly string[] = []): PanelMesh {
  const b = newBuf();
  for (let ax = 0; ax < 3; ax++)
    for (const sg of [1, -1]) {
      if (skip.includes(`${sg > 0 ? '+' : '-'}${'xyz'[ax]}`)) continue;
      const n: V3 = [0, 0, 0];
      n[ax] = sg;
      const u = (ax + 1) % 3;
      const v = (ax + 2) % 3;
      const corner = (su: number, sv: number): V3 => {
        const p = [c[0]!, c[1]!, c[2]!];
        p[ax] = p[ax]! + sg * h[ax]!;
        p[u] = p[u]! + su * h[u]!;
        p[v] = p[v]! + sv * h[v]!;
        return [p[0]!, p[1]!, p[2]!];
      };
      const t: V3 = [0, 0, 0];
      t[u] = 1;
      const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map((p, k) => vert(b, p, n, k === 1 || k === 2 ? 2 * h[u]! : 0, k >= 2 ? 2 * h[v]! : 0, t));
      // e_u × e_v = e_ax: CCW seen from +ax.
      if (sg > 0) b.index.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
      else b.index.push(q[0]!, q[2]!, q[1]!, q[0]!, q[3]!, q[2]!);
    }
  return b;
}

/** Axis-aligned rounded box (centre, half extents) — thin parts get r clamped. */
const roundBox = (c: readonly number[], h: readonly number[], r = 0.006, segs = 1, rot?: (p: V3) => V3): PanelMesh =>
  roundedBoxMesh([c[0]!, c[1]!, c[2]!], [h[0]!, h[1]!, h[2]!], r, rot ? { segs, rot } : { segs });

/** Ring of n points about `axis` through c. */
function ring(c: readonly number[], axis: readonly number[], r: number, n: number, phase = 0): V3[] {
  const a = norm3(axis);
  const ref: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm3(cross3(a, ref));
  const e2 = cross3(a, e1);
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const t = phase + (2 * Math.PI * k) / n;
    out.push(add3(c, add3(scale3(e1, r * Math.cos(t)), scale3(e2, r * Math.sin(t)))));
  }
  return out;
}

/** Closed cylinder a → b (radius r, n sides, capped), normals outward. */
function cyl(a: readonly number[], b: readonly number[], r: number, n = 12, caps = true): PanelMesh {
  const axis = sub3(b, a);
  const m = gridLoftMesh(createLoft([ring(a, axis, r, n), ring(b, axis, r, n)], { closedU: true }), n, 1, { capStart: caps, capEnd: caps });
  return orientMesh(m, scale3(add3(a, b), 0.5));
}

/** Tube along a polyline (rings of radius r), open ends unless capped. */
function tube(pts: readonly V3[], r: number, n = 8, caps = true): PanelMesh {
  const secs: V3[][] = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    return ring(p, sub3(next, prev), r, n);
  });
  // Rings from ring() pick their own phase per axis: re-align each to its predecessor (no twist).
  for (let i = 1; i < secs.length; i++) {
    const a = secs[i - 1]!;
    const b = secs[i]!;
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < n; s++) {
      let d = 0;
      for (let k = 0; k < n; k++) d += Math.hypot(...sub3(sub3(b[(k + s) % n]!, pts[i]!), sub3(a[k]!, pts[i - 1]!)));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    secs[i] = Array.from({ length: n }, (_, k) => b[(k + best) % n]!);
  }
  const m = gridLoftMesh(createLoft(secs, { closedU: true }), n, Math.max(1, (pts.length - 1) * 2), { capStart: caps, capEnd: caps });
  // Outward: per vertex the normal must point away from the path; orientMesh against the centroid works for straight-ish tubes.
  let c: V3 = [0, 0, 0];
  for (const p of pts) c = add3(c, scale3(p, 1 / pts.length));
  return orientMesh(m, c);
}

/** Low dome (rivet head / lamp lens bulge) on a plane: centre, outward normal, radius, height, n sides. */
function dome(c: readonly number[], nrm: readonly number[], r: number, h: number, n = 6): PanelMesh {
  const b = newBuf();
  const nn = norm3(nrm);
  const top = vert(b, add3(c, scale3(nn, h)), nn, 0, 0);
  const rim = ring(c, nn, r, n);
  const ids = rim.map((p) => vert(b, p, norm3(add3(sub3(p, c), scale3(nn, r * 0.6))), 0, 0));
  for (let k = 0; k < n; k++) {
    const a = ids[k]!;
    const d = ids[(k + 1) % n]!;
    const f = cross3(sub3(rim[k]!, add3(c, scale3(nn, h))), sub3(rim[(k + 1) % n]!, add3(c, scale3(nn, h))));
    if (dot3(f, nn) >= 0) b.index.push(top, a, d);
    else b.index.push(top, d, a);
  }
  return b;
}

/** Flat disc (lamp lens) facing `nrm`. */
function disc(c: readonly number[], nrm: readonly number[], r: number, n = 14, bulge = 0): PanelMesh {
  return dome(c, nrm, r, bulge, n);
}

/** Thin annulus (bezel) facing nrm. */
function annulus(c: readonly number[], nrm: readonly number[], r0: number, r1: number, n = 18): PanelMesh {
  const b = newBuf();
  const nn = norm3(nrm);
  const a = ring(c, nn, r0, n);
  const o = ring(c, nn, r1, n);
  const ia = a.map((p) => vert(b, p, nn, 0, 0));
  const io = o.map((p) => vert(b, p, nn, 0, 0));
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const f = cross3(sub3(o[k]!, a[k]!), sub3(a[k1]!, a[k]!));
    if (dot3(f, nn) >= 0) b.index.push(ia[k]!, io[k]!, ia[k1]!, ia[k1]!, io[k]!, io[k1]!);
    else b.index.push(ia[k]!, ia[k1]!, io[k]!, ia[k1]!, io[k1]!, io[k]!);
  }
  return b;
}

/** Translate a mesh. */
const moved = (m: PanelMesh, d: readonly number[]): PanelMesh => transformMesh(m, (p) => add3(p, d));

// ====================================================================== stroke font (livery lettering)
/** Glyph strokes on a 0..w × 0..1 box (cap height 1). */
const GLYPHS: Readonly<Record<string, { w: number; s: readonly (readonly [number, number, number, number])[] }>> = {
  V: { w: 0.72, s: [[0, 1, 0.36, 0], [0.36, 0, 0.72, 1]] },
  A: { w: 0.72, s: [[0, 0, 0.36, 1], [0.36, 1, 0.72, 0], [0.16, 0.38, 0.56, 0.38]] },
  L: { w: 0.58, s: [[0, 1, 0, 0], [0, 0, 0.58, 0]] },
  E: { w: 0.58, s: [[0, 0, 0, 1], [0, 1, 0.58, 1], [0, 0.5, 0.48, 0.5], [0, 0, 0.58, 0]] },
  Y: { w: 0.72, s: [[0, 1, 0.36, 0.48], [0.72, 1, 0.36, 0.48], [0.36, 0.48, 0.36, 0]] },
  F: { w: 0.56, s: [[0, 0, 0, 1], [0, 1, 0.56, 1], [0, 0.52, 0.46, 0.52]] },
  R: { w: 0.64, s: [[0, 0, 0, 1], [0, 1, 0.48, 1], [0.48, 1, 0.64, 0.86], [0.64, 0.86, 0.64, 0.66], [0.64, 0.66, 0.48, 0.52], [0.48, 0.52, 0, 0.52], [0.3, 0.52, 0.64, 0]] },
  I: { w: 0.16, s: [[0.08, 0, 0.08, 1]] },
  G: { w: 0.68, s: [[0.68, 0.84, 0.52, 1], [0.52, 1, 0.16, 1], [0.16, 1, 0, 0.84], [0, 0.84, 0, 0.16], [0, 0.16, 0.16, 0], [0.16, 0, 0.52, 0], [0.52, 0, 0.68, 0.16], [0.68, 0.16, 0.68, 0.46], [0.68, 0.46, 0.4, 0.46]] },
  H: { w: 0.66, s: [[0, 0, 0, 1], [0.66, 0, 0.66, 1], [0, 0.5, 0.66, 0.5]] },
  T: { w: 0.7, s: [[0, 1, 0.7, 1], [0.35, 1, 0.35, 0]] },
  S: { w: 0.62, s: [[0.62, 0.86, 0.5, 1], [0.5, 1, 0.12, 1], [0.12, 1, 0, 0.86], [0, 0.86, 0, 0.64], [0, 0.64, 0.12, 0.52], [0.12, 0.52, 0.5, 0.48], [0.5, 0.48, 0.62, 0.36], [0.62, 0.36, 0.62, 0.14], [0.62, 0.14, 0.5, 0], [0.5, 0, 0.12, 0], [0.12, 0, 0, 0.14]] },
  ' ': { w: 0.4, s: [] },
};

/**
 * Lettering as flat stroke quads on a plane: origin = baseline start, `ud` =
 * reading direction (unit), `vd` = up (unit), cap height h, stroke width as a
 * fraction of h, letter spacing as a fraction of h. Faces `nrm`.
 */
function lettering(text: string, origin: V3, ud: V3, vd: V3, nrm: V3, h: number, stroke = 0.15, spacing = 0.18): PanelMesh {
  const parts: PanelMesh[] = [];
  let x = 0;
  const w = stroke * h;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`boxtruck livery: no glyph '${ch}'`);
    for (const [x0, y0, x1, y1] of g.s) {
      const a: P2 = [(x + x0) * h, y0 * h];
      const b: P2 = [(x + x1) * h, y1 * h];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      // Extend half a stroke past each end so corners close; perpendicular half width.
      const ax = a[0] - (dx * w) / 2;
      const ay = a[1] - (dy * w) / 2;
      const bx = b[0] + (dx * w) / 2;
      const by = b[1] + (dy * w) / 2;
      const px = (-dy * w) / 2;
      const py = (dx * w) / 2;
      const P = (u: number, v: number): V3 => add3(origin, add3(scale3(ud, u), scale3(vd, v)));
      parts.push(patch(P(ax - px, ay - py), P(bx - px, by - py), P(ax + px, ay + py), P(bx + px, by + py), 1, 1, nrm));
    }
    x += g.w + spacing;
  }
  return mergeMeshes(parts);
}
/** Text width in units of cap height. */

// ====================================================================== cab master
/** Roof (section top) height at z: the cowl at the windscreen base, rising linearly to the header (a flat raked windscreen). */
const cabTop = (z: number): number => CAB.cowlY + (CAB.roofY - CAB.cowlY) * clamp01((z - CAB.cowlZ) / (CAB.headerZ - CAB.cowlZ));
const CAB_STATIONS = [-2.38, -2.31, -2.24, -2.17, -2.1, -2.02, -1.8, -1.5, -1.2, -0.98, -0.87] as const;
/** u knots of the cab master (control points per section). */
function cabSection(z: number): V3[] {
  const H = cabTop(z);
  const f = clamp01((H - CAB.cowlY) / (CAB.roofY - CAB.cowlY));
  // Rear corner: the back wall edge rolls in over the last 8 cm.
  const back = smoothstep(-0.95, -0.87, z);
  const xs = (x: number): number => x - 0.035 * back * smoothstep(0.6, 1.1, x);
  const pts: [number, number][] = [
    [1.12, 1.02],
    [1.155, 1.1],
    [1.165, 1.5],
    [1.162, 1.93],
    [lerp(1.152, 1.138, f), lerp(1.952, 2.25, f)],
    [lerp(1.125, 1.1, f), lerp(1.962, 2.45, f)],
    [lerp(1.07, 1.04, f), H - 0.015 * f],
    [0.94, H + 0.012],
    [0.5, H + 0.036],
    [0, H + 0.045],
  ];
  return pts.map(([x, y]) => [xs(x), y, z]);
}

// ====================================================================== nose master
/** Hood top height along z (rises toward the cowl). */
const hoodY = (z: number): number => lerp(1.6, 1.765, Math.pow(clamp01((z - NOSE.z0) / (NOSE.z1 - NOSE.z0)), 0.8));
const NOSE_STATIONS = [-3.64, -3.6, -3.52, -3.38, -3.15, -2.9, -2.65, -2.44] as const;
function noseSection(z: number): V3[] {
  const t = clamp01((z - NOSE.z0) / (NOSE.z1 - NOSE.z0));
  const yh = hoodY(z);
  // Front corners round in plan view (the nose tapers over its first 25 cm).
  const taper = lerp(0.935, 1, smoothstep(0, 0.22, t));
  const pts: [number, number][] = [
    [1.1, 0.98],
    [1.138, 1.1],
    [1.152, 1.3],
    [1.142, yh - 0.15],
    [1.1, yh - 0.058],
    [0.98, yh - 0.018],
    [0.765, yh],
    [0.4, yh + 0.022],
    [0, yh + 0.03],
  ];
  return pts.map(([x, y]) => [x === 0 ? 0 : x * (x > 0.7 ? taper : lerp(taper, 1, 0.5)), y, z]);
}

// ====================================================================== glass beams (from the rig: pairs that exist)
const BEAM_KEYS = new Set(BOXTRUCK.body.beams.map((b) => (b.a < b.b ? `${b.a}|${b.b}` : `${b.b}|${b.a}`)));
const existing = (pairs: readonly (readonly [string, string])[]): BeamSelector => {
  const ok = pairs.filter(([a, b]) => BEAM_KEYS.has(a < b ? `${a}|${b}` : `${b}|${a}`));
  if (ok.length === 0) throw new Error(`boxtruck visual: no glass beams among ${pairs.map((p) => p.join('-')).join(', ')}`);
  return { pairs: ok.map(([a, b]) => [a, b] as const) };
};
const GLASS_BEAMS = {
  windscreen: existing(
    (['c0_cw', 'c0_ap_L', 'c0_ap_R'] as const).flatMap((a) =>
      (['c1_rf', 'c1_rf_L', 'c1_rf_R'] as const).filter((b) => !(a.endsWith('_L') && b.endsWith('_L')) && !(a.endsWith('_R') && b.endsWith('_R'))).map((b) => [a, b] as const),
    ),
  ),
  side: (s: 'L' | 'R') =>
    existing([
      [`c1_bt_${s}`, `c2_rf_${s}`],
      [`c1_rf_${s}`, `c2_bt_${s}`],
      [`c2_bt_${s}`, `c3_rf_${s}`],
      [`c2_rf_${s}`, `c3_bt_${s}`],
    ]),
  rear: existing([
    ['c3_bt_R', 'c3_rf'],
    ['c3_bt_L', 'c3_rf'],
    ['c3_bt_R', 'c3_rf_L'],
    ['c3_bt_L', 'c3_rf_R'],
  ]),
};

// ====================================================================== build
export interface BoxtruckBuildOptions {
  /** 0 = full detail, 1 ≈ 40 % (render LOD1 ≥ 25 m), 2 = LOD2 (≥ 80 m, far shadows). */
  lod: 0 | 1 | 2;
}

/**
 * One damage weight per slot: a slot whose panels differ (0 vs > 0) splits
 * into two draws (flexskin groups by the damage variant).
 */
const SLOT_DW: Readonly<Record<MaterialSlot, number>> = {
  paint: 1,
  trim: 0.6,
  chrome: 0.6,
  glass: 0,
  rubber: 0,
  lightHead: 0.3,
  lightTail: 0.3,
  lightIndicator: 0.3,
  lightReverse: 0.3,
  interior: 0,
  interiorTrim: 0,
  grille: 0.6,
  mirror: 0,
  underbody: 0.4,
  plate: 0.6,
  rim: 0,
  tire: 0,
  brakeDisc: 0,
  caliper: 0,
};

/** Panels a LOD2 truck leaves out (rivets, seals, small trim behind / under things). */
const LOD2_DROP = /Seal|^rivets|^interior|^steering|^wipers|^handles|^grab|^roofLamps|^sideMarkers|^tape|^outriggers|^hinges|^strap|^tankStraps|^airTanks|^shocks|^plateF$/;

export function buildBoxtruckVisual(opts: BoxtruckBuildOptions = { lod: 0 }): VehicleVisualDef {
  const lod = opts.lod;
  // LOD1/2: hard-edged boxes (2 triangles a face; the rounded edges are sub-pixel past 25 m).
  const box = (c: readonly number[], h: readonly number[], r = 0.006, segs = 1, rot?: (p: V3) => V3): PanelMesh =>
    lod === 0 || rot ? roundBox(c, h, r, lod === 0 ? segs : 1, rot) : slab(c, h);
  const rs = lod === 0 ? 1 : lod === 1 ? 1.7 : 4.6;
  /** Segment counts for explicit parts. */
  const CYL = lod === 0 ? 14 : lod === 1 ? 10 : 8;
  const panels: PanelDef[] = [];
  const add = (
    id: string,
    kind: PanelKind,
    material: MaterialSlot,
    mesh: PanelMesh,
    bind: readonly string[],
    extra: Partial<Pick<PanelDef, 'detach' | 'glass' | 'lights' | 'castShadow' | 'finish'>> = {},
  ): void => {
    if (mesh.index.length === 0) throw new Error(`boxtruck visual: panel ${id} is empty`);
    panels.push({ id, kind, material, surface: toMeshSurface(mesh), bind, detach: null, damageWeight: SLOT_DW[material], ...extra });
  };
  const SIDES = ['R', 'L'] as const;
  const perSide = (m: PanelMesh, s: 'L' | 'R'): PanelMesh => (s === 'R' ? m : mirrorMesh(m));
  const sideBind = (ids: readonly string[], s: 'L' | 'R'): string[] => ids.map((id) => id.replace(/\$/g, s));
  const boxFinish = (color: number, extra: PanelFinish = {}): PanelFinish => ({ color, solid: true, ...extra });

  // ---------------------------------------------------------------- cut helpers
  const lip: EdgeStyle = { inset: 0.002, roll: 0.003, wall: 0.025, segments: 1, seal: false };
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
      corner: o.corner ?? 0.02,
      offset: o.offset,
      thickness: o.thickness,
      bounds: o.where ? (boundsWhere(sheet, o.where) ?? undefined) : undefined,
      border: o.border ?? lip,
      mirrorX: o.mirror,
    });
  const neg = (s: Shape2): Shape2 => ({ sd: (a, b) => -s.sd(a, b) });
  /** Side-view (z, y) closed polygon, smoothed. */

  // ================================================================ CAB
  const cabLoft = createLoft(CAB_STATIONS.map(cabSection), { symmetric: true });
  const SC = createSheet(loftSurface(cabLoft), { resolution: 0.08 * rs, maxAngleDeg: 12 * rs });
  /** Door outline (side view z, y): front edge raked parallel to the A-pillar above the belt. */
  const DOOR: P2[] = [
    [-2.235, 1.055],
    [-2.235, 1.95],
    [-2.05, 2.43],
    [-1.0, 2.43],
    [-1.0, 1.055],
  ];
  const WIN: P2[] = [
    [-2.15, 1.985],
    [-2.0, 2.375],
    [-1.065, 2.375],
    [-1.065, 1.985],
  ];
  const doorShape = polyShape(DOOR, true);
  const winShape = polyShape(WIN, true);
  /** Windscreen opening in plan (x, z): inside the A-pillars, between the cowl and the header. */
  const wsShape = roundRectShape(0, (CAB.cowlZ + CAB.headerZ) / 2 + 0.002, 0.955, (CAB.headerZ - CAB.cowlZ) / 2 - 0.022, 0.07);
  const cabBind = ['c0_*', 'c1_*', 'c2_*', 'c3_*'];
  {
    const m = cut(SC, [sideCut(neg(doorShape)), topCut(neg(wsShape), 'hem')], { mirror: true, border: 'seam', thickness: lod === 0 ? 0.012 : undefined });
    add('cabShell', 'body', 'paint', m.mesh, cabBind);
  }
  const doorBind = (s: 'L' | 'R'): string[] => sideBind(['c0_hp_$', 'c1_sl_$', 'c1_dm_$', 'c1_bt_$', 'c1_rf_$', 'c2_sl_$', 'c2_dm_$', 'c2_bt_$', 'c2_rf_$', 'c3_sl_$', 'c3_qm_$', 'c3_bt_$'], s);
  {
    const m = cut(SC, [sideCut(doorShape), sideCut(neg(winShape), 'hem')], { where: (p) => p[2] > -2.3 && p[2] < -0.95 && p[0] > 0.9, thickness: lod === 0 ? 0.012 : undefined });
    const g = cut(SC, [sideCut(polyShape(WIN.map(([z, y]) => [z, y] as P2), true), 'seam')], { offset: -0.014, border: 'seam', where: (p) => p[2] > -2.2 && p[2] < -1.0 && p[1] > 1.9 });
    for (const s of SIDES) {
      add(`door${s}`, 'door', 'paint', perSide(m.mesh, s), doorBind(s));
      if (lod < 2) add(`door${s}Seal`, 'trim', 'rubber', perSide(m.seal, s), doorBind(s), { castShadow: false });
      add(`doorGlass${s}`, 'glass', 'glass', perSide(g.mesh, s), doorBind(s), { castShadow: false, glass: glassSpec(false, GLASS_BEAMS.side(s)) });
    }
  }
  {
    const m = cut(SC, [topCut(wsShape, 'seam')], { mirror: true, offset: -0.01, border: 'seam', where: (p) => p[2] < -2.05 && p[1] > 1.9 });
    add('windscreen', 'glass', 'glass', m.mesh, ['c0_cw', 'c0_ap_*', 'c0_hp_*', 'c1_rf*', 'c1_bt_*'], { castShadow: false, glass: glassSpec(true, GLASS_BEAMS.windscreen) });
  }
  // Back wall: flat sheet at the last cab station, outline = that section, with the rear window.
  {
    const sec = cabSection(CAB.backZ);
    const half: P2[] = smooth2(sec.map((p) => [p[0] - 0.004, p[1]] as P2), 6);
    const outline: P2[] = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y] as P2)];
    const z = CAB.backZ - 0.001;
    const sheet = createSheet(loftSurface(createLoft([[[-1.3, 0.98, z], [1.3, 0.98, z]], [[-1.3, 2.75, z], [1.3, 2.75, z]]])), { resolution: 0.08 * Math.min(rs, 1.6) });
    const rw = roundRectShape(0, 2.2, 0.42, 0.16, 0.05);
    const wall = cutPanel({ sheet, cuts: [frontCut(polyShape(outline, true), 'seam'), frontCut(neg(rw), 'hem')], corner: 0.015, border: 'seam' });
    const fix = (m: PanelMesh): PanelMesh => orientMesh(m, [0, 1.8, -1.5]);
    add('cabBack', 'body', 'paint', fix(wall.mesh), ['c3_*', 'c2_rf*', 'c2_bt_*']);
    const glass = cutPanel({ sheet, cuts: [frontCut(rw, 'seam')], corner: 0.01, border: 'seam', offset: 0 });
    add('rearGlass', 'glass', 'glass', moved(fix(glass.mesh), [0, 0, -0.008]), ['c3_*'], { castShadow: false, glass: glassSpec(false, GLASS_BEAMS.rear) });
  }
  // Cowl front face (between the hood's rear edge and the windscreen base) and cab floor / underside.
  add('cowlFace', 'body', 'paint', patch([-1.12, 1.62, CAB.cowlZ - 0.012], [1.12, 1.62, CAB.cowlZ - 0.012], [-1.12, 2.0, CAB.cowlZ - 0.012], [1.12, 2.0, CAB.cowlZ - 0.012], 4, 1, [0, 0, -1]), ['c0_*']);
  add('cabFloor', 'body', 'underbody', box([0, 1.02, -1.62], [1.1, 0.015, 0.74], 0.01), ['c0_fl_*', 'c0_tn', 'c1_fl_*', 'c1_tn', 'c2_fl_*', 'c2_tn', 'c3_fl_*', 'c3_tn', 'c1_sl_*', 'c3_sl_*']);

  // ================================================================ NOSE (hood + fenders + front face)
  const noseLoft = createLoft(NOSE_STATIONS.map(noseSection), { symmetric: true });
  const archDisplace = (p: V3): void => {
    // Fender flare: the wheel-arch lip rolls outward 3 cm.
    if (Math.abs(p[0]) < 0.9) return;
    const d = Math.hypot(p[2] - ZF, p[1] - ARCH_Y) - ARCH_R;
    const w = Math.exp(-((d - 0.04) * (d - 0.04)) / (2 * 0.06 * 0.06)) * smoothstep(1.4, 1.1, p[1]);
    p[0] += Math.sign(p[0]) * 0.03 * w;
  };
  const SN = createSheet(loftSurface(noseLoft, { displace: archDisplace }), { resolution: 0.075 * rs, maxAngleDeg: 12 * rs });
  const hoodShape: Shape2 = { sd: (x) => 0.757 - Math.abs(x) };
  {
    const m = cut(SN, [topCut(hoodShape)], { mirror: true, thickness: lod === 0 ? 0.015 : undefined, where: (p) => p[1] > 1.5 });
    add('hood', 'hood', 'paint', m.mesh, ['hood_*'], { detach: { attach: 'boundary', minBrokenFraction: 0.85, mode: 'follow' } });
    if (lod < 2) add('hoodSeal', 'trim', 'rubber', m.seal, ['hood_*'], { castShadow: false });
  }
  const archCut = (): Cut => sideCut({ sd: (z, y) => Math.hypot(z - ZF, y - ARCH_Y) - ARCH_R }, 'arch');
  const fenderBind = (s: 'L' | 'R'): string[] => sideBind(['s0_fd_$', 's0_rh_$', 's0_rl_$', 's1_ap_$', 's1_ai_$', 's1_fd_$', 's2_ap_$', 's2_ai_$', 's2_fd_$'], s);
  {
    const m = cut(SN, [topCut(neg(hoodShape)), archCut()], { where: (p) => p[0] > 0.6 });
    for (const s of SIDES) add(`fender${s}`, 'fender', 'paint', perSide(m.mesh, s), fenderBind(s));
  }
  // Front face: flat sheet just behind the nose's front section, with the grille and lamp openings.
  const FACE_Z = NOSE.z0 - 0.002;
  const GRILLE = roundRectShape(0, 1.25, 0.6, 0.27, 0.05);
  const LAMP = { x0: 0.665, x1: 1.015, y0: 1.175, y1: 1.425 } as const;
  const lampShape = (sgn: number): Shape2 => roundRectShape(sgn * (LAMP.x0 + LAMP.x1) / 2, (LAMP.y0 + LAMP.y1) / 2, (LAMP.x1 - LAMP.x0) / 2 + 0.006, (LAMP.y1 - LAMP.y0) / 2 + 0.006, 0.03);
  const IND = { x0: 0.8, x1: 1.0, y0: 1.035, y1: 1.115 } as const;
  const indShape = (sgn: number): Shape2 => roundRectShape(sgn * (IND.x0 + IND.x1) / 2, (IND.y0 + IND.y1) / 2, (IND.x1 - IND.x0) / 2 + 0.004, (IND.y1 - IND.y0) / 2 + 0.004, 0.015);
  {
    const sec = noseSection(NOSE.z0);
    const half: P2[] = smooth2(sec.map((p) => [p[0] - 0.006, p[1]] as P2), 6);
    const outline: P2[] = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y] as P2)];
    const sheet = createSheet(loftSurface(createLoft([[[-1.2, 0.96, FACE_Z], [1.2, 0.96, FACE_Z]], [[-1.2, 1.7, FACE_Z], [1.2, 1.7, FACE_Z]]])), { resolution: 0.05 * Math.min(rs, 1.6) });
    const holes = [GRILLE, lampShape(1), lampShape(-1), indShape(1), indShape(-1)].map((h) => frontCut(neg(h), 'lip'));
    const face = cutPanel({ sheet, cuts: [frontCut(polyShape(outline, true), 'seam'), ...holes], corner: 0.012, border: 'seam' });
    add('noseFace', 'body', 'paint', orientMesh(face.mesh, [0, 1.25, -1]), ['s0_*']);
  }
  // Grille: dark mesh insert, chrome surround and horizontal bars, centre badge.
  {
    add('grilleMesh', 'grille', 'grille', patch([-0.6, 0.98, FACE_Z + 0.06], [0.6, 0.98, FACE_Z + 0.06], [-0.6, 1.52, FACE_Z + 0.06], [0.6, 1.52, FACE_Z + 0.06], 4, 2, [0, 0, -1]), ['s0_*']);
    const bars: PanelMesh[] = [];
    for (let k = 0; k < 6; k++) bars.push(box([0, 1.03 + k * 0.088, FACE_Z + 0.02], [0.585, 0.014, 0.012], 0.006));
    // Surround: four bars hugging the opening.
    bars.push(box([0, 1.528, FACE_Z - 0.006], [0.62, 0.016, 0.012], 0.008), box([0, 0.972, FACE_Z - 0.006], [0.62, 0.016, 0.012], 0.008));
    for (const sx of [1, -1]) bars.push(box([sx * 0.612, 1.25, FACE_Z - 0.006], [0.016, 0.29, 0.012], 0.008));
    add('grilleBars', 'grille', 'chrome', mergeMeshes(bars), ['s0_*']);
    const badge = mergeMeshes([box([0, 1.425, FACE_Z - 0.02], [0.11, 0.035, 0.008], 0.01), box([0, 1.425, FACE_Z - 0.026], [0.07, 0.016, 0.006], 0.004)]);
    add('badge', 'trim', 'trim', badge, ['s0_*']);
  }
  // Headlamps: recessed housing, lens, chrome projector bezels (the lamp shader draws the eyes at 34 % / 66 %).
  {
    const housing: PanelMesh[] = [];
    const lens: PanelMesh[] = [];
    const bezels: PanelMesh[] = [];
    const W = LAMP.x1 - LAMP.x0;
    const H = LAMP.y1 - LAMP.y0;
    for (const sx of [1, -1]) {
      const cx = (sx * (LAMP.x0 + LAMP.x1)) / 2;
      housing.push(box([cx, (LAMP.y0 + LAMP.y1) / 2, FACE_Z + 0.03], [W / 2 + 0.004, H / 2 + 0.004, 0.03], 0.01));
      const nx = lod === 0 ? 8 : 3;
      lens.push(patch([sx * LAMP.x0, LAMP.y0, FACE_Z - 0.004], [sx * LAMP.x1, LAMP.y0, FACE_Z - 0.004], [sx * LAMP.x0, LAMP.y1, FACE_Z - 0.004], [sx * LAMP.x1, LAMP.y1, FACE_Z - 0.004], nx, Math.max(2, nx >> 1), [0, 0, -1]));
      for (const f of [0.34, 0.66]) {
        const c: V3 = [sx * (LAMP.x0 + f * W), LAMP.y0 + 0.58 * H, FACE_Z - 0.009];
        bezels.push(annulus(c, [0, 0, -1], 0.27 * H * 0.9, 0.27 * H * 1.12, lod === 0 ? 20 : 10));
      }
    }
    add('lampHousings', 'trim', 'trim', mergeMeshes(housing), ['s0_*']);
    add('headlights', 'light', 'lightHead', mergeMeshes(lens), ['s0_*'], { lights: ['head', 'highBeam'] });
    add('projectorBezels', 'trim', 'chrome', mergeMeshes(bezels), ['s0_*']);
    for (const s of SIDES) {
      const sx = s === 'R' ? 1 : -1;
      const ind = patch([sx * IND.x0, IND.y0, FACE_Z - 0.004], [sx * IND.x1, IND.y0, FACE_Z - 0.004], [sx * IND.x0, IND.y1, FACE_Z - 0.004], [sx * IND.x1, IND.y1, FACE_Z - 0.004], 2, 1, [0, 0, -1]);
      add(`indicatorF${s}`, 'light', 'lightIndicator', ind, ['s0_*'], { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'] });
    }
  }
  // Front bumper (chrome steel), plate, tow hooks.
  const bumperBind = ['bf_*'];
  {
    const bz = -3.79;
    const main = box([0, 0.69, bz], [1.0, 0.17, 0.065], 0.035, lod === 0 ? 3 : 1);
    const ends = SIDES.map((s) => {
      const sx = s === 'R' ? 1 : -1;
      return box([sx * 1.075, 0.69, bz + 0.06], [0.085, 0.165, 0.06], 0.03, lod === 0 ? 2 : 1, rotY(sx * 0.5));
    });
    add('bumperF', 'bumper', 'chrome', mergeMeshes([main, ...ends]), bumperBind, { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    const plateFace = patch([-0.17, 0.62, bz - 0.068], [0.17, 0.62, bz - 0.068], [-0.17, 0.77, bz - 0.068], [0.17, 0.77, bz - 0.068], 1, 1, [0, 0, -1]);
    add('plateF', 'trim', 'plate', plateFace, bumperBind);
    add('towHooks', 'trim', 'trim', mergeMeshes(SIDES.map((s) => box([(s === 'R' ? 1 : -1) * 0.48, 0.5, bz - 0.02], [0.03, 0.05, 0.06], 0.012))), bumperBind);
  }
  // Fender details: side vents (louvres behind the arch), side repeaters.
  {
    const vents: PanelMesh[] = [];
    for (let k = 0; k < 5; k++) vents.push(box([1.155, 1.43 - k * 0.045, -2.62], [0.006, 0.012, 0.12], 0.004));
    for (const s of SIDES) add(`fenderVents${s}`, 'trim', 'trim', perSide(mergeMeshes(vents), s), fenderBind(s));
    const rep = box([1.153, 1.32, -3.42], [0.008, 0.022, 0.05], 0.008);
    for (const s of SIDES) add(`repeater${s}`, 'light', 'lightIndicator', perSide(rep, s), fenderBind(s), { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'] });
  }
  // Wheel-well liners behind the front arches (dark), engine block seen through the arches.
  {
    const liner: V3[][] = [];
    const R = ARCH_R + 0.01;
    for (let k = 0; k <= 14; k++) {
      const a = -0.25 + ((Math.PI + 0.5) * k) / 14;
      const y = ARCH_Y + R * Math.sin(a);
      const z = ZF - R * Math.cos(a);
      liner.push([
        [0.78, y, z],
        [0.95, y, z],
        [1.12, y, z],
      ]);
    }
    const lm = orientMesh(gridLoftMesh(createLoft(liner), 2, 18), [1.0, ARCH_Y, ZF], false);
    for (const s of SIDES) add(`linerF${s}`, 'trim', 'underbody', perSide(lm, s), fenderBind(s));
  }

  // ================================================================ cab details
  {
    // Sun visor over the windscreen + roof marker lamps (amber ID lamps, five across).
    const visor = box([0, CAB.roofY + 0.035, CAB.headerZ - 0.1], [1.0, 0.012, 0.12], 0.008, 1, rotX(-0.18));
    add('visor', 'trim', 'trim', visor, ['c0_cw', 'c0_ap_*', 'c1_rf*', 'c1_bt_*']);
    const lamps: PanelMesh[] = [];
    for (const x of [-0.36, -0.18, 0, 0.18, 0.36]) lamps.push(box([x, CAB.roofY + 0.064, CAB.headerZ - 0.05], [0.04, 0.022, 0.03], 0.012));
    // Cab clearance lamps: amber markers, lit with the tail lamps.
    add('roofLamps', 'light', 'lightIndicator', mergeMeshes(lamps), ['c1_rf*', 'c2_rf*', 'c1_bt_*'], { lights: ['tail'] });
  }
  {
    // West-coast mirrors: tall head on two arms + a round spot mirror below; detach = hide.
    const head = box([1.42, 2.14, -2.18], [0.035, 0.2, 0.09], 0.025, lod === 0 ? 2 : 1);
    const glassM = patch([1.395, 1.96, -2.1], [1.395, 1.96, -2.26], [1.395, 2.32, -2.1], [1.395, 2.32, -2.26], 1, 1, [0, 0, 1]);
    const arms = mergeMeshes([
      tube([[1.16, 2.3, -2.18], [1.3, 2.32, -2.18], [1.4, 2.3, -2.18]], 0.012, 6),
      tube([[1.16, 1.86, -2.18], [1.32, 1.9, -2.18], [1.4, 1.96, -2.18]], 0.012, 6),
    ]);
    const spot = mergeMeshes([cyl([1.37, 1.74, -2.21], [1.37, 1.74, -2.27], 0.1, CYL), tube([[1.38, 1.86, -2.2], [1.37, 1.8, -2.22]], 0.01, 6)]);
    const spotGlass = disc([1.37, 1.74, -2.172], [0, 0, 1], 0.09, CYL);
    for (const s of SIDES) {
      const bind = sideBind(['c0_hp_$', 'c0_ap_$', 'c0_fw_$', 'c0_cw', 'c1_dm_$', 'c1_bt_$', 'c1_rf_$', 'c1_rf', 'c1_sl_$'], s);
      const det = { attach: 'boundary', minBrokenFraction: 0.34, mode: 'hide' } as const;
      add(`mirror${s}`, 'mirror', 'trim', perSide(mergeMeshes([head, arms, spot]), s), bind, { detach: det });
      add(`mirrorGlass${s}`, 'mirror', 'mirror', perSide(mergeMeshes([glassM, spotGlass]), s), bind, { detach: det });
    }
  }
  {
    // Door handles (chrome paddles) + grab handles on the B-pillar (back corner) + hinges.
    const handle = box([1.172, 1.86, -1.12], [0.012, 0.025, 0.08], 0.01);
    const grab = tube([[1.17, 1.32, -0.93], [1.205, 1.34, -0.93], [1.205, 2.12, -0.93], [1.17, 2.14, -0.93]], 0.014, 6);
    const hinges = mergeMeshes([box([1.168, 1.36, -2.22], [0.01, 0.04, 0.025], 0.006), box([1.168, 1.8, -2.22], [0.01, 0.04, 0.025], 0.006)]);
    for (const s of SIDES) {
      add(`handles${s}`, 'trim', 'chrome', perSide(handle, s), doorBind(s));
      add(`grab${s}`, 'trim', 'chrome', perSide(grab, s), sideBind(['c3_sl_$', 'c3_qm_$', 'c3_bt_$', 'c2_dm_$', 'c2_bt_$', 'c2_sl_$'], s));
      add(`hinges${s}`, 'trim', 'chrome', perSide(hinges, s), sideBind(['c0_hp_$', 'c0_sl_$', 'c1_sl_$', 'c1_dm_$', 'c1_bt_$'], s));
    }
  }
  {
    // Wipers parked on the cowl.
    const w = mergeMeshes([box([-0.42, 2.02, CAB.cowlZ + 0.02], [0.36, 0.008, 0.012], 0.005, 1, rotZ(0.04)), box([0.4, 2.02, CAB.cowlZ + 0.02], [0.36, 0.008, 0.012], 0.005, 1, rotZ(-0.04))]);
    add('wipers', 'trim', 'rubber', w, ['c0_cw', 'c0_ap_*', 'c1_rf*']);
  }
  {
    // Steps under each door (two treads on a bracket), the battery-box lid doubles as the bottom step on the right.
    const steps = mergeMeshes([
      box([1.07, 0.8, -1.92], [0.1, 0.012, 0.24], 0.006),
      box([1.06, 0.5, -1.92], [0.11, 0.012, 0.24], 0.006),
      box([1.0, 0.64, -2.15], [0.012, 0.2, 0.02], 0.005),
      box([1.0, 0.64, -1.69], [0.012, 0.2, 0.02], 0.005),
    ]);
    for (const s of SIDES) add(`steps${s}`, 'trim', 'chrome', perSide(steps, s), sideBind(['c0_sl_$', 'c1_sl_$', 'c1_dm_$', 'c2_sl_$', 'c2_dm_$', 'c1_fl_$', 'c2_fl_$'], s));
  }
  {
    // Exhaust stack behind the cab (right): pipe, perforated heat shield, curved tip.
    const pipe = tube([[0.98, 1.0, -0.74], [0.98, 2.9, -0.74], [0.98, 3.04, -0.7], [0.98, 3.1, -0.62]], 0.06, CYL);
    const shield = cyl([0.98, 1.6, -0.74], [0.98, 2.35, -0.74], 0.075, CYL);
    const clamps = mergeMeshes([box([1.0, 1.7, -0.8], [0.03, 0.02, 0.05], 0.006), box([1.0, 2.3, -0.8], [0.03, 0.02, 0.05], 0.006)]);
    add('exhaust', 'trim', 'chrome', mergeMeshes([pipe, shield]), ['c3_*', 'c2_bt_R', 'c2_rf_R'], {});
    add('exhaustClamps', 'trim', 'trim', clamps, ['c3_*']);
  }
  // ---------------------------------------------------------------- interior
  if (lod < 2) {
    const dashBind = ['c0_*', 'c1_*'];
    const dash = mergeMeshes([box([0, 1.72, -2.22], [1.05, 0.14, 0.12], 0.05, 1, rotX(0.2)), box([-0.5, 1.85, -2.14], [0.3, 0.06, 0.08], 0.03, 1, rotX(-0.25))]);
    add('interiorDash', 'interior', 'interiorTrim', dash, dashBind);
    const wc: V3 = [-0.5, 1.82, -1.96];
    const torus: V3[][] = [];
    const NR = lod === 0 ? 16 : 10;
    for (let k = 0; k <= NR; k++) {
      const a = (k / NR) * Math.PI * 2;
      const sec: V3[] = [];
      for (let q = 0; q < 8; q++) {
        const b = (q / 8) * Math.PI * 2;
        const r = 0.24 + 0.018 * Math.cos(b);
        sec.push([Math.cos(a) * r, Math.sin(a) * r, 0.018 * Math.sin(b)]);
      }
      torus.push(sec);
    }
    const wheelLocal = mergeMeshes([orientMesh(gridLoftMesh(createLoft(torus, { closedU: true }), 6, NR * 2), [0, 0, 0]), box([0, 0, 0], [0.07, 0.07, 0.03], 0.03), box([0, -0.12, 0], [0.02, 0.12, 0.012], 0.008)]);
    const steering = transformMesh(wheelLocal, (q) => add3(rotX(-1.05)(q), wc));
    add('steering', 'interior', 'interiorTrim', mergeMeshes([steering, tube([wc, [-0.5, 1.6, -2.2]], 0.03, 6)]), dashBind);
    const seat = (x: number, w: number): PanelMesh =>
      mergeMeshes([box([x, 1.48, -1.3], [w, 0.08, 0.26], 0.05), box([x, 1.92, -1.02], [w, 0.36, 0.07], 0.06, 1, rotX(-0.18)), box([x, 2.36, -0.96], [w * 0.5, 0.09, 0.06], 0.04, 1, rotX(-0.18))]);
    add('interiorSeats', 'interior', 'interior', mergeMeshes([seat(-0.55, 0.26), seat(0.42, 0.42), box([0, 1.25, -1.35], [0.95, 0.12, 0.3], 0.04)]), ['c1_fl_*', 'c1_tn', 'c2_*', 'c3_*']);
    add('interiorPanels', 'interior', 'interior', mergeMeshes(SIDES.map((s) => perSide(box([1.11, 1.55, -1.6], [0.025, 0.35, 0.55], 0.02), s))), ['c1_*', 'c2_*', 'c3_*']);
  }

  // ================================================================ CHASSIS
  {
    // Ladder rails: C-channel (web outboard, flanges inward) from the horns to the rear crossmember.
    const R0 = -3.62;
    const R1 = 3.7;
    const nz = lod === 0 ? 30 : 10;
    const rail = (s: 'L' | 'R'): PanelMesh => {
      const sx = s === 'R' ? 1 : -1;
      const x = sx * 0.455;
      const xi = sx * 0.375;
      return mergeMeshes([
        patch([x, 0.7, R0], [x, 0.7, R1], [x, 0.98, R0], [x, 0.98, R1], nz, 2, [sx, 0, 0]),
        patch([x, 0.98, R0], [x, 0.98, R1], [xi, 0.98, R0], [xi, 0.98, R1], nz, 1, [0, 1, 0]),
        patch([x, 0.7, R0], [x, 0.7, R1], [xi, 0.7, R0], [xi, 0.7, R1], nz, 1, [0, -1, 0]),
        patch([xi, 0.7, R0], [xi, 0.7, R1], [xi, 0.74, R0], [xi, 0.74, R1], nz, 1, [-sx, 0, 0]),
        patch([xi, 0.94, R0], [xi, 0.94, R1], [xi, 0.98, R0], [xi, 0.98, R1], nz, 1, [-sx, 0, 0]),
      ]);
    };
    for (const s of SIDES) add(`rail${s}`, 'body', 'underbody', rail(s), sideBind(['f*_lo_$', 'f*_hi_$'], s).map((id) => id));
    const cms: PanelMesh[] = [];
    for (const z of [-3.62, -2.32, -0.6, 0.62, 1.28, 2.6, 3.7]) cms.push(box([0, 0.8, z], [0.375, 0.09, 0.04], 0.01));
    add('crossmembers', 'body', 'underbody', mergeMeshes(cms), ['f0_*', 'f3_*', 'f6_*', 'f8_*', 'f9_*', 'f11_*', 'f13_*']);
  }
  {
    // Front I-beam axle with kingpin bosses; leaf springs (4 leaves) under the rails; shocks.
    const beam = mergeMeshes([
      box([0, 0.37, ZF], [0.62, 0.05, 0.05], 0.015),
      box([0.75, 0.43, ZF], [0.14, 0.05, 0.05], 0.015, 1, rotZ(0.35)),
      box([-0.75, 0.43, ZF], [0.14, 0.05, 0.05], 0.015, 1, rotZ(-0.35)),
      cyl([0.88, 0.3, ZF], [0.88, 0.6, ZF], 0.05, 10),
      cyl([-0.88, 0.3, ZF], [-0.88, 0.6, ZF], 0.05, 10),
    ]);
    add('axleF', 'body', 'underbody', beam, ['FA_kT_*', 'FA_kB_*', 'FA_sp_*', 'FA_st_*', 'FA_c']);
    const leaf = (zc: number, x: number, yAx: number, half: number): PanelMesh => {
      const parts: PanelMesh[] = [];
      for (let k = 0; k < 4; k++) {
        const l = half * (1 - 0.18 * k);
        const pts: V3[] = [];
        for (let i = 0; i <= 8; i++) {
          const t = -1 + (2 * i) / 8;
          pts.push([x, yAx + 0.035 + 0.11 * t * t - k * 0.016, zc + l * t]);
        }
        parts.push(tube(pts, 0.008, 4));
      }
      return mergeMeshes(parts);
    };
    const leafF = leaf(ZF, 0.45, 0.47, 0.62);
    for (const s of SIDES) add(`leafF${s}`, 'body', 'underbody', perSide(leafF, s), sideBind(['FA_kT_$', 'FA_kB_$', 'FA_sp_$', 'f1_lo_$', 'f2_lo_$', 'f3_lo_$', 'f2_hi_$'], s));
    const leafR = leaf(ZR, 0.5, 0.58, 0.7);
    for (const s of SIDES) add(`leafR${s}`, 'body', 'underbody', perSide(leafR, s), sideBind(['RA_kU_$', 'RA_ab_$', 'RA_af_$', 'f9_lo_$', 'f10_lo_$', 'f11_lo_$', 'f10_hi_$'], s));
    if (lod < 2) {
      const shocks: PanelMesh[] = [];
      for (const sx of [1, -1]) {
        shocks.push(cyl([sx * 0.66, 0.46, ZF + 0.12], [sx * 0.62, 0.86, ZF + 0.16], 0.035, 8));
        shocks.push(cyl([sx * 0.62, 0.46, ZR - 0.14], [sx * 0.6, 0.86, ZR - 0.2], 0.04, 8));
      }
      add('shocks', 'body', 'underbody', mergeMeshes(shocks), ['FA_*', 'RA_kU_*', 'RA_ab_*', 'RA_af_*', 'RA_D', 'f2_*', 'f10_*']);
    }
    // Rear axle: housing tube, diff pumpkin, hub drums.
    const housing = mergeMeshes([
      cyl([-0.86, 0.43, ZR], [0.86, 0.43, ZR], 0.075, CYL),
      orientMesh(gridLoftMesh(createLoft([ring([0, 0.43, ZR - 0.28], [0, 0, 1], 0.06, CYL), ring([0, 0.43, ZR - 0.12], [0, 0, 1], 0.2, CYL), ring([0, 0.43, ZR + 0.12], [0, 0, 1], 0.19, CYL), ring([0, 0.43, ZR + 0.18], [0, 0, 1], 0.1, CYL)], { closedU: true }), CYL, 6, { capStart: true, capEnd: true }), [0, 0.43, ZR]),
    ]);
    add('axleR', 'body', 'underbody', housing, ['RA_kU_*', 'RA_ae_*', 'RA_ab_*', 'RA_af_*', 'RA_D']);
    // Driveshaft: gearbox → centre bearing → pinion.
    const ds = mergeMeshes([cyl([0, 0.82, -1.45], [0, 0.66, 0.1], 0.05, 8), cyl([0, 0.66, 0.1], [0, 0.46, ZR - 0.3], 0.05, 8), box([0, 0.69, 0.1], [0.08, 0.06, 0.04], 0.01)]);
    add('driveshaft', 'body', 'underbody', ds, ['gbx_*', 'f5_lo_*', 'f6_lo_*', 'f7_*', 'f8_lo_*', 'f9_lo_*', 'RA_D', 'kb0_*', 'kb1_*']);
  }
  {
    // Fuel tank (left, polished aluminium) on straps; battery box + air tanks (right).
    const tankBind = sideBind(['kb0_$', 'f4_lo_$', 'f5_lo_$', 'f6_lo_$', 'f5_hi_$', 'gd0_$', 'c3_sl_$', 'c2_sl_$'], 'L');
    const tank = orientMesh(
      gridLoftMesh(
        createLoft(
          [-1.48, -1.46, -1.42, -0.66, -0.62, -0.6].map((z, i) => {
            const r = [0.2, 0.25, 0.27, 0.27, 0.25, 0.2][i]!;
            return ring([-0.86, 0.66, z], [0, 0, 1], r, lod === 0 ? 20 : 12);
          }),
          { closedU: true },
        ),
        lod === 0 ? 20 : 12,
        lod === 0 ? 10 : 5,
        { capStart: true, capEnd: true },
      ),
      [-0.86, 0.66, -1.04],
    );
    add('fuelTank', 'body', 'chrome', tank, tankBind);
    add('tankStraps', 'trim', 'trim', mergeMeshes([-1.25, -0.85].map((z) => cyl([-0.86, 0.66, z - 0.02], [-0.86, 0.66, z + 0.02], 0.275, lod === 0 ? 20 : 12, false))), tankBind);
    add('fuelCap', 'trim', 'chrome', cyl([-1.0, 0.9, -1.2], [-1.0, 0.95, -1.2], 0.05, 10), tankBind);
    const battBind = sideBind(['kb0_$', 'f4_lo_$', 'f5_lo_$', 'f6_lo_$', 'f5_hi_$', 'gd0_$', 'c3_sl_$', 'c2_sl_$'], 'R');
    add('batteryBox', 'body', 'trim', box([0.82, 0.68, -1.06], [0.3, 0.2, 0.36], 0.02), battBind);
    add('batteryLid', 'body', 'chrome', box([0.84, 0.885, -1.06], [0.3, 0.012, 0.37], 0.01), battBind);
    if (lod < 2) add('airTanks', 'body', 'underbody', mergeMeshes([cyl([-0.2, 0.55, -0.4], [-0.2, 0.55, 0.5], 0.12, 10), cyl([0.2, 0.55, -0.4], [0.2, 0.55, 0.5], 0.12, 10)]), ['kb0_*', 'kb1_*', 'f6_lo_*', 'f7_lo_*', 'f8_lo_*']);
  }
  {
    // Engine sump / gearbox under the cab (seen from the side) — the block itself hides under the hood.
    add('engine', 'body', 'underbody', mergeMeshes([box([0, 0.95, -2.85], [0.32, 0.3, 0.55], 0.06), box([0, 0.86, -1.8], [0.2, 0.15, 0.4], 0.05)]), ['eng_*', 'gbx_*']);
  }
  {
    // Side underrun guards: two aluminium rails on brackets between the axles.
    const g = mergeMeshes([
      box([1.17, 0.5, 0.35], [0.025, 0.04, 0.98], 0.012),
      box([1.17, 0.74, 0.35], [0.025, 0.04, 0.98], 0.012),
      ...[-0.55, 0.05, 0.65, 1.25].map((z) => box([1.15, 0.86, z], [0.02, 0.3, 0.025], 0.006)),
    ]);
    for (const s of SIDES) add(`guards${s}`, 'body', 'chrome', perSide(g, s), sideBind(['gd*_$', 'b0_fl_$', 'b1_fl_$', 'b2_fl_$', 'b3_fl_$', 'b0_fi_$', 'b1_fi_$', 'b2_fi_$', 'b3_fi_$'], s));
  }
  {
    // Rear underride (ICC) bar + struts; red / white tape.
    const bar = mergeMeshes([box([0, 0.5, 3.8], [1.1, 0.06, 0.05], 0.012), ...[0.45, -0.45].map((x) => box([x, 0.72, 3.74], [0.04, 0.22, 0.04], 0.01))]);
    add('bumperR', 'bumper', 'underbody', bar, ['br_*'], { detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' } });
    const tapes: PanelMesh[] = [];
    for (let k = 0; k < 8; k++) tapes.push(patch([-1.08 + k * 0.27, 0.47, 3.852], [-0.95 + k * 0.27, 0.47, 3.852], [-1.08 + k * 0.27, 0.53, 3.852], [-0.95 + k * 0.27, 0.53, 3.852], 1, 1, [0, 0, 1]));
    add('tapeIcc', 'trim', 'paint', mergeMeshes(tapes), ['br_*'], { finish: boxFinish(BOXTRUCK_LIVERY.tapeRed) });
  }
  {
    // Mud flaps behind the duals on a chrome bar.
    const flap = mergeMeshes([patch([0.62, 0.2, 2.5], [1.2, 0.2, 2.5], [0.62, 0.86, 2.5], [1.2, 0.86, 2.5], 3, 3, [0, 0, 1]), patch([0.62, 0.2, 2.49], [1.2, 0.2, 2.49], [0.62, 0.86, 2.49], [1.2, 0.86, 2.49], 1, 1, [0, 0, -1])]);
    const flapBar = box([0.91, 0.88, 2.5], [0.31, 0.02, 0.02], 0.008);
    for (const s of SIDES) {
      const bind = sideBind(['b4_fl_$', 'b4_fi_$', 'b4_wl_$', 'b5_fl_$', 'b5_fi_$', 'b5_wl_$', 'b4_cg', 'b5_cg'], s);
      add(`mudFlap${s}`, 'trim', 'rubber', perSide(flap, s), bind);
      add(`flapBar${s}`, 'trim', 'chrome', perSide(flapBar, s), bind);
    }
  }

  // ================================================================ BOX
  const boxWhite = boxFinish(BOXTRUCK_LIVERY.box, { dirt: 0.12 });
  const railFin = boxFinish(BOXTRUCK_LIVERY.rail);
  const nz = Math.max(4, Math.round(4.3 / (0.12 * rs)));
  const ny = Math.max(3, Math.round(2.2 / (0.12 * rs)));
  const wallBind = (s: 'L' | 'R'): string[] => sideBind(['b*_fl_$', 'b*_wl_$', 'b*_wm_$', 'b*_rl_$'], s);
  {
    for (const s of SIDES) {
      const sx = s === 'R' ? 1 : -1;
      const x = sx * BOX.x;
      add(`boxSide${s}`, 'body', 'paint', patch([x, 1.2, BOX.z0 + 0.06], [x, 1.2, BOX.z1 - 0.07], [x, 3.33, BOX.z0 + 0.06], [x, 3.33, BOX.z1 - 0.07], nz, ny, [sx, 0, 0]), wallBind(s), { finish: boxWhite });
    }
    const nx = Math.max(3, Math.round(2.4 / (0.14 * rs)));
    add('boxFront', 'body', 'paint', patch([-1.2, 1.2, BOX.z0], [1.2, 1.2, BOX.z0], [-1.2, 3.34, BOX.z0], [1.2, 3.34, BOX.z0], nx, ny, [0, 0, -1]), ['b0_*'], { finish: boxWhite });
    add('boxRoof', 'roof', 'paint', patch([-1.2, BOX.roof, BOX.z0 + 0.05], [1.2, BOX.roof, BOX.z0 + 0.05], [-1.2, BOX.roof, BOX.z1 - 0.05], [1.2, BOX.roof, BOX.z1 - 0.05], nx, nz, [0, 1, 0]), ['b*_rl_*', 'b*_rc'], { finish: boxFinish(BOXTRUCK_LIVERY.box) });
    // Extruded rails: bottom (sill) and top along the sides, corner posts at the front, rear posts + header + sill.
    const rails: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      rails.push(box([sx * (BOX.x + 0.005), 1.15, 1.55], [0.02, 0.065, 2.16], 0.012));
      rails.push(box([sx * (BOX.x + 0.005), 3.37, 1.55], [0.02, 0.055, 2.16], 0.012));
      rails.push(box([sx * (BOX.x - 0.01), 2.27, BOX.z0 + 0.02], [0.035, 1.18, 0.035], 0.02));
      rails.push(box([sx * 1.16, 2.25, BOX.z1 + 0.01], [0.09, 1.18, 0.04], 0.012));
    }
    rails.push(box([0, 3.32, BOX.z1 + 0.01], [1.24, 0.11, 0.045], 0.012), box([0, 1.12, BOX.z1 + 0.01], [1.24, 0.08, 0.06], 0.012));
    rails.push(box([0, BOX.roof + 0.008, BOX.z0 + 0.02], [1.24, 0.03, 0.035], 0.012));
    add('boxRails', 'body', 'paint', mergeMeshes(rails), ['b*_fl_*', 'b*_rl_*', 'b0_*', 'b7_*'], { finish: railFin });
    // Seam battens (the sheet-and-post joints), one per station + midway.
    const battens: PanelMesh[] = [];
    const seamZ: number[] = [];
    for (let i = 0; i + 1 < BOX_ST.length; i++) seamZ.push((BOX_ST[i]! + BOX_ST[i + 1]!) / 2);
    for (let i = 1; i + 1 < BOX_ST.length; i++) seamZ.push(BOX_ST[i]!);
    seamZ.sort((a, b) => a - b);
    for (const z of seamZ) battens.push(slab([BOX.x + 0.003, 2.26, z], [0.004, 1.06, 0.022], ['-x']));
    for (const s of SIDES) add(`battens${s}`, 'body', 'paint', perSide(mergeMeshes(battens), s), wallBind(s), { finish: railFin });
    if (lod < 2) {
      // LOD1 keeps the panel (same ids as LOD0) with 3-sided heads on every other rivet.
      const rv: PanelMesh[] = [];
      const step = lod === 0 ? 0.16 : 0.32;
      const sides = lod === 0 ? 5 : 3;
      for (const z of seamZ) for (let y = 1.28; y < 3.28; y += step) rv.push(dome([BOX.x + 0.008, y, z], [1, 0, 0], 0.007, 0.004, sides));
      for (let z = BOX.z0 + 0.12; z < BOX.z1 - 0.08; z += step) {
        rv.push(dome([BOX.x + 0.026, 1.16, z], [1, 0, 0], 0.007, 0.004, sides));
        rv.push(dome([BOX.x + 0.026, 3.37, z], [1, 0, 0], 0.007, 0.004, sides));
      }
      for (const s of SIDES) add(`rivets${s}`, 'body', 'paint', perSide(mergeMeshes(rv), s), wallBind(s), { finish: railFin });
    }
    // Floor crossmember ends (outriggers) under the sills.
    if (lod < 2) {
      const out: PanelMesh[] = [];
      for (let z = BOX.z0 + 0.15; z < BOX.z1; z += 0.3) out.push(slab([1.1, 1.04, z], [0.12, 0.035, 0.025], ['-x', '+y']));
      for (const s of SIDES) add(`outriggers${s}`, 'body', 'underbody', perSide(mergeMeshes(out), s), sideBind(['b*_fl_$', 'b*_fi_$'], s));
    }
    // Box floor underside.
    add('boxFloor', 'body', 'underbody', patch([-1.2, 1.0, BOX.z0], [1.2, 1.0, BOX.z0], [-1.2, 1.0, BOX.z1], [1.2, 1.0, BOX.z1], 4, 8, [0, -1, 0]), ['b*_fi_*', 'b*_fl_*', 'b*_fc']);
  }
  {
    // Rear: roller door (slats), handle, lock, pull strap.
    const slats: PanelMesh[] = [];
    const N = lod === 0 ? 13 : 7;
    const y0 = 1.22;
    const y1 = 3.2;
    const h = (y1 - y0) / N;
    for (let k = 0; k < N; k++) {
      const ya = y0 + k * h;
      const z = BOX.z1 + 0.03;
      slats.push(patch([-1.06, ya + 0.004, z], [1.06, ya + 0.004, z], [-1.06, ya + h * 0.55, z + 0.008], [1.06, ya + h * 0.55, z + 0.008], lod === 0 ? 8 : 3, 1, [0, 0, 1]));
      slats.push(patch([-1.06, ya + h * 0.55, z + 0.008], [1.06, ya + h * 0.55, z + 0.008], [-1.06, ya + h - 0.004, z], [1.06, ya + h - 0.004, z], lod === 0 ? 8 : 3, 1, [0, 0, 1]));
    }
    add('rollerDoor', 'trunk', 'paint', mergeMeshes(slats), ['b7_*'], { finish: boxFinish(BOXTRUCK_LIVERY.roller, { dirt: 0.2 }) });
    add('doorHandle', 'trim', 'chrome', mergeMeshes([box([0, 1.32, BOX.z1 + 0.06], [0.16, 0.018, 0.02], 0.008), box([0.42, 1.3, BOX.z1 + 0.055], [0.05, 0.05, 0.015], 0.006)]), ['b7_*']);
    if (lod < 2) add('strap', 'trim', 'rubber', box([-0.3, 1.5, BOX.z1 + 0.05], [0.025, 0.3, 0.004], 0.002), ['b7_*']);
  }
  {
    // Rear lamps: round tail / brake pairs, amber indicators, white reverse, in black grommet plates; clearance lamps up top.
    const z = BOX.z1 + 0.075;
    const plates: PanelMesh[] = [];
    const tails: PanelMesh[] = [];
    const revs: PanelMesh[] = [];
    for (const sx of [1, -1]) {
      plates.push(box([sx * 0.78, 1.1, BOX.z1 + 0.07], [0.36, 0.075, 0.008], 0.01));
      for (const x of [1.06, 0.92]) tails.push(disc([sx * x, 1.1, z], [0, 0, 1], 0.058, CYL, 0.012));
      revs.push(disc([sx * 0.52, 1.1, z], [0, 0, 1], 0.05, CYL, 0.01));
    }
    for (const x of [-0.18, 0, 0.18]) tails.push(box([x, 3.32, BOX.z1 + 0.058], [0.035, 0.02, 0.012], 0.008));
    for (const sx of [1, -1]) tails.push(box([sx * 1.15, 3.35, BOX.z1 + 0.058], [0.03, 0.02, 0.012], 0.008));
    add('lampPlates', 'trim', 'trim', mergeMeshes(plates), ['b7_*']);
    add('taillights', 'light', 'lightTail', mergeMeshes(tails), ['b7_*'], { lights: ['tail', 'brake'] });
    add('reverseLamps', 'light', 'lightReverse', mergeMeshes(revs), ['b7_*'], { lights: ['reverse'] });
    for (const s of SIDES) add(`indicatorR${s}`, 'light', 'lightIndicator', disc([(s === 'R' ? 1 : -1) * 0.7, 1.1, z], [0, 0, 1], 0.05, CYL, 0.01), ['b7_*'], { lights: [s === 'R' ? 'indicatorR' : 'indicatorL'] });
    const plateR = patch([-0.17, 1.22, BOX.z1 + 0.07], [0.17, 1.22, BOX.z1 + 0.07], [-0.17, 1.37, BOX.z1 + 0.07], [0.17, 1.37, BOX.z1 + 0.07], 1, 1, [0, 0, 1]);
    add('plateR', 'trim', 'plate', plateR, ['b7_*']);
  }
  if (lod < 2) {
    // Side marker lamps (amber front, red rear) on the sills; conspicuity tape (red / white) along the sills.
    const amber = mergeMeshes([box([BOX.x + 0.03, 1.15, BOX.z0 + 0.18], [0.008, 0.025, 0.04], 0.008), box([BOX.x + 0.03, 1.15, 1.55], [0.008, 0.025, 0.04], 0.008)]);
    const red = box([BOX.x + 0.03, 1.15, BOX.z1 - 0.15], [0.008, 0.025, 0.04], 0.008);
    for (const s of SIDES) {
      add(`sideMarkersA${s}`, 'light', 'lightIndicator', perSide(amber, s), wallBind(s), { lights: ['tail'] });
      add(`sideMarkersR${s}`, 'light', 'lightTail', perSide(red, s), wallBind(s), { lights: ['tail'] });
    }
    const tapeR: PanelMesh[] = [];
    const tapeW: PanelMesh[] = [];
    let k = 0;
    for (let z = BOX.z0 + 0.3; z + 0.3 < BOX.z1 - 0.2; z += 0.3, k++) {
      const p = patch([BOX.x + 0.027, 1.2, z], [BOX.x + 0.027, 1.2, z + 0.3], [BOX.x + 0.027, 1.24, z], [BOX.x + 0.027, 1.24, z + 0.3], 1, 1, [1, 0, 0]);
      (k % 2 ? tapeW : tapeR).push(p);
    }
    for (const s of SIDES) {
      add(`tapeRed${s}`, 'trim', 'paint', perSide(mergeMeshes(tapeR), s), wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.tapeRed) });
      add(`tapeWhite${s}`, 'trim', 'paint', perSide(mergeMeshes(tapeW), s), wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.tapeWhite) });
    }
  }
  {
    // LIVERY: a midnight-blue band with an orange pinstripe along the lower sides, "VALLEY" over "FREIGHT"
    // in the band colour, and the VF monogram on the box nose above the cab.
    const off = 0.006;
    for (const s of SIDES) {
      const sx = s === 'R' ? 1 : -1;
      const nrm: V3 = [sx, 0, 0];
      // Reading direction: toward the front on the right side, toward the rear on the left.
      const ud: V3 = [0, 0, -sx];
      const zStart = sx > 0 ? 3.3 : -0.2;
      // Decals sit just proud of the seam battens (behind them a narrow stroke vanished: "FRE GHT").
      const xt = sx * (BOX.x + 0.0095);
      const band = patch([xt, 1.3, BOX.z0 + 0.1], [xt, 1.3, BOX.z1 - 0.12], [xt, 1.62, BOX.z0 + 0.1], [xt, 1.62, BOX.z1 - 0.12], lod === 0 ? 12 : 4, 1, nrm);
      const pin = patch([xt, 1.66, BOX.z0 + 0.1], [xt, 1.66, BOX.z1 - 0.12], [xt, 1.7, BOX.z0 + 0.1], [xt, 1.7, BOX.z1 - 0.12], lod === 0 ? 12 : 4, 1, nrm);
      add(`liveryBand${s}`, 'trim', 'paint', band, wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.blue) });
      add(`liveryStripe${s}`, 'trim', 'paint', pin, wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.orange) });
      const big = lettering('VALLEY', [xt, 2.32, zStart], ud, [0, 1, 0], nrm, 0.62, 0.17, 0.2);
      const small = lettering('FREIGHT', [xt, 1.93, zStart + (sx > 0 ? -0.02 : 0.02)], ud, [0, 1, 0], nrm, 0.26, 0.17, 0.42);
      add(`liveryText${s}`, 'trim', 'paint', mergeMeshes([big, small]), wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.blue) });
      // Orange swoosh: a slanted parallelogram ahead of the lettering.
      const zs = sx > 0 ? -0.15 : 3.25;
      const sw = patch([xt, 2.0, zs], [xt, 2.0, zs - 0.55 * sx], [xt, 3.05, zs + 0.25 * -sx], [xt, 3.05, zs - 0.3 * sx], 2, 3, nrm);
      add(`liverySwoosh${s}`, 'trim', 'paint', sw, wallBind(s), { finish: boxFinish(BOXTRUCK_LIVERY.orange) });
    }
    const nose = mergeMeshes([
      // Read from ahead of the truck: left-to-right is −X.
      lettering('VF', [0.3, 2.78, BOX.z0 - off], [-1, 0, 0], [0, 1, 0], [0, 0, -1], 0.42, 0.18, 0.12),
      patch([-0.75, 2.66, BOX.z0 - off], [0.75, 2.66, BOX.z0 - off], [-0.75, 2.7, BOX.z0 - off], [0.75, 2.7, BOX.z0 - off], 3, 1, [0, 0, -1]),
    ]);
    add('liveryNose', 'trim', 'paint', nose, ['b0_*'], { finish: boxFinish(BOXTRUCK_LIVERY.blue) });
    const doorText = lettering('VALLEY FREIGHT', [-0.82, 2.72, BOX.z1 + 0.05], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.17, 0.17, 0.28);
    add('liveryDoor', 'trim', 'paint', doorText, ['b7_*'], { finish: boxFinish(BOXTRUCK_LIVERY.blue) });
  }

  return {
    vehicle: 'boxtruck',
    panels: lod === 2 ? panels.filter((p) => !LOD2_DROP.test(p.id)) : panels,
    paint: { ...BOXTRUCK_PAINT },
    wheels: {
      rim: { style: 'steel', spokes: 10, spokeWidth: 0.62, dish: 0.06, lip: 0.016, finish: 'silver', boltCount: 10 },
      tire: { tread: 'street', sidewallText: 'CRUMPLE HAUL 245/70R19.5', bulge: 0.07 },
      brake: { discRadius: 0.17, caliperColor: 0x1b1c1e },
      mirrored: ['RLi', 'RRi'],
    },
    plate: 'VF 6500',
  };
}

function glassSpec(laminated: boolean, beams: BeamSelector): GlassSpec {
  return {
    laminated,
    beams,
    crackStrain: laminated ? 0.015 : 0.025,
    shatterStrain: laminated ? 0.05 : 0.045,
    crackImpulse: laminated ? 160 : 200,
    shatterImpulse: laminated ? 800 : 480,
    shatterBrokenFraction: 0.34,
  };
}

/** The box truck's full-detail visual definition (LOD0). */
export const BOXTRUCK_VISUAL: VehicleVisualDef = buildBoxtruckVisual({ lod: 0 });

setVisualExtras(BOXTRUCK_VISUAL, {
  lods: [once(() => buildBoxtruckVisual({ lod: 1 })), once(() => buildBoxtruckVisual({ lod: 2 }))],
});
// Road grime grows from the front arches (the rear duals sit under the box floor).
setFinishExtras(BOXTRUCK_VISUAL, { arches: [{ z: ZF, y: ARCH_Y, r: ARCH_R, xMin: 0.95 }] });

// (Shut-gap reference for tests.)
export const BOXTRUCK_SHUT_GAP = VISUAL_DEFAULTS.shutGap;
// Silence unused-import lint for helpers kept for LOD variants.
