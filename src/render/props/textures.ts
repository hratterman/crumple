/**
 * Procedural prop textures (U2). Pixel generators are pure (seeded hashes,
 * no Math.random) and return RGBA8 images (row 0 = bottom, v = 0); printed
 * artwork (cardboard print, crate stencils, sign faces) is drawn on a 2D
 * canvas when one exists and degrades to plain images without one (node
 * tests). Wrappers cache one DataTexture per image: every prop batch
 * shares them.
 *
 * ATLASES (uv conventions the visual defs in ./visuals.ts rely on):
 *   cardboard / crate  2 × 2 face atlas: (0,0)-(.5,.5) side A, (.5,0)-(1,.5)
 *                      side B, (0,.5)-(.5,1) top, (.5,.5)-(1,1) bottom
 *   rubber             v [0, .25) sidewall (u = once around), [.25, .5)
 *                      tread band (4 tiles across u), [.5, 1) plain rubber
 *   sign               2 × 2 sign faces (instance seed picks one)
 */
import type { DataTexture } from 'three';

import {
  grainNormalImage,
  hash3,
  heightToNormal,
  imageTexture,
  lensNormalImage,
  periodicFbm,
  periodicNoise,
  sidewallImages,
  treadImages,
  type PixelImage,
} from '../vehicle/textures';
import { TIRE_GROOVES } from './visuals';

function image(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ============================================================ canvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas2D(w: number, h: number): Ctx2D | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d');
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c.getContext('2d');
    }
  } catch {
    // no canvas
  }
  return null;
}

/** Canvas pixels → image (rows flipped to bottom-up). */
function canvasImage(ctx: Ctx2D, w: number, h: number): PixelImage {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = image(w, h);
  for (let y = 0; y < h; y++) out.data.set(src.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}


/**
 * Tileable fbm field on a w × h image, evaluated on a coarse grid (every
 * `step` px) and bilinearly interpolated: 1/step² of the noise cost; the
 * low-frequency fields (mottling, stains, tone) lose nothing visible.
 */
export function coarseFbm(w: number, h: number, period: number, octaves: number, seed: number, step = 4): Float32Array {
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  const g = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) g[j * gw + i] = periodicFbm(i / gw, j / gh, period, octaves, seed);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * gh;
    const j0 = Math.floor(fy);
    const ty = fy - j0;
    const j1 = (j0 + 1) % gh;
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * gw;
      const i0 = Math.floor(fx);
      const tx = fx - i0;
      const i1 = (i0 + 1) % gw;
      const a = g[j0 * gw + i0]!, b = g[j0 * gw + i1]!, c = g[j1 * gw + i0]!, d = g[j1 * gw + i1]!;
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

/** Multiplies an image by a tileable grey fbm (mottling), in place. */
function mottle(img: PixelImage, period: number, amount: number, seed: number): void {
  const { width: w, height: h, data } = img;
  const f = coarseFbm(w, h, period, 4, seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = f[y * w + x]!;
      const k = 1 + amount * (n - 0.5) * 2;
      const o = (y * w + x) * 4;
      data[o] = Math.min(255, data[o]! * k);
      data[o + 1] = Math.min(255, data[o + 1]! * k);
      data[o + 2] = Math.min(255, data[o + 2]! * k);
    }
  }
}

function fill(img: PixelImage, r: number, g: number, b: number): void {
  for (let i = 0; i < img.width * img.height; i++) img.data.set([r, g, b, 255], i * 4);
}

// ============================================================ cardboard (2 × 2 face atlas)
const CARD = 1024;

/** Draws one box face's print into the canvas cell (x0, y0, size s, canvas y down). */
function drawCardFace(ctx: Ctx2D, x0: number, y0: number, s: number, kind: 'sideA' | 'sideB' | 'top' | 'bottom'): void {
  const tape = 'rgba(176, 128, 66, 0.92)';
  const ink = 'rgba(38, 30, 24, 0.82)';
  const tapeW = s * 0.16;
  if (kind === 'top' || kind === 'bottom') {
    // flap seam across the middle (along u), tape over it
    ctx.fillStyle = 'rgba(70, 45, 20, 0.55)';
    ctx.fillRect(x0, y0 + s * 0.5 - 1.5, s, 3);
    ctx.fillStyle = tape;
    ctx.fillRect(x0, y0 + s * 0.5 - tapeW / 2, s, tapeW);
    // tape edge highlights + a few wrinkles
    ctx.fillStyle = 'rgba(255, 230, 190, 0.35)';
    ctx.fillRect(x0, y0 + s * 0.5 - tapeW / 2, s, 2);
    ctx.fillStyle = 'rgba(90, 60, 25, 0.35)';
    ctx.fillRect(x0, y0 + s * 0.5 + tapeW / 2 - 2, s, 2);
    ctx.strokeStyle = 'rgba(255, 235, 200, 0.25)';
    ctx.lineWidth = 1;
    for (let k = 0; k < 7; k++) {
      const x = x0 + s * (0.1 + 0.13 * k);
      ctx.beginPath();
      ctx.moveTo(x, y0 + s * 0.5 - tapeW / 2);
      ctx.lineTo(x + s * 0.02, y0 + s * 0.5 + tapeW / 2);
      ctx.stroke();
    }
    if (kind === 'top') {
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(s * 0.05)}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('OPEN HERE', x0 + s * 0.5, y0 + s * 0.22);
    }
    return;
  }
  if (kind === 'sideB') {
    // the top / bottom tape runs ~9 cm down / up the faces the flap seam ends on
    ctx.fillStyle = tape;
    ctx.fillRect(x0 + s * 0.5 - tapeW / 2, y0, tapeW, s * 0.15);
    ctx.fillStyle = 'rgba(90, 60, 25, 0.4)';
    ctx.fillRect(x0 + s * 0.5 - tapeW / 2, y0 + s * 0.15 - 2, tapeW, 2);
    ctx.fillStyle = tape;
    ctx.fillRect(x0 + s * 0.5 - tapeW / 2, y0 + s * 0.87, tapeW, s * 0.13);
    ctx.fillStyle = 'rgba(90, 60, 25, 0.4)';
    ctx.fillRect(x0 + s * 0.5 - tapeW / 2, y0 + s * 0.87, tapeW, 2);
  } else {
    // flap edges: the top / bottom flap fold lines a few mm below / above the face edge
    ctx.fillStyle = 'rgba(70, 45, 20, 0.3)';
    ctx.fillRect(x0, y0 + s * 0.012, s, 2);
    ctx.fillRect(x0, y0 + s * 0.985, s, 2);
  }
  if (kind === 'sideA') {
    // "this side up" arrows + fragile glass + umbrella icons, top-left; big print centre
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    const ax = x0 + s * 0.1;
    const ay = y0 + s * 0.22;
    for (let k = 0; k < 2; k++) {
      const cx = ax + k * s * 0.07;
      ctx.beginPath();
      ctx.moveTo(cx, ay);
      ctx.lineTo(cx + s * 0.03, ay + s * 0.04);
      ctx.lineTo(cx + s * 0.012, ay + s * 0.04);
      ctx.lineTo(cx + s * 0.012, ay + s * 0.1);
      ctx.lineTo(cx - s * 0.012, ay + s * 0.1);
      ctx.lineTo(cx - s * 0.012, ay + s * 0.04);
      ctx.lineTo(cx - s * 0.03, ay + s * 0.04);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(ax - s * 0.035, ay + s * 0.11, s * 0.135, s * 0.008);
    // glass icon
    const gx = x0 + s * 0.78;
    const gy = y0 + s * 0.2;
    ctx.lineWidth = s * 0.008;
    ctx.beginPath();
    ctx.moveTo(gx - s * 0.04, gy);
    ctx.lineTo(gx + s * 0.04, gy);
    ctx.quadraticCurveTo(gx + s * 0.04, gy + s * 0.07, gx, gy + s * 0.075);
    ctx.quadraticCurveTo(gx - s * 0.04, gy + s * 0.07, gx - s * 0.04, gy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(gx, gy + s * 0.075);
    ctx.lineTo(gx, gy + s * 0.12);
    ctx.moveTo(gx - s * 0.03, gy + s * 0.12);
    ctx.lineTo(gx + s * 0.03, gy + s * 0.12);
    ctx.stroke();
    // centre print
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(s * 0.11)}px "Arial Black", Arial, sans-serif`;
    ctx.fillText('FRAGILE', x0 + s * 0.5, y0 + s * 0.52);
    ctx.font = `700 ${Math.round(s * 0.045)}px Arial, sans-serif`;
    ctx.fillText('HANDLE WITH CARE', x0 + s * 0.5, y0 + s * 0.6);
    ctx.lineWidth = s * 0.006;
    ctx.strokeRect(x0 + s * 0.16, y0 + s * 0.4, s * 0.68, s * 0.24);
    // recycling-style loop, bottom right
    ctx.beginPath();
    ctx.arc(x0 + s * 0.82, y0 + s * 0.78, s * 0.04, 0.3, Math.PI * 1.8);
    ctx.stroke();
    ctx.font = `700 ${Math.round(s * 0.03)}px Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('MAX 20 KG', x0 + s * 0.08, y0 + s * 0.82);
  } else {
    // white shipping label with barcode and address lines
    const lx = x0 + s * 0.14;
    const ly = y0 + s * 0.34;
    const lw = s * 0.46;
    const lh = s * 0.32;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(lx + 3, ly + 4, lw, lh);
    ctx.fillStyle = '#f2f0ea';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.fillStyle = '#1a1a1a';
    for (let k = 0; k < 46; k++) {
      const w = 1 + Math.floor(hash3(k, 3, 77) * 3.5);
      if (hash3(k, 5, 77) > 0.35) ctx.fillRect(lx + lw * 0.08 + k * lw * 0.018, ly + lh * 0.62, w, lh * 0.26);
    }
    ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
    for (let k = 0; k < 4; k++) ctx.fillRect(lx + lw * 0.08, ly + lh * (0.1 + 0.11 * k), lw * (0.5 + 0.35 * hash3(k, 1, 9)), lh * 0.045);
    ctx.font = `900 ${Math.round(s * 0.06)}px Arial, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('A1', lx + lw * 0.93, ly + lh * 0.38);
    // printed size grid in the corner (box maker's certificate)
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    const cx = x0 + s * 0.7;
    const cy = y0 + s * 0.66;
    ctx.beginPath();
    ctx.arc(cx + s * 0.09, cy + s * 0.08, s * 0.075, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(s * 0.022)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('BOX CERTIFICATE', cx + s * 0.09, cy + s * 0.07);
    ctx.fillText('SINGLE WALL', cx + s * 0.09, cy + s * 0.1);
  }
}

/** Cardboard colour atlas (kraft + print). */
export function cardboardColorImage(): PixelImage {
  const ctx = canvas2D(CARD, CARD);
  let img: PixelImage;
  if (ctx) {
    ctx.fillStyle = '#b48a5a';
    ctx.fillRect(0, 0, CARD, CARD);
    const s = CARD / 2;
    // canvas y down: top row of the canvas = v ∈ [.5, 1) (top / bottom faces)
    drawCardFace(ctx, 0, s, s, 'sideA');
    drawCardFace(ctx, s, s, s, 'sideB');
    drawCardFace(ctx, 0, 0, s, 'top');
    drawCardFace(ctx, s, 0, s, 'bottom');
    img = canvasImage(ctx, CARD, CARD);
  } else {
    img = image(CARD, CARD);
    fill(img, 180, 138, 90);
  }
  mottle(img, 6, 0.09, 41);
  // faint flute shading (vertical stripes across each face)
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = 1 - 0.025 * (0.5 + 0.5 * Math.cos((x / w) * Math.PI * 2 * 96));
      const o = (y * w + x) * 4;
      data[o] = data[o]! * k;
      data[o + 1] = data[o + 1]! * k;
      data[o + 2] = data[o + 2]! * k;
    }
  }
  return img;
}

/** Cardboard normal atlas: flutes (fine ridges along v), tape edges, a little surface noise. */
export function cardboardNormalImage(): PixelImage {
  const n = 512;
  const h = new Float32Array(n * n);
  const f = coarseFbm(n, n, 24, 3, 5, 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const flute = 0.5 + 0.5 * Math.cos((x / n) * Math.PI * 2 * 96);
      h[y * n + x] = 0.35 * flute + 0.4 * f[y * n + x]!;
    }
  }
  return heightToNormal(h, n, n, 1.1);
}

// ============================================================ wooden crate (2 × 2 face atlas)
const CRATE = 512;

/** Bilinear wrap-around lookup in a tileable field. */
function sampleField(f: Float32Array, w: number, h: number, u: number, v: number): number {
  const fx = (u - Math.floor(u)) * w;
  const fy = (v - Math.floor(v)) * h;
  const i0 = Math.floor(fx) % w;
  const j0 = Math.floor(fy) % h;
  const i1 = (i0 + 1) % w;
  const j1 = (j0 + 1) % h;
  const tx = fx - Math.floor(fx);
  const ty = fy - Math.floor(fy);
  const a = f[j0 * w + i0]!, b = f[j0 * w + i1]!, c = f[j1 * w + i0]!, d = f[j1 * w + i1]!;
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

let grainField: Float32Array | null = null;
const GRAIN = 256;
function woodField(x: number, y: number, w: number, h: number, seed: number, plank: number): number {
  // long grain along u, plank-specific offset (one shared tileable field, sampled per plank)
  grainField ??= coarseFbm(GRAIN, GRAIN, 12, 3, 31, 2);
  const g = sampleField(grainField, GRAIN, GRAIN, x / w + seed * 0.013, (y / h) * 0.25 + plank * 0.37);
  const rings = 0.5 + 0.5 * Math.sin((y / h) * 220 + g * 9 + plank * 2.1);
  return 0.6 * g + 0.4 * rings;
}

/** Crate colour + height: planks across each face, a frame of battens, stencil on side A. */
export function crateImages(): { color: PixelImage; normal: PixelImage } {
  const N = CRATE;
  const col = image(N, N);
  const height = new Float32Array(N * N);
  const s = N / 2;
  const PLANKS = 5;
  const frame = 0.12; // batten width, fraction of the face
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = (x % s) / s; // 0..1 within the face
      const fy = (y % s) / s;
      const faceId = (x >= s ? 1 : 0) + (y >= s ? 2 : 0);
      const pk = Math.min(PLANKS - 1, Math.floor(fy * PLANKS));
      const inPlank = fy * PLANKS - pk;
      const gap = 1 - smooth(0.0, 0.035, Math.min(inPlank, 1 - inPlank));
      const isFrame = fx < frame || fx > 1 - frame || fy < frame || fy > 1 - frame;
      // diagonal brace on side faces
      const isBrace = faceId < 2 && Math.abs(fx - fy) < frame * 0.7 && !isFrame;
      let wv: number;
      let hgt: number;
      if (isFrame || isBrace) {
        const along = isBrace ? (fx + fy) * 0.5 : fx < frame || fx > 1 - frame ? fy : fx;
        wv = woodField(along * N, (isBrace ? fx - fy : fx < frame || fx > 1 - frame ? fx : fy) * N * 0.4, N, N, 91 + faceId, 7);
        const edge = isBrace ? Math.abs(fx - fy) / (frame * 0.7) : Math.min(Math.abs(fx - frame), Math.abs(1 - frame - fx), Math.abs(fy - frame), Math.abs(1 - frame - fy)) / 0.02;
        hgt = 1 - 0.4 * (1 - smooth(0, 1, edge));
      } else {
        wv = woodField(fx * N, fy * N, N, N, 31 + faceId, pk);
        hgt = 0.35 - 0.6 * gap;
      }
      const tone = 0.78 + 0.12 * hash3(pk, faceId, 3);
      let r = (196 * tone - 40 * wv) * (1 - 0.65 * gap);
      let g = (156 * tone - 38 * wv) * (1 - 0.65 * gap);
      let b = (104 * tone - 30 * wv) * (1 - 0.65 * gap);
      if (isFrame || isBrace) {
        r *= 0.92;
        g *= 0.9;
        b *= 0.86;
      }
      // nail heads at the frame corners / brace ends
      const nails = [frame * 0.5, 1 - frame * 0.5];
      for (const nx of nails) {
        for (const ny of nails) {
          const d = Math.hypot((fx - nx) * s, (fy - ny) * s);
          if (d < 2.5) {
            r = g = b = 70 + 20 * (1 - d / 2.5);
            hgt = 1.1;
          }
        }
      }
      const o = (y * N + x) * 4;
      col.data[o] = r;
      col.data[o + 1] = g;
      col.data[o + 2] = b;
      col.data[o + 3] = 255;
      height[y * N + x] = hgt + 0.06 * wv;
    }
  }
  // stencil on side A (canvas, multiplied in)
  const ctx = canvas2D(s, s);
  if (ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(s * 0.12)}px "Arial Black", Impact, sans-serif`;
    ctx.fillText('FRAGILE', s * 0.5, s * 0.42);
    ctx.font = `700 ${Math.round(s * 0.06)}px Impact, "Arial Narrow", sans-serif`;
    ctx.fillText('THIS WAY UP', s * 0.5, s * 0.58);
    ctx.font = `700 ${Math.round(s * 0.045)}px "Courier New", monospace`;
    ctx.fillText('NET 25 KG  LOT 0417', s * 0.5, s * 0.7);
    const st = canvasImage(ctx, s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const a = st.data[(y * s + x) * 4]! / 255;
        if (a <= 0) continue;
        const spray = 0.75 + 0.25 * hash3(x, y, 17); // stencil overspray
        const k = 1 - 0.78 * a * spray;
        const o = (y * N + x) * 4; // side A = bottom-left cell (v ∈ [0, .5))
        col.data[o] = col.data[o]! * k;
        col.data[o + 1] = col.data[o + 1]! * k;
        col.data[o + 2] = col.data[o + 2]! * k;
      }
    }
  }
  return { color: col, normal: heightToNormal(height, N, N, 2.2) };
}


// ============================================================ concrete
/** Precast concrete: grey with aggregate, pores, cure stains; tileable 512 (≈ 1 m per tile). */
export function concreteImages(): { color: PixelImage; normal: PixelImage } {
  const n = 512;
  const col = image(n, n);
  const h = new Float32Array(n * n);
  const fb = coarseFbm(n, n, 4, 4, 201);
  const fs = coarseFbm(n, n, 2, 3, 207, 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const base = fb[y * n + x]!;
      const stain = fs[y * n + x]!;
      const agg = periodicNoise(u * 96, v * 96, 96, 211);
      const pore = hash3(x, y, 223) > 0.993 ? 1 : 0;
      let g = 0.62 + 0.12 * (base - 0.5) - 0.1 * smooth(0.55, 0.8, stain) + 0.06 * (agg - 0.5);
      if (pore) g *= 0.55;
      const o = (y * n + x) * 4;
      col.data[o] = Math.round(clamp01(g * 1.02) * 255);
      col.data[o + 1] = Math.round(clamp01(g * 1.0) * 255);
      col.data[o + 2] = Math.round(clamp01(g * 0.95) * 255);
      col.data[o + 3] = 255;
      h[y * n + x] = 0.5 * agg + 0.3 * base - 1.5 * pore;
    }
  }
  return { color: col, normal: heightToNormal(h, n, n, 1.4) };
}

// ============================================================ galvanized steel
/** Hot-dip spangle: Voronoi-ish crystal patches of slightly different brightness (colour only; roughness from G). */
export function galvanizedImage(): PixelImage {
  const n = 256;
  const img = image(n, n);
  const cells = 20;
  const cs = n / cells;
  const ft = coarseFbm(n, n, 8, 3, 305);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const ci = Math.floor(x / cs);
      const cj = Math.floor(y / cs);
      let best = Infinity;
      let id = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = (((ci + di) % cells) + cells) % cells;
          const jj = (((cj + dj) % cells) + cells) % cells;
          const px = (ci + di + 0.15 + 0.7 * hash3(ii, jj, 301)) * cs;
          const py = (cj + dj + 0.15 + 0.7 * hash3(ii, jj, 302)) * cs;
          const d = (px - x) ** 2 + (py - y) ** 2;
          if (d < best) {
            best = d;
            id = ii * 131 + jj;
          }
        }
      }
      const tone = 0.8 + 0.08 * hash3(id, 0, 303) + 0.05 * (ft[y * n + x]! - 0.5);
      const o = (y * n + x) * 4;
      const g = Math.round(clamp01(tone) * 255);
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = Math.min(255, g + 4);
      img.data[o + 3] = 255;
    }
  }
  return img;
}

// ============================================================ retro-reflective sheeting
/** Micro-prism sheeting: a fine diamond lattice of pyramids (normal map). */
export function prismSheetImage(): PixelImage {
  const n = 128;
  const out = image(n, n);
  const cell = 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = ((x + 0.5) % cell) / cell - 0.5;
      const fy = ((y + 0.5) % cell) / cell - 0.5;
      const ax = Math.abs(fx);
      const ay = Math.abs(fy);
      const m = 0.45;
      const nx = ax > ay ? Math.sign(fx) * m : 0;
      const ny = ax > ay ? 0 : Math.sign(fy) * m;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * n + x) * 4;
      out.data[o] = Math.round((nx / l) * 127.5 + 127.5);
      out.data[o + 1] = Math.round((ny / l) * 127.5 + 127.5);
      out.data[o + 2] = Math.round((1 / l) * 127.5 + 127.5);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// ============================================================ rubber atlas (tyre sidewall + tread + plain)

export function rubberImages(): { color: PixelImage; normal: PixelImage } {
  const W = 2048;
  const H = 1024;
  const col = image(W, H);
  const nrm = image(W, H);
  const side = sidewallImages('CRUMPLE TRACTION', '205/55 R16 91V'); // 2048 × 256
  col.data.set(side.color.data, 0);
  nrm.data.set(side.normal.data, 0);
  const tread = treadImages('street', TIRE_GROOVES, 4); // 512 × 256
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * 512 + (x % 512)) * 4;
      const d = ((y + 256) * W + x) * 4;
      col.data.set(tread.color.data.subarray(s, s + 4), d);
      nrm.data.set(tread.normal.data.subarray(s, s + 4), d);
    }
  }
  const grain = grainNormalImage('rubber', 256, 61);
  const plain = coarseFbm(W, 512, 16, 3, 71, 8);
  for (let y = 512; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4;
      const s = (((y - 512) % 256) * 256 + (x % 256)) * 4;
      const g = Math.round(150 + 20 * plain[(y - 512) * W + x]!);
      col.data[d] = g;
      col.data[d + 1] = g;
      col.data[d + 2] = g;
      col.data[d + 3] = 255;
      nrm.data.set(grain.data.subarray(s, s + 4), d);
    }
  }
  return { color: col, normal: nrm };
}

// ============================================================ sign faces (2 × 2 atlas)
const SIGN = 1024;

/** Yellow diamond warning signs: 0 general danger "!", 1 bend right, 2 crossroads, 3 uneven road. */
export function signImage(): PixelImage {
  const ctx = canvas2D(SIGN, SIGN);
  if (!ctx) {
    const img = image(SIGN, SIGN);
    fill(img, 236, 178, 22);
    return img;
  }
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(0, 0, SIGN, SIGN);
  const s = SIGN / 2;
  for (let k = 0; k < 4; k++) {
    const x0 = (k % 2) * s;
    const y0 = (k >> 1) * s; // canvas y down → atlas cell v order flipped: cell k at canvas row k>>1 = v ∈ [.5,1) for k < 2
    const cx = x0 + s / 2;
    const cy = y0 + s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    // diamond: the plate is a square rotated 45°; it fills the cell's inscribed square
    ctx.rotate(Math.PI / 4);
    const hw = s * 0.345;
    ctx.fillStyle = '#121212';
    roundRect(ctx, -hw, -hw, hw * 2, hw * 2, s * 0.03);
    ctx.fill();
    const iw = hw - s * 0.022;
    ctx.fillStyle = '#f2b51a';
    roundRect(ctx, -iw, -iw, iw * 2, iw * 2, s * 0.02);
    ctx.fill();
    const bw = iw - s * 0.016;
    ctx.strokeStyle = '#121212';
    ctx.lineWidth = s * 0.012;
    roundRect(ctx, -bw, -bw, bw * 2, bw * 2, s * 0.015);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#121212';
    ctx.strokeStyle = '#121212';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (k === 0) {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.035, cy - s * 0.19);
      ctx.lineTo(cx + s * 0.035, cy - s * 0.19);
      ctx.lineTo(cx + s * 0.018, cy + s * 0.07);
      ctx.lineTo(cx - s * 0.018, cy + s * 0.07);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.14, s * 0.035, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 1) {
      ctx.lineWidth = s * 0.055;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.06, cy + s * 0.2);
      ctx.lineTo(cx - s * 0.06, cy - s * 0.02);
      ctx.quadraticCurveTo(cx - s * 0.06, cy - s * 0.12, cx + s * 0.04, cy - s * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.13, cy - s * 0.12);
      ctx.lineTo(cx + s * 0.03, cy - s * 0.21);
      ctx.lineTo(cx + s * 0.03, cy - s * 0.03);
      ctx.closePath();
      ctx.fill();
    } else if (k === 2) {
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.2);
      ctx.lineTo(cx, cy + s * 0.2);
      ctx.moveTo(cx - s * 0.17, cy);
      ctx.lineTo(cx + s * 0.17, cy);
      ctx.stroke();
    } else {
      ctx.lineWidth = s * 0.05;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.2, cy + s * 0.08);
      ctx.lineTo(cx - s * 0.12, cy + s * 0.08);
      ctx.quadraticCurveTo(cx - s * 0.06, cy - s * 0.08, cx, cy + s * 0.08);
      ctx.quadraticCurveTo(cx + s * 0.06, cy - s * 0.08, cx + s * 0.12, cy + s * 0.08);
      ctx.lineTo(cx + s * 0.2, cy + s * 0.08);
      ctx.stroke();
    }
  }
  return canvasImage(ctx, SIGN, SIGN);
}

/** Octagonal STOP face (layout v6): red octagon, white rim, white legend; the plate quad maps the full image. */
export function stopImage(): PixelImage {
  const N = 512;
  const ctx = canvas2D(N, N);
  if (!ctx) {
    const img = image(N, N);
    fill(img, 196, 24, 20);
    return img;
  }
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(0, 0, N, N);
  const oct = (r: number): void => {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      const x = N / 2 + Math.cos(a) * r;
      const y = N / 2 + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  oct(N * 0.5);
  ctx.fillStyle = '#f4f4f2';
  ctx.fill();
  oct(N * 0.465);
  ctx.fillStyle = '#c4181a';
  ctx.fill();
  ctx.fillStyle = '#f4f4f2';
  ctx.font = `bold ${Math.round(N * 0.3)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(N / 2, N / 2 + N * 0.01);
  ctx.scale(0.86, 1.1);
  ctx.fillText('STOP', 0, 0);
  ctx.restore();
  return canvasImage(ctx, N, N);
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ============================================================ grime (shared roughness / dirt field)
/** Tileable grime: R = dirt (0..1), G = roughness variation, B = streak field; 256². */
export function grimeImage(): PixelImage {
  const n = 256;
  const img = image(n, n);
  const fd = coarseFbm(n, n, 4, 5, 401, 2);
  const fr = coarseFbm(n, n, 16, 3, 403, 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const dirt = smooth(0.45, 0.8, fd[y * n + x]!);
      const rough = fr[y * n + x]!;
      const streak = periodicFbm(u * 1, v * 0.1, 24, 3, 405);
      const o = (y * n + x) * 4;
      img.data[o] = Math.round(dirt * 255);
      img.data[o + 1] = Math.round(rough * 255);
      img.data[o + 2] = Math.round(streak * 255);
      img.data[o + 3] = 255;
    }
  }
  return img;
}

// ============================================================ cached textures
const cache = new Map<string, DataTexture>();
function cached(key: string, color: boolean, make: () => PixelImage): DataTexture {
  let t = cache.get(key);
  if (!t) {
    t = imageTexture(make(), color, `prop:${key}`);
    cache.set(key, t);
  }
  return t;
}
function pair(key: string, make: () => { color: PixelImage; normal: PixelImage }): { color: DataTexture; normal: DataTexture } {
  let imgs: { color: PixelImage; normal: PixelImage } | null = null;
  const get = (): { color: PixelImage; normal: PixelImage } => (imgs ??= make());
  return { color: cached(`${key}:c`, true, () => get().color), normal: cached(`${key}:n`, false, () => get().normal) };
}

export const propTextures = {
  cardboard: (): { color: DataTexture; normal: DataTexture } => ({
    color: cached('card:c', true, cardboardColorImage),
    normal: cached('card:n', false, cardboardNormalImage),
  }),
  crate: (): { color: DataTexture; normal: DataTexture } => pair('crate', crateImages),
  concrete: (): { color: DataTexture; normal: DataTexture } => pair('concrete', concreteImages),
  galvanized: (): DataTexture => cached('galv', true, galvanizedImage),
  prism: (): DataTexture => cached('prism', false, prismSheetImage),
  rubber: (): { color: DataTexture; normal: DataTexture } => pair('rubber', rubberImages),
  sign: (): DataTexture => cached('sign', true, signImage),
  stop: (): DataTexture => cached('stop', true, stopImage),
  grime: (): DataTexture => cached('grime', false, grimeImage),
  plasticGrain: (): DataTexture => cached('grain', false, () => grainNormalImage('plastic', 256, 33)),
  lens: (): DataTexture => cached('lens', false, () => lensNormalImage('prism', 5)),
};

export function disposePropTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
