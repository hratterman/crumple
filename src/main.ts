import './style.css';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import { SimClient, type ObjectRange } from './app/simClient';
import { loadTerrainSet } from './assets/loader';
import { quatFromAxisAngle, quatRotateVec3, vec3Normalize, type Quat, type Vec3 } from './core/math';
import { createInputMapper } from './input/actions';
import { attachInputDevices } from './input/devices';
import { MaterialId, type ActionState, type Transform } from './protocol/messages';
import { VehicleTelemetry } from './protocol/telemetry';
import { vehiclePoseFromNodes, type ChaseTarget } from './render/cameras/chase';
import { CameraDirector } from './render/cameras/director';
import { BeamView } from './render/debug/beamview';
import { compileRig } from './sim/rig/builder';
import { softCube } from './sim/rig/testrigs';
import { buildVehicleRig } from './sim/vehicle/builder';
import { SEDAN } from './sim/vehicle/defs/sedan';
import { Hud } from './ui/hud';

const canvas = document.getElementById('app') as HTMLCanvasElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(6, 3.5, 8);
camera.lookAt(0, 0.5, 0);

// Warm golden-hour gradient sky: large inverted dome, gradient by view direction.
const skyMaterial = new ShaderMaterial({
  side: BackSide,
  depthWrite: false,
  uniforms: {
    topColor: { value: new Color(0x2e5a8f) },
    horizonColor: { value: new Color(0xf2a65a) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    varying vec3 vDir;
    void main() {
      float h = normalize(vDir).y;
      float t = pow(clamp(h, 0.0, 1.0), 0.6);
      gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
    }
  `,
});
const sky = new Mesh(new SphereGeometry(900, 32, 16), skyMaterial);
sky.frustumCulled = false;
scene.add(sky);

// Ground: large asphalt plane at y = 0 (the sim's ground plane is infinite).
const GROUND_SIZE = 600;
const TEXTURE_TILE_M = 4;
const groundMaterial = new MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.95 });
const ground = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), groundMaterial);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

void loadTerrainSet('asphalt', { anisotropy: renderer.capabilities.getMaxAnisotropy() }).then(
  (set) => {
    const repeat = GROUND_SIZE / TEXTURE_TILE_M;
    for (const tex of [set.color, set.normal, set.rough, set.ao]) tex?.repeat.set(repeat, repeat);
    groundMaterial.color.set(0xffffff);
    groundMaterial.map = set.color;
    groundMaterial.normalMap = set.normal;
    groundMaterial.roughnessMap = set.rough;
    groundMaterial.roughness = 1;
    groundMaterial.aoMap = set.ao;
    groundMaterial.needsUpdate = true;
  },
);

// Physical light units: Lambert divides by π, so dark asphalt needs strong light.
const sun = new DirectionalLight(0xffd9a8, 6);
sun.position.set(30, 20, 10);
scene.add(sun);
scene.add(new HemisphereLight(0xa8c4e8, 0x5a4632, 2.2));
scene.add(new AmbientLight(0x8899bb, 0.4));

// ------------------------------------------------------------ sim
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
const GROUND_Y = 0;
client.ground(GROUND_Y, MaterialId.asphalt);

const VEHICLE_ID = 1;
const CUBE_ID = 2;

// Rest-pose facts of the sedan (pure build; same canonical order the worker uses).
const sedanRig = compileRig(buildVehicleRig(SEDAN));
const SPAWN_DROP_M = 0.06;
let restMinY = Infinity;
for (let i = 0; i < sedanRig.nodeCount; i++) {
  restMinY = Math.min(restMinY, sedanRig.nodePos[3 * i + 1]! - sedanRig.nodeRadius[i]!);
}
const spawnLift = GROUND_Y - restMinY + SPAWN_DROP_M;

const vehicleSpawn: Transform = { pos: [0, spawnLift, 0], quat: [0, 0, 0, 1] };
const transmission = SEDAN.drivetrain.transmission ?? 'auto';
client.spawnVehicle(VEHICLE_ID, SEDAN, vehicleSpawn, transmission);

// Soft cube target off to the side, ahead of the car (vehicle forward is −Z).
const tumbleAxis = vec3Normalize([0, 0, 0] as Vec3, [1, 0.35, 0.6]);
const cubeSpawn: Transform = {
  pos: [6, 3, -18],
  quat: quatFromAxisAngle([0, 0, 0, 1] as Quat, tumbleAxis, 0.45),
};
client.spawn(CUBE_ID, softCube(), cubeSpawn);

const beamView = new BeamView();
beamView.visible = true;
scene.add(beamView.group);

// ------------------------------------------------------------ cameras, input, HUD
const director = new CameraDirector(camera, renderer.domElement, {
  initial: 'chase',
  chase: { groundHeight: () => GROUND_Y },
});

const mapper = createInputMapper({ transmission, gearCount: SEDAN.drivetrain.gearRatios.length });
const devices = attachInputDevices(mapper);

const hud = new Hud(document.body, {
  idleRpm: SEDAN.drivetrain.idleRpm,
  redlineRpm: SEDAN.drivetrain.redlineRpm,
  revLimitRpm: SEDAN.drivetrain.revLimitRpm,
});

let paused = false;
let slowMo = false;
const SLOW_MO_SCALE = 0.25;
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

/** Full repair: despawn + spawn a fresh sedan where the car is now, heading kept. */
function repairVehicle(): void {
  const t: Transform = { pos: vehicleSpawn.pos, quat: vehicleSpawn.quat };
  const info = client.vehicleInfo(VEHICLE_ID);
  if (poseValid && info) {
    const f = pose.forward;
    const h = Math.hypot(f.x, f.z);
    // Rotation about +Y taking rig forward (−Z) to the current horizontal heading.
    const yaw = h > 0.2 ? Math.atan2(-f.x, -f.z) : 0;
    const q = quatFromAxisAngle([0, 0, 0, 1] as Quat, [0, 1, 0], yaw);
    const o = info.frameNodes[0]!;
    const rest: Vec3 = [sedanRig.nodePos[3 * o]!, sedanRig.nodePos[3 * o + 1]!, sedanRig.nodePos[3 * o + 2]!];
    const r = quatRotateVec3([0, 0, 0] as Vec3, q, rest);
    t.pos = [pose.position.x - r[0], spawnLift, pose.position.z - r[2]];
    t.quat = q;
  }
  client.despawn(VEHICLE_ID);
  client.spawnVehicle(VEHICLE_ID, SEDAN, t, mapper.transmission);
  lastSent.gearSelect = NaN; // force a full input resend for the fresh object
  director.snap();
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
        beamView.visible = !beamView.visible;
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
        // Manual gear stepping lives in the mapper (gearSelect); nothing else to do.
        break;
    }
  }
}

// ------------------------------------------------------------ debug/test global
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
  /** Latest vehicle telemetry (subset), or null before the car appears. */
  get vehicle(): { speed: number; rpm: number; gear: number; damage: number } | null {
    const t = client.telemetry(VEHICLE_ID);
    if (!t) return null;
    const T = VehicleTelemetry;
    return { speed: t[T.speed]!, rpm: t[T.engineRpm]!, gear: t[T.gear]!, damage: t[T.damage]! };
  },
  get camera(): string {
    return director.mode;
  },
  get beamView(): boolean {
    return beamView.visible;
  },
  get timescale(): number {
    return paused ? 0 : slowMo ? SLOW_MO_SCALE : 1;
  },
};
(window as unknown as { __crumple: typeof crumple }).__crumple = crumple;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------ frame loop
const hudStatus = { paused: false, slowMo: false, camera: 'chase', transmission, beamView: true };
let lastTime = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // Input → worker.
  devices.poll();
  const tel = client.telemetry(VEHICLE_ID);
  const speed = tel ? (tel[VehicleTelemetry.speed] ?? 0) : 0;
  sendInput(mapper.update(dt, speed));
  handleCommands();

  // Interpolated nodes → beam view + camera subject.
  const need = client.nodeTotal * 3;
  if (positions.length < need) positions = new Float32Array(need);
  if (client.interpolate(client.renderTime(now), positions) > 0) {
    beamView.update(client, positions);
    poseValid = updateVehiclePose();
  } else {
    poseValid = false;
  }
  // No FX consumers yet; drain so the queue never saturates.
  client.drainEvents({});

  director.update(dt, poseValid ? pose : null);
  sky.position.copy(camera.position);

  hudStatus.paused = paused;
  hudStatus.slowMo = slowMo;
  hudStatus.camera = director.mode;
  hudStatus.transmission = mapper.transmission;
  hudStatus.beamView = beamView.visible;
  hud.update(client.telemetry(VEHICLE_ID), hudStatus, dt);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
