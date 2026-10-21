/**
 * Layout v6 region data (R-WORLD): each region module contributes zones, pads,
 * roads, junctions, spawns, surface patches, areas and POIs; layout.ts
 * merges them into DEFAULT_LAYOUT after the P3–P8 core. Pure data.
 */
import type {
  JunctionDef,
  PadDef,
  PointOfInterest,
  RoadDef,
  SpawnPoint,
  SurfacePatchDef,
  Vec2,
  WorldArea,
  ZoneDef,
} from '../types';

export interface RegionData {
  zones?: ZoneDef[];
  pads?: PadDef[];
  roads?: RoadDef[];
  junctions?: JunctionDef[];
  spawns?: SpawnPoint[];
  surfaces?: SurfacePatchDef[];
  areas?: WorldArea[];
  pois?: PointOfInterest[];
}

/** Unit (x, z) heading from a compass-free direction vector (layout rule: no angles). */
export function unit(x: number, z: number): Vec2 {
  const l = Math.sqrt(x * x + z * z);
  return [x / l, z / l];
}
