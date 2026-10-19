/**
 * DEV ONLY — flexbody skin harness (not part of the production build).
 * Open /crumple/dev/skin.html.
 *
 * The synthetic subject (render/vehicle/synthetic: rounded box shell on the
 * soft-cube rig) skinned through the real patchMaterial (CSM → flex2),
 * posed procedurally (no physics worker): ?pose=rest|roll|dent|explode.
 * window.__skin exposes hooks for the e2e (GPU ⇄ CPU parity readback of the
 * exact flex2 GLSL, program errors) and screenshots.
 */
import {
  BufferAttribute,
  BufferGeometry,
  FloatType,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NoBlending,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

import { createLightingStack } from '../src/render/lighting';
import { patchMaterial } from '../src/render/material';
import { createPostStack } from '../src/render/post';
import { QUALITY_LEVELS, QUALITY_PRESETS } from '../src/render/types';
import type { QualityLevel, RenderContext } from '../src/render/types';
import { bindPanels, evalFlexFrame } from '../src/render/vehicle/binder';
import { createFlexSkin } from '../src/render/vehicle/flexskin';
import { syntheticCubeSubject } from '../src/render/vehicle/synthetic';
import type { VehicleFrameInput, VehicleMaterialSet } from '../src/render/vehicle/types';

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

// ------------------------------------------------------------ ground
const groundMat = patchMaterial(new MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9 }), { csm: lighting.csm });
const ground = new Mesh(new PlaneGeometry(200, 200).rotateX(-Math.PI / 2), groundMat.color);
ground.receiveShadow = true;
scene.add(ground);

// ------------------------------------------------------------ skinned subject
const subject = syntheticCubeSubject(params.has('cells') ? Number(params.get('cells')) : 26);
const t0 = performance.now();
const binding = bindPanels(subject.compiled, subject.def, subject.geoms);
const bindMs = performance.now() - t0;
const paint = new MeshPhysicalMaterial({ color: 0x8c0a12, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
const materials: VehicleMaterialSet = { base: () => paint, setPaint() {}, setLights() {}, dispose() {} };
const skin = createFlexSkin(binding, {
  materials,
  damage: null,
  lighting,
  patchMaterial,
  anchorNode: subject.compiled.frameNodes[0]!,
});
scene.add(skin.object);

const rig = subject.compiled.rig;
const nodes = new Float32Array(rig.nodeCount * 3);
const frame: VehicleFrameInput = { nodes, nodeOffset: 0, tick: 0, broken: new Uint8Array(0), repairEpoch: 0, telemetry: null, dtS: 0 };
const ORIGIN: [number, number, number] = [20, 0.82, -30];

/** Procedural node poses (world space). */
function pose(name: string): void {
  for (let i = 0; i < rig.nodeCount; i++) {
    let x = rig.nodePos[3 * i]!;
    let y = rig.nodePos[3 * i + 1]!;
    let z = rig.nodePos[3 * i + 2]!;
    if (name === 'roll') {
      // Body roll 9° about the forward axis, plus a little pitch.
      const a = 0.16;
      const b = 0.05;
      [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
      [y, z] = [y * Math.cos(b) - z * Math.sin(b), y * Math.sin(b) + z * Math.cos(b)];
    } else if (name === 'dent') {
      // Dropped on its front-left top corner: corner pushed in and down, the side panel bowed.
      const d = Math.max(0, 1 - Math.hypot(x + 0.75, y - 0.75, z + 0.75) / 1.3);
      const s2 = d * d * (3 - 2 * d);
      x += 0.32 * s2;
      y -= 0.38 * s2;
      z += 0.22 * s2;
      if (x > 0.5) x += 0.08 * Math.cos(1.9 * y) * Math.cos(1.9 * z);
    } else if (name === 'explode') {
      if (i === 21) {
        x += 30;
        y += 40;
      }
    }
    nodes[3 * i] = x + ORIGIN[0];
    nodes[3 * i + 1] = y + ORIGIN[1];
    nodes[3 * i + 2] = z + ORIGIN[2];
  }
  skin.update(frame);
}
let poseName = params.get('pose') ?? 'dent';
pose(poseName);

camera.position.set(ORIGIN[0] + 3.4, ORIGIN[1] + 1.7, ORIGIN[2] + 3.9);
camera.lookAt(ORIGIN[0], ORIGIN[1] - 0.2, ORIGIN[2]);

// ------------------------------------------------------------ GPU ⇄ CPU parity (exact flex2 GLSL, readback)
const W = 256;
function parity(panelIndex = 0): { maxPos: number; maxNrm: number; vertices: number; nan: number } {
  const p = binding.panels[panelIndex]!;
  const src = skin.meshes[panelIndex]!.geometry;
  const g = new BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  const H = Math.ceil(p.vertexCount / W);
  const mat = new ShaderMaterial({
    uniforms: { uMode: { value: 0 }, uSize: { value: [W, H] } },
    vertexShader: /* glsl */ `
      #include <common>
      uniform int uMode;
      uniform vec2 uSize;
      varying vec3 vOut;
      void main() {
        #include <beginnormal_vertex>
        #include <begin_vertex>
        vOut = uMode == 0 ? transformed : objectNormal;
        float id = float( gl_VertexID );
        vec2 px = vec2( mod( id, uSize.x ) + 0.5, floor( id / uSize.x ) + 0.5 ) / uSize;
        gl_Position = vec4( px * 2.0 - 1.0, 0.0, 1.0 );
        gl_PointSize = 1.0;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vOut;
      void main() { gl_FragColor = vec4( vOut, 1.0 ); }`,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  // The color target: it is the one that reconstructs frames (normals).
  mat.onBeforeCompile = (s, r) => skin.patch.apply(s, 'color', r);
  const pts = new Points(g, mat);
  pts.frustumCulled = false;
  const pscene = new Scene();
  pscene.add(pts);
  const rt = new WebGLRenderTarget(W, H, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const ortho = new OrthographicCamera();
  const read = (mode: number): Float32Array => {
    mat.uniforms.uMode!.value = mode;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(pscene, ortho);
    const buf = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    renderer.setRenderTarget(null);
    return buf;
  };
  const gpuPos = read(0);
  const gpuNrm = read(1);
  // CPU mirror on exactly the texture's (f32) skin-space nodes.
  const sn = new Float64Array(rig.nodeCount * 3);
  for (let i = 0; i < rig.nodeCount; i++) for (let k = 0; k < 3; k++) sn[3 * i + k] = skin.nodeData[4 * i + k]!;
  const out = new Float64Array(6);
  let maxPos = 0;
  let maxNrm = 0;
  let nan = 0;
  for (let v = 0; v < p.vertexCount; v++) {
    evalFlexFrame(p, v, sn, out, null);
    for (let k = 0; k < 3; k++) {
      const gp = gpuPos[4 * v + k]!;
      const gn = gpuNrm[4 * v + k]!;
      if (!Number.isFinite(gp) || !Number.isFinite(gn)) nan++;
      maxPos = Math.max(maxPos, Math.abs(gp - out[k]!));
      maxNrm = Math.max(maxNrm, Math.abs(gn - out[3 + k]!));
    }
  }
  rt.dispose();
  g.dispose();
  mat.dispose();
  return { maxPos, maxNrm, vertices: p.vertexCount, nan };
}

// ------------------------------------------------------------ hooks + loop
const errors: string[] = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  errors.push(`${gl.getProgramInfoLog(program) ?? ''} ${gl.getShaderInfoLog(vs) ?? ''} ${gl.getShaderInfoLog(fs) ?? ''}`);
};
function draw(): void {
  lighting.update(camera);
  post.render(1 / 60);
}
draw();

const hooks = {
  ready: true,
  bindMs,
  stats: binding.stats,
  get pose(): string {
    return poseName;
  },
  setPose(name: string): void {
    poseName = name;
    pose(name);
    draw();
  },
  parity,
  draw,
  get errors(): string[] {
    return errors;
  },
  /** Debug handles (not a contract). */
  debug: { skin, camera, lighting, scene },
  get programs(): number {
    return renderer.info.programs?.length ?? 0;
  },
};
(window as unknown as { __skin: typeof hooks }).__skin = hooks;

if (params.get('loop') !== '0') {
  let t = 0;
  const tick = (): void => {
    t += 1 / 60;
    if (poseName === 'wobble') {
      for (let i = 0; i < rig.nodeCount; i++) {
        const y = rig.nodePos[3 * i + 1]!;
        nodes[3 * i] = rig.nodePos[3 * i]! + ORIGIN[0] + 0.12 * Math.sin(t * 3) * (y + 0.75);
        nodes[3 * i + 1] = y + ORIGIN[1];
        nodes[3 * i + 2] = rig.nodePos[3 * i + 2]! + ORIGIN[2];
      }
      skin.update(frame);
    }
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
