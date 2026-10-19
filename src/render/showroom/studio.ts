/**
 * Showroom studio (P6 S1, docs/CONTRACTS.md "Showroom + vehicle select").
 *
 * Its OWN scene, camera and post stack (the game world is paused and not
 * rendered while the showroom is open), drawn with the game's post chain
 * (createPostStack: n8ao, sanitize, SMAA, bloom, ACES, vignette) at the
 * current quality preset. A studio LightingStack replaces the golden-hour
 * one: `csm` null (so the vehicle materials take the plain shadowed-light
 * path) and a procedural soft-box environment instead of the HDRI.
 *
 *  - Cyclorama: ONE lathe surface (floor → coved fillet → wall) so floor
 *    and backdrop meet without a seam; vertex colours grade it (a light
 *    pool around the turntable, the wall darkening upward and away from the
 *    key side).
 *  - Lights: an overhead soft-box key (directional, soft PCF shadow onto the
 *    floor), two cool rim spots behind the car, a warm kicker low at the
 *    front and the soft-box env map (overhead box + side strips + a warm
 *    back strip) that draws the long highlights along the paint.
 *  - Floor: lit + shadow-receiving, under a planar reflection overlay
 *    (Reflector with a custom shader: mip-blurred, Fresnel-weighted, fading
 *    out toward the cove) and a baked contact shadow (footprint + four tyre
 *    patches) that turns with the car.
 *  - Turntable: the REAL vehicle visual (createVehicleVisual on the rest
 *    nodes, settle off, LOD0, no damage FX) fed rest nodes rotated about Y
 *    each frame, so the car turns exactly as the game would draw it; an
 *    emissive ring marks the platform.
 *  - Camera: damped orbit (yaw / pitch / zoom) around the car with an intro
 *    dolly; a view offset keeps the car clear of the UI panels.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LatheGeometry,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SpotLight,
  SRGBColorSpace,
  Vector2,
  Vector3,
  BoxGeometry,
} from 'three';
import type { Object3D, Texture, WebGLRenderer } from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

import type { CompiledVehicle } from '../../sim/vehicle/types';
import { createPostStack } from '../post';
import type { LightingStack, PatchMaterial, PostStack, QualityPreset, RenderContext } from '../types';
import { createVehicleVisual, type VehicleVisualHandle } from '../vehicle/index';
import type { PaintDef, VehicleFrameInput, VehicleVisualDef } from '../vehicle/types';

// ============================================================ tuning
/** Flat floor radius, fillet radius and wall height of the cyclorama, m. */
export const STUDIO_FLOOR_R = 11;
export const STUDIO_FILLET_R = 4;
export const STUDIO_WALL_H = 16;
/** Turntable radius (ring), m. */
export const TURNTABLE_R = 3.35;
/** Auto-rotation, rad/s, and the pause after the user touched the camera, s. */
export const TURNTABLE_SPEED = 0.16;
export const TURNTABLE_IDLE_S = 3.5;
/** Camera: vertical FOV (deg), pitch limits (rad), zoom range (× fit distance). */
export const STUDIO_FOV = 30;
export const STUDIO_PITCH: readonly [number, number] = [0.06, 0.62];
export const STUDIO_ZOOM: readonly [number, number] = [0.62, 1.6];
/** Overhead key spot (cd) and the weak directional twin (lux-ish). */
const KEY_SPOT_CD = 300;
const KEY_INTENSITY = 0.6;
const ENV_INTENSITY = 0.42;
/** Sign of the env rotation that keeps its +Z toward the camera (three's envMapRotation convention). */
const ENV_FOLLOW_SIGN = -1;

export interface StudioVehicle {
  /** Cache key (catalog id). */
  id: string;
  compiled: CompiledVehicle;
  visual: VehicleVisualDef;
  paint: PaintDef;
  /** Rig-local AABB incl. wheels (catalog `extent`). */
  extent: { min: readonly [number, number, number]; max: readonly [number, number, number] };
}

export interface StudioOptions {
  quality: QualityPreset;
  width: number;
  height: number;
  patchMaterial: PatchMaterial;
}

export interface Studio {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly post: PostStack;
  /**
   * Shows `v` on the turntable: builds its visual (cached per id while the
   * studio lives) and resolves once its programs are compiled. Null clears.
   */
  setVehicle(v: StudioVehicle | null): Promise<void>;
  /** Instant recolour of the current vehicle. */
  setPaint(paint: PaintDef): void;
  /** Drag: yaw/pitch by CSS pixels. */
  orbit(dxPx: number, dyPx: number): void;
  /** Wheel: positive = zoom out. */
  zoom(deltaY: number): void;
  /** Camera dolly-in from wide (on open). */
  intro(): void;
  /** Car framing: shift in CSS px (positive = right / up) and the fraction of the view width it may fill (clear of side panels). */
  setFraming(offsetX: number, offsetY: number, fill?: number): void;
  frame(dtS: number): void;
  setSize(width: number, height: number): void;
  setQuality(q: QualityPreset): void;
  readonly vehicleId: string | null;
  readonly turntableAngle: number;
  dispose(): void;
}

// ============================================================ studio environment (PMREM of a procedural soft-box room)
function emissive(r: number, g: number, b: number): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ side: DoubleSide });
  m.color.setRGB(r, g, b);
  return m;
}

function buildEnvironment(renderer: WebGLRenderer): Texture {
  const env = new Scene();
  const room = new Mesh(new BoxGeometry(40, 18, 40), emissive(0.012, 0.013, 0.016));
  (room.material as MeshBasicMaterial).side = BackSide;
  room.position.y = 9;
  env.add(room);
  const floor = new Mesh(new PlaneGeometry(40, 40), emissive(0.03, 0.031, 0.034));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  env.add(floor);
  const add = (w: number, h: number, mat: MeshBasicMaterial, pos: [number, number, number], rot: [number, number, number]): void => {
    const m = new Mesh(new PlaneGeometry(w, h), mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    env.add(m);
  };
  // Laid out in CAMERA space (+Z = toward the camera): the studio rotates the env with the orbit
  // yaw, so the photographer's lights stay put while the car turns under them.
  // Overhead soft box (the key), slightly toward the camera.
  add(9, 4.5, emissive(6.5, 6.4, 6.1), [0, 8.5, 1.5], [Math.PI / 2, 0, 0]);
  // Big diffusion panel high behind the camera: the long gradient down hood, doors and flanks.
  add(13, 3.2, emissive(2.2, 2.25, 2.4), [0, 5.2, 11], [-0.35, Math.PI, 0]);
  // Long side strips: crisp highlight lines along the shoulders.
  add(0.6, 7, emissive(6, 6.1, 6.4), [-8, 3.4, 2], [0, Math.PI / 2, 0]);
  add(0.6, 7, emissive(6, 6.1, 6.4), [8, 3.4, 2], [0, -Math.PI / 2, 0]);
  // Horizontal strip high behind the car (roof / rear window line), warm.
  add(14, 0.55, emissive(3.4, 2.5, 1.7), [0, 5.2, -12], [0, 0, 0]);
  // Low wide fill near the floor in front (bumper / sills), dim and cool.
  add(16, 1.2, emissive(0.7, 0.75, 0.85), [0, 0.9, 12.5], [0, Math.PI, 0]);
  // Two small accent cards at the rear corners (taillight edges).
  add(1.6, 3, emissive(2.4, 2.6, 3), [-10, 2.2, -9], [0, Math.PI / 4, 0]);
  add(1.6, 3, emissive(2.4, 2.6, 3), [10, 2.2, -9], [0, -Math.PI / 4, 0]);
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035);
  pmrem.dispose();
  env.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
  });
  return rt.texture;
}

// ============================================================ cyclorama
/** Lathe profile (x = radius, y = height): floor rings → quarter-circle fillet → wall. */
function cycloramaProfile(): Vector2[] {
  const pts: Vector2[] = [];
  const floorSteps = 14;
  for (let i = 0; i <= floorSteps; i++) pts.push(new Vector2(Math.max(0.001, (STUDIO_FLOOR_R * i) / floorSteps), 0));
  const filletSteps = 12;
  for (let i = 1; i <= filletSteps; i++) {
    const a = (i / filletSteps) * (Math.PI / 2);
    pts.push(new Vector2(STUDIO_FLOOR_R + STUDIO_FILLET_R * Math.sin(a), STUDIO_FILLET_R * (1 - Math.cos(a))));
  }
  const wallSteps = 8;
  for (let i = 1; i <= wallSteps; i++) {
    pts.push(new Vector2(STUDIO_FLOOR_R + STUDIO_FILLET_R, STUDIO_FILLET_R + ((STUDIO_WALL_H - STUDIO_FILLET_R) * i) / wallSteps));
  }
  return pts;
}

/** Studio grading (linear multiplier on the albedo): light pool, darker up the wall and away from the back. */
function cycloramaShade(x: number, y: number, z: number): number {
  const r = Math.hypot(x, z);
  const pool = 0.45 + 0.55 * Math.exp(-(r * r) / (2 * 5.2 * 5.2));
  // 1 behind the car (−Z, the default view's backdrop), 0 in front.
  const back = 0.5 - 0.5 * (r > 1e-3 ? z / r : 0);
  const up = Math.exp(-Math.max(0, y - 1.2) / 5.5);
  const wall = y > 0.01 ? (0.55 + 0.45 * back) * up : 1;
  return Math.min(1, (y > 0.01 ? 0.62 : pool) * wall);
}

function createCyclorama(): Mesh<LatheGeometry, MeshStandardMaterial> {
  const geo = new LatheGeometry(cycloramaProfile(), 144);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = cycloramaShade(pos.getX(i), pos.getY(i), pos.getZ(i));
    colors[3 * i] = s;
    colors[3 * i + 1] = s;
    colors[3 * i + 2] = s * 1.02;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  const mat = new MeshStandardMaterial({
    name: 'studio.cyclorama',
    color: new Color().setRGB(0.05, 0.052, 0.058),
    roughness: 0.55,
    metalness: 0,
    vertexColors: true,
    side: BackSide,
    envMapIntensity: 0.22,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'studio.cyclorama';
  mesh.receiveShadow = true;
  return mesh;
}

// ============================================================ reflection overlay
const FLOOR_REFLECTION_SHADER = {
  name: 'StudioFloorReflection',
  uniforms: {
    color: { value: null as Color | null },
    tDiffuse: { value: null as Texture | null },
    textureMatrix: { value: null as unknown },
    uFadeR: { value: new Vector2(2.5, 9.5) },
    uStrength: { value: 0.9 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4( position, 1.0 );
      vec4 w = modelMatrix * vec4( position, 1.0 );
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform vec2 uFadeR;
    uniform float uStrength;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      float r = length( vWorld.xz );
      // Glossy, not mirror: blur grows with distance from the car (mip LOD + a 4-tap cross).
      float lod = mix( 1.2, 4.0, smoothstep( 0.5, uFadeR.y, r ) );
      vec2 texel = 1.0 / vec2( textureSize( tDiffuse, 0 ) );
      float o = exp2( lod ) * 0.75;
      vec3 c = textureLod( tDiffuse, uv, lod ).rgb * 0.4;
      c += textureLod( tDiffuse, uv + vec2( o, 0.0 ) * texel, lod ).rgb * 0.15;
      c += textureLod( tDiffuse, uv - vec2( o, 0.0 ) * texel, lod ).rgb * 0.15;
      c += textureLod( tDiffuse, uv + vec2( 0.0, o ) * texel, lod ).rgb * 0.15;
      c += textureLod( tDiffuse, uv - vec2( 0.0, o ) * texel, lod ).rgb * 0.15;
      vec3 v = normalize( cameraPosition - vWorld );
      float f = 0.06 + 0.94 * pow( 1.0 - clamp( v.y, 0.0, 1.0 ), 5.0 );
      float fade = 1.0 - smoothstep( uFadeR.x, uFadeR.y, r );
      float a = clamp( f * uStrength * fade, 0.0, 0.85 );
      gl_FragColor = vec4( c * color, a );
      #include <colorspace_fragment>
    }`,
};

// ============================================================ turntable ring
function createRingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    name: 'studio.ring',
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uR: { value: TURNTABLE_R }, uColor: { value: new Color().setRGB(2.4, 1.15, 0.42) }, uGroove: { value: new Color().setRGB(0.05, 0.055, 0.065) } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform float uR;
      uniform vec3 uColor;
      uniform vec3 uGroove;
      varying vec2 vP;
      void main() {
        float r = length( vP );
        float d = r - uR;
        // Screen-space width keeps the core line ~1.5 px wide at any distance (no aliasing).
        float px = max( fwidth( r ), 1e-4 );
        float core = 1.0 - smoothstep( 0.0, 1.5 * px + 0.006, abs( d ) );
        float halo = exp( - d * d / ( 2.0 * 0.06 * 0.06 ) ) * 0.22;
        float groove = 1.0 - smoothstep( 0.0, 1.2 * px + 0.004, abs( d + 0.16 ) );
        vec3 c = uColor * ( core + halo ) + uGroove * groove * 2.0;
        gl_FragColor = vec4( c, 1.0 );
        #include <colorspace_fragment>
      }`,
  });
}

// ============================================================ contact shadow (baked, turns with the car)
function contactShadowTexture(v: StudioVehicle, half: [number, number]): CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d')!;
  // alphaMap reads the GREEN channel: white shapes on opaque black.
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const toPx = (x: number, z: number): [number, number] => [((x / half[0]) * 0.5 + 0.5) * S, ((z / half[1]) * 0.5 + 0.5) * S];
  const { min, max } = v.extent;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  // Footprint: stacked translucent rounded rects = a soft falloff without canvas filters (Safari lacks ctx.filter).
  const w = max[0] - min[0];
  const l = max[2] - min[2];
  const layers = 18;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const grow = 0.55 * (1 - t);
    const [x0, z0] = toPx(min[0] - cx - grow + 0.12, min[2] - cz - grow + 0.25);
    const [x1, z1] = toPx(max[0] - cx + grow - 0.12, max[2] - cz + grow - 0.25);
    const rad = Math.min(x1 - x0, z1 - z0) * 0.35;
    g.fillStyle = `rgba(255,255,255,${0.05 + 0.03 * t})`;
    g.beginPath();
    g.roundRect(x0, z0, Math.max(1, x1 - x0), Math.max(1, z1 - z0), Math.max(0, rad));
    g.fill();
  }
  // Tyre patches: dense dark ellipses under each wheel.
  const p = v.compiled.rig.nodePos;
  for (const wh of v.compiled.wheels) {
    const x = (p[3 * wh.hubI]! + p[3 * wh.hubO]!) / 2 - cx;
    const z = (p[3 * wh.hubI + 2]! + p[3 * wh.hubO + 2]!) / 2 - cz;
    const [px, pz] = toPx(x, z);
    const rx = (Math.abs(p[3 * wh.hubO]! - p[3 * wh.hubI]!) * 0.9 + 0.12) / (2 * half[0]) * S;
    const rz = (wh.radius * 0.9) / (2 * half[1]) * S;
    const grad = g.createRadialGradient(px, pz, 0, px, pz, Math.max(rx, rz) * 1.4);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(px, pz, rx * 1.4, rz * 1.4, 0, 0, Math.PI * 2);
    g.fill();
  }
  void w;
  void l;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

// ============================================================ factory
interface CachedVisual {
  visual: VehicleVisualHandle;
  vehicle: StudioVehicle;
  rest: Float64Array;
  nodes: Float32Array;
  shadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  center: [number, number];
  ready: Promise<void>;
}

export function createStudio(renderer: WebGLRenderer, opts: StudioOptions): Studio {
  const scene = new Scene();
  scene.name = 'studio';
  scene.background = new Color().setRGB(0.006, 0.0065, 0.008);
  const camera = new PerspectiveCamera(STUDIO_FOV, opts.width / Math.max(1, opts.height), 0.1, 120);
  scene.add(camera);

  const environment = buildEnvironment(renderer);
  scene.environment = environment;
  scene.environmentIntensity = ENV_INTENSITY;

  // ---- lights
  // Key: an overhead soft-box spot whose pool of light IS the set (falls off into the dark cyc).
  const key = new SpotLight(0xffffff, KEY_SPOT_CD, 30, 0.5, 0.95, 2);
  key.color.setRGB(1, 0.965, 0.92);
  key.position.set(0.8, 9.5, 2.6);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 4;
  key.shadow.camera.far = 16;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 10;
  key.name = 'studio.key';
  scene.add(key, key.target);
  // A weak directional twin: the stack's `sun` (flake glints, anything that wants a key direction).
  const sun = new DirectionalLight(0xffffff, KEY_INTENSITY);
  sun.color.copy(key.color);
  sun.position.copy(key.position);
  sun.target.position.set(0, 0, 0);
  sun.name = 'studio.sun';
  scene.add(sun, sun.target);

  const rimL = new SpotLight(0xcfe0ff, 70, 22, 0.55, 1, 2);
  rimL.position.set(-5.5, 3.6, -6);
  rimL.target.position.set(0, 0.6, 0);
  const rimR = new SpotLight(0xcfe0ff, 70, 22, 0.55, 1, 2);
  rimR.position.set(5.5, 3.6, -6);
  rimR.target.position.set(0, 0.6, 0);
  const kicker = new SpotLight(0xffc796, 110, 18, 0.7, 1, 2);
  kicker.position.set(-4, 1.2, 6.5);
  kicker.target.position.set(0, 0.5, 0);
  // The cyc behind the car: a broad wash so the backdrop glows behind the silhouette.
  const wash = new SpotLight(0xdfe6f2, 70, 40, 0.6, 1, 2);
  wash.position.set(0, 7, 4);
  wash.target.position.set(0, 2.2, -STUDIO_FLOOR_R - STUDIO_FILLET_R);
  const hemi = new HemisphereLight(0x8a93a3, 0x0c0d10, 0.06);
  for (const l of [rimL, rimR, kicker, wash]) scene.add(l, l.target);
  scene.add(hemi);

  // ---- set
  const cyc = createCyclorama();
  scene.add(cyc);

  const reflector = new Reflector(new CircleGeometry(STUDIO_FLOOR_R, 96), {
    shader: FLOOR_REFLECTION_SHADER,
    textureWidth: 512,
    textureHeight: 512,
    clipBias: 0.002,
    multisample: 0,
    color: 0xb9bec8,
  });
  reflector.name = 'studio.floorReflection';
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.y = 0.002;
  const reflMat = reflector.material as Mesh['material'] & { transparent: boolean; depthWrite: boolean; uniforms: Record<string, { value: unknown }> };
  reflMat.transparent = true;
  reflMat.depthWrite = false;
  const reflRT = reflector.getRenderTarget();
  reflRT.texture.generateMipmaps = true;
  reflRT.texture.minFilter = LinearMipmapLinearFilter;
  scene.add(reflector);

  const turntable = new Group();
  turntable.name = 'studio.turntable';
  scene.add(turntable);
  // Turntable edge: a soft glowing band (analytic radial profile: no thin-line aliasing) + a faint inner groove.
  const ring = new Mesh(new RingGeometry(TURNTABLE_R - 0.32, TURNTABLE_R + 0.32, 192, 1), createRingMaterial());
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  ring.renderOrder = 2;
  scene.add(ring);

  // ---- lighting stack for the vehicle materials (no CSM: plain shadowed lights)
  const lighting: LightingStack = {
    sun,
    sunDirection: sun.position.clone().normalize(),
    csm: null,
    environment,
    update() {},
    setQuality() {},
    dispose() {},
  };
  const ctx: RenderContext = { renderer, scene, camera, quality: opts.quality, width: opts.width, height: opts.height, sampler: null };
  const post = createPostStack(ctx);

  // ---- vehicles
  const cache = new Map<string, CachedVisual>();
  let current: CachedVisual | null = null;
  let angle = Math.PI - 0.7;
  let idle = TURNTABLE_IDLE_S;
  const frameIn: VehicleFrameInput = {
    nodes: new Float32Array(0),
    nodeOffset: 0,
    tick: 0,
    broken: new Uint8Array(0),
    repairEpoch: 0,
    telemetry: null,
    dtS: 0,
  };

  // ---- camera rig
  const look = new Vector3(0, 0.62, 0);
  let fitDistance = 7;
  const cam = { yaw: 0.18, pitch: 0.16, zoom: 1 };
  const goal = { yaw: 0.18, pitch: 0.16, zoom: 1 };
  /** Shift (CSS px, + = right / up) and the fraction of the view width the car may fill. */
  const framing = { x: 0, y: 0, fill: 0.5 };
  let width = opts.width;
  let height = opts.height;

  const fit = (v: StudioVehicle | null): void => {
    const min = v ? v.extent.min : [-0.95, 0, -2.4];
    const max = v ? v.extent.max : [0.95, 1.45, 2.4];
    const len = max[2]! - min[2]!;
    const wid = max[0]! - min[0]!;
    const h = max[1]! - min[1]!;
    // Silhouette radius: the car seen at three-quarters is a little shorter than its bounding sphere.
    const r = 0.36 * Math.hypot(len, wid, h);
    const tanV = Math.tan((STUDIO_FOV * Math.PI) / 360);
    const aspect = width / Math.max(1, height);
    const tanH = tanV * aspect;
    // Horizontally the car spans `framing.fill` of the view; vertically at most 62 %.
    const dH = r / (tanH * Math.max(0.2, framing.fill));
    const dV = r / (tanV * 0.62);
    fitDistance = Math.max(dH, dV, r * 2);
    look.set(0, Math.min(0.7, h * 0.36), 0);
  };

  const applyViewOffset = (): void => {
    camera.aspect = width / Math.max(1, height);
    if (framing.x !== 0 || framing.y !== 0) camera.setViewOffset(width, height, -framing.x, framing.y, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };

  const placeCamera = (): void => {
    const d = fitDistance * cam.zoom;
    const cp = Math.cos(cam.pitch);
    camera.position.set(look.x + Math.sin(cam.yaw) * cp * d, look.y + Math.sin(cam.pitch) * d, look.z + Math.cos(cam.yaw) * cp * d);
    camera.lookAt(look);
    camera.updateMatrixWorld();
  };

  const buildVisual = (v: StudioVehicle): CachedVisual => {
    const visual = createVehicleVisual(ctx, v.compiled, v.visual, { lighting, patchMaterial: opts.patchMaterial, settle: false, lods: false, fx: false });
    visual.setPaint(v.paint);
    visual.object.visible = false;
    turntable.add(visual.object);
    const rest = v.compiled.rig.nodePos;
    const { min, max } = v.extent;
    const center: [number, number] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
    const half: [number, number] = [(max[0] - min[0]) * 0.5 + 0.9, (max[2] - min[2]) * 0.5 + 0.9];
    const shadowTex = contactShadowTexture(v, half);
    const shadow = new Mesh(
      new PlaneGeometry(half[0] * 2, half[1] * 2),
      new MeshBasicMaterial({ name: 'studio.contactShadow', color: 0x000000, alphaMap: shadowTex, transparent: true, depthWrite: false, opacity: 0.92 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.003;
    shadow.renderOrder = 1;
    shadow.visible = false;
    turntable.add(shadow);
    // Compile against the composer's HalfFloat target (programs key on the output colour space).
    renderer.setRenderTarget(post.composer.inputBuffer);
    const p = renderer.compileAsync(visual.object, camera, scene);
    renderer.setRenderTarget(null);
    const ready = p.then(
      () => undefined,
      (e: unknown) => console.warn('[showroom] vehicle pre-compile failed', e),
    );
    return { visual, vehicle: v, rest, nodes: new Float32Array(rest.length), shadow, center, ready };
  };

  const disposeCached = (c: CachedVisual): void => {
    c.visual.dispose();
    c.shadow.removeFromParent();
    c.shadow.geometry.dispose();
    c.shadow.material.alphaMap?.dispose();
    c.shadow.material.dispose();
  };

  /** Rest nodes → centred on the turntable, rotated by `angle` about +Y. */
  const feed = (c: CachedVisual, dt: number): void => {
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    const [cx, cz] = c.center;
    const r = c.rest;
    const out = c.nodes;
    for (let i = 0; i < out.length; i += 3) {
      const x = r[i]! - cx;
      const z = r[i + 2]! - cz;
      out[i] = x * cs + z * sn;
      out[i + 1] = r[i + 1]!;
      out[i + 2] = -x * sn + z * cs;
    }
    if (frameIn.broken.length !== c.vehicle.compiled.rig.beamCount) frameIn.broken = new Uint8Array(c.vehicle.compiled.rig.beamCount);
    frameIn.nodes = out;
    frameIn.dtS = dt;
    c.visual.update(frameIn);
    c.shadow.rotation.z = angle;
  };

  const resizeReflection = (): void => {
    const pr = renderer.getPixelRatio();
    reflRT.setSize(Math.max(64, Math.round(width * pr * 0.5)), Math.max(64, Math.round(height * pr * 0.5)));
  };

  let token = 0;
  const studio: Studio = {
    scene,
    camera,
    post,
    get vehicleId() {
      return current ? current.vehicle.id : null;
    },
    get turntableAngle() {
      return angle;
    },
    async setVehicle(v) {
      const my = ++token;
      if (!v) {
        if (current) current.visual.object.visible = current.shadow.visible = false;
        current = null;
        return;
      }
      let c = cache.get(v.id);
      if (!c) {
        c = buildVisual(v);
        cache.set(v.id, c);
      }
      c.visual.setPaint(v.paint);
      await c.ready;
      if (my !== token) return;
      if (current && current !== c) current.visual.object.visible = current.shadow.visible = false;
      current = c;
      c.visual.object.visible = true;
      c.shadow.visible = true;
      fit(c.vehicle);
    },
    setPaint(paint) {
      current?.visual.setPaint(paint);
    },
    orbit(dx, dy) {
      goal.yaw -= dx * 0.0062;
      goal.pitch = Math.min(STUDIO_PITCH[1], Math.max(STUDIO_PITCH[0], goal.pitch + dy * 0.0042));
      idle = 0;
    },
    zoom(deltaY) {
      goal.zoom = Math.min(STUDIO_ZOOM[1], Math.max(STUDIO_ZOOM[0], goal.zoom * Math.exp(deltaY * 0.0011)));
      idle = 0;
    },
    intro() {
      cam.yaw = goal.yaw - 0.9;
      cam.pitch = Math.min(STUDIO_PITCH[1], goal.pitch + 0.16);
      cam.zoom = goal.zoom * 1.55;
    },
    setFraming(x, y, fill) {
      framing.x = x;
      framing.y = y;
      if (fill !== undefined) framing.fill = fill;
      applyViewOffset();
      fit(current ? current.vehicle : null);
    },
    frame(dtS) {
      const dt = Math.min(Math.max(dtS, 0), 0.1);
      idle += dt;
      // Turntable: eases back in after the user lets go.
      const spin = TURNTABLE_SPEED * Math.min(1, Math.max(0, (idle - TURNTABLE_IDLE_S) / 1.5));
      angle += spin * dt;
      const k = 1 - Math.exp(-4.2 * dt);
      cam.yaw += (goal.yaw - cam.yaw) * k;
      cam.pitch += (goal.pitch - cam.pitch) * k;
      cam.zoom += (goal.zoom - cam.zoom) * (1 - Math.exp(-3 * dt));
      placeCamera();
      // Reflections follow the photographer (see buildEnvironment).
      scene.environmentRotation.y = ENV_FOLLOW_SIGN * cam.yaw;
      if (current) feed(current, dt);
      post.render(dt);
    },
    setSize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      ctx.width = width;
      ctx.height = height;
      applyViewOffset();
      fit(current ? current.vehicle : null);
      post.setSize(width, height);
      resizeReflection();
    },
    setQuality(q) {
      ctx.quality = q;
      post.setQuality(q);
    },
    dispose() {
      token++;
      for (const c of cache.values()) disposeCached(c);
      cache.clear();
      current = null;
      post.dispose();
      reflector.dispose();
      reflector.geometry.dispose();
      cyc.geometry.dispose();
      cyc.material.dispose();
      ring.geometry.dispose();
      ring.material.dispose();
      key.shadow.map?.dispose();
      key.dispose();
      sun.dispose();
      for (const l of [rimL, rimR, kicker, wash]) l.dispose();
      hemi.dispose();
      environment.dispose();
      scene.clear();
    },
  };
  fit(null);
  applyViewOffset();
  resizeReflection();
  placeCamera();
  return studio;
}

/** Objects of a studio (debug: draw counts in tests). */
export function studioObjects(s: Studio): Object3D[] {
  return s.scene.children.slice();
}
