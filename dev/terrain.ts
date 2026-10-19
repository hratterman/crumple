/**
 * Terrain preview (dev only: /crumple/dev/terrain.html, not in the build).
 *
 * DEFAULT_LAYOUT terrain through createTerrainRenderer, with C's lighting /
 * post / patchMaterial when present (else a sun + hemisphere + HDRI
 * fallback) and A's generateTerrain when present (else a synthetic stand-in).
 *
 * Controls: click to capture the mouse, WASD move, Q/E (or Space/C) down/up,
 * Shift fast, 1–7 showcase viewpoints, H toggles the HUD, L cycles quality.
 * window.__terrainPreview exposes hooks for e2e/screenshots.
 */
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FogExp2,
  HemisphereLight,
  NoToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Camera, Texture } from 'three';

import { loadAllTerrainSets, loadEnvironmentHDR } from '../src/assets/loader';
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
import type { GenerateTerrain, TerrainData } from '../src/world/types';
import { syntheticTerrain } from './synthetic';

// Optional sibling modules (absent while parallel agents are still working).
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
    console.warn('[terrain-preview] optional module failed to load', e);
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PRESETS[qualityLevel].pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2400);
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
}

interface PreviewHooks {
  ready: boolean;
  error: string | null;
  terrainSource: 'generateTerrain' | 'synthetic';
  lightingSource: 'stack' | 'fallback';
  postSource: 'stack' | 'fallback';
  views: string[];
  view: number;
  frameMs: number;
  cpuMs: number;
  fps: number;
  setView(i: number): void;
  setQuality(level: QualityLevel): void;
  /** Build all chunk LODs for the current camera synchronously. */
  prime(): void;
  /** Render n frames synchronously (headless screenshots), returns mean CPU ms. */
  renderFrames(n: number): number;
  stats(): Record<string, unknown>;
  setDebug(mode: number): void;
  /** The terrain shader uniforms (live tuning from devtools / e2e). */
  uniforms: Record<string, { value: unknown }> | null;
  /** Drive the camera along the highway at `speed` m/s for `frames` 60 Hz frames (update only, no draw). */
  streamTest(frames: number, speed: number): { maxUpdateMs: number; maxBuildMs: number; meanUpdateMs: number; builds: number; over8: number };
  setCamera(pos: [number, number, number], look: [number, number, number]): void;
}
const hooks: PreviewHooks = {
  ready: false,
  error: null,
  terrainSource: 'synthetic',
  lightingSource: 'fallback',
  postSource: 'fallback',
  views: [],
  view: 0,
  frameMs: 0,
  cpuMs: 0,
  fps: 0,
  setView: () => {},
  setQuality: () => {},
  prime: () => {},
  renderFrames: () => 0,
  stats: () => ({}),
  setDebug: () => {},
  uniforms: null,
  streamTest: () => ({ maxUpdateMs: 0, maxBuildMs: 0, meanUpdateMs: 0, builds: 0, over8: 0 }),
  setCamera: () => {},
};
(window as unknown as { __terrainPreview: PreviewHooks }).__terrainPreview = hooks;

// ------------------------------------------------------------ fallback lighting
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
    const rt = pmrem.fromEquirectangular(env);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.9;
    scene.background = env;
    scene.backgroundIntensity = 1;
  } else {
    scene.background = new Color(0x9db4d0);
  }
  const focus = new Vector3();
  return {
    sun,
    sunDirection,
    csm: null,
    environment: scene.environment!,
    update(c: Camera) {
      // Shadow box centred ahead of the camera.
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

// ------------------------------------------------------------ boot
async function boot(): Promise<void> {
  const t0 = performance.now();
  hud.textContent = 'generating terrain…';
  const worldMod = await optional(worldMods);
  let terrain: TerrainData;
  if (worldMod?.generateTerrain) {
    terrain = worldMod.generateTerrain(DEFAULT_LAYOUT);
    hooks.terrainSource = 'generateTerrain';
  } else {
    terrain = syntheticTerrain(DEFAULT_LAYOUT);
  }
  const genMs = performance.now() - t0;

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
    renderer.toneMappingExposure = 1.0;
  }
  const patchMaterial: PatchMaterial =
    materialMod?.patchMaterial ?? (<M,>(m: M) => ({ color: m, depth: null, distance: null }) as never);

  const t1 = performance.now();
  const terrainR = createTerrainRenderer(ctx, terrain, materials, { lighting, patchMaterial });
  const createMs = performance.now() - t1;
  scene.add(terrainR.object);
  terrainR.uniforms.uTDebug!.value = Number(params.get('debug') ?? 0);

  // ---------------------------------------------------------- views
  const hAt = (x: number, z: number): number => {
    const u = Math.min(Math.max((x - terrain.originX) / terrain.spacing, 0), terrain.cols - 1.001);
    const v = Math.min(Math.max((z - terrain.originZ) / terrain.spacing, 0), terrain.rows - 1.001);
    const c = Math.floor(u);
    const r = Math.floor(v);
    const tx = u - c;
    const tz = v - r;
    const H = terrain.heights;
    const i = r * terrain.cols + c;
    const a = H[i]! + (H[i + 1]! - H[i]!) * tx;
    const b = H[i + terrain.cols]! + (H[i + terrain.cols + 1]! - H[i + terrain.cols]!) * tx;
    return a + (b - a) * tz;
  };
  const at = (x: number, z: number, lift: number): Vector3 => new Vector3(x, hAt(x, z) + lift, z);
  const spawn = (id: string) => terrain.spawns.find((s) => s.id === id);
  const hw = spawn('highway');
  const hwPos = hw ? new Vector3(hw.pos[0], hw.pos[1] + 1.5, hw.pos[2]) : at(600, 80, 1.5);
  const hwFwd = hw ? new Vector3(-Math.sin(hw.yaw), 0, -Math.cos(hw.yaw)) : new Vector3(0, 0, -1);
  // Steepest rock face in the range for a triplanar close-up.
  let best = 0;
  let cliff = new Vector3(150, 0, -300);
  let cliffN = new Vector3(0, 0, 1);
  for (let z = -640; z < -120; z += 6) {
    for (let x = -380; x < 620; x += 6) {
      const gx = (hAt(x + 2, z) - hAt(x - 2, z)) / 4;
      const gz = (hAt(x, z + 2) - hAt(x, z - 2)) / 4;
      const s = gx * gx + gz * gz;
      if (s > best) {
        best = s;
        cliff = new Vector3(x, hAt(x, z), z);
        cliffN = new Vector3(-gx, 0, -gz).normalize();
      }
    }
  }
  const groundDir = new Vector3(-lighting.sunDirection.x, 0, -lighting.sunDirection.z)
    .normalize()
    .applyAxisAngle(new Vector3(0, 1, 0), 1.0);
  const views: View[] = [
    { name: 'summit lookout', pos: at(150, -350, 9), look: new Vector3(-300, 8, 330) },
    { name: 'lake shore', pos: at(-196, 214, 1.7), look: at(-330, 330, -2) },
    { name: 'arena', pos: at(468, 452, 16), look: at(330, 300, 0) },
    { name: 'highway', pos: hwPos, look: hwPos.clone().addScaledVector(hwFwd, 80).setY(hwPos.y - 1) },
    { name: 'aerial', pos: new Vector3(-520, 330, 760), look: new Vector3(80, 20, -120) },
    {
      name: 'cliff',
      pos: cliff.clone().addScaledVector(cliffN, 22).setY(cliff.y + 6),
      look: cliff.clone(),
    },
    {
      // Down-sun and to the side, so the normal maps read.
      name: 'ground detail',
      pos: at(-60, 120, 1.3),
      look: at(-60 + groundDir.x * 5, 120 + groundDir.z * 5, 0),
    },
  ];
  hooks.views = views.map((v) => v.name);

  const yawPitch = { yaw: 0, pitch: 0 };
  const applyLook = (): void => {
    camera.rotation.set(yawPitch.pitch, yawPitch.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  const setView = (i: number): void => {
    const v = views[i];
    if (!v) return;
    hooks.view = i;
    camera.position.copy(v.pos);
    const d = v.look.clone().sub(v.pos).normalize();
    yawPitch.yaw = Math.atan2(-d.x, -d.z);
    yawPitch.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    applyLook();
  };
  setView(Number(params.get('view') ?? 0));

  // ---------------------------------------------------------- input
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code.startsWith('Digit')) setView(Number(e.code.slice(5)) - 1);
    if (e.code === 'KeyH') hud.classList.toggle('hidden');
    if (e.code === 'KeyL') {
      const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(qualityLevel) + 1) % QUALITY_LEVELS.length]!;
      hooks.setQuality(next);
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
    let speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 120 : 24;
    if (keys.has('AltLeft')) speed = 4;
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, camera.up).normalize();
    const d = speed * dt;
    if (keys.has('KeyW')) camera.position.addScaledVector(fwd, d);
    if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -d);
    if (keys.has('KeyD')) camera.position.addScaledVector(right, d);
    if (keys.has('KeyA')) camera.position.addScaledVector(right, -d);
    if (keys.has('KeyE') || keys.has('Space')) camera.position.y += d;
    if (keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= d;
    const floor = hAt(camera.position.x, camera.position.z) + 0.4;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.updateMatrixWorld();
  };

  // ---------------------------------------------------------- frame
  let last = performance.now();
  let cpuEma = 0;
  let dtEma = 16;
  // Count every pass of the frame (shadow cascades + composer), not just the last draw.
  renderer.info.autoReset = false;
  const frame = (dtS: number): number => {
    renderer.info.reset();
    const c0 = performance.now();
    move(dtS);
    lighting.update(camera);
    terrainR.update(camera);
    if (post) post.render(dtS);
    else renderer.render(scene, camera);
    return performance.now() - c0;
  };
  hooks.setView = setView;
  hooks.uniforms = terrainR.uniforms;
  hooks.setDebug = (m: number) => {
    terrainR.uniforms.uTDebug!.value = m;
  };
  hooks.streamTest = (frames: number, speed: number) => {
    const road = terrain.roads.find((r) => r.id === 'highway') ?? terrain.roads[0];
    let maxUpdateMs = 0;
    let maxBuildMs = 0;
    let sum = 0;
    let builds = 0;
    let over8 = 0;
    const geomsBefore = renderer.info.memory.geometries;
    for (let f = 0; f < frames; f++) {
      const sDist = (f / 60) * speed;
      if (road) {
        const st = road.stations;
        const n = road.stationCount;
        const i = Math.floor(sDist / 2) % n;
        const j = (i + 1) % n;
        camera.position.set(st[i * 7]!, st[i * 7 + 1]! + 1.4, st[i * 7 + 2]!);
        camera.lookAt(st[j * 7]!, st[j * 7 + 1]! + 1.4, st[j * 7 + 2]!);
      } else {
        camera.position.set(-600 + sDist, 30, 0);
        camera.lookAt(-500 + sDist, 30, 0);
      }
      camera.updateMatrixWorld();
      lighting.update(camera);
      const t0 = performance.now();
      terrainR.update(camera);
      const ms = performance.now() - t0;
      sum += ms;
      if (ms > maxUpdateMs) maxUpdateMs = ms;
      if (ms > 8) {
        over8++;
        console.log(`slow update ${ms.toFixed(1)} ms: plan ${terrainR.stats.planMs.toFixed(1)} build ${terrainR.stats.lastBuildMs.toFixed(1)} finish ${terrainR.stats.finishMs.toFixed(1)}`);
      }
      if (terrainR.stats.lastBuildMs > maxBuildMs) maxBuildMs = terrainR.stats.lastBuildMs;
      if (terrainR.stats.lastBuildMs > 0.05) builds++;
    }
    void geomsBefore;
    return { maxUpdateMs, maxBuildMs, meanUpdateMs: sum / frames, builds, over8 };
  };
  hooks.setCamera = (p, l) => {
    views.push({ name: 'custom', pos: new Vector3(...p), look: new Vector3(...l) });
    setView(views.length - 1);
  };
  hooks.setQuality = (level: QualityLevel) => {
    qualityLevel = level;
    ctx.quality = QUALITY_PRESETS[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, ctx.quality.pixelRatioCap));
    renderer.setSize(ctx.width, ctx.height);
    lighting.setQuality(ctx.quality);
    post?.setQuality(ctx.quality);
    post?.setSize(ctx.width, ctx.height);
    terrainR.setQuality(ctx.quality);
  };
  hooks.prime = () => {
    lighting.update(camera);
    terrainR.prime(camera);
  };
  hooks.renderFrames = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frame(0);
    renderer.getContext().finish();
    return sum / n;
  };
  hooks.stats = () => ({
    ...terrainR.stats,
    lodCounts: [...terrainR.stats.lodCounts],
    rendererTriangles: renderer.info.render.triangles,
    drawCalls: renderer.info.render.calls,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
    quality: qualityLevel,
    genMs: Math.round(genMs),
    createMs: Math.round(createMs),
    cameraPos: camera.position.toArray().map((v) => Math.round(v * 10) / 10),
    view: views[hooks.view]?.name,
  });

  const loop = (): void => {
    const t = performance.now();
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const cpu = frame(dt);
    cpuEma += (cpu - cpuEma) * 0.1;
    dtEma += (dt * 1000 - dtEma) * 0.1;
    hooks.cpuMs = cpuEma;
    hooks.frameMs = dtEma;
    hooks.fps = 1000 / dtEma;
    const s = terrainR.stats;
    hud.textContent =
      `CRUMPLE terrain preview — ${views[hooks.view]?.name ?? 'free'}   [${qualityLevel}]\n` +
      `frame ${dtEma.toFixed(1)} ms (${(1000 / dtEma).toFixed(0)} fps)  cpu ${cpuEma.toFixed(2)} ms\n` +
      `terrain tris ${(s.triangles / 1000).toFixed(0)}k  all tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  calls ${renderer.info.render.calls}\n` +
      `chunks ${s.visibleChunks}/${s.chunks}  lod ${s.lodCounts.join('/')}  queue ${s.pending}  build ${s.lastBuildMs.toFixed(2)} ms (peak ${s.peakBuildMs.toFixed(2)})\n` +
      `terrain ${hooks.terrainSource}  light ${hooks.lightingSource}  post ${hooks.postSource}\n` +
      `1-7 views · WASD/QE fly · shift fast · click mouse-look · L quality · H hud`;
    requestAnimationFrame(loop);
  };
  hooks.ready = true;
  // ?still: no rAF loop — frames are rendered only via renderFrames (headless screenshots).
  if (params.get('still') === null) requestAnimationFrame(loop);
  else hud.classList.add('hidden');
}

boot().catch((e: unknown) => {
  console.error(e);
  hooks.error = String((e as Error)?.stack ?? e);
  hud.textContent = `preview failed: ${hooks.error}`;
});
