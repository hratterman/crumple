/**
 * Sim engine: owns the arena, objects, ground, pending events and the fixed
 * step. Worker-only. Commands (spawn/despawn/reset/input/ground) must be
 * called between steps; step() itself is allocation-free.
 */
import type { Vec3 } from '../core/math';
import { createRng, type Rng } from '../core/rng';
import type { SnapshotWriter } from '../protocol/codec';
import {
  BEAM_BREAK_CAPACITY,
  EventKind,
  IMPACT_CAPACITY,
  SKID_CAPACITY,
} from '../protocol/events';
import { TELEMETRY_SLOTS } from '../protocol/layout';
import {
  ACTION_NAMES,
  ACTION_RANGES,
  Action,
  DEFAULT_CAPACITY,
  isLayoutPropId,
  isPropObjectId,
  PROP_DYNAMIC_ID_BASE,
  PROP_DYNAMIC_MAX,
  type ActionState,
  type PropSpawn,
  type SnapshotCapacity,
  type Transform,
} from '../protocol/messages';
import { applyBeamForces } from './beams';
import { applyColliderContacts, compileColliders, resetColliderContactState } from './collision/colliders';
import { applyGroundContacts, PlaneSampler, resetGroundContactState } from './collision/ground';
import type { ColliderWorld } from './collision/types';
import { resolveColliders } from '../world/colliders';
import type { ColliderDef, ResolvedCollider, WaterBody } from '../world/types';
import { DEFAULT_MATERIALS } from './collision/materials';
import { integrateNodes } from './integrator';
import { compileRig } from './rig/builder';
import type { CompiledRig, RigDef } from './rig/types';
import { SimArena } from './state';
import { SIM_OBJECT_FLAG_SLEEPING, type EventSink, type HeightSampler, type MaterialTable, type SimObject, type SimState } from './types';
import { compilePropRig, getPropDef, isPropKey } from './props/catalog';
import { applyPropDamping, PROP_INTERNAL_DAMPING, propAnchored, type PropRuntime } from './props/runtime';
import type { PropInstance, PropKey } from './props/types';
import { compileVehicle } from './vehicle/builder';
import { createTerrainSampler, type HeightfieldSampler } from '../world/sampler';
import type { TerrainData } from '../world/types';
import {
  createVehicleRuntime,
  rebaseVehicle,
  recoverVehicle,
  resetVehicleRuntime,
  vehiclePreStep,
  writeVehicleTelemetry,
} from './vehicle/runtime';
import type { CompiledVehicle, TransmissionMode, VehicleDef, VehicleRuntime } from './vehicle/types';
import { setWheelGround } from './vehicle/wheels';

/** Fixed physics step, s. */
export const SIM_DT = 1 / 2000;
export const SIM_HZ = 2000;

export interface EngineConfig {
  gravity: Vec3;
  debugStrains: boolean;
  capacity?: SnapshotCapacity;
  seed?: number;
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
  readonly capacity: SnapshotCapacity;
  readonly debugStrains: boolean;
  readonly events: PendingEvents;
  readonly rng: Rng;
  gravityX: number;
  gravityY: number;
  gravityZ: number;
  sampler: HeightSampler | null = null;
  /** The installed heightfield (setGroundTerrain), null for plane / no ground. */
  terrain: TerrainData | null = null;
  materials: MaterialTable = DEFAULT_MATERIALS;
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
  /** Compiled rig per objectId (needed for reset/repair). */
  private readonly rigs = new Map<number, CompiledRig>();
  /** Vehicle runtime per objectId. */
  private readonly vehicles = new Map<number, VehicleRuntime>();
  /** Parallel to arena.objects: the object's vehicle runtime or null (hot-loop lookup). */
  private vehicleSlots: (VehicleRuntime | null)[] = [];
  /** Prop runtime per objectId (layout + dynamic props). */
  private readonly props = new Map<number, PropRuntime>();
  /** Parallel to arena.objects: the object's prop runtime or null. */
  private propSlots: (PropRuntime | null)[] = [];

  constructor(config: EngineConfig) {
    const cap = config.capacity ?? DEFAULT_CAPACITY;
    for (const v of [cap.maxObjects, cap.nodeCapacity, cap.beamCapacity]) {
      if (!Number.isInteger(v) || v < 0) throw new RangeError('capacity values must be non-negative integers');
    }
    const g = config.gravity;
    if (!g || g.length !== 3 || !g.every(Number.isFinite)) throw new TypeError('gravity must be 3 finite numbers');
    this.capacity = { ...cap };
    this.debugStrains = !!config.debugStrains;
    this.arena = new SimArena(cap.nodeCapacity, cap.beamCapacity, cap.maxObjects);
    this.state = this.arena.state;
    this.events = new PendingEvents(this.arena);
    this.gravityX = g[0];
    this.gravityY = g[1];
    this.gravityZ = g[2];
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
    this.terrain = null;
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
    this.sampler = sampler;
    this.terrain = terrain;
    return sampler;
  }

  clearGround(): void {
    this.sampler = null;
    this.terrain = null;
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
  }

  spawn(objectId: number, def: RigDef, transform: Transform): SimObject {
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
    // Ranges from here on shifted; per-node contact bookkeeping restarts.
    resetGroundContactState(this.state, obj.nodeStart, this.state.nodeCount - obj.nodeStart);
    resetColliderContactState(this.state, obj.nodeStart, this.state.nodeCount - obj.nodeStart);
    this.repairEpochs.set(objectId, 0);
    this.syncVehicles();
    return obj;
  }

  /**
   * Spawns a vehicle: compileVehicle (pure; main compiles the same def to
   * map snapshot nodes) → arena insert → vehicle runtime. `transmission`
   * overrides the def's initial mode.
   */
  spawnVehicle(objectId: number, def: VehicleDef, transform: Transform, transmission?: TransmissionMode): SimObject {
    let compiled: CompiledVehicle;
    try {
      compiled = compileVehicle(def);
    } catch (e) {
      throw new SimCommandError(`invalid vehicle: ${e instanceof Error ? e.message : String(e)}`, objectId);
    }
    return this.spawnCompiledVehicle(objectId, compiled, transform, transmission);
  }

  spawnCompiledVehicle(
    objectId: number,
    compiled: CompiledVehicle,
    transform: Transform,
    transmission?: TransmissionMode,
  ): SimObject {
    if (transmission !== undefined && transmission !== 'auto' && transmission !== 'manual') {
      throw new SimCommandError(`invalid transmission ${String(transmission)}`, objectId);
    }
    const obj = this.spawnCompiled(objectId, compiled.rig, transform);
    const rt = createVehicleRuntime(objectId, compiled, obj.nodeStart, obj.beamStart, transmission);
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

  /** Upright the vehicle in place (damage and drivetrain kept); see recoverVehicle. */
  recover(objectId: number, pos?: Vec3): void {
    const v = this.vehicles.get(objectId);
    const obj = this.arena.get(objectId);
    if (!v || !obj) throw new SimCommandError(`objectId ${objectId} is not a vehicle`, objectId);
    if (pos !== undefined && (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite))) {
      throw new SimCommandError('recover pos must be 3 finite numbers', objectId);
    }
    recoverVehicle(this.state, v, this.sampler, pos);
    resetGroundContactState(this.state, obj.nodeStart, obj.nodeCount);
    resetColliderContactState(this.state, obj.nodeStart, obj.nodeCount);
  }

  /** Rebuilds the per-object vehicle/prop slots and rebases every vehicle onto its current arena range. */
  private syncVehicles(): void {
    const objs = this.arena.objects;
    const slots: (VehicleRuntime | null)[] = new Array(objs.length);
    const pslots: (PropRuntime | null)[] = new Array(objs.length);
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      const v = this.vehicles.get(obj.objectId) ?? null;
      if (v !== null && (v.nodeStart !== obj.nodeStart || v.beamStart !== obj.beamStart)) {
        rebaseVehicle(v, obj.nodeStart, obj.beamStart);
      }
      slots[o] = v;
      pslots[o] = this.props.get(obj.objectId) ?? null;
    }
    this.vehicleSlots = slots;
    this.propSlots = pslots;
  }

  // ------------------------------------------------------------------ props (P5)
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
    });
    this.syncVehicles();
    this.setAsleep(obj, asleep);
    return obj;
  }

  /** Puts an object to sleep (velocities zeroed, skipped by every pass) or wakes it. */
  setAsleep(obj: SimObject, asleep: boolean): void {
    const rt = this.props.get(obj.objectId);
    if (rt) rt.stillS = 0;
    if (asleep) {
      obj.flags |= SIM_OBJECT_FLAG_SLEEPING;
      const s = this.state;
      const end = obj.nodeStart + obj.nodeCount;
      for (let i = obj.nodeStart; i < end; i++) {
        s.velX[i] = 0;
        s.velY[i] = 0;
        s.velZ[i] = 0;
        s.frcX[i] = 0;
        s.frcY[i] = 0;
        s.frcZ[i] = 0;
      }
    } else {
      obj.flags &= ~SIM_OBJECT_FLAG_SLEEPING;
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
  }

  /**
   * Layout props (worker, on groundHeightfield): despawns every previous
   * layout prop, then spawns the instances asleep (objectId per instance).
   */
  spawnLayoutProps(instances: readonly PropInstance[]): void {
    const old = this.arena.objects.filter((o) => isLayoutPropId(o.objectId)).map((o) => o.objectId);
    for (const id of old) this.despawn(id);
    for (const inst of instances) this.spawnProp(inst.objectId, inst.prop, inst.transform, true);
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
    this.arena.remove(objectId);
    this.rigs.delete(objectId);
    this.vehicles.delete(objectId);
    this.props.delete(objectId);
    this.repairEpochs.delete(objectId);
    resetGroundContactState(this.state, start, this.state.nodeCount + n - start);
    resetColliderContactState(this.state, start, this.state.nodeCount + n - start);
    this.syncVehicles();
  }

  reset(objectId: number, transform: Transform): void {
    const rig = this.rigs.get(objectId);
    if (!rig) throw new SimCommandError(`unknown objectId ${objectId}`, objectId);
    let obj: SimObject;
    try {
      obj = this.arena.reset(objectId, rig, transform);
    } catch (e) {
      throw new SimCommandError(e instanceof Error ? e.message : String(e), objectId);
    }
    resetGroundContactState(this.state, obj.nodeStart, obj.nodeCount);
    resetColliderContactState(this.state, obj.nodeStart, obj.nodeCount);
    this.repairEpochs.set(objectId, ((this.repairEpochs.get(objectId) ?? 0) + 1) >>> 0);
    const v = this.vehicles.get(objectId);
    if (v) resetVehicleRuntime(v);
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

  /** Sets one action by index (clamped). */
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
    // The wheel kernels' ground is module state: point it at THIS engine's
    // ground every step (several engines may coexist, e.g. in tests).
    if (this.vehicles.size > 0) setWheelGround(sampler, this.materials, SIM_DT);
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      if ((obj.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
      const veh = vslots[o];
      if (veh) vehiclePreStep(s, veh, obj.actions, SIM_DT);
      const hb = obj.hydroBeams;
      if (hb.length > 0) {
        const steer = obj.actions[Action.steer]!;
        const base = obj.hydroBase;
        const travel = obj.hydroTravel;
        for (let h = 0; h < hb.length; h++) restLen[hb[h]!] = base[h]! * (1 + travel[h]! * steer);
      }
      applyBeamForces(s, obj.beamStart, obj.beamCount, sink, dbg);
      const prop = pslots[o];
      if (prop) {
        const anchored = prop.anchorBeams.length > 0 && propAnchored(s, prop, obj.beamStart);
        applyPropDamping(s, obj.nodeStart, obj.nodeCount, PROP_INTERNAL_DAMPING, anchored);
      }
      if (sampler !== null) {
        applyGroundContacts(s, obj.nodeStart, obj.nodeCount, sampler, this.materials, SIM_DT, obj.objectId, sink, gx, gy, gz);
      }
      if (cw !== null) {
        applyColliderContacts(s, obj.nodeStart, obj.nodeCount, cw, this.materials, SIM_DT, obj.objectId, sink, gx, gy, gz);
      }
      integrateNodes(s, obj.nodeStart, obj.nodeCount, SIM_DT, gx, gy, gz);
    }
    this.tick++;
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
      const i = writer.addObject(obj.objectId, obj.flags, obj.nodeCount, obj.beamCount);
      writer.writeNodesSoA(i, s.posX, s.posY, s.posZ, obj.nodeStart);
      writer.writeStrains(i, s.strainOut, obj.beamStart);
      writer.writeBrokenBeams(i, s.active, obj.beamStart);
      writer.setRepairEpoch(i, this.repairEpochs.get(obj.objectId) ?? 0);
      const veh = this.vehicleSlots[o];
      if (veh) {
        const t = writeVehicleTelemetry(s, veh);
        for (let k = 0; k < TELEMETRY_SLOTS; k++) writer.setTelemetry(i, k, t[k]!);
      }
    }
    this.events.flushTo(writer);
  }
}
