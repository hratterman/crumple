/**
 * FX rules (pure, no three): surface classes, the docs/CONTRACTS.md
 * "FX event → effect" decisions, emission rates, skid strengths and colour
 * palettes. Everything here is unit-tested; index.ts only wires it to the
 * pools.
 */
import { MaterialId } from '../../protocol/messages';
import type { PropSurface } from '../../sim/props/types';
import {
  FX_CLOD_IMPULSE,
  FX_DUST_SPEED,
  FX_RUT_SLIP,
  FX_SCRAPE_SLIP,
  FX_SKID_MIN_LOAD,
  FX_SKID_SLIP,
  FX_SPARK_IMPULSE,
  FX_TYRE_SMOKE_SLIP,
  type FxSurface,
} from './types';

// ------------------------------------------------------------------ surfaces
/** Mover surface codes (compact, typed-array friendly). 0 = unknown → metal. */
export const SURF_METAL = 0;
export const SURF_PLASTIC = 1;
export const SURF_RUBBER = 2;
export const SURF_CARDBOARD = 3;
export const SURF_WOOD = 4;
export const SURF_CONCRETE = 5;
export const SURF_TYRE = 6;
export const SURFACE_CODES: Readonly<Record<FxSurface, number>> = {
  metal: SURF_METAL,
  plastic: SURF_PLASTIC,
  rubber: SURF_RUBBER,
  cardboard: SURF_CARDBOARD,
  wood: SURF_WOOD,
  concrete: SURF_CONCRETE,
  tyre: SURF_TYRE,
};
export function surfaceCode(s: PropSurface): number {
  return SURFACE_CODES[s];
}

/** Ground class of a MaterialId: 'hard' paved/rock/metal, 'soft' grass/dirt/gravel, 'object' 7..10. */
export const GROUND_HARD = 0;
export const GROUND_SOFT = 1;
export const GROUND_OBJECT = 2;
export function groundClass(materialId: number): number {
  switch (materialId) {
    case MaterialId.grass:
    case MaterialId.dirt:
    case MaterialId.gravel:
      return GROUND_SOFT;
    case MaterialId.plastic:
    case MaterialId.rubber:
    case MaterialId.wood:
    case MaterialId.cardboard:
      return GROUND_OBJECT;
    default:
      return GROUND_HARD; // asphalt, rock, concrete, metal (and unknown ids)
  }
}
/** Mover surface of an object material (7..10) when it is the OTHER side of a contact. */
export function objectMaterialSurface(materialId: number): number {
  switch (materialId) {
    case MaterialId.plastic:
      return SURF_PLASTIC;
    case MaterialId.rubber:
      return SURF_RUBBER;
    case MaterialId.wood:
      return SURF_WOOD;
    case MaterialId.cardboard:
      return SURF_CARDBOARD;
    case MaterialId.concrete:
    case MaterialId.rock:
      return SURF_CONCRETE;
    default:
      return SURF_METAL;
  }
}
/** Sparks need a metal (or concrete) mover. */
export function sparkingSurface(s: number): boolean {
  return s === SURF_METAL || s === SURF_CONCRETE;
}

// ------------------------------------------------------------------ decisions
/** Impact effect ids. */
export const IMPACT_NONE = 0;
export const IMPACT_SPARKS = 1;
export const IMPACT_CLOD = 2;
export const IMPACT_CHIPS = 3;

/**
 * Contract table, impact rows. `mover` = surface code of the moving object
 * (SURF_TYRE for tyre contacts), `materialId` = what it hit.
 */
export function impactEffect(mover: number, materialId: number, impulse: number): number {
  const g = groundClass(materialId);
  if (g === GROUND_SOFT) return impulse >= FX_CLOD_IMPULSE ? IMPACT_CLOD : IMPACT_NONE;
  if (impulse < FX_SPARK_IMPULSE) return IMPACT_NONE;
  if (mover === SURF_TYRE) return IMPACT_NONE;
  if (g === GROUND_OBJECT) return IMPACT_CHIPS; // a soft-material object was hit: its chips
  if (sparkingSurface(mover)) return IMPACT_SPARKS;
  return IMPACT_CHIPS;
}

/** Skid (scrape) effect ids for NON-tyre movers. */
export const SCRAPE_NONE = 0;
export const SCRAPE_SPARKS = 1;
export const SCRAPE_DUST = 2;
export const SCRAPE_CHIPS = 3;
export function scrapeEffect(mover: number, materialId: number, slip: number, load: number): number {
  if (mover === SURF_TYRE) return SCRAPE_NONE;
  const g = groundClass(materialId);
  if (g === GROUND_SOFT) return SCRAPE_DUST;
  if (sparkingSurface(mover)) {
    if (g === GROUND_HARD && slip >= FX_SCRAPE_SLIP && load >= 100) return SCRAPE_SPARKS;
    return slip >= FX_SCRAPE_SLIP ? SCRAPE_DUST : SCRAPE_NONE;
  }
  return slip >= FX_SCRAPE_SLIP ? SCRAPE_CHIPS : SCRAPE_NONE;
}

/** Per-wheel effect flags from telemetry (bit set). */
export const WHEEL_SMOKE = 1;
export const WHEEL_SKID = 2;
export const WHEEL_RUT = 4;
export const WHEEL_SPRAY = 8;
export const WHEEL_ROOST = 16;
export function wheelEffects(materialId: number, slip: number, load: number, groundSpeed: number, contact: boolean): number {
  if (!contact) return 0;
  const g = groundClass(materialId);
  let f = 0;
  if (g === GROUND_SOFT) {
    if (slip >= FX_RUT_SLIP) f |= WHEEL_RUT | WHEEL_SPRAY;
    if (materialId !== MaterialId.grass && groundSpeed >= FX_DUST_SPEED) f |= WHEEL_ROOST;
  } else {
    if (slip >= FX_TYRE_SMOKE_SLIP) f |= WHEEL_SMOKE;
    if (slip >= FX_SKID_SLIP && load >= FX_SKID_MIN_LOAD) f |= WHEEL_SKID;
  }
  return f;
}

// ------------------------------------------------------------------ rates
/** Reference wheel load, N (a sedan corner at rest ≈ 3.5 kN). */
export const REF_LOAD = 3500;
/** Tyre smoke particles per sim second per wheel at budget 3000 (rate ∝ (slip − 3)·load). */
export function smokeRate(slip: number, load: number): number {
  const x = slip - FX_TYRE_SMOKE_SLIP;
  if (x <= 0) return 0;
  const l = Math.min(Math.max(load / REF_LOAD, 0.25), 1.8);
  return Math.min(1.6 * x * l * 2.7, 128);
}
/** Skid mark coverage 0..1 (∝ slip·load, from 0 at the threshold, saturating). */
export function skidStrength(slip: number, load: number): number {
  const s = (slip - FX_SKID_SLIP) / 8;
  if (s <= 0) return 0;
  const l = Math.min(Math.max(0.4 + (0.6 * load) / REF_LOAD, 0), 1.2);
  return Math.min(Math.pow(Math.min(s, 1), 0.75) * l, 1);
}
export function rutStrength(slip: number, load: number): number {
  const s = (slip - FX_RUT_SLIP) / 5;
  if (s <= 0) return 0;
  return Math.min(1, 0.35 + 0.65 * Math.min(s, 1)) * Math.min(Math.max(load / REF_LOAD, 0.4), 1.2);
}
/** Rooster-tail dust per sim second per wheel (∝ speed). */
export function roostRate(groundSpeed: number, slip: number): number {
  const x = groundSpeed - FX_DUST_SPEED;
  if (x <= 0) return 0;
  return Math.min(4 + x * 2.2 + slip * 2.5, 70);
}
/** Spray (clods + dust) per sim second per wheel on soft ground (∝ slip). */
export function sprayRate(slip: number): number {
  const x = slip - FX_RUT_SLIP;
  if (x <= 0) return 0;
  return Math.min(6 + x * 7, 90);
}
/** Sparks in an impact burst (∝ impulse). */
export function sparkBurstCount(impulse: number): number {
  return Math.min(Math.round(6 + impulse * 1.2), 90);
}

/**
 * Swept width of a sliding contact patch, m: a tyre rolling straight lays its
 * tread width; sliding sideways it lays the patch LENGTH. `ax, az` = axle
 * (horizontal unit), `mx, mz` = path direction (horizontal unit).
 */
export function sweptWidth(treadWidth: number, patchLength: number, ax: number, az: number, mx: number, mz: number): number {
  // m⊥ = (−mz, mx); |a·m⊥| = |cos| between axle and path normal, |h·m⊥| = |a·m|.
  const am = Math.abs(ax * mx + az * mz);
  const aperp = Math.abs(-ax * mz + az * mx);
  return treadWidth * aperp + patchLength * am;
}

// ------------------------------------------------------------------ palettes (linear RGB)
export type Rgb = readonly [number, number, number];
/** Dust colour per terrain material (soft grounds; hard grounds give pale grey). */
export function dustColor(materialId: number): Rgb {
  switch (materialId) {
    case MaterialId.dirt:
      return [0.42, 0.31, 0.21];
    case MaterialId.gravel:
      return [0.46, 0.42, 0.36];
    case MaterialId.grass:
      return [0.34, 0.3, 0.2];
    default:
      return [0.5, 0.48, 0.45];
  }
}
/** Clod / grit colour per terrain material. */
export function clodColor(materialId: number): Rgb {
  switch (materialId) {
    case MaterialId.dirt:
      return [0.16, 0.1, 0.06];
    case MaterialId.gravel:
      return [0.3, 0.28, 0.25];
    case MaterialId.grass:
      return [0.09, 0.13, 0.04];
    default:
      return [0.22, 0.21, 0.2];
  }
}
/** Rut multiplier tint (multiplied onto the lit ground). */
export function rutTint(materialId: number): Rgb {
  switch (materialId) {
    case MaterialId.dirt:
      return [0.5, 0.42, 0.36];
    case MaterialId.gravel:
      return [0.62, 0.58, 0.54];
    case MaterialId.grass:
      return [0.6, 0.48, 0.36];
    default:
      return [0.55, 0.5, 0.45];
  }
}
/** Chip / debris colour of a mover surface (vehicles pass their paint for metal). */
export function surfaceColor(s: number, rand: number): Rgb {
  switch (s) {
    case SURF_PLASTIC:
      return rand < 0.6 ? [0.85, 0.22, 0.02] : [0.9, 0.88, 0.85]; // cone orange / white band
    case SURF_RUBBER:
      return [0.025, 0.025, 0.028];
    case SURF_CARDBOARD:
      return [0.42, 0.28, 0.14];
    case SURF_WOOD:
      return rand < 0.5 ? [0.45, 0.3, 0.16] : [0.62, 0.46, 0.27];
    case SURF_CONCRETE:
      return [0.42, 0.41, 0.39];
    default:
      return [0.3, 0.31, 0.33];
  }
}
/** Body paint per compiled vehicle name (debris chips); unknown → mid grey. */
export const VEHICLE_PAINT: Readonly<Record<string, number>> = {
  sedan: 0x1f4f9a,
};
