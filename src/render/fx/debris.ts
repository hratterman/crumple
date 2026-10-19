/**
 * Rigid debris chunks (contract: ./types.ts DEBRIS): one InstancedMesh per
 * shape group (chunk, flake → ≤ 2 draws), CPU ballistic integration with
 * terrain bounce (sampler, cached per metre of travel), settle (lie flat),
 * shrink-out fade; capacity = QualityPreset.debrisBudget across groups,
 * oldest recycled. Lit + CSM-receiving (patchMaterial), never casts.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';

import type { Rng } from '../../core/rng';
import { LAYER_NO_REFLECTION } from '../types';

const STRIDE = 13; // px py pz vx vy vz qx qy qz qw wx wy wz
const SLEEP_SPEED = 0.3;
const FADE_FRACTION = 0.2;

/** Irregular convex-ish chunk (jittered octahedron, flat-shaded), unit size. */
export function createChunkGeometry(rng: Rng): BufferGeometry {
  const v: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 0.7, 0], [0, -0.7, 0], [0, 0, 0.85], [0, 0, -0.85],
  ].map(([x, y, z]) => [x! * (0.75 + 0.4 * rng.float()), y! * (0.75 + 0.4 * rng.float()), z! * (0.75 + 0.4 * rng.float())]);
  const faces = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5],
  ];
  return flatGeometry(v, faces, 0.5);
}

/** Thin irregular plate (flakes, shards, splinters), unit size in XZ. */
export function createFlakeGeometry(): BufferGeometry {
  const t = 0.06;
  const ring: [number, number][] = [
    [0.0, 0.62], [-0.48, 0.2], [-0.55, -0.38], [0.05, -0.5], [0.6, -0.3], [0.45, 0.3],
  ];
  const v: [number, number, number][] = [];
  for (const [x, z] of ring) v.push([x, t, z]);
  for (const [x, z] of ring) v.push([x, -t, z]);
  const n = ring.length;
  const faces: number[][] = [];
  for (let i = 1; i < n - 1; i++) {
    faces.push([0, i + 1, i]);
    faces.push([n, n + i, n + i + 1]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, n + j]);
    faces.push([i, n + j, n + i]);
  }
  return flatGeometry(v, faces, 0.5);
}

function flatGeometry(v: readonly (readonly number[])[], faces: readonly (readonly number[])[], scale: number): BufferGeometry {
  const pos = new Float32Array(faces.length * 9);
  let o = 0;
  for (const f of faces) {
    for (const k of f) {
      const p = v[k]!;
      pos[o++] = p[0]! * scale;
      pos[o++] = p[1]! * scale;
      pos[o++] = p[2]! * scale;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class DebrisPool {
  readonly mesh: InstancedMesh;
  private cap: number;
  private st!: Float64Array;
  private age!: Float32Array;
  private life!: Float32Array;
  private scale!: Float32Array;
  private alive!: Uint8Array;
  private asleep!: Uint8Array;
  private ground!: Float64Array;
  private colors!: InstancedBufferAttribute;
  private next = 0;
  private liveN = 0;
  private dirty = false;
  groundAt: (x: number, z: number) => number;
  private readonly gravity = 9.81;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly zero = new Matrix4().makeScale(0, 0, 0);

  constructor(name: string, geometry: BufferGeometry, material: Material, capacity: number, groundAt: (x: number, z: number) => number) {
    this.cap = Math.max(1, capacity | 0);
    this.groundAt = groundAt;
    this.mesh = new InstancedMesh(geometry, material, this.cap);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER_NO_REFLECTION);
    this.allocate();
  }

  private allocate(): void {
    const n = this.cap;
    this.st = new Float64Array(n * STRIDE);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.asleep = new Uint8Array(n);
    this.ground = new Float64Array(n * 3);
    if (this.mesh.count !== n || this.mesh.instanceMatrix.count !== n) {
      this.mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(n * 16), 16);
    }
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.colors = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    this.colors.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colors;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.zero);
    this.mesh.count = 0;
    this.next = 0;
    this.liveN = 0;
  }

  get capacity(): number {
    return this.cap;
  }
  get live(): number {
    return this.liveN;
  }

  /** One chunk (recycles the oldest when full). Allocation-free. */
  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, size: number, lifeS: number, rng: Rng, r: number, g: number, b: number): void {
    const i = this.next;
    this.next = i + 1 === this.cap ? 0 : i + 1;
    if (!this.alive[i]) this.liveN++;
    this.alive[i] = 1;
    this.asleep[i] = 0;
    this.age[i] = 0;
    this.life[i] = lifeS;
    this.scale[i] = size;
    const o = i * STRIDE;
    const s = this.st;
    s[o] = px;
    s[o + 1] = py;
    s[o + 2] = pz;
    s[o + 3] = vx;
    s[o + 4] = vy;
    s[o + 5] = vz;
    let qx = rng.float() * 2 - 1;
    let qy = rng.float() * 2 - 1;
    let qz = rng.float() * 2 - 1;
    let qw = rng.float() * 2 - 1;
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
    qx /= ql;
    qy /= ql;
    qz /= ql;
    qw /= ql;
    s[o + 6] = qx;
    s[o + 7] = qy;
    s[o + 8] = qz;
    s[o + 9] = qw;
    s[o + 10] = (rng.float() * 2 - 1) * 22;
    s[o + 11] = (rng.float() * 2 - 1) * 22;
    s[o + 12] = (rng.float() * 2 - 1) * 22;
    const gc = i * 3;
    this.ground[gc] = this.groundAt(px, pz);
    this.ground[gc + 1] = px;
    this.ground[gc + 2] = pz;
    this.colors.setXYZ(i, r, g, b);
    this.colors.addUpdateRange(i * 3, 3);
    this.colors.needsUpdate = true;
    if (i + 1 > this.mesh.count) this.mesh.count = i + 1;
    this.dirty = true;
  }

  /** Integrates every live chunk (sim-scaled dt). Allocation-free. */
  update(dtS: number): void {
    if (this.liveN === 0) {
      if (this.dirty) {
        this.mesh.count = 0;
        this.dirty = false;
      }
      return;
    }
    const dt = Math.min(Math.max(dtS, 0), 0.05);
    const s = this.st;
    const drag = Math.max(0, 1 - 0.3 * dt);
    let maxAlive = 0;
    let moved = dt > 0;
    for (let i = 0, n = this.mesh.count; i < n; i++) {
      if (!this.alive[i]) continue;
      const age = (this.age[i] = this.age[i]! + dt);
      const life = this.life[i]!;
      if (age >= life) {
        this.alive[i] = 0;
        this.liveN--;
        this.mesh.setMatrixAt(i, this.zero);
        moved = true;
        continue;
      }
      maxAlive = i + 1;
      const o = i * STRIDE;
      const size = this.scale[i]!;
      if (!this.asleep[i] && dt > 0) {
        let vx = s[o + 3]! * drag;
        let vy = s[o + 4]! * drag - this.gravity * dt;
        let vz = s[o + 5]! * drag;
        const px = s[o]! + vx * dt;
        let py = s[o + 1]! + vy * dt;
        const pz = s[o + 2]! + vz * dt;
        const gc = i * 3;
        const gdx = px - this.ground[gc + 1]!;
        const gdz = pz - this.ground[gc + 2]!;
        if (gdx * gdx + gdz * gdz > 0.5) {
          this.ground[gc] = this.groundAt(px, pz);
          this.ground[gc + 1] = px;
          this.ground[gc + 2] = pz;
        }
        const gy = this.ground[gc]! + size * 0.22;
        let wx = s[o + 10]!;
        let wy = s[o + 11]!;
        let wz = s[o + 12]!;
        if (py < gy) {
          py = gy;
          if (vy < 0) vy = -vy * 0.3;
          vx *= 0.5;
          vz *= 0.5;
          wx *= 0.45;
          wy *= 0.45;
          wz *= 0.45;
          if (vx * vx + vy * vy + vz * vz < SLEEP_SPEED * SLEEP_SPEED) {
            this.asleep[i] = 1;
            vx = vy = vz = 0;
            const qy0 = s[o + 7]!;
            const qw0 = s[o + 9]!;
            const l = Math.sqrt(qy0 * qy0 + qw0 * qw0) || 1;
            s[o + 6] = 0;
            s[o + 7] = qy0 / l;
            s[o + 8] = 0;
            s[o + 9] = qw0 / l;
          }
        }
        s[o] = px;
        s[o + 1] = py;
        s[o + 2] = pz;
        s[o + 3] = vx;
        s[o + 4] = vy;
        s[o + 5] = vz;
        s[o + 10] = wx;
        s[o + 11] = wy;
        s[o + 12] = wz;
        if (!this.asleep[i]) {
          const qx = s[o + 6]!;
          const qy = s[o + 7]!;
          const qz = s[o + 8]!;
          const qw = s[o + 9]!;
          const h = 0.5 * dt;
          let nx = qx + h * (wx * qw + wy * qz - wz * qy);
          let ny = qy + h * (wy * qw + wz * qx - wx * qz);
          let nz = qz + h * (wz * qw + wx * qy - wy * qx);
          let nw = qw - h * (wx * qx + wy * qy + wz * qz);
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          nw /= l;
          s[o + 6] = nx;
          s[o + 7] = ny;
          s[o + 8] = nz;
          s[o + 9] = nw;
        }
      }
      const fadeStart = life * (1 - FADE_FRACTION);
      const k = age > fadeStart ? 1 - (age - fadeStart) / (life - fadeStart) : 1;
      const sc = size * k;
      this.v.set(s[o]!, s[o + 1]!, s[o + 2]!);
      this.q.set(s[o + 6]!, s[o + 7]!, s[o + 8]!, s[o + 9]!);
      this.s.set(sc, sc, sc);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    if (this.liveN === 0) maxAlive = 0;
    this.mesh.count = maxAlive;
    if (moved) this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = this.liveN > 0;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) {
      this.alive[i] = 0;
      this.mesh.setMatrixAt(i, this.zero);
    }
    this.liveN = 0;
    this.next = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  resize(capacity: number): void {
    const n = Math.max(1, capacity | 0);
    if (n === this.cap) return;
    this.cap = n;
    this.mesh.dispose(); // frees the old instance buffers' GPU copies
    this.allocate();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/** Shared lit debris material (instance colours; CSM patched by the caller). */
export function createDebrisMaterial(name: string, metalness: number, roughness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ name, color: 0xffffff, metalness, roughness, envMapIntensity: 1 });
}
