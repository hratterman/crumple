/**
 * Worker-side autopilot for main-spawned vehicles (P8, protocol
 * `setAutopilot`; docs/CONTRACTS.md "P8 contracts"): the demolition-derby
 * "ram the target" driver. Runs every TRAFFIC_AI_TICKS at the start of a
 * tick (engine.step, after the traffic update), pilots in ascending
 * objectId order. Deterministic: reads sim state only (frame nodes of the
 * pilot, the target's frame origin + velocity), seeded rng per pilot, only
 * + − × ÷ sqrt (the rational atan of the traffic model).
 *
 * Behaviour: aim at the target's position led by its velocity (lead =
 * distance / closing speed, ≤ 1.2 s × aggression), steer toward the bearing
 * (full lock when the target is behind), throttle up to the target speed
 * 9 + 16·aggression m/s — flat out inside the last 18 m (the hit), easing
 * off on full lock at speed. Recovery: stuck (throttle on, < 1 m/s for
 * 1.5 s) or the target close behind → reverse 1.2–2 s with the steering
 * mirrored (swings the nose toward the target), then go again.
 */
import { createRng, type Rng } from '../../core/rng';
import { Action, type SetAutopilotMsg } from '../../protocol/messages';
import { TRAFFIC_AI_TICKS } from '../../protocol/traffic';
import type { SimState } from '../types';
import { atanR } from './model';

/** Seconds per autopilot update (100 Hz). */
export const AUTOPILOT_DT = TRAFFIC_AI_TICKS / 2000;
export const AUTOPILOT_BASE_SPEED = 9;
export const AUTOPILOT_SPEED_GAIN = 16;
const LEAD_MAX_S = 1.2;
const RAM_DIST_M = 18;
const STUCK_SPEED = 1;
const STUCK_S = 1.5;
const REVERSE_MIN_S = 1.2;
const REVERSE_SPREAD_S = 0.8;
const BEHIND_CLOSE_M = 8;
const STEER_GAIN = 1.8;
const STEER_SLEW_PER_TICK = 6 * AUTOPILOT_DT;

export interface Pilot {
  objectId: number;
  target: number;
  aggression: number;
  rng: Rng;
  seed: number;
  reverseS: number;
  stuckS: number;
  steer: number;
}

/** What the autopilot needs from the engine (structural; SimEngine implements it). */
export interface AutopilotHost {
  readonly state: SimState;
  /** [origin, front, top] global node indices of a vehicle's frame, or null (not a vehicle / absent). */
  frameNodesOf(objectId: number, out: Int32Array): boolean;
  /** Sets one action of an object (clamped like setInput); false if absent. */
  setObjectAction(objectId: number, index: number, value: number): boolean;
}

const fr = new Int32Array(3);
const tf = new Int32Array(3);

export class AutopilotSet {
  /** Ascending objectId. */
  readonly pilots: Pilot[] = [];

  get size(): number {
    return this.pilots.length;
  }

  /** Validated by the engine (vehicle exists); 'off' removes (actions zeroed by the caller). */
  set(msg: SetAutopilotMsg): void {
    this.remove(msg.objectId);
    if (msg.mode === 'off') return;
    let a = msg.aggression ?? 0.7;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    const seed = (msg.seed ?? msg.objectId) >>> 0;
    const p: Pilot = { objectId: msg.objectId, target: msg.targetObjectId ?? 1, aggression: a, rng: createRng(seed), seed, reverseS: 0, stuckS: 0, steer: 0 };
    let i = 0;
    while (i < this.pilots.length && this.pilots[i]!.objectId < p.objectId) i++;
    this.pilots.splice(i, 0, p);
  }

  has(objectId: number): boolean {
    return this.pilots.some((p) => p.objectId === objectId);
  }

  remove(objectId: number): void {
    const i = this.pilots.findIndex((p) => p.objectId === objectId);
    if (i >= 0) this.pilots.splice(i, 1);
  }

  /** `reset` of a piloted object: timers and rng restart (a restarted challenge replays the same AI). */
  resetTimers(objectId: number): void {
    const p = this.pilots.find((x) => x.objectId === objectId);
    if (!p) return;
    p.reverseS = 0;
    p.stuckS = 0;
    p.steer = 0;
    p.rng = createRng(p.seed);
  }

  clear(): void {
    this.pilots.length = 0;
  }

  /** One AI tick (call at the start of every TRAFFIC_AI_TICKS-th tick). */
  update(host: AutopilotHost): void {
    const s = host.state;
    for (let k = 0; k < this.pilots.length; k++) {
      const p = this.pilots[k]!;
      if (!host.frameNodesOf(p.objectId, fr)) continue;
      const o = fr[0]!;
      const f = fr[1]!;
      const px = s.posX[o]!;
      const pz = s.posZ[o]!;
      let fx = s.posX[f]! - px;
      let fz = s.posZ[f]! - pz;
      const fl = Math.sqrt(fx * fx + fz * fz);
      if (!(fl > 1e-6)) continue;
      fx /= fl;
      fz /= fl;
      const v = s.velX[o]! * fx + s.velZ[o]! * fz;

      let throttle = 0;
      let brake = 0;
      let gear = 1;
      let steerTarget = 0;
      if (!host.frameNodesOf(p.target, tf)) {
        // no target: stop
        brake = 1;
        p.stuckS = 0;
      } else {
        const to = tf[0]!;
        const tx = s.posX[to]!;
        const tz = s.posZ[to]!;
        const tvx = s.velX[to]!;
        const tvz = s.velZ[to]!;
        let dx = tx - px;
        let dz = tz - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // closing speed along the line of sight
        const ux = dist > 1e-6 ? dx / dist : fx;
        const uz = dist > 1e-6 ? dz / dist : fz;
        const vx = s.velX[o]!;
        const vz = s.velZ[o]!;
        let closing = (vx - tvx) * ux + (vz - tvz) * uz;
        if (closing < 4) closing = 4;
        let lead = dist / closing;
        const leadMax = LEAD_MAX_S * p.aggression;
        if (lead > leadMax) lead = leadMax;
        dx += tvx * lead;
        dz += tvz * lead;
        // Car frame: right = (−fz, fx).
        const lat = dx * -fz + dz * fx;
        const fwd = dx * fx + dz * fz;

        if (p.reverseS > 0) {
          p.reverseS -= AUTOPILOT_DT;
          gear = -1;
          throttle = 0.85;
          // reversing: steering swings the nose the other way
          steerTarget = lat >= 0 ? -1 : 1;
          p.stuckS = 0;
        } else {
          if (fwd <= 0.5) steerTarget = lat >= 0 ? 1 : -1;
          else {
            const x = (STEER_GAIN * lat) / (fwd + 2);
            steerTarget = atanR(x) / 0.78;
          }
          const vTarget = AUTOPILOT_BASE_SPEED + AUTOPILOT_SPEED_GAIN * p.aggression;
          throttle = dist < RAM_DIST_M && fwd > 0 ? 1 : v < vTarget ? 1 : v < vTarget + 2 ? 0.3 : 0;
          if (v > vTarget + 4) brake = 0.4;
          const as = steerTarget < 0 ? -steerTarget : steerTarget;
          if (as > 0.8 && v > 10) throttle *= 0.45;
          // stuck / overshot
          if (throttle > 0.5 && (v < 0 ? -v : v) < STUCK_SPEED) p.stuckS += AUTOPILOT_DT;
          else p.stuckS = 0;
          const behindClose = fwd < 0 && dist < BEHIND_CLOSE_M;
          if (p.stuckS >= STUCK_S || behindClose) {
            p.reverseS = REVERSE_MIN_S + REVERSE_SPREAD_S * p.rng.float();
            p.stuckS = 0;
          }
        }
      }
      if (steerTarget > 1) steerTarget = 1;
      else if (steerTarget < -1) steerTarget = -1;
      const ds = steerTarget - p.steer;
      p.steer += ds > STEER_SLEW_PER_TICK ? STEER_SLEW_PER_TICK : ds < -STEER_SLEW_PER_TICK ? -STEER_SLEW_PER_TICK : ds;
      host.setObjectAction(p.objectId, Action.throttle, throttle);
      host.setObjectAction(p.objectId, Action.brake, brake);
      host.setObjectAction(p.objectId, Action.steer, p.steer);
      host.setObjectAction(p.objectId, Action.handbrake, 0);
      host.setObjectAction(p.objectId, Action.gearSelect, gear);
    }
  }
}
