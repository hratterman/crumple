/**
 * Vehicle material factory (A3; contract: ./types.ts "materials (A3)").
 *
 * One BASE material per MaterialSlot. Consumers clone it and patch the
 * clone (patchMaterial composes CSM → flexbody → damage after the hook a
 * base carries). Base materials carry their own `onBeforeCompile` +
 * `customProgramCacheKey` (own properties; `clone()` is overridden to keep
 * them and to register the clone), so the per-vehicle uniforms below stay
 * shared by every clone: `setLights` / `setPaint` reach all of them.
 *
 * Paint: MeshPhysicalMaterial clearcoat. Base coat = colour + metalness +
 * a procedural flake normal map (mipmapped: sparkle up close, smooth sheen
 * far away); clearcoat = its own orange-peel micro-normal; plus two hook
 * terms: per-flake SUN GLINTS (a sharp specular lobe off a random per-cell
 * flake normal inside RE_Direct, so they are shadowed per CSM cascade) and
 * a pearl colour shift toward grazing angles.
 *
 * Glass: ultra = physical transmission (thin-walled, tinted); other
 * presets = premultiplied-alpha "fresnel glass" (reflections at full
 * strength, background attenuated by (1 − F)·T). Behind the B-pillar
 * (rest z > privacyZ, derived from the glass panels) it turns into darker
 * privacy glass.
 *
 * Lamps: lens over reflector optics (normal-mapped), emissive patterns
 * computed in rest space from the slot's lamp bounding box (|x| mirrored):
 * head = DRL light-guide strip + two projector "eyes"; tail = contour
 * light guide (tail) + fill (brake); reverse / indicator = fill.
 * Indicators pick their side from sign(rest x).
 *
 * Every hook reads only its own varyings (vCrUv = uv, vCrRest = position =
 * REST rig-local for flexbody panels), so it never depends on the order
 * of later patches.
 *
 * Panel finish (P6, weathering.ts): when the def has panels with a
 * `PanelDef.finish`, the slots carrying them get the weathering hook after
 * their own (cache key + '|wx1'), reading a per-panel finish texture by
 * the flexskin panel index. Defs without a finish compile exactly as
 * before.
 */
import {
  Color,
  DoubleSide,
  FrontSide,
  Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderChunk,
  ShaderLib,
  Vector2,
  Vector3,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { VehicleTelemetryFrame } from '../../protocol/telemetry';
import type { RenderContext } from '../types';
import { setVehicleTextureAnisotropy, vehicleTextures } from './textures';
import {
  applyWeatherGlsl,
  buildFinishData,
  createFinishTexture,
  createWeatherUniforms,
  finishExtras,
  WEATHER_KEY,
  type FinishData,
} from './weathering';
import type {
  CreateVehicleMaterials,
  LightState,
  MaterialSlot,
  PaintDef,
  PanelDef,
  VehicleMaterialSet,
  VehicleVisualDef,
  WheelVisualDef,
} from './types';

type AnyMat = MeshStandardMaterial | MeshPhysicalMaterial;
type Uniform<T> = { value: T };

export const MATERIAL_SLOTS: readonly MaterialSlot[] = [
  'paint',
  'trim',
  'chrome',
  'glass',
  'rubber',
  'lightHead',
  'lightTail',
  'lightIndicator',
  'lightReverse',
  'interior',
  'interiorTrim',
  'grille',
  'mirror',
  'underbody',
  'plate',
  'rim',
  'tire',
  'brakeDisc',
  'caliper',
];

// ============================================================ palette
/**
 * Eight factory colours. flake.scale = flake size in millimetres, density =
 * share of reflective flakes, intensity = flake tilt / sparkle strength.
 */
export const PAINT_PALETTE = {
  /** Deep candy red over a bright metallic base. */
  crimsonCandy: {
    color: 0x7a0610,
    metallic: 0.55,
    roughness: 0.34,
    clearcoat: 1,
    clearcoatRoughness: 0.025,
    flake: { density: 0.75, scale: 0.55, intensity: 0.8 },
    pearl: 0.15,
  },
  /** Midnight blue metallic. */
  midnightBlue: {
    color: 0x0c2148,
    metallic: 0.7,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    flake: { density: 0.8, scale: 0.5, intensity: 0.85 },
  },
  /** Tri-coat pearl white. */
  pearlWhite: {
    color: 0xe9e7e0,
    metallic: 0.05,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    flake: { density: 0.35, scale: 0.4, intensity: 0.35 },
    pearl: 0.55,
  },
  /** Obsidian black with a fine silver flake. */
  obsidianBlack: {
    color: 0x07080a,
    metallic: 0.6,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.015,
    flake: { density: 0.55, scale: 0.4, intensity: 0.7 },
  },
  /** British racing green metallic. */
  racingGreen: {
    color: 0x0c2e1f,
    metallic: 0.6,
    roughness: 0.33,
    clearcoat: 1,
    clearcoatRoughness: 0.025,
    flake: { density: 0.7, scale: 0.55, intensity: 0.75 },
    pearl: 0.1,
  },
  /** Liquid silver. */
  liquidSilver: {
    color: 0xb5b9bf,
    metallic: 0.9,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.025,
    flake: { density: 0.9, scale: 0.45, intensity: 0.7 },
  },
  /** Solid sunset orange (no flake). */
  sunsetOrange: {
    color: 0xd4470f,
    metallic: 0,
    roughness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    flake: null,
    pearl: 0.2,
  },
  /** Flat-solid graphite grey (no flake). */
  graphite: {
    color: 0x5b5f63,
    metallic: 0,
    roughness: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
    flake: null,
  },
} as const satisfies Record<string, PaintDef>;
export type PaintName = keyof typeof PAINT_PALETTE;
export const PAINT_NAMES = Object.keys(PAINT_PALETTE) as PaintName[];

// ============================================================ tuning
/** Texture repeats per metre of UV (UVs are arc length in metres). */
export const TEXTURE_DENSITY = {
  /** Flake tile ≈ 128 cells: flake mm × 128. */
  orangePeel: 18,
  plasticGrain: 22,
  leather: 11,
  fabric: 55,
  reflector: 16,
  prism: 22,
  honeycomb: 7,
  rubber: 12,
} as const;
/** Licence plate: UV metres from the plate's min corner, EU 520 × 110 mm. */
export const PLATE_SIZE_M: readonly [number, number] = [0.52, 0.11];
/** Glass transmittance (1 = clear) front / privacy, and tint (sRGB). */
export const GLASS_TUNING = {
  transmittance: 0.72,
  privacyTransmittance: 0.22,
  tint: 0x9db3ab,
  /** z blend half-width at the privacy split, m. */
  privacyBlend: 0.03,
} as const;
/** Flake glint lobe exponent (sun disc + haze). */
export const GLINT_POWER = 320;
/**
 * Flake glint gain: each glint is the SUN mirrored by one flake, far
 * brighter than the base coat's spread lobe (sub-pixel flakes are sampled
 * one cell per pixel, so the expected energy stays right).
 */
export const GLINT_STRENGTH = 14;
/** HDR emissive levels (scene-linear; bloom threshold is 1.8). */
export const LAMP_LEVELS = {
  drl: 9,
  lowBeam: 34,
  highBeam: 46,
  lensGlow: 0.25,
  tail: 3.5,
  brake: 3,
  reverse: 9,
  indicator: 16,
  fog: 10,
} as const;

/**
 * Builds the lamp state from telemetry: brake lamps follow the APPLIED
 * brake (and the handbrake at standstill-ish speeds stays dark), reverse
 * lamps whenever reverse is engaged. Headlights / indicators are game
 * state, passed in.
 */
export function lightStateFromTelemetry(
  t: VehicleTelemetryFrame | null,
  out: LightState,
  game: { head?: boolean; highBeam?: boolean; indicatorL?: boolean; indicatorR?: boolean; fog?: boolean } = {},
): LightState {
  const brake = t ? t.brake : 0;
  out.brake = brake > 0.02 ? Math.min(1, 0.6 + brake) : 0;
  out.reverse = t ? t.gear < 0 : false;
  out.head = game.head ?? false;
  out.highBeam = game.highBeam ?? false;
  out.indicatorL = game.indicatorL ?? false;
  out.indicatorR = game.indicatorR ?? false;
  out.fog = game.fog ?? false;
  return out;
}

export function createLightState(): LightState {
  return { head: false, highBeam: false, brake: 0, reverse: false, indicatorL: false, indicatorR: false, fog: false };
}

// ============================================================ rest-space extents from the visual def
interface Box {
  min: Vector3;
  max: Vector3;
}

/** Rest-space points of a panel surface (lofts: control points inside the window). */
function surfacePoints(p: PanelDef, cb: (x: number, y: number, z: number) => void): void {
  const s = p.surface;
  if (s.type === 'mesh') {
    for (let i = 0; i + 2 < s.position.length; i += 3) cb(s.position[i]!, s.position[i + 1]!, s.position[i + 2]!);
    return;
  }
  const w = s.window ?? { u0: 0, u1: 1, v0: 0, v1: 1 };
  const nv = s.sections.length;
  s.sections.forEach((sec, j) => {
    const v = nv > 1 ? j / (nv - 1) : 0;
    if (v < w.v0 - 1e-6 || v > w.v1 + 1e-6) return;
    const nu = sec.length;
    sec.forEach((pt, i) => {
      const u = nu > 1 ? i / (nu - 1) : 0;
      if (u < w.u0 - 1e-6 || u > w.u1 + 1e-6) return;
      cb(pt[0], pt[1], pt[2]);
    });
  });
}

/** Mirrored (|x|) bounding box of every panel using `slot`, or null. */
export function slotBox(def: VehicleVisualDef, slot: MaterialSlot): Box | null {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of def.panels) {
    if (p.material !== slot) continue;
    surfacePoints(p, (x, y, z) => {
      const ax = Math.abs(x);
      min.set(Math.min(min.x, ax), Math.min(min.y, y), Math.min(min.z, z));
      max.set(Math.max(max.x, ax), Math.max(max.y, y), Math.max(max.z, z));
    });
  }
  return Number.isFinite(min.x) ? { min, max } : null;
}

/**
 * Privacy-glass split (rest z, forward −Z): halfway between the front-most
 * and rear-most glass panel centroids (≈ the B-pillar on a sedan). Infinity
 * (never) when the car has < 2 glass panels.
 */
export function privacySplitZ(def: VehicleVisualDef): number {
  const cz: number[] = [];
  for (const p of def.panels) {
    if (p.material !== 'glass') continue;
    let s = 0;
    let n = 0;
    surfacePoints(p, (_x, _y, z) => {
      s += z;
      n++;
    });
    if (n) cz.push(s / n);
  }
  if (cz.length < 2) return Infinity;
  const lo = Math.min(...cz);
  const hi = Math.max(...cz);
  return lo + 0.52 * (hi - lo);
}

// ============================================================ GLSL
const VERTEX_PARS = /* glsl */ `
varying vec2 vCrUv;
varying vec3 vCrRest;
`;
const VERTEX_MAIN = /* glsl */ `
vCrUv = uv;
vCrRest = position;
`;
const FRAG_COMMON = /* glsl */ `
varying vec2 vCrUv;
varying vec3 vCrRest;
vec3 crHash32( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yxz + 33.33 );
	return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}
`;

const PAINT_PARS = /* glsl */ `
uniform vec4 uCrFlake;      // cells per metre, density, tilt, glint strength
uniform float uCrGlintPow;
uniform vec4 uCrPearl;      // rgb tint (linear), amount
vec3 crGlintN = vec3( 0.0, 0.0, 1.0 );
float crGlintW = 0.0;
`;
/** After <normal_fragment_maps>: pearl shift + this fragment's flake glint normal. */
const PAINT_MAIN = /* glsl */ `
{
	float crNV = saturate( dot( normal, normalize( vViewPosition ) ) );
	float crGraze = 1.0 - crNV;
	diffuseColor.rgb = mix( diffuseColor.rgb, uCrPearl.rgb, uCrPearl.a * crGraze * crGraze );
	vec2 crCell = vCrUv * uCrFlake.x;
	vec3 crR = crHash32( floor( crCell ) );
	float crOn = step( 1.0 - uCrFlake.y, crR.z );
	vec2 crTilt = ( crR.xy * 2.0 - 1.0 ) * uCrFlake.z;
	#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
		crGlintN = normalize( normal + tbn[ 0 ] * crTilt.x + tbn[ 1 ] * crTilt.y );
	#else
		vec3 crT1 = normalize( cross( normal, abs( normal.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
		crGlintN = normalize( normal + crT1 * crTilt.x + cross( normal, crT1 ) * crTilt.y );
	#endif
	// sub-pixel flakes: one flake sampled per pixel, dimmer as the footprint grows and gone past
	// ~7 flakes per pixel (there the mipmapped flake normal map already carries the sheen)
	float crFp = length( fwidth( crCell ) );
	crGlintW = crOn * uCrFlake.w / ( 1.0 + 0.6 * crFp * crFp ) * ( 1.0 - smoothstep( 3.0, 7.0, crFp ) );
}
`;
/** Inside RE_Direct_Physical, before the base specular: the glint lobe (shadowed by directLight.color). */
const PAINT_GLINT = /* glsl */ `
	{
		vec3 crH = normalize( directLight.direction + geometryViewDir );
		float crNH = saturate( dot( crGlintN, crH ) );
		float crNL = saturate( dot( crGlintN, directLight.direction ) );
		reflectedLight.directSpecular += directLight.color * ( crNL * crGlintW * pow( crNH, uCrGlintPow ) );
	}
`;
const GLINT_ANCHOR = 'reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter';

const GLASS_PARS = /* glsl */ `
uniform vec4 uCrGlass;  // transmittance, privacy transmittance, privacy z, blend
`;
const GLASS_MAIN = /* glsl */ `
float crPrivacy = smoothstep( uCrGlass.z - uCrGlass.w, uCrGlass.z + uCrGlass.w, vCrRest.z );
float crTrans = mix( uCrGlass.x, uCrGlass.y, crPrivacy );
#ifdef USE_TRANSMISSION
	diffuseColor.rgb *= mix( 1.0, uCrGlass.y / max( uCrGlass.x, 1e-3 ), crPrivacy );
#endif
`;
/**
 * Replaces <premultiplied_alpha_fragment> on cheap glass (premultiplied
 * blending ONE, 1 − a): rgb = reflections + body colour at FULL strength,
 * background × (1 − F)·T. The transmission variant keeps three's path.
 */
const GLASS_OUT = /* glsl */ `
#ifdef USE_TRANSMISSION
	#include <premultiplied_alpha_fragment>
#else
{
	float crF = 0.04 + 0.96 * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 5.0 );
	gl_FragColor.a = 1.0 - ( 1.0 - crF ) * crTrans;
}
#endif
`;

const LAMP_PARS = /* glsl */ `
uniform vec4 uCrLamp;      // per-slot levels (see LAMP_SLOT)
uniform vec3 uCrLampMin;
uniform vec3 uCrLampMax;
uniform vec3 uCrLampColor;  // linear emissive colour
uniform vec3 uCrLampColor2;
`;
/**
 * After <emissivemap_fragment> (roughness/metalness factors + normal known,
 * lights not yet evaluated). CR_LAMP: 1 head, 2 tail, 3 reverse, 4 indicator.
 */
const LAMP_MAIN = /* glsl */ `
{
	vec3 crQ = vec3( abs( vCrRest.x ), vCrRest.yz );
	vec3 crSize = max( uCrLampMax - uCrLampMin, vec3( 1e-3 ) );
	vec3 crT = clamp( ( crQ - uCrLampMin ) / crSize, 0.0, 1.0 );
	float crFacing = 0.25 + 0.75 * saturate( dot( normal, normalize( vViewPosition ) ) );
	// distance to the lamp outline in metres (x, y extents)
	float crEdge = min( min( crQ.x - uCrLampMin.x, uCrLampMax.x - crQ.x ), min( crQ.y - uCrLampMin.y, uCrLampMax.y - crQ.y ) );
	vec3 crE = vec3( 0.0 );
	#if CR_LAMP == 1
		float crH = crSize.y;
		float crRp = 0.27 * crH;
		vec2 crC1 = vec2( uCrLampMin.x + 0.34 * crSize.x, uCrLampMin.y + 0.58 * crH );
		vec2 crC2 = vec2( uCrLampMin.x + 0.66 * crSize.x, uCrLampMin.y + 0.58 * crH );
		float crD1 = length( crQ.xy - crC1 );
		float crD2 = length( crQ.xy - crC2 );
		float crEye1 = 1.0 - smoothstep( crRp * 0.8, crRp * 0.88, crD1 );
		float crEye2 = 1.0 - smoothstep( crRp * 0.8, crRp * 0.88, crD2 );
		float crRing = smoothstep( crRp * 0.8, crRp * 0.9, min( crD1, crD2 ) ) * ( 1.0 - smoothstep( crRp * 1.02, crRp * 1.12, min( crD1, crD2 ) ) );
		float crEyes = max( crEye1, crEye2 );
		// projector lens: dark polished glass; bezel ring: bright metal
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.015 ), crEyes );
		metalnessFactor = mix( mix( metalnessFactor, 0.0, crEyes ), 1.0, crRing );
		roughnessFactor = mix( mix( roughnessFactor, 0.04, crEyes ), 0.12, crRing );
		// DRL light guide: thin strip along the lower edge, turning up the outboard end
		float crStripY = smoothstep( 0.05, 0.08, crT.y ) * ( 1.0 - smoothstep( 0.15, 0.19, crT.y ) ) * smoothstep( 0.04, 0.1, crT.x );
		float crStripX = smoothstep( 0.86, 0.89, crT.x ) * ( 1.0 - smoothstep( 0.94, 0.97, crT.x ) ) * smoothstep( 0.05, 0.1, crT.y ) * ( 1.0 - smoothstep( 0.7, 0.8, crT.y ) );
		float crDrl = max( crStripY, crStripX );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.9 ), crDrl * 0.6 );
		roughnessFactor = mix( roughnessFactor, 0.35, crDrl );
		crE = uCrLampColor * ( uCrLamp.x * crDrl * ${LAMP_LEVELS.drl.toFixed(1)}
			+ uCrLamp.y * crEye1 * ${LAMP_LEVELS.lowBeam.toFixed(1)}
			+ max( uCrLamp.y, uCrLamp.z ) * crEye2 * ${LAMP_LEVELS.lowBeam.toFixed(1)}
			+ uCrLamp.z * crEye1 * ${(LAMP_LEVELS.highBeam - LAMP_LEVELS.lowBeam).toFixed(1)}
			+ ( uCrLamp.y + uCrLamp.z ) * ${LAMP_LEVELS.lensGlow.toFixed(1)} * ( 1.0 - crEyes ) )
			+ uCrLampColor2 * uCrLamp.w * ${LAMP_LEVELS.fog.toFixed(1)} * ( 1.0 - smoothstep( 0.0, 0.05, crT.y ) );
	#elif CR_LAMP == 2
		float crGuide = smoothstep( 0.008, 0.012, crEdge ) * ( 1.0 - smoothstep( 0.02, 0.026, crEdge ) );
		float crFill = smoothstep( 0.028, 0.04, crEdge );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.6 + 0.04, crGuide );
		crE = uCrLampColor * ( uCrLamp.x * ( crGuide * ${LAMP_LEVELS.tail.toFixed(1)} + crFill * 0.35 )
			+ uCrLamp.y * ( crFill * ${LAMP_LEVELS.brake.toFixed(1)} + crGuide * ${LAMP_LEVELS.brake.toFixed(1)} ) );
	#elif CR_LAMP == 5
		// classic (1990s) headlamp: a reflector bowl behind a ribbed lens, one hot spot per beam
		vec2 crC = vec2( uCrLampMin.x + 0.62 * crSize.x, uCrLampMin.y + 0.52 * crSize.y );
		vec2 crH = vec2( uCrLampMin.x + 0.34 * crSize.x, uCrLampMin.y + 0.52 * crSize.y );
		float crR = 0.3 * crSize.y;
		float crG1 = exp( -2.5 * dot( crQ.xy - crC, crQ.xy - crC ) / ( crR * crR ) );
		float crG2 = exp( -2.5 * dot( crQ.xy - crH, crQ.xy - crH ) / ( crR * crR ) );
		float crRib = 0.5 + 0.5 * sin( crQ.x * 260.0 );
		diffuseColor.rgb *= 0.85 + 0.15 * crRib;
		crE = uCrLampColor * ( uCrLamp.y * ( 0.25 + ${LAMP_LEVELS.lowBeam.toFixed(1)} * 0.5 * crG1 )
			+ uCrLamp.z * ( 0.2 + ${LAMP_LEVELS.highBeam.toFixed(1)} * 0.5 * crG2 ) ) * ( 0.8 + 0.2 * crRib );
	#elif CR_LAMP == 6
		// classic tail lamp: the whole lens glows (tail) and brightens (brake), dimmer at the rim
		float crFill6 = 0.55 + 0.45 * smoothstep( 0.003, 0.02, crEdge );
		crE = uCrLampColor * crFill6 * ( uCrLamp.x * 1.4 + uCrLamp.y * ${LAMP_LEVELS.brake.toFixed(1)} * 1.4 );
	#elif CR_LAMP == 3
		crE = uCrLampColor * uCrLamp.x * ${LAMP_LEVELS.reverse.toFixed(1)} * ( 0.35 + 0.65 * smoothstep( 0.004, 0.02, crEdge ) );
	#else
		float crSide = vCrRest.x < 0.0 ? uCrLamp.x : uCrLamp.y;
		crE = uCrLampColor * crSide * ${LAMP_LEVELS.indicator.toFixed(1)} * ( 0.35 + 0.65 * smoothstep( 0.004, 0.02, crEdge ) );
	#endif
	totalEmissiveRadiance += crE * crFacing;
}
`;

function must(src: string, anchor: string, what: string): void {
  if (!src.includes(anchor)) throw new Error(`vehicle materials (${what}): shader lacks "${anchor}" (three chunk drift)`);
}

type Hook = (shader: WebGLProgramParametersWithUniforms) => void;

/** Common edits: varyings in both stages. */
function addVaryings(shader: WebGLProgramParametersWithUniforms, what: string): void {
  must(shader.vertexShader, '#include <common>', what);
  must(shader.vertexShader, '#include <uv_vertex>', what);
  must(shader.fragmentShader, '#include <common>', what);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_COMMON}`);
}

export function paintHook(u: PaintUniforms): Hook {
  return (shader) => {
    addVaryings(shader, 'paint');
    const fs = shader.fragmentShader;
    must(fs, '#include <normal_fragment_maps>', 'paint');
    must(fs, '#include <lights_physical_pars_fragment>', 'paint');
    const phys = ShaderChunk.lights_physical_pars_fragment;
    must(phys, GLINT_ANCHOR, 'paint glint');
    shader.uniforms.uCrFlake = u.flake;
    shader.uniforms.uCrGlintPow = u.glintPow;
    shader.uniforms.uCrPearl = u.pearl;
    shader.fragmentShader = fs
      .replace('#include <common>', `#include <common>\n${PAINT_PARS}`)
      .replace('#include <lights_physical_pars_fragment>', phys.replace(GLINT_ANCHOR, `${PAINT_GLINT}\n\t${GLINT_ANCHOR}`))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${PAINT_MAIN}`);
  };
}

export function glassHook(u: Uniform<Vector4Like>): Hook {
  return (shader) => {
    addVaryings(shader, 'glass');
    const fs = shader.fragmentShader;
    must(fs, '#include <color_fragment>', 'glass');
    must(fs, '#include <premultiplied_alpha_fragment>', 'glass');
    shader.uniforms.uCrGlass = u;
    shader.fragmentShader = fs
      .replace('#include <common>', `#include <common>\n${GLASS_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${GLASS_MAIN}`)
      .replace('#include <premultiplied_alpha_fragment>', GLASS_OUT);
  };
}

export const LAMP_SLOT_ID: Readonly<Record<'lightHead' | 'lightTail' | 'lightReverse' | 'lightIndicator', number>> = {
  lightHead: 1,
  lightTail: 2,
  lightReverse: 3,
  lightIndicator: 4,
};

export function lampHook(id: number, u: LampUniforms): Hook {
  return (shader) => {
    addVaryings(shader, 'lamp');
    must(shader.fragmentShader, '#include <emissivemap_fragment>', 'lamp');
    shader.uniforms.uCrLamp = u.level;
    shader.uniforms.uCrLampMin = u.min;
    shader.uniforms.uCrLampMax = u.max;
    shader.uniforms.uCrLampColor = u.color;
    shader.uniforms.uCrLampColor2 = u.color2;
    shader.fragmentShader = `#define CR_LAMP ${id}\n${shader.fragmentShader}`
      .replace('#include <common>', `#include <common>\n${LAMP_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${LAMP_MAIN}`);
  };
}

// ============================================================ uniforms
interface Vector4Like {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface PaintUniforms {
  flake: Uniform<Vector4Like>;
  glintPow: Uniform<number>;
  pearl: Uniform<Vector4Like>;
}
export interface LampUniforms {
  level: Uniform<Vector4Like>;
  min: Uniform<Vector3>;
  max: Uniform<Vector3>;
  color: Uniform<Color>;
  color2: Uniform<Color>;
}

const v4 = (x = 0, y = 0, z = 0, w = 0): Vector4Like => ({ x, y, z, w });

// ============================================================ material construction
/**
 * Peak scene-linear radiance a vehicle fragment may write. A mirror-sharp
 * lobe (clearcoat, chrome; GGX roughness floor 0.0525) reflecting the sun
 * reaches ~2.5e5 — beyond half float (65504): the HalfFloat composer stores
 * Inf and the post chain turns it into NaN, blacking out the WHOLE frame
 * through bloom. Clamped here (bloom still flares hard at this level).
 */
export const MAX_RADIANCE = 2048;
const CLAMP_CHUNK = `#include <opaque_fragment>
gl_FragColor.rgb = min( gl_FragColor.rgb, vec3( ${MAX_RADIANCE.toFixed(1)} ) );`;

/** Applies the radiance clamp (every vehicle material). */
export function clampRadiance(shader: WebGLProgramParametersWithUniforms): void {
  must(shader.fragmentShader, '#include <opaque_fragment>', 'radiance clamp');
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', CLAMP_CHUNK);
}

/** Installs the hook (+ radiance clamp) and cache key as own properties; clone() keeps them and registers the clone. */
function hooked<M extends AnyMat>(m: M, key: string, hook: Hook | null, registry: Set<Material>): M {
  m.onBeforeCompile = ((shader: WebGLProgramParametersWithUniforms) => {
    hook?.(shader);
    clampRadiance(shader);
  }) as M['onBeforeCompile'];
  const k = `${key || 'crStd'}|clamp1`;
  m.customProgramCacheKey = () => k;
  track(m, registry);
  return m;
}

function track(m: Material, registry: Set<Material>): void {
  registry.add(m);
  const protoClone = Object.getPrototypeOf(m).clone as (this: Material) => Material;
  (m as unknown as { clone: () => Material }).clone = function cloneTracked(this: Material): Material {
    const c = protoClone.call(this);
    if (Object.prototype.hasOwnProperty.call(this, 'onBeforeCompile')) c.onBeforeCompile = this.onBeforeCompile;
    if (Object.prototype.hasOwnProperty.call(this, 'customProgramCacheKey')) c.customProgramCacheKey = this.customProgramCacheKey;
    track(c, registry);
    c.addEventListener('dispose', () => registry.delete(c));
    return c;
  };
}

/** Anisotropic filtering cap per quality level (the renderer's max caps it further). */
export const ANISOTROPY_CAP: Readonly<Record<RenderContext['quality']['level'], number>> = { low: 4, medium: 8, high: 16, ultra: 16 };

/**
 * FINE-DETAIL FADE (anti-moiré for periodic micro-relief, e.g.
 * the honeycomb grille, 32-texel cells): from ~3 texels per pixel (cells
 * ~10 px) to ~12 (cells ~2.5 px: the beat frequency) — distance, or grazing
 * angles where the major axis of the footprint outruns even anisotropic
 * filtering — the normal-map relief
 * fades out, the lost micro-shadowing is folded into roughness, and the
 * colour map blends toward its mean — the pattern dissolves into an even
 * mesh tone instead of beating into moiré. `size` = map texels per tile.
 */
export function fineDetailHook(size: readonly [number, number], mapMean: number): Hook {
  const sz = `vec2( ${size[0].toFixed(1)}, ${size[1].toFixed(1)} )`;
  const pars = /* glsl */ `
float crFineFade( vec2 uv ) {
	vec2 t = fwidth( uv ) * ${sz};
	return 1.0 - smoothstep( 3.0, 12.0, max( t.x, t.y ) );
}`;
  return (shader) => {
    must(shader.fragmentShader, '#include <common>', 'fine detail');
    must(shader.fragmentShader, '#include <normal_fragment_maps>', 'fine detail');
    must(shader.fragmentShader, '#include <map_fragment>', 'fine detail');
    const nrm = ShaderChunk.normal_fragment_maps.replace(
      'mapN.xy *= normalScale;',
      'float crFine = crFineFade( vNormalMapUv );\n\tmapN.xy *= normalScale * crFine;\n\troughnessFactor = mix( min( 1.0, roughnessFactor + 0.15 ), roughnessFactor, crFine );',
    );
    const map = ShaderChunk.map_fragment.replace(
      'diffuseColor *= sampledDiffuseColor;',
      `sampledDiffuseColor.rgb = mix( vec3( ${mapMean.toFixed(4)} ), sampledDiffuseColor.rgb, crFineFade( vMapUv ) );\n\tdiffuseColor *= sampledDiffuseColor;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace('#include <map_fragment>', map)
      .replace('#include <normal_fragment_maps>', nrm);
  };
}

/** Mean of a colour texture in LINEAR units (sRGB-decoded). */
function linearMean(t: Texture): number {
  const img = t.image as { data?: ArrayLike<number> } | null;
  const d = img?.data;
  if (!d || d.length < 4) return 0.5;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const c = d[i]! / 255;
    sum += c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    n++;
  }
  return sum / n;
}

/** A per-material texture view with its own repeat (shares the GPU upload). */
function tiled(t: Texture, perMetre: number): Texture {
  const c = t.clone();
  c.repeat.set(perMetre, perMetre);
  c.needsUpdate = true;
  return c;
}

/** Linear colour of an sRGB hex. */
const srgb = (hex: number): Color => new Color().setHex(hex);

export const RIM_FINISHES: Readonly<Record<WheelVisualDef['rim']['finish'], { color: number; metalness: number; roughness: number; clearcoat: number }>> = {
  silver: { color: 0xd3d6db, metalness: 1, roughness: 0.17, clearcoat: 0.7 },
  gunmetal: { color: 0x50545a, metalness: 0.95, roughness: 0.3, clearcoat: 0.7 },
  chrome: { color: 0xf4f6f8, metalness: 1, roughness: 0.04, clearcoat: 0 },
  black: { color: 0x101113, metalness: 0.35, roughness: 0.32, clearcoat: 1 },
  gold: { color: 0xc8a050, metalness: 1, roughness: 0.25, clearcoat: 0.6 },
};

function applyPaint(m: MeshPhysicalMaterial, p: PaintDef): void {
  m.color.setHex(p.color);
  m.metalness = p.metallic;
  m.roughness = p.roughness;
  m.clearcoat = p.clearcoat;
  m.clearcoatRoughness = p.clearcoatRoughness;
  const k = p.flake ? p.flake.intensity : 0;
  m.normalScale.set(0.5 * k, 0.5 * k);
}

function writePaintUniforms(u: PaintUniforms, p: PaintDef): void {
  const f = p.flake;
  const mm = f ? Math.min(3, Math.max(0.2, f.scale)) : 0.5;
  u.flake.value.x = 1000 / mm;
  u.flake.value.y = f ? Math.min(1, Math.max(0, f.density)) * 0.5 : 0;
  u.flake.value.z = f ? 0.2 + 0.25 * f.intensity : 0;
  u.flake.value.w = f ? GLINT_STRENGTH * f.intensity * (0.4 + 0.6 * p.metallic) : 0;
  u.glintPow.value = GLINT_POWER;
  const pearl = p.pearl ?? 0;
  // pearl: a neighbouring-hue sheen toward grazing angles (red → orange-gold flop, blue → violet);
  // near-white bases get a soft peach-gold interference tint
  const c = new Color().setHex(p.color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const tint =
    hsl.s < 0.12
      ? new Color().setHSL(0.09, 0.45, Math.min(0.8, Math.max(0.5, hsl.l)))
      : new Color().setHSL((hsl.h + 0.06) % 1, Math.min(1, hsl.s * 1.1 + 0.1), Math.min(0.6, hsl.l * 1.6 + 0.08));
  u.pearl.value.x = tint.r;
  u.pearl.value.y = tint.g;
  u.pearl.value.z = tint.b;
  u.pearl.value.w = 0.6 * pearl;
}

/** Flake normal map for a paint (cached per density; per-material repeat from the flake size). */
function flakeMap(p: PaintDef): Texture {
  const density = p.flake ? Math.round(Math.min(1, Math.max(0.2, p.flake.density + 0.15)) * 4) / 4 : 0.5;
  const mm = p.flake ? Math.min(3, Math.max(0.2, p.flake.scale)) : 0.5;
  // 128 cells per tile → tile = 128 flakes
  return tiled(vehicleTextures.flake(density), 1000 / (mm * 128));
}

/**
 * A3 factory. `ctx.quality.level === 'ultra'` selects transmission glass.
 * Shared procedural textures come from textures.ts (cached; never disposed here).
 */
export const createVehicleMaterials: CreateVehicleMaterials = (ctx: RenderContext, def: VehicleVisualDef): VehicleMaterialSet => {
  const registries = new Map<MaterialSlot, Set<Material>>();
  const reg = (slot: MaterialSlot): Set<Material> => {
    let s = registries.get(slot);
    if (!s) registries.set(slot, (s = new Set()));
    return s;
  };
  const transmissive = ctx.quality.level === 'ultra';
  const maxAniso = (ctx.renderer as { capabilities?: { getMaxAnisotropy?: () => number } } | undefined)?.capabilities?.getMaxAnisotropy?.() ?? 8;
  setVehicleTextureAnisotropy(Math.min(maxAniso, ANISOTROPY_CAP[ctx.quality.level] ?? 8));

  // ---------------- paint
  let paint: PaintDef = def.paint;
  const paintU: PaintUniforms = { flake: { value: v4() }, glintPow: { value: 900 }, pearl: { value: v4() } };
  writePaintUniforms(paintU, paint);
  const paintMat = new MeshPhysicalMaterial({
    name: 'crPaint',
    normalMap: flakeMap(paint),
    normalScale: new Vector2(0.4, 0.4),
    clearcoatNormalMap: tiled(vehicleTextures.orangePeel(), TEXTURE_DENSITY.orangePeel),
    clearcoatNormalScale: new Vector2(0.07, 0.07),
    specularIntensity: 1,
  });
  applyPaint(paintMat, paint);
  hooked(paintMat, 'crPaint1', paintHook(paintU), reg('paint'));

  // ---------------- glass
  const privacyZ = privacySplitZ(def);
  const glassU: Uniform<Vector4Like> = {
    value: v4(GLASS_TUNING.transmittance, GLASS_TUNING.privacyTransmittance, Number.isFinite(privacyZ) ? privacyZ : 1e6, GLASS_TUNING.privacyBlend),
  };
  const glassMat = transmissive
    ? new MeshPhysicalMaterial({
        name: 'crGlass',
        color: srgb(GLASS_TUNING.tint).lerp(new Color(1, 1, 1), 0.55),
        metalness: 0,
        roughness: 0.02,
        transmission: 1,
        thickness: 0,
        ior: 1.52,
        specularIntensity: 1,
        side: FrontSide,
      })
    : new MeshPhysicalMaterial({
        name: 'crGlass',
        color: srgb(0x0a100e),
        metalness: 0,
        roughness: 0.03,
        ior: 1.52,
        specularIntensity: 1,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        side: FrontSide,
      });
  hooked(glassMat, transmissive ? 'crGlass1t' : 'crGlass1', glassHook(glassU), reg('glass'));

  // ---------------- lamps
  const extras = finishExtras(def);
  const classic = extras.lamps === 'classic';
  const lampU = new Map<MaterialSlot, LampUniforms>();
  const lamp = (
    slot: 'lightHead' | 'lightTail' | 'lightReverse' | 'lightIndicator',
    params: ConstructorParameters<typeof MeshPhysicalMaterial>[0],
    color: number,
    color2 = 0xffffff,
  ): MeshPhysicalMaterial => {
    const box = slotBox(def, slot) ?? { min: new Vector3(0, 0, 0), max: new Vector3(1, 1, 1) };
    const u: LampUniforms = {
      level: { value: v4() },
      min: { value: box.min.clone() },
      max: { value: box.max.clone() },
      color: { value: new Color(color) },
      color2: { value: new Color(color2) },
    };
    lampU.set(slot, u);
    const m = new MeshPhysicalMaterial({ name: `cr-${slot}`, clearcoat: 1, clearcoatRoughness: 0.02, specularIntensity: 1, ...params });
    // classic (pre-LED) lamp optics for defs that ask for them (weathering.ts FinishExtras.lamps)
    const id = classic && slot === 'lightHead' ? 5 : classic && slot === 'lightTail' ? 6 : LAMP_SLOT_ID[slot];
    return hooked(m, `crLamp${id}`, lampHook(id, u), reg(slot));
  };
  const reflector = tiled(vehicleTextures.lens('reflector'), TEXTURE_DENSITY.reflector);
  const prism = tiled(vehicleTextures.lens('prism'), TEXTURE_DENSITY.prism);
  const head = lamp(
    'lightHead',
    { color: srgb(0xe4e9ee), metalness: 0.85, roughness: 0.14, normalMap: reflector, normalScale: new Vector2(0.6, 0.6) },
    0xe8f0ff,
    0xfff1d0,
  );
  const tail = lamp(
    'lightTail',
    { color: srgb(0x5c0508), metalness: 0.25, roughness: 0.22, normalMap: prism, normalScale: new Vector2(0.45, 0.45) },
    0xff0800,
  );
  const reverse = lamp(
    'lightReverse',
    { color: srgb(0xb4b8be), metalness: 0.95, roughness: 0.12, normalMap: prism, normalScale: new Vector2(0.5, 0.5) },
    0xf4f6ff,
  );
  const indicator = lamp(
    'lightIndicator',
    { color: srgb(0xc08a40), metalness: 0.9, roughness: 0.14, normalMap: prism, normalScale: new Vector2(0.5, 0.5) },
    0xff7a0a,
  );
  // convert lamp colours (authored sRGB-ish hex above) to linear
  for (const u of lampU.values()) {
    u.color.value.convertSRGBToLinear();
    u.color2.value.convertSRGBToLinear();
  }

  // ---------------- trims, interior, misc
  const std = (slot: MaterialSlot, params: ConstructorParameters<typeof MeshPhysicalMaterial>[0]): MeshPhysicalMaterial =>
    hooked(new MeshPhysicalMaterial({ name: `cr-${slot}`, ...params }), '', null, reg(slot));
  const grain = tiled(vehicleTextures.grain('plastic'), TEXTURE_DENSITY.plasticGrain);
  const trim = std('trim', {
    color: srgb(0x121315),
    roughness: 0.58,
    metalness: 0,
    specularIntensity: 0.55,
    normalMap: grain,
    normalScale: new Vector2(0.35, 0.35),
  });
  const chrome = std('chrome', { color: srgb(0xf2f4f6), metalness: 1, roughness: 0.045, specularIntensity: 1 });
  const rubber = std('rubber', {
    color: srgb(0x0e0e0f),
    roughness: 0.82,
    metalness: 0,
    specularIntensity: 0.4,
    normalMap: tiled(vehicleTextures.grain('rubber'), TEXTURE_DENSITY.rubber),
    normalScale: new Vector2(0.3, 0.3),
  });
  const interior = std('interior', {
    color: srgb(0x26272a),
    roughness: 0.88,
    metalness: 0,
    specularIntensity: 0.35,
    sheen: 1,
    sheenColor: srgb(0x5d6066),
    sheenRoughness: 0.55,
    normalMap: tiled(vehicleTextures.grain('fabric'), TEXTURE_DENSITY.fabric),
    normalScale: new Vector2(0.6, 0.6),
    side: DoubleSide,
  });
  const interiorTrim = std('interiorTrim', {
    color: srgb(0x1b1c1e),
    roughness: 0.5,
    metalness: 0,
    specularIntensity: 0.5,
    normalMap: tiled(vehicleTextures.grain('leather'), TEXTURE_DENSITY.leather),
    normalScale: new Vector2(0.4, 0.4),
    side: DoubleSide,
  });
  const honey = vehicleTextures.honeycomb();
  const honeyImg = honey.normal.image as { width: number; height: number };
  const grille = hooked(
    new MeshPhysicalMaterial({
      name: 'cr-grille',
      color: srgb(0x1a1b1d),
      map: tiled(honey.color, TEXTURE_DENSITY.honeycomb),
      normalMap: tiled(honey.normal, TEXTURE_DENSITY.honeycomb),
      normalScale: new Vector2(1, 1),
      roughness: 0.28,
      metalness: 0.15,
      clearcoat: 0.6,
      clearcoatRoughness: 0.08,
      specularIntensity: 0.8,
    }),
    'crGrille1',
    fineDetailHook([honeyImg.width, honeyImg.height], linearMean(honey.color)),
    reg('grille'),
  );
  const mirror = std('mirror', { color: srgb(0xdfe3e8), metalness: 1, roughness: 0.02 });
  const underbody = std('underbody', { color: srgb(0x17181a), roughness: 0.88, metalness: 0.1, specularIntensity: 0.4 });
  const plateTex = vehicleTextures.plate(def.plate ?? 'CR 4MPL').clone();
  plateTex.repeat.set(1 / PLATE_SIZE_M[0], 1 / PLATE_SIZE_M[1]);
  plateTex.needsUpdate = true;
  const plate = std('plate', { color: srgb(0xffffff), map: plateTex, roughness: 0.38, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.1 });

  // ---------------- wheel slots (wheels.ts clones + specialises these)
  const fin = RIM_FINISHES[def.wheels.rim.finish] ?? RIM_FINISHES.silver;
  const rim = std('rim', {
    color: srgb(fin.color),
    metalness: fin.metalness,
    roughness: fin.roughness,
    clearcoat: fin.clearcoat,
    clearcoatRoughness: 0.04,
  });
  const tire = std('tire', { color: srgb(extras.worn ? 0x2e2d2b : 0x262626), roughness: extras.worn ? 0.92 : 0.84, metalness: 0, specularIntensity: 0.45 });
  if (extras.worn) {
    // weathered steel wheels: no lacquer shine, a little dust
    rim.clearcoat = 0;
    rim.roughness = Math.max(rim.roughness, 0.55);
    rim.color.multiplyScalar(1.6).lerp(srgb(0x4a4238), 0.25);
  }
  const disc = vehicleTextures.brakeDisc();
  const brakeDisc = std('brakeDisc', {
    color: srgb(0x8d9095),
    map: disc.color,
    normalMap: disc.normal,
    normalScale: new Vector2(0.6, 0.6),
    metalness: 0.9,
    roughness: 0.36,
    anisotropy: 0.65,
  });
  const caliper = std('caliper', {
    color: srgb(def.wheels.brake.caliperColor),
    roughness: 0.32,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });

  const bases: Record<MaterialSlot, AnyMat> = {
    paint: paintMat,
    trim,
    chrome,
    glass: glassMat,
    rubber,
    lightHead: head,
    lightTail: tail,
    lightIndicator: indicator,
    lightReverse: reverse,
    interior,
    interiorTrim,
    grille,
    mirror,
    underbody,
    plate,
    rim,
    tire,
    brakeDisc,
    caliper,
  };

  // ---------------- panel finish (weathering): only the slots that carry a finished panel
  const finish = buildFinishData(def);
  const finishTex = finish.finished > 0 ? createFinishTexture(finish) : null;
  if (finishTex) {
    const wu = createWeatherUniforms(finishTex, extras.arches ?? []);
    for (const slot of finish.slots) {
      const m = bases[slot];
      if (!m) continue;
      const prev = m.onBeforeCompile;
      const key = m.customProgramCacheKey();
      m.onBeforeCompile = ((shader: WebGLProgramParametersWithUniforms, renderer: unknown) => {
        (prev as (s: WebGLProgramParametersWithUniforms, r: unknown) => void).call(m, shader, renderer);
        applyWeatherGlsl(shader, wu);
      }) as AnyMat['onBeforeCompile'];
      const k = `${key}|${WEATHER_KEY}`;
      m.customProgramCacheKey = () => k;
    }
  }

  const lights = createLightState();
  lights.head = false;
  function writeLights(s: LightState): void {
    const h = lampU.get('lightHead');
    if (h) {
      h.level.value.x = 1; // DRL always on
      h.level.value.y = s.head ? 1 : 0;
      h.level.value.z = s.highBeam ? 1 : 0;
      h.level.value.w = s.fog ? 1 : 0;
    }
    const t = lampU.get('lightTail');
    if (t) {
      t.level.value.x = s.head ? 1 : 0;
      t.level.value.y = Math.min(1, Math.max(0, s.brake));
    }
    const r = lampU.get('lightReverse');
    if (r) r.level.value.x = s.reverse ? 1 : 0;
    const i = lampU.get('lightIndicator');
    if (i) {
      i.level.value.x = s.indicatorL ? 1 : 0;
      i.level.value.y = s.indicatorR ? 1 : 0;
    }
  }
  writeLights(lights);

  const set: VehicleMaterialSet & { readonly finish: FinishInfo | null } = {
    finish: finishTex ? { data: finish, texture: finishTex } : null,
    base(slot: MaterialSlot): AnyMat {
      const m = bases[slot];
      if (!m) throw new Error(`createVehicleMaterials: unknown slot "${slot}"`);
      return m;
    },
    setPaint(p: PaintDef): void {
      const flakeChanged =
        (paint.flake === null) !== (p.flake === null) ||
        (paint.flake && p.flake && (paint.flake.density !== p.flake.density || paint.flake.scale !== p.flake.scale));
      paint = p;
      writePaintUniforms(paintU, p);
      const nm = flakeChanged ? flakeMap(p) : null;
      for (const m of reg('paint')) {
        const pm = m as MeshPhysicalMaterial;
        applyPaint(pm, p);
        if (nm) pm.normalMap = nm; // same defines → no recompile
      }
    },
    setLights(s: LightState): void {
      writeLights(s);
    },
    dispose(): void {
      for (const reg of registries.values()) {
        for (const m of [...reg]) m.dispose();
        reg.clear();
      }
      finishTex?.dispose();
    },
  };
  return set;
};

/** Panel-finish data of a material set (weathering.ts), null when the def has no finished panel. */
export interface FinishInfo {
  data: FinishData;
  texture: Texture;
}

/** The finish of a set made by createVehicleMaterials (null for other sets / no finish). */
export function materialFinish(set: VehicleMaterialSet): FinishInfo | null {
  return (set as { finish?: FinishInfo | null }).finish ?? null;
}

/** Test/debug: the shared uniform objects behind a material set's hooks (null if absent). */
export function debugLampLevels(set: VehicleMaterialSet, slot: 'lightHead' | 'lightTail' | 'lightReverse' | 'lightIndicator'): Vector4Like | null {
  const m = set.base(slot);
  const shader = fakeShader();
  m.onBeforeCompile(shader as never, null as never);
  const u = shader.uniforms.uCrLamp as Uniform<Vector4Like> | undefined;
  return u ? u.value : null;
}

/** Minimal program-parameter stub carrying the real physical shader sources (tests / debug). */
export function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: ShaderChunkLib.vertex,
    fragmentShader: ShaderChunkLib.fragment,
  } as unknown as WebGLProgramParametersWithUniforms;
}

// three's raw physical program sources (with #includes unresolved, exactly what onBeforeCompile sees)
const ShaderChunkLib = {
  get vertex(): string {
    return ShaderLib.physical.vertexShader;
  },
  get fragment(): string {
    return ShaderLib.physical.fragmentShader;
  },
};
