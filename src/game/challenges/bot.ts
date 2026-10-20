/**
 * Playtest bot (pure): pure pursuit along a polyline with a curvature-aware
 * speed profile and a speed PI. Drives the in-game debug bot
 * (`__crumple.challenges.bot`) and the headless playtests that tuned the
 * medal thresholds. Not an opponent AI (that is the worker's ram autopilot).
 */
import type { ChallengeSample, XZ } from './types';

export interface BotConfig {
  line: readonly XZ[];
  /** Cruise target, km/h. */
  speedKmh: number;
  /** Lateral acceleration budget for the corner speed, m/s² (default 6). */
  latAcc?: number;
  /** Stop (brake) within this many metres of the line's end (default: drive through). */
  stopAtEnd?: boolean;
  /** Throttle ceiling (default 1). */
  maxThrottle?: number;
  /** Steering gain (default 1.6). */
  steerGain?: number;
  /** Lookahead clamp, m (default [5, 22]). */
  lookahead?: readonly [number, number];
}

export interface BotActions {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: number;
}

export class Bot {
  private seg = 0;
  /** Distance left to the end of the line (m), updated per call. */
  remaining = Infinity;
  private readonly cum: number[] = [0];
  readonly out: BotActions = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

  constructor(readonly cfg: BotConfig) {
    const l = cfg.line;
    for (let i = 1; i < l.length; i++) this.cum.push(this.cum[i - 1]! + Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]));
  }

  get length(): number {
    return this.cum[this.cum.length - 1]!;
  }

  /** Point at arc distance s along the line (clamped; extended straight past the end). */
  private at(s: number): [number, number] {
    const l = this.cfg.line;
    const L = this.length;
    if (s >= L) {
      const a = l[l.length - 2]!;
      const b = l[l.length - 1]!;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [b[0] + ((b[0] - a[0]) / d) * (s - L), b[1] + ((b[1] - a[1]) / d) * (s - L)];
    }
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1]! < s) i++;
    const u = (s - this.cum[i]!) / Math.max(1e-6, this.cum[i + 1]! - this.cum[i]!);
    return [l[i]![0] + (l[i + 1]![0] - l[i]![0]) * u, l[i]![1] + (l[i + 1]![1] - l[i]![1]) * u];
  }

  /** Heading change per metre over [s, s + span] (curvature estimate). */
  private curvature(s: number, span: number): number {
    const a = this.at(s);
    const b = this.at(s + span / 2);
    const c = this.at(s + span);
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) / (span / 2);
  }

  update(s: Readonly<ChallengeSample>): BotActions {
    const o = this.out;
    const l = this.cfg.line;
    const px = s.pos[0];
    const pz = s.pos[2];
    // progress: nearest point on segments seg..seg+3 (monotonic)
    let best = Infinity;
    let bestS = this.cum[this.seg]!;
    for (let i = this.seg; i < Math.min(l.length - 1, this.seg + 4); i++) {
      const a = l[i]!;
      const b = l[i + 1]!;
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const e2 = ex * ex + ez * ez || 1;
      const u = Math.max(0, Math.min(1, ((px - a[0]) * ex + (pz - a[1]) * ez) / e2));
      const d = Math.hypot(a[0] + ex * u - px, a[1] + ez * u - pz);
      if (d < best) {
        best = d;
        bestS = this.cum[i]! + u * Math.sqrt(e2);
        if (i > this.seg && u > 0) this.seg = i;
      }
    }
    const v = Math.hypot(s.vel[0], s.vel[2]);
    const [lmin, lmax] = this.cfg.lookahead ?? [5, 22];
    const L = Math.max(lmin, Math.min(lmax, 0.55 * v + 4));
    const tgt = this.at(bestS + L);
    const dx = tgt[0] - px;
    const dz = tgt[1] - pz;
    const fx = s.forward[0];
    const fz = s.forward[2];
    const fl = Math.hypot(fx, fz) || 1;
    const ahead = (dx * fx + dz * fz) / fl;
    const lat = (dx * -fz + dz * fx) / fl;
    const ang = Math.atan2(lat, Math.max(0.1, ahead));
    o.steer = Math.max(-1, Math.min(1, (this.cfg.steerGain ?? 1.6) * ang));
    // speed profile
    let vt = this.cfg.speedKmh / 3.6;
    const kap = Math.max(this.curvature(bestS + 2, 16), this.curvature(bestS + 0.4 * v + 6, 24));
    if (kap > 1e-4) vt = Math.min(vt, Math.sqrt((this.cfg.latAcc ?? 6) / kap));
    this.remaining = this.length - bestS;
    if (this.cfg.stopAtEnd) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * 2.5 * (this.remaining - 0.6))));
    const e = vt - v;
    if (e >= 0) {
      o.throttle = Math.min(this.cfg.maxThrottle ?? 1, 0.25 + 0.35 * e);
      o.brake = 0;
    } else {
      o.throttle = 0;
      o.brake = Math.min(1, -0.25 * e);
    }
    if (this.cfg.stopAtEnd && this.remaining < 0.8 && v < 1.5) {
      o.throttle = 0;
      o.brake = 1;
    }
    o.handbrake = 0;
    return o;
  }
}
