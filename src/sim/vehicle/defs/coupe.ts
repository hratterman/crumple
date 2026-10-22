/**
 * COUPE — "Vortex RS": 2-door front-mid-engine RWD sports coupe (4.0 L
 * twin-turbo V8, 7-speed, LSD, TC).
 *
 * PURE DATA MODULE (docs/CONTRACTS.md P2 boundary amendment): main-thread
 * code may import it. The VehicleDef is GENERATED once at module load by a
 * deterministic procedure (no RNG, fixed iteration order). The generator is
 * an adapted copy of the sedan's (docs/CONTRACTS.md P6 "No shared fleet
 * generator"); the WHY notes on shared mechanisms (crash sections, rigid
 * subframe, rear link factor, damping budget, ...) live in defs/sedan.ts and
 * are only summarized here.
 *
 * Vehicle frame: up +Y, forward −Z, right +X. Ground at y = 0 with the tyres
 * just touching in the rest pose (wheel centres at y = WHEEL_RADIUS).
 *
 * Targets (CONTRACTS "Fleet targets", coupe): 1300 kg incl. wheels,
 * wheelbase 2.55 m, wide track 1.64 m, low CG (0.45 m rest), static axle split
 * 46/54 (engine behind the front axle, rear-biased for traction),
 * stiffer springs (1.75 / 1.95 Hz), wider 0.33 m tyres with a stickier
 * compound, 300 kW / 520 N·m, 7-speed auto, LSD.
 *
 * BODY LATTICE: 13 stations from the front bumper (z −2.16) to the rear
 * bumper (z +2.15): short overhangs, a long nose (firewall 0.73 m behind the
 * front axle), a short cabin (one long door per side, s5 → s7) closed by a
 * rear-seat bulkhead (s8) under the fastback. Same zone scheme as the sedan:
 * bumper < crash cans / tail < engine bay < safety cell, so the ends fold
 * first; brittle glass beams in the window strips; a physical hood sub-rig.
 */
import { addClosureNodes, buildClosureSet, dormantClosureShells, planClosures, stationDoorSpec, type ClosureSpec } from '../closures';
import { SHELL_GROUPS, SHELL_RELEASE_CELL, shellLayout } from '../shellDefs';
import type { RigBeamDef, RigNodeDef } from '../../rig/types';
import type { CrashProbes } from '../crash';
import { wheelNodeId, type DrivetrainDef, type VehicleDef, type WheelDef } from '../types';
import { capRoofYield } from '../roof';

// R-CRASH roof strength (see defs/sedan.ts "roof strength", roof.ts)
/** Roof-ring members' yield force cap, N. Measured (roofStrength.ts platen): SWR 3.1 (39 kN at 127 mm; FMVSS 216a ≥ 3), ≈ 50 % kept as set. */
const ROOF_YIELD = 2e4;
const ROOF_RING = ['s5_cw*', 's6_rf*', 's7_rf*', 's8_rf*', 's9_dk*'];

// ====================================================================== targets
const DT = 1 / 2000;
const G = 9.81;
export const COUPE_TARGETS = {
  totalMass: 1300,
  wheelbase: 2.55,
  track: 1.64,
  frontAxleShare: 0.46,
  /** CG height in the REST pose; the car settles ~3 cm lower. */
  cgHeight: 0.45,
  rideHzFront: 1.75,
  rideHzRear: 1.95,
  dampingRatio: 0.32,
  /**
   * Suspension travel (at the wheel) under static load, m; the rest is
   * preload (see the sedan). NEGATIVE: the preload exceeds the static load
   * by this much spring travel, so the corners settle 1 cm extended and
   * the body's static sag (≈ 4.5 cm of soft-body tyre squish) stays in the
   * 2–5 cm band at the stiffer coupe springs.
   */
  staticSuspensionSag: -0.01,
  maxWheelAngleRad: 0.52,
  /**
   * Acceptance (docs/CONTRACTS.md P6 "Fleet targets", coupe column; the
   * sedan's harness thresholds elsewhere), asserted by coupe.test.ts.
   */
  acceptance: {
    beamBudget: 3000,
    staticSag: [0.02, 0.05],
    zeroTo100S: [3.9, 4.6],
    launchDriftDeg: 3,
    // R-CRASH 34 → 34.5: the hinged doors + lid moved the stop 33.8 → 34.1 m (mass, CG and axle split unchanged);
    // a 300 kW / 1300 kg coupe on sticky tyres stops from 100 km/h in 33–35 m
    brake100M: 34.5,
    circleR40G: 1.05,
    stepSteerOvershoot: 1.35,
    topSpeed: { lowKmh: 250, highKmh: 260, straightFromKmh: 245 },
    // rebound m/s: R-CRASH 5–15 % of the 13.9 m/s impact (real cars; the old [1, 4] was 7–29 %)
    frontal50: { crush: [0.35, 0.6], crushMax: 0.7, intrusion: 0.08, springback: 0.25, rebound: [0.69, 2.08] },
    frontal30: { crush: [0.15, 0.3], intrusion: 0.03, springback: 0.25 },
    frontal10: { crush: 0.03, plastic: 0.05 },
    pole30: { door: [0.2, 0.4] },
    offset64: { intrusion: 0.15 },
  },
} as const;

/**
 * Performance tyre (275/35R19-class): the sedan's 205/55R16 tuning
 * (wheelrig.ts WHEEL_TUNING_205_55R16; same node masses and spring rates,
 * so the same per-node ω·dt) on a bigger 0.33 m radius / 19" rim (shorter
 * sidewall), wider (0.19 m between the ring planes: one rendered wheel variant, U6 draws), a
 * stickier compound (μ 1.35) and a stiffer lateral brush (cornering stiffness).
 */
export const COUPE_TYRE = {
  radius: 0.33,
  rimRadius: 0.24,
  width: 0.19,
  rays: 12,
  tireNodeRadius: 0.045,
  tireContactSpring: 8e4,
  // R-PHYS: 8.5e4 → 1.9e5: a 255/35R19-class performance tyre, C_α/Fz ≈ 18–22/rad, peak ≈ 5–7°
  treadBrushStiffness: 1.9e5,
  treadBrushDamping: 30,
  rimHoopTension: 1,
  treadHoopTension: 0.5,
  rollingResistance: 0.008,
  tireRingSpring: 2.65e4,
  tireRingDamp: 4,
  rimSpring: 5.4e4,
  rimDamp: 6,
  sidewallSpring: 5.3e4,
  sidewallDamp: 6,
  hubMass: 10,
  rimMass: 24,
  tireMass: 9.4,
  // R-PHYS: 1.35 → 1.6 μ_x with μ_y = 0.81 μ_x (a 255/35R19 max-performance tyre): ABS stops ≈ 1.15–1.2 g
  // (100–0 ≈ 34 m), skidpad ≈ 1.03 g
  friction: 1.6,
  tyreLateralMu: 0.81,
  // R-PHYS tyre model (tyre.ts)
  tyreLoadSensitivity: 0.06,
  // max-performance tyres keep ≈ 0.85 of their peak sliding
  tyreSlideRatio: 0.85,
  tyrePeakSlip: 0.06,
  tyreSlideSlip: 0.45,
} as const satisfies Partial<WheelDef>;
/**
 * Rear lateral brush stiffness, N/m per tread node (front: COUPE_TYRE's).
 * The wider rear tyre's higher cornering stiffness is also what keeps the
 * car straight at v_max: with equal front/rear brushes a ~1.6 s yaw weave
 * grew from 260 km/h (±0.09 rad/s at 278 km/h); at 1.15e5 the 10 s
 * full-throttle run from 245 km/h holds |r| < 0.01 rad/s.
 */
const REAR_BRUSH = 2.3e5; // R-PHYS: 1.15e5 × 2 with the front's realism scaling

const Z_F = -COUPE_TARGETS.wheelbase / 2; // front axle
const Z_R = COUPE_TARGETS.wheelbase / 2; // rear axle
const HALF_TRACK = COUPE_TARGETS.track / 2;
const WHEEL_RADIUS = COUPE_TYRE.radius; // 0.33 m
const Y_W = WHEEL_RADIUS; // wheel centre height at rest (tyres touch y = 0)

/** ω·dt the auto-stiffness allocation solves for (structure limit 0.35, margin). */
const OMEGA_DT_TARGET = 0.33;
const BUDGET_PER_KG = (OMEGA_DT_TARGET / DT) ** 2; // Σk/m allowed, (N/m)/kg
/** ω·dt target of the body SHELL nodes (crash stiffness; see the sedan's SHELL_OMEGA_DT_TARGET). */
const SHELL_OMEGA_DT_TARGET = 0.485;
const SHELL_BUDGET_PER_KG = (SHELL_OMEGA_DT_TARGET / DT) ** 2;

// ====================================================================== beam classes
/**
 * Structural classes (see the sedan for the full rationale): `w` = stiffness
 * share, `zeta` = damping ratio; yield deform = max(yieldStrain·k·L,
 * minDeform), breakF = breakRatio·deform. Floors above the hard-driving body
 * loads; the cage far above the crumple zones.
 * COUPE CRASH TUNING (crash.ts harness; the sedan's classes gave 10 km/h
 * 3.5 cm permanent crush, 30 km/h 32 cm): the lighter 46 %-front car has
 * less stiffness budget up front, and its short nose reaches the
 * wheel/engine stack sooner — once that stack takes the load (~45 cm in a
 * 50 km/h hit) the rest of the travel is elastic and springs back (30 %).
 * What fixed all three speeds together:
 *   - heavier crash-can / radiator-support rails (station base masses), so
 *     the front zone is stiffer and soaks low-speed hits elastically;
 *   - `can` (station 1 → 2): yields on STRAIN (2.5 %) with a low force
 *     floor: the stiff rails hold at 10–30 km/h, the light diagonals fold;
 *   - `crash` / `bay` (radiator support → firewall) at 6 kN floors and ζ
 *     0.55: they absorb the 50 km/h energy plastically BEFORE the stack
 *     engages (peak 66 cm, 19 % spring-back, rebound 3.6 m/s).
 * The 50 km/h fold mode is sensitive (bistable between "cans fold through
 * the radiator support" and "bumper slides past the cans"); coupe.test.ts
 * pins the numbers.
 */
const REAR_BAY_FACTOR = 10;
const CLASSES = {
  bumper: { w: 1.0, zeta: 0.4, yieldStrain: 0.04, minDeform: 1.5e3, breakRatio: 5 },
  /** Crash cans (station 1 and its links to the radiator support): strain-yield, see COUPE CRASH TUNING. */
  can: { w: 1.0, zeta: 0.55, yieldStrain: 0.04, minDeform: 3e3, breakRatio: 6 },
  crash: { w: 1.0, zeta: 0.55, yieldStrain: 0.0234, minDeform: 6e3, breakRatio: 6 },
  bay: { w: 1.0, zeta: 0.55, yieldStrain: 0.015, minDeform: 6e3, breakRatio: 6 },
  cage: { w: 1.3, zeta: 0.3, yieldStrain: 0.1, minDeform: 1.6e4, breakRatio: 5 },
  /** Brittle: elastic, shatters at GLASS_BREAK_STRAIN. */
  glass: { w: 0.4, zeta: 0.25, yieldStrain: 0.06, minDeform: 0, breakRatio: 1.7 },
  subframe: { w: 3, zeta: 0.25, yieldStrain: 0.04, minDeform: 2e4, breakRatio: 5 },
  mount: { w: 1.0, zeta: 0.3, yieldStrain: 0.04, minDeform: 6e3, breakRatio: 5 },
  /** Engine block: never yields or breaks. */
  engine: { w: 2.0, zeta: 0.2, yieldStrain: 0, minDeform: 0, breakRatio: 0 },
} as const;
type BeamClass = keyof typeof CLASSES;

// ====================================================================== stations
type Pt = readonly [tag: string, x: number, y: number];
interface Station {
  z: number;
  /** Right half of the section ring, bottom-centre → top-centre; x = 0 entries are centre nodes. */
  ring: readonly Pt[];
  /** Ring closes through the centre nodes (else: open U, sides only). */
  closed: boolean;
  /** Triangulate in-plane (every pair within BULKHEAD_REACH). */
  bulkhead: boolean;
  /** Extra in-section nodes (right half, mirrored) not on the ring. */
  extra?: readonly Pt[];
  /** Class of ring/in-plane beams and of the links to the NEXT station. */
  cls: BeamClass;
  /** Base node mass per tag, kg (before the mass-distribution solve). */
  mass: Readonly<Record<string, number>>;
}

const BULKHEAD_REACH = 1.0;
/** Per-node (Σd/m)·dt target of the generator (validator limit 1). */
const DAMP_BUDGET = 0.95;
/** Open (bay) sections: cross-car braces between the two sides up to this length, m. */
const BAY_CROSS_REACH = 1.2;
/** Longitudinal members take this many times a diagonal's share of each node's budget. */
const LONGITUDINAL_W = 4;
const LINKS_PER_NODE = 3;

/*
 * Tags (as the sedan): bl/bo/bu bumper lower/outer/upper · rl/rh crash rail
 * low/high · fd fender top · rs/rt radiator support bottom/top · tw shock
 * tower · tn tunnel · fl floor · sl sill · hp hinge pillar · cw cowl ·
 * fw firewall · dm door mid · bt belt line · rf roof (rail / centre) ·
 * qm quarter mid · dk rear deck (fastback base) · tf trunk floor ·
 * qt quarter top (rear haunch) · ld trunk lid.
 */
/** Base mass of the bay rail nodes (s3, s4 rl/rh), kg: the V8 sits between them, behind the front axle. */
const RAIL_BASE = 46;
const STATIONS: readonly Station[] = [
  // 0 front bumper face (low nose)
  { z: -2.16, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 9, bo: 6, bu: 9 },
    ring: [['bl', 0, 0.27], ['bl', 0.42, 0.27], ['bo', 0.78, 0.38], ['bu', 0.42, 0.46], ['bu', 0, 0.46]] },
  // 1 crash-can tips
  { z: -1.92, closed: false, bulkhead: false, cls: 'can', mass: { rl: 30, rh: 30, fd: 6 },
    ring: [['rl', 0.42, 0.25], ['rh', 0.42, 0.46], ['fd', 0.78, 0.58]] },
  // 2 radiator support (bulkhead)
  { z: -1.64, closed: true, bulkhead: true, cls: 'crash', mass: { rs: 8, rl: 36, rh: 36, fd: 6, rt: 8 },
    ring: [['rs', 0, 0.22], ['rl', 0.42, 0.24], ['rh', 0.42, 0.47], ['fd', 0.83, 0.66], ['rt', 0, 0.66]] },
  // 3 front axle: shock towers (kept low under the long, low hood)
  { z: Z_F, closed: false, bulkhead: false, cls: 'bay', mass: { rl: RAIL_BASE, rh: RAIL_BASE, tw: 16, fd: 5 },
    ring: [['rl', 0.42, 0.24], ['rh', 0.42, 0.5], ['tw', 0.58, 0.74], ['fd', 0.87, 0.74]] },
  // 4 engine bay rear (V8 block)
  { z: -0.9, closed: false, bulkhead: false, cls: 'bay', mass: { rl: RAIL_BASE, rh: RAIL_BASE, fd: 5 },
    ring: [['rl', 0.43, 0.22], ['rh', 0.44, 0.5], ['fd', 0.88, 0.8]] },
  // 5 firewall / cowl / A-pillar base (bulkhead)
  { z: -0.55, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 8, fl: 9, sl: 9, hp: 7, cw: 7, fw: 6 },
    ring: [['tn', 0, 0.33], ['fl', 0.42, 0.19], ['sl', 0.9, 0.21], ['hp', 0.91, 0.55], ['cw', 0.76, 0.87], ['cw', 0, 0.89]],
    extra: [['fw', 0.4, 0.6]] },
  // Floor / sill heights: ≈ 9 cm of clearance under the 5 cm contact radius after the static sag.
  // 6 door mid / windscreen header
  { z: -0.06, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 8, fl: 13, sl: 9, dm: 6, bt: 6, rf: 4 },
    ring: [['tn', 0, 0.33], ['fl', 0.42, 0.18], ['sl', 0.9, 0.2], ['dm', 0.93, 0.52], ['bt', 0.9, 0.87], ['rf', 0.62, 1.23], ['rf', 0, 1.26]] },
  // 7 B-pillar hoop (bulkhead + cross-cabin cage diagonals)
  { z: 0.46, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 8, fl: 13, sl: 9, dm: 6, bt: 6, rf: 4 },
    ring: [['tn', 0, 0.33], ['fl', 0.42, 0.18], ['sl', 0.9, 0.2], ['dm', 0.93, 0.52], ['bt', 0.9, 0.87], ['rf', 0.6, 1.2], ['rf', 0, 1.23]] },
  // 8 rear-seat bulkhead under the fastback (cell's rear end)
  { z: 0.96, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 12, fl: 12, sl: 8, qm: 6, bt: 5, rf: 4 },
    ring: [['tn', 0, 0.3], ['fl', 0.46, 0.24], ['sl', 0.88, 0.24], ['qm', 0.93, 0.56], ['bt', 0.9, 0.87], ['rf', 0.56, 1.1], ['rf', 0, 1.13]] },
  // 9 rear axle: rear shock towers, wide haunches, fastback base (top braced, see TOP_BRACES)
  { z: Z_R, closed: true, bulkhead: false, cls: 'bay', mass: { tf: 7, rl: 7, rh: 7, tw: 12, qt: 5, dk: 3 },
    ring: [['tf', 0, 0.32], ['rl', 0.48, 0.3], ['rh', 0.48, 0.52], ['tw', 0.62, 0.76], ['qt', 0.93, 0.85], ['dk', 0.58, 0.97], ['dk', 0, 1.0]] },
  // 10 deck / trunk
  { z: 1.7, closed: true, bulkhead: false, cls: 'crash', mass: { tf: 7, rl: 5, rh: 5, qt: 4, ld: 3 },
    ring: [['tf', 0, 0.34], ['rl', 0.48, 0.32], ['rh', 0.48, 0.52], ['qt', 0.88, 0.86], ['ld', 0.58, 0.93], ['ld', 0, 0.94]] },
  // 11 rear panel / crash cans (bulkhead), ducktail lip
  { z: 1.95, closed: true, bulkhead: true, cls: 'crash', mass: { tf: 10, rl: 12, rh: 12, qt: 5, ld: 4 },
    ring: [['tf', 0, 0.36], ['rl', 0.48, 0.34], ['rh', 0.48, 0.54], ['qt', 0.82, 0.82], ['ld', 0.56, 0.93], ['ld', 0, 0.94]] },
  // 12 rear bumper face
  { z: 2.15, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 9, bo: 6, bu: 9 },
    ring: [['bl', 0, 0.3], ['bl', 0.44, 0.3], ['bo', 0.8, 0.42], ['bu', 0.44, 0.52], ['bu', 0, 0.52]] },
];
/** Last (rear) bumper station index. */
const REAR_BUMPER = STATIONS.length - 1;
/**
 * Axial yield force of each SAFETY-CELL station gap g (g → g+1, cage-class
 * links), N: far above any frontal's section force, so the cell stays
 * elastic while the crumple zones (strain-yield classes, 0 here) fold.
 */
const GAP_YIELD: readonly number[] = [0, 0, 0, 0, 0, 1.2e6, 1.2e6, 1.2e6, 400e3, 0, 0, 0];
/** Shear diagonals of a gap yield at ≥ this fraction of the axial members' yield travel… */
const SHEAR_YIELD_FLOOR = 0.8;
/** …and at ≥ this fraction of a longitudinal member's yield force. */
const SHEAR_FORCE_SHARE = 0.6;
/** In-station members yield at this multiple of the adjacent gaps' yield travel. */
const IN_STATION_YIELD_FACTOR = 3;
/** Window glass breaks (shatters) at this strain; elastic below. */
const GLASS_BREAK_STRAIN = 0.03;
/** Door skin/frame nodes (s6 dm, bt, sl, fl: the one long door): yield strain, so a side impact dents them plastically. */
const DOOR_YIELD_STRAIN = 0.05;
const DOOR_MIN_DEFORM = 4e3;
/** Firewall panel node (s5_fw_*): its links yield like the bay (no trampoline springback). */
const FIREWALL_PANEL = /^s5_fw_/;
const DOOR_NODES = /^s6_(dm|bt|sl|fl)_/;
const isDoor = (a: string, b: string): boolean => DOOR_NODES.test(a) || DOOR_NODES.test(b);
/** Bumper beam ↔ crash-can links: brittle relative to their yield, so a hard hit tears the bumper off. */
// R-CRASH 3 → 1.9: the bumper yield strain went 0.025 → 0.04 (30 km/h crush at the 8 MN/m wall); the mounts keep their break FORCE.
const BUMPER_MOUNT_BREAK_RATIO = 1.9;
const BUMPER_STATION = new RegExp(`^s(0|${REAR_BUMPER})_`);
const isBumperMount = (a: string, b: string): boolean => BUMPER_STATION.test(a) !== BUMPER_STATION.test(b);
/** Load-path members that change tag across a gap ([gap, front tag, rear tag]): longitudinal share. */
const LOAD_PATH_CONTINUATIONS: readonly (readonly [number, string, string])[] = [
  [0, 'bl', 'rl'],
  [0, 'bu', 'rh'],
  [4, 'rl', 'fl'],
  [4, 'rh', 'fw'],
  [4, 'fd', 'hp'],
  [4, 'fd', 'cw'],
  [8, 'fl', 'rl'],
];
/** Stations whose links to the next station are window glass between these tags. */
const GLASS_TAGS: readonly (readonly [string, string])[] = [
  ['bt', 'rf'],
  ['cw', 'rf'],
  ['rf', 'dk'],
];
/**
 * Safety-cell members spanning two stations ([station, tag, station, tag],
 * both sides; centre nodes once): sills, floor rails, tunnel and roof rails
 * across the long door opening and over the rear seats, plus diagonals
 * across the door frame (the sedan's CABIN_SPANS rationale: a member
 * spanning the opening keeps the cell's length while the ends crush).
 */
const CABIN_SPANS: readonly (readonly [number, string, number, string])[] = [
  [5, 'sl', 7, 'sl'],
  [6, 'sl', 8, 'sl'],
  [5, 'fl', 7, 'fl'],
  [6, 'fl', 8, 'fl'],
  [5, 'tn', 7, 'tn'],
  [6, 'tn', 8, 'tn'],
  [6, 'rf', 8, 'rf'],
  [5, 'cw', 7, 'rf'],
  [5, 'sl', 7, 'bt'],
  [5, 'hp', 7, 'sl'],
  [6, 'bt', 8, 'sl'],
];
/** Cabin spans yield only at this strain. */
const CABIN_SPAN_YIELD_STRAIN = 0.25;
const SPAN_KEYS = new Set(
  CABIN_SPANS.flatMap(([i, ta, j, tb]) => [`s${i}_${ta}|s${j}_${tb}`]),
);
/** Both endpoints match a CABIN_SPANS entry (side suffix ignored). */
const isCabinSpan = (a: string, b: string): boolean => {
  const base = (id: string): string => id.replace(/_[LR]$/, '');
  return SPAN_KEYS.has(`${base(a)}|${base(b)}`) || SPAN_KEYS.has(`${base(b)}|${base(a)}`);
};
/**
 * In-plane braces of an open ring ([station, centre tag, side tag], both
 * sides): the fastback base's centre node (s9_dk) hung on its ring
 * neighbours only, flapped in a 10 km/h frontal and strained the rear-glass
 * beams past their break strain. (Making s9 a full bulkhead instead
 * stiffened the tail so much that the 50 km/h frontal sprang back 30 %.)
 */
const TOP_BRACES: readonly (readonly [number, string, string])[] = [
  [9, 'dk', 'tw'],
  [9, 'dk', 'qt'],
];
/** Cross-cabin cage diagonals (tag a on one side → tag b on the other). */
const CROSS_CABIN: readonly (readonly [number, string, string])[] = [
  [5, 'cw', 'sl'],
  [7, 'rf', 'sl'],
  [7, 'bt', 'fl'],
  [8, 'rf', 'fl'],
];

// ====================================================================== suspension geometry
/**
 * Per corner as the sedan (RoR-style upright = hubI, hubO + one body node
 * kU; lower A-arm to hubI, upper A-arm to kU, toe link / tie-rod hydro to
 * hubO; 1 DOF left: wheel travel; shock hubI → tower; crossed anti-roll
 * beams). Wider track: the upright sits at x = HALF_TRACK − HUB_SPACING/2.
 */
const HUB_SPACING = 0.24;
/** Engine block / gearbox node mass, kg (light block; the V8's mass sits in the bay rails, see the sedan). */
const ENGINE_NODE_MASS = 5;
/** V8 block corners: z front / rear (behind the front axle), y low / high (cam covers), half width (vee). */
const ENGINE_Z = [-1.42, -0.84] as const;
const ENGINE_Y = [0.3, 0.64] as const;
const ENGINE_HALF_X = 0.24;
/** Fore-aft reach of the tie rod (front, pivot behind the wheel) and toe link (rear, pivot ahead), m. */
const LINK_REACH = 0.35;
interface CornerGeom {
  z: number;
  kU: [number, number, number];
  lowerPivots: [[number, number, number], [number, number, number]];
  upperPivots: [[number, number, number], [number, number, number]];
  linkPivot: [number, number, number];
  /** Station index of this axle's shock tower node (tag 'tw'). */
  towerStation: number;
}
const X_U = HALF_TRACK - HUB_SPACING / 2; // upright x (= hubI x)
const FRONT: CornerGeom = {
  z: Z_F,
  kU: [X_U, 0.6, Z_F + 0.03],
  lowerPivots: [[X_U - 0.32, Y_W, Z_F - 0.3], [X_U - 0.32, Y_W, Z_F + 0.28]],
  upperPivots: [[X_U - 0.29, 0.6, Z_F - 0.28], [X_U - 0.29, 0.6, Z_F + 0.28]],
  linkPivot: [HALF_TRACK + HUB_SPACING / 2, Y_W, Z_F + LINK_REACH],
  towerStation: 3,
};
const REAR: CornerGeom = {
  z: Z_R,
  kU: [X_U, 0.6, Z_R],
  lowerPivots: [[X_U - 0.32, Y_W, Z_R - 0.3], [X_U - 0.32, Y_W, Z_R + 0.3]],
  upperPivots: [[X_U - 0.29, 0.6, Z_R - 0.28], [X_U - 0.29, 0.6, Z_R + 0.28]],
  linkPivot: [HALF_TRACK + HUB_SPACING / 2, Y_W, Z_R - LINK_REACH],
  towerStation: 9,
};

/** Upright-top node mass, kg (unsprung). */
const KNUCKLE_NODE_MASS = 7.5;
/** Rigid subframe (see the sedan's SUBFRAME note). */
const K_SUBFRAME = 1e6;
const SUBFRAME_BUDGET_SHARE = 0.7;
const SUBFRAME_DEFORM = 9e4;
const SUBFRAME_BREAK = 1.8e5;
const subframePivotMass = (fixedK: number): number => round(fixedK / (BUDGET_PER_KG * SUBFRAME_BUDGET_SHARE), 2);
/** Base mass of the upper-arm pivot nodes, kg (before the mass solve). */
const PIVOT_NODE_MASS = 7;
/** Fixed suspension stiffnesses, N/m (budgets as the sedan's). */
const K_LOWER_ARM = 1.2e6;
const K_UPPER_ARM = 8e5;
const K_TOE_LINK = 1.5e6;
const K_AXLE_STUB = 1.2e6;
const ATTACH_SPRING = 9e5;
/** Rear hub-link stiffness factor (the sedan's REAR_LINK_FACTOR: no power-on yaw weave). */
const REAR_LINK_FACTOR = 2;
const linkFactor = (front: boolean): number => (front ? 1 : REAR_LINK_FACTOR);
const hubMass = (front: boolean): number => WHEEL_HUB_MASS * (front ? 1 : REAR_LINK_FACTOR * 0.81);
const knuckleMass = (front: boolean): number => KNUCKLE_NODE_MASS * linkFactor(front);
const ATTACH_DAMP = 300;
const D_ARM = 400;
/** Anti-roll: ARB roll rate at the wheel as a fraction of the axle's spring wheel rate. */
const ARB_FRACTION_FRONT = 0.6;
const ARB_FRACTION_REAR = 0.3;
/** Damper calibration of the soft-body quarter car (see the sedan). */
const DAMPER_CALIBRATION = 1.6;

/** Heavy hub carrier (upright + big brakes): 15 kg per hub node. */
const WHEEL_HUB_MASS = 30;

// ====================================================================== hood
/**
 * HOOD sub-rig (the sedan's P4 scheme on the coupe's long, low hood): 12
 * nodes hood_{r}{s}, r = 0..3 front → rear, s ∈ {L, C, R}, X-braced grid;
 * creases (bumper-class yield), latch pops in a hard frontal, hinges hold.
 *   hinges  hood_3L–s5_cw_L, hood_3L–s4_fd_L (mirror R): high break.
 *   latch   hood_0C–s2_rt, hood_0L/R–s2_fd_L/R: elastic, snaps at latchBreak.
 *   rests   support beams rows 1–2 L/R onto the s2..s4 fender tops and
 *           rows 1–3 L/R onto the upper bay rails (s2..s4 rh),
 *           hood_1C onto s2_rt, hood_0* onto the crash cans / bumper,
 *           hood_3C onto the firewall panel, hood_2C onto the V8's cam covers.
 * The rows clear the shock towers by ≥ 5 cm.
 */
const HOOD_Z = [-1.94, -1.5, -1.07, -0.66] as const;
const HOOD_Y = [0.66, 0.765, 0.835, 0.87] as const;
const HOOD_HALF_X = 0.62;
/** Centre-line crown, m. */
const HOOD_CROWN = 0.025;
const HOOD_NODE_MASS = 1;

/*
 * R-CRASH hinged closures (closures.ts; the sedan's rules, see defs/sedan.ts): one long door per side
 * (hinge axis s5_sl → s5_hp on the A-pillar, latch on the B-pillar s7_dm + s7_fl) and the short ducktail
 * trunk lid (hinge s9_dk_L → s9_dk_R at the fastback base, latch s11_tf + s11_ld, gas struts). Skin nodes
 * are fixed masses in the structure solve (0.5 kg door / 0.7 kg lid nodes, the cage keeps the rest: see the
 * sedan for why light).
 */
const DOOR_NODE_MASS = 0.5;
const TRUNK_NODE_MASS = 0.7;
/** Door-aperture racking sensors break at this strain (the latch pops when its opening distorts). */
const DOOR_RACK_STRAIN = 0.05;
const CLOSURE = {
  skin: { zeta: 0.5, yieldStrain: 0.03, minDeform: 2.5e3, breakRatio: 8 },
  /** Hinges bend from 12 kN and tear off at 30 kN; each latch beam pops at 11 kN (FMVSS 206 primary latch). */
  hingeDeform: 1.2e4,
  hingeBreak: 3e4,
  latchBreak: 1.1e4,
  stopBreak: 1.5e4,
};
const HOOD = {
  zeta: 0.5,
  yieldStrain: 0.03,
  minDeform: 1.5e3,
  breakRatio: 8,
  hingeDeform: 1.2e4,
  hingeBreak: 3e4,
  latchBreak: 4e3,
  restBreak: 1.5e4,
} as const;

/** Trunk-lid centre rest stiffness per rest, N/m. */
const TRUNK_REST_K = 1e5;

// ====================================================================== drivetrain
/**
 * 4.0 L twin-turbo V8: 520 N·m from 2250 to 5500 rpm (boost plateau), then
 * ≈ constant 300 kW to 7000 rpm (limiter 7300). 7-speed auto with quick
 * shifts, LSD, TC. Gearing: 1st to ≈ 70 km/h (one shift before 100 km/h),
 * 6th tops out near 290 km/h, 7th is a cruise overdrive.
 */
const DRIVETRAIN: DrivetrainDef = {
  // R-PHYS: halfshaft / CV strength ≈ 2.2 × the peak 1st-gear wheel torque per side (520 × 2.75 × 3.45 / 2 = 2470)
  halfshaftBreakTorque: 5400,
  // R-PHYS engine systems (engineSystems.ts): fuel, cooling, oil, stall / starter
  engine: { displacementL: 4.0, fuel: 'petrol', tankL: 70 },
  torqueCurve: [
    [0, 230],
    [750, 280],
    [1500, 380],
    [2000, 480],
    [2250, 520],
    [5500, 520],
    [6000, 477],
    [6500, 440],
    [7000, 405],
    [7300, 330],
  ],
  idleRpm: 750,
  redlineRpm: 7000,
  revLimitRpm: 7300,
  engineInertia: 0.16,
  engineBrakeTorque: 70,
  gearRatios: [2.75, 1.9, 1.48, 1.2, 1.0, 0.86, 0.72],
  reverseRatio: 3.0,
  finalDrive: 3.45,
  shiftTimeS: 0.1,
  autoShiftUpRpm: 7000,
  autoShiftDownRpm: 2800,
  diff: 'limited',
  diffLockTorque: 600,
  // R-PHYS: clutch-pack LSD: 150 N·m preload, 50 % power / 30 % coast locking (TBR 3.0 / 1.9)
  lsd: { preload: 150, powerRamp: 0.5, coastRamp: 0.3 },
  clutchMaxTorque: 800,
  transmission: 'auto',
  // The soft tyre needs ~20 % slip for 0.65 g of drive (TC off: ~0.7 g with the rears spinning).
  tractionControl: 0.1,
};

// ====================================================================== generator
type V3 = [number, number, number];
type Side = 'L' | 'R';
const sideSign = (s: Side): number => (s === 'R' ? 1 : -1);
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]): number => Math.sqrt(dot(a, a));
const unit = (a: readonly number[]): V3 => {
  const l = len(a);
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};
const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const mirror = (p: readonly number[], s: Side): V3 => [p[0]! * sideSign(s), p[1]!, p[2]!];
const round = (v: number, digits = 4): number => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};
/** 3 significant digits (stiffness / damping / forces). */
const sig3 = (v: number): number => {
  if (v === 0) return 0;
  const p = 10 ** (2 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
};

/** Rodrigues rotation of p about the axis through o with unit direction u by angle a. */
function rotateAbout(p: readonly number[], o: readonly number[], u: readonly number[], a: number): V3 {
  const v = sub(p, o);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const uxv = cross(u, v);
  const uv = dot(u, v);
  return [
    o[0]! + v[0]! * c + uxv[0]! * s + u[0]! * uv * (1 - c),
    o[1]! + v[1]! * c + uxv[1]! * s + u[1]! * uv * (1 - c),
    o[2]! + v[2]! * c + uxv[2]! * s + u[2]! * uv * (1 - c),
  ];
}

interface AutoBeam {
  a: string;
  b: string;
  cls: BeamClass;
  /** Stiffness share weight (class w × member factor). */
  w: number;
}

/** Design numbers derived while generating (documented, asserted by coupe.test.ts). */
export interface CoupeDesign {
  totalMass: number;
  cg: V3;
  frontAxleShare: number;
  unsprungCorner: { front: number; rear: number };
  sprungCornerMass: { front: number; rear: number };
  tireRate: number;
  wheelRate: { front: number; rear: number };
  motionRatio: { front: number; rear: number };
  shockK: { front: number; rear: number };
  shockD: { front: number; rear: number };
  preload: { front: number; rear: number };
  arbK: { front: number; rear: number };
  tieRodLength: number;
  hydroTravel: { L: number; R: number };
  bodyNodeCount: number;
  bodyBeamCount: number;
  /** Per station gap: axial stiffness K_g (N/m) and the gap closure at section yield δ_g = F_g/K_g (m). */
  gapAxialK: number[];
  gapYieldTravel: number[];
}

/**
 * R-PHYS rolling-loss correction (tyre.ts): the 12/10-ray tread polygon's excess loss over a real tyre's
 * f_r = 0.011·(1 + V/160 km/h) (Wong, "Theory of Ground Vehicles" eq. 1.12), per unit load, every 10 km/h
 * of tread speed from 0 — measured by coasting this car in neutral (realism/coastdown calibration), kept
 * conservative (0.85 × the lower of the bin and its neighbours' mean) so it never propels a coasting car.
 */
export const COUPE_ROLLING_LOSS: readonly number[] = [0, 0.0012, 0.0024, 0.0026, 0.0038, 0.0082, 0.0126, 0.0206, 0.0229, 0.0245, 0.0417, 0.0711, 0.0861, 0.0957, 0.1037, 0.1342, 0.1599, 0.1644, 0.118, 0.11, 0.0891, 0.0561, 0.0384, 0.0626, 0.0619, 0.0658, 0.0838, 0.0977, 0.1054, 0.1077, 0.11];

function buildCoupe(): { def: VehicleDef; design: CoupeDesign } {
  const nodes: RigNodeDef[] = [];
  const pos = new Map<string, V3>();
  const massOf = new Map<string, number>();
  /** Nodes whose masses are solved for the axle split / CG (structure). */
  const structure: string[] = [];
  const addNode = (id: string, p: readonly number[], mass: number, group: string, collidable = true, isStructure = true): string => {
    const q: V3 = [round(p[0]!), round(p[1]!), round(p[2]!)];
    nodes.push({ id, pos: q, mass, group, ...(collidable ? {} : { collidable: false }) });
    pos.set(id, q);
    massOf.set(id, mass);
    if (isStructure) structure.push(id);
    return id;
  };

  // ---- body stations
  const stationIds: string[][] = [];
  const stationRing: string[][][] = [];
  const tagOf = new Map<string, string>();
  const stationOf = new Map<string, number>();
  const sid = (i: number, tag: string, side?: Side): string => (side ? `s${i}_${tag}_${side}` : `s${i}_${tag}`);
  STATIONS.forEach((st, i) => {
    const ids: string[] = [];
    const right: string[] = [];
    const left: string[] = [];
    const centres: string[] = [];
    const add = (pt: Pt, onRing: boolean): void => {
      const [tag, x, y] = pt;
      const m = st.mass[tag];
      if (m === undefined) throw new Error(`coupe: station ${i} has no mass for tag ${tag}`);
      const sides: (Side | undefined)[] = x === 0 ? [undefined] : ['R', 'L'];
      for (const s of sides) {
        const id = addNode(sid(i, tag, s), [s ? x * sideSign(s) : 0, y, st.z], m, 'body');
        ids.push(id);
        tagOf.set(id, tag);
        stationOf.set(id, i);
        if (!onRing) continue;
        if (s === undefined) centres.push(id);
        else (s === 'R' ? right : left).push(id);
      }
    };
    for (const pt of st.ring) add(pt, true);
    for (const pt of st.extra ?? []) add(pt, false);
    stationIds.push(ids);
    // Ring order: [bottom centre?] R… [top centre?] …L (reversed), closing back.
    const first = st.ring[0]!;
    const last = st.ring[st.ring.length - 1]!;
    const bottom = first[1] === 0 ? [centres[0]!] : [];
    const top = last[1] === 0 ? [centres[centres.length - 1]!] : [];
    // Open sections (engine bay) keep the two sides as separate paths.
    stationRing.push(st.closed ? [[...bottom, ...right, ...top, ...left.reverse()]] : [right, left]);
  });

  // ---- engine block (V8, longitudinal, front-mid: behind the front axle) + gearbox
  const engine: string[] = [];
  for (const z of ENGINE_Z)
    for (const y of ENGINE_Y)
      for (const s of ['R', 'L'] as const) engine.push(addNode(`eng_${z === ENGINE_Z[0] ? 'f' : 'r'}${y === ENGINE_Y[0] ? 'lo' : 'hi'}_${s}`, [ENGINE_HALF_X * sideSign(s), y, z], ENGINE_NODE_MASS, 'engine', true, false));
  const gearbox = (['R', 'L'] as const).map((s) => addNode(`gbx_${s}`, [0.12 * sideSign(s), 0.36, -0.3], ENGINE_NODE_MASS, 'engine', true, false));

  // ---- suspension body nodes + upright tops (hub nodes come from the wheels)
  type CornerIds = { kU: string; hubI: string; hubO: string; lower: string[]; upper: string[]; link: string; tower: string };
  const corners = new Map<string, CornerIds>();
  const halfS = HUB_SPACING / 2;
  for (const [axle, g] of [['F', FRONT], ['R', REAR]] as const) {
    for (const s of ['L', 'R'] as const) {
      const c = `${axle}${s}`; // == wheel id
      const ids: CornerIds = {
        kU: addNode(`${c}_kU`, mirror(g.kU, s), knuckleMass(axle === 'F'), 'knuckle', false, false),
        hubI: wheelNodeId(c, 'hubI'),
        hubO: wheelNodeId(c, 'hubO'),
        lower: g.lowerPivots.map((p, i) => addNode(`${c}_lp${i}`, mirror(p, s), subframePivotMass(K_LOWER_ARM * linkFactor(axle === 'F') + 4 * K_SUBFRAME), 'subframe', true, false)),
        upper: g.upperPivots.map((p, i) => addNode(`${c}_up${i}`, mirror(p, s), PIVOT_NODE_MASS, 'subframe')),
        link: addNode(`${c}_${axle === 'F' ? 'rack' : 'toe'}`, mirror(g.linkPivot, s), subframePivotMass(K_TOE_LINK * linkFactor(axle === 'F') + 3 * K_SUBFRAME), 'subframe', true, false),
        tower: sid(g.towerStation, 'tw', s),
      };
      // Hub rest positions (generated by buildWheelRig from hubInner/hubOuter below).
      pos.set(ids.hubI, [round((HALF_TRACK - halfS) * sideSign(s)), Y_W, g.z]);
      pos.set(ids.hubO, [round((HALF_TRACK + halfS) * sideSign(s)), Y_W, g.z]);
      corners.set(c, ids);
    }
  }

  // ---- hood sub-rig (P4, docs/CONTRACTS.md "Sedan rig additions"): appended
  // after every structure node so structure indices are unchanged; fixed
  // masses outside the structure solve (the solve keeps the car at 1450 kg).
  const hoodIds: string[][] = [];
  HOOD_Z.forEach((z, r) => {
    const row: string[] = [];
    for (const s of ['L', 'C', 'R'] as const) {
      const x = s === 'C' ? 0 : s === 'R' ? HOOD_HALF_X : -HOOD_HALF_X;
      const y = HOOD_Y[r]! + (s === 'C' ? HOOD_CROWN : 0);
      row.push(addNode(`hood_${r}${s}`, [x, y, z], HOOD_NODE_MASS, 'hood', true, false));
    }
    hoodIds.push(row);
  });

  // ---- hinged closures (R-CRASH): nodes now (fixed masses, outside the structure solve), beams after the solve
  const closureSpecs: { spec: ClosureSpec; openSign: 1 | -1 }[] = [];
  {
    const P = (id: string): V3 => pos.get(id)!;
    const common = { nodeMass: DOOR_NODE_MASS, budgetPerKg: BUDGET_PER_KG, ...CLOSURE, rackStrain: DOOR_RACK_STRAIN, holdOpenDeg: 35, maxOpenDeg: 68, strapForce: 75 };
    for (const side of ['R', 'L'] as const) {
      const spec = stationDoorSpec(
        P,
        { id: `d${side}`, side, hinge: 's5', mid: 's6', latch: 's7', hingeTag: 'hp', latchTag: 'dm', rackTag: 'cw', rails: ['s6', 's7'], top: [false, true, true], strapTo: sid(5, 'fw', side), tunnel: sid(7, 'tn') },
        common,
      );
      closureSpecs.push({ spec, openSign: 1 });
    }
    // trunk lid: rows across the car (L, centre, R), columns hinge (fastback base) → shut edge (ducktail)
    const lidGrid: V3[][] = [-0.55, 0, 0.55].map((x) => [
      [x, x === 0 ? 0.985 : 0.955, 1.33],
      [x, x === 0 ? 0.925 : 0.915, 1.64],
      [x, x === 0 ? 0.925 : 0.915, 1.91],
    ] as V3[]);
    closureSpecs.push({
      spec: {
        id: 'tk',
        group: 'trunk',
        grid: lidGrid,
        nodeMass: TRUNK_NODE_MASS,
        hingeAxis: [sid(9, 'dk', 'L'), sid(9, 'dk', 'R')],
        hinged: [[0, 0], [1, 0], [2, 0]],
        latches: [
          { cell: [1, 2], to: sid(11, 'tf') },
          { cell: [1, 2], to: sid(11, 'ld') },
        ],
        stops: [
          { cell: [0, 2], to: sid(11, 'rh', 'L') },
          { cell: [2, 2], to: sid(11, 'rh', 'R') },
          { cell: [0, 1], to: sid(10, 'rh', 'L') },
          { cell: [2, 1], to: sid(10, 'rh', 'R') },
          { cell: [1, 1], to: sid(10, 'tf') },
        ],
        strap: { cell: [1, 1], to: sid(9, 'tf') },
        // gas struts: an unlatched lid rises to (nearly) fully open
        strapForce: 500,
        stopCandidates: [],
        stopRows: [1],
        inner: [[0, 0.8, 1.62]],
        innerReach: 0.9,
        rack: [
          [sid(9, 'dk', 'L'), sid(11, 'ld', 'R')],
          [sid(9, 'dk', 'R'), sid(11, 'ld', 'L')],
        ],
        rackStrain: DOOR_RACK_STRAIN,
        holdOpenDeg: 68,
        maxOpenDeg: 75,
        budgetPerKg: BUDGET_PER_KG,
        ...CLOSURE,
      },
      openSign: 1,
    });
    planClosures(closureSpecs, pos, (id) => /^s\d+_/.test(id));
    addClosureNodes(closureSpecs, addNode);
  }

  // ---- wheels
  const unsprungWheelOf = (front: boolean): number => hubMass(front) + COUPE_TYRE.rimMass + COUPE_TYRE.tireMass;
  const unsprungCornerOf = (front: boolean): number => unsprungWheelOf(front) + knuckleMass(front);
  const wheel = (id: 'FL' | 'FR' | 'RL' | 'RR'): WheelDef => {
    const front = id[0] === 'F';
    const s: Side = id[1] === 'L' ? 'L' : 'R';
    const c = corners.get(id)!;
    return {
      ...COUPE_TYRE,
      rollingLossComp: COUPE_ROLLING_LOSS,
      treadBrushStiffness: front ? COUPE_TYRE.treadBrushStiffness : REAR_BRUSH,
      hubMass: hubMass(front),
      id,
      hubInner: pos.get(c.hubI)!,
      hubOuter: pos.get(c.hubO)!,
      axle: front ? 'front' : 'rear',
      steered: front,
      driven: !front,
      braked: true,
      // Big brakes, 64/36 bias: front wheels reach 3200 N·m, rear 3200·0.36/0.64 = 1800 N·m.
      brakeTorqueMax: 3200,
      handbrake: !front,
      attach: [c.kU],
      attachSpring: ATTACH_SPRING * linkFactor(front),
      attachDamp: ATTACH_DAMP,
      attachBreakF: 1.0e5,
    };
  };
  const wheels = [wheel('FL'), wheel('FR'), wheel('RL'), wheel('RR')];

  // ---- mass distribution solve
  /*
   * Structure masses get a linear gradient m_i = b_i·(s + a·(z_i − z̄) + c·(y_i − ȳ))
   * (b_i = base mass per tag above). Three linear equations fix s, a, c:
   *   Σm = M_total − M_fixed (engine, gearbox, knuckles, wheels),
   *   Σm·z = M_total·z_cg − Σ_fixed m·z,  z_cg = Z_R − share·wheelbase (48/52 static split),
   *   Σm·y = M_total·y_cg − Σ_fixed m·y.
   */
  {
    const M = COUPE_TARGETS.totalMass;
    const zcg = Z_R - COUPE_TARGETS.frontAxleShare * COUPE_TARGETS.wheelbase;
    const ycg = COUPE_TARGETS.cgHeight;
    const isStruct = new Set(structure);
    let fm = 0;
    let fz = 0;
    let fy = 0;
    for (const n of nodes) {
      if (isStruct.has(n.id)) continue;
      fm += n.mass;
      fz += n.mass * n.pos[2];
      fy += n.mass * n.pos[1];
    }
    for (const w of wheels) {
      const uw = unsprungWheelOf(w.axle === 'front');
      fm += uw;
      fz += uw * w.hubInner[2];
      fy += uw * w.hubInner[1];
    }
    let bSum = 0;
    let zBar = 0;
    let yBar = 0;
    for (const id of structure) {
      const b = massOf.get(id)!;
      bSum += b;
      zBar += b * pos.get(id)![2];
      yBar += b * pos.get(id)![1];
    }
    zBar /= bSum;
    yBar /= bSum;
    // Rows: [Σb, Σb·dz, Σb·dy] · [s, a, c] = rhs for weights 1, z, y.
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const id of structure) {
      const b = massOf.get(id)!;
      const [, y, z] = pos.get(id)!;
      const basis = [1, z - zBar, y - yBar];
      const wts = [1, z, y];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) A[r]![k]! += b * wts[r]! * basis[k]!;
    }
    const rhs = [M - fm, M * zcg - fz, M * ycg - fy];
    const coef = solve3(A, rhs);
    for (const n of nodes) {
      if (!isStruct.has(n.id)) continue;
      const b = massOf.get(n.id)!;
      const m = b * (coef[0]! + coef[1]! * (n.pos[2] - zBar) + coef[2]! * (n.pos[1] - yBar));
      if (!(m > 0.5)) throw new Error(`coupe: mass solve gave ${m} kg for ${n.id}`);
      n.mass = round(m, 3);
      massOf.set(n.id, n.mass);
    }
  }

  // ---- totals, CG, corner loads
  let totalMass = 0;
  const cg: V3 = [0, 0, 0];
  const accum = (m: number, p: readonly number[]): void => {
    totalMass += m;
    for (let k = 0; k < 3; k++) cg[k]! += m * p[k]!;
  };
  for (const n of nodes) accum(n.mass, n.pos);
  for (const w of wheels) accum(unsprungWheelOf(w.axle === 'front'), [(w.hubInner[0] + w.hubOuter[0]) / 2, Y_W, w.hubInner[2]]);
  for (let k = 0; k < 3; k++) cg[k] = cg[k]! / totalMass;
  const frontAxleShare = (Z_R - cg[2]) / (Z_R - Z_F);
  /*
   * Sprung corner mass = axle load / 2 − unsprung corner (wheel 38 kg +
   * knuckle 13.5 kg). Ride frequency is the ride rate (spring wheel rate in
   * series with the tyre): K_ride = m_s·(2πf)², k_wheel = K_ride·k_t/(k_t − K_ride).
   * Tyre rate k_t ≈ 3.5 kN / 15.6 mm ≈ 2.24e5 N/m (wheelrig.ts static test).
   */
  const sprungFront = (totalMass * frontAxleShare) / 2 - unsprungCornerOf(true);
  const sprungRear = (totalMass * (1 - frontAxleShare)) / 2 - unsprungCornerOf(false);
  const tireRate = 3500 / 0.0156;
  const wheelRateFor = (m: number, hz: number): number => {
    const ride = m * (2 * Math.PI * hz) ** 2;
    return (ride * tireRate) / (tireRate - ride);
  };
  const wheelRate = { front: wheelRateFor(sprungFront, COUPE_TARGETS.rideHzFront), rear: wheelRateFor(sprungRear, COUPE_TARGETS.rideHzRear) };

  // ---- beams
  const auto: AutoBeam[] = [];
  const fixed: RigBeamDef[] = [];
  const seen = new Set<string>();
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const link = (a: string, b: string, cls: BeamClass, factor = 1): void => {
    if (a === b) return;
    const k = key(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    auto.push({ a, b, cls, w: CLASSES[cls].w * factor });
  };
  const fix = (beam: RigBeamDef): void => {
    const k = key(beam.a, beam.b);
    if (seen.has(k)) throw new Error(`coupe: duplicate beam ${k}`);
    seen.add(k);
    fixed.push(beam);
  };
  const dist = (a: string, b: string): number => len(sub(pos.get(a)!, pos.get(b)!));
  const nearest = (from: string, pool: readonly string[], n: number): string[] =>
    pool
      .filter((p) => p !== from)
      .map((p) => [p, dist(from, p)] as const)
      .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, n)
      .map((x) => x[0]);
  const isGlass = (a: string, b: string): boolean => {
    const ta = tagOf.get(a);
    const tb = tagOf.get(b);
    if (ta === undefined || tb === undefined || stationOf.get(a) === stationOf.get(b)) return false;
    return GLASS_TAGS.some(([x, y]) => (ta === x && tb === y) || (ta === y && tb === x)) && !sameColumn(a, b);
  };
  /** Same tag + same side across consecutive stations: a rail / sill / roof-rail / tunnel member. */
  const isLongitudinal = (a: string, b: string): boolean => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    if (Math.sign(pa[0]) !== Math.sign(pb[0])) return false;
    const ta = tagOf.get(a)!;
    const tb = tagOf.get(b)!;
    if (ta === tb) return true;
    const [lo, hi] = stationOf.get(a)! < stationOf.get(b)! ? [ta, tb] : [tb, ta];
    const g = Math.min(stationOf.get(a)!, stationOf.get(b)!);
    return LOAD_PATH_CONTINUATIONS.some(([gap, x, y]) => gap === g && x === lo && y === hi);
  };
  /** Pillars (cowl→roof rail, roof rail→deck) are structure, not glass: same side and outboard. */
  const sameColumn = (a: string, b: string): boolean => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    return pa[0] !== 0 && pb[0] !== 0 && Math.sign(pa[0]) === Math.sign(pb[0]) && tagOf.get(a) !== 'bt' && tagOf.get(b) !== 'bt';
  };

  STATIONS.forEach((st, i) => {
    const paths = stationRing[i]!;
    const ring = paths.flat();
    // Ring edges.
    for (const path of paths) for (let k = 0; k + 1 < path.length; k++) link(path[k]!, path[k + 1]!, st.cls);
    if (st.closed) link(ring[ring.length - 1]!, ring[0]!, st.cls);
    // Bulkhead: in-plane triangulation.
    const ids = stationIds[i]!;
    if (st.bulkhead) {
      for (let p = 0; p < ids.length; p++)
        for (let q = p + 1; q < ids.length; q++) if (dist(ids[p]!, ids[q]!) <= BULKHEAD_REACH) link(ids[p]!, ids[q]!, st.cls);
    } else {
      for (const e of ids) if (!ring.includes(e)) for (const n of nearest(e, ids, 3)) link(e, n, st.cls);
      if (!st.closed) {
        // Open (engine-bay) sections: triangulate each side in-plane (an
        // untriangulated polyline section distorts freely: the bay rails
        // buckled inward elastically in a frontal and sprang back) and tie
        // the lower rails across under the engine (subframe crossmember).
        for (let p = 0; p < ids.length; p++)
          for (let q = p + 1; q < ids.length; q++) {
            const pa = pos.get(ids[p]!)!;
            const pb = pos.get(ids[q]!)!;
            const same = Math.sign(pa[0]) === Math.sign(pb[0]);
            const cross = !same && dist(ids[p]!, ids[q]!) <= BAY_CROSS_REACH;
            if ((same && dist(ids[p]!, ids[q]!) <= BULKHEAD_REACH) || cross) link(ids[p]!, ids[q]!, st.cls);
          }
      }
    }
    // Links to the next station: nearest LINKS_PER_NODE both ways.
    const next = stationIds[i + 1];
    if (next === undefined) return;
    // The firewall gap (bay → cage) belongs to the crumple zone: its rails
    // fold onto the firewall instead of loading the cell.
    const fw = st.cls !== 'cage' && STATIONS[i + 1]!.cls === 'cage';
    const cls: BeamClass = !fw && (STATIONS[i + 1]!.cls === 'cage' || st.cls === 'cage') ? 'cage' : st.cls;
    const pairs: [string, string][] = [];
    for (const a of ids) for (const b of nearest(a, next, LINKS_PER_NODE)) pairs.push([a, b]);
    for (const b of next) for (const a of nearest(b, ids, LINKS_PER_NODE)) pairs.push([a, b]);
    for (const [a, b] of pairs) {
      if (isGlass(a, b)) link(a, b, 'glass');
      else link(a, b, cls, isLongitudinal(a, b) ? LONGITUDINAL_W : 1);
    }
  });
  // Safety-cell chords spanning two stations (see CABIN_SPANS).
  for (const [i, ta, j, tb] of CABIN_SPANS) {
    for (const sd of ['R', 'L'] as const) {
      const a = pos.has(sid(i, ta, sd)) ? sid(i, ta, sd) : sid(i, ta);
      const b = pos.has(sid(j, tb, sd)) ? sid(j, tb, sd) : sid(j, tb);
      link(a, b, 'cage', ta === tb ? LONGITUDINAL_W : 1);
    }
  }
  for (const [i, ta, tb] of TOP_BRACES) for (const sd of ['R', 'L'] as const) link(sid(i, ta), sid(i, tb, sd), STATIONS[i]!.cls);
  for (const [i, ta, tb] of CROSS_CABIN) {
    link(sid(i, ta, 'R'), sid(i, tb, 'L'), 'cage');
    link(sid(i, ta, 'L'), sid(i, tb, 'R'), 'cage');
  }

  // Engine: rigid block (all pairs) + mounts to the nearest bay structure.
  const block = [...engine, ...gearbox];
  for (let p = 0; p < block.length; p++)
    for (let q = p + 1; q < block.length; q++) {
      const a = block[p]!;
      const b = block[q]!;
      const gbxPair = gearbox.includes(a) || gearbox.includes(b);
      // Gearbox ties only to the rear half of the block.
      if (gbxPair && !(gearbox.includes(a) && gearbox.includes(b)) && (pos.get(a)![2] === ENGINE_Z[0] || pos.get(b)![2] === ENGINE_Z[0])) continue;
      link(a, b, 'engine');
    }
  const bayPool = stationIds.slice(1, 7).flat();
  for (const e of block) for (const n of nearest(e, bayPool, 3)) link(e, n, 'mount');

  // Suspension pivots → nearest 4 structure nodes; per-axle cross members.
  const bodyPool = stationIds.flat();
  /*
   * Anchors: of the 8 nearest structure nodes pick the 4 whose unit
   * directions span space best (max det Σ ûûᵀ, ties → nearer), so a pivot
   * is never hung off one plane of the rail (soft in the arm's load axis).
   */
  const anchors = (p: string, pool: readonly string[]): string[] => {
    const cand = nearest(p, pool, 8);
    let best: string[] = cand.slice(0, 4);
    let bestScore = -Infinity;
    for (let a = 0; a < cand.length; a++)
      for (let b = a + 1; b < cand.length; b++)
        for (let c = b + 1; c < cand.length; c++)
          for (let d = c + 1; d < cand.length; d++) {
            const set = [cand[a]!, cand[b]!, cand[c]!, cand[d]!];
            const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            let sumD = 0;
            for (const q of set) {
              const v = sub(pos.get(q)!, pos.get(p)!);
              sumD += len(v);
              const u = unit(v);
              for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) M[3 * r + k]! += u[r]! * u[k]!;
            }
            const det =
              M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) - M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) + M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
            const score = det / sumD;
            if (score > bestScore + 1e-12) {
              bestScore = score;
              best = set;
            }
          }
    return best;
  };
  for (const [c, ids] of corners) {
    const z = c[0] === 'F' ? Z_F : Z_R;
    const pool = bodyPool.filter((id) => Math.abs(pos.get(id)![2] - z) < 0.75);
    for (const p of [...ids.lower, ...ids.upper, ids.link]) for (const n of anchors(p, pool)) link(p, n, 'subframe');
  }
  for (const axle of ['F', 'R'] as const) {
    const L = corners.get(`${axle}L`)!;
    const R = corners.get(`${axle}R`)!;
    // Rigid subframe (fixed K_SUBFRAME, see there): cross members + per-side triangles.
    const sub = (a: string, b: string): void =>
      fix({ a, b, type: 'normal', k: K_SUBFRAME, d: D_ARM, deform: SUBFRAME_DEFORM, breakF: SUBFRAME_BREAK });
    sub(L.lower[0]!, R.lower[0]!);
    sub(L.lower[1]!, R.lower[1]!);
    sub(L.lower[0]!, R.lower[1]!);
    sub(R.lower[0]!, L.lower[1]!);
    sub(L.link, R.link);
    for (const s of [L, R]) {
      sub(s.lower[0]!, s.lower[1]!);
      sub(s.link, s.lower[1]!);
      sub(s.link, s.lower[0]!);
      link(s.upper[0]!, s.upper[1]!, 'subframe');
    }
  }

  // ---- suspension (fixed stiffness)
  const motionRatio = { front: 0, rear: 0 };
  const shockK = { front: 0, rear: 0 };
  const shockD = { front: 0, rear: 0 };
  const preload = { front: 0, rear: 0 };
  const arbK = { front: 0, rear: 0 };
  const hydroTravel = { L: 0, R: 0 };
  let tieRodLength = 0;
  for (const [axle, g] of [['F', FRONT], ['R', REAR]] as const) {
    const front = axle === 'F';
    const which = front ? 'front' : 'rear';
    const mS = front ? sprungFront : sprungRear;
    const kW = front ? wheelRate.front : wheelRate.rear;
    const Rc = corners.get(`${axle}R`)!;
    const hubI = pos.get(Rc.hubI)!;
    const tower = pos.get(Rc.tower)!;
    /*
     * Exact first-order kinematics of the 1-DOF corner (right side) for a
     * unit vertical velocity of the wheel centre (see travelKinematics):
     * MR = shock compression rate per unit wheel travel. hubI moves ≈ 1.2×
     * the wheel centre because the upright rotates as it travels.
     */
    const kin = travelKinematics(g, hubI, pos.get(Rc.hubO)!, pos.get(Rc.kU)!);
    const mr = -dot(kin.vI, unit(sub(hubI, tower)));
    /*
     * Anti-roll pair hubI(L)–kU(R), kU(L)–hubI(R): length rate per unit
     * wheel travel in heave (h, both wheels up; camber gain makes it ≠ 0)
     * and roll (r, right up / left down). Per wheel the pair adds k·h² to
     * the heave wheel rate and k·r² to the roll wheel rate (energy
     * ½·2k·(rate·y)² vs springs ½·2·k_wheel·y²), so k = f·k_wheel/r² makes
     * the bar add f × the spring roll stiffness.
     */
    const Lc = corners.get(`${axle}L`)!;
    const uArb = unit(sub(pos.get(Rc.kU)!, pos.get(Lc.hubI)!));
    const mirrorV = (v: V3): V3 => [-v[0], v[1], v[2]];
    const hRate = dot(sub(kin.vU, mirrorV(kin.vI)), uArb);
    const rRate = dot(sub(kin.vU, mirrorV(kin.vI).map((c) => -c)), uArb);
    const frac = front ? ARB_FRACTION_FRONT : ARB_FRACTION_REAR;
    arbK[which] = sig3((frac * kW) / (rRate * rRate));
    /*
     * Spring on the shock axis: k·MR² + k_arb·h² = k_wheel. Static shock
     * force by virtual work (all other links rigid): F = W_s / MR, W_s = m_s·g.
     * Preload carries all but staticSuspensionSag: P = F − k·(sag·MR).
     * Damping: c = ζ·2·sqrt(k_wheel·m_s)·CAL / MR².
     */
    const k = (kW - arbK[which] * hRate * hRate) / (mr * mr);
    const Fs = (mS * G) / mr;
    const P = Fs - k * COUPE_TARGETS.staticSuspensionSag * mr;
    const c = (DAMPER_CALIBRATION * COUPE_TARGETS.dampingRatio * 2 * Math.sqrt(kW * mS)) / (mr * mr);
    motionRatio[which] = mr;
    shockK[which] = sig3(k);
    shockD[which] = sig3(c);
    preload[which] = sig3(P);
    // Bump stops at ±0.08 m of shock travel (beyond: 5× rate).
    const bound = round(0.08 / len(sub(hubI, tower)), 3);

    for (const s of ['L', 'R'] as const) {
      const ids = corners.get(`${axle}${s}`)!;
      // Axle stub: the generated hubI–hubO beam has the (soft) rim rate; this one makes the upright triangle rigid.
      const lf = linkFactor(front);
      fix({ a: ids.hubI, b: ids.hubO, type: 'normal', k: K_AXLE_STUB * lf, d: D_ARM, deform: 0, breakF: 0 });
      for (const p of ids.lower) fix({ a: ids.hubI, b: p, type: 'normal', k: K_LOWER_ARM * lf, d: D_ARM, deform: 9e4, breakF: 1.8e5 });
      for (const p of ids.upper) fix({ a: ids.kU, b: p, type: 'normal', k: K_UPPER_ARM, d: D_ARM, deform: 7e4, breakF: 1.4e5 });
      fix({
        a: ids.hubI,
        b: ids.tower,
        type: 'shock',
        k: shockK[which],
        d: shockD[which],
        preload: preload[which],
        boundsLow: bound,
        boundsHigh: bound,
        deform: 0,
        breakF: 1.2e5,
      });
      if (front) {
        /*
         * Tie rod: hydro rest = L0·(1 + travel·steer). Steer +1 = right turn =
         * negative rotation of the upright about the (upward) steering axis
         * hubI → kU; hubO swings fore/aft and the fore-aft tie rod follows.
         * The rod runs exactly fore-aft from hubO (travel moves hubO only in
         * x-y, so no bump steer / binding: an inclined rod added ~3e5 N/m of
         * heave stiffness). It is LINK_REACH = 0.35 m long; full lock stays
         * > 50° from the rod's dead point (rod in line with hubO's radius
         * about the axis).
         * Unbreakable: a step to full lock briefly loads it k·ΔL ≈ 2e5 N.
         * travel = central difference (L(−δ) − L(+δ)) / (2·L0) at δ = 0.55 rad.
         */
        const pI = pos.get(ids.hubI)!;
        const pO = pos.get(ids.hubO)!;
        const rack = pos.get(ids.link)!;
        const u = unit(sub(pos.get(ids.kU)!, pI));
        const L0 = len(sub(pO, rack));
        const Lat = (ang: number): number => len(sub(rotateAbout(pO, pI, u, ang), rack));
        const d = COUPE_TARGETS.maxWheelAngleRad;
        hydroTravel[s] = round((Lat(-d) - Lat(d)) / (2 * L0), 4);
        tieRodLength = L0;
        fix({ a: ids.link, b: ids.hubO, type: 'hydro', k: K_TOE_LINK * lf, d: D_ARM, hydroTravel: hydroTravel[s], deform: 0, breakF: 0 });
      } else {
        fix({ a: ids.link, b: ids.hubO, type: 'normal', k: K_TOE_LINK * lf, d: D_ARM, deform: 9e4, breakF: 1.6e5 });
      }
    }
    const L = Lc;
    const dArb = sig3(0.1 * Math.sqrt(arbK[which] * knuckleMass(front)));
    const arbF = linkFactor(front);
    fix({ a: L.hubI, b: Rc.kU, type: 'normal', k: arbK[which] * arbF, d: dArb, deform: 0, breakF: 1e5 });
    fix({ a: L.kU, b: Rc.hubI, type: 'normal', k: arbK[which] * arbF, d: dArb, deform: 0, breakF: 1e5 });
  }

  // ---- Trunk-lid centre support rests (the sedan's P5 fix): station 10 is
  // an open (non-bulkhead) ring, so the lid centre s10_ld would hang on its
  // lid neighbours; two compression-only rests down to the upper rear rails
  // s10_rh_L/R. Elastic, snap at 15 kN like the hood rests.
  for (const side of ['L', 'R'] as const) {
    const a = sid(10, 'ld');
    const b = sid(10, 'rh', side);
    const k = TRUNK_REST_K;
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    fix({ a, b, type: 'support', k, d: sig3(2 * HOOD.zeta * Math.sqrt((k * ma * mb) / (ma + mb))), deform: 0, breakF: HOOD.restBreak });
  }

  // ---- hood beams (declared last; see HOOD). Stiffness: each hood node's
  // budget (0.33/dt)²·m split by weight over its hood beams (a structure
  // endpoint never limits it); the hood k then counts as fixed k at its
  // structure endpoints, so their auto beams shrink to fit.
  const hoodBeams: RigBeamDef[] = [];
  {
    type HB = { a: string; b: string; w: number; kind: 'skin' | 'hinge' | 'latch' | 'rest' };
    const hb: HB[] = [];
    const H = (r: number, c: number): string => hoodIds[r]![c]!;
    for (let r = 0; r < HOOD_Z.length; r++) {
      for (let c = 0; c < 3; c++) {
        if (c + 1 < 3) hb.push({ a: H(r, c), b: H(r, c + 1), w: 1, kind: 'skin' });
        if (r + 1 < HOOD_Z.length) {
          hb.push({ a: H(r, c), b: H(r + 1, c), w: 1, kind: 'skin' });
          if (c + 1 < 3) {
            hb.push({ a: H(r, c), b: H(r + 1, c + 1), w: 0.5, kind: 'skin' });
            hb.push({ a: H(r, c + 1), b: H(r + 1, c), w: 0.5, kind: 'skin' });
          }
        }
      }
    }
    for (const s of ['L', 'R'] as const) {
      const c = s === 'L' ? 0 : 2;
      hb.push({ a: H(3, c), b: sid(5, 'cw', s), w: 1.5, kind: 'hinge' });
      hb.push({ a: H(3, c), b: sid(4, 'fd', s), w: 1.5, kind: 'hinge' });
      hb.push({ a: H(0, c), b: sid(2, 'fd', s), w: 1, kind: 'latch' });
      hb.push({ a: H(1, c), b: sid(2, 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(1, c), b: sid(3, 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid(3, 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid(4, 'fd', s), w: 0.5, kind: 'rest' });
    }
    hb.push({ a: H(0, 1), b: sid(2, 'rt'), w: 1, kind: 'latch' });
    hb.push({ a: H(1, 1), b: sid(2, 'rt'), w: 0.5, kind: 'rest' });
    // Front edge: the latch links are near-horizontal, so the front corners
    // and centre also rest on the crash-can tops / bumper beam (support).
    hb.push({ a: H(0, 0), b: sid(1, 'rh', 'L'), w: 0.5, kind: 'rest' });
    hb.push({ a: H(0, 2), b: sid(1, 'rh', 'R'), w: 0.5, kind: 'rest' });
    hb.push({ a: H(0, 1), b: sid(0, 'bu'), w: 0.5, kind: 'rest' });
    hb.push({ a: H(3, 1), b: sid(5, 'fw', 'L'), w: 0.5, kind: 'rest' });
    hb.push({ a: H(3, 1), b: sid(5, 'fw', 'R'), w: 0.5, kind: 'rest' });
    // The low hood's side rows sit almost level with the fender tops, so the
    // fender rests above are near-horizontal struts that carry no weight
    // (rows 1–2 L/R sagged 11 cm, row 3 3.6 cm at rest): each side row also
    // rests on the upper bay rails 30 cm below (≈ 55° struts).
    for (const s of ['L', 'R'] as const) {
      const c = s === 'L' ? 0 : 2;
      hb.push({ a: H(1, c), b: sid(2, 'rh', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(1, c), b: sid(3, 'rh', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid(3, 'rh', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid(4, 'rh', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(3, c), b: sid(4, 'rh', s), w: 0.5, kind: 'rest' });
    }
    // hood_2C rests on the V8's top corners (cam covers): with only the skin
    // under it the sedan's settled crown sagged 5.9 cm.
    for (const s of ['L', 'R'] as const) {
      hb.push({ a: H(2, 1), b: `eng_rhi_${s}`, w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, 1), b: `eng_fhi_${s}`, w: 0.5, kind: 'rest' });
    }
    const hoodW = new Map<string, number>();
    for (const b of hb) for (const id of [b.a, b.b]) if (id.startsWith('hood_')) hoodW.set(id, (hoodW.get(id) ?? 0) + b.w);
    const hoodShare = (id: string): number => (id.startsWith('hood_') ? (BUDGET_PER_KG * massOf.get(id)!) / hoodW.get(id)! : Infinity);
    for (const { a, b, w, kind } of hb) {
      const k = sig3(0.995 * w * Math.min(hoodShare(a), hoodShare(b)));
      const ma = massOf.get(a)!;
      const mb = massOf.get(b)!;
      const d = sig3(2 * HOOD.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
      const L = dist(a, b);
      if (seen.has(key(a, b))) throw new Error(`coupe: duplicate hood beam ${a}–${b}`);
      seen.add(key(a, b));
      if (kind === 'skin') {
        const deform = sig3(Math.max(HOOD.yieldStrain * k * L, HOOD.minDeform));
        hoodBeams.push({ a, b, type: 'normal', k, d, deform, breakF: sig3(HOOD.breakRatio * deform) });
      } else if (kind === 'hinge') {
        hoodBeams.push({ a, b, type: 'normal', k, d, deform: HOOD.hingeDeform, breakF: HOOD.hingeBreak });
      } else if (kind === 'latch') {
        hoodBeams.push({ a, b, type: 'normal', k, d, deform: 0, breakF: HOOD.latchBreak });
      } else {
        hoodBeams.push({ a, b, type: 'support', k, d, deform: 0, breakF: HOOD.restBreak });
      }
    }
  }

  // ---- auto stiffness: split each node's budget by class weight
  /*
   * Node budget B_i = (0.33/dt)²·m_i − Σ(fixed k at i, incl. generated wheel
   * attach beams). Beam k = w·min(B_a/W_a, B_b/W_b), W = Σ w of auto beams at
   * the node, so Σk_i ≤ (0.33/dt)²·m_i for every node by construction.
   * Damping d = 2ζ·sqrt(k·μ), μ = reduced mass of the two endpoints.
   */
  const fixedK = new Map<string, number>();
  const addK = (id: string, k: number): void => void fixedK.set(id, (fixedK.get(id) ?? 0) + k);
  // ---- hinged closure beams (R-CRASH), counted as fixed k at their body nodes like the hood's
  const closures = buildClosureSet(closureSpecs, pos, massOf, seen, key, SHELL_RELEASE_CELL);
  for (const b of [...fixed, ...hoodBeams, ...closures.beams]) {
    addK(b.a, b.k!);
    addK(b.b, b.k!);
  }
  for (const w of wheels) for (const id of w.attach) addK(id, 2 * (w.attachSpring ?? ATTACH_SPRING));
  const W = new Map<string, number>();
  for (const b of auto) {
    const w = b.w;
    W.set(b.a, (W.get(b.a) ?? 0) + w);
    W.set(b.b, (W.get(b.b) ?? 0) + w);
  }
  const share = (id: string): number => {
    const perKg = stationOf.has(id) ? SHELL_BUDGET_PER_KG : BUDGET_PER_KG;
    const budget = perKg * massOf.get(id)! - (fixedK.get(id) ?? 0);
    if (!(budget > 0)) throw new Error(`coupe: node ${id} has no stiffness budget left`);
    return budget / W.get(id)!;
  };
  const kOf = auto.map(({ a, b, w }) => sig3(0.995 * w * Math.min(share(a), share(b))));
  /*
   * CRASH SECTIONS: body beams spanning consecutive stations g → g+1 (glass
   * excepted) yield together when the gap closes by δ_g = F_g / K_g, where
   * F_g = GAP_YIELD[g] (the section's axial yield force) and
   * K_g = Σ k·cz² its axial stiffness (cz = |cos| of the beam to the car's
   * long axis): deform = k·δ_g·cz (floored by the class minDeform).
   * Uniform section yield = the gap crushes as one fold instead of one
   * member at a time.
   */
  const gapOf = (a: string, b: string): number => {
    const sa = stationOf.get(a);
    const sb = stationOf.get(b);
    if (sa === undefined || sb === undefined || Math.abs(sa - sb) !== 1) return -1;
    return Math.min(sa, sb);
  };
  const czOf = (a: string, b: string): number => Math.abs(pos.get(a)![2] - pos.get(b)![2]) / dist(a, b);
  const gapK = new Float64Array(STATIONS.length);
  const isLong = (i: number): boolean => auto[i]!.w > CLASSES[auto[i]!.cls].w;
  // Longitudinal members (rails, sills, …) carry the section yield force
  // F_g in equal shares; the rest of the gap yields at the rails' travel.
  const gapLongCz = new Float64Array(STATIONS.length);
  auto.forEach(({ a, b, cls }, i) => {
    const g = gapOf(a, b);
    if (g < 0 || cls === 'glass') return;
    gapK[g]! += kOf[i]! * czOf(a, b) ** 2;
    if (isLong(i)) gapLongCz[g]! += czOf(a, b);
  });
  const longDeform = Array.from(gapLongCz, (c, g) => (g < GAP_YIELD.length && c > 0 ? GAP_YIELD[g]! / c : 0));
  const travelSum = new Float64Array(STATIONS.length);
  const travelN = new Float64Array(STATIONS.length);
  auto.forEach(({ a, b, cls }, i) => {
    const g = gapOf(a, b);
    if (g < 0 || cls === 'glass' || !isLong(i)) return;
    travelSum[g]! += longDeform[g]! / (kOf[i]! * czOf(a, b));
    travelN[g]!++;
  });
  const gapYieldTravel = Array.from(travelSum, (t, g) => (travelN[g]! > 0 ? t / travelN[g]! : 0));
  const autoBeams: RigBeamDef[] = auto.map(({ a, b, cls }, i) => {
    const spec = CLASSES[cls];
    const k = kOf[i]!;
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    const d = sig3(2 * spec.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
    if (spec.yieldStrain === 0) return { a, b, type: 'normal', k, d, deform: 0, breakF: 0 };
    const g = gapOf(a, b);
    let section = 0;
    if (cls === 'glass') {
      // Brittle: elastic up to its break strain, then shatters (never yields).
      return { a, b, type: 'normal', k, d, deform: 0, breakF: sig3(GLASS_BREAK_STRAIN * k * dist(a, b)) };
    }
    if ((FIREWALL_PANEL.test(a) || FIREWALL_PANEL.test(b)) && stationOf.has(a) && stationOf.has(b)) {
      // Firewall panel: dents plastically where the engine hits it.
      const deform = sig3(Math.max(REAR_BAY_FACTOR * CLASSES.bay.yieldStrain * k * dist(a, b), CLASSES.bay.minDeform));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(CLASSES.bay.breakRatio * deform) };
    }
    if (isDoor(a, b)) {
      const deform = sig3(Math.max(DOOR_YIELD_STRAIN * k * dist(a, b), DOOR_MIN_DEFORM));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(spec.breakRatio * deform) };
    }
    if (cls === 'cage') {
      if (g >= 0) {
        section = isLong(i)
          ? longDeform[g]!
          : Math.max(k * gapYieldTravel[g]! * Math.max(czOf(a, b), SHEAR_YIELD_FLOOR), SHEAR_FORCE_SHARE * longDeform[g]!);
      }
      else {
        // In-station (ring / bulkhead / bay brace) members keep the section's
        // shape: they yield only at the adjacent gaps' yield travel.
        const st = stationOf.get(a);
        if (st !== undefined && st === stationOf.get(b)) {
          const near = Math.max(gapYieldTravel[st - 1] ?? 0, gapYieldTravel[st] ?? 0);
          section = k * near * IN_STATION_YIELD_FACTOR;
        }
      }
    }
    if (section === 0 && isCabinSpan(a, b)) section = CABIN_SPAN_YIELD_STRAIN * k * dist(a, b);
    const rearBay = (g === 3 || g === 4 || (g < 0 && (stationOf.get(a) === 4 || stationOf.get(b) === 4) && stationOf.get(a) === stationOf.get(b))) && cls !== 'cage';
    const base = section > 0 ? section : spec.yieldStrain * k * dist(a, b);
    const deform = sig3(Math.max(rearBay ? base * REAR_BAY_FACTOR : base, spec.minDeform));
    const mount = isBumperMount(a, b);
    return { a, b, type: 'normal', k, d, deform, breakF: sig3((mount ? BUMPER_MOUNT_BREAK_RATIO : spec.breakRatio) * deform) };
  });

  /*
   * Damping budget: (Σd/m)·dt ≤ DAMP_BUDGET per node (the validator's limit
   * is 1). Light nodes with many auto beams (radiator support, firewall
   * tunnel) exceeded it at the crash-zone damping ratios; their auto beams'
   * d (and the hood's) is scaled down uniformly (never the fixed beams).
   */
  {
    const sumD = new Map<string, number>();
    for (const b of [...autoBeams, ...fixed, ...hoodBeams, ...closures.beams]) {
      for (const id of [b.a, b.b]) sumD.set(id, (sumD.get(id) ?? 0) + (b.d ?? 0));
    }
    for (const w of wheels) for (const id of w.attach) sumD.set(id, (sumD.get(id) ?? 0) + 2 * (w.attachDamp ?? 0));
    // the scalable share (auto / hood / closure beams): when the uniform factor still leaves a node over the
    // validator's limit (its fixed suspension dampers alone near it: a shock tower once the R-CRASH closures
    // took 42 kg out of the structure solve), the scalable beams take the whole cut
    const scalableD = new Map<string, number>();
    for (const b of [...autoBeams, ...hoodBeams, ...closures.beams]) for (const id of [b.a, b.b]) scalableD.set(id, (scalableD.get(id) ?? 0) + (b.d ?? 0));
    const scale = (id: string): number => {
      const m = massOf.get(id);
      if (m === undefined) return 1;
      const sum = sumD.get(id)!;
      const z = (sum * DT) / m;
      if (z <= DAMP_BUDGET) return 1;
      const sc = scalableD.get(id) ?? 0;
      const f = DAMP_BUDGET / z;
      if (((sum - sc * (1 - f)) * DT) / m <= 1) return f;
      return sc > 0 ? Math.max(0, (DAMP_BUDGET * m) / DT - (sum - sc)) / sc : 1;
    };
    for (const b of [...autoBeams, ...hoodBeams, ...closures.beams]) {
      const f = Math.min(scale(b.a), scale(b.b));
      if (f < 1) b.d = sig3(b.d! * f);
    }
  }
  const beams = [...autoBeams, ...fixed, ...hoodBeams, ...closures.beams];
  // R-CRASH roof strength (roof.ts; roofStrength.ts platen): the roof ring's members yield at the roof's collapse load
  capRoofYield(beams, ROOF_RING, ROOF_YIELD);
  const def: VehicleDef = {
    name: 'coupe',
    body: {
      name: 'coupe.body',
      nodes,
      beams,
      groupDefaults: {
        body: { friction: 0.5, radius: 0.05 },
        engine: { friction: 0.5, radius: 0.08 },
        subframe: { friction: 0.5, radius: 0.04 },
        knuckle: { friction: 0.5, radius: 0.03 },
        hood: { friction: 0.5, radius: 0.03 },
        door: { friction: 0.5, radius: 0.03 },
        trunk: { friction: 0.5, radius: 0.03 },
      },
    },
    wheels,
    drivetrain: DRIVETRAIN,
    brakes: { frontBias: 0.64, handbrakeTorqueMax: 1800, abs: true, esc: true },
    // Low, wide fastback with a ducktail and diffuser: net downforce. CdA 0.68 (Cd ≈ 0.35
    // × 1.95 m²) also caps v_max at ≈ 285 km/h (a 40 s run settles there, |r| < 0.02 rad/s):
    // at 0.58 it reached 288 km/h and slowly yawed off line (wheel speed far beyond the tread
    // hoop-tension cap, wheels.ts HOOP_OMEGA_MAX).
    // R-PHYS: lift per axle (sports coupe with a rear spoiler: slight front lift, rear downforce; Hucho, "Aerodynamics of Road Vehicles" 1998)
    aero: { dragCoeffArea: 0.68, liftCoeffArea: -0.12, liftFront: 0.03, liftRear: -0.15 },
    // R-PHYS: linear dampers for now. With any non-linear valving (dampers.ts) the 30 km/h side pole pulls
    // s5_hp_R 1–3 cm past the pole axis ≈ 0.4 s after contact (it already does at 31 km/h with these linear
    // dampers): a marginal pillar case for R-CRASH (CONTRACTS "R-PHYS ↔ R-CRASH"). Sports valving to fit then:
    // { bump: 0.65, rebound: 1.2 } (rebound 1.8 : 1).

    steering: { maxWheelAngleDeg: round((COUPE_TARGETS.maxWheelAngleRad * 180) / Math.PI, 2) },
    frame: { origin: sid(7, 'tn'), front: sid(2, 'rs'), top: sid(7, 'rf') },
    // Feel pass: rigid shell cluster (shell.ts) — crumple zones released whole on impact, firewall, safety cell.
    crushSet: ROOF_RING,
    // R-CRASH: each hinged closure is a LATCHED zone of the body cluster (free on its hinges once its latch
    // breaks) plus its own dormant cluster that wakes then (the free panel stays a stiff panel)
    shell: [
      {
        ...shellLayout({
          front: ['s0_*', 's1_*', 's2_*', 's3_*', 's4_*', 'hood_*', 'FL_*', 'FR_*'],
          rear: ['s9_*', 's10_*', 's11_*', 's12_*', 'RL_*', 'RR_*'],
          firewall: ['s5_*'],
          cell: ['s5_hp_*', 's5_sl_*', 's6_*', 's7_*', 's8_*'],
          extra: closures.zones,
        }),
        groups: [...SHELL_GROUPS, 'door', 'trunk'],
      },
      ...dormantClosureShells(closureSpecs, SHELL_RELEASE_CELL),
    ],
  };
  const design: CoupeDesign = {
    totalMass,
    cg,
    frontAxleShare,
    unsprungCorner: { front: unsprungCornerOf(true), rear: unsprungCornerOf(false) },
    sprungCornerMass: { front: sprungFront, rear: sprungRear },
    tireRate,
    wheelRate,
    motionRatio,
    shockK,
    shockD,
    preload,
    arbK,
    tieRodLength,
    hydroTravel,
    bodyNodeCount: nodes.length,
    bodyBeamCount: beams.length,
    gapAxialK: Array.from(gapK.slice(0, STATIONS.length - 1)),
    gapYieldTravel: gapYieldTravel.slice(0, STATIONS.length - 1),
  };
  return { def, design };
}

/**
 * First-order kinematics of a corner (right side) for unit vertical
 * velocity of the wheel centre. hubI rotates about the lower pivot axis
 * (rate a), kU about the upper pivot axis (rate b); hubO keeps its distance
 * to hubI, kU and the fixed toe pivot; hubI–kU stays rigid. Linear in
 * (b, v_O) for a = 1, then scaled so the wheel centre rises at 1 m/s.
 */
function travelKinematics(g: CornerGeom, I: V3, O: V3, U: V3): { vI: V3; vO: V3; vU: V3 } {
  const rot = (a: readonly number[], b: readonly number[], pt: V3): V3 => cross(unit(sub(b, a)), sub(pt, a));
  const wI = rot(g.lowerPivots[0], g.lowerPivots[1], I);
  const wU = rot(g.upperPivots[0], g.upperPivots[1], U);
  const T = g.linkPivot;
  const dOI = sub(O, I);
  const dOU = sub(O, U);
  const dOT = sub(O, T);
  const dUI = sub(U, I);
  // Unknowns x = [b, vOx, vOy, vOz].
  const A = [
    [0, dOI[0], dOI[1], dOI[2]], //   (vO − vI)·(O − I) = 0
    [-dot(wU, dOU), dOU[0], dOU[1], dOU[2]], // (vO − b·wU)·(O − U) = 0
    [0, dOT[0], dOT[1], dOT[2]], //   vO·(O − T) = 0
    [dot(wU, dUI), 0, 0, 0], //      (b·wU − vI)·(U − I) = 0
  ];
  const rhs = [dot(wI, dOI), 0, 0, dot(wI, dUI)];
  const x = solveN(A, rhs);
  const vI = wI;
  const vU: V3 = [wU[0] * x[0]!, wU[1] * x[0]!, wU[2] * x[0]!];
  const vO: V3 = [x[1]!, x[2]!, x[3]!];
  const sc = 1 / ((vI[1] + vO[1]) / 2);
  const scale = (v: V3): V3 => [v[0] * sc, v[1] * sc, v[2] * sc];
  return { vI: scale(vI), vO: scale(vO), vU: scale(vU) };
}

/** Gaussian elimination with partial pivoting (n×n). */
function solveN(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Gaussian elimination with partial pivoting (3×3). */
function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

const BUILT = buildCoupe();

/**
 * Node sets the crash harness measures the coupe by (crash.ts CrashProbes):
 * crash-can tips s1, B-pillar floor s7, firewall ring s5, safety cell
 * s8 (rear-seat bulkhead) → s5, the long door's mid nodes s6, bumper
 * stations s0 / s12 and the hood exempt from the span check.
 */
export const COUPE_CRASH_PROBES: CrashProbes = {
  front: ['s1_rl_*', 's1_rh_*'],
  cabin: ['s7_fl_*', 's7_sl_*'],
  firewall: ['s5_fl_*', 's5_sl_*', 's5_hp_*', 's5_cw_*'],
  cellRear: ['s8_*'],
  cellFront: ['s5_*'],
  doorMid: ['s6_dm_*'],
  doorR: 's6_dm_R',
  doorL: 's6_dm_L',
  sillR: 's6_sl_R',
  sillL: 's6_sl_L',
  exemptPrefixes: ['s0_', `s${REAR_BUMPER}_`, 'hood_'],
  latch: [['hood_0C', 's2_rt']],
  bumperPrefix: 's0_',
  windscreen: ['s5_cw', 's6_rf'],
};

/** The coupe VehicleDef (plain JSON). Wheels FL, FR, RL, RR. */
export const COUPE: VehicleDef = BUILT.def;
/** Derived design numbers (mass/CG solve, suspension rates) for tests and tuning UIs. */
export const COUPE_DESIGN: CoupeDesign = BUILT.design;
