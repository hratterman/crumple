/**
 * R-RIG ⇄ R-CORE: the rig-variant interface behind the "physics quality"
 * setting (docs/CONTRACTS.md "R-RIG"). LIGHT module (no rig data): main /
 * the worker import it eagerly; every HD rig is a separate lazily imported
 * chunk (`loadVehicleVariant`), generated on first use.
 *
 *   standard  the hand-tuned P2–P6 rigs (unchanged; ≤ 3500 player beams)
 *   high      sheet-metal skins at ~15 cm on every exterior panel, seams,
 *             real-gauge mass redistribution (≈ 2.5–3× standard)
 *   ultra     ~11 cm skins (+ closed-section members where specified),
 *             the densest tier (≈ 4× standard)
 * A car without a given tier falls back to the next lower one.
 */
import type { CrashProbes } from '../../crash';
import type { VehicleDef } from '../../types';
import type { CollisionTriangle, RigGenReport } from '../../../rig/gen/types';

export type PhysicsQuality = 'standard' | 'high' | 'ultra';
export const PHYSICS_QUALITIES: readonly PhysicsQuality[] = ['standard', 'high', 'ultra'];

/**
 * Per-tier budgets. Beams: the validator's player budget for that tier
 * (standard = PLAYER_BEAM_BUDGET 3500). Cost: the worker's measured ms of
 * CPU per simulated second for the player car alone on the JS kernel
 * (U1's method; see CONTRACTS "R-RIG" for the measurements); the WASM
 * column is R-CORE's to fill once its kernel lands.
 */
export const PHYSICS_QUALITY_BUDGETS: Readonly<Record<PhysicsQuality, { playerBeams: number; playerNodes: number }>> = {
  standard: { playerBeams: 3500, playerNodes: 1024 },
  high: { playerBeams: 8000, playerNodes: 2048 },
  ultra: { playerBeams: 14000, playerNodes: 3072 },
};

export interface VehicleVariant {
  /** Catalog id ('sedan', 'coupe', …). */
  car: string;
  /** The tier actually delivered (≤ the one asked for). */
  quality: PhysicsQuality;
  def: VehicleDef;
  probes: CrashProbes;
  /** HD tiers only: generator report and the outer-skin collision triangles (R-CORE node-vs-triangle format). */
  report?: RigGenReport;
  collision?: readonly CollisionTriangle[];
  /** HD tiers only: sheet node ids per render panel (the HD visual binds each panel to its sheet). */
  skinNodes?: Readonly<Record<string, readonly string[]>>;
}

type Loader = (q: Exclude<PhysicsQuality, 'standard'>) => Promise<VehicleVariant | null>;

/** Cars with HD tiers: dynamic imports, so each car's rig data is its own chunk. */
const HD_LOADERS: Readonly<Record<string, Loader>> = {
  sedan: async (q) => (await import('./sedan')).sedanVariant(q),
};

/**
 * The car's rig at `quality`, falling back to the next lower tier the car
 * has. `standard` resolves the caller-supplied standard def (main already
 * has it; this module never imports rig data eagerly).
 */
export async function loadVehicleVariant(car: string, quality: PhysicsQuality, standard: () => Promise<VehicleVariant>): Promise<VehicleVariant> {
  const loader = HD_LOADERS[car];
  if (loader && quality !== 'standard') {
    for (const q of quality === 'ultra' ? (['ultra', 'high'] as const) : (['high'] as const)) {
      const v = await loader(q);
      if (v) return v;
    }
  }
  return standard();
}

/** Tiers a car offers (UI). */
export function variantTiers(car: string): readonly PhysicsQuality[] {
  return HD_LOADERS[car] ? PHYSICS_QUALITIES : ['standard'];
}
