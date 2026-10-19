import { describe, expect, it } from 'vitest';
import { quatRotateVec3, type Vec3 } from '../core/math';
import { clearOfBoxes, placeOnGround, repairSpot, SPAWN_DROP_MAX_M, yawOf, yawOfQuat, type RestPose } from './spawn';

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

describe('repairSpot', () => {
  const flat = { heightAt: (): number => 0 };
  it('keeps the spot when clear, backs off along the heading out of a prop spawn box', () => {
    // Car at the origin facing −Z (yaw 0); a barrel box 1 m ahead of its nose (z −3.4..−2.6) does not block.
    const ahead = [-0.3, 0, -3.4, 0.3, 1, -2.6] as const;
    expect(repairSpot(box, flat, 0, 0, 0, [ahead])!.pos[2]).toBe(0);
    // A box under the car: back off (+Z for yaw 0) until the footprint (z ±2.3 incl. radius-free nodes ±2) clears it by 0.4 m.
    const under = [-0.3, 0, -0.3, 0.3, 1, 0.3] as const;
    const t = repairSpot(box, flat, 0, 0, 0, [under])!;
    expect(t.pos[0]).toBe(0);
    expect(t.pos[2]).toBeGreaterThanOrEqual(2.7);
    expect(clearOfBoxes(box, t.pos[0], t.pos[1], t.pos[2], 0, [under])).toBe(true);
    // Heading −X (yaw π/2): backing off moves +X.
    const t2 = repairSpot(box, flat, 0, 0, Math.PI / 2, [under])!;
    expect(t2.pos[0]).toBeGreaterThan(2.6);
    expect(Math.abs(t2.pos[2])).toBeLessThan(1e-9);
  });
  it('ignores boxes far above / below and returns null when boxed in', () => {
    const high = [-0.3, 10, -0.3, 0.3, 11, 0.3] as const;
    expect(repairSpot(box, flat, 0, 0, 0, [high])!.pos[2]).toBe(0);
    const wall = [-50, 0, -50, 50, 1, 50] as const;
    expect(repairSpot(box, flat, 0, 0, 0, [wall], 5)).toBeNull();
  });
});

describe('yawOfQuat', () => {
  it('recovers the yaw placeOnGround encoded (P6 swap keeps the heading)', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2.5, -1.2, -3]) {
      const t = placeOnGround(box, { heightAt: () => 0 }, 0, 0, yaw);
      const back = yawOfQuat(t.quat);
      expect(Math.atan2(Math.sin(back - yaw), Math.cos(back - yaw))).toBeCloseTo(0, 9);
    }
  });
});
