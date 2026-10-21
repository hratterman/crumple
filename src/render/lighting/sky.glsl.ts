/**
 * GLSL for the physically based sky (Hillaire 2020): transmittance LUT,
 * multiple-scattering LUT, sky-view LUT, the sky dome / IBL capture shader
 * and the lookup shared with every env-patched material (aerial perspective).
 *
 * Units: megametres and per-megametre coefficients (atmosphere.ts). The LUTs
 * hold radiance for a unit solar illuminance; consumers multiply by uSkySunE.
 */
import { ATMOSPHERE } from './atmosphere';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
const v3 = (a: readonly number[]): string => `vec3(${a.map(f).join(', ')})`;

export const TRANSMITTANCE_LUT_SIZE = [256, 64] as const;
export const MULTISCAT_LUT_SIZE = 32;
export const SKYVIEW_LUT_SIZE = [192, 108] as const;

/** Constants + scattering profile + LUT addressing (shared by every pass). */
export const ATMO_COMMON = /* glsl */ `
#ifndef CRUMPLE_ATMO_COMMON
#define CRUMPLE_ATMO_COMMON
const float ATMO_PI = 3.14159265358979;
const float ATMO_RG = ${f(ATMOSPHERE.groundRadius)};
const float ATMO_RT = ${f(ATMOSPHERE.topRadius)};
const vec3 ATMO_RAY_SCAT = ${v3(ATMOSPHERE.rayleighScattering)};
const float ATMO_RAY_H = ${f(ATMOSPHERE.rayleighScaleHeightKm)};
const float ATMO_MIE_SCAT = ${f(ATMOSPHERE.mieScattering)};
const float ATMO_MIE_ABS = ${f(ATMOSPHERE.mieAbsorption)};
const float ATMO_MIE_H = ${f(ATMOSPHERE.mieScaleHeightKm)};
const float ATMO_MIE_G = ${f(ATMOSPHERE.mieG)};
const vec3 ATMO_OZONE = ${v3(ATMOSPHERE.ozoneAbsorption)};
const float ATMO_OZONE_C = ${f(ATMOSPHERE.ozoneCenterKm)};
const float ATMO_OZONE_W = ${f(ATMOSPHERE.ozoneHalfWidthKm)};
const vec3 ATMO_GROUND_ALBEDO = vec3(${f(ATMOSPHERE.groundAlbedo)});

float atmoSafeAcos(float x) { return acos(clamp(x, -1.0, 1.0)); }

// distance to the sphere of radius r around the origin along rd from ro, or -1
float atmoRaySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  if (c > 0.0 && b > 0.0) return -1.0;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  if (disc > b * b) return -b + sqrt(disc);
  return -b - sqrt(disc);
}

void atmoScattering(vec3 pos, out vec3 rayleigh, out float mie, out vec3 extinction) {
  float altKm = (length(pos) - ATMO_RG) * 1000.0;
  float rd = exp(-altKm / ATMO_RAY_H);
  float md = exp(-altKm / ATMO_MIE_H);
  rayleigh = ATMO_RAY_SCAT * rd;
  mie = ATMO_MIE_SCAT * md;
  vec3 ozone = ATMO_OZONE * max(0.0, 1.0 - abs(altKm - ATMO_OZONE_C) / ATMO_OZONE_W);
  extinction = rayleigh + vec3(mie + ATMO_MIE_ABS * md) + ozone;
}

float atmoMiePhase(float c) {
  float g = ATMO_MIE_G;
  float scale = 3.0 / (8.0 * ATMO_PI);
  float num = (1.0 - g * g) * (1.0 + c * c);
  float den = (2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
  return scale * num / den;
}

float atmoRayleighPhase(float c) {
  return 3.0 / (16.0 * ATMO_PI) * (1.0 + c * c);
}

vec2 atmoLutUv(vec3 pos, vec3 sunDir) {
  float h = length(pos);
  vec3 up = pos / h;
  return vec2(clamp(0.5 + 0.5 * dot(sunDir, up), 0.0, 1.0), clamp((h - ATMO_RG) / (ATMO_RT - ATMO_RG), 0.0, 1.0));
}
#endif
`;

/** Fullscreen-triangle vertex shader for the LUT passes. */
export const LUT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const TRANSMITTANCE_FRAGMENT = /* glsl */ `
${ATMO_COMMON}
varying vec2 vUv;
void main() {
  float cosZ = 2.0 * vUv.x - 1.0;
  float h = mix(ATMO_RG, ATMO_RT, vUv.y);
  vec3 pos = vec3(0.0, h, 0.0);
  vec3 dir = normalize(vec3(0.0, cosZ, -sqrt(max(0.0, 1.0 - cosZ * cosZ))));
  if (atmoRaySphere(pos, dir, ATMO_RG) > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float tMax = atmoRaySphere(pos, dir, ATMO_RT);
  vec3 od = vec3(0.0);
  const float N = 40.0;
  float dt = tMax / N;
  for (float i = 0.0; i < N; i += 1.0) {
    vec3 p = pos + (i + 0.5) * dt * dir;
    vec3 r; float m; vec3 ext;
    atmoScattering(p, r, m, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

export const MULTISCAT_FRAGMENT = /* glsl */ `
${ATMO_COMMON}
uniform sampler2D uTransmittance;
varying vec2 vUv;
const int SQRT_SAMPLES = 8;
const float STEPS = 20.0;
void main() {
  float cosZ = 2.0 * vUv.x - 1.0;
  float h = mix(ATMO_RG, ATMO_RT, vUv.y);
  vec3 pos = vec3(0.0, h, 0.0);
  vec3 sunDir = normalize(vec3(0.0, cosZ, -sqrt(max(0.0, 1.0 - cosZ * cosZ))));
  vec3 lumTotal = vec3(0.0);
  vec3 fms = vec3(0.0);
  float inv = 1.0 / float(SQRT_SAMPLES * SQRT_SAMPLES);
  for (int i = 0; i < SQRT_SAMPLES; i++) {
    for (int j = 0; j < SQRT_SAMPLES; j++) {
      float theta = ATMO_PI * (float(i) + 0.5) / float(SQRT_SAMPLES);
      float phi = atmoSafeAcos(1.0 - 2.0 * (float(j) + 0.5) / float(SQRT_SAMPLES));
      vec3 rd = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
      float atmoDist = atmoRaySphere(pos, rd, ATMO_RT);
      float groundDist = atmoRaySphere(pos, rd, ATMO_RG);
      float tMax = groundDist > 0.0 ? groundDist : atmoDist;
      float c = dot(rd, sunDir);
      float mieP = atmoMiePhase(c);
      float rayP = atmoRayleighPhase(-c);
      vec3 lum = vec3(0.0);
      vec3 lumFactor = vec3(0.0);
      vec3 trans = vec3(1.0);
      float t = 0.0;
      for (float s = 0.0; s < STEPS; s += 1.0) {
        float nt = ((s + 0.3) / STEPS) * tMax;
        float dt = nt - t;
        t = nt;
        vec3 p = pos + t * rd;
        vec3 ray; float mie; vec3 ext;
        atmoScattering(p, ray, mie, ext);
        vec3 st = exp(-dt * ext);
        vec3 scat = ray + vec3(mie);
        lumFactor += trans * (scat - scat * st) / ext;
        vec3 sunT = texture2D(uTransmittance, atmoLutUv(p, sunDir)).rgb;
        vec3 ins = (ray * rayP + mie * mieP) * sunT;
        lum += trans * (ins - ins * st) / ext;
        trans *= st;
      }
      if (groundDist > 0.0) {
        vec3 hit = pos + groundDist * rd;
        if (dot(pos, sunDir) > 0.0) {
          hit = normalize(hit) * ATMO_RG;
          lum += trans * ATMO_GROUND_ALBEDO * texture2D(uTransmittance, atmoLutUv(hit, sunDir)).rgb;
        }
      }
      fms += lumFactor * inv;
      lumTotal += lum * inv;
    }
  }
  gl_FragColor = vec4(lumTotal / (1.0 - fms), 1.0);
}
`;

export const SKYVIEW_FRAGMENT = /* glsl */ `
${ATMO_COMMON}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScat;
uniform float uViewHeight;
uniform float uSunElevation;
varying vec2 vUv;
const float STEPS = 30.0;
void main() {
  float az = (vUv.x - 0.5) * 2.0 * ATMO_PI;
  float adjV;
  if (vUv.y < 0.5) { float c = 1.0 - 2.0 * vUv.y; adjV = -c * c; }
  else { float c = 2.0 * vUv.y - 1.0; adjV = c * c; }
  vec3 pos = vec3(0.0, uViewHeight, 0.0);
  float horizon = atmoSafeAcos(sqrt(max(0.0, uViewHeight * uViewHeight - ATMO_RG * ATMO_RG)) / uViewHeight) - 0.5 * ATMO_PI;
  float alt = adjV * 0.5 * ATMO_PI - horizon;
  float ca = cos(alt);
  vec3 rd = vec3(ca * sin(az), sin(alt), -ca * cos(az));
  vec3 sunDir = vec3(0.0, sin(uSunElevation), -cos(uSunElevation));
  float atmoDist = atmoRaySphere(pos, rd, ATMO_RT);
  float groundDist = atmoRaySphere(pos, rd, ATMO_RG);
  float tMax = groundDist < 0.0 ? atmoDist : groundDist;
  float c = dot(rd, sunDir);
  float mieP = atmoMiePhase(c);
  float rayP = atmoRayleighPhase(-c);
  vec3 lum = vec3(0.0);
  vec3 trans = vec3(1.0);
  float t = 0.0;
  for (float s = 0.0; s < STEPS; s += 1.0) {
    float nt = ((s + 0.3) / STEPS) * tMax;
    float dt = nt - t;
    t = nt;
    vec3 p = pos + t * rd;
    vec3 ray; float mie; vec3 ext;
    atmoScattering(p, ray, mie, ext);
    vec3 st = exp(-dt * ext);
    vec2 luv = atmoLutUv(p, sunDir);
    vec3 sunT = texture2D(uTransmittance, luv).rgb;
    vec3 psi = texture2D(uMultiScat, luv).rgb;
    vec3 ins = ray * (rayP * sunT + psi) + mie * (mieP * sunT + psi);
    lum += trans * (ins - ins * st) / ext;
    trans *= st;
  }
  gl_FragColor = vec4(lum, 1.0);
}
`;

/**
 * Sky radiance lookup (world direction → radiance for unit solar illuminance)
 * from the sky-view LUT, plus the analytic night sky. Needs uniforms
 * crumpleSkyView, crumpleSkyHeight, crumpleSunDir (the SUN, not the key
 * light), crumpleSkySunE, crumpleNightZenith, crumpleNightHorizon,
 * crumpleMoonDir, crumpleMoonGlow, crumpleOvercast (rgb = overcast radiance, a = cover).
 */
export const SKY_LOOKUP = /* glsl */ `
#ifndef CRUMPLE_SKY_LOOKUP
#define CRUMPLE_SKY_LOOKUP
vec3 crumpleSkyViewLut(vec3 d) {
  float h = crumpleSkyHeight;
  float rg = ${f(ATMOSPHERE.groundRadius)};
  float horizon = acos(clamp(sqrt(max(0.0, h * h - rg * rg)) / h, -1.0, 1.0));
  float alt = horizon - acos(clamp(d.y, -1.0, 1.0));
  vec3 s = vec3(crumpleSunDir.x, 0.0, crumpleSunDir.z);
  float sl = length(s);
  vec3 fwd = sl > 1e-4 ? s / sl : vec3(0.0, 0.0, -1.0);
  vec3 right = vec3(-fwd.z, 0.0, fwd.x);
  vec2 dh = vec2(dot(d, right), dot(d, fwd));
  float az = (abs(alt) > 1.5707 || dot(dh, dh) < 1e-10) ? 0.0 : atan(dh.x, dh.y);
  float v = 0.5 + 0.5 * sign(alt) * sqrt(abs(alt) * 0.63661977);
  return texture2D(crumpleSkyView, vec2(az * 0.15915494 + 0.5, v)).rgb;
}
vec3 crumpleNightSky(vec3 d) {
  float y = max(d.y, 0.0);
  vec3 c = mix(crumpleNightHorizon, crumpleNightZenith, sqrt(y));
  float mc = max(dot(d, crumpleMoonDir), 0.0);
  c += crumpleMoonGlow * (pow(mc, 12.0) * 0.6 + pow(mc, 300.0) * 3.0);
  return c;
}
/** Clear-sky radiance (day atmosphere + night sky) blended toward the overcast deck. */
vec3 crumpleSkyRadiance(vec3 d) {
  vec3 dd = vec3(d.x, max(d.y, 0.0), d.z);
  vec3 c = crumpleSkyViewLut(normalize(dd)) * crumpleSkySunE + crumpleNightSky(dd);
  float cover = crumpleOvercast.a;
  vec3 deck = crumpleOvercast.rgb * (0.75 + 0.25 * sqrt(dd.y));
  return mix(c, deck, cover * smoothstep(-0.02, 0.12, d.y) + cover * (1.0 - smoothstep(-0.02, 0.12, d.y)) * 0.85);
}
#endif
`;
