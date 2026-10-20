/**
 * Flat-track tyre bench sanity (tyreBench.ts): the load servo holds the
 * commanded load, a free-rolling tyre at α = 0 makes no side force, the
 * cornering force opposes the slip and is odd in α, and the bench's
 * steady-state force balance is consistent (Fz matches the target within 2 %).
 */
import { describe, expect, it } from 'vitest';
import { SEDAN } from '../defs/sedan';
import { benchStep, createTyreBench } from './tyreBench';
import { DEG } from './tyreSweeps';

function mean(b: ReturnType<typeof createTyreBench>, ticks: number): { fx: number; fy: number; fz: number; mz: number } {
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let mz = 0;
  for (let i = 0; i < ticks; i++) {
    benchStep(b);
    fx += b.fx;
    fy += b.fy;
    fz += b.fz;
    mz += b.mz;
  }
  return { fx: fx / ticks, fy: fy / ticks, fz: fz / ticks, mz: mz / ticks };
}

describe('tyre bench', () => {
  it('holds the load and rolls straight at α = 0', () => {
    const b = createTyreBench(SEDAN.wheels[0]!, { load: 4000, speed: 15 });
    const m = mean(b, 1000);
    expect(Math.abs(m.fz - 4000) / 4000).toBeLessThan(0.02);
    expect(Math.abs(m.fy)).toBeLessThan(150);
    expect(m.fx).toBeLessThan(0); // rolling resistance drags
  });

  it('cornering force opposes the slip and is odd in α', () => {
    const pos = createTyreBench(SEDAN.wheels[0]!, { load: 4000, speed: 15 });
    const neg = createTyreBench(SEDAN.wheels[0]!, { load: 4000, speed: 15 });
    pos.alpha = 3 * DEG;
    neg.alpha = -3 * DEG;
    mean(pos, 400);
    mean(neg, 400);
    const p = mean(pos, 800);
    const n = mean(neg, 800);
    expect(p.fy).toBeGreaterThan(500);
    expect(n.fy).toBeLessThan(-500);
    expect(Math.abs(p.fy + n.fy) / p.fy).toBeLessThan(0.15);
    // aligning moment turns the wheel toward its velocity at small slip
    expect(p.mz).toBeGreaterThan(0);
    expect(n.mz).toBeLessThan(0);
  });
});
