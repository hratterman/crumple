/**
 * PICKUP — full-size crew-cab pickup (5.0 L V8, 6-speed auto, RWD, LSD),
 * body-on-frame (docs/CONTRACTS.md "P6 contracts", fleet targets F2).
 *
 * PURE DATA MODULE (P2 boundary amendment): main-thread code may import it.
 * Generated once at module load by a deterministic procedure (no RNG, fixed
 * iteration order). Adapted from defs/sedan.ts (never imported from it).
 *
 * Vehicle frame: up +Y, forward −Z, right +X. Ground y = 0, tyres just
 * touching in the rest pose (wheel centres at y = WHEEL_RADIUS).
 *
 * STRUCTURE — five separate sub-structures, each a chain of cross-section
 * stations (right half authored, mirrored), tied together only by
 * breakable MOUNT beams, so in a crash they shift and tear relative to each
 * other:
 *   frame  `f{i}_{lo|hi}_{L|R}` ladder frame, f0 (horn tips, z −2.72) …
 *          f11 (rear crossmember + hitch, z +3.00), kicked up over the rear
 *          axle; front shock towers f3_tw, rear spring towers f9_tw.
 *   clip   `s{i}_*` front clip (radiator support s0, fender / apron s1, s2)
 *          on the frame horns; its rear ties to the cab cowl by fender bolts.
 *   cab    `c{i}_*` crew cab, c0 cowl / firewall (A-pillar bases `c0_ap_*`, cowl
 *          centre `c0_cw`) … c4 back wall: the safety
 *          cell (sedan-style rings, cabin spans, cross-cabin diagonals) on 6
 *          body mounts.
 *   bed    `b{i}_*` b0 front wall … b3 rear posts, on 6 bed mounts.
 *   tailgate `tg_{0|1}{L|C|R}{i|o}` a two-layer 2 × 3 grid hinged at the
 *          bed sill, latched at the post tops.
 * plus the hood sub-rig `hood_{r}{L|C|R}` (sedan contract layout), the front
 * bumper `bf_*` and rear bumper `br_*` + `hitch` on the frame ends, the V8
 * block `eng_*` / gearbox `gbx_*` on frame mounts.
 *
 * SUSPENSION — front: long-travel double wishbone per corner (sedan corner
 * kinematics, rigid subframe, hydro tie rods). Rear: a LIVE AXLE — the two
 * rear uprights, the diff node `axD` and two spring brackets `R{L,R}_ab` form
 * one rigid body, located by two lower and two upper trailing links (the
 * leaf springs' front eyes) and a Panhard rod; coil-over "leaf" springs
 * from the brackets to the frame spring towers.
 */
import { SHELL_RELEASE_FRAME, shellLayout } from '../shellDefs';
import type { RigBeamDef, RigNodeDef } from '../../rig/types';
import { wheelNodeId, type DrivetrainDef, type VehicleDef, type WheelDef } from '../types';

// ====================================================================== targets
const DT = 1 / 2000;
const G = 9.81;
export const PICKUP_TARGETS = {
  totalMass: 2100,
  wheelbase: 3.7,
  track: 1.72,
  /** Static front axle share (empty truck). */
  frontAxleShare: 0.57,
  /** CG height in the REST pose. */
  cgHeight: 0.76,
  rideHzFront: 1.3,
  rideHzRear: 1.75,
  dampingRatio: 0.3,
  staticSuspensionSag: 0.0,
  maxWheelAngleRad: 0.6,
  /** Ground clearance (lowest non-wheel node surface) at rest, m (contract ≥ 0.22). */
  minGroundClearance: 0.22,
  powerKw: 295,
  torqueNm: 550,
} as const;

const Z_F = -PICKUP_TARGETS.wheelbase / 2;
const Z_R = PICKUP_TARGETS.wheelbase / 2;
const HALF_TRACK = PICKUP_TARGETS.track / 2;

/**
 * LT275/65R18-class all-terrain tyre on an 18" rim (0.39 m radius, 12 rays).
 * Derived from the sedan's 205/55R16 tuning (wheelrig.ts) with every carcass
 * spring, damper and mass scaled ×1.5 (a 5 kN wheel load instead of 3.5 kN at
 * the same per-node ω·dt), a wider tread and a lower μ (AT tread on asphalt).
 */
export const PICKUP_TIRE = {
  radius: 0.39,
  rimRadius: 0.245,
  width: 0.2,
  rays: 12,
  tireNodeRadius: 0.05,
  tireContactSpring: 7e4,
  treadBrushStiffness: 1.05e5,
  treadBrushDamping: 45,
  rimHoopTension: 1,
  treadHoopTension: 0.5,
  rollingResistance: 0.012,
  tireRingSpring: 4.0e4,
  tireRingDamp: 6,
  rimSpring: 7.0e4,
  rimDamp: 9,
  sidewallSpring: 1.5e5,
  sidewallDamp: 15,
  hubMass: 40,
  rimMass: 44,
  tireMass: 22,
  // R-PHYS: 1.0 → 1.1 μ_x with μ_y = 0.85 μ_x (an all-season LT tyre): ABS ≈ 0.95 g, skidpad ≈ 0.8 g
  friction: 1.13,
  tyreLateralMu: 0.85,
  // R-PHYS tyre model (tyre.ts): LT tyre
  tyreLoadSensitivity: 0.07,
  tyreSlideRatio: 0.82,
  tyrePeakSlip: 0.08,
  tyreSlideSlip: 0.55,
} as const satisfies Partial<WheelDef>;

/**
 * Lateral tread-brush stiffness per tread node, N/m (wheels.ts applyTreadBrush), per axle.
 * Two limits (pickup.test.ts straight-line runs): (1) the live axle's lateral / yaw
 * location (Panhard, trailing-link anchors) is compliant — at the sedan-like 7e4–1e5 on
 * the rear tyres a full-throttle run grew a ±0.3 rad/s yaw weave from ≈ 95 km/h, ≤ 5e4 is
 * stable; (2) the CG sits 57 % forward, so the front must not out-corner the rear
 * (C_f·a ≤ C_r·b): at 9e4 front the truck weaved and spun coasting at 170 km/h. Equal-ish
 * soft brushes make it a stable understeerer (the sedan is near neutral).
 * Feel pass: 4.5e4 → 3.3e4 front. With the rigid shell cluster the frame no longer twists away
 * load transfer and the truck held R40 at 0.947 g (target 0.75–0.92); a softer front brush
 * (more understeer at the limit) brings it back to 0.91 g.
 */
// R-PHYS: × 2.3 (3.3e4 / 4e4 before): an LT265/70R17-class tyre, C_α/Fz ≈ 11–13/rad, peak ≈ 7–10° (bench)
const FRONT_BRUSH = 7.6e4;
const REAR_BRUSH = 9.2e4;
const WHEEL_RADIUS = PICKUP_TIRE.radius;
const Y_W = WHEEL_RADIUS;

const OMEGA_DT_TARGET = 0.33;
const BUDGET_PER_KG = (OMEGA_DT_TARGET / DT) ** 2;
/**
 * Front bumper mounting (see the FRONT BUMPER beams). Crush brackets: stiffness / crush force per member
 * (at 5e5 the crushed brackets stored enough to spring the horn tips 14 cm back out: 50 km/h spring-back
 * 32 %; 2e5 gives 6 %). Straps: stiffness, bend (yield) force and bolt-shear force. A strap folds
 * plastically at BUMPER_STRAP_YIELD as the horns crush, so it never springs the bar back off the crushed
 * horns; the ratchet lets its force run ahead of the yield in proportion to the closing rate (beams.ts
 * PLASTIC_RATCHET: ≈ k·v·dt / ratchet = k·v·0.005), so the bolts shear only when the horns are driven in
 * fast. Measured peaks (lower strap): 50 km/h 8.0 kN, 60 km/h 8.8 kN, 70 km/h tears the lower straps,
 * 80 km/h and up tears all four. Shear at 9.6 kN leaves 20 % margin at 50 km/h.
 */
const K_BUMPER_BRACKET = 2e5;
const BUMPER_BRACKET_CRUSH = 2.5e4;
const K_BUMPER_STRAP = 9e4;
const BUMPER_STRAP_YIELD = 2e3;
const BUMPER_STRAP_SHEAR = 9.6e3;
/** Shell nodes (group 'body': frame, clip, cab, bed, bumpers) run stiffer for crash response (sedan.ts SHELL_OMEGA_DT_TARGET). */
const SHELL_OMEGA_DT_TARGET = 0.485;
const SHELL_BUDGET_PER_KG = (SHELL_OMEGA_DT_TARGET / DT) ** 2;

// ====================================================================== beam classes
/**
 * Same scheme as the sedan: `w` = stiffness share of a node's budget,
 * `zeta` = damping ratio on the reduced mass, deform = max(yieldStrain·k·L,
 * minDeform), breakF = breakRatio·deform. Frame gaps listed in GAP_YIELD
 * yield as a section (see CRASH SECTIONS).
 */
const CLASSES = {
  frame: { w: 1.2, zeta: 0.35, yieldStrain: 0.05, minDeform: 3e4, breakRatio: 6 },
  horn: { w: 1.0, zeta: 0.4, yieldStrain: 0.018, minDeform: 8e3, breakRatio: 6 },
  clip: { w: 1.0, zeta: 0.4, yieldStrain: 0.02, minDeform: 3e3, breakRatio: 6 },
  bumper: { w: 1.0, zeta: 0.4, yieldStrain: 0.03, minDeform: 6e3, breakRatio: 5 },
  cage: { w: 1.3, zeta: 0.3, yieldStrain: 0.1, minDeform: 2.5e4, breakRatio: 5 },
  glass: { w: 0.4, zeta: 0.25, yieldStrain: 0.06, minDeform: 0, breakRatio: 1.7 },
  bed: { w: 1.0, zeta: 0.35, yieldStrain: 0.03, minDeform: 6e3, breakRatio: 6 },
  /** Body / bed mounts: rubber-bushed bolts that shear in a hard crash. */
  mount: { w: 3, zeta: 0.35, yieldStrain: 0.02, minDeform: 8e3, breakRatio: 8 },
  /** Bumper brackets onto the frame horns: push the horns (a weak bracket let the bar slide 30 cm past them). */
  bumperMount: { w: 2, zeta: 0.4, yieldStrain: 0.05, minDeform: 2.5e4, breakRatio: 3 },
  subframe: { w: 3, zeta: 0.25, yieldStrain: 0.04, minDeform: 2.5e4, breakRatio: 5 },
  engMount: { w: 1.0, zeta: 0.3, yieldStrain: 0.04, minDeform: 1e4, breakRatio: 5 },
  engine: { w: 2.0, zeta: 0.2, yieldStrain: 0, minDeform: 0, breakRatio: 0 },
} as const;
type BeamClass = keyof typeof CLASSES;

// ====================================================================== stations
type Pt = readonly [tag: string, x: number, y: number];
interface Station {
  /** Node id prefix + index, e.g. 'f3'. */
  id: string;
  /** Structure the station belongs to (links run only between consecutive stations of one structure). */
  part: 'frame' | 'clip' | 'cab' | 'bed' | 'bumperF' | 'bumperR';
  z: number;
  ring: readonly Pt[];
  closed: boolean;
  bulkhead: boolean;
  extra?: readonly Pt[];
  cls: BeamClass;
  mass: Readonly<Record<string, number>>;
  /** In-plane triangulation reach, m (default 1.25). */
  reach?: number;
}

/*
 * Masses are BASE values (kg) before the CG/axle-split solve. The front rails
 * (f1..f4) carry the V8's mass (the block nodes themselves are light, like the
 * sedan's P4 engine, so the rails get the stiffness budget a frontal needs).
 */
const ENGINE_RAIL = 36;
const FRAME: readonly Station[] = [
  { id: 'f0', part: 'frame', z: -2.72, closed: true, bulkhead: true, cls: 'horn', mass: { lo: 20, hi: 20 }, ring: [['lo', 0.46, 0.45], ['hi', 0.46, 0.72]] },
  { id: 'f1', part: 'frame', z: -2.4, closed: true, bulkhead: true, cls: 'horn', mass: { lo: 28, hi: 28 }, ring: [['lo', 0.46, 0.45], ['hi', 0.46, 0.72]] },
  { id: 'f2', part: 'frame', z: -2.08, closed: true, bulkhead: true, cls: 'frame', mass: { lo: ENGINE_RAIL, hi: ENGINE_RAIL }, ring: [['lo', 0.46, 0.45], ['hi', 0.46, 0.72]] },
  {
    id: 'f3', part: 'frame', z: Z_F, closed: true, bulkhead: true, cls: 'frame', mass: { lo: ENGINE_RAIL, hi: ENGINE_RAIL, tw: 22 },
    ring: [['lo', 0.47, 0.45], ['hi', 0.47, 0.72]], extra: [['tw', 0.6, 1.02]],
  },
  { id: 'f4', part: 'frame', z: -1.42, closed: true, bulkhead: false, cls: 'frame', mass: { lo: ENGINE_RAIL, hi: ENGINE_RAIL }, ring: [['lo', 0.49, 0.43], ['hi', 0.49, 0.73]] },
  { id: 'f5', part: 'frame', z: -0.95, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 34, hi: 34 }, ring: [['lo', 0.52, 0.4], ['hi', 0.52, 0.75]] },
  { id: 'f6', part: 'frame', z: -0.15, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 32, hi: 32 }, ring: [['lo', 0.53, 0.4], ['hi', 0.53, 0.75]] },
  { id: 'f7', part: 'frame', z: 0.65, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 30, hi: 30 }, ring: [['lo', 0.53, 0.4], ['hi', 0.53, 0.75]] },
  { id: 'f8', part: 'frame', z: 1.22, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 16, hi: 16 }, ring: [['lo', 0.53, 0.46], ['hi', 0.53, 0.79]] },
  {
    id: 'f9', part: 'frame', z: Z_R, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 16, hi: 16, tw: 18 },
    ring: [['lo', 0.53, 0.6], ['hi', 0.53, 0.86]], extra: [['tw', 0.66, 1.04]],
  },
  { id: 'f10', part: 'frame', z: 2.5, closed: true, bulkhead: false, cls: 'frame', mass: { lo: 14, hi: 14 }, ring: [['lo', 0.53, 0.6], ['hi', 0.53, 0.86]] },
  { id: 'f11', part: 'frame', z: 3.0, closed: true, bulkhead: true, cls: 'frame', mass: { lo: 16, hi: 16 }, ring: [['lo', 0.52, 0.58], ['hi', 0.52, 0.84]] },
];

/** Front clip: radiator support, inner aprons, fender tops (sheet metal on the frame horns). */
const CLIP: readonly Station[] = [
  {
    id: 's0', part: 'clip', z: -2.6, closed: true, bulkhead: true, cls: 'clip', mass: { rs: 8, rl: 8, rh: 6, fd: 5, rt: 6 },
    ring: [['rs', 0, 0.72], ['rl', 0.62, 0.72], ['fd', 0.94, 1.1], ['rh', 0.62, 1.15], ['rt', 0, 1.17]],
  },
  { id: 's1', part: 'clip', z: -1.98, closed: false, bulkhead: false, cls: 'clip', mass: { ap: 6, ai: 5, fd: 5 }, ring: [['ap', 0.74, 0.8], ['ai', 0.68, 1.13], ['fd', 0.99, 1.18]] },
  { id: 's2', part: 'clip', z: -1.26, closed: false, bulkhead: false, cls: 'clip', mass: { ap: 6, ai: 5, fd: 5 }, ring: [['ap', 0.72, 0.82], ['ai', 0.7, 1.2], ['fd', 0.99, 1.23]] },
];

const CAB_RING = (z: number, y0: number): Pt[] => [
  ['tn', 0, y0 + 0.06],
  ['fl', 0.5, y0],
  ['sl', 0.94, 0.62],
  ['dm', 0.985, 0.98],
  ['bt', 0.975, 1.33],
  ['rf', 0.8, 1.87 + (z < 0 ? 0 : 0.005)],
  ['rf', 0, 1.95],
];
const CAB: readonly Station[] = [
  {
    id: 'c0', part: 'cab', z: -0.95, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 11.6, fl: 14.5, sl: 14.5, hp: 11.6, ap: 10.2, cw: 10.2, fw: 8.7 },
    ring: [['tn', 0, 0.86], ['fl', 0.5, 0.8], ['sl', 0.93, 0.62], ['hp', 0.965, 1.02], ['ap', 0.86, 1.3], ['cw', 0, 1.33]],
    extra: [['fw', 0.42, 1.05]],
  },
  { id: 'c1', part: 'cab', z: -0.4, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 11.6, fl: 20.3, sl: 14.5, dm: 8.7, bt: 8.7, rf: 7.2 }, ring: CAB_RING(-0.4, 0.8) },
  { id: 'c2', part: 'cab', z: 0.12, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 11.6, fl: 20.3, sl: 14.5, dm: 8.7, bt: 8.7, rf: 7.2 }, ring: CAB_RING(0.12, 0.8) },
  { id: 'c3', part: 'cab', z: 0.58, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 11.6, fl: 20.3, sl: 14.5, dm: 8.7, bt: 8.7, rf: 7.2 }, ring: CAB_RING(0.58, 0.8) },
  {
    id: 'c4', part: 'cab', z: 0.98, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 14.5, fl: 17.4, sl: 13, qm: 8.7, bt: 8.7, rf: 7.2 },
    ring: [['tn', 0, 0.86], ['fl', 0.5, 0.8], ['sl', 0.93, 0.62], ['qm', 0.975, 0.98], ['bt', 0.965, 1.33], ['rf', 0.79, 1.86], ['rf', 0, 1.93]],
  },
];

/** Bed: floor (fc centre, fl inner), outer sill (bo), side-wall rail (rl); b0 is the front wall (+ rc top centre). */
const BED: readonly Station[] = [
  {
    id: 'b0', part: 'bed', z: 1.1, closed: true, bulkhead: true, cls: 'bed', mass: { fc: 8, fl: 8, bo: 7, rl: 5, rc: 4, cx: 4 },
    ring: [['fc', 0, 0.94], ['fl', 0.6, 0.94], ['bo', 0.985, 0.9], ['rl', 0.995, 1.36], ['rc', 0, 1.36]],
    extra: [['cx', 0, 0.86]],
  },
  { id: 'b1', part: 'bed', z: 1.5, closed: false, bulkhead: false, cls: 'bed', mass: { fc: 8, fl: 8, bo: 6, rl: 4, cx: 4 }, ring: [['fc', 0, 0.94], ['fl', 0.6, 0.94], ['bo', 0.985, 0.9], ['rl', 0.995, 1.36]], extra: [['cx', 0, 0.86]] },
  { id: 'b2', part: 'bed', z: 2.2, closed: false, bulkhead: false, cls: 'bed', mass: { fc: 8, fl: 8, bo: 6, rl: 4, cx: 4 }, ring: [['fc', 0, 0.94], ['fl', 0.6, 0.94], ['bo', 0.985, 0.9], ['rl', 0.995, 1.36]], extra: [['cx', 0, 0.86]] },
  { id: 'b3', part: 'bed', z: 2.92, closed: false, bulkhead: false, cls: 'bed', mass: { fc: 9, fl: 9, bo: 7, rl: 5, cx: 4 }, ring: [['fc', 0, 0.94], ['fl', 0.6, 0.94], ['bo', 0.985, 0.9], ['rl', 0.995, 1.36]], extra: [['cx', 0, 0.86]] },
];

const BUMPERS: readonly Station[] = [
  {
    id: 'bf', part: 'bumperF', z: -2.88, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 7, bo: 6, bu: 7 },
    ring: [['bl', 0, 0.5], ['bl', 0.5, 0.5], ['bo', 0.97, 0.6], ['bu', 0.5, 0.86], ['bu', 0, 0.86]],
  },
  {
    id: 'br', part: 'bumperR', z: 3.13, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 6, bo: 5, bu: 6 },
    ring: [['bl', 0, 0.56], ['bl', 0.5, 0.56], ['bo', 0.98, 0.62], ['bu', 0.5, 0.8], ['bu', 0, 0.8]],
  },
];

const STRUCTURES: readonly (readonly Station[])[] = [FRAME, CLIP, CAB, BED, BUMPERS.slice(0, 1), BUMPERS.slice(1)];

/**
 * Axial section yield force of FRAME gap g (f_g → f_g+1), N: the crumple
 * zone is the frame front (horns f0→f2) and the clip; f2→f4 (the engine bay
 * with the front axle) yields late, the rest of the frame never in a frontal.
 */
const FRAME_GAP_YIELD: readonly number[] = [0.6e5, 2.0e5, 1.1e6, 1.2e6, 1.6e6, 2e6, 2e6, 2e6, 2e6, 1.5e6, 1.2e6];
/** Cab gaps (safety cell): never yield in a frontal (sedan.ts GAP_YIELD cell values). */
const CAB_GAP_YIELD: readonly number[] = [1.2e6, 1.2e6, 1.2e6, 9e5];
const SHEAR_YIELD_FLOOR = 0.8;
const SHEAR_FORCE_SHARE = 0.6;
/**
 * Frame bays: web / X diagonals yield no earlier than the chords. Weaker diagonals let a horn bay
 * collapse as a parallelogram (the tip station swung 45 cm about the next one with its chords
 * barely shortened) instead of crushing axially.
 */
const FRAME_SHEAR_FORCE_SHARE = 1.2;
/** Minimum break force of frame / horn members, N. */
const FRAME_MIN_BREAK = 3.5e5;
const IN_STATION_YIELD_FACTOR = 3;
const LONGITUDINAL_W = 4;
/** Frame rail chords: bending stiffness of a pin-jointed ladder lives in them (a 0.27 m deep truss). */
const FRAME_LONGITUDINAL_W = 24;
/** Frame web members (verticals + same-side diagonals): the truss's shear stiffness. */
const FRAME_WEB_W = 4;
/** Frame chord spans (station pairs) that bypass the bays between them. */
const FRAME_SPANS: readonly (readonly [number, number])[] = [
  [2, 5],
  [3, 6],
  [5, 7],
  [6, 8],
  [7, 9],
];
/** Frame horizontal X-braces (lateral shear between the rails). */
const FRAME_SHEAR_W = 2.5;
const LINKS_PER_NODE = 3;
const DAMP_BUDGET = 0.95;
const GLASS_BREAK_STRAIN = 0.03;
/**
 * The windscreen (cw–rf) breaks earlier: the body-on-frame cab barely deforms in a frontal (the
 * frame takes it), so at 3 % only a third of its beams broke at 100 km/h.
 */
const WINDSCREEN_BREAK_STRAIN = 0.006;
const DOOR_NODES = /^c[13]_(dm|bt|sl)_/;
const DOOR_YIELD_STRAIN = 0.04;
const DOOR_MIN_DEFORM = 3.5e3;
const FIREWALL_PANEL = /^c0_fw_/;
/** Cab glass: windscreen cw–rf (c0→c1), side windows bt–rf (c1..c4), back glass in the c4 plane. */
const GLASS_TAGS: readonly (readonly [string, string])[] = [
  ['bt', 'rf'],
  ['cw', 'rf'],
  ['ap', 'rf'],
];
const CABIN_SPANS: readonly (readonly [number, string, number, string])[] = [
  [0, 'sl', 2, 'sl'],
  [2, 'sl', 4, 'sl'],
  [0, 'fl', 2, 'fl'],
  [2, 'fl', 4, 'fl'],
  [0, 'tn', 2, 'tn'],
  [2, 'tn', 4, 'tn'],
  [1, 'rf', 3, 'rf'],
  [0, 'ap', 2, 'rf'],
  [2, 'rf', 4, 'rf'],
  [0, 'sl', 2, 'bt'],
  [0, 'hp', 2, 'sl'],
  [2, 'sl', 4, 'bt'],
  [2, 'bt', 4, 'sl'],
];
const CABIN_SPAN_YIELD_STRAIN = 0.25;
const CROSS_CABIN: readonly (readonly [number, string, string])[] = [
  [0, 'ap', 'sl'],
  [2, 'rf', 'sl'],
  [2, 'bt', 'fl'],
  [4, 'rf', 'sl'],
  [4, 'bt', 'fl'],
];

// ====================================================================== suspension geometry
const HUB_SPACING = 0.28;
const LINK_REACH = 0.38;
interface CornerGeom {
  z: number;
  kU: [number, number, number];
  lowerPivots: [[number, number, number], [number, number, number]];
  upperPivots: [[number, number, number], [number, number, number]];
  linkPivot: [number, number, number];
}
/** Front: tall-knuckle double wishbone (≈ 0.39 m upright), long travel. */
const FRONT: CornerGeom = {
  z: Z_F,
  kU: [0.75, 0.78, Z_F + 0.03],
  // R-PHYS: the UPPER arm's pivot axis inclined ≈ 6° in side view (front pivot up; the lower arm — a crash-path
  // subframe member — untouched) puts the side-view IC behind the wheel: anti-dive ≈ −35 % (pro-dive) → ≈ 20 %;
  // the tie-rod geometry is unchanged (bump steer −0.01 °/cm, toe-out in bump; realism/suspension.test.ts)
  lowerPivots: [[0.36, Y_W, Z_F - 0.3], [0.36, Y_W, Z_F + 0.28]],
  upperPivots: [[0.42, 0.78 + 0.026, Z_F - 0.26], [0.42, 0.78 - 0.026, Z_F + 0.26]],
  linkPivot: [HALF_TRACK + HUB_SPACING / 2, 0.4, Z_F + LINK_REACH],
};
/** Front shock travel to the bump stops, m (long-travel). */
const FRONT_SHOCK_TRAVEL = 0.13;
const REAR_SHOCK_TRAVEL = 0.11;
const KNUCKLE_NODE_MASS = 11;
const K_SUBFRAME = 1.2e6;
const SUBFRAME_BUDGET_SHARE = 0.7;
const SUBFRAME_DEFORM = 1.1e5;
const SUBFRAME_BREAK = 2.2e5;
const subframePivotMass = (fixedK: number): number => round(fixedK / (BUDGET_PER_KG * SUBFRAME_BUDGET_SHARE), 2);
const PIVOT_NODE_MASS = 8;
const K_LOWER_ARM = 1.4e6;
const K_UPPER_ARM = 9e5;
const K_TOE_LINK = 1.6e6;
const K_AXLE_STUB = 1.4e6;
const ATTACH_SPRING = 1.0e6;
const ATTACH_DAMP = 350;
const D_ARM = 450;
const ARB_FRACTION_FRONT = 0.55;
const DAMPER_CALIBRATION = 1.6;
const FRONT_HUB_MASS = 40;

/*
 * REAR LIVE AXLE (right side; mirrored). Rigid body: the upright tops
 * `R?_kU` (spring seats over the axle centre), the spring brackets `R?_ab`
 * behind the tube and the diff `axD` ahead of it (all pairs: non-coplanar,
 * rigid); each side's hubI / hubO hang on it. Located by (fixed stiffness,
 * frame pivots fixed-mass):
 *   lower trailing link  hubI → R?_lp   (the leaf's front eye)
 *   upper trailing link  kU   → R?_up   (wind-up / pitch)
 *   crossed Panhards     RL_kU → RR_pan and RR_kU → RL_pan (frame): one
 *                        Panhard rod's L/R asymmetry yawed the truck 4° over
 *                        a 10 s straight; a Watt's linkage's soft rocker weaved
 *   spring + damper      R?_kU → f9_tw  (over the axle centre: a spring seat
 *                        behind it wound the housing up 3° at rest)
 * 4 parallel trailing links + the lateral rods = 4 independent constraints on a
 * 6-DOF body: heave and roll remain. (A triangulated 4-link — converging
 * upper links instead — spun the truck in every straight-line run.)
 */
const REAR = {
  kU: [0.72, 0.6, Z_R] as [number, number, number],
  ab: [0.66, 0.42, Z_R + 0.22] as [number, number, number],
  axD: [0, 0.42, Z_R - 0.2] as [number, number, number],
  lp: [0.62, 0.44, Z_R - 0.72] as [number, number, number],
  up: [0.6, 0.66, Z_R - 0.62] as [number, number, number],
  /** Crossed Panhard rods: frame pivot (right side; the left rod's mirrored). */
  pan: [0.5, 0.62, Z_R] as [number, number, number],
};
const AXLE_NODE_MASS = { kU: 24, ab: 16, axD: 20 } as const;
const REAR_HUB_MASS = 52;
const K_AXLE = 1.0e6;
const K_TRAIL = 1.6e6;
/** Each of the two crossed Panhard rods (together ≈ one 1.8e6 rod laterally). */
const K_PANHARD = 1.0e6;

// ====================================================================== hood / tailgate
const HOOD_Z = [-2.52, -2.0, -1.5, -1.08] as const;
const HOOD_Y = [1.18, 1.22, 1.26, 1.29] as const;
const HOOD_HALF_X = 0.72;
const HOOD_CROWN = 0.03;
const HOOD_NODE_MASS = 1.6;
const HOOD = {
  zeta: 0.5,
  yieldStrain: 0.03,
  minDeform: 2e3,
  breakRatio: 8,
  hingeDeform: 1.6e4,
  hingeBreak: 4e4,
  // Feel pass 5e3 → 4e3: with the rigid cab + frame rails the 100 km/h frontal's latch load peaked just under 5 kN.
  latchBreak: 4e3,
  restBreak: 2e4,
} as const;
const TG_X = 0.93;
const TG_Y = [0.95, 1.35] as const;
const TG_Z = { i: 2.925, o: 3.025 } as const;
const TG_NODE_MASS = 2.5;
const TAILGATE = {
  zeta: 0.5,
  yieldStrain: 0.03,
  minDeform: 2.5e3,
  breakRatio: 8,
  hingeDeform: 1.5e4,
  hingeBreak: 3.5e4,
  latchBreak: 9e3,
  restBreak: 2e4,
} as const;

// ====================================================================== drivetrain
/**
 * 5.0 L V8: 550 N·m from 4000 to 4500 rpm, 295 kW at 5500 rpm. Short final
 * drive (4.56) with a direct-ish top gear so the 6200 rpm limiter caps the
 * truck at ≈ 190 km/h (contract: accel > 0 at 175, ≤ 0 at 200 km/h).
 */
const DRIVETRAIN: DrivetrainDef = {
  // R-PHYS engine systems (engineSystems.ts): fuel, cooling, oil, stall / starter
  engine: { displacementL: 5.0, fuel: 'petrol', tankL: 98 },
  torqueCurve: [
    [0, 280],
    [700, 360],
    [1500, 430],
    [2500, 495],
    [3500, 535],
    [4000, 550],
    [4500, 550],
    [5000, 538],
    [5500, 512],
    [6000, 440],
    [6400, 330],
  ],
  idleRpm: 700,
  redlineRpm: 6000,
  revLimitRpm: 6200,
  engineInertia: 0.26,
  engineBrakeTorque: 85,
  // R-PHYS: 5th direct, 6th a 0.72 overdrive (a real full-size pickup cruises at ≈ 2000 rpm at 100 km/h; it
  // held 3250 rpm and burned 16.5 L/100 km), the old limiter top speed now an electronic governor (speedLimitKmh)
  gearRatios: [3.4, 2.25, 1.62, 1.28, 1.0, 0.72],
  speedLimitKmh: 190,
  reverseRatio: 3.3,
  finalDrive: 4.1,
  shiftTimeS: 0.2,
  autoShiftUpRpm: 5900,
  autoShiftDownRpm: 2300,
  diff: 'limited',
  diffLockTorque: 600,
  clutchMaxTorque: 850,
  transmission: 'auto',
  tractionControl: 0.14,
  // R-PHYS: live rear axle — the differential's drive-torque reaction acts on the axle housing.
  driveReaction: 'body',
};

// ====================================================================== generator helpers
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
const sig3 = (v: number): number => {
  if (v === 0) return 0;
  const p = 10 ** (2 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
};
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
  w: number;
}

/** Design numbers derived while generating (asserted by pickup.test.ts). */
export interface PickupDesign {
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
  arbK: { front: number };
  hydroTravel: { L: number; R: number };
  bodyNodeCount: number;
  bodyBeamCount: number;
  /** Body / bed mount beams (node id pairs). */
  cabMounts: [string, string][];
  bedMounts: [string, string][];
  /** Tailgate hinge + latch beams. */
  tailgateHinges: [string, string][];
  tailgateLatches: [string, string][];
  /** Front bumper straps (the tear-off beams; the render detaches the bar on them). */
  bumperStraps: [string, string][];
}

/**
 * R-PHYS rolling-loss correction (tyre.ts): the 12/10-ray tread polygon's excess loss over a real tyre's
 * f_r = 0.011·(1 + V/160 km/h) (Wong, "Theory of Ground Vehicles" eq. 1.12), per unit load, every 10 km/h
 * of tread speed from 0 — measured by coasting this car in neutral (realism/coastdown calibration), kept
 * conservative (0.85 × the lower of the bin and its neighbours' mean) so it never propels a coasting car.
 */
export const PICKUP_ROLLING_LOSS: readonly number[] = [0, 0.0048, 0.0058, 0.0063, 0.0066, 0.0062, 0.0063, 0.0089, 0.0097, 0.0081, 0.0091, 0.0137, 0.0179, 0.0289, 0.0474, 0.0533, 0.0742, 0.0774, 0.0805, 0.0785, 0.0765];

function buildPickup(): { def: VehicleDef; design: PickupDesign } {
  const nodes: RigNodeDef[] = [];
  const pos = new Map<string, V3>();
  const massOf = new Map<string, number>();
  const structure: string[] = [];
  const addNode = (id: string, p: readonly number[], mass: number, group: string, collidable = true, isStructure = true): string => {
    if (pos.has(id)) throw new Error(`pickup: duplicate node ${id}`);
    const q: V3 = [round(p[0]!), round(p[1]!), round(p[2]!)];
    nodes.push({ id, pos: q, mass, group, ...(collidable ? {} : { collidable: false }) });
    pos.set(id, q);
    massOf.set(id, mass);
    if (isStructure) structure.push(id);
    return id;
  };

  // ---- shell stations
  const tagOf = new Map<string, string>();
  /** Global station key ('f3', 'c2', …) of each shell node. */
  const stationOf = new Map<string, string>();
  const stationIds = new Map<string, string[]>();
  const stationRing = new Map<string, string[][]>();
  const stationDef = new Map<string, Station>();
  const sid = (st: string, tag: string, side?: Side): string => (side ? `${st}_${tag}_${side}` : `${st}_${tag}`);
  for (const chain of STRUCTURES) {
    for (const st of chain) {
      stationDef.set(st.id, st);
      const ids: string[] = [];
      const right: string[] = [];
      const left: string[] = [];
      const centres: string[] = [];
      const add = (pt: Pt, onRing: boolean): void => {
        const [tag, x, y] = pt;
        const m = st.mass[tag];
        if (m === undefined) throw new Error(`pickup: station ${st.id} has no mass for tag ${tag}`);
        const sides: (Side | undefined)[] = x === 0 ? [undefined] : ['R', 'L'];
        for (const s of sides) {
          const id = addNode(sid(st.id, tag, s), [s ? x * sideSign(s) : 0, y, st.z], m, 'body');
          ids.push(id);
          tagOf.set(id, tag);
          stationOf.set(id, st.id);
          if (!onRing) continue;
          if (s === undefined) centres.push(id);
          else (s === 'R' ? right : left).push(id);
        }
      };
      for (const pt of st.ring) add(pt, true);
      for (const pt of st.extra ?? []) add(pt, false);
      stationIds.set(st.id, ids);
      const first = st.ring[0]!;
      const last = st.ring[st.ring.length - 1]!;
      const bottom = first[1] === 0 ? [centres[0]!] : [];
      const top = last[1] === 0 && centres.length > (bottom.length > 0 ? 1 : 0) ? [centres[centres.length - 1]!] : [];
      stationRing.set(st.id, st.closed ? [[...bottom, ...right, ...top, ...left.reverse()]] : [[...bottom, ...right], [...(bottom.length ? bottom : []), ...left]]);
    }
  }
  const rearHitch = addNode('hitch', [0, 0.5, 3.27], 6, 'body');
  tagOf.set(rearHitch, 'hitch');

  // ---- engine (V8, longitudinal) + gearbox: light nodes (the mass is in the front rails)
  const ENGINE_NODE_MASS = 6;
  const engine: string[] = [];
  for (const z of [-2.25, -1.5])
    for (const y of [0.66, 1.06])
      for (const s of ['R', 'L'] as const) engine.push(addNode(`eng_${z < -1.9 ? 'f' : 'r'}${y < 0.8 ? 'lo' : 'hi'}_${s}`, [0.26 * sideSign(s), y, z], ENGINE_NODE_MASS, 'engine', true, false));
  const gearbox = (['R', 'L'] as const).map((s) => addNode(`gbx_${s}`, [0.16 * sideSign(s), 0.7, -0.75], ENGINE_NODE_MASS, 'engine', true, false));

  // ---- front corners (sedan corner kinematics)
  type CornerIds = { kU: string; hubI: string; hubO: string; lower: string[]; upper: string[]; link: string; tower: string };
  const corners = new Map<string, CornerIds>();
  const halfS = HUB_SPACING / 2;
  for (const s of ['L', 'R'] as const) {
    const c = `F${s}`;
    const g = FRONT;
    const ids: CornerIds = {
      kU: addNode(`${c}_kU`, mirror(g.kU, s), KNUCKLE_NODE_MASS, 'knuckle', false, false),
      hubI: wheelNodeId(c, 'hubI'),
      hubO: wheelNodeId(c, 'hubO'),
      lower: g.lowerPivots.map((p, i) => addNode(`${c}_lp${i}`, mirror(p, s), subframePivotMass(K_LOWER_ARM + 4 * K_SUBFRAME), 'subframe', true, false)),
      upper: g.upperPivots.map((p, i) => addNode(`${c}_up${i}`, mirror(p, s), PIVOT_NODE_MASS, 'subframe')),
      link: addNode(`${c}_rack`, mirror(g.linkPivot, s), subframePivotMass(K_TOE_LINK + 3 * K_SUBFRAME), 'subframe', true, false),
      tower: sid('f3', 'tw', s),
    };
    pos.set(ids.hubI, [round((HALF_TRACK - halfS) * sideSign(s)), Y_W, g.z]);
    pos.set(ids.hubO, [round((HALF_TRACK + halfS) * sideSign(s)), Y_W, g.z]);
    corners.set(c, ids);
  }

  // ---- rear live axle
  type AxleSide = { kU: string; ab: string; hubI: string; hubO: string; lp: string; up: string };
  const axle = new Map<Side, AxleSide>();
  const trailPivotMass = subframePivotMass(K_TRAIL + 4 * 2.5e5);
  for (const s of ['L', 'R'] as const) {
    const c = `R${s}`;
    const a: AxleSide = {
      kU: addNode(`${c}_kU`, mirror(REAR.kU, s), AXLE_NODE_MASS.kU, 'axle', false, false),
      ab: addNode(`${c}_ab`, mirror(REAR.ab, s), AXLE_NODE_MASS.ab, 'axle', true, false),
      hubI: wheelNodeId(c, 'hubI'),
      hubO: wheelNodeId(c, 'hubO'),
      lp: addNode(`${c}_lp`, mirror(REAR.lp, s), trailPivotMass, 'subframe', true, false),
      up: addNode(`${c}_up`, mirror(REAR.up, s), trailPivotMass, 'subframe', true, false),
    };
    pos.set(a.hubI, [round((HALF_TRACK - halfS) * sideSign(s)), Y_W, Z_R]);
    pos.set(a.hubO, [round((HALF_TRACK + halfS) * sideSign(s)), Y_W, Z_R]);
    axle.set(s, a);
  }
  const axD = addNode('axD', REAR.axD, AXLE_NODE_MASS.axD, 'axle', true, false);
  // Crossed Panhard rods RL_kU → RR_pan and RR_kU → RL_pan: lateral location, L/R symmetric (a single
  // Panhard rod's asymmetry yawed the truck 0.004 rad/s, 4° over a 10 s straight). Level at ride height,
  // their heave bind is second order (≈ 0.5 kN vertical at full bump).
  const panR = addNode('RR_pan', REAR.pan, subframePivotMass(K_PANHARD + 4 * 2.5e5), 'subframe', true, false);
  const panL = addNode('RL_pan', mirror(REAR.pan, 'L'), subframePivotMass(K_PANHARD + 4 * 2.5e5), 'subframe', true, false);

  // ---- hood sub-rig (appended after the structure; sedan contract layout)
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
  // ---- tailgate sub-rig
  const tg = (r: number, c: 'L' | 'C' | 'R', l: 'i' | 'o'): string => `tg_${r}${c}${l}`;
  for (let r = 0; r < 2; r++)
    for (const c of ['L', 'C', 'R'] as const)
      for (const l of ['i', 'o'] as const) addNode(tg(r, c, l), [c === 'C' ? 0 : c === 'R' ? TG_X : -TG_X, TG_Y[r]!, TG_Z[l]], TG_NODE_MASS, 'tailgate', true, false);

  // ---- wheels
  const unsprungWheelOf = (front: boolean): number => (front ? FRONT_HUB_MASS : REAR_HUB_MASS) + PICKUP_TIRE.rimMass + PICKUP_TIRE.tireMass;
  const axleBodyMass = 2 * AXLE_NODE_MASS.kU + 2 * AXLE_NODE_MASS.ab + AXLE_NODE_MASS.axD;
  const unsprungCornerOf = (front: boolean): number => unsprungWheelOf(front) + (front ? KNUCKLE_NODE_MASS : axleBodyMass / 2);
  const wheel = (id: 'FL' | 'FR' | 'RL' | 'RR'): WheelDef => {
    const front = id[0] === 'F';
    const s: Side = id[1] === 'L' ? 'L' : 'R';
    const kU = front ? corners.get(id)!.kU : axle.get(s)!.kU;
    return {
      ...PICKUP_TIRE,
      rollingLossComp: PICKUP_ROLLING_LOSS,
      hubMass: front ? FRONT_HUB_MASS : REAR_HUB_MASS,
      id,
      hubInner: pos.get(wheelNodeId(id, 'hubI'))!,
      hubOuter: pos.get(wheelNodeId(id, 'hubO'))!,
      axle: front ? 'front' : 'rear',
      steered: front,
      driven: !front,
      braked: true,
      brakeTorqueMax: 4200,
      treadBrushStiffness: front ? FRONT_BRUSH : REAR_BRUSH,
      handbrake: !front,
      attach: [kU],
      attachSpring: ATTACH_SPRING * (front ? 1 : 1.1),
      attachDamp: ATTACH_DAMP,
      attachBreakF: 1.4e5,
    };
  };
  const wheels = [wheel('FL'), wheel('FR'), wheel('RL'), wheel('RR')];

  // ---- mass distribution solve: structure masses m_i = b_i·(s + a·(z − z̄)) — total mass and the
  // static axle split (sedan.ts solves the CG height too; here that starved the low frame rails of
  // mass, so the height is what the base masses give, asserted by pickup.test.ts).
  {
    const M = PICKUP_TARGETS.totalMass;
    const zcg = Z_R - PICKUP_TARGETS.frontAxleShare * PICKUP_TARGETS.wheelbase;
    const isStruct = new Set(structure);
    let fm = 0;
    let fz = 0;
    for (const n of nodes) {
      if (isStruct.has(n.id)) continue;
      fm += n.mass;
      fz += n.mass * n.pos[2];
    }
    for (const w of wheels) {
      const uw = unsprungWheelOf(w.axle === 'front');
      fm += uw;
      fz += uw * w.hubInner[2];
    }
    let bSum = 0;
    let zBar = 0;
    for (const id of structure) {
      const b = massOf.get(id)!;
      bSum += b;
      zBar += b * pos.get(id)![2];
    }
    zBar /= bSum;
    const A = [
      [0, 0],
      [0, 0],
    ];
    for (const id of structure) {
      const b = massOf.get(id)!;
      const z = pos.get(id)![2];
      const basis = [1, z - zBar];
      const wts = [1, z];
      for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) A[r]![k]! += b * wts[r]! * basis[k]!;
    }
    const coef = solveN(A, [M - fm, M * zcg - fz]);
    for (const n of nodes) {
      if (!isStruct.has(n.id)) continue;
      const b = massOf.get(n.id)!;
      const m = b * (coef[0]! + coef[1]! * (n.pos[2] - zBar));
      if (!(m > 0.5)) throw new Error(`pickup: mass solve gave ${m} kg for ${n.id}`);
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
  const sprungFront = (totalMass * frontAxleShare) / 2 - unsprungCornerOf(true);
  const sprungRear = (totalMass * (1 - frontAxleShare)) / 2 - unsprungCornerOf(false);
  /** Tyre rate: ≈ 5 kN per 22 mm (pickup.test.ts static squash measures it). */
  const tireRate = 5000 / 0.022;
  const wheelRateFor = (m: number, hz: number): number => {
    const ride = m * (2 * Math.PI * hz) ** 2;
    return (ride * tireRate) / (tireRate - ride);
  };
  const wheelRate = { front: wheelRateFor(sprungFront, PICKUP_TARGETS.rideHzFront), rear: wheelRateFor(sprungRear, PICKUP_TARGETS.rideHzRear) };

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
    if (seen.has(k)) throw new Error(`pickup: duplicate beam ${k}`);
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
  const sameColumn = (a: string, b: string): boolean => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    return pa[0] !== 0 && pb[0] !== 0 && Math.sign(pa[0]) === Math.sign(pb[0]) && tagOf.get(a) !== 'bt' && tagOf.get(b) !== 'bt';
  };
  const isGlass = (a: string, b: string): boolean => {
    const sa = stationOf.get(a);
    const sb = stationOf.get(b);
    if (sa === undefined || sb === undefined || !sa.startsWith('c') || !sb.startsWith('c')) return false;
    const ta = tagOf.get(a)!;
    const tb = tagOf.get(b)!;
    if (sa === sb) {
      // Back glass: in the c4 plane between the belt and the roof rail.
      return sa === 'c4' && ((ta === 'bt' && tb === 'rf') || (ta === 'rf' && tb === 'bt')) && !sameColumn(a, b) && Math.abs(pos.get(a)![0] - pos.get(b)![0]) > 0.05;
    }
    return GLASS_TAGS.some(([x, y]) => (ta === x && tb === y) || (ta === y && tb === x)) && !sameColumn(a, b);
  };
  const isLongitudinal = (a: string, b: string): boolean => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    if (Math.sign(pa[0]) !== Math.sign(pb[0])) return false;
    return tagOf.get(a) === tagOf.get(b);
  };

  /*
   * FRAME: an explicit two-sided Pratt truss per rail (chords lo / hi, web
   * diagonals, verticals) + crossmembers at the bulkhead stations. The
   * generic nearest-3 linking spread every node's budget over many weak
   * cross links: the ladder sagged 4 cm between the axles under the cab.
   */
  FRAME.forEach((st, i) => {
    const cls = st.cls;
    for (const s of ['L', 'R'] as const) link(sid(st.id, 'lo', s), sid(st.id, 'hi', s), cls, FRAME_WEB_W);
    if (st.bulkhead) {
      link(sid(st.id, 'lo', 'L'), sid(st.id, 'lo', 'R'), cls);
      link(sid(st.id, 'hi', 'L'), sid(st.id, 'hi', 'R'), cls);
      link(sid(st.id, 'lo', 'L'), sid(st.id, 'hi', 'R'), cls, 0.7);
      link(sid(st.id, 'hi', 'L'), sid(st.id, 'lo', 'R'), cls, 0.7);
    }
    // Towers: to both rails of their station (the rails lie in x = ±const planes; one side alone leaves them free sideways).
    for (const e of st.extra ?? [])
      for (const s of ['L', 'R'] as const) {
        for (const t of ['lo', 'hi']) link(sid(st.id, e[0], s), sid(st.id, t, s), cls);
        link(sid(st.id, e[0], s), sid(st.id, 'hi', s === 'L' ? 'R' : 'L'), cls);
        link(sid(st.id, e[0], s), sid(st.id, 'lo', s === 'L' ? 'R' : 'L'), cls, 0.7);
      }
    const nx = FRAME[i + 1];
    if (nx === undefined) return;
    const c: BeamClass = cls === 'horn' || nx.cls === 'horn' ? 'horn' : cls;
    for (const s of ['L', 'R'] as const) {
      link(sid(st.id, 'lo', s), sid(nx.id, 'lo', s), c, FRAME_LONGITUDINAL_W);
      link(sid(st.id, 'hi', s), sid(nx.id, 'hi', s), c, FRAME_LONGITUDINAL_W);
      link(sid(st.id, 'lo', s), sid(nx.id, 'hi', s), c, FRAME_WEB_W);
      link(sid(st.id, 'hi', s), sid(nx.id, 'lo', s), c, FRAME_WEB_W);
    }
  });
  for (const chain of STRUCTURES) {
    if (chain === FRAME) continue;
    chain.forEach((st, i) => {
      const paths = stationRing.get(st.id)!;
      const ring = paths.flat();
      for (const path of paths) for (let k = 0; k + 1 < path.length; k++) link(path[k]!, path[k + 1]!, st.cls);
      if (st.closed) link(ring[ring.length - 1]!, ring[0]!, st.cls);
      const ids = stationIds.get(st.id)!;
      const reach = st.reach ?? 1.25;
      if (st.bulkhead) {
        for (let p = 0; p < ids.length; p++)
          for (let q = p + 1; q < ids.length; q++) {
            const a = ids[p]!;
            const b = ids[q]!;
            if (dist(a, b) > reach) continue;
            link(a, b, isGlass(a, b) ? 'glass' : st.cls);
          }
      } else {
        for (const e of ids) if (!ring.includes(e)) for (const n of nearest(e, ids, 3)) link(e, n, st.cls);
        // Open / non-bulkhead sections: triangulate each side in-plane and
        // tie the two sides across (bed floor crossmembers, apron braces).
        for (let p = 0; p < ids.length; p++)
          for (let q = p + 1; q < ids.length; q++) {
            const a = ids[p]!;
            const b = ids[q]!;
            const pa = pos.get(a)!;
            const pb = pos.get(b)!;
            const same = Math.sign(pa[0]) === Math.sign(pb[0]) || pa[0] === 0 || pb[0] === 0;
            const lowCross = !same && Math.max(pa[1], pb[1]) < 1.0 && dist(a, b) <= 1.4;
            if ((same && dist(a, b) <= 0.9) || lowCross) link(a, b, st.cls);
          }
      }
      const nextSt = chain[i + 1];
      if (nextSt === undefined) return;
      const next = stationIds.get(nextSt.id)!;
      const cls: BeamClass = st.cls === 'cage' || nextSt.cls === 'cage' ? 'cage' : st.cls === 'horn' || nextSt.cls === 'horn' ? 'horn' : st.cls;
      const pairs: [string, string][] = [];
      for (const a of ids) for (const b of nearest(a, next, LINKS_PER_NODE)) pairs.push([a, b]);
      for (const b of next) for (const a of nearest(b, ids, LINKS_PER_NODE)) pairs.push([a, b]);
      for (const [a, b] of pairs) {
        if (isGlass(a, b)) link(a, b, 'glass');
        else link(a, b, cls, isLongitudinal(a, b) ? (cls === 'frame' || cls === 'horn' ? FRAME_LONGITUDINAL_W : LONGITUDINAL_W) : 1);
      }
    });
  }
  // Safety-cell chords + cross-cabin diagonals (sedan.ts CABIN_SPANS / CROSS_CABIN).
  const cabKey = (i: number, t: string, s: Side): string => (pos.has(sid(`c${i}`, t, s)) ? sid(`c${i}`, t, s) : sid(`c${i}`, t));
  const spanKeys = new Set<string>();
  for (const [i, ta, j, tb] of CABIN_SPANS) {
    for (const sd of ['R', 'L'] as const) {
      const a = cabKey(i, ta, sd);
      const b = cabKey(j, tb, sd);
      spanKeys.add(key(a, b));
      link(a, b, 'cage', ta === tb ? LONGITUDINAL_W : 1);
    }
  }
  // Windscreen: the nearest-3 links leave one glass beam (cowl centre → header centre); X it across
  // both halves so the pane has a shear brace and a strain signal over its whole width.
  for (const sd of ['R', 'L'] as const) {
    link(sid('c0', 'ap', sd), sid('c1', 'rf'), 'glass');
    link(sid('c0', 'cw'), sid('c1', 'rf', sd), 'glass');
  }
  for (const [i, ta, tb] of CROSS_CABIN) {
    link(sid(`c${i}`, ta, 'R'), sid(`c${i}`, tb, 'L'), 'cage');
    link(sid(`c${i}`, ta, 'L'), sid(`c${i}`, tb, 'R'), 'cage');
  }
  // Frame: horizontal X-bracing of every bay at both flanges: the ladder's lateral shear / yaw stiffness between the
  // axles (a soft frame yaws the rear axle against the front: compliance steer, a power-on weave).
  for (let i = 0; i + 1 < FRAME.length; i++) {
    const a = FRAME[i]!.id;
    const b = FRAME[i + 1]!.id;
    link(sid(a, 'lo', 'R'), sid(b, 'lo', 'L'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'lo', 'L'), sid(b, 'lo', 'R'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'hi', 'R'), sid(b, 'hi', 'L'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'hi', 'L'), sid(b, 'hi', 'R'), FRAME[i]!.cls, FRAME_SHEAR_W);
  }
  // Frame SPANS: chords spanning 2–3 bays behind the horns and under the cab. A spring's k does not
  // depend on its length, so one span is ~3× as stiff axially as the chain of bays it bypasses, for
  // the same node budget: the 4.5 m frame compressed 6 cm elastically in a 30 km/h frontal and
  // threw it back out (41 % spring-back).
  for (const [i, j] of FRAME_SPANS)
    for (const s of ['L', 'R'] as const) for (const t of ['lo', 'hi']) link(sid(`f${i}`, t, s), sid(`f${j}`, t, s), 'frame', FRAME_LONGITUDINAL_W);
  // Shock / spring towers on the frame: braced to both rail flanges of their and the neighbouring stations.
  for (const s of ['L', 'R'] as const) {
    for (const t of [sid('f2', 'hi', s), sid('f2', 'lo', s), sid('f3', 'lo', s), sid('f4', 'hi', s), sid('f4', 'lo', s)]) link(sid('f3', 'tw', s), t, 'frame');
    for (const t of [sid('f8', 'hi', s), sid('f8', 'lo', s), sid('f9', 'lo', s), sid('f10', 'hi', s), sid('f10', 'lo', s)]) link(sid('f9', 'tw', s), t, 'frame');
  }

  // ---- front clip ↔ frame (radiator support + apron mounts) and ↔ cab (fender bolts at the cowl)
  const clipFrame: [string, string][] = [];
  const cabMounts: [string, string][] = [];
  const bedMounts: [string, string][] = [];
  for (const s of ['L', 'R'] as const) {
    clipFrame.push(
      [sid('s0', 'rl', s), sid('f1', 'hi', s)],
      [sid('s0', 'rl', s), sid('f1', 'lo', s)],
      [sid('s0', 'rl', s), sid('f2', 'hi', s)],
      [sid('s0', 'rl', s), sid('f0', 'hi', s)],
      [sid('s1', 'ap', s), sid('f3', 'hi', s)],
      [sid('s1', 'ap', s), sid('f3', 'tw', s)],
      [sid('s1', 'ai', s), sid('f3', 'tw', s)],
      [sid('s1', 'ap', s), sid('f2', 'hi', s)],
      [sid('s2', 'ap', s), sid('f4', 'hi', s)],
      [sid('s2', 'ap', s), sid('f5', 'hi', s)],
      [sid('s2', 'ai', s), sid('f3', 'tw', s)],
    );
  }
  for (const [a, b] of clipFrame) link(a, b, 'clip');
  // Fender / apron rear to the cab cowl: bolted, so a hard frontal tears it.
  for (const s of ['L', 'R'] as const) {
    for (const [a, b] of [
      [sid('s2', 'fd', s), sid('c0', 'hp', s)],
      [sid('s2', 'fd', s), sid('c0', 'ap', s)],
      [sid('s2', 'ai', s), sid('c0', 'ap', s)],
      [sid('s2', 'ai', s), sid('c0', 'fw', s)],
      [sid('s2', 'ap', s), sid('c0', 'hp', s)],
    ] as const)
      link(a, b, 'mount', 0.6);
  }
  // Cab mounts: c0 (front), c2 (middle), c4 (rear) floor sides onto frame outriggers; triangulated pairs.
  for (const s of ['L', 'R'] as const) {
    cabMounts.push(
      [sid('c0', 'fl', s), sid('f5', 'hi', s)],
      [sid('c0', 'sl', s), sid('f5', 'hi', s)],
      [sid('c0', 'fl', s), sid('f5', 'lo', s)],
      [sid('c0', 'fl', s), sid('f4', 'hi', s)],
      [sid('c2', 'fl', s), sid('f6', 'hi', s)],
      [sid('c2', 'sl', s), sid('f6', 'hi', s)],
      [sid('c2', 'fl', s), sid('f6', 'lo', s)],
      [sid('c1', 'fl', s), sid('f6', 'hi', s)],
      [sid('c4', 'fl', s), sid('f7', 'hi', s)],
      [sid('c4', 'sl', s), sid('f7', 'hi', s)],
      [sid('c4', 'fl', s), sid('f7', 'lo', s)],
      [sid('c3', 'fl', s), sid('f7', 'hi', s)],
    );
    bedMounts.push(
      [sid('b0', 'fl', s), sid('f8', 'hi', s)],
      [sid('b0', 'bo', s), sid('f8', 'hi', s)],
      [sid('b0', 'fl', s), sid('f8', 'lo', s)],
      [sid('b1', 'fl', s), sid('f8', 'hi', s)],
      [sid('b2', 'fl', s), sid('f10', 'hi', s)],
      [sid('b2', 'fl', s), sid('f9', 'hi', s)],
      [sid('b3', 'fl', s), sid('f10', 'hi', s)],
      [sid('b3', 'fl', s), sid('f11', 'hi', s)],
      [sid('b3', 'bo', s), sid('f11', 'hi', s)],
      [sid('b3', 'fl', s), sid('f11', 'lo', s)],
    );
  }
  for (const [a, b] of [...cabMounts, ...bedMounts]) link(a, b, 'mount');
  // Bumpers: brackets onto the frame ends; the hitch receiver on the rear crossmember.
  const bumperMounts: [string, string][] = [];
  for (const s of ['L', 'R'] as const) {
    bumperMounts.push(
      [sid('br', 'bl', s), sid('f11', 'lo', s)],
      [sid('br', 'bl', s), sid('f11', 'hi', s)],
      [sid('br', 'bu', s), sid('f11', 'hi', s)],
      [sid('br', 'bu', s), sid('f11', 'lo', s)],
      [sid('br', 'bo', s), sid('f11', 'hi', s)],
    );
  }
  bumperMounts.push(['br_bl', 'f11_lo_L'], ['br_bl', 'f11_lo_R'], ['br_bu', 'f11_hi_L'], ['br_bu', 'f11_hi_R']);
  for (const [a, b] of bumperMounts) link(a, b, 'bumperMount');
  // FRONT BUMPER: the bar bears on the horn tips through crush brackets (compression only: they crush,
  // they never hold the bar on), and is held on by bracket straps bolted back along the rails to the
  // first crossmember (f3). The straps fold with the horns; driven in fast (≥ ~65 km/h) their bolts shear
  // and the bar comes away. A 50 km/h hit crushes the horns about 0.45 m with the bar staying on, bent;
  // 80–100 km/h tear it off (constants above).
  const bumperCrush: [string, string][] = [];
  for (const s of ['L', 'R'] as const) {
    bumperCrush.push(
      [sid('bf', 'bl', s), sid('f0', 'lo', s)],
      [sid('bf', 'bl', s), sid('f0', 'hi', s)],
      [sid('bf', 'bu', s), sid('f0', 'hi', s)],
      [sid('bf', 'bu', s), sid('f0', 'lo', s)],
      [sid('bf', 'bo', s), sid('f0', 'lo', s)],
      [sid('bf', 'bo', s), sid('f0', 'hi', s)],
    );
  }
  bumperCrush.push(['bf_bl', 'f0_lo_L'], ['bf_bl', 'f0_lo_R'], ['bf_bu', 'f0_hi_L'], ['bf_bu', 'f0_hi_R']);
  for (const [a, b] of bumperCrush) {
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    fix({ a, b, type: 'support', k: K_BUMPER_BRACKET, d: sig3(0.8 * Math.sqrt((K_BUMPER_BRACKET * ma * mb) / (ma + mb))), deform: BUMPER_BRACKET_CRUSH, breakF: 0 });
  }
  const bumperStraps: [string, string][] = [];
  for (const s of ['L', 'R'] as const) bumperStraps.push([sid('bf', 'bl', s), sid('f3', 'lo', s)], [sid('bf', 'bu', s), sid('f3', 'hi', s)]);
  for (const [a, b] of bumperStraps) {
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    fix({ a, b, type: 'normal', k: K_BUMPER_STRAP, d: sig3(0.5 * Math.sqrt((K_BUMPER_STRAP * ma * mb) / (ma + mb))), deform: BUMPER_STRAP_YIELD, breakF: BUMPER_STRAP_SHEAR });
  }
  for (const t of ['f11_lo_L', 'f11_lo_R', 'f11_hi_L', 'f11_hi_R', 'br_bl', 'br_bl_L', 'br_bl_R', 'br_bu']) link(rearHitch, t, 'frame');

  // ---- engine: rigid block + mounts to the frame
  const block = [...engine, ...gearbox];
  for (let p = 0; p < block.length; p++)
    for (let q = p + 1; q < block.length; q++) {
      const a = block[p]!;
      const b = block[q]!;
      const gbxPair = gearbox.includes(a) || gearbox.includes(b);
      if (gbxPair && !(gearbox.includes(a) && gearbox.includes(b)) && (pos.get(a)![2] < -1.9 || pos.get(b)![2] < -1.9)) continue;
      link(a, b, 'engine');
    }
  const framePool = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].flatMap((s) => stationIds.get(s)!);
  for (const e of block) for (const n of nearest(e, framePool, 3)) link(e, n, 'engMount');

  // ---- front suspension pivots → frame anchors (sedan.ts anchors(): 4 of the 8 nearest spanning space best)
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
            const det = M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) - M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) + M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
            const score = det / sumD;
            if (score > bestScore + 1e-12) {
              bestScore = score;
              best = set;
            }
          }
    return best;
  };
  const frameNodes = FRAME.flatMap((st) => stationIds.get(st.id)!);
  for (const [, ids] of corners) {
    const pool = frameNodes.filter((id) => Math.abs(pos.get(id)![2] - Z_F) < 0.8);
    for (const p of [...ids.lower, ...ids.upper, ids.link]) for (const n of anchors(p, pool)) link(p, n, 'subframe');
  }
  {
    const L = corners.get('FL')!;
    const R = corners.get('FR')!;
    const sf = (a: string, b: string): void => fix({ a, b, type: 'normal', k: K_SUBFRAME, d: D_ARM, deform: SUBFRAME_DEFORM, breakF: SUBFRAME_BREAK });
    sf(L.lower[0]!, R.lower[0]!);
    sf(L.lower[1]!, R.lower[1]!);
    sf(L.lower[0]!, R.lower[1]!);
    sf(R.lower[0]!, L.lower[1]!);
    sf(L.link, R.link);
    for (const s of [L, R]) {
      sf(s.lower[0]!, s.lower[1]!);
      sf(s.link, s.lower[1]!);
      sf(s.link, s.lower[0]!);
      link(s.upper[0]!, s.upper[1]!, 'subframe');
    }
  }
  // Rear link pivots → frame anchors.
  {
    const pool = frameNodes.filter((id) => Math.abs(pos.get(id)![2] - Z_R) < 1.0);
    for (const s of ['L', 'R'] as const) for (const p of [axle.get(s)!.lp, axle.get(s)!.up]) for (const n of anchors(p, pool)) link(p, n, 'subframe');
    for (const p of [panL, panR]) for (const n of anchors(p, pool)) link(p, n, 'subframe');
  }

  // ---- front suspension (fixed stiffness)
  const motionRatio = { front: 0, rear: 0 };
  const shockK = { front: 0, rear: 0 };
  const shockD = { front: 0, rear: 0 };
  const preload = { front: 0, rear: 0 };
  const arbK = { front: 0 };
  const hydroTravel = { L: 0, R: 0 };
  {
    const g = FRONT;
    const mS = sprungFront;
    const kW = wheelRate.front;
    const Rc = corners.get('FR')!;
    const Lc = corners.get('FL')!;
    const hubI = pos.get(Rc.hubI)!;
    const tower = pos.get(Rc.tower)!;
    const kin = travelKinematics(g, hubI, pos.get(Rc.hubO)!, pos.get(Rc.kU)!);
    const mr = -dot(kin.vI, unit(sub(hubI, tower)));
    const uArb = unit(sub(pos.get(Rc.kU)!, pos.get(Lc.hubI)!));
    const mirrorV = (v: V3): V3 => [-v[0], v[1], v[2]];
    const hRate = dot(sub(kin.vU, mirrorV(kin.vI)), uArb);
    const rRate = dot(sub(kin.vU, mirrorV(kin.vI).map((c) => -c)), uArb);
    arbK.front = sig3((ARB_FRACTION_FRONT * kW) / (rRate * rRate));
    const k = (kW - arbK.front * hRate * hRate) / (mr * mr);
    const Fs = (mS * G) / mr;
    const P = Fs - k * PICKUP_TARGETS.staticSuspensionSag * mr;
    const c = (DAMPER_CALIBRATION * PICKUP_TARGETS.dampingRatio * 2 * Math.sqrt(kW * mS)) / (mr * mr);
    motionRatio.front = mr;
    shockK.front = sig3(k);
    shockD.front = sig3(c);
    preload.front = sig3(P);
    const bound = round(FRONT_SHOCK_TRAVEL / len(sub(hubI, tower)), 3);
    for (const s of ['L', 'R'] as const) {
      const ids = corners.get(`F${s}`)!;
      fix({ a: ids.hubI, b: ids.hubO, type: 'normal', k: K_AXLE_STUB, d: D_ARM, deform: 0, breakF: 0 });
      for (const p of ids.lower) fix({ a: ids.hubI, b: p, type: 'normal', k: K_LOWER_ARM, d: D_ARM, deform: 1.1e5, breakF: 2.2e5 });
      for (const p of ids.upper) fix({ a: ids.kU, b: p, type: 'normal', k: K_UPPER_ARM, d: D_ARM, deform: 8e4, breakF: 1.6e5 });
      fix({ a: ids.hubI, b: ids.tower, type: 'shock', k: shockK.front, d: shockD.front, preload: preload.front, boundsLow: bound, boundsHigh: bound, deform: 0, breakF: 1.5e5 });
      const pI = pos.get(ids.hubI)!;
      const pO = pos.get(ids.hubO)!;
      const rack = pos.get(ids.link)!;
      const u = unit(sub(pos.get(ids.kU)!, pI));
      const L0 = len(sub(pO, rack));
      const Lat = (ang: number): number => len(sub(rotateAbout(pO, pI, u, ang), rack));
      const d = PICKUP_TARGETS.maxWheelAngleRad;
      hydroTravel[s] = round((Lat(-d) - Lat(d)) / (2 * L0), 4);
      fix({ a: ids.link, b: ids.hubO, type: 'hydro', k: K_TOE_LINK, d: D_ARM, hydroTravel: hydroTravel[s], deform: 0, breakF: 0 });
    }
    const dArb = sig3(0.1 * Math.sqrt(arbK.front * KNUCKLE_NODE_MASS));
    fix({ a: Lc.hubI, b: Rc.kU, type: 'normal', k: arbK.front, d: dArb, deform: 0, breakF: 1.2e5 });
    fix({ a: Lc.kU, b: Rc.hubI, type: 'normal', k: arbK.front, d: dArb, deform: 0, breakF: 1.2e5 });
  }

  // ---- rear live axle (fixed stiffness)
  {
    const L = axle.get('L')!;
    const R = axle.get('R')!;
    const rigid = (a: string, b: string, k = K_AXLE): void => fix({ a, b, type: 'normal', k, d: D_ARM, deform: 0, breakF: 0 });
    // Housing: kU L/R, brackets L/R and the diff, all pairs (non-coplanar: a rigid body); each upright's hubs hang on it.
    const body = [L.kU, L.ab, R.kU, R.ab, axD];
    for (let p = 0; p < body.length; p++) for (let q = p + 1; q < body.length; q++) rigid(body[p]!, body[q]!);
    for (const a of [L, R]) {
      rigid(a.hubI, a.hubO, K_AXLE_STUB);
      rigid(a.hubI, a.ab);
      rigid(a.hubI, axD);
      rigid(a.hubO, a.ab, K_AXLE_STUB);
      rigid(a.hubO, axD, K_AXLE_STUB * 0.5);
      fix({ a: a.hubI, b: a.lp, type: 'normal', k: K_TRAIL, d: D_ARM, deform: 1.2e5, breakF: 2.4e5 });
      fix({ a: a.kU, b: a.up, type: 'normal', k: K_TRAIL, d: D_ARM, deform: 1.2e5, breakF: 2.4e5 });
    }
    fix({ a: L.kU, b: panR, type: 'normal', k: K_PANHARD, d: D_ARM, deform: 1.2e5, breakF: 2.4e5 });
    fix({ a: R.kU, b: panL, type: 'normal', k: K_PANHARD, d: D_ARM, deform: 1.2e5, breakF: 2.4e5 });
    // Spring + damper: bracket → frame spring tower. Heave and roll both move each bracket ≈ vertically.
    const ab = pos.get(R.kU)!;
    const tw = pos.get(sid('f9', 'tw', 'R'))!;
    const mr = dot([0, 1, 0], unit(sub(tw, ab)));
    const kW = wheelRate.rear;
    const mS = sprungRear;
    // The spring sits inboard of the wheel (bracket x 0.66 vs tyre centre 0.86): roll rate × (0.66/0.86)²; heave = wheel rate.
    const k = kW / (mr * mr);
    const Fs = (mS * G) / mr;
    const P = Fs - k * PICKUP_TARGETS.staticSuspensionSag * mr;
    const c = (DAMPER_CALIBRATION * PICKUP_TARGETS.dampingRatio * 2 * Math.sqrt(kW * mS)) / (mr * mr);
    motionRatio.rear = mr;
    shockK.rear = sig3(k);
    shockD.rear = sig3(c);
    preload.rear = sig3(P);
    const bound = round(REAR_SHOCK_TRAVEL / len(sub(tw, ab)), 3);
    for (const a of [L, R]) {
      const s = a === L ? 'L' : 'R';
      fix({ a: a.kU, b: sid('f9', 'tw', s), type: 'shock', k: shockK.rear, d: shockD.rear, preload: preload.rear, boundsLow: bound, boundsHigh: bound, deform: 0, breakF: 1.5e5 });
    }
  }

  // ---- hood beams (sedan.ts layout: skin grid, hinges at the clip's rear apron, latch on the radiator support, rests on the fenders)
  const subBeams: RigBeamDef[] = [];
  type SB = { a: string; b: string; w: number; kind: 'skin' | 'hinge' | 'latch' | 'rest' };
  const emitSub = (list: SB[], spec: typeof HOOD | typeof TAILGATE): void => {
    const own = (id: string): boolean => id.startsWith('hood_') || id.startsWith('tg_');
    const wsum = new Map<string, number>();
    for (const b of list) for (const id of [b.a, b.b]) if (own(id)) wsum.set(id, (wsum.get(id) ?? 0) + b.w);
    const share = (id: string): number => (own(id) ? (BUDGET_PER_KG * massOf.get(id)!) / wsum.get(id)! : Infinity);
    for (const { a, b, w, kind } of list) {
      const k = sig3(0.995 * w * Math.min(share(a), share(b)));
      const ma = massOf.get(a)!;
      const mb = massOf.get(b)!;
      const d = sig3(2 * spec.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
      const L = dist(a, b);
      if (seen.has(key(a, b))) throw new Error(`pickup: duplicate sub-rig beam ${a}–${b}`);
      seen.add(key(a, b));
      if (kind === 'skin') {
        const deform = sig3(Math.max(spec.yieldStrain * k * L, spec.minDeform));
        subBeams.push({ a, b, type: 'normal', k, d, deform, breakF: sig3(spec.breakRatio * deform) });
      } else if (kind === 'hinge') subBeams.push({ a, b, type: 'normal', k, d, deform: spec.hingeDeform, breakF: spec.hingeBreak });
      else if (kind === 'latch') subBeams.push({ a, b, type: 'normal', k, d, deform: 0, breakF: spec.latchBreak });
      else subBeams.push({ a, b, type: 'support', k, d, deform: 0, breakF: spec.restBreak });
    }
  };
  {
    const hb: SB[] = [];
    const H = (r: number, c: number): string => hoodIds[r]![c]!;
    for (let r = 0; r < HOOD_Z.length; r++)
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
    for (const s of ['L', 'R'] as const) {
      const c = s === 'L' ? 0 : 2;
      hb.push({ a: H(3, c), b: sid('s2', 'ai', s), w: 1.5, kind: 'hinge' });
      hb.push({ a: H(3, c), b: sid('s2', 'fd', s), w: 1.5, kind: 'hinge' });
      hb.push({ a: H(0, c), b: sid('s0', 'rh', s), w: 1, kind: 'latch' });
      hb.push({ a: H(0, c), b: sid('s0', 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(1, c), b: sid('s1', 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(1, c), b: sid('s1', 'ai', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid('s2', 'fd', s), w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, c), b: sid('s2', 'ai', s), w: 0.5, kind: 'rest' });
    }
    hb.push({ a: H(0, 1), b: sid('s0', 'rt'), w: 1, kind: 'latch' });
    hb.push({ a: H(1, 1), b: sid('s0', 'rt'), w: 0.5, kind: 'rest' });
    hb.push({ a: H(3, 1), b: sid('c0', 'cw'), w: 0.5, kind: 'rest' });
    for (const s of ['L', 'R'] as const) {
      hb.push({ a: H(1, 1), b: `eng_fhi_${s}`, w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, 1), b: `eng_rhi_${s}`, w: 0.5, kind: 'rest' });
      hb.push({ a: H(3, 1), b: sid('c0', 'fw', s), w: 0.5, kind: 'rest' });
    }
    emitSub(hb, HOOD);
  }
  // ---- tailgate beams: two-layer 2 × 3 box grid; hinges at the bed sill (bottom row), latches at the post tops.
  const tailgateHinges: [string, string][] = [];
  const tailgateLatches: [string, string][] = [];
  {
    const tb: SB[] = [];
    const cols = ['L', 'C', 'R'] as const;
    const all: string[] = [];
    for (let r = 0; r < 2; r++) for (const c of cols) for (const l of ['i', 'o'] as const) all.push(tg(r, c, l));
    // Every pair within a column pair (adjacent columns) — a braced box, no out-of-plane mechanism.
    for (let p = 0; p < all.length; p++)
      for (let q = p + 1; q < all.length; q++) {
        const a = all[p]!;
        const b = all[q]!;
        const ca = cols.indexOf(a[4] as 'L');
        const cb = cols.indexOf(b[4] as 'L');
        if (Math.abs(ca - cb) > 1) continue;
        tb.push({ a, b, w: a[3] === b[3] && a[5] !== b[5] ? 0.8 : 1, kind: 'skin' });
      }
    for (const s of ['L', 'R'] as const) {
      for (const l of ['i', 'o'] as const) {
        tb.push({ a: tg(0, s, l), b: sid('b3', 'bo', s), w: 1.5, kind: 'hinge' });
        tailgateHinges.push([tg(0, s, l), sid('b3', 'bo', s)]);
      }
      tb.push({ a: tg(0, s, 'i'), b: sid('b3', 'fl', s), w: 1.0, kind: 'hinge' });
      tailgateHinges.push([tg(0, s, 'i'), sid('b3', 'fl', s)]);
      tb.push({ a: tg(1, s, 'i'), b: sid('b3', 'rl', s), w: 1.5, kind: 'latch' });
      tb.push({ a: tg(1, s, 'o'), b: sid('b3', 'rl', s), w: 1.0, kind: 'latch' });
      tailgateLatches.push([tg(1, s, 'i'), sid('b3', 'rl', s)], [tg(1, s, 'o'), sid('b3', 'rl', s)]);
    }
    emitSub(tb, TAILGATE);
  }

  // ---- auto stiffness: split each node's budget by class weight (sedan.ts)
  const fixedK = new Map<string, number>();
  const addK = (id: string, k: number): void => void fixedK.set(id, (fixedK.get(id) ?? 0) + k);
  for (const b of [...fixed, ...subBeams]) {
    addK(b.a, b.k!);
    addK(b.b, b.k!);
  }
  for (const w of wheels) for (const id of w.attach) addK(id, 2 * (w.attachSpring ?? ATTACH_SPRING));
  const W = new Map<string, number>();
  for (const b of auto) {
    W.set(b.a, (W.get(b.a) ?? 0) + b.w);
    W.set(b.b, (W.get(b.b) ?? 0) + b.w);
  }
  const share = (id: string): number => {
    const perKg = stationOf.has(id) || id === 'hitch' ? SHELL_BUDGET_PER_KG : BUDGET_PER_KG;
    const budget = perKg * massOf.get(id)! - (fixedK.get(id) ?? 0);
    if (!(budget > 0)) throw new Error(`pickup: node ${id} has no stiffness budget left (${budget.toFixed(0)})`);
    return budget / W.get(id)!;
  };
  const kOf = auto.map(({ a, b, w }) => sig3(0.995 * w * Math.min(share(a), share(b))));

  /*
   * CRASH SECTIONS (sedan.ts): beams spanning consecutive stations of the
   * FRAME or the CAB yield together at the gap's axial section force F_g:
   * longitudinal members carry F_g in equal shares, the gap's diagonals
   * yield at the same closure (floored), in-station members at 3× it.
   */
  const gapOf = (a: string, b: string): string | null => {
    const sa = stationOf.get(a);
    const sb = stationOf.get(b);
    if (sa === undefined || sb === undefined) return null;
    const pa = sa[0]!;
    if (pa !== sb[0] || (pa !== 'f' && pa !== 'c')) return null;
    const ia = Number(sa.slice(1));
    const ib = Number(sb.slice(1));
    if (Math.abs(ia - ib) !== 1) return null;
    return `${pa}${Math.min(ia, ib)}`;
  };
  const gapYield = (g: string): number => (g[0] === 'f' ? FRAME_GAP_YIELD[Number(g.slice(1))]! : CAB_GAP_YIELD[Number(g.slice(1))]!);
  const czOf = (a: string, b: string): number => Math.abs(pos.get(a)![2] - pos.get(b)![2]) / dist(a, b);
  const isLong = (i: number): boolean => auto[i]!.w > CLASSES[auto[i]!.cls].w * 1.01;
  const gapLongCz = new Map<string, number>();
  auto.forEach(({ a, b, cls }, i) => {
    const g = gapOf(a, b);
    if (g === null || cls === 'glass' || !isLong(i)) return;
    gapLongCz.set(g, (gapLongCz.get(g) ?? 0) + czOf(a, b));
  });
  const longDeform = (g: string): number => gapYield(g) / gapLongCz.get(g)!;
  const travelSum = new Map<string, number>();
  const travelN = new Map<string, number>();
  auto.forEach(({ a, b, cls }, i) => {
    const g = gapOf(a, b);
    if (g === null || cls === 'glass' || !isLong(i)) return;
    travelSum.set(g, (travelSum.get(g) ?? 0) + longDeform(g) / (kOf[i]! * czOf(a, b)));
    travelN.set(g, (travelN.get(g) ?? 0) + 1);
  });
  const gapTravel = (g: string | undefined): number => (g !== undefined && travelN.has(g) ? travelSum.get(g)! / travelN.get(g)! : 0);
  const autoBeams: RigBeamDef[] = auto.map(({ a, b, cls }, i) => {
    const spec = CLASSES[cls];
    const k = kOf[i]!;
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    const d = sig3(2 * spec.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
    if (spec.yieldStrain === 0) return { a, b, type: 'normal', k, d, deform: 0, breakF: 0 };
    if (cls === 'glass') {
      const ws = stationOf.get(a) !== stationOf.get(b) && ['cw', 'ap'].some((t) => tagOf.get(a) === t || tagOf.get(b) === t);
      return { a, b, type: 'normal', k, d, deform: 0, breakF: sig3((ws ? WINDSCREEN_BREAK_STRAIN : GLASS_BREAK_STRAIN) * k * dist(a, b)) };
    }
    if (FIREWALL_PANEL.test(a) || FIREWALL_PANEL.test(b)) {
      const deform = sig3(Math.max(0.15 * k * dist(a, b), 8e3));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(6 * deform) };
    }
    if (DOOR_NODES.test(a) || DOOR_NODES.test(b)) {
      const deform = sig3(Math.max(DOOR_YIELD_STRAIN * k * dist(a, b), DOOR_MIN_DEFORM));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(spec.breakRatio * deform) };
    }
    const g = gapOf(a, b);
    let section = 0;
    if ((cls === 'cage' || cls === 'frame' || cls === 'horn') && g !== null && gapLongCz.has(g)) {
      section = isLong(i)
        ? longDeform(g)
        : Math.max(k * gapTravel(g) * Math.max(czOf(a, b), SHEAR_YIELD_FLOOR), (cls === 'cage' ? SHEAR_FORCE_SHARE : FRAME_SHEAR_FORCE_SHARE) * longDeform(g));
    } else if ((cls === 'cage' || cls === 'frame') && g === null) {
      const st = stationOf.get(a);
      if (st !== undefined && st === stationOf.get(b) && (st[0] === 'f' || st[0] === 'c')) {
        const n = Number(st.slice(1));
        const near = Math.max(gapTravel(`${st[0]}${n - 1}`), gapTravel(`${st[0]}${n}`));
        section = k * near * IN_STATION_YIELD_FACTOR;
      }
    }
    if (section === 0 && spanKeys.has(key(a, b))) section = CABIN_SPAN_YIELD_STRAIN * k * dist(a, b);
    const base = section > 0 ? section : spec.yieldStrain * k * dist(a, b);
    const deform = sig3(Math.max(base, spec.minDeform));
    // Frame rails fold, they never snap: a horn chord that broke in tension at 6× its (low) section
    // yield let the next station telescope through the tip.
    const floor = cls === 'frame' || cls === 'horn' ? FRAME_MIN_BREAK : 0;
    return { a, b, type: 'normal', k, d, deform, breakF: sig3(Math.max(spec.breakRatio * deform, floor)) };
  });

  // ---- damping budget: (Σd/m)·dt ≤ DAMP_BUDGET per node (auto + sub-rig beams scaled down).
  {
    const sumD = new Map<string, number>();
    for (const b of [...autoBeams, ...fixed, ...subBeams]) for (const id of [b.a, b.b]) sumD.set(id, (sumD.get(id) ?? 0) + (b.d ?? 0));
    for (const w of wheels) for (const id of w.attach) sumD.set(id, (sumD.get(id) ?? 0) + 2 * (w.attachDamp ?? 0));
    const scale = (id: string): number => {
      const m = massOf.get(id);
      if (m === undefined) return 1;
      const z = (sumD.get(id)! * DT) / m;
      return z > DAMP_BUDGET ? DAMP_BUDGET / z : 1;
    };
    for (const b of [...autoBeams, ...subBeams]) {
      const f = Math.min(scale(b.a), scale(b.b));
      if (f < 1) b.d = sig3(b.d! * f);
    }
  }

  // Sub-rigs (hood, tailgate) declared last, like the sedan's hood.
  const beams = [...autoBeams, ...fixed, ...subBeams];
  const def: VehicleDef = {
    name: 'pickup',
    body: {
      name: 'pickup.body',
      nodes,
      beams,
      groupDefaults: {
        body: { friction: 0.5, radius: 0.05 },
        engine: { friction: 0.5, radius: 0.08 },
        subframe: { friction: 0.5, radius: 0.04 },
        knuckle: { friction: 0.5, radius: 0.03 },
        axle: { friction: 0.5, radius: 0.06 },
        hood: { friction: 0.5, radius: 0.03 },
        tailgate: { friction: 0.5, radius: 0.03 },
      },
    },
    wheels,
    drivetrain: DRIVETRAIN,
    brakes: { frontBias: 0.64, handbrakeTorqueMax: 2200, abs: true, esc: true },
    aero: { dragCoeffArea: 1.45, liftCoeffArea: 0.1 },
    // R-PHYS: asymmetric digressive dampers (dampers.ts: rebound 2.6 : 1 bump, knee 0.1 m/s)
    dampers: { front: true, rear: true },
    steering: { maxWheelAngleDeg: round((PICKUP_TARGETS.maxWheelAngleRad * 180) / Math.PI, 2) },
    frame: { origin: sid('c2', 'tn'), front: sid('s0', 'rs'), top: sid('c2', 'rf') },
    // Feel pass: rigid shell cluster (shell.ts) — crumple zones released whole on impact, firewall, safety cell.
    // R-CRASH crush unloading: gentle on the crumple members, off for the held cab / frame (the stiff
    // body-on-frame front already rebounded 8–10 %; α 40 took it to 5 %, α 3: 6.6 / 7.2 % at 50 / 100 km/h).
    crushUnload: 3,
    crushUnloadHeld: 1,
    shell: shellLayout({
      front: ['f0_*', 'f1_*', 'f2_*', 'f3_*', 's0_*', 's1_*', 's2_*', 'bf_*', 'hood_*', 'FL_*', 'FR_*'],
      rear: ['b0_*', 'b1_*', 'b2_*', 'b3_*', 'br_*', 'tg_*', 'hitch*', 'f8_*', 'f9_*', 'f10_*', 'f11_*', 'RL_*', 'RR_*'],
      firewall: ['c0_*'],
      cell: ['c1_*', 'c2_*', 'c3_*', 'c4_*'],
      cellWhole: true,
      // frame rails under the cab: rigid while driving, bend (plastically) in a big crash
      extra: [{ ids: ['f4_*', 'f5_*', 'f6_*', 'f7_*'], release: SHELL_RELEASE_FRAME, yield: true }],
    }),
  };
  const design: PickupDesign = {
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
    hydroTravel,
    bodyNodeCount: nodes.length,
    bodyBeamCount: beams.length,
    cabMounts,
    bedMounts,
    tailgateHinges,
    tailgateLatches,
    bumperStraps,
  };
  return { def, design };
}

/** First-order kinematics of a front corner (sedan.ts travelKinematics). */
function travelKinematics(g: CornerGeom, I: V3, O: V3, U: V3): { vI: V3; vO: V3; vU: V3 } {
  const rot = (a: readonly number[], b: readonly number[], pt: V3): V3 => cross(unit(sub(b, a)), sub(pt, a));
  const wI = rot(g.lowerPivots[0], g.lowerPivots[1], I);
  const wU = rot(g.upperPivots[0], g.upperPivots[1], U);
  const T = g.linkPivot;
  const dOI = sub(O, I);
  const dOU = sub(O, U);
  const dOT = sub(O, T);
  const dUI = sub(U, I);
  const A = [
    [0, dOI[0], dOI[1], dOI[2]],
    [-dot(wU, dOU), dOU[0], dOU[1], dOU[2]],
    [0, dOT[0], dOT[1], dOT[2]],
    [dot(wU, dUI), 0, 0, 0],
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

const BUILT = buildPickup();

/** The pickup VehicleDef (plain JSON). Wheels FL, FR, RL, RR. */
export const PICKUP: VehicleDef = BUILT.def;
/** Derived design numbers (mass/CG solve, suspension rates, mounts). */
export const PICKUP_DESIGN: PickupDesign = BUILT.design;

/** Crash-harness node sets (src/sim/vehicle/crash.ts CrashProbes). */
export const PICKUP_CRASH_PROBES = {
  front: ['f0_lo_*', 'f0_hi_*'],
  cabin: ['c2_fl_*', 'c2_sl_*'],
  firewall: ['c0_fl_*', 'c0_sl_*', 'c0_hp_*', 'c0_cw_*'],
  cellRear: ['c4_*'],
  cellFront: ['c0_*'],
  doorMid: ['c1_dm_*'],
  doorR: 'c1_dm_R',
  doorL: 'c1_dm_L',
  sillR: 'c1_sl_R',
  sillL: 'c1_sl_L',
  exemptPrefixes: ['bf_', 'br_', 'hood_', 'tg_', 's0_', 's1_', 's2_', 'b0_', 'b1_', 'b2_', 'b3_', 'hitch'],
  latch: [['hood_0C', 's0_rt']],
  bumperPrefix: 'bf_',
  windscreen: ['c0_cw', 'c1_rf'],
} as const;
