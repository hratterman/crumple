/**
 * Vegetation renderer (P5, U4). CONTRACT: ./types.ts (density/rank rule,
 * mesh ↔ impostor LOD, wind in color AND depth, grass, shadows per preset).
 *
 * Draws (main pass, max 13 ≤ VEG_DRAW_BUDGET):
 *   tree LOD0 × 6 (one InstancedBufferGeometry per conifer / broadleaf
 *   variant, full mesh) · tree LOD1 × 2 (all variants of a kind merged;
 *   the vertex stage collapses the other variants' vertices) · impostors × 1
 *   (every tree variant in one hemi-octahedral atlas) · shrubs × 1 (merged
 *   variants) · rocks near + far × 2 · grass × 1.
 * Shadows: one LOD1 caster mesh per tree kind (2 draws per casting cascade,
 * covering every mesh-range tree), rendered only inside the shadow pass and
 * only into cascades [0, vegetationShadowCascades).
 * LOD: tree LOD0 within lod0 = min(0.45 × vegetationNearM, 80 m), LOD1 to
 * the (mesh-cap-limited) near distance, impostors to vegetationFarM; every
 * boundary is a VEG_LOD_FADE_M dithered cross-fade evaluated per instance on
 * the GPU, so instance lists (64 m chunks, widened view cone) are rebuilt
 * only when the camera moves > 8 m or turns > 20° or the level changes.
 */
import {
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { BufferGeometry, Material, Object3D, PerspectiveCamera, WebGLRenderer } from 'three';

import { VEG_BOULDER_CENTER_LIFT, VEG_BOULDER_RADIUS_M, VegetationKind, type VegetationScatter } from '../../world/types';
import { LAYER_NO_REFLECTION, type LightingStack, type QualityPreset, type WorldFrame } from '../types';
import { buildNoiseTexture } from '../terrain/textures';
import { buildBroadleaf, buildConifer, buildRock, buildShrubs, MeshBuilder, type VegMeshData } from './geometry';
import { createMacroNoise, fillGrassTile, GRASS_STRIDE, GRASS_TILE_M, grassGeometry, grassPatch, type MacroNoise } from './grass';
import { bakeImpostors, impostorPatch, impostorQuad, type ImpostorAtlas } from './impostor';
import { createVegUniforms, vegPatch, type VegUniforms } from './shader';
import { createVegetationTextures } from './textures';
import { VEG_LOD_FADE_M, type CreateVegetationRenderer, type VegetationRenderer, type VegetationStats } from './types';

/** Rebuild instance lists after the camera moved this far (m) or turned this much (rad). */
const REBUILD_MOVE_M = 8;
const REBUILD_TURN = 0.35;
/** Distance slack on every list boundary (camera motion until the next rebuild). */
const MARGIN_M = REBUILD_MOVE_M + 1;
/** Extra half-angle of the culling cone beyond the camera's diagonal half-FOV (> REBUILD_TURN). */
const CONE_SLACK = 0.5;
const CHUNK_M = 64;
/** Rock near/far mesh switch and per-size cull (m per m of radius). */
const ROCK_LOD_M = 60;
const ROCK_CULL_PER_M = 210;
const SHRUB_CULL_PER_SCALE = 190;
const SMALL_CULL_MAX = 350;
/** Small-rock radius at scale 1 (boulders: VEG_BOULDER_RADIUS_M). */
const ROCK_RADIUS_M = 0.42;
const TREE_KINDS = 2;
const TREE_VARIANTS = 3;
const GRASS_CAP = 26000;

interface List {
  a: Float32Array;
  b: Float32Array;
  n: number;
  cap: number;
  geom: InstancedBufferGeometry;
  attrA: InstancedBufferAttribute;
  attrB: InstancedBufferAttribute;
  mesh: Mesh;
}

function baseGeometry(m: VegMeshData): BufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(m.position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(m.normal, 3));
  g.setAttribute('uv', new Float32BufferAttribute(m.uv, 2));
  g.setAttribute('veg', new Float32BufferAttribute(m.veg, 4));
  if (m.vvar) g.setAttribute('vvar', new Float32BufferAttribute(m.vvar, 1));
  g.setIndex(Array.from(m.index));
  return g;
}

function makeList(base: BufferGeometry, cap: number, material: Material, name: string): List {
  const geom = new InstancedBufferGeometry();
  for (const key of Object.keys(base.attributes)) geom.setAttribute(key, base.getAttribute(key));
  geom.setIndex(base.getIndex());
  const attrA = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  const attrB = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  attrA.setUsage(DynamicDrawUsage);
  attrB.setUsage(DynamicDrawUsage);
  geom.setAttribute('iA', attrA);
  geom.setAttribute('iB', attrB);
  geom.instanceCount = 0;
  const mesh = new Mesh(geom, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.visible = false;
  return { a: attrA.array as Float32Array, b: attrB.array as Float32Array, n: 0, cap, geom, attrA, attrB, mesh };
}

function commit(l: List): void {
  l.geom.instanceCount = l.n;
  l.mesh.visible = l.n > 0;
  if (l.n > 0) {
    for (const at of [l.attrA, l.attrB]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, l.n * 4);
      at.needsUpdate = true;
    }
  }
}

/** Instances binned into CHUNK_M chunks (CSR), one bin set per group. */
interface Bins {
  cols: number;
  start: Int32Array;
  items: Int32Array;
  cx: Float32Array;
  cz: Float32Array;
  y0: Float32Array;
  y1: Float32Array;
}
function binInstances(s: VegetationScatter, take: (k: number) => boolean, ox: number, oz: number, size: number): Bins {
  const cols = Math.ceil(size / CHUNK_M);
  const n = cols * cols;
  const count = new Int32Array(n + 1);
  const cell = new Int32Array(s.count).fill(-1);
  for (let i = 0; i < s.count; i++) {
    if (!take(s.kind[i]!)) continue;
    const c = Math.min(cols - 1, Math.max(0, Math.floor((s.x[i]! - ox) / CHUNK_M)));
    const r = Math.min(cols - 1, Math.max(0, Math.floor((s.z[i]! - oz) / CHUNK_M)));
    cell[i] = r * cols + c;
    count[r * cols + c + 1]!++;
  }
  for (let i = 1; i <= n; i++) count[i]! += count[i - 1]!;
  const fill = count.slice(0, n);
  const items = new Int32Array(count[n]!);
  const y0 = new Float32Array(n).fill(0);
  const y1 = new Float32Array(n).fill(0);
  const seen = new Uint8Array(n);
  for (let i = 0; i < s.count; i++) {
    const k = cell[i]!;
    if (k < 0) continue;
    items[fill[k]!++] = i;
    const y = s.y[i]!;
    if (!seen[k]) {
      seen[k] = 1;
      y0[k] = y;
      y1[k] = y + 25;
    } else {
      y0[k] = Math.min(y0[k]!, y);
      y1[k] = Math.max(y1[k]!, y + 25);
    }
  }
  const cx = new Float32Array(n);
  const cz = new Float32Array(n);
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      cx[r * cols + c] = ox + (c + 0.5) * CHUNK_M;
      cz[r * cols + c] = oz + (r + 0.5) * CHUNK_M;
    }
  }
  return { cols, start: count, items, cx, cz, y0, y1 };
}

interface Bands {
  lod0: number;
  near: number;
  far: number;
  smallFar: number;
}
/** Tree LOD0 radius, mesh (near) and impostor (far) distances, small-object cull for a preset. */
export function vegetationBands(q: QualityPreset): Bands {
  const near = q.vegetationNearM;
  return { lod0: Math.min(80, near * 0.45), near, far: q.vegetationFarM, smallFar: Math.min(q.vegetationFarM, SMALL_CULL_MAX) };
}

type VegStats = VegetationStats & {
  lod0: number;
  lod1: number;
  shrubs: number;
  rocks: number;
  casters: number;
  nearEff: number;
  rebuildMs: number;
  setupMs: number;
  bakeMs: number;
  textureMs: number;
  textureTimings: { cards: number; bark: number; normal: number };
};

export const createVegetationRenderer: CreateVegetationRenderer = (ctx, scatter, terrain, sampler, opts): VegetationRenderer => {
  const t0 = performance.now();
  const renderer: WebGLRenderer = ctx.renderer;
  const lighting: LightingStack = opts.lighting;
  const object = new Group();
  object.name = 'vegetation';
  const uniforms: VegUniforms = createVegUniforms();
  const tex = createVegetationTextures(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  // ------------------------------------------------------------ meshes
  const lod0: VegMeshData[] = [];
  for (let v = 0; v < TREE_VARIANTS; v++) lod0.push(buildConifer(v, 0).build(false));
  for (let v = 0; v < TREE_VARIANTS; v++) lod0.push(buildBroadleaf(v, 0).build(false));
  const mergedLod1 = (kind: number): VegMeshData => {
    const all = new MeshBuilder();
    for (let v = 0; v < TREE_VARIANTS; v++) {
      const b = kind === 0 ? buildConifer(v, 1) : buildBroadleaf(v, 1);
      b.vvar.fill(v);
      all.append(b);
    }
    return all.build(true);
  };
  const lod1 = [mergedLod1(0), mergedLod1(1)];
  const shrubData = buildShrubs(4).build(true);
  const rockNearData = buildRock(2).build(false);
  const rockFarData = buildRock(1).build(false);

  // ------------------------------------------------------------ impostor bake (from the LOD0 meshes)
  const atlas: ImpostorAtlas = bakeImpostors(renderer, lod0, tex.albedo, {
    frames: 8,
    framePx: ctx.quality.level === 'low' ? 64 : 96,
    cols: 3,
    rows: 2,
  });

  // ------------------------------------------------------------ materials
  const csm = lighting.csm;
  const off = (): { value: Vector4 } => ({ value: new Vector4(-2, -1, 1e5, 1e5 + 1) });
  const fadeLod0 = off();
  const fadeLod1 = off();
  const fadeImp = off();
  const fadeShrub = off();
  const fadeRockNear = { value: new Vector4(-2, -1, ROCK_LOD_M - 6, ROCK_LOD_M) };
  const fadeRockFar = { value: new Vector4(ROCK_LOD_M - 6, ROCK_LOD_M, 1e5, 1e5 + 1) };
  const foliage = (name: string): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ map: tex.albedo, normalMap: tex.normal, alphaTest: 0.5, side: DoubleSide, roughness: 0.8, metalness: 0 });
    m.name = name;
    return m;
  };
  type MatSet = { color: Material; depth: Material | null };
  const patched: MatSet[] = [];
  const patch = (m: MeshStandardMaterial, p: ReturnType<typeof vegPatch>, alphaDepth: boolean): MatSet => {
    const set = opts.patchMaterial(m, { csm, flexbody: p });
    if (set.depth && alphaDepth) {
      set.depth.map = tex.albedo;
      set.depth.alphaTest = 0.5;
      set.depth.side = DoubleSide;
    }
    const out = { color: set.color, depth: set.depth };
    patched.push(out);
    return out;
  };
  const treeMat0 = patch(foliage('veg-tree-lod0'), vegPatch({ kind: 'tree', variantSelect: false, fade: fadeLod0, bend: 0.4 }, uniforms), true);
  const treeMat1 = patch(foliage('veg-tree-lod1'), vegPatch({ kind: 'tree', variantSelect: true, fade: fadeLod1, bend: 0.4 }, uniforms), true);
  const shrubMat = patch(
    foliage('veg-shrub'),
    vegPatch({ kind: 'shrub', variantSelect: true, fade: fadeShrub, bend: 0.12, sizeCull: SHRUB_CULL_PER_SCALE }, uniforms),
    true,
  );
  const rockMaterial = (name: string): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ map: tex.rockAlbedo, roughness: 0.88, metalness: 0 });
    m.name = name;
    return m;
  };
  const rockMatNear = patch(rockMaterial('veg-rock-near'), vegPatch({ kind: 'rock', variantSelect: false, fade: fadeRockNear, bend: 0 }, uniforms), false);
  const rockMatFar = patch(
    rockMaterial('veg-rock-far'),
    vegPatch({ kind: 'rock', variantSelect: false, fade: fadeRockFar, bend: 0, sizeCull: ROCK_CULL_PER_M }, uniforms),
    false,
  );
  const impMat = new MeshStandardMaterial({ alphaTest: 0.42, roughness: 0.8, metalness: 0, side: DoubleSide });
  impMat.name = 'veg-impostor';
  const impSet = opts.patchMaterial(impMat, { csm, flexbody: impostorPatch(atlas, uniforms, fadeImp) });
  const grassR = { value: ctx.quality.grassRadiusM };
  const grassMat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: DoubleSide });
  grassMat.name = 'veg-grass';
  const grassSet = opts.patchMaterial(grassMat, { csm, flexbody: grassPatch(uniforms, grassR) });

  // ------------------------------------------------------------ instance lists
  const kindCount = new Int32Array(8);
  const varCount = new Int32Array(TREE_KINDS * TREE_VARIANTS);
  for (let i = 0; i < scatter.count; i++) {
    const k = scatter.kind[i]!;
    kindCount[k]!++;
    if (k <= 1) varCount[k * TREE_VARIANTS + Math.min(TREE_VARIANTS - 1, scatter.variant[i]!)]!++;
  }
  const trees = kindCount[0]! + kindCount[1]!;
  const rocksTotal = kindCount[3]! + kindCount[4]!;
  const lod0Bases = lod0.map(baseGeometry);
  const lod0Lists: List[] = lod0Bases.map((g, k) => {
    const l = makeList(g, Math.max(1, Math.min(varCount[k]!, 3200)), treeMat0.color, `veg-lod0-${k}`);
    l.mesh.customDepthMaterial = treeMat0.depth ?? undefined;
    return l;
  });
  const lod1Bases = lod1.map(baseGeometry);
  const lod1Lists = [0, 1].map((k) => makeList(lod1Bases[k]!, Math.max(1, Math.min(kindCount[k]!, 6000)), treeMat1.color, `veg-lod1-${k}`));
  const casterLists = [0, 1].map((k) => {
    const l = makeList(lod1Bases[k]!, Math.max(1, Math.min(kindCount[k]!, 6000)), treeMat1.color, `veg-caster-${k}`);
    l.mesh.castShadow = true;
    l.mesh.receiveShadow = false;
    l.mesh.customDepthMaterial = treeMat1.depth ?? undefined;
    return l;
  });
  const impList = makeList(impostorQuad(), Math.max(1, trees), impSet.color, 'veg-impostors');
  const shrubList = makeList(baseGeometry(shrubData), Math.max(1, kindCount[2]!), shrubMat.color, 'veg-shrubs');
  const rockNearList = makeList(baseGeometry(rockNearData), Math.max(1, Math.min(rocksTotal, 4000)), rockMatNear.color, 'veg-rocks-near');
  const rockFarList = makeList(baseGeometry(rockFarData), Math.max(1, rocksTotal), rockMatFar.color, 'veg-rocks-far');
  const mainLists = [...lod0Lists, ...lod1Lists, impList, shrubList, rockNearList, rockFarList];
  const allLists = [...mainLists, ...casterLists];
  for (const l of mainLists) object.add(l.mesh);
  const casterRoot = new Group();
  casterRoot.name = 'veg-casters';
  casterRoot.visible = false;
  for (const l of casterLists) casterRoot.add(l.mesh);
  object.add(casterRoot);

  const grass = grassGeometry(GRASS_CAP);
  const grassMesh = new Mesh(grass.geometry, grassSet.color);
  grassMesh.name = 'veg-grass';
  grassMesh.frustumCulled = false;
  grassMesh.receiveShadow = true;
  grassMesh.visible = false;
  grassMesh.layers.set(LAYER_NO_REFLECTION);
  object.add(grassMesh);
  let macro: MacroNoise | null = null;
  {
    const nt = buildNoiseTexture(terrain.seed);
    macro = createMacroNoise(nt.image.data as Uint8Array, nt.image.width);
    nt.dispose();
  }

  // ------------------------------------------------------------ per-instance render data
  const N = scatter.count;
  const cosY = new Float32Array(N);
  const sinY = new Float32Array(N);
  const seed = new Float32Array(N);
  const radius = new Float32Array(N);
  const cy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    cosY[i] = Math.cos(scatter.yaw[i]!);
    sinY[i] = Math.sin(scatter.yaw[i]!);
    const h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
    seed[i] = ((h ^ (h >>> 15)) >>> 0) / 4294967296;
    const k = scatter.kind[i]!;
    if (k === VegetationKind.boulder) {
      radius[i] = VEG_BOULDER_RADIUS_M * scatter.scale[i]!;
      cy[i] = scatter.y[i]! + VEG_BOULDER_CENTER_LIFT * radius[i]!;
    } else if (k === VegetationKind.rock) {
      radius[i] = ROCK_RADIUS_M * scatter.scale[i]!;
      cy[i] = scatter.y[i]! + 0.15 * radius[i]!;
    }
  }
  const size = (terrain.cols - 1) * terrain.spacing;
  const treeBins = binInstances(scatter, (k) => k <= 1, terrain.originX, terrain.originZ, size);
  const smallBins = binInstances(scatter, (k) => k >= 2, terrain.originX, terrain.originZ, size);
  const eligible = new Uint8Array(N);
  let eligibleCount = 0;
  const setEligible = (density: number): void => {
    eligibleCount = 0;
    for (let i = 0; i < N; i++) {
      const e = scatter.rank[i]! < density || scatter.collider[i]! >= 0 ? 1 : 0;
      eligible[i] = e;
      eligibleCount += e;
    }
  };

  // ------------------------------------------------------------ state
  let q: QualityPreset = ctx.quality;
  let bands = vegetationBands(q);
  let castCascades = q.vegetationShadowCascades;
  const lastPos = new Vector3(1e9, 0, 0);
  const lastFwd = new Vector3(0, 0, 1);
  const fwd = new Vector3();
  let dirty = true;
  const dist = new Float32Array(N);
  const visTree = new Int32Array(Math.max(1, kindCount[0]! + kindCount[1]!));
  const hist = new Int32Array(256);
  const stats: VegStats = {
    eligible: 0,
    meshInstances: 0,
    impostors: 0,
    grassTufts: 0,
    drawCalls: 0,
    lod0: 0,
    lod1: 0,
    shrubs: 0,
    rocks: 0,
    casters: 0,
    nearEff: bands.near,
    rebuildMs: 0,
    setupMs: 0,
    bakeMs: atlas.ms,
    textureMs: tex.ms,
    textureTimings: tex.timings,
  };

  const pushTree = (l: List, i: number, variantId: number): void => {
    if (l.n >= l.cap) return;
    const o = l.n * 4;
    l.a[o] = scatter.x[i]!;
    l.a[o + 1] = scatter.y[i]!;
    l.a[o + 2] = scatter.z[i]!;
    l.a[o + 3] = scatter.scale[i]!;
    l.b[o] = cosY[i]!;
    l.b[o + 1] = sinY[i]!;
    l.b[o + 2] = variantId;
    l.b[o + 3] = seed[i]!;
    l.n++;
  };
  const pushRock = (l: List, i: number): void => {
    if (l.n >= l.cap) return;
    const o = l.n * 4;
    l.a[o] = scatter.x[i]!;
    l.a[o + 1] = cy[i]!;
    l.a[o + 2] = scatter.z[i]!;
    l.a[o + 3] = radius[i]!;
    l.b[o] = cosY[i]!;
    l.b[o + 1] = sinY[i]!;
    l.b[o + 2] = 0;
    l.b[o + 3] = seed[i]!;
    l.n++;
  };

  /** Chunk within `range` and inside the widened view cone (half-angle with cos = cosBase). */
  const chunkVisible = (b: Bins, k: number, cam: Vector3, cosBase: number, sinBase: number, range: number): boolean => {
    const dx = b.cx[k]! - cam.x;
    const dy = (b.y0[k]! + b.y1[k]!) * 0.5 - cam.y;
    const dz = b.cz[k]! - cam.z;
    const r = CHUNK_M * 0.75 + (b.y1[k]! - b.y0[k]!) * 0.5;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d - r > range) return false;
    if (d < r + 12) return true;
    const cosA = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
    const s = r / d;
    const c = Math.sqrt(1 - s * s);
    return cosA >= cosBase * c - sinBase * s;
  };

  const rebuild = (camera: PerspectiveCamera): void => {
    const tStart = performance.now();
    const cam = camera.position;
    camera.getWorldDirection(fwd);
    const vfov = (camera.fov * Math.PI) / 180;
    const halfDiag = Math.atan(Math.tan(vfov / 2) * Math.sqrt(1 + camera.aspect * camera.aspect));
    const cone = Math.min(Math.PI, halfDiag + CONE_SLACK);
    const cosBase = Math.cos(cone);
    const sinBase = Math.sin(cone);
    const F = VEG_LOD_FADE_M;
    const M = MARGIN_M;
    for (const l of allLists) l.n = 0;

    // ---- trees: distances + mesh cap (nearest first via a 1 m histogram) ----
    hist.fill(0);
    let nVis = 0;
    const tb = treeBins;
    for (let k = 0; k < tb.cols * tb.cols; k++) {
      if (tb.start[k] === tb.start[k + 1]) continue;
      if (!chunkVisible(tb, k, cam, cosBase, sinBase, bands.far + M)) continue;
      for (let j = tb.start[k]!; j < tb.start[k + 1]!; j++) {
        const i = tb.items[j]!;
        if (!eligible[i]) continue;
        const dx = scatter.x[i]! - cam.x;
        const dy = scatter.y[i]! - cam.y;
        const dz = scatter.z[i]! - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > bands.far + M) continue;
        dist[i] = d;
        visTree[nVis++] = i;
        if (d < bands.near + M) hist[Math.min(255, Math.floor(d))]!++;
      }
    }
    let nearEff = bands.near;
    for (let b = 0, acc = 0; b < 256; b++) {
      acc += hist[b]!;
      if (acc > q.vegetationMeshCap) {
        nearEff = Math.max(Math.min(bands.lod0, 30) + F, Math.min(bands.near, b));
        break;
      }
    }
    const r0 = Math.min(bands.lod0, nearEff - F);
    let castMax = 0;
    if (castCascades > 0) {
      if (csm) {
        const far = Math.min(camera.far, csm.maxFar);
        const br = csm.breaks;
        const idx = Math.min(br.length, castCascades) - 1;
        castMax = idx >= 0 ? (br[idx]! + 0.125 * br[idx]! * br[idx]!) * far : 0;
      } else {
        castMax = q.csmFar;
      }
    }
    for (let j = 0; j < nVis; j++) {
      const i = visTree[j]!;
      const d = dist[i]!;
      const kind = scatter.kind[i]!;
      const v = Math.min(TREE_VARIANTS - 1, scatter.variant[i]!);
      if (d < r0 + M) pushTree(lod0Lists[kind * TREE_VARIANTS + v]!, i, v);
      if (d > r0 - F - M && d < nearEff + M) pushTree(lod1Lists[kind]!, i, v);
      if (d < nearEff + M && d < castMax + M) pushTree(casterLists[kind]!, i, v);
      if (d > nearEff - F - M) pushTree(impList, i, kind * TREE_VARIANTS + v);
    }

    // ---- shrubs / rocks / boulders ----
    const sb = smallBins;
    for (let k = 0; k < sb.cols * sb.cols; k++) {
      if (sb.start[k] === sb.start[k + 1]) continue;
      if (!chunkVisible(sb, k, cam, cosBase, sinBase, bands.smallFar + M)) continue;
      for (let j = sb.start[k]!; j < sb.start[k + 1]!; j++) {
        const i = sb.items[j]!;
        if (!eligible[i]) continue;
        const kind = scatter.kind[i]!;
        const dx = scatter.x[i]! - cam.x;
        const dy = scatter.y[i]! - cam.y;
        const dz = scatter.z[i]! - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (kind === VegetationKind.shrub) {
          if (d < Math.min(bands.smallFar, SHRUB_CULL_PER_SCALE * scatter.scale[i]!) + M) pushTree(shrubList, i, scatter.variant[i]!);
        } else {
          const cull = Math.min(bands.smallFar, ROCK_CULL_PER_M * radius[i]!);
          if (d < ROCK_LOD_M + M) pushRock(rockNearList, i);
          if (d > ROCK_LOD_M - 6 - M && d < cull + M) pushRock(rockFarList, i);
        }
      }
    }

    // ---- bands → uniforms ----
    fadeLod0.value.set(-2, -1, r0 - F, r0);
    fadeLod1.value.set(r0 - F, r0, nearEff - F, nearEff);
    fadeImp.value.set(nearEff - F, nearEff, bands.far * 0.78, bands.far);
    fadeShrub.value.set(-2, -1, 0, bands.smallFar);
    fadeRockFar.value.set(ROCK_LOD_M - 6, ROCK_LOD_M, 0, bands.smallFar);
    for (const l of allLists) commit(l);
    for (const l of casterLists) l.mesh.visible = l.n > 0; // the casterRoot gate keeps them out of the main pass

    stats.lod0 = lod0Lists.reduce((s, l) => s + l.n, 0);
    stats.lod1 = lod1Lists.reduce((s, l) => s + l.n, 0);
    stats.casters = casterLists.reduce((s, l) => s + l.n, 0);
    stats.shrubs = shrubList.n;
    stats.rocks = rockNearList.n + rockFarList.n;
    stats.impostors = impList.n;
    stats.meshInstances = stats.lod0 + stats.lod1 + stats.shrubs + stats.rocks;
    stats.nearEff = nearEff;
    stats.rebuildMs = performance.now() - tStart;
    lastPos.copy(cam);
    lastFwd.copy(fwd);
    dirty = false;
  };

  // ------------------------------------------------------------ grass tiles
  const tileCache = new Map<number, Float32Array>();
  const tileKey = (tx: number, tz: number): number => (tx + 4096) * 8192 + (tz + 4096);
  const grassLast = new Vector3(1e9, 0, 0);
  const grassFwd = new Vector3(0, 0, 1);
  let grassDirty = true;
  const used = new Set<number>();
  const tiles: { tx: number; tz: number; d: number }[] = [];
  const updateGrass = (camera: PerspectiveCamera): void => {
    const R = q.grassRadiusM;
    grassR.value = R;
    if (R <= 0) {
      grassMesh.visible = false;
      stats.grassTufts = 0;
      return;
    }
    const cam = camera.position;
    camera.getWorldDirection(fwd);
    const moved = Math.hypot(cam.x - grassLast.x, cam.z - grassLast.z);
    if (!grassDirty && moved < 2 && fwd.dot(grassFwd) > Math.cos(0.22) && Math.abs(cam.y - grassLast.y) < 4) return;
    grassDirty = false;
    grassLast.copy(cam);
    grassFwd.copy(fwd);
    const ground = sampler.heightAt(cam.x, cam.z);
    if (cam.y - ground > R) {
      grassMesh.visible = false;
      stats.grassTufts = 0;
      return;
    }
    const vfov = (camera.fov * Math.PI) / 180;
    const halfDiag = Math.atan(Math.tan(vfov / 2) * Math.sqrt(1 + camera.aspect * camera.aspect));
    const cone = Math.min(Math.PI, halfDiag + 0.45);
    const cosLim = Math.cos(cone);
    const sinLim = Math.sin(cone);
    const t0x = Math.floor((cam.x - R) / GRASS_TILE_M);
    const t1x = Math.floor((cam.x + R) / GRASS_TILE_M);
    const t0z = Math.floor((cam.z - R) / GRASS_TILE_M);
    const t1z = Math.floor((cam.z + R) / GRASS_TILE_M);
    const a = grass.iA.array as Float32Array;
    const b = grass.iB.array as Float32Array;
    let n = 0;
    used.clear();
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fl;
    const fz = fwd.z / fl;
    const tr = GRASS_TILE_M * 0.71;
    // Candidate tiles (view cone), nearest first so the cap never drops near grass.
    tiles.length = 0;
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const cx = (tx + 0.5) * GRASS_TILE_M - cam.x;
        const cz = (tz + 0.5) * GRASS_TILE_M - cam.z;
        const d = Math.hypot(cx, cz);
        if (d - tr > R) continue;
        if (d > tr * 2 && fwd.y > -0.85) {
          const c = (cx * fx + cz * fz) / d;
          const s = tr / d;
          if (c < cosLim * Math.sqrt(1 - s * s) - sinLim * s) continue;
        }
        tiles.push({ tx, tz, d });
      }
    }
    tiles.sort((p, q2) => p.d - q2.d);
    for (const { tx, tz } of tiles) {
      const key = tileKey(tx, tz);
      used.add(key);
      let tile = tileCache.get(key);
      if (!tile) {
        tile = fillGrassTile(tx, tz, sampler, terrain.waterLevel, macro);
        tileCache.set(key, tile);
      }
      const m = tile.length / GRASS_STRIDE;
      for (let j = 0; j < m && n < GRASS_CAP; j++) {
        const o = j * GRASS_STRIDE;
        const p = n * 4;
        a[p] = tile[o]!;
        a[p + 1] = tile[o + 1]!;
        a[p + 2] = tile[o + 2]!;
        a[p + 3] = tile[o + 3]!;
        b[p] = tile[o + 4]!;
        b[p + 1] = tile[o + 5]!;
        b[p + 2] = tile[o + 6]!;
        b[p + 3] = tile[o + 7]!;
        n++;
      }
    }
    if (tileCache.size > used.size * 3 + 64) {
      for (const k of tileCache.keys()) if (!used.has(k)) tileCache.delete(k);
    }
    grass.geometry.instanceCount = n;
    for (const at of [grass.iA, grass.iB]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 4);
      at.needsUpdate = true;
    }
    grassMesh.visible = n > 0;
    stats.grassTufts = n;
  };

  // ------------------------------------------------------------ shadow-pass gating of the caster meshes
  // The main pass builds its render list before shadow maps render, so the casters (hidden outside
  // shadowMap.render) never draw there; per cascade, each light's updateMatrices (called right before
  // its casters render) opens the gate only for cascades < vegetationShadowCascades.
  let inShadow = false;
  const wrapped = new WeakSet<object>();
  const shadowMap = renderer.shadowMap;
  const origShadowRender = shadowMap.render;
  const shadowRender = function (this: unknown, ...args: Parameters<typeof origShadowRender>): void {
    inShadow = true;
    casterRoot.visible = castCascades > 0;
    try {
      origShadowRender.apply(this, args);
    } finally {
      inShadow = false;
      casterRoot.visible = false;
    }
  };
  shadowMap.render = shadowRender;
  const wrapShadows = (): void => {
    const lights = csm ? csm.lights : [lighting.sun];
    for (let i = 0; i < lights.length; i++) {
      const shadow = lights[i]!.shadow;
      if (wrapped.has(shadow)) continue;
      wrapped.add(shadow);
      const origUpdate = shadow.updateMatrices;
      const idx = i;
      shadow.updateMatrices = function (this: unknown, light) {
        if (inShadow) casterRoot.visible = idx < castCascades;
        return origUpdate.call(this, light);
      };
    }
  };

  // ------------------------------------------------------------ public
  const applyQuality = (nq: QualityPreset): void => {
    q = nq;
    bands = vegetationBands(q);
    castCascades = q.vegetationShadowCascades;
    setEligible(q.vegetationDensity);
    stats.eligible = eligibleCount;
    grassR.value = q.grassRadiusM;
    dirty = true;
    grassDirty = true;
  };
  applyQuality(ctx.quality);
  stats.setupMs = performance.now() - t0;

  const r: VegetationRenderer & { scatter: VegetationScatter; atlas: ImpostorAtlas; textures: typeof tex; meshes: Object3D[] } = {
    object,
    stats,
    scatter,
    atlas,
    textures: tex,
    meshes: [...mainLists.map((l) => l.mesh), grassMesh, ...casterLists.map((l) => l.mesh)],
    update(frame: WorldFrame) {
      const camera = frame.camera;
      const t = frame.time;
      // Wind: slowly veering direction, breathing strength.
      const ang = 0.7 + 0.35 * Math.sin(t * 0.021) + 0.1 * Math.sin(t * 0.13);
      uniforms.uVegWind.value.set(Math.cos(ang), Math.sin(ang), 0.42 + 0.14 * Math.sin(t * 0.09) + 0.08 * Math.sin(t * 0.31 + 1), t);
      uniforms.uVegSun.value.copy(lighting.sunDirection);
      const sun = lighting.sun;
      uniforms.uVegSunCol.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
      wrapShadows();
      camera.getWorldDirection(fwd);
      if (dirty || camera.position.distanceTo(lastPos) > REBUILD_MOVE_M || fwd.dot(lastFwd) < Math.cos(REBUILD_TURN)) rebuild(camera);
      updateGrass(camera);
      let draws = grassMesh.visible ? 1 : 0;
      for (const l of mainLists) if (l.mesh.visible) draws++;
      stats.drawCalls = draws;
    },
    setQuality(nq: QualityPreset) {
      applyQuality(nq);
    },
    dispose() {
      if (shadowMap.render === shadowRender) shadowMap.render = origShadowRender;
      for (const l of allLists) l.geom.dispose();
      for (const g of [...lod0Bases, ...lod1Bases]) g.dispose();
      grass.geometry.dispose();
      for (const s of patched) {
        s.color.dispose();
        s.depth?.dispose();
      }
      impSet.color.dispose();
      grassSet.color.dispose();
      atlas.dispose();
      tex.dispose();
      object.removeFromParent();
    },
  };
  return r;
};
