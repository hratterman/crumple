// Procedural fallback textures — pure typed-array synthesis, no DOM/canvas/three,
// so it runs identically in node (vitest) and the browser. Used whenever the
// CI-fetched CC0 assets are absent, which is the normal state in the dev sandbox.

import type { TerrainSlug } from './manifest';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA8, row-major, tightly packed; alpha is always 255 */
  data: Uint8Array;
}

export interface FallbackMaps {
  color: RgbaImage;
  normal: RgbaImage;
  rough: RgbaImage;
}

// src/core/rng did not exist when this module was written (parallel P0/P1 build);
// local mulberry32 copy — swap for core/rng once it lands if desired.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixSeed(slug: string, seed: number): number {
  let h = 2166136261 ^ (seed >>> 0);
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // one PRNG step decorrelates adjacent seed values
  return Math.floor(mulberry32(h >>> 0)() * 4294967296) >>> 0;
}

// Lattice hash with per-axis periods so every noise octave tiles across [0,1)².
function latticeHash(ix: number, iy: number, px: number, py: number, seed: number): number {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed | 0, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Tileable value noise in [0,1]; u,v in [0,1), fx/fy = integer frequencies. */
function valueNoise(u: number, v: number, fx: number, fy: number, seed: number): number {
  const x = u * fx;
  const y = v * fy;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = latticeHash(x0, y0, fx, fy, seed);
  const b = latticeHash(x0 + 1, y0, fx, fy, seed);
  const c = latticeHash(x0, y0 + 1, fx, fy, seed);
  const d = latticeHash(x0 + 1, y0 + 1, fx, fy, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tileable fbm in [0,1] (frequency doubles per octave, so periodicity is preserved). */
function fbm(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, f, f, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

interface WorleyResult {
  dist: number;
  id: number;
}

/** Nearest-feature (Worley) distance + owning-cell id, tileable. */
function worley(u: number, v: number, freq: number, seed: number, out: WorleyResult): void {
  const x = u * freq;
  const y = v * freq;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best = Infinity;
  let bestId = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const dx = gx + latticeHash(gx, gy, freq, freq, seed + 31) - x;
      const dy = gy + latticeHash(gx, gy, freq, freq, seed + 57) - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bestId = latticeHash(gx, gy, freq, freq, seed + 91);
      }
    }
  }
  out.dist = Math.sqrt(best);
  out.id = bestId;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function clampByte(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}

interface Surf {
  h: number; // heightfield sample in ~[0,1], feeds the sobel normal
  r: number; // color 0..255
  g: number;
  b: number;
  rough: number; // 0..1
}

const NORMAL_STRENGTH: Record<TerrainSlug, number> = {
  asphalt: 5,
  grass: 3.5,
  dirt: 4.5,
  rock: 7,
  gravel: 7,
};

const scratchWorley: WorleyResult = { dist: 0, id: 0 };

function sampleSurface(slug: TerrainSlug, u: number, v: number, s: number, out: Surf): void {
  switch (slug) {
    case 'asphalt': {
      // dark grey fine speckle + sparse faint recessed cracks
      const speck = valueNoise(u, v, 192, 192, s);
      const macro = fbm(u, v, 6, 3, s + 11);
      const crackField = fbm(u, v, 5, 4, s + 23);
      const crack = smoothstep(0.045, 0.012, Math.abs(crackField - 0.5));
      const shade = 0.16 + 0.06 * (macro - 0.5) + 0.1 * (speck - 0.5);
      const lit = Math.max(0.02, shade * (1 - 0.5 * crack));
      out.r = 255 * lit * 0.98;
      out.g = 255 * lit;
      out.b = 255 * lit * 1.04;
      out.h = 0.5 + 0.25 * (macro - 0.5) + 0.12 * (speck - 0.5) - 0.5 * crack;
      out.rough = 0.82 + 0.1 * (speck - 0.5) + 0.12 * crack;
      return;
    }
    case 'grass': {
      // green variegation with horizontal-ish streaks
      const patch = fbm(u, v, 10, 4, s);
      const streak = valueNoise(u, v, 96, 14, s + 7);
      const fine = valueNoise(u, v, 220, 220, s + 3);
      const gg = 0.3 + 0.3 * patch + 0.14 * (streak - 0.5) + 0.06 * (fine - 0.5);
      out.r = 255 * gg * 0.62;
      out.g = 255 * gg;
      out.b = 255 * gg * 0.34;
      out.h = 0.4 * patch + 0.35 * streak + 0.25 * fine;
      out.rough = 0.9 - 0.06 * patch;
      return;
    }
    case 'dirt': {
      // brown blotches with fine grain
      const blotch = fbm(u, v, 5, 4, s);
      const fine = valueNoise(u, v, 140, 140, s + 5);
      const t = Math.min(1, Math.max(0, 0.15 + 0.75 * blotch + 0.12 * (fine - 0.5)));
      out.r = 70 + 78 * t;
      out.g = 50 + 60 * t;
      out.b = 34 + 40 * t;
      out.h = 0.75 * blotch + 0.2 * fine;
      out.rough = 0.96 - 0.06 * blotch;
      return;
    }
    case 'rock': {
      // grey-brown strata: warped triangle-wave bands along v
      const warp = fbm(u, v, 4, 4, s);
      const bands = Math.abs(2 * frac(v * 7 + 0.9 * warp) - 1);
      const grain = valueNoise(u, v, 180, 180, s + 9);
      const t = 0.55 * bands + 0.28 * warp + 0.17 * grain;
      out.r = 92 + 64 * t;
      out.g = 84 + 60 * t;
      out.b = 72 + 50 * t;
      out.h = 0.55 * bands + 0.35 * warp + 0.1 * grain;
      out.rough = 0.68 + 0.18 * grain;
      return;
    }
    case 'gravel': {
      // dense stone speckle: worley cells as stones over dark gaps
      worley(u, v, 42, s, scratchWorley);
      const stone = smoothstep(0.62, 0.38, scratchWorley.dist);
      const fine = valueNoise(u, v, 200, 200, s + 13);
      const sc = 0.3 + 0.5 * scratchWorley.id + 0.1 * (fine - 0.5);
      out.r = 35 + (255 * sc - 35) * stone;
      out.g = 32 + (255 * sc * 0.98 - 32) * stone;
      out.b = 30 + (255 * sc * 0.95 - 30) * stone;
      out.h = stone * (0.3 + 0.6 * sc) + 0.1 * fine;
      out.rough = 0.9 - 0.25 * stone + 0.05 * (fine - 0.5);
      return;
    }
  }
}

/**
 * Sobel of the heightfield → tangent-space normal map, OpenGL Y+ convention
 * (+v runs opposite to +row), 127-centered bytes: decode as (byte - 127) / 127.
 */
function heightToNormal(h: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
      const gy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
      const nx = -gx * strength;
      const ny = gy * strength; // dh/dv = -dh/drow, folded into the sign here
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * size + x) * 4;
      out[o] = clampByte(127 + nx * inv * 127);
      out[o + 1] = clampByte(127 + ny * inv * 127);
      out[o + 2] = clampByte(127 + inv * 127);
      out[o + 3] = 255;
    }
  }
  return out;
}

const scratchSurf: Surf = { h: 0, r: 0, g: 0, b: 0, rough: 0 };

/**
 * Synthesize a tileable color/normal/rough set for one terrain material.
 * Deterministic in (slug, size, seed); same-seed calls return identical bytes.
 */
export function makeFallbackMaps(slug: TerrainSlug, size = 512, seed = 1): FallbackMaps {
  const s = mixSeed(slug, seed);
  const n = size * size;
  const height = new Float32Array(n);
  const color = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      sampleSurface(slug, u, v, s, scratchSurf);
      const i = y * size + x;
      height[i] = scratchSurf.h;
      const o = i * 4;
      color[o] = clampByte(scratchSurf.r);
      color[o + 1] = clampByte(scratchSurf.g);
      color[o + 2] = clampByte(scratchSurf.b);
      color[o + 3] = 255;
      const rb = clampByte(scratchSurf.rough * 255);
      rough[o] = rb;
      rough[o + 1] = rb;
      rough[o + 2] = rb;
      rough[o + 3] = 255;
    }
  }
  const normal = heightToNormal(height, size, NORMAL_STRENGTH[slug]);
  return {
    color: { width: size, height: size, data: color },
    normal: { width: size, height: size, data: normal },
    rough: { width: size, height: size, data: rough },
  };
}

/**
 * Golden-hour gradient equirect (2:1) with a low sun disk — env-map fallback
 * when the Poly Haven HDRs are absent. LDR RGBA; treat as sRGB.
 */
export function makeFallbackSkyEquirect(size = 1024): RgbaImage {
  const width = Math.max(4, size | 0);
  const height = Math.max(2, width >> 1);
  const data = new Uint8Array(width * height * 4);
  const sunEl = 0.1; // rad above horizon — low golden-hour sun
  const sunAz = 0; // centered at u = 0.5
  const sx = Math.cos(sunEl) * Math.sin(sunAz);
  const sy = Math.sin(sunEl);
  const sz = Math.cos(sunEl) * Math.cos(sunAz);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const el = (0.5 - v) * Math.PI; // row 0 = zenith
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let x = 0; x < width; x++) {
      const az = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = ce * Math.sin(az);
      const dz = ce * Math.cos(az);
      const cosSun = Math.min(1, Math.max(-1, dx * sx + se * sy + dz * sz));
      let r: number;
      let g: number;
      let b: number;
      if (el >= 0) {
        // zenith blue-grey → warm horizon band
        const t = (1 - el / (Math.PI / 2)) ** 3;
        r = 70 + 174 * t;
        g = 92 + 64 * t;
        b = 132 - 36 * t;
      } else {
        // warm ground glow fading to dark below the horizon
        const t = Math.min(1, -el / 0.5);
        r = 150 - 98 * t;
        g = 110 - 68 * t;
        b = 84 - 46 * t;
      }
      const ang = Math.acos(cosSun);
      const disk = smoothstep(0.035, 0.02, ang);
      const glowBase = Math.max(0, cosSun);
      const glow = 0.6 * glowBase ** 64 + 0.25 * glowBase ** 8;
      r += disk * 255 + glow * 220;
      g += disk * 235 + glow * 150;
      b += disk * 200 + glow * 80;
      const o = (y * width + x) * 4;
      data[o] = clampByte(r);
      data[o + 1] = clampByte(g);
      data[o + 2] = clampByte(b);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
