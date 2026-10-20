/**
 * Ghost bake (P6 T2): the rigid instance meshes of a traffic variant,
 * evaluated from the SAME flexbody bindings the soft-body visual draws, at
 * the variant's SETTLED template nodes (TrafficReadyMsg), so the ghost and
 * the promoted soft body agree at the hand-over (docs/CONTRACTS.md
 * "Ghost ⇄ soft-body hand-over").
 *
 *  - Settle calibration: the pooled soft-body visuals get their static-sag
 *    calibration PRESET from the template (settleOffsets, the same numbers
 *    flexskin's SettleCalibration would average on a car standing still),
 *    and the ghost is baked from the calibrated nodes (ghostNodes), so a
 *    pristine traffic car looks the same in both forms.
 *  - Body LOD1 / LOD2 = the visual's lodBindings evaluated with the CPU
 *    mirror of the single-triad shader (evalFlexVertexSingle): what the
 *    skin draws beyond VEHICLE_LOD1_M.
 *  - Everything opaque goes into ONE merged geometry per LOD with a
 *    per-vertex material code (GHOST_MAT_*), base colour and roughness /
 *    metalness; glass is baked as opaque dark gloss (a car ≥ 25 m away),
 *    and panels hidden behind it (interior, underbody, seals) are left out.
 *  - Wheels: one merged rigid wheel (tyre + rim + disc + caliper) per LOD in
 *    wheel-local space (x = axle outboard), instanced 4 × per car.
 * Pure (three math/geometry only, no GL): unit-tested in node.
 */
import { BufferAttribute, BufferGeometry, Color, Matrix4, Vector3 } from 'three';

import type { CompiledVehicle } from '../../sim/vehicle/types';
import { evalFlexVertexSingle } from '../vehicle/binder';
import { SETTLE_DEFAULTS } from '../vehicle/flexskin';
import { RIM_FINISHES } from '../vehicle/materials';
import type { BindingSet, LightFunction, MaterialSlot, WheelVisualDef } from '../vehicle/types';
import {
  buildRimGeometry,
  buildTyreGeometry,
  createWheelFrame,
  mergePbrParts,
  solveWheelFrame,
  WHEEL_SEGS,
  wheelDims,
  wheelRest,
  type WheelDetail,
  type WheelFrame,
} from '../vehicle/wheels';

// ============================================================ settle
/**
 * Per body node, rig-local: the template's deviation from the rigid rest
 * pose relative to the frame origin, capped like SettleCalibration
 * (SETTLE_DEFAULTS.maxOffset). xyz × bodyNodeCount.
 */
export function settleOffsets(compiled: CompiledVehicle, template: ArrayLike<number>): Float32Array {
  const n = Math.min(compiled.bodyNodeCount, compiled.rig.nodeCount);
  const rest = compiled.rig.nodePos;
  const o = compiled.frameNodes[0] ?? 0;
  const out = new Float32Array(3 * n);
  const max = SETTLE_DEFAULTS.maxOffset;
  for (let i = 0; i < n; i++) {
    let x = template[3 * i]! - template[3 * o]! - (rest[3 * i]! - rest[3 * o]!);
    let y = template[3 * i + 1]! - template[3 * o + 1]! - (rest[3 * i + 1]! - rest[3 * o + 1]!);
    let z = template[3 * i + 2]! - template[3 * o + 2]! - (rest[3 * i + 2]! - rest[3 * o + 2]!);
    let l = Math.hypot(x, y, z);
    if (!Number.isFinite(l)) x = y = z = l = 0;
    if (l > max) {
      const k = max / l;
      x *= k;
      y *= k;
      z *= k;
    }
    out[3 * i] = x;
    out[3 * i + 1] = y;
    out[3 * i + 2] = z;
  }
  return out;
}

/** Template nodes with the settle calibration applied (body nodes − offset; wheels untouched), rig-local xyz. */
export function ghostNodes(compiled: CompiledVehicle, template: ArrayLike<number>, offsets: Float32Array): Float64Array {
  const out = new Float64Array(3 * compiled.rig.nodeCount);
  for (let i = 0; i < out.length; i++) out[i] = template[i]!;
  for (let i = 0; i < offsets.length; i++) out[i] = out[i]! - offsets[i]!;
  return out;
}

// ============================================================ body
/** Per-vertex material codes (crMat.x). */
export const GHOST_MAT_PLAIN = 0;
export const GHOST_MAT_PAINT = 1;
/** Clear-coated non-paint (glass, lenses, chrome). */
export const GHOST_MAT_GLOSS = 2;

/** Lamp codes (crMat.w). Indicators by side (the panel's own light functions). */
export const GHOST_LAMP = { none: 0, head: 1, tail: 2, reverse: 3, indicatorL: 4, indicatorR: 5 } as const;

interface SlotLook {
  color: number;
  roughness: number;
  metalness: number;
  mat: number;
}

/** Flat looks of every body slot (the soft body's textures average to these at ghost distances). */
export const GHOST_SLOT_LOOK: Readonly<Record<MaterialSlot, SlotLook | null>> = {
  paint: { color: 0xffffff, roughness: 0.3, metalness: 0, mat: GHOST_MAT_PAINT },
  trim: { color: 0x141518, roughness: 0.55, metalness: 0, mat: GHOST_MAT_PLAIN },
  chrome: { color: 0xd8dade, roughness: 0.12, metalness: 1, mat: GHOST_MAT_GLOSS },
  glass: { color: 0x0a0d10, roughness: 0.06, metalness: 0, mat: GHOST_MAT_GLOSS },
  rubber: { color: 0x0b0b0c, roughness: 0.8, metalness: 0, mat: GHOST_MAT_PLAIN },
  lightHead: { color: 0xa8adb4, roughness: 0.1, metalness: 0.7, mat: GHOST_MAT_GLOSS },
  lightTail: { color: 0x4a0709, roughness: 0.15, metalness: 0, mat: GHOST_MAT_GLOSS },
  lightIndicator: { color: 0x7a4a10, roughness: 0.15, metalness: 0, mat: GHOST_MAT_GLOSS },
  lightReverse: { color: 0x9da2a8, roughness: 0.15, metalness: 0.5, mat: GHOST_MAT_GLOSS },
  interior: null,
  interiorTrim: null,
  grille: { color: 0x0d0e0f, roughness: 0.5, metalness: 0.2, mat: GHOST_MAT_PLAIN },
  mirror: { color: 0x8a9096, roughness: 0.06, metalness: 1, mat: GHOST_MAT_GLOSS },
  underbody: null,
  plate: { color: 0xc9c9c0, roughness: 0.5, metalness: 0, mat: GHOST_MAT_PLAIN },
  rim: { color: 0xc8cbd0, roughness: 0.2, metalness: 1, mat: GHOST_MAT_GLOSS },
  tire: { color: 0x151515, roughness: 0.85, metalness: 0, mat: GHOST_MAT_PLAIN },
  brakeDisc: { color: 0x555555, roughness: 0.5, metalness: 1, mat: GHOST_MAT_PLAIN },
  caliper: { color: 0x8a1010, roughness: 0.35, metalness: 0, mat: GHOST_MAT_PLAIN },
};

function lampCode(lights: readonly LightFunction[]): number {
  if (lights.includes('indicatorL')) return GHOST_LAMP.indicatorL;
  if (lights.includes('indicatorR')) return GHOST_LAMP.indicatorR;
  if (lights.includes('brake') || lights.includes('tail')) return GHOST_LAMP.tail;
  if (lights.includes('head')) return GHOST_LAMP.head;
  if (lights.includes('reverse')) return GHOST_LAMP.reverse;
  return GHOST_LAMP.none;
}

/** Panels a ghost leaves out: hidden behind its opaque glass / underneath, or sub-pixel seals. */
export function ghostSkipsPanel(panelId: string, slot: MaterialSlot, castShadow: boolean): boolean {
  if (GHOST_SLOT_LOOK[slot] === null) return true;
  if (slot === 'rubber' && !castShadow) return true;
  return /^(doorCard|seats|dash|steering|console|headliner|parcelShelf|liner|engineCover)/.test(panelId);
}

/**
 * Merged rigid body of one binding (LOD) at `nodes` (rig-local xyz,
 * stride 3): position, normal, color (linear), crMat = (material code,
 * roughness, metalness, lamp code), uint32 index.
 */
export function bakeGhostBody(binding: BindingSet, nodes: ArrayLike<number>): BufferGeometry {
  let vtx = 0;
  let idx = 0;
  const panels = binding.panels.filter((p) => !ghostSkipsPanel(p.panelId, p.material, p.castShadow));
  for (const p of panels) {
    vtx += p.vertexCount;
    idx += p.index.length;
  }
  const pos = new Float32Array(3 * vtx);
  const nrm = new Float32Array(3 * vtx);
  const col = new Float32Array(3 * vtx);
  const mat = new Float32Array(4 * vtx);
  const index = new Uint32Array(idx);
  const out = new Float64Array(6);
  const c = new Color();
  let v0 = 0;
  let i0 = 0;
  for (const p of panels) {
    const look = GHOST_SLOT_LOOK[p.material]!;
    c.setHex(look.color);
    const lamp = lampCode(p.lights);
    for (let v = 0; v < p.vertexCount; v++) {
      evalFlexVertexSingle(p, v, nodes, out);
      const o = v0 + v;
      pos[3 * o] = out[0]!;
      pos[3 * o + 1] = out[1]!;
      pos[3 * o + 2] = out[2]!;
      nrm[3 * o] = out[3]!;
      nrm[3 * o + 1] = out[4]!;
      nrm[3 * o + 2] = out[5]!;
      col[3 * o] = c.r;
      col[3 * o + 1] = c.g;
      col[3 * o + 2] = c.b;
      mat[4 * o] = look.mat;
      mat[4 * o + 1] = look.roughness;
      mat[4 * o + 2] = look.metalness;
      mat[4 * o + 3] = lamp;
    }
    for (let k = 0; k < p.index.length; k++) index[i0 + k] = p.index[k]! + v0;
    v0 += p.vertexCount;
    i0 += p.index.length;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('crMat', new BufferAttribute(mat, 4));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Positions-only copy (shadow caster). */
export function positionsOnly(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  out.setIndex(g.getIndex());
  out.boundingSphere = g.boundingSphere;
  return out;
}

// ============================================================ wheels
export interface GhostWheel {
  /** Rig-local wheel basis at the template: makeBasis(s, u, v) at the rim centre. */
  rest: Matrix4;
  /** Tyre radius, m (spin = distance / radius). */
  radius: number;
  /** Steered (front) wheel. */
  steered: boolean;
}

/** Wheel frames of the variant at the template nodes. */
export function ghostWheels(compiled: CompiledVehicle, nodes: ArrayLike<number>): GhostWheel[] {
  const out: GhostWheel[] = [];
  const f: WheelFrame = createWheelFrame();
  for (const w of compiled.wheels) {
    const rest = wheelRest(compiled, w);
    if (!solveWheelFrame(rest, nodes, 3, f)) {
      solveWheelFrame(rest, compiled.rig.nodePos, 3, f);
    }
    out.push({ rest: new Matrix4().makeBasis(f.s, f.u, f.v).setPosition(f.centre), radius: w.radius, steered: w.steered });
  }
  return out;
}

/**
 * One merged rigid wheel per detail level in wheel-local space (x = axle
 * outboard): tread + sidewall (flat rubber), rim face/barrel/cap/nuts,
 * disc, caliper. Attributes: position, normal, color, crPbr.
 */
export function bakeGhostWheel(compiled: CompiledVehicle, def: WheelVisualDef, detail: WheelDetail): BufferGeometry {
  const w = compiled.wheels[0]!;
  const dims = wheelDims(compiled, w);
  const segs = WHEEL_SEGS[detail]!;
  const rim = buildRimGeometry(dims, def, def.rim, segs.rim, detail);
  const tyre = buildTyreGeometry(dims, def.tire, segs.tyre, detail);
  const spec = RIM_FINISHES[def.rim.finish] ?? RIM_FINISHES.silver;
  const face = new Color().setHex(spec.color);
  const rubber = new Color().setHex(0x141414);
  const g = mergePbrParts([
    { geo: tyre.tread, color: rubber, pbr: [0, 0.88, 0] },
    { geo: tyre.sidewall, color: rubber.clone().multiplyScalar(1.15), pbr: [0, 0.8, 0] },
    { geo: rim.face, color: face, pbr: [spec.metalness, spec.roughness, spec.clearcoat] },
    { geo: rim.barrel, color: face.clone().multiplyScalar(0.55), pbr: [Math.min(1, spec.metalness), 0.5, 0] },
    { geo: rim.cap, color: new Color().setHex(0x0b0c0e), pbr: [0.4, 0.18, 1] },
    { geo: rim.nuts, color: new Color().setHex(0xd8dade), pbr: [1, 0.08, 0] },
    { geo: rim.disc, color: new Color().setHex(0x4a4a4a), pbr: [1, 0.45, 0] },
    { geo: rim.caliper, color: new Color().setHex(def.brake.caliperColor), pbr: [0.05, 0.32, 1] },
  ])!;
  for (const p of [rim.face, rim.barrel, rim.cap, rim.nuts, rim.hat, rim.disc, rim.caliper, rim.shield, tyre.tread, tyre.sidewall]) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** Wheel matrix (rig-local): T(centre) · R_y(yaw) · R_x(spin) · basis. */
export function wheelLocalMatrix(w: GhostWheel, yaw: number, spin: number, out: Matrix4): Matrix4 {
  const c = _c.setFromMatrixPosition(w.rest);
  _basis.copy(w.rest).setPosition(0, 0, 0);
  _ry.makeRotationY(yaw);
  _rx.makeRotationX(spin);
  out.copy(_ry).multiply(_rx).multiply(_basis);
  out.setPosition(c);
  return out;
}
const _c = new Vector3();
const _basis = new Matrix4();
const _ry = new Matrix4();
const _rx = new Matrix4();
