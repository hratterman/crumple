/**
 * Stunt evaluators (pure, main thread; unit-tested on synthetic samples):
 *
 *  - RotationTracker: integrates the chassis rotation snapshot to snapshot
 *    from the orthonormal frame [right, up, forward]: the relative rotation
 *    Q = R0ᵀ·R1 → axis-angle (body frame) → roll (about forward) and pitch
 *    (about right) accumulate as signed angles over a STUNT SEGMENT, which
 *    starts when the car leaves its wheels (airborne or tumbling) and ends
 *    once it has stood on ≥ 3 wheels for SETTLE_S. The counts are the
 *    accumulated angles in turns (360° = 1), counted in quarter steps with a
 *    30° tolerance (a roll landed 330° round still counts as one).
 *  - AirTracker: jumps (takeoff → touchdown) from `airborne` (telemetry
 *    airborne AND no body contact): distance (horizontal COM), airtime,
 *    height (max COM rise over the takeoff COM).
 *  - DriftScorer: types.ts DRIFT rules (angle × speed × time, combo
 *    multiplier, chain gap, broken by body contact or a spin).
 *  - GateTracker: ordered gates, crossing time interpolated between the
 *    two snapshot times around the crossing.
 */
import {
  DRIFT_BREAK_IMPULSE,
  DRIFT_CHAIN_GAP_S,
  DRIFT_COMBO_STEP_S,
  DRIFT_MAX_ANGLE_DEG,
  DRIFT_MAX_MULT,
  DRIFT_MIN_ANGLE_DEG,
  DRIFT_MIN_SPEED,
  DRIFT_POINTS_SCALE,
  type GateDef,
} from '../types';
import { yawDir } from './geometry';

const TWO_PI = Math.PI * 2;
const QUARTER = Math.PI / 2;
/** Tolerance when counting turns: a roll finished within 30° counts. */
const TURN_TOLERANCE = (30 * Math.PI) / 180;

type V3 = readonly [number, number, number] | readonly number[];

function cross(a: V3, b: V3, out: number[]): void {
  out[0] = a[1]! * b[2]! - a[2]! * b[1]!;
  out[1] = a[2]! * b[0]! - a[0]! * b[2]!;
  out[2] = a[0]! * b[1]! - a[1]! * b[0]!;
}
function dot(a: V3, b: V3): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** Whole turns in quarter steps from an accumulated angle (rad), with the turn tolerance. */
export function turnsOf(angleRad: number): number {
  const a = Math.abs(angleRad);
  const q = Math.floor((a + TURN_TOLERANCE) / QUARTER);
  return q / 4;
}

/** Full rotations (integer) from an accumulated angle (rad), with the turn tolerance. */
export function fullTurns(angleRad: number): number {
  return Math.floor((Math.abs(angleRad) + TURN_TOLERANCE) / TWO_PI);
}

// ============================================================ rotation
export interface RotationSegment {
  /** Signed accumulated angles over the segment, rad (roll + = right side down). */
  roll: number;
  pitch: number;
  yaw: number;
  /** Duration s. */
  duration: number;
}

export class RotationTracker {
  /** Current segment (null while settled on its wheels). */
  segment: RotationSegment | null = null;
  /** Totals over the run, rad (absolute sums of finished segments' magnitudes). */
  totalRoll = 0;
  totalPitch = 0;
  private readonly right0 = [1, 0, 0];
  private readonly up0 = [0, 1, 0];
  private readonly back0 = [0, 0, 1];
  private readonly right1 = [1, 0, 0];
  private readonly back1 = [0, 0, 1];
  private has = false;
  private settled = 0;
  /** Seconds on ≥ 3 wheels that close a segment. */
  static readonly SETTLE_S = 0.35;

  reset(): void {
    this.segment = null;
    this.totalRoll = 0;
    this.totalPitch = 0;
    this.has = false;
    this.settled = 0;
  }

  /**
   * One sample. `onWheels` = ≥ 3 wheels in contact and no body contact.
   * Returns the segment that just ended (rotations to score), else null.
   */
  update(forward: V3, up: V3, onWheels: boolean, dt: number): RotationSegment | null {
    // Right-handed body frame [right, up, back] (back = −forward; right = up × back).
    const b1 = this.back1;
    b1[0] = -forward[0]!;
    b1[1] = -forward[1]!;
    b1[2] = -forward[2]!;
    const r1 = this.right1;
    cross(up, b1, r1);
    if (!this.has) {
      this.copy(b1, up, r1);
      this.has = true;
      return null;
    }
    // Relative rotation in the PREVIOUS body frame: Q = R0ᵀ R1, R = columns [right, up, back].
    const R0x = this.right0;
    const R0y = this.up0;
    const R0z = this.back0;
    const q00 = dot(R0x, r1);
    const q01 = dot(R0x, up);
    const q02 = dot(R0x, b1);
    const q10 = dot(R0y, r1);
    const q11 = dot(R0y, up);
    const q12 = dot(R0y, b1);
    const q20 = dot(R0z, r1);
    const q21 = dot(R0z, up);
    const q22 = dot(R0z, b1);
    const tr = q00 + q11 + q22;
    let c = (tr - 1) / 2;
    if (c > 1) c = 1;
    else if (c < -1) c = -1;
    const angle = Math.acos(c);
    let ax = q21 - q12;
    let ay = q02 - q20;
    let az = q10 - q01;
    const n = Math.hypot(ax, ay, az);
    if (n > 1e-9 && angle > 1e-7) {
      ax = (ax / n) * angle;
      ay = (ay / n) * angle;
      az = (az / n) * angle;
    } else {
      ax = ay = az = 0;
    }
    this.copy(b1, up, r1);

    if (!onWheels) {
      this.settled = 0;
      if (!this.segment) this.segment = { roll: 0, pitch: 0, yaw: 0, duration: 0 };
    } else if (this.segment) {
      this.settled += dt;
    }
    const s = this.segment;
    if (!s) return null;
    // Body axes: x = right (pitch, + = nose up), y = up (yaw, + = left), z = back (roll about −forward).
    s.pitch += ax;
    s.yaw += ay;
    s.roll -= az;
    s.duration += dt;
    if (this.settled >= RotationTracker.SETTLE_S) {
      this.segment = null;
      this.settled = 0;
      this.totalRoll += Math.abs(s.roll);
      this.totalPitch += Math.abs(s.pitch);
      return s;
    }
    return null;
  }

  /** Close the open segment (run end) and return it, if any. */
  flush(): RotationSegment | null {
    const s = this.segment;
    if (!s) return null;
    this.segment = null;
    this.totalRoll += Math.abs(s.roll);
    this.totalPitch += Math.abs(s.pitch);
    return s;
  }

  private copy(b: V3, u: V3, r: V3): void {
    for (let i = 0; i < 3; i++) {
      this.back0[i] = b[i]!;
      this.up0[i] = u[i]!;
      this.right0[i] = r[i]!;
    }
  }
}

// ============================================================ air
export interface JumpResult {
  /** Horizontal COM distance takeoff → touchdown, m. */
  distance: number;
  airtime: number;
  /** Max COM rise above the takeoff COM, m (≥ 0). */
  height: number;
  takeoff: [number, number, number];
  landing: [number, number, number];
  takeoffTime: number;
  landTime: number;
}

export class AirTracker {
  inAir = false;
  airtimeTotal = 0;
  best: JumpResult | null = null;
  jumps = 0;
  private t0 = 0;
  private readonly p0: [number, number, number] = [0, 0, 0];
  private maxY = 0;
  private lastT = 0;

  constructor(public minAirtime = 0.25) {}

  reset(): void {
    this.inAir = false;
    this.airtimeTotal = 0;
    this.best = null;
    this.jumps = 0;
  }

  /** Current flight time (0 on the ground). */
  airtime(now: number): number {
    return this.inAir ? now - this.t0 : 0;
  }

  /** Takeoff COM of the current flight (valid while inAir). */
  get takeoff(): readonly [number, number, number] {
    return this.p0;
  }

  /** One sample; returns a landed qualifying jump, else null. */
  update(t: number, pos: V3, airborne: boolean): JumpResult | null {
    this.lastT = t;
    if (airborne) {
      if (!this.inAir) {
        this.inAir = true;
        this.t0 = t;
        this.p0[0] = pos[0]!;
        this.p0[1] = pos[1]!;
        this.p0[2] = pos[2]!;
        this.maxY = pos[1]!;
      } else if (pos[1]! > this.maxY) this.maxY = pos[1]!;
      return null;
    }
    if (!this.inAir) return null;
    this.inAir = false;
    const airtime = t - this.t0;
    if (airtime < this.minAirtime) return null;
    const dx = pos[0]! - this.p0[0];
    const dz = pos[2]! - this.p0[2];
    const j: JumpResult = {
      distance: Math.hypot(dx, dz),
      airtime,
      height: Math.max(0, this.maxY - this.p0[1]),
      takeoff: [this.p0[0], this.p0[1], this.p0[2]],
      landing: [pos[0]!, pos[1]!, pos[2]!],
      takeoffTime: this.t0,
      landTime: t,
    };
    this.jumps++;
    this.airtimeTotal += airtime;
    if (!this.best || j.distance > this.best.distance) this.best = j;
    return j;
  }
}

// ============================================================ drift
export interface DriftEvent {
  kind: 'bank' | 'broken' | 'spin';
  points: number;
  multiplier: number;
}

export class DriftScorer {
  banked = 0;
  chainPoints = 0;
  chainTime = 0;
  /** Best single banked chain (points × multiplier). */
  bestChain = 0;
  /** Current drift angle, degrees (0 when not drifting). */
  angle = 0;
  private gap = 0;

  reset(): void {
    this.banked = 0;
    this.chainPoints = 0;
    this.chainTime = 0;
    this.bestChain = 0;
    this.angle = 0;
    this.gap = 0;
  }

  get multiplier(): number {
    return Math.min(DRIFT_MAX_MULT, 1 + Math.floor(this.chainTime / DRIFT_COMBO_STEP_S));
  }

  get active(): boolean {
    return this.chainPoints > 0;
  }

  /** Total including the pending chain (× its multiplier). */
  get total(): number {
    return this.banked + this.chainPoints * this.multiplier;
  }

  /**
   * One sample. `vel` world m/s, `forward` unit chassis forward, `grounded`
   * (some wheel on something), `impulse` = the largest body impact this
   * snapshot. Returns a chain event (banked / broken), else null.
   */
  update(dt: number, vel: V3, forward: V3, grounded: boolean, impulse: number): DriftEvent | null {
    if (impulse >= DRIFT_BREAK_IMPULSE && this.chainPoints > 0) return this.lose('broken');
    const vx = vel[0]!;
    const vz = vel[2]!;
    const sp = Math.hypot(vx, vz);
    const fx = forward[0]!;
    const fz = forward[2]!;
    const fl = Math.hypot(fx, fz);
    let angle = 0;
    if (sp >= DRIFT_MIN_SPEED && fl > 0.3 && grounded) {
      let c = (vx * fx + vz * fz) / (sp * fl);
      if (c > 1) c = 1;
      else if (c < -1) c = -1;
      angle = (Math.acos(c) * 180) / Math.PI;
    }
    if (angle > DRIFT_MAX_ANGLE_DEG) {
      this.angle = 0;
      return this.chainPoints > 0 ? this.lose('spin') : null;
    }
    if (angle >= DRIFT_MIN_ANGLE_DEG) {
      this.angle = angle;
      this.gap = 0;
      this.chainPoints += angle * sp * dt * DRIFT_POINTS_SCALE;
      this.chainTime += dt;
      return null;
    }
    this.angle = 0;
    if (this.chainPoints <= 0) return null;
    this.gap += dt;
    if (this.gap < DRIFT_CHAIN_GAP_S) return null;
    return this.bank();
  }

  /** Bank the pending chain now (run end). */
  bank(): DriftEvent | null {
    if (this.chainPoints <= 0) return null;
    const mult = this.multiplier;
    const pts = this.chainPoints * mult;
    this.banked += pts;
    if (pts > this.bestChain) this.bestChain = pts;
    this.chainPoints = 0;
    this.chainTime = 0;
    this.gap = 0;
    return { kind: 'bank', points: pts, multiplier: mult };
  }

  private lose(kind: 'broken' | 'spin'): DriftEvent {
    const ev: DriftEvent = { kind, points: this.chainPoints * this.multiplier, multiplier: this.multiplier };
    this.chainPoints = 0;
    this.chainTime = 0;
    this.gap = 0;
    this.angle = 0;
    return ev;
  }
}

// ============================================================ gates
export interface GateCrossing {
  index: number;
  /** Interpolated crossing time, sim s. */
  time: number;
}

/** A resolved gate: centre (base y resolved), travel direction, half width, height. */
export interface ResolvedGate {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  halfWidth: number;
  height: number;
}

export function resolveGate(g: GateDef, groundAt: (x: number, z: number) => number): ResolvedGate {
  const [dx, dz] = yawDir(g.yawDeg);
  const y = g.pos[1] ?? groundAt(g.pos[0], g.pos[2]);
  return { x: g.pos[0], y, z: g.pos[2], dx, dz, halfWidth: (g.width ?? 10) / 2, height: g.height ?? 5 };
}

/** Lateral slack beyond the painted half width (the COM may be off-centre while the car is clearly through). */
export const GATE_LATERAL_SLACK = 0.75;

export class GateTracker {
  next = 0;
  readonly times: number[] = [];

  constructor(readonly gates: readonly ResolvedGate[]) {}

  get done(): boolean {
    return this.next >= this.gates.length;
  }

  reset(): void {
    this.next = 0;
    this.times.length = 0;
  }

  /** Tests the COM segment p0 (t0) → p1 (t1) against the next gate. */
  update(t0: number, p0: V3, t1: number, p1: V3): GateCrossing | null {
    if (this.done) return null;
    const g = this.gates[this.next]!;
    const s0 = (p0[0]! - g.x) * g.dx + (p0[2]! - g.z) * g.dz;
    const s1 = (p1[0]! - g.x) * g.dx + (p1[2]! - g.z) * g.dz;
    if (!(s0 < 0 && s1 >= 0)) return null;
    const u = s0 / (s0 - s1);
    const x = p0[0]! + (p1[0]! - p0[0]!) * u;
    const y = p0[1]! + (p1[1]! - p0[1]!) * u;
    const z = p0[2]! + (p1[2]! - p0[2]!) * u;
    const lateral = Math.abs((x - g.x) * -g.dz + (z - g.z) * g.dx);
    if (lateral > g.halfWidth + GATE_LATERAL_SLACK) return null;
    if (y < g.y - 1.5 || y > g.y + g.height + 2) return null;
    const time = t0 + (t1 - t0) * u;
    this.times.push(time);
    return { index: this.next++, time };
  }
}
