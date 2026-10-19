/**
 * Vehicle render LOD (U6, P5 perf; docs/CONTRACTS.md "Vehicle perf
 * amendments"). Pure: distances, hysteresis and the per-def registry of
 * coarser visual defs + render-side binding extras.
 *
 *   LOD0  < VEHICLE_LOD1_M   full body (3 blended triads in the colour pass), full wheels
 *   LOD1  < VEHICLE_LOD2_M   body def `lods[0]` (≈ 40 % of the triangles), single-triad, wheel LOD1
 *   LOD2  beyond             body def `lods[1]`, single-triad, wheel LOD2
 * Each boundary has ±VEHICLE_LOD_HYSTERESIS_M so a camera hovering at the
 * threshold never flickers between levels. Distances are measured from the
 * view camera to the skin anchor, scaled by the camera's zoom against the
 * 60° reference field of view (a zoomed-in camera keeps detail).
 * Shadows never use LOD0: cascade 0 casts LOD1, cascades ≥ 1 LOD2.
 */
import type { VehicleVisualDef } from './types';

export const VEHICLE_LOD1_M = 25;
export const VEHICLE_LOD2_M = 80;
export const VEHICLE_LOD_HYSTERESIS_M = 2;
/** Reference vertical field of view (degrees) the distances are tuned for. */
export const VEHICLE_LOD_REF_FOV = 60;

/** Next LOD level for an effective camera distance `d` (m), with hysteresis around each boundary. */
export function selectVehicleLod(prev: number, d: number, maxLevel = 2): number {
  if (!Number.isFinite(d)) return prev;
  const h = VEHICLE_LOD_HYSTERESIS_M;
  let lod = prev < 0 ? 0 : prev > maxLevel ? maxLevel : prev;
  if (lod === 0 && d > VEHICLE_LOD1_M + h) lod = 1;
  if (lod === 1 && d < VEHICLE_LOD1_M - h) lod = 0;
  if (lod === 1 && d > VEHICLE_LOD2_M + h) lod = 2;
  if (lod === 2 && d < VEHICLE_LOD2_M - h) lod = d < VEHICLE_LOD1_M - h ? 0 : 1;
  if (lod === 0 && d > VEHICLE_LOD2_M + h) lod = 2; // a camera jump straight past both
  return lod > maxLevel ? maxLevel : lod;
}

/** Effective LOD distance: true distance × tan(fov/2) / tan(ref/2) (zooming in = closer). */
export function lodDistance(distance: number, fovDeg: number | undefined): number {
  if (fovDeg === undefined || !(fovDeg > 0 && fovDeg < 179)) return distance;
  return (distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.tan((VEHICLE_LOD_REF_FOV * Math.PI) / 360);
}

/**
 * Render-side extras of a VehicleVisualDef (not part of the frozen def):
 *   lods    coarser defs for LOD1, LOD2 (same panel ids; built lazily, once)
 *   follow  follower panel id → leader panel id: the follower is re-bound
 *           with the leader's triads (binder.ts bindFollower), so it moves
 *           as a constant offset of the leader's surface (interior door
 *           cards behind the door skins never poke through a dent).
 */
export interface VehicleVisualExtras {
  lods?: readonly (() => VehicleVisualDef)[];
  follow?: Readonly<Record<string, string>>;
}

const EXTRAS = new WeakMap<VehicleVisualDef, VehicleVisualExtras>();

export function setVisualExtras(def: VehicleVisualDef, extras: VehicleVisualExtras): void {
  EXTRAS.set(def, extras);
}

export function visualExtras(def: VehicleVisualDef): VehicleVisualExtras {
  return EXTRAS.get(def) ?? {};
}

/** Memoizes a def builder (LOD defs are shared by every vehicle using the same base def). */
export function once<T>(build: () => T): () => T {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = build();
      done = true;
    }
    return v as T;
  };
}
