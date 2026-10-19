/**
 * Terrain GPU textures (B):
 *  - two DataArrayTextures holding the 5 PBR sets (one sampler each, so the
 *    whole splat costs 2 array samplers + 4 small 2D ones):
 *      albedo  RGBA8 sRGB  rgb = colour, a = height proxy (height blend)
 *      surface RGBA8 lin.  rg = tangent normal xy (OpenGL +Y), b = rough, a = AO
 *    Layer order = splat channel order: paved, dirt, rock, gravel, grass.
 *    Images are packed with v increasing from the image BOTTOM (three's
 *    flipY convention) so tangent space is T = +u, B = +v.
 *  - splat RGBA8 (linear, no mips), terrain normal RG16F (nx, nz of the
 *    sampler's central-difference vertex normals; bilinear filtering gives
 *    exactly the sampler's blended normal before renormalisation), concrete
 *    mask R8 (linear) and a tileable RGBA8 value-noise texture.
 */
import {
  DataArrayTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';

import type { TerrainSlug } from '../../assets/manifest';
import { MaterialId } from '../../protocol/messages';
import type { TerrainData } from '../../world/types';
import type { TerrainMaterialSet } from '../types';

/** Array layer per splat channel (R paved, G dirt, B rock, A gravel, implicit grass). */
export const TERRAIN_LAYERS: readonly TerrainSlug[] = ['asphalt', 'dirt', 'rock', 'gravel', 'grass'];

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(size: number): { ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx) return { ctx };
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('terrain: 2D canvas unavailable for texture packing');
  return { ctx };
}

interface RawImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Decode any texture image to RGBA8 at size×size, rows bottom-up (v up). */
function readPixels(tex: Texture, size: number, ctx: Ctx2D): Uint8ClampedArray {
  const img = tex.image as unknown;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (img && typeof img === 'object' && 'data' in img && (img as RawImage).data) {
    // DataTexture (procedural fallback): rows are already bottom-up (no flipY).
    const raw = img as RawImage;
    const out = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      const sy = Math.min(raw.height - 1, Math.floor(((y + 0.5) * raw.height) / size));
      for (let x = 0; x < size; x++) {
        const sx = Math.min(raw.width - 1, Math.floor(((x + 0.5) * raw.width) / size));
        const s = (sy * raw.width + sx) * 4;
        const d = (y * size + x) * 4;
        out[d] = raw.data[s]!;
        out[d + 1] = raw.data[s + 1]!;
        out[d + 2] = raw.data[s + 2]!;
        out[d + 3] = raw.data[s + 3]!;
      }
    }
    return out;
  }
  // Image element / bitmap: draw flipped so row 0 is the image bottom.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(1, 0, 0, -1, 0, size);
  ctx.drawImage(img as CanvasImageSource, 0, 0, size, size);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx.getImageData(0, 0, size, size).data;
}

export interface TerrainArrays {
  albedo: DataArrayTexture;
  surface: DataArrayTexture;
  /** Mean linear albedo per layer (shader uses it for far-detail ratios). */
  meanAlbedo: Float32Array;
  size: number;
  buildMs: number;
}

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/**
 * Pack the 5 sets into the two arrays. Height proxy (no displacement maps
 * ship): 0.65·AO + 0.35·luminance, histogram-stretched per layer to the
 * 2–98 % range so every layer drives the height blend equally.
 */
export function buildTerrainArrays(materials: TerrainMaterialSet, size: number, anisotropy: number): TerrainArrays {
  const t0 = performance.now();
  const layers = TERRAIN_LAYERS.length;
  const layerBytes = size * size * 4;
  const albedo = new Uint8Array(layerBytes * layers);
  const surface = new Uint8Array(layerBytes * layers);
  const meanAlbedo = new Float32Array(layers * 3);
  const { ctx } = makeCanvas(size);
  const prox = new Float32Array(size * size);
  const hist = new Uint32Array(256);

  for (let l = 0; l < layers; l++) {
    const set = materials[TERRAIN_LAYERS[l]!];
    const col = readPixels(set.color, size, ctx);
    const base = l * layerBytes;
    albedo.set(col, base);
    const nrm = readPixels(set.normal, size, ctx);
    const rough = readPixels(set.rough, size, ctx);
    const ao = set.ao ? readPixels(set.ao, size, ctx) : null;
    hist.fill(0);
    let mr = 0;
    let mg = 0;
    let mb = 0;
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) lin[i] = srgbToLinear(i);
    for (let i = 0, px = 0; px < size * size; px++, i += 4) {
      const lum = (0.2126 * col[i]! + 0.7152 * col[i + 1]! + 0.0722 * col[i + 2]!) / 255;
      const a = ao ? ao[i]! / 255 : 1;
      const p = ao ? 0.65 * a + 0.35 * lum : lum;
      prox[px] = p;
      hist[Math.min(255, Math.max(0, Math.round(p * 255)))]!++;
      surface[base + i] = nrm[i]!;
      surface[base + i + 1] = nrm[i + 1]!;
      surface[base + i + 2] = rough[i]!;
      surface[base + i + 3] = ao ? ao[i]! : 255;
      mr += lin[col[i]!]!;
      mg += lin[col[i + 1]!]!;
      mb += lin[col[i + 2]!]!;
    }
    const total = size * size;
    meanAlbedo[l * 3] = mr / total;
    meanAlbedo[l * 3 + 1] = mg / total;
    meanAlbedo[l * 3 + 2] = mb / total;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let b = 0; b < 256; b++) {
      acc += hist[b]!;
      if (acc < total * 0.02) lo = b;
      if (acc <= total * 0.98) hi = b;
    }
    const loF = lo / 255;
    const span = Math.max(1 / 255, (hi - lo) / 255);
    for (let px = 0, i = base + 3; px < total; px++, i += 4) {
      const s = (prox[px]! - loF) / span;
      albedo[i] = s <= 0 ? 0 : s >= 1 ? 255 : Math.round(s * 255);
    }
  }

  const mk = (data: Uint8Array, srgb: boolean): DataArrayTexture => {
    const tex = new DataArrayTexture(data, size, size, layers);
    tex.format = RGBAFormat;
    tex.type = UnsignedByteType;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = anisotropy;
    if (srgb) tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    // Drop the CPU copy (~16 MB per layer) once it is on the GPU.
    tex.onUpdate = () => {
      (tex.image as { data: Uint8Array | null }).data = null;
    };
    return tex;
  };
  return {
    albedo: mk(albedo, true),
    surface: mk(surface, false),
    meanAlbedo,
    size,
    buildMs: performance.now() - t0,
  };
}

/** Splat weights (RGBA8, linear, no mips) — TerrainData.splat as-is. */
export function buildSplatTexture(t: TerrainData): DataTexture {
  const tex = new DataTexture(t.splat, t.cols, t.rows, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Concrete mask (material == concrete) as linear-filtered R8 for a soft tint edge. */
export function buildConcreteTexture(t: TerrainData): DataTexture {
  const n = t.cols * t.rows;
  const data = new Uint8Array(n);
  const M = t.material;
  for (let i = 0; i < n; i++) data[i] = M[i] === MaterialId.concrete ? 255 : 0;
  const tex = new DataTexture(data, t.cols, t.rows, RedFormat, UnsignedByteType);
  tex.unpackAlignment = 1;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Vertex normals by central differences (one-sided on the border), the
 * TerrainSampler formula, stored as (nx, nz) half floats; ny is rebuilt.
 */
export function buildNormalTexture(t: TerrainData): DataTexture {
  const { cols, rows, spacing, heights: H } = t;
  const data = new Uint16Array(cols * rows * 2);
  const toHalf = DataUtils.toHalfFloat;
  for (let r = 0; r < rows; r++) {
    const rm = r > 0 ? r - 1 : r;
    const rp = r < rows - 1 ? r + 1 : r;
    const dz = (rp - rm) * spacing;
    for (let c = 0; c < cols; c++) {
      const cm = c > 0 ? c - 1 : c;
      const cp = c < cols - 1 ? c + 1 : c;
      const dx = (cp - cm) * spacing;
      const gx = (H[r * cols + cp]! - H[r * cols + cm]!) / dx;
      const gz = (H[rp * cols + c]! - H[rm * cols + c]!) / dz;
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      const o = (r * cols + c) * 2;
      data[o] = toHalf(-gx * inv);
      data[o + 1] = toHalf(-gz * inv);
    }
  }
  const tex = new DataTexture(data, cols, rows, RGFormat, HalfFloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable 256² value-noise fbm, 4 independent channels (R/G large-scale
 * macro variation, B/A finer breakup), mipmapped, repeat-wrapped.
 */
export function buildNoiseTexture(seed = 7): DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let s = seed >>> 0 || 1;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const field = new Float32Array(N * N);
  for (let ch = 0; ch < 4; ch++) {
    field.fill(0);
    let amp = 1;
    let norm = 0;
    for (let oct = 0; oct < 5; oct++) {
      const g = 4 << oct; // lattice cells per side (periodic)
      const lat = new Float32Array(g * g);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < N; y++) {
        const fy = (y / N) * g;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * g;
          const x0 = Math.floor(fx);
          const tx = fx - x0;
          const sx = tx * tx * (3 - 2 * tx);
          const a = lat[(y0 % g) * g + (x0 % g)]!;
          const b = lat[(y0 % g) * g + ((x0 + 1) % g)]!;
          const c = lat[((y0 + 1) % g) * g + (x0 % g)]!;
          const d = lat[((y0 + 1) % g) * g + ((x0 + 1) % g)]!;
          field[y * N + x]! += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        }
      }
      norm += amp;
      amp *= 0.5;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      const v = field[i]! / norm;
      field[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let i = 0; i < field.length; i++) data[i * 4 + ch] = Math.round(((field[i]! - lo) / (hi - lo)) * 255);
  }
  const tex = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
