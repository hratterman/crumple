import { describe, expect, it } from 'vitest';

import { PROP_LAYOUT_MAX_INSTANCES } from '../../protocol/messages';
import { resolvePropInstances } from '../../sim/props/placement';
import { colliderWorldAabb, resolveColliders } from '../../world/colliders';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { validateLayout } from '../../world/validate';

const flat = (): number => 10.5;

describe('DEFAULT_LAYOUT props', () => {
  it('validate and resolve within the instance budget, proxies apart', () => {
    expect(() => validateLayout(DEFAULT_LAYOUT)).not.toThrow();
    const inst = resolvePropInstances(DEFAULT_LAYOUT.props, flat);
    expect(inst.length).toBeGreaterThan(150);
    expect(inst.length).toBeLessThanOrEqual(PROP_LAYOUT_MAX_INSTANCES);
    const keys = new Set(inst.map((i) => i.prop));
    for (const k of ['cone', 'barrel', 'tire', 'boxCardboard', 'boxWood', 'signPost', 'lightPole', 'concreteBlock']) expect(keys.has(k as never)).toBe(true);
  }, 60_000);

  it('no prop proxy intersects a static collider', () => {
    const inst = resolvePropInstances(DEFAULT_LAYOUT.props, flat);
    const cols = resolveColliders(DEFAULT_LAYOUT.colliders, flat);
    for (const p of inst) {
      for (const c of cols) {
        const b = colliderWorldAabb(c);
        const a = p.aabb;
        const hit = a[0] < b[3] && b[0] < a[3] && a[1] < b[4] && b[1] < a[4] && a[2] < b[5] && b[2] < a[5];
        expect(hit, `${p.id} vs ${c.id}`).toBe(false);
      }
    }
  }, 60_000);
});
