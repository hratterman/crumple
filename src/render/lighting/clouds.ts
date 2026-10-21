/**
 * Clouds: a raymarched cumulus layer (1.4–2.6 km, on the planet's curvature)
 * lit by the key light with the time of day, plus the cheap cloud-shadow
 * texture the terrain, roads, cars and foliage sample.
 *
 *  - noise: one tileable 96³ R8 Perlin–Worley volume, generated ON THE GPU
 *    once (one draw per slice into a 3D render target: a CPU bake cost
 *    ~0.2–0.8 s of main thread);
 *  - PANORAMA: the layer is marched into an upper-hemisphere panorama (rgb =
 *    in-scattered radiance, a = transmittance; sqrt elevation mapping so the
 *    horizon gets the rows) re-rendered every few frames — clouds are
 *    kilometres away, so camera motion never shows the lag. The sky dome
 *    and the IBL capture composite it (sky·T + cloud);
 *  - lighting: Beer–Lambert + powder, a two-lobe HG phase (silver lining
 *    toward the sun), a short light march toward the key light, ambient from
 *    the sky SH above and the ground below, aerial perspective with distance;
 *  - SHADOW: a 256² map of the layer's transmittance along the key light,
 *    4 km around the camera, re-rendered every few frames; world-lit
 *    materials multiply the key light by it (env patch);
 *  - preset scaling (CLOUD_QUALITY): panorama size, primary / light steps,
 *    update period. Low marches a flat 2D layer (no light steps).
 * Wind drifts everything; `cloudCover` (weather) remaps the coverage.
 */
import {
  ClampToEdgeWrapping,
  WebGL3DRenderTarget,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  BufferGeometry,
  BufferAttribute,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';

import type { QualityLevel } from '../types';

export const CLOUD_BASE_M = 1400;
export const CLOUD_TOP_M = 2600;
/** Cloud-shadow map coverage (m, square around the camera) and size (px). */
export const CLOUD_SHADOW_SPAN_M = 4096;
export const CLOUD_SHADOW_SIZE = 256;
const EARTH_R = 6.36e6;

export interface CloudQuality {
  panorama: [number, number];
  steps: number;
  lightSteps: number;
  /** Panorama re-render period, frames. */
  period: number;
}
export const CLOUD_QUALITY: Readonly<Record<QualityLevel, CloudQuality>> = {
  low: { panorama: [384, 96], steps: 6, lightSteps: 0, period: 6 },
  medium: { panorama: [512, 128], steps: 10, lightSteps: 2, period: 4 },
  high: { panorama: [1024, 256], steps: 14, lightSteps: 3, period: 3 },
  ultra: { panorama: [2048, 512], steps: 28, lightSteps: 5, period: 2 },
};

// ------------------------------------------------------------ GLSL
const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
export const CLOUD_NOISE_SIZE = 96;
const NOISE_FRAGMENT = /* glsl */ `
uniform float uSlice;
varying vec2 vUv;
float h3(vec3 p, float per) {
  p = mod(p, per);
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x, float per) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i, per), h3(i + vec3(1, 0, 0), per), f.x), mix(h3(i + vec3(0, 1, 0), per), h3(i + vec3(1, 1, 0), per), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1), per), h3(i + vec3(1, 0, 1), per), f.x), mix(h3(i + vec3(0, 1, 1), per), h3(i + vec3(1, 1, 1), per), f.x), f.y), f.z);
}
float worley(vec3 x, float per) {
  vec3 i = floor(x);
  float d2 = 9.0;
  for (int k = -1; k <= 1; k++)
    for (int j = -1; j <= 1; j++)
      for (int l = -1; l <= 1; l++) {
        vec3 c = i + vec3(float(l), float(j), float(k));
        vec3 fp = c + vec3(h3(c + 11.0 * per, per), h3(c + 23.0 * per, per), h3(c + 37.0 * per, per));
        vec3 d = fp - x;
        d2 = min(d2, dot(d, d));
      }
  return 1.0 - min(1.0, sqrt(d2));
}
void main() {
  vec3 p = vec3(vUv, (uSlice + 0.5) / ${CLOUD_NOISE_SIZE}.0);
  float f = 0.0;
  float a = 0.5;
  float amp = 0.0;
  for (int o = 0; o < 4; o++) {
    float per = 4.0 * exp2(float(o));
    f += a * vnoise(p * per, per);
    amp += a;
    a *= 0.5;
  }
  f /= amp;
  float w = 0.625 * worley(p * 4.0, 4.0) + 0.25 * worley(p * 8.0, 8.0) + 0.125 * worley(p * 16.0, 16.0);
  float pw = clamp((f - (1.0 - w) * 0.55) / (1.0 - (1.0 - w) * 0.55), 0.0, 1.0);
  gl_FragColor = vec4(0.55 * pw + 0.45 * w, 0.0, 0.0, 1.0);
}
`;

const CLOUD_COMMON = /* glsl */ `
uniform highp sampler3D uCloudNoise;
uniform vec3 uCloudWind;        // xz offset m, y = time s
uniform float uCloudCover;      // 0..1
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;         // colour × intensity
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform vec3 uCamPos;
const float CL_BASE = ${CLOUD_BASE_M.toFixed(1)};
const float CL_TOP = ${CLOUD_TOP_M.toFixed(1)};
const float CL_R = ${EARTH_R.toFixed(1)};

float clHeight(vec3 p) {
  // altitude above the curved ground (camera-centred planet)
  vec3 q = p - vec3(uCamPos.x, -CL_R, uCamPos.z);
  return length(q) - CL_R;
}
float clDensity(vec3 p, bool detail) {
  float h = (clHeight(p) - CL_BASE) / (CL_TOP - CL_BASE);
  if (h < 0.0 || h > 1.0) return 0.0;
  vec3 q = vec3(p.x + uCloudWind.x, p.y, p.z + uCloudWind.z);
  float base = texture(uCloudNoise, q * vec3(1.0 / 5200.0, 1.0 / 3400.0, 1.0 / 5200.0)).r;
  float cov = mix(0.2, 0.98, uCloudCover);
  // cumulus profile: flat base, rounded tops, taller where the field is denser
  float prof = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.45 + 0.4 * base, h);
  float d = clamp((base * prof - (1.0 - cov)) / max(cov, 0.05), 0.0, 1.0);
  if (detail && d > 0.0) {
    float e = texture(uCloudNoise, q * (1.0 / 780.0) + vec3(0.0, uCloudWind.y * 0.004, 0.0)).r;
    d = clamp(d - (1.0 - d) * e * 0.55, 0.0, 1.0);
  }
  return d;
}
float clHG(float c, float g) {
  float k = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (12.566371 * k * sqrt(k));
}
`;

const PANO_FRAGMENT = /* glsl */ `
${CLOUD_COMMON}
uniform float uFrame;
uniform float uElMin;
varying vec2 vUv;
const int STEPS = CL_STEPS;
const int LSTEPS = CL_LSTEPS;
float clRaySphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r * r;
  float h = b * b - cc;
  if (h < 0.0) return -1.0;
  return -b + sqrt(h);
}
void main() {
  float az = (vUv.x - 0.5) * 6.2831853;
  float el = uElMin + vUv.y * vUv.y * (1.5707963 - uElMin);
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 ro = uCamPos;
  vec3 pc = vec3(uCamPos.x, -CL_R, uCamPos.z);
  float t0 = clRaySphere(ro, rd, pc, CL_R + CL_BASE);
  float t1 = clRaySphere(ro, rd, pc, CL_R + CL_TOP);
  if (t0 < 0.0 || rd.y < -0.02) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, t0 + 24000.0);
  float dt = (t1 - t0) / float(STEPS);
  // per-texel jitter, decorrelated each refresh (no banding)
  float jit = fract(sin(dot(vUv * 913.17 + uFrame * 0.618, vec2(12.9898, 78.233))) * 43758.5453);
  float cosT = dot(rd, uKeyDir);
  float phase = mix(clHG(cosT, 0.72), clHG(cosT, -0.25), 0.3);
  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < STEPS; i++) {
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = ro + rd * t;
    float d = clDensity(p, true);
    if (d <= 0.0) continue;
    float sigma = d * 0.075;
    // light march toward the key light
    float tau = 0.0;
    for (int j = 0; j < LSTEPS; j++) {
      vec3 lp = p + uKeyDir * (float(j) + 0.5) * 140.0;
      tau += clDensity(lp, false) * 0.075 * 140.0;
    }
    float h = clamp((clHeight(p) - CL_BASE) / (CL_TOP - CL_BASE), 0.0, 1.0);
    float beer = exp(-tau);
    float powder = 1.0 - exp(-2.0 * tau - 0.3);
    vec3 direct = uKeyColor * (beer * mix(1.0, powder, 0.6)) * phase * 5.0 * (LSTEPS > 0 ? 1.0 : 0.6 + 0.4 * h);
    vec3 amb = mix(uAmbBottom, uAmbTop, h) * (0.45 + 0.55 * h);
    float a = 1.0 - exp(-sigma * dt);
    L += T * a * (direct + amb);
    T *= 1.0 - a;
    if (T < 0.015) break;
  }
  // aerial perspective: far clouds fade into the sky behind them
  float fade = exp(-max(t0 - 6000.0, 0.0) / 30000.0);
  gl_FragColor = vec4(L * fade, mix(1.0, T, fade));
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
${CLOUD_COMMON}
uniform vec4 uShadowRect; // origin x, origin z, span, 0
varying vec2 vUv;
void main() {
  vec3 g = vec3(uShadowRect.x + vUv.x * uShadowRect.z, uCamPos.y, uShadowRect.y + vUv.y * uShadowRect.z);
  float ky = max(uKeyDir.y, 0.08);
  float tau = 0.0;
  for (int i = 0; i < 6; i++) {
    float alt = mix(CL_BASE, CL_TOP, (float(i) + 0.5) / 6.0);
    vec3 p = g + uKeyDir / ky * (alt - g.y);
    tau += clDensity(p, false) * 0.045 * (CL_TOP - CL_BASE) / 6.0;
  }
  gl_FragColor = vec4(exp(-tau * 0.55), 0.0, 0.0, 1.0);
}
`;


/** Panorama lookup for the sky dome / IBL (needs uniform uCloudPano, uCloudElMin). */
export const CLOUD_PANO_LOOKUP = /* glsl */ `
uniform sampler2D uCloudPano;
uniform float uCloudElMin;
uniform float uCloudOn;
vec4 crumpleClouds(vec3 d) {
  if (uCloudOn < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  float el = asin(clamp(d.y, -1.0, 1.0));
  if (el < uCloudElMin) return vec4(0.0, 0.0, 0.0, 1.0);
  float v = sqrt(clamp((el - uCloudElMin) / (1.5707963 - uCloudElMin), 0.0, 1.0));
  float u = atan(d.z, d.x) * 0.15915494 + 0.5;
  vec4 c = texture2D(uCloudPano, vec2(u, v));
  // fade the layer in above its lowest row (no hard cut at the panorama edge)
  float k = smoothstep(uCloudElMin, uCloudElMin + 0.02, el);
  return vec4(c.rgb * k, mix(1.0, c.a, k));
}
`;

export interface CloudFrame {
  camPos: Vector3;
  keyDir: Vector3;
  /** Key light colour × intensity (sun or moon, after the atmosphere). */
  keyColor: Vector3;
  ambTop: Vector3;
  ambBottom: Vector3;
  cover: number;
  /** Seconds (wind). */
  time: number;
}

export interface CloudSystem {
  /** Uniforms the sky dome / IBL materials merge (panorama + switches). */
  readonly domeUniforms: { uCloudPano: { value: Texture | null }; uCloudElMin: { value: number }; uCloudOn: { value: number } };
  readonly shadowTexture: Texture;
  /** World rect of the shadow map: origin x, origin z, 1/span, coverage mean (outside the map). */
  readonly shadowRect: Vector4;
  setQuality(level: QualityLevel): void;
  update(renderer: WebGLRenderer, f: CloudFrame): void;
  readonly stats: { panoramaRenders: number; shadowRenders: number };
  dispose(): void;
}

export function createCloudSystem(level: QualityLevel): CloudSystem {
  const N = CLOUD_NOISE_SIZE;
  const noiseRT = new WebGL3DRenderTarget(N, N, N, { format: RedFormat, type: UnsignedByteType, depthBuffer: false, generateMipmaps: false });
  const noise = noiseRT.texture;
  noise.minFilter = LinearFilter;
  noise.magFilter = LinearFilter;
  noise.wrapS = noise.wrapT = noise.wrapR = RepeatWrapping;
  let noiseReady = false;
  const noiseMat = new ShaderMaterial({ name: 'crumple.clouds.noise', uniforms: { uSlice: { value: 0 } }, vertexShader: QUAD_VERTEX, fragmentShader: NOISE_FRAGMENT, depthTest: false, depthWrite: false });

  const quadGeo = new BufferGeometry();
  quadGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new Mesh(quadGeo);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const shared = {
    uCloudNoise: { value: noise },
    uCloudWind: { value: new Vector3() },
    uCloudCover: { value: 0.3 },
    uKeyDir: { value: new Vector3(0, 1, 0) },
    uKeyColor: { value: new Vector3(1, 1, 1) },
    uAmbTop: { value: new Vector3(0.3, 0.35, 0.45) },
    uAmbBottom: { value: new Vector3(0.1, 0.1, 0.1) },
    uCamPos: { value: new Vector3() },
  };
  const EL_MIN = -0.03;
  let q = CLOUD_QUALITY[level];
  const makePano = (): { rt: WebGLRenderTarget; mat: ShaderMaterial } => {
    const rt = new WebGLRenderTarget(q.panorama[0], q.panorama[1], {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.wrapS = RepeatWrapping;
    rt.texture.wrapT = ClampToEdgeWrapping;
    const mat = new ShaderMaterial({
      name: 'crumple.clouds.panorama',
      uniforms: { ...shared, uFrame: { value: 0 }, uElMin: { value: EL_MIN } },
      defines: { CL_STEPS: q.steps, CL_LSTEPS: q.lightSteps },
      vertexShader: QUAD_VERTEX,
      fragmentShader: PANO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    return { rt, mat };
  };
  let pano = makePano();
  const shadowRT = new WebGLRenderTarget(CLOUD_SHADOW_SIZE, CLOUD_SHADOW_SIZE, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  shadowRT.texture.wrapS = shadowRT.texture.wrapT = ClampToEdgeWrapping;
  const shadowMat = new ShaderMaterial({
    name: 'crumple.clouds.shadow',
    uniforms: { ...shared, uShadowRect: { value: new Vector4() } },
    vertexShader: QUAD_VERTEX,
    fragmentShader: SHADOW_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const domeUniforms = { uCloudPano: { value: pano.rt.texture as Texture | null }, uCloudElMin: { value: EL_MIN }, uCloudOn: { value: 1 } };
  const shadowRect = new Vector4(0, 0, 1 / CLOUD_SHADOW_SPAN_M, 1);
  const stats = { panoramaRenders: 0, shadowRenders: 0 };
  let frame = 0;
  let lastCover = -1;
  const shadowOrigin = new Vector2();

  const render = (renderer: WebGLRenderer, mat: ShaderMaterial, rt: WebGLRenderTarget): void => {
    const prev = renderer.getRenderTarget();
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  };

  return {
    domeUniforms,
    shadowTexture: shadowRT.texture,
    shadowRect,
    stats,
    setQuality(lv) {
      const nq = CLOUD_QUALITY[lv];
      if (nq === q) return;
      q = nq;
      pano.rt.dispose();
      pano.mat.dispose();
      pano = makePano();
      domeUniforms.uCloudPano.value = pano.rt.texture;
      frame = 0;
    },
    update(renderer, f) {
      if (!noiseReady) {
        // one draw per slice of the 3D target, once
        const prev = renderer.getRenderTarget();
        quad.material = noiseMat;
        for (let z = 0; z < N; z++) {
          noiseMat.uniforms.uSlice!.value = z;
          renderer.setRenderTarget(noiseRT, z);
          renderer.render(scene, cam);
        }
        renderer.setRenderTarget(prev);
        noiseReady = true;
      }
      shared.uCamPos.value.copy(f.camPos);
      shared.uKeyDir.value.copy(f.keyDir);
      shared.uKeyColor.value.copy(f.keyColor);
      shared.uAmbTop.value.copy(f.ambTop);
      shared.uAmbBottom.value.copy(f.ambBottom);
      shared.uCloudCover.value = f.cover;
      // wind: ~9 m/s from the west-south-west, slowly veering
      const wa = 0.35 + 0.15 * Math.sin(f.time * 0.0021);
      shared.uCloudWind.value.set(f.time * 9 * Math.cos(wa), f.time, f.time * 9 * Math.sin(wa));
      domeUniforms.uCloudOn.value = f.cover > 0.02 ? 1 : 0;
      const coverJump = Math.abs(f.cover - lastCover) > 0.05;
      if (frame % q.period === 0 || coverJump) {
        pano.mat.uniforms.uFrame!.value = frame;
        render(renderer, pano.mat, pano.rt);
        stats.panoramaRenders++;
      }
      if (frame % (q.period * 2) === 1 || coverJump) {
        const texel = CLOUD_SHADOW_SPAN_M / CLOUD_SHADOW_SIZE;
        shadowOrigin.set(Math.floor((f.camPos.x - CLOUD_SHADOW_SPAN_M / 2) / texel) * texel, Math.floor((f.camPos.z - CLOUD_SHADOW_SPAN_M / 2) / texel) * texel);
        (shadowMat.uniforms.uShadowRect!.value as Vector4).set(shadowOrigin.x, shadowOrigin.y, CLOUD_SHADOW_SPAN_M, 0);
        render(renderer, shadowMat, shadowRT);
        shadowRect.set(shadowOrigin.x, shadowOrigin.y, 1 / CLOUD_SHADOW_SPAN_M, 1 - 0.75 * f.cover * f.cover);
        stats.shadowRenders++;
      }
      lastCover = f.cover;
      frame++;
    },
    dispose() {
      noiseRT.dispose();
      noiseMat.dispose();
      pano.rt.dispose();
      pano.mat.dispose();
      shadowRT.dispose();
      shadowMat.dispose();
      quadGeo.dispose();
    },
  };
}
