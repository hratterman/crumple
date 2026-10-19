/**
 * Wheel + tyre visuals (A3; contract: ./types.ts "WHEEL SKIN").
 *
 * Per CompiledWheel, every frame, from the skin's node data (block A, skin
 * space = world − anchor, world-aligned):
 *   RIM FRAME  centre = centroid of the rim ring (both rows), axle
 *              s = normalize(c_rimO − c_rimI) (outboard), in-plane
 *              u = normalize(Σ_k R_s(−α_k)·q_k) — the least-squares phase
 *              of ALL rim nodes vs their rest angles α_k (spin, wobble,
 *              steering all come from the nodes), v = s × u. Rim, spokes,
 *              hub, lug nuts and brake disc follow it rigidly.
 *   UPRIGHT    calipers + dust shield: x = s, y = (attach node − centre) ⊥ s
 *              (the knuckle top), so they steer and bump but never spin.
 *   TYRE       the rim frame + a 'wheel1' vertex patch (flexbody slot of
 *              patchMaterial → colour, depth AND distance, so shadows
 *              deform too):
 *               - radial deflection d_k = |tyre node k ⊥ axle| − rest,
 *                 Catmull-Rom interpolated around the ring between rays
 *                 (never per-node triads: 12 rays would facet), blended
 *                 inner/outer row by axial position, applied with a
 *                 smoothstep falloff from the bead (0) to the tread (1);
 *               - CONTACT FLAT: the soft tread layer lets tyre nodes sink
 *                 into the ground (static ≈ 2 cm), so the tread is clamped
 *                 to a ground plane estimated from the lower tyre nodes
 *                 (y − nodeRadius + TYRE_SINK_PER_COMPRESSION·compression,
 *                 calibrated on the settled sedan), faded in by the ring's
 *                 compression so an airborne wheel stays round;
 *               - the squashed sidewall bulges axially.
 * A detached wheel simply follows its own nodes.
 *
 * Geometry is built once per (wheel def, dims) in wheel-local space
 * (x = axle outboard, (y, z) = wheel plane, φ = atan2(z, y)); left and
 * right wheels share it (the frame is always right-handed).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Material,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { CompiledVehicle, CompiledWheel } from '../../sim/vehicle/types';
import type { LightingStack, PatchMaterial, PatchTarget, ShaderPatch } from '../types';
import { RIM_FINISHES } from './materials';
import { attachShadowLod, shadowLodAvailable, type ShadowLodClient } from './shadowlod';
import { vehicleTextures, type TreadPattern } from './textures';
import type { CreateWheelVisuals, FlexSkin, VehicleMaterialSet, WheelVisualDef, WheelVisuals } from './types';

export const WHEEL_PATCH_KEY = 'wheel1';
/** Max rays per ring the shader holds (WHEEL_RAYS_MAX is 14). */
export const TYRE_MAX_RAYS = 16;
/**
 * Ground sink of a tread node per metre of its radial compression
 * (soft contact layer in series with the carcass). Settled sedan: bottom
 * node compressed 18 mm, its sphere 21 mm into the ground → 1.17.
 */
export const TYRE_SINK_PER_COMPRESSION = 1.17;
/** Ring compression (m) over which the contact flat fades in. */
export const TYRE_CONTACT_FADE: readonly [number, number] = [0.002, 0.006];
/** Axial sidewall bulge per metre of tread deflection (at mid sidewall). */
export const TYRE_BULGE_PER_DEFLECTION = 0.55;

// ============================================================ dims
export interface WheelDims {
  /** Outer tyre radius (contact surface at rest), m. */
  radius: number;
  /** Bead seat radius = rim ring radius. */
  bead: number;
  /** Half the axial spacing of the node ring planes. */
  rowHalf: number;
  /** Tyre section half width. */
  tyreHalfW: number;
  /** Rim half width (outer lip plane at +rimHalfW). */
  rimHalfW: number;
  /** Tyre node contact radius. */
  nodeRadius: number;
}

export function wheelDims(compiled: CompiledVehicle, w: CompiledWheel): WheelDims {
  const p = compiled.rig.nodePos;
  let ix = 0, iy = 0, iz = 0, ox = 0, oy = 0, oz = 0;
  for (let k = 0; k < w.rays; k++) {
    const a = 3 * (w.rimStart + k);
    const b = 3 * (w.rimStart + w.rays + k);
    ix += p[a]!; iy += p[a + 1]!; iz += p[a + 2]!;
    ox += p[b]!; oy += p[b + 1]!; oz += p[b + 2]!;
  }
  const rowHalf = Math.hypot(ox - ix, oy - iy, oz - iz) / w.rays / 2;
  const tyreHalfW = Math.max(0.06, rowHalf * 1.36);
  return {
    radius: w.radius,
    bead: w.rimRadius,
    rowHalf: Math.max(1e-3, rowHalf),
    tyreHalfW,
    rimHalfW: tyreHalfW * 0.86,
    nodeRadius: compiled.rig.nodeRadius[w.tireStart] ?? w.radius - w.tireRingRadius,
  };
}

// ============================================================ rest data + frame solve
export interface WheelRest {
  wheel: CompiledWheel;
  rays: number;
  /** cos / sin of each rim node's rest angle (2·rays: rimI then rimO). */
  rimCos: Float64Array;
  rimSin: Float64Array;
  /** Rest polar radius of tyre node k (2·rays: tireI then tireO). */
  tyreR0: Float64Array;
  /** Ray slot (ascending angle) of tyre node k within its row. */
  slotOf: Int32Array;
  /** Rest angle of slot 0 (radians, rest frame). */
  a0: number;
  /** Upright reference node (object-local) or −1 (world up). */
  attach: number;
  /** Caliper angle about the axle from the upright's up axis (rear, ~25° above horizontal). */
  caliperAngle: number;
}

function sub(p: ArrayLike<number>, stride: number, i: number, out: Vector3): Vector3 {
  return out.set(p[i * stride]!, p[i * stride + 1]!, p[i * stride + 2]!);
}

/** In-plane basis (u ⊥ s, toward world up when possible). */
function upBasis(s: Vector3, ref: Vector3 | null, u: Vector3): Vector3 {
  if (ref) u.copy(ref);
  else u.set(0, 1, 0);
  u.addScaledVector(s, -u.dot(s));
  if (u.lengthSq() < 1e-10) {
    u.set(0, 0, 1).addScaledVector(s, -s.z);
  }
  return u.normalize();
}

export function wheelRest(compiled: CompiledVehicle, w: CompiledWheel): WheelRest {
  const p = compiled.rig.nodePos;
  const n = w.rays;
  const cI = new Vector3();
  const cO = new Vector3();
  const t = new Vector3();
  for (let k = 0; k < n; k++) {
    cI.add(sub(p, 3, w.rimStart + k, t));
    cO.add(sub(p, 3, w.rimStart + n + k, t));
  }
  cI.multiplyScalar(1 / n);
  cO.multiplyScalar(1 / n);
  const c = cI.clone().add(cO).multiplyScalar(0.5);
  const s = cO.clone().sub(cI).normalize();
  const u = upBasis(s, null, new Vector3());
  const v = new Vector3().crossVectors(s, u);
  const rimCos = new Float64Array(2 * n);
  const rimSin = new Float64Array(2 * n);
  for (let k = 0; k < 2 * n; k++) {
    sub(p, 3, w.rimStart + k, t).sub(c);
    const a = Math.atan2(t.dot(v), t.dot(u));
    rimCos[k] = Math.cos(a);
    rimSin[k] = Math.sin(a);
  }
  const tyreR0 = new Float64Array(2 * n);
  const ang = new Float64Array(n);
  for (let k = 0; k < 2 * n; k++) {
    sub(p, 3, w.tireStart + k, t).sub(c);
    t.addScaledVector(s, -t.dot(s));
    tyreR0[k] = t.length();
    if (k < n) ang[k] = Math.atan2(t.dot(v), t.dot(u));
  }
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => ang[a]! - ang[b]!);
  const slotOf = new Int32Array(2 * n);
  order.forEach((k, j) => {
    slotOf[k] = j;
    slotOf[k + n] = j;
  });
  // upright reference + caliper placement (toward the rear = +Z, raised ~25°)
  const attach = w.attachNodes.length ? w.attachNodes[0]! : -1;
  const ref = attach >= 0 ? sub(p, 3, attach, new Vector3()).sub(c) : null;
  const cu = upBasis(s, ref, new Vector3());
  const cw = new Vector3().crossVectors(s, cu);
  const rear = Math.atan2(cw.z, cu.z); // angle of +Z in the (cu, cw) plane, measured from cu
  return {
    wheel: w,
    rays: n,
    rimCos,
    rimSin,
    tyreR0,
    slotOf,
    a0: ang[order[0]!]!,
    attach,
    caliperAngle: rear * 0.72,
  };
}

export interface WheelFrame {
  centre: Vector3;
  s: Vector3;
  u: Vector3;
  v: Vector3;
  /** Upright up axis (⊥ s). */
  up: Vector3;
  valid: boolean;
}

export function createWheelFrame(): WheelFrame {
  return { centre: new Vector3(), s: new Vector3(1, 0, 0), u: new Vector3(0, 1, 0), v: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), valid: false };
}

const _a = new Vector3();
const _b = new Vector3();
const _q = new Vector3();
const _sq = new Vector3();

/**
 * Rim + upright frame from node positions (object-local indices, `stride`
 * floats per node: 4 for the skin's block A, 3 for rest/interleaved xyz).
 * Leaves `out` untouched (valid false) when the nodes are degenerate/NaN.
 */
export function solveWheelFrame(rest: WheelRest, nodes: ArrayLike<number>, stride: number, out: WheelFrame): boolean {
  const w = rest.wheel;
  const n = rest.rays;
  _a.set(0, 0, 0);
  _b.set(0, 0, 0);
  for (let k = 0; k < n; k++) {
    _a.add(sub(nodes, stride, w.rimStart + k, _q));
    _b.add(sub(nodes, stride, w.rimStart + n + k, _q));
  }
  _a.multiplyScalar(1 / n);
  _b.multiplyScalar(1 / n);
  const cx = (_a.x + _b.x) / 2, cy = (_a.y + _b.y) / 2, cz = (_a.z + _b.z) / 2;
  _b.sub(_a);
  const sl = _b.length();
  if (!(sl > 1e-4) || !Number.isFinite(cx + cy + cz)) return false;
  const s = _b.multiplyScalar(1 / sl);
  // u = Σ q cos α − (s × q) sin α
  let ux = 0, uy = 0, uz = 0;
  for (let k = 0; k < 2 * n; k++) {
    sub(nodes, stride, w.rimStart + k, _q);
    _q.x -= cx;
    _q.y -= cy;
    _q.z -= cz;
    _sq.crossVectors(s, _q);
    const ca = rest.rimCos[k]!, sa = rest.rimSin[k]!;
    ux += _q.x * ca - _sq.x * sa;
    uy += _q.y * ca - _sq.y * sa;
    uz += _q.z * ca - _sq.z * sa;
  }
  _q.set(ux, uy, uz).addScaledVector(s, -(ux * s.x + uy * s.y + uz * s.z));
  const ul = _q.length();
  if (!(ul > 1e-6)) return false;
  out.centre.set(cx, cy, cz);
  out.s.copy(s);
  out.u.copy(_q).multiplyScalar(1 / ul);
  out.v.crossVectors(out.s, out.u);
  if (rest.attach >= 0) {
    sub(nodes, stride, rest.attach, _q);
    _q.x -= cx;
    _q.y -= cy;
    _q.z -= cz;
    upBasis(out.s, Number.isFinite(_q.x + _q.y + _q.z) ? _q : null, out.up);
  } else upBasis(out.s, null, out.up);
  out.valid = true;
  return true;
}

// ============================================================ tyre deformation (uniforms + CPU mirror)
export interface TyreUniforms {
  /** Radial deflection per ray slot, inner / outer row (m). */
  di: { value: Float32Array };
  do: { value: Float32Array };
  /** rays, slot-0 angle, 0, 0. */
  ring: { value: { x: number; y: number; z: number; w: number } };
  /** Ground plane in wheel-local space: normal xyz, offset (dot(p, n) ≥ w above ground). */
  plane: { value: { x: number; y: number; z: number; w: number } };
  /** radius, bead, rowHalf, bulge. */
  dims: { value: { x: number; y: number; z: number; w: number } };
}

export function createTyreUniforms(dims: WheelDims, rest: WheelRest): TyreUniforms {
  return {
    di: { value: new Float32Array(TYRE_MAX_RAYS) },
    do: { value: new Float32Array(TYRE_MAX_RAYS) },
    ring: { value: { x: rest.rays, y: rest.a0, z: 0, w: 0 } },
    plane: { value: { x: 0, y: 1, z: 0, w: -10 } },
    dims: { value: { x: dims.radius, y: dims.bead, z: dims.rowHalf, w: TYRE_BULGE_PER_DEFLECTION } },
  };
}

/**
 * Writes the tyre uniforms (ring deflections + contact plane) from node
 * positions and the solved frame. World up = +Y (skin space is world-aligned).
 */
export function updateTyreUniforms(
  rest: WheelRest,
  dims: WheelDims,
  frame: WheelFrame,
  nodes: ArrayLike<number>,
  stride: number,
  u: TyreUniforms,
): void {
  const w = rest.wheel;
  const n = rest.rays;
  const c = frame.centre;
  const s = frame.s;
  let gmin = Infinity;
  let comp = 0;
  for (let k = 0; k < 2 * n; k++) {
    sub(nodes, stride, w.tireStart + k, _q);
    const py = _q.y;
    _q.sub(c);
    _q.addScaledVector(s, -_q.dot(s));
    const r = _q.length();
    if (!Number.isFinite(r)) continue;
    const d = r - rest.tyreR0[k]!;
    const slot = rest.slotOf[k]!;
    if (k < n) u.di.value[slot] = d;
    else u.do.value[slot] = d;
    // lower half of the ring (radial direction pointing down) → ground estimate
    if (r > 1e-4 && -_q.y / r > 0.35) {
      const cpr = Math.max(0, -d);
      const g = py - dims.nodeRadius + TYRE_SINK_PER_COMPRESSION * cpr;
      if (g < gmin) gmin = g;
      if (cpr > comp) comp = cpr;
    }
  }
  const pl = u.plane.value;
  pl.x = frame.s.y;
  pl.y = frame.u.y;
  pl.z = frame.v.y;
  const [f0, f1] = TYRE_CONTACT_FADE;
  const t = Math.min(1, Math.max(0, (comp - f0) / (f1 - f0)));
  const contact = t * t * (3 - 2 * t);
  pl.w = Number.isFinite(gmin) ? gmin - c.y - (1 - contact) * 0.08 : -10;
}

/** Periodic Catmull-Rom over ray slots. */
function crSample(arr: ArrayLike<number>, n: number, j: number, f: number): number {
  const p0 = arr[(j - 1 + n) % n]!;
  const p1 = arr[j % n]!;
  const p2 = arr[(j + 1) % n]!;
  const p3 = arr[(j + 2) % n]!;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

/** CPU mirror of the 'wheel1' vertex code (tests): deforms a wheel-local point in place. */
export function deformTyrePoint(u: TyreUniforms, p: Vector3): Vector3 {
  const dims = u.dims.value;
  const n = u.ring.value.x;
  const r = Math.hypot(p.y, p.z);
  const dy = r > 1e-5 ? p.y / r : 1;
  const dz = r > 1e-5 ? p.z / r : 0;
  const step = (2 * Math.PI) / n;
  const a = Math.atan2(dz, dy) - u.ring.value.y;
  let tu = (a / step) % n;
  if (tu < 0) tu += n;
  const j = Math.floor(tu);
  const f = tu - j;
  const wO = Math.min(1, Math.max(0, 0.5 + p.x / (2 * dims.z)));
  const d = crSample(u.di.value, n, j, f) * (1 - wO) + crSample(u.do.value, n, j, f) * wO;
  let tread = dims.x + d;
  const pl = u.plane.value;
  const dn = dy * pl.y + dz * pl.z;
  if (dn < -1e-3) tread = Math.min(tread, (pl.w - p.x * pl.x) / dn);
  tread = Math.max(tread, dims.y + 0.01);
  const delta = dims.x - tread;
  const t = Math.min(1, Math.max(0, (r - dims.y) / (dims.x - dims.y)));
  const g = t * t * (3 - 2 * t);
  const rn = r - delta * g;
  p.y = dy * rn;
  p.z = dz * rn;
  p.x += Math.sign(p.x) * dims.w * Math.max(delta, 0) * 4 * t * (1 - t);
  return p;
}

const TYRE_VERTEX_PARS = /* glsl */ `
uniform float uTyreDI[ ${TYRE_MAX_RAYS} ];
uniform float uTyreDO[ ${TYRE_MAX_RAYS} ];
uniform vec4 uTyreRing;
uniform vec4 uTyrePlane;
uniform vec4 uTyreDims;
float tyreSlot( int j, float wO ) {
	int n = int( uTyreRing.x + 0.5 );
	int k = ( j + n ) % n;
	return mix( uTyreDI[ k ], uTyreDO[ k ], wO );
}
`;
const TYRE_BEGIN_VERTEX = /* glsl */ `
vec3 transformed = vec3( position );
{
	float tyR = length( transformed.yz );
	vec2 tyDir = tyR > 1e-5 ? transformed.yz / tyR : vec2( 1.0, 0.0 );
	float tyN = uTyreRing.x;
	float tyA = atan( tyDir.y, tyDir.x ) - uTyreRing.y;
	float tyU = mod( tyA / ( 6.28318530718 / tyN ), tyN );
	float tyJf = floor( tyU );
	float tyF = tyU - tyJf;
	int tyJ = int( tyJf );
	float tyWO = clamp( 0.5 + transformed.x / ( 2.0 * uTyreDims.z ), 0.0, 1.0 );
	float p0 = tyreSlot( tyJ - 1, tyWO );
	float p1 = tyreSlot( tyJ, tyWO );
	float p2 = tyreSlot( tyJ + 1, tyWO );
	float p3 = tyreSlot( tyJ + 2, tyWO );
	float tyD = 0.5 * ( 2.0 * p1 + ( -p0 + p2 ) * tyF + ( 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 ) * tyF * tyF + ( -p0 + 3.0 * p1 - 3.0 * p2 + p3 ) * tyF * tyF * tyF );
	float tyTread = uTyreDims.x + tyD;
	float tyDn = dot( tyDir, uTyrePlane.yz );
	if ( tyDn < -1e-3 ) tyTread = min( tyTread, ( uTyrePlane.w - transformed.x * uTyrePlane.x ) / tyDn );
	tyTread = max( tyTread, uTyreDims.y + 0.01 );
	float tyDelta = uTyreDims.x - tyTread;
	float tyT = clamp( ( tyR - uTyreDims.y ) / ( uTyreDims.x - uTyreDims.y ), 0.0, 1.0 );
	float tyG = tyT * tyT * ( 3.0 - 2.0 * tyT );
	transformed.yz = tyDir * ( tyR - tyDelta * tyG );
	transformed.x += sign( transformed.x ) * uTyreDims.w * max( tyDelta, 0.0 ) * 4.0 * tyT * ( 1.0 - tyT );
}
`;

/**
 * Instanced variant (one draw for every wheel of a geometry variant): the
 * per-wheel uniforms become arrays indexed by gl_InstanceID; uTyreD packs
 * per wheel 4 vec4 of inner-row deflections then 4 of outer-row ones.
 */
function tyreInstancedPars(n: number): string {
  return /* glsl */ `
uniform vec4 uTyreD[ ${8 * n} ];
uniform vec4 uTyreRingI[ ${n} ];
uniform vec4 uTyrePlaneI[ ${n} ];
uniform vec4 uTyreDimsI[ ${n} ];
float tyreSlotI( int base, int n, int j, float wO ) {
	int k = ( j + n ) % n;
	int c = k & 3;
	return mix( uTyreD[ base + ( k >> 2 ) ][ c ], uTyreD[ base + 4 + ( k >> 2 ) ][ c ], wO );
}
`;
}
const TYRE_INSTANCE_SELECT = /* glsl */ `
#ifdef USE_INSTANCING
	int tyI = gl_InstanceID;
#else
	int tyI = 0;
#endif
	vec4 uTyreRing = uTyreRingI[ tyI ];
	vec4 uTyrePlane = uTyrePlaneI[ tyI ];
	vec4 uTyreDims = uTyreDimsI[ tyI ];
#define tyreSlot( j, wO ) tyreSlotI( tyI * 8, int( uTyreRing.x + 0.5 ), j, wO )
`;

/** Applies the wheel1 GLSL edit (exported for tests); `instances` > 0 = the instanced variant. */
export function applyTyreGlsl(shader: { vertexShader: string }, instances = 0): void {
  const vs = shader.vertexShader;
  for (const chunk of ['#include <common>', '#include <begin_vertex>']) {
    if (!vs.includes(chunk)) throw new Error(`wheel1: vertex shader lacks ${chunk}`);
  }
  shader.vertexShader =
    instances > 0
      ? vs
          .replace('#include <common>', `#include <common>\n${tyreInstancedPars(instances)}`)
          .replace('#include <begin_vertex>', `${TYRE_INSTANCE_SELECT}${TYRE_BEGIN_VERTEX}#undef tyreSlot\n`)
      : vs.replace('#include <common>', `#include <common>\n${TYRE_VERTEX_PARS}`).replace('#include <begin_vertex>', TYRE_BEGIN_VERTEX);
}

/** Packed uniforms of an instanced tyre patch (one entry per wheel instance). */
export interface TyreInstanceUniforms {
  d: { value: Float32Array };
  ring: { value: Float32Array };
  plane: { value: Float32Array };
  dims: { value: Float32Array };
}

export function createTyreInstanceUniforms(n: number): TyreInstanceUniforms {
  return {
    d: { value: new Float32Array(32 * n) },
    ring: { value: new Float32Array(4 * n) },
    plane: { value: new Float32Array(4 * n) },
    dims: { value: new Float32Array(4 * n) },
  };
}

/** Copies wheel `i`'s TyreUniforms into the packed arrays. */
export function packTyreInstance(src: TyreUniforms, i: number, out: TyreInstanceUniforms): void {
  const d = out.d.value;
  const o = 32 * i;
  for (let k = 0; k < TYRE_MAX_RAYS; k++) {
    d[o + k] = src.di.value[k]!;
    d[o + 16 + k] = src.do.value[k]!;
  }
  const v4 = (q: { x: number; y: number; z: number; w: number }, a: Float32Array): void => {
    a[4 * i] = q.x;
    a[4 * i + 1] = q.y;
    a[4 * i + 2] = q.z;
    a[4 * i + 3] = q.w;
  };
  v4(src.ring.value, out.ring.value);
  v4(src.plane.value, out.plane.value);
  v4(src.dims.value, out.dims.value);
}

/** Instanced tyre patch (key wheel1i<n>): every wheel of a variant in one draw, shadows deform too. */
export function createTyreInstancedPatch(u: TyreInstanceUniforms, n: number): ShaderPatch {
  return {
    key: `${WHEEL_PATCH_KEY}i${n}`,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, _target: PatchTarget): void {
      shader.uniforms.uTyreD = u.d;
      shader.uniforms.uTyreRingI = u.ring;
      shader.uniforms.uTyrePlaneI = u.plane;
      shader.uniforms.uTyreDimsI = u.dims;
      applyTyreGlsl(shader, n);
    },
  };
}

/** One wheel's tyre patch (uniform objects shared by its tread + sidewall materials and their shadow twins). */
export function createTyrePatch(u: TyreUniforms): ShaderPatch {
  return {
    key: WHEEL_PATCH_KEY,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, _target: PatchTarget): void {
      shader.uniforms.uTyreDI = u.di;
      shader.uniforms.uTyreDO = u.do;
      shader.uniforms.uTyreRing = u.ring;
      shader.uniforms.uTyrePlane = u.plane;
      shader.uniforms.uTyreDims = u.dims;
      applyTyreGlsl(shader);
    },
  };
}

// ============================================================ geometry builders
interface P2 {
  x: number;
  r: number;
}
interface GeoBuf {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}
const newBuf = (): GeoBuf => ({ pos: [], nrm: [], uv: [], idx: [] });

function toGeometry(b: GeoBuf): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(b.nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2));
  g.setIndex(b.idx);
  if (b.pos.length) g.computeBoundingSphere();
  return g;
}

/**
 * Lathes a profile strip around +x. Visible side = LEFT of the traversal in
 * (x, r) (normal = (−dr, dx)). v(i) per point; u = φ/2π·uScale.
 */
function lathe(
  b: GeoBuf,
  strip: readonly P2[],
  segs: number,
  opts: { v?: (i: number, p: P2) => number; uScale?: number; phi0?: number; phiLen?: number } = {},
): void {
  const n = strip.length;
  if (n < 2) return;
  const phi0 = opts.phi0 ?? 0;
  const phiLen = opts.phiLen ?? Math.PI * 2;
  const uScale = opts.uScale ?? 1;
  const base = b.pos.length / 3;
  const nx: number[] = [];
  const nr: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = strip[Math.max(0, i - 1)]!;
    const c = strip[Math.min(n - 1, i + 1)]!;
    const dx = c.x - a.x;
    const dr = c.r - a.r;
    const l = Math.hypot(dx, dr) || 1;
    nx.push(-dr / l);
    nr.push(dx / l);
  }
  for (let j = 0; j <= segs; j++) {
    const phi = phi0 + (phiLen * j) / segs;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let i = 0; i < n; i++) {
      const p = strip[i]!;
      b.pos.push(p.x, p.r * cp, p.r * sp);
      b.nrm.push(nx[i]!, nr[i]! * cp, nr[i]! * sp);
      b.uv.push(((phi - phi0) / (Math.PI * 2)) * uScale, opts.v ? opts.v(i, p) : i / (n - 1));
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = base + j * n + i;
      const bb = a + 1;
      const d = a + n;
      const c = d + 1;
      b.idx.push(a, d, bb, bb, d, c);
    }
  }
}

/** Splits a polyline into strips at corner indices (hard edges): corners are shared points. */
function stripsAt(points: readonly P2[], corners: readonly number[]): P2[][] {
  const cs = [...new Set(corners)].filter((c) => c > 0 && c < points.length - 1).sort((a, b) => a - b);
  const out: P2[][] = [];
  let start = 0;
  for (const c of cs) {
    out.push(points.slice(start, c + 1));
    start = c;
  }
  out.push(points.slice(start));
  return out;
}

// ---------------------------------------------------------------- tyre
export interface TyreGeometry {
  tread: BufferGeometry;
  sidewall: BufferGeometry;
  /** Groove centres / widths as fractions of the tread band arc (texture alignment). */
  grooves: { v: number; w: number }[];
  /** Tread texture tiles around the circumference (4 pitches each). */
  tiles: number;
}

const GROOVES: Readonly<Record<TreadPattern, readonly { x: number; w: number; depth: number }[]>> = {
  // x as a fraction of the tread half width (signed), w / depth in metres
  street: [
    { x: -0.62, w: 0.009, depth: 0.007 },
    { x: -0.2, w: 0.011, depth: 0.008 },
    { x: 0.2, w: 0.011, depth: 0.008 },
    { x: 0.62, w: 0.009, depth: 0.007 },
  ],
  sport: [
    { x: -0.42, w: 0.013, depth: 0.007 },
    { x: 0.08, w: 0.007, depth: 0.006 },
    { x: 0.46, w: 0.014, depth: 0.007 },
  ],
  allTerrain: [
    { x: -0.55, w: 0.012, depth: 0.011 },
    { x: -0.05, w: 0.012, depth: 0.011 },
    { x: 0.45, w: 0.012, depth: 0.011 },
  ],
};

/** Tyre / rim geometry detail per wheel LOD: 0 full (≈ 32 k triangles per wheel), 1 (≤ 4 k), 2 (≈ 0.8 k). */
export type WheelDetail = 0 | 1 | 2;
const TYRE_DETAIL = [
  { shoulder: 7, tread: 28, grooves: true, side: 16 },
  { shoulder: 3, tread: 6, grooves: false, side: 6 },
  { shoulder: 2, tread: 3, grooves: false, side: 3 },
] as const;
/** Lathe segments per wheel LOD (tyre, rim parts). */
export const WHEEL_SEGS: readonly { tyre: number; rim: number }[] = [
  { tyre: 144, rim: 96 },
  { tyre: 32, rim: 24 },
  { tyre: 16, rim: 12 },
];

export function buildTyreGeometry(dims: WheelDims, tire: WheelVisualDef['tire'], segs = 144, detail: WheelDetail = 0): TyreGeometry {
  const R = dims.radius;
  const halfW = dims.tyreHalfW;
  const shoulderR = Math.min(0.026, halfW * 0.28);
  const crown = 0.004;
  const xt = halfW - shoulderR;
  const treadR = (x: number): number => R - crown * Math.min(1, (x / xt) ** 2);
  const grooves = [...GROOVES[tire.tread]].sort((a, b) => a.x - b.x);
  // ---- tread band (x −→ +), with grooves as hard-edged notches (x is monotone along the band)
  const band = (d: (typeof TYRE_DETAIL)[number]): { pts: P2[]; corners: number[] } => {
    const pts: P2[] = [];
    const corners: number[] = [];
    const shoulder = (sign: 1 | -1, from: number, to: number, steps: number): void => {
      for (let k = 0; k <= steps; k++) {
        const th = from + ((to - from) * k) / steps;
        pts.push({ x: sign * (xt + shoulderR * Math.sin(th)), r: R - crown - shoulderR + shoulderR * Math.cos(th) });
      }
    };
    shoulder(-1, Math.PI / 2, 0, d.shoulder);
    let gi = 0;
    for (let k = 1; k < d.tread; k++) {
      const x = -xt + (2 * xt * k) / d.tread;
      while (d.grooves && gi < grooves.length && grooves[gi]!.x * xt - grooves[gi]!.w / 2 < x) {
        const g = grooves[gi]!;
        const gx = g.x * xt;
        const x0 = gx - g.w / 2;
        const x1 = gx + g.w / 2;
        const r0 = treadR(x0);
        const r1 = treadR(x1);
        corners.push(pts.length);
        pts.push({ x: x0, r: r0 });
        corners.push(pts.length);
        pts.push({ x: x0 + 0.0012, r: r0 - g.depth });
        corners.push(pts.length);
        pts.push({ x: x1 - 0.0012, r: r1 - g.depth });
        corners.push(pts.length);
        pts.push({ x: x1, r: r1 });
        gi++;
      }
      if (pts.length && x <= pts[pts.length - 1]!.x + 1e-4) continue;
      pts.push({ x, r: treadR(x) });
    }
    shoulder(1, 0, Math.PI / 2, d.shoulder);
    return { pts, corners };
  };
  // arc-length v over the FULL band (the tread texture is laid out on it at every LOD)
  const full = band(TYRE_DETAIL[0]);
  const fpts = full.pts;
  const corners0 = full.corners;
  const arc: number[] = [0];
  for (let i = 1; i < fpts.length; i++) arc.push(arc[i - 1]! + Math.hypot(fpts[i]!.x - fpts[i - 1]!.x, fpts[i]!.r - fpts[i - 1]!.r));
  const total = arc[arc.length - 1]!;
  /** v of a band point: the full band's arc length at the same x (identity at detail 0). */
  const vAtX = (x: number): number => {
    if (x <= fpts[0]!.x) return 0;
    for (let i = 1; i < fpts.length; i++) {
      if (x <= fpts[i]!.x) {
        const t = (x - fpts[i - 1]!.x) / Math.max(1e-9, fpts[i]!.x - fpts[i - 1]!.x);
        return (arc[i - 1]! + t * (arc[i]! - arc[i - 1]!)) / total;
      }
    }
    return 1;
  };
  const { pts, corners } = detail === 0 ? full : band(TYRE_DETAIL[detail]);
  const vOf = new Map<P2, number>();
  pts.forEach((p, i) => vOf.set(p, detail === 0 ? arc[i]! / total : vAtX(p.x)));
  const pitchLen = 0.032;
  const circumference = 2 * Math.PI * R;
  const tiles = Math.max(4, Math.round(circumference / (pitchLen * 4)));
  const tread = newBuf();
  for (const st of stripsAt(pts, corners)) lathe(tread, st, segs, { v: (_i, p) => vOf.get(p)!, uScale: tiles });
  const grooveV: { v: number; w: number }[] = [];
  for (let c = 0; c + 3 < corners0.length; c += 4) {
    const a = arc[corners0[c]!]!;
    const b = arc[corners0[c + 3]!]!;
    grooveV.push({ v: (a + b) / 2 / total, w: (b - a) / total });
  }
  // ---- sidewalls: cubic from the shoulder end down to the bead, plus the bead tuck under the flange
  const top: P2 = { x: halfW, r: R - crown - shoulderR };
  const bead: P2 = { x: dims.rimHalfW + 0.004, r: dims.bead + 0.017 };
  const h = top.r - bead.r;
  const bulge = Math.min(0.2, Math.max(0, tire.bulge));
  const c1: P2 = { x: top.x + h * bulge * 0.55, r: top.r - h * 0.38 };
  const c2: P2 = { x: bead.x + 0.012 + h * bulge * 0.2, r: bead.r + h * 0.32 };
  const side: P2[] = [];
  const SIDE = TYRE_DETAIL[detail].side;
  for (let k = 0; k <= SIDE; k++) {
    const t = k / SIDE;
    const m = 1 - t;
    side.push({
      x: m * m * m * top.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * bead.x,
      r: m * m * m * top.r + 3 * m * m * t * c1.r + 3 * m * t * t * c2.r + t * t * t * bead.r,
    });
  }
  side.push({ x: bead.x - 0.003, r: dims.bead + 0.008 });
  side.push({ x: dims.rimHalfW - 0.004, r: dims.bead + 0.002 });
  const rTop = top.r;
  const sv = (_i: number, p: P2): number => Math.min(1, Math.max(0, (p.r - dims.bead) / (rTop - dims.bead)));
  const sidewall = newBuf();
  // outer (+x, traversed top → bead): u = −φ so lettering reads left → right from outside
  lathe(sidewall, side, segs, { v: sv, uScale: -1 });
  // inner (−x, traversed bead → top)
  const inner = side.map((p) => ({ x: -p.x, r: p.r })).reverse();
  lathe(sidewall, inner, segs, { v: sv, uScale: 1 });
  return { tread: toGeometry(tread), sidewall: toGeometry(sidewall), grooves: grooveV, tiles };
}

// ---------------------------------------------------------------- rim
export interface RimLayout {
  /** Outer lip plane. */
  xFace: number;
  /** Spoke outer ends / dish wall bottom. */
  xEnd: number;
  /** Hub face plane (xEnd − dish). */
  xHub: number;
  rFlange: number;
  rEnd: number;
  rHub: number;
  /** Brake disc centre plane, radius, thickness. */
  xDisc: number;
  rDisc: number;
  tDisc: number;
}

export function rimLayout(dims: WheelDims, rim: WheelVisualDef['rim'], brake: WheelVisualDef['brake']): RimLayout {
  const xFace = dims.rimHalfW;
  const xEnd = xFace - 0.016;
  const dish = Math.min(0.07, Math.max(0, rim.dish));
  const xHub = xEnd - dish;
  const tDisc = 0.026;
  const xDisc = xHub - 0.03 - 0.006 - tDisc / 2;
  return {
    xFace,
    xEnd,
    xHub,
    rFlange: dims.bead + 0.017,
    rEnd: dims.bead - 0.014,
    rHub: 0.072,
    xDisc,
    rDisc: Math.min(brake.discRadius, dims.bead - 0.05),
    tDisc,
  };
}

/** Spoke sweep: chamfered, crowned bar from hub to lip with dish, width taper, flare and twist. */
function spoke(b: GeoBuf, L: RimLayout, theta0: number, twist: number, wHub: number, wRim: number, flare: number, S = 16): void {
  const r0 = L.rHub - 0.008;
  const r1 = L.rEnd + 0.006;
  const sections: Vector3[][] = [];
  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const r = r0 + (r1 - r0) * t;
    const th = theta0 + twist * t;
    const ery = Math.cos(th), erz = Math.sin(th);
    const ety = -erz, etz = ery;
    const w = wHub + (wRim - wHub) * Math.pow(t, 1.3) + flare * Math.pow(t, 6) + 0.012 * Math.pow(1 - t, 8);
    const xf = L.xEnd - (L.xEnd - L.xHub) * Math.pow(1 - t, 1.5) + 0.002;
    const xb = xf - (0.03 - 0.01 * t);
    const c = Math.min(0.0045, w / 6);
    const crown = 0.0035;
    const sec: [number, number][] = [
      [-w / 2, xb],
      [-w / 2, xf - c],
      [-w / 2 + c, xf],
      [0, xf + crown],
      [w / 2 - c, xf],
      [w / 2, xf - c],
      [w / 2, xb],
      [-w / 2, xb],
    ];
    sections.push(sec.map(([sl, xa]) => new Vector3(xa, r * ery + sl * ety, r * erz + sl * etz)));
  }
  const nPts = sections[0]!.length;
  const dt = new Vector3();
  const ab = new Vector3();
  const nn = new Vector3();
  for (let f = 0; f < nPts - 1; f++) {
    const base = b.pos.length / 3;
    for (let i = 0; i <= S; i++) {
      const A = sections[i]![f]!;
      const B = sections[i]![f + 1]!;
      const Ap = sections[Math.min(S, i + 1)]![f]!;
      const Am = sections[Math.max(0, i - 1)]![f]!;
      dt.subVectors(Ap, Am);
      ab.subVectors(B, A);
      nn.crossVectors(dt, ab).normalize();
      for (const P of [A, B]) {
        b.pos.push(P.x, P.y, P.z);
        b.nrm.push(nn.x, nn.y, nn.z);
      }
      b.uv.push(i / S, 0, i / S, 1);
    }
    for (let i = 0; i < S; i++) {
      const a = base + 2 * i;
      const bb = a + 1;
      const a1 = a + 2;
      const b1 = a + 3;
      b.idx.push(a, a1, bb, bb, a1, b1);
    }
  }
}

/** Swept closed convex profile (caliper body) over φ ∈ [φ0, φ1], with end caps. */
function sweepClosed(b: GeoBuf, profile: readonly P2[], phi0: number, phi1: number, segs: number): void {
  // sides
  const loop = [...profile, profile[0]!];
  lathe(b, loop, segs, { phi0, phiLen: phi1 - phi0 });
  // caps (fan, centroid)
  const cx = profile.reduce((s, p) => s + p.x, 0) / profile.length;
  const cr = profile.reduce((s, p) => s + p.r, 0) / profile.length;
  for (const [phi, dir] of [
    [phi0, -1],
    [phi1, 1],
  ] as const) {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    // cap normal = ± tangent direction of φ
    const ny = -sp * dir, nz = cp * dir;
    const base = b.pos.length / 3;
    b.pos.push(cx, cr * cp, cr * sp);
    b.nrm.push(0, ny, nz);
    b.uv.push(0.5, 0.5);
    for (const p of profile) {
      b.pos.push(p.x, p.r * cp, p.r * sp);
      b.nrm.push(0, ny, nz);
      b.uv.push(0, 0);
    }
    for (let i = 0; i < profile.length; i++) {
      const a = base + 1 + i;
      const c = base + 1 + ((i + 1) % profile.length);
      // profile is clockwise in (x, r): (centre, next, this) faces +φ
      if (dir > 0) b.idx.push(base, c, a);
      else b.idx.push(base, a, c);
    }
  }
}

/** Rounded-rectangle profile in (x, r). */
function roundedRect(x0: number, x1: number, r0: number, r1: number, rad: number, steps = 3): P2[] {
  const out: P2[] = [];
  const corner = (cx: number, cr: number, a0: number): void => {
    for (let k = 0; k <= steps; k++) {
      const a = a0 + ((Math.PI / 2) * k) / steps;
      out.push({ x: cx + rad * Math.cos(a), r: cr + rad * Math.sin(a) });
    }
  };
  // traversed so the outside is on the left (counter-clockwise in (x, r) as seen with x right, r up → clockwise needed)
  corner(x1 - rad, r1 - rad, 0);
  corner(x0 + rad, r1 - rad, Math.PI / 2);
  corner(x0 + rad, r0 + rad, Math.PI);
  corner(x1 - rad, r0 + rad, (3 * Math.PI) / 2);
  return out.reverse();
}

export interface RimGeometry {
  face: BufferGeometry;
  barrel: BufferGeometry;
  cap: BufferGeometry;
  nuts: BufferGeometry;
  disc: BufferGeometry;
  hat: BufferGeometry;
  caliper: BufferGeometry;
  shield: BufferGeometry;
  layout: RimLayout;
}

export function buildRimGeometry(
  dims: WheelDims,
  def: WheelVisualDef,
  rimDef: WheelVisualDef['rim'] = def.rim,
  segs = 96,
  detail: WheelDetail = 0,
): RimGeometry {
  const SS = detail === 0 ? 16 : detail === 1 ? 4 : 2;
  const L = rimLayout(dims, rimDef, def.brake);
  const rB = dims.bead;
  const lip = Math.min(0.03, Math.max(0.006, rimDef.lip));
  // ---------------- face: lip roll + dish wall + hub + spokes
  const face = newBuf();
  lathe(face, [
    { x: L.xFace - 0.014, r: L.rFlange + 0.001 },
    { x: L.xFace - 0.005, r: L.rFlange + 0.001 },
    { x: L.xFace - 0.0015, r: L.rFlange - 0.0015 },
    { x: L.xFace, r: L.rFlange - 0.005 },
    { x: L.xFace, r: L.rFlange - lip },
  ], segs);
  lathe(face, [
    { x: L.xFace, r: L.rFlange - lip },
    { x: L.xFace - 0.003, r: L.rFlange - lip - 0.003 },
    { x: L.xEnd, r: L.rEnd },
  ], segs);
  // hub: side wall then face (to the cap ring) and a chamfer
  lathe(face, [
    { x: L.xHub - 0.03, r: L.rHub + 0.004 },
    { x: L.xHub - 0.003, r: L.rHub + 0.004 },
    { x: L.xHub + 0.001, r: L.rHub - 0.001 },
    { x: L.xHub + 0.001, r: 0.04 },
    { x: L.xHub - 0.002, r: 0.036 },
  ], segs);
  const style = rimDef.style;
  const N = Math.max(3, Math.round(rimDef.spokes));
  const sw = Math.min(0.9, Math.max(0.08, rimDef.spokeWidth));
  const pitch1 = (2 * Math.PI * L.rEnd) / N;
  const pitch0 = (2 * Math.PI * L.rHub) / N;
  if (style === 'mesh') {
    for (let k = 0; k < 2 * N; k++) {
      const th = (k * Math.PI) / N;
      spoke(face, L, th - 0.18 * (k % 2 ? 1 : -1), 0.36 * (k % 2 ? 1 : -1), 0.014, Math.max(0.012, sw * pitch1 * 0.35), 0.01, SS);
    }
  } else if (style === 'turbine') {
    for (let k = 0; k < N; k++) spoke(face, L, (2 * Math.PI * k) / N, 0.55, Math.max(0.012, sw * pitch0), Math.max(0.016, sw * pitch1 * 0.8), 0.006, SS);
  } else if (style === 'steel') {
    for (let k = 0; k < N; k++) spoke(face, L, (2 * Math.PI * k) / N, 0, Math.max(0.02, pitch0 * 0.85), pitch1 * Math.max(0.55, sw), 0.02, SS);
  } else {
    for (let k = 0; k < N; k++) {
      spoke(face, L, (2 * Math.PI * k) / N, 0, Math.max(0.026, Math.min(pitch0 * 0.8, sw * pitch0 * 1.5)), sw * pitch1, 0.03, SS);
    }
  }
  // ---------------- barrel interior (seen through the spokes), inner flange
  const barrel = newBuf();
  const xIn = -dims.rimHalfW;
  if (detail > 0) {
    lathe(barrel, [
      { x: L.xEnd, r: L.rEnd },
      { x: L.xEnd - 0.012, r: rB - 0.012 },
      { x: xIn, r: rB - 0.012 },
      { x: xIn - 0.004, r: rB },
      { x: xIn - 0.004, r: L.rFlange },
    ], segs);
  } else lathe(barrel, [
    { x: L.xEnd, r: L.rEnd },
    { x: L.xEnd - 0.012, r: rB - 0.012 },
    { x: xIn + 0.05, r: rB - 0.012 },
    { x: xIn + 0.04, r: rB - 0.03 },
    { x: xIn + 0.016, r: rB - 0.03 },
    { x: xIn + 0.008, r: rB - 0.012 },
    { x: xIn, r: rB - 0.012 },
  ], segs);
  if (detail === 0) lathe(barrel, [
    { x: xIn, r: rB - 0.012 },
    { x: xIn - 0.004, r: rB },
    { x: xIn - 0.004, r: L.rFlange },
    { x: xIn + 0.006, r: L.rFlange + 0.001 },
  ], segs);
  // ---------------- centre cap
  const cap = newBuf();
  if (detail === 0) lathe(cap, [
    { x: L.xHub - 0.002, r: 0.036 },
    { x: L.xHub + 0.004, r: 0.034 },
    { x: L.xHub + 0.008, r: 0.028 },
    { x: L.xHub + 0.0095, r: 0.015 },
    { x: L.xHub + 0.01, r: 0.0 },
  ], 48);
  // ---------------- lug nuts (hex, conical tip) on the PCD
  const nutParts: BufferGeometry[] = [];
  const nutCount = detail === 0 ? Math.max(3, Math.round(def.rim.boltCount)) : 0;
  const pcd = Math.min(0.057, L.rHub - 0.018);
  const nb = Math.max(3, nutCount);
  for (let k = 0; k < nutCount; k++) {
    const th = (2 * Math.PI * (k + 0.5)) / nb;
    const hex = new CylinderGeometry(0.0105, 0.0105, 0.014, 6);
    hex.rotateZ(-Math.PI / 2);
    hex.translate(L.xHub + 0.007, 0, 0);
    const tip = new CylinderGeometry(0.004, 0.0085, 0.006, 12);
    tip.rotateZ(-Math.PI / 2);
    tip.translate(L.xHub + 0.017, 0, 0);
    for (const [g, flat] of [
      [hex, true],
      [tip, false],
    ] as const) {
      g.translate(0, pcd * Math.cos(th), pcd * Math.sin(th));
      const ni = g.toNonIndexed();
      if (flat) ni.computeVertexNormals(); // non-indexed → per-face normals: crisp hex flats
      nutParts.push(ni);
      g.dispose();
    }
  }
  const nuts = nutParts.length ? mergeGeometries(nutParts)! : toGeometry(newBuf());
  // ---------------- brake disc (rotates): faces with polar UV, vented edge
  const disc = newBuf();
  const rIn = 0.09;
  const xo = L.xDisc + L.tDisc / 2;
  const xi = L.xDisc - L.tDisc / 2;
  const dv = (_i: number, p: P2): number => (p.r - rIn) / (L.rDisc - rIn);
  lathe(disc, [
    { x: xo, r: L.rDisc },
    { x: xo, r: rIn },
  ], segs, { v: dv });
  lathe(disc, [
    { x: xi, r: rIn },
    { x: xi, r: L.rDisc },
  ], segs, { v: dv });
  lathe(disc, [
    { x: xi, r: L.rDisc },
    { x: xi + 0.008, r: L.rDisc },
  ], segs, { v: () => 0.02 });
  lathe(disc, [
    { x: xo - 0.008, r: L.rDisc },
    { x: xo, r: L.rDisc },
  ], segs, { v: () => 0.02 });
  // ---------------- hat (dark) + vent gap
  const hat = newBuf();
  lathe(hat, [
    { x: xi + 0.008, r: L.rDisc - 0.004 },
    { x: xo - 0.008, r: L.rDisc - 0.004 },
  ], segs);
  lathe(hat, [
    { x: xo, r: rIn },
    { x: L.xHub - 0.032, r: rIn - 0.004 },
    { x: L.xHub - 0.032, r: 0.03 },
  ], segs);
  // ---------------- caliper (non-rotating, built at φ = 0 → placed by the upright frame)
  const cal = newBuf();
  const span = 0.42; // radians
  const cr0 = L.rDisc - 0.044;
  const cr1 = Math.min(L.rDisc + 0.024, rB - 0.03);
  sweepClosed(cal, roundedRect(L.xDisc - 0.034, L.xDisc + 0.032, cr0, cr1, 0.008, detail === 0 ? 3 : 1), -span / 2, span / 2, detail === 0 ? 20 : detail === 1 ? 6 : 3);
  // ---------------- dust shield (non-rotating)
  const shield = newBuf();
  lathe(shield, [
    { x: xi - 0.014, r: L.rDisc + 0.012 },
    { x: xi - 0.011, r: L.rDisc + 0.004 },
    { x: xi - 0.011, r: 0.05 },
    { x: xi - 0.02, r: 0.045 },
    { x: xi - 0.02, r: 0 },
  ], segs);
  return {
    face: toGeometry(face),
    barrel: toGeometry(barrel),
    cap: toGeometry(cap),
    nuts,
    disc: toGeometry(disc),
    hat: toGeometry(hat),
    caliper: toGeometry(cal),
    shield: toGeometry(shield),
    layout: L,
  };
}

// ============================================================ assembly
/**
 * DRAWS (U6 perf pass): wheels sharing a geometry variant (dims + rim + tyre
 * def; the sedan has one) are InstancedMeshes — one draw per part for all of
 * them. Per LOD level (the skin's colour LOD: WHEEL_SEGS / WheelDetail):
 *   rim      face + barrel + centre cap + lug nuts + disc hat, merged with
 *            per-vertex colour + (metalness, roughness, clearcoat) (wheelPbrHook)
 *   disc     brake disc (textured)
 *   upright  caliper + dust shield, merged per-vertex PBR, double-sided
 *   tread, sidewall  the instanced tyre patch (per-wheel ring uniforms by gl_InstanceID)
 * Spin parts share one instance-matrix attribute (rim frame per wheel), the
 * upright parts another (steer/bump frame × the caliper angle).
 * Shadows: one caster InstancedMesh per shadow LOD (tread + sidewall + rim
 * face + disc, positions only, tyre patch so the squash shadows too) — LOD1
 * into cascade 0, LOD2 into cascades ≥ 1 (shadowlod.ts). Without a renderer
 * hook ("direct" mode: tests, dev harnesses) the colour meshes cast.
 */
interface WheelInstance {
  rest: WheelRest;
  dims: WheelDims;
  frame: WheelFrame;
  tyre: TyreUniforms;
  /** Instance slot in its variant group. */
  slot: number;
  /** Caliper rotation about the axle, baked into the upright instance matrix. */
  calRot: Matrix4;
}

interface VariantGroup {
  wheels: WheelInstance[];
  spinM: InstancedBufferAttribute;
  uprightM: InstancedBufferAttribute;
  tyreU: TyreInstanceUniforms;
  /** Colour draws per LOD level. */
  levels: InstancedMesh[][];
  /** [cascade 0 (LOD1), cascades ≥ 1 (LOD2)]. */
  casters: InstancedMesh[];
  sphere: Sphere;
}

export interface WheelVisualOptions {
  materials: VehicleMaterialSet;
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  /** Renderer for the shadow-pass caster switch; absent = colour meshes cast directly. */
  renderer?: WebGLRenderer | null;
}

export interface WheelVisualsImpl extends WheelVisuals {
  /** Colour draws per LOD level (all variants). */
  readonly levels: readonly (readonly Mesh[])[];
  /** Shadow casters (empty in direct mode). */
  readonly casters: readonly Mesh[];
  /** LOD level drawn this frame. */
  readonly lod: number;
}

/** Per-vertex PBR for merged rigid wheel parts: color attribute + crPbr = (metalness, roughness, clearcoat scale, 0). */
export function wheelPbrHook(shader: { vertexShader: string; fragmentShader: string }): void {
  const vs = shader.vertexShader;
  const fs = shader.fragmentShader;
  for (const [src, chunk] of [
    [vs, '#include <common>'],
    [vs, 'void main() {'],
    [fs, '#include <common>'],
    [fs, '#include <roughnessmap_fragment>'],
    [fs, '#include <metalnessmap_fragment>'],
    [fs, '#include <lights_physical_fragment>'],
  ] as const) {
    if (!src.includes(chunk)) throw new Error(`wheel pbr: shader lacks ${chunk}`);
  }
  shader.vertexShader = vs
    .replace('#include <common>', '#include <common>\nattribute vec4 crPbr;\nvarying vec4 vCrPbr;')
    .replace('void main() {', 'void main() {\n\tvCrPbr = crPbr;');
  shader.fragmentShader = fs
    .replace('#include <common>', '#include <common>\nvarying vec4 vCrPbr;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = vCrPbr.y;')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = vCrPbr.x;')
    .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n\tmaterial.clearcoat *= vCrPbr.z;\n#endif');
}

interface PbrPart {
  geo: BufferGeometry;
  color: Color;
  /** metalness, roughness, clearcoat */
  pbr: readonly [number, number, number];
}

/** Indexed copy with the given attributes only (sequential index for non-indexed input). */
function indexedCopy(g: BufferGeometry, names: readonly string[]): BufferGeometry {
  const out = new BufferGeometry();
  for (const n of names) {
    const a = g.getAttribute(n);
    if (a) out.setAttribute(n, a.clone());
  }
  const count = g.getAttribute('position').count;
  const idx = g.getIndex();
  out.setIndex(idx ? Array.from(idx.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i));
  return out;
}

/** Rigid parts merged into one geometry with per-vertex colour + crPbr (empty parts skipped). */
export function mergePbrParts(parts: readonly PbrPart[]): BufferGeometry | null {
  const list: BufferGeometry[] = [];
  for (const p of parts) {
    const n = p.geo.getAttribute('position')?.count ?? 0;
    if (n === 0) continue;
    const g = indexedCopy(p.geo, ['position', 'normal', 'uv']);
    const col = new Float32Array(3 * n);
    const pbr = new Float32Array(4 * n);
    for (let i = 0; i < n; i++) {
      col[3 * i] = p.color.r;
      col[3 * i + 1] = p.color.g;
      col[3 * i + 2] = p.color.b;
      pbr[4 * i] = p.pbr[0];
      pbr[4 * i + 1] = p.pbr[1];
      pbr[4 * i + 2] = p.pbr[2];
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('crPbr', new BufferAttribute(pbr, 4));
    list.push(g);
  }
  if (!list.length) return null;
  const m = mergeGeometries(list)!;
  for (const g of list) g.dispose();
  return m;
}

/** Positions-only merge (shadow casters). */
function mergePositions(parts: readonly BufferGeometry[]): BufferGeometry | null {
  const list = parts.filter((g) => (g.getAttribute('position')?.count ?? 0) > 0).map((g) => indexedCopy(g, ['position']));
  if (!list.length) return null;
  const m = mergeGeometries(list)!;
  for (const g of list) g.dispose();
  return m;
}

type PhysMat = MeshPhysicalMaterial | MeshStandardMaterial;

function clonePhys<M extends PhysMat>(m: M): M {
  return m.clone() as M;
}

const _m = new Matrix4();
const _z = new Vector3();

export const createWheelVisuals = (compiled: CompiledVehicle, def: WheelVisualDef, opts: WheelVisualOptions): WheelVisualsImpl => {
  const object = new Group();
  object.name = `wheels:${compiled.name}`;
  const owned = new Set<Material>();
  const geoms = new Set<BufferGeometry>();
  const csm = opts.lighting.csm;
  const direct = !shadowLodAvailable(opts.renderer);
  const M = opts.materials;
  const own = <T extends { color: Material; depth: Material | null; distance: Material | null }>(set: T): T => {
    owned.add(set.color);
    if (set.depth) owned.add(set.depth);
    if (set.distance) owned.add(set.distance);
    return set;
  };
  /** A per-vertex-PBR material (rigid wheel parts). */
  const pbrMaterial = (name: string, doubleSide: boolean, ccRoughness: number): Material => {
    const m = clonePhys(M.base('rim') as MeshPhysicalMaterial);
    m.name = name;
    m.color.setRGB(1, 1, 1);
    m.vertexColors = true;
    m.metalness = 1;
    m.roughness = 1;
    m.clearcoat = 1;
    m.clearcoatRoughness = ccRoughness;
    m.map = null;
    m.normalMap = null;
    if (doubleSide) m.side = DoubleSide;
    const prior = m.onBeforeCompile;
    m.onBeforeCompile = function (this: Material, shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) {
      prior.call(this, shader, r);
      wheelPbrHook(shader);
    } as typeof m.onBeforeCompile;
    const key = `${m.customProgramCacheKey()}|wpbr1`;
    m.customProgramCacheKey = () => key;
    return own(opts.patchMaterial(m, { csm })).color;
  };
  const rimMat = pbrMaterial('crWheelRim', false, 0.04);
  const uprightMat = pbrMaterial('crWheelUpright', true, 0.05);
  const discMat = own(opts.patchMaterial(clonePhys(M.base('brakeDisc')), { csm })).color;
  const colorOf = (slot: 'chrome' | 'caliper' | 'underbody'): Color => (M.base(slot) as PhysMat).color.clone();

  // ---- geometry per (variant, LOD level)
  interface LevelGeo {
    rim: BufferGeometry | null;
    disc: BufferGeometry;
    upright: BufferGeometry | null;
    tread: BufferGeometry;
    sidewall: BufferGeometry;
    caster: BufferGeometry | null;
  }
  const keep = <G extends BufferGeometry | null>(g: G): G => {
    if (g) geoms.add(g);
    return g;
  };
  const buildLevel = (dims: WheelDims, rimDef: WheelVisualDef['rim'], tireDef: WheelVisualDef['tire'], detail: WheelDetail): LevelGeo => {
    const segs = WHEEL_SEGS[detail]!;
    const rim = buildRimGeometry(dims, def, rimDef, segs.rim, detail);
    const tyre = buildTyreGeometry(dims, tireDef, segs.tyre, detail);
    const spec = RIM_FINISHES[rimDef.finish] ?? RIM_FINISHES.silver;
    const face = new Color().setHex(spec.color);
    const rimGeo = mergePbrParts([
      { geo: rim.face, color: face, pbr: [spec.metalness, spec.roughness, spec.clearcoat] },
      { geo: rim.barrel, color: face.clone().multiplyScalar(0.55), pbr: [Math.min(1, spec.metalness), 0.5, 0] },
      { geo: rim.cap, color: new Color().setHex(0x0b0c0e), pbr: [0.4, 0.18, 1] },
      { geo: rim.nuts, color: colorOf('chrome'), pbr: [1, 0.045, 0] },
      { geo: rim.hat, color: new Color().setHex(0x2a2b2d), pbr: [0.6, 0.6, 0] },
    ]);
    const calGeo = rim.caliper.clone();
    const uprightGeo = mergePbrParts([
      { geo: calGeo, color: colorOf('caliper'), pbr: [0.05, 0.32, 1] },
      { geo: rim.shield, color: colorOf('underbody'), pbr: [0.1, 0.88, 0] },
    ]);
    calGeo.dispose();
    const caster = detail > 0 ? mergePositions([tyre.tread, tyre.sidewall, rim.face, rim.disc]) : null;
    for (const g of [rim.face, rim.barrel, rim.cap, rim.nuts, rim.hat, rim.caliper, rim.shield]) g.dispose();
    return { rim: keep(rimGeo), disc: keep(rim.disc), upright: keep(uprightGeo), tread: keep(tyre.tread), sidewall: keep(tyre.sidewall), caster: keep(caster) };
  };

  // ---- variant groups
  const groups: VariantGroup[] = [];
  const levelMeshes: Mesh[][] = [[], [], []];
  const allCasters: Mesh[] = [];
  const variants = new Map<string, { dims: WheelDims; rimDef: WheelVisualDef['rim']; tireDef: WheelVisualDef['tire']; wheels: CompiledWheel[] }>();
  for (const w of compiled.wheels) {
    const rear = w.axle === 'rear' && def.rear;
    const rimDef = rear && def.rear?.rim ? { ...def.rim, ...def.rear.rim } : def.rim;
    const tireDef = rear && def.rear?.tire ? { ...def.tire, ...def.rear.tire } : def.tire;
    const dims = wheelDims(compiled, w);
    const key = JSON.stringify([dims, rimDef, tireDef]);
    let v = variants.get(key);
    if (!v) variants.set(key, (v = { dims, rimDef, tireDef, wheels: [] }));
    v.wheels.push(w);
  }
  const wheels: WheelInstance[] = [];
  for (const v of variants.values()) {
    const n = v.wheels.length;
    const spinM = new InstancedBufferAttribute(new Float32Array(16 * n), 16);
    const uprightM = new InstancedBufferAttribute(new Float32Array(16 * n), 16);
    spinM.setUsage(DynamicDrawUsage);
    uprightM.setUsage(DynamicDrawUsage);
    const tyreU = createTyreInstanceUniforms(n);
    const patch = createTyreInstancedPatch(tyreU, n);
    // per-variant tyre materials (textures follow the tread / sidewall text)
    // groove layout of the full-detail band (the tread texture is laid out on it at every LOD)
    const probe = buildTyreGeometry(v.dims, v.tireDef, 3, 2);
    probe.tread.dispose();
    probe.sidewall.dispose();
    const treadTex = vehicleTextures.tread(v.tireDef.tread, probe.grooves, 4);
    const sideTex = vehicleTextures.sidewall(v.tireDef.sidewallText);
    const treadM = clonePhys(M.base('tire') as MeshPhysicalMaterial);
    treadM.map = treadTex.color;
    treadM.normalMap = treadTex.normal;
    treadM.normalScale.set(1, 1);
    treadM.name = 'crTread';
    const sideM = clonePhys(M.base('tire') as MeshPhysicalMaterial);
    sideM.map = sideTex.color;
    sideM.normalMap = sideTex.normal;
    sideM.normalScale.set(1, 1);
    sideM.roughness = 0.72;
    sideM.color.multiplyScalar(1 / 0.62); // the lettering map's base level is 0.62
    sideM.name = 'crSidewall';
    const treadSet = own(opts.patchMaterial(treadM, { csm, flexbody: patch }));
    const sideSet = own(opts.patchMaterial(sideM, { csm, flexbody: patch }));
    const casterSet = direct ? null : own(opts.patchMaterial(new MeshBasicMaterial({ name: 'wheelCasterColor', colorWrite: false, depthWrite: false }), { flexbody: patch }));

    const sphere = new Sphere();
    const group: VariantGroup = { wheels: [], spinM, uprightM, tyreU, levels: [], casters: [], sphere };
    const inst = (geo: BufferGeometry, mat: Material, matrices: InstancedBufferAttribute, name: string, cast: boolean, set?: { depth: Material | null; distance: Material | null }): InstancedMesh => {
      const mesh = new InstancedMesh(geo, mat, n);
      mesh.instanceMatrix = matrices;
      mesh.boundingSphere = sphere;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = name;
      if (set?.depth) mesh.customDepthMaterial = set.depth;
      if (set?.distance) mesh.customDistanceMaterial = set.distance;
      object.add(mesh);
      return mesh;
    };
    for (let level = 0; level < 3; level++) {
      const g = buildLevel(v.dims, v.rimDef, v.tireDef, level as WheelDetail);
      const list: InstancedMesh[] = [];
      if (g.rim) list.push(inst(g.rim, rimMat, spinM, `wheelRim${level}`, direct));
      list.push(inst(g.disc, discMat, spinM, `wheelDisc${level}`, direct));
      if (g.upright) list.push(inst(g.upright, uprightMat, uprightM, `wheelUpright${level}`, direct));
      list.push(inst(g.tread, treadSet.color, spinM, `wheelTread${level}`, direct, treadSet));
      list.push(inst(g.sidewall, sideSet.color, spinM, `wheelSidewall${level}`, direct, sideSet));
      for (const m of list) m.visible = level === 0;
      group.levels.push(list);
      levelMeshes[level]!.push(...list);
      if (casterSet && level > 0 && g.caster) {
        const c = inst(g.caster, casterSet.color, spinM, `wheelCaster${level}`, true, casterSet);
        c.receiveShadow = false;
        c.visible = false;
        group.casters.push(c);
        allCasters.push(c);
      } else if (g.caster) {
        geoms.delete(g.caster);
        g.caster.dispose();
      }
    }
    v.wheels.forEach((w, slot) => {
      const dims = wheelDims(compiled, w);
      const rest = wheelRest(compiled, w);
      const frame = createWheelFrame();
      solveWheelFrame(rest, compiled.rig.nodePos, 3, frame);
      const wi: WheelInstance = { rest, dims, frame, tyre: createTyreUniforms(dims, rest), slot, calRot: new Matrix4().makeRotationX(rest.caliperAngle) };
      packTyreInstance(wi.tyre, slot, tyreU);
      place(group, wi);
      group.wheels.push(wi);
      wheels.push(wi);
    });
    updateSphere(group);
    groups.push(group);
  }

  function place(g: VariantGroup, w: WheelInstance): void {
    const f = w.frame;
    _m.makeBasis(f.s, f.u, f.v).setPosition(f.centre);
    _m.toArray(g.spinM.array as Float32Array, 16 * w.slot);
    _z.crossVectors(f.s, f.up);
    _m.makeBasis(f.s, f.up, _z).setPosition(f.centre).multiply(w.calRot);
    _m.toArray(g.uprightM.array as Float32Array, 16 * w.slot);
    g.spinM.needsUpdate = true;
    g.uprightM.needsUpdate = true;
  }

  function updateSphere(g: VariantGroup): void {
    let cx = 0, cy = 0, cz = 0;
    for (const w of g.wheels) {
      cx += w.frame.centre.x;
      cy += w.frame.centre.y;
      cz += w.frame.centre.z;
    }
    const inv = g.wheels.length ? 1 / g.wheels.length : 0;
    cx *= inv;
    cy *= inv;
    cz *= inv;
    let r = 0;
    for (const w of g.wheels) {
      const d = Math.hypot(w.frame.centre.x - cx, w.frame.centre.y - cy, w.frame.centre.z - cz) + w.dims.radius + 0.1;
      if (d > r) r = d;
    }
    g.sphere.center.set(cx, cy, cz);
    g.sphere.radius = r;
  }

  let lod = 0;
  const showLevel = (level: number): void => {
    for (const g of groups) g.levels.forEach((list, l) => list.forEach((m) => (m.visible = l === level)));
  };

  const shadowClient: ShadowLodClient = {
    shadowBegin(): void {
      for (const g of groups) g.casters.forEach((c, i) => (c.visible = i === 0));
    },
    shadowCascade(index: number): void {
      for (const g of groups) {
        const want = Math.min(index === 0 ? 0 : 1, g.casters.length - 1);
        g.casters.forEach((c, i) => (c.visible = i === want));
      }
    },
    shadowEnd(): void {
      for (const c of allCasters) c.visible = false;
    },
  };
  const detach = direct ? () => {} : attachShadowLod(opts.renderer, opts.lighting, shadowClient);

  return {
    object,
    levels: levelMeshes,
    casters: allCasters,
    get lod(): number {
      return lod;
    },
    update(skin: FlexSkin, _dtS: number): void {
      // Wheel transforms are in skin space: sit where the skin root sits (sibling) or at its origin (child).
      if (object.parent !== skin.object) object.position.copy(skin.object.position);
      else object.position.set(0, 0, 0);
      const want = Math.min(2, Math.max(0, (skin as { lod?: number }).lod ?? 0));
      if (want !== lod) {
        lod = want;
        showLevel(lod);
      }
      const data = skin.nodeData;
      for (const g of groups) {
        for (const w of g.wheels) {
          if (!solveWheelFrame(w.rest, data, 4, w.frame)) continue;
          updateTyreUniforms(w.rest, w.dims, w.frame, data, 4, w.tyre);
          packTyreInstance(w.tyre, w.slot, g.tyreU);
          place(g, w);
        }
        updateSphere(g);
      }
    },
    dispose(): void {
      detach();
      object.removeFromParent();
      for (const g of geoms) g.dispose();
      for (const m of owned) m.dispose();
    },
  };
};

/** Contract check: the extended factory still satisfies CreateWheelVisuals. */
export const createWheelVisualsContract: CreateWheelVisuals = createWheelVisuals;
