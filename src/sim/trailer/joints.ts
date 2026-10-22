/**
 * Cross-object JOINTS (R-PHYS2) — WORKER ONLY. Couplings between nodes of
 * two different objects (a beam can only join nodes of one rig):
 *
 *  - BALL  (trailer ball hitch, bolted splices): a zero-length 3-D spring-
 *          damper between node A and node B with a dead band `play` (the
 *          coupler's free play: it clunks) — free rotation, translation held.
 *  - ROPE  (safety chains, cargo straps, cable anchors): tension only, slack
 *          up to `rest` (m), then a spring-damper along the line; `rest`
 *          below the current distance = pretension (a ratcheted strap).
 *  - LINK  (pin-and-loop barrier connections, bolted splices): a distance
 *          spring-damper (both ways) at `rest` with a ± `play` dead band.
 *
 * LAW: implicit (backward Euler) on the joint's own spring-damper, with the
 * predicted velocities v* = v + F·dt/m that already include every force of
 * the tick so far (beams, node contacts), so any stiffness is stable and the
 * joint never adds to a node's explicit ω·dt budget:
 *   u* = relative velocity (B − A) along the constrained direction(s),
 *   u' = (u* − dt·(k/m_r)·e) / (1 + dt·c/m_r + dt²·k/m_r),   J = m_r·(u' − u*),
 *   F_B = J/dt, F_A = −J/dt   (equal and opposite: momentum exact),
 * m_r = m_A·m_B/(m_A + m_B); a pinned node or a SLEEPING object is infinite
 * mass (m_r = the free side's mass, only the free side is pushed) and a joint
 * force above JOINT_WAKE_FORCE requests that object's wake (applied by the
 * engine at the next tick boundary: deterministic).
 * BREAK: |F| > breakF (sticky); an impact event (metal) marks it for FX/audio.
 *
 * PHASE: after the node-vs-node pass, before phase 3 (water → ground →
 * colliders → shell → integrate): the implicit ground friction and the rigid
 * shell clusters see the joint force. Joints run in creation order.
 *
 * NUMERICS: + − × ÷ sqrt only, zero allocation in apply().
 */
import { MaterialId } from '../../protocol/messages';
import { SIM_OBJECT_FLAG_SLEEPING, type EventSink, type SimObject, type SimState } from '../types';

export const JointKind = { ball: 0, rope: 1, link: 2 } as const;
export type JointKind = (typeof JointKind)[keyof typeof JointKind];

/** A joint force above this wakes a sleeping object on either side, N. */
export const JOINT_WAKE_FORCE = 150;

export interface JointSpec {
  kind: JointKind;
  /** Free-form tag (trailer id, strap id) for queries / removal. */
  tag: string;
  objA: SimObject;
  /** Object-local node index. */
  nodeA: number;
  objB: SimObject;
  nodeB: number;
  /** Stiffness N/m and damping N·s/m. */
  k: number;
  c: number;
  /** ROPE: slack length (m). BALL: unused (0). */
  rest: number;
  /** BALL: free play radius, m (0 = none). */
  play: number;
  /** Break force, N (Infinity = never). */
  breakF: number;
  /** The joint cannot break before this tick (a coupling made at spawn settles first). Default 0. */
  armTick?: number;
  /**
   * ROPE: ratchet pretension, N. Until `armTick` the rope's slack length is taken up so it holds this
   * tension (the load settles onto the deck after a strap is cinched: a fixed rest length went slack).
   */
  pretension?: number;
}

export interface Joint extends JointSpec {
  broken: boolean;
  /** |F| of the last tick, N (diagnostics, tests), and its vector on node B. */
  force: number;
  fx: number;
  fy: number;
  fz: number;
  /** Peak |F| since creation, N. */
  peak: number;
}

export class JointSet {
  readonly joints: Joint[] = [];
  /** Objects whose wake a joint requested this tick (engine drains it at the next tick boundary). */
  readonly wakeRequests: SimObject[] = [];

  add(spec: JointSpec): Joint {
    if (spec.objA === spec.objB) throw new Error('joint: both ends on one object (use a beam)');
    for (const v of [spec.k, spec.c, spec.rest, spec.play]) if (!(Number.isFinite(v) && v >= 0)) throw new Error(`joint ${spec.tag}: invalid parameter ${v}`);
    if (!(spec.breakF > 0)) throw new Error(`joint ${spec.tag}: breakF must be > 0`);
    const j: Joint = { ...spec, broken: false, force: 0, fx: 0, fy: 0, fz: 0, peak: 0 };
    this.joints.push(j);
    return j;
  }

  /** Removes every joint with `tag` (or touching `obj`). Returns the count. */
  remove(pred: (j: Joint) => boolean): number {
    let w = 0;
    let n = 0;
    for (let r = 0; r < this.joints.length; r++) {
      const j = this.joints[r]!;
      if (pred(j)) n++;
      else this.joints[w++] = j;
    }
    this.joints.length = w;
    return n;
  }

  removeObject(obj: SimObject): number {
    return this.remove((j) => j.objA === obj || j.objB === obj);
  }

  /** Repairs (un-breaks) the joints matching `pred`. */
  repair(pred: (j: Joint) => boolean): void {
    for (const j of this.joints) if (pred(j)) j.broken = false;
  }

  get size(): number {
    return this.joints.length;
  }

  /** Applies every intact joint (creation order). See the header for the law. */
  apply(state: SimState, dt: number, tick: number, events: EventSink): void {
    const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass } = state;
    const js = this.joints;
    for (let q = 0; q < js.length; q++) {
      const j = js[q]!;
      if (j.broken) continue;
      const oa = j.objA;
      const ob = j.objB;
      const sa = (oa.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
      const sb = (ob.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
      if (sa && sb) {
        j.force = 0;
        continue;
      }
      const a = oa.nodeStart + j.nodeA;
      const b = ob.nodeStart + j.nodeB;
      const ima = sa ? 0 : invMass[a]!;
      const imb = sb ? 0 : invMass[b]!;
      const ims = ima + imb;
      if (ims === 0) continue;
      const mr = 1 / ims;
      // Predicted velocities (the tick's forces so far included).
      const ux = velX[b]! + frcX[b]! * imb * dt - velX[a]! - frcX[a]! * ima * dt;
      const uy = velY[b]! + frcY[b]! * imb * dt - velY[a]! - frcY[a]! * ima * dt;
      const uz = velZ[b]! + frcZ[b]! * imb * dt - velZ[a]! - frcZ[a]! * ima * dt;
      const ex = posX[b]! - posX[a]!;
      const ey = posY[b]! - posY[a]!;
      const ez = posZ[b]! - posZ[a]!;
      const kd = (dt * j.k) / mr;
      const den = 1 + (dt * j.c) / mr + dt * kd;
      let jx = 0;
      let jy = 0;
      let jz = 0;
      if (j.kind === JointKind.ball) {
        // Dead band: the spring acts on the offset beyond `play` (radially).
        let fx = ex;
        let fy = ey;
        let fz = ez;
        if (j.play > 0) {
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          const s = d > j.play ? (d - j.play) / d : 0;
          fx *= s;
          fy *= s;
          fz *= s;
        }
        jx = mr * ((ux - kd * fx) / den - ux);
        jy = mr * ((uy - kd * fy) / den - uy);
        jz = mr * ((uz - kd * fz) / den - uz);
      } else if (j.kind === JointKind.link) {
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < 1e-9) continue;
        let s = d - j.rest;
        if (s > j.play) s -= j.play;
        else if (s < -j.play) s += j.play;
        else s = 0;
        const nx = ex / d;
        const ny = ey / d;
        const nz = ez / d;
        const un = ux * nx + uy * ny + uz * nz;
        const jn = mr * ((un - kd * s) / den - un);
        jx = jn * nx;
        jy = jn * ny;
        jz = jn * nz;
      } else {
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (j.pretension !== undefined && tick < (j.armTick ?? 0)) {
          const r = d - j.pretension / j.k;
          if (r < j.rest && r > 0.02) j.rest = r;
        }
        const s = d - j.rest;
        if (s <= 0 || d < 1e-9) {
          j.force = 0;
          continue;
        }
        const nx = ex / d;
        const ny = ey / d;
        const nz = ez / d;
        const un = ux * nx + uy * ny + uz * nz;
        let jn = mr * ((un - kd * s) / den - un);
        if (jn > 0) jn = 0; // a rope only pulls
        jx = jn * nx;
        jy = jn * ny;
        jz = jn * nz;
      }
      const invDt = 1 / dt;
      const Fx = jx * invDt;
      const Fy = jy * invDt;
      const Fz = jz * invDt;
      const F = Math.sqrt(Fx * Fx + Fy * Fy + Fz * Fz);
      j.force = F;
      j.fx = Fx;
      j.fy = Fy;
      j.fz = Fz;
      if (F > j.peak) j.peak = F;
      if (F > j.breakF && tick >= (j.armTick ?? 0)) {
        j.broken = true;
        j.force = 0;
        events.impact(oa.objectId, MaterialId.metal, posX[a]!, posY[a]!, posZ[a]!, 0, 1, 0, F * dt);
        continue;
      }
      if (imb > 0) {
        frcX[b] = frcX[b]! + Fx;
        frcY[b] = frcY[b]! + Fy;
        frcZ[b] = frcZ[b]! + Fz;
      }
      if (ima > 0) {
        frcX[a] = frcX[a]! - Fx;
        frcY[a] = frcY[a]! - Fy;
        frcZ[a] = frcZ[a]! - Fz;
      }
      if (F > JOINT_WAKE_FORCE) {
        if (sa) this.wakeRequests.push(oa);
        else if (sb) this.wakeRequests.push(ob);
      }
    }
  }
}
