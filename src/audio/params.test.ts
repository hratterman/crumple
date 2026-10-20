import { describe, expect, it } from 'vitest';

import { crashGain, CRASH_IMPULSE_FULL, dopplerFactor, duckGain, engineLoad, firingHz, scrubGain, slowMoLowpass, slowMoPitch, squealGain, squealPitch, SPEED_OF_SOUND, windGain } from './params';
import { VoicePool } from './pool';

describe('audio parameter mapping', () => {
  it('rpm → firing frequency (four-stroke: rpm/60 · cyl/2)', () => {
    expect(firingHz(6000, 8)).toBe(400);
    expect(firingHz(800, 6)).toBe(40);
    expect(firingHz(3000, 4)).toBe(100);
    expect(firingHz(-5, 4)).toBe(0);
  });

  it('slip → squeal gain: silent when rolling, full by ~5.5 m/s, yields to scrub at burnout slip, 0 when unloaded', () => {
    expect(squealGain(0.5, 3500)).toBe(0);
    expect(squealGain(1.2, 3500)).toBe(0);
    const curve = [1.5, 2, 3, 4, 5].map((s) => squealGain(s, 3500));
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThan(curve[i - 1]!);
    expect(squealGain(6, 3500)).toBeCloseTo(1, 5);
    expect(squealGain(30, 3500)).toBeLessThan(0.6);
    expect(squealGain(6, 0)).toBe(0);
    expect(squealGain(6, 1000)).toBeLessThan(squealGain(6, 3500));
    expect(scrubGain(2)).toBe(0);
    expect(scrubGain(24)).toBe(1);
    expect(squealPitch(8, 3500)).toBeGreaterThan(squealPitch(2, 3500));
  });

  it('impulse → crash gain: log-shaped, monotonic, 0 below the floor, 1 at full', () => {
    expect(crashGain(2)).toBe(0);
    expect(crashGain(CRASH_IMPULSE_FULL)).toBe(1);
    expect(crashGain(1e5)).toBe(1);
    const xs = [10, 30, 100, 300, 1000];
    for (let i = 1; i < xs.length; i++) expect(crashGain(xs[i]!)).toBeGreaterThan(crashGain(xs[i - 1]!));
    // equal impulse ratios ≈ equal steps (log law)
    const a = crashGain(400) - crashGain(40);
    const b = crashGain(1600) - crashGain(160);
    expect(Math.abs(a - b)).toBeLessThan(0.15);
    expect(duckGain(1)).toBeCloseTo(Math.pow(10, -0.5), 5);
    expect(duckGain(0)).toBe(1);
  });

  it('Doppler: approaching raises, receding lowers, transverse ≈ 1, listener motion counts, clamped', () => {
    const c = SPEED_OF_SOUND;
    // source at x=-50 moving +x at 30 m/s toward a listener at the origin
    const up = dopplerFactor(-50, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(up).toBeCloseTo(c / (c - 30), 6);
    const down = dopplerFactor(50, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(down).toBeCloseTo(c / (c + 30), 6);
    expect(dopplerFactor(0, 0, -50, 30, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(1, 6);
    // listener moving toward a still source
    expect(dopplerFactor(-50, 0, 0, 0, 0, 0, 0, 0, 0, -20, 0, 0)).toBeCloseTo((c + 20) / c, 6);
    // co-moving (chase cam): no shift
    expect(dopplerFactor(-6, 0, 0, 40, 0, 0, 0, 0, 0, 40, 0, 0)).toBeCloseTo(1, 6);
    expect(dopplerFactor(-50, 0, 0, 600, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(2);
    expect(dopplerFactor(1, 1, 1, 9, 9, 9, 1, 1, 1, 0, 0, 0)).toBe(1);
  });

  it('slow-mo pitch = rate^3/4 capped, cinematic low-pass closes with the rate', () => {
    expect(slowMoPitch(1)).toBe(1);
    expect(slowMoPitch(0.5)).toBeCloseTo(Math.pow(0.5, 0.75), 6);
    expect(slowMoPitch(0.25)).toBeCloseTo(Math.pow(0.25, 0.75), 6);
    expect(slowMoPitch(0.125)).toBe(0.32);
    expect(slowMoPitch(2)).toBe(1.35);
    expect(slowMoLowpass(1)).toBe(20000);
    expect(slowMoLowpass(0.25)).toBeLessThan(3000);
    expect(slowMoLowpass(0.5)).toBeGreaterThan(slowMoLowpass(0.25));
  });

  it('engine load and wind level', () => {
    expect(engineLoad(0, -50, 400)).toBe(0);
    expect(engineLoad(1, 400, 400)).toBe(1);
    expect(engineLoad(1, 0, 400)).toBeCloseTo(0.45, 6);
    expect(windGain(2)).toBe(0);
    expect(windGain(48)).toBe(1);
  });
});

describe('voice pool', () => {
  it('reuses the owner voice, fills free voices, steals the quietest, never exceeds the cap', () => {
    const pool = new VoicePool([0, 1, 2]);
    expect(pool.acquire(10, 0.5)).toBe(0);
    expect(pool.acquire(11, 0.2)).toBe(1);
    expect(pool.acquire(10, 0.6)).toBe(0);
    expect(pool.acquire(12, 0.9)).toBe(2);
    expect(pool.active).toBe(3);
    // a weaker claim than every held voice is refused
    expect(pool.acquire(13, 0.1)).toBe(-1);
    // a stronger one steals the quietest (owner 11)
    expect(pool.acquire(14, 0.4)).toBe(1);
    expect(pool.ownerOf(1)).toBe(14);
    expect(pool.steals).toBe(1);
    expect(pool.active).toBe(3);
    pool.releaseUnless((k) => k !== 12);
    expect(pool.find(12)).toBe(-1);
    expect(pool.active).toBe(2);
  });
});
