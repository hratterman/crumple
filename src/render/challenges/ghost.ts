/**
 * Ghost car (P8-C): the personal-best run played back as a translucent
 * hologram. The body is the vehicle's own flexbody binding baked rigid at
 * its rest nodes (render/traffic/bake.ts bakeGhostBody, coarse LOD), plus
 * simple wheel discs, drawn in ONE additive draw with a fresnel rim and
 * moving scanlines; no shadows, no depth write. Posed by the recorded
 * frame-origin pose (types.ts GhostTrack).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import { bakeGhostBody } from '../traffic/bake';
import type { BindingSet } from '../vehicle/types';

export interface GhostCar {
  readonly object: Object3D;
  /** Frame-origin world position + chassis quaternion [x, y, z, w]. */
  setPose(pos: ArrayLike<number>, quat: ArrayLike<number>): void;
  setVisible(v: boolean): void;
  /** Fade (0..1), e.g. when the player is right on top of it. */
  setOpacity(o: number): void;
  update(timeS: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRim;
uniform float uTime;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.2);
  float scan = 0.82 + 0.18 * sin(vY * 38.0 - uTime * 7.0);
  vec3 c = (uColor * (0.22 + 0.35 * f) + uRim * rim * 1.6) * scan;
  gl_FragColor = vec4(c * uOpacity, 1.0);
}`;

export function createGhostCar(compiled: CompiledVehicle, binding: BindingSet): GhostCar {
  const rest = compiled.rig.nodePos;
  const body = bakeGhostBody(binding, rest);
  const parts: BufferGeometry[] = [stripTo(body)];
  for (const w of compiled.wheels) {
    const a = w.hubI;
    const b = w.hubO;
    const ax = rest[3 * a]!;
    const ay = rest[3 * a + 1]!;
    const az = rest[3 * a + 2]!;
    const bx = rest[3 * b]!;
    const by = rest[3 * b + 1]!;
    const bz = rest[3 * b + 2]!;
    const len = Math.max(0.12, Math.hypot(bx - ax, by - ay, bz - az) + 0.08);
    const c = new CylinderGeometry(w.radius, w.radius, len, 20, 1, false);
    c.rotateZ(Math.PI / 2);
    c.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    parts.push(stripTo(c));
    c.dispose();
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  body.dispose();
  geo.computeBoundingSphere();
  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uColor: { value: new Color(0.35, 0.75, 1.0) },
      uRim: { value: new Color(0.7, 0.95, 1.0) },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'challenge-ghost';
  mesh.renderOrder = 6;
  mesh.frustumCulled = true;
  const o = compiled.frameNodes[0] ?? 0;
  const originRest = new Vector3(rest[3 * o]!, rest[3 * o + 1]!, rest[3 * o + 2]!);
  const q = new Quaternion();
  const off = new Vector3();
  return {
    object: mesh,
    setPose(pos, quat) {
      q.set(quat[0]!, quat[1]!, quat[2]!, quat[3]!);
      off.copy(originRest).applyQuaternion(q);
      mesh.position.set(pos[0]! - off.x, pos[1]! - off.y, pos[2]! - off.z);
      mesh.quaternion.copy(q);
    },
    setVisible(v) {
      mesh.visible = v;
    },
    setOpacity(v) {
      mat.uniforms.uOpacity!.value = v;
    },
    update(t) {
      mat.uniforms.uTime!.value = t;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}

/** position + normal only, non-indexed (merge-compatible). */
function stripTo(g: BufferGeometry): BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(src.getAttribute('position').array), 3));
  const n = src.getAttribute('normal');
  out.setAttribute('normal', n ? new BufferAttribute(new Float32Array(n.array), 3) : new BufferAttribute(new Float32Array(src.getAttribute('position').count * 3), 3));
  if (src !== g) src.dispose();
  return out;
}
