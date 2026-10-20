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
/** Per-event impulse below which an impact is ignored entirely (node patter), N·s. */
export const IMPACT_FLOOR = 2;
/**
 * Weight of an impact by its contact normal: horizontal hits (walls, cars,
 * poles) count fully, vertical ones (the underbody or wheels meeting the
 * ground over bumps) only 15 %. Measured on recorded drives: bouncing
 * off-road puts 50–100 underbody nodes on the ground at once (Σ impulse up
 * to 311 N·s per snapshot, all vertical) — that is not a crash.
 */
export function normalWeight(ny: number): number {
  return 1 - 0.85 * (ny < 0 ? -ny : ny);
}

export class EventAccumulator {
  count = 0;
  readonly id = new Int32Array(MAX_BUCKETS);
  readonly impulse = new Float64Array(MAX_BUCKETS);
  /** Σ impulse × normalWeight (non-tyre events ≥ IMPACT_FLOOR), N·s. */
  readonly wImpulse = new Float64Array(MAX_BUCKETS);
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
  /** Player body skid events this frame (scrape occupancy). */
  scrapeEvents = 0;
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
  /** Player velocity (m/s, sim time): events lag the rendered hubs by up to a snapshot + a frame + interpolation. */
  vx = 0;
  vy = 0;
  vz = 0;

  clear(): void {
    this.count = 0;
    this.scrapePower = 0;
    this.scrapeSpeed = 0;
    this.tyreImpact = 0;
    this.scrapeEvents = 0;
    this.glassCount = 0;
  }

  /**
   * Is (x, y, z) at a player tyre? Within the wheel radius + 0.3 m of the
   * segment each hub midpoint sweeps from 0.15 s behind to 0.06 s ahead
   * along the car's velocity (events come from snapshots up to ~0.1 s off
   * the rendered pose: at 30 m/s a fixed-point test put tyre contacts metres
   * from their wheel and called them body hits).
   */
  isPlayerTyre(x: number, y: number, z: number): boolean {
    const r = this.hubRadius + 0.3;
    const r2 = r * r;
    const ax = this.vx * 0.21;
    const ay = this.vy * 0.21;
    const az = this.vz * 0.21;
    const aa = ax * ax + ay * ay + az * az;
    for (let k = 0; k < this.hubCount; k++) {
      // segment from h − 0.15·v to h + 0.06·v
      const sx = this.hubs[3 * k]! - this.vx * 0.15;
      const sy = this.hubs[3 * k + 1]! - this.vy * 0.15;
      const sz = this.hubs[3 * k + 2]! - this.vz * 0.15;
      let t = aa > 1e-9 ? ((x - sx) * ax + (y - sy) * ay + (z - sz) * az) / aa : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (sx + ax * t);
      const dy = y - (sy + ay * t);
      const dz = z - (sz + az * t);
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
    this.wImpulse[i] = 0;
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
    if (e.objectId === this.playerId && this.isPlayerTyre(e.px, e.py, e.pz)) {
      if (j > this.tyreImpact) this.tyreImpact = j;
      return;
    }
    if (j < IMPACT_FLOOR) return;
    const i = this.bucket(e.objectId);
    if (i < 0) return;
    this.impulse[i] = this.impulse[i]! + j;
    this.wImpulse[i] = this.wImpulse[i]! + j * normalWeight(e.ny);
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
    this.scrapeEvents++;
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
