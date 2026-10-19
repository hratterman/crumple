import { describe, expect, it } from 'vitest';
import { quatRotateVec3, type Vec3 } from '../core/math';
import { placeOnGround, SPAWN_DROP_MAX_M, yawOf, type RestPose } from './spawn';

const box: RestPose = {
  nodeCount: 4,
  // a 2 × 4 m footprint, nodes at y 0.3 with radius 0.3 (bottom at y = 0)
  nodePos: [-1, 0.3, -2, 1, 0.3, -2, -1, 0.3, 2, 1, 0.3, 2],
  nodeRadius: [0.3, 0.3, 0.3, 0.3],
};

function minGap(rest: RestPose, ground: (x: number, z: number) => number, t: ReturnType<typeof placeOnGround>): number {
  let gap = Infinity;
  for (let i = 0; i < rest.nodeCount; i++) {
    const p = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [rest.nodePos[3 * i]!, rest.nodePos[3 * i + 1]!, rest.nodePos[3 * i + 2]!]);
    const x = p[0] + t.pos[0];
    const y = p[1] + t.pos[1];
    const z = p[2] + t.pos[2];
    gap = Math.min(gap, y - rest.nodeRadius[i]! - ground(x, z));
  }
  return gap;
}

describe('placeOnGround', () => {
  it('drops the lowest node `drop` above a sloped ground for any heading', () => {
    const ground = (x: number, z: number): number => 10 + 0.2 * x - 0.1 * z;
    for (const yaw of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      const t = placeOnGround(box, { heightAt: ground }, 5, -3, yaw, 0.06);
      expect(t.pos[0]).toBe(5);
      expect(t.pos[2]).toBe(-3);
      expect(minGap(box, ground, t)).toBeCloseTo(0.06, 9);
    }
  });

  it('clamps the drop height', () => {
    const flat = (): number => 0;
    expect(minGap(box, flat, placeOnGround(box, { heightAt: flat }, 0, 0, 0, 30))).toBeCloseTo(SPAWN_DROP_MAX_M, 9);
  });

  it('faces the yaw convention (0 → −Z, π/2 → −X)', () => {
    for (const yaw of [0, Math.PI / 2, 1]) {
      const t = placeOnGround(box, { heightAt: () => 0 }, 0, 0, yaw);
      const f = quatRotateVec3([0, 0, 0] as Vec3, t.quat, [0, 0, -1]);
      expect(f[0]).toBeCloseTo(-Math.sin(yaw), 9);
      expect(f[2]).toBeCloseTo(-Math.cos(yaw), 9);
      expect(yawOf(f[0], f[2])).toBeCloseTo(yaw, 9);
    }
  });
});
