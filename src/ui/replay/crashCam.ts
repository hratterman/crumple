/**
 * Live crash cam (P7 R2): a severe impact during live play becomes a short
 * highlight. Pure timing state; the session performs the replay calls.
 *
 *   idle ──severe marker──▶ armed ──DELAY_S later──▶ playing ──end / skip──▶ idle (+ cooldown)
 *
 * A marker arms the cam when it is the player's own crash (or within reach
 * of the player), its severity ≥ triggerSeverity, it is newer than anything
 * already shown and the cooldown has passed. While armed, a marker that grows
 * (the merge window) or a harder one replaces it. The highlight plays from
 * PREROLL_S before the peak at SPEED and returns to live POSTROLL_S after it.
 */

export const CRASH_CAM_DELAY_S = 1.2;
export const CRASH_CAM_PREROLL_S = 2;
export const CRASH_CAM_POSTROLL_S = 1.6;
export const CRASH_CAM_SPEED = 0.25;
export const CRASH_CAM_SEVERITY = 0.45;
/** After returning to live, wall seconds before another highlight may arm. */
export const CRASH_CAM_COOLDOWN_S = 4;

export type CrashCamPhase = 'idle' | 'armed' | 'playing';

export interface CrashCamMarker {
  readonly id: number;
  readonly time: number;
  readonly severity: number;
}

export class CrashCam {
  enabled = true;
  triggerSeverity = CRASH_CAM_SEVERITY;
  private _phase: CrashCamPhase = 'idle';
  private armedAt = 0;
  private _markerId = -1;
  private _markerTime = 0;
  private severity = 0;
  /** Sim time already covered by a highlight (older markers never re-trigger). */
  private shownUntil = -Infinity;
  private cooldownUntil = -Infinity;
  /** Highlights played since boot. */
  count = 0;

  get phase(): CrashCamPhase {
    return this._phase;
  }
  get markerId(): number {
    return this._markerId;
  }
  get markerTime(): number {
    return this._markerTime;
  }

  /** A marker event while LIVE. `nearPlayer`: the player's crash (or close to it). */
  onMarker(m: CrashCamMarker, wallNow: number, nearPlayer: boolean): void {
    if (!this.enabled || !nearPlayer || this._phase === 'playing') return;
    if (m.severity < this.triggerSeverity || m.time <= this.shownUntil || wallNow < this.cooldownUntil) return;
    if (this._phase === 'armed') {
      if (m.id === this._markerId || m.severity > this.severity) {
        this._markerId = m.id;
        this._markerTime = m.time;
        this.severity = Math.max(this.severity, m.severity);
      }
      return;
    }
    this._phase = 'armed';
    this.armedAt = wallNow;
    this._markerId = m.id;
    this._markerTime = m.time;
    this.severity = m.severity;
  }

  /** True when the armed highlight should start now (the caller checks the game can show it). */
  due(wallNow: number): boolean {
    return this._phase === 'armed' && wallNow - this.armedAt >= CRASH_CAM_DELAY_S;
  }

  /** The highlight started (replay entered). */
  started(): void {
    this._phase = 'playing';
    this.count++;
  }

  /** Back to live: `coveredUntil` = the sim time the highlight showed up to. */
  finished(wallNow: number, coveredUntil: number): void {
    this._phase = 'idle';
    this.shownUntil = Math.max(this.shownUntil, coveredUntil, this._markerTime);
    this.cooldownUntil = wallNow + CRASH_CAM_COOLDOWN_S;
  }

  /** Drop an armed highlight (the player paused, entered replay, turned it off). */
  cancel(): void {
    if (this._phase === 'armed') this._phase = 'idle';
  }

  /** A manual replay covered the buffer: nothing before `time` should trigger later. */
  markShown(time: number): void {
    this.shownUntil = Math.max(this.shownUntil, time);
  }
}
