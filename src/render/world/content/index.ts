/**
 * World-content renderer (layout v6, R-WORLD): draws the generated content
 * (src/world/content) — structures (bridges, tunnels, lamp standards) now;
 * buildings, street furniture, decals and detail in later units — from the
 * same records / colliders the physics worker installs. Static meshes merged
 * per material (a handful of draws); `lights` is the WorldLight list for
 * R-GFX's night lighting (docs/CONTRACTS.md "R-WORLD contracts" → lights).
 */
import { BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Camera, type Material } from 'three';
import type { WorldContent, WorldLight } from '../../../world/content/types';
import { resolveColliders } from '../../../world/colliders';
import type { TerrainData, TerrainSampler } from '../../../world/types';
import type { LightingStack, PatchMaterial, QualityPreset, RenderContext } from '../../types';
import type { Geo } from './geo';
import { createContentMaterials } from './materials';
import { addLights, addStructureColliders, addStructureRecords, newStructureGeos } from './structures';
import { buildingTextures } from './buildingTextures';
import { addBuilding, buildingAttrs, createFacadeMaterial, createRoofMaterial, newBuildingGeos, trimMaterial, type FacadeUniforms } from './buildings';
import { createItems, type ItemsRenderer } from './items';
import { addCables, addDecals, addPuddles, addStrips, buildSigns, decalMaterial, puddleMaterial } from './surfaces';
import { Geo as GeoBuilder } from './geo';
import { addAreaColliders, addAreaRecords, addAreaStrips, type AreaGeos, type GeoAt, type TextBoard } from './areas';

/** Content batches farther than this (m, plan distance to the batch) stop casting shadows. */
export const SHADOW_CASTER_M = 300;

export interface WorldContentRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}

export interface WorldContentRenderer {
  readonly object: Group;
  /** Light sources for night lighting (R-GFX), = content.lights. */
  readonly lights: readonly WorldLight[];
  readonly stats: { draws: number; triangles: number; buildMs: number };
  update(camera: Camera, simTimeS: number): void;
  setQuality(q: QualityPreset): void;
  dispose(): void;
}

export function createWorldContentRenderer(
  ctx: RenderContext,
  content: WorldContent,
  terrain: TerrainData,
  sampler: TerrainSampler,
  opts: WorldContentRendererOptions,
): WorldContentRenderer {
  const t0 = performance.now();
  let maxAniso = 8;
  try {
    maxAniso = ctx.renderer.capabilities.getMaxAnisotropy();
  } catch {
    maxAniso = 1;
  }
  const mats = createContentMaterials(maxAniso, opts.lighting, opts.patchMaterial);
  const root = new Group();
  root.name = 'worldContent';
  const resolved = resolveColliders(content.colliders, (x, z) => sampler.heightAt(x, z));

  const sg = newStructureGeos();
  addStructureColliders(sg, resolved);
  if (content.render) addStructureRecords(sg, content.render.structures, terrain.roads);
  addLights(sg, content.lights, (x, z) => sampler.heightAt(x, z));

  let triangles = 0;
  const add = (g: Geo, m: Material, name: string, shadows = true, extra?: (geo: ReturnType<Geo['build']>) => void): void => {
    if (g.vertexCount === 0) return;
    const geo = g.build();
    extra?.(geo);
    triangles += g.idx.length / 3;
    const me = new Mesh(geo, m);
    me.name = `worldContent:${name}`;
    me.castShadow = shadows;
    me.receiveShadow = true;
    me.matrixAutoUpdate = false;
    me.updateMatrixWorld(true);
    root.add(me);
  };
  // Mode-area solids, barriers and free-standing structures: the structure materials (+ painted), batched
  // per AREA_CELL_M cell so off-screen cells frustum- and shadow-cull (tyre walls alone are ~150 k tris); 512 m
  // keeps it to ≤ 5 draws per occupied cell.
  const AREA_CELL_M = 512;
  const cells = new Map<string, AreaGeos>();
  const geoAt: GeoAt = (x, z) => {
    const key = `${Math.floor(x / AREA_CELL_M)},${Math.floor(z / AREA_CELL_M)}`;
    let g = cells.get(key);
    if (!g) cells.set(key, (g = { concrete: new GeoBuilder(), concreteDark: new GeoBuilder(), steel: new GeoBuilder(), painted: new GeoBuilder(true), lamp: new GeoBuilder() }));
    return g;
  };
  const boards: TextBoard[] = [];
  addAreaColliders(geoAt, resolved);
  if (content.render) {
    addAreaStrips(geoAt, content.render.strips);
    addAreaRecords(geoAt, content.render.structures, boards);
  }
  add(sg.concrete, mats.concrete, 'concrete');
  add(sg.concreteDark, mats.concreteDark, 'concreteDark');
  add(sg.tile, mats.tile, 'tile', false);
  add(sg.steel, mats.steel, 'steel');
  add(sg.lamp, mats.lamp, 'lamp', false);
  const areaStart = root.children.length;
  for (const [key, g] of cells) {
    add(g.concrete, mats.concrete, `area:${key}:concrete`);
    add(g.concreteDark, mats.concreteDark, `area:${key}:concreteDark`);
    add(g.steel, mats.steel, `area:${key}:steel`);
    add(g.painted, mats.painted, `area:${key}:painted`);
    add(g.lamp, mats.lamp, `area:${key}:lamp`, false);
  }
  // Shadow LOD: per-cell area batches cast shadows only near the camera (every caster costs a draw in
  // each cascade it reaches; the far cascade sees the whole town).
  const areaMeshes = root.children.slice(areaStart).filter((m) => (m as Mesh).castShadow) as Mesh[];
  if (sg.shade.vertexCount > 0) {
    // Shadow-only: writes nothing in the colour pass (one empty draw), casts in every cascade.
    const shadeMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    mats.all.push(shadeMat);
    add(sg.shade, shadeMat, 'tunnelShade', true);
    const sm = root.children[root.children.length - 1] as Mesh;
    sm.receiveShadow = false;
  }

  // ---- buildings (walls with the facade / interior-mapping shader, roofs, trim + clutter)
  const groundAt = (x: number, z: number): number => sampler.heightAt(x, z);
  const facadeU: FacadeUniforms = { uWorldNight: { value: 0 } };
  const extraMats: Material[] = [];
  const extraTex: { dispose(): void }[] = [];
  let items: ItemsRenderer | null = null;
  if (content.render) {
    const R = content.render;
    const bt = buildingTextures(Math.min(8, maxAniso));
    extraTex.push(bt.walls.albedo, bt.walls.normal, bt.roofs.albedo, bt.roofs.normal);
    const bg = newBuildingGeos();
    for (const b of R.buildings) addBuilding(bg, b, groundAt);
    const attrs = buildingAttrs();
    const facade = createFacadeMaterial(bt.walls, facadeU);
    const roof = createRoofMaterial(bt.roofs);
    const trim = trimMaterial();
    for (const m of [facade, roof, trim]) {
      opts.patchMaterial(m, { csm: opts.lighting.csm });
      extraMats.push(m);
    }
    add(bg.walls, facade, 'walls', true, (g) => {
      g.setAttribute('aFac', new BufferAttribute(attrs.fac, 4));
      g.setAttribute('aTrim', new BufferAttribute(attrs.trim, 3));
    });
    add(bg.roofs, roof, 'roofs');
    add(bg.trim, trim, 'trim');
    // ---- sidewalks, kerbs, fences, decals, cables, signs
    const sg2 = { slab: new GeoBuilder(), kerb: new GeoBuilder(), fence: new GeoBuilder(true), metal: new GeoBuilder(true) };
    addStrips(sg2, R.strips, groundAt);
    add(sg2.slab, mats.paving, 'sidewalks', false);
    add(sg2.kerb, mats.concrete, 'kerbs', false);
    const fenceMat = new MeshStandardMaterial({ name: 'wc-fence', vertexColors: true, roughness: 0.8 });
    opts.patchMaterial(fenceMat, { csm: opts.lighting.csm });
    extraMats.push(fenceMat);
    add(sg2.fence, fenceMat, 'fences');
    const dg = new GeoBuilder(true);
    addDecals(dg, R.decals, groundAt);
    const dm = decalMaterial();
    opts.patchMaterial(dm.material, { csm: opts.lighting.csm });
    extraMats.push(dm.material);
    extraTex.push(dm.texture);
    add(dg, dm.material, 'decals', false);
    const pg = new GeoBuilder();
    if (addPuddles(pg, R.decals, groundAt) > 0) {
      const pm = puddleMaterial();
      opts.patchMaterial(pm.material, { csm: opts.lighting.csm });
      extraMats.push(pm.material);
      extraTex.push(pm.texture);
      add(pg, pm.material, 'puddles', false);
    }
    const cg = new GeoBuilder();
    addCables(cg, R.cables);
    const cableMat = new MeshStandardMaterial({ name: 'wc-cable', color: 0x15171a, roughness: 0.6 });
    opts.patchMaterial(cableMat, { csm: opts.lighting.csm });
    extraMats.push(cableMat);
    add(cg, cableMat, 'cables', false);
    const signs = buildSigns(R.buildings, boards);
    if (signs) {
      const sm = new MeshStandardMaterial({ name: 'wc-signs', map: signs.texture, roughness: 0.5, emissive: 0xffffff, emissiveMap: signs.texture, emissiveIntensity: 0.05 });
      opts.patchMaterial(sm, { csm: opts.lighting.csm });
      extraMats.push(sm);
      extraTex.push(signs.texture);
      add(signs.geo, sm, 'signs', false);
    }
    // ---- instanced street furniture / parked cars / poles / signal masts
    const im = {
      paint: new MeshStandardMaterial({ name: 'wc-item-paint', vertexColors: true, roughness: 0.45, metalness: 0.25 }),
      metal: new MeshStandardMaterial({ name: 'wc-item-metal', vertexColors: true, roughness: 0.55, metalness: 0.5 }),
      glass: new MeshStandardMaterial({ name: 'wc-item-glass', vertexColors: true, roughness: 0.08, metalness: 0.1 }),
      emissive: new MeshStandardMaterial({ name: 'wc-item-lamp', vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.4 }),
    };
    for (const m of Object.values(im)) {
      opts.patchMaterial(m, { csm: opts.lighting.csm });
      extraMats.push(m);
    }
    items = createItems(root, R.items, content.signals, im, groundAt);
  }

  const stats = { draws: root.children.length, triangles, buildMs: performance.now() - t0 };
  return {
    object: root,
    lights: content.lights,
    stats,
    update(camera: Camera, simTimeS: number) {
      items?.update(camera, simTimeS);
      const cp = camera.position;
      for (const m of areaMeshes) {
        const bs = m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere!);
        m.castShadow = Math.hypot(bs.center.x - cp.x, bs.center.z - cp.z) - bs.radius < SHADOW_CASTER_M;
      }
    },
    setQuality() {},
    dispose() {
      items?.dispose();
      for (const m of extraMats) m.dispose();
      for (const t of extraTex) t.dispose();
      root.traverse((o) => {
        if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose();
      });
      for (const m of mats.all) m.dispose();
      for (const t of mats.textures) t.dispose();
      root.removeFromParent();
    },
  };
}

/**
 * Render copy of the terrain with the tunnel covers applied (TerrainData.covers): heights are a
 * copy (the sampler, cameras and ribbons keep the carved ones); the cover splat is written into
 * the shared splat in place (render-only data on main).
 */
export function withTerrainCovers(t: TerrainData): TerrainData {
  const covers = t.covers ?? [];
  if (covers.length === 0) return t;
  const heights = new Float32Array(t.heights);
  for (const c of covers) {
    for (let r = 0; r < c.rows; r++) {
      for (let k = 0; k < c.cols; k++) {
        const h = c.heights[r * c.cols + k]!;
        if (Number.isNaN(h)) continue;
        const i = (c.row0 + r) * t.cols + c.col0 + k;
        heights[i] = h;
        for (let ch = 0; ch < 4; ch++) t.splat[i * 4 + ch] = c.splat[(r * c.cols + k) * 4 + ch]!;
      }
    }
  }
  return { ...t, heights };
}
