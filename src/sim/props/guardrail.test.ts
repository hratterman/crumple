/**
 * W-beam guardrail (R-PHYS2): a spliced, end-anchored run settles still (the
 * implicit rail members are stable), and crash tests against MASH TL-3 /
 * the Midwest Guardrail System: a 2.3 t pickup at 100 km/h and 25° is
 * contained and redirected (dynamic deflection 0.5–1.5 m; MGS ≈ 1.0–1.1 m,
 * EN 1317 W3–W5), exits nearly parallel at a reduced speed, stays upright;
 * a small car the same; a 7.5 t box truck (beyond TL-3) is not contained;
 * a 90° hit at 100 km/h tears the rail.
 */
import { describe, expect, it, vi } from 'vitest';
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { BOXTRUCK } from '../vehicle/defs/boxtruck';
import { PICKUP } from '../vehicle/defs/pickup';
import { SEDAN } from '../vehicle/defs/sedan';
import { GUARDRAIL_LENGTH } from './defs/guardrail';
import { runGuardrailImpact, type GuardrailImpactResult } from './guardrailImpact';

vi.setConfig({ testTimeout: 300_000 });

function log(name: string, r: GuardrailImpactResult): void {
  console.log(
    `[guardrail] ${name}: dynamic deflection ${r.dynamicDeflection.toFixed(2)} m (permanent ${r.permanentDeflection.toFixed(2)}), exit ${r.exitSpeedKmh.toFixed(0)} km/h at ${r.exitAngleDeg.toFixed(1)}°, roll ${r.maxRollDeg.toFixed(0)}°, ` +
      `penetrated ${r.penetrated}, broken: rail/post members ${r.railLinksBroken}, splices ${r.splicesBroken}, terminals ${r.anchorsBroken}`,
  );
}

describe('W-beam guardrail', () => {
  it('a spliced 10-panel run with anchored terminals settles still (stable implicit rail)', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 16, nodeCapacity: 8192, beamCapacity: 32768 } });
    eng.setGroundPlane(0, MaterialId.dirt);
    const n = 10;
    eng.spawnProps(
      Array.from({ length: n }, (_, i) => ({
        objectId: PROP_DYNAMIC_ID_BASE + i,
        prop: i === 0 || i === n - 1 ? ('guardrailEnd' as const) : ('guardrail' as const),
        transform: { pos: [(i - (n - 1) / 2) * GUARDRAIL_LENGTH, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] },
        asleep: false,
      })),
    );
    // Splices: 3 per joint (rows) × 9 joints; the inner terminal cables dropped (only the run's ends anchor).
    expect(eng.towing.joints.joints.filter((j) => j.tag.startsWith('join:')).length).toBe(27);
    expect(eng.towing.joints.joints.filter((j) => j.tag.startsWith('panchor:')).length).toBe(4);
    for (let t = 0; t < 3 * 2000; t++) eng.step();
    const s = eng.state;
    let vmax = 0;
    for (let i = 0; i < s.nodeCount; i++) vmax = Math.max(vmax, Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!));
    expect(vmax).toBeLessThan(0.05);
    expect(eng.towing.joints.joints.some((j) => j.broken)).toBe(false);
  });

  it('TL-3: a 2.3 t pickup at 100 km/h, 25° is contained and redirected', () => {
    const r = runGuardrailImpact(PICKUP, 100, 25);
    log('pickup 100 km/h 25°', r);
    expect(r.penetrated).toBe(false);
    expect(r.dynamicDeflection).toBeGreaterThan(0.4);
    expect(r.dynamicDeflection).toBeLessThan(1.5);
    expect(r.exitAngleDeg).toBeLessThan(5); // not heading back into the rail
    expect(r.exitAngleDeg).toBeGreaterThan(-20);
    expect(r.exitSpeedKmh).toBeGreaterThan(35);
    expect(r.exitSpeedKmh).toBeLessThan(90);
    expect(r.maxRollDeg).toBeLessThan(30);
    expect(r.splicesBroken + r.anchorsBroken).toBe(0);
  });

  it('a small car at 100 km/h, 25° is contained too', () => {
    const r = runGuardrailImpact(SEDAN, 100, 25);
    log('sedan 100 km/h 25°', r);
    expect(r.penetrated).toBe(false);
    expect(r.dynamicDeflection).toBeLessThan(1.5);
    expect(r.exitAngleDeg).toBeLessThan(5);
    expect(r.maxRollDeg).toBeLessThan(45);
  });

  it('beyond its rating: a 7.5 t box truck is not contained; a 90° hit tears the rail', () => {
    const truck = runGuardrailImpact(BOXTRUCK, 100, 25);
    log('box truck 100 km/h 25°', truck);
    expect(truck.penetrated).toBe(true);
    const square = runGuardrailImpact(PICKUP, 100, 90);
    log('pickup 100 km/h 90°', square);
    expect(square.railLinksBroken + square.splicesBroken).toBeGreaterThan(5);
    expect(square.dynamicDeflection).toBeGreaterThan(1.5);
  });
});
