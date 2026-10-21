/**
 * The environment patch: one ShaderPatch that patchMaterial composes into
 * EVERY world-lit material (every material patched with `{ csm }`, after the
 * PATCH_ORDER features). It carries what the time of day and weather change
 * per frame without recompiling anything:
 *
 *  - aerial perspective: the global fog chunk (lighting.ts) takes its haze
 *    colour from the physically based sky in the fog ray's direction — an L2
 *    spherical-harmonics fit of the sky dome's radiance (projected on the GPU
 *    from the sky-view LUT, read back asynchronously) plus an analytic Mie
 *    glow toward the sun — with Rayleigh + height-Mie extinction
 *    (CRUMPLE_ENV path). No sampler: texture units are scarce on the car
 *    paint (CSM ×4, flexbody ×2, maps, spot shadow + cookie);
 *  - key-light visibility: the CSM chunk's directional shadow factor is kept
 *    in `crumpleKeyVis` (min over the cascades shading the fragment) so
 *    materials can shade light that does not go through RE_Direct (foliage
 *    translucency) with the same shadows;
 *  - clustered night lights (lightGrid.ts): streetlights, floodlights, traffic
 *    lamps lit through RE_Direct from one packed float texture;
 *  - lamp lenses (`env: { lamp }`): emissive scaled from a day level up to full
 *    as the night light gain rises;
 *  - cloud shadows: the key light (every directional light the CSM chunk
 *    evaluates) is multiplied by the cloud layer's transmittance map
 *    (clouds.ts), and `crumpleKeyVis` includes it;
 *  - WETNESS (`crumpleWet`: x = surface wetness 0..1, y = rain 0..1, z =
 *    time s): every world-lit surface darkens where porous and turns glossy
 *    where it faces the sky (`env: { wet }` picks the response: 'ground' for
 *    terrain / roads / concrete — strongest darkening, the shaders add
 *    puddles and ripples —, 'paint' for car bodies — water beads in the
 *    clearcoat —, 'none' to opt out; default 'generic').
 *
 * The uniforms are module singletons ({value} objects shared by reference:
 * three clones a built-in material's ShaderLib uniforms, but a uniform object
 * assigned in onBeforeCompile is used as is), so one write per frame reaches
 * every program. Materials that are not world-lit (sky, particles, studio)
 * keep three's plain fog path against scene.fog.color.
 */
import { ShaderChunk } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

import type { ShaderPatch } from '../types';
import { ENV_UNIFORMS, envPatchFor, HAZE_GLOW_G, setEnvInjector, type EnvOptions } from './envUniforms';
import { LIGHT_GRID_GLSL } from './lightGrid';
import { SKY_LOOKUP } from './sky.glsl';

export { AERIAL_RAYLEIGH_PER_M, ENV_PATCH_KEY, ENV_UNIFORMS, HAZE_GLOW_G, type EnvOptions, type EnvUniforms } from './envUniforms';


/** The sky-view LUT lookup and its uniforms (sky dome, IBL capture, probe — not materials). */
export const SKY_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D crumpleSkyView;
uniform float crumpleSkyHeight;
uniform vec3 crumpleSunDir;
uniform float crumpleSkySunE;
uniform vec3 crumpleNightZenith;
uniform vec3 crumpleNightHorizon;
uniform vec3 crumpleMoonDir;
uniform vec3 crumpleMoonGlow;
uniform vec4 crumpleOvercast;
uniform float crumpleEnvIntensity;
${SKY_LOOKUP}
`;

/** GLSL declarations of the shared uniforms for world-lit materials (fragment stage). */
export const ENV_PARS_FRAGMENT = /* glsl */ `
uniform vec3 crumpleHazeSH[ 9 ];
uniform vec3 crumpleHazeGlow;
uniform vec3 crumpleSunDir;
uniform vec3 crumpleBetaR;
uniform float crumpleEnvIntensity;
uniform highp sampler2D crumpleLightGrid;
uniform vec2 crumpleGridOrigin;
uniform float crumpleLightGain;
uniform sampler2D crumpleCloudShadow;
uniform vec4 crumpleCloudRect;
uniform vec4 crumpleWet;
uniform vec4 crumpleBeamAxis;
uniform vec4 crumpleBeamUp;
/** Headlight beam pattern (headlights.ts beamPattern), x right / y up in units of the cone's tan. */
float crumpleBeamPattern( float x, float y, bool high ) {
  if ( high ) {
    float core = exp( - ( x * x / 0.09 + ( y - 0.02 ) * ( y - 0.02 ) / 0.035 ) );
    float spread = exp( - ( x * x / 0.55 + y * y / 0.25 ) );
    return min( 1.0, core * 0.85 + spread * 0.3 );
  }
  float cut = 0.03 + clamp( ( x - 0.02 ) / 0.12, 0.0, 1.0 ) * 0.13;
  float below = smoothstep( cut + 0.02, cut - 0.025, y );
  float hot = exp( - ( ( x - 0.06 ) * ( x - 0.06 ) / 0.05 + ( y + 0.025 ) * ( y + 0.025 ) / 0.004 ) );
  float wide = exp( - x * x / 0.45 ) * smoothstep( -0.7, -0.04, y ) * exp( - ( y + 0.04 ) * ( y + 0.04 ) / 0.06 );
  float fore = 0.25 * smoothstep( -1.0, -0.3, y );
  return min( 1.0, below * ( hot * 0.85 + wide * 0.45 + fore + 0.02 ) );
}
/** The beam pattern toward a fragment (view-space positions of the fragment and the lamp). */
float crumpleBeam( vec3 fragV, vec3 lampV ) {
  vec3 ax = normalize( mat3( viewMatrix ) * crumpleBeamAxis.xyz );
  vec3 up = normalize( mat3( viewMatrix ) * crumpleBeamUp.xyz );
  vec3 rt = normalize( cross( ax, up ) );
  vec3 d = fragV - lampV;
  float z = max( dot( d, ax ), 1e-3 );
  float t = crumpleBeamAxis.w;
  return crumpleBeamPattern( dot( d, rt ) / z / t, dot( d, up ) / z / t, crumpleBeamUp.w > 0.5 );
}
#if CRUMPLE_WET == 2
uniform sampler2D crumplePuddleMap;
uniform vec4 crumplePuddleRect;
#endif
float crumpleHash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float crumpleNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( crumpleHash12( i ), crumpleHash12( i + vec2( 1.0, 0.0 ) ), f.x ), mix( crumpleHash12( i + vec2( 0.0, 1.0 ) ), crumpleHash12( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
/** Rain ripples: rings spreading from random points (p in metres, t seconds); returns the surface slope (world xz). */
vec2 crumpleRipples( vec2 p, float t ) {
  vec2 g = p * 2.4;
  vec2 c0 = floor( g );
  vec2 s = vec2( 0.0 );
  for ( int j = -1; j <= 1; j ++ )
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 c = c0 + vec2( float( i ), float( j ) );
      float h = crumpleHash12( c );
      vec2 ctr = c + vec2( crumpleHash12( c + 7.1 ), crumpleHash12( c + 3.7 ) );
      float ph = fract( t * ( 0.7 + 0.5 * h ) + h * 9.0 );
      vec2 d = g - ctr;
      float dl = length( d );
      float x = ( dl - ph * 1.1 ) * 9.0;
      float ring = x > -3.14159 && x < 3.14159 ? sin( x ) * ( 1.0 - ph ) * ( 1.0 - ph ) : 0.0;
      s += d / max( dl, 1e-3 ) * ring;
    }
  return s;
}
/** Water beads on a surface (cell-jittered droplets); xy = normal tilt, z = coverage. p in metres. */
vec3 crumpleBeads( vec2 p ) {
  vec2 g = p * 55.0;
  vec2 c = floor( g );
  vec3 acc = vec3( 0.0 );
  for ( int j = 0; j <= 1; j ++ )
    for ( int i = 0; i <= 1; i ++ ) {
      vec2 cc = c + vec2( float( i ), float( j ) );
      float h = crumpleHash12( cc );
      vec2 o = cc + vec2( crumpleHash12( cc + 17.0 ), crumpleHash12( cc + 31.0 ) ) - g;
      float r = 0.18 + 0.32 * h * h;
      float d = length( o );
      float m = 1.0 - smoothstep( r * 0.75, r, d );
      if ( h > 0.55 ) acc += vec3( -o / r * m * 0.9, m );
    }
  return acc;
}
/** Sky radiance seen along d (haze colour): SH L2 + Mie glow toward the sun. */
vec3 crumpleHaze( vec3 d ) {
  vec3 c = crumpleHazeSH[ 0 ] * 0.282095
    + crumpleHazeSH[ 1 ] * ( 0.488603 * d.y ) + crumpleHazeSH[ 2 ] * ( 0.488603 * d.z ) + crumpleHazeSH[ 3 ] * ( 0.488603 * d.x )
    + crumpleHazeSH[ 4 ] * ( 1.092548 * d.x * d.y ) + crumpleHazeSH[ 5 ] * ( 1.092548 * d.y * d.z )
    + crumpleHazeSH[ 6 ] * ( 0.315392 * ( 3.0 * d.z * d.z - 1.0 ) ) + crumpleHazeSH[ 7 ] * ( 1.092548 * d.x * d.z )
    + crumpleHazeSH[ 8 ] * ( 0.546274 * ( d.x * d.x - d.y * d.y ) );
  float g = ${HAZE_GLOW_G.toFixed(3)};
  float k = 1.0 + g * g - 2.0 * g * dot( d, crumpleSunDir );
  c += crumpleHazeGlow * ( ( 1.0 - g * g ) / ( 12.566371 * k * sqrt( k ) ) );
  return max( c, vec3( 0.0 ) );
}
`;

const GROUND_UNIFORM_NAMES = ['crumplePuddleMap', 'crumplePuddleRect'] as const;

const ENV_UNIFORM_NAMES = [
  'crumpleHazeSH',
  'crumpleHazeGlow',
  'crumpleSunDir',
  'crumpleBetaR',
  'crumpleEnvIntensity',
  'crumpleLightGrid',
  'crumpleGridOrigin',
  'crumpleLightGain',
  'crumpleCloudShadow',
  'crumpleCloudRect',
  'crumpleWet',
  'crumpleBeamAxis',
  'crumpleBeamUp',
] as const;

/** 'road' = ground without the puddle map (road shaders are at the 16-sampler limit): puddles from noise alone. */
const WET_MODE = { none: 0, generic: 1, ground: 2, paint: 3, road: 4 } as const;

/**
 * Wet surfaces, after <lights_physical_fragment> (material struct built):
 * water fills the micro-pores (darker diffuse where rough / porous) and
 * forms a smooth film where the surface faces the sky; paint keeps its
 * clearcoat glossy and gets beads (normal set in WET_NORMAL_GLSL).
 */
const WET_MATERIAL_GLSL = /* glsl */ `
#if CRUMPLE_WET > 0
if ( crumpleWet.x > 0.001 ) {
  vec3 wetN = transpose( mat3( viewMatrix ) ) * normal;
  float wetUp = smoothstep( 0.05, 0.75, wetN.y );
  float wet = crumpleWet.x * mix( 0.3, 1.0, wetUp );
  float por = smoothstep( 0.3, 0.85, material.roughness );
  #if CRUMPLE_WET == 2 || CRUMPLE_WET == 4
    // ground: pores fill (darker), a thin film (glossy but still textured), then puddles where the
    // heightfield is concave (puddle map) and the noise allows, growing with the wetness
    #ifdef CRUMPLE_WET_FILM
      float film = clamp( CRUMPLE_WET_FILM, 0.0, 1.0 ); // the host shader's film capacity (terrain: turf 0)
    #else
      float film = 1.0;
    #endif
    material.diffuseColor *= mix( 1.0, 0.55, wet * por );
    float filmR = mix( material.roughness * 0.82, mix( 0.4, 0.17, wetUp ), film );
    material.roughness = mix( material.roughness, filmR, wet * mix( 0.6, 1.0, wetUp ) );
    vec3 gW = transpose( mat3( viewMatrix ) ) * ( - vViewPosition - viewMatrix[ 3 ].xyz );
    #if CRUMPLE_WET == 2
      float pot = texture2D( crumplePuddleMap, ( gW.xz - crumplePuddleRect.xy ) * crumplePuddleRect.zw ).r;
    #else
      float pot = 0.32;
    #endif
    float pn = crumpleNoise2( gW.xz * 0.31 ) * 0.62 + crumpleNoise2( gW.xz * 1.37 + 5.0 ) * 0.38;
    float pud = smoothstep( 0.6, 0.66, pot * 0.85 + pn * 0.55 + ( crumpleWet.x - 1.0 ) * 0.6 + 0.12 - ( 1.0 - film ) * 0.08 ) * wetUp;
    if ( pud > 0.0 ) {
      material.diffuseColor *= mix( 1.0, 0.6, pud );
      material.roughness = mix( material.roughness, 0.025, pud );
      vec3 upV = normalize( mat3( viewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
      vec3 pn3 = normalize( mix( normal, upV, pud ) );
      if ( crumpleWet.y > 0.02 ) {
        vec2 rs = crumpleRipples( gW.xz, crumpleWet.z ) * 0.07 * crumpleWet.y * pud;
        pn3 = normalize( pn3 + mat3( viewMatrix ) * vec3( rs.x, 0.0, rs.y ) );
      }
      normal = pn3;
    }
  #elif CRUMPLE_WET == 3
    material.roughness = mix( material.roughness, material.roughness * 0.7, wet );
  #else
    material.diffuseColor *= mix( 1.0, 0.72, wet * por );
    material.roughness = mix( material.roughness, max( 0.1, material.roughness * 0.45 ), wet * wetUp );
  #endif
}
#endif
`;

/** Paint: rain beads on the clearcoat, after <clearcoat_normal_fragment_maps> (vFlexRest = rest-space position of the car body). */
const WET_NORMAL_GLSL = /* glsl */ `
#if CRUMPLE_WET == 3 && defined( USE_CLEARCOAT )
if ( crumpleWet.x > 0.05 ) {
  #ifdef FLEXBODY
    vec3 bp = vFlexRest;
  #else
    vec3 bp = vec3( 0.0 );
  #endif
  vec3 bwN = transpose( mat3( viewMatrix ) ) * clearcoatNormal;
  vec3 ba = abs( bwN );
  vec2 buv = ba.y > max( ba.x, ba.z ) ? bp.xz : ( ba.x > ba.z ? bp.zy : bp.xy );
  vec3 b = crumpleBeads( buv );
  float side = 1.0 - smoothstep( 0.2, 0.9, abs( bwN.y ) ) * 0.4;
  float k = smoothstep( 0.05, 0.6, crumpleWet.x ) * side;
  vec3 bt = normalize( cross( clearcoatNormal, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) );
  vec3 bb = cross( clearcoatNormal, bt );
  clearcoatNormal = normalize( clearcoatNormal + ( bt * b.x + bb * b.y ) * k * 0.9 );
}
#endif
`;

const DIR_SHADOW_RE =
  /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \]([^;]*?)\) : 1\.0;/g;

/**
 * The (CSM) lights_fragment_begin chunk with every directional shadow factor
 * also folded into `crumpleKeyVis`. Pure string transform (exported for tests).
 */
export function lightsBeginWithKeyVis(chunk: string): string {
  const body = chunk
    .replace(
      DIR_SHADOW_RE,
      '{ float crumpleSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]$1) : 1.0; crumpleKeyVis = min( crumpleKeyVis, crumpleSh * crumpleCloudSh ); directLight.color *= crumpleSh; }',
    )
    .replace(DIR_INFO_RE, '$& directLight.color *= crumpleCloudSh;')
    // the only spot lights are the player's headlights: shape them by the beam (no cookie texture unit)
    .replace(SPOT_INFO_RE, '$& directLight.color *= crumpleBeam( geometryPosition, spotLight.position );');
  return `${CLOUD_SHADOW_PRELUDE}\nfloat crumpleKeyVis = crumpleCloudSh;\n${body}`;
}

const SPOT_INFO_RE = /getSpotLightInfo\( spotLight, geometryPosition, directLight \);/g;
const DIR_INFO_RE = /getDirectionalLightInfo\( directionalLight(?:s\[ ?\w+ ?\])?, directLight \);/g;

/** World position from the view-space varying; the cloud-shadow transmittance there. */
const CLOUD_SHADOW_PRELUDE = /* glsl */ `
float crumpleCloudSh = 1.0;
{
  vec3 ccW = transpose( mat3( viewMatrix ) ) * ( - vViewPosition - viewMatrix[ 3 ].xyz );
  vec2 ccUv = ( ccW.xz - crumpleCloudRect.xy ) * crumpleCloudRect.z;
  crumpleCloudSh = ( ccUv.x > 0.0 && ccUv.y > 0.0 && ccUv.x < 1.0 && ccUv.y < 1.0 ) ? texture2D( crumpleCloudShadow, ccUv ).r : crumpleCloudRect.w;
}`;

/** Adds the env uniforms (by reference) and declarations to a program. False if the shader has no `#include <common>`. */
export function injectEnv(shader: WebGLProgramParametersWithUniforms, opts: EnvOptions = {}): boolean {
  let fs = shader.fragmentShader;
  if (!fs.includes('#include <common>')) return false;
  for (const k of ENV_UNIFORM_NAMES) shader.uniforms[k] = ENV_UNIFORMS[k];
  fs = fs.replace('#include <common>', `#include <common>\n${ENV_PARS_FRAGMENT}`);
  let defs = '#define CRUMPLE_ENV\n';
  if (fs.includes('#include <lights_fragment_begin>')) {
    fs = fs.replace('#include <lights_fragment_begin>', lightsBeginWithKeyVis(ShaderChunk.lights_fragment_begin));
    defs += '#define CRUMPLE_KEYVIS\n';
  }
  if (fs.includes('#include <lights_fragment_end>')) {
    fs = fs.replace('#include <lights_fragment_end>', `${LIGHT_GRID_GLSL}\n#include <lights_fragment_end>`);
    defs += '#define CRUMPLE_LIGHTS\n';
  }
  const wet = WET_MODE[opts.wet ?? 'generic'];
  defs += `#define CRUMPLE_WET ${wet}\n`;
  if (wet === 2) for (const k of GROUND_UNIFORM_NAMES) shader.uniforms[k] = ENV_UNIFORMS[k];
  if (wet > 0 && fs.includes('#include <lights_physical_fragment>')) {
    fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${WET_MATERIAL_GLSL}`);
  }
  if (wet === 3 && fs.includes('#include <clearcoat_normal_fragment_maps>')) {
    fs = fs.replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>\n${WET_NORMAL_GLSL}`);
  }
  if (opts.lamp !== undefined && fs.includes('#include <emissivemap_fragment>')) {
    const day = Math.max(0, Math.min(1, opts.lamp)).toFixed(3);
    fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= mix( ${day}, 1.0, crumpleLightGain );`);
  }
  shader.fragmentShader = defs + fs;
  return true;
}

setEnvInjector(injectEnv);
export { envPatchFor };
export const ENV_PATCH: ShaderPatch = envPatchFor();
