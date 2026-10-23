/**
 * SEDAN_TRAFFIC — the AI traffic sedan: the player SEDAN's chassis on a
 * cheaper rig (docs/CONTRACTS.md "P6 contracts": ≤ 1500 beams, 10-ray
 * wheels, no hood sub-rig, same mass / wheelbase / track / drivetrain, the
 * sedan's node-id scheme `s{station}_{tag}_{side}` at the same rest
 * positions for every node it keeps, so T2 derives its visual from
 * buildSedanVisual with re-pointed selectors).
 *
 * A COPY-AND-ADAPT of defs/sedan.ts (no shared fleet generator; never
 * import from or edit sedan.ts). What changed, and why it still drives and
 * crashes like the sedan:
 *  - wheels: 10 rays (WHEEL_TUNING_TRAFFIC_10). Per-beam rim / sidewall /
 *    tread-ring springs and dampers, the tread contact layer and brush are
 *    scaled by 12/10 (the same per-node mass and ω·dt as the 12-ray wheel,
 *    the same total radial / lateral stiffness);
 *  - no hood sub-rig (the hood panel binds to the fender tops / radiator
 *    support) and no engine block (the I6's mass is in the bay rails);
 *  - SKIP_STATIONS: no door stations (s6, s8) and no trunk stations (s11,
 *    s12): the cage runs A-pillar → B-pillar → C-pillar, the trunk axle ring
 *    → rear bumper, each one longer bay; OMIT: the B-pillar floor pans;
 *  - bulkheads aft of the B-pillar triangulated within 0.45 m;
 *  - CRUSH CANS on the front rails (a robust frontal, see there);
 *  - inter-station links: each node to its nearest next-station node both
 *    ways plus ONE shear diagonal per ring edge (GAP DIAGONALS), except the
 *    front crumple zone (GAP_LINKS, nearest 2 both ways) — fewer, stiffer
 *    beams for the same per-node ω·dt budget (the auto-stiffness allocation
 *    splits each node's budget over fewer beams), so the section stiffness
 *    and the strain-based crash classes carry over;
 *  - bulkheads triangulated within BULKHEAD_REACH 0.6 m (sedan 1.0), the
 *    rear-seat bulkhead s9 within 0.85 m (FULL_BULKHEADS: the rear
 *    subframe's anchor ring; softer, the 195 km/h straight weaved) and the
 *    rear-axle ring s10 braced in-plane (BRACED_STATIONS: rear toe
 *    stiffness); bay cross braces within 1.0 m (sedan 1.2); the B-pillar
 *    roof centre braced to the pillar tops (EXTRA_CAGE);
 *  - subframe pivots on 3 body anchors (sedan 4);
 *  - crumple-class yield floors ×CRUMPLE_FLOOR_FACTOR.
 * Measured (sedanTraffic.test.ts): 1351 beams (wheels 892, body 459; was
 * 1499), sag 4.5 cm, 0–100 6.8 s, 100–0 35.8 m, R40 0.98 g, step overshoot
 * 1.18; 50 km/h frontal crush 40.8 cm (40.4 / 41.7 at 47.5 / 52.5 km/h,
 * 40.8 at 90 % overlap).
 * Everything else (stations, suspension, subframe, drivetrain, crash
 * classes, mass solve) is the sedan's.
 *
 * Vehicle frame: up +Y, forward −Z, right +X. Ground at y = 0 with the tyres
 * just touching in the rest pose (wheel centres at y = WHEEL_RADIUS).
 */
import { shellLayout } from '../shellDefs';
import type { RigBeamDef, RigNodeDef } from '../../rig/types';
import { wheelNodeId, type DrivetrainDef, type VehicleDef, type WheelDef } from '../types';
import type { CrashProbes } from '../crash';
import { WHEEL_TUNING_205_55R16 } from '../wheelrig';

/**
 * The sedan's 205/55R16 tuning on a 10-ray wheel: per-beam springs/dampers,
 * the per-node contact layer and brush ×12/10 (each node carries 1.2× the
 * mass, so ω·dt per node is unchanged; ring/sidewall totals match).
 */
const RAY_SCALE = 12 / 10;
export const WHEEL_TUNING_TRAFFIC_10 = {
  ...WHEEL_TUNING_205_55R16,
  rays: 10,
  tireContactSpring: WHEEL_TUNING_205_55R16.tireContactSpring * RAY_SCALE,
  treadBrushStiffness: WHEEL_TUNING_205_55R16.treadBrushStiffness * RAY_SCALE,
  treadBrushDamping: WHEEL_TUNING_205_55R16.treadBrushDamping * RAY_SCALE,
  tireRingSpring: WHEEL_TUNING_205_55R16.tireRingSpring * RAY_SCALE,
  tireRingDamp: WHEEL_TUNING_205_55R16.tireRingDamp * RAY_SCALE,
  rimSpring: WHEEL_TUNING_205_55R16.rimSpring * RAY_SCALE,
  rimDamp: WHEEL_TUNING_205_55R16.rimDamp * RAY_SCALE,
  sidewallSpring: WHEEL_TUNING_205_55R16.sidewallSpring * RAY_SCALE,
  sidewallDamp: WHEEL_TUNING_205_55R16.sidewallDamp * RAY_SCALE,
} as const;

// ====================================================================== targets
const DT = 1 / 2000;
const G = 9.81;
export const SEDAN_TRAFFIC_TARGETS = {
  totalMass: 1450,
  wheelbase: 2.75,
  track: 1.56,
  frontAxleShare: 0.52,
  /** CG height in the REST pose; the car settles ~3 cm lower. */
  cgHeight: 0.52,
  rideHzFront: 1.4,
  rideHzRear: 1.6,
  dampingRatio: 0.3,
  /**
   * Suspension compression (at the wheel) under static load, m: the rest of
   * the weight is preload. Small because the soft-body tyre already squishes
   * ~3.5 cm (wheelrig.ts) and the chassis should settle only 2–6 cm.
   */
  staticSuspensionSag: 0.001,
  maxWheelAngleRad: 0.55,
} as const;

const Z_F = -SEDAN_TRAFFIC_TARGETS.wheelbase / 2; // front axle
const Z_R = SEDAN_TRAFFIC_TARGETS.wheelbase / 2; // rear axle
const HALF_TRACK = SEDAN_TRAFFIC_TARGETS.track / 2;
const WHEEL_RADIUS = WHEEL_TUNING_TRAFFIC_10.radius; // 0.32 m
const Y_W = WHEEL_RADIUS; // wheel centre height at rest (tyres touch y = 0)

/** ω·dt the auto-stiffness allocation solves for (structure limit 0.35, margin). */
const OMEGA_DT_TARGET = 0.33;
const BUDGET_PER_KG = (OMEGA_DT_TARGET / DT) ** 2; // Σk/m allowed, (N/m)/kg
/**
 * ω·dt target of the body SHELL nodes (stations s0…s13), above the 0.33 of
 * everything else, still under the 0.5 hard limit.
 * WHY: crash response is stiffness-limited. The ~590 kg shell must carry a
 * ~250–400 kN crush force; at 0.33 its section stiffnesses were ~3 MN/m,
 * so a section reached its yield force only after ~10 cm of ELASTIC
 * closure per section: a 30 km/h frontal compressed the nose ~90 cm and
 * gave most of it back (spring-back, rebound). (0.485/0.33)² ≈ 2.2× the
 * stiffness. With ground/collider contact (≤ sqrt(0.2) in quadrature) a
 * shell node stays ≤ 0.68, far inside the explicit-Euler bound of 2.
 */
const SHELL_OMEGA_DT_TARGET = 0.485;
const SHELL_BUDGET_PER_KG = (SHELL_OMEGA_DT_TARGET / DT) ** 2;

// ====================================================================== beam classes
/**
 * Structural classes. `w` = relative stiffness share when a node's budget
 * (Σk ≤ (0.33/dt)²·m) is split among its auto beams; `zeta` = per-beam
 * damping ratio on the reduced mass.
 *
 * Plastic yield is STRAIN-based with a force floor:
 *   deform = max(yieldStrain·k·L, minDeform), breakF = breakRatio·deform.
 * Pure force thresholds fail here: the ω·dt budget keeps body beams soft
 * (k ≈ 1–3e5 N/m), so a 2e4 N threshold needs ~50 % strain and an 8 m/s
 * frontal hit crushed the nose 0.5 m ELASTICALLY (it sprang back) while the
 * cage broke. Floors sit above the measured driving loads (full throttle,
 * locked-wheel braking, full-lock cornering, 0.5 m drop: ≤ 3 kN in body
 * beams, ≤ 4.7 kN in mounts/subframe), so normal driving stays elastic;
 * the cage floor is ~4× the crumple zones', so crashes fold the ends first.
 * P4 crash tuning (crash.ts harness, peak/final/spring-back measured):
 * LOW yield strains in the crumple zones (1.5–2.5 %): the elastic travel
 * before yield is what springs back, so members that distort must yield
 * early; ζ 0.4 there; the rear bay stronger (REAR_BAY_FACTOR) so the zone
 * folds front to back; cage links force-based (CRASH SECTIONS) so the cell
 * never yields in a frontal. Spring-back sources found and removed: the
 * plastic ratchet's symmetric reverse yield (beams.ts
 * PLASTIC_REVERSE_FACTOR), a 25 kg-node engine block on budget-starved
 * mounts (ENGINE_NODE_MASS), soft subframe anchors (class weight 3), an
 * elastic firewall (FIREWALL_PANEL).
 */
/**
 * The rear bay (gaps s3→s4→s5, s4's own members and the firewall panel)
 * yields at this multiple of the bay class strain: the front zone (bumper,
 * crash cans, s2→s3) folds first and the rear bay + firewall stop the
 * engine/wheel stack. Without it a 50 km/h hit crushed the whole bay into
 * the firewall (peak ~95 cm).
 */
const REAR_BAY_FACTOR = 10;
/**
 * Traffic rig: the crumple classes' yield-force floors × this. Their
 * members yield at the FLOOR (k·strain·L ≪ minDeform at these budgets), so
 * a section's yield force is ≈ members × floor; the traffic rig has ≈ 2/3
 * of the sedan's members per gap, and at the sedan's floors the 50 km/h
 * frontal crushed 98 cm (peak 118).
 */
const CRUMPLE_FLOOR_FACTOR = 2.2;
const CLASSES = {
  bumper: { w: 1.0, zeta: 0.4, yieldStrain: 0.025, minDeform: 1.5e3 * CRUMPLE_FLOOR_FACTOR, breakRatio: 5 },
  crash: { w: 1.0, zeta: 0.4, yieldStrain: 0.018, minDeform: 3e3 * CRUMPLE_FLOOR_FACTOR, breakRatio: 6 },
  bay: { w: 1.0, zeta: 0.4, yieldStrain: 0.015, minDeform: 4e3 * CRUMPLE_FLOOR_FACTOR, breakRatio: 6 },
  cage: { w: 1.3, zeta: 0.3, yieldStrain: 0.1, minDeform: 1.6e4, breakRatio: 5 },
  /** Brittle: elastic, shatters at GLASS_BREAK_STRAIN (yieldStrain/breakRatio unused). */
  glass: { w: 0.4, zeta: 0.25, yieldStrain: 0.06, minDeform: 0, breakRatio: 1.7 },
  /**
   * Weight 3 (P4): stiff anchors; at 1.5 the heavy subframe compressed its
   * anchors ~10 cm elastically in a frontal and pushed the nose back out.
   * Floor 2e4 N ≥ 1.25× the measured hard-driving anchor load (16 kN).
   */
  subframe: { w: 3, zeta: 0.25, yieldStrain: 0.04, minDeform: 2e4, breakRatio: 5 },
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

const BULKHEAD_REACH = 0.6;
/**
 * Bulkheads triangulated at the sedan's 1.0 m reach: the rear-subframe
 * stations. At 0.6 m the rear axle's anchor ring was torsionally soft and
 * the 195 km/h full-throttle straight grew a ±0.3 rad/s yaw weave
 * (compliance steer, cf. the sedan's REAR_LINK_FACTOR note).
 */
const FULL_BULKHEADS: readonly number[] = [9];
const FULL_BULKHEAD_REACH = 0.7;
/** Non-bulkhead stations braced in-plane at BULKHEAD_REACH (traffic): the rear axle ring s10 (rear subframe anchors, toe stiffness). */
const BRACED_STATIONS: readonly number[] = [10];
/** Bumper faces (s0, s13): rigid beams of their own, triangulated at this reach. */
const BUMPER_REACH = 0.5;
/** Bulkheads aft of the B-pillar and the rear bumper face (traffic: ≈ 1300 beams; the front keeps its reach for the crush). */
const REAR_BULKHEAD_REACH = 0.45;
const REAR_BUMPER_REACH = 0.4;
const reachOf = (station: number): number =>
  FULL_BULKHEADS.includes(station)
    ? FULL_BULKHEAD_REACH
    : station === 0
      ? BUMPER_REACH
      : station === 13
        ? REAR_BUMPER_REACH
        : station >= 7
          ? REAR_BULKHEAD_REACH
          : BULKHEAD_REACH;
/**
 * Extra cage members: the B-pillar hoop's roof centre s7_rf (the frame top)
 * to the pillar tops. Without the door stations' roof centres it hung on two
 * near-collinear roof links and sagged 17 cm at rest.
 */
const EXTRA_CAGE: readonly (readonly [string, string])[] = [
  ['s7_rf', 's7_bt_R'],
  ['s7_rf', 's7_bt_L'],
];
/**
 * Sedan nodes the traffic rig does not have (T2 re-points their panels):
 * the cabin floor-pan nodes between tunnel and sill at the door stations
 * (the floor spans tunnel → sill directly; the bulkheads s5 / s9 keep
 * theirs) and the roof-centre nodes of the door stations (the B-pillar
 * hoop's s7_rf is the frame top and stays).
 */
const OMIT: ReadonlySet<string> = new Set(['s7_fl_R', 's7_fl_L']);
/**
 * Stations the traffic rig leaves out entirely (≈ 1300-beam target): the two door stations either side of
 * the B-pillar. The cage runs s5 (A-pillar / firewall) → s7 (B-pillar hoop) → s9 (rear-seat bulkhead), one
 * 0.6–0.7 m bay each, and those bays link station to station like any other gap; the doors bind to the
 * pillars and sills (T2 re-points their panels). A traffic car is struck in the doors by the player only.
 */
export const SKIP_STATIONS: ReadonlySet<number> = new Set([6, 8, 11, 12]);
/**
 * CRUSH CANS (traffic rig): one plastic member per front rail flange from the crash-can tips (s1) back to
 * the rail at the towers (s3), at a low crush force. Without them the bay folded over the firewall in a
 * frontal, so how much of the fold stayed after the rebound decided the crush: 25–95 cm from ±5 % speed or
 * a 10 % offset. The cans tie the front rails into one column that crushes progressively: 50 km/h frontal
 * 40.4–41.7 cm from 47.5 to 52.5 km/h, 40.8 cm at 90 % overlap (sedanTraffic.test.ts).
 */
const K_CRUSH_CAN = 4e5;
const CRUSH_CAN_YIELD = 5e3;
const CRUSH_CAN_TO = 3;
/** Per-node (Σd/m)·dt target of the generator (validator limit 1). */
const DAMP_BUDGET = 0.95;
/** Open (bay) sections: cross-car braces between the two sides up to this length, m. */
const BAY_CROSS_REACH = 1.0;
/**
 * Longitudinal members (rails, sills, roof rails, tunnel) take this many
 * times a diagonal's share of each node's budget: bending stiffness lives in
 * them, shear only needs the diagonals.
 */
const LONGITUDINAL_W = 4;
/**
 * GAP DIAGONALS (traffic rig): each node links to its nearest node of the
 * next station both ways (the longitudinal members), and every ring edge
 * gets ONE shear diagonal, from its inboard end (smaller |x|, then lower) to
 * the other end's twin: mirror-symmetric, every skin quad triangulated, ≈ 2
 * beams per node and gap instead of the sedan's ≈ 2.7 (nearest 3 both ways).
 */
const LINKS_PER_NODE = 1;
/**
 * …except the front crumple zone (gaps s0→s5), which keeps nearest-N links
 * per gap (+ the diagonals): with single diagonals there the 50 km/h
 * frontal crushed ~1 m (peak 1.2 m: the bay sheared and folded), with the
 * sedan's 3 it measured 36 cm (peak 63).
 */
const GAP_LINKS: readonly number[] = [2, 2, 2, 2, 2];

/*
 * Tags: bl/bo/bu bumper lower/outer/upper · rl/rh crash rail low/high ·
 * fd fender top · rs/rt radiator support bottom/top · tw shock tower ·
 * tn tunnel · fl floor · sl sill · hp hinge pillar · cw cowl (A-pillar base) ·
 * fw firewall · dm door mid · bt belt line · rf roof (rail / centre) ·
 * qm quarter mid · dk rear deck (C-pillar base) · tf trunk floor ·
 * qt quarter top · ld trunk lid.
 */
/** Base mass of the bay rail nodes (s3, s4 rl/rh), kg: they carry the engine's share of the mass (the traffic rig has no engine block: all of it). */
const RAIL_BASE = 50;
const STATIONS: readonly Station[] = [
  // 0 front bumper face
  { z: -2.3, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 10, bo: 6, bu: 10 },
    ring: [['bl', 0, 0.3], ['bl', 0.4, 0.3], ['bo', 0.74, 0.42], ['bu', 0.4, 0.5], ['bu', 0, 0.5]] },
  // 1 crash-can tips
  { z: -2.04, closed: false, bulkhead: false, cls: 'crash', mass: { rl: 20, rh: 20, fd: 6 },
    ring: [['rl', 0.42, 0.28], ['rh', 0.42, 0.5], ['fd', 0.74, 0.64]] },
  // 2 radiator support (bulkhead)
  { z: -1.72, closed: true, bulkhead: true, cls: 'crash', mass: { rs: 8, rl: 30, rh: 30, fd: 6, rt: 8 },
    ring: [['rs', 0, 0.26], ['rl', 0.42, 0.28], ['rh', 0.42, 0.52], ['fd', 0.79, 0.74], ['rt', 0, 0.76]] },
  // 3 front axle: shock towers
  { z: Z_F, closed: false, bulkhead: false, cls: 'bay', mass: { rl: RAIL_BASE, rh: RAIL_BASE, tw: 8, fd: 5 },
    ring: [['rl', 0.42, 0.28], ['rh', 0.42, 0.54], ['tw', 0.56, 0.88], ['fd', 0.82, 0.82]] },
  // 4 engine bay rear
  { z: -1.06, closed: false, bulkhead: false, cls: 'bay', mass: { rl: RAIL_BASE, rh: RAIL_BASE, fd: 5 },
    ring: [['rl', 0.43, 0.26], ['rh', 0.44, 0.54], ['fd', 0.84, 0.88]] },
  // 5 firewall / cowl / A-pillar base (bulkhead)
  { z: -0.8, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 16, fl: 22, sl: 18, hp: 12, cw: 9, fw: 16 },
    ring: [['tn', 0, 0.34], ['fl', 0.42, 0.2], ['sl', 0.86, 0.22], ['hp', 0.87, 0.62], ['cw', 0.74, 0.98], ['cw', 0, 1.0]],
    extra: [['fw', 0.4, 0.68]] },
  // 6 front door / A-pillar top (windshield header)
  { z: -0.32, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 8, fl: 13, sl: 9, dm: 6, bt: 6, rf: 4 },
    ring: [['tn', 0, 0.34], ['fl', 0.42, 0.17], ['sl', 0.86, 0.2], ['dm', 0.88, 0.6], ['bt', 0.86, 0.98], ['rf', 0.64, 1.4], ['rf', 0, 1.44]] },
  // 7 B-pillar hoop (bulkhead + cross-cabin cage diagonals)
  { z: 0.15, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 8, fl: 13, sl: 9, dm: 6, bt: 6, rf: 4 },
    ring: [['tn', 0, 0.34], ['fl', 0.42, 0.17], ['sl', 0.86, 0.2], ['dm', 0.88, 0.6], ['bt', 0.86, 0.98], ['rf', 0.66, 1.43], ['rf', 0, 1.46]] },
  // 8 rear door / C-pillar top
  { z: 0.62, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 8, fl: 13, sl: 9, dm: 6, bt: 6, rf: 4 },
    ring: [['tn', 0, 0.34], ['fl', 0.42, 0.18], ['sl', 0.86, 0.2], ['dm', 0.88, 0.6], ['bt', 0.86, 0.98], ['rf', 0.62, 1.39], ['rf', 0, 1.42]] },
  // 9 rear seat bulkhead / C-pillar base (fuel tank under the seat)
  { z: 1.1, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 12, fl: 12, sl: 8, qm: 6, dk: 5 },
    ring: [['tn', 0, 0.32], ['fl', 0.46, 0.28], ['sl', 0.84, 0.28], ['qm', 0.86, 0.62], ['dk', 0.76, 0.98], ['dk', 0, 1.0]] },
  // 10 rear axle: rear shock towers
  { z: Z_R, closed: true, bulkhead: false, cls: 'bay', mass: { tf: 7, rl: 7, rh: 7, tw: 8, qt: 5, ld: 3 },
    ring: [['tf', 0, 0.34], ['rl', 0.48, 0.32], ['rh', 0.48, 0.54], ['tw', 0.6, 0.84], ['qt', 0.84, 0.92], ['ld', 0.6, 1.0], ['ld', 0, 1.02]] },
  // 11 trunk
  { z: 1.8, closed: true, bulkhead: false, cls: 'crash', mass: { tf: 7, rl: 5, rh: 5, qt: 4, ld: 3 },
    ring: [['tf', 0, 0.36], ['rl', 0.48, 0.34], ['rh', 0.48, 0.54], ['qt', 0.84, 0.92], ['ld', 0.6, 0.99], ['ld', 0, 1.0]] },
  // 12 rear panel / crash cans (bulkhead)
  { z: 2.12, closed: true, bulkhead: true, cls: 'crash', mass: { tf: 10, rl: 12, rh: 12, qt: 5, ld: 4 },
    ring: [['tf', 0, 0.38], ['rl', 0.48, 0.36], ['rh', 0.48, 0.56], ['qt', 0.8, 0.86], ['ld', 0.58, 0.96], ['ld', 0, 0.97]] },
  // 13 rear bumper face
  { z: 2.4, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 10, bo: 6, bu: 10 },
    ring: [['bl', 0, 0.34], ['bl', 0.44, 0.34], ['bo', 0.76, 0.46], ['bu', 0.42, 0.54], ['bu', 0, 0.54]] },
];
/**
 * Axial yield force of each SAFETY-CELL station gap g (station g → g+1,
 * cage-class links), N; see CRASH SECTIONS in the generator. Set far above
 * any frontal's section force (~250–400 kN), so the cell stays elastic
 * while the crumple zones (strain-yield classes, 0 here) fold.
 */
const GAP_YIELD: readonly number[] = [0, 0, 0, 0, 0, 1.2e6, 1.2e6, 1.2e6, 1.2e6, 400e3, 0, 0, 0];
/**
 * Load-path members that change tag across a gap ([gap, front tag, rear
 * tag], same side) get the longitudinal stiffness share like same-tag
 * rails: bumper beam → crash cans, bay rails → floor rails / firewall, the
 * fender (apron) rail → A-pillar, rear floor → rear rails.
 */
/**
 * A gap's shear diagonals yield at no less than this fraction of the axial
 * members' yield travel (deform = k·δ_g·max(cz, floor)): with pure cz
 * scaling the near-transverse diagonals yielded first and the bay crushed
 * by SHEARING sideways (stations sliding past each other) at a fraction of
 * its axial capacity.
 */
const SHEAR_YIELD_FLOOR = 0.8;
/** …and at no less than this fraction of a longitudinal member's yield force. */
const SHEAR_FORCE_SHARE = 0.6;
/** In-station members yield at this multiple of the adjacent gaps' yield travel. */
const IN_STATION_YIELD_FACTOR = 3;
/** Window glass breaks (shatters) at this strain; elastic below. */
const GLASS_BREAK_STRAIN = 0.03;
/**
 * Door skins/frames: the bays either side of the B-pillar's door-mid and belt nodes (s7 dm / bt to the
 * A- and C-pillar stations: the door stations are SKIP_STATIONS) yield at this strain, so a side impact
 * dents the doors plastically.
 */
const DOOR_YIELD_STRAIN = 0.05;
const DOOR_MIN_DEFORM = 4e3;
const DOOR_NODES = /^s7_(dm|bt)_/;
/**
 * Firewall panel node (s5_fw_*, the engine side of the bulkhead): its
 * links yield like the bay. As part of the never-yielding cell bulkhead it
 * acted as a trampoline: the engine/gearbox block pushed it ~34 cm back
 * elastically and it threw the whole front forward again (springback).
 */
const FIREWALL_PANEL = /^s5_fw_/;
/**
 * Bumper beam ↔ crash-can links (the boundary of the s0 / s13 bulkheads):
 * brittle relative to their yield, so a hard hit tears the bumper off.
 */
const BUMPER_MOUNT_BREAK_RATIO = 3;
const isBumperMount = (a: string, b: string): boolean => /^s(0|13)_/.test(a) !== /^s(0|13)_/.test(b);
const LOAD_PATH_CONTINUATIONS: readonly (readonly [number, string, string])[] = [
  [0, 'bl', 'rl'],
  [0, 'bu', 'rh'],
  [4, 'rl', 'fl'],
  [4, 'rh', 'fw'],
  [4, 'fd', 'hp'],
  [4, 'fd', 'cw'],
  [9, 'fl', 'rl'],
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
 * from bulkhead to bulkhead, plus X diagonals across each door frame.
 * WHY: the per-node ω·dt budget keeps each cabin segment soft (sill ≈ 4e5
 * N/m per 0.48 m), and a chain of soft segments folded: a 50 km/h frontal
 * V-folded the floor at the front doors and tented the roof (the front's
 * ~250 kN crush force acts below the cabin's centre of mass). A member
 * spanning the door opening costs its end nodes the same budget as one
 * segment but is not in series with the mid-door nodes, so the cell keeps
 * its length and shape while the ends crush.
 */
const CABIN_SPANS: readonly (readonly [number, string, number, string])[] = [
  [5, 'sl', 7, 'sl'],
  [7, 'sl', 9, 'sl'],
  [5, 'fl', 7, 'fl'],
  [7, 'fl', 9, 'fl'],
  [5, 'tn', 7, 'tn'],
  [7, 'tn', 9, 'tn'],
  [5, 'cw', 7, 'rf'],
  [7, 'rf', 9, 'dk'],
  [5, 'sl', 7, 'bt'],
  [5, 'hp', 7, 'sl'],
  [7, 'sl', 9, 'dk'],
  [7, 'bt', 9, 'sl'],
];
/** Cabin spans yield only at this strain (they carry the frontal crush force past the doors elastically). */
const CABIN_SPAN_YIELD_STRAIN = 0.25;
const SPAN_KEYS = new Set(
  CABIN_SPANS.flatMap(([i, ta, j, tb]) => [`s${i}_${ta}|s${j}_${tb}`]),
);
/** Both endpoints match a CABIN_SPANS entry (side suffix ignored). */
const isCabinSpan = (a: string, b: string): boolean => {
  const base = (id: string): string => id.replace(/_[LR]$/, '');
  return SPAN_KEYS.has(`${base(a)}|${base(b)}`) || SPAN_KEYS.has(`${base(b)}|${base(a)}`);
};
/** B-pillar hoop / rear bulkhead: cross-cabin cage diagonals (tag a on one side → tag b on the other). */
const CROSS_CABIN: readonly (readonly [number, string, string])[] = [
  [5, 'cw', 'sl'],
  [7, 'rf', 'sl'],
  [7, 'bt', 'fl'],
  [9, 'dk', 'fl'],
];

// ====================================================================== suspension geometry
/**
 * Per corner (right side; mirrored), RoR-style with the hub nodes as the
 * upright: the wheel's hubI/hubO plus ONE body node kU (upright top) bolted
 * to both hubs (WheelDef.attach = [kU] → hubI–kU, hubO–kU) form a rigid
 * triangle (6 DOF). Constraints:
 *   lower A-arm  hubI → 2 pivots (fore/aft)   2
 *   upper A-arm  kU   → 2 pivots (fore/aft)   2
 *   toe link     hubO → 1 pivot, fore-aft     1   (front: tie-rod HYDRO)
 * = 5, leaving exactly 1 DOF: wheel travel. The steering/toe axis is the
 * line hubI → kU (near-vertical, 6.6° caster at the front). The arms are
 * level at ride height and form a near-parallelogram (≈0.29 m, A-arm
 * pivots ±0.28–0.3 m fore/aft for caster/brake stiffness): the upright
 * translates vertically, so there is no first-order track change (tyre
 * scrub added ~1.5e4 N/m of fake heave rate with inclined arms) or camber
 * change (a short upper arm swung 40° and flipped the upright at full dive
 * in the drivetrain integration test). The toe link acts on
 * hubO, 0.18 m off that axis, along the direction hubO moves when the
 * upright yaws, so drive/brake forces at the contact patch (≈ 0.1 m scrub
 * lever) can only toe the wheel through the link's own compliance (< 1°
 * at 7 kN, see sedan.test.ts). The link is horizontal and perpendicular
 * to the travel arc, so bump steer is second order.
 * Shock: hubI → tower. Anti-roll: crossed beams hubI(L)–kU(R),
 * kU(L)–hubI(R); heave leaves their length unchanged, roll stretches them,
 * and both ends sit on the steering axis so steering never loads them.
 */
/**
 * Hub node spacing along the axle, m (tyre rings stay at centre ± width/2).
 * Lateral tyre force F at the ground makes a camber moment F·r on the
 * wheel that reaches the upright only as a vertical couple on the two hub
 * nodes: M/spacing. A sliding car (8 kN lateral, 2.6 kN·m) put ±17 kN on
 * hubs 0.15 m apart and flipped the upright; 0.24 m cuts the couple by
 * 1.6× and dishes the spokes (laterally stiffer wheel). Wider spacing
 * softens the tyre radially (0.30 m: +15 mm static squish).
 */
const HUB_SPACING = 0.24;
/**
 * Fore-aft reach of the tie rod (front, pivot behind the wheel) and toe
 * link (rear, pivot ahead), m. The link pivot is the third corner of the
 * subframe triangle with the two lower-arm pivots (0.56 m inboard, ±0.3 m
 * fore/aft): at 0.7 / 0.6 m reach both of its subframe edges ran within
 * 22–30° of each other, so the pivot was soft across them and lateral
 * load moved it ~2 mm fore-aft relative to the arm pivots (front wheels
 * steered INTO the turn, ≈ 0.5°/g even with the rigid subframe). At
 * 0.35 m the edges are ~45° apart and lateral-force compliance steer is
 * ≈ 0.4°/g OUT of the turn (understeer; static lateral-gravity bench).
 */
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
const FRONT: CornerGeom = {
  z: Z_F,
  kU: [0.66, 0.58, Z_F + 0.03],
  // R-PHYS: the UPPER arm's pivot axis inclined ≈ 6° in side view (front pivot up; the lower arm — a crash-path
  // subframe member — untouched) puts the side-view IC behind the wheel: anti-dive ≈ −35 % (pro-dive) → ≈ 20 %;
  // the tie-rod geometry is unchanged (bump steer −0.125 °/cm, toe-out in bump; realism/suspension.test.ts)
  lowerPivots: [[0.34, Y_W, Z_F - 0.3], [0.34, Y_W, Z_F + 0.28]],
  upperPivots: [[0.37, 0.58 + 0.031, Z_F - 0.28], [0.37, 0.58 - 0.031, Z_F + 0.28]],
  linkPivot: [HALF_TRACK + HUB_SPACING / 2, 0.32, Z_F + LINK_REACH],
  towerStation: 3,
};
const REAR: CornerGeom = {
  z: Z_R,
  kU: [0.66, 0.58, Z_R],
  lowerPivots: [[0.34, Y_W, Z_R - 0.3], [0.34, Y_W, Z_R + 0.3]],
  upperPivots: [[0.37, 0.58, Z_R - 0.28], [0.37, 0.58, Z_R + 0.28]],
  // R-PHYS: toe link 0.6 cm above the hub: bump steer +0.134 → ≈ +0.09 °/cm (toe-in in bump: roll understeer, ≤ 0.1 °/° of roll)
  linkPivot: [HALF_TRACK + HUB_SPACING / 2, 0.326, Z_R - LINK_REACH],
  towerStation: 10,
};

/** Upright-top node mass, kg (unsprung). */
const KNUCKLE_NODE_MASS = 7.5;
/**
 * SUBFRAME. Per axle, the two lower-arm pivots and the tie-rod / toe-link
 * pivot of each side, plus the L–R cross members (straight + X), are tied
 * by FIXED K_SUBFRAME beams into one planar frame that is mounted to the
 * body by each pivot's 4 auto anchor beams. Before, those links were auto
 * beams of ~1.2e5 N/m (the pivots' budgets went to the arm/link beams):
 * the pivots moved 3–5 mm relative to each other at 0.5 g (static bench,
 * lateral gravity), steering the front wheels INTO the turn by ≈ 1.8°/g —
 * compliance oversteer that took the understeer gradient to ≈ 0 and made
 * the car weave and spin at ≈ 205 km/h with or without drive (a neutral
 * downhill run at a steady 210 km/h diverged in 5 s; rigid subframe:
 * |r| ≤ 0.001 rad/s). The toe scrub also cost high-speed drag.
 * Pivot masses carry the fixed beams at SUBFRAME_BUDGET_SHARE of the node
 * budget, the rest for the anchors; they are fixed (outside the CG/axle
 * mass solve, which would scale them below that budget).
 */
const K_SUBFRAME = 1e6;
/** Body anchors per subframe-triangle pivot (sedan 4; 3 non-coplanar bars already fix a point). */
const SUBFRAME_ANCHORS = 3;
/** Body anchors per upper-arm pivot (sedan 4). */
const UPPER_ANCHORS = 3;
const SUBFRAME_BUDGET_SHARE = 0.7;
const SUBFRAME_DEFORM = 9e4;
const SUBFRAME_BREAK = 1.8e5;
const subframePivotMass = (fixedK: number): number => round(fixedK / (BUDGET_PER_KG * SUBFRAME_BUDGET_SHARE), 2);
/** Base mass of the upper-arm pivot nodes, kg (before the mass solve). */
const PIVOT_NODE_MASS = 7;
/**
 * Fixed suspension stiffnesses, N/m. Budgets (ω·dt ≤ 0.35, Σk ≤ 4.9e5·m):
 * hub node 15 kg: wheel beams ≈ 1.6e6 + attach 9e5 + axle stub 1.2e6 +
 * lower arm 2·1.2e6 + shock + ARB (hubI) or toe link 1.5e6 (hubO) → ω·dt ≤ 0.35;
 * kU 7.5 kg: 2·9e5 + 2·8e5 + ARB (checked by sedan.test.ts).
 */
const K_LOWER_ARM = 1.2e6;
const K_UPPER_ARM = 8e5;
const K_TOE_LINK = 1.5e6;
const K_AXLE_STUB = 1.2e6;
const ATTACH_SPRING = 9e5;
/**
 * Rear hub-link stiffness factor (axle stub, lower arm, toe link, ARB,
 * upright attach). At 1× the driven rear upright's compliance let a
 * straight full-throttle run grow a ~0.7 Hz yaw weave from 120 km/h up
 * (spun at 185 km/h; coasting, open diff, TC off, brush off all still did
 * it); 2× is stable to v_max (handling.test.ts high-speed run).
 */
const REAR_LINK_FACTOR = 2;
const linkFactor = (front: boolean): number => (front ? 1 : REAR_LINK_FACTOR);
/**
 * Hub / knuckle node masses per axle: the rear ones carry REAR_LINK_FACTOR×
 * the link stiffness (the hubs' wheel beams do not scale, so 0.81 of it).
 */
const hubMass = (front: boolean): number => WHEEL_HUB_MASS * (front ? 1 : REAR_LINK_FACTOR * 0.81);
const knuckleMass = (front: boolean): number => KNUCKLE_NODE_MASS * linkFactor(front);
const ATTACH_DAMP = 300;
const D_ARM = 400;
/** Anti-roll: ARB roll rate at the wheel as a fraction of the axle's spring wheel rate. */
const ARB_FRACTION_FRONT = 0.5;
const ARB_FRACTION_REAR = 0.25;
/**
 * The soft-body quarter car (soft tyre carcass in series, ground penalty,
 * link compliance) shows ≈ 0.55× the damping ratio of the rigid-link
 * estimate in the heave decay test (sedan.test.ts; measured ζ scales
 * linearly with shock d), so damper rates carry this calibration to land
 * at ζ ≈ 0.3. 1.9 → 1.6 in P4: the crash-tuned shell (ζ 0.4 crumple zones,
 * heavier bay rails) adds its own heave damping (decay ratio fell to 0.21).
 */
const DAMPER_CALIBRATION = 1.6;

/** Wheel: 205/55R16-class tuning (wheelrig.ts) with a heavy hub carrier (upright + brakes): 15 kg per hub node. */
const WHEEL_HUB_MASS = 30;

// ====================================================================== rests
/** Trunk-lid rests (the sedan's P5 rests; the sedan's hood class numbers). */
const REST = { zeta: 0.5, restBreak: 1.5e4 } as const;

/** Trunk-lid centre rest stiffness per rest, N/m (2 rests ≈ 13 % of s11_ld's ω·dt budget). */
const TRUNK_REST_K = 1e5;

// ====================================================================== drivetrain
/**
 * 3.0 L I6: 350 N·m held from 3500 to 6500 rpm, ≈ 238 kW at 6500–6800 rpm
 * (a ~250 kW-class sports-sedan engine; the old curve fell to 315 N·m at
 * 6000 rpm, ~200 kW, and could not hold 200 km/h against drag + rolling).
 */
const DRIVETRAIN: DrivetrainDef = {
  // R-PHYS: halfshaft / CV strength ≈ 2.2 × the peak 1st-gear wheel torque per side (as the sedan)
  halfshaftBreakTorque: 5100,
  // R-PHYS engine systems (engineSystems.ts): fuel, cooling, oil, stall / starter
  engine: { displacementL: 3.0, fuel: 'petrol', tankL: 60 },
  torqueCurve: [
    [0, 180],
    [800, 210],
    [1500, 270],
    [2000, 305],
    [2500, 330],
    [3000, 345],
    [3500, 350],
    [6500, 350],
    [6800, 335],
    [7200, 260],
  ],
  idleRpm: 800,
  redlineRpm: 6800,
  revLimitRpm: 7000,
  engineInertia: 0.18,
  engineBrakeTorque: 60,
  // R-PHYS: 6th 0.8 → 0.68 overdrive (6-speed automatics run ≈ 0.67–0.69): 2270 rpm at 100 km/h instead of 2670
  gearRatios: [3.9, 2.4, 1.7, 1.3, 1.0, 0.68],
  reverseRatio: 3.6,
  finalDrive: 3.4,
  shiftTimeS: 0.25,
  // Torque holds 350 N·m to 6500 rpm: 5th out-pulls 6th up to the 7000
  // limiter, so full-throttle upshifts go just below it (at 6300 the box
  // dropped into 6th at ~195 km/h, 190 kW instead of 5th's 240 kW, and
  // never kicked back down).
  autoShiftUpRpm: 6900,
  autoShiftDownRpm: 2600,
  diff: 'limited',
  diffLockTorque: 400,
  // R-PHYS: clutch-pack LSD (Salisbury): 80 N·m preload, 40 % power / 25 % coast locking (TBR 2.3 / 1.7)
  lsd: { preload: 80, powerRamp: 0.4, coastRamp: 0.25 },
  clutchMaxTorque: 550,
  transmission: 'auto',
  // Driven-wheel excess slip over the undriven reference before TC cuts in.
  // The soft tyre needs ~8 % rear slip to put 4 kN down at 200 km/h (and
  // the free-rolling fronts read ≈ −3 % there), so 0.08 cut throttle on a
  // dry straight and capped the car at ~185 km/h.
  tractionControl: 0.14,
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

/** Design numbers derived while generating (documented, asserted by sedan.test.ts). */
export interface SedanTrafficDesign {
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
 * f_r = 0.01·(1 + V/160 km/h) (Wong, "Theory of Ground Vehicles" eq. 1.12), per unit load, every 10 km/h
 * of tread speed from 0 — measured by coasting this car in neutral (realism/coastdown calibration), kept
 * conservative (0.85 × the lower of the bin and its neighbours' mean) so it never propels a coasting car.
 */
export const SEDAN_TRAFFIC_ROLLING_LOSS: readonly number[] = [0, 0.003, 0.0026, 0.0044, 0.0067, 0.0095, 0.024, 0.0096, 0.0107, 0.0164, 0.0244, 0.0501, 0.0591, 0.0929, 0.1153, 0.1361, 0.1543, 0.0974, 0.0875, 0.0641, 0.1091, 0.1022, 0.1022];

function buildSedanTraffic(): { def: VehicleDef; design: SedanTrafficDesign } {
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
      if (m === undefined) throw new Error(`sedanTraffic: station ${i} has no mass for tag ${tag}`);
      const sides: (Side | undefined)[] = x === 0 ? [undefined] : ['R', 'L'];
      for (const s of sides) {
        if (OMIT.has(sid(i, tag, s)) || SKIP_STATIONS.has(i)) continue;
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
    const bottom = first[1] === 0 && pos.has(sid(i, first[0])) ? [sid(i, first[0])] : [];
    const top = last[1] === 0 && pos.has(sid(i, last[0])) ? [sid(i, last[0])] : [];
    // Open sections (engine bay) keep the two sides as separate paths.
    stationRing.push(st.closed ? [[...bottom, ...right, ...top, ...left.reverse()]] : [right, left]);
  });

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

  // ---- wheels
  const unsprungWheelOf = (front: boolean): number => hubMass(front) + WHEEL_TUNING_TRAFFIC_10.rimMass + WHEEL_TUNING_TRAFFIC_10.tireMass;
  const unsprungCornerOf = (front: boolean): number => unsprungWheelOf(front) + knuckleMass(front);
  const wheel = (id: 'FL' | 'FR' | 'RL' | 'RR'): WheelDef => {
    const front = id[0] === 'F';
    const s: Side = id[1] === 'L' ? 'L' : 'R';
    const c = corners.get(id)!;
    return {
      ...WHEEL_TUNING_TRAFFIC_10,
      rollingLossComp: SEDAN_TRAFFIC_ROLLING_LOSS,
      hubMass: hubMass(front),
      id,
      hubInner: pos.get(c.hubI)!,
      hubOuter: pos.get(c.hubO)!,
      axle: front ? 'front' : 'rear',
      steered: front,
      driven: !front,
      braked: true,
      // 60/40 bias: front wheels reach 2500 N·m, rear 2500·0.4/0.6 ≈ 1667 N·m.
      brakeTorqueMax: 2500,
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
   *   Σm·z = M_total·z_cg − Σ_fixed m·z,  z_cg = Z_R − 0.52·wheelbase (52/48 static split),
   *   Σm·y = M_total·y_cg − Σ_fixed m·y.
   */
  {
    const M = SEDAN_TRAFFIC_TARGETS.totalMass;
    const zcg = Z_R - SEDAN_TRAFFIC_TARGETS.frontAxleShare * SEDAN_TRAFFIC_TARGETS.wheelbase;
    const ycg = SEDAN_TRAFFIC_TARGETS.cgHeight;
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
      if (!(m > 0.5)) throw new Error(`sedanTraffic: mass solve gave ${m} kg for ${n.id}`);
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
  const wheelRate = { front: wheelRateFor(sprungFront, SEDAN_TRAFFIC_TARGETS.rideHzFront), rear: wheelRateFor(sprungRear, SEDAN_TRAFFIC_TARGETS.rideHzRear) };

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
    if (seen.has(k)) throw new Error(`sedanTraffic: duplicate beam ${k}`);
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
    if (SKIP_STATIONS.has(i)) return;
    const paths = stationRing[i]!;
    const ring = paths.flat();
    // Ring edges.
    for (const path of paths) for (let k = 0; k + 1 < path.length; k++) link(path[k]!, path[k + 1]!, st.cls);
    if (st.closed) link(ring[ring.length - 1]!, ring[0]!, st.cls);
    // Bulkhead: in-plane triangulation.
    const ids = stationIds[i]!;
    if (st.bulkhead || BRACED_STATIONS.includes(i)) {
      for (let p = 0; p < ids.length; p++)
        for (let q = p + 1; q < ids.length; q++) if (dist(ids[p]!, ids[q]!) <= reachOf(i)) link(ids[p]!, ids[q]!, st.cls);
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
    let ni = i + 1;
    while (SKIP_STATIONS.has(ni)) ni++;
    const next = stationIds[ni];
    if (next === undefined) return;
    // The firewall gap (bay → cage) belongs to the crumple zone: its rails
    // fold onto the firewall instead of loading the cell.
    const fw = st.cls !== 'cage' && STATIONS[ni]!.cls === 'cage';
    const cls: BeamClass = !fw && (STATIONS[ni]!.cls === 'cage' || st.cls === 'cage') ? 'cage' : st.cls;
    const pairs: [string, string][] = [];
    const nl = GAP_LINKS[i] ?? LINKS_PER_NODE;
    for (const a of ids) for (const b of nearest(a, next, nl)) pairs.push([a, b]);
    for (const b of next) for (const a of nearest(b, ids, nl)) pairs.push([a, b]);
    // One shear diagonal per ring edge (see GAP DIAGONALS).
    const twin = (a: string): string => nearest(a, next, 1)[0]!;
    for (const path of paths) {
      const edges: [string, string][] = [];
      for (let k = 0; k + 1 < path.length; k++) edges.push([path[k]!, path[k + 1]!]);
      if (st.closed && path.length > 2) edges.push([path[path.length - 1]!, path[0]!]);
      for (const [p, q] of edges) {
        const tp = twin(p);
        const tq = twin(q);
        if (tp === tq) continue;
        const pp = pos.get(p)!;
        const pq = pos.get(q)!;
        const pInboard = Math.abs(pp[0]) < Math.abs(pq[0]) || (Math.abs(pp[0]) === Math.abs(pq[0]) && pp[1] < pq[1]);
        pairs.push(pInboard ? [p, tq] : [q, tp]);
      }
    }
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
      if (!pos.has(a) || !pos.has(b)) continue;
      link(a, b, 'cage', ta === tb ? LONGITUDINAL_W : 1);
    }
  }
  for (const [a, b] of EXTRA_CAGE) link(a, b, 'cage');
  for (const [i, ta, tb] of CROSS_CABIN) {
    if (!pos.has(sid(i, ta, 'R')) || !pos.has(sid(i, tb, 'R'))) continue;
    link(sid(i, ta, 'R'), sid(i, tb, 'L'), 'cage');
    link(sid(i, ta, 'L'), sid(i, tb, 'R'), 'cage');
  }

  // Suspension pivots → nearest 4 structure nodes; per-axle cross members.
  const bodyPool = stationIds.flat();
  /*
   * Anchors: of the 8 nearest structure nodes pick the 4 whose unit
   * directions span space best (max det Σ ûûᵀ, ties → nearer), so a pivot
   * is never hung off one plane of the rail (soft in the arm's load axis).
   */
  const anchors = (p: string, pool: readonly string[], n: number): string[] => {
    const cand = nearest(p, pool, 8);
    let best: string[] = cand.slice(0, n);
    let bestScore = -Infinity;
    const pick: number[] = [];
    const visit = (from: number): void => {
      if (pick.length === n) {
        const set = pick.map((i) => cand[i]!);
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
        return;
      }
      for (let i = from; i < cand.length; i++) {
        pick.push(i);
        visit(i + 1);
        pick.pop();
      }
    };
    visit(0);
    return best;
  };
  for (const [c, ids] of corners) {
    const z = c[0] === 'F' ? Z_F : Z_R;
    const pool = bodyPool.filter((id) => Math.abs(pos.get(id)![2] - z) < 0.75);
    // Subframe-triangle pivots (lower arms, link) are braced by the rigid
    // subframe: 3 anchors span space; the upper-arm pivots keep 4.
    for (const p of [...ids.lower, ids.link]) for (const n of anchors(p, pool, SUBFRAME_ANCHORS)) link(p, n, 'subframe');
    for (const p of ids.upper) for (const n of anchors(p, pool, UPPER_ANCHORS)) link(p, n, 'subframe');
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
    const P = Fs - k * SEDAN_TRAFFIC_TARGETS.staticSuspensionSag * mr;
    const c = (DAMPER_CALIBRATION * SEDAN_TRAFFIC_TARGETS.dampingRatio * 2 * Math.sqrt(kW * mS)) / (mr * mr);
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
        const d = SEDAN_TRAFFIC_TARGETS.maxWheelAngleRad;
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

  // ---- P5 (U1): trunk-lid centre support rests. Station 11 is an open
  // (non-bulkhead) ring, so the lid centre s11_ld hung on its lid neighbours
  // and sagged 3.4 cm (the trunk floor centre sags with it, so a rest to the
  // floor only got 2.4 cm). Two compression-only rests down to the upper
  // rear rails s11_rh_L/R (45°: a stand-in for the lid's inner frame);
  // elastic, snap at 15 kN like the hood rests. k is a small share of
  // s11_ld's budget (fixed k: the auto beams there shrink to fit).
  for (const side of ['L', 'R'] as const) {
    const st = SKIP_STATIONS.has(11) ? 10 : 11;
    const a = sid(st, 'ld');
    const b = sid(st, 'rh', side);
    const k = TRUNK_REST_K;
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    fix({ a, b, type: 'support', k, d: sig3(2 * REST.zeta * Math.sqrt((k * ma * mb) / (ma + mb))), deform: 0, breakF: REST.restBreak });
  }

  // ---- crush cans (see CRUSH CANS)
  for (const side of ['L', 'R'] as const)
    for (const t of ['rl', 'rh']) {
      const a = sid(1, t, side);
      const b = sid(CRUSH_CAN_TO, t, side);
      const ma = massOf.get(a)!;
      const mb = massOf.get(b)!;
      fix({ a, b, type: 'normal', k: K_CRUSH_CAN, d: sig3(2 * 0.3 * Math.sqrt((K_CRUSH_CAN * ma * mb) / (ma + mb))), deform: CRUSH_CAN_YIELD, breakF: 0 });
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
  for (const b of fixed) {
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
    if (!(budget > 0)) throw new Error(`sedanTraffic: node ${id} has no stiffness budget left`);
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
    if (sa === undefined || sb === undefined || sa === sb) return -1;
    const [lo, hi] = sa < sb ? [sa, sb] : [sb, sa];
    // Consecutive KEPT stations (a skipped station between them does not break the gap).
    for (let k = lo + 1; k < hi; k++) if (!SKIP_STATIONS.has(k)) return -1;
    return lo;
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
    if ((DOOR_NODES.test(a) || DOOR_NODES.test(b)) && stationOf.get(a) !== stationOf.get(b)) {
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
    for (const b of [...autoBeams, ...fixed]) {
      for (const id of [b.a, b.b]) sumD.set(id, (sumD.get(id) ?? 0) + (b.d ?? 0));
    }
    for (const w of wheels) for (const id of w.attach) sumD.set(id, (sumD.get(id) ?? 0) + 2 * (w.attachDamp ?? 0));
    const scale = (id: string): number => {
      const m = massOf.get(id);
      if (m === undefined) return 1;
      const z = (sumD.get(id)! * DT) / m;
      return z > DAMP_BUDGET ? DAMP_BUDGET / z : 1;
    };
    for (const b of autoBeams) {
      const f = Math.min(scale(b.a), scale(b.b));
      if (f < 1) b.d = sig3(b.d! * f);
    }
  }
  const beams = [...autoBeams, ...fixed];
  const def: VehicleDef = {
    name: 'sedanTraffic',
    body: {
      name: 'sedanTraffic.body',
      nodes,
      beams,
      groupDefaults: {
        body: { friction: 0.5, radius: 0.05 },
        subframe: { friction: 0.5, radius: 0.04 },
        knuckle: { friction: 0.5, radius: 0.03 },
      },
    },
    wheels,
    drivetrain: DRIVETRAIN,
    brakes: { frontBias: 0.6, handbrakeTorqueMax: 1500, abs: true, esc: true },
    // R-PHYS: lift per axle (as the sedan; Hucho, "Aerodynamics of Road Vehicles" 1998)
    aero: { dragCoeffArea: 0.65, liftCoeffArea: 0.08, liftFront: 0.06, liftRear: 0.02 },
    // R-PHYS: asymmetric digressive dampers (dampers.ts: rebound 2.6 : 1 bump, knee 0.1 m/s)
    dampers: { front: true, rear: true },
    // R-PHYS steering system (steering.ts): as the sedan
    steering: { maxWheelAngleDeg: round((SEDAN_TRAFFIC_TARGETS.maxWheelAngleRad * 180) / Math.PI, 2), system: { ratio: 15, torsionBarNmPerDeg: 2, assistGain0: 20, assistGainHigh: 0.6, assistSpeed: 6, assistMaxNm: 80, inertia: 0.04 } },
    frame: { origin: sid(7, 'tn'), front: sid(2, 'rs'), top: sid(7, 'rf') },
    // Feel pass: rigid shell cluster (shell.ts) — crumple zones released whole on impact, firewall, safety cell.
    shell: shellLayout({
      front: ['s0_*', 's1_*', 's2_*', 's3_*', 's4_*', 'FL_*', 'FR_*'],
      rear: ['s10_*', 's13_*', 'RL_*', 'RR_*'],
      firewall: ['s5_*'],
      cell: ['s5_hp_*', 's5_sl_*', 's7_*', 's9_*'],
    }),
  };
  const design: SedanTrafficDesign = {
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

const BUILT = buildSedanTraffic();

/** The traffic sedan VehicleDef (plain JSON). Wheels FL, FR, RL, RR. */
export const SEDAN_TRAFFIC: VehicleDef = BUILT.def;
/** Derived design numbers (mass/CG solve, suspension rates) for tests and tuning UIs. */
export const SEDAN_TRAFFIC_DESIGN: SedanTrafficDesign = BUILT.design;

/**
 * Crash-harness node sets (crash.ts runCrash `probes`): the sedan's, minus
 * the nodes this rig omits (cabin reference = B-pillar sills + tunnel) and
 * the hood (no latch).
 */
export const SEDAN_TRAFFIC_CRASH_PROBES: CrashProbes = {
  front: ['s1_rl_*', 's1_rh_*'],
  cabin: ['s7_sl_*', 's7_tn'],
  firewall: ['s5_fl_*', 's5_sl_*', 's5_hp_*', 's5_cw_*'],
  cellRear: ['s9_*'],
  cellFront: ['s5_*'],
  doorMid: ['s7_dm_*'],
  doorR: 's7_dm_R',
  doorL: 's7_dm_L',
  sillR: 's7_sl_R',
  sillL: 's7_sl_L',
  exemptPrefixes: ['s0_', 's13_'],
  latch: [],
  bumperPrefix: 's0_',
  windscreen: ['s5_cw', 's7_rf'],
};
