/**
 * Static-collider visuals (P4, A5): the crash-test arena furniture drawn
 * from the SAME resolved colliders the worker collides with
 * (src/world/colliders.ts `resolveColliders`), so what you see is what you
 * hit:
 *   wall    cast-concrete barrier: formwork panels + tie holes, hazard
 *           band on both long faces, a crash-test target on the local +Z face.
 *   pole    galvanized steel post, black/yellow sleeve, base plate + cap.
 *   ramp    concrete wedge with a grooved deck, steel lip angle and a
 *           painted lip line.
 *   jersey  New-Jersey profile barrier (narrower at the top than its box
 *           collider), weathered concrete with a reflector.
 *   block / plate / sphere: plain concrete / steel.
 * Every lit material goes through patchMaterial({csm}) (CSM shadows).
 * Textures are procedural, tileable DataTextures (no DOM, deterministic).
 * Geometry UVs are in metres; each texture's repeat sets its tile size.
 */
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CylinderGeometry,
  DataTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  type Camera,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from '../../core/rng';
import { CONTENT_VISUALS, colliderVisual } from '../../world/colliders';
import type { ResolvedCollider } from '../../world/types';
import type { LightingStack, PatchMaterial, QualityPreset, RenderContext } from '../types';

export interface ColliderRendererOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}

export interface ColliderRenderer {
  readonly object: Object3D;
  /** Static meshes: nothing per frame (kept for the renderer family's shape). */
  update(camera: Camera): void;
  setQuality(q: QualityPreset): void;
  dispose(): void;
}

// ====================================================================== procedural textures
const TEX = 256;

/** Tileable value noise: lattice of `period` cells wrapping over [0, 1). */
export function periodicNoise(seed: number, period: number): (u: number, v: number) => number {
  const rng = createRng(seed);
  const lat = new Float32Array(period * period);
  for (let i = 0; i < lat.length; i++) lat[i] = rng.float() * 2 - 1;
  const at = (i: number, j: number): number => lat[((j % period) + period) % period * period + (((i % period) + period) % period)]!;
  return (u, v) => {
    const x = u * period;
    const y = v * period;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

export function tileableFbm(seed: number, base: number, octaves: number): (u: number, v: number) => number {
  const layers = Array.from({ length: octaves }, (_, k) => periodicNoise(seed + k * 101, base << k));
  return (u, v) => {
    let s = 0;
    let amp = 1;
    let norm = 0;
    for (const n of layers) {
      s += amp * n(u, v);
      norm += amp;
      amp *= 0.5;
    }
    return s / norm;
  };
}

export function makeTexture(data: Uint8Array, size: number, srgb: boolean, repeatU: number, repeatV: number): DataTexture {
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.repeat.set(repeatU, repeatV);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Height field (0..1) → tangent-space normal map (tileable central differences). */
export function normalFromHeight(h: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const H = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.sqrt(dx * dx + dy * dy + 1);
      const o = 4 * (y * size + x);
      out[o] = Math.round((0.5 - (0.5 * dx) / l) * 255);
      out[o + 1] = Math.round((0.5 - (0.5 * dy) / l) * 255);
      out[o + 2] = Math.round((0.5 + 0.5 / l) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

export interface ConcreteStyle {
  seed: number;
  /** Base linear-ish grey (sRGB byte). */
  tone: number;
  /** Warm tint (sRGB byte offsets r, g, b). */
  tint: [number, number, number];
  /** Formwork: panel seams on the tile edges + tie holes. */
  formwork?: boolean;
  /** Grooves across v (anti-slip deck): count per tile. */
  grooves?: number;
  /** Water/rust streak strength (vertical, along −v). */
  streaks?: number;
}

/** Concrete albedo (sRGB) + normal map, one tile. */
export function concreteTextures(style: ConcreteStyle): { albedo: Uint8Array; normal: Uint8Array } {
  const fine = tileableFbm(style.seed, 16, 4);
  const coarse = tileableFbm(style.seed + 7, 4, 3);
  const streakN = periodicNoise(style.seed + 13, 24);
  const rng = createRng(style.seed + 99);
  const height = new Float32Array(TEX * TEX);
  const albedo = new Uint8Array(TEX * TEX * 4);
  // Pores: small dark pits.
  const pores = new Float32Array(TEX * TEX);
  for (let k = 0; k < 900; k++) {
    const cx = rng.int(0, TEX - 1);
    const cy = rng.int(0, TEX - 1);
    const r = rng.range(0.6, 1.8);
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++) {
        const d = Math.sqrt(x * x + y * y);
        if (d > r) continue;
        const i = ((cy + y + TEX) % TEX) * TEX + ((cx + x + TEX) % TEX);
        pores[i] = Math.max(pores[i]!, 1 - d / r);
      }
  }
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const u = x / TEX;
      const v = y / TEX;
      const i = y * TEX + x;
      let h = 0.5 + 0.18 * fine(u, v) + 0.1 * coarse(u, v) - 0.35 * pores[i]!;
      let shade = 1 + 0.07 * fine(u * 2, v * 2) + 0.09 * coarse(u, v) - 0.25 * pores[i]!;
      if (style.formwork) {
        // Seams on the tile border (≈ 1.5 cm at 1 m/128 px), 4 tie holes.
        const su = Math.min(x, TEX - 1 - x);
        const sv = Math.min(y, TEX - 1 - y);
        const seam = Math.min(su, sv);
        if (seam < 2) {
          h -= 0.3;
          shade *= 0.8;
        } else if (seam < 4) shade *= 0.93;
        for (const [tu, tv] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
          const d = Math.hypot(u - tu, v - tv) * TEX;
          if (d < 4) {
            h -= 0.5 * (1 - d / 4);
            shade *= 0.62 + 0.38 * (d / 4);
          } else if (d < 9) shade *= 1 - 0.05 * (1 - (d - 4) / 5);
        }
      }
      if (style.grooves) {
        const g = (v * style.grooves) % 1;
        if (g < 0.12) {
          h -= 0.35;
          shade *= 0.86;
        }
      }
      if (style.streaks) {
        const s = Math.max(0, streakN(u, 0.05) * 1.6 - 0.3) * (0.4 + 0.6 * v);
        shade *= 1 - style.streaks * s;
      }
      height[i] = h;
      const o = 4 * i;
      const base = style.tone * shade;
      albedo[o] = clampByte(base + style.tint[0]);
      albedo[o + 1] = clampByte(base + style.tint[1]);
      albedo[o + 2] = clampByte(base + style.tint[2]);
      albedo[o + 3] = 255;
    }
  }
  return { albedo, normal: normalFromHeight(height, TEX, 3.5) };
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Black/yellow 45° hazard stripes, one stripe pair per tile. */
export function hazardStripes(): Uint8Array {
  const n = 64;
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const s = ((x + y) % n) / n;
      const edge = Math.min(Math.abs(s - 0.5), s, 1 - s) * n; // px to a stripe boundary
      const yellow = s < 0.5;
      const aa = Math.min(1, edge / 1.2);
      const c: [number, number, number] = yellow ? [242, 190, 24] : [22, 22, 22];
      const o: [number, number, number] = yellow ? [22, 22, 22] : [242, 190, 24];
      const i = 4 * (y * n + x);
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(c[k]! * (0.5 + 0.5 * aa) + o[k]! * (0.5 - 0.5 * aa));
      out[i + 3] = 255;
    }
  return out;
}

/** Crash-test target: black/yellow quadrant disc with a white rim; alpha 0 outside. */
function crashTarget(): Uint8Array {
  const n = 128;
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5;
      const v = (y + 0.5) / n - 0.5;
      const r = Math.hypot(u, v) * 2;
      const i = 4 * (y * n + x);
      if (r > 1) {
        out[i + 3] = 0;
        continue;
      }
      const rim = r > 0.88;
      const quad = (u >= 0) === (v >= 0);
      const col: [number, number, number] = rim ? [235, 235, 230] : quad ? [242, 190, 24] : [18, 18, 18];
      out[i] = col[0];
      out[i + 1] = col[1];
      out[i + 2] = col[2];
      out[i + 3] = 255;
    }
  return out;
}

// ====================================================================== geometry (pure; UVs in metres)
type V3 = readonly [number, number, number];

/** Accumulates flat-shaded quads/triangles with per-face UVs (metres). */
class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** Vertex colour of the next polygons (linear RGB); `colored` emits the attribute. */
  color: [number, number, number] = [1, 1, 1];
  colored = false;

  /** Planar polygon (convex, CCW seen from outside), uv = (p·uAxis, p·vAxis). */
  poly(pts: readonly V3[], uAxis: V3, vAxis: V3): void {
    const a = pts[0]!;
    const b = pts[1]!;
    const c = pts[2]!;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.pos.length / 3;
    for (const p of pts) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(this.color[0], this.color[1], this.color[2]);
      this.nrm.push(nx, ny, nz);
      this.uv.push(p[0] * uAxis[0] + p[1] * uAxis[1] + p[2] * uAxis[2], p[0] * vAxis[0] + p[1] * vAxis[1] + p[2] * vAxis[2]);
    }
    for (let k = 1; k + 1 < pts.length; k++) this.idx.push(base, base + k, base + k + 1);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    if (this.colored) g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const NX: V3 = [-1, 0, 0];
const NZ: V3 = [0, 0, -1];

/** Axis-aligned box [min, max] with world-scale UVs (u along the face's horizontal edge, v up). */
export function boxGeometry(min: V3, max: V3): BufferGeometry {
  const b = new GeoBuilder();
  addBox(b, min, max);
  return b.build();
}

function addBox(b: GeoBuilder, [x0, y0, z0]: V3, [x1, y1, z1]: V3): void {
  b.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], X, Y); // +Z
  b.poly([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], NX, Y); // −Z
  b.poly([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], NZ, Y); // +X
  b.poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], Z, Y); // −X
  b.poly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], X, NZ); // +Y
  b.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], X, Z); // −Y
}

/** Ramp wedge (ColliderDef 'ramp'): surface from y = −hy at z = +hz up to +hy at z = −hz. Deck v = slope distance. */
export function rampGeometry(hx: number, hy: number, hz: number): { body: BufferGeometry; deck: BufferGeometry } {
  const body = new GeoBuilder();
  const deck = new GeoBuilder();
  const slopeLen = Math.hypot(2 * hz, 2 * hy);
  const sv: V3 = [0, (2 * hy) / slopeLen, (-2 * hz) / slopeLen]; // up the slope
  deck.poly([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], X, sv);
  body.poly([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], NX, Y); // back (lip face)
  body.poly([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz]], NZ, Y); // +X side
  body.poly([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, -hz]], Z, Y); // −X side
  body.poly([[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], X, Z); // bottom
  return { body: body.build(), deck: deck.build() };
}

/**
 * New-Jersey barrier profile in (z, y) for half width hz and half height hy
 * (standard 0.61 × 0.81 m: 75 mm toe, 55° face to 330 mm, 84° face to a
 * 150 mm top), extruded along x over ±hx.
 */
export function jerseyGeometry(hx: number, hy: number, hz: number): BufferGeometry {
  const H = 2 * hy;
  const prof: [number, number][] = [
    [hz, -hy],
    [hz, -hy + (0.075 / 0.81) * H],
    [hz * 0.41, -hy + (0.33 / 0.81) * H],
    [hz * 0.25, hy],
  ];
  const loop: [number, number][] = [...prof, ...prof.slice().reverse().map(([z, y]) => [-z, y] as [number, number])];
  const b = new GeoBuilder();
  for (let k = 0; k < loop.length; k++) {
    const [za, ya] = loop[k]!;
    const [zb, yb] = loop[(k + 1) % loop.length]!;
    if (za === zb && ya === yb) continue;
    // Quad from profile edge a→b extruded along x; u along x, v along the profile edge.
    const ex = [0, yb - ya, zb - za];
    const el = Math.hypot(ex[1]!, ex[2]!) || 1;
    const vAxis: V3 = [0, ex[1]! / el, ex[2]! / el];
    b.poly([[hx, ya, za], [-hx, ya, za], [-hx, yb, zb], [hx, yb, zb]], NX, vAxis);
  }
  // End caps (convex profile).
  b.poly(loop.map(([z, y]) => [hx, y, z] as V3), NZ, Y);
  b.poly(loop.slice().reverse().map(([z, y]) => [-hx, y, z] as V3), Z, Y);
  return b.build();
}

// ====================================================================== renderer
interface Mats {
  wall: MeshStandardMaterial;
  concrete: MeshStandardMaterial;
  jersey: MeshStandardMaterial;
  deck: MeshStandardMaterial;
  steel: MeshStandardMaterial;
  hazard: MeshStandardMaterial;
  target: MeshStandardMaterial;
  paint: MeshStandardMaterial;
  reflector: MeshStandardMaterial;
  // P8 stunt park
  corrugated: MeshStandardMaterial;
  painted: MeshStandardMaterial;
  rubber: MeshStandardMaterial;
  plate: MeshStandardMaterial;
}

function createMaterials(maxAniso: number): { mats: Mats; textures: Texture[] } {
  const textures: Texture[] = [];
  const tex = (data: Uint8Array, size: number, srgb: boolean, ru: number, rv: number): DataTexture => {
    const t = makeTexture(data, size, srgb, ru, rv);
    t.anisotropy = Math.min(t.anisotropy, maxAniso);
    textures.push(t);
    return t;
  };
  const concreteSet = (style: ConcreteStyle, tileU: number, tileV: number, roughness: number): MeshStandardMaterial => {
    const c = concreteTextures(style);
    return new MeshStandardMaterial({
      name: `collider-concrete-${style.seed}`,
      map: tex(c.albedo, TEX, true, 1 / tileU, 1 / tileV),
      normalMap: tex(c.normal, TEX, false, 1 / tileU, 1 / tileV),
      normalScale: new Vector2(1, 1),
      roughness,
      metalness: 0,
    });
  };
  const stripes = hazardStripes();
  const mats: Mats = {
    // Wall formwork panels 2.4 × 1.0 m.
    wall: concreteSet({ seed: 11, tone: 158, tint: [4, 2, -3], formwork: true, streaks: 0.22 }, 2.4, 1.0, 0.9),
    concrete: concreteSet({ seed: 23, tone: 150, tint: [3, 2, -2], streaks: 0.12 }, 2.0, 2.0, 0.92),
    jersey: concreteSet({ seed: 37, tone: 184, tint: [3, 2, -1], streaks: 0.1 }, 1.5, 1.5, 0.88),
    deck: concreteSet({ seed: 41, tone: 140, tint: [2, 1, -2], grooves: 8 }, 1.2, 1.2, 0.95),
    steel: new MeshStandardMaterial({ name: 'collider-steel', color: 0xa9afb5, metalness: 0.85, roughness: 0.36 }),
    hazard: new MeshStandardMaterial({ name: 'collider-hazard', map: tex(stripes, 64, true, 1 / 0.5, 1 / 0.5), roughness: 0.55, metalness: 0 }),
    target: new MeshStandardMaterial({
      name: 'collider-target',
      map: tex(crashTarget(), 128, true, 1, 1),
      alphaTest: 0.5,
      roughness: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    paint: new MeshStandardMaterial({ name: 'collider-paint', color: 0xf0bf1a, roughness: 0.5, metalness: 0 }),
    reflector: new MeshStandardMaterial({ name: 'collider-reflector', color: 0xff8a1c, emissive: 0x401800, roughness: 0.25, metalness: 0.1 }),
    // P8: shipping containers (vertex-coloured paint over vertical corrugation), painted parts (wrecks,
    // seats, stripes), tyre rubber, diamond-plate steel (kickers).
    corrugated: new MeshStandardMaterial({
      name: 'collider-corrugated',
      vertexColors: true,
      map: tex(grimeTexture(51), 128, true, 1 / 3, 1 / 2.6),
      normalMap: tex(corrugationNormal(), 64, false, 1 / 0.6, 1),
      normalScale: new Vector2(1.2, 1.2),
      roughness: 0.62,
      metalness: 0.35,
    }),
    painted: new MeshStandardMaterial({ name: 'collider-painted', vertexColors: true, map: tex(grimeTexture(77), 128, true, 1 / 1.6, 1 / 1.6), roughness: 0.6, metalness: 0.25 }),
    rubber: new MeshStandardMaterial({ name: 'collider-rubber', vertexColors: true, normalMap: tex(treadNormal(), 64, false, 1 / 0.35, 1 / 0.35), roughness: 0.92, metalness: 0 }),
    plate: new MeshStandardMaterial({
      name: 'collider-plate',
      color: 0x5f666d,
      normalMap: tex(diamondPlateNormal(), 64, false, 1 / 0.4, 1 / 0.4),
      normalScale: new Vector2(0.9, 0.9),
      roughness: 0.5,
      metalness: 0.72,
    }),
  };
  // The target texture shows one disc over the whole quad (UV 0..1).
  mats.target.map!.wrapS = ClampToEdgeWrapping;
  mats.target.map!.wrapT = ClampToEdgeWrapping;
  return { mats, textures };
}

function mesh(g: BufferGeometry, m: Material, shadows = true): Mesh {
  const me = new Mesh(g, m);
  me.castShadow = shadows;
  me.receiveShadow = true;
  return me;
}

/** Builds one collider's visual group in its LOCAL frame (caller places it). */
function buildCollider(c: ResolvedCollider, M: Mats): Group {
  const g = new Group();
  g.name = `collider:${c.id}`;
  const [a, b, d] = c.size;
  switch (colliderVisual(c)) {
    case 'none':
      break;
    case 'wall': {
      g.add(mesh(boxGeometry([-a, -b, -d], [a, b, d]), M.wall));
      // Hazard bands near the top of both long faces (2 mm proud).
      const band = Math.min(0.3, b * 0.3);
      const y1 = b - 0.12;
      g.add(mesh(boxGeometry([-a + 0.05, y1 - band, d], [a - 0.05, y1, d + 0.004]), M.hazard, false));
      g.add(mesh(boxGeometry([-a + 0.05, y1 - band, -d - 0.004], [a - 0.05, y1, -d]), M.hazard, false));
      // Crash target on the +Z face at bumper height.
      const tr = Math.min(0.45, b * 0.4);
      const tb = new GeoBuilder();
      tb.poly([[-tr, -tr, 0], [tr, -tr, 0], [tr, tr, 0], [-tr, tr, 0]], [0.5 / tr, 0, 0], [0, 0.5 / tr, 0]);
      const target = tb.build();
      // uv = p/(2·tr) ∈ [−0.5, 0.5] → shift to [0, 1].
      const uv = target.getAttribute('uv') as BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + 0.5, uv.getY(i) + 0.5);
      const tm = mesh(target, M.target, false);
      tm.position.set(0, -b + 0.55, d + 0.006);
      g.add(tm);
      break;
    }
    case 'pole': {
      const r = a;
      const hh = b;
      g.add(mesh(new CylinderGeometry(r, r, 2 * hh, 28, 1), M.steel));
      const sleeveH = Math.min(1.0, hh);
      const sleeve = new CylinderGeometry(r * 1.015, r * 1.015, sleeveH, 28, 1, true);
      // Wrap stripes: u = 1 around (≈ 2πr m) → repeat count via the uv itself.
      const suv = sleeve.getAttribute('uv') as BufferAttribute;
      const circ = 2 * Math.PI * r;
      for (let i = 0; i < suv.count; i++) suv.setXY(i, suv.getX(i) * circ, suv.getY(i) * sleeveH);
      const sm = mesh(sleeve, M.hazard, false);
      sm.position.y = -hh + 0.3 + sleeveH / 2;
      g.add(sm);
      const plate = mesh(new CylinderGeometry(r * 1.45, r * 1.55, 0.03, 28), M.steel);
      plate.position.y = -hh + 0.015;
      g.add(plate);
      const cap = mesh(new SphereGeometry(r * 1.02, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.steel);
      cap.position.y = hh;
      cap.scale.y = 0.35;
      g.add(cap);
      break;
    }
    case 'ramp': {
      const w = rampGeometry(a, b, d);
      g.add(mesh(w.body, M.concrete));
      g.add(mesh(w.deck, M.deck));
      // Steel lip angle along the top back edge and a painted line just below it.
      g.add(mesh(boxGeometry([-a, b - 0.06, -d - 0.006], [a, b + 0.006, -d + 0.04]), M.steel));
      // Painted line 12–24 cm down the slope from the lip.
      const L = Math.hypot(2 * d, 2 * b);
      const at = (sDown: number): [number, number] => [b - (2 * b * sDown) / L + 0.004, -d + (2 * d * sDown) / L];
      const [ya, za] = at(0.24);
      const [yb, zb] = at(0.12);
      const lb = new GeoBuilder();
      lb.poly([[-a + 0.05, ya, za], [a - 0.05, ya, za], [a - 0.05, yb, zb], [-a + 0.05, yb, zb]], X, Z);
      g.add(mesh(lb.build(), M.paint, false));
      break;
    }
    case 'jersey': {
      g.add(mesh(jerseyGeometry(a, b, d), M.jersey));
      // Reflector disc on both faces near the top.
      const rg = new CylinderGeometry(0.035, 0.035, 0.01, 16);
      for (const s of [1, -1]) {
        const rm = mesh(rg, M.reflector, false);
        rm.rotation.x = Math.PI / 2;
        rm.position.set(0, b - 0.12, s * (d * 0.25 + 0.02));
        g.add(rm);
      }
      break;
    }
    case 'plate': {
      g.add(mesh(boxGeometry([-a, -0.05, -d], [a, 0, d]), M.steel));
      break;
    }
    case 'container':
      buildContainer(g, c, M);
      break;
    case 'wreck':
      buildWreck(g, c, M);
      break;
    case 'tires':
      buildTyreWall(g, c, M);
      break;
    case 'kicker': {
      const w = rampGeometry(a, b, d);
      g.add(mesh(w.body, M.steel));
      g.add(mesh(w.deck, M.plate));
      // hazard band along the lip (on the deck, 2 mm proud)
      const L = Math.hypot(2 * d, 2 * b);
      const at = (sDown: number): [number, number] => [b - (2 * b * sDown) / L + 0.003, -d + (2 * d * sDown) / L];
      const [ya, za] = at(0.35);
      const [yb, zb] = at(0.02);
      const lb = new GeoBuilder();
      lb.poly([[-a + 0.02, ya, za], [a - 0.02, ya, za], [a - 0.02, yb, zb], [-a + 0.02, yb, zb]], X, Z);
      g.add(mesh(lb.build(), M.hazard, false));
      break;
    }
    case 'deck': {
      if (a < 0.3) {
        g.add(mesh(boxGeometry([-a, -b, -d], [a, b, d]), M.steel));
        break;
      }
      const top = new GeoBuilder();
      top.poly([[-a, b, d], [a, b, d], [a, b, -d], [-a, b, -d]], X, NZ);
      g.add(mesh(top.build(), M.deck));
      const sides = new GeoBuilder();
      sides.poly([[-a, -b, d], [a, -b, d], [a, b, d], [-a, b, d]], X, Y);
      sides.poly([[a, -b, -d], [-a, -b, -d], [-a, b, -d], [a, b, -d]], NX, Y);
      sides.poly([[a, -b, d], [a, -b, -d], [a, b, -d], [a, b, d]], NZ, Y);
      sides.poly([[-a, -b, -d], [-a, -b, d], [-a, b, d], [-a, b, -d]], Z, Y);
      sides.poly([[-a, -b, -d], [a, -b, -d], [a, -b, d], [-a, -b, d]], X, Z);
      g.add(mesh(sides.build(), M.steel));
      break;
    }
    case 'floodlight': {
      // the mast (the lamp head above it is decoration: render/world/stuntpark.ts)
      const mast = new CylinderGeometry(a * 0.55, a * 0.85, 2 * b - 0.6, 14, 1);
      const mm = mesh(mast, M.steel);
      mm.position.y = 0.3;
      g.add(mm);
      const plinth = mesh(new CylinderGeometry(a, a, 0.6, 16), M.concrete);
      plinth.position.y = -b + 0.3;
      g.add(plinth);
      break;
    }
    case 'grandstand':
      buildGrandstand(g, c, M);
      break;
    default: {
      if (c.kind === 'sphere') g.add(mesh(new SphereGeometry(a, 32, 16), M.concrete));
      else if (c.kind === 'cylinder') g.add(mesh(new CylinderGeometry(a, a, 2 * b, 28), M.concrete));
      else if (c.kind === 'ramp') {
        const w = rampGeometry(a, b, d);
        g.add(mesh(w.body, M.concrete), mesh(w.deck, M.deck));
      } else if (c.kind === 'plane') g.add(mesh(boxGeometry([-a, -0.05, -d], [a, 0, d]), M.concrete));
      else g.add(mesh(boxGeometry([-a, -b, -d], [a, b, d]), M.concrete));
    }
  }
  return g;
}


// ====================================================================== P8 stunt-park visuals
/** sRGB hex → linear [r, g, b] (vertex colours are linear). */
function lin(hex: number, k = 1): [number, number, number] {
  const f = (v: number): number => {
    const c = v / 255;
    return (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * k;
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

/** Stable 32-bit hash of a collider id (colour picks, dents). */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const CONTAINER_COLORS = [0x8f3324, 0x1f4f7a, 0x2f5f3b, 0xc2621f, 0x6f767c, 0x1d6b6e, 0xa8842a];

function addBoxC(b: GeoBuilder, [x0, y0, z0]: V3, [x1, y1, z1]: V3): void {
  addBox(b, [x0, y0, z0], [x1, y1, z1]);
}

/** 40 ft container: corrugated walls, door end with locking bars, end frames and corner castings. */
function buildContainer(g: Group, c: ResolvedCollider, M: Mats): void {
  const [a, b, d] = c.size;
  const h = idHash(c.id);
  const body = new GeoBuilder();
  body.colored = true;
  body.color = lin(CONTAINER_COLORS[h % CONTAINER_COLORS.length]!, 0.95);
  const i = 0.05;
  addBoxC(body, [-a + 0.12, -b + 0.12, -d + i], [a - 0.12, b - 0.08, d - i]);
  g.add(mesh(body.build(), M.corrugated));
  const fr = new GeoBuilder();
  fr.colored = true;
  fr.color = lin(CONTAINER_COLORS[h % CONTAINER_COLORS.length]!, 0.7);
  // end frames + rails
  for (const sx of [-1, 1]) {
    addBoxC(fr, [sx > 0 ? a - 0.12 : -a, -b, -d], [sx > 0 ? a : -a + 0.12, b, d]);
  }
  addBoxC(fr, [-a, b - 0.08, -d], [a, b, -d + 0.1]);
  addBoxC(fr, [-a, b - 0.08, d - 0.1], [a, b, d]);
  addBoxC(fr, [-a, -b, -d], [a, -b + 0.12, -d + 0.1]);
  addBoxC(fr, [-a, -b, d - 0.1], [a, -b + 0.12, d]);
  // door locking bars on the +x end
  fr.color = lin(0x9a9a92);
  for (const z of [-0.75, -0.35, 0.35, 0.75]) addBoxC(fr, [a - 0.02, -b + 0.2, z * d - 0.025], [a, b - 0.2, z * d + 0.025]);
  g.add(mesh(fr.build(), M.painted));
}

/** Crushed car hulk (length along local x): extruded side profile with dents, glassless cabin, flat tyres. */
function buildWreck(g: Group, c: ResolvedCollider, M: Mats): void {
  const [a, b, d] = c.size;
  const h = idHash(c.id);
  const rng = createRng(h);
  const y0 = -b;
  // side profile (x, y) front (−x) → rear (+x), clockwise from the bottom front
  const roofDrop = rng.range(0.05, 0.25);
  const prof: [number, number][] = [
    [-a, y0 + 0.28],
    [-a + 0.05, y0 + 0.62],
    [-a + 0.95, y0 + 0.78],
    [-0.55, y0 + 0.86],
    [-0.15, b - roofDrop],
    [0.85, b - 0.02],
    [1.3, y0 + 0.86],
    [a - 0.05, y0 + 0.74],
    [a, y0 + 0.3],
  ];
  const paint = lin([0x6b2a22, 0x2f4a5c, 0x8a8a80, 0x4c5a3a, 0x7a5a2a, 0x24282c][h % 6]!, 0.9);
  const rust = lin(0x5a3a22, 0.8);
  const dark = lin(0x141414);
  const N = 6; // segments across z
  const b2 = new GeoBuilder();
  b2.colored = true;
  const dent = (x: number, y: number, z: number): number => 0.045 * Math.sin(x * 3.1 + (h % 7)) * Math.cos(z * 4.3 + y * 2);
  const P = (x: number, y: number, z: number): V3 => {
    const zz = z * (0.92 + 0.08 * Math.min(1, Math.max(0, (y0 + 0.86 - y) / 0.4 + 1)));
    const yy = Math.min(b, y - Math.abs(dent(x, y, z)));
    return [x, yy, Math.max(-d, Math.min(d, zz))];
  };
  const colAt = (x: number, y: number): [number, number, number] => {
    if (y > y0 + 0.9 && x > -0.5 && x < 1.25) return dark; // windows (void)
    const r = 0.5 + 0.5 * Math.sin(x * 5 + y * 7 + (h % 13));
    return r > 0.82 ? rust : paint;
  };
  for (let k = 0; k < prof.length; k++) {
    const p = prof[k]!;
    const q = prof[(k + 1) % prof.length]!;
    for (let j = 0; j < N; j++) {
      const za = -d + (2 * d * j) / N;
      const zb = -d + (2 * d * (j + 1)) / N;
      b2.color = colAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      b2.poly([P(q[0], q[1], za), P(p[0], p[1], za), P(p[0], p[1], zb), P(q[0], q[1], zb)], X, Z);
    }
  }
  // bottom + side faces
  b2.color = paint;
  // side faces: the profile is concave at the windscreen base, so triangulate it properly
  const tris = ShapeUtils.triangulateShape(prof.map(([x, y]) => new Vector2(x, y)), []);
  for (const sz of [-1, 1]) {
    for (const t3 of tris) {
      const pa = prof[t3[0]!]!;
      const pb = prof[t3[1]!]!;
      const pc = prof[t3[2]!]!;
      const tri = [P(pa[0], pa[1], sz * d), P(pb[0], pb[1], sz * d), P(pc[0], pc[1], sz * d)];
      // outward = sign(sz) along z
      const cz = (tri[1]![0] - tri[0]![0]) * (tri[2]![1] - tri[0]![1]) - (tri[1]![1] - tri[0]![1]) * (tri[2]![0] - tri[0]![0]);
      b2.poly(cz * sz > 0 ? tri : [tri[0]!, tri[2]!, tri[1]!], X, Y);
    }
  }
  g.add(mesh(b2.build(), M.painted));
  // flat tyres
  const t = new GeoBuilder();
  t.colored = true;
  t.color = lin(0x1a1a1a);
  for (const wx of [-a + 0.85, a - 0.8]) for (const wz of [-d + 0.12, d - 0.32]) addBoxC(t, [wx - 0.32, y0, wz], [wx + 0.32, y0 + 0.36, wz + 0.2]);
  g.add(mesh(t.build(), M.rubber));
}

/** Stacked tyre wall filling the box: rows of tyre stacks (torus rings), every other stack with a painted band. */
function buildTyreWall(g: Group, c: ResolvedCollider, M: Mats): void {
  const [a, b, d] = c.size;
  const h = idHash(c.id);
  const pitch = 0.62;
  const nx = Math.max(1, Math.floor((2 * a) / pitch));
  const nz = Math.max(1, Math.floor((2 * d) / pitch));
  const levels = Math.max(1, Math.round((2 * b) / 0.25));
  const tyre = new TorusGeometry(0.19, 0.11, 5, 12);
  tyre.rotateX(Math.PI / 2);
  tyre.scale(1, (2 * b) / levels / 0.22, 1);
  const tPos = tyre.getAttribute('position');
  const tNrm = tyre.getAttribute('normal');
  const tIdx = tyre.getIndex()!;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const rubber = lin(0x1c1c1c);
  const bands = [lin(0xe8e8e2), lin(0xc8241c), lin(0xe8b818)];
  const sx = (2 * a) / nx;
  const sz = (2 * d) / nz;
  const ty = (2 * b) / levels;
  for (let ix = 0; ix < nx; ix++)
    for (let iz = 0; iz < nz; iz++) {
      const painted = (ix + iz + h) % 2 === 0;
      const band = bands[(ix + h) % bands.length]!;
      for (let l = 0; l < levels; l++) {
        const cx = -a + sx * (ix + 0.5);
        const cz = -d + sz * (iz + 0.5);
        const cy = -b + ty * (l + 0.5);
        const color = painted && l % 2 === 1 ? band : rubber;
        const base = pos.length / 3;
        for (let v = 0; v < tPos.count; v++) {
          pos.push(cx + tPos.getX(v), cy + tPos.getY(v), cz + tPos.getZ(v));
          nrm.push(tNrm.getX(v), tNrm.getY(v), tNrm.getZ(v));
          col.push(color[0], color[1], color[2]);
          uvs.push(tPos.getX(v) + cx, tPos.getY(v) + cy);
        }
        for (let k = 0; k < tIdx.count; k++) idx.push(base + tIdx.getX(k));
      }
    }
  tyre.dispose();
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(idx);
  g.add(mesh(geo, M.rubber));
}

/**
 * Grandstand on its ramp collider (wedge rising to local −Z): concrete
 * terraces whose front edges straddle the wedge plane (± half a riser),
 * coloured seat rows, side walls.
 */
function buildGrandstand(g: Group, c: ResolvedCollider, M: Mats): void {
  const [a, b, d] = c.size;
  const N = 8;
  const run = (2 * d) / N;
  const rise = (2 * b) / N;
  const steps = new GeoBuilder();
  const seats = new GeoBuilder();
  seats.colored = true;
  const seatCols = [lin(0x1d4e89), lin(0x1d4e89), lin(0xe9e7e1), lin(0xd8571c)];
  for (let k = 0; k < N; k++) {
    const zf = d - k * run;
    const zb = d - (k + 1) * run;
    const top = -b + (k + 0.5) * rise;
    addBox(steps, [-a, -b, zb], [a, top, zf]);
    // seat row: blocks of colour along the row (a pattern that reads as crowd seating from afar)
    const n = Math.floor((2 * a) / 2.4);
    for (let s = 0; s < n; s++) {
      seats.color = seatCols[(s + k * 3 + (s % 5 === 0 ? 2 : 0)) % seatCols.length]!;
      const x0 = -a + 0.3 + s * 2.4;
      const sh = Math.min(0.42, b - top);
      if (sh <= 0.02) continue;
      addBox(seats, [x0, top, zb + 0.12], [x0 + 2.25, top + sh, zb + 0.55]);
    }
  }
  g.add(mesh(steps.build(), M.concrete));
  g.add(mesh(seats.build(), M.painted));
}

/** Vertical corrugation normal map (trapezoid ribs), one rib per tile. */
export function corrugationNormal(): Uint8Array {
  const n = 64;
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const t = Math.abs(u - 0.5) * 2; // 0 centre → 1 edge
      hgt[y * n + x] = t < 0.45 ? 1 : t > 0.75 ? 0 : 1 - (t - 0.45) / 0.3;
    }
  return normalFromHeight(hgt, n, 6);
}

/** Diamond-plate normal map: raised lozenges in a staggered grid. */
export function diamondPlateNormal(): Uint8Array {
  const n = 64;
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let best = 0;
      for (const [cx, cy, dir] of [[0.25, 0.25, 1], [0.75, 0.75, 1], [0.75, 0.25, -1], [0.25, 0.75, -1]] as const) {
        let dx = x / n - cx;
        let dy = y / n - cy;
        dx -= Math.round(dx);
        dy -= Math.round(dy);
        const along = (dx + dir * dy) / Math.SQRT2;
        const across = (dx - dir * dy) / Math.SQRT2;
        const v = 1 - Math.min(1, Math.abs(along) / 0.17) - Math.min(1, Math.abs(across) / 0.035);
        if (v > best) best = v;
      }
      hgt[y * n + x] = Math.max(0, best);
    }
  return normalFromHeight(hgt, n, 4);
}

/** Tyre tread / sidewall grain normal map. */
export function treadNormal(): Uint8Array {
  const n = 64;
  const f = tileableFbm(91, 8, 3);
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hgt[y * n + x] = 0.5 + 0.5 * f(x / n, y / n) + ((y >> 3) % 2 ? 0.2 : 0);
  return normalFromHeight(hgt, n, 3);
}

/** Grime / weathering albedo multiplier (greyscale sRGB around 0.85–1). */
export function grimeTexture(seed: number): Uint8Array {
  const n = 128;
  const f = tileableFbm(seed, 4, 4);
  const s = periodicNoise(seed + 5, 32);
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const streak = Math.max(0, s(u, 0.1) * 1.4 - 0.4) * v;
      const g = clampByte(255 * (0.9 + 0.08 * f(u, v) - 0.18 * streak));
      const o = 4 * (y * n + x);
      out[o] = g;
      out[o + 1] = clampByte(g * 0.98);
      out[o + 2] = clampByte(g * 0.95);
      out[o + 3] = 255;
    }
  return out;
}

/** Every collider's visual group, placed in world space (one per collider, `collider:<id>`). */
function placedGroups(resolved: readonly ResolvedCollider[], mats: Mats): Group[] {
  // Layout v6: world-content colliders (ids 'w:*') and content visuals (buildings, kerbs, structures…) are the content
  // renderer's, except plain content ramps / blocks, which keep this renderer's stunt-park look.
  const generic = (c: ResolvedCollider): boolean => (c.id.startsWith('w:') ? c.visual === 'ramp' || (c.visual === 'block' && c.kind === 'box') : c.visual === undefined || !CONTENT_VISUALS.has(c.visual));
  return resolved.filter(generic).map((c) => {
    const g = buildCollider(c, mats);
    g.position.set(c.pos[0], c.pos[1], c.pos[2]);
    g.quaternion.set(c.quat[0], c.quat[1], c.quat[2], c.quat[3]);
    g.updateMatrixWorld(true);
    return g;
  });
}

/** The per-collider groups before batching (tests: visual == collision per collider). */
export function colliderGroups(resolved: readonly ResolvedCollider[]): Group[] {
  return placedGroups(resolved, createMaterials(4).mats);
}

/**
 * Builds the meshes for `resolved` colliders (call again with a new set; P5
 * breakables will swap meshes per id). Materials are patched with CSM.
 */
export function createColliderRenderer(ctx: RenderContext, resolved: readonly ResolvedCollider[], opts: ColliderRendererOptions): ColliderRenderer {
  let maxAniso = 8;
  try {
    maxAniso = ctx.renderer.capabilities.getMaxAnisotropy();
  } catch {
    maxAniso = 1;
  }
  const { mats, textures } = createMaterials(maxAniso);
  const csm = opts.lighting.csm;
  for (const m of Object.values(mats) as MeshStandardMaterial[]) opts.patchMaterial(m, { csm });

  const root = new Group();
  root.name = 'colliders';
  // Built per collider, then baked to world space and merged per (material, casts shadow): a
  // handful of draws instead of one per part (52 in every pass the arena was in, P5 draw budget).
  const batches = new Map<string, { material: Material; casts: boolean; parts: BufferGeometry[] }>();
  for (const g of placedGroups(resolved, mats)) {
    g.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const material = m.material as Material;
      const key = `${material.uuid}|${m.castShadow ? 1 : 0}`;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { material, casts: m.castShadow, parts: [] }));
      const part = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
      const vc = (material as MeshStandardMaterial).vertexColors === true;
      for (const name of Object.keys(part.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(vc && name === 'color')) part.deleteAttribute(name);
      if (vc && !part.getAttribute('color')) part.setAttribute('color', new BufferAttribute(new Float32Array(part.getAttribute('position').count * 3).fill(1), 3));
      if (!part.getAttribute('normal')) part.computeVertexNormals();
      if (!part.getAttribute('uv')) part.setAttribute('uv', new BufferAttribute(new Float32Array(part.getAttribute('position').count * 2), 2));
      part.clearGroups();
      b.parts.push(part);
      m.geometry.dispose();
    });
  }
  for (const b of batches.values()) {
    const merged = mergeGeometries(b.parts, false);
    for (const p of b.parts) p.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const me = mesh(merged, b.material, b.casts);
    me.name = `colliders:${b.material.name}${b.casts ? '' : ':decal'}`;
    me.matrixAutoUpdate = false;
    me.updateMatrixWorld(true);
    root.add(me);
  }

  return {
    object: root,
    update() {},
    setQuality() {},
    dispose() {
      root.traverse((o) => {
        if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose();
      });
      for (const m of Object.values(mats) as Material[]) m.dispose();
      for (const t of textures) t.dispose();
      root.removeFromParent();
    },
  };
}
