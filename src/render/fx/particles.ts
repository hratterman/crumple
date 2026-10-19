/**
 * GPU particle pools (contract: ./types.ts PARTICLES). Each pool is ONE draw:
 * an InstancedBufferGeometry (unit quad) over a ring buffer of SPAWN records
 * written only when particles spawn (preallocated update ranges over the
 * touched slice). The vertex shader evaluates motion analytically from the
 * age: exponential drag toward a terminal velocity (gravity / buoyant rise /
 * wind), one analytic ground bounce solved on the CPU at spawn time, size,
 * alpha and colour over life; dead records collapse off-screen. No
 * per-particle CPU work per frame.
 *
 * Record (RECORD_FLOATS f32, 5 vec4 attributes):
 *   iA = p0.xyz, birth (sim s)     iB = v0.xyz, life (s)
 *   iC = vb.xyz (post-bounce v), tb (bounce time after birth, NO_BOUNCE = none)
 *   iD = size0, size1, seed 0..1, kind + opacity (integer kind, fract = opacity)
 *   iE = rgb, ground y at spawn
 * Per-pool kind table uniforms: uKind[k] = (drag 1/s, gravity m/s², rise
 * m/s², wind factor), uKindB[k] = pool-specific shaping.
 */
import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  Vector4,
  ZeroFactor,
  type Texture,
} from 'three';

import { LAYER_NO_REFLECTION } from '../types';
import { FX_SPARK_MAX_RADIANCE } from './types';

export const RECORD_FLOATS = 20;
export const NO_BOUNCE = 1e6;
export const KIND_SLOTS = 8;

/** Motion constants of one particle kind (must match the shader's fxMotion). */
export interface KindMotion {
  drag: number;
  gravity: number;
  rise: number;
  wind: number;
}

/** Mutable spawn description (reuse one instance; no allocation per spawn). */
export interface ParticleSpawn {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  birth: number;
  life: number;
  size0: number;
  size1: number;
  seed: number;
  kind: number;
  /** 0..0.999 */
  opacity: number;
  r: number;
  g: number;
  b: number;
  /** Ground height under the spawn point (soft-particle floor, bounce plane). */
  ground: number;
  /** Bounce restitution (0 = none: the kind never bounces). */
  bounce: number;
  /** Horizontal speed kept on the bounce. */
  friction: number;
}
export function createParticleSpawn(): ParticleSpawn {
  return {
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, birth: 0, life: 1, size0: 0.1, size1: 0.1, seed: 0,
    kind: 0, opacity: 0.5, r: 1, g: 1, b: 1, ground: -1e4, bounce: 0, friction: 0.6,
  };
}

// ------------------------------------------------------------------ analytic motion (CPU twin of fxMotion)
/** Vertical position at age t: y0 + T·t + (v0 − T)(1 − e^{−kt})/k with T = (rise − g)/k. */
export function motionY(y0: number, vy0: number, t: number, m: KindMotion): number {
  const k = Math.max(m.drag, 0.01);
  const T = (m.rise - m.gravity) / k;
  return y0 + T * t + ((vy0 - T) * (1 - Math.exp(-k * t))) / k;
}
export function motionVY(vy0: number, t: number, m: KindMotion): number {
  const k = Math.max(m.drag, 0.01);
  const T = (m.rise - m.gravity) / k;
  return T + (vy0 - T) * Math.exp(-k * t);
}
/**
 * First time t > 0 the analytic arc reaches `ground` (descending), or
 * NO_BOUNCE when it never does (terminal velocity ≥ 0, or beyond 30 s).
 * Spawn-time only (bracket + bisection, ~40 exp).
 */
export function solveGroundHit(y0: number, vy0: number, ground: number, m: KindMotion): number {
  if (y0 <= ground) return 0;
  const k = Math.max(m.drag, 0.01);
  const T = (m.rise - m.gravity) / k;
  if (T >= 0) return NO_BOUNCE;
  // apex (v = 0) when rising
  let lo = 0;
  if (vy0 > 0) lo = -Math.log(-T / (vy0 - T)) / k;
  let hi = Math.max(lo, 0.02) * 2;
  let guard = 0;
  while (motionY(y0, vy0, hi, m) > ground) {
    hi *= 2;
    if (++guard > 12 || hi > 30) return NO_BOUNCE;
  }
  for (let i = 0; i < 28; i++) {
    const mid = 0.5 * (lo + hi);
    if (motionY(y0, vy0, mid, m) > ground) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ------------------------------------------------------------------ GLSL
export const MOTION_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
uniform vec4 uKind[${KIND_SLOTS}];
uniform vec4 uKindB[${KIND_SLOTS}];
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
vec3 fxMotion( vec3 p0, vec3 v0, float t, vec4 k, out vec3 vel ) {
  float drag = max( k.x, 0.01 );
  vec3 term = uWind * k.w + vec3( 0.0, ( k.z - k.y ) / drag, 0.0 );
  float e = exp( -drag * t );
  vel = term + ( v0 - term ) * e;
  return p0 + term * t + ( v0 - term ) * ( ( 1.0 - e ) / drag );
}
// Position at age t (one analytic bounce at iC.w, then pinned to the spawn ground).
vec3 fxPosition( float t, vec4 k, out vec3 vel ) {
  vec3 p;
  if ( t > iC.w ) {
    vec3 pb = fxMotion( iA.xyz, iB.xyz, iC.w, k, vel );
    p = fxMotion( pb, iC.xyz, t - iC.w, k, vel );
  } else {
    p = fxMotion( iA.xyz, iB.xyz, t, k, vel );
  }
  return p;
}
float fxHash( float n ) { return fract( sin( n * 91.3458 ) * 47453.5453 ); }
`;

const OFFSCREEN_GLSL = /* glsl */ `gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );`;

/** Smoke / dust / spray / splash ring: alpha-blended (premultiplied), lit, fogged billboards. */
const SOFT_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${MOTION_GLSL}
uniform float uSizeScale;
// player vehicle centre (xyz) + radius (w; 0 = off): puffs between it and the camera thin out
uniform vec4 uFocus;
varying vec2 vUv;
varying vec2 vCorner;
varying vec4 vChannel;
varying vec3 vColor;
varying vec3 vWorld;
varying float vAlpha;
varying float vSoft;
varying float vErode;
varying float vFlat;
varying float vSmoke;
void main() {
  float age = uTime - iA.w;
  float life = iB.w;
  if ( age < -1e-3 || age >= life ) { ${OFFSCREEN_GLSL} return; }
  int kind = int( iD.w );
  float opacity = fract( iD.w );
  vSmoke = kind == 0 ? 1.0 : 0.0;
  vec4 k = uKind[ kind ];
  vec4 kb = uKindB[ kind ];   // x fade-in s, y fade-out start (life fraction), z turbulence m, w flat (1) / billboard (0)
  vec3 vel;
  vec3 p = fxPosition( age, k, vel );
  float x = age / life;
  float seed = iD.z;
  float size = mix( iD.x, iD.y, 1.0 - pow( 1.0 - x, 2.6 ) ) * uSizeScale;
  float turb = kb.z * ( 1.0 - exp( -age * 0.7 ) );
  p += turb * vec3( sin( age * 0.83 + seed * 37.1 ), 0.45 * sin( age * 0.61 + seed * 53.7 ), cos( age * 0.97 + seed * 71.3 ) );
  float ground = iE.w;
  vFlat = kb.w;
  if ( kb.w < 0.5 ) p.y = max( p.y, ground + size * 0.3 );
  // rotate the texture, not the quad (the lighting normal stays camera-aligned)
  float ang = seed * 6.2831853 + age * ( seed - 0.5 ) * ( 0.9 - 0.5 * vSmoke );
  float ca = cos( ang ), sa = sin( ang );
  vec2 c = position.xy;
  vUv = vec2( ca * c.x - sa * c.y, sa * c.x + ca * c.y ) * 0.5 + 0.5;
  vCorner = c;
  vec3 right, up;
  if ( kb.w > 0.5 ) {
    right = vec3( 1.0, 0.0, 0.0 );
    up = vec3( 0.0, 0.0, 1.0 );
  } else {
    right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
    up = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  }
  vec3 wp = p + ( right * c.x + up * c.y ) * size;
  if ( kb.w > 0.5 ) wp.y = ground + 0.03;
  vWorld = wp;
  vSoft = kb.w > 0.5 ? 1e3 : ( wp.y - ground ) / max( size * 0.45, 0.05 );
  float ch = floor( seed * 4.0 );
  vChannel = vec4( ch == 0.0 ? 1.0 : 0.0, ch == 1.0 ? 1.0 : 0.0, ch == 2.0 ? 1.0 : 0.0, ch >= 3.0 ? 1.0 : 0.0 );
  float fadeIn = smoothstep( 0.0, max( kb.x, 1e-3 ), age );
  float fadeOut = 1.0 - smoothstep( kb.y, 1.0, x );
  vErode = 0.55 * smoothstep( 0.25, 1.0, x );
  vColor = iE.rgb;
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  float dcam = -mvPosition.z;
  // particles around the camera dissolve instead of slicing through the near plane
  vAlpha = opacity * fadeIn * fadeOut * smoothstep( 0.25, 0.9 + size * 0.6, dcam );
  if ( uFocus.w > 0.0 && kb.w < 0.5 ) {
    // keep the player's car readable: billboards in front of it along the view ray thin out
    vec3 toF = uFocus.xyz - cameraPosition;
    float lf = max( length( toF ), 1e-3 );
    vec3 toP = p - cameraPosition;
    float along = dot( toP, toF ) / lf;
    float lateral = length( toP - toF * ( along / lf ) );
    float before = 1.0 - smoothstep( lf - uFocus.w, lf + 0.5 * uFocus.w, along );
    float onRay = 1.0 - smoothstep( uFocus.w + 0.4 * size, uFocus.w + 1.2 * size, lateral );
    vAlpha *= 1.0 - 0.5 * before * onRay;
  }
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SOFT_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uPuff;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
varying vec2 vUv;
varying vec2 vCorner;
varying vec4 vChannel;
varying vec3 vColor;
varying vec3 vWorld;
varying float vAlpha;
varying float vSoft;
varying float vErode;
varying float vFlat;
varying float vSmoke;
void main() {
  float vFlatInv = 1.0 - vFlat;
  float d;
  if ( vFlat > 0.5 ) {
    // expanding splash ring: thin bright annulus with a broken crest
    float r = length( vCorner );
    float ring = smoothstep( 0.72, 0.9, r ) * ( 1.0 - smoothstep( 0.9, 1.0, r ) );
    float brk = 0.6 + 0.4 * sin( atan( vCorner.y, vCorner.x ) * 11.0 + vColor.r * 40.0 );
    d = ring * brk;
  } else {
    d = dot( texture2D( uPuff, vUv ), vChannel );
    // tyre smoke: half the billow pattern traded for a smooth radial body (wispy, no visible noise)
    float r2 = dot( vCorner, vCorner );
    float body = clamp( 1.0 - r2, 0.0, 1.0 );
    d = mix( d, body * body * 0.8, 0.45 * vSmoke );
  }
  // derivatives before any discard (helper lanes stay well-defined)
  float px = max( length( vec2( dFdx( vCorner.x ), dFdy( vCorner.x ) ) ), 1e-4 );
  vec2 g = clamp( vec2( dFdx( d ), dFdy( d ) ) / px, -4.0, 4.0 ) * ( 1.0 - 0.65 * vSmoke );
  float den = smoothstep( vErode * ( 1.0 - 0.3 * vSmoke ), vErode + 0.5 + 0.35 * vSmoke, d );
  // soft rim on smoke billboards
  den *= 1.0 - vSmoke * smoothstep( 0.35, 1.0, length( vCorner ) );
  float a = vAlpha * den * clamp( vSoft, 0.0, 1.0 );
  if ( a < 0.003 ) discard;
  // lighting: a camera-facing sphere normal bent by the puff's density
  // gradient (screen-space derivatives → lumpy billows), wrapped diffuse
  // (translucent), forward scattering toward the sun, dense cores
  // self-shadowing, darker undersides
  vec2 q = vCorner;
  vec3 nv = normalize( vec3( q * 0.75 - g * 0.32 * vFlatInv, sqrt( max( 1.0 - dot( q, q ) * 0.7, 0.05 ) ) ) );
  vec3 nw = ( vec4( nv, 0.0 ) * viewMatrix ).xyz;
  float ndl = dot( nw, uSunDir );
  float wrap = clamp( ndl * 0.6 + 0.4, 0.0, 1.0 );
  vec3 V = normalize( vWorld - cameraPosition );
  float fwd = pow( max( dot( V, uSunDir ), 0.0 ), 5.0 );
  float self = mix( 1.0, 0.3 + 0.7 * wrap, clamp( d * 1.4, 0.0, 1.0 ) );
  float up = clamp( nw.y * 0.5 + 0.5, 0.0, 1.0 );
  vec3 amb = mix( uGroundAmb, uSkyAmb * 2.0, up ) * ( 0.6 + 0.4 * up ) * ( 1.0 - 0.25 * d );
  // multiple scattering whitens the key light inside the plume
  vec3 sunC = mix( vec3( dot( uSunColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), uSunColor, 0.55 );
  vec3 sun = sunC * ( wrap * wrap * self * 0.26 + fwd * ( 1.0 - 0.6 * d ) * 0.45 );
  gl_FragColor = vec4( vColor * ( amb + sun ), a );
  #include <fog_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;

/** Chips, clods, flakes, splinters, droplets: small alpha-tested lit bits, tumbling. */
const BITS_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${MOTION_GLSL}
varying vec2 vQ;
varying vec3 vColor;
varying float vLit;
varying float vSeed;
varying float vFade;
void main() {
  float age = uTime - iA.w;
  float life = iB.w;
  if ( age < -1e-3 || age >= life ) { ${OFFSCREEN_GLSL} return; }
  int kind = int( iD.w );
  vec4 k = uKind[ kind ];
  vec4 kb = uKindB[ kind ];   // x aspect (width/length), y tumble rate, z flutter, w unused
  vec3 vel;
  vec3 p = fxPosition( age, k, vel );
  float ground = iE.w;
  float size = iD.x;
  p.y = max( p.y, ground + size * 0.3 );
  float seed = iD.z;
  float landed = age > iC.w ? 1.0 : 0.0;
  float spin = kb.y * ( 0.5 + seed ) * ( 1.0 - 0.85 * landed );
  float tumble = abs( cos( age * spin + seed * 6.28 ) );
  float flatten = mix( max( tumble, 0.18 ), 0.35, landed );
  float ang = seed * 6.2831853 + age * spin * 0.6;
  float ca = cos( ang ), sa = sin( ang );
  vec2 c = position.xy * vec2( kb.x, flatten );
  c = vec2( ca * c.x - sa * c.y, sa * c.x + ca * c.y );
  vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  vec3 up = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  vec3 wp = p + ( right * c.x + up * c.y ) * size;
  vQ = position.xy;
  vColor = iE.rgb;
  vSeed = seed;
  vLit = 0.35 + 0.65 * abs( sin( age * spin * 1.3 + seed * 11.0 ) );
  vFade = 1.0 - smoothstep( 0.8, 1.0, age / life );
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BITS_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
varying vec2 vQ;
varying vec3 vColor;
varying float vLit;
varying float vSeed;
varying float vFade;
void main() {
  // irregular polygon outline per seed
  float th = atan( vQ.y, vQ.x );
  float rad = 0.72 + 0.16 * sin( th * 3.0 + vSeed * 40.0 ) + 0.1 * sin( th * 5.0 + vSeed * 17.0 );
  float r = length( vQ );
  if ( r > rad * vFade ) discard;
  float rim = 0.8 + 0.2 * ( 1.0 - r / rad );
  gl_FragColor = vec4( vColor * ( uSkyAmb * 0.9 + uSunColor * 0.28 * vLit ) * rim, 1.0 );
  #include <fog_fragment>
}
`;

/** Sparks: additive HDR streaks between p(t − shutter) and p(t), cooling white → orange → red. */
const SPARK_VERTEX = /* glsl */ `
#include <common>
${MOTION_GLSL}
uniform float uShutter;
uniform float uPxWorld;
varying vec2 vQ;
varying vec3 vEmit;
void main() {
  float age = uTime - iA.w;
  float life = iB.w;
  if ( age < -1e-3 || age >= life ) { ${OFFSCREEN_GLSL} return; }
  int kind = int( iD.w );
  vec4 k = uKind[ kind ];
  float ground = iE.w;
  vec3 vel;
  vec3 head = fxPosition( age, k, vel );
  vec3 vt;
  vec3 tail = fxPosition( max( age - uShutter, 0.0 ), k, vt );
  head.y = max( head.y, ground + 0.01 );
  tail.y = max( tail.y, ground + 0.01 );
  vec3 axis = head - tail;
  float len = length( axis );
  vec3 toCam = cameraPosition - head;
  float dcam = max( length( toCam ), 1e-3 );
  vec3 dir = len > 1e-5 ? axis / len : vec3( 0.0, 1.0, 0.0 );
  vec3 side = cross( dir, toCam / dcam );
  float sl = length( side );
  side = sl > 1e-4 ? side / sl : vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  // ≥ 1.4 px wide; energy conserved when widened (no sub-pixel shimmer)
  float w = iD.x;
  float wMin = 1.4 * uPxWorld * dcam;
  float energy = w / max( w, wMin );
  w = max( w, wMin );
  float t = position.y * 0.5 + 0.5;            // 0 tail … 1 head
  vec3 base = mix( tail, head, t );
  // round caps: push the ends out by half a width along the axis
  base += dir * position.y * w * 0.5;
  vec3 wp = base + side * position.x * w * 0.5;
  vQ = vec2( position.x, t );
  float x = age / life;
  float heat = 1.0 - x;
  vec3 hot = vec3( 1.0, 0.82, 0.55 );
  vec3 warm = vec3( 1.0, 0.42, 0.08 );
  vec3 cool = vec3( 0.8, 0.12, 0.02 );
  vec3 col = heat > 0.5 ? mix( warm, hot, ( heat - 0.5 ) * 2.0 ) : mix( cool, warm, heat * 2.0 );
  float intensity = iD.y * ( 0.15 + 0.85 * heat * heat ) * energy;
  // fade by distance (sparks skip the fog chunks: additive haze would brighten)
  intensity *= 1.0 - smoothstep( 120.0, 220.0, dcam );
  vEmit = col * iE.rgb * intensity;
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

const SPARK_FRAGMENT = /* glsl */ `
varying vec2 vQ;
varying vec3 vEmit;
void main() {
  float across = exp( -vQ.x * vQ.x * 3.5 );
  float along = 0.25 + 0.75 * smoothstep( 0.0, 0.85, vQ.y );
  vec3 c = vEmit * across * along;
  gl_FragColor = vec4( clamp( c, vec3( 0.0 ), vec3( ${FX_SPARK_MAX_RADIANCE.toFixed(1)} ) ), 1.0 );
}
`;

// ------------------------------------------------------------------ materials
export interface FxLightUniforms {
  uSunDir: { value: Vector3 };
  uSunColor: { value: Vector3 };
  uSkyAmb: { value: Vector3 };
  uGroundAmb: { value: Vector3 };
}
export function createLightUniforms(): FxLightUniforms {
  return {
    uSunDir: { value: new Vector3(0.3, 0.4, 0.6).normalize() },
    uSunColor: { value: new Vector3(6, 3, 1.2) },
    uSkyAmb: { value: new Vector3(0.6, 0.65, 0.75) },
    uGroundAmb: { value: new Vector3(0.25, 0.22, 0.18) },
  };
}

function motionUniforms(kinds: readonly KindMotion[], shaping: readonly (readonly number[])[]): Record<string, { value: unknown }> {
  const uKind: Vector4[] = [];
  const uKindB: Vector4[] = [];
  for (let i = 0; i < KIND_SLOTS; i++) {
    const m = kinds[i] ?? kinds[0]!;
    uKind.push(new Vector4(m.drag, m.gravity, m.rise, m.wind));
    const s = shaping[i] ?? shaping[0] ?? [0, 0, 0, 0];
    uKindB.push(new Vector4(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0));
  }
  return { uTime: { value: 0 }, uWind: { value: new Vector3(WIND[0], WIND[1], WIND[2]) }, uKind: { value: uKind }, uKindB: { value: uKindB } };
}

function setBlend(m: ShaderMaterial, additive: boolean): void {
  m.side = DoubleSide; // flat rings face down, spark ribbons either way
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = OneFactor;
  m.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = ZeroFactor;
  m.blendDstAlpha = OneFactor;
}

export function createSoftMaterial(
  puff: Texture,
  light: FxLightUniforms,
  kinds: readonly KindMotion[],
  shaping: readonly (readonly number[])[],
): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'fx.soft',
    vertexShader: SOFT_VERTEX,
    fragmentShader: SOFT_FRAGMENT,
    uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...motionUniforms(kinds, shaping), uPuff: { value: puff }, uSizeScale: { value: 1 }, uFocus: { value: new Vector4(0, 0, 0, 0) }, ...light },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  setBlend(m, false);
  return m;
}
export function createBitsMaterial(light: FxLightUniforms, kinds: readonly KindMotion[], shaping: readonly (readonly number[])[]): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'fx.bits',
    vertexShader: BITS_VERTEX,
    fragmentShader: BITS_FRAGMENT,
    uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...motionUniforms(kinds, shaping), uSunColor: light.uSunColor, uSkyAmb: light.uSkyAmb },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  setBlend(m, false);
  return m;
}
export function createSparkMaterial(kinds: readonly KindMotion[]): ShaderMaterial {
  const m = new ShaderMaterial({
    name: 'fx.sparks',
    vertexShader: SPARK_VERTEX,
    fragmentShader: SPARK_FRAGMENT,
    uniforms: { ...motionUniforms(kinds, []), uShutter: { value: 0.045 }, uPxWorld: { value: 0.001 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  setBlend(m, true);
  return m;
}

// ------------------------------------------------------------------ pool
interface Range {
  start: number;
  count: number;
}

export class ParticlePool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private capacityN: number;
  private data: Float32Array;
  private buffer: InstancedInterleavedBuffer;
  /** Death time per slot (sim s), for on-demand live counts. */
  private death: Float32Array;
  private next = 0;
  private used = 0;
  private dirtyStart = -1;
  private dirtyCount = 0;
  private readonly rangeA: Range = { start: 0, count: 0 };
  private readonly rangeB: Range = { start: 0, count: 0 };
  readonly kinds: readonly KindMotion[];

  constructor(name: string, capacity: number, material: ShaderMaterial, kinds: readonly KindMotion[], renderOrder: number) {
    this.kinds = kinds;
    this.capacityN = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacityN * RECORD_FLOATS);
    this.death = new Float32Array(this.capacityN);
    this.buffer = this.makeBuffer();
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.bind(g);
    g.instanceCount = 0;
    this.mesh = new Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.layers.set(LAYER_NO_REFLECTION);
    this.mesh.matrixAutoUpdate = false;
  }

  private makeBuffer(): InstancedInterleavedBuffer {
    const b = new InstancedInterleavedBuffer(this.data, RECORD_FLOATS, 1);
    b.setUsage(DynamicDrawUsage);
    return b;
  }
  private bind(g: InstancedBufferGeometry): void {
    g.setAttribute('iA', new InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('iB', new InterleavedBufferAttribute(this.buffer, 4, 4));
    g.setAttribute('iC', new InterleavedBufferAttribute(this.buffer, 4, 8));
    g.setAttribute('iD', new InterleavedBufferAttribute(this.buffer, 4, 12));
    g.setAttribute('iE', new InterleavedBufferAttribute(this.buffer, 4, 16));
  }

  get capacity(): number {
    return this.capacityN;
  }
  /** Slots ever written (draw instance count). */
  get drawn(): number {
    return this.used;
  }

  /** Writes one record (recycles the oldest slot when full). Allocation-free. */
  spawn(s: ParticleSpawn): void {
    const i = this.next;
    this.next = i + 1 === this.capacityN ? 0 : i + 1;
    if (this.used < this.capacityN && i + 1 > this.used) this.used = i + 1;
    const o = i * RECORD_FLOATS;
    const d = this.data;
    const m = this.kinds[s.kind] ?? this.kinds[0]!;
    let tb = NO_BOUNCE;
    let bx = 0;
    let by = 0;
    let bz = 0;
    if (s.bounce > 0) {
      tb = solveGroundHit(s.py, s.vy, s.ground, m);
      if (tb < NO_BOUNCE) {
        const k = Math.max(m.drag, 0.01);
        const e = Math.exp(-k * tb);
        // horizontal terminal velocity = wind·factor (uWind is fixed; see WIND)
        const twx = WIND[0] * m.wind;
        const twz = WIND[2] * m.wind;
        const vx = twx + (s.vx - twx) * e;
        const vz = twz + (s.vz - twz) * e;
        const vy = motionVY(s.vy, tb, m);
        bx = vx * s.friction;
        by = -vy * s.bounce;
        bz = vz * s.friction;
        if (tb === 0) by = Math.abs(s.vy) * s.bounce;
      }
    }
    d[o] = s.px;
    d[o + 1] = s.py;
    d[o + 2] = s.pz;
    d[o + 3] = s.birth;
    d[o + 4] = s.vx;
    d[o + 5] = s.vy;
    d[o + 6] = s.vz;
    d[o + 7] = s.life;
    d[o + 8] = bx;
    d[o + 9] = by;
    d[o + 10] = bz;
    d[o + 11] = tb;
    d[o + 12] = s.size0;
    d[o + 13] = s.size1;
    d[o + 14] = s.seed;
    d[o + 15] = (s.kind | 0) + Math.min(Math.max(s.opacity, 0), 0.999);
    d[o + 16] = s.r;
    d[o + 17] = s.g;
    d[o + 18] = s.b;
    d[o + 19] = s.ground;
    this.death[i] = s.birth + s.life;
    if (this.dirtyStart < 0) {
      this.dirtyStart = i;
      this.dirtyCount = 1;
    } else if (this.dirtyCount < this.capacityN) this.dirtyCount++;
  }

  /** Queues the touched slice(s) for upload; call once per frame after spawning. */
  flush(time: number): void {
    const mat = this.mesh.material;
    (mat.uniforms.uTime as { value: number }).value = time;
    this.mesh.geometry.instanceCount = this.used;
    if (this.dirtyStart < 0) return;
    const b = this.buffer;
    const F = RECORD_FLOATS;
    if (this.dirtyCount >= this.capacityN) {
      this.rangeA.start = 0;
      this.rangeA.count = this.capacityN * F;
      b.updateRanges.push(this.rangeA);
    } else {
      const end = this.dirtyStart + this.dirtyCount;
      if (end <= this.capacityN) {
        this.rangeA.start = this.dirtyStart * F;
        this.rangeA.count = this.dirtyCount * F;
        b.updateRanges.push(this.rangeA);
      } else {
        this.rangeA.start = this.dirtyStart * F;
        this.rangeA.count = (this.capacityN - this.dirtyStart) * F;
        this.rangeB.start = 0;
        this.rangeB.count = (end - this.capacityN) * F;
        b.updateRanges.push(this.rangeA, this.rangeB);
      }
    }
    b.needsUpdate = true;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
  }

  /** Live particles at sim time `time` (on-demand stats; O(capacity)). */
  live(time: number): number {
    let n = 0;
    const birth = this.data;
    for (let i = 0; i < this.used; i++) {
      const b = birth[i * RECORD_FLOATS + 3]!;
      if (time >= b - 1e-3 && time < this.death[i]!) n++; // births are f32
    }
    return n;
  }
  /** True when any record can still be alive at `time`. */
  anyAlive(time: number): boolean {
    for (let i = 0; i < this.used; i++) if (time < this.death[i]!) return true;
    return false;
  }

  clear(): void {
    this.data.fill(0);
    this.death.fill(0);
    this.next = 0;
    this.used = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.mesh.geometry.instanceCount = 0;
    this.buffer.updateRanges.length = 0;
    this.buffer.needsUpdate = true;
  }

  /** Reallocates for a new budget (quality change only); drops live particles. */
  resize(capacity: number): void {
    const n = Math.max(1, capacity | 0);
    if (n === this.capacityN) return;
    this.capacityN = n;
    this.data = new Float32Array(n * RECORD_FLOATS);
    this.death = new Float32Array(n);
    this.buffer = this.makeBuffer();
    const g = this.mesh.geometry;
    g.dispose();
    this.bind(g);
    this.next = 0;
    this.used = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    g.instanceCount = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Wind (world m/s) shared by every pool's uWind (CPU bounce solve uses it too). */
export const WIND: readonly [number, number, number] = [0.8, 0, 0.35];
