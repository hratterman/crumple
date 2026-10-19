/**
 * Reflection-only terrain proxy: the planar reflection pass draws this ONE
 * coarse, vertex-coloured heightfield instead of the chunked terrain (~300
 * chunk draws looking across the lake) and the road ribbons (~100), which
 * keeps the pass inside WATER_REFLECTION_DRAW_BUDGET. Reflections are
 * wave-distorted and half resolution, so 4 m spacing around the lake (16 m
 * beyond) with splat-averaged albedo reads the same as the real terrain.
 * Lives on WATER_REFLECTION_LAYER (enabled only on the reflection camera).
 */
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three';

import { SPLAT_CHANNELS, SPLAT_DIRT, SPLAT_GRAVEL, SPLAT_PAVED, SPLAT_ROCK } from '../../world/types';
import type { TerrainData, WaterBody } from '../../world/types';

/** Render layer seen only by the water's reflection camera. */
export const WATER_REFLECTION_LAYER = 3;
/** Fine proxy spacing within PROXY_NEAR_M of a lake, m; coarse spacing elsewhere. */
export const PROXY_FINE_M = 4;
export const PROXY_COARSE_M = 16;
export const PROXY_NEAR_M = 380;

/** Linear albedo per splat layer (paved, dirt, rock, gravel, grass), matched to the shaded terrain. */
const ALBEDO: readonly (readonly [number, number, number])[] = [
  [0.05, 0.05, 0.05],
  [0.16, 0.115, 0.075],
  [0.2, 0.175, 0.15],
  [0.21, 0.19, 0.16],
  [0.055, 0.085, 0.025],
];

interface Grid {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
}

/** Positions / colours / indices of one regular grid (cells for which `keepCell` is true). */
function gridMesh(
  t: TerrainData,
  g: Grid,
  level: number,
  keepCell: (x: number, z: number) => boolean,
  pos: number[],
  col: number[],
  idx: number[],
): void {
  const vid = new Int32Array((g.nx + 1) * (g.nz + 1)).fill(-1);
  const vert = (i: number, j: number): number => {
    const k = j * (g.nx + 1) + i;
    if (vid[k]! >= 0) return vid[k]!;
    const x = g.x0 + i * g.step;
    const z = g.z0 + j * g.step;
    const c = Math.min(t.cols - 1, Math.max(0, Math.round((x - t.originX) / t.spacing)));
    const r = Math.min(t.rows - 1, Math.max(0, Math.round((z - t.originZ) / t.spacing)));
    const s = r * t.cols + c;
    pos.push(x, t.heights[s]!, z);
    const o = s * SPLAT_CHANNELS;
    const w = [t.splat[o + SPLAT_PAVED]!, t.splat[o + SPLAT_DIRT]!, t.splat[o + SPLAT_ROCK]!, t.splat[o + SPLAT_GRAVEL]!, 0];
    w[4] = Math.max(0, 255 - w[0]! - w[1]! - w[2]! - w[3]!);
    let cr = 0;
    let cg = 0;
    let cb = 0;
    for (let l = 0; l < 5; l++) {
      const f = w[l]! / 255;
      cr += f * ALBEDO[l]![0];
      cg += f * ALBEDO[l]![1];
      cb += f * ALBEDO[l]![2];
    }
    col.push(cr, cg, cb);
    vid[k] = pos.length / 3 - 1;
    return vid[k]!;
  };
  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.step;
      const z = g.z0 + (j + 0.5) * g.step;
      if (!keepCell(x, z)) continue;
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c = vert(i, j + 1);
      const d = vert(i + 1, j + 1);
      // drop cells deep under the water (the oblique clip removes them anyway)
      if (Math.max(pos[a * 3 + 1]!, pos[b * 3 + 1]!, pos[c * 3 + 1]!, pos[d * 3 + 1]!) < level - 1) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
}

export function buildReflectionProxy(terrain: TerrainData, bodies: readonly WaterBody[]): Mesh<BufferGeometry, MeshStandardMaterial> | null {
  if (bodies.length === 0) return null;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const size = (terrain.cols - 1) * terrain.spacing;
  const minX = terrain.originX;
  const minZ = terrain.originZ;
  const level = Math.min(...bodies.map((b) => b.level));
  const near = bodies.map((b) => ({
    x0: Math.max(minX, b.minX - PROXY_NEAR_M),
    x1: Math.min(minX + size, b.maxX + PROXY_NEAR_M),
    z0: Math.max(minZ, b.minZ - PROXY_NEAR_M),
    z1: Math.min(minZ + size, b.maxZ + PROXY_NEAR_M),
  }));
  const snap = (v: number, s: number, o: number): number => o + Math.floor((v - o) / s) * s;
  // fine grids
  for (const n of near) {
    const x0 = snap(n.x0, PROXY_FINE_M, minX);
    const z0 = snap(n.z0, PROXY_FINE_M, minZ);
    const g: Grid = {
      x0,
      z0,
      step: PROXY_FINE_M,
      nx: Math.ceil((n.x1 - x0) / PROXY_FINE_M),
      nz: Math.ceil((n.z1 - z0) / PROXY_FINE_M),
    };
    gridMesh(terrain, g, level, () => true, pos, col, idx);
  }
  // coarse grid outside the fine regions (cells overlap the fine border by one coarse cell: no cracks)
  const inFine = (x: number, z: number): boolean =>
    near.some((n) => x > n.x0 + PROXY_COARSE_M && x < n.x1 - PROXY_COARSE_M && z > n.z0 + PROXY_COARSE_M && z < n.z1 - PROXY_COARSE_M);
  const coarse: Grid = { x0: minX, z0: minZ, step: PROXY_COARSE_M, nx: Math.floor(size / PROXY_COARSE_M), nz: Math.floor(size / PROXY_COARSE_M) };
  gridMesh(terrain, coarse, level, (x, z) => !inFine(x, z), pos, col, idx);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  const n = pos.length / 3;
  geo.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new MeshStandardMaterial({ name: 'crumple.water.proxy', vertexColors: true, roughness: 0.92, metalness: 0 });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'water-reflection-proxy';
  mesh.layers.set(WATER_REFLECTION_LAYER);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  return mesh;
}
