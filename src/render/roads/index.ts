/**
 * createRoadRenderer (E, P3) — see the RoadRenderer contract in
 * src/render/types.ts and the mesher notes in geometry.ts.
 *
 * Scene graph: object (Group 'roads') → one Mesh per ~96 m piece with a
 * [core, fringe] material pair and 3 LOD geometries swapped by camera
 * distance (× QualityPreset.terrainLodBias, with hysteresis). three's
 * frustum culling uses each piece's bounding sphere.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Sphere,
  Vector3,
  type Camera,
  type Material,
} from 'three';

import type {
  QualityPreset,
  RenderContext,
  RoadRenderer,
  RoadRendererOptions,
  TerrainMaterialSet,
} from '../types';
import type { TerrainData, TerrainSampler } from '../../world/types';
import { buildRoadRibbons, type RibbonGeometryData, type RoadRibbons } from './geometry';
import { createRoadMaterials, createRoadNoiseTexture, createWhiteTexture, type RoadMaterialPair } from './material';

/** Material define selecting the one-tap road path (shader.ts RD_LITE). */
export const RD_LITE_DEFINE = 'RD_LITE';
/** Presets that use the lite road path. */
export function roadLite(level: string): boolean {
  return level === 'low';
}

export { buildRoadRibbons } from './geometry';

/** LOD switch distances (camera → piece sphere surface, m) before lodBias. */
export const ROAD_LOD_DISTANCES: readonly number[] = [140, 360];
const LOD_HYSTERESIS = 0.1;

export interface RoadRendererStats {
  pieces: number;
  visiblePieces: number;
  triangles: number;
  lodCounts: number[];
  junctions: number;
}

export interface RoadRendererExt extends RoadRenderer {
  readonly stats: RoadRendererStats;
  readonly ribbons: RoadRibbons;
}

function toGeometry(d: RibbonGeometryData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new BufferAttribute(d.normals, 3));
  g.setAttribute('aRoadUV', new BufferAttribute(d.roadUV, 2));
  g.setAttribute('aJunc', new BufferAttribute(d.junc, 4));
  g.setAttribute('aMisc', new BufferAttribute(d.misc, 4));
  g.setAttribute('aMouth', new BufferAttribute(d.mouth, 1));
  g.setIndex(new BufferAttribute(d.index, 1));
  g.addGroup(0, d.coreCount, 0);
  g.addGroup(d.coreCount, d.index.length - d.coreCount, 1);
  g.boundingSphere = new Sphere(new Vector3(d.center[0], d.center[1], d.center[2]), d.radius + 0.5);
  return g;
}

export function createRoadRenderer(
  ctx: RenderContext,
  terrain: TerrainData,
  sampler: TerrainSampler,
  materials: TerrainMaterialSet,
  opts: RoadRendererOptions,
): RoadRendererExt {
  const ribbons = buildRoadRibbons(terrain.roads, sampler);
  const noise = createRoadNoiseTexture();
  noise.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
  const white = createWhiteTexture();
  const deps = {
    materials,
    noise,
    white,
    patchMaterial: opts.patchMaterial,
    csm: opts.lighting.csm,
  };
  const mats: RoadMaterialPair[] = ribbons.roads.map((info, i) => createRoadMaterials(info, i + 1, deps));

  const object = new Group();
  object.name = 'roads';
  interface PieceRt {
    mesh: Mesh;
    lods: BufferGeometry[];
    tris: number[];
    lod: number;
    center: Vector3;
    radius: number;
  }
  const pieces: PieceRt[] = ribbons.pieces.map((p, pi) => {
    const lods = p.lods.map(toGeometry);
    const m = mats[p.road]!;
    const mesh = new Mesh(lods[0], [m.core, m.fringe] as Material[]);
    mesh.name = `road:${ribbons.roads[p.road]!.profile.id}:${pi}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // Fringes blend over the terrain: draw roads after it.
    mesh.renderOrder = 1;
    const s = p.lods[0]!;
    object.add(mesh);
    return {
      mesh,
      lods,
      tris: p.lods.map((l) => l.index.length / 3),
      lod: 0,
      center: new Vector3(s.center[0], s.center[1], s.center[2]),
      radius: s.radius,
    };
  });

  /** Low preset: one texture tap per map (RD_LITE, shader.ts). */
  const applyLite = (q: QualityPreset): void => {
    const lite = roadLite(q.level);
    for (const m of mats) {
      for (const mat of [m.core, m.fringe]) {
        const defines = (mat.defines ??= {});
        if (lite === (RD_LITE_DEFINE in defines)) continue;
        if (lite) defines[RD_LITE_DEFINE] = '';
        else delete defines[RD_LITE_DEFINE];
        mat.needsUpdate = true;
      }
    }
  };
  applyLite(ctx.quality);

  let lodBias = ctx.quality.terrainLodBias;
  const stats: RoadRendererStats = {
    pieces: pieces.length,
    visiblePieces: pieces.length,
    triangles: 0,
    lodCounts: [0, 0, 0],
    junctions: ribbons.junctions.junctions.length,
  };
  const camPos = new Vector3();

  const update = (camera: Camera): void => {
    camera.getWorldPosition(camPos);
    stats.lodCounts.fill(0);
    stats.triangles = 0;
    for (const p of pieces) {
      const d = Math.max(0, camPos.distanceTo(p.center) - p.radius);
      const maxLod = Math.min(ROAD_LOD_DISTANCES.length, p.lods.length - 1);
      let lod = p.lod;
      while (lod < maxLod && d > ROAD_LOD_DISTANCES[lod]! * lodBias * (1 + LOD_HYSTERESIS)) lod++;
      while (lod > 0 && d < ROAD_LOD_DISTANCES[lod - 1]! * lodBias * (1 - LOD_HYSTERESIS)) lod--;
      if (lod !== p.lod) {
        p.lod = lod;
        p.mesh.geometry = p.lods[lod]!;
      }
      stats.lodCounts[lod] = (stats.lodCounts[lod] ?? 0) + 1;
      stats.triangles += p.tris[lod]!;
    }
  };

  return {
    object,
    ribbons,
    stats,
    update,
    setQuality(q: QualityPreset) {
      lodBias = q.terrainLodBias;
      applyLite(q);
    },
    dispose() {
      for (const p of pieces) for (const g of p.lods) g.dispose();
      for (const m of mats) {
        m.core.dispose();
        m.fringe.dispose();
      }
      noise.dispose();
      white.dispose();
      object.removeFromParent();
    },
  };
}
