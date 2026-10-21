/**
 * World-content helpers (layout v6, R-WORLD). Everything that feeds a collider,
 * a prop or a signal uses the generator numerics (+ − × ÷ sqrt floor abs min
 * max, seeded core/rng): both workers must build bit-identical content.
 */
import { createRoadSample, sampleRoad } from '../roads';
import { quatFromBasis } from '../routes';
import type { ColliderDef, ColliderVisual, RoadProfile, RoadSample, WorldVec3 } from '../types';

export type Quat = [number, number, number, number];
export type V3 = [number, number, number];

/** Rotation about +Y taking local −Z to the unit plan direction (dx, dz) (sqrt only). */
export function yawQuatDir(dx: number, dz: number): Quat {
  const l = Math.sqrt(dx * dx + dz * dz);
  const fx = l > 0 ? dx / l : 0;
  const fz = l > 0 ? dz / l : -1;
  const q: Quat = [0, 0, 0, 1];
  // columns: X = right (−fz, 0, fx), Y = up, Z = −forward
  quatFromBasis(-fz, 0, fx, 0, 1, 0, -fx, 0, -fz, q);
  q[0] = 0;
  q[2] = 0;
  const n = Math.sqrt(q[1] * q[1] + q[3] * q[3]);
  q[1] /= n;
  q[3] /= n;
  return q;
}

/**
 * Rotation taking local −Z to the unit 3D `forward` and local +Y as close to world up as the
 * forward allows, rolled by `bank` (cross-slope m/m, + = right side higher). sqrt only.
 */
export function frameQuat(fx: number, fy: number, fz: number, bank = 0): Quat {
  let l = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= l;
  fy /= l;
  fz /= l;
  // right = horizontal right (−fz, 0, fx) raised by the bank, orthogonalised against forward
  let rx = -fz;
  let ry = bank;
  let rz = fx;
  const d = rx * fx + ry * fy + rz * fz;
  rx -= d * fx;
  ry -= d * fy;
  rz -= d * fz;
  l = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= l;
  ry /= l;
  rz /= l;
  // up = right × forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const q: Quat = [0, 0, 0, 1];
  quatFromBasis(rx, ry, rz, ux, uy, uz, -fx, -fy, -fz, q);
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotates local vector v by unit quat q (sqrt-free). */
export function rotate(q: Quat, vx: number, vy: number, vz: number): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Round to 1 mm (keeps hashed collider data short and identical across engines). */
export const mm = (v: number): number => Math.round(v * 1000) / 1000;

export function box(id: string, pos: readonly [number, number | null, number], quat: Quat, hx: number, hy: number, hz: number, material: number, visual: ColliderVisual): ColliderDef {
  return { id, kind: 'box', pos: [mm(pos[0]), pos[1] === null ? null : mm(pos[1]), mm(pos[2])], quat, size: [mm(hx), mm(hy), mm(hz)], material: material as ColliderDef['material'], visual };
}

export function cylinder(id: string, pos: readonly [number, number | null, number], quat: Quat, r: number, hh: number, material: number, visual: ColliderVisual): ColliderDef {
  return { id, kind: 'cylinder', pos: [mm(pos[0]), pos[1] === null ? null : mm(pos[1]), mm(pos[2])], quat, size: [mm(r), mm(hh), 0], material: material as ColliderDef['material'], visual };
}

/** Road frame at arc s: centre, unit tangent (plan), right (plan), bank. */
export interface RoadFrame {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  rx: number;
  rz: number;
  bank: number;
}
const SMP: RoadSample = createRoadSample();
export function roadFrame(p: RoadProfile, s: number): RoadFrame {
  sampleRoad(p, s, SMP);
  return { x: SMP.x, y: SMP.y, z: SMP.z, tx: SMP.tx, tz: SMP.tz, rx: SMP.rx, rz: SMP.rz, bank: SMP.bank };
}
/** Point at (s, d, h above the carriageway surface there). */
export function roadPoint(p: RoadProfile, s: number, d: number, h = 0): WorldVec3 {
  const f = roadFrame(p, s);
  return [f.x + f.rx * d, f.y + f.bank * d + h, f.z + f.rz * d];
}

/**
 * Splits [s0, s1] into ⌈len / maxLen⌉ equal pieces; calls fn(sa, sb, k, n). Pieces are equal
 * so neighbouring segments meet exactly.
 */
export function pieces(s0: number, s1: number, maxLen: number, fn: (sa: number, sb: number, k: number, n: number) => void): void {
  const n = Math.max(1, Math.ceil((s1 - s0) / maxLen - 1e-9));
  for (let k = 0; k < n; k++) fn(s0 + ((s1 - s0) * k) / n, s0 + ((s1 - s0) * (k + 1)) / n, k, n);
}

/**
 * A box riding a road segment [sa, sb]: centred at lateral offset d, its TOP `top` m above the
 * carriageway surface (at d), `depth` deep, `halfW` half wide across, extended `ext` m beyond
 * each end (overlap between consecutive pieces). Tilted with the chord's grade and the bank.
 */
export function roadBox(
  id: string,
  p: RoadProfile,
  sa: number,
  sb: number,
  d: number,
  top: number,
  depth: number,
  halfW: number,
  ext: number,
  material: number,
  visual: ColliderVisual,
): ColliderDef {
  const a = roadPoint(p, sa, d, top);
  const b = roadPoint(p, sb, d, top);
  const fm = roadFrame(p, (sa + sb) / 2);
  const fx = b[0] - a[0];
  const fy = b[1] - a[1];
  const fz = b[2] - a[2];
  const L = Math.sqrt(fx * fx + fy * fy + fz * fz);
  const q = frameQuat(fx, fy, fz, fm.bank);
  const down = rotate(q, 0, -depth / 2, 0);
  const pos: [number, number, number] = [(a[0] + b[0]) / 2 + down[0], (a[1] + b[1]) / 2 + down[1], (a[2] + b[2]) / 2 + down[2]];
  return box(id, pos, q, halfW, depth / 2, L / 2 + ext, material, visual);
}

/** Deterministic hash → [0, 1) for render-only variety (FNV of a string + index). */
export function hash01(key: string, i: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 0x01000193);
  h = Math.imul(h ^ i, 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
