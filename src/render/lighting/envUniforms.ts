/**
 * The env patch's always-loaded half: the shared uniform objects (main,
 * the FX and every lazily loaded lighting module write them) and the
 * ShaderPatch handles patchMaterial appends. The GLSL and the injector
 * (envPatch.ts) live in the lazily loaded lighting chunk and register
 * themselves on import; a world-lit (csm) material can only exist once the
 * lighting stack — and so the injector — has loaded.
 */
import { Matrix3, Vector2, Vector3, Vector4 } from 'three';
import type { Texture, WebGLProgramParametersWithUniforms } from 'three';

import type { ShaderPatch } from '../types';
import { ATMOSPHERE, ATMOSPHERE_BASE_ALTITUDE_M, SUN_ILLUMINANCE_TOA } from './atmosphere';

/** Program-cache key of the env patch (bump when the GLSL changes shape). */
export const ENV_PATCH_KEY = 'env2';

/** Rayleigh extinction at the valley floor per metre (×1.5: the valley's long sight lines read as distance). */
export const AERIAL_RAYLEIGH_PER_M = ATMOSPHERE.rayleighScattering.map((x) => x * 1e-6 * 1.5) as [number, number, number];

/** HG asymmetry of the analytic haze glow toward the sun. */
export const HAZE_GLOW_G = 0.76;

/** Shared uniform objects (never replace these objects; write `.value`). */
export const ENV_UNIFORMS = {
  /** L2 SH of the sky radiance (9 × rgb; sky.ts probe → lighting.ts), haze colour of world-lit materials. */
  crumpleHazeSH: { value: Array.from({ length: 9 }, (_, i) => (i === 0 ? new Vector3(1.2, 1.4, 1.7) : new Vector3())) },
  /** Mie glow toward the sun (radiance at the HG peak / phase), rgb. */
  crumpleHazeGlow: { value: new Vector3() },
  crumpleSkyView: { value: null as Texture | null },
  /** Viewer radius, Mm (ground radius + valley altitude + camera height). */
  crumpleSkyHeight: { value: ATMOSPHERE.groundRadius + ATMOSPHERE_BASE_ALTITUDE_M * 1e-6 },
  /** Toward the SUN (even at night: the sky LUT is the sun's). */
  crumpleSunDir: { value: new Vector3(0, 1, 0) },
  /** Sky-LUT radiance scale (solar illuminance at the top of the atmosphere, scene units). */
  crumpleSkySunE: { value: SUN_ILLUMINANCE_TOA },
  crumpleNightZenith: { value: new Vector3(0.0012, 0.0018, 0.0036) },
  crumpleNightHorizon: { value: new Vector3(0.0022, 0.0028, 0.0042) },
  crumpleMoonDir: { value: new Vector3(0, -1, 0) },
  crumpleMoonGlow: { value: new Vector3() },
  /** rgb = overcast deck radiance, a = cover 0..1 (blends the clear sky toward it). */
  crumpleOvercast: { value: new Vector4(0, 0, 0, 0) },
  /** Rayleigh extinction per metre. */
  crumpleBetaR: { value: new Vector3(...AERIAL_RAYLEIGH_PER_M) },
  /** scene.environmentIntensity mirrored for the haze. */
  crumpleEnvIntensity: { value: 1 },
  /** Equatorial → world rotation of the star field (sky dome only, shared for convenience). */
  crumpleStarRot: { value: new Matrix3() },
  /** Clustered lights: packed records + cell lists (lightGrid.ts). */
  crumpleLightGrid: { value: null as Texture | null },
  /** World XZ of the light grid's (0, 0) corner. */
  crumpleGridOrigin: { value: new Vector2() },
  /** 0 by day … 1 at night: artificial lights + lamp-lens emissives. */
  crumpleLightGain: { value: 0 },
  /** Cloud-shadow map (r = transmittance along the key light) and its world rect: origin x, z, 1/span, value outside. */
  crumpleCloudShadow: { value: null as Texture | null },
  crumpleCloudRect: { value: new Vector4(0, 0, 1 / 4096, 1) },
  /** x = surface wetness 0..1, y = rain intensity 0..1, z = wall-clock seconds (ripples, beads), w = 0. */
  crumpleWet: { value: new Vector4() },
  /** Puddle potential (puddles.ts, R8 over the map) and its rect: origin x, z, 1/width m, 1/height m. */
  crumplePuddleMap: { value: null as Texture | null },
  crumplePuddleRect: { value: new Vector4(0, 0, 0, 0) },
  /** Headlight beam frame (world): axis, up; w of the axis = tan(cone half angle), w of up = 1 high beam / 0 low. */
  crumpleBeamAxis: { value: new Vector4(0, 0, -1, 0.73) },
  crumpleBeamUp: { value: new Vector4(0, 1, 0, 0) },
};
export type EnvUniforms = typeof ENV_UNIFORMS;

/** Per-material env options (MaterialFeatures.env). */
export interface EnvOptions {
  /** Lamp lens: its emissive runs at this fraction by day, full at night (0..1). */
  lamp?: number;
  /** Wet-surface response (default 'generic'). */
  wet?: 'generic' | 'ground' | 'road' | 'paint' | 'none';
}

type EnvInjector = (shader: WebGLProgramParametersWithUniforms, opts: EnvOptions) => boolean;
let injector: EnvInjector | null = null;
/** envPatch.ts registers its injector on import. */
export function setEnvInjector(fn: EnvInjector): void {
  injector = fn;
}

const envPatches = new Map<string, ShaderPatch>();

/** The patch patchMaterial appends for world-lit (csm) materials (one instance per option set). */
export function envPatchFor(opts: EnvOptions = {}): ShaderPatch {
  const key = `${ENV_PATCH_KEY}${opts.lamp !== undefined ? `L${opts.lamp.toFixed(3)}` : ''}${opts.wet && opts.wet !== 'generic' ? `W${opts.wet}` : ''}`;
  let p = envPatches.get(key);
  if (!p) {
    p = {
      key,
      targets: ['color'],
      apply(shader) {
        if (!injector) throw new Error('env patch: lighting/envPatch.ts not loaded');
        injector(shader, opts);
      },
    };
    envPatches.set(key, p);
  }
  return p;
}
