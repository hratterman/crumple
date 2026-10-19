/**
 * VEHICLE CATALOG (P6 contract; docs/CONTRACTS.md "P6 contracts").
 *
 * The one place main-thread code (showroom, player spawn, traffic) learns
 * which vehicles exist. Each entry lives in its own file under
 * ./vehicles/<id>.ts, OWNED by the unit that builds that vehicle; this file
 * only aggregates them and never changes when a vehicle lands.
 *
 * An entry is static metadata (spec card, palettes, budgets, camera
 * framing) plus `load()`, a DYNAMIC import of the vehicle's two pure data
 * modules — the sim rig def (src/sim/vehicle/defs/<id>.ts, sent to the
 * worker in `spawnVehicle` / `setTraffic`) and the visual def
 * (src/render/vehicle/defs/<id>.ts, which registers its LOD/follow extras on
 * import) — so the five fleets do not land in the app chunk (≤ 500 kB).
 *
 * Main-only (imports render types); the worker never sees the catalog: it
 * receives plain VehicleDefs.
 */
import { BEATER_ENTRY } from './vehicles/beater';
import { BOXTRUCK_ENTRY } from './vehicles/boxtruck';
import { COUPE_ENTRY } from './vehicles/coupe';
import { PICKUP_ENTRY } from './vehicles/pickup';
import { SEDAN_ENTRY } from './vehicles/sedan';
import { SEDAN_TRAFFIC_ENTRY } from './vehicles/sedanTraffic';
import type { PaintPalette, VehicleCatalogEntry, VehicleId } from './catalogTypes';

export * from './catalogTypes';

export const VEHICLE_CATALOG: Readonly<Record<VehicleId, VehicleCatalogEntry>> = {
  sedan: SEDAN_ENTRY,
  coupe: COUPE_ENTRY,
  pickup: PICKUP_ENTRY,
  boxtruck: BOXTRUCK_ENTRY,
  beater: BEATER_ENTRY,
  sedanTraffic: SEDAN_TRAFFIC_ENTRY,
};

export function isVehicleId(x: unknown): x is VehicleId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(VEHICLE_CATALOG, x);
}

export function getVehicleEntry(id: VehicleId): VehicleCatalogEntry {
  return VEHICLE_CATALOG[id];
}

/** Catalog entries usable as traffic variants right now (available + trafficEligible), catalog order. */
export function trafficVariantEntries(): VehicleCatalogEntry[] {
  return Object.values(VEHICLE_CATALOG).filter((e) => e.available && e.trafficEligible);
}

/** The palette with `paletteId`, else palettes[0]. */
export function paletteOf(entry: VehicleCatalogEntry, paletteId: string | null | undefined): PaintPalette {
  return entry.palettes.find((p) => p.id === paletteId) ?? entry.palettes[0]!;
}
