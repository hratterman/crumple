/**
 * DEV ONLY — sedan body turntable (static rest pose). Not part of the
 * production build (vite builds index.html only). Open /crumple/dev/body.html.
 *
 * Shows SEDAN_VISUAL tessellated by loft.ts with the real lighting / post
 * stack; materials from A3's createVehicleMaterials when it loads (else
 * plain MeshPhysicalMaterial placeholders, ?mat=plain forces them); wheels
 * from A3's createWheelVisuals on the rest node positions (else simple
 * placeholder wheels).
 *
 * Keys: V / shift+V view · T turntable · W wireframe · L lamps · H HUD · 1–4 quality.
 * URL: ?view=<name> ?lod=1 ?mat=plain ?hud=0 ?q=<level> ?spin=0 ?hide=<id,id>
 * window.__body exposes hooks for screenshots.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';

import { createQualityControllerWith } from '../src/app/quality';
import { loadTerrainSet } from '../src/assets/loader';
import { createLightingStack } from '../src/render/lighting';
import { patchMaterial } from '../src/render/material';
import { createPostStack } from '../src/render/post';
import { QUALITY_LEVELS, QUALITY_PRESETS } from '../src/render/types';
import type { QualityLevel, RenderContext } from '../src/render/types';
import { buildSedanVisual } from '../src/render/vehicle/defs/sedan';
import { tessellateVehicle } from '../src/render/vehicle/loft';
import type { FlexSkin, MaterialSlot, PanelGeometry, VehicleMaterialSet, VehicleVisualDef } from '../src/render/vehicle/types';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
hud.hidden = params.get('hud') === '0';

const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;

const scene = new Scene();
const camera = new PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 3000);
const level = (QUALITY_LEVELS as readonly string[]).includes(params.get('q') ?? '') ? (params.get('q') as QualityLevel) : 'high';
const ctx: RenderContext = { renderer, scene, camera, quality: QUALITY_PRESETS[level], width: innerWidth, height: innerHeight, sampler: null };
renderer.setSize(ctx.width, ctx.height, false);

const lighting = await createLightingStack(ctx, {});
const post = createPostStack(ctx);
const quality = createQualityControllerWith(ctx, { lighting, post }, { storage: null, initial: level });

// ------------------------------------------------------------ lit helper
function lit(mesh: Mesh, mat: Material, cast = true): Mesh {
  const set = patchMaterial(mat, { csm: lighting.csm });
  mesh.material = set.color;
  if (set.depth) mesh.customDepthMaterial = set.depth;
  if (set.distance) mesh.customDistanceMaterial = set.distance;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------ ground
const floorMat = new MeshPhysicalMaterial({ name: 'floor', color: 0xffffff, roughness: 1, specularIntensity: 0.3 });
const floorGeo = new PlaneGeometry(120, 120);
floorGeo.rotateX(-Math.PI / 2);
const floor = lit(new Mesh(floorGeo), floorMat, false);
scene.add(floor);
let texturesReady = false;
void loadTerrainSet('asphalt', { anisotropy: renderer.capabilities.getMaxAnisotropy() })
  .then((a) => {
    for (const t of [a.color, a.normal, a.rough]) t.repeat.set(30, 30);
    floorMat.map = a.color;
    floorMat.normalMap = a.normal;
    floorMat.roughnessMap = a.rough;
    floorMat.needsUpdate = true;
  })
  .finally(() => {
    texturesReady = true;
  });

// ------------------------------------------------------------ car
const lod = params.get('lod') === '1' ? 1 : 0;
const t0 = performance.now();
const def: VehicleVisualDef = buildSedanVisual({ lod });
const t1 = performance.now();
const geoms: PanelGeometry[] = tessellateVehicle(def);
const t2 = performance.now();
const hidden = new Set((params.get('hide') ?? '').split(',').filter(Boolean));

function placeholder(slot: MaterialSlot): MeshStandardMaterial | MeshPhysicalMaterial {
  const P = (o: ConstructorParameters<typeof MeshPhysicalMaterial>[0]): MeshPhysicalMaterial => new MeshPhysicalMaterial(o);
  switch (slot) {
    case 'paint':
      return P({ color: def.paint.color, metalness: def.paint.metallic, roughness: def.paint.roughness, clearcoat: 1, clearcoatRoughness: 0.03 });
    case 'trim':
    case 'grille':
      return P({ color: 0x0b0c0d, roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    case 'chrome':
      return P({ color: 0xffffff, metalness: 1, roughness: 0.06 });
    case 'glass':
      return P({ color: 0x0e1418, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.55, clearcoat: 1 });
    case 'rubber':
      return P({ color: 0x080808, roughness: 0.85 });
    case 'lightHead':
      return P({ color: 0xdfe6ea, roughness: 0.05, metalness: 0.6, clearcoat: 1 });
    case 'lightTail':
      return P({ color: 0x5a0006, roughness: 0.08, clearcoat: 1, emissive: 0x300000 });
    case 'lightIndicator':
      return P({ color: 0x8a4a00, roughness: 0.08, clearcoat: 1 });
    case 'lightReverse':
      return P({ color: 0xdddddd, roughness: 0.08, clearcoat: 1 });
    case 'interior':
      return P({ color: 0x2a2724, roughness: 0.85 });
    case 'interiorTrim':
      return P({ color: 0x141414, roughness: 0.6 });
    case 'mirror':
      return P({ color: 0xffffff, metalness: 1, roughness: 0.02 });
    case 'underbody':
      return P({ color: 0x101010, roughness: 0.9 });
    case 'plate':
      return P({ color: 0xf2f2ee, roughness: 0.4 });
    default:
      return P({ color: 0x777777, roughness: 0.5 });
  }
}

let mats: VehicleMaterialSet | null = null;
if (params.get('mat') !== 'plain') {
  try {
    const m = await import('../src/render/vehicle/materials');
    mats = m.createVehicleMaterials(ctx, def);
    const pn = params.get('paint');
    if (pn && pn in m.PAINT_PALETTE) mats.setPaint(m.PAINT_PALETTE[pn as keyof typeof m.PAINT_PALETTE]);
  } catch (e) {
    console.warn('body preview: A3 materials unavailable, using placeholders', e);
  }
}
const baseFor = (slot: MaterialSlot): Material => (mats ? mats.base(slot).clone() : placeholder(slot));

const car = new Group();
scene.add(car);
const meshes: Mesh[] = [];
let tris = 0;
geoms.forEach((g, i) => {
  const p = def.panels[i]!;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(g.position, 3));
  geo.setAttribute('normal', new BufferAttribute(g.normal, 3));
  geo.setAttribute('uv', new BufferAttribute(g.uv, 2));
  if (g.tangent) geo.setAttribute('tangent', new BufferAttribute(g.tangent, 4));
  geo.setIndex(new BufferAttribute(g.index, 1));
  geo.computeBoundingSphere();
  const mesh = lit(new Mesh(geo), baseFor(p.material), p.castShadow ?? p.material !== 'glass');
  mesh.name = p.id;
  mesh.visible = !hidden.has(p.id);
  tris += g.index.length / 3;
  meshes.push(mesh);
  car.add(mesh);
});

// ------------------------------------------------------------ wheels
let wheelsKind = 'placeholder';
try {
  const [{ createWheelVisuals }, { compileVehicle }, { SEDAN }] = await Promise.all([
    import('../src/render/vehicle/wheels'),
    import('../src/sim/vehicle/builder'),
    import('../src/sim/vehicle/defs/sedan'),
  ]);
  if (!mats) throw new Error('wheels need A3 materials');
  const compiled = compileVehicle(SEDAN);
  const wheels = createWheelVisuals(compiled, def.wheels, { materials: mats, lighting, patchMaterial });
  const N = compiled.rig.nodeCount;
  const nodeData = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) nodeData.set([compiled.rig.nodePos[3 * i]!, compiled.rig.nodePos[3 * i + 1]!, compiled.rig.nodePos[3 * i + 2]!, 0], 4 * i);
  const fakeSkin = { object: new Group(), nodeData, anchor: [0, 0, 0] };
  car.add(fakeSkin.object, wheels.object);
  wheels.update(fakeSkin as unknown as FlexSkin, 1 / 60);
  wheelsKind = 'A3';
} catch (e) {
  console.warn('body preview: placeholder wheels', e);
  const tyreMat = placeholder('rubber');
  const rimMat = new MeshPhysicalMaterial({ color: 0x5a5e64, metalness: 1, roughness: 0.25, clearcoat: 0.6 });
  const prof: Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI;
    prof.push(new Vector2(0.21 + 0.11 * Math.sin(a) * 0.95 + (i === 0 || i === 16 ? 0 : 0.002), -0.1 * Math.cos(a)));
  }
  const tyreGeo = new LatheGeometry(prof, 48);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new CylinderGeometry(0.205, 0.205, 0.19, 40);
  rimGeo.rotateZ(Math.PI / 2);
  for (const [x, z] of [
    [0.78, -1.375],
    [-0.78, -1.375],
    [0.78, 1.375],
    [-0.78, 1.375],
  ] as const) {
    const t = lit(new Mesh(tyreGeo), tyreMat);
    t.position.set(x, 0.32, z);
    const r = lit(new Mesh(rimGeo), rimMat);
    r.position.set(x, 0.32, z);
    car.add(t, r);
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
  { name: 'front34', pos: [-4.6, 1.35, -5.3], target: [0, 0.62, -0.1], fov: 30 },
  { name: 'side', pos: [-8.6, 0.95, 0.0], target: [0, 0.66, 0.02], fov: 30 },
  { name: 'rear34', pos: [4.4, 1.5, 5.6], target: [0, 0.65, 0.1], fov: 30 },
  { name: 'top', pos: [-3.2, 7.8, 0.6], target: [0, 0.5, 0.0], fov: 34 },
  { name: 'front', pos: [0, 1.0, -8.5], target: [0, 0.65, 0], fov: 22 },
  { name: 'rear', pos: [0, 1.15, 8.5], target: [0, 0.68, 0], fov: 22 },
  { name: 'detail', pos: [-1.95, 0.95, -3.1], target: [-0.55, 0.62, -2.0], fov: 26 },
  { name: 'shut', pos: [-2.2, 1.25, -1.25], target: [-0.8, 0.85, -0.8], fov: 24 },
  { name: 'low34', pos: [-4.0, 0.55, -4.4], target: [0, 0.55, -0.4], fov: 32 },
  { name: 'hero', pos: [-3.3, 0.42, -4.6], target: [0.1, 0.62, -0.9], fov: 34 },
  { name: 'lamp', pos: [-1.55, 0.98, -2.75], target: [-0.76, 0.7, -2.08], fov: 24 },
  { name: 'nose', pos: [-1.2, 0.7, -4.4], target: [-0.1, 0.52, -2.2], fov: 30 },
  { name: 'chase', pos: [0, 1.62, 6.3], target: [0, 0.9, -1.0], fov: 50 },
  { name: 'interior', pos: [-1.7, 1.45, -0.2], target: [0, 0.9, -0.2], fov: 45 },
];
let viewIndex = Math.max(
  0,
  VIEWS.findIndex((v) => v.name === params.get('view')),
);
function setView(i: number): void {
  viewIndex = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length;
  const v = VIEWS[viewIndex]!;
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(...v.target);
}
setView(viewIndex);

let spin = params.get('spin') === '1';
let wire = false;

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
let paused = params.get('still') === '1';
function frame(now: number): void {
  if (paused) {
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (spin) car.rotation.y += dt * 0.35;
  renderOnce(dt);
  quality.frame(dt);
  if (!hud.hidden)
    hud.textContent = `CRUMPLE body  [V] view ${VIEWS[viewIndex]!.name}  [T] spin  [W] wire\nLOD${lod}  ${def.panels.length} panels  ${tris} tris  build ${(t1 - t0).toFixed(0)} ms + tess ${(t2 - t1).toFixed(0)} ms  mats ${mats ? 'A3' : 'plain'}  wheels ${wheelsKind}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  const lvl = ({ '1': 'low', '2': 'medium', '3': 'high', '4': 'ultra' } as Record<string, QualityLevel>)[k];
  if (lvl) quality.setLevel(lvl);
  else if (k === 'v') setView(viewIndex + (e.shiftKey ? -1 : 1));
  else if (k === 't') spin = !spin;
  else if (k === 'h') hud.hidden = !hud.hidden;
  else if (k === 'w') {
    wire = !wire;
    for (const m of meshes) (m.material as MeshStandardMaterial).wireframe = wire;
  } else if (k === 'l' && mats) mats.setLights({ head: true, highBeam: false, brake: 1, reverse: false, indicatorL: true, indicatorR: false, fog: false });
});

const hooks = {
  ready: false,
  get texturesReady() {
    return texturesReady;
  },
  views: VIEWS.map((v) => v.name),
  setView(name: string | number) {
    setView(typeof name === 'number' ? name : VIEWS.findIndex((v) => v.name === name));
  },
  setCamera(pos: [number, number, number], target: [number, number, number], fov = 30) {
    camera.position.set(...pos);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.lookAt(...target);
  },
  setRotation(rad: number) {
    car.rotation.y = rad;
  },
  setWire(on: boolean) {
    wire = on;
    for (const m of meshes) (m.material as MeshStandardMaterial).wireframe = on;
  },
  setCastShadow(ids: string[], on: boolean) {
    for (const m of meshes) if (ids.includes(m.name)) m.castShadow = on;
  },
  debug: { meshes, scene, camera, post, lighting },
  setVisible(ids: string[], on: boolean) {
    for (const m of meshes) if (ids.includes(m.name)) m.visible = on;
  },
  setLights(on: boolean) {
    mats?.setLights({ head: on, highBeam: false, brake: on ? 1 : 0, reverse: false, indicatorL: on, indicatorR: false, fog: false });
  },
  pause(p: boolean) {
    paused = p;
  },
  renderFrames(n = 1) {
    for (let i = 0; i < n; i++) renderOnce(1 / 60);
  },
  info() {
    return { panels: def.panels.length, tris, buildMs: t1 - t0, tessMs: t2 - t1, mats: mats ? 'A3' : 'plain', wheels: wheelsKind, perPanel: geoms.map((g) => [g.panelId, g.index.length / 3]) };
  },
};
(window as unknown as { __body: typeof hooks }).__body = hooks;
void DoubleSide;
renderOnce(1 / 60);
hooks.ready = true;
