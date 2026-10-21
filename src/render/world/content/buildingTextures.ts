/**
 * Procedural texture arrays for buildings (R-WORLD render; no downloads):
 *  walls  layer 0 clapboard siding, 1 brick, 2 stucco, 3 corrugated metal,
 *         4 vertical barn boards, 5 concrete block
 *  roofs  layer 0 asphalt shingles, 1 standing-seam metal, 2 gravel membrane,
 *         3 clay pantiles
 * Each layer: albedo (sRGB, near-white tintable by vertex colour where the
 * material is painted, natural colour for brick / clay) + a normal map.
 * Tiles are 2 m (walls) / 3 m (roofs); UVs are metres.
 */
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { createRng } from '../../../core/rng';
import { normalFromHeight, tileableFbm } from '../colliders';

export const WALL_TILE_M = 2;
export const ROOF_TILE_M = 3;
export const WallLayer = { siding: 0, brick: 1, stucco: 2, metal: 3, boards: 4, block: 5 } as const;
export const RoofLayer = { shingle: 0, seam: 1, membrane: 2, tile: 3 } as const;

const N = 256;

type Painter = (x: number, y: number) => { r: number; g: number; b: number; h: number };

function layer(p: Painter): { albedo: Uint8Array; normal: Uint8Array } {
  const albedo = new Uint8Array(N * N * 4);
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = p(x / N, y / N);
      const o = (y * N + x) * 4;
      albedo[o] = Math.max(0, Math.min(255, c.r));
      albedo[o + 1] = Math.max(0, Math.min(255, c.g));
      albedo[o + 2] = Math.max(0, Math.min(255, c.b));
      albedo[o + 3] = 255;
      h[y * N + x] = c.h;
    }
  }
  return { albedo, normal: normalFromHeight(h, N, 2.2) };
}

function walls(): { albedo: Uint8Array; normal: Uint8Array }[] {
  const n1 = tileableFbm(901, 8, 4);
  const n2 = tileableFbm(907, 32, 3);
  const rng = createRng(911);
  const brickTone = new Float32Array(64 * 64);
  for (let i = 0; i < brickTone.length; i++) brickTone[i] = rng.range(-22, 22);
  return [
    // clapboard: 8 boards per 2 m (0.25 m), shadow line under each lap
    layer((u, v) => {
      const b = v * 8;
      const f = b - Math.floor(b);
      const lap = f < 0.12 ? 0.55 + f * 3 : 1;
      const grain = n2(u * 0.25, v) * 10;
      const t = 232 * lap + grain + n1(u, v) * 8;
      return { r: t, g: t, b: t - 3, h: f };
    }),
    // brick: 0.065 m courses (≈ 31 per 2 m → 32), running bond, mortar
    layer((u, v) => {
      const rows = 32;
      const cols = 9;
      const ry = v * rows;
      const row = Math.floor(ry);
      const fy = ry - row;
      const rx = u * cols + (row % 2) * 0.5;
      const col = Math.floor(rx);
      const fx = rx - col;
      const mortar = fy < 0.14 || fx < 0.05;
      const tone = brickTone[(row % 64) * 64 + (((col % 64) + 64) % 64)]!;
      const grit = n2(u * 3, v * 3) * 14;
      if (mortar) return { r: 178 + grit * 0.4, g: 170 + grit * 0.4, b: 158 + grit * 0.4, h: 0 };
      return { r: 150 + tone + grit, g: 78 + tone * 0.6 + grit * 0.6, b: 58 + tone * 0.4 + grit * 0.5, h: 1 - 0.15 * n1(u * 2, v * 2) };
    }),
    // stucco: fine trowel noise
    layer((u, v) => {
      const t = 226 + n2(u, v) * 18 + n1(u * 2, v * 2) * 10;
      return { r: t, g: t - 2, b: t - 6, h: 0.5 + n2(u * 2, v * 2) * 0.5 };
    }),
    // corrugated metal: vertical ribs every 0.076 m (≈ 26 per 2 m), rust streaks
    layer((u, v) => {
      const s = Math.sin(u * Math.PI * 2 * 26);
      const streak = Math.max(0, n1(u * 4, v * 0.5)) * 30;
      const t = 205 + s * 14;
      return { r: t + streak * 0.6, g: t - streak * 0.1, b: t + 4 - streak * 0.5, h: 0.5 + 0.5 * s };
    }),
    // vertical boards with battens (barns)
    layer((u, v) => {
      const b = u * 10;
      const f = b - Math.floor(b);
      const gap = f < 0.06 ? 0.6 : 1;
      const grain = n2(u, v * 0.2) * 16;
      const t = (200 + grain) * gap;
      return { r: t, g: t, b: t, h: f < 0.06 ? 0 : 1 };
    }),
    // concrete block: 0.4 × 0.2 m units
    layer((u, v) => {
      const ry = v * 10;
      const row = Math.floor(ry);
      const fy = ry - row;
      const rx = u * 5 + (row % 2) * 0.5;
      const fx = rx - Math.floor(rx);
      const joint = fy < 0.07 || fx < 0.035;
      const t = (joint ? 150 : 196) + n2(u * 2, v * 2) * 16;
      return { r: t, g: t, b: t - 2, h: joint ? 0 : 1 };
    }),
  ];
}

function roofs(): { albedo: Uint8Array; normal: Uint8Array }[] {
  const n1 = tileableFbm(931, 8, 4);
  const n2 = tileableFbm(937, 32, 3);
  const rng = createRng(941);
  const tab = new Float32Array(128 * 128);
  for (let i = 0; i < tab.length; i++) tab[i] = rng.range(-1, 1);
  return [
    // asphalt shingles: 3-tab, 0.14 m exposure → 21 courses per 3 m
    layer((u, v) => {
      const rows = 21;
      const ry = v * rows;
      const row = Math.floor(ry);
      const fy = ry - row;
      const rx = u * 9 + (row % 2) * 0.5;
      const col = Math.floor(rx);
      const fx = rx - col;
      const edge = fy > 0.86 ? 0.7 : 1;
      const slot = fx < 0.03 ? 0.8 : 1;
      const tone = tab[(row % 128) * 128 + (((col % 128) + 128) % 128)]! * 18;
      const t = (200 + tone + n2(u * 2, v * 2) * 20) * edge * slot;
      return { r: t, g: t, b: t, h: fy };
    }),
    // standing seam metal: seams every 0.5 m
    layer((u, v) => {
      const f = u * 6 - Math.floor(u * 6);
      const seam = f < 0.05 ? 1.15 : 1;
      const t = 214 * seam + n1(u, v) * 8;
      return { r: t, g: t, b: t, h: f < 0.05 ? 1 : 0.3 };
    }),
    // gravel / membrane flat roof
    layer((u, v) => {
      const t = 186 + n2(u * 4, v * 4) * 30 + n1(u * 2, v * 2) * 10;
      return { r: t, g: t - 2, b: t - 5, h: 0.5 + n2(u * 6, v * 6) * 0.5 };
    }),
    // clay pantiles: rounded columns 0.3 m, courses 0.35 m
    layer((u, v) => {
      const s = Math.sin(u * Math.PI * 2 * 10);
      const ry = v * 8.5;
      const fy = ry - Math.floor(ry);
      const lip = fy > 0.85 ? 0.75 : 1;
      const t = (0.85 + 0.15 * s) * lip;
      const grit = n2(u * 2, v * 2) * 18;
      return { r: (190 + grit) * t, g: (98 + grit * 0.5) * t, b: (66 + grit * 0.4) * t, h: 0.5 + 0.5 * s };
    }),
  ];
}

function arrays(layers: { albedo: Uint8Array; normal: Uint8Array }[], anisotropy: number): { albedo: DataArrayTexture; normal: DataArrayTexture } {
  const L = layers.length;
  const a = new Uint8Array(N * N * 4 * L);
  const n = new Uint8Array(N * N * 4 * L);
  layers.forEach((l, i) => {
    a.set(l.albedo, i * N * N * 4);
    n.set(l.normal, i * N * N * 4);
  });
  const mk = (data: Uint8Array, srgb: boolean): DataArrayTexture => {
    const t = new DataArrayTexture(data, N, N, L);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(a, true), normal: mk(n, false) };
}

export function buildingTextures(anisotropy: number): { walls: { albedo: DataArrayTexture; normal: DataArrayTexture }; roofs: { albedo: DataArrayTexture; normal: DataArrayTexture } } {
  return { walls: arrays(walls(), anisotropy), roofs: arrays(roofs(), anisotropy) };
}
