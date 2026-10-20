/**
 * Flexbody skin (A2, U6 perf pass): node texture + the `flex2` vertex patch
 * + MERGED draws. Contract: ./types.ts "NODE TEXTURE" and "FLEXBODY SHADER
 * PATCH", docs/CONTRACTS.md "Vehicle perf amendments". The CPU mirror of
 * the GLSL below is binder.ts evalFlexFrame / evalFlexVertexSingle —
 * change both together (flexskin.test.ts checks the constants match).
 *
 * DRAWS: panels sharing (material slot, damage variant) are merged into one
 * Mesh per LOD level; every vertex carries its panel index (flexFrameU.w,
 * an exact float) and a hidden-panel mask texture (one R8 texel per panel,
 * 64 wide like the node texture) collapses hidden panels (detached 'hide'
 * trim, shattered tempered glass) to a point in the vertex stage. Detached
 * 'follow' panels stay in their merged draw and keep skinning to their own
 * flying nodes. Glass panes merge into one draw too (the damage patch reads
 * per-pane crack uniforms by panel index).
 *
 * LOD (lods.ts): level 0 = the full binding with the 3-triad blend in the
 * colour pass; levels 1, 2 = coarser bindings (same panels by id) evaluated
 * with ONE triad (the strongest-weight slot 0: 3 + 3 texel fetches instead
 * of 9 + 9). Shadows never draw the colour meshes: one merged CASTER mesh
 * per shadow LOD (every castShadow panel, single triad, lean attributes) —
 * LOD1 into cascade 0, LOD2 into cascades ≥ 1 (shadowlod.ts switches them
 * around the shadow pass). Without a renderer hook (tests, dev harnesses)
 * the colour meshes cast their own shadows ("direct" mode).
 *
 * The patch goes through patchMaterial's flexbody slot, so the color,
 * depth (CSM cascades) and distance materials all reconstruct the same
 * deformed surface: shadows are cast by the DEFORMED body. Depth and
 * distance targets always use the single-triad evaluation.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  Sphere,
  UnsignedByteType,
  type Camera,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';

import type { PatchTarget, ShaderPatch } from '../types';
import { FLEX_FAR, FLEX_NORMAL_EPS } from './binder';
import { lodDistance, selectVehicleLod } from './lods';
import { attachShadowLod, shadowLodAvailable, type ShadowLodClient } from './shadowlod';
import {
  FLEX_AGREE_FLOOR,
  FLEX_CONSENSUS,
  FLEX_CROSS_FLOOR,
  FLEX_CRUMPLE_AMP,
  FLEX_GS_FLOOR,
  FLEX_HEALTHY_SLACK,
  FLEX_HEALTHY_STRETCH,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEX_QUALITY_FLOOR,
  FLEX_SIN_FLOOR,
  FLEX_TRIADS,
  FLEXBODY_PATCH_KEY,
  NODE_TEX_FLAG_BROKEN,
  NODE_TEX_WIDTH,
  type BindingPanel,
  type BindingSet,
  type FlexSkin,
  type FlexSkinOptions,
  type VehicleFrameInput,
  type Vec3T,
} from './types';

const K = FLEX_TRIADS;
/** Patch key of the all-single-triad variant (LOD ≥ 1 colour + every caster). */
export const FLEXBODY_SINGLE_PATCH_KEY = 'flex2s';

/** GLSL float literal. */
function f(x: number): string {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** One triad's GLSL call (k = 0..2). */
const triadCall = (k: number): string =>
  `\tflexTriad( flexTriad${k}, flexCoef${k}, flexFrame${k}.xyz, ft${k}, P${k}, W${k}, N${k}, T${k}, accD );\n`;

/**
 * CRUMPLE FOLDS (types.ts "FLEXBODY SHADER PATCH v2"): a cosmetic sheet-metal
 * fold field in REST space (never swims), in about [−0.3, 0.6] — biased
 * OUTWARD: interior trim sits a few cm behind the door skins and an inward
 * fold would push the skin through it (a hole showing the door card):
 * accordion ridges across the car's long axis (frontal / rear crush buckles
 * panels into folds across z) broken up by an isotropic buckle family.
 * The vertex stage displaces along the blended normal by
 * FLEX_CRUMPLE_AMP · strain · damageWeight · flexCrumple(rest) in EVERY
 * target (shadows fold too); the damage fragment patch adds the same height
 * to its bump so the folds shade. Stage-agnostic GLSL (both stages include it).
 */
export const FLEX_CRUMPLE_GLSL = /* glsl */ `
vec3 flexMod289( vec3 x ) {
	return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0;
}
vec4 flexMod289( vec4 x ) {
	return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0;
}
vec4 flexPermute( vec4 x ) {
	return flexMod289( ( x * 34.0 + 10.0 ) * x );
}
// 3D simplex noise in about [-0.97, 0.97] with its ANALYTIC gradient (webgl-noise, Ashima Arts /
// Stefan Gustavson, MIT; kernel radius 0.5: C2, no lattice-aligned flat lines like value noise).
// Shading takes slopes from this gradient, never from dFdx / dFdy of a procedural height: screen
// derivatives are constant over each 2x2 pixel quad (always under SwiftShader, coarse on many GPUs),
// which lit every quad flat (4x4 screen-pixel blocks at the 0.5 software render scale).
float flexSnoise( vec3 v, out vec3 grad ) {
	const vec2 C = vec2( 1.0 / 6.0, 1.0 / 3.0 );
	vec3 i = floor( v + dot( v, C.yyy ) );
	vec3 x0 = v - i + dot( i, C.xxx );
	vec3 g = step( x0.yzx, x0.xyz );
	vec3 l = 1.0 - g;
	vec3 i1 = min( g.xyz, l.zxy );
	vec3 i2 = max( g.xyz, l.zxy );
	vec3 x1 = x0 - i1 + C.xxx;
	vec3 x2 = x0 - i2 + C.yyy;
	vec3 x3 = x0 - 0.5;
	i = flexMod289( i );
	vec4 p = flexPermute( flexPermute( flexPermute( i.z + vec4( 0.0, i1.z, i2.z, 1.0 ) ) + i.y + vec4( 0.0, i1.y, i2.y, 1.0 ) ) + i.x + vec4( 0.0, i1.x, i2.x, 1.0 ) );
	vec4 j = p - 49.0 * floor( p * ( 1.0 / 49.0 ) );
	vec4 xg = floor( j * ( 1.0 / 7.0 ) );
	vec4 yg = floor( j - 7.0 * xg );
	vec4 x = xg * ( 2.0 / 7.0 ) + ( 0.5 / 7.0 - 1.0 );
	vec4 y = yg * ( 2.0 / 7.0 ) + ( 0.5 / 7.0 - 1.0 );
	vec4 h = 1.0 - abs( x ) - abs( y );
	vec4 b0 = vec4( x.xy, y.xy );
	vec4 b1 = vec4( x.zw, y.zw );
	vec4 s0 = floor( b0 ) * 2.0 + 1.0;
	vec4 s1 = floor( b1 ) * 2.0 + 1.0;
	vec4 sh = -step( h, vec4( 0.0 ) );
	vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
	vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
	vec3 g0 = normalize( vec3( a0.xy, h.x ) );
	vec3 g1 = normalize( vec3( a0.zw, h.y ) );
	vec3 g2 = normalize( vec3( a1.xy, h.z ) );
	vec3 g3 = normalize( vec3( a1.zw, h.w ) );
	vec4 m = max( 0.5 - vec4( dot( x0, x0 ), dot( x1, x1 ), dot( x2, x2 ), dot( x3, x3 ) ), 0.0 );
	vec4 m2 = m * m;
	vec4 m3 = m2 * m;
	vec4 m4 = m2 * m2;
	vec4 pd = vec4( dot( g0, x0 ), dot( g1, x1 ), dot( g2, x2 ), dot( g3, x3 ) );
	vec4 t = -8.0 * m3 * pd;
	grad = 105.0 * ( t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3 + m4.x * g0 + m4.y * g1 + m4.z * g2 + m4.w * g3 );
	return 105.0 * dot( m4, pd );
}
// Ridged noise 1 - |n| (sharp crest at n = 0) with gradient; e > 0 rounds the crest over about e
// (anti-aliasing: e ~ the noise change across one pixel).
float flexRidge( float n, vec3 gn, float e, out vec3 g ) {
	float s = sqrt( n * n + e * e );
	g = -( n / max( s, 1e-6 ) ) * gn;
	return 1.0 - ( s - e );
}
// Crumple fold field (rest space) and its rest-space gradient; e as flexRidge (0 = exact crests).
float flexCrumpleG( vec3 p, float e, out vec3 g ) {
	vec3 sa = vec3( 1.7, 2.3, 5.2 );
	vec3 ga, gb, ra, rb;
	float a = flexRidge( flexSnoise( p * sa + 3.1, ga ), ga * sa, e, ra );
	float b = flexRidge( flexSnoise( p * 3.1 + 9.7, gb ), gb * 3.1, e, rb );
	g = 1.4 * a * ra + 0.9 * b * rb;
	return 0.7 * ( a * a - 0.2 ) + 0.45 * ( b * b - 0.3 );
}
float flexCrumple( vec3 p ) {
	vec3 g;
	return flexCrumpleG( p, 0.0, g );
}
`;

/**
 * Declarations + the per-vertex evaluation (vertex stage, after <common>).
 * FLEXBODY_COLOR = color target only (tangents + damage varyings);
 * FLEXBODY_SINGLE = triad slot 0 only (weight 1, no consensus): depth and
 * distance always, colour at LOD ≥ 1. Mirrors binder.ts evalTriadSlot /
 * evalFlexFrame / evalFlexVertexSingle (types.ts "FLEXBODY RECONSTRUCTION
 * v2"); flexEvaluate() runs first thing in main() and the replaced chunks
 * read its results. flexFrameU.w = the vertex's panel index: hidden panels
 * (uFlexHidden texel > 0.5) collapse to the skin origin (degenerate).
 * Single-triad geometry packs flexFrameU = (ft0.y, ft0.z, damageWeight, panel).
 */
export const FLEX_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uFlexNodes;
uniform int uFlexRows;
uniform highp sampler2D uFlexHidden;
attribute vec4 flexTriad0;
attribute vec4 flexCoef0;
attribute vec4 flexFrame0;
#ifndef FLEXBODY_SINGLE
attribute vec4 flexTriad1;
attribute vec4 flexTriad2;
attribute vec4 flexCoef1;
attribute vec4 flexCoef2;
attribute vec4 flexFrame1;
attribute vec4 flexFrame2;
#endif
attribute vec4 flexFrameU;
#ifdef FLEXBODY_COLOR
#ifndef FLEXBODY_SINGLE
attribute vec4 flexFrameT;
#endif
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
flat varying float vFlexPanel;
#endif
vec3 flexP;
vec3 flexN;
vec3 flexT;
${FLEX_CRUMPLE_GLSL}
vec4 flexNode( int i, int block ) {
	return texelFetch( uFlexNodes, ivec2( i & ${NODE_TEX_WIDTH - 1}, ( i >> 6 ) + block * uFlexRows ), 0 );
}
vec3 flexSafeNormalize( vec3 v ) {
	float l = length( v );
	return l > ${f(FLEX_NORMAL_EPS)} ? v / l : vec3( 0.0, 1.0, 0.0 );
}
bool flexHidden() {
	int p = int( flexFrameU.w + 0.5 );
	return texelFetch( uFlexHidden, ivec2( p & ${NODE_TEX_WIDTH - 1}, p >> 6 ), 0 ).r > 0.5;
}
void flexTriad( vec4 tri, vec4 coef, vec3 fn, vec3 ft, out vec3 P, out float W, out vec3 N, out vec3 T, inout vec4 accD ) {
	ivec3 idx = ivec3( tri.xyz + 0.5 );
	vec4 nR = flexNode( idx.x, 0 );
	vec4 nX = flexNode( idx.y, 0 );
	vec4 nY = flexNode( idx.z, 0 );
	vec3 e1 = nX.xyz - nR.xyz;
	vec3 e2 = nY.xyz - nR.xyz;
	vec3 cr = cross( e1, e2 );
	float L = length( cr );
	float l1 = length( e1 );
	float m = max( l1 * length( e2 ), ${f(FLEX_CROSS_FLOOR)} );
	vec3 o = coef.x * e1 + coef.y * e2 + coef.z * ( cr / max( L, ${f(FLEX_SIN_FLOOR)} * m ) );
	float lo = length( o );
	float lim = ${f(FLEX_MAX_STRETCH)} * coef.w + ${f(FLEX_MAX_SLACK)};
	float q = 0.0;
	if ( lo <= lim ) {
		q = ( 1.0 - smoothstep( ${f(FLEX_HEALTHY_STRETCH)} * coef.w + ${f(FLEX_HEALTHY_SLACK)}, lim, lo ) )
			* smoothstep( ${f(0.5 * FLEX_SIN_FLOOR)}, ${f(2 * FLEX_SIN_FLOOR)}, L / m );
	} else {
		o = lo < ${f(FLEX_FAR)} ? o * ( lim / lo ) : vec3( 0.0 );
	}
	P = nR.xyz + o;
	W = tri.w * max( q, ${f(FLEX_QUALITY_FLOOR)} );
	vec3 f1 = e1 / max( l1, ${f(FLEX_GS_FLOOR)} );
	vec3 t = e2 - dot( e2, f1 ) * f1;
	vec3 f2 = t / max( length( t ), ${f(FLEX_GS_FLOOR)} );
	mat3 F = mat3( f1, f2, cross( f1, f2 ) );
	N = F * fn;
	T = F * ft;
	float wX = clamp( coef.x, 0.0, 1.0 );
	float wY = clamp( coef.y, 0.0, 1.0 );
	float wR = max( 0.0, 1.0 - wX - wY );
	vec3 d = ( wR * flexNode( idx.x, 1 ).xyz + wX * flexNode( idx.y, 1 ).xyz + wY * flexNode( idx.z, 1 ).xyz ) / ( wR + wX + wY );
	int fl = int( nR.w + 0.5 ) | int( nX.w + 0.5 ) | int( nY.w + 0.5 );
	accD += tri.w * vec4( d, ( fl & ${NODE_TEX_FLAG_BROKEN} ) != 0 ? 1.0 : 0.0 );
}
float flexConsensus( float W, vec3 P, vec3 Pm ) {
	vec3 d = P - Pm;
	return W / ( 1.0 + dot( d, d ) * ${f(1 / (FLEX_CONSENSUS * FLEX_CONSENSUS))} );
}
float flexAgree( float C, vec3 N, vec3 Nm ) {
	return C * ( ${f(FLEX_AGREE_FLOOR)} + smoothstep( -0.2, 0.8, dot( N, Nm ) ) );
}
void flexEvaluate() {
#ifdef FLEXBODY_COLOR
	vFlexRest = position;
	vFlexPanel = flexFrameU.w;
	vFlexDamage = vec4( 0.0 );
#endif
	if ( flexHidden() ) {
		flexP = vec3( 0.0 );
		flexN = vec3( 0.0, 1.0, 0.0 );
		flexT = vec3( 1.0, 0.0, 0.0 );
		return;
	}
	vec4 accD = vec4( 0.0 );
#ifdef FLEXBODY_SINGLE
	vec3 P0, N0, T0;
	float W0;
#ifdef FLEXBODY_COLOR
	vec3 ft0 = vec3( flexFrame0.w, flexFrameU.xy );
#else
	vec3 ft0 = vec3( 0.0 );
#endif
	flexTriad( vec4( flexTriad0.xyz, 1.0 ), flexCoef0, flexFrame0.xyz, ft0, P0, W0, N0, T0, accD );
	flexP = P0;
	flexN = flexSafeNormalize( N0 );
	flexT = flexSafeNormalize( T0 - dot( T0, flexN ) * flexN );
#else
	vec3 P0, P1, P2, N0, N1, N2, T0, T1, T2;
	float W0, W1, W2;
#ifdef FLEXBODY_COLOR
	vec3 ft0 = vec3( flexFrame0.w, flexFrameT.xy );
	vec3 ft1 = vec3( flexFrame1.w, flexFrameT.zw );
	vec3 ft2 = vec3( flexFrame2.w, flexFrameU.xy );
#else
	vec3 ft0 = vec3( 0.0 ), ft1 = vec3( 0.0 ), ft2 = vec3( 0.0 );
#endif
${triadCall(0)}${triadCall(1)}${triadCall(2)}	vec3 Pm = ( W0 * P0 + W1 * P1 + W2 * P2 ) / ( W0 + W1 + W2 );
	float C0 = flexConsensus( W0, P0, Pm );
	float C1 = flexConsensus( W1, P1, Pm );
	float C2 = flexConsensus( W2, P2, Pm );
	flexP = ( C0 * P0 + C1 * P1 + C2 * P2 ) / ( C0 + C1 + C2 );
	vec3 Nm = flexSafeNormalize( C0 * N0 + C1 * N1 + C2 * N2 );
	float A0 = flexAgree( C0, N0, Nm );
	float A1 = flexAgree( C1, N1, Nm );
	float A2 = flexAgree( C2, N2, Nm );
	flexN = flexSafeNormalize( A0 * N0 + A1 * N1 + A2 * N2 );
	vec3 Tb = A0 * T0 + A1 * T1 + A2 * T2;
	flexT = flexSafeNormalize( Tb - dot( Tb, flexN ) * flexN );
#endif
	flexP += flexN * ( ${f(FLEX_CRUMPLE_AMP)} * accD.x * flexFrameU.z * flexCrumple( position ) );
#ifdef FLEXBODY_COLOR
	vFlexDamage = vec4( accD.xyz * flexFrameU.z, accD.w );
#endif
}
`;

/** Replaces <beginnormal_vertex>: the blended, re-orthonormalized frame. */
export const FLEX_NORMAL_CHUNK = /* glsl */ `
vec3 objectNormal = flexN;
#ifdef USE_TANGENT
vec3 objectTangent = flexT;
#endif
`;

/** Replaces <begin_vertex>: the blended position. */
export const FLEX_POSITION_CHUNK = /* glsl */ `
vec3 transformed = flexP;
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif
`;

/** Injected as the first statement of main(). */
export const FLEX_MAIN_CALL = '\tflexEvaluate();';

const FRAGMENT_PARS = /* glsl */ `
#define FLEXBODY
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
flat varying float vFlexPanel;
`;

/**
 * Applies the flex2 edit to a program's sources (exported for tests / the
 * e2e compile check). Depth / distance targets are always single-triad;
 * `single` makes the colour target single-triad too (LOD ≥ 1).
 */
export function applyFlexGlsl(shader: { vertexShader: string; fragmentShader: string }, target: PatchTarget, single = false): void {
  const vs = shader.vertexShader;
  for (const chunk of ['#include <common>', '#include <begin_vertex>', 'void main() {']) {
    if (!vs.includes(chunk)) throw new Error(`flexbody: vertex shader lacks ${chunk}`);
  }
  let defines = target === 'color' ? '#define FLEXBODY\n#define FLEXBODY_COLOR\n' : '#define FLEXBODY\n';
  if (single || target !== 'color') defines += '#define FLEXBODY_SINGLE\n';
  shader.vertexShader =
    defines +
    vs
      .replace('#include <common>', `#include <common>\n${FLEX_VERTEX_PARS}`)
      .replace('void main() {', `void main() {\n${FLEX_MAIN_CALL}`)
      .replace('#include <beginnormal_vertex>', FLEX_NORMAL_CHUNK)
      .replace('#include <begin_vertex>', FLEX_POSITION_CHUNK);
  if (target === 'color') shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader;
}

/** Hidden-panel mask: one R8 texel per panel (64 wide, rows = ⌈panels / 64⌉); > 0.5 = hidden. */
export function createHiddenMask(panelCount: number): DataTexture {
  const rows = Math.max(1, Math.ceil(panelCount / NODE_TEX_WIDTH));
  const t = new DataTexture(new Uint8Array(NODE_TEX_WIDTH * rows), NODE_TEX_WIDTH, rows, RedFormat, UnsignedByteType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/**
 * The flex2 ShaderPatch bound to one node texture (uniform objects shared
 * by every material of the skin). `single` = the all-single-triad variant
 * (key flex2s). `hidden` defaults to an all-visible mask.
 */
export function createFlexPatch(texture: DataTexture, rows: number, hidden: DataTexture = createHiddenMask(1), single = false): ShaderPatch {
  const uNodes = { value: texture };
  const uRows = { value: rows };
  const uHidden = { value: hidden };
  return {
    key: single ? FLEXBODY_SINGLE_PATCH_KEY : FLEXBODY_PATCH_KEY,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      shader.uniforms.uFlexNodes = uNodes;
      shader.uniforms.uFlexRows = uRows;
      shader.uniforms.uFlexHidden = uHidden;
      applyFlexGlsl(shader, target, single);
    },
  };
}

/** rows per block for nodeCount nodes. */
export function nodeTextureRows(nodeCount: number): number {
  return Math.max(1, Math.ceil(nodeCount / NODE_TEX_WIDTH));
}

/**
 * Attribute layout of a skin geometry:
 *   full    3 triads (LOD0 colour): position, normal, uv, [tangent], flexTriad/Coef/Frame 0..2, flexFrameT, flexFrameU
 *   single  slot 0 only (LOD ≥ 1 colour): position, uv, [tangent], flexTriad0 (w = 1), flexCoef0, flexFrame0, flexFrameU = (ft0.y, ft0.z, dmgW, panel)
 *   caster  slot 0 only, depth programs: position, flexTriad0, flexCoef0, flexFrame0, flexFrameU = (0, 0, dmgW, panel)
 */
export type SkinGeometryLayout = 'full' | 'single' | 'caster';

export interface MergedPanel {
  panel: BindingPanel<string>;
  /** Index written to flexFrameU.w (the hidden-mask texel). */
  maskIndex: number;
}

/** Panel geometry (one panel, full layout, mask index = panelIndex): dev parity harness, tests. */
export function buildPanelGeometry(p: BindingPanel<string>): BufferGeometry {
  return buildSkinGeometry([{ panel: p, maskIndex: p.panelIndex }], 'full');
}

/** Merged geometry of `parts` in order (vertex ranges consecutive, indices offset). */
export function buildSkinGeometry(parts: readonly MergedPanel[], layout: SkinGeometryLayout): BufferGeometry {
  let n = 0;
  let ni = 0;
  let tangents = layout !== 'caster';
  for (const { panel: p } of parts) {
    n += p.vertexCount;
    ni += p.index.length;
    if (!p.restTangent || !p.frameTangent) tangents = false;
  }
  const g = new BufferGeometry();
  const pos = new Float32Array(n * 3);
  const nrm = layout === 'full' ? new Float32Array(n * 3) : null;
  const uv = layout !== 'caster' ? new Float32Array(n * 2) : null;
  const tan = tangents ? new Float32Array(n * 4) : null;
  const slots = layout === 'full' ? K : 1;
  const tri: Float32Array[] = [];
  const coef: Float32Array[] = [];
  const frame: Float32Array[] = [];
  for (let k = 0; k < slots; k++) {
    tri.push(new Float32Array(n * 4));
    coef.push(new Float32Array(n * 4));
    frame.push(new Float32Array(n * 4));
  }
  const T = layout === 'full' ? new Float32Array(n * 4) : null;
  const U = new Float32Array(n * 4);
  const index = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const { panel: p, maskIndex } of parts) {
    const pn = p.vertexCount;
    pos.set(p.restPosition, 3 * vo);
    nrm?.set(p.restNormal, 3 * vo);
    uv?.set(p.uv, 2 * vo);
    if (tan && p.restTangent) tan.set(p.restTangent, 4 * vo);
    for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i]! + vo;
    const ft = p.frameTangent;
    for (let v = 0; v < pn; v++) {
      const d = 4 * (vo + v);
      for (let k = 0; k < slots; k++) {
        const s = K * v + k;
        const tk = tri[k]!;
        tk[d] = p.triad[3 * s]!;
        tk[d + 1] = p.triad[3 * s + 1]!;
        tk[d + 2] = p.triad[3 * s + 2]!;
        tk[d + 3] = slots === 1 ? 1 : p.weight[s]!;
        const ck = coef[k]!;
        for (let c = 0; c < 4; c++) ck[d + c] = p.coef[4 * s + c]!;
        const fk = frame[k]!;
        fk[d] = p.frameNormal[3 * s]!;
        fk[d + 1] = p.frameNormal[3 * s + 1]!;
        fk[d + 2] = p.frameNormal[3 * s + 2]!;
        if (ft && layout !== 'caster') {
          fk[d + 3] = ft[3 * s]!;
          if (slots === 1) {
            U[d] = ft[3 * s + 1]!;
            U[d + 1] = ft[3 * s + 2]!;
          } else if (k === 2) {
            U[d] = ft[3 * s + 1]!;
            U[d + 1] = ft[3 * s + 2]!;
          } else {
            T![d + 2 * k] = ft[3 * s + 1]!;
            T![d + 2 * k + 1] = ft[3 * s + 2]!;
          }
        }
      }
      U[d + 2] = p.damageWeight[v]!;
      U[d + 3] = maskIndex;
    }
    vo += pn;
    io += p.index.length;
  }
  g.setAttribute('position', new BufferAttribute(pos, 3));
  if (nrm) g.setAttribute('normal', new BufferAttribute(nrm, 3));
  if (uv) g.setAttribute('uv', new BufferAttribute(uv, 2));
  for (let k = 0; k < slots; k++) {
    g.setAttribute(`flexTriad${k}`, new BufferAttribute(tri[k]!, 4));
    g.setAttribute(`flexCoef${k}`, new BufferAttribute(coef[k]!, 4));
    g.setAttribute(`flexFrame${k}`, new BufferAttribute(frame[k]!, 4));
  }
  if (T) g.setAttribute('flexFrameT', new BufferAttribute(T, 4));
  g.setAttribute('flexFrameU', new BufferAttribute(U, 4));
  if (tan) g.setAttribute('tangent', new BufferAttribute(tan, 4));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = new Sphere();
  return g;
}

/** Clone a base material keeping a hook + cache key the base carries as own properties (Material.copy drops them). */
export function cloneBaseMaterial<M extends Material>(base: M): M {
  const m = base.clone() as M;
  if (Object.prototype.hasOwnProperty.call(base, 'onBeforeCompile')) m.onBeforeCompile = base.onBeforeCompile;
  if (Object.prototype.hasOwnProperty.call(base, 'customProgramCacheKey')) m.customProgramCacheKey = base.customProgramCacheKey;
  return m;
}

export interface FlexSkinExtraOptions {
  /** Object-local anchor node (CompiledVehicle.frameNodes[0]); default 0. */
  anchorNode?: number;
  /** Static-sag calibration (see SettleCalibration); null/absent = off. */
  settle?: SettleOptions | null;
  /** Coarser bindings for LOD1, LOD2 (same rig; panels matched to the LOD0 binding by panelId). */
  lods?: readonly BindingSet[];
  /** Renderer for the shadow-pass caster switch (shadowlod.ts); absent = colour meshes cast directly. */
  renderer?: WebGLRenderer | null;
}

export interface SettleOptions {
  /** Rig REST node positions (CompiledRig.nodePos), object-local xyz. */
  restNodes: ArrayLike<number>;
  /** CompiledVehicle.frameNodes: origin, front, top. */
  frameNodes: ArrayLike<number>;
  /** Nodes [0, bodyNodeCount) are calibrated (wheels never: tyre squash is real). */
  bodyNodeCount: number;
}

export const SETTLE_DEFAULTS = {
  /** Calibrate only this long (s of frames) after a spawn / repair: never on a wreck that came to rest. */
  windowS: 6,
  /** Settled = anchor slower than this (m/s) and upright (frame up · world Y ≥ minUp)… */
  maxSpeed: 0.2,
  minUp: 0.9,
  /** …for waitS, then node deviations are averaged over sampleS. */
  waitS: 0.35,
  sampleS: 0.4,
  /** Per-node offset cap, m. */
  maxOffset: 0.12,
  /** Fade-in of a fresh calibration, s. */
  fadeS: 0.3,
} as const;

/**
 * SETTLE CALIBRATION — the visual bind pose is the SETTLED pose. The sim's
 * light sub-rigs sag under gravity at rest (the sedan's hood centre node
 * hood_2C drops 5.8 cm: a near-flat pin-jointed grid has no out-of-plane
 * stiffness and that node has no support rest; the trunk lid ~7 cm), which
 * the flexbody would show as dents with the engine poking through on a
 * pristine car. Shortly after each spawn / repair, once the car is upright
 * and still, the per-node deviation from the rigid rest pose (rig-local,
 * through the frame-node basis) is averaged and from then on subtracted —
 * rotated by the current frame basis, faded in, and gated by uprightness
 * (a car on its roof sags the other way, so the correction fades out past
 * the horizontal). Wheel nodes are excluded. Allocation-free per frame.
 */
export class SettleCalibration {
  readonly offset: Float32Array;
  calibrated = false;
  /** Largest |offset|, m (diagnostics). */
  maxOffset = 0;
  /** Last frame's inputs to the settle test (diagnostics). */
  readonly diag = { age: 0, speed: 0, upY: 0, broken: false, still: 0 };
  private readonly rest: ArrayLike<number>;
  private readonly fo: number;
  private readonly ff: number;
  private readonly ft: number;
  private readonly n: number;
  private readonly sum: Float64Array;
  /** Rest basis (rows a1, a2, a3) and current basis (rows b1, b2, b3). */
  private readonly A = new Float64Array(9);
  private readonly Bc = new Float64Array(9);
  private readonly ro = new Float64Array(3);
  private epoch = NaN;
  private age = 0;
  private still = 0;
  private samples = 0;
  private sampleT = 0;
  private fade = 0;
  private prevX = NaN;
  private prevY = NaN;
  private prevZ = NaN;
  private basisOk = false;
  private gain = 0;

  constructor(opts: SettleOptions, nodeCount: number) {
    this.rest = opts.restNodes;
    this.fo = opts.frameNodes[0] ?? -1;
    this.ff = opts.frameNodes[1] ?? -1;
    this.ft = opts.frameNodes[2] ?? -1;
    this.n = Math.max(0, Math.min(opts.bodyNodeCount, nodeCount));
    this.offset = new Float32Array(this.n * 3);
    this.sum = new Float64Array(this.n * 3);
    const ok = [this.fo, this.ff, this.ft].every((i) => i >= 0 && i < nodeCount);
    if (!ok) this.n = 0;
    else {
      const r = this.rest;
      for (let k = 0; k < 3; k++) this.ro[k] = r[3 * this.fo + k]!;
      basis(
        r[3 * this.ff]! - r[3 * this.fo]!, r[3 * this.ff + 1]! - r[3 * this.fo + 1]!, r[3 * this.ff + 2]! - r[3 * this.fo + 2]!,
        r[3 * this.ft]! - r[3 * this.fo]!, r[3 * this.ft + 1]! - r[3 * this.fo + 1]!, r[3 * this.ft + 2]! - r[3 * this.fo + 2]!,
        this.A,
      );
    }
  }

  /** Correction gain of the last apply (0 = none, 1 = full). */
  get strength(): number {
    return this.gain;
  }

  /**
   * Per frame, after block A (skin space = world − anchor) is written:
   * advances the calibration from the world-space frame and subtracts the
   * gated offsets from block A. `broken` = any beam broken this snapshot.
   */
  update(src: ArrayLike<number>, base: number, dtS: number, epoch: number, broken: boolean, nodeData: Float32Array): void {
    this.gain = 0;
    if (this.n === 0) return;
    const o = base + 3 * this.fo;
    const ox = src[o]!, oy = src[o + 1]!, oz = src[o + 2]!;
    const f = base + 3 * this.ff;
    const t = base + 3 * this.ft;
    this.basisOk = basis(src[f]! - ox, src[f + 1]! - oy, src[f + 2]! - oz, src[t]! - ox, src[t + 1]! - oy, src[t + 2]! - oz, this.Bc);
    if (!this.basisOk) return;
    const B = this.Bc;
    const dt = dtS > 0 && dtS < 1 ? dtS : 0;
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.age = 0;
      this.restart();
    }
    this.age += dt;
    const speed = dt > 0 ? Math.hypot(ox - this.prevX, oy - this.prevY, oz - this.prevZ) / dt : Infinity;
    this.prevX = ox;
    this.prevY = oy;
    this.prevZ = oz;
    const upY = B[4]!; // b2 = top direction ⟂ forward
    const dg = this.diag;
    dg.age = this.age;
    dg.speed = speed;
    dg.upY = upY;
    dg.broken = broken;
    dg.still = this.still;
    if (!this.calibrated && dt > 0) {
      const settled = this.age <= SETTLE_DEFAULTS.windowS && !broken && upY >= SETTLE_DEFAULTS.minUp && speed <= SETTLE_DEFAULTS.maxSpeed;
      if (!settled) this.restart();
      else {
        this.still += dt;
        if (this.still >= SETTLE_DEFAULTS.waitS) {
          this.accumulate(src, base, ox, oy, oz);
          this.sampleT += dt;
          if (this.sampleT >= SETTLE_DEFAULTS.sampleS) this.finish();
        }
      }
    }
    if (!this.calibrated) return;
    this.fade = Math.min(1, this.fade + (dt > 0 ? dt / SETTLE_DEFAULTS.fadeS : 0));
    const up = (upY - 0.3) / 0.5;
    const g = this.fade * (up <= 0 ? 0 : up >= 1 ? 1 : up * up * (3 - 2 * up));
    this.gain = g;
    if (g <= 0) return;
    // world offset = Bᵀ-rows… Q·δ with Q = Bᵀ A (rows are basis vectors): first δ in basis coords, then out.
    const A = this.A;
    const off = this.offset;
    for (let i = 0; i < this.n; i++) {
      const dx = off[3 * i]!, dy = off[3 * i + 1]!, dz = off[3 * i + 2]!;
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const u0 = A[0]! * dx + A[1]! * dy + A[2]! * dz;
      const u1 = A[3]! * dx + A[4]! * dy + A[5]! * dz;
      const u2 = A[6]! * dx + A[7]! * dy + A[8]! * dz;
      const d = 4 * i;
      nodeData[d] = nodeData[d]! - g * (B[0]! * u0 + B[3]! * u1 + B[6]! * u2);
      nodeData[d + 1] = nodeData[d + 1]! - g * (B[1]! * u0 + B[4]! * u1 + B[7]! * u2);
      nodeData[d + 2] = nodeData[d + 2]! - g * (B[2]! * u0 + B[5]! * u1 + B[8]! * u2);
    }
  }

  /** Drops the calibration (tests / debug). */
  reset(): void {
    this.calibrated = false;
    this.offset.fill(0);
    this.maxOffset = 0;
    this.fade = 0;
    this.restart();
  }

  private restart(): void {
    this.still = 0;
    this.samples = 0;
    this.sampleT = 0;
    this.sum.fill(0);
  }

  /** Σ (rig-local deviation of every body node from the rigid rest pose). */
  private accumulate(src: ArrayLike<number>, base: number, ox: number, oy: number, oz: number): void {
    const A = this.A;
    const B = this.Bc;
    const r = this.rest;
    const sum = this.sum;
    for (let i = 0; i < this.n; i++) {
      const s = base + 3 * i;
      const wx = src[s]! - ox, wy = src[s + 1]! - oy, wz = src[s + 2]! - oz;
      // basis coords now → rig-local through the rest basis.
      const u0 = B[0]! * wx + B[1]! * wy + B[2]! * wz;
      const u1 = B[3]! * wx + B[4]! * wy + B[5]! * wz;
      const u2 = B[6]! * wx + B[7]! * wy + B[8]! * wz;
      const lx = A[0]! * u0 + A[3]! * u1 + A[6]! * u2;
      const ly = A[1]! * u0 + A[4]! * u1 + A[7]! * u2;
      const lz = A[2]! * u0 + A[5]! * u1 + A[8]! * u2;
      sum[3 * i] = sum[3 * i]! + lx - (r[3 * i]! - this.ro[0]!);
      sum[3 * i + 1] = sum[3 * i + 1]! + ly - (r[3 * i + 1]! - this.ro[1]!);
      sum[3 * i + 2] = sum[3 * i + 2]! + lz - (r[3 * i + 2]! - this.ro[2]!);
    }
    this.samples++;
  }

  private finish(): void {
    if (this.samples === 0) return;
    const inv = 1 / this.samples;
    let max = 0;
    for (let i = 0; i < this.n; i++) {
      let x = this.sum[3 * i]! * inv, y = this.sum[3 * i + 1]! * inv, z = this.sum[3 * i + 2]! * inv;
      let l = Math.hypot(x, y, z);
      if (!Number.isFinite(l)) x = y = z = l = 0;
      if (l > SETTLE_DEFAULTS.maxOffset) {
        const k = SETTLE_DEFAULTS.maxOffset / l;
        x *= k;
        y *= k;
        z *= k;
        l = SETTLE_DEFAULTS.maxOffset;
      }
      this.offset[3 * i] = x;
      this.offset[3 * i + 1] = y;
      this.offset[3 * i + 2] = z;
      if (l > max) max = l;
    }
    this.maxOffset = max;
    this.calibrated = true;
    this.fade = 0;
  }
}

/** Orthonormal basis rows (f̂, û ⟂ f̂, f̂ × û) from forward / top vectors; false when degenerate. */
function basis(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, out: Float64Array): boolean {
  const fl = Math.hypot(fx, fy, fz);
  if (!(fl > 1e-6)) return false;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  const p = tx * fx + ty * fy + tz * fz;
  tx -= p * fx;
  ty -= p * fy;
  tz -= p * fz;
  const tl = Math.hypot(tx, ty, tz);
  if (!(tl > 1e-6)) return false;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  out[0] = fx;
  out[1] = fy;
  out[2] = fz;
  out[3] = tx;
  out[4] = ty;
  out[5] = tz;
  out[6] = fy * tz - fz * ty;
  out[7] = fz * tx - fx * tz;
  out[8] = fx * ty - fy * tx;
  return true;
}


/** One merged draw: its mesh, the union of its panels' nodes and the bounds margin. */
interface DrawEntry {
  mesh: Mesh;
  nodes: Uint16Array;
  margin: number;
  sphere: Sphere;
  /** LOD0 panel indices drawn by this mesh. */
  panels: Int32Array;
}

export interface FlexSkinImpl extends FlexSkin {
  /** Static-sag calibration, or null when not configured. */
  readonly settle: SettleCalibration | null;
  /** LOD0 panel index → index into `meshes` (its merged draw), −1 = none. */
  readonly panelDraw: Int32Array;
  /** Colour draws per LOD level (levels[0] === meshes). */
  readonly levels: readonly (readonly Mesh[])[];
  /** Shadow caster meshes [cascade 0 (LOD1), cascades ≥ 1 (LOD2)] (empty in direct mode). */
  readonly casters: readonly Mesh[];
  /** The all-single-triad patch (key flex2s) of LOD ≥ 1 and the casters. */
  readonly patchSingle: ShaderPatch;
  /** Hidden-panel mask (R8, one texel per LOD0 panel). */
  readonly hiddenMask: DataTexture;
  /** Current colour LOD level. */
  readonly lod: number;
  /** Pins the colour LOD (debug / screenshots); null = by camera distance. */
  setForcedLod(level: number | null): void;
  /** Panel visibility as last set (true = drawn). */
  panelVisible(panelIndex: number): boolean;
}

/** Union of the panels' triad nodes. */
function unionNodes(panels: readonly BindingPanel<string>[], nodeCount: number): Uint16Array {
  const used = new Uint8Array(nodeCount);
  let n = 0;
  for (const p of panels) {
    for (let k = 0; k < p.nodes.length; k++) {
      const i = p.nodes[k]!;
      if (i < nodeCount && !used[i]) {
        used[i] = 1;
        n++;
      }
    }
  }
  const out = new Uint16Array(n);
  for (let i = 0, k = 0; i < nodeCount; i++) if (used[i]) out[k++] = i;
  return out;
}

/** A vertex is a blend of points within the clamp (FLEX_MAX_STRETCH·d0 + slack) of triad R nodes, plus the crumple folds. */
function boundsMargin(panels: readonly BindingPanel<string>[]): number {
  let maxD0 = 0;
  for (const p of panels) for (let s = 0; s < p.vertexCount * K; s++) maxD0 = Math.max(maxD0, p.coef[4 * s + 3]!);
  return FLEX_MAX_STRETCH * maxD0 + FLEX_MAX_SLACK + FLEX_CRUMPLE_AMP;
}

export function createFlexSkin(binding: BindingSet, opts: FlexSkinOptions & FlexSkinExtraOptions): FlexSkinImpl {
  const nodeCount = binding.nodeCount;
  const rows = nodeTextureRows(nodeCount);
  const nodeData = new Float32Array(NODE_TEX_WIDTH * rows * 2 * 4);
  const texture = new DataTexture(nodeData, NODE_TEX_WIDTH, rows * 2, RGBAFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.name = `flexNodes:${binding.vehicle}`;
  texture.needsUpdate = true;
  const nodeFlags = new Uint8Array(nodeCount);
  const P = binding.panels.length;
  const hiddenMask = createHiddenMask(P);
  hiddenMask.name = `flexHidden:${binding.vehicle}`;
  const hiddenData = hiddenMask.image.data as Uint8Array;
  const patch = createFlexPatch(texture, rows, hiddenMask, false);
  const patchSingle = createFlexPatch(texture, rows, hiddenMask, true);
  const anchorNode = Math.min(Math.max(0, opts.anchorNode ?? 0), Math.max(0, nodeCount - 1));
  const csm = opts.lighting.csm;
  const direct = !shadowLodAvailable(opts.renderer);

  const object = new Group();
  object.name = `vehicle:${binding.vehicle}`;
  const owned: Material[] = [];
  const geometries: BufferGeometry[] = [];

  // ---- panel alignment: every level's panels → LOD0 panel index (by id)
  const lod0Index = new Map<string, number>();
  for (const p of binding.panels) lod0Index.set(p.panelId, p.panelIndex);
  const levelPanels: MergedPanel[][] = [binding.panels.map((p) => ({ panel: p, maskIndex: p.panelIndex }))];
  for (const lb of opts.lods ?? []) {
    if (lb.nodeCount !== nodeCount) throw new Error(`flexskin: LOD binding has ${lb.nodeCount} nodes, LOD0 ${nodeCount}`);
    const list: MergedPanel[] = [];
    for (const p of lb.panels) {
      const i = lod0Index.get(p.panelId);
      if (i !== undefined) list.push({ panel: p, maskIndex: i });
    }
    levelPanels.push(list);
  }

  /** Damage patch of a merged group (null = undamageable; undefined = cannot merge glass). */
  const dmg = opts.damage as (FlexSkinOptions['damage'] & { glassGroupPatch?: (panels: readonly number[]) => ShaderPatch | null }) | null;
  const variantKey = (i: number): string => dmg?.patchFor(i)?.key ?? '-';

  const entries: DrawEntry[] = [];
  const entryOf = new Map<Mesh, DrawEntry>();
  const addEntry = (mesh: Mesh, panels: readonly MergedPanel[]): DrawEntry => {
    const list = panels.map((m) => m.panel);
    const e: DrawEntry = {
      mesh,
      nodes: unionNodes(list, nodeCount),
      margin: boundsMargin(list),
      sphere: mesh.geometry.boundingSphere!,
      panels: Int32Array.from(panels, (m) => m.maskIndex),
    };
    restBounds(list, e.sphere);
    entries.push(e);
    entryOf.set(mesh, e);
    return e;
  };

  const levels: Mesh[][] = [];
  for (let level = 0; level < levelPanels.length; level++) {
    const single = level > 0;
    // group by (slot, damage variant[, castShadow in direct mode][, tangents]) in first-seen panel order
    const groups = new Map<string, MergedPanel[]>();
    for (const mp of levelPanels[level]!) {
      const p = mp.panel;
      const vk = variantKey(mp.maskIndex);
      const glass = vk.endsWith(':glass');
      const separateGlass = glass && !dmg?.glassGroupPatch;
      const key = [
        p.material,
        vk,
        direct ? (p.castShadow ? 'cs' : 'nc') : '',
        p.restTangent && p.frameTangent ? 't' : 'n',
        separateGlass ? `pane${mp.maskIndex}` : '',
      ].join('|');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(mp);
    }
    const meshes: Mesh[] = [];
    for (const [key, parts] of groups) {
      const first = parts[0]!;
      const vk = variantKey(first.maskIndex);
      let damagePatch: ShaderPatch | null = null;
      if (vk.endsWith(':glass')) {
        damagePatch =
          parts.length === 1 || !dmg?.glassGroupPatch
            ? (dmg?.patchFor(first.maskIndex) ?? null)
            : dmg.glassGroupPatch(parts.map((m) => m.maskIndex));
      } else if (vk !== '-') damagePatch = dmg?.patchFor(first.maskIndex) ?? null;
      const geometry = buildSkinGeometry(parts, single ? 'single' : 'full');
      geometries.push(geometry);
      const base = opts.materials.base(first.panel.material as Parameters<typeof opts.materials.base>[0]);
      const set = opts.patchMaterial(cloneBaseMaterial(base), {
        csm,
        flexbody: single ? patchSingle : patch,
        damage: damagePatch ?? undefined,
      });
      // Panels are open shells: both faces must reach the shadow map.
      set.color.shadowSide = DoubleSide;
      const mesh = new Mesh(geometry, set.color);
      if (set.depth) mesh.customDepthMaterial = set.depth;
      if (set.distance) mesh.customDistanceMaterial = set.distance;
      mesh.castShadow = direct && first.panel.castShadow;
      mesh.receiveShadow = true;
      mesh.visible = level === 0;
      mesh.name = `skin${level}:${key.split('|').slice(0, 2).join(':')}${parts.length === 1 ? `:${first.panel.panelId}` : ''}`;
      owned.push(set.color);
      if (set.depth) owned.push(set.depth);
      if (set.distance) owned.push(set.distance);
      object.add(mesh);
      meshes.push(mesh);
      addEntry(mesh, parts);
    }
    levels.push(meshes);
  }
  const meshes = levels[0]!;
  const panelDraw = new Int32Array(P).fill(-1);
  meshes.forEach((m, di) => {
    for (const i of entryOf.get(m)!.panels) panelDraw[i] = di;
  });

  // ---- shadow casters (single triad, every castShadow panel of the level, one draw each)
  const casters: Mesh[] = [];
  const casterEntries: DrawEntry[] = [];
  if (!direct) {
    const n = levelPanels.length;
    const sources = [Math.min(1, n - 1), Math.min(2, n - 1)];
    const built = new Map<number, Mesh>();
    for (const src of sources) {
      let mesh = built.get(src);
      if (!mesh) {
        const parts = levelPanels[src]!.filter((m) => m.panel.castShadow);
        const geometry = buildSkinGeometry(parts, 'caster');
        geometries.push(geometry);
        const color = new MeshBasicMaterial({ name: 'skinCasterColor', colorWrite: false, depthWrite: false });
        const set = opts.patchMaterial(color, { flexbody: patchSingle });
        set.color.shadowSide = DoubleSide;
        mesh = new Mesh(geometry, set.color);
        if (set.depth) mesh.customDepthMaterial = set.depth;
        if (set.distance) mesh.customDistanceMaterial = set.distance;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.visible = false;
        mesh.name = `skinCaster:lod${src}`;
        owned.push(set.color);
        if (set.depth) owned.push(set.depth);
        if (set.distance) owned.push(set.distance);
        object.add(mesh);
        built.set(src, mesh);
        casterEntries.push(addEntry(mesh, parts));
      }
      casters.push(mesh);
    }
  }

  const anchor: [number, number, number] = [0, 0, 0];
  const settle = opts.settle ? new SettleCalibration(opts.settle, nodeCount) : null;
  let lod = 0;
  let forced: number | null = null;
  const maxLevel = levels.length - 1;

  function showLevel(level: number): void {
    for (let l = 0; l < levels.length; l++) for (const m of levels[l]!) m.visible = l === level;
  }

  function cameraLod(camera: Camera): number {
    const e = camera.matrixWorld.elements;
    const dx = e[12]! - anchor[0];
    const dy = e[13]! - anchor[1];
    const dz = e[14]! - anchor[2];
    const cam = camera as Camera & { fov?: number; zoom?: number };
    const zoom = cam.zoom && cam.zoom > 0 ? cam.zoom : 1;
    return selectVehicleLod(lod, lodDistance(Math.sqrt(dx * dx + dy * dy + dz * dz), cam.fov) / zoom, maxLevel);
  }

  function update(frame: VehicleFrameInput): void {
    const src = frame.nodes;
    const base = frame.nodeOffset * 3;
    if (base + nodeCount * 3 > src.length) return;
    const ax = src[base + 3 * anchorNode]!;
    const ay = src[base + 3 * anchorNode + 1]!;
    const az = src[base + 3 * anchorNode + 2]!;
    if (!Number.isFinite(ax + ay + az)) return;
    for (let i = 0; i < nodeCount; i++) {
      const s = base + 3 * i;
      const o = 4 * i; // block A texel (i & 63, i >> 6) is linear index i
      let x = src[s]! - ax;
      let y = src[s + 1]! - ay;
      let z = src[s + 2]! - az;
      if (!Number.isFinite(x + y + z)) x = y = z = 0;
      nodeData[o] = x;
      nodeData[o + 1] = y;
      nodeData[o + 2] = z;
      nodeData[o + 3] = nodeFlags[i]!;
    }
    if (settle) settle.update(src, base, frame.dtS, frame.repairEpoch, frame.broken.includes(1), nodeData);
    anchor[0] = ax;
    anchor[1] = ay;
    anchor[2] = az;
    object.position.set(ax, ay, az);
    const next = forced !== null ? Math.min(Math.max(0, forced), maxLevel) : frame.camera && maxLevel > 0 ? cameraLod(frame.camera) : 0;
    if (next !== lod) {
      lod = next;
      showLevel(lod);
    }
    for (const m of levels[lod]!) nodeBounds(nodeData, entryOf.get(m)!);
    for (const e of casterEntries) nodeBounds(nodeData, e);
    texture.needsUpdate = true;
  }

  const shadowClient: ShadowLodClient = {
    shadowBegin(): void {
      for (let i = 0; i < casters.length; i++) casters[i]!.visible = i === 0;
    },
    shadowCascade(index: number): void {
      const want = index === 0 ? 0 : 1;
      for (let i = 0; i < casters.length; i++) casters[i]!.visible = false;
      const c = casters[want] ?? casters[0];
      if (c) c.visible = true;
    },
    shadowEnd(): void {
      for (const c of casters) c.visible = false;
    },
  };
  const detach = direct ? () => {} : attachShadowLod(opts.renderer, opts.lighting, shadowClient);

  const skin: FlexSkinImpl = {
    object,
    meshes,
    nodeTexture: texture,
    rows,
    nodeData,
    nodeFlags,
    anchor: anchor as unknown as Vec3T,
    patch,
    patchSingle,
    hiddenMask,
    settle,
    panelDraw,
    levels,
    casters,
    get lod(): number {
      return lod;
    },
    update,
    setForcedLod(level: number | null): void {
      forced = level;
    },
    setPanelVisible(panelIndex: number, visible: boolean): void {
      if (!(panelIndex >= 0 && panelIndex < P)) return;
      const v = visible ? 0 : 255;
      if (hiddenData[panelIndex] === v) return;
      hiddenData[panelIndex] = v;
      hiddenMask.needsUpdate = true;
    },
    panelVisible(panelIndex: number): boolean {
      return hiddenData[panelIndex] === 0;
    },
    dispose(): void {
      detach();
      object.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of owned) m.dispose();
      texture.dispose();
      hiddenMask.dispose();
      const i = SKIN_INSTANCES.indexOf(skin);
      if (i >= 0) SKIN_INSTANCES.splice(i, 1);
    },
  };
  SKIN_INSTANCES.push(skin);
  return skin;
}

/** Live skins (debug / e2e: also `globalThis.__crumpleSkins` in the browser). Read-only use. */
export const SKIN_INSTANCES: FlexSkinImpl[] = [];
if (typeof window !== 'undefined') (window as unknown as { __crumpleSkins: FlexSkinImpl[] }).__crumpleSkins = SKIN_INSTANCES;

/** Rest bounds of a merged draw (until the first update): union AABB of the panels' rest spheres. */
function restBounds(panels: readonly BindingPanel<string>[], out: Sphere): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of panels) {
    const r = p.restRadius + 0.1;
    minX = Math.min(minX, p.restCenter[0] - r);
    maxX = Math.max(maxX, p.restCenter[0] + r);
    minY = Math.min(minY, p.restCenter[1] - r);
    maxY = Math.max(maxY, p.restCenter[1] + r);
    minZ = Math.min(minZ, p.restCenter[2] - r);
    maxZ = Math.max(maxZ, p.restCenter[2] + r);
  }
  if (!(maxX >= minX)) {
    out.center.set(0, 0, 0);
    out.radius = 0;
    return;
  }
  out.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  out.radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/** Bounding sphere of a draw's nodes (skin space, AABB centre) + margin. */
function nodeBounds(data: Float32Array, b: DrawEntry): void {
  const n = b.nodes;
  if (n.length === 0) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < n.length; k++) {
    const o = 4 * n[k]!;
    const x = data[o]!, y = data[o + 1]!, z = data[o + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let k = 0; k < n.length; k++) {
    const o = 4 * n[k]!;
    const dx = data[o]! - cx, dy = data[o + 1]! - cy, dz = data[o + 2]! - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  b.sphere.center.set(cx, cy, cz);
  b.sphere.radius = Math.sqrt(r2) + b.margin;
}
