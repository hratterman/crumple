/**
 * createTerrainRenderer (B, FROZEN signature in src/render/types.ts).
 *
 * 22 × 22 chunk meshes (one Mesh each, geometry swapped per LOD). LOD k is
 * chosen from the 3-D distance camera → chunk AABB against
 * TERRAIN_LOD_DISTANCES × terrainLodBias; the vertex shader geomorphs with
 * the same ranges so a switch is invisible (chunks.ts). Geometry is built
 * on demand from a priority queue under a per-frame time budget (default
 * 3 ms), nearest/in-view first; every chunk always holds its LOD 3 mesh
 * (built up front, ~5 ms total) so nothing is ever missing while finer
 * LODs stream in. Cached LODs not needed for 8 s are evicted.
 */
import { Box3, Frustum, Vector2, Group, Matrix4, Mesh, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, Vector3 } from 'three';
import type { BufferGeometry, Camera, Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';

import { TERRAIN_CHUNK_CELLS } from '../../world/types';
import type { TerrainData } from '../../world/types';
import { TERRAIN_LOD_DISTANCES, TERRAIN_TILE_M } from '../types';
import type {
  QualityPreset,
  RenderContext,
  TerrainMaterialSet,
  TerrainRenderer,
  TerrainRendererOptions,
} from '../types';
import {
  buildChunkLod,
  ChunkBuild,
  chunkHeightRange,
  chunkSkirtDepth,
  lodTriangles,
  makeChunkGeometry,
  mergeChunkGeometries,
  TERRAIN_LOD_COUNT,
} from './chunks';
import {
  applyTerrainColorPatch,
  applyTerrainDepthPatch,
  createTerrainUniforms,
  TERRAIN_LITE_DEFINE,
  TERRAIN_SHADER_KEY,
  terrainLite,
} from './shader';
import type { TerrainUniforms } from './shader';
import {
  buildConcreteTexture,
  buildNoiseTexture,
  buildNormalTexture,
  buildSplatTexture,
  buildTerrainArrays,
  takePrebuiltTerrainArrays,
  TERRAIN_LAYERS,
  terrainTextureSize,
} from './textures';

/** Anisotropy of the terrain arrays: off on the lite (low) path — it multiplies every terrain fetch. */
export function terrainAnisotropy(level: string, maxAnisotropy: number): number {
  return terrainLite(level) ? 1 : Math.min(8, maxAnisotropy);
}

/** Morph band as a fraction of each LOD range: [start, end]. End < 1 so morph completes before the switch. */
const MORPH_START = 0.62;
const MORPH_END = 0.96;
/** Prefetch a finer LOD this far (fraction) beyond its switch distance. */
const PREFETCH = 1.18;
const EVICT_AFTER_S = 8;
/**
 * Far-field batching (P5 draw budget): blocks of SUPER_CHUNK × SUPER_CHUNK
 * chunks whose members all draw LOD 3 draw as one pre-merged mesh (the
 * summit / lakeshore views had 140–210 LOD-3 chunk draws).
 */
export const SUPER_CHUNK = 4;

/**
 * Per-layer look. `mean` is the target mean albedo (linear) the texture is
 * re-levelled to; the ambientCG sets range from near-black (Rock035) to
 * near-white (Gravel023), so raw they never sit together.
 */
interface LayerLook {
  mean: [number, number, number];
  contrast: number;
  sat: number;
  normal: number;
  /** Roughness remap [min, max] of the texture's 0..1 (the ambientCG maps read glossy at grazing sun). */
  rough: [number, number];
  /** Macro variation multipliers at noise 0 / 1. */
  macroA: [number, number, number];
  macroB: [number, number, number];
}
const LOOK: Readonly<Record<string, LayerLook>> = {
  asphalt: { mean: [0.045, 0.045, 0.043], contrast: 0.9, sat: 0.5, normal: 0.9, rough: [0.62, 0.98], macroA: [0.88, 0.88, 0.88], macroB: [1.12, 1.1, 1.06] },
  dirt: { mean: [0.12, 0.092, 0.064], contrast: 1.3, sat: 0.7, normal: 1.25, rough: [0.7, 1.0], macroA: [1.1, 0.98, 0.85], macroB: [0.88, 0.9, 0.92] },
  rock: { mean: [0.085, 0.076, 0.066], contrast: 0.85, sat: 0.35, normal: 1.15, rough: [0.55, 0.95], macroA: [1.12, 1.02, 0.92], macroB: [0.8, 0.82, 0.86] },
  gravel: { mean: [0.14, 0.126, 0.108], contrast: 0.9, sat: 0.5, normal: 1.0, rough: [0.62, 0.98], macroA: [1.06, 1.0, 0.92], macroB: [0.85, 0.85, 0.86] },
  grass: { mean: [0.085, 0.105, 0.035], contrast: 1.0, sat: 1.0, normal: 0.9, rough: [0.68, 1.0], macroA: [1.2, 1.02, 0.7], macroB: [0.8, 1.0, 0.85] },
};

interface Chunk {
  cx: number;
  cz: number;
  box: Box3;
  mesh: Mesh;
  geoms: (BufferGeometry | null)[];
  lastUsed: Float64Array;
  lod: number;
  want: number;
  dist: number;
  inView: boolean;
  skirt: number;
}

export interface TerrainRendererExt extends TerrainRenderer {
  readonly stats: {
    chunks: number;
    visibleChunks: number;
    triangles: number;
    /** Chunk-LOD builds waiting in the queue. */
    pending: number;
    /** Worst single-frame build time, ms (since the last resetPeak). */
    peakBuildMs: number;
    lastBuildMs: number;
    /** Visible chunks per LOD. */
    lodCounts: number[];
    textureMs: number;
    planMs: number;
    finishMs: number;
  };
  /** Build everything the camera needs right now (loading screens / tests), ignoring the frame budget. */
  prime(camera: Camera): void;
  /** Per-frame streaming budget, ms. */
  buildBudgetMs: number;
  resetPeak(): void;
  readonly uniforms: TerrainUniforms;
}

export function createTerrainRenderer(
  ctx: RenderContext,
  terrain: TerrainData,
  materials: TerrainMaterialSet,
  opts: TerrainRendererOptions,
): TerrainRendererExt {
  const renderer: WebGLRenderer = ctx.renderer;
  const chunksX = (terrain.cols - 1) / TERRAIN_CHUNK_CELLS;
  const chunksZ = (terrain.rows - 1) / TERRAIN_CHUNK_CELLS;
  if (!Number.isInteger(chunksX) || !Number.isInteger(chunksZ)) {
    throw new RangeError(`terrain grid ${terrain.cols}×${terrain.rows} is not chunk-aligned (${TERRAIN_CHUNK_CELLS})`);
  }

  // ------------------------------------------------------------ textures
  const level = ctx.quality.level;
  const texSize = terrainTextureSize(level);
  const aniso = terrainAnisotropy(level, renderer.capabilities.getMaxAnisotropy());
  const arrays = takePrebuiltTerrainArrays(materials, texSize, aniso) ?? buildTerrainArrays(materials, texSize, aniso);
  const splatTex = buildSplatTexture(terrain);
  const normalTex = buildNormalTexture(terrain);
  const concreteTex = buildConcreteTexture(terrain);
  const noiseTex = buildNoiseTexture(terrain.seed);

  const uniforms = createTerrainUniforms();
  uniforms.uTGrid!.value.set(
    terrain.originX - 0.5 * terrain.spacing,
    terrain.originZ - 0.5 * terrain.spacing,
    1 / (terrain.cols * terrain.spacing),
    1 / (terrain.rows * terrain.spacing),
  );
  uniforms.tTNormal!.value = normalTex;
  uniforms.tTSplat!.value = splatTex;
  uniforms.tTConcrete!.value = concreteTex;
  uniforms.tTNoise!.value = noiseTex;
  uniforms.tTAlbedo!.value = arrays.albedo;
  uniforms.tTSurface!.value = arrays.surface;
  uniforms.uTWater!.value.x = terrain.waterLevel;
  TERRAIN_LAYERS.forEach((slug, l) => {
    const look = LOOK[slug]!;
    (uniforms.uTTileInv!.value as number[])[l] = 1 / TERRAIN_TILE_M[slug];
    (uniforms.uTNormalStr!.value as number[])[l] = look.normal;
    (uniforms.uTSat!.value as number[])[l] = look.sat;
    (uniforms.uTRough!.value as Vector2[])[l]!.set(...look.rough);
    (uniforms.uTTint!.value as Vector3[])[l]!.set(...look.mean);
    (uniforms.uTContrast!.value as number[])[l] = look.contrast;
    (uniforms.uTMacroA!.value as Vector3[])[l]!.set(...look.macroA);
    (uniforms.uTMacroB!.value as Vector3[])[l]!.set(...look.macroB);
    (uniforms.uTMean!.value as Vector3[])[l]!.set(
      arrays.meanAlbedo[l * 3]!,
      arrays.meanAlbedo[l * 3 + 1]!,
      arrays.meanAlbedo[l * 3 + 2]!,
    );
  });

  // ------------------------------------------------------------ materials
  const base = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  base.name = 'terrain';
  const patched = opts.patchMaterial(base, { csm: opts.lighting.csm });
  const color = patched.color;
  installTerrainHook(color, (shader) => applyTerrainColorPatch(shader, uniforms));

  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.name = 'terrain-depth';
  depth.onBeforeCompile = (shader) => applyTerrainDepthPatch(shader, uniforms);
  depth.customProgramCacheKey = () => `${TERRAIN_SHADER_KEY}-depth`;

  // ------------------------------------------------------------ chunks
  const object = new Group();
  object.name = 'terrain';
  object.matrixAutoUpdate = false;
  const chunks: Chunk[] = [];
  const size = TERRAIN_CHUNK_CELLS * terrain.spacing;
  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const [lo, hi] = chunkHeightRange(terrain, cx, cz);
      const x0 = terrain.originX + cx * TERRAIN_CHUNK_CELLS * terrain.spacing;
      const z0 = terrain.originZ + cz * TERRAIN_CHUNK_CELLS * terrain.spacing;
      const box = new Box3(new Vector3(x0, lo, z0), new Vector3(x0 + size, hi, z0 + size));
      const geoms: (BufferGeometry | null)[] = new Array<BufferGeometry | null>(TERRAIN_LOD_COUNT).fill(null);
      const coarsest = TERRAIN_LOD_COUNT - 1;
      const skirt = chunkSkirtDepth(terrain, cx, cz);
      geoms[coarsest] = makeChunkGeometry(buildChunkLod(terrain, cx, cz, coarsest, skirt), coarsest, box);
      const mesh = new Mesh(geoms[coarsest]!, color);
      mesh.name = `terrain-${cx}-${cz}`;
      mesh.matrixAutoUpdate = false;
      mesh.customDepthMaterial = depth;
      if (patched.distance) mesh.customDistanceMaterial = patched.distance;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      object.add(mesh);
      chunks.push({
        cx,
        cz,
        box,
        mesh,
        geoms,
        lastUsed: new Float64Array(TERRAIN_LOD_COUNT),
        lod: coarsest,
        want: coarsest,
        dist: 0,
        inView: true,
        skirt,
      });
    }
  }
  // Far-field super-chunks: pre-merged LOD-3 geometry per SUPER_CHUNK² block (LOD 3 never evicts).
  const coarsestLod = TERRAIN_LOD_COUNT - 1;
  const supers: { mesh: Mesh; members: Chunk[] }[] = [];
  for (let sz = 0; sz < chunksZ; sz += SUPER_CHUNK) {
    for (let sx = 0; sx < chunksX; sx += SUPER_CHUNK) {
      const members = chunks.filter((c) => c.cx >= sx && c.cx < sx + SUPER_CHUNK && c.cz >= sz && c.cz < sz + SUPER_CHUNK);
      if (members.length < 2) continue;
      const mesh = new Mesh(mergeChunkGeometries(members.map((c) => c.geoms[coarsestLod]!)), color);
      mesh.name = `terrain-far-${sx}-${sz}`;
      mesh.matrixAutoUpdate = false;
      mesh.customDepthMaterial = depth;
      if (patched.distance) mesh.customDistanceMaterial = patched.distance;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.visible = false;
      object.add(mesh);
      supers.push({ mesh, members });
    }
  }
  object.updateMatrixWorld(true);

  // ------------------------------------------------------------ quality
  const ranges = new Float64Array(TERRAIN_LOD_COUNT);
  let csmFar = ctx.quality.csmFar;
  const applyQuality = (q: QualityPreset): void => {
    csmFar = q.csmFar;
    const lite = terrainLite(q.level);
    const defines = (color.defines ??= {});
    if (lite !== (TERRAIN_LITE_DEFINE in defines)) {
      if (lite) defines[TERRAIN_LITE_DEFINE] = '';
      else delete defines[TERRAIN_LITE_DEFINE];
      color.needsUpdate = true;
    }
    const morph = uniforms.uTMorph!.value as { set(x: number, y: number): void }[];
    for (let k = 0; k < TERRAIN_LOD_COUNT; k++) {
      const r = k < TERRAIN_LOD_DISTANCES.length ? TERRAIN_LOD_DISTANCES[k]! * q.terrainLodBias : Infinity;
      ranges[k] = r;
      if (Number.isFinite(r)) morph[k]!.set(r * MORPH_START, r * MORPH_END);
      else morph[k]!.set(1e9, 2e9);
    }
  };
  applyQuality(ctx.quality);

  // ------------------------------------------------------------ streaming
  const frustum = new Frustum();
  const projView = new Matrix4();
  const camPos = new Vector3();
  const queue: { chunk: Chunk; lod: number; prio: number; build: ChunkBuild | null }[] = [];
  const queued = new Set<number>();
  const keyOf = (c: Chunk, lod: number): number => ((c.cz * chunksX + c.cx) << 2) | lod;
  const now = (): number => performance.now();

  const stats = {
    chunks: chunks.length,
    visibleChunks: 0,
    triangles: 0,
    pending: 0,
    peakBuildMs: 0,
    lastBuildMs: 0,
    lodCounts: [0, 0, 0, 0],
    textureMs: arrays.buildMs,
    planMs: 0,
    finishMs: 0,
    /** Far-field super-chunks drawn (each replacing SUPER_CHUNK² LOD-3 chunk draws). */
    superChunks: 0,
  };

  const lodFor = (dist: number, scale: number): number => {
    for (let k = 0; k < TERRAIN_LOD_COUNT - 1; k++) if (dist < ranges[k]! * scale) return k;
    return TERRAIN_LOD_COUNT - 1;
  };

  /** Grid rows per build slice (~1–2k vertices): bounds the overrun of the frame budget. */
  const SLICE_ROWS = 16;
  const enqueue = (c: Chunk, lod: number, prio: number): void => {
    if (c.geoms[lod]) return;
    const k = keyOf(c, lod);
    if (queued.has(k)) return;
    queued.add(k);
    queue.push({ chunk: c, lod, prio, build: null });
  };

  let clock = 0;
  const assign = (c: Chunk): void => {
    // Best available LOD: the wanted one, else the nearest finer, else coarser.
    let lod = c.want;
    if (!c.geoms[lod]) {
      let best = -1;
      for (let d = 1; d < TERRAIN_LOD_COUNT && best < 0; d++) {
        if (lod - d >= 0 && c.geoms[lod - d]) best = lod - d;
        else if (lod + d < TERRAIN_LOD_COUNT && c.geoms[lod + d]) best = lod + d;
      }
      lod = best;
    }
    if (lod !== c.lod) {
      c.lod = lod;
      c.mesh.geometry = c.geoms[lod]!;
    }
    c.lastUsed[lod] = clock;
  };

  const plan = (camera: Camera): void => {
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    (uniforms.uTCam!.value as Vector3).copy(camPos);
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem);
    const shadows = opts.lighting.csm !== null || opts.lighting.sun.castShadow;
    for (const c of chunks) {
      c.dist = c.box.distanceToPoint(camPos);
      c.inView = frustum.intersectsBox(c.box);
      c.want = lodFor(c.dist, 1);
      const pre = lodFor(c.dist, PREFETCH);
      const casts = shadows && c.dist < csmFar;
      c.mesh.castShadow = casts;
      // Off-screen chunks stay "visible" while they may cast into view; three
      // culls them per camera/cascade frustum itself.
      c.mesh.visible = c.inView || casts;
      if (!c.geoms[c.want]) enqueue(c, c.want, c.dist * (c.inView ? 1 : 4));
      if (pre !== c.want && !c.geoms[pre]) enqueue(c, pre, c.dist * (c.inView ? 1.5 : 6) + 50);
    }
  };

  const drain = (budgetMs: number): void => {
    const t0 = now();
    for (const job of queue) {
      const c = job.chunk;
      // In-progress builds first (their memory is already spent), then nearest / in view.
      job.prio = c.dist * (c.inView ? 1 : 4) + (job.lod === c.want ? 0 : 50 + c.dist * 0.5) - (job.build ? 1e6 : 0);
    }
    if (queue.length > 1) queue.sort((a, b) => b.prio - a.prio); // pop() takes the smallest
    while (queue.length > 0 && now() - t0 < budgetMs) {
      const job = queue[queue.length - 1]!;
      const c = job.chunk;
      // Drop stale jobs (the chunk no longer wants that LOD, even with prefetch).
      const stillWanted = job.lod === c.want || job.lod === lodFor(c.dist, PREFETCH);
      if (!stillWanted || c.geoms[job.lod]) {
        queue.pop();
        queued.delete(keyOf(c, job.lod));
        continue;
      }
      job.build ??= new ChunkBuild(terrain, c.cx, c.cz, job.lod, c.skirt);
      if (job.build.step(SLICE_ROWS)) {
        c.geoms[job.lod] = makeChunkGeometry(job.build.data, job.lod, c.box);
        c.lastUsed[job.lod] = clock;
        queue.pop();
        queued.delete(keyOf(c, job.lod));
      }
    }
    const ms = now() - t0;
    stats.lastBuildMs = ms;
    if (ms > stats.peakBuildMs) stats.peakBuildMs = ms;
  };

  const finish = (): void => {
    let vis = 0;
    let tris = 0;
    const lc = stats.lodCounts;
    lc.fill(0);
    for (const c of chunks) {
      assign(c);
      if (c.inView) {
        vis++;
        tris += lodTriangles(c.lod);
        lc[c.lod]!++;
      }
      // Evict stale finer LODs (LOD 3 always stays).
      for (let k = 0; k < TERRAIN_LOD_COUNT - 1; k++) {
        const g = c.geoms[k];
        if (g && k !== c.lod && clock - c.lastUsed[k]! > EVICT_AFTER_S * 1000 && k !== c.want) {
          g.dispose();
          c.geoms[k] = null;
        }
      }
    }
    // Far-field batching: a block whose members all draw LOD 3 draws as its merged mesh instead.
    let superDrawn = 0;
    for (const s of supers) {
      let all = true;
      let shown = false;
      let casts = false;
      for (const c of s.members) {
        if (c.lod !== coarsestLod) {
          all = false;
          break;
        }
        if (c.mesh.visible) shown = true;
        if (c.mesh.castShadow) casts = true;
      }
      s.mesh.visible = all && shown;
      if (!s.mesh.visible) continue;
      s.mesh.castShadow = casts;
      for (const c of s.members) c.mesh.visible = false;
      superDrawn++;
    }
    stats.superChunks = superDrawn;
    stats.visibleChunks = vis;
    stats.triangles = tris;
    stats.pending = queue.length;
  };

  const self: TerrainRendererExt = {
    object,
    stats,
    uniforms,
    buildBudgetMs: 3,
    update(camera: Camera): void {
      clock = now();
      plan(camera);
      const t1 = now();
      drain(self.buildBudgetMs);
      const t2 = now();
      finish();
      const t3 = now();
      stats.planMs = t1 - clock;
      stats.finishMs = t3 - t2;
    },
    prime(camera: Camera): void {
      clock = now();
      plan(camera);
      drain(Infinity);
      finish();
    },
    resetPeak(): void {
      stats.peakBuildMs = 0;
    },
    setQuality(q: QualityPreset): void {
      applyQuality(q);
    },
    dispose(): void {
      object.removeFromParent();
      for (const c of chunks) for (const g of c.geoms) g?.dispose();
      for (const s of supers) s.mesh.geometry.dispose();
      color.dispose();
      depth.dispose();
      patched.depth?.dispose();
      patched.distance?.dispose();
      for (const t of [arrays.albedo, arrays.surface, splatTex, normalTex, concreteTex, noiseTex]) t.dispose();
    },
  };
  return self;
}

/**
 * Compose the terrain patch AFTER whatever hook patchMaterial installed
 * (CSM's uniform hook first, per PATCH_ORDER). onBeforeCompile becomes an
 * accessor: if lighting later re-runs csm.setupMaterial (which assigns a
 * fresh hook), that assignment replaces the INNER hook and the terrain patch
 * still runs last.
 */
function installTerrainHook(
  material: Material,
  patch: (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void,
): void {
  let inner = material.onBeforeCompile.bind(material);
  const outer = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer): void => {
    inner(shader, renderer);
    patch(shader, renderer);
  };
  Object.defineProperty(material, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get: () => outer,
    set: (fn: (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void) => {
      inner = fn;
    },
  });
  const priorKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${priorKey()}|${TERRAIN_SHADER_KEY}`;
  material.needsUpdate = true;
}
