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
 *   - terrain/road renderers, post stack, quality controller; the player
 *     vehicle (P6: the persisted catalog choice, app/player.ts) spawns only
 *     after terrainReady; shaders compile and the first frames render
 *     behind the loading screen, which then offers "Choose your car" (first
 *     launch) and fades out.
 * Frame order follows render/types.ts: sim → camera → lighting → terrain /
 * roads → quality → post.
 *
 * P6 modes: 'drive' (the game loop), 'pause' (ui/pause.ts; timescale 0, the
 * world frame frozen behind the menu) and 'showroom' (ui/showroom + the
 * render/showroom studio drawn instead of the world, timescale 0).
 */
import { SIGNAL_TICK_HZ, signalAspect } from './world/signals';
import './style.css';
import { MeshPhysicalMaterial, NoToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import type { Mesh, Material } from 'three';

import { FrameProfiler, gpuSyncFn, PassCounter, perfGpuSync, perfRequested } from './app/perf';
import { anisotropyFor, createQualityControllerWith, isQualityLevel, isSoftwareRenderer, loadQualityLevel, SOFTWARE_GL_PIXEL_RATIO } from './app/quality';
import { SimClient, type ObjectRange } from './app/simClient';
import { createReplayController, FRAME_BODY_HIT, FRAME_PROP_HIT } from './app/replay';
import type { DamageState } from './render/vehicle/damage';
import type { PropVisualState } from './render/props/types';
import type { FxState } from './render/fx/types';
import { createTrafficController, type TrafficController } from './app/traffic';
import { placeOnGround, repairSpot, yawOf, yawOfQuat, type Aabb, type RestPose } from './app/spawn';
import { SPAWN_HOLD_BRAKE, SPAWN_HOLD_INPUT_EPS, SpawnHold } from './app/spawnHold';
import { chaseFramingFor, drivableEntry, hasStoredChoice, loadPlayerAssets, loadVehicleChoice, PlayerVehicle, saveVehicleChoice, speedoMax, type PlayerAssets } from './app/player';
import { chaseScale, loadSettings, saveSettings, trafficDensityFor, type GameSettings } from './app/settings';
import { DEFAULT_VEHICLE_ID, getVehicleEntry, PLAYER_VEHICLE_IDS, type VehicleChoice } from './game/catalog';
import { loadTerrain } from './app/world';
import { loadAllTerrainSets } from './assets/loader';
import { quatFromAxisAngle, quatRotateVec3, vec3Normalize, type Quat, type Vec3 } from './core/math';
import { createInputMapper } from './input/actions';
import { attachInputDevices } from './input/devices';
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from './protocol/events';
import { GAME_CAPACITY, isPropObjectId, SPAWN_SETTLE_S, type ActionState, type Transform } from './protocol/messages';
import { VehicleTelemetry } from './protocol/telemetry';
import { TRAFFIC_FLAG_BRAKE, TRAFFIC_FLAG_HEADLIGHTS, type TrafficAgentFrame } from './protocol/traffic';
import { DEFAULT_CHASE_OPTIONS, vehiclePoseFromNodes, type ChaseTarget } from './render/cameras/chase';
import { CameraDirector } from './render/cameras/director';
import { createAabbNearest, createAabbOccluder } from './render/cameras/occluder';
import { createRoadside } from './render/cameras/roadside';
import { BeamView } from './render/debug/beamview';
import { addEnvApiHook, envDebugApi, type EnvDebugApi } from './render/lighting/envApi';
import { ENV_UNIFORMS } from './render/lighting/envUniforms';
import type { HeadlightState } from './render/lighting/headlights';
import type { NightLights, TrafficLamp } from './render/lighting/nightLights';
import type { RainFrame } from './render/fx/rain';
import { createPuddleMap, PUDDLE_CELL_M } from './render/lighting/puddles';
import { patchMaterial } from './render/material';
import { createPostStack } from './render/post';
import { createRoadRenderer } from './render/roads';
import { createTerrainRenderer, prebuildTerrainArrays, terrainAnisotropy, terrainTextureSize } from './render/terrain';
import { createFarLand, FARLAND_OUTER_M } from './render/terrain/farland';
import type { ChallengeHost } from './app/challenges';
import type { FxSystem } from './render/fx/types';
import type { PropRenderer } from './render/props/types';
import { createStudio, type Studio } from './render/showroom/studio';
import { bindPanels } from './render/vehicle/binder';
import { createFlexSkin } from './render/vehicle/flexskin';
import { bodyVisibleIn, VEHICLE_DEBUG_VIEWS, type VehicleDebugView } from './render/vehicle/index';
import { syntheticCubeSubject } from './render/vehicle/synthetic';
import type { FlexSkin, VehicleFrameInput, VehicleMaterialSet } from './render/vehicle/types';
import {
  DEFAULT_QUALITY,
  LAYER_NO_REFLECTION,
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  type LightingStack,
  type PostStack,
  type QualityController,
  type RenderContext,
  type WorldFrame,
} from './render/types';
import { compilePropRig } from './sim/props/catalog';
import { resolvePropInstances } from './sim/props/placement';
import { compileRig } from './sim/rig/builder';
import { softCube } from './sim/rig/testrigs';
import type { TransmissionMode } from './sim/vehicle/types';
import { Hud, type HudVehicleSpec } from './ui/hud';
import { LoadingScreen } from './ui/loading';
import { PauseMenu, type QualityLevelName } from './ui/pause';
import { Showroom, type ShowroomStage } from './ui/showroom/showroom';
import { createReplaySession, type ReplaySession } from './ui/replay/session';
import type { PerfOverlay, PerfOverlayData } from './ui/perfOverlay';
import type { AudioPlayerInfo, AudioSystem } from './audio/types';
import { colliderWorldAabb, resolveColliders } from './world/colliders';
import { createTerrainSampler } from './world/sampler';
import { resolveWater } from './world/water';
import type { ColliderDef, TerrainData, TerrainSampler, WorldLayout } from './world/types';

/**
 * Layout v6: the map data (zones, roads, areas, POIs, stunt park) is its own chunk, fetched at
 * script start; boot() assigns LAYOUT before anything reads it (the app chunk stays < 500 kB).
 */
const layoutP: Promise<WorldLayout> = import('./world/layout').then((m) => m.DEFAULT_LAYOUT);
let LAYOUT: WorldLayout;
/** Layout + generated world-content colliders (what the worker installs before the vegetation). */
let worldColliders: readonly ColliderDef[] = [];
/** First view (layout spawn id; overridable with ?spawn=<id>). */
const DEFAULT_SPAWN = 'highway';
const VEHICLE_ID = 1;
const CUBE_ID = 2;
/** Beam/node colour gain under the HDR post pipeline (see BeamView). */
const WIREFRAME_GAIN = 0.26;
const SLOW_MO_SCALE = 0.25;
/** P6: traffic rng seed (fixed: same traffic every boot; replays record it with the setTraffic command). */
const TRAFFIC_SEED = 0x7a11c;
/** P6: how long a first launch's loading screen offers "Choose your car" before driving off, ms. */
const WELCOME_HOLD_MS = 9000;

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
const physicsReady = layoutP.then((layout) => client.groundHeightfield(layout, 0));
/**
 * P7 live replay (app/replay; R2's UI / cameras consume `replay` as a ReplayController). Records
 * every snapshot as it arrives; while `replay.active` the frame loop presents recorded frames and
 * sends the worker nothing.
 */
const replay = createReplayController({
  client,
  playerObjectId: 1,
  level: startLevel,
  build: __BUILD_HASH__,
  paintOf: (id) => (id === 1 && player ? player.palette.id : null),
  wheelsOf: (id) => (id === 1 ? playerHubs() : null),
});
/** Replay checkpoint domains (registration order = bit in primeFrame's `hits`): the player's damage, then the props. */
const REPLAY_DOMAIN_PLAYER_BIT = 1;
const REPLAY_DOMAIN_PROPS_BIT = 2;
replay.registerDomain({
  key: 'player',
  hitFlag: FRAME_BODY_HIT,
  save: (into) => {
    const pv = player ? player.visual : null;
    return pv ? pv.damage.saveState(into as DamageState | null) : null;
  },
  restore: (st, seed) => {
    const pv = player ? player.visual : null;
    if (pv && st) pv.damage.restoreState(st as DamageState, seed);
  },
});
/** Snapshot tick of the last event drain (the player's damage has consumed events up to it one frame later). */
let lastDrainTick = -1;
/** The player's wheel hubs (replay markers ignore tyre contacts), cached per player vehicle. */
let hubsFor: { p: unknown; hubs: { hubs: Int32Array; radius: number } } | null = null;
function playerHubs(): { hubs: Int32Array; radius: number } | null {
  if (!player) return null;
  if (hubsFor?.p !== player) {
    const w = player.assets.compiled.wheels;
    const hubs = new Int32Array(w.length * 2);
    w.forEach((x, k) => {
      hubs[2 * k] = x.hubI;
      hubs[2 * k + 1] = x.hubO;
    });
    hubsFor = { p: player, hubs: { hubs, radius: Math.max(...w.map((x) => x.radius)) } };
  }
  return hubsFor.hubs;
}

const cubeRig = compileRig(softCube());
/** ?view=body|body+beams|beams|nodes picks the first debug view (B cycles them). */
const initialView = ((v) => (VEHICLE_DEBUG_VIEWS as readonly string[]).includes(v ?? '') ? (v as VehicleDebugView) : 'body')(params.get('view'));

// ------------------------------------------------------------ P6: player vehicle choice + settings
/** Persisted (or ?vehicle= / ?paint=) choice; unknown / unbuilt ids fall back to the sedan. */
const bootChoice: VehicleChoice = loadVehicleChoice(location.search);
/** A first launch (nothing stored yet) is offered the showroom on the loading screen. */
const firstLaunch = !hasStoredChoice();
const settings: GameSettings = loadSettings();
/** Start loading the player's vehicle modules right away (dynamic chunks; overlaps the terrain). */
const bootAssetsP: Promise<PlayerAssets> = loadPlayerAssets(drivableEntry(bootChoice.id)).catch((e: unknown) => {
  console.error(`[vehicle] '${bootChoice.id}' failed to load; falling back to the sedan`, e);
  return loadPlayerAssets(getVehicleEntry(DEFAULT_VEHICLE_ID));
});
/** The live player vehicle (null until boot loads it). */
let player: PlayerVehicle | null = null;
let transmission: TransmissionMode = 'auto';
/** Confirmed vehicle swaps since boot (tests). */
let swapCount = 0;

// ------------------------------------------------------------ state filled in by boot()
let terrain: TerrainData | null = null;
let sampler: TerrainSampler | null = null;
let quality: QualityController | null = null;
let post: PostStack | null = null;
/** R-TYRE: the surface water last sent to the worker (setSurfaceWetness). */
const tyreWater = { wetness: 0, rain: 0 };
/** R-GFX: the world lighting stack (time of day + weather live on `lightingStack.env`). */
let lightingStack: LightingStack | null = null;
/** R-GFX night lights (light grid + the player's shadowed headlights), null before boot. */
let nightLights: NightLights | null = null;
/** R-GFX player headlight switch: 'auto' follows dusk / rain / fog; J cycles, K toggles high beam. */
let headlightMode: 'auto' | 'on' | 'off' = 'auto';
let highBeam = false;
const headState: HeadlightState = { on: false, high: false, brake: 0, reverse: false };
const trafficLampFrames: TrafficAgentFrame[] = [];
const trafficLamps: TrafficLamp[] = [];
let running = false;
let spawnIndex = 0;
let lastSpawn: Transform = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
/** After a reset/teleport: snap the chase camera once a snapshot past this tick shows the new pose (−1 = none). */
let snapAfterTick = -1;

const beamView = new BeamView({ gain: WIREFRAME_GAIN });
beamView.visible = true;
scene.add(beamView.group);

// ------------------------------------------------------------ flexbody visuals (P4)
/** The player's body (null until boot builds it, or when the visual failed: then the wireframe stays on). */
function playerVisual() {
  return player ? player.visual : null;
}
/** The arena soft cube skinned as a rounded red block (synthetic subject on the softCube rig). */
let cubeSkin: FlexSkin | null = null;
let debugView: VehicleDebugView = initialView;

function applyDebugView(): void {
  const sedanVisual = playerVisual();
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
  if (!playerVisual()) {
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

const cubeFrame: VehicleFrameInput = {
  nodes: new Float32Array(0),
  nodeOffset: 0,
  tick: 0,
  broken: new Uint8Array(cubeRig.beamCount),
  repairEpoch: 0,
  telemetry: null,
  dtS: 0,
};

/** Feeds the interpolated nodes of this frame to the skinned bodies. */
function updateVisuals(dt: number): void {
  player?.update(client, VEHICLE_ID, findRange(VEHICLE_ID), positions, dt, camera);
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
/** R-GFX: the lazily loaded lighting chunk (render/lighting/lazy.ts), set by boot(). */
let lightingMod: typeof import('./render/lighting/lazy') | null = null;
function updateNearCasters(lighting: LightingStack): void {
  if (!lightingMod) return;
  const sedanVisual = playerVisual();
  const root = sedanVisual ? sedanVisual.object : null;
  const d = sedanVisual ? camera.position.distanceTo(sedanVisual.skin.object.getWorldPosition(casterPos)) : 0;
  lightingMod.setNearCasters(lighting, renderer, camera, root, 0.5 * (d - NEAR_CASTER_REACH_M), d + NEAR_CASTER_REACH_M);
}

// ------------------------------------------------------------ P8 audio (src/audio, lazy chunk; set by boot())
let audio: AudioSystem | null = null;
/** The player facts the audio needs, cached per player vehicle. */
let audioPlayerFor: { p: PlayerVehicle; info: AudioPlayerInfo } | null = null;
function audioPlayerInfo(): AudioPlayerInfo | null {
  if (!player) return null;
  if (audioPlayerFor?.p !== player) {
    const a = player.assets;
    const hubs = playerHubs();
    audioPlayerFor = {
      p: player,
      info: {
        id: player.id,
        drivetrain: a.sim.drivetrain,
        hubs: hubs ? hubs.hubs : new Int32Array(0),
        wheelRadius: hubs ? hubs.radius : 0.33,
        length: a.entry.extent.max[2] - a.entry.extent.min[2],
      },
    };
  }
  return audioPlayerFor.info;
}

// ------------------------------------------------------------ P5 world layer (props, FX; set by boot())
let fx: FxSystem | null = null;
let props: PropRenderer | null = null;
/** P6 AI traffic (app/traffic.ts, T2); null until boot builds it. */
let traffic: TrafficController | null = null;
let layoutPropCount = 0;
/** Spawn-pose AABBs of the layout props (F re-places them; see repairVehicle). */
let propBoxes: readonly Aabb[] = [];

/**
 * Sim events → the sedan's damage, prop scuffs and world FX (allocation-free routing). Awake
 * traffic events reach FX through the traffic controller (it drops the spawn-contact burst of
 * a freshly promoted car).
 */
const eventSink = {
  impact(e: Readonly<ImpactEvent>): void {
    audio?.onImpact(e);
    if (e.objectId === VEHICLE_ID) playerVisual()?.onImpact(e);
    else if (isPropObjectId(e.objectId)) props?.onImpact(e);
    else if (traffic?.owns(e.objectId)) return traffic.onImpact(e);
    fx?.onImpact(e);
  },
  beamBreak(e: Readonly<BeamBreakEvent>): void {
    audio?.onBeamBreak(e);
    if (e.objectId === VEHICLE_ID) playerVisual()?.onBeamBreak(e);
    else if (isPropObjectId(e.objectId)) props?.onBeamBreak(e);
    else if (traffic?.owns(e.objectId)) return traffic.onBeamBreak(e);
    fx?.onBeamBreak(e);
  },
  skid(e: Readonly<SkidEvent>): void {
    audio?.onSkid(e);
    if (e.objectId === VEHICLE_ID) playerVisual()?.onSkid(e);
    else if (traffic?.owns(e.objectId)) return traffic.onSkid(e);
    fx?.onSkid(e);
  },
};

const director = new CameraDirector(camera, renderer.domElement, {
  initial: 'chase',
  chase: { groundHeight: (x, z) => (sampler ? sampler.heightAt(x, z) : 0) },
});

// Per-vehicle gear count / transmission are applied when the player vehicle loads (applyPlayerSpec).
const mapper = createInputMapper({ transmission });
let hud: Hud | null = null;
/** P7 (R2): replay UI, replay cameras, crash cam and photo mode (ui/replay/session.ts); null until boot. */
let replaySession: ReplaySession | null = null;
/** The player's hood-camera mount: on the bonnet just ahead of the windscreen, from the rig's rest pose + catalog extent. */
let hoodFor: { p: PlayerVehicle; mount: { up: number; forward: number } } | null = null;
function playerHoodMount(): { up: number; forward: number } | null {
  if (!player) return null;
  if (hoodFor?.p !== player) {
    const c = player.assets.compiled;
    const o = Math.max(0, c.frameNodes[0] ?? 0);
    const P = c.rig.nodePos;
    const ex = player.assets.entry.extent;
    // Rig frame: up +Y, forward −Z (extent.min z = the front bumper).
    const camY = ex.max[1] * 0.71;
    const camZ = ex.min[2] * 0.48;
    hoodFor = { p: player, mount: { up: camY - P[3 * o + 1]!, forward: -(camZ - P[3 * o + 2]!) } };
  }
  return hoodFor.mount;
}
let paused = false;
let slowMo = false;
/** Traction control (X); P6: every spawn starts with the settings' default. */
let tractionControl = settings.tractionControl;
function applyTimescale(): void {
  client.setTimescale(paused ? 0 : slowMo ? SLOW_MO_SCALE : 1);
}

/** P6 game mode: boot (loading), drive, pause (menu), showroom (studio instead of the world). */
type GameMode = 'boot' | 'drive' | 'pause' | 'showroom' | 'challenges';
let mode: GameMode = 'boot';

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

/** The chase target a freshly placed vehicle will have (camera setup before its first snapshot). */
function poseFromTransform(t: Transform, out: ChaseTarget, assets: PlayerAssets): void {
  const o = Math.max(0, assets.compiled.frameNodes[0] ?? 0);
  const rest = assets.compiled.rig.nodePos;
  const r = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [rest[3 * o]!, rest[3 * o + 1]!, rest[3 * o + 2]!]);
  out.position.set(t.pos[0] + r[0], t.pos[1] + r[1], t.pos[2] + r[2]);
  const f = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [0, 0, -1]);
  out.forward.set(f[0], f[1], f[2]);
  out.up.set(0, 1, 0);
  out.velocity.set(0, 0, 0);
}

// ------------------------------------------------------------ spawning
/** Rest pose of the current player rig (placement clearance). */
function playerRest() {
  return player!.assets.rest;
}

function spawnTransformAt(i: number, rest = playerRest()): Transform {
  const s = terrain!.spawns[i]!;
  return clearSpawnAt(rest, s.pos[0], s.pos[2], s.yaw);
}

/** Obstacles a spawn must clear: every other object of the latest snapshot near (x, z) (props where they lie now, the cube, awake traffic) as a bounding-sphere box. */
function liveObstacles(x: number, z: number): Aabb[] {
  const out: Aabb[] = [];
  const b = [0, 0, 0, 0];
  for (const r of client.objectRanges()) {
    if (r.objectId === VEHICLE_ID || !client.objectBounds(r.objectId, b)) continue;
    const [cx, cy, cz, rad] = b as [number, number, number, number];
    if (Math.abs(cx - x) > rad + 15 || Math.abs(cz - z) > rad + 15) continue;
    out.push([cx - rad, cy - rad, cz - rad, cx + rad, cy + rad, cz + rad]);
  }
  return out;
}

/**
 * Spawn / teleport pose at (x, z) facing `yaw`: on the ground plane under the
 * whole footprint (placeOnGround), moved back (then forward) along the
 * heading until it clears every other object where it lies now
 * (repairSpot); the spot itself when nothing within reach is clear.
 */
function clearSpawnAt(rest: RestPose, x: number, z: number, yaw: number): Transform {
  const boxes = liveObstacles(x, z);
  return (boxes.length > 0 ? repairSpot(rest, sampler!, x, z, yaw, boxes) : null) ?? placeOnGround(rest, sampler!, x, z, yaw);
}

/** Teleport (full repair) to layout spawn point `i` (keys 1–8). */
function teleport(i: number): void {
  if (!terrain || i < 0 || i >= terrain.spawns.length) return;
  spawnIndex = i;
  lastSpawn = spawnTransformAt(i);
  client.reset(VEHICLE_ID, lastSpawn, SPAWN_SETTLE_S);
  holdParked();
  lastSent.gearSelect = NaN; // force a full input resend
  snapAfterTick = client.latestTick;
  replaySession?.quietCrashCam(); // P7: the drop onto the spawn is not a crash
  hud?.showToast(terrain.spawns[i]!.name.toUpperCase(), `SPAWN ${i + 1}`);
}

/** Full repair at world (x, z) facing `yaw` (rad, 0 = −Z), dropped onto the terrain (tests, screenshots). */
function placeVehicle(x: number, z: number, yaw: number): void {
  if (!sampler) return;
  lastSpawn = placeOnGround(playerRest(), sampler, x, z, yaw);
  client.reset(VEHICLE_ID, lastSpawn, SPAWN_SETTLE_S);
  holdParked();
  lastSent.gearSelect = NaN;
  snapAfterTick = client.latestTick;
  replaySession?.quietCrashCam();
}

/** F: full repair in place (heading kept), dropped onto the terrain. */
function repairVehicle(): void {
  let t = lastSpawn;
  if (poseValid && sampler && player) {
    const sedanRig = playerRest();
    const f = pose.forward;
    const yaw = Math.hypot(f.x, f.z) > 0.2 ? yawOf(f.x, f.z) : 0;
    // Props return to their spawn poses at the same time: never repair the car inside one's spawn box.
    t = propBoxes.length > 0 ? (repairSpot(sedanRig, sampler, pose.position.x, pose.position.z, yaw, propBoxes) ?? lastSpawn) : placeOnGround(sedanRig, sampler, pose.position.x, pose.position.z, yaw);
  }
  client.reset(VEHICLE_ID, t, SPAWN_SETTLE_S);
  holdParked();
  lastSent.gearSelect = NaN;
  snapAfterTick = client.latestTick;
  replaySession?.quietCrashCam();
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
/** Parking-brake hold after every placement of the player car (spawn, teleport, F, DRIVE, challenge start) until the player touches a control. */
const spawnHold = new SpawnHold();
/** Arms the hold and sends it right away (held render loops send no per-frame input; the input log carries it either way). */
function holdParked(): void {
  spawnHold.arm();
  client.input(VEHICLE_ID, { handbrake: 1, brake: SPAWN_HOLD_BRAKE });
}
const lastSent: ActionState = { throttle: NaN, brake: NaN, steer: NaN, handbrake: NaN, clutch: NaN, gearSelect: NaN, horn: NaN };
function sendInput(a: ActionState): void {
  if (
    a.throttle === lastSent.throttle &&
    a.brake === lastSent.brake &&
    a.steer === lastSent.steer &&
    a.handbrake === lastSent.handbrake &&
    a.clutch === lastSent.clutch &&
    a.gearSelect === lastSent.gearSelect &&
    a.horn === lastSent.horn
  ) {
    return;
  }
  Object.assign(lastSent, a);
  client.input(VEHICLE_ID, { ...a });
}

function setTractionControl(on: boolean): void {
  tractionControl = on;
  client.setAssists(VEHICLE_ID, { tractionControl: on });
  hud?.showToast(on ? 'TRACTION CONTROL ON' : 'TRACTION CONTROL OFF', 'ASSISTS', 1500);
}

function handleCommands(): void {
  for (const c of mapper.drainCommands()) {
    // P8: F / R restart a running challenge
    if (challenges?.onCommand(c)) continue;
    switch (c) {
      case 'recover':
        client.recover(VEHICLE_ID);
        replaySession?.quietCrashCam();
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
        // P6: P / Escape / Start open the pause menu (the sim pauses while it is open).
        openPause();
        break;
      case 'slowMo':
        slowMo = !slowMo;
        applyTimescale();
        break;
      case 'toggleTractionControl':
        setTractionControl(!tractionControl);
        break;
      case 'replay':
        // P7: Backspace / D-pad right opens the live replay (its UI takes the keyboard while open).
        replaySession?.toggleReplay();
        break;
      case 'shiftUp':
      case 'shiftDown':
        // Manual gear stepping lives in the mapper (gearSelect).
        break;
    }
  }
}

/** P7: discrete commands while the replay is shown (nothing may reach the paused worker). */
function handleReplayCommands(): void {
  for (const c of mapper.drainCommands()) {
    switch (c) {
      case 'cameraCycle':
        director.cycle();
        break;
      case 'toggleBeamView':
        cycleDebugView();
        break;
      case 'pause':
        // P / Escape / Start leave the replay (R2's UI may rebind)
        void replay.exit();
        break;
      default:
        break;
    }
  }
}

// Spawn menu (1–8) and quality cycling (L); the driving keys go through the mapper.
window.addEventListener('keydown', (e) => {
  if (!running || mode !== 'drive' || replay.active || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) {
    challenges?.quit(); // P8: teleporting abandons a challenge
    teleport(Number(m[1]) - 1);
    e.preventDefault();
  } else if (e.code === 'Backquote') {
    setProfiling(!prof.enabled);
    e.preventDefault();
  } else if (e.code === 'KeyJ') {
    // R-GFX headlights: auto → on → off
    headlightMode = headlightMode === 'auto' ? 'on' : headlightMode === 'on' ? 'off' : 'auto';
    hud?.showToast(`HEADLIGHTS ${headlightMode.toUpperCase()}`, 'J', 1400);
  } else if (e.code === 'KeyK') {
    highBeam = !highBeam;
    hud?.showToast(highBeam ? 'HIGH BEAM' : 'LOW BEAM', 'K', 1400);
  } else if (e.code === 'KeyL' && quality) {
    const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(quality.preset.level) + 1) % QUALITY_LEVELS.length]!;
    quality.setLevel(next);
    hud?.showToast(next.toUpperCase(), 'QUALITY', 1500);
  }
});

// ------------------------------------------------------------ P6: settings, player spec, swap, menus
/** HUD gauges for the current vehicle (redline from its drivetrain, speedo from its catalog top speed). */
function hudSpecFor(assets: PlayerAssets): HudVehicleSpec {
  const d = assets.sim.drivetrain;
  return {
    idleRpm: d.idleRpm,
    redlineRpm: d.redlineRpm,
    revLimitRpm: d.revLimitRpm,
    speedoMax: speedoMax(assets.entry.stats.topSpeedKmh, settings.units),
    units: settings.units,
  };
}

/** Chase framing: catalog distance/height × the near/normal/far setting, look height scaled with it. */
function applyChaseFraming(assets: PlayerAssets): void {
  const f = chaseFramingFor(assets.entry, chaseScale(settings.chase));
  const lookHeight = DEFAULT_CHASE_OPTIONS.lookHeight * (assets.entry.chase.height / DEFAULT_CHASE_OPTIONS.height);
  director.chase.setFraming({ distance: f.distance, height: f.height, lookHeight, baseFov: settings.fov });
}

/** Mapper / HUD / camera for the current player vehicle. */
function applyPlayerSpec(assets: PlayerAssets): void {
  transmission = assets.sim.drivetrain.transmission ?? 'auto';
  mapper.setTransmission(transmission);
  mapper.setGearCount(assets.sim.drivetrain.gearRatios.length);
  hud?.setSpec(hudSpecFor(assets));
  applyChaseFraming(assets);
  applyLampMounts(assets);
}

/** R-GFX: the player's lamp positions for the headlight spots / light grid. */
function applyLampMounts(assets: PlayerAssets): void {
  if (!nightLights || !lightingMod) return;
  const o = Math.max(0, assets.compiled.frameNodes[0] ?? 0);
  const rest = assets.compiled.rig.nodePos;
  nightLights.setPlayerMounts(lightingMod.lampMountsFor(assets.visual, [rest[3 * o]!, rest[3 * o + 1]!, rest[3 * o + 2]!]));
}

/** Traffic density for a preset under the player's traffic setting (the quality controller and the menu both route here). */
let trafficStarted = false;
function trafficPreset(q: (typeof QUALITY_PRESETS)[keyof typeof QUALITY_PRESETS]) {
  const d = trafficDensityFor(q.traffic, settings.traffic);
  // P8: a running challenge caps the agents (most run with none)
  return { ...q, traffic: challengeTraffic === null ? d : { ...d, agents: Math.min(d.agents, challengeTraffic) } };
}
/** P8: traffic agents allowed while a challenge runs (null = the player's setting). */
let challengeTraffic: number | null = null;
function startTraffic(): void {
  if (!traffic || trafficStarted || settings.traffic === 'off' || params.get('traffic') === '0') return;
  trafficStarted = true;
  const t = traffic;
  void t.start(TRAFFIC_SEED).then((on) => {
    console.info(`[traffic] ${on ? 'running' : 'off'}`);
    if (on) t.setQuality(trafficPreset(ctx.quality));
  });
}

function setSetting(patch: Partial<GameSettings>): void {
  Object.assign(settings, patch);
  saveSettings(settings);
  if (patch.units !== undefined && player) hud?.setSpec(hudSpecFor(player.assets));
  if ((patch.chase !== undefined || patch.fov !== undefined) && player) applyChaseFraming(player.assets);
  if (patch.tractionControl !== undefined && patch.tractionControl !== tractionControl) setTractionControl(patch.tractionControl);
  if (patch.traffic !== undefined) {
    if (trafficStarted) traffic?.setQuality(trafficPreset(ctx.quality));
    else startTraffic();
  }
  // R-GFX time of day / weather
  const env = lightingStack?.env;
  if (env) {
    if (patch.timeOfDay !== undefined) env.setTime(patch.timeOfDay);
    if (patch.timeSpeed !== undefined) env.setTimeSpeed(patch.timeSpeed);
    if (patch.weather !== undefined) env.setWeather(patch.weather);
  }
}

/** The paint material actually drawn on the player body (tests: the swap really recoloured it). */
function playerPaintHex(): number | null {
  const v = playerVisual();
  if (!v) return null;
  let hex: number | null = null;
  v.skin.object.traverse((o) => {
    if (hex !== null) return;
    const m = (o as Mesh).material as Material | Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (/^crPaint/.test(mat.name) && (mat as MeshPhysicalMaterial).color) {
        hex = (mat as MeshPhysicalMaterial).color.getHex();
        return;
      }
    }
  });
  return hex;
}

/** Creates the player visual for `assets` (hidden; added to the scene), or null with ?body=0 / on failure. */
let visualDeps: ConstructorParameters<typeof PlayerVehicle>[2] = null;
function wrapProfiling(p: PlayerVehicle): void {
  const v = p.visual;
  if (!v) return;
  // Vehicle internals (nested in the 'vehicle' lap); wrapping is free while profiling is off.
  prof.wrap(v.damage, 'update', 'vehicle.damage');
  prof.wrap(v.skin, 'update', 'vehicle.flexskin');
  prof.wrap(v.wheels, 'update', 'vehicle.wheels');
  if (v.fx) prof.wrap(v.fx, 'update', 'vehicle.fx');
}

/**
 * Replaces the player car (Drive in the showroom): the new body is built and
 * its programs compiled first (the old car keeps driving / the showroom keeps
 * rendering), then objectId 1 is despawned and respawned with the new def at
 * spawn point `spawnIndex` (or the current one), placed by the new rig's
 * clearance; FX / HUD / input / chase framing follow, the old visual is
 * disposed. Traffic keeps its focus (objectId 1).
 */
async function swapVehicle(choice: VehicleChoice, spawnAt: number | null): Promise<void> {
  if (!terrain || !sampler || !player) throw new Error('swapVehicle before boot');
  const entry = drivableEntry(choice.id);
  const assets = await loadPlayerAssets(entry);
  const next = new PlayerVehicle(assets, choice.palette, visualDeps);
  const obj = next.object;
  if (obj && post) {
    scene.add(obj);
    try {
      renderer.setRenderTarget(post.composer.inputBuffer);
      const p = renderer.compileAsync(obj, camera, scene);
      renderer.setRenderTarget(null);
      await p;
    } catch (e) {
      console.warn('[vehicle] swap pre-compile failed; programs compile on first draw', e);
    }
  }
  // Swap: despawn + spawn the same objectId (no frame in between sees both).
  const old = player;
  client.despawn(VEHICLE_ID);
  fx?.removeObject(VEHICLE_ID);
  old.dispose();
  player = next;
  wrapProfiling(next);
  if (spawnAt !== null && spawnAt >= 0 && spawnAt < terrain.spawns.length) {
    spawnIndex = spawnAt;
    lastSpawn = spawnTransformAt(spawnAt, assets.rest);
  } else {
    lastSpawn = clearSpawnAt(assets.rest, lastSpawn.pos[0], lastSpawn.pos[2], yawOfQuat(lastSpawn.quat));
  }
  applyPlayerSpec(assets);
  client.spawnVehicle(VEHICLE_ID, assets.sim, lastSpawn, transmission, entry.id, SPAWN_SETTLE_S);
  holdParked();
  replaySession?.quietCrashCam();
  tractionControl = settings.tractionControl;
  if (!tractionControl) client.setAssists(VEHICLE_ID, { tractionControl: false });
  fx?.addVehicle(VEHICLE_ID, assets.compiled);
  applyDebugView();
  lastSent.gearSelect = NaN;
  poseValid = false;
  snapAfterTick = client.latestTick;
  director.snap();
  saveVehicleChoice({ id: entry.id, palette: next.palette.id });
  swapCount++;
  Object.assign(crumple.debug, { cubeSkin });
}

// ---- menus
let pauseMenu: PauseMenu | null = null;
let showroom: Showroom | null = null;
let studio: Studio | null = null;
/** Where the showroom returns on Back. */
let showroomFrom: 'pause' | 'loading' = 'pause';
/** Re-render the frozen world once (behind the pause menu: resize, quality change). */
let redrawPaused = false;

function enterMenuMode(m: 'pause' | 'showroom' | 'challenges'): void {
  mode = m;
  mapper.releaseAll();
  paused = true;
  applyTimescale();
}

// ---- P8 stunt challenges (lazy chunk: app/challenges + game/ui/render challenges)
let challenges: ChallengeHost | null = null;
let challengesP: Promise<ChallengeHost> | null = null;
let challengesFrom: 'pause' | 'loading' | 'drive' = 'pause';
/** The driving input after the challenge filter (the mapper's object is never mutated). */
const challengeInput: ActionState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1 };
let challengeDepsP: (() => Parameters<typeof import('./app/challenges').createChallengeHost>[0]) | null = null;

function loadChallenges(): Promise<ChallengeHost> {
  challengesP ??= import('./app/challenges').then((m) => {
    if (!challengeDepsP) throw new Error('challenges before boot');
    challenges = m.createChallengeHost(challengeDepsP());
    return challenges;
  });
  return challengesP;
}

/** Opens the challenge select (world paused behind it, like the pause menu). */
function openChallenges(from: 'pause' | 'loading' | 'drive'): void {
  void loadChallenges().then((h) => {
    if (mode === 'showroom' || mode === 'boot') return;
    challengesFrom = from;
    pauseMenu?.close();
    enterMenuMode('challenges');
    h.openSelect();
  });
}

/** The select screen closed: back to where it came from, or drive (a challenge starts). */
function challengesClosed(reason: 'start' | 'back'): void {
  if (mode !== 'challenges') return;
  if (reason === 'back' && challengesFrom === 'pause' && pauseMenu) {
    mode = 'pause';
    redrawPaused = true;
    pauseMenu.open('challenges');
  } else resume();
}

function openPause(): void {
  if (mode !== 'drive' || !pauseMenu) return;
  enterMenuMode('pause');
  pauseMenu.open();
}

function resume(): void {
  if (mode !== 'pause' && mode !== 'showroom' && mode !== 'challenges') return;
  pauseMenu?.close();
  if (showroom?.isOpen) closeShowroom();
  mapper.releaseAll();
  lastSent.gearSelect = NaN;
  paused = false;
  applyTimescale();
  mode = 'drive';
  // P8: after the mode change (challengesClosed then leaves the mode alone)
  if (challenges?.selectOpen) challenges.closeSelect();
}

function openShowroom(from: 'pause' | 'loading'): void {
  if (!showroom || !player || mode === 'showroom') return;
  showroomFrom = from;
  pauseMenu?.close();
  enterMenuMode('showroom');
  hud?.setVisible(false);
  void showroom.open({ id: player.id as VehicleChoice['id'], palette: player.palette.id }, spawnIndex);
}

function closeShowroom(): void {
  showroom?.close();
  hud?.setVisible(true);
  // The studio owns GPU memory (its composer, env map, visuals): freed on every close.
  studio?.dispose();
  studio = null;
  post?.setSize(ctx.width, ctx.height);
  camera.aspect = ctx.width / ctx.height;
  camera.updateProjectionMatrix();
}

/** Showroom Back: to the pause menu (opened from it) or straight into the drive (from the loading screen). */
function showroomBack(): void {
  closeShowroom();
  if (showroomFrom === 'pause' && pauseMenu) {
    mode = 'pause';
    redrawPaused = true;
    pauseMenu.open('vehicle');
  } else resume();
}

/** Discrete commands while a menu is open: only pause (Start / P via the mapper) acts. */
function handleMenuCommands(): void {
  for (const c of mapper.drainCommands()) {
    if (c !== 'pause') continue;
    if (mode === 'pause') resume();
    else if (mode === 'showroom') showroom?.back();
    else if (mode === 'challenges') challenges?.closeSelect();
  }
}

/** The studio stage behind the showroom UI (created on open, disposed on close). */
const stage: ShowroomStage = {
  async show(id, paint) {
    const entry = getVehicleEntry(id);
    const assets = await loadPlayerAssets(entry);
    if (!studio) return;
    await studio.setVehicle({ id, compiled: assets.compiled, visual: assets.visual, paint, extent: entry.extent });
  },
  paint: (p) => studio?.setPaint(p),
  orbit: (dx, dy) => studio?.orbit(dx, dy),
  zoom: (d) => studio?.zoom(d),
  intro: () => studio?.intro(),
  setFraming: (x, y, fill) => studio?.setFraming(x, y, fill),
  frame: (dt) => studio?.frame(dt),
  resize: (w, h) => studio?.setSize(w, h),
};

function createMenus(): void {
  const spawns = () => (terrain ? terrain.spawns.map((s) => ({ id: s.id, name: s.name })) : []);
  pauseMenu = new PauseMenu(document.body, {
    spawns,
    spawnIndex: () => spawnIndex,
    vehicle: () => {
      const e = player ? player.assets.entry : getVehicleEntry(DEFAULT_VEHICLE_ID);
      return { name: e.stats.name, className: e.stats.class, paint: player ? player.palette.name : e.palettes[0]!.name };
    },
    settings: () => settings,
    quality: () => (quality ? quality.preset.level : ctx.quality.level) as QualityLevelName,
    onResume: resume,
    onChooseVehicle: () => openShowroom('pause'),
    onSpawn: (i) => {
      resume();
      challenges?.quit();
      teleport(i);
    },
    onRestart: () => {
      resume();
      if (challenges?.active) return challenges.restart(); // P8: restart the running challenge
      teleport(spawnIndex);
      if (layoutPropCount > 0) client.resetProps();
      fx?.clear();
    },
    onSettings: setSetting,
    onQuality: (level) => {
      if (!quality || quality.preset.level === level) return;
      quality.setLevel(level);
      redrawPaused = true;
    },
    // P7 (R2): replay + photo mode from the menu.
    onReplay: () => {
      resume();
      void replaySession?.enterReplay();
    },
    onPhoto: () => {
      resume();
      void replaySession?.enterPhoto();
    },
    replayInfo: () => ({ seconds: replay.duration, crashes: replay.markers().length }),
    // P8: stunt challenges
    onChallenges: () => openChallenges('pause'),
    challengeActive: () => (challenges?.active ? challenges.activeName : null),
    onChallengeRestart: () => {
      resume();
      challenges?.restart();
    },
    onChallengeQuit: () => {
      resume();
      challenges?.quit();
    },
  });
  showroom = new Showroom(document.body, {
    entries: PLAYER_VEHICLE_IDS.map((id) => getVehicleEntry(id)),
    spawns,
    units: () => settings.units,
    stage: async () => {
      // ?sq=<level> renders the studio at another preset than the world (screenshots under software GL).
      const sq = params.get('sq');
      const studioQuality = isQualityLevel(sq) ? QUALITY_PRESETS[sq] : ctx.quality;
      studio ??= createStudio(renderer, { quality: studioQuality, width: ctx.width, height: ctx.height, patchMaterial });
      Object.assign(crumple.debug, { studio });
      return stage;
    },
    onDrive: async (choice, si) => {
      await swapVehicle(choice, si);
      resume();
      const e = getVehicleEntry(choice.id);
      hud?.showToast(e.stats.name.toUpperCase(), terrain ? terrain.spawns[spawnIndex]!.name.toUpperCase() : '', 3000);
    },
    onBack: showroomBack,
  });
}

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
  get idleRpm(): number {
    return player ? player.assets.sim.drivetrain.idleRpm : 0;
  },
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
    const sedanVisual = playerVisual();
    return !!sedanVisual && sedanVisual.object.visible && bodyVisibleIn(debugView);
  },
  /** Flexbody bake facts for the player vehicle, or null when it has no body. */
  get body(): { panels: number; vertices: number; triangles: number; repaired: number; tessellateMs: number; bindMs: number; totalMs: number } | null {
    const sedanVisual = playerVisual();
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
  /** Traction control state (X toggles it). */
  get tractionControl(): boolean {
    return tractionControl;
  },
  setTractionControl(on: boolean): void {
    setTractionControl(on);
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
  // ---- P6 (S1): modes, player vehicle, menus, settings
  /** 'boot' | 'drive' | 'pause' | 'showroom'. */
  get mode(): GameMode {
    return mode;
  },
  get paused(): boolean {
    return paused;
  },
  /** The player's vehicle: catalog id, palette, the paint colour actually drawn (sRGB hex), swaps since boot. */
  get player(): { id: string; palette: string; paletteName: string; paletteHex: number; paintHex: number | null; nodes: number; swaps: number; transmission: string } | null {
    if (!player) return null;
    return {
      id: player.id,
      palette: player.palette.id,
      paletteName: player.palette.name,
      paletteHex: player.palette.paint.color,
      paintHex: playerPaintHex(),
      nodes: player.nodeCount,
      swaps: swapCount,
      transmission,
    };
  },
  get settings(): Readonly<GameSettings> {
    return { ...settings };
  },
  setSetting(patch: Partial<GameSettings>): void {
    setSetting(patch);
  },
  /** HUD gauge facts (per-vehicle redline / speedo scale). */
  get hudSpec(): Readonly<HudVehicleSpec> | null {
    return hud ? { ...hud.vehicleSpec } : null;
  },
  openPause(): void {
    openPause();
  },
  resume(): void {
    resume();
  },
  openShowroom(): void {
    if (mode === 'drive') openPause();
    openShowroom('pause');
  },
  /** Showroom state (tests; the UI is the real path). */
  get showroom(): { open: boolean; busy: boolean; selection: VehicleChoice | null; spawn: number; studioVehicle: string | null; turntable: number } {
    return {
      open: !!showroom?.isOpen,
      busy: !!showroom?.busy,
      selection: showroom?.isOpen ? showroom.selection : null,
      spawn: showroom ? showroom.spawn : -1,
      studioVehicle: studio ? studio.vehicleId : null,
      turntable: studio ? studio.turntableAngle : 0,
    };
  },
  /** Swap the player car directly (tests / console): same path as the showroom's Drive. */
  setVehicle(id: string, palette?: string, spawn?: number): Promise<void> {
    return swapVehicle({ id: id as VehicleChoice['id'], palette: palette ?? '' }, spawn ?? null);
  },
  /** R-GFX time of day + weather (render/lighting/environment.ts), null before the lighting stack exists. */
  get env(): EnvDebugApi | null {
    return lightingStack?.env ? envDebugApi(lightingStack.env) : null;
  },
  /** P7 live replay (app/replay/types.ts ReplayDebugApi). */
  get replay() {
    return replay.debug;
  },
  /** P8 synthesized audio (src/audio/types.ts AudioDebug), null until its chunk loaded. */
  get audio() {
    return audio ? audio.debug : null;
  },
  /** P8 stunt challenges (app/challenges.ts ChallengeDebugApi), null until the challenge chunk loaded. */
  get challenges() {
    return challenges ? challenges.debug : null;
  },
  /** P8: load the challenge chunk (tests). */
  loadChallenges(): Promise<boolean> {
    return loadChallenges().then(() => true);
  },
  /** P8: open the challenge select screen. */
  openChallenges(): void {
    if (mode === 'pause') openChallenges('pause');
    else openChallenges('drive');
  },
  /** P7 (R2) replay UI / cameras / crash cam / photo mode (ui/replay/session.ts ReplaySessionDebug), null before boot. */
  get replayUi() {
    return replaySession ? replaySession.debug : null;
  },
  /** Dev handles for tuning from the console (not a contract). `sedanVisual` stays as an alias of `playerVisual`. */
  debug: { scene, camera, renderer, ctx, client } as Record<string, unknown>,
};
Object.defineProperties(crumple.debug, {
  playerVisual: { get: () => playerVisual(), enumerable: true },
  sedanVisual: { get: () => playerVisual(), enumerable: true },
  player: { get: () => player, enumerable: true },
});
(window as unknown as { __crumple: typeof crumple }).__crumple = crumple;

window.addEventListener('resize', () => {
  ctx.width = window.innerWidth;
  ctx.height = window.innerHeight;
  camera.aspect = ctx.width / ctx.height;
  camera.updateProjectionMatrix();
  if (mode === 'showroom') return; // the showroom resizes its own stage
  renderer.setSize(ctx.width, ctx.height);
  post?.setSize(ctx.width, ctx.height);
  // setSize clears the canvas: the frozen world behind the pause menu is drawn again.
  if (mode === 'pause') redrawPaused = true;
});

// ------------------------------------------------------------ boot
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * The P5 world layer (props, vegetation, water, FX) is its own chunks, fetched in parallel with the
 * terrain generation (the app chunk stays under 500 kB and parses sooner).
 */
function loadWorldLayer() {
  return Promise.all([
    import('./render/props'),
    import('./render/vegetation'),
    import('./render/water'),
    import('./render/fx'),
    // P8: static colliders + stunt-park decoration (procedural textures / geometry: ~40 kB off the app chunk)
    import('./render/world/colliders'),
    import('./render/world/stuntpark'),
  ]);
}

async function boot(): Promise<void> {
  const t0 = performance.now();
  LAYOUT = await layoutP;
  const worldLayerP = loadWorldLayer();
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
  const lightingModP = import('./render/lighting/lazy');
  const lightingP = lightingModP.then((m) => {
    lightingMod = m;
    return m.createLightingStack(ctx, { time: settings.timeOfDay, timeSpeed: settings.timeSpeed, weather: settings.weather });
  });
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
  lightingStack = lighting;
  // R-GFX: the headlight spots exist before any program compiles (the spot count is part of every lit program).
  const nightR = lightingMod!.createNightLights(ctx.quality);
  nightLights = nightR;
  scene.add(nightR.object);
  ENV_UNIFORMS.crumpleLightGrid.value = nightR.grid.texture;
  crumple.debug.nightLights = nightR;
  crumple.debug.envUniforms = ENV_UNIFORMS;
  const postStack = createPostStack(ctx);
  post = postStack;
  // R-GFX: a time-of-day / weather jump (settings, photo mode, tests) skips the eye adaptation
  lighting.env?.onChange(() => postStack.exposure?.snap());
  mark('postStack');

  // Flexbody bodies: built (tessellate + bind) while the terrain still generates in its worker (they
  // need only the lighting stack), then their programs start compiling in the GPU process right away.
  // ?body=0 skips them (wireframe only: perf comparisons, debugging the sim).
  const withBody = params.get('body') !== '0';
  visualDeps = withBody ? { ctx, lighting, patchMaterial, groundAt: (x, z) => (sampler ? sampler.heightAt(x, z) : 0) } : null;
  // P6: the persisted / default catalog vehicle (its modules were requested at script start).
  const bootAssets = await bootAssetsP;
  mark('vehicleAssets');
  player = new PlayerVehicle(bootAssets, bootChoice.id === bootAssets.entry.id ? bootChoice.palette : null, visualDeps);
  const sedanVisual = player.visual;
  if (sedanVisual) {
    scene.add(sedanVisual.object);
    const t = sedanVisual.timings;
    console.info(
      `[vehicle] ${player.id} body: ${sedanVisual.binding.panels.length} panels, ${sedanVisual.binding.stats.vertices} verts, tessellate ${t.tessellateMs.toFixed(0)} ms, bind ${t.bindMs.toFixed(0)} ms, total ${t.totalMs.toFixed(0)} ms`,
    );
  }
  applyPlayerSpec(bootAssets);
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
  Object.assign(crumple.debug, { cubeSkin });
  wrapProfiling(player);
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

  const [loaded, materials, [{ createPropRenderer }, { createVegetationRenderer }, { createWaterRenderer }, { createFxSystem }, { createColliderRenderer }, { createStuntParkRenderer }]] = await Promise.all([
    terrainP,
    materialsP,
    worldLayerP,
  ]);
  mark('assets+terrain');
  const world = loaded.terrain;
  terrain = world;
  const smp = createTerrainSampler(world);
  sampler = smp;
  ctx.sampler = smp;
  await nextFrame();

  // R-GFX rain: where water pools on the carved heightfield (ground-mode wet surfaces sample it)
  {
    const pm = createPuddleMap(world);
    const cell = Math.max(1, Math.round(PUDDLE_CELL_M / world.spacing)) * world.spacing;
    ENV_UNIFORMS.crumplePuddleMap.value = pm;
    ENV_UNIFORMS.crumplePuddleRect.value.set(world.originX - cell / 2, world.originZ - cell / 2, 1 / (pm.image.width * cell), 1 / (pm.image.height * cell));
  }
  const terrainR = createTerrainRenderer(ctx, world, materials, { lighting, patchMaterial });
  scene.add(terrainR.object);
  mark('terrainRenderer');
  stats.stages.terrainTextureMs = Math.round(terrainR.stats.textureMs);
  const roadsR = createRoadRenderer(ctx, world, smp, materials, { lighting, patchMaterial });
  scene.add(roadsR.object);
  mark('roadRenderer');
  scene.add(createFarLand(world, { lighting, patchMaterial }).object);
  // Static colliders (arena wall, poles, ramp, barriers): drawn exactly where the worker collides with them.
  // Layout v6: the generated world content's colliders follow the layout's (the worker's order).
  worldColliders = [...LAYOUT.colliders, ...loaded.content.colliders];
  const collidersR = createColliderRenderer(ctx, resolveColliders(worldColliders, (x, z) => smp.heightAt(x, z)), {
    lighting,
    patchMaterial,
  });
  scene.add(collidersR.object);
  // P8: stunt-park decoration (markings, floodlight heads, grandstand roof, deck legs) over the same colliders.
  const stuntParkR = createStuntParkRenderer(ctx, resolveColliders(LAYOUT.colliders, (x, z) => smp.heightAt(x, z)), {
    lighting,
    patchMaterial,
    heightAt: (x, z) => smp.heightAt(x, z),
  });
  scene.add(stuntParkR.object);
  Object.assign(crumple.debug, { stuntPark: stuntParkR });
  // P5 world layer (contracts: docs/CONTRACTS.md "P5 contracts"). Same pure inputs as the physics worker.
  const heightAt = (x: number, z: number): number => smp.heightAt(x, z);
  const waterBodies = resolveWater(LAYOUT, world);
  const propInstances = resolvePropInstances([...LAYOUT.props, ...loaded.content.props], heightAt);
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
  // R-GFX rain streaks (one instanced draw, only while it rains)
  const rainR = lightingMod!.createRain(ctx.quality.level);
  scene.add(rainR.object);
  const rainFrame: RainFrame = {
    camera,
    dtS: 0,
    intensity: 0,
    wind: new Vector3(1.4, 0, 0.6),
    time: 0,
    ambient: new Vector3(),
    keyColor: new Vector3(),
    beam: null,
  };
  const rainBeam = { pos: new Vector3(), dir: new Vector3(), intensity: 0, cosOuter: 0.8 };
  fxR.addVehicle(VEHICLE_ID, bootAssets.compiled);
  fxR.addProps(propInstances);
  const trafficC = createTrafficController(ctx, { client, lighting, patchMaterial, fx: fxR, sampler: smp, focusObjectId: VEHICLE_ID });
  traffic = trafficC;
  scene.add(trafficC.object);
  // R-GFX night lights: streetlights (light-pole props, live), floodlights, traffic + player lamps in one light grid.
  const lampRig = ((): { nodes: number[]; rest: [number, number, number][] } | null => {
    try {
      const c = compilePropRig('lightPole');
      const nodes = ['lamp_0', 'lamp_1', 'lamp_2', 'lamp_3'].map((id) => c.nodeIds.indexOf(id));
      if (nodes.some((i) => i < 0)) return null;
      return { nodes, rest: nodes.map((i) => [c.nodePos[3 * i]!, c.nodePos[3 * i + 1]!, c.nodePos[3 * i + 2]!] as [number, number, number]) };
    } catch {
      return null;
    }
  })();
  nightR.setWorld({ props: propInstances, lampRig, colliders: resolveColliders(worldColliders, (x, z) => smp.heightAt(x, z)) });
  {
    // R-WORLD light sources (street / flood / tunnel / window / sign / beacon / signal heads); a signal lamp is lit while its leg
    // shows that aspect at the presented sim time (called from nightR.update, after worldFrame exists).
    const plans = loaded.content.signals;
    nightR.setWorldLights(loaded.content.lights, (l) => {
      const sg = l.signal;
      const plan = sg ? plans[sg.plan] : undefined;
      return !!sg && !!plan && signalAspect(plan, sg.leg, Math.floor(worldFrame.simTime * SIGNAL_TICK_HZ)) === sg.lamp;
    });
  }
  addEnvApiHook((p) => {
    if (p.headlights === 'off' || p.headlights === 'auto') {
      headlightMode = p.headlights;
      highBeam = false;
    } else if (p.headlights === 'low' || p.headlights === 'high') {
      headlightMode = 'on';
      highBeam = p.headlights === 'high';
    }
  });
  stats.stages.vegetationMs = Math.round(loaded.vegetationMs);
  // P6: traffic follows the preset scaled by the player's traffic setting (off / light / normal / heavy).
  const trafficQ = { setQuality: (q: typeof ctx.quality) => trafficC.setQuality(trafficPreset(q)) };
  const qc = createQualityControllerWith(
    ctx,
    { lighting, post: postStack, others: [terrainR, roadsR, collidersR, propsR, vegetationR, waterR, fxR, trafficQ, nightR, { setQuality: (q: typeof ctx.quality) => rainR.setQuality(q.level) }, { setQuality: (q: typeof ctx.quality) => replay.setQuality(q.level) }] },
    forcedLevel ? { initial: forcedLevel, storage: null, maxPixelRatio } : { maxPixelRatio },
  );
  quality = qc;
  Object.assign(crumple.debug, { terrain: terrainR, roads: roadsR, post: postStack, director, props: propsR, vegetation: vegetationR, water: waterR, fx: fxR, traffic: trafficC, waterBodies, propInstances });
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
  if (info.contentHash !== undefined && info.contentHash >>> 0 !== loaded.content.hash >>> 0) {
    console.error(
      `[world] content hash mismatch: physics 0x${(info.contentHash >>> 0).toString(16)} vs render 0x${(loaded.content.hash >>> 0).toString(16)}`,
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
  client.spawnVehicle(VEHICLE_ID, bootAssets.sim, lastSpawn, transmission, bootAssets.entry.id, SPAWN_SETTLE_S);
  holdParked();
  if (!tractionControl) client.setAssists(VEHICLE_ID, { tractionControl: false });
  spawnCube();
  // P6 traffic: ?traffic=0 (perf comparisons) or the 'off' setting disables it; the stub resolves false until T2 lands.
  startTraffic();

  // Camera at the spawn, the first view's LODs built and its programs compiled behind the overlay.
  const startPose = { position: new Vector3(), forward: new Vector3(), up: new Vector3(), velocity: new Vector3() } satisfies ChaseTarget;
  poseFromTransform(lastSpawn, startPose, bootAssets);
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
  const hudView = new Hud(document.body, hudSpecFor(player.assets));
  hud = hudView;
  createMenus();

  // P7 (R2): the replay session (UI, replay cameras, crash cam, photo mode). Crash cam: on by the
  // player's setting; automation (navigator.webdriver) keeps it off unless ?crashcam=1.
  const crashCamParam = params.get('crashcam');
  const cameraHeight = (x: number, z: number): number => smp.heightAt(x, z);
  // Camera occluders: static colliders + the bulky layout props at their spawn poses (blocks, barrels, crates; not cones).
  const occluderBoxes = [
    ...resolveColliders(worldColliders, cameraHeight)
      .filter((c) => c.visual !== 'lid' && c.visual !== 'kerb')
      .map((c) => colliderWorldAabb(c)),
    ...propBoxes.filter((b) => b[4] - b[1] > 0.7 && Math.max(b[3] - b[0], b[5] - b[2]) > 0.7),
  ];
  replaySession = createReplaySession({
    replay,
    camera,
    renderer,
    post: postStack,
    world: {
      groundHeight: cameraHeight,
      occluded: createAabbOccluder(occluderBoxes),
      nearestOccluder: createAabbNearest(occluderBoxes),
      roadside: createRoadside(world.roads, cameraHeight),
    },
    pickMeshes: () => [collidersR.object],
    renderFrame: () => frame(0, false),
    canHighlight: () => running && mode === 'drive' && !paused && !hold && !pinnedCamera,
    crashCamEnabled: () => (crashCamParam !== null ? crashCamParam !== '0' : settings.crashCam && !navigator.webdriver),
    onActiveChange: (on) => {
      mapper.releaseAll();
      lastSent.gearSelect = NaN; // full input resend after the replay
      hudView.setVisible(!on);
    },
    onExitToLive: (smooth) => {
      if (smooth) director.handOver();
      else director.snap();
    },
    toast: (title, sub) => hudView.showToast(title, sub, 1800),
    hoodMount: (id) => (id === VEHICLE_ID ? playerHoodMount() : null),
    subjectName: (t) => (t.objectId === VEHICLE_ID && player ? player.assets.entry.stats.name : t.kind === 'traffic' ? 'Traffic' : 'Object'),
    units: () => settings.units,
    environment: lighting.env ? { time: () => lighting.env!.time, setTime: (h: number) => lighting.env!.setTime(h) } : undefined,
  });

  // P8: synthesized audio (lazy chunk + AudioWorklet module); the context resumes on the first gesture.
  if (params.get('audio') !== '0') {
    const propKeys = new Map(propInstances.map((p) => [p.objectId, p.prop as string]));
    const fwdTmp = new Vector3();
    void import('./audio')
      .then((m) =>
        m.createAudioSystem({
          sim: client,
          cameraMatrix: () => camera.matrixWorld.elements,
          replay,
          playerObjectId: VEHICLE_ID,
          player: audioPlayerInfo,
          nodes: () => positions,
          playerForward: (out) => {
            if (!poseValid) return false;
            fwdTmp.copy(pose.forward);
            out[0] = fwdTmp.x;
            out[1] = fwdTmp.y;
            out[2] = fwdTmp.z;
            return true;
          },
          materialAt: (x, z) => smp.materialAt(x, z),
          layoutZones: LAYOUT.zones,
          heightAt: (x, z) => smp.heightAt(x, z),
          propKey: (id) => propKeys.get(id) ?? null,
          settings: () => settings,
          timeScale: () => (paused ? 0 : slowMo ? SLOW_MO_SCALE : 1),
          crashCam: () => replaySession?.crashCam.phase === 'playing',
          playerDamage: () => (playerVisual()?.damage as { onFx: ((fx: { type: string; pos: ArrayLike<number> }) => void) | null } | undefined) ?? null,
          hrtf: () => ctx.quality.level !== 'low',
          trafficVoices: () => (ctx.quality.level === 'low' ? { awake: 2, ghosts: 2 } : { awake: 4, ghosts: 4 }),
        }),
      )
      .then((a) => {
        audio = a;
      })
      .catch((e: unknown) => console.warn('[audio] unavailable', e));
  }

  // P8: the challenge host's deps (the host itself is a lazy chunk, created on first use)
  const challengeColliders = resolveColliders(worldColliders, cameraHeight);
  challengeDepsP = () => ({
    client,
    scene,
    camera,
    sampler: smp,
    terrain: world,
    colliders: challengeColliders,
    props: propsR,
    fx: fxR,
    replay,
    replayUi: () => replaySession,
    visualDeps,
    build: __BUILD_HASH__,
    player: () => player,
    swapVehicle: (choice) => swapVehicle(choice, null),
    placePlayer: (t) => {
      lastSpawn = t;
      client.reset(VEHICLE_ID, t, SPAWN_SETTLE_S);
      holdParked();
      lastSent.gearSelect = NaN;
      snapAfterTick = client.latestTick;
      replaySession?.quietCrashCam();
      director.snap();
    },
    setTrafficAgents: (n) => {
      if (challengeTraffic === n) return;
      challengeTraffic = n;
      if (trafficStarted) traffic?.setQuality(trafficPreset(ctx.quality));
    },
    setTractionControl: (on) => {
      const want = on ?? settings.tractionControl;
      if (want !== tractionControl) {
        tractionControl = want;
        client.setAssists(VEHICLE_ID, { tractionControl: want });
      }
    },
    toast: (title, sub) => hudView.showToast(title, sub, 2400),
    onSelectOpen: (open, reason) => {
      if (!open) challengesClosed(reason ?? 'back');
      else if (mode === 'drive') {
        // opened from the results screen: pause the world behind it like the menu path
        challengesFrom = 'drive';
        enterMenuMode('challenges');
      }
    },
  });

  const hudStatus = { paused: false, slowMo: false, camera: 'chase', transmission, beamView: true, view: debugView as string, tractionControl };
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
  /** One world frame; `input` false = a redraw behind the pause menu (no input, no commands). */
  const frame = (dt: number, input = true): void => {
    prof.begin();
    // Input → worker.
    if (input && replay.active) {
      devices.poll();
      handleReplayCommands();
    } else if (input) {
      devices.poll();
      const tel = client.telemetry(VEHICLE_ID);
      const speed = tel ? (tel[VehicleTelemetry.speed] ?? 0) : 0;
      const raw = mapper.update(dt, speed);
      // A running challenge holds the car through its own countdown filter: no spawn hold on top.
      if (challenges?.active) spawnHold.release();
      else if (spawnHold.active && tel && (tel[VehicleTelemetry.throttle] ?? 0) > SPAWN_HOLD_INPUT_EPS) {
        // Throttle arrived from elsewhere (autopilot, tests driving through debug.client.input): the car
        // is being driven, so the hold is over — and main does not resend idle input over that driver.
        spawnHold.release();
        Object.assign(lastSent, raw);
      }
      const act = spawnHold.apply(raw);
      if (challenges?.active) {
        // P8: countdown hold / results brake / playtest bot
        Object.assign(challengeInput, act);
        challenges.filterInput(challengeInput);
        sendInput(challengeInput);
      } else sendInput(act);
      handleCommands();
    }
    prof.lap('input');

    // P7: the replay playhead advances and presents its frames through the client (no-op while live).
    replay.update(dt);
    if (!replay.active) replay.recordStrains = beamView.visible;
    // Sim → interpolated nodes → beam view + camera subject.
    const need = client.nodeTotal * 3;
    if (positions.length < need) positions = new Float32Array(need);
    // One render-clock read per frame: every consumer (nodes, traffic, FX, audio) sees the same instant.
    const renderT = client.renderTime();
    const interpolated = client.interpolate(renderT, positions) > 0;
    prof.lap('interpolate');
    if (interpolated) {
      if (beamView.visible) beamView.update(client, positions);
      poseValid = updateVehiclePose();
      prof.lap('beamView+pose');
      updateVisuals(dt);
      // P7: the player's damage has now processed every event up to the previous drain
      if (!replay.active) replay.checkpoint('player', lastDrainTick);
      prof.lap('vehicle');
      const pv = playerVisual();
      if (prof.enabled && pv) {
        // Upload the node texture here (it would happen inside the render) so its cost is visible.
        renderer.initTexture(pv.skin.nodeTexture);
        if (cubeSkin) renderer.initTexture(cubeSkin.nodeTexture);
        prof.lap('nodeTexUpload');
      }
    } else {
      poseValid = false;
    }
    client.drainEvents(eventSink);
    if (!replay.active) lastDrainTick = client.latestTick;
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
    } else if (replaySession?.ownsCamera) replaySession.updateCamera(dt);
    else director.update(dt, poseValid ? pose : null);
    prof.lap('camera');
    // R-GFX: time of day advances with the world (frozen while paused or replaying)
    lighting.env?.advance(paused || replay.active ? 0 : dt);
    // R-TYRE: the weather's surface water reaches the tyres as a LOGGED command (replays reproduce the grip), only
    // when it moved by > 0.02 and never while replaying (main sends no commands then)
    if (!replay.active && lighting.env) {
      const wx = lighting.env.weather;
      if (Math.abs(wx.wetness - tyreWater.wetness) > 0.02 || Math.abs(wx.rain - tyreWater.rain) > 0.02) {
        tyreWater.wetness = wx.wetness;
        tyreWater.rain = wx.rain;
        client.setSurfaceWetness(wx.wetness, wx.rain);
      }
    }
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
    worldFrame.simTime = renderT;
    worldFrame.timeScale = paused || replay.active ? 0 : slowMo ? SLOW_MO_SCALE : 1;
    worldFrame.nodes = positions;
    worldFrame.interpolated = interpolated;
    worldFrame.objects = client.objectRanges();
    worldFrame.tick = client.latestTick;
    // P8: challenge course, ghost, opponents' bodies and HUD (camera final, before props / FX)
    challenges?.frame(dt, worldFrame);
    trafficC.update(worldFrame);
    prof.lap('traffic');
    propsR.update(worldFrame);
    // P7: props scuff on drain (same frame), so their checkpoint tag is this frame's drain
    if (!replay.active && worldFrame.interpolated) replay.checkpoint('props', lastDrainTick);
    prof.lap('props');
    vegetationR.update(worldFrame);
    prof.lap('vegetation');
    fxR.update(worldFrame);
    prof.lap('fx');
    waterR.update(worldFrame);
    prof.lap('water');
    // R-GFX night lights: player lamps (auto with dusk / rain / fog), traffic lamps, streetlights → light grid
    {
      const env = lighting.env;
      const pl = player;
      headState.on = headlightMode === 'on' || (headlightMode === 'auto' && !!env?.headlightsWanted);
      headState.high = headState.on && highBeam;
      const tel = client.telemetry(VEHICLE_ID);
      headState.brake = tel ? Math.min(1, Math.max(0, tel[VehicleTelemetry.brake] ?? 0)) : 0;
      headState.reverse = tel ? (tel[VehicleTelemetry.gear] ?? 0) < 0 : false;
      if (pl) {
        pl.lamps.head = headState.on;
        pl.lamps.highBeam = headState.high;
      }
      const gain = env ? env.darkness : 0;
      let nt = 0;
      if (gain > 0.01 && trafficStarted) {
        nt = client.readTrafficAgents(renderT, trafficLampFrames);
        for (let i = 0; i < nt; i++) {
          const a = trafficLampFrames[i]!;
          const l = (trafficLamps[i] ??= { pos: a.pos, quat: a.quat, headlights: false, brake: 0 });
          l.pos = a.pos;
          l.quat = a.quat;
          l.headlights = (a.flags & TRAFFIC_FLAG_HEADLIGHTS) !== 0 || gain > 0.3;
          l.brake = (a.flags & TRAFFIC_FLAG_BRAKE) !== 0 ? 1 : 0;
        }
      }
      nightR.update(worldFrame, { pose: poseValid ? pose : null, state: headState }, trafficLamps, nt, gain);
      ENV_UNIFORMS.crumpleGridOrigin.value.copy(nightR.grid.origin);
      // R-GFX weather: rain streaks (lit by the beam + light grid), tyre spray
      const weather = env?.weather;
      fxR.setWeather?.(weather ?? { wetness: 0, rain: 0 });
      rainFrame.dtS = dt;
      rainFrame.intensity = weather ? weather.rain : 0;
      rainFrame.time = worldFrame.time;
      const fogC = scene.fog ? scene.fog.color : null;
      if (fogC) rainFrame.ambient.set(fogC.r, fogC.g, fogC.b).multiplyScalar(0.7);
      rainFrame.keyColor.set(lighting.sun.color.r, lighting.sun.color.g, lighting.sun.color.b).multiplyScalar(lighting.sun.intensity);
      const spot = nightR.headlights.spots[0];
      if (spot && spot.intensity > 0) {
        rainBeam.pos.copy(spot.position);
        rainBeam.dir.copy(spot.target.position).sub(spot.position).normalize();
        rainBeam.intensity = spot.intensity * nightR.headlights.spots.length;
        rainBeam.cosOuter = Math.cos(spot.angle);
        rainFrame.beam = rainBeam;
      } else rainFrame.beam = null;
      rainR.update(rainFrame);
      // drops on the lens of the driving cameras only (never in replay / photo / a pinned shot)
      const lensCam = !replay.active && !pinnedCamera && director.mode === 'chase';
      postStack.setLensRain?.(lensCam && weather ? weather.rain * 0.8 : 0, worldFrame.time);
    }
    prof.lap('nightLights');
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
    hudStatus.tractionControl = tractionControl;
    hudView.update(client.telemetry(VEHICLE_ID), hudStatus, dt);
    prof.lap('hud');
    // P8: audio follows the presented frame (live or replay), after the camera is final
    audio?.update(dt);
    prof.lap('audio');
    perfOverlay?.update(perfData);
    // P7 (R2): replay UI, crash cam (after the frame is drawn).
    if (input) replaySession?.frame(dt);
    prof.lap('replayUi');
  };

  // P7 replay: main's side — live snapshot / verbatim restore, damage checkpoint domains, settled-seek priming.
  const fillWorldFrame = (simTime: number): void => {
    const need = client.nodeTotal * 3;
    if (positions.length < need) positions = new Float32Array(need);
    worldFrame.interpolated = client.interpolate(simTime, positions) > 0;
    worldFrame.nodes = positions;
    worldFrame.simTime = simTime;
    worldFrame.timeScale = 0;
    worldFrame.objects = client.objectRanges();
    worldFrame.tick = client.latestTick;
  };
  const noEvents = {};
  /** Prime routing for the current frame: FX window and/or the domains whose hit frame it is. */
  let primeFx = false;
  let primeHits = 0;
  const primeSink = {
    impact(e: Readonly<ImpactEvent>): void {
      if (e.objectId === VEHICLE_ID) {
        if (primeHits & REPLAY_DOMAIN_PLAYER_BIT) playerVisual()?.onImpact(e);
      } else if (isPropObjectId(e.objectId)) {
        if (primeHits & REPLAY_DOMAIN_PROPS_BIT) propsR.onImpact(e);
      } else if (trafficC.owns(e.objectId)) {
        if (primeFx) trafficC.onImpact(e);
        return;
      }
      if (primeFx) fxR.onImpact(e);
    },
    beamBreak(e: Readonly<BeamBreakEvent>): void {
      if (e.objectId === VEHICLE_ID) {
        if (primeHits & REPLAY_DOMAIN_PLAYER_BIT) playerVisual()?.onBeamBreak(e);
      } else if (isPropObjectId(e.objectId)) {
        if (primeHits & REPLAY_DOMAIN_PROPS_BIT) propsR.onBeamBreak(e);
      } else if (trafficC.owns(e.objectId)) {
        if (primeFx) trafficC.onBeamBreak(e);
        return;
      }
      if (primeFx) fxR.onBeamBreak(e);
    },
    skid(e: Readonly<SkidEvent>): void {
      if (e.objectId === VEHICLE_ID) {
        if (primeHits & REPLAY_DOMAIN_PLAYER_BIT) playerVisual()?.onSkid(e);
      } else if (trafficC.owns(e.objectId)) {
        if (primeFx) trafficC.onSkid(e);
        return;
      }
      if (primeFx) fxR.onSkid(e);
    },
  };
  const saveVisualState = () => {
    const pv = playerVisual();
    return {
      pv,
      player: pv ? pv.damage.saveState() : null,
      props: propsR.saveState(),
      traffic: trafficC.saveReplayState(),
      fx: fxR.saveState(),
      // R-GFX: the eye's adaptation (replay cameras meter other views)
      exposure: postStack.exposure ? [postStack.exposure.value, postStack.exposure.target ?? postStack.exposure.value] : null,
    };
  };
  let lastSavedLive: unknown = null;
  /** FNV-1a over every typed array / number of a saved visual state (object refs under `pv` skipped). */
  const digest = (v: unknown): number => {
    let h = 0x811c9dc5;
    const seen = new Set<unknown>();
    const walk = (x: unknown): void => {
      if (x === null || x === undefined) return void (h = Math.imul(h ^ 1, 0x01000193));
      if (typeof x === 'number' || typeof x === 'boolean') {
        const f = new Float64Array([Number(x)]);
        const u = new Uint32Array(f.buffer);
        h = Math.imul(h ^ u[0]!, 0x01000193);
        h = Math.imul(h ^ u[1]!, 0x01000193);
        return;
      }
      if (ArrayBuffer.isView(x)) {
        const b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
        return;
      }
      if (typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);
      if (Array.isArray(x)) return x.forEach(walk);
      for (const k of Object.keys(x as object).sort()) if (k !== 'pv') walk((x as Record<string, unknown>)[k]);
    };
    walk(v);
    return h >>> 0;
  };
  Object.assign(crumple.debug, {
    /** P7 e2e: digest of the visual state now / of the one saved when the replay was entered. */
    replayDigest: () => digest(saveVisualState()),
    replayLiveDigest: () => (lastSavedLive ? digest(lastSavedLive) : 0),
    /** Player damage totals (Σ strain, Σ scuff, hidden panels). */
    damageSums: () => {
      const pv = playerVisual();
      if (!pv) return null;
      let strain = 0;
      let scuff = 0;
      for (let i = 0; i < pv.damage.strain.length; i++) {
        strain += pv.damage.strain[i]!;
        scuff += pv.damage.scuff[i]!;
      }
      let hidden = 0;
      for (let i = 0; i < pv.damage.panelCount; i++) if (!pv.skin.panelVisible(i)) hidden++;
      return { strain, scuff, hidden };
    },
  });
  replay.registerDomain({
    key: 'props',
    hitFlag: FRAME_PROP_HIT,
    save: (into) => propsR.saveState(into as PropVisualState | null),
    restore: (st, seed) => propsR.restoreState(st as PropVisualState, seed),
  });
  replay.setVisuals({
    enter() {
      mapper.releaseAll();
      fxR.setSkidmarksFrozen(true);
    },
    exit() {
      mapper.releaseAll();
      lastSent.gearSelect = NaN; // force a full input resend
      fxR.setSkidmarksFrozen(false);
    },
    saveLive() {
      lastSavedLive = saveVisualState();
      return lastSavedLive;
    },
    restoreLive(state) {
      const st = state as { pv: ReturnType<typeof playerVisual>; player: DamageState | null; props: PropVisualState; traffic: unknown; fx: FxState; exposure: [number, number] | null };
      if (st.exposure) postStack.exposure?.set?.(st.exposure[0], st.exposure[1]);
      const pv = playerVisual();
      if (pv && pv === st.pv && st.player) {
        pv.damage.restoreState(st.player);
        pv.fx?.clear();
      }
      propsR.restoreState(st.props);
      trafficC.restoreReplayState(st.traffic);
      fxR.restoreState(st.fx);
    },
    reverse(on) {
      fxR.setDebrisHidden(on);
    },
    primeBegin(seed) {
      // traffic visuals see the new seek generation (their damage resets); FX restart from `seed`
      fillWorldFrame(client.renderTime());
      trafficC.update(worldFrame);
      client.drainEvents(noEvents);
      fxR.clearTransient();
      fxR.reseed(seed);
    },
    primeFrame(time, fx, hits) {
      fillWorldFrame(time);
      primeFx = fx;
      primeHits = hits;
      // props scuff against the node texture: write this frame's poses first
      if (hits & REPLAY_DOMAIN_PROPS_BIT) propsR.update(worldFrame);
      const pv = playerVisual();
      // crash frames outside the FX window must not throw fresh glass shards
      const onFx = pv ? pv.damage.onFx : null;
      if (pv && !fx) pv.damage.onFx = null;
      client.drainEvents(primeSink);
      if (hits & REPLAY_DOMAIN_PLAYER_BIT && worldFrame.interpolated) updateVisuals(0);
      if (pv) pv.damage.onFx = onFx;
      if (fx) fxR.update(worldFrame);
    },
  });

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
    if (mode === 'showroom') {
      // The studio replaces the world (paused, not rendered); Start / P only (handleMenuCommands).
      devices.poll();
      handleMenuCommands();
      showroom?.frame(dt);
      requestAnimationFrame(loop);
      return;
    }
    if (mode === 'challenges') {
      // P8: the challenge select over the frozen world (like the pause menu).
      devices.poll();
      handleMenuCommands();
      challenges?.selectFrame(dt);
      if (redrawPaused) {
        redrawPaused = false;
        frame(0, false);
      }
      requestAnimationFrame(loop);
      return;
    }
    if (mode === 'pause') {
      // The last world frame stays on the canvas behind the menu; redrawn only when it was cleared.
      devices.poll();
      handleMenuCommands();
      pauseMenu?.frame(dt);
      if (redrawPaused) {
        redrawPaused = false;
        frame(0, false);
      }
      requestAnimationFrame(loop);
      return;
    }
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
  mode = 'drive';
  running = true;
  // P6: a first launch (or ?welcome) is offered the showroom before the overlay fades; automation
  // (navigator.webdriver) and returning players drive straight in with the persisted car.
  const welcome = params.has('welcome') || (firstLaunch && !navigator.webdriver);
  if (welcome) {
    // ?welcome=<ms> overrides the hold (screenshots).
    const holdParam = Number(params.get('welcome'));
    const r = await loading.ready(player.assets.entry.stats.name, holdParam > 0 ? holdParam : WELCOME_HOLD_MS);
    if (r === 'choose') openShowroom('loading');
    else if (r === 'challenges') openChallenges('loading');
  }
  await loading.hide();
  if (mode === 'drive') hudView.showToast(world.spawns[spawnIndex]!.name.toUpperCase(), LAYOUT.name.toUpperCase(), 3200);
  // P8: ?challenge=<id> starts one straight away (tests, links)
  const wantChallenge = params.get('challenge');
  if (wantChallenge) void loadChallenges().then((h) => h.start(wantChallenge));
}

boot().catch((e: unknown) => {
  console.error('[boot] failed', e);
  loading.fail(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
});
