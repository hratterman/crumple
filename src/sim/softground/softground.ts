/**
 * SOFT GROUND (R-PHYS2) — persistent terrain deformation: wheel ruts in mud,
 * sand, dirt and turf. WORKER ONLY (state + kernels); the per-soil numbers
 * are plain data below.
 *
 * STATE: a sparse grid of rut DEPTHS (m, ≥ 0 = the surface lowered) on
 * vertices every SOFT_CELL_M, in TILES of SOFT_TILE² vertices allocated on
 * first touch (an open-addressing hash of tile coordinates; at most
 * SOFT_MAX_TILES, then the least recently touched tile is recycled), plus a
 * per-vertex PASS count and last-touch tick. Deterministic (allocation in
 * touch order, fixed iteration order), part of the state hash, rebuilt by
 * `resimulate` from the command log like every other sim state.
 *
 * DEFORMATION (per tread node in ground contact on a rut-keeping surface,
 * each tick, `applySoftGround`, before the ground pass): contact pressure
 * p = N/A_node (N = this tick's ground normal force, groundNormalForce), the
 * virgin plastic sinkage of the soil (Bekker): z(p) = (p / (k_c/b + k_φ))^(1/n)
 * (b = SOFT_TREAD_WIDTH), less the elastic rebound, raised by wheel slip
 * (slip sinkage, z·(1 + k_s·slip)) and by the number of passes (multi-pass
 * compaction, z_N = z_1·N^α; Wong, "Theory of Ground Vehicles" 4th ed. §2.4–
 * 2.5; Holm 1969). A vertex deepens toward that target at most RUT_RATE m/s
 * (soil flows over the contact time) and never rises again by itself.
 * COMPACTION RESISTANCE: the plastic work N·Δz of a deepening vertex is taken
 * from the node's horizontal motion, F = N·(Δz/dt)/v (≤ μ_soil·N): rolling
 * through fresh soil costs energy (Bekker's R_c), rolling in an existing rut
 * (Δz = 0) does not — the "easier in the ruts" effect.
 * TRACKING: the contact surface is the heightfield minus the rut
 * (SoftGroundSampler wraps the engine's sampler): rut walls tilt the contact
 * normal, so a tyre in a rut is pushed back toward its centre and steering
 * out of one takes force.
 *
 * R-TYRE ↔ R-PHYS2: R-TYRE's Bekker-Wong pressure-sinkage of the tyre (the
 * transient sinkage under load, its forces) sits on top of this surface;
 * `compaction(x, z)` (passes) lets it stiffen compacted soil.
 *
 * NUMERICS: + − × ÷ sqrt only in stepping (the soil exponents are applied
 * through a precomputed power table: pow is not allowed in the hot loop),
 * zero allocation.
 */
import { MaterialId } from '../../protocol/messages';
import type { HeightSampler, SimState } from '../types';
import type { WheelRuntime } from '../vehicle/types';
import { NODE_FLAG_COLLIDABLE, NODE_FLAG_IN_CONTACT, NODE_FLAG_TREAD } from '../types';

export const SOFT_CELL_M = 0.2;
export const SOFT_TILE = 32;
export const SOFT_MAX_TILES = 512;
const TILE_VERTS = SOFT_TILE * SOFT_TILE;
const HASH_SIZE = 2048;
/** A vertex touched again after this many ticks counts a new pass. */
export const SOFT_PASS_GAP_TICKS = 400;
/** Default contact area of one node, m² (body nodes, unit tests); tread nodes use their wheel's width × π·R / rays. */
export const SOFT_NODE_AREA = 0.015;
const PI = 3.141592653589793;
/** Tread width b in Bekker's k_c/b, m. */
export const SOFT_TREAD_WIDTH = 0.2;
/** Fastest a vertex deepens, m/s (the soil flows over the ~30 ms contact). */
export const RUT_RATE = 1.5;
/** Ruts never exceed this depth, m (the axle / floor would be on the ground). */
export const RUT_MAX = 0.3;

export interface SoilParams {
  /** Bekker exponent n, cohesive k_c (kN/m^(n+1)), frictional k_φ (kN/m^(n+2)). */
  n: number;
  kc: number;
  kphi: number;
  /** Elastic rebound share of the sinkage (the rut keeps 1 − rebound). */
  rebound: number;
  /** Multi-pass exponent α (z_N = z_1·N^α). */
  alpha: number;
  /** Slip sinkage gain k_s (per unit slip velocity / 5 m/s, capped). */
  slipK: number;
  /** Cap of the compaction resistance, × N (= the surface's rolling coefficient, SURFACE_PHYSICS.rolling). */
  muSoil: number;
  /**
   * Ploughing coefficient of sheet metal dug into the soil (× N, on top of the surface friction): a wreck
   * sliding / tumbling on its side or roof gouges the soil. Set so the sedan's 48 km/h dolly rollover on
   * dirt ends at a drag factor ≈ 0.5 (staged tests 0.38–0.5); the tumble's distance is insensitive to it
   * (0.05–0.3 all give 0.50–0.56), the furrows it leaves are not.
   */
  muDig: number;
}

/**
 * Soils per rut-keeping surface (SURFACE_PHYSICS.persistentRuts). Bekker
 * values after Wong (Table 2.3): dry sand n 1.1 / k_c 0.99 / k_φ 1528;
 * dirt = a trafficked dirt road / trail, compacted loam (n 0.8 / 30 / 6000:
 * a car tyre at ≈ 60 kPa sinks ≈ 4 mm; Wong's tilled sandy loam, 0.7 / 5.3 /
 * 1515, sank a parked pickup 2–3 cm and held it on a 10° trail); grass =
 * mown turf / verge, the soil bound by roots (n 0.8 / 30 / 9000: a car tyre
 * prints ≈ 2 mm, a 7.5 t truck ≈ 5 mm); mud = a saturated clay loam (n 0.8 /
 * 3 / 700: a car tyre at ≈ 60 kPa sinks ≈ 4 cm, a spinning one twice
 * that); wet grass = loam held by roots, softened by water. The
 * resistance caps are the surfaces' rolling coefficients (SURFACE_PHYSICS:
 * mud 0.2, sand 0.15, wet grass 0.07, grass 0.06, dirt 0.05).
 */
export const SOILS: Readonly<Partial<Record<number, SoilParams>>> = {
  [MaterialId.sand]: { n: 1.1, kc: 0.99, kphi: 1528, rebound: 0.05, alpha: 0.25, slipK: 1.5, muSoil: 0.15, muDig: 0.25 },
  [MaterialId.mud]: { n: 0.8, kc: 3, kphi: 700, rebound: 0.1, alpha: 0.3, slipK: 2, muSoil: 0.2, muDig: 0.2 },
  [MaterialId.dirt]: { n: 0.8, kc: 30, kphi: 6000, rebound: 0.2, alpha: 0.2, slipK: 0.3, muSoil: 0.05, muDig: 0.15 },
  [MaterialId.wetGrass]: { n: 0.75, kc: 4, kphi: 1200, rebound: 0.25, alpha: 0.2, slipK: 1.2, muSoil: 0.07, muDig: 0.12 },
  [MaterialId.grass]: { n: 0.8, kc: 30, kphi: 9000, rebound: 0.35, alpha: 0.15, slipK: 0.8, muSoil: 0.06, muDig: 0.1 },
};

/** Pressure table resolution: z(p) for p in [0, P_MAX] kPa every P_STEP (precomputed: no pow in the hot loop). */
const P_STEP = 2;
const P_MAX = 600;
const P_N = P_MAX / P_STEP + 1;

export class SoftGround {
  /** Hash slot → tile index (−1 empty); tiles keyed by (tx, tz). */
  private readonly slots = new Int32Array(HASH_SIZE).fill(-1);
  readonly tileX = new Int32Array(SOFT_MAX_TILES);
  readonly tileZ = new Int32Array(SOFT_MAX_TILES);
  /** Last tick any vertex of the tile changed (render dirty tracking + LRU recycling). */
  readonly tileTick = new Int32Array(SOFT_MAX_TILES);
  /** Bumped on every change (render hook: send tiles whose version moved). */
  readonly tileVersion = new Uint32Array(SOFT_MAX_TILES);
  readonly depth = new Float32Array(SOFT_MAX_TILES * TILE_VERTS);
  readonly passes = new Uint16Array(SOFT_MAX_TILES * TILE_VERTS);
  readonly lastTouch = new Int32Array(SOFT_MAX_TILES * TILE_VERTS);
  tileCount = 0;
  /** Per soil material: z(p) table (m), and the multi-pass factor N^α for N = 1..64. */
  private readonly zTable: (Float64Array | null)[] = [];
  private readonly passTable: (Float64Array | null)[] = [];

  constructor() {
    for (let m = 0; m < 32; m++) {
      this.zTable.push(null);
      this.passTable.push(null);
    }
    for (const [mat, s] of Object.entries(SOILS)) {
      if (!s) continue;
      const z = new Float64Array(P_N);
      const k = s.kc / SOFT_TREAD_WIDTH + s.kphi;
      for (let i = 0; i < P_N; i++) z[i] = Math.pow((i * P_STEP) / k, 1 / s.n) * (1 - s.rebound);
      this.zTable[Number(mat)] = z;
      const pt = new Float64Array(65);
      for (let n = 1; n <= 64; n++) pt[n] = Math.pow(n, s.alpha);
      pt[0] = 1;
      this.passTable[Number(mat)] = pt;
    }
  }

  /** Removes every rut (full reset; not used by the game loop). */
  clear(): void {
    this.slots.fill(-1);
    this.depth.fill(0);
    this.passes.fill(0);
    this.lastTouch.fill(0);
    this.tileTick.fill(0);
    this.tileVersion.fill(0);
    this.tileCount = 0;
  }

  private slotOf(tx: number, tz: number): number {
    let h = (Math.imul(tx, 73856093) ^ Math.imul(tz, 19349663)) & (HASH_SIZE - 1);
    for (;;) {
      const t = this.slots[h]!;
      if (t < 0 || (this.tileX[t] === tx && this.tileZ[t] === tz)) return h;
      h = (h + 1) & (HASH_SIZE - 1);
    }
  }

  /**
   * Whether any rut tile overlaps the x/z box (the engine runs an object's
   * ground on the rutted JS sampler only then; elsewhere the R-CORE kernel's
   * mirrored heightfield, which knows no ruts, is exact).
   */
  anyTileIn(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    if (this.tileCount === 0) return false;
    const s = SOFT_CELL_M * SOFT_TILE;
    const tx0 = Math.floor(minX / s);
    const tz0 = Math.floor(minZ / s);
    const tx1 = Math.floor(maxX / s);
    const tz1 = Math.floor(maxZ / s);
    if (!(tx1 - tx0 < 64 && tz1 - tz0 < 64)) return true;
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) if (this.slots[this.slotOf(tx, tz)]! >= 0) return true;
    return false;
  }

  /** Tile index of (tx, tz) or −1. */
  tileOf(tx: number, tz: number): number {
    if (this.tileCount === 0) return -1;
    return this.slots[this.slotOf(tx, tz)]!;
  }

  /** Allocates (or recycles the least recently touched) tile for (tx, tz). */
  private alloc(tx: number, tz: number, tick: number): number {
    let t: number;
    if (this.tileCount < SOFT_MAX_TILES) {
      t = this.tileCount++;
    } else {
      t = 0;
      for (let k = 1; k < SOFT_MAX_TILES; k++) if (this.tileTick[k]! < this.tileTick[t]!) t = k;
      this.removeSlot(this.tileX[t]!, this.tileZ[t]!);
      this.depth.fill(0, t * TILE_VERTS, (t + 1) * TILE_VERTS);
      this.passes.fill(0, t * TILE_VERTS, (t + 1) * TILE_VERTS);
      this.lastTouch.fill(0, t * TILE_VERTS, (t + 1) * TILE_VERTS);
    }
    this.tileX[t] = tx;
    this.tileZ[t] = tz;
    this.tileTick[t] = tick;
    this.tileVersion[t] = (this.tileVersion[t]! + 1) >>> 0;
    this.slots[this.slotOf(tx, tz)] = t;
    return t;
  }

  /** Removes a tile key from the open-addressing table (backward-shift deletion). */
  private removeSlot(tx: number, tz: number): void {
    let i = this.slotOf(tx, tz);
    if (this.slots[i]! < 0) return;
    this.slots[i] = -1;
    let j = i;
    for (;;) {
      j = (j + 1) & (HASH_SIZE - 1);
      const t = this.slots[j]!;
      if (t < 0) return;
      const k = (Math.imul(this.tileX[t]!, 73856093) ^ Math.imul(this.tileZ[t]!, 19349663)) & (HASH_SIZE - 1);
      // Move t back to i if its home k is not cyclically in (i, j].
      if ((i <= j && (k <= i || k > j)) || (i > j && k <= i && k > j)) {
        this.slots[i] = t;
        this.slots[j] = -1;
        i = j;
      }
    }
  }

  /** Global vertex index (tile·TILE_VERTS + local) of grid vertex (ix, iz), or −1 when its tile is absent. */
  vertex(ix: number, iz: number): number {
    const tx = Math.floor(ix / SOFT_TILE);
    const tz = Math.floor(iz / SOFT_TILE);
    const t = this.tileOf(tx, tz);
    if (t < 0) return -1;
    return t * TILE_VERTS + (iz - tz * SOFT_TILE) * SOFT_TILE + (ix - tx * SOFT_TILE);
  }

  private vertexAlloc(ix: number, iz: number, tick: number): number {
    const tx = Math.floor(ix / SOFT_TILE);
    const tz = Math.floor(iz / SOFT_TILE);
    let t = this.tileOf(tx, tz);
    if (t < 0) t = this.alloc(tx, tz, tick);
    return t * TILE_VERTS + (iz - tz * SOFT_TILE) * SOFT_TILE + (ix - tx * SOFT_TILE);
  }

  private depthV(ix: number, iz: number): number {
    const v = this.vertex(ix, iz);
    return v < 0 ? 0 : this.depth[v]!;
  }

  /** Rut depth at (x, z), m (bilinear over the vertices; 0 off the allocated tiles). */
  depthAt(x: number, z: number): number {
    if (this.tileCount === 0) return 0;
    const fx = x / SOFT_CELL_M;
    const fz = z / SOFT_CELL_M;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const w = fz - iz;
    const d00 = this.depthV(ix, iz);
    const d10 = this.depthV(ix + 1, iz);
    const d01 = this.depthV(ix, iz + 1);
    const d11 = this.depthV(ix + 1, iz + 1);
    return (d00 * (1 - u) + d10 * u) * (1 - w) + (d01 * (1 - u) + d11 * u) * w;
  }

  /**
   * Smoothed gradient of the rut depth at (x, z) into out[0..1] (∂d/∂x, ∂d/∂z):
   * central-difference vertex gradients blended bilinearly (C0, like the
   * terrain sampler's normals: raw bilinear slopes chatter at 2 kHz).
   */
  gradAt(x: number, z: number, out: Float64Array): void {
    out[0] = 0;
    out[1] = 0;
    if (this.tileCount === 0) return;
    const fx = x / SOFT_CELL_M;
    const fz = z / SOFT_CELL_M;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const w = fz - iz;
    const inv2 = 1 / (2 * SOFT_CELL_M);
    let gx = 0;
    let gz = 0;
    for (let k = 0; k < 4; k++) {
      const vx = ix + (k & 1);
      const vz = iz + (k >> 1);
      const wt = ((k & 1) !== 0 ? u : 1 - u) * ((k >> 1) !== 0 ? w : 1 - w);
      if (wt === 0) continue;
      gx += wt * (this.depthV(vx + 1, vz) - this.depthV(vx - 1, vz)) * inv2;
      gz += wt * (this.depthV(vx, vz + 1) - this.depthV(vx, vz - 1)) * inv2;
    }
    out[0] = gx;
    out[1] = gz;
  }

  /** Passes recorded at the vertex nearest (x, z) (0 = virgin soil). */
  compaction(x: number, z: number): number {
    const v = this.vertex(Math.round(x / SOFT_CELL_M), Math.round(z / SOFT_CELL_M));
    return v < 0 ? 0 : this.passes[v]!;
  }

  /**
   * One loaded node at (x, z) on soil `mat` with normal force `n` (N) and
   * horizontal slip speed `slip` (m/s): deepens the 4 surrounding vertices
   * toward the target sinkage (bilinear shares). Returns the depth gained at
   * the node's point this tick (m) — the compaction work N·Δz.
   */
  press(x: number, z: number, mat: number, n: number, slip: number, tick: number, dt: number, area = SOFT_NODE_AREA): number {
    const zt = this.zTable[mat];
    if (zt === undefined || zt === null || !(n > 0)) return 0;
    const s = SOILS[mat]!;
    let p = n / (area * 1000);
    if (p > P_MAX) p = P_MAX;
    const fp = p / P_STEP;
    const ip = Math.floor(fp);
    const z1 = ip + 1 < P_N ? zt[ip]! + (zt[ip + 1]! - zt[ip]!) * (fp - ip) : zt[P_N - 1]!;
    let sl = slip / 5;
    if (sl > 1) sl = 1;
    const zSlip = z1 * (1 + s.slipK * sl);
    const fx = x / SOFT_CELL_M;
    const fz = z / SOFT_CELL_M;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const w = fz - iz;
    const pt = this.passTable[mat]!;
    const maxStep = RUT_RATE * dt;
    let gained = 0;
    for (let k = 0; k < 4; k++) {
      const wt = ((k & 1) !== 0 ? u : 1 - u) * ((k >> 1) !== 0 ? w : 1 - w);
      if (wt < 0.05) continue;
      const v = this.vertexAlloc(ix + (k & 1), iz + (k >> 1), tick);
      if (tick - this.lastTouch[v]! > SOFT_PASS_GAP_TICKS || this.passes[v] === 0) {
        if (this.passes[v]! < 64) this.passes[v] = this.passes[v]! + 1;
      }
      this.lastTouch[v] = tick;
      let target = zSlip * pt[this.passes[v]!]!;
      if (target > RUT_MAX) target = RUT_MAX;
      // The node's own share of the target: the vertex nearest the node gets the full depth.
      const cur = this.depth[v]!;
      const want = target * (wt > 0.5 ? 1 : 2 * wt);
      if (want <= cur) continue;
      let dz = want - cur;
      if (dz > maxStep) dz = maxStep;
      this.depth[v] = cur + dz;
      gained += wt * dz;
      const t = (v / TILE_VERTS) | 0;
      this.tileTick[t] = tick;
      this.tileVersion[t] = (this.tileVersion[t]! + 1) >>> 0;
    }
    return gained;
  }
}

/**
 * The engine's ground sampler with the ruts cut in: height − depth, normal
 * tilted by the rut gradient. Kept SMALL (call sites in the 2 kHz contact
 * pass inline it); the rut lookups write through the `q` scratch so no
 * double crosses a non-inlined call boundary (no HeapNumber boxing).
 */
export class SoftGroundSampler implements HeightSampler {
  private readonly q = new Float64Array(4);
  constructor(
    public base: HeightSampler,
    readonly ground: SoftGround,
  ) {}
  heightAt(x: number, z: number): number {
    const h = this.base.heightAt(x, z);
    if (this.ground.tileCount === 0) return h;
    const q = this.q;
    q[0] = x;
    q[1] = z;
    this.rut();
    return h - q[2]!;
  }
  normalAt(x: number, z: number, out: Float64Array): void {
    this.base.normalAt(x, z, out);
    if (this.ground.tileCount === 0) return;
    const q = this.q;
    q[0] = x;
    q[1] = z;
    this.tilt(out);
  }
  materialAt(x: number, z: number): number {
    return this.base.materialAt(x, z);
  }
  private rut(): void {
    const q = this.q;
    q[2] = this.ground.depthAt(q[0]!, q[1]!);
  }
  /** n ∝ (−H_x + d_x, 1, −H_z + d_z) with H_x = −n_x/n_y from the base normal. */
  private tilt(out: Float64Array): void {
    const q = this.q;
    this.ground.gradAt(q[0]!, q[1]!, q);
    const gx = q[0]!;
    const gz = q[1]!;
    if (gx === 0 && gz === 0) return;
    const ny = out[1]!;
    if (ny < 0.2) return;
    const ax = out[0]! / ny + gx;
    const az = out[2]! / ny + gz;
    const l = Math.sqrt(ax * ax + 1 + az * az);
    out[0] = ax / l;
    out[1] = 1 / l;
    out[2] = az / l;
  }
}

/**
 * Rut formation + compaction resistance for a vehicle (its tyre tread nodes),
 * before the ground pass. `normalForce(i)` = the engine's groundNormalForce
 * on the rutted sampler (this tick's contact). The plastic work N·Δz of the
 * wheel's deepening ruts is taken from the wheel's travel as a force at its
 * hubs opposing the hub's ground velocity, W/(|v|·dt) (≤ μ_soil·ΣN): a force
 * on the contact nodes would be cancelled by their implicit stick friction.
 */
export function applySoftGround(
  state: SimState,
  wheels: readonly WheelRuntime[],
  sg: SoftGround,
  sampler: HeightSampler,
  normalForce: (i: number) => number,
  tick: number,
  dt: number,
  resistance: boolean,
): void {
  const { posX, posY, posZ, velX, velZ, frcX, frcZ, flags } = state;
  for (let w = 0; w < wheels.length; w++) {
    const wr = wheels[w]!;
    const hI = wr.hubI;
    const hO = wr.hubO;
    // Tread strip each tread node carries: tyre width (hub separation) × circumference / (2·rays) nodes.
    const ax = posX[hO]! - posX[hI]!;
    const ay = posY[hO]! - posY[hI]!;
    const az = posZ[hO]! - posZ[hI]!;
    const area = (Math.sqrt(ax * ax + ay * ay + az * az) * PI * wr.wheel.radius) / wr.wheel.rays;
    const hvx = 0.5 * (velX[hI]! + velX[hO]!);
    const hvz = 0.5 * (velZ[hI]! + velZ[hO]!);
    let work = 0;
    let nSum = 0;
    let mu = 0;
    const end = wr.tireStart + wr.ringCount;
    for (let i = wr.tireStart; i < end; i++) {
      const f = flags[i]!;
      if ((f & NODE_FLAG_TREAD) === 0 || (f & NODE_FLAG_COLLIDABLE) === 0) continue;
      const x = posX[i]!;
      const z = posZ[i]!;
      const mat = sampler.materialAt(x, z);
      const soil = SOILS[mat];
      if (soil === undefined) continue;
      const n = normalForce(i);
      if (!(n > 0)) continue;
      // Slip: the tread node's ground speed (a rolling contact node is nearly still; a spinning one digs).
      const vx = velX[i]!;
      const vz = velZ[i]!;
      const dz = sg.press(x, z, mat, n, Math.sqrt(vx * vx + vz * vz), tick, dt, area);
      // Compaction work: the soil's pressure rises with sinkage (p = k·z^n), so the energy left in the rut is
      // ∫p dz = p·z/(n + 1), not the full load × depth (Bekker's R_c).
      work += (n * dz) / (soil.n + 1);
      nSum += n;
      mu += soil.muSoil * n;
    }
    if (!resistance || work <= 0) continue;
    const v = Math.sqrt(hvx * hvx + hvz * hvz);
    if (v < 0.05) continue;
    // Below ~1 m/s most of the new sinkage is the wheel settling under its static load (gravity's work, not a
    // drag on the travel): the resistance fades in with speed, so a car that has sunk in can still creep out.
    let F = work / (v * dt);
    const cap = v < 1 ? mu * v : mu;
    if (F > cap) F = cap;
    const fx = (-0.5 * F * hvx) / v;
    const fz = (-0.5 * F * hvz) / v;
    frcX[hI] = frcX[hI]! + fx;
    frcZ[hI] = frcZ[hI]! + fz;
    frcX[hO] = frcX[hO]! + fx;
    frcZ[hO] = frcZ[hO]! + fz;
    void nSum;
  }
}

/**
 * SHEET-METAL DIG: body (non-wheel) nodes of a vehicle that were in ground contact last tick and touch a
 * rut-keeping soil gouge it (a furrow in the rut grid, at the node's slide speed as slip) and are held by the
 * soil's ploughing resistance F = muDig·N against their horizontal velocity (implicit: never reverses it).
 * Runs before the ground pass (N = this tick's ground force). Zero allocation.
 */
export function applyBodyDig(
  state: SimState,
  first: number,
  count: number,
  sg: SoftGround,
  sampler: HeightSampler,
  normalForce: (i: number) => number,
  tick: number,
  dt: number,
): void {
  const { posX, posZ, velX, velZ, frcX, frcZ, flags, invMass } = state;
  const end = first + count;
  const invDt = 1 / dt;
  for (let i = first; i < end; i++) {
    const f = flags[i]!;
    if ((f & NODE_FLAG_IN_CONTACT) === 0 || (f & NODE_FLAG_TREAD) !== 0) continue;
    const x = posX[i]!;
    const z = posZ[i]!;
    const mat = sampler.materialAt(x, z);
    const soil = SOILS[mat];
    if (soil === undefined) continue;
    const vx = velX[i]!;
    const vz = velZ[i]!;
    const v = Math.sqrt(vx * vx + vz * vz);
    if (v < 0.05) continue;
    const n = normalForce(i);
    if (!(n > 0)) continue;
    sg.press(x, z, mat, n, v, tick, dt);
    let F = soil.muDig * n;
    const cap = v * invDt / invMass[i]!;
    if (F > cap) F = cap;
    frcX[i] = frcX[i]! - (F * vx) / v;
    frcZ[i] = frcZ[i]! - (F * vz) / v;
  }
}
