import { beforeAll, describe, expect, it } from 'vitest';

import { MaterialId } from '../protocol/messages';
import { colliderWorldAabb, resolveColliders } from './colliders';
import { DEFAULT_LAYOUT } from './layout';
import { createRoadProjection, projectToRoad } from './roads';
import { createTerrainSampler } from './sampler';
import { compileShape } from './shapes';
import { generateTerrain } from './terrain';
import {
  VEG_BOULDER_CENTER_LIFT,
  VEG_BOULDER_RADIUS_M,
  VEG_COLLIDER_REACH_M,
  VEG_MAX_COLLIDERS,
  VEG_MAX_INSTANCES,
  VEG_ROAD_CLEARANCE_M,
  VEG_TREE_MIN_SPACING_M,
  VEG_TRUNK_HALF_HEIGHT_M,
  VEG_TRUNK_RADIUS_M,
  VegetationKind,
  type TerrainData,
  type VegetationScatter,
} from './types';
import { emptyScatter, hashVegetation, scatterBuffers, scatterVegetation, VEG_MIN_TREE_NY, VEG_VARIANTS } from './vegetation';

const isTree = (k: number): boolean => k === VegetationKind.conifer || k === VegetationKind.broadleaf;

describe('scatterVegetation (DEFAULT_LAYOUT)', () => {
  let terrain: TerrainData;
  let s: VegetationScatter;
  let ms = 0;
  beforeAll(() => {
    terrain = generateTerrain(DEFAULT_LAYOUT);
    const t0 = performance.now();
    s = scatterVegetation(DEFAULT_LAYOUT, terrain);
    ms = performance.now() - t0;
  }, 120_000);

  it('is deterministic and hashed (same call → same hash; hash covers the SoA)', () => {
    const again = scatterVegetation(DEFAULT_LAYOUT, terrain);
    expect(again.hash).toBe(s.hash);
    expect(hashVegetation(s)).toBe(s.hash);
    expect(again.count).toBe(s.count);
    expect(Array.from(again.collider)).toEqual(Array.from(s.collider));
    // Perturbing one instance changes the hash.
    const x = s.x[0]!;
    s.x[0] = x + 0.25;
    expect(hashVegetation(s)).not.toBe(s.hash);
    s.x[0] = x;
    console.info(`[vegetation] ${s.count} instances, ${s.colliders.length} colliders in ${ms.toFixed(0)} ms`);
  });

  it('depends on the splat (the worker must scatter before dropping it)', () => {
    const noSplat = scatterVegetation(DEFAULT_LAYOUT, { ...terrain, splat: new Uint8Array(0) });
    expect(noSplat.hash).not.toBe(s.hash);
  });

  it('fills every biome within the instance budget', () => {
    expect(s.count).toBeLessThanOrEqual(VEG_MAX_INSTANCES);
    const counts = [0, 0, 0, 0, 0];
    const variants = VEG_VARIANTS.map((n) => new Array<number>(n).fill(0));
    for (let i = 0; i < s.count; i++) {
      counts[s.kind[i]!]!++;
      expect(s.variant[i]!).toBeLessThan(VEG_VARIANTS[s.kind[i]!]!);
      variants[s.kind[i]!]![s.variant[i]!]!++;
    }
    expect(counts[VegetationKind.conifer]!).toBeGreaterThan(4000);
    expect(counts[VegetationKind.broadleaf]!).toBeGreaterThan(4000);
    expect(counts[VegetationKind.shrub]!).toBeGreaterThan(3000);
    expect(counts[VegetationKind.rock]!).toBeGreaterThan(1500);
    expect(counts[VegetationKind.boulder]!).toBeGreaterThan(300);
    for (const v of variants.flat()) expect(v).toBeGreaterThan(0);
  });

  it('SoA fields are finite and in range', () => {
    let bad = 0;
    for (let i = 0; i < s.count; i++) {
      const ok =
        Number.isFinite(s.x[i]!) && Number.isFinite(s.y[i]!) && Number.isFinite(s.z[i]!) &&
        s.scale[i]! >= 0.4 && s.scale[i]! <= 2 && s.yaw[i]! >= 0 && s.yaw[i]! < 2 * Math.PI + 1e-6 && s.rank[i]! >= 0 && s.rank[i]! < 1;
      if (!ok) bad++;
    }
    expect(bad).toBe(0);
    // Rank is uniform within a kind (density keeps ~that fraction of every kind).
    for (let k = 0; k < 5; k++) {
      let n = 0;
      let below = 0;
      for (let i = 0; i < s.count; i++) {
        if (s.kind[i] !== k) continue;
        n++;
        if (s.rank[i]! < 0.25) below++;
      }
      expect(below / n).toBeGreaterThan(0.2);
      expect(below / n).toBeLessThan(0.3);
    }
  });

  it('keeps out of water, pads, the town and arena, colliders, spawns and the map rim', () => {
    const pads = DEFAULT_LAYOUT.pads.map((p) => compileShape(p.shape));
    const flats = DEFAULT_LAYOUT.zones.filter((z) => z.kind === 'town' || z.kind === 'arena').map((z) => compileShape(z.shape));
    const smp = createTerrainSampler(terrain);
    const boxes = resolveColliders(DEFAULT_LAYOUT.colliders, (x, z) => smp.heightAt(x, z));
    const aabbs = boxes.map((c) => colliderWorldAabb(c, 2));
    const bad: Record<string, number> = { water: 0, height: 0, pad: 0, flat: 0, collider: 0, spawn: 0 };
    for (let i = 0; i < s.count; i++) {
      const x = s.x[i]!;
      const z = s.z[i]!;
      if (s.y[i]! < terrain.waterLevel + 0.4) bad.water!++;
      if (Math.abs(s.y[i]! - smp.heightAt(x, z)) > 1e-3) bad.height!++;
      for (const p of pads) if (p.outside(x, z) <= 0) bad.pad!++;
      for (const f of flats) if (f.mask(x, z) > 0.1) bad.flat!++;
      for (const b of aabbs) if (x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5]) bad.collider!++;
      for (const sp of terrain.spawns) if (Math.hypot(x - sp.pos[0], z - sp.pos[2]) < 12) bad.spawn!++;
    }
    expect(bad).toEqual({ water: 0, height: 0, pad: 0, flat: 0, collider: 0, spawn: 0 });
  }, 60_000);

  it('trees and shrubs stand on gentle, non-rock ground; trees keep their spacing', () => {
    const smp = createTerrainSampler(terrain);
    const n = new Float64Array(3);
    const sp = new Float64Array(5);
    const cell = new Map<number, number[]>();
    const key = (x: number, z: number): number => Math.floor(x / 4 + 1000) * 4096 + Math.floor(z / 4 + 1000);
    let steep = 0;
    let rocky = 0;
    let close = 0;
    let minNy = 1;
    for (let i = 0; i < s.count; i++) {
      const k = s.kind[i]!;
      if (k > VegetationKind.shrub) continue;
      smp.normalAt(s.x[i]!, s.z[i]!, n);
      minNy = Math.min(minNy, n[1]!);
      if (n[1]! < 0.8) steep++;
      smp.splatAt(s.x[i]!, s.z[i]!, sp);
      if (sp[2]! >= 0.5) rocky++;
      if (!isTree(k)) continue;
      const kk = key(s.x[i]!, s.z[i]!);
      const list = cell.get(kk) ?? [];
      list.push(i);
      cell.set(kk, list);
    }
    for (const [kk, list] of cell) {
      const cx = Math.floor(kk / 4096);
      const cz = kk % 4096;
      for (const i of list) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (const j of cell.get((cx + dx) * 4096 + cz + dz) ?? []) {
              if (j > i && Math.hypot(s.x[i]! - s.x[j]!, s.z[i]! - s.z[j]!) < VEG_TREE_MIN_SPACING_M) close++;
            }
          }
        }
      }
    }
    expect({ steep, rocky, close }).toEqual({ steep: 0, rocky: 0, close: 0 });
    expect(minNy).toBeGreaterThanOrEqual(VEG_MIN_TREE_NY - 1e-3);
  }, 60_000);

  it('clears every road verge by VEG_ROAD_CLEARANCE_M and turns trees / boulders within reach into colliders', () => {
    const proj = createRoadProjection();
    const pads = DEFAULT_LAYOUT.pads.map((p) => compileShape(p.shape));
    const arena = compileShape(DEFAULT_LAYOUT.zones.find((z) => z.kind === 'arena')!.shape);
    let nearRoad = 0;
    let tooClose = 0;
    let missing = 0;
    let stray = 0;
    for (let i = 0; i < s.count; i++) {
      const k = s.kind[i]!;
      let edge = Infinity;
      for (const road of terrain.roads) {
        projectToRoad(road, s.x[i]!, s.z[i]!, proj);
        edge = Math.min(edge, proj.dist - (road.width / 2 + road.shoulder));
      }
      if (edge < VEG_ROAD_CLEARANCE_M[k]! - 0.02) tooClose++;
      if (isTree(k) || k === VegetationKind.boulder) {
        let reach = edge <= VEG_COLLIDER_REACH_M;
        for (const p of pads) reach ||= p.outside(s.x[i]!, s.z[i]!) <= VEG_COLLIDER_REACH_M;
        reach ||= arena.outside(s.x[i]!, s.z[i]!) <= VEG_COLLIDER_REACH_M;
        if (reach) {
          nearRoad++;
          if (s.collider[i]! < 0) missing++;
        }
      } else if (s.collider[i] !== -1) {
        stray++;
      }
    }
    expect({ tooClose, missing, stray }).toEqual({ tooClose: 0, missing: 0, stray: 0 });
    expect(nearRoad).toBeGreaterThan(300);
  }, 120_000);

  it('emits valid, sparse colliders (wood trunks, rock domes) that resolve on both sides', () => {
    expect(s.colliders.length).toBeGreaterThan(300);
    expect(s.colliders.length).toBeLessThanOrEqual(VEG_MAX_COLLIDERS);
    const smp = createTerrainSampler(terrain);
    const resolved = resolveColliders(s.colliders, (x, z) => smp.heightAt(x, z));
    expect(resolved).toHaveLength(s.colliders.length);
    const seen = new Set<number>();
    for (let i = 0; i < s.count; i++) {
      const c = s.collider[i]!;
      if (c < 0) continue;
      expect(seen.has(c)).toBe(false);
      seen.add(c);
      const def = s.colliders[c]!;
      expect(def.id).toBe(`veg:${i}`);
      expect(def.visual).toBe('none');
      if (s.kind[i] === VegetationKind.boulder) {
        const r = VEG_BOULDER_RADIUS_M * s.scale[i]!;
        expect(def.kind).toBe('sphere');
        expect(def.material).toBe(MaterialId.rock);
        expect(def.size[0]).toBeCloseTo(r, 5);
        expect(def.pos[1]).toBeCloseTo(s.y[i]! + VEG_BOULDER_CENTER_LIFT * r, 3);
      } else {
        expect(def.kind).toBe('cylinder');
        expect(def.material).toBe(MaterialId.wood);
        expect(def.pos[1]).toBeNull();
        expect(def.size[0]).toBeCloseTo(VEG_TRUNK_RADIUS_M[s.kind[i]!]! * s.scale[i]!, 5);
        expect(def.size[1]).toBe(VEG_TRUNK_HALF_HEIGHT_M);
      }
    }
    expect(seen.size).toBe(s.colliders.length);
    // ≥ 4 m apart (the sim's 8 m collider grid stays well under its per-object candidate cap).
    const pts = s.colliders.map((c) => [c.pos[0], c.pos[2]] as const);
    const grid = new Map<string, number[]>();
    pts.forEach((p, i) => {
      const k = `${Math.floor(p[0] / 4)},${Math.floor(p[1] / 4)}`;
      grid.set(k, [...(grid.get(k) ?? []), i]);
    });
    let maxPer8 = 0;
    const per8 = new Map<string, number>();
    pts.forEach((p, i) => {
      const gx = Math.floor(p[0] / 4);
      const gz = Math.floor(p[1] / 4);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
            if (j > i) expect(Math.hypot(p[0] - pts[j]![0], p[1] - pts[j]![1])).toBeGreaterThanOrEqual(4 - 1e-6);
          }
        }
      }
      const k8 = `${Math.floor(p[0] / 8)},${Math.floor(p[1] / 8)}`;
      per8.set(k8, (per8.get(k8) ?? 0) + 1);
      maxPer8 = Math.max(maxPer8, per8.get(k8)!);
    });
    expect(maxPer8).toBeLessThanOrEqual(8);
  });

  it('keeps the summit lookout view and the highway corridor open', () => {
    const look = DEFAULT_LAYOUT.pads.find((p) => p.purpose === 'lookout')!;
    const [lx, lz] = look.shape.type === 'circle' ? look.shape.center : [0, 0];
    let near = 0;
    for (let i = 0; i < s.count; i++) {
      if (!isTree(s.kind[i]!)) continue;
      const dz = s.z[i]! - lz;
      if (dz > 0 && Math.hypot(s.x[i]! - lx, dz) < 70) near++;
    }
    expect(near).toBe(0);
  });

  it('hands its buffers over for transfer', () => {
    const bufs = scatterBuffers(s);
    expect(bufs.length).toBe(9);
    expect(new Set(bufs).size).toBe(bufs.length);
    expect(scatterBuffers(emptyScatter())).toHaveLength(0);
  });
});
