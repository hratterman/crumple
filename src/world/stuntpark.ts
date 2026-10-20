/**
 * Stunt park + Anvil ski jump (P8; docs/CONTRACTS.md "P8 contracts" →
 * "Stunt park"). Pure layout DATA appended to DEFAULT_LAYOUT: static
 * colliders (drawn by render/world/colliders.ts with the P8 visuals),
 * soft props, and render-only decoration (painted markings, floodlight
 * heads; render/world/stuntpark.ts). No three, no DOM, no sim imports.
 *
 * Arena (zone grown to x 270..510, z 240..420, flat concrete at 10.5):
 *
 *   z 232  ▭▭ containers ▭▭     ◉ floods              ◉
 *   z 244  [park bays]  |poles|  ▂crash wall▂   ⊿ramp   ┌─ derby pit ─┐
 *          (NW, pickup)  |    |       |  lane   landing │ containers  │
 *   z 300        ○ drift pad  |  ▲roll kicker(388)      │  tyre wall  │
 *   z 330  gate →             pyramid   pins ◁ bowling lane ◁ runway ═══
 *   z 352                                  kicker S ▶            ╮
 *   z 376                         block wall  kicker L ▶  quarter-pipe ╯ (x 499–505)
 *   z 408  jump line ────────▶ take-off ▶ wrecks ▶ landing ▶ tyres
 *   z 437        ▤▤▤▤ grandstand ▤▤▤▤
 *
 * The ski jump sits on Anvil's south face (x 460): a 17 m start tower and
 * a 6 m in-run (18° → 28° → table, lip 96.8 m at z −336), then a 16 m
 * landing hill of deck boxes (smoothed terrain envelope + 0.45 m, so no
 * terrain or tree pokes through) down to the outrun at z −215.
 */
import { MaterialId } from '../protocol/messages';
import type { ColliderDef, ColliderVisual, PropPlacement } from './types';

type V3 = readonly [number, number, number];
type Quat = [number, number, number, number];

const DEG = Math.PI / 180;

/** Yaw-only quaternion; yawDeg 0 = local −Z faces −Z (north), 90 = faces −X. */
export function yawQuat(yawDeg: number): Quat {
  const a = (yawDeg * DEG) / 2;
  return [0, Math.sin(a), 0, Math.cos(a)];
}

/** Unit quaternion of the rotation whose matrix columns are (x, y, z) (orthonormal, right-handed). */
function quatFromColumns(x: V3, y: V3, z: V3): Quat {
  const m00 = x[0];
  const m11 = y[1];
  const m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    q = [(y[2] - z[1]) / S, (z[0] - x[2]) / S, (x[1] - y[0]) / S, 0.25 * S];
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * S, (y[0] + x[1]) / S, (z[0] + x[2]) / S, (y[2] - z[1]) / S];
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(y[0] + x[1]) / S, 0.25 * S, (z[1] + y[2]) / S, (z[0] - x[2]) / S];
  } else {
    const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(z[0] + x[2]) / S, (z[1] + y[2]) / S, 0.25 * S, (x[1] - y[0]) / S];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * A box whose TOP face runs from A to B (centreline points, world m),
 * `width` across, `thick` deep, extended `overlap` m at both ends (no gaps
 * at the joints). Local axes: x = right of travel, y = surface normal,
 * z = back (−travel); a rolled box is never produced (right stays level).
 */
export function deckBox(id: string, a: V3, b: V3, width: number, thick: number, visual: ColliderVisual, material: MaterialId = MaterialId.metal, overlap = 0.12): ColliderDef {
  let fx = b[0] - a[0];
  let fy = b[1] - a[1];
  let fz = b[2] - a[2];
  const L = Math.hypot(fx, fy, fz);
  fx /= L;
  fy /= L;
  fz /= L;
  // right = f × Y
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl;
  rz /= rl;
  // up = right × f
  const ux = 0 * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - 0 * fx;
  const quat = quatFromColumns([rx, 0, rz], [ux, uy, uz], [-fx, -fy, -fz]);
  const h = thick / 2;
  const pos: [number, number, number] = [(a[0] + b[0]) / 2 - ux * h, (a[1] + b[1]) / 2 - uy * h, (a[2] + b[2]) / 2 - uz * h];
  return { id, kind: 'box', pos, quat, size: [width / 2, h, L / 2 + overlap], material, visual };
}

// ============================================================ arena constants
/** Arena floor height (zone flatten height). */
export const ARENA_Y = 10.5;
/** Container (40 ft) half extents, length along local x. */
const CONT: V3 = [6.096, 1.295, 1.22];

function container(id: string, x: number, z: number, yawDeg: number, level = 0): ColliderDef {
  return {
    id,
    kind: 'box',
    pos: level === 0 ? [x, null, z] : [x, ARENA_Y + CONT[1] + 2 * CONT[1] * level, z],
    quat: yawQuat(yawDeg),
    size: [CONT[0], CONT[1], CONT[2]],
    material: MaterialId.metal,
    visual: 'container',
  };
}

function tires(id: string, x: number, z: number, halfLen: number, yawDeg = 0, halfDepth = 0.45): ColliderDef {
  return { id, kind: 'box', pos: [x, null, z], quat: yawQuat(yawDeg), size: [halfLen, 0.55, halfDepth], material: MaterialId.rubber, visual: 'tires' };
}

function wreck(id: string, x: number, z: number, yawDeg: number): ColliderDef {
  // car length along local x (4.5 m), 1.8 m wide, crushed to 1.24 m
  return { id, kind: 'box', pos: [x, null, z], quat: yawQuat(yawDeg), size: [2.25, 0.62, 0.9], material: MaterialId.metal, visual: 'wreck' };
}

function jersey(id: string, x: number, z: number, yawDeg = 0): ColliderDef {
  return { id, kind: 'box', pos: [x, null, z], quat: yawQuat(yawDeg), size: [1.5, 0.405, 0.3], material: MaterialId.concrete, visual: 'jersey' };
}

function kicker(id: string, x: number, z: number, yawDeg: number, hx: number, hy: number, hz: number): ColliderDef {
  return { id, kind: 'ramp', pos: [x, null, z], quat: yawQuat(yawDeg), size: [hx, hy, hz], material: MaterialId.metal, visual: 'kicker' };
}

function flood(id: string, x: number, z: number, faceX: number, faceZ: number): ColliderDef {
  // local −Z (the lamp head) faces the arena centre
  const yaw = Math.atan2(-(faceX - x), -(faceZ - z)) / DEG;
  return { id, kind: 'cylinder', pos: [x, null, z], quat: yawQuat(yaw), size: [0.35, 9, 0], material: MaterialId.metal, visual: 'floodlight' };
}

// ------------------------------------------------------------ named features (challenges use these)
/** Bowling: lane along z 330 heading west; pins (challenge props) around PIN_HEAD. */
export const BOWLING = { laneZ: 330, startX: 437, headPinX: 396 } as const;
/** Barrel-roll side kicker under the LEFT wheels of a car driving north on x = 388. */
export const BARREL_ROLL = { laneX: 388, kickerX: 387.15, kickerZ: 300, startZ: 362, hx: 0.6, hy: 0.75, hz: 3.5 } as const;
/** Wreck jump heading east along z 408. */
export const WRECK_JUMP = { laneZ: 408, takeoffX: 457, wreckX: [466, 468, 470, 472], landingX: 482, runStartX: 335 } as const;
/** Derby pit (inside, metres). */
export const DERBY_PIT = { minX: 457.5, maxX: 506.5, minZ: 246.5, maxZ: 314.5, centre: [482, 280] as const } as const;
/** Precision-park bays along the west edge (bay axis along x, 3 m wide, 6.6 m deep). */
export const PARK_BAYS = { x: 279, depth: 6.6, width: 3.2, zs: [249.6, 252.8, 256, 259.2, 262.4, 265.6], target: 2 } as const;
/** Drift pad (painted). */
export const DRIFT_PAD = { centre: [326, 300] as const, radius: 15 } as const;
/** Quarter-pipe bank along the east edge, facing west. */
export const QUARTER_PIPE = { x0: 499, radius: 5, maxDeg: 72, minZ: 344, maxZ: 396 } as const;

// ------------------------------------------------------------ ski jump (Anvil, x 460, heading south)
export const SKI_JUMP_X = 460;
/** In-run top surface centreline (z, y), north → south; the start pad is the first segment. */
export const SKI_INRUN: readonly (readonly [number, number])[] = [
  [-402, 117],
  [-394, 117],
  [-387.5, 114.89],
  [-381, 112.8],
  [-373.5, 109.77],
  [-366, 106.7],
  [-359, 102.98],
  [-352, 99.3],
  [-349, 98.4],
  [-346, 97.6],
  [-343.5, 97.08],
  [-341, 96.75],
  [-338, 96.7],
  [-336, 96.8],
];
/** The take-off lip (the in-run's last point). */
export const SKI_LIP: V3 = [SKI_JUMP_X, 96.8, -336];
/** Landing hill top surface (z, y): smoothed terrain envelope (±8 m strip max) + 0.45 m, measured on DEFAULT_LAYOUT v4/v5 terrain (unchanged there). */
export const SKI_LANDING: readonly (readonly [number, number])[] = [
  [-335, 92.55], [-331, 92.03], [-327, 90.81], [-323, 89.03], [-319, 86.85], [-315, 84.19], [-311, 81.71], [-307, 78.95],
  [-303, 75.63], [-299, 71.03], [-295, 65.75], [-291, 60.49], [-287, 55.79], [-283, 51.49], [-279, 47.71], [-275, 44.13],
  [-271, 40.63], [-267, 37.25], [-263, 33.97], [-259, 30.81], [-255, 27.83], [-251, 25.15], [-247, 22.95], [-243, 21.43],
  [-239, 20.57], [-235, 20.07], [-231, 19.81], [-227, 19.65], [-219, 19.5], [-213, 19.4],
];
const SKI_INRUN_W = 6;
const SKI_LANDING_W = 16;

function skiJump(): ColliderDef[] {
  const out: ColliderDef[] = [];
  const x = SKI_JUMP_X;
  for (let i = 0; i + 1 < SKI_INRUN.length; i++) {
    const [za, ya] = SKI_INRUN[i]!;
    const [zb, yb] = SKI_INRUN[i + 1]!;
    out.push(deckBox(`ski:inrun${i}`, [x, ya, za], [x, yb, zb], SKI_INRUN_W, 0.8, 'deck', MaterialId.concrete, i === SKI_INRUN.length - 2 ? 0 : 0.12));
    // side rails (0.6 m) keep the car on the in-run
    for (const side of [-1, 1]) {
      const ox = x + side * (SKI_INRUN_W / 2 + 0.1);
      out.push(deckBox(`ski:rail${i}${side < 0 ? 'L' : 'R'}`, [ox, ya + 0.6, za], [ox, yb + 0.6, zb], 0.2, 0.6, 'deck', MaterialId.metal, 0.05));
    }
  }
  for (let i = 0; i + 1 < SKI_LANDING.length; i++) {
    const [za, ya] = SKI_LANDING[i]!;
    const [zb, yb] = SKI_LANDING[i + 1]!;
    out.push(deckBox(`ski:land${i}`, [x, ya, za], [x, yb, zb], SKI_LANDING_W, 1.2, 'deck', MaterialId.concrete));
  }
  // outrun: a ramp down from the deck end to the terrain
  const [zEnd, yEnd] = SKI_LANDING[SKI_LANDING.length - 1]!;
  out.push({ id: 'ski:outrun', kind: 'ramp', pos: [x, yEnd - 0.55, zEnd + 4], quat: [0, 0, 0, 1], size: [SKI_LANDING_W / 2, 0.55, 4], material: MaterialId.concrete, visual: 'ramp' });
  return out;
}

// ------------------------------------------------------------ quarter pipe
function quarterPipe(): ColliderDef[] {
  const q = QUARTER_PIPE;
  const out: ColliderDef[] = [];
  const n = 6;
  const zc = (q.minZ + q.maxZ) / 2;
  const w = q.maxZ - q.minZ;
  const pt = (deg: number): V3 => [q.x0 + q.radius * Math.sin(deg * DEG), ARENA_Y + q.radius * (1 - Math.cos(deg * DEG)), zc];
  for (let i = 0; i < n; i++) {
    const a = pt((q.maxDeg * i) / n);
    const b = pt((q.maxDeg * (i + 1)) / n);
    out.push(deckBox(`qp:stave${i}`, a, b, w, 0.5, 'deck', MaterialId.concrete, 0.06));
  }
  const top = pt(q.maxDeg);
  // back wall behind the curve (no gap under the staves)
  out.push({ id: 'qp:back', kind: 'box', pos: [top[0] + 0.7, ARENA_Y + (top[1] - ARENA_Y + 0.4) / 2, zc], quat: [0, 0, 0, 1], size: [0.7, (top[1] - ARENA_Y + 0.4) / 2, w / 2], material: MaterialId.concrete, visual: 'wall' });
  return out;
}

// ------------------------------------------------------------ the park
function stuntParkColliders(): ColliderDef[] {
  const c: ColliderDef[] = [];
  // Derby pit: containers north + east (east stacked two high at the ends), jerseys south, tyre wall west, tyre island.
  [463.3, 475.5, 487.7, 499.9].forEach((x, k) => c.push(container(`derby:contN${k}`, x, 244.6, 0)));
  c.push(container('derby:contN0b', 463.3, 244.6, 0, 1));
  c.push(container('derby:contN3b', 499.9, 244.6, 0, 1));
  [253.4, 265.6, 277.8, 290, 302.2].forEach((z, k) => c.push(container(`derby:contE${k}`, 508.4, z, 90)));
  c.push(container('derby:contE4b', 508.4, 302.2, 90, 1));
  for (let k = 0; k < 16; k++) c.push(jersey(`derby:jersey${k}`, 458.3 + 3.1 * k, 316));
  for (let k = 0; k < 9; k++) c.push(tires(`derby:tyreW${k}`, 455.6, 249 + 7.6 * k, 3.7, 90));
  c.push(tires('derby:tyreSE', 507.6, 312.2, 3.7, 90));
  c.push(tires('derby:island', 482, 280, 2.2, 0, 2.2));

  // Wreck jump (east along z 408): take-off kicker, four wrecks across the lane, landing ramp.
  const wj = WRECK_JUMP;
  c.push(kicker('jump:takeoff', wj.takeoffX, wj.laneZ, -90, 3, 1.2, 5));
  wj.wreckX.forEach((x, k) => c.push(wreck(`jump:wreck${k}`, x, wj.laneZ + (k % 2 ? 0.35 : -0.35), 90 + (k % 2 ? 6 : -5))));
  c.push(kicker('jump:landing', wj.landingX, wj.laneZ, 90, 3, 1.2, 5));

  // Kickers: small + large heading east toward the quarter pipe; the P4 ramp is the medium one.
  c.push(kicker('kicker:small', 462, 352, -90, 1.8, 0.35, 2.5));
  c.push(kicker('kicker:large', 462, 376, -90, 2.5, 1.0, 5));
  c.push(...quarterPipe());

  // Barrel-roll side kicker (left wheels of a car on x = 388 heading north).
  const br = BARREL_ROLL;
  c.push(kicker('roll:kicker', br.kickerX, br.kickerZ, 0, br.hx, br.hy, br.hz));

  // Precision-park bays: wrecks parked either side of the target bay, concrete stops at the bay ends.
  const pb = PARK_BAYS;
  pb.zs.forEach((z, k) => {
    if (k === pb.target) return;
    if (k === pb.target - 1 || k === pb.target + 1 || k === 0 || k === 5) c.push(wreck(`park:wreck${k}`, pb.x + 0.2, z + (k % 2 ? 0.1 : -0.1), k % 2 ? 2 : -3));
  });
  c.push({ id: 'park:stop', kind: 'box', pos: [pb.x - pb.depth / 2 - 0.4, null, (pb.zs[0]! + pb.zs[5]!) / 2], quat: [0, 0, 0, 1], size: [0.25, 0.4, ((pb.zs[5]! - pb.zs[0]!) + pb.width) / 2], material: MaterialId.concrete, visual: 'jersey' });

  // North backdrop: container stacks outside the arena edge.
  [288, 300.5, 330, 342.5, 420, 432.5].forEach((x, k) => c.push(container(`back:cont${k}`, x, 233.4, k % 3 === 2 ? 3 : 0)));

  // Jersey line along the south edge in front of the grandstand, gaps for the jump-line run-up.
  for (let k = 0; k < 18; k++) c.push(jersey(`south:jersey${k}`, 316 + 3.1 * k, 423.5));

  // Grandstand (seats face north; a wedge rising to the south).
  c.push({ id: 'grandstand', kind: 'ramp', pos: [360, null, 437], quat: yawQuat(180), size: [40, 3.4, 7.5], material: MaterialId.concrete, visual: 'grandstand' });

  // Floodlight towers around the park.
  const cx = 390;
  const cz = 330;
  c.push(flood('flood:nw', 266, 234, cx, cz), flood('flood:ne', 514, 234, cx, cz), flood('flood:sw', 266, 426, cx, cz), flood('flood:se', 514, 426, cx, cz));
  c.push(flood('flood:n', 395, 230, cx, cz), flood('flood:s', 450, 430, cx, cz));
  return c;
}

export const STUNT_PARK_COLLIDERS: readonly ColliderDef[] = [...stuntParkColliders(), ...skiJump()];

/** Soft props of the park (tyre stacks catching the wreck-jump outrun and flanking the quarter pipe, cones on the run-up). */
export const STUNT_PARK_PROPS: readonly PropPlacement[] = [
  { id: 'jumpCatch', prop: 'tire', pos: [506.5, null, 401.5], stack: 3, row: { count: 6, step: [0, 2.6] } },
  { id: 'qpTyresN', prop: 'tire', pos: [497, null, 341.4], stack: 2, row: { count: 3, step: [2.4, 0] } },
  { id: 'qpTyresS', prop: 'tire', pos: [497, null, 398.6], stack: 2, row: { count: 3, step: [2.4, 0] } },
  { id: 'jumpConesN', prop: 'cone', pos: [400, null, 403.5], row: { count: 6, step: [9, 0] } },
  { id: 'jumpConesS', prop: 'cone', pos: [400, null, 412.5], row: { count: 6, step: [9, 0] } },
];

// ============================================================ decoration (render only)
export type PaintColor = 'white' | 'yellow' | 'red' | 'blue' | 'orange';
export type DecorMark =
  | { kind: 'line'; pts: readonly (readonly [number, number])[]; width: number; color: PaintColor; dash?: readonly [number, number] }
  | { kind: 'circle'; c: readonly [number, number]; r: number; width: number; color: PaintColor; dash?: readonly [number, number] }
  | { kind: 'rect'; c: readonly [number, number]; halfX: number; halfZ: number; yawDeg?: number; width: number; color: PaintColor; fill?: boolean }
  | { kind: 'arrow'; c: readonly [number, number]; yawDeg: number; size: number; color: PaintColor }
  | { kind: 'text'; c: readonly [number, number]; yawDeg: number; text: string; size: number; color: PaintColor };

function markings(): DecorMark[] {
  const m: DecorMark[] = [];
  // Crash lane: red/white edges + start box and a "100" speed target.
  m.push({ kind: 'line', pts: [[350, 398], [350, 270]], width: 0.18, color: 'red', dash: [3, 3] });
  m.push({ kind: 'line', pts: [[370, 398], [370, 270]], width: 0.18, color: 'red', dash: [3, 3] });
  m.push({ kind: 'rect', c: [360, 404], halfX: 3, halfZ: 4, width: 0.2, color: 'white' });
  m.push({ kind: 'text', c: [360, 300], yawDeg: 0, text: '100', size: 5, color: 'white' });
  m.push({ kind: 'text', c: [360, 284], yawDeg: 0, text: 'KM/H', size: 2.4, color: 'white' });
  // Bowling lane + pin spots.
  m.push({ kind: 'line', pts: [[442, 326.2], [390, 326.2]], width: 0.15, color: 'white' });
  m.push({ kind: 'line', pts: [[442, 333.8], [390, 333.8]], width: 0.15, color: 'white' });
  for (let x = 432; x >= 406; x -= 6) m.push({ kind: 'arrow', c: [x, 330], yawDeg: 90, size: 1.4, color: 'yellow' });
  m.push({ kind: 'text', c: [418, 337.5], yawDeg: 90, text: 'BOWLING', size: 1.8, color: 'white' });
  // Barrel-roll guide: alignment stripe up to the kicker, ROLL lettering.
  m.push({ kind: 'line', pts: [[BARREL_ROLL.laneX, BARREL_ROLL.startZ], [BARREL_ROLL.laneX, BARREL_ROLL.kickerZ + BARREL_ROLL.hz + 1]], width: 0.25, color: 'yellow', dash: [2, 2] });
  m.push({ kind: 'text', c: [BARREL_ROLL.laneX + 4, 322], yawDeg: 0, text: 'ROLL', size: 2.2, color: 'yellow' });
  // Wreck-jump run-up chevrons.
  for (let x = 345; x <= 445; x += 12) m.push({ kind: 'arrow', c: [x, WRECK_JUMP.laneZ], yawDeg: -90, size: 1.8, color: 'white' });
  m.push({ kind: 'line', pts: [[340, 404.6], [450, 404.6]], width: 0.18, color: 'white' });
  m.push({ kind: 'line', pts: [[340, 411.4], [450, 411.4]], width: 0.18, color: 'white' });
  m.push({ kind: 'text', c: [395, 408], yawDeg: -90, text: 'JUMP', size: 2.4, color: 'yellow' });
  // Kicker lanes.
  m.push({ kind: 'arrow', c: [446, 352], yawDeg: -90, size: 1.6, color: 'yellow' });
  m.push({ kind: 'arrow', c: [446, 376], yawDeg: -90, size: 1.6, color: 'yellow' });
  // Drift pad.
  m.push({ kind: 'circle', c: DRIFT_PAD.centre, r: DRIFT_PAD.radius, width: 0.3, color: 'yellow' });
  m.push({ kind: 'circle', c: DRIFT_PAD.centre, r: DRIFT_PAD.radius - 6, width: 0.2, color: 'white', dash: [2, 2] });
  m.push({ kind: 'text', c: DRIFT_PAD.centre, yawDeg: 0, text: 'DRIFT', size: 2.6, color: 'yellow' });
  // Park bays (target bay in yellow).
  const pb = PARK_BAYS;
  const z0 = pb.zs[0]! - pb.width / 2;
  for (let k = 0; k <= pb.zs.length; k++) {
    const z = z0 + k * pb.width;
    m.push({ kind: 'line', pts: [[pb.x - pb.depth / 2, z], [pb.x + pb.depth / 2, z]], width: 0.15, color: 'white' });
  }
  m.push({ kind: 'rect', c: [pb.x, pb.zs[pb.target]!], halfX: pb.depth / 2 - 0.15, halfZ: pb.width / 2 - 0.15, width: 0.12, color: 'yellow' });
  m.push({ kind: 'text', c: [pb.x + pb.depth / 2 + 2.2, pb.zs[pb.target]!], yawDeg: 90, text: 'P', size: 2.2, color: 'yellow' });
  // Derby pit centre ring + name.
  m.push({ kind: 'circle', c: DERBY_PIT.centre, r: 18, width: 0.3, color: 'orange', dash: [3, 2] });
  m.push({ kind: 'text', c: [482, 300], yawDeg: 0, text: 'DERBY', size: 3.2, color: 'orange' });
  // Centre logo.
  m.push({ kind: 'text', c: [410, 362], yawDeg: 0, text: 'CRUMPLE PROVING GROUND', size: 2.6, color: 'white' });
  return m;
}

export const STUNT_PARK_DECOR: readonly DecorMark[] = markings();

/** Ski-jump distance boards: horizontal metres from the lip painted across the landing hill. */
export const SKI_JUMP_MARKS: readonly number[] = [20, 30, 40, 50, 60, 70, 80, 90];
