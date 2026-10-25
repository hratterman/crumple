/**
 * TYRE–SURFACE PHYSICS (worker-only, R-TYRE): what each ground material does
 * to a tyre, by MaterialId. Two kinds of ground:
 *
 * FIRM (asphalt, concrete, rock, metal, …): rubber friction. The tyre's own
 * μ(slip, load, temperature) is scaled by the surface's dry grip relative to
 * dry asphalt, and on a WET surface (setSurfaceWetness, 0..1):
 *   f_wet = 1 − w·(a0 + a1·V·(1 + 0.8·worn)),  V in km/h, worn = 1 − d/d_new
 * (wet/dry ≈ 0.75 at 30 km/h → 0.6 at 90 km/h for a new tyre on asphalt: the
 * wet skid number falls with speed and with tread depth; ADAC / TÜV summer-tyre
 * tests: 80 → 20 km/h wet in 26–34 m (≈ 0.72 of the dry deceleration), worn
 * tyres several metres longer; PIARC skid-resistance–speed gradients).
 * HYDROPLANING: the patch lifts on the water wedge above
 *   V_hp = 6.35·√p[kPa]·(0.456 + 0.67·d/(d + h) + 0.568/h) km/h
 * (d tread depth, h water depth, mm): Horne & Joyner's 6.35·√p for a flooded,
 * smooth tyre (NASA TN D-2056; 9·√p[psi] knots), scaled by tread drainage and
 * film depth to the measured onsets (ADAC aquaplaning tests, 7–8 mm water:
 * new tyres ≈ 85 km/h, 3 mm tread ≈ 70 km/h; a damp road never floats a
 * tyre: V_hp > 200 km/h below 0.5 mm). Partial lift between 0.7·V_hp and
 * V_hp (Moore's three-zone patch), grip × (1 − 0.92·lift).
 *
 * DEFORMABLE (sand, mud, gravel, dirt, grass, snow): the tyre shears the soil.
 *  - PRESSURE–SINKAGE (Bekker): p = (k_c/b + k_φ)·zⁿ; a wheel of diameter D
 *    in rigid mode under load W sinks z0 = [3W/((3 − n)·k·b·√D)]^(2/(2n+1)) and
 *    rolls against the COMPACTION resistance R_c = b·k·z^(n+1)/(n+1) (Wong,
 *    "Theory of Ground Vehicles" 4th ed. §2.3–2.4, §1.2). A pneumatic tyre is
 *    the EQUIVALENT RIGID WHEEL whose arc in the soil is as long as the tyre's
 *    flattened patch plus its sunk arc (Wong & Preston-Thomas's flexible-tyre
 *    treatment): √(D_e·z) = L_f + √(D·z), L_f = 2√(D·δ − δ²), δ the tyre's
 *    deflection — so a softer (aired-down) tyre floats: longer flat, larger
 *    D_e, less sinkage and compaction. z depends on W and D_e only through
 *    q = W/√D_e: z(q) and R_c(q) are tabulated per wheel at spawn
 *    (createSoilTables); the hot path only interpolates.
 *    Longitudinal BULLDOZING (below) only acts on the sinkage beyond 0.06·D:
 *    for shallow ruts the compaction integral already covers the soil the
 *    tyre's front arc displaces.
 *  - BULLDOZING of the soil the sunk tyre pushes sideways, per unit width
 *    0.67·c·z·K_pc + 0.5·γ·z²·K_pγ (Bekker; K_pγ = (2·N_γ/tan φ + 1)·cos²φ,
 *    K_pc = (N_c − tan φ)·cos²φ, Terzaghi's N_c, N_γ at φ), over the patch length.
 *  - SHEAR (Janosi–Hanamoto): τ = (c + p·tan φ)·(1 − e^(−j/K)); integrated over a
 *    patch of length L at slip i, μ = (c·A/W + tan φ)·(1 − (K/(iL))(1 − e^(−iL/K))):
 *    no peak — grip RISES with slip to the soil's shear strength (loose surfaces
 *    want wheelspin / a sliding car). e^(−x) enters only through
 *    g(x) = 1 − (1 − e^(−x))/x, evaluated by the Padé form x(6 + x)/(12 + 6x + x²)
 *    (exact slope at 0, → 1 − 1/x; |error| < 0.03).
 * Soil sets: Wong (2008) Table 2.3 (dry sand, clayey soil, sandy loam, snow)
 * with k_φ adjusted where a surface is the COMPACTED version (trail dirt, turf
 * over loam, gravel over a rolled base, packed snow); every adjustment is
 * noted on the entry with the sinkage / rolling-resistance it gives a 3.5 kN
 * car tyre against the published ranges (Wong Table 1.1: C_rr on sand
 * 0.15–0.3, field 0.08–0.35, gravel road 0.02–0.05).
 *
 * Hot path: only + − × ÷ sqrt; tables are built at spawn (Math.pow allowed
 * there, like the wheel geometry).
 */
import { MaterialId } from '../../protocol/messages';

export interface SoilParams {
  /** Bekker exponent. */
  n: number;
  /** Cohesive / frictional moduli, N/m^(n+1) and N/m^(n+2). */
  kc: number;
  kphi: number;
  /** Cohesion, Pa. */
  c: number;
  /** Internal friction angle, deg. */
  phiDeg: number;
  /** Shear deformation modulus, m. */
  K: number;
  /** Unit weight, N/m³. */
  gamma: number;
}

export interface TyreSurface {
  name: string;
  /** Dry grip of a tyre on it ÷ its grip on dry asphalt (firm surfaces). */
  grip: number;
  /** Wet weights a0 (speed-independent) and a1 (per km/h); 0 = water does nothing. */
  wet0: number;
  wet1: number;
  /** Macrotexture, mm (drains the film: adds to the tread's drainage depth). */
  texture: number;
  /** Extra rolling resistance of a rough firm surface (C_rr). */
  crr: number;
  /** Deformable soil, or null (firm). */
  soil: SoilParams | null;
  /**
   * Wet soil: its strength (c, tan φ) × (1 − soilWet·w) — water lubricates turf
   * and dirt; sand firms up (negative).
   */
  soilWet: number;
}

const firm = (name: string, grip: number, wet0: number, wet1: number, texture: number, crr: number): TyreSurface => ({
  name,
  grip,
  wet0,
  wet1,
  texture,
  crr,
  soil: null,
  soilWet: 0,
});
const soft = (name: string, soil: SoilParams, soilWet: number): TyreSurface => ({
  name,
  grip: 1,
  wet0: 0,
  wet1: 0,
  texture: 2,
  crr: 0,
  soil,
  soilWet,
});

/** Additive MaterialIds for surfaces not painted yet (CONTRACTS "R-TYRE"): snow 15, ice 16. */
export const MATERIAL_SNOW = 15;
export const MATERIAL_ICE = 16;

/**
 * Indexed by MaterialId. Firm grips relative to dry asphalt; wet weights per
 * surface (smooth / polished surfaces lose more); soils documented per entry
 * (3.5 kN, 205-wide, 0.64 m tyre).
 */
export const TYRE_SURFACES: readonly TyreSurface[] = (() => {
  const t: TyreSurface[] = [];
  t[MaterialId.asphalt] = firm('asphalt', 1, 0.12, 0.003, 0.8, 0);
  // compacted turf over loam: z ≈ 1.6 cm, C_rr ≈ 0.06, μ → ≈ 0.55 at large slip (field 0.08–0.35, grass ≈ 0.5–0.6)
  t[MaterialId.grass] = soft('grass', { n: 0.9, kc: 52.5e3, kphi: 2.6e7, c: 3e3, phiDeg: 27, K: 0.015, gamma: 15e3 }, 0.35);
  // compacted trail dirt: z ≈ 0.8 cm, C_rr ≈ 0.04, μ → ≈ 0.7 (dry dirt road 0.65–0.75)
  t[MaterialId.dirt] = soft('dirt', { n: 0.9, kc: 52.5e3, kphi: 8e7, c: 4e3, phiDeg: 32, K: 0.01, gamma: 16e3 }, 0.3);
  t[MaterialId.rock] = firm('rock', 0.9, 0.2, 0.002, 2, 0.005);
  // loose gravel over a rolled base: z ≈ 0.4 cm, C_rr ≈ 0.03; low grip at small slip, rising with it (μ → ≈ 0.65)
  t[MaterialId.gravel] = soft('gravel', { n: 1, kc: 0, kphi: 7e8, c: 0, phiDeg: 33, K: 0.02, gamma: 17e3 }, 0.1);
  t[MaterialId.concrete] = firm('concrete', 1, 0.1, 0.0028, 1, 0.001);
  t[MaterialId.metal] = firm('metal', 0.6, 0.35, 0.002, 0.1, 0);
  t[MaterialId.plastic] = firm('plastic', 0.55, 0.35, 0.002, 0.1, 0);
  t[MaterialId.rubber] = firm('rubber', 1, 0.2, 0.003, 0.5, 0.004);
  t[MaterialId.wood] = firm('wood', 0.65, 0.35, 0.003, 0.5, 0.002);
  t[MaterialId.cardboard] = firm('cardboard', 0.55, 0.45, 0.003, 0.3, 0.01);
  // saturated clayey soil (Wong Table 2.3 clayey soil, 38 % moisture, k_φ ÷ 2): z ≈ 6 cm, C_rr ≈ 0.25, μ → ≈ 0.3
  t[MaterialId.mud] = soft('mud', { n: 0.5, kc: 13.19e3, kphi: 346e3, c: 4.14e3, phiDeg: 13, K: 0.025, gamma: 17e3 }, 0);
  // dry sand (Wong Table 2.3, LLL dry sand): z ≈ 9 cm, C_rr ≈ 0.29 (Wong Table 1.1: 0.15–0.3), μ → ≈ 0.54
  t[MaterialId.sand] = soft('sand', { n: 1.1, kc: 0.99e3, kphi: 1528.43e3, c: 1.04e3, phiDeg: 28, K: 0.025, gamma: 15.7e3 }, -0.15);
  // wet turf: softer loam under it, the grass blades lubricate: z ≈ 2.5 cm, μ → ≈ 0.38
  t[MaterialId.wetGrass] = soft('wetGrass', { n: 0.9, kc: 52.5e3, kphi: 1.2e7, c: 2e3, phiDeg: 19, K: 0.02, gamma: 16e3 }, 0);
  t[MaterialId.asphaltWorn] = firm('asphaltWorn', 0.93, 0.18, 0.004, 0.4, 0.002);
  // packed snow (Wong Table 2.3 snow, compacted ×40 k_φ): z ≈ 2 cm, μ → ≈ 0.3 (packed snow 0.2–0.3)
  t[MATERIAL_SNOW] = soft('snow', { n: 1.6, kc: 4.37e3, kphi: 7.9e6, c: 1.03e3, phiDeg: 16, K: 0.03, gamma: 4e3 }, 0.2);
  // ice near 0 °C: rubber on ice μ ≈ 0.1 (wet ice 0.05) — firm, glassy
  t[MATERIAL_ICE] = firm('ice', 0.1, 0.5, 0.002, 0, 0);
  return t;
})();

/** Surface entry of a MaterialId (asphalt for unknown ids). */
export function tyreSurface(id: number): TyreSurface {
  return TYRE_SURFACES[id] ?? TYRE_SURFACES[MaterialId.asphalt]!;
}

// ------------------------------------------------------------ soil, spawn time
/** Load grid of the per-wheel soil tables: 0..LOAD_MAX_FACTOR·Fz0 in SOIL_STEPS steps. */
export const SOIL_STEPS = 48;
export const LOAD_MAX_FACTOR = 4;

/** Per wheel, per soil: sinkage z (m) and compaction resistance (N) vs q = W/√D_e (N/√m). */
export interface SoilTable {
  /** q step, N/√m. */
  dq: number;
  z: Float64Array;
  rc: Float64Array;
  /** Bulldozing coefficients per unit width: R = b·(qa·z + qb·z²). */
  qa: number;
  qb: number;
  /** tan φ and c of the soil, shear modulus K (m). */
  tanPhi: number;
  c: number;
  K: number;
}

/** Terzaghi bearing-capacity factors N_c, N_γ (Vesić) at φ (deg); spawn-time. */
function bearing(phiDeg: number): { Nc: number; Ng: number } {
  const phi = (phiDeg * Math.PI) / 180;
  const t = Math.tan(phi);
  const Nq = Math.exp(Math.PI * t) * Math.tan(Math.PI / 4 + phi / 2) ** 2;
  const Nc = t > 1e-6 ? (Nq - 1) / t : 5.14;
  const Ng = 2 * (Nq + 1) * t;
  return { Nc, Ng };
}

/** Builds the soil tables of one wheel (tyre width b, diameter D, design load fz0); index = MaterialId. */
export function createSoilTables(b: number, D: number, fz0: number): (SoilTable | null)[] {
  const out: (SoilTable | null)[] = [];
  const dq = (LOAD_MAX_FACTOR * fz0) / Math.sqrt(D) / SOIL_STEPS;
  for (let id = 0; id < TYRE_SURFACES.length; id++) {
    const s = TYRE_SURFACES[id]?.soil;
    if (!s) {
      out.push(null);
      continue;
    }
    const k = s.kc / b + s.kphi;
    const z = new Float64Array(SOIL_STEPS + 1);
    const rc = new Float64Array(SOIL_STEPS + 1);
    for (let i = 0; i <= SOIL_STEPS; i++) {
      const q = i * dq;
      const zi = q > 0 ? ((3 * q) / ((3 - s.n) * k * b)) ** (2 / (2 * s.n + 1)) : 0;
      z[i] = zi;
      rc[i] = (b * k * zi ** (s.n + 1)) / (s.n + 1);
    }
    const phi = (s.phiDeg * Math.PI) / 180;
    const cos2 = Math.cos(phi) ** 2;
    const { Nc, Ng } = bearing(s.phiDeg);
    const Kpc = (Nc - Math.tan(phi)) * cos2;
    const Kpg = ((2 * Ng) / Math.tan(phi) + 1) * cos2;
    out.push({ dq, z, rc, qa: 0.67 * s.c * Kpc, qb: 0.5 * s.gamma * Kpg, tanPhi: Math.tan(phi), c: s.c, K: s.K });
  }
  return out;
}

/** Linear interpolation of a soil table column at q = W/√D_e. */
export function soilLookup(t: SoilTable, col: Float64Array, q: number): number {
  let x = q / t.dq;
  if (!(x > 0)) return 0;
  const last = col.length - 1;
  if (x >= last) return col[last]! + (col[last]! - col[last - 1]!) * (x - last);
  const i = x | 0;
  x -= i;
  return col[i]! + (col[i + 1]! - col[i]!) * x;
}

/** Bulldozing resistance (N) of a tyre sunk z (m) over a front of width w (m). */
export function bulldozing(t: SoilTable, z: number, w: number): number {
  return z > 0 ? w * (t.qa * z + t.qb * z * z) : 0;
}

/** g(x) = 1 − (1 − e^(−x))/x (Janosi–Hanamoto patch average), Padé form. */
export function janosiG(x: number): number {
  if (!(x > 0)) return 0;
  return (x * (6 + x)) / (12 + 6 * x + x * x);
}

/**
 * Soil shear coefficient at combined slip σ over a patch of length L (m) and
 * area A (m²) under load W (N): (c·A/W + tan φ)·g(σL/K), strength scaled by wetness.
 */
export function soilMu(t: SoilTable, sigma: number, L: number, A: number, W: number, strength: number): number {
  const cap = (W > 1 ? (t.c * A) / W : 0) + t.tanPhi;
  return cap * strength * janosiG((sigma * L) / t.K);
}

// ------------------------------------------------------------ water
/** Hydroplaning onset (full lift) speed, m/s, at gauge pressure p (Pa), tread depth d and water depth h (mm). */
export function hydroplaneSpeed(pGauge: number, d: number, h: number): number {
  if (!(h > 0.05)) return Infinity;
  const kpa = pGauge > 1000 ? pGauge / 1000 : 1;
  const kmh = 6.35 * Math.sqrt(kpa) * (0.456 + (0.67 * d) / (d + h) + 0.568 / h);
  return kmh / 3.6;
}

/** Water film depth (mm) on a sealed surface from the weather (wetness, rain 0..1). */
export function waterDepth(wetness: number, rain: number): number {
  return wetness * (0.2 + 2.3 * rain);
}
