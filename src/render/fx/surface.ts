/**
 * Visual surface height for decals (skidmarks): the terrain, or inside a
 * rendered road's opaque core terrain + RIBBON_LIFT_M (the ribbon mesher's
 * rule), easing to 0 across the transparent fringe (whose outer row tucks
 * under the terrain). A coarse grid (CELL_M) lists the candidate roads per
 * cell (bitmask words) so a query projects onto only those roads, with a
 * per-caller arc hint (projectToRoad's ±24-segment window). Pure, no three.
 */
import { createRoadProjection, projectToRoad } from '../../world/roads';
import { ROAD_STATION_STRIDE, type RoadProfile, type TerrainData } from '../../world/types';
import { ROAD_STYLE_PARAMS, isRendered, styleForProfile } from '../roads/styles';
import { RIBBON_LIFT_M } from '../types';

const CELL_M = 8;

interface RoadEntry {
  profile: RoadProfile;
  core: number;
  fringe: number;
}

export class SurfaceLift {
  private readonly roads: RoadEntry[] = [];
  private readonly words: number;
  private readonly grid: Uint32Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly ox: number;
  private readonly oz: number;
  private readonly proj = createRoadProjection();
  /** Arc hints per (caller slot × road), NaN = none. */
  private readonly hints: Float64Array;
  static readonly HINT_SLOTS = 64;

  constructor(terrain: Pick<TerrainData, 'originX' | 'originZ' | 'spacing' | 'cols' | 'rows' | 'roads'>) {
    for (const p of terrain.roads) {
      if (!isRendered(p) || p.stationCount < 2) continue;
      const sp = ROAD_STYLE_PARAMS[styleForProfile(p)];
      const half = p.width / 2;
      const core = Math.max(half + 0.1, half + p.shoulder - sp.fringeInset);
      this.roads.push({ profile: p, core, fringe: sp.fringe });
    }
    this.words = Math.max(1, Math.ceil(this.roads.length / 32));
    const sizeX = (terrain.cols - 1) * terrain.spacing;
    const sizeZ = (terrain.rows - 1) * terrain.spacing;
    this.ox = terrain.originX;
    this.oz = terrain.originZ;
    this.cols = Math.max(1, Math.ceil(sizeX / CELL_M) + 1);
    this.rows = Math.max(1, Math.ceil(sizeZ / CELL_M) + 1);
    this.grid = new Uint32Array(this.cols * this.rows * this.words);
    this.hints = new Float64Array(SurfaceLift.HINT_SLOTS * Math.max(1, this.roads.length)).fill(Number.NaN);
    this.roads.forEach((r, ri) => this.stamp(r, ri));
  }

  private stamp(r: RoadEntry, ri: number): void {
    const st = r.profile.stations;
    const reach = r.core + r.fringe + 2;
    const word = ri >> 5;
    const bit = 1 << (ri & 31);
    const n = r.profile.stationCount;
    for (let i = 0; i < n; i++) {
      const x = st[i * ROAD_STATION_STRIDE]!;
      const z = st[i * ROAD_STATION_STRIDE + 2]!;
      const c0 = Math.floor((x - reach - this.ox) / CELL_M);
      const c1 = Math.floor((x + reach - this.ox) / CELL_M);
      const r0 = Math.floor((z - reach - this.oz) / CELL_M);
      const r1 = Math.floor((z + reach - this.oz) / CELL_M);
      for (let rr = Math.max(0, r0); rr <= Math.min(this.rows - 1, r1); rr++) {
        for (let cc = Math.max(0, c0); cc <= Math.min(this.cols - 1, c1); cc++) {
          this.grid[(rr * this.cols + cc) * this.words + word]! |= bit;
        }
      }
    }
  }

  /** Number of rendered roads considered. */
  get roadCount(): number {
    return this.roads.length;
  }

  /**
   * Lift of the visual surface above sampler.heightAt(x, z), m. `slot`
   * (0..HINT_SLOTS−1) keeps a per-caller arc hint so repeated nearby
   * queries stay O(window). Allocation-free.
   */
  liftAt(x: number, z: number, slot = 0): number {
    const c = Math.floor((x - this.ox) / CELL_M);
    const r = Math.floor((z - this.oz) / CELL_M);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 0;
    const base = (r * this.cols + c) * this.words;
    let best = 0;
    const nRoads = this.roads.length;
    const hs = (slot % SurfaceLift.HINT_SLOTS) * nRoads;
    for (let w = 0; w < this.words; w++) {
      let bits = this.grid[base + w]!;
      while (bits !== 0) {
        const b = 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const ri = w * 32 + b;
        const road = this.roads[ri]!;
        const hint = this.hints[hs + ri]!;
        const p = projectToRoad(road.profile, x, z, this.proj, Number.isNaN(hint) ? undefined : hint);
        this.hints[hs + ri] = p.s;
        const d = p.dist;
        let lift: number;
        if (d <= road.core) lift = RIBBON_LIFT_M;
        else if (d >= road.core + road.fringe * 0.5) lift = 0;
        else lift = RIBBON_LIFT_M * (1 - (d - road.core) / (road.fringe * 0.5));
        if (lift > best) best = lift;
        if (best >= RIBBON_LIFT_M) return best;
      }
    }
    return best;
  }
}
