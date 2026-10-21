/**
 * Natural detail (layout v6, R-WORLD): what sits between the trees.
 *  - fallen logs in the hills / mountains (SOLID: lying cylinder colliders, hashed numerics),
 *  - render-only items (main's helper worker only): wildflower patches in meadows, tall-grass
 *    tussocks along road verges and field margins, roadside rubbish (cans, bottles, a tyre,
 *    a bag) on the gravel shoulders, small stone clusters on rocky ground.
 * Placement walks a fixed grid (rows, cols ascending) and decides per cell from the terrain
 * material + slope, a cell hash and the content exclusions (buildings, lots, structures).
 */
import { createRng } from '../../core/rng';
import { MaterialId } from '../../protocol/messages';
import { compileShape, type CompiledShape } from '../shapes';
import type { ColliderDef, TerrainData, WorldLayout } from '../types';
import type { ContentExclusion, ItemInstance } from './types';
import { cylinder, hash01, mm, yawQuatDir, type Quat } from './util';

export interface DetailOut {
  colliders: ColliderDef[];
  exclusions: ContentExclusion[];
  items: ItemInstance[];
}

/** Bucketed exclusion test (32 m buckets). */
class ExclusionGrid {
  private readonly b = new Map<number, ContentExclusion[]>();
  constructor(list: readonly ContentExclusion[]) {
    for (const e of list) {
      const r = Math.abs(e.hx) + Math.abs(e.hz);
      for (let bz = Math.floor((e.cz - r) / 32); bz <= Math.floor((e.cz + r) / 32); bz++) {
        for (let bx = Math.floor((e.cx - r) / 32); bx <= Math.floor((e.cx + r) / 32); bx++) {
          const k = bz * 4096 + bx;
          let a = this.b.get(k);
          if (!a) this.b.set(k, (a = []));
          a.push(e);
        }
      }
    }
  }
  hit(x: number, z: number, pad: number): boolean {
    const a = this.b.get(Math.floor(z / 32) * 4096 + Math.floor(x / 32));
    if (!a) return false;
    for (const e of a) {
      const dx = x - e.cx;
      const dz = z - e.cz;
      const u = dx * e.ax + dz * e.az;
      const v = -dx * e.az + dz * e.ax;
      if (Math.abs(u) <= e.hx + pad && Math.abs(v) <= e.hz + pad) return true;
    }
    return false;
  }
}

/** Wildflower colours (sRGB): buttercup, daisy, clover, poppy, cornflower. */
const FLOWERS = [0xf2d22a, 0xeeeae0, 0xb04ad0, 0xd83a2a, 0x4a6ad8];

const PAVED = new Set<number>([MaterialId.asphalt, MaterialId.concrete, MaterialId.asphaltWorn]);

export function buildDetail(layout: WorldLayout, t: TerrainData, exclusions: readonly ContentExclusion[], render: boolean): DetailOut {
  const o: DetailOut = { colliders: [], exclusions: [], items: [] };
  const ex = new ExclusionGrid(exclusions);
  const exDetail = new ExclusionGrid(exclusions.filter((e) => e.detail));
  const { cols, rows, originX, originZ, spacing, heights, material } = t;
  const idx = (x: number, z: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.round((x - originX) / spacing)));
    const r = Math.min(rows - 1, Math.max(0, Math.round((z - originZ) / spacing)));
    return r * cols + c;
  };
  const H = (x: number, z: number): number => heights[idx(x, z)]!;
  const M = (x: number, z: number): number => material[idx(x, z)]!;
  const slope = (x: number, z: number): number => {
    const gx = (H(x + 2, z) - H(x - 2, z)) / 4;
    const gz = (H(x, z + 2) - H(x, z - 2)) / 4;
    return Math.sqrt(gx * gx + gz * gz);
  };
  const wild: CompiledShape[] = [];
  const settled: CompiledShape[] = [];
  const wet: CompiledShape[] = [];
  for (const zn of layout.zones) {
    if (zn.kind === 'hills' || zn.kind === 'mountains') wild.push(compileShape(zn.shape));
    else if (zn.kind === 'town' || zn.kind === 'arena') settled.push(compileShape(zn.shape));
    else if (zn.kind === 'lake') wet.push(compileShape(zn.shape));
  }
  const inAny = (list: CompiledShape[], x: number, z: number, grow = 0): boolean => {
    for (const s of list) if (s.outside(x, z) <= grow) return true;
    return false;
  };
  const nearPaved = (x: number, z: number, r: number): boolean => PAVED.has(M(x + r, z)) || PAVED.has(M(x - r, z)) || PAVED.has(M(x, z + r)) || PAVED.has(M(x, z - r)) || PAVED.has(M(x, z));
  const nearRoadMat = (x: number, z: number, r: number): boolean => {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [0, 0],
    ] as const) {
      const m = M(x + dx, z + dz);
      if (PAVED.has(m) || m === MaterialId.gravel) return true;
    }
    return false;
  };
  const half = (cols - 1) * spacing * 0.5;
  const rim = half - 40;

  // ---- fallen logs (solid): 48 m cells over the wild zones
  const rng = createRng(((layout.seed ?? 1) ^ 0x10a5) >>> 0);
  let logs = 0;
  const qLie: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // local Y → X (lying)
  for (let gz = -rim; gz < rim; gz += 48) {
    for (let gx = -rim; gx < rim; gx += 48) {
      const p = rng.float();
      const x = gx + rng.float() * 48;
      const z = gz + rng.float() * 48;
      const dx = rng.float() * 2 - 1;
      const dz = rng.float() * 2 - 1;
      const len = 2.5 + rng.float() * 3.5;
      const r = 0.16 + rng.float() * 0.16;
      if (p > 0.16) continue;
      if (!inAny(wild, x, z) || inAny(settled, x, z, 30) || inAny(wet, x, z, 20)) continue;
      const m = M(x, z);
      if (m !== MaterialId.grass && m !== MaterialId.dirt && m !== MaterialId.wetGrass) continue;
      if (slope(x, z) > 0.08 || nearRoadMat(x, z, 8) || ex.hit(x, z, 4)) continue; // level ground: a straight log lies flat
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l < 0.1) continue;
      // yaw (log axis along (dx, dz)) ∘ lie (local Y → local X); quaternion product with + − × only
      const qy = yawQuatDir(-dz / l, dx / l); // local −Z → (−dz, dx): local X → (dx, dz)
      const q = qmul(qy, qLie);
      const y = H(x, z) + r * 0.8;
      o.colliders.push(cylinder(`w:dt:log${logs}`, [mm(x), mm(y), mm(z)], q, mm(r), mm(len / 2), MaterialId.wood, 'log'));
      o.exclusions.push({ cx: mm(x), cz: mm(z), ax: dx / l, az: dz / l, hx: len / 2 + 0.8, hz: 1.2, detail: true });
      logs++;
    }
  }
  if (!render) return o;

  // ---- render-only detail: 6 m cells, one candidate each
  for (let gz = -rim; gz < rim; gz += 6) {
    for (let gx = -rim; gx < rim; gx += 6) {
      const k = Math.round(gz * 4099 + gx);
      const h = hash01('dt', k);
      if (h > 0.5) continue;
      const x = gx + hash01('dtx', k) * 6;
      const z = gz + hash01('dtz', k) * 6;
      const m = M(x, z);
      if (PAVED.has(m)) continue;
      const roadside = nearPaved(x, z, 5);
      // meadow patches: low-frequency blobs (128 m cells, 35 % flowering)
      const meadow = hash01('mdw', Math.floor(x / 128) * 131 + Math.floor(z / 128)) < 0.35;
      const s = slope(x, z);
      if (exDetail.hit(x, z, 0.5)) continue;
      const dir: [number, number] = [hash01('dd', k) * 2 - 1, hash01('de', k) * 2 - 1];
      if ((m === MaterialId.grass || m === MaterialId.wetGrass) && !roadside && meadow && s < 0.3 && h < 0.16 && !inAny(settled, x, z, -10)) {
        o.items.push({ kind: 'flowers', pos: [x, 0, z], dir, scale: 0.8 + hash01('ds', k) * 0.6, variant: 0, color: FLOWERS[Math.floor(hash01('dv', k) * FLOWERS.length)] });
      } else if ((m === MaterialId.grass || m === MaterialId.dirt || m === MaterialId.gravel) && roadside && !nearPaved(x, z, 1.5) && h < 0.22) {
        if (h < 0.012 && !inAny(settled, x, z, -40)) o.items.push({ kind: 'litter', pos: [x, 0, z], dir, scale: 1, variant: Math.floor(hash01('dl', k) * 4) });
        else o.items.push({ kind: 'tussock', pos: [x, 0, z], dir, scale: 0.7 + hash01('ds', k) * 0.7, variant: Math.floor(hash01('dv', k) * 3) });
      } else if ((m === MaterialId.grass || m === MaterialId.wetGrass) && h < 0.05 && !inAny(settled, x, z)) {
        o.items.push({ kind: 'tussock', pos: [x, 0, z], dir, scale: 0.8 + hash01('ds', k) * 0.8, variant: Math.floor(hash01('dv', k) * 3) });
      } else if ((m === MaterialId.rock || s > 0.6) && h < 0.08) {
        o.items.push({ kind: 'stones', pos: [x, 0, z], dir, scale: 0.6 + hash01('ds', k) * 0.9, variant: Math.floor(hash01('dv', k) * 2) });
      }
    }
  }
  return o;
}

/** Hamilton product a ⊗ b (unit quats; + − × only). */
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
