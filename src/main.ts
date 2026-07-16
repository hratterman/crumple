import './style.css';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  BoxGeometry,
  WebGLRenderer,
} from 'three';

const canvas = document.getElementById('app') as HTMLCanvasElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();

const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(6, 4, 8);
camera.lookAt(0, 1, 0);

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

const grid = new GridHelper(200, 100, 0x666666, 0x333333);
scene.add(grid);

const ground = new Mesh(
  new BoxGeometry(200, 0.02, 200),
  new MeshStandardMaterial({ color: 0x1c1f24, roughness: 1.0 }),
);
ground.position.y = -0.02;
scene.add(ground);

const cube = new Mesh(
  new BoxGeometry(1, 1, 1),
  new MeshStandardMaterial({ color: 0xd2452b, roughness: 0.45, metalness: 0.1 }),
);
cube.position.set(0, 1.5, 0);
scene.add(cube);

const sun = new DirectionalLight(0xffe0b3, 2.5);
sun.position.set(30, 20, 10);
scene.add(sun);
scene.add(new AmbientLight(0x8899bb, 0.6));

const crumple = { tick: 0, build: __BUILD_HASH__ };
(window as unknown as { __crumple: typeof crumple }).__crumple = crumple;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  cube.rotation.x += 0.3 * dt;
  cube.rotation.y += 0.47 * dt;
  cube.rotation.z += 0.11 * dt;

  renderer.render(scene, camera);
  crumple.tick += 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
