/**
 * DEV ONLY — graphics-stack spike preview (not part of the production build:
 * vite builds index.html only). Open /crumple/dev/lighting.html.
 *
 * Keys: 1–4 quality low/medium/high/ultra · V next view · A AO-only view ·
 * T tone mapping ACES/AgX · H toggle HUD · P pause adaptive resolution.
 * URL: ?q=<level> ?view=<n> ?hud=0 ?adaptive=0
 * window.__lighting exposes hooks for e2e/screenshots.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ToneMappingMode } from 'postprocessing';

import { createQualityControllerWith } from '../src/app/quality';
import { loadTerrainSet } from '../src/assets/loader';
import { createFbm2, createSeededNoise2D } from '../src/core/noise';
import { createRng } from '../src/core/rng';
import { createLightingStack, ENV_GRADE, lightingDebug } from '../src/render/lighting';
import { patchMaterial } from '../src/render/material';
import { createPostStack, postDebug } from '../src/render/post';
import { QUALITY_LEVELS, QUALITY_PRESETS } from '../src/render/types';
import type { QualityLevel, RenderContext } from '../src/render/types';
import { createVehicleMaterials, PAINT_NAMES, PAINT_PALETTE } from '../src/render/vehicle/materials';
import type { FlexSkin, MaterialSlot, PaintDef, VehicleMaterialSet, VehicleVisualDef, WheelVisualDef } from '../src/render/vehicle/types';
import { createWheelVisuals } from '../src/render/vehicle/wheels';
import { compileVehicle } from '../src/sim/vehicle/builder';
import { SEDAN } from '../src/sim/vehicle/defs/sedan';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
hud.hidden = params.get('hud') === '0';

const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;

const scene = new Scene();
const camera = new PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 3000);
const initialLevel = (QUALITY_LEVELS as readonly string[]).includes(params.get('q') ?? '') ? (params.get('q') as QualityLevel) : 'high';
const ctx: RenderContext = {
  renderer,
  scene,
  camera,
  quality: QUALITY_PRESETS[initialLevel],
  width: innerWidth,
  height: innerHeight,
  sampler: null,
};
renderer.setSize(ctx.width, ctx.height, false);

const gradeParam = params.get('grade')?.split(',').map(Number);
if (gradeParam?.length === 3 && gradeParam.every(Number.isFinite)) ENV_GRADE.splice(0, 3, ...(gradeParam as [number, number, number]));
const hdriParam = params.get('hdri');
const lighting = await createLightingStack(ctx, hdriParam === 'venice_sunset' ? { hdri: 'venice_sunset' } : {});
const post = createPostStack(ctx);
const quality = createQualityControllerWith(ctx, { lighting, post }, { storage: null, initial: initialLevel });
let adaptive = params.get('adaptive') !== '0';

// ------------------------------------------------------------ materials
const patchedSet = new Map<Material, ReturnType<typeof patchMaterial>>();
function lit<T extends Mesh | InstancedMesh>(mesh: T, cast = true, receive = true): T {
  const m = mesh.material as Material;
  let set = patchedSet.get(m);
  if (!set) {
    set = patchMaterial(m, { csm: lighting.csm });
    patchedSet.set(m, set);
  }
  mesh.material = set.color;
  if (set.depth) mesh.customDepthMaterial = set.depth;
  if (set.distance) mesh.customDistanceMaterial = set.distance;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/** Metallic-flake normal map: per-texel random micro-normals, mipmapped so flakes sparkle up close and average out far away. */
function flakeNormalMap(size = 256, seed = 7): DataTexture {
  const rng = createRng(seed);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = rng.range(-1, 1) * 0.55;
    const y = rng.range(-1, 1) * 0.55;
    const z = 1;
    const l = Math.hypot(x, y, z);
    data[i * 4] = Math.round(((x / l) * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round(((y / l) * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(((z / l) * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.repeat.set(24, 24);
  t.needsUpdate = true;
  return t;
}
const flakes = flakeNormalMap();

const paint = (hex: number): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({
    name: `paint-${hex.toString(16)}`,
    color: hex,
    metalness: 0.72,
    roughness: 0.3,
    normalMap: flakes,
    normalScale: new Vector2(0.32, 0.32),
    clearcoat: 1,
    clearcoatRoughness: 0.025,
  });
const redPaint = paint(0x6e0309);
const bluePaint = paint(0x0b2a5c);
const chrome = new MeshPhysicalMaterial({ name: 'chrome', color: 0xffffff, metalness: 1, roughness: 0.04 });
const glass = new MeshPhysicalMaterial({
  name: 'glass',
  color: 0xffffff,
  metalness: 0,
  roughness: 0.02,
  transmission: 1,
  thickness: 0.6,
  ior: 1.5,
  specularIntensity: 1,
});
const tint = new MeshPhysicalMaterial({
  name: 'window',
  color: 0x0a0d10,
  metalness: 0,
  roughness: 0.03,
  clearcoat: 1,
  clearcoatRoughness: 0.01,
});
const matte = new MeshStandardMaterial({ name: 'matte', color: 0x5f656e, roughness: 0.82, metalness: 0 });
const satin = new MeshStandardMaterial({ name: 'satin', color: 0x2b2d30, roughness: 0.45, metalness: 0.3 });
const rubber = new MeshStandardMaterial({ name: 'rubber', color: 0x101010, roughness: 0.88 });
const concrete = new MeshStandardMaterial({ name: 'concrete', color: 0x8a857c, roughness: 0.9 });
const lamp = new MeshStandardMaterial({ name: 'lamp', color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 12 });
const tail = new MeshStandardMaterial({ name: 'tail', color: 0x330000, emissive: 0xff1a10, emissiveIntensity: 2 });

// ------------------------------------------------------------ ground
const noise = createFbm2(createSeededNoise2D(11), 5);
const noise2 = createFbm2(createSeededNoise2D(23), 3);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let h = noise(x / 190, z / 190) * 9 * smooth(26, 110, r);
  h += noise2(x / 38, z / 38) * 0.9 * smooth(22, 60, r);
  h += 110 * smooth(330, 720, r) ** 1.4 * (0.65 + 0.35 * noise2(x / 260, z / 260));
  return h;
}

/** Plane with a cubic radial warp: ~0.6 m cells at the centre, ~13 m at the 700 m edge. */
function groundGeometry(half = 720, segs = 300): BufferGeometry {
  const a = 0.13;
  const warp = (t: number): number => half * (a * t + (1 - a) * t * t * t);
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = warp((i / segs) * 2 - 1);
      const z = warp((j / segs) * 2 - 1);
      const k = j * n + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = groundHeight(x, z);
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3;
      uv[k * 2 + 1] = z / 3;
    }
  }
  const idx = new Uint32Array(segs * segs * 6);
  let o = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a0 = j * n + i;
      const b0 = a0 + 1;
      const c0 = a0 + n;
      const d0 = c0 + 1;
      idx.set([a0, c0, b0, b0, c0, d0], o);
      o += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Rough terrain under a bright dawn sky: full F0/F90 env specular reads as a white sheen at grazing angles.
const grassMat = new MeshPhysicalMaterial({ name: 'grass', color: 0xffffff, roughness: 1, specularIntensity: 0.35 });
const ground = lit(new Mesh(groundGeometry(), grassMat), true, true);
ground.name = 'ground';
scene.add(ground);

const asphaltMat = new MeshPhysicalMaterial({
  name: 'asphalt',
  color: 0xffffff,
  roughness: 1,
  specularIntensity: 0.3,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const padGeo = new PlaneGeometry(44, 44);
padGeo.rotateX(-Math.PI / 2);
const pad = lit(new Mesh(padGeo, asphaltMat), false, true);
pad.position.y = 0.002;
scene.add(pad);

let texturesReady = false;
void (async () => {
  const anis = renderer.capabilities.getMaxAnisotropy();
  const [g, a] = await Promise.all([loadTerrainSet('grass', { anisotropy: anis }), loadTerrainSet('asphalt', { anisotropy: anis })]);
  grassMat.map = g.color;
  grassMat.normalMap = g.normal;
  grassMat.roughnessMap = g.rough;
  grassMat.color.set(0xd8d2c0);
  grassMat.needsUpdate = true;
  for (const t of [a.color, a.normal, a.rough]) t.repeat.set(11, 11);
  asphaltMat.map = a.color;
  asphaltMat.normalMap = a.normal;
  asphaltMat.roughnessMap = a.rough;
  asphaltMat.needsUpdate = true;
  texturesReady = true;
})();

// ------------------------------------------------------------ cars
function car(body: Material): Group {
  const g = new Group();
  const shell = lit(new Mesh(new RoundedBoxGeometry(4.5, 0.72, 1.86, 5, 0.22), body));
  shell.position.y = 0.66;
  g.add(shell);
  const hood = lit(new Mesh(new RoundedBoxGeometry(1.5, 0.2, 1.74, 4, 0.09), body));
  hood.position.set(1.45, 1.0, 0);
  g.add(hood);
  const cabin = lit(new Mesh(new RoundedBoxGeometry(2.3, 0.62, 1.62, 5, 0.24), tint));
  cabin.position.set(-0.35, 1.25, 0);
  g.add(cabin);
  const roof = lit(new Mesh(new RoundedBoxGeometry(1.7, 0.08, 1.5, 3, 0.04), body));
  roof.position.set(-0.45, 1.57, 0);
  g.add(roof);
  for (const z of [-0.94, 0.94]) {
    const trim = lit(new Mesh(new BoxGeometry(3.6, 0.05, 0.03), chrome));
    trim.position.set(-0.05, 0.86, z);
    g.add(trim);
  }
  for (const x of [-2.27, 2.27]) {
    const bumper = lit(new Mesh(new RoundedBoxGeometry(0.16, 0.18, 1.8, 3, 0.06), chrome));
    bumper.position.set(x, 0.42, 0);
    g.add(bumper);
  }
  for (const z of [-0.62, 0.62]) {
    const head = lit(new Mesh(new BoxGeometry(0.06, 0.12, 0.34), lamp), false, false);
    head.position.set(2.26, 0.78, z);
    g.add(head);
    const tl = lit(new Mesh(new BoxGeometry(0.06, 0.1, 0.4), tail), false, false);
    tl.position.set(-2.26, 0.8, z);
    g.add(tl);
  }
  const tireGeo = new CylinderGeometry(0.35, 0.35, 0.26, 40);
  tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new CylinderGeometry(0.23, 0.23, 0.27, 32);
  rimGeo.rotateX(Math.PI / 2);
  for (const x of [-1.42, 1.42]) {
    for (const z of [-0.84, 0.84]) {
      const t = lit(new Mesh(tireGeo, rubber));
      t.position.set(x, 0.35, z);
      g.add(t);
      const r = lit(new Mesh(rimGeo, chrome));
      r.position.set(x, 0.35, z);
      g.add(r);
    }
  }
  return g;
}

const hero = car(redPaint);
scene.add(hero);
const second = car(bluePaint);
second.position.set(-7.5, 0, -5.2);
second.rotation.y = 0.55;
scene.add(second);
const third = car(satin);
third.position.set(-1.5, 0, 7.8);
third.rotation.y = Math.PI - 0.15;
scene.add(third);

// spheres + blocks
const spheres: [Material, number, number][] = [
  [chrome, 6.5, -1.6],
  [glass, 6.5, 1.0],
  [redPaint, 6.5, 3.6],
  [matte, 6.5, 6.2],
];
for (const [m, x, z] of spheres) {
  const s = lit(new Mesh(new SphereGeometry(0.85, 64, 32), m));
  s.position.set(x, 0.85, z);
  scene.add(s);
}
for (let i = 0; i < 6; i++) {
  const b = lit(new Mesh(new BoxGeometry(2.0, 0.8, 0.6), concrete));
  b.position.set(-12 + i * 2.15, 0.4, -10.5);
  b.rotation.y = 0.02 * (i % 2 ? 1 : -1);
  scene.add(b);
}
for (const [x, z, s] of [
  [9.5, -6.5, 1.2],
  [11, -4.6, 0.9],
  [10.2, -8.5, 1.5],
] as const) {
  const c = lit(new Mesh(new BoxGeometry(s, s, s), matte));
  c.position.set(x, s / 2, z);
  c.rotation.y = x * 0.7;
  scene.add(c);
}
const pole = lit(new Mesh(new CylinderGeometry(0.09, 0.12, 7.5, 16), satin));
pole.position.set(3.5, 3.75, -9);
scene.add(pole);
const arm = lit(new Mesh(new BoxGeometry(2.2, 0.1, 0.12), satin));
arm.position.set(2.5, 7.45, -9);
scene.add(arm);

// distant landmarks + trees (cascade/fog depth cues)
const rng = createRng(5);
const tmp = new Object3D();
const blocks: [number, number][] = [];
for (let i = 0; i < 40; i++) {
  const ang = rng.range(0, Math.PI * 2);
  const r = rng.range(60, 560);
  blocks.push([Math.cos(ang) * r, Math.sin(ang) * r]);
}
const blockMesh = lit(new InstancedMesh(new BoxGeometry(1, 1, 1), concrete, blocks.length));
blocks.forEach(([x, z], i) => {
  const w = rng.range(4, 14);
  const h = rng.range(3, 16);
  tmp.position.set(x, groundHeight(x, z) + h / 2 - 0.5, z);
  tmp.rotation.set(0, rng.range(0, Math.PI), 0);
  tmp.scale.set(w, h, rng.range(4, 14));
  tmp.updateMatrix();
  blockMesh.setMatrixAt(i, tmp.matrix);
});
scene.add(blockMesh);

const TREES = 260;
const keepClear = (x: number, z: number): boolean =>
  [
    [-5.6, 6.4],
    [-1.2, 7.4],
    [5.4, -4.7],
    [12.6, -2.2],
    [3.6, 3.0],
    [-26, 22],
    [-14, -12],
    [6, -16],
    [-60, 70],
  ].some(([cx, cz]) => Math.hypot(x - cx!, z - cz!) < 16);
const foliage = new MeshStandardMaterial({ name: 'foliage', color: 0x2c4a22, roughness: 0.9 });
const bark = new MeshStandardMaterial({ name: 'bark', color: 0x4a3626, roughness: 0.95 });
const crownGeo = new ConeGeometry(1.6, 5.5, 10);
crownGeo.translate(0, 4.6, 0);
const trunkGeo = new CylinderGeometry(0.16, 0.22, 2.2, 8);
trunkGeo.translate(0, 1.1, 0);
const crowns = lit(new InstancedMesh(crownGeo, foliage, TREES));
const trunks = lit(new InstancedMesh(trunkGeo, bark, TREES));
const m4 = new Matrix4();
const q = new Quaternion();
for (let i = 0; i < TREES; i++) {
  let x = 0;
  let z = 0;
  do {
    const ang = rng.range(0, Math.PI * 2);
    const r = 30 + rng.float() ** 1.6 * 520;
    x = Math.cos(ang) * r;
    z = Math.sin(ang) * r;
  } while (keepClear(x, z));
  const s = rng.range(0.7, 1.5);
  q.setFromAxisAngle(new Vector3(0, 1, 0), rng.range(0, 6.28));
  m4.compose(new Vector3(x, groundHeight(x, z) - 0.1, z), q, new Vector3(s, s * rng.range(0.85, 1.3), s));
  crowns.setMatrixAt(i, m4);
  trunks.setMatrixAt(i, m4);
}
scene.add(crowns, trunks);

// ------------------------------------------------------------ car materials showcase (?show=materials)
// Paint palette pebbles + a flake/orange-peel hood panel, the sedan's soft-body wheels in a settled
// pose (tyre flat from synthetic contact), lamp boards OFF vs ON, side glass over an interior.
const showMaterials = params.get('show') === 'materials';
const matShow = {
  lampsOn: null as VehicleMaterialSet | null,
  wheelSkin: null as { object: Group; nodeData: Float32Array } | null,
  wheels: null as ReturnType<typeof createWheelVisuals> | null,
  restNodes: null as Float32Array | null,
  compiled: null as ReturnType<typeof compileVehicle> | null,
};
if (showMaterials) {
  for (const o of [hero, second, third]) o.visible = false;
  for (const o of scene.children) if (o instanceof Mesh && o.geometry instanceof SphereGeometry) o.visible = false;
  const show = new Group();
  show.name = 'materialsShowcase';
  scene.add(show);
  const SHOW_WHEELS: WheelVisualDef = {
    rim: { style: 'spoke', spokes: 5, spokeWidth: 0.34, dish: 0.034, lip: 0.012, finish: 'silver', boltCount: 5 },
    tire: { tread: 'street', sidewallText: 'Crumple Sport', bulge: 0.1 },
    brake: { discRadius: 0.15, caliperColor: 0xc8102e },
  };
  /** Gently domed lens quad in rig-local metres (facing ±z), as both a MeshSurface and a BufferGeometry. */
  const lens = (x0: number, x1: number, y0: number, y1: number, z: number, facing: 1 | -1, bulge = 0.012) => {
    const nu = 16;
    const nv = 8;
    const position: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const v = j / nv;
        const x = x0 + (x1 - x0) * u;
        const y = y0 + (y1 - y0) * v;
        const b = (1 - (2 * u - 1) ** 2) * (1 - (2 * v - 1) ** 2);
        position.push(x, y, z + facing * bulge * b);
        uv.push(Math.abs(x - x0), y - y0);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i;
        const c = a + nu + 1;
        const flip = (facing > 0) === (x1 > x0);
        if (flip) index.push(a, a + 1, c, a + 1, c + 1, c);
        else index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(index);
    g.computeVertexNormals();
    return { surface: { type: 'mesh' as const, position, index, uv }, geometry: g };
  };
  const mirrorPair = (x0: number, x1: number, y0: number, y1: number, z: number, facing: 1 | -1) => [lens(x0, x1, y0, y1, z, facing), lens(-x0, -x1, y0, y1, z, facing)];
  const LAMPS = {
    lightHead: mirrorPair(0.4, 0.8, 0.62, 0.75, -2.2, -1),
    lightIndicator: mirrorPair(0.5, 0.8, 0.565, 0.6, -2.19, -1),
    lightTail: mirrorPair(0.42, 0.82, 0.7, 0.83, 2.2, 1),
    lightReverse: mirrorPair(0.2, 0.38, 0.72, 0.8, 2.2, 1),
  } as const;
  const sidePane = (z0: number, z1: number, y0: number, y1: number) => {
    const position = [-0.86, y0, z0, -0.86, y0, z1, -0.86, y1, z1 - 0.06, -0.86, y1, z0 + 0.04];
    return { type: 'mesh' as const, position, index: [0, 1, 2, 0, 2, 3] };
  };
  const panes = { front: sidePane(-0.62, 0.12, 0.98, 1.34), rear: sidePane(0.24, 1.0, 0.98, 1.32) };
  const visualDef = (paintDef: PaintDef): VehicleVisualDef => ({
    vehicle: 'showcase',
    paint: paintDef,
    wheels: SHOW_WHEELS,
    panels: [
      ...Object.entries(LAMPS).flatMap(([slot, pair]) =>
        pair.map((l, k) => ({ id: `${slot}${k}`, kind: 'light' as const, material: slot as MaterialSlot, surface: l.surface, bind: [], detach: null })),
      ),
      { id: 'glassF', kind: 'glass' as const, material: 'glass' as const, surface: panes.front, bind: [], detach: null },
      { id: 'glassR', kind: 'glass' as const, material: 'glass' as const, surface: panes.rear, bind: [], detach: null },
    ],
  });
  const vmat = (set: VehicleMaterialSet, slot: MaterialSlot): Material => set.base(slot).clone();

  // ---- paint pebbles (squashed spheres, UVs rescaled to metres) on pedestals
  const pebbleGeo = new SphereGeometry(0.42, 96, 48);
  {
    const uvA = pebbleGeo.getAttribute('uv') as BufferAttribute;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 2 * Math.PI * 0.42, uvA.getY(i) * Math.PI * 0.42);
  }
  pebbleGeo.scale(1, 0.62, 1);
  const pedestal = new CylinderGeometry(0.26, 0.3, 0.55, 48);
  const sets: VehicleMaterialSet[] = [];
  PAINT_NAMES.forEach((name, k) => {
    const set = createVehicleMaterials(ctx, visualDef(PAINT_PALETTE[name]));
    sets.push(set);
    const x = -4.9 + k * 1.4;
    const peb = lit(new Mesh(pebbleGeo, vmat(set, 'paint')));
    peb.position.set(x, 0.55 + 0.26, -3.2);
    peb.rotation.y = 0.4;
    peb.name = `paint:${name}`;
    show.add(peb);
    const ped = lit(new Mesh(pedestal, vmat(set, 'trim')));
    ped.position.set(x, 0.275, -3.2);
    show.add(ped);
  });
  // ---- hood panel: doubly curved sheet (R 2.6 m) in the hero paint, sun grazing for flake glints
  {
    const R = 2.6;
    const hood = new SphereGeometry(R, 160, 80, Math.PI * 0.5 - 0.36, 0.72, Math.PI * 0.5 - 0.24, 0.48);
    const uvA = hood.getAttribute('uv') as BufferAttribute;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 2 * Math.PI * R, uvA.getY(i) * Math.PI * R);
    const m = lit(new Mesh(hood, vmat(sets[0]!, 'paint')));
    m.position.set(0, 0.85 - R, -6.0);
    m.rotation.set(-Math.PI / 2, 0, 0);
    m.name = 'paint:hood';
    show.add(m);
    const m2 = lit(new Mesh(hood, vmat(sets[1]!, 'paint')));
    m2.position.set(3.4, 0.85 - R, -6.0);
    m2.rotation.set(-Math.PI / 2, 0, 0);
    show.add(m2);
  }

  // ---- wheels: the real sedan rig in a synthetic settled pose (hub 0.281 m, contact sink K·c)
  const compiled = compileVehicle(SEDAN);
  matShow.compiled = compiled;
  const wset = createVehicleMaterials(ctx, visualDef(PAINT_PALETTE.crimsonCandy));
  const wheels = createWheelVisuals(compiled, SHOW_WHEELS, { materials: wset, lighting, patchMaterial });
  const N = compiled.rig.nodeCount;
  const nodes = new Float32Array(N * 4);
  const rp = compiled.rig.nodePos;
  let hubY = 0;
  for (const w of compiled.wheels) hubY += (rp[3 * w.hubI + 1]! + rp[3 * w.hubO + 1]!) / 2 / compiled.wheels.length;
  const dy = 0.281 - hubY;
  for (let i = 0; i < N; i++) nodes.set([rp[3 * i]!, rp[3 * i + 1]! + dy, rp[3 * i + 2]!, 0], 4 * i);
  matShow.restNodes = nodes.slice();
  const wheelSkin = { object: new Group(), nodeData: nodes };
  wheelSkin.object.position.set(0, 0, 4.5);
  show.add(wheelSkin.object, wheels.object);
  matShow.wheelSkin = wheelSkin;
  matShow.wheels = wheels;
  const settle = (spin: number): void => {
    const src = matShow.restNodes!;
    nodes.set(src);
    for (const w of compiled.wheels) {
      // spin rim + tyre nodes about the rim axis, then press the tyre ring onto y = 0
      const cI = new Vector3();
      const cO = new Vector3();
      for (let k = 0; k < w.rays; k++) {
        cI.add(new Vector3(src[4 * (w.rimStart + k)]!, src[4 * (w.rimStart + k) + 1]!, src[4 * (w.rimStart + k) + 2]!));
        cO.add(new Vector3(src[4 * (w.rimStart + w.rays + k)]!, src[4 * (w.rimStart + w.rays + k) + 1]!, src[4 * (w.rimStart + w.rays + k) + 2]!));
      }
      cI.multiplyScalar(1 / w.rays);
      cO.multiplyScalar(1 / w.rays);
      const c = cI.clone().add(cO).multiplyScalar(0.5);
      const s = cO.clone().sub(cI).normalize();
      const q = new Quaternion().setFromAxisAngle(s, spin);
      for (let k = 0; k < 4 * w.rays; k++) {
        const i = w.rimStart + k; // rim then tyre (contiguous)
        const p = new Vector3(src[4 * i]!, src[4 * i + 1]!, src[4 * i + 2]!).sub(c).applyQuaternion(q);
        if (i >= w.tireStart) {
          const pen = 0.045 - (c.y + p.y);
          if (pen > 0) {
            const radial = p.clone().addScaledVector(s, -p.dot(s));
            const r = radial.length();
            p.addScaledVector(radial, -(pen / 2.17) / r);
          }
        }
        nodes.set([c.x + p.x, c.y + p.y, c.z + p.z], 4 * i);
      }
    }
    wheels.update(wheelSkin as unknown as FlexSkin, 1 / 60);
  };
  settle(0.3);
  (matShow as unknown as { settle: (a: number) => void }).settle = settle;
  // ---- lamp boards: OFF (left) and ON (right), front fascia + rear fascia
  const boards: [number, boolean][] = [
    [7.2, false],
    [9.6, true],
  ];
  for (const [bx, on] of boards) {
    const set = createVehicleMaterials(ctx, visualDef(PAINT_PALETTE.obsidianBlack));
    const root = new Group();
    root.position.set(bx, 0, 3.2);
    root.rotation.y = 0;
    show.add(root);
    for (const z of [-2.17, 2.17]) {
      const fascia = lit(new Mesh(new RoundedBoxGeometry(1.9, 0.5, 0.3, 4, 0.06), vmat(set, 'paint')));
      fascia.position.set(0, 0.67, z - Math.sign(z) * 0.14);
      root.add(fascia);
    }
    for (const [slot, pair] of Object.entries(LAMPS)) {
      for (const l of pair) {
        const m = lit(new Mesh(l.geometry, vmat(set, slot as MaterialSlot)));
        root.add(m);
      }
    }
    if (on) {
      set.setLights({ head: true, highBeam: false, brake: 1, reverse: true, indicatorL: true, indicatorR: false, fog: false });
      matShow.lampsOn = set;
    }
  }

  // ---- glass over an interior (front pane clear, rear pane privacy)
  {
    const set = createVehicleMaterials(ctx, visualDef(PAINT_PALETTE.liquidSilver));
    const root = new Group();
    root.position.set(-7.5, 0, 3.4);
    show.add(root);
    const door = lit(new Mesh(new RoundedBoxGeometry(1.8, 0.62, 2.1, 4, 0.06), vmat(set, 'paint')));
    door.position.set(0, 0.64, 0.2);
    root.add(door);
    const roof = lit(new Mesh(new RoundedBoxGeometry(1.76, 0.07, 1.86, 3, 0.03), vmat(set, 'paint')));
    roof.position.set(0, 1.375, 0.2);
    root.add(roof);
    // closed cabin: far wall, front/rear bulkheads and a dark floor tub so the interior is shaded like a car's
    const shell = vmat(set, 'paint');
    for (const [w, h, d, x, y, z] of [
      [0.04, 0.44, 1.82, 0.84, 1.16, 0.2],
      [1.7, 0.44, 0.04, 0, 1.16, -0.7],
      [1.7, 0.44, 0.04, 0, 1.16, 1.1],
    ] as const) {
      const wall = lit(new Mesh(new BoxGeometry(w, h, d), shell));
      wall.position.set(x, y, z);
      root.add(wall);
    }
    const tub = lit(new Mesh(new BoxGeometry(1.7, 0.02, 1.8), vmat(set, 'interiorTrim')));
    tub.position.set(0, 0.96, 0.2);
    root.add(tub);
    for (const z of [-0.66, 0.18, 1.04]) {
      const pillar = lit(new Mesh(new BoxGeometry(0.06, 0.42, 0.08), vmat(set, 'trim')));
      pillar.position.set(-0.84, 1.16, z);
      root.add(pillar);
    }
    const fabric = vmat(set, 'interior');
    const dash = vmat(set, 'interiorTrim');
    for (const [z, yy] of [
      [0.05, 0.0],
      [0.95, 0.0],
    ] as const) {
      const cushion = lit(new Mesh(new RoundedBoxGeometry(0.55, 0.14, 0.55, 4, 0.05), fabric));
      cushion.position.set(-0.4, 0.74 + yy, z);
      root.add(cushion);
      const back = lit(new Mesh(new RoundedBoxGeometry(0.55, 0.56, 0.14, 4, 0.05), fabric));
      back.position.set(-0.4, 1.02, z + 0.3);
      back.rotation.x = -0.18;
      root.add(back);
      const head = lit(new Mesh(new RoundedBoxGeometry(0.3, 0.16, 0.12, 4, 0.05), fabric));
      head.position.set(-0.4, 1.36, z + 0.36);
      root.add(head);
    }
    const dashboard = lit(new Mesh(new RoundedBoxGeometry(1.6, 0.22, 0.4, 4, 0.06), dash));
    dashboard.position.set(0, 0.98, -0.62);
    root.add(dashboard);
    for (const p of [panes.front, panes.rear]) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(p.position), 3));
      g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      g.setIndex(p.index);
      g.computeVertexNormals();
      const pane = lit(new Mesh(g, vmat(set, 'glass')), false, true);
      root.add(pane);
    }
  }
}

// ------------------------------------------------------------ views
interface View {
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}
const VIEWS: View[] = [
  { name: 'hero', pos: [5.4, 1.05, -4.7], target: [0.1, 0.62, 0.25], fov: 38 },
  { name: 'broadside', pos: [-1.2, 1.2, 7.4], target: [0.3, 0.72, 0], fov: 40 },
  { name: 'side', pos: [-5.6, 1.25, 6.4], target: [0.4, 0.75, 0], fov: 40 },
  { name: 'clearcoat', pos: [3.6, 1.55, 3.0], target: [1.0, 0.85, 0.2], fov: 38 },
  { name: 'wide', pos: [-26, 7.5, 22], target: [10, 2, -6], fov: 50 },
  { name: 'sunward', pos: [-14, 2.2, -12], target: [20, 4, 24], fov: 55 },
  { name: 'shadows', pos: [6, 7.5, -16], target: [-4, 0, -6], fov: 50 },
  { name: 'vista', pos: [-60, 28, 70], target: [120, 5, -140], fov: 55 },
  { name: 'contact', pos: [12.6, 0.9, -2.2], target: [10.2, 0.35, -6.4], fov: 35 },
];
if (showMaterials) {
  VIEWS.push(
    { name: 'mat-paint', pos: [0.3, 1.45, 0.4], target: [0, 0.72, -3.2], fov: 52 },
    { name: 'mat-sparkle', pos: [-1.1, 1.25, -1.9], target: [-0.7, 0.85, -3.2], fov: 34 },
    { name: 'mat-flake', pos: [1.2, 1.3, -7.4], target: [0.0, 0.84, -5.6], fov: 24 },
    { name: 'mat-wheel', pos: [-2.25, 0.52, 2.35], target: [-0.78, 0.3, 3.2], fov: 30 },
    { name: 'mat-lamps-front', pos: [8.4, 1.05, -2.4], target: [8.4, 0.62, 1.0], fov: 44 },
    { name: 'mat-lamps-rear', pos: [8.4, 1.1, 9.0], target: [8.4, 0.72, 5.4], fov: 44 },
    { name: 'mat-glass', pos: [-10.9, 1.35, 3.0], target: [-8.0, 1.12, 3.6], fov: 40 },
  );
}
const viewParam = params.get('view');
const namedView = viewParam ? VIEWS.findIndex((v) => v.name === viewParam) : -1;
let viewIndex = namedView >= 0 ? namedView : Math.min(VIEWS.length - 1, Math.max(0, Number(viewParam ?? 0) | 0));
function setView(i: number): void {
  viewIndex = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length;
  const v = VIEWS[viewIndex]!;
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(...v.target);
}
setView(viewIndex);

// ------------------------------------------------------------ loop
function resize(): void {
  ctx.width = innerWidth;
  ctx.height = innerHeight;
  camera.aspect = ctx.width / ctx.height;
  camera.updateProjectionMatrix();
  post.setSize(ctx.width, ctx.height);
}
window.addEventListener('resize', resize);
resize();

function renderOnce(dt: number): void {
  lighting.update(camera);
  post.render(dt);
}

let last = performance.now();
let emaMs = 16;
let paused = false;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    renderOnce(dt);
    if (adaptive) quality.frame(dt);
    emaMs += (dt * 1000 - emaMs) * 0.05;
    if (!hud.hidden) {
      hud.textContent = `CRUMPLE lighting spike  [1-4] preset  [V] view  [A] AO  [T] tone  [P] adaptive\n${quality.preset.level}  scale ${quality.scale.toFixed(2)}  ${emaMs.toFixed(1)} ms  view ${VIEWS[viewIndex]!.name}  adaptive ${adaptive ? 'on' : 'off'}`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let aoOnly = false;
let agx = false;
window.addEventListener('keydown', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  const lvl = ({ '1': 'low', '2': 'medium', '3': 'high', '4': 'ultra' } as Record<string, QualityLevel>)[k];
  if (lvl) quality.setLevel(lvl);
  else if (k === 'v') setView(viewIndex + (e.shiftKey ? -1 : 1));
  else if (k === 'a') {
    aoOnly = !aoOnly;
    postDebug(post).ao.setDisplayMode(aoOnly ? 'AO' : 'Combined');
  } else if (k === 't') {
    agx = !agx;
    postDebug(post).setToneMapping(agx ? ToneMappingMode.AGX : ToneMappingMode.ACES_FILMIC);
  } else if (k === 'h') hud.hidden = !hud.hidden;
  else if (k === 'p') adaptive = !adaptive;
});

// ------------------------------------------------------------ e2e hooks
function syncGpu(): void {
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

const hooks = {
  ready: false,
  get texturesReady() {
    return texturesReady;
  },
  views: VIEWS.map((v) => v.name),
  get view() {
    return VIEWS[viewIndex]!.name;
  },
  get level() {
    return quality.preset.level;
  },
  get scale() {
    return quality.scale;
  },
  setView(i: number | string) {
    setView(typeof i === 'number' ? i : VIEWS.findIndex((v) => v.name === i));
  },
  setQuality(level: QualityLevel) {
    quality.setLevel(level);
  },
  setAdaptive(on: boolean) {
    adaptive = on;
  },
  pause(p: boolean) {
    paused = p;
  },
  setToneMapping(mode: 'aces' | 'agx') {
    postDebug(post).setToneMapping(mode === 'agx' ? ToneMappingMode.AGX : ToneMappingMode.ACES_FILMIC);
  },
  /** Debug access to the scene graph (materials showcase inspection). */
  get scene() {
    return scene;
  },
  get camera() {
    return camera;
  },
  /** Materials showcase (?show=materials): wheel spin angle (rad) and lamp state of the ON board. */
  setWheelSpin(angle: number) {
    (matShow as unknown as { settle?: (a: number) => void }).settle?.(angle);
  },
  setLamps(state: { head?: boolean; highBeam?: boolean; brake?: number; reverse?: boolean; indicatorL?: boolean; indicatorR?: boolean }) {
    matShow.lampsOn?.setLights({ head: false, highBeam: false, brake: 0, reverse: false, indicatorL: false, indicatorR: false, fog: false, ...state });
  },
  setAoDisplay(mode: 'Combined' | 'AO' | 'No AO') {
    postDebug(post).ao.setDisplayMode(mode);
  },
  setExposure(x: number) {
    renderer.toneMappingExposure = x;
  },
  setSunElevation(deg: number) {
    lightingDebug(lighting).setSunElevation(deg);
  },
  setSunColor(linearHex: number) {
    lightingDebug(lighting).setSunColor(linearHex);
  },
  setFogDensity(x: number) {
    if (scene.fog && 'density' in scene.fog) scene.fog.density = x;
  },
  setEnvIntensity(x: number) {
    scene.environmentIntensity = x;
  },
  setSunIntensity(x: number) {
    for (const l of lighting.csm?.lights ?? [lighting.sun]) l.intensity = x;
  },
  /** Debug: replace every patched material's colour with a plain white to read lighting alone. */
  csmDebug() {
    const c = lighting.csm;
    if (!c) return null;
    return c.lights.map((l) => ({
      pos: l.position.toArray().map((v) => +v.toFixed(1)),
      target: l.target.position.toArray().map((v) => +v.toFixed(1)),
      cam: [l.shadow.camera.left, l.shadow.camera.right, l.shadow.camera.near, l.shadow.camera.far].map((v) => +v.toFixed(2)),
      bias: l.shadow.bias,
      normalBias: l.shadow.normalBias,
      map: l.shadow.map ? [l.shadow.map.width, l.shadow.map.height] : null,
      parent: l.parent?.type ?? null,
      castShadow: l.castShadow,
    }));
  },
  /** Render n frames synchronously (camera static); returns mean wall ms per frame incl. GPU sync. */
  renderFrames(n = 1): number {
    syncGpu();
    renderer.info.autoReset = false;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      renderer.info.reset();
      renderOnce(1 / 60);
      syncGpu();
    }
    renderer.info.autoReset = true;
    return (performance.now() - t0) / Math.max(1, n);
  },
  /** Render once and read a 16×9 grid from the canvas: mean/std of luma (0..255) for e2e sanity checks. */
  sample(): { mean: number; std: number } {
    renderOnce(1 / 60);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    const lumas: number[] = [];
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 16; i++) {
        gl.readPixels(Math.floor(((i + 0.5) / 16) * w), Math.floor(((j + 0.5) / 9) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        lumas.push(0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!);
      }
    }
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const std = Math.sqrt(lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length);
    return { mean, std };
  },
  info() {
    const dbg = lightingDebug(lighting);
    const info = renderer.info;
    return {
      level: quality.preset.level,
      drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
      pixelRatio: renderer.getPixelRatio(),
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      cascades: lighting.csm?.cascades ?? 0,
      breaks: lighting.csm?.breaks.slice() ?? [],
      sunDirection: lighting.sunDirection.toArray(),
      sunAnalysis: dbg.analysis,
      hazeAway: dbg.hazeAway.toArray(),
      hazeSun: dbg.hazeSun.toArray(),
      proceduralSky: dbg.procedural,
      maxTextures: renderer.capabilities.maxTextures,
      gpu: (() => {
        const gl = renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      })(),
    };
  },
};
(window as unknown as { __lighting: typeof hooks }).__lighting = hooks;
renderOnce(1 / 60);
hooks.ready = true;
