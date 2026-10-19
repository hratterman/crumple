/**
 * rollover.ts harness self-tests on the sedan (the box truck's numbers live in
 * boxtruck.test.ts): sign convention, a low-CG car that grips instead of
 * tipping, and the tripped / roof-landing set-ups.
 */
import { describe, expect, it } from 'vitest';
import { SIM_HZ } from '../engine';
import { SEDAN } from './defs/sedan';
import { createHandlingSim, stepN } from './handling';
import { rollAngleDeg, runJTurn, runRollover, runSteadyLateral, type CrushProbe } from './rollover';

const ROOF: CrushProbe[] = [{ name: 's7', roof: ['s7_rf_L', 's7_rf_R'], floor: ['s7_fl_L', 's7_fl_R'], across: ['s7_fl_L', 's7_fl_R'] }];

describe('rollover harness', { timeout: 300_000 }, () => {
  it('reads ≈ 0° roll on a parked car', () => {
    const sim = createHandlingSim({ def: SEDAN });
    stepN(sim, SIM_HZ);
    expect(Math.abs(rollAngleDeg(sim))).toBeLessThan(0.5);
  });

  it('a roll rate to the right reads positive and a big one rolls the car over; finite throughout', () => {
    const small = runRollover(SEDAN, { speedKmh: 30, rollRate: 1.5, durationS: 0.15, probes: { roof: ROOF } });
    expect(small.samples[small.samples.length - 1]!.rollDeg).toBeGreaterThan(5);
    const big = runRollover(SEDAN, { speedKmh: 50, rollRate: -14, durationS: 2.5, probes: { roof: ROOF } });
    expect(big.finite).toBe(true);
    expect(big.maxRollDeg).toBeGreaterThan(60);
    expect(big.samples.some((s) => s.rollDeg < -60)).toBe(true);
  });

  it('roof landing: upside down from 0.5 m at 50 km/h, the roof probe reports crush', () => {
    const r = runRollover(SEDAN, { speedKmh: 50, rollRate: 0, invertedDropM: 0.5, durationS: 2, probes: { roof: ROOF } });
    expect(r.finite).toBe(true);
    expect(r.finalRollDeg).toBeGreaterThan(150);
    expect(r.crushMax.roof).toBeGreaterThan(0);
    expect(r.worst.roof).toBe('s7');
  });

  it('the low sedan holds 0.35 g with a few degrees of roll and all four wheels down; a 40 km/h full-lock J-turn does not tip it', () => {
    const st = runSteadyLateral(SEDAN, { latG: 0.35 });
    expect(st.latG).toBeGreaterThan(0.32);
    expect(st.rollDeg).toBeLessThan(5);
    expect(st.lifted).toBe(false);
    const j = runJTurn(SEDAN, { speedKmh: 40 });
    expect(j.rolled).toBe(false);
    expect(j.maxRollDeg).toBeLessThan(12);
  });
});
