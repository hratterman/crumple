/**
 * Engine systems (engineSystems.ts) against published engine references:
 *  [H]  J. B. Heywood, "Internal Combustion Engine Fundamentals" (1988):
 *       ch. 12 (17–35 % of the fuel energy goes to the coolant), ch. 13
 *       (friction mean effective pressure), ch. 15 (brake specific fuel
 *       consumption of SI engines ≈ 240–270 g/kWh at best, far higher at
 *       light load).
 *  [ANL] Argonne National Laboratory, idling fuel use: ≈ 0.6–1.5 L/h for
 *       1.6–3 L passenger-car petrol engines (larger engines more).
 *  [SAE] cooling-system practice: thermostat 88–95 °C, a car reaches
 *       operating temperature in ≈ 5–10 min of driving; with no coolant an
 *       engine overheats within minutes and seizes if driven on.
 */
import { describe, expect, it } from 'vitest';
import { SEDAN } from './defs/sedan';
import { compileVehicle } from './builder';
import { createDrivetrainState, computeWheelInertia, RPM_PER_RAD_S, type DrivetrainStateEx } from './drivetrain';
import { createEngineSystems, engineSystemsPost, heatDerate, type EngineSystemsState } from './engineSystems';

const cv = compileVehicle(SEDAN);
const fresh = (): { es: EngineSystemsState; d: DrivetrainStateEx } => {
  const es = createEngineSystems(cv);
  const d = createDrivetrainState(cv.drivetrain, computeWheelInertia(cv));
  return { es, d };
};
/** Runs `seconds` at a fixed operating point (rpm, net torque, throttle, road speed); dt 10 ms. */
function hold(es: EngineSystemsState, d: DrivetrainStateEx, rpm: number, torque: number, throttle: number, speed: number, seconds: number, until?: () => boolean): number {
  const dt = 0.01;
  let t = 0;
  while (t < seconds) {
    d.rpm = rpm;
    d.engineOmega = rpm / RPM_PER_RAD_S;
    d.engineTorque = torque;
    d.throttle = throttle;
    engineSystemsPost(es, d, cv.drivetrain.idleRpm, 0, speed, dt);
    t += dt;
    if (until && until()) return t;
  }
  return t;
}
const bsfc = (es: EngineSystemsState, kw: number): number => (es.fuelRateLph * 0.745 * 1000) / kw; // g/kWh

describe('engine systems: fuel', () => {
  it('idle 0.6–1.5 L/h; best BSFC 230–290 g/kWh at full load, ≥ 1.8× worse at 10 % load [ANL][H]', () => {
    const { es, d } = fresh();
    hold(es, d, 800, 0, 0.05, 0, 1);
    expect(es.fuelRateLph).toBeGreaterThan(0.6);
    expect(es.fuelRateLph).toBeLessThan(1.5);
    hold(es, d, 3500, 350, 1, 30, 0.1);
    const full = bsfc(es, (350 * 3500) / RPM_PER_RAD_S / 1000);
    expect(full).toBeGreaterThan(230);
    expect(full).toBeLessThan(290);
    hold(es, d, 2000, 30, 0.1, 15, 0.1);
    expect(bsfc(es, (30 * 2000) / RPM_PER_RAD_S / 1000) / full).toBeGreaterThan(1.8);
  });

  it('overrun fuel cut: throttle shut above idle + 300 rpm burns nothing', () => {
    const { es, d } = fresh();
    hold(es, d, 3000, -40, 0, 25, 0.1);
    expect(es.fuelRateLph).toBe(0);
  });
});

describe('engine systems: cooling', () => {
  it('warm-up from 20 °C reaches the thermostat (88 °C) in 4–15 min of light driving, then holds 88–100 °C [SAE]', () => {
    const { es, d } = fresh();
    es.coolantC = 20;
    const t = hold(es, d, 2000, 60, 0.2, 14, 1800, () => es.coolantC >= 88);
    expect(t / 60).toBeGreaterThan(4);
    expect(t / 60).toBeLessThan(15);
    hold(es, d, 2000, 60, 0.2, 14, 600);
    expect(es.coolantC).toBeGreaterThan(88);
    expect(es.coolantC).toBeLessThan(100);
  });

  it('full power at 200 km/h holds ≤ 108 °C; idling parked 20 min stays ≤ 105 °C (fan) [SAE]', () => {
    const a = fresh();
    hold(a.es, a.d, 6600, 350, 1, 55, 600);
    expect(a.es.coolantC).toBeLessThan(108);
    const b = fresh();
    hold(b.es, b.d, 800, 0, 0.05, 0, 1200);
    expect(b.es.coolantC).toBeLessThan(105);
  });

  it('a destroyed radiator at 100 km/h: overheats (> 115 °C) within 1–6 min, the ECU derates, the engine seizes ≥ 30 s later and cannot restart [SAE]', () => {
    const { es, d } = fresh();
    es.radiatorDamage = 1;
    const tHot = hold(es, d, 2600, 90, 0.25, 27.8, 1200, () => es.coolantC > 115);
    expect(tHot / 60).toBeGreaterThan(1);
    expect(tHot / 60).toBeLessThan(6);
    expect(heatDerate(125)).toBeLessThan(0.8);
    const tSeize = hold(es, d, 2600, 90, 0.25, 27.8, 1800, () => es.seized === 1);
    expect(tSeize).toBeGreaterThan(30);
    expect(es.seized).toBe(1);
    expect(d.engineOn).toBe(0);
  });
});

describe('engine systems: oil', () => {
  it('a cracked sump drains the oil; dry at 4000 rpm the engine seizes within 1–4 min [H]', () => {
    const { es, d } = fresh();
    es.oilLeak = 0.02;
    hold(es, d, 4000, 150, 0.4, 30, 60, () => es.oilLevel <= 0);
    const t = hold(es, d, 4000, 150, 0.4, 30, 600, () => es.seized === 1);
    expect(t).toBeGreaterThan(60);
    expect(t).toBeLessThan(240);
  });
});

