/**
 * TYRE THERMAL / INFLATION / WEAR KERNEL (tyreThermal.ts) against published
 * behaviour. Sources:
 *  [TIRE]  Tyre makers' inflation guidance (Michelin, Goodyear, Bridgestone):
 *          set pressures cold; after highway driving the pressure is ≈ 2–4 psi
 *          (≈ 6–12 %) higher, i.e. the air is ≈ 20–35 K above ambient.
 *  [F]     Farroni et al., "TRT: thermo racing tyre", Meccanica 50 (2015):
 *          surface temperature responds in seconds, carcass in minutes;
 *          sustained sliding drives the surface to 100–200 °C.
 *  [BURN]  Burnout / drift practice: tyres smoke (surface ≳ 200 °C) within
 *          a few seconds of a full burnout and are destroyed within about a
 *          minute; a drift session wears a tyre in minutes.
 *  [GAS]   Ideal gas at constant volume: p_abs ∝ T_abs.
 */
import { describe, expect, it } from 'vitest';
import {
  createTyreThermalState,
  KELVIN,
  P_ATM,
  stepTyreThermal,
  T_REF,
  tyreThermalParams,
  type TyreHeatInputs,
} from './tyreThermal';

const DT = 1 / 2000;
const SEDAN_TYRE = tyreThermalParams({ radius: 0.32, rimRadius: 0.2, width: 0.15, tyreMass: 9.4, pressure: 230e3, compound: 'road', treadDepth: 8 });

function run(sec: number, inp: Partial<TyreHeatInputs>, s = createTyreThermalState(SEDAN_TYRE)): typeof s {
  const full: TyreHeatInputs = { slipPower: 0, rollPower: 0, speed: 0, contact: 1, discTemp: T_REF, ambient: T_REF, road: T_REF, ...inp };
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) stepTyreThermal(SEDAN_TYRE, s, full, DT);
  return s;
}

describe('tyre thermal model', () => {
  it('cavity and capacities are those of a 205/55R16 [geometry]', () => {
    // 205/55R16: ≈ 25–35 L of air, ≈ 0.1 kg of it at 2.3 bar
    expect(SEDAN_TYRE.volume).toBeGreaterThan(0.022);
    expect(SEDAN_TYRE.volume).toBeLessThan(0.036);
    const s = createTyreThermalState(SEDAN_TYRE);
    expect(s.gasMass).toBeGreaterThan(0.08);
    expect(s.gasMass).toBeLessThan(0.14);
    expect(s.pressure).toBeCloseTo(230e3, -2);
  });

  it('constant-volume gas: p_abs ∝ T_abs [GAS]', () => {
    const s = createTyreThermalState(SEDAN_TYRE);
    const p0 = s.pressure + P_ATM;
    // heat the carcass and let the gas follow (no flows to ambient: ambient = the gas temperature target)
    run(600, { ambient: 60, road: 60, discTemp: 60 }, s);
    expect(s.tGas).toBeGreaterThan(35);
    expect((s.pressure + P_ATM) / p0).toBeCloseTo((s.tGas + KELVIN) / (T_REF + KELVIN), 4);
  });

  // rolling loss at 108 km/h: C_rr = 0.01·(1 + 108/160) [Wong eq. 1.12] on a 3.5 kN wheel
  const HWY = 0.01 * (1 + 108 / 160) * 3500 * 30;
  it('highway warm-up: after 15 min at 108 km/h the air is 15–35 K up and the pressure 5–12 % up [TIRE]', () => {
    const s = run(900, { speed: 30, rollPower: HWY });
    const dT = s.tGas - T_REF;
    expect(dT).toBeGreaterThan(15);
    expect(dT).toBeLessThan(35);
    const rise = s.pressure / 230e3 - 1;
    expect(rise).toBeGreaterThan(0.05);
    expect(rise).toBeLessThan(0.12);
    // and it has (nearly) settled: the next 5 min add < 3 K
    const t1 = s.tGas;
    run(300, { speed: 30, rollPower: HWY }, s);
    expect(s.tGas - t1).toBeLessThan(3);
  });

  it('burnout: surface past 200 °C within 5 s, an 8 mm tread gone in 30–120 s [BURN][F]', () => {
    // a 238 kW sedan holding a burnout: ≈ 50 kW of slip power per rear tyre, wheel at ≈ 25 m/s tread speed, car still
    const s = createTyreThermalState(SEDAN_TYRE);
    let t200 = Infinity;
    let tGone = Infinity;
    for (let i = 0; i < 120 / DT; i++) {
      stepTyreThermal(SEDAN_TYRE, s, { slipPower: 50e3, rollPower: 0, speed: 1, contact: 1, discTemp: T_REF, ambient: T_REF, road: T_REF }, DT);
      if (t200 === Infinity && s.tSurf > 200) t200 = i * DT;
      if (tGone === Infinity && s.tread <= 0) tGone = i * DT;
    }
    expect(t200).toBeLessThan(5);
    expect(tGone).toBeGreaterThan(30);
    expect(tGone).toBeLessThan(120);
  });

  it('drift: 10 s at 15 kW of slip heats the surface to 100–220 °C, the carcass far less; cools in seconds after [F]', () => {
    const s = run(10, { slipPower: 15e3, speed: 15, rollPower: 0.012 * 3500 * 15 });
    expect(s.tSurf).toBeGreaterThan(100);
    expect(s.tSurf).toBeLessThan(220);
    expect(s.tCarc).toBeLessThan(s.tSurf - 40);
    const hot = s.tSurf;
    run(5, { speed: 20, rollPower: 0.012 * 3500 * 20 }, s);
    expect(s.tSurf).toBeLessThan(hot - 30);
  });

  it('punctures: a nail-sized leak takes minutes, a cut seconds, and both end at atmospheric [TIRE]', () => {
    const slow = createTyreThermalState(SEDAN_TYRE);
    slow.leakArea = 2e-7;
    run(60, {}, slow);
    expect(slow.pressure / 230e3).toBeGreaterThan(0.5);
    expect(slow.pressure / 230e3).toBeLessThan(0.97);
    const fast = createTyreThermalState(SEDAN_TYRE);
    fast.leakArea = 3e-4; // a ≈ 2 cm sidewall gash
    run(3, {}, fast);
    expect(fast.pressure).toBeLessThan(5e3);
    run(10, {}, fast);
    expect(fast.pressure).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(fast.tGas)).toBe(true);
  });

  it('hot brakes warm the air (a 500 °C disc for 2 min parked: +5–40 K) [GAS]', () => {
    const s = run(120, { discTemp: 500 });
    expect(s.tGas - T_REF).toBeGreaterThan(5);
    expect(s.tGas - T_REF).toBeLessThan(40);
  });
});
