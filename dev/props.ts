/**
 * DEV ONLY — prop visuals harness (not part of the production build).
 * Open /crumple/dev/props.html.
 *
 * Every catalog prop through the real instanced renderer (patchMaterial →
 * CSM + flexI1), posed procedurally (no physics worker): a pristine row and
 * a crushed row (?pose=rest|crush), ?view=row|<key> close-ups, ?q=quality.
 * window.__props exposes hooks for screenshots / the e2e compile check.
 */
import { Mesh, MeshStandardMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGLRenderer } from 'three';

import { MaterialId } from '../src/protocol/messages';
import { createLightingStack } from '../src/render/lighting';
import { patchMaterial } from '../src/render/material';
import { createPostStack } from '../src/render/post';
import { createPropRenderer } from '../src/render/props';
import { QUALITY_LEVELS, QUALITY_PRESETS, type QualityLevel, type RenderContext, type SimObjectSlice, type WorldFrame } from '../src/render/types';
import { compilePropRig, PROP_CATALOG } from '../src/sim/props/catalog';
import { PROP_KEYS, type PropInstance, type PropKey } from '../src/sim/props/types';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;

const scene = new Scene();
const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 3000);
const level = (QUALITY_LEVELS as readonly string[]).includes(params.get('q') ?? '') ? (params.get('q') as QualityLevel) : 'high';
const ctx: RenderContext = { renderer, scene, camera, quality: QUALITY_PRESETS[level], width: innerWidth, height: innerHeight, sampler: null };
renderer.setSize(ctx.width, ctx.height, false);
const lighting = await createLightingStack(ctx);
const post = createPostStack(ctx);

const groundMat = patchMaterial(new MeshStandardMaterial({ color: 0x9a958c, roughness: 0.92 }), { csm: lighting.csm });
const ground = new Mesh(new PlaneGeometry(400, 400).rotateX(-Math.PI / 2), groundMat.color);
ground.receiveShadow = true;
scene.add(ground);

// ------------------------------------------------------------ instances: pristine row (z = 0) + crushed row (z = 4)
const SPACING: Record<PropKey, number> = { cone: 1.2, barrel: 1.4, tire: 1.4, boxCardboard: 1.4, boxWood: 1.6, signPost: 2, lightPole: 3.4, concreteBlock: 2.2 };
const instances: PropInstance[] = [];
const ORIGIN = [40, 0, -20];
let x = ORIGIN[0]!;
const xs: Record<string, number> = {};
for (const [row, z] of [0, 4].entries()) {
  x = ORIGIN[0]!;
  for (const key of PROP_KEYS) {
    const def = PROP_CATALOG[key];
    const idx = instances.length;
    const yaw = row === 0 ? 0.35 : -0.5;
    const pos: [number, number, number] = [x, 0, ORIGIN[2]! + z];
    instances.push({
      index: idx,
      objectId: 4096 + idx,
      id: `${key}.${row}`,
      prop: key,
      transform: { pos, quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] },
      aabb: [pos[0] - 2, 0, pos[2] - 2, pos[0] + 2, 9, pos[2] + 2],
      surface: def.surface,
      material: def.material ?? MaterialId.concrete,
    });
    if (row === 0) xs[key] = x;
    x += SPACING[key];
  }
}
const props = createPropRenderer(ctx, instances, { lighting, patchMaterial });
scene.add(props.object);

// ------------------------------------------------------------ procedural node poses
const slices: SimObjectSlice[] = [];
let total = 0;
for (const p of instances) {
  const n = compilePropRig(p.prop).nodeCount;
  slices.push({ objectId: p.objectId, flags: 0, nodeOffset: total, nodeCount: n, beamOffset: 0, beamCount: 0 });
  total += n;
}
const nodes = new Float32Array(total * 3);

function crush(key: PropKey, px: number, py: number, pz: number, i: number): [number, number, number] {
  const rig = compilePropRig(key);
  let maxY = 0;
  for (let k = 0; k < rig.nodeCount; k++) maxY = Math.max(maxY, rig.nodePos[3 * k + 1]!);
  // a hit from the front-left: nodes near (−x, mid height, −z) pushed in; tall props lean / bend
  if (key === 'signPost' || key === 'lightPole') {
    const t = py / maxY;
    if (rig.nodeIds[i]!.startsWith('anchor')) return [px, py, pz];
    return [px + 0.9 * t * t * maxY * 0.12, py - 0.05 * t, pz + 0.3 * t * t];
  }
  const cx = -0.4, cy = maxY * 0.55, cz = -0.4;
  const d = Math.hypot(px - cx, (py - cy) * 0.8, pz - cz);
  const w = Math.max(0, 1 - d / (key === 'concreteBlock' ? 0.5 : 0.75));
  const s = w * w * (3 - 2 * w);
  const amt = key === 'concreteBlock' ? 0.03 : key === 'boxWood' ? 0.12 : 0.2;
  return [px + amt * s, py - amt * 0.5 * s - (key === 'boxCardboard' ? 0.12 * (py / maxY) ** 2 : 0), pz + amt * 0.8 * s];
}

function pose(name: string): void {
  instances.forEach((p, j) => {
    const rig = compilePropRig(p.prop);
    const q = p.transform.quat;
    const c = 1 - 2 * q[1] * q[1];
    const s = 2 * q[1] * q[3];
    const sl = slices[j]!;
    const crushed = name === 'crush' && j >= PROP_KEYS.length;
    for (let i = 0; i < rig.nodeCount; i++) {
      let lx = rig.nodePos[3 * i]!, ly = rig.nodePos[3 * i + 1]!, lz = rig.nodePos[3 * i + 2]!;
      if (crushed) [lx, ly, lz] = crush(p.prop, lx, ly, lz, i);
      const o = 3 * (sl.nodeOffset + i);
      nodes[o] = c * lx + s * lz + p.transform.pos[0];
      nodes[o + 1] = ly + p.transform.pos[1];
      nodes[o + 2] = -s * lx + c * lz + p.transform.pos[2];
    }
  });
}
let poseName = params.get('pose') ?? 'crush';
pose(poseName);

let tick = 1;
const frame: WorldFrame = {
  dtS: 1 / 60,
  time: 0,
  simTime: 0,
  timeScale: 1,
  camera,
  nodes,
  interpolated: true,
  objects: slices,
  tick,
};

// ------------------------------------------------------------ views
const VIEWS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  row: { pos: [ORIGIN[0]! + 7, 3.2, ORIGIN[2]! + 13], look: [ORIGIN[0]! + 7, 0.8, ORIGIN[2]! + 1.5] },
  front: { pos: [ORIGIN[0]! + 6, 1.6, ORIGIN[2]! - 5.5], look: [ORIGIN[0]! + 6, 0.6, ORIGIN[2]!] },
};
for (const key of PROP_KEYS) {
  const kx = xs[key]!;
  const big = key === 'lightPole' ? 4 : key === 'signPost' ? 1.4 : key === 'concreteBlock' || key === 'boxWood' ? 0.7 : 0.35;
  const look: [number, number, number] = [kx, 0.3 + big * 0.55, ORIGIN[2]!];
  // pristine row seen from the front (−Z) at three-quarters; crushed row from behind (+Z)
  VIEWS[key] = { pos: [kx + 0.9 + big * 0.9, 0.9 + big * 1.0, ORIGIN[2]! - 1.6 - big * 2.6], look };
  if (key === 'lightPole') VIEWS[key] = { pos: [kx + 3.5, 6.2, ORIGIN[2]! - 6.5], look: [kx, 6.6, ORIGIN[2]! - 0.9] };
  VIEWS[`${key}Crush`] = { pos: [kx - 0.9 - big * 0.9, 0.9 + big * 1.0, ORIGIN[2]! + 4 + 1.6 + big * 2.6], look: [kx + (SPACING[key] ?? 0) * 0, look[1], ORIGIN[2]! + 4] };
}
function setView(name: string): void {
  const v = VIEWS[name] ?? VIEWS.row!;
  camera.position.set(...v.pos);
  camera.lookAt(...v.look);
  camera.updateMatrixWorld();
}
setView(params.get('view') ?? 'row');

const errors: string[] = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  errors.push(`${gl.getProgramInfoLog(program) ?? ''} ${gl.getShaderInfoLog(vs) ?? ''} ${gl.getShaderInfoLog(fs) ?? ''}`);
};
function draw(): void {
  camera.updateMatrixWorld();
  frame.tick = ++tick;
  props.update(frame);
  lighting.update(camera);
  post.render(1 / 60);
}
draw();
for (const sl of slices) sl.flags = 1; // asleep from now on (texels kept)

const hooks = {
  ready: true,
  get errors(): string[] {
    return errors;
  },
  stats: props.stats,
  setView(name: string): void {
    setView(name);
    draw();
  },
  setPose(name: string): void {
    poseName = name;
    pose(name);
    for (const sl of slices) sl.flags = 0;
    draw();
    for (const sl of slices) sl.flags = 1;
  },
  draw,
  views: Object.keys(VIEWS),
};
(window as unknown as { __props: typeof hooks }).__props = hooks;

if (params.get('loop') !== '0') {
  const loop = (): void => {
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
