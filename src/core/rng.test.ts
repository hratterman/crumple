import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('createRng', () => {
  it('is deterministic: same seed, same sequence', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a.float()).toBe(b.float());
    }
  });

  it('different seeds give different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (a.float() === b.float()) same++;
    }
    expect(same).toBeLessThan(3);
  });

  it('adjacent raw seeds are uncorrelated (first draws differ)', () => {
    const firsts = new Set<number>();
    for (let seed = 0; seed < 64; seed++) {
      firsts.add(createRng(seed).float());
    }
    expect(firsts.size).toBe(64);
  });

  it('float() is in [0, 1) with sane mean and spread', () => {
    const rng = createRng(42);
    const n = 20000;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = rng.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it('range(a, b) stays in [a, b)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng.range(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
    }
  });

  it('int(a, b) is inclusive on both ends and hits every value', () => {
    const rng = createRng(99);
    const counts = new Map<number, number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(2, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(6);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (let v = 2; v <= 6; v++) {
      expect(counts.get(v) ?? 0).toBeGreaterThan(0);
    }
  });

  it('pick draws every element and throws on empty', () => {
    const rng = createRng(5);
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rng.pick(items));
    expect(seen.size).toBe(3);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  describe('fork', () => {
    it('same (seed, streamId) yields the same stream', () => {
      const a = createRng(123).fork(7);
      const b = createRng(123).fork(7);
      for (let i = 0; i < 100; i++) expect(a.float()).toBe(b.float());
    });

    it('is independent of parent consumption', () => {
      const parentA = createRng(555);
      const parentB = createRng(555);
      // Drain one parent heavily before forking.
      for (let i = 0; i < 1000; i++) parentB.float();
      const forkA = parentA.fork(3);
      const forkB = parentB.fork(3);
      for (let i = 0; i < 100; i++) expect(forkA.float()).toBe(forkB.float());
    });

    it('different streamIds give different streams', () => {
      const parent = createRng(321);
      const f0 = parent.fork(0);
      const f1 = parent.fork(1);
      let same = 0;
      for (let i = 0; i < 100; i++) {
        if (f0.float() === f1.float()) same++;
      }
      expect(same).toBeLessThan(3);
    });

    it('fork stream differs from parent stream', () => {
      const seq = (r: { float(): number }): number[] =>
        Array.from({ length: 50 }, () => r.float());
      const parentSeq = seq(createRng(888));
      const forkSeq = seq(createRng(888).fork(0));
      expect(forkSeq).not.toEqual(parentSeq);
    });

    it('drawing from a fork does not perturb the parent', () => {
      const a = createRng(2024);
      const b = createRng(2024);
      const forked = a.fork(1);
      for (let i = 0; i < 100; i++) forked.float();
      for (let i = 0; i < 100; i++) expect(a.float()).toBe(b.float());
    });
  });
});
