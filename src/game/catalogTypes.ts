/**
 * Vehicle catalog TYPES + palette helpers (P6 contract). Split from
 * catalog.ts so the per-vehicle entry files (./vehicles/*.ts) can import
 * them without an import cycle through the aggregate.
 */
import type { PaintDef, VehicleVisualDef } from '../render/vehicle/types';
import type { VehicleDef } from '../sim/vehicle/types';

export type VehicleId = 'sedan' | 'coupe' | 'pickup' | 'boxtruck' | 'beater' | 'sedanTraffic';

/** Showroom order (player-selectable vehicles). */
export const PLAYER_VEHICLE_IDS: readonly VehicleId[] = ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater'];
export const DEFAULT_VEHICLE_ID: VehicleId = 'sedan';

export type Drivetrain = 'RWD' | 'FWD' | 'AWD';

/**
 * Spec card (showroom). Numbers are the BUILT vehicle's: each fleet unit's
 * tests assert massKg within 2 % of compileVehicle(sim).totalMass, powerKw
 * within 3 % of max(torque·rpm) of the torque curve, torqueNm = the curve's
 * peak, drivetrain = the driven wheels, and topSpeedKmh / zeroTo100S within
 * 5 % of the handling harness (null = not measured: the box truck's 0–100).
 */
export interface VehicleStatsCard {
  /** Display name ("Vela GT"); fictional marque, never a real brand. */
  name: string;
  /** Class line ("Sport sedan"). */
  class: string;
  /** One sentence for the card. */
  blurb: string;
  engine: string;
  gearbox: string;
  drivetrain: Drivetrain;
  powerKw: number;
  torqueNm: number;
  massKg: number;
  topSpeedKmh: number;
  zeroTo100S: number | null;
  /** 1..5 bars on the card. */
  ratings: { speed: number; handling: number; toughness: number };
}

export interface PaintPalette {
  /** Stable id (persisted). */
  id: string;
  name: string;
  paint: PaintDef;
}

export interface VehicleAssets {
  sim: VehicleDef;
  /** LOD0 visual def; its LOD1/LOD2 + follow extras are registered by its module (lods.ts setVisualExtras). */
  visual: VehicleVisualDef;
}

export interface VehicleCatalogEntry {
  id: VehicleId;
  /** false until the vehicle's unit lands its defs: load() rejects, the showroom shows the card as "in the workshop". */
  available: boolean;
  /** Player-selectable in the showroom. */
  selectable: boolean;
  /** May be a traffic variant (requires a rig ≤ TRAFFIC_BEAM_BUDGET 1500 beams). P6: only sedanTraffic. */
  trafficEligible: boolean;
  stats: VehicleStatsCard;
  /** ≥ 4 entries; palettes[0].paint equals the visual def's own `paint`. */
  palettes: readonly PaintPalette[];
  /** validateVehicle budget the def must meet (PLAYER 3500 / TRAFFIC 1500 / tighter per-vehicle targets). */
  beamBudget: number;
  /** Chase-camera framing (ChaseOptions.distance / height at rest, m). */
  chase: { distance: number; height: number };
  /** Rig-local AABB of the rest body incl. wheels, m (showroom turntable framing, spawn clearance). */
  extent: { min: [number, number, number]; max: [number, number, number] };
  load(): Promise<VehicleAssets>;
}

/**
 * PERSISTENCE (S1): localStorage key VEHICLE_CHOICE_KEY = JSON
 * VehicleChoice. Unknown / unavailable ids fall back to DEFAULT_VEHICLE_ID,
 * unknown palette ids to palettes[0]. Read at boot (the spawned vehicle),
 * written on every confirmed choice. Storage errors are ignored.
 */
export const VEHICLE_CHOICE_KEY = 'crumple.vehicle.v1';
export interface VehicleChoice {
  id: VehicleId;
  palette: string;
}

/** Placeholder loader for entries whose unit has not landed yet. */
export function notYetBuilt(id: VehicleId): () => Promise<VehicleAssets> {
  return () => Promise.reject(new Error(`vehicle '${id}' is not built yet (P6 fleet unit pending)`));
}

/** Small helper for palette tables. */
export function solidPaint(color: number, roughness = 0.42, clearcoat = 0.8): PaintDef {
  return { color, metallic: 0, roughness, clearcoat, clearcoatRoughness: 0.06, flake: null };
}
export function metallicPaint(color: number, metallic = 0.65, flake = 0.6, pearl = 0): PaintDef {
  return {
    color,
    metallic,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    flake: { density: flake, scale: 0.6, intensity: flake },
    ...(pearl > 0 ? { pearl } : {}),
  };
}
