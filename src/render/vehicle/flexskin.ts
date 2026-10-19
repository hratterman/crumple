/**
 * Flexbody skin (A2): node texture + the `flex2` vertex patch + one Mesh per
 * BindingPanel. Contract: ./types.ts "NODE TEXTURE" and "FLEXBODY SHADER
 * PATCH"; the CPU mirror of the GLSL below is binder.ts evalFlexFrame —
 * change both together (flexskin.test.ts checks the constants match).
 *
 * The patch goes through patchMaterial's flexbody slot, so the color,
 * depth (CSM cascades) and distance materials all reconstruct the same
 * deformed surface: shadows are cast by the DEFORMED body.
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
  NearestFilter,
  RGBAFormat,
  Sphere,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { PatchTarget, ShaderPatch } from '../types';
import { FLEX_FAR, FLEX_NORMAL_EPS } from './binder';
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
float flexHash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
float flexNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( flexHash13( i ), flexHash13( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ),
			mix( flexHash13( i + vec3( 0.0, 1.0, 0.0 ) ), flexHash13( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
		mix( mix( flexHash13( i + vec3( 0.0, 0.0, 1.0 ) ), flexHash13( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ),
			mix( flexHash13( i + vec3( 0.0, 1.0, 1.0 ) ), flexHash13( i + vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y ), u.z );
}
float flexCrumple( vec3 p ) {
	float a = 1.0 - abs( flexNoise( p * vec3( 1.7, 2.3, 5.2 ) + 3.1 ) * 2.0 - 1.0 );
	float b = 1.0 - abs( flexNoise( p * 3.1 + 9.7 ) * 2.0 - 1.0 );
	return 0.7 * ( a * a - 0.2 ) + 0.45 * ( b * b - 0.3 );
}
`;

/**
 * Declarations + the per-vertex evaluation (vertex stage, after <common>).
 * FLEXBODY_COLOR = color target only (tangents + damage varyings). Mirrors
 * binder.ts evalTriadSlot / evalFlexFrame (types.ts "FLEXBODY
 * RECONSTRUCTION v2"); flexEvaluate() runs first thing in main() and the
 * replaced chunks read its results.
 */
export const FLEX_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uFlexNodes;
uniform int uFlexRows;
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
	flexP += flexN * ( ${f(FLEX_CRUMPLE_AMP)} * accD.x * flexFrameU.z * flexCrumple( position ) );
#ifdef FLEXBODY_COLOR
	vFlexRest = position;
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
`;

/** Applies the flex2 edit to a program's sources (exported for tests / the e2e compile check). */
export function applyFlexGlsl(shader: { vertexShader: string; fragmentShader: string }, target: PatchTarget): void {
  const vs = shader.vertexShader;
  for (const chunk of ['#include <common>', '#include <begin_vertex>', 'void main() {']) {
    if (!vs.includes(chunk)) throw new Error(`flexbody: vertex shader lacks ${chunk}`);
  }
  const defines = target === 'color' ? '#define FLEXBODY\n#define FLEXBODY_COLOR\n' : '#define FLEXBODY\n';
  shader.vertexShader =
    defines +
    vs
      .replace('#include <common>', `#include <common>\n${FLEX_VERTEX_PARS}`)
      .replace('void main() {', `void main() {\n${FLEX_MAIN_CALL}`)
      .replace('#include <beginnormal_vertex>', FLEX_NORMAL_CHUNK)
      .replace('#include <begin_vertex>', FLEX_POSITION_CHUNK);
  if (target === 'color') shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader;
}

/** The flex2 ShaderPatch bound to one node texture (uniform objects shared by every material of the skin). */
export function createFlexPatch(texture: DataTexture, rows: number): ShaderPatch {
  const uNodes = { value: texture };
  const uRows = { value: rows };
  return {
    key: FLEXBODY_PATCH_KEY,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      shader.uniforms.uFlexNodes = uNodes;
      shader.uniforms.uFlexRows = uRows;
      applyFlexGlsl(shader, target);
    },
  };
}

/** rows per block for nodeCount nodes. */
export function nodeTextureRows(nodeCount: number): number {
  return Math.max(1, Math.ceil(nodeCount / NODE_TEX_WIDTH));
}

/** Panel geometry: rest attributes + the packed flex2 attributes (types.ts "FLEXBODY SHADER PATCH v2"). */
export function buildPanelGeometry(p: BindingPanel): BufferGeometry {
  const g = new BufferGeometry();
  const n = p.vertexCount;
  g.setAttribute('position', new BufferAttribute(p.restPosition, 3));
  g.setAttribute('normal', new BufferAttribute(p.restNormal, 3));
  g.setAttribute('uv', new BufferAttribute(p.uv, 2));
  const ft = p.frameTangent;
  const T = new Float32Array(n * 4);
  const U = new Float32Array(n * 4);
  for (let k = 0; k < K; k++) {
    const tri = new Float32Array(n * 4);
    const coef = new Float32Array(n * 4);
    const frame = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      const s = K * v + k;
      tri[4 * v] = p.triad[3 * s]!;
      tri[4 * v + 1] = p.triad[3 * s + 1]!;
      tri[4 * v + 2] = p.triad[3 * s + 2]!;
      tri[4 * v + 3] = p.weight[s]!;
      for (let c = 0; c < 4; c++) coef[4 * v + c] = p.coef[4 * s + c]!;
      frame[4 * v] = p.frameNormal[3 * s]!;
      frame[4 * v + 1] = p.frameNormal[3 * s + 1]!;
      frame[4 * v + 2] = p.frameNormal[3 * s + 2]!;
      if (ft) {
        frame[4 * v + 3] = ft[3 * s]!;
        const dst = k === 2 ? U : T;
        const o = k === 2 ? 4 * v : 4 * v + 2 * k;
        dst[o] = ft[3 * s + 1]!;
        dst[o + 1] = ft[3 * s + 2]!;
      }
    }
    g.setAttribute(`flexTriad${k}`, new BufferAttribute(tri, 4));
    g.setAttribute(`flexCoef${k}`, new BufferAttribute(coef, 4));
    g.setAttribute(`flexFrame${k}`, new BufferAttribute(frame, 4));
  }
  for (let v = 0; v < n; v++) U[4 * v + 2] = p.damageWeight[v]!;
  g.setAttribute('flexFrameT', new BufferAttribute(T, 4));
  g.setAttribute('flexFrameU', new BufferAttribute(U, 4));
  if (p.restTangent && ft) g.setAttribute('tangent', new BufferAttribute(p.restTangent, 4));
  g.setIndex(new BufferAttribute(p.index, 1));
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

/** Per-panel bounds bookkeeping. */
interface PanelBounds {
  nodes: Uint16Array;
  margin: number;
  sphere: Sphere;
}

export interface FlexSkinImpl extends FlexSkin {
  /** Static-sag calibration, or null when not configured. */
  readonly settle: SettleCalibration | null;
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
  const patch = createFlexPatch(texture, rows);
  const anchorNode = Math.min(Math.max(0, opts.anchorNode ?? 0), Math.max(0, nodeCount - 1));

  const object = new Group();
  object.name = `vehicle:${binding.vehicle}`;
  const meshes: Mesh[] = [];
  const bounds: PanelBounds[] = [];
  const owned: Material[] = [];
  for (const p of binding.panels) {
    const geometry = buildPanelGeometry(p);
    const base = opts.materials.base(p.material);
    const set = opts.patchMaterial(cloneBaseMaterial(base), {
      csm: opts.lighting.csm,
      flexbody: patch,
      damage: opts.damage?.patchFor(p.panelIndex) ?? undefined,
    });
    // Panels are open shells: both faces must reach the shadow map.
    set.color.shadowSide = DoubleSide;
    const mesh = new Mesh(geometry, set.color);
    if (set.depth) mesh.customDepthMaterial = set.depth;
    if (set.distance) mesh.customDistanceMaterial = set.distance;
    mesh.castShadow = p.castShadow;
    mesh.receiveShadow = true;
    mesh.name = `panel:${p.panelId}`;
    owned.push(set.color);
    if (set.depth) owned.push(set.depth);
    if (set.distance) owned.push(set.distance);
    object.add(mesh);
    meshes.push(mesh);
    let maxD0 = 0;
    for (let s = 0; s < p.vertexCount * K; s++) maxD0 = Math.max(maxD0, p.coef[4 * s + 3]!);
    // A vertex is a blend of points within the clamp (FLEX_MAX_STRETCH·d0 + slack) of triad R nodes, plus the crumple folds.
    const b: PanelBounds = { nodes: p.nodes, margin: FLEX_MAX_STRETCH * maxD0 + FLEX_MAX_SLACK + FLEX_CRUMPLE_AMP, sphere: geometry.boundingSphere! };
    bounds.push(b);
    restBounds(p, b.sphere);
  }

  const anchor: [number, number, number] = [0, 0, 0];
  const settle = opts.settle ? new SettleCalibration(opts.settle, nodeCount) : null;

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
    for (const b of bounds) nodeBounds(nodeData, b);
    texture.needsUpdate = true;
  }

  const skin: FlexSkinImpl = {
    object,
    meshes,
    nodeTexture: texture,
    rows,
    nodeData,
    nodeFlags,
    anchor: anchor as unknown as Vec3T,
    patch,
    settle,
    update,
    setPanelVisible(panelIndex: number, visible: boolean): void {
      const m = meshes[panelIndex];
      if (m) m.visible = visible;
    },
    dispose(): void {
      object.removeFromParent();
      for (const m of meshes) m.geometry.dispose();
      for (const m of owned) m.dispose();
      texture.dispose();
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

function restBounds(p: BindingPanel, out: Sphere): void {
  out.center.set(p.restCenter[0], p.restCenter[1], p.restCenter[2]);
  out.radius = p.restRadius + 0.1;
}

/** Bounding sphere of a panel's nodes (skin space, AABB centre) + margin. */
function nodeBounds(data: Float32Array, b: PanelBounds): void {
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
