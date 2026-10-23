/**
 * Prop visual definitions (U2): realistic procedural models per catalog key,
 * authored in the PROP frame (Y up, base on y = 0, front −Z; rig node
 * layouts in src/sim/props/defs/*.ts) and bound to the catalog rig so every
 * prop dents, folds and crushes with its nodes.
 *
 * Pure (no three): build → tessellate → bind. Panels of slender truss
 * members (sign post, light pole shaft) carry `chain` and are bound by
 * ./chain.ts; every other panel goes through bindRigPanels.
 */
import { compilePropRig } from '../../sim/props/catalog';
import type { PropKey } from '../../sim/props/types';
import type { CompiledRig } from '../../sim/rig/types';
import { bindRigPanels } from '../vehicle/binder';
import { tessellateSurface } from '../vehicle/loft';
import type { BindingPanel, BindingSet, PanelDef } from '../vehicle/types';
import { bindChainPanel, chainLevels, countLevels } from './chain';
import { MeshBuilder, disc, gridQuad, lathe, rotZ, roundedBox, tube, type ProfilePoint, type UvRect, type V3 } from './shapes';
import type { PropMaterialSlot, PropVisualDef } from './types';

/** Panel variants (flexFrameU.w) understood by the hooks. */
export const PROP_VARIANT = {
  /** Default surface of the slot. */
  main: 0,
  /** conePlastic: black recycled-rubber base; barrelPaint: lid; rubber: plain grain; galvanized: dark painted lamp housing. */
  alt: 1,
  /** conePlastic: inside of the shell; barrelPaint: zinc bung caps; galvanized: base flange (rusty). */
  inner: 2,
} as const;

/** Circumferential tread grooves (v fraction across the tread band, width fraction): mesh notches + tread map agree. */
export const TIRE_GROOVES: readonly { v: number; w: number }[] = [
  { v: 0.3, w: 0.07 },
  { v: 0.5, w: 0.07 },
  { v: 0.7, w: 0.07 },
];

/** A prop panel: PanelDef + the material variant (flexFrameU.w) + optional chain binding. */
export interface PropPanelDef extends PanelDef<PropMaterialSlot> {
  variant?: number;
  /** Bind as a truss member: node levels `${prefix}${l}_{0..2}` (./chain.ts). */
  chain?: { prefix: string };
}
export interface PropVisual extends PropVisualDef {
  readonly panels: readonly PropPanelDef[];
}

function panel(
  id: string,
  material: PropMaterialSlot,
  b: MeshBuilder,
  bind: string[],
  extra: Partial<PropPanelDef> = {},
): PropPanelDef {
  return { id, kind: 'body', material, surface: b.toSurface(), bind, detach: null, ...extra };
}

/** Detail factor of the visual being built (LOD0 1, LOD1 PROP_LOD1_DETAIL); set by propVisual around the builders. */
let Q = 1;
/** Segment count / grid step at the current detail. */
const seg = (n: number): number => Math.max(6, Math.round(n * Q));
const st = (step: number): number => step / Q;

/** Points along y in [y0, y1] with ≤ step spacing (inclusive), r from f(y). */
function profileRange(y0: number, y1: number, step: number, f: (y: number) => number): ProfilePoint[] {
  const n = Math.max(1, Math.ceil(Math.abs(y1 - y0) / step));
  const out: ProfilePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    out.push({ r: f(y), y });
  }
  return out;
}

// ============================================================ cone
function coneVisual(): PropVisual {
  const SEG = 32;
  const rAt = (y: number): number => 0.142 - ((0.142 - 0.026) * (y - 0.06)) / 0.63;
  const shellBind = ['base_*', 'shell_*', 'tip'];
  const panels: PropPanelDef[] = [];
  // Recycled-rubber base: 0.38 m square slab with rounded edges.
  const base = new MeshBuilder();
  roundedBox(base, [0, 0.0175, 0], [0.19, 0.0175, 0.19], { radius: 0.012, step: st(0.05) });
  panels.push(panel('base', 'conePlastic', base, ['base_*'], { variant: PROP_VARIANT.alt }));
  // Collar: the shell flares into the base (black moulded foot).
  const collar = new MeshBuilder();
  lathe(
    collar,
    [
      { r: 0.178, y: 0.035, n: [0.2, 1] },
      { r: 0.168, y: 0.041 },
      { r: 0.155, y: 0.05 },
      { r: 0.146, y: 0.058 },
      { r: rAt(0.07), y: 0.07, n: [1, 0.184] },
    ],
    { segments: seg(SEG), uRepeat: 3, vScale: 4 },
  );
  panels.push(panel('collar', 'conePlastic', collar, shellBind, { variant: PROP_VARIANT.alt }));
  // Shell (orange) split around the two reflective sleeves; sleeves stand 1.2 mm proud with crease steps.
  const slope = (0.142 - 0.026) / 0.63;
  const nCone: [number, number] = [1, slope];
  const orange = (id: string, y0: number, y1: number, top = false): void => {
    const b = new MeshBuilder();
    const pts: ProfilePoint[] = profileRange(y0, y1, st(0.02), rAt).map((p) => ({ ...p, n: nCone }));
    if (top) {
      pts.pop();
      pts.push({ r: rAt(y1), y: y1, n: nCone }, { r: 0.02, y: y1 + 0.009 }, { r: 0.01, y: y1 + 0.013 }, { r: 0, y: y1 + 0.0145, n: [0, 1] });
    }
    lathe(b, pts, { segments: seg(SEG), uRepeat: 3, vScale: 4 });
    panels.push(panel(id, 'conePlastic', b, shellBind));
  };
  const sleeve = (id: string, y0: number, y1: number): void => {
    const b = new MeshBuilder();
    const d = 0.0012;
    const pts: ProfilePoint[] = [{ r: rAt(y0), y: y0, n: [-0.05, -1] }, { r: rAt(y0) + d, y: y0, crease: true }];
    for (const p of profileRange(y0, y1, st(0.02), (y) => rAt(y) + d).slice(1)) pts.push({ ...p, n: nCone });
    pts.push({ r: rAt(y1), y: y1, n: [0.05, 1] });
    lathe(b, pts, { segments: seg(SEG), uRepeat: 10, vScale: 20 });
    panels.push(panel(id, 'reflective', b, shellBind));
  };
  orange('shellLow', 0.07, 0.34);
  sleeve('bandLow', 0.34, 0.42);
  orange('shellMid', 0.42, 0.48);
  sleeve('bandHigh', 0.48, 0.6);
  orange('shellTop', 0.6, 0.69, true);
  return { prop: 'cone', panels };
}

// ============================================================ barrel
function barrelVisual(): PropVisual {
  const SEG = 44;
  const R = 0.2875; // wall
  const panels: PropPanelDef[] = [];
  // Rolling hoops (two swaged ribs) + rolled chimes, as one lathe from the bottom chime to the top chime.
  const prof: ProfilePoint[] = [
    { r: 0.272, y: 0.0, n: [0, -1] },
    { r: 0.288, y: 0.0015 },
    { r: 0.2955, y: 0.008 },
    { r: 0.2965, y: 0.015 },
    { r: 0.293, y: 0.023 },
    { r: R + 0.0005, y: 0.03, crease: true },
  ];
  const hoop = (yc: number): void => {
    prof.push({ r: R, y: yc - 0.03 }, { r: R + 0.004, y: yc - 0.016 }, { r: R + 0.0085, y: yc - 0.006 }, { r: R + 0.009, y: yc }, { r: R + 0.0085, y: yc + 0.006 }, { r: R + 0.004, y: yc + 0.016 }, { r: R, y: yc + 0.03 });
  };
  // fine swage lines near the chimes + the two hoops, wall points every ~4 cm between
  const wall = (y0: number, y1: number): void => {
    for (const p of profileRange(y0, y1, st(0.05), () => R).slice(1, -1)) prof.push(p);
  };
  prof.push({ r: R, y: 0.06 }, { r: R + 0.0018, y: 0.07 }, { r: R, y: 0.08 });
  wall(0.08, 0.263);
  hoop(0.293);
  wall(0.323, 0.557);
  hoop(0.587);
  wall(0.617, 0.8);
  prof.push({ r: R, y: 0.8 }, { r: R + 0.0018, y: 0.81 }, { r: R, y: 0.82 }, { r: R + 0.0005, y: 0.85, crease: true });
  prof.push({ r: 0.293, y: 0.857 }, { r: 0.2965, y: 0.865 }, { r: 0.2955, y: 0.872 }, { r: 0.288, y: 0.8785 }, { r: 0.276, y: 0.88, n: [-0.2, 1] });
  // inside of the top chime down to the lid
  prof.push({ r: 0.271, y: 0.877 }, { r: 0.2695, y: 0.868, n: [-1, 0.1] }, { r: 0.268, y: 0.862, n: [-0.4, 1] });
  const body = new MeshBuilder();
  lathe(body, prof, { segments: seg(SEG), uRepeat: 1.8, vScale: 1 });
  panels.push(panel('drum', 'barrelPaint', body, ['rim*', 'lidT_c', 'lidB_c']));
  // Top lid: embossed ring, bungs (zinc caps).
  const lid = new MeshBuilder();
  lathe(
    lid,
    [
      { r: 0.268, y: 0.862, n: [0, 1] },
      { r: 0.215, y: 0.862, n: [0, 1] },
      { r: 0.205, y: 0.8655 },
      { r: 0.195, y: 0.862, n: [0, 1] },
      { r: 0.11, y: 0.861, n: [0, 1] },
      { r: 0.0, y: 0.861, n: [0, 1] },
    ],
    { segments: seg(SEG), uRepeat: 1.8 },
  );
  panels.push(panel('lidTop', 'barrelPaint', lid, ['rim*', 'lidT_c', 'lidB_c'], { variant: PROP_VARIANT.alt }));
  const bungs = new MeshBuilder();
  for (const [x, z, r] of [
    [0.17, 0.07, 0.034],
    [-0.19, 0.0, 0.02],
  ] as const) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        { r: r + 0.008, y: 0.861, n: [0, 1] },
        { r: r + 0.006, y: 0.866 },
        { r, y: 0.869, n: [0.3, 1] },
        { r: r * 0.6, y: 0.871, n: [0, 1] },
        { r: 0, y: 0.871, n: [0, 1] },
      ],
      { segments: seg(20) },
    );
    b.transform((p) => p, [x, 0, z]);
    bungs.append(b);
  }
  panels.push(panel('bungs', 'barrelPaint', bungs, ['rim*', 'lidT_c', 'lidB_c'], { variant: PROP_VARIANT.inner }));
  const bottom = new MeshBuilder();
  disc(bottom, 0.0, 0, 0.272, -1, seg(SEG), 3);
  panels.push(panel('lidBottom', 'barrelPaint', bottom, ['rim*', 'lidT_c', 'lidB_c'], { variant: PROP_VARIANT.alt }));
  return { prop: 'barrel', panels };
}

// ============================================================ tire
function tireVisual(): PropVisual {
  const SEG = 56;
  const H = 0.2;
  const RT = 0.325; // tread
  const RB = 0.203; // bead
  const RS = 0.312; // shoulder junction
  const yLo = 0.035;
  const yHi = H - 0.035;
  const treadV = (y: number): number => 0.25 + 0.248 * Math.min(1, Math.max(0, (y - yLo) / (yHi - yLo)));
  const sideV = (r: number): number => 0.002 + 0.244 * Math.min(1, Math.max(0, (r - RB) / (RS - RB)));
  const b = new MeshBuilder();
  // upper sidewall (bead → shoulder)
  const upper: ProfilePoint[] = (
    [
    { r: RB, y: 0.182, n: [-0.5, 0.87] },
    { r: 0.208, y: 0.19 },
    { r: 0.216, y: 0.1945 },
    { r: 0.222, y: 0.196 },
    { r: 0.228, y: 0.1955 },
    { r: 0.24, y: 0.197 },
    { r: 0.26, y: 0.1992 },
    { r: 0.28, y: 0.2 },
    { r: 0.296, y: 0.1985 },
    { r: 0.305, y: 0.196 },
    { r: RS, y: 0.192, n: [0.6, 0.8] },
    ] as ProfilePoint[]
  ).map((p) => ({ ...p, v: sideV(p.r) }));
  lathe(b, upper, { segments: seg(SEG), uRepeat: 1 });
  // tread with three circumferential grooves (the tread map's groove walls land on them)
  const tread: ProfilePoint[] = [
    { r: RS, y: 0.192, n: [0.6, 0.8] },
    { r: 0.3195, y: 0.184 },
    { r: 0.3235, y: 0.175 },
    { r: RT, y: yHi },
  ];
  const grooves = TIRE_GROOVES.map((g) => yLo + (yHi - yLo) * g.v).sort((p, q) => q - p);
  const gw = (yHi - yLo) * TIRE_GROOVES[0]!.w * 0.5;
  let y = yHi;
  for (const gc of grooves) {
    const top = gc + gw;
    if (y - top > 0.012) tread.push({ r: RT, y: (y + top) / 2, n: [1, 0] });
    tread.push({ r: RT, y: top, crease: true }, { r: RT - 0.008, y: top - 0.001, crease: true }, { r: RT - 0.008, y: gc - gw + 0.001, crease: true }, { r: RT, y: gc - gw, crease: true });
    y = gc - gw;
  }
  tread.push({ r: RT, y: (y + yLo) / 2, n: [1, 0] }, { r: RT, y: yLo }, { r: 0.3235, y: 0.025 }, { r: 0.3195, y: 0.016 }, { r: RS, y: 0.008, n: [0.6, -0.8] });
  lathe(
    b,
    tread.map((p) => ({ ...p, v: treadV(p.y) })),
    { segments: seg(SEG), uRepeat: 3 },
  );
  // lower sidewall (shoulder → bead)
  lathe(
    b,
    upper
      .slice()
      .reverse()
      .map((p) => ({ ...p, y: H - p.y, n: p.n ? ([p.n[0], -p.n[1]] as const) : undefined })),
    { segments: seg(SEG), uRepeat: 1 },
  );
  // bead hole wall
  lathe(
    b,
    ([
      { r: RB, y: H - 0.182, n: [-0.5, -0.87] },
      { r: 0.2, y: 0.03 },
      { r: 0.1985, y: 0.06 },
      { r: 0.198, y: 0.1 },
      { r: 0.1985, y: 0.14 },
      { r: 0.2, y: 0.17 },
      { r: RB, y: 0.182, n: [-0.5, 0.87] },
    ] as ProfilePoint[]).map((p) => ({ ...p, v: 0.55 + p.y })),
    { segments: seg(SEG), uRepeat: 4, inward: false },
  );
  return { prop: 'tire', panels: [panel('tyre', 'rubber', b, ['tI_*', 'tO_*', 'tT_*'])] };
}

// ============================================================ boxes
const inset = (r: UvRect, e = 0.004): UvRect => ({ u0: r.u0 + e, v0: r.v0 + e, u1: r.u1 - e, v1: r.v1 - e });
const ATLAS = {
  sideA: inset({ u0: 0, v0: 0, u1: 0.5, v1: 0.5 }),
  sideB: inset({ u0: 0.5, v0: 0, u1: 1, v1: 0.5 }),
  top: inset({ u0: 0, v0: 0.5, u1: 0.5, v1: 1 }),
  bottom: inset({ u0: 0.5, v0: 0.5, u1: 1, v1: 1 }),
};

function boxVisual(key: 'boxCardboard' | 'boxWood', size: number, radius: number, slot: PropMaterialSlot): PropVisual {
  const b = new MeshBuilder();
  const h = size / 2;
  roundedBox(b, [0, h, 0], [h, h, h], {
    radius,
    step: st(size / 9),
    uv: { nz: ATLAS.sideA, pz: ATLAS.sideA, px: ATLAS.sideB, nx: ATLAS.sideB, py: ATLAS.top, ny: ATLAS.bottom },
  });
  return { prop: key, panels: [panel('box', slot, b, ['c_*', 'f_*'])] };
}

function concreteVisual(): PropVisual {
  const b = new MeshBuilder();
  roundedBox(b, [0, 0.3, 0], [0.6, 0.3, 0.3], { radius: 0.028, step: st(0.1) });
  // shallow lifting-anchor recesses on top (two discs a hair below the face)
  for (const x of [-0.32, 0.32]) {
    const r = new MeshBuilder();
    lathe(
      r,
      [
        { r: 0.06, y: 0.6, n: [0, 1] },
        { r: 0.052, y: 0.596, crease: true },
        { r: 0.03, y: 0.594, n: [0, 1] },
        { r: 0.0, y: 0.594, n: [0, 1] },
      ],
      { segments: seg(20) },
    );
    r.transform((p) => p, [x, 0.0004, 0]);
    b.append(r);
  }
  return { prop: 'concreteBlock', panels: [panel('block', 'concrete', b, ['c_*', 'f_*'])] };
}

// ============================================================ sign post
function diamondPlate(b: MeshBuilder, yc: number, z: number, half: number, face: 1 | -1, cells: number, uvAtlas: boolean): void {
  // the square rotated 45°: corners (0, yc ± half), (± half, yc); vertices on an s × t grid along the two edges
  const base = b.vertexCount;
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const s = i / cells;
      const t = j / cells;
      const x = half * (s - t);
      const y = yc - half + half * (s + t);
      const u = uvAtlas ? (x + half) / (2 * half) : x;
      const v = uvAtlas ? (y - (yc - half)) / (2 * half) : y;
      b.vert([x, y, z], [0, 0, face], face < 0 || !uvAtlas ? u : 1 - u, v);
    }
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = base + j * (cells + 1) + i;
      b.quad(a, a + 1, a + cells + 2, a + cells + 1);
    }
  }
}

function signPostVisual(rig: CompiledRig): PropVisual {
  const panels: PropPanelDef[] = [];
  const levels = countLevels(rig, 'post_');
  const top = rig.nodePos[3 * rig.nodeIds.indexOf(`post_${levels - 1}_0`) + 1]! + 0.04;
  // 60 mm galvanized pipe with a domed cap
  const post = new MeshBuilder();
  const pts: ProfilePoint[] = profileRange(-0.05, top - 0.02, st(0.1), () => 0.03).map((p) => ({ ...p, n: [1, 0] as const }));
  pts.push({ r: 0.028, y: top - 0.006 }, { r: 0.018, y: top }, { r: 0, y: top + 0.003, n: [0, 1] });
  lathe(post, pts, { segments: seg(16), uRepeat: 0.4, vScale: 2 });
  panels.push(panel('post', 'galvanized', post, ['post_*'], { chain: { prefix: 'post_' } }));
  // sign plate: yellow diamond (instance picks the symbol) 0.72 m across, aluminium back
  const sc = rig.nodeIds.indexOf('sign_c');
  const yc = sc >= 0 ? rig.nodePos[3 * sc + 1]! : 2.3;
  const zc = sc >= 0 ? rig.nodePos[3 * sc + 2]! : -0.1;
  const half = 0.36;
  const front = new MeshBuilder();
  diamondPlate(front, yc, zc - 0.002, half, -1, Math.max(2, Math.round(8 * Q)), true);
  panels.push(panel('face', 'signFace', front, ['sign_*']));
  const back = new MeshBuilder();
  diamondPlate(back, yc, zc + 0.002, half, 1, Math.max(2, Math.round(8 * Q)), false);
  // rim: 4 thin edge strips
  const corners: V3[] = [
    [0, yc - half, 0],
    [half, yc, 0],
    [0, yc + half, 0],
    [-half, yc, 0],
  ];
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const c = corners[(k + 1) % 4]!;
    const n: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - yc, 0];
    const i0 = back.vert([a[0], a[1], zc - 0.002], n, 0, 0);
    const i1 = back.vert([c[0], c[1], zc - 0.002], n, 1, 0);
    const i2 = back.vert([c[0], c[1], zc + 0.002], n, 1, 0.01);
    const i3 = back.vert([a[0], a[1], zc + 0.002], n, 0, 0.01);
    back.quad(i0, i1, i2, i3);
  }
  // two clamp brackets from the plate back to the post
  for (const by of [yc - 0.16, yc + 0.16]) roundedBox(back, [0, by, (zc + 0.002 - 0.03) / 2], [0.07, 0.022, Math.abs(zc + 0.002 + 0.03) / 2], { radius: 0.006, step: st(0.05) });
  panels.push(panel('back', 'galvanized', back, ['sign_*']));
  return { prop: 'signPost', panels };
}

// ============================================================ stop sign (layout v6)
/** Octagon (flats ⟂ X / Y) in the plane z, centre (0, yc), circumradius R; UV = full image (atlasless face) or metres. */
function octPlate(b: MeshBuilder, yc: number, z: number, R: number, face: 1 | -1, uvImage: boolean): void {
  const c = b.vert([0, yc, z], [0, 0, face], 0.5, 0.5);
  const ring: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    const x = Math.cos(a) * R;
    const y = Math.sin(a) * R;
    // image u runs left → right as seen from the front (−Z face): mirror x for the front
    const u = uvImage ? (face < 0 ? 0.5 - x / (2 * R) : 0.5 + x / (2 * R)) : x;
    const v = uvImage ? 0.5 + y / (2 * R) : y;
    ring.push(b.vert([x, yc + y, z], [0, 0, face], u, v));
  }
  for (let k = 0; k < 8; k++) {
    const a = ring[k]!;
    const d = ring[(k + 1) % 8]!;
    if (face < 0) b.tri(c, d, a);
    else b.tri(c, a, d);
  }
}

function stopSignVisual(rig: CompiledRig): PropVisual {
  const panels: PropPanelDef[] = [];
  const levels = countLevels(rig, 'post_');
  const top = rig.nodePos[3 * rig.nodeIds.indexOf(`post_${levels - 1}_0`) + 1]! + 0.04;
  const post = new MeshBuilder();
  const pts: ProfilePoint[] = profileRange(-0.05, top - 0.02, st(0.1), () => 0.03).map((p) => ({ ...p, n: [1, 0] as const }));
  pts.push({ r: 0.028, y: top - 0.006 }, { r: 0.018, y: top }, { r: 0, y: top + 0.003, n: [0, 1] });
  lathe(post, pts, { segments: seg(16), uRepeat: 0.4, vScale: 2 });
  panels.push(panel('post', 'galvanized', post, ['post_*'], { chain: { prefix: 'post_' } }));
  const sc = rig.nodeIds.indexOf('sign_c');
  const yc = sc >= 0 ? rig.nodePos[3 * sc + 1]! : 2.3;
  const zc = sc >= 0 ? rig.nodePos[3 * sc + 2]! : -0.1;
  const R = 0.38; // 0.7 m across flats
  const front = new MeshBuilder();
  octPlate(front, yc, zc - 0.002, R, -1, true);
  panels.push(panel('face', 'stopFace', front, ['sign_*']));
  const back = new MeshBuilder();
  octPlate(back, yc, zc + 0.002, R, 1, false);
  for (const by of [yc - 0.16, yc + 0.16]) roundedBox(back, [0, by, (zc + 0.002 - 0.03) / 2], [0.07, 0.022, Math.abs(zc + 0.002 + 0.03) / 2], { radius: 0.006, step: st(0.05) });
  panels.push(panel('back', 'galvanized', back, ['sign_*']));
  return { prop: 'stopSign', panels };
}

// ============================================================ mailbox (layout v6)
function mailboxVisual(): PropVisual {
  const panels: PropPanelDef[] = [];
  const post = new MeshBuilder();
  roundedBox(post, [0, 0.47, 0], [0.07, 0.52, 0.07], { radius: 0.008, step: st(0.15) });
  panels.push(panel('post', 'wood', post, ['post_*'], { chain: { prefix: 'post_' } }));
  const box = new MeshBuilder();
  // steel box with a rounded (barrel) top: a box body + a half-round lathe-free roof of quads
  roundedBox(box, [0, 1.06, 0], [0.13, 0.1, 0.29], { radius: 0.01, step: st(0.08) });
  const n = Math.max(4, Math.round(8 * Q));
  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI * i) / n;
    const a1 = (Math.PI * (i + 1)) / n;
    const p = (a: number, z: number): [number, number, number] => [Math.cos(a) * 0.13, 1.16 + Math.sin(a) * 0.1, z];
    const nn = (a: number): [number, number, number] => [Math.cos(a), Math.sin(a), 0];
    const v0 = box.vert(p(a0, -0.29), nn(a0), i / n, 0);
    const v1 = box.vert(p(a1, -0.29), nn(a1), (i + 1) / n, 0);
    const v2 = box.vert(p(a1, 0.29), nn(a1), (i + 1) / n, 1);
    const v3 = box.vert(p(a0, 0.29), nn(a0), i / n, 1);
    box.quad(v0, v3, v2, v1);
    // end caps (door at −Z, back at +Z)
    const c0 = box.vert([0, 1.16, -0.29], [0, 0, -1], 0.5, 0.5);
    const e0 = box.vert(p(a0, -0.29), [0, 0, -1], 0, 0);
    const e1 = box.vert(p(a1, -0.29), [0, 0, -1], 1, 0);
    box.tri(c0, e1, e0);
    const c1 = box.vert([0, 1.16, 0.29], [0, 0, 1], 0.5, 0.5);
    const f0 = box.vert(p(a0, 0.29), [0, 0, 1], 0, 0);
    const f1 = box.vert(p(a1, 0.29), [0, 0, 1], 1, 0);
    box.tri(c1, f0, f1);
  }
  // flag on the side
  roundedBox(box, [0.145, 1.2, 0.12], [0.01, 0.07, 0.03], { radius: 0.003, step: st(0.05) });
  panels.push(panel('box', 'barrelPaint', box, ['box_*']));
  return { prop: 'mailbox', panels };
}

// ============================================================ light pole
function lightPoleVisual(rig: CompiledRig): PropVisual {
  const panels: PropPanelDef[] = [];
  const levels = countLevels(rig, 'pole_');
  const topY = rig.nodePos[3 * rig.nodeIds.indexOf(`pole_${levels - 1}_0`) + 1]! + 0.06;
  const rAt = (y: number): number => 0.105 - (0.042 * Math.max(0, y)) / topY;
  // tapered octagon-ish round shaft with a cap
  const shaft = new MeshBuilder();
  const pts: ProfilePoint[] = profileRange(-0.05, topY - 0.03, st(0.15), rAt).map((p) => ({ ...p, n: [1, 0.0054] as const }));
  pts.push({ r: rAt(topY) * 0.9, y: topY - 0.005 }, { r: rAt(topY) * 0.55, y: topY + 0.012 }, { r: 0, y: topY + 0.018, n: [0, 1] });
  lathe(shaft, pts, { segments: seg(24), uRepeat: 0.6, vScale: 1.5 });
  // service door outline: a slightly proud panel near the base
  roundedBox(shaft, [0, 0.62, -rAt(0.62) + 0.003], [0.045, 0.16, 0.006], { radius: 0.004, step: st(0.04) });
  panels.push(panel('shaft', 'galvanized', shaft, ['pole_*'], { chain: { prefix: 'pole_' } }));
  // base flange + anchor bolts (weathered)
  const flange = new MeshBuilder();
  lathe(
    flange,
    [
      { r: 0.2, y: -0.01, n: [1, 0] },
      { r: 0.2, y: 0.022, crease: true },
      { r: 0.19, y: 0.028, n: [0, 1] },
      { r: 0.125, y: 0.03, crease: true },
      { r: rAt(0.07), y: 0.07, n: [1, 0.4] },
    ],
    { segments: seg(32), uRepeat: 1 },
  );
  for (const [x, z] of [
    [0.15, 0.15],
    [-0.15, 0.15],
    [0.15, -0.15],
    [-0.15, -0.15],
  ] as const) {
    const bolt = new MeshBuilder();
    lathe(
      bolt,
      [
        { r: 0.024, y: 0.028, n: [1, 0] },
        { r: 0.024, y: 0.046, crease: true },
        { r: 0.012, y: 0.05, n: [0, 1] },
        { r: 0.012, y: 0.075, n: [1, 0] },
        { r: 0, y: 0.078, n: [0, 1] },
      ],
      { segments: 6 },
    );
    bolt.transform((p) => p, [x, 0, z]);
    flange.append(bolt);
  }
  panels.push(panel('flange', 'galvanized', flange, ['pole_*'], { chain: { prefix: 'pole_' }, variant: PROP_VARIANT.inner }));
  // outreach arm: rises out of the shaft top and reaches 1.8 m forward
  const a0 = rig.nodeIds.indexOf('arm_1_0');
  const armZ = a0 >= 0 ? rig.nodePos[3 * a0 + 2]! : -1.8;
  const armY = topY - 0.06;
  const arm = new MeshBuilder();
  tube(
    arm,
    [
      [0, armY - 0.35, 0],
      [0, armY - 0.12, -0.05],
      [0, armY + 0.02, -0.25],
      [0, armY + 0.05, -0.6],
      [0, armY + 0.04, armZ * 0.55],
      [0, armY + 0.0, armZ * 0.8],
      [0, armY - 0.06, armZ + 0.1],
    ],
    [0.05, 0.048, 0.045, 0.042, 0.04, 0.038, 0.036],
    seg(12),
    { uRepeat: 0.3, capEnd: true, up: [1, 0, 0] },
  );
  panels.push(panel('arm', 'galvanized', arm, ['arm_*', `pole_${levels - 1}_*`, `pole_${levels - 2}_*`]));
  // luminaire housing (painted) + lens
  const l0 = rig.nodeIds.indexOf('lamp_0');
  const lampY = l0 >= 0 ? rig.nodePos[3 * l0 + 1]! : armY - 0.2;
  const housing = new MeshBuilder();
  roundedBox(housing, [0, lampY + 0.045, armZ], [0.19, 0.06, 0.34], { radius: 0.055, step: st(0.06) });
  panels.push(panel('housing', 'galvanized', housing, ['lamp_*', 'arm_1_*'], { variant: PROP_VARIANT.alt }));
  const lens = new MeshBuilder();
  roundedBox(lens, [0, lampY - 0.016, armZ], [0.15, 0.006, 0.27], { radius: 0.005, step: st(0.06), faces: ['ny'] });
  panels.push(panel('lens', 'lampLens', lens, ['lamp_*'], { castShadow: false, damageWeight: 0.3 }));
  return { prop: 'lightPole', panels };
}

// ============================================================ R-PHYS2 props
/** Prism along X over a closed (z, y) section polygon (counter-clockwise seen from +X), flat side faces + end caps. */
function prismX(b: MeshBuilder, sec: readonly (readonly [number, number])[], x0: number, x1: number, step: number): void {
  const n = sec.length;
  const nu = Math.max(1, Math.ceil((x1 - x0) / step));
  for (let k = 0; k < n; k++) {
    const [za, ya] = sec[k]!;
    const [zb, yb] = sec[(k + 1) % n]!;
    // outward normal of the edge in the (z, y) plane (CCW polygon → right-hand normal)
    const ez = zb - za;
    const ey = yb - ya;
    const l = Math.hypot(ez, ey) || 1;
    const nrm: V3 = [0, -ez / l, ey / l];
    const nv = Math.max(1, Math.ceil(l / step));
    gridQuad(b, [x0, ya, za], [x1 - x0, 0, 0], [0, yb - ya, zb - za], nu, nv, nrm, { u0: x0, u1: x1, v0: 0, v1: l });
  }
  for (const [x, sx] of [
    [x0, -1],
    [x1, 1],
  ] as const) {
    let cz = 0;
    let cy = 0;
    for (const [z, y] of sec) {
      cz += z / n;
      cy += y / n;
    }
    const c = b.vert([x, cy, cz], [sx, 0, 0], cz, cy);
    const first = b.vertexCount;
    for (const [z, y] of sec) b.vert([x, y, z], [sx, 0, 0], z, y);
    for (let k = 0; k < n; k++) b.tri(c, first + k, first + ((k + 1) % n));
  }
}

function waterBarrierVisual(): PropVisual {
  const b = new MeshBuilder();
  // Yodock-style: a tapered HDPE shell with a moulded fork-lift slot line and fill cap.
  const sec: [number, number][] = [
    [0.275, 0],
    [0.275, 0.06],
    [0.15, 0.8],
    [-0.15, 0.8],
    [-0.275, 0.06],
    [-0.275, 0],
  ];
  prismX(b, sec, -0.9, 0.9, st(0.15));
  const cap = new MeshBuilder();
  lathe(cap, [{ r: 0.07, y: 0.8, n: [0, 1] }, { r: 0.07, y: 0.815, crease: true }, { r: 0, y: 0.82, n: [0, 1] }], { segments: seg(16) });
  cap.transform((q) => q, [0.55, 0, 0]);
  b.append(cap);
  return { prop: 'waterBarrier', panels: [panel('shell', 'conePlastic', b, ['s*', 'end_*', 'core'])] };
}

function jerseyVisual(): PropVisual {
  const b = new MeshBuilder();
  // F-shape: 75 mm vertical reveal, 55° lower face to the break point at 330 mm, 84° upper face to 810 mm.
  const sec: [number, number][] = [
    [0.305, 0],
    [0.305, 0.075],
    [0.2, 0.33],
    [0.075, 0.81],
    [-0.075, 0.81],
    [-0.2, 0.33],
    [-0.305, 0.075],
    [-0.305, 0],
  ];
  prismX(b, sec, -1.5, 1.5, st(0.25));
  return { prop: 'jerseyBarrier', panels: [panel('barrier', 'concrete', b, ['s*'])] };
}

function hayBaleVisual(): PropVisual {
  const b = new MeshBuilder();
  const prof: ProfilePoint[] = [
    { r: 0, y: -0.6, n: [0, -1] },
    { r: 0.62, y: -0.6, n: [0, -1] },
    { r: 0.72, y: -0.585, n: [0.6, -1] },
    { r: 0.75, y: -0.55, crease: true },
    ...profileRange(-0.5, 0.5, st(0.1), () => 0.75),
    { r: 0.75, y: 0.55, crease: true },
    { r: 0.72, y: 0.585, n: [0.6, 1] },
    { r: 0.62, y: 0.6, n: [0, 1] },
    { r: 0, y: 0.6, n: [0, 1] },
  ];
  lathe(b, prof, { segments: seg(40), uRepeat: 6, vScale: 2 });
  b.transform(rotZ(Math.PI / 2), [0, 0.75, 0]);
  return { prop: 'hayBale', panels: [panel('bale', 'cardboard', b, ['r*', 'ax_*', 'core'], { variant: PROP_VARIANT.alt })] };
}

function palletVisual(): PropVisual {
  const b = new MeshBuilder();
  // GMA 48 × 40": three stringers along X, 7 top deck boards and 3 bottom boards across Z.
  for (const z of [-0.47, 0, 0.47]) roundedBox(b, [0, 0.067, z], [0.61, 0.045, 0.019], { radius: 0.004, step: st(0.2) });
  for (let i = 0; i < 7; i++) roundedBox(b, [-0.54 + i * 0.18, 0.1335, 0], [0.065, 0.0105, 0.51], { radius: 0.003, step: st(0.2) });
  for (const x of [-0.54, 0, 0.54]) roundedBox(b, [x, 0.0105, 0], [0.065, 0.0105, 0.51], { radius: 0.003, step: st(0.2) });
  return { prop: 'pallet', panels: [panel('pallet', 'wood', b, ['b*', 't*'])] };
}

function fenceVisual(): PropVisual {
  const panels: PropPanelDef[] = [];
  const PX = [-1.2 + 0.04 + 0.06, 0, 1.2 - 0.04 - 0.06];
  PX.forEach((x, p) => {
    const post = new MeshBuilder();
    roundedBox(post, [x, 0.55, 0], [0.045, 0.55, 0.045], { radius: 0.006, step: st(0.25) });
    panels.push(panel(`post${p}`, 'wood', post, [`p${p}_*`], { chain: { prefix: `p${p}_` } }));
  });
  for (const [r, y] of [
    [0, 0.25],
    [1, 0.85],
  ] as const) {
    const rail = new MeshBuilder();
    roundedBox(rail, [0, y, 0.105], [1.12, 0.044, 0.06], { radius: 0.004, step: st(0.3) });
    panels.push(panel(`rail${r}`, 'wood', rail, [`rail${r}*`]));
  }
  [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9].forEach((x, i) => {
    const pk = new MeshBuilder();
    roundedBox(pk, [x, 0.52, 0.2], [0.044, 0.46, 0.01], { radius: 0.003, step: st(0.25) });
    // dog-ear top
    const tip = new MeshBuilder();
    roundedBox(tip, [x, 0.995, 0.2], [0.03, 0.015, 0.01], { radius: 0.003, step: st(0.1) });
    pk.append(tip);
    panels.push(panel(`picket${i}`, 'wood', pk, [`pk${i}_*`, 'rail01_*', 'rail11_*'], { variant: PROP_VARIANT.alt }));
  });
  return { prop: 'fencePanel', panels };
}

/** W-beam guardrail panel (sim: props/defs/guardrail.ts): the rail's W section at the contact surface, steel posts on blockouts. */
function guardrailVisual(key: 'guardrail' | 'guardrailEnd'): PropVisual {
  const panels: PropPanelDef[] = [];
  // W section (z, y): the two peaks on the 0.1 m contact surface (z −0.1), the valley 83 mm back, 2.7 mm sheet.
  const front: [number, number][] = [
    [-0.055, 0.476],
    [-0.1, 0.51],
    [-0.1, 0.575],
    [-0.017, 0.631],
    [-0.1, 0.687],
    [-0.1, 0.752],
    [-0.055, 0.787],
  ];
  const sec: [number, number][] = [...front, ...front.slice().reverse().map(([z, y]) => [z + 0.0027, y] as [number, number])];
  const rail = new MeshBuilder();
  prismX(rail, sec, -1.905, 1.905, st(0.25));
  panels.push(panel('rail', 'galvanized', rail, ['rt*', 'rb*', 'rv*']));
  [-0.9525, 0.9525].forEach((x, i) => {
    const post = new MeshBuilder();
    roundedBox(post, [x, 0.36, 0.435], [0.05, 0.36, 0.075], { radius: 0.004, step: st(0.25) });
    panels.push(panel(`post${i}`, 'galvanized', post, [`p${i}_*`]));
    const block = new MeshBuilder();
    roundedBox(block, [x, 0.63, 0.21], [0.075, 0.1, 0.15], { radius: 0.004, step: st(0.2) });
    panels.push(panel(`block${i}`, 'wood', block, [`k${i}*`, `p${i}_3`, `p${i}_4`, `p${i}_5`]));
  });
  return { prop: key, panels };
}

// ============================================================ registry
/** LOD1 detail factor (segment counts × this, grid steps ÷ this). */
export const PROP_LOD1_DETAIL = 0.45;
const cache = new Map<string, PropVisual>();

function build(key: PropKey, rig: CompiledRig): PropVisual {
  switch (key) {
    case 'cone':
      return coneVisual();
    case 'barrel':
      return barrelVisual();
    case 'tire':
      return tireVisual();
    case 'boxCardboard':
      return boxVisual('boxCardboard', 0.6, 0.012, 'cardboard');
    case 'boxWood':
      return boxVisual('boxWood', 0.8, 0.016, 'wood');
    case 'concreteBlock':
      return concreteVisual();
    case 'signPost':
      return signPostVisual(rig);
    case 'lightPole':
      return lightPoleVisual(rig);
    case 'stopSign':
      return stopSignVisual(rig);
    case 'mailbox':
      return mailboxVisual();
    case 'barrelFull':
      return { ...barrelVisual(), prop: 'barrelFull' };
    case 'waterBarrier':
      return waterBarrierVisual();
    case 'jerseyBarrier':
      return jerseyVisual();
    case 'hayBale':
      return hayBaleVisual();
    case 'pallet':
      return palletVisual();
    case 'fencePanel':
      return fenceVisual();
    case 'guardrail':
    case 'guardrailEnd':
      return guardrailVisual(key);
  }
}

/** The visual def of a key at LOD `lod` (0 full, 1 reduced; built once, pure). */
export function propVisual(key: PropKey, lod: 0 | 1 = 0): PropVisual {
  const id = `${key}:${lod}`;
  let v = cache.get(id);
  if (!v) {
    Q = lod === 0 ? 1 : PROP_LOD1_DETAIL;
    try {
      v = build(key, compilePropRig(key));
    } finally {
      Q = 1;
    }
    cache.set(id, v);
  }
  return v;
}

/** Per-slot default damage weight (lenses barely show strain). */
const damageWeightOf = (slot: PropMaterialSlot): number => (slot === 'lampLens' ? 0.3 : 1);

export interface PropBinding {
  key: PropKey;
  rig: CompiledRig;
  binding: BindingSet<PropMaterialSlot>;
  /** Material variant per panel (binding.panels order). */
  variants: readonly number[];
}

/** Tessellate + bind one key at one LOD (pure; deterministic). */
export function bindPropVisual(key: PropKey, lod: 0 | 1 = 0): PropBinding {
  const rig = compilePropRig(key);
  const vis = propVisual(key, lod);
  const geoms = vis.panels.map((p) => tessellateSurface(p.id, p.surface));
  const generic = vis.panels.map((p, i) => ({ p, i })).filter(({ p }) => !p.chain);
  const set = bindRigPanels(
    rig,
    key,
    generic.map(({ p }) => p),
    generic.map(({ i }) => geoms[i]!),
    damageWeightOf,
  );
  const panels: BindingPanel<PropMaterialSlot>[] = [];
  let g = 0;
  vis.panels.forEach((p, i) => {
    if (p.chain) {
      panels.push(bindChainPanel(rig, p, geoms[i]!, i, chainLevels(rig, p.chain.prefix, countLevels(rig, p.chain.prefix)), p.damageWeight ?? damageWeightOf(p.material)));
    } else {
      const bp = set.panels[g++]!;
      panels.push({ ...bp, panelIndex: i });
    }
  });
  let vertices = 0;
  let triangles = 0;
  for (const p of panels) {
    vertices += p.vertexCount;
    triangles += p.index.length / 3;
  }
  return {
    key,
    rig,
    binding: { ...set, panels, stats: { ...set.stats, vertices, triangles } },
    variants: vis.panels.map((p) => p.variant ?? 0),
  };
}
