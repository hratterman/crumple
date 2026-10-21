/**
 * R-CRASH car-vs-car crashes (crashPair.ts): momentum transfer, delta-v per car, restitution and
 * interpenetration between two soft-body vehicles (node-vs-node contact, collision/objects.ts).
 *
 * Physics references: in a collision the pair's momentum is conserved (on the ground only tyre / scrape
 * friction acts from outside, small over a ~0.1 s pulse); at the end of the main pulse both cars share
 * the plastic-collision velocity (m_a v_a + m_b v_b)/(m_a + m_b), so each car's delta-v is inversely
 * proportional to its mass; car-to-car restitution is low (≈ 0–0.1 frontal, ≤ 0.3 for a high truck
 * front into a car's side, which rolls and yaws the car away). No node may be driven through the other
 * car's skin: the deepest cross-object sphere overlap stays well under the combined radius and nothing
 * is left interlocked at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEDAN_CRASH_PROBES, type CrashProbes } from './crash';
import { formatPair, runPairCrash, type PairResult } from './crashPair';
import { BOXTRUCK, BOXTRUCK_CRASH_PROBES } from './defs/boxtruck';
import { SEDAN } from './defs/sedan';
import { SEDAN_TRAFFIC, SEDAN_TRAFFIC_CRASH_PROBES } from './defs/sedanTraffic';

const sedan = { def: SEDAN, probes: SEDAN_CRASH_PROBES };
const truck = { def: BOXTRUCK, probes: BOXTRUCK_CRASH_PROBES as unknown as CrashProbes };

let headon: PairResult;
let headonFree: PairResult;
let tbone: PairResult;
let tboneFree: PairResult;
let offset: PairResult;
let rearEnd: PairResult;
let rearTraffic: PairResult;

beforeAll(() => {
  headon = runPairCrash({ kind: 'headon', a: { ...sedan, speedKmh: 50 }, b: { ...truck, speedKmh: 50 } });
  headonFree = runPairCrash({ kind: 'headon', ground: false, a: { ...sedan, speedKmh: 50 }, b: { ...truck, speedKmh: 50 }, afterContactS: 0.6 });
  tbone = runPairCrash({ kind: 'tbone', a: { ...truck, speedKmh: 50 }, b: { ...sedan, speedKmh: 0 } });
  tboneFree = runPairCrash({ kind: 'tbone', ground: false, a: { ...truck, speedKmh: 50 }, b: { ...sedan, speedKmh: 0 }, afterContactS: 0.6 });
  offset = runPairCrash({ kind: 'headon', overlap: 0.5, a: { ...sedan, speedKmh: 50 }, b: { ...sedan, speedKmh: 50 } });
  rearEnd = runPairCrash({ kind: 'rear', a: { ...sedan, speedKmh: 50 }, b: { ...sedan, speedKmh: 0 } });
  rearTraffic = runPairCrash({ kind: 'rear', rearTips: ['s13_bl_*', 's13_bu_*'], a: { ...sedan, speedKmh: 50 }, b: { def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES, speedKmh: 0 } });
}, 900_000);

afterAll(() => {
  const all = [headon, headonFree, tbone, tboneFree, offset, rearEnd, rearTraffic].filter(Boolean);
  if (all.length > 0) console.log('\ncar-vs-car crash report\n' + all.map((r) => '  ' + (r.spec.ground === false ? 'zero-g ' : '') + formatPair(r)).join('\n'));
});

function expectClean(r: PairResult): void {
  expect(r.a.finite).toBe(true);
  expect(r.b.finite).toBe(true);
  // nothing driven through the other car: deepest sphere overlap < 40 % of r_a + r_b (≈ 8 cm for 0.2 m spheres), none left deep
  expect(r.maxOverlapFrac).toBeLessThan(0.4);
  expect(r.deepPairsEnd).toBe(0);
  // no energy from nowhere: no body node / hub much faster late than the fastest car was at impact (a struck car
  // spinning away carries its outer nodes a little past its COM speed: 10 %)
  const v0 = Math.max(Math.abs(r.a.vBefore), Math.abs(r.b.vBefore));
  expect(r.a.maxSpeedLate).toBeLessThanOrEqual(1.1 * v0);
  expect(r.b.maxSpeedLate).toBeLessThanOrEqual(1.1 * v0);
}

describe('car-vs-car crashes', () => {
  it('momentum is conserved by the contact and the structures (zero gravity, no ground): head-on and T-bone within 0.5 %', () => {
    expect(headonFree.momentumErr).toBeLessThan(0.005);
    expect(tboneFree.momentumErr).toBeLessThan(0.005);
    for (const r of [headonFree, tboneFree]) {
      expect(Math.abs(r.common.va - r.common.ideal)).toBeLessThan(0.02 * Math.abs(r.a.vBefore));
      expect(Math.abs(r.common.vb - r.common.ideal)).toBeLessThan(0.02 * Math.abs(r.a.vBefore));
    }
  });

  it('sedan vs box truck head-on, 50 + 50 km/h: the truck pushes the sedan back, delta-v ∝ 1/mass, plastic, no interpenetration', () => {
    // common velocity: the truck's direction, within 5 % of the plastic ideal (tyre friction over the pulse)
    expect(headon.common.ideal).toBeLessThan(-8);
    expect(Math.abs(headon.common.va - headon.common.ideal)).toBeLessThan(0.05 * headon.a.vBefore);
    expect(Math.abs(headon.common.vb - headon.common.ideal)).toBeLessThan(0.05 * headon.a.vBefore);
    // the sedan is thrown backwards (delta-v ≈ 22 m/s), the truck slowed by ≈ 5 m/s: ratio ≈ mass ratio
    expect(headon.a.deltaV).toBeLessThan(-20);
    expect(headon.b.deltaV).toBeGreaterThan(4);
    const ratio = -headon.a.deltaV / headon.b.deltaV;
    expect(ratio / (headon.b.mass / headon.a.mass)).toBeGreaterThan(0.85);
    expect(ratio / (headon.b.mass / headon.a.mass)).toBeLessThan(1.15);
    expect(headon.restitution).toBeLessThan(0.15);
    expect(headon.momentumErr).toBeLessThan(0.05);
    // the sedan's front takes the crush (a 100 km/h-closing hit into a truck's frame), the truck's barely
    expect(headon.a.crush).toBeGreaterThan(0.45);
    expect(headon.b.crush).toBeLessThan(0.15);
    expectClean(headon);
  });

  it('box truck T-bones a parked sedan at 50 km/h: the sedan is carried away at the shared velocity, no interpenetration', () => {
    expect(Math.abs(tbone.common.va - tbone.common.ideal)).toBeLessThan(0.05 * tbone.a.vBefore);
    expect(Math.abs(tbone.common.vb - tbone.common.ideal)).toBeLessThan(0.05 * tbone.a.vBefore);
    // sedan delta-v ≈ 11–14 m/s (plastic 11.4), the truck's ≈ 3–4 m/s
    expect(tbone.b.deltaV).toBeGreaterThan(10);
    expect(tbone.b.deltaV).toBeLessThan(15);
    expect(-tbone.a.deltaV).toBeGreaterThan(2);
    expect(-tbone.a.deltaV).toBeLessThan(5);
    expect(tbone.restitution).toBeLessThan(0.3);
    expectClean(tbone);
  });

  it('sedan vs sedan 50 % offset frontal, 50 + 50 km/h: symmetric delta-v, both stop, crush in each car, no interlock', () => {
    expect(Math.abs(offset.a.deltaV + offset.b.deltaV)).toBeLessThan(0.5);
    expect(Math.abs(offset.common.va)).toBeLessThan(0.7);
    expect(Math.abs(offset.common.vb)).toBeLessThan(0.7);
    expect(offset.restitution).toBeLessThan(0.15);
    for (const c of [offset.a, offset.b]) {
      expect(c.crush).toBeGreaterThan(0.25);
      expect(c.crush).toBeLessThan(0.65);
    }
    expectClean(offset);
  });

  /*
   * R-CRASH: a car struck by a car used to be carried along as a rigid block (its shell's implicit damper
   * spread the contact impulse, the crumple zone never left its yield bond): the traffic sedan's rear
   * crushed 1 cm when rear-ended at 50 km/h. Shell tiers now release on a car impact (NODE_FLAG_OBJ_IMPACT).
   */
  it('rear-end, 50 km/h into a parked sedan / traffic sedan: both cars share the momentum, the struck rear crushes', () => {
    for (const r of [rearEnd, rearTraffic]) {
      expect(Math.abs(r.common.va - r.common.ideal)).toBeLessThan(0.06 * r.a.vBefore);
      expect(Math.abs(r.common.vb - r.common.ideal)).toBeLessThan(0.06 * r.a.vBefore);
      expect(r.restitution).toBeLessThan(0.15);
      expect(r.a.crush).toBeGreaterThan(0.1);
      expect(r.b.crush).toBeGreaterThan(0.15);
      expect(r.b.crush).toBeLessThan(0.6);
      expectClean(r);
    }
  });
});
