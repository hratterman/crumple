import { describe, expect, it } from 'vitest';
import { SIGNAL_TICK_HZ, signalAspect, ticksToGreen, type SignalPlan } from './signals';

const s = (sec: number): number => Math.round(sec * SIGNAL_TICK_HZ);
const plan: SignalPlan = {
  junction: 'j',
  pos: [0, 0],
  cycleTicks: s(24 + 3.5 + 1.5 + 14 + 3.5 + 1.5),
  offsetTicks: 0,
  phases: [
    { greenTicks: s(24), amberTicks: s(3.5), allRedTicks: s(1.5) },
    { greenTicks: s(14), amberTicks: s(3.5), allRedTicks: s(1.5) },
  ],
  legs: [
    { road: 'a', side: -1, phase: 0, stop: [0, 0, 0], dir: [1, 0], halfWidth: 4 },
    { road: 'b', side: 1, phase: 1, stop: [0, 0, 0], dir: [0, 1], halfWidth: 4 },
  ],
};

describe('signals', () => {
  it('runs green → amber → all-red per phase; the two phases never show green together', () => {
    expect(signalAspect(plan, 0, 0)).toBe('green');
    expect(signalAspect(plan, 1, 0)).toBe('red');
    expect(signalAspect(plan, 0, s(24) + 1)).toBe('amber');
    expect(signalAspect(plan, 0, s(27.6))).toBe('red');
    expect(signalAspect(plan, 1, s(27.6))).toBe('red');
    expect(signalAspect(plan, 1, s(29.1))).toBe('green');
    expect(signalAspect(plan, 1, s(43.2))).toBe('amber');
    for (let t = 0; t < plan.cycleTicks * 2; t += 97) {
      const a = signalAspect(plan, 0, t);
      const b = signalAspect(plan, 1, t);
      expect(a !== 'red' && b !== 'red').toBe(false);
    }
  });
  it('wraps the cycle, honours the offset and counts ticks to green', () => {
    expect(signalAspect(plan, 0, plan.cycleTicks)).toBe('green');
    expect(signalAspect(plan, 0, -1)).toBe('red');
    expect(signalAspect({ ...plan, offsetTicks: s(24) + 10 }, 0, 0)).toBe('amber');
    expect(ticksToGreen(plan, 0, 5)).toBe(0);
    expect(ticksToGreen(plan, 1, 0)).toBe(s(24 + 3.5 + 1.5));
    expect(ticksToGreen(plan, 0, s(30))).toBe(plan.cycleTicks - s(30));
  });
});
