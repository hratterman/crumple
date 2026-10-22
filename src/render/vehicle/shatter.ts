/**
 * Glass + debris FX (A4, P4 minimal until the P5 particle system):
 *   - GLASS_CRACK_GLSL: procedural spiderweb crack overlay used by the
 *     damage patch on glass panels (radial cracks + polygonal rings around
 *     up to two impact centres, in the pane's REST plane so the web never
 *     swims while the pane flexes).
 *   - ShardPool: pooled InstancedMesh of small pieces with ballistic
 *     integration, ground bounce, settle, shrink-out. Fixed capacity: a new
 *     spawn past capacity recycles the oldest piece (bounded memory, no
 *     allocation after construction). R-CRASH: crash debris persists on the
 *     road (DEBRIS_PERSIST_S) and a piece at rest skips its matrix write.
 *   - createDamageFx: the DamageFx sink (VehicleDamage.onFx) — tempered
 *     glass bursts into a cloud of shards, laminated glass sheds a few,
 *     'hide' panels (mirrors, trim) throw debris chunks, torn beams chip paint.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Material } from 'three';

import { createRng, type Rng } from '../../core/rng';
import type { BindingSet, DamageFx, VehicleDamage, VehicleVisualDef } from './types';

// ====================================================================== crack GLSL
/**
 * Fragment-stage helpers (needs dmgHash13 / dmgNoise from the damage patch).
 * uCrackA / uCrackB: xyz = centre (REST rig-local), w = level 0..1 (0 = none).
 * uCrackU / uCrackV: orthonormal basis of the pane plane (rest space).
 * Returns crack coverage 0..1 at rest position p; px = metres per pixel (AA).
 */
export const GLASS_CRACK_GLSL = /* glsl */ `
uniform vec4 uCrackA;
uniform vec4 uCrackB;
uniform vec3 uCrackU;
uniform vec3 uCrackV;
uniform float uCrackSeed;

float dmgSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
float dmgH1(float k, float s) {
  return fract(sin(k * 127.1 + s * 311.7) * 43758.5453);
}
const float DMG_SECTORS = 17.0;
const float DMG_TAU = 6.2831853;
vec2 dmgRadial(float k, float seed, float R, out float len) {
  float kk = mod(k, DMG_SECTORS);
  float sec = DMG_TAU / DMG_SECTORS;
  float a = (kk + 0.5 + 0.95 * (dmgH1(kk, seed) - 0.5)) * sec;
  float l = dmgH1(kk + 17.0, seed);
  len = R * (0.35 + 0.65 * l);
  return vec2(cos(a), sin(a));
}
float dmgRingR(float k, float i, float seed, float R) {
  float kk = mod(k, DMG_SECTORS);
  float t = (i + 0.55 + 0.8 * (dmgH1(kk * 7.0 + i, seed + 3.0) - 0.5)) / 5.6;
  return R * pow(max(t, 0.03), 1.35);
}
float dmgCrackWeb(vec3 p, vec4 c, float seed, float px) {
  if (c.w <= 0.0) return 0.0;
  vec3 d3 = p - c.xyz;
  vec2 q = vec2(dot(d3, uCrackU), dot(d3, uCrackV));
  float level = c.w;
  float R = mix(0.12, 0.95, level);
  // organic wobble: cracks are never straight
  q += 0.009 * vec2(dmgNoise(vec3(q * 18.0, seed)) - 0.5, dmgNoise(vec3(q * 18.0, seed + 5.0)) - 0.5)
     + 0.0025 * vec2(dmgNoise(vec3(q * 90.0, seed + 2.0)) - 0.5, dmgNoise(vec3(q * 90.0, seed + 7.0)) - 0.5);
  float r = length(q);
  if (r > R * 1.05) return 0.0;
  float sec = DMG_TAU / DMG_SECTORS;
  float th = atan(q.y, q.x);
  if (th < 0.0) th += DMG_TAU;
  float k0 = floor(th / sec);
  float d = 1e3;
  float dr = 1e3;
  for (int j = -2; j <= 1; j++) {
    float k = k0 + float(j);
    float l0;
    float l1;
    vec2 a0 = dmgRadial(k, seed, R, l0);
    vec2 a1 = dmgRadial(k + 1.0, seed, R, l1);
    d = min(d, dmgSeg(q, vec2(0.0), a0 * l0));
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float r0 = dmgRingR(k, fi, seed, R);
      float r1 = dmgRingR(k + 1.0, fi, seed, R);
      if (r0 > l0 || r1 > l1) continue;
      if (dmgH1(mod(k, DMG_SECTORS) * 3.0 + fi * 11.0, seed + 9.0) < 0.3) continue;
      dr = min(dr, dmgSeg(q, a0 * r0, a1 * r1));
    }
  }
  float fade = 1.0 - smoothstep(0.7 * R, R, r);
  float w = (0.00022 + 0.0006 * (1.0 - r / R)) + px * 0.45;
  float lines = 1.0 - smoothstep(w * 0.5, w * 1.5, d);
  float rings = (1.0 - smoothstep(w * 0.35, w * 1.1, dr)) * 0.7;
  // crushed impact core: frosted, densely crazed
  float rc = 0.012 + 0.03 * level;
  float core = (1.0 - smoothstep(rc * 0.35, rc, r)) * (0.55 + 0.45 * dmgNoise(vec3(q * 380.0, seed)));
  return clamp(max(max(lines, rings) * mix(0.55, 1.0, fade), core), 0.0, 1.0);
}
float dmgCrack(vec3 p, float px) {
  return max(dmgCrackWeb(p, uCrackA, uCrackSeed, px), dmgCrackWeb(p, uCrackB, uCrackSeed + 13.0, px));
}
`;

// ====================================================================== shard pool
export interface ShardPoolOptions {
  capacity: number;
  geometry: BufferGeometry;
  material: Material;
  /** Gravity, m/s² (positive down). */
  gravity?: number;
  /** Ground height query; default y = 0. */
  groundAt?: ((x: number, z: number) => number) | null;
}

/** Thin irregular triangle prism, unit size in XZ, `thick` in Y (flat side down). */
export function createShardGeometry(thick = 0.08): BufferGeometry {
  const t = thick / 2;
  const a = [0.0, 0.62];
  const b = [-0.55, -0.38];
  const c = [0.6, -0.3];
  const tri = [a, b, c];
  const pos: number[] = [];
  const push = (p: number[], y: number): void => {
    pos.push(p[0]!, y, p[1]!);
  };
  // top (+Y, CCW seen from above) and bottom
  push(a, t);
  push(c, t);
  push(b, t);
  push(a, -t);
  push(b, -t);
  push(c, -t);
  // sides
  for (let i = 0; i < 3; i++) {
    const p = tri[i]!;
    const q = tri[(i + 1) % 3]!;
    push(p, t);
    push(p, -t);
    push(q, -t);
    push(p, t);
    push(q, -t);
    push(q, t);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/** Small chunky debris piece (irregular box), unit size. */
export function createChunkGeometry(): BufferGeometry {
  const g = createShardGeometry(0.35);
  return g;
}

const SLEEP_SPEED = 0.35;
const FADE_FRACTION = 0.25;
/**
 * R-CRASH persistent debris: glass crumbs, trim pieces and paint chips stay on the road where they landed
 * (a real crash scene keeps them until it is swept), recycled oldest-first by the pool's capacity; 10 min
 * then a fade. A glint from a fresh crack still fades in seconds.
 */
export const DEBRIS_PERSIST_S = 600;

export class ShardPool {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  private readonly st: Float64Array; // per piece: px py pz vx vy vz qx qy qz qw wx wy wz
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly scale: Float32Array;
  private readonly alive: Uint8Array;
  private readonly asleep: Uint8Array;
  /** 1 = at rest and its matrix already written (skipped until it fades). */
  private readonly placed: Uint8Array;
  /** Cached ground height + where it was sampled (re-sampled after 1 m of travel: few boxed calls). */
  private readonly ground: Float64Array;
  private readonly colors: InstancedBufferAttribute;
  private next = 0;
  private _live = 0;
  private dirty = false;
  private readonly gravity: number;
  groundAt: ((x: number, z: number) => number) | null;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly zero = new Matrix4().makeScale(0, 0, 0);

  constructor(opts: ShardPoolOptions) {
    const n = opts.capacity;
    this.capacity = n;
    this.gravity = opts.gravity ?? 9.81;
    this.groundAt = opts.groundAt ?? null;
    this.st = new Float64Array(n * 13);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.asleep = new Uint8Array(n);
    this.placed = new Uint8Array(n);
    this.ground = new Float64Array(n * 3);
    this.mesh = new InstancedMesh(opts.geometry, opts.material, n);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.colors = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    this.colors.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colors;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.zero);
  }

  get live(): number {
    return this._live;
  }

  /** Spawn one piece (recycles the oldest slot when full). No allocation. */
  spawn(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    lifeS: number,
    rng: Rng,
    r = 1,
    g = 1,
    b = 1,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (!this.alive[i]) this._live++;
    this.alive[i] = 1;
    this.asleep[i] = 0;
    this.placed[i] = 0;
    this.age[i] = 0;
    this.life[i] = lifeS;
    this.scale[i] = size;
    const o = i * 13;
    const s = this.st;
    s[o] = px;
    s[o + 1] = py;
    s[o + 2] = pz;
    s[o + 3] = vx;
    s[o + 4] = vy;
    s[o + 5] = vz;
    // random orientation (uniform-ish), random spin up to ~25 rad/s
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
    s[o + 10] = (rng.float() * 2 - 1) * 25;
    s[o + 11] = (rng.float() * 2 - 1) * 25;
    s[o + 12] = (rng.float() * 2 - 1) * 25;
    const gc = i * 3;
    this.ground[gc] = this.groundAt ? this.groundAt(px, pz) : 0;
    this.ground[gc + 1] = px;
    this.ground[gc + 2] = pz;
    this.colors.setXYZ(i, r, g, b);
    this.colors.needsUpdate = true;
    if (i + 1 > this.mesh.count) this.mesh.count = i + 1;
    this.dirty = true;
  }

  /** Integrate every live piece. Allocation-free. */
  update(dtS: number): void {
    if (this._live === 0) {
      if (this.dirty) {
        this.mesh.count = 0;
        this.dirty = false;
      }
      return;
    }
    const dt = Math.min(Math.max(dtS, 0), 0.05);
    const s = this.st;
    const drag = Math.max(0, 1 - 0.25 * dt);
    const ground = this.groundAt;
    let maxAlive = 0;
    for (let i = 0, n = this.mesh.count; i < n; i++) {
      if (!this.alive[i]) continue;
      const age = (this.age[i] = this.age[i]! + dt);
      const life = this.life[i]!;
      if (age >= life) {
        this.alive[i] = 0;
        this._live--;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      maxAlive = i + 1;
      const o = i * 13;
      const size = this.scale[i]!;
      if (!this.asleep[i]) {
        let vx = s[o + 3]! * drag;
        let vy = s[o + 4]! * drag - this.gravity * dt;
        let vz = s[o + 5]! * drag;
        let px = s[o]! + vx * dt;
        let py = s[o + 1]! + vy * dt;
        let pz = s[o + 2]! + vz * dt;
        const gc = i * 3;
        const gdx = px - this.ground[gc + 1]!;
        const gdz = pz - this.ground[gc + 2]!;
        if (ground && gdx * gdx + gdz * gdz > 1) {
          this.ground[gc] = ground(px, pz);
          this.ground[gc + 1] = px;
          this.ground[gc + 2] = pz;
        }
        const gy = this.ground[gc]! + size * 0.04;
        let wx = s[o + 10]!;
        let wy = s[o + 11]!;
        let wz = s[o + 12]!;
        if (py < gy) {
          py = gy;
          if (vy < 0) vy = -vy * 0.28;
          vx *= 0.55;
          vz *= 0.55;
          wx *= 0.5;
          wy *= 0.5;
          wz *= 0.5;
          if (vx * vx + vy * vy + vz * vz < SLEEP_SPEED * SLEEP_SPEED) {
            this.asleep[i] = 1;
            vx = vy = vz = 0;
            // lie flat: keep only the yaw part of the orientation
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
          // q += 0.5·(ω ⊗ q)·dt, renormalized
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
      // a piece at rest keeps its matrix until it starts to fade (persistent debris: most of the pool)
      if (this.asleep[i] && age <= fadeStart && this.placed[i]) continue;
      this.placed[i] = this.asleep[i]!;
      const k = age > fadeStart ? 1 - (age - fadeStart) / (life - fadeStart) : 1;
      const sc = size * k;
      this.v.set(s[o]!, s[o + 1]!, s[o + 2]!);
      this.q.set(s[o + 6]!, s[o + 7]!, s[o + 8]!, s[o + 9]!);
      this.s.set(sc, sc, sc);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    if (this._live === 0) maxAlive = 0;
    this.mesh.count = maxAlive;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = this._live > 0;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.alive[i] = 0;
      this.mesh.setMatrixAt(i, this.zero);
    }
    this._live = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

// ====================================================================== damage FX sink
export interface DamageFxOptions {
  binding: BindingSet;
  def: VehicleVisualDef;
  /** When given, `damage.onFx` is set to this system's sink. */
  damage?: VehicleDamage | null;
  /** World velocity of the vehicle (shards inherit it), default zero. */
  velocity?: (out: Float64Array) => void;
  groundAt?: ((x: number, z: number) => number) | null;
  /** Glass shard pool size (default 1500), debris pool size (default 320). */
  glassCapacity?: number;
  debrisCapacity?: number;
  seed?: number;
}

export interface DamageFxSystem {
  /** Add to the scene (world space). */
  readonly object: Group;
  readonly sink: (fx: DamageFx) => void;
  readonly glass: ShardPool;
  readonly debris: ShardPool;
  update(dtS: number): void;
  clear(): void;
  dispose(): void;
}

/**
 * The P4 DamageFx sink: pooled glass shards + debris. Call update(dt) every
 * frame (allocation-free); spawning happens in the sink (event-driven).
 */
export function createDamageFx(opts: DamageFxOptions): DamageFxSystem {
  const rng = createRng(opts.seed ?? 0x5ba77e2);
  const glassMat = new MeshStandardMaterial({
    name: 'glassShard',
    color: 0xd8efe9,
    roughness: 0.04,
    metalness: 0.85,
    envMapIntensity: 1.6,
    transparent: false,
  });
  const debrisMat = new MeshStandardMaterial({ name: 'debrisChunk', color: 0xffffff, roughness: 0.55, metalness: 0.2 });
  const glass = new ShardPool({
    capacity: opts.glassCapacity ?? 1500,
    geometry: createShardGeometry(),
    material: glassMat,
    groundAt: opts.groundAt ?? null,
  });
  const debris = new ShardPool({
    capacity: opts.debrisCapacity ?? 320,
    geometry: createChunkGeometry(),
    material: debrisMat,
    groundAt: opts.groundAt ?? null,
  });
  glass.mesh.name = 'glassShards';
  debris.mesh.name = 'debris';
  const object = new Group();
  object.name = 'damageFx';
  object.add(glass.mesh, debris.mesh);

  const paint = new Color().setHex(opts.def.paint.color);
  const vel = new Float64Array(3);
  const binding = opts.binding;

  const sink = (fx: DamageFx): void => {
    vel[0] = vel[1] = vel[2] = 0;
    opts.velocity?.(vel);
    switch (fx.type) {
      case 'glassShatter': {
        const panel = binding.panels[fx.panelIndex];
        const radius = panel ? Math.max(0.15, panel.restRadius * 0.75) : 0.4;
        const count = fx.laminated ? 40 : Math.min(420, Math.max(80, Math.round(420 * radius * radius)));
        burstDisc(glass, rng, fx.pos, fx.normal, radius, count, vel, fx.laminated ? 0.6 : 1.8, 0.006, 0.022, DEBRIS_PERSIST_S);
        break;
      }
      case 'panelDetach': {
        if (fx.mode !== 'hide') {
          // a follow panel keeps skinning to its own nodes; just shed some paint
          for (let k = 0; k < 10; k++) chip(debris, rng, fx.pos, vel, 0.5, 0.012, 0.03, paint.r, paint.g, paint.b);
          break;
        }
        for (let k = 0; k < 14; k++) chip(debris, rng, fx.pos, vel, 1.6, 0.02, 0.06, 0.03, 0.03, 0.035);
        break;
      }
      case 'beamBreak': {
        // paint/primer chips where metal tears
        const n = 1 + Math.floor(rng.float() * 2);
        for (let k = 0; k < n; k++) {
          const primer = rng.float() < 0.3;
          chip(
            debris,
            rng,
            fx.pos,
            vel,
            1.2,
            0.006,
            0.016,
            primer ? 0.3 : paint.r,
            primer ? 0.31 : paint.g,
            primer ? 0.3 : paint.b,
          );
        }
        break;
      }
      case 'glassCrack':
        // a few glints fall out of a fresh crack
        burstDisc(glass, rng, fx.pos, null, 0.05, 6, vel, 0.4, 0.003, 0.008, 5);
        break;
    }
  };
  if (opts.damage) opts.damage.onFx = sink;

  return {
    object,
    sink,
    glass,
    debris,
    update(dtS: number): void {
      glass.update(dtS);
      debris.update(dtS);
    },
    clear(): void {
      glass.clear();
      debris.clear();
    },
    dispose(): void {
      if (opts.damage && opts.damage.onFx === sink) opts.damage.onFx = null;
      glass.mesh.geometry.dispose();
      debris.mesh.geometry.dispose();
      glassMat.dispose();
      debrisMat.dispose();
      glass.dispose();
      debris.dispose();
      object.removeFromParent();
    },
  };
}

/** Pieces spread over a disc (perpendicular to `normal`, or a sphere when null), flung along ±normal. */
function burstDisc(
  pool: ShardPool,
  rng: Rng,
  pos: readonly number[],
  normal: readonly number[] | null,
  radius: number,
  count: number,
  vel: Float64Array,
  speed: number,
  sizeMin: number,
  sizeMax: number,
  lifeS: number,
): void {
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (normal) {
    nx = normal[0]!;
    ny = normal[1]!;
    nz = normal[2]!;
  }
  // basis (u, w) ⟂ n
  let ux = ny * 0 - nz * 1;
  let uy = 0;
  let uz = nx * 1 - ny * 0;
  if (ux * ux + uz * uz < 1e-6) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = ny * uz - nz * uy;
  const wy = nz * ux - nx * uz;
  const wz = nx * uy - ny * ux;
  for (let k = 0; k < count; k++) {
    const a = rng.float() * Math.PI * 2;
    const r = Math.sqrt(rng.float()) * radius;
    const ca = Math.cos(a) * r;
    const sa = Math.sin(a) * r;
    const off = normal ? 0 : (rng.float() * 2 - 1) * radius;
    const px = pos[0]! + ux * ca + wx * sa + nx * off;
    const py = pos[1]! + uy * ca + wy * sa + ny * off;
    const pz = pos[2]! + uz * ca + wz * sa + nz * off;
    // mostly inward (glass falls into the cabin and out of the frame both ways), plus scatter
    const side = rng.float() < 0.65 ? 1 : -1;
    const sp = speed * (0.3 + rng.float());
    const vx = vel[0]! * (0.7 + 0.3 * rng.float()) + nx * sp * side + (rng.float() * 2 - 1) * speed * 0.6;
    const vy = vel[1]! + ny * sp * side + rng.float() * speed * 0.8;
    const vz = vel[2]! * (0.7 + 0.3 * rng.float()) + nz * sp * side + (rng.float() * 2 - 1) * speed * 0.6;
    const size = sizeMin + (sizeMax - sizeMin) * rng.float() * rng.float();
    const tint = 0.85 + 0.15 * rng.float();
    pool.spawn(px, py, pz, vx, vy, vz, size, lifeS * (0.7 + 0.6 * rng.float()), rng, tint, tint, tint);
  }
}

function chip(
  pool: ShardPool,
  rng: Rng,
  pos: readonly number[],
  vel: Float64Array,
  speed: number,
  sizeMin: number,
  sizeMax: number,
  r: number,
  g: number,
  b: number,
): void {
  const vx = vel[0]! * 0.8 + (rng.float() * 2 - 1) * speed;
  const vy = vel[1]! + rng.float() * speed;
  const vz = vel[2]! * 0.8 + (rng.float() * 2 - 1) * speed;
  const size = sizeMin + (sizeMax - sizeMin) * rng.float();
  pool.spawn(pos[0]!, pos[1]!, pos[2]!, vx, vy, vz, size, DEBRIS_PERSIST_S * (0.9 + 0.2 * rng.float()), rng, r, g, b);
}
