/**
 * Preallocated SoA arena (SimState) + object slot table.
 *
 * Objects occupy contiguous node/beam ranges packed in ASCENDING objectId
 * order (canonical ordering rule 2). Spawning/despawning re-packs the arena
 * with copyWithin; that only ever happens between steps, never inside one.
 * Nothing here runs in the per-step hot path.
 */
import type { Transform } from '../protocol/messages';
import type { CompiledRig } from './rig/types';
import { ACTION_COUNT, BeamType, NODE_FLAG_IN_CONTACT, type SimObject, type SimState } from './types';

export function createSimState(nodeCapacity: number, beamCapacity: number): SimState {
  if (!(nodeCapacity >= 0) || !(beamCapacity >= 0)) throw new RangeError('negative SimState capacity');
  return {
    nodeCapacity,
    beamCapacity,
    nodeCount: 0,
    beamCount: 0,
    posX: new Float64Array(nodeCapacity),
    posY: new Float64Array(nodeCapacity),
    posZ: new Float64Array(nodeCapacity),
    velX: new Float64Array(nodeCapacity),
    velY: new Float64Array(nodeCapacity),
    velZ: new Float64Array(nodeCapacity),
    frcX: new Float64Array(nodeCapacity),
    frcY: new Float64Array(nodeCapacity),
    frcZ: new Float64Array(nodeCapacity),
    invMass: new Float64Array(nodeCapacity),
    radius: new Float64Array(nodeCapacity),
    friction: new Float64Array(nodeCapacity),
    contactK: new Float64Array(nodeCapacity),
    treadAxX: new Float64Array(nodeCapacity),
    treadAxY: new Float64Array(nodeCapacity),
    treadAxZ: new Float64Array(nodeCapacity),
    treadF: new Float64Array(nodeCapacity),
    objRadius: new Float64Array(nodeCapacity),
    flags: new Uint8Array(nodeCapacity),
    aIdx: new Int32Array(beamCapacity),
    bIdx: new Int32Array(beamCapacity),
    k: new Float64Array(beamCapacity),
    d: new Float64Array(beamCapacity),
    restLen: new Float64Array(beamCapacity),
    restLen0: new Float64Array(beamCapacity),
    k0: new Float64Array(beamCapacity),
    deform: new Float64Array(beamCapacity),
    breakF: new Float64Array(beamCapacity),
    boundsLow: new Float64Array(beamCapacity),
    boundsHigh: new Float64Array(beamCapacity),
    preload: new Float64Array(beamCapacity),
    type: new Uint8Array(beamCapacity),
    active: new Uint8Array(beamCapacity),
    strainOut: new Float32Array(beamCapacity),
  };
}

type NodeArray = Float64Array | Uint8Array;
type BeamArray = Float64Array | Float32Array | Int32Array | Uint8Array;

function nodeArrays(s: SimState): NodeArray[] {
  return [
    s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.frcX, s.frcY, s.frcZ,
    s.invMass, s.radius, s.friction, s.contactK, s.treadAxX, s.treadAxY, s.treadAxZ, s.treadF, s.objRadius, s.flags,
  ];
}

function beamArrays(s: SimState): BeamArray[] {
  return [
    s.aIdx, s.bIdx, s.k, s.d, s.restLen, s.restLen0, s.k0, s.deform, s.breakF,
    s.boundsLow, s.boundsHigh, s.preload, s.type, s.active, s.strainOut,
  ];
}

/** Row-major 3×3 rotation matrix from quat [x,y,z,w] (normalized here). Spawn-time only. */
export function quatToMat3(q: readonly number[], out: Float64Array = new Float64Array(9)): Float64Array {
  let x = q[0] ?? 0;
  let y = q[1] ?? 0;
  let z = q[2] ?? 0;
  let w = q[3] ?? 1;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(len > 0) || !Number.isFinite(len)) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    x /= len;
    y /= len;
    z /= len;
    w /= len;
  }
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y - z * w);
  out[2] = 2 * (x * z + y * w);
  out[3] = 2 * (x * y + z * w);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z - x * w);
  out[6] = 2 * (x * z - y * w);
  out[7] = 2 * (y * z + x * w);
  out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

function checkTransform(t: Transform): void {
  const p = t.pos;
  const q = t.quat;
  if (!p || !q || p.length !== 3 || q.length !== 4) throw new TypeError('transform needs pos[3] and quat[4]');
  for (const v of p) if (!Number.isFinite(v)) throw new TypeError('transform.pos must be finite');
  for (const v of q) if (!Number.isFinite(v)) throw new TypeError('transform.quat must be finite');
}

/**
 * Writes the rig's rest pose under `transform` into the object's node range
 * and resets per-node dynamic state (velocity, force, contact flag) plus the
 * static per-node properties from the compiled rig.
 */
export function loadRigNodes(state: SimState, obj: SimObject, rig: CompiledRig, transform: Transform): void {
  checkTransform(transform);
  const m = quatToMat3(transform.quat);
  const tx = transform.pos[0];
  const ty = transform.pos[1];
  const tz = transform.pos[2];
  const base = obj.nodeStart;
  const np = rig.nodePos;
  for (let i = 0; i < rig.nodeCount; i++) {
    const g = base + i;
    const lx = np[3 * i]!;
    const ly = np[3 * i + 1]!;
    const lz = np[3 * i + 2]!;
    state.posX[g] = tx + m[0]! * lx + m[1]! * ly + m[2]! * lz;
    state.posY[g] = ty + m[3]! * lx + m[4]! * ly + m[5]! * lz;
    state.posZ[g] = tz + m[6]! * lx + m[7]! * ly + m[8]! * lz;
    state.velX[g] = 0;
    state.velY[g] = 0;
    state.velZ[g] = 0;
    state.frcX[g] = 0;
    state.frcY[g] = 0;
    state.frcZ[g] = 0;
    state.invMass[g] = rig.nodeInvMass[i]!;
    state.radius[g] = rig.nodeRadius[i]!;
    state.friction[g] = rig.nodeFriction[i]!;
    state.contactK[g] = rig.nodeContactK[i]!;
    state.treadAxX[g] = 0;
    state.treadAxY[g] = 0;
    state.treadAxZ[g] = 0;
    state.treadF[g] = 0;
    state.objRadius[g] = rig.nodeObjRadius[i]!;
    state.flags[g] = rig.nodeFlags[i]! & ~NODE_FLAG_IN_CONTACT;
  }
}

/** Restores every beam of the object to its compiled (undamaged) state. */
export function loadRigBeams(state: SimState, obj: SimObject, rig: CompiledRig): void {
  const nb = obj.nodeStart;
  const bb = obj.beamStart;
  for (let i = 0; i < rig.beamCount; i++) {
    const g = bb + i;
    state.aIdx[g] = nb + rig.beamA[i]!;
    state.bIdx[g] = nb + rig.beamB[i]!;
    state.k[g] = rig.beamK[i]!;
    state.k0[g] = rig.beamK[i]!;
    state.d[g] = rig.beamD[i]!;
    state.restLen[g] = rig.beamRestLen[i]!;
    state.restLen0[g] = rig.beamRestLen[i]!;
    state.deform[g] = rig.beamDeform[i]!;
    state.breakF[g] = rig.beamBreakF[i]!;
    state.boundsLow[g] = rig.beamBoundsLow[i]!;
    state.boundsHigh[g] = rig.beamBoundsHigh[i]!;
    state.preload[g] = rig.beamPreload[i]!;
    state.type[g] = rig.beamType[i]!;
    state.active[g] = 1;
    state.strainOut[g] = 0;
  }
}

function buildHydro(obj: SimObject, rig: CompiledRig): void {
  let n = 0;
  for (let i = 0; i < rig.beamCount; i++) if (rig.beamType[i] === BeamType.hydro) n++;
  obj.hydroBeams = new Int32Array(n);
  obj.hydroBase = new Float64Array(n);
  obj.hydroTravel = new Float64Array(n);
  let h = 0;
  for (let i = 0; i < rig.beamCount; i++) {
    if (rig.beamType[i] !== BeamType.hydro) continue;
    obj.hydroBeams[h] = obj.beamStart + i;
    obj.hydroBase[h] = rig.beamRestLen[i]!;
    obj.hydroTravel[h] = rig.beamHydroTravel[i]!;
    h++;
  }
}

/** Arena + ascending-objectId slot table. */
export class SimArena {
  readonly state: SimState;
  readonly maxObjects: number;
  /** Live objects, ascending objectId; ranges packed contiguously in this order. */
  readonly objects: SimObject[] = [];

  constructor(nodeCapacity: number, beamCapacity: number, maxObjects: number) {
    this.state = createSimState(nodeCapacity, beamCapacity);
    this.maxObjects = maxObjects;
  }

  /** Index in `objects` of objectId, or -1 (binary search). */
  indexOf(objectId: number): number {
    const o = this.objects;
    let lo = 0;
    let hi = o.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const id = o[mid]!.objectId;
      if (id === objectId) return mid;
      if (id < objectId) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get(objectId: number): SimObject | undefined {
    const i = this.indexOf(objectId);
    return i < 0 ? undefined : this.objects[i];
  }

  /** Index in `objects` of the object owning arena beam `beam`, or -1. Allocation-free. */
  ownerOfBeam(beam: number): number {
    const o = this.objects;
    let lo = 0;
    let hi = o.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ob = o[mid]!;
      if (beam < ob.beamStart) hi = mid - 1;
      else if (beam >= ob.beamStart + ob.beamCount) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /**
   * Inserts `rig` as `objectId` at its ascending-id slot, shifting later
   * objects' ranges up. Throws RangeError on duplicate id / capacity.
   */
  insert(objectId: number, rig: CompiledRig, transform: Transform): SimObject {
    if (!Number.isInteger(objectId) || objectId < 0 || objectId > 0xffffffff) {
      throw new RangeError(`objectId ${objectId} is not a u32`);
    }
    checkTransform(transform);
    if (this.indexOf(objectId) >= 0) throw new RangeError(`objectId ${objectId} already exists`);
    const s = this.state;
    if (this.objects.length >= this.maxObjects) throw new RangeError(`object capacity ${this.maxObjects} exceeded`);
    const n = rig.nodeCount;
    const m = rig.beamCount;
    if (s.nodeCount + n > s.nodeCapacity) {
      throw new RangeError(`node capacity ${s.nodeCapacity} exceeded (${s.nodeCount} + ${n})`);
    }
    if (s.beamCount + m > s.beamCapacity) {
      throw new RangeError(`beam capacity ${s.beamCapacity} exceeded (${s.beamCount} + ${m})`);
    }

    let pos = 0;
    while (pos < this.objects.length && this.objects[pos]!.objectId < objectId) pos++;
    const next = this.objects[pos];
    const nodeStart = next ? next.nodeStart : s.nodeCount;
    const beamStart = next ? next.beamStart : s.beamCount;

    if (next) {
      if (n > 0) for (const a of nodeArrays(s)) a.copyWithin(nodeStart + n, nodeStart, s.nodeCount);
      if (m > 0) for (const a of beamArrays(s)) a.copyWithin(beamStart + m, beamStart, s.beamCount);
      const end = s.beamCount + m;
      for (let b = beamStart + m; b < end; b++) {
        s.aIdx[b]! += n;
        s.bIdx[b]! += n;
      }
      for (let i = pos; i < this.objects.length; i++) {
        const o = this.objects[i]!;
        o.nodeStart += n;
        o.beamStart += m;
        for (let h = 0; h < o.hydroBeams.length; h++) o.hydroBeams[h]! += m;
      }
    }

    const obj: SimObject = {
      objectId,
      nodeStart,
      nodeCount: n,
      beamStart,
      beamCount: m,
      flags: 0,
      actions: new Float64Array(ACTION_COUNT),
      hydroBeams: new Int32Array(0),
      hydroBase: new Float64Array(0),
      hydroTravel: new Float64Array(0),
    };
    buildHydro(obj, rig);
    s.nodeCount += n;
    s.beamCount += m;
    this.objects.splice(pos, 0, obj);
    loadRigNodes(s, obj, rig, transform);
    loadRigBeams(s, obj, rig);
    return obj;
  }

  /** Removes objectId and packs later objects down. Returns false if absent. */
  remove(objectId: number): boolean {
    const pos = this.indexOf(objectId);
    if (pos < 0) return false;
    const s = this.state;
    const obj = this.objects[pos]!;
    const n = obj.nodeCount;
    const m = obj.beamCount;
    const nodeEnd = obj.nodeStart + n;
    const beamEnd = obj.beamStart + m;
    if (n > 0) for (const a of nodeArrays(s)) a.copyWithin(obj.nodeStart, nodeEnd, s.nodeCount);
    if (m > 0) for (const a of beamArrays(s)) a.copyWithin(obj.beamStart, beamEnd, s.beamCount);
    const newBeamCount = s.beamCount - m;
    for (let b = obj.beamStart; b < newBeamCount; b++) {
      s.aIdx[b]! -= n;
      s.bIdx[b]! -= n;
    }
    for (let i = pos + 1; i < this.objects.length; i++) {
      const o = this.objects[i]!;
      o.nodeStart -= n;
      o.beamStart -= m;
      for (let h = 0; h < o.hydroBeams.length; h++) o.hydroBeams[h]! -= m;
    }
    s.nodeCount -= n;
    s.beamCount = newBeamCount;
    // Scrub the freed tail so stale data never leaks into hashes or snapshots.
    for (const a of nodeArrays(s)) a.fill(0, s.nodeCount, s.nodeCount + n);
    for (const a of beamArrays(s)) a.fill(0, s.beamCount, s.beamCount + m);
    this.objects.splice(pos, 1);
    return true;
  }

  /** Full repair of an existing object: rest pose at `transform`, zero velocity, beams restored. */
  reset(objectId: number, rig: CompiledRig, transform: Transform): SimObject {
    const obj = this.get(objectId);
    if (!obj) throw new RangeError(`unknown objectId ${objectId}`);
    loadRigNodes(this.state, obj, rig, transform);
    loadRigBeams(this.state, obj, rig);
    return obj;
  }
}
