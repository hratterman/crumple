/**
 * SEDAN high-density visuals (R-RIG): buildSedanVisual (every LOD) re-pointed at sedanHD(tier) — see index.ts.
 */
import type { HdTier } from '../../../../sim/vehicle/defs/hd/skinSources';
import type { VehicleVisualDef } from '../../types';
import { vehicleVisualSync } from './index';

/** The sedan's HD visual for a tier (LOD0; LOD1 / LOD2 + door-card followers registered). Memoized. */
export function sedanHDVisual(tier: HdTier): VehicleVisualDef {
  return vehicleVisualSync('sedan', tier);
}
