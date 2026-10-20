/**
 * Road surface styles (pure data). One style per RoadKind; the ribbon shader
 * compiles one program variant per style (core + fringe).
 */
import { ROAD_KIND_DEFAULTS, type RoadKind, type RoadProfile } from '../../world/types';

export type RoadStyle = 'highway' | 'mountain' | 'country' | 'street' | 'arena' | 'dirt';
export const ROAD_STYLES: readonly RoadStyle[] = ['highway', 'mountain', 'country', 'street', 'arena', 'dirt'];

export interface RoadStyleParams {
  /** Curb-return radius where this road joins a road it yields to, m. */
  fillet: number;
  /** Width of the transparent outer fringe (gravel → terrain fade), m. */
  fringe: number;
  /** Opaque core stops this far inside the verge's outer edge, m. */
  fringeInset: number;
  /** Crosswalks + stop lines at junctions. */
  crosswalks: boolean;
  /** Stop line where this road yields. */
  stopLine: boolean;
  /** Paint wear 0..1. */
  wear: number;
}

export const ROAD_STYLE_PARAMS: Readonly<Record<RoadStyle, RoadStyleParams>> = {
  highway: { fillet: 9, fringe: 1.6, fringeInset: 0.35, crosswalks: false, stopLine: false, wear: 0.12 },
  mountain: { fillet: 5, fringe: 1.4, fringeInset: 0.3, crosswalks: false, stopLine: true, wear: 0.45 },
  country: { fillet: 7, fringe: 1.5, fringeInset: 0.35, crosswalks: false, stopLine: true, wear: 0.3 },
  street: { fillet: 4.5, fringe: 1.0, fringeInset: 0.15, crosswalks: true, stopLine: true, wear: 0.3 },
  arena: { fillet: 8, fringe: 1.4, fringeInset: 0.3, crosswalks: false, stopLine: false, wear: 0.2 },
  dirt: { fillet: 4, fringe: 1.8, fringeInset: 0.9, crosswalks: false, stopLine: false, wear: 0 },
};

const KIND_STYLE: Readonly<Record<RoadKind, RoadStyle>> = {
  highway: 'highway',
  mountain: 'mountain',
  country: 'country',
  street: 'street',
  arena: 'arena',
  dirt: 'dirt',
  // Layout v6 racing circuit / pit lane: the arena's clean concrete-grey asphalt style.
  track: 'arena',
};

export function styleForProfile(p: RoadProfile): RoadStyle {
  return KIND_STYLE[p.kind];
}

/**
 * Roads that get a mesh: every 'ribbon' road, plus dirt trails as a
 * conforming overlay (ruts + soft edges over the terrain's dirt splat).
 */
export function isRendered(p: RoadProfile): boolean {
  return p.surface === 'ribbon' || p.kind === 'dirt';
}

export function kindPriority(kind: RoadKind): number {
  return ROAD_KIND_DEFAULTS[kind].priority;
}
