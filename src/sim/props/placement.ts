/**
 * Layout prop expansion (P5, U1). CONTRACT: ResolvePropInstances in ./types.
 * PURE + deterministic (main and the worker both call it on identical
 * terrain): placements in declaration order → row copies (ascending) →
 * stack levels (bottom → top).
 *
 * Y RESOLUTION (U1 note in docs/CONTRACTS.md): `y: null` resolves to the
 * HIGHEST terrain height among the placement point and the four corners of
 * the (rotated) proxy footprint, so a prop on a slope never starts with its
 * uphill base nodes buried (a 1 cm penetration pops a light node at
 * several m/s); the downhill side settles the few mm when it wakes.
 */
import { PROP_LAYOUT_ID_BASE, PROP_LAYOUT_MAX_INSTANCES } from '../../protocol/messages';
import { WorldLayoutError, type PropPlacement } from '../../world/types';
import { getPropDef, isPropKey } from './catalog';
import type { PropDef, PropInstance, ResolvePropInstances } from './types';

/** Overlap tolerance for touching proxies (stacks, rows at exact pitch), m. */
const OVERLAP_EPS = 1e-3;
/** Facing vectors must be unit to this tolerance. */
const UNIT_EPS = 1e-3;

const fail = (msg: string): never => {
  throw new WorldLayoutError(`props: ${msg}`);
};

/**
 * Yaw quat [x, y, z, w] turning local −Z onto the unit plan direction
 * (fx, fz), sqrt only (contract formula; (0, −1) → identity).
 */
export function facingQuat(fx: number, fz: number): [number, number, number, number] {
  const c = Math.sqrt(Math.max(0, (1 - fz) / 2));
  const s = (fx > 0 ? -1 : 1) * Math.sqrt(Math.max(0, (1 + fz) / 2));
  return [0, s, 0, c];
}

/** World AABB of a prop's proxy under a yaw-only transform. */
export function proxyAabb(def: PropDef, pos: readonly number[], quat: readonly number[]): [number, number, number, number, number, number] {
  const s = quat[1]!;
  const c = quat[3]!;
  // Yaw rotation from (0, s, 0, c): x' = cos·x + sin·z, z' = −sin·x + cos·z.
  const cos = 1 - 2 * s * s;
  const sin = 2 * s * c;
  const [cx, cy, cz] = def.proxy.center;
  const [hx, hy, hz] = def.proxy.halfExtents;
  const wx = Math.abs(cos) * hx + Math.abs(sin) * hz;
  const wz = Math.abs(sin) * hx + Math.abs(cos) * hz;
  const px = pos[0]! + cos * cx + sin * cz;
  const pz = pos[2]! - sin * cx + cos * cz;
  const py = pos[1]! + cy;
  return [px - wx, py - hy, pz - wz, px + wx, py + hy, pz + wz];
}

/** Highest ground under a prop's footprint at (x, z): the point itself and the 4 corners of its rotated proxy AABB. */
export function footprintHeight(def: PropDef, x: number, z: number, quat: readonly number[], heightAt: (x: number, z: number) => number): number {
  const box = proxyAabb(def, [x, 0, z], quat);
  let y = heightAt(x, z);
  const corners: readonly (readonly [number, number])[] = [
    [box[0], box[2]],
    [box[3], box[2]],
    [box[3], box[5]],
    [box[0], box[5]],
  ];
  for (const [cx, cz] of corners) {
    const h = heightAt(cx, cz);
    if (h > y) y = h;
  }
  return y;
}

function vec2(v: unknown, where: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    fail(`${where}: expected finite [x, z]`);
  }
  return v as [number, number];
}

export const resolvePropInstances: ResolvePropInstances = (placements, heightAt) => {
  if (!Array.isArray(placements)) fail('placements must be an array');
  const out: PropInstance[] = [];
  const ids = new Set<string>();
  placements.forEach((p: PropPlacement, pi) => {
    const where = `props[${pi}] '${String(p?.id)}'`;
    if (!p || typeof p !== 'object') fail(`${where}: not an object`);
    if (typeof p.id !== 'string' || p.id.length === 0) fail(`${where}: empty id`);
    if (ids.has(p.id)) fail(`${where}: duplicate id`);
    ids.add(p.id);
    if (!isPropKey(p.prop)) fail(`${where}: unknown prop key '${String(p.prop)}'`);
    const def = getPropDef(p.prop as PropDef['key']);
    const pos = p.pos;
    if (!Array.isArray(pos) || pos.length !== 3) fail(`${where}.pos: expected [x, y|null, z]`);
    const [x0, y0, z0] = pos;
    if (!Number.isFinite(x0) || !Number.isFinite(z0) || (y0 !== null && !Number.isFinite(y0))) fail(`${where}.pos: not finite`);
    const [fx, fz] = p.facing === undefined ? [0, -1] : vec2(p.facing, `${where}.facing`);
    if (Math.abs(Math.sqrt(fx * fx + fz * fz) - 1) > UNIT_EPS) fail(`${where}.facing must be a unit vector`);
    const stack = p.stack ?? 1;
    if (!Number.isInteger(stack) || stack < 1) fail(`${where}.stack must be an integer >= 1`);
    if (stack > 1 && !(def.stackHeight > 0)) fail(`${where}: '${def.key}' is not stackable`);
    const count = p.row?.count ?? 1;
    if (!Number.isInteger(count) || count < 1) fail(`${where}.row.count must be an integer >= 1`);
    const [sx, sz] = p.row ? vec2(p.row.step, `${where}.row.step`) : [0, 0];
    const quat = facingQuat(fx, fz);
    const single = count === 1 && stack === 1;
    for (let r = 0; r < count; r++) {
      const x = x0 + r * sx;
      const z = z0 + r * sz;
      const y = y0 === null ? footprintHeight(def, x, z, quat, heightAt) : y0;
      for (let l = 0; l < stack; l++) {
        if (out.length >= PROP_LAYOUT_MAX_INSTANCES) fail(`more than ${PROP_LAYOUT_MAX_INSTANCES} instances`);
        const index = out.length;
        const tpos: [number, number, number] = [x, y + l * def.stackHeight, z];
        const inst: PropInstance = {
          index,
          objectId: PROP_LAYOUT_ID_BASE + index,
          id: single ? p.id : `${p.id}.${r}.${l}`,
          prop: def.key,
          transform: { pos: tpos, quat: [quat[0], quat[1], quat[2], quat[3]] },
          aabb: proxyAabb(def, tpos, quat),
          surface: def.surface,
          material: def.material,
        };
        if (p.padId !== undefined) inst.padId = p.padId;
        out.push(inst);
      }
    }
  });
  // Proxies must not overlap (touching within OVERLAP_EPS is fine: stacks, rows at exact pitch).
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!.aabb;
    for (let j = i + 1; j < out.length; j++) {
      const b = out[j]!.aabb;
      if (
        a[0] < b[3] - OVERLAP_EPS &&
        b[0] < a[3] - OVERLAP_EPS &&
        a[1] < b[4] - OVERLAP_EPS &&
        b[1] < a[4] - OVERLAP_EPS &&
        a[2] < b[5] - OVERLAP_EPS &&
        b[2] < a[5] - OVERLAP_EPS
      ) {
        fail(`'${out[i]!.id}' overlaps '${out[j]!.id}'`);
      }
    }
  }
  return out;
};
