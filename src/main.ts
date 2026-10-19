/**
 * CRUMPLE — the game on Crumple Valley (P3).
 *
 * Boot (src/ui/loading.ts shows the steps; everything that can overlaps):
 *   - the physics worker gets `groundHeightfield(layout)` FIRST (never a
 *     plane: switching ground types de-inlines the sampler and makes the sim
 *     allocate) and regenerates its own terrain;
 *   - main's render copy is generated in a helper worker (no page freeze)
 *     and its hash checked against the physics worker's terrainReady;
 *   - textures + HDRI load in parallel; the lighting stack is created before
 *     any material compiles (it installs the fog chunks);
 *   - terrain/road renderers, post stack, quality controller; the sedan
 *     spawns only after terrainReady; shaders compile and the first frames
 *     render behind the loading screen, which then fades out.
 * Frame order follows render/types.ts: sim → camera → lighting → terrain /
 * roads → quality → post.
 */
import './style.css';
import { NoToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';

import { createQualityControllerWith, isQualityLevel, loadQualityLevel } from './app/quality';
import { SimClient, type ObjectRange } from './app/simClient';
import { placeOnGround, yawOf } from './app/spawn';
import { loadTerrain } from './app/world';
import { loadAllTerrainSets } from './assets/loader';
import { quatFromAxisAngle, quatRotateVec3, vec3Normalize, type Quat, type Vec3 } from './core/math';
import { createInputMapper } from './input/actions';
import { attachInputDevices } from './input/devices';
import type { ActionState, Transform } from './protocol/messages';
import { VehicleTelemetry } from './protocol/telemetry';
import { vehiclePoseFromNodes, type ChaseTarget } from './render/cameras/chase';
import { CameraDirector } from './render/cameras/director';
import { BeamView } from './render/debug/beamview';
import { createLightingStack } from './render/lighting';
import { patchMaterial } from './render/material';
import { createPostStack } from './render/post';
import { createRoadRenderer } from './render/roads';
import { createTerrainRenderer } from './render/terrain';
import {
  DEFAULT_QUALITY,
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  type PostStack,
  type QualityController,
  type RenderContext,
} from './render/types';
import { compileRig } from './sim/rig/builder';
import { softCube } from './sim/rig/testrigs';
import { buildVehicleRig } from './sim/vehicle/builder';
import { SEDAN } from './sim/vehicle/defs/sedan';
import { Hud } from './ui/hud';
import { LoadingScreen } from './ui/loading';
import { DEFAULT_LAYOUT } from './world/layout';
import { createTerrainSampler } from './world/sampler';
import type { TerrainData, TerrainSampler } from './world/types';

const LAYOUT = DEFAULT_LAYOUT;
/** First view (layout spawn id; overridable with ?spawn=<id>). */
const DEFAULT_SPAWN = 'highway';
const VEHICLE_ID = 1;
const CUBE_ID = 2;
/** Beam/node colour gain under the HDR post pipeline (see BeamView). */
const WIREFRAME_GAIN = 0.32;
const SLOW_MO_SCALE = 0.25;

const params = new URLSearchParams(location.search);
const loading = new LoadingScreen();

// ------------------------------------------------------------ renderer + context
const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
/** ?q=low|medium|high|ultra forces a preset for this page load (not persisted; tests, screenshots). */
const forcedLevel = ((q) => (isQualityLevel(q) ? q : null))(params.get('q'));
const startLevel = forcedLevel ?? loadQualityLevel() ?? DEFAULT_QUALITY;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_PRESETS[startLevel].pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2600);
scene.add(camera);

const ctx: RenderContext = {
  renderer,
  scene,
  camera,
  quality: QUALITY_PRESETS[startLevel],
  width: window.innerWidth,
  height: window.innerHeight,
  sampler: null,
};

// ------------------------------------------------------------ sim (heightfield first, never a plane)
const fatalBox = document.createElement('div');
fatalBox.className = 'fatal';
fatalBox.hidden = true;
document.body.appendChild(fatalBox);

const client = new SimClient({
  seed: 1234,
  gravity: [0, -9.81, 0],
  snapshotHz: 120,
  debugStrains: true,
  onFatal: (message) => {
    fatalBox.textContent = `Simulation stopped: ${message}`;
    fatalBox.hidden = false;
  },
});
// The worker regenerates in parallel with main's own copy; main compares the two hashes once both exist.
const physicsReady = client.groundHeightfield(LAYOUT, 0);

// Rest-pose facts of the sedan (pure build; same canonical order the worker uses).
const sedanDef = buildVehicleRig(SEDAN);
const sedanRig = compileRig(sedanDef);
const SEDAN_FRAME_ORIGIN = Math.max(0, sedanDef.nodes.findIndex((n) => n.id === SEDAN.frame.origin));
const cubeRig = compileRig(softCube());
const transmission = SEDAN.drivetrain.transmission ?? 'auto';

// ------------------------------------------------------------ state filled in by boot()
let terrain: TerrainData | null = null;
let sampler: TerrainSampler | null = null;
let quality: QualityController | null = null;
let post: PostStack | null = null;
let running = false;
let spawnIndex = 0;
let lastSpawn: Transform = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
/** After a reset/teleport: snap the chase camera once a snapshot past this tick shows the new pose (−1 = none). */
let snapAfterTick = -1;

const beamView = new BeamView({ gain: WIREFRAME_GAIN });
beamView.visible = true;
scene.add(beamView.group);

const director = new CameraDirector(camera, renderer.domElement, {
  initial: 'chase',
  chase: { groundHeight: (x, z) => (sampler ? sampler.heightAt(x, z) : 0) },
});

const mapper = createInputMapper({ transmission, gearCount: SEDAN.drivetrain.gearRatios.length });
let hud: Hud | null = null;
let paused = false;
let slowMo = false;
function applyTimescale(): void {
  client.setTimescale(paused ? 0 : slowMo ? SLOW_MO_SCALE : 1);
}

// ------------------------------------------------------------ vehicle pose
let positions = new Float32Array(0);
const pose = {
  position: new Vector3(),
  forward: new Vector3(0, 0, -1),
  up: new Vector3(0, 1, 0),
  velocity: new Vector3(),
} satisfies ChaseTarget;
let poseValid = false;

function findRange(objectId: number): ObjectRange | null {
  for (const r of client.objectRanges()) if (r.objectId === objectId) return r;
  return null;
}

function updateVehiclePose(): boolean {
  const info = client.vehicleInfo(VEHICLE_ID);
  const range = findRange(VEHICLE_ID);
  if (!info || !range || range.nodeCount !== info.nodeCount) return false;
  if (!vehiclePoseFromNodes(positions, range.nodeOffset, range.nodeCount, info.frameNodes, pose.position, pose.forward, pose.up)) {
    return false;
  }
  const t = client.telemetry(VEHICLE_ID);
  if (t) pose.velocity.set(t[VehicleTelemetry.velX]!, t[VehicleTelemetry.velY]!, t[VehicleTelemetry.velZ]!);
  else pose.velocity.set(0, 0, 0);
  if (!Number.isFinite(pose.velocity.x + pose.velocity.y + pose.velocity.z)) pose.velocity.set(0, 0, 0);
  return true;
}

/** The chase target a freshly placed sedan will have (camera setup before its first snapshot). */
function poseFromTransform(t: Transform, out: ChaseTarget): void {
  const o = SEDAN_FRAME_ORIGIN;
  const r = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [sedanRig.nodePos[3 * o]!, sedanRig.nodePos[3 * o + 1]!, sedanRig.nodePos[3 * o + 2]!]);
  out.position.set(t.pos[0] + r[0], t.pos[1] + r[1], t.pos[2] + r[2]);
  const f = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [0, 0, -1]);
  out.forward.set(f[0], f[1], f[2]);
  out.up.set(0, 1, 0);
  out.velocity.set(0, 0, 0);
}

// ------------------------------------------------------------ spawning
function spawnTransformAt(i: number): Transform {
  const s = terrain!.spawns[i]!;
  return placeOnGround(sedanRig, sampler!, s.pos[0], s.pos[2], s.yaw);
}

/** Teleport (full repair) to layout spawn point `i` (keys 1–8). */
function teleport(i: number): void {
  if (!terrain || i < 0 || i >= terrain.spawns.length) return;
  spawnIndex = i;
  lastSpawn = spawnTransformAt(i);
  client.reset(VEHICLE_ID, lastSpawn);
  lastSent.gearSelect = NaN; // force a full input resend
  snapAfterTick = client.latestTick;
  hud?.showToast(terrain.spawns[i]!.name.toUpperCase(), `SPAWN ${i + 1}`);
}

/** F: full repair in place (heading kept), dropped onto the terrain. */
function repairVehicle(): void {
  let t = lastSpawn;
  if (poseValid && sampler) {
    const f = pose.forward;
    const yaw = Math.hypot(f.x, f.z) > 0.2 ? yawOf(f.x, f.z) : 0;
    t = placeOnGround(sedanRig, sampler, pose.position.x, pose.position.z, yaw);
  }
  client.reset(VEHICLE_ID, t);
  lastSent.gearSelect = NaN;
  snapAfterTick = client.latestTick;
}

/** The soft cube: a target dropped in the crash-test arena, ahead of the arena spawn. */
function spawnCube(): void {
  const arena = terrain!.spawns.find((s) => s.id === 'arena');
  const x = arena ? arena.pos[0] : 360;
  const z = arena ? arena.pos[2] - 45 : 355;
  let ground = -Infinity;
  for (let i = 0; i < cubeRig.nodeCount; i++) {
    ground = Math.max(ground, sampler!.heightAt(x + cubeRig.nodePos[3 * i]!, z + cubeRig.nodePos[3 * i + 2]!));
  }
  const axis = vec3Normalize([0, 0, 0] as Vec3, [1, 0.35, 0.6]);
  client.spawn(CUBE_ID, softCube(), { pos: [x, ground + 3, z], quat: quatFromAxisAngle([0, 0, 0, 1] as Quat, axis, 0.45) });
}

// ------------------------------------------------------------ input plumbing
const lastSent: ActionState = { throttle: NaN, brake: NaN, steer: NaN, handbrake: NaN, clutch: NaN, gearSelect: NaN };
function sendInput(a: ActionState): void {
  if (
    a.throttle === lastSent.throttle &&
    a.brake === lastSent.brake &&
    a.steer === lastSent.steer &&
    a.handbrake === lastSent.handbrake &&
    a.clutch === lastSent.clutch &&
    a.gearSelect === lastSent.gearSelect
  ) {
    return;
  }
  Object.assign(lastSent, a);
  client.input(VEHICLE_ID, { ...a });
}

function handleCommands(): void {
  for (const c of mapper.drainCommands()) {
    switch (c) {
      case 'recover':
        client.recover(VEHICLE_ID);
        break;
      case 'repair':
        repairVehicle();
        break;
      case 'cameraCycle':
        director.cycle();
        break;
      case 'toggleBeamView':
        // Cycles beams → nodes (no body mesh until P4: never hide the car).
        beamView.cycle();
        break;
      case 'pause':
        paused = !paused;
        applyTimescale();
        break;
      case 'slowMo':
        slowMo = !slowMo;
        applyTimescale();
        break;
      case 'shiftUp':
      case 'shiftDown':
        // Manual gear stepping lives in the mapper (gearSelect).
        break;
    }
  }
}

// Spawn menu (1–8) and quality cycling (L); the driving keys go through the mapper.
window.addEventListener('keydown', (e) => {
  if (!running || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) {
    teleport(Number(m[1]) - 1);
    e.preventDefault();
  } else if (e.code === 'KeyL' && quality) {
    const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(quality.preset.level) + 1) % QUALITY_LEVELS.length]!;
    quality.setLevel(next);
    hud?.showToast(next.toUpperCase(), 'QUALITY', 1500);
  }
});

// ------------------------------------------------------------ debug/test global
const stats = { loadMs: 0, terrainMs: 0, physicsMs: 0, fps: 0, terrainMatched: false, stages: {} as Record<string, number> };
/** Test/screenshot hook: while true the loop skips frames (the sim keeps running); renderOnce draws one. */
let hold = false;
let renderOnce: (() => void) | null = null;
const crumple = {
  get tick(): number {
    return client.latestTick;
  },
  build: __BUILD_HASH__,
  get nodes(): number {
    return client.nodeTotal;
  },
  get snapshotHz(): number {
    return client.stats.snapshotHz;
  },
  idleRpm: SEDAN.drivetrain.idleRpm,
  /** True once the game loop runs (the loading screen is fading out). */
  get ready(): boolean {
    return running;
  },
  stats,
  /** Latest vehicle telemetry (subset), or null before the car appears. */
  get vehicle(): { speed: number; rpm: number; gear: number; damage: number } | null {
    const t = client.telemetry(VEHICLE_ID);
    if (!t) return null;
    const T = VehicleTelemetry;
    return { speed: t[T.speed]!, rpm: t[T.engineRpm]!, gear: t[T.gear]!, damage: t[T.damage]! };
  },
  /** Vehicle chassis position (world m), or null. */
  get position(): [number, number, number] | null {
    return poseValid ? [pose.position.x, pose.position.y, pose.position.z] : null;
  },
  get camera(): string {
    return director.mode;
  },
  /** True while the strain wireframe is shown. */
  get beamView(): boolean {
    return beamView.visible && beamView.mode === 'beams';
  },
  get viewMode(): string {
    return beamView.mode;
  },
  get nodesVisible(): boolean {
    return beamView.nodesVisible;
  },
  get timescale(): number {
    return paused ? 0 : slowMo ? SLOW_MO_SCALE : 1;
  },
  /** Layout spawn ids (keys 1–8 in this order). */
  get spawns(): string[] {
    return terrain ? terrain.spawns.map((s) => s.id) : [];
  },
  get spawnIndex(): number {
    return spawnIndex;
  },
  get quality(): { level: string; scale: number } | null {
    return quality ? { level: quality.preset.level, scale: quality.scale } : null;
  },
  /** Teleport to spawn point i (0-based, layout order). */
  spawn(i: number): void {
    teleport(i);
  },
  /** Screenshot helpers: hold the render loop, draw single frames on demand. */
  set hold(v: boolean) {
    hold = v;
  },
  get hold(): boolean {
    return hold;
  },
  renderOnce(): void {
    renderOnce?.();
  },
  /** Dev handles for tuning from the console (not a contract). */
  debug: { scene, camera, renderer, ctx } as Record<string, unknown>,
};
(window as unknown as { __crumple: typeof crumple }).__crumple = crumple;

window.addEventListener('resize', () => {
  ctx.width = window.innerWidth;
  ctx.height = window.innerHeight;
  camera.aspect = ctx.width / ctx.height;
  camera.updateProjectionMatrix();
  renderer.setSize(ctx.width, ctx.height);
  post?.setSize(ctx.width, ctx.height);
});

// ------------------------------------------------------------ boot
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function boot(): Promise<void> {
  const t0 = performance.now();
  physicsReady.then(
    (info) => {
      stats.physicsMs = info.generateMs;
      loading.set('physics', 'done');
    },
    () => loading.set('physics', 'error'),
  );
  const terrainP = loadTerrain(LAYOUT).then((r) => {
    stats.terrainMs = r.generateMs;
    loading.set('terrain', 'done');
    return r;
  });
  const materialsP = loadAllTerrainSets({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
  // Before any material compiles: the stack installs the height-fog chunks and CSM.
  const lightingP = createLightingStack(ctx);
  void Promise.all([materialsP, lightingP]).then(() => loading.set('textures', 'done'));

  const mark = (name: string): void => {
    stats.stages[name] = Math.round(performance.now() - t0);
  };
  const [loaded, materials, lighting] = await Promise.all([terrainP, materialsP, lightingP]);
  mark('assets+terrain');
  crumple.debug.lighting = lighting;
  const world = loaded.terrain;
  terrain = world;
  const smp = createTerrainSampler(world);
  sampler = smp;
  ctx.sampler = smp;
  await nextFrame();

  const postStack = createPostStack(ctx);
  post = postStack;
  const terrainR = createTerrainRenderer(ctx, world, materials, { lighting, patchMaterial });
  scene.add(terrainR.object);
  const roadsR = createRoadRenderer(ctx, world, smp, materials, { lighting, patchMaterial });
  scene.add(roadsR.object);
  const qc = createQualityControllerWith(
    ctx,
    { lighting, post: postStack, others: [terrainR, roadsR] },
    forcedLevel ? { initial: forcedLevel, storage: null } : {},
  );
  quality = qc;
  Object.assign(crumple.debug, { terrain: terrainR, roads: roadsR, post: postStack, director });
  mark('renderers');
  await nextFrame();

  // Physics: spawn only once the worker's heightfield is installed.
  const info = await physicsReady;
  stats.terrainMatched = info.terrainHash >>> 0 === world.hash >>> 0;
  if (!stats.terrainMatched) {
    console.error(
      `[world] terrain hash mismatch: physics 0x${(info.terrainHash >>> 0).toString(16)} vs render 0x${(world.hash >>> 0).toString(16)}`,
    );
  }
  mark('physics');
  loading.set('shaders', 'active');
  const wanted = params.get('spawn') ?? DEFAULT_SPAWN;
  spawnIndex = Math.max(0, world.spawns.findIndex((s) => s.id === wanted));
  lastSpawn = spawnTransformAt(spawnIndex);
  client.spawnVehicle(VEHICLE_ID, SEDAN, lastSpawn, transmission);
  spawnCube();

  // Camera at the spawn, the first view's LODs built and its programs compiled behind the overlay.
  const startPose = { position: new Vector3(), forward: new Vector3(), up: new Vector3(), velocity: new Vector3() } satisfies ChaseTarget;
  poseFromTransform(lastSpawn, startPose);
  director.snap();
  director.update(0, startPose);
  lighting.update(camera);
  terrainR.prime(camera);
  roadsR.update(camera);
  mark('prime');
  try {
    await renderer.compileAsync(scene, camera);
  } catch (e) {
    console.warn('[boot] compileAsync failed; programs compile on first draw', e);
  }
  mark('compile');
  postStack.render(0);
  await nextFrame();
  mark('firstRender');

  // Bounded wait for the sedan's first snapshot so the first visible frame shows it.
  const waitStart = performance.now();
  while (!findRange(VEHICLE_ID) && performance.now() - waitStart < 8000) await nextFrame();
  mark('vehicle');

  const devices = attachInputDevices(mapper);
  const hudView = new Hud(document.body, {
    idleRpm: SEDAN.drivetrain.idleRpm,
    redlineRpm: SEDAN.drivetrain.redlineRpm,
    revLimitRpm: SEDAN.drivetrain.revLimitRpm,
  });
  hud = hudView;

  const hudStatus = { paused: false, slowMo: false, camera: 'chase', transmission, beamView: true };
  const frame = (dt: number): void => {
    // Input → worker.
    devices.poll();
    const tel = client.telemetry(VEHICLE_ID);
    const speed = tel ? (tel[VehicleTelemetry.speed] ?? 0) : 0;
    sendInput(mapper.update(dt, speed));
    handleCommands();

    // Sim → interpolated nodes → beam view + camera subject.
    const need = client.nodeTotal * 3;
    if (positions.length < need) positions = new Float32Array(need);
    if (client.interpolate(client.renderTime(), positions) > 0) {
      beamView.update(client, positions);
      poseValid = updateVehiclePose();
    } else {
      poseValid = false;
    }
    client.drainEvents({}); // no FX consumers yet; keep the queue from saturating
    // Commands apply at the next step boundary: two snapshots later the pose is the reset one.
    if (snapAfterTick >= 0 && poseValid && client.latestTick > snapAfterTick + 40) {
      snapAfterTick = -1;
      director.snap();
    }

    director.update(dt, poseValid ? pose : null);
    lighting.update(camera);
    terrainR.update(camera);
    roadsR.update(camera);
    qc.frame(dt);
    postStack.render(dt);

    hudStatus.paused = paused;
    hudStatus.slowMo = slowMo;
    hudStatus.camera = director.mode;
    hudStatus.transmission = mapper.transmission;
    hudStatus.beamView = beamView.visible && beamView.mode === 'beams';
    hudView.update(client.telemetry(VEHICLE_ID), hudStatus, dt);
  };

  // One real frame under the overlay (shadow + post programs), then fade into the scene.
  frame(0);
  await nextFrame();
  mark('firstFrame');
  loading.set('shaders', 'done');
  stats.loadMs = performance.now() - t0;
  console.info(
    `[boot] ready in ${(stats.loadMs / 1000).toFixed(2)} s (terrain ${stats.terrainMs.toFixed(0)} ms ${loaded.worker ? 'in a worker' : 'on main'}, physics ${stats.physicsMs.toFixed(0)} ms)`,
  );

  let last = performance.now();
  let fpsEma = 0;
  renderOnce = () => {
    const now = performance.now();
    frame(Math.min(Math.max((now - last) / 1000, 0), 0.1));
    last = now;
  };
  const loop = (now: number): void => {
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
    last = now;
    if (hold) {
      requestAnimationFrame(loop);
      return;
    }
    frame(dt);
    if (dt > 0) fpsEma += (1 / dt - fpsEma) * 0.05;
    stats.fps = fpsEma;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  running = true;
  await loading.hide();
  hudView.showToast(world.spawns[spawnIndex]!.name.toUpperCase(), LAYOUT.name.toUpperCase(), 3200);
}

boot().catch((e: unknown) => {
  console.error('[boot] failed', e);
  loading.fail(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
});
