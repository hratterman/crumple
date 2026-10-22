/**
 * Trailers + cargo runtime (R-PHYS2) — WORKER ONLY. Owned by the engine
 * (`SimEngine.towing`): cross-object joints (hitches, safety chains, cargo
 * straps), carrier surfaces (decks / beds / walls), trailer brake control
 * and the bookkeeping of what is hitched / loaded where.
 *
 * Per tick (engine): `preStep` at the tick boundary (wake requests from the
 * joints, trailer brakes mirror the tow vehicle's pedal, breakaway brakes
 * when a braked trailer's hitch has failed), then `apply` after the node-
 * vs-node pass (joints → carrier surfaces), and `rebuild` at broadphase
 * rebuilds (cargo that left its carrier becomes an ordinary prop).
 * Deterministic: maps iterate in insertion order, which follows the command
 * order; the hot paths loop arrays.
 */
import { Action } from '../../protocol/messages';
import type { CompiledRig } from '../rig/types';
import type { EventSink, SimObject, SimState } from '../types';
import { applyCarrier, createCarrierRuntime, type CarrierRuntime } from './carrier';
import { CARRIERS, STRAP } from './carriers';
import { HITCH, SAFETY_CHAIN } from './defs';
import { JointKind, JointSet, type Joint } from './joints';

export interface TrailerLink {
  trailer: SimObject;
  tow: SimObject | null;
  hitch: Joint | null;
  chains: Joint[];
  /** Electric brakes (mirror the tow vehicle's pedal; breakaway = full brake once the hitch is gone). */
  braked: boolean;
}

export interface CargoLink {
  cargo: SimObject;
  carrier: CarrierRuntime;
  straps: Joint[];
}

/** Joint breaking arms this long after a coupling is made (the spawn settle), s. */
export const COUPLING_ARM_S = 0.5;
/** Cargo off its carrier's footprint that has not touched it for this long is unloaded (an ordinary prop). */
export const CARGO_LOST_TICKS = 1000;

export class TowingSystem {
  readonly joints = new JointSet();
  /** Carrier runtime per vehicle objectId (insertion = spawn order). */
  readonly carriers = new Map<number, CarrierRuntime>();
  readonly trailers = new Map<number, TrailerLink>();
  readonly cargo = new Map<number, CargoLink>();
  /** Ascending-objectId list of carriers with cargo (hot loop). */
  private active: CarrierRuntime[] = [];

  get busy(): boolean {
    return this.joints.size > 0 || this.active.length > 0 || this.trailers.size > 0;
  }

  /** Registers a carrier if the vehicle's name has one (CARRIERS). */
  addCarrier(obj: SimObject, name: string, rig: CompiledRig): void {
    const def = CARRIERS[name];
    if (!def) return;
    const tri: number[] = [];
    const doorTri: boolean[] = [];
    const id = (n: string): number => rig.nodeIds.indexOf(n);
    const cx = def.center[0];
    const cy = def.center[1];
    const cz = def.center[2];
    const p = rig.nodePos;
    for (const q of def.quads) {
      const ix = q.nodes.map(id);
      if (ix.some((i) => i < 0)) continue;
      for (const t of [
        [ix[0]!, ix[1]!, ix[2]!],
        [ix[0]!, ix[2]!, ix[3]!],
      ]) {
        const [a, b, c] = t as [number, number, number];
        const e0 = [p[3 * b]! - p[3 * a]!, p[3 * b + 1]! - p[3 * a + 1]!, p[3 * b + 2]! - p[3 * a + 2]!];
        const e1 = [p[3 * c]! - p[3 * a]!, p[3 * c + 1]! - p[3 * a + 1]!, p[3 * c + 2]! - p[3 * a + 2]!];
        const n = [e0[1]! * e1[2]! - e0[2]! * e1[1]!, e0[2]! * e1[0]! - e0[0]! * e1[2]!, e0[0]! * e1[1]! - e0[1]! * e1[0]!];
        const toC = [cx - p[3 * a]!, cy - p[3 * a + 1]!, cz - p[3 * a + 2]!];
        const inward = n[0]! * toC[0]! + n[1]! * toC[1]! + n[2]! * toC[2]! > 0;
        if (inward) tri.push(a, b, c);
        else tri.push(a, c, b);
        doorTri.push(!!q.door);
      }
    }
    const rt = createCarrierRuntime(obj, Int32Array.from(tri), Uint8Array.from(doorTri.map((d) => (d ? 1 : 0))), def.lift, def.friction);
    this.carriers.set(obj.objectId, rt);
  }

  carrierOf(objectId: number): CarrierRuntime | undefined {
    return this.carriers.get(objectId);
  }

  /** Opens / closes a carrier's `door` quads (rear doors the rig does not model as closures). */
  setDoors(objectId: number, open: boolean): boolean {
    const c = this.carriers.get(objectId);
    if (!c) return false;
    for (let t = 0; t < c.doors.length; t++) if (c.doors[t] !== 0) c.off[t] = open ? 1 : 0;
    return true;
  }

  /** Forget everything that references `obj` (despawn). Returns the cargo ids whose carrier went away. */
  removeObject(obj: SimObject, excluded: Set<number>, pairKey: (a: number, b: number) => number): void {
    this.joints.removeObject(obj);
    const id = obj.objectId;
    this.trailers.delete(id);
    for (const [tid, t] of this.trailers) {
      if (t.tow === obj) {
        t.tow = null;
        t.hitch = null;
        t.chains = [];
        void tid;
      }
    }
    const c = this.carriers.get(id);
    if (c) {
      for (const g of c.cargo) {
        excluded.delete(pairKey(id, g.objectId));
        this.cargo.delete(g.objectId);
      }
      this.carriers.delete(id);
    }
    const cl = this.cargo.get(id);
    if (cl) {
      excluded.delete(pairKey(cl.carrier.obj.objectId, id));
      const i = cl.carrier.cargo.indexOf(obj);
      if (i >= 0) {
        cl.carrier.cargo.splice(i, 1);
        cl.carrier.touch.splice(i, 1);
      }
      this.cargo.delete(id);
    }
    this.syncActive();
  }

  /** Couples `trailer` to `tow`: ball joint coupler ↔ hitch + two crossed safety chains. */
  hitch(trailer: SimObject, trailerRig: CompiledRig, tow: SimObject, towRig: CompiledRig, towHitchNode: string, braked: boolean, armTick: number, state: SimState): TrailerLink {
    this.unhitch(trailer);
    const coupler = trailerRig.nodeIds.indexOf('coupler');
    const ball = towRig.nodeIds.indexOf(towHitchNode);
    if (coupler < 0 || ball < 0) throw new Error('hitch: missing coupler / hitch node');
    const hitch = this.joints.add({ kind: JointKind.ball, tag: `hitch:${trailer.objectId}`, objA: tow, nodeA: ball, objB: trailer, nodeB: coupler, k: HITCH.k, c: HITCH.c, rest: 0, play: HITCH.play, breakF: HITCH.breakF, armTick });
    // Safety chains: trailer tongue sides → the tow vehicle's body nodes nearest the hitch on the OPPOSITE
    // side (they cross under the coupler and catch the tongue if the ball lets go).
    const chains: Joint[] = [];
    const bx = towRig.nodePos[3 * ball]!;
    const by = towRig.nodePos[3 * ball + 1]!;
    const bz = towRig.nodePos[3 * ball + 2]!;
    for (const [tn, side] of [
      ['tn_L', 1],
      ['tn_R', -1],
    ] as const) {
      const ti = trailerRig.nodeIds.indexOf(tn);
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < towRig.nodeCount; i++) {
        if (i === ball || towRig.nodeInvMass[i] === 0) continue;
        const x = towRig.nodePos[3 * i]!;
        if (side * (x - bx) < 0.12) continue;
        const d = (x - bx - side * 0.3) ** 2 + (towRig.nodePos[3 * i + 1]! - by) ** 2 + (towRig.nodePos[3 * i + 2]! - bz) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (ti < 0 || best < 0) continue;
      const a = tow.nodeStart + best;
      const b = trailer.nodeStart + ti;
      const dx = state.posX[b]! - state.posX[a]!;
      const dy = state.posY[b]! - state.posY[a]!;
      const dz = state.posZ[b]! - state.posZ[a]!;
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz) + SAFETY_CHAIN.slack;
      chains.push(this.joints.add({ kind: JointKind.rope, tag: `chain:${trailer.objectId}`, objA: tow, nodeA: best, objB: trailer, nodeB: ti, k: SAFETY_CHAIN.k, c: SAFETY_CHAIN.c, rest: L, play: 0, breakF: SAFETY_CHAIN.breakF, armTick }));
    }
    const link: TrailerLink = { trailer, tow, hitch, chains, braked };
    this.trailers.set(trailer.objectId, link);
    return link;
  }

  unhitch(trailer: SimObject): void {
    const t = this.trailers.get(trailer.objectId);
    this.joints.remove((j) => j.tag === `hitch:${trailer.objectId}` || j.tag === `chain:${trailer.objectId}`);
    if (t) {
      t.tow = null;
      t.hitch = null;
      t.chains = [];
    }
  }

  /**
   * Loads `cargo` onto `carrier` (contact through the carrier surfaces, no
   * node-vs-node contact between the two) and optionally straps it down:
   * two ratchet straps over the load's top, each from a tie-down anchor on
   * one side to the nearest top node, pretensioned.
   */
  load(cargo: SimObject, carrier: CarrierRuntime, carrierRig: CompiledRig, cargoRig: CompiledRig, carrierName: string, strap: boolean, armTick: number, state: SimState, excluded: Set<number>, pairKey: (a: number, b: number) => number): CargoLink {
    this.unload(cargo, excluded, pairKey);
    carrier.cargo.push(cargo);
    carrier.touch.push(armTick);
    excluded.add(pairKey(carrier.obj.objectId, cargo.objectId));
    const link: CargoLink = { cargo, carrier, straps: [] };
    if (strap) {
      const def = CARRIERS[carrierName]!;
      // The cargo's top nodes (highest quarter of the rest pose).
      let ymax = -Infinity;
      for (let i = 0; i < cargoRig.nodeCount; i++) if (cargoRig.nodeInvMass[i]! > 0) ymax = Math.max(ymax, cargoRig.nodePos[3 * i + 1]!);
      const top: number[] = [];
      for (let i = 0; i < cargoRig.nodeCount; i++) if (cargoRig.nodeInvMass[i]! > 0 && cargoRig.nodePos[3 * i + 1]! > ymax - 0.08) top.push(i);
      const anchors = def.anchors.map((n) => carrierRig.nodeIds.indexOf(n)).filter((i) => i >= 0);
      // The carrier's long axis in the world (rig +Z = rearward): from its frontmost to its rearmost anchor.
      let af = anchors[0] ?? 0;
      let ar = af;
      for (const a of anchors) {
        if (carrierRig.nodePos[3 * a + 2]! < carrierRig.nodePos[3 * af + 2]!) af = a;
        if (carrierRig.nodePos[3 * a + 2]! > carrierRig.nodePos[3 * ar + 2]!) ar = a;
      }
      const ns = carrier.obj.nodeStart;
      let lx = state.posX[ns + ar]! - state.posX[ns + af]!;
      let lz = state.posZ[ns + ar]! - state.posZ[ns + af]!;
      const ll = Math.hypot(lx, lz) || 1;
      lx /= ll;
      lz /= ll;
      const cx = centroid(state, cargo, 0);
      const cz = centroid(state, cargo, 2);
      // Two straps over the load, crossed: on each side one leg to the nearest anchor AHEAD of the load and
      // one to the nearest anchor BEHIND it (each leg ends on the nearest top corner), so the straps pull the
      // load down onto the deck (friction) and also restrain it directly fore and aft.
      for (const side of [-1, 1]) {
        for (const dir of [-1, 1]) {
          let best = -1;
          let bd = Infinity;
          for (const a of anchors) {
            if (side * carrierRig.nodePos[3 * a]! <= 0) continue;
            const g = ns + a;
            const dx = state.posX[g]! - cx;
            const dz = state.posZ[g]! - cz;
            if (dir * (dx * lx + dz * lz) <= 0.05) continue;
            const d = dx * dx + dz * dz;
            if (d < bd) {
              bd = d;
              best = a;
            }
          }
          if (best < 0 || top.length === 0) continue;
          const g = ns + best;
          let tn = top[0]!;
          let td = Infinity;
          for (const t of top) {
            const c = cargo.nodeStart + t;
            const d = (state.posX[c]! - state.posX[g]!) ** 2 + (state.posY[c]! - state.posY[g]!) ** 2 + (state.posZ[c]! - state.posZ[g]!) ** 2;
            if (d < td) {
              td = d;
              tn = t;
            }
          }
          const L0 = Math.sqrt(td);
          const k = STRAP.kL / Math.max(0.3, L0);
          const rest = Math.max(0.05, L0 - STRAP.pretension / k);
          link.straps.push(this.joints.add({ kind: JointKind.rope, tag: `strap:${cargo.objectId}`, objA: carrier.obj, nodeA: best, objB: cargo, nodeB: tn, k, c: STRAP.c, rest, play: 0, breakF: STRAP.breakF, armTick, pretension: STRAP.pretension }));
        }
      }
    }
    this.cargo.set(cargo.objectId, link);
    this.syncActive();
    return link;
  }

  unload(cargo: SimObject, excluded: Set<number>, pairKey: (a: number, b: number) => number): void {
    const l = this.cargo.get(cargo.objectId);
    if (!l) return;
    this.joints.remove((j) => j.tag === `strap:${cargo.objectId}`);
    const i = l.carrier.cargo.indexOf(cargo);
    if (i >= 0) {
      l.carrier.cargo.splice(i, 1);
      l.carrier.touch.splice(i, 1);
    }
    excluded.delete(pairKey(l.carrier.obj.objectId, cargo.objectId));
    this.cargo.delete(cargo.objectId);
    this.syncActive();
  }

  private syncActive(): void {
    this.active = [...this.carriers.values()].filter((c) => c.cargo.length > 0).sort((a, b) => a.obj.objectId - b.obj.objectId);
  }

  /** Tick boundary: joint wake requests, trailer brakes. Returns true when objects were woken. */
  preStep(wake: (obj: SimObject) => void): void {
    const wr = this.joints.wakeRequests;
    if (wr.length > 0) {
      for (let i = 0; i < wr.length; i++) wake(wr[i]!);
      wr.length = 0;
    }
    for (const t of this.trailers.values()) {
      if (!t.braked) continue;
      const a = t.trailer.actions;
      if (t.hitch && !t.hitch.broken && t.tow) {
        a[Action.brake] = t.tow.actions[Action.brake]!;
      } else if (t.hitch && t.hitch.broken) {
        a[Action.brake] = 1; // breakaway switch: the trailer battery applies the brakes
      }
    }
  }

  /** Joints, then carrier surfaces (after the node-vs-node pass). */
  apply(state: SimState, dt: number, tick: number, events: EventSink, gx: number, gy: number, gz: number): void {
    if (this.joints.size > 0) this.joints.apply(state, dt, tick, events);
    const act = this.active;
    for (let i = 0; i < act.length; i++) applyCarrier(state, act[i]!, dt, tick, gx, gy, gz);
  }

  /** Broadphase rebuild: cargo whose centroid left its carrier's node box (+1.5 m) is unloaded. */
  rebuild(state: SimState, tick: number, excluded: Set<number>, pairKey: (a: number, b: number) => number): void {
    if (this.cargo.size === 0) return;
    for (const l of [...this.cargo.values()]) {
      const c = l.carrier.obj;
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = c.nodeStart; i < c.nodeStart + c.nodeCount; i++) {
        const x = state.posX[i]!;
        const y = state.posY[i]!;
        const z = state.posZ[i]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const px = centroid(state, l.cargo, 0);
      const py = centroid(state, l.cargo, 1);
      const pz = centroid(state, l.cargo, 2);
      // Gone: far outside the carrier's box, or off its plan-view footprint and not touching any of its
      // surfaces for CARGO_LOST_TICKS (a crate that went over the gate onto the road just behind it).
      const m = 1.5;
      const far = px < x0 - m || px > x1 + m || py < y0 - m || py > y1 + m || pz < z0 - m || pz > z1 + m;
      const ci = l.carrier.cargo.indexOf(l.cargo);
      const idle = ci >= 0 && tick - l.carrier.touch[ci]! > CARGO_LOST_TICKS;
      const off = px < x0 - 0.1 || px > x1 + 0.1 || pz < z0 - 0.1 || pz > z1 + 0.1;
      if (far || (idle && off)) this.unload(l.cargo, excluded, pairKey);
    }
  }
}

function centroid(state: SimState, o: SimObject, axis: 0 | 1 | 2): number {
  const a = axis === 0 ? state.posX : axis === 1 ? state.posY : state.posZ;
  let s = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) s += a[i]!;
  return s / o.nodeCount;
}
