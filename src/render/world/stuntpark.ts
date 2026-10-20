/**
 * Stunt-park decoration (P8; docs/CONTRACTS.md "P8 contracts" → "Stunt
 * park"): everything drawn that does not collide —
 *   - painted ground markings (src/world/stuntpark.ts STUNT_PARK_DECOR +
 *     the ski jump's distance boards), draped over the terrain AND the
 *     collider decks (a downward ray against box / ramp colliders), with
 *     weathered paint; text via one canvas atlas;
 *   - floodlight heads on the 'floodlight' masts, the grandstand's back
 *     wall, roof and columns, steel legs under elevated 'deck' colliders
 *     (the ski-jump in-run / landing hill).
 * Static, merged per material: 4 draws (paint, text, steel, lamps); steel
 * casts shadows, the rest does not.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Material,
  type Object3D,
} from 'three';
import { quatToMatrix } from '../../world/colliders';
import { surfaceIndex, type SurfaceIndex } from '../../world/surface';
import { SKI_JUMP_MARKS, SKI_JUMP_X, SKI_LIP, STUNT_PARK_DECOR, type DecorMark, type PaintColor } from '../../world/stuntpark';
import type { ResolvedCollider } from '../../world/types';
import type { LightingStack, PatchMaterial, RenderContext } from '../types';

export interface StuntParkRenderer {
  readonly object: Object3D;
  update(): void;
  setQuality(): void;
  /** Ground height including collider decks (markings, tests). */
  surfaceAt(x: number, z: number): number;
  readonly stats: { paintTriangles: number; texts: number; legs: number; draws: number };
  dispose(): void;
}

export interface StuntParkOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  heightAt(x: number, z: number): number;
}

const PAINT: Readonly<Record<PaintColor, [number, number, number]>> = {
  white: [0.82, 0.82, 0.8],
  yellow: [0.86, 0.6, 0.04],
  red: [0.62, 0.05, 0.03],
  blue: [0.04, 0.16, 0.5],
  orange: [0.85, 0.28, 0.03],
};
const PAINT_CSS: Readonly<Record<PaintColor, string>> = { white: '#e8e8e4', yellow: '#f0c018', red: '#c41e14', blue: '#1d4fb0', orange: '#ec6a1c' };
const LIFT = 0.025;

// ------------------------------------------------------------ paint geometry
class Paint {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  constructor(private readonly surf: SurfaceIndex) {}

  private v(x: number, z: number, c: readonly number[]): void {
    this.pos.push(x, this.surf.at(x, z) + LIFT, z);
    this.col.push(c[0]!, c[1]!, c[2]!);
    this.uv.push(x * 0.25, z * 0.25);
  }

  /** Strip along a segment, subdivided every ≤ 1.5 m (drapes over ramps / decks). */
  segment(ax: number, az: number, bx: number, bz: number, w: number, color: PaintColor): void {
    const c = PAINT[color];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) return;
    const nx = (-(bz - az) / L) * (w / 2);
    const nz = ((bx - ax) / L) * (w / 2);
    const n = Math.max(1, Math.ceil(L / 1.5));
    for (let i = 0; i < n; i++) {
      const u0 = i / n;
      const u1 = (i + 1) / n;
      const x0 = ax + (bx - ax) * u0;
      const z0 = az + (bz - az) * u0;
      const x1 = ax + (bx - ax) * u1;
      const z1 = az + (bz - az) * u1;
      // two triangles, CCW seen from above (+Y normal)
      this.v(x0 - nx, z0 - nz, c);
      this.v(x1 - nx, z1 - nz, c);
      this.v(x1 + nx, z1 + nz, c);
      this.v(x0 - nx, z0 - nz, c);
      this.v(x1 + nx, z1 + nz, c);
      this.v(x0 + nx, z0 + nz, c);
    }
  }

  dashed(ax: number, az: number, bx: number, bz: number, w: number, color: PaintColor, dash?: readonly [number, number]): void {
    if (!dash) return this.segment(ax, az, bx, bz, w, color);
    const L = Math.hypot(bx - ax, bz - az);
    const step = dash[0] + dash[1];
    for (let s = 0; s < L; s += step) {
      const e = Math.min(L, s + dash[0]);
      this.segment(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L, ax + ((bx - ax) * e) / L, az + ((bz - az) * e) / L, w, color);
    }
  }

  tri(a: readonly [number, number], b: readonly [number, number], cc: readonly [number, number], color: PaintColor): void {
    const c = PAINT[color];
    this.v(a[0], a[1], c);
    this.v(b[0], b[1], c);
    this.v(cc[0], cc[1], c);
  }

  mark(m: DecorMark): void {
    switch (m.kind) {
      case 'line':
        for (let i = 0; i + 1 < m.pts.length; i++) this.dashed(m.pts[i]![0], m.pts[i]![1], m.pts[i + 1]![0], m.pts[i + 1]![1], m.width, m.color, m.dash);
        break;
      case 'circle': {
        const n = Math.max(24, Math.ceil((2 * Math.PI * m.r) / 1.2));
        for (let i = 0; i < n; i++) {
          if (m.dash && i % 2 === 1) continue;
          const a0 = (2 * Math.PI * i) / n;
          const a1 = (2 * Math.PI * (i + 1)) / n;
          this.segment(m.c[0] + m.r * Math.cos(a0), m.c[1] + m.r * Math.sin(a0), m.c[0] + m.r * Math.cos(a1), m.c[1] + m.r * Math.sin(a1), m.width, m.color);
        }
        break;
      }
      case 'rect': {
        const a = ((m.yawDeg ?? 0) * Math.PI) / 180;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const P = (lx: number, lz: number): [number, number] => [m.c[0] + lx * ca + lz * sa, m.c[1] - lx * sa + lz * ca];
        const cs = [P(-m.halfX, -m.halfZ), P(m.halfX, -m.halfZ), P(m.halfX, m.halfZ), P(-m.halfX, m.halfZ)];
        if (m.fill) {
          this.tri(cs[0]!, cs[2]!, cs[1]!, m.color);
          this.tri(cs[0]!, cs[3]!, cs[2]!, m.color);
        } else for (let i = 0; i < 4; i++) this.segment(cs[i]![0], cs[i]![1], cs[(i + 1) % 4]![0], cs[(i + 1) % 4]![1], m.width, m.color);
        break;
      }
      case 'arrow': {
        // chevron pointing along the yaw (0 = −Z)
        const a = (m.yawDeg * Math.PI) / 180;
        const fx = -Math.sin(a);
        const fz = -Math.cos(a);
        const rx = -fz;
        const rz = fx;
        const s = m.size;
        const tip: [number, number] = [m.c[0] + fx * s, m.c[1] + fz * s];
        const l: [number, number] = [m.c[0] - fx * s * 0.2 - rx * s * 0.8, m.c[1] - fz * s * 0.2 - rz * s * 0.8];
        const r: [number, number] = [m.c[0] - fx * s * 0.2 + rx * s * 0.8, m.c[1] - fz * s * 0.2 + rz * s * 0.8];
        const notch: [number, number] = [m.c[0] + fx * s * 0.25, m.c[1] + fz * s * 0.25];
        this.tri(tip, notch, l, m.color);
        this.tri(tip, r, notch, m.color);
        break;
      }
      case 'text':
        break;
    }
  }

  geometry(): BufferGeometry {
    // Make every triangle face +Y (winding from arbitrary helpers).
    const p = this.pos;
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i + 3]! - p[i]!;
      const az = p[i + 5]! - p[i + 2]!;
      const bx = p[i + 6]! - p[i]!;
      const bz = p[i + 8]! - p[i + 2]!;
      // y of (a × b) = az·bx − ax·bz; swap the last two vertices when it points down
      if (az * bx - ax * bz < 0) {
        for (let k = 0; k < 3; k++) {
          const t = p[i + 3 + k]!;
          p[i + 3 + k] = p[i + 6 + k]!;
          p[i + 6 + k] = t;
        }
        const c = this.col;
        for (let k = 0; k < 3; k++) {
          const t = c[i + 3 + k]!;
          c[i + 3 + k] = c[i + 6 + k]!;
          c[i + 6 + k] = t;
        }
        const uvI = (i / 3) * 2;
        const u = this.uv;
        for (let k = 0; k < 2; k++) {
          const t = u[uvI + 2 + k]!;
          u[uvI + 2 + k] = u[uvI + 4 + k]!;
          u[uvI + 4 + k] = t;
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    const n = new Float32Array(p.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new BufferAttribute(n, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------ solid builder (steel / lamps)
class Solid {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  color: [number, number, number] = [0.55, 0.57, 0.6];
  /** Oriented box: centre c, axes u (x), v (y), w (z) unit, half extents h. */
  box(c: readonly number[], u: readonly number[], v: readonly number[], w: readonly number[], h: readonly [number, number, number]): void {
    const corner = (sx: number, sy: number, sz: number): number[] => [0, 1, 2].map((k) => c[k]! + u[k]! * h[0] * sx + v[k]! * h[1] * sy + w[k]! * h[2] * sz);
    const faces: [number[], number[][]][] = [
      [u.slice(), [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)]],
      [u.map((x) => -x), [corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), corner(-1, -1, -1)]],
      [v.slice(), [corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)]],
      [v.map((x) => -x), [corner(-1, -1, 1), corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1)]],
      [w.slice(), [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)]],
      [w.map((x) => -x), [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)]],
    ];
    for (const [n, q] of faces) {
      for (const k of [0, 1, 2, 0, 2, 3]) {
        this.pos.push(q[k]![0]!, q[k]![1]!, q[k]![2]!);
        this.nrm.push(n[0]!, n[1]!, n[2]!);
        this.col.push(this.color[0], this.color[1], this.color[2]);
      }
    }
  }
  /** Axis-aligned vertical column from y0 to y1. */
  column(x: number, z: number, y0: number, y1: number, r: number): void {
    if (y1 - y0 < 0.05) return;
    this.box([x, (y0 + y1) / 2, z], [1, 0, 0], [0, 1, 0], [0, 0, 1], [r, (y1 - y0) / 2, r]);
  }
  /** Beam from a to b with half thickness r (square section). */
  beam(a: readonly number[], b: readonly number[], r: number): void {
    const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const L = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (L < 1e-6) return;
    const w = d.map((x) => x / L);
    let u = [w[2]!, 0, -w[0]!];
    let ul = Math.hypot(u[0]!, u[2]!);
    if (ul < 1e-6) {
      u = [1, 0, 0];
      ul = 1;
    }
    u = u.map((x) => x / ul);
    const v = [w[1]! * u[2]! - w[2]! * u[1]!, w[2]! * u[0]! - w[0]! * u[2]!, w[0]! * u[1]! - w[1]! * u[0]!];
    this.box([(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2], u, v, w, [r, r, L / 2]);
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    return g;
  }
}

function rot(R: Float64Array, l: readonly number[]): number[] {
  return [R[0]! * l[0]! + R[1]! * l[1]! + R[2]! * l[2]!, R[3]! * l[0]! + R[4]! * l[1]! + R[5]! * l[2]!, R[6]! * l[0]! + R[7]! * l[1]! + R[8]! * l[2]!];
}

function wornTexture(): DataTexture {
  const n = 64;
  const d = new Uint8Array(n * n * 4);
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < n * n; i++) {
    const v = 175 + Math.floor(rnd() * 80);
    d[4 * i] = v;
    d[4 * i + 1] = v;
    d[4 * i + 2] = v;
    d[4 * i + 3] = 255;
  }
  const t = new DataTexture(d, n, n, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Text quads + atlas (null without a DOM canvas: tests). */
function buildText(marks: readonly (DecorMark & { kind: 'text' })[], surf: SurfaceIndex): { geo: BufferGeometry; tex: CanvasTexture } | null {
  if (marks.length === 0 || typeof document === 'undefined') return null;
  const rowH = 96;
  const W = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = rowH * marks.length;
  const g2 = canvas.getContext('2d');
  if (!g2) return null;
  g2.clearRect(0, 0, W, canvas.height);
  g2.textAlign = 'center';
  g2.textBaseline = 'middle';
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  marks.forEach((m, i) => {
    g2.font = `900 ${rowH * 0.78}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
    const tw = Math.min(W - 8, g2.measureText(m.text).width);
    g2.fillStyle = PAINT_CSS[m.color];
    g2.fillText(m.text, W / 2, rowH * (i + 0.5), W - 8);
    const aspect = tw / (rowH * 0.78);
    const h = m.size;
    const w = h * aspect;
    // text reads along the yaw's right vector, upright toward the yaw direction
    const a = (m.yawDeg * Math.PI) / 180;
    const fx = -Math.sin(a);
    const fz = -Math.cos(a);
    const rx = -fz;
    const rz = fx;
    const u0 = (W / 2 - tw / 2) / W;
    const u1 = (W / 2 + tw / 2) / W;
    const v0 = 1 - (rowH * (i + 0.9)) / canvas.height;
    const v1 = 1 - (rowH * (i + 0.1)) / canvas.height;
    const nx = 8;
    for (let k = 0; k < nx; k++) {
      const s0 = -w / 2 + (w * k) / nx;
      const s1 = -w / 2 + (w * (k + 1)) / nx;
      const P = (s: number, t: number): number[] => {
        const x = m.c[0] + rx * s + fx * t;
        const z = m.c[1] + rz * s + fz * t;
        return [x, surf.at(x, z) + LIFT + 0.004, z];
      };
      const q = [P(s0, -h / 2), P(s1, -h / 2), P(s1, h / 2), P(s0, h / 2)];
      const qu = [
        [u0 + ((u1 - u0) * k) / nx, v0],
        [u0 + ((u1 - u0) * (k + 1)) / nx, v0],
        [u0 + ((u1 - u0) * (k + 1)) / nx, v1],
        [u0 + ((u1 - u0) * k) / nx, v1],
      ];
      // (r, f) is CCW seen from above: [0, 1, 2], [0, 2, 3] face up
      for (const o of [0, 1, 2, 0, 2, 3]) {
        pos.push(...q[o]!);
        uv.push(...qu[o]!);
        nrm.push(0, 1, 0);
      }
    }
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.computeBoundingSphere();
  return { geo, tex };
}

export function createStuntParkRenderer(_ctx: RenderContext, colliders: readonly ResolvedCollider[], opts: StuntParkOptions): StuntParkRenderer {
  const surf = surfaceIndex(colliders, opts.heightAt);
  const root = new Group();
  root.name = 'stuntpark';
  const materials: Material[] = [];
  const csm = opts.lighting.csm;

  // ---- paint
  const paint = new Paint(surf);
  const texts: (DecorMark & { kind: 'text' })[] = [];
  for (const m of STUNT_PARK_DECOR) {
    if (m.kind === 'text') texts.push(m);
    else paint.mark(m);
  }
  // ski-jump distance boards across the landing hill
  for (const k of SKI_JUMP_MARKS) {
    const z = SKI_LIP[2] + k;
    paint.segment(SKI_JUMP_X - 7.6, z, SKI_JUMP_X + 7.6, z, k % 20 === 0 ? 0.35 : 0.2, k === 60 ? 'red' : 'blue');
    texts.push({ kind: 'text', c: [SKI_JUMP_X - 5.2, z - 1.4], yawDeg: 180, text: `${k}`, size: 2.6, color: k === 60 ? 'red' : 'blue' });
  }
  const paintMat = new MeshStandardMaterial({
    name: 'stunt-paint',
    vertexColors: true,
    map: wornTexture(),
    roughness: 0.72,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  opts.patchMaterial(paintMat, { csm });
  materials.push(paintMat);
  const paintGeo = paint.geometry();
  const paintMesh = new Mesh(paintGeo, paintMat);
  paintMesh.name = 'stuntpark:paint';
  paintMesh.receiveShadow = true;
  paintMesh.matrixAutoUpdate = false;
  root.add(paintMesh);

  const text = buildText(texts, surf);
  if (text) {
    const tm = new MeshStandardMaterial({
      name: 'stunt-text',
      map: text.tex,
      transparent: false,
      alphaTest: 0.35,
      roughness: 0.72,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    opts.patchMaterial(tm, { csm });
    materials.push(tm);
    const mesh = new Mesh(text.geo, tm);
    mesh.name = 'stuntpark:text';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }

  // ---- steel: deck legs, flood heads, grandstand roof
  const steel = new Solid();
  const lamps = new Solid();
  lamps.color = [1, 1, 1];
  let legs = 0;
  for (const c of colliders) {
    const vis = c.visual;
    const R = new Float64Array(9);
    quatToMatrix(c.quat, R);
    const [a, b, d] = c.size;
    if (vis === 'deck' && a >= 0.3) {
      steel.color = [0.42, 0.44, 0.46];
      for (const [sx, sz] of [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]] as const) {
        const l = rot(R, [a * sx, -b, d * sz]);
        const x = c.pos[0] + l[0]!;
        const y = c.pos[1] + l[1]!;
        const z = c.pos[2] + l[2]!;
        const g = opts.heightAt(x, z);
        if (y - g > 0.4) {
          steel.column(x, z, g - 0.2, y + 0.02, 0.14);
          legs++;
        }
      }
    } else if (vis === 'floodlight') {
      const top = [c.pos[0], c.pos[1] + b, c.pos[2]];
      // head frame facing local −Z, tilted 22° down
      const f = rot(R, [0, -0.375, -0.927]);
      const u = rot(R, [1, 0, 0]);
      // v = f × u keeps (u, v, f) right-handed (Solid.box winding)
      const v = [f[1]! * u[2]! - f[2]! * u[1]!, f[2]! * u[0]! - f[0]! * u[2]!, f[0]! * u[1]! - f[1]! * u[0]!];
      const ctr = [top[0]! + f[0]! * 0.5, top[1]! + 0.9, top[2]! + f[2]! * 0.5];
      steel.color = [0.5, 0.52, 0.55];
      steel.box(ctr, u, v, f, [1.7, 0.9, 0.18]);
      steel.beam(top, [ctr[0]!, ctr[1]! - 0.6, ctr[2]!], 0.12);
      // service platform
      steel.box([top[0]!, top[1]! - 0.3, top[2]!], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.9, 0.05, 0.9]);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 2; j++) {
          const lc = [ctr[0]! + u[0]! * (-1.2 + 0.8 * i) + v[0]! * (-0.42 + 0.84 * j) + f[0]! * 0.2, ctr[1]! + u[1]! * (-1.2 + 0.8 * i) + v[1]! * (-0.42 + 0.84 * j) + f[1]! * 0.2, ctr[2]! + u[2]! * (-1.2 + 0.8 * i) + v[2]! * (-0.42 + 0.84 * j) + f[2]! * 0.2];
          lamps.box(lc, u, v, f, [0.34, 0.34, 0.03]);
        }
    } else if (vis === 'grandstand') {
      // local: wedge rising to −Z (back); back wall, roof and front columns
      const P = (x: number, y: number, z: number): number[] => {
        const l = rot(R, [x, y, z]);
        return [c.pos[0] + l[0]!, c.pos[1] + l[1]!, c.pos[2] + l[2]!];
      };
      const U = rot(R, [1, 0, 0]);
      const V = rot(R, [0, 1, 0]);
      const Wv = rot(R, [0, 0, 1]);
      steel.color = [0.62, 0.6, 0.56];
      steel.box(P(0, 0.9, -d - 0.25), U, V, Wv, [a, b + 0.9, 0.25]);
      steel.color = [0.36, 0.38, 0.42];
      // roof: from above the back wall forward over the terraces, sloping down slightly
      const ry0 = b + 3.6;
      const ry1 = b + 2.6;
      const roofC = P(0, (ry0 + ry1) / 2, -d + (2 * d) / 2 - 0.5);
      const tilt = Math.atan2(ry0 - ry1, 2 * d);
      const rw = [Wv[0]! * Math.cos(tilt) - V[0]! * Math.sin(tilt), Wv[1]! * Math.cos(tilt) - V[1]! * Math.sin(tilt), Wv[2]! * Math.cos(tilt) - V[2]! * Math.sin(tilt)];
      const rv = [V[0]! * Math.cos(tilt) + Wv[0]! * Math.sin(tilt), V[1]! * Math.cos(tilt) + Wv[1]! * Math.sin(tilt), V[2]! * Math.cos(tilt) + Wv[2]! * Math.sin(tilt)];
      steel.box(roofC, U, rv, rw, [a + 1, 0.12, d + 0.4]);
      steel.color = [0.4, 0.42, 0.45];
      for (let x = -a; x <= a + 0.01; x += 10) {
        const zc = d - 1.2;
        const yTerr = -b + ((d - zc) / (2 * d)) * 2 * b;
        steel.beam(P(x, yTerr, zc), P(x, ry1 + 0.1, zc), 0.12);
        steel.beam(P(x, 0, -d - 0.3), P(x, ry0, -d - 0.3), 0.15);
      }
    }
  }
  const steelMat = new MeshStandardMaterial({ name: 'stunt-steel', vertexColors: true, roughness: 0.48, metalness: 0.7 });
  opts.patchMaterial(steelMat, { csm });
  materials.push(steelMat);
  const steelMesh = new Mesh(steel.geometry(), steelMat);
  steelMesh.name = 'stuntpark:steel';
  steelMesh.castShadow = true;
  steelMesh.receiveShadow = true;
  steelMesh.matrixAutoUpdate = false;
  root.add(steelMesh);
  const lampMat = new MeshStandardMaterial({ name: 'stunt-lamp', color: 0xfff3dc, emissive: 0xffe2b0, emissiveIntensity: 2.2, roughness: 0.3, metalness: 0 });
  opts.patchMaterial(lampMat, { csm });
  materials.push(lampMat);
  const lampMesh = new Mesh(lamps.geometry(), lampMat);
  lampMesh.name = 'stuntpark:lamps';
  lampMesh.matrixAutoUpdate = false;
  root.add(lampMesh);
  root.updateMatrixWorld(true);

  const draws = root.children.length;
  return {
    object: root,
    update() {},
    setQuality() {},
    surfaceAt: (x, z) => surf.at(x, z),
    stats: { paintTriangles: paintGeo.getAttribute('position').count / 3, texts: texts.length, legs, draws },
    dispose() {
      root.traverse((o) => {
        if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose();
      });
      for (const m of materials) {
        const mm = m as MeshStandardMaterial;
        mm.map?.dispose();
        m.dispose();
      }
      root.removeFromParent();
    },
  };
}
