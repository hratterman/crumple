// Pure asset manifest — no three/DOM imports so sim, tools, and tests can use it.

export type TerrainSlug = 'asphalt' | 'grass' | 'dirt' | 'rock' | 'gravel';

export const TERRAIN_SLUGS = [
  'asphalt',
  'grass',
  'dirt',
  'rock',
  'gravel',
] as const satisfies readonly TerrainSlug[];

export interface TerrainMapPaths {
  color: string;
  normal: string;
  rough: string;
  ao?: string;
}

export interface TerrainSet {
  /** directory of the set, relative to the site base (under public/) */
  dir: string;
  maps: TerrainMapPaths;
}

function terrainSet(slug: TerrainSlug): TerrainSet {
  const dir = `assets/textures/${slug}`;
  return {
    dir,
    maps: {
      color: `${dir}/color.jpg`,
      normal: `${dir}/normal.jpg`,
      rough: `${dir}/rough.jpg`,
      ao: `${dir}/ao.jpg`,
    },
  };
}

/** CC0 PBR sets fetched by tools/fetch-assets.mjs (ambientCG); paths exist only after CI fetch. */
export const TERRAIN_SETS: Record<TerrainSlug, TerrainSet> = {
  asphalt: terrainSet('asphalt'),
  grass: terrainSet('grass'),
  dirt: terrainSet('dirt'),
  rock: terrainSet('rock'),
  gravel: terrainSet('gravel'),
};

/** CC0 HDR environments (Poly Haven); kiara_1_dawn is the primary golden-hour env. */
export const HDRI_FILES = {
  kiara_1_dawn: 'assets/hdri/kiara_1_dawn_2k.hdr',
  venice_sunset: 'assets/hdri/venice_sunset_2k.hdr',
} as const;

export type HdriName = keyof typeof HDRI_FILES;

/** sha256 inventory written by tools/fetch-assets.mjs alongside the fetched files */
export const ASSET_MANIFEST_JSON = 'assets/manifest.json';

/**
 * Resolve an asset path relative to the site base.
 * Vite statically replaces import.meta.env.BASE_URL in builds ('/crumple/' on
 * Pages, '/' in dev); the try/catch keeps this module loadable under plain
 * node (tools, vitest) where import.meta.env may be absent.
 */
export function assetUrl(rel: string): string {
  let base = '/';
  try {
    const b = import.meta.env.BASE_URL;
    if (typeof b === 'string' && b.length > 0) base = b;
  } catch {
    // plain node: keep '/'
  }
  if (!base.endsWith('/')) base += '/';
  return base + (rel.startsWith('/') ? rel.slice(1) : rel);
}
