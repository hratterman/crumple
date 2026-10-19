/**
 * Lighting stack (contract: render/types.ts CreateLightingStack).
 *
 *  - HDRI (kiara_1_dawn), graded once on the CPU (white balance ENV_GRADE,
 *    soft highlight shoulder ENV_SHOULDER, scale ENV_SCALE against the sun)
 *    → PMREM → scene.environment (reflections + IBL fill).
 *  - Sky dome: the same graded HDRI drawn at infinity, a haze band at the
 *    horizon that is exactly the fog colour model below, and an analytic sun
 *    disc + corona at the key light. Sky, IBL and fog all follow
 *    scene.environmentIntensity.
 *  - Sun: direction estimated from the HDRI's brightest REGION (energy per
 *    solid-angle bin, so the moon/specks lose to the dawn glow), azimuth kept,
 *    elevation lifted to ≥ SUN_MIN_ELEVATION_DEG (the kiara sun sits behind
 *    the ridge at ~5°: at that angle flat ground gets 9 % of the key light).
 *  - CSM (three/examples CSM) with custom practical splits, per-cascade
 *    normal bias in shadow texels, fade on.
 *  - Exponential HEIGHT fog with sun in-scattering. Implemented by replacing
 *    three's global fog_* chunks while the stack lives (scene.fog stays a
 *    FogExp2 so fogColor/fogDensity uniforms and n8ao's fog-aware AO keep
 *    working). Constants for the height falloff and sun lobe are baked into
 *    the chunk at creation: create the stack before compiling materials.
 *
 * Every lit material must be patched with patchMaterial({ csm }): CSM's
 * global lights_* chunks make an UNPATCHED lit material sum all cascade
 * lights (N× too bright) — not only "no cascaded shadows".
 */
import {
  BackSide,
  BoxGeometry,
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  DirectionalLight,
  Euler,
  FloatType,
  FogExp2,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix3,
  Matrix4,
  Mesh,
  PMREMGenerator,
  RGBAFormat,
  ShaderChunk,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Camera, Material, Object3D, Texture, WebGLRenderer } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

import { loadEnvironmentHDR } from '../assets/loader';
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
export const DEFAULT_FOG_DENSITY = 0.00045;
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
interface FogBake {
  sunDir: Vector3;
  sunColor: Color;
  lobe: number;
}

const FOG_CHUNKS = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment'] as const;
type FogChunk = (typeof FOG_CHUNKS)[number];
let savedFogChunks: Record<FogChunk, string> | null = null;

const glslFloat = (x: number): string => (Number.isFinite(x) ? x.toPrecision(7) : '0.0').replace(/^(-?\d+)$/, '$1.0');
const glslVec3 = (x: number, y: number, z: number): string => `vec3(${glslFloat(x)}, ${glslFloat(y)}, ${glslFloat(z)})`;

/** GLSL for the shared haze colour model (fog + sky), with sun lobe constants baked. */
function hazeGlsl(b: FogBake): string {
  const h = new Vector3(b.sunDir.x, 0, b.sunDir.z).normalize();
  return /* glsl */ `
#ifndef CRUMPLE_HAZE
#define CRUMPLE_HAZE
const vec3 crumpleHazeSunDirH = ${glslVec3(h.x, 0, h.z)};
const vec3 crumpleHazeSunColor = ${glslVec3(b.sunColor.r, b.sunColor.g, b.sunColor.b)};
const float crumpleHazeLobe = ${glslFloat(b.lobe)};
vec3 crumpleHaze( vec3 awayColor, vec3 dir ) {
  vec2 dh = dir.xz;
  float l = length( dh );
  float c = l > 1e-4 ? max( dot( dh / l, crumpleHazeSunDirH.xz ), 0.0 ) : 0.0;
  return mix( awayColor, crumpleHazeSunColor, pow( c, crumpleHazeLobe ) );
}
#endif`;
}

function installFogChunks(b: FogBake): void {
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
    ${hazeGlsl(b)}
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  // Exponential height fog: density(y) = fogDensity·exp(−b(y − y0)), integrated along the view ray.
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogDist = length( vFogWorldOffset );
    vec3 fogDir = vFogWorldOffset / max( fogDist, 1e-4 );
    float fogB = ${glslFloat(FOG_HEIGHT_FALLOFF)};
    float fogCamH = max( cameraPosition.y - ${glslFloat(FOG_BASE_HEIGHT)}, -200.0 );
    float fogRy = fogB * fogDir.y * fogDist;
    float fogShape = abs( fogRy ) > 1e-3 ? ( 1.0 - exp( - fogRy ) ) / fogRy : 1.0 - 0.5 * fogRy;
    float fogFactor = 1.0 - exp( - fogDensity * fogDist * exp( - fogB * fogCamH ) * fogShape );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, crumpleHaze( fogColor, fogDir ), fogFactor );
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

// ============================================================ sky dome
function createSky(equirect: Texture, bake: FogBake, opts: { envRot: Matrix3; intensity: number }): Mesh<BoxGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    name: 'crumple.sky',
    side: BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: {
      tSky: { value: equirect },
      uRot: { value: opts.envRot },
      uIntensity: { value: opts.intensity },
      uClamp: { value: SKY_RADIANCE_CLAMP * ENV_SCALE },
      uHazeColor: { value: new Color() },
      uHazeLow: { value: Math.sin((HAZE_LOW_DEG * Math.PI) / 180) },
      uHazeHigh: { value: Math.sin((HAZE_HIGH_DEG * Math.PI) / 180) },
      uSunDir: { value: bake.sunDir.clone() },
      uSunColor: { value: new Color(1, 1, 1) },
      uSunDisc: { value: 60 },
      uSunCos: { value: Math.cos((0.45 * Math.PI) / 180) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        gl_Position = p.xyww; // on the far plane
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      ${hazeGlsl(bake)}
      uniform sampler2D tSky;
      uniform mat3 uRot;
      uniform float uIntensity;
      uniform float uClamp;
      uniform vec3 uHazeColor;
      uniform float uHazeLow;
      uniform float uHazeHigh;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunDisc;
      uniform float uSunCos;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        vec3 e = uRot * d;
        vec2 uv = vec2( atan( e.z, e.x ) * RECIPROCAL_PI2 + 0.5, asin( clamp( e.y, -1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5 );
        vec3 sky = texture2D( tSky, uv ).rgb * uIntensity;
        float l = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
        sky *= min( 1.0, uClamp / max( l, 1e-5 ) );
        float h = smoothstep( uHazeLow, uHazeHigh, d.y );
        sky = mix( crumpleHaze( uHazeColor, d ), sky, h * h * ( 3.0 - 2.0 * h ) );
        float cs = dot( d, uSunDir );
        float disc = smoothstep( uSunCos - 4e-6, uSunCos + 4e-6, cs );
        float corona = pow( max( cs, 0.0 ), 900.0 ) * 6.0 + pow( max( cs, 0.0 ), 60.0 ) * 0.6;
        sky += uSunColor * ( disc * uSunDisc + corona ) * step( -0.02, d.y );
        gl_FragColor = vec4( sky, 1.0 );
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = 'crumple.sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;
  mesh.scale.setScalar(10);
  mesh.matrixAutoUpdate = true;
  return mesh;
}

/** Returns `tex` if it already holds half/float data, else a linear HalfFloat copy (and disposes `tex`). */
function toHalfFloatEquirect(tex: Texture): Texture {
  if (tex.type === HalfFloatType || tex.type === FloatType) return tex;
  const img = tex.image as { width: number; height: number; data: ArrayLike<number> };
  const n = img.width * img.height;
  const out = new Uint16Array(n * 4);
  const srgb = tex.colorSpace === SRGBColorSpace;
  for (let i = 0; i < n * 4; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = img.data[i + k]! / 255;
      out[i + k] = DataUtils.toHalfFloat(srgb ? srgbLut[img.data[i + k]!]! : v);
    }
    out[i + 3] = DataUtils.toHalfFloat(1);
  }
  const copy = new DataTexture(out, img.width, img.height, RGBAFormat, HalfFloatType);
  copy.mapping = EquirectangularReflectionMapping;
  copy.colorSpace = LinearSRGBColorSpace;
  tex.dispose();
  return copy;
}

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

  const env = await loadEnvironmentHDR(opts.hdri ?? 'kiara_1_dawn');
  // The grade scales radiance far below 1: keep everything in half float (the procedural fallback is sRGB8).
  const equirect = toHalfFloatEquirect(env.texture);
  // Procedural fallback is a DataTexture written zenith-first; HDRLoader flips its rows the same way.
  equirect.flipY = true;
  equirect.magFilter = LinearFilter;
  equirect.minFilter = LinearFilter;
  equirect.generateMipmaps = false;
  equirect.needsUpdate = true;

  const img = equirect.image as { width: number; height: number; data: ArrayLike<number> };
  const view: EquirectImage = {
    width: img.width,
    height: img.height,
    data: img.data,
    encoding: equirect.type === HalfFloatType ? 'half' : equirect.type === FloatType ? 'float' : 'srgb8',
    channels: 4,
  };
  // Analyse the graded-but-unclamped sky (the clamp would flatten the sun search), then clamp.
  gradeEquirect(view, ENV_GRADE);
  const analysis = analyzeEquirect(view);
  gradeEquirect(view, [ENV_SCALE, ENV_SCALE, ENV_SCALE], ENV_SHOULDER);

  // ---- sun
  const hdriSun = liftSunElevation(analysis.sunDirection, SUN_MIN_ELEVATION_DEG);
  const sunDirection = new Vector3(...(opts.sunDirection ?? hdriSun)).normalize();
  const yaw = opts.sunDirection ? envYawFor(analysis.sunDirection, opts.sunDirection) : 0;
  scene.environmentRotation.set(0, yaw, 0);
  const envRot = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(0, yaw, 0))).transpose();

  const sunColor = new Color().setHex(opts.sunColor ?? DEFAULT_SUN_COLOR, 'srgb-linear');
  const sunIntensity = opts.sunIntensity ?? DEFAULT_SUN_INTENSITY;
  const sun = new DirectionalLight(sunColor, sunIntensity);
  sun.name = 'crumple.sun';
  sun.position.copy(sunDirection).multiplyScalar(500);
  sun.target.position.set(0, 0, 0);

  // ---- environment
  const envIntensity = opts.envIntensity ?? 1;
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(equirect);
  pmrem.dispose();
  const environment = envRT.texture;
  scene.environment = environment;
  scene.environmentIntensity = envIntensity;
  scene.background = null;

  // ---- haze model (fog colour = HDRI horizon band away from the sun; lobe toward it)
  const hazeAway = new Color(...analysis.horizonAway).multiplyScalar(ENV_SCALE); // × scene.environmentIntensity at use
  const hazeSun = new Color(...analysis.horizonSun).multiplyScalar(ENV_SCALE * envIntensity);
  // the horizon toward a low sun can be 10× the away side: cap so fogged terrain never outshines the sky
  const capL = Math.max(hazeAway.r, hazeAway.g, hazeAway.b) * HAZE_SUN_CAP;
  const sunMax = Math.max(hazeSun.r, hazeSun.g, hazeSun.b);
  if (sunMax > capL) hazeSun.multiplyScalar(capL / sunMax);
  const bake: FogBake = { sunDir: sunDirection.clone(), sunColor: hazeSun, lobe: analysis.horizonLobe };
  installFogChunks(bake);

  const fogDensity = opts.fogDensity ?? DEFAULT_FOG_DENSITY;
  const prevFog = scene.fog;
  scene.fog = fogDensity > 0 ? new FogExp2(hazeAway.clone().multiplyScalar(envIntensity), fogDensity) : null;

  // ---- sky
  const sky = createSky(equirect, bake, { envRot, intensity: envIntensity });
  sky.material.uniforms.uHazeColor!.value = hazeAway.clone().multiplyScalar(envIntensity);
  (sky.material.uniforms.uSunColor!.value as Color).setRGB(...analysis.sunColor).lerp(sunColor, 0.5);
  scene.add(sky);

  // ---- CSM (fallback: a single shadowed sun when texture units are scarce)
  const maxTextures = renderer.capabilities.maxTextures;
  const useCsm = maxTextures >= 16;
  let quality = ctx.quality;
  let csm: CSM | null = null;
  const lightDirection = sunDirection.clone().negate();

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

  /** csm.updateFrustums + the throttled cascades' margin (CSM re-fits the boxes from scratch each call). */
  const fitCascades = (): void => {
    if (!csm) return;
    csm.updateFrustums();
    csm.lights.forEach((l, i) => {
      if (i < CSM_THROTTLE_FROM) return;
      // throttled cascades: a little extra extent so a one-frame-old box still covers the slice
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
      lightDirection,
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

  const fallbackTexel = new Vector3();
  let lastEnvIntensity = Number.NaN;
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
    environment,
    update(camera: Camera) {
      camera.updateMatrixWorld();
      sky.position.setFromMatrixPosition(camera.matrixWorld);
      // sky + fog track scene.environmentIntensity so reflections, sky and haze always agree
      const ei = scene.environmentIntensity;
      if (ei !== lastEnvIntensity) {
        lastEnvIntensity = ei;
        sky.material.uniforms.uIntensity!.value = ei;
        (sky.material.uniforms.uHazeColor!.value as Color).copy(hazeAway).multiplyScalar(ei);
        if (scene.fog instanceof FogExp2) scene.fog.color.copy(hazeAway).multiplyScalar(ei);
      }
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
      scene.remove(sky);
      sky.geometry.dispose();
      sky.material.dispose();
      if (scene.environment === environment) scene.environment = null;
      envRT.dispose();
      equirect.dispose();
      scene.fog = prevFog;
      restoreFogChunks();
    },
  };

  // debug handle for tools/dev pages (not part of the contract)
  (stack as unknown as { debug: LightingDebug }).debug = {
    analysis,
    sky,
    hazeAway,
    hazeSun,
    procedural: env.procedural,
    setSunElevation(deg: number) {
      const d = liftSunElevation([sunDirection.x, 0, sunDirection.z], deg);
      const el = (deg * Math.PI) / 180;
      const h = Math.hypot(d[0], d[2]) || 1;
      sunDirection.set((d[0] / h) * Math.cos(el), Math.sin(el), (d[2] / h) * Math.cos(el));
      sun.position.copy(sunDirection).multiplyScalar(500);
      (sky.material.uniforms.uSunDir!.value as Vector3).copy(sunDirection);
      if (csm) {
        csm.lightDirection.copy(sunDirection).negate();
        fitCascades();
      }
    },
    setSunColor(hex: number) {
      sunColor.setHex(hex, 'srgb-linear');
      sun.color.copy(sunColor);
      styleCsmLights();
    },
  };
  return stack;
};

/** Dev/test handle (not part of the contract). */
export interface LightingDebug {
  analysis: SkyAnalysis;
  sky: Mesh<BoxGeometry, ShaderMaterial>;
  hazeAway: Color;
  hazeSun: Color;
  procedural: boolean;
  setSunElevation(deg: number): void;
  setSunColor(linearHex: number): void;
}

export function lightingDebug(stack: LightingStack): LightingDebug {
  return (stack as unknown as { debug: LightingDebug }).debug;
}

