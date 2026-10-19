/**
 * DEV ONLY — A4 damage visuals preview on the synthetic flexbody cube (no
 * worker: node positions, broken flags and impact events are scripted).
 * Open /crumple/dev/damage.html. Keys: 0–5 stage · H HUD.
 *   0 pristine · 1 dent (plastic strain) · 2 + scrapes · 3 + cracked pane
 *   4 + lid torn ('follow' detach) · 5 + pane shattered (shards)
 * URL: ?stage=<n> ?view=<n>. window.__damage exposes hooks for screenshots.
 */
import {
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import { createQualityControllerWith } from '../src/app/quality';
import { createLightingStack } from '../src/render/lighting';
import { patchMaterial } from '../src/render/material';
import { createPostStack } from '../src/render/post';
import { QUALITY_PRESETS } from '../src/render/types';
import type { RenderContext } from '../src/render/types';
import { bindPanels } from '../src/render/vehicle/binder';
import { createVehicleDamage } from '../src/render/vehicle/damage';
import { createFlexSkin } from '../src/render/vehicle/flexskin';
import { createDamageFx } from '../src/render/vehicle/shatter';
import { syntheticCubeSubject } from '../src/render/vehicle/synthetic';
import type {
  MaterialSlot,
  PanelDef,
  PanelGeometry,
  VehicleFrameInput,
  VehicleMaterialSet,
  VehicleVisualDef,
} from '../src/render/vehicle/types';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: false, stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
const scene = new Scene();
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 2000);
const ctx: RenderContext = {
  renderer,
  scene,
  camera,
  quality: QUALITY_PRESETS.high,
  width: innerWidth,
  height: innerHeight,
  sampler: null,
};
renderer.setSize(ctx.width, ctx.height, false);
const lighting = await createLightingStack(ctx);
const post = createPostStack(ctx);
const quality = createQualityControllerWith(ctx, { lighting, post }, { storage: null, initial: 'high' });

// ground
const groundMat = patchMaterial(new MeshStandardMaterial({ color: 0x77736b, roughness: 0.92 }), { csm: lighting.csm }).color;
const ground = new Mesh(new PlaneGeometry(400, 400), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------- subject: synthetic cube + a glass pane on the +z face
const subject = syntheticCubeSubject(40);
const paneGeom = ((): PanelGeometry => {
  const nx = 24;
  const ny = 16;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = -0.5 + i / nx;
      const y = -0.25 + (0.7 * j) / ny;
      pos.push(x, y, 0.79);
      nrm.push(0, 0, 1);
      uv.push(x, y);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1);
    }
  }
  return {
    panelId: 'pane',
    position: Float32Array.from(pos),
    normal: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    tangent: null,
    index: Uint32Array.from(idx),
    damageWeight: null,
  };
})();
const paneDef: PanelDef = {
  id: 'pane',
  kind: 'glass',
  material: 'glass',
  surface: { type: 'mesh', position: Array.from(paneGeom.position), index: Array.from(paneGeom.index) },
  bind: ['n*_*_3'],
  detach: null,
  glass: {
    laminated: params.get('laminated') === '1',
    beams: { between: [['n*_*_3'], ['n*_*_3']] },
    crackStrain: 0.05,
    shatterStrain: 0.3,
    crackImpulse: 60,
    shatterImpulse: 2500,
    shatterBrokenFraction: 0.6,
  },
};
const def: VehicleVisualDef = { ...subject.def, panels: [...subject.def.panels, paneDef] };
const geoms = [...subject.geoms, paneGeom];
const binding = bindPanels(subject.compiled, def, geoms);

const paint = new MeshPhysicalMaterial({
  color: 0xb3121b,
  metalness: 0.55,
  roughness: 0.32,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
});
const glass = new MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.03,
  transmission: 1,
  thickness: 0.005,
  ior: 1.5,
});
const trim = new MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
const materials: VehicleMaterialSet = {
  base: (slot: MaterialSlot) => (slot === 'paint' ? paint : slot === 'glass' ? glass : trim),
  setPaint: () => {},
  setLights: () => {},
  dispose: () => {},
};
const damage = createVehicleDamage(subject.compiled, binding, def);
const skin = createFlexSkin(binding, { materials, damage, lighting, patchMaterial, anchorNode: subject.compiled.frameNodes[0]! });
scene.add(skin.object);
const fx = createDamageFx({ binding, def, damage, groundAt: () => 0 });
scene.add(fx.object);

// ---------------------------------------------------------------- scripted "sim"
const rig = subject.compiled.rig;
const N = rig.nodeCount;
const LIFT = 0.8;
const frame: VehicleFrameInput = {
  nodes: new Float32Array(N * 3),
  nodeOffset: 0,
  tick: 0,
  broken: new Uint8Array(rig.beamCount),
  repairEpoch: 0,
  telemetry: null,
  dtS: 1 / 60,
};
let stage = 0;

function pose(s: number): void {
  for (let i = 0; i < N; i++) {
    let x = rig.nodePos[i * 3]!;
    let y = rig.nodePos[i * 3 + 1]!;
    let z = rig.nodePos[i * 3 + 2]!;
    if (s >= 1) {
      // crushed front-top-right corner
      const dx = x - 0.75;
      const dy = y - 0.75;
      const dz = z - 0.75;
      const d = Math.hypot(dx, dy, dz);
      const w = Math.max(0, 1 - d / 1.3) ** 2;
      z -= 0.42 * w;
      y -= 0.16 * w;
      x -= 0.1 * w;
    }
    if (s >= 4 && y > 0.7) {
      // lid torn loose: lifted and twisted
      y += 0.25 + 0.2 * (x + 0.75);
      z -= 0.12;
    }
    frame.nodes[i * 3] = x;
    frame.nodes[i * 3 + 1] = y + LIFT;
    frame.nodes[i * 3 + 2] = z;
  }
}

function impact(x: number, y: number, z: number, impulse: number): void {
  damage.onImpact({ objectId: 1, materialId: 0, px: x, py: y + LIFT, pz: z, nx: 0, ny: 0, nz: 1, impulse });
}

function tick(n = 1): void {
  for (let k = 0; k < n; k++) {
    frame.tick += 16;
    damage.update(frame, skin);
    skin.update(frame);
  }
}

function setStage(s: number): void {
  frame.repairEpoch++;
  frame.broken.fill(0);
  stage = 0;
  pose(0);
  tick(2);
  for (let k = 1; k <= s; k++) {
    stage = k;
    pose(k);
    if (k === 2) {
      // a scrape along the front and right face
      for (let t = 0; t <= 12; t++) impact(-0.6 + t * 0.1, -0.35 + 0.02 * t, 0.62, 120);
      for (let t = 0; t <= 10; t++) impact(0.7, -0.5 + t * 0.03, 0.6 - t * 0.12, 90);
    }
    if (k === 3) impact(-0.15, 0.15, 0.79, 260);
    if (k === 4) {
      const lid = binding.panels.find((p) => p.panelId === 'lid')!;
      for (const b of lid.detach!.attachBeams) frame.broken[b] = 1;
    }
    if (k === 5) impact(0.2, 0.05, 0.79, 4000);
    tick(5);
  }
  fx.update(0);
}

// ---------------------------------------------------------------- camera / loop
const VIEWS: [number, number, number, number, number, number][] = [
  [2.6, 1.9, 3.4, 0, 0.75, 0.2],
  [0.6, 1.35, 2.3, 0, 0.9, 0.6],
  [3.6, 2.6, 1.0, 0, 0.8, 0],
];
function view(i: number): void {
  const v = VIEWS[i % VIEWS.length]!;
  camera.position.set(v[0], v[1], v[2]);
  camera.lookAt(v[3], v[4], v[5]);
}
view(Number(params.get('view') ?? 0));
setStage(Number(params.get('stage') ?? 0));

let last = performance.now();
let paused = false;
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) {
    tick(1);
    fx.update(dt);
  }
  lighting.update(camera);
  quality.frame(dt);
  post.render(dt);
  hud.textContent = `stage ${stage}  shards ${fx.glass.live}  debris ${fx.debris.live}\n${binding.panels
    .map((p, i) => {
      const s = damage.panelState(i);
      return `${p.panelId}: det ${s.detached} crack ${s.crack.toFixed(2)} shat ${s.shattered}`;
    })
    .join('\n')}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key >= '0' && e.key <= '5') setStage(Number(e.key));
  if (e.key === 'h') hud.hidden = !hud.hidden;
  if (e.key === 'v') view(Math.floor(Math.random() * 3));
});
addEventListener('resize', () => {
  ctx.width = innerWidth;
  ctx.height = innerHeight;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight);
});

(window as unknown as { __damage: unknown }).__damage = {
  setStage,
  view,
  advance(seconds: number): void {
    const steps = Math.round(seconds * 60);
    for (let k = 0; k < steps; k++) fx.update(1 / 60);
  },
  pause(p: boolean): void {
    paused = p;
  },
  ready: true,
  damage,
};
