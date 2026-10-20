/**
 * Skidmarks (contract: ./types.ts SKIDMARKS): one draw over a capped ring of
 * quad SEGMENTS. Each segment's start edge is the previous segment's end
 * edge (continuous ribbons per wheel); vertices sit on the visual surface +
 * FX_SKID_LIFT_M (computed by the caller), polygonOffset FX_SKID_POLYGON_OFFSET.
 *
 * Shading is MULTIPLICATIVE (dst × src.rgb): the mark darkens (rubber, ruts)
 * or lightens (metal scrapes) whatever lit, shadowed asphalt is underneath,
 * so it needs no lighting or shadow lookups of its own. A rubber mark's
 * multiplier rises above 1 toward the sun's mirror direction (polished
 * rubber sheen). Coverage fades with age (FX_SKID_FADE_S) and distance.
 */
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  OneFactor,
  ShaderMaterial,
  SrcColorFactor,
  Vector3,
  ZeroFactor,
} from 'three';

import { LAYER_NO_REFLECTION } from '../types';
import { FX_SKID_FADE_S, FX_SKID_POLYGON_OFFSET } from './types';

/** Floats per segment in each attribute. */
const POS_F = 12; // 4 vertices × xyz
const MARK_F = 16; // 4 × (u, along m, strength, birth)
const TINT_F = 16; // 4 × (r, g, b, sheen)

const SKID_VERTEX = /* glsl */ `
attribute vec4 aMark;
attribute vec4 aTint;
varying vec4 vMark;
varying vec4 vTint;
varying vec3 vWorld;
void main() {
  vMark = aMark;
  vTint = aTint;
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
}
`;

const SKID_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform vec3 uSunDir;
varying vec4 vMark;
varying vec4 vTint;
varying vec3 vWorld;
float skHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float skNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( skHash( i ), skHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( skHash( i + vec2( 0.0, 1.0 ) ), skHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
  float u = vMark.x;
  float along = vMark.y;
  float age = uTime - vMark.w;
  // P7 replay: a mark born after the presented time is not there yet
  float fade = ( 1.0 - smoothstep( uFade * 0.3, uFade, age ) ) * step( -1e-3, age );
  float edge = 1.0 - smoothstep( 0.72, 1.0, abs( u ) );
  // tread striations along the travel direction + patchy rubber transfer
  float grooves = 0.88 + 0.12 * sin( u * 19.0 + 1.3 );
  float patchy = 0.8 + 0.3 * skNoise( vec2( along * 1.3, u * 1.2 + vMark.w * 0.37 ) ) + 0.1 * ( skNoise( vec2( along * 9.0, u * 6.0 ) ) - 0.5 );
  float cov = clamp( vMark.z * fade * edge * grooves * patchy, 0.0, 1.0 );
  vec3 m = mix( vec3( 1.0 ), vTint.rgb, cov );
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 H = normalize( V + uSunDir );
  m += cov * vTint.a * pow( max( H.y, 0.0 ), 48.0 ) * vec3( 1.3, 1.2, 1.05 );
  float dist = length( cameraPosition - vWorld );
  m = mix( m, vec3( 1.0 ), smoothstep( 140.0, 240.0, dist ) );
  gl_FragColor = vec4( m, 1.0 );
}
`;

export interface SkidVertex {
  x: number;
  y: number;
  z: number;
}

export class SkidLayer {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private cap: number;
  private pos!: Float32Array;
  private mark!: Float32Array;
  private tint!: Float32Array;
  private posAttr!: BufferAttribute;
  private markAttr!: BufferAttribute;
  private tintAttr!: BufferAttribute;
  private next = 0;
  private used = 0;
  /** P7 replay: no new segments while frozen (the shader hides marks born after uTime). */
  frozen = false;
  private dirtyStart = -1;
  private dirtyCount = 0;
  private readonly ranges: { start: number; count: number }[][] = [0, 1, 2].map(() => [
    { start: 0, count: 0 },
    { start: 0, count: 0 },
  ]);
  /** Birth time per segment, for the live count. */
  private births!: Float32Array;

  constructor(capacity: number) {
    this.cap = Math.max(1, capacity | 0);
    const g = new BufferGeometry();
    const material = new ShaderMaterial({
      name: 'fx.skid',
      vertexShader: SKID_VERTEX,
      fragmentShader: SKID_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: FX_SKID_FADE_S },
        uSunDir: { value: new Vector3(0.3, 0.4, 0.6).normalize() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      // strips run either way round (winding follows the travel direction)
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: FX_SKID_POLYGON_OFFSET[0],
      polygonOffsetUnits: FX_SKID_POLYGON_OFFSET[1],
    });
    material.blending = CustomBlending;
    material.blendEquation = AddEquation;
    material.blendSrc = ZeroFactor;
    material.blendDst = SrcColorFactor;
    material.blendEquationAlpha = AddEquation;
    material.blendSrcAlpha = ZeroFactor;
    material.blendDstAlpha = OneFactor;
    this.mesh = new Mesh(g, material);
    this.mesh.name = 'fx.skidmarks';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = -20;
    this.mesh.layers.set(LAYER_NO_REFLECTION);
    this.mesh.matrixAutoUpdate = false;
    this.allocate();
  }

  private allocate(): void {
    const n = this.cap;
    const g = this.mesh.geometry;
    this.pos = new Float32Array(n * POS_F);
    this.mark = new Float32Array(n * MARK_F);
    this.tint = new Float32Array(n * TINT_F);
    this.births = new Float32Array(n).fill(-1e9);
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.markAttr = new BufferAttribute(this.mark, 4).setUsage(DynamicDrawUsage);
    this.tintAttr = new BufferAttribute(this.tint, 4).setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aMark', this.markAttr);
    g.setAttribute('aTint', this.tintAttr);
    const idx = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      const o = i * 6;
      // v0 = start-left, v1 = start-right, v2 = end-right, v3 = end-left
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v;
      idx[o + 4] = v + 2;
      idx[o + 5] = v + 3;
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.next = 0;
    this.used = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
  }

  get capacity(): number {
    return this.cap;
  }

  /**
   * One quad: start edge (l0, r0) → end edge (l1, r1); along = arc metres
   * at start/end (texture continuity), s0/s1 = coverage, tint = multiplier
   * (rgb) + sheen. Recycles the oldest segment when full. Allocation-free.
   */
  add(
    l0x: number, l0y: number, l0z: number, r0x: number, r0y: number, r0z: number,
    l1x: number, l1y: number, l1z: number, r1x: number, r1y: number, r1z: number,
    along0: number, along1: number, s0: number, s1: number, birth: number,
    tr: number, tg: number, tb: number, sheen: number,
  ): void {
    if (this.frozen) return;
    const i = this.next;
    this.next = i + 1 === this.cap ? 0 : i + 1;
    if (this.used < this.cap && i + 1 > this.used) this.used = i + 1;
    const p = this.pos;
    let o = i * POS_F;
    p[o] = l0x; p[o + 1] = l0y; p[o + 2] = l0z;
    p[o + 3] = r0x; p[o + 4] = r0y; p[o + 5] = r0z;
    p[o + 6] = r1x; p[o + 7] = r1y; p[o + 8] = r1z;
    p[o + 9] = l1x; p[o + 10] = l1y; p[o + 11] = l1z;
    const m = this.mark;
    o = i * MARK_F;
    m[o] = -1; m[o + 1] = along0; m[o + 2] = s0; m[o + 3] = birth;
    m[o + 4] = 1; m[o + 5] = along0; m[o + 6] = s0; m[o + 7] = birth;
    m[o + 8] = 1; m[o + 9] = along1; m[o + 10] = s1; m[o + 11] = birth;
    m[o + 12] = -1; m[o + 13] = along1; m[o + 14] = s1; m[o + 15] = birth;
    const t = this.tint;
    o = i * TINT_F;
    for (let k = 0; k < 4; k++) {
      t[o + k * 4] = tr;
      t[o + k * 4 + 1] = tg;
      t[o + k * 4 + 2] = tb;
      t[o + k * 4 + 3] = sheen;
    }
    this.births[i] = birth;
    if (this.dirtyStart < 0) {
      this.dirtyStart = i;
      this.dirtyCount = 1;
    } else if (this.dirtyCount < this.cap) this.dirtyCount++;
  }

  flush(time: number, sunDir: Vector3): void {
    const u = this.mesh.material.uniforms;
    (u.uTime as { value: number }).value = time;
    (u.uSunDir as { value: Vector3 }).value.copy(sunDir);
    this.mesh.geometry.setDrawRange(0, this.used * 6);
    if (this.dirtyStart < 0) return;
    this.upload(this.posAttr, POS_F, 0);
    this.upload(this.markAttr, MARK_F, 1);
    this.upload(this.tintAttr, TINT_F, 2);
    this.dirtyStart = -1;
    this.dirtyCount = 0;
  }

  private upload(attr: BufferAttribute, F: number, a: number): void {
    const ra = this.ranges[a]![0]!;
    const rb = this.ranges[a]![1]!;
    if (this.dirtyCount >= this.cap) {
      ra.start = 0;
      ra.count = this.cap * F;
      attr.updateRanges.push(ra);
    } else {
      const end = this.dirtyStart + this.dirtyCount;
      if (end <= this.cap) {
        ra.start = this.dirtyStart * F;
        ra.count = this.dirtyCount * F;
        attr.updateRanges.push(ra);
      } else {
        ra.start = this.dirtyStart * F;
        ra.count = (this.cap - this.dirtyStart) * F;
        rb.start = 0;
        rb.count = (end - this.cap) * F;
        attr.updateRanges.push(ra, rb);
      }
    }
    attr.needsUpdate = true;
  }

  /** Segments still visible at `time` (not yet fully faded). */
  live(time: number): number {
    let n = 0;
    for (let i = 0; i < this.used; i++) if (time - this.births[i]! < FX_SKID_FADE_S) n++;
    return n;
  }

  /** Segments ever written (draw range). */
  get drawn(): number {
    return this.used;
  }

  clear(): void {
    this.pos.fill(0);
    this.mark.fill(0);
    this.births.fill(-1e9);
    this.next = 0;
    this.used = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  resize(capacity: number): void {
    const n = Math.max(1, capacity | 0);
    if (n === this.cap) return;
    this.cap = n;
    this.mesh.geometry.dispose();
    this.allocate();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
