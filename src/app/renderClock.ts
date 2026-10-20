/**
 * Live render clock + node-position history (main thread, no three).
 *
 * WHY (measured, `presentation.harness.ts`): the old render clock restarted
 * at every snapshot arrival (`prev.simTime + span · (now − arrival) /
 * smoothed interval`, clamped to [0, 1]). The worker's wakes are paced by
 * setTimeout (≥ 4 ms clamp) plus its own CPU time, so snapshots arrive with
 * several ms of jitter and their sim spans alternate between 1 and 2
 * snapshot ticks; every arrival snapped the clock and late ones held it.
 * The rendered car therefore moved in uneven steps: clock error RMS
 * 1.0–3.8 ms, max 9–11 ms at 60 / 120 / 144 Hz displays, i.e. at 30 m/s
 * the car jumped up to ~30 cm against the (smoothed) chase camera.
 *
 * RenderClock advances by the frame's wall time × the sim's time scale and
 * steers its RATE (±8 %) so that the lowest "lead" (newest snapshot time −
 * render time, sampled just before each arrival) settles at `margin`: the
 * render time trails the newest snapshot by about one snapshot interval +
 * the arrival jitter, and interpolation always has data. A late snapshot is
 * bridged by a short linear extrapolation (≤ half a snapshot interval);
 * large discontinuities (stall, time-scale step, replay exit) re-sync.
 *
 * NodeHistory keeps copies of the last few snapshots' node positions (the
 * 3-buffer pool lets main hold only two buffers) so the delayed render time
 * can be interpolated between the right pair.
 */
import type { SnapshotReader } from '../protocol/codec';
import { NODE_STRIDE } from '../protocol/layout';
import { createTrafficAgentFrame, type TrafficAgentFrame } from '../protocol/traffic';

/** Target lowest lead behind the newest snapshot, sim s. */
export const CLOCK_MARGIN_S = 0.0015;
/** Max rate correction (fraction of the time scale). */
export const CLOCK_MAX_CORR = 0.08;
/** Lead error is removed over about this much wall time, s. */
export const CLOCK_CORR_TAU_S = 1.0;
/** Above this excess lead (sim s per unit time scale) the correction may reach CLOCK_FAST_CORR. */
export const CLOCK_FAST_LEAD_S = 0.03;
export const CLOCK_FAST_CORR = 0.25;
/** Per-arrival blend of the rate correction toward its new target. */
export const CLOCK_CORR_SLEW = 0.1;
/** Re-sync when the lead exceeds this (sim s; e.g. after a worker stall). */
export const CLOCK_RESYNC_LEAD_S = 0.1;
/** Extrapolation past the newest snapshot is capped at this fraction of a snapshot interval. */
export const CLOCK_MAX_EXTRAP = 0.5;

export class RenderClock {
  /** Render sim time, s (NaN until first used). */
  private t = NaN;
  private wallMs = 0;
  private corr = 0;
  /** Filtered lowest lead (sim s). */
  private trough = NaN;
  /** Smoothed sim time between consecutive snapshots, s. */
  span = 1 / 120;

  reset(): void {
    this.t = NaN;
    this.corr = 0;
    this.trough = NaN;
  }

  /** Rate correction currently applied (diagnostics). */
  get correction(): number {
    return this.corr;
  }

  /**
   * A snapshot arrived at `nowMs`: `prevNewest` = the newest sim time held
   * before it (NaN if none), `newest` = its sim time, `ts` = its time scale.
   */
  onArrival(nowMs: number, prevNewest: number, newest: number, ts: number): void {
    const gap = newest - prevNewest;
    if (gap > 0 && gap < 0.25) this.span += (gap - this.span) * 0.1;
    if (Number.isNaN(this.t) || !(gap > 0)) {
      if (!(gap >= 0)) this.reset(); // time went backwards (new worker / resimulation)
      return;
    }
    const rate = ts > 0 ? ts : 0;
    let dt = (nowMs - this.wallMs) / 1000;
    dt = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    const tp = this.t + dt * rate * (1 + this.corr);
    const lead = prevNewest - tp;
    if (newest - tp > CLOCK_RESYNC_LEAD_S || lead < -2 * this.span - CLOCK_RESYNC_LEAD_S) {
      this.reset();
      return;
    }
    const tf = this.trough;
    // Fast toward lower troughs (avoid starving), slow toward higher ones.
    this.trough = Number.isNaN(tf) ? lead : tf + (lead - tf) * (lead < tf ? 0.5 : 0.08);
    const e = this.trough - CLOCK_MARGIN_S;
    const scale = rate > 0.05 ? rate : 0.05;
    let c = e / (CLOCK_CORR_TAU_S * scale);
    // Far behind (after a worker stall's catch-up burst): catch up faster rather than lag for a second.
    const hi = e > CLOCK_FAST_LEAD_S * scale ? CLOCK_FAST_CORR : CLOCK_MAX_CORR;
    c = c > hi ? hi : c < -CLOCK_MAX_CORR ? -CLOCK_MAX_CORR : c;
    // Slewed: a rate step is itself a visible velocity step at speed.
    this.corr += (c - this.corr) * CLOCK_CORR_SLEW;
  }

  /** Render sim time at `nowMs` (advances the clock; call once per frame). */
  time(nowMs: number, newest: number, ts: number): number {
    if (Number.isNaN(this.t)) {
      this.t = newest - this.span - CLOCK_MARGIN_S;
      this.wallMs = nowMs;
      this.corr = 0;
      return this.t;
    }
    let dt = (nowMs - this.wallMs) / 1000;
    dt = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    this.wallMs = nowMs;
    const rate = ts > 0 ? ts : 0;
    let t = this.t + dt * rate * (1 + this.corr);
    const cap = newest + CLOCK_MAX_EXTRAP * this.span;
    if (t > cap) t = cap > this.t ? cap : this.t;
    this.t = t;
    return t;
  }
}

interface HistEntry {
  simTime: number;
  nodes: Float32Array;
  objCount: number;
  ids: Int32Array;
  offs: Int32Array;
  counts: Int32Array;
  traffic: TrafficAgentFrame[];
  trafficCount: number;
}

function newEntry(): HistEntry {
  return {
    simTime: 0,
    nodes: new Float32Array(0),
    objCount: 0,
    ids: new Int32Array(0),
    offs: new Int32Array(0),
    counts: new Int32Array(0),
    traffic: [],
    trafficCount: 0,
  };
}

/** Number of snapshots kept for the delayed render clock. */
export const HISTORY_LENGTH = 6;

export class NodeHistory {
  private readonly ring: HistEntry[] = [];
  private head = 0;
  /** Entries held (≤ HISTORY_LENGTH), oldest at `head`. */
  length = 0;

  constructor(readonly capacity = HISTORY_LENGTH) {
    for (let i = 0; i < capacity; i++) this.ring.push(newEntry());
  }

  clear(): void {
    this.length = 0;
    this.head = 0;
  }

  /** i = 0 oldest … length − 1 newest. */
  private at(i: number): HistEntry {
    return this.ring[(this.head + i) % this.capacity]!;
  }

  get newestTime(): number {
    return this.length > 0 ? this.at(this.length - 1).simTime : NaN;
  }

  push(r: SnapshotReader): void {
    let e: HistEntry;
    if (this.length < this.capacity) {
      e = this.at(this.length);
      this.length++;
    } else {
      e = this.ring[this.head]!;
      this.head = (this.head + 1) % this.capacity;
    }
    e.simTime = r.simTime;
    const src = r.nodes;
    if (e.nodes.length < src.length) e.nodes = new Float32Array(Math.max(src.length, e.nodes.length * 2));
    e.nodes.set(src);
    const n = r.objectCount;
    if (e.ids.length < n) {
      const cap = Math.max(n, e.ids.length * 2, 8);
      e.ids = new Int32Array(cap);
      e.offs = new Int32Array(cap);
      e.counts = new Int32Array(cap);
    }
    for (let i = 0; i < n; i++) {
      e.ids[i] = r.objectId(i);
      e.offs[i] = r.objectNodeOffset(i);
      e.counts[i] = r.objectNodeCount(i);
    }
    e.objCount = n;
    const tn = r.trafficCount;
    while (e.traffic.length < tn) e.traffic.push(createTrafficAgentFrame());
    for (let i = 0; i < tn; i++) r.readTrafficAgent(i, e.traffic[i]!);
    e.trafficCount = tn;
  }

  /**
   * Bracketing pair for `t`: writes [olderIndex, newerIndex, u] (u ∈ [0, 1],
   * or up to 1 + CLOCK_MAX_EXTRAP·… beyond the newest = extrapolation) into
   * `out`; false when fewer than 2 entries.
   */
  private bracket(t: number, out: Float64Array): boolean {
    const n = this.length;
    if (n < 2) return false;
    let j = n - 2;
    if (t <= this.at(0).simTime) j = 0;
    else for (let i = 0; i < n - 1; i++) if (t <= this.at(i + 1).simTime) { j = i; break; }
    const a = this.at(j);
    const b = this.at(j + 1);
    const span = b.simTime - a.simTime;
    let u = span > 0 ? (t - a.simTime) / span : 1;
    if (u < 0) u = 0;
    // beyond the newest: bounded linear extrapolation (RenderClock caps t as well)
    const uMax = 1 + CLOCK_MAX_EXTRAP;
    if (u > uMax) u = uMax;
    out[0] = j;
    out[1] = j + 1;
    out[2] = u;
    return true;
  }
  private readonly br = new Float64Array(3);

  /**
   * Node positions at `t` in `cur`'s layout (global snapshot order). Objects
   * missing from the bracketing pair (or with another node count) take
   * `cur`'s positions. Returns false (out untouched) with < 2 entries.
   */
  interpolate(t: number, cur: SnapshotReader, out: Float32Array): boolean {
    if (!this.bracket(t, this.br)) return false;
    const a = this.at(this.br[0]!);
    const b = this.at(this.br[1]!);
    const u = this.br[2]!;
    const curNodes = cur.nodes;
    let ia = 0;
    let ib = 0;
    for (let i = 0, n = cur.objectCount; i < n; i++) {
      const id = cur.objectId(i);
      const off = cur.objectNodeOffset(i) * NODE_STRIDE;
      const cnt = cur.objectNodeCount(i);
      const len = cnt * NODE_STRIDE;
      // objects are in ascending id order in every snapshot: merge walk
      while (ia < a.objCount && a.ids[ia]! < id) ia++;
      while (ib < b.objCount && b.ids[ib]! < id) ib++;
      const inA = ia < a.objCount && a.ids[ia] === id && a.counts[ia] === cnt;
      const inB = ib < b.objCount && b.ids[ib] === id && b.counts[ib] === cnt;
      if (inA && inB) {
        const pa = a.offs[ia]! * NODE_STRIDE;
        const pb = b.offs[ib]! * NODE_STRIDE;
        const na = a.nodes;
        const nb = b.nodes;
        for (let k = 0; k < len; k++) {
          const x = na[pa + k]!;
          out[off + k] = x + (nb[pb + k]! - x) * u;
        }
      } else if (inB) {
        out.set(b.nodes.subarray(b.offs[ib]! * NODE_STRIDE, b.offs[ib]! * NODE_STRIDE + len), off);
      } else {
        out.set(curNodes.subarray(off, off + len), off);
      }
    }
    return true;
  }

  /** `objectId` is in both snapshots of the bracketing pair for `t` with the same node count. */
  hasObjectPair(objectId: number, t: number): boolean {
    if (!this.bracket(t, this.br)) return false;
    const a = this.at(this.br[0]!);
    const b = this.at(this.br[1]!);
    let ca = -1;
    let cb = -2;
    for (let i = 0; i < a.objCount; i++) if (a.ids[i] === objectId) { ca = a.counts[i]!; break; }
    for (let i = 0; i < b.objCount; i++) if (b.ids[i] === objectId) { cb = b.counts[i]!; break; }
    return ca === cb;
  }

  /** One node of `objectId` at `t` into out[0..2]; false when not in the bracketing pair. */
  node(objectId: number, local: number, t: number, out: { [i: number]: number }): boolean {
    if (!this.bracket(t, this.br)) return false;
    const a = this.at(this.br[0]!);
    const b = this.at(this.br[1]!);
    const u = this.br[2]!;
    let ia = -1;
    let ib = -1;
    for (let i = 0; i < a.objCount; i++) if (a.ids[i] === objectId) { ia = i; break; }
    for (let i = 0; i < b.objCount; i++) if (b.ids[i] === objectId) { ib = i; break; }
    if (ib < 0 || local < 0 || local >= b.counts[ib]!) return false;
    const pb = (b.offs[ib]! + local) * NODE_STRIDE;
    if (ia < 0 || a.counts[ia] !== b.counts[ib]) {
      out[0] = b.nodes[pb]!;
      out[1] = b.nodes[pb + 1]!;
      out[2] = b.nodes[pb + 2]!;
      return true;
    }
    const pa = (a.offs[ia]! + local) * NODE_STRIDE;
    for (let k = 0; k < 3; k++) out[k] = a.nodes[pa + k]! + (b.nodes[pb + k]! - a.nodes[pa + k]!) * u;
    return true;
  }

  /**
   * Traffic agent `agent`'s records in the bracketing pair for `t`: returns
   * u and fills `older` / `newer` (false when the pair lacks it).
   */
  trafficPair(agent: number, t: number, older: TrafficAgentFrame, newer: TrafficAgentFrame): number {
    if (!this.bracket(t, this.br)) return -1;
    const a = this.at(this.br[0]!);
    const b = this.at(this.br[1]!);
    let ja = -1;
    let jb = -1;
    for (let i = 0; i < a.trafficCount; i++) if (a.traffic[i]!.agent === agent) { ja = i; break; }
    for (let i = 0; i < b.trafficCount; i++) if (b.traffic[i]!.agent === agent) { jb = i; break; }
    if (ja < 0 || jb < 0) return -1;
    copyAgent(a.traffic[ja]!, older);
    copyAgent(b.traffic[jb]!, newer);
    return this.br[2]!;
  }
}

function copyAgent(s: TrafficAgentFrame, d: TrafficAgentFrame): void {
  d.agent = s.agent;
  d.objectId = s.objectId;
  d.flags = s.flags;
  d.variant = s.variant;
  d.paint = s.paint;
  d.state = s.state;
  d.pos[0] = s.pos[0];
  d.pos[1] = s.pos[1];
  d.pos[2] = s.pos[2];
  d.quat[0] = s.quat[0];
  d.quat[1] = s.quat[1];
  d.quat[2] = s.quat[2];
  d.quat[3] = s.quat[3];
  d.speed = s.speed;
  d.steer = s.steer;
  d.brake = s.brake;
  d.path = s.path;
}
