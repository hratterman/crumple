import { describe, expect, it } from 'vitest';
import { MaterialId } from '../protocol/messages';
import { colliderVisual, colliderWorldAabb, quatToMatrix, resolveColliders } from './colliders';
import { DEFAULT_LAYOUT } from './layout';
import { WorldLayoutError, type ColliderDef } from './types';

const flat = (): number => 10;
const box = (over: Partial<ColliderDef> = {}): ColliderDef => ({
  id: 'b',
  kind: 'box',
  pos: [0, null, 0],
  quat: [0, 0, 0, 1],
  size: [1, 0.5, 2],
  material: MaterialId.concrete,
  ...over,
});

describe('resolveColliders', () => {
  it('rests y-null solids on the terrain by kind', () => {
    const r = resolveColliders(
      [
        box(),
        box({ id: 'c', kind: 'cylinder', size: [0.15, 3, 0] }),
        box({ id: 's', kind: 'sphere', size: [0.7, 0, 0] }),
        box({ id: 'p', kind: 'plane', size: [2, 0, 2] }),
        box({ id: 'r', kind: 'ramp', size: [2.5, 0.7, 4.5] }),
        box({ id: 'f', pos: [1, 4, 2] }),
      ],
      flat,
    );
    expect(r.map((c) => c.pos[1])).toEqual([10.5, 13, 10.7, 10, 10.7, 4]);
    expect(r[0]!.quat).toEqual([0, 0, 0, 1]);
  });

  it('rejects duplicates, non-unit quats, bad sizes, tilted y-null and bad materials', () => {
    const bad: ColliderDef[][] = [
      [box(), box()],
      [box({ quat: [0, 0, 0, 1.01] })],
      [box({ size: [1, 0, 1] })],
      [box({ kind: 'cylinder', size: [0, 1, 0] })],
      [box({ quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] })],
      [box({ material: 99 as MaterialId })],
      [box({ kind: 'cone' as ColliderDef['kind'] })],
    ];
    for (const set of bad) expect(() => resolveColliders(set, flat)).toThrow(WorldLayoutError);
    // A tilted collider with explicit y is fine.
    expect(() => resolveColliders([box({ pos: [0, 2, 0], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] })], flat)).not.toThrow();
  });

  it('resolves the DEFAULT_LAYOUT arena colliders', () => {
    const r = resolveColliders(DEFAULT_LAYOUT.colliders, () => 10.5);
    expect(r.map((c) => c.id)).toContain('crashWall');
    expect(r.find((c) => c.id === 'crashWall')!.pos).toEqual([360, 11.5, 265]);
    expect(colliderVisual(r.find((c) => c.id === 'pole1')!)).toBe('pole');
  });
});

describe('collider geometry helpers', () => {
  it('quatToMatrix: yaw 90° maps local +X to world −Z', () => {
    const R = new Array<number>(9);
    const h = Math.SQRT1_2;
    quatToMatrix([0, h, 0, h], R);
    // world = R·(1,0,0) = first column
    expect(R[0]).toBeCloseTo(0, 12);
    expect(R[3]).toBeCloseTo(0, 12);
    expect(R[6]).toBeCloseTo(-1, 12);
  });

  it('world AABB of a yawed box covers its rotated extents', () => {
    const h = Math.sin(Math.PI / 8);
    const [c] = resolveColliders([box({ pos: [0, 0, 0], quat: [0, h, 0, Math.cos(Math.PI / 8)], size: [2, 1, 0.5] })], flat);
    const bb = colliderWorldAabb(c!, 0.1);
    const ext = 2 * Math.SQRT1_2 + 0.5 * Math.SQRT1_2 + 0.1;
    expect(bb[0]).toBeCloseTo(-ext, 9);
    expect(bb[3]).toBeCloseTo(ext, 9);
    expect(bb[1]).toBeCloseTo(-1.1, 9);
  });
});
