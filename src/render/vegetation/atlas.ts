/**
 * Vegetation atlas layout (pure data; textures.ts paints it). Canvas pixels,
 * y down; UV rects are in three's v-up convention (rows are stored
 * bottom-up, flipY false).
 */
export const ATLAS_SIZE = 1024;

/** Atlas region in canvas pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** UV rect (u0, v0 bottom-left, du, dv) in three's convention. */
export interface UvRect {
  u: number;
  v: number;
  du: number;
  dv: number;
}

export const ATLAS_PX: Readonly<Record<AtlasRegion, PxRect>> = {
  barkConifer: { x: 0, y: 0, w: 128, h: 1024 },
  barkBroad: { x: 128, y: 0, w: 128, h: 1024 },
  barkBirch: { x: 256, y: 0, w: 128, h: 1024 },
  sprig: { x: 384, y: 0, w: 640, h: 256 },
  pine: { x: 384, y: 256, w: 640, h: 256 },
  leaves: { x: 384, y: 512, w: 320, h: 320 },
  birchLeaves: { x: 704, y: 512, w: 320, h: 320 },
  scrub: { x: 384, y: 832, w: 320, h: 192 },
  reeds: { x: 704, y: 832, w: 160, h: 192 },
  fern: { x: 864, y: 832, w: 160, h: 192 },
};
export type AtlasRegion =
  | 'barkConifer'
  | 'barkBroad'
  | 'barkBirch'
  | 'sprig'
  | 'pine'
  | 'leaves'
  | 'birchLeaves'
  | 'scrub'
  | 'reeds'
  | 'fern';

/** UV rect of a region (half-texel inset on card regions so mips do not bleed across). */
export function atlasRect(r: AtlasRegion): UvRect {
  const p = ATLAS_PX[r];
  const inset = r.startsWith('bark') ? 0 : 1;
  return {
    u: (p.x + inset) / ATLAS_SIZE,
    v: 1 - (p.y + p.h - inset) / ATLAS_SIZE,
    du: (p.w - 2 * inset) / ATLAS_SIZE,
    dv: (p.h - 2 * inset) / ATLAS_SIZE,
  };
}
/** Bark tiles: one texture repeat around the trunk, BARK_V_M metres per repeat along it. */
export const BARK_V_M = 9;

