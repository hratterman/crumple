/**
 * Trailer rigs (R-PHYS2) — PURE DATA (main may import it to build visuals,
 * like the vehicle defs): no engine / state / worker imports, no three.
 *
 * A trailer is a VehicleDef with no driven wheel (its "engine" idles in
 * neutral and never connects), so its tyres get the full tyre model (tread
 * brush, Pacejka-shaped μ, rolling resistance) and its brakes the ABS-less
 * brake path; the coupling to the tow vehicle is a cross-object ball joint +
 * two crossed safety chains (src/sim/trailer/runtime.ts).
 *
 * FRAME (rig-local; forward = −Z toward the coupler, up +Y, right +X; the
 * ground is y = 0 under the tyres at rest):
 *   r{i}_{lo|hi}_{L|R}   side rails, deck stations i = 0..4 front → rear
 *   dk{i}                deck centre line (cross members)
 *   sd{i}_{L|R}          top rails of the sides (utility) / box wall mid + roof (box)
 *   tn_{L|R}, coupler    A-frame tongue; `coupler` = the hitch socket node
 *   ax{f|c|r}_{L|R}      axle assembly per side (front eye / seat / rear eye)
 *   gt_{L|R}             tailgate top (utility: hinged on r4_hi, latched to sd4)
 *   W_L / W_R            wheels (ST175/80R13-class, 10 rays)
 *
 * NUMBERS: a 5 × 8 ft single-axle steel utility trailer is ≈ 250–320 kg
 * empty, GVWR ≈ 1300 kg; a 6 × 12 ft enclosed cargo trailer ≈ 650–900 kg,
 * GVWR ≈ 2200 kg (single axle at the light end). Leaf springs: static
 * deflection 3–6 cm at rated load (trailers ride stiff, ≈ 2–3 Hz) with
 * inter-leaf friction for damping (ζ ≈ 0.1–0.2, no shock absorbers).
 * Tongue weight guidance: 10–15 % of the trailer's weight (SAE J2638 / every
 * towing guide); below ≈ 7 % the combination sways at highway speed.
 */
import type { RigBeamDef, RigNodeDef } from '../rig/types';
import type { DrivetrainDef, VehicleDef, WheelDef } from '../vehicle/types';
import { WHEEL_TUNING_BEATER_10 } from '../vehicle/defs/beater';

export type TrailerKind = 'utility' | 'box';
export const TRAILER_KINDS: readonly TrailerKind[] = ['utility', 'box'];

export interface TrailerOptions {
  /** Tyre parameter overrides (tests / tuning). */
  tire?: Partial<WheelDef>;
  /** Rigid shell cluster over the frame (default true). */
  shell?: boolean;
  /** Axle position along the deck (rig z, m; the deck spans z −1.25 … +1.25). Default 0.2 (≈ 10 % tongue weight empty). */
  axleZ?: number;
  /** Extra frame mass (ballast) and where it sits along z (spread over the deck nodes nearest it), kg / m. */
  ballast?: { mass: number; z: number };
}

const DT = 1 / 2000;
const G = 9.81;
const DECK_Z = [-1.25, -0.625, 0, 0.625, 1.25] as const;
const RAIL_X = 0.72;
const Y_LO = 0.46;
const Y_HI = 0.6;
const SIDE_TOP = 0.96;
const BOX_ROOF = 2.25;
const BOX_MID = 1.42;
const COUPLER_Z = -2.45;
/** Coupler socket height: matches a drop-less 2" receiver ball on a pickup (rig y ≈ 0.5). */
const COUPLER_Y = 0.5;

/** ST175/80R13-class trailer tyre: the beater's 175/70R13 budget tyre, a little stiffer and harder (ST load range C). */
export const TRAILER_TIRE = {
  ...WHEEL_TUNING_BEATER_10,
  radius: 0.29,
  rimRadius: 0.17,
  width: 0.14,
  rollingResistance: 0.009,
  treadBrushStiffness: 1.1e5,
  friction: 1.0,
  tyreLateralMu: 0.85,
} as const satisfies Partial<WheelDef>;

/** No drive: a token engine that idles in neutral (the def must carry one). */
const TRAILER_DRIVETRAIN: DrivetrainDef = {
  torqueCurve: [
    [0, 1],
    [8000, 1],
  ],
  idleRpm: 800,
  redlineRpm: 6000,
  revLimitRpm: 6500,
  engineInertia: 0.2,
  engineBrakeTorque: 0,
  gearRatios: [1],
  reverseRatio: 1,
  finalDrive: 1,
  shiftTimeS: 0.2,
  autoShiftUpRpm: 5000,
  autoShiftDownRpm: 1500,
  diff: 'open',
  clutchMaxTorque: 1,
  transmission: 'manual',
};

type V3 = [number, number, number];

interface Builder {
  nodes: RigNodeDef[];
  beams: RigBeamDef[];
  pos: Map<string, V3>;
  mass: Map<string, number>;
}

function node(b: Builder, id: string, p: V3, mass: number, group: string, extra: Partial<RigNodeDef> = {}): string {
  if (b.pos.has(id)) throw new Error(`trailer: duplicate node ${id}`);
  b.pos.set(id, p);
  b.mass.set(id, mass);
  b.nodes.push({ id, pos: p, mass, group, ...extra });
  return id;
}

function dist(b: Builder, a: string, c: string): number {
  const p = b.pos.get(a)!;
  const q = b.pos.get(c)!;
  return Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
}

/**
 * Beam sized from the endpoint masses at a target per-beam ω·dt share
 * (`w` = fraction of the lighter node's (ω/dt)²·m budget), damped at ζ of
 * its own critical value. Steel frame members yield at `yieldStrain` and
 * tear at `breakStrain` of their length (a trailer frame bends in a crash
 * and on a hard kerb strike; the drawbar folds).
 */
function beam(b: Builder, a: string, c: string, w: number, o: { zeta?: number; yieldStrain?: number; breakStrain?: number; type?: RigBeamDef['type']; deform?: number; breakF?: number } = {}): void {
  const ma = b.mass.get(a)!;
  const mc = b.mass.get(c)!;
  const m = Math.min(ma, mc);
  const k = w * (0.3 / DT) ** 2 * m;
  const mr = (ma * mc) / (ma + mc);
  const d = (o.zeta ?? 0.25) * 2 * Math.sqrt(k * mr);
  const L = dist(b, a, c);
  b.beams.push({
    a,
    b: c,
    type: o.type ?? 'normal',
    k: round(k),
    d: round(d),
    deform: o.deform ?? (o.yieldStrain ? round(k * L * o.yieldStrain) : 0),
    breakF: o.breakF ?? (o.breakStrain ? round(k * L * o.breakStrain) : 0),
  });
}

function round(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}

/** Builds a trailer VehicleDef (pure; deterministic). */
export function buildTrailer(kind: TrailerKind, opts: TrailerOptions = {}): VehicleDef {
  const b: Builder = { nodes: [], beams: [], pos: new Map(), mass: new Map() };
  const box = kind === 'box';
  const axleZ = opts.axleZ ?? (box ? 0.15 : 0.2);
  // ---- frame masses (kg per node); totals in the header
  const railLo = box ? 24 : 6;
  const railHi = box ? 20 : 5.5;
  const deckC = box ? 16 : 4.5;
  const sideM = box ? 13 : 3;
  const steel = { yieldStrain: 0.01, breakStrain: 0.12 };
  for (let i = 0; i < DECK_Z.length; i++) {
    const z = DECK_Z[i]!;
    for (const [s, x] of [
      ['L', -RAIL_X],
      ['R', RAIL_X],
    ] as const) {
      node(b, `r${i}_lo_${s}`, [x, Y_LO, z], railLo, 'body');
      node(b, `r${i}_hi_${s}`, [x, Y_HI, z], railHi, 'body', { objRadius: 0.12 });
    }
    node(b, `dk${i}`, [0, Y_HI - 0.04, z], deckC, 'body', { objRadius: 0.14 });
  }
  // Ballast (cargo bolted to the deck in tests / heavier variants): spread over the deck nodes nearest z.
  if (opts.ballast && opts.ballast.mass > 0) {
    const { mass, z } = opts.ballast;
    let best = 0;
    for (let i = 1; i < DECK_Z.length; i++) if (Math.abs(DECK_Z[i]! - z) < Math.abs(DECK_Z[best]! - z)) best = i;
    const ids = [`r${best}_lo_L`, `r${best}_lo_R`, `r${best}_hi_L`, `r${best}_hi_R`, `dk${best}`];
    for (const id of ids) {
      const nd = b.nodes.find((n) => n.id === id)!;
      nd.mass += mass / ids.length;
      b.mass.set(id, nd.mass);
    }
  }
  // Sides / box walls.
  const sideIds: string[][] = [];
  for (let i = 0; i < DECK_Z.length; i++) {
    const z = DECK_Z[i]!;
    const row: string[] = [];
    for (const [s, x] of [
      ['L', -RAIL_X - 0.02],
      ['R', RAIL_X + 0.02],
    ] as const) {
      if (box) {
        row.push(node(b, `sm${i}_${s}`, [x, BOX_MID, z], sideM, 'body'));
        row.push(node(b, `sd${i}_${s}`, [x, BOX_ROOF, z], sideM, 'body'));
      } else if (i < DECK_Z.length - 1 || true) {
        row.push(node(b, `sd${i}_${s}`, [x, SIDE_TOP, z], sideM, 'body'));
      }
    }
    sideIds.push(row);
  }
  // Tongue (A-frame) + coupler.
  // The drawbar passes under / behind the tow vehicle's bumper: no node-vs-node contact for its nodes (the
  // tow's bumper spheres would push the coupler off the ball). The deck corners still hit it at a jackknife.
  const noObj = { objContact: false } as const;
  node(b, 'tn_L', [-0.36, COUPLER_Y + 0.02, -1.85], box ? 16 : 8, 'body', noObj);
  node(b, 'tn_R', [0.36, COUPLER_Y + 0.02, -1.85], box ? 16 : 8, 'body', noObj);
  node(b, 'coupler', [0, COUPLER_Y, COUPLER_Z], box ? 18 : 10, 'body', noObj);
  node(b, 'tn_top', [0, COUPLER_Y + 0.22, -1.95], box ? 10 : 5, 'body', noObj);
  // Tailgate (utility): a ramp gate hinged on the rear rail tops.
  if (!box) {
    node(b, 'gt_L', [-RAIL_X, SIDE_TOP, 1.25 + 0.03], 6, 'gate');
    node(b, 'gt_R', [RAIL_X, SIDE_TOP, 1.25 + 0.03], 6, 'gate');
  }
  // Suspension per side (a torsion-axle style trailing arm): a pivot pair on the frame ahead of the hub
  // (inner / outer), a spring seat on the frame above the hub. The hub swings about the pivot axis.
  const R = TRAILER_TIRE.radius;
  const PIV_DZ = 0.42;
  for (const [s_, sx] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    node(b, `pvi_${s_}`, [sx * 0.6, R + 0.08, axleZ - PIV_DZ], 6, 'body', { collidable: false, objContact: false });
    node(b, `pvo_${s_}`, [sx * 0.96, R + 0.08, axleZ - PIV_DZ], 6, 'body', { collidable: false, objContact: false });
    node(b, `sp_${s_}`, [sx * 0.86, Y_HI + 0.02, axleZ], 5, 'body', { objContact: false });
  }
  // Lateral location (the leaf / torsion-arm bushings are stiff sideways): a link from each hub to a frame
  // node on the centre line at the axle. Without it the trailing arms toed the wheels toward a side load
  // (compliance oversteer of a rear axle) and the trailer swayed undamped even behind a rigid hitch.
  node(b, 'axm', [0, R + 0.08, axleZ], 8, 'body', { collidable: false, objContact: false });
  // ---- frame beams: rails (lo/hi chords + webs), cross members, deck centre line
  for (let i = 0; i < DECK_Z.length; i++) {
    for (const s of ['L', 'R']) beam(b, `r${i}_lo_${s}`, `r${i}_hi_${s}`, 0.18, steel);
    beam(b, `r${i}_lo_L`, `r${i}_lo_R`, 0.12, steel);
    beam(b, `r${i}_hi_L`, `dk${i}`, 0.14, steel);
    beam(b, `dk${i}`, `r${i}_hi_R`, 0.14, steel);
    beam(b, `r${i}_lo_L`, `dk${i}`, 0.1, steel);
    beam(b, `dk${i}`, `r${i}_lo_R`, 0.1, steel);
    if (i + 1 < DECK_Z.length) {
      for (const s of ['L', 'R']) {
        beam(b, `r${i}_lo_${s}`, `r${i + 1}_lo_${s}`, 0.2, steel);
        beam(b, `r${i}_hi_${s}`, `r${i + 1}_hi_${s}`, 0.2, steel);
        beam(b, `r${i}_lo_${s}`, `r${i + 1}_hi_${s}`, 0.12, steel);
        beam(b, `r${i}_hi_${s}`, `r${i + 1}_lo_${s}`, 0.12, steel);
      }
      beam(b, `dk${i}`, `dk${i + 1}`, 0.12, steel);
      // Deck plate shear (X-braced bays): the deck is a stiff diaphragm.
      beam(b, `r${i}_hi_L`, `dk${i + 1}`, 0.08, steel);
      beam(b, `dk${i}`, `r${i + 1}_hi_R`, 0.08, steel);
      beam(b, `r${i}_hi_R`, `dk${i + 1}`, 0.08, steel);
      beam(b, `dk${i}`, `r${i + 1}_hi_L`, 0.08, steel);
    }
  }
  // Sides: posts + top rail + braces (utility) / two-panel walls + roof (box).
  for (let i = 0; i < DECK_Z.length; i++) {
    for (const s of ['L', 'R']) {
      if (box) {
        beam(b, `r${i}_hi_${s}`, `sm${i}_${s}`, 0.14, steel);
        beam(b, `sm${i}_${s}`, `sd${i}_${s}`, 0.14, steel);
        beam(b, `r${i}_lo_${s}`, `sm${i}_${s}`, 0.06, steel);
      } else {
        beam(b, `r${i}_hi_${s}`, `sd${i}_${s}`, 0.14, steel);
        beam(b, `r${i}_lo_${s}`, `sd${i}_${s}`, 0.06, steel);
      }
      if (i + 1 < DECK_Z.length) {
        beam(b, `sd${i}_${s}`, `sd${i + 1}_${s}`, 0.14, steel);
        beam(b, `r${i}_hi_${s}`, `sd${i + 1}_${s}`, 0.06, steel);
        beam(b, `sd${i}_${s}`, `r${i + 1}_hi_${s}`, 0.06, steel);
        if (box) {
          beam(b, `sm${i}_${s}`, `sm${i + 1}_${s}`, 0.1, steel);
          beam(b, `sm${i}_${s}`, `sd${i + 1}_${s}`, 0.05, steel);
          beam(b, `sd${i}_${s}`, `sm${i + 1}_${s}`, 0.05, steel);
          beam(b, `r${i}_hi_${s}`, `sm${i + 1}_${s}`, 0.05, steel);
          beam(b, `sm${i}_${s}`, `r${i + 1}_hi_${s}`, 0.05, steel);
        }
      }
    }
    if (box) {
      // Roof bows + diagonal roof bracing; front wall braces at station 0; rear door frame at 4.
      beam(b, `sd${i}_L`, `sd${i}_R`, 0.12, steel);
      if (i + 1 < DECK_Z.length) {
        beam(b, `sd${i}_L`, `sd${i + 1}_R`, 0.05, steel);
        beam(b, `sd${i}_R`, `sd${i + 1}_L`, 0.05, steel);
      }
    }
  }
  if (box) {
    for (const i of [0, DECK_Z.length - 1]) {
      beam(b, `sm${i}_L`, `sm${i}_R`, 0.08, steel);
      beam(b, `r${i}_hi_L`, `sd${i}_R`, 0.04, steel);
      beam(b, `r${i}_hi_R`, `sd${i}_L`, 0.04, steel);
    }
  } else {
    // Front wall of the utility box (sides at station 0 joined by a top rail + braces).
    beam(b, 'sd0_L', 'sd0_R', 0.1, steel);
    beam(b, 'r0_hi_L', 'sd0_R', 0.05, steel);
    beam(b, 'r0_hi_R', 'sd0_L', 0.05, steel);
  }
  // Tongue: A-frame to the front rails + the deck's first cross member.
  for (const s of ['L', 'R']) {
    beam(b, `tn_${s}`, `r0_lo_${s}`, 0.3, steel);
    beam(b, `tn_${s}`, `r0_hi_${s}`, 0.25, steel);
    beam(b, `tn_${s}`, 'coupler', 0.35, steel);
    beam(b, `tn_${s}`, 'tn_top', 0.2, steel);
    beam(b, `tn_${s}`, 'dk0', 0.15, steel);
    beam(b, `tn_${s}`, `r1_lo_${s}`, 0.12, steel);
  }
  beam(b, 'tn_L', 'tn_R', 0.2, steel);
  beam(b, 'coupler', 'tn_top', 0.3, steel);
  beam(b, 'tn_top', 'dk0', 0.15, steel);
  beam(b, 'coupler', 'dk0', 0.12, steel);
  // Tailgate: hinged on the rear rail tops (free rotation about the r4_hi L–R line), latched to the side tops.
  if (!box) {
    beam(b, 'gt_L', 'gt_R', 0.4, steel);
    for (const s of ['L', 'R']) {
      beam(b, `gt_${s}`, `r4_hi_${s}`, 0.4, steel);
      beam(b, `gt_${s}`, `r4_hi_${s === 'L' ? 'R' : 'L'}`, 0.25, steel);
      // Latch (pin + chain): breaks at 6 kN of tension / shear; `openTailgate` releases it.
      beam(b, `gt_${s}`, `sd4_${s}`, 0.3, { breakF: 6000 });
      // Hinge stop (the gate's check chains): a compression-only strut to the next rail top forward, at hinge
      // height. Its length is the same with the gate up and hanging straight down and longer in between, so it
      // only pushes once the open gate would swing on, forward under the deck.
      beam(b, `gt_${s}`, `r3_hi_${s}`, 0.3, { type: 'support' });
    }
  }
  // ---- suspension: pivots + spring seats tied into the frame; springs = preloaded shock beams hub → seat
  let iF = 0;
  for (let i = 0; i < DECK_Z.length; i++) if (DECK_Z[i]! <= axleZ) iF = i;
  const iR = Math.min(DECK_Z.length - 1, iF + 1);
  let iP = 0;
  for (let i = 0; i < DECK_Z.length; i++) if (DECK_Z[i]! <= axleZ - PIV_DZ) iP = i;
  const iP1 = Math.min(DECK_Z.length - 1, iP + 1);
  for (const s_ of ['L', 'R']) {
    for (const pv of [`pvi_${s_}`, `pvo_${s_}`]) {
      beam(b, pv, `r${iP}_lo_${s_}`, 0.25, steel);
      beam(b, pv, `r${iP1}_lo_${s_}`, 0.25, steel);
      beam(b, pv, `r${iP}_hi_${s_}`, 0.15, steel);
      beam(b, pv, `r${iP1}_hi_${s_}`, 0.15, steel);
    }
    beam(b, `pvi_${s_}`, `pvo_${s_}`, 0.3, steel);
    beam(b, `pvi_${s_}`, `dk${iP}`, 0.12, steel);
    beam(b, `sp_${s_}`, `r${iF}_hi_${s_}`, 0.25, steel);
    beam(b, `sp_${s_}`, `r${iR}_hi_${s_}`, 0.25, steel);
    beam(b, `sp_${s_}`, `r${iF}_lo_${s_}`, 0.2, steel);
    beam(b, `sp_${s_}`, `r${iR}_lo_${s_}`, 0.2, steel);
    beam(b, `sp_${s_}`, `sd${iF}_${s_}`, 0.1, steel);
    beam(b, 'axm', `r${iF}_lo_${s_}`, 0.2, steel);
    beam(b, 'axm', `r${iR}_lo_${s_}`, 0.2, steel);
  }
  beam(b, 'axm', `dk${iF}`, 0.2, steel);
  beam(b, 'axm', `dk${iR}`, 0.2, steel);
  // Sprung mass per side for the spring rate (wheel masses are unsprung: they live in the wheel rig).
  let sprung = 0;
  for (const n of b.nodes) sprung += n.mass;
  const perSide = sprung / 2;
  // Ride ≈ 2.4 Hz (trailers ride stiff), inter-leaf / rubber-torsion damping ζ ≈ 0.2.
  const fRide = 2.4;
  const kSpring = perSide * (2 * Math.PI * fRide) ** 2;
  const cSpring = 0.2 * 2 * Math.sqrt(kSpring * perSide);
  let zg = 0;
  for (const n of b.nodes) zg += n.mass * n.pos[2];
  zg /= sprung;
  const axleShare = Math.min(1, Math.max(0.5, (zg - COUPLER_Z) / (axleZ - COUPLER_Z)));
  const springPreload = (sprung * G * axleShare) / 2;
  const springLen = Y_HI + 0.02 - R;
  // ---- wheels
  const HUB_X = 0.8;
  const wheels: WheelDef[] = (['L', 'R'] as const).map((s) => {
    const sx = s === 'L' ? -1 : 1;
    const wd: WheelDef = {
      ...TRAILER_TIRE,
      ...opts.tire,
      id: `W_${s}`,
      hubInner: [sx * HUB_X, R, axleZ],
      hubOuter: [sx * (HUB_X + TRAILER_TIRE.width), R, axleZ],
      axle: 'rear',
      steered: false,
      driven: false,
      braked: box,
      handbrake: false,
      brakeTorqueMax: box ? 900 : 0,
      attach: [`pvi_${s}`, `pvo_${s}`, 'axm'],
      attachSpring: 6e5,
      attachDamp: 500,
      attachBreakF: 6e4,
    } as WheelDef;
    return wd;
  });
  for (const s_ of ['L', 'R']) {
    b.beams.push({
      a: `W_${s_}.hubI`,
      b: `sp_${s_}`,
      type: 'shock',
      k: round(kSpring),
      d: round(cSpring),
      preload: round(springPreload),
      // ±9 cm of travel to the bump / rebound stops (fractions of the rest length).
      boundsLow: round(0.09 / springLen),
      boundsHigh: round(0.09 / springLen),
      deform: 0,
      breakF: 6e4,
    });
  }
  void DT;
  const def: VehicleDef = {
    name: kind === 'box' ? 'trailerBox' : 'trailerUtility',
    body: { name: `${kind}Trailer.body`, nodes: b.nodes, beams: b.beams },
    wheels,
    drivetrain: TRAILER_DRIVETRAIN,
    brakes: { frontBias: 0.5, handbrakeTorqueMax: 0 },
    aero: { dragCoeffArea: box ? 1.6 : 0.5, liftCoeffArea: 0 },
    steering: { maxWheelAngleDeg: 1 },
    frame: { origin: 'r2_lo_L', front: 'r0_lo_L', top: 'r2_hi_L' },
    shell: opts.shell === false ? false : { groups: ['body'], release: { lo: 0.01, hi: 0.03, vLo: 3, vHi: 4 } },
  };
  return def;
}

/** The tow-hitch node of each towing vehicle (VehicleDef.name → body node id; ball centre). */
export const TOW_HITCH_NODES: Readonly<Record<string, string>> = {
  pickup: 'hitch',
  // A receiver on the rear bumper bulkhead's lower centre (a 2" ball ≈ 0.4 m up): light trailers only.
  sedan: 's13_bl',
  beater: 's13_bl',
  // Pintle hook under the rear bumper.
  boxtruck: 'br_bl',
};

/** Trailer coupling parameters (runtime.ts). */
export const HITCH = {
  /** Ball-and-coupler elastic stiffness (receiver, shank, ball), N/m, and damping, N·s/m. */
  k: 4e6,
  c: 6e3,
  /** Coupler free play (radial), m. */
  play: 0.0015,
  /** Ultimate failure of a class III ball mount (≈ 2.5 × the 5000 lb GTW rating × g), N. */
  breakF: 5.5e4,
} as const;

export const SAFETY_CHAIN = {
  /** 5/16" grade 30 proof coil chain, ≈ 1.2 m: effective rope stiffness N/m, damping, break N (≈ 4 × WLL 8.5 kN). */
  k: 2.5e5,
  c: 1.5e3,
  breakF: 3.4e4,
  /** Slack over the straight distance (they cross under the tongue and must allow full-lock turns). */
  slack: 0.22,
} as const;
