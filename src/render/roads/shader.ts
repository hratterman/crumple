/**
 * Ribbon shader chunks, spliced into MeshPhysicalMaterial (so lighting,
 * IBL, fog and CSM stay three's own). Surfaces, wear and markings are all
 * procedural in road space (u = lateral m, v = arc m):
 *  - markings are analytically box-filtered against the pixel footprint
 *    (fwidth) — crisp up close, converging to their true average coverage at
 *    distance instead of aliasing/shimmering; dashes use the integral of
 *    the pulse train, so a 12 m dash cycle at 400 m is a stable grey line;
 *  - the asphalt set is sampled twice (second sample rotated 53° at 1.2×
 *    scale) and blended by low-frequency noise to break 4 m tiling;
 *  - every period divides V_PERIOD_M (48 m) so closed loops wrap seamlessly;
 *  - RD_LITE (low preset): one tap per map instead of the anti-tiling pair.
 * Junction data (cut/mark/crosswalk distances) come per vertex; see
 * junctions.ts.
 */

export const ROAD_VERTEX_PARS = /* glsl */ `
attribute vec2 aRoadUV;
attribute vec4 aJunc;
attribute vec4 aMisc;
attribute float aMouth;
varying vec2 vRoadUV;
varying vec4 vJunc;
varying vec4 vMisc;
varying float vMouth;
uniform float uPullK;
uniform float uPullRank;
`;

export const ROAD_VERTEX_BEGIN = /* glsl */ `
vRoadUV = aRoadUV;
vJunc = aJunc;
vMisc = aMisc;
vMouth = aMouth;
`;

/**
 * View-ray depth pull (screen position unchanged): beats coarse distant
 * terrain LODs (∝ dist²) and lets a yielding road's curb returns win over
 * the winner's verge near junctions. uPullRank 0 (dirt overlays) keeps a
 * trail beneath every paved ribbon it touches.
 */
export const ROAD_VERTEX_PROJECT = /* glsl */ `
{
  float rdDist = length(mvPosition.xyz);
  float rdPull = uPullK * rdDist * rdDist + uPullRank * (0.0004 * rdDist + aMisc.w * (0.02 + 0.0008 * rdDist));
  mvPosition.xyz *= max(0.05, 1.0 - rdPull / max(rdDist, 1e-3));
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const ROAD_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D tCol;
uniform sampler2D tNrm;
uniform sampler2D tRgh;
uniform sampler2D tAO;
uniform sampler2D tGCol;
uniform sampler2D tGNrm;
uniform sampler2D tNoise;
uniform float uHalfW;
uniform float uShoulder;
uniform float uInset;
uniform float uFringeW;
uniform float uFillet;
uniform float uLanes;
uniform float uTile;
uniform vec2 uSeed;
uniform float uWear;
uniform float uRetro;
varying vec2 vRoadUV;
varying vec4 vJunc;
varying vec4 vMisc;
varying float vMouth;

// Box-filtered coverage of the band |x − c| < hw over a pixel footprint fw.
float rdBox(float x, float fw, float c, float hw) {
  float lo = max(x - 0.5 * fw, c - hw);
  float hi = min(x + 0.5 * fw, c + hw);
  return clamp((hi - lo) / fw, 0.0, 1.0);
}
// Integral of a pulse train that is on over [0, D) of every period P.
float rdTrainI(float x, float P, float D) {
  return floor(x / P) * D + min(x - floor(x / P) * P, D);
}
// Box-filtered dash coverage at x (dash starts at multiples of P).
float rdDash(float x, float fw, float P, float D) {
  float w = max(fw, 1e-4);
  return clamp((rdTrainI(x + 0.5 * w, P, D) - rdTrainI(x - 0.5 * w, P, D)) / w, 0.0, 1.0);
}
// Thin lines of width w centred on multiples of P.
float rdLines(float x, float fw, float P, float w) {
  return rdDash(x + 0.5 * w, fw, P, w);
}
float rdHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float rdLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rdUnpack(vec4 t) { return t.xyz * 2.0 - 1.0; }
mat3 rdTangentFrame(vec3 eyePos, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(eyePos);
  vec3 q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uv);
  vec2 st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n);
  vec3 q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
// Junction kill: 0 inside / near a partner's carriageway, 1 beyond margin.
float rdKeep(float d, float margin) {
  return smoothstep(margin, margin + 0.6, d);
}
`;

/** Replaces <map_fragment>: computes rdCol / rdRough / rdN / rdAO / rdEmis / alpha. */
export const ROAD_FRAGMENT_SURFACE = /* glsl */ `
vec2 rdUV = vRoadUV;
float rdU = rdUV.x;
float rdV = rdUV.y;
float rdFwU = max(fwidth(rdU), 1e-4);
float rdFwV = max(fwidth(rdV), 1e-4);
float rdBeyond = vMisc.x;
float rdQ = rdBeyond > 0.0 ? length(vec2(rdU, rdBeyond)) : abs(rdU);
float rdCut = vJunc.x;
float rdMarkD = vJunc.y;
float rdXw = vJunc.z;
float rdJDir = vJunc.w;
// Overlap the winner's ragged paved edge (depth priority keeps this road on top).
if (rdCut < -0.3) discard;

float rdFil = 0.0;
if (rdCut < uFillet) {
  float t = uFillet - rdCut;
  rdFil = uFillet - sqrt(max(0.0, uFillet * uFillet - t * t));
}
float rdA = uHalfW + rdFil;
float rdCore = rdA + uShoulder - uInset;
// Only the paved surface may overlap the winner's edge; verge/fringe stop short of it.
if (rdCut < 0.35 && rdQ > rdA + 0.1) discard;
#ifdef RD_FRINGE
  if (rdQ < rdCore) discard;
#else
  if (rdQ >= rdCore) discard;
#endif

vec2 rdW = rdUV + uSeed;
vec4 rdN1 = texture2D(tNoise, rdW / 48.0);
vec4 rdN2 = texture2D(tNoise, rdW / 12.0 + 0.37);
vec4 rdN3 = texture2D(tNoise, rdW / 3.0 + 0.71);
float rdViewDist = length(vViewPosition);
float rdNStr = mix(1.0, 0.4, smoothstep(30.0, 220.0, rdViewDist));

// ---- primary set (asphalt / dirt), anti-tiled -------------------------
const mat2 rdRot = mat2(0.6, 0.8, -0.8, 0.6);
vec2 rdT1 = rdW / uTile;
vec2 rdT2 = (rdRot * rdW) / (uTile * 1.2);
#ifdef RD_LITE
// Low preset: one tap per map (the anti-tiling second sample doubles the fetches).
vec3 rdC = texture2D(tCol, rdT1).rgb;
vec3 rdNP = rdUnpack(texture2D(tNrm, rdT1));
float rdRgT = texture2D(tRgh, rdT1).g;
float rdAOT = texture2D(tAO, rdT1).r;
#else
float rdMixT = smoothstep(0.4, 0.6, rdN1.g);
vec3 rdC = mix(texture2D(tCol, rdT1).rgb, texture2D(tCol, rdT2).rgb, rdMixT);
vec3 rdNb2 = rdUnpack(texture2D(tNrm, rdT2));
rdNb2.xy = rdNb2.xy * rdRot;
vec3 rdNP = normalize(mix(rdUnpack(texture2D(tNrm, rdT1)), rdNb2, rdMixT));
float rdRgT = mix(texture2D(tRgh, rdT1).g, texture2D(tRgh, rdT2).g, rdMixT);
float rdAOT = mix(texture2D(tAO, rdT1).r, texture2D(tAO, rdT2).r, rdMixT);
#endif
float rdTexL = rdLum(rdC);

// ---- gravel verge ---------------------------------------------------
vec2 rdTG = rdW / 2.4;
vec3 rdGc = texture2D(tGCol, rdTG).rgb;
vec3 rdGN = rdUnpack(texture2D(tGNrm, rdTG));
rdGc = vec3(rdLum(rdGc)) * vec3(0.60, 0.56, 0.50) * 0.36 * mix(0.75, 1.15, rdN2.r);

// Lanes: centre → edge line split into uLanes per direction.
float rdLaneW = max(0.5, (uHalfW - 0.35) / uLanes);
float rdLm = (fract(abs(rdU) / rdLaneW) - 0.5) * rdLaneW;
float rdOnLane = 1.0 - smoothstep(uHalfW - 0.5, uHalfW - 0.1, abs(rdU));
float rdWheel = exp(-pow((abs(rdLm) - 0.88) / 0.32, 2.0)) * rdOnLane;
float rdOil = exp(-pow(rdLm / 0.4, 2.0)) * rdOnLane;

vec3 rdPav;
float rdPavR;
vec3 rdPavN = rdNP;
float rdPavAO = mix(1.0, rdAOT, 0.8);
float rdRag = (rdN3.r - 0.5) * 0.16 + (rdN2.g - 0.5) * 0.14;

#if defined(STYLE_DIRT)
  // Two-track trail: compacted brown ruts, mossy hump + edges (texture's own colour).
  float rdTL = clamp(rdTexL / 0.1, 0.3, 2.0);
  vec3 rdBrown = vec3(0.135, 0.097, 0.064) * (0.6 + 0.45 * rdTL) * mix(0.78, 1.18, rdN1.r) * mix(0.9, 1.1, rdN3.g);
  float rdHump = 1.0 - smoothstep(0.18, 0.5, abs(rdU) + (rdN3.g - 0.5) * 0.45);
  float rdEdgeG = smoothstep(rdA - 1.0, rdA + 0.15, rdQ + (rdN2.r - 0.5) * 1.2 + (rdN3.b - 0.5) * 0.4);
  float rdGrass = clamp(max(rdHump * mix(0.55, 1.0, rdN2.b), rdEdgeG), 0.0, 1.0);
  rdGrass *= smoothstep(0.15, 0.45, rdN3.b * 0.7 + rdN3.a * 0.3 + rdGrass * 0.45);
  float rdRut = exp(-pow((abs(rdU) - 0.85) / 0.32, 2.0)) * (1.0 - smoothstep(0.0, 2.0, rdBeyond));
  // Loose stones between the ruts / on the shoulders.
  float rdStones = smoothstep(0.55, 0.85, rdN2.g) * (1.0 - rdRut) * 0.55;
  vec3 rdMix = mix(rdBrown, rdGc * 0.9, rdStones);
  rdPav = mix(rdMix, rdC * vec3(0.9, 0.86, 0.72), rdGrass);
  // Ruts: darker, compacted, with damp low spots.
  rdPav *= 1.0 - 0.38 * rdRut * (0.65 + 0.35 * rdN2.r);
  float rdWet = rdRut * smoothstep(0.66, 0.8, rdN2.g * 0.6 + rdN1.r * 0.4);
  rdPav = mix(rdPav, rdPav * vec3(0.55, 0.5, 0.48), rdWet);
  rdPavR = mix(0.96, 0.86, rdRut) - 0.5 * rdWet;
  float rdDh = 0.07 * rdRut * 2.0 * (abs(rdU) - 0.85) / (0.32 * 0.32) * sign(rdU);
  rdPavN = normalize(vec3(rdNP.xy * mix(1.2, 0.55, rdRut) * (1.0 - rdWet * 0.7) + vec2(rdDh * 0.4, 0.0), rdNP.z));
  rdRag = 0.0;
#elif defined(STYLE_ARENA)
  // Saw-cut concrete slabs, per-slab tint, stains, rubber from crash-test run-ups.
  float rdTL = clamp(rdTexL / 0.025, 0.4, 2.0);
  vec2 rdSlab = floor(vec2((rdU + 60.0) / 3.0, rdV / 6.0));
  float rdSh = rdHash(rdSlab + uSeed);
  rdPav = vec3(0.235, 0.23, 0.215) * (0.8 + 0.2 * rdTL) * (0.9 + 0.14 * rdSh)
    * mix(0.82, 1.1, rdN1.r) * mix(0.92, 1.05, rdN3.r);
  float rdStain = smoothstep(0.62, 0.8, rdN2.r * 0.45 + rdN1.g * 0.55);
  rdPav *= 1.0 - 0.25 * rdStain;
  float rdJoint = max(rdLines(rdU + 60.0, rdFwU, 3.0, 0.012), rdLines(rdV, rdFwV, 6.0, 0.012));
  rdPav *= 1.0 - 0.6 * rdJoint * (1.0 - smoothstep(60.0, 160.0, rdViewDist) * 0.6);
  float rdStreak = texture2D(tNoise, vec2(rdW.x / 2.4, rdW.y / 48.0)).r;
  float rdWheelA = exp(-pow((abs(abs(rdU) - 1.6) - 0.8) / 0.45, 2.0));
  float rdRubber = smoothstep(0.45, 0.7, rdStreak) * rdWheelA * smoothstep(0.35, 0.6, rdN1.g) * (0.6 + 0.4 * rdN3.g);
  rdPav *= 1.0 - 0.6 * rdRubber;
  rdPavR = 0.86 + (rdRgT - 0.44) * 0.4;
  rdPavN = normalize(vec3(rdNP.xy * 0.35, rdNP.z));
  rdPavAO = mix(1.0, rdAOT, 0.4);
  rdRag = 0.0;
#else
  #if defined(STYLE_HIGHWAY)
    vec3 rdTint = vec3(2.05, 2.03, 2.0);
    float rdSat = 0.6;
  #elif defined(STYLE_MOUNTAIN)
    vec3 rdTint = vec3(2.9, 2.82, 2.7);
    float rdSat = 0.35;
  #elif defined(STYLE_STREET)
    vec3 rdTint = vec3(2.4, 2.36, 2.32);
    float rdSat = 0.45;
  #else
    vec3 rdTint = vec3(2.3, 2.26, 2.18);
    float rdSat = 0.5;
  #endif
  rdPav = mix(vec3(rdTexL), rdC, rdSat) * rdTint * mix(0.8, 1.16, rdN1.r) * mix(0.92, 1.07, rdN2.g);
  // Paving runs: each ~96 m batch has its own tone; transverse joints between them.
  {
    float rdRunId = floor(rdV / 96.0);
    float rdRunH = rdHash(vec2(rdRunId, 1.3) + uSeed.x);
    rdPav *= 0.9 + 0.2 * rdRunH;
    float rdRunJ = rdBox(rdV, rdFwV, rdRunId * 96.0, 0.015) + rdBox(rdV, rdFwV, rdRunId * 96.0 + 96.0, 0.015);
    rdPav *= 1.0 - 0.45 * rdRunJ * step(rdBeyond, 0.0);
  }
  rdPavR = 0.94 + (rdRgT - 0.44) * 0.5;
  // Wheel tracks: polished binder (slightly darker, a touch glossier) + oil drip strip.
  #if defined(STYLE_HIGHWAY)
    float rdPol = 1.0;
  #elif defined(STYLE_MOUNTAIN)
    float rdPol = 0.6;
  #else
    float rdPol = 0.8;
  #endif
  rdPav *= 1.0 - rdPol * (0.1 * rdWheel + 0.14 * rdOil * smoothstep(0.3, 0.7, rdN2.r));
  rdPavR -= rdPol * 0.09 * rdWheel;
  float rdCrackFade = 1.0 - smoothstep(30.0, 110.0, rdViewDist);

  // Transverse thermal cracks: wiggly lines across the lane every ~14 m.
  {
    float rdTc = rdV / 12.0;
    float rdTcId = floor(rdTc);
    float rdTcH = rdHash(vec2(rdTcId, 3.7) + uSeed.x);
    float rdTcPos = (rdTcId + 0.25 + 0.5 * rdTcH) * 12.0
      + (texture2D(tNoise, vec2(rdW.x / 6.0, rdTcId * 0.173)).r - 0.5) * 0.9;
    #if defined(STYLE_HIGHWAY)
      float rdTcP = 0.8;
    #else
      float rdTcP = 0.35;
    #endif
    float rdTcLen = step(abs(rdU), uHalfW * (0.55 + 0.5 * rdHash(vec2(rdTcId, 9.1))));
    float rdTcC = step(rdTcP, rdTcH) * rdTcLen * rdBox(rdV, rdFwV, rdTcPos, 0.012 + 0.012 * rdTcH);
    #if defined(STYLE_HIGHWAY)
      // Sealed: a wider glossy tar band.
      float rdTcS = step(rdTcP, rdTcH) * rdTcLen * rdBox(rdV, rdFwV, rdTcPos, 0.035);
      rdPav = mix(rdPav, vec3(0.010), rdTcS * 0.85);
      rdPavR = mix(rdPavR, 0.4, rdTcS);
    #else
      rdPav *= 1.0 - 0.7 * rdTcC * rdCrackFade;
    #endif
  }
  // Longitudinal construction joint near the centre line (sealed).
  {
    float rdLj = rdBox(rdU, rdFwU, 0.32 + (rdN2.r - 0.5) * 0.05, 0.02) * step(rdBeyond, 0.0);
    rdPav = mix(rdPav, rdPav * 0.55, rdLj * 0.7);
  }

  #if defined(STYLE_MOUNTAIN) || defined(STYLE_STREET) || defined(STYLE_COUNTRY)
    #if defined(STYLE_MOUNTAIN)
      float rdPatchP = 0.86;
      float rdCrackAmt = 1.0;
    #elif defined(STYLE_STREET)
      float rdPatchP = 0.9;
      float rdCrackAmt = 0.55;
    #else
      float rdPatchP = 0.94;
      float rdCrackAmt = 0.6;
    #endif
    // Utility-cut / pothole repairs: crisp rectangles of fresher, darker mix.
    vec2 rdCellSz = vec2(2.4, 8.0);
    vec2 rdCellF = vec2(rdU + 30.0, rdV) / rdCellSz;
    vec2 rdCell = floor(rdCellF);
    vec2 rdIn = (rdCellF - rdCell) * rdCellSz;
    float rdPh = rdHash(rdCell + uSeed * 0.13);
    vec2 rdPLo = vec2(0.15 + 0.6 * rdHash(rdCell + 7.1), 0.4 + 3.0 * rdHash(rdCell + 3.3));
    vec2 rdPSz = vec2(0.7 + 1.4 * rdHash(rdCell + 1.7), 1.2 + 3.8 * rdHash(rdCell + 9.2));
    rdPSz = min(rdPSz, rdCellSz - rdPLo - 0.1);
    float rdPatch = step(rdPatchP, rdPh)
      * rdBox(rdIn.x, rdFwU, rdPLo.x + rdPSz.x * 0.5, rdPSz.x * 0.5)
      * rdBox(rdIn.y, rdFwV, rdPLo.y + rdPSz.y * 0.5, rdPSz.y * 0.5)
      * step(abs(rdU), uHalfW - 0.3);
    float rdSeam = rdPatch * (1.0 - rdBox(rdIn.x, rdFwU, rdPLo.x + rdPSz.x * 0.5, rdPSz.x * 0.5 - 0.035)
      * rdBox(rdIn.y, rdFwV, rdPLo.y + rdPSz.y * 0.5, rdPSz.y * 0.5 - 0.035));
    // Skin patches: irregular blobs of newer seal.
    float rdBlob = smoothstep(0.76, 0.775, rdN2.r * 0.3 + rdN1.g * 0.7) * step(abs(rdU), uHalfW - 0.2);
    float rdNew = max(rdPatch, rdBlob * 0.75);
    rdPav = mix(rdPav, rdPav * vec3(0.52, 0.52, 0.54), rdNew);
    rdPav *= 1.0 - 0.45 * rdSeam;
    rdPavR = mix(rdPavR, 0.86, rdNew);
    // Fatigue (alligator) cracking: only in wheel paths of distressed stretches and at the edges.
    float rdCellD = texture2D(tNoise, rdW / 6.0 + 0.5).b;
    float rdCrW = 0.035;
    float rdCrack = 1.0 - smoothstep(rdCrW, rdCrW + max(fwidth(rdCellD), 1e-3) * 1.2, rdCellD);
    float rdDistress = max(rdWheel * smoothstep(0.62, 0.74, rdN1.r),
      smoothstep(rdA - 1.0, rdA - 0.2, abs(rdU)) * smoothstep(0.45, 0.65, rdN2.r));
    rdCrack *= rdDistress * rdCrackAmt * (1.0 - rdNew) * rdCrackFade;
    rdPav *= 1.0 - 0.55 * rdCrack;
    // Tar snakes: sealed cracks along meandering fbm contours, black and glossy.
    float rdSnN = texture2D(tNoise, (rdW + vec2(13.0, 5.0)) / vec2(16.0, 48.0)).r;
    float rdSnD = abs(rdSnN - 0.5);
    float rdSnake = 1.0 - smoothstep(0.006, 0.006 + max(fwidth(rdSnN), 1e-3) * 1.2, rdSnD);
    rdSnake *= smoothstep(0.5, 0.65, rdN1.g) * rdCrackAmt * (1.0 - rdPatch) * step(abs(rdU), rdA - 0.15);
    rdPav = mix(rdPav, vec3(0.011, 0.011, 0.012), rdSnake * 0.85);
    rdPavR = mix(rdPavR, 0.38, rdSnake);
    rdPavN = normalize(vec3(rdPavN.xy * (1.0 - 0.6 * rdSnake), rdPavN.z));
  #endif
  #if defined(STYLE_STREET)
    // Concrete gutter pan along the edge.
    float rdGut = smoothstep(rdA - 0.55, rdA - 0.55 + rdFwU, abs(rdU)) * step(rdBeyond, 0.0);
    rdPav = mix(rdPav, vec3(0.25, 0.245, 0.23) * (0.85 + 0.3 * rdN3.r), rdGut);
    rdPavR = mix(rdPavR, 0.86, rdGut);
    rdRag = 0.0;
  #endif
#endif

// ---- paved ↔ verge ----------------------------------------------------
float rdEdgeW = max(rdFwU, 0.006);
float rdPaved = 1.0 - smoothstep(rdA + rdRag - rdEdgeW, rdA + rdRag + rdEdgeW, rdQ);
#if defined(STYLE_STREET)
  // Raised-looking concrete sidewalk strip instead of gravel.
  vec3 rdVerge = vec3(0.3, 0.295, 0.28) * (0.85 + 0.3 * rdN3.r) * (1.0 - 0.25 * rdLines(rdV, rdFwV, 1.5, 0.02));
  float rdVergeR = 0.85;
  vec3 rdVergeN = vec3(rdNP.xy * 0.3, rdNP.z);
#elif defined(STYLE_DIRT)
  vec3 rdVerge = rdC * vec3(0.95, 0.9, 0.8);
  float rdVergeR = 0.95;
  vec3 rdVergeN = rdNP;
#else
  float rdCrumb = 1.0 - smoothstep(0.0, 0.35, rdQ - rdA - rdRag);
  vec3 rdVerge = mix(rdGc, rdPav * 0.9, rdCrumb * 0.5 * step(rdN3.a, 0.6));
  float rdVergeR = 0.97;
  vec3 rdVergeN = rdGN;
#endif
vec3 rdCol = mix(rdVerge, rdPav, rdPaved);
float rdRough = mix(rdVergeR, rdPavR, rdPaved);
vec3 rdN = normalize(mix(rdVergeN, rdPavN, rdPaved));
float rdAO = mix(1.0, rdPavAO, rdPaved);

// ---- markings ---------------------------------------------------------
vec3 rdEmis = vec3(0.0);
float rdSpecMul = 1.0;
#if !defined(MARK_NONE) && !defined(RD_FRINGE)
{
  const vec3 rdWhite = vec3(0.70, 0.70, 0.68);
  const vec3 rdYellow = vec3(0.62, 0.37, 0.035);
  float rdNoCap = 1.0 - smoothstep(0.0, max(rdFwV, 0.05), rdBeyond);
  float rdEdgeKeep = rdKeep(vMouth, 0.15) * rdNoCap;
  float rdCenterKeep = rdKeep(rdMarkD, 0.4) * rdNoCap;
  bool rdYields = abs(rdJDir) > 0.5;
  #if defined(STYLE_STREET)
    float rdStopAt = uFillet + 3.8;
  #else
    float rdStopAt = uFillet + 0.9;
  #endif
  if (rdYields) rdCenterKeep *= smoothstep(rdStopAt + 0.45, rdStopAt + 0.45 + max(fwidth(rdXw), 0.01), rdXw);
  float rdMW = 0.0;
  float rdMY = 0.0;
  #if defined(STYLE_HIGHWAY)
    float rdEdgeHW = 0.1;
  #else
    float rdEdgeHW = 0.075;
  #endif
  rdMW += rdBox(abs(rdU), rdFwU, uHalfW - 0.3, rdEdgeHW) * rdEdgeKeep;
  #if defined(MARK_HIGHWAY)
    rdMY += (rdBox(rdU, rdFwU, 0.13, 0.065) + rdBox(rdU, rdFwU, -0.13, 0.065)) * rdCenterKeep;
    float rdDashV = rdDash(rdV, rdFwV, 12.0, 3.0);
    for (int k = 1; k < 4; k++) {
      if (float(k) >= uLanes) break;
      rdMW += rdBox(abs(rdU), rdFwU, float(k) * rdLaneW, 0.075) * rdDashV * rdCenterKeep;
    }
  #elif defined(MARK_CENTER)
    float rdDashV = rdDash(rdV, rdFwV, 12.0, 3.0);
    float rdPR = step(0.5, vMisc.y);
    float rdPL = step(0.5, vMisc.z);
    #if defined(STYLE_MOUNTAIN)
      rdMY += rdBox(rdU, rdFwU, 0.12, 0.06) * mix(1.0, rdDashV, rdPR) * rdCenterKeep;
      rdMY += rdBox(rdU, rdFwU, -0.12, 0.06) * mix(1.0, rdDashV, rdPL) * rdCenterKeep;
    #else
      rdMY += rdBox(rdU, rdFwU, 0.0, 0.065) * mix(1.0, rdDashV, rdPR * rdPL) * rdCenterKeep;
    #endif
  #endif
  // Stop line across the incoming lane where this road yields.
  #if !defined(STYLE_ARENA) && !defined(STYLE_HIGHWAY)
  if (rdYields) {
    float rdSide = rdJDir > 0.0 ? rdU : -rdU;
    float rdLane = rdBox(rdSide, rdFwU, (uHalfW - 0.4 + 0.15) * 0.5, (uHalfW - 0.4 - 0.15) * 0.5);
    rdMW += rdLane * rdBox(rdXw, max(fwidth(rdXw), 1e-3), rdStopAt + 0.22, 0.22) * rdNoCap;
  }
  #endif
  #if defined(STYLE_STREET)
    // Continental crosswalk on every leg, set back past the curb return.
    float rdXwC = uFillet + 1.9;
    float rdBand = rdBox(rdXw, max(fwidth(rdXw), 1e-3), rdXwC, 1.5) * step(rdMarkD, 40.0);
    float rdBars = rdDash(rdU + 40.25, rdFwU, 1.0, 0.5) * rdBox(abs(rdU), rdFwU, 0.0, uHalfW - 0.6);
    rdMW += rdBand * rdBars * rdNoCap;
  #endif
  // Wear: paint lost off aggregate peaks, in wheel paths, and in patches.
  float rdWear = uWear * (0.55 * (1.0 - smoothstep(0.2, 0.75, rdN3.a * 0.5 + rdN2.r * 0.5))
    + 0.35 * rdWheel + 0.35 * (1.0 - rdN1.r));
  float rdKeepPaint = clamp(1.0 - rdWear, 0.0, 1.0) * mix(0.75, 1.0, smoothstep(0.08, 0.3, rdTexL / 0.12 * 0.2 + rdN3.r * 0.5));
  rdMW = min(rdMW, 1.0) * rdKeepPaint * rdPaved;
  rdMY = min(rdMY, 1.0) * rdKeepPaint * rdPaved;
  float rdPaint = min(1.0, rdMW + rdMY);
  vec3 rdPaintC = (rdMW * rdWhite + rdMY * rdYellow) / max(rdMW + rdMY, 1e-4);
  rdPaintC *= 0.88 + 0.24 * clamp(rdTexL / 0.035, 0.0, 1.5) * 0.5;
  rdCol = mix(rdCol, rdPaintC, rdPaint);
  rdRough = mix(rdRough, 0.5, rdPaint);
  rdSpecMul = mix(1.0, 2.0, rdPaint);
  rdN = normalize(vec3(rdN.xy * (1.0 - 0.5 * rdPaint), rdN.z));
  // Glass-bead retroreflection: brightens toward grazing view.
  float rdNdV = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  rdEmis = rdPaintC * rdPaint * uRetro * pow(1.0 - rdNdV, 4.0);
}
#endif

rdN = normalize(vec3(rdN.xy * rdNStr, rdN.z));
diffuseColor.rgb = rdCol;

#ifdef RD_FRINGE
  float rdFade = 1.0 - smoothstep(rdCore + 0.35, rdCore + uFringeW,
    rdQ + (rdN3.g - 0.5) * 0.55 + (rdN2.r - 0.5) * 0.6);
  diffuseColor.a = rdFade;
  if (rdFade <= 0.003) discard;
#endif
`;

export const ROAD_FRAGMENT_ROUGHNESS = /* glsl */ `
float roughnessFactor = clamp(rdRough, 0.04, 1.0);
`;

export const ROAD_FRAGMENT_NORMAL = /* glsl */ `
{
  mat3 rdTBN = rdTangentFrame(-vViewPosition, normal, vRoadUV);
  normal = normalize(rdTBN * rdN);
}
`;

export const ROAD_FRAGMENT_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += rdEmis;
`;

export const ROAD_FRAGMENT_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= rdAO;
reflectedLight.indirectSpecular *= mix(1.0, rdAO, 0.6);
`;
