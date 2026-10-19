/**
 * Procedural vehicle textures (A3). Everything is generated on the CPU once
 * per parameter set and cached (no downloads): metallic flake, clearcoat
 * orange peel, plastic / leather / fabric grain, lamp reflector + prism
 * lenses, honeycomb grille, brake disc, tyre tread, tyre sidewall lettering
 * and the licence plate.
 *
 * The pixel generators are PURE (seeded integer hashes, no Math.random) and
 * return RGBA8 images, so they run in node tests; only the `*Texture`
 * wrappers touch three, and only lettering/plate need a 2D canvas (they
 * degrade to plain images without one).
 *
 * Conventions: every image TILES (wraps on both axes); normal maps are
 * OpenGL tangent space (+Y = +v), NoColorSpace; colour maps are sRGB;
 * DataTexture rows are bottom-up (row 0 = v 0, flipY false).
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';

// ============================================================ images
/** RGBA8 image, row 0 = bottom (v = 0). */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function image(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Integer hash → [0, 1). Deterministic across engines (Math.imul only). */
export function hash3(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrapI = (i: number, n: number): number => ((i % n) + n) % n;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Periodic value noise in lattice units (period in cells), [0, 1). */
export function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const ax = wrapI(x0, period);
  const ay = wrapI(y0, period);
  const bx = wrapI(x0 + 1, period);
  const by = wrapI(y0 + 1, period);
  const a = hash3(ax, ay, seed);
  const b = hash3(bx, ay, seed);
  const c = hash3(ax, by, seed);
  const d = hash3(bx, by, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Tileable fbm over a w×h image: u, v ∈ [0, 1), base period in cells, octaves double the period. */
export function periodicFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise(u * p, v * p, p, seed + o * 101);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Height field (row 0 = bottom) → tangent-space normal map. strength = slope per unit height per pixel. */
export function heightToNormal(h: Float32Array, w: number, ht: number, strength: number, wrap = true): PixelImage {
  const out = image(w, ht);
  const at = (x: number, y: number): number => {
    if (wrap) return h[wrapI(y, ht) * w + wrapI(x, w)]!;
    return h[Math.min(ht - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  };
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * w + x) * 4;
      out.data[o] = Math.round((-dx * il * 0.5 + 0.5) * 255);
      out.data[o + 1] = Math.round((-dy * il * 0.5 + 0.5) * 255);
      out.data[o + 2] = Math.round((il * 0.5 + 0.5) * 255);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Grey (or tinted) colour map from a 0..1 field: value lerps lo..hi (0..1 sRGB-ish). */
function fieldToGrey(f: Float32Array, w: number, ht: number, lo: number, hi: number): PixelImage {
  const out = image(w, ht);
  for (let i = 0; i < w * ht; i++) {
    const g = Math.round(Math.min(1, Math.max(0, lo + (hi - lo) * f[i]!)) * 255);
    out.data[i * 4] = g;
    out.data[i * 4 + 1] = g;
    out.data[i * 4 + 2] = g;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

// ============================================================ paint
/**
 * Metallic flake normal map: a wrapped jittered Voronoi of platelets
 * (≈ cellPx across), each platelet a flat facet with a random tilt
 * (|tilt| ≤ maxTilt, tangent-space xy); a (1 − density) share of cells is
 * pigment (flat). Mipmapped, the flakes average out to the plain base
 * normal far away and sparkle up close.
 */
export function flakeNormalImage(size = 512, cellPx = 4, density = 0.7, maxTilt = 0.55, seed = 7): PixelImage {
  const out = image(size, size);
  const cells = Math.max(1, Math.round(size / cellPx));
  const cs = size / cells;
  // feature points per cell
  const fx = new Float32Array(cells * cells);
  const fy = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      fx[j * cells + i] = (i + 0.15 + 0.7 * hash3(i, j, seed)) * cs;
      fy[j * cells + i] = (j + 0.15 + 0.7 * hash3(i, j, seed + 1)) * cs;
    }
  }
  for (let y = 0; y < size; y++) {
    const cj = Math.floor(y / cs);
    for (let x = 0; x < size; x++) {
      const ci = Math.floor(x / cs);
      let best = Infinity;
      let bi = 0;
      let bj = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di;
          const jj = cj + dj;
          const wi = wrapI(ii, cells);
          const wj = wrapI(jj, cells);
          const px = fx[wj * cells + wi]! + (ii - wi) * cs;
          const py = fy[wj * cells + wi]! + (jj - wj) * cs;
          const d = (px - x - 0.5) ** 2 + (py - y - 0.5) ** 2;
          if (d < best) {
            best = d;
            bi = wi;
            bj = wj;
          }
        }
      }
      let nx = 0;
      let ny = 0;
      if (hash3(bi, bj, seed + 2) < density) {
        // tilt: random direction, magnitude biased toward small (most flakes lie flat)
        const a = hash3(bi, bj, seed + 3) * Math.PI * 2;
        const m = maxTilt * Math.sqrt(hash3(bi, bj, seed + 4)) * (0.35 + 0.65 * hash3(bi, bj, seed + 5));
        nx = Math.cos(a) * m;
        ny = Math.sin(a) * m;
      }
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const o = (y * size + x) * 4;
      out.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Clearcoat orange peel: soft tileable undulation (≈ 8 bumps across the tile). */
export function orangePeelImage(size = 256, strength = 6, seed = 19): PixelImage {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = periodicFbm(x / size, y / size, 8, 3, seed, 0.45);
    }
  }
  return heightToNormal(h, size, size, strength);
}

// ============================================================ trim / interior grains
export type GrainKind = 'plastic' | 'leather' | 'fabric' | 'rubber';

/** Wrapped Voronoi F2 − F1 (cell-edge distance, in pixels) over `cells`² jittered points. */
function voronoiEdge(size: number, cells: number, seed: number): Float32Array {
  const cs = size / cells;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ci = Math.floor(x / cs);
      const cj = Math.floor(y / cs);
      let f1 = Infinity;
      let f2 = Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di;
          const jj = cj + dj;
          const wi = wrapI(ii, cells);
          const wj = wrapI(jj, cells);
          const px = (ii + 0.1 + 0.8 * hash3(wi, wj, seed)) * cs;
          const py = (jj + 0.1 + 0.8 * hash3(wi, wj, seed + 1)) * cs;
          const d = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      }
      out[y * size + x] = f2 - f1;
    }
  }
  return out;
}

/** Grain normal maps: textured trim plastic (stipple), leather (creased cells), woven fabric, rubber (fine noise). */
export function grainNormalImage(kind: GrainKind, size = 256, seed = 31): PixelImage {
  const h = new Float32Array(size * size);
  if (kind === 'plastic') {
    const edges = voronoiEdge(size, 48, seed);
    for (let i = 0; i < size * size; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      const n = periodicFbm(x / size, y / size, 64, 2, seed + 7);
      h[i] = 0.55 * smooth(0, 2.2, edges[i]!) + 0.45 * n;
    }
    return heightToNormal(h, size, size, 1.6);
  }
  if (kind === 'leather') {
    const edges = voronoiEdge(size, 22, seed);
    for (let i = 0; i < size * size; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      const n = periodicFbm(x / size, y / size, 32, 3, seed + 3);
      h[i] = 0.75 * smooth(0, 3.5, edges[i]!) + 0.25 * n;
    }
    return heightToNormal(h, size, size, 2.2);
  }
  if (kind === 'fabric') {
    const threads = 16; // per tile
    const p = size / threads;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = Math.floor(x / p);
        const j = Math.floor(y / p);
        const fx = x / p - i;
        const fy = y / p - j;
        const warpOver = (i + j) % 2 === 0;
        const across = warpOver ? fx : fy; // the visible thread's cross-section coordinate
        const along = warpOver ? fy : fx;
        const prof = Math.sin(Math.PI * across); // round thread
        const dip = 0.25 * Math.sin(Math.PI * along); // thread arches over the crossing one
        h[y * size + x] = 0.65 * prof + dip + 0.12 * periodicNoise((x / size) * 64, (y / size) * 64, 64, seed);
      }
    }
    return heightToNormal(h, size, size, 1.4);
  }
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    h[i] = periodicFbm(x / size, y / size, 32, 3, seed + 11);
  }
  return heightToNormal(h, size, size, 2.0);
}

// ============================================================ hex lattices (lenses, grille)
/**
 * Nearest hex-lattice centre (two offset rectangular lattices a × a√3),
 * wrapped on a w × h tile where w = cols·a, h = rows·b. Returns offset
 * (dx, dy) from the centre in pixels plus the cell id.
 */
function hexCell(x: number, y: number, a: number, b: number, cols: number, rows: number, out: Float64Array): void {
  let best = Infinity;
  for (let lat = 0; lat < 2; lat++) {
    const ox = lat * a * 0.5;
    const oy = lat * b * 0.5;
    const i = Math.round((x - ox) / a);
    const j = Math.round((y - oy) / b);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const cx = ox + (i + di) * a;
        const cy = oy + (j + dj) * b;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < best) {
          best = d;
          out[0] = x - cx;
          out[1] = y - cy;
          out[2] = wrapI(i + di, cols) * 2 + lat + wrapI(j + dj, rows) * cols * 2;
        }
      }
    }
  }
}

/** Hex "radius" metric of an offset (flat-topped cells of the lattice above: 1 at the edge). */
function hexDist(dx: number, dy: number, a: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // pointy-top hexagon with inradius a/2 along x
  return Math.max(ax, ax * 0.5 + ay * 0.8660254) / (a * 0.5);
}

export type LensKind = 'reflector' | 'prism';

/**
 * Lamp internals seen through a clear lens: 'reflector' = concave
 * multi-faceted mirror cells (headlamp), 'prism' = small hex pyramids
 * (tail / indicator lens optics).
 */
export function lensNormalImage(kind: LensKind, seed = 3): PixelImage {
  const a = kind === 'reflector' ? 32 : 16;
  const b = Math.round(a * Math.sqrt(3));
  const cols = kind === 'reflector' ? 8 : 16;
  const rows = kind === 'reflector' ? 4 : 8;
  const w = cols * a;
  const ht = rows * b;
  const out = image(w, ht);
  const c = new Float64Array(3);
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      hexCell(x + 0.5, y + 0.5, a, b, cols, rows, c);
      const r = hexDist(c[0]!, c[1]!, a);
      let nx: number;
      let ny: number;
      if (kind === 'reflector') {
        // concave dome: normal tilts toward the centre, steeper toward the rim, + per-cell jitter
        const k = 0.9;
        nx = (-c[0]! / (a * 0.5)) * k * 0.6 + (hash3(c[2]!, 0, seed) - 0.5) * 0.15;
        ny = (-c[1]! / (a * 0.5)) * k * 0.6 + (hash3(c[2]!, 1, seed) - 0.5) * 0.15;
        if (r > 0.93) {
          nx *= 0.2;
          ny *= 0.2;
        }
      } else {
        // pyramid: facet normal along the dominant hex direction
        const ang = Math.atan2(c[1]!, c[0]!);
        const sector = Math.round(ang / (Math.PI / 3)) * (Math.PI / 3);
        const m = r > 0.08 ? 0.55 : 0;
        nx = Math.cos(sector) * m;
        ny = Math.sin(sector) * m;
      }
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * w + x) * 4;
      out.data[o] = Math.round((nx / l) * 127.5 + 127.5);
      out.data[o + 1] = Math.round((ny / l) * 127.5 + 127.5);
      out.data[o + 2] = Math.round((1 / l) * 127.5 + 127.5);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Honeycomb grille mesh: raised bevelled walls around dark recessed cells. Returns normal + colour (cavity) maps. */
export function honeycombImages(): { normal: PixelImage; color: PixelImage } {
  const a = 32;
  const b = Math.round(a * Math.sqrt(3));
  const cols = 8;
  const rows = 4;
  const w = cols * a;
  const ht = rows * b;
  const h = new Float32Array(w * ht);
  const cav = new Float32Array(w * ht);
  const c = new Float64Array(3);
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      hexCell(x + 0.5, y + 0.5, a, b, cols, rows, c);
      const r = hexDist(c[0]!, c[1]!, a);
      const wall = smooth(0.72, 0.86, r);
      h[y * w + x] = wall;
      // cavity: dark hole, walls lit, slight gradient into the hole
      cav[y * w + x] = 0.08 + 0.92 * smooth(0.6, 0.86, r);
    }
  }
  return { normal: heightToNormal(h, w, ht, 4), color: fieldToGrey(cav, w, ht, 0, 1) };
}

// ============================================================ brake disc
/**
 * Brake disc face in polar UV (u = angle 0..1 around, v = radius 0..1
 * across the swept band): concentric grinding marks + 3 staggered rows of
 * cross-drilled holes. Normal + colour (holes dark).
 */
export function brakeDiscImages(holesAround = 24, seed = 5): { normal: PixelImage; color: PixelImage } {
  const w = 1024;
  const ht = 64;
  const h = new Float32Array(w * ht);
  const col = new Float32Array(w * ht);
  const rowsV = [0.3, 0.5, 0.7];
  for (let y = 0; y < ht; y++) {
    const v = (y + 0.5) / ht;
    const grind = 0.35 * periodicNoise(0.5, v * 160, 1 << 20, seed) + 0.15 * periodicNoise(0.5, v * 41, 1 << 20, seed + 1);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      let hole = 0;
      for (let r = 0; r < rowsV.length; r++) {
        const n = holesAround;
        const phase = (u * n + r / 3) % 1;
        const du = (phase - 0.5) * (w / n); // pixels
        const dv = (v - rowsV[r]!) * ht * 1.0;
        const d = Math.sqrt(du * du + dv * dv);
        hole = Math.max(hole, 1 - smooth(4.5, 6.5, d));
      }
      h[y * w + x] = grind * (1 - hole) - hole;
      col[y * w + x] = (0.85 + 0.15 * grind) * (1 - 0.9 * hole);
    }
  }
  return { normal: heightToNormal(h, w, ht, 1.2), color: fieldToGrey(col, w, ht, 0, 1) };
}

// ============================================================ tyre tread
export type TreadPattern = 'street' | 'sport' | 'allTerrain';

/**
 * Tread tile: `pitches` tread pitches around (u), the full tread band
 * across (v, arc-length fraction of the band). `grooves` = circumferential
 * groove centres as v fractions with widths (fractions) — the same values
 * the tyre mesh notches geometrically, so the map's groove walls land on
 * the mesh grooves. Normal + colour (groove floors and sipes darker).
 */
export function treadImages(
  pattern: TreadPattern,
  grooves: readonly { v: number; w: number }[],
  pitches = 4,
  seed = 13,
): { normal: PixelImage; color: PixelImage } {
  const w = 512;
  const ht = 256;
  const h = new Float32Array(w * ht);
  const shade = new Float32Array(w * ht);
  const pitch = w / pitches;
  const firstG = grooves.length ? grooves[0]!.v - grooves[0]!.w / 2 : 0.2;
  const lastG = grooves.length ? grooves[grooves.length - 1]!.v + grooves[grooves.length - 1]!.w / 2 : 0.8;
  for (let y = 0; y < ht; y++) {
    const v = (y + 0.5) / ht;
    // circumferential grooves (mesh carries the depth; the map adds the wall bevel + darkening)
    let g = 0;
    for (const gr of grooves) g = Math.max(g, 1 - smooth(gr.w * 0.42, gr.w * 0.6, Math.abs(v - gr.v)));
    const shoulder = v < firstG || v > lastG;
    const sideSign = v < 0.5 ? -1 : 1;
    // which rib (between grooves) this row lies in: used to stagger features
    let rib = 0;
    for (const gr of grooves) if (v > gr.v) rib++;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      let cut = 0; // 0 rubber .. 1 deep groove
      let sipe = 0;
      if (pattern === 'street') {
        if (shoulder) {
          // lateral shoulder grooves, slightly curved, ending 30 % into the rib
          const into = sideSign < 0 ? (firstG - v) / firstG : (v - lastG) / (1 - lastG);
          const curve = 6 * into * into;
          const d = Math.abs((((px + curve) % pitch) + pitch) % pitch - pitch * 0.5);
          cut = (1 - smooth(5, 8, d)) * smooth(0.0, 0.3, into);
        } else {
          // two angled sipes per pitch in each rib
          const off = rib * pitch * 0.25 + (v - 0.5) * 30;
          const d = Math.abs((((px + off) % (pitch / 2)) + pitch / 2) % (pitch / 2) - pitch / 4);
          sipe = 1 - smooth(0.8, 1.8, d);
        }
      } else if (pattern === 'sport') {
        if (shoulder) {
          const into = sideSign < 0 ? (firstG - v) / firstG : (v - lastG) / (1 - lastG);
          const slant = into * 40 * sideSign;
          const d = Math.abs((((px + slant) % pitch) + pitch) % pitch - pitch * 0.5);
          cut = (1 - smooth(7, 10, d)) * smooth(0.05, 0.25, into);
        } else if (rib === 1 || rib === grooves.length - 1) {
          // short angled notches off the main grooves
          const d = Math.abs((((px + (v - 0.5) * 120) % pitch) + pitch) % pitch - pitch * 0.5);
          sipe = (1 - smooth(1.2, 2.6, d)) * 0.8;
        }
      } else {
        // all-terrain: staggered blocks with zig-zag sipes
        const stagger = (rib % 2) * pitch * 0.5;
        const d = Math.abs((((px + stagger) % pitch) + pitch) % pitch - pitch * 0.5);
        cut = 1 - smooth(9, 12, d);
        const zig = Math.abs(((px / 10 + rib) % 2) - 1) * 6;
        const ds = Math.abs((((v * ht + zig) % 32) + 32) % 32 - 16);
        sipe = (1 - smooth(0.8, 1.6, ds)) * (1 - cut);
      }
      const k = y * w + x;
      h[k] = -Math.max(g, cut) - 0.6 * sipe + 0.04 * hash3(x, y, seed);
      shade[k] = 1 - 0.45 * Math.max(g, cut) - 0.35 * sipe;
    }
  }
  return { normal: heightToNormal(h, w, ht, 2.4), color: fieldToGrey(shade, w, ht, 0, 1) };
}

// ============================================================ canvas (lettering, plate)
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas2D(w: number, h: number): Ctx2D | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d');
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c.getContext('2d');
    }
  } catch {
    // fall through
  }
  return null;
}

/** Canvas pixels → image with rows flipped to bottom-up. */
function canvasToImage(ctx: Ctx2D, w: number, h: number): PixelImage {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = image(w, h);
  for (let y = 0; y < h; y++) out.data.set(src.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

/** Separable box blur in place (wrap in x, clamp in y): softens canvas glyph edges into rounded raised lettering. */
function blurField(f: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(f.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += f[y * w + wrapI(x + k, w)]!;
      tmp[y * w + x] = s / (2 * r + 1);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!;
      f[y * w + x] = s / (2 * r + 1);
    }
  }
}

/**
 * Sidewall: u = around (one tile = the whole circumference, read along +u),
 * v = bead (0) → shoulder (1). Rim-protector rib, shoulder ribs, brand
 * text twice around + size code. Without a canvas only the ribs are drawn.
 */
export function sidewallImages(text: string | null, sizeCode = '205/55 R16 91V'): { normal: PixelImage; color: PixelImage } {
  const w = 2048;
  const ht = 256;
  const f = new Float32Array(w * ht);
  const ctx = makeCanvas2D(w, ht);
  if (ctx && text) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, ht);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // canvas y down = v down: letter tops toward the shoulder (v = 1 is canvas top)
    ctx.font = `900 ${Math.round(ht * 0.3)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    for (const u of [0.25, 0.75]) ctx.fillText(text.toUpperCase(), u * w, ht * 0.5);
    ctx.font = `700 ${Math.round(ht * 0.12)}px Arial, sans-serif`;
    for (const u of [0.02, 0.5, 0.98]) ctx.fillText(sizeCode, u * w, ht * 0.56);
    ctx.font = `700 ${Math.round(ht * 0.085)}px Arial, sans-serif`;
    for (const u of [0.0, 0.5]) ctx.fillText('TUBELESS  RADIAL', (u + 0.07) * w, ht * 0.7);
    const img = canvasToImage(ctx, w, ht);
    for (let i = 0; i < w * ht; i++) f[i] = img.data[i * 4]! / 255;
    blurField(f, w, ht, 1);
  }
  const lettering = Float32Array.from(f);
  for (let y = 0; y < ht; y++) {
    const v = (y + 0.5) / ht;
    // rim protector bead (v ≈ 0.1) and fine concentric ribs near the shoulder
    const rib = 0.7 * (1 - smooth(0.012, 0.03, Math.abs(v - 0.11))) + 0.35 * (1 - smooth(0.004, 0.012, Math.abs(v - 0.86)));
    const ribs2 = v > 0.88 ? 0.18 * (0.5 + 0.5 * Math.cos(v * ht * 0.9)) : 0;
    for (let x = 0; x < w; x++) f[y * w + x] = Math.max(f[y * w + x]! * 0.8, rib) + ribs2;
  }
  const col = new Float32Array(w * ht);
  for (let i = 0; i < w * ht; i++) col[i] = 0.62 + 0.38 * lettering[i]!;
  return { normal: heightToNormal(f, w, ht, 5), color: fieldToGrey(col, w, ht, 0, 1) };
}

/** Licence plate colour map (EU-like 520 × 110 mm proportions); plain plate without a canvas. */
export function plateImage(text: string): PixelImage {
  const w = 512;
  const ht = 112;
  const ctx = makeCanvas2D(w, ht);
  if (!ctx) {
    const out = image(w, ht);
    for (let i = 0; i < w * ht; i++) out.data.set([236, 236, 230, 255], i * 4);
    return out;
  }
  ctx.fillStyle = '#ecece6';
  ctx.fillRect(0, 0, w, ht);
  ctx.strokeStyle = '#151515';
  ctx.lineWidth = 5;
  ctx.strokeRect(5, 5, w - 10, ht - 10);
  ctx.fillStyle = '#1d3f9a';
  ctx.fillRect(8, 8, 46, ht - 16);
  ctx.fillStyle = '#f2d230';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(31 + Math.cos(a) * 13, 40 + Math.sin(a) * 13, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.font = '700 24px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CR', 31, 82);
  ctx.fillStyle = '#121212';
  ctx.font = `700 ${Math.round(ht * 0.66)}px "DIN Alternate", "Arial Narrow", Arial, sans-serif`;
  ctx.fillText(text.toUpperCase(), (w + 54) / 2, ht * 0.54, w - 80);
  return canvasToImage(ctx, w, ht);
}

// ============================================================ three wrappers + cache
const cache = new Map<string, DataTexture>();

/** DataTexture from an image: repeat-wrapped, trilinear + anisotropic, mipmapped. */
export function imageTexture(img: PixelImage, color: boolean, name: string): DataTexture {
  const t = new DataTexture(img.data, img.width, img.height, RGBAFormat, UnsignedByteType);
  t.name = name;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.flipY = false;
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function cached(key: string, make: () => DataTexture): DataTexture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/**
 * Cached texture accessors. Textures are SHARED by every vehicle: materials
 * never dispose them (per-material `repeat` needs a `.clone()`, which
 * shares the GPU upload through its Source).
 */
export const vehicleTextures = {
  flake: (density = 0.7): DataTexture =>
    cached(`flake:${density.toFixed(2)}`, () => imageTexture(flakeNormalImage(512, 4, density), false, 'crFlake')),
  orangePeel: (): DataTexture => cached('peel', () => imageTexture(orangePeelImage(), false, 'crOrangePeel')),
  grain: (kind: GrainKind): DataTexture => cached(`grain:${kind}`, () => imageTexture(grainNormalImage(kind), false, `crGrain-${kind}`)),
  lens: (kind: LensKind): DataTexture => cached(`lens:${kind}`, () => imageTexture(lensNormalImage(kind), false, `crLens-${kind}`)),
  honeycomb: (): { normal: DataTexture; color: DataTexture } => {
    let imgs: ReturnType<typeof honeycombImages> | null = null;
    const get = (): ReturnType<typeof honeycombImages> => (imgs ??= honeycombImages());
    return {
      normal: cached('honey:n', () => imageTexture(get().normal, false, 'crHoneyN')),
      color: cached('honey:c', () => imageTexture(get().color, true, 'crHoneyC')),
    };
  },
  brakeDisc: (): { normal: DataTexture; color: DataTexture } => {
    let imgs: ReturnType<typeof brakeDiscImages> | null = null;
    const get = (): ReturnType<typeof brakeDiscImages> => (imgs ??= brakeDiscImages());
    return {
      normal: cached('disc:n', () => imageTexture(get().normal, false, 'crDiscN')),
      color: cached('disc:c', () => imageTexture(get().color, true, 'crDiscC')),
    };
  },
  tread: (pattern: TreadPattern, grooves: readonly { v: number; w: number }[], pitches: number): { normal: DataTexture; color: DataTexture } => {
    const key = `tread:${pattern}:${pitches}:${grooves.map((g) => `${g.v.toFixed(3)}/${g.w.toFixed(3)}`).join(',')}`;
    let imgs: ReturnType<typeof treadImages> | null = null;
    const get = (): ReturnType<typeof treadImages> => (imgs ??= treadImages(pattern, grooves, pitches));
    return {
      normal: cached(`${key}:n`, () => imageTexture(get().normal, false, 'crTreadN')),
      color: cached(`${key}:c`, () => imageTexture(get().color, true, 'crTreadC')),
    };
  },
  sidewall: (text: string | null, sizeCode?: string): { normal: DataTexture; color: DataTexture } => {
    const key = `side:${text ?? ''}:${sizeCode ?? ''}`;
    let imgs: ReturnType<typeof sidewallImages> | null = null;
    const get = (): ReturnType<typeof sidewallImages> => (imgs ??= sidewallImages(text, sizeCode));
    return {
      normal: cached(`${key}:n`, () => imageTexture(get().normal, false, 'crSideN')),
      color: cached(`${key}:c`, () => imageTexture(get().color, true, 'crSideC')),
    };
  },
  plate: (text: string): DataTexture =>
    cached(`plate:${text}`, () => {
      const t = imageTexture(plateImage(text), true, 'crPlate');
      t.wrapS = t.wrapT = RepeatWrapping;
      return t;
    }),
};

/** Drops every cached vehicle texture (GPU memory); only for full teardown (tests, dev pages). */
export function disposeVehicleTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
