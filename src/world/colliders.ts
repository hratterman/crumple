/**
 * Static colliders — pure helpers shared by the sim (collision) and render
 * (meshes): validation + terrain resolution (`resolveColliders`, the FROZEN
 * ResolveColliders signature in ./types), the rotation matrix every consumer
 * must use, and the conservative world AABB. Both sides call these with the
 * same inputs, so what is drawn is exactly what is collided with.
 *
 * Pure: no three, no DOM, no sim imports; deterministic (+ − × ÷ sqrt only).
 */
import { MATERIAL_COUNT } from '../protocol/messages';
import {
  WorldLayoutError,
  type ColliderDef,
  type ColliderKind,
  type ColliderVisual,
  type ResolveColliders,
  type ResolvedCollider,
  type WorldVec3,
} from './types';

/** Tolerance on |quat| − 1. */
export const COLLIDER_QUAT_TOLERANCE = 1e-6;
/** One-sided plane colliders are a slab this deep below their surface (m); mirrors the sim's COLLIDER_PLANE_DEPTH. */
export const PLANE_SLAB_DEPTH = 0.5;

const KINDS: readonly ColliderKind[] = ['box', 'cylinder', 'sphere', 'plane', 'ramp', 'mesh'];

/**
 * Layout v6 (R-WORLD) visuals drawn by src/render/world/content/** from the WorldContent, never by
 * the static-collider renderer (render/world/colliders.ts skips them).
 */
export const CONTENT_VISUALS: ReadonlySet<ColliderVisual> = new Set<ColliderVisual>([
  'building',
  'kerb',
  'armco',
  'railing',
  'deckSlab',
  'tunnelWall',
  'pier',
  'parked',
  'log',
  'pipe',
  'crashBarrier',
  'sled',
  'lid',
]);

/** Default render style per kind (ColliderDef.visual omitted). */
export function colliderVisual(c: Pick<ColliderDef, 'kind' | 'visual'>): ColliderVisual {
  if (c.visual !== undefined) return c.visual;
  switch (c.kind) {
    case 'cylinder':
      return 'pole';
    case 'plane':
      return 'plate';
    case 'ramp':
      return 'ramp';
    default:
      return 'block';
  }
}

/**
 * Row-major rotation matrix of a unit quaternion [x, y, z, w]:
 * world = R·local + pos. Writes 9 numbers into `out` at `offset`.
 */
export function quatToMatrix(q: readonly number[], out: Float64Array | number[], offset = 0): void {
  const x = q[0]!;
  const y = q[1]!;
  const z = q[2]!;
  const w = q[3]!;
  out[offset] = 1 - 2 * (y * y + z * z);
  out[offset + 1] = 2 * (x * y - z * w);
  out[offset + 2] = 2 * (x * z + y * w);
  out[offset + 3] = 2 * (x * y + z * w);
  out[offset + 4] = 1 - 2 * (x * x + z * z);
  out[offset + 5] = 2 * (y * z - x * w);
  out[offset + 6] = 2 * (x * z - y * w);
  out[offset + 7] = 2 * (y * z + x * w);
  out[offset + 8] = 1 - 2 * (x * x + y * y);
}

/**
 * Local-frame bounding box of a collider's solid: [minX, minY, minZ, maxX,
 * maxY, maxZ] (plane: the slab below its surface).
 */
export function colliderLocalBounds(c: Pick<ResolvedCollider, 'kind' | 'size'>): [number, number, number, number, number, number] {
  const [a, b, cc] = c.size;
  switch (c.kind) {
    case 'box':
    case 'ramp':
    case 'mesh':
      return [-a, -b, -cc, a, b, cc];
    case 'cylinder':
      return [-a, -b, -a, a, b, a];
    case 'sphere':
      return [-a, -a, -a, a, a, a];
    case 'plane':
      return [-a, -PLANE_SLAB_DEPTH, -cc, a, 0, cc];
  }
}

/**
 * World AABB [minX, minY, minZ, maxX, maxY, maxZ] of a resolved collider,
 * grown by `fatten` m on every side (exact for the local box under R).
 */
export function colliderWorldAabb(c: ResolvedCollider, fatten = 0): [number, number, number, number, number, number] {
  const R = new Array<number>(9);
  quatToMatrix(c.quat, R);
  const lb = colliderLocalBounds(c);
  const out: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let centre = c.pos[r]!;
    let half = 0;
    for (let k = 0; k < 3; k++) {
      const m = R[3 * r + k]!;
      const lc = (lb[k]! + lb[k + 3]!) / 2;
      const lh = (lb[k + 3]! - lb[k]!) / 2;
      centre += m * lc;
      half += (m < 0 ? -m : m) * lh;
    }
    out[r] = centre - half - fatten;
    out[r + 3] = centre + half + fatten;
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validates and resolves colliders (FROZEN ResolveColliders): unique ids,
 * known kind, unit quat (±1e-6), positive sizes per kind, valid material,
 * y null ⇒ yaw-only quat. y null rests the solid on the terrain:
 * heightAt(x, z) + hy (box, ramp, cylinder), + r (sphere), + 0 (plane).
 * Throws WorldLayoutError naming the collider.
 */
export const resolveColliders: ResolveColliders = (colliders, heightAt) => {
  if (!Array.isArray(colliders)) throw new WorldLayoutError('colliders must be an array');
  const seen = new Set<string>();
  const out: ResolvedCollider[] = [];
  for (const c of colliders) {
    if (!c || typeof c !== 'object') throw new WorldLayoutError('collider must be an object');
    const id = c.id;
    if (typeof id !== 'string' || id.length === 0) throw new WorldLayoutError('collider id must be a non-empty string');
    const fail = (msg: string): never => {
      throw new WorldLayoutError(`collider '${id}': ${msg}`);
    };
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    if (!KINDS.includes(c.kind)) fail(`unknown kind ${String(c.kind)}`);
    const q = c.quat;
    if (!Array.isArray(q) || q.length !== 4 || !q.every(finite)) fail('quat must be 4 finite numbers [x, y, z, w]');
    const qn = Math.sqrt(q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]!);
    if (!(Math.abs(qn - 1) <= COLLIDER_QUAT_TOLERANCE)) fail(`quat must be unit (|q| = ${qn})`);
    const s = c.size;
    if (!Array.isArray(s) || s.length !== 3 || !s.every(finite)) fail('size must be 3 finite numbers');
    const need = c.kind === 'sphere' ? [0] : c.kind === 'cylinder' ? [0, 1] : c.kind === 'plane' ? [0, 2] : [0, 1, 2];
    for (const k of need) if (!(s[k]! > 0)) fail(`size[${k}] must be > 0 for a ${c.kind}`);
    if (!Number.isInteger(c.material) || c.material < 0 || c.material >= MATERIAL_COUNT) fail(`invalid material ${String(c.material)}`);
    if (c.kind === 'mesh') {
      // R-CORE static mesh: vertices inside the declared local half extents, triangles index them.
      const m = c.mesh;
      if (!m || !Array.isArray(m.positions) || !Array.isArray(m.indices)) fail('mesh needs positions and indices');
      const P = m!.positions;
      const I = m!.indices;
      if (P.length === 0 || P.length % 3 !== 0 || !P.every(finite)) fail('mesh.positions must be 3n finite numbers');
      if (I.length === 0 || I.length % 3 !== 0) fail('mesh.indices must be 3n vertex indices');
      const nv = P.length / 3;
      for (const v of I) if (!Number.isInteger(v) || v < 0 || v >= nv) fail(`mesh index ${String(v)} out of range`);
      for (let v = 0; v < P.length; v++) if (Math.abs(P[v]!) > s[v % 3]! + 1e-6) fail('mesh vertex outside the size half extents');
    } else if (c.mesh !== undefined) fail('mesh is only valid for kind mesh');
    if (c.breakable !== undefined && !(finite(c.breakable.anchorForce) && c.breakable.anchorForce > 0)) {
      fail('breakable.anchorForce must be > 0');
    }
    const p = c.pos;
    if (!Array.isArray(p) || p.length !== 3 || !finite(p[0]) || !finite(p[2]) || !(p[1] === null || finite(p[1]))) {
      fail('pos must be [x, y | null, z] finite');
    }
    let y: number;
    if (p[1] === null) {
      // Yaw-only: rotation about +Y keeps the local +Y axis vertical (x = z = 0 components).
      if (Math.abs(q[0]!) > COLLIDER_QUAT_TOLERANCE || Math.abs(q[2]!) > COLLIDER_QUAT_TOLERANCE) {
        fail('y null (rest on terrain) needs a yaw-only quat');
      }
      const lift = c.kind === 'sphere' ? s[0]! : c.kind === 'plane' ? 0 : s[1]!;
      y = heightAt(p[0], p[2]) + lift;
      if (!Number.isFinite(y)) fail('terrain height is not finite');
    } else {
      y = p[1];
    }
    const pos: WorldVec3 = [p[0], y, p[2]];
    const r: ResolvedCollider = { ...c, pos, quat: [q[0]!, q[1]!, q[2]!, q[3]!], size: [s[0]!, s[1]!, s[2]!] };
    out.push(r);
  }
  return out;
};
