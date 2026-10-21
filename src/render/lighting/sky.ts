/**
 * GPU side of the physically based sky (Hillaire 2020).
 *
 *  - transmittance LUT (256×64) and multiple-scattering LUT (32×32), once;
 *  - sky-view LUT (192×108), re-rendered when the sun moves (> 0.02°) or the
 *    camera altitude changes (> 25 m) — a few hundred µs of GPU;
 *  - sky dome (scene object): LUT radiance × solar illuminance + sun disc
 *    (limb darkened, transmittance-coloured), moon (phase-lit, maria), star
 *    field (equal-area cells, pixel-footprint widened so stars never alias),
 *    Milky Way band, all fading with the sky's own brightness;
 *  - IBL: the dome without discs, a lit ground hemisphere below the horizon,
 *    captured into a cube (64–256 px) and PMREM-filtered into ONE persistent
 *    target (scene.environment keeps the same texture object: no recompiles);
 *  - a 8×1 float probe of sky radiance (zenith, horizon by azimuth, hemisphere
 *    mean) read back asynchronously for CPU consumers (fog colour of unpatched
 *    materials, FX ambient, IBL ground).
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CubeCamera,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PMREMGenerator,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
} from 'three';
import type { Texture, TextureDataType, WebGLRenderer, Wrapping } from 'three';

import { ATMOSPHERE } from './atmosphere';
import { CLOUD_PANO_LOOKUP } from './clouds';
import { readPixelsAsync } from '../readback';
import { ENV_UNIFORMS, SKY_PARS_FRAGMENT } from './envPatch';
import {
  ATMO_COMMON,
  LUT_VERTEX,
  MULTISCAT_FRAGMENT,
  MULTISCAT_LUT_SIZE,
  SKYVIEW_FRAGMENT,
  SKYVIEW_LUT_SIZE,
  TRANSMITTANCE_FRAGMENT,
  TRANSMITTANCE_LUT_SIZE,
} from './sky.glsl';

/** Sun disc radiance multiplier (× transmittance): bright enough to bloom, finite in HalfFloat. */
export const SUN_DISC_RADIANCE = 60;
/** Moon disc radiance at full illumination (night exposure lifts it). */
export const MOON_DISC_RADIANCE = 0.16;

export interface SkyFrameState {
  sunDir: Vector3;
  moonDir: Vector3;
  /** Camera altitude above the valley datum, m. */
  cameraAltitude: number;
  /** 0..1 star visibility (night × clear sky). */
  starVisibility: number;
  /** Moon illuminated fraction 0..1. */
  moonIllumination: number;
  /** Seconds, for twinkle. */
  time: number;
  /** IBL ground radiance (linear rgb). */
  ground: Vector3;
}

export interface SkyProbe {
  /** L2 SH of the sky radiance, 9 × rgb (haze colour of world-lit materials). */
  sh: [number, number, number][];
  zenith: [number, number, number];
  /** Horizon (3° elevation) toward the sun, its right, away, its left. */
  horizon: [number, number, number][];
  /** Cosine-weighted mean radiance of the upper hemisphere (E_sky / π). */
  hemisphere: [number, number, number];
  /** Mean horizon radiance over all azimuths. */
  horizonMean: [number, number, number];
  /** Frames since boot when it was read (−1 = estimate). */
  age: number;
}

function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

function lutTarget(w: number, h: number, wrapS: Wrapping = ClampToEdgeWrapping, type: TextureDataType = HalfFloatType): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(w, h, {
    type,
    format: RGBAFormat,
    magFilter: type === FloatType ? NearestFilter : LinearFilter,
    minFilter: type === FloatType ? NearestFilter : LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.wrapS = wrapS;
  rt.texture.wrapT = ClampToEdgeWrapping;
  return rt;
}

const DOME_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

function domeFragment(ibl: boolean): string {
  return /* glsl */ `
${ibl ? '#define SKY_IBL' : ''}
#include <common>
${ATMO_COMMON}
${SKY_PARS_FRAGMENT}
uniform sampler2D uTransmittance;
uniform float uSunDisc;
uniform float uMoonDisc;
uniform float uStarVis;
uniform float uTime;
uniform mat3 crumpleStarRot;
uniform vec3 uGround;
varying vec3 vDir;
${CLOUD_PANO_LOOKUP}

float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec4 h42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + 113.0 * i.z;
  float a = fract(sin(n) * 43758.5453), b = fract(sin(n + 1.0) * 43758.5453);
  float c = fract(sin(n + 57.0) * 43758.5453), d = fract(sin(n + 58.0) * 43758.5453);
  float e = fract(sin(n + 113.0) * 43758.5453), g = fract(sin(n + 114.0) * 43758.5453);
  float h = fract(sin(n + 170.0) * 43758.5453), k = fract(sin(n + 171.0) * 43758.5453);
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

#ifndef SKY_IBL
// Equal-area star cells on the celestial sphere; each pixel looks at its cell and the 8 neighbours.
vec3 starField(vec3 d, float pxAng) {
  vec3 s = transpose(crumpleStarRot) * d;
  const float N = 260.0;
  float lon = atan(s.y, s.x) * 0.15915494 + 0.5;
  vec2 g = vec2(lon * N * 2.0, (s.z * 0.5 + 0.5) * N);
  vec2 cell = floor(g);
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      c.x = mod(c.x, N * 2.0);
      vec4 h = h42(c);
      if (h.x > 0.42) continue;
      vec2 sp = c + h.yz;
      float sl = (sp.x / (N * 2.0) - 0.5) * 6.2831853;
      float sz = sp.y / N * 2.0 - 1.0;
      float sr = sqrt(max(0.0, 1.0 - sz * sz));
      vec3 sd = vec3(sr * cos(sl), sr * sin(sl), sz);
      float a2 = max(0.0, 2.0 - 2.0 * dot(s, sd));
      float mag = pow(h.w, 9.0) * 1.6 + h.w * 0.02;
      float r = max(0.00025, 0.75 * pxAng);
      float k = exp(-a2 / (r * r)) * (0.00025 * 0.00025) / (r * r);
      float tw = 0.78 + 0.22 * sin(uTime * (2.0 + 9.0 * h.y) + 40.0 * h.z);
      vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.78, 0.86, 1.0), h.y);
      acc += tint * mag * k * tw;
    }
  }
  // Milky Way: a soft band about the galactic equator, mottled by noise
  const vec3 GP = vec3(-0.868, -0.2, 0.456);
  float b = dot(s, GP);
  float band = exp(-b * b / 0.035) * (0.35 + 0.65 * vnoise(s * 7.0)) * (0.6 + 0.4 * vnoise(s * 23.0));
  acc += vec3(0.75, 0.82, 1.0) * band * 0.0012;
  return acc * 0.03;
}
#endif

void main() {
  vec3 d = normalize(vDir);
  vec3 sky = crumpleSkyRadiance(d);
  vec4 cl = crumpleClouds(d);
#ifdef SKY_IBL
  sky = sky * cl.a + cl.rgb;
  float g = smoothstep(0.0, -0.08, d.y);
  sky = mix(sky, uGround, g);
#else
  vec3 view = vec3(0.0, crumpleSkyHeight, 0.0);
  // clouds over the sky; the sun / moon / stars below shine through their transmittance
  sky = sky * cl.a + cl.rgb;
  float clear = (1.0 - crumpleOvercast.a) * cl.a;
  float pxAng = max(length(fwidth(d)), 1e-6);
  // sun disc (limb darkened, coloured by the transmittance along the view ray)
  float ang = acos(clamp(dot(d, crumpleSunDir), -1.0, 1.0));
  const float SUN_R = 0.004654;
  float disc = 1.0 - smoothstep(SUN_R - pxAng, SUN_R + pxAng, ang);
  if (disc > 0.0) {
    float r = clamp(ang / SUN_R, 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - r * r));
    vec3 T = texture2D(uTransmittance, atmoLutUv(view, crumpleSunDir)).rgb;
    sky += T * uSunDisc * limb * disc * clear;
  }
  // moon: a lit sphere (phase from the sun direction), maria from noise, faint earthshine
  float am = acos(clamp(dot(d, crumpleMoonDir), -1.0, 1.0));
  const float MOON_R = 0.0046;
  if (am < MOON_R + 2.0 * pxAng) {
    vec3 w = crumpleMoonDir;
    vec3 u = normalize(cross(w, abs(w.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 v = cross(u, w);
    vec2 q = vec2(dot(d, u), dot(d, v)) / sin(MOON_R);
    float r2 = dot(q, q);
    float edge = 1.0 - smoothstep(1.0 - pxAng / MOON_R, 1.0 + pxAng / MOON_R, sqrt(r2));
    vec3 n = q.x * u + q.y * v - sqrt(max(0.0, 1.0 - r2)) * w;
    float lit = max(dot(n, crumpleSunDir), 0.0);
    vec3 mp = vec3(q * 2.2, 3.7);
    float maria = smoothstep(0.45, 0.7, vnoise(mp * 1.3) * 0.65 + vnoise(mp * 3.1) * 0.35);
    float albedo = 0.82 - 0.32 * maria - 0.08 * vnoise(mp * 9.0);
    vec3 T = texture2D(uTransmittance, atmoLutUv(view, crumpleMoonDir)).rgb;
    vec3 moon = uMoonDisc * T * (lit * albedo + 0.006) * vec3(1.0, 0.97, 0.92);
    sky = mix(sky, sky * (1.0 - clear) + moon * clear + sky * clear * 0.15, edge);
  }
  // stars fade with the sky's own brightness (and hide behind the overcast)
  if (uStarVis > 0.0 && d.y > -0.02) {
    float skyL = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    float vis = uStarVis * clear * (1.0 - smoothstep(0.004, 0.03, skyL)) * smoothstep(-0.02, 0.18, d.y);
    if (vis > 0.0) sky += starField(d, pxAng) * vis;
  }
#endif
  gl_FragColor = vec4(sky * crumpleEnvIntensity, 1.0);
}
`;
}

/** Probe texels: 0–8 SH L2 coefficients (rgb), 9 zenith, 10–13 horizon (toward the sun, right, away, left), 14 hemisphere mean, 15 horizon mean. */
export const PROBE_TEXELS = 16;
const PROBE_FRAGMENT = /* glsl */ `
#include <common>
${SKY_PARS_FRAGMENT}
varying vec2 vUv;
vec3 horizonAt(float az) {
  vec3 s = vec3(crumpleSunDir.x, 0.0, crumpleSunDir.z);
  float sl = length(s);
  vec3 fwd = sl > 1e-4 ? s / sl : vec3(0.0, 0.0, -1.0);
  vec3 right = vec3(-fwd.z, 0.0, fwd.x);
  vec3 d = normalize(fwd * cos(az) + right * sin(az) + vec3(0.0, 0.0524, 0.0));
  return crumpleSkyRadiance(d);
}
float shBasis(int i, vec3 d) {
  if (i == 0) return 0.282095;
  if (i == 1) return 0.488603 * d.y;
  if (i == 2) return 0.488603 * d.z;
  if (i == 3) return 0.488603 * d.x;
  if (i == 4) return 1.092548 * d.x * d.y;
  if (i == 5) return 1.092548 * d.y * d.z;
  if (i == 6) return 0.315392 * (3.0 * d.z * d.z - 1.0);
  if (i == 7) return 1.092548 * d.x * d.z;
  return 0.546274 * (d.x * d.x - d.y * d.y);
}
void main() {
  int i = int(floor(vUv.x * ${PROBE_TEXELS}.0));
  vec3 c = vec3(0.0);
  if (i < 9) {
    // projection over the sphere (lat-long grid, solid-angle weighted); below the horizon = horizon colour
    const int NT = 16;
    const int NP = 32;
    float dw = (3.14159265 / float(NT)) * (6.2831853 / float(NP));
    for (int t = 0; t < NT; t++) {
      float th = (float(t) + 0.5) / float(NT) * 3.14159265;
      float st = sin(th);
      for (int p = 0; p < NP; p++) {
        float ph = (float(p) + 0.5) / float(NP) * 6.2831853;
        vec3 d = vec3(st * cos(ph), cos(th), st * sin(ph));
        c += crumpleSkyRadiance(d) * shBasis(i, d) * st * dw;
      }
    }
  } else if (i == 9) c = crumpleSkyRadiance(vec3(0.0, 1.0, 0.0));
  else if (i <= 13) c = horizonAt(float(i - 10) * 1.5707963);
  else if (i == 14) {
    // cosine-weighted hemisphere mean: 4 rings × 8 azimuths
    float wsum = 0.0;
    for (int r = 0; r < 4; r++) {
      float el = (float(r) + 0.5) / 4.0 * 1.5707963;
      for (int a = 0; a < 8; a++) {
        float az = float(a) / 8.0 * 6.2831853;
        vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
        float w = sin(el) * cos(el);
        c += crumpleSkyRadiance(d) * w;
        wsum += w;
      }
    }
    c /= wsum;
  } else {
    for (int a = 0; a < 8; a++) c += horizonAt(float(a) / 8.0 * 6.2831853);
    c /= 8.0;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

export interface SkySystem {
  readonly dome: Mesh;
  /** PMREM of the current sky (scene.environment); the same texture object for the stack's life. */
  readonly environment: Texture;
  readonly probe: SkyProbe;
  /** Re-renders the sky-view LUT when the sun / camera altitude moved; updates the dome uniforms. */
  update(state: SkyFrameState): void;
  /** Re-captures the IBL from the current sky (cube + PMREM). */
  captureEnvironment(): void;
  /** IBL cube face size (preset dependent; re-allocates). */
  setEnvironmentSize(size: number): void;
  /** Requests an async probe readback (resolves into `probe`). */
  readProbe(): void;
  readonly stats: { lutRenders: number; iblCaptures: number; probeReads: number };
  dispose(): void;
}

export function createSkySystem(renderer: WebGLRenderer, opts: { envSize?: number; cloudUniforms?: Record<string, { value: unknown }> } = {}): SkySystem {
  const quad = new Mesh(fullscreenTriangle());
  quad.frustumCulled = false;
  const quadScene = new Scene();
  quadScene.add(quad);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const tRT = lutTarget(TRANSMITTANCE_LUT_SIZE[0], TRANSMITTANCE_LUT_SIZE[1]);
  const mRT = lutTarget(MULTISCAT_LUT_SIZE, MULTISCAT_LUT_SIZE);
  const sRT = lutTarget(SKYVIEW_LUT_SIZE[0], SKYVIEW_LUT_SIZE[1], RepeatWrapping);
  const probeRT = lutTarget(PROBE_TEXELS, 1, ClampToEdgeWrapping, FloatType);

  const tMat = new ShaderMaterial({ name: 'crumple.sky.transmittance', vertexShader: LUT_VERTEX, fragmentShader: TRANSMITTANCE_FRAGMENT, depthTest: false, depthWrite: false });
  const mMat = new ShaderMaterial({
    name: 'crumple.sky.multiscat',
    uniforms: { uTransmittance: { value: tRT.texture } },
    vertexShader: LUT_VERTEX,
    fragmentShader: MULTISCAT_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const sMat = new ShaderMaterial({
    name: 'crumple.sky.view',
    uniforms: {
      uTransmittance: { value: tRT.texture },
      uMultiScat: { value: mRT.texture },
      uViewHeight: { value: ENV_UNIFORMS.crumpleSkyHeight.value },
      uSunElevation: { value: 0.5 },
    },
    vertexShader: LUT_VERTEX,
    fragmentShader: SKYVIEW_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const pMat = new ShaderMaterial({ name: 'crumple.sky.probe', uniforms: { ...ENV_UNIFORMS }, vertexShader: LUT_VERTEX, fragmentShader: PROBE_FRAGMENT, depthTest: false, depthWrite: false });

  const renderQuad = (mat: ShaderMaterial, rt: WebGLRenderTarget): void => {
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    quad.material = mat;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.render(quadScene, ortho);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  };
  renderQuad(tMat, tRT);
  renderQuad(mMat, mRT);
  ENV_UNIFORMS.crumpleSkyView.value = sRT.texture;

  const domeUniforms = (): Record<string, { value: unknown }> => ({
    ...ENV_UNIFORMS,
    uTransmittance: { value: tRT.texture },
    uSunDisc: { value: SUN_DISC_RADIANCE },
    uMoonDisc: { value: MOON_DISC_RADIANCE },
    uStarVis: { value: 0 },
    uTime: { value: 0 },
    uGround: { value: new Vector3(0.02, 0.022, 0.016) },
    uCloudPano: { value: null },
    uCloudElMin: { value: 0 },
    uCloudOn: { value: 0 },
    ...(opts.cloudUniforms ?? {}),
  });
  const makeDome = (ibl: boolean): Mesh<BoxGeometry, ShaderMaterial> => {
    const material = new ShaderMaterial({
      name: ibl ? 'crumple.sky.ibl' : 'crumple.sky',
      side: BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: domeUniforms(),
      vertexShader: DOME_VERTEX,
      fragmentShader: domeFragment(ibl),
    });
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
    mesh.name = material.name;
    mesh.frustumCulled = false;
    // drawn LAST among the opaques: its fragments sit on the far plane, so the depth test leaves only
    // the visible sky to shade (the IBL capture renders it alone)
    mesh.renderOrder = 1e6;
    mesh.scale.setScalar(10);
    return mesh;
  };
  const dome = makeDome(false);
  const iblDome = makeDome(true);
  const iblScene = new Scene();
  iblScene.add(iblDome);

  let envSize = opts.envSize ?? 128;
  let cubeRT = new WebGLCubeRenderTarget(envSize, { type: HalfFloatType, generateMipmaps: false });
  let cubeCam = new CubeCamera(0.1, 100, cubeRT);
  iblScene.add(cubeCam);
  const pmrem = new PMREMGenerator(renderer);
  let envRT: WebGLRenderTarget | null = null;

  const stats = { lutRenders: 0, iblCaptures: 0, probeReads: 0 };
  const probe: SkyProbe = {
    sh: Array.from({ length: 9 }, (_, i): [number, number, number] => (i === 0 ? [1.2, 1.4, 1.7] : [0, 0, 0])),
    zenith: [0.3, 0.45, 0.8],
    horizon: [
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
    ],
    hemisphere: [0.3, 0.4, 0.6],
    horizonMean: [0.45, 0.5, 0.55],
    age: -1,
  };

  let lastSunY = Number.NaN;
  let lastHeight = Number.NaN;
  let frame = 0;
  let reading = false;
  const probeBuf = new Float32Array(PROBE_TEXELS * 4);

  const capture = (): void => {
    const prevTarget = renderer.getRenderTarget();
    cubeCam.update(renderer, iblScene);
    // first capture allocates the PMREM target; later ones reuse it (same texture object)
    envRT = envRT ? pmrem.fromCubemap(cubeRT.texture, envRT) : pmrem.fromCubemap(cubeRT.texture);
    renderer.setRenderTarget(prevTarget);
    stats.iblCaptures++;
  };

  const sys: SkySystem = {
    dome,
    get environment() {
      if (!envRT) capture();
      return envRT!.texture;
    },
    probe,
    stats,
    update(state: SkyFrameState) {
      frame++;
      const h = ATMOSPHERE.groundRadius + (200 + Math.max(0, state.cameraAltitude)) * 1e-6;
      ENV_UNIFORMS.crumpleSkyHeight.value = h;
      ENV_UNIFORMS.crumpleSunDir.value.copy(state.sunDir);
      ENV_UNIFORMS.crumpleMoonDir.value.copy(state.moonDir);
      const sunY = state.sunDir.y;
      if (!(Math.abs(sunY - lastSunY) < 3.5e-4) || !(Math.abs(h - lastHeight) < 25e-6)) {
        lastSunY = sunY;
        lastHeight = h;
        const su = sMat.uniforms;
        su.uViewHeight!.value = h;
        su.uSunElevation!.value = Math.asin(Math.max(-1, Math.min(1, sunY)));
        renderQuad(sMat, sRT);
        stats.lutRenders++;
      }
      for (const m of [dome.material, iblDome.material]) {
        const u = m.uniforms;
        u.uStarVis!.value = state.starVisibility;
        u.uTime!.value = state.time;
        u.uMoonDisc!.value = MOON_DISC_RADIANCE * (0.25 + 0.75 * state.moonIllumination);
        (u.uGround!.value as Vector3).copy(state.ground);
      }
    },
    captureEnvironment: capture,
    setEnvironmentSize(size: number) {
      if (size === envSize) return;
      envSize = size;
      iblScene.remove(cubeCam);
      cubeRT.dispose();
      cubeRT = new WebGLCubeRenderTarget(envSize, { type: HalfFloatType, generateMipmaps: false });
      cubeCam = new CubeCamera(0.1, 100, cubeRT);
      iblScene.add(cubeCam);
      const old = envRT;
      envRT = null;
      capture();
      old?.dispose();
    },
    readProbe() {
      if (reading) return;
      reading = true;
      renderQuad(pMat, probeRT);
      const at = frame;
      readPixelsAsync(renderer, probeRT, 0, 0, PROBE_TEXELS, 1, probeBuf)
        .then((b) => {
          const px = (i: number): [number, number, number] => [b[i * 4]!, b[i * 4 + 1]!, b[i * 4 + 2]!];
          const ok = Array.from(b).every((x) => Number.isFinite(x));
          if (ok) {
            for (let k = 0; k < 9; k++) probe.sh[k] = px(k);
            probe.zenith = px(9);
            probe.horizon = [px(10), px(11), px(12), px(13)];
            probe.hemisphere = px(14);
            probe.horizonMean = px(15);
            probe.age = at;
            stats.probeReads++;
          }
        })
        .catch(() => {
          /* readback unsupported: keep the CPU estimate */
        })
        .finally(() => {
          reading = false;
        });
    },
    dispose() {
      for (const rt of [tRT, mRT, sRT, probeRT]) rt.dispose();
      for (const m of [tMat, mMat, sMat, pMat, dome.material, iblDome.material]) m.dispose();
      dome.geometry.dispose();
      iblDome.geometry.dispose();
      quad.geometry.dispose();
      cubeRT.dispose();
      envRT?.dispose();
      pmrem.dispose();
      if (ENV_UNIFORMS.crumpleSkyView.value === sRT.texture) ENV_UNIFORMS.crumpleSkyView.value = null;
    },
  };
  return sys;
}
