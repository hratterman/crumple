/**
 * TYRE THERMAL / INFLATION / WEAR STATE (worker-only, R-TYRE): the slow
 * state of a tyre that the friction model (tyre.ts) and the carcass
 * stiffness read every tick. Pure kernels over a per-wheel record; only
 * + − × ÷ sqrt, no allocation, fixed order (numerics contract), so the
 * state replays bit-exactly and ports to the WASM core as is.
 *
 * THREE THERMAL NODES (lumped-parameter tyre thermal model in the manner of
 * Farroni et al., "TRT: thermo racing tyre", Meccanica 50 (2015), and
 * Sorniotti, "Tire thermal model for enhanced vehicle dynamics simulation",
 * SAE 2009-01-0441):
 *   surface  C_s dT_s/dt = η_slip·P_slip + 0.4·P_roll − G_sc(T_s − T_c)
 *                          − h_air(v)·A_tread·(T_s − T_amb) − G_road·c_patch·(T_s − T_road)
 *   carcass  C_c dT_c/dt = 0.6·P_roll + G_sc(T_s − T_c) − G_cg(T_c − T_g)
 *                          − h_air(v)·A_side·(T_c − T_amb)
 *   gas      C_g dT_g/dt = G_cg(T_c − T_g) + G_brake(T_disc − T_g) − G_rim(v)·(T_g − T_amb)
 *  - surface = a 0.7 mm tread skin (flash heating while sliding, seconds), carcass
 *    = the rest of the rubber + belts (minutes), gas = the inflation air (its
 *    heat capacity is tiny: it follows the inner liner and the rim).
 *  - P_slip = the contact's frictional power |F_x·u_x| + |F_y·u_y| from the
 *    rigid-wheel slip velocities (the energy the patch dissipates); η_slip
 *    = 0.7 of it goes into the tyre (Farroni's partition; the rest heats the
 *    road). P_roll = the reference rolling-resistance power C_rr·Fz·v
 *    (hysteresis of the tread 40 % / carcass 60 %, Wong §1.2.2: rolling
 *    loss sits mostly in the tread and the sidewalls).
 *  - Convection h_air = 10 + 2.7·v^0.75 W/(m²·K) (forced convection of a rolling
 *    tyre: ≈ 45 W/(m²·K) at 30 m/s, Sorniotti); v^0.75 = √(v·√v).
 *  - G_brake: radiation + conduction from the brake disc (R-PHYS brakeHeat.ts)
 *    through the wheel into the gas: hot brakes raise tyre pressure.
 * PRESSURE: ideal gas in a fixed volume, p_abs = m_gas·R·T_g/V. A leak (puncture
 * area A_leak) bleeds mass through an orifice, choked while p_abs > 1.89·p_atm:
 *   ṁ = C_d·A·p_abs·√(γ/(R·T))·(2/(γ+1))^((γ+1)/(2(γ−1))) = 0.0404·C_d·A·p_abs/√T (air, SI)
 * else subsonic ṁ = C_d·A·√(2·ρ·Δp). C_d = 0.6.
 * COMPOUND WINDOW: μ factor of the tread temperature T_t = 0.6·T_s + 0.4·T_c,
 * 1 inside [T_lo, T_hi], falling parabolically outside (cold: 1 − c·((T_lo −
 * T)/40 K)², hot: 1 − h·((T − T_hi)/60 K)²), floored at 0.6. Road compounds
 * work from 20 °C (summer tyres are designed for cold starts: ≈ 5 % less grip
 * near 0 °C); a max-performance compound wants 50–100 °C and has ≈ 7 % less
 * grip cold; above the window every compound overheats (blistering / graining
 * past ≈ 120–130 °C). Sources: Pacejka (2012) §1.2 (grip vs temperature as the
 * rubber's viscoelastic loss peak), Farroni 2015 (μ(T) window fits), tyre
 * makers' data for summer vs track compounds.
 * WEAR: tread depth falls with the frictional energy into the tread,
 * dd/dt = −k_w·η_slip·P_slip·(1 + ((T_s − 30)⁺/45)²) (Archard / Schallamach:
 * abrasion ∝ frictional work, strongly accelerated by temperature). k_w is set
 * so a burnout destroys an 8 mm tread in ≈ 60 s of ≈ 50 kW per tyre and
 * normal driving lasts tens of thousands of km.
 */

/** Atmospheric pressure, Pa. */
export const P_ATM = 101_325;
/** Specific gas constant of air, J/(kg·K). */
export const R_AIR = 287.05;
/** c_v of air, J/(kg·K). */
export const CV_AIR = 718;
/** Specific heat of tyre rubber (tread), J/(kg·K) (Farroni 2015: 1880). */
export const C_RUBBER = 1880;
/** Specific heat of the carcass (rubber + steel belts + textile), J/(kg·K). */
export const C_CARCASS = 1500;
/** Kelvin offset. */
export const KELVIN = 273.15;
/** Orifice discharge coefficient. */
export const LEAK_CD = 0.6;
/** Share of the contact's frictional power that heats the tyre (Farroni). */
export const SLIP_HEAT_SHARE = 0.7;
/** Rolling-loss heat split: tread share (the rest heats the carcass). */
export const ROLL_HEAT_TREAD = 0.4;
/** Tread skin thickness for the surface node, m. */
export const SKIN_THICKNESS = 0.0007;
/** Density of tread rubber, kg/m³. */
export const RUBBER_DENSITY = 1150;
/** Surface ↔ carcass conductance per m² of tread (k 0.25 W/(m·K) over ≈ 6 mm), W/(m²·K). */
export const G_SC_PER_M2 = 40;
/** Carcass ↔ gas (inner liner convection), W/(m²·K) of inner area. */
export const H_INNER = 25;
/** Patch ↔ road conduction, W/(m²·K) of tread area (≈ 500 W/(m²·K) in the patch, which is ≈ 1/15 of the tread). */
export const H_ROAD = 30;
/** Brake disc → tyre gas conductance (through hub, rim and wheel cavity), W/K. */
export const G_BRAKE = 1.5;
/** Rim (gas → ambient) conductance at rest and per m/s, W/K. */
export const G_RIM0 = 2;
export const G_RIM_V = 0.25;

/** Compound grip windows (°C) and fall-off weights. */
export interface TyreCompound {
  lo: number;
  hi: number;
  /** μ loss at 40 K below `lo`. */
  cold: number;
  /** μ loss at 60 K above `hi`. */
  hot: number;
}

export const TYRE_COMPOUNDS = {
  /** Summer / all-season road compound (passenger, economy, LT). */
  road: { lo: 20, hi: 95, cold: 0.06, hot: 0.15 },
  /** Max-performance summer (track-capable): wants heat. */
  performance: { lo: 50, hi: 105, cold: 0.12, hot: 0.18 },
  /** Truck / commercial compound (low hysteresis, cut resistant). */
  truck: { lo: 15, hi: 90, cold: 0.05, hot: 0.12 },
} as const satisfies Record<string, TyreCompound>;
export type TyreCompoundId = keyof typeof TYRE_COMPOUNDS;

/** μ factor of the compound at tread temperature T (°C). */
export function compoundFactor(c: TyreCompound, T: number): number {
  let f = 1;
  if (T < c.lo) {
    const x = (c.lo - T) / 40;
    f = 1 - c.cold * x * x;
  } else if (T > c.hi) {
    const x = (T - c.hi) / 60;
    f = 1 - c.hot * x * x;
  }
  return f < 0.6 ? 0.6 : f;
}

/** Per-tyre constants (spawn time; derived from the WheelDef, see createTyreThermal). */
export interface TyreThermalParams {
  /** Cold inflation (gauge) at T_REF, Pa. */
  p0: number;
  /** Cavity volume, m³. */
  volume: number;
  /** Heat capacities, J/K. */
  cSurf: number;
  cCarc: number;
  /** Areas, m²: tread (outer), sidewalls (outer, both), inner liner. */
  aTread: number;
  aSide: number;
  aInner: number;
  /** New tread depth, mm. */
  treadNew: number;
  /** Wear rate, mm per J of tread frictional heat at T_s ≤ 30 °C. */
  wearK: number;
  compound: TyreCompound;
}

/** Mutable per-tyre slow state. */
export interface TyreThermalState {
  /** Temperatures, °C. */
  tSurf: number;
  tCarc: number;
  tGas: number;
  /** Inflation air mass, kg. */
  gasMass: number;
  /** Gauge pressure, Pa (derived each step). */
  pressure: number;
  /** Leak orifice area, m² (0 = sealed). */
  leakArea: number;
  /** Tread depth, mm. */
  tread: number;
  /** Frictional energy into the tread so far, J (telemetry / tests). */
  slipEnergy: number;
}

/** Reference temperature of the cold inflation pressure, °C. */
export const T_REF = 20;

/** Ideal-gas mass of the cavity at gauge pressure p (Pa) and T (°C). */
export function gasMassAt(p: TyreThermalParams, gauge: number, T: number): number {
  return ((gauge + P_ATM) * p.volume) / (R_AIR * (T + KELVIN));
}

export function createTyreThermalState(p: TyreThermalParams, ambient = T_REF): TyreThermalState {
  const s: TyreThermalState = {
    tSurf: ambient,
    tCarc: ambient,
    tGas: ambient,
    gasMass: 0,
    pressure: p.p0,
    leakArea: 0,
    tread: p.treadNew,
    slipEnergy: 0,
  };
  resetTyreThermalState(p, s, ambient);
  return s;
}

/** Full repair: cold tyre at ambient, inflated to p0 at T_REF (so the cold pressure follows the ambient), new tread. */
export function resetTyreThermalState(p: TyreThermalParams, s: TyreThermalState, ambient = T_REF): void {
  s.tSurf = ambient;
  s.tCarc = ambient;
  s.tGas = ambient;
  s.gasMass = gasMassAt(p, p.p0, T_REF);
  s.pressure = (s.gasMass * R_AIR * (ambient + KELVIN)) / p.volume - P_ATM;
  s.leakArea = 0;
  s.tread = p.treadNew;
  s.slipEnergy = 0;
}

/** Per-tick inputs (all from the wheel this tick). */
export interface TyreHeatInputs {
  /** Contact frictional power, W (≥ 0). */
  slipPower: number;
  /** Reference rolling-loss power C_rr·Fz·v, W (≥ 0). */
  rollPower: number;
  /** Wheel centre speed, m/s. */
  speed: number;
  /** 1 while the tyre touches the ground. */
  contact: number;
  /** Brake disc temperature, °C (ambient when unbraked). */
  discTemp: number;
  /** Ambient air and road temperature, °C. */
  ambient: number;
  road: number;
}

/**
 * Advances the three temperatures, the inflation (leak) and the wear by dt.
 * Hot path: + − × ÷ sqrt only.
 */
export function stepTyreThermal(p: TyreThermalParams, s: TyreThermalState, inp: TyreHeatInputs, dt: number): void {
  const v = inp.speed < 0 ? -inp.speed : inp.speed;
  const v75 = Math.sqrt(v * Math.sqrt(v));
  const hAir = 10 + 2.7 * v75;
  const qSlip = SLIP_HEAT_SHARE * (inp.slipPower > 0 ? inp.slipPower : 0);
  const qRoll = inp.rollPower > 0 ? inp.rollPower : 0;
  const Ts = s.tSurf;
  const Tc = s.tCarc;
  const Tg = s.tGas;
  const gSc = G_SC_PER_M2 * p.aTread;
  const gCg = H_INNER * p.aInner;
  const qSc = gSc * (Ts - Tc);
  const qCg = gCg * (Tc - Tg);
  const qRoad = inp.contact !== 0 ? H_ROAD * p.aTread * (Ts - inp.road) : 0;
  const dS = qSlip + ROLL_HEAT_TREAD * qRoll - qSc - hAir * p.aTread * (Ts - inp.ambient) - qRoad;
  const dC = (1 - ROLL_HEAT_TREAD) * qRoll + qSc - qCg - hAir * p.aSide * (Tc - inp.ambient);
  const cGas = s.gasMass * CV_AIR;
  const gRim = G_RIM0 + G_RIM_V * v;
  const dG = qCg + G_BRAKE * (inp.discTemp - Tg) - gRim * (Tg - inp.ambient);
  s.tSurf = Ts + (dS * dt) / p.cSurf;
  s.tCarc = Tc + (dC * dt) / p.cCarc;
  // the gas capacity vanishes with the gas (a flat tyre): integrate it implicitly-stable
  const kG = gCg + G_BRAKE + gRim;
  const tauInv = cGas > 1e-9 ? kG / cGas : 0;
  if (tauInv * dt < 0.5) s.tGas = Tg + (dG * dt) / (cGas > 1e-9 ? cGas : 1);
  else s.tGas = (gCg * Tc + G_BRAKE * inp.discTemp + gRim * inp.ambient) / kG;
  // ---- wear (frictional heat into the tread, temperature accelerated)
  if (qSlip > 0) {
    s.slipEnergy += qSlip * dt;
    const hot = s.tSurf > 30 ? (s.tSurf - 30) / 45 : 0;
    const d = s.tread - p.wearK * qSlip * dt * (1 + hot * hot);
    s.tread = d > 0 ? d : 0;
  }
  // ---- inflation: leak, then ideal gas
  const TgK = s.tGas + KELVIN;
  if (s.leakArea > 0 && s.gasMass > 0) {
    const pAbs = (s.gasMass * R_AIR * TgK) / p.volume;
    let mdot: number;
    if (pAbs > 1.89 * P_ATM) mdot = (0.0404 * LEAK_CD * s.leakArea * pAbs) / Math.sqrt(TgK);
    else {
      const dp = pAbs - P_ATM;
      const rho = s.gasMass / p.volume;
      mdot = dp > 0 ? LEAK_CD * s.leakArea * Math.sqrt(2 * rho * dp) : 0;
    }
    const mAtm = (P_ATM * p.volume) / (R_AIR * TgK);
    let m = s.gasMass - mdot * dt;
    if (m < mAtm) m = mAtm;
    s.gasMass = m;
  }
  const g = (s.gasMass * R_AIR * TgK) / p.volume - P_ATM;
  s.pressure = g > 0 ? g : 0;
}

/** Fractional inflation dpi = (p − p0)/p0 (MF 6.1 notation). */
export function inflationRatio(p: TyreThermalParams, s: TyreThermalState): number {
  return (s.pressure - p.p0) / p.p0;
}

/** Tread temperature that sets the compound's grip, °C. */
export function treadTemp(s: TyreThermalState): number {
  return 0.6 * s.tSurf + 0.4 * s.tCarc;
}

/** Tyre geometry and construction a WheelDef gives (spawn-time builder input). */
export interface TyreBuild {
  /** Outer radius, rim radius, ring-plane spacing (m). */
  radius: number;
  rimRadius: number;
  width: number;
  /** Tyre (tread + carcass) mass, kg. */
  tyreMass: number;
  /** Cold inflation, gauge Pa. */
  pressure: number;
  compound: TyreCompoundId;
  /** New tread depth, mm. */
  treadDepth: number;
}

/** Section width ÷ the rig's ring-plane spacing (the tread rings sit inside the shoulders). */
export const SECTION_PER_WIDTH = 1.35;
/**
 * Wear rate, mm of tread per J of frictional heat into the tread at ≤ 30 °C:
 * a 50 kW-per-tyre burnout (35 kW into the tread, surface ≈ 250 °C: ×25)
 * takes an 8 mm tread off in ≈ 60 s; normal driving (≈ 100–200 W of slip heat
 * per tyre at ≈ 40 °C) lasts ≈ 10⁴ km.
 */
export const WEAR_K = 4.5e-8;

/** Builds the thermal / inflation constants of a tyre (spawn time; Math.* allowed). */
export function tyreThermalParams(b: TyreBuild): TyreThermalParams {
  const sw = SECTION_PER_WIDTH * b.width;
  const R = b.radius;
  const r = b.rimRadius;
  const aTread = 2 * Math.PI * R * sw;
  const aSide = 2 * Math.PI * (R * R - r * r);
  const skin = aTread * SKIN_THICKNESS * RUBBER_DENSITY;
  const carc = b.tyreMass > skin * 2 ? b.tyreMass - skin : skin;
  return {
    p0: b.pressure,
    volume: Math.PI * (R * R - r * r) * sw * 0.85,
    cSurf: skin * C_RUBBER,
    cCarc: carc * C_CARCASS,
    aTread,
    aSide,
    aInner: aTread + aSide,
    treadNew: b.treadDepth,
    wearK: WEAR_K,
    compound: TYRE_COMPOUNDS[b.compound],
  };
}
