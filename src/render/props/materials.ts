/**
 * Prop materials (U2): one base MeshStandardMaterial per PropMaterialSlot,
 * each with its own fragment hook (installed as the material's
 * onBeforeCompile, so patchMaterial runs it as the "prior hook" before
 * CSM + flexI1). Hooks read the flexI1 varyings under `#ifdef FLEXBODY`:
 *   vFlexDamage.x  plastic strain 0..1 (dents → creases, stress whitening,
 *                  cracked paint, splintered wood, chipped concrete)
 *   vFlexDamage.y  scuff 0..1 (impacts: bare steel, scratched plastic)
 *   vPropInst      (seed, wear, panel variant)
 *   vFlexRest      rest prop-local position (grime / streak lookups never swim)
 * Consumers clone a base before patching (patchMaterial throws on a second
 * patch); the hook + cache key survive cloneBaseMaterial.
 */
import { Color, MeshStandardMaterial, RepeatWrapping, type Texture, type WebGLProgramParametersWithUniforms } from 'three';

import type { RenderContext } from '../types';
import { clampRadiance } from '../vehicle/materials';
import { propTextures } from './textures';
import type { PropMaterialSlot } from './types';

export const PROP_MATERIAL_SLOTS: readonly PropMaterialSlot[] = [
  'conePlastic',
  'reflective',
  'barrelPaint',
  'rubber',
  'cardboard',
  'wood',
  'concrete',
  'galvanized',
  'signFace',
  'stopFace',
  'lampLens',
];

/** Barrel paint colours (sRGB), picked per instance by seed. */
export const BARREL_PALETTE: readonly number[] = [0x1f4f9e, 0xb0261c, 0xd79a12, 0x2d5f35, 0x1e1e1f, 0x2b6f9e, 0xc4c2b8];


const glslF = (x: number): string => (Number.isFinite(x) ? x.toPrecision(6) : '0.0').replace(/^(-?\d+)$/, '$1.0');
function lin(hex: number): string {
  const c = new Color().setHex(hex);
  return `vec3( ${glslF(c.r)}, ${glslF(c.g)}, ${glslF(c.b)} )`;
}

type Hook = (shader: WebGLProgramParametersWithUniforms) => void;

/** Shared fragment helpers (after <common>). */
const COMMON_PARS = /* glsl */ `
uniform sampler2D uPropGrime;
float propStrain() {
#ifdef FLEXBODY
	return clamp( vFlexDamage.x, 0.0, 1.0 );
#else
	return 0.0;
#endif
}
float propScuff() {
#ifdef FLEXBODY
	return clamp( vFlexDamage.y, 0.0, 1.0 );
#else
	return 0.0;
#endif
}
vec3 propRest() {
#ifdef FLEXBODY
	return vFlexRest;
#else
	return vec3( 0.0 );
#endif
}
vec3 propInstance() {
#ifdef PROP_INSTANCED
	return vPropInst;
#else
	return vec3( 0.0 );
#endif
}
bool propVariant( float v ) { return abs( propInstance().z - v ) < 0.5; }
/** Grime field at the rest position: r = dirt, g = roughness noise, b = streaks (seeded per instance). */
vec3 propGrime( float scale ) {
	vec3 p = propRest();
	float s = propInstance().x * 17.0;
	vec2 side = vec2( p.x * 0.8 - p.z * 0.6 + s, p.y );
	vec2 top = p.xz + s;
	// rest-space facet normal from screen derivatives (never swims, no extra varying)
	vec3 cr = cross( dFdx( p ), dFdy( p ) );
	float ny = abs( cr.y ) / max( length( cr ), 1e-12 );
	return mix( texture2D( uPropGrime, side * scale ).rgb, texture2D( uPropGrime, top * scale ).rgb, smoothstep( 0.6, 0.9, ny ) );
}
`;

interface SlotGlsl {
  /** Extra declarations (after <common>). */
  pars?: string;
  /** Replaces <map_fragment> (custom atlas lookups). */
  map?: string;
  /** After <color_fragment>: edit diffuseColor.rgb. */
  color?: string;
  /** After <roughnessmap_fragment>: edit roughnessFactor. */
  rough?: string;
  /** After <metalnessmap_fragment>: edit metalnessFactor. */
  metal?: string;
  /** After <emissivemap_fragment>: edit totalEmissiveRadiance. */
  emissive?: string;
}

const SLOT_GLSL: Record<PropMaterialSlot, SlotGlsl> = {
  conePlastic: {
    color: /* glsl */ `
	{
		float st = propStrain();
		vec3 g = propGrime( 2.0 );
		vec3 base = diffuseColor.rgb;
		if ( propVariant( 1.0 ) ) base = ${lin(0x1b1b1c)};
		else if ( propVariant( 2.0 ) ) base *= 0.55;
		// stress whitening (PE turns pale where it was folded), road grime toward the base
		if ( !propVariant( 1.0 ) ) base = mix( base, base * 0.6 + vec3( 0.25, 0.23, 0.21 ), smoothstep( 0.15, 0.8, st ) * smoothstep( 0.3, 0.7, g.g ) * 0.6 );
		float low = 1.0 - smoothstep( 0.0, 0.32, propRest().y );
		base *= 1.0 - 0.35 * g.r * ( 0.35 + 0.65 * low ) * ( 0.4 + propInstance().y );
		base = mix( base, vec3( 0.42 ), propScuff() * 0.5 * g.g );
		diffuseColor.rgb = base;
	}`,
    rough: /* glsl */ `
	roughnessFactor = propVariant( 1.0 ) ? 0.85 : roughnessFactor + 0.25 * propStrain() + 0.15 * propGrime( 2.0 ).r;`,
  },
  reflective: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 2.0 );
		diffuseColor.rgb *= 1.0 - 0.25 * g.r * ( 0.3 + propInstance().y ) - 0.35 * propStrain();
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.35 ), propScuff() * 0.4 );
	}`,
    rough: /* glsl */ `
	roughnessFactor = clamp( roughnessFactor + 0.3 * propStrain(), 0.0, 1.0 );`,
  },
  barrelPaint: {
    pars: /* glsl */ `
const vec3 BARREL_PAL[ ${BARREL_PALETTE.length} ] = vec3[]( ${BARREL_PALETTE.map(lin).join(', ')} );
float propBare;
`,
    color: /* glsl */ `
	{
		vec3 p = propRest();
		float seed = propInstance().x;
		vec3 paint = BARREL_PAL[ int( seed * ${glslF(BARREL_PALETTE.length)} ) % ${BARREL_PALETTE.length} ];
		vec3 g = propGrime( 1.6 );
		float st = propStrain();
		float wear = propInstance().y;
		// rust streaks run down from the top chime, rust + dirt pool at the bottom chime
		float streak = smoothstep( 0.55, 0.9, g.b ) * smoothstep( 0.3, 0.85, p.y ) * ( 0.3 + wear );
		float chime = max( 1.0 - smoothstep( 0.0, 0.05, p.y ), smoothstep( 0.83, 0.88, p.y ) );
		float rust = clamp( streak * 0.6 + chime * g.r * ( 0.5 + wear ) + 0.35 * st * smoothstep( 0.7, 0.9, g.g ), 0.0, 1.0 );
		vec3 base = paint;
		if ( propVariant( 2.0 ) ) base = ${lin(0x9a9a96)};
		base *= 0.85 + 0.3 * g.g;
		base = mix( base, ${lin(0x5a2f17)} * ( 0.7 + 0.6 * g.g ), rust * 0.85 );
		// dents crack the paint (dark creases), impacts scrape to bare steel
		base *= 1.0 - 0.3 * smoothstep( 0.1, 0.7, st );
		propBare = clamp( propScuff() * smoothstep( 0.25, 0.6, g.g + 0.3 * st ), 0.0, 1.0 );
		base = mix( base, ${lin(0x8c8d8f)}, propBare );
		base *= 1.0 - 0.3 * g.r * ( 1.0 - smoothstep( 0.0, 0.25, p.y ) );
		diffuseColor.rgb = base;
	}`,
    rough: /* glsl */ `
	roughnessFactor = clamp( roughnessFactor + 0.2 * propGrime( 1.6 ).g + 0.25 * propStrain() - 0.2 * propBare, 0.08, 1.0 );`,
    metal: /* glsl */ `
	metalnessFactor = mix( metalnessFactor, 0.9, propBare );`,
  },
  rubber: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 1.5 );
		// dusty, sun-faded rubber: lighter tops of the tread blocks, dirt pooled low
		diffuseColor.rgb *= 0.9 + 0.25 * g.g;
		diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0x6d6253)}, 0.25 * g.r * ( 0.4 + propInstance().y ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.12 ), propScuff() * 0.4 );
	}`,
    rough: /* glsl */ `
	roughnessFactor = clamp( roughnessFactor - 0.08 * propGrime( 1.5 ).g, 0.0, 1.0 );`,
  },
  cardboard: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 2.2 );
		float seed = propInstance().x;
		float st = propStrain();
		// R-PHYS2 hay bale (variant 1): sun-bleached straw, darker weathered outer layer, net-wrap lines
		if ( propVariant( 1.0 ) ) {
			vec3 p = propRest();
			float strand = 0.5 + 0.5 * sin( p.z * 140.0 + p.y * 37.0 + g.b * 9.0 );
			diffuseColor.rgb = mix( ${lin(0xb89a52)}, ${lin(0xd9bf73)}, 0.45 * g.g + 0.35 * strand );
			diffuseColor.rgb *= 1.0 - 0.22 * g.r;
			diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0xe6e2d6)}, 0.18 * smoothstep( 0.92, 0.98, sin( p.x * 24.0 ) ) );
		}
		// kraft shade per box, scuffed corners, crushed board darkens along the creases
		diffuseColor.rgb *= vec3( 0.92 + 0.16 * seed, 0.92 + 0.12 * seed, 0.9 + 0.08 * fract( seed * 7.3 ) );
		diffuseColor.rgb *= 1.0 - 0.18 * g.r * ( 0.3 + propInstance().y );
		diffuseColor.rgb *= 1.0 - 0.5 * smoothstep( 0.05, 0.7, st ) * ( 0.6 + 0.4 * g.g );
		diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0xd8c3a0)}, propScuff() * 0.55 * smoothstep( 0.4, 0.7, g.g ) );
	}`,
    rough: /* glsl */ `
	roughnessFactor = clamp( roughnessFactor + 0.1 * propStrain(), 0.0, 1.0 );`,
  },
  wood: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 1.8 );
		float seed = propInstance().x;
		float st = propStrain();
		diffuseColor.rgb *= vec3( 0.88 + 0.2 * seed, 0.88 + 0.16 * seed, 0.86 + 0.14 * seed );
		diffuseColor.rgb *= 1.0 - 0.25 * g.r * ( 0.3 + propInstance().y );
		// bruised / split boards darken (the folds themselves are geometry)
		diffuseColor.rgb *= 1.0 - 0.25 * smoothstep( 0.05, 0.6, st ) * ( 0.7 + 0.3 * g.g );
		diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0xcfae7c)}, propScuff() * 0.45 );
	}`,
  },
  concrete: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 1.0 );
		vec3 p = propRest();
		diffuseColor.rgb *= 0.92 + 0.14 * propInstance().y;
		diffuseColor.rgb *= 1.0 - 0.3 * g.r * ( 1.0 - smoothstep( 0.0, 0.3, p.y ) );
		diffuseColor.rgb *= 1.0 - 0.18 * smoothstep( 0.6, 0.9, g.b );
		// chipped edges: brighter fresh aggregate
		diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0xbdb7ab)}, clamp( propStrain() * 1.5 + propScuff() * 0.6, 0.0, 1.0 ) * smoothstep( 0.35, 0.65, g.g ) );
	}`,
  },
  galvanized: {
    pars: 'float propPainted;\n',
    color: /* glsl */ `
	{
		vec3 g = propGrime( 1.4 );
		vec3 p = propRest();
		propPainted = propVariant( 1.0 ) ? 1.0 : 0.0;
		if ( propPainted > 0.5 ) diffuseColor.rgb = ${lin(0x4b4e52)} * ( 0.9 + 0.2 * g.g );
		float low = 1.0 - smoothstep( 0.0, 0.5, p.y );
		diffuseColor.rgb *= 1.0 - 0.35 * g.r * ( 0.25 + 0.75 * low );
		if ( propVariant( 2.0 ) ) diffuseColor.rgb = mix( diffuseColor.rgb, ${lin(0x6b4a30)}, 0.45 * g.r );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.75 ), propScuff() * 0.6 * g.g );
		diffuseColor.rgb *= 1.0 - 0.25 * propStrain();
	}`,
    rough: /* glsl */ `
	roughnessFactor = propPainted > 0.5 ? 0.55 : clamp( roughnessFactor + 0.25 * ( propGrime( 1.4 ).g - 0.5 ) + 0.2 * propStrain(), 0.15, 1.0 );`,
    metal: /* glsl */ `
	metalnessFactor = propPainted > 0.5 ? 0.3 : metalnessFactor;`,
  },
  signFace: {
    map: /* glsl */ `
#ifdef USE_MAP
	{
		// the instance seed picks one of the 4 sign faces of the atlas
		float k = floor( propInstance().x * 4.0 );
		vec2 cell = vec2( mod( k, 2.0 ), k < 2.0 ? 1.0 : 0.0 ) * 0.5;
		vec4 sampledDiffuseColor = texture2D( map, cell + clamp( vMapUv, 0.002, 0.998 ) * 0.5 );
		diffuseColor *= sampledDiffuseColor;
	}
#endif`,
    color: /* glsl */ `
	{
		vec3 g = propGrime( 2.0 );
		diffuseColor.rgb *= 1.0 - 0.2 * g.r * ( 0.3 + propInstance().y ) - 0.3 * propStrain();
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.55 ), propScuff() * 0.5 * g.g );
	}`,
  },
  stopFace: {
    color: /* glsl */ `
	{
		vec3 g = propGrime( 2.0 );
		diffuseColor.rgb *= 1.0 - 0.15 * g.r * ( 0.3 + propInstance().y ) - 0.3 * propStrain();
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.55 ), propScuff() * 0.5 * g.g );
	}`,
  },
  lampLens: {
    emissive: /* glsl */ `
	totalEmissiveRadiance *= 0.85 + 0.3 * propInstance().y;`,
  },
};

function makeHook(slot: PropMaterialSlot, grime: Texture): Hook {
  const g = SLOT_GLSL[slot];
  const uGrime = { value: grime };
  return (shader) => {
    shader.uniforms.uPropGrime = uGrime;
    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON_PARS}${g.pars ?? ''}`);
    if (g.map) fs = fs.replace('#include <map_fragment>', g.map);
    if (g.color) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${g.color}`);
    if (g.rough) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${g.rough}`);
    if (g.metal) fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${g.metal}`);
    if (g.emissive) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${g.emissive}`);
    shader.fragmentShader = fs;
    clampRadiance(shader);
  };
}

export interface PropMaterialSet {
  base(slot: PropMaterialSlot): MeshStandardMaterial;
  dispose(): void;
}

/** Base materials per slot (textures are shared, cached in ./textures). */
export function createPropMaterials(_ctx: RenderContext | null): PropMaterialSet {
  const tex = propTextures;
  const grime = tex.grime();
  const mats = new Map<PropMaterialSlot, MeshStandardMaterial>();
  const make = (slot: PropMaterialSlot): MeshStandardMaterial => {
    let m: MeshStandardMaterial;
    switch (slot) {
      case 'conePlastic':
        m = new MeshStandardMaterial({ color: 0xff4f0d, roughness: 0.5, metalness: 0, normalMap: tex.plasticGrain() });
        m.normalScale.set(0.25, 0.25);
        break;
      case 'reflective':
        m = new MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.28, metalness: 0, normalMap: tex.prism() });
        m.normalScale.set(0.12, 0.12);
        break;
      case 'barrelPaint':
        m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.25 });
        break;
      case 'rubber': {
        const r = tex.rubber();
        m = new MeshStandardMaterial({ color: 0x2a2a2b, roughness: 0.88, metalness: 0, map: r.color, normalMap: r.normal });
        m.normalScale.set(1, 1);
        break;
      }
      case 'cardboard': {
        const c = tex.cardboard();
        m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, map: c.color, normalMap: c.normal });
        m.normalScale.set(0.35, 0.35);
        break;
      }
      case 'wood': {
        const c = tex.crate();
        m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, map: c.color, normalMap: c.normal });
        m.normalScale.set(0.8, 0.8);
        break;
      }
      case 'concrete': {
        const c = tex.concrete();
        m = new MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.92, metalness: 0, map: c.color, normalMap: c.normal });
        m.normalScale.set(0.7, 0.7);
        break;
      }
      case 'galvanized': {
        m = new MeshStandardMaterial({ color: 0xd4d7da, roughness: 0.36, metalness: 0.6, map: tex.galvanized() });
        break;
      }
      case 'signFace':
        m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0, map: tex.sign() });
        break;
      case 'stopFace':
        m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0, map: tex.stop() });
        break;
      case 'lampLens':
        m = new MeshStandardMaterial({
          color: 0xe8e4da,
          roughness: 0.18,
          metalness: 0,
          normalMap: tex.lens(),
          emissive: new Color(0xffb15c),
          emissiveIntensity: 1.6,
        });
        m.normalScale.set(0.4, 0.4);
        break;
    }
    for (const t of [m.map, m.normalMap]) if (t) t.wrapS = t.wrapT = RepeatWrapping;
    m.name = `prop:${slot}`;
    m.onBeforeCompile = makeHook(slot, grime);
    const key = `prop:${slot}`;
    m.customProgramCacheKey = () => key;
    return m;
  };
  return {
    base(slot) {
      let m = mats.get(slot);
      if (!m) {
        m = make(slot);
        mats.set(slot, m);
      }
      return m;
    },
    dispose() {
      for (const m of mats.values()) m.dispose();
      mats.clear();
    },
  };
}

/** For tests: the hook's GLSL edits applied to a fake shader. */
export function applySlotHook(slot: PropMaterialSlot, shader: WebGLProgramParametersWithUniforms, grime: Texture): void {
  makeHook(slot, grime)(shader);
}
