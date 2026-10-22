/**
 * Per-vehicle WATER specs (R-PHYS2) — PURE DATA: no engine / state / worker
 * imports, no three, no DOM. Keyed by VehicleDef.name; a vehicle without an
 * entry keeps the P5 law (uniform density 500 + the global flood level).
 *
 * MODEL (src/sim/water/vehicleWater.ts runs it):
 *  - DISPLACEMENT is per node and physical: every body node displaces its
 *    solid share m_i/solidDensity, every node of a sealed COMPARTMENT (cabin,
 *    trunk, cab, box) also carries an equal share of that compartment's air
 *    volume, wheels keep m/500 (tyre air). So a car floats nose down (the
 *    engine bay has mass but no air) with the waterline near the sills.
 *  - FLOODING per compartment: water enters through openings at their world
 *    heights by the orifice law Q = C_d·A·sign(Δh)·sqrt(2g|Δh|) (Δh = outside
 *    head − inside head over the opening's lower edge); the openings are the
 *    door / floor SEALS (closed car), every broken GLASS beam of the
 *    compartment (its share of `glazingArea`), every broken structural beam
 *    of it (a torn seam, TEAR_AREA_M2 each) and permanent openings (no
 *    glass). The water inside weighs on the compartment's nodes below its
 *    free surface (deepest first), so the car tips toward its flooded end.
 *
 * NUMBERS (sources):
 *  - Passenger volumes: EPA interior volume classes (mid-size sedan
 *    2.8–3.1 m³, compact 2.5–2.8, two-seat / minicompact ≤ 2.4, crew cab
 *    pickup ≈ 3.4 incl. rear seat), trunk 0.3–0.45 m³.
 *  - Time afloat: McDonald & Giesbrecht, "Vehicle submersion: a review of the
 *    problem, associated risks, and survival information", Aviat. Space
 *    Environ. Med. 84 (2013): vehicles float 30–120 s (a sealed modern car
 *    toward the long end), the water reaches the side windows in ≈ 60 s; an
 *    open / broken window floods the cabin within seconds once under.
 *    `sealArea` is calibrated to that (vehicleWater.test.ts).
 *  - Intakes: the air-intake snorkel / filter box inlet behind the grille or
 *    the headlight (cars 0.6–0.8 m, a pickup ≈ 1.0 m, a medium-duty truck's
 *    behind-cab / under-hood inlet ≈ 1.5 m above the ground).
 */

export interface WaterOpeningSpec {
  /** Body node id whose world height is the opening's lower edge. */
  node: string;
  /** Effective open area, m². */
  area: number;
}

export interface WaterCompartmentSpec {
  name: string;
  /** Body node-id prefixes (`s5_` …) whose nodes form the compartment's shell. */
  prefixes: readonly string[];
  /** Sealed air volume, m³. */
  airVolume: number;
  /** Effective orifice area of the closed compartment's seals / drains / vents, m² (low on the shell). */
  sealArea: number;
  /** Total glazing of the compartment, m² (shared among its glass beams; open when one breaks). */
  glazingArea: number;
  /** Openings that are always open (a derby car without glass), m². */
  openings?: readonly WaterOpeningSpec[];
}

export interface VehicleWaterSpec {
  compartments: readonly WaterCompartmentSpec[];
  /** Body node id at the engine air intake (hydrolock when water reaches it with the engine running), or null. */
  intake: string | null;
  /** Height of the intake above that node, m (rig-local, along the body's up). */
  intakeOffset: number;
  /** Mean density of the body's solid material (steel, iron, glass, plastics, trim), kg/m³. */
  solidDensity: number;
  /** Body form-drag coefficient on the submerged projected area. */
  dragCoeff: number;
}

/** A broken structural beam of a compartment opens a seam of this area, m² (total capped at TEAR_AREA_MAX_M2). */
export const TEAR_AREA_M2 = 0.004;
export const TEAR_AREA_MAX_M2 = 0.4;
/** Orifice discharge coefficient (sharp-edged opening). */
export const ORIFICE_CD = 0.6;
/** A flooding compartment keeps this share of its air (the air pocket under the roof). */
export const AIR_POCKET_FRACTION = 0.04;
/** Glass beams: never yield, break at 1.5–6 % strain (the vehicle defs' brittle glass class). */
export const GLASS_STRAIN_MIN = 0.015;
export const GLASS_STRAIN_MAX = 0.06;
/** Engine running (hydrolock possible) above this crank speed, rpm. */
export const HYDROLOCK_MIN_RPM = 300;
/**
 * Bow wave: the water in front of a wading vehicle stands up by k·v²/2g, capped. The intakes sit behind the
 * grille, in the bumper's stagnation zone (full stagnation head k = 1 on a flat face; a bumper with an
 * under-tray lets some flow pass under, k ≈ 0.8). Flood-wading guidance: a 30 cm ford taken at ≈ 15 km/h
 * throws water over a sedan's bonnet (≈ +0.5 m), the walking-pace "bow wave" technique raises it ≈ 10 cm.
 */
export const BOW_WAVE_K = 0.8;
export const BOW_WAVE_MAX_M = 0.5;

const SEDAN_STATIONS = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let s = from; s <= to; s++) out.push(`s${s}_`);
  return out;
};

const SEDAN_SPEC: VehicleWaterSpec = {
  compartments: [
    { name: 'cabin', prefixes: SEDAN_STATIONS(5, 9), airVolume: 2.85, sealArea: 0.0105, glazingArea: 3.4 },
    { name: 'trunk', prefixes: SEDAN_STATIONS(10, 12), airVolume: 0.45, sealArea: 0.012, glazingArea: 0 },
  ],
  intake: 's2_rt',
  intakeOffset: -0.05,
  solidDensity: 3000,
  dragCoeff: 1.0,
};

export const VEHICLE_WATER_SPECS: Readonly<Record<string, VehicleWaterSpec>> = {
  sedan: SEDAN_SPEC,
  sedanTraffic: SEDAN_SPEC,
  coupe: {
    compartments: [
      { name: 'cabin', prefixes: SEDAN_STATIONS(5, 9), airVolume: 2.3, sealArea: 0.009, glazingArea: 2.8 },
      { name: 'trunk', prefixes: SEDAN_STATIONS(10, 11), airVolume: 0.3, sealArea: 0.01, glazingArea: 0 },
    ],
    intake: 's2_rt',
    intakeOffset: -0.05,
    solidDensity: 3000,
    dragCoeff: 1.0,
  },
  beater: {
    // Derby rules: no glass at all — the window openings are permanently open (side windows,
    // the mesh windscreen, the rear window), so once the belt line goes under it floods at once.
    compartments: [
      {
        name: 'cabin',
        prefixes: SEDAN_STATIONS(5, 9),
        airVolume: 2.5,
        sealArea: 0.014,
        glazingArea: 0,
        openings: [
          { node: 's5_cw', area: 0.8 },
          { node: 's6_bt_L', area: 0.3 },
          { node: 's6_bt_R', area: 0.3 },
          { node: 's8_bt_L', area: 0.25 },
          { node: 's8_bt_R', area: 0.25 },
          { node: 's9_dk', area: 0.55 },
        ],
      },
      { name: 'trunk', prefixes: SEDAN_STATIONS(10, 12), airVolume: 0.35, sealArea: 0.012, glazingArea: 0 },
    ],
    intake: 's2_rt',
    intakeOffset: -0.05,
    solidDensity: 3000,
    dragCoeff: 1.05,
  },
  pickup: {
    // The bed is open (no air); the crew cab is the one sealed volume.
    compartments: [{ name: 'cab', prefixes: ['c0_', 'c1_', 'c2_', 'c3_', 'c4_'], airVolume: 3.4, sealArea: 0.012, glazingArea: 3.2 }],
    intake: 'eng_fhi_L',
    intakeOffset: 0,
    solidDensity: 3500,
    dragCoeff: 1.05,
  },
  boxtruck: {
    // Cab + a dry-freight box: the box is far from watertight (roll-up door gaps, a plank floor).
    compartments: [
      { name: 'cab', prefixes: ['c0_', 'c1_', 'c2_', 'c3_'], airVolume: 2.8, sealArea: 0.012, glazingArea: 2.4 },
      { name: 'box', prefixes: ['b0_', 'b1_', 'b2_', 'b3_', 'b4_', 'b5_', 'b6_', 'b7_', 'bf_'], airVolume: 32, sealArea: 0.12, glazingArea: 0 },
    ],
    intake: 's2_ai_L',
    intakeOffset: 0,
    solidDensity: 4000,
    dragCoeff: 1.1,
  },
};
