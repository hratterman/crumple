/**
 * Per-frame aggregation of the sim event rings for audio (P8; pure,
 * allocation-free). A crash delivers hundreds of node impacts per snapshot:
 * they are summed per object (impulse-weighted position, hardest material,
 * beam breaks) and the director turns each object's bucket into at most a
 * few layered one-shots. Tyre contacts of the player (impacts / skids near a
 * wheel hub) are not crashes: tyre skids are covered by telemetry, body
 * skids become the scrape voice.
 */
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';

export const MAX_BUCKETS = 32;
export const MAX_GLASS = 8;
/** Per-event impulse below which a non-player impact is ignored (tyre patter of traffic, settling props), N·s. */
export const OTHER_IMPACT_FLOOR = 6;

export class EventAccumulator {
  count = 0;
  readonly id = new Int32Array(MAX_BUCKETS);
  readonly impulse = new Float64Array(MAX_BUCKETS);
  readonly maxImpulse = new Float64Array(MAX_BUCKETS);
  readonly material = new Int32Array(MAX_BUCKETS);
  readonly wx = new Float64Array(MAX_BUCKETS);
  readonly wy = new Float64Array(MAX_BUCKETS);
  readonly wz = new Float64Array(MAX_BUCKETS);
  readonly breaks = new Int32Array(MAX_BUCKETS);
  readonly bx = new Float64Array(MAX_BUCKETS);
  readonly by = new Float64Array(MAX_BUCKETS);
  readonly bz = new Float64Array(MAX_BUCKETS);
  dropped = 0;
  /** The player's body scrape this frame: Σ slip·load (N·m/s) and the fastest slip (m/s). */
  scrapePower = 0;
  scrapeSpeed = 0;
  /** Tyre impacts of the player this frame (landings): the largest impulse, N·s. */
  tyreImpact = 0;
  glassCount = 0;
  readonly glassShatter = new Uint8Array(MAX_GLASS);
  readonly glassPos = new Float64Array(MAX_GLASS * 3);
  /** Events are ignored while false (seek priming, reverse playback). */
  enabled = true;

  // player tyre classification: hub midpoints (xyz) and radius
  playerId = 1;
  hubCount = 0;
  readonly hubs = new Float64Array(8 * 3);
  hubRadius = 0.35;

  clear(): void {
    this.count = 0;
    this.scrapePower = 0;
    this.scrapeSpeed = 0;
    this.tyreImpact = 0;
    this.glassCount = 0;
  }

  /** Is (x, y, z) at a player tyre (within the wheel radius + margin of a hub midpoint)? */
  isPlayerTyre(x: number, y: number, z: number): boolean {
    const r = this.hubRadius + 0.3;
    const r2 = r * r;
    for (let k = 0; k < this.hubCount; k++) {
      const dx = x - this.hubs[3 * k]!;
      const dy = y - this.hubs[3 * k + 1]!;
      const dz = z - this.hubs[3 * k + 2]!;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  }

  private bucket(id: number): number {
    for (let i = 0; i < this.count; i++) if (this.id[i] === id) return i;
    if (this.count >= MAX_BUCKETS) {
      this.dropped++;
      return -1;
    }
    const i = this.count++;
    this.id[i] = id;
    this.impulse[i] = 0;
    this.maxImpulse[i] = 0;
    this.material[i] = 0;
    this.wx[i] = this.wy[i] = this.wz[i] = 0;
    this.breaks[i] = 0;
    this.bx[i] = this.by[i] = this.bz[i] = 0;
    return i;
  }

  onImpact(e: Readonly<ImpactEvent>): void {
    if (!this.enabled) return;
    const j = e.impulse;
    if (!(j > 0)) return;
    if (e.objectId === this.playerId) {
      if (this.isPlayerTyre(e.px, e.py, e.pz)) {
        if (j > this.tyreImpact) this.tyreImpact = j;
        return;
      }
    } else if (j < OTHER_IMPACT_FLOOR) return;
    const i = this.bucket(e.objectId);
    if (i < 0) return;
    this.impulse[i] = this.impulse[i]! + j;
    if (j > this.maxImpulse[i]!) {
      this.maxImpulse[i] = j;
      this.material[i] = e.materialId;
    }
    this.wx[i] = this.wx[i]! + e.px * j;
    this.wy[i] = this.wy[i]! + e.py * j;
    this.wz[i] = this.wz[i]! + e.pz * j;
  }

  onBeamBreak(e: Readonly<BeamBreakEvent>): void {
    if (!this.enabled) return;
    const i = this.bucket(e.objectId);
    if (i < 0) return;
    this.breaks[i] = this.breaks[i]! + 1;
    this.bx[i] = this.bx[i]! + e.px;
    this.by[i] = this.by[i]! + e.py;
    this.bz[i] = this.bz[i]! + e.pz;
  }

  onSkid(e: Readonly<SkidEvent>): void {
    if (!this.enabled || e.objectId !== this.playerId) return;
    if (this.isPlayerTyre(e.px, e.py, e.pz)) return;
    this.scrapePower += e.slip * e.load;
    if (e.slip > this.scrapeSpeed) this.scrapeSpeed = e.slip;
  }

  onGlass(shatter: boolean, x: number, y: number, z: number): void {
    if (!this.enabled || this.glassCount >= MAX_GLASS) return;
    const k = this.glassCount++;
    this.glassShatter[k] = shatter ? 1 : 0;
    this.glassPos[3 * k] = x;
    this.glassPos[3 * k + 1] = y;
    this.glassPos[3 * k + 2] = z;
  }

  /** Impulse-weighted contact position of bucket i (falls back to the break centroid). */
  position(i: number, out: Float64Array): void {
    const j = this.impulse[i]!;
    if (j > 0) {
      out[0] = this.wx[i]! / j;
      out[1] = this.wy[i]! / j;
      out[2] = this.wz[i]! / j;
    } else {
      const n = Math.max(1, this.breaks[i]!);
      out[0] = this.bx[i]! / n;
      out[1] = this.by[i]! / n;
      out[2] = this.bz[i]! / n;
    }
  }
}
