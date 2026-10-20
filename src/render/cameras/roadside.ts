/**
 * Roadside finder for the trackside camera (CameraWorld.roadside): the
 * nearest road centreline point to (x, z), pushed out past the carriageway
 * and shoulder on the requested side. Uses the pure world road profiles, so
 * the camera stands on the verge, not in a lane or a field.
 */
import type { Vector3 } from 'three';
import { createRoadProjection, createRoadSample, projectToRoad, sampleRoad } from '../../world/roads';
import type { RoadProfile } from '../../world/types';

export type RoadsideFn = (x: number, z: number, side: 1 | -1, offset: number, maxDist: number, out: Vector3) => boolean;

export function createRoadside(roads: readonly RoadProfile[], groundHeight: (x: number, z: number) => number): RoadsideFn {
  const proj = createRoadProjection();
  const sample = createRoadSample();
  return (x, z, side, offset, maxDist, out) => {
    let best: RoadProfile | null = null;
    let bestS = 0;
    let bestDist = maxDist;
    for (const r of roads) {
      projectToRoad(r, x, z, proj);
      if (proj.dist < bestDist) {
        bestDist = proj.dist;
        best = r;
        bestS = proj.s;
      }
    }
    if (!best) return false;
    sampleRoad(best, bestS, sample);
    const d = side * (best.width / 2 + best.shoulder + offset);
    out.set(sample.x + sample.rx * d, 0, sample.z + sample.rz * d);
    out.y = groundHeight(out.x, out.z);
    return true;
  };
}
