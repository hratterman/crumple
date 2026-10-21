/**
 * Physically based atmosphere constants + the CPU half of the model (pure).
 *
 * The parameters are Hillaire 2020 ("A Scalable and Production Ready Sky and
 * Atmosphere Rendering Technique") for Earth: Rayleigh + Mie scattering with
 * exponential density profiles and an ozone absorption tent. Lengths in the
 * GLSL (sky.glsl.ts) are megametres, coefficients per megametre; this module
 * uses the same units so both sides agree bit-for-bit in shape.
 *
 * The CPU side evaluates sun / moon transmittance (key-light colour and
 * intensity) without touching the GPU: the GPU LUTs drive the sky dome, the
 * IBL capture and the aerial perspective.
 */
import type { Vec3 } from './astro';

export const ATMOSPHERE = {
  /** Mm */
  groundRadius: 6.36,
  topRadius: 6.46,
  /** per Mm at sea level */
  rayleighScattering: [5.802, 13.558, 33.1] as const,
  rayleighScaleHeightKm: 8,
  mieScattering: 3.996,
  mieAbsorption: 4.4,
  mieScaleHeightKm: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.65, 1.881, 0.085] as const,
  ozoneCenterKm: 25,
  ozoneHalfWidthKm: 15,
  groundAlbedo: 0.3,
} as const;

/** Altitude of the valley floor above the model's sea level, m (camera altitude is added on top). */
export const ATMOSPHERE_BASE_ALTITUDE_M = 200;
/**
 * Solar illuminance at the top of the atmosphere in scene units. The noon sun
 * through the atmosphere lands near the P3 key light (≈ 6): sunlit faces stay
 * where the post stack's exposure was tuned.
 */
export const SUN_ILLUMINANCE_TOA = 7.2;

function extinctionAt(altKm: number, out: Vec3): Vec3 {
  const A = ATMOSPHERE;
  const rd = Math.exp(-altKm / A.rayleighScaleHeightKm);
  const md = Math.exp(-altKm / A.mieScaleHeightKm);
  const oz = Math.max(0, 1 - Math.abs(altKm - A.ozoneCenterKm) / A.ozoneHalfWidthKm);
  const m = (A.mieScattering + A.mieAbsorption) * md;
  out[0] = A.rayleighScattering[0] * rd + m + A.ozoneAbsorption[0] * oz;
  out[1] = A.rayleighScattering[1] * rd + m + A.ozoneAbsorption[1] * oz;
  out[2] = A.rayleighScattering[2] * rd + m + A.ozoneAbsorption[2] * oz;
  return out;
}

/** Distance (Mm) along `dir` from a point at radius `r` (on +Y) to the sphere of radius `R`, or −1. */
function raySphere(r: number, dirY: number, R: number): number {
  // origin (0, r, 0), unit dir with y component dirY
  const b = r * dirY;
  const c = r * r - R * R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t0 > 0) return t0;
  if (t1 > 0) return t1;
  return -1;
}

const tmpExt: Vec3 = [0, 0, 0];

/**
 * Transmittance from altitude `altitudeM` toward a direction with vertical
 * component `cosZenith`, to the top of the atmosphere (0 if the ray hits the
 * ground). 64-step midpoint integration.
 */
export function transmittance(altitudeM: number, cosZenith: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const A = ATMOSPHERE;
  const r = A.groundRadius + altitudeM * 1e-6;
  const g = raySphere(r, cosZenith, A.groundRadius);
  if (g > 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const tMax = raySphere(r, cosZenith, A.topRadius);
  const n = 64;
  const dt = tMax / n;
  let o0 = 0;
  let o1 = 0;
  let o2 = 0;
  const sinZ = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * dt;
    const x = t * sinZ;
    const y = r + t * cosZenith;
    const h = Math.sqrt(x * x + y * y) - A.groundRadius;
    extinctionAt(h * 1000, tmpExt);
    o0 += tmpExt[0] * dt;
    o1 += tmpExt[1] * dt;
    o2 += tmpExt[2] * dt;
  }
  out[0] = Math.exp(-o0);
  out[1] = Math.exp(-o1);
  out[2] = Math.exp(-o2);
  return out;
}

/**
 * Illuminance of a celestial light at the ground, scene units, per channel:
 * TOA illuminance × transmittance, faded over the disc crossing the horizon
 * (±0.6°) so the key light never pops.
 */
export function bodyIlluminance(dir: readonly number[], toa: number, altitudeM = ATMOSPHERE_BASE_ALTITUDE_M, out: Vec3 = [0, 0, 0]): Vec3 {
  const y = dir[1]!;
  const sinHalf = Math.sin((0.6 * Math.PI) / 180);
  const vis = smoothstep(-sinHalf, sinHalf, y);
  // evaluate just above the geometric horizon while the disc straddles it
  transmittance(altitudeM, Math.max(y, sinHalf * 0.5), out);
  out[0] *= toa * vis;
  out[1] *= toa * vis;
  out[2] *= toa * vis;
  return out;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Luminance (Rec. 709) of a linear RGB triple. */
export function luminance(c: readonly number[]): number {
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
