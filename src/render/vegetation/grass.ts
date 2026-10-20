/**
 * Grass tufts around the camera: GRASS_TILE_M tiles keyed by integer tile
 * coordinates, each filled deterministically (per-tile hash) with tufts on
 * grass-splat ground (density ∝ grass weight; none on paved / gravel verges,
 * rock, dirt tracks, water or steep ground). The tuft colour follows the
 * terrain's grass layer (its mean albedo × the same macro-variation noise
 * the terrain shader samples, drier where dirt shows through). Tiles are
 * cached; the instance buffer is refilled from the tiles in a widened view
 * cone when the camera moves or turns. The vertex stage thins and shrinks
 * tufts toward grassRadiusM (no visible edge) and bends them in the wind.
 */
import { Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, DynamicDrawUsage } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

import type { TerrainSampler } from '../../world/types';
import type { ShaderPatch } from '../types';
import type { VegUniforms } from './shader';

export const GRASS_TILE_M = 8;
/** Candidate tufts per m² before the splat / slope tests. */
const GRASS_DENSITY = 3.6;
/** Floats per tuft: iA (x, y, z, height) + iB (r, g, b, seed). */
export const GRASS_STRIDE = 8;

/** Grass tint inputs: the terrain grass layer's mean albedo and macro variation (render/terrain LOOK). */
const GRASS_MEAN: readonly [number, number, number] = [0.085, 0.105, 0.035];
const MACRO_A: readonly [number, number, number] = [1.2, 1.02, 0.7];
const MACRO_B: readonly [number, number, number] = [0.8, 1.0, 0.85];

/** Blades per tuft and their shape (pure; tested). */
export function buildTuft(blades = 7): { position: Float32Array; normal: Float32Array; gb: Float32Array; index: Uint16Array } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const gb: number[] = [];
  const idx: number[] = [];
  let s = 0x9e3779b9;
  const r = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const T = [0, 0.55];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 0.8;
    const ox = Math.cos(a) * 0.07 * r();
    const oz = Math.sin(a) * 0.07 * r();
    const lean = 0.18 + 0.3 * r();
    const h = 0.65 + 0.35 * r();
    const w = 0.02 + 0.012 * r();
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Blade plane: across = perpendicular to the lean direction.
    const ax = -dz;
    const az = dx;
    const base = pos.length / 3;
    for (const t of T) {
      const bend = lean * t * t;
      for (const side of [-1, 1]) {
        pos.push(ox + dx * bend + ax * side * w * (1 - t), h * t * (1 - 0.15 * bend), oz + dz * bend + az * side * w * (1 - t));
        nrm.push(dx * 0.5, 0.85, dz * 0.5);
        gb.push(t, side, b / blades, 0);
      }
    }
    pos.push(ox + dx * lean, h * (1 - 0.15 * lean), oz + dz * lean);
    nrm.push(dx * 0.5, 0.85, dz * 0.5);
    gb.push(1, 0, b / blades, 0);
    for (let k = 0; k < T.length - 1; k++) {
      const i0 = base + k * 2;
      idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
    const last = base + (T.length - 1) * 2;
    idx.push(last, last + 1, last + 2);
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nrm), gb: new Float32Array(gb), index: new Uint16Array(idx) };
}

function tileHash(tx: number, tz: number, seed: number): number {
  let h = Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Bilinear sample of the terrain's macro noise (RGBA8 periodic 256²) at world-scaled coords. */
export type MacroNoise = (u: number, v: number, channel: number) => number;

export function createMacroNoise(data: Uint8Array, size: number): MacroNoise {
  return (u, v, ch) => {
    const x = (u - Math.floor(u)) * size - 0.5;
    const y = (v - Math.floor(v)) * size - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const a = (xx: number, yy: number): number => data[((((yy % size) + size) % size) * size + (((xx % size) + size) % size)) * 4 + ch]! / 255;
    const top = a(x0, y0) + (a(x0 + 1, y0) - a(x0, y0)) * tx;
    const bot = a(x0, y0 + 1) + (a(x0 + 1, y0 + 1) - a(x0, y0 + 1)) * tx;
    return top + (bot - top) * ty;
  };
}

/** Fill one tile's tufts into a new Float32Array (GRASS_STRIDE floats each). */
export function fillGrassTile(tx: number, tz: number, sampler: TerrainSampler, waterLevel: number, macro: MacroNoise | null, seed = 0x6ea55): Float32Array {
  let s = tileHash(tx, tz, seed) | 0;
  const r = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.round(GRASS_TILE_M * GRASS_TILE_M * GRASS_DENSITY);
  const out = new Float32Array(n * GRASS_STRIDE);
  const sp = new Float64Array(5);
  const nm = new Float64Array(3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = (tx + r()) * GRASS_TILE_M;
    const z = (tz + r()) * GRASS_TILE_M;
    const u = r();
    const hgt = r();
    const sd = r();
    if (!sampler.contains(x, z)) continue;
    sampler.splatAt(x, z, sp);
    const grass = sp[4]!;
    if (sp[0]! > 0.02 || sp[3]! > 0.35 || sp[2]! > 0.4) continue;
    // Clumpy acceptance: grass weight with a soft threshold.
    if (!(u < Math.min(1, (grass - 0.25) * 1.6))) continue;
    const y = sampler.heightAt(x, z);
    if (y < waterLevel + 0.15) continue;
    sampler.normalAt(x, z, nm);
    if (nm[1]! < 0.78) continue;
    let mr = 1;
    let mg = 1;
    let mb = 1;
    if (macro) {
      const nzB = macro(x / 640, z / 640, 0);
      const nzC = macro(x / 150 + 0.37, z / 150 + 0.37, 1);
      let m = Math.min(1, Math.max(0, nzB * 0.65 + nzC * 0.35));
      m = m <= 0.2 ? 0 : m >= 0.8 ? 1 : ((m - 0.2) / 0.6) * ((m - 0.2) / 0.6) * (3 - (2 * (m - 0.2)) / 0.6);
      mr = MACRO_A[0] + (MACRO_B[0] - MACRO_A[0]) * m;
      mg = MACRO_A[1] + (MACRO_B[1] - MACRO_A[1]) * m;
      mb = MACRO_A[2] + (MACRO_B[2] - MACRO_A[2]) * m;
    }
    const dry = Math.min(1, sp[1]! * 2.5 + sp[3]! * 1.5);
    const j = 0.85 + 0.3 * sd;
    const o = k * GRASS_STRIDE;
    out[o] = x;
    out[o + 1] = y - 0.03;
    out[o + 2] = z;
    out[o + 3] = (0.24 + 0.3 * hgt * hgt) * (1 - 0.35 * dry);
    out[o + 4] = GRASS_MEAN[0] * mr * j * (1 + 0.9 * dry) * 0.86;
    out[o + 5] = GRASS_MEAN[1] * mg * j * (1 + 0.25 * dry);
    out[o + 6] = GRASS_MEAN[2] * mb * j * (1 + 0.6 * dry) * 1.15;
    out[o + 7] = r();
    k++;
  }
  return out.slice(0, k * GRASS_STRIDE);
}

export function grassGeometry(capacity: number): { geometry: InstancedBufferGeometry; iA: InstancedBufferAttribute; iB: InstancedBufferAttribute } {
  const t = buildTuft();
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(t.position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(t.normal, 3));
  g.setAttribute('gb', new Float32BufferAttribute(t.gb, 4));
  g.setIndex(Array.from(t.index));
  const iA = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const iB = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  iA.setUsage(DynamicDrawUsage);
  iB.setUsage(DynamicDrawUsage);
  g.setAttribute('iA', iA);
  g.setAttribute('iB', iB);
  g.instanceCount = 0;
  return { geometry: g, iA, iB };
}

/** Grass patch (color only: grass never casts). uGrass = (radius, 0, 0, 0). */
export function grassPatch(u: VegUniforms, radius: { value: number }): ShaderPatch {
  return {
    key: 'veggrass2',
    targets: ['color'],
    apply(shader: WebGLProgramParametersWithUniforms) {
      shader.uniforms.uVegWind = u.uVegWind;
      shader.uniforms.uVegSun = u.uVegSun;
      shader.uniforms.uVegSunCol = u.uVegSunCol;
      shader.uniforms.uGrassR = radius;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 gb;
uniform vec4 uVegWind;
uniform float uGrassR;
varying vec3 vGrassCol;
varying float vGrassT;`,
        )
        .replace(
          '#include <begin_vertex>',
          `float gSeed = iB.w;
  float gAng = gSeed * 81.681;
  float gc = cos(gAng), gs = sin(gAng);
  float gD = distance(cameraPosition.xz, iA.xz);
  float keep = 1.0 - smoothstep(uGrassR * 0.3, uGrassR, gD);
  float thin = fract(gSeed * 91.7);
  float h = iA.w * clamp((keep - thin) * 5.0, 0.0, 1.0);
  vec3 lp = vec3(gc * position.x - gs * position.z, position.y * h, gs * position.x + gc * position.z);
  float t = gb.x;
  float tw = uVegWind.w;
  vec2 wd = uVegWind.xy;
  float gust = 0.5 + 0.35 * sin(dot(iA.xz, wd) * 0.11 - tw * 2.1) + 0.15 * sin(dot(iA.xz, vec2(-wd.y, wd.x)) * 0.23 + tw * 1.3);
  float flick = sin(tw * 5.3 + gSeed * 40.0 + gb.z * 9.0) * 0.06;
  lp.xz += (wd * (uVegWind.z * gust * 0.42 + 0.05) + vec2(-wd.y, wd.x) * flick) * t * t * h * 1.6;
  vec3 transformed = lp + iA.xyz;
  // × 0.9: the turf under the tufts carries texture AO, cavity and mid-scale darkening; bare
  // blade colour read paler than the ground it grows from
  vGrassCol = iB.rgb * 0.9 * mix(0.78, 1.06, t) * mix(1.0, 1.06, gb.z);
  vGrassT = t;`,
        )
        .replace(
          '#include <defaultnormal_vertex>',
          `float gA0 = iB.w * 81.681;
  // Mostly the ground's up normal: a field of thin, translucent blades lights about like the
  // turf under it. Blade-tilted normals (y × 1.8) lit sun-facing blades at twice the ground's
  // N·L and sun-averted ones at ~0, a salt-and-pepper of pale and near-black specks.
  vec3 gN = normalize(vec3(cos(gA0) * normal.x - sin(gA0) * normal.z, normal.y * 5.0, sin(gA0) * normal.x + cos(gA0) * normal.z));
  objectNormal = gN;
  #include <defaultnormal_vertex>`,
        );
      let f = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform vec3 uVegSun;
uniform vec3 uVegSunCol;
varying vec3 vGrassCol;
varying float vGrassT;`,
      );
      f = f.replace('#include <map_fragment>', 'diffuseColor.rgb = vGrassCol;');
      f = f.replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
  vec3 normal = normalize(vNormal);
  vec3 nonPerturbedNormal = normal;`,
      );
      // rough, matte blades: terrain-level sheen (full dielectric F0 at grazing view angles paled
      // every blade toward the sky colour)
      f = f.replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
  material.specularColor *= 0.3;
  material.specularColorBlended *= 0.3;
  material.specularF90 *= 0.3;`,
      );
      f = f.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  {
    vec3 sunV = normalize((viewMatrix * vec4(uVegSun, 0.0)).xyz);
    float bl = max(dot(normalize(-vViewPosition), sunV), 0.0);
    totalEmissiveRadiance += diffuseColor.rgb * uVegSunCol * (bl * bl * 0.18 + 0.02) * vGrassT;
  }`,
      );
      shader.fragmentShader = f;
    },
  };
}
