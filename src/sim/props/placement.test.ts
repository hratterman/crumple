import { describe, expect, it } from 'vitest';
import { PROP_LAYOUT_ID_BASE, PROP_LAYOUT_MAX_INSTANCES } from '../../protocol/messages';
import { WorldLayoutError, type PropPlacement } from '../../world/types';
import { quatToMat3 } from '../state';
import { PROP_CATALOG } from './catalog';
import { facingQuat, resolvePropInstances } from './placement';

const flat = (): number => 2;

function throwsLayout(fn: () => unknown, match: RegExp): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorldLayoutError);
  expect((err as Error).message).toMatch(match);
}

describe('resolvePropInstances', () => {
  it('resolves an empty list to []', () => {
    expect(resolvePropInstances([], flat)).toEqual([]);
  });

  it('expands rows × stacks in declaration order with ids, objectIds and stack pitch', () => {
    const placements: PropPlacement[] = [
      { id: 'single', prop: 'cone', pos: [0, null, 0] },
      { id: 'wall', prop: 'tire', pos: [10, null, 0], stack: 3, row: { count: 2, step: [1, 0] }, padId: 'arena' },
    ];
    const out = resolvePropInstances(placements, flat);
    expect(out.map((p) => p.id)).toEqual(['single', 'wall.0.0', 'wall.0.1', 'wall.0.2', 'wall.1.0', 'wall.1.1', 'wall.1.2']);
    out.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.objectId).toBe(PROP_LAYOUT_ID_BASE + i);
    });
    expect(out[0]!.surface).toBe('plastic');
    expect(out[0]!.material).toBe(PROP_CATALOG.cone.material);
    expect(out[3]!.transform.pos).toEqual([10, 2 + 2 * PROP_CATALOG.tire.stackHeight, 0]);
    expect(out[4]!.transform.pos).toEqual([11, 2, 0]);
    expect(out[4]!.padId).toBe('arena');
    expect(out[0]!.padId).toBeUndefined();
  });

  it('builds yaw quats from facing with sqrt only: local −Z maps onto the facing', () => {
    for (const [fx, fz] of [
      [0, -1],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0.6, -0.8],
      [-0.28, 0.96],
    ] as const) {
      const q = facingQuat(fx, fz);
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
      const m = quatToMat3(q);
      // R·(0, 0, −1) = −(third column).
      expect(-m[2]!).toBeCloseTo(fx, 12);
      expect(-m[5]!).toBeCloseTo(0, 12);
      expect(-m[8]!).toBeCloseTo(fz, 12);
    }
    expect(facingQuat(0, -1)).toEqual([0, 0, 0, 1]);
  });

  it('resolves y null to the highest ground under the footprint; explicit y is kept', () => {
    const slope = (x: number, z: number) => 0.1 * x + 0.05 * z;
    const [a, b] = resolvePropInstances(
      [
        { id: 'a', prop: 'boxWood', pos: [0, null, 0] },
        { id: 'b', prop: 'boxWood', pos: [5, 7, 0] },
      ],
      slope,
    );
    const h = PROP_CATALOG.boxWood.proxy.halfExtents;
    expect(a!.transform.pos[1]).toBeCloseTo(0.1 * h[0] + 0.05 * h[2], 12);
    expect(b!.transform.pos[1]).toBe(7);
    expect(a!.aabb[1]).toBeCloseTo(a!.transform.pos[1], 9);
  });

  it('rejects unknown keys, stacks of non-stackable props, overlaps and too many instances', () => {
    throwsLayout(() => resolvePropInstances([{ id: 'x', prop: 'piano', pos: [0, null, 0] }], flat), /unknown prop key 'piano'/);
    throwsLayout(() => resolvePropInstances([{ id: 'x', prop: 'cone', pos: [0, null, 0], stack: 2 }], flat), /not stackable/);
    throwsLayout(
      () =>
        resolvePropInstances(
          [
            { id: 'a', prop: 'barrel', pos: [0, null, 0] },
            { id: 'b', prop: 'barrel', pos: [0.3, null, 0] },
          ],
          flat,
        ),
      /'b' overlaps 'a'|'a' overlaps 'b'/,
    );
    throwsLayout(
      () => resolvePropInstances([{ id: 'r', prop: 'cone', pos: [0, null, 0], row: { count: PROP_LAYOUT_MAX_INSTANCES + 1, step: [1, 0] } }], flat),
      /more than 256/,
    );
    throwsLayout(() => resolvePropInstances([{ id: 'f', prop: 'cone', pos: [0, null, 0], facing: [1, 1] }], flat), /unit vector/);
    throwsLayout(
      () =>
        resolvePropInstances(
          [
            { id: 'd', prop: 'cone', pos: [0, null, 0] },
            { id: 'd', prop: 'cone', pos: [5, null, 0] },
          ],
          flat,
        ),
      /duplicate id/,
    );
  });

  it('allows touching proxies: stacks and boxes in a row at exactly their width', () => {
    const w = 2 * PROP_CATALOG.boxCardboard.proxy.halfExtents[0];
    const out = resolvePropInstances([{ id: 'row', prop: 'boxCardboard', pos: [0, null, 0], stack: 2, row: { count: 4, step: [w, 0] } }], flat);
    expect(out).toHaveLength(8);
  });
});
