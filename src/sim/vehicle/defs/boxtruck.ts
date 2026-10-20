/**
 * BOXTRUCK — medium-duty conventional box truck, 6500 kg loaded (6.7 L
 * turbo-diesel inline-6, 6-speed auto, RWD on dual rear wheels, open diff),
 * body-on-frame (docs/CONTRACTS.md "P6 contracts", fleet targets F3).
 *
 * PURE DATA MODULE (P2 boundary amendment): main-thread code may import it.
 * Generated once at module load by a deterministic procedure (no RNG, fixed
 * iteration order). Adapted from defs/pickup.ts (never imported from it).
 *
 * Vehicle frame: up +Y, forward −Z, right +X. Ground y = 0, tyres just
 * touching in the rest pose (wheel centres at y = WHEEL_RADIUS).
 *
 * STRUCTURE — separate sub-structures, each a chain of cross-section
 * stations (right half authored, mirrored), tied together only by breakable
 * MOUNT beams, so in a crash they shift and tear relative to each other:
 *   frame  `f{i}_{lo|hi}_{L|R}` straight ladder frame, f0 (horn tips, z −3.62)
 *          … f13 (rear crossmember, z +3.70); crossmember centres `f3_x`,
 *          `f7_x` (the vehicle frame nodes); spring towers f2_tw / f10_tw.
 *   clip   `s{i}_*` front clip (radiator support s0, inner aprons + fender
 *          tops s1, s2) on the frame horns; fender bolts to the cab cowl.
 *   cab    `c{i}_*` short-hood conventional cab, c0 cowl / firewall … c3 back
 *          wall: sedan-style rings, cabin spans, cross-cabin diagonals, one
 *          door per side (c1 hinge pillar … c3), on 4 + 4 + 4 cab mounts.
 *   box    `b{i}_*` b0 front wall … b7 rear portal (roller door frame): floor
 *          (centre fc, runners fi on the frame rails, sills fl), walls (wl, wm),
 *          roof (rail rl, centre rc), floor at 1.24 m. Aluminium posts and a
 *          skin node `bp{i}_{cell}_{L|R}` in the middle of every wall panel
 *          (the skin dents between the posts); the box sits on the frame on
 *          breakable mounts at every station.
 *   guards `gd{i}_{lo|hi}_{L|R}` side underride guards between the axles:
 *          two steel rails on four posts hung from the box sills, braced to
 *          the frame rails.
 * plus the hood sub-rig `hood_{r}{L|C|R}` (sedan contract layout, latched to
 * the radiator support), the front bumper `bf_*` and rear underride bar
 * `br_*` on the frame ends, the I6 block `eng_*` / gearbox `gbx_*` on frame
 * mounts.
 *
 * SUSPENSION — front: a forged I-BEAM AXLE (`FA_*`, rigid body: kingpin tops
 * / bottoms, spring seats, centre drop, steering-arm pivots) on two parallel
 * leading links per side (the leaf spring's front half) + crossed Panhard
 * rods; each knuckle (hubI, hubO) swivels about its kingpin (kT–kB) and is
 * steered by a hydro tie rod from the axle's steering arm. Rear: a LIVE AXLE
 * (`RA_*`) carrying DUAL wheels per side (outer RL / RR = telemetry corners,
 * inner RLi / RRi), located like the front; each dual pair is bolted together
 * by crossed rim-to-rim beams, so the pair spins as one. Spring/dampers run
 * from the axles' spring seats to frame towers; torsion anti-roll bars front
 * and rear (`arb{F|R}_*`, ARB_SPEC) carry most of the roll stiffness and the
 * leaf packs' roll damping.
 */
import { SHELL_RELEASE_DENT, shellLayout } from '../shellDefs';
import type { RigBeamDef, RigNodeDef } from '../../rig/types';
import { wheelNodeId, type DrivetrainDef, type VehicleDef, type WheelDef } from '../types';

// ====================================================================== targets
const DT = 1 / 2000;
const G = 9.81;
export const BOXTRUCK_TARGETS = {
  totalMass: 6500,
  wheelbase: 4.7,
  /** Front tyre centre track. */
  trackFront: 2.04,
  /** Rear dual-pair centre track (mid-way between the inner and outer tyre centres). */
  trackRear: 1.86,
  /** Rear dual spacing (inner ↔ outer tyre centre). */
  dualSpacing: 0.33,
  /** Static front axle share (loaded). */
  frontAxleShare: 0.35,
  /** CG height in the REST pose (contract ≥ 1.35 m). */
  cgHeightMin: 1.35,
  rideHzFront: 2.6,
  rideHzRear: 1.6,
  dampingRatio: 0.6,
  maxWheelAngleRad: 0.87,
  powerKw: 180,
  torqueNm: 900,
  /** Governed top speed (rev limiter in 6th), km/h. */
  governedKmh: 110,
} as const;

const Z_F = -2.75;
const Z_R = Z_F + BOXTRUCK_TARGETS.wheelbase;
const HALF_TRACK_F = BOXTRUCK_TARGETS.trackFront / 2;
const X_DUAL_IN = (BOXTRUCK_TARGETS.trackRear - BOXTRUCK_TARGETS.dualSpacing) / 2;
const X_DUAL_OUT = (BOXTRUCK_TARGETS.trackRear + BOXTRUCK_TARGETS.dualSpacing) / 2;
const X_DUAL_MID = BOXTRUCK_TARGETS.trackRear / 2;

/**
 * 245/70R19.5-class regional truck tyre on a 19.5" steel disc wheel (0.43 m
 * radius, 10 rays). Derived from the pickup tuning (LT 0.39 m, 5 kN) with the
 * carcass springs scaled ×2.4 for an ≈ 11 kN wheel load; a heavy rim
 * (steel disc + brake drum) carries the stiff sidewall within ω·dt.
 * Grip: one μ on every tyre, steer and drive alike. 0.65 is a loaded
 * regional-haul tyre on dry asphalt (heavy truck tyres run high contact
 * pressure and peak well below a car tyre's ≈ 0.9–1.0); 80–0 in ≈ 41 m.
 */
export const BOXTRUCK_TIRE = {
  radius: 0.43,
  rimRadius: 0.25,
  width: 0.2,
  rays: 10,
  tireNodeRadius: 0.055,
  tireContactSpring: 1.7e5,
  treadBrushStiffness: 8e4,
  treadBrushDamping: 90,
  rimHoopTension: 1,
  treadHoopTension: 0.5,
  rollingResistance: 0.007,
  tireRingSpring: 9.5e4,
  tireRingDamp: 14,
  rimSpring: 1.6e5,
  rimDamp: 20,
  sidewallSpring: 3.6e5,
  sidewallDamp: 34,
  hubMass: 50,
  rimMass: 88,
  tireMass: 52,
  friction: 0.65,
} as const satisfies Partial<WheelDef>;

/** Lateral tread-brush stiffness per tread node, N/m, per axle (the rear has four tyres). */
const FRONT_BRUSH = 1.2e5;
const REAR_BRUSH = 3e5;
const WHEEL_RADIUS = BOXTRUCK_TIRE.radius;
const Y_W = WHEEL_RADIUS;

const OMEGA_DT_TARGET = 0.33;
const BUDGET_PER_KG = (OMEGA_DT_TARGET / DT) ** 2;
/** Shell nodes (group 'body': frame, clip, cab, box, guards, bumpers) run stiffer for crash response. */
const SHELL_OMEGA_DT_TARGET = 0.485;
const SHELL_BUDGET_PER_KG = (SHELL_OMEGA_DT_TARGET / DT) ** 2;

// ====================================================================== suspension geometry (used by the frame towers)
/** Front I-beam axle (right side; mirrored). */
const FA = {
  /** Kingpin top = the spring seat (the spring sits right over the wheel load: no lever through the axle body). */
  kT: [0.86, 0.62, Z_F + 0.035] as [number, number, number],
  /** Kingpin bottom: with kT 7.5° of caster (4.7 cm of trail at the ground) — without it the knuckles steered into the turn under side load. */
  kB: [0.9, 0.28, Z_F - 0.01] as [number, number, number],
  /** Panhard rod end / axle beam spring pad. */
  sp: [0.62, 0.52, Z_F] as [number, number, number],
  c: [0, 0.4, Z_F + 0.1] as [number, number, number],
  /** Knuckle steering arm (part of the knuckle, behind the hub line). */
  arm: [1.0, 0.43, Z_F + 0.26] as [number, number, number],
  /**
   * Tie-rod end on the axle: placed so the hydro runs tangential to the arm's steer arc (an inboard pivot
   * at the hub height gave 6e4 N·m/rad of steer stiffness: ±3° of tramp steer at 60 km/h).
   */
  st: [0.63, 0.43, Z_F + 0.44] as [number, number, number],
  /**
   * Leading links to the front hanger: lower from kB, upper from kT, PARALLEL to the long axis (converging
   * links turn the axle's lateral compliance into yaw: compliance steer).
   */
  lp: [0.9, 0.28, Z_F - 0.62] as [number, number, number],
  up: [0.86, 0.62, Z_F - 0.6] as [number, number, number],
  pan: [0.42, 0.62, Z_F + 0.22] as [number, number, number],
};
/** Rear hub spacing (hubI ↔ hubO). */
const REAR_HUB_SPACING = 0.36;
/**
 * Rear live axle (right side; mirrored). The axle end carries the dual pair: the end node ae over the
 * outer dual, the brackets ab / af below the pair centre (with them inboard at the inner dual, the outer
 * dual cantilevered off the end and carried a quarter less than the inner one).
 */
const RA = {
  /** Spring seat (wide, over the inner dual). */
  kU: [0.62, 0.62, Z_R] as [number, number, number],
  /** Axle end (top of the tube by the hubs): the duals' upright reference. */
  ae: [X_DUAL_OUT, 0.58, Z_R] as [number, number, number],
  /** Brackets under the tube, behind / ahead. */
  ab: [X_DUAL_MID, 0.28, Z_R + 0.2] as [number, number, number],
  af: [X_DUAL_MID, 0.28, Z_R - 0.2] as [number, number, number],
  D: [0, 0.42, Z_R - 0.25] as [number, number, number],
  /** Trailing links forward to the hangers, parallel to the long axis and level with their axle ends (sloped or converging links make roll / compliance steer: the axle steered 0.7° out of a 0.5 g turn). */
  lp: [X_DUAL_MID, 0.28, Z_R - 0.78] as [number, number, number],
  up: [0.62, 0.62, Z_R - 0.66] as [number, number, number],
  pan: [0.42, 0.66, Z_R + 0.12] as [number, number, number],
};
// ====================================================================== beam classes
/**
 * `w` = stiffness share of a node's budget, `zeta` = damping ratio on the
 * reduced mass, deform = max(yieldStrain·k·L, minDeform), breakF =
 * breakRatio·deform. Frame and cab gaps yield as a section (CRASH SECTIONS).
 */
const CLASSES = {
  frame: { w: 1.2, zeta: 0.35, yieldStrain: 0.05, minDeform: 6e4, breakRatio: 6 },
  horn: { w: 1.0, zeta: 0.4, yieldStrain: 0.018, minDeform: 2e4, breakRatio: 6 },
  clip: { w: 1.0, zeta: 0.4, yieldStrain: 0.02, minDeform: 3e3, breakRatio: 6 },
  bumper: { w: 1.0, zeta: 0.4, yieldStrain: 0.03, minDeform: 1.2e4, breakRatio: 5 },
  cage: { w: 1.3, zeta: 0.3, yieldStrain: 0.1, minDeform: 2.5e4, breakRatio: 5 },
  glass: { w: 0.4, zeta: 0.25, yieldStrain: 0.06, minDeform: 0, breakRatio: 1.7 },
  /** Box posts, bows and skin shear panels (aluminium: dents early, tears at 6× yield). */
  box: { w: 1.0, zeta: 0.35, yieldStrain: 0.006, minDeform: 2e3, breakRatio: 6 },
  /** Box floor runners and sills (one row, station to station): carry the cargo's fore-aft load into the mounts. */
  boxFloor: { w: 1.6, zeta: 0.35, yieldStrain: 0.03, minDeform: 1.5e4, breakRatio: 6 },
  /**
   * Box floor crossmembers (within a station) and floor diagonals (station to station): a side hit folds the
   * sill in between the posts. At boxFloor's yield they shoved the whole wall in elastically and it sprang
   * back out (sedan into the side at 50 km/h: 15 cm at the peak, 2 cm left); with the crossmembers at 1 kN
   * and the diagonals at 5 kN the wall keeps ≈ 18 cm. The diagonals also carry the walls' fore-aft load
   * onto the runners: at 4 kN a 50 km/h frontal racked the box 31 cm forward (column ≤ 30).
   */
  boxFloorX: { w: 1.6, zeta: 0.35, yieldStrain: 0.003, minDeform: 1e3, breakRatio: 6 },
  boxFloorD: { w: 1.6, zeta: 0.35, yieldStrain: 0.006, minDeform: 5e3, breakRatio: 6 },
  /** Freight ↔ box (spokes from the cargo node): stiff enough to brace the walls, yields early in a crash. */
  cargo: { w: 2.0, zeta: 0.4, yieldStrain: 0.02, minDeform: 6e3, breakRatio: 5 },
  /** Side underride guards (steel rails, posts and braces): bend at a car's bumper load, tear only far beyond it. */
  guard: { w: 1.0, zeta: 0.4, yieldStrain: 0.005, minDeform: 3e3, breakRatio: 12 },
  /** Box side skin (1 mm aluminium between the posts): dents early, tears at 6× yield. */
  skin: { w: 1.0, zeta: 0.35, yieldStrain: 0.006, minDeform: 2e3, breakRatio: 6 },
  /** Cab mounts: rubber-bushed bolts that shear in a hard crash. */
  mount: { w: 3, zeta: 0.35, yieldStrain: 0.02, minDeform: 1.5e4, breakRatio: 8 },
  /** Box U-bolts / shear plates onto the frame: hold a loaded box in a 50 km/h frontal, tear in bigger hits. */
  boxMount: { w: 3, zeta: 0.35, yieldStrain: 0.02, minDeform: 3e4, breakRatio: 4 },
  bumperMount: { w: 2, zeta: 0.4, yieldStrain: 0.05, minDeform: 5e4, breakRatio: 3 },
  subframe: { w: 3, zeta: 0.25, yieldStrain: 0.04, minDeform: 6e4, breakRatio: 5 },
  engMount: { w: 1.0, zeta: 0.3, yieldStrain: 0.04, minDeform: 2e4, breakRatio: 5 },
  engine: { w: 2.0, zeta: 0.2, yieldStrain: 0, minDeform: 0, breakRatio: 0 },
} as const;
type BeamClass = keyof typeof CLASSES;

// ====================================================================== stations
type Pt = readonly [tag: string, x: number, y: number];
type Part = 'frame' | 'clip' | 'cab' | 'box' | 'bumperF' | 'bumperR';
interface Station {
  /** Node id prefix + index, e.g. 'f3'. */
  id: string;
  part: Part;
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
 * Masses are BASE values (kg) before the total / axle-split solve. The front
 * rails (f1..f4) carry the diesel's mass (the block nodes are light, like the
 * sedan's P4 engine, so the rails get the stiffness budget a frontal needs);
 * f5..f7 carry the fuel tank, batteries and air tanks.
 */
/**
 * Frame node base masses per station (before the solve). The engine / gearbox
 * ride on f1–f4; the spring hangers, towers, link brackets and box mounts load
 * f8–f11 with fixed-stiffness joints, which come off those nodes' budgets
 * first (at 18 kg the rear hanger nodes had ≈ 1e5 N/m left for the rail
 * chords: the rear frame sheared 7° under the box in a 0.45 g turn).
 */
const FRAME_BASE_MASS = [50, 66, 76, 66, 40, 32, 32, 30, 28, 30, 30, 28, 22, 22] as const;
const RAIL_X = 0.43;
const RAIL_LO = 0.7;
const RAIL_HI = 0.98;
const rail = (x = RAIL_X): Pt[] => [
  ['lo', x, RAIL_LO],
  ['hi', x, RAIL_HI],
];
const FRAME_Z = [-3.62, -3.2, Z_F, -2.32, -1.75, -1.18, -0.6, 0.0, 0.62, 1.28, Z_R, 2.6, 3.15, 3.7] as const;
const FRAME: readonly Station[] = FRAME_Z.map((z, i): Station => {
  const base = FRAME_BASE_MASS[i]!;
  const st: Station = {
    id: `f${i}`,
    part: 'frame',
    z,
    ring: rail(),
    closed: true,
    bulkhead: i !== 1,
    cls: i <= 1 ? 'horn' : 'frame',
    mass: { lo: base, hi: base, tw: 106, x: 14 },
  };
  if (i === 2) return { ...st, extra: [['tw', FA.kT[0], 1.06]] };
  if (i === 10) return { ...st, extra: [['tw', RA.kU[0], 1.0]] };
  if (i === 3 || i === 7) return { ...st, extra: [['x', 0, 0.86]] };
  return st;
});

/** Front clip: radiator support, inner aprons, fender tops (sheet metal + the fibreglass nose on the frame horns). */
const CLIP: readonly Station[] = [
  {
    id: 's0', part: 'clip', z: -3.55, closed: true, bulkhead: true, cls: 'clip', mass: { rs: 12, rl: 12, rh: 8, fd: 8, rt: 8 },
    ring: [['rs', 0, 0.86], ['rl', 0.62, 0.86], ['fd', 1.08, 1.12], ['rh', 0.64, 1.56], ['rt', 0, 1.58]],
  },
  { id: 's1', part: 'clip', z: -3.0, closed: false, bulkhead: false, cls: 'clip', mass: { ap: 9, ai: 7, fd: 8 }, ring: [['ap', 0.7, 0.96], ['ai', 0.74, 1.5], ['fd', 1.15, 1.26]] },
  { id: 's2', part: 'clip', z: -2.48, closed: false, bulkhead: false, cls: 'clip', mass: { ap: 9, ai: 7, fd: 8 }, ring: [['ap', 0.72, 1.0], ['ai', 0.76, 1.56], ['fd', 1.16, 1.32]] },
];

const CAB_FLOOR = 1.16;
const CAB_RING = (y0: number): Pt[] => [
  ['tn', 0, y0 + 0.04],
  ['fl', 0.6, y0],
  ['sl', 1.13, 1.1],
  ['dm', 1.165, 1.6],
  ['bt', 1.15, 1.98],
  ['rf', 1.03, 2.56],
  ['rf', 0, 2.62],
];
const CAB: readonly Station[] = [
  {
    id: 'c0', part: 'cab', z: -2.32, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 14, fl: 16, sl: 16, hp: 13, ap: 12, cw: 12, fw: 10 },
    ring: [['tn', 0, CAB_FLOOR + 0.04], ['fl', 0.6, CAB_FLOOR], ['sl', 1.12, 1.1], ['hp', 1.155, 1.6], ['ap', 1.12, 1.96], ['cw', 0, 1.99]],
    extra: [['fw', 0.5, 1.6]],
  },
  { id: 'c1', part: 'cab', z: -2.08, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 12, fl: 18, sl: 16, dm: 11, bt: 11, rf: 9 }, ring: CAB_RING(CAB_FLOOR) },
  { id: 'c2', part: 'cab', z: -1.48, closed: true, bulkhead: false, cls: 'cage', mass: { tn: 12, fl: 20, sl: 15, dm: 9, bt: 9, rf: 8 }, ring: CAB_RING(CAB_FLOOR) },
  {
    id: 'c3', part: 'cab', z: -0.88, closed: true, bulkhead: true, cls: 'cage', mass: { tn: 14, fl: 18, sl: 15, qm: 11, bt: 11, rf: 9 },
    ring: [['tn', 0, CAB_FLOOR + 0.04], ['fl', 0.6, CAB_FLOOR], ['sl', 1.13, 1.1], ['qm', 1.16, 1.6], ['bt', 1.15, 1.98], ['rf', 1.02, 2.55], ['rf', 0, 2.61]],
  },
];

/**
 * BOX: floor centre fc, runner fi (on the frame rail), sill fl, wall rows wl /
 * wm, roof rail rl, roof centre rc. b0 = front wall (bulkhead), b7 = rear
 * portal (roller-door frame). Cargo mass rides on the floor and low wall
 * nodes (`CARGO`), the box structure on all of them.
 */
const BOX_Z = [-0.6, 0.0, 0.62, 1.28, Z_R, 2.6, 3.15, 3.7] as const;
/** Box floor height (the runners sit on 0.08 m sub-frame sills over the rails). */
const BOX_FLOOR_Y = 1.24;
export const BOX_DIMS = { halfWidth: 1.24, floorY: BOX_FLOOR_Y, roofY: BOX_FLOOR_Y + 2.24, front: BOX_Z[0], rear: BOX_Z[BOX_Z.length - 1]!, stations: BOX_Z.length } as const;
const BOX_RING: Pt[] = [
  ['fc', 0, BOX_FLOOR_Y],
  ['fi', RAIL_X, BOX_FLOOR_Y - 0.08],
  ['fl', 1.22, BOX_FLOOR_Y],
  ['wl', 1.24, BOX_FLOOR_Y + 0.66],
  ['wm', 1.24, BOX_FLOOR_Y + 1.44],
  ['rl', 1.22, BOX_FLOOR_Y + 2.22],
  ['rc', 0, BOX_FLOOR_Y + 2.26],
];
/**
 * Base box structure masses per node (kg) + cargo per node (loaded). The load
 * itself is a CARGO node `b{i}_cg` per station (light freight — furniture,
 * parcels — stacked to the roof, its centre 1.9 m above the floor: the
 * loaded CG at rest ≥ 1.35 m) on spokes to every ring node: it
 * bears on the floor and braces the walls (an empty pin-jointed box frame
 * buckles under its own wall weight), and in a crash or rollover the spokes
 * yield, so the freight shifts and the box crushes and racks around it.
 */
/** Chassis / cab / box base masses → kg (the freight nodes take the remainder of the 6.5 t). */
const STRUCTURE_MASS_SCALE = 0.448;
const BOX_MASS = { fc: 6, fi: 14, fl: 11, wl: 7, wm: 6, rl: 7, rc: 7, cg: 0 } as const;
const CARGO = { fc: 0, fi: 6, fl: 6, wl: 6, wm: 8, rl: 6, rc: 3, cg: 560 } as const;
const CARGO_Y = BOX_FLOOR_Y + 2.06;
/** Spokes from the freight node to the roof row (rl, rc): yield force, N (elastic in driving; a rollover crushes the roof). */
const CARGO_TOP = /^b\d_(rl_[LR]|rc)$/;
const CARGO_TOP_YIELD = 2.5e3;
const BOX: readonly Station[] = BOX_Z.map((z, i): Station => {
  const mass: Record<string, number> = {};
  for (const k of Object.keys(BOX_MASS) as (keyof typeof BOX_MASS)[]) mass[k] = BOX_MASS[k] + CARGO[k] * (i === 0 || i === BOX_Z.length - 1 ? 0.5 : 1);
  return { id: `b${i}`, part: 'box', z, ring: BOX_RING, closed: true, bulkhead: i === 0, cls: 'box', mass, extra: [['cg', 0, CARGO_Y]] };
});

const BUMPERS: readonly Station[] = [
  {
    id: 'bf', part: 'bumperF', z: -3.76, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 12, bo: 9, bu: 12, bk: 12, bh: 12 },
    ring: [['bl', 0, 0.5], ['bl', 0.55, 0.5], ['bo', 1.12, 0.6], ['bu', 0.55, 0.88], ['bu', 0, 0.88]],
    // Bracket feet on the bar's back face, square in front of the rail's lower and upper flange lines.
    extra: [['bk', RAIL_X, RAIL_LO], ['bh', RAIL_X, 0.88]],
  },
  {
    id: 'br', part: 'bumperR', z: 3.78, closed: true, bulkhead: true, cls: 'bumper', mass: { bl: 22, bo: 10, bu: 22 },
    ring: [['bl', 0, 0.44], ['bl', 0.6, 0.44], ['bo', 1.1, 0.48], ['bu', 0.6, 0.6], ['bu', 0, 0.6]],
  },
];

const STRUCTURES: readonly (readonly Station[])[] = [FRAME, CLIP, CAB, BOX, BUMPERS.slice(0, 1), BUMPERS.slice(1)];

/**
 * Axial section yield force of FRAME gap g (f_g → f_g+1), N: the crumple
 * zone is the frame horns ahead of the front axle (f0 → f2) and the clip;
 * f2 → f3 yields late, the frame behind never in a frontal.
 */
const FRAME_GAP_YIELD: readonly number[] = [2.4e5, 3.6e5, 1.4e6, 1.2e7, 1.2e7, 1.2e7, 1.2e7, 1.2e7, 1.2e7, 1.2e7, 1e7, 8e6, 6e6];
/** Cab gaps (safety cell): never yield in a frontal. */
const CAB_GAP_YIELD: readonly number[] = [1.4e6, 1.4e6, 1.2e6];
const SHEAR_YIELD_FLOOR = 0.8;
const SHEAR_FORCE_SHARE = 0.6;
const FRAME_SHEAR_FORCE_SHARE = 1.2;
/** Frame web diagonals yield at this multiple of a chord's share of the gap's section force. */
const FRAME_WEB_DIAG_FACTOR = 2.5;
const FRAME_MIN_BREAK = 8e5;
/** In-station frame members (rail webs, crossmembers): yield floor, N. */
const FRAME_SECTION_MIN_YIELD = 1.5e6;
const IN_STATION_YIELD_FACTOR = 3;
const LONGITUDINAL_W = 4;
const FRAME_LONGITUDINAL_W = 24;
/**
 * Horn chords (f0 → f2 flanges): a larger share of the horn nodes' budget than the frame's 1-bay chords.
 * The horns crush progressively at the FRAME_GAP_YIELD section forces and spring back by their elastic
 * part: at the frame's weight (24) a 50 km/h hit peaked at 46 cm and left 22 (springback 52 %); at 72 the
 * crush is 26–30 cm permanent from 47.5 to 52.5 km/h. Pushed past ≈ 50 cm the horns fold under onto the
 * front tyres (≈ 60 cm, the 64 km/h case).
 */
const HORN_CHORD_W = 72;
/**
 * Web diagonals (lo_i ↔ hi_i+1) carry the rail's vertical shear. At weight 4
 * a bay's shear stiffness was ≈ 80 kN/m: in a 50 km/h frontal the horns
 * folded in a Z at no force, the cab section dropped onto the axle and the
 * truck stood on its nose (rear 4 m up, box on the cab roof).
 */
const FRAME_WEB_W = 32;
const FRAME_SPANS: readonly (readonly [number, number])[] = [
  [2, 4],
  [3, 5],
  [4, 6],
  [5, 7],
  [6, 8],
  [7, 9],
  [8, 10],
  [9, 11],
  [10, 12],
];
const FRAME_SHEAR_W = 40;
const FRAME_XMEMBER_W = 16;
/**
 * 3–4-bay frame spans (cab section → box): axial stiffness of a line of
 * beams is Σ k·L, so the long ones carry far more per unit of the node
 * budget than 1-bay chords.
 */
const FRAME_LONG_SPANS: readonly (readonly [number, number])[] = [
  [2, 5],
  [3, 6],
  [4, 7],
  [5, 8],
  [6, 9],
  [3, 7],
  [4, 8],
  [5, 9],
  [6, 10],
];
const FRAME_LONG_SPAN_W = 30;
const LINKS_PER_NODE = 3;
const DAMP_BUDGET = 0.95;
const GLASS_BREAK_STRAIN = 0.03;
const WINDSCREEN_BREAK_STRAIN = 0.016;
const DOOR_NODES = /^c2_(dm|bt|sl)_/;
const DOOR_YIELD_STRAIN = 0.04;
const DOOR_MIN_DEFORM = 5e3;
const FIREWALL_PANEL = /^c0_fw_/;
const GLASS_TAGS: readonly (readonly [string, string])[] = [
  ['bt', 'rf'],
  ['cw', 'rf'],
  ['ap', 'rf'],
];
const CABIN_SPANS: readonly (readonly [number, string, number, string])[] = [
  [0, 'sl', 2, 'sl'],
  [1, 'sl', 3, 'sl'],
  [0, 'fl', 2, 'fl'],
  [1, 'fl', 3, 'fl'],
  [0, 'tn', 2, 'tn'],
  [1, 'tn', 3, 'tn'],
  [1, 'rf', 3, 'rf'],
  [1, 'bt', 3, 'bt'],
  [0, 'hp', 2, 'sl'],
  [1, 'sl', 3, 'bt'],
  [1, 'bt', 3, 'sl'],
];
const CABIN_SPAN_YIELD_STRAIN = 0.25;
const CROSS_CABIN: readonly (readonly [number, string, string])[] = [
  [0, 'ap', 'sl'],
  [1, 'rf', 'sl'],
  [1, 'bt', 'fl'],
  [3, 'rf', 'sl'],
  [3, 'bt', 'fl'],
  // Back wall (a solid panel round a small window): crossed both ways, so the cab roof stands on it upside down.
  [3, 'bt', 'sl'],
  [3, 'qm', 'fl'],
  [3, 'rf', 'fl'],
];
/** Side underride guard: rail line just inside the box wall, rail heights, node mass, rail weight, contact radius. */
const GUARD_X = 1.17;
const GUARD_LO_Y = 0.48;
const GUARD_HI_Y = 0.84;
const GUARD_NODE_MASS = 12;
const GUARD_RAIL_W = 3;
const GUARD_OBJ_RADIUS = 0.2;
/** Box side skin nodes (one per wall panel): base mass, contact radius. */
const SKIN_NODE_MASS = 4;
const SKIN_OBJ_RADIUS = 0.24;
/** Box wall / roof nodes get a big object-contact sphere (node spacing ≈ 0.65 m): no gap for a car's nodes to slip through. */
const BOX_OBJ_RADIUS = 0.3;

// ====================================================================== suspension geometry
const FRONT_SHOCK_TRAVEL = 0.1;
const REAR_SHOCK_TRAVEL = 0.1;
const FRONT_HUB_SPACING = 0.32;
const FRONT_HUB_MASS = 64;
const REAR_HUB_MASS = 58;
const FA_NODE_MASS = { kT: 37, kB: 30, sp: 24, c: 26, st: 24, arm: 21 } as const;
const RA_NODE_MASS = { kU: 56, ae: 40, ab: 47, af: 47, D: 60 } as const;
const K_AXLE = 1.4e6;
/**
 * Rear axle housing (the live axle's end tetrahedra + cross members): it carries two thirds of the truck
 * from spring seats 0.31 m inboard of the inner duals. At K_AXLE it bent 17 mm under the static load, the
 * hub line cambered 1.1° and the outer duals carried 25 % less than the inner ones (the inside outer dual
 * left the ground at 0.2 g).
 */
const K_REAR_AXLE = 2.5e6;
/** Fixed joints onto the frame (fixedLink). */
const K_TOWER = 1.5e6;
const K_CAB_MOUNT = 1.2e6;
const K_BOX_MOUNT = 1.6e6;
const K_BUMPER_MOUNT = 1.4e6;
/**
 * Engine / gearbox block: 10 nodes carrying the 6.7 L I6 and the gearbox (the rest of the drivetrain mass rides
 * on the front rails), on fixed-stiffness mounts that yield at ENG_MOUNT_YIELD each — in a frontal the block
 * stacks against the radiator and pushes on the frame through them instead of sliding back loose.
 */
const ENGINE_BLOCK_NODE_MASS = 12;
const K_ENG_MOUNT = 8e5;
const ENG_MOUNT_YIELD = 1.2e5;
/** Radiator / fan stack (radiator support → engine front, compression only): stiffness, crush force per member. */
const K_RAD_STACK = 6e5;
const RAD_STACK_YIELD = 8e4;
/** Front bumper crush-bracket axial yield, N per square bracket member (≈ 0.45 MN for the bar). */
const BUMPER_BRACKET_YIELD = 1.4e5;
const K_ANCHOR = 1.2e6;
const K_BELLY = 2.6e6;
/**
 * Belly-truss member yield, N. The truss is the frame's bending depth under
 * the cab and box: at the default 5 % strain (60–200 kN) it yielded in the
 * first 0.1 s of a 50 km/h frontal, and the frame then folded up at f7 under
 * the box's pitch moment (rear frame 3 m in the air, box nose on the cab).
 */
const BELLY_YIELD = 2.5e6;
/** Belly truss nodes (z = f5, f8 stations), height, mass (tank + batteries). */
const BELLY_Z = [-1.18, 0.62] as const;
const BELLY_Y = 0.45;
const BELLY_MASS = 44;
const K_KNUCKLE = 1.8e6;
const K_STUB = 2.0e6;
const K_TIE_ROD = 3.0e6;
const D_STEER = 6000;
const K_LINK = 2.6e6;
const K_PANHARD = 2.4e6;
const ATTACH_SPRING = 1.8e6;
const ATTACH_DAMP = 700;
const D_ARM = 900;
const DAMPER_CALIBRATION = 1.6;
/** Dual-pair coupling (crossed rim-to-rim beams per ray: the two wheels are bolted together). */
const K_DUAL = 6e4;
const PIVOT_BUDGET_SHARE = 0.97;
const pivotMass = (fixedK: number): number => round(fixedK / (BUDGET_PER_KG * PIVOT_BUDGET_SHARE), 2);

/**
 * ANTI-ROLL BARS (`arb{F|R}_{A|T|U}_{L|R}`): a torsion bar across the frame
 * in two bushings (A, on the rail bottoms), each half a rigid body {A_L, A_R,
 * arm tip T, offset U} that can only turn about the A_L–A_R line; the arm
 * tips drop-link to the axle. The halves are coupled by two crossed beams
 * T_L–U_R / U_L–T_R: turning both halves together (heave) leaves them at
 * length, twisting one against the other (axle roll) stretches one and
 * compresses the other — pure roll stiffness, no heave rate. Rated as axle
 * roll stiffness about the axle's centre line, N·m/rad.
 *
 * Laden, the rear axle carries two thirds of the truck on leaf-spring seats
 * only 1.24 m apart (≈ 1.6e5 N·m/rad): without a bar the rear rolled ≈ 8° on
 * its springs at 0.45 g, twisted the frame against the stiffer front and
 * swung the box's CG 0.2 m outboard, so the inside rear duals left the
 * ground at 0.26 g and the truck tipped at 0.58 g on a tilt table.
 *
 * `rollC` (N·m·s/rad) is roll damping on the same torsion beams: a leaf-spring
 * truck's roll is damped mostly by the inter-leaf friction of its spring
 * packs, lumped here so it acts in roll only and leaves the ride (heave)
 * damping at its calibrated ζ. Without it the laden box's roll was damped at
 * ζ ≈ 0.3 by the shocks alone (seats 1.2–1.7 m apart under a 2.5 m box) and
 * a 40 km/h full-lock J-turn tipped at 0.47 g lateral, 75 % of the 0.62 g it
 * takes on a tilt table: the roll overshoot did the rest. The bar ends (T, U)
 * carry the leaf packs' mass so the damping stays within (Σd/m)·dt.
 */
const ARB_SPEC = {
  front: { tag: 'arbF', xArm: 0.62, axis: [0.6, Z_F + 0.42], tip: [0.84, Z_F], drop: 'FA_sp', rollK: 2.5e5, rollC: 6e4 },
  rear: { tag: 'arbR', xArm: RA.kU[0], axis: [0.62, Z_R - 0.5], tip: [0.9, Z_R - 0.1], drop: 'RA_kU', rollK: 4e5, rollC: 1e5 },
} as const;
/** Bushing x (under the rails), offset-node radius, rigid half-body / drop-link stiffness. */
const ARB_BUSH_X = RAIL_X;
const ARB_U_R = 1.4;
const K_ARB_BODY = 2e6;
const K_ARB_LINK = 2e6;
const D_ARB = 2000;

// ====================================================================== hood
const HOOD_Z = [-3.5, -3.1, -2.76, -2.46] as const;
const HOOD_Y = [1.6, 1.66, 1.71, 1.75] as const;
const HOOD_HALF_X = 0.74;
const HOOD_CROWN = 0.03;
const HOOD_NODE_MASS = 3;
const HOOD = {
  zeta: 0.5,
  yieldStrain: 0.03,
  minDeform: 3e3,
  breakRatio: 8,
  hingeDeform: 2.5e4,
  hingeBreak: 6e4,
  latchBreak: 8e3,
  restBreak: 3e4,
} as const;

// ====================================================================== drivetrain
/**
 * 6.7 L turbo-diesel I6: 900 N·m from 1200 to 1800 rpm, 180 kW from 2000 to
 * 2400 rpm, governor droop 2400–2700 rpm. Low gearing (Allison-style 6-speed, 5.1
 * final; the loaded tyres roll on ≈ 0.36 m) — the limiter in 6th caps the
 * truck at ≈ 110 km/h.
 */
const DRIVETRAIN: DrivetrainDef = {
  torqueCurve: [
    [0, 380],
    [600, 520],
    [800, 640],
    [1000, 780],
    [1200, 900],
    [1800, 900],
    [2000, 859],
    [2200, 781],
    [2400, 716],
    // Governor droop: full-load torque falls away above 2400 rpm, so the truck settles at ≈ 110 km/h in 6th
    // below the hard cut instead of sawing on it (the cut drops the speed ≈ 8 km/h each time).
    [2500, 640],
    [2600, 420],
    [2700, 150],
  ],
  idleRpm: 650,
  redlineRpm: 2500,
  revLimitRpm: 2700,
  engineInertia: 1.4,
  engineBrakeTorque: 260,
  gearRatios: [3.49, 1.86, 1.41, 1.0, 0.75, 0.63],
  reverseRatio: 5.03,
  finalDrive: 5.1,
  shiftTimeS: 0.35,
  autoShiftUpRpm: 2350,
  autoShiftDownRpm: 1200,
  diff: 'open',
  clutchMaxTorque: 1600,
  transmission: 'auto',
  tractionControl: 0.15,
};

// ====================================================================== generator helpers
type V3 = [number, number, number];
type Side = 'L' | 'R';
const SIDES = ['L', 'R'] as const;
const sideSign = (s: Side): number => (s === 'R' ? 1 : -1);
const other = (s: Side): Side => (s === 'R' ? 'L' : 'R');
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

/** Design numbers derived while generating (asserted by boxtruck.test.ts). */
export interface BoxtruckDesign {
  totalMass: number;
  cg: V3;
  frontAxleShare: number;
  unsprungAxle: { front: number; rear: number };
  sprungAxle: { front: number; rear: number };
  tireRate: number;
  wheelRate: { front: number; rear: number };
  shockK: { front: number; rear: number };
  shockD: { front: number; rear: number };
  preload: { front: number; rear: number };
  hydroTravel: { L: number; R: number };
  bodyNodeCount: number;
  bodyBeamCount: number;
  cabMounts: [string, string][];
  boxMounts: [string, string][];
  /** Dual-pair coupling beams. */
  dualLinks: [string, string][];
}

function buildBoxtruck(): { def: VehicleDef; design: BoxtruckDesign } {
  const nodes: RigNodeDef[] = [];
  const pos = new Map<string, V3>();
  const massOf = new Map<string, number>();
  const structure: string[] = [];
  const addNode = (id: string, p: readonly number[], mass: number, group: string, collidable = true, isStructure = true, objRadius?: number): string => {
    if (pos.has(id)) throw new Error(`boxtruck: duplicate node ${id}`);
    const q: V3 = [round(p[0]!), round(p[1]!), round(p[2]!)];
    nodes.push({ id, pos: q, mass, group, ...(collidable ? {} : { collidable: false }), ...(objRadius ? { objRadius } : {}) });
    pos.set(id, q);
    massOf.set(id, mass);
    if (isStructure) structure.push(id);
    return id;
  };

  // ---- shell stations
  const tagOf = new Map<string, string>();
  const stationOf = new Map<string, string>();
  const stationIds = new Map<string, string[]>();
  const stationRing = new Map<string, string[][]>();
  const sid = (st: string, tag: string, side?: Side): string => (side ? `${st}_${tag}_${side}` : `${st}_${tag}`);
  for (const chain of STRUCTURES) {
    for (const st of chain) {
      const ids: string[] = [];
      const right: string[] = [];
      const left: string[] = [];
      const centres: string[] = [];
      const add = (pt: Pt, onRing: boolean): void => {
        const [tag, x, y] = pt;
        const m = st.mass[tag];
        if (m === undefined) throw new Error(`boxtruck: station ${st.id} has no mass for tag ${tag}`);
        const sides: (Side | undefined)[] = x === 0 ? [undefined] : ['R', 'L'];
        const objR = st.part === 'box' && tag !== 'fi' && tag !== 'fc' ? BOX_OBJ_RADIUS : undefined;
        for (const s of sides) {
          const id = addNode(sid(st.id, tag, s), [s ? x * sideSign(s) : 0, y, st.z], m, 'body', true, true, objR);
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
  // Side underride guards (between the axles, under the box): two steel rails per side on posts at the box
  // stations b0–b3, braced to the box floor and to the frame rail (see the GUARD_* constants).
  const GUARD_STATIONS = [0, 1, 2, 3];
  const guards = new Map<Side, { lo: string[]; hi: string[] }>();
  for (const s of SIDES) {
    const lo: string[] = [];
    const hi: string[] = [];
    for (const i of GUARD_STATIONS) {
      for (const [row, y, list] of [
        ['lo', GUARD_LO_Y, lo],
        ['hi', GUARD_HI_Y, hi],
      ] as const) {
        const id = addNode(`gd${i}_${row}_${s}`, [GUARD_X * sideSign(s), y, BOX_Z[i]!], GUARD_NODE_MASS, 'body', true, true, GUARD_OBJ_RADIUS);
        tagOf.set(id, 'gd');
        list.push(id);
      }
    }
    guards.set(s, { lo, hi });
  }
  // Box side skin: a node at the middle of every wall panel (between two posts and two wall rows), so a hit
  // between the posts dents the aluminium skin there instead of shoving two whole posts.
  const SKIN_CELLS = [
    ['fl', 'wl'],
    ['wl', 'wm'],
    ['wm', 'rl'],
  ] as const;
  const skin: { id: string; corners: [string, string, string, string] }[] = [];
  for (let i = 0; i + 1 < BOX.length; i++)
    for (const s of SIDES)
      SKIN_CELLS.forEach(([r0, r1], c) => {
        const corners: [string, string, string, string] = [sid(BOX[i]!.id, r0, s), sid(BOX[i]!.id, r1, s), sid(BOX[i + 1]!.id, r0, s), sid(BOX[i + 1]!.id, r1, s)];
        const p = [0, 1, 2].map((k) => corners.reduce((a, id) => a + pos.get(id)![k]!, 0) / 4);
        const id = addNode(`bp${i}_${c}_${s}`, [BOX_DIMS.halfWidth * sideSign(s), p[1]!, p[2]!], SKIN_NODE_MASS, 'body', true, true, SKIN_OBJ_RADIUS);
        tagOf.set(id, 'bp');
        skin.push({ id, corners });
      });

  // Belly truss nodes (fuel tank / battery box carriers), group 'body' (shell budget).
  const belly = new Map<Side, string[]>();
  for (const s of SIDES)
    belly.set(
      s,
      BELLY_Z.map((z, k) => {
        const id = addNode(`kb${k}_${s}`, [RAIL_X * sideSign(s), BELLY_Y, z], BELLY_MASS, 'body');
        tagOf.set(id, 'kb');
        return id;
      }),
    );

  // ---- engine (I6, longitudinal) + gearbox: light nodes (the mass is in the front rails)
  const ENGINE_NODE_MASS = ENGINE_BLOCK_NODE_MASS;
  const engine: string[] = [];
  for (const z of [-3.3, -2.35])
    for (const y of [0.82, 1.36])
      for (const s of ['R', 'L'] as const) engine.push(addNode(`eng_${z < -2.8 ? 'f' : 'r'}${y < 1 ? 'lo' : 'hi'}_${s}`, [0.3 * sideSign(s), y, z], ENGINE_NODE_MASS, 'engine', true, false));
  const gearbox = SIDES.map((s) => addNode(`gbx_${s}`, [0.2 * sideSign(s), 0.86, -1.55], ENGINE_NODE_MASS, 'engine', true, false));

  // ---- front I-beam axle
  const fa = (k: keyof typeof FA, s?: Side): string => (s ? `FA_${k}_${s}` : `FA_${k}`);
  for (const s of SIDES) {
    addNode(fa('kT', s), mirror(FA.kT, s), FA_NODE_MASS.kT, 'axle', false, false);
    addNode(fa('kB', s), mirror(FA.kB, s), FA_NODE_MASS.kB, 'axle', true, false);
    addNode(fa('sp', s), mirror(FA.sp, s), FA_NODE_MASS.sp, 'axle', true, false);
    addNode(fa('st', s), mirror(FA.st, s), FA_NODE_MASS.st, 'axle', false, false);
    addNode(fa('arm', s), mirror(FA.arm, s), FA_NODE_MASS.arm, 'knuckle', false, false);
  }
  addNode(fa('c'), FA.c, FA_NODE_MASS.c, 'axle', true, false);
  const halfF = FRONT_HUB_SPACING / 2;
  for (const s of SIDES) {
    const c = `F${s}`;
    pos.set(wheelNodeId(c, 'hubI'), [round((HALF_TRACK_F - halfF) * sideSign(s)), Y_W, Z_F]);
    pos.set(wheelNodeId(c, 'hubO'), [round((HALF_TRACK_F + halfF) * sideSign(s)), Y_W, Z_F]);
  }
  // ---- rear live axle
  const ra = (k: keyof typeof RA, s?: Side): string => (s ? `RA_${k}_${s}` : `RA_${k}`);
  for (const s of SIDES) {
    addNode(ra('kU', s), mirror(RA.kU, s), RA_NODE_MASS.kU, 'axle', false, false);
    addNode(ra('ae', s), mirror(RA.ae, s), RA_NODE_MASS.ae, 'axle', false, false);
    addNode(ra('ab', s), mirror(RA.ab, s), RA_NODE_MASS.ab, 'axle', true, false);
    addNode(ra('af', s), mirror(RA.af, s), RA_NODE_MASS.af, 'axle', true, false);
  }
  addNode(ra('D'), RA.D, RA_NODE_MASS.D, 'axle', true, false);
  const halfR = REAR_HUB_SPACING / 2;
  const dualId = (s: Side, inner: boolean): string => `R${s}${inner ? 'i' : ''}`;
  for (const s of SIDES)
    for (const inner of [false, true]) {
      const x = inner ? X_DUAL_IN : X_DUAL_OUT;
      const c = dualId(s, inner);
      pos.set(wheelNodeId(c, 'hubI'), [round((x - halfR) * sideSign(s)), Y_W, Z_R]);
      pos.set(wheelNodeId(c, 'hubO'), [round((x + halfR) * sideSign(s)), Y_W, Z_R]);
    }
  // ---- suspension pivots on the frame (fixed-mass: sized for their beams)
  const linkPivotMass = pivotMass(K_LINK + 4 * K_ANCHOR);
  const panPivotMass = pivotMass(K_PANHARD + 4 * K_ANCHOR);
  for (const s of SIDES) {
    addNode(fa('lp', s), mirror(FA.lp, s), linkPivotMass, 'subframe', true, false);
    addNode(fa('up', s), mirror(FA.up, s), linkPivotMass, 'subframe', true, false);
    addNode(fa('pan', s), mirror(FA.pan, s), panPivotMass, 'subframe', true, false);
    // The rear spring hangers sit 0.45 m under the rails on long anchors: at the stiffness-sized mass the one
    // that the rear slammed onto after a 50 km/h nose-stand whipped to 18 m/s (crash.ts vLate); twice the mass
    // (≈ a forged hanger + the spring eye) keeps it with the frame.
    addNode(ra('lp', s), mirror(RA.lp, s), 2 * linkPivotMass, 'subframe', true, false);
    addNode(ra('up', s), mirror(RA.up, s), linkPivotMass, 'subframe', true, false);
    addNode(ra('pan', s), mirror(RA.pan, s), panPivotMass, 'subframe', true, false);
  }

  // ---- anti-roll bars: geometry, torsion-beam stiffness from the rated roll stiffness, node masses from Σk
  interface ArbBuilt {
    tag: string;
    A: Record<Side, string>;
    T: Record<Side, string>;
    U: Record<Side, string>;
    drop: string;
    kT: number;
    dT: number;
  }
  const arbs: ArbBuilt[] = [];
  for (const spec of [ARB_SPEC.front, ARB_SPEC.rear].filter((x) => x.rollK > 0)) {
    const [ya, za] = spec.axis;
    const [yt, zt] = spec.tip;
    const arm = [yt - ya, zt - za];
    const armLen = Math.hypot(arm[0]!, arm[1]!);
    // Offset node: perpendicular to the arm in the y–z plane, on the upper side.
    let perp = [-arm[1]! / armLen, arm[0]! / armLen];
    if (perp[0]! < 0) perp = [-perp[0]!, -perp[1]!];
    const P = (s: Side, k: 'T' | 'U'): V3 => {
      const x = spec.xArm * sideSign(s);
      return k === 'T' ? [x, yt, zt] : [x, ya + ARB_U_R * perp[0]!, za + ARB_U_R * perp[1]!];
    };
    // Torsion lever λ = ∂|T_L − U_R| / ∂(θ_L − θ_R) (rotation about the bar axis, numerically).
    const rotX = (p: V3, th: number): V3 => {
      const y = p[1] - ya;
      const z = p[2] - za;
      return [p[0], ya + y * Math.cos(th) - z * Math.sin(th), za + y * Math.sin(th) + z * Math.cos(th)];
    };
    const eps = 1e-6;
    const lam = Math.abs(len(sub(rotX(P('L', 'T'), eps), P('R', 'U'))) - len(sub(P('L', 'T'), P('R', 'U')))) / eps;
    // Axle roll φ moves the drop links ±xArm·φ vertically: arm turn ±xArm·φ/ℓ (ℓ = arm's fore-aft length).
    const gear = (2 * spec.xArm) / Math.abs(zt - za);
    const kT = sig3(spec.rollK / (2 * lam * lam * gear * gear));
    const dT = sig3(spec.rollC / (2 * lam * lam * gear * gear));
    const dampMass = (sumD: number): number => (sumD * DT) / 0.95;
    const mT = round(Math.max((3 * K_ARB_BODY + kT + K_ARB_LINK) / (SHELL_BUDGET_PER_KG * 0.97), dampMass(5 * D_ARB + dT)), 2);
    const mU = round(Math.max((3 * K_ARB_BODY + kT) / (SHELL_BUDGET_PER_KG * 0.97), dampMass(3 * D_ARB + dT)), 2);
    const mA = round((5 * K_ARB_BODY + 4 * K_ANCHOR) / (SHELL_BUDGET_PER_KG * 0.97), 2);
    const b: ArbBuilt = { tag: spec.tag, A: { L: '', R: '' }, T: { L: '', R: '' }, U: { L: '', R: '' }, drop: spec.drop, kT, dT };
    for (const s of SIDES) {
      b.A[s] = addNode(`${spec.tag}_A_${s}`, [spec.xArm * sideSign(s), ya, za], mA, 'body', false, false);
      b.T[s] = addNode(`${spec.tag}_T_${s}`, P(s, 'T'), mT, 'body', false, false);
      b.U[s] = addNode(`${spec.tag}_U_${s}`, P(s, 'U'), mU, 'body', false, false);
    }
    arbs.push(b);
  }

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

  // ---- wheels: FL, FR, RL, RR (outer duals = telemetry corners), RLi, RRi (inner duals)
  const unsprungWheel = (front: boolean): number => (front ? FRONT_HUB_MASS : REAR_HUB_MASS) + BOXTRUCK_TIRE.rimMass + BOXTRUCK_TIRE.tireMass;
  const wheel = (id: string): WheelDef => {
    const front = id[0] === 'F';
    return {
      ...BOXTRUCK_TIRE,
      hubMass: front ? FRONT_HUB_MASS : REAR_HUB_MASS,
      id,
      hubInner: pos.get(wheelNodeId(id, 'hubI'))!,
      hubOuter: pos.get(wheelNodeId(id, 'hubO'))!,
      axle: front ? 'front' : 'rear',
      steered: front,
      driven: !front,
      braked: true,
      brakeTorqueMax: 3150,
      treadBrushStiffness: front ? FRONT_BRUSH : REAR_BRUSH,
      friction: BOXTRUCK_TIRE.friction,
      handbrake: !front,
      // No WheelDef.attach: the hub links are body beams (kingpin / axle-end below). The tread brush puts a
      // wheel's overturning moment as a lateral force pair between the attach node and the hubs, F = M/h;
      // on these axles the only node above the hubs is 0.15–0.19 m up, and that pair (2.3× the tyre's side
      // force, onto the rigid axle) pumped a 5 Hz axle tramp. Without it the moment is a hub couple, which
      // the kingpin knuckle and the axle-end brackets carry.
      attach: front ? [] : [`RA_ae_${id.includes('L') ? 'L' : 'R'}`],
      attachSpring: ATTACH_SPRING,
      attachDamp: ATTACH_DAMP,
      attachBreakF: 3e5,
    };
  };
  const wheels = ['FL', 'FR', 'RL', 'RR', 'RLi', 'RRi'].map(wheel);
  const axleBody = (prefix: string): number => nodes.filter((n) => n.id.startsWith(prefix) && n.group === 'axle').reduce((a, n) => a + n.mass, 0);
  const unsprungAxle = { front: 2 * unsprungWheel(true) + axleBody('FA_'), rear: 4 * unsprungWheel(false) + axleBody('RA_') };

  // ---- mass distribution: the chassis, cab and box structure take their base masses × STRUCTURE_MASS_SCALE;
  // the FREIGHT nodes take the rest, m_i = b_i·(s + a·(z − z̄)), solved for the total mass and the static
  // axle split — the load's fore-aft position sets the split. (A solve over every node rescaled the whole
  // chassis whenever one part changed: the frame, towers and box lost a quarter of their stiffness budget
  // to a heavier engine block and the truck rolled softer.) The CG height follows (asserted by the test).
  {
    const M = BOXTRUCK_TARGETS.totalMass;
    const zcg = Z_R - BOXTRUCK_TARGETS.frontAxleShare * BOXTRUCK_TARGETS.wheelbase;
    const payload = (id: string): boolean => /^b\d+_cg$/.test(id);
    for (const id of structure) {
      if (payload(id)) continue;
      const n = nodes.find((q) => q.id === id)!;
      n.mass = round(massOf.get(id)! * STRUCTURE_MASS_SCALE, 3);
      massOf.set(id, n.mass);
    }
    let fm = 0;
    let fz = 0;
    for (const n of nodes) {
      if (payload(n.id)) continue;
      fm += n.mass;
      fz += n.mass * n.pos[2];
    }
    for (const w of wheels) {
      const uw = unsprungWheel(w.axle === 'front');
      fm += uw;
      fz += uw * w.hubInner[2];
    }
    const cargo = nodes.filter((n) => payload(n.id));
    let bSum = 0;
    let zBar = 0;
    for (const n of cargo) {
      bSum += n.mass;
      zBar += n.mass * n.pos[2];
    }
    zBar /= bSum;
    const A = [
      [0, 0],
      [0, 0],
    ];
    for (const n of cargo) {
      const z = n.pos[2];
      const basis = [1, z - zBar];
      const wts = [1, z];
      for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) A[r]![k]! += n.mass * wts[r]! * basis[k]!;
    }
    const coef = solveN(A, [M - fm, M * zcg - fz]);
    for (const n of cargo) {
      const m = n.mass * (coef[0]! + coef[1]! * (n.pos[2] - zBar));
      if (!(m > 0.5)) throw new Error(`boxtruck: mass solve gave ${m} kg for ${n.id}`);
      n.mass = round(m, 3);
      massOf.set(n.id, n.mass);
    }
  }

  // ---- totals, CG, axle loads
  let totalMass = 0;
  const cg: V3 = [0, 0, 0];
  const accum = (m: number, p: readonly number[]): void => {
    totalMass += m;
    for (let k = 0; k < 3; k++) cg[k]! += m * p[k]!;
  };
  for (const n of nodes) accum(n.mass, n.pos);
  for (const w of wheels) accum(unsprungWheel(w.axle === 'front'), [(w.hubInner[0] + w.hubOuter[0]) / 2, Y_W, w.hubInner[2]]);
  for (let k = 0; k < 3; k++) cg[k] = cg[k]! / totalMass;
  const frontAxleShare = (Z_R - cg[2]) / (Z_R - Z_F);
  const sprungAxle = { front: totalMass * frontAxleShare - unsprungAxle.front, rear: totalMass * (1 - frontAxleShare) - unsprungAxle.rear };
  /** Tyre rate ≈ 11 kN per 25 mm. */
  const tireRate = 11000 / 0.025;
  /** Per-side heave wheel rate for a sprung mass per side m at ride frequency hz, with `tyres` tyres in series. */
  const wheelRateFor = (m: number, hz: number, tyres: number): number => {
    const ride = m * (2 * Math.PI * hz) ** 2;
    const kt = tyres * tireRate;
    return (ride * kt) / (kt - ride);
  };
  const wheelRate = {
    front: wheelRateFor(sprungAxle.front / 2, BOXTRUCK_TARGETS.rideHzFront, 1),
    rear: wheelRateFor(sprungAxle.rear / 2, BOXTRUCK_TARGETS.rideHzRear, 2),
  };

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
    if (seen.has(k)) throw new Error(`boxtruck: duplicate beam ${k}`);
    seen.add(k);
    fixed.push(beam);
  };
  const dist = (a: string, b: string): number => len(sub(pos.get(a)!, pos.get(b)!));
  /**
   * A FIXED-stiffness structural joint (mounts, towers, pivot anchors): the frame nodes spend their
   * auto budget on the rail chords (weight 24), so a weight-1 joint onto them got ≈ 1e5 N/m and a
   * loaded box sat 5 cm deep in its mounts. Fixed k is taken off both nodes' budgets first.
   */
  const fixedLink = (a: string, b: string, cls: BeamClass, k: number, yieldF = 0): void => {
    const spec = CLASSES[cls];
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    const deform = sig3(Math.max(yieldF, spec.yieldStrain * k * dist(a, b), spec.minDeform));
    fix({ a, b, type: 'normal', k, d: sig3(2 * spec.zeta * Math.sqrt((k * ma * mb) / (ma + mb))), deform, breakF: sig3(spec.breakRatio * deform) });
  };
  /**
   * The n nearest of `pool`, MIRROR-SYMMETRIC: candidates tied with the last one taken (a node on the centre
   * line sees its mirrored neighbours at equal distance) are all taken. An id tie-break picked the R one only,
   * and the asymmetric cab / clip lattice gave the truck a steady pull.
   */
  const nearest = (from: string, pool: readonly string[], n: number): string[] => {
    const sorted = pool
      .filter((p) => p !== from)
      .map((p) => [p, dist(from, p)] as const)
      .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1));
    let m = Math.min(n, sorted.length);
    while (m > 0 && m < sorted.length && Math.abs(sorted[m]![1] - sorted[m - 1]![1]) < 1e-9) m++;
    return sorted.slice(0, m).map((x) => x[0]);
  };
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
      // Back glass: in the c3 plane between the belt and the roof rail.
      return sa === 'c3' && ((ta === 'bt' && tb === 'rf') || (ta === 'rf' && tb === 'bt')) && !sameColumn(a, b) && Math.abs(pos.get(a)![0] - pos.get(b)![0]) > 0.05;
    }
    return GLASS_TAGS.some(([x, y]) => (ta === x && tb === y) || (ta === y && tb === x)) && !sameColumn(a, b);
  };
  const isLongitudinal = (a: string, b: string): boolean => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    if (Math.sign(pa[0]) !== Math.sign(pb[0])) return false;
    return tagOf.get(a) === tagOf.get(b);
  };
  const boxFloorTag = (id: string): boolean => {
    const t = tagOf.get(id);
    return t === 'fc' || t === 'fi' || t === 'fl';
  };
  // Floor runners (one row, station to station) carry the fore-aft load; the crossmembers (boxFloorX) and
  // the floor's diagonals (boxFloorD) are what a side hit folds.
  const floorRow = (id: string): string => id.split('_').slice(1).join('_');
  const boxCls = (a: string, b: string): BeamClass =>
    boxFloorTag(a) && boxFloorTag(b) ? (floorRow(a) === floorRow(b) ? 'boxFloor' : a.split('_')[0] === b.split('_')[0] ? 'boxFloorX' : 'boxFloorD') : 'box';

  /** Rail web diagonals (lo_i ↔ hi_i+1): the bay's shear members, rated apart from the crushing chords. */
  const webDiagonals = new Set<string>();
  // FRAME: an explicit two-sided Pratt truss per rail (chords lo / hi, web diagonals, verticals) + crossmembers.
  FRAME.forEach((st, i) => {
    const cls = st.cls;
    for (const s of SIDES) link(sid(st.id, 'lo', s), sid(st.id, 'hi', s), cls, FRAME_WEB_W);
    if (st.bulkhead) {
      link(sid(st.id, 'lo', 'L'), sid(st.id, 'lo', 'R'), cls, FRAME_XMEMBER_W);
      link(sid(st.id, 'hi', 'L'), sid(st.id, 'hi', 'R'), cls, FRAME_XMEMBER_W);
      link(sid(st.id, 'lo', 'L'), sid(st.id, 'hi', 'R'), cls, FRAME_XMEMBER_W);
      link(sid(st.id, 'hi', 'L'), sid(st.id, 'lo', 'R'), cls, FRAME_XMEMBER_W);
    }
    for (const e of st.extra ?? []) {
      if (e[1] === 0) {
        // Crossmember centre node: to both flanges of both rails.
        for (const s of SIDES) for (const t of ['lo', 'hi']) link(sid(st.id, e[0]), sid(st.id, t, s), cls);
        continue;
      }
      for (const s of SIDES) {
        for (const t of ['lo', 'hi']) fixedLink(sid(st.id, e[0], s), sid(st.id, t, s), 'frame', K_TOWER);
        fixedLink(sid(st.id, e[0], s), sid(st.id, 'hi', other(s)), 'frame', K_TOWER);
        fixedLink(sid(st.id, e[0], s), sid(st.id, 'lo', other(s)), 'frame', 0.7 * K_TOWER);
      }
    }
    const nx = FRAME[i + 1];
    if (nx === undefined) return;
    const c: BeamClass = cls === 'horn' || nx.cls === 'horn' ? 'horn' : cls;
    for (const s of SIDES) {
      const chordW = c === 'horn' ? HORN_CHORD_W : FRAME_LONGITUDINAL_W;
      link(sid(st.id, 'lo', s), sid(nx.id, 'lo', s), c, chordW);
      link(sid(st.id, 'hi', s), sid(nx.id, 'hi', s), c, chordW);
      link(sid(st.id, 'lo', s), sid(nx.id, 'hi', s), c, FRAME_WEB_W);
      link(sid(st.id, 'hi', s), sid(nx.id, 'lo', s), c, FRAME_WEB_W);
      webDiagonals.add(key(sid(st.id, 'lo', s), sid(nx.id, 'hi', s)));
      webDiagonals.add(key(sid(st.id, 'hi', s), sid(nx.id, 'lo', s)));
    }
  });
  for (const chain of STRUCTURES) {
    if (chain === FRAME) continue;
    chain.forEach((st, i) => {
      const paths = stationRing.get(st.id)!;
      const ring = paths.flat();
      const ringCls = (a: string, b: string): BeamClass => (st.part === 'box' ? boxCls(a, b) : st.cls);
      for (const path of paths) for (let k = 0; k + 1 < path.length; k++) link(path[k]!, path[k + 1]!, ringCls(path[k]!, path[k + 1]!));
      if (st.closed) link(ring[ring.length - 1]!, ring[0]!, ringCls(ring[ring.length - 1]!, ring[0]!));
      const ids = stationIds.get(st.id)!;
      const reach = st.reach ?? 1.25;
      if (st.part === 'box') {
        // Box frame (posts + bows): corner gussets; the freight node braces the section (spokes to every ring node);
        // the front wall (bulkhead) is a triangulated panel on top.
        // Posts: corner gussets at the floor (fi–wl) and roof (wm–rc) plus a knee brace fi–wm, so a post
        // (fl–wl–wm–rl, pin-jointed) is not a parallelogram linkage between the floor and the roof bow.
        for (const s of SIDES) {
          link(sid(st.id, 'fi', s), sid(st.id, 'wl', s), 'box');
          link(sid(st.id, 'wm', s), sid(st.id, 'rc'), 'box', 0.6);
          link(sid(st.id, 'fi', s), sid(st.id, 'wm', s), 'box', 0.6);
        }
        for (const r of ring) link(sid(st.id, 'cg'), r, 'cargo');
        if (st.bulkhead) {
          for (let p = 0; p < ids.length; p++)
            for (let q = p + 1; q < ids.length; q++) {
              const a = ids[p]!;
              const b = ids[q]!;
              if (dist(a, b) <= reach) link(a, b, boxCls(a, b));
            }
          // Front wall panel: X across the middle, cross bars (a fully triangulated wall).
          link(sid(st.id, 'wl', 'R'), sid(st.id, 'wl', 'L'), 'box');
          link(sid(st.id, 'wm', 'R'), sid(st.id, 'wm', 'L'), 'box');
          link(sid(st.id, 'wl', 'R'), sid(st.id, 'wm', 'L'), 'box');
          link(sid(st.id, 'wl', 'L'), sid(st.id, 'wm', 'R'), 'box');
        }
      } else if (st.bulkhead) {
        for (let p = 0; p < ids.length; p++)
          for (let q = p + 1; q < ids.length; q++) {
            const a = ids[p]!;
            const b = ids[q]!;
            if (dist(a, b) > reach) continue;
            link(a, b, isGlass(a, b) ? 'glass' : ringCls(a, b));
          }
      } else {
        for (const e of ids) if (!ring.includes(e)) for (const n of nearest(e, ids, 3)) link(e, n, st.cls);
        for (let p = 0; p < ids.length; p++)
          for (let q = p + 1; q < ids.length; q++) {
            const a = ids[p]!;
            const b = ids[q]!;
            const pa = pos.get(a)!;
            const pb = pos.get(b)!;
            const same = Math.sign(pa[0]) === Math.sign(pb[0]) || pa[0] === 0 || pb[0] === 0;
            const lowCross = !same && Math.max(pa[1], pb[1]) < 1.2 && dist(a, b) <= 1.6;
            if ((same && dist(a, b) <= 0.9) || lowCross) link(a, b, st.cls);
          }
      }
      const nextSt = chain[i + 1];
      if (nextSt === undefined) return;
      if (st.part === 'box') {
        link(sid(st.id, 'cg'), sid(nextSt.id, 'cg'), 'cargo');
        // Freight on the floor: diagonals to the next / previous station's floor (runner + centre). The spokes
        // above lie in the station plane, so without these the freight's fore-aft inertia had no path but
        // tilting them: in a 50 km/h frontal the 2 t load ran forward at roof height, racked the box over
        // the cab and crushed it (cab roof −1.5 m, frame bent down under it, rear frame 4 m in the air).
        for (const [a, b] of [
          [st.id, nextSt.id],
          [nextSt.id, st.id],
        ] as const)
          for (const t of [sid(b, 'fi', 'L'), sid(b, 'fi', 'R'), sid(b, 'fc')]) link(sid(a, 'cg'), t, 'cargo');
        const nextRing = stationRing.get(nextSt.id)!.flat();
        for (const a of ring) for (const b of nearest(a, nextRing, LINKS_PER_NODE)) link(a, b, boxCls(a, b), isLongitudinal(a, b) ? LONGITUDINAL_W : 1);
        for (const b of nextRing) for (const a of nearest(b, ring, LINKS_PER_NODE)) link(a, b, boxCls(a, b), isLongitudinal(a, b) ? LONGITUDINAL_W : 1);
        return;
      }
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
  // Box: floor and roof X-bracing between stations (diaphragms), wall diagonals both ways (achiral shear panels).
  for (let i = 0; i + 1 < BOX.length; i++) {
    const a = BOX[i]!.id;
    const b = BOX[i + 1]!.id;
    for (const s of SIDES) {
      link(sid(a, 'fi', s), sid(b, 'fc'), 'boxFloor');
      link(sid(a, 'fc'), sid(b, 'fi', s), 'boxFloor');
      link(sid(a, 'rl', s), sid(b, 'rc'), 'box');
      link(sid(a, 'rc'), sid(b, 'rl', s), 'box');
    }
  }
  // Wall panels: skin spokes from each panel's middle node to its four corners (the panel's shear web).
  for (const { id, corners } of skin) for (const c of corners) link(id, c, 'skin');
  // Safety-cell chords + cross-cabin diagonals.
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
  // Roof bows: the (nearly flat) roof centre line hangs on the belt rails — a flat triangulated roof has no
  // stiffness out of its plane, and the cab roof centre sagged 15 cm.
  for (const st of CAB) if (pos.has(sid(st.id, 'bt', 'R'))) for (const s of SIDES) link(sid(st.id, 'rf'), sid(st.id, 'bt', s), 'cage');
  // Floor centre (tunnel) of the open mid station on the door pillars likewise.
  for (const s of SIDES) link(sid('c2', 'tn'), sid('c2', 'dm', s), 'cage');
  for (const [i, ta, tb] of CROSS_CABIN) {
    link(sid(`c${i}`, ta, 'R'), sid(`c${i}`, tb, 'L'), 'cage');
    link(sid(`c${i}`, ta, 'L'), sid(`c${i}`, tb, 'R'), 'cage');
  }
  // Frame: horizontal X-bracing of every bay at both flanges (lateral shear / yaw stiffness).
  for (let i = 0; i + 1 < FRAME.length; i++) {
    const a = FRAME[i]!.id;
    const b = FRAME[i + 1]!.id;
    link(sid(a, 'lo', 'R'), sid(b, 'lo', 'L'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'lo', 'L'), sid(b, 'lo', 'R'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'hi', 'R'), sid(b, 'hi', 'L'), FRAME[i]!.cls, FRAME_SHEAR_W);
    link(sid(a, 'hi', 'L'), sid(b, 'hi', 'R'), FRAME[i]!.cls, FRAME_SHEAR_W);
  }
  // Frame chord spans (bypass two bays: stiffer axially for the same budget).
  for (const [i, j] of FRAME_SPANS) for (const s of SIDES) for (const t of ['lo', 'hi']) link(sid(`f${i}`, t, s), sid(`f${j}`, t, s), 'frame', FRAME_LONGITUDINAL_W);
  for (const [i, j] of FRAME_LONG_SPANS) for (const s of SIDES) for (const t of ['lo', 'hi']) link(sid(`f${i}`, t, s), sid(`f${j}`, t, s), 'frame', FRAME_LONG_SPAN_W);
  // Spring towers: braced to both rail flanges of their and the neighbouring stations.
  for (const s of SIDES) {
    for (const t of [sid('f1', 'hi', s), sid('f1', 'lo', s), sid('f3', 'hi', s), sid('f3', 'lo', s)]) fixedLink(sid('f2', 'tw', s), t, 'frame', K_TOWER);
    for (const t of [sid('f9', 'hi', s), sid('f9', 'lo', s), sid('f11', 'hi', s), sid('f11', 'lo', s)]) fixedLink(sid('f10', 'tw', s), t, 'frame', K_TOWER);
  }

  // ---- belly truss: the fuel tank (left) / battery + air-tank box (right) carriers hang 0.25 m under the
  // rails between the axles and tie f2 … f10 as a king-post truss. The pin-jointed rails alone (0.28 m deep,
  // chords within the ω·dt budget) let the loaded frame sag 11 cm between the axles.
  for (const s of SIDES) {
    const kf = belly.get(s)![0]!;
    const kr = belly.get(s)![1]!;
    for (const [a, b] of [
      [sid('f2', 'lo', s), kf],
      [sid('f3', 'lo', s), kf],
      [kf, sid('f4', 'lo', s)],
      [kf, sid('f5', 'lo', s)],
      [kf, sid('f6', 'lo', s)],
      [kf, kr],
      [kr, sid('f7', 'lo', s)],
      [kr, sid('f8', 'lo', s)],
      [kr, sid('f9', 'lo', s)],
      [kr, sid('f10', 'lo', s)],
    ] as const)
      fixedLink(a, b, 'frame', K_BELLY, BELLY_YIELD);
  }
  fixedLink(belly.get('L')![0]!, belly.get('R')![0]!, 'frame', 0.5 * K_BELLY, BELLY_YIELD);
  fixedLink(belly.get('L')![1]!, belly.get('R')![1]!, 'frame', 0.5 * K_BELLY, BELLY_YIELD);
  fixedLink(belly.get('L')![0]!, belly.get('R')![1]!, 'frame', 0.5 * K_BELLY, BELLY_YIELD);
  fixedLink(belly.get('R')![0]!, belly.get('L')![1]!, 'frame', 0.5 * K_BELLY, BELLY_YIELD);

  // ---- front clip ↔ frame and ↔ cab cowl (fender bolts)
  for (const s of SIDES) {
    for (const [a, b] of [
      [sid('s0', 'rl', s), sid('f0', 'hi', s)],
      [sid('s0', 'rl', s), sid('f1', 'hi', s)],
      [sid('s0', 'rl', s), sid('f1', 'lo', s)],
      [sid('s0', 'rl', s), sid('f0', 'lo', s)],
      [sid('s1', 'ap', s), sid('f1', 'hi', s)],
      [sid('s1', 'ap', s), sid('f2', 'hi', s)],
      [sid('s1', 'ap', s), sid('f2', 'tw', s)],
      [sid('s1', 'ai', s), sid('f2', 'tw', s)],
      [sid('s2', 'ap', s), sid('f2', 'tw', s)],
      [sid('s2', 'ap', s), sid('f3', 'hi', s)],
      [sid('s2', 'ai', s), sid('f2', 'tw', s)],
    ] as const)
      link(a, b, 'clip');
    for (const [a, b] of [
      [sid('s2', 'fd', s), sid('c0', 'hp', s)],
      [sid('s2', 'fd', s), sid('c0', 'ap', s)],
      [sid('s2', 'ai', s), sid('c0', 'ap', s)],
      [sid('s2', 'ai', s), sid('c0', 'fw', s)],
      [sid('s2', 'ap', s), sid('c0', 'hp', s)],
    ] as const)
      link(a, b, 'mount', 0.6);
  }
  link('s0_rs', 'f0_lo_L', 'clip');
  link('s0_rs', 'f0_lo_R', 'clip');
  // Cab mounts: c0/c1 (front) on f3, c2 on f4, c3 (rear) on f5 / f6.
  const cabMounts: [string, string][] = [];
  for (const s of SIDES) {
    cabMounts.push(
      [sid('c0', 'fl', s), sid('f3', 'hi', s)],
      [sid('c0', 'sl', s), sid('f3', 'hi', s)],
      [sid('c0', 'fl', s), sid('f3', 'lo', s)],
      [sid('c1', 'fl', s), sid('f3', 'hi', s)],
      [sid('c2', 'fl', s), sid('f4', 'hi', s)],
      [sid('c2', 'sl', s), sid('f4', 'hi', s)],
      [sid('c2', 'fl', s), sid('f4', 'lo', s)],
      [sid('c1', 'fl', s), sid('f4', 'hi', s)],
      [sid('c3', 'fl', s), sid('f5', 'hi', s)],
      [sid('c3', 'sl', s), sid('f5', 'hi', s)],
      [sid('c3', 'fl', s), sid('f5', 'lo', s)],
      [sid('c3', 'fl', s), sid('f6', 'hi', s)],
    );
  }
  for (const [a, b] of cabMounts) fixedLink(a, b, 'mount', K_CAB_MOUNT);
  // Box mounts: each runner node on the rail below it (shear plate: vertical + both diagonals + outrigger to the far flange).
  const boxMounts: [string, string][] = [];
  BOX.forEach((st, i) => {
    const f = `f${i + 6}`;
    for (const s of SIDES) {
      const fi = sid(st.id, 'fi', s);
      boxMounts.push([fi, sid(f, 'hi', s)], [fi, sid(f, 'lo', s)]);
      if (i > 0) boxMounts.push([fi, sid(`f${i + 5}`, 'hi', s)]);
      if (i + 1 < BOX.length) boxMounts.push([fi, sid(`f${i + 7}`, 'hi', s)]);
    }
  });
  for (const [a, b] of boxMounts) fixedLink(a, b, 'boxMount', K_BOX_MOUNT);
  // Side guards: posts, two rails, bay diagonals; each post hung from the box sill and floor runner and its
  // foot braced inboard to the frame rail's lower flange (the guard catches a car's bumper and hood, instead
  // of the 1.24 m box floor riding over them and onto the windscreen).
  for (const s of SIDES) {
    const { lo, hi } = guards.get(s)!;
    GUARD_STATIONS.forEach((i, k) => {
      const st = BOX[i]!.id;
      const fr = `f${i + 6}`;
      link(lo[k]!, hi[k]!, 'guard', 2);
      link(hi[k]!, sid(st, 'fl', s), 'guard', 2);
      link(hi[k]!, sid(st, 'fi', s), 'guard', 1.5);
      link(lo[k]!, sid(st, 'fi', s), 'guard', 1);
      link(lo[k]!, sid(fr, 'lo', s), 'guard', 1.5);
      link(hi[k]!, sid(fr, 'lo', s), 'guard', 1);
      if (k + 1 >= GUARD_STATIONS.length) return;
      link(lo[k]!, lo[k + 1]!, 'guard', GUARD_RAIL_W);
      link(hi[k]!, hi[k + 1]!, 'guard', GUARD_RAIL_W);
      link(lo[k]!, hi[k + 1]!, 'guard', 1);
      link(hi[k]!, lo[k + 1]!, 'guard', 1);
    });
  }
  // Bumpers: brackets onto the frame ends.
  const bumperMounts: [string, string][] = [];
  for (const s of SIDES) {
    bumperMounts.push(
      [sid('br', 'bl', s), sid('f13', 'lo', s)],
      [sid('br', 'bl', s), sid('f12', 'lo', s)],
      [sid('br', 'bu', s), sid('f13', 'lo', s)],
      [sid('br', 'bu', s), sid('f13', 'hi', s)],
      [sid('br', 'bo', s), sid('f13', 'lo', s)],
    );
  }
  bumperMounts.push(['br_bl', 'f13_lo_L'], ['br_bl', 'f13_lo_R'], ['br_bu', 'f13_lo_L'], ['br_bu', 'f13_lo_R']);
  // The underride bar hangs 0.3 m below the rails: struts forward to f12 as well (it sagged 10 cm on f13 alone).
  bumperMounts.push(['br_bl', 'f12_lo_L'], ['br_bl', 'f12_lo_R'], ['br_bu', 'f12_lo_L'], ['br_bu', 'f12_lo_R']);
  for (const s of SIDES) bumperMounts.push([sid('br', 'bu', s), sid('f12', 'lo', s)], [sid('br', 'bo', s), sid('f12', 'lo', s)]);
  for (const [a, b] of bumperMounts) fixedLink(a, b, 'bumperMount', K_BUMPER_MOUNT);
  // Front bumper: a deep steel channel on two crush brackets per horn. The brackets run square along the rail
  // (bk → lower flange, bh → upper) with crossed webs; they crush first at BUMPER_BRACKET_YIELD and fold up
  // solid (the compression floor), then the bar bears on the horn tips. Diagonal brackets from the bar ends
  // let it slide back past the horns (the horn tips then hit the wall bare and folded under).
  const bumperFront: [string, string, number][] = [];
  for (const s of SIDES) {
    bumperFront.push(
      [sid('bf', 'bk', s), sid('f0', 'lo', s), BUMPER_BRACKET_YIELD],
      [sid('bf', 'bh', s), sid('f0', 'hi', s), BUMPER_BRACKET_YIELD],
      [sid('bf', 'bk', s), sid('f0', 'hi', s), 0.6 * BUMPER_BRACKET_YIELD],
      [sid('bf', 'bh', s), sid('f0', 'lo', s), 0.6 * BUMPER_BRACKET_YIELD],
      // Bar-end and centre stays (they hold the bar's own modes still; the square brackets carry the crush).
      [sid('bf', 'bo', s), sid('f0', 'lo', s), 0.4 * BUMPER_BRACKET_YIELD],
      [sid('bf', 'bl', s), sid('f0', 'lo', s), 0.4 * BUMPER_BRACKET_YIELD],
      [sid('bf', 'bu', s), sid('f0', 'hi', s), 0.4 * BUMPER_BRACKET_YIELD],
      ['bf_bl', sid('f0', 'lo', s), 0.4 * BUMPER_BRACKET_YIELD],
      ['bf_bu', sid('f0', 'hi', s), 0.4 * BUMPER_BRACKET_YIELD],
    );
  }
  for (const [a, b, y] of bumperFront) {
    fixedLink(a, b, 'bumperMount', K_BUMPER_MOUNT, y);
    bumperMounts.push([a, b]);
  }

  // ---- engine: rigid block + mounts to the frame
  const block = [...engine, ...gearbox];
  for (let p = 0; p < block.length; p++)
    for (let q = p + 1; q < block.length; q++) {
      const a = block[p]!;
      const b = block[q]!;
      const gbxPair = gearbox.includes(a) || gearbox.includes(b);
      if (gbxPair && !(gearbox.includes(a) && gearbox.includes(b)) && (pos.get(a)![2] < -2.8 || pos.get(b)![2] < -2.8)) continue;
      link(a, b, 'engine');
    }
  const framePool = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].flatMap((s) => stationIds.get(s)!).filter((id) => !id.includes('_tw_') && !id.endsWith('_x'));
  for (const e of block) for (const n of nearest(e, framePool, 3)) fixedLink(e, n, 'engMount', K_ENG_MOUNT, ENG_MOUNT_YIELD);
  // Radiator / fan stack: once the clip has crushed back onto the engine, the radiator support bears on the block
  // (compression only), so the engine and its mounts join the load path at grille height.
  for (const [a, b] of [
    ['s0_rl_L', 'eng_flo_L'],
    ['s0_rl_R', 'eng_flo_R'],
    ['s0_rh_L', 'eng_fhi_L'],
    ['s0_rh_R', 'eng_fhi_R'],
    ['s0_rs', 'eng_flo_L'],
    ['s0_rs', 'eng_flo_R'],
    ['s0_rt', 'eng_fhi_L'],
    ['s0_rt', 'eng_fhi_R'],
  ] as const) {
    const ma = massOf.get(a)!;
    const mb = massOf.get(b)!;
    fix({ a, b, type: 'support', k: K_RAD_STACK, d: sig3(0.6 * Math.sqrt((K_RAD_STACK * ma * mb) / (ma + mb))), deform: RAD_STACK_YIELD, breakF: 0 });
  }

  // ---- suspension pivots → frame anchors (4 of the 8 nearest spanning space best)
  const anchors = (p: string, pool: readonly string[]): string[] => {
    const cand = nearest(p, pool, 8);
    let best: string[] = cand.slice(0, 4);
    let bestScore = -Infinity;
    for (let a = 0; a < cand.length; a++)
      for (let b = a + 1; b < cand.length; b++)
        for (let c = b + 1; c < cand.length; c++)
          for (let d = c + 1; d < cand.length; d++) {
            const set = [cand[a]!, cand[b]!, cand[c]!, cand[d]!];
            const Mx = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            let sumD = 0;
            for (const q of set) {
              const v = sub(pos.get(q)!, pos.get(p)!);
              sumD += len(v);
              const u = unit(v);
              for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) Mx[3 * r + k]! += u[r]! * u[k]!;
            }
            const det = Mx[0]! * (Mx[4]! * Mx[8]! - Mx[5]! * Mx[7]!) - Mx[1]! * (Mx[3]! * Mx[8]! - Mx[5]! * Mx[6]!) + Mx[2]! * (Mx[3]! * Mx[7]! - Mx[4]! * Mx[6]!);
            const score = det / sumD;
            if (score > bestScore + 1e-12) {
              bestScore = score;
              best = set;
            }
          }
    return best;
  };
  const frameNodes = FRAME.flatMap((st) => stationIds.get(st.id)!);
  {
    const poolF = frameNodes.filter((id) => Math.abs(pos.get(id)![2] - (Z_F - 0.4)) < 0.9);
    const poolR = frameNodes.filter((id) => Math.abs(pos.get(id)![2] - (Z_R - 0.4)) < 1.0);
    for (const s of SIDES) {
      for (const p of [fa('lp', s), fa('up', s), fa('pan', s)]) for (const n of anchors(p, poolF)) fixedLink(p, n, 'subframe', K_ANCHOR);
      for (const p of [ra('lp', s), ra('up', s), ra('pan', s)]) for (const n of anchors(p, poolR)) fixedLink(p, n, 'subframe', K_ANCHOR);
    }
  }

  // ---- axles (fixed stiffness)
  const rigid = (a: string, b: string, k = K_AXLE): void => fix({ a, b, type: 'normal', k, d: D_ARM, deform: 0, breakF: 0 });
  const linkBeam = (a: string, b: string, k: number): void => fix({ a, b, type: 'normal', k, d: D_ARM, deform: 2.5e5, breakF: 5e5 });
  /**
   * Rigid axle body from two 4-node ends [top, end, low-rear, low-front]: each end all pairs (a
   * tetrahedron), joined by seven cross beams (two rigid bodies need six; seven keep it mirror-symmetric), plus a centre node.
   */
  const rigidBody = (ends: readonly (readonly [string, string, string, string])[], centre: string, centreLinks: readonly number[], k = K_AXLE): void => {
    const L = ends[0]!;
    const R = ends[1]!;
    for (const e of [L, R]) for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) rigid(e[p]!, e[q]!, k);
    // Mirror-symmetric cross bracing (one-way diagonals made the axle body chiral: it toed under side load).
    for (const [p, q] of [
      [0, 0],
      [2, 2],
      [3, 3],
      [0, 2],
      [2, 0],
      [0, 3],
      [3, 0],
    ] as const)
      rigid(L[p]!, R[q]!, k);
    for (const c of centreLinks) for (const e of [L, R]) rigid(centre, e[c]!, k);
  };
  const hydroTravel = { L: 0, R: 0 };
  {
    // Front I-beam (a rigid body): a tetrahedron per end {kT, kB, sp, st}, six cross beams, the centre drop on four.
    rigidBody(SIDES.map((s) => [fa('kT', s), fa('kB', s), fa('sp', s), fa('st', s)] as const), fa('c'), [0, 1, 3]);
    for (const s of SIDES) {
      const hubI = wheelNodeId(`F${s}`, 'hubI');
      const hubO = wheelNodeId(`F${s}`, 'hubO');
      // KNUCKLE = {hubI, hubO, steering arm}: each node on the kingpin (kT, kB) — a hinge about kT–kB — plus
      // a stiff stub axle and the arm tied to both hubs. The arm sits BEHIND the hub line: with only the two
      // hubs, every knuckle beam lay in the plane z = Z_F, so the knuckle had a second, first-order free
      // motion out of that plane and the wheels steered 3° where the tie rod asked for 10°. (The wheel's own
      // hubI–hubO beam has the rim's 1.6e5 N/m.)
      const arm = fa('arm', s);
      fix({ a: hubI, b: hubO, type: 'normal', k: K_STUB, d: D_ARM, deform: 0, breakF: 0 });
      for (const h of [hubI, hubO, arm]) {
        fix({ a: h, b: fa('kT', s), type: 'normal', k: K_KNUCKLE, d: ATTACH_DAMP, deform: 0, breakF: 3e5 });
        fix({ a: h, b: fa('kB', s), type: 'normal', k: K_KNUCKLE, d: D_ARM, deform: 0, breakF: 3e5 });
      }
      fix({ a: arm, b: hubI, type: 'normal', k: K_KNUCKLE, d: D_ARM, deform: 0, breakF: 3e5 });
      fix({ a: arm, b: hubO, type: 'normal', k: K_KNUCKLE, d: D_ARM, deform: 0, breakF: 3e5 });
      // Tie rod (steering hydro) from the axle's tie-rod end to the arm, tangential to the arm's steer arc.
      const pA = pos.get(arm)!;
      const st = pos.get(fa('st', s))!;
      const kB = pos.get(fa('kB', s))!;
      const u = unit(sub(pos.get(fa('kT', s))!, kB));
      const L0 = len(sub(pA, st));
      const Lat = (ang: number): number => len(sub(rotateAbout(pA, kB, u, ang), st));
      const d = BOXTRUCK_TARGETS.maxWheelAngleRad;
      hydroTravel[s] = round((Lat(-d) - Lat(d)) / (2 * L0), 4);
      // Steering damper on the tie rod (beam-axle shimmy: the spinning wheels' gyroscopic camber ↔ steer coupling).
      fix({ a: fa('st', s), b: arm, type: 'hydro', k: K_TIE_ROD, d: D_STEER, hydroTravel: hydroTravel[s], deform: 0, breakF: 0 });
      // Leading links (leaf spring front half): lower from the kingpin bottom, upper from the kingpin top.
      linkBeam(fa('kB', s), fa('lp', s), K_LINK);
      linkBeam(fa('kT', s), fa('up', s), K_LINK);
    }
    linkBeam(fa('sp', 'L'), fa('pan', 'R'), K_PANHARD);
    linkBeam(fa('sp', 'R'), fa('pan', 'L'), K_PANHARD);
  }
  const dualLinks: [string, string][] = [];
  {
    rigidBody(SIDES.map((s) => [ra('kU', s), ra('ae', s), ra('ab', s), ra('af', s)] as const), ra('D'), [0, 2], K_REAR_AXLE);
    for (const s of SIDES) {
      for (const inner of [false, true]) {
        const w = dualId(s, inner);
        // Hub on the axle end (attach: ae) + the brackets fore / aft below the tube (non-coplanar) + a stub axle.
        rigid(wheelNodeId(w, 'hubI'), wheelNodeId(w, 'hubO'), K_STUB);
        for (const h of ['hubI', 'hubO'] as const) {
          rigid(wheelNodeId(w, h), ra('ab', s), K_AXLE);
          rigid(wheelNodeId(w, h), ra('af', s), K_AXLE);
        }
        rigid(wheelNodeId(w, 'hubI'), ra('kU', s), K_AXLE * 0.5);
      }
      // Dual pair bolted together: crossed rim-to-rim beams (inner wheel's outer rim row ↔ outer wheel's inner row).
      const n = BOXTRUCK_TIRE.rays;
      const wi = dualId(s, true);
      const wo = dualId(s, false);
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        for (const [a, b] of [
          [wheelNodeId(wi, 'rimO', k), wheelNodeId(wo, 'rimI', k1)],
          [wheelNodeId(wi, 'rimO', k1), wheelNodeId(wo, 'rimI', k)],
        ] as const) {
          fix({ a, b, type: 'normal', k: K_DUAL, d: 12, deform: 0, breakF: 6e4 });
          dualLinks.push([a, b]);
        }
      }
      linkBeam(ra('ab', s), ra('lp', s), K_LINK);
      linkBeam(ra('kU', s), ra('up', s), K_LINK);
    }
    linkBeam(ra('kU', 'L'), ra('pan', 'R'), K_PANHARD);
    linkBeam(ra('kU', 'R'), ra('pan', 'L'), K_PANHARD);
  }

  // ---- springs + dampers (fixed stiffness): axle spring seats → frame towers
  const shockK = { front: 0, rear: 0 };
  const shockD = { front: 0, rear: 0 };
  const preload = { front: 0, rear: 0 };
  const spring = (axle: 'front' | 'rear'): void => {
    const seat = axle === 'front' ? fa('kT', 'R') : ra('kU', 'R');
    const tower = axle === 'front' ? sid('f2', 'tw', 'R') : sid('f10', 'tw', 'R');
    const pa = pos.get(seat)!;
    const pt = pos.get(tower)!;
    const mr = dot([0, 1, 0], unit(sub(pt, pa)));
    const kW = wheelRate[axle];
    const mS = sprungAxle[axle] / 2;
    const k = kW / (mr * mr);
    const Fs = (mS * G) / mr;
    const c = (DAMPER_CALIBRATION * BOXTRUCK_TARGETS.dampingRatio * 2 * Math.sqrt(kW * mS)) / (mr * mr);
    shockK[axle] = sig3(k);
    shockD[axle] = sig3(c);
    preload[axle] = sig3(Fs);
    const bound = round((axle === 'front' ? FRONT_SHOCK_TRAVEL : REAR_SHOCK_TRAVEL) / len(sub(pt, pa)), 3);
    for (const s of SIDES) {
      const a = axle === 'front' ? fa('kT', s) : ra('kU', s);
      const b = axle === 'front' ? sid('f2', 'tw', s) : sid('f10', 'tw', s);
      fix({ a, b, type: 'shock', k: shockK[axle], d: shockD[axle], preload: preload[axle], boundsLow: bound, boundsHigh: bound, deform: 0, breakF: 4e5 });
    }
  };
  spring('front');
  spring('rear');

  // ---- anti-roll bars: half-bodies, torsion, drop links, bushings on the frame
  for (const b of arbs) {
    const rb = (x: string, y: string): void => fix({ a: x, b: y, type: 'normal', k: K_ARB_BODY, d: D_ARB, deform: 0, breakF: 0 });
    rb(b.A.L, b.A.R);
    for (const s of SIDES) {
      for (const n of [b.T[s], b.U[s]]) for (const a of SIDES) rb(n, b.A[a]);
      rb(b.T[s], b.U[s]);
      const sd = s === 'L' ? 'R' : 'L';
      fix({ a: b.T[s], b: b.U[sd], type: 'normal', k: b.kT, d: b.dT, deform: 0, breakF: 0 });
      fix({ a: b.T[s], b: `${b.drop}_${s}`, type: 'normal', k: K_ARB_LINK, d: D_ARB, deform: 0, breakF: 0 });
      const pool = frameNodes.filter((id) => !id.includes('_tw_') && !id.endsWith('_x') && Math.abs(pos.get(id)![2] - pos.get(b.A[s])![2]) < 0.8);
      for (const n of anchors(b.A[s], pool)) fixedLink(b.A[s], n, 'subframe', K_ANCHOR);
    }
  }

  // ---- hood beams (skin grid, hinges at the clip's rear apron, latch on the radiator support, rests on the fenders)
  const subBeams: RigBeamDef[] = [];
  type SB = { a: string; b: string; w: number; kind: 'skin' | 'hinge' | 'latch' | 'rest' };
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
    for (const s of SIDES) {
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
    for (const s of SIDES) {
      hb.push({ a: H(1, 1), b: `eng_fhi_${s}`, w: 0.5, kind: 'rest' });
      hb.push({ a: H(2, 1), b: `eng_rhi_${s}`, w: 0.5, kind: 'rest' });
      hb.push({ a: H(3, 1), b: sid('c0', 'fw', s), w: 0.5, kind: 'rest' });
    }
    const own = (id: string): boolean => id.startsWith('hood_');
    const wsum = new Map<string, number>();
    for (const b of hb) for (const id of [b.a, b.b]) if (own(id)) wsum.set(id, (wsum.get(id) ?? 0) + b.w);
    const share = (id: string): number => (own(id) ? (BUDGET_PER_KG * massOf.get(id)!) / wsum.get(id)! : Infinity);
    for (const { a, b, w, kind } of hb) {
      const k = sig3(0.995 * w * Math.min(share(a), share(b)));
      const ma = massOf.get(a)!;
      const mb = massOf.get(b)!;
      const d = sig3(2 * HOOD.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
      const L = dist(a, b);
      if (seen.has(key(a, b))) throw new Error(`boxtruck: duplicate sub-rig beam ${a}–${b}`);
      seen.add(key(a, b));
      if (kind === 'skin') {
        const deform = sig3(Math.max(HOOD.yieldStrain * k * L, HOOD.minDeform));
        subBeams.push({ a, b, type: 'normal', k, d, deform, breakF: sig3(HOOD.breakRatio * deform) });
      } else if (kind === 'hinge') subBeams.push({ a, b, type: 'normal', k, d, deform: HOOD.hingeDeform, breakF: HOOD.hingeBreak });
      else if (kind === 'latch') subBeams.push({ a, b, type: 'normal', k, d, deform: 0, breakF: HOOD.latchBreak });
      else subBeams.push({ a, b, type: 'support', k, d, deform: 0, breakF: HOOD.restBreak });
    }
  }

  // ---- auto stiffness: split each node's budget by class weight
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
  const isShell = (id: string): boolean => stationOf.has(id) || id.startsWith('gd') || id.startsWith('kb') || id.startsWith('bp');
  const share = (id: string): number => {
    const perKg = isShell(id) ? SHELL_BUDGET_PER_KG : BUDGET_PER_KG;
    const budget = perKg * massOf.get(id)! - (fixedK.get(id) ?? 0);
    if (!(budget > 0)) throw new Error(`boxtruck: node ${id} has no stiffness budget left (${budget.toFixed(0)})`);
    return budget / W.get(id)!;
  };
  const kOf = auto.map(({ a, b, w }) => sig3(0.995 * w * Math.min(share(a), share(b))));

  /*
   * CRASH SECTIONS: beams spanning consecutive stations of the FRAME or the
   * CAB yield together at the gap's axial section force F_g: longitudinal
   * members carry F_g in equal shares, the gap's diagonals yield at the same
   * closure (floored), in-station members at 3× it.
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
  const isLong = (i: number): boolean => auto[i]!.w > CLASSES[auto[i]!.cls].w * 1.01 && !webDiagonals.has(key(auto[i]!.a, auto[i]!.b));
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
    if (cls === 'cargo' && (CARGO_TOP.test(a) || CARGO_TOP.test(b)) && (/_cg$/.test(a) || /_cg$/.test(b))) {
      // Freight → roof spokes: the load stops short of the roof, so they give way in a rollover and the box roof crushes.
      return { a, b, type: 'normal', k, d, deform: CARGO_TOP_YIELD, breakF: sig3(4 * CARGO_TOP_YIELD) };
    }
    if (FIREWALL_PANEL.test(a) || FIREWALL_PANEL.test(b)) {
      const deform = sig3(Math.max(0.15 * k * dist(a, b), 1.5e4));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(6 * deform) };
    }
    if (DOOR_NODES.test(a) || DOOR_NODES.test(b)) {
      const deform = sig3(Math.max(DOOR_YIELD_STRAIN * k * dist(a, b), DOOR_MIN_DEFORM));
      return { a, b, type: 'normal', k, d, deform, breakF: sig3(spec.breakRatio * deform) };
    }
    const g = gapOf(a, b);
    let section = 0;
    if ((cls === 'frame' || cls === 'horn') && g !== null && gapLongCz.has(g) && webDiagonals.has(key(a, b))) {
      // Web diagonals keep the bay square while its chords crush: at the chords' share the horn bays sheared
      // into a parallelogram, the horn tip tucked under the next station and the horns folded instead of crushing.
      section = FRAME_WEB_DIAG_FACTOR * longDeform(g);
    } else if ((cls === 'cage' || cls === 'frame' || cls === 'horn') && g !== null && gapLongCz.has(g)) {
      section = isLong(i)
        ? longDeform(g)
        : Math.max(k * gapTravel(g) * Math.max(czOf(a, b), SHEAR_YIELD_FLOOR), (cls === 'cage' ? SHEAR_FORCE_SHARE : FRAME_SHEAR_FORCE_SHARE) * longDeform(g));
    } else if (cls === 'frame' && g === null && /^f\d+$/.test(stationOf.get(a) ?? '') && /^f\d+$/.test(stationOf.get(b) ?? '')) {
      // Frame spans f_i → f_i+2..4: as strong as the weakest gap they bridge (at 5 % strain they set the fold at f7).
      const ia = Number(stationOf.get(a)!.slice(1));
      const ib = Number(stationOf.get(b)!.slice(1));
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      if (hi - lo >= 2 && hi - lo <= 4) {
        let m = Infinity;
        for (let g = lo; g < hi; g++) if (gapLongCz.has(`f${g}`)) m = Math.min(m, longDeform(`f${g}`));
        if (Number.isFinite(m)) section = m;
      }
    } else if ((cls === 'cage' || cls === 'frame' || cls === 'horn') && g === null) {
      const st = stationOf.get(a);
      if (st !== undefined && st === stationOf.get(b) && (st[0] === 'f' || st[0] === 'c')) {
        const n = Number(st.slice(1));
        const near = Math.max(gapTravel(`${st[0]}${n - 1}`), gapTravel(`${st[0]}${n}`));
        section = k * near * IN_STATION_YIELD_FACTOR;
        // A rail's web and the crossmembers keep the section's shape while its chords crush: at the gap-travel
        // rule the horn webs yielded in tension at 60 kN, the flanges peeled apart and the horns folded under.
        if (st[0] === 'f') section = Math.max(section, FRAME_SECTION_MIN_YIELD);
      }
    }
    if (section === 0 && spanKeys.has(key(a, b))) section = CABIN_SPAN_YIELD_STRAIN * k * dist(a, b);
    const base = section > 0 ? section : spec.yieldStrain * k * dist(a, b);
    const deform = sig3(Math.max(base, spec.minDeform));
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

  const beams = [...autoBeams, ...fixed, ...subBeams];
  const def: VehicleDef = {
    name: 'boxtruck',
    body: {
      name: 'boxtruck.body',
      nodes,
      beams,
      groupDefaults: {
        body: { friction: 0.5, radius: 0.05 },
        engine: { friction: 0.5, radius: 0.08 },
        subframe: { friction: 0.5, radius: 0.04 },
        axle: { friction: 0.5, radius: 0.06 },
        knuckle: { friction: 0.5, radius: 0.04 },
        hood: { friction: 0.5, radius: 0.03 },
      },
    },
    wheels,
    drivetrain: DRIVETRAIN,
    brakes: { frontBias: 0.55, handbrakeTorqueMax: 4000 },
    aero: { dragCoeffArea: 5.6, liftCoeffArea: 0 },
    steering: { maxWheelAngleDeg: round((BOXTRUCK_TARGETS.maxWheelAngleRad * 180) / Math.PI, 2) },
    frame: { origin: 'f7_x', front: 'f3_x', top: sid('c3', 'rf') },
    // Feel pass: rigid shell clusters (shell.ts). Body-on-frame: the cab and the box are each a rigid
    // body on their breakable mounts; the ladder frame (+ its front horns) stays a beam lattice so it still
    // twists like a truck frame (the rollover targets depend on it).
    shell: [
      shellLayout({
        ids: ['c0_*', 'c1_*', 'c2_*', 'c3_*', 's0_*', 's1_*', 's2_*', 'hood_*'],
        front: ['s0_*', 's1_*', 's2_*', 'hood_*'],
        rear: [],
        firewall: ['c0_*'],
        cell: ['c1_*', 'c2_*', 'c3_*'],
      }),
      {
        ids: ['b0_*', 'b1_*', 'b2_*', 'b3_*', 'b4_*', 'b5_*', 'b6_*', 'b7_*'],
        // floor runners / centre ride on the (flexible) frame rails: they stay in the beam lattice as the mount layer
        exclude: [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [`b${i}_fi_*`, `b${i}_fc`]),
        zones: [{ ids: ['*'], release: SHELL_RELEASE_DENT, whole: true }],
        freqHz: 60,
      },
    ],
  };
  const design: BoxtruckDesign = {
    totalMass,
    cg,
    frontAxleShare,
    unsprungAxle,
    sprungAxle,
    tireRate,
    wheelRate,
    shockK,
    shockD,
    preload,
    hydroTravel,
    bodyNodeCount: nodes.length,
    bodyBeamCount: beams.length,
    cabMounts,
    boxMounts,
    dualLinks,
  };
  return { def, design };
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

const BUILT = buildBoxtruck();

/** The box truck VehicleDef (plain JSON). Wheels FL, FR, RL, RR (outer duals), RLi, RRi (inner duals). */
export const BOXTRUCK: VehicleDef = BUILT.def;
/** Derived design numbers (mass/CG solve, suspension rates, mounts). */
export const BOXTRUCK_DESIGN: BoxtruckDesign = BUILT.design;
/** Inner dual wheel ids (render: WheelVisualDef.mirrored). */
export const BOXTRUCK_INNER_DUALS = ['RLi', 'RRi'] as const;

/** Crash-harness node sets (src/sim/vehicle/crash.ts CrashProbes). */
export const BOXTRUCK_CRASH_PROBES = {
  front: ['f0_lo_*', 'f0_hi_*'],
  cabin: ['c3_fl_*', 'c3_sl_*'],
  firewall: ['c0_fl_*', 'c0_sl_*', 'c0_hp_*', 'c0_cw'],
  cellRear: ['c3_*'],
  cellFront: ['c0_*'],
  doorMid: ['c2_dm_*'],
  doorR: 'c2_dm_R',
  doorL: 'c2_dm_L',
  sillR: 'c2_sl_R',
  sillL: 'c2_sl_L',
  exemptPrefixes: ['bf_', 'br_', 'hood_', 's0_', 's1_', 's2_', 'b0_', 'b1_', 'b2_', 'b3_', 'b4_', 'b5_', 'b6_', 'b7_', 'gd', 'kb'],
  latch: [['hood_0C', 's0_rt']],
  bumperPrefix: 'bf_',
  windscreen: ['c0_cw', 'c1_rf'],
} as const;
