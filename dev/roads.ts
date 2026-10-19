/**
 * Road ribbon preview (dev only: /crumple/dev/roads.html, not in the build).
 *
 * DEFAULT_LAYOUT terrain + createRoadRenderer, with B's terrain renderer and
 * C's lighting / post / patchMaterial when present (fallbacks otherwise) and
 * A's generateTerrain when present (else dev/roadsSynth.ts).
 *
 * Keys: 1–9, 0 viewpoints (highway sweeper, hairpin, town junction, dirt
 * trail, arena runway, passing zones, highway junction, aerial, trailhead,
 * base fork), WASD/QE fly,
 * Shift fast, click mouse-look, L quality, H hud, T toggles terrain.
 * window.__roadsPreview exposes hooks for e2e / screenshots (?still renders
 * only on demand).
 */
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FogExp2,
  HemisphereLight,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Camera, Texture } from 'three';

import { loadAllTerrainSets, loadEnvironmentHDR } from '../src/assets/loader';
import { createRoadRenderer } from '../src/render/roads';
import { createTerrainRenderer } from '../src/render/terrain';
import { DEFAULT_QUALITY, QUALITY_LEVELS, QUALITY_PRESETS } from '../src/render/types';
import type {
  CreateLightingStack,
  CreatePostStack,
  LightingStack,
  PatchMaterial,
  PostStack,
  QualityLevel,
  RenderContext,
} from '../src/render/types';
import { DEFAULT_LAYOUT } from '../src/world/layout';
import { createTerrainSampler } from '../src/world/sampler';
import {
  ROAD_STATION_SPACING,
  ROAD_STATION_STRIDE,
  RoadStation,
  type GenerateTerrain,
  type RoadProfile,
  type TerrainData,
} from '../src/world/types';
import { syntheticTerrainWithRoads } from './roadsSynth';

const worldMods = import.meta.glob<{ generateTerrain?: GenerateTerrain }>('../src/world/terrain.ts');
const lightingMods = import.meta.glob<{ createLightingStack?: CreateLightingStack }>('../src/render/lighting.ts');
const postMods = import.meta.glob<{ createPostStack?: CreatePostStack }>('../src/render/post.ts');
const materialMods = import.meta.glob<{ patchMaterial?: PatchMaterial }>('../src/render/material.ts');

async function optional<T>(mods: Record<string, () => Promise<T>>): Promise<T | null> {
  const load = Object.values(mods)[0];
  if (!load) return null;
  try {
    return await load();
  } catch (e) {
    console.warn('[roads-preview] optional module failed to load', e);
    return null;
  }
}

const params = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
let qualityLevel: QualityLevel = (params.get('q') as QualityLevel) || DEFAULT_QUALITY;
if (!QUALITY_LEVELS.includes(qualityLevel)) qualityLevel = DEFAULT_QUALITY;

const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PRESETS[qualityLevel].pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 2400);
scene.add(camera);
const ctx: RenderContext = {
  renderer,
  scene,
  camera,
  quality: QUALITY_PRESETS[qualityLevel],
  width: window.innerWidth,
  height: window.innerHeight,
  sampler: null,
};

interface View {
  name: string;
  pos: Vector3;
  look: Vector3;
  fov?: number;
}

interface PreviewHooks {
  ready: boolean;
  error: string | null;
  terrainSource: 'generateTerrain' | 'synthetic';
  lightingSource: 'stack' | 'fallback';
  postSource: 'stack' | 'fallback';
  views: string[];
  view: number;
  setView(i: number): void;
  setQuality(level: QualityLevel): void;
  setCamera(pos: [number, number, number], look: [number, number, number], fov?: number): void;
  showTerrain(on: boolean): void;
  prime(): void;
  renderFrames(n: number): number;
  stats(): Record<string, unknown>;
}
const hooks: PreviewHooks = {
  ready: false,
  error: null,
  terrainSource: 'synthetic',
  lightingSource: 'fallback',
  postSource: 'fallback',
  views: [],
  view: 0,
  setView: () => {},
  setQuality: () => {},
  setCamera: () => {},
  showTerrain: () => {},
  prime: () => {},
  renderFrames: () => 0,
  stats: () => ({}),
};
(window as unknown as { __roadsPreview: PreviewHooks }).__roadsPreview = hooks;

function fallbackLighting(env: Texture | null): LightingStack {
  const sunDirection = new Vector3(-0.62, 0.2, -0.36).normalize();
  const sun = new DirectionalLight(0xffd2a0, 5.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  const cam = sun.shadow.camera;
  cam.left = -220;
  cam.right = 220;
  cam.top = 220;
  cam.bottom = -220;
  cam.near = 1;
  cam.far = 1600;
  scene.add(sun, sun.target);
  scene.add(new HemisphereLight(0x9fb7d8, 0x4a3b2a, env ? 0.35 : 1.6));
  scene.fog = new FogExp2(new Color(0xc9b8a2), 0.0011);
  if (env) {
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(env).texture;
    scene.environmentIntensity = 0.9;
    scene.background = env;
  } else scene.background = new Color(0x9db4d0);
  const focus = new Vector3();
  return {
    sun,
    sunDirection,
    csm: null,
    environment: scene.environment!,
    update(c: Camera) {
      c.getWorldDirection(focus);
      focus.multiplyScalar(140).add(c.position);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(sunDirection, 700);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
    },
    setQuality() {},
    dispose() {},
  };
}

/** Station helpers on a resolved profile. */
function stationPos(p: RoadProfile, i: number): Vector3 {
  const o = i * ROAD_STATION_STRIDE;
  return new Vector3(p.stations[o + RoadStation.x], p.stations[o + RoadStation.y], p.stations[o + RoadStation.z]);
}
function stationFwd(p: RoadProfile, i: number): Vector3 {
  const o = i * ROAD_STATION_STRIDE;
  return new Vector3(p.stations[o + RoadStation.tx], 0, p.stations[o + RoadStation.tz]);
}
function stationRight(p: RoadProfile, i: number): Vector3 {
  const f = stationFwd(p, i);
  return new Vector3(-f.z, 0, f.x);
}
function kappa(p: RoadProfile, i: number): number {
  return p.stations[i * ROAD_STATION_STRIDE + RoadStation.curvature]!;
}
/** Station of max |κ| (optionally max signed) within [i0, i1). */
function maxCurv(p: RoadProfile, i0: number, i1: number, sign = 0): number {
  let best = i0;
  let bv = -Infinity;
  for (let i = Math.max(0, i0); i < Math.min(p.stationCount, i1); i++) {
    const k = sign === 0 ? Math.abs(kappa(p, i)) : sign * kappa(p, i);
    if (k > bv) {
      bv = k;
      best = i;
    }
  }
  return best;
}

async function boot(): Promise<void> {
  const t0 = performance.now();
  hud.textContent = 'generating terrain…';
  const worldMod = await optional(worldMods);
  let terrain: TerrainData;
  if (worldMod?.generateTerrain && params.get('synth') === null) {
    terrain = worldMod.generateTerrain(DEFAULT_LAYOUT);
    hooks.terrainSource = 'generateTerrain';
  } else terrain = syntheticTerrainWithRoads(DEFAULT_LAYOUT);
  const genMs = performance.now() - t0;
  const sampler = createTerrainSampler(terrain);
  ctx.sampler = sampler;

  hud.textContent = 'loading textures…';
  const [materials, lightingMod, postMod, materialMod] = await Promise.all([
    loadAllTerrainSets({ anisotropy: renderer.capabilities.getMaxAnisotropy() }),
    optional(lightingMods),
    optional(postMods),
    optional(materialMods),
  ]);
  let lighting: LightingStack;
  if (lightingMod?.createLightingStack && params.get('fallbackLight') === null) {
    lighting = await lightingMod.createLightingStack(ctx);
    hooks.lightingSource = 'stack';
  } else {
    const env = await loadEnvironmentHDR('kiara_1_dawn').catch(() => null);
    if (env) env.texture.mapping = EquirectangularReflectionMapping;
    lighting = fallbackLighting(env?.texture ?? null);
  }
  let post: PostStack | null = null;
  if (postMod?.createPostStack && params.get('fallbackPost') === null) {
    post = postMod.createPostStack(ctx);
    hooks.postSource = 'stack';
  } else {
    renderer.toneMapping = ACESFilmicToneMapping;
  }
  const patchMaterial: PatchMaterial =
    materialMod?.patchMaterial ?? (<M,>(m: M) => ({ color: m, depth: null, distance: null }) as never);

  const terrainR = createTerrainRenderer(ctx, terrain, materials, { lighting, patchMaterial });
  scene.add(terrainR.object);
  const t1 = performance.now();
  const roadsR = createRoadRenderer(ctx, terrain, sampler, materials, { lighting, patchMaterial });
  const roadMs = performance.now() - t1;
  scene.add(roadsR.object);

  // ---------------------------------------------------------- views
  const road = (id: string): RoadProfile => {
    const i = DEFAULT_LAYOUT.roads.findIndex((r) => r.id === id);
    return terrain.roads[i]!;
  };
  const hAt = (x: number, z: number): number => sampler.heightAt(x, z);
  const at = (x: number, z: number, lift: number): Vector3 => new Vector3(x, hAt(x, z) + lift, z);
  const along = (p: RoadProfile, i: number, d: number, lift: number): Vector3 => {
    const q = stationPos(p, i).addScaledVector(stationRight(p, i), d);
    return at(q.x, q.z, lift);
  };
  const st = (s: number): number => Math.round(s / ROAD_STATION_SPACING);

  const hw = road('highway');
  // Highway sweeper: west side heading north, low sun from the right; eye in the inner lane.
  const hwApex = maxCurv(hw, st(260), st(520));
  const hwCam = Math.max(0, hwApex - 45);
  const ridge = road('ridgePass');
  const hp = maxCurv(ridge, st(500), st(800));
  const hpOut = stationRight(ridge, hp).multiplyScalar(-Math.sign(kappa(ridge, hp)) || 1);
  const dirt = road('dirtTrail');
  const dI = st(260);
  const runway = road('arenaRunway');
  const pass = road('ridgePass');
  // A station where only one direction may pass (dashed | solid double yellow).
  const passFlags = roadsR.ribbons.roads.find((r) => r.profile.id === 'ridgePass')!.passing;
  let passI = st(160);
  for (let i = 20; i < pass.stationCount - 20; i++) {
    if (passFlags.passR[i] !== passFlags.passL[i] && passFlags.passR[i + 12] !== passFlags.passL[i + 12]) {
      passI = i;
      break;
    }
  }
  const views: View[] = [
    {
      name: 'highway sweeper',
      pos: along(hw, hwCam, 1.7, 1.25),
      look: along(hw, hwApex + 6, -1.0, 0.4),
    },
    {
      name: 'hairpin',
      pos: stationPos(ridge, hp).addScaledVector(hpOut, 26).setY(stationPos(ridge, hp).y + 13),
      look: stationPos(ridge, hp).addScaledVector(hpOut, -4),
    },
    { name: 'town junction', pos: at(132, 268, 6.5), look: at(150, 250, 0) },
    { name: 'dirt trail', pos: along(dirt, dI, 0.2, 1.45), look: along(dirt, dI + 10, 0, 0.5) },
    { name: 'arena runway', pos: along(runway, st(16), 2.5, 1.3), look: along(runway, st(70), 1.2, 0.6) },
    { name: 'passing zones', pos: along(pass, passI, 1.6, 1.3), look: along(pass, passI + 12, 0.5, 0.5) },
    { name: 'highway junction', pos: at(574, 352, 9), look: at(598, 330, 0) },
    { name: 'aerial', pos: new Vector3(260, 160, 520), look: new Vector3(150, 10, 330) },
    { name: 'trailhead', pos: at(-318, 140, 6), look: at(-332, 166, 0) },
    { name: 'base fork', pos: at(-252, -166, 6), look: at(-232, -190, 0) },
  ];
  hooks.views = views.map((v) => v.name);

  const yawPitch = { yaw: 0, pitch: 0 };
  const applyLook = (): void => {
    camera.rotation.set(yawPitch.pitch, yawPitch.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  const lookFrom = (pos: Vector3, look: Vector3, fov = 58): void => {
    camera.position.copy(pos);
    const d = look.clone().sub(pos).normalize();
    yawPitch.yaw = Math.atan2(-d.x, -d.z);
    yawPitch.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    applyLook();
  };
  const setView = (i: number): void => {
    const v = views[i];
    if (!v) return;
    hooks.view = i;
    lookFrom(v.pos, v.look, v.fov);
  };
  setView(Number(params.get('view') ?? 0));

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code.startsWith('Digit')) setView((Number(e.code.slice(5)) + 9) % 10);
    if (e.code === 'KeyH') hud.classList.toggle('hidden');
    if (e.code === 'KeyT') terrainR.object.visible = !terrainR.object.visible;
    if (e.code === 'KeyL') {
      hooks.setQuality(QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(qualityLevel) + 1) % QUALITY_LEVELS.length]!);
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => void canvas.requestPointerLock?.());
  let dragging = false;
  canvas.addEventListener('mousedown', () => (dragging = true));
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas && !dragging) return;
    yawPitch.yaw -= e.movementX * 0.0022;
    yawPitch.pitch = Math.max(-1.5, Math.min(1.5, yawPitch.pitch - e.movementY * 0.0022));
    applyLook();
  });
  window.addEventListener('resize', () => {
    ctx.width = window.innerWidth;
    ctx.height = window.innerHeight;
    camera.aspect = ctx.width / ctx.height;
    camera.updateProjectionMatrix();
    renderer.setSize(ctx.width, ctx.height);
    post?.setSize(ctx.width, ctx.height);
  });
  const fwd = new Vector3();
  const right = new Vector3();
  const move = (dt: number): void => {
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 120 : 20;
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, camera.up).normalize();
    const d = speed * dt;
    if (keys.has('KeyW')) camera.position.addScaledVector(fwd, d);
    if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -d);
    if (keys.has('KeyD')) camera.position.addScaledVector(right, d);
    if (keys.has('KeyA')) camera.position.addScaledVector(right, -d);
    if (keys.has('KeyE') || keys.has('Space')) camera.position.y += d;
    if (keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= d;
    const floor = hAt(camera.position.x, camera.position.z) + 0.3;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.updateMatrixWorld();
  };

  const frame = (dtS: number): number => {
    const c0 = performance.now();
    move(dtS);
    lighting.update(camera);
    terrainR.update(camera);
    roadsR.update(camera);
    if (post) post.render(dtS);
    else renderer.render(scene, camera);
    return performance.now() - c0;
  };
  hooks.setView = setView;
  hooks.showTerrain = (on) => {
    terrainR.object.visible = on;
  };
  hooks.setCamera = (pos, look, fov) => lookFrom(new Vector3(...pos), new Vector3(...look), fov);
  hooks.setQuality = (level: QualityLevel) => {
    qualityLevel = level;
    ctx.quality = QUALITY_PRESETS[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, ctx.quality.pixelRatioCap));
    renderer.setSize(ctx.width, ctx.height);
    lighting.setQuality(ctx.quality);
    post?.setQuality(ctx.quality);
    post?.setSize(ctx.width, ctx.height);
    terrainR.setQuality(ctx.quality);
    roadsR.setQuality(ctx.quality);
  };
  hooks.prime = () => {
    lighting.update(camera);
    terrainR.prime(camera);
    roadsR.update(camera);
  };
  hooks.renderFrames = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frame(0);
    renderer.getContext().finish();
    return sum / n;
  };
  hooks.stats = () => ({
    roads: { ...roadsR.stats, lodCounts: [...roadsR.stats.lodCounts] },
    junctions: roadsR.ribbons.junctions.junctions.map((j) => ({
      x: Math.round(j.x),
      z: Math.round(j.z),
      members: j.members.map((m) => `${roadsR.ribbons.roads[m.road]!.profile.id}:${m.role}`),
    })),
    rendererTriangles: renderer.info.render.triangles,
    drawCalls: renderer.info.render.calls,
    genMs: Math.round(genMs),
    roadBuildMs: Math.round(roadMs),
    view: views[hooks.view]?.name,
    cameraPos: camera.position.toArray().map((v) => Math.round(v * 10) / 10),
    terrainSource: hooks.terrainSource,
    lightingSource: hooks.lightingSource,
    postSource: hooks.postSource,
  });

  let last = performance.now();
  let dtEma = 16;
  const loop = (): void => {
    const t = performance.now();
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    frame(dt);
    dtEma += (dt * 1000 - dtEma) * 0.1;
    const s = roadsR.stats;
    hud.textContent =
      `CRUMPLE road preview — ${views[hooks.view]?.name ?? 'free'}   [${qualityLevel}]\n` +
      `frame ${dtEma.toFixed(1)} ms  road tris ${(s.triangles / 1000).toFixed(0)}k  lod ${s.lodCounts.join('/')}  pieces ${s.pieces}  junctions ${s.junctions}\n` +
      `terrain ${hooks.terrainSource}  light ${hooks.lightingSource}  post ${hooks.postSource}  build ${roadMs.toFixed(0)} ms\n` +
      `1-9,0 views · WASD/QE fly · shift fast · click mouse-look · L quality · T terrain · H hud`;
    requestAnimationFrame(loop);
  };
  hooks.ready = true;
  if (params.get('still') === null) requestAnimationFrame(loop);
  else hud.classList.add('hidden');
}

boot().catch((e: unknown) => {
  console.error(e);
  hooks.error = String((e as Error)?.stack ?? e);
  hud.textContent = `preview failed: ${hooks.error}`;
});
