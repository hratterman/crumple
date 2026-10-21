/**
 * Ground-level content (R-WORLD render): sidewalk slabs + kerb stones from
 * the strip polylines, fences, flat decals (lots, driveways, bay lines,
 * manholes, patches, oil, cracks) through one atlas, catenary cables, and
 * the shop sign boards (canvas text atlas). All merged: one draw each.
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three';
import { createRng } from '../../../core/rng';
import type { BuildingInstance, CableInstance, DecalInstance, StripInstance } from '../../../world/content/types';
import { tileableFbm } from '../colliders';
import { signBoard } from './buildings';
import type { TextBoard } from './areas';
import { add, cross, Geo, linear, norm, scale, sub, type V3 } from './geo';

// ------------------------------------------------------------------ strips
export function addStrips(geo: { slab: Geo; kerb: Geo; fence: Geo; metal: Geo }, strips: readonly StripInstance[], groundAt: (x: number, z: number) => number): void {
  for (const st of strips) {
    const P = st.points;
    const n = P.length / 3;
    if (n < 2) continue;
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) pts.push([P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!]);
    // per-point right (horizontal, + = side)
    const rights: V3[] = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(n - 1, i + 1)]!;
      const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
      return scale([-t[2], 0, t[0]], st.side);
    });
    if (st.kind === 'sidewalk') {
      const h = st.height;
      let v = 0;
      for (let i = 0; i + 1 < n; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const ra = rights[i]!;
        const rb = rights[i + 1]!;
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        // kerb stone: face (road side) + 0.18 m top
        const a0: V3 = [a[0], a[1] - 0.05, a[2]];
        const b0: V3 = [b[0], b[1] - 0.05, b[2]];
        const a1: V3 = [a[0], a[1] + h, a[2]];
        const b1: V3 = [b[0], b[1] + h, b[2]];
        geo.kerb.polyFacing([a0, b0, b1, a1], scale(ra, -1), norm(sub(b, a)), [0, 1, 0], v);
        const a2 = add(a1, scale(ra, 0.18));
        const b2 = add(b1, scale(rb, 0.18));
        geo.kerb.polyFacing([a1, b1, b2, a2], [0, 1, 0], norm(sub(b, a)), ra, v);
        // slab: from the kerb stone back to the full width, at the raised terrain + 1.5 cm
        const a3 = add([a[0], a[1] + h + 0.015, a[2]], scale(ra, st.width));
        const b3 = add([b[0], b[1] + h + 0.015, b[2]], scale(rb, st.width));
        const a2s: V3 = [a2[0], a2[1] + 0.015, a2[2]];
        const b2s: V3 = [b2[0], b2[1] + 0.015, b2[2]];
        geo.slab.polyFacing([a2s, b2s, b3, a3], [0, 1, 0], norm(sub(b, a)), ra, v);
        v += L;
      }
    } else if (st.kind === 'fencePicket' || st.kind === 'fenceRail') {
      geo.fence.color = st.kind === 'fencePicket' ? linear(0xf2f0ea) : linear(0x6b5a46);
      for (let i = 0; i + 1 < n; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
        const q: [number, number, number, number] = [0, Math.sin(Math.atan2(t[0], t[2]) / 2), 0, Math.cos(Math.atan2(t[0], t[2]) / 2)];
        const posts = Math.max(1, Math.round(L / (st.kind === 'fencePicket' ? 0.14 : 2.4)));
        for (let k = 0; k < posts; k++) {
          const f = (k + 0.5) / posts;
          const x = a[0] + (b[0] - a[0]) * f;
          const z = a[2] + (b[2] - a[2]) * f;
          const y = groundAt(x, z);
          if (st.kind === 'fencePicket') geo.fence.box([x, y + 0.5, z], q, 0.03, 0.5, 0.012);
          else geo.fence.box([x, y + 0.6, z], q, 0.06, 0.6, 0.06);
        }
        const ya = groundAt(a[0], a[2]);
        const yb = groundAt(b[0], b[2]);
        const rails = st.kind === 'fencePicket' ? [0.3, 0.8] : [0.35, 0.75, 1.1];
        for (const h of rails) {
          const mid: V3 = [(a[0] + b[0]) / 2, (ya + yb) / 2 + h, (a[2] + b[2]) / 2];
          geo.fence.box(mid, q, 0.025, 0.04, L / 2);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ decals
const ATLAS = 512;
/** Atlas cells (4 × 2): lot asphalt, bay line, concrete (driveway / forecourt), manhole, patch, oil, crack, crosswalk bar. */
const CELLS: Record<string, number> = { lotAsphalt: 0, bayLine: 1, driveway: 2, forecourt: 2, manhole: 3, patch: 4, oil: 5, crack: 6, paint: 7, paintYellow: 7, paintRed: 7, rail: 7 };
/** Vertex tint per decal kind (the atlas cell is white paint for the coloured ones). */
const TINT: Record<string, number> = { paintYellow: 0xf0c020, paintRed: 0xd02818, rail: 0x55585c };

function decalAtlas(): DataTexture {
  const N = ATLAS;
  const C = N / 4; // cell 128 px
  const data = new Uint8Array(N * N * 4);
  const fbm = tileableFbm(1201, 8, 4);
  const rng = createRng(1203);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const o = (y * N + x) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  };
  for (let cell = 0; cell < 8; cell++) {
    const ox = (cell % 4) * C;
    const oy = Math.floor(cell / 4) * C;
    const cracks: [number, number, number, number][] = [];
    if (cell === 6) for (let k = 0; k < 6; k++) cracks.push([rng.range(0.1, 0.9), rng.range(0.1, 0.9), rng.range(-1, 1), rng.range(-1, 1)]);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = x / C;
        const v = y / C;
        const n = fbm(u, v);
        const edge = Math.min(u, 1 - u, v, 1 - v);
        const soft = Math.min(1, edge * 10);
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        switch (cell) {
          case 0: // lot asphalt
            r = g = b = 58 + n * 22;
            a = 255 * Math.min(1, edge * 30);
            break;
          case 1: // bay line (white, worn)
            r = g = b = 225;
            a = 255 * (n > -0.25 ? 0.9 : 0.4) * Math.min(1, edge * 40);
            break;
          case 2: // concrete driveway
            r = 168 + n * 18;
            g = 164 + n * 18;
            b = 156 + n * 18;
            a = (Math.abs(v - 0.5) < 0.006 ? 0.6 : 1) * 255 * Math.min(1, edge * 40);
            if (Math.abs(v - 0.5) < 0.006) r = g = b = 120;
            break;
          case 3: {
            // manhole: iron disc with a ring and a grid
            const d = Math.hypot(u - 0.5, v - 0.5);
            const ring = d > 0.42 && d < 0.47;
            const grid = (Math.abs(((u * 10) % 1) - 0.5) < 0.12 || Math.abs(((v * 10) % 1) - 0.5) < 0.12) && d < 0.42;
            r = g = b = ring ? 70 : grid ? 52 : 40 + n * 10;
            a = d < 0.47 ? 255 : 0;
            break;
          }
          case 4: // asphalt patch (darker, sealed edge)
            r = g = b = 40 + n * 14;
            a = 230 * soft;
            if (edge < 0.04) r = g = b = 22;
            break;
          case 5: {
            // oil stain
            const d = Math.hypot(u - 0.5, v - 0.5) * 2 + n * 0.25;
            r = g = b = 18;
            a = 200 * Math.max(0, 1 - d) ** 1.4;
            break;
          }
          case 6: {
            // crack lines
            let m = 0;
            for (const [cx, cy, dx, dy] of cracks) {
              const t = (u - cx) * dx + (v - cy) * dy;
              const px = u - cx - t * dx;
              const py = v - cy - t * dy;
              const dd = Math.hypot(px, py) + Math.abs(fbm(u * 3, v * 3)) * 0.01;
              if (dd < 0.006 && Math.abs(t) < 0.4) m = 1;
            }
            r = g = b = 14;
            a = 210 * m;
            break;
          }
          default: // white paint
            r = g = b = 236;
            a = 255 * (0.8 + 0.2 * n) * Math.min(1, edge * 40);
        }
        put(ox + x, oy + y, Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)), Math.max(0, Math.min(255, a)));
      }
    }
  }
  const t = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function addDecals(g: Geo, decals: readonly DecalInstance[], groundAt: (x: number, z: number) => number): void {
  for (const d of decals) {
    if (d.kind === 'puddle') continue;
    const cell = CELLS[d.kind] ?? 7;
    g.color = TINT[d.kind] !== undefined ? linear(TINT[d.kind]!) : [1, 1, 1];
    const u0 = ((cell % 4) + 0.02) / 4;
    const u1 = ((cell % 4) + 0.98) / 4;
    const v0 = (Math.floor(cell / 4) + 0.02) / 2;
    const v1 = (Math.floor(cell / 4) + 0.98) / 2;
    const t = norm([d.dir[0], 0, d.dir[1]]);
    const r: V3 = [-t[2], 0, t[0]];
    const corner = (a: number, b: number): V3 => {
      const x = d.pos[0] + t[0] * a + r[0] * b;
      const z = d.pos[2] + t[2] * a + r[2] * b;
      return [x, Math.max(groundAt(x, z), d.pos[1]) + 0.045, z];
    };
    const A = corner(-d.hl, -d.hw);
    const B = corner(d.hl, -d.hw);
    const C = corner(d.hl, d.hw);
    const D = corner(-d.hl, d.hw);
    // tiled cells (lot asphalt, concrete) repeat in metres by stretching UV inside the cell is not
    // possible with an atlas: big decals keep one texel field (noise is low-frequency there).
    g.quadUV(A, D, C, B, [u0, v0, u0, v1, u1, v1, u1, v0], [0, 1, 0]);
  }
}

export function decalMaterial(): { material: MeshStandardMaterial; texture: Texture } {
  const texture = decalAtlas();
  const material = new MeshStandardMaterial({
    name: 'wc-decal',
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    roughness: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  return { material, texture };
}

// ------------------------------------------------------------------ puddles
/** Standing-water decals: soft-edged quads (4 alpha shapes in a 2 × 2 atlas), glossy dark water. */
export function addPuddles(g: Geo, decals: readonly DecalInstance[], groundAt: (x: number, z: number) => number): number {
  let n = 0;
  for (const d of decals) {
    if (d.kind !== 'puddle') continue;
    const t = norm([d.dir[0], 0, d.dir[1]]);
    const r: V3 = [-t[2], 0, t[0]];
    const corner = (a: number, b: number): V3 => {
      const x = d.pos[0] + t[0] * a + r[0] * b;
      const z = d.pos[2] + t[2] * a + r[2] * b;
      return [x, Math.max(groundAt(x, z), d.pos[1]) + 0.05, z];
    };
    const cu = (d.variant % 2) * 0.5;
    const cv = Math.floor((d.variant % 4) / 2) * 0.5;
    g.quadUV(corner(-d.hl, -d.hw), corner(-d.hl, d.hw), corner(d.hl, d.hw), corner(d.hl, -d.hw), [cu, cv, cu, cv + 0.5, cu + 0.5, cv + 0.5, cu + 0.5, cv], [0, 1, 0]);
    n++;
  }
  return n;
}

export function puddleMaterial(): { material: MeshStandardMaterial; texture: Texture } {
  const N = 256;
  const C = N / 2;
  const data = new Uint8Array(N * N * 4);
  const fbm = tileableFbm(1301, 6, 4);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * C;
    const oy = Math.floor(cell / 2) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = x / C - 0.5;
        const v = y / C - 0.5;
        const n = fbm(x / C + cell * 0.31, y / C + cell * 0.17);
        const rr = Math.hypot(u, v) * 2 + n * 0.45;
        const a = Math.max(0, Math.min(1, (0.92 - rr) * 6));
        const o = ((oy + y) * N + ox + x) * 4;
        // rim: wet dark soil band (low alpha) outside the water
        const wet = Math.max(0, Math.min(1, (1.08 - rr) * 5));
        const al = Math.round(255 * Math.max(a, wet * 0.35)); // alphaMap reads green
        data[o] = al;
        data[o + 1] = al;
        data[o + 2] = al;
        data[o + 3] = 255;
      }
    }
  }
  const texture = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  const material = new MeshStandardMaterial({
    name: 'wc-puddle',
    color: 0x1d1a16,
    roughness: 0.04,
    metalness: 0.0,
    alphaMap: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -5,
  });
  return { material, texture };
}

// ------------------------------------------------------------------ cables
export function addCables(g: Geo, cables: readonly CableInstance[]): void {
  for (const c of cables) {
    const P = c.points;
    const n = P.length / 3;
    for (let i = 0; i + 1 < n; i++) {
      const a: V3 = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
      const b: V3 = [P[(i + 1) * 3]!, P[(i + 1) * 3 + 1]!, P[(i + 1) * 3 + 2]!];
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const sag = c.sag * (L / 30) * (L / 30) * 1.4;
      const seg = 8;
      let prev = a;
      for (let k = 1; k <= seg; k++) {
        const f = k / seg;
        const p: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - sag * 4 * f * (1 - f), a[2] + (b[2] - a[2]) * f];
        g.cylinder(prev, p, c.kind === 'power' ? 0.012 : 0.006, 4, false);
        prev = p;
      }
    }
  }
}

// ------------------------------------------------------------------ signs
/** Sign boards: one canvas atlas (512 × 128 cells), one quad per building sign. Null without a canvas. */
export function buildSigns(buildings: readonly BuildingInstance[], boards: readonly TextBoard[] = []): { geo: Geo; texture: Texture } | null {
  const all: TextBoard[] = [];
  for (const b of buildings) {
    const s = signBoard(b);
    if (!s) continue;
    const lum = ((b.trim >> 16) & 255) * 0.3 + ((b.trim >> 8) & 255) * 0.59 + (b.trim & 255) * 0.11;
    all.push({ text: b.sign!, bg: b.trim, fg: lum > 140 ? 0x1d1d1d : 0xf6f2e6, centre: s.centre, right: s.right, up: s.up, w: s.w, h: s.h });
  }
  all.push(...boards);
  const signs = all;
  if (signs.length === 0) return null;
  const cols = 4;
  const rows = Math.ceil(signs.length / cols);
  const W = 512 * cols;
  const H = 128 * rows;
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(W, H);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
  } else return null;
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const geo = new Geo();
  const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
  signs.forEach((b, i) => {
    const cx = (i % cols) * 512;
    const cy = Math.floor(i / cols) * 128;
    ctx.fillStyle = hex(b.bg);
    ctx.fillRect(cx, cy, 512, 128);
    ctx.strokeStyle = hex(b.fg);
    ctx.lineWidth = 6;
    ctx.strokeRect(cx + 6, cy + 6, 500, 116);
    ctx.fillStyle = hex(b.fg);
    ctx.font = 'bold 72px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(b.text).width;
    // keep the glyph aspect when the board is shorter / wider than the 4:1 cell
    const k = Math.min(1, 470 / w);
    ctx.save();
    ctx.translate(cx + 256, cy + 66);
    ctx.scale(k, 1);
    ctx.fillText(b.text, 0, 0);
    ctx.restore();
    const r = scale(b.right, b.w / 2);
    const u = scale(b.up, b.h / 2);
    const A = sub(sub(b.centre, r), u);
    const B = sub(add(b.centre, r), u);
    const C = add(add(b.centre, r), u);
    const D = add(sub(b.centre, r), u);
    const u0 = cx / W;
    const u1 = (cx + 512) / W;
    const v0 = 1 - (cy + 128) / H;
    const v1 = 1 - cy / H;
    // front face outward: A D C B order
    geo.quadUV(A, D, C, B, [u1, v0, u1, v1, u0, v1, u0, v0]);
  });
  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { geo, texture };
}
