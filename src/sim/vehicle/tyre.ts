/**
 * TYRE MODEL (worker-only; R-PHYS friction state, R-TYRE thermal / inflation
 * / wear / surface state). The tyre's FORCES stay emergent (tread nodes,
 * contact layer, lateral brush on a compliant carcass, ring; wheels.ts /
 * ground.ts); this module sets, every tick before the brush and the ground
 * pass, the Coulomb μ every tread node of the wheel sees — so the brush cap,
 * the node-level stick and the friction ellipse all follow it — and returns
 * the wheel's extra rolling torque.
 *
 * TREAD-NODE μ IS THE TYRE–SURFACE μ (R-TYRE): this module composes the
 * absolute μ of the patch and writes it ÷ the patch material's multiplier
 * (the ground pass and the brush multiply by the node's material, as for
 * every node), so on the patch's own material the product is exactly:
 *
 *  firm ground   μ = μ_base · f_load · f_slip · f_T · f_p · f_wear · grip_s · f_wet · f_hydro
 *  soft ground   μ = μ_soil(σ) · strength_wet                  (tyreSurface.ts)
 *
 * - f_load (LOAD SENSITIVITY, R-PHYS): 1 − ls·(F̄z/Fz0 − 1), clamped [0.7, 1.2]
 *   (Pacejka 2012 §4.3, pDy2 ≈ −0.1); F̄z low-passed over LOAD_TAU.
 * - f_slip (SLIDING FALL-OFF, R-PHYS): 1 − (1 − r)·S(σ) with S a smoothstep
 *   from σ_peak to σ_slide on the rigid wheel's combined slip σ = |slip
 *   velocity| / max(V, 3 m/s) (μ_slide/μ_peak ≈ 0.7–0.85 on dry asphalt).
 * - f_T: the compound's temperature window at the tread temperature
 *   (tyreThermal.ts compoundFactor; cold road tyres ≈ −5 % near 0 °C,
 *   performance compounds want 50–100 °C, everything overheats past ≈ 120 °C).
 * - f_p: grip vs inflation, 1 − 0.1·dpi clamped [0.95, 1.08] (dpi = p/p0 − 1;
 *   a smaller, harder patch grips less: MF 6.1's ppx3 / ppy3 ≈ −0.1 … −0.3,
 *   Besselink, Schmeitz & Pacejka, VSD 48 (2010)).
 * - f_wear: 1 + 0.05·worn (worn = 1 − d/d_new): a worn tread's stiffer, shorter
 *   blocks squirm less: a bald tyre grips ≈ 5 % more on DRY roads (tyre tests),
 *   and far less on wet ones (f_wet below).
 * - grip_s, f_wet, f_hydro: the surface (tyreSurface.ts): dry grip relative to
 *   asphalt; wet μ falling with speed and tread wear; hydroplaning lift above
 *   0.7·V_hp(p, tread, water).
 *
 * INFLATION drives the carcass (MF-Swift: vertical stiffness ∝ 1 + 0.7·dpi,
 * the remaining 30 % structural; a flat tyre squashes to its rim): the
 * sidewall beams' k, the tread contact layer (where most of the rig's
 * vertical compliance sits) and the carcass lateral stiffness scale with
 * clamp(0.3 + 0.7·p/p0, 0.3, 1) — over-inflation does not stiffen (the
 * beams sit at the ω·dt budget) — and the rolling resistance with
 * (p/p0)^−0.375 (SAE J2452: C_rr ∝ p^α, α ≈ −0.3…−0.5; p^0.375 by square roots),
 * plus, below 30 % of p0, the flat tyre's carcass work: C_rr + 0.25·(1 − p/0.3p0)²
 * (a flat drags at C_rr ≈ 0.1–0.3 and its flexing carcass overheats).
 *
 * SOFT SOIL (sand, mud, gravel, dirt, grass): Bekker's pressure–sinkage law
 * becomes the tread nodes' CONTACT law: each node's soft-layer stiffness is the
 * rubber layer in series with the soil's secant stiffness (load ÷ the
 * equivalent rigid wheel's Bekker sinkage z0, shared over the contact nodes),
 * so the tyre sinks z0 under its load and further where the load rises (the
 * soil's energy loss is the compaction resistance below: a one-sided node
 * damper was tried — the polygon's tread nodes touch down at metres per
 * second, so it became a rolling loss several times R_c). The tyre deflection that sets the equivalent
 * diameter is the PHYSICAL one, δ = W/K_z with K_z ≈ 2.4·p·√(SW·D) (Rhyne-type
 * vertical stiffness: ≈ 200 kN/m for a 205/55R16 at 2.3 bar), not the rig's
 * (its contact layer is ≈ 2× softer than a real carcass). The compaction
 * resistance R_c and the longitudinal bulldozing of the soil beyond 0.06·D roll
 * against the wheel as a torque, and a sunk tyre sliding sideways pushes a
 * berm (lateral bulldozing force on the hubs). (A kinematic version that shrank
 * the tread nodes' contact radius by z limit-cycled: the support moved, the
 * load dropped, z recovered, the load spiked: Fz −2.7…+9.4 kN on the bench.)
 * R-PHYS2 (persistent ruts): `setSoilRutHook` (see there).
 *
 * ROLLING-LOSS CORRECTION (R-PHYS): WheelDef.rollingLossComp (per unit load
 * every 10 km/h of tread speed) offsets the 12-ray tread polygon's vibration
 * loss, fed back as a torque in the rolling direction (calibrated by R-PHYS:
 * realism/coastdown, powertrain road load).
 *
 * Hot path: only + − × ÷ sqrt, no allocation, fixed order.
 */
import { MaterialId } from '../../protocol/messages';
import { NODE_FLAG_IN_CONTACT, type HeightSampler, type MaterialTable, type SimState } from '../types';
import {
  WHEEL_FLAG_CONTACT,
  WHEEL_FLAG_DEBEADED,
  WHEEL_FLAG_DETACHED,
  WHEEL_FLAG_FLAT,
  WHEEL_FLAG_HYDROPLANING,
  WHEEL_FLAG_LEAKING,
  WHEEL_FLAG_ON_RIM,
  WHEEL_FLAG_TPMS,
  type WheelFrame,
} from '../../protocol/wheels';
import type { CompiledWheel, WheelRuntime } from './types';
import {
  createTyreThermalState,
  gasMassAt,
  compoundFactor,
  resetTyreThermalState,
  stepTyreThermal,
  treadTemp,
  T_REF,
  tyreThermalParams,
  type TyreHeatInputs,
  type TyreThermalParams,
  type TyreThermalState,
} from './tyreThermal';
import { bulldozing, createSoilTables, hydroplaneSpeed, soilLookup, soilMu, TYRE_SURFACES, waterDepth, type SoilTable } from './tyreSurface';

/** Low-pass time constant of the wheel load feeding f_load, s. */
export const LOAD_TAU = 0.03;
/** Floor of the speed normalising σ, m/s (a car sliding sideways at walking pace still slides). */
export const SIGMA_V_MIN = 3;
/** Low-pass of σ, s (ω ripple of the soft ring). */
export const SIGMA_TAU = 0.01;
/** Clamp of the load factor. */
export const LOAD_FACTOR_MIN = 0.7;
export const LOAD_FACTOR_MAX = 1.2;
/** Defaults for the optional WheelDef fields. */
export const TYRE_DEFAULTS = {
  loadSensitivity: 0,
  slideRatio: 1,
  peakSlip: 0.1,
  slideSlip: 0.6,
} as const;
/** Speed step of WheelDef.rollingLossComp, m/s (10 km/h). */
export const ROLL_COMP_STEP = 10 / 3.6;
/** Structural share of the carcass stiffness (MF-Swift pfz1 ≈ 0.7: the rest is inflation). */
export const CARCASS_STRUCT = 0.3;
/** Flat-tyre rolling resistance: added C_rr at zero pressure (fades in below FLAT_FROM·p0). */
export const FLAT_CRR = 0.25;
export const FLAT_FROM = 0.3;
/** The rig's free-rolling loss ÷ its compiled C_rr (sedan bench, 15 m/s: 0.0143 / 0.008): scales the inflation correction. */
export const CRR_RIG_GAIN = 1.8;
/** Grip vs inflation slope and clamps (f_p). */
export const PRESSURE_GRIP = 0.1;
/** Dry-grip gain of a fully worn tread. */
export const WEAR_DRY_GAIN = 0.05;
/** Wet-grip loss of a fully worn tread, × the speed term of f_wet. */
export const WEAR_WET_GAIN = 0.8;
/** Hydroplaning: lift starts at this fraction of V_hp and is complete at V_hp; grip left at full lift. */
export const HYDRO_ONSET = 0.7;
export const HYDRO_GRIP_LOST = 0.92;
/** Rhyne-type vertical stiffness K_z = KZ_COEF·p·√(SW·D), N/m (p in Pa, SW section width, D diameter, m). */
export const KZ_COEF = 2.4;
/** Low-pass of the contact-node count sharing the soil spring, per tick. */
const NCONT_ALPHA = 1 / 41;
/** Longitudinal bulldozing acts on sinkage beyond this share of the diameter (Bekker; see tyreSurface.ts). */
export const BULLDOZE_FROM_D = 0.06;
/** Soil hold: below SOIL_HOLD_V (m/s) the slip fed to Janosi–Hanamoto rises toward SOIL_HOLD_I (full shear). */
export const SOIL_HOLD_V = 2;
export const SOIL_HOLD_I = 1;
/** Speed floor of the soil's slip ratio, m/s. */
export const SOIL_V_FLOOR = 0.5;
/** Lateral bulldozing velocity regularisation, m/s. */
export const BULLDOZE_V0 = 0.3;
/** Rolling resistance ω ramp, rad/s (= types ROLL_RES_OMEGA_EPS). */
const ROLL_OMEGA_EPS = 0.1;
/** Sidewall beams within each ray's 22 (WHEEL BEAM ORDER: 8 rim, 4 tread, 8 sidewall, 2 X-brace). */
const SIDE_FIRST = 12;
const SIDE_COUNT = 8;
const BEAMS_PER_RAY = 22;

/**
 * Feature switches of the R-TYRE state (harness / A-B diagnostics only; the
 * game never changes them, and a run must not toggle them mid-way: they are
 * not part of the replayed state). Each off = that factor stays at its
 * nominal value (μ factor 1, no pressure-driven carcass / rolling change,
 * no rim damage).
 */
export const TYRE_FEATURES = { thermalGrip: true, inflation: true, rimDamage: true, wear: true };

// ------------------------------------------------------------ environment (module state, set by the engine)
/** Surface water and weather the tyres see (engine `setSurfaceWetness`, a logged command). */
export const tyreEnv = { wetness: 0, rain: 0, ambient: T_REF };
export function setTyreEnvironment(wetness: number, rain: number): void {
  tyreEnv.wetness = wetness;
  tyreEnv.rain = rain;
}

/**
 * R-PHYS2 seam (persistent soft-ground ruts): `rutDepth(x, z)` = how deep the
 * soil under (x, z) is already compacted (m, ≥ 0): a tyre rolling in its rut
 * sinks only the rest of its Bekker sinkage (repetitive loading). `onSink`
 * reports every soft-ground wheel each tick (contact point, sinkage, width).
 * Null = none (fresh soil everywhere).
 */
export interface SoilRutHook {
  rutDepth(x: number, z: number): number;
  onSink(objectId: number, wheel: number, x: number, z: number, sinkage: number, width: number): void;
}
let rutHook: SoilRutHook | null = null;
export function setSoilRutHook(h: SoilRutHook | null): void {
  rutHook = h;
}

/** Per-wheel tyre state (preallocated at spawn; worker-only). */
export interface TyreState {
  /** Base μ of each tyre ring node (rig nodeFriction), 2·rays. */
  base: Float64Array;
  /** Design load Fz0, N. */
  fz0: number;
  loadSensitivity: number;
  slideRatio: number;
  peakSlip: number;
  slideSlip: number;
  /** Rolling-loss correction table (per unit load, every ROLL_COMP_STEP), may be empty. */
  rollComp: Float64Array;
  /** Low-passed load (N) and combined slip. */
  load: number;
  sigma: number;
  /** Last μ factor applied (μ_node / μ_base on firm ground). */
  factor: number;
  // ---- R-TYRE
  thermalP: TyreThermalParams;
  thermal: TyreThermalState;
  /** Soil tables per MaterialId (null = firm). */
  soil: (SoilTable | null)[];
  /** Tyre outer diameter and section width, m; tread node contact radius at rest. */
  diameter: number;
  sectionWidth: number;
  nodeRadius: number;
  /** Bekker sinkage of the patch (soil), m (telemetry, rut hook). */
  sinkage: number;
  /** Compiled soft-layer stiffness of the tread nodes, N/m; contact nodes low-passed; soil contact law on. */
  kRubber: number;
  nContact: number;
  soilOn: boolean;
  /** Contact-layer stiffness last written on firm ground, N/m. */
  contactApplied: number;
  /** RIG-LOCAL sidewall beam indices and their compiled stiffness. */
  sideBeams: Int32Array;
  sideK0: Float64Array;
  /** Carcass multiplier last written into the sidewall beams (1 = compiled). */
  carcassApplied: number;
  /** Compiled carcass lateral stiffness, N/m. */
  carcassK0: number;
  /** Compiled rolling resistance coefficient. */
  crr0: number;
  /** Surface under the patch (MaterialId) and the lift / grip of the last tick (telemetry). */
  material: number;
  lift: number;
  grip: number;
  waterDepth: number;
  /** Owner (soil hook reports): objectId and wheel index; global beam base of the vehicle (rebase). */
  objectId: number;
  wheelIndex: number;
  beamBase: number;
  /** The bead has unseated (debead puncture): flat, the tread slips on the rim. */
  debeaded: boolean;
  /** Rewrite the carcass beams and tread radii next tick (repair / service). */
  dirty: boolean;
  /** Last tick's rim-strike speed (m/s, 0 = rim clear) and the low-passed |side force| on the bead, N. */
  rimStrike: number;
  beadFy: number;
}

/** Spawn-time constants of a wheel for its tyre state (rig-local beam data from the compiled rig). */
export interface TyreSpawn {
  cw: CompiledWheel;
  base: Float64Array;
  fz0: number;
  /** CompiledRig.beamK (rig-local). */
  beamK: Float64Array;
  /** Number of WheelDef.attach nodes (beam order: attach beams first). */
  attachCount: number;
  /** Compiled contact radius and soft-layer stiffness of the tread nodes. */
  nodeRadius: number;
  contactK: number;
  objectId: number;
}

export function createTyreState(sp: TyreSpawn): TyreState {
  const cw = sp.cw;
  const t = cw.tyre;
  const width = t?.width ?? 0.15;
  const thermalP = tyreThermalParams({
    radius: cw.radius,
    rimRadius: cw.rimRadius,
    width,
    tyreMass: t?.tyreMass ?? 9,
    pressure: (t?.pressure ?? 230) * 1000,
    compound: t?.compound ?? 'road',
    treadDepth: t?.treadDepth ?? 8,
  });
  const fz0 = sp.fz0 > 0 ? sp.fz0 : 1;
  const sectionWidth = 1.35 * width;
  const n = cw.rays;
  const sideBeams = new Int32Array(n * SIDE_COUNT);
  const sideK0 = new Float64Array(n * SIDE_COUNT);
  const first = cw.beamStart + 2 * sp.attachCount + 1;
  for (let r = 0; r < n; r++) {
    for (let q = 0; q < SIDE_COUNT; q++) {
      const b = first + r * BEAMS_PER_RAY + SIDE_FIRST + q;
      sideBeams[r * SIDE_COUNT + q] = b;
      sideK0[r * SIDE_COUNT + q] = sp.beamK[b]!;
    }
  }
  return {
    base: sp.base,
    fz0,
    loadSensitivity: t?.loadSensitivity ?? TYRE_DEFAULTS.loadSensitivity,
    slideRatio: t?.slideRatio ?? TYRE_DEFAULTS.slideRatio,
    peakSlip: t?.peakSlip ?? TYRE_DEFAULTS.peakSlip,
    slideSlip: t?.slideSlip ?? TYRE_DEFAULTS.slideSlip,
    rollComp: Float64Array.from(t?.rollingLossComp ?? []),
    load: fz0,
    sigma: 0,
    factor: 1,
    thermalP,
    thermal: createTyreThermalState(thermalP, T_REF),
    soil: createSoilTables(sectionWidth, 2 * cw.radius, fz0),
    diameter: 2 * cw.radius,
    sectionWidth,
    nodeRadius: sp.nodeRadius,
    sinkage: 0,
    kRubber: sp.contactK,
    nContact: 4,
    soilOn: false,
    contactApplied: sp.contactK,
    sideBeams,
    sideK0,
    carcassApplied: 1,
    carcassK0: t?.lateralStiffness ?? 0,
    crr0: cw.rollingResistance,
    material: MaterialId.asphalt,
    lift: 0,
    grip: 1,
    waterDepth: 0,
    objectId: sp.objectId,
    wheelIndex: cw.index,
    beamBase: 0,
    debeaded: false,
    dirty: false,
    rimStrike: 0,
    beadFy: 0,
  };
}

/** Full repair: cold, inflated, new tread, out of any rut (the engine has restored the rig's beams and radii). */
export function resetTyreState(t: TyreState): void {
  t.load = t.fz0;
  t.sigma = 0;
  t.factor = 1;
  resetTyreThermalState(t.thermalP, t.thermal, T_REF);
  t.sinkage = 0;
  t.carcassApplied = 1;
  t.contactApplied = t.kRubber;
  t.lift = 0;
  t.grip = 1;
  t.debeaded = false;
  t.rimStrike = 0;
  t.beadFy = 0;
}

/** Leak orifice areas, m², of the puncture kinds (tyreThermal.ts orifice law). */
export const LEAK_AREA = {
  /** A nail / screw: a 0.5 mm path past the object — a few % a minute. */
  slow: 2e-7,
  /** A sidewall cut / gash ≈ 2 cm: flat in about a second. */
  fast: 3e-4,
  /** The bead unseated: the whole bead gap. */
  debead: 3e-3,
} as const;
/**
 * RIM STRIKES: a rim node in contact means the tyre has bottomed out (the rim
 * sits ≈ 10 cm inside the tread on a car tyre); its approach speed grades
 * the damage: the HUB's approach speed (the tyre's compression rate; a rim
 * node's own velocity carries the spin) — on the ground along the ground
 * normal at the node (a flat rolling on its rim, or a rim grazing the road
 * at speed, reads ≈ 0; a pothole's far edge reads the hub's speed into it),
 * on a collider (kerb face or edge) toward the node (a round rim's contact
 * normal passes near its centre). A corner mass of ≈ 400 kg on a ≈ 200 kN/m tyre
 * bottoms its 8 cm at ≈ 1.8 m/s; a kerb or a sharp pothole edge hit at
 * 30–50 km/h meets the rim at ≈ 3–6 m/s; unseating a bead by impact takes a
 * crash-grade hit (≥ 12 m/s: the wheel driven into a wall). Graded (m/s): a bent flange / nicked
 * bead (slow leak, the classic kerb-strike leak), a pinch cut / sidewall
 * rupture (fast), the bead knocked off its seat (debead). Tyre makers'
 * impact-damage guidance and pothole studies (e.g. Kelley / Bridgestone
 * pinch-shock notes; Varma & Bhattacharya, SAE 2012-01-0200 pothole loads).
 * BEAD UNSEATING under side load: the bead's hold on the rim's safety humps
 * falls with the pressure (FMVSS 139 bead-unseat resistance is tested
 * inflated); below BEAD_FROM·p0 a side force (low-passed BEAD_TAU) above
 * Fz0·(BEAD_HOLD0 + BEAD_HOLD_P·p/p0) rolls the bead off: hard cornering on
 * a flat debeads, a half-inflated tyre needs ≈ 1.1·Fz0 of side force.
 */
export const RIM_STRIKE = { slow: 1.5, fast: 3.5, debead: 12 } as const;
/** A rim node this close above the ground (beyond its radius, m) is on the ground, not a collider. */
export const RIM_GROUND_SLOP = 0.01;
export const BEAD_FROM = 0.5;
export const BEAD_HOLD0 = 0.45;
export const BEAD_HOLD_P = 1.3;
export const BEAD_TAU = 0.05;
/** Tread μ left on a debeaded tyre (the tread slips round the rim). */
export const DEBEAD_GRIP = 0.3;

/** Opens a leak (the larger of the current one and the kind's). */
export function punctureTyre(t: TyreState, kind: keyof typeof LEAK_AREA): void {
  const a = LEAK_AREA[kind];
  if (a > t.thermal.leakArea) t.thermal.leakArea = a;
  if (kind === 'debead') t.debeaded = true;
}

/** Re-inflates / airs down to a cold gauge pressure (kPa) at the current gas temperature; seals a slow leak. */
export function setTyrePressure(t: TyreState, kPa: number): void {
  const th = t.thermal;
  if (th.leakArea <= LEAK_AREA.slow) th.leakArea = 0;
  if (t.debeaded || th.leakArea > 0) return; // a cut or an unseated bead does not hold air
  const gauge = kPa > 0 ? kPa * 1000 : 0;
  th.gasMass = gasMassAt(t.thermalP, gauge, T_REF);
  th.pressure = (th.gasMass * 287.05 * (th.tGas + 273.15)) / t.thermalP.volume - 101_325;
  if (th.pressure < 0) th.pressure = 0;
  t.dirty = true;
}

/** Sets the remaining tread depth, mm (clamped to 0 … new): a worn tyre (less wet grip, earlier hydroplaning). */
export function setTreadDepth(t: TyreState, mm: number): void {
  const n = t.thermalP.treadNew;
  t.thermal.tread = mm < 0 ? 0 : mm > n ? n : mm;
}

/** New tyre (cold, sealed, design pressure, full tread). */
export function repairTyre(t: TyreState): void {
  resetTyreState(t);
  t.dirty = true;
}

// ------------------------------------------------------------ telemetry
/** TPMS warning threshold: 25 % below the cold placard (FMVSS 138). */
export const TPMS_WARN_RATIO = 0.75;
/** Flat below this gauge pressure, Pa. */
export const FLAT_PRESSURE = 25e3;

/**
 * Fills a snapshot wheel record (protocol/wheels.ts) for wheel `w` of a
 * vehicle object. Snapshot-rate only (Math.atan2 is fine here: telemetry,
 * never sim state).
 */
export function fillWheelFrame(state: SimState, w: WheelRuntime, t: TyreState, objectId: number, discTemp: number, out: WheelFrame): WheelFrame {
  const th = t.thermal;
  let flags = 0;
  if (w.contact !== 0) flags |= WHEEL_FLAG_CONTACT;
  if (th.leakArea > 0 && th.pressure > FLAT_PRESSURE) flags |= WHEEL_FLAG_LEAKING;
  if (th.pressure <= FLAT_PRESSURE) flags |= WHEEL_FLAG_FLAT;
  if (t.debeaded) flags |= WHEEL_FLAG_DEBEADED;
  if (th.pressure < TPMS_WARN_RATIO * t.thermalP.p0) flags |= WHEEL_FLAG_TPMS;
  if (t.lift > 0.5) flags |= WHEEL_FLAG_HYDROPLANING;
  if (w.detached !== 0) flags |= WHEEL_FLAG_DETACHED;
  const fl = state.flags;
  const r0 = w.rimStart;
  for (let i = r0; i < r0 + w.ringCount; i++) {
    if ((fl[i]! & NODE_FLAG_IN_CONTACT) !== 0) {
      flags |= WHEEL_FLAG_ON_RIM;
      break;
    }
  }
  // slip angle of the hub velocity against the wheel heading (axle s, forward = s × up)
  const { velX, velZ, posX, posZ } = state;
  const hi = w.hubI;
  const ho = w.hubO;
  const vx = (velX[hi]! + velX[ho]!) * 0.5;
  const vz = (velZ[hi]! + velZ[ho]!) * 0.5;
  let sx = posX[ho]! - posX[hi]!;
  let sz = posZ[ho]! - posZ[hi]!;
  const sl = Math.hypot(sx, sz);
  let alpha = 0;
  if (sl > 1e-9) {
    const k = w.wheel.spinSign / sl;
    sx *= k;
    sz *= k;
    // forward f = s × (0, 1, 0) = (−s_z, 0, s_x); "right" = −s (s points vehicle-left)
    const vf = -sz * vx + sx * vz;
    const vr = -(sx * vx + sz * vz);
    if (Math.abs(vf) > 0.5) alpha = Math.atan2(vr, Math.abs(vf));
  }
  out.objectId = objectId;
  out.wheel = w.wheel.index;
  out.flags = flags;
  out.materialId = t.material;
  out.pressureKpa = th.pressure / 1000;
  out.tSurface = th.tSurf;
  out.tCarcass = th.tCarc;
  out.tGas = th.tGas;
  out.treadMm = th.tread;
  out.tDisc = discTemp;
  out.sinkage = t.sinkage;
  out.grip = t.grip;
  out.lift = t.lift;
  out.slipRatio = w.slipRatio;
  out.slipAngle = alpha;
  out.load = w.load;
  return out;
}

// ------------------------------------------------------------ module scratch
const nrm = new Float64Array(3);
const heat: TyreHeatInputs = { slipPower: 0, rollPower: 0, speed: 0, contact: 0, discTemp: T_REF, ambient: T_REF, road: T_REF };

/**
 * Sets the μ of the wheel's tyre ring nodes for this tick (call after
 * estimateWheelOmega, before the brush and the ground pass), advances the
 * tyre's slow state and returns the extra torque about the spin axis (N·m,
 * signed: rolling-loss correction − surface / soil / inflation rolling
 * resistance), which the caller adds to the wheel's axle torque.
 * `sampler` = the active ground (null: no ground), `discTemp` = the wheel's
 * brake disc temperature (°C).
 */
export function stepTyre(
  state: SimState,
  w: WheelRuntime,
  t: TyreState,
  dt: number,
  sampler: HeightSampler | null = null,
  discTemp = T_REF,
  materials: MaterialTable | null = null,
): number {
  const { velX, velY, velZ, posX, posY, posZ, friction, frcX, frcY, frcZ } = state;
  // ---- load (low-passed)
  t.load += (w.load - t.load) * (dt / (LOAD_TAU + dt));
  // ---- combined slip of the rigid wheel at the contact
  const hi = w.hubI;
  const ho = w.hubO;
  const vx = (velX[hi]! + velX[ho]!) * 0.5;
  const vy = (velY[hi]! + velY[ho]!) * 0.5;
  const vz = (velZ[hi]! + velZ[ho]!) * 0.5;
  let sx = posX[ho]! - posX[hi]!;
  let sy = posY[ho]! - posY[hi]!;
  let sz = posZ[ho]! - posZ[hi]!;
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let sigma = 0;
  let uLat = 0;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (sl > 1e-9) {
    sx /= sl;
    sy /= sl;
    sz /= sl;
    uLat = vx * sx + vy * sy + vz * sz;
  }
  if (sl > 1e-9 && w.contact !== 0) {
    // lateral slip: hub velocity along the axle (≈ ground plane); longitudinal: ω·r − v_x via slipRatio
    const vFwd2 = speed * speed - uLat * uLat;
    const vFwd = vFwd2 > 0 ? Math.sqrt(vFwd2) : 0;
    const uLon = w.slipRatio * (vFwd > 0.5 ? vFwd : 0.5);
    const den = speed > SIGMA_V_MIN ? speed : SIGMA_V_MIN;
    sigma = Math.sqrt(uLat * uLat + uLon * uLon) / den;
  }
  t.sigma += (sigma - t.sigma) * (dt / (SIGMA_TAU + dt));

  // ---- the patch: surface under its load-weighted centre
  const t0 = w.tireStart;
  const n = w.ringCount;
  const tl = w.treadLoad;
  let pw = 0;
  let px = 0;
  let pz = 0;
  for (let j = 0; j < n; j++) {
    const fn = tl[j]!;
    if (!(fn > 0)) continue;
    pw += fn;
    px += fn * posX[t0 + j]!;
    pz += fn * posZ[t0 + j]!;
  }
  let mat = t.material;
  if (pw > 0 && sampler !== null) {
    px /= pw;
    pz /= pw;
    mat = sampler.materialAt(px, pz);
    t.material = mat;
  }
  const surf = TYRE_SURFACES[mat] ?? TYRE_SURFACES[MaterialId.asphalt]!;
  const soilT = t.soil[mat] ?? null;

  // ---- thermal / inflation / wear
  const th = t.thermal;
  const p0 = t.thermalP.p0;
  let pr = TYRE_FEATURES.inflation ? th.pressure / p0 : 1;
  if (pr < 0) pr = 0;
  // rolling-resistance factor of the inflation, (p/p0)^−0.375 = 1/√(√x·√(√x)) (x clamped ≥ 0.25: a flat rides on the rim)
  const xr = pr > 0.25 ? pr : 0.25;
  const sxr = Math.sqrt(xr);
  const prr = 1 / Math.sqrt(sxr * Math.sqrt(sxr));
  let crrFlat = 0;
  if (pr < FLAT_FROM) {
    const xf = 1 - pr / FLAT_FROM;
    crrFlat = FLAT_CRR * xf * xf;
  }
  {
    const fxP = w.patchFx ?? 0;
    const fyP = w.patchFy ?? 0;
    const uxP = w.patchUx ?? 0;
    heat.slipPower = (fyP < 0 ? -fyP : fyP) * (uLat < 0 ? -uLat : uLat) + fxP * uxP;
    // reference rolling loss C_rr·Fz·v (Wong: C_rr rises ≈ 0.01·(1 + V/160 km/h) for a car tyre)
    heat.rollPower = w.contact !== 0 ? (t.crr0 * prr * (1 + speed / 44.4) + crrFlat) * (w.load > 0 ? w.load : 0) * speed : 0;
    heat.speed = speed;
    heat.contact = w.contact;
    heat.discTemp = discTemp;
    heat.ambient = tyreEnv.ambient;
    heat.road = tyreEnv.ambient;
    stepTyreThermal(t.thermalP, th, heat, dt);
    pr = th.pressure / p0;
    if (pr < 0) pr = 0;
  }
  if (!TYRE_FEATURES.inflation) pr = 1;
  // ---- tyre damage (see the RIM STRIKES doc): the rim bottoming on the ground or a collider (last tick's contact
  // flags), and the bead unseating under side load at low pressure
  {
    const fl = state.flags;
    const r0 = w.rimStart;
    const rn = w.ringCount;
    let vn = 0;
    const cxh = (posX[hi]! + posX[ho]!) * 0.5;
    const cyh = (posY[hi]! + posY[ho]!) * 0.5;
    const czh = (posZ[hi]! + posZ[ho]!) * 0.5;
    const rad = state.radius;
    for (let i = r0; i < r0 + rn; i++) {
      if ((fl[i]! & NODE_FLAG_IN_CONTACT) === 0) continue;
      const x = posX[i]!;
      const z = posZ[i]!;
      let v: number;
      if (sampler !== null && posY[i]! - sampler.heightAt(x, z) < rad[i]! + RIM_GROUND_SLOP) {
        // on the ground: the hub's approach speed along the ground normal (the tyre's compression rate; a rim node's
        // own velocity carries the spin — ω·r_rim·sin θ downward just ahead of the bottom, 14 m/s at 260 km/h)
        sampler.normalAt(x, z, nrm);
        v = -(vx * nrm[0]! + vy * nrm[1]! + vz * nrm[2]!);
      } else {
        // on a collider (a kerb face, an edge): its contact normal through a round rim passes near the centre —
        // the hub's speed toward the node (the rim's spin is tangential)
        const dx = x - cxh;
        const dy = posY[i]! - cyh;
        const dz = z - czh;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(dl > 1e-6)) continue;
        v = (vx * dx + vy * dy + vz * dz) / dl;
      }
      if (v > vn) vn = v;
    }
    t.rimStrike = vn;
    if (!TYRE_FEATURES.rimDamage) vn = 0;
    if (vn > RIM_STRIKE.debead) punctureTyre(t, 'debead');
    else if (vn > RIM_STRIKE.fast) punctureTyre(t, 'fast');
    else if (vn > RIM_STRIKE.slow) punctureTyre(t, 'slow');
    const fyP = w.patchFy ?? 0;
    t.beadFy += ((fyP < 0 ? -fyP : fyP) - t.beadFy) * (dt / (BEAD_TAU + dt));
    if (TYRE_FEATURES.rimDamage && !t.debeaded && pr < BEAD_FROM && t.beadFy > t.fz0 * (BEAD_HOLD0 + BEAD_HOLD_P * pr)) punctureTyre(t, 'debead');
  }
  // carcass: vertical (sidewall beams) and lateral stiffness follow the inflation
  let kc = CARCASS_STRUCT + (1 - CARCASS_STRUCT) * pr;
  if (kc > 1) kc = 1;
  if (t.dirty || kc - t.carcassApplied > 0.002 || t.carcassApplied - kc > 0.002) {
    const kArr = state.k;
    const nb = t.sideBeams.length;
    const bb = t.beamBase;
    for (let q = 0; q < nb; q++) kArr[bb + t.sideBeams[q]!] = t.sideK0[q]! * kc;
    t.carcassApplied = kc;
  }
  w.carcassK = t.carcassK0 * t.carcassApplied;

  // ---- μ
  let mu: number;
  const wet = tyreEnv.wetness;
  const worn = 1 - th.tread / t.thermalP.treadNew;
  let L = 0;
  let A = 0;
  let zTarget = 0;
  let rc = 0;
  if (soilT !== null) {
    // patch on soil: flattened length of the deflected tyre + the sunk arc (equivalent rigid wheel, tyreSurface.ts)
    const D = t.diameter;
    const W = t.load > 0 ? t.load : 0;
    // physical vertical stiffness at this inflation (30 % structural, MF-Swift pfz1 ≈ 0.7)
    const kz = KZ_COEF * Math.sqrt(t.sectionWidth * D) * (CARCASS_STRUCT * p0 + (1 - CARCASS_STRUCT) * (th.pressure > 0 ? th.pressure : 0));
    let defl = W / kz;
    if (defl > 0.45 * D) defl = 0.45 * D;
    const lf2 = D * defl - defl * defl;
    const lf = lf2 > 0 ? 2 * Math.sqrt(lf2) : 0;
    const zc = t.sinkage > 1e-3 ? t.sinkage : 1e-3;
    const de = lf / Math.sqrt(zc) + Math.sqrt(D);
    const q = W / de; // W/√D_e, √D_e = de
    zTarget = soilLookup(soilT, soilT.z, q);
    rc = soilLookup(soilT, soilT.rc, q);
    if (rutHook !== null && pw > 0) {
      const rut = rutHook.rutDepth(px, pz);
      zTarget = zTarget > rut ? zTarget - rut : 0;
    }
    t.sinkage = zTarget;
    L = lf + Math.sqrt(D * zc);
    A = t.sectionWidth * L;
    let strength = 1 - surf.soilWet * wet;
    if (strength < 0.2) strength = 0.2;
    // a slow or parked wheel: a soil element dwells L/V in the patch, so any creep mobilises the soil's full
    // shear strength (j = creep × dwell ≫ K) — the rolling Janosi–Hanamoto slip only governs a moving patch
    // (without this a parked car slid down a 10° dirt trail: μ(σ = 0) = 0)
    // σ is normalised by max(V, 3 m/s) (R-PHYS fall-off); the soil wants the true slip, slip speed / V
    let iEff = speed < SIGMA_V_MIN ? (t.sigma * SIGMA_V_MIN) / (speed > SOIL_V_FLOOR ? speed : SOIL_V_FLOOR) : t.sigma;
    if (speed < SOIL_HOLD_V) iEff += (1 - speed / SOIL_HOLD_V) * SOIL_HOLD_I;
    mu = soilMu(soilT, iEff, L, A, W, strength);
    t.factor = mu / (t.base[0]! > 0 ? t.base[0]! : 1);
    t.lift = 0;
    t.waterDepth = 0;
  } else {
    let fl = 1 - t.loadSensitivity * (t.load / t.fz0 - 1);
    fl = fl < LOAD_FACTOR_MIN ? LOAD_FACTOR_MIN : fl > LOAD_FACTOR_MAX ? LOAD_FACTOR_MAX : fl;
    let fs = 1;
    if (t.slideRatio < 1) {
      let x = (t.sigma - t.peakSlip) / (t.slideSlip - t.peakSlip);
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      fs = 1 - (1 - t.slideRatio) * x * x * (3 - 2 * x);
    }
    const fT = TYRE_FEATURES.thermalGrip ? compoundFactor(t.thermalP.compound, treadTemp(th)) : 1;
    let fp = 1 - PRESSURE_GRIP * (pr - 1);
    fp = fp < 0.95 ? 0.95 : fp > 1.08 ? 1.08 : fp;
    const fw = TYRE_FEATURES.wear ? 1 + WEAR_DRY_GAIN * (worn > 0 ? worn : 0) : 1;
    let fwet = 1;
    let lift = 0;
    let wd = 0;
    if (wet > 0) {
      const kmh = speed * 3.6;
      fwet = 1 - wet * (surf.wet0 + surf.wet1 * kmh * (1 + WEAR_WET_GAIN * (worn > 0 ? worn : 0)));
      if (fwet < 0.15) fwet = 0.15;
      wd = waterDepth(wet, tyreEnv.rain);
      const vhp = hydroplaneSpeed(th.pressure, th.tread + surf.texture, wd);
      if (speed > HYDRO_ONSET * vhp) {
        let xh = (speed - HYDRO_ONSET * vhp) / ((1 - HYDRO_ONSET) * vhp);
        if (xh > 1) xh = 1;
        lift = xh * xh * (3 - 2 * xh);
      }
    }
    t.lift = lift;
    t.waterDepth = wd;
    const f = fl * fs * fT * fp * fw * surf.grip * fwet * (1 - HYDRO_GRIP_LOST * lift) * (t.debeaded ? DEBEAD_GRIP : 1);
    t.factor = f;
    mu = t.base[0]! * f;
  }
  t.grip = t.factor;
  const base = t.base;
  const b0 = base[0]! > 0 ? base[0]! : 1;
  // the ground pass and the brush multiply a node's friction by its material's (collision/materials.ts): divide that
  // back out at the patch centre so the patch sees the absolute μ composed here (a node on another material than
  // the centre keeps the ratio of the two tables: a smooth edge)
  const mf = materials !== null ? materials.friction[mat]! : 1;
  const muRel = mf > 1e-6 ? mu / mf : mu;
  for (let j = 0; j < n; j++) friction[t0 + j] = muRel * (base[j]! / b0);

  // ---- soil: the tread nodes' contact law (rubber in series with the soil's secant stiffness), compaction +
  // bulldozing resistance
  let extra = 0;
  const om = w.omega;
  let rr = om / ROLL_OMEGA_EPS;
  if (rr > 1) rr = 1;
  else if (rr < -1) rr = -1;
  {
    let nc = 0;
    for (let j = 0; j < n; j++) if (tl[j]! > 0) nc++;
    t.nContact += (nc - t.nContact) * NCONT_ALPHA;
    const contactK = state.contactK;
    // the contact layer carries the inflation's share of the vertical stiffness (× the carcass factor)
    const kr = t.kRubber * t.carcassApplied;
    if (soilT !== null && w.contact !== 0 && zTarget > 1e-5) {
      const W = t.load > 0 ? t.load : 0;
      const ncs = t.nContact > 1 ? t.nContact : 1;
      const ksTot = W / zTarget;
      const ks = ksTot / ncs;
      const kNode = kr > 0 ? (kr * ks) / (kr + ks) : ks;
      for (let j = 0; j < n; j++) contactK[t0 + j] = kNode;
      t.soilOn = true;
      // longitudinal: compaction + bulldozing beyond 0.06·D, as a rolling torque; lateral: the berm a sunk tyre pushes
      const z = zTarget;
      const zb = z - BULLDOZE_FROM_D * t.diameter;
      const rLon = rc + (zb > 0 ? bulldozing(soilT, zb, t.sectionWidth) : 0);
      extra -= rLon * w.rollRadius * rr;
      const rLat = bulldozing(soilT, z, L);
      if (rLat > 0 && sl > 1e-9) {
        const ax = sx;
        const az = sz;
        const al = Math.sqrt(ax * ax + az * az);
        if (al > 1e-6) {
          const ua = (vx * ax + vz * az) / al;
          const fb = (-rLat * ua) / ((ua < 0 ? -ua : ua) + BULLDOZE_V0);
          const gx = (0.5 * fb * ax) / al;
          const gz = (0.5 * fb * az) / al;
          frcX[hi] = frcX[hi]! + gx;
          frcZ[hi] = frcZ[hi]! + gz;
          frcX[ho] = frcX[ho]! + gx;
          frcZ[ho] = frcZ[ho]! + gz;
        }
      }
      if (rutHook !== null) rutHook.onSink(t.objectId, t.wheelIndex, px, pz, z, t.sectionWidth);
    } else {
      if (t.soilOn || t.dirty || kr !== t.contactApplied) {
        for (let j = 0; j < n; j++) contactK[t0 + j] = kr;
        t.soilOn = false;
        t.contactApplied = kr;
      }
      if (soilT === null) t.sinkage = 0;
    }
    t.dirty = false;
  }
  // firm-surface roughness and the inflation's share of the rolling resistance (the compiled C_rr is the
  // nominal tyre's: applyWheelTorques). INFLATION: the rig's own rolling loss already grows as the carcass factor
  // kc softens it (bench: loss ∝ 1/kc, +32 % at 0.7·p0 — hysteresis ∝ deflection), steeper than real tyres
  // (SAE J2452: ∝ p^−0.3…−0.5); the correction CRR_RIG_GAIN·C_rr·((p/p0)^−0.375 − 1/kc) brings the total onto
  // p^−0.375 (bench +19 % at 0.7·p0) and lowers it when over-inflated (kc is clamped at 1 there).
  if (w.load > 0 && w.detached === 0) {
    const kcNow = t.carcassApplied > CARCASS_STRUCT ? t.carcassApplied : CARCASS_STRUCT;
    const crrX = surf.crr + crrFlat + CRR_RIG_GAIN * t.crr0 * (prr - 1 / kcNow);
    if (crrX !== 0) extra -= crrX * w.load * w.rollRadius * rr;
  }

  // ---- rolling-loss correction (tread speed, per unit load, linear in the table)
  const tab = t.rollComp;
  const nt = tab.length;
  if (nt === 0 || !(w.load > 0) || w.detached !== 0) return extra;
  let vt = om * w.rollRadius;
  if (vt < 0) vt = -vt;
  const xi = vt / ROLL_COMP_STEP;
  const i = xi | 0;
  let c: number;
  if (i >= nt - 1) c = tab[nt - 1]!;
  else c = tab[i]! + (tab[i + 1]! - tab[i]!) * (xi - i);
  if (!(c > 0)) return extra;
  const tau = c * w.load * w.rollRadius;
  return extra + (om > 0 ? tau : -tau);
}
