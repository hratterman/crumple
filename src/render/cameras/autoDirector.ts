/**
 * Auto director (P7 R2): decides WHEN to cut and TO WHAT, like a broadcast
 * editor. Pure rules over the playhead, the markers and the current shot's
 * health; the camera rig builds the shots and answers `probe` (would this
 * shot see the subject from where it would start?).
 *
 * Editorial rules (all shot lengths in WALL seconds: what the viewer feels):
 *  1. Never cut within MIN_SHOT_S (1.5 s) of the previous cut. No exceptions.
 *  2. Cut on impact: playing forward, an upcoming marker (severity ≥
 *     IMPACT_MIN_SEVERITY) is cut to IMPACT_LEAD_S of viewing time before it,
 *     to the best static angle on its crash point ('impact' shot). If rule 1
 *     blocks that moment, the cut lands as soon as it is legal while still
 *     within IMPACT_LATE_S of sim time after the impact (cut on the action).
 *  3. Hold for the impact: no discretionary cut while an impact cut is due
 *     within MIN_SHOT_S + IMPACT_LEAD_S (it would leave a < 1.5 s shot).
 *  4. Line of sight: a shot that lost its subject (terrain, a wall) for a
 *     moment is cut away from as soon as rule 1 allows.
 *  5. Pace: every shot has a planned length by kind (seeded jitter); a
 *     trackside shot also ends once the subject recedes out of it.
 *  6. Variety: never the same kind twice in a row, the one before that is
 *     discouraged, only candidates whose opening frame sees the subject.
 */
import { createRng, type Rng } from '../../core/rng';
import type { ShotKind } from './shots';

export const MIN_SHOT_S = 1.5;
export const IMPACT_LEAD_S = 0.55;
export const IMPACT_LATE_S = 0.45;
export const IMPACT_MIN_SEVERITY = 0.2;

/** A crash moment (structurally a ReplayMarker). */
export interface DirectorMarker {
  readonly id: number;
  readonly time: number;
  readonly severity: number;
  readonly objectId: number;
  readonly pos: ArrayLike<number>;
}

export interface DirectorFrame {
  wallDt: number;
  /** Presented time, s. */
  time: number;
  playing: boolean;
  /** Playback rate magnitude (sim s per wall s) and direction. */
  speed: number;
  direction: 1 | -1;
  /** Subject horizontal speed, m/s. */
  subjectSpeed: number;
  /** Subject id (impact cuts only for markers on it, or with it within reach). */
  subjectId: number;
  markers: readonly DirectorMarker[];
}

export interface CurrentShot {
  kind: ShotKind;
  healthy: boolean;
  /** The shot asks to end (trackside: the subject receded). */
  wantsCut: boolean;
}

export interface CutDecision {
  kind: ShotKind;
  variant: number;
  /** Set for an impact cut. */
  marker: DirectorMarker | null;
  reason: 'start' | 'impact' | 'los' | 'pace' | 'receded';
}

/** Can a shot of `kind` / `variant` start now with the subject in view? */
export type ShotProbe = (kind: ShotKind, variant: number) => boolean;

const DISCRETIONARY: readonly ShotKind[] = ['follow', 'bumper', 'trackside', 'heli', 'hood'];
const LENGTH: Readonly<Record<ShotKind, readonly [number, number]>> = {
  follow: [4, 6.5],
  bumper: [3, 4.5],
  trackside: [3.5, 6],
  heli: [4, 6],
  hood: [2.4, 3.4],
  impact: [3, 4.2],
};

export class AutoDirector {
  /** Wall seconds since the last cut. */
  age = 0;
  planned = 4;
  private rng: Rng;
  private readonly seed: number;
  private prevKind: ShotKind | null = null;
  private curKind: ShotKind | null = null;
  private lastImpactId = -1;
  private cuts = 0;

  constructor(seed = 0x5eed) {
    this.seed = seed;
    this.rng = createRng(seed);
  }

  get cutCount(): number {
    return this.cuts;
  }

  /** New sequence (enter, seek): the next decide() opens with an establishing shot. */
  reset(seed = this.seed): void {
    this.rng = createRng(seed);
    this.prevKind = this.curKind = null;
    this.age = 0;
    this.lastImpactId = -1;
  }

  /** Mark impacts at or before `time` as already covered (a seek past them must not cut back). */
  skipImpactsBefore(markers: readonly DirectorMarker[], time: number): void {
    for (const m of markers) if (m.time <= time && m.id > this.lastImpactId) this.lastImpactId = m.id;
  }

  /**
   * One frame. Returns a cut (the caller resets that shot) or null. `current`
   * null = nothing on screen yet (always cuts: rule 1 does not apply).
   */
  decide(f: DirectorFrame, current: CurrentShot | null, probe: ShotProbe): CutDecision | null {
    this.age += Math.max(0, f.wallDt);
    if (!current || this.curKind === null) return this.commit(this.pickDiscretionary(f, probe, true), null, 'start');

    const legal = this.age >= MIN_SHOT_S;
    const impact = this.nextImpact(f);
    if (impact && legal) {
      const ttiWall = (impact.time - f.time) / Math.max(f.speed, 1e-3);
      const late = f.time - impact.time;
      if ((ttiWall <= IMPACT_LEAD_S && ttiWall >= 0) || (late > 0 && late <= IMPACT_LATE_S)) {
        this.lastImpactId = impact.id;
        return this.commit({ kind: 'impact', variant: impact.id }, impact, 'impact');
      }
    }
    if (impact && f.time - impact.time > IMPACT_LATE_S) this.lastImpactId = impact.id; // missed (paused / seek): let it go
    if (!legal) return null;
    if (!current.healthy) return this.commit(this.pickDiscretionary(f, probe, false), null, 'los');
    // Rule 3: an impact cut is coming; do not leave it a sub-minimum shot.
    if (impact && f.playing && f.direction > 0) {
      const ttiWall = (impact.time - f.time) / Math.max(f.speed, 1e-3);
      if (ttiWall > 0 && ttiWall <= MIN_SHOT_S + IMPACT_LEAD_S + 0.2) return null;
    }
    if (current.wantsCut) return this.commit(this.pickDiscretionary(f, probe, false), null, 'receded');
    // Pace only while the picture moves (a paused frame keeps its shot).
    if (f.playing && this.age >= this.planned) return this.commit(this.pickDiscretionary(f, probe, false), null, 'pace');
    return null;
  }

  /** The next impact this director has not cut to yet (forward play only). */
  private nextImpact(f: DirectorFrame): DirectorMarker | null {
    if (!f.playing || f.direction < 0) return null;
    for (const m of f.markers) {
      if (m.id <= this.lastImpactId || m.severity < IMPACT_MIN_SEVERITY) continue;
      if (m.time + IMPACT_LATE_S < f.time) continue;
      return m;
    }
    return null;
  }

  private pickDiscretionary(f: DirectorFrame, probe: ShotProbe, opening: boolean): { kind: ShotKind; variant: number } {
    const moving = f.subjectSpeed > 4;
    let total = 0;
    const cands: { kind: ShotKind; variant: number; w: number }[] = [];
    for (const kind of DISCRETIONARY) {
      if (kind === this.curKind) continue;
      let w = kind === 'trackside' ? 3 : kind === 'follow' ? 2.2 : kind === 'bumper' ? 2 : kind === 'heli' ? 1.2 : 0.8;
      if (!moving && (kind === 'bumper' || kind === 'hood')) w *= 0.15;
      if (opening && kind === 'hood') w = 0; // never open on the bonnet
      if (kind === this.prevKind) w *= 0.35;
      if (w <= 0) continue;
      const side = this.rng.float() < 0.5 ? -1 : 1;
      const variant = side * (1 + this.rng.int(0, 7));
      let v = variant;
      if (!probe(kind, v)) {
        v = -variant;
        if (!probe(kind, v)) continue;
      }
      cands.push({ kind, variant: v, w });
      total += w;
    }
    if (cands.length === 0) return { kind: 'follow', variant: 0 };
    let x = this.rng.float() * total;
    for (const c of cands) {
      x -= c.w;
      if (x <= 0) return c;
    }
    return cands[cands.length - 1]!;
  }

  private commit(pick: { kind: ShotKind; variant: number }, marker: DirectorMarker | null, reason: CutDecision['reason']): CutDecision {
    this.prevKind = this.curKind;
    this.curKind = pick.kind;
    this.age = 0;
    const [lo, hi] = LENGTH[pick.kind];
    this.planned = lo + this.rng.float() * (hi - lo);
    this.cuts++;
    return { kind: pick.kind, variant: pick.variant, marker, reason };
  }
}
