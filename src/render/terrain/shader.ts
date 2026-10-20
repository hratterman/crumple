/**
 * Terrain shader patch (B) for MeshStandardMaterial (colour) and
 * MeshDepthMaterial (shadow casters), applied through onBeforeCompile so
 * three's lighting, fog, CSM and shadow code stay intact.
 *
 * Vertex: CDLOD geomorph (see chunks.ts) driven by the MAIN camera position
 * (uTCam — the shadow pass must morph like the colour pass), normal read
 * from the terrain normal texture.
 *
 * Fragment, per pixel:
 *  1. terrain normal N from the RG16F normal texture (= the collision
 *     sampler's smoothed normal), splat weights (grass implicit) with a
 *     small noise warp that breaks the 1 m bilinear grid pattern;
 *  2. projections: planar XZ everywhere, plus X/Z planes where the slope is
 *     steep (smooth weights, so there is no seam at the switch);
 *  3. every active layer is sampled with HEX TILING (Mikkelsen 2022): three
 *     randomly rotated + offset taps on a world-space triangle grid,
 *     blended by barycentric weight × height → no visible repeats;
 *  4. height-based layer blend (weights gated so a zero-weight layer never
 *     shows: colour stays inside the 5-weight blend);
 *  5. macro colour variation (2 noise scales) + per-layer grading, far
 *     detail (the same texture at 1/9 scale modulating colour beyond ~60 m),
 *     distance fade of normal strength;
 *  6. concrete tint on the paved layer, wet darkening near the water line.
 *
 * TERRAIN_LITE (define; the low preset, see renderer.ts): only the TWO
 * strongest splat layers, each with ONE planar tap (2 fetches instead of up
 * to 3 planes × (6 hex + 2 plain + 2 far) for every layer a pixel quad
 * touches); no hex tiling, side planes or far detail. Under a software
 * rasterizer (SwiftShader, CI) the full path was ~90 % of the frame.
 */
import type { IUniform, WebGLProgramParametersWithUniforms } from 'three';
import { Vector2, Vector3, Vector4 } from 'three';

export const TERRAIN_SHADER_KEY = 'terrain-b1';
/** Material define selecting the one-tap terrain path (low preset). */
export const TERRAIN_LITE_DEFINE = 'TERRAIN_LITE';

/** Presets that use the lite terrain path. */
export function terrainLite(level: string): boolean {
  return level === 'low';
}

export interface TerrainUniforms {
  [name: string]: IUniform;
}

const VERT_PARS = /* glsl */ `
attribute vec2 aMorph;
uniform vec3 uTCam;
uniform vec2 uTMorph[4];
uniform vec4 uTGrid;
`;

const VERT_NORMAL_PARS = /* glsl */ `
uniform sampler2D tTNormal;
varying vec3 vTPos;
vec3 tTerrainNormal(vec2 xz) {
  vec2 n = textureLod(tTNormal, (xz - uTGrid.xy) * uTGrid.zw, 0.0).xy;
  return vec3(n.x, sqrt(max(1.0 - dot(n, n), 0.0)), n.y);
}
`;

const VERT_MORPH = /* glsl */ `
vec3 transformed = vec3(position);
{
  // Chunk meshes have an identity transform: object space == world space.
  float tDist = distance(uTCam, position);
  vec2 tMr = uTMorph[int(aMorph.y + 0.5)];
  float tK = clamp((tDist - tMr.x) / (tMr.y - tMr.x), 0.0, 1.0);
  transformed.y = mix(position.y, aMorph.x, tK);
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vTPos;
uniform vec4 uTGrid;
uniform sampler2D tTNormal;
uniform sampler2D tTSplat;
uniform sampler2D tTConcrete;
uniform sampler2D tTNoise;
uniform highp sampler2DArray tTAlbedo;
uniform highp sampler2DArray tTSurface;
uniform float uTTileInv[5];
uniform float uTNormalStr[5];
uniform float uTSat[5];
uniform float uTContrast[5];
uniform vec3 uTTint[5];      // target mean albedo (linear) per layer
uniform vec3 uTMacroA[5];
uniform vec3 uTMacroB[5];
uniform vec3 uTMean[5];
uniform vec2 uTRough[5];    // roughness remap: mix(x, y, texture)
uniform vec4 uTWater;      // level, wet band, underwater darkening, enabled
uniform vec4 uTHex;        // lattice edge (m), rotation strength, blend sharpness, height influence
uniform vec4 uTBlend;      // height-blend depth, height scale, far-detail start, far-detail end
uniform vec3 uTConcrete;   // concrete colour (linear)
uniform float uTSpec;      // specular intensity (F0 and F90 scale); rough ground under a bright dawn sky
uniform float uTDebug;     // 0 off, 1 albedo, 2 normal, 3 roughness, 4 splat, 5 AO
uniform vec4 uTCut;        // steep cuts (render only): N.y where rock starts, N.y where it is full, rock share of the moved weight, jitter
uniform vec3 uTFill;       // bounce from sunlit terrain + sky multiple scattering (linear radiance at full weight)
uniform vec2 uTSunH;       // horizontal unit vector toward the sun (x, z)
uniform float uTCutFoot;   // reach (m) of the scree band at the foot of a steep cut

vec2 tHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

#ifndef TERRAIN_LITE
// Triangle-grid (hex tiling) state for one projection plane.
struct THex {
  vec3 w;
  vec2 c1; vec2 c2; vec2 c3;   // tap rotation centres (m)
  mat2 r1; mat2 r2; mat2 r3;   // rotations (texture <- world plane)
  vec2 o1; vec2 o2; vec2 o3;   // random offsets (m)
};

mat2 tRot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

THex tHexGrid(vec2 p) {
  float E = uTHex.x;
  vec2 st = p / E;
  vec2 sk = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  THex g;
  g.w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  vec2 v1 = base + vec2(s, s);
  vec2 v2 = base + vec2(s, 1.0 - s);
  vec2 v3 = base + vec2(1.0 - s, s);
  g.c1 = vec2(v1.x + 0.5 * v1.y, 0.8660254 * v1.y) * E;
  g.c2 = vec2(v2.x + 0.5 * v2.y, 0.8660254 * v2.y) * E;
  g.c3 = vec2(v3.x + 0.5 * v3.y, 0.8660254 * v3.y) * E;
  vec2 h1 = tHash22(v1), h2 = tHash22(v2), h3 = tHash22(v3);
  float rs = 6.2831853 * uTHex.y;
  g.r1 = tRot((h1.x - 0.5) * rs);
  g.r2 = tRot((h2.x - 0.5) * rs);
  g.r3 = tRot((h3.x - 0.5) * rs);
  g.o1 = tHash22(v1 + 17.0) * 97.0;
  g.o2 = tHash22(v2 + 17.0) * 97.0;
  g.o3 = tHash22(v3 + 17.0) * 97.0;
  return g;
}

// One layer on one plane with hex tiling. alb = rgb + height, srf = (n.xy in
// plane frame, rough, ao). Gradients are explicit (called under branches).
// hexK: 0 = full hex tiling, 1 = one plain tap. Far away the hex cells get
// sub-pixel and their random taps alias into a regular dot pattern, while the
// mipmapped texture is already uniform there — so fade to a single tap.
void tSampleHex(in THex g, vec2 p, vec2 dpx, vec2 dpy, float layer, float tInv, float hexK, float footprint, out vec4 alb, out vec4 srf) {
  // Once one texture repeat spans only a few pixels the mipmapped texture
  // shows its period as a fine regular pattern (moiré). Fade to the layer's
  // mean (1×1 mip) there; far detail + macro noise carry the variation.
  float meanK = smoothstep(0.12, 0.35, footprint * tInv);
  vec4 ma = vec4(0.0);
  vec4 ms = vec4(0.0);
  if (meanK > 0.0) {
    ma = textureLod(tTAlbedo, vec3(0.5, 0.5, layer), 16.0);
    ms = textureLod(tTSurface, vec3(0.5, 0.5, layer), 16.0);
    ms.xy = vec2(0.0);
    if (meanK >= 1.0) {
      alb = ma;
      srf = ms;
      return;
    }
  }
  vec4 pa = vec4(0.0);
  vec4 ps = vec4(0.5, 0.5, 0.5, 1.0);
  if (hexK > 0.0) {
    vec2 up = p * tInv;
    pa = textureGrad(tTAlbedo, vec3(up, layer), dpx * tInv, dpy * tInv);
    ps = textureGrad(tTSurface, vec3(up, layer), dpx * tInv, dpy * tInv);
    ps.xy = ps.xy * 2.0 - 1.0;
    if (hexK >= 1.0) {
      alb = mix(pa, ma, meanK);
      srf = mix(ps, ms, meanK);
      return;
    }
  }
  vec2 u1 = (g.r1 * (p - g.c1) + g.c1 + g.o1) * tInv;
  vec2 u2 = (g.r2 * (p - g.c2) + g.c2 + g.o2) * tInv;
  vec2 u3 = (g.r3 * (p - g.c3) + g.c3 + g.o3) * tInv;
  vec2 dx1 = g.r1 * dpx * tInv, dy1 = g.r1 * dpy * tInv;
  vec2 dx2 = g.r2 * dpx * tInv, dy2 = g.r2 * dpy * tInv;
  vec2 dx3 = g.r3 * dpx * tInv, dy3 = g.r3 * dpy * tInv;
  vec4 a1 = textureGrad(tTAlbedo, vec3(u1, layer), dx1, dy1);
  vec4 a2 = textureGrad(tTAlbedo, vec3(u2, layer), dx2, dy2);
  vec4 a3 = textureGrad(tTAlbedo, vec3(u3, layer), dx3, dy3);
  vec3 hh = vec3(a1.a, a2.a, a3.a);
  vec3 W = g.w * mix(vec3(1.0), 0.35 + hh, uTHex.w);
  W = pow(max(W, vec3(1e-4)), vec3(uTHex.z));
  W /= (W.x + W.y + W.z);
  vec4 s1 = textureGrad(tTSurface, vec3(u1, layer), dx1, dy1);
  vec4 s2 = textureGrad(tTSurface, vec3(u2, layer), dx2, dy2);
  vec4 s3 = textureGrad(tTSurface, vec3(u3, layer), dx3, dy3);
  alb = a1 * W.x + a2 * W.y + a3 * W.z;
  // Tangent normals back into the plane frame: R^T (texture <- world).
  vec2 n1 = (s1.xy * 2.0 - 1.0) * g.r1;
  vec2 n2 = (s2.xy * 2.0 - 1.0) * g.r2;
  vec2 n3 = (s3.xy * 2.0 - 1.0) * g.r3;
  srf = vec4(n1 * W.x + n2 * W.y + n3 * W.z, s1.z * W.x + s2.z * W.y + s3.z * W.z, s1.w * W.x + s2.w * W.y + s3.w * W.z);
  if (hexK > 0.0) {
    alb = mix(alb, pa, hexK);
    srf = mix(srf, ps, hexK);
  }
  alb = mix(alb, ma, meanK);
  srf = mix(srf, ms, meanK);
}

#else
// One planar tap (+ the layer mean in the moiré band): the low-preset path.
void tSamplePlain(vec2 p, vec2 dpx, vec2 dpy, float layer, float tInv, float footprint, out vec4 alb, out vec4 srf) {
  float meanK = smoothstep(0.12, 0.35, footprint * tInv);
  vec4 ma = vec4(0.0);
  vec4 ms = vec4(0.0);
  if (meanK > 0.0) {
    ma = textureLod(tTAlbedo, vec3(0.5, 0.5, layer), 16.0);
    ms = textureLod(tTSurface, vec3(0.5, 0.5, layer), 16.0);
    ms.xy = vec2(0.0);
    if (meanK >= 1.0) {
      alb = ma;
      srf = ms;
      return;
    }
  }
  vec2 up = p * tInv;
  alb = textureGrad(tTAlbedo, vec3(up, layer), dpx * tInv, dpy * tInv);
  srf = textureGrad(tTSurface, vec3(up, layer), dpx * tInv, dpy * tInv);
  srf.xy = srf.xy * 2.0 - 1.0;
  alb = mix(alb, ma, meanK);
  srf = mix(srf, ms, meanK);
}
#endif

vec3 tGrade(vec3 c, int l, float macro) {
  // Albedo levels: re-centre the texture on a target mean (the raw ambientCG
  // sets range from near-black rock to near-white gravel), keeping its detail
  // as a ratio with adjustable saturation and contrast.
  vec3 ratio = c / max(uTMean[l], vec3(1e-4));
  float rl = dot(ratio, vec3(0.2126, 0.7152, 0.0722));
  ratio = mix(vec3(rl), ratio, uTSat[l]);
  vec3 o = uTTint[l] * pow(max(ratio, vec3(0.0)), vec3(uTContrast[l]));
  return o * mix(uTMacroA[l], uTMacroB[l], macro);
}

#ifdef TERRAIN_LITE
// One lite layer: graded colour (+ concrete on the paved layer), planar normal, roughness.
// tOff: the projection plane's tangent frame (u axis, v axis) in world space, for the normal map.
void tLayerLite(int l, vec4 alb, vec4 srf, vec3 N, mat2x3 tOff, float nFade, float macro, float concrete, float slabTone, float slabJoint,
                out vec3 col, out vec3 n, out float rough) {
  float nStr = uTNormalStr[l] * nFade;
  vec2 d = srf.xy * nStr;
  n = normalize(N + tOff[0] * d.x + tOff[1] * d.y);
  col = tGrade(alb.rgb, l, macro);
  if (l == 0 && concrete > 0.0) {
    float rl = dot(alb.rgb / max(uTMean[0], vec3(1e-4)), vec3(0.2126, 0.7152, 0.0722));
    vec3 conc = uTConcrete * pow(max(rl, 0.0), 0.6) * mix(0.9, 1.08, macro);
    conc *= slabTone * (1.0 - 0.6 * slabJoint);
    col = mix(col, conc, concrete);
  }
  rough = mix(uTRough[l].x, uTRough[l].y, srf.z);
}
#endif
`;

const FRAG_MAIN = /* glsl */ `
vec3 tNormalW;
float tRough;
float tAO;
float tSpec = uTSpec;
{
  vec3 P = vTPos;
  vec3 dPdx = dFdx(P);
  vec3 dPdy = dFdy(P);
  float tDist = distance(P, cameraPosition);

  vec2 gridUv = (P.xz - uTGrid.xy) * uTGrid.zw;
  vec2 nT = texture(tTNormal, gridUv).xy;
  vec3 N = vec3(nT.x, sqrt(max(1.0 - dot(nT, nT), 0.0)), nT.y);

  vec4 nzA = texture(tTNoise, P.xz * (1.0 / 23.0));
  vec4 nzB = texture(tTNoise, P.xz * (1.0 / 640.0));
  vec4 nzC = texture(tTNoise, P.xz * (1.0 / 150.0) + 0.37);
  // Splat lookup warped by ~±0.8 m so blend contours do not follow the grid.
  vec2 warp = (nzA.ba - 0.5) * 1.6 * uTGrid.zw;
  vec4 sp = texture(tTSplat, gridUv + warp);
  float w[5];
  w[0] = sp.r; w[1] = sp.g; w[2] = sp.b; w[3] = sp.a;
  w[4] = max(1.0 - (sp.r + sp.g + sp.b + sp.a), 0.0);
  // Steep cuts and embankments read as rock / bare dirt (render only: materialAt keeps the
  // generator's splat). Grass painted on a 45° road cut lit only by the violet dawn sky went
  // near-black purple; turf and loose gravel do not hold on slopes that steep anyway.
  {
    float cut = smoothstep(uTCut.x, uTCut.y, N.y + (nzA.r - 0.5) * uTCut.w);
    float mv = (w[4] + 0.6 * w[3]) * cut;
    w[4] *= 1.0 - cut;
    w[3] *= 1.0 - 0.6 * cut;
    float rockShare = uTCut.z * mix(0.75, 1.15, nzC.r);
    w[2] += mv * clamp(rockShare, 0.0, 1.0);
    w[1] += mv * (1.0 - clamp(rockShare, 0.0, 1.0));
  }
  float concrete = texture(tTConcrete, gridUv).r;
  // Concrete cast slabs (6 m): per-slab tone + antialiased saw-cut joints
  // (derivatives taken here, in uniform control flow).
  vec2 slab = P.xz / 6.0 + 0.5;
  float slabTone = 0.93 + 0.14 * tHash22(floor(slab)).x;
  vec2 je = 3.0 - abs(fract(slab) - 0.5) * 6.0;   // m to the nearest joint
  vec2 sfw = max(fwidth(P.xz), vec2(1e-4));
  float slabJoint = max(1.0 - smoothstep(0.012, 0.012 + sfw.x, je.x), 1.0 - smoothstep(0.012, 0.012 + sfw.y, je.y));
  slabJoint *= 1.0 - smoothstep(0.02, 0.08, max(sfw.x, sfw.y));

#ifdef TERRAIN_LITE
  vec3 tw = vec3(0.0, 1.0, 0.0);
  // One tap per layer, but steep faces project onto the side plane they face (a planar XZ tap
  // smeared into long streaks down road cuts). The switch contour is jittered by noise.
  vec2 pY = P.xz;
  vec2 lDx = dPdx.xz;
  vec2 lDy = dPdy.xz;
  mat2x3 lFrame = mat2x3(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0));
  {
    float ax = abs(N.x);
    float az = abs(N.z);
    if (max(ax, az) > N.y + (nzA.b - 0.5) * 0.2) {
      if (ax > az) {
        float sx = N.x >= 0.0 ? 1.0 : -1.0;
        pY = vec2(P.z * sx, P.y) + 31.0;
        lDx = vec2(dPdx.z * sx, dPdx.y);
        lDy = vec2(dPdy.z * sx, dPdy.y);
        lFrame = mat2x3(vec3(0.0, 0.0, sx), vec3(0.0, 1.0, 0.0));
      } else {
        float sz = N.z >= 0.0 ? 1.0 : -1.0;
        pY = vec2(-P.x * sz, P.y) + 57.0;
        lDx = vec2(-dPdx.x * sz, dPdx.y);
        lDy = vec2(-dPdy.x * sz, dPdy.y);
        lFrame = mat2x3(vec3(-sz, 0.0, 0.0), vec3(0.0, 1.0, 0.0));
      }
    }
  }
#else
  // Projection weights: XZ plane always; side planes fade in on steep slopes.
  vec3 tw = pow(abs(N), vec3(4.0));
  float steep = smoothstep(0.88, 0.62, N.y);
  tw.xz *= steep;
  tw /= (tw.x + tw.y + tw.z);
  bool useX = tw.x > 0.02;
  bool useZ = tw.z > 0.02;
  vec3 sgn = vec3(N.x >= 0.0 ? 1.0 : -1.0, 1.0, N.z >= 0.0 ? 1.0 : -1.0);

  vec2 pY = P.xz;
  vec2 pX = vec2(P.z * sgn.x, P.y);
  vec2 pZ = vec2(-P.x * sgn.z, P.y);
  THex gY = tHexGrid(pY);
  THex gX = gY;
  THex gZ = gY;
  if (useX) gX = tHexGrid(pX + 31.0);
  if (useZ) gZ = tHexGrid(pZ + 57.0);
#endif

  float macro = clamp(nzB.r * 0.65 + nzC.g * 0.35, 0.0, 1.0);
  macro = smoothstep(0.2, 0.8, macro);
  // Pixel footprint (m) → hex tiling fades to a plain tap once cells are ~sub-pixel.
  float footprint = sqrt(length(dPdx) * length(dPdy));
#ifndef TERRAIN_LITE
  float detailFar = smoothstep(uTBlend.z, uTBlend.w, tDist);
  float hexK = smoothstep(0.22 * uTHex.x / 2.2, 0.5 * uTHex.x / 2.2, footprint);
#endif
  float nFade = mix(1.0, 0.45, smoothstep(25.0, 260.0, tDist));

#ifdef TERRAIN_LITE
  // The two strongest layers only: bounded work per pixel (a SIMD quad straddling a blend ran up
  // to all five layers), one planar tap each, same grading / concrete / height blend.
  int i0 = 4;
  int i1 = 4;
  float w0 = -1.0;
  float w1 = -1.0;
  for (int l = 0; l < 5; l++) {
    float wl = w[l];
    if (wl > w0) {
      w1 = w0; i1 = i0;
      w0 = wl; i0 = l;
    } else if (wl > w1) {
      w1 = wl; i1 = l;
    }
  }
  vec3 albedo = vec3(0.0);
  vec3 nW = vec3(0.0);
  tRough = 0.0;
  tAO = 0.0;
  float hgt = 0.0;
  {
    vec4 a0, s0, a1, s1;
    tSamplePlain(pY, lDx, lDy, float(i0), uTTileInv[i0], footprint, a0, s0);
    bool two = w1 >= 0.003;
    if (two) tSamplePlain(pY, lDx, lDy, float(i1), uTTileInv[i1], footprint, a1, s1);
    else { a1 = a0; s1 = s0; }
    vec3 c0, c1, n0, n1;
    float r0, r1, h0, h1;
    tLayerLite(i0, a0, s0, N, lFrame, nFade, macro, concrete, slabTone, slabJoint, c0, n0, r0);
    tLayerLite(i1, a1, s1, N, lFrame, nFade, macro, concrete, slabTone, slabJoint, c1, n1, r1);
    h0 = w0 + uTBlend.y * a0.a * min(w0 * 4.0, 1.0);
    h1 = two ? w1 + uTBlend.y * a1.a * min(w1 * 4.0, 1.0) : -1.0;
    float hmax = max(h0, h1);
    float b0 = max(h0 - (hmax - uTBlend.x), 0.0);
    float b1 = two ? max(h1 - (hmax - uTBlend.x), 0.0) : 0.0;
    float ib = 1.0 / max(b0 + b1, 1e-5);
    albedo = (c0 * b0 + c1 * b1) * ib;
    nW = normalize(n0 * b0 + n1 * b1);
    tRough = (r0 * b0 + r1 * b1) * ib;
    tAO = (s0.w * b0 + s1.w * b1) * ib;
    hgt = (a0.a * b0 + a1.a * b1) * ib;
  }
#else
  vec3 lAlb[5];
  vec3 lN[5];
  float lH[5];
  float lR[5];
  float lAO[5];
  float hb[5];
  float hmax = -1.0;
  for (int l = 0; l < 5; l++) {
    lAlb[l] = vec3(0.0); lN[l] = N; lH[l] = 0.0; lR[l] = 1.0; lAO[l] = 1.0; hb[l] = -1.0;
    if (w[l] < 0.003) continue;
    float layer = float(l);
    float ti = uTTileInv[l];
    vec4 alb; vec4 srf;
    vec4 albAcc = vec4(0.0);
    vec4 srfAcc = vec4(0.0);
    vec3 nAcc = vec3(0.0);
    float nStr = uTNormalStr[l] * nFade;
    // Y (planar) projection
#ifdef TERRAIN_LITE
    tSamplePlain(pY, dPdx.xz, dPdy.xz, layer, ti, footprint, alb, srf);
#else
    tSampleHex(gY, pY, dPdx.xz, dPdy.xz, layer, ti, hexK, footprint, alb, srf);
#endif
    {
      vec3 tn = vec3(srf.xy * nStr, 1.0);
      tn = vec3(tn.xy + N.xz, tn.z * N.y);
      nAcc += tn.xzy * tw.y;
#ifndef TERRAIN_LITE
      // Far detail: the same texture at ~1/9 scale modulates colour.
      if (detailFar > 0.0) {
        // Two rotated, incommensurate scales (1/9 and 1/31): their product
        // never visibly repeats, unlike either alone.
        mat2 rf1 = mat2(0.8, 0.6, -0.6, 0.8);
        mat2 rf2 = mat2(0.28, -0.96, 0.96, 0.28);
        float k1 = ti * 0.11;
        float k2 = ti * 0.0323;
        vec3 f1 = textureGrad(tTAlbedo, vec3(rf1 * pY * k1, layer), rf1 * dPdx.xz * k1, rf1 * dPdy.xz * k1).rgb;
        vec3 f2 = textureGrad(tTAlbedo, vec3(rf2 * pY * k2 + 0.37, layer), rf2 * dPdx.xz * k2, rf2 * dPdy.xz * k2).rgb;
        vec3 im = 1.0 / max(uTMean[l], vec3(1e-3));
        // The 1/9 scale itself repeats every ~30–55 m: fade it to neutral when that spans few pixels.
        f1 = mix(f1, uTMean[l], smoothstep(0.12, 0.35, footprint * k1));
        vec3 fr = sqrt(clamp(f1 * im, 0.3, 3.0) * clamp(f2 * im, 0.3, 3.0));
        alb.rgb *= mix(vec3(1.0), fr, detailFar * 0.7);
      }
#endif
      albAcc += alb * tw.y;
      srfAcc += srf * tw.y;
    }
#ifndef TERRAIN_LITE
    if (useX) {
      tSampleHex(gX, pX, vec2(dPdx.z * sgn.x, dPdx.y), vec2(dPdy.z * sgn.x, dPdy.y), layer, ti, hexK, footprint, alb, srf);
      vec3 tn = vec3(srf.xy * nStr, 1.0);
      tn.x *= sgn.x;
      tn = vec3(tn.xy + N.zy, tn.z * N.x);
      nAcc += tn.zyx * tw.x;
      albAcc += alb * tw.x;
      srfAcc += srf * tw.x;
    }
    if (useZ) {
      tSampleHex(gZ, pZ, vec2(-dPdx.x * sgn.z, dPdx.y), vec2(-dPdy.x * sgn.z, dPdy.y), layer, ti, hexK, footprint, alb, srf);
      vec3 tn = vec3(srf.xy * nStr, 1.0);
      tn.x *= -sgn.z;
      tn = vec3(tn.xy + N.xy, tn.z * N.z);
      nAcc += tn.xyz * tw.z;
      albAcc += alb * tw.z;
      srfAcc += srf * tw.z;
    }
#endif
    lAlb[l] = tGrade(albAcc.rgb, l, macro);
    if (l == 0 && concrete > 0.0) {
      // Concrete: the paved set re-levelled lighter/greyer, keeping its detail.
      float rl = dot(albAcc.rgb / max(uTMean[0], vec3(1e-4)), vec3(0.2126, 0.7152, 0.0722));
      vec3 conc = uTConcrete * pow(max(rl, 0.0), 0.6) * mix(0.9, 1.08, macro);
      conc *= slabTone * (1.0 - 0.6 * slabJoint);
      lAlb[0] = mix(lAlb[0], conc, concrete);
    }
    lH[l] = albAcc.a;
    lN[l] = normalize(nAcc);
    lR[l] = mix(uTRough[l].x, uTRough[l].y, srfAcc.z);
    lAO[l] = srfAcc.w;
    // Height blend input: weight + height, gated near zero weight.
    hb[l] = w[l] + uTBlend.y * albAcc.a * min(w[l] * 4.0, 1.0);
    hmax = max(hmax, hb[l]);
  }

  float depth = uTBlend.x;
  float bsum = 0.0;
  vec3 albedo = vec3(0.0);
  vec3 nW = vec3(0.0);
  tRough = 0.0;
  tAO = 0.0;
  float hgt = 0.0;
  for (int l = 0; l < 5; l++) {
    float b = max(hb[l] - (hmax - depth), 0.0);
    b *= step(0.003, w[l]);
    bsum += b;
    albedo += lAlb[l] * b;
    nW += lN[l] * b;
    tRough += lR[l] * b;
    tAO += lAO[l] * b;
    hgt += lH[l] * b;
  }
  float ib = 1.0 / max(bsum, 1e-5);
  albedo *= ib; tRough *= ib; tAO *= ib; hgt *= ib;
  nW = normalize(nW);

#endif

  // Mid-scale breakup (1–10 m) so no surface reads as a flat colour at 20–80 m.
  albedo *= mix(0.84, 1.14, clamp(nzA.g * 0.65 + nzC.a * 0.35, 0.0, 1.0));

  // Rock-cut character on steep faces (shader only): sedimentary strata along world Y (warped,
  // gently dipping, two scales, alternating warm / grey beds), dark bedding-plane and joint
  // cracks, exposed harder ledges from macro noise; scree / debris tint where a cut meets the
  // flat ground below it (the shoulder). Flat ground pays one branch.
  {
    // strata start a little shallower than the rock override, so a cut's lower apron keeps them
    float cutK = smoothstep(uTCut.x + 0.06, uTCut.y + 0.08, N.y);
    vec2 gT = uTGrid.zw * uTCutFoot;
    float footN = 0.0;
    if (cutK < 0.98) {
      // steepest neighbour within ~uTCutFoot m (the normal texture stores (x, z): |xz|² = 1 − y²)
      vec2 a1 = textureLod(tTNormal, gridUv + vec2(gT.x, gT.y) * 0.7, 0.0).xy;
      vec2 a2 = textureLod(tTNormal, gridUv - vec2(gT.x, gT.y) * 0.7, 0.0).xy;
      float sMax = max(dot(a1, a1), dot(a2, a2));
#ifndef TERRAIN_LITE
      vec2 a3 = textureLod(tTNormal, gridUv + vec2(gT.x, -gT.y) * 0.7, 0.0).xy;
      vec2 a4 = textureLod(tTNormal, gridUv - vec2(gT.x, -gT.y) * 0.7, 0.0).xy;
      sMax = max(sMax, max(dot(a3, a3), dot(a4, a4)));
#endif
      footN = smoothstep(uTCut.x + 0.06, uTCut.y + 0.08, sqrt(max(1.0 - sMax, 0.0))) * (1.0 - cutK);
    }
    if (cutK > 0.0) {
      // explicit gradients: this runs under a branch (implicit derivatives are undefined there)
      const float kS = 1.0 / 37.0;
      vec4 nzS = textureGrad(tTNoise, vec2(P.x + P.z, P.y * 2.3) * kS, vec2(dPdx.x + dPdx.z, dPdx.y * 2.3) * kS, vec2(dPdy.x + dPdy.z, dPdy.y * 2.3) * kS);
      float yS = P.y + (nzC.r - 0.5) * 6.0 + (nzS.g - 0.5) * 1.2 + dot(P.xz, vec2(0.021, -0.013));
      float bedA = sin(yS * 3.6959);                 // ~1.7 m beds
      float bedB = sin(yS * 11.4240 + nzS.b * 3.0);  // ~0.55 m laminae
      float tone = 1.0 + 0.26 * bedA + 0.1 * bedB;
      // beds alternate buff sandstone / grey shale / iron-stained red-brown
      float bedC = 0.5 + 0.5 * sin(yS * 1.31 + nzC.g * 4.0);
      vec3 bedTint = mix(mix(vec3(1.1, 1.0, 0.86), vec3(0.9, 0.93, 0.98), smoothstep(0.3, 0.7, bedC)), vec3(1.12, 0.86, 0.72), smoothstep(0.8, 0.95, bedC) * 0.8);
      // bedding-plane cracks (thin, along the beds) and joints (noise ridges across them)
      float ph = fract(yS * 0.588);
      float plane = abs(ph - 0.5) * 2.0;
      float bedCrack = 1.0 - smoothstep(0.0, 0.07 + 0.05 * nzS.r, 1.0 - plane);
      float joint = 1.0 - smoothstep(0.015, 0.05, abs(nzS.a - 0.5));
      float crack = max(bedCrack * 0.85, joint * 0.7 * smoothstep(0.3, 0.7, nzS.r));
      crack *= 1.0 - smoothstep(0.03, 0.12, footprint); // sub-pixel cracks alias: fade with distance
      // harder ledges: patches of bare, paler, smoother rock
      float ledge = smoothstep(0.55, 0.7, nzC.b * 0.7 + nzS.r * 0.3);
      // exposed rock reads paler and greyer than the soil it is cut through
      float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
      vec3 rockC = mix(albedo, vec3(lum) * vec3(1.06, 1.0, 0.9), 0.65) * 1.3;
      vec3 cutAlb = rockC * tone * bedTint * mix(1.0, 1.25, ledge) * (1.0 - 0.6 * crack);
      albedo = mix(albedo, cutAlb, cutK);
      tRough = mix(tRough, mix(tRough, 0.6, ledge), cutK);
      tAO = mix(tAO, tAO * (1.0 - 0.5 * crack), cutK);
      // stepped beds: each bed's tread tilts toward the sky, its riser (just under the next
      // bedding plane) toward the horizon, so light catches the ledges
      float riser = smoothstep(0.72, 0.94, ph) * (1.0 - smoothstep(0.96, 1.0, ph));
      nW = normalize(nW + vec3(0.0, 1.0, 0.0) * ((0.3 - 0.75 * riser) * cutK * (0.6 + 0.4 * ledge)));
    }
    if (footN > 0.0) {
      // scree: fallen, paler grey-brown debris with coarse speckle at the foot of the cut
      const float kP = 1.0 / 1.7;
      float speck = textureGrad(tTNoise, P.xz * kP, dPdx.xz * kP, dPdy.xz * kP).r;
      vec3 scree = vec3(0.16, 0.148, 0.13) * mix(0.55, 1.3, speck * speck) * mix(0.9, 1.1, nzA.b);
      float k = footN * mix(0.55, 1.0, smoothstep(0.3, 0.7, nzA.r * 0.5 + speck * 0.5));
      albedo = mix(albedo, scree, k * 0.9);
      tRough = mix(tRough, 0.9, k);
    }
  }

  // Wet ground near the water line (and darker under it).
  if (uTWater.w > 0.5) {
    float above = P.y - uTWater.x;
    float jitter = (nzA.r - 0.5) * 0.7 + (nzC.b - 0.5) * 0.6;
    float wet = 1.0 - smoothstep(0.15, uTWater.y, above + jitter);
    wet *= mix(1.0, 0.6, hgt * (1.0 - smoothstep(0.0, 0.5, -above)));
    float under = smoothstep(0.0, -1.5, above);
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 wetC = mix(vec3(lum), albedo, 1.25) * 0.42;
    albedo = mix(albedo, wetC, wet);
    albedo *= mix(1.0, uTWater.z, under);
    tRough = mix(tRough, 0.14, wet * 0.85);
    tSpec = mix(uTSpec, 1.0, wet);
    nW = normalize(mix(nW, N, wet * 0.55));
  }

  // Cavity: a little AO on direct light too (AO also scales indirect below).
  albedo *= mix(1.0, tAO, 0.35);
  tRough = clamp(mix(tRough, max(tRough, 0.6), smoothstep(80.0, 600.0, tDist) * 0.6), 0.04, 1.0);
  tNormalW = nW;
  diffuseColor.rgb *= albedo;
  if (uTDebug > 0.5) {
    vec3 dbg = albedo;
    if (uTDebug > 1.5) dbg = nW * 0.5 + 0.5;
    if (uTDebug > 2.5) dbg = vec3(tRough);
    if (uTDebug > 3.5) dbg = vec3(w[0] + w[3], w[4] + w[1] * 0.5, w[2] + w[3]);
    if (uTDebug > 4.5) dbg = vec3(tAO);
    totalEmissiveRadiance = dbg * (uTDebug > 1.5 ? 0.25 : 1.0);
    diffuseColor.rgb = vec3(0.0);
    tRough = 1.0;
  }
}
`;

/** Uniform values shared by the colour and depth materials (same IUniform objects). */
export function createTerrainUniforms(): TerrainUniforms {
  const v3 = (n: number): Vector3[] => Array.from({ length: n }, () => new Vector3(1, 1, 1));
  return {
    uTCam: { value: new Vector3() },
    uTMorph: { value: [new Vector2(1e9, 2e9), new Vector2(1e9, 2e9), new Vector2(1e9, 2e9), new Vector2(1e9, 2e9)] },
    uTGrid: { value: new Vector4() },
    tTNormal: { value: null },
    tTSplat: { value: null },
    tTConcrete: { value: null },
    tTNoise: { value: null },
    tTAlbedo: { value: null },
    tTSurface: { value: null },
    uTTileInv: { value: [1, 1, 1, 1, 1] },
    uTNormalStr: { value: [1, 1, 1, 1, 1] },
    uTSat: { value: [1, 1, 1, 1, 1] },
    uTContrast: { value: [1, 1, 1, 1, 1] },
    uTTint: { value: v3(5) },
    uTMacroA: { value: v3(5) },
    uTMacroB: { value: v3(5) },
    uTMean: { value: v3(5) },
    uTRough: { value: Array.from({ length: 5 }, () => new Vector2(0, 1)) },
    uTWater: { value: new Vector4(6, 1.6, 0.6, 1) },
    uTHex: { value: new Vector4(2.2, 1, 6, 0.6) },
    uTBlend: { value: new Vector4(0.12, 0.5, 18, 160) },
    uTConcrete: { value: new Vector3(0.2, 0.195, 0.185) },
    uTDebug: { value: 0 },
    uTSpec: { value: 0.3 },
    uTCut: { value: new Vector4(0.84, 0.66, 0.85, 0.14) },
    uTFill: { value: new Vector3(0, 0, 0) },
    uTSunH: { value: new Vector2(1, 0) },
    uTCutFoot: { value: 4 },
  };
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`terrain shader patch: chunk ${find} not found`);
  return src.replace(find, repl);
}

/** Colour (MeshStandardMaterial) patch. Runs after CSM's hook (composition order). */
export function applyTerrainColorPatch(shader: WebGLProgramParametersWithUniforms, uniforms: TerrainUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  let vs = shader.vertexShader;
  vs = replaceOnce(vs, '#include <common>', `#include <common>\n${VERT_PARS}\n${VERT_NORMAL_PARS}`);
  vs = replaceOnce(vs, '#include <beginnormal_vertex>', 'vec3 objectNormal = tTerrainNormal(position.xz);');
  vs = replaceOnce(vs, '#include <begin_vertex>', `${VERT_MORPH}\nvTPos = transformed;`);
  shader.vertexShader = vs;
  let fs = shader.fragmentShader;
  fs = replaceOnce(fs, '#include <common>', `#include <common>\n${FRAG_PARS}`);
  fs = replaceOnce(fs, '#include <map_fragment>', `#include <map_fragment>\n${FRAG_MAIN}`);
  fs = replaceOnce(fs, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = tRough;');
  fs = replaceOnce(
    fs,
    '#include <normal_fragment_maps>',
    '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(tNormalW, 0.0)).xyz);',
  );
  fs = replaceOnce(
    fs,
    '#include <lights_physical_fragment>',
    '#include <lights_physical_fragment>\nmaterial.specularColor *= tSpec;\nmaterial.specularColorBlended *= tSpec;\nmaterial.specularF90 *= tSpec;',
  );
  fs = replaceOnce(
    fs,
    '#include <aomap_fragment>',
    `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= tAO;
reflectedLight.indirectSpecular *= mix(1.0, tAO, 0.7);
// Bounce from sunlit terrain + sky multiple scattering. The HDRI's lower hemisphere is the
// photographer's dark ground, so a face turned from the sun saw only the dim violet anti-sun
// sky (≈ 4 % of a sunlit slope: road cuts went black-purple). Sun-averted, steep faces look at
// the sunlit (sun-facing) terrain across from them, so they get the most.
{
  float tAway = 0.5 - 0.45 * dot(tNormalW.xz, uTSunH);
  float tSide = clamp(1.15 - tNormalW.y, 0.1, 1.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uTFill * (tAway * tSide) * mix(1.0, tAO, 0.6);
}`,
  );
  shader.fragmentShader = fs;
}

/** Depth (shadow caster) patch: geomorph only. */
export function applyTerrainDepthPatch(shader: WebGLProgramParametersWithUniforms, uniforms: TerrainUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  let vs = shader.vertexShader;
  vs = replaceOnce(vs, '#include <common>', `#include <common>\n${VERT_PARS}`);
  vs = replaceOnce(vs, '#include <begin_vertex>', VERT_MORPH);
  shader.vertexShader = vs;
}
