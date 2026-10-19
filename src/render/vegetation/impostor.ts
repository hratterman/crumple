/**
 * Hemi-octahedral tree impostors, BAKED AT LOAD from the LOD0 meshes so the
 * far trees match the near ones: per tree variant an N×N grid of
 * orthographic views over the upper hemisphere (frame (i, j) ↔ direction
 * hemiOctDecode(i/(N−1), j/(N−1))), rendered in ONE instanced draw per
 * variant and pass (each instance = one frame, placed into its atlas cell
 * in the vertex stage). Two atlases: albedo (sRGB, × baked AO, alpha) and
 * normal (tree-local); both coverage-premultiplied. At runtime a camera-facing quad per
 * tree blends the 4 frames around the view direction (in the tree's own
 * yaw frame) and lights the stored normal with the regular PBR path, so
 * mesh ↔ impostor transitions keep the same lighting.
 */
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Texture, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';

import type { ShaderPatch } from '../types';
import type { VegMeshData } from './geometry';
import { VEG_DITHER_GLSL, type VegUniforms } from './shader';

export interface ImpostorAtlas {
  albedo: Texture;
  normal: Texture;
  /** Frames per side. */
  frames: number;
  cols: number;
  rows: number;
  /** Per variant: bounding-sphere centre height and radius (m, scale 1). */
  bounds: { centerY: number; radius: number }[];
  ms: number;
  dispose(): void;
}

const BAKE_VS = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;
in vec4 veg;
in float frame;
uniform float uN;
uniform float uCenterY;
uniform float uRadius;
uniform vec4 uRegion; // atlas uv origin of the variant, cell size
out vec2 vUv;
out vec3 vN;
out vec4 vVeg;
void main() {
  float j = floor((frame + 0.5) / uN);
  float i = frame - j * uN;
  vec2 f = vec2(i, j) / (uN - 1.0) * 2.0 - 1.0;
  vec3 d = vec3((f.x + f.y) * 0.5, 0.0, (f.x - f.y) * 0.5);
  d.y = max(0.0, 1.0 - abs(d.x) - abs(d.z));
  d = normalize(d);
  vec3 right = abs(d.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), d));
  vec3 up = cross(d, right);
  vec3 p = position - vec3(0.0, uCenterY, 0.0);
  vec3 q = vec3(dot(p, right), dot(p, up), -dot(p, d)) / uRadius;
  vec2 cell = uRegion.xy + vec2(i, j) * uRegion.zw;
  vec2 xy = cell + (q.xy * 0.5 + 0.5) * uRegion.zw;
  gl_Position = vec4(xy * 2.0 - 1.0, q.z, 1.0);
  vUv = uv;
  vN = normal;
  vVeg = veg;
}
`;
const BAKE_FS = /* glsl */ `
precision highp float;
uniform sampler2D tAlbedo;
uniform int uMode;
in vec2 vUv;
in vec3 vN;
in vec4 vVeg;
out vec4 outColor;
void main() {
  vec4 a = texture(tAlbedo, vUv);
  if (a.a < 0.42) discard;
  // Premultiplied by coverage (alpha 1 here, 0 where cleared): mips and the 4-frame blend divide it back out.
  if (uMode == 0) outColor = vec4(a.rgb * mix(0.3, 1.0, vVeg.y), 1.0);
  else outColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
}
`;

export interface BakeOptions {
  frames: number;
  framePx: number;
  cols: number;
  rows: number;
}

/** Bake every tree variant mesh (index = impostor variant id) into the two atlases. */
export function bakeImpostors(renderer: WebGLRenderer, meshes: readonly VegMeshData[], atlas: Texture, o: BakeOptions): ImpostorAtlas {
  const t0 = performance.now();
  const W = o.cols * o.frames * o.framePx;
  const H = o.rows * o.frames * o.framePx;
  const mk = (srgb: boolean): WebGLRenderTarget => {
    const rt = new WebGLRenderTarget(W, H, {
      depthBuffer: true,
      format: RGBAFormat,
      type: UnsignedByteType,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
    });
    rt.texture.colorSpace = srgb ? SRGBColorSpace : '';
    rt.texture.anisotropy = 4;
    return rt;
  };
  const rtA = mk(true);
  const rtN = mk(false);
  rtA.texture.name = 'veg-impostor-albedo';
  rtN.texture.name = 'veg-impostor-normal';

  const scene = new Scene();
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const n2 = o.frames * o.frames;
  const frameAttr = new InstancedBufferAttribute(new Float32Array(n2).map((_, i) => i), 1);
  const mats: RawShaderMaterial[] = [];
  const geos: InstancedBufferGeometry[] = [];
  const bounds: { centerY: number; radius: number }[] = [];
  meshes.forEach((m, v) => {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(m.position, 3));
    g.setAttribute('normal', new Float32BufferAttribute(m.normal, 3));
    g.setAttribute('uv', new Float32BufferAttribute(m.uv, 2));
    g.setAttribute('veg', new Float32BufferAttribute(m.veg, 4));
    g.setAttribute('frame', frameAttr);
    g.setIndex(Array.from(m.index));
    g.instanceCount = n2;
    const radius = m.radius * 1.02;
    bounds.push({ centerY: m.centerY, radius });
    const col = v % o.cols;
    const row = Math.floor(v / o.cols);
    const mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BAKE_VS,
      fragmentShader: BAKE_FS,
      side: DoubleSide,
      uniforms: {
        uN: { value: o.frames },
        uCenterY: { value: m.centerY },
        uRadius: { value: radius },
        uRegion: { value: new Vector4(col / o.cols, row / o.rows, 1 / (o.cols * o.frames), 1 / (o.rows * o.frames)) },
        tAlbedo: { value: atlas },
        uMode: { value: 0 },
      },
    });
    const mesh = new Mesh(g, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    mats.push(mat);
    geos.push(g);
  });

  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  try {
    for (const [rt, mode] of [
      [rtA, 0],
      [rtN, 1],
    ] as const) {
      for (const m of mats) m.uniforms.uMode!.value = mode;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(new Color(0, 0, 0), 0);
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.autoUpdate = prevShadow;
  }
  for (const m of mats) m.dispose();
  for (const g of geos) g.dispose();
  return {
    albedo: rtA.texture,
    normal: rtN.texture,
    frames: o.frames,
    cols: o.cols,
    rows: o.rows,
    bounds,
    ms: performance.now() - t0,
    dispose() {
      rtA.dispose();
      rtN.dispose();
    },
  };
}

/** Unit quad geometry for impostor billboards (position xy ∈ [−1, 1]). */
export function impostorQuad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * Runtime impostor patch (color only; impostors never cast). Uniforms:
 * tImpAlbedo / tImpNormal, uImp = (frames, cell du, cell dv, push toward
 * the camera in radii), uImpVar[v] = (centerY, radius, region u0, v0),
 * uVegFade (in band at the mesh distance, out band at the far cull).
 */
export function impostorPatch(atlas: ImpostorAtlas, u: VegUniforms, fade: { value: Vector4 }): ShaderPatch {
  const nVar = atlas.bounds.length;
  const varVec = atlas.bounds.map(
    (b, v) => new Vector4(b.centerY, b.radius, (v % atlas.cols) / atlas.cols, Math.floor(v / atlas.cols) / atlas.rows),
  );
  const uImp = new Vector4(atlas.frames, 1 / (atlas.cols * atlas.frames), 1 / (atlas.rows * atlas.frames), 0.35);
  return {
    key: `vegimp1-${nVar}-${atlas.frames}`,
    targets: ['color'],
    apply(shader: WebGLProgramParametersWithUniforms) {
      shader.uniforms.tImpAlbedo = { value: atlas.albedo };
      shader.uniforms.tImpNormal = { value: atlas.normal };
      shader.uniforms.uImp = { value: uImp };
      shader.uniforms.uImpVar = { value: varVec };
      shader.uniforms.uVegFade = fade;
      shader.uniforms.uVegSun = u.uVegSun;
      shader.uniforms.uVegSunCol = u.uVegSunCol;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 iA;
attribute vec4 iB;
uniform vec4 uImp;
uniform vec4 uImpVar[${nVar}];
uniform vec4 uVegFade;
varying vec2 vImpUv;
varying vec4 vImpCell;
varying vec2 vImpW;
varying vec2 vVegFade;
varying vec3 vImpRot;`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec4 vb = uImpVar[int(iB.z + 0.5)];
  float impS = iA.w;
  vec3 impC = iA.xyz + vec3(0.0, vb.x * impS, 0.0);
  float impR = vb.y * impS;
  vec3 toCam = cameraPosition - impC;
  float impDist = length(toCam);
  vec3 d = toCam / max(impDist, 1e-3);
  vec3 right = abs(d.y) > 0.999 ? vec3(iB.x, 0.0, iB.y) : normalize(cross(vec3(0.0, 1.0, 0.0), d));
  vec3 up = cross(d, right);
  vec3 transformed = impC + (right * position.x + up * position.y) * impR + d * (impR * uImp.w);
  vec3 dl = vec3(iB.x * d.x + iB.y * d.z, max(d.y, 0.0), -iB.y * d.x + iB.x * d.z);
  dl /= (abs(dl.x) + abs(dl.y) + abs(dl.z));
  vec2 g = (vec2(dl.x + dl.z, dl.x - dl.z) * 0.5 + 0.5) * (uImp.x - 1.0);
  vec2 g0 = clamp(floor(g), vec2(0.0), vec2(uImp.x - 2.0));
  vImpW = clamp(g - g0, 0.0, 1.0);
  vImpCell = vec4(g0, vb.zw);
  vImpUv = position.xy * 0.5 + 0.5;
  vImpRot = vec3(iB.x, iB.y, iB.w);
  float vegD = distance(cameraPosition, iA.xyz);
  vVegFade = vec2(smoothstep(uVegFade.x, uVegFade.y, vegD), 1.0 - smoothstep(uVegFade.z, uVegFade.w, vegD));`,
        );
      let f = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform sampler2D tImpAlbedo;
uniform sampler2D tImpNormal;
uniform vec4 uImp;
uniform vec3 uVegSun;
uniform vec3 uVegSunCol;
varying vec2 vImpUv;
varying vec4 vImpCell;
varying vec2 vImpW;
varying vec2 vVegFade;
varying vec3 vImpRot;
${VEG_DITHER_GLSL}`,
      );
      f = f.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  {
    float t = vegDither();
    if (vVegFade.y <= t || vVegFade.x < 1.0 - t) discard;
  }`,
      );
      f = f.replace(
        '#include <map_fragment>',
        `vec2 impCw = uImp.yz;
  vec2 impUv = vImpCell.zw + (vImpCell.xy + clamp(vImpUv, 0.004, 0.996)) * impCw;
  vec4 impW = vec4((1.0 - vImpW.x) * (1.0 - vImpW.y), vImpW.x * (1.0 - vImpW.y), (1.0 - vImpW.x) * vImpW.y, vImpW.x * vImpW.y);
  vec4 impA = texture2D(tImpAlbedo, impUv) * impW.x + texture2D(tImpAlbedo, impUv + vec2(impCw.x, 0.0)) * impW.y
    + texture2D(tImpAlbedo, impUv + vec2(0.0, impCw.y)) * impW.z + texture2D(tImpAlbedo, impUv + impCw) * impW.w;
  vec4 impN = texture2D(tImpNormal, impUv) * impW.x + texture2D(tImpNormal, impUv + vec2(impCw.x, 0.0)) * impW.y
    + texture2D(tImpNormal, impUv + vec2(0.0, impCw.y)) * impW.z + texture2D(tImpNormal, impUv + impCw) * impW.w;
  float seed = vImpRot.z;
  vec3 impTint = vec3(1.0 + (seed - 0.5) * 0.28, 1.0 + (fract(seed * 7.1) - 0.5) * 0.16, 1.0 - (seed - 0.5) * 0.3);
  // Both atlases are coverage-premultiplied (cleared to 0): un-premultiply after filtering + blending.
  diffuseColor *= vec4(impA.rgb / max(impA.a, 1e-3) * impTint, impA.a * 1.15);
  vec3 impNl = normalize(impN.xyz / max(impN.a, 1e-3) * 2.0 - 1.0);
  vec3 impNw = vec3(vImpRot.x * impNl.x - vImpRot.y * impNl.z, impNl.y, vImpRot.y * impNl.x + vImpRot.x * impNl.z);
  float impLeaf = 0.85;`,
      );
      f = f.replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
  vec3 normal = normalize((viewMatrix * vec4(impNw, 0.0)).xyz);
  vec3 nonPerturbedNormal = normal;`,
      );
      f = f.replace('#include <normal_fragment_maps>', '');
      f = f.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(0.9, 0.62, impLeaf);`,
      );
      f = f.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  {
    vec3 sunV = normalize((viewMatrix * vec4(uVegSun, 0.0)).xyz);
    float bl = max(dot(normalize(-vViewPosition), sunV), 0.0);
    bl = bl * bl * bl;
    totalEmissiveRadiance += diffuseColor.rgb * uVegSunCol * (bl * 0.28 + 0.035) * impLeaf;
  }`,
      );
      shader.fragmentShader = f;
    },
  };
}
