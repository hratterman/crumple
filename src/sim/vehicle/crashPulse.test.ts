/**
 * R-CRASH crash pulse (crash.ts `crashPulse`): CFC 60 peak deceleration, stop time and the occupant load
 * criterion, checked on a pulse with a closed-form answer — a constant deceleration a from v0, long enough
 * that the compartment is still decelerating when the occupant has been restrained. The virtual
 * occupant flies free until it leads by 65 mm (t1 = √(0.13 / a)), then a constant deceleration A must bring
 * its 0.235 m of remaining relative travel to rest: A = a + (a·t1)² / 0.47 = a·(1 + 0.13 / 0.47) ≈ 1.277·a.
 */
import { describe, expect, it } from 'vitest';
import { crashPulse } from './crash';

const G = 9.81;
const DT = 1 / 2000;

function constantPulse(v0: number, a: number, durationS = 0.3): number[] {
  const v: number[] = [];
  for (let i = 0; i * DT < durationS; i++) v.push(Math.max(0, v0 - a * i * DT));
  return v;
}

describe('crash pulse', () => {
  it('a constant 10 g stop from 108 km/h: peak 10 g, stop v0 / a, OLC 1.277 × 10 g', () => {
    // long enough that the compartment is still decelerating when the occupant is restrained (t2 ≈ 0.17 s)
    const a = 10 * G;
    const v0 = 30;
    const p = crashPulse(constantPulse(v0, a, 0.4), DT);
    expect(p.tStop).toBeCloseTo(v0 / a, 3);
    expect(p.peakG).toBeGreaterThan(9.5);
    expect(p.peakG).toBeLessThan(11);
    expect(p.olcG).toBeCloseTo(10 * (1 + 0.13 / 0.47), 1);
  });

  it('a car that never stops reports an infinite stop time', () => {
    const p = crashPulse(constantPulse(15, 10 * G, 0.1), DT);
    expect(p.tStop).toBe(Infinity);
  });
});
