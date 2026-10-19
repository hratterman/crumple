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
import { MeshPhysicalMaterial, NoToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';

import { FrameProfiler, gpuSyncFn, PassCounter, perfGpuSync, perfRequested } from './app/perf';
import { anisotropyFor, createQualityControllerWith, isQualityLevel, isSoftwareRenderer, loadQualityLevel, SOFTWARE_GL_PIXEL_RATIO } from './app/quality';
import { SimClient, type ObjectRange } from './app/simClient';
import { placeOnGround, repairSpot, yawOf, type Aabb } from './app/spawn';
import { loadTerrain } from './app/world';
import { loadAllTerrainSets } from './assets/loader';
import { quatFromAxisAngle, quatRotateVec3, vec3Normalize, type Quat, type Vec3 } from './core/math';
import { createInputMapper } from './input/actions';
import { attachInputDevices } from './input/devices';
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from './protocol/events';
import { GAME_CAPACITY, isPropObjectId, type ActionState, type Transform } from './protocol/messages';
import { createVehicleTelemetryFrame, VehicleTelemetry } from './protocol/telemetry';
import { vehiclePoseFromNodes, type ChaseTarget } from './render/cameras/chase';
import { CameraDirector } from './render/cameras/director';
import { BeamView } from './render/debug/beamview';
import { createLightingStack, setNearCasters } from './render/lighting';
import { patchMaterial } from './render/material';
import { createPostStack } from './render/post';
import { createRoadRenderer } from './render/roads';
import { createTerrainRenderer, prebuildTerrainArrays, terrainAnisotropy, terrainTextureSize } from './render/terrain';
import { createFarLand, FARLAND_OUTER_M } from './render/terrain/farland';
import { createColliderRenderer } from './render/world/colliders';
import { createFxSystem } from './render/fx';
import type { FxSystem } from './render/fx/types';
import { createPropRenderer } from './render/props';
import type { PropRenderer } from './render/props/types';
import { createVegetationRenderer } from './render/vegetation';
import { createWaterRenderer } from './render/water';
import { bindPanels } from './render/vehicle/binder';
import { SEDAN_VISUAL } from './render/vehicle/defs/sedan';
import { createFlexSkin } from './render/vehicle/flexskin';
import { bodyVisibleIn, createVehicleVisual, VEHICLE_DEBUG_VIEWS, type VehicleDebugView, type VehicleVisualHandle } from './render/vehicle/index';
import { syntheticCubeSubject } from './render/vehicle/synthetic';
import type { FlexSkin, VehicleFrameInput, VehicleMaterialSet } from './render/vehicle/types';
import {
  DEFAULT_QUALITY,
  LAYER_NO_REFLECTION,
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  type PostStack,
  type QualityController,
  type RenderContext,
  type WorldFrame,
} from './render/types';
import { resolvePropInstances } from './sim/props/placement';
import { compileRig } from './sim/rig/builder';
import { softCube } from './sim/rig/testrigs';
import { buildVehicleRig, compileVehicle } from './sim/vehicle/builder';
import { SEDAN } from './sim/vehicle/defs/sedan';
import { Hud } from './ui/hud';
import { LoadingScreen } from './ui/loading';
import type { PerfOverlay, PerfOverlayData } from './ui/perfOverlay';
import { resolveColliders } from './world/colliders';
import { DEFAULT_LAYOUT } from './world/layout';
import { createTerrainSampler } from './world/sampler';
import { resolveWater } from './world/water';
import type { TerrainData, TerrainSampler } from './world/types';

const LAYOUT = DEFAULT_LAYOUT;
/** First view (layout spawn id; overridable with ?spawn=<id>). */
const DEFAULT_SPAWN = 'highway';
const VEHICLE_ID = 1;
const CUBE_ID = 2;
/** Beam/node colour gain under the HDR post pipeline (see BeamView). */
const WIREFRAME_GAIN = 0.26;
const SLOW_MO_SCALE = 0.25;

const params = new URLSearchParams(location.search);
const loading = new LoadingScreen();

// ------------------------------------------------------------ renderer + context
const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
function rendererString(r: WebGLRenderer): string {
  const gl = r.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
}
/** ?q=low|medium|high|ultra forces a preset for this page load (not persisted; tests, screenshots). */
const forcedLevel = ((q) => (isQualityLevel(q) ? q : null))(params.get('q'));
/** A software rasterizer (SwiftShader, llvmpipe: no usable GPU) starts on low unless the player chose a level. */
const softwareGl = isSoftwareRenderer(rendererString(renderer));
const startLevel = forcedLevel ?? loadQualityLevel() ?? (softwareGl ? 'low' : DEFAULT_QUALITY);
/** ?swcap=0 lifts the software-GL resolution cap (full-resolution screenshots under SwiftShader). */
const maxPixelRatio = softwareGl && params.get('swcap') !== '0' ? SOFTWARE_GL_PIXEL_RATIO : Infinity;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_PRESETS[startLevel].pixelRatioCap, maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
// Far plane: the far-land ring's outer edge seen from the opposite map corner.
const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, Math.ceil(FARLAND_OUTER_M + 704 * Math.SQRT2 + 200));
// P5: particles, skidmarks, grass and water live on this layer (excluded from the water's planar reflection).
camera.layers.enable(LAYER_NO_REFLECTION);
scene.add(camera);

// ------------------------------------------------------------ profiling (?perf=1 or the ` key)
const prof = new FrameProfiler(perfRequested(location.search));
const passCounter = new PassCounter(renderer);
if (perfGpuSync(location.search)) passCounter.sync = gpuSyncFn(renderer.getContext() as WebGL2RenderingContext);
/** The overlay UI is a lazily loaded chunk (dev / rare). */
let perfOverlay: PerfOverlay | null = null;
function setProfiling(on: boolean): void {
  prof.enabled = on;
  if (perfOverlay) perfOverlay.visible = on;
  else if (on) {
    void import('./ui/perfOverlay').then((m) => {
      perfOverlay ??= new m.PerfOverlay();
      perfOverlay.visible = prof.enabled;
    });
  }
  if (on) passCounter.attach();
  else passCounter.detach();
}
setProfiling(prof.enabled);

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
  // P5: layout props are separate objects (auto-spawned by the worker with the heightfield).
  capacity: GAME_CAPACITY,
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
/** The sedan as main renders it (same canonical order as the worker; triads index into it). */
const sedanCompiled = compileVehicle(SEDAN);
/** ?view=body|body+beams|beams|nodes picks the first debug view (B cycles them). */
const initialView = ((v) => (VEHICLE_DEBUG_VIEWS as readonly string[]).includes(v ?? '') ? (v as VehicleDebugView) : 'body')(params.get('view'));
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

// ------------------------------------------------------------ flexbody visuals (P4)
/** The sedan's body (null until boot builds it, or when the visual failed: then the wireframe stays on). */
let sedanVisual: VehicleVisualHandle | null = null;
/** The arena soft cube skinned as a rounded red block (synthetic subject on the softCube rig). */
let cubeSkin: FlexSkin | null = null;
let debugView: VehicleDebugView = initialView;

function applyDebugView(): void {
  if (!sedanVisual) {
    // No body mesh: never hide the car — the wireframe cycles beams ⇄ nodes.
    beamView.visible = true;
    if (debugView === 'nodes') beamView.mode = 'nodes';
    else beamView.mode = 'beams';
    return;
  }
  sedanVisual.setDebugView(debugView);
  if (cubeSkin) cubeSkin.object.visible = bodyVisibleIn(debugView);
  beamView.visible = debugView !== 'body';
  beamView.mode = debugView === 'nodes' ? 'nodes' : 'beams';
}

function cycleDebugView(): void {
  if (!sedanVisual) {
    debugView = debugView === 'nodes' ? 'beams' : 'nodes';
  } else {
    debugView = VEHICLE_DEBUG_VIEWS[(VEHICLE_DEBUG_VIEWS.indexOf(debugView) + 1) % VEHICLE_DEBUG_VIEWS.length]!;
  }
  applyDebugView();
}

function cubeMaterials(): VehicleMaterialSet {
  const paint = new MeshPhysicalMaterial({
    name: 'cubePaint',
    color: 0x8c0a12,
    metalness: 0.55,
    roughness: 0.34,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  return { base: () => paint, setPaint() {}, setLights() {}, dispose: () => paint.dispose() };
}

const sedanBroken = new Uint8Array(sedanCompiled.rig.beamCount);
const sedanTelemetry = createVehicleTelemetryFrame();
let sedanBrokenTick = -1;
const sedanFrame: VehicleFrameInput = {
  nodes: new Float32Array(0),
  nodeOffset: 0,
  tick: 0,
  broken: sedanBroken,
  repairEpoch: 0,
  telemetry: null,
  dtS: 0,
};
const cubeFrame: VehicleFrameInput = { ...sedanFrame, broken: new Uint8Array(cubeRig.beamCount), telemetry: null };

/** Feeds the interpolated nodes of this frame to the skinned bodies. */
function updateVisuals(dt: number): void {
  if (sedanVisual) {
    const range = findRange(VEHICLE_ID);
    const ok = !!range && range.nodeCount === sedanCompiled.rig.nodeCount;
    sedanVisual.object.visible = ok;
    if (ok) {
      const tick = client.latestTick;
      if (tick !== sedanBrokenTick) {
        sedanBrokenTick = tick;
        if (client.brokenBeams(VEHICLE_ID, sedanBroken) < 0) sedanBroken.fill(0);
      }
      sedanFrame.nodes = positions;
      sedanFrame.nodeOffset = range.nodeOffset;
      sedanFrame.tick = tick;
      sedanFrame.repairEpoch = client.repairEpoch(VEHICLE_ID);
      sedanFrame.telemetry = client.readTelemetry(VEHICLE_ID, sedanTelemetry) ? sedanTelemetry : null;
      sedanFrame.dtS = dt;
      sedanFrame.camera = camera;
      sedanVisual.update(sedanFrame);
    }
  }
  if (cubeSkin) {
    const range = findRange(CUBE_ID);
    const ok = !!range && range.nodeCount === cubeRig.nodeCount;
    cubeSkin.object.visible = ok && bodyVisibleIn(debugView);
    if (ok) {
      cubeFrame.nodes = positions;
      cubeFrame.nodeOffset = range.nodeOffset;
      cubeFrame.tick = client.latestTick;
      cubeFrame.dtS = dt;
      cubeSkin.update(cubeFrame);
    }
  }
}

/**
 * Shadow LOD: the sedan (~100 draws per cascade) only renders into the
 * cascades that hold its shadow's receivers: view depths within its camera
 * distance + NEAR_CASTER_REACH_M (body radius + a 16° sun's shadow length),
 * down to half of distance − reach (a receiver at the screen edge has a
 * smaller view depth than its distance).
 */
const NEAR_CASTER_REACH_M = 9;
const casterPos = new Vector3();
function updateNearCasters(lighting: Parameters<typeof setNearCasters>[0]): void {
  const root = sedanVisual ? sedanVisual.object : null;
  const d = sedanVisual ? camera.position.distanceTo(sedanVisual.skin.object.getWorldPosition(casterPos)) : 0;
  setNearCasters(lighting, renderer, camera, root, 0.5 * (d - NEAR_CASTER_REACH_M), d + NEAR_CASTER_REACH_M);
}

// ------------------------------------------------------------ P5 world layer (props, FX; set by boot())
let fx: FxSystem | null = null;
let props: PropRenderer | null = null;
let layoutPropCount = 0;
/** Spawn-pose AABBs of the layout props (F re-places them; see repairVehicle). */
let propBoxes: readonly Aabb[] = [];

/** Sim events → the sedan's damage, prop scuffs and world FX (allocation-free routing; every object's events reach FX). */
const eventSink = {
  impact(e: Readonly<ImpactEvent>): void {
    if (e.objectId === VEHICLE_ID) sedanVisual?.onImpact(e);
    else if (isPropObjectId(e.objectId)) props?.onImpact(e);
    fx?.onImpact(e);
  },
  beamBreak(e: Readonly<BeamBreakEvent>): void {
    if (e.objectId === VEHICLE_ID) sedanVisual?.onBeamBreak(e);
    else if (isPropObjectId(e.objectId)) props?.onBeamBreak(e);
    fx?.onBeamBreak(e);
  },
  skid(e: Readonly<SkidEvent>): void {
    if (e.objectId === VEHICLE_ID) sedanVisual?.onSkid(e);
    fx?.onSkid(e);
  },
};

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

/** Full repair at world (x, z) facing `yaw` (rad, 0 = −Z), dropped onto the terrain (tests, screenshots). */
function placeVehicle(x: number, z: number, yaw: number): void {
  if (!sampler) return;
  lastSpawn = placeOnGround(sedanRig, sampler, x, z, yaw);
  client.reset(VEHICLE_ID, lastSpawn);
  lastSent.gearSelect = NaN;
  snapAfterTick = client.latestTick;
}

/** F: full repair in place (heading kept), dropped onto the terrain. */
function repairVehicle(): void {
  let t = lastSpawn;
  if (poseValid && sampler) {
    const f = pose.forward;
    const yaw = Math.hypot(f.x, f.z) > 0.2 ? yawOf(f.x, f.z) : 0;
    // Props return to their spawn poses at the same time: never repair the car inside one's spawn box.
    t = propBoxes.length > 0 ? (repairSpot(sedanRig, sampler, pose.position.x, pose.position.z, yaw, propBoxes) ?? lastSpawn) : placeOnGround(sedanRig, sampler, pose.position.x, pose.position.z, yaw);
  }
  client.reset(VEHICLE_ID, t);
  lastSent.gearSelect = NaN;
  snapAfterTick = client.latestTick;
  // P5: F also rebuilds the arena (every layout prop repaired and re-placed asleep).
  if (layoutPropCount > 0) client.resetProps();
}

/** The soft cube: a target dropped in the crash-test arena, ahead of the arena spawn. */
function spawnCube(): void {
  const arena = terrain!.spawns.find((s) => s.id === 'arena');
  const x = arena ? arena.pos[0] : 360;
  const z = arena ? arena.pos[2] - 26 : 374;
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
        // body → body + beams → beams → nodes (beams ⇄ nodes when the body failed to build).
        cycleDebugView();
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
  } else if (e.code === 'Backquote') {
    setProfiling(!prof.enabled);
    e.preventDefault();
  } else if (e.code === 'KeyL' && quality) {
    const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(quality.preset.level) + 1) % QUALITY_LEVELS.length]!;
    quality.setLevel(next);
    hud?.showToast(next.toUpperCase(), 'QUALITY', 1500);
  }
});

function perfData(): PerfOverlayData {
  const info = renderer.info;
  return {
    profile: prof.snapshot(),
    gpu: passCounter.snapshot(),
    extra: {
      quality: quality ? `${quality.preset.level} ×${quality.scale.toFixed(2)}` : '-',
      buffer: `${renderer.domElement.width}×${renderer.domElement.height}`,
      programs: info.programs?.length ?? 0,
      'geometries/textures': `${info.memory.geometries}/${info.memory.textures}`,
    },
  };
}

// ------------------------------------------------------------ debug/test global
const stats = { loadMs: 0, terrainMs: 0, physicsMs: 0, fps: 0, terrainMatched: false, stages: {} as Record<string, number> };
/** Test/screenshot hook: while true the loop skips frames (the sim keeps running); renderOnce draws one. */
let hold = false;
let renderOnce: (() => void) | null = null;
/** Seconds of camera motion to simulate (30 Hz) on the next frame, after the sim pose is read (screenshots). */
let settleNext = 0;
/** Screenshot hook: a fixed world-space camera (pos, look-at target) instead of the director, or null. */
let pinnedCamera: { pos: [number, number, number]; target: [number, number, number] } | null = null;
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
  /** Debug view: 'body' | 'body+beams' | 'beams' | 'nodes'. */
  get viewMode(): string {
    return debugView;
  },
  get nodesVisible(): boolean {
    return beamView.nodesVisible;
  },
  /** True while the sedan's skinned body is drawn. */
  get bodyVisible(): boolean {
    return !!sedanVisual && sedanVisual.object.visible && bodyVisibleIn(debugView);
  },
  /** Flexbody bake facts for the sedan, or null when it has no body. */
  get body(): { panels: number; vertices: number; triangles: number; repaired: number; tessellateMs: number; bindMs: number; totalMs: number } | null {
    if (!sedanVisual) return null;
    const s = sedanVisual.binding.stats;
    return { panels: sedanVisual.binding.panels.length, vertices: s.vertices, triangles: s.triangles, repaired: s.repaired, ...sedanVisual.timings };
  },
  /** Set the debug view directly (screenshots / tests). */
  setView(v: string): void {
    if ((VEHICLE_DEBUG_VIEWS as readonly string[]).includes(v)) {
      debugView = v as VehicleDebugView;
      applyDebugView();
    }
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
  /** Full repair at world (x, z) facing `yawDeg` (0 = −Z, 90 = −X), on the ground. */
  place(x: number, z: number, yawDeg = 0): void {
    placeVehicle(x, z, (yawDeg * Math.PI) / 180);
  },
  /** Screenshot helpers: hold the render loop, draw single frames on demand. */
  set hold(v: boolean) {
    hold = v;
  },
  get hold(): boolean {
    return hold;
  },
  renderOnce(settleSeconds = 0): void {
    settleNext = settleSeconds;
    renderOnce?.();
  },
  /** Pin the camera at `pos` looking at `target` (world m; screenshots of the world, e.g. the arena props); null releases it to the director. */
  pinCamera(pos: [number, number, number] | null, target?: [number, number, number]): void {
    pinnedCamera = pos ? { pos: [pos[0], pos[1], pos[2]], target: target ? [target[0], target[1], target[2]] : [pos[0], pos[1], pos[2] - 1] } : null;
  },
  /** Prop renderer stats (instances, visible, awake sim objects, draws). */
  get props(): { instances: number; visibleInstances: number; awake: number; drawCalls: number } | null {
    return props ? { ...props.stats } : null;
  },
  /** Advance only the camera rig by `seconds` at 30 Hz (screenshots under software GL, where frames take seconds). */
  settleCamera(seconds: number): void {
    for (let t = 0; t < seconds; t += 1 / 30) director.update(1 / 30, poseValid ? pose : null);
  },
  /** Profiler snapshot (?perf=1 or the ` key; zeros while off). */
  get perf(): PerfOverlayData & { loadStages: Record<string, number> } {
    return { ...perfData(), loadStages: stats.stages };
  },
  /** Turn profiling (and the overlay) on/off. */
  setProfiling(on: boolean): void {
    setProfiling(on);
  },
  /** Dev handles for tuning from the console (not a contract). */
  debug: { scene, camera, renderer, ctx, client } as Record<string, unknown>,
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
  // Road ribbons sample these directly: anisotropic taps are the low preset's (and SwiftShader's) worst cost.
  const materialsP = loadAllTerrainSets({ anisotropy: anisotropyFor(startLevel, renderer.capabilities.getMaxAnisotropy()) });
  // Before any material compiles: the stack installs the height-fog chunks and CSM.
  const lightingP = createLightingStack(ctx);
  void Promise.all([materialsP, lightingP]).then(() => loading.set('textures', 'done'));

  const mark = (name: string): void => {
    stats.stages[name] = Math.round(performance.now() - t0);
  };
  // Loading-screen phases (ms since boot start; the perf overlay / ?perf=1 report them).
  void terrainP.then(() => mark('terrainGenerated'));
  void materialsP.then(() => mark('texturesLoaded'));
  void lightingP.then(() => mark('lightingReady'));
  void physicsReady.then(() => mark('physicsTerrain'));
  // Pack the terrain texture arrays while the terrain still generates in its worker (main is idle).
  let terrainDone = false;
  void terrainP.then(() => (terrainDone = true));
  void materialsP.then(async (m) => {
    await nextFrame();
    if (terrainDone) return; // the renderer builds them itself, on the critical path either way
    const level = ctx.quality.level;
    prebuildTerrainArrays(m, terrainTextureSize(level), terrainAnisotropy(level, renderer.capabilities.getMaxAnisotropy()));
    mark('terrainTexturesPacked');
  });
  const lighting = await lightingP;
  crumple.debug.lighting = lighting;
  const postStack = createPostStack(ctx);
  post = postStack;
  mark('postStack');

  // Flexbody bodies: built (tessellate + bind) while the terrain still generates in its worker (they
  // need only the lighting stack), then their programs start compiling in the GPU process right away.
  // ?body=0 skips them (wireframe only: perf comparisons, debugging the sim).
  const withBody = params.get('body') !== '0';
  try {
    if (!withBody) throw new Error('disabled by ?body=0');
    sedanVisual = createVehicleVisual(ctx, sedanCompiled, SEDAN_VISUAL, {
      lighting,
      patchMaterial,
      groundAt: (x, z) => (sampler ? sampler.heightAt(x, z) : 0),
    });
    sedanVisual.object.visible = false;
    scene.add(sedanVisual.object);
    const t = sedanVisual.timings;
    console.info(
      `[vehicle] sedan body: ${sedanVisual.binding.panels.length} panels, ${sedanVisual.binding.stats.vertices} verts, tessellate ${t.tessellateMs.toFixed(0)} ms, bind ${t.bindMs.toFixed(0)} ms, total ${t.totalMs.toFixed(0)} ms`,
    );
  } catch (e) {
    if (withBody) console.error('[vehicle] sedan body failed; showing the beam wireframe', e);
    sedanVisual = null;
  }
  try {
    if (!withBody) throw new Error('disabled by ?body=0');
    const cube = syntheticCubeSubject();
    cubeSkin = createFlexSkin(bindPanels(cube.compiled, cube.def, cube.geoms), {
      materials: cubeMaterials(),
      damage: null,
      lighting,
      patchMaterial,
      anchorNode: cube.compiled.frameNodes[0]!,
    });
    cubeSkin.object.visible = false;
    scene.add(cubeSkin.object);
  } catch (e) {
    if (withBody) console.error('[vehicle] soft cube skin failed', e);
    cubeSkin = null;
  }
  applyDebugView();
  Object.assign(crumple.debug, { sedanVisual, cubeSkin });
  if (sedanVisual) {
    // Vehicle internals (nested in the 'vehicle' lap); wrapping is free while profiling is off.
    prof.wrap(sedanVisual.damage, 'update', 'vehicle.damage');
    prof.wrap(sedanVisual.skin, 'update', 'vehicle.flexskin');
    prof.wrap(sedanVisual.wheels, 'update', 'vehicle.wheels');
    if (sedanVisual.fx) prof.wrap(sedanVisual.fx, 'update', 'vehicle.fx');
  }
  mark('vehicleVisual');
  // Off the critical path: compile the bodies' programs against the composer target (see compileAsync below).
  for (const obj of [sedanVisual?.object, cubeSkin?.object]) {
    if (!obj) continue;
    renderer.setRenderTarget(postStack.composer.inputBuffer);
    const p = renderer.compileAsync(obj, camera, scene);
    renderer.setRenderTarget(null);
    p.catch((e: unknown) => console.warn('[boot] vehicle program pre-compile failed', e));
  }
  await nextFrame();

  const [loaded, materials] = await Promise.all([terrainP, materialsP]);
  mark('assets+terrain');
  const world = loaded.terrain;
  terrain = world;
  const smp = createTerrainSampler(world);
  sampler = smp;
  ctx.sampler = smp;
  await nextFrame();

  const terrainR = createTerrainRenderer(ctx, world, materials, { lighting, patchMaterial });
  scene.add(terrainR.object);
  mark('terrainRenderer');
  stats.stages.terrainTextureMs = Math.round(terrainR.stats.textureMs);
  const roadsR = createRoadRenderer(ctx, world, smp, materials, { lighting, patchMaterial });
  scene.add(roadsR.object);
  mark('roadRenderer');
  scene.add(createFarLand(world, { lighting, patchMaterial }).object);
  // Static colliders (arena wall, poles, ramp, barriers): drawn exactly where the worker collides with them.
  const collidersR = createColliderRenderer(ctx, resolveColliders(LAYOUT.colliders, (x, z) => smp.heightAt(x, z)), {
    lighting,
    patchMaterial,
  });
  scene.add(collidersR.object);
  // P5 world layer (contracts: docs/CONTRACTS.md "P5 contracts"). Same pure inputs as the physics worker.
  const heightAt = (x: number, z: number): number => smp.heightAt(x, z);
  const waterBodies = resolveWater(LAYOUT, world);
  const propInstances = resolvePropInstances(LAYOUT.props, heightAt);
  layoutPropCount = propInstances.length;
  propBoxes = propInstances.map((p) => p.aabb);
  const propsR = createPropRenderer(ctx, propInstances, { lighting, patchMaterial });
  props = propsR;
  scene.add(propsR.object);
  const vegetationR = createVegetationRenderer(ctx, loaded.vegetation, world, smp, { lighting, patchMaterial });
  scene.add(vegetationR.object);
  const waterR = createWaterRenderer(ctx, waterBodies, world, { lighting, patchMaterial });
  scene.add(waterR.object);
  const fxR = createFxSystem(ctx, {
    lighting,
    patchMaterial,
    sampler: smp,
    terrain: world,
    water: waterBodies,
    telemetry: (id) => client.telemetry(id),
  });
  fx = fxR;
  scene.add(fxR.object);
  fxR.addVehicle(VEHICLE_ID, sedanCompiled);
  fxR.addProps(propInstances);
  stats.stages.vegetationMs = Math.round(loaded.vegetationMs);
  const qc = createQualityControllerWith(
    ctx,
    { lighting, post: postStack, others: [terrainR, roadsR, collidersR, propsR, vegetationR, waterR, fxR] },
    forcedLevel ? { initial: forcedLevel, storage: null, maxPixelRatio } : { maxPixelRatio },
  );
  quality = qc;
  Object.assign(crumple.debug, { terrain: terrainR, roads: roadsR, post: postStack, director, props: propsR, vegetation: vegetationR, water: waterR, fx: fxR, waterBodies, propInstances });
  mark('renderers');
  await nextFrame();

  // Physics: spawn only once the worker's heightfield is installed.
  const info = await physicsReady;
  stats.terrainMatched = info.terrainHash >>> 0 === world.hash >>> 0;
  if (info.vegetationHash !== undefined && info.vegetationHash >>> 0 !== loaded.vegetation.hash >>> 0) {
    console.error(
      `[world] vegetation hash mismatch: physics 0x${(info.vegetationHash >>> 0).toString(16)} vs render 0x${(loaded.vegetation.hash >>> 0).toString(16)}`,
    );
  }
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
    // Compile against the composer's HalfFloat target: programs key on the output colour space, and
    // compiling for the canvas (sRGB) built a second, never-used copy of every scene program.
    renderer.setRenderTarget(postStack.composer.inputBuffer);
    const compiled = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(null);
    await compiled;
  } catch (e) {
    console.warn('[boot] compileAsync failed; programs compile on first draw', e);
  }
  mark('compile');

  // Bounded wait for the sedan's first snapshot so the first visible frame shows it. No draw before
  // it: the one real frame below compiles the remaining (shadow, post) programs behind the overlay,
  // and a software rasterizer pays seconds per full frame.
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

  const hudStatus = { paused: false, slowMo: false, camera: 'chase', transmission, beamView: true, view: debugView as string };
  const bootTime = performance.now();
  const worldFrame: WorldFrame = {
    dtS: 0,
    time: 0,
    simTime: 0,
    timeScale: 1,
    camera,
    nodes: positions,
    interpolated: false,
    objects: [],
    tick: 0,
  };
  const frame = (dt: number): void => {
    prof.begin();
    // Input → worker.
    devices.poll();
    const tel = client.telemetry(VEHICLE_ID);
    const speed = tel ? (tel[VehicleTelemetry.speed] ?? 0) : 0;
    sendInput(mapper.update(dt, speed));
    handleCommands();
    prof.lap('input');

    // Sim → interpolated nodes → beam view + camera subject.
    const need = client.nodeTotal * 3;
    if (positions.length < need) positions = new Float32Array(need);
    const interpolated = client.interpolate(client.renderTime(), positions) > 0;
    prof.lap('interpolate');
    if (interpolated) {
      if (beamView.visible) beamView.update(client, positions);
      poseValid = updateVehiclePose();
      prof.lap('beamView+pose');
      updateVisuals(dt);
      prof.lap('vehicle');
      if (prof.enabled && sedanVisual) {
        // Upload the node texture here (it would happen inside the render) so its cost is visible.
        renderer.initTexture(sedanVisual.skin.nodeTexture);
        if (cubeSkin) renderer.initTexture(cubeSkin.nodeTexture);
        prof.lap('nodeTexUpload');
      }
    } else {
      poseValid = false;
    }
    client.drainEvents(eventSink);
    prof.lap('events');
    // Commands apply at the next step boundary: two snapshots later the pose is the reset one.
    if (snapAfterTick >= 0 && poseValid && client.latestTick > snapAfterTick + 40) {
      snapAfterTick = -1;
      director.snap();
    }

    if (settleNext > 0) {
      for (let t = 0; t < settleNext; t += 1 / 30) director.update(1 / 30, poseValid ? pose : null);
      settleNext = 0;
    }
    if (pinnedCamera) {
      camera.position.fromArray(pinnedCamera.pos);
      camera.lookAt(pinnedCamera.target[0], pinnedCamera.target[1], pinnedCamera.target[2]);
      camera.updateMatrixWorld();
    } else director.update(dt, poseValid ? pose : null);
    prof.lap('camera');
    lighting.update(camera);
    updateNearCasters(lighting);
    prof.lap('csm');
    terrainR.update(camera);
    prof.lap('terrain');
    roadsR.update(camera);
    prof.lap('roads');
    // P5 world layer: camera is final; water last (its planar reflection sees this frame's props/vegetation).
    worldFrame.dtS = dt;
    worldFrame.time = (performance.now() - bootTime) / 1000;
    worldFrame.simTime = client.renderTime();
    worldFrame.timeScale = paused ? 0 : slowMo ? SLOW_MO_SCALE : 1;
    worldFrame.nodes = positions;
    worldFrame.interpolated = interpolated;
    worldFrame.objects = client.objectRanges();
    worldFrame.tick = client.latestTick;
    propsR.update(worldFrame);
    prof.lap('props');
    vegetationR.update(worldFrame);
    prof.lap('vegetation');
    fxR.update(worldFrame);
    prof.lap('fx');
    waterR.update(worldFrame);
    prof.lap('water');
    qc.frame(dt);
    prof.lap('quality');
    if (passCounter.attached) {
      const csm = lighting.csm;
      if (csm) for (let i = 0; i < csm.lights.length; i++) passCounter.label(csm.lights[i]!.shadow.map, `csm${i}`);
      else passCounter.label(lighting.sun.shadow.map, 'sun');
      passCounter.watchPasses(postStack.composer.passes);
      passCounter.beginFrame();
    }
    postStack.render(dt);
    passCounter.endFrame();
    prof.lap('render');

    hudStatus.paused = paused;
    hudStatus.slowMo = slowMo;
    hudStatus.camera = director.mode;
    hudStatus.transmission = mapper.transmission;
    hudStatus.beamView = beamView.visible && beamView.mode === 'beams';
    hudStatus.view = debugView;
    hudView.update(client.telemetry(VEHICLE_ID), hudStatus, dt);
    prof.lap('hud');
    perfOverlay?.update(perfData);
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
      // Held frames (screenshots / tests) still take commands: F, R, X … act as soon as they are pressed.
      devices.poll();
      handleCommands();
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
