/**
 * Points of interest + areas (layout v6, R-WORLD): resolution helpers for game
 * modes. Pure, both sides. See PointOfInterest / WorldArea in types.ts and the
 * frozen id list in docs/CONTRACTS.md "R-WORLD contracts".
 */
import { compileShape } from './shapes';
import { surfaceIndex } from './surface';
import type { PointOfInterest, ResolvedCollider, ResolvedPoi, WorldArea, WorldLayout } from './types';

/**
 * Resolves every POI's y: explicit y kept; y null = the support surface (terrain,
 * or the top of a box / ramp collider over it — a bridge deck, a crash-lab floor).
 */
export function resolvePois(
  pois: readonly PointOfInterest[],
  heightAt: (x: number, z: number) => number,
  colliders: readonly ResolvedCollider[] = [],
): ResolvedPoi[] {
  const surf = surfaceIndex(
    colliders.filter((c) => c.visual !== 'lid' && c.visual !== 'tunnelWall' && c.visual !== 'building'),
    heightAt,
  );
  return pois.map((p) => ({ ...p, pos: [p.pos[0], p.pos[1] ?? surf.at(p.pos[0], p.pos[2]), p.pos[2]] as const }));
}

/** POIs of one area (layout order). */
export function poisOf(layout: WorldLayout, area: string): PointOfInterest[] {
  return (layout.pois ?? []).filter((p) => p.area === area);
}

/** The POI with this id, or null. */
export function poiById(layout: WorldLayout, id: string): PointOfInterest | null {
  return (layout.pois ?? []).find((p) => p.id === id) ?? null;
}

/** Areas whose bounds contain (x, z) (layout order; overlapping areas all match). */
export function areasAt(layout: WorldLayout, x: number, z: number): WorldArea[] {
  return (layout.areas ?? []).filter((a) => compileShape(a.bounds).outside(x, z) <= 0);
}
