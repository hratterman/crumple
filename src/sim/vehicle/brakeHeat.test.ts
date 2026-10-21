/**
 * Brake disc thermal model and pad fade (brakeHeat.ts) against published
 * brake engineering references:
 *  [L]  R. Limpert, "Brake Design and Safety", 3rd ed. (SAE 2011), ch. 3:
 *       single-stop disc temperature rise = η·E / (m·c) for short stops (no
 *       time to convect); ventilated passenger-car rotors cool with time
 *       constants ≈ 60–150 s at highway speed and ≈ 400–900 s parked.
 *  [R13H] UN ECE R13-H, Annex 3, Type-I (heating) test for M1 cars: 15
 *       brakings from 120 to 60 km/h at 3 m/s², one every 45 s; the hot
 *       service brake must then still deliver ≥ 60 % of the cold
 *       performance with the same pedal force.
 *  [J2522] SAE J2522 (AK Master) fade sections: OE NAO / low-met pads keep
 *       ≈ 0.6–0.8 of their nominal μ at 550–650 °C.
 */
import { describe, expect, it } from 'vitest';
import { AMBIENT_C, DISC_C, DISC_HEAT_SHARE, brakeFade, createBrakeHeat, stepDiscTemp } from './brakeHeat';

const DT = 1 / 2000;

describe('brake disc temperature and fade', () => {
  it('a 100–0 stop heats the disc by η·E/(m·c) within 10 % (stop too short to cool) [L]', () => {
    const s = createBrakeHeat([8], [true]);
    // sedan: 1450 kg, 1 g, front axle 70 % of the work, two discs
    const m = 1450;
    const a = 9.81;
    const r = 0.3;
    let v = 100 / 3.6;
    let e = 0;
    while (v > 0) {
      const tau = (0.35 * m * a * r);
      const p = tau * (v / r);
      e += p * DT;
      stepDiscTemp(s, 0, p, v, DT);
      v -= a * DT;
    }
    const expected = (DISC_HEAT_SHARE * e) / (8 * DISC_C);
    expect(s.temp[0]! - AMBIENT_C).toBeGreaterThan(0.9 * expected);
    expect(s.temp[0]! - AMBIENT_C).toBeLessThan(1.01 * expected);
  });

  it('cooling time constants: ventilated disc 60–150 s at 100 km/h, 400–900 s parked [L]', () => {
    const tau = (v: number): number => {
      const s = createBrakeHeat([8], [true]);
      s.temp[0] = AMBIENT_C + 100; // small ΔT: convection-dominated
      let t = 0;
      while (s.temp[0]! > AMBIENT_C + 100 / Math.E) {
        stepDiscTemp(s, 0, 0, v, 0.01);
        t += 0.01;
      }
      return t;
    };
    const t100 = tau(100 / 3.6);
    const t0 = tau(0);
    expect(t100).toBeGreaterThan(60);
    expect(t100).toBeLessThan(150);
    expect(t0).toBeGreaterThan(400);
    expect(t0).toBeLessThan(900);
  });

  it('fade: plateau 150–350 °C, cold pads 0.9–0.99, 0.6–0.8 at 550–650 °C [J2522]', () => {
    expect(brakeFade(250)).toBe(1);
    expect(brakeFade(20)).toBeGreaterThan(0.9);
    expect(brakeFade(20)).toBeLessThan(0.99);
    for (const t of [550, 600, 650]) {
      expect(brakeFade(t)).toBeGreaterThan(0.6);
      expect(brakeFade(t)).toBeLessThan(0.8);
    }
  });

  it('R13-H Type-I heating cycle: the hot brake keeps ≥ 60 % of the cold torque [R13H]', () => {
    // sedan front disc (8 kg ventilated): 15 × (brake 120 → 60 km/h at 3 m/s², accelerate back, cruise), 45 s cycle
    const s = createBrakeHeat([8], [true]);
    const m = 1450;
    const share = 0.35; // one front disc's share of the braking work
    let peak = 0;
    for (let c = 0; c < 15; c++) {
      let t = 0;
      let v = 120 / 3.6;
      while (t < 45) {
        let p = 0;
        if (t < (60 / 3.6) / 3) {
          p = share * m * 3 * v;
          v -= 3 * 0.01;
        } else if (v < 120 / 3.6) {
          v += 1.5 * 0.01;
        }
        stepDiscTemp(s, 0, p, v, 0.01);
        t += 0.01;
      }
      peak = Math.max(peak, s.temp[0]!);
    }
    const cold = brakeFade(AMBIENT_C + 40);
    const hot = brakeFade(peak);
    expect(peak).toBeGreaterThan(80);
    expect(hot / cold).toBeGreaterThan(0.6);
  });
});
