/**
 * Ground material table (indexed by the FROZEN MaterialId values).
 *
 * Effective contact μ = node friction × material friction, so a tyre node
 * (μ 2.0) on asphalt grips at 2.0 and a chassis node (μ 0.5) scrapes at 0.5.
 */
import { MATERIAL_COUNT, MaterialId, type MaterialTable } from '../types';

/** Material friction multipliers by name (documentation + tuning UIs). */
export const MATERIAL_FRICTION: Readonly<Record<keyof typeof MaterialId, number>> = {
  asphalt: 1.0,
  grass: 0.6,
  dirt: 0.7,
  rock: 0.9,
  gravel: 0.65,
  concrete: 1.0,
  metal: 0.4,
  // P5 object materials (static colliders such as tree trunks; node-vs-node contact uses node friction only).
  plastic: 0.5,
  rubber: 1.1,
  wood: 0.6,
  cardboard: 0.55,
  // Layout v6 terrain surfaces (R-WORLD; = src/world/surfaces.ts SURFACE_PHYSICS[*].friction).
  // Rolling resistance / sinkage of that table are R-PHYS's to apply in the tyre contact.
  mud: 0.45,
  sand: 0.55,
  wetGrass: 0.42,
  asphaltWorn: 0.93,
};

/** Builds a MaterialTable; `overrides` replace individual entries. Not for hot paths (allocates). */
export function createMaterialTable(
  overrides: Partial<Record<keyof typeof MaterialId, number>> = {},
): MaterialTable {
  const friction = new Float64Array(MATERIAL_COUNT);
  for (const name of Object.keys(MaterialId) as (keyof typeof MaterialId)[]) {
    friction[MaterialId[name]] = overrides[name] ?? MATERIAL_FRICTION[name];
  }
  return { friction };
}

export const DEFAULT_MATERIALS: MaterialTable = createMaterialTable();
