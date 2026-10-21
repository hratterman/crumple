/**
 * Vegetation shader patches. All vegetation meshes are plain Meshes with an
 * InstancedBufferGeometry (no instanceMatrix): per-instance attributes
 *   iA = (x, y, z, scale)            trunk foot / rock centre, world m
 *   iB = (cos yaw, sin yaw, variant, seed 0..1)
 * and the vertex stage places, rotates and sways each vertex. The patch is a
 * ShaderPatch handed to patchMaterial in the `flexbody` slot (a vertex-stage
 * deformation of color AND depth), so CSM shadows sway with the trees.
 *
 * Fade (color only): vVegFade = (fade-in, fade-out) from the camera distance
 * to the instance and uVegFade = (inStart, inEnd, outStart, outEnd); the
 * fragment discards against an interleaved-gradient dither so two LODs with
 * the same band edges are exact complements (dithered cross-fade).
 */
import { Vector3, Vector4 } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

import type { PatchTarget, ShaderPatch } from '../types';

/** Uniform objects shared by every vegetation material (one update per frame). */
export interface VegUniforms {
  /** (dir.x, dir.z, strength 0..1, time s). */
  uVegWind: { value: Vector4 };
  /** World unit vector toward the sun. */
  uVegSun: { value: Vector3 };
  /** Sun radiance (linear RGB × intensity) for leaf translucency. */
  uVegSunCol: { value: Vector3 };
}
export function createVegUniforms(): VegUniforms {
  return {
    uVegWind: { value: new Vector4(0.8, 0.6, 0.45, 0) },
    uVegSun: { value: new Vector3(0, 1, 0) },
    uVegSunCol: { value: new Vector3(1, 1, 1) },
  };
}

export type VegPatchKind = 'tree' | 'shrub' | 'rock';
export interface VegPatchOptions {
  kind: VegPatchKind;
  /** Merged multi-variant geometry: vertices whose `vvar` ≠ the instance variant collapse (zero area). */
  variantSelect: boolean;
  /** Per-material fade band uniform (color target only). */
  fade: { value: Vector4 };
  /** Tree bend amplitude at the crown top, m at scale 1 and full wind. */
  bend: number;
  /** > 0: the fade-out ends at min(uVegFade.w, sizeCull × iA.w) (small things vanish sooner), starting at 85 % of it. */
  sizeCull?: number;
}

/** Interleaved-gradient dither + fade discard (fragment). */
export const VEG_DITHER_GLSL = /* glsl */ `
float vegDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
`;

const WIND_GLSL = /* glsl */ `
uniform vec4 uVegWind;
float vegGust(vec3 ip, float ph) {
  vec2 wd = uVegWind.xy;
  float t = uVegWind.w;
  float a = sin(dot(ip.xz, wd) * 0.045 - t * 1.25 + ph * 0.3);
  float b = sin(dot(ip.xz, vec2(-wd.y, wd.x)) * 0.021 + t * 0.41 + ph);
  return 0.5 + 0.35 * a + 0.15 * b;
}
`;

function vertexHead(o: VegPatchOptions, color: boolean): string {
  return /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 veg;
${o.variantSelect ? 'attribute float vvar;' : ''}
${WIND_GLSL}
${color ? 'uniform vec4 uVegFade;\nvarying vec4 vVeg;\nvarying vec2 vVegFade;\nvarying vec3 vVegWorldN;\nvarying vec3 vVegWorldP;' : ''}
`;
}

function vertexBody(o: VegPatchOptions, color: boolean): string {
  const rock = o.kind === 'rock';
  return /* glsl */ `
  vec3 vegLocal = position;
  vec3 vegLn = normal;
  ${o.variantSelect ? 'bool vegKeep = abs(vvar - iB.z) < 0.5;' : 'bool vegKeep = true;'}
  float vegS = iA.w;
  float vegPh = iB.w * 6.2831853;
  ${
    rock
      ? `// Rocks: full random orientation from the seed (render only), slight vertical squash.
  float ra = iB.w * 6.2831853 * 3.0;
  vec3 rax = normalize(vec3(cos(ra), 0.35 * sin(ra * 1.7), sin(ra)));
  float rt = (fract(iB.w * 7.13) - 0.5) * 1.6;
  float rc = cos(rt), rs = sin(rt);
  vegLocal = vegLocal * rc + cross(rax, vegLocal) * rs + rax * dot(rax, vegLocal) * (1.0 - rc);
  vegLn = vegLn * rc + cross(rax, vegLn) * rs + rax * dot(rax, vegLn) * (1.0 - rc);`
      : ''
  }
  vec3 vegP = vec3(iB.x * vegLocal.x - iB.y * vegLocal.z, vegLocal.y, iB.y * vegLocal.x + iB.x * vegLocal.z) * vegS;
  vec3 vegN = vec3(iB.x * vegLn.x - iB.y * vegLn.z, vegLn.y, iB.y * vegLn.x + iB.x * vegLn.z);
  ${
    rock
      ? ''
      : `{
    float g = vegGust(iA.xyz, vegPh);
    float ws = uVegWind.z;
    vec2 wd = uVegWind.xy;
    float sway = veg.z;
    float osc = sin(uVegWind.w * 1.7 + vegPh) * 0.6 + sin(uVegWind.w * 2.9 + vegPh * 1.9) * 0.4;
    vec2 bend = wd * (ws * g * sway * ${o.bend.toFixed(3)}) + vec2(-wd.y, wd.x) * (osc * ws * sway * ${(o.bend * 0.3).toFixed(3)});
    vegP.xz += bend * vegS;
    vegP.y -= dot(bend, bend) * 0.15 * vegS;
    float fl = veg.w * veg.x * (0.25 + ws) * g;
    float ft = uVegWind.w * 6.5 + dot(vegLocal, vec3(1.9, 2.7, 1.3)) * 2.2 + vegPh;
    vegP += (vegN * sin(ft) + vec3(0.0, 0.5 * sin(ft * 1.37 + 1.0), 0.0)) * fl * ${o.kind === 'shrub' ? '0.05' : '0.07'} * vegS;
  }`
  }
  vec3 transformed = vegKeep ? vegP + iA.xyz : iA.xyz;
  ${
    color
      ? `float vegD = distance(cameraPosition, iA.xyz);
  vVegFade = vec2(smoothstep(uVegFade.x, uVegFade.y, vegD), 1.0 - smoothstep(uVegFade.z, uVegFade.w, vegD));
  ${
    o.sizeCull
      ? `float vegCull = min(uVegFade.w, ${o.sizeCull.toFixed(1)} * iA.w);
  vVegFade.y = 1.0 - smoothstep(vegCull * 0.85, vegCull, vegD);`
      : ''
  }
  vVeg = vec4(veg.x, veg.y, iB.w, vegS);
  vVegWorldN = vegN;
  vVegWorldP = transformed;
  // The rotated normal replaces three's (normal_vertex ran before begin_vertex).
  transformedNormal = normalize(normalMatrix * vegN);
  vNormal = transformedNormal;`
      : ''
  }
`;
}

function fragmentHead(o: VegPatchOptions): string {
  return /* glsl */ `
uniform vec4 uVegWind;
uniform vec3 uVegSun;
uniform vec3 uVegSunCol;
varying vec4 vVeg;
varying vec2 vVegFade;
varying vec3 vVegWorldN;
varying vec3 vVegWorldP;
${VEG_DITHER_GLSL}
${o.kind === 'rock' ? ROCK_FRAG_HEAD : ''}
`;
}

const ROCK_FRAG_HEAD = /* glsl */ `
float vegHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vegVnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vegHash(i), vegHash(i + vec2(1.0, 0.0)), f.x), mix(vegHash(i + vec2(0.0, 1.0)), vegHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

function applyColor(shader: WebGLProgramParametersWithUniforms, o: VegPatchOptions, u: VegUniforms): void {
  shader.uniforms.uVegWind = u.uVegWind;
  shader.uniforms.uVegSun = u.uVegSun;
  shader.uniforms.uVegSunCol = u.uVegSunCol;
  shader.uniforms.uVegFade = o.fade;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${vertexHead(o, true)}`)
    .replace('#include <begin_vertex>', vertexBody(o, true));
  const rock = o.kind === 'rock';
  let frag = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragmentHead(o)}`);
  frag = frag.replace(
    '#include <clipping_planes_fragment>',
    `#include <clipping_planes_fragment>
  {
    float t = vegDither();
    if (vVegFade.y <= t || vVegFade.x < 1.0 - t) discard;
    ${
      rock
        ? ''
        : `// Near leaf cards seen edge-on smear into streaks: dither them out (the crossing cards fill in).
    if (vVeg.x > 0.5) {
      vec3 gn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
      float facing = abs(dot(gn, normalize(vViewPosition)));
      float nearK = 1.0 - smoothstep(25.0, 45.0, length(vViewPosition));
      if (smoothstep(0.06, 0.32, facing) < fract(t + 0.5) * nearK) discard;
    }`
    }
  }`,
  );
  if (rock) {
    // World-space triplanar procedural rock (the map is the tileable rock albedo), moss on top faces.
    frag = frag.replace(
      '#include <map_fragment>',
      `{
    vec3 wn = normalize(vVegWorldN);
    vec3 bw = pow(abs(wn), vec3(4.0));
    bw /= (bw.x + bw.y + bw.z);
    vec3 p = vVegWorldP * 0.45;
    vec3 c = texture2D(map, p.zy).rgb * bw.x + texture2D(map, p.xz).rgb * bw.y + texture2D(map, p.xy).rgb * bw.z;
    float n = vegVnoise(vVegWorldP.xz * 0.9) * 0.6 + vegVnoise(vVegWorldP.xz * 3.1) * 0.4;
    float moss = smoothstep(0.45, 0.85, wn.y + 0.35 * (n - 0.5)) * smoothstep(0.3, 0.7, n + 0.15);
    c = mix(c * vec3(1.02, 0.98, 0.92) * (0.85 + 0.3 * fract(vVeg.z * 13.7)), vec3(0.1, 0.12, 0.045), moss * 0.8);
    diffuseColor.rgb *= c * mix(0.55, 1.0, vVeg.y);
  }`,
    );
    frag = frag.replace('#include <normal_fragment_maps>', '');
    // Sky + ground bounce fill: the IBL alone left the sun-averted faces of boulders black against
    // the (brighter, translucency-lit) grass and terrain around them.
    frag = frag.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * uVegSunCol * (0.05 + 0.04 * max(vVegWorldN.y, 0.0));`,
    );
  } else {
    frag = frag.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
  {
    float leaf = vVeg.x;
    float seed = vVeg.z;
    // Per-tree foliage colour: a warm (olive / yellow-green) ↔ cool (blue-green) axis, a
    // saturation and a brightness draw, so a stand never reads as one cloned green.
    float hW = fract(seed * 7.13) - 0.5;
    float hB = fract(seed * 13.37);
    float hS = fract(seed * 3.71);
    vec3 tint = leaf > 0.5
      ? vec3(1.0 + hW * 0.42, 1.0 + (fract(seed * 5.3) - 0.5) * 0.14, 1.0 - hW * 0.5) * (0.74 + 0.42 * hB)
      : vec3(1.0 + (fract(seed * 3.3) - 0.5) * 0.2);
    if (leaf > 0.5) {
      float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.85 + 0.35 * hS);
    }
    // crown self-shadowing: inner and lower clusters sit in the crown's own shade
    float occ = leaf > 0.5 ? mix(0.14, 1.0, vVeg.y * vVeg.y) : mix(0.3, 1.0, vVeg.y);
    diffuseColor.rgb *= tint * occ;
  }`,
    );
    // Foliage: never flip normals on back faces (spherical crown normals light both sides alike).
    frag = frag.replace('#include <normal_fragment_begin>', NORMAL_BEGIN_NO_FLIP);
    frag = frag.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
  roughnessFactor = mix(0.9, 0.82, vVeg.x);`,
    );
    // A crown is thousands of differently tilted leaves: its aggregate sheen is broad and dim.
    // Full dielectric F0 on cards whose normals are bent toward the sky lit the crown tops as
    // pale, near-white patches (sky reflection at grazing view angles).
    frag = frag.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
  {
    float vegSpec = mix(1.0, 0.14, vVeg.x);
    material.specularColor *= vegSpec;
    material.specularColorBlended *= vegSpec;
    material.specularF90 *= vegSpec;
  }`,
    );
    // Leaf translucency: shadowed, after the light loop (foliageTranslucency).
    frag = frag.replace('#include <lights_fragment_end>', foliageTranslucency('vVeg.x', '0.25 + 0.75 * vVeg.y', 0.55, 0.06));
    // bark: bounce + sky fill (sun-averted trunks under the crown went pitch black)
    frag = frag.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * uVegSunCol * 0.045 * (1.0 - vVeg.x);`,
    );
  }
  shader.fragmentShader = frag;
}

/**
 * Leaf / grass-blade translucency, added to the direct diffuse AFTER the light
 * loop so it carries the key light's shadow (`crumpleKeyVis`, env patch):
 * unshadowed emissive translucency made sun-backlit crowns glow white. Light
 * through a leaf is filtered by it twice (albedo², a deeper yellow-green),
 * with a forward lobe toward the viewer and a small wrap term. `amount`,
 * `occ` are GLSL expressions (leaf mask, crown-depth occlusion).
 */
export function foliageTranslucency(amount: string, occ: string, lobe: number, wrap: number): string {
  return /* glsl */ `#include <lights_fragment_end>
  {
    vec3 vegSunV = normalize((viewMatrix * vec4(uVegSun, 0.0)).xyz);
    float vegBl = max(dot(normalize(-vViewPosition), vegSunV), 0.0);
    vegBl *= vegBl;
    vegBl *= vegBl;
    float vegVis = 1.0;
    #ifdef CRUMPLE_KEYVIS
      vegVis = crumpleKeyVis;
    #endif
    vec3 vegTrans = min(diffuseColor.rgb * diffuseColor.rgb * 5.0, vec3(0.6));
    reflectedLight.directDiffuse += vegTrans * uVegSunCol * (vegBl * ${lobe.toFixed(3)} + ${wrap.toFixed(3)}) * vegVis * (${amount}) * (${occ});
  }`;
}

const NORMAL_BEGIN_NO_FLIP = /* glsl */ `
float faceDirection = 1.0;
vec3 normal = normalize( vNormal );
#if defined( USE_NORMALMAP_TANGENTSPACE )
  mat3 tbn = getTangentFrame( - vViewPosition, normal, vNormalMapUv );
#endif
vec3 nonPerturbedNormal = normal;
`;

function applyDepth(shader: WebGLProgramParametersWithUniforms, o: VegPatchOptions, u: VegUniforms): void {
  shader.uniforms.uVegWind = u.uVegWind;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${vertexHead(o, false)}`)
    .replace('#include <begin_vertex>', vertexBody(o, false));
}

/** The vegetation vertex-stage ShaderPatch (instancing + wind + fade + shading tweaks). */
export function vegPatch(o: VegPatchOptions, u: VegUniforms): ShaderPatch {
  return {
    key: `veg1-${o.kind}${o.variantSelect ? '-vs' : ''}-b${o.bend}-c${o.sizeCull ?? 0}`,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget) {
      if (target === 'color') applyColor(shader, o, u);
      else applyDepth(shader, o, u);
    },
  };
}
