import { describe, expect, it } from 'vitest';
import { integrateNodes } from './integrator';
import { createSimState } from './state';

const DT = 1 / 2000;

describe('integrateNodes (semi-implicit Euler)', () => {
  it('projectile matches the discrete closed form within 1e-9 over 1000 steps', () => {
    const s = createSimState(1, 0);
    s.nodeCount = 1;
    s.invMass[0] = 1 / 3;
    const p0 = [1, 2, -3];
    const v0 = [4, 10, -2];
    const g = [0.5, -9.81, 0.25];
    s.posX[0] = p0[0]!;
    s.posY[0] = p0[1]!;
    s.posZ[0] = p0[2]!;
    s.velX[0] = v0[0]!;
    s.velY[0] = v0[1]!;
    s.velZ[0] = v0[2]!;
    const N = 1000;
    for (let n = 0; n < N; n++) integrateNodes(s, 0, 1, DT, g[0]!, g[1]!, g[2]!);
    const t = N * DT;
    const pos = [s.posX[0]!, s.posY[0]!, s.posZ[0]!];
    const vel = [s.velX[0]!, s.velY[0]!, s.velZ[0]!];
    for (let a = 0; a < 3; a++) {
      // v_n = v0 + g·t ; p_n = p0 + v0·t + ½·g·t·(t + dt)  (symplectic Euler, exact)
      expect(Math.abs(vel[a]! - (v0[a]! + g[a]! * t))).toBeLessThan(1e-9);
      expect(Math.abs(pos[a]! - (p0[a]! + v0[a]! * t + 0.5 * g[a]! * t * (t + DT)))).toBeLessThan(1e-9);
      // ...which is the continuous parabola up to the O(dt) term ½·g·t·dt.
      const cont = p0[a]! + v0[a]! * t + 0.5 * g[a]! * t * t;
      expect(Math.abs(pos[a]! - cont)).toBeLessThanOrEqual(Math.abs(0.5 * g[a]! * t * DT) + 1e-9);
    }
  });

  it('applies force × invMass and zeroes the accumulators', () => {
    const s = createSimState(1, 0);
    s.nodeCount = 1;
    s.invMass[0] = 0.5;
    s.frcX[0] = 10;
    s.frcY[0] = -4;
    s.frcZ[0] = 2;
    integrateNodes(s, 0, 1, DT, 0, 0, 0);
    expect(s.velX[0]).toBeCloseTo(5 * DT, 15);
    expect(s.velY[0]).toBeCloseTo(-2 * DT, 15);
    expect(s.velZ[0]).toBeCloseTo(1 * DT, 15);
    expect(s.posX[0]).toBeCloseTo(5 * DT * DT, 15);
    expect([s.frcX[0], s.frcY[0], s.frcZ[0]]).toEqual([0, 0, 0]);
  });

  it('pinned nodes (invMass 0) stay put under force and gravity', () => {
    const s = createSimState(1, 0);
    s.nodeCount = 1;
    s.posY[0] = 7;
    s.velY[0] = 3;
    for (let n = 0; n < 100; n++) {
      s.frcY[0] = 1e6;
      integrateNodes(s, 0, 1, DT, 0, -9.81, 0);
    }
    expect(s.posY[0]).toBe(7);
    expect(s.velY[0]).toBe(0);
    expect(s.frcY[0]).toBe(0);
  });

  it('only touches nodes in [first, first+count)', () => {
    const s = createSimState(4, 0);
    s.nodeCount = 4;
    for (let i = 0; i < 4; i++) {
      s.invMass[i] = 1;
      s.frcX[i] = 1;
    }
    integrateNodes(s, 1, 2, DT, 0, -9.81, 0);
    expect(s.velY[0]).toBe(0);
    expect(s.frcX[0]).toBe(1);
    expect(s.velY[3]).toBe(0);
    expect(s.frcX[3]).toBe(1);
    expect(s.velY[1]).toBeCloseTo(-9.81 * DT, 15);
    expect(s.velY[2]).toBeCloseTo(-9.81 * DT, 15);
  });
});
