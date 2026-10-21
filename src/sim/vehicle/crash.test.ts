/**
 * SEDAN crash acceptance (P4, docs/CONTRACTS.md "Crash tuning targets").
 * Every scenario runs once (beforeAll) and the table is printed, so the
 * file doubles as the crash tuning report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatCrash, runCrash, type CrashResult } from './crash';

let f50: CrashResult;
let f30: CrashResult;
let f10: CrashResult;
let pole: CrashResult;
let offset: CrashResult;
let f100: CrashResult;

beforeAll(() => {
  f50 = runCrash({ kind: 'frontal', speedKmh: 50 });
  f30 = runCrash({ kind: 'frontal', speedKmh: 30 });
  f10 = runCrash({ kind: 'frontal', speedKmh: 10 });
  pole = runCrash({ kind: 'pole', speedKmh: 30 });
  offset = runCrash({ kind: 'offset', speedKmh: 64, overlap: 0.4 });
  f100 = runCrash({ kind: 'frontal', speedKmh: 100 });
}, 180_000);

afterAll(() => {
  const all = [f50, f30, f10, pole, offset, f100].filter(Boolean);
  if (all.length > 0) console.log('\nSEDAN crash report\n' + all.map((r) => '  ' + formatCrash(r)).join('\n'));
});

/** "No explosion" (CONTRACTS): finite, no body node faster than the impact speed after 1 s, KE at 2 s < 5 %, no beam span > 3 m. */
function expectNoExplosion(r: CrashResult): void {
  expect(r.finite).toBe(true);
  expect(r.maxSpeedLate).toBeLessThanOrEqual(r.initialSpeed);
  expect(r.keRatio).toBeLessThan(0.05);
  expect(r.maxSpan).toBeLessThan(3);
}

describe('SEDAN crash harness', () => {
  it('50 km/h full frontal: crush 35–60 cm, peak ≤ 70 cm, spring-back ≤ 25 %, cabin intrusion < 8 cm, rebound 5–15 % of the impact speed, stable, wheels on, penetration < 5 cm', () => {
    expect(f50.crush).toBeGreaterThanOrEqual(0.35);
    expect(f50.crush).toBeLessThanOrEqual(0.6);
    // The crumple zone, not the cell, stops the car; the crush stays (no rubbery un-crumpling).
    expect(f50.crushMax).toBeLessThanOrEqual(0.7);
    expect(f50.springback).toBeLessThanOrEqual(0.25);
    expect(f50.intrusion).toBeLessThan(0.08);
    // R-CRASH: real cars rebound 5–15 % of the barrier speed (the old 1–4 m/s = 7–29 %).
    expect(f50.rebound / f50.initialSpeed).toBeGreaterThanOrEqual(0.05);
    expect(f50.rebound / f50.initialSpeed).toBeLessThanOrEqual(0.15);
    expectNoExplosion(f50);
    expect(f50.wheelsDetached).toBe(0);
    expect(f50.maxPenetration).toBeLessThan(0.05);
  });

  it('30 km/h full frontal: crush 15–30 cm, spring-back ≤ 25 %, intrusion < 3 cm, wheels and bumper stay on', () => {
    expect(f30.crush).toBeGreaterThanOrEqual(0.15);
    expect(f30.crush).toBeLessThanOrEqual(0.3);
    expect(f30.springback).toBeLessThanOrEqual(0.25);
    expect(f30.intrusion).toBeLessThan(0.03);
    expect(f30.wheelsDetached).toBe(0);
    expect(f30.bumperBrokenFraction).toBeLessThan(0.5);
  });

  it('10 km/h full frontal: permanent crush ≤ 3 cm, no broken beams, ≤ 5 % of body beams plastic', () => {
    expect(f10.crush).toBeLessThanOrEqual(0.03);
    expect(f10.brokenBeams).toBe(0);
    expect(f10.plasticFraction).toBeLessThanOrEqual(0.05);
  });

  it('30 km/h side pole at the front door: door intrusion 20–35 cm, nothing pulled through the pole', () => {
    expect(pole.doorIntrusion).toBeGreaterThanOrEqual(0.2);
    expect(pole.doorIntrusion).toBeLessThanOrEqual(0.35);
    expect(pole.poleSideKept).toBe(true);
    expect(pole.finite).toBe(true);
  });

  it('64 km/h 40 % offset frontal: cabin intrusion < 15 cm', () => {
    expect(offset.intrusion).toBeLessThan(0.15);
    expect(offset.finite).toBe(true);
  });

  it('100 km/h full frontal: stable, hood latch broken, bumper torn (≥ half its mounts), windscreen shattered', () => {
    expectNoExplosion(f100);
    expect(f100.latchBroken).toBe(true);
    expect(f100.bumperBrokenFraction).toBeGreaterThanOrEqual(0.5);
    expect(f100.windscreenBrokenFraction).toBeGreaterThanOrEqual(0.5);
  });

  /*
   * Feel pass: the SAFETY CELL keeps its shape (rigid shell cluster, shell.ts). Cell = the body nodes from
   * the firewall ring to the rear-seat bulkhead (door apertures, sills, pillars, roof rails); deviation from
   * its rigid best fit, and the rippling of the side skins (CrashResult.cellDev / doorWave). Before (beam
   * lattice alone): 50 km/h 4.8 cm final / 29.7 cm peak, 17 mm ripple; 100 km/h 27 / 47 cm, 80 mm; pole
   * (outside the dent) 11 / 24 cm, 16 mm — the "crinkled foil" cabins.
   */
  it('safety cell: straight after a 50 km/h frontal, only moderately bent at 100 km/h, a pole dent stays local', () => {
    expect(f50.cellDev).toBeLessThan(0.03);
    expect(f50.cellDevMax).toBeLessThan(0.08);
    expect(f50.doorWave).toBeLessThan(0.006);
    expect(f30.cellDevMax).toBeLessThan(0.05);
    // R-CRASH 0.18 → 0.22: the worst node is the cowl centre (s5_cw), the firewall panel the engine is now pushed into
    // (the wall no longer absorbs 8 cm of the stack at 8 MN/m, and the stack does not spring back); mean firewall
    // intrusion stays ≈ 4 cm, the door apertures / pillars well inside.
    expect(f100.cellDev).toBeLessThan(0.22);
    expect(f100.doorWave).toBeLessThan(0.06);
    expect(pole.cellDev).toBeLessThan(0.05);
    expect(pole.doorWave).toBeLessThan(0.005);
  });
});
