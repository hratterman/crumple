import { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { resolveColliders } from '../../world/colliders';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { SKI_JUMP_X, SKI_LANDING } from '../../world/stuntpark';
import { patchMaterial } from '../material';
import type { LightingStack, RenderContext } from '../types';
import { createStuntParkRenderer } from './stuntpark';

describe('createStuntParkRenderer', () => {
  const ground = (): number => 10.5;
  const resolved = resolveColliders(DEFAULT_LAYOUT.colliders, ground);
  const r = createStuntParkRenderer({} as RenderContext, resolved, { lighting: { csm: null } as unknown as LightingStack, patchMaterial, heightAt: ground });

  it('drapes markings over collider decks (ski landing hill) and the ground', () => {
    const [z, y] = SKI_LANDING[10]!;
    expect(r.surfaceAt(SKI_JUMP_X, z)).toBeCloseTo(y, 1);
    expect(r.surfaceAt(380, 330)).toBeCloseTo(10.5, 3);
    // kicker ramp top is above the floor, the far end of the wedge too
    expect(r.surfaceAt(462 + 4.5, 376)).toBeGreaterThan(11.6);
    expect(r.surfaceAt(462 - 4.5, 376)).toBeLessThan(10.9);
  });

  it('is a handful of static draws with legs under the elevated decks', () => {
    const meshes = r.object.children.filter((o) => (o as Mesh).isMesh) as Mesh[];
    expect(meshes.length).toBeLessThanOrEqual(4);
    expect(r.stats.legs).toBeGreaterThan(20);
    expect(r.stats.paintTriangles).toBeGreaterThan(500);
    for (const m of meshes) {
      const p = m.geometry.getAttribute('position');
      for (let i = 0; i < p.array.length; i++) expect(Number.isFinite(p.array[i])).toBe(true);
    }
  });
});
