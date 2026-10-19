/**
 * Water surface material: a MeshStandardMaterial patched through
 * onBeforeCompile (three's lights, CSM shadows, IBL and the custom height
 * fog stay intact; patchMaterial({csm}) composes CSM in front of this hook).
 *
 * Lighting split (the patch replaces <opaque_fragment>):
 *   - the material's diffuse colour is WHITE, so three's direct + indirect
 *     diffuse = the radiance of a white Lambertian at this point under the
 *     shadowed sun + sky: `lightW`, the light that the water volume scatters
 *     (× shallow/deep colour) and foam reflects (× foam albedo);
 *   - three's direct specular (GGX, CSM-shadowed, roughness from the wave
 *     field) is the SUN GLINT, scaled to water's F0 and radiance-capped;
 *   - reflection = planar texture (projected with the mirrored camera's
 *     matrix, wave-distorted) or the PMREM environment with a fake reflected
 *     shoreline band near the horizon ('env' presets), Schlick fresnel F0 0.02;
 *   - refraction = the opaque frame copied just before the water draws
 *     (tRefraction, see index.ts), wave-distorted ∝ depth, attenuated by
 *     Beer–Lambert along the view + light path through the water, plus
 *     in-scattering mix(shallow, deep, 1 − e^(−σ̄·path)) · lightW;
 *   - depth d = level − terrain from the field texture (R) → soft edge
 *     alpha (no seam where the terrain meets the plane); shore distance (G)
 *     → lapping foam lines; contacts (objects in the water) → foam rings +
 *     a local soft-intersection term; ripple rings → normal perturbation.
 * Final colour is NaN/Inf-guarded and clamped to WATER_MAX_RADIANCE.
 * Backfaces (camera under water): Snell's window over a dark scatter tint.
 */
import { Color, DoubleSide, Matrix4, MeshStandardMaterial, NormalBlending, Vector2, Vector3, Vector4 } from 'three';
import type { IUniform, Texture, WebGLProgramParametersWithUniforms } from 'three';

import type { WaterOptics } from '../../world/types';
import { MAX_CONTACTS, MAX_RIPPLES, RIPPLE_LIFE_S, RIPPLE_SPEED_MS } from './ripples';
import { WATER_MAX_RADIANCE } from './types';

export const WATER_SHADER_KEY = 'water-u5a';

export interface WaterUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  uLevel: IUniform<number>;
  tWave: IUniform<Texture | null>;
  uWaveScale: IUniform<Vector4>;
  tNoise: IUniform<Texture | null>;
  tField: IUniform<Texture | null>;
  uFieldGrid: IUniform<Vector4>;
  uFieldHalf: IUniform<Vector2>;
  tRefraction: IUniform<Texture | null>;
  uScreenInv: IUniform<Vector2>;
  uRefraction: IUniform<number>;
  tReflection: IUniform<Texture | null>;
  uReflMatrix: IUniform<Matrix4>;
  uPlanar: IUniform<number>;
  uShallow: IUniform<Color>;
  uDeep: IUniform<Color>;
  uAbsorb: IUniform<Vector3>;
  uFoamDepth: IUniform<number>;
  uWaveLen: IUniform<number>;
  uWaveSpeed: IUniform<number>;
  uWind: IUniform<Vector2>;
  uShoreTint: IUniform<Color>;
  uRipples: IUniform<Float32Array>;
  uContacts: IUniform<Float32Array>;
}

const VERT_PARS = /* glsl */ `
varying vec3 vWaterPos;
`;
const VERT_POS = /* glsl */ `
vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_PARS = /* glsl */ `
#define WATER_MAX_RADIANCE ${WATER_MAX_RADIANCE.toFixed(1)}
#define WATER_RIPPLES ${MAX_RIPPLES}
#define WATER_CONTACTS ${MAX_CONTACTS}
varying vec3 vWaterPos;
uniform float uTime;
uniform float uLevel;
uniform sampler2D tWave;
uniform vec4 uWaveScale;     // slope decode: A, B, (unused), global strength
uniform sampler2D tNoise;
uniform sampler2D tField;
uniform vec4 uFieldGrid;     // originX, originZ, 1/extentX, 1/extentZ
uniform vec2 uFieldHalf;     // half texel
uniform sampler2D tRefraction;
uniform vec2 uScreenInv;
uniform float uRefraction;   // 1 = tRefraction holds this frame's opaque scene
uniform sampler2D tReflection;
uniform mat4 uReflMatrix;
uniform float uPlanar;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uAbsorb;
uniform float uFoamDepth;
uniform float uWaveLen;
uniform float uWaveSpeed;
uniform vec2 uWind;
uniform vec3 uShoreTint;
uniform vec4 uRipples[WATER_RIPPLES];
uniform vec4 uContacts[WATER_CONTACTS];

vec3 wN;          // world wave normal (toward the viewer's side)
vec2 wField;      // depth, shore distance
float wFade;      // 1 near → 0 far (normal detail)
float wContact;   // 0..1 nearness to an object piercing the surface
float wFoamRipple;

vec2 waterSlope(vec2 xz, float t, float dist) {
  vec2 w = uWind;
  vec2 wp = vec2(-w.y, w.x);
  // wind gust patches ("cat's paws"): glassy lanes next to rippled ones
  float g1 = texture2D(tNoise, xz * (1.0 / 310.0) + w * (t * 0.0045)).r;
  float g2 = texture2D(tNoise, xz * (1.0 / 133.0) - wp * (t * 0.006) + 0.37).r;
  float gust = smoothstep(0.32, 0.78, g1 * 0.65 + g2 * 0.45);
  float L = uWaveLen;
  vec4 a = texture2D(tWave, xz / (L * 3.7) + w * (t * 0.020));
  vec4 b = texture2D(tWave, xz / L + (w * 0.92 + wp * 0.25) * (t * 0.075));
  vec2 s = (a.rg * 2.0 - 1.0) * uWaveScale.x * 0.55
         + (b.ba * 2.0 - 1.0) * uWaveScale.y * (0.12 + 0.88 * gust);
  #ifndef WATER_LITE
    vec4 c = texture2D(tWave, xz / (L * 0.29) + (w * 0.85 - wp * 0.4) * (t * 0.16));
    s += (c.rg * 2.0 - 1.0) * uWaveScale.x * (0.04 + 0.96 * gust) * 0.7;
  #endif
  // distance: the mips average slopes away anyway; fade so far water reads as a mirror with sparkle in roughness
  wFade = 1.0 - smoothstep(25.0, 520.0, dist);
  s *= uWaveScale.w * mix(0.35, 1.0, wFade);
  // ripple rings from objects in the water
  wFoamRipple = 0.0;
  for (int i = 0; i < WATER_RIPPLES; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    float age = uTime - r.z;
    if (age < 0.0 || age > ${RIPPLE_LIFE_S.toFixed(1)}) continue;
    vec2 dv = xz - r.xy;
    float d = length(dv);
    float x = d - age * ${RIPPLE_SPEED_MS.toFixed(2)};
    float env = exp(-x * x * 1.4) * exp(-age * 0.85) * r.w / (1.0 + 0.35 * d);
    float k = 7.0;
    s += (dv / max(d, 1e-3)) * (env * cos(k * x) * 0.8);
    wFoamRipple += env * smoothstep(0.6, 1.0, cos(k * x)) * exp(-age * 1.6);
  }
  return s;
}

float waterLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** After <normal_fragment_maps>: the wave normal replaces the (flat) geometry normal. */
const FRAG_NORMAL = /* glsl */ `
{
  vec2 fuv = (vWaterPos.xz - uFieldGrid.xy) * uFieldGrid.zw + uFieldHalf;
  wField = texture2D(tField, fuv).rg;
  if (wField.x < -0.05) discard; // true terrain above the level (coarse terrain LOD dips under it)
  float dist = length(vWaterPos - cameraPosition);
  vec2 s = waterSlope(vWaterPos.xz, uTime * uWaveSpeed, dist);
  // calm down in very shallow water (no fetch) and right at the shore
  s *= mix(0.35, 1.0, smoothstep(0.0, 1.2, wField.x));
  // grazing angles: the projected wave pattern aliases into streaks; keep the far field a soft mirror
  s *= mix(0.3, 1.0, smoothstep(0.012, 0.12, abs(cameraPosition.y - vWaterPos.y) / max(dist, 1e-3)));
  wContact = 0.0;
  for (int i = 0; i < WATER_CONTACTS; i++) {
    vec4 c = uContacts[i];
    if (c.w <= 0.0) continue;
    float d = length(vWaterPos.xz - c.xy);
    wContact = max(wContact, c.w * (1.0 - smoothstep(c.z * 0.6, c.z + 0.9, d)));
  }
  wN = normalize(vec3(-s.x, 1.0, -s.y));
  if (!gl_FrontFacing) wN = -wN;
  normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
}
`;

/** After <roughnessmap_fragment>: glint roughness grows with distance (lost wave detail = wider lobe). */
const FRAG_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(0.13, 0.05, wFade);
`;

const FRAG_OUT = /* glsl */ `
{
  vec3 V = normalize(cameraPosition - vWaterPos);
  float dist = length(cameraPosition - vWaterPos);
  float depth = max(wField.x, 0.0);
  vec3 lightW = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse; // white Lambertian radiance
  vec3 col;
  float alpha;
  if (gl_FrontFacing) {
    float cosV = max(dot(wN, V), 0.0);
    // ---- refraction (opaque frame below the surface)
    vec2 suv = gl_FragCoord.xy * uScreenInv;
    float dz = clamp(depth, 0.0, 2.5);
    vec2 roff = wN.xz * (0.045 * dz / (1.0 + dist * 0.06));
    vec3 bed = uRefraction > 0.5 ? texture2D(tRefraction, clamp(suv + roff, vec2(0.001), vec2(0.999))).rgb : uDeep * lightW;
    // the bed was shaded as dry/wet land: strip its sun specular (an albedo-0.3 Lambertian is the most it can send up)
    vec3 bedMax = lightW * 0.3 + 1e-4;
    bed = bed / (1.0 + max(waterLum(bed) / waterLum(bedMax) - 1.0, 0.0));
    // caustics: wave focusing on a sunlit shallow bed (divergence of the slope field, two extra taps)
    #ifndef WATER_LITE
    {
      float sunFrac = clamp(waterLum(reflectedLight.directDiffuse) / max(waterLum(lightW), 1e-4), 0.0, 1.0);
      vec2 cp = (vWaterPos.xz + roff * 40.0) / (uWaveLen * 0.55) + uWind * (uTime * uWaveSpeed * 0.09);
      vec2 s0 = texture2D(tWave, cp).rg;
      vec2 sx = texture2D(tWave, cp + vec2(0.012, 0.0)).rg;
      vec2 sz = texture2D(tWave, cp + vec2(0.0, 0.012)).rg;
      float div = (sx.x - s0.x) + (sz.y - s0.y);
      float shallowK = (1.0 - exp(-depth * 2.5)) * exp(-depth * 0.45);
      bed *= 1.0 + clamp(-div * 9.0, -0.35, 1.2) * shallowK * sunFrac * 0.7;
    }
    #endif
    float vy = max(abs(V.y), 0.22);
    float path = depth / vy + depth;          // eye ray down to the bed + sunlight down to it
    vec3 T = exp(-uAbsorb * path);
    float k = 1.0 - exp(-dot(uAbsorb, vec3(0.3333)) * path * 0.6);
    vec3 scatter = mix(uShallow, uDeep, k) * lightW * 0.55;
    vec3 body = bed * T + scatter * (1.0 - T);
    // ---- reflection
    float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
    vec3 R = reflect(-V, wN);
    R.y = abs(R.y); // a wave-tilted ray dipping under the horizon would hit the water again, not the HDRI ground
    vec3 env = vec3(0.0);
    #ifdef USE_ENVMAP
      env = waterEnv(R, 0.02);
    #endif
    // environment mode: reflected far shore / mountains as a dark band low over the horizon
    // from the flat-plane reflection (only a little wave wobble), so ripples do not stripe the band
    float ry = abs(V.y) + (R.y - abs(V.y)) * 0.25;
    float shore = 1.0 - smoothstep(0.01, 0.14, ry);
    vec3 envR = mix(env, uShoreTint * lightW, shore * 0.65);
    vec3 refl = envR;
    if (uPlanar > 0.5) {
      vec4 p = uReflMatrix * vec4(vWaterPos, 1.0);
      vec2 ruv = p.xy / p.w + wN.xz * (0.08 / (1.0 + dist * 0.02));
      refl = texture2D(tReflection, clamp(ruv, vec2(0.002), vec2(0.998))).rgb;
    }
    // ---- sun glint (three's shadowed GGX lobe, F0 0.04 → water 0.02), capped
    vec3 glint = reflectedLight.directSpecular * 0.5;
    float gl = waterLum(glint);
    glint *= min(1.0, (WATER_MAX_RADIANCE * 0.6) / max(gl, 1e-4));
    col = mix(body, refl, F) + glint;
    // ---- foam: shoreline band (noise-broken lapping lines) + object contacts + ripple crests
    vec2 xz = vWaterPos.xz;
    float n1 = texture2D(tNoise, xz * 0.071 + uWind * (uTime * 0.018)).r;
    float n2 = texture2D(tNoise, xz * 0.23 - uWind * (uTime * 0.05) + 0.5).r;
    float band = 1.0 - smoothstep(0.0, uFoamDepth, depth + (n1 - 0.5) * 0.18);
    float lap = 0.5 + 0.5 * sin(wField.y * 2.3 - uTime * 1.25 + n1 * 5.0);
    float shoreFoam = band * smoothstep(0.55, 0.9, n2 * 0.7 + lap * 0.45 + band * 0.2);
    float contactFoam = wContact * smoothstep(0.3, 0.7, n2 + wContact * 0.3);
    float foam = clamp(shoreFoam * 0.42 + contactFoam * 0.9 + wFoamRipple * 0.6, 0.0, 1.0);
    col = mix(col, vec3(0.78, 0.8, 0.8) * lightW, foam);
    // soft intersection: alpha → 0 as the depth → 0 (terrain) or at an object's waterline
    alpha = smoothstep(0.0, 0.09, wField.x) * (1.0 - 0.45 * wContact * (1.0 - foam));
  } else {
    // under the surface looking up: Snell's window (≈ 48.6° half-angle) inside total internal reflection
    float cosV = abs(dot(wN, V));
    vec3 sky = vec3(0.0);
    #ifdef USE_ENVMAP
      sky = waterEnv(normalize(-V + vec3(0.0, 0.6, 0.0)), 0.25);
    #endif
    vec3 deep = uDeep * lightW * 0.5;
    col = mix(deep, sky * 0.7 + deep, smoothstep(0.6, 0.72, cosV));
    alpha = 1.0;
  }
  // radiance cap + non-finite guard (HalfFloat target; bloom must never see Inf/NaN)
  col = clamp(col, vec3(0.0), vec3(WATER_MAX_RADIANCE));
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/** After the env pars: world-direction environment lookup. */
const FRAG_ENV = /* glsl */ `
vec3 waterEnv(vec3 dirW, float rough) {
  #ifdef ENVMAP_TYPE_CUBE_UV
    return textureCubeUV(envMap, envMapRotation * dirW, rough).rgb * envMapIntensity;
  #else
    return vec3(0.0);
  #endif
}
`;

function replaceOnce(src: string, find: string, repl: string): string {
  const i = src.indexOf(find);
  if (i < 0) throw new Error(`water shader: chunk ${find} not found`);
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

export function createWaterUniforms(optics: WaterOptics, level: number): WaterUniforms {
  const u: WaterUniforms = {
    uTime: { value: 0 },
    uLevel: { value: level },
    tWave: { value: null },
    uWaveScale: { value: new Vector4(1, 1, 0, 1) },
    tNoise: { value: null },
    tField: { value: null },
    uFieldGrid: { value: new Vector4() },
    uFieldHalf: { value: new Vector2() },
    tRefraction: { value: null },
    uScreenInv: { value: new Vector2(1, 1) },
    uRefraction: { value: 0 },
    tReflection: { value: null },
    uReflMatrix: { value: new Matrix4() },
    uPlanar: { value: 0 },
    uShallow: { value: new Color() },
    uDeep: { value: new Color() },
    uAbsorb: { value: new Vector3() },
    uFoamDepth: { value: 0.35 },
    uWaveLen: { value: 6 },
    uWaveSpeed: { value: 0.6 },
    uWind: { value: new Vector2(1, 0) },
    uShoreTint: { value: new Color(0.06, 0.07, 0.045) },
    uRipples: { value: new Float32Array(MAX_RIPPLES * 4) },
    uContacts: { value: new Float32Array(MAX_CONTACTS * 4) },
  };
  applyOptics(u, optics);
  return u;
}

/** WaterOptics → uniforms (colours are sRGB hex → linear). */
export function applyOptics(u: WaterUniforms, o: WaterOptics): void {
  u.uShallow.value.setHex(o.shallowColor);
  u.uDeep.value.setHex(o.deepColor);
  u.uAbsorb.value.set(o.absorption[0], o.absorption[1], o.absorption[2]);
  u.uFoamDepth.value = o.foamDepth;
  u.uWaveLen.value = o.waveScale;
  u.uWaveSpeed.value = o.waveSpeed;
}

/** Material define selecting the cheaper path (low preset): two wave taps, no caustics. */
export const WATER_LITE_DEFINE = 'WATER_LITE';

/** Toggle the lite path (recompiles on change). */
export function setWaterLite(m: MeshStandardMaterial, lite: boolean): void {
  m.defines ??= {};
  if (!!m.defines[WATER_LITE_DEFINE] === lite) return;
  if (lite) m.defines[WATER_LITE_DEFINE] = '';
  else delete m.defines[WATER_LITE_DEFINE];
  m.needsUpdate = true;
}

/** The unpatched water material (index.ts runs patchMaterial({csm}) on it). */
export function createWaterMaterial(uniforms: WaterUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    name: 'crumple.water',
    color: 0xffffff,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    depthWrite: true,
    blending: NormalBlending,
    side: DoubleSide,
  });
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = replaceOnce(vs, '#include <common>', `#include <common>\n${VERT_PARS}`);
    vs = replaceOnce(vs, '#include <begin_vertex>', `#include <begin_vertex>\n${VERT_POS}`);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = replaceOnce(fs, '#include <common>', `#include <common>\n${FRAG_PARS}`);
    fs = replaceOnce(fs, '#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${FRAG_ENV}`);
    fs = replaceOnce(fs, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`);
    fs = replaceOnce(fs, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGHNESS}`);
    fs = replaceOnce(fs, '#include <opaque_fragment>', FRAG_OUT);
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => WATER_SHADER_KEY;
  return m;
}
