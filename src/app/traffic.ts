/**
 * AI traffic, main side (P6 T2; docs/CONTRACTS.md "P6 contracts"). The
 * worker owns the traffic (route network, driver model, awake ⇄ ghost
 * scheduler); this controller configures it and DRAWS it:
 *
 *  - start(): loads the catalog's traffic variants, sends `setTraffic`
 *    (density = the quality preset scaled by the player's traffic setting,
 *    whatever setQuality said last), and on `trafficReady` bakes each
 *    variant's GHOST meshes (render/traffic/bake.ts: the flexbody LOD1/LOD2
 *    bindings evaluated at the SETTLED template) and builds a pool of
 *    soft-body VehicleVisuals (maxAwake of the preset; created up front, one
 *    per frame, never at promotion time).
 *  - update(frame): every agent record (interpolated by SimClient) is drawn
 *    either as a rigid ghost instance (render/traffic/ghosts.ts: a few
 *    instanced draws for all of them, wheels rolling + steering, palette
 *    paint, AI lamps) or — once its awake object is in BOTH interpolation
 *    snapshots (`nodesReady`) — by a pooled soft-body visual fed like the
 *    player's. The swap happens in one frame in both directions: the soft
 *    body starts exactly at pose · template (T1) and the ghost is that
 *    template under the same calibration, so there is no pop. An awake car
 *    without a free visual (pool still building) stays a rigid instance.
 *  - lamps: AI intent flags → brake lamps, indicators (blinking), hazards,
 *    headlights; the same LightState for ghost and soft body.
 *  - governor: worker load > 0.8 for 2 s → one fewer awake car (≥ 1),
 *    < 0.55 for 10 s → one more (≤ the preset), via setTrafficDensity.
 */
import { Color, Group, Matrix4, Quaternion, Vector3, type Object3D } from 'three';

import { trafficVariantEntries, type VehicleCatalogEntry } from '../game/catalog';
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';
import { createVehicleTelemetryFrame } from '../protocol/telemetry';
import {
  createTrafficAgentFrame,
  isTrafficObjectId,
  TRAFFIC_FLAG_AWAKE,
  TRAFFIC_MAX_AGENTS,
  type TrafficAgentFrame,
  type TrafficDensity,
} from '../protocol/traffic';
import type { FxSystem } from '../render/fx/types';
import { bakeGhostBody, bakeGhostWheel, ghostNodes, ghostWheels, settleOffsets } from '../render/traffic/bake';
import { createGhostFleet, type GhostFleet, type GhostInstance, type GhostVariantMeshes } from '../render/traffic/ghosts';
import { TrafficGovernor } from '../render/traffic/governor';
import { trafficLights } from '../render/traffic/intent';
import type { LightingStack, PatchMaterial, QualityPreset, RenderContext, SimObjectSlice, WorldFrame } from '../render/types';
import { createVehicleVisual, type VehicleVisualHandle } from '../render/vehicle/index';
import { lodDistance, selectVehicleLod } from '../render/vehicle/lods';
import { createLightState } from '../render/vehicle/materials';
import type { LightState, VehicleFrameInput } from '../render/vehicle/types';
import type { TerrainSampler } from '../world/types';
import { loadPlayerAssets, type PlayerAssets } from './player';
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
  /** An awake traffic object's events: its visual's damage, and world FX (main does not send them to FX itself). */
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  dispose(): void;
}

/** Diagnostics (tests, `__crumple.debug.traffic.stats`). */
export interface TrafficStats {
  running: boolean;
  agents: number;
  ghosts: number;
  /** Awake agents drawn by a soft-body visual this frame. */
  softBodies: number;
  /** Awake agents drawn as rigid instances (not in both snapshots yet, or no free visual). */
  awakeRigid: number;
  pool: number;
  /** Ghost draws in the main pass this frame. */
  ghostDraws: number;
  maxAwake: number;
  workerLoad: number;
  /** Hand-overs since start (ghost → soft body, soft body → ghost). */
  promotions: number;
  demotions: number;
}

interface PooledVisual {
  handle: VehicleVisualHandle;
  frame: VehicleFrameInput;
  broken: Uint8Array;
  telemetry: ReturnType<typeof createVehicleTelemetryFrame>;
  lights: LightState;
  agent: number;
  objectId: number;
  assignments: number;
  used: boolean;
  brokenTick: number;
  /** Sim time from which the object is registered with FX (see FX_DELAY_S); NaN once registered. */
  fxAt: number;
}

/**
 * Wheel FX (smoke, skids) start this long after a promotion: the fresh soft
 * body's tyres settle onto the road in the first instants (slip transient)
 * and would puff smoke at the hand-over.
 */
const FX_DELAY_S = 0.6;

interface VariantRuntime {
  entry: VehicleCatalogEntry;
  assets: PlayerAssets;
  offsets: Float32Array;
  paints: { color: Color; metalness: number }[];
  pool: PooledVisual[];
  maxSteerRad: number;
}

export function createTrafficController(ctx: RenderContext, deps: TrafficControllerDeps): TrafficController {
  const object = new Group();
  object.name = 'traffic';
  const { client } = deps;

  let density: TrafficDensity = { ...ctx.quality.traffic };
  const governor = new TrafficGovernor(density.maxAwake);
  let variants: VariantRuntime[] = [];
  let fleet: GhostFleet | null = null;
  let running = false;
  let generation = 0;
  const agents: TrafficAgentFrame[] = [];
  for (let i = 0; i < TRAFFIC_MAX_AGENTS; i++) agents.push(createTrafficAgentFrame());
  const lodPrev = new Int8Array(TRAFFIC_MAX_AGENTS).fill(-1);
  const spin = new Float64Array(TRAFFIC_MAX_AGENTS);
  const wasSoft = new Uint8Array(TRAFFIC_MAX_AGENTS);
  let lastSimTime = NaN;
  /** Per agent: last mode (0 ghost, 1 awake) and the snapshot tick it changed at. */
  const lastMode = new Int8Array(TRAFFIC_MAX_AGENTS).fill(-1);
  const modeTick = new Float64Array(TRAFFIC_MAX_AGENTS).fill(-1);
  /** Debug: draw awake cars as rigid instances too (hand-over comparisons). */
  let forceGhost = false;
  /** Debug: AI flags OR-ed into every agent's lamps (lamp checks; 0 = off). */
  let debugFlags = 0;

  const stats: TrafficStats = {
    running: false,
    agents: 0,
    ghosts: 0,
    softBodies: 0,
    awakeRigid: 0,
    pool: 0,
    ghostDraws: 0,
    maxAwake: density.maxAwake,
    workerLoad: 0,
    promotions: 0,
    demotions: 0,
  };

  const ghost: GhostInstance = {
    variant: 0,
    lod: 2,
    pose: new Matrix4(),
    paint: new Color(),
    metalness: 0,
    head: 0,
    brake: 0,
    indL: 0,
    indR: 0,
    yaw: 0,
    spin: 0,
  };
  const ghostLights = createLightState();
  const _p = new Vector3();
  const _q = new Quaternion();
  const _s = new Vector3(1, 1, 1);
  const _cam = new Vector3();
  const _fwd = new Vector3();

  function sendDensity(): void {
    if (!running) return;
    client.setTrafficDensity({ ...density, maxAwake: Math.min(density.maxAwake, governor.maxAwake) });
  }

  function groundAt(x: number, z: number): number {
    return deps.sampler.heightAt(x, z);
  }

  function createPooled(v: VariantRuntime): PooledVisual {
    const handle = createVehicleVisual(ctx, v.assets.compiled, v.assets.visual, {
      lighting: deps.lighting,
      patchMaterial: deps.patchMaterial,
      groundAt,
    });
    // Preset the static-sag calibration from the settled template (bake.ts): the soft body
    // and its ghost then show the same calibrated body from the first frame.
    const settle = handle.skin.settle;
    if (settle) {
      settle.offset.set(v.offsets.subarray(0, settle.offset.length));
      settle.calibrated = true;
      (settle as unknown as { fade: number }).fade = 1;
    }
    handle.object.visible = false;
    handle.object.name = `trafficVisual:${v.entry.id}`;
    object.add(handle.object);
    const broken = new Uint8Array(v.assets.compiled.rig.beamCount);
    return {
      handle,
      broken,
      telemetry: createVehicleTelemetryFrame(),
      lights: createLightState(),
      frame: { nodes: new Float32Array(0), nodeOffset: 0, tick: 0, broken, repairEpoch: 0, telemetry: null, dtS: 0 },
      agent: -1,
      objectId: 0,
      assignments: 0,
      used: false,
      brokenTick: -1,
      fxAt: NaN,
    };
  }

  function release(pv: PooledVisual): void {
    if (pv.objectId && Number.isNaN(pv.fxAt)) deps.fx?.removeObject(pv.objectId);
    pv.fxAt = NaN;
    if (pv.agent >= 0) wasSoft[pv.agent] = 0;
    pv.agent = -1;
    pv.objectId = 0;
    pv.handle.object.visible = false;
  }

  function teardown(): void {
    running = false;
    stats.running = false;
    generation++;
    for (const v of variants) {
      for (const pv of v.pool) {
        release(pv);
        pv.handle.dispose();
      }
    }
    variants = [];
    fleet?.dispose();
    fleet = null;
  }

  /** Grows each variant's pool to the preset's maxAwake, one visual per frame (never at promotion time). */
  let filling = false;
  /** Grows each variant's pool to the preset's maxAwake, one visual per frame (never at promotion time). */
  async function fillPools(): Promise<void> {
    if (filling) return;
    filling = true;
    try {
      for (;;) {
        if (!running) return;
        const v = variants.find((x) => x.pool.length < density.maxAwake);
        if (!v) return;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (!running || !variants.includes(v) || v.pool.length >= density.maxAwake) continue;
        try {
          v.pool.push(createPooled(v));
        } catch (e) {
          console.error('[traffic] soft-body visual failed; awake cars stay rigid', e);
          return;
        }
        stats.pool = variants.reduce((a, x) => a + x.pool.length, 0);
      }
    } finally {
      filling = false;
    }
  }

  function findRange(objects: readonly SimObjectSlice[], id: number): SimObjectSlice | null {
    let lo = 0;
    let hi = objects.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const o = objects[mid]!;
      if (o.objectId === id) return o;
      if (o.objectId < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  function acquire(v: VariantRuntime, a: TrafficAgentFrame, simTime: number): PooledVisual | null {
    for (const pv of v.pool) {
      if (pv.agent === a.agent && pv.objectId === a.objectId) return pv;
    }
    const pv = v.pool.find((x) => x.agent < 0);
    if (!pv) return null;
    pv.agent = a.agent;
    pv.objectId = a.objectId;
    pv.assignments++;
    pv.brokenTick = -1;
    const palette = v.entry.palettes[a.paint % v.entry.palettes.length]!;
    pv.handle.setPaint(palette.paint);
    pv.fxAt = simTime + FX_DELAY_S;
    return pv;
  }

  function bound(objectId: number): PooledVisual | null {
    for (const v of variants) for (const pv of v.pool) if (pv.objectId === objectId && pv.agent >= 0) return pv;
    return null;
  }

  function feed(pv: PooledVisual, a: TrafficAgentFrame, range: SimObjectSlice, frame: WorldFrame): void {
    const tick = client.latestTick;
    if (tick !== pv.brokenTick) {
      pv.brokenTick = tick;
      if (client.brokenBeams(a.objectId, pv.broken) < 0) pv.broken.fill(0);
    }
    const f = pv.frame;
    f.nodes = frame.nodes;
    f.nodeOffset = range.nodeOffset;
    f.tick = tick;
    // A pooled visual is a new car on every assignment: its damage / FX restart.
    f.repairEpoch = pv.assignments * 65536 + client.repairEpoch(a.objectId);
    f.telemetry = client.readTelemetry(a.objectId, pv.telemetry) ? pv.telemetry : null;
    f.dtS = frame.dtS;
    f.camera = frame.camera;
    f.lights = trafficLights(a.flags | debugFlags, a.brake, a.agent, frame.time, pv.lights);
    pv.handle.update(f);
  }

  function drawGhost(v: VariantRuntime, vi: number, a: TrafficAgentFrame, frame: WorldFrame): void {
    if (!fleet) return;
    _p.set(a.pos[0], a.pos[1], a.pos[2]);
    _q.set(a.quat[0], a.quat[1], a.quat[2], a.quat[3]);
    if (client.latestTick === modeTick[a.agent]) {
      // The record changed mode (ghost ⇄ awake) in the latest snapshot, so SimClient could not
      // interpolate it: it is the LATEST pose, up to one snapshot ahead of the render time.
      // Step it back along the heading so the hand-over frames do not jump forward.
      const back = Math.max(0, Math.min(0.05, client.simTime - frame.simTime)) * a.speed;
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      _p.addScaledVector(_fwd, -back);
    }
    ghost.pose.compose(_p, _q, _s);
    const d = lodDistance(_p.distanceTo(_cam), frame.camera.fov);
    const lod = selectVehicleLod(lodPrev[a.agent]!, d);
    lodPrev[a.agent] = lod;
    ghost.variant = vi;
    ghost.lod = lod >= 2 ? 2 : 1;
    const paint = v.paints[a.paint % v.paints.length]!;
    ghost.paint.copy(paint.color);
    ghost.metalness = paint.metalness;
    const ls = trafficLights(a.flags | debugFlags, a.brake, a.agent, frame.time, ghostLights);
    ghost.head = ls.head ? 1 : 0;
    ghost.brake = ls.brake;
    ghost.indL = ls.indicatorL ? 1 : 0;
    ghost.indR = ls.indicatorR ? 1 : 0;
    // steer +1 = right: the wheel's heading turns from −Z toward +X (a negative yaw about +Y).
    ghost.yaw = -a.steer * v.maxSteerRad;
    ghost.spin = spin[a.agent]!;
    fleet.push(ghost);
  }

  /** Records drawn last frame (tests / console): agent, objectId, flags, state, pos, speed, steer. */
  function snapshot(): { agent: number; objectId: number; flags: number; state: number; pos: number[]; quat: number[]; speed: number; steer: number; soft: boolean }[] {
    const out = [];
    for (let i = 0; i < stats.agents; i++) {
      const a = agents[i]!;
      out.push({ agent: a.agent, objectId: a.objectId, flags: a.flags, state: a.state, pos: [...a.pos], quat: [...a.quat], speed: a.speed, steer: a.steer, soft: wasSoft[a.agent] === 1 });
    }
    return out;
  }

  const controller: TrafficController & { readonly stats: TrafficStats; readonly density: TrafficDensity; snapshot: typeof snapshot; forceGhost: boolean; debugFlags: number } = {
    object,
    stats,
    snapshot,
    get forceGhost(): boolean {
      return forceGhost;
    },
    set forceGhost(v: boolean) {
      forceGhost = v;
    },
    get debugFlags(): number {
      return debugFlags;
    },
    set debugFlags(v: number) {
      debugFlags = v >>> 0;
    },
    get density(): TrafficDensity {
      return { ...density, maxAwake: Math.min(density.maxAwake, governor.maxAwake) };
    },

    async start(seed: number): Promise<boolean> {
      teardown();
      const gen = generation;
      const entries = trafficVariantEntries();
      if (entries.length === 0 || density.agents <= 0) return false;
      let assets: PlayerAssets[];
      try {
        assets = await Promise.all(entries.map((e) => loadPlayerAssets(e)));
      } catch (e) {
        console.warn('[traffic] variant load failed; no traffic', e);
        return false;
      }
      if (gen !== generation) return false;
      let info;
      try {
        info = await client.setTraffic({
          enabled: true,
          seed,
          variants: assets.map((a) => ({ catalogId: a.entry.id, vehicle: a.sim, weight: 1, paletteCount: a.entry.palettes.length })),
          density: { ...density },
          focusObjectId: deps.focusObjectId,
        });
      } catch (e) {
        console.warn('[traffic] the worker declined traffic', e);
        return false;
      }
      if (gen !== generation) return false;
      try {
        const meshes: GhostVariantMeshes[] = [];
        const templates = assets.map((a, i) => {
          const t = info.variants[i];
          if (t && t.settled.length === 3 * a.compiled.rig.nodeCount) return t.settled;
          console.warn(`[traffic] ${a.entry.id}: no settled template from the worker; ghosts use the rest pose`);
          return a.compiled.rig.nodePos;
        });
        variants = assets.map((a, i) => ({
          entry: a.entry,
          assets: a,
          offsets: settleOffsets(a.compiled, templates[i]!),
          paints: a.entry.palettes.map((p) => ({ color: new Color().setHex(p.paint.color), metalness: p.paint.metallic })),
          pool: [],
          maxSteerRad: (a.compiled.steering.maxWheelAngleDeg * Math.PI) / 180,
        }));
        variants.forEach((v, i) => {
          // The first pooled visual also provides the LOD bindings the ghosts are baked from.
          const first = createPooled(v);
          v.pool.push(first);
          const nodes = ghostNodes(v.assets.compiled, templates[i]!, v.offsets);
          const lb = first.handle.lodBindings;
          const lod1 = lb[0] ?? first.handle.binding;
          const lod2 = lb[1] ?? lod1;
          const body1 = bakeGhostBody(lod1, nodes);
          const body2 = bakeGhostBody(lod2, nodes);
          const e = v.entry.extent;
          meshes.push({
            bodies: [body1, body2],
            wheels: [bakeGhostWheel(v.assets.compiled, v.assets.visual.wheels, 1), bakeGhostWheel(v.assets.compiled, v.assets.visual.wheels, 2)],
            wheelFrames: ghostWheels(v.assets.compiled, nodes),
            paintRoughness: v.assets.visual.paint.roughness,
            footprint: {
              cx: (e.min[0] + e.max[0]) / 2,
              cz: (e.min[2] + e.max[2]) / 2,
              hx: (e.max[0] - e.min[0]) / 2 + 0.35,
              hz: (e.max[2] - e.min[2]) / 2 + 0.45,
            },
          });
        });
        fleet = createGhostFleet(meshes, {
          lighting: deps.lighting,
          patchMaterial: deps.patchMaterial,
          renderer: ctx.renderer,
          capacity: TRAFFIC_MAX_AGENTS,
        });
        object.add(fleet.object);
      } catch (e) {
        console.error('[traffic] render build failed; traffic off', e);
        teardown();
        client.setTrafficDensity({ agents: 0, maxAwake: 0, awakePoolBeams: 0 });
        return false;
      }
      running = true;
      stats.running = true;
      stats.pool = variants.reduce((a, x) => a + x.pool.length, 0);
      lodPrev.fill(-1);
      lastMode.fill(-1);
      modeTick.fill(-1);
      spin.fill(0);
      wasSoft.fill(0);
      lastSimTime = NaN;
      void fillPools();
      console.info(
        `[traffic] ${info.agentCount} agents on ${info.pathCount} paths (setup ${info.setupMs.toFixed(0)} ms), ${variants.length} variant(s), maxAwake ${density.maxAwake}`,
      );
      return true;
    },

    update(frame: WorldFrame): void {
      if (!running || !fleet) return;
      const load = client.workerLoad;
      stats.workerLoad = load;
      if (frame.timeScale > 0 && governor.update(frame.dtS, load)) {
        sendDensity();
        console.info(`[traffic] governor: worker load ${load.toFixed(2)} → maxAwake ${governor.maxAwake}`);
      }
      stats.maxAwake = Math.min(density.maxAwake, governor.maxAwake);
      const n = client.readTrafficAgents(frame.simTime, agents);
      const dSim = Number.isFinite(lastSimTime) ? Math.max(0, Math.min(0.25, frame.simTime - lastSimTime)) : 0;
      lastSimTime = frame.simTime;
      frame.camera.getWorldPosition(_cam);
      for (const v of variants) for (const pv of v.pool) pv.used = false;
      fleet.begin(frame.camera);
      let ghosts = 0;
      let soft = 0;
      let rigid = 0;
      for (let i = 0; i < n; i++) {
        const a = agents[i]!;
        const v = variants[a.variant];
        if (!v || a.agent >= TRAFFIC_MAX_AGENTS) continue;
        const radius = v.assets.compiled.wheels[0]?.radius ?? 0.32;
        spin[a.agent] = (spin[a.agent]! - (a.speed * dSim) / radius) % (2 * Math.PI);
        const awake = (a.flags & TRAFFIC_FLAG_AWAKE) !== 0;
        if (lastMode[a.agent] !== (awake ? 1 : 0)) {
          lastMode[a.agent] = awake ? 1 : 0;
          modeTick[a.agent] = client.latestTick;
        }
        let drawn = false;
        if (awake && a.nodesReady && !forceGhost) {
          const range = findRange(frame.objects, a.objectId);
          if (range && range.nodeCount === v.assets.compiled.rig.nodeCount) {
            const pv = acquire(v, a, frame.simTime);
            if (pv) {
              pv.used = true;
              if (frame.simTime >= pv.fxAt) {
                deps.fx?.addVehicle(a.objectId, v.assets.compiled);
                pv.fxAt = NaN;
              }
              if (frame.interpolated) feed(pv, a, range, frame);
              pv.handle.object.visible = true;
              if (!wasSoft[a.agent]) stats.promotions++;
              wasSoft[a.agent] = 1;
              drawn = true;
              soft++;
            }
          }
        }
        if (!drawn) {
          if (wasSoft[a.agent]) stats.demotions++;
          wasSoft[a.agent] = 0;
          drawGhost(v, a.variant, a, frame);
          if (awake) rigid++;
          else ghosts++;
        } else {
          // keep the ghost LOD state in step so a demotion draws the soft body's level
          _p.set(a.pos[0], a.pos[1], a.pos[2]);
          lodPrev[a.agent] = selectVehicleLod(lodPrev[a.agent]!, lodDistance(_p.distanceTo(_cam), frame.camera.fov));
        }
      }
      for (const v of variants) for (const pv of v.pool) if (!pv.used && pv.agent >= 0) release(pv);
      fleet.end();
      stats.agents = n;
      stats.ghosts = ghosts;
      stats.softBodies = soft;
      stats.awakeRigid = rigid;
      stats.ghostDraws = fleet.stats.draws;
    },

    setQuality(q: QualityPreset): void {
      const next = q.traffic;
      if (next.agents === density.agents && next.maxAwake === density.maxAwake && next.awakePoolBeams === density.awakePoolBeams) return;
      density = { ...next };
      governor.setPreset(density.maxAwake);
      if (running) {
        sendDensity();
        void fillPools();
      }
    },

    owns: isTrafficObjectId,

    // Damage always; world FX only once the object is registered with FX (FX_DELAY_S after its
    // promotion): the spawn puts every tread node into ground contact at once, and that burst of
    // contact impacts / skids would puff dust and smoke at the hand-over.
    onImpact(e: Readonly<ImpactEvent>): void {
      const pv = bound(e.objectId);
      pv?.handle.onImpact(e);
      if (pv && Number.isNaN(pv.fxAt)) deps.fx?.onImpact(e);
    },
    onBeamBreak(e: Readonly<BeamBreakEvent>): void {
      const pv = bound(e.objectId);
      pv?.handle.onBeamBreak(e);
      if (pv && Number.isNaN(pv.fxAt)) deps.fx?.onBeamBreak(e);
    },
    onSkid(e: Readonly<SkidEvent>): void {
      const pv = bound(e.objectId);
      pv?.handle.onSkid(e);
      if (pv && Number.isNaN(pv.fxAt)) deps.fx?.onSkid(e);
    },

    dispose(): void {
      teardown();
      object.removeFromParent();
    },
  };
  return controller;
}
