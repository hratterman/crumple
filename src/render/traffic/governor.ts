/**
 * Main-side traffic governor (P6 T2; docs/CONTRACTS.md "Awake budget"):
 * worker load (snapshot header, CPU ms per simulated ms) above HIGH for
 * DOWN_S → one fewer awake car (≥ 1); below LOW for UP_S → one more, up to
 * the preset. Pure state machine; the controller sends the result with
 * `setTrafficDensity` (a logged command: the sim stays deterministic).
 */
export const TRAFFIC_GOVERNOR = {
  high: 0.8,
  low: 0.55,
  downS: 2,
  upS: 10,
  /** Load samples older than this (no snapshots: paused / hidden tab) reset the timers, s. */
  staleS: 0.5,
} as const;

export class TrafficGovernor {
  /** Awake cars the governor currently allows (≤ the preset's maxAwake). */
  maxAwake: number;
  private preset: number;
  private highT = 0;
  private lowT = 0;

  constructor(presetMaxAwake: number) {
    this.preset = presetMaxAwake;
    this.maxAwake = presetMaxAwake;
  }

  /** A new preset (quality / setting change): the cap resets to it. */
  setPreset(maxAwake: number): void {
    this.preset = maxAwake;
    this.maxAwake = maxAwake;
    this.highT = this.lowT = 0;
  }

  /**
   * Advances by `dtS` with the current worker load (≤ 0 = not measured).
   * Returns true when maxAwake changed (send a density update).
   */
  update(dtS: number, load: number): boolean {
    if (!(dtS > 0) || dtS > TRAFFIC_GOVERNOR.staleS || !(load > 0)) {
      this.highT = this.lowT = 0;
      return false;
    }
    const G = TRAFFIC_GOVERNOR;
    this.highT = load > G.high ? this.highT + dtS : 0;
    this.lowT = load < G.low ? this.lowT + dtS : 0;
    const floor = Math.min(1, this.preset);
    if (this.highT >= G.downS && this.maxAwake > floor) {
      this.maxAwake--;
      this.highT = 0;
      return true;
    }
    if (this.lowT >= G.upS && this.maxAwake < this.preset) {
      this.maxAwake++;
      this.lowT = 0;
      return true;
    }
    return false;
  }
}
