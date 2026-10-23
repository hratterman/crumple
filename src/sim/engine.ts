/**
 * Sim engine: owns the arena, objects, ground, pending events and the fixed
 * step. Worker-only. Commands (spawn/despawn/reset/input/ground) must be
 * called between steps; step() itself is allocation-free.
 */
import { shellCrashArmed } from './vehicle/shell';
import type { Vec3 } from '../core/math';
import { createRng, type Rng } from '../core/rng';
import type { SnapshotWriter } from '../protocol/codec';
import {
  BEAM_BREAK_CAPACITY,
  EventKind,
  IMPACT_CAPACITY,
  SKID_CAPACITY,
} from '../protocol/events';
import { OBJECT_FLAG_HORN, TELEMETRY_SLOTS, VEHICLE_EXT_SLOTS } from '../protocol/layout';
import {
  ACTION_NAMES,
  ACTION_RANGES,
  Action,
  DEFAULT_CAPACITY,
  MaterialId,
  isLayoutPropId,
  isPropObjectId,
  PROP_DYNAMIC_ID_BASE,
  PROP_DYNAMIC_MAX,
  type ActionState,
  type PropSpawn,
  type SnapshotCapacity,
  type Transform,
} from '../protocol/messages';
import { applyColliderContacts, compileColliders, resetColliderContactState } from './collision/colliders';
import { OBJ_REBUILD_TICKS, OBJ_REBUILD_TICKS_SLOW, OBJ_SLOW_SPEED, ObjectContacts, pairKey } from './collision/objects';
import { applyWater, boxNearWater, VEHICLE_FLOOD_LOSS, VEHICLE_FLOOD_TIME_S } from './collision/water';
import { TriangleContacts, type StaticMeshInput, type TriangleSlot } from './collision/triangles';
import { deriveCollisionTriangles, mergeTriangles, triangleSetOf } from './rig/triangles';
import { quatToMatrix } from '../world/colliders';
import { groundNormalForce, markMirroredSampler, PlaneSampler, resetGroundContactState } from './collision/ground';
import { applyBodyDig, applySoftGround, SoftGround, SoftGroundSampler } from './softground/softground';
import type { ColliderWorld } from './collision/types';
import { resolveColliders } from '../world/colliders';
import { WATER_PHYSICS, type ColliderDef, type ResolvedCollider, type WaterBody } from '../world/types';
import { DEFAULT_MATERIALS } from './collision/materials';
import { defaultKernel, setActiveKernel, type KernelFactory, type SimKernel } from './kernel';
import { compileRig } from './rig/builder';
import type { CompiledRig, RigDef } from './rig/types';
import { SimArena } from './state';
import { NODE_FLAG_OBJ_CONTACT, SIM_OBJECT_FLAG_SLEEPING, type EventSink, type HeightSampler, type MaterialTable, type SimObject, type SimState } from './types';
import { compilePropRig, getPropDef, isPropKey } from './props/catalog';
import { applyPropDamping, createFluidState, FLUID_TICKS, PROP_BUDGET_SLEEP_SPEED, PROP_INTERNAL_DAMPING, PROP_UNMOVED_HOLD_FRACTION, PROP_WAKE_SPEED, propAnchored, resetFluidState, stepPropFluid, type PropRuntime } from './props/runtime';
import { PROP_AWAKE_BEAM_BUDGET, type PropDef, type PropInstance, type PropKey } from './props/types';
import { compileVehicle, TRAFFIC_BEAM_BUDGET, validateVehicle } from './vehicle/builder';
import { isTrafficObjectId, TRAFFIC_AI_TICKS, type TrafficBubble, type TrafficDensity, type TrafficVariantSpec } from '../protocol/traffic';
import { buildRouteNetwork } from '../world/routes';
import type { RouteNetwork, WorldLayout } from '../world/types';
import { clampDensity, TrafficSim } from './traffic/traffic';
import { buildVariant, type TrafficVariant } from './traffic/templates';
import { AutopilotSet } from './traffic/autopilot';
import { SOLVER_PRESETS, SPAWN_SETTLE_MAX_S, type SetAutopilotMsg, type SolverOptions } from '../protocol/messages';
import { createTerrainSampler, type HeightfieldSampler } from '../world/sampler';
import type { TerrainData } from '../world/types';
import {
  createVehicleRuntime,
  rebaseVehicle,
  recoverVehicle,
  resetVehicleRuntime,
  vehiclePreStep,
  writeVehicleTelemetry,
  writeVehicleTelemetryExt,
  type VehicleRuntimeEx,
} from './vehicle/runtime';
import type { CompiledVehicle, TransmissionMode, VehicleDef, VehicleRuntime } from './vehicle/types';
import { setWheelGround } from './vehicle/wheels';
import { fillWheelFrame, punctureTyre, repairTyre, setSoilRutHook, setTreadDepth, setTyreEnvironment, setTyrePressure, tyreEnv, type SoilRutHook } from './vehicle/tyre';
import { createWheelFrame } from '../protocol/wheels';

/** Snapshot scratch for the wheel records (never retained). */
const wheelScratch = createWheelFrame();
import { createVehicleWater, drainVehicleWater, stepVehicleWater } from './water/vehicleWater';
import { COUPLING_ARM_S, TowingSystem } from './trailer/runtime';
import { JointKind, type JointSpec } from './trailer/joints';
import { buildTrailer, TOW_HITCH_NODES, type TrailerKind } from './trailer/defs';
import { facingQuat } from './props/placement';
import { joinProps, PROP_JOINS } from './props/joins';
import { applyRailContacts, createRailSurface, type RailSurface } from './props/railContact';
import { createVehicleDebris, updateDebris, wakeAllIslands, type VehicleDebris } from './debris/islands';
import type { DrivetrainStateEx } from './vehicle/drivetrain';

/**
 * R-CORE: solver options of a fresh engine (before any `setSolver`). Main
 * sends the physics-quality preset (SOLVER_PRESETS) right after `init`.
 */
export const SOLVER_DEFAULTS: Readonly<SolverOptions> = SOLVER_PRESETS.standard;
let defaultSolver: Readonly<SolverOptions> = SOLVER_DEFAULTS;
/** Solver options new engines start from (tests / tools run a harness at another quality; the worker uses setSolver). */
export function setDefaultSolver(options: Readonly<SolverOptions>): void {
  defaultSolver = { ...options };
}
export function getDefaultSolver(): Readonly<SolverOptions> {
  return defaultSolver;
}
const SOLVER_OPTION_KEYS = ['triangleContact', 'selfCollision', 'ccd'] as const satisfies readonly (keyof SolverOptions)[];

/**
 * R-CORE collision triangles of an object, resolved lazily (derivation of a
 * vehicle surface is ~0.1–0.6 s once per def; single-object sims never need
 * it), or at spawn when triangle contact is on.
 */
interface LazyTriangles {
  rig: CompiledRig;
  /** Vehicles: body node count (derivation range); plain rigs: 0 = declared triangles only. */
  bodyNodeCount: number;
  /** Cache key across compiles of the same def (VehicleDef object), or null. */
  defKey: object | null;
  slot: TriangleSlot | null | undefined;
}
/** Extra reach (m) when deciding whether two objects may meet through their triangles this interval. */
const TRI_REACH_PAD = 0.5;
const TRI_BY_DEF = new WeakMap<object, TriangleSlot | null>();
const TRI_BY_RIG = new WeakMap<CompiledRig, TriangleSlot | null>();

function resolveTriangles(t: LazyTriangles): TriangleSlot | null {
  if (t.slot !== undefined) return t.slot;
  let slot = t.defKey ? TRI_BY_DEF.get(t.defKey) : undefined;
  if (slot === undefined) slot = TRI_BY_RIG.get(t.rig);
  if (slot === undefined) {
    const rig = t.rig;
    // Vehicles: the derived body surface (+ caps), plus declared triangles it lacks; plain rigs: declared only.
    let tris = rig.triangles;
    if (t.bodyNodeCount > 0) {
      const derived = deriveCollisionTriangles(rig, { nodeCount: t.bodyNodeCount });
      tris = tris && tris.count > 0 ? mergeTriangles(derived, tris, rig.nodePos) : derived;
    }
    slot = tris && tris.count > 0 ? { set: triangleSetOf(rig, tris), nodeSelf: rig.nodeSelfCollide ?? null } : null;
    TRI_BY_RIG.set(rig, slot);
    if (t.defKey) TRI_BY_DEF.set(t.defKey, slot);
  }
  t.slot = slot;
  return slot;
}

/** Fixed physics step, s. */
export const SIM_DT = 1 / 2000;

/** Validates a spawnVehicle / reset `settle` (sim s) into ticks: clamped to SPAWN_SETTLE_MAX_S, rounded. */
function settleTicksOf(settle: number | undefined, objectId: number): number {
  if (settle === undefined) return 0;
  if (typeof settle !== 'number' || !Number.isFinite(settle) || settle < 0) throw new SimCommandError('settle must be a finite number ≥ 0', objectId);
  return Math.round((settle < SPAWN_SETTLE_MAX_S ? settle : SPAWN_SETTLE_MAX_S) / SIM_DT);
}
export const SIM_HZ = 2000;

export interface EngineConfig {
  gravity: Vec3;
  debugStrains: boolean;
  capacity?: SnapshotCapacity;
  seed?: number;
  /** R-CORE solver kernel (js / wasm / simd; bit-identical). Default: `defaultKernel()`. */
  kernel?: KernelFactory;
}

const IMPACT_FIELDS = 9;
const BREAK_FIELDS = 5;
const SKID_FIELDS = 7;

/**
 * Buffers events between WRITTEN snapshots (discovery order, preallocated at
 * protocol capacity). Events beyond capacity are dropped and counted; the
 * counts are added to the next written snapshot's overflow fields.
 */
export class PendingEvents implements EventSink {
  readonly impacts = new Float64Array(IMPACT_CAPACITY * IMPACT_FIELDS);
  readonly breaks = new Float64Array(BEAM_BREAK_CAPACITY * BREAK_FIELDS);
  readonly skids = new Float64Array(SKID_CAPACITY * SKID_FIELDS);
  impactCount = 0;
  breakCount = 0;
  skidCount = 0;
  impactOverflow = 0;
  breakOverflow = 0;
  skidOverflow = 0;
  /** Objects in a spawn-settle window: their impact / skid events are dropped (SimEngine.startSettle). */
  readonly muted = new Set<number>();

  constructor(private readonly arena: SimArena) {}

  impact(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    impulse: number,
  ): void {
    if (this.muted.size > 0 && this.muted.has(objectId)) return;
    if (this.impactCount >= IMPACT_CAPACITY) {
      this.impactOverflow++;
      return;
    }
    const a = this.impacts;
    const w = this.impactCount * IMPACT_FIELDS;
    a[w] = objectId;
    a[w + 1] = materialId;
    a[w + 2] = px;
    a[w + 3] = py;
    a[w + 4] = pz;
    a[w + 5] = nx;
    a[w + 6] = ny;
    a[w + 7] = nz;
    a[w + 8] = impulse;
    this.impactCount++;
  }

  beamBreak(beamIndex: number, px: number, py: number, pz: number): void {
    if (this.breakCount >= BEAM_BREAK_CAPACITY) {
      this.breakOverflow++;
      return;
    }
    const oi = this.arena.ownerOfBeam(beamIndex);
    if (oi < 0) return; // unreachable: every arena beam belongs to an object
    const obj = this.arena.objects[oi]!;
    const a = this.breaks;
    const w = this.breakCount * BREAK_FIELDS;
    a[w] = obj.objectId;
    a[w + 1] = beamIndex - obj.beamStart;
    a[w + 2] = px;
    a[w + 3] = py;
    a[w + 4] = pz;
    this.breakCount++;
  }

  skid(
    objectId: number,
    materialId: number,
    px: number,
    py: number,
    pz: number,
    slip: number,
    load: number,
  ): void {
    if (this.muted.size > 0 && this.muted.has(objectId)) return;
    if (this.skidCount >= SKID_CAPACITY) {
      this.skidOverflow++;
      return;
    }
    const a = this.skids;
    const w = this.skidCount * SKID_FIELDS;
    a[w] = objectId;
    a[w + 1] = materialId;
    a[w + 2] = px;
    a[w + 3] = py;
    a[w + 4] = pz;
    a[w + 5] = slip;
    a[w + 6] = load;
    this.skidCount++;
  }

  /** Copies everything pending into `writer` (after begin) and clears. */
  flushTo(writer: SnapshotWriter): void {
    const im = this.impacts;
    for (let i = 0; i < this.impactCount; i++) {
      const w = i * IMPACT_FIELDS;
      writer.pushImpact(im[w]!, im[w + 1]!, im[w + 2]!, im[w + 3]!, im[w + 4]!, im[w + 5]!, im[w + 6]!, im[w + 7]!, im[w + 8]!);
    }
    const br = this.breaks;
    for (let i = 0; i < this.breakCount; i++) {
      const w = i * BREAK_FIELDS;
      writer.pushBeamBreak(br[w]!, br[w + 1]!, br[w + 2]!, br[w + 3]!, br[w + 4]!);
    }
    const sk = this.skids;
    for (let i = 0; i < this.skidCount; i++) {
      const w = i * SKID_FIELDS;
      writer.pushSkid(sk[w]!, sk[w + 1]!, sk[w + 2]!, sk[w + 3]!, sk[w + 4]!, sk[w + 5]!, sk[w + 6]!);
    }
    if (this.impactOverflow > 0) writer.addOverflow(EventKind.impact, this.impactOverflow);
    if (this.breakOverflow > 0) writer.addOverflow(EventKind.beamBreak, this.breakOverflow);
    if (this.skidOverflow > 0) writer.addOverflow(EventKind.skid, this.skidOverflow);
    this.clear();
  }

  clear(): void {
    this.impactCount = 0;
    this.breakCount = 0;
    this.skidCount = 0;
    this.impactOverflow = 0;
    this.breakOverflow = 0;
    this.skidOverflow = 0;
  }
}

/** Command rejected (unknown object, capacity, invalid input). The sim stays consistent. */
export class SimCommandError extends Error {
  constructor(
    message: string,
    readonly objectId?: number,
  ) {
    super(message);
    this.name = 'SimCommandError';
  }
}

export class SimEngine {
  readonly arena: SimArena;
  readonly state: SimState;
  /** The solver kernel bound to `state` (R-CORE). */
  readonly kernel: SimKernel;
  /** Its factory (helper engines, e.g. traffic template settles, use the same kernel). */
  readonly kernelFactory: KernelFactory;
  readonly capacity: SnapshotCapacity;
  readonly debugStrains: boolean;
  readonly events: PendingEvents;
  readonly rng: Rng;
  gravityX: number;
  gravityY: number;
  gravityZ: number;
  /** |gravity| (water buoyancy). */
  gravityMag: number;
  sampler: HeightSampler | null = null;
  /** R-PHYS2: the rutted view of `sampler` (soft ground on), used only for objects near ruts. */
  private rutSampler: SoftGroundSampler | null = null;
  /** Per arena slot, this tick: 1 = the object's box touches a rut tile (ground + wheels on the rutted sampler). */
  private nearRuts = new Uint8Array(64);
  /** The installed heightfield (setGroundTerrain), null for plane / no ground. */
  terrain: TerrainData | null = null;
  materials: MaterialTable = DEFAULT_MATERIALS;
  /** R-TYRE: surface water (setSurfaceWetness), 0..1. */
  wetness = 0;
  rain = 0;
  /** Fixed steps taken since init. */
  tick = 0;
  /** Layout colliders (installed with the heightfield), then the setColliders extra set. */
  layoutColliders: ResolvedCollider[] = [];
  extraColliders: ResolvedCollider[] = [];
  /** Compiled active collider set (layout then extra); null = none. */
  colliderWorld: ColliderWorld | null = null;
  /** P5 water bodies (resolveWater, installed with the heightfield): buoyancy + drag. */
  water: WaterBody[] = [];
  /** Repair epoch per objectId (+1 per reset; snapshot OBJ_REPAIR_EPOCH). */
  private readonly repairEpochs = new Map<number, number>();
  /**
   * Last epoch of each despawned objectId: a respawn of the same id continues
   * from it (+1), so main sees the new body as a new epoch (no interpolation
   * from the old car, fresh damage) even when the node count matches.
   */
  private readonly retiredEpochs = new Map<number, number>();
  /** Spawn-settle windows: objectId → the first tick after its window (see startSettle). */
  private readonly settles = new Map<number, number>();
  /** Earliest end tick in `settles` (Infinity = none): step() checks only this. */
  private nextSettleEnd = Infinity;
  /** Compiled rig per objectId (needed for reset/repair). */
  private readonly rigs = new Map<number, CompiledRig>();
  /** Vehicle runtime per objectId. */
  private readonly vehicles = new Map<number, VehicleRuntime>();
  /** Parallel to arena.objects: the object's vehicle runtime or null (hot-loop lookup). */
  private vehicleSlots: (VehicleRuntime | null)[] = [];
  /** Scratch for enforceAwakeBudget (arena slots; reused, no per-rebuild allocation after warm-up). */
  private readonly budgetOrder: number[] = [];
  /** Node-vs-node contact (P5): broadphase + pair list + kernel. */
  readonly contacts: ObjectContacts;
  /** R-CORE node-vs-triangle contact (object triangles, self-collision, static meshes). */
  readonly tris: TriangleContacts;
  /** Collision triangles per objectId (lazy). */
  private readonly triById = new Map<number, LazyTriangles>();
  /** Parallel to arena.objects: lazy triangles or null. */
  private triSlots: (LazyTriangles | null)[] = [];
  /** Tick of the last / next broadphase rebuild and its interval. */
  private lastRebuild = 0;
  private nextRebuild = 0;
  private rebuildInterval = OBJ_REBUILD_TICKS;
  /** Set by commands that move nodes or change sleep states: rebuild before the next step. */
  private contactsDirty = true;
  /** Vehicle flood level 0..1 per objectId (water; reset by reset/recover). */
  private readonly floods = new Map<number, { level: number }>();
  /** Parallel to arena.objects: the vehicle's flood state or null. */
  private floodSlots: ({ level: number } | null)[] = [];
  /** Prop runtime per objectId (layout + dynamic props). */
  private readonly props = new Map<number, PropRuntime>();
  /** Parallel to arena.objects: the object's prop runtime or null. */
  private propSlots: (PropRuntime | null)[] = [];
  /** AI traffic (P6), null = off. Runs at the start of every TRAFFIC_AI_TICKS-th tick. */
  traffic: TrafficSim | null = null;
  /** P8: worker-side drivers of main-spawned vehicles (setAutopilot), run right after the traffic update. */
  readonly autopilots = new AutopilotSet();
  /** Route network cache (layout id/version + terrain hash). */
  private routeCache: { key: string; net: RouteNetwork } | null = null;
  /** R-CORE solver options (setSolver). Engines start from SOLVER_DEFAULTS. */
  readonly solver: SolverOptions = { ...defaultSolver };
  /** VehicleCatalog id per vehicle objectId (spawnVehicle.catalogId; P7 replay header). */
  readonly catalogIds = new Map<number, string>();
  /** R-PHYS2: trailers, cargo, cross-object joints and carrier surfaces. */
  readonly towing = new TowingSystem();
  /** R-PHYS2: debris island sleep per vehicle (objectId → state); list + frame origins rebuilt by syncVehicles. */
  private readonly debris = new Map<number, VehicleDebris>();
  private debrisList: VehicleDebris[] = [];
  /** R-PHYS2: guardrail rail faces (objectId → surface; list in arena order) and the vehicles' slots. */
  private readonly railById = new Map<number, RailSurface>();
  private railList: RailSurface[] = [];
  private railVehicles: SimObject[] = [];
  private railVehicleSlots: number[] = [];
  private debrisOrigins: number[] = [];
  private debrisSlots: number[] = [];
  /** R-PHYS2: persistent ruts (heightfield ground; planes only after enableSoftGround()). */
  readonly softGround = new SoftGround();
  softGroundOn = false;
  /**
   * The compaction resistance of fresh ruts (softground.ts). Off: R-TYRE's Bekker tyre contact
   * (vehicle/tyre.ts) owns the soil forces, its compaction resistance included (CONTRACTS "R-TYRE ↔ R-PHYS2").
   */
  softGroundResistance = false;
  /** R-TYRE seam: a tyre in a rut sinks only the rest of its Bekker sinkage (the rutted ground is already that deep). */
  private readonly rutHook: SoilRutHook = { rutDepth: (x, z) => this.softGround.priorDepthAt(x, z, this.tick), onSink: () => {} };
  private readonly groundN = (i: number): number => groundNormalForce(this.state, i, this.rutSampler ?? this.sampler!, SIM_DT);
  /** Compiled trailer defs per (kind, options) key. */
  private readonly trailerDefs = new Map<string, CompiledVehicle>();
  /** Wake callback for joint wake requests (bound once: no per-tick closure). */
  private readonly wakeObject = (obj: SimObject): void => {
    if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) this.setAsleep(obj, false);
  };

  constructor(config: EngineConfig) {
    const cap = config.capacity ?? DEFAULT_CAPACITY;
    for (const v of [cap.maxObjects, cap.nodeCapacity, cap.beamCapacity]) {
      if (!Number.isInteger(v) || v < 0) throw new RangeError('capacity values must be non-negative integers');
    }
    const g = config.gravity;
    if (!g || g.length !== 3 || !g.every(Number.isFinite)) throw new TypeError('gravity must be 3 finite numbers');
    this.capacity = { ...cap };
    this.debugStrains = !!config.debugStrains;
    this.kernelFactory = config.kernel ?? defaultKernel();
    this.kernel = this.kernelFactory.create(cap.nodeCapacity, cap.beamCapacity);
    this.arena = new SimArena(cap.nodeCapacity, cap.beamCapacity, cap.maxObjects, this.kernel.state);
    this.state = this.arena.state;
    this.events = new PendingEvents(this.arena);
    this.contacts = new ObjectContacts(cap.nodeCapacity, cap.maxObjects);
    this.tris = new TriangleContacts(cap.nodeCapacity, cap.maxObjects);
    this.tris.excludedPairs = this.contacts.triExcludedPairs;
    this.gravityX = g[0];
    this.gravityY = g[1];
    this.gravityZ = g[2];
    this.gravityMag = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    this.rng = createRng(config.seed ?? 0);
  }

  get objects(): readonly SimObject[] {
    return this.arena.objects;
  }

  get simTime(): number {
    return this.tick * SIM_DT;
  }

  setGroundPlane(y: number, materialId: number): void {
    if (!Number.isFinite(y)) throw new SimCommandError('ground y must be finite');
    if (!Number.isInteger(materialId) || materialId < 0 || materialId >= this.materials.friction.length) {
      throw new SimCommandError(`invalid materialId ${materialId}`);
    }
    this.sampler = new PlaneSampler(y, materialId);
    this.rutSampler = null;
    this.terrain = null;
    this.softGroundOn = false;
  }

  /** R-PHYS2: ruts on the current ground (the heightfield turns them on by itself; tests call this on a plane). */
  enableSoftGround(): void {
    if (!this.sampler || this.softGroundOn) return;
    this.rutSampler = new SoftGroundSampler(this.sampler, this.softGround);
    this.softGroundOn = true;
  }

  /**
   * Installs a heightfield ground (P3): builds the TerrainSampler (vertex
   * normal grid) over `terrain`, which the engine then holds by reference
   * (do not mutate it). Every material byte must be a valid MaterialId (the
   * friction lookup in the contact kernels is unchecked). Returns the sampler.
   */
  setGroundTerrain(terrain: TerrainData): HeightfieldSampler {
    const mats = terrain.material;
    const nMat = this.materials.friction.length;
    for (let i = 0; i < mats.length; i++) {
      if (mats[i]! >= nMat) throw new SimCommandError(`terrain material ${mats[i]} at sample ${i} is not a MaterialId`);
    }
    let sampler: HeightfieldSampler;
    try {
      sampler = createTerrainSampler(terrain);
    } catch (e) {
      throw new SimCommandError(`invalid terrain: ${e instanceof Error ? e.message : String(e)}`);
    }
    markMirroredSampler(sampler);
    this.sampler = sampler;
    this.softGround.clear();
    this.rutSampler = new SoftGroundSampler(sampler, this.softGround);
    this.softGroundOn = true;
    this.terrain = terrain;
    return sampler;
  }

  clearGround(): void {
    this.sampler = null;
    this.rutSampler = null;
    this.terrain = null;
    this.softGroundOn = false;
  }

  /** Ground height for collider resolution (0 without ground). */
  private groundHeightAt = (x: number, z: number): number => (this.sampler ? this.sampler.heightAt(x, z) : 0);

  /**
   * Installs the LAYOUT collider set (worker: with groundHeightfield):
   * resolved against the current ground. Invalid → SimCommandError, set unchanged.
   */
  setLayoutColliders(defs: readonly ColliderDef[]): void {
    this.layoutColliders = this.resolve(defs);
    this.rebuildColliders();
  }

  /** Installs the water bodies (worker: with groundHeightfield). */
  setWater(bodies: readonly WaterBody[]): void {
    for (const b of bodies) {
      if (![b.level, b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite) || !(b.minX <= b.maxX && b.minZ <= b.maxZ)) {
        throw new SimCommandError(`invalid water body '${b.id}'`);
      }
    }
    this.water = bodies.map((b) => ({ ...b }));
  }

  /** Replaces the EXTRA collider set (protocol setColliders), appended after the layout set. */
  setExtraColliders(defs: readonly ColliderDef[]): void {
    this.extraColliders = this.resolve(defs);
    this.rebuildColliders();
  }

  private resolve(defs: readonly ColliderDef[]): ResolvedCollider[] {
    if (!Array.isArray(defs)) throw new SimCommandError('colliders must be an array');
    try {
      return resolveColliders(defs, this.groundHeightAt);
    } catch (e) {
      throw new SimCommandError(`invalid colliders: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private rebuildColliders(): void {
    const all = [...this.layoutColliders, ...this.extraColliders];
    const ids = new Set<string>();
    for (const c of all) {
      if (ids.has(c.id)) throw new SimCommandError(`duplicate collider id '${c.id}' (layout and extra sets share one id space)`);
      ids.add(c.id);
    }
    for (const c of all) {
      if (c.material >= this.materials.friction.length) throw new SimCommandError(`collider '${c.id}': material ${c.material} is not in the material table`);
    }
    this.colliderWorld = all.length > 0 ? compileColliders(all) : null;
    // R-CORE: mesh colliders → world-space static triangle meshes.
    const meshes: StaticMeshInput[] = [];
    const R = new Float64Array(9);
    for (const c of all) {
      if (c.kind !== 'mesh' || !c.mesh) continue;
      quatToMatrix(c.quat, R);
      const P = c.mesh.positions;
      const out = new Float64Array(P.length);
      for (let v = 0; v < P.length; v += 3) {
        const x = P[v]!, y = P[v + 1]!, z = P[v + 2]!;
        out[v] = c.pos[0] + R[0]! * x + R[1]! * y + R[2]! * z;
        out[v + 1] = c.pos[1] + R[3]! * x + R[4]! * y + R[5]! * z;
        out[v + 2] = c.pos[2] + R[6]! * x + R[7]! * y + R[8]! * z;
      }
      meshes.push({ positions: out, indices: Int32Array.from(c.mesh.indices), material: c.material, twoSided: c.mesh.twoSided === true });
    }
    this.tris.setStaticMeshes(meshes);
    this.contactsDirty = true;
  }

  spawn(objectId: number, def: RigDef, transform: Transform): SimObject {
    if (isTrafficObjectId(objectId)) throw new SimCommandError(`objectId ${objectId} is in the traffic range (worker-owned)`, objectId);
    let rig: CompiledRig;
    try {
      rig = compileRig(def);
    } catch (e) {
      throw new SimCommandError(`invalid rig: ${e instanceof Error ? e.message : String(e)}`, objectId);
    }
    return this.spawnCompiled(objectId, rig, transform);
  }

  spawnCompiled(objectId: number, rig: CompiledRig, transform: Transform): SimObject {
    let obj: SimObject;
    try {
      obj = this.arena.insert(objectId, rig, transform);
    } catch (e) {
      throw new SimCommandError(e instanceof Error ? e.message : String(e), objectId);
    }
    this.rigs.set(objectId, rig);
    if (rig.triangles && rig.triangles.count > 0) this.triById.set(objectId, { rig, bodyNodeCount: 0, defKey: null, slot: undefined });
    else this.triById.delete(objectId);
    // Ranges from here on shifted; per-node contact bookkeeping restarts.
    resetGroundContactState(this.state, obj.nodeStart, this.state.nodeCount - obj.nodeStart);
    resetColliderContactState(this.state, obj.nodeStart, this.state.nodeCount - obj.nodeStart);
    const retired = this.retiredEpochs.get(objectId);
    this.repairEpochs.set(objectId, retired === undefined ? 0 : (retired + 1) >>> 0);
    this.syncVehicles();
    // Global node indices shifted: drop the pair lists.
    this.contacts.clear();
    this.tris.clear();
    this.contactsDirty = true;
    return obj;
  }

  /**
   * Spawns a vehicle: compileVehicle (pure; main compiles the same def to
   * map snapshot nodes) → arena insert → vehicle runtime. `transmission`
   * overrides the def's initial mode.
   */
  spawnVehicle(objectId: number, def: VehicleDef, transform: Transform, transmission?: TransmissionMode, catalogId?: string, settle?: number): SimObject {
    if (isTrafficObjectId(objectId)) throw new SimCommandError(`objectId ${objectId} is in the traffic range (worker-owned)`, objectId);
    if (catalogId !== undefined && typeof catalogId !== 'string') throw new SimCommandError('catalogId must be a string', objectId);
    const settleTicks = settleTicksOf(settle, objectId);
    let compiled: CompiledVehicle;
    try {
      compiled = compileVehicle(def);
    } catch (e) {
      throw new SimCommandError(`invalid vehicle: ${e instanceof Error ? e.message : String(e)}`, objectId);
    }
    const obj = this.spawnCompiledVehicle(objectId, compiled, transform, transmission, def);
    if (catalogId !== undefined) this.catalogIds.set(objectId, catalogId);
    if (settleTicks > 0) this.startSettle(objectId, settleTicks);
    return obj;
  }

  spawnCompiledVehicle(
    objectId: number,
    compiled: CompiledVehicle,
    transform: Transform,
    transmission?: TransmissionMode,
    /** R-CORE: the source def (caches the derived collision triangles across compiles). */
    defKey?: object,
  ): SimObject {
    if (transmission !== undefined && transmission !== 'auto' && transmission !== 'manual') {
      throw new SimCommandError(`invalid transmission ${String(transmission)}`, objectId);
    }
    const obj = this.spawnCompiled(objectId, compiled.rig, transform);
    // Vehicles always have collision triangles: the derived body surface plus any declared ones it lacks.
    const lazy: LazyTriangles = { rig: compiled.rig, bodyNodeCount: compiled.bodyNodeCount, defKey: defKey ?? null, slot: undefined };
    this.triById.set(objectId, lazy);
    // With triangle contact on, derive now (a spawn already compiles) rather than at the first approach (an
    // HD rig's surface takes ~0.2–0.6 s once per def).
    if (this.solver.triangleContact) resolveTriangles(lazy);
    const rt = createVehicleRuntime(objectId, compiled, obj.nodeStart, obj.beamStart, transmission);
    const water = createVehicleWater(compiled);
    if (water) rt.water = water;
    this.towing.addCarrier(obj, compiled.name, compiled.rig);
    this.debris.set(objectId, createVehicleDebris(obj, rt));
    this.syncVehicles();
    this.vehicles.set(objectId, rt);
    this.syncVehicles();
    return obj;
  }

  /** The vehicle runtime of objectId, if it is a vehicle. */
  getVehicle(objectId: number): VehicleRuntime | undefined {
    return this.vehicles.get(objectId);
  }

  setTransmission(objectId: number, mode: TransmissionMode): void {
    const v = this.vehicles.get(objectId);
    if (!v) throw new SimCommandError(`objectId ${objectId} is not a vehicle`, objectId);
    if (mode !== 'auto' && mode !== 'manual') throw new SimCommandError(`invalid transmission ${String(mode)}`, objectId);
    v.drivetrain.transmission = mode;
  }

  /** Driver assists (protocol `setAssists`); omitted fields keep their state. */
  setAssists(objectId: number, assists: { tractionControl?: boolean; abs?: boolean; esc?: boolean; clutchAssist?: boolean }): void {
    const v = this.vehicles.get(objectId);
    if (!v) throw new SimCommandError(`objectId ${objectId} is not a vehicle`, objectId);
    const tc = assists?.tractionControl;
    const abs = assists?.abs;
    const esc = assists?.esc;
    if (tc !== undefined && typeof tc !== 'boolean') throw new SimCommandError('setAssists: tractionControl must be a boolean', objectId);
    if (abs !== undefined && typeof abs !== 'boolean') throw new SimCommandError('setAssists: abs must be a boolean', objectId);
    if (esc !== undefined && typeof esc !== 'boolean') throw new SimCommandError('setAssists: esc must be a boolean', objectId);
    const ca = assists?.clutchAssist;
    if (ca !== undefined && typeof ca !== 'boolean') throw new SimCommandError('setAssists: clutchAssist must be a boolean', objectId);
    if (tc !== undefined) v.drivetrain.tractionControl = tc;
    const dts = v.drivetrain as DrivetrainStateEx;
    if (abs !== undefined) dts.abs = abs;
    if (esc !== undefined) dts.esc = esc;
    if (ca !== undefined) dts.clutchAssist = ca;
  }

  /** R-TYRE: surface water the tyres see (protocol `setSurfaceWetness`, logged; clamped to [0, 1]). */
  setSurfaceWetness(wetness: number, rain: number): void {
    if (typeof wetness !== 'number' || !Number.isFinite(wetness) || typeof rain !== 'number' || !Number.isFinite(rain)) {
      throw new SimCommandError('setSurfaceWetness: wetness and rain must be finite numbers');
    }
    this.wetness = wetness < 0 ? 0 : wetness > 1 ? 1 : wetness;
    this.rain = rain < 0 ? 0 : rain > 1 ? 1 : rain;
  }

  /** R-TYRE: tyre service (protocol `setTyre`, logged): inflate / air down, puncture, repair. */
  setTyre(msg: { objectId: number; wheel?: number; pressureKpa?: number; puncture?: 'slow' | 'fast' | 'debead'; repair?: boolean; treadMm?: number }): void {
    const v = this.vehicles.get(msg.objectId) as VehicleRuntimeEx | undefined;
    if (!v) throw new SimCommandError(`objectId ${msg.objectId} is not a vehicle`, msg.objectId);
    const n = v.tyres.length;
    if (msg.wheel !== undefined && (!Number.isInteger(msg.wheel) || msg.wheel < 0 || msg.wheel >= n)) {
      throw new SimCommandError(`setTyre: wheel ${String(msg.wheel)} out of range`, msg.objectId);
    }
    if (msg.pressureKpa !== undefined && !(Number.isFinite(msg.pressureKpa) && msg.pressureKpa >= 0 && msg.pressureKpa <= 2000)) {
      throw new SimCommandError('setTyre: pressureKpa must be in [0, 2000]', msg.objectId);
    }
    if (msg.puncture !== undefined && msg.puncture !== 'slow' && msg.puncture !== 'fast' && msg.puncture !== 'debead') {
      throw new SimCommandError('setTyre: puncture must be slow | fast | debead', msg.objectId);
    }
    if (msg.treadMm !== undefined && !(Number.isFinite(msg.treadMm) && msg.treadMm >= 0 && msg.treadMm <= 40)) {
      throw new SimCommandError('setTyre: treadMm must be in [0, 40]', msg.objectId);
    }
    for (let w = 0; w < n; w++) {
      if (msg.wheel !== undefined && w !== msg.wheel) continue;
      const t = v.tyres[w]!;
      if (msg.repair === true) repairTyre(t);
      if (msg.pressureKpa !== undefined) setTyrePressure(t, msg.pressureKpa);
      if (msg.puncture !== undefined) punctureTyre(t, msg.puncture);
      if (msg.treadMm !== undefined) setTreadDepth(t, msg.treadMm);
    }
  }

  /** Upright the vehicle in place (damage and drivetrain kept); see recoverVehicle. */
  recover(objectId: number, pos?: Vec3): void {
    const v = this.vehicles.get(objectId);
    const obj = this.arena.get(objectId);
    if (!v || !obj) throw new SimCommandError(`objectId ${objectId} is not a vehicle`, objectId);
    if (pos !== undefined && (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite))) {
      throw new SimCommandError('recover pos must be 3 finite numbers', objectId);
    }
    const dbr = this.debris.get(objectId);
    if (dbr) wakeAllIslands(this.state, dbr);
    recoverVehicle(this.state, v, this.sampler, pos);
    resetGroundContactState(this.state, obj.nodeStart, obj.nodeCount);
    resetColliderContactState(this.state, obj.nodeStart, obj.nodeCount);
    const fl = this.floods.get(objectId);
    if (fl) fl.level = 0; // recovered onto land: the cabin drains
    if (v.water) drainVehicleWater(v.water, false);
    this.contactsDirty = true;
    if (this.towing.trailers.size > 0) this.replaceTrailersOf(objectId);
  }

  /** Rebuilds the per-object vehicle/prop slots and rebases every vehicle onto its current arena range. */
  private syncVehicles(): void {
    const objs = this.arena.objects;
    const slots: (VehicleRuntime | null)[] = new Array(objs.length);
    const pslots: (PropRuntime | null)[] = new Array(objs.length);
    const fslots: ({ level: number } | null)[] = new Array(objs.length);
    const tslots: (LazyTriangles | null)[] = new Array(objs.length);
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      tslots[o] = this.triById.get(obj.objectId) ?? null;
      const v = this.vehicles.get(obj.objectId) ?? null;
      if (v !== null && (v.nodeStart !== obj.nodeStart || v.beamStart !== obj.beamStart)) {
        rebaseVehicle(v, obj.nodeStart, obj.beamStart);
      }
      slots[o] = v;
      pslots[o] = this.props.get(obj.objectId) ?? null;
      let fl: { level: number } | null = null;
      if (v) {
        fl = this.floods.get(obj.objectId) ?? { level: 0 };
        this.floods.set(obj.objectId, fl);
      }
      fslots[o] = fl;
    }
    this.vehicleSlots = slots;
    this.propSlots = pslots;
    this.railList = [];
    this.railVehicles = [];
    this.railVehicleSlots = [];
    for (let o = 0; o < objs.length; o++) {
      const rs = this.railById.get(objs[o]!.objectId);
      if (rs) this.railList.push(rs);
      if (slots[o]) {
        this.railVehicles.push(objs[o]!);
        this.railVehicleSlots.push(o);
      }
    }
    this.floodSlots = fslots;
    this.triSlots = tslots;
    this.debrisList = [];
    this.debrisOrigins = [];
    this.debrisSlots = [];
    for (let o = 0; o < objs.length; o++) {
      const d = this.debris.get(objs[o]!.objectId);
      const v = slots[o];
      if (!d || !v) continue;
      this.debrisList.push(d);
      this.debrisOrigins.push(v.vehicle.frameNodes[0]!);
      this.debrisSlots.push(o);
    }
  }

  // ------------------------------------------------------------------ trailers + cargo (R-PHYS2)
  /** Compiled trailer def per kind + ballast (pure, cached). */
  private compiledTrailer(kind: TrailerKind, ballastKg: number, ballastZ: number): CompiledVehicle {
    const key = `${kind}|${ballastKg}|${ballastZ}`;
    let c = this.trailerDefs.get(key);
    if (!c) {
      c = compileVehicle(buildTrailer(kind, ballastKg > 0 ? { ballast: { mass: ballastKg, z: ballastZ } } : {}));
      this.trailerDefs.set(key, c);
    }
    return c;
  }

  /** World basis of a vehicle's frame now: origin + right (X), up (Y), back (Z) unit columns. */
  private vehicleBasis(v: VehicleRuntime, out: Float64Array): void {
    const s = this.state;
    const f = v.vehicle.frameNodes;
    const o = v.nodeStart + f[0]!;
    const a = v.nodeStart + f[1]!;
    const t = v.nodeStart + f[2]!;
    let fx = s.posX[a]! - s.posX[o]!;
    let fy = s.posY[a]! - s.posY[o]!;
    let fz = s.posZ[a]! - s.posZ[o]!;
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    let ux = s.posX[t]! - s.posX[o]!;
    let uy = s.posY[t]! - s.posY[o]!;
    let uz = s.posZ[t]! - s.posZ[o]!;
    const ud = ux * fx + uy * fy + uz * fz;
    ux -= ud * fx;
    uy -= ud * fy;
    uz -= ud * fz;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    out[0] = s.posX[o]!;
    out[1] = s.posY[o]!;
    out[2] = s.posZ[o]!;
    // right = forward × up; back = −forward
    out[3] = fy * uz - fz * uy;
    out[4] = fz * ux - fx * uz;
    out[5] = fx * uy - fy * ux;
    out[6] = ux;
    out[7] = uy;
    out[8] = uz;
    out[9] = -fx;
    out[10] = -fy;
    out[11] = -fz;
  }

  /** Trailer transform with its coupler on `towId`'s hitch ball, aligned with the tow's heading (sqrt-only). */
  private trailerPoseOnHitch(towId: number, cv: CompiledVehicle, trailerId: number): Transform {
    const tow = this.vehicles.get(towId);
    if (!tow) throw new SimCommandError(`trailer: tow ${towId} is not a vehicle`, trailerId);
    const hitchName = TOW_HITCH_NODES[tow.vehicle.name];
    const hi = hitchName === undefined ? -1 : tow.vehicle.rig.nodeIds.indexOf(hitchName);
    if (hi < 0) throw new SimCommandError(`trailer: vehicle '${tow.vehicle.name}' has no tow hitch`, trailerId);
    const B = new Float64Array(12);
    this.vehicleBasis(tow, B);
    let bx = -B[9]!;
    let bz = -B[11]!;
    const bl = Math.sqrt(bx * bx + bz * bz);
    bx /= bl;
    bz /= bl;
    const qy = facingQuat(bx, bz);
    const ci = cv.rig.nodeIds.indexOf('coupler');
    const cy = cv.rig.nodePos[3 * ci + 1]!;
    const cz = cv.rig.nodePos[3 * ci + 2]!;
    // Axle line (wheel hubs' mean z, rig-local; the tyres stand on rig y = 0).
    let za = 0;
    for (const w of cv.wheels) za += cv.rig.nodePos[3 * w.hubI + 2]!;
    za /= cv.wheels.length;
    const g = tow.nodeStart + hi;
    const s = this.state;
    const hx = s.posX[g]!;
    const hy = s.posY[g]!;
    const hz = s.posZ[g]!;
    // Ground under the axle (approximately: the hitch xz moved back along the heading by the drawbar length).
    const L = za - cz;
    const ground = this.sampler ? this.sampler.heightAt(hx - bx * L, hz - bz * L) : hy - cy;
    // Pitch θ about the trailer's x so the coupler meets the ball with the tyres on the ground:
    // cy·cosθ + L·sinθ = hy − ground (two fixed-point passes, sqrt only).
    const dy = hy - ground;
    let sn = (dy - cy) / L;
    for (let k = 0; k < 2; k++) {
      if (sn > 0.5) sn = 0.5;
      if (sn < -0.5) sn = -0.5;
      sn = (dy - cy * Math.sqrt(1 - sn * sn)) / L;
    }
    if (sn > 0.5) sn = 0.5;
    if (sn < -0.5) sn = -0.5;
    const cs = Math.sqrt(1 - sn * sn);
    const qp: [number, number, number, number] = [(sn >= 0 ? 1 : -1) * Math.sqrt((1 - cs) / 2), 0, 0, Math.sqrt((1 + cs) / 2)];
    const q = quatMul(qy, qp);
    // Coupler offset under (yaw ∘ pitch): pitch about x first, then yaw.
    const cy2 = cy * cs - cz * sn;
    const cz2 = cy * sn + cz * cs;
    const ys = qy[1];
    const yc = qy[3];
    const cosY = 1 - 2 * ys * ys;
    const sinY = 2 * ys * yc;
    const px = hx - sinY * cz2;
    const pz = hz - cosY * cz2;
    return { pos: [px, hy - cy2 + 0.003, pz], quat: q };
  }

  /** After a tow vehicle was reset / recovered: its hitched trailers follow onto the hitch (repaired couplings, re-armed). */
  private replaceTrailersOf(towId: number): void {
    for (const t of this.towing.trailers.values()) {
      if (t.tow?.objectId !== towId) continue;
      const tid = t.trailer.objectId;
      const tv = this.vehicles.get(tid);
      if (!tv) continue;
      this.reset(tid, this.trailerPoseOnHitch(towId, tv.vehicle, tid), 0.4);
      this.hitchTrailer(tid, towId);
    }
  }

  /**
   * R-PHYS2 protocol `spawnTrailer`: spawns a trailer (kind 'utility' | 'box',
   * optional ballast kg at deck z) and, with `towObjectId`, places it on the
   * tow vehicle's hitch ball (aligned with its heading) and hitches it. A
   * 0.4 s spawn settle applies; the coupling cannot break for COUPLING_ARM_S.
   */
  spawnTrailer(objectId: number, kind: TrailerKind, o: { towObjectId?: number; transform?: Transform; ballastKg?: number; ballastZ?: number } = {}): SimObject {
    if (kind !== 'utility' && kind !== 'box') throw new SimCommandError(`unknown trailer kind '${String(kind)}'`, objectId);
    const ballastKg = o.ballastKg ?? 0;
    const ballastZ = o.ballastZ ?? 0;
    if (!(Number.isFinite(ballastKg) && ballastKg >= 0 && ballastKg <= 2000 && Number.isFinite(ballastZ))) throw new SimCommandError('spawnTrailer: invalid ballast', objectId);
    const cv = this.compiledTrailer(kind, ballastKg, ballastZ);
    let transform = o.transform;
    if (o.towObjectId !== undefined) transform = this.trailerPoseOnHitch(o.towObjectId, cv, objectId);
    if (!transform) throw new SimCommandError('spawnTrailer: needs towObjectId or transform', objectId);
    const obj = this.spawnCompiledVehicle(objectId, cv, transform, 'manual');
    this.setInput(objectId, { gearSelect: 0, throttle: 0 });
    this.startSettle(objectId, Math.round(0.4 / SIM_DT));
    if (o.towObjectId !== undefined) this.hitchTrailer(objectId, o.towObjectId);
    return obj;
  }

  /** R-PHYS2 protocol `hitchTrailer`: couples a trailer to a tow vehicle's hitch (null = unhitch). */
  hitchTrailer(trailerId: number, towObjectId: number | null): void {
    const t = this.vehicles.get(trailerId);
    const tObj = this.arena.get(trailerId);
    if (!t || !tObj || !t.vehicle.rig.nodeIds.includes('coupler')) throw new SimCommandError(`hitchTrailer: ${trailerId} is not a trailer`, trailerId);
    if (towObjectId === null) {
      this.towing.unhitch(tObj);
      this.syncTowPairs();
      return;
    }
    const tow = this.vehicles.get(towObjectId);
    const towObj = this.arena.get(towObjectId);
    const hitchName = tow ? TOW_HITCH_NODES[tow.vehicle.name] : undefined;
    if (!tow || !towObj || hitchName === undefined) throw new SimCommandError(`hitchTrailer: ${towObjectId} cannot tow`, trailerId);
    this.towing.hitch(tObj, t.vehicle.rig, towObj, tow.vehicle.rig, hitchName, t.vehicle.name === 'trailerBox', this.tick + Math.round(COUPLING_ARM_S / SIM_DT), this.state);
    this.syncTowPairs();
  }

  /** Trailer ↔ tow pairs stay on node-vs-node spheres (ObjectContacts.triExcludedPairs). */
  private syncTowPairs(): void {
    const ex = this.contacts.triExcludedPairs;
    ex.clear();
    for (const t of this.towing.trailers.values()) if (t.tow) ex.add(pairKey(t.trailer.objectId, t.tow.objectId));
    this.contactsDirty = true;
  }

  /**
   * R-PHYS2 protocol `spawnCargo`: props placed on a carrier (pickup bed, box
   * truck, trailer deck) at a rig-local point of the carrier (the prop's base
   * centre), optionally turned (rig-local facing) and strapped down. Atomic:
   * everything is validated first. Cargo contacts the carrier through its
   * deck / wall surfaces (src/sim/trailer/carrier.ts).
   */
  spawnCargo(items: readonly { objectId: number; prop: PropKey; carrierObjectId: number; pos: readonly [number, number, number]; facing?: readonly [number, number]; strap?: boolean }[]): void {
    if (!Array.isArray(items)) throw new SimCommandError('spawnCargo: items must be an array');
    items.forEach((it, i) => {
      const where = `spawnCargo.items[${i}]`;
      if (!it || typeof it !== 'object') throw new SimCommandError(`${where}: not an object`);
      if (!this.towing.carrierOf(it.carrierObjectId)) throw new SimCommandError(`${where}: ${it.carrierObjectId} is not a carrier`);
      if (!Array.isArray(it.pos) || it.pos.length !== 3 || !it.pos.every(Number.isFinite)) throw new SimCommandError(`${where}: invalid pos`);
      if (it.facing !== undefined && !(Array.isArray(it.facing) && it.facing.length === 2 && Math.abs(it.facing[0] * it.facing[0] + it.facing[1] * it.facing[1] - 1) < 1e-3)) throw new SimCommandError(`${where}: facing must be a unit (x, z)`);
    });
    const B = new Float64Array(12);
    const spawns: PropSpawn[] = items.map((it) => {
      const v = this.vehicles.get(it.carrierObjectId)!;
      this.vehicleBasis(v, B);
      const rig = v.vehicle.rig;
      const o = v.vehicle.frameNodes[0]!;
      const lx = it.pos[0] - rig.nodePos[3 * o]!;
      const ly = it.pos[1] - rig.nodePos[3 * o + 1]!;
      const lz = it.pos[2] - rig.nodePos[3 * o + 2]!;
      const pos: [number, number, number] = [B[0]! + B[3]! * lx + B[6]! * ly + B[9]! * lz, B[1]! + B[4]! * lx + B[7]! * ly + B[10]! * lz, B[2]! + B[5]! * lx + B[8]! * ly + B[11]! * lz];
      // Rotation: carrier basis × local yaw (facing), as a quaternion (sqrt-only).
      const f = it.facing ?? [0, -1];
      const qy = facingQuat(f[0], f[1]);
      return { objectId: it.objectId, prop: it.prop, transform: { pos, quat: quatMul(matToQuat(B), qy) }, asleep: false };
    });
    this.spawnProps(spawns);
    items.forEach((it) => {
      const cargo = this.arena.get(it.objectId)!;
      const carrier = this.towing.carrierOf(it.carrierObjectId)!;
      const v = this.vehicles.get(it.carrierObjectId)!;
      // Carried along: the carrier's velocity at the frame origin.
      const s = this.state;
      const og = v.nodeStart + v.vehicle.frameNodes[0]!;
      for (let i = cargo.nodeStart; i < cargo.nodeStart + cargo.nodeCount; i++) {
        s.velX[i] = s.velX[og]!;
        s.velY[i] = s.velY[og]!;
        s.velZ[i] = s.velZ[og]!;
      }
      this.towing.load(cargo, carrier, v.vehicle.rig, compilePropRig(it.prop), v.vehicle.name, !!it.strap, this.tick + Math.round(COUPLING_ARM_S / SIM_DT), s, this.contacts.excludedPairs, pairKey);
    });
    this.contactsDirty = true;
  }

  /** R-PHYS2 protocol `setCargoDoor`: opens / closes a carrier's doors (box rear doors) or a trailer's tailgate latch. */
  setCargoDoor(objectId: number, open: boolean): void {
    const v = this.vehicles.get(objectId);
    const obj = this.arena.get(objectId);
    if (!v || !obj || !this.towing.carrierOf(objectId)) throw new SimCommandError(`setCargoDoor: ${objectId} is not a carrier`, objectId);
    this.towing.setDoors(objectId, open);
    // Latched gates (utility trailer): the gt_* → sd4_* latch beams.
    const rig = v.vehicle.rig;
    const s = this.state;
    for (const side of ['L', 'R']) {
      const a = rig.nodeIds.indexOf(`gt_${side}`);
      const b = rig.nodeIds.indexOf(`sd4_${side}`);
      if (a < 0 || b < 0) continue;
      for (let k = 0; k < rig.beamCount; k++) {
        const ba = rig.beamA[k]!;
        const bb = rig.beamB[k]!;
        if (!((ba === a && bb === b) || (ba === b && bb === a))) continue;
        const g = obj.beamStart + k;
        if (open) s.active[g] = 0;
        else {
          const dx = s.posX[obj.nodeStart + a]! - s.posX[obj.nodeStart + b]!;
          const dy = s.posY[obj.nodeStart + a]! - s.posY[obj.nodeStart + b]!;
          const dz = s.posZ[obj.nodeStart + a]! - s.posZ[obj.nodeStart + b]!;
          // Re-latch only a gate that is (nearly) shut.
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) < s.restLen[g]! + 0.05) s.active[g] = 1;
        }
      }
    }
    this.contactsDirty = true;
  }

  // ------------------------------------------------------------------ props (P5)
  /** Vehicle flood level 0..1 (water), or undefined for a non-vehicle. */
  floodLevel(objectId: number): number | undefined {
    const w = this.vehicles.get(objectId)?.water;
    if (w) return w.flood;
    return this.floods.get(objectId)?.level;
  }

  /** The prop runtime of objectId, if it is a prop. */
  getProp(objectId: number): PropRuntime | undefined {
    return this.props.get(objectId);
  }

  /**
   * Spawns one catalog prop (compiled rig cached per key). `asleep`
   * (default true) freezes it in the rest pose until woken.
   */
  spawnProp(objectId: number, key: PropKey, transform: Transform, asleep = true): SimObject {
    if (!isPropKey(key)) throw new SimCommandError(`unknown prop key '${String(key)}'`, objectId);
    const def = getPropDef(key);
    const rig = compilePropRig(key);
    const obj = this.spawnCompiled(objectId, rig, transform);
    const anchor: number[] = [];
    for (let b = 0; b < rig.beamCount; b++) {
      if (rig.nodeInvMass[rig.beamA[b]!] === 0 || rig.nodeInvMass[rig.beamB[b]!] === 0) anchor.push(b);
    }
    this.props.set(objectId, {
      key,
      def,
      spawn: { pos: [transform.pos[0], transform.pos[1], transform.pos[2]], quat: [transform.quat[0], transform.quat[1], transform.quat[2], transform.quat[3]] },
      anchorBeams: Int32Array.from(anchor),
      stillS: 0,
      moved: false,
      sleepBox: new Float64Array(6),
      sleepRmax: 0,
      fluid: createFluidState(def, rig),
    });
    this.addPropLinks(obj, def, rig);
    const rail = key === 'guardrail' || key === 'guardrailEnd' ? createRailSurface(obj, rig) : null;
    if (rail) this.railById.set(objectId, rail);
    this.syncVehicles();
    this.setAsleep(obj, asleep);
    return obj;
  }

  /**
   * Puts an object to sleep (velocities and forces zeroed, skipped by every
   * pass, its current node box stored for the broadphase) or wakes it.
   */
  setAsleep(obj: SimObject, asleep: boolean): void {
    const rt = this.props.get(obj.objectId);
    if (rt) {
      rt.stillS = 0;
      rt.moved = false;
    }
    this.contactsDirty = true;
    if (!asleep) {
      obj.flags &= ~SIM_OBJECT_FLAG_SLEEPING;
      return;
    }
    obj.flags |= SIM_OBJECT_FLAG_SLEEPING;
    const s = this.state;
    const end = obj.nodeStart + obj.nodeCount;
    const box = rt?.sleepBox;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    let rmax = 0;
    for (let i = obj.nodeStart; i < end; i++) {
      s.velX[i] = 0;
      s.velY[i] = 0;
      s.velZ[i] = 0;
      s.frcX[i] = 0;
      s.frcY[i] = 0;
      s.frcZ[i] = 0;
      if ((s.flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
      x0 = Math.min(x0, s.posX[i]!);
      y0 = Math.min(y0, s.posY[i]!);
      z0 = Math.min(z0, s.posZ[i]!);
      x1 = Math.max(x1, s.posX[i]!);
      y1 = Math.max(y1, s.posY[i]!);
      z1 = Math.max(z1, s.posZ[i]!);
      rmax = Math.max(rmax, s.objRadius[i]!);
    }
    if (box && rt) {
      box[0] = x0;
      box[1] = y0;
      box[2] = z0;
      box[3] = x1;
      box[4] = y1;
      box[5] = z1;
      rt.sleepRmax = rmax;
    }
  }

  /**
   * Protocol `spawnProps`: atomic batch. Every item is validated first
   * (key, id in the dynamic range, unique and unused, capacity); any
   * failure throws naming the first bad item and nothing spawns.
   */
  spawnProps(items: readonly PropSpawn[]): void {
    if (!Array.isArray(items)) throw new SimCommandError('spawnProps: items must be an array');
    const s = this.state;
    const seen = new Set<number>();
    let nodes = 0;
    let beams = 0;
    items.forEach((it, i) => {
      const where = `spawnProps.items[${i}]`;
      if (!it || typeof it !== 'object') throw new SimCommandError(`${where}: not an object`);
      const id = it.objectId;
      if (!Number.isInteger(id) || id < PROP_DYNAMIC_ID_BASE || id >= PROP_DYNAMIC_ID_BASE + PROP_DYNAMIC_MAX) {
        throw new SimCommandError(`${where}: objectId ${String(id)} outside the dynamic prop range`, id);
      }
      if (seen.has(id) || this.arena.indexOf(id) >= 0) throw new SimCommandError(`${where}: objectId ${id} already in use`, id);
      seen.add(id);
      if (!isPropKey(it.prop)) throw new SimCommandError(`${where}: unknown prop key '${String(it.prop)}'`, id);
      const t = it.transform;
      if (!t || !Array.isArray(t.pos) || !Array.isArray(t.quat) || t.pos.length !== 3 || t.quat.length !== 4 || ![...t.pos, ...t.quat].every(Number.isFinite)) {
        throw new SimCommandError(`${where}: invalid transform`, id);
      }
      if (it.asleep !== undefined && typeof it.asleep !== 'boolean') throw new SimCommandError(`${where}: asleep must be a boolean`, id);
      const rig = compilePropRig(it.prop);
      nodes += rig.nodeCount;
      beams += rig.beamCount;
    });
    if (this.arena.objects.length + items.length > this.arena.maxObjects) throw new SimCommandError(`spawnProps: object capacity ${this.arena.maxObjects} exceeded`);
    if (s.nodeCount + nodes > s.nodeCapacity) throw new SimCommandError(`spawnProps: node capacity ${s.nodeCapacity} exceeded`);
    if (s.beamCount + beams > s.beamCapacity) throw new SimCommandError(`spawnProps: beam capacity ${s.beamCapacity} exceeded`);
    for (const it of items) this.spawnProp(it.objectId, it.prop, it.transform, it.asleep ?? true);
    this.joinProps();
  }

  /** R-PHYS2: joins end-to-end segments of joinable props (pinned barrier runs; props/joins.ts). */
  private joinProps(): void {
    const list: { obj: SimObject; key: PropKey; rig: CompiledRig }[] = [];
    for (const o of this.arena.objects) {
      const rt = this.props.get(o.objectId);
      if (rt && PROP_JOINS[rt.key] !== undefined) list.push({ obj: o, key: rt.key, rig: compilePropRig(rt.key) });
    }
    if (list.length > 1) joinProps(this.towing.joints, this.state, list, this.onPropJoin);
  }

  /** Spliced guardrail panels never collide with each other (their end columns coincide). */
  private readonly onPropJoin = (a: SimObject, b: SimObject, exclusive: boolean, endA: number, endB: number): void => {
    // A spliced end is no longer a terminal: its anchor cable goes.
    const ta = `panchor:${a.objectId}:${endA}`;
    const tb = `panchor:${b.objectId}:${endB}`;
    this.towing.joints.remove((j) => j.tag === ta || j.tag === tb);
    if (!exclusive) return;
    this.contacts.excludedPairs.add(pairKey(a.objectId, b.objectId));
    this.contactsDirty = true;
  };

  /** R-PHYS2: a prop's implicit members (PropDef.links: guardrail rail tension, anchor cables). */
  private addPropLinks(obj: SimObject, def: PropDef, rig: CompiledRig): void {
    const links = def.links;
    if (!links) return;
    // A dense stiff network: solve the joints with PROP_LINK_ITERATIONS Gauss-Seidel sweeps from now on.
    if (this.towing.joints.iterations < PROP_LINK_ITERATIONS) this.towing.joints.iterations = PROP_LINK_ITERATIONS;
    for (const l of links) {
      const a = rig.nodeIds.indexOf(l.a);
      const b = rig.nodeIds.indexOf(l.b);
      if (a < 0 || b < 0) throw new Error(`prop ${def.key}: link ${l.a}–${l.b} names a missing node`);
      const dx = rig.nodePos[3 * b]! - rig.nodePos[3 * a]!;
      const dy = rig.nodePos[3 * b + 1]! - rig.nodePos[3 * a + 1]!;
      const dz = rig.nodePos[3 * b + 2]! - rig.nodePos[3 * a + 2]!;
      const tag = l.end === undefined ? `plink:${obj.objectId}` : `panchor:${obj.objectId}:${l.end}`;
      const ball = l.kind === 'ball';
      const kind = ball ? JointKind.ball : l.kind === 'rope' ? JointKind.rope : JointKind.link;
      const spec: JointSpec = { kind, tag, objA: obj, nodeA: a, objB: obj, nodeB: b, k: l.k, c: l.c, rest: ball ? 0 : Math.sqrt(dx * dx + dy * dy + dz * dz), play: l.play ?? 0, breakF: l.breakF };
      if (l.kind === 'strut') spec.strut = true;
      if (l.yieldF !== undefined) spec.yieldF = l.yieldF;
      if (l.ruptureStrain !== undefined) spec.ruptureStrain = l.ruptureStrain;
      if (l.chain) spec.chain = true;
      this.towing.joints.add(spec);
    }
  }

  /**
   * Layout props (worker, on groundHeightfield): checks the capacity (all
   * or nothing), despawns every previous layout prop, then spawns the
   * instances asleep (objectId per instance).
   */
  spawnLayoutProps(instances: readonly PropInstance[]): void {
    const old = this.arena.objects.filter((o) => isLayoutPropId(o.objectId));
    // Capacity first (all or nothing), counting the layout props this replaces.
    const s = this.state;
    let nodes = s.nodeCount;
    let beams = s.beamCount;
    for (const o of old) {
      nodes -= o.nodeCount;
      beams -= o.beamCount;
    }
    for (const inst of instances) {
      if (!isPropKey(inst.prop)) throw new SimCommandError(`layout prop ${inst.id}: unknown key '${String(inst.prop)}'`);
      const rig = compilePropRig(inst.prop);
      nodes += rig.nodeCount;
      beams += rig.beamCount;
    }
    if (this.arena.objects.length - old.length + instances.length > this.arena.maxObjects) {
      throw new SimCommandError(`${instances.length} layout props exceed the object capacity ${this.arena.maxObjects}`);
    }
    if (nodes > s.nodeCapacity) throw new SimCommandError(`layout props exceed the node capacity ${s.nodeCapacity}`);
    if (beams > s.beamCapacity) throw new SimCommandError(`layout props exceed the beam capacity ${s.beamCapacity}`);
    for (const o of old) this.despawn(o.objectId);
    for (const inst of instances) this.spawnProp(inst.objectId, inst.prop, inst.transform, true);
    this.joinProps();
  }

  /**
   * Protocol `resetProps`: full repair + re-place at the spawn transform,
   * asleep; omitted ids = every layout prop. Unknown / non-prop ids throw
   * before anything changes.
   */
  resetProps(objectIds?: readonly number[]): void {
    let ids: number[];
    if (objectIds === undefined) {
      ids = this.arena.objects.filter((o) => isLayoutPropId(o.objectId)).map((o) => o.objectId);
    } else {
      if (!Array.isArray(objectIds)) throw new SimCommandError('resetProps: objectIds must be an array');
      for (const id of objectIds) {
        if (!isPropObjectId(id) || !this.props.has(id)) throw new SimCommandError(`resetProps: ${String(id)} is not a live prop`, id);
      }
      ids = [...objectIds];
    }
    for (const id of ids) {
      const rt = this.props.get(id)!;
      this.reset(id, rt.spawn);
      this.setAsleep(this.arena.get(id)!, true);
    }
  }

  despawn(objectId: number): void {
    const obj = this.arena.get(objectId);
    if (!obj) throw new SimCommandError(`unknown objectId ${objectId}`, objectId);
    const start = obj.nodeStart;
    const n = obj.nodeCount;
    this.towing.removeObject(obj, this.contacts.excludedPairs, pairKey);
    this.syncTowPairs();
    this.arena.remove(objectId);
    this.autopilots.remove(objectId);
    this.rigs.delete(objectId);
    const gone = this.vehicles.get(objectId);
    if (gone?.shell) for (const c of gone.shell) this.kernel.releaseShell(c);
    if (gone) this.kernel.releaseWheels?.(gone.wheels);
    this.vehicles.delete(objectId);
    this.triById.delete(objectId);
    this.debris.delete(objectId);
    this.railById.delete(objectId);
    this.props.delete(objectId);
    this.floods.delete(objectId);
    const epoch = this.repairEpochs.get(objectId);
    if (epoch !== undefined) this.retiredEpochs.set(objectId, epoch);
    this.repairEpochs.delete(objectId);
    this.catalogIds.delete(objectId);
    this.settles.delete(objectId);
    this.events.muted.delete(objectId);
    resetGroundContactState(this.state, start, this.state.nodeCount + n - start);
    resetColliderContactState(this.state, start, this.state.nodeCount + n - start);
    this.syncVehicles();
    this.contacts.clear();
    this.tris.clear();
    this.contactsDirty = true;
  }

  reset(objectId: number, transform: Transform, settle?: number): void {
    const rig = this.rigs.get(objectId);
    if (!rig) throw new SimCommandError(`unknown objectId ${objectId}`, objectId);
    const settleTicks = settleTicksOf(settle, objectId);
    let obj: SimObject;
    try {
      obj = this.arena.reset(objectId, rig, transform);
    } catch (e) {
      throw new SimCommandError(e instanceof Error ? e.message : String(e), objectId);
    }
    resetGroundContactState(this.state, obj.nodeStart, obj.nodeCount);
    resetColliderContactState(this.state, obj.nodeStart, obj.nodeCount);
    this.repairEpochs.set(objectId, ((this.repairEpochs.get(objectId) ?? 0) + 1) >>> 0);
    this.autopilots.resetTimers(objectId);
    const v = this.vehicles.get(objectId);
    if (v) resetVehicleRuntime(v);
    if (v?.water) drainVehicleWater(v.water, true);
    const dbr = this.debris.get(objectId);
    if (dbr) {
      // The arena reloaded the rig's masses: frozen islands are gone with the damage.
      dbr.islands = [];
      dbr.broken = 0;
    }
    const pr = this.props.get(objectId);
    if (pr?.fluid) resetFluidState(pr.fluid, pr.def);
    // Couplings of a repaired object are repaired too (pinned barrier segments, cargo straps).
    if (this.towing.joints.size > 0) this.towing.joints.repair((j) => j.objA === obj || j.objB === obj);
    const fl = this.floods.get(objectId);
    if (fl) fl.level = 0;
    // A sleeping object stays asleep at the new pose: refresh its broadphase box.
    if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) this.setAsleep(obj, true);
    this.contactsDirty = true;
    // The beams were just reloaded from the rig: a window still open ends here (or restarts).
    this.settles.delete(objectId);
    this.events.muted.delete(objectId);
    if (settleTicks > 0) this.startSettle(objectId, settleTicks);
    if (v && this.towing.trailers.size > 0) this.replaceTrailersOf(objectId);
  }

  /**
   * Spawn settle (spawnVehicle / reset `settle`): for `ticks` steps the
   * object's beams neither yield nor break (deform / break thresholds lifted
   * to Infinity) and its impact / skid events are dropped, while it drops
   * the last centimetres onto its suspension and the preloaded shocks /
   * rest-pose sag find their equilibrium. The thresholds come back from the
   * compiled rig when the window ends (nothing yields meanwhile, so they are
   * the rig's values). Deterministic: the window is part of the logged
   * command and ends at a fixed tick.
   */
  private startSettle(objectId: number, ticks: number): void {
    const obj = this.arena.get(objectId);
    if (!obj) return;
    const s = this.state;
    for (let b = obj.beamStart, e = obj.beamStart + obj.beamCount; b < e; b++) {
      s.deform[b] = Infinity;
      s.breakF[b] = Infinity;
    }
    const end = this.tick + ticks;
    this.settles.set(objectId, end);
    this.events.muted.add(objectId);
    if (end < this.nextSettleEnd) this.nextSettleEnd = end;
  }

  /** Ends every settle window due at this tick (restores the rig's thresholds). */
  private expireSettles(): void {
    let next = Infinity;
    for (const [id, end] of this.settles) {
      if (end > this.tick) {
        if (end < next) next = end;
        continue;
      }
      this.settles.delete(id);
      this.events.muted.delete(id);
      const obj = this.arena.get(id);
      const rig = this.rigs.get(id);
      if (!obj || !rig) continue;
      const s = this.state;
      for (let i = 0; i < rig.beamCount; i++) {
        const b = obj.beamStart + i;
        s.deform[b] = rig.beamDeform[i]!;
        s.breakF[b] = rig.beamBreakF[i]!;
      }
    }
    this.nextSettleEnd = next;
  }

  /** Remaining settle ticks of `objectId` (0 = not settling). */
  settleTicksLeft(objectId: number): number {
    const end = this.settles.get(objectId);
    return end === undefined ? 0 : Math.max(0, end - this.tick);
  }

  /** Merges named actions (clamped to ACTION_RANGES; gearSelect rounded). */
  setInput(objectId: number, actions: Partial<ActionState>): void {
    const obj = this.arena.get(objectId);
    if (!obj) throw new SimCommandError(`unknown objectId ${objectId}`, objectId);
    if (!actions || typeof actions !== 'object') throw new SimCommandError('actions must be an object', objectId);
    for (let i = 0; i < ACTION_NAMES.length; i++) {
      const v = actions[ACTION_NAMES[i]!];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new SimCommandError(`action ${ACTION_NAMES[i]} must be a finite number`, objectId);
      }
    }
    for (let i = 0; i < ACTION_NAMES.length; i++) {
      const v = actions[ACTION_NAMES[i]!];
      if (v !== undefined) this.setAction(obj, i, v);
    }
  }

  /**
   * P8 protocol `setAutopilot`: a worker-side driver for a vehicle (challenge
   * opponents). Unknown / non-vehicle object, bad mode or target → error.
   * 'off' removes it and zeroes the object's actions.
   */
  setAutopilot(msg: SetAutopilotMsg): void {
    const id = msg.objectId;
    if (!this.vehicles.has(id)) throw new SimCommandError(`setAutopilot: objectId ${id} is not a vehicle`, id);
    if (msg.mode !== 'off' && msg.mode !== 'ram') throw new SimCommandError(`setAutopilot: unknown mode ${String(msg.mode)}`, id);
    if (msg.targetObjectId !== undefined && !Number.isInteger(msg.targetObjectId)) throw new SimCommandError('setAutopilot: targetObjectId must be an integer', id);
    if (msg.aggression !== undefined && !(typeof msg.aggression === 'number' && Number.isFinite(msg.aggression))) throw new SimCommandError('setAutopilot: aggression must be a finite number', id);
    this.autopilots.set(msg);
    if (msg.mode === 'off') {
      const obj = this.arena.get(id);
      if (obj) for (let i = 0; i < obj.actions.length; i++) obj.actions[i] = 0;
    }
  }

  /** AutopilotHost: [origin, front, top] global node indices of a vehicle's frame. */
  frameNodesOf(objectId: number, out: Int32Array): boolean {
    const v = this.vehicles.get(objectId);
    if (!v) return false;
    const f = v.vehicle.frameNodes;
    out[0] = v.nodeStart + f[0]!;
    out[1] = v.nodeStart + f[1]!;
    out[2] = v.nodeStart + f[2]!;
    return true;
  }

  /** AutopilotHost: one action of an object by index (clamped). */
  setObjectAction(objectId: number, index: number, value: number): boolean {
    const obj = this.arena.get(objectId);
    if (!obj) return false;
    this.setAction(obj, index, value);
    return true;
  }

  /** Sets one action by index (clamped). */
  /**
   * R-CORE solver options (`setSolver`, logged + replayed). Missing fields
   * keep their value. Validated: every given field must be a boolean.
   */
  setSolver(options: Partial<SolverOptions>): void {
    if (!options || typeof options !== 'object') throw new SimCommandError('setSolver: options must be an object');
    for (const key of SOLVER_OPTION_KEYS) {
      const v = options[key];
      if (v !== undefined && typeof v !== 'boolean') throw new SimCommandError(`setSolver: ${key} must be a boolean`);
    }
    for (const key of SOLVER_OPTION_KEYS) {
      const v = options[key];
      if (v !== undefined) this.solver[key] = v;
    }
    this.contactsDirty = true;
  }

  setAction(obj: SimObject, index: number, value: number): void {
    const r = ACTION_RANGES[index];
    if (!r) throw new SimCommandError(`invalid action index ${index}`, obj.objectId);
    let v = index === Action.gearSelect ? Math.round(value) : value;
    if (v < r[0]) v = r[0];
    if (v > r[1]) v = r[1];
    obj.actions[index] = v;
  }

  /**
   * One fixed step (SIM_DT): per object ascending → [vehicle pre-step] →
   * hydro drive → beams → ground → static colliders → integrate.
   */
  step(): void {
    if (this.tick >= this.nextSettleEnd) this.expireSettles();
    const tow = this.towing.busy ? this.towing : null;
    if (tow !== null) tow.preStep(this.wakeObject);
    // P6: traffic driver model + scheduler at the START of every TRAFFIC_AI_TICKS-th tick (may spawn/despawn).
    if (this.traffic !== null && this.tick % TRAFFIC_AI_TICKS === 0) this.traffic.update(this);
    if (this.autopilots.size > 0 && this.tick % TRAFFIC_AI_TICKS === 0) this.autopilots.update(this);
    const s = this.state;
    const objs = this.arena.objects;
    const sampler = this.sampler;
    const sink = this.events;
    const dbg = this.debugStrains;
    const gx = this.gravityX;
    const gy = this.gravityY;
    const gz = this.gravityZ;
    const restLen = s.restLen;
    const vslots = this.vehicleSlots;
    const pslots = this.propSlots;
    const cw = this.colliderWorld;
    const kern = this.kernel;
    // The wheel kernels' ground is module state: point it at THIS engine's
    // ground every step (several engines may coexist, e.g. in tests).
    const rutS = this.rutSampler;
    if (this.vehicles.size > 0) {
      setWheelGround(sampler, this.materials, SIM_DT);
      setTyreEnvironment(this.wetness, this.rain);
      setSoilRutHook(this.softGroundOn ? this.rutHook : null);
    }
    setActiveKernel(kern);
    kern.beginTick?.();
    if (this.contactsDirty || this.tick >= this.nextRebuild) this.broadphase();
    // R-PHYS2: which objects are near ruts this tick (their wheels + ground use the rutted sampler).
    const ruts = this.softGroundOn && this.softGround.tileCount > 0;
    if (this.nearRuts.length < objs.length) this.nearRuts = new Uint8Array(2 * objs.length);
    const near = this.nearRuts;
    // Phase 1, per awake object ascending: vehicle pre-step → hydros → beams (+ prop damping).
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
      let nr = 0;
      if (ruts) {
        // The broadphase box (≤ 16 ticks old) padded by the motion since.
        const b = 6 * o;
        const ob = this.contacts.oBox;
        const pad = this.contacts.oVmax[o]! * OBJ_REBUILD_TICKS_SLOW * SIM_DT + 0.5;
        nr = this.softGround.anyTileIn(ob[b]! - pad, ob[b + 2]! - pad, ob[b + 3]! + pad, ob[b + 5]! + pad) ? 1 : 0;
      }
      near[o] = nr;
      const veh = vslots[o];
      if (veh) {
        if (nr === 1) setWheelGround(rutS, this.materials, SIM_DT);
        vehiclePreStep(s, veh, obj.actions, SIM_DT);
        if (nr === 1) setWheelGround(sampler, this.materials, SIM_DT);
      }
      const hb = obj.hydroBeams;
      if (hb.length > 0) {
        const steer = obj.actions[Action.steer]!;
        const base = obj.hydroBase;
        const travel = obj.hydroTravel;
        for (let h = 0; h < hb.length; h++) restLen[hb[h]!] = base[h]! * (1 + travel[h]! * steer);
      }
      kern.beams(obj.beamStart, obj.beamCount, sink, dbg, veh ? shellCrashArmed(veh.shell) : false);
      const prop = pslots[o];
      if (prop) {
        const anchored = prop.anchorBeams.length > 0 && propAnchored(s, prop, obj.beamStart, sink);
        applyPropDamping(s, obj.nodeStart, obj.nodeCount, PROP_INTERNAL_DAMPING, anchored);
        if (prop.fluid !== null && this.tick % FLUID_TICKS === 0) stepPropFluid(s, obj, prop, this.gravityMag, SIM_DT);
      }
    }
    // Phase 2: node-vs-node contacts over the cached pair list (canonical order), then node-vs-triangle
    // (R-CORE: object triangles, self-collision, static meshes; canonical order).
    if (this.contacts.pairCount > 0) this.contacts.apply(s, SIM_DT, sink);
    if (this.tris.pairCount > 0) this.tris.apply(s, SIM_DT, sink, gx, gy, gz, this.solver.ccd);
    // R-PHYS2: guardrail rail faces vs vehicle nodes (props/railContact.ts), then cross-object joints
    // (hitches, chains, straps, the rails' implicit members), then carrier surfaces (cargo on decks / beds).
    if (this.railList.length > 0 && this.railVehicles.length > 0) applyRailContacts(s, this.railList, this.railVehicles, this.contacts.oBox, this.railVehicleSlots, SIM_DT, gx, gy, gz, this.wakeObject);
    if (tow !== null) tow.apply(s, SIM_DT, this.tick, sink, gx, gy, gz);
    // Phase 3, per awake object ascending: water → ground → static colliders → integrate.
    const water = this.water;
    const c = this.contacts;
    const g = this.gravityMag;
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
      if (water.length > 0) {
        // Early-out on the broadphase box (≤ 16 ticks old, padded by the motion since).
        const b = 6 * o;
        const pad = c.oVmax[o]! * OBJ_REBUILD_TICKS_SLOW * SIM_DT + 0.5;
        if (boxNearWater(water, c.oBox[b]!, c.oBox[b + 1]!, c.oBox[b + 2]!, c.oBox[b + 3]!, c.oBox[b + 5]!, pad)) {
          const veh = vslots[o];
          const prop = pslots[o];
          const fl = this.floodSlots[o];
          if (veh && veh.water) {
            stepVehicleWater(s, veh.water, obj.nodeStart, obj.nodeCount, obj.beamStart, water, g, SIM_DT, veh.drivetrain.rpm);
            if (veh.water.hydrolocked !== 0) seizeHydrolocked(veh);
          } else if (veh && fl) {
            const bodyN = veh.vehicle.bodyNodeCount;
            const sum = applyWater(s, obj.nodeStart, obj.nodeCount, water, WATER_PHYSICS.vehicleDensity, g, SIM_DT, obj.nodeStart + bodyN, 1 - VEHICLE_FLOOD_LOSS * fl.level);
            if (sum > 0 && fl.level < 1) {
              const lv = fl.level + (SIM_DT * sum) / (bodyN * VEHICLE_FLOOD_TIME_S);
              fl.level = lv > 1 ? 1 : lv;
            }
          } else {
            applyWater(s, obj.nodeStart, obj.nodeCount, water, prop ? prop.def.density : WATER_PHYSICS.vehicleDensity, g, SIM_DT, obj.nodeStart, 1);
          }
        }
      }
      if (sampler !== null) {
        const sv = vslots[o];
        if (this.softGroundOn && sv) {
          applySoftGround(s, sv.wheels, this.softGround, rutS!, this.groundN, this.tick, SIM_DT, this.softGroundResistance);
          applyBodyDig(s, obj.nodeStart, sv.vehicle.bodyNodeCount, this.softGround, rutS!, this.groundN, this.tick, SIM_DT);
        }
        // Near ruts the rutted sampler (JS ground); elsewhere the plain ground (the kernel's mirror).
        kern.ground(obj.nodeStart, obj.nodeCount, near[o] === 1 ? rutS! : sampler, this.materials, SIM_DT, obj.objectId, sink, gx, gy, gz, cw !== null);
      }
      if (cw !== null) {
        applyColliderContacts(s, obj.nodeStart, obj.nodeCount, cw, this.materials, SIM_DT, obj.objectId, sink, gx, gy, gz, kern.objectBox?.(obj.nodeStart, obj.nodeCount));
      }
      // Feel pass: the rigid shell cluster sees every force of the tick (last pass before integration).
      const vsh = vslots[o]?.shell;
      if (vsh) for (let c = 0; c < vsh.length; c++) kern.shell(vsh[c]!, SIM_DT, gx, gy, gz);
      kern.integrate(obj.nodeStart, obj.nodeCount, SIM_DT, gx, gy, gz);
    }
    this.tick++;
  }

  /**
   * Broadphase rebuild (every OBJ_REBUILD_TICKS / _SLOW ticks, or right
   * after a command moved nodes): measures every object, puts still props
   * to sleep, wakes sleeping objects a MOVING awake object may reach within
   * the interval (once more through sleeping objects touching a woken one:
   * a stack wakes together), then rebuilds the node pair list.
   */
  private broadphase(): void {
    const s = this.state;
    const objs = this.arena.objects;
    const c = this.contacts;
    const pslots = this.propSlots;
    const n = objs.length;
    const elapsed = (this.tick - this.lastRebuild) * SIM_DT;
    c.objectCount = n;
    let allSlow = true;
    for (let o = 0; o < n; o++) {
      const obj = objs[o]!;
      const rt = pslots[o];
      const mat = rt ? rt.def.material : MaterialId.metal;
      if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0 && rt) {
        c.setStaticBox(o, obj.nodeStart, obj.nodeCount, obj.objectId, mat, rt.sleepBox, 0, rt.sleepRmax);
        continue;
      }
      const v = c.measureObject(s, o, obj.nodeStart, obj.nodeCount, obj.objectId, mat);
      if (v >= OBJ_SLOW_SPEED) allSlow = false;
      // Sleep: props still (max node speed below their threshold) for holdS.
      if (rt && !this.contactsDirty) {
        if (v < rt.def.sleep.linearSpeed) {
          rt.stillS += elapsed;
          if (rt.stillS >= (rt.moved ? rt.def.sleep.holdS : PROP_UNMOVED_HOLD_FRACTION * rt.def.sleep.holdS)) {
            this.setAsleep(obj, true);
            c.setStaticBox(o, obj.nodeStart, obj.nodeCount, obj.objectId, mat, rt.sleepBox, 0, rt.sleepRmax);
          }
        } else {
          rt.stillS = 0;
          rt.moved = true;
        }
      }
    }
    const interval = allSlow ? OBJ_REBUILD_TICKS_SLOW : OBJ_REBUILD_TICKS;
    // Wake: a moving awake object near a sleeping one (reachable within the interval).
    let woke = false;
    for (let p = 0; p < n; p++) {
      if (c.oStatic[p] !== 0 || c.oValid[p] === 0 || c.oVmax[p]! < PROP_WAKE_SPEED) continue;
      for (let q = 0; q < n; q++) {
        if (c.oStatic[q] === 0 || c.oValid[q] === 0) continue;
        if (!c.boxesNear(p, q, c.oRmax[p]! + c.oRmax[q]! + c.margin(p, q, interval, SIM_DT))) continue;
        this.wakeSlot(q);
        c.oStatic[q] = 2; // woken this pass (propagation source)
        woke = true;
      }
    }
    if (woke) {
      // Propagate UP through stacks: a sleeping object resting on a just-woken one (its box bottom
      // above the woken box's mid-height, boxes touching) wakes too, transitively, so a stack never
      // hovers over a moved base. Side neighbours are left to the mover rule above (a pushed prop wakes
      // the next one a rebuild later): waking the whole barrel wall cost 2 kHz stepping of drums
      // nothing touched.
      let grew = true;
      while (grew) {
        grew = false;
        for (let p = 0; p < n; p++) {
          if (c.oStatic[p] !== 2) continue;
          c.oStatic[p] = 4; // propagated from
          const midY = 0.5 * (c.oBox[6 * p + 1]! + c.oBox[6 * p + 4]!);
          for (let q = 0; q < n; q++) {
            if (c.oStatic[q] !== 1 || c.oValid[q] === 0) continue;
            if (c.oBox[6 * q + 1]! < midY) continue;
            if (!c.boxesNear(p, q, c.oRmax[p]! + c.oRmax[q]! + c.margin(p, q, interval, SIM_DT))) continue;
            this.wakeSlot(q);
            c.oStatic[q] = 2;
            grew = true;
          }
        }
      }
      for (let o = 0; o < n; o++) if (c.oStatic[o]! >= 2) c.oStatic[o] = 0;
    }
    if (this.props.size > 0) this.enforceAwakeBudget(interval);
    const triNeeded = this.markTriangleSlots(n, interval);
    if (this.debrisList.length > 0 && !this.contactsDirty) updateDebris(s, this.debrisList, this.debrisOrigins, elapsed, c.oBox, c.oVmax, n, this.debrisSlots);
    if (this.towing.cargo.size > 0) this.towing.rebuild(s, this.tick, c.excludedPairs, pairKey);
    c.rebuild(s, interval, SIM_DT, s.friction);
    if (triNeeded) this.rebuildTriangles(n, interval);
    else if (this.tris.pairCount > 0) this.tris.clear();
    this.rebuildInterval = interval;
    this.lastRebuild = this.tick;
    this.nextRebuild = this.tick + interval;
    this.contactsDirty = false;
  }

  /**
   * R-CORE: decides which slots collide through triangles this interval
   * (ObjectContacts.oTriangles: object pairs where both do skip spheres) and
   * resolves (lazily derives) the triangles that will be needed: with
   * triangleContact, objects with triangles whose boxes come within reach of
   * another such object; with selfCollision, every awake object with
   * triangles. Returns whether the triangle pass has work.
   */
  private markTriangleSlots(n: number, interval: number): boolean {
    const c = this.contacts;
    const ts = this.triSlots;
    const sol = this.solver;
    c.oTriangles.fill(0, 0, n);
    let any = this.tris.hasStatic;
    if (this.triById.size === 0) return any;
    if (sol.triangleContact) {
      for (let p = 0; p < n; p++) {
        const tp = ts[p];
        if (!tp || c.oValid[p] === 0) continue;
        for (let q = p + 1; q < n; q++) {
          const tq = ts[q];
          if (!tq || c.oValid[q] === 0) continue;
          if (c.oStatic[p] !== 0 && c.oStatic[q] !== 0) continue;
          const pad = c.oRmax[p]! + c.oRmax[q]! + c.margin(p, q, interval, SIM_DT) + TRI_REACH_PAD;
          if (!c.boxesNear(p, q, pad)) continue;
          if (!resolveTriangles(tp) || !resolveTriangles(tq)) continue;
          c.oTriangles[p] = 1;
          c.oTriangles[q] = 1;
          any = true;
        }
      }
    }
    if (sol.selfCollision) {
      for (let o = 0; o < n; o++) {
        const t = ts[o];
        if (t && c.oValid[o] !== 0 && c.oStatic[o] === 0 && resolveTriangles(t)) any = true;
      }
    }
    return any;
  }

  /** R-CORE: fills the triangle pass's slots (arena order) and rebuilds its pair list. */
  private rebuildTriangles(n: number, interval: number): void {
    const objs = this.arena.objects;
    const c = this.contacts;
    const t = this.tris;
    const self = this.solver.selfCollision;
    for (let o = 0; o < n; o++) {
      const obj = objs[o]!;
      const lazy = this.triSlots[o];
      const slot = lazy && (c.oTriangles[o] !== 0 || (self && c.oStatic[o] === 0)) ? resolveTriangles(lazy) : null;
      const prop = this.propSlots[o];
      const rig = this.rigs.get(obj.objectId);
      t.setObject(o, obj.nodeStart, obj.nodeCount, obj.beamStart, obj.objectId, prop ? prop.def.material : MaterialId.metal, rig?.nodeMaterial ?? null, slot);
    }
    t.rebuild(this.state, n, c.oBox, c.oVmax, c.oValid, c.oStatic, interval, SIM_DT, this.solver);
  }

  /**
   * Awake budget (PROP_AWAKE_BEAM_BUDGET, soft): over it, awake props slower
   * than PROP_BUDGET_SLEEP_SPEED that no moving object can reach within the
   * rebuild interval sleep now, slowest first (ties: slot order).
   */
  private enforceAwakeBudget(interval: number): void {
    const objs = this.arena.objects;
    const c = this.contacts;
    const pslots = this.propSlots;
    const n = objs.length;
    const cand = this.budgetOrder;
    cand.length = 0;
    let beams = 0;
    for (let o = 0; o < n; o++) {
      const obj = objs[o]!;
      if (!pslots[o] || (obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
      beams += obj.beamCount;
      if (c.oVmax[o]! < PROP_BUDGET_SLEEP_SPEED) cand.push(o);
    }
    if (beams <= PROP_AWAKE_BEAM_BUDGET || cand.length === 0) return;
    // Insertion sort by speed (stable, allocation-free; a handful of candidates).
    for (let i = 1; i < cand.length; i++) {
      const o = cand[i]!;
      const v = c.oVmax[o]!;
      let j = i - 1;
      while (j >= 0 && c.oVmax[cand[j]!]! > v) {
        cand[j + 1] = cand[j]!;
        j--;
      }
      cand[j + 1] = o;
    }
    for (let i = 0; i < cand.length && beams > PROP_AWAKE_BEAM_BUDGET; i++) {
      const o = cand[i]!;
      let reachable = false;
      for (let p = 0; p < n && !reachable; p++) {
        if (p === o || c.oStatic[p] !== 0 || c.oValid[p] === 0 || c.oVmax[p]! < PROP_WAKE_SPEED) continue;
        reachable = c.boxesNear(p, o, c.oRmax[p]! + c.oRmax[o]! + c.margin(p, o, interval, SIM_DT));
      }
      if (reachable) continue; // it would wake again at the next rebuild (ping-pong)
      const obj = objs[o]!;
      const rt = pslots[o]!;
      this.setAsleep(obj, true);
      c.setStaticBox(o, obj.nodeStart, obj.nodeCount, obj.objectId, rt.def.material, rt.sleepBox, 0, rt.sleepRmax);
      beams -= obj.beamCount;
    }
  }

  /** Wakes the object in arena slot `o` (broadphase). */
  private wakeSlot(o: number): void {
    const obj = this.arena.objects[o]!;
    obj.flags &= ~SIM_OBJECT_FLAG_SLEEPING;
    const rt = this.propSlots[o];
    if (rt) {
      rt.stillS = 0;
      rt.moved = false;
    }
  }

  /**
   * Fills an attached writer: header, objects (ascending id; vehicle
   * telemetry, zeros for plain rigs), nodes f64→f32, strains (debugStrains),
   * broken-beam bitset + repair epoch (P4),
   * then all pending events, which are cleared. Only call for snapshots that
   * will actually be sent.
   */
  writeSnapshot(writer: SnapshotWriter, timeScale = 1): void {
    const s = this.state;
    const objs = this.arena.objects;
    writer.begin(this.tick, this.simTime, timeScale);
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      // P8: the horn travels as an object flag (snapshot + live replay buffer)
      const i = writer.addObject(obj.objectId, obj.flags | (obj.actions[Action.horn]! >= 0.5 ? OBJECT_FLAG_HORN : 0), obj.nodeCount, obj.beamCount);
      writer.writeNodesSoA(i, s.posX, s.posY, s.posZ, obj.nodeStart);
      writer.writeStrains(i, s.strainOut, obj.beamStart);
      writer.writeBrokenBeams(i, s.active, obj.beamStart);
      writer.setRepairEpoch(i, this.repairEpochs.get(obj.objectId) ?? 0);
      const veh = this.vehicleSlots[o];
      if (veh) {
        const t = writeVehicleTelemetry(s, veh);
        for (let k = 0; k < TELEMETRY_SLOTS; k++) writer.setTelemetry(i, k, t[k]!);
        const x = writeVehicleTelemetryExt(veh);
        for (let k = 0; k < VEHICLE_EXT_SLOTS; k++) writer.setTelemetryExt(i, k, x[k]!);
        // R-TYRE: one wheel record per wheel (TPMS, tyre temperatures, grip)
        const vx = veh as VehicleRuntimeEx;
        const ty = vx.tyres;
        if (ty) {
          const bh = vx.brakeHeat;
          for (let w = 0; w < veh.wheels.length; w++) {
            const disc = bh && bh.mass[w]! > 0 ? bh.temp[w]! : tyreEnv.ambient;
            writer.pushWheel(fillWheelFrame(s, veh.wheels[w]!, ty[w]!, obj.objectId, disc, wheelScratch));
          }
        }
      }
    }
    if (this.traffic !== null) this.traffic.writeRecords(writer, this);
    this.events.flushTo(writer);
  }

  // ------------------------------------------------------------------ traffic (P6)
  /** Commands moved nodes outside the step (traffic promotions): rebuild the broadphase. */
  markMoved(): void {
    this.contactsDirty = true;
  }

  /**
   * Protocol `setTraffic` (FULL REPLACE): removes every agent and awake
   * traffic object, then (enabled, agents > 0) builds the route network from
   * `layout` + the installed heightfield, validates (TRAFFIC_BEAM_BUDGET),
   * compiles and settles each variant once, and places the ghosts. Throws
   * SimCommandError (traffic stays off) on a bad config.
   */
  setTraffic(
    cfg: { enabled: boolean; seed: number; variants: readonly TrafficVariantSpec[]; density: TrafficDensity; focusObjectId: number; bubble?: TrafficBubble },
    layout: WorldLayout | null,
  ): { routeHash: number; pathCount: number; agentCount: number; variants: { catalogId: string; nodeCount: number; settled: Float32Array }[] } {
    if (!cfg || typeof cfg !== 'object') throw new SimCommandError('setTraffic: config must be an object');
    if (this.traffic !== null) {
      this.traffic.clear(this);
      this.traffic = null;
    }
    const density = clampDensity(cfg.density);
    if (!cfg.enabled || density.agents === 0) return { routeHash: 0, pathCount: 0, agentCount: 0, variants: [] };
    if (!Number.isInteger(cfg.focusObjectId)) throw new SimCommandError('setTraffic: focusObjectId must be an integer');
    if (typeof cfg.seed !== 'number' || !Number.isFinite(cfg.seed)) throw new SimCommandError('setTraffic: seed must be a finite number');
    if (!this.terrain || !layout) throw new SimCommandError('setTraffic: needs the heightfield (groundHeightfield) first');
    if (!Array.isArray(cfg.variants) || cfg.variants.length === 0) throw new SimCommandError('setTraffic: at least one variant is required');
    const bubble = cfg.bubble;
    if (bubble !== undefined && !(Number.isFinite(bubble.promoteM) && Number.isFinite(bubble.demoteM) && bubble.promoteM > 0 && bubble.demoteM > bubble.promoteM)) {
      throw new SimCommandError('setTraffic: bubble needs 0 < promoteM < demoteM');
    }
    const compiled: { spec: TrafficVariantSpec; cv: CompiledVehicle }[] = [];
    cfg.variants.forEach((spec, i) => {
      if (!spec || typeof spec !== 'object' || typeof spec.catalogId !== 'string') throw new SimCommandError(`setTraffic: variants[${i}] must have a catalogId`);
      if (!(typeof spec.weight === 'number' && spec.weight > 0 && Number.isFinite(spec.weight))) throw new SimCommandError(`setTraffic: variants[${i}].weight must be > 0`);
      if (!(Number.isInteger(spec.paletteCount) && spec.paletteCount >= 0)) throw new SimCommandError(`setTraffic: variants[${i}].paletteCount must be an integer ≥ 0`);
      const rep = validateVehicle(spec.vehicle, TRAFFIC_BEAM_BUDGET);
      if (!rep.ok) throw new SimCommandError(`setTraffic: variants[${i}] (${spec.catalogId}) rejected: ${rep.errors[0] ?? 'invalid'}`);
      try {
        compiled.push({ spec, cv: compileVehicle(spec.vehicle) });
      } catch (e) {
        throw new SimCommandError(`setTraffic: variants[${i}] (${spec.catalogId}) does not compile: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const key = `${layout.id}|${layout.version}|${this.terrain.hash}`;
    let net: RouteNetwork;
    if (this.routeCache && this.routeCache.key === key) net = this.routeCache.net;
    else {
      try {
        net = buildRouteNetwork(layout, this.terrain);
      } catch (e) {
        throw new SimCommandError(`setTraffic: route network: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.routeCache = { key, net };
    }
    const g: [number, number, number] = [this.gravityX, this.gravityY, this.gravityZ];
    const variants: TrafficVariant[] = compiled.map(({ spec, cv }) =>
      buildVariant(spec.catalogId, cv, spec.weight, spec.paletteCount, spec.vehicle.steering.maxWheelAngleDeg, (nodes, beams) => {
        const e = new SimEngine({ gravity: g, debugStrains: false, capacity: { maxObjects: 1, nodeCapacity: nodes, beamCapacity: beams }, kernel: this.kernelFactory });
        e.setGroundPlane(0, MaterialId.asphalt);
        return e;
      }),
    );
    const sim = new TrafficSim(net, variants, { seed: cfg.seed, variants, density, focusObjectId: cfg.focusObjectId, bubble: bubble ? { promoteM: bubble.promoteM, demoteM: bubble.demoteM } : undefined });
    sim.init(this);
    this.traffic = sim;
    return {
      routeHash: net.hash,
      pathCount: net.paths.length,
      agentCount: sim.agentCount,
      variants: variants.map((v) => ({ catalogId: v.catalogId, nodeCount: v.compiled.rig.nodeCount, settled: Float32Array.from(v.settled) })),
    };
  }

  /** Protocol `setTrafficDensity`. No traffic configured → SimCommandError. */
  setTrafficDensity(density: TrafficDensity): void {
    if (this.traffic === null) throw new SimCommandError('setTrafficDensity: no traffic configured');
    if (!density || typeof density !== 'object') throw new SimCommandError('setTrafficDensity: density must be an object');
    this.traffic.setDensity(density);
  }
}

/** Quaternion [x, y, z, w] of the rotation whose columns are B[3..5], B[6..8], B[9..11] (sqrt-only, Shepperd). */
function matToQuat(B: Float64Array): [number, number, number, number] {
  const m00 = B[3]!;
  const m10 = B[4]!;
  const m20 = B[5]!;
  const m01 = B[6]!;
  const m11 = B[7]!;
  const m21 = B[8]!;
  const m02 = B[9]!;
  const m12 = B[10]!;
  const m22 = B[11]!;
  const tr = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (tr > 0) {
    const sq = Math.sqrt(tr + 1) * 2;
    w = 0.25 * sq;
    x = (m21 - m12) / sq;
    y = (m02 - m20) / sq;
    z = (m10 - m01) / sq;
  } else if (m00 > m11 && m00 > m22) {
    const sq = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / sq;
    x = 0.25 * sq;
    y = (m01 + m10) / sq;
    z = (m02 + m20) / sq;
  } else if (m11 > m22) {
    const sq = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / sq;
    x = (m01 + m10) / sq;
    y = 0.25 * sq;
    z = (m12 + m21) / sq;
  } else {
    const sq = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / sq;
    x = (m02 + m20) / sq;
    y = (m12 + m21) / sq;
    z = 0.25 * sq;
  }
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  return [x / l, y / l, z / l, w / l];
}

/** Hamilton product a·b of [x, y, z, w] quaternions. */
function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Joint Gauss-Seidel sweeps once a prop with implicit members (a guardrail) exists (trailer/joints.ts). */
export const PROP_LINK_ITERATIONS = 2;

/**
 * R-PHYS2 → R-PHYS: water in the cylinders (VehicleRuntime.water.hydrolocked) bends the rods — the engine
 * stops and locks (engine systems: health 0, seized; the starter cannot turn it). Sticky like the flag:
 * `recover` keeps it, `reset` clears both.
 */
function seizeHydrolocked(veh: VehicleRuntime): void {
  const es = (veh as VehicleRuntimeEx).engineSys;
  if (!es || es.seized !== 0) return;
  es.health = 0;
  es.seized = 1;
  const d = veh.drivetrain as DrivetrainStateEx;
  d.engineOn = 0;
  d.seized = 1;
}
