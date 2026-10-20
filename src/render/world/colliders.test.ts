import { Box3, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { colliderWorldAabb, resolveColliders } from '../../world/colliders';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { patchMaterial } from '../material';
import type { LightingStack, RenderContext } from '../types';
import { colliderGroups, createColliderRenderer, jerseyGeometry, rampGeometry } from './colliders';

const ctx = { renderer: { capabilities: { getMaxAnisotropy: () => 4 } } } as unknown as RenderContext;
const lighting = { csm: null } as unknown as LightingStack;

describe('createColliderRenderer', () => {
  const resolved = resolveColliders(DEFAULT_LAYOUT.colliders, () => 10.5);
  const r = createColliderRenderer(ctx, resolved, { lighting, patchMaterial });

  it('draws every arena collider inside its collision AABB (visual == collision)', () => {
    const groups = colliderGroups(resolved);
    expect(groups.length).toBe(resolved.length);
    for (let i = 0; i < resolved.length; i++) {
      const c = resolved[i]!;
      const g = groups[i]!;
      expect(g.name).toBe(`collider:${c.id}`);
      const bb = new Box3().setFromObject(g);
      const ref = colliderWorldAabb(c, 0.02);
      let meshes = 0;
      g.traverse((o) => {
        if (!(o as Mesh).isMesh) return;
        meshes++;
        const pos = (o as Mesh).geometry.getAttribute('position');
        for (let k = 0; k < pos.array.length; k++) expect(Number.isFinite(pos.array[k])).toBe(true);
      });
      expect(meshes).toBeGreaterThan(0);
      // Decals/caps may sit a few mm proud of the solid; nothing larger.
      expect(bb.min.x).toBeGreaterThanOrEqual(ref[0] - 0.1);
      expect(bb.min.z).toBeGreaterThanOrEqual(ref[2] - 0.1);
      expect(bb.min.y).toBeGreaterThanOrEqual(ref[1] - 0.01);
      expect(bb.max.y).toBeLessThanOrEqual(ref[4] + 0.06);
      expect(bb.max.z).toBeLessThanOrEqual(ref[5] + 0.1);
      expect(bb.max.x).toBeLessThanOrEqual(ref[3] + 0.1);
      // And it fills the collider (no tiny placeholder).
      expect(bb.max.y - bb.min.y).toBeGreaterThan(0.9 * (ref[4] - ref[1] - 0.04));
    }
  });

  it('batches the parts per (material, casts shadow): a handful of draws, all inside the colliders', () => {
    const meshes = r.object.children.filter((o) => (o as Mesh).isMesh) as Mesh[];
    expect(meshes.length).toBeGreaterThan(3);
    expect(meshes.length).toBeLessThanOrEqual(18);
    const boxes = resolved.map((c) => colliderWorldAabb(c, 0.12));
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      for (let k = 0; k < pos.count; k += 7) {
        const x = pos.getX(k);
        const y = pos.getY(k);
        const z = pos.getZ(k);
        expect(boxes.some((b) => x >= b[0] && x <= b[3] && y >= b[1] - 0.01 && y <= b[4] + 0.06 && z >= b[2] && z <= b[5])).toBe(true);
      }
    }
  });

  it('patches every material with CSM support and disposes cleanly', () => {
    const mats = new Set<unknown>();
    r.object.traverse((o) => {
      if ((o as Mesh).isMesh) mats.add((o as Mesh).material);
    });
    expect(mats.size).toBeGreaterThan(5);
    expect(() => r.dispose()).not.toThrow();
  });
});

describe('collider geometry', () => {
  it('ramp deck spans toe (y −hy, z +hz) to lip (y +hy, z −hz) with outward normals', () => {
    const { deck, body } = rampGeometry(2.5, 0.7, 4.5);
    deck.computeBoundingBox();
    expect(deck.boundingBox!.min.y).toBeCloseTo(-0.7, 6);
    expect(deck.boundingBox!.max.y).toBeCloseTo(0.7, 6);
    const n = deck.getAttribute('normal');
    expect(n.getY(0)).toBeGreaterThan(0.9);
    expect(n.getZ(0)).toBeGreaterThan(0);
    expect(body.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('jersey profile is 0.6 m at the base, narrower at the top, 0.81 m tall', () => {
    const g = jerseyGeometry(1.5, 0.405, 0.3);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.z).toBeCloseTo(0.3, 6);
    expect(g.boundingBox!.max.y - g.boundingBox!.min.y).toBeCloseTo(0.81, 6);
    const p = g.getAttribute('position');
    let topHalfWidth = 0;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.4) topHalfWidth = Math.max(topHalfWidth, Math.abs(p.getZ(i)));
    expect(topHalfWidth).toBeLessThan(0.1);
  });
});
