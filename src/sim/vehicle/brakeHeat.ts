/**
 * R-PHYS: brake disc temperature and pad fade (new module; runs in the
 * vehicle pre-step after the wheel torques). Per braked wheel a lumped disc:
 *
 *   m·c·dT/dt = η·τ_brake·|ω| − hA(v)·(T − T_amb) − ε·σ·A·(T⁴ − T_amb⁴)
 *
 * η = 0.9 of the friction power goes into the disc (the rest into the pad;
 * Limpert, "Brake Design and Safety", 3rd ed. 2011, ch. 3: heat partition
 * ≈ 0.88–0.95 for cast-iron discs with organic / low-met pads); c = 460
 * J/(kg·K) (grey iron). Convection hA(v) = hA0 + hA1·(v / 27.8 m/s)^0.75,
 * set from the cooling time constants m·c / hA of a ventilated disc: ≈ 600 s
 * parked, ≈ 100 s at 100 km/h (Limpert ch. 3; solid discs cool ≈ 1.6× slower
 * at speed: hA1 × 0.6). Radiation ε 0.55, A = disc faces (≈ m / 50 m²/kg).
 *
 * Pad friction vs disc temperature, `BRAKE_FADE` (μ / μ_nominal, every
 * 100 °C from 0 °C): cold pads bite ≈ 5 % less, the plateau runs 150–350 °C,
 * then the resin binder outgasses and μ falls — 0.85 at 500 °C, 0.74 at
 * 600 °C, 0.52 at 800 °C — the shape of OE NAO / low-metallic pad fade curves
 * in SAE J2522 (AK Master) fade sections (μ ≈ 0.38–0.42 nominal → 0.25–0.3
 * at 550–650 °C). The caliper torque is scaled by it (brakes.ts), so a hot
 * brake needs more pedal, and an ABS stop lengthens once the faded torque no
 * longer reaches the tyre's lock torque.
 *
 * HOT LOOP: + − × ÷ sqrt only, zero allocation.
 */

/** μ_pad / μ_nominal at 0, 100, …, 800 °C (clamped beyond). */
export const BRAKE_FADE: readonly number[] = [0.95, 0.98, 1.0, 1.0, 0.95, 0.85, 0.74, 0.62, 0.52];
export const BRAKE_FADE_STEP_C = 100;
export const DISC_C = 460;
export const DISC_HEAT_SHARE = 0.9;
export const AMBIENT_C = 25;
/** Ventilated disc: cooling time constants m·c/hA, s, parked and at 27.8 m/s. */
export const COOL_TAU_PARKED_S = 600;
export const COOL_TAU_100_S = 100;
/** Solid disc / drum: speed-dependent convection share relative to a ventilated disc. */
export const SOLID_COOL_FACTOR = 0.6;
const SIGMA = 5.67e-8;
const EMISSIVITY = 0.55;
/** Radiating area per kg of disc, m²/kg (a 296 × 28 mm, 8 kg vented disc: ≈ 0.16 m² of faces). */
const AREA_PER_KG = 0.02;
const K0 = 273.15;

export function brakeFade(tC: number): number {
  let u = tC / BRAKE_FADE_STEP_C;
  if (u <= 0) return BRAKE_FADE[0]!;
  const n = BRAKE_FADE.length - 1;
  if (u >= n) return BRAKE_FADE[n]!;
  let i = 0;
  while (i + 1 < u) i++;
  u -= i;
  return BRAKE_FADE[i]! + (BRAKE_FADE[i + 1]! - BRAKE_FADE[i]!) * u;
}

export interface BrakeHeatState {
  /** Disc temperature per wheel, °C (declaration order). */
  temp: Float64Array;
  /** Disc mass per wheel, kg (0 = unbraked: no thermal model). */
  mass: Float64Array;
  /** Convection hA0 (parked) and hA1 (speed part at 27.8 m/s), W/K, per wheel. */
  hA0: Float64Array;
  hA1: Float64Array;
}

export function createBrakeHeat(masses: readonly number[], vented: readonly boolean[]): BrakeHeatState {
  const n = masses.length;
  const s: BrakeHeatState = { temp: new Float64Array(n), mass: Float64Array.from(masses), hA0: new Float64Array(n), hA1: new Float64Array(n) };
  for (let w = 0; w < n; w++) {
    const mc = masses[w]! * DISC_C;
    const h0 = mc / COOL_TAU_PARKED_S;
    const h100 = mc / COOL_TAU_100_S;
    s.hA0[w] = h0;
    s.hA1[w] = (h100 - h0) * (vented[w] ? 1 : SOLID_COOL_FACTOR);
  }
  resetBrakeHeat(s);
  return s;
}

export function resetBrakeHeat(s: BrakeHeatState): void {
  s.temp.fill(AMBIENT_C);
}

/**
 * One tick of disc w: friction power `power` (W, τ·|ω|), vehicle speed v (m/s).
 * Explicit Euler: the stiffest term (radiation at 900 °C) has m·c/(4εσAT³) ≫ dt.
 */
export function stepDiscTemp(s: BrakeHeatState, w: number, power: number, v: number, dt: number): number {
  const m = s.mass[w]!;
  const t = s.temp[w]!;
  if (!(m > 0)) return t;
  const av = v < 0 ? -v : v;
  const x = av / 27.8;
  const x75 = Math.sqrt(x * Math.sqrt(x));
  const hA = s.hA0[w]! + s.hA1[w]! * x75;
  const tk = t + K0;
  const ak = AMBIENT_C + K0;
  const t2 = tk * tk;
  const a2 = ak * ak;
  const rad = EMISSIVITY * SIGMA * AREA_PER_KG * m * (t2 * t2 - a2 * a2);
  const dT = ((DISC_HEAT_SHARE * power - hA * (t - AMBIENT_C) - rad) * dt) / (m * DISC_C);
  const tn = t + dT;
  s.temp[w] = tn;
  return tn;
}
