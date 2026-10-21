/**
 * Lighting stack (contract: render/types.ts CreateLightingStack).
 *
 *  - TIME OF DAY + WEATHER (lighting/environment.ts): the stack owns the
 *    EnvironmentController (`stack.env`); sun and moon come from the time
 *    (lighting/astro.ts), the key light from their transmittance through the
 *    atmosphere (lighting/atmosphere.ts): the sun by day, the moon (cool, dim,
 *    lifted by eye adaptation) by night, dimmed by cloud cover.
 *  - SKY (lighting/sky.ts): Hillaire 2020 physically based atmosphere —
 *    transmittance + multiple-scattering LUTs, a sky-view LUT re-rendered as
 *    the sun moves, a dome with the sun disc, moon, stars and Milky Way.
 *  - IBL: the same sky (plus a lit ground hemisphere) captured into a cube
 *    and PMREM-filtered into one persistent target at a low cadence (sun moved
 *    > IBL_RECAPTURE_DEG or the weather changed).
 *  - CSM (three/examples CSM) with custom practical splits, per-cascade
 *    normal bias in shadow texels, fade on; the cascade lights follow the key
 *    light's direction, colour and intensity.
 *  - Exponential HEIGHT fog + AERIAL PERSPECTIVE: three's global fog_* chunks
 *    are replaced while the stack lives (scene.fog stays a FogExp2 so the
 *    fogDensity uniform and n8ao's fog-aware AO keep working). World-lit
 *    materials (patchMaterial's env patch, lighting/envPatch.ts) fade toward
 *    the sky-view LUT radiance in each fog ray's direction with Rayleigh +
 *    height-Mie extinction; everything else mixes toward scene.fog.color (the
 *    sky's mean horizon radiance, read back asynchronously).
 *
 * Every lit material must be patched with patchMaterial({ csm }): CSM's
 * global lights_* chunks make an UNPATCHED lit material sum all cascade
 * lights (N× too bright) — not only "no cascaded shadows".
 *
 * The HDRI helpers below (analysis, grading) are kept for the dev pages and
 * the studio; the world sky is procedural.
 */
import {
  Color,
  DataUtils,
  DirectionalLight,
  FogExp2,
  ShaderChunk,
  Vector3,
} from 'three';
import type { Camera, Material, Object3D, WebGLRenderer } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

import { hourForSunElevation, moonDirectionAt, moonIllumination, sunDirectionAt } from './lighting/astro';
import { ATMOSPHERE_BASE_ALTITUDE_M, bodyIlluminance, smoothstep, SUN_ILLUMINANCE_TOA } from './lighting/atmosphere';
import { createCloudSystem, type CloudFrame } from './lighting/clouds';
import { createEnvironment } from './lighting/environment';
import { ENV_UNIFORMS } from './lighting/envPatch';
import { createSkySystem } from './lighting/sky';
import type { SkyFrameState, SkySystem } from './lighting/sky';
import type { CreateLightingStack, LightingOptions, LightingStack, QualityPreset, RenderContext } from './types';

// ============================================================ tuning
/** Key-light elevation floor, deg (golden hour, but still shapes flat ground). */
export const SUN_MIN_ELEVATION_DEG = 16;
/** Linear RGB (contract: linear hex) — the linear value of sRGB #ffd9a8, a golden-hour orange. */
export const DEFAULT_SUN_COLOR = 0xffb164;
export const DEFAULT_SUN_INTENSITY = 6;
/**
 * Height-fog density at FOG_BASE_HEIGHT, 1/m. Gentle aerial perspective:
 * ≈ 34 % over 1 km at valley level, ≈ 18 % from the 150 m summit down to the
 * valley 800 m away (0.0012 washed the whole valley out from the summit).
 * Distant HDRI mountains fade through the sky's haze band, not this.
 */
export const DEFAULT_FOG_DENSITY = 0.00032;
/** Height-fog falloff, 1/m: density halves every ln2/falloff ≈ 83 m of altitude. */
export const FOG_HEIGHT_FALLOFF = 1 / 120;
/** Altitude where fog density equals fogDensity, m. */
export const FOG_BASE_HEIGHT = 0;
/** Sky haze band (deg): fully haze below LOW, pure HDRI above HIGH. */
export const HAZE_LOW_DEG = -1.5;
export const HAZE_HIGH_DEG = 10;
/** HDRI elevation band (deg) averaged into the fog/haze colour model. */
export const HORIZON_BAND_DEG: readonly [number, number] = [8, 16];
/** Toward-sun haze colour is capped at this multiple of the away colour (fogged terrain must not outshine the sky glow). */
export const HAZE_SUN_CAP = 3;
/**
 * Soft highlight shoulder on the HDRI (raw units, sky AND IBL): luminance
 * above `knee` compresses as knee + x/(1 + x/range). kiara's dawn glow
 * (≈ 30–46) lands near 8 with its gradation intact, and a visible sun disc
 * (venice ≈ 2600) cannot double the analytic sun.
 */
export const ENV_SHOULDER = { knee: 3, range: 6 } as const;
/** Upper bound of the shoulder (knee + range): also the radiance cap used for the horizon band. */
export const SKY_RADIANCE_CLAMP = ENV_SHOULDER.knee + ENV_SHOULDER.range;
/**
 * Scene-linear scale of the HDRI relative to the key light (sun ≈ 6 by
 * contract). Golden-hour balance: sunlit faces ≈ 2.5–3× the sky fill. The
 * post stack's exposure (POST_EXPOSURE) is matched to this scale.
 */
export const ENV_SCALE = 0.16;

/**
 * White-balance gains applied to the HDRI (sky, IBL and the fog model all
 * inherit them). kiara_1_dawn's sky is strongly lavender (B/R ≈ 2.5): a
 * camera balanced for the warm key light renders it bluer and less purple.
 * Mutable for dev tooling (set before createLightingStack).
 */
export const ENV_GRADE: [number, number, number] = [1.0, 1.04, 0.78];

/** Practical split weight toward logarithmic (1 = log, 0 = uniform). */
export const CSM_SPLIT_LAMBDA = 0.9;
/** Near distance the log split starts from (camera.near is far too small). */
export const CSM_SPLIT_NEAR_M = 2;
/** Casters this far behind each cascade (sunward) still render into it. */
export const CSM_LIGHT_MARGIN_M = 220;
/** Normal offset in shadow texels of each cascade (acne on slopes). */
export const CSM_NORMAL_BIAS_TEXELS = 1.4;
/** Constant depth bias in metres along the light (converted per light range). */
export const CSM_DEPTH_BIAS_M = 0.04;
/** PCF (Vogel) radius in texels for cascade 0; outer cascades get less. */
export const CSM_PCF_RADIUS = 2.2;

// ============================================================ pure: HDRI analysis
export interface EquirectImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** 'half' = IEEE half bits (Uint16), 'float' = linear floats, 'srgb8' = 8-bit sRGB. */
  encoding: 'half' | 'float' | 'srgb8';
  channels: number;
}

export interface SkyAnalysis {
  /** Unit vector toward the brightest region (three equirect convention, row 0 = zenith). */
  sunDirection: [number, number, number];
  /** Chroma of that region, max channel = 1. */
  sunColor: [number, number, number];
  /** Peak luminance in the region (linear radiance). */
  sunPeak: number;
  /** Mean horizon-band radiance facing away from the sun (linear RGB). */
  horizonAway: [number, number, number];
  /** Horizon-band radiance at the sun azimuth (linear RGB). */
  horizonSun: [number, number, number];
  /** Lobe exponent k: band(az) ≈ mix(away, sun, max(cos Δaz, 0)^k). */
  horizonLobe: number;
  /** Mean radiance above 45° elevation. */
  zenith: [number, number, number];
}

const srgbLut = /* @__PURE__ */ (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

function texel(img: EquirectImage, col: number, row: number, out: [number, number, number]): [number, number, number] {
  const i = (row * img.width + col) * img.channels;
  const d = img.data;
  if (img.encoding === 'half') {
    out[0] = DataUtils.fromHalfFloat(d[i]!);
    out[1] = DataUtils.fromHalfFloat(d[i + 1]!);
    out[2] = DataUtils.fromHalfFloat(d[i + 2]!);
  } else if (img.encoding === 'srgb8') {
    out[0] = srgbLut[d[i]!]!;
    out[1] = srgbLut[d[i + 1]!]!;
    out[2] = srgbLut[d[i + 2]!]!;
  } else {
    out[0] = d[i]!;
    out[1] = d[i + 1]!;
    out[2] = d[i + 2]!;
  }
  return out;
}

/**
 * Grade an equirect in place: multiply RGB by `gain`, then scale any pixel
 * whose luminance exceeds `clampLum` down to it (an HDRI's sun disc / dawn
 * glow would otherwise flood the IBL and double the analytic sun). sRGB8
 * data (procedural fallback) is only gained.
 */
export function gradeEquirect(
  img: EquirectImage,
  gain: readonly [number, number, number],
  shoulder: { knee: number; range: number } | null = null,
): void {
  const d = img.data as unknown as { [i: number]: number; length: number };
  const n = img.width * img.height * img.channels;
  const ch = img.channels;
  if (img.encoding === 'half' || img.encoding === 'float') {
    const half = img.encoding === 'half';
    const rd = (i: number): number => (half ? DataUtils.fromHalfFloat(d[i]!) : d[i]!);
    const wr = (i: number, v: number): void => {
      d[i] = half ? DataUtils.toHalfFloat(v) : v;
    };
    for (let i = 0; i < n; i += ch) {
      const r = rd(i);
      const g = rd(i + 1);
      const b = rd(i + 2);
      let k = 1;
      if (shoulder) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l > shoulder.knee) {
          const x = l - shoulder.knee;
          k = (shoulder.knee + x / (1 + x / shoulder.range)) / l;
        }
      }
      wr(i, r * k * gain[0]);
      wr(i + 1, g * k * gain[1]);
      wr(i + 2, b * k * gain[2]);
    }
  } else {
    if (gain[0] === 1 && gain[1] === 1 && gain[2] === 1) return;
    for (let i = 0; i < n; i += ch) {
      for (let k = 0; k < 3; k++) {
        const lin = srgbLut[d[i + k]!]! * gain[k]!;
        const s = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
        d[i + k] = Math.max(0, Math.min(255, Math.round(s * 255)));
      }
    }
  }
}

const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** World direction of equirect pixel centre (three's equirectUv inverse; row 0 = top). */
export function equirectDirection(col: number, row: number, width: number, height: number): [number, number, number] {
  const u = (col + 0.5) / width;
  const v = 1 - (row + 0.5) / height;
  const phi = (u - 0.5) * 2 * Math.PI;
  const lat = (v - 0.5) * Math.PI;
  const c = Math.cos(lat);
  return [Math.cos(phi) * c, Math.sin(lat), Math.sin(phi) * c];
}

/**
 * Find the sun (or the brightest glow when the disc is hidden) and fit the
 * horizon colour model used by fog and sky haze. Samples a ≤512×256 grid.
 */
export function analyzeEquirect(img: EquirectImage): SkyAnalysis {
  const W = img.width;
  const H = img.height;
  const sx = Math.max(1, Math.floor(W / 512));
  const sy = Math.max(1, Math.floor(H / 256));
  const AZ = 72; // 5° bins
  const EL = 36;
  const binE = new Float64Array(AZ * EL);
  const c: [number, number, number] = [0, 0, 0];
  const bandSum = new Float64Array(AZ * 3);
  const bandW = new Float64Array(AZ);
  const zen = [0, 0, 0];
  let zenW = 0;
  const loRad = (HORIZON_BAND_DEG[0] * Math.PI) / 180;
  const hiRad = (HORIZON_BAND_DEG[1] * Math.PI) / 180;
  const minSunLat = (-4 * Math.PI) / 180;

  for (let row = 0; row < H; row += sy) {
    const lat = (0.5 - (row + 0.5) / H) * Math.PI;
    const w = Math.cos(lat);
    const eb = Math.min(EL - 1, Math.floor(((lat + Math.PI / 2) / Math.PI) * EL));
    for (let col = 0; col < W; col += sx) {
      texel(img, col, row, c);
      const L = lum(c);
      const ab = Math.min(AZ - 1, Math.floor(((col + 0.5) / W) * AZ));
      if (lat > minSunLat) binE[eb * AZ + ab]! += L * w;
      if (lat >= loRad && lat <= hiRad) {
        const k = Math.min(1, SKY_RADIANCE_CLAMP / Math.max(L, 1e-6)); // a visible disc must not dominate the band
        bandSum[ab * 3]! += c[0] * k;
        bandSum[ab * 3 + 1]! += c[1] * k;
        bandSum[ab * 3 + 2]! += c[2] * k;
        bandW[ab]! += 1;
      }
      if (lat > Math.PI / 4) {
        zen[0]! += c[0] * w;
        zen[1]! += c[1] * w;
        zen[2]! += c[2] * w;
        zenW += w;
      }
    }
  }

  // 3×3-bin (az wraps) energy → brightest region
  let best = -1;
  let bestE = -1;
  for (let e = 0; e < EL; e++) {
    for (let a = 0; a < AZ; a++) {
      let s = 0;
      for (let de = -1; de <= 1; de++) {
        const ee = e + de;
        if (ee < 0 || ee >= EL) continue;
        for (let da = -1; da <= 1; da++) s += binE[ee * AZ + ((a + da + AZ) % AZ)]!;
      }
      if (s > bestE) {
        bestE = s;
        best = e * AZ + a;
      }
    }
  }
  const bestEl = Math.floor(best / AZ);
  const bestAz = best % AZ;

  // Refine inside a ±2-bin window: L²-weighted direction centroid (the core of the glow/disc).
  const colsPerBin = W / AZ;
  const rowsPerBin = H / EL;
  const r0 = Math.max(0, Math.floor(H - (bestEl + 3) * rowsPerBin));
  const r1 = Math.min(H - 1, Math.ceil(H - (bestEl - 2) * rowsPerBin));
  let peak = 0;
  for (let row = r0; row <= r1; row += sy) {
    for (let k = -2.5 * colsPerBin; k <= 2.5 * colsPerBin; k += sx) {
      const col = (((Math.floor((bestAz + 0.5) * colsPerBin + k)) % W) + W) % W;
      peak = Math.max(peak, lum(texel(img, col, row, c)));
    }
  }
  const dir = [0, 0, 0];
  const col3 = [0, 0, 0];
  let wsum = 0;
  for (let row = r0; row <= r1; row += sy) {
    for (let k = -2.5 * colsPerBin; k <= 2.5 * colsPerBin; k += sx) {
      const col = (((Math.floor((bestAz + 0.5) * colsPerBin + k)) % W) + W) % W;
      texel(img, col, row, c);
      const L = lum(c);
      if (L < 0.5 * peak) continue;
      const wgt = L * L;
      const d = equirectDirection(col, row, W, H);
      dir[0]! += d[0] * wgt;
      dir[1]! += d[1] * wgt;
      dir[2]! += d[2] * wgt;
      col3[0]! += c[0] * wgt;
      col3[1]! += c[1] * wgt;
      col3[2]! += c[2] * wgt;
      wsum += wgt;
    }
  }
  const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
  const sunDirection: [number, number, number] = [dir[0]! / dl, dir[1]! / dl, dir[2]! / dl];
  const cmax = Math.max(col3[0]!, col3[1]!, col3[2]!, 1e-9);
  const sunColor: [number, number, number] = wsum > 0 ? [col3[0]! / cmax, col3[1]! / cmax, col3[2]! / cmax] : [1, 1, 1];

  // Horizon band per azimuth bin, then away/sun colours and the lobe exponent.
  const band: [number, number, number][] = [];
  for (let a = 0; a < AZ; a++) {
    const n = Math.max(1, bandW[a]!);
    band.push([bandSum[a * 3]! / n, bandSum[a * 3 + 1]! / n, bandSum[a * 3 + 2]! / n]);
  }
  const sunAz = Math.atan2(sunDirection[2], sunDirection[0]);
  const binAz = (a: number): number => ((a + 0.5) / AZ - 0.5) * 2 * Math.PI;
  const away = [0, 0, 0];
  let awayN = 0;
  const toward = [0, 0, 0];
  let towardN = 0;
  for (let a = 0; a < AZ; a++) {
    const cd = Math.cos(binAz(a) - sunAz);
    const b = band[a]!;
    if (cd < -0.25) {
      away[0]! += b[0];
      away[1]! += b[1];
      away[2]! += b[2];
      awayN++;
    }
    if (cd > Math.cos((12 * Math.PI) / 180)) {
      toward[0]! += b[0];
      toward[1]! += b[1];
      toward[2]! += b[2];
      towardN++;
    }
  }
  const horizonAway: [number, number, number] = [away[0]! / Math.max(1, awayN), away[1]! / Math.max(1, awayN), away[2]! / Math.max(1, awayN)];
  const horizonSun: [number, number, number] = [
    toward[0]! / Math.max(1, towardN),
    toward[1]! / Math.max(1, towardN),
    toward[2]! / Math.max(1, towardN),
  ];
  const la = lum(horizonAway);
  const ls = lum(horizonSun);
  const ks: number[] = [];
  if (ls > la * 1.05) {
    for (let a = 0; a < AZ; a++) {
      const cd = Math.cos(binAz(a) - sunAz);
      if (cd < 0.3 || cd > 0.97) continue;
      const rel = (lum(band[a]!) - la) / (ls - la);
      if (rel > 0.02 && rel < 0.98) ks.push(Math.log(rel) / Math.log(cd));
    }
  }
  ks.sort((x, y) => x - y);
  const horizonLobe = ks.length ? Math.min(64, Math.max(1, ks[ks.length >> 1]!)) : 8;
  const zenith: [number, number, number] = [zen[0]! / Math.max(zenW, 1e-9), zen[1]! / Math.max(zenW, 1e-9), zen[2]! / Math.max(zenW, 1e-9)];

  return { sunDirection, sunColor, sunPeak: peak, horizonAway, horizonSun, horizonLobe, zenith };
}

/** Keep azimuth, raise elevation to at least `minDeg`. */
export function liftSunElevation(dir: readonly [number, number, number], minDeg: number): [number, number, number] {
  const minEl = (minDeg * Math.PI) / 180;
  const el = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  if (el >= minEl) return [dir[0], dir[1], dir[2]];
  const h = Math.hypot(dir[0], dir[2]) || 1;
  const c = Math.cos(minEl);
  return [(dir[0] / h) * c, Math.sin(minEl), (dir[2] / h) * c];
}

/**
 * CSM split distances as fractions of `far` (CSM 'custom' callback form):
 * practical split between uniform and a log split that starts at
 * max(near, CSM_SPLIT_NEAR_M). Last entry is always 1.
 */
export function cascadeSplits(count: number, near: number, far: number, lambda = CSM_SPLIT_LAMBDA, target: number[] = []): number[] {
  target.length = 0;
  const n0 = Math.min(Math.max(near, CSM_SPLIT_NEAR_M), far * 0.5);
  for (let i = 1; i < count; i++) {
    const log = n0 * (far / n0) ** (i / count);
    const uni = near + ((far - near) * i) / count;
    target.push((lambda * log + (1 - lambda) * uni) / far);
  }
  target.push(1);
  return target;
}

// ============================================================ shadow-map budget
/**
 * Far-cascade throttling: cascades 0–1 re-render every frame; cascade k ≥ 2
 * every 2nd frame, staggered (k even on even frames, odd on odd), so a
 * 4-cascade preset renders 3 shadow maps per frame. A skipped cascade keeps
 * its map AND its shadow matrix (three updates the matrix only when it
 * renders the map), so receivers stay consistent; its light box carries
 * CSM_THROTTLE_MARGIN of extra extent so one frame of camera motion stays
 * inside it. A camera jump > CSM_THROTTLE_JUMP_M re-renders everything.
 */
export const CSM_THROTTLE_FROM = 2;
export const CSM_THROTTLE_PERIOD = 2;
export const CSM_THROTTLE_MARGIN = 0.04;
export const CSM_THROTTLE_JUMP_M = 8;

/** Whether cascade `index` re-renders its shadow map on frame `frame` (pure). */
export function cascadeDue(index: number, frame: number): boolean {
  if (index < CSM_THROTTLE_FROM) return true;
  return (frame + index) % CSM_THROTTLE_PERIOD === 0;
}

/**
 * Bitmask of the cascades whose view-depth range overlaps [dMin, dMax] m
 * (pure). `breaks` are CSM's split fractions of `far`; each range is widened
 * by CSM's fade band (CSMShader: ±0.125·edge² in units of far). Never empty.
 */
export function cascadesOverlapping(breaks: readonly number[], far: number, dMin: number, dMax: number): number {
  let mask = 0;
  let a = 0;
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i]!;
    const lo = (a - 0.125 * a * a) * far;
    const hi = i === breaks.length - 1 ? Infinity : (b + 0.125 * b * b) * far;
    if (lo <= dMax && hi >= dMin) mask |= 1 << i;
    a = b;
  }
  return mask === 0 && breaks.length > 0 ? 1 << (breaks.length - 1) : mask;
}

interface NearCasterState {
  root: Object3D | null;
  mask: number;
  /** root.visible as the app left it, while shadow maps render. */
  saved: boolean;
  wrapped: WeakSet<object>;
}
const nearCasters = new WeakMap<LightingStack, NearCasterState>();
const NEAR_CASTER_ALL = 0x7fffffff;

/**
 * Shadow LOD for one subtree (a vehicle: ~100 draws per cascade): it is
 * rendered only into the cascades covering camera distances [dMin, dMax]
 * (the receivers of its shadow). three tests object layers against the
 * VIEW camera in the shadow pass, so the subtree's `visible` is toggled per
 * cascade instead: each cascade light's shadow.updateMatrices (called right
 * before that cascade's casters render) applies its mask bit, and
 * renderer.shadowMap.render restores the flag afterwards. The main pass is
 * unaffected (its render list is built before the shadow maps render).
 * Call every frame after update(camera); root null disables it.
 */
export function setNearCasters(
  stack: LightingStack,
  renderer: WebGLRenderer,
  camera: Camera,
  root: Object3D | null,
  dMin: number,
  dMax: number,
): void {
  const csm = stack.csm;
  let st = nearCasters.get(stack);
  if (!st) {
    st = { root: null, mask: NEAR_CASTER_ALL, saved: true, wrapped: new WeakSet() };
    nearCasters.set(stack, st);
    const state = st;
    const shadowMap = renderer.shadowMap;
    const orig = shadowMap.render;
    shadowMap.render = function (this: unknown, ...args: Parameters<typeof orig>) {
      const r = state.root;
      if (r) state.saved = r.visible;
      try {
        orig.apply(this, args);
      } finally {
        if (r) r.visible = state.saved;
      }
    };
  }
  st.root = root;
  if (!csm) {
    st.mask = NEAR_CASTER_ALL;
    return;
  }
  const far = Math.min((camera as Camera & { far?: number }).far ?? csm.maxFar, csm.maxFar);
  st.mask = cascadesOverlapping(csm.breaks, far, dMin, dMax);
  for (let i = 0; i < csm.lights.length; i++) {
    const shadow = csm.lights[i]!.shadow;
    if (st.wrapped.has(shadow)) continue;
    st.wrapped.add(shadow);
    const state = st;
    const bit = 1 << i;
    const origUpdate = shadow.updateMatrices;
    shadow.updateMatrices = function (this: unknown, light) {
      if (state.root) state.root.visible = state.saved && (state.mask & bit) !== 0;
      return origUpdate.call(this, light);
    };
  }
}

/** Rotation (about +Y) that carries azimuth `fromAz` onto `toAz` for three's envMapRotation convention. */
export function envYawFor(hdriDir: readonly number[], worldDir: readonly number[]): number {
  return Math.atan2(hdriDir[2]!, hdriDir[0]!) - Math.atan2(worldDir[2]!, worldDir[0]!);
}

// ============================================================ fog chunks (global while a stack lives)
const FOG_CHUNKS = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment'] as const;
type FogChunk = (typeof FOG_CHUNKS)[number];
let savedFogChunks: Record<FogChunk, string> | null = null;

const glslFloat = (x: number): string => (Number.isFinite(x) ? x.toPrecision(7) : '0.0').replace(/^(-?\d+)$/, '$1.0');

/**
 * Exponential HEIGHT fog for every fogged material. Env-patched (world-lit)
 * materials get aerial perspective: Rayleigh + height-Mie extinction toward
 * the sky radiance in the fog ray's own direction (sky-view LUT), so distant
 * terrain fades into exactly the sky behind it at any time of day. Everything
 * else (particles, unpatched helpers) mixes toward scene.fog.color.
 */
function installFogChunks(): void {
  if (!savedFogChunks) {
    savedFogChunks = {} as Record<FogChunk, string>;
    for (const k of FOG_CHUNKS) savedFogChunks[k] = ShaderChunk[k];
  }
  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldOffset;
#endif`;
  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldOffset = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz; // view → world rotation (transpose)
#endif`;
  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldOffset;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogDist = length( vFogWorldOffset );
    vec3 fogDir = vFogWorldOffset / max( fogDist, 1e-4 );
    float fogB = ${glslFloat(FOG_HEIGHT_FALLOFF)};
    float fogCamH = max( cameraPosition.y - ${glslFloat(FOG_BASE_HEIGHT)}, -200.0 );
    float fogRy = fogB * fogDir.y * fogDist;
    float fogShape = abs( fogRy ) > 1e-3 ? ( 1.0 - exp( - fogRy ) ) / fogRy : 1.0 - 0.5 * fogRy;
    float fogTauM = fogDensity * fogDist * exp( - fogB * fogCamH ) * fogShape;
    #ifdef CRUMPLE_ENV
      vec3 fogT = exp( - ( vec3( fogTauM ) + crumpleBetaR * fogDist ) );
      vec3 fogSky = crumpleHaze( fogDir ) * crumpleEnvIntensity;
      gl_FragColor.rgb = gl_FragColor.rgb * fogT + fogSky * ( 1.0 - fogT );
    #else
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, 1.0 - exp( - fogTauM ) );
    #endif
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`;
}

function restoreFogChunks(): void {
  if (!savedFogChunks) return;
  for (const k of FOG_CHUNKS) ShaderChunk[k] = savedFogChunks[k];
  savedFogChunks = null;
}

// ============================================================ time of day → light
/** Moon illuminance at the top of the atmosphere (full moon), scene units: night stays dark, eye adaptation lifts it. */
export const MOON_ILLUMINANCE_TOA = 0.045;
/** Moonlight tint (the eye reads moonlight cool: Purkinje). */
export const MOON_TINT: readonly [number, number, number] = [0.72, 0.84, 1.0];
/** Direct light lost under full cloud cover (cloud shadows add the spatial part). */
export const OVERCAST_DIRECT_LOSS = 0.82;
/** Height-fog density at fog = 1 (weather), 1/m: ~150 m visibility at the valley floor. */
export const FOG_DENSITY_DENSE = 0.016;
/** IBL capture: re-capture once the sun moved this far (deg) or the weather changed. */
export const IBL_RECAPTURE_DEG = 0.5;
export const IBL_MIN_INTERVAL_S = 0.3;
/** Analytic Mie glow of the haze toward the sun, × the key light (sky-SH haze cannot hold the sharp forward lobe). */
export const HAZE_GLOW_STRENGTH = 0.035;
/** Ground albedo for the IBL's lower hemisphere (grass / dirt / asphalt mix). */
export const IBL_GROUND_ALBEDO: readonly [number, number, number] = [0.11, 0.12, 0.085];

/** IBL cube face size per preset. */
export function envSizeFor(q: QualityPreset): number {
  return q.level === 'low' ? 64 : q.level === 'ultra' ? 256 : 128;
}

export interface KeyLight {
  /** Toward the light (sun by day, moon by night). */
  dir: Vector3;
  color: Color;
  intensity: number;
  isMoon: boolean;
}

const tmpA: [number, number, number] = [0, 0, 0];
const tmpB: [number, number, number] = [0, 0, 0];

/**
 * Key light for sun / moon positions and cloud cover (pure apart from three
 * value types). The sun owns the key light down to −1.7° elevation (its
 * illuminance is already ~0 at −0.6°); below, the moon fades in by −5.7°.
 */
export function keyLightFor(sunDir: Vector3, moonDir: Vector3, moonFraction: number, cloudCover: number, out: KeyLight): KeyLight {
  // broken cumulus shades through the cloud-shadow map; only a closing deck dims the light everywhere
  const direct = 1 - OVERCAST_DIRECT_LOSS * smoothstep(0.7, 1.0, cloudCover);
  if (sunDir.y > -0.03) {
    bodyIlluminance([sunDir.x, sunDir.y, sunDir.z], SUN_ILLUMINANCE_TOA, ATMOSPHERE_BASE_ALTITUDE_M, tmpA);
    out.dir.copy(sunDir);
    out.isMoon = false;
  } else {
    bodyIlluminance([moonDir.x, moonDir.y, moonDir.z], MOON_ILLUMINANCE_TOA * moonFraction, ATMOSPHERE_BASE_ALTITUDE_M, tmpA);
    const fade = smoothstep(-0.03, -0.1, sunDir.y);
    tmpA[0] *= MOON_TINT[0] * fade;
    tmpA[1] *= MOON_TINT[1] * fade;
    tmpA[2] *= MOON_TINT[2] * fade;
    out.dir.copy(moonDir.y > 0.02 ? moonDir : tmpV.set(moonDir.x, 0.02, moonDir.z).normalize());
    out.isMoon = true;
  }
  const m = Math.max(tmpA[0], tmpA[1], tmpA[2], 1e-9);
  out.color.setRGB(tmpA[0] / m, tmpA[1] / m, tmpA[2] / m);
  out.intensity = m * direct;
  return out;
}
const tmpV = new Vector3();

// ============================================================ CSM plumbing
/** Runtime members missing from @types/three (JS names are underscored). */
interface CSMInternals {
  _createLights(): void;
}

function lightFarFor(q: QualityPreset): number {
  return CSM_LIGHT_MARGIN_M + 2.4 * q.csmFar;
}

// ============================================================ factory
export const createLightingStack: CreateLightingStack = async (ctx: RenderContext, opts: LightingOptions = {}) => {
  const { renderer, scene } = ctx;
  renderer.shadowMap.enabled = true;

  // The fog chunks must be in place before any material compiles.
  installFogChunks();
  const env = createEnvironment({ time: opts.time, timeSpeed: opts.timeSpeed, preset: opts.weather });
  const clouds = createCloudSystem(ctx.quality.level);
  ENV_UNIFORMS.crumpleCloudShadow.value = clouds.shadowTexture;
  const sky = createSkySystem(renderer, { envSize: envSizeFor(ctx.quality), cloudUniforms: clouds.domeUniforms });
  scene.add(sky.dome);

  // ---- key light (sun by day, moon by night)
  const fixedSun = opts.sunDirection ? new Vector3(...opts.sunDirection).normalize() : null;
  const sunDir = new Vector3();
  const moonDir = new Vector3();
  const key: KeyLight = { dir: new Vector3(), color: new Color(), intensity: 0, isMoon: false };
  const placeBodies = (): void => {
    if (fixedSun) sunDir.copy(fixedSun);
    else sunDir.fromArray(sunDirectionAt(env.time, tmpB));
    moonDir.fromArray(moonDirectionAt(env.time, tmpB));
    keyLightFor(sunDir, moonDir, moonIllumination(), env.weather.cloudCover, key);
    if (opts.sunColor !== undefined && !key.isMoon) key.color.setHex(opts.sunColor, 'srgb-linear');
    if (opts.sunIntensity !== undefined && !key.isMoon) key.intensity = opts.sunIntensity;
  };
  placeBodies();
  /** Toward the key light (contract: `sunDirection`; the moon's at night). */
  const sunDirection = key.dir.clone();
  const sunColor = key.color.clone();
  let sunIntensity = key.intensity;
  const sun = new DirectionalLight(sunColor, sunIntensity);
  sun.name = 'crumple.sun';
  sun.position.copy(sunDirection).multiplyScalar(500);
  sun.target.position.set(0, 0, 0);

  // ---- environment (IBL) + fog
  const envIntensity = opts.envIntensity ?? 1;
  scene.environmentIntensity = envIntensity;
  scene.background = null;
  const baseFog = opts.fogDensity ?? DEFAULT_FOG_DENSITY;
  const prevFog = scene.fog;
  const fog = baseFog > 0 ? new FogExp2(0x9aa8b8, baseFog) : null;
  scene.fog = fog;

  // ---- CSM (fallback: a single shadowed sun when texture units are scarce)
  const maxTextures = renderer.capabilities.maxTextures;
  const useCsm = maxTextures >= 16;
  let quality = ctx.quality;
  let csm: CSM | null = null;

  const styleCsmLights = (): void => {
    if (!csm) return;
    const range = csm.lightFar - csm.lightNear;
    csm.lights.forEach((l, i) => {
      l.color.copy(sunColor);
      l.intensity = sunIntensity;
      l.shadow.bias = -CSM_DEPTH_BIAS_M / range;
      l.shadow.radius = Math.max(1, CSM_PCF_RADIUS - 0.5 * i);
      l.shadow.intensity = 1;
      const cam = l.shadow.camera;
      const texelM = (cam.right - cam.left) / csm!.shadowMapSize;
      l.shadow.normalBias = CSM_NORMAL_BIAS_TEXELS * texelM;
      l.shadow.autoUpdate = i < CSM_THROTTLE_FROM;
      l.shadow.needsUpdate = true;
      l.name = `crumple.csm${i}`;
    });
  };
  const colourCsmLights = (): void => {
    if (!csm) {
      sun.color.copy(sunColor);
      sun.intensity = sunIntensity;
      return;
    }
    for (const l of csm.lights) {
      l.color.copy(sunColor);
      l.intensity = sunIntensity;
    }
  };

  /** csm.updateFrustums + the throttled cascades' margin (CSM re-fits the boxes from scratch each call). */
  const fitCascades = (): void => {
    if (!csm) return;
    csm.updateFrustums();
    csm.lights.forEach((l, i) => {
      if (i < CSM_THROTTLE_FROM) return;
      const cam = l.shadow.camera;
      const mx = (cam.right - cam.left) * CSM_THROTTLE_MARGIN;
      const my = (cam.top - cam.bottom) * CSM_THROTTLE_MARGIN;
      cam.left -= mx;
      cam.right += mx;
      cam.bottom -= my;
      cam.top += my;
      cam.updateProjectionMatrix();
    });
    styleCsmLights();
  };

  if (useCsm) {
    csm = new CSM({
      camera: ctx.camera,
      parent: scene,
      cascades: quality.csmCascades,
      maxFar: quality.csmFar,
      mode: 'custom',
      customSplitsCallback: (n, near, far, breaks) => {
        cascadeSplits(n, near, far, CSM_SPLIT_LAMBDA, breaks);
      },
      shadowMapSize: quality.shadowMapSize,
      lightDirection: sunDirection.clone().negate(),
      lightIntensity: sunIntensity,
      lightNear: 1,
      lightFar: lightFarFor(quality),
      lightMargin: CSM_LIGHT_MARGIN_M,
    });
    csm.fade = true;
    fitCascades();
  } else {
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    scene.add(sun, sun.target);
  }

  const reconfigureCsm = (q: QualityPreset): void => {
    if (!csm) return;
    csm.remove();
    for (const l of csm.lights) l.dispose();
    csm.lights.length = 0;
    csm.cascades = q.csmCascades;
    csm.maxFar = q.csmFar;
    csm.shadowMapSize = q.shadowMapSize;
    csm.lightFar = lightFarFor(q);
    (csm as unknown as CSMInternals)._createLights();
    fitCascades();
    for (const m of csm.shaders.keys() as IterableIterator<Material>) {
      m.defines = m.defines ?? {};
      if (m.defines.CSM_CASCADES !== q.csmCascades) {
        m.defines.CSM_CASCADES = q.csmCascades;
        m.needsUpdate = true;
      }
    }
  };

  // projection tracking → CSM frustum refit (resize, fov change)
  const lastProj = new Float64Array(16).fill(Number.NaN);
  const projectionChanged = (camera: Camera): boolean => {
    const e = camera.projectionMatrix.elements;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (lastProj[i] !== e[i]) {
        changed = true;
        lastProj[i] = e[i]!;
      }
    }
    return changed;
  };

  // ---- per-frame environment derivation
  const skyState: SkyFrameState = {
    sunDir,
    moonDir,
    cameraAltitude: 0,
    starVisibility: 0,
    moonIllumination: moonIllumination(),
    time: 0,
    ground: new Vector3(),
  };
  const fogColor = new Color();
  const cloudFrame: CloudFrame = {
    camPos: new Vector3(),
    keyDir: new Vector3(),
    keyColor: new Vector3(),
    ambTop: new Vector3(),
    ambBottom: new Vector3(),
    cover: 0,
    time: 0,
  };
  const lastIblSun = new Vector3(Number.NaN, 0, 0);
  let lastIblWeather = Number.NaN;
  let lastIblProbe = -2;
  const iblHemi = [0, 0, 0];
  let lastIblAt = -1e9;
  let iblDirty = true;
  let frameNo = 0;
  const t0 = performance.now();
  let lastEnvVersion = -1;

  const deriveEnvironment = (camera: Camera): void => {
    const w = env.weather;
    placeBodies();
    // key light: snap the CSM direction only when it moved (rotation shimmer), colour every frame
    if (key.dir.angleTo(sunDirection) > 0.0004 || (key.isMoon && key.dir.distanceToSquared(sunDirection) > 1e-8)) {
      sunDirection.copy(key.dir);
      sun.position.copy(sunDirection).multiplyScalar(500);
      if (csm) csm.lightDirection.copy(sunDirection).negate();
    }
    sunColor.copy(key.color);
    sunIntensity = key.intensity;
    colourCsmLights();

    const nightness = smoothstep(-0.02, -0.16, sunDir.y);
    const clear = 1 - w.cloudCover;
    skyState.starVisibility = nightness * smoothstep(0.85, 0.35, w.cloudCover);
    skyState.time = (performance.now() - t0) / 1000;
    camera.getWorldPosition(tmpV);
    skyState.cameraAltitude = tmpV.y;
    // moonlit night sky: brighter under a high, full moon; a little brighter under cloud (town glow)
    const moonUp = smoothstep(-0.05, 0.25, moonDir.y) * moonIllumination();
    const nightK = 0.35 + 0.9 * moonUp;
    ENV_UNIFORMS.crumpleNightZenith.value.set(0.0010, 0.0016, 0.0034).multiplyScalar(nightK * (0.6 + 0.4 * clear));
    ENV_UNIFORMS.crumpleNightHorizon.value.set(0.0024, 0.0028, 0.0040).multiplyScalar(nightK);
    ENV_UNIFORMS.crumpleMoonGlow.value.set(MOON_TINT[0], MOON_TINT[1], MOON_TINT[2]).multiplyScalar(0.004 * moonUp * clear);
    // overcast deck: lit from above by what reaches the cloud tops, greyed
    const sunUp = Math.max(sunDir.y + 0.08, 0);
    const deckL = 0.06 * SUN_ILLUMINANCE_TOA * Math.min(1, sunUp * 1.6) * (0.35 + 0.65 * Math.min(1, sunUp * 3)) + 0.003 * nightK;
    const cover = smoothstep(0.35, 1, w.cloudCover);
    ENV_UNIFORMS.crumpleOvercast.value.set(deckL * 0.93, deckL * 0.97, deckL * 1.04, cover * 0.92);
    ENV_UNIFORMS.crumpleEnvIntensity.value = scene.environmentIntensity;
    ENV_UNIFORMS.crumpleLightGain.value = env.darkness;
    ENV_UNIFORMS.crumpleWet.value.set(w.wetness, w.rain, skyState.time, 0);
    // IBL ground: albedo × (direct + sky) / π
    const hemi = sky.probe.hemisphere;
    const keyE = sunIntensity * Math.max(sunDirection.y, 0);
    skyState.ground.set(
      IBL_GROUND_ALBEDO[0] * (keyE * sunColor.r / Math.PI + hemi[0]),
      IBL_GROUND_ALBEDO[1] * (keyE * sunColor.g / Math.PI + hemi[1]),
      IBL_GROUND_ALBEDO[2] * (keyE * sunColor.b / Math.PI + hemi[2]),
    );
    // clouds: lit by the key light, sky SH above (≈ zenith), the lit ground below
    cloudFrame.camPos.copy(tmpV);
    cloudFrame.keyDir.copy(sunDirection);
    cloudFrame.keyColor.set(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(sunIntensity / Math.max(1 - OVERCAST_DIRECT_LOSS * smoothstep(0.7, 1.0, w.cloudCover), 0.2));
    const z = sky.probe.zenith;
    const hm = sky.probe.hemisphere;
    cloudFrame.ambTop.set(0.5 * (z[0] + hm[0]), 0.5 * (z[1] + hm[1]), 0.5 * (z[2] + hm[2])).multiplyScalar(Math.PI * 0.32);
    // the ground's bounce under the cloud bases, mostly grey (a green field does not tint a cumulus)
    const gl = (skyState.ground.x + skyState.ground.y + skyState.ground.z) / 3;
    cloudFrame.ambBottom.set(gl, gl, gl).lerp(skyState.ground, 0.35).multiplyScalar(0.9);
    cloudFrame.cover = w.cloudCover;
    cloudFrame.time = env.clock; // drifts with live play only: a replay / pause shows the clouds it left
    clouds.update(renderer, cloudFrame);
    ENV_UNIFORMS.crumpleCloudRect.value.copy(clouds.shadowRect);
    sky.update(skyState);
    // haze of world-lit materials: the probed sky SH (windowed against ringing) + the sun's Mie glow
    const sh = sky.probe.sh;
    const win = [1, 0.92, 0.92, 0.92, 0.72, 0.72, 0.72, 0.72, 0.72];
    for (let k = 0; k < 9; k++) ENV_UNIFORMS.crumpleHazeSH.value[k]!.set(sh[k]![0] * win[k]!, sh[k]![1] * win[k]!, sh[k]![2] * win[k]!);
    const glowK = key.isMoon ? 0 : HAZE_GLOW_STRENGTH * clear;
    ENV_UNIFORMS.crumpleHazeGlow.value.set(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(sunIntensity * glowK);
    // fog: the height-fog density follows the weather; its colour (unpatched materials, FX ambient) = the horizon
    if (fog) {
      fog.density = baseFog * (1 + 0.6 * w.cloudCover) + FOG_DENSITY_DENSE * w.fog * w.fog;
      const hm = sky.probe.horizonMean;
      fogColor.setRGB(hm[0], hm[1], hm[2]).multiplyScalar(scene.environmentIntensity);
      fog.color.copy(fogColor);
    }
    // IBL re-capture: sun moved, weather changed, or night features faded
    const wKey = w.cloudCover * 7 + skyState.starVisibility * 3 + w.fog;
    if (lastIblSun.angleTo(sunDir) > (IBL_RECAPTURE_DEG * Math.PI) / 180 || Math.abs(wKey - lastIblWeather) > 0.03) iblDirty = true;
    // the IBL ground is lit by the probed sky: a fresh probe that moved > 8 % re-captures it
    if (sky.probe.age !== lastIblProbe) {
      lastIblProbe = sky.probe.age;
      const d = Math.abs(hemi[0] - iblHemi[0]!) + Math.abs(hemi[1] - iblHemi[1]!) + Math.abs(hemi[2] - iblHemi[2]!);
      if (d > 0.08 * (hemi[0] + hemi[1] + hemi[2]) + 1e-6) iblDirty = true;
    }
    const now = skyState.time;
    if (iblDirty && now - lastIblAt >= IBL_MIN_INTERVAL_S) {
      sky.captureEnvironment();
      iblHemi[0] = hemi[0];
      iblHemi[1] = hemi[1];
      iblHemi[2] = hemi[2];
      lastIblSun.copy(sunDir);
      lastIblWeather = wKey;
      lastIblAt = now;
      iblDirty = false;
      if (scene.environment !== sky.environment) scene.environment = sky.environment;
    }
    if (frameNo % 12 === 0 || env.version !== lastEnvVersion) sky.readProbe();
    lastEnvVersion = env.version;
  };

  const fallbackTexel = new Vector3();
  let disposed = false;
  let shadowFrame = 0;
  const lastCamPos = new Vector3(Number.NaN, 0, 0);
  const camPos = new Vector3();

  const stack: LightingStack = {
    sun,
    sunDirection,
    get csm() {
      return csm;
    },
    get environment() {
      return sky.environment;
    },
    env,
    update(camera: Camera) {
      frameNo++;
      camera.updateMatrixWorld();
      sky.dome.position.setFromMatrixPosition(camera.matrixWorld);
      deriveEnvironment(camera);
      if (csm) {
        if (csm.camera !== camera) {
          csm.camera = camera;
          lastProj.fill(Number.NaN);
        }
        let all = false;
        if (projectionChanged(camera)) {
          fitCascades();
          all = true;
        }
        csm.update();
        camPos.setFromMatrixPosition(camera.matrixWorld);
        if (!(camPos.distanceToSquared(lastCamPos) <= CSM_THROTTLE_JUMP_M * CSM_THROTTLE_JUMP_M)) all = true;
        lastCamPos.copy(camPos);
        shadowFrame++;
        for (let i = CSM_THROTTLE_FROM; i < csm.lights.length; i++) {
          if (all || cascadeDue(i, shadowFrame)) csm.lights[i]!.shadow.needsUpdate = true;
        }
      } else {
        // single shadow box following the camera, snapped to texels to stop shimmering
        const half = Math.min(quality.csmFar, 160) * 0.5;
        const cam = sun.shadow.camera;
        cam.left = cam.bottom = -half;
        cam.right = cam.top = half;
        cam.near = 1;
        cam.far = 2 * CSM_LIGHT_MARGIN_M + half * 2;
        cam.updateProjectionMatrix();
        const texel = (2 * half) / quality.shadowMapSize;
        fallbackTexel.setFromMatrixPosition(camera.matrixWorld);
        fallbackTexel.set(Math.round(fallbackTexel.x / texel) * texel, Math.round(fallbackTexel.y / texel) * texel, Math.round(fallbackTexel.z / texel) * texel);
        sun.target.position.copy(fallbackTexel);
        sun.position.copy(fallbackTexel).addScaledVector(sunDirection, CSM_LIGHT_MARGIN_M + half);
        sun.target.updateMatrixWorld();
      }
    },
    setQuality(q: QualityPreset) {
      quality = q;
      sky.setEnvironmentSize(envSizeFor(q));
      clouds.setQuality(q.level);
      if (scene.environment !== sky.environment) scene.environment = sky.environment;
      if (csm) reconfigureCsm(q);
      else {
        sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (csm) {
        csm.remove();
        for (const l of csm.lights) l.dispose();
        csm.dispose();
      }
      scene.remove(sun, sun.target);
      sun.dispose();
      scene.remove(sky.dome);
      if (scene.environment === sky.environment) scene.environment = null;
      sky.dispose();
      clouds.dispose();
      scene.fog = prevFog;
      restoreFogChunks();
    },
  };

  // first frame's environment (the IBL exists before any material compiles against scene.environment)
  deriveEnvironment(ctx.camera);
  scene.environment = sky.environment;

  // debug handle for tools/dev pages (not part of the contract)
  const analysisView = (): SkyAnalysis => {
    const p = sky.probe;
    return {
      sunDirection: [sunDir.x, sunDir.y, sunDir.z],
      sunColor: [key.color.r, key.color.g, key.color.b],
      sunPeak: key.intensity,
      horizonAway: p.horizon[2]!,
      horizonSun: p.horizon[0]!,
      horizonLobe: 8,
      zenith: p.zenith,
    };
  };
  (stack as unknown as { debug: LightingDebug }).debug = {
    get analysis() {
      return analysisView();
    },
    sky,
    hazeAway: fogColor,
    hazeSun: new Color(),
    procedural: true,
    key,
    setSunElevation(deg: number) {
      // time of day whose sun reaches `deg` in the afternoon (or the closest noon/midnight)
      const h = hourForSunElevation(deg, false);
      env.setTime(h ?? (deg > 0 ? 12 : 0));
    },
    setSunColor(hex: number) {
      opts.sunColor = hex;
    },
  };
  return stack;
};

/** Dev/test handle (not part of the contract). */
export interface LightingDebug {
  readonly analysis: SkyAnalysis;
  sky: SkySystem;
  hazeAway: Color;
  hazeSun: Color;
  procedural: boolean;
  key: KeyLight;
  setSunElevation(deg: number): void;
  setSunColor(linearHex: number): void;
}

export function lightingDebug(stack: LightingStack): LightingDebug {
  return (stack as unknown as { debug: LightingDebug }).debug;
}
