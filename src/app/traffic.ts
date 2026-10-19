/**
 * AI traffic, main side (P6 seam; OWNER T2 — this file is a pre-wired STUB
 * that T2 replaces, keeping `TrafficController` and the factory signature;
 * main.ts already calls every member). docs/CONTRACTS.md "P6 contracts".
 *
 * Responsibilities (T2):
 *  - start(): load the catalog's traffic variants (trafficVariantEntries():
 *    sim def + visual def), send `client.setTraffic({enabled, seed,
 *    variants, density: preset.traffic, focusObjectId})`, and on
 *    `trafficReady` build per variant (a) the GHOST instances — rigid
 *    InstancedMeshes of the variant's LOD1 and LOD2 bodies + wheels, baked
 *    by evaluating the flexbody binding at the SETTLED template nodes
 *    (TrafficTemplate.settled, rig-local), so ghost and soft body agree —
 *    and (b) a pool of `density.maxAwake` hidden VehicleVisuals (created +
 *    compiled up front; never at promotion time).
 *  - update(frame): client.readTrafficAgents(frame.simTime, …); ghosts →
 *    instance matrices (pose · template; front-wheel yaw from steer, wheel
 *    spin from speed), awake agents with `nodesReady` → a pooled visual fed
 *    like the player's (nodes, broken bits, epoch, telemetry, camera) with
 *    `lights` from the AI flags (brake, indicators blinking
 *    TRAFFIC_BLINK_ON_S/OFF_S, hazards, headlights); the hand-over swaps
 *    instance ⇄ visual in the same frame (no pop); per-agent paint from the
 *    record's paint index (setPaint on the pooled visual; instance colour).
 *    Registers awake objects with FX (fx.addVehicle / removeObject).
 *  - governor: if client.workerLoad > 0.8 for 2 s, setTrafficDensity with
 *    maxAwake − 1 (≥ 1); back up (≤ the preset) after 10 s below 0.55.
 *  - setQuality(q): setTrafficDensity(q.traffic) when it changed.
 * Ghosts never cast into CSM cascades ≥ 1; LOD by camera distance
 * (lods.ts), ≤ 2 draws per (variant, LOD, slot group).
 */
import { Group, type Object3D } from 'three';

import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';
import { isTrafficObjectId } from '../protocol/traffic';
import type { FxSystem } from '../render/fx/types';
import type { LightingStack, PatchMaterial, QualityPreset, RenderContext, WorldFrame } from '../render/types';
import type { TerrainSampler } from '../world/types';
import type { SimClient } from './simClient';

export interface TrafficControllerDeps {
  client: SimClient;
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  fx: FxSystem | null;
  sampler: TerrainSampler;
  /** The vehicle the awake bubble follows (the player). */
  focusObjectId: number;
}

export interface TrafficController {
  /** Add to the scene by the caller. */
  readonly object: Object3D;
  /**
   * Configures traffic in the worker and builds the render resources.
   * Resolves true once traffic runs, false when it cannot (no available
   * traffic variant, the worker rejects or does not implement it). Call
   * after the focus vehicle's spawn. Calling again restarts traffic (new
   * seed). A player-vehicle swap needs no restart: the focus stays
   * objectId 1 (while it is despawned the worker promotes nobody).
   */
  start(seed: number): Promise<boolean>;
  /** Per frame, after the camera (LOD) and before FX. */
  update(frame: WorldFrame): void;
  setQuality(q: QualityPreset): void;
  /** True for awake traffic objectIds (event routing). */
  owns(objectId: number): boolean;
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  dispose(): void;
}

/** STUB (T2 replaces): no traffic, every member a no-op. */
export function createTrafficController(_ctx: RenderContext, _deps: TrafficControllerDeps): TrafficController {
  const object = new Group();
  object.name = 'traffic';
  return {
    object,
    start: () => Promise.resolve(false),
    update() {},
    setQuality() {},
    owns: isTrafficObjectId,
    onImpact() {},
    onBeamBreak() {},
    onSkid() {},
    dispose() {
      object.removeFromParent();
    },
  };
}
