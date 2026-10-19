/**
 * The INSTANCED flexbody patch (`flexI1`, contract: ./types.ts). Same v2
 * reconstruction as the vehicle `flex2` patch (render/vehicle/types.ts
 * "FLEXBODY RECONSTRUCTION v2"; CPU mirror binder.ts evalFlexFrame), with
 * one difference: every triad node index is offset by the per-instance
 * attribute `propInst.x` (the instance's first texel in the SHARED props
 * node texture), so every instance of a prop key is one draw.
 *
 * Per-instance attribute `propInst` (vec4, InstancedBufferAttribute):
 *   x = node base (exact float), y = seed in [0, 1) (colour / print
 *   variation), z = wear 0..1, w = reserved.
 * Color target varyings: vFlexRest (REST prop-local position), vFlexDamage
 * (strain, scuff, 0, broken) and vPropInst (seed, wear, panel variant) for
 * the slot material hooks (materials.ts), all under `#ifdef FLEXBODY`.
 * The panel VARIANT rides in flexFrameU.w (reserved 0 in the vehicle
 * layout): an integer per panel (e.g. the cone's black rubber base vs its
 * orange shell in one 'conePlastic' batch).
 * Targets color + depth + distance (props cast deformed shadows).
 */
import type { DataTexture, WebGLProgramParametersWithUniforms } from 'three';

import type { PatchTarget, ShaderPatch } from '../types';
import { FLEX_FAR, FLEX_NORMAL_EPS } from '../vehicle/binder';
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
  NODE_TEX_FLAG_BROKEN,
  NODE_TEX_WIDTH,
} from '../vehicle/types';
import { PROP_FLEX_PATCH_KEY } from './types';

/** GLSL float literal. */
function f(x: number): string {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Cosmetic crumple field in REST space (same family as the vehicle folds, own copy: props are smaller, so a finer scale). */
const CRUMPLE_GLSL = /* glsl */ `
float propHash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
float propNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( propHash13( i ), propHash13( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ),
			mix( propHash13( i + vec3( 0.0, 1.0, 0.0 ) ), propHash13( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
		mix( mix( propHash13( i + vec3( 0.0, 0.0, 1.0 ) ), propHash13( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ),
			mix( propHash13( i + vec3( 0.0, 1.0, 1.0 ) ), propHash13( i + vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y ), u.z );
}
float propCrumple( vec3 p ) {
	float a = 1.0 - abs( propNoise( p * 4.3 + 3.1 ) * 2.0 - 1.0 );
	float b = 1.0 - abs( propNoise( p * 9.1 + 9.7 ) * 2.0 - 1.0 );
	return 0.6 * ( a * a - 0.3 ) + 0.4 * ( b * b - 0.3 );
}
`;

/** Crumple amplitude for props (m at full strain): 60 % of the vehicle's, props are small. */
export const PROP_CRUMPLE_AMP = FLEX_CRUMPLE_AMP * 0.6;

const triadCall = (k: number): string =>
  `\tpropTriad( flexTriad${k}, flexCoef${k}, flexFrame${k}.xyz, ft${k}, base, P${k}, W${k}, N${k}, T${k}, accD );\n`;

/** Vertex declarations + propEvaluate() (after <common>). */
export const PROP_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uPropNodes;
uniform int uPropRows;
attribute vec4 propInst;
attribute vec4 flexTriad0;
attribute vec4 flexTriad1;
attribute vec4 flexTriad2;
attribute vec4 flexCoef0;
attribute vec4 flexCoef1;
attribute vec4 flexCoef2;
attribute vec4 flexFrame0;
attribute vec4 flexFrame1;
attribute vec4 flexFrame2;
attribute vec4 flexFrameU;
#ifdef FLEXBODY_COLOR
attribute vec4 flexFrameT;
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
varying vec3 vPropInst;
#endif
vec3 flexP;
vec3 flexN;
vec3 flexT;
${CRUMPLE_GLSL}
vec4 propNode( int i, int block ) {
	return texelFetch( uPropNodes, ivec2( i & ${NODE_TEX_WIDTH - 1}, ( i >> 6 ) + block * uPropRows ), 0 );
}
vec3 propSafeNormalize( vec3 v ) {
	float l = length( v );
	return l > ${f(FLEX_NORMAL_EPS)} ? v / l : vec3( 0.0, 1.0, 0.0 );
}
void propTriad( vec4 tri, vec4 coef, vec3 fn, vec3 ft, int base, out vec3 P, out float W, out vec3 N, out vec3 T, inout vec4 accD ) {
	ivec3 idx = ivec3( tri.xyz + 0.5 ) + base;
	vec4 nR = propNode( idx.x, 0 );
	vec4 nX = propNode( idx.y, 0 );
	vec4 nY = propNode( idx.z, 0 );
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
	vec3 d = ( wR * propNode( idx.x, 1 ).xyz + wX * propNode( idx.y, 1 ).xyz + wY * propNode( idx.z, 1 ).xyz ) / ( wR + wX + wY );
	int fl = int( nR.w + 0.5 ) | int( nX.w + 0.5 ) | int( nY.w + 0.5 );
	accD += tri.w * vec4( d, ( fl & ${NODE_TEX_FLAG_BROKEN} ) != 0 ? 1.0 : 0.0 );
}
float propConsensus( float W, vec3 P, vec3 Pm ) {
	vec3 d = P - Pm;
	return W / ( 1.0 + dot( d, d ) * ${f(1 / (FLEX_CONSENSUS * FLEX_CONSENSUS))} );
}
float propAgree( float C, vec3 N, vec3 Nm ) {
	return C * ( ${f(FLEX_AGREE_FLOOR)} + smoothstep( -0.2, 0.8, dot( N, Nm ) ) );
}
void propEvaluate() {
	int base = int( propInst.x + 0.5 );
	vec4 accD = vec4( 0.0 );
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
	float C0 = propConsensus( W0, P0, Pm );
	float C1 = propConsensus( W1, P1, Pm );
	float C2 = propConsensus( W2, P2, Pm );
	flexP = ( C0 * P0 + C1 * P1 + C2 * P2 ) / ( C0 + C1 + C2 );
	vec3 Nm = propSafeNormalize( C0 * N0 + C1 * N1 + C2 * N2 );
	float A0 = propAgree( C0, N0, Nm );
	float A1 = propAgree( C1, N1, Nm );
	float A2 = propAgree( C2, N2, Nm );
	flexN = propSafeNormalize( A0 * N0 + A1 * N1 + A2 * N2 );
	vec3 Tb = A0 * T0 + A1 * T1 + A2 * T2;
	flexT = propSafeNormalize( Tb - dot( Tb, flexN ) * flexN );
	flexP += flexN * ( ${f(PROP_CRUMPLE_AMP)} * accD.x * flexFrameU.z * propCrumple( position ) );
#ifdef FLEXBODY_COLOR
	vFlexRest = position;
	vFlexDamage = vec4( accD.xyz * flexFrameU.z, accD.w );
	vPropInst = vec3( propInst.yz, flexFrameU.w );
#endif
}
`;

const NORMAL_CHUNK = /* glsl */ `
vec3 objectNormal = flexN;
#ifdef USE_TANGENT
vec3 objectTangent = flexT;
#endif
`;

const POSITION_CHUNK = /* glsl */ `
vec3 transformed = flexP;
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
#define FLEXBODY
#define PROP_INSTANCED
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
varying vec3 vPropInst;
`;

/** Applies the flexI1 edit to a program's sources (exported for tests). */
export function applyPropFlexGlsl(shader: { vertexShader: string; fragmentShader: string }, target: PatchTarget): void {
  const vs = shader.vertexShader;
  for (const chunk of ['#include <common>', '#include <begin_vertex>', 'void main() {']) {
    if (!vs.includes(chunk)) throw new Error(`prop flexbody: vertex shader lacks ${chunk}`);
  }
  const defines = target === 'color' ? '#define FLEXBODY\n#define FLEXBODY_COLOR\n#define PROP_INSTANCED\n' : '#define FLEXBODY\n#define PROP_INSTANCED\n';
  shader.vertexShader =
    defines +
    vs
      .replace('#include <common>', `#include <common>\n${PROP_VERTEX_PARS}`)
      .replace('void main() {', 'void main() {\n\tpropEvaluate();')
      .replace('#include <beginnormal_vertex>', NORMAL_CHUNK)
      .replace('#include <begin_vertex>', POSITION_CHUNK);
  if (target === 'color') shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader;
}

/** Uniform holders shared by every props material (the texture may be re-allocated when instances are added). */
export interface PropNodeUniforms {
  uPropNodes: { value: DataTexture };
  uPropRows: { value: number };
}

export function createPropFlexPatch(u: PropNodeUniforms): ShaderPatch {
  return {
    key: PROP_FLEX_PATCH_KEY,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      shader.uniforms.uPropNodes = u.uPropNodes;
      shader.uniforms.uPropRows = u.uPropRows;
      applyPropFlexGlsl(shader, target);
    },
  };
}
