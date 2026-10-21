/**
 * Water renderer (P5, U5). CONTRACT: ./types.ts (docs/CONTRACTS.md "P5
 * contracts"). Per WaterBody: one flat mesh hugging the shoreline
 * (surface.ts), the patched water material (material.ts) fed by a terrain
 * depth / shore-distance texture (world/water.ts waterField), procedural
 * wave + noise textures (waves.ts), object ripples/contacts (ripples.ts)
 * and, on 'planar' presets, a mirrored-camera reflection (reflection.ts).
 *
 * REFRACTION: the water is transparent (drawn after every opaque object);
 * its onBeforeRender copies the bound colour buffer (the composer's
 * HalfFloat scene target) into a FramebufferTexture once per render call,
 * so the shader can show the lake bed distorted by the waves and attenuated
 * by depth without a second scene render.
 *
 * UNDERWATER: when the camera dips below the surface over the lake, a
 * full-screen tint quad (after the water) stands in for underwater fog.
 */
import {
  Box3,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  FramebufferTexture,
  Group,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';

import type { WaterBody } from '../../world/types';
import { waterField } from '../../world/water';
import type { WaterField } from '../../world/water';
import { LAYER_NO_REFLECTION } from '../types';
import type { QualityPreset, WorldFrame } from '../types';
import { createWaterMaterial, createWaterUniforms, setWaterLite } from './material';
import type { WaterUniforms } from './material';
import { buildReflectionProxy } from './proxy';
import { PlanarReflection } from './reflection';
import { WaterInteraction } from './ripples';
import { buildSurfaceGeometry, selectSurfaceCells } from './surface';
import { WATER_REFLECTION_MAX_DIST_M, WATER_RENDER_ORDER } from './types';
import type { CreateWaterRenderer, WaterRenderer, WaterStats } from './types';
import { buildNoiseTexture, buildWaveTexture, WAVE_SPECTRUM_A, WAVE_SPECTRUM_B } from './waves';

/** Prevailing wind over the lake (unit, world XZ): from the west-south-west. Waves and gusts align with it. */
export const WATER_WIND: readonly [number, number] = [0.87, -0.49];
/** Overall wave slope strength (1 = the generated spectra as-is). */
export const WATER_WAVE_STRENGTH = 0.16;

interface BodyDraw {
  body: WaterBody;
  field: WaterField;
  mesh: Mesh;
  uniforms: WaterUniforms;
  box: Box3;
  reflection: PlanarReflection | null;
  fieldTexture: DataTexture;
}

/** RG16F: R = depth (level − terrain, m), G = signed shore distance (m). */
function fieldTexture(f: WaterField): DataTexture {
  const n = f.cols * f.rows;
  const data = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    data[i * 2] = DataUtils.toHalfFloat(Math.max(-8, Math.min(60, f.depth[i]!)));
    data[i * 2 + 1] = DataUtils.toHalfFloat(Math.max(-40, Math.min(80, f.shoreDist[i]!)));
  }
  const t = new DataTexture(data, f.cols, f.rows, RGFormat, HalfFloatType);
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.name = 'crumple.water.field';
  t.needsUpdate = true;
  return t;
}

function waveTextures(maxAniso: number): { wave: DataTexture; noise: DataTexture; scaleA: number; scaleB: number } {
  const wind = Math.atan2(WATER_WIND[1], WATER_WIND[0]);
  const w = buildWaveTexture(256, 0x5eed_a7e2, { ...WAVE_SPECTRUM_A, windAngle: wind }, { ...WAVE_SPECTRUM_B, windAngle: wind });
  const wave = new DataTexture(w.data, w.size, w.size, RGBAFormat, UnsignedByteType);
  wave.wrapS = wave.wrapT = RepeatWrapping;
  wave.minFilter = LinearMipmapLinearFilter;
  wave.magFilter = LinearFilter;
  wave.generateMipmaps = true;
  wave.anisotropy = Math.min(8, maxAniso);
  wave.name = 'crumple.water.waves';
  wave.needsUpdate = true;
  const nd = buildNoiseTexture(128);
  const noise = new DataTexture(nd, 128, 128, RedFormat, UnsignedByteType);
  noise.wrapS = noise.wrapT = RepeatWrapping;
  noise.minFilter = LinearMipmapLinearFilter;
  noise.magFilter = LinearFilter;
  noise.generateMipmaps = true;
  noise.name = 'crumple.water.noise';
  noise.needsUpdate = true;
  return { wave, noise, scaleA: w.scaleA, scaleB: w.scaleB };
}

/** Full-screen underwater tint (drawn after the water while the camera is below the surface). */
function underwaterOverlay(): Mesh<PlaneGeometry, ShaderMaterial> {
  const m = new ShaderMaterial({
    name: 'crumple.water.underwater',
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uColor: { value: new Color() }, uAlpha: { value: 0.82 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      varying vec2 vUv;
      void main() {
        // brighter toward the surface (top of the screen when looking level)
        gl_FragColor = vec4(uColor * mix(0.6, 1.3, vUv.y), uAlpha * mix(1.0, 0.8, vUv.y));
      }`,
  });
  const mesh = new Mesh(new PlaneGeometry(1, 1), m);
  mesh.name = 'crumple.water.underwater';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6;
  mesh.visible = false;
  mesh.layers.set(LAYER_NO_REFLECTION);
  return mesh;
}

export const createWaterRenderer: CreateWaterRenderer = (ctx, bodies, terrain, opts): WaterRenderer => {
  const { renderer, scene } = ctx;
  const object = new Group();
  object.name = 'water';
  const stats: WaterStats = { bodies: bodies.length, reflectionRendered: false, reflectionDraws: 0 };
  let quality = ctx.quality;

  const tex = waveTextures(renderer.capabilities.getMaxAnisotropy());
  const interaction = new WaterInteraction(bodies);
  const draws: BodyDraw[] = [];

  // Refraction source: one copy of the colour buffer per render call, shared by every body.
  let refraction: FramebufferTexture | null = null;
  let copiedFrame = -1;
  const rtSize = new Vector2();
  const copyFramebuffer = (r: WebGLRenderer): void => {
    const frame = r.info.render.frame;
    if (frame === copiedFrame) return;
    copiedFrame = frame;
    const rt = r.getRenderTarget();
    if (rt) rtSize.set(rt.width, rt.height);
    else r.getDrawingBufferSize(rtSize);
    const type = rt ? rt.texture.type : UnsignedByteType;
    const w = Math.max(1, Math.floor(rtSize.x));
    const h = Math.max(1, Math.floor(rtSize.y));
    const img = refraction?.image as { width: number; height: number } | undefined;
    if (!refraction || img!.width !== w || img!.height !== h || refraction.type !== type) {
      refraction?.dispose();
      refraction = new FramebufferTexture(w, h);
      refraction.type = type;
      refraction.minFilter = LinearFilter;
      refraction.magFilter = LinearFilter;
      refraction.name = 'crumple.water.refraction';
    }
    r.copyFramebufferToTexture(refraction);
    for (const d of draws) {
      d.uniforms.tRefraction.value = refraction;
      d.uniforms.uScreenInv.value.set(1 / w, 1 / h);
      d.uniforms.uRefraction.value = 1;
    }
  };

  for (const body of bodies) {
    const field = waterField(terrain, body);
    const cells = selectSurfaceCells(field);
    if (cells.kept === 0) continue;
    const geometry = buildSurfaceGeometry(cells, body.level);
    const uniforms = createWaterUniforms(body.optics, body.level);
    uniforms.tWave.value = tex.wave;
    uniforms.tNoise.value = tex.noise;
    uniforms.uWaveScale.value.set(tex.scaleA, tex.scaleB, 0, WATER_WAVE_STRENGTH);
    uniforms.uWind.value.set(WATER_WIND[0], WATER_WIND[1]);
    const ft = fieldTexture(field);
    uniforms.tField.value = ft;
    uniforms.uFieldGrid.value.set(field.originX, field.originZ, 1 / (field.cols * field.spacing), 1 / (field.rows * field.spacing));
    uniforms.uFieldHalf.value.set(0.5 / field.cols, 0.5 / field.rows);
    uniforms.uRipples.value = interaction.ripples;
    uniforms.uContacts.value = interaction.contacts;
    const material = createWaterMaterial(uniforms);
    material.userData.uniforms = uniforms; // console tuning
    const set = opts.patchMaterial(material, { csm: opts.lighting.csm, env: { wet: 'none' } });
    const mesh = new Mesh(geometry, set.color);
    mesh.name = `water:${body.id}`;
    mesh.renderOrder = WATER_RENDER_ORDER;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER_NO_REFLECTION);
    mesh.matrixAutoUpdate = false;
    mesh.onBeforeRender = (r) => copyFramebuffer(r);
    object.add(mesh);
    const box = new Box3(new Vector3(body.minX, body.level - 1, body.minZ), new Vector3(body.maxX, body.level + 1, body.maxZ));
    draws.push({ body, field, mesh, uniforms, box, reflection: null, fieldTexture: ft });
  }

  const overlay = underwaterOverlay();
  object.add(overlay);

  // Reflection-only coarse terrain (replaces the terrain chunks + road ribbons in the planar pass).
  const proxy = draws.length ? buildReflectionProxy(terrain, bodies) : null;
  if (proxy) {
    proxy.material = opts.patchMaterial(proxy.material, { csm: opts.lighting.csm, env: { wet: 'none' } }).color;
    object.add(proxy);
  }
  const hideInReflection: Object3D[] = [];
  /** The pass samples shadow maps it does not render: wait until the main frame has created them. */
  const shadowsReady = (): boolean => {
    const csm = opts.lighting.csm;
    if (csm) return csm.lights.every((l) => !!l.shadow.map);
    return !opts.lighting.sun.castShadow || !!opts.lighting.sun.shadow.map;
  };

  let sky: Object3D | null = null;
  const camPos = new Vector3();

  /** The body whose flooded region holds the camera below its surface, or null. */
  const underwaterAt = (p: Vector3): BodyDraw | null => {
    for (const d of draws) {
      const b = d.body;
      if (p.y >= b.level - 0.03 || p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ) continue;
      const f = d.field;
      const c = Math.round((p.x - f.originX) / f.spacing);
      const r = Math.round((p.z - f.originZ) / f.spacing);
      if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) continue;
      if (f.mask[r * f.cols + c]) return d;
    }
    return null;
  };

  const applyQuality = (q: QualityPreset): void => {
    quality = q;
    for (const d of draws) setWaterLite(d.mesh.material as MeshStandardMaterial, q.level === 'low');
    if (q.waterReflection !== 'planar') {
      for (const d of draws) {
        d.reflection?.dispose();
        d.reflection = null;
        d.uniforms.uPlanar.value = 0;
      }
    }
  };
  applyQuality(quality);

  const distToRect = (b: WaterBody, x: number, z: number): number => {
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    return Math.sqrt(dx * dx + dz * dz);
  };

  const api: WaterRenderer = {
    object,
    stats,
    update(frame: WorldFrame) {
      const camera = frame.camera;
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      interaction.update(frame);
      stats.reflectionRendered = false;
      stats.reflectionDraws = 0;
      if (!sky) sky = scene.getObjectByName('crumple.sky') ?? null;
      if (proxy && hideInReflection.length === 0) {
        for (const c of scene.children) if (c.name === 'terrain' || c.name === 'roads') hideInReflection.push(c);
      }
      for (const d of draws) {
        const u = d.uniforms;
        u.uTime.value = frame.time;
        let planar = false;
        if (
          quality.waterReflection === 'planar' &&
          quality.waterReflectionScale > 0 &&
          shadowsReady() &&
          distToRect(d.body, camPos.x, camPos.z) <= WATER_REFLECTION_MAX_DIST_M
        ) {
          d.reflection ??= new PlanarReflection();
          if (d.reflection.visible(camera, d.box)) {
            // the water itself is on LAYER_NO_REFLECTION: the layer-0 reflection camera never draws it
            planar = d.reflection.render(renderer, scene, camera, d.body.level, quality.waterReflectionScale, sky, hideInReflection);
            if (planar) {
              stats.reflectionRendered = true;
              stats.reflectionDraws += d.reflection.draws;
              u.tReflection.value = d.reflection.target.texture;
              u.uReflMatrix.value = d.reflection.textureMatrix;
            }
          }
        }
        u.uPlanar.value = planar ? 1 : 0;
      }
      const under = underwaterAt(camPos);
      overlay.visible = !!under;
      if (under) {
        const c = (overlay.material.uniforms.uColor!.value as Color).setHex(under.body.optics.deepColor);
        c.multiplyScalar(0.9 * Math.exp(-0.08 * (under.body.level - camPos.y)));
      }
    },
    setQuality(q: QualityPreset) {
      applyQuality(q);
    },
    dispose() {
      for (const d of draws) {
        d.mesh.geometry.dispose();
        (d.mesh.material as ShaderMaterial).dispose();
        d.fieldTexture.dispose();
        d.reflection?.dispose();
      }
      overlay.geometry.dispose();
      overlay.material.dispose();
      tex.wave.dispose();
      tex.noise.dispose();
      proxy?.geometry.dispose();
      proxy?.material.dispose();
      refraction?.dispose();
      object.clear();
    },
  };
  // dev/console handle (not part of the contract)
  (api as unknown as { debug: unknown }).debug = { draws, interaction, tex };
  return api;
};
