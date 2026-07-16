// Texture/HDRI loading with procedural fallback — the ONLY three-importing
// module under src/assets. Real CC0 files are CI-fetched into public/assets;
// when absent (normal in the dev sandbox) every load falls back to DataTextures
// built from src/assets/procedural.ts, so nothing here may hard-fail.

import {
  DataTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

import { assetUrl, HDRI_FILES, TERRAIN_SETS } from './manifest';
import type { HdriName, TerrainSlug } from './manifest';
import { makeFallbackMaps, makeFallbackSkyEquirect } from './procedural';
import type { RgbaImage } from './procedural';

export interface TerrainTextureSet {
  slug: TerrainSlug;
  color: Texture;
  normal: Texture;
  rough: Texture;
  /** null when the real AO map is unavailable (procedural set has none) */
  ao: Texture | null;
  /** true when procedural fallbacks were substituted for missing files */
  procedural: boolean;
}

export interface TerrainLoadOptions {
  /**
   * Anisotropy hint — pass renderer.capabilities.getMaxAnisotropy(); this
   * module never touches the renderer itself. Defaults to 1.
   */
  anisotropy?: number;
  /** procedural fallback resolution (default 512) */
  fallbackSize?: number;
  /** procedural fallback seed (default 1) */
  fallbackSeed?: number;
}

export interface EnvironmentTexture {
  /** equirect texture ready for PMREM / scene.environment */
  texture: Texture;
  procedural: boolean;
}

async function tryLoad(loader: TextureLoader, url: string): Promise<Texture | null> {
  try {
    return await loader.loadAsync(url);
  } catch {
    return null;
  }
}

function applyTerrainParams(tex: Texture, anisotropy: number, srgb: boolean): Texture {
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = SRGBColorSpace;
  return tex;
}

function dataTextureFrom(img: RgbaImage): DataTexture {
  const tex = new DataTexture(img.data, img.width, img.height, RGBAFormat, UnsignedByteType);
  // DataTexture defaults to NearestFilter / no mips — undo that
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load one terrain PBR set, falling back to a consistent procedural set if any
 * required map (color/normal/rough) is missing. Never rejects for missing files.
 */
export async function loadTerrainSet(
  slug: TerrainSlug,
  opts: TerrainLoadOptions = {},
): Promise<TerrainTextureSet> {
  const anisotropy = opts.anisotropy ?? 1;
  const { maps } = TERRAIN_SETS[slug];
  const loader = new TextureLoader();
  const [color, normal, rough, ao] = await Promise.all([
    tryLoad(loader, assetUrl(maps.color)),
    tryLoad(loader, assetUrl(maps.normal)),
    tryLoad(loader, assetUrl(maps.rough)),
    maps.ao ? tryLoad(loader, assetUrl(maps.ao)) : Promise.resolve<Texture | null>(null),
  ]);

  if (color && normal && rough) {
    return {
      slug,
      color: applyTerrainParams(color, anisotropy, true),
      normal: applyTerrainParams(normal, anisotropy, false),
      rough: applyTerrainParams(rough, anisotropy, false),
      ao: ao ? applyTerrainParams(ao, anisotropy, false) : null,
      procedural: false,
    };
  }

  // Partial sets are discarded whole so color/normal/rough always agree.
  for (const t of [color, normal, rough, ao]) t?.dispose();
  console.info(`[assets] terrain '${slug}' files missing — using procedural fallback`);
  const fb = makeFallbackMaps(slug, opts.fallbackSize ?? 512, opts.fallbackSeed ?? 1);
  return {
    slug,
    color: applyTerrainParams(dataTextureFrom(fb.color), anisotropy, true),
    normal: applyTerrainParams(dataTextureFrom(fb.normal), anisotropy, false),
    rough: applyTerrainParams(dataTextureFrom(fb.rough), anisotropy, false),
    ao: null,
    procedural: true,
  };
}

/** Load every terrain set in parallel (each independently falls back). */
export async function loadAllTerrainSets(
  opts: TerrainLoadOptions = {},
): Promise<Record<TerrainSlug, TerrainTextureSet>> {
  const slugs = Object.keys(TERRAIN_SETS) as TerrainSlug[];
  const sets = await Promise.all(slugs.map((slug) => loadTerrainSet(slug, opts)));
  const out = {} as Record<TerrainSlug, TerrainTextureSet>;
  for (const set of sets) out[set.slug] = set;
  return out;
}

/**
 * Load an HDR environment (equirect). Falls back to a procedural golden-hour
 * sky when the .hdr is missing. r185 RGBELoader defaults to HalfFloatType,
 * which is what PMREM wants — no explicit setDataType needed.
 */
export async function loadEnvironmentHDR(
  name: HdriName = 'kiara_1_dawn',
  opts: { fallbackSize?: number } = {},
): Promise<EnvironmentTexture> {
  try {
    const texture = await new RGBELoader().loadAsync(assetUrl(HDRI_FILES[name]));
    texture.mapping = EquirectangularReflectionMapping;
    return { texture, procedural: false };
  } catch {
    console.info(`[assets] HDRI '${name}' missing — using procedural sky fallback`);
    const sky = makeFallbackSkyEquirect(opts.fallbackSize ?? 1024);
    const texture = new DataTexture(sky.data, sky.width, sky.height, RGBAFormat, UnsignedByteType);
    texture.colorSpace = SRGBColorSpace;
    texture.mapping = EquirectangularReflectionMapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearFilter;
    texture.needsUpdate = true;
    return { texture, procedural: true };
  }
}
