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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { SimClient } from './app/simClient';
import { loadTerrainSet } from './assets/loader';
import { quatFromAxisAngle, vec3Normalize, type Quat, type Vec3 } from './core/math';
import { MaterialId, type Transform } from './protocol/messages';
import { BeamView } from './render/debug/beamview';
import { softCube } from './sim/rig/testrigs';

const canvas = document.getElementById('app') as HTMLCanvasElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(4.5, 3.5, 6);

// Warm golden-hour gradient sky: large inverted dome, gradient by world-space height.
const skyMaterial = new ShaderMaterial({
  side: BackSide,
  depthWrite: false,
  uniforms: {
    topColor: { value: new Color(0x2e5a8f) },
    horizonColor: { value: new Color(0xf2a65a) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition).y;
      float t = pow(clamp(h, 0.0, 1.0), 0.6);
      gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
    }
  `,
});
const sky = new Mesh(new SphereGeometry(900, 32, 16), skyMaterial);
scene.add(sky);

// Ground: 60 m asphalt pad at y = 0 (matches the sim's ground plane).
const GROUND_SIZE = 60;
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
client.ground(0, MaterialId.asphalt);

const CUBE_ID = 1;
const tumbleAxis = vec3Normalize([0, 0, 0] as Vec3, [1, 0.35, 0.6]);
const spawnTransform: Transform = {
  pos: [0, 6, 0],
  quat: quatFromAxisAngle([0, 0, 0, 1] as Quat, tumbleAxis, 0.45),
};
client.spawn(CUBE_ID, softCube(), spawnTransform);

const beamView = new BeamView();
scene.add(beamView.group);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 2;
controls.maxDistance = 80;
controls.target.set(0, 3, 0);
controls.update();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !e.repeat && !e.ctrlKey && !e.metaKey) {
    client.reset(CUBE_ID, spawnTransform);
  }
});

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
};
(window as unknown as { __crumple: typeof crumple }).__crumple = crumple;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let positions = new Float32Array(0);
const centroid = new Vector3();
const follow = new Vector3();
let lastTime = performance.now();

function cubeCentroid(out: Vector3): boolean {
  for (const r of client.objectRanges()) {
    if (r.objectId !== CUBE_ID || r.nodeCount === 0) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    const end = (r.nodeOffset + r.nodeCount) * 3;
    for (let i = r.nodeOffset * 3; i < end; i += 3) {
      x += positions[i]!;
      y += positions[i + 1]!;
      z += positions[i + 2]!;
    }
    const inv = 1 / r.nodeCount;
    out.set(x * inv, y * inv, z * inv);
    return Number.isFinite(out.x + out.y + out.z);
  }
  return false;
}

function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  const need = client.nodeTotal * 3;
  if (positions.length < need) positions = new Float32Array(need);
  if (client.interpolate(client.renderTime(now), positions) > 0) {
    beamView.update(client, positions);
    if (cubeCentroid(centroid)) {
      // Follow the cube: translate camera and target together so orbiting is preserved.
      follow.copy(centroid).sub(controls.target).multiplyScalar(1 - Math.exp(-4 * dt));
      controls.target.add(follow);
      camera.position.add(follow);
    }
  }
  // No FX consumers yet; drain so the queue never saturates.
  client.drainEvents({});

  controls.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
