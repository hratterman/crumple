/**
 * World FX — P5 contract (U3; docs/CONTRACTS.md "P5 contracts" and the
 * "FX event → effect" table). Change only via that doc. Main thread only.
 *
 * PARTICLES (GPU-friendly pools): each pool is ONE draw — an
 * InstancedBufferGeometry ring buffer of SPAWN records (birth time, origin,
 * velocity, size, seed, colour/kind) written only when particles spawn
 * (addUpdateRange over the touched slice); the vertex shader evaluates
 * motion analytically from age (ballistic + drag + buoyant rise for smoke,
 * one analytic ground bounce for sparks/debris-sized bits at the spawn
 * ground height), size/alpha/colour over life, and kills by age. No per-
 * particle CPU work per frame. Total live particles ≤ QualityPreset
 * .particleBudget across pools (oldest recycled first). Pools: smoke/dust
 * (alpha-blended, lit by sun + env approximations, fogged), sparks (additive
 * HDR streaks, emissive ≤ FX_SPARK_MAX_RADIANCE so the sanitize clamp never
 * engages), splash/spray (alpha). Particles never cast shadows, never write
 * depth, and live on LAYER_NO_REFLECTION.
 * DEBRIS: rigid chunks (InstancedMesh per material group, ≤ 2 draws) with
 * CPU ballistic integration + terrain bounce (sampler) + settle + fade,
 * capped at QualityPreset.debrisBudget (oldest recycled).
 * SKIDMARKS: one draw; a capped ring of quad SEGMENTS (QualityPreset
 * .skidSegments) laid per wheel along the contact path, alpha fading with
 * age (FX_SKID_FADE_S) and recycled oldest-first; y = visual surface + FX_SKID_LIFT_M
 * where the visual surface is the terrain (sampler.heightAt) or, inside a
 * ribbon road's carriageway, terrain + RIBBON_LIFT_M; polygonOffset
 * (FX_SKID_POLYGON_OFFSET) beyond the ribbons' (−1, −1), depthWrite false,
 * receives no shadow lookups (cheap), LAYER_NO_REFLECTION.
 * Draw budget: ≤ FX_DRAW_BUDGET draws in the main pass, 0 in shadow passes.
 */
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../../protocol/events';
import type { PropInstance, PropSurface } from '../../sim/props/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { TerrainData, TerrainSampler, WaterBody } from '../../world/types';
import type { LightingStack, PatchMaterial, RenderContext, WorldLayerRenderer } from '../types';

/** What the MOVING contact is made of: a tyre, or the object's body surface (vehicles: 'metal'; props: PropDef.surface). */
export type FxSurface = PropSurface | 'tyre';

// Thresholds (contract numbers; the table in docs/CONTRACTS.md uses them).
/** Wheel slip (telemetry wheelSlip, m/s) above which a tyre smokes on hard ground. */
export const FX_TYRE_SMOKE_SLIP = 3;
/** Wheel slip above which a tyre leaves a skidmark on hard ground, m/s (with load ≥ FX_SKID_MIN_LOAD). */
export const FX_SKID_SLIP = 2;
/** On soft ground (grass/dirt/gravel) ruts start at this slip, m/s. */
export const FX_RUT_SLIP = 1;
export const FX_SKID_MIN_LOAD = 800;
/** Rooster-tail dust/spray from a rolling tyre on dirt/gravel above this ground speed, m/s. */
export const FX_DUST_SPEED = 6;
/** Spark threshold for a hard-surface impact of a metal/concrete body node, N·s. */
export const FX_SPARK_IMPULSE = 6;
/** Spark stream threshold for a body scrape (skid event of a non-tyre metal node), m/s, with load ≥ 100 N. */
export const FX_SCRAPE_SLIP = 2;
/** Soft-ground impact (grass/dirt/gravel) above this impulse throws a dirt clod puff, N·s. */
export const FX_CLOD_IMPULSE = 10;
/** A node entering water faster than this (downward, m/s) splashes; wading faster than FX_WAKE_SPEED sprays. */
export const FX_SPLASH_SPEED = 1.5;
export const FX_WAKE_SPEED = 2;
/** A skid/impact event within (tyre radius + this) of a wheel's hub midpoint is a TYRE contact. */
export const FX_TYRE_CLASSIFY_MARGIN = 0.15;
export const FX_SKID_LIFT_M = 0.008;
export const FX_SKID_POLYGON_OFFSET: readonly [number, number] = [-4, -4];
export const FX_SKID_FADE_S = 45;
export const FX_SPARK_MAX_RADIANCE = 40;
export const FX_DRAW_BUDGET = 8;

export interface FxStats {
  particles: number;
  debris: number;
  skidSegments: number;
  drawCalls: number;
}

/**
 * The FX system. Event handlers are called for EVERY object's events
 * (main.ts routes the whole drain here); they only enqueue spawns (no
 * allocation). update(frame) runs after the camera is final: per-wheel
 * skidmarks/smoke/dust from telemetry + tyre nodes of registered vehicles,
 * water splashes/wakes from frame.nodes vs the water bodies, debris
 * integration, pool uploads.
 */
export interface FxSystem extends WorldLayerRenderer {
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  /** R-GFX (additive): surface wetness / rain for tyre spray (lighting/environment.ts WeatherState). */
  setWeather?(w: { wetness: number; rain: number }): void;
  /** Per-wheel effects + tyre classification for this vehicle object (CompiledVehicle = what the worker compiled). */
  addVehicle(objectId: number, compiled: CompiledVehicle): void;
  /** Surface classes (and debris colours) for props; unknown objects count as 'metal'. */
  addProps(instances: readonly PropInstance[]): void;
  removeObject(objectId: number): void;
  /** Drop every live particle, debris chunk and skidmark (teleport, repair-all). */
  clear(): void;
  readonly stats: FxStats;
  // ---- P7 replay hooks (additive; docs/CONTRACTS.md "P7 contracts")
  /**
   * Drop live particles, debris and queued events and reset the emitters'
   * per-wheel accumulators, but KEEP the skidmarks (replay seek: the FX are
   * then re-run over recorded frames).
   */
  clearTransient(): void;
  /** Restart the FX random stream with `seed` (a re-run from the same frame spawns the same particles). */
  reseed(seed: number): void;
  /**
   * While frozen no skidmark / rut / burnout segment is laid (replay: the
   * live marks already cover the buffer; the shader hides marks born after
   * the current time, so they follow the playhead). Unfreezing restarts the
   * wheels' strips.
   */
  setSkidmarksFrozen(frozen: boolean): void;
  /**
   * P7 follow-up: the whole transient FX state (particle pools, debris,
   * emitter accumulators, clocks) — replay entry snapshots it and exit
   * restores it verbatim, so leaving the replay shows exactly the FX of the
   * moment it was entered. Skidmarks are not part of it (frozen while
   * replaying). Opaque; `into` is reused when it fits.
   */
  saveState(into?: FxState | null): FxState;
  restoreState(s: FxState): void;
  /** Hide the debris chunks (reverse playback: they cannot run backwards; a settled seek re-creates them). */
  setDebrisHidden(hidden: boolean): void;
}
/** Opaque FxSystem.saveState snapshot. */
export interface FxState {
  readonly kind: 'fx';
}
export interface FxOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  sampler: TerrainSampler;
  /** Road profiles (ribbon carriageway test for skidmark height) and material map. */
  terrain: TerrainData;
  water: readonly WaterBody[];
  /** Latest telemetry block of an object (SimClient.telemetry), or null. */
  telemetry(objectId: number): Float32Array | null;
}
/** U3: src/render/fx/index.ts. */
export type CreateFxSystem = (ctx: RenderContext, opts: FxOptions) => FxSystem;
