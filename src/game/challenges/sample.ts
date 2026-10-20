/**
 * ChallengeSample builder (types.ts contract): one sample per live snapshot
 * from the SnapshotReader, allocation-free after construction. Pure (no
 * three, no DOM): app/challenges.ts feeds it from SimClient's snapshot
 * listener, the headless playtests feed it from a WorkerHost.
 */
import { PROP_LAYOUT_ID_BASE, isPropObjectId } from '../../protocol/messages';
import type { SnapshotReader } from '../../protocol/codec';
import { VehicleTelemetry as T } from '../../protocol/telemetry';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import { DESTRUCTION_BEAM_POINTS, DESTRUCTION_IMPULSE_MIN, DESTRUCTION_IMPULSE_POINTS, type ChallengeSample } from './types';

/** Static facts of a vehicle rig the sample needs (from its CompiledVehicle). */
export interface RigInfo {
  frame: [number, number, number];
  /** Hub node pairs per wheel (local), and the largest tyre radius. */
  hubs: Int32Array;
  wheelRadius: number;
  /** Front body nodes measuring crush, their rest forward distance from the frame origin, and their rest distance to it. */
  crushNodes: Int32Array;
  crushRestFwd: Float32Array;
  crushRestDist: Float32Array;
  nodeCount: number;
}

export function rigInfo(cv: CompiledVehicle): RigInfo {
  const P = cv.rig.nodePos;
  const o = cv.frameNodes[0] ?? 0;
  const f = cv.frameNodes[1] ?? 0;
  const t = cv.frameNodes[2] ?? 0;
  const hubs = new Int32Array(cv.wheels.length * 2);
  let wr = 0;
  cv.wheels.forEach((w, k) => {
    hubs[2 * k] = w.hubI;
    hubs[2 * k + 1] = w.hubO;
    wr = Math.max(wr, w.radius);
  });
  const nb = Math.min(cv.bodyNodeCount, cv.rig.nodeCount);
  let maxF = -Infinity;
  for (let i = 0; i < nb; i++) maxF = Math.max(maxF, -(P[3 * i + 2]! - P[3 * o + 2]!));
  const ids: number[] = [];
  for (let i = 0; i < nb; i++) if (-(P[3 * i + 2]! - P[3 * o + 2]!) >= maxF - 0.45) ids.push(i);
  const crushNodes = Int32Array.from(ids);
  const crushRestFwd = new Float32Array(ids.length);
  const crushRestDist = new Float32Array(ids.length);
  ids.forEach((i, k) => {
    const dx = P[3 * i]! - P[3 * o]!;
    const dy = P[3 * i + 1]! - P[3 * o + 1]!;
    const dz = P[3 * i + 2]! - P[3 * o + 2]!;
    crushRestFwd[k] = -dz;
    crushRestDist[k] = Math.hypot(dx, dy, dz);
  });
  return { frame: [o, f, t], hubs, wheelRadius: wr, crushNodes, crushRestFwd, crushRestDist, nodeCount: cv.rig.nodeCount };
}

/** A challenge prop watched for "down" (pins). */
export interface PinWatch {
  objectId: number;
  group: string;
  /** Rest centroid and the base height it stands on. */
  x: number;
  z: number;
  cy: number;
  baseY: number;
}

export interface SampleBuilderOptions {
  playerId: number;
  player: RigInfo;
  /** Support height under a point (terrain + collider decks). */
  surfaceAt(x: number, z: number): number;
  pins?: readonly PinWatch[];
  opponents?: readonly { id: number; rig: RigInfo }[];
}

export function createSample(): ChallengeSample {
  return {
    valid: false,
    tick: 0,
    simTime: 0,
    origin: [0, 0, 0],
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    forward: [0, 0, -1],
    up: [0, 1, 0],
    speed: 0,
    airborne: false,
    wheelContact: 0,
    bodyImpact: false,
    bodyImpulse: 0,
    damage: 0,
    slip: 0,
    groundY: 0,
    crushCm: 0,
    hubs: [0, 0, 0, 0, 0, 0, 0, 0],
    propHits: 0,
    vehicleHits: 0,
    pinsDown: {},
    opponents: [],
  };
}

const scratch = new Float64Array(3);

export class SampleBuilder {
  readonly sample = createSample();
  /** COM height above the support surface at rest (measured by `calibrate`). */
  comRestHeight = 0.55;
  /** Crush reading of the undamaged car at rest (sag), subtracted from every sample. */
  crushBase = 0;
  private readonly o: SampleBuilderOptions;
  private readonly hubMid = new Float64Array(12);

  constructor(opts: SampleBuilderOptions) {
    this.o = opts;
    for (const p of opts.pins ?? []) this.sample.pinsDown[p.group] = 0;
    this.sample.opponents = (opts.opponents ?? []).map((x) => ({ id: x.id, present: false, damage: 0, pos: [0, 0, 0], upY: 1 }));
  }

  /** Forget the calibration (restart: the car was repaired at the start). */
  reset(): void {
    this.comRestHeight = 0.55;
    this.crushBase = 0;
  }

  /** Stores the current COM clearance as the resting one (call while the car stands at the start). */
  calibrate(): void {
    const s = this.sample;
    if (!s.valid) return;
    const h = s.pos[1] - s.groundY;
    if (h > 0.2 && h < 2.5) this.comRestHeight = h;
    this.crushBase += s.crushCm;
  }

  build(r: SnapshotReader): ChallengeSample {
    const s = this.sample;
    const o = this.o;
    s.tick = r.tick;
    s.simTime = r.simTime;
    const i = r.findObject(o.playerId);
    if (i < 0 || r.objectNodeCount(i) !== o.player.nodeCount) {
      s.valid = false;
      return s;
    }
    s.valid = true;
    const nodes = r.objectNodes(i);
    if (!frameOf(nodes, o.player.frame, s.origin, s.forward, s.up)) {
      s.valid = false;
      return s;
    }
    s.pos[0] = r.telemetry(i, T.comX);
    s.pos[1] = r.telemetry(i, T.comY);
    s.pos[2] = r.telemetry(i, T.comZ);
    s.vel[0] = r.telemetry(i, T.velX);
    s.vel[1] = r.telemetry(i, T.velY);
    s.vel[2] = r.telemetry(i, T.velZ);
    s.speed = r.telemetry(i, T.speed);
    s.damage = r.telemetry(i, T.damage);
    s.wheelContact = r.telemetry(i, T.wheelContact) | 0;
    s.slip = (Math.abs(r.telemetry(i, T.wheelSlipRL)) + Math.abs(r.telemetry(i, T.wheelSlipRR))) / 2;
    // hubs (XZ) + their 3D midpoints (tyre-contact classification)
    const hb = o.player.hubs;
    const nw = hb.length / 2;
    for (let k = 0; k < nw && k < 4; k++) {
      const a = hb[2 * k]!;
      const b = hb[2 * k + 1]!;
      const x = (nodes[3 * a]! + nodes[3 * b]!) / 2;
      const y = (nodes[3 * a + 1]! + nodes[3 * b + 1]!) / 2;
      const z = (nodes[3 * a + 2]! + nodes[3 * b + 2]!) / 2;
      this.hubMid[3 * k] = x;
      this.hubMid[3 * k + 1] = y;
      this.hubMid[3 * k + 2] = z;
      s.hubs[2 * k] = x;
      s.hubs[2 * k + 1] = z;
    }
    // body contact: impacts / skids of the player away from the tyres
    let bodyImpact = false;
    let bodyContact = false;
    let imp = 0;
    let propHits = 0;
    let vehicleHits = 0;
    const tyreR = o.player.wheelRadius + 0.15;
    for (let k = 0; k < r.impactCount; k++) {
      const id = r.impactObjectId(k);
      const j = r.impactImpulse(k);
      if (id === o.playerId) {
        r.impactPos(k, scratch);
        if (!this.nearHub(scratch, tyreR, Math.min(nw, 4))) {
          bodyImpact = true;
          bodyContact = true;
          if (j > imp) imp = j;
        }
      } else if (j >= DESTRUCTION_IMPULSE_MIN) {
        if (isPropObjectId(id)) propHits += j * DESTRUCTION_IMPULSE_POINTS;
        else if (id < PROP_LAYOUT_ID_BASE) vehicleHits += j * DESTRUCTION_IMPULSE_POINTS;
      }
    }
    for (let k = 0; k < r.skidCount; k++) {
      if (r.skidObjectId(k) !== o.playerId) continue;
      r.skidPos(k, scratch);
      if (!this.nearHub(scratch, tyreR, Math.min(nw, 4))) bodyContact = true;
    }
    for (let k = 0; k < r.beamBreakCount; k++) {
      const id = r.beamBreakObjectId(k);
      if (id === o.playerId) continue;
      if (isPropObjectId(id)) propHits += DESTRUCTION_BEAM_POINTS;
      else if (id < PROP_LAYOUT_ID_BASE) vehicleHits += DESTRUCTION_BEAM_POINTS;
    }
    s.bodyImpact = bodyImpact;
    s.bodyImpulse = imp;
    s.propHits = propHits;
    s.vehicleHits = vehicleHits;
    s.groundY = o.surfaceAt(s.pos[0], s.pos[2]);
    const telAir = r.telemetry(i, T.airborne) >= 0.5;
    const clear = s.pos[1] - s.groundY > this.comRestHeight + 0.2 || Math.abs(s.vel[1]) > 1.2;
    s.airborne = telAir && !bodyContact && clear;
    s.crushCm = Math.max(0, crushOf(nodes, o.player, s.origin, s.forward) - this.crushBase);
    // pins
    for (const p of o.pins ?? []) s.pinsDown[p.group] = 0;
    for (const p of o.pins ?? []) {
      const j = r.findObject(p.objectId);
      if (j < 0) continue;
      const pn = r.objectNodes(j);
      const n = r.objectNodeCount(j);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let k = 0; k < n; k++) {
        cx += pn[3 * k]!;
        cy += pn[3 * k + 1]!;
        cz += pn[3 * k + 2]!;
      }
      cx /= n;
      cy /= n;
      cz /= n;
      const moved = Math.hypot(cx - p.x, cz - p.z);
      if (moved > 0.8 || cy < p.baseY + 0.7 * (p.cy - p.baseY)) s.pinsDown[p.group] = (s.pinsDown[p.group] ?? 0) + 1;
    }
    // opponents
    const ops = o.opponents ?? [];
    for (let k = 0; k < ops.length; k++) {
      const out = s.opponents[k]!;
      const j = r.findObject(ops[k]!.id);
      out.present = j >= 0 && r.objectNodeCount(j) === ops[k]!.rig.nodeCount;
      if (!out.present) continue;
      out.damage = r.telemetry(j, T.damage);
      out.pos[0] = r.telemetry(j, T.comX);
      out.pos[1] = r.telemetry(j, T.comY);
      out.pos[2] = r.telemetry(j, T.comZ);
      const on = r.objectNodes(j);
      const fr = ops[k]!.rig.frame;
      const ux = on[3 * fr[2]]! - on[3 * fr[0]]!;
      const uy = on[3 * fr[2] + 1]! - on[3 * fr[0] + 1]!;
      const uz = on[3 * fr[2] + 2]! - on[3 * fr[0] + 2]!;
      out.upY = uy / (Math.hypot(ux, uy, uz) || 1);
    }
    return s;
  }

  private nearHub(p: Float64Array, r: number, n: number): boolean {
    const h = this.hubMid;
    for (let k = 0; k < n; k++) {
      const dx = p[0]! - h[3 * k]!;
      const dy = p[1]! - h[3 * k + 1]!;
      const dz = p[2]! - h[3 * k + 2]!;
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
    return false;
  }
}

/** Frame-node basis (origin, unit forward, unit up ⟂ forward); false when degenerate. */
export function frameOf(nodes: ArrayLike<number>, fr: readonly number[], origin: number[], fwd: number[], up: number[]): boolean {
  const o = fr[0]!;
  const f = fr[1]!;
  const t = fr[2]!;
  const ox = nodes[3 * o]!;
  const oy = nodes[3 * o + 1]!;
  const oz = nodes[3 * o + 2]!;
  let fx = nodes[3 * f]! - ox;
  let fy = nodes[3 * f + 1]! - oy;
  let fz = nodes[3 * f + 2]! - oz;
  const fl = Math.hypot(fx, fy, fz);
  if (!(fl > 1e-4) || !Number.isFinite(ox + oy + oz)) return false;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let ux = nodes[3 * t]! - ox;
  let uy = nodes[3 * t + 1]! - oy;
  let uz = nodes[3 * t + 2]! - oz;
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  const ul = Math.hypot(ux, uy, uz) || 1;
  origin[0] = ox;
  origin[1] = oy;
  origin[2] = oz;
  fwd[0] = fx;
  fwd[1] = fy;
  fwd[2] = fz;
  up[0] = ux / ul;
  up[1] = uy / ul;
  up[2] = uz / ul;
  return true;
}

/** Front crush (cm, ≥ 0): mean rest − current forward distance of the front body nodes still attached. */
export function crushOf(nodes: ArrayLike<number>, rig: RigInfo, origin: readonly number[], fwd: readonly number[]): number {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < rig.crushNodes.length; k++) {
    const i = rig.crushNodes[k]!;
    const dx = nodes[3 * i]! - origin[0]!;
    const dy = nodes[3 * i + 1]! - origin[1]!;
    const dz = nodes[3 * i + 2]! - origin[2]!;
    const dist = Math.hypot(dx, dy, dz);
    if (Math.abs(dist - rig.crushRestDist[k]!) > 1.5) continue; // torn off
    sum += rig.crushRestFwd[k]! - (dx * fwd[0]! + dy * fwd[1]! + dz * fwd[2]!);
    n++;
  }
  return n > 0 ? Math.max(0, (sum / n) * 100) : 0;
}
