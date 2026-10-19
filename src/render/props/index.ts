/**
 * Prop renderer (P5, U2). CONTRACT: ./types.ts ("INSTANCED FLEXBODY").
 *
 *   per PropKey     one binding (./visuals.ts: tessellate + bind to the catalog rig)
 *   per (key, slot) one InstancedBufferGeometry + Mesh (merged panels, flexFrameU.w = panel variant)
 *   all props       ONE node texture (block A: xyz = world − propsOrigin, w = flags;
 *                   block B: strain, scuff), propsOrigin = camera snapped to 64 m
 *   per frame       awake (and just-slept / re-placed) instances write their texels from
 *                   the interpolated snapshot; sleeping ones skip; per-instance culling by
 *                   the current node AABB → compacted `propInst` (node base, seed, wear) +
 *                   instanceCount; the texture uploads only when something was written.
 * Strain (block B .x) is derived per snapshot tick from rest-vs-current beam lengths of
 * awake props (plastic yield in the sim IS a lasting length change), with a two-tick
 * persistence filter against elastic transients; impacts add scuff (block B .y).
 */
import {
  BufferAttribute,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  FloatType,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  type Material,
  type MeshStandardMaterial,
} from 'three';

import { OBJECT_FLAG_SLEEPING } from '../../protocol/layout';
import { isPropObjectId } from '../../protocol/messages';
import type { PropInstance, PropKey } from '../../sim/props/types';
import type { QualityLevel, QualityPreset, RenderContext, WorldFrame } from '../types';
import { FLEX_TRIADS, NODE_TEX_FLAG_BROKEN, NODE_TEX_WIDTH, type BindingPanel } from '../vehicle/types';
import { createPropMaterials, type PropMaterialSet } from './materials';
import { createPropFlexPatch, type PropNodeUniforms } from './patch';
import {
  PROP_DRAW_BUDGET,
  PROP_SHADOW_CASCADES,
  type CreatePropRenderer,
  type PropMaterialSlot,
  type PropRenderer,
  type PropRendererOptions,
  type PropRendererStats,
} from './types';
import { bindPropVisual, type PropBinding } from './visuals';

const K = FLEX_TRIADS;

/** Instances farther than this from the camera are not drawn (m, by quality). */
export const PROP_CULL_DISTANCE: Readonly<Record<QualityLevel, number>> = { low: 160, medium: 260, high: 380, ultra: 520 };
/** Strain mapping: |L/L0 − 1| below the deadzone is elastic; full shading at `full`. */
export const PROP_STRAIN = { deadzone: 0.015, full: 0.12 } as const;
/** Impact scuff: radius (m) and the impulse (N·s) that fully scuffs the nearest node. */
export const PROP_SCUFF = { radius: 0.4, fullImpulse: 250 } as const;
/** Instances farther than this (m) draw the reduced LOD1 mesh (same nodes, same texels). */
export const PROP_LOD1_DISTANCE = 32;
/** A sleeping prop whose first node moved more than this (m) since its last write was re-placed (resetProps): rewrite + clear damage. */
const RESET_JUMP_M = 0.05;

// ------------------------------------------------------------ batches
interface SlotDraw {
  slot: PropMaterialSlot;
  geometry: InstancedBufferGeometry;
  mesh: Mesh;
  inst: InstancedBufferAttribute;
}

interface Batch {
  key: PropKey;
  pb: PropBinding;
  nodeCount: number;
  beamA: Uint32Array;
  beamB: Uint32Array;
  restLen: Float64Array;
  /** Per LOD (0 full, 1 reduced): one draw per material slot. */
  lods: SlotDraw[][];
  instances: Inst[];
  /** Max distance of the drawn surface outside the node AABB (m). */
  margin: number;
  /** Shadow reach added to the culling sphere (tall props throw long golden-hour shadows). */
  shadowReach: number;
}

interface Inst {
  objectId: number;
  data: PropInstance;
  batch: Batch;
  base: number;
  seed: number;
  wear: number;
  /** World AABB of the current nodes (min xyz, max xyz). */
  aabb: Float64Array;
  /** Written from the simulation at least once. */
  simWritten: boolean;
  wasAwake: boolean;
  /** Last written world position of node 0 (reset detection). */
  last: Float64Array;
  prevRaw: Float32Array;
  scuff: Float32Array;
  flags: Uint8Array;
  removed: boolean;
}

function hash01(n: number, salt: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x27d4eb2d, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Merged instanced geometry of the panels of one slot (flex attributes as the vehicle layout, variant in flexFrameU.w). */
export function buildSlotGeometry(panels: readonly BindingPanel<string>[], variants: readonly number[]): InstancedBufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of panels) {
    nv += p.vertexCount;
    ni += p.index.length;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const tan = new Float32Array(nv * 4);
  const tri = [0, 1, 2].map(() => new Float32Array(nv * 4));
  const coef = [0, 1, 2].map(() => new Float32Array(nv * 4));
  const frame = [0, 1, 2].map(() => new Float32Array(nv * 4));
  const T = new Float32Array(nv * 4);
  const U = new Float32Array(nv * 4);
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  panels.forEach((p, pi) => {
    const n = p.vertexCount;
    pos.set(p.restPosition, vo * 3);
    nrm.set(p.restNormal, vo * 3);
    uv.set(p.uv, vo * 2);
    if (p.restTangent) tan.set(p.restTangent, vo * 4);
    const ft = p.frameTangent;
    for (let v = 0; v < n; v++) {
      const d = vo + v;
      for (let k = 0; k < K; k++) {
        const s = K * v + k;
        tri[k]!.set([p.triad[3 * s]!, p.triad[3 * s + 1]!, p.triad[3 * s + 2]!, p.weight[s]!], 4 * d);
        coef[k]!.set([p.coef[4 * s]!, p.coef[4 * s + 1]!, p.coef[4 * s + 2]!, p.coef[4 * s + 3]!], 4 * d);
        frame[k]!.set([p.frameNormal[3 * s]!, p.frameNormal[3 * s + 1]!, p.frameNormal[3 * s + 2]!, ft ? ft[3 * s]! : 0], 4 * d);
        if (ft) {
          const dst = k === 2 ? U : T;
          const o = k === 2 ? 4 * d : 4 * d + 2 * k;
          dst[o] = ft[3 * s + 1]!;
          dst[o + 1] = ft[3 * s + 2]!;
        }
      }
      U[4 * d + 2] = p.damageWeight[v]!;
      U[4 * d + 3] = variants[pi] ?? 0;
    }
    for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i]! + vo;
    vo += n;
    io += p.index.length;
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('tangent', new BufferAttribute(tan, 4));
  for (let k = 0; k < K; k++) {
    g.setAttribute(`flexTriad${k}`, new BufferAttribute(tri[k]!, 4));
    g.setAttribute(`flexCoef${k}`, new BufferAttribute(coef[k]!, 4));
    g.setAttribute(`flexFrame${k}`, new BufferAttribute(frame[k]!, 4));
  }
  g.setAttribute('flexFrameT', new BufferAttribute(T, 4));
  g.setAttribute('flexFrameU', new BufferAttribute(U, 4));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = new Sphere();
  g.instanceCount = 0;
  return g;
}

function cloneBase<M extends Material>(base: M): M {
  const m = base.clone() as M;
  if (Object.prototype.hasOwnProperty.call(base, 'onBeforeCompile')) m.onBeforeCompile = base.onBeforeCompile;
  if (Object.prototype.hasOwnProperty.call(base, 'customProgramCacheKey')) m.customProgramCacheKey = base.customProgramCacheKey;
  return m;
}

/** Quaternion-rotate (x, y, z) by q = (qx, qy, qz, qw) into out[0..3). */
function rotate(q: readonly number[], x: number, y: number, z: number, out: Float64Array): void {
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

export const createPropRenderer: CreatePropRenderer = (ctx: RenderContext, instances: readonly PropInstance[], opts: PropRendererOptions): PropRenderer => {
  const root = new Group();
  root.name = 'props';
  const materials: PropMaterialSet = createPropMaterials(ctx);
  const owned: Material[] = [];
  const stats: PropRendererStats = { instances: 0, visibleInstances: 0, awake: 0, drawCalls: 0 };
  const origin = new Vector3(Math.round(ctx.camera.position.x / 64) * 64, Math.round(ctx.camera.position.y / 64) * 64, Math.round(ctx.camera.position.z / 64) * 64);
  root.position.copy(origin);

  // ---------------------------------------------------------- node texture
  let capacity = 0; // texels per block
  let rows = 1;
  let data = new Float32Array(NODE_TEX_WIDTH * 4 * 2);
  const makeTexture = (): DataTexture => {
    const t = new DataTexture(data, NODE_TEX_WIDTH, rows * 2, RGBAFormat, FloatType);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.name = 'propNodes';
    t.needsUpdate = true;
    return t;
  };
  const uniforms: PropNodeUniforms = { uPropNodes: { value: makeTexture() }, uPropRows: { value: rows } };
  const patch = createPropFlexPatch(uniforms);
  let used = 0;
  let texDirty = true;

  function ensureCapacity(texels: number): void {
    if (texels <= capacity) return;
    const newCap = Math.max(texels, capacity * 2, 1024);
    const newRows = Math.ceil(newCap / NODE_TEX_WIDTH);
    const next = new Float32Array(NODE_TEX_WIDTH * 4 * newRows * 2);
    const blockOld = NODE_TEX_WIDTH * 4 * rows;
    const blockNew = NODE_TEX_WIDTH * 4 * newRows;
    if (capacity > 0) {
      next.set(data.subarray(0, blockOld), 0);
      next.set(data.subarray(blockOld, 2 * blockOld), blockNew);
    }
    data = next;
    rows = newRows;
    capacity = newRows * NODE_TEX_WIDTH;
    const old = uniforms.uPropNodes.value;
    uniforms.uPropNodes.value = makeTexture();
    uniforms.uPropRows.value = rows;
    old.dispose();
    texDirty = true;
  }

  // ---------------------------------------------------------- batches
  const batches = new Map<PropKey, Batch>();
  const batchList: Batch[] = [];
  const byId = new Map<number, Inst>();
  const all: Inst[] = [];

  function slotDraws(key: PropKey, pb: PropBinding, lod: number): SlotDraw[] {
    const bySlot = new Map<PropMaterialSlot, { panels: BindingPanel<string>[]; variants: number[]; cast: boolean }>();
    pb.binding.panels.forEach((p, i) => {
      let e = bySlot.get(p.material);
      if (!e) {
        e = { panels: [], variants: [], cast: false };
        bySlot.set(p.material, e);
      }
      e.panels.push(p);
      e.variants.push(pb.variants[i] ?? 0);
      e.cast ||= p.castShadow;
    });
    const draws: SlotDraw[] = [];
    for (const [slot, e] of bySlot) {
      const geometry = buildSlotGeometry(e.panels, e.variants);
      const inst = new InstancedBufferAttribute(new Float32Array(16 * 4), 4);
      inst.setUsage(DynamicDrawUsage);
      geometry.setAttribute('propInst', inst);
      const set = opts.patchMaterial(cloneBase(materials.base(slot)) as MeshStandardMaterial, { csm: opts.lighting.csm, flexbody: patch });
      set.color.shadowSide = DoubleSide;
      const mesh = new Mesh(geometry, set.color);
      if (set.depth) mesh.customDepthMaterial = set.depth;
      if (set.distance) mesh.customDistanceMaterial = set.distance;
      mesh.castShadow = e.cast;
      mesh.receiveShadow = true;
      mesh.name = `props:${key}:${slot}:lod${lod}`;
      mesh.visible = false;
      owned.push(set.color);
      if (set.depth) owned.push(set.depth);
      if (set.distance) owned.push(set.distance);
      root.add(mesh);
      draws.push({ slot, geometry, mesh, inst });
    }
    return draws;
  }

  function buildBatch(key: PropKey): Batch {
    const pb = bindPropVisual(key, 0);
    const rig = pb.rig;
    // surface reach outside the node AABB (rest), for culling spheres
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rig.nodeCount; i++) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, rig.nodePos[3 * i + a]!);
        hi[a] = Math.max(hi[a]!, rig.nodePos[3 * i + a]!);
      }
    }
    let margin = 0;
    for (const p of pb.binding.panels) {
      for (let v = 0; v < p.vertexCount; v++) {
        for (let a = 0; a < 3; a++) {
          const x = p.restPosition[3 * v + a]!;
          margin = Math.max(margin, lo[a]! - x, x - hi[a]!);
        }
      }
    }
    const lods = [slotDraws(key, pb, 0), slotDraws(key, bindPropVisual(key, 1), 1)];
    let height = 0;
    for (let i = 0; i < rig.nodeCount; i++) height = Math.max(height, rig.nodePos[3 * i + 1]!);
    const restLen = new Float64Array(rig.beamCount);
    for (let b = 0; b < rig.beamCount; b++) restLen[b] = rig.beamRestLen[b]!;
    const batch: Batch = {
      key,
      pb,
      nodeCount: rig.nodeCount,
      beamA: Uint32Array.from(rig.beamA),
      beamB: Uint32Array.from(rig.beamB),
      restLen,
      lods,
      instances: [],
      margin: margin + 0.1,
      shadowReach: Math.min(12, 1 + 1.6 * height),
    };
    batches.set(key, batch);
    batchList.push(batch);
    return batch;
  }

  const tmp = new Float64Array(3);
  function writeRest(it: Inst): void {
    const rig = it.batch.pb.rig;
    const t = it.data.transform;
    const box = it.aabb;
    box.fill(Infinity, 0, 3);
    box.fill(-Infinity, 3, 6);
    for (let i = 0; i < rig.nodeCount; i++) {
      rotate(t.quat, rig.nodePos[3 * i]!, rig.nodePos[3 * i + 1]!, rig.nodePos[3 * i + 2]!, tmp);
      const x = tmp[0]! + t.pos[0], y = tmp[1]! + t.pos[1], z = tmp[2]! + t.pos[2];
      const d = 4 * (it.base + i);
      data[d] = x - origin.x;
      data[d + 1] = y - origin.y;
      data[d + 2] = z - origin.z;
      data[d + 3] = it.flags[i]!;
      if (x < box[0]!) box[0] = x;
      if (y < box[1]!) box[1] = y;
      if (z < box[2]!) box[2] = z;
      if (x > box[3]!) box[3] = x;
      if (y > box[4]!) box[4] = y;
      if (z > box[5]!) box[5] = z;
      if (i === 0) {
        it.last[0] = x;
        it.last[1] = y;
        it.last[2] = z;
      }
    }
    texDirty = true;
  }

  function writeSim(it: Inst, src: Float32Array, nodeOffset: number): void {
    const n = it.batch.nodeCount;
    const box = it.aabb;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    for (let i = 0; i < n; i++) {
      const s = 3 * (nodeOffset + i);
      const x = src[s]!, y = src[s + 1]!, z = src[s + 2]!;
      if (!Number.isFinite(x + y + z)) continue;
      const d = 4 * (it.base + i);
      data[d] = x - ox;
      data[d + 1] = y - oy;
      data[d + 2] = z - oz;
      data[d + 3] = it.flags[i]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (minX <= maxX) {
      box[0] = minX;
      box[1] = minY;
      box[2] = minZ;
      box[3] = maxX;
      box[4] = maxY;
      box[5] = maxZ;
    }
    const s0 = 3 * nodeOffset;
    it.last[0] = src[s0]!;
    it.last[1] = src[s0 + 1]!;
    it.last[2] = src[s0 + 2]!;
    it.simWritten = true;
    texDirty = true;
  }

  let strainScratch = new Float32Array(64);
  /** Per snapshot tick: node strain from beam lengths (two-tick persistence), block B .x. */
  function updateStrain(it: Inst, src: Float32Array, nodeOffset: number): void {
    const b = it.batch;
    const n = b.nodeCount;
    if (strainScratch.length < n) strainScratch = new Float32Array(n * 2);
    const raw = strainScratch;
    raw.fill(0, 0, n);
    const base = 3 * nodeOffset;
    for (let k = 0; k < b.beamA.length; k++) {
      const a = b.beamA[k]!, c = b.beamB[k]!;
      const sa = base + 3 * a, sc = base + 3 * c;
      const dx = src[sa]! - src[sc]!, dy = src[sa + 1]! - src[sc + 1]!, dz = src[sa + 2]! - src[sc + 2]!;
      const L0 = b.restLen[k]!;
      if (!(L0 > 1e-6)) continue;
      let e = Math.sqrt(dx * dx + dy * dy + dz * dz) / L0 - 1;
      if (e < 0) e = -e;
      if (!(e < 10)) e = 10;
      if (e > raw[a]!) raw[a] = e;
      if (e > raw[c]!) raw[c] = e;
    }
    const blockB = 4 * NODE_TEX_WIDTH * rows;
    const span = PROP_STRAIN.full - PROP_STRAIN.deadzone;
    for (let i = 0; i < n; i++) {
      const r = raw[i]!;
      const f = r < it.prevRaw[i]! ? r : it.prevRaw[i]!;
      it.prevRaw[i] = r;
      let s = (f - PROP_STRAIN.deadzone) / span;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const d = blockB + 4 * (it.base + i);
      data[d] = s;
      data[d + 1] = it.scuff[i]!;
    }
    texDirty = true;
  }

  function clearDamage(it: Inst): void {
    it.scuff.fill(0);
    it.prevRaw.fill(0);
    it.flags.fill(0);
    const blockB = 4 * NODE_TEX_WIDTH * rows;
    data.fill(0, blockB + 4 * it.base, blockB + 4 * (it.base + it.batch.nodeCount));
    texDirty = true;
  }

  function add(list: readonly PropInstance[]): void {
    for (const p of list) {
      if (!isPropObjectId(p.objectId) || byId.has(p.objectId)) continue;
      const batch = batches.get(p.prop) ?? buildBatch(p.prop);
      const n = batch.nodeCount;
      ensureCapacity(used + n);
      const it: Inst = {
        objectId: p.objectId,
        data: p,
        batch,
        base: used,
        seed: hash01(p.objectId, 11),
        wear: hash01(p.objectId, 23),
        aabb: new Float64Array(6),
        simWritten: false,
        wasAwake: false,
        last: new Float64Array(3),
        prevRaw: new Float32Array(n),
        scuff: new Float32Array(n),
        flags: new Uint8Array(n),
        removed: false,
      };
      used += n;
      batch.instances.push(it);
      byId.set(p.objectId, it);
      all.push(it);
      writeRest(it);
      stats.instances++;
      for (const d of batch.lods.flat()) {
        if (d.inst.count < batch.instances.length) {
          const next = new InstancedBufferAttribute(new Float32Array(Math.max(batch.instances.length, d.inst.count * 2) * 4), 4);
          next.setUsage(DynamicDrawUsage);
          d.geometry.setAttribute('propInst', next);
          d.inst = next;
        }
      }
    }
  }

  // ---------------------------------------------------------- shadows: cascades [0, PROP_SHADOW_CASCADES) only
  const wrapped = new WeakSet<object>();
  let savedVisible = true;
  let shadowMapWrapped = false;
  function installShadowMask(): void {
    const csm = opts.lighting.csm;
    if (!csm) return;
    if (!shadowMapWrapped) {
      shadowMapWrapped = true;
      const shadowMap = ctx.renderer.shadowMap;
      const orig = shadowMap.render;
      shadowMap.render = function (this: unknown, ...args: Parameters<typeof orig>) {
        savedVisible = root.visible;
        try {
          orig.apply(this, args);
        } finally {
          root.visible = savedVisible;
        }
      };
    }
    for (let i = 0; i < csm.lights.length; i++) {
      const shadow = csm.lights[i]!.shadow;
      if (wrapped.has(shadow)) continue;
      wrapped.add(shadow);
      const allowed = i < PROP_SHADOW_CASCADES;
      const origUpdate = shadow.updateMatrices;
      shadow.updateMatrices = function (this: unknown, light) {
        root.visible = savedVisible && allowed;
        return origUpdate.call(this, light);
      };
    }
  }

  // ---------------------------------------------------------- frame
  const frustum = new Frustum();
  const projView = new Matrix4();
  const sphere = new Sphere();
  let cullDistance = PROP_CULL_DISTANCE[ctx.quality.level];
  let lastTick = -1;

  function update(frame: WorldFrame): void {
    const cam = frame.camera;
    // propsOrigin: camera snapped to 64 m (f32 precision of the texel positions)
    const sx = Math.round(cam.position.x / 64) * 64;
    const sy = Math.round(cam.position.y / 64) * 64;
    const sz = Math.round(cam.position.z / 64) * 64;
    const originMoved = sx !== origin.x || sy !== origin.y || sz !== origin.z;
    if (originMoved) {
      origin.set(sx, sy, sz);
      root.position.copy(origin);
      root.updateMatrixWorld();
    }
    const tickChanged = frame.tick !== lastTick;
    lastTick = frame.tick;
    let awake = 0;
    const src = frame.nodes;
    for (let k = 0; k < frame.objects.length; k++) {
      const o = frame.objects[k]!;
      if (!isPropObjectId(o.objectId)) continue;
      const it = byId.get(o.objectId);
      if (!it || o.nodeCount !== it.batch.nodeCount || 3 * (o.nodeOffset + o.nodeCount) > src.length) continue;
      const sleeping = (o.flags & OBJECT_FLAG_SLEEPING) !== 0;
      if (!sleeping) awake++;
      let write = !sleeping || it.wasAwake || !it.simWritten || originMoved;
      if (sleeping && !write) {
        // re-placed while asleep (resetProps): node 0 jumped
        const s0 = 3 * o.nodeOffset;
        const dx = src[s0]! - it.last[0]!, dy = src[s0 + 1]! - it.last[1]!, dz = src[s0 + 2]! - it.last[2]!;
        if (dx * dx + dy * dy + dz * dz > RESET_JUMP_M * RESET_JUMP_M) {
          clearDamage(it);
          write = true;
        }
      }
      if (write) {
        writeSim(it, src, o.nodeOffset);
        if (tickChanged || it.wasAwake !== !sleeping) updateStrain(it, src, o.nodeOffset);
      }
      it.wasAwake = !sleeping;
    }
    if (originMoved) for (const it of all) if (!it.simWritten && !it.removed) writeRest(it);
    stats.awake = awake;

    // per-instance culling + compaction
    projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    let visible = 0;
    let draws = 0;
    const lod1 = PROP_LOD1_DISTANCE * PROP_LOD1_DISTANCE;
    for (const b of batchList) {
      const m = b.margin;
      for (let lod = 0; lod < 2; lod++) {
        let count = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const it of b.instances) {
          const a = it.aabb;
          const mx = (a[0]! + a[3]!) / 2, my = (a[1]! + a[4]!) / 2, mz = (a[2]! + a[5]!) / 2;
          const dx = mx - cx, dy = my - cy, dz = mz - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if ((d2 > lod1 ? 1 : 0) !== lod) continue;
          const hx = (a[3]! - a[0]!) / 2, hy = (a[4]! - a[1]!) / 2, hz = (a[5]! - a[2]!) / 2;
          const r = Math.sqrt(hx * hx + hy * hy + hz * hz) + m;
          const lim = cullDistance + r;
          if (d2 > lim * lim) continue;
          sphere.center.set(mx, my, mz);
          sphere.radius = r + b.shadowReach;
          if (!frustum.intersectsSphere(sphere)) continue;
          const o = 4 * count;
          for (const d of b.lods[lod]!) {
            const arr = d.inst.array as Float32Array;
            arr[o] = it.base;
            arr[o + 1] = it.seed;
            arr[o + 2] = it.wear;
            arr[o + 3] = 0;
          }
          count++;
          if (a[0]! - m < minX) minX = a[0]! - m;
          if (a[1]! - m < minY) minY = a[1]! - m;
          if (a[2]! - m < minZ) minZ = a[2]! - m;
          if (a[3]! + m > maxX) maxX = a[3]! + m;
          if (a[4]! + m > maxY) maxY = a[4]! + m;
          if (a[5]! + m > maxZ) maxZ = a[5]! + m;
        }
        visible += count;
        for (const d of b.lods[lod]!) {
          d.geometry.instanceCount = count;
          d.mesh.visible = count > 0;
          if (count > 0) {
            d.inst.clearUpdateRanges();
            d.inst.addUpdateRange(0, count * 4);
            d.inst.needsUpdate = true;
            const bs = d.geometry.boundingSphere!;
            bs.center.set((minX + maxX) / 2 - origin.x, (minY + maxY) / 2 - origin.y, (minZ + maxZ) / 2 - origin.z);
            bs.radius = 0.5 * Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
            draws++;
          }
        }
      }
    }
    stats.visibleInstances = visible;
    stats.drawCalls = draws;
    root.visible = visible > 0;
    if (texDirty) {
      uniforms.uPropNodes.value.needsUpdate = true;
      texDirty = false;
    }
    installShadowMask();
  }

  function scuffAt(objectId: number, px: number, py: number, pz: number, amount: number, flag: number): void {
    const it = byId.get(objectId);
    if (!it) return;
    const n = it.batch.nodeCount;
    const R = PROP_SCUFF.radius;
    const blockB = 4 * NODE_TEX_WIDTH * rows;
    for (let i = 0; i < n; i++) {
      const d = 4 * (it.base + i);
      const dx = data[d]! + origin.x - px, dy = data[d + 1]! + origin.y - py, dz = data[d + 2]! + origin.z - pz;
      const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / R;
      if (!(q < 1)) continue;
      if (amount > 0) {
        const f = (1 - q * q) * (1 - q * q);
        const s = Math.min(1, it.scuff[i]! + amount * f);
        it.scuff[i] = s;
        data[blockB + d + 1] = s;
      }
      if (flag && q < 0.6) {
        it.flags[i] = it.flags[i]! | flag;
        data[d + 3] = it.flags[i]!;
      }
    }
    texDirty = true;
  }

  add(instances);

  const renderer: PropRenderer = {
    object: root,
    root,
    stats,
    update,
    setQuality(q: QualityPreset) {
      cullDistance = PROP_CULL_DISTANCE[q.level];
    },
    addInstances(list) {
      add(list);
    },
    removeInstance(objectId) {
      const it = byId.get(objectId);
      if (!it) return;
      it.removed = true;
      byId.delete(objectId);
      const b = it.batch;
      b.instances.splice(b.instances.indexOf(it), 1);
      all.splice(all.indexOf(it), 1);
      stats.instances--;
    },
    onImpact(e) {
      if (!(e.impulse > 0)) return;
      scuffAt(e.objectId, e.px, e.py, e.pz, Math.min(1, e.impulse / PROP_SCUFF.fullImpulse), 0);
    },
    onBeamBreak(e) {
      scuffAt(e.objectId, e.px, e.py, e.pz, 0.25, NODE_TEX_FLAG_BROKEN);
    },
    dispose() {
      root.removeFromParent();
      for (const b of batchList) for (const d of b.lods.flat()) d.geometry.dispose();
      for (const m of owned) m.dispose();
      materials.dispose();
      uniforms.uPropNodes.value.dispose();
      const i = PROP_RENDERERS.indexOf(renderer);
      if (i >= 0) PROP_RENDERERS.splice(i, 1);
    },
  };
  const batchCount = batchList.reduce((s, b) => s + b.lods.reduce((t, l) => t + l.length, 0), 0);
  if (batchCount > PROP_DRAW_BUDGET) console.warn(`[props] ${batchCount} batches exceed PROP_DRAW_BUDGET ${PROP_DRAW_BUDGET}`);
  PROP_RENDERERS.push(renderer);
  return renderer;
};

/** Live prop renderers (debug / e2e: also `globalThis.__crumpleProps`). Read-only use. */
export const PROP_RENDERERS: PropRenderer[] = [];
if (typeof window !== 'undefined') (window as unknown as { __crumpleProps: PropRenderer[] }).__crumpleProps = PROP_RENDERERS;
