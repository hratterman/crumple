/**
 * Flexbody skin (A2): node texture + the `flex1` vertex patch + one Mesh per
 * BindingPanel. Contract: ./types.ts "NODE TEXTURE" and "FLEXBODY SHADER
 * PATCH"; the CPU mirror of the GLSL below is binder.ts evalFlexFrame —
 * change both together (flexskin.test.ts checks the constants match).
 *
 * The patch goes through patchMaterial's flexbody slot, so the color,
 * depth (CSM cascades) and distance materials all reconstruct the same
 * deformed surface: shadows are cast by the DEFORMED body.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  Material,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Sphere,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { PatchTarget, ShaderPatch } from '../types';
import { FLEX_NORMAL_EPS } from './binder';
import {
  FLEX_CROSS_FLOOR,
  FLEX_GS_FLOOR,
  FLEX_MAX_SLACK,
  FLEX_MAX_STRETCH,
  FLEXBODY_PATCH_KEY,
  NODE_TEX_FLAG_BROKEN,
  NODE_TEX_WIDTH,
  type BindingPanel,
  type BindingSet,
  type FlexSkin,
  type FlexSkinOptions,
  type VehicleFrameInput,
  type Vec3T,
} from './types';

/** GLSL float literal. */
function f(x: number): string {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Declarations (vertex stage, after <common>). FLEXBODY_COLOR = color target only. */
export const FLEX_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uFlexNodes;
uniform int uFlexRows;
attribute vec3 flexTriad;
attribute vec4 flexCoef;
attribute vec3 flexNormal;
attribute float flexDamage;
#ifdef USE_TANGENT
attribute vec4 flexTangent;
#endif
#ifdef FLEXBODY_COLOR
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
#endif
vec4 flexNode( int i, int block ) {
	return texelFetch( uFlexNodes, ivec2( i & ${NODE_TEX_WIDTH - 1}, ( i >> 6 ) + block * uFlexRows ), 0 );
}
void flexLoad( out ivec3 idx, out vec3 r, out vec3 e1, out vec3 e2 ) {
	idx = ivec3( flexTriad + 0.5 );
	r = flexNode( idx.x, 0 ).xyz;
	e1 = flexNode( idx.y, 0 ).xyz - r;
	e2 = flexNode( idx.z, 0 ).xyz - r;
}
mat3 flexFrame( vec3 e1, vec3 e2 ) {
	vec3 f1 = e1 / max( length( e1 ), ${f(FLEX_GS_FLOOR)} );
	vec3 t = e2 - dot( e2, f1 ) * f1;
	vec3 f2 = t / max( length( t ), ${f(FLEX_GS_FLOOR)} );
	return mat3( f1, f2, cross( f1, f2 ) );
}
vec3 flexSafeNormalize( vec3 v ) {
	float l = length( v );
	return l > ${f(FLEX_NORMAL_EPS)} ? v / l : vec3( 0.0, 1.0, 0.0 );
}
#ifdef FLEXBODY_COLOR
vec4 flexDamageBlend( ivec3 idx ) {
	float wX = clamp( flexCoef.x, 0.0, 1.0 );
	float wY = clamp( flexCoef.y, 0.0, 1.0 );
	float wR = max( 0.0, 1.0 - wX - wY );
	vec3 d = ( wR * flexNode( idx.x, 1 ).xyz + wX * flexNode( idx.y, 1 ).xyz + wY * flexNode( idx.z, 1 ).xyz ) / ( wR + wX + wY );
	int fl = int( flexNode( idx.x, 0 ).w + 0.5 ) | int( flexNode( idx.y, 0 ).w + 0.5 ) | int( flexNode( idx.z, 0 ).w + 0.5 );
	return vec4( d * flexDamage, ( fl & ${NODE_TEX_FLAG_BROKEN} ) != 0 ? 1.0 : 0.0 );
}
#endif
`;

/** Replaces <beginnormal_vertex>: objectNormal (+ objectTangent) from the GS triad frame. */
export const FLEX_NORMAL_CHUNK = /* glsl */ `
ivec3 flexNIdx;
vec3 flexNR, flexNE1, flexNE2;
flexLoad( flexNIdx, flexNR, flexNE1, flexNE2 );
mat3 flexF = flexFrame( flexNE1, flexNE2 );
vec3 objectNormal = flexSafeNormalize( flexF * flexNormal );
#ifdef USE_TANGENT
vec3 objectTangent = flexSafeNormalize( flexF * flexTangent.xyz );
#endif
`;

/** Replaces <begin_vertex>: transformed = R + a·e1 + b·e2 + c·n̂ with the stretch/NaN clamp. */
export const FLEX_POSITION_CHUNK = /* glsl */ `
ivec3 flexIdx;
vec3 flexR, flexE1, flexE2;
flexLoad( flexIdx, flexR, flexE1, flexE2 );
vec3 flexCr = cross( flexE1, flexE2 );
vec3 transformed = flexR + flexCoef.x * flexE1 + flexCoef.y * flexE2 + flexCoef.z * ( flexCr / max( length( flexCr ), ${f(FLEX_CROSS_FLOOR)} ) );
if ( !( length( transformed - flexR ) <= ${f(FLEX_MAX_STRETCH)} * flexCoef.w + ${f(FLEX_MAX_SLACK)} ) ) transformed = flexR;
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif
#ifdef FLEXBODY_COLOR
	vFlexRest = position;
	vFlexDamage = flexDamageBlend( flexIdx );
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
#define FLEXBODY
varying vec3 vFlexRest;
varying vec4 vFlexDamage;
`;

/** Applies the flex1 edit to a program's sources (exported for tests / the e2e compile check). */
export function applyFlexGlsl(shader: { vertexShader: string; fragmentShader: string }, target: PatchTarget): void {
  const vs = shader.vertexShader;
  for (const chunk of ['#include <common>', '#include <begin_vertex>']) {
    if (!vs.includes(chunk)) throw new Error(`flexbody: vertex shader lacks ${chunk}`);
  }
  const defines = target === 'color' ? '#define FLEXBODY\n#define FLEXBODY_COLOR\n' : '#define FLEXBODY\n';
  shader.vertexShader =
    defines +
    vs
      .replace('#include <common>', `#include <common>\n${FLEX_VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', FLEX_NORMAL_CHUNK)
      .replace('#include <begin_vertex>', FLEX_POSITION_CHUNK);
  if (target === 'color') shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader;
}

/** The flex1 ShaderPatch bound to one node texture (uniform objects shared by every material of the skin). */
export function createFlexPatch(texture: DataTexture, rows: number): ShaderPatch {
  const uNodes = { value: texture };
  const uRows = { value: rows };
  return {
    key: FLEXBODY_PATCH_KEY,
    targets: ['color', 'depth', 'distance'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      shader.uniforms.uFlexNodes = uNodes;
      shader.uniforms.uFlexRows = uRows;
      applyFlexGlsl(shader, target);
    },
  };
}

/** rows per block for nodeCount nodes. */
export function nodeTextureRows(nodeCount: number): number {
  return Math.max(1, Math.ceil(nodeCount / NODE_TEX_WIDTH));
}

/** Panel geometry: rest attributes + flexbody attributes. */
export function buildPanelGeometry(p: BindingPanel): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p.restPosition, 3));
  g.setAttribute('normal', new BufferAttribute(p.restNormal, 3));
  g.setAttribute('uv', new BufferAttribute(p.uv, 2));
  g.setAttribute('flexTriad', new BufferAttribute(Float32Array.from(p.triad), 3));
  g.setAttribute('flexCoef', new BufferAttribute(p.coef, 4));
  g.setAttribute('flexNormal', new BufferAttribute(p.frameNormal, 3));
  g.setAttribute('flexDamage', new BufferAttribute(p.damageWeight, 1));
  if (p.restTangent && p.frameTangent) {
    g.setAttribute('tangent', new BufferAttribute(p.restTangent, 4));
    g.setAttribute('flexTangent', new BufferAttribute(p.frameTangent, 4));
  }
  g.setIndex(new BufferAttribute(p.index, 1));
  g.boundingSphere = new Sphere();
  return g;
}

/** Clone a base material keeping a hook + cache key the base carries as own properties (Material.copy drops them). */
export function cloneBaseMaterial<M extends Material>(base: M): M {
  const m = base.clone() as M;
  if (Object.prototype.hasOwnProperty.call(base, 'onBeforeCompile')) m.onBeforeCompile = base.onBeforeCompile;
  if (Object.prototype.hasOwnProperty.call(base, 'customProgramCacheKey')) m.customProgramCacheKey = base.customProgramCacheKey;
  return m;
}

export interface FlexSkinExtraOptions {
  /** Object-local anchor node (CompiledVehicle.frameNodes[0]); default 0. */
  anchorNode?: number;
}

/** Per-panel bounds bookkeeping. */
interface PanelBounds {
  nodes: Uint16Array;
  margin: number;
  sphere: Sphere;
}

export function createFlexSkin(binding: BindingSet, opts: FlexSkinOptions & FlexSkinExtraOptions): FlexSkin {
  const nodeCount = binding.nodeCount;
  const rows = nodeTextureRows(nodeCount);
  const nodeData = new Float32Array(NODE_TEX_WIDTH * rows * 2 * 4);
  const texture = new DataTexture(nodeData, NODE_TEX_WIDTH, rows * 2, RGBAFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.name = `flexNodes:${binding.vehicle}`;
  texture.needsUpdate = true;
  const nodeFlags = new Uint8Array(nodeCount);
  const patch = createFlexPatch(texture, rows);
  const anchorNode = Math.min(Math.max(0, opts.anchorNode ?? 0), Math.max(0, nodeCount - 1));

  const object = new Group();
  object.name = `vehicle:${binding.vehicle}`;
  const meshes: Mesh[] = [];
  const bounds: PanelBounds[] = [];
  const owned: Material[] = [];
  for (const p of binding.panels) {
    const geometry = buildPanelGeometry(p);
    const base = opts.materials.base(p.material);
    const set = opts.patchMaterial(cloneBaseMaterial(base), {
      csm: opts.lighting.csm,
      flexbody: patch,
      damage: opts.damage?.patchFor(p.panelIndex) ?? undefined,
    });
    // Panels are open shells: both faces must reach the shadow map.
    set.color.shadowSide = DoubleSide;
    const mesh = new Mesh(geometry, set.color);
    if (set.depth) mesh.customDepthMaterial = set.depth;
    if (set.distance) mesh.customDistanceMaterial = set.distance;
    mesh.castShadow = p.castShadow;
    mesh.receiveShadow = true;
    mesh.name = `panel:${p.panelId}`;
    owned.push(set.color);
    if (set.depth) owned.push(set.depth);
    if (set.distance) owned.push(set.distance);
    object.add(mesh);
    meshes.push(mesh);
    let maxD0 = 0;
    for (let v = 0; v < p.vertexCount; v++) maxD0 = Math.max(maxD0, p.coef[4 * v + 3]!);
    // A vertex sits within ~d0 of its R node (≤ 2·d0 + slack under the clamp); 1.5·d0 covers real stretch.
    const b: PanelBounds = { nodes: p.nodes, margin: 0.1 + 1.5 * maxD0, sphere: geometry.boundingSphere! };
    bounds.push(b);
    restBounds(p, b.sphere);
  }

  const anchor: [number, number, number] = [0, 0, 0];

  function update(frame: VehicleFrameInput): void {
    const src = frame.nodes;
    const base = frame.nodeOffset * 3;
    if (base + nodeCount * 3 > src.length) return;
    const ax = src[base + 3 * anchorNode]!;
    const ay = src[base + 3 * anchorNode + 1]!;
    const az = src[base + 3 * anchorNode + 2]!;
    if (!Number.isFinite(ax + ay + az)) return;
    for (let i = 0; i < nodeCount; i++) {
      const s = base + 3 * i;
      const o = 4 * i; // block A texel (i & 63, i >> 6) is linear index i
      let x = src[s]! - ax;
      let y = src[s + 1]! - ay;
      let z = src[s + 2]! - az;
      if (!Number.isFinite(x + y + z)) x = y = z = 0;
      nodeData[o] = x;
      nodeData[o + 1] = y;
      nodeData[o + 2] = z;
      nodeData[o + 3] = nodeFlags[i]!;
    }
    anchor[0] = ax;
    anchor[1] = ay;
    anchor[2] = az;
    object.position.set(ax, ay, az);
    for (const b of bounds) nodeBounds(nodeData, b);
    texture.needsUpdate = true;
  }

  return {
    object,
    meshes,
    nodeTexture: texture,
    rows,
    nodeData,
    nodeFlags,
    anchor: anchor as unknown as Vec3T,
    patch,
    update,
    setPanelVisible(panelIndex: number, visible: boolean): void {
      const m = meshes[panelIndex];
      if (m) m.visible = visible;
    },
    dispose(): void {
      object.removeFromParent();
      for (const m of meshes) m.geometry.dispose();
      for (const m of owned) m.dispose();
      texture.dispose();
    },
  };
}

function restBounds(p: BindingPanel, out: Sphere): void {
  out.center.set(p.restCenter[0], p.restCenter[1], p.restCenter[2]);
  out.radius = p.restRadius + 0.1;
}

/** Bounding sphere of a panel's nodes (skin space, AABB centre) + margin. */
function nodeBounds(data: Float32Array, b: PanelBounds): void {
  const n = b.nodes;
  if (n.length === 0) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < n.length; k++) {
    const o = 4 * n[k]!;
    const x = data[o]!, y = data[o + 1]!, z = data[o + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let k = 0; k < n.length; k++) {
    const o = 4 * n[k]!;
    const dx = data[o]! - cx, dy = data[o + 1]! - cy, dz = data[o + 2]! - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  b.sphere.center.set(cx, cy, cz);
  b.sphere.radius = Math.sqrt(r2) + b.margin;
}
