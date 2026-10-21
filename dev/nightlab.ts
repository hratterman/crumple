/**
 * DEV ONLY — night-lighting lab (not part of the production build).
 * Open /crumple/dev/nightlab.html: a ground plane under the real lighting
 * stack + post, one streetlight in the clustered light grid, ?time=hours.
 * window.__lab: sample() → mean luma of the centre, setGain(x), render().
 */
import { Mesh, MeshStandardMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGLRenderer } from 'three';

import { createLightingStack } from '../src/render/lighting';
import { ENV_UNIFORMS } from '../src/render/lighting/envPatch';
import { createNightLights } from '../src/render/lighting/nightLights';
import { patchMaterial } from '../src/render/material';
import { createPostStack, postDebug } from '../src/render/post';
import { QUALITY_PRESETS, type RenderContext, type WorldFrame } from '../src/render/types';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = true;
const scene = new Scene();
const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 3000);
const ctx: RenderContext = { renderer, scene, camera, quality: QUALITY_PRESETS.high, width: innerWidth, height: innerHeight, sampler: null };
renderer.setSize(ctx.width, ctx.height, false);
const lighting = await createLightingStack(ctx, { time: Number(params.get('time') ?? 23) });
const night = createNightLights(ctx.quality);
scene.add(night.object);
ENV_UNIFORMS.crumpleLightGrid.value = night.grid.texture;
night.addStaticLights([{ pos: [0, 7, 0], dir: [0, -1, 0], color: [1, 0.82, 0.6], intensity: 34, range: 30, outer: 1.22, inner: 0.62 }]);
const post = createPostStack(ctx);
const mat = patchMaterial(new MeshStandardMaterial({ color: 0x777777, roughness: 0.9 }), { csm: lighting.csm, env: { wet: params.has('wet') ? 'ground' : 'generic' } });
const ground = new Mesh(new PlaneGeometry(200, 200).rotateX(-Math.PI / 2), mat.color);
ground.receiveShadow = true;
scene.add(ground);
camera.position.set(0, 9, 18);
camera.lookAt(0, 0, 0);
const frame: WorldFrame = { dtS: 1 / 60, time: 0, simTime: 0, timeScale: 1, camera, nodes: new Float32Array(0), interpolated: false, objects: [], tick: 0 };
const off = { on: false, high: false, brake: 0, reverse: false };
let gainOverride: number | null = null;
const render = (): void => {
  lighting.update(camera);
  const gain = gainOverride ?? lighting.env?.darkness ?? 1;
  night.update(frame, { pose: null, state: off }, [], 0, gain);
  ENV_UNIFORMS.crumpleGridOrigin.value.copy(night.grid.origin);
  ENV_UNIFORMS.crumpleLightGain.value = gain;
  if (params.has('nogrid')) ENV_UNIFORMS.crumpleLightGrid.value = null;
  if (params.has('nocloud')) ENV_UNIFORMS.crumpleCloudShadow.value = null;
  if (params.has('nospot')) for (const sp of night.headlights.spots) sp.castShadow = false;
  if (params.has('nopost')) renderer.render(scene, camera);
  else post.render(1 / 60);
};
const lab = {
  render,
  setGain(g: number | null) {
    gainOverride = g;
  },
  sample(): number {
    render();
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!;
  },
  src() {
    const gl = renderer.getContext();
    return (renderer.info.programs ?? []).map((p) => {
      const fs = gl.getAttachedShaders(p.program)!.map((x) => gl.getShaderSource(x) ?? '').find((t) => t.includes('pc_fragColor')) ?? '';
      return { name: p.name, env: fs.includes('CRUMPLE_ENV'), lights: fs.includes('#define CRUMPLE_LIGHTS'), loop: fs.includes('clIds'), keyvis: fs.includes('crumpleKeyVis'), dbg: fs.includes('dl.w / 30.0'), len: fs.length };
    });
  },
  info() {
    const a = postDebug(post).autoExposure;
    return {
      lights: night.grid.count,
      origin: night.grid.origin.toArray(),
      gain: ENV_UNIFORMS.crumpleLightGain.value,
      exposure: [a.value, a.target, a.log2Lum, a.reads],
      sh0: ENV_UNIFORMS.crumpleHazeSH.value[0]!.toArray(),
      glow: ENV_UNIFORMS.crumpleHazeGlow.value.toArray(),
      fog: (scene.fog as { density?: number } | null)?.density,
      key: [lighting.sun.intensity, lighting.sun.color.toArray()],
    };
  },
};
(window as unknown as { __lab: typeof lab }).__lab = lab;
render();
