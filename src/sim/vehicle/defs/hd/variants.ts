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

import type { PhysicsQuality } from '../../../../protocol/messages';

// the union lives in the protocol (R-CORE's setting); re-exported for the rig side
export { PHYSICS_QUALITIES, type PhysicsQuality } from '../../../../protocol/messages';

/**
 * Per-tier budgets. Beams: the validator's player budget for that tier
 * (standard = PLAYER_BEAM_BUDGET 3500). Cost: the worker's measured ms of
 * CPU per simulated second for the player car alone on the JS kernel
 * (U1's method; see CONTRACTS "R-RIG" for the measurements); the WASM
 * column is R-CORE's to fill once its kernel lands.
 */
export const PHYSICS_QUALITY_BUDGETS: Readonly<Record<PhysicsQuality, { playerBeams: number; playerNodes: number }>> = {
  standard: { playerBeams: 3500, playerNodes: 1024 },
  high: { playerBeams: 10000, playerNodes: 2048 },
  ultra: { playerBeams: 16000, playerNodes: 3072 },
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

type HdQuality = Exclude<PhysicsQuality, 'standard'>;
type Loader = (q: HdQuality) => Promise<VehicleVariant | null>;

/**
 * Which HD tiers have passed the car's full acceptance suite (src/sim/vehicle/defs/hd/validation.test.ts:
 * the standard car's own crash / settling / handling / body-flex / launch-feel / rollover targets). An
 * 'experimental' tier is generated and structurally tested (hd.test.ts) but still misses a target: the quality
 * setting skips it (falls back to the next lower validated tier, then standard) unless the caller opts in.
 */
export type VariantStatus = 'validated' | 'experimental';
export const HD_STATUS: Readonly<Record<string, Readonly<Record<HdQuality, VariantStatus>>>> = {
  sedan: { high: 'validated', ultra: 'validated' },
  coupe: { high: 'validated', ultra: 'experimental' },
  pickup: { high: 'experimental', ultra: 'experimental' },
  boxtruck: { high: 'experimental', ultra: 'experimental' },
  beater: { high: 'experimental', ultra: 'experimental' },
};

const offered = (car: string, q: HdQuality, experimental: boolean): boolean => !!HD_LOADERS[car] && (experimental || HD_STATUS[car]?.[q] === 'validated');

/** Cars with HD tiers: dynamic imports, so each car's rig data is its own chunk. */
const HD_LOADERS: Readonly<Record<string, Loader>> = {
  sedan: async (q) => (await import('./sedan')).sedanVariant(q),
  coupe: async (q) => (await import('./coupe')).coupeVariant(q),
  pickup: async (q) => (await import('./pickup')).pickupVariant(q),
  boxtruck: async (q) => (await import('./boxtruck')).boxtruckVariant(q),
  beater: async (q) => (await import('./beater')).beaterVariant(q),
};

/**
 * The car's rig at `quality`, falling back to the next lower tier the car
 * has. `standard` resolves the caller-supplied standard def (main already
 * has it; this module never imports rig data eagerly).
 */
export async function loadVehicleVariant(
  car: string,
  quality: PhysicsQuality,
  standard: () => Promise<VehicleVariant>,
  opts: { experimental?: boolean } = {},
): Promise<VehicleVariant> {
  const loader = HD_LOADERS[car];
  if (loader && quality !== 'standard') {
    for (const q of quality === 'ultra' ? (['ultra', 'high'] as const) : (['high'] as const)) {
      if (!offered(car, q, !!opts.experimental)) continue;
      const v = await loader(q);
      if (v) return v;
    }
  }
  return standard();
}

/** Tiers a car offers (UI): standard plus its validated HD tiers (or every HD tier with `experimental`). */
export function variantTiers(car: string, experimental = false): readonly PhysicsQuality[] {
  return ['standard', ...(['high', 'ultra'] as const).filter((q) => offered(car, q, experimental))];
}
