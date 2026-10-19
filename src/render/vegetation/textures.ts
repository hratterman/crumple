/**
 * Procedural vegetation textures (no downloads): one 1024² foliage/bark
 * ATLAS (albedo sRGB + alpha, plus a tangent-space normal map) shared by
 * every tree, shrub and impostor-bake material, and a tileable rock set.
 *
 * Atlas layout (canvas pixels, y down; UV rects are exported flipped to
 * three's v-up convention, rows are stored bottom-up so flipY stays false):
 *   x   0–127   conifer bark   (full height; v wraps → tiles along the trunk)
 *   x 128–255   broadleaf bark (grey-brown, furrowed)
 *   x 256–383   birch bark     (white, dark lenticels)
 *   x 384–1023  y   0–255  spruce/fir sprig card (twig base at the left)
 *               y 256–511  pine tuft card
 *               y 512–831  broadleaf cluster (x 384–703), birch cluster (x 704–1023)
 *               y 832–1023 scrub (x 384–703), reeds (x 704–863), fern (x 864–1023)
 * Transparent texels carry the region's mean colour (no dark mip halos).
 */
import { ATLAS_SIZE, ATLAS_PX as PX, type AtlasRegion, type PxRect } from './atlas';
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

export interface VegetationTextures {
  albedo: DataTexture;
  normal: DataTexture;
  rockAlbedo: DataTexture;
  rockNormal: DataTexture;
  /** Mean linear foliage colour (impostor bake clear colour). */
  foliageMean: [number, number, number];
  ms: number;
  /** Stage wall times, ms (cards = canvas paths, bark, normal = fill + normal map + upload prep). */
  timings: { cards: number; bark: number; normal: number };
  dispose(): void;
}

// ------------------------------------------------------------ small deterministic helpers
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic value noise on a w×h lattice of cells (tileable), smooth interpolation. */
function periodicNoise(seed: number, gw: number, gh: number): (x: number, y: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(gw * gh);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  return (x, y) => {
    const fx = x * gw;
    const fy = y * gh;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const xa = ((x0 % gw) + gw) % gw;
    const xb = (xa + 1) % gw;
    const ya = ((y0 % gh) + gh) % gh;
    const yb = (ya + 1) % gh;
    const a = lat[ya * gw + xa]!;
    const b = lat[ya * gw + xb]!;
    const c = lat[yb * gw + xa]!;
    const d = lat[yb * gw + xb]!;
    return a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy;
  };
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return { ctx: c.getContext('2d', { willReadFrequently: true })! };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { ctx: c.getContext('2d', { willReadFrequently: true })! };
}

const rgb = (r: number, g: number, b: number, a = 1): string => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

// ------------------------------------------------------------ bark (typed arrays: albedo + height)
function bark(
  img: Uint8ClampedArray,
  height: Float32Array,
  p: PxRect,
  kind: 'conifer' | 'broad' | 'birch',
): void {
  const n1 = periodicNoise(kind === 'conifer' ? 11 : kind === 'broad' ? 12 : 13, 6, 18);
  const n2 = kind === 'broad' ? periodicNoise(22, 10, 22) : periodicNoise(kind === 'conifer' ? 21 : 23, 16, 90);
  const n3 = periodicNoise(kind === 'conifer' ? 31 : kind === 'broad' ? 32 : 33, 40, 160);
  const nPlate = periodicNoise(kind === 'conifer' ? 41 : 42, 5, 26);
  for (let y = 0; y < p.h; y++) {
    const v = y / p.h;
    for (let x = 0; x < p.w; x++) {
      const u = x / p.w;
      let hgt: number;
      let r: number;
      let g: number;
      let b: number;
      if (kind === 'birch') {
        // White papery bark: horizontal dark lenticels, a few black diamond scars, faint peel.
        const len = n2(u * 0.35, v) * 0.6 + n3(u, v) * 0.4;
        const lent = Math.max(0, (len - 0.68) * 5);
        const scar = Math.max(0, (n1(u, v) - 0.78) * 6) * (0.6 + 0.4 * n3(u * 2, v));
        const base = 0.82 + 0.12 * n3(u * 3, v * 0.5);
        hgt = 0.6 - lent * 0.5 - scar * 0.4 + 0.1 * n3(u, v);
        const dark = Math.min(1, lent * 0.9 + scar);
        r = (215 * base) * (1 - dark) + 38 * dark;
        g = (210 * base) * (1 - dark) + 34 * dark;
        b = (198 * base) * (1 - dark) + 32 * dark;
        // Darker, rougher base near the ground (v small = trunk foot repeats every BARK_V_M: keep subtle).
      } else if (kind === 'conifer') {
        // Spruce / pine: scaly plates separated by dark fissures, reddish where flaked.
        const plate = nPlate(u, v);
        const fiss = Math.abs(n2(u + 0.15 * n1(u, v), v) - 0.5) * 2; // 0 in a fissure
        const fissure = 1 - Math.min(1, fiss * 3.2);
        const scales = n3(u, v);
        hgt = 0.65 - 0.55 * fissure + 0.25 * (scales - 0.5) + 0.15 * plate;
        const flake = Math.max(0, (plate - 0.62) * 3) * (1 - fissure);
        const lum = 0.75 + 0.35 * (scales - 0.5);
        r = (88 + 50 * flake) * lum * (1 - 0.65 * fissure);
        g = (68 + 22 * flake) * lum * (1 - 0.7 * fissure);
        b = (56 + 8 * flake) * lum * (1 - 0.72 * fissure);
      } else {
        // Oak / beech: grey-brown with long vertical furrows and lichen patches.
        const f = n2(u + 0.08 * n1(u, v * 2), v * 0.6);
        const furrow = 1 - Math.min(1, Math.abs(f - 0.5) * 4);
        const knot = n3(u, v);
        hgt = 0.7 - 0.6 * furrow * furrow + 0.15 * (knot - 0.5);
        const lichen = Math.max(0, (n1(u * 1.7, v) - 0.66) * 3) * (1 - furrow);
        const lum = 0.8 + 0.3 * (knot - 0.5);
        r = (92 * lum) * (1 - 0.55 * furrow) * (1 - lichen) + 118 * lichen;
        g = (86 * lum) * (1 - 0.55 * furrow) * (1 - lichen) + 128 * lichen;
        b = (78 * lum) * (1 - 0.58 * furrow) * (1 - lichen) + 92 * lichen;
      }
      const i = ((p.y + y) * ATLAS_SIZE + p.x + x) * 4;
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
      img[i + 3] = 255;
      height[(p.y + y) * ATLAS_SIZE + p.x + x] = hgt;
    }
  }
}

// ------------------------------------------------------------ foliage cards (canvas paths)
interface Pal {
  base: [number, number, number];
  jitter: number;
}
function col(r: () => number, pal: Pal, lum = 1): string {
  const j = 1 + (r() - 0.5) * pal.jitter;
  const hue = (r() - 0.5) * pal.jitter * 0.6;
  return rgb(pal.base[0] * j * lum * (1 + hue), pal.base[1] * j * lum, pal.base[2] * j * lum * (1 - hue));
}

function leaf(ctx: Ctx2D, x: number, y: number, len: number, wid: number, ang: number, fill: string, vein: string | null): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
  ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
  ctx.fillStyle = fill;
  ctx.fill();
  if (vein) {
    ctx.strokeStyle = vein;
    ctx.lineWidth = Math.max(0.6, wid * 0.12);
    ctx.beginPath();
    ctx.moveTo(len * 0.05, 0);
    ctx.lineTo(len * 0.85, 0);
    ctx.stroke();
  }
  ctx.restore();
}

function twig(ctx: Ctx2D, pts: [number, number][], w0: number, w1: number, color: string): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const t = i / Math.max(1, pts.length - 2);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = w0 + (w1 - w0) * t;
    ctx.beginPath();
    ctx.moveTo(pts[i]![0], pts[i]![1]);
    ctx.lineTo(pts[i + 1]![0], pts[i + 1]![1]);
    ctx.stroke();
  }
}

/**
 * Spruce / fir branch spray (base at the left edge, tip at the right): a
 * flattened, dense mass of needled twigs in a spearhead silhouette (high
 * alpha coverage so crowns read as solid at distance). Pine: long-needle
 * fascicles bunched toward the twig ends.
 */
function drawSprig(ctx: Ctx2D, p: PxRect, r: () => number, pine: boolean): void {
  const cy = p.y + p.h * 0.5;
  const pal: Pal = pine ? { base: [46, 72, 38], jitter: 0.35 } : { base: [30, 56, 36], jitter: 0.35 };
  const dark: Pal = pine ? { base: [30, 48, 28], jitter: 0.3 } : { base: [20, 40, 27], jitter: 0.3 };
  const tipPal: Pal = pine ? { base: [70, 96, 50], jitter: 0.3 } : { base: [58, 92, 54], jitter: 0.3 };
  const len = p.w * 0.97;
  const x0 = p.x + 4;
  const needle = (x: number, y: number, a: number, l: number, c: string, w: number): void => {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  const axis: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    axis.push([x0 + t * len, cy + Math.sin(t * 5 + r()) * p.h * 0.02]);
  }
  const axisY = (x: number): number => {
    const t = Math.max(0, Math.min(0.999, (x - x0) / len)) * 12;
    const i = Math.floor(t);
    return axis[i]![1] + (axis[i + 1]![1] - axis[i]![1]) * (t - i);
  };
  // Side twigs (alternate), shortening toward the tip: spearhead silhouette.
  const twigs: [number, number][][] = [];
  const nSide = pine ? 12 : 30;
  for (let k = 0; k < nSide; k++) {
    const t = 0.03 + (k / nSide) * 0.92;
    const ax = x0 + t * len;
    const ay = axisY(ax);
    const dir = k % 2 === 0 ? -1 : 1;
    const sl = p.h * (pine ? 0.4 : 0.47) * (1 - (pine ? 0.45 : 0.72) * t) * (0.85 + 0.3 * r());
    const ang = (pine ? 0.7 : 0.85) + (r() - 0.5) * 0.3;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 4; i++) {
      const s2 = i / 4;
      const curl = s2 * s2 * 0.25;
      pts.push([ax + Math.cos(ang - curl) * sl * s2 * 1.15, ay + dir * Math.sin(ang - curl) * sl * s2]);
    }
    twigs.push(pts);
  }
  const barkCol = pine ? rgb(92, 70, 50) : rgb(62, 50, 40);
  twig(ctx, axis, pine ? 5 : 4.5, 1.5, barkCol);
  for (const t of twigs) twig(ctx, t, 2.4, 0.8, barkCol);
  const fur = (pts: [number, number][], scale: number, layer: number): void => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [xa, ya] = pts[i]!;
      const [xb, yb] = pts[i + 1]!;
      const segA = Math.atan2(yb - ya, xb - xa);
      const segL = Math.hypot(xb - xa, yb - ya);
      const count = Math.ceil(segL / (pine ? 5 : layer === 0 ? 2.2 : 1.5));
      for (let k = 0; k < count; k++) {
        const t = (k + r()) / count;
        const x = xa + (xb - xa) * t;
        const y = ya + (yb - ya) * t;
        const tipness = (i + t) / (pts.length - 1);
        if (pine) {
          if (r() > 0.25 + 0.75 * tipness) continue;
          const nn = 7 + Math.floor(r() * 6);
          for (let m = 0; m < nn; m++) {
            const a = segA + (r() - 0.5) * 2.6;
            needle(x, y, a, (18 + r() * 16) * scale, col(r, layer === 0 ? dark : r() < 0.3 ? tipPal : pal), layer === 0 ? 2.2 : 1.5);
          }
        } else {
          for (const sd of [-1, 1]) {
            const a = segA + sd * (0.75 + r() * 0.7);
            const c = layer === 0 ? col(r, dark) : col(r, tipness > 0.7 && r() < 0.55 ? tipPal : pal);
            needle(x, y, a, (layer === 0 ? 11 : 8) * scale * (0.75 + 0.5 * r()), c, layer === 0 ? 2.6 : 1.7);
          }
        }
      }
    }
  };
  for (let layer = 0; layer < 2; layer++) {
    for (const t of twigs) fur(t, 1, layer);
    fur(axis, 1.3, layer);
  }
}

/**
 * A broadleaf cluster filling its square card: twigs fanning up from the
 * bottom centre, then two layers of leaves (darker back, lighter front)
 * scattered over an irregular disk — ~75 % alpha coverage, ragged rim.
 */
function drawCluster(ctx: Ctx2D, p: PxRect, r: () => number, birch: boolean): void {
  const cx = p.x + p.w * 0.5;
  const cy = p.y + p.h * 0.5;
  const R = p.w * 0.46;
  const pal: Pal = birch ? { base: [92, 124, 46], jitter: 0.35 } : { base: [60, 92, 34], jitter: 0.4 };
  const shade: Pal = birch ? { base: [62, 92, 34], jitter: 0.3 } : { base: [38, 62, 24], jitter: 0.35 };
  const twigCol = birch ? rgb(70, 52, 40) : rgb(66, 52, 40);
  // Irregular rim: radius by angle from a few harmonics.
  const h1 = r() * 6.28;
  const h2 = r() * 6.28;
  const rimAt = (a: number): number => R * (0.86 + 0.09 * Math.sin(3 * a + h1) + 0.06 * Math.sin(5 * a + h2));
  const ox = cx;
  const oy = p.y + p.h * 0.98;
  const nt = birch ? 9 : 7;
  for (let k = 0; k < nt; k++) {
    const a = -Math.PI / 2 + (k / (nt - 1) - 0.5) * 1.3 + (r() - 0.5) * 0.2;
    const l = p.h * (0.55 + 0.3 * r());
    const pts: [number, number][] = [];
    for (let i = 0; i <= 5; i++) {
      const s2 = i / 5;
      const droop = birch ? s2 * s2 * R * 0.3 : 0;
      pts.push([ox + Math.cos(a) * l * s2, oy + Math.sin(a) * l * s2 + droop]);
    }
    twig(ctx, pts, 3.2, 1, twigCol);
  }
  const nLeaves = birch ? 340 : 280;
  for (let layer = 0; layer < 2; layer++) {
    for (let k = 0; k < nLeaves; k++) {
      const a = r() * Math.PI * 2;
      const rr = Math.sqrt(r()) * rimAt(a) * (layer === 0 ? 0.92 : 1);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      const len = birch ? 12 + r() * 7 : 16 + r() * 10;
      const wid = len * (birch ? 0.44 : 0.38);
      const ang = birch ? Math.PI / 2 + (r() - 0.5) * 1.6 : r() * Math.PI * 2;
      // Outer leaves catch more light; inner ones sit in the cluster's own shade.
      const edge = rr / R;
      const lum = layer === 0 ? 0.75 + 0.15 * edge : 0.95 + 0.2 * edge + 0.1 * r();
      leaf(ctx, x, y, len, wid, ang, col(r, layer === 0 ? shade : pal, lum), layer === 1 && !birch ? rgb(110, 132, 64, 0.45) : null);
    }
  }
}

function drawScrub(ctx: Ctx2D, p: PxRect, r: () => number): void {
  const pal: Pal = { base: [92, 98, 52], jitter: 0.45 };
  const twigCol = rgb(84, 68, 52);
  for (let k = 0; k < 9; k++) {
    const x0 = p.x + p.w * (0.3 + 0.4 * r());
    const y0 = p.y + p.h;
    const a = -Math.PI / 2 + (r() - 0.5) * 1.8;
    const l = p.h * (0.6 + 0.35 * r());
    const pts: [number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      pts.push([x0 + Math.cos(a) * l * s + (r() - 0.5) * 6, y0 + Math.sin(a) * l * s]);
    }
    twig(ctx, pts, 3, 1, twigCol);
    for (let i = 2; i < pts.length; i++) {
      for (let m = 0; m < 8; m++) {
        const [x, y] = pts[i]!;
        leaf(ctx, x + (r() - 0.5) * 22, y + (r() - 0.5) * 22, 8 + r() * 6, 3 + r() * 2, r() * 6.28, col(r, pal), null);
      }
    }
  }
}

function drawReeds(ctx: Ctx2D, p: PxRect, r: () => number): void {
  for (let k = 0; k < 26; k++) {
    const x0 = p.x + p.w * (0.15 + 0.7 * r());
    const y0 = p.y + p.h;
    const h = p.h * (0.55 + 0.42 * r());
    const lean = (r() - 0.5) * p.w * 0.35;
    const w = 3 + r() * 2.5;
    const g = 0.75 + 0.35 * r();
    ctx.fillStyle = rgb(92 * g, 116 * g, 52 * g);
    ctx.beginPath();
    ctx.moveTo(x0 - w / 2, y0);
    ctx.quadraticCurveTo(x0 + lean * 0.3, y0 - h * 0.6, x0 + lean, y0 - h);
    ctx.quadraticCurveTo(x0 + lean * 0.3 + w * 0.4, y0 - h * 0.6, x0 + w / 2, y0);
    ctx.fill();
    if (r() < 0.22) {
      // Cattail head.
      ctx.fillStyle = rgb(82, 56, 38);
      const hx = x0 + lean * 0.9;
      const hy = y0 - h * 0.9;
      ctx.beginPath();
      ctx.ellipse(hx, hy, 3.2, 11, Math.atan2(lean, h) * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFern(ctx: Ctx2D, p: PxRect, r: () => number): void {
  const x0 = p.x + p.w * 0.5;
  const y0 = p.y + p.h;
  const pal: Pal = { base: [70, 112, 42], jitter: 0.25 };
  const n = 22;
  const top = p.y + p.h * 0.03;
  twig(ctx, [[x0, y0], [x0, top]], 2.4, 1, rgb(80, 96, 48));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const y = y0 + (top - y0) * t;
    const l = p.w * 0.46 * Math.sin(Math.PI * (0.15 + 0.85 * t)) * (1 - 0.3 * t);
    for (const side of [-1, 1]) {
      const segs = 6;
      for (let m = 0; m < segs; m++) {
        const s = (m + 0.5) / segs;
        const lx = x0 + side * l * s;
        const ly = y - l * s * 0.25;
        leaf(ctx, lx, ly, 11 * (1 - 0.45 * s), 5 * (1 - 0.35 * s), side > 0 ? -0.5 : Math.PI + 0.5, col(r, pal, 1 - 0.2 * s), null);
      }
    }
  }
}

// ------------------------------------------------------------ rock set
function rockSet(size: number): { albedo: Uint8Array; normal: Uint8Array } {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const n1 = periodicNoise(51, 4, 4);
  const n2 = periodicNoise(52, 12, 12);
  const n3 = periodicNoise(53, 40, 40);
  const n4 = periodicNoise(54, 7, 7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const cr = Math.abs(n2(u, v) - 0.5) * 2;
      const crack = 1 - Math.min(1, cr * 6);
      const hh = 0.5 * n1(u, v) + 0.3 * n2(u, v) + 0.2 * n3(u, v) - 0.35 * crack;
      h[y * size + x] = hh;
      const tone = 0.75 + 0.5 * (n4(u, v) - 0.5) + 0.25 * (n3(u, v) - 0.5);
      const i = (y * size + x) * 4;
      // Weathered granite ≈ 0.2 linear albedo, like the terrain's rock set (at 106/103/98 the
      // boulders read as black blobs against the sunlit ground).
      albedo[i] = 144 * tone * (1 - 0.45 * crack);
      albedo[i + 1] = 139 * tone * (1 - 0.45 * crack);
      albedo[i + 2] = 130 * tone * (1 - 0.45 * crack);
      albedo[i + 3] = 255;
    }
  }
  heightToNormal(h, size, size, normal, 3.5, true);
  return { albedo, normal };
}

/** Sobel normal map (tangent space, +Y = v up after the bottom-up row flip). */
function heightToNormal(h: Float32Array, w: number, hgt: number, out: Uint8Array, strength: number, wrap: boolean): void {
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const xm = wrap ? (x - 1 + w) % w : Math.max(0, x - 1);
      const xp = wrap ? (x + 1) % w : Math.min(w - 1, x + 1);
      const ym = wrap ? (y - 1 + hgt) % hgt : Math.max(0, y - 1);
      const yp = wrap ? (y + 1) % hgt : Math.min(hgt - 1, y + 1);
      const dx = (h[y * w + xp]! - h[y * w + xm]!) * strength;
      const dy = (h[yp * w + x]! - h[ym * w + x]!) * strength;
      // Canvas rows run down; v runs up → flip dy.
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
}

/** Rows top-down → bottom-up (flipY false on DataTextures). */
function flipRows(src: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, wrapS: boolean, wrapT: boolean, aniso: number): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  t.colorSpace = srgb ? SRGBColorSpace : '';
  t.wrapS = wrapS ? RepeatWrapping : ClampToEdgeWrapping;
  t.wrapT = wrapT ? RepeatWrapping : ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const srgbToLinear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

export function createVegetationTextures(anisotropy = 4): VegetationTextures {
  const t0 = performance.now();
  const S = ATLAS_SIZE;
  const { ctx } = makeCanvas(S, S);
  ctx.clearRect(0, 0, S, S);
  const r = rng(0xbada55);
  drawSprig(ctx, PX.sprig, r, false);
  drawSprig(ctx, PX.pine, r, true);
  drawCluster(ctx, PX.leaves, r, false);
  drawCluster(ctx, PX.birchLeaves, r, true);
  drawScrub(ctx, PX.scrub, r);
  drawReeds(ctx, PX.reeds, r);
  drawFern(ctx, PX.fern, r);
  const img = ctx.getImageData(0, 0, S, S).data;
  const t1 = performance.now();
  // Height for the normal map: luminance × coverage on cards, explicit on bark.
  const height = new Float32Array(S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const a = img[p + 3]! / 255;
    height[i] = ((img[p]! + img[p + 1]! * 1.4 + img[p + 2]! * 0.4) / (2.8 * 255)) * a * 1.6 + a * 0.25;
  }
  bark(img, height, PX.barkConifer, 'conifer');
  bark(img, height, PX.barkBroad, 'broad');
  bark(img, height, PX.barkBirch, 'birch');
  const t2 = performance.now();
  // Transparent texels take the region mean (dilation-free halo fix); mean foliage colour for the bake.
  let fr = 0;
  let fg = 0;
  let fb = 0;
  let fn = 0;
  for (const key of ['sprig', 'pine', 'leaves', 'birchLeaves', 'scrub', 'reeds', 'fern'] as AtlasRegion[]) {
    const p = PX[key];
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sn = 0;
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const i = (y * S + x) * 4;
        if (img[i + 3]! > 128) {
          sr += img[i]!;
          sg += img[i + 1]!;
          sb += img[i + 2]!;
          sn++;
        }
      }
    }
    if (sn === 0) continue;
    sr /= sn;
    sg /= sn;
    sb /= sn;
    if (key === 'sprig' || key === 'leaves') {
      fr += srgbToLinear(sr);
      fg += srgbToLinear(sg);
      fb += srgbToLinear(sb);
      fn++;
    }
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const i = (y * S + x) * 4;
        const a = img[i + 3]!;
        if (a < 255) {
          // Blend toward the mean so partially covered edge texels do not fringe.
          const k = a / 255;
          img[i] = img[i]! * k + sr * (1 - k);
          img[i + 1] = img[i + 1]! * k + sg * (1 - k);
          img[i + 2] = img[i + 2]! * k + sb * (1 - k);
        }
      }
    }
  }
  const nrm = new Uint8Array(S * S * 4);
  heightToNormal(height, S, S, nrm, 4, false);
  const aniso = Math.max(1, anisotropy);
  const albedo = dataTex(flipRows(img, S, S), S, S, true, false, true, aniso);
  albedo.name = 'veg-atlas';
  const normal = dataTex(flipRows(nrm, S, S), S, S, false, false, true, aniso);
  normal.name = 'veg-atlas-normal';
  const RS = 256;
  const rs = rockSet(RS);
  const rockAlbedo = dataTex(rs.albedo, RS, RS, true, true, true, aniso);
  const rockNormal = dataTex(rs.normal, RS, RS, false, true, true, aniso);
  return {
    albedo,
    normal,
    rockAlbedo,
    rockNormal,
    foliageMean: fn > 0 ? [fr / fn, fg / fn, fb / fn] : [0.04, 0.07, 0.03],
    ms: performance.now() - t0,
    timings: { cards: t1 - t0, bark: t2 - t1, normal: performance.now() - t2 },
    dispose() {
      albedo.dispose();
      normal.dispose();
      rockAlbedo.dispose();
      rockNormal.dispose();
    },
  };
}
