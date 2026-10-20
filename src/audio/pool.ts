/**
 * Fixed-size voice pool with priority stealing (P8 audio; pure, allocation-
 * free after construction). A voice is held by an owner key (object id,
 * event slot, …) with a priority (louder / closer = higher). `acquire`
 * returns the owner's existing voice, else a free one, else steals the
 * lowest-priority voice if the new claim beats it — so the cap is never
 * exceeded and the quietest voice is the one that drops out.
 */
export class VoicePool<T> {
  readonly voices: readonly T[];
  private readonly owner: Int32Array;
  private readonly prio: Float64Array;
  private readonly stamp: Float64Array;
  private clock = 0;
  steals = 0;

  constructor(voices: readonly T[]) {
    this.voices = voices;
    this.owner = new Int32Array(voices.length).fill(-1);
    this.prio = new Float64Array(voices.length);
    this.stamp = new Float64Array(voices.length);
  }

  get capacity(): number {
    return this.voices.length;
  }

  /** Voices held. */
  get active(): number {
    let n = 0;
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i]! >= 0) n++;
    return n;
  }

  /** Index of `key`'s voice, or −1. */
  find(key: number): number {
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === key) return i;
    return -1;
  }

  ownerOf(i: number): number {
    return this.owner[i]!;
  }

  /**
   * Claims a voice for `key` (≥ 0) at `priority`; returns its index or −1 when
   * every voice is held by a higher (or equal, older) claim.
   */
  acquire(key: number, priority: number): number {
    this.clock++;
    let i = this.find(key);
    if (i < 0) {
      for (let j = 0; j < this.owner.length; j++) {
        if (this.owner[j]! < 0) {
          i = j;
          break;
        }
      }
    }
    if (i < 0) {
      // steal the lowest priority (oldest on ties)
      let worst = -1;
      for (let j = 0; j < this.owner.length; j++) {
        if (worst < 0 || this.prio[j]! < this.prio[worst]! || (this.prio[j] === this.prio[worst] && this.stamp[j]! < this.stamp[worst]!)) worst = j;
      }
      if (worst < 0 || this.prio[worst]! >= priority) return -1;
      i = worst;
      this.steals++;
    }
    this.owner[i] = key;
    this.prio[i] = priority;
    this.stamp[i] = this.clock;
    return i;
  }

  /** Updates the priority of a held voice (e.g. it decays as a one-shot rings out). */
  setPriority(i: number, priority: number): void {
    this.prio[i] = priority;
  }

  release(i: number): void {
    this.owner[i] = -1;
    this.prio[i] = 0;
  }

  /** Releases every voice whose owner is not marked in `keep(key)`. */
  releaseUnless(keep: (key: number) => boolean): void {
    for (let i = 0; i < this.owner.length; i++) {
      const o = this.owner[i]!;
      if (o >= 0 && !keep(o)) this.release(i);
    }
  }
}
