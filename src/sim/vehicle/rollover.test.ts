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
    // > 4° (was > 5°): the frame nodes the roll is read from no longer flex with the imposed roll (rigid
    // shell, feel pass): 4.8° is the body's true roll after 0.15 s.
    expect(small.samples[small.samples.length - 1]!.rollDeg).toBeGreaterThan(4);
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

  /*
   * R-CRASH roof crush (roof.ts / defs/sedan.ts "roof strength"; SWR 3.8 in roofStrength.test.ts). Real
   * rollovers dent a roof 5–20 cm with the A-pillar buckling (NHTSA dolly / FMVSS 216 correlation:
   * SWR 3.5–4 roofs crush ≈ 10 cm in a 2–4 quarter-turn roll); before R-CRASH no roll or drop dented the
   * sedan's roof (the safety cell's rigid shell held it; ≤ 0.2 cm permanent).
   */
  it('roof crush: an inverted 1 m drop dents the roof 5–20 cm and it stays dented; a 0.5 m drop less', () => {
    const roof: CrushProbe[] = [
      { name: 'AL', roof: ['s6_rf_L'], floor: ['s6_fl_L'], across: ['s6_sl_L', 's6_sl_R'] },
      { name: 'AR', roof: ['s6_rf_R'], floor: ['s6_fl_R'], across: ['s6_sl_L', 's6_sl_R'] },
      { name: 'B', roof: ['s7_rf_L', 's7_rf_R'], floor: ['s7_fl_L', 's7_fl_R'], across: ['s7_sl_L', 's7_sl_R'] },
    ];
    const big = runRollover(SEDAN, { speedKmh: 30, rollRate: 0, invertedDropM: 1.0, durationS: 3, probes: { roof } });
    const small = runRollover(SEDAN, { speedKmh: 50, rollRate: 0, invertedDropM: 0.5, durationS: 3, probes: { roof } });
    console.log(
      `[roof crush] inverted drop 1.0 m: ${(big.crush.roof! * 100).toFixed(1)} cm (${big.worst.roof}, peak ${(big.crushMax.roof! * 100).toFixed(1)}); ` +
        `0.5 m: ${(small.crush.roof! * 100).toFixed(1)} cm (peak ${(small.crushMax.roof! * 100).toFixed(1)})`,
    );
    expect(big.finite && small.finite).toBe(true);
    expect(big.crush.roof).toBeGreaterThan(0.05);
    expect(big.crush.roof).toBeLessThan(0.2);
    expect(small.crush.roof).toBeGreaterThan(0.01);
    expect(small.crush.roof).toBeLessThan(big.crush.roof!);
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
