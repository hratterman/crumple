/**
 * DIFFERENTIALS on a split-μ launch (realism/driveline.ts: one driven tyre on
 * ice, μ × 0.15, full throttle in 1st, TC / ESC off), against the theory:
 *  [M]  Milliken & Milliken, "Race Car Vehicle Dynamics" (1995) ch. 20: an
 *       open differential splits the torque equally (both sides at the ice
 *       wheel's traction limit); a clutch-pack (Salisbury) LSD can move
 *       T_lock = preload + ramp·T_in between the sides, so T_high − T_low =
 *       T_lock and the torque bias ratio ≥ (1 + r)/(1 − r); a viscous
 *       coupling transfers torque ∝ the wheel-speed difference; a locked
 *       axle keeps both wheels at one speed.
 */
import { describe, expect, it } from 'vitest';
import { PICKUP } from '../defs/pickup';
import { SEDAN } from '../defs/sedan';
import type { VehicleDef } from '../types';
import { dumpJson } from './dump';
import { runSplitMu } from './driveline';

const withDiff = (def: VehicleDef, d: Partial<VehicleDef['drivetrain']>): VehicleDef => ({ ...def, drivetrain: { ...def.drivetrain, ...d } });

describe('differential torque split on split μ [M]', () => {
  it('open: equal torque both sides (±5 %); clutch LSD: T_high − T_low = preload + ramp·T_in (±10 %), 1.8× the open car\'s acceleration', async () => {
    const open = runSplitMu(withDiff(SEDAN, { diff: 'open', lsd: undefined }));
    const lsd = runSplitMu(SEDAN);
    const l = SEDAN.drivetrain.lsd!;
    await dumpJson('splitmu_sedan', { open, lsd });
    expect(Math.abs(open.tHigh / open.tLow - 1)).toBeLessThan(0.05);
    const theory = l.preload + l.powerRamp * lsd.tIn;
    expect((lsd.tHigh - lsd.tLow) / theory).toBeGreaterThan(0.9);
    expect((lsd.tHigh - lsd.tLow) / theory).toBeLessThan(1.1);
    expect(lsd.tHigh / lsd.tLow).toBeGreaterThan((1 + l.powerRamp) / (1 - l.powerRamp));
    expect(lsd.accel).toBeGreaterThan(1.8 * open.accel);
  }, 120_000);

  it('viscous coupling: transfer = c·Δω (±10 %); locked axle: no speed difference', async () => {
    const c = 40;
    const v = runSplitMu(withDiff(SEDAN, { diff: 'viscous', viscousCoeff: c, lsd: undefined }));
    const k = runSplitMu(withDiff(PICKUP, { diff: 'locked', lsd: undefined }));
    await dumpJson('splitmu_viscous_locked', { v, k });
    const theory = c * Math.abs(v.dOmega);
    expect((v.tHigh - v.tLow) / theory).toBeGreaterThan(0.9);
    expect((v.tHigh - v.tLow) / theory).toBeLessThan(1.1);
    expect(Math.abs(k.dOmega)).toBeLessThan(0.5);
  }, 120_000);
});

describe('halfshaft breakage', () => {
  it('an overload snaps the shafts (strength 600 N·m: a full-throttle launch breaks them, the real 5100 N·m does not); with one shaft broken an open diff drives nothing, a clutch LSD pushes its preload through the good side, a locked axle drives it fully', async () => {
    const { createHandlingSim, kinematics, stepN } = await import('../handling');
    const launch = (def: VehicleDef, breakOne: boolean): { broken: number; v: number } => {
      const sim = createHandlingSim({ def });
      sim.eng.setAssists(1, { tractionControl: false, esc: false });
      stepN(sim, 3000);
      const d = sim.veh.drivetrain as unknown as { shaftBroken: Uint8Array };
      if (breakOne) d.shaftBroken[sim.cv.drivetrain.drivenWheels[0]!] = 1;
      for (let t = 0; t < 6000; t++) {
        sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0 });
        sim.eng.step();
      }
      const k = kinematics(sim);
      return { broken: d.shaftBroken.reduce((a, b) => a + b, 0), v: Math.hypot(k.vx, k.vz) };
    };
    const intact = launch(SEDAN, false);
    const weak = launch(withDiff(SEDAN, { halfshaftBreakTorque: 600 }), false);
    expect(intact.broken).toBe(0);
    expect(weak.broken).toBeGreaterThan(0);
    const open = launch(withDiff(SEDAN, { diff: 'open', lsd: undefined }), true);
    const lsd = launch(SEDAN, true);
    const locked = launch(withDiff(SEDAN, { diff: 'locked', lsd: undefined }), true);
    await dumpJson('halfshaft', { intact, weak, open, lsd, locked });
    expect(open.v).toBeLessThan(0.2);
    expect(lsd.v).toBeGreaterThan(open.v + 0.3);
    expect(locked.v).toBeGreaterThan(2 * lsd.v);
  }, 120_000);
});

describe('engine rock (powertrain reactions on the mounts)', () => {
  it('full throttle in 1st rolls the block 0.3–5° on its mounts (longitudinal sedan, transverse beater); a free-revving blip in neutral rocks the body > 0.1° [PM]', async () => {
    // [PM] Yu, Naganathan & Dukkipati, "A literature review of automotive vehicle engine mounting systems",
    // Mech. Mach. Theory 36 (2001): powertrain roll under maximum drive torque ≈ 1–5° for elastomer mounts.
    const { runRock } = await import('./rock');
    const { BEATER } = await import('../defs/beater');
    const sedan = runRock(SEDAN, 'launch');
    const beater = runRock(BEATER, 'launch');
    const blip = runRock(SEDAN, 'blip');
    await dumpJson('rock', { sedan, beater, blip });
    for (const r of [sedan, beater]) {
      expect(Math.abs(r.blockDeg)).toBeGreaterThan(0.3);
      expect(Math.abs(r.blockDeg)).toBeLessThan(5);
    }
    expect(Math.abs(blip.bodyRollDeg)).toBeGreaterThan(0.1);
  }, 120_000);
});
