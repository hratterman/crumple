/**
 * Rain: GPU-animated streaks in a box that travels with the camera (drops
 * stay put in the world while the camera moves; the box wraps around it),
 * falling with the wind and stretched along their motion RELATIVE TO THE
 * CAMERA (driving into the rain slants the streaks toward the viewer).
 *
 * Lighting: the sky ambient, the key light, and — what makes night rain read
 * — the clustered light grid (streetlights, traffic lamps) and the player's
 * headlight cone (forward-scattering drops glow inside the beam). One
 * instanced draw, alpha-blended, no depth write, never in shadow passes or
 * the water's planar reflection. Count per preset (RAIN_DROPS); drops fade
 * in and out with the rain intensity (instances beyond `count` collapse).
 */
import {
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { PerspectiveCamera } from 'three';

import { ENV_UNIFORMS } from '../lighting/envPatch';
import { GRID_CELL_M, GRID_LIGHT_ROWS, GRID_N, GRID_TEX_W } from '../lighting/lightGrid';
import { LAYER_NO_REFLECTION, type QualityLevel } from '../types';

export const RAIN_DROPS: Readonly<Record<QualityLevel, number>> = { low: 1500, medium: 4000, high: 7000, ultra: 14000 };
/** Box around the camera, m (x/z half extent, height). */
export const RAIN_BOX = { half: 22, height: 26 } as const;
/** Terminal velocity of rain drops, m/s. */
export const RAIN_FALL_SPEED = 8.5;

const VERTEX = /* glsl */ `
attribute vec4 aSeed; // xyz in [0,1), w = size jitter
uniform vec3 uCam;
uniform vec3 uCamVel;
uniform vec3 uWind;
uniform float uTime;
uniform float uCount;
uniform float uHalf;
uniform float uHeight;
uniform float uStreak;
varying vec2 vUv;
varying vec3 vWorld;
varying float vFade;
void main() {
  float idx = float(gl_InstanceID);
  vec3 fall = vec3(uWind.x, -${RAIN_FALL_SPEED.toFixed(2)}, uWind.z);
  // world position of this drop, wrapped into the box around the camera
  vec3 box = vec3(2.0 * uHalf, uHeight, 2.0 * uHalf);
  vec3 p0 = aSeed.xyz * box + fall * uTime;
  vec3 base = uCam - vec3(uHalf, uHeight * 0.45, uHalf);
  vec3 wp = base + mod(p0 - base, box);
  // motion relative to the camera over the exposure → streak direction and length
  vec3 rel = fall - uCamVel;
  float rl = max(length(rel), 1e-3);
  vec3 sdir = rel / rl;
  float len = clamp(rl * uStreak, 0.12, 1.4) * (0.7 + 0.6 * aSeed.w);
  vec3 toCam = normalize(uCam - wp);
  vec3 side = normalize(cross(sdir, toCam) + vec3(1e-5));
  float dist = length(uCam - wp);
  // never thinner than ~0.7 px: far drops widen and fade (no sub-pixel shimmer)
  float px = dist * 0.0011;
  float w = max(0.0012 + 0.0008 * aSeed.w, px);
  vec3 pos = wp + side * position.x * w + sdir * position.y * len;
  vUv = position.xy;
  vWorld = pos;
  float alive = step(idx, uCount);
  vFade = alive * (0.0012 + 0.0008 * aSeed.w) / w * smoothstep(0.6, 2.5, dist) * (1.0 - smoothstep(uHalf * 0.7, uHalf, length((wp - uCam).xz)));
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  if (alive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uAmbient;
uniform vec3 uKeyColor;
uniform vec3 uCam;
uniform float uAlpha;
uniform vec4 uBeamPos;   // xyz, w = intensity (0 = off)
uniform vec4 uBeamDir;   // xyz, w = cos of the cone
uniform highp sampler2D crumpleLightGrid;
uniform vec2 crumpleGridOrigin;
uniform float crumpleLightGain;
varying vec2 vUv;
varying vec3 vWorld;
varying float vFade;
void main() {
  // a streak: soft across, tapered at both ends
  float across = 1.0 - abs(vUv.x);
  float along = smoothstep(-0.5, -0.2, vUv.y) * (1.0 - smoothstep(0.25, 0.5, vUv.y));
  float a = across * across * along * vFade * uAlpha;
  if (a < 0.002) discard;
  vec3 view = normalize(vWorld - uCam);
  vec3 col = uAmbient * 0.9 + uKeyColor * 0.04;
  // the player's headlight beam: drops scatter forward (toward the camera behind / beside the car)
  if (uBeamPos.w > 0.0) {
    vec3 l = vWorld - uBeamPos.xyz;
    float d = length(l);
    float c = dot(l / max(d, 1e-3), uBeamDir.xyz);
    float cone = smoothstep(uBeamDir.w, mix(uBeamDir.w, 1.0, 0.5), c);
    float fwd = 0.35 + 1.6 * pow(max(dot(view, l / max(d, 1e-3)), 0.0), 4.0);
    col += vec3(0.95, 0.97, 1.0) * uBeamPos.w * cone * fwd / max(d * d, 1.0) * 0.02;
  }
  // clustered lights (streetlights, traffic lamps)
  if (crumpleLightGain > 0.0) {
    vec2 g = (vWorld.xz - crumpleGridOrigin) / ${GRID_CELL_M}.0;
    if (g.x >= 0.0 && g.y >= 0.0 && g.x < ${GRID_N}.0 && g.y < ${GRID_N}.0) {
      ivec2 c = ivec2(floor(g));
      vec4 A = texelFetch(crumpleLightGrid, ivec2(c.x * 2, ${GRID_LIGHT_ROWS} + c.y), 0);
      vec4 B = texelFetch(crumpleLightGrid, ivec2(c.x * 2 + 1, ${GRID_LIGHT_ROWS} + c.y), 0);
      float ids[8] = float[8](A.x, A.y, A.z, A.w, B.x, B.y, B.z, B.w);
      for (int k = 0; k < 8; k++) {
        int id = int(ids[k] + 0.5) - 1;
        if (id < 0) break;
        ivec2 lt = ivec2((id * 4) % ${GRID_TEX_W}, (id * 4) / ${GRID_TEX_W});
        vec4 lp = texelFetch(crumpleLightGrid, lt, 0);
        vec3 lw = lp.xyz - vWorld;
        float ld = length(lw);
        if (ld >= lp.w) continue;
        vec4 lc = texelFetch(crumpleLightGrid, lt + ivec2(1, 0), 0);
        vec4 ls = texelFetch(crumpleLightGrid, lt + ivec2(2, 0), 0);
        vec3 ldir = lw / max(ld, 1e-3);
        float spot = ls.w < -1.5 ? 1.0 : smoothstep(ls.w, lc.w, dot(-ldir, ls.xyz));
        float fall = 1.0 - smoothstep(0.6 * lp.w, lp.w, ld);
        float fwd = 0.4 + 1.4 * pow(max(dot(view, -ldir), 0.0), 3.0);
        col += lc.rgb * spot * fall * fwd / max(ld * ld, 1.0) * 0.06 * crumpleLightGain;
      }
    }
  }
  gl_FragColor = vec4(col, a);
}
`;

export interface RainFrame {
  camera: PerspectiveCamera;
  /** Render dt, s (camera velocity → streak slant). */
  dtS: number;
  /** 0..1 rain intensity. */
  intensity: number;
  /** Wind (horizontal m/s). */
  wind: Vector3;
  time: number;
  ambient: Vector3;
  keyColor: Vector3;
  /** Player headlight beam (null when off). */
  beam: { pos: Vector3; dir: Vector3; intensity: number; cosOuter: number } | null;
}

export interface RainRenderer {
  readonly object: Mesh;
  setQuality(level: QualityLevel): void;
  update(f: RainFrame): void;
  dispose(): void;
}

export function createRain(level: QualityLevel): RainRenderer {
  const maxDrops = RAIN_DROPS.ultra;
  const geom = new InstancedBufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute([-1, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, -1, 0.5, 0], 3));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(maxDrops * 4);
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
  const seedAttr = new InstancedBufferAttribute(seeds, 4);
  seedAttr.setUsage(DynamicDrawUsage);
  geom.setAttribute('aSeed', seedAttr);
  geom.instanceCount = 0;

  const uniforms = {
    uCam: { value: new Vector3() },
    uCamVel: { value: new Vector3() },
    uWind: { value: new Vector3() },
    uTime: { value: 0 },
    uCount: { value: 0 },
    uHalf: { value: RAIN_BOX.half },
    uHeight: { value: RAIN_BOX.height },
    uStreak: { value: 1 / 50 },
    uAmbient: { value: new Vector3() },
    uKeyColor: { value: new Vector3() },
    uAlpha: { value: 0.5 },
    uBeamPos: { value: new Vector4() },
    uBeamDir: { value: new Vector4() },
    crumpleLightGrid: ENV_UNIFORMS.crumpleLightGrid,
    crumpleGridOrigin: ENV_UNIFORMS.crumpleGridOrigin,
    crumpleLightGain: ENV_UNIFORMS.crumpleLightGain,
  };
  const material = new ShaderMaterial({
    name: 'crumple.rain',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
  });
  const mesh = new Mesh(geom, material);
  mesh.name = 'crumple.rain';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 20;
  mesh.layers.set(LAYER_NO_REFLECTION);
  mesh.visible = false;
  let budget = RAIN_DROPS[level];
  const lastCam = new Vector3(Number.NaN, 0, 0);
  const camNow = new Vector3();
  const vel = new Vector3();
  const step = new Vector3();

  return {
    object: mesh,
    setQuality(lv) {
      budget = RAIN_DROPS[lv];
    },
    update(f) {
      const n = Math.round(budget * Math.min(1, f.intensity * 1.25));
      mesh.visible = n > 0;
      if (!mesh.visible) return;
      geom.instanceCount = n;
      uniforms.uCount.value = n;
      f.camera.getWorldPosition(camNow);
      if (f.dtS > 1e-4 && Number.isFinite(lastCam.x)) {
        // camera velocity, smoothed; a cut (> 30 m/frame) resets it
        const d = camNow.distanceTo(lastCam);
        if (d < 30) vel.lerp(step.subVectors(camNow, lastCam).divideScalar(f.dtS), Math.min(1, f.dtS * 8));
        else vel.set(0, 0, 0);
      }
      lastCam.copy(camNow);
      uniforms.uCam.value.copy(camNow);
      uniforms.uCamVel.value.copy(vel);
      uniforms.uWind.value.copy(f.wind);
      uniforms.uTime.value = f.time % 3600;
      uniforms.uAmbient.value.copy(f.ambient);
      uniforms.uKeyColor.value.copy(f.keyColor);
      uniforms.uAlpha.value = 0.28 + 0.3 * f.intensity;
      if (f.beam) {
        uniforms.uBeamPos.value.set(f.beam.pos.x, f.beam.pos.y, f.beam.pos.z, f.beam.intensity);
        uniforms.uBeamDir.value.set(f.beam.dir.x, f.beam.dir.y, f.beam.dir.z, f.beam.cosOuter);
      } else uniforms.uBeamPos.value.w = 0;
    },
    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
}
